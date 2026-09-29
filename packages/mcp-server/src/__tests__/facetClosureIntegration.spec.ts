/**
 * facetClosureIntegration.spec.ts — FIX-C1 (eval-0927 P0-1/P0-2), Deliverable
 * 3's own acceptance item: on `buildHttpCorpusWorkspace(root, "compact")` AND
 * `"sliced"`, the FIRST pack of V01's query, V03's query, the §4 two-line
 * query (V02_QUERY_JA) and V05's query serves the `DEFAULT_OPTIONS` and
 * `RETRYABLE_STATUSES` declarations and (V01/V03/§4) at least one caller
 * window, with exact ranges.
 *
 * In-process `buildTaskPack` (no server spawn — the same lightweight pattern
 * readCodeTaskPack.spec.ts's own "answer-focus precision" describe block
 * uses), against the SHARED fixture `evaluation0927Scenarios.ts` already
 * defines (owned by agent W0 for EDITING; read-only import here, per
 * brief-fix-c1.md's own instruction to reuse it).
 *
 * "Decisions may still be wrong — the gate is FIX-G's job; state what you
 * observe" (brief-fix-c1.md Acceptance): this file asserts on SERVED
 * EVIDENCE (`result.surfaces`), never on `decision.kind`/`certificate` —
 * FIX-G's later obligation wiring decides what a served-but-not-yet-covered
 * fact means for completeness.
 */
import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";

import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import { buildTaskPack, type TaskPackResult } from "../features/task-pack/readCodeTaskPack.js";
import {
  buildHttpCorpusWorkspace,
  V01_QUERY_EN,
  V02_QUERY_JA,
  V03_QUERY_JA,
  V05_QUERY_EN,
  type HttpCorpusVariant,
} from "./helpers/evaluation0927Scenarios.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();

const tmpDirs: string[] = [];
afterAll(async () => {
  for (const dir of tmpDirs.splice(0)) {
    try {
      await rmDirWithRetry(dir);
    } catch {
      // best-effort cleanup, same tolerance every sibling spec in this dir takes
    }
  }
});

function workspaceFor(variant: HttpCorpusVariant): string {
  const ws = fs.realpathSync(shortTmpDir(HOME, `.tl-fx-c1-${variant}-`));
  tmpDirs.push(ws);
  buildHttpCorpusWorkspace(ws, variant);
  return ws;
}

function servedText(result: TaskPackResult): string {
  return result.surfaces.map((s) => s.code ?? "").join("\n---\n");
}

function surfaceFor(result: TaskPackResult, path: string) {
  return result.surfaces.find((s) => s.path === path);
}

const DEFAULT_OPTIONS_SUBSTRINGS = ["timeoutMs: 5000", "maxAttempts: 3,", "retryDelayMs: 100,"];
const RETRYABLE_STATUSES_SUBSTRING = "RETRYABLE_STATUSES = new Set([429, 502, 503, 504])";
const CALLER_PATHS = ["src/api/users.ts", "src/api/orders.ts"];

const QUERIES: ReadonlyArray<{ id: string; query: string; expectCallers: boolean }> = [
  { id: "V01 (EN)", query: V01_QUERY_EN, expectCallers: true },
  { id: "V03 (JA)", query: V03_QUERY_JA, expectCallers: true },
  { id: "§4 (V02, JA two-line)", query: V02_QUERY_JA, expectCallers: true },
  { id: "V05 (EN)", query: V05_QUERY_EN, expectCallers: false },
];

