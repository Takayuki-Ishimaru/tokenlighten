import { describe, expect, it } from "vitest";
import {
  CALIBRATION_DIRECT_MEDIUM_MAX_RELATIVE_ERROR95,
  CALIBRATION_HIGH_MAX_RELATIVE_ERROR95,
  CALIBRATION_HIGH_SAMPLE_COUNT,
  CALIBRATION_MATERIALITY,
  CALIBRATION_MIN_SAMPLE_COUNT,
  CALIBRATION_TRANSFERRED_MEDIUM_MAX_RELATIVE_ERROR95,
  SESSION_ESTIMATOR_CALIBRATION,
} from "../calibration.js";

const CLIENTS = [
  "vscode",
  "codex",
  "claude-code",
  "desktop",
  "other",
] as const;

describe("SESSION_ESTIMATOR_CALIBRATION", () => {
  it("keeps the confidence policy constants aligned with paired-v1", () => {
    expect(CALIBRATION_MIN_SAMPLE_COUNT).toBe(12);
    expect(CALIBRATION_HIGH_SAMPLE_COUNT).toBe(24);
    expect(CALIBRATION_HIGH_MAX_RELATIVE_ERROR95).toBe(0.25);
    expect(CALIBRATION_DIRECT_MEDIUM_MAX_RELATIVE_ERROR95).toBe(0.5);
    expect(CALIBRATION_TRANSFERRED_MEDIUM_MAX_RELATIVE_ERROR95).toBe(0.6);
    expect(CALIBRATION_MATERIALITY).toBe(0.1);
  });

  it("contains a valid release-safe value for every client", () => {
    const calibration = SESSION_ESTIMATOR_CALIBRATION;
    expect(calibration.schemaVersion).toBe(1);
    expect(calibration.rawPairedBillingIncluded).toBe(false);
    expect(Object.keys(calibration.tokenDeltaMultiplierByClient).sort())
      .toEqual([...CLIENTS].sort());
    expect(Object.keys(calibration.sourceByClient).sort())
      .toEqual([...CLIENTS].sort());
    expect(Object.keys(calibration.sampleCountByClient).sort())
      .toEqual([...CLIENTS].sort());
    expect(Object.keys(calibration.relativeError95ByClient).sort())
      .toEqual([...CLIENTS].sort());

    for (const client of CLIENTS) {
      const source = calibration.sourceByClient[client];
      const multiplier = calibration.tokenDeltaMultiplierByClient[client];
      const sampleCount = calibration.sampleCountByClient[client];
      const relativeError95 = calibration.relativeError95ByClient[client];

      expect(Number.isFinite(multiplier)).toBe(true);
      expect(multiplier).toBeGreaterThan(0);
      if (source === "analytic-fallback") {
        expect(multiplier).toBe(1);
        expect(sampleCount).toBe(0);
        expect(relativeError95).toBeNull();
      } else {
        expect(Number.isInteger(sampleCount)).toBe(true);
        expect(sampleCount).toBeGreaterThanOrEqual(
          CALIBRATION_MIN_SAMPLE_COUNT,
        );
        expect(relativeError95).not.toBeNull();
        expect(Number.isFinite(relativeError95)).toBe(true);
        expect(relativeError95).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("derives the preserved global fields from direct client calibration", () => {
    const calibration = SESSION_ESTIMATOR_CALIBRATION;
    const directClients = CLIENTS.filter(
      (client) => calibration.sourceByClient[client] === "paired-direct",
    );
    const hasPaired = CLIENTS.some(
      (client) => calibration.sourceByClient[client] !== "analytic-fallback",
    );
    const directErrors = directClients.flatMap((client) => {
      const value = calibration.relativeError95ByClient[client];
      return value === null ? [] : [value];
    });

    expect(calibration.source).toBe(
      hasPaired ? "paired-derived" : "analytic-fallback",
    );
    expect(calibration.sampleCount).toBe(
      directClients.reduce(
        (sum, client) => sum + calibration.sampleCountByClient[client],
        0,
      ),
    );
    expect(calibration.relativeError95).toBe(
      directErrors.length > 0 ? Math.max(...directErrors) : null,
    );
  });
});
