// killServerGroup.ts — kills a tsx-wrapped spec-local dev server as a whole
// process group, never just its direct child.
//
// A `spawn()` call whose arguments are `process.execPath` and an args array
// starting `TSX_CLI, "--liftoff-only", BIN_TS, ...` re-execs through tsx: the
// process that `spawn()` call returns is the tsx WRAPPER, and the real
// `bin.ts` MCP server tsx runs is that wrapper's GRANDCHILD. `child.kill
// ("SIGKILL")` alone reaches only the wrapper — on a wrapper that re-execs
// rather than replacing its own PID, the grandchild server can keep running
// as an orphan (PPID 1, ~190 MB each; see testServerMemoryFence.spec.ts's
// header for the memory story). Confirmed by hand (start `tl mcp start
// --stdio`, SIGKILL the wrapper's pid alone: the grandchild can outlive it)
// before relying on this — same finding readRequestContinuation.spec.ts's
// header and `qualityFirstScenarios.ts`'s `spawnJsonRpcServer().kill()`
// document and fix the same way.
//
// The fix is at the SPAWN site, not here: pass `detached: process.platform
// !== "win32"` to `spawn()` so the wrapper becomes its own process-group
// leader (POSIX) and the grandchild inherits that group. `process.kill(-pid,
// ...)` then reaches both in one signal. win32 has no such group semantics
// for `detached`, so there `child.kill(...)` (direct-child only) is already
// the best available; concurrent restart flows on any platform may call this
// twice or on an already-exited child, so any failure (ESRCH, or the group
// simply being gone already) is a silent no-op, never a throw.
import type { ChildProcess } from "node:child_process";

/**
 * Best-effort SIGKILL of `child`'s whole process group (POSIX, when it was
 * spawned with `detached: true` and still has a pid) or of `child` itself
 * (win32, or no pid). Safe to call on an already-exited child, safe to call
 * twice — every failure is swallowed.
 */
export function killServerGroup(child: ChildProcess | undefined | null): void {
  if (!child) return;
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
