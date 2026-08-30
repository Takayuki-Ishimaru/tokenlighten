/**
 * create_file tool implementation for @tokenlighten/mcp-server v0.4.
 *
 * Creates a NEW file at the given workspace-relative path.
 * Parent directories are created automatically (mkdir -p behaviour).
 * Writes are atomic AND no-replace: tmp file + fs.linkSync publish (falls
 * back to a direct O_CREAT|O_EXCL|O_WRONLY "wx" write when link() is
 * unavailable on the target filesystem/platform) — see the publish step
 * below for the exact mechanism and why it replaced tmp file + rename.
 * A shadow-git checkpoint is taken after each successful write.
 *
 * Existing files are REJECTED — use apply_edits_multi to modify them.
 * This prevents accidental data loss and keeps the tool's role unambiguous.
 *
 * Security:
 *   - Path traversal via ".." is rejected before any I/O.
 *   - Symlinks that escape the workspace are rejected via realpath check
 *     (reuses the same guard pattern as searchReplaceEdit.ts).
 *   - Any pre-existing entry at the target — regular file, directory, valid
 *     symlink, or a DANGLING symlink — refuses creation (lstat-based check;
 *     see below). A dangling symlink's target is unreachable, but the link
 *     ITSELF is a directory entry that already occupies the name.
 *   - Publish is no-replace (2026-08-13 hardening, CWE-59/CWE-367): a file
 *     that races into existence at the target between the existence check
 *     and the publish step is refused, never silently overwritten.
 *   - Write gate: callers must start the server with --allow-write.
 *
 * Output policy: plain data — no meta envelope.
 * Spec: docs/06-stable-prefix-rebuild.md §3.3.3
 */

import { batchCheckpoint } from "../write/checkpoint.js";
import type { GuardedWorkspaceRoot } from "../write/guardedWorkspace.js";
import { invalidateCachedWorkspaceFiles } from "@tokenlighten/skeleton-engine";
import { validateCreateTarget, publishNewFile } from "./createFileCore.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreateFileInput {
  path: string;
  content: string;
}

export type CreateFileResult =
  | { ok: true; path: string; bytes: number }
  | { ok: false; error: "file_exists" | "path_escapes_root" | "write_disabled" | "write_error" | "mkdir_error"; message?: string; code?: string };

// ---------------------------------------------------------------------------
// Main implementation
// ---------------------------------------------------------------------------

/**
 * Create a new file at the given workspace-relative path.
 *
 * @param input      - Tool input (path + content).
 * @param workspace  - Absolute workspace root, proven to have come out of the
 *                     dispatch guard stack (see write/guardedWorkspace.ts).
 * @param allowWrite - Write-enable flag (must be true to write).
 * @param sessionId  - Session identifier for shadow-git checkpoint.
 */
export async function createFile(
  input: CreateFileInput,
  workspace: GuardedWorkspaceRoot,
  allowWrite: boolean,
  sessionId: string
): Promise<CreateFileResult> {
  // Write gate.
  //
  // W3-4(c) (v0.13 wave-2 handoff, cross-audit D-5 property): the five
  // sibling write entry points (rangeEdit.ts, pathlessEdit.ts,
  // artifactEdit.ts, searchReplaceEdit.ts, renameSymbol.ts,
  // applyEditsMulti.ts) all carry the shared, A.7.1-recognized
  // `code: "write-not-enabled"` on their own write-gate refusal.
  // createFile.ts was the one holdout: its error union spelled this case
  // `error: "write_disabled"` (underscore, uncoded) with no `code` field at
  // all, so `refusalCodeOf` (protocol/refusal.ts) — which reads `reason`,
  // then `code`, then `terminal_reason` against the recognized enum — found
  // none of the three and fell through to the single documented
  // code-less-body fallback, `invalid-input`. That made a `create:true` call
  // against a server started without `--allow-write` indistinguishable, by
  // `code` alone, from a genuine argument-SHAPE violation — confirmed live
  // via canonicalSurface.spec.ts's D-5 "schema-valid canonical request"
  // property, which had to sidestep this producer (spawn a real
  // `--allow-write` server) to stay non-vacuous. Adding the same recognized
  // code here, alongside the existing `error` string (kept for
  // createFile.spec.ts's pre-existing `result.error` pins), closes the gap
  // with no other behavior change.
  if (!allowWrite) {
    return { ok: false, error: "write_disabled", code: "write-not-enabled" };
  }

  const relPath = input.path;

  // Path-safety + "nothing must already be here" check (traversal, realpath
  // escape, lstat-based existence — see validateCreateTarget's own doc
  // comment for the exact semantics, byte-identical to this function's
  // pre-2026-08-30 inline checks). Shared with applyEditsMulti.ts's batch
  // edits[] create item so the two paths cannot drift apart.
  const validation = validateCreateTarget(relPath, workspace);
  if (!validation.ok) {
    return validation.message !== undefined
      ? { ok: false, error: validation.error, message: validation.message }
      : { ok: false, error: validation.error };
  }
  const absPath = validation.absPath;

  // mkdir -p the parent, then publish with the no-replace tmp+link (falls
  // back to "wx") primitive — see publishNewFile's own doc comment for the
  // full CWE-59/CWE-367 rationale. Shared with the batch create path.
  const publish = publishNewFile(absPath, input.content);
  if (!publish.ok) {
    return publish.message !== undefined
      ? { ok: false, error: publish.error, message: publish.message }
      : { ok: false, error: publish.error };
  }
  const bytes = publish.bytes;

  // Shadow-git checkpoint (non-fatal on failure).
  try {
    batchCheckpoint(workspace, [relPath], sessionId);
  } catch {
    // Checkpoint failure is non-fatal — file is written, just not checkpointed.
  }

  // V10-10: a brand-new file cannot have a stale cached entry, but the
  // WORKSPACE's memoized manifest (skeleton-engine's manifestMemo) may still
  // certify "nothing changed" via its whole-directory stat fingerprint,
  // which this new file would now be absent from — invalidate so the next
  // read re-enumerates. Best-effort: an index-cache problem must never fail
  // a write that already landed on disk.
  try {
    invalidateCachedWorkspaceFiles(workspace, [relPath]);
  } catch {
    // best-effort — see above
  }

  return { ok: true, path: relPath, bytes };
}
