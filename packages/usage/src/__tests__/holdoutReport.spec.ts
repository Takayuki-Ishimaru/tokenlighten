import { describe, expect, it } from "vitest";
import type { CoefficientCell, PairedSample } from "../coefficientStore.js";
import {
  CALIBRATION_HIGH_SAMPLE_COUNT,
  CALIBRATION_MIN_SAMPLE_COUNT,
} from "../calibration.js";
import { buildHoldoutReport, unmatchedReasonKinds, type UnmatchedAttempt } from "../holdoutReport.js";

describe("unmatchedReasonKinds", () => {
  it("lists exactly the four canonical reasons the task brief specifies", () => {
    expect([...unmatchedReasonKinds()].sort()).toEqual([
      "low-confidence",
      "missing-log",
      "unknown-model",
      "unmatched-session",
    ]);
  });
});

describe("buildHoldoutReport", () => {
  const cells: CoefficientCell[] = [
    {
      taskFamily: "known-local",
      client: "claude-code",
      coefficient: 10,
      provenance: "paired-direct",
      sampleCount: CALIBRATION_HIGH_SAMPLE_COUNT,
      relativeError95: 0.05,
    },
    {
      taskFamily: "navigation",
      client: "codex",
      coefficient: 5,
      provenance: "transferred",
      transferredFrom: { taskFamily: "known-local", client: "claude-code" },
      sampleCount: CALIBRATION_MIN_SAMPLE_COUNT,
      relativeError95: 0.55,
    },
  ];

  // Confidence is computed by buildHoldoutReport from computeCellHoldoutStats
  // over THESE samples (not from the cells' own stored sampleCount/
  // relativeError95 fields) -- so each cell needs enough matched, low-error
  // samples here to actually clear the band it is meant to demonstrate.
  // actual=100 in every sample keeps the relative-error arithmetic simple:
  // relativeError = |100 - predicted| / 100.
  const knownLocalSamples: PairedSample[] = Array.from(
    { length: CALIBRATION_HIGH_SAMPLE_COUNT },
    () => ({ taskFamily: "known-local", client: "claude-code", actualTokens: 100, predictedTokens: 105, matched: true }),
  ); // relative error 0.05 on every sample -- clears the HIGH bound (0.25).
  const navigationSamples: PairedSample[] = Array.from(
    { length: CALIBRATION_MIN_SAMPLE_COUNT },
    () => ({ taskFamily: "navigation", client: "codex", actualTokens: 100, predictedTokens: 155, matched: true }),
  ); // relative error 0.55 -- clears the LOOSER transferred bound (0.6) but
  // NOT the direct-medium bound (0.5), demonstrating transferred's own
  // (looser) acceptance rule rather than a plain "direct minus one" downgrade.
  const samples: PairedSample[] = [...knownLocalSamples, ...navigationSamples];

  const unmatchedAttempts: UnmatchedAttempt[] = [
    { taskFamily: "known-local", client: "claude-code", reason: "unmatched-session" },
    { taskFamily: "cross-package", client: "vscode", reason: "missing-log" },
    { taskFamily: "cross-package", client: "vscode", reason: "missing-log" },
    { taskFamily: "known-local", client: "claude-code", reason: "low-confidence" },
  ];

  it("produces one row per (taskFamily, client) appearing in cells, samples, or unmatched attempts", () => {
    const report = buildHoldoutReport(cells, samples, unmatchedAttempts);
    const keys = report.rows.map((r) => `${r.taskFamily}/${r.client}`);
    expect(keys).toEqual([
      "cross-package/vscode",
      "known-local/claude-code",
      "navigation/codex",
    ]);
  });

  it("carries coefficient provenance and confidence per row, 'none'/'unavailable' when no cell exists", () => {
    const report = buildHoldoutReport(cells, samples, unmatchedAttempts);
    const crossPackage = report.rows.find((r) => r.taskFamily === "cross-package")!;
    expect(crossPackage.provenance).toBe("none");
    expect(crossPackage.confidence).toBe("unavailable");

    const knownLocal = report.rows.find((r) => r.taskFamily === "known-local")!;
    expect(knownLocal.provenance).toBe("paired-direct");
    expect(knownLocal.confidence).toBe("high");

    const navigation = report.rows.find((r) => r.taskFamily === "navigation")!;
    expect(navigation.provenance).toBe("transferred");
    // Transferred NEVER reaches "high" even with abundant, low-error
    // samples -- see coefficientStore.spec.ts's dedicated coverage of this.
    expect(navigation.confidence).toBe("medium");
  });

  it("carries sample count / coverage / relative error from the holdout samples", () => {
    const report = buildHoldoutReport(cells, samples, unmatchedAttempts);
    const knownLocal = report.rows.find((r) => r.taskFamily === "known-local")!;
    expect(knownLocal.sampleCount).toBe(CALIBRATION_HIGH_SAMPLE_COUNT);
    expect(knownLocal.coverageRate).toBe(1);
    expect(knownLocal.relativeError95).toBeCloseTo(0.05, 10);

    const navigation = report.rows.find((r) => r.taskFamily === "navigation")!;
    expect(navigation.sampleCount).toBe(CALIBRATION_MIN_SAMPLE_COUNT);
    expect(navigation.relativeError95).toBeCloseTo(0.55, 10);
  });

  it("builds a per-cell AND a total unmatched-reasons histogram", () => {
    const report = buildHoldoutReport(cells, samples, unmatchedAttempts);
    const knownLocal = report.rows.find((r) => r.taskFamily === "known-local")!;
    expect(knownLocal.unmatchedReasons).toEqual({
      "missing-log": 0,
      "unmatched-session": 1,
      "unknown-model": 0,
      "low-confidence": 1,
    });
    const crossPackage = report.rows.find((r) => r.taskFamily === "cross-package")!;
    expect(crossPackage.unmatchedReasons["missing-log"]).toBe(2);
    expect(report.totalUnmatchedReasons).toEqual({
      "missing-log": 2,
      "unmatched-session": 1,
      "unknown-model": 0,
      "low-confidence": 1,
    });
  });

  it("is deterministic: identical fixtures reproduce a deep-equal report every time", () => {
    const a = buildHoldoutReport(cells, samples, unmatchedAttempts);
    const b = buildHoldoutReport(cells, samples, unmatchedAttempts);
    expect(a).toEqual(b);
  });

  it("embeds no wall-clock timestamp (deterministic reproducibility)", () => {
    const report = buildHoldoutReport(cells, samples, unmatchedAttempts);
    expect(JSON.stringify(report)).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });

  it("an empty everything yields an empty report, not a fabricated row", () => {
    const report = buildHoldoutReport([], [], []);
    expect(report.rows).toEqual([]);
    expect(report.totalUnmatchedReasons).toEqual({
      "missing-log": 0,
      "unmatched-session": 0,
      "unknown-model": 0,
      "low-confidence": 0,
    });
  });

  it("is pure: never mutates its inputs", () => {
    const cellsSnapshot = JSON.parse(JSON.stringify(cells));
    const samplesSnapshot = JSON.parse(JSON.stringify(samples));
    const attemptsSnapshot = JSON.parse(JSON.stringify(unmatchedAttempts));
    buildHoldoutReport(cells, samples, unmatchedAttempts);
    expect(cells).toEqual(cellsSnapshot);
    expect(samples).toEqual(samplesSnapshot);
    expect(unmatchedAttempts).toEqual(attemptsSnapshot);
  });
});
