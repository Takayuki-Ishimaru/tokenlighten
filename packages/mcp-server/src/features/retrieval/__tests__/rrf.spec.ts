/**
 * rrf.spec.ts — V10-08 Hybrid Retrieval v1: reciprocal rank fusion math.
 */

import { describe, it, expect } from "vitest";
import { reciprocalRankFusion, weightedReciprocalRankFusion, sortByFusedScore, DEFAULT_RRF_K, type RankedList } from "../rrf.js";

describe("reciprocalRankFusion — exact formula", () => {
  it("scores a single list's items as exactly 1/(k+rank), 1-based rank", () => {
    const fused = reciprocalRankFusion([["a", "b", "c"]], 10);
    expect(fused.get("a")).toBeCloseTo(1 / 11, 12);
    expect(fused.get("b")).toBeCloseTo(1 / 12, 12);
    expect(fused.get("c")).toBeCloseTo(1 / 13, 12);
  });

  it("uses DEFAULT_RRF_K (60) when k is omitted", () => {
    const fused = reciprocalRankFusion([["a"]]);
    expect(fused.get("a")).toBeCloseTo(1 / (DEFAULT_RRF_K + 1), 12);
  });

  it("sums contributions across lists for a key present in more than one", () => {
    // "x" is rank 1 in list1 (contributes 1/(60+1)) and rank 3 in list2 (contributes 1/(60+3)).
    const fused = reciprocalRankFusion([
      ["x", "a", "b"],
      ["c", "d", "x"],
    ]);
    const expected = 1 / (DEFAULT_RRF_K + 1) + 1 / (DEFAULT_RRF_K + 3);
    expect(fused.get("x")).toBeCloseTo(expected, 12);
  });

  it("a key absent from a list contributes zero from it — consensus across MORE lists can outrank a single list's rank-1", () => {
    // "consensus": rank 2 in three different lists.
    const fused = reciprocalRankFusion([
      ["other1", "consensus"],
      ["other2", "consensus"],
      ["other3", "consensus"],
    ]);
    // "lonely": rank 1 in exactly one list, absent from the other two.
    const fusedLonely = reciprocalRankFusion([["lonely", "other1"]]);
    const consensusScore = fused.get("consensus")!;
    const lonelyScore = fusedLonely.get("lonely")!;
    // 3 * 1/62 (~0.04839) > 1/61 (~0.01639).
    expect(consensusScore).toBeGreaterThan(lonelyScore);
  });

  it("an empty list of rankers fuses to an empty map", () => {
    expect(reciprocalRankFusion([]).size).toBe(0);
  });

  it("a key that appears twice in the SAME list contributes once per occurrence (rank is positional, not deduped by the fusion function)", () => {
    const fused = reciprocalRankFusion([["a", "a"]]);
    const expected = 1 / (DEFAULT_RRF_K + 1) + 1 / (DEFAULT_RRF_K + 2);
    expect(fused.get("a")).toBeCloseTo(expected, 12);
  });
});

describe("sortByFusedScore", () => {
  it("orders keys by fused score descending", () => {
    const fused = new Map([["low", 0.01], ["high", 0.5], ["mid", 0.2]]);
    expect(sortByFusedScore(["low", "high", "mid"], fused)).toEqual(["high", "mid", "low"]);
  });

  it("treats a missing key as score 0", () => {
    const fused = new Map([["present", 0.5]]);
    expect(sortByFusedScore(["absent", "present"], fused)).toEqual(["present", "absent"]);
  });

  it("breaks ties by preserving the input order", () => {
    const fused = new Map([["a", 0.3], ["b", 0.3], ["c", 0.3]]);
    expect(sortByFusedScore(["a", "b", "c"], fused)).toEqual(["a", "b", "c"]);
    expect(sortByFusedScore(["c", "b", "a"], fused)).toEqual(["c", "b", "a"]);
  });
});

describe("weightedReciprocalRankFusion — byte-identity with reciprocalRankFusion at weight 1 (V11-02)", () => {
  it("weight 1 for every list reproduces reciprocalRankFusion's output exactly, for a variety of shapes", () => {
    const shapes: RankedList[][] = [
      [["a", "b", "c"]],
      [["x", "a", "b"], ["c", "d", "x"]],
      [["other1", "consensus"], ["other2", "consensus"], ["other3", "consensus"]],
      [],
      [["a", "a"]],
    ];
    for (const lists of shapes) {
      const legacy = reciprocalRankFusion(lists);
      const weighted = weightedReciprocalRankFusion(lists.map((list) => ({ list, weight: 1 })));
      expect(weighted).toEqual(legacy);
      for (const [key, value] of legacy) {
        expect(weighted.get(key)).toBe(value);
      }
    }
  });

  it("reciprocalRankFusion is now defined IN TERMS OF weightedReciprocalRankFusion — k behavior is unchanged", () => {
    const fused = reciprocalRankFusion([["a", "b", "c"]], 10);
    expect(fused.get("a")).toBeCloseTo(1 / 11, 12);
    expect(fused.get("b")).toBeCloseTo(1 / 12, 12);
    expect(fused.get("c")).toBeCloseTo(1 / 13, 12);
  });
});

describe("weightedReciprocalRankFusion — weight actually discriminates (V11-02)", () => {
  it("weight 0 fully excludes a list's contribution", () => {
    const fused = weightedReciprocalRankFusion([
      { list: ["a", "b"], weight: 0 },
      { list: ["b", "a"], weight: 1 },
    ]);
    expect(fused.get("a")).toBeCloseTo(1 / (DEFAULT_RRF_K + 2), 12);
    expect(fused.get("b")).toBeCloseTo(1 / (DEFAULT_RRF_K + 1), 12);
  });

  it("weight 2 doubles a list's contribution relative to weight 1", () => {
    const single = weightedReciprocalRankFusion([{ list: ["a"], weight: 1 }]);
    const doubled = weightedReciprocalRankFusion([{ list: ["a"], weight: 2 }]);
    expect(doubled.get("a")).toBeCloseTo(single.get("a")! * 2, 12);
  });

  it("weighted contributions from several lists sum correctly", () => {
    const fused = weightedReciprocalRankFusion([
      { list: ["x"], weight: 2 },
      { list: ["x"], weight: 3 },
    ]);
    const expected = (2 + 3) / (DEFAULT_RRF_K + 1);
    expect(fused.get("x")).toBeCloseTo(expected, 12);
  });

  it("dropping a list entirely (e.g. a gated-out retriever) is equivalent to it never having existed", () => {
    const withList = weightedReciprocalRankFusion([{ list: ["a", "b"], weight: 1 }]);
    const withoutList = weightedReciprocalRankFusion([]);
    expect(withoutList.size).toBe(0);
    expect(withList.get("a")).toBeGreaterThan(0);
  });

  it("an empty weighted-lists array fuses to an empty map", () => {
    expect(weightedReciprocalRankFusion([]).size).toBe(0);
  });
});
