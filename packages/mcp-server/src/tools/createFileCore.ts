/**
 * createFileCore.ts — shared CREATE-A-NEW-FILE primitives.
 *
 * F-V13-2 (DESIGN-v0.13-plan.md §"進行記録", 2026-08-29 triage): a single
 * edits[] batch mixing a `create:true` item with existing-file search/replace
 * items failed the create item with a misleading "File not found" — the
 * batch dispatch (server.ts's typedEdits construction loop / applyEditsMulti's
 * Phase 1) had no notion of "this item's target is SUPPOSED to be absent"
 * and forced every item through the existing-file `fs.statSync` check.
 *
 * Factored out of createFile.ts (the single edit_file `create:true` path) so
 * the batch edits[] create path (applyEditsMulti.ts) shares the EXACT same
 * security/no-replace guarantees instead of re-deriving them and risking
 * drift. createFile.ts and applyEditsMulti.ts each keep their own call-site
 * concerns (the write-enable gate, shadow-git checkpoint granularity — one
 * per call here, one per BATCH there — cache invalidation timing, and
 * response shaping); this module carries only the mechanism:
 *
 *   1. `validateCreateTarget` — is it SAFE and LEGAL to create at this path:
 *      no lexical ".." traversal, no realpath escape at the first existing
 *      ancestor, and nothing already occupies the target (lstat-based, so a
 *      dangling symlink counts as "occupied" too).
 *   2. `publishNewFile` — mkdir -p the parent, then publish the content with
 *      a NO-REPLACE primitive (tmp file + fs.linkSync, falling back to a
 *      direct O_CREAT|O_EXCL|O_WRONLY "wx" write when link() is unsupported
 *      on the target filesystem/platform) so a file that races into
 *      existence between step 1 and this call is refused, never clobbered
 *      (CWE-59/CWE-367 — see createFile.ts's original doc comment for the
 *      full incident history this hardening answers).
 *
 * Neither function checks the --allow-write gate or takes a shadow-git
 * checkpoint — those stay call-site concerns (createFile.ts's single-create
 * gate; applyEditsMulti.ts's batch-level gate + Phase-3 checkpoint covering
 * every path the batch touched, created or edited alike).
 */

import * as fs from "fs";
import * as path from "path";
import { makeTmpPath } from "../write/atomicWrite.js";

// ---------------------------------------------------------------------------
// validateCreateTarget
// ---------------------------------------------------------------------------

export type CreateTargetValidation =
  | { ok: true; absPath: string }
  | { ok: false; error: "path_escapes_root" | "file_exists"; message?: string };

/**
 * Validate a workspace-relative path is safe to CREATE at (never to read or
 * edit — this is a "nothing should be here yet" check, the inverse of every
 * other path guard in this codebase). Byte-identical logic to createFile.ts's
 * original inline checks:
 *
 *   - `relPath` must be non-empty.
 *   - Lexical traversal: the resolved absolute path must stay under the
 *     workspace root.
 *   - Realpath escape: walking up from the target to the first EXISTING
 *     ancestor, that ancestor's realpath must stay under the workspace's own
 *     realpath (defends against a symlinked ancestor directory).
 *   - Pre-existing entry: `lstat` (never `stat`, which follows a final
 *     symlink and would treat a dangling one as "nothing here") on the exact
 *     target — a regular file, a directory, a valid symlink, OR a dangling
 *     symlink all refuse, because a directory entry already occupies the
 *     name in every one of those cases.
 */
