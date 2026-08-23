import { describe, expect, it } from "vitest";
import {
  CALIBRATION_DIRECT_MEDIUM_MAX_RELATIVE_ERROR95,
  CALIBRATION_HIGH_MAX_RELATIVE_ERROR95,
  CALIBRATION_HIGH_SAMPLE_COUNT,
  CALIBRATION_MIN_SAMPLE_COUNT,
  CALIBRATION_TRANSFERRED_MEDIUM_MAX_RELATIVE_ERROR95,
} from "../calibration.js";
import {
  COEFFICIENT_MIN_COVERAGE_RATE,
  computeCellHoldoutStats,
  evaluateCellPolicy,
  lookupCoefficient,
  transferCoefficient,
  type CellHoldoutStats,
  type CoefficientCell,
  type PairedSample,
} from "../coefficientStore.js";

describe("COEFFICIENT_MIN_COVERAGE_RATE", () => {
  it("is a fraction in (0, 1] usable as a coverage-rate floor", () => {
    expect(COEFFICIENT_MIN_COVERAGE_RATE).toBeGreaterThan(0);
    expect(COEFFICIENT_MIN_COVERAGE_RATE).toBeLessThanOrEqual(1);
  });
});

const DIRECT_CELL: CoefficientCell = {
  taskFamily: "known-local",
  client: "claude-code",
  coefficient: 42,
  provenance: "paired-direct",
  sampleCount: 20,
  relativeError95: 0.3,
};

describe("lookupCoefficient", () => {
  it("finds an exact (taskFamily, client) match", () => {
    expect(lookupCoefficient([DIRECT_CELL], "known-local", "claude-code")).toBe(DIRECT_CELL);
  });

  it("returns null when no cell matches", () => {
    expect(lookupCoefficient([DIRECT_CELL], "known-local", "codex")).toBeNull();
    expect(lookupCoefficient([DIRECT_CELL], "navigation", "claude-code")).toBeNull();
    expect(lookupCoefficient([], "known-local", "claude-code")).toBeNull();
  });
});

describe("transferCoefficient", () => {
  it("borrows a paired-direct source's coefficient value for a new (family, client) target", () => {
    const transferred = transferCoefficient(DIRECT_CELL, { taskFamily: "navigation", client: "codex" });
    expect(transferred).toEqual({
      taskFamily: "navigation",
      client: "codex",
      coefficient: DIRECT_CELL.coefficient,
      provenance: "transferred",
      transferredFrom: { taskFamily: "known-local", client: "claude-code" },
      sampleCount: DIRECT_CELL.sampleCount,
      relativeError95: DIRECT_CELL.relativeError95,
    });
  });

  it("refuses to chain a transfer from an already-transferred cell", () => {
    const transferred = transferCoefficient(DIRECT_CELL, { taskFamily: "navigation", client: "codex" });
    expect(() =>
      transferCoefficient(transferred, { taskFamily: "cross-package", client: "vscode" }),
    ).toThrow(/paired-direct/);
  });
});

describe("computeCellHoldoutStats", () => {
  it("computes sampleCount, matchedCount, coverageRate, and a 95th-percentile relative error per cell", () => {
    const samples: PairedSample[] = [
      { taskFamily: "known-local", client: "claude-code", actualTokens: 100, predictedTokens: 110, matched: true },
      { taskFamily: "known-local", client: "claude-code", actualTokens: 200, predictedTokens: 180, matched: true },
      { taskFamily: "known-local", client: "claude-code", actualTokens: 300, predictedTokens: 300, matched: true },
      { taskFamily: "known-local", client: "claude-code", actualTokens: 0, predictedTokens: 0, matched: false },
      { taskFamily: "navigation", client: "codex", actualTokens: 50, predictedTokens: 60, matched: true },
    ];
    const rows = computeCellHoldoutStats(samples);
    expect(rows).toHaveLength(2);
    const knownLocal = rows.find((r) => r.taskFamily === "known-local")!;
    expect(knownLocal.sampleCount).toBe(4);
    expect(knownLocal.matchedCount).toBe(3);
    expect(knownLocal.coverageRate).toBeCloseTo(0.75, 10);
    // relative errors (matched, actual != 0), ascending: |100-110|/100=0.1,
    // |300-300|/300=0, |200-180|/200=0.1 -> sorted [0, 0.1, 0.1];
    // 95th percentile (nearest-rank, ceil(0.95*3)-1=2) -> index 2 -> 0.1.
    expect(knownLocal.relativeError95).toBeCloseTo(0.1, 10);
  });

  it("relativeError95 is null when there are no matched, non-zero-actual samples", () => {
    const rows = computeCellHoldoutStats([
      { taskFamily: "known-local", client: "codex", actualTokens: 10, predictedTokens: 5, matched: false },
    ]);
    expect(rows[0].coverageRate).toBe(0);
    expect(rows[0].relativeError95).toBeNull();
  });

  it("an empty sample list yields an empty report, not a fabricated row", () => {
    expect(computeCellHoldoutStats([])).toEqual([]);
  });

  it("orders rows deterministically by (taskFamily, client) regardless of input order", () => {
    const samples: PairedSample[] = [
      { taskFamily: "navigation", client: "codex", actualTokens: 1, predictedTokens: 1, matched: true },
      { taskFamily: "known-local", client: "vscode", actualTokens: 1, predictedTokens: 1, matched: true },
      { taskFamily: "known-local", client: "claude-code", actualTokens: 1, predictedTokens: 1, matched: true },
    ];
    const rows = computeCellHoldoutStats(samples);
    expect(rows.map((r) => `${r.taskFamily}/${r.client}`)).toEqual([
      "known-local/claude-code",
      "known-local/vscode",
      "navigation/codex",
    ]);
  });

  it("is pure: never mutates its input", () => {
    const samples: PairedSample[] = [
      { taskFamily: "known-local", client: "claude-code", actualTokens: 1, predictedTokens: 1, matched: true },
    ];
    const snapshot = JSON.parse(JSON.stringify(samples));
    computeCellHoldoutStats(samples);
    expect(samples).toEqual(snapshot);
  });
});

