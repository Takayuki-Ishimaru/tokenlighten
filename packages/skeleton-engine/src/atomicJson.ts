// Plain data only — no meta envelope, no 'tokenlighten:meta' wrappers.
// Reason: docs/00-postmortem.md §2.2

/**
 * atomicJson.ts — the single write-tmp-then-rename primitive every
 * skeleton-engine on-disk artifact (source-index.v1.json, tl-graph.json,
 * publish-journal.v1.json) publishes through.
 *
 * V11-09 (Incremental Index / Graph Update v2) extracted this out of
 * indexStore.ts's writeManifest and graphBuilder.ts's writeGraphIfStale,
 * which had hand-duplicated the identical five-step sequence (safety-check
 * parent, safety-check target, write tmp with a unique name, re-check
 * safety, rename). The duplication itself was harmless, but it meant a
 * crash-recovery fault injector had no single seam to hook — this module IS
 * that seam: `beforeRename` (test-only) fires after the tmp file is
 * DURABLY on disk and before the publishing rename, so a test can simulate
 * a process crash at that exact instant by throwing there.
 *
 * CRASH SAFETY. `fs.rename` is atomic within one filesystem: a reader of
 * `targetPath` always observes either the complete OLD bytes or the
 * complete NEW bytes, never a torn mix — this is the load-bearing property
 * every caller relies on. A crash (real, or fault-injected via
 * `beforeRename`) before the rename leaves `targetPath` untouched (the old
 * content, or its prior absence, stands) and orphans the tmp file, which
 * this function now best-effort unlinks on any post-write failure (the
 * original hand-written call sites did not — an orphaned tmp file was
 * previously permanent litter under `.tokenlighten/`, which is harmless but
 * unbounded across repeated crashes; cleaning it up here is a strict
 * improvement, not a behavior callers could have depended on).
 */

import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { assertSafeWriteTarget, ensureSafeWriteParent } from "./safeWritePath.js";

export interface AtomicJsonWriteHooks {
  /**
   * Test-only fault injection. Invoked synchronously after the tmp file is
   * durably written, immediately before the publishing rename. Throwing
   * here simulates a crash between temp-write and rename: the caller sees
   * the thrown error, the tmp file is best-effort cleaned up, and
   * `targetPath` is provably untouched. Never set outside this package's
   * own fault-injection specs (see `__tests__/helpers/faultInjector.ts`).
   */
  beforeRename?: () => void;
}

/**
 * Write `serialized` to `targetPath` (already-JSON-stringified — callers
 * decide their own key-sorting/compaction policy) via write-tmp-then-rename,
 * guarded the same way every existing skeleton-engine writer already was:
 * `ensureSafeWriteParent`/`assertSafeWriteTarget` before AND after the tmp
 * write (the second pass catches a symlink swapped into the parent while
 * the tmp write was in flight).
 *
 * `makeTmpPath(dir)` lets each caller keep its own on-disk naming
 * convention (source-index.v1.<pid>.<ts>.tmp vs tl-graph.json.<pid>.<ts>.tmp
 * vs publish-journal.v1.<pid>.<ts>.tmp) — this function does not prescribe
 * one, it only prescribes the durability sequence around it.
 */
export async function writeJsonAtomic(
  root: string,
  targetPath: string,
  serialized: string,
  makeTmpPath: (dir: string) => string,
  hooks?: AtomicJsonWriteHooks,
): Promise<void> {
  ensureSafeWriteParent(root, targetPath, true);
  assertSafeWriteTarget(root, targetPath);

  const tmpPath = makeTmpPath(dirname(targetPath));
  await fs.writeFile(tmpPath, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });

  try {
    ensureSafeWriteParent(root, targetPath, false);
    assertSafeWriteTarget(root, targetPath);
    hooks?.beforeRename?.();
    await fs.rename(tmpPath, targetPath);
  } catch (err) {
    try {
      await fs.unlink(tmpPath);
    } catch {
      // best-effort — the thrown `err` below is the real signal; a failed
      // cleanup must never mask it.
    }
    throw err;
  }
}
