/**
 * rangeEdit.ts — handle-scoped line-range write primitives.
 *
 * These helpers intentionally reuse existing edit_file fields so the MCP
 * advertised schema does not grow.
 */

import * as fs from "fs";
import * as path from "path";
import { writeExistingFileAtomic } from "./atomicWrite.js";
import { batchCheckpoint } from "./checkpoint.js";
import { looksLikeSecretFile } from "./secretScan.js";
import { rangeMissForensics, type NearestMatchInfo } from "./editForensics.js";
import { formatDelta, formatLines } from "../util/lineDelta.js";

const MAX_FILE_BYTES = 5 * 1024 * 1024;

export type RangeEditResult =
  | { ok: true; path: string; lines: string; delta: string }
  | ({ ok: false; error: string; code: string } & NearestMatchInfo);

export interface RangeEditInput {
  path: string;
  range: string;
  content?: string;
  search?: string;
  replace?: string;
}

function parseRange(range: string): { start: number; end: number } | null {
  // 2026-07-11c: accept comma-separated ranges ("160,195") as a synonym for
  // the dash form — mirrors readCodeModes.ts's resolveSlice leniency for the
  // same agent typo (comma instead of dash).
  const commaMatch = /^\s*(\d+)\s*,\s*(\d+)\s*$/.exec(range);
  const normalized = commaMatch ? `${commaMatch[1]}-${commaMatch[2]}` : range;
  const match = normalized.match(/^(\d+)(?:-(\d+))?$/);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2] ?? match[1]);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) return null;
  return { start, end };
}

function detectLineEnding(s: string): "\n" | "\r\n" | "\r" {
  const idx = s.indexOf("\n");
  if (idx === -1) return s.includes("\r") ? "\r" : "\n";
  return idx > 0 && s[idx - 1] === "\r" ? "\r\n" : "\n";
}

function toLf(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function restoreLineEnding(s: string, lineEnding: "\n" | "\r\n" | "\r"): string {
  return lineEnding === "\n" ? s : s.replace(/\n/g, lineEnding);
}

function lineStartIndex(text: string, line: number): number {
  if (line <= 1) return 0;
  let seen = 1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") {
      seen++;
      if (seen === line) return i + 1;
    }
  }
  return text.length;
}

function lineEndWithNewlineIndex(text: string, line: number): number {
  let seen = 1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") {
      if (seen === line) return i + 1;
      seen++;
    }
  }
  return text.length;
}

function countLogicalLines(text: string): number {
  if (text.length === 0) return 0;
  const normalized = toLf(text);
  const trimmedTrailingNewline = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  if (trimmedTrailingNewline.length === 0) return 0;
  return trimmedTrailingNewline.split("\n").length;
}

function resolveExistingFile(relPath: string, workspace: string): { abs: string; workspaceReal: string } | RangeEditResult {
  if (!relPath) return { ok: false, error: "path is required", code: "invalid-input" };
  if (looksLikeSecretFile(relPath)) {
    return { ok: false, error: `Refusing to write to secret/credential file: ${relPath}`, code: "secret-file" };
  }

  const resolvedWorkspace = path.resolve(workspace);
  const abs = path.resolve(workspace, relPath);
  if (!abs.startsWith(resolvedWorkspace + path.sep) && abs !== resolvedWorkspace) {
    return { ok: false, error: "path escapes workspace root", code: "path-escape" };
  }

  let workspaceReal: string;
  try {
    workspaceReal = fs.realpathSync(resolvedWorkspace);
  } catch {
    workspaceReal = resolvedWorkspace;
  }

  let real: string;
  try {
    real = fs.realpathSync(abs);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { ok: false, error: code === "ENOENT" ? `File not found: ${relPath}` : `Cannot stat file: ${(err as Error).message}`, code: code === "ENOENT" ? "not-found" : "read-error" };
  }
  if (real !== workspaceReal && !real.startsWith(workspaceReal + path.sep)) {
    return { ok: false, error: "path escapes workspace root (symlink)", code: "path-escape" };
  }
  return { abs, workspaceReal };
}

function writeExistingFile(abs: string, content: string, mode: number | undefined): RangeEditResult | null {
  try {
    writeExistingFileAtomic(abs, content, mode);
    return null;
  } catch (err) {
    return { ok: false, error: `Cannot write file: ${(err as Error).message}`, code: "write-error" };
  }
}

