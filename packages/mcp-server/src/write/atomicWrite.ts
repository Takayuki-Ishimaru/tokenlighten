/**
 * atomicWrite.ts — safe tmp-file rename with EBUSY retry (Windows file-lock).
 *
 * Replicated from packages/cli/src/atomicWrite.ts — intentionally NOT imported
 * from @tokenlighten/cli to keep the mcp-server dep graph clean.
 *
 * Design:
 *   - tmp file lives in the SAME directory as target (no cross-filesystem EXDEV)
 *   - EBUSY (Windows lock contention) is retried with exponential backoff 50→200ms
 *   - EROFS and other errors surface immediately (no retry)
 *   - On final failure the tmp file is cleaned up before throwing
 *
 * Output policy: plain data — no meta envelope.
 */

import { readFileSync, renameSync, unlinkSync, writeFileSync, chmodSync } from "fs";
import { join, dirname, basename } from "path";
import { randomBytes } from "crypto";
import { invalidateCachedWorkspaceFiles } from "@tokenlighten/skeleton-engine";
import { carryServedRangesAcrossEdit, deltaContextArmed } from "./deltaContext.js";

export class AtomicWriteError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "AtomicWriteError";
  }
}

/** Synchronous busy-wait using a Date.now loop (safe on write path, not hot). */
function sleepSync(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // busy-wait — acceptable: write is cold path, max 200ms
  }
}

/**
 * Rename src → dst with retry on EBUSY (Windows file-lock contention).
 * Other errors (EROFS, EACCES, …) surface immediately.
 *
 * Backoff schedule: 50, 100, 150, 200 ms between attempts (5 attempts total);
 * the final attempt throws immediately on failure, with no trailing delay.
 *
 * @param opts.renameFn - Injectable rename implementation (default: fs.renameSync).
 *   Useful in tests since fs.renameSync is non-configurable on Node built-ins.
 */
export function retryRename(
  src: string,
  dst: string,
  opts: {
    attempts?: number;
    baseMs?: number;
    capMs?: number;
    renameFn?: (src: string, dst: string) => void;
  } = {}
): void {
  const { attempts = 5, baseMs = 50, capMs = 200 } = opts;
  const doRename = opts.renameFn ?? ((s: string, d: string) => renameSync(s, d));

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      doRename(src, dst);
      return; // success
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;

      // Only retry EBUSY (Windows file-lock); surface all other errors immediately.
      if (code !== "EBUSY") {
        try {
          unlinkSync(src);
        } catch {
          // best-effort cleanup
        }
        throw err;
      }

      if (attempt === attempts) {
        // Final failure — clean up tmp file, then throw typed error.
        try {
          unlinkSync(src);
        } catch {
          // best-effort cleanup
        }
        throw new AtomicWriteError(
          `renameSync failed after ${attempts} attempts (EBUSY): ${src} → ${dst}`,
          err
        );
      }

      // Exponential backoff capped at capMs: 50, 100, 150, 200, 200, …
      const delay = Math.min(baseMs * attempt, capMs);
      sleepSync(delay);
    }
  }
}

/**
 * Build a tmp file path in the same directory as target.
 * Name: .<basename(target)>.tl-<6-byte-hex>.tmp
 * Placing tmp in the same directory as the target avoids EXDEV on Linux tmpfs.
 */
export function makeTmpPath(target: string): string {
  const dir = dirname(target);
  const base = basename(target);
  const hex = randomBytes(6).toString("hex");
  return join(dir, "." + base + ".tl-" + hex + ".tmp");
}

/**
 * Write `content` to `target`, replacing an EXISTING file on disk, while
 * preserving the original file's permission bits. This is THE write
 * aggregation point for edit_file's existing-file paths (single
 * search/replace, edits[] batch — including its mid-batch rollback restore —
 * and handle+range content/search-replace); every one of them funnels its
 * actual disk write through here instead of calling writeFileSync+
 * retryRename inline.
 *
 * The write goes through a same-directory temp file + retryRename (above) so
 * a reader never observes a partial write. Left alone, that scheme silently
 * resets the file to the process's default create mode (0o666 & ~umask) on
 * every edit: renameSync() replaces the whole inode, so whatever mode the
 * brand-new temp file was created with becomes the target's mode too — an
 * executable script edited through edit_file silently came back 100644
 * (2026-08-07 incident, caught only via `git diff`'s old-mode/new-mode
 * lines; the fixture's own +x bit was restored by hand).
 *
 * `originalMode` should be the `.mode` of an `fs.Stats` taken for this same
 * target before the call — every existing-file write site already stats the
 * file once (size cap check / read), so this costs no extra syscall in the
 * common case. Pass `undefined` only when no such stat exists; the write
 * then falls back to the platform default create mode (pre-fix behavior),
 * so callers must never do this for a target known to already exist.
 *
 * Mode is restored with an explicit chmod on the temp file, BEFORE the
 * rename — not the `{mode}` option on `writeFileSync`/`open`. That option's
 * mode is masked by the process umask at creation time, so it cannot
 * reliably reproduce an unusually permissive original mode (e.g. 0o775 would
 * come back as 0o755 under the common 0o022 umask). chmod has no umask
 * interaction: it always sets exactly the bits given. Only the
 * permission/setuid/setgid/sticky bits (mode & 0o7777) are applied — any
 * file-type bits carried in a raw `Stats.mode` are masked off, matching
 * chmod(2). A chmod failure is swallowed (best-effort): restoring the
 * executable bit must never be the reason a content edit that would
 * otherwise succeed gets refused.
 *
 * On any failure the temp file is removed and the error is rethrown; the
 * target itself is never touched (the rename hasn't happened yet).
 *
 * `indexInvalidation`, when given, invalidates the skeleton-engine in-process
 * source-index memo for `root` (V10-10) once the rename above has actually
 * succeeded — this function IS the write aggregation point named in its own
 * doc comment above, so it is also the narrowest single seam every
 * existing-file edit/rollback-restore funnels through. Best-effort: an
 * index-cache problem must never fail a write that already landed on disk.
 * Every production caller of this function passes it; only tests exercising
 * this module in isolation omit it.
 *
 * B2 / V12-02 (TL_DELTA_CONTEXT, default OFF) rides that SAME argument for the
 * same reason: `{root, relPath}` is what names this write to the workspace
 * session, and the sentence above — the narrowest seam every existing-file
 * edit/rollback-restore funnels through — is exactly the safety floor a ledger
 * transformation needs, namely hunks THIS server applied and nothing else. See
 * `write/deltaContext.ts`; a caller that omits `indexInvalidation` opts out of
 * both, which is why only tests do.
 */
