/**
 * search_replace_edit tool implementation for @tokenlighten/mcp-server v0.2.
 *
 * Applies a single exact-match search/replace to a workspace file.
 * Writes are atomic: tmp file in same directory, then retryRename with EBUSY backoff.
 * Secret file paths are rejected before any read or write.
 * 5 MB file cap is enforced before any processing.
 *
 * Output policy: plain data — no meta envelope.
 * Spec: docs/components/02-mcp-server.md §2.1
 */

import * as fs from "fs";
import * as path from "path";
import { makeTmpPath, retryRename, writeExistingFileAtomic } from "../write/atomicWrite.js";
import { looksLikeSecretFile } from "../write/secretScan.js";
import { invalidateCachedWorkspaceFiles } from "@tokenlighten/skeleton-engine";
import type { GuardedWorkspaceRoot } from "../write/guardedWorkspace.js";
import { applySingleEdit } from "../write/textEdit.js";
import { computeLineDelta, formatDelta, formatLines } from "../util/lineDelta.js";
import { countLines } from "../util/countLines.js";
import { shortSha } from "../util/handles.js";
import { fastPathV2Enabled } from "../util/flags.js";
import { trace } from "../util/trace.js";
import { evaluateImpactGuard, isFastPathEligible } from "../write/impactGuard.js";
import { selectEditRepresentation } from "../write/editSelector.js";
import { verifyTargetFingerprint } from "../write/targetFingerprint.js";
import { runFocusedVerification } from "../write/focusedVerification.js";
import { detectWriteEncodingRisk, writeEncodingRefusalMessage } from "../util/textDecode.js";

/**
 * Resolve the realpath of an existing file (or its first existing ancestor for
 * new-file paths) and verify it stays within workspaceReal.
 * Returns the resolved real path if safe, or null if it escapes the workspace.
 */
function safeRealpathSync(absPath: string, workspaceReal: string, fileExists: boolean): string | null {
  try {
    if (fileExists) {
      const real = fs.realpathSync(absPath);
      if (real === workspaceReal || real.startsWith(workspaceReal + path.sep)) {
        return real;
      }
      return null;
    } else {
      // For new-file creation: walk up from absPath to find the first existing
      // ancestor, then realpath that.
      let cur = path.dirname(absPath);
      while (true) {
        try {
          const real = fs.realpathSync(cur);
          if (real === workspaceReal || real.startsWith(workspaceReal + path.sep)) {
            return absPath; // path is within workspace
          }
          return null; // first existing ancestor resolves outside workspace
        } catch {
          const parent = path.dirname(cur);
          if (parent === cur) {
            // Hit filesystem root — fall back to lexical check
            break;
          }
          cur = parent;
        }
      }
      // Lexical fallback: the resolved path starts with workspace
      const resolved = path.resolve(absPath);
      if (resolved === workspaceReal || resolved.startsWith(workspaceReal + path.sep)) {
        return resolved;
      }
      return null;
    }
  } catch {
    return null;
  }
}

/** 5 MB per-file cap. */
const MAX_FILE_BYTES = 5 * 1024 * 1024;

export interface SearchReplaceEditInput {
  path: string;
  search: string;
  replace: string;
  allow_create?: boolean;
}