describe("evaluateCellPolicy — paired-direct", () => {
  it("is high when sample count and relative error clear the HIGH thresholds", () => {
    const stats: CellHoldoutStats = {
      taskFamily: "known-local",
      client: "claude-code",
      sampleCount: CALIBRATION_HIGH_SAMPLE_COUNT,
      matchedCount: CALIBRATION_HIGH_SAMPLE_COUNT,
      coverageRate: 1,
      relativeError95: CALIBRATION_HIGH_MAX_RELATIVE_ERROR95,
    };
    expect(evaluateCellPolicy(stats, "paired-direct")).toBe("high");
  });

  it("is medium when only the (looser) direct-medium bound is cleared", () => {
    const stats: CellHoldoutStats = {
      taskFamily: "known-local",
      client: "claude-code",
      sampleCount: CALIBRATION_MIN_SAMPLE_COUNT,
      matchedCount: CALIBRATION_MIN_SAMPLE_COUNT,
      coverageRate: 1,
      relativeError95: CALIBRATION_DIRECT_MEDIUM_MAX_RELATIVE_ERROR95,
    };
    expect(evaluateCellPolicy(stats, "paired-direct")).toBe("medium");
  });

  it("is low when coverage is below COEFFICIENT_MIN_COVERAGE_RATE, regardless of sample count/error", () => {
    const stats: CellHoldoutStats = {
      taskFamily: "known-local",
      client: "claude-code",
      sampleCount: CALIBRATION_HIGH_SAMPLE_COUNT,
      matchedCount: 1,
      coverageRate: COEFFICIENT_MIN_COVERAGE_RATE - 0.01,
      relativeError95: 0.01,
    };
    expect(evaluateCellPolicy(stats, "paired-direct")).toBe("low");
  });

  it("is low when relativeError95 is null (no evidence)", () => {
    const stats: CellHoldoutStats = {
      taskFamily: "known-local",
      client: "claude-code",
      sampleCount: 100,
      matchedCount: 0,
      coverageRate: 0,
      relativeError95: null,
    };
    expect(evaluateCellPolicy(stats, "paired-direct")).toBe("low");
  });
});

describe("evaluateCellPolicy — transferred ALWAYS downgrades confidence one level", () => {
  it("stats that would be direct-HIGH are only ever transferred-MEDIUM, never high", () => {
    const stats: CellHoldoutStats = {
      taskFamily: "known-local",
      client: "codex",
      sampleCount: CALIBRATION_HIGH_SAMPLE_COUNT,
      matchedCount: CALIBRATION_HIGH_SAMPLE_COUNT,
      coverageRate: 1,
      relativeError95: CALIBRATION_HIGH_MAX_RELATIVE_ERROR95,
    };
    expect(evaluateCellPolicy(stats, "paired-direct")).toBe("high");
    expect(evaluateCellPolicy(stats, "transferred")).toBe("medium");
  });

  it("clears the LOOSER transferred-medium bound (between the direct-medium and transferred-medium bounds)", () => {
    const midpointError =
      (CALIBRATION_DIRECT_MEDIUM_MAX_RELATIVE_ERROR95 + CALIBRATION_TRANSFERRED_MEDIUM_MAX_RELATIVE_ERROR95) / 2;
    const stats: CellHoldoutStats = {
      taskFamily: "known-local",
      client: "codex",
      sampleCount: CALIBRATION_MIN_SAMPLE_COUNT,
      matchedCount: CALIBRATION_MIN_SAMPLE_COUNT,
      coverageRate: 1,
      relativeError95: midpointError,
    };
    expect(midpointError).toBeGreaterThan(CALIBRATION_DIRECT_MEDIUM_MAX_RELATIVE_ERROR95);
    expect(midpointError).toBeLessThanOrEqual(CALIBRATION_TRANSFERRED_MEDIUM_MAX_RELATIVE_ERROR95);
    expect(evaluateCellPolicy(stats, "transferred")).toBe("medium");
  });

  it("falls to low once even the looser transferred bound is exceeded", () => {
    const stats: CellHoldoutStats = {
      taskFamily: "known-local",
      client: "codex",
      sampleCount: CALIBRATION_MIN_SAMPLE_COUNT,
      matchedCount: CALIBRATION_MIN_SAMPLE_COUNT,
      coverageRate: 1,
      relativeError95: CALIBRATION_TRANSFERRED_MEDIUM_MAX_RELATIVE_ERROR95 + 0.01,
    };
    expect(evaluateCellPolicy(stats, "transferred")).toBe("low");
  });

  it("never returns high for transferred no matter how good the stats are", () => {
    const stats: CellHoldoutStats = {
      taskFamily: "known-local",
      client: "codex",
      sampleCount: 1000,
      matchedCount: 1000,
      coverageRate: 1,
      relativeError95: 0,
    };
    expect(evaluateCellPolicy(stats, "transferred")).toBe("medium");
  });
});
