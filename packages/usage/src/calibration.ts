import type { TokenLightenClient } from "@tokenlighten/types";

/** Expected fraction of a session's turns that follow a given TL call. */
export const RESIDUAL_TURN_SHARE = 0.5;

/** Minimum paired sample count required for direct calibration. */
export const CALIBRATION_MIN_SAMPLE_COUNT = 12;
/** Direct calibration threshold for high confidence. */
export const CALIBRATION_HIGH_SAMPLE_COUNT = 24;
export const CALIBRATION_HIGH_MAX_RELATIVE_ERROR95 = 0.25;
/** Direct calibration threshold for medium confidence. */
export const CALIBRATION_DIRECT_MEDIUM_MAX_RELATIVE_ERROR95 = 0.5;
/** Transferred calibration can reach medium confidence, but never high. */
export const CALIBRATION_TRANSFERRED_MEDIUM_MAX_RELATIVE_ERROR95 = 0.6;
/** Ignore clients below this share when choosing scope confidence/intervals. */
export const CALIBRATION_MATERIALITY = 0.1;

export type SessionEstimatorCalibrationClientSource =
  | "paired-direct"
  | "paired-transferred"
  | "analytic-fallback";

export interface SessionEstimatorCalibration {
  readonly schemaVersion: 1;
  readonly version: string;
  readonly calibratedAt: string | null;
  readonly source: "analytic-fallback" | "paired-derived";
  readonly rawPairedBillingIncluded: false;
  readonly sampleCount: number;
  readonly relativeError95: number | null;
  readonly tokenDeltaMultiplierByClient: Readonly<Record<TokenLightenClient, number>>;
  readonly sourceByClient: Readonly<
    Record<TokenLightenClient, SessionEstimatorCalibrationClientSource>
  >;
  readonly sampleCountByClient: Readonly<Record<TokenLightenClient, number>>;
  readonly relativeError95ByClient: Readonly<
    Record<TokenLightenClient, number | null>
  >;
}

/**
 * Release-safe calibration artifact.
 *
 * Raw paired billing, transcripts, task names, paths, and source text are never
 * shipped. A release build may replace this object with aggregated coefficients
 * produced by the private calibration pipeline. This multiplier applies on top
 * of the residual-turns analytic model; a future paired-derived calibration can
 * fold its measured correction into these values without exposing raw billing.
 */
export const SESSION_ESTIMATOR_CALIBRATION: SessionEstimatorCalibration = {
  schemaVersion: 1,
  version: "analytic-v1",
  calibratedAt: null,
  source: "analytic-fallback",
  rawPairedBillingIncluded: false,
  sampleCount: 0,
  relativeError95: null,
  tokenDeltaMultiplierByClient: {
    vscode: 1,
    codex: 1,
    "claude-code": 1,
    desktop: 1,
    other: 1,
  },
  sourceByClient: {
    vscode: "analytic-fallback",
    codex: "analytic-fallback",
    "claude-code": "analytic-fallback",
    desktop: "analytic-fallback",
    other: "analytic-fallback",
  },
  sampleCountByClient: {
    vscode: 0,
    codex: 0,
    "claude-code": 0,
    desktop: 0,
    other: 0,
  },
  relativeError95ByClient: {
    vscode: null,
    codex: null,
    "claude-code": null,
    desktop: null,
    other: null,
  },
};
