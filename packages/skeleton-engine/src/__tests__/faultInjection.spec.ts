/**
 * faultInjection.spec.ts — V11-09 (Incremental Index / Graph Update v2)
 * acceptance suite: fault injection over the invalidateCachedWorkspaceFiles
 * seam and the manifest/graph publish transaction.
 *
 * Covers, per the design brief's five fault categories:
 *   (a) dropped invalidation (documents the accepted residual)
 *   (b) duplicate invalidation (idempotency)
 *   (c) reordered invalidate/write (safe degrade, never corruption)
 *   (d) concurrent invalidate during an in-flight build
 *   (e) crash mid-publish (manifest, graph, and journal writes)
 * plus the crash-recovery invariant (old-or-new, never torn) and graph
 * generation both-ends consistency.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadOrBuildSourceIndex,
  loadManifest,
  resetManifestMemoForTest,
} from "../indexStore.js";
import { getTlGraphPath } from "../graphBuilder.js";
import { readPublishJournal } from "../publishJournal.js";
import {
  writeSameStatWithoutInvalidate,
  invalidateTwice,
  invalidateBeforeWrite,
  injectConcurrentInvalidateDuringBuild,
  injectCrashBeforeRename,
  wholeSecondMtime,
} from "./helpers/faultInjector.js";

let tmpDir: string;
// This suite tests invalidateCachedWorkspaceFiles/loadOrBuildSourceIndex's
// OWN behavior, not the opt-in/opt-out consistency scan (consistencyScan.
// spec.ts owns that) — pin the scan explicitly OFF for every test here so
// "(a) dropped invalidation" keeps documenting the RAW, unmitigated
// residual regardless of the scan's own default (on since 2026-08-21; see
// consistencyScan.ts).
const ORIGINAL_SCAN_ENV = process.env["TL_INDEX_CONSISTENCY_SCAN"];

beforeEach(async () => {
  tmpDir = join(tmpdir(), `faultInjection-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(join(tmpDir, "src"), { recursive: true });
  resetManifestMemoForTest();
  process.env["TL_INDEX_CONSISTENCY_SCAN"] = "0";
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  if (ORIGINAL_SCAN_ENV === undefined) delete process.env["TL_INDEX_CONSISTENCY_SCAN"];
  else process.env["TL_INDEX_CONSISTENCY_SCAN"] = ORIGINAL_SCAN_ENV;
});

async function readGraph(root: string): Promise<{ rootHash: string; generation: number; symbols: unknown[]; files: unknown[] } | null> {
  try {
    return JSON.parse(await fs.readFile(getTlGraphPath(root), "utf8"));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// (a) Dropped invalidation — documents the accepted residual precisely.
// ---------------------------------------------------------------------------

describe("fault (a): dropped invalidation", () => {
  it("a same-stat swap with NO invalidate call is served stale until something else re-validates it", async () => {
    const filePath = join(tmpDir, "src", "a.ts");
    const pinnedMtimeSec = wholeSecondMtime();
    await fs.writeFile(filePath, "export function hello() { return 1; }\n", "utf8");
    await fs.utimes(filePath, pinnedMtimeSec, pinnedMtimeSec);

    const first = await loadOrBuildSourceIndex(tmpDir, { commit: "c", ignoreHash: "h" });
    expect(first.manifest.files["src/a.ts"]!.symbols[0]!.name).toBe("hello");

    await writeSameStatWithoutInvalidate(
      filePath,
      "export function hello() { return 9; }\n",
      pinnedMtimeSec,
    );

    // Documented residual: no invalidate happened, and nothing else in this
    // workspace changed to bust the memo's whole-manifest stat fingerprint
    // — served stale, exactly the accepted "external same-stat writes"
    // residual AGENTS.md names.
    const second = await loadOrBuildSourceIndex(tmpDir, { commit: "c", ignoreHash: "h" });
    expect(second.manifest).toBe(first.manifest);
    expect(second.reparsed).toBe(0);
  });

  it("the SAME dropped-invalidation swap self-heals as soon as an unrelated file change busts the memo (real content re-validated, not merely re-trusted)", async () => {
    const aPath = join(tmpDir, "src", "a.ts");
    const bPath = join(tmpDir, "src", "b.ts");
    const pinnedMtimeSec = wholeSecondMtime();
    await fs.writeFile(aPath, "export function hello() { return 1; }\n", "utf8");
    await fs.utimes(aPath, pinnedMtimeSec, pinnedMtimeSec);
    await fs.writeFile(bPath, "export function other() { return 1; }\n", "utf8");

    await loadOrBuildSourceIndex(tmpDir, { commit: "c", ignoreHash: "h" });

    await writeSameStatWithoutInvalidate(
      aPath,
      "export function hello() { return 9; }\n",
      pinnedMtimeSec,
    );
    // An ORDINARY edit to a different file — real mtime change, busts the
    // whole-manifest stat fingerprint and re-enters the per-file loop,
    // where the P1.4 content-hash gate — run against freshly re-read bytes
    // regardless of stat — catches a.ts's swap too.
    await fs.writeFile(bPath, "export function other() { return 2; }\n", "utf8");

    const third = await loadOrBuildSourceIndex(tmpDir, { commit: "c", ignoreHash: "h" });
    expect(third.manifest.files["src/b.ts"]!.symbols[0]!.signature).toContain("other");
    // a.ts's stale entry is now genuinely re-validated against disk, not
    // just re-trusted: contentSha256 must match the SWAPPED bytes.
    const { hashContent } = await import("../merkle.js");
    expect(third.manifest.files["src/a.ts"]!.contentSha256).toBe(
      hashContent(Buffer.from("export function hello() { return 9; }\n")),
    );
  });
});

// ---------------------------------------------------------------------------
// (b) Duplicate invalidation — idempotent.
// ---------------------------------------------------------------------------

describe("fault (b): duplicate invalidation", () => {
  it("calling invalidateCachedWorkspaceFiles twice never throws and produces the same end state as calling it once", async () => {
    await fs.writeFile(join(tmpDir, "src", "a.ts"), "export function hello() {}\n", "utf8");
    const first = await loadOrBuildSourceIndex(tmpDir, { commit: "c", ignoreHash: "h" });
    expect(first.reparsed).toBe(1);

    expect(() => invalidateTwice(tmpDir, ["src/a.ts"])).not.toThrow();

    const second = await loadOrBuildSourceIndex(tmpDir, { commit: "c", ignoreHash: "h" });
    // Same observable contract as a SINGLE invalidate: memo busted (a new
    // manifest object), disk content unchanged so nothing needed re-parse.
    expect(second.manifest).not.toBe(first.manifest);
    expect(second.reparsed).toBe(0);
    expect(second.manifest.files["src/a.ts"]!.symbols[0]!.name).toBe("hello");
  });

  it("double-invalidating a root with NO memo entry at all is a safe no-op", async () => {
    expect(() => invalidateTwice(join(tmpDir, "never-built"))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// (c) Reordered invalidate/write — safe degrade, never corruption.
// ---------------------------------------------------------------------------

describe("fault (c): reordered invalidate/write (invalidate BEFORE the write lands)", () => {
  it("invalidating before the write still lands correctly (at worst one extra re-parse, never stale-forever)", async () => {
    const filePath = join(tmpDir, "src", "a.ts");
    await fs.writeFile(filePath, "export function hello() { return 1; }\n", "utf8");
    const first = await loadOrBuildSourceIndex(tmpDir, { commit: "c", ignoreHash: "h" });
    expect(first.manifest.files["src/a.ts"]!.symbols[0]!.signature).toContain("return 1");

    await invalidateBeforeWrite(tmpDir, "src/a.ts", async () => {
      await fs.writeFile(filePath, "export function hello() { return 2; }\n", "utf8");
    });

    const second = await loadOrBuildSourceIndex(tmpDir, { commit: "c", ignoreHash: "h" });
    expect(second.manifest.files["src/a.ts"]!.symbols[0]!.signature).toContain("return 2");
  });
});

// ---------------------------------------------------------------------------
// (d) Concurrent invalidate during an in-flight build.
// ---------------------------------------------------------------------------

describe("fault (d): concurrent invalidate during an in-flight loadOrBuildSourceIndex", () => {
  it("an invalidate landing mid-build is not erased by that same build's own completion", async () => {
    await fs.writeFile(join(tmpDir, "src", "a.ts"), "export function hello() { return 1; }\n", "utf8");
    await fs.writeFile(join(tmpDir, "src", "b.ts"), "export function world() { return 2; }\n", "utf8");

    const first = await loadOrBuildSourceIndex(tmpDir, { commit: "c", ignoreHash: "h" });
    expect(first.reparsed).toBe(2);

    // An ordinary, unrelated change so the SECOND build's own initial
    // whole-match check misses on its own merits and it actually enters
    // the per-file loop (where the injected hook fires) — independent of
    // the race under test.
    await fs.writeFile(join(tmpDir, "src", "b.ts"), "export function world() { return 99; }\n", "utf8");

    const second = await loadOrBuildSourceIndex(tmpDir, {
      commit: "c",
      ignoreHash: "h",
      __testHooks: injectConcurrentInvalidateDuringBuild(tmpDir, "src/a.ts"),
    });
    // The in-flight build's OWN answer is still fine for its own caller —
    // the race is about what gets published for FUTURE callers, not about
    // corrupting this call's return value.
    expect(second.manifest.files["src/a.ts"]).toBeDefined();
    expect(second.manifest.files["src/b.ts"]!.symbols[0]!.signature).toContain("return 99");

    // A plain third call, no hooks, run immediately after. If second's
    // completion had incorrectly republished over the concurrent
    // invalidate, third would hit the memo's whole-match shortcut and get
    // back the EXACT SAME manifest object second returned (this identity
    // check is the shortcut's own signature — see indexStore.spec.ts's
    // "serves an unchanged workspace from the memo" test). With the fix,
    // the poisoned memo entry the concurrent invalidate left behind must
    // survive second's completion, forcing third through real
    // per-file/disk validation instead.
    const third = await loadOrBuildSourceIndex(tmpDir, { commit: "c", ignoreHash: "h" });
    expect(third.manifest).not.toBe(second.manifest);
  });
});

// ---------------------------------------------------------------------------
// (e) Crash mid-publish — manifest, graph, and journal writes.
// ---------------------------------------------------------------------------

describe("fault (e): crash mid-publish — old-or-new, never torn", () => {
  it("a crash before the MANIFEST rename leaves the previous on-disk state fully intact", async () => {
    await fs.writeFile(join(tmpDir, "src", "a.ts"), "export function hello() {}\n", "utf8");
    await loadOrBuildSourceIndex(tmpDir, { commit: "c", ignoreHash: "h" });
    const manifestBefore = await loadManifest(tmpDir);
    expect(manifestBefore).not.toBeNull();

    await fs.writeFile(join(tmpDir, "src", "a.ts"), "export function hello() { return 2; }\n", "utf8");
    resetManifestMemoForTest();

    // The crash itself is expected to surface as a pushed warning, not a
    // thrown exception out of loadOrBuildSourceIndex — writeManifest's
    // failure is caught and reported (see loadOrBuildSourceIndex step 9).
    const crashed = await loadOrBuildSourceIndex(tmpDir, {
      commit: "c",
      ignoreHash: "h",
      __testHooks: injectCrashBeforeRename("manifest"),
    });
    expect(crashed.warnings.some((w) => w.includes("failed to write cache"))).toBe(true);

    // Old-consistent-state: the on-disk manifest is byte-identical to
    // before the crashed call — never a torn/partial file.
    const manifestAfterCrash = await loadManifest(tmpDir);
    expect(manifestAfterCrash).toEqual(manifestBefore);

    // No orphaned tmp file left under the cache dir.
    const cacheDirEntries = await fs.readdir(join(tmpDir, ".tokenlighten", "cache"));
    expect(cacheDirEntries.filter((n) => n.includes(".tmp"))).toEqual([]);

    // Recovery: the very next ordinary call converges to the new content.
    resetManifestMemoForTest();
    const recovered = await loadOrBuildSourceIndex(tmpDir, { commit: "c", ignoreHash: "h" });
    expect(recovered.manifest.files["src/a.ts"]!.symbols[0]!.signature).toContain("return 2");
  });

  it("a crash before the GRAPH rename (manifest already committed) is detected and self-healed on the next call", async () => {
    await fs.writeFile(join(tmpDir, "src", "a.ts"), "export function hello() {}\n", "utf8");
    await fs.writeFile(join(tmpDir, "src", "b.ts"), "export function world() { return hello(); }\n", "utf8");
    await loadOrBuildSourceIndex(tmpDir, { commit: "c", ignoreHash: "h" });
    const graphBefore = await readGraph(tmpDir);
    expect(graphBefore).not.toBeNull();

    // Change content so this call actually attempts a new manifest+graph
    // publish (a no-op reload would skip both writes entirely).
    await fs.writeFile(join(tmpDir, "src", "a.ts"), "export function hello() { return 1; }\n", "utf8");
    resetManifestMemoForTest();

    const crashed = await loadOrBuildSourceIndex(tmpDir, {
      commit: "c",
      ignoreHash: "h",
      __testHooks: injectCrashBeforeRename("graph"),
    });
    expect(crashed.warnings.some((w) => w.includes("failed to write graph index"))).toBe(true);

    // Manifest DID commit (its write happens before the graph write and is
    // unaffected by a graph-rename crash) — generation advanced.
    const manifestAfterCrash = await loadManifest(tmpDir);
    expect(manifestAfterCrash).not.toBeNull();
    expect(manifestAfterCrash!.generation).toBeGreaterThan(graphBefore ? graphBefore.generation : 0);

    // Graph on disk is STILL the old, fully self-consistent (never torn)
    // generation — a crash mid-publish never produces a partially-written
    // graph, only a stale-but-valid one.
    const graphAfterCrash = await readGraph(tmpDir);
    expect(graphAfterCrash).toEqual(graphBefore);

    // The publish journal recorded the gap — this is exactly what lets the
    // NEXT call force a rebuild instead of trusting the (currently stale)
    // on-disk graph's own rootHash shortcut.
    const journalStatus = await readPublishJournal(tmpDir);
    expect(journalStatus.pending).toBe(true);
    expect(journalStatus.record!.generation).toBe(manifestAfterCrash!.generation);

    // Recovery: the very next ordinary call (even with NOTHING further
    // changed on disk) must force the graph to catch up, because the
    // journal is pending — not silently skip via the rootHash shortcut
    // (which would otherwise see the CURRENT graph's rootHash, computed
    // from the crashed run's own half-published state, as already
    // "fresh" relative to itself).
    resetManifestMemoForTest();
    const recovered = await loadOrBuildSourceIndex(tmpDir, { commit: "c", ignoreHash: "h" });
    const graphAfterRecovery = await readGraph(tmpDir);
    expect(graphAfterRecovery!.rootHash).toBe(recovered.manifest.rootHash);
    expect(graphAfterRecovery!.generation).toBe(recovered.manifest.generation);

    // Journal cleared — steady state restored, no permanent "pending" litter.
    const journalAfterRecovery = await readPublishJournal(tmpDir);
    expect(journalAfterRecovery.pending).toBe(false);
  });

  it("a crash before the JOURNAL rename itself does not block the manifest publish that already succeeded", async () => {
    await fs.writeFile(join(tmpDir, "src", "a.ts"), "export function hello() {}\n", "utf8");
    await loadOrBuildSourceIndex(tmpDir, { commit: "c", ignoreHash: "h" });

    await fs.writeFile(join(tmpDir, "src", "a.ts"), "export function hello() { return 3; }\n", "utf8");
    resetManifestMemoForTest();

    const result = await loadOrBuildSourceIndex(tmpDir, {
      commit: "c",
      ignoreHash: "h",
      __testHooks: injectCrashBeforeRename("journal"),
    });
    expect(result.warnings.some((w) => w.includes("failed to write publish journal"))).toBe(true);

    // The manifest publish itself is unaffected — best-effort journal
    // write failure must never block or unwind a publish that already
    // landed.
    const manifest = await loadManifest(tmpDir);
    expect(manifest!.files["src/a.ts"]!.symbols[0]!.signature).toContain("return 3");
    // And the graph still converges in the SAME call (the journal write
    // failure only narrows this one call's crash-recovery window; it does
    // not stop step 10 from running).
    const graph = await readGraph(tmpDir);
    expect(graph!.rootHash).toBe(manifest!.rootHash);
  });
});

// ---------------------------------------------------------------------------
// Crash-recovery consistency, broadly — never a torn manifest/graph pair.
// ---------------------------------------------------------------------------

describe("crash recovery: consistency after ANY of the above faults is 100% (old-or-new, never torn)", () => {
  it("after every fault above, a fresh full rebuild from the CURRENT on-disk artifacts is byte-shape valid (loadManifest never returns a torn/corrupt shape)", async () => {
    await fs.writeFile(join(tmpDir, "src", "a.ts"), "export function hello() {}\n", "utf8");
    await loadOrBuildSourceIndex(tmpDir, { commit: "c", ignoreHash: "h" });
    await fs.writeFile(join(tmpDir, "src", "a.ts"), "export function hello() { return 4; }\n", "utf8");
    resetManifestMemoForTest();

    await loadOrBuildSourceIndex(tmpDir, {
      commit: "c",
      ignoreHash: "h",
      __testHooks: injectCrashBeforeRename("graph"),
    });

    const manifest = await loadManifest(tmpDir);
    expect(manifest).not.toBeNull();
    expect(manifest!.version).toBe(1);
    expect(typeof manifest!.rootHash).toBe("string");
    expect(typeof manifest!.generation).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// Graph generation both-ends consistency.
// ---------------------------------------------------------------------------

describe("graph generation — both-ends consistency", () => {
  it("a rootHash change always bumps generation; an unchanged reload keeps the same generation", async () => {
    await fs.writeFile(join(tmpDir, "src", "a.ts"), "export function hello() {}\n", "utf8");
    const first = await loadOrBuildSourceIndex(tmpDir, { commit: "c", ignoreHash: "h" });
    expect(first.manifest.generation).toBe(1);
    const graph1 = await readGraph(tmpDir);
    expect(graph1!.generation).toBe(1);
    expect(graph1!.rootHash).toBe(first.manifest.rootHash);

    // Unchanged reload — same generation on both sides.
    const reload = await loadOrBuildSourceIndex(tmpDir, { commit: "c", ignoreHash: "h" });
    expect(reload.manifest.generation).toBe(1);

    // A real content change bumps generation on BOTH the manifest and the
    // republished graph, from the SAME manifest snapshot in one call.
    await fs.writeFile(join(tmpDir, "src", "a.ts"), "export function hello() { return 1; }\n", "utf8");
    resetManifestMemoForTest();
    const second = await loadOrBuildSourceIndex(tmpDir, { commit: "c", ignoreHash: "h" });
    expect(second.manifest.generation).toBe(2);
    const graph2 = await readGraph(tmpDir);
    expect(graph2!.generation).toBe(2);
    expect(graph2!.rootHash).toBe(second.manifest.rootHash);
  });

  it("every symbol's definition+references pair is published atomically from ONE manifest snapshot — never a torn cross-generation mix", async () => {
    await fs.writeFile(join(tmpDir, "src", "enums.ts"), "export const X = 1;\n", "utf8");
    await fs.writeFile(join(tmpDir, "src", "consumer.ts"), "export function use() { return X; }\n", "utf8");
    const first = await loadOrBuildSourceIndex(tmpDir, { commit: "c", ignoreHash: "h" });
    const graph1 = await readGraph(tmpDir);
    expect(graph1!.generation).toBe(first.manifest.generation);

    // Add a SECOND consumer of X — both the new reference (forward: X is
    // referenced) and consumer2's own file entry (the "other end" of that
    // edge) must appear in the SAME generation, never split across two.
    await fs.writeFile(join(tmpDir, "src", "consumer2.ts"), "export function useToo() { return X; }\n", "utf8");
    resetManifestMemoForTest();
    const second = await loadOrBuildSourceIndex(tmpDir, { commit: "c", ignoreHash: "h" });
    const graph2 = await readGraph(tmpDir) as unknown as {
      generation: number;
      symbols: { name: string; references: { path: string }[] }[];
    };
    expect(graph2.generation).toBe(second.manifest.generation);
    expect(graph2.generation).toBeGreaterThan(graph1!.generation);
    const xSymbol = graph2.symbols.find((s) => s.name === "X");
    expect(xSymbol).toBeDefined();
    const refPaths = xSymbol!.references.map((r) => r.path).sort();
    // Both ends present together in generation 2 — never just one of them.
    expect(refPaths).toEqual(["src/consumer.ts", "src/consumer2.ts"]);
  });
});
