// killServerGroup.ts — kills a spec-local dev server as a whole process
// group, never just its direct child.
//
// The fix is at the SPAWN site, not here: pass `detached: process.platform
// !== "win32"` to `spawn()` so the process it returns becomes its own
// process-group leader (POSIX) and everything it starts inherits that group.
// `process.kill(-pid, ...)` then reaches all of them in one signal, where
// `child.kill("SIGKILL")` alone reaches only the direct child and can leave
// the rest running as orphans (PPID 1, ~190 MB each for a server; see
// testServerMemoryFence.spec.ts's header for the memory story). Dev servers
// spawned with helpers/tsxNode.ts are one process, but they can start
// children of their own (language servers, workers), and a server launched
// through a wrapper — the `tl` CLI, or the tsx CLI these specs used before
// tsxNode.ts — runs as the wrapper's child: confirmed by hand (start `tl mcp
// start --stdio`, SIGKILL the wrapper's pid alone: the child can outlive it),
// the same finding `qualityFirstScenarios.ts`'s `spawnJsonRpcServer().kill()`
// documents.
//
// win32 has no such group semantics for `detached`, so there `child.kill(...)`
// (direct-child only) is already the best available; concurrent restart flows
// on any platform may call this twice or on an already-exited child, so any
// failure (ESRCH, or the group simply being gone already) is a silent no-op,
// never a throw.
import type { ChildProcess } from "node:child_process";

import { isPooledChild } from "./serverPool.js";

/**
 * Best-effort SIGKILL of `child`'s whole process group (POSIX, when it was
 * spawned with `detached: true` and still has a pid) or of `child` itself
 * (win32, or no pid). Safe to call on an already-exited child, safe to call
 * twice — every failure is swallowed.
 */
export function killServerGroup(child: ChildProcess | undefined | null): void {
  if (!child) return;
  // A pooled lease (helpers/serverPool.ts) shares its process group with the
  // pool: kill() ends the lease, and the pool decides whether the process dies.
  if (isPooledChild(child)) {
    child.kill("SIGKILL");
    return;
  }
  try {
    if (process.platform !== "win32" && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    // Already exited, or the group is gone — best-effort cleanup.
    try {
      child.kill("SIGKILL");
    } catch {
      /* ok */
    }
  }
}
