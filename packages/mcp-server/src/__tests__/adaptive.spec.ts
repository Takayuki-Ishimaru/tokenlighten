/**
 * adaptive.spec.ts — unit tests for util/adaptive.ts
 *
 * Covers:
 *   - Default session state: all inactive values.
 *   - After 1 handle edit + 4 path-search edits: lockdownPathEdits=true.
 *   - After 3 repeated reads of same (path, range): tightenGovernor=true, cap=2.
 *   - D10 (2026-08-14): TL_SESSION_CONTROL is permanent-on, so the flag is
 *     inert and every rule fires even with the old rollback value set.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getAdaptiveAdvice } from "../util/adaptive.js";
import {
  resetAll,
  recordHandleEdit,
  recordPathSearchEdit,
  recordRepeatedRead,
} from "../util/session.js";
import { PER_TASK_FULL_CAP } from "../util/fullGovernor.js";

const WS = "/workspace/adaptive-test";

beforeEach(() => {
  resetAll();
  delete process.env["TL_SESSION_CONTROL"];
});

afterEach(() => {
  delete process.env["TL_SESSION_CONTROL"];
});

// ---------------------------------------------------------------------------
// Default session state
// ---------------------------------------------------------------------------

describe("getAdaptiveAdvice — default state", () => {
  it("returns lockdownPathEdits=false with empty session", () => {
    const advice = getAdaptiveAdvice(WS);
    expect(advice.lockdownPathEdits).toBe(false);
  });

  it("returns tightenGovernor=false with empty session", () => {
    const advice = getAdaptiveAdvice(WS);
    expect(advice.tightenGovernor).toBe(false);
  });

  it("returns effectivePerTaskCap=PER_TASK_FULL_CAP with empty session", () => {
    const advice = getAdaptiveAdvice(WS);
    expect(advice.effectivePerTaskCap).toBe(PER_TASK_FULL_CAP);
  });
});

// ---------------------------------------------------------------------------
// lockdownPathEdits rule
// ---------------------------------------------------------------------------

describe("getAdaptiveAdvice — lockdownPathEdits", () => {
  it("does not lock down with path edits but no handle edits", () => {
    recordPathSearchEdit(WS);
    recordPathSearchEdit(WS);
    recordPathSearchEdit(WS);
    const advice = getAdaptiveAdvice(WS);
    expect(advice.lockdownPathEdits).toBe(false);
  });

  it("does not lock down after 1 handle edit and fewer than 2*(1+1)=4 path edits", () => {
    recordHandleEdit(WS);
    // 3 path edits — threshold is 4
    recordPathSearchEdit(WS);
    recordPathSearchEdit(WS);
    recordPathSearchEdit(WS);
    const advice = getAdaptiveAdvice(WS);
    expect(advice.lockdownPathEdits).toBe(false);
  });

  it("locks down after 1 handle edit + 4 path-search edits (threshold = 2*(1+1)=4)", () => {
    recordHandleEdit(WS);
    recordPathSearchEdit(WS);
    recordPathSearchEdit(WS);
    recordPathSearchEdit(WS);
    recordPathSearchEdit(WS);
    const advice = getAdaptiveAdvice(WS);
    expect(advice.lockdownPathEdits).toBe(true);
  });

  it("threshold scales with handleBackedEdits: 2 handles require 6 path edits to lock", () => {
    recordHandleEdit(WS);
    recordHandleEdit(WS);
    // threshold = 2*(2+1) = 6
    for (let i = 0; i < 5; i++) recordPathSearchEdit(WS);
    expect(getAdaptiveAdvice(WS).lockdownPathEdits).toBe(false);
    recordPathSearchEdit(WS); // 6th path edit
    expect(getAdaptiveAdvice(WS).lockdownPathEdits).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// tightenGovernor rule
// ---------------------------------------------------------------------------

describe("getAdaptiveAdvice — tightenGovernor", () => {
  it("does not tighten after fewer than 3 reads of the same range", () => {
    recordRepeatedRead(WS, "src/service.ts", "10-50");
    recordRepeatedRead(WS, "src/service.ts", "10-50");
    const advice = getAdaptiveAdvice(WS);
    expect(advice.tightenGovernor).toBe(false);
  });

  it("tightens after exactly 3 reads of the same (path, range)", () => {
    recordRepeatedRead(WS, "src/service.ts", "10-50");
    recordRepeatedRead(WS, "src/service.ts", "10-50");
    recordRepeatedRead(WS, "src/service.ts", "10-50");
    const advice = getAdaptiveAdvice(WS);
    expect(advice.tightenGovernor).toBe(true);
  });

  it("tightens after 3 repeated reads of a 'full' sentinel range", () => {
    recordRepeatedRead(WS, "src/large.ts", "full");
    recordRepeatedRead(WS, "src/large.ts", "full");
    recordRepeatedRead(WS, "src/large.ts", "full");
    const advice = getAdaptiveAdvice(WS);
    expect(advice.tightenGovernor).toBe(true);
  });

  it("caps effectivePerTaskCap at PER_TASK_FULL_CAP-1 when tightened, floor 1", () => {
    recordRepeatedRead(WS, "src/service.ts", "10-50");
    recordRepeatedRead(WS, "src/service.ts", "10-50");
    recordRepeatedRead(WS, "src/service.ts", "10-50");
    const advice = getAdaptiveAdvice(WS);
    expect(advice.effectivePerTaskCap).toBe(PER_TASK_FULL_CAP - 1);
    expect(advice.effectivePerTaskCap).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// D10 inertness — TL_SESSION_CONTROL cannot disable the rules
// ---------------------------------------------------------------------------

// D10 (2026-08-14): TL_SESSION_CONTROL is permanent-on and the inactive-advice
// off-branch is deleted. Every rule below now fires WITH the old rollback value
// set — that inversion is the point of the conversion.
describe("getAdaptiveAdvice — D10: TL_SESSION_CONTROL is inert", () => {
  beforeEach(() => {
    process.env["TL_SESSION_CONTROL"] = "0";
  });

  it("still locks down path edits after the regression pattern", () => {
    recordHandleEdit(WS);
    for (let i = 0; i < 10; i++) recordPathSearchEdit(WS);
    const advice = getAdaptiveAdvice(WS);
    expect(advice.lockdownPathEdits).toBe(true);
  });

  it("still tightens the governor after repeated reads", () => {
    for (let i = 0; i < 10; i++) recordRepeatedRead(WS, "src/x.ts", "full");
    const advice = getAdaptiveAdvice(WS);
    expect(advice.tightenGovernor).toBe(true);
  });

  it("still reduces effectivePerTaskCap below the default", () => {
    for (let i = 0; i < 10; i++) recordRepeatedRead(WS, "src/x.ts", "full");
    const advice = getAdaptiveAdvice(WS);
    expect(advice.effectivePerTaskCap).toBeLessThan(PER_TASK_FULL_CAP);
  });
});
