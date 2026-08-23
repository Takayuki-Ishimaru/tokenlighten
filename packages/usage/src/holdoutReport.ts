/**
 * holdoutReport.ts — V11-08 Attribution & Calibration v2.
 *
 * A holdout-error/coverage/unmatched-reason report feed: a pure function
 * producing the dashboard-shaped summary the task brief specifies — per
 * (task family × client): coefficient provenance, sample count, relative
 * error, coverage, and an unmatched-reasons histogram — built from
 * coefficientStore.ts's cell data plus sessionMatcher.ts's failure reasons.
 *
 * DETERMINISM (acceptance criterion: "deterministic same-fixture ⇒
 * same-report reproducibility"): this module embeds NO wall-clock read
 * (`Date.now()`/`new Date()`). A "report" is a pure function of its inputs
 * only — a caller that wants a "generated at" timestamp stamps it
 * separately when persisting the report, outside this pure function.
 */

import type {
  CoefficientCell,
  CoefficientClient,
  CoefficientProvenanceKind,
  ConfidenceLevel,
  PairedSample,
  TaskFamily,
} from "./coefficientStore.js";
import { computeCellHoldoutStats, evaluateCellPolicy, lookupCoefficient } from "./coefficientStore.js";
import type { SessionMatchFailureReason } from "./sessionMatcher.js";

export interface UnmatchedAttempt {
  readonly taskFamily: TaskFamily;
  readonly client: CoefficientClient;
  readonly reason: SessionMatchFailureReason;
}

const UNMATCHED_REASONS: readonly SessionMatchFailureReason[] = [
  "missing-log",
  "unmatched-session",
  "unknown-model",
  "low-confidence",
];

export type UnmatchedReasonHistogram = Record<SessionMatchFailureReason, number>;

function emptyHistogram(): UnmatchedReasonHistogram {
  return {
    "missing-log": 0,
    "unmatched-session": 0,
    "unknown-model": 0,
    "low-confidence": 0,
  };
}

export interface FamilyClientReportRow {
  readonly taskFamily: TaskFamily;
  readonly client: CoefficientClient;
  /** "none" when no coefficient cell exists for this (family, client) pair
   *  at all — distinct from a cell existing with low confidence. */
  readonly provenance: CoefficientProvenanceKind | "none";
  readonly confidence: ConfidenceLevel | "unavailable";
  readonly sampleCount: number;
  readonly coverageRate: number;
  readonly relativeError95: number | null;
  readonly unmatchedReasons: UnmatchedReasonHistogram;
}

export interface HoldoutReport {
  /** Sorted by (taskFamily, client) — deterministic regardless of input
   *  order. */
  readonly rows: readonly FamilyClientReportRow[];
  readonly totalUnmatchedReasons: UnmatchedReasonHistogram;
}

function cellKey(taskFamily: TaskFamily, client: CoefficientClient): string {
  return `${taskFamily}\0${client}`;
}

/**
 * Builds the dashboard-shaped holdout report from recorded coefficient
 * cells, paired holdout samples, and unmatched-session attempts. Pure,
 * deterministic, no I/O. `cells`/`samples`/`unmatchedAttempts` are never
 * mutated.
 */
export function buildHoldoutReport(
  cells: readonly CoefficientCell[],
  samples: readonly PairedSample[],
  unmatchedAttempts: readonly UnmatchedAttempt[],
): HoldoutReport {
  const statsByCell = new Map(
    computeCellHoldoutStats(samples).map((s) => [cellKey(s.taskFamily, s.client), s]),
  );
  const histogramByCell = new Map<string, UnmatchedReasonHistogram>();
  const totalUnmatchedReasons = emptyHistogram();
  for (const attempt of unmatchedAttempts) {
    const key = cellKey(attempt.taskFamily, attempt.client);
    const histogram = histogramByCell.get(key) ?? emptyHistogram();
    histogram[attempt.reason]++;
    histogramByCell.set(key, histogram);
    totalUnmatchedReasons[attempt.reason]++;
  }

  const allKeys = new Set<string>([
    ...cells.map((c) => cellKey(c.taskFamily, c.client)),
    ...statsByCell.keys(),
    ...histogramByCell.keys(),
  ]);

  const rows: FamilyClientReportRow[] = [];
  for (const key of allKeys) {
    const [taskFamily, client] = key.split("\0") as [TaskFamily, CoefficientClient];
    const cell = lookupCoefficient(cells, taskFamily, client);
    const stats = statsByCell.get(key) ?? null;
    const unmatchedReasons = histogramByCell.get(key) ?? emptyHistogram();
    const confidence: ConfidenceLevel | "unavailable" =
      cell && stats ? evaluateCellPolicy(stats, cell.provenance) : "unavailable";
    rows.push({
      taskFamily,
      client,
      provenance: cell?.provenance ?? "none",
      confidence,
      sampleCount: stats?.sampleCount ?? 0,
      coverageRate: stats?.coverageRate ?? 0,
      relativeError95: stats?.relativeError95 ?? null,
      unmatchedReasons,
    });
  }

  rows.sort((a, b) =>
    a.taskFamily === b.taskFamily
      ? a.client.localeCompare(b.client)
      : a.taskFamily.localeCompare(b.taskFamily));

  return { rows, totalUnmatchedReasons };
}

/** Convenience: verifies every one of the four canonical unmatched reasons
 *  (missing-log / unmatched-session / unknown-model / low-confidence) is a
 *  valid histogram key — used by holdoutReport.spec.ts to assert the report
 *  never silently drops a reason kind. Exported so a consumer building its
 *  own histogram can validate against the same canonical list. */
export function unmatchedReasonKinds(): readonly SessionMatchFailureReason[] {
  return UNMATCHED_REASONS;
}
