/**
 * qualityGate.ts — V11-02 Task-aware Weighted RRF v2: weak-retriever quality
 * gate.
 *
 * DESIGN-v0.10-expansion-plan-v1.3.md V11-02: "weak retrieverはquality
 * gateを通過した場合だけfusionへ参加する。" Applies ONLY to index.ts's two
 * non-floor rankers (the pre-existing "current heuristic" pool and, when
 * TL_BM25F_CANDIDATE is also on, BM25F) — the three hard-floor rankers
 * (exact/symbol/reference) always participate in fusion regardless of this
 * gate, matching V11-02's own unconditional-floor requirement.
 *
 * Deterministic and score-only: no I/O, no model call. A gated-out
 * retriever's ranked list is excluded from THIS CALL's weighted RRF sum —
 * its candidates are NOT removed from the pool (index.ts still adds every
 * BM25F-sourced candidate regardless of gate outcome, unchanged from
 * pre-V11-02; a gated-out list simply stops contributing rank-based fusion
 * score, so its members settle wherever their OTHER signals, if any, plus
 * the hard floor place them).
 */

export type QualityGateReason = "empty" | "degenerate-scores" | "insufficient-margin";

export interface QualityGateResult {
  passed: boolean;
  reason?: QualityGateReason;
}

/** A list whose score spread (top - bottom) is under this fraction of its own top score reads as flat/undiscriminating. */
const MIN_TOP_MARGIN_RATIO = 0.05;

/**
 * `scores` must already be sorted descending — the shape every ranked list
 * in this package is produced in (Bm25fIndex.score() and the pre-existing
 * heuristic candidate sort both guarantee this).
 */
export function evaluateRetrieverQuality(scores: readonly number[]): QualityGateResult {
  if (scores.length === 0) return { passed: false, reason: "empty" };
  const top = scores[0]!;
  if (!(top > 0)) return { passed: false, reason: "degenerate-scores" };
  if (scores.length === 1) return { passed: true };
  const bottom = scores[scores.length - 1]!;
  const distinctCount = new Set(scores).size;
  if (distinctCount <= 1) return { passed: false, reason: "degenerate-scores" };
  if (top - bottom < top * MIN_TOP_MARGIN_RATIO) return { passed: false, reason: "insufficient-margin" };
  return { passed: true };
}
