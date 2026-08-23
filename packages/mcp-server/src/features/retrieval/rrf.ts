/**
 * retrieval/rrf.ts — V10-08 Hybrid Retrieval v1: reciprocal rank fusion.
 *
 * Standard RRF (Cormack/Clarke/Buettcher 2009): fuses N independently ranked
 * lists into one score per key using ONLY rank position, never the
 * rankers' own score scale. That is exactly what lets an unnormalized BM25F
 * score fuse safely against the existing linear heuristic score and the
 * unscored exact/parser-proven-symbol/reference lists (DESIGN-v0.10-
 * expansion-plan-v1.3.md V10-08: "RRFでscaleの異なるrankerを順位融合する").
 */

/** RRF's own damping constant. 60 is the value from the original paper and the de facto default. */
export const DEFAULT_RRF_K = 60;

/** One ranker's output: an ordered list of candidate keys, best first. */
export type RankedList = readonly string[];

/**
 * V11-02 Task-aware Weighted RRF v2: one ranker's ranked list PLUS the
 * fusion weight multiplier its contributions get scaled by. weight=1 is
 * exactly the implicit per-list weight every reciprocalRankFusion call made
 * before V11-02 (see that function's implementation below, which is this
 * function called with weight 1 for every list — byte-identical output,
 * since multiplying an IEEE754 double by 1 changes no bit). weight=0 fully
 * excludes a list from the fused sum without needing to omit it from the
 * array (features/retrieval/profiles.ts documents where a profile may
 * legitimately want this, e.g. an adversarial/muted retriever).
 */
export interface WeightedRankedList {
  list: RankedList;
  weight: number;
}

/** The general form reciprocalRankFusion below is defined in terms of — see WeightedRankedList's own doc comment for the byte-identity guarantee at weight=1. */
export function weightedReciprocalRankFusion(
  weightedLists: readonly WeightedRankedList[],
  k: number = DEFAULT_RRF_K,
): Map<string, number> {
  const fused = new Map<string, number>();
  for (const { list, weight } of weightedLists) {
    list.forEach((key, index) => {
      const rank = index + 1;
      const contribution = weight / (k + rank);
      fused.set(key, (fused.get(key) ?? 0) + contribution);
    });
  }
  return fused;
}

/**
 * Fuse ranked lists into one score per key: sum of 1/(k + rank) across every
 * list the key appears in (1-based rank within that list), zero contribution
 * from lists the key is absent from. A key's rank WITHIN one list is exactly
 * that list's own order — de-duplicating or re-ranking a single ranker's
 * output is the caller's job, not this function's.
 */
export function reciprocalRankFusion(
  rankedLists: readonly RankedList[],
  k: number = DEFAULT_RRF_K,
): Map<string, number> {
  // Every list at implicit weight 1 — see weightedReciprocalRankFusion's own
  // doc comment for why this is byte-identical to this function's original,
  // pre-V11-02, hand-written loop (multiplying by 1 changes no IEEE754 bit).
  return weightedReciprocalRankFusion(
    rankedLists.map((list) => ({ list, weight: 1 })),
    k,
  );
}

/**
 * Sort keys by fused score descending. Ties keep the input order (stable) —
 * callers pass keys in a meaningful prior order (e.g. the existing heuristic
 * ranking) so a genuine tie degrades to that order rather than an arbitrary
 * one.
 */
export function sortByFusedScore(keys: readonly string[], fused: ReadonlyMap<string, number>): string[] {
  return keys
    .map((key, index) => ({ key, index, score: fused.get(key) ?? 0 }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.key);
}