export function writeExistingFileAtomic(
  target: string,
  content: string,
  originalMode: number | undefined,
  indexInvalidation?: { root: string; relPath: string }
): void {
  // B2 / V12-02 (TL_DELTA_CONTEXT, default OFF): capture the bytes this write
  // is about to replace, but ONLY for a path this session has actually served
  // ranges for — `deltaContextArmed` is false for every other write, including
  // every write at all while the flag is off, so no read happens.
  //
  // Taken BEFORE the rename (the target still holds the pre-edit bytes) and
  // consumed only AFTER it succeeds: a write that throws leaves the old bytes
  // AND the old ledger entry describing them, which is already correct.
  const deltaBefore = indexInvalidation !== undefined
    && deltaContextArmed(indexInvalidation.root, indexInvalidation.relPath)
    ? readPreEditText(target)
    : undefined;
  // 2026-08-27 (write-path fail-closed guard, last-resort backstop): every
  // production caller now sniffs the target's encoding BEFORE reading its
  // content for edit computation (util/textDecode.ts's detectWriteEncodingRisk)
  // and refuses rather than proceeding for a UTF-16-BOM or NUL-riddled file —
  // see rangeEdit.ts/searchReplaceEdit.ts/applyEditsMulti.ts/readAndEdit.ts/
  // renameSymbol.ts. This is the belt to that suspenders: a naive UTF-16-as-
  // UTF-8 read-modify-write bakes lossy REPLACEMENT CHARACTER (U+FFFD)
  // substitutions into `content` wherever the original bytes did not form
  // valid UTF-8 — but a UTF-16 file's ASCII-range characters interleave a
  // raw NUL between every code unit, and NUL survives that lossy decode
  // untouched. A raw NUL in content about to be written is therefore the
  // cheapest, most reliable post-hoc signature of exactly this corruption —
  // refuse here too, for any caller (present or future) that reaches this
  // function without its own upstream guard, rather than writing it.
  // (String.fromCharCode(0), not a literal escape, keeps this source file's
  // own bytes plain ASCII.)
  if (content.includes(String.fromCharCode(0))) {
    throw new AtomicWriteError(
      `refusing to write ${target}: content contains a raw NUL character, the signature of a UTF-16 (or otherwise non-UTF-8) file misread as UTF-8 upstream — this write was blocked to avoid corrupting the file`,
    );
  }
  const tmpPath = makeTmpPath(target);
  try {
    writeFileSync(tmpPath, content, "utf8");
    if (originalMode !== undefined) {
      try {
        chmodSync(tmpPath, originalMode & 0o7777);
      } catch {
        // best-effort — never block a content write over a mode restore failure
      }
    }
    retryRename(tmpPath, target);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // best-effort cleanup
    }
    throw err;
  }
  if (indexInvalidation) {
    try {
      invalidateCachedWorkspaceFiles(indexInvalidation.root, [indexInvalidation.relPath]);
    } catch {
      // best-effort — see doc comment above
    }
    if (deltaBefore !== undefined) {
      try {
        carryServedRangesAcrossEdit(
          indexInvalidation.root, indexInvalidation.relPath, deltaBefore, content,
        );
      } catch {
        // best-effort, same rule as the index invalidation above: a ledger
        // projection problem must never fail a write that already landed. The
        // untransformed entry then fails the next read's sha check and the
        // full body is served — the pre-B2 behaviour.
      }
    }
  }
}

/**
 * B2 / V12-02: the target's current bytes, or `undefined` when they cannot be
 * read as text. Never throws — a delta projection is an optimization, and a
 * missing/binary/unreadable pre-image simply means there is nothing to carry.
 */
function readPreEditText(target: string): string | undefined {
  try {
    return readFileSync(target, "utf8");
  } catch {
    return undefined;
  }
}
