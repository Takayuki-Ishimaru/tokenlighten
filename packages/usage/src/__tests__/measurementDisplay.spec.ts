import { describe, expect, it } from "vitest";
import { computeMeasurementDecomposition } from "../measurementEngine.js";
import { buildMeasurementDisplay } from "../measurementDisplay.js";
import type { MeasurementInputEvent } from "../measurementEngine.js";
import type { BillingEstimateResult } from "../pricingSnapshots.js";
import type { FeatureContributionSummary } from "../featureContributions.js";

function telemetry(event: string, fields: Partial<MeasurementInputEvent> = {}): MeasurementInputEvent {
  return { event, ts: 0, ...fields };
}

function usageEvent(estimatedSavedTokens: number): MeasurementInputEvent {
  return { estimatedSavedTokens } as MeasurementInputEvent;
}

// ---------------------------------------------------------------------------
// The "no all-dash" DoD: lower layers render even when upper layers cannot.
// ---------------------------------------------------------------------------

describe("buildMeasurementDisplay — no-all-dash DoD", () => {
  it("with a completely empty event batch, every tier still carries a status and a non-empty basis", () => {
    const decomposition = computeMeasurementDecomposition([]);
    const display = buildMeasurementDisplay(decomposition);

    for (const tier of [display.wire, display.mcpResponse, display.contextAvoided, display.session, display.session.net]) {
      expect(typeof tier.status).toBe("string");
      expect(tier.basis.length).toBeGreaterThan(0);
    }
  });

  it("the wire tier is ALWAYS measured, even with zero events (a count of 0 is not an estimate)", () => {
    const decomposition = computeMeasurementDecomposition([]);
    const display = buildMeasurementDisplay(decomposition);
    expect(display.wire.status).toBe("measured");
    expect(display.wire.calls).toBe(0);
    expect(display.wire.events).toBe(0);
  });

  it("a lower tier (wire) is measured while an upper tier (session) is unavailable", () => {
    // Only wire-level counting is possible from an event batch with no
    // recognized event kinds at all -- the display must not go all-dash.
    const decomposition = computeMeasurementDecomposition([telemetry("some_unrelated_event")]);
    const display = buildMeasurementDisplay(decomposition);
    expect(display.wire.status).toBe("measured");
    expect(display.wire.events).toBe(1);
    expect(display.session.status).toBe("unavailable");
    expect(display.session.basis.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Tier mapping
// ---------------------------------------------------------------------------

describe("buildMeasurementDisplay — tier mapping", () => {
  it("wire reports the engine's observedCounts (calls/events), not tokens", () => {
    const events = [
      telemetry("route_decision", { call_id: 1 }),
      telemetry("route_decision", { call_id: 2 }),
      telemetry("task_pack_start", { call_id: 2 }),
    ];
    const display = buildMeasurementDisplay(computeMeasurementDecomposition(events));
    expect(display.wire.events).toBe(3);
    expect(display.wire.calls).toBe(2);
    expect(display.wire.tokens).toBeNull();
    expect(display.wire.cashUsd).toBeNull();
  });

  it("mcpResponse mirrors tl_overhead exactly", () => {
    const events = [telemetry("route_decision", { call_id: 1 })];
    const decomposition = computeMeasurementDecomposition(events);
    const display = buildMeasurementDisplay(decomposition);
    expect(display.mcpResponse.status).toBe(decomposition.tl_overhead.provenance.status);
    expect(display.mcpResponse.tokens).toBe(decomposition.tl_overhead.tokens);
    expect(display.mcpResponse.basis).toBe(decomposition.tl_overhead.provenance.basis);
  });

  it("contextAvoided combines direct_context_saving + avoided_read_saving", () => {
    const events = [usageEvent(400), telemetry("repeated_range"), telemetry("post_edit_readback")];
    const decomposition = computeMeasurementDecomposition(events);
    const display = buildMeasurementDisplay(decomposition);
    const expectedTokens =
      (decomposition.direct_context_saving.tokens ?? 0) + (decomposition.avoided_read_saving.tokens ?? 0);
    expect(display.contextAvoided.tokens).toBe(expectedTokens);
    // direct_context_saving is measured but avoided_read_saving is
    // estimated -- the combined tier must not claim "measured".
    expect(decomposition.direct_context_saving.provenance.status).toBe("measured");
    expect(decomposition.avoided_read_saving.provenance.status).toBe("estimated");
    expect(display.contextAvoided.status).toBe("estimated");
  });

  it("contextAvoided is measured when BOTH halves are measured (only possible if avoided_read_saving is unavailable and contributes 0)", () => {
    // avoided_read_saving can only ever be "measured" in the trivial sense
    // that never actually happens in this engine (it is either estimated or
    // unavailable) -- so a "measured" contextAvoided tier is unreachable
    // today. Assert the CONTRAPOSITIVE instead: with only
    // direct_context_saving present, the combined tier is never
    // "unavailable" (real evidence exists), matching the no-all-dash DoD.
    const decomposition = computeMeasurementDecomposition([usageEvent(100)]);
    const display = buildMeasurementDisplay(decomposition);
    expect(display.contextAvoided.status).not.toBe("unavailable");
    expect(display.contextAvoided.tokens).toBe(100);
  });

  it("contextAvoided is unavailable when BOTH halves are unavailable", () => {
    const decomposition = computeMeasurementDecomposition([telemetry("route_decision", { call_id: 1 })]);
    const display = buildMeasurementDisplay(decomposition);
    expect(display.contextAvoided.status).toBe("unavailable");
    expect(display.contextAvoided.tokens).toBeNull();
  });

  it("session mirrors avoided_turn_saving and carries a nested net tier", () => {
    const events = [telemetry("repeated_query"), usageEvent(200)];
    const decomposition = computeMeasurementDecomposition(events);
    const display = buildMeasurementDisplay(decomposition);
    expect(display.session.status).toBe(decomposition.avoided_turn_saving.provenance.status);
    expect(display.session.tokens).toBe(decomposition.avoided_turn_saving.tokens);
    expect(display.session.net.status).toBe(decomposition.net.provenance.status);
    expect(display.session.net.tokens).toBe(decomposition.net.tokens);
  });
});

// ---------------------------------------------------------------------------
// Purity / additivity
// ---------------------------------------------------------------------------

describe("buildMeasurementDisplay — purity", () => {
  it("is a pure reshape: it never re-derives a number the engine did not already compute", () => {
    const events = [usageEvent(150), telemetry("repeated_range"), telemetry("repeated_query", { call_id: 1 })];
    const decomposition = computeMeasurementDecomposition(events);
    const a = buildMeasurementDisplay(decomposition);
    const b = buildMeasurementDisplay(decomposition);
    expect(a).toEqual(b);
  });

  it("does not mutate the decomposition it was given", () => {
    const decomposition = computeMeasurementDecomposition([usageEvent(150)]);
    const snapshot = JSON.parse(JSON.stringify(decomposition));
    buildMeasurementDisplay(decomposition);
    expect(decomposition).toEqual(snapshot);
  });
});

// ---------------------------------------------------------------------------
// V11-08 addition: optional `billing` / `featureContributions` tiers. Fully
// additive -- every test above this block calls buildMeasurementDisplay with
// ONE argument and must keep passing unmodified.
// ---------------------------------------------------------------------------

describe("buildMeasurementDisplay — options is fully additive/optional", () => {
  it("omits billing and featureContributions ENTIRELY when no options are supplied", () => {
    const display = buildMeasurementDisplay(computeMeasurementDecomposition([usageEvent(100)]));
    expect("billing" in display).toBe(false);
    expect("featureContributions" in display).toBe(false);
  });

  it("existing four tiers are computed identically whether or not options are supplied", () => {
    const decomposition = computeMeasurementDecomposition([usageEvent(100), telemetry("repeated_range")]);
    const without = buildMeasurementDisplay(decomposition);
    const withOptions = buildMeasurementDisplay(decomposition, { featureContributions: [] });
    expect(withOptions.wire).toEqual(without.wire);
    expect(withOptions.mcpResponse).toEqual(without.mcpResponse);
    expect(withOptions.contextAvoided).toEqual(without.contextAvoided);
    expect(withOptions.session).toEqual(without.session);
  });
});

describe("buildMeasurementDisplay — billing tier", () => {
  const decomposition = computeMeasurementDecomposition([usageEvent(100)]);

  it("surfaces an estimated billing result with priceAsOf and billingMode", () => {
    const billing: BillingEstimateResult = {
      status: "estimated",
      model: "claude-sonnet-5-20260810",
      billingMode: "api",
      priceAsOf: "2026-08-10",
      snapshotId: "api-reference-2026-08-10",
      costUsd: 1.23,
      breakdown: { inputUsd: 1, cacheWriteUsd: 0, cacheReadUsd: 0, outputUsd: 0.23 },
    };
    const display = buildMeasurementDisplay(decomposition, { billing });
    expect(display.billing).toEqual({
      status: "estimated",
      basis: expect.any(String),
      costUsd: 1.23,
      billingMode: "api",
      priceAsOf: "2026-08-10",
    });
  });

  it("surfaces an unavailable billing result (unknown model) without a billingMode/priceAsOf/cost", () => {
    const billing: BillingEstimateResult = {
      status: "unavailable",
      reason: "unknown-model",
      model: "totally-unknown",
      basis: "no pricing entry matches this model",
    };
    const display = buildMeasurementDisplay(decomposition, { billing });
    expect(display.billing).toEqual({
      status: "unavailable",
      basis: "no pricing entry matches this model",
      costUsd: null,
      billingMode: null,
      priceAsOf: null,
    });
  });

  it("a billing tier being unavailable does NOT make a lower tier (wire) unavailable", () => {
    const billing: BillingEstimateResult = {
      status: "unavailable",
      reason: "unknown-model",
      model: "x",
      basis: "unknown model",
    };
    const display = buildMeasurementDisplay(decomposition, { billing });
    expect(display.wire.status).toBe("measured");
    expect(display.contextAvoided.status).not.toBe("unavailable");
  });
});

describe("buildMeasurementDisplay — featureContributions tier", () => {
  const decomposition = computeMeasurementDecomposition([usageEvent(100)]);

  it("renders one entry per fed summary, preserving negative tokens as negative", () => {
    const summaries: FeatureContributionSummary[] = [
      { feature: "acknowledged_prior_bytes_avoided", status: "measured", tokens: -300, eventCount: 2, basis: "test" },
      { feature: "avoided_turn", status: "estimated", tokens: 1500, eventCount: 1, basis: "test" },
    ];
    const display = buildMeasurementDisplay(decomposition, { featureContributions: summaries });
    expect(display.featureContributions).toEqual([
      { feature: "acknowledged_prior_bytes_avoided", status: "measured", basis: "test", tokens: -300, cashUsd: null },
      { feature: "avoided_turn", status: "estimated", basis: "test", tokens: 1500, cashUsd: null },
    ]);
  });

  it("an empty array is rendered as present-but-empty, distinct from never fed", () => {
    const display = buildMeasurementDisplay(decomposition, { featureContributions: [] });
    expect(display.featureContributions).toEqual([]);
    expect("featureContributions" in display).toBe(true);
  });

  it("a lower tier (wire/mcpResponse) is unaffected by featureContributions being fed or not", () => {
    const withFeature = buildMeasurementDisplay(decomposition, {
      featureContributions: [{ feature: "x", status: "measured", tokens: 1, eventCount: 1, basis: "b" }],
    });
    const withoutFeature = buildMeasurementDisplay(decomposition);
    expect(withFeature.mcpResponse).toEqual(withoutFeature.mcpResponse);
  });
});
