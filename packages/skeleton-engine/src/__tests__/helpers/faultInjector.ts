// Plain data only — no meta envelope, no 'tokenlighten:meta' wrappers.
// Reason: docs/00-postmortem.md §2.2

/**
 * faultInjector.ts — test-only fault injection helpers for V11-09's
 * (Incremental Index / Graph Update v2) crash/race hardening suite.
 *
 * Every export below drives ONE of the five fault categories the V11-09
 * design brief lists — (a) dropped invalidation, (b) duplicate
 * invalidation, (c) reordered invalidate/write, (d) concurrent invalidate
 * during a build, (e) crash mid-publish — using the PRODUCTION code's own
 * real seams (loadOrBuildSourceIndex's `opts.__testHooks`,
 * invalidateCachedWorkspaceFiles itself, atomicJson.ts's `beforeRename`)
 * rather than reimplementing or mocking them. A fault "injected" this way
 * is faithful to what a real crash/race actually does to on-disk state and
 * in-process caches, not an approximation of it — this file only NAMES and
 * COMPOSES those seams for readability in the specs that drive them.
 */

import { promises as fs } from "node:fs";
import { invalidateCachedWorkspaceFiles } from "../../indexStore.js";
import type { IndexFaultHooksForTest } from "../../indexStore.js";

/** Same helper indexStore.spec.ts already uses locally — see its own doc
 * comment (V10-10 section) for why a WHOLE-SECOND timestamp, not merely a
 * "close" one, is required to make "same size AND same mtime" an exact,
 * platform-independent precondition instead of a flaky one. */
export function wholeSecondMtime(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * (a) Dropped invalidation. Performs a same-stat content swap (size and a
 * PINNED whole-second mtime both held constant across the swap — the
 * documented V10-10 shape, achievable in practice on a coarse filesystem
 * timestamp or two writes landing in the same clock tick) WITHOUT calling
 * invalidateCachedWorkspaceFiles afterward — exactly what a write path
 * that forgot to call it, or an external tool bypassing TL's write seams
 * entirely, would produce.
 *
 * DOCUMENTED RESIDUAL, not a bug this helper's specs paper over: a dropped
 * invalidation for a same-stat swap is caught ONLY once something else
 * causes the per-file loop to re-examine this exact file with fresh bytes
 * in hand (a DIFFERENT file changing busts the memo's whole-manifest stat
 * fingerprint and re-enters the per-file loop, where P1.4's content-hash
 * gate — always run against freshly re-read bytes — catches this file's
 * swap too) or an explicit consistencyScan run (TL_INDEX_CONSISTENCY_SCAN)
 * happens to sample this path. Absent either of those, the swap is served
 * stale indefinitely: AGENTS.md names this "external same-stat writes"
 * case as the accepted residual, and it is precisely what an omitted
 * invalidate call reproduces.
 */
export async function writeSameStatWithoutInvalidate(
  filePath: string,
  content: string,
  pinnedMtimeSec: number,
): Promise<void> {
  await fs.writeFile(filePath, content, "utf8");
  await fs.utimes(filePath, pinnedMtimeSec, pinnedMtimeSec);
  // Deliberately NO invalidateCachedWorkspaceFiles call — that omission is
  // the fault under test.
}

/**
 * (b) Duplicate invalidation. Calls invalidateCachedWorkspaceFiles TWICE in
 * immediate succession for the same root/paths — specs assert idempotency:
 * no throw, and the resulting memo state is the same as a single call
 * would have produced.
 */
export function invalidateTwice(root: string, relPaths?: string[]): void {
  invalidateCachedWorkspaceFiles(root, relPaths);
  invalidateCachedWorkspaceFiles(root, relPaths);
}

/**
 * (c) Reordered invalidate/write. Every production write seam (mcp-server's
 * createFile.ts, searchReplaceEdit.ts, artifactEdit.ts, atomicWrite.ts)
 * calls invalidateCachedWorkspaceFiles AFTER the write lands, never
 * before — this helper drives the INVERTED order to prove the system
 * degrades safely (at most one redundant re-parse on the next build, never
 * corruption or a wrong-forever result) even though no production call
 * site actually produces this ordering today.
 */
export async function invalidateBeforeWrite(
  root: string,
  relPath: string,
  writeFn: () => Promise<void>,
): Promise<void> {
  invalidateCachedWorkspaceFiles(root, [relPath]);
  await writeFn();
}

/**
 * (d) Concurrent invalidate during an in-flight loadOrBuildSourceIndex
 * call. Returns `opts.__testHooks` that fire a REAL, synchronous
 * invalidateCachedWorkspaceFiles call the first time the per-file loop
 * reaches `onFile` — single-threaded JS has no true concurrency, so firing
 * partway through an in-flight build's own per-file loop (well before that
 * build reaches its own publish decision at the end) stands in for
 * "another async task got a turn on the event loop and completed its
 * invalidate call before this build finished."
 */
export function injectConcurrentInvalidateDuringBuild(
  root: string,
  onFile: string,
  relPathsToInvalidate?: string[],
): IndexFaultHooksForTest {
  let fired = false;
  return {
    midBuild: (relPath: string) => {
      if (fired || relPath !== onFile) return;
      fired = true;
      invalidateCachedWorkspaceFiles(root, relPathsToInvalidate);
    },
  };
}

/**
 * (e) Crash mid-publish. Returns `opts.__testHooks` that throw the FIRST
 * time the named target's tmp file is durably written but before the
 * publishing rename — simulating a process crash at that exact instant via
 * the SAME `beforeRename` seam atomicJson.ts's real writer already calls
 * in production (writeJsonAtomic), not a separate mock of it.
 */
export function injectCrashBeforeRename(
  target: "manifest" | "graph" | "journal",
): IndexFaultHooksForTest {
  const crash = (): never => {
    throw new Error(`fault-injector: simulated crash before ${target} rename`);
  };
  switch (target) {
    case "manifest":
      return { beforeManifestRename: crash };
    case "graph":
      return { beforeGraphRename: crash };
    case "journal":
      return { beforeJournalRename: crash };
  }
}

/**
 * Merge several `opts.__testHooks` objects (e.g. a crash hook plus a
 * midBuild hook) into one. Later hooks win on a field collision — specs
 * needing more than one fault at once should keep them on DIFFERENT
 * fields (this suite never needs to compose two hooks on the SAME field).
 */
export function composeFaultHooks(...hooks: IndexFaultHooksForTest[]): IndexFaultHooksForTest {
  return Object.assign({}, ...hooks);
}
