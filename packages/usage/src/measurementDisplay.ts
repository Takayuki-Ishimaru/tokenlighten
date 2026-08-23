/**
 * measurementDisplay.ts — V10-02 display feed.
 *
 * Maps a `MeasurementDecomposition` (measurementEngine.ts) onto the plan's
 * layered display model (DESIGN-v0.10-expansion-plan-v1.3.md lines 885-941:
 * "表示を Wire / MCP response / Context avoided / Session / Billing /
 * Verified Task の層へ分ける"). This module implements the FOUR tiers the
 * V10-02 task brief names — Wire / MCP response / Context avoided / Session;
 * Billing and Verified Task are the design doc's remaining two and are out
 * of scope for this wave.
 *
 * Additive only: a brand-new export, no existing type in this package or
 * @tokenlighten/types changes shape. Does not touch the VS Code extension —
 * this is the FEED a display consumer maps onto its own UI; how any client
 * renders a `MeasurementDisplayTiers` value is that client's concern.
 *
 * DoD ("lower-layer metricがあるのに全体が『—』にならない" — a fixture must
 * never render all-dash when a lower layer has real evidence): every tier
 * ALWAYS carries a `status` and a non-empty `basis` string, even when its
 * numeric fields are `null`. A renderer can always show the status/basis
 * text in place of a bare "—", regardless of how little this batch of
 * events made measurable.
 */

import type {
  MeasurementComponent,
  MeasurementDecomposition,
  ProvenanceStatus,
} from "./measurementEngine.js";
import type { FeatureContributionSummary } from "./featureContributions.js";
import type { BillingEstimateResult, BillingMode } from "./pricingSnapshots.js";

export interface DisplayTier {
  status: ProvenanceStatus;
  /** Always non-empty — see this file's DoD note above. */
  basis: string;
  tokens: number | null;
  cashUsd: number | null;
}

export interface MeasurementDisplayTiers {
  /**
   * Lowest tier: raw call/event volume this batch was built from. ALWAYS
   * `"measured"` — a plain count of the supplied array is never an
   * estimate, even when the count is 0. `tokens`/`cashUsd` are null (this
   * tier is a volume count, not a savings figure); `calls`/`events` carry
   * the actual numbers.
   */
  wire: DisplayTier & { calls: number; events: number };
  /** TL's own response-scaffolding cost (tl_overhead). */
  mcpResponse: DisplayTier;
  /** Content re-reads avoided: direct_context_saving + avoided_read_saving. */
  contextAvoided: DisplayTier;
  /** Session-level round-trips avoided (avoided_turn_saving), plus the
   *  overall net figure this batch supports. */
  session: DisplayTier & { net: DisplayTier };
  /**
   * V11-08 addition, ADDITIVE and OPTIONAL: this design doc's originally
   * deferred "Billing" tier (this file's own header doc: "Billing and
   * Verified Task are the design doc's remaining two and are out of scope
   * for this wave" — V10-02's wave; V11-08 is the workstream chartered to
   * add pricing-snapshot-aware billing, so it closes this gap here).
   * Present ONLY when `buildMeasurementDisplay` was called with a `billing`
   * option — absent (not merely a dash) when the caller supplied none, so a
   * consumer can distinguish "never fed" from "fed but unavailable".
   */
  billing?: BillingDisplayTier;
  /**
   * V11-08 addition, ADDITIVE and OPTIONAL: one entry per fed feature
   * contribution (PI-03 acknowledged-prior, V11-05 avoided-turn, etc — see
   * featureContributions.ts). Present ONLY when `buildMeasurementDisplay`
   * was called with a `featureContributions` option; a lower tier (wire,
   * mcpResponse, contextAvoided, session) NEVER becomes unavailable because
   * this one is absent or itself unavailable — each tier is computed
   * independently, matching this file's existing no-all-dash DoD.
   */
  featureContributions?: readonly FeatureContributionDisplayTier[];
}

export interface BillingDisplayTier {
  status: "estimated" | "unavailable";
  /** Always non-empty. */
  basis: string;
  costUsd: number | null;
  /** Null iff status is "unavailable" — an unknown model produces no
   *  estimate, never a billing-mode-less number. */
  billingMode: BillingMode | null;
  /** Null iff status is "unavailable". */
  priceAsOf: string | null;
}

export interface FeatureContributionDisplayTier extends DisplayTier {
  feature: string;
}