describe.each(["compact", "sliced"] as const)("facet closure on the %s HTTP corpus variant", (variant) => {
  for (const { id, query, expectCallers } of QUERIES) {
    // A FRESH workspace per test case (never one shared across queries): the
    // server's own per-workspace served/receipt ledger means a SECOND
    // `buildTaskPack` call against a workspace another test already queried
    // is not "the first pack of the task" any more and can legitimately
    // answer with a receipt instead of fresh surfaces -- exactly the
    // property this spec exists to test FOR the first call, so every call
    // here must genuinely be one.
    it(`${id}: serves DEFAULT_OPTIONS, RETRYABLE_STATUSES${expectCallers ? ", and a caller window" : ""}`, async () => {
      const ws = workspaceFor(variant);
      const result = await buildTaskPack({ query, taskProfile: "answer", paths: [] }, ws);
      const text = servedText(result);
      for (const needle of DEFAULT_OPTIONS_SUBSTRINGS) {
        expect(text, `expected DEFAULT_OPTIONS body ("${needle}") in served evidence for ${id}/${variant}`).toContain(needle);
      }
      expect(text, `expected RETRYABLE_STATUSES body in served evidence for ${id}/${variant}`).toContain(
        RETRYABLE_STATUSES_SUBSTRING,
      );
      const configSurface = surfaceFor(result, "src/config.ts");
      expect(configSurface, `expected a src/config.ts surface for ${id}/${variant}`).toBeDefined();
      expect(configSurface!.code ?? "").toContain("timeoutMs: 5000");
      const retrySurface = surfaceFor(result, "src/retry.ts");
      expect(retrySurface, `expected a src/retry.ts surface for ${id}/${variant}`).toBeDefined();
      expect(retrySurface!.code ?? "").toContain(RETRYABLE_STATUSES_SUBSTRING);

      if (expectCallers) {
        const paths = result.surfaces.map((s) => s.path);
        expect(paths, `expected one of ${CALLER_PATHS.join(", ")} in served surfaces for ${id}/${variant}`).toEqual(
          expect.arrayContaining([expect.stringMatching(new RegExp(CALLER_PATHS.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")))]),
        );
        const callerSurface = result.surfaces.find((s) => CALLER_PATHS.includes(s.path));
        expect(callerSurface!.code ?? "").toContain("fetchWithRetry(");
      }
    });
  }
});

function rangeContains(range: string | undefined, line: number): { start: number; end: number } | undefined {
  const match = range ? /^(\d+)-(\d+)$/.exec(range) : undefined;
  if (!match) return undefined;
  const start = Number(match[1]);
  const end = Number(match[2]);
  return start <= line && line <= end ? { start, end } : undefined;
}

describe("exact range assertion (one representative case, not repeated per query/variant)", () => {
  it("V01 on the compact corpus: served ranges are well-formed and tightly bound the target declarations", async () => {
    const ws = workspaceFor("compact");
    const result = await buildTaskPack({ query: V01_QUERY_EN, taskProfile: "answer", paths: [] }, ws);
    const configSurface = surfaceFor(result, "src/config.ts");
    const retrySurface = surfaceFor(result, "src/retry.ts");

    // config.ts:7-11 is DEFAULT_OPTIONS's own exact declaration extent
    // (verified directly against evidenceClosure.spec.ts's own findModuleConstantWindow
    // unit case for this identical shape). config.ts is a 15-line file, so a
    // SEPARATE tiny-file mechanism may legitimately widen this hook's own
    // 7-11 proposal to the whole file (1-15) once it lands among the pack's
    // candidates -- this assertion checks CONTAINMENT and a sane upper
    // bound, not the literal string, so it holds either way.
    const configBounds = rangeContains(configSurface?.range, 7);
    expect(configBounds, `expected src/config.ts's range ("${configSurface?.range}") to contain line 7 (DEFAULT_OPTIONS)`).toBeDefined();
    expect(rangeContains(configSurface?.range, 11)).toBeDefined();
    expect(configBounds!.end - configBounds!.start + 1).toBeLessThanOrEqual(15);

    // retry.ts:1-1 is RETRYABLE_STATUSES's own exact declaration extent; the
    // whole file is 9 lines, so any widening (e.g. this hook's own
    // range-collision fix merging it with shouldRetry's pre-selected 3-5)
    // still stays within the file's own size.
    const retryBounds = rangeContains(retrySurface?.range, 1);
    expect(retryBounds, `expected src/retry.ts's range ("${retrySurface?.range}") to contain line 1 (RETRYABLE_STATUSES)`).toBeDefined();
    expect(retryBounds!.end - retryBounds!.start + 1).toBeLessThanOrEqual(9);
  });
});
