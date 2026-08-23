import { describe, expect, it } from "vitest";
import {
  computeMeasurementDecomposition,
  DEFAULT_COEFFICIENTS,
  type MeasurementInputEvent,
} from "../measurementEngine.js";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function telemetry(
  event: string,
  fields: Partial<MeasurementInputEvent> = {},
): MeasurementInputEvent {
  return { event, ts: 0, ...fields };
}

function usageEvent(estimatedSavedTokens: number): MeasurementInputEvent {
  return { estimatedSavedTokens } as MeasurementInputEvent;
}

// ---------------------------------------------------------------------------
// Empty input — nothing fabricated
// ---------------------------------------------------------------------------

describe("computeMeasurementDecomposition — empty input", () => {
  it("every component is unavailable with null tokens/cashUsd", () => {
    const result = computeMeasurementDecomposition([]);
    for (const key of [
      "direct_context_saving",
      "avoided_read_saving",
      "avoided_turn_saving",
      "tl_overhead",
      "net",
    ] as const) {
      expect(result[key].provenance.status).toBe("unavailable");
      expect(result[key].tokens).toBeNull();
      expect(result[key].cashUsd).toBeNull();
      expect(result[key].provenance.basis.length).toBeGreaterThan(0);
    }
  });

  it("observedCounts are all zero", () => {
    const { observedCounts } = computeMeasurementDecomposition([]);
    expect(observedCounts).toEqual({
      totalEvents: 0,
      usageLikeEvents: 0,
      repeatedQuery: 0,
      repeatedRange: 0,
      forcedResend: 0,
      postEditReadback: 0,
      distinctCallIds: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// direct_context_saving — measured, exact arithmetic
// ---------------------------------------------------------------------------

describe("computeMeasurementDecomposition — direct_context_saving", () => {
  it("is measured (not estimated) and sums estimatedSavedTokens exactly", () => {
    const events = [usageEvent(500), usageEvent(300), usageEvent(-50)];
    const result = computeMeasurementDecomposition(events);
    expect(result.direct_context_saving.provenance.status).toBe("measured");
    expect(result.direct_context_saving.tokens).toBe(750);
  });

  it("negative saving (TL added tokens) is preserved, not clamped to 0", () => {
    const events = [usageEvent(-400)];
    const result = computeMeasurementDecomposition(events);
    expect(result.direct_context_saving.provenance.status).toBe("measured");
    expect(result.direct_context_saving.tokens).toBe(-400);
  });

  it("is unavailable when no usage-like event is present", () => {
    const events = [telemetry("route_decision")];
    const result = computeMeasurementDecomposition(events);
    expect(result.direct_context_saving.provenance.status).toBe("unavailable");
    expect(result.direct_context_saving.tokens).toBeNull();
  });

  it("does not confuse a telemetry event for a usage-like event even with similarly-named fields", () => {
    // A TL_TRACE record never carries estimatedSavedTokens; a usage event
    // never carries `event`. The two shapes must never cross-match.
    const events = [telemetry("repeated_range", { path: "a.ts" })];
    const result = computeMeasurementDecomposition(events);
    expect(result.direct_context_saving.provenance.status).toBe("unavailable");
  });
});

// ---------------------------------------------------------------------------
// avoided_read_saving — estimated, count x coefficient
// ---------------------------------------------------------------------------

describe("computeMeasurementDecomposition — avoided_read_saving", () => {
  it("counts repeated_range + post_edit_readback and is ALWAYS estimated, never measured", () => {
    const events = [
      telemetry("repeated_range"),
      telemetry("repeated_range"),
      telemetry("post_edit_readback"),
    ];
    const result = computeMeasurementDecomposition(events);
    expect(result.avoided_read_saving.provenance.status).toBe("estimated");
    expect(result.avoided_read_saving.tokens).toBe(3 * DEFAULT_COEFFICIENTS.avoidedReadTokensPerHit);
  });

  it("ignores unrelated event kinds", () => {
    const events = [telemetry("route_decision"), telemetry("forced_resend")];
    const result = computeMeasurementDecomposition(events);
    expect(result.avoided_read_saving.provenance.status).toBe("unavailable");
  });
});

// ---------------------------------------------------------------------------
// avoided_turn_saving — estimated, count x coefficient
// ---------------------------------------------------------------------------

describe("computeMeasurementDecomposition — avoided_turn_saving", () => {
  it("counts repeated_query + forced_resend and is ALWAYS estimated, never measured", () => {
    const events = [
      telemetry("repeated_query"),
      telemetry("forced_resend"),
      telemetry("forced_resend"),
    ];
    const result = computeMeasurementDecomposition(events);
    expect(result.avoided_turn_saving.provenance.status).toBe("estimated");
    expect(result.avoided_turn_saving.tokens).toBe(3 * DEFAULT_COEFFICIENTS.avoidedTurnTokensPerHit);
  });

  it("is unavailable with none of its driving events", () => {
    const events = [telemetry("repeated_range")];
    const result = computeMeasurementDecomposition(events);
    expect(result.avoided_turn_saving.provenance.status).toBe("unavailable");
  });
});

// ---------------------------------------------------------------------------
// tl_overhead — estimated, distinct call_id count x coefficient
// ---------------------------------------------------------------------------

describe("computeMeasurementDecomposition — tl_overhead", () => {
  it("counts DISTINCT call_ids, not raw event count, and is always estimated", () => {
    const events = [
      telemetry("route_decision", { call_id: 1 }),
      telemetry("task_pack_start", { call_id: 1 }),
      telemetry("task_pack_end", { call_id: 1 }),
      telemetry("route_decision", { call_id: 2 }),
    ];
    const result = computeMeasurementDecomposition(events);
    expect(result.observedCounts.distinctCallIds).toBe(2);
    expect(result.tl_overhead.provenance.status).toBe("estimated");
    expect(result.tl_overhead.tokens).toBe(2 * DEFAULT_COEFFICIENTS.overheadTokensPerCall);
  });

  it("is unavailable when no event carries a numeric call_id", () => {
    const events = [telemetry("route_decision"), usageEvent(100)];
    const result = computeMeasurementDecomposition(events);
    expect(result.tl_overhead.provenance.status).toBe("unavailable");
  });
});

// ---------------------------------------------------------------------------
// Coefficients: overriding the NUMBER never changes the STATUS
// ---------------------------------------------------------------------------

describe("computeMeasurementDecomposition — coefficient overrides", () => {
  it("a custom coefficient changes the token figure but the component stays estimated", () => {
    const events = [telemetry("repeated_range")];
    const result = computeMeasurementDecomposition(events, {
      coefficients: { avoidedReadTokensPerHit: 42 },
    });
    expect(result.avoided_read_saving.tokens).toBe(42);
    expect(result.avoided_read_saving.provenance.status).toBe("estimated");
  });

  it("an unrelated coefficient override leaves the other coefficients at their documented default", () => {
    const events = [telemetry("repeated_query")];
    const result = computeMeasurementDecomposition(events, {
      coefficients: { avoidedReadTokensPerHit: 999999 },
    });
    expect(result.avoided_turn_saving.tokens).toBe(DEFAULT_COEFFICIENTS.avoidedTurnTokensPerHit);
  });
});

// ---------------------------------------------------------------------------
// Pricing / cash — strictly opt-in, never inferred
// ---------------------------------------------------------------------------

describe("computeMeasurementDecomposition — pricing", () => {
  it("every cashUsd is null when no pricing config is supplied, regardless of token status", () => {
    const events = [usageEvent(1000), telemetry("repeated_range"), telemetry("repeated_query")];
    const result = computeMeasurementDecomposition(events);
    expect(result.direct_context_saving.cashUsd).toBeNull();
    expect(result.avoided_read_saving.cashUsd).toBeNull();
    expect(result.avoided_turn_saving.cashUsd).toBeNull();
    expect(result.net.cashUsd).toBeNull();
  });

  it("computes cashUsd from tokens x rate once pricing is supplied", () => {
    const events = [usageEvent(1_000_000)];
    const result = computeMeasurementDecomposition(events, {
      pricing: { costPerMillionTokensUsd: 3 },
    });
    expect(result.direct_context_saving.cashUsd).toBe(3);
  });

  it("an unavailable component's cashUsd stays null even WITH pricing supplied", () => {
    const events = [usageEvent(100)];
    const result = computeMeasurementDecomposition(events, {
      pricing: { costPerMillionTokensUsd: 5 },
    });
    expect(result.avoided_read_saving.provenance.status).toBe("unavailable");
    expect(result.avoided_read_saving.cashUsd).toBeNull();
  });

  it("net.cashUsd is null unless ALL FOUR components have a non-null cashUsd (strict, not best-effort)", () => {
    // direct_context_saving has cash; the other three (no driving events)
    // do not -- net's cash total must not silently omit them.
    const events = [usageEvent(1_000_000)];
    const result = computeMeasurementDecomposition(events, {
      pricing: { costPerMillionTokensUsd: 1 },
    });
    expect(result.direct_context_saving.cashUsd).not.toBeNull();
    expect(result.net.cashUsd).toBeNull();
  });

  it("net.cashUsd sums all four once every component has cash (subtracting tl_overhead)", () => {
    const events = [
      usageEvent(1_000_000),
      telemetry("repeated_range"),
      telemetry("repeated_query"),
      telemetry("route_decision", { call_id: 1 }),
    ];
    const result = computeMeasurementDecomposition(events, {
      pricing: { costPerMillionTokensUsd: 1 },
    });
    const expected =
      (result.direct_context_saving.cashUsd ?? 0)
      + (result.avoided_read_saving.cashUsd ?? 0)
      + (result.avoided_turn_saving.cashUsd ?? 0)
      - (result.tl_overhead.cashUsd ?? 0);
    expect(result.net.cashUsd).toBeCloseTo(expected, 10);
  });
});

// ---------------------------------------------------------------------------
// net — the honesty invariant across every combination
// ---------------------------------------------------------------------------

describe("computeMeasurementDecomposition — net", () => {
  it("is measured ONLY when all four components are measured", () => {
    // Only direct_context_saving can ever be "measured" in this engine (the
    // other three are coefficient-driven), so with any of them present net
    // must NOT be "measured".
    const events = [usageEvent(500), telemetry("repeated_range")];
    const result = computeMeasurementDecomposition(events);
    expect(result.avoided_read_saving.provenance.status).toBe("estimated");
    expect(result.net.provenance.status).not.toBe("measured");
  });

  it("is unavailable only when every component is unavailable", () => {
    const result = computeMeasurementDecomposition([telemetry("some_unrelated_event")]);
    expect(result.net.provenance.status).toBe("unavailable");
    expect(result.net.tokens).toBeNull();
  });

  it("is a best-effort PARTIAL sum (not unavailable) when only SOME components have evidence", () => {
    const events = [usageEvent(500)];
    const result = computeMeasurementDecomposition(events);
    // avoided_read_saving/avoided_turn_saving/tl_overhead are all
    // unavailable here, but direct_context_saving is real evidence -- net
    // must surface it rather than collapsing to unavailable (matches the
    // display feed's "no all-dash" requirement one level up).
    expect(result.net.provenance.status).toBe("estimated");
    expect(result.net.tokens).toBe(500);
  });

  it("sums the three additive components and SUBTRACTS tl_overhead", () => {
    const events = [
      usageEvent(1000), // direct_context_saving
      telemetry("repeated_range"), // avoided_read_saving
      telemetry("repeated_query"), // avoided_turn_saving
      telemetry("route_decision", { call_id: 1 }), // tl_overhead
    ];
    const result = computeMeasurementDecomposition(events);
    const expected =
      1000
      + DEFAULT_COEFFICIENTS.avoidedReadTokensPerHit
      + DEFAULT_COEFFICIENTS.avoidedTurnTokensPerHit
      - DEFAULT_COEFFICIENTS.overheadTokensPerCall;
    expect(result.net.tokens).toBe(expected);
  });

  it("never claims a component as measured when it is estimated (the core honesty invariant)", () => {
    // Exhaustive-ish sweep: for every non-empty subset of the four driving
    // event kinds, no coefficient-driven component may ever report
    // "measured", and tokens is null iff status is "unavailable".
    const kinds = ["repeated_range", "post_edit_readback", "repeated_query", "forced_resend"];
    for (let mask = 1; mask < 1 << kinds.length; mask++) {
      const events = kinds
        .filter((_, i) => (mask & (1 << i)) !== 0)
        .map((k) => telemetry(k));
      const result = computeMeasurementDecomposition(events);
      for (const key of ["avoided_read_saving", "avoided_turn_saving", "tl_overhead"] as const) {
        expect(result[key].provenance.status).not.toBe("measured");
        expect(result[key].tokens === null).toBe(result[key].provenance.status === "unavailable");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Purity
// ---------------------------------------------------------------------------

describe("computeMeasurementDecomposition — purity", () => {
  it("identical input yields a deep-equal result across two independent calls", () => {
    const events = [
      usageEvent(200),
      telemetry("repeated_range", { call_id: 1 }),
      telemetry("repeated_query", { call_id: 2 }),
    ];
    const a = computeMeasurementDecomposition(events);
    const b = computeMeasurementDecomposition(events);
    expect(a).toEqual(b);
  });

  it("never mutates the input array or its entries", () => {
    const events = [usageEvent(200), telemetry("repeated_range")];
    const snapshot = JSON.parse(JSON.stringify(events));
    computeMeasurementDecomposition(events);
    expect(events).toEqual(snapshot);
  });
});
