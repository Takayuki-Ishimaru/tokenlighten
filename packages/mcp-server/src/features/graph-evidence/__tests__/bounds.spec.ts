// ---------------------------------------------------------------------------
// bounds.spec.ts — V11-01 acceptance: bounded expansion.
//
// Plan §V11-01 受入基準 "graph explosion fixture で budget／fan-out cap を超えない",
// and the standing rule that a truncated result may never read as `complete`.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";

import {
  BoundTracker,
  BOUND_FIELDS,
  coverageUnderTruncation,
  EMPTY_TRUNCATION_REPORT,
  EXPANSION_SCOPE,
  MAX_TRUNCATION_DETAILS,
  TRUNCATION_REASONS,
  validateBounds,
  type ExpansionBounds,
} from "../bounds.js";

const GENEROUS: ExpansionBounds = {
  maxNodes: 100,
  maxDepth: 4,
  maxFanout: 50,
  maxBytes: 1_000_000,
  maxDurationMs: 10_000,
};

function withBound(field: keyof ExpansionBounds, value: number): ExpansionBounds {
  return { ...GENEROUS, [field]: value };
}

/** A clock that advances one tick per read, so duration is deterministic. */
function tickingClock(step: number): () => number {
  let t = 0;
  return () => {
    const now = t;
    t += step;
    return now;
  };
}

// ---------------------------------------------------------------------------
// 1. Every bound is mandatory
// ---------------------------------------------------------------------------