export type SearchReplaceEditResult =
  | {
      ok: true;
      path: string;
      lines: string;
      delta: string;
      /**
       * Disclosure (2026-08-07). applySingleEdit may apply a RECOVERED
       * search/replace instead of the caller's literal bytes: when the raw
       * search misses and it carries a literal `\n`/`\t`/`\r`, the unescaped
       * variant is retried, and the replacement is unescaped too when it
       * shares an escape class. That rewrite is legitimate (it rescues a
       * double-encoded caller) but it must never be SILENT: it can change
       * the bytes that land on disk — a replacement carrying a two-backslash
       * `\\uXXXX` source literal comes out with one backslash.
       *
       * applyEditsMulti has always disclosed this as `normalized_escapes`
       * (a path list); the single-edit engine computed the same flag and
       * dropped it, so the caller could not tell an as-sent write from a
       * rewritten one. These two fields close that asymmetry. Absent on
       * every ordinary (verbatim) success.
       */
      normalized_escapes?: true;
      /** As above, for the unique full-line indentation-drift recovery. */
      normalized_whitespace?: true;
    }
  | {
      ok: false;
      error: string;
      code: string;
      /**
       * V11-06 (behind TL_FAST_PATH_V2), `code:"hash-mismatch"` only: the
       * ALREADY-ADVERTISED short-sha display field write/preconditions.ts's
       * own `precondition:"expected-hash"` hash-mismatch uses (util/handles.ts
       * shortSha) — populated here with the CURRENT on-disk sha a target-
       * fingerprint-drift refusal just proved, so a caller can round-trip it
       * straight back as `expectedSha` on a `precondition:"expected-hash"`
       * retry without a native re-read. Absent on every other failure code.
       */
      current_sha?: string;
    };

/**
 * Apply one search/replace edit to a file.
 *
 * @param input       - Tool input arguments.
 * @param workspace   - Absolute workspace root (for path resolution).
 * @param allowWrite  - Write-enable flag (must be true to write).
 */
