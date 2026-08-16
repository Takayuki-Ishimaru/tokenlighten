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

import * as fs from "fs";
import * as path from "path";
import { makeTmpPath } from "../write/atomicWrite.js";
import { batchCheckpoint } from "../write/checkpoint.js";
import type { GuardedWorkspaceRoot } from "../write/guardedWorkspace.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreateFileInput {
  path: string;
  content: string;
}

export type CreateFileResult =
  | { ok: true; path: string; bytes: number }
  | { ok: false; error: "file_exists" | "path_escapes_root" | "write_disabled" | "write_error" | "mkdir_error"; message?: string };

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
  if (!allowWrite) {
    return { ok: false, error: "write_disabled" };
  }

  const relPath = input.path;
  if (!relPath) {
    return { ok: false, error: "path_escapes_root", message: "path is required" };
  }

  // Lexical path traversal check.
  const resolvedWorkspace = path.resolve(workspace);
  const absPath = path.resolve(workspace, relPath);
  if (!absPath.startsWith(resolvedWorkspace + path.sep) && absPath !== resolvedWorkspace) {
    return { ok: false, error: "path_escapes_root" };
  }

  // Realpath escape check for symlinks.
  let workspaceReal: string;
  try {
    workspaceReal = fs.realpathSync(resolvedWorkspace);
  } catch {
    workspaceReal = resolvedWorkspace;
  }

  // Verify the parent directory (if it exists) doesn't resolve outside workspace.
  // For new paths, we walk up to the first existing ancestor and realpath it.
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
    // Realpath check failed — fall through; lexical check already passed above
  }

  // Reject any pre-existing directory entry at the target — regular file,
  // directory, valid symlink, or a DANGLING symlink (2026-08-13 hardening).
  // lstat inspects the entry ITSELF and never follows a final symlink, unlike
  // stat (which follows it). That distinction is exactly the hole this
  // replaces: statSync on a dangling symlink follows it to a target that
  // doesn't exist and throws ENOENT — indistinguishable from "nothing at this
  // path at all" — so a dangling symlink used to slip past this check even
  // though a directory entry genuinely occupies the name. lstatSync throws
  // ENOENT only when there is truly no entry here, dangling or not.
  try {
    fs.lstatSync(absPath);
    // If we reach here, some entry already exists at this path.
    return { ok: false, error: "file_exists" };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      // Some other lstat error (permissions, etc.) — reject.
      return { ok: false, error: "file_exists", message: `Cannot stat path: ${(err as Error).message}` };
    }
    // ENOENT means nothing exists at this path — proceed.
  }

  // mkdir -p the parent directory.
  const parentDir = path.dirname(absPath);
  try {
    fs.mkdirSync(parentDir, { recursive: true });
  } catch (err) {
    return {
      ok: false,
      error: "mkdir_error",
      message: `Cannot create directory: ${(err as Error).message}`,
    };
  }

  // Write the content to a tmp file in the same directory, then PUBLISH it
  // to absPath with a no-replace primitive (2026-08-13 hardening,
  // CWE-59/CWE-367). The previous publish step was retryRename(tmpPath,
  // absPath) — rename() ALWAYS replaces an existing destination, so a file
  // that raced into existence at absPath between the lstat check above and
  // this publish was silently clobbered, even though create_file's whole
  // contract is "refuse when something is already there."
  //
  // fs.linkSync is the atomic POSIX no-replace primitive: it creates a
  // second directory entry (absPath) for the SAME inode as tmpPath and fails
  // with EEXIST — leaving whatever raced into that name untouched — if
  // anything already occupies absPath. The tmp name is then unlinked,
  // leaving only the published file at absPath with content/mode identical
  // to what the old rename-based path produced (both start from the same
  // freshly-written tmp file, and link() shares the inode rather than
  // copying it, so no mode-preservation step is needed here either).
  //
  // link() is unavailable on some filesystems/platforms (FAT32/exFAT, some
  // network or overlay filesystems). Any linkSync failure OTHER than EEXIST
  // (a genuine race — or, defensively, EISDIR if a race left a directory at
  // the target) is treated as "link() unusable here" and falls back to a
  // direct O_CREAT|O_EXCL|O_WRONLY ("wx") write straight to absPath. That
  // flag combination is specified to fail with EEXIST — and to never follow
  // a symlink at the target, dangling or not — regardless of filesystem, so
  // the no-replace guarantee holds even without link() support. It is
  // non-atomic (a reader could in principle observe a partial write mid-call)
  // but that trade-off is acceptable here: the property this hardening
  // exists to guarantee is no-replace, not read-atomicity — and the fsync/
  // mode behavior is otherwise unchanged from the pre-existing path (neither
  // the old code nor either branch here calls fsync or passes an explicit
  // mode; both rely on the process's default create mode, same as today).
  const tmpPath = makeTmpPath(absPath);
  try {
    fs.writeFileSync(tmpPath, input.content, "utf8");
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    return {
      ok: false,
      error: "write_error",
      message: `Cannot write file: ${(err as Error).message}`,
    };
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
      // same refusal as the pre-existing-file case above.
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      return { ok: false, error: "file_exists" };
    }
    // link() itself is unusable on this filesystem/platform — abandon the
    // tmp file and fall back to a direct no-replace write on absPath.
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    try {
      fs.writeFileSync(absPath, input.content, { encoding: "utf8", flag: "wx" });
    } catch (fallbackErr) {
      const fallbackCode = (fallbackErr as NodeJS.ErrnoException).code;
      if (fallbackCode === "EEXIST" || fallbackCode === "EISDIR") {
        return { ok: false, error: "file_exists" };
      }
      return {
        ok: false,
        error: "write_error",
        message: `Cannot write file: ${(fallbackErr as Error).message}`,
      };
    }
  }

  const bytes = Buffer.byteLength(input.content, "utf8");

  // Shadow-git checkpoint (non-fatal on failure).
  try {
    batchCheckpoint(workspace, [relPath], sessionId);
  } catch {
    // Checkpoint failure is non-fatal — file is written, just not checkpointed.
  }

  return { ok: true, path: relPath, bytes };
}
