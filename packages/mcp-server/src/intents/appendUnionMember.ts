/**
 * appendUnionMember.ts — intent: append-union-member.
 *
 * Appends a new string literal to a TypeScript type alias whose value is a
 * union of string literals (e.g. `type Status = "A" | "B"`).
 *
 * TypeScript ONLY for v0.7. Uses a regex-based parser — tree-sitter would be
 * more precise but the pattern is syntactically narrow enough that regex is
 * reliable and avoids WASM initialization overhead on the write path.
 *
 * Refuses if:
 *   - symbol is not a union of string literals
 *   - target member is already present
 *   - syntax can't be parsed confidently
 */

import * as fs from "fs";
import { writeExistingFileAtomic } from "../write/atomicWrite.js";
import { looksLikeSecretFile } from "../write/secretScan.js";
import { computeLineDelta, formatDelta, formatLines } from "../util/lineDelta.js";
import { safeResolveForWrite, resolveReal, isWithin, statReadTargetSync } from "../util/safePath.js";
import type { GuardedWorkspaceRoot } from "../write/guardedWorkspace.js";

export type AppendUnionMemberResult =
  | { ok: true; path: string; lines: string; delta: string }
  | { ok: false; reason: string; next?: string };

/** Escape a string to be safe inside a TypeScript string-literal regex. */
function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Locate the type alias declaration for `symbolName` in `content`.
 * Returns the match details needed to perform the append, or null.
 *
 * Handles:
 *   - `type Foo = "A" | "B";`
 *   - `export type Foo = "A" | "B";`
 *   - Multi-line unions (each member on its own line)
 */
function parseUnionTypeAlias(
  content: string,
  symbolName: string,
): {
  /** Full match text of the type alias (from `type Foo` to `;`). */
  match: string;
  /** 0-based start index in content. */
  startIdx: number;
  /** Quote character used in the union members (" or '). */
  quote: string;
  /** Parsed member literals (without quotes). */
  members: string[];
  /** Index of the trailing semicolon (relative to startIdx). */
  semiOffset: number;
} | null {
  // Match: (export? type NAME = ... ;)
  // We allow any whitespace/newlines between = and ;
  const typePat = new RegExp(
    `(?:^|\\n)[ \\t]*(export\\s+)?type\\s+${escapeForRegex(symbolName)}\\s*=([^;]+);`,
    "s",
  );
  const m = typePat.exec(content);
  if (!m) return null;

  const fullMatch = m[0]!;
  // Determine start index: if match starts with \n, the "type" keyword starts at +1.
  const rawStart = m.index!;
  const startIdx = fullMatch.startsWith("\n") ? rawStart + 1 : rawStart;
  const rhs = m[2]!; // everything between "=" and ";"

  // Trim leading/trailing whitespace from RHS.
  const rhsTrimmed = rhs.trim();

  // Split on "|" and check each token.
  const parts = rhsTrimmed.split(/\s*\|\s*/);
  if (parts.length === 0) return null;

  // Each part must be a quoted string literal.
  const quote = parts[0]!.trim()[0];
  if (quote !== '"' && quote !== "'") return null;

  const members: string[] = [];
  for (const part of parts) {
    const p = part.trim();
    if (!p.startsWith(quote) || !p.endsWith(quote) || p.length < 2) return null;
    // Verify no other quote characters inside (simple single-layer).
    const inner = p.slice(1, -1);
    if (inner.includes(quote)) return null;
    members.push(inner);
  }

  // Find where the semicolon is in the full match (relative to startIdx).
  const matchText = content.slice(startIdx, startIdx + fullMatch.length - (fullMatch.startsWith("\n") ? 1 : 0));
  const semiOffset = matchText.lastIndexOf(";");
  if (semiOffset === -1) return null;

  // Adjust: strip leading \n from fullMatch when computing the "match" slice.
  const adjustedMatch = content.slice(startIdx, rawStart + fullMatch.length);

  return {
    match: adjustedMatch,
    startIdx,
    quote,
    members,
    semiOffset: adjustedMatch.lastIndexOf(";"),
  };
}

