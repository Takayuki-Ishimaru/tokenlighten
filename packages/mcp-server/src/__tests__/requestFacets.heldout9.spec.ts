/**
 * requestFacets.heldout9.spec.ts — ninth facet set: the BLIND check of the FLOW
 * facet's ORDER OF CALLS phrasing (structure-map entry vocabulary, 2026-10-24).
 *
 * 107 items (entryHeldout2.ts; 58 EN, 49 JA; 37 entry positives, 6 short-answer
 * and 6 order-of-calls controls, 8 explain-in-full requests, 50 negatives) written
 * AFTER the rules of requestFacets.ts `isCallOrderClause` / FLOW_JA_RE were final,
 * in a different voice and domain mix from the development set
 * (requestFacets.heldout8.spec.ts), and scored ONCE. Only the flow facet is
 * labeled here; the short-answer wording and the entry are scored on the same
 * items by structureMapEntry.heldout2.spec.ts.
 *
 * BLIND RESULT, as scored (flow facet, 51 positives of 107):
 *   before (pre-change)   precision 0.78  recall 0.27   (tp 14 fp 4 fn 37)
 *   after  (final rules)  precision 0.90  recall 0.84   (tp 43 fp 5 fn  8)
 * One miss was a gap that the blind set exposed and that was fixed afterwards:
 * "the EXACT order it calls …" — one adjective between "the" and "order"
 * (exact / precise / actual / right / usual / default / typical / full …). With
 * that single change the set stops being blind for it: recall 0.86 (tp 44 fn 7),
 * precision unchanged. Set #2b (29 items written after that change, 18 flow
 * positives) is its blind check: precision 1.00, recall 1.00 (before: 0.17).
 *
 * Remaining misses, kept as misses (7; every one was written beyond the
 * vocabulary on purpose): b-en-09 "which stage it calls first" (an ACTIVE verb
 * with no do-support: "which function calls X first" asks for a caller),
 * b-en-15 "which does it check first" (no call verb), h-en-01 "end to end … in
 * that sequence", h-en-03 "the sequence in which it checks …", h-en-04 "the
 * phases and their order", b-ja-13 「どっちが先？」, h-ja-01 「どのあたりで入る？」
 * (the bare word, with no call or execution verb, is not a flow). Remaining
 * false positives (5): four are PRE-EXISTING rules (n-en-02 "order of
 * magnitude" and n-en-04 "in what order do they appear" — bare "order of" / "in
 * what order"; n-ja-02 「注文日順に」 — bare 順に; n-ja-06 「実行順位」 — 実行順 before
 * 位), one is the new 処理の順番 of "I want to swap it" (c-ja-03: the
 * change-request gate has no 入れ替えたい).
 *
 * Floors are a regression guard just under the post-fix result, not a target.
 */
import { describe, expect, it } from "vitest";

import { formatEntryScore, scoreEntryHeldOut } from "./helpers/entryHeldout.js";
import { ENTRY_HELDOUT_2, ENTRY_HELDOUT_2B } from "./helpers/entryHeldout2.js";

const KNOWN_FLOW_MISSES: ReadonlySet<string> = new Set(["b-en-09", "b-en-15", "h-en-01", "h-en-03", "h-en-04", "b-ja-13", "h-ja-01"]);
const KNOWN_FLOW_FALSE_POSITIVES: ReadonlySet<string> = new Set(["n-en-02", "n-en-04", "n-ja-02", "n-ja-06", "c-ja-03"]);

describe("held-out facet set #9 (107 items, flow facet: the order of calls, BLIND, 2026-10-24)", () => {
  it("table shape and id uniqueness", () => {
    expect(ENTRY_HELDOUT_2.length).toBe(107);
    expect(new Set(ENTRY_HELDOUT_2.map((item) => item.id)).size).toBe(107);
    expect(ENTRY_HELDOUT_2.filter((item) => item.map && item.flow).length).toBe(37);
    expect(ENTRY_HELDOUT_2.filter((item) => item.lang === "en").length).toBe(58);
  });

  it("flow precision/recall floors; every miss and false positive is a known one", () => {
    const score = scoreEntryHeldOut(ENTRY_HELDOUT_2);
    // eslint-disable-next-line no-console
    console.log(formatEntryScore("requestFacets held-out #9", score));
    const flowMisses = score.misses.filter((line) => line.startsWith("FLOW-")).map((line) => line.split(" ")[1]!);
    const flowFalsePositives = score.misses.filter((line) => line.startsWith("FLOW+")).map((line) => line.split(" ")[1]!);
    expect(flowMisses.filter((id) => !KNOWN_FLOW_MISSES.has(id)), "a flow miss that is not a known one").toEqual([]);
    expect(flowFalsePositives.filter((id) => !KNOWN_FLOW_FALSE_POSITIVES.has(id)), "a flow false positive that is not a known one").toEqual([]);
    expect(score.flow.recall).toBeGreaterThanOrEqual(0.82);
    expect(score.flow.precision).toBeGreaterThanOrEqual(0.85);
  });

  it("set #2b (29 items written after the 'exact order' fix): every flow item is found, none is invented", () => {
    expect(ENTRY_HELDOUT_2B.length).toBe(29);
    const score = scoreEntryHeldOut(ENTRY_HELDOUT_2B);
    // eslint-disable-next-line no-console
    console.log(formatEntryScore("requestFacets held-out #9b", score));
    expect(score.flow.recall).toBeGreaterThanOrEqual(0.95);
    expect(score.flow.precision).toBeGreaterThanOrEqual(0.95);
  });
});