export function replaceRangeContent(
  input: RangeEditInput,
  workspace: string,
  allowWrite: boolean,
  sessionId: string,
): RangeEditResult {
  if (!allowWrite) return { ok: false, error: "Write tools are disabled. Restart the server with --allow-write.", code: "write-not-enabled" };

  const range = parseRange(input.range);
  if (!range) return { ok: false, error: "invalid range", code: "invalid-input" };

  const resolved = resolveExistingFile(input.path, workspace);
  if ("ok" in resolved) return resolved;

  const stat = fs.statSync(resolved.abs);
  if (stat.size > MAX_FILE_BYTES) return { ok: false, error: `File exceeds 5 MB limit (${stat.size} bytes): ${input.path}`, code: "file-too-large" };

  const existing = fs.readFileSync(resolved.abs, "utf8");
  const lineEnding = detectLineEnding(existing);
  const normalized = toLf(existing);
  // Bounds check: lineStartIndex/lineEndWithNewlineIndex silently CLAMP an
  // out-of-range line number to end-of-file rather than failing, so without
  // this check a stale/wrong range (e.g. a handle minted before the file
  // shrank via a different edit) would replace far more of the file than
  // the caller's range said — mirrors applyEditsMulti.ts's edits[] range
  // branch (tools/applyEditsMulti.ts), which already rejects this exact
  // case for the batch-edit path; this was the single-edit path's gap.
  const totalLines = countLogicalLines(normalized);
  if (range.start > totalLines || range.end > totalLines) {
    return { ok: false, error: `range ${input.range} is out of bounds (file has ${totalLines} lines)`, code: "invalid-input" };
  }
  const startIndex = lineStartIndex(normalized, range.start);
  const endIndex = lineEndWithNewlineIndex(normalized, range.end);
  const replacement = toLf(input.content ?? "");
  const next = normalized.slice(0, startIndex) + replacement + normalized.slice(endIndex);
  const restored = restoreLineEnding(next, lineEnding);
  const writeError = writeExistingFile(resolved.abs, restored, stat.mode);
  if (writeError) return writeError;

  try { batchCheckpoint(workspace, [input.path], sessionId); } catch { /* non-fatal */ }

  const added = countLogicalLines(replacement);
  const removed = range.end - range.start + 1;
  return {
    ok: true,
    path: input.path,
    lines: formatLines(range.start, Math.max(range.start, range.start + Math.max(added, 1) - 1)),
    delta: formatDelta(added, removed),
  };
}

export function replaceAllInRange(
  input: RangeEditInput,
  workspace: string,
  allowWrite: boolean,
  sessionId: string,
): RangeEditResult {
  if (!allowWrite) return { ok: false, error: "Write tools are disabled. Restart the server with --allow-write.", code: "write-not-enabled" };
  if (!input.search) return { ok: false, error: "search string is required", code: "invalid-input" };

  const range = parseRange(input.range);
  if (!range) return { ok: false, error: "invalid range", code: "invalid-input" };

  const resolved = resolveExistingFile(input.path, workspace);
  if ("ok" in resolved) return resolved;

  const stat = fs.statSync(resolved.abs);
  if (stat.size > MAX_FILE_BYTES) return { ok: false, error: `File exceeds 5 MB limit (${stat.size} bytes): ${input.path}`, code: "file-too-large" };

  const existing = fs.readFileSync(resolved.abs, "utf8");
  const lineEnding = detectLineEnding(existing);
  const normalized = toLf(existing);
  // Bounds check — see the matching comment in replaceRangeContent above.
  const totalLines = countLogicalLines(normalized);
  if (range.start > totalLines || range.end > totalLines) {
    return { ok: false, error: `range ${input.range} is out of bounds (file has ${totalLines} lines)`, code: "invalid-input" };
  }
  const startIndex = lineStartIndex(normalized, range.start);
  const endIndex = lineEndWithNewlineIndex(normalized, range.end);
  const segment = normalized.slice(startIndex, endIndex);
  const search = toLf(input.search);
  const replace = toLf(input.replace ?? "");
  if (!segment.includes(search)) {
    return {
      ok: false,
      error: "search string not found in range",
      code: "not-found",
      // P4.2 (2026-08-02 T13 rep1-a): when the anchor is absent from the
      // SEGMENT but present exactly once elsewhere in the FILE, say where —
      // the scope-head fallback alone cost a full re-read per occurrence.
      ...rangeMissForensics(normalized, segment, search, range.start, range.end),
    };
  }

  const replaced = segment.split(search).join(replace);
  const next = normalized.slice(0, startIndex) + replaced + normalized.slice(endIndex);
  const restored = restoreLineEnding(next, lineEnding);
  const writeError = writeExistingFile(resolved.abs, restored, stat.mode);
  if (writeError) return writeError;

  try { batchCheckpoint(workspace, [input.path], sessionId); } catch { /* non-fatal */ }

  return {
    ok: true,
    path: input.path,
    lines: formatLines(range.start, range.end),
    delta: formatDelta(countLogicalLines(replaced), range.end - range.start + 1),
  };
}