export async function applyAppendUnionMember(
  relPath: string,
  symbolName: string | undefined,
  target: string,
  workspace: GuardedWorkspaceRoot,
  allowWrite: boolean,
  handleId: string,
  lang: string | undefined,
): Promise<AppendUnionMemberResult> {
  if (!allowWrite) {
    return { ok: false, reason: "write-not-enabled" };
  }

  // TypeScript only.
  if (lang && lang !== "ts" && lang !== "js") {
    return { ok: false, reason: "intent-lang-unsupported", next: "edit_file search=... replace=..." };
  }
  // For non-TS extension files when lang is not specified, check the extension.
  if (relPath && !lang) {
    const ext = relPath.split(".").pop()?.toLowerCase();
    if (ext && ext !== "ts" && ext !== "tsx" && ext !== "js" && ext !== "jsx" && ext !== "mts" && ext !== "cts") {
      return { ok: false, reason: "intent-lang-unsupported", next: "edit_file search=... replace=..." };
    }
  }

  if (!symbolName) {
    return { ok: false, reason: "intent-unsupported", next: `read_file mode=slice handle=${handleId}` };
  }
  if (!target || target.trim() === "") {
    return { ok: false, reason: "intent-unsupported", next: "provide target member name" };
  }

  if (looksLikeSecretFile(relPath)) {
    return { ok: false, reason: "intent-unsupported" };
  }

  const abs = safeResolveForWrite(relPath, workspace);
  if (!abs) {
    return { ok: false, reason: "path-outside-workspace" };
  }
  let realPath: string;
  try {
    realPath = fs.realpathSync(abs);
  } catch {
    return { ok: false, reason: "path-outside-workspace" };
  }
  if (!isWithin(realPath, resolveReal(workspace))) {
    return { ok: false, reason: "path-outside-workspace" };
  }

  let raw: string;
  let rawMode: number | undefined;
  try {
    // Stat FIRST — see appendEnumMember.ts for why (FIFO/oversize must be
    // refused before the open; refusal throws into the existing catch).
    rawMode = statReadTargetSync(realPath, workspace).mode;
    raw = fs.readFileSync(realPath, "utf8");
  } catch {
    return { ok: false, reason: "intent-unsupported", next: `read_file mode=slice handle=${handleId}` };
  }

  const parsed = parseUnionTypeAlias(raw, symbolName);
  if (!parsed) {
    return {
      ok: false,
      reason: "intent-unsupported",
      next: `read_file mode=slice handle=${handleId}`,
    };
  }

  // Check target is not already a member.
  if (parsed.members.includes(target)) {
    return {
      ok: false,
      reason: "intent-unsupported",
      next: `${symbolName} already contains member "${target}"`,
    };
  }

  // Append: insert ` | "<target>"` before the semicolon.
  const { startIdx, match, semiOffset, quote } = parsed;
  const newMember = ` | ${quote}${target}${quote}`;
  const newMatch = match.slice(0, semiOffset) + newMember + match.slice(semiOffset);
  const newContent = raw.slice(0, startIdx) + newMatch + raw.slice(startIdx + match.length);

  // Mode preservation: see writeExistingFileAtomic's doc comment
  // (2026-08-07 chmod-reset incident).
  try {
    writeExistingFileAtomic(realPath, newContent, rawMode, { root: workspace, relPath });
  } catch (err) {
    return {
      ok: false,
      reason: "intent-unsupported",
      next: `write failed: ${(err as Error).message}`,
    };
  }

  // Compute delta: the old text is `match`, the new is `newMatch`.
  const ld = computeLineDelta(raw, match, newMatch);
  return {
    ok: true,
    path: relPath,
    lines: formatLines(ld.startLine, ld.endLine),
    delta: formatDelta(ld.added, ld.removed),
  };
}
