/**
 * consistencyScan.spec.ts — V11-09 (Incremental Index / Graph Update v2):
 * bounded self-heal mechanics, TL_INDEX_CONSISTENCY_SCAN flag gating
 * (default OFF), and its opportunistic wiring inside loadOrBuildSourceIndex.
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
import type { SourceIndexManifestV1, IndexedFileV1 } from "../indexStore.js";
import { runConsistencyScan, consistencyScanEnabledFromEnv } from "../consistencyScan.js";
import { writeSameStatWithoutInvalidate, wholeSecondMtime } from "./helpers/faultInjector.js";

let tmpDir: string;
const ORIGINAL_ENV = process.env["TL_INDEX_CONSISTENCY_SCAN"];

beforeEach(async () => {
  tmpDir = join(tmpdir(), `consistencyScan-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(join(tmpDir, "src"), { recursive: true });
  resetManifestMemoForTest();
  delete process.env["TL_INDEX_CONSISTENCY_SCAN"];
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  if (ORIGINAL_ENV === undefined) delete process.env["TL_INDEX_CONSISTENCY_SCAN"];
  else process.env["TL_INDEX_CONSISTENCY_SCAN"] = ORIGINAL_ENV;
});

function makeFile(overrides: Partial<IndexedFileV1> & { path: string }): IndexedFileV1 {
  return {
    language: "typescript",
    sizeBytes: 100,
    mtimeMs: 1000,
    contentSha256: "unused-in-these-tests",
    symbols: [],
    chunks: [],
    outgoingSymbolRefs: {},
    ...overrides,
  };
}

function makeManifest(files: Record<string, IndexedFileV1>): SourceIndexManifestV1 {
  return {
    version: 1,
    engineVersion: "x",
    repoRootRealpath: tmpDir,
    ignoreHash: "h",
    builtFromCommit: "c",
    rootHash: "unused",
    generation: 1,
    files,
    directories: {},
  };
}

describe("consistencyScanEnabledFromEnv", () => {
  it("defaults to true when unset (on by default since 2026-08-21)", () => {
    expect(consistencyScanEnabledFromEnv()).toBe(true);
  });

  it.each(["1", "true", "TRUE", "yes", "YES", "on", "On"])("%s => true", (val) => {
    process.env["TL_INDEX_CONSISTENCY_SCAN"] = val;
    expect(consistencyScanEnabledFromEnv()).toBe(true);
  });

  it.each(["0", "false", "no", "off", ""])("%s => false (explicit opt-out)", (val) => {
    process.env["TL_INDEX_CONSISTENCY_SCAN"] = val;
    expect(consistencyScanEnabledFromEnv()).toBe(false);
  });

  // Unrecognized values fall back to the default (true) — mirroring
  // flags.ts's own parseBool convention, not a fixed "false".
  it.each(["maybe", "2"])("%s => true (unrecognized falls back to the default)", (val) => {
    process.env["TL_INDEX_CONSISTENCY_SCAN"] = val;
    expect(consistencyScanEnabledFromEnv()).toBe(true);
  });
});

describe("runConsistencyScan — bounded mechanics", () => {
  it("an all-fresh manifest reports zero dropped and returns the SAME manifest reference (no-op re-persist avoided)", async () => {
    await fs.writeFile(join(tmpDir, "a.ts"), "hello", "utf8");
    const { hashContent } = await import("../merkle.js");
    const manifest = makeManifest({
      "a.ts": makeFile({ path: "a.ts", contentSha256: hashContent(Buffer.from("hello")) }),
    });

    const { manifest: result, result: report } = await runConsistencyScan(tmpDir, manifest);
    expect(report).toEqual({
      scanned: 1,
      ok: 1,
      dropped: 0,
      truncated: false,
      durationMs: expect.any(Number),
      droppedPaths: [],
    });
    expect(result).toBe(manifest);
  });

  it("drops an entry whose disk content no longer matches contentSha256", async () => {
    await fs.writeFile(join(tmpDir, "a.ts"), "changed-content", "utf8");
    const manifest = makeManifest({
      "a.ts": makeFile({ path: "a.ts", contentSha256: "stale-sha-does-not-match" }),
    });

    const { manifest: result, result: report } = await runConsistencyScan(tmpDir, manifest);
    expect(report.dropped).toBe(1);
    expect(report.droppedPaths).toEqual(["a.ts"]);
    expect(result.files["a.ts"]).toBeUndefined();
    expect(result).not.toBe(manifest);
  });

  it("drops an entry whose file is missing on disk entirely", async () => {
    // Never written to disk at all.
    const manifest = makeManifest({
      "gone.ts": makeFile({ path: "gone.ts", contentSha256: "whatever" }),
    });

    const { manifest: result, result: report } = await runConsistencyScan(tmpDir, manifest);
    expect(report.dropped).toBe(1);
    expect(result.files["gone.ts"]).toBeUndefined();
  });

  it("dropping entries bumps generation and recomputes rootHash/directories", async () => {
    await fs.writeFile(join(tmpDir, "a.ts"), "hello", "utf8");
    const { hashContent } = await import("../merkle.js");
    const manifest = {
      ...makeManifest({
        "a.ts": makeFile({ path: "a.ts", contentSha256: hashContent(Buffer.from("hello")) }),
        "stale.ts": makeFile({ path: "stale.ts", contentSha256: "wrong" }),
      }),
      generation: 7,
    };
    await fs.writeFile(join(tmpDir, "stale.ts"), "some other content", "utf8");

    const { manifest: result } = await runConsistencyScan(tmpDir, manifest);
    expect(result.generation).toBe(8);
    expect(result.rootHash).not.toBe(manifest.rootHash);
    expect(Object.keys(result.files)).toEqual(["a.ts"]);
  });

  it("never touches (or drops) a 'failed' entry — no sentinel sha to verify, dropping it would recreate the false-absence bug", async () => {
    // The file genuinely does not exist on disk (matching a real "failed"
    // entry's typical cause), but the scan must not treat that as grounds
    // to drop it — "failed" entries are excluded from the scan's candidate
    // pool entirely (see consistencyScan.ts's scannableCandidates).
    const manifest = makeManifest({
      "unreadable.ts": makeFile({ path: "unreadable.ts", contentSha256: "", parseStatus: "failed" }),
    });

    const { manifest: result, result: report } = await runConsistencyScan(tmpDir, manifest);
    expect(report.scanned).toBe(0);
    expect(report.dropped).toBe(0);
    expect(result.files["unreadable.ts"]).toBeDefined();
    expect(result).toBe(manifest);
  });

  it("respects maxFiles: only samples up to the bound and reports truncated:true", async () => {
    const files: Record<string, IndexedFileV1> = {};
    for (let i = 0; i < 10; i++) {
      const path = `f${i}.ts`;
      await fs.writeFile(join(tmpDir, path), `content-${i}`, "utf8");
      const { hashContent } = await import("../merkle.js");
      files[path] = makeFile({ path, contentSha256: hashContent(Buffer.from(`content-${i}`)) });
    }
    const manifest = makeManifest(files);

    const { result: report } = await runConsistencyScan(tmpDir, manifest, { maxFiles: 3 });
    expect(report.scanned).toBe(3);
    expect(report.truncated).toBe(true);
  });

  it("respects maxDurationMs: stops early once the soft budget elapses", async () => {
    const files: Record<string, IndexedFileV1> = {};
    for (let i = 0; i < 20; i++) {
      const path = `f${i}.ts`;
      await fs.writeFile(join(tmpDir, path), `content-${i}`, "utf8");
      const { hashContent } = await import("../merkle.js");
      files[path] = makeFile({ path, contentSha256: hashContent(Buffer.from(`content-${i}`)) });
    }
    const manifest = makeManifest(files);

    // 0ms budget — the very first elapsed-time check (before the first
    // file) should already trip.
    const { result: report } = await runConsistencyScan(tmpDir, manifest, { maxFiles: 1000, maxDurationMs: 0 });
    expect(report.truncated).toBe(true);
    expect(report.scanned).toBeLessThan(20);
  });
});

describe("consistencyScan — opportunistic wiring inside loadOrBuildSourceIndex (flag-gated)", () => {
  it("explicitly OFF (opt-out via \"0\"): a same-stat-swapped file dropped invalidation residual is NOT caught by the scan", async () => {
    process.env["TL_INDEX_CONSISTENCY_SCAN"] = "0";
    const filePath = join(tmpDir, "src", "a.ts");
    const pinnedMtimeSec = wholeSecondMtime();
    await fs.writeFile(filePath, "export function hello() { return 1; }\n", "utf8");
    await fs.utimes(filePath, pinnedMtimeSec, pinnedMtimeSec);
    await loadOrBuildSourceIndex(tmpDir, { commit: "c", ignoreHash: "h" });

    await writeSameStatWithoutInvalidate(filePath, "export function hello() { return 9; }\n", pinnedMtimeSec);

    const second = await loadOrBuildSourceIndex(tmpDir, { commit: "c", ignoreHash: "h" });
    // Explicitly opted out — the manifest memo's whole-match shortcut still
    // serves the stale entry (proven separately in faultInjection.spec.ts);
    // this test only asserts the SCAN itself did not fire (no warning).
    expect(second.warnings.some((w) => w.includes("consistency scan"))).toBe(false);
  });

  it("default (flag genuinely unset, on since 2026-08-21): catches the SAME dropped-invalidation swap, even on the memo whole-match shortcut path", async () => {
    const filePath = join(tmpDir, "src", "a.ts");
    const pinnedMtimeSec = wholeSecondMtime();
    await fs.writeFile(filePath, "export function hello() { return 1; }\n", "utf8");
    await fs.utimes(filePath, pinnedMtimeSec, pinnedMtimeSec);
    await loadOrBuildSourceIndex(tmpDir, { commit: "c", ignoreHash: "h" });

    // Same-stat swap, no invalidate, and the env is genuinely unset here
    // (beforeEach's own delete, not touched further) — this exercises the
    // DEFAULT posture, not an opt-in. Deliberately do NOT reset the memo:
    // the whole point is that this exact sequence would normally hit the
    // memo's whole-match shortcut and return early, never re-reading any
    // file, unless the scan (now on by default) catches it.
    await writeSameStatWithoutInvalidate(filePath, "export function hello() { return 9; }\n", pinnedMtimeSec);

    const result = await loadOrBuildSourceIndex(tmpDir, { commit: "c", ignoreHash: "h" });
    expect(result.warnings.some((w) => w.includes("consistency scan dropped"))).toBe(true);
    // a.ts was dropped by the scan within this SAME call — absent here,
    // not silently stale.
    expect(result.manifest.files["src/a.ts"]).toBeUndefined();

    // The repair persisted to disk within this same call too.
    const persisted = await loadManifest(tmpDir);
    expect(persisted!.files["src/a.ts"]).toBeUndefined();

    // The very next ordinary call re-adds it, now genuinely fresh.
    const recovered = await loadOrBuildSourceIndex(tmpDir, { commit: "c", ignoreHash: "h" });
    expect(recovered.manifest.files["src/a.ts"]!.symbols[0]!.signature).toContain("return 9");
  });

  it("flag explicitly ON (\"1\"): catches the SAME dropped-invalidation swap the opt-out test above misses, even on the memo whole-match shortcut path", async () => {
    process.env["TL_INDEX_CONSISTENCY_SCAN"] = "1";
    const filePath = join(tmpDir, "src", "a.ts");
    const pinnedMtimeSec = wholeSecondMtime();
    await fs.writeFile(filePath, "export function hello() { return 1; }\n", "utf8");
    await fs.utimes(filePath, pinnedMtimeSec, pinnedMtimeSec);
    await loadOrBuildSourceIndex(tmpDir, { commit: "c", ignoreHash: "h" });

    // Same-stat swap, no invalidate — deliberately do NOT reset the memo:
    // the whole point is that this exact sequence would normally hit the
    // memo's whole-match shortcut and return early, never re-reading any
    // file. The scan is wired into THAT exact path (not just the full
    // per-file-loop path) precisely so a flag-ON caller still catches this.
    await writeSameStatWithoutInvalidate(filePath, "export function hello() { return 9; }\n", pinnedMtimeSec);

    const result = await loadOrBuildSourceIndex(tmpDir, { commit: "c", ignoreHash: "h" });
    expect(result.warnings.some((w) => w.includes("consistency scan dropped"))).toBe(true);
    // a.ts was dropped by the scan within this SAME call — absent here,
    // not silently stale.
    expect(result.manifest.files["src/a.ts"]).toBeUndefined();

    // The repair persisted to disk within this same call too.
    const persisted = await loadManifest(tmpDir);
    expect(persisted!.files["src/a.ts"]).toBeUndefined();

    // The very next ordinary call re-adds it, now genuinely fresh.
    const recovered = await loadOrBuildSourceIndex(tmpDir, { commit: "c", ignoreHash: "h" });
    expect(recovered.manifest.files["src/a.ts"]!.symbols[0]!.signature).toContain("return 9");
  });
});
