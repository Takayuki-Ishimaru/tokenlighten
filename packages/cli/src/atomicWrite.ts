/**
 * atomicWrite.ts — safe tmp-file rename with EBUSY retry (Windows file-lock).
 *
 * Design: docs/components/06-platform-support.md §10.3
 *   - tmp file lives in the SAME directory as target (no cross-filesystem EXDEV)
 *   - EBUSY (Windows lock contention) is retried with exponential backoff 50→200ms
 *   - EROFS and other errors surface immediately (no retry)
 *   - On final failure the tmp file is cleaned up before throwing
 *
 * Output policy: plain data — no meta envelope.
 * See docs/00-postmortem.md §2.2 for rationale.
 */

import { renameSync, unlinkSync } from "fs";
import { join, dirname, basename } from "path";
import { randomBytes } from "crypto";

export class AtomicWriteError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "AtomicWriteError";
  }
}

/** Synchronous busy-wait using a Date.now loop (safe on config write path, not hot). */
function sleepSync(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // busy-wait — acceptable: config write is cold path, max 200ms
  }
}

/**
 * Rename src → dst with retry on EBUSY (Windows file-lock contention).
 * Other errors (EROFS, EACCES, …) surface immediately.
 *
 * Backoff schedule: 50, 100, 150, 200 ms between attempts (5 attempts total;
 * the last attempt fails immediately with no further delay).
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

      // Exponential backoff capped at capMs: 50, 100, 150, 200, …
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
  return join(dir, '.' + base + '.tl-' + hex + '.tmp');
}
