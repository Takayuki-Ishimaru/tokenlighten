// laneTaskHandlesEllipsis.spec.ts — E1 (2026-09-05, measured on paid smoke
// r11 / SF13-estimator-telemetry-continuation-a_tl_sf_cheap3-r0): a solver
// copied a DISPLAY-ABBREVIATED task handle ("prefix...suffix") rather than
// the opaque token itself, `resolveTaskHandle` correctly rejected it, and
// `isSplicedHandle` (wave D's near-miss proof) does not cover the shape:
// the "..." characters are EXTRA relative to the live handle, not a
// deletion, so `isSplicedHandle`'s prefix+suffix arithmetic never reaches
// `supplied.length`. `isEllipsisAbbreviatedHandle` closes that gap; this
// suite pins its truth table directly, plus its wiring into
// `laneTaskHandleNearMiss` alongside the existing splice proof.
//
// Every supplied/live pair below is built by SLICING one real-shaped `LIVE`
// constant, never hand-typed — a hand-typed abbreviation is exactly how the
// measured incident's own bug report briefly mis-transcribed one character
// while drafting this fix, so the values here are computed, not copied.

import { describe, expect, it } from "vitest";

import {
  isEllipsisAbbreviatedHandle,
  isSplicedHandle,
  laneTaskHandleNearMiss,
  recordLaneTaskHandle,
  resetLaneTaskHandlesForTest,
} from "../state/laneTaskHandles.js";

/** Shaped like a real minted task handle: scheme prefix + opaque body. */
const LIVE =
  "tlh_task_v1_AQGWsSsvzBv-sugSTzDVp2UWipaLDcxJC1NfqJRsrjOSPXj7ihF0AAAAAQyQNrwMkYg8Z0J-6jqk_rQAAERs82D70OKWxao9JHp05WU";

/** The measured r11 shape: a 24-char prefix + "..." + a 5-char suffix. */
const R11_SUPPLIED = `${LIVE.slice(0, 24)}...${LIVE.slice(-5)}`;

describe("isEllipsisAbbreviatedHandle", () => {
  it("matches the measured r11 shape (24-char prefix + '...' + 5-char suffix)", () => {
    expect(isEllipsisAbbreviatedHandle(R11_SUPPLIED, LIVE)).toBe(true);
  });

  it("the r11 shape is NOT proven by isSplicedHandle — the two checks are complementary", () => {
    expect(isSplicedHandle(R11_SUPPLIED, LIVE)).toBe(false);
  });

  it("matches the same shape with the unicode ellipsis '…' instead of '...'", () => {
    const supplied = `${LIVE.slice(0, 24)}…${LIVE.slice(-5)}`;
    expect(isEllipsisAbbreviatedHandle(supplied, LIVE)).toBe(true);
  });

  it("matches a bare '..' marker when it occurs exactly once and the floor is met", () => {
    const supplied = `${LIVE.slice(0, 30)}..${LIVE.slice(-8)}`;
    expect(isEllipsisAbbreviatedHandle(supplied, LIVE)).toBe(true);
  });

  it("does not match a random other live handle (foreign handle stays foreign)", () => {
    const other = `${"tlh_task_v1_"}${"z".repeat(100)}`;
    expect(isEllipsisAbbreviatedHandle(R11_SUPPLIED, other)).toBe(false);
  });

  it("does not match when the kept prefix+suffix falls below the 24-char floor", () => {
    // 12-char prefix + 5-char suffix = 17, below MIN_SHARED_PREFIX (24).
    const supplied = `${LIVE.slice(0, 12)}...${LIVE.slice(-5)}`;
    expect(isEllipsisAbbreviatedHandle(supplied, LIVE)).toBe(false);
  });

  it("matches exactly AT the floor (19 + 5 = 24)", () => {
    const supplied = `${LIVE.slice(0, 19)}...${LIVE.slice(-5)}`;
    expect(isEllipsisAbbreviatedHandle(supplied, LIVE)).toBe(true);
  });

  it("does not match one character below the floor (18 + 5 = 23)", () => {
    const supplied = `${LIVE.slice(0, 18)}...${LIVE.slice(-5)}`;
    expect(isEllipsisAbbreviatedHandle(supplied, LIVE)).toBe(false);
  });

  it("does not match when the marker recurs (ambiguous split point)", () => {
    const supplied = `${LIVE.slice(0, 24)}...${LIVE.slice(30, 40)}...${LIVE.slice(-5)}`;
    expect(isEllipsisAbbreviatedHandle(supplied, LIVE)).toBe(false);
  });

  it("does not match when the marker falls inside the scheme prefix itself", () => {
    const supplied = `tlh_..._v1_${LIVE.slice(20)}`;
    expect(isEllipsisAbbreviatedHandle(supplied, LIVE)).toBe(false);
  });

  it("does not match a string with the wrong scheme prefix entirely", () => {
    expect(isEllipsisAbbreviatedHandle("hbogus...abcde", LIVE)).toBe(false);
  });

  it("is a no-op for an exact match", () => {
    expect(isEllipsisAbbreviatedHandle(LIVE, LIVE)).toBe(false);
  });

  it("is a no-op when supplied is not strictly shorter than live", () => {
    expect(isEllipsisAbbreviatedHandle(`${LIVE}...`, LIVE)).toBe(false);
  });

  it("does not match when the kept suffix is wrong even if the prefix matches", () => {
    const supplied = `${LIVE.slice(0, 24)}...ZZZZZ`;
    expect(isEllipsisAbbreviatedHandle(supplied, LIVE)).toBe(false);
  });
});

describe("laneTaskHandleNearMiss — ellipsis-abbreviation wiring", () => {
  const WORKSPACE = "/tmp/ws-ellipsis-unit";
  const LANE = "unit-ellipsis";

  it("resolves the r11-shaped supplied string to the lane's one live handle", () => {
    resetLaneTaskHandlesForTest();
    recordLaneTaskHandle(WORKSPACE, LANE, LIVE);
    const match = laneTaskHandleNearMiss(WORKSPACE, LANE, R11_SUPPLIED, (candidate) => candidate === LIVE);
    expect(match).toBe(LIVE);
  });

  it("does not resolve when the abbreviation matches no lane handle", () => {
    resetLaneTaskHandlesForTest();
    recordLaneTaskHandle(WORKSPACE, LANE, LIVE);
    const foreign = `${LIVE.slice(0, 24)}...ZZZZZ`;
    const match = laneTaskHandleNearMiss(WORKSPACE, LANE, foreign, (candidate) => candidate === LIVE);
    expect(match).toBeUndefined();
  });

  it("does not resolve against a candidate the liveness check rejects", () => {
    resetLaneTaskHandlesForTest();
    recordLaneTaskHandle(WORKSPACE, LANE, LIVE);
    const match = laneTaskHandleNearMiss(WORKSPACE, LANE, R11_SUPPLIED, () => false);
    expect(match).toBeUndefined();
  });
});