export function validateCreateTarget(relPath: string, workspace: string): CreateTargetValidation {
  if (!relPath) {
    return { ok: false, error: "path_escapes_root", message: "path is required" };
  }

  const resolvedWorkspace = path.resolve(workspace);
  const absPath = path.resolve(workspace, relPath);
  if (!absPath.startsWith(resolvedWorkspace + path.sep) && absPath !== resolvedWorkspace) {
    return { ok: false, error: "path_escapes_root" };
  }

  let workspaceReal: string;
  try {
    workspaceReal = fs.realpathSync(resolvedWorkspace);
  } catch {
    workspaceReal = resolvedWorkspace;
  }

  try {
    let cur = path.dirname(absPath);
    while (true) {
      try {
        const real = fs.realpathSync(cur);
        if (real !== workspaceReal && !real.startsWith(workspaceReal + path.sep)) {
          return { ok: false, error: "path_escapes_root" };
        }
        break; // ancestor is within workspace
      } catch {
        const parent = path.dirname(cur);
        if (parent === cur) break; // hit filesystem root — fall through to lexical check
        cur = parent;
      }
    }
  } catch {
    // Realpath check failed — fall through; lexical check already passed above.
  }

  try {
    fs.lstatSync(absPath);
    // If we reach here, some entry already exists at this path.
    return { ok: false, error: "file_exists" };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      return { ok: false, error: "file_exists", message: `Cannot stat path: ${(err as Error).message}` };
    }
    // ENOENT means nothing exists at this path — proceed.
  }

  return { ok: true, absPath };
}

// ---------------------------------------------------------------------------
// publishNewFile
// ---------------------------------------------------------------------------

export type PublishNewFileResult =
  | { ok: true; bytes: number }
  | { ok: false; error: "mkdir_error" | "write_error" | "file_exists"; message?: string };

/**
 * mkdir -p the parent directory, then publish `content` at `absPath` with a
 * NO-REPLACE primitive: a tmp file in the same directory + `fs.linkSync`
 * (falls back to a direct `O_CREAT|O_EXCL|O_WRONLY` "wx" write when link()
 * is unsupported on the target filesystem/platform — FAT32/exFAT, some
 * network or overlay filesystems). Race-safe: any entry that appears at
 * `absPath` between `validateCreateTarget`'s check and this call is refused,
 * never clobbered.
 *
 * Caller's responsibility: the --allow-write gate, `validateCreateTarget`
 * having already passed, and (best-effort, after success) invalidating any
 * cached workspace file listing — createFile.ts and applyEditsMulti.ts each
 * do this on their own call-site schedule.
 */
export function publishNewFile(absPath: string, content: string): PublishNewFileResult {
  const parentDir = path.dirname(absPath);
  try {
    fs.mkdirSync(parentDir, { recursive: true });
  } catch (err) {
    return { ok: false, error: "mkdir_error", message: `Cannot create directory: ${(err as Error).message}` };
  }

  const tmpPath = makeTmpPath(absPath);
  try {
    fs.writeFileSync(tmpPath, content, "utf8");
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    return { ok: false, error: "write_error", message: `Cannot write file: ${(err as Error).message}` };
  }

  try {
    fs.linkSync(tmpPath, absPath);
    // Best-effort: the file is already published under absPath at this
    // point, so a failure to remove the tmp name is just litter, not a
    // correctness problem.
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
  } catch (linkErr) {
    const linkCode = (linkErr as NodeJS.ErrnoException).code;
    if (linkCode === "EEXIST" || linkCode === "EISDIR") {
      // Genuine race: something now occupies absPath. No-replace held — the
      // tmp file (never published) is discarded and the caller sees the
      // same refusal as the pre-existing-file case.
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      return { ok: false, error: "file_exists" };
    }
    // link() itself is unusable on this filesystem/platform — abandon the
    // tmp file and fall back to a direct no-replace write on absPath.
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    try {
      fs.writeFileSync(absPath, content, { encoding: "utf8", flag: "wx" });
    } catch (fallbackErr) {
      const fallbackCode = (fallbackErr as NodeJS.ErrnoException).code;
      if (fallbackCode === "EEXIST" || fallbackCode === "EISDIR") {
        return { ok: false, error: "file_exists" };
      }
      return { ok: false, error: "write_error", message: `Cannot write file: ${(fallbackErr as Error).message}` };
    }
  }

  const bytes = Buffer.byteLength(content, "utf8");
  return { ok: true, bytes };
}
