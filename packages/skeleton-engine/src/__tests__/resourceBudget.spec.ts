/**
 * resourceBudget.spec.ts — V11-09 (Incremental Index / Graph Update v2):
 * cold vs warm loadOrBuildSourceIndex resource-budget evidence.
 * The caching contract is asserted with exact counts: cold reparses every
 * file, a memo-warm reload reparses/reads nothing further, and a disk-cache-
 * warm reload reuses every entry via content-hash validation without a
 * single re-extraction.
 *
 * Elapsed-time evidence is intentionally limited to the memo shortcut, whose
 * margin is large enough to survive normal CI noise. Disk-cache-warm still
 * reads and hashes every file, so its wall-clock time can be comparable to a
 * cold parse for this synthetic fixture even when the reuse contract is
 * working correctly. The exact reparsed/reused assertions above are the
 * deterministic regression gate for that path.
 *
 * The remaining timing check uses interleaved cold/warm pairs summed across
 * several rounds. Interleaving reduces scheduler and GC bias between the two
 * arms; summing avoids making any assertion about absolute milliseconds or
 * individual rounds.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadOrBuildSourceIndex, resetManifestMemoForTest } from "../indexStore.js";

let tmpDir: string;

const FIXTURE_FILE_COUNT = 300;
const SYMBOLS_PER_FILE = 20;
const PAIRED_ROUNDS = 12;

async function seedFixture(root: string): Promise<void> {
  const srcDir = join(root, "src");
  await fs.mkdir(srcDir, { recursive: true });
  const writes: Promise<void>[] = [];
  for (let i = 0; i < FIXTURE_FILE_COUNT; i++) {
    const lines: string[] = [];
    // Many symbols per file — cold extraction cost (regex symbol scan +
    // chunking) scales with symbol count, not just byte count, so this
    // widens the real gap between "skip extraction" (warm) and "run it"
    // (cold) beyond what raw file size alone would give.
    for (let s = 0; s < SYMBOLS_PER_FILE; s++) {
      lines.push(`export function fn${i}_${s}(x: number) { return x + ${i} + ${s}; }`);
    }
    lines.push(`export class Widget${i} { value = ${i}; method() { return this.value; } }`);
    lines.push(`export const CONST_${i} = ${i};`);
    lines.push("");
    writes.push(fs.writeFile(join(srcDir, `module${i}.ts`), lines.join("\n"), "utf8"));
  }
  await Promise.all(writes);
}

async function measureMs(fn: () => Promise<unknown>): Promise<number> {
  const start = performance.now();
  await fn();
  return performance.now() - start;
}

/**
 * Runs `rounds` interleaved (cold, warm) pairs and returns the SUMMED
 * wall-clock time on each side — see the file's own doc comment for why
 * interleaving-then-summing, rather than a single sample or a per-round
 * win-fraction, is what makes this robust to shared-machine noise.
 * `warmBeforeEach` re-establishes whichever warm state (memo-populated, or
 * memo-cleared-but-disk-cached) this call is measuring, immediately before
 * each warm measurement.
 */
async function pairedColdVsWarmTotals(
  rounds: number,
  coldCall: () => Promise<unknown>,
  warmBeforeEach: () => Promise<unknown>,
  warmCall: () => Promise<unknown>,
): Promise<{ totalColdMs: number; totalWarmMs: number }> {
  let totalColdMs = 0;
  let totalWarmMs = 0;
  for (let i = 0; i < rounds; i++) {
    totalColdMs += await measureMs(coldCall);
    await warmBeforeEach();
    totalWarmMs += await measureMs(warmCall);
  }
  return { totalColdMs, totalWarmMs };
}

beforeEach(async () => {
  tmpDir = join(tmpdir(), `resourceBudget-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await seedFixture(tmpDir);
  resetManifestMemoForTest();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("cold vs warm — counts (exact, not timing-based)", () => {
  it("cold reparses every file; a memo-warm reload reparses none of them", async () => {
    const cold = await loadOrBuildSourceIndex(tmpDir, { commit: "c", ignoreHash: "h" });
    expect(cold.reparsed).toBe(FIXTURE_FILE_COUNT);
    expect(cold.reused).toBe(0);

    const warm = await loadOrBuildSourceIndex(tmpDir, { commit: "c", ignoreHash: "h" });
    expect(warm.reparsed).toBe(0);
    // The memo whole-match shortcut reports every file as "reused" without
    // ever touching disk content again.
    expect(warm.reused).toBe(FIXTURE_FILE_COUNT);
    expect(warm.manifest).toBe(cold.manifest); // same object — proves the shortcut fired
  });

  it("disk-cache-warm (memo cleared, on-disk cache intact) reuses every entry via content-hash validation, reparsing none", async () => {
    await loadOrBuildSourceIndex(tmpDir, { commit: "c", ignoreHash: "h" });
    resetManifestMemoForTest();

    const diskWarm = await loadOrBuildSourceIndex(tmpDir, { commit: "c", ignoreHash: "h" });
    expect(diskWarm.reparsed).toBe(0);
    expect(diskWarm.reused).toBe(FIXTURE_FILE_COUNT);
  });

  it("noCache:true always reparses every file, warm or not", async () => {
    await loadOrBuildSourceIndex(tmpDir, { commit: "c", ignoreHash: "h" });
    const forced = await loadOrBuildSourceIndex(tmpDir, { commit: "c", ignoreHash: "h", noCache: true });
    expect(forced.reparsed).toBe(FIXTURE_FILE_COUNT);
    expect(forced.reused).toBe(0);
  });
});

describe("cold vs warm — timing (loose: interleaved-paired totals; no absolute-ms assertion)", () => {
  it("a memo-warm reload is strictly cheaper in total than a cold (noCache:true) build, summed over interleaved rounds", async () => {
    await loadOrBuildSourceIndex(tmpDir, { commit: "c", ignoreHash: "h" }); // seed the memo once, outside the loop

    const { totalColdMs, totalWarmMs } = await pairedColdVsWarmTotals(
      PAIRED_ROUNDS,
      () => loadOrBuildSourceIndex(tmpDir, { commit: "c", ignoreHash: "h", noCache: true }),
      async () => {}, // memo already warm from the seed call above; noCache:true cold calls never touch it
      () => loadOrBuildSourceIndex(tmpDir, { commit: "c", ignoreHash: "h" }),
    );

    expect(totalWarmMs).toBeLessThan(totalColdMs);
  });

});