export interface MeasurementDisplayOptions {
  /** A pricingSnapshots.ts `BillingEstimateResult` to surface as the
   *  `billing` tier. Omit to leave the tier absent entirely. */
  billing?: BillingEstimateResult;
  /** featureContributions.ts summaries to surface, one display tier each.
   *  Pass `[]` (as opposed to omitting the option) to explicitly assert
   *  "fed, but nothing to show" rather than "never fed". */
  featureContributions?: readonly FeatureContributionSummary[];
}

function billingTier(estimate: BillingEstimateResult): BillingDisplayTier {
  return estimate.status === "estimated"
    ? {
      status: "estimated",
      basis: `${estimate.model} priced against snapshot "${estimate.snapshotId}" `
        + `(${estimate.billingMode}, as of ${estimate.priceAsOf})`,
      costUsd: estimate.costUsd,
      billingMode: estimate.billingMode,
      priceAsOf: estimate.priceAsOf,
    }
    : {
      status: "unavailable",
      basis: estimate.basis,
      costUsd: null,
      billingMode: null,
      priceAsOf: null,
    };
}

function featureContributionTier(
  summary: FeatureContributionSummary,
): FeatureContributionDisplayTier {
  return {
    feature: summary.feature,
    status: summary.status,
    basis: summary.basis,
    tokens: summary.tokens,
    // Pricing a feature contribution is out of scope for this tier — a
    // future wave can wire pricingSnapshots.ts through per-feature, but this
    // module never fabricates a cash figure it was not given.
    cashUsd: null,
  };
}

function tierOf(c: MeasurementComponent): DisplayTier {
  return {
    status: c.provenance.status,
    basis: c.provenance.basis,
    tokens: c.tokens,
    cashUsd: c.cashUsd,
  };
}

/** Combines two components into one tier. Mirrors measurementEngine.ts's
 *  combineNet rule set at a smaller scale: unavailable-plus-unavailable
 *  stays unavailable; otherwise sums non-null tokens (an unavailable half
 *  contributes 0, not a fabricated figure) and is "measured" only if BOTH
 *  halves are measured; cashUsd is strict all-or-nothing. */
function combineTwo(a: MeasurementComponent, b: MeasurementComponent): DisplayTier {
  if (a.provenance.status === "unavailable" && b.provenance.status === "unavailable") {
    return {
      status: "unavailable",
      basis: `${a.provenance.basis}; ${b.provenance.basis}`,
      tokens: null,
      cashUsd: null,
    };
  }
  const bothMeasured =
    a.provenance.status === "measured" && b.provenance.status === "measured";
  const cashUsd = a.cashUsd !== null && b.cashUsd !== null ? a.cashUsd + b.cashUsd : null;
  return {
    status: bothMeasured ? "measured" : "estimated",
    basis: `${a.provenance.basis}; ${b.provenance.basis}`,
    tokens: (a.tokens ?? 0) + (b.tokens ?? 0),
    cashUsd,
  };
}

/**
 * Pure mapping from the engine's decomposition to the display tiers. No I/O,
 * no defaults inferred beyond what `decomposition`/`options` already carry —
 * this function only reshapes, it never re-derives a number some other
 * module did not already compute.
 *
 * `options` is additive and fully backward compatible: calling this with
 * just `decomposition` (as every pre-V11-08 call site does) omits `billing`
 * and `featureContributions` from the result ENTIRELY (not merely null) —
 * the original four tiers are computed exactly as before.
 */
export function buildMeasurementDisplay(
  decomposition: MeasurementDecomposition,
  options: MeasurementDisplayOptions = {},
): MeasurementDisplayTiers {
  const {
    direct_context_saving,
    avoided_read_saving,
    avoided_turn_saving,
    tl_overhead,
    net,
    observedCounts,
  } = decomposition;
  const base: MeasurementDisplayTiers = {
    wire: {
      status: "measured",
      basis: `${observedCounts.totalEvents} telemetry/usage event(s) observed `
        + `across ${observedCounts.distinctCallIds} distinct call(s)`,
      tokens: null,
      cashUsd: null,
      calls: observedCounts.distinctCallIds,
      events: observedCounts.totalEvents,
    },
    mcpResponse: tierOf(tl_overhead),
    contextAvoided: combineTwo(direct_context_saving, avoided_read_saving),
    session: {
      ...tierOf(avoided_turn_saving),
      net: tierOf(net),
    },
  };
  return {
    ...base,
    ...(options.billing !== undefined ? { billing: billingTier(options.billing) } : {}),
    ...(options.featureContributions !== undefined
      ? { featureContributions: options.featureContributions.map(featureContributionTier) }
      : {}),
  };
}
