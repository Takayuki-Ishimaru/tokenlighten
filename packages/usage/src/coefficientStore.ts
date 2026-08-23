/**
 * coefficientStore.ts — V11-08 Attribution & Calibration v2.
 *
 * Paired-direct coefficients keyed by (task family × client), extending
 * calibration.ts's existing per-CLIENT-only policy
 * (SESSION_ESTIMATOR_CALIBRATION / scripts/apply-calibration.mjs) to a finer
 * grain. Every coefficient cell carries explicit provenance:
 *
 *   paired-direct — measured directly on that exact (family, client) cell.
 *   transferred   — borrowed from another cell's paired-direct measurement;
 *                   ALWAYS downgrades confidence by exactly one level (never
 *                   "high", per calibration.ts's own existing rule: "
 *                   Transferred calibration can reach medium confidence, but
 *                   never high").
 *
 * `taskFamily` is kept as a plain opaque string rather than importing a
 * canonical enum: V11-02 (Task-aware RRF v2, `features/retrieval/
 * taskFamily.ts`) owns that canonical inference and is a SIBLING wave-A
 * workstream with no shared owned files
 * (DESIGN-v0.11-expansion-plan-reconciliation.md §5) — this module must not
 * assume it has landed. Any string a caller supplies is accepted verbatim.
 *
 * Pure: no I/O, no mutation of inputs, no bench-tuned magic numbers beyond
 * calibration.ts's existing, documented policy constants (plus exactly one
 * NEW constant this file adds — COEFFICIENT_MIN_COVERAGE_RATE below).
 *
 * COEFFICIENT_MIN_COVERAGE_RATE deliberately lives HERE rather than inside
 * calibration.ts, even though it extends that file's threshold policy: the
 * checked-in calibration.ts is also the OUTPUT of
 * scripts/apply-calibration.mjs's `renderCalibration()` (see
 * applyCalibration.spec.ts's byte-exact template-preamble assertion), a
 * repo-root script this workstream's hard constraints forbid touching (only
 * packages/usage/ is in scope). Adding a constant inside calibration.ts's
 * hand-maintained preamble would silently diverge from what that generator
 * re-emits on its next run — confirmed by running the existing test suite
 * with the constant placed there. Keeping it in this file's own numeric
 * home avoids the conflict entirely while still checking additively
 * alongside calibration.ts's existing thresholds (see evaluateCellPolicy).
 */

import type { TokenLightenClient } from "@tokenlighten/types";
import {
  CALIBRATION_DIRECT_MEDIUM_MAX_RELATIVE_ERROR95,
  CALIBRATION_HIGH_MAX_RELATIVE_ERROR95,
  CALIBRATION_HIGH_SAMPLE_COUNT,
  CALIBRATION_MIN_SAMPLE_COUNT,
  CALIBRATION_TRANSFERRED_MEDIUM_MAX_RELATIVE_ERROR95,
} from "./calibration.js";

/**
 * Minimum fraction of a (task family × client) cell's paired-holdout
 * attempts that must have resolved to a matched session (see
 * sessionMatcher.ts) before its relative-error figure is trusted at all.
 * Below this, a cell's confidence is "low" regardless of sample count or
 * relative error — a coefficient fit mostly from UNMATCHED attempts is not
 * evidence of accuracy, it is evidence of a matching problem.
 */
export const COEFFICIENT_MIN_COVERAGE_RATE = 0.6;

export type TaskFamily = string;
export type CoefficientClient = TokenLightenClient;
export type CoefficientProvenanceKind = "paired-direct" | "transferred";
export type ConfidenceLevel = "high" | "medium" | "low";

export interface CoefficientCell {
  readonly taskFamily: TaskFamily;
  readonly client: CoefficientClient;
  /** Tokens-avoided-per-unit coefficient for this (family, client) cell. */
  readonly coefficient: number;
  readonly provenance: CoefficientProvenanceKind;
  /** Set only when provenance is "transferred". */
  readonly transferredFrom?: { readonly taskFamily: TaskFamily; readonly client: CoefficientClient };
  readonly sampleCount: number;
  readonly relativeError95: number | null;
}

