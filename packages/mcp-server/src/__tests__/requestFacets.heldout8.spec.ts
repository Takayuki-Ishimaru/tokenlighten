/**
 * requestFacets.heldout8.spec.ts — eighth facet set: the FLOW facet's ORDER OF
 * CALLS phrasing (structure-map entry vocabulary, 2026-10-24). A DEVELOPMENT set.
 *
 * 172 items (entryHeldout1.ts: 16 paraphrases of the generality audit's
 * order-of-calls question + 49 fresh positives + 26 short-answer / order-only /
 * explain-in-full controls + 81 negatives; 104 EN, 68 JA) written BEFORE the
 * rules changed, each labeled by the author (`flow` = the request asks for the
 * order, sequence or flow of calls). Only the flow facet is labeled here; the
 * other three facets are held unchanged by sets #1-#7 (identical precision and
 * recall before and after) and by the shared before/after diff of the two entry
 * detectors over 44,901 request-like strings of the test suites (value, condition
 * and callers: 0 changes). The structure map's other half, the short-answer
 * wording, is scored on the same items by structureMapEntry.heldout1.spec.ts.
 *
 * The audit found the entry shaped by one benchmark request: 1 of 8 EN and 0 of 8
 * JA paraphrases carried a flow this module knew ("in what order", "order of …",
 * "execution order", 順番に/順に/どの順 were the only order phrasings). Scored
 * first against the pre-change extractor, then shaped the rules of
 * requestFacets.ts `isCallOrderClause` / FLOW_JA_RE (every order phrasing
 * anchored to a call or execution verb or noun, never to the bare word "order" /
 * 順番), so this set is NOT blind. The blind check of the same change is
 * requestFacets.heldout9.spec.ts.
 *
 *   FLOW facet              precision  recall   tp  fp  fn  tn
 *   before (pre-change)       0.97      0.35    29   1  54  88
 *   after (final)             0.97      0.90    75   2   8  87
 *     EN (104 items)          1.00->0.98  0.30->0.93   (13/43 -> 40/43)
 *     JA (68 items)           0.94->0.97  0.40->0.88   (16/40 -> 35/40)
 *     the audit's 16          1.00->1.00  0.31->0.88   (5/16 -> 14/16)
 *     the 156 fresh items     0.96->0.97  0.36->0.91
 *
 * Remaining misses, kept as misses (8): a-ja-04 「…がどう呼ばれるか」 (how, not
 * in what order), a-ja-07 「A / B / C の順番は？」 (the bare word 順番),
 * p-en-09 "when do its load and refresh steps get called" (do-support is a call
 * site: callers; and the list is cut at "and"), p-en-21 / p-ja-24 "before or
 * after" / 「前？後？」, p-en-23 "the order in which it posts, reconciles and
 * closes" (no call verb the module knows), p-ja-02 and p-ja-06 (a step named
 * `write` / `extract` opens a clause: the change-request gate reads it as an
 * imperative; not a vocabulary gap). Remaining false positives (2), kept:
 * n-en-24 "keep the call order the same" (a constraint on a change; the flow
 * evidence it asks for is what the refactor needs) and n-ja-19 「登録順に並べる」
 * (the pre-existing bare 順に).
 *
 * Floors are a regression guard just under that result, not a target.
 */
import { describe, expect, it } from "vitest";

import { formatEntryScore, scoreEntryHeldOut } from "./helpers/entryHeldout.js";
import { ENTRY_HELDOUT_1 } from "./helpers/entryHeldout1.js";

/** The flow facet's known misses on this set (see the header): a new one is a regression. */
const KNOWN_FLOW_MISSES: ReadonlySet<string> = new Set([
  "a-ja-04", "a-ja-07", "p-en-09", "p-en-21", "p-en-23", "p-ja-02", "p-ja-06", "p-ja-24",
]);
/** The flow facet's known false positives on this set: a new one is a regression. */
const KNOWN_FLOW_FALSE_POSITIVES: ReadonlySet<string> = new Set(["n-en-24", "n-ja-19"]);

describe("held-out facet set #8 (172 items, flow facet: the order of calls, DEVELOPMENT set, 2026-10-24)", () => {
  it("table shape and id uniqueness", () => {
    expect(ENTRY_HELDOUT_1.length).toBe(172);
    expect(new Set(ENTRY_HELDOUT_1.map((item) => item.id)).size).toBe(172);
    expect(ENTRY_HELDOUT_1.filter((item) => item.map && item.flow).length).toBe(65);
    expect(ENTRY_HELDOUT_1.filter((item) => item.source === "audit").length).toBe(16);
    expect(ENTRY_HELDOUT_1.filter((item) => item.lang === "en").length).toBe(104);
  });

  it("flow precision/recall floors; every miss and false positive is a known one", () => {
    const score = scoreEntryHeldOut(ENTRY_HELDOUT_1);
    // eslint-disable-next-line no-console
    console.log(formatEntryScore("requestFacets held-out #8", score));
    const flowMisses = score.misses.filter((line) => line.startsWith("FLOW-")).map((line) => line.split(" ")[1]!);
    const flowFalsePositives = score.misses.filter((line) => line.startsWith("FLOW+")).map((line) => line.split(" ")[1]!);
    expect(flowMisses.filter((id) => !KNOWN_FLOW_MISSES.has(id)), "a flow miss that is not a known one").toEqual([]);
    expect(flowFalsePositives.filter((id) => !KNOWN_FLOW_FALSE_POSITIVES.has(id)), "a flow false positive that is not a known one").toEqual([]);
    expect(score.flow.recall).toBeGreaterThanOrEqual(0.88);
    expect(score.flow.precision).toBeGreaterThanOrEqual(0.95);
  });

  it("the business noun \"order\" and \"order\" beside a call verb as a modifier never become a flow", () => {
    const orderSense = ENTRY_HELDOUT_1.filter((item) => item.category === "order-sense" || item.category === "order-modifier");
    expect(orderSense.length).toBe(32);
    const score = scoreEntryHeldOut(orderSense);
    // The one pre-existing false positive among them is the bare 順に of n-ja-19.
    expect(score.misses.filter((line) => line.startsWith("FLOW+")).map((line) => line.split(" ")[1])).toEqual(["n-ja-19"]);
  });
});
