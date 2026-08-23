// ---------------------------------------------------------------------------
// V11-07 break-even table -- unknown cells fall back to policy.ts's global
// defaults exactly, and the two documented cells resolve to their stated
// override numbers.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { MIN_ABSOLUTE_GAIN_BYTES, MIN_RELATIVE_GAIN, MIN_ROWS } from "../protocol/codec/policy.js";
import {
  BREAKEVEN_VERSION,
  GLOBAL_DEFAULT_THRESHOLDS,
  resolveBreakevenThresholds,
} from "../protocol/codec/breakeven.js";

describe("breakeven -- global defaults mirror policy.ts exactly", () => {
  it("GLOBAL_DEFAULT_THRESHOLDS is numerically identical to the v1 globals", () => {
    expect(GLOBAL_DEFAULT_THRESHOLDS).toEqual({
      minRelativeGain: MIN_RELATIVE_GAIN,
      minAbsoluteGainUnits: MIN_ABSOLUTE_GAIN_BYTES,
      minRows: MIN_ROWS,
    });
  });

  it("BREAKEVEN_VERSION is a non-empty version string", () => {
    expect(typeof BREAKEVEN_VERSION).toBe("string");
    expect(BREAKEVEN_VERSION.length).toBeGreaterThan(0);
  });
});

describe("breakeven -- unknown cell => global defaults, always", () => {
  it("an entirely unrecognised client/tokenizer/kind/shape combination falls back", () => {
    const result = resolveBreakevenThresholds({
      clientProfileId: "some-unrecognised-client",
      tokenizerId: "some-unrecognised-tokenizer",
      kind: "search.matches",
      shapeClass: "rows-small-mixed",
    });
    expect(result).toEqual(GLOBAL_DEFAULT_THRESHOLDS);
  });

  it("the 'unknown' client profile id never resolves to an override, even for the read.text/string-heavy cell that DOES have one for a known client", () => {
    const result = resolveBreakevenThresholds({
      clientProfileId: "unknown",
      tokenizerId: "bytes",
      kind: "read.text",
      shapeClass: "string-heavy",
    });
    expect(result).toEqual(GLOBAL_DEFAULT_THRESHOLDS);
  });

  it("a known client with an unlisted (kind, shapeClass) pair falls back", () => {
    const result = resolveBreakevenThresholds({
      clientProfileId: "tl-reference-client",
      tokenizerId: "bytes",
      kind: "read.map",
      shapeClass: "rows-medium-mixed",
    });
    expect(result).toEqual(GLOBAL_DEFAULT_THRESHOLDS);
  });

  it("a listed cell under an unlisted tokenizer id falls back (tokenizer id is part of the key)", () => {
    const result = resolveBreakevenThresholds({
      clientProfileId: "tl-reference-client",
      tokenizerId: "some-real-tokenizer-v1",
      kind: "read.text",
      shapeClass: "string-heavy",
    });
    expect(result).toEqual(GLOBAL_DEFAULT_THRESHOLDS);
  });
});

describe("breakeven -- documented cell overrides", () => {
  it("tl-reference-client / bytes / read.text / string-heavy relaxes the relative-gain and row floors", () => {
    const result = resolveBreakevenThresholds({
      clientProfileId: "tl-reference-client",
      tokenizerId: "bytes",
      kind: "read.text",
      shapeClass: "string-heavy",
    });
    expect(result).toEqual({ minRelativeGain: 0.05, minAbsoluteGainUnits: 32, minRows: 0 });
    // Strictly looser than the global default on both gain floors, and the
    // row floor is dropped entirely (a raw block has no "rows").
    expect(result.minRelativeGain).toBeLessThan(GLOBAL_DEFAULT_THRESHOLDS.minRelativeGain);
    expect(result.minAbsoluteGainUnits).toBeLessThan(GLOBAL_DEFAULT_THRESHOLDS.minAbsoluteGainUnits);
    expect(result.minRows).toBeLessThan(GLOBAL_DEFAULT_THRESHOLDS.minRows);
  });

  it("tl-reference-client / bytes / search.matches / rows-large-numeric raises the relative-gain floor", () => {
    const result = resolveBreakevenThresholds({
      clientProfileId: "tl-reference-client",
      tokenizerId: "bytes",
      kind: "search.matches",
      shapeClass: "rows-large-numeric",
    });
    expect(result).toEqual({
      minRelativeGain: 0.15,
      minAbsoluteGainUnits: MIN_ABSOLUTE_GAIN_BYTES,
      minRows: MIN_ROWS,
    });
    expect(result.minRelativeGain).toBeGreaterThan(GLOBAL_DEFAULT_THRESHOLDS.minRelativeGain);
  });

  it("the same shape class under a DIFFERENT kind than the listed cell does not inherit the override", () => {
    const result = resolveBreakevenThresholds({
      clientProfileId: "tl-reference-client",
      tokenizerId: "bytes",
      kind: "search.references", // the table only lists search.matches for rows-large-numeric
      shapeClass: "rows-large-numeric",
    });
    expect(result).toEqual(GLOBAL_DEFAULT_THRESHOLDS);
  });
});