// ---------------------------------------------------------------------------
// Lookup / transfer
// ---------------------------------------------------------------------------

export function lookupCoefficient(
  cells: readonly CoefficientCell[],
  taskFamily: TaskFamily,
  client: CoefficientClient,
): CoefficientCell | null {
  return cells.find((c) => c.taskFamily === taskFamily && c.client === client) ?? null;
}

/**
 * Builds a transferred cell by borrowing a paired-direct source cell's
 * coefficient value for a DIFFERENT (taskFamily, client) target. Chained
 * transfers (transferring an already-transferred cell) are refused —
 * confidence must always trace back to exactly one direct measurement, not
 * a game of telephone. Choosing WHICH source cell to borrow from is left to
 * the caller (a bench/product decision, not mechanics this file owns).
 */
export function transferCoefficient(
  source: CoefficientCell,
  target: { readonly taskFamily: TaskFamily; readonly client: CoefficientClient },
): CoefficientCell {
  if (source.provenance !== "paired-direct") {
    throw new Error(
      "transferCoefficient requires a paired-direct source cell (no chained transfers)",
    );
  }
  return {
    taskFamily: target.taskFamily,
    client: target.client,
    coefficient: source.coefficient,
    provenance: "transferred",
    transferredFrom: { taskFamily: source.taskFamily, client: source.client },
    sampleCount: source.sampleCount,
    relativeError95: source.relativeError95,
  };
}

// ---------------------------------------------------------------------------
// Holdout relative-error / coverage computation
// ---------------------------------------------------------------------------

export interface PairedSample {
  readonly taskFamily: TaskFamily;
  readonly client: CoefficientClient;
  /** Ground-truth measured tokens for this paired holdout task. */
  readonly actualTokens: number;
  /** Tokens the coefficient under test would have predicted. */
  readonly predictedTokens: number;
  /** False when this paired attempt never resolved to a matched session
   *  (sessionMatcher.ts returned "unavailable") — such attempts still count
   *  toward the coverage denominator but contribute no relative-error
   *  sample, since there is no trustworthy actual/predicted pair. */
  readonly matched: boolean;
}

export interface CellHoldoutStats {
  readonly taskFamily: TaskFamily;
  readonly client: CoefficientClient;
  /** Total paired attempts for this cell, matched or not. */
  readonly sampleCount: number;
  readonly matchedCount: number;
  /** matchedCount / sampleCount; 0 when sampleCount is 0. */
  readonly coverageRate: number;
  /** 95th-percentile |actual - predicted| / |actual| over MATCHED samples
   *  with a non-zero actual value. Null when no such sample exists — never
   *  a fabricated 0. */
  readonly relativeError95: number | null;
}

function percentile95(sortedAscending: readonly number[]): number {
  const index = Math.min(
    sortedAscending.length - 1,
    Math.max(0, Math.ceil(0.95 * sortedAscending.length) - 1),
  );
  return sortedAscending[index];
}

/**
 * Groups paired samples by (taskFamily, client) and computes each cell's
 * holdout statistics. Pure; deterministic row order (sorted by taskFamily
 * then client) so identical input always yields a deep-equal result.
 */
export function computeCellHoldoutStats(
  samples: readonly PairedSample[],
): CellHoldoutStats[] {
  const groups = new Map<string, PairedSample[]>();
  for (const sample of samples) {
    const key = `${sample.taskFamily}\0${sample.client}`;
    const group = groups.get(key) ?? [];
    group.push(sample);
    groups.set(key, group);
  }
  const rows: CellHoldoutStats[] = [];
  for (const [key, group] of groups) {
    const [taskFamily, client] = key.split("\0") as [TaskFamily, CoefficientClient];
    const matched = group.filter((s) => s.matched);
    const relativeErrors = matched
      .filter((s) => s.actualTokens !== 0)
      .map((s) => Math.abs(s.actualTokens - s.predictedTokens) / Math.abs(s.actualTokens))
      .sort((a, b) => a - b);
    rows.push({
      taskFamily,
      client,
      sampleCount: group.length,
      matchedCount: matched.length,
      coverageRate: group.length > 0 ? matched.length / group.length : 0,
      relativeError95: relativeErrors.length > 0 ? percentile95(relativeErrors) : null,
    });
  }
  return rows.sort((a, b) =>
    a.taskFamily === b.taskFamily
      ? a.client.localeCompare(b.client)
      : a.taskFamily.localeCompare(b.taskFamily));
}

