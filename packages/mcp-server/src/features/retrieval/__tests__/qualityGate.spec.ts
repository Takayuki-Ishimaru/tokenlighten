import { describe, it, expect } from "vitest";
import { evaluateRetrieverQuality } from "../qualityGate.js";

describe("evaluateRetrieverQuality — empty and degenerate lists", () => {
  it("an empty list fails with reason 'empty'", () => {
    expect(evaluateRetrieverQuality([])).toEqual({ passed: false, reason: "empty" });
  });

  it("a single positive score passes (nothing to compare a margin against)", () => {
    expect(evaluateRetrieverQuality([0.7])).toEqual({ passed: true });
  });

  it("a single non-positive score fails as degenerate", () => {
    expect(evaluateRetrieverQuality([0])).toEqual({ passed: false, reason: "degenerate-scores" });
    expect(evaluateRetrieverQuality([-1])).toEqual({ passed: false, reason: "degenerate-scores" });
  });

  it("every score identical (a flat tie) fails as degenerate, regardless of list length", () => {
    expect(evaluateRetrieverQuality([0.5, 0.5, 0.5, 0.5])).toEqual({ passed: false, reason: "degenerate-scores" });
  });

  it("a NaN top score fails as degenerate (defensive)", () => {
    expect(evaluateRetrieverQuality([NaN, 0.1])).toEqual({ passed: false, reason: "degenerate-scores" });
  });
});

describe("evaluateRetrieverQuality — margin discipline", () => {
  it("a wide score spread passes", () => {
    expect(evaluateRetrieverQuality([1.0, 0.8, 0.5, 0.3])).toEqual({ passed: true });
  });

  it("a spread under 5% of the top score fails as insufficient-margin", () => {
    // spread = 1.0 - 0.98 = 0.02, which is < 1.0 * 0.05.
    expect(evaluateRetrieverQuality([1.0, 0.99, 0.98])).toEqual({ passed: false, reason: "insufficient-margin" });
  });

  it("a spread exactly at the boundary passes (top - bottom >= top * ratio, not strictly greater)", () => {
    // top=1.0, bottom=0.95 -> spread exactly 0.05 = 1.0 * 0.05.
    expect(evaluateRetrieverQuality([1.0, 0.97, 0.95])).toEqual({ passed: true });
  });

  it("a strong top score with a flat, low-scoring tail still passes — the TOP item is well-differentiated, which is the useful signal", () => {
    expect(evaluateRetrieverQuality([1.0, 0.4, 0.4, 0.4])).toEqual({ passed: true });
  });
});

describe("evaluateRetrieverQuality — determinism", () => {
  it("is a pure function of its input", () => {
    const scores = [0.9, 0.6, 0.3];
    expect(evaluateRetrieverQuality(scores)).toEqual(evaluateRetrieverQuality(scores));
  });
});
