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
import { shortSha } from "../util/handles.js";
import { fastPathV2Enabled } from "../util/flags.js";
import { trace } from "../util/trace.js";
import { attemptGraphImpactProbe, evaluateImpactGuard, isFastPathEligible } from "../write/impactGuard.js";
import { selectEditRepresentation } from "../write/editSelector.js";
import { verifyTargetFingerprint } from "../write/targetFingerprint.js";

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
      /**
       * F-B7 (v0.11 wave C): set only on the TL_FAST_PATH_V2
       * fingerprint-drift refusal below — the SAME shape
       * searchReplaceEdit.ts's own seam returns for the identical
       * condition (a fresh re-read proving the target moved between
       * selection and apply).
       */
      current_sha?: string;
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

  // -------------------------------------------------------------------
  // F-B7 (v0.11 wave C) / V11-06 Known-Local Fast Path v2 (behind
  // TL_FAST_PATH_V2, +TL_GRAPH_EVIDENCE for the probe half via
  // attemptGraphImpactProbe's own internal gate) — pre-apply half, wired
  // onto the symbol-bearing edit path exactly the way
  // tools/searchReplaceEdit.ts's own TL_FAST_PATH_V2 seam does it: additive,
  // best-effort (never blocks an edit this function could otherwise
  // complete), and the guard verdict itself is diagnostic ONLY — see that
  // file's doc comment for why isFastPathEligible is traced, not branched
  // on. The one real behavioral consequence, same as that seam, is the
  // fingerprint-drift refusal: a fresh re-read proving the target moved
  // between selection and apply. Unlike searchReplaceEdit's search-only
  // shape, this path HAS a symbol, so the graph half of the guard runs too.
  // -------------------------------------------------------------------
  if (fastPathV2Enabled() && input.search !== "") {
    try {
      const selection = selectEditRepresentation({ path: relPath, fileText: existingContent, search: input.search });
      const graph = attemptGraphImpactProbe({
        workspace,
        path: relPath,
        symbol: input.symbol,
        fileText: existingContent,
      });
      const guard = evaluateImpactGuard({
        path: relPath,
        searchText: input.search,
        replaceText: input.replace,
        fileText: existingContent,
        graph,
      });
      trace(
        "fast_path_v2_guard",
        {
          path: relPath,
          symbol: input.symbol,
          selection: selection.ok
            ? { representation: selection.selection.representation, rationale: selection.selection.rationale }
            : { refused: selection.code, reason: selection.reason },
          guard,
          fast_path_eligible: isFastPathEligible(guard, selection),
        },
        workspace,
      );

      if (selection.ok) {
        // Re-verify IMMEDIATELY before apply, against a FRESH read — same
        // TOCTOU close as searchReplaceEdit.ts's identical block.
        const freshRead = fs.readFileSync(absPath, "utf8");
        const verification = verifyTargetFingerprint(selection.selection.fingerprint, {
          currentFileText: freshRead,
          anchorText: selection.selection.anchorText,
        });
        if (!verification.ok) {
          trace(
            "fast_path_v2_fingerprint_drift",
            { path: relPath, reasons: verification.reasons },
            workspace,
          );
          return {
            ok: false,
            error: `target fingerprint drift detected between selection and apply (${verification.reasons.join(", ")}) — the file changed after this edit was prepared; re-read the file and retry`,
            code: "hash-mismatch",
            current_sha: shortSha(verification.currentContentSha),
          };
        }
      }
    } catch {
      // Best-effort — see this block's doc comment above.
    }
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
    writeExistingFileAtomic(absPath, editResult.text!, existingMode, { root: workspaceReal, relPath });
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
