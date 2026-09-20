// rmDirWithRetry.ts — Windows-safe cleanup for spawned-server test harnesses.
//
// A just-killed child process (`child.kill("SIGKILL")`) does not release its
// open file handles synchronously with the JS-visible `kill()` call
// returning: Windows delivers the signal and tears the process down
// asynchronously, so an `fs.rmSync(dir, {recursive:true,force:true})` (or a
// rename of that same directory) issued immediately afterward can observe
// EPERM/EBUSY/ENOTEMPTY while the kernel is still finishing that teardown.
// POSIX has no such failure mode (unlink/rename of a still-open file is
// legal there), so `waitForExit` and the retry loop are both effectively
// free on macOS/Linux — the child has almost always already exited, and the
// first `fs` attempt succeeds.
import { rmSync } from "node:fs";
import type { ChildProcess } from "node:child_process";

const RETRYABLE_CODES = new Set(["EPERM", "EBUSY", "ENOTEMPTY"]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolves once `child` has actually exited (or immediately if it already
 * has). Call after `child.kill(...)` and before touching a directory the
 * child had open — closes most of the Windows "handle not released yet"
 * race at its source, rather than only papering over it with retries.
 */
export function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
    // Belt and braces: a process that never emits "exit" (already reaped,
    // detached, etc.) must not hang the caller forever.
    setTimeout(resolve, 5000);
  });
}

/**
 * Runs `fn` (a synchronous fs operation such as `rmSync`/`renameSync`),
 * retrying with backoff on the transient Windows codes a just-killed
 * child's still-closing handles can cause. Not a behavior change on
 * POSIX: the first attempt is the same call that always ran here, and it
 * always succeeds there on the first try.
 */
export async function retryTransientFsOp<T>(fn: () => T, attempts = 10, delayMs = 100): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    try {
      return fn();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (i === attempts - 1 || !code || !RETRYABLE_CODES.has(code)) throw err;
      await sleep(delayMs);
    }
  }
  /* istanbul ignore next -- unreachable: the loop above always returns or throws */
  throw new Error("retryTransientFsOp: exhausted attempts without returning or throwing");
}

/** `fs.rmSync(dir, {recursive:true,force:true})` with the same retry. */
export function rmDirWithRetry(dir: string, attempts = 10, delayMs = 100): Promise<void> {
  return retryTransientFsOp(() => rmSync(dir, { recursive: true, force: true }), attempts, delayMs);
}