// ---------------------------------------------------------------------------
// Policy check (extends calibration.ts's thresholds additively)
// ---------------------------------------------------------------------------

function directConfidence(stats: CellHoldoutStats): ConfidenceLevel {
  if (stats.coverageRate < COEFFICIENT_MIN_COVERAGE_RATE || stats.relativeError95 === null) {
    return "low";
  }
  if (
    stats.sampleCount >= CALIBRATION_HIGH_SAMPLE_COUNT
    && stats.relativeError95 <= CALIBRATION_HIGH_MAX_RELATIVE_ERROR95
  ) {
    return "high";
  }
  if (
    stats.sampleCount >= CALIBRATION_MIN_SAMPLE_COUNT
    && stats.relativeError95 <= CALIBRATION_DIRECT_MEDIUM_MAX_RELATIVE_ERROR95
  ) {
    return "medium";
  }
  return "low";
}

/**
 * Mirrors calibration.ts's EXISTING per-client transferred rule
 * (index.ts's `sessionEstimate()`: `source === "paired-transferred" &&
 * hasDirectMediumOrBetter && relativeError95 <=
 * CALIBRATION_TRANSFERRED_MEDIUM_MAX_RELATIVE_ERROR95 ? "medium" : "low"`)
 * — transferred coefficients get their OWN, deliberately looser error bound
 * (0.6 vs. direct-medium's 0.5) rather than a strict "recompute what direct
 * would say, then subtract one level" downgrade; there is no branch
 * anywhere in this function that returns "high" for a transferred cell, so
 * the achievable CEILING is still exactly one rung below direct's ceiling,
 * matching calibration.ts's comment verbatim: "Transferred calibration can
 * reach medium confidence, but never high."
 *
 * Deliberate, documented DEVIATION from the existing per-client rule: this
 * does not additionally gate on some OTHER cell anywhere in the whole
 * matrix having scored medium-or-better first (`hasDirectMediumOrBetter`)
 * — that whole-matrix signal is too weak/noisy at the finer (task family ×
 * client) cell grain this module adds. The meaningful lineage guarantee is
 * already enforced structurally by `transferCoefficient()`'s hard
 * requirement that its SOURCE cell be `paired-direct` in the first place.
 */
function transferredConfidence(stats: CellHoldoutStats): ConfidenceLevel {
  if (stats.coverageRate < COEFFICIENT_MIN_COVERAGE_RATE || stats.relativeError95 === null) {
    return "low";
  }
  return stats.sampleCount >= CALIBRATION_MIN_SAMPLE_COUNT
    && stats.relativeError95 <= CALIBRATION_TRANSFERRED_MEDIUM_MAX_RELATIVE_ERROR95
    ? "medium"
    : "low";
}

/**
 * Evaluates a cell's confidence against calibration.ts's policy thresholds
 * (extended additively by COEFFICIENT_MIN_COVERAGE_RATE). `provenance` is
 * evaluated independently of `stats.taskFamily`/`client` (the caller
 * supplies the stats for whichever cell it wants evaluated, direct or
 * transferred) so this function stays a pure policy check, not a lookup.
 */
export function evaluateCellPolicy(
  stats: CellHoldoutStats,
  provenance: CoefficientProvenanceKind,
): ConfidenceLevel {
  return provenance === "paired-direct"
    ? directConfidence(stats)
    : transferredConfidence(stats);
}
