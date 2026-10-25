/**
 * structureMapEntry.heldout1.spec.ts — the structure map's ENTRY (short-answer
 * wording AND a flow), scored on held-out set #1 (entryHeldout1.ts, 2026-10-24).
 * A DEVELOPMENT set: its pre-change misses shaped structureMap.ts
 * `asksForStructureMap` and requestFacets.ts `isCallOrderClause` / FLOW_JA_RE;
 * the blind check is structureMapEntry.heldout2.spec.ts.
 *
 * The map is served only to a request that passes BOTH detectors. The generality
 * audit (fable-analysis-r16/generality-audit.md §3.3.3) found 1 of 8 EN and 0 of 8
 * JA paraphrases of the T03 question passing both. 172 items, labeled by the
 * author before they were scored: 65 entry positives (16 are the audit's own
 * paraphrases, 49 are fresh), 8 short-answer controls without a flow, 8
 * order-of-calls controls without a brevity word, 10 explain-in-full requests
 * (a flow whose answer is asked in MORE detail), and 81 negatives (business
 * "order", "order" beside a call verb as a modifier, change requests,
 * "short" / "quick" / "summary" / "overview" / "brief" / "map" / "step" / "flow"
 * / "tldr" in their other senses, ease and "all at once" in JA).
 *
 *                 MAP wording          FLOW facet           ENTRY (both)
 *                 prec  recall         prec  recall         prec  recall
 *   before        0.85  0.55           0.97  0.35           1.00  0.17   (11 of 65)
 *   after         0.99  1.00           0.97  0.90           1.00  0.88   (57 of 65)
 *     the audit's 16     1.00  0.56 -> 1.00        0.31 -> 0.88          1/16 -> 14/16
 *     EN (104 items)     entry recall 0.12 -> 0.91 (4/33 -> 30/33)
 *     JA (68 items)      entry recall 0.22 -> 0.84 (7/32 -> 27/32)
 *
 * The cost of a false match is asymmetric, so the floors are not: a request
 * wrongly judged map-shaped is answered from rows, not whole members (LESS
 * evidence), so the entry must hold ZERO false positives here and the wording
 * must not match any "explain in detail" request. Before the change 8 negatives
 * were map-shaped (the `summary` of "the summary field" / `summary.total`, the
 * `Overview` component / 画面, 概要欄, a 短く that means "shorten", a "summary
 * line" in a change request); after it 1 remains (n-ja-20 「短くまとめて書き直して」,
 * the pre-existing 短く before まとめ). Remaining entry misses (8, all flow-side):
 * the audit's 「…がどう呼ばれるか」 and 「A / B / C の順番は？」, "before or after" /
 * 「前？後？」, a `write` / `extract` step name read as an imperative by the
 * change-request gate, "the order in which it posts, reconciles and closes".
 *
 * Floors are a regression guard just under that result, not a target.
 */
import { describe, expect, it } from "vitest";

import { asksForStructureMap } from "../features/task-pack/structureMap.js";
import { formatEntryScore, scoreEntryHeldOut } from "./helpers/entryHeldout.js";
import { ENTRY_HELDOUT_1 } from "./helpers/entryHeldout1.js";

/** The short-answer wording's known false positive on this set (the pre-existing 短く). */
const KNOWN_MAP_FALSE_POSITIVES: ReadonlySet<string> = new Set(["n-ja-20"]);

describe("structure map entry — held-out set #1 (172 items, DEVELOPMENT set, 2026-10-24)", () => {
  it("scores the short-answer wording and the entry; every map false positive is a known one", () => {
    const score = scoreEntryHeldOut(ENTRY_HELDOUT_1);
    // eslint-disable-next-line no-console
    console.log(formatEntryScore("structure-map entry held-out #1", score));
    const mapFalsePositives = score.misses.filter((line) => line.startsWith("MAP+")).map((line) => line.split(" ")[1]!);
    expect(mapFalsePositives.filter((id) => !KNOWN_MAP_FALSE_POSITIVES.has(id)), "a map false positive that is not a known one").toEqual([]);
    expect(score.map.recall).toBeGreaterThanOrEqual(0.97);
    expect(score.map.precision).toBeGreaterThanOrEqual(0.97);
    expect(score.entry.recall).toBeGreaterThanOrEqual(0.85);
    expect(score.entry.precision).toBe(1);
    expect(score.entryFalsePositives).toEqual([]);
  });

  it("an \"explain in detail\" request is never map-shaped, whatever order of calls it asks for", () => {
    for (const item of ENTRY_HELDOUT_1.filter((entry) => entry.category === "explain-in-full")) {
      expect(asksForStructureMap(item.text), item.text).toBe(false);
    }
  });

  it("the audit's 16 paraphrases: 14 pass both detectors now (1 of 16 before); the 2 left need a bare 順番 or a 'how' and stay out", () => {
    const audit = ENTRY_HELDOUT_1.filter((item) => item.source === "audit");
    const score = scoreEntryHeldOut(audit);
    expect(score.map.recall).toBe(1);
    expect(score.entry.tp).toBe(14);
    expect(score.misses.filter((line) => line.startsWith("FLOW-")).map((line) => line.split(" ")[1]).sort()).toEqual(["a-ja-04", "a-ja-07"]);
  });
});
