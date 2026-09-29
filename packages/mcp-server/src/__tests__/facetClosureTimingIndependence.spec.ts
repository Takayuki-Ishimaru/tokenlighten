/**
 * facetClosureTimingIndependence.spec.ts — FIX-FAB item 11 (orchestrator
 * report, 2026-09-27): a facet-closure completeness decision must be a
 * function of deterministic WORK budgets, never of wall-clock elapsed time.
 *
 * CONFIRMED ROOT CAUSE (PERF agent, reproduced independently by this agent
 * running `replayCorpus.spec.ts` under this same wave's shared, loaded
 * machine — `sfflag1` failed on both runs): `callSitesForFocalMember`'s
 * per-file loop and `recoverFacetClosureCandidates`'s `planSitesComplete`
 * both raced `Date.now()` against `concernRecovery.ts`'s
 * `CUMULATIVE_LOCATE_BUDGET_MS` (1000 ms) — a budget sized for a completely
 * different, genuinely variable-cost operation (a workspace-wide locate
 * call). A caller-site scan's own work is a HANDFUL of already-cached file
 * reads, deterministically capped by `MAX_CALLER_FILES_EXAMINED`; under
 * concurrent load on a shared box, that fixed, tiny amount of work could
 * still cross the 1-second mark, flipping the pack's own certificate from
 * `act.answer` to `discover` for reasons having nothing to do with the
 * evidence found.
 *
 * This file proves the FIX (readCodeTaskPack.ts's `FACET_CLOSURE_EMERGENCY_BUDGET_MS`,
 * 20 s, used only as a last-resort circuit breaker) by injecting a
 * synthetic slow clock — `Date.now()` advances by a fixed, large increment
 * on every call, simulating a box so loaded that ordinary synchronous work
 * "costs" hundreds of milliseconds of wall-clock per step. A small,
 * deterministically-bounded scan (well under `MAX_CALLER_FILES_EXAMINED`)
 * must report `complete:true` under that clock — proving the decision no
 * longer depends on how fast the box happens to be — while the SAME clock
 * against the OLD 1-second-class budget demonstrably starves the identical
 * scan, which is the documented root cause, not a hypothesis.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import {
  plainFunctionCallerSites,
  FileReadCache,
  FACET_CLOSURE_EMERGENCY_BUDGET_MS,
} from "../features/task-pack/readCodeTaskPack.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();
const tmpDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of tmpDirs.splice(0)) {
    try {
      await rmDirWithRetry(dir);
    } catch {
      /* best-effort cleanup */
    }
  }
});

function makeWorkspace(): string {
  const ws = fs.realpathSync(shortTmpDir(HOME, ".tl-timing-"));
  tmpDirs.push(ws);
  return ws;
}

function writeFile(ws: string, rel: string, content: string): void {
  const abs = path.join(ws, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

/** The OLD budget this item's confirmed root cause raced against (concernRecovery.ts's `CUMULATIVE_LOCATE_BUDGET_MS`) — a literal here, not an import, so this test keeps proving the OLD number even if that module's own constant is ever retuned for its own (unrelated) purpose. */
const OLD_RACY_BUDGET_MS = 1000;

/** Installs a synthetic clock that advances by `stepMs` on every `Date.now()` call, starting from the real current time. Returns the value `Date.now()` will report on the NEXT call (i.e. the baseline a caller should build a deadline from). */
function installSlowClock(stepMs: number): number {
  const base = Date.now();
  let calls = 0;
  vi.spyOn(Date, "now").mockImplementation(() => base + (calls += 1) * stepMs);
  return base + stepMs;
}

function buildFiveCallerWorkspace(): { ws: string; member: string; focalPath: string } {
  const ws = makeWorkspace();
  const focalPath = "src/policy.ts";
  writeFile(ws, focalPath, "export function isTransient(status: number): boolean {\n  return status >= 500;\n}\n");
  for (let i = 0; i < 5; i++) {
    writeFile(
      ws,
      `src/callers/caller${i}.ts`,
      `import { isTransient } from "../policy";\n\nexport function check${i}(status: number): boolean {\n  return isTransient(status);\n}\n`,
    );
  }
  return { ws, member: "isTransient", focalPath };
}

describe("item 11 — caller-site scan completeness is a function of work done, not wall-clock speed", () => {
  it("a small, deterministically-bounded scan (5 files, well under MAX_CALLER_FILES_EXAMINED) completes under the NEW emergency budget despite a synthetic slow clock advancing 300ms per tick", () => {
    const { ws, member, focalPath } = buildFiveCallerWorkspace();
    const cache = new FileReadCache();
    const nextNow = installSlowClock(300);
    const deadline = nextNow + FACET_CLOSURE_EMERGENCY_BUDGET_MS;

    const result = plainFunctionCallerSites(member, focalPath, {}, ws, cache, false, deadline);

    expect(result.complete).toBe(true);
    expect(result.sites.length).toBe(5);
  });

  it("documents the CONFIRMED root cause: the SAME slow clock against the OLD ~1-second-class budget starves the identical, otherwise-instant scan", () => {
    const { ws, member, focalPath } = buildFiveCallerWorkspace();
    const cache = new FileReadCache();
    const nextNow = installSlowClock(300);
    const deadline = nextNow + OLD_RACY_BUDGET_MS;

    const result = plainFunctionCallerSites(member, focalPath, {}, ws, cache, false, deadline);

    // At 300ms/tick, the deadline (1000ms out) is exceeded partway through
    // the 5-file loop — exactly the load-dependent cutoff that flipped
    // `planSitesComplete` (and therefore act.answer -> discover) under real
    // concurrent load. This is the FAILING shape the fix above replaces.
    expect(result.complete).toBe(false);
    expect(result.sites.length).toBeLessThan(5);
  });

  it("the two runs above examine the IDENTICAL fixture and differ only in which budget the same slow clock is measured against — proving the completeness decision, not the evidence, is what the old budget raced", () => {
    const { ws, member, focalPath } = buildFiveCallerWorkspace();
    const cacheNew = new FileReadCache();
    const nextNowNew = installSlowClock(300);
    const newResult = plainFunctionCallerSites(member, focalPath, {}, ws, cacheNew, false, nextNowNew + FACET_CLOSURE_EMERGENCY_BUDGET_MS);
    vi.restoreAllMocks();

    const cacheOld = new FileReadCache();
    const nextNowOld = installSlowClock(300);
    const oldResult = plainFunctionCallerSites(member, focalPath, {}, ws, cacheOld, false, nextNowOld + OLD_RACY_BUDGET_MS);

    // Same fixture, same clock shape — the only difference is the budget.
    expect(newResult.sites.map((s) => s.path).sort()).toEqual(
      Array.from({ length: 5 }, (_, i) => `src/callers/caller${i}.ts`).sort(),
    );
    expect(newResult.complete).toBe(true);
    expect(oldResult.complete).toBe(false);
  });

  it("recall control: a REAL (unmocked) clock completes the same small scan too — the fix does not depend on the mock, only on the budget no longer being tight enough to race ordinary work", () => {
    const { ws, member, focalPath } = buildFiveCallerWorkspace();
    const cache = new FileReadCache();
    const deadline = Date.now() + FACET_CLOSURE_EMERGENCY_BUDGET_MS;

    const result = plainFunctionCallerSites(member, focalPath, {}, ws, cache, false, deadline);

    expect(result.complete).toBe(true);
    expect(result.sites.length).toBe(5);
  });
});
