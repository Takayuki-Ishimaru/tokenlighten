/**
 * read_and_edit tool — atomic read-symbol-context + search/replace edit.
 *
 * Saves one round-trip vs calling read_code(mode=symbol) then search_replace_edit
 * separately. Returns the pre-edit symbol context and a compact edit delta.
 */

import * as fs from "fs";
import * as path from "path";
import { writeExistingFileAtomic } from "../write/atomicWrite.js";
import { looksLikeSecretFile } from "../write/secretScan.js";
import type { GuardedWorkspaceRoot } from "../write/guardedWorkspace.js";
import { applySingleEdit } from "../write/textEdit.js";
import { getSymbolWithContext } from "./getSymbolWithContext.js";
import { computeLineDelta, formatDelta, formatLines } from "../util/lineDelta.js";
import { compressFormat } from "../util/formatCompress.js";

const MAX_FILE_BYTES = 5 * 1024 * 1024;

export interface ReadAndEditInput {
  path: string;
  symbol: string;
  search: string;
  replace: string;
}

export type ReadAndEditResult =
  | { ok: true; context: string; edit: { path: string; lines: string; delta: string } }
  | {
      ok: false;
      error: string;
      code: string;
      /**
       * D1: propagated verbatim from getSymbolWithContext's not-found
       * payload when code === "not-found", so a symbol miss in the
       * edit_code symbol+search branch carries the same recovery data as
       * the read_code symbol paths instead of a bare error string.
       */
      candidates?: string[];
      skeleton?: string;
    };

function safeRealpathSync(absPath: string, workspaceReal: string): string | null {
  try {
    const real = fs.realpathSync(absPath);
    if (real === workspaceReal || real.startsWith(workspaceReal + path.sep)) {
      return real;
    }
    return null;
  } catch {
    return null;
  }
}

export async function readAndEdit(
  input: ReadAndEditInput,
  workspace: GuardedWorkspaceRoot,
  allowWrite: boolean,
): Promise<ReadAndEditResult> {
  if (!allowWrite) {
    return { ok: false, error: "Write tools are disabled. Restart with --allow-write.", code: "write-not-enabled" };
  }

  const relPath = input.path;
  if (!relPath) return { ok: false, error: "path is required", code: "invalid-input" };
  if (!input.symbol) return { ok: false, error: "symbol is required", code: "invalid-input" };

  if (looksLikeSecretFile(relPath)) {
    return { ok: false, error: `Refusing to touch secret/credential file: ${relPath}`, code: "secret-file" };
  }

  const resolvedWorkspace = path.resolve(workspace);
  const absPath = path.resolve(workspace, relPath);
  if (!absPath.startsWith(resolvedWorkspace + path.sep) && absPath !== resolvedWorkspace) {
    return { ok: false, error: "path escapes workspace root", code: "path-escape" };
  }

  let workspaceReal: string;
  try { workspaceReal = fs.realpathSync(resolvedWorkspace); } catch { workspaceReal = resolvedWorkspace; }

  // Read file
  let existingContent: string;
  let existingMode: number | undefined;
  try {
    const stat = fs.statSync(absPath);
    if (stat.size > MAX_FILE_BYTES) {
      return { ok: false, error: `File exceeds 5 MB limit`, code: "file-too-large" };
    }
    existingContent = fs.readFileSync(absPath, "utf8");
    existingMode = stat.mode;
  } catch (err) {
    const errCode = (err as NodeJS.ErrnoException).code;
    return {
      ok: false,
      error: errCode === "ENOENT" ? `File not found: ${relPath}` : `Cannot read: ${(err as Error).message}`,
      code: errCode === "ENOENT" ? "not-found" : "read-error",
    };
  }

  if (safeRealpathSync(absPath, workspaceReal) === null) {
    return { ok: false, error: "path escapes workspace root (symlink)", code: "path-escape" };
  }

  // Read symbol context (pre-edit)
  const symbolResult = await getSymbolWithContext(existingContent, {
    path: relPath,
    symbol: input.symbol,
  });
  if (!symbolResult.ok) {
    // D1: symbol-not-found recovery passthrough — candidates/skeleton
    // survive instead of being dropped to a bare error+code pair.
    return {
      ok: false,
      error: symbolResult.error,
      code: symbolResult.code,
      ...(symbolResult.candidates ? { candidates: symbolResult.candidates } : {}),
      ...(symbolResult.skeleton ? { skeleton: symbolResult.skeleton } : {}),
    };
  }

  // Apply edit
  const editResult = applySingleEdit(existingContent, input.search, input.replace);
  if (!editResult.ok) {
    return {
      ok: false,
      error: editResult.error ?? "edit failed",
      code: editResult.code ?? "edit-error",
    };
  }

  // Atomic write — preserves the original file's mode (see
  // writeExistingFileAtomic's doc comment; 2026-08-07 chmod-reset incident).
  try {
    writeExistingFileAtomic(absPath, editResult.text!, existingMode);
  } catch (err) {
    return { ok: false, error: `Cannot write: ${(err as Error).message}`, code: "write-error" };
  }

  const ld = computeLineDelta(existingContent, input.search, input.replace);
  return {
    ok: true,
    context: compressFormat(symbolResult.data.code),
    edit: {
      path: relPath,
      lines: formatLines(ld.startLine, ld.endLine),
      delta: formatDelta(ld.added, ld.removed),
    },
  };
}