export async function searchReplaceEdit(
  input: SearchReplaceEditInput,
  workspace: GuardedWorkspaceRoot,
  allowWrite: boolean
): Promise<SearchReplaceEditResult> {
  if (!allowWrite) {
    return {
      ok: false,
      error: "Write tools are disabled. Restart the server with --allow-write.",
      code: "write-not-enabled",
    };
  }

  const relPath = input.path;
  if (!relPath) {
    return { ok: false, error: "path is required", code: "invalid-input" };
  }

  // Secret file rejection.
  if (looksLikeSecretFile(relPath)) {
    return {
      ok: false,
      error: `Refusing to write to secret/credential file: ${relPath}`,
      code: "secret-file",
    };
  }

  // Resolve to absolute path within workspace.
  const absPath = path.resolve(workspace, relPath);
  // Ensure the path stays within the workspace root (lexical check first).
  const resolvedWorkspace = path.resolve(workspace);
  if (!absPath.startsWith(resolvedWorkspace + path.sep) && absPath !== resolvedWorkspace) {
    return { ok: false, error: "path escapes workspace root", code: "path-escape" };
  }

  // Compute the real (symlink-resolved) workspace root once.
  let workspaceReal: string;
  try {
    workspaceReal = fs.realpathSync(resolvedWorkspace);
  } catch {
    workspaceReal = resolvedWorkspace;
  }

  const allowCreate = input.allow_create ?? false;

  // Read existing file content.
  let existingContent: string;
  let existingMode: number | undefined;
  let fileExists = false;
  try {
    const stat = fs.statSync(absPath);
    if (stat.size > MAX_FILE_BYTES) {
      return {
        ok: false,
        error: `File exceeds 5 MB limit (${stat.size} bytes): ${relPath}`,
        code: "file-too-large",
      };
    }
    // 2026-08-27 (write-path fail-closed guard): sniff BEFORE trusting a
    // plain UTF-8 decode — see util/textDecode.ts's doc comment. Full
    // UTF-16 round-trip editing is out of scope; refusal is correct.
    const buf = fs.readFileSync(absPath);
    const encodingRisk = detectWriteEncodingRisk(buf);
    if (encodingRisk) {
      return {
        ok: false,
        error: writeEncodingRefusalMessage(relPath, encodingRisk),
        code: "unsupported-encoding",
      };
    }
    existingContent = buf.toString("utf8");
    existingMode = stat.mode;
    fileExists = true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      if (!allowCreate) {
        return {
          ok: false,
          // FIX 2c: edit_file's ADVERTISED schema has `create`, not
          // `allow_create` (that name only ever existed on the deprecated
          // search_replace_edit alias's schema) — an agent that hit this hint
          // could not see the param it named, and abandoned the tool. Point
          // at the name the caller can actually see; this function's own
          // `allow_create` field survives as an engine-internal option, fed
          // ONLY from the advertised `create` now — server.ts's edit_file
          // dispatch computes `allow_create: args["create"] === true`; the
          // caller-facing `allow_create` alias itself was deleted.
          error: `File not found: ${relPath}. Use create:true to create new files.`,
          code: "not-found",
        };
      }
      existingContent = "";
      fileExists = false;
    } else {
      return {
        ok: false,
        error: `Cannot read file: ${(err as Error).message}`,
        code: "read-error",
      };
    }
  }

  // Realpath escape check — defend against symlinks pointing outside workspace.
  const safeReal = safeRealpathSync(absPath, workspaceReal, fileExists);
  if (safeReal === null) {
    return { ok: false, error: "path escapes workspace root (symlink)", code: "path-escape" };
  }

  // Handle new file creation.
  if (!fileExists && allowCreate) {
    if (input.search !== "") {
      return {
        ok: false,
        // FIX 2c: see the not-found hint above — same rename, same reason.
        error: "When creating a new file (create:true, file absent), search must be empty string.",
        code: "invalid-input",
      };
    }
    // Create parent directories if needed.
    const parentDir = path.dirname(absPath);
    try {
      fs.mkdirSync(parentDir, { recursive: true });
    } catch (err) {
      return {
        ok: false,
        error: `Cannot create directory: ${(err as Error).message}`,
        code: "write-error",
      };
    }
    const newContent = input.replace;
    const tmpPath = makeTmpPath(absPath);
    try {
      fs.writeFileSync(tmpPath, newContent, "utf8");
      retryRename(tmpPath, absPath);
    } catch (err) {
      return {
        ok: false,
        error: `Cannot write file: ${(err as Error).message}`,
        code: "write-error",
      };
    }
    // V10-10: this create path does not go through writeExistingFileAtomic
    // (there is no existing mode to preserve), so it is not covered by that
    // function's own index-invalidation call — invalidate directly.
    // Best-effort: an index-cache problem must never fail a write that
    // already landed on disk.
    try {
      invalidateCachedWorkspaceFiles(workspaceReal, [relPath]);
    } catch {
      // best-effort — see above
    }
    // BUG FIX: was newContent.split("\n").length, which counts a phantom
    // final segment for trailing-newline content — reported "lines"/"delta"
    // on a brand-new file overstated its line count by one.
    const lineCount = countLines(newContent);
    return {
      ok: true,
      path: relPath,
      lines: formatLines(1, lineCount),
      delta: formatDelta(lineCount, 0),
    };
  }

  // -------------------------------------------------------------------
  // V11-06 Known-Local Fast Path v2 (behind TL_FAST_PATH_V2) — pre-apply
  // half. Flag OFF ⇒ nothing below runs; this seam is byte-identical to
  // pre-V11-06 (util/flags.ts's "V11-06 addendum" states this invariant).
  //
  // SAFETY: neither the selector nor the guard is ever allowed to change the
  // OUTCOME of a call that would have succeeded or failed identically before
  // this wave — `selectEditRepresentation` uses RAW (non-normalized)
  // occurrence counting (see its own doc comment), which can disagree with
  // `applySingleEdit`'s normalized count on exotic input (mixed line
  // endings); the code below therefore NEVER short-circuits on the
  // selector's verdict, success or failure. The ONLY new observable
  // behavior is an ADDITIVE refusal when a fresh re-read PROVES the target
  // drifted between selection and apply — a real TOCTOU window this closes
  // — and additional TL_TRACE records. A failure anywhere in this block is
  // swallowed (best-effort): a V11-06 diagnostic must never block an edit
  // the existing machinery below can still complete correctly.
  // -------------------------------------------------------------------
  if (fastPathV2Enabled() && input.search !== "") {
    try {
      const selection = selectEditRepresentation({ path: relPath, fileText: existingContent, search: input.search });
      const guard = evaluateImpactGuard({
        path: relPath,
        searchText: input.search,
        replaceText: input.replace,
        fileText: existingContent,
      });
      trace(
        "fast_path_v2_guard",
        {
          path: relPath,
          selection: selection.ok
            ? { representation: selection.selection.representation, rationale: selection.selection.rationale }
            : { refused: selection.code, reason: selection.reason },
          guard,
          fast_path_eligible: isFastPathEligible(guard, selection),
        },
        workspace,
      );

      if (selection.ok) {
        // Re-verify IMMEDIATELY before apply, against a FRESH read — the
        // in-memory `existingContent` above cannot have drifted from
        // itself, so this is the one place in this synchronous function a
        // genuine external mutation between selection and apply could
        // actually be observed.
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
            error: `target fingerprint drift detected between selection and apply (${verification.reasons.join(", ")}) — the file changed after this edit was prepared; re-read the file and retry, or retry this SAME call with precondition:"expected-hash" expectedSha=${shortSha(verification.currentContentSha)}`,
            code: "hash-mismatch",
            current_sha: shortSha(verification.currentContentSha),
          };
        }
      }
    } catch {
      // Best-effort — see this block's doc comment above.
    }
  }

  // Apply the search/replace edit.
  const editResult = applySingleEdit(existingContent, input.search, input.replace);
  if (!editResult.ok) {
    return {
      ok: false,
      error: editResult.error ?? "edit failed",
      code: editResult.code ?? "edit-error",
    };
  }

  const newContent = editResult.text!;

  // Atomic write — preserves the original file's mode (see
  // writeExistingFileAtomic's doc comment; 2026-08-07 chmod-reset incident).
  try {
    writeExistingFileAtomic(absPath, newContent, existingMode, { root: workspaceReal, relPath });
  } catch (err) {
    return {
      ok: false,
      error: `Cannot write file: ${(err as Error).message}`,
      code: "write-error",
    };
  }

  // -------------------------------------------------------------------
  // V11-06 Known-Local Fast Path v2 — post-apply Focused Verification.
  // Trace-only this wave (deviation E-8: no new wire fields) — see
  // write/focusedVerification.ts's own header. Runs AFTER the write above
  // has already succeeded, so any failure here is diagnostic, never a
  // reason to change the response this call already earned.
  // -------------------------------------------------------------------
  if (fastPathV2Enabled()) {
    try {
      const anchorText = editResult.usedSearch ?? input.search;
      const replacementText = editResult.usedReplace ?? input.replace;
      const spanStart = existingContent.indexOf(anchorText);
      const report = await runFocusedVerification({
        path: relPath,
        beforeText: existingContent,
        afterText: newContent,
        anchorText,
        replacementText,
        expectedReplacementCount: 1,
        spanStart: spanStart >= 0 ? spanStart : 0,
        spanEnd: spanStart >= 0 ? spanStart + anchorText.length : 0,
      });
      trace(
        "fast_path_v2_focused_verification",
        { path: relPath, all_passed: report.allPassed, checks: report.checks },
        workspace,
      );
    } catch {
      // Best-effort — see the pre-apply block's doc comment above.
    }
  }

  // The reported line range/delta must describe the edit that ACTUALLY
  // happened. When a recovery path fired, the caller's raw search never
  // matched this text, so feeding it to computeLineDelta measures an edit
  // that did not occur (observed: a recovered 2-line edit reported lines:"1",
  // delta:"+1/-1"). usedSearch/usedReplace are the strings applySingleEdit
  // really matched and really applied; they are absent on the verbatim path,
  // where the caller's own strings are already the right answer.
  const ld = computeLineDelta(
    existingContent,
    editResult.usedSearch ?? input.search,
    editResult.usedReplace ?? input.replace,
  );
  return {
    ok: true,
    path: relPath,
    lines: formatLines(ld.startLine, ld.endLine),
    delta: formatDelta(ld.added, ld.removed),
    ...(editResult.normalizedEscapes ? { normalized_escapes: true as const } : {}),
    ...(editResult.normalizedWhitespace ? { normalized_whitespace: true as const } : {}),
  };
}