describe("validateBounds — there is no unbounded mode", () => {
  it("accepts a well-formed budget", () => {
    expect(() => validateBounds(GENEROUS)).not.toThrow();
  });

  it.each(BOUND_FIELDS)("rejects %s = Infinity", (field) => {
    expect(() => validateBounds(withBound(field, Number.POSITIVE_INFINITY))).toThrow(RangeError);
  });

  it.each(BOUND_FIELDS)("rejects %s = NaN", (field) => {
    expect(() => validateBounds(withBound(field, Number.NaN))).toThrow(RangeError);
  });

  it.each(BOUND_FIELDS)("rejects %s = 0", (field) => {
    expect(() => validateBounds(withBound(field, 0))).toThrow(/must be >= 1/);
  });

  it.each(BOUND_FIELDS)("rejects a negative %s", (field) => {
    expect(() => validateBounds(withBound(field, -1))).toThrow(/must be >= 1/);
  });

  it.each(BOUND_FIELDS)("rejects a fractional %s", (field) => {
    expect(() => validateBounds(withBound(field, 2.5))).toThrow(/must be an integer/);
  });

  it("rejects a missing field even when the caller lied to the type system", () => {
    const missing = { ...GENEROUS } as Record<string, number>;
    delete missing["maxFanout"];
    expect(() => validateBounds(missing as unknown as ExpansionBounds)).toThrow(
      /maxFanout must be a finite number/,
    );
  });

  it("the tracker validates at construction, before anything is expanded", () => {
    expect(() => new BoundTracker({ bounds: withBound("maxNodes", 0) })).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// 2. Each cap bites, and says so
// ---------------------------------------------------------------------------

describe("caps", () => {
  it("maxNodes is never overrun", () => {
    const tracker = new BoundTracker({ bounds: withBound("maxNodes", 3) });
    const admitted = [1, 2, 3, 4, 5].filter((n) => tracker.admitNode(10, `node-${n}`));
    expect(admitted).toHaveLength(3);
    expect(tracker.nodesAdmitted).toBe(3);
    expect(tracker.report().counts["max-nodes"]).toBe(2);
    expect(tracker.report().truncated).toBe(true);
  });

  it("maxBytes is never overrun — a node is charged whole or not at all", () => {
    const tracker = new BoundTracker({ bounds: withBound("maxBytes", 25) });
    expect(tracker.admitNode(10, "a")).toBe(true);
    expect(tracker.admitNode(10, "b")).toBe(true);
    expect(tracker.admitNode(10, "c")).toBe(false);
    expect(tracker.bytesCharged).toBe(20);
    expect(tracker.bytesCharged).toBeLessThanOrEqual(25);
    expect(tracker.report().counts["max-bytes"]).toBe(1);
  });

  it("maxFanout slices and records exactly what was dropped", () => {
    const tracker = new BoundTracker({ bounds: withBound("maxFanout", 4) });
    const kept = tracker.limitFanout([1, 2, 3, 4, 5, 6, 7], "hub");
    expect(kept).toEqual([1, 2, 3, 4]);
    const report = tracker.report();
    expect(report.counts["max-fanout"]).toBe(1);
    expect(report.details[0]).toMatchObject({ reason: "max-fanout", at: "hub", dropped: 3, limit: 4 });
  });

  it("maxFanout does not record when nothing was dropped", () => {
    const tracker = new BoundTracker({ bounds: withBound("maxFanout", 4) });
    expect(tracker.limitFanout([1, 2], "small")).toEqual([1, 2]);
    expect(tracker.report().truncated).toBe(false);
  });

  it("maxDepth stops the walk and records it", () => {
    const tracker = new BoundTracker({ bounds: withBound("maxDepth", 2) });
    expect(tracker.admitDepth(1, "a")).toBe(true);
    expect(tracker.admitDepth(2, "b")).toBe(true);
    expect(tracker.admitDepth(3, "c")).toBe(false);
    expect(tracker.report().counts["max-depth"]).toBe(1);
  });

  it("maxDurationMs expires once and latches, however often it is polled", () => {
    const tracker = new BoundTracker({
      bounds: withBound("maxDurationMs", 5),
      now: tickingClock(3),
    });
    // startedAt consumed tick 0; the next reads are 3, 6, ...
    expect(tracker.expired()).toBe(false);
    expect(tracker.expired()).toBe(true);
    expect(tracker.expired()).toBe(true);
    expect(tracker.expired()).toBe(true);
    expect(tracker.report().counts["max-duration"]).toBe(1);
    expect(tracker.report().details[0]?.at).toBe(EXPANSION_SCOPE);
  });
});

// ---------------------------------------------------------------------------
// 3. The detail list is itself bounded
// ---------------------------------------------------------------------------

describe("truncation reporting", () => {
  it("caps the detail list and says it did", () => {
    const tracker = new BoundTracker({ bounds: withBound("maxNodes", 1) });
    expect(tracker.admitNode(1, "seed")).toBe(true);
    for (let i = 0; i < MAX_TRUNCATION_DETAILS + 10; i++) tracker.admitNode(1, `n-${i}`);
    const report = tracker.report();
    expect(report.details).toHaveLength(MAX_TRUNCATION_DETAILS);
    expect(report.detailsTruncated).toBe(true);
    // Counts are NOT capped: the report still knows how many were lost.
    expect(report.counts["max-nodes"]).toBe(MAX_TRUNCATION_DETAILS + 10);
  });

  it("reports every reason, zeroed, when nothing was truncated", () => {
    const report = new BoundTracker({ bounds: GENEROUS }).report();
    expect(report.truncated).toBe(false);
    for (const reason of TRUNCATION_REASONS) expect(report.counts[reason]).toBe(0);
    expect(report).toEqual(EMPTY_TRUNCATION_REPORT);
  });

  it("report() snapshots — a later cap cannot mutate an earlier report", () => {
    const tracker = new BoundTracker({ bounds: withBound("maxNodes", 1) });
    tracker.admitNode(1, "seed");
    tracker.admitNode(1, "dropped");
    const first = tracker.report();
    tracker.admitNode(1, "also-dropped");
    expect(first.counts["max-nodes"]).toBe(1);
    expect(tracker.report().counts["max-nodes"]).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 4. Truncation degrades coverage
// ---------------------------------------------------------------------------

describe("coverageUnderTruncation", () => {
  it("a truncated expansion is NEVER complete", () => {
    const tracker = new BoundTracker({ bounds: withBound("maxNodes", 1) });
    tracker.admitNode(1, "seed");
    tracker.admitNode(1, "dropped");
    expect(coverageUnderTruncation("complete", tracker.report())).toBe("partial");
  });

  it("unknown stays unknown — truncation cannot improve an unprovable claim", () => {
    const tracker = new BoundTracker({ bounds: withBound("maxNodes", 1) });
    tracker.admitNode(1, "seed");
    tracker.admitNode(1, "dropped");
    expect(coverageUnderTruncation("unknown", tracker.report())).toBe("unknown");
  });

  it("leaves an untruncated expansion alone", () => {
    expect(coverageUnderTruncation("complete", EMPTY_TRUNCATION_REPORT)).toBe("complete");
    expect(coverageUnderTruncation("partial", EMPTY_TRUNCATION_REPORT)).toBe("partial");
  });
});
