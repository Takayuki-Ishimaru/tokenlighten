/**
 * measurementEngine.ts — V10-02 Telemetry v2 / Measurement Engine v1.
 *
 * DESIGN-v0.10-expansion-plan-v1.3.md lines 885-941 ("Measurement Engine v1は
 * `Direct Context Saving + Avoided Read Saving + Avoided Turn Saving - TL
 * Overhead`へ分解する"). DESIGN-v0.10-expansion-plan-reconciliation.md §5 D-8
 * defers the paired calibration/ablation RUNS that would FIT the coefficients
 * below — not this engine. This module ships the decomposition machinery with
 * DOCUMENTED, UNFIT default coefficients, honestly labelled `"estimated"`.
 *
 * Pure and additive: no I/O, no side effects, nothing else in this package
 * changes shape to accommodate it. Input is a plain array of records shaped
 * like TWO independent, already-shipped sources, mixed freely in one array:
 *
 *   1. TL_TRACE JSONL records carrying the V10-02 envelope
 *      (packages/mcp-server/src/util/trace.ts's `trace_id`/`call_id`/
 *      `task_ref`/`route`/`flags_active`/`workspaceRef`/`protocol_era`, plus
 *      an `event` name and that event's own payload). This package cannot
 *      import @tokenlighten/mcp-server (the dependency runs the other way —
 *      see packages/mcp-server/package.json), so `TelemetryEvent` below is a
 *      STRUCTURAL duck-typed mirror of that shape, not an import of it.
 *   2. `TokenLightenUsageEvent`-shaped records (this package's own
 *      index.ts/`createUsageRecorder` channel), recognized by their
 *      `estimatedSavedTokens` field — the ALREADY-MEASURED, already-shipped
 *      per-call baseline-vs-response delta (0.9.x scoped usage-metrics,
 *      2026-08-11). This engine does not recompute that number; it only
 *      surfaces it inside the plan's four-way decomposition shape.
 *
 * HONESTY INVARIANT (matches the shipped 0.9.x usage-metrics design exactly,
 * per the task brief — "the engine must NEVER present an estimated component
 * as measured"): `tokens`/`cashUsd` are `null` if and only if
 * `provenance.status === "unavailable"`. A coefficient-driven figure is
 * ALWAYS `"estimated"`, structurally — there is no config knob anywhere in
 * this module that promotes an estimated component to `"measured"`; only a
 * real calibration landing in a FUTURE version of this file can do that.
 *
 * CASH VS TOKENS (plan: "API-equivalent cost、provider credit avoided、
 * marginal cash chargeを分離し、定額利用を現金削減と断定しない" — never claim
 * flat-rate usage as cash savings): `tokens` is always computable from the
 * supplied events; `cashUsd` is `null` on every component whenever no
 * `pricing` config is supplied, full stop — a token figure existing never by
 * itself implies a cash figure exists.
 */

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

/**
 * Structural mirror of a TL_TRACE JSONL record after the V10-02 envelope —
 * see this file's header doc for why this is a duck-typed shape rather than
 * an import. Only the fields this engine actually reads are typed; anything
 * else a real trace record carries (event-specific payload fields) rides
 * the index signature untouched.
 */
export interface TelemetryEvent {
  event: string;
  ts?: number;
  trace_id?: string;
  call_id?: number;
  task_ref?: string;
  route?: string;
  flags_active?: readonly string[];
  workspaceRef?: string;
  protocol_era?: string;
  [key: string]: unknown;
}

/**
 * Structural mirror of the subset of `TokenLightenUsageEvent`
 * (@tokenlighten/types) this engine reads. `estimatedSavedTokens` is the
 * discriminator: a record carrying it (even `0` or negative) is treated as a
 * measured usage-channel entry, never as a telemetry event — the two shapes
 * never collide in practice (a TL_TRACE record has no `estimatedSavedTokens`
 * field; a usage event has no `event` field).
 */
export interface UsageLikeEvent {
  estimatedSavedTokens: number;
  [key: string]: unknown;
}

export type MeasurementInputEvent = TelemetryEvent | UsageLikeEvent;

export interface MeasurementPricingConfig {
  /** Required to compute ANY cashUsd figure. Absent => every component's
   *  cashUsd is null — the plan's "never claim flat-rate usage as cash
   *  savings" rule, enforced structurally rather than left to a caller. */
  costPerMillionTokensUsd: number;
}

// ---------------------------------------------------------------------------
// Documented default coefficients (D-8: UNFIT, pending paired calibration)
// ---------------------------------------------------------------------------

export interface MeasurementCoefficients {
  /**
   * Tokens a caller is assumed to avoid re-fetching on ONE `repeated_range`
   * or `post_edit_readback` ledger hit, instead of a fresh re-serve.
   * Placeholder order-of-magnitude (a small-to-medium code slice) — UNFIT.
   */
  avoidedReadTokensPerHit: number;
  /**
   * Tokens a caller is assumed to avoid spending on ONE extra discovery
   * round-trip (`repeated_query` or `forced_resend`) it did not have to
   * make — re-reading/re-searching context a prior call already resolved.
   * Placeholder order-of-magnitude (several files' worth of re-discovery) —
   * UNFIT.
   */
  avoidedTurnTokensPerHit: number;
  /**
   * Tokens of TL's OWN response scaffolding (kind/coverage/qref/next/etc.)
   * assumed per distinct tool call. Placeholder order-of-magnitude — UNFIT.
   */
  overheadTokensPerCall: number;
}

/**
 * DOCUMENTED, UNFIT v1 defaults. The paired calibration that would fit these
 * (DESIGN-v0.10 D-8) is deferred beyond v0.10.0 as measurement-run spend, not
 * engineering — see this file's header doc. Every component these drive is
 * `provenance.status: "estimated"`, never `"measured"`, structurally.
 */
export const DEFAULT_COEFFICIENTS: MeasurementCoefficients = {
  avoidedReadTokensPerHit: 600,
  avoidedTurnTokensPerHit: 1500,
  overheadTokensPerCall: 150,
};

export interface MeasurementEngineConfig {
  pricing?: MeasurementPricingConfig;
  /** Override one or more DEFAULT_COEFFICIENTS entries — e.g. for a future
   *  calibration run's fitted values. Overriding a NUMBER never changes a
   *  component's provenance status; only this file's own code can do that. */
  coefficients?: Partial<MeasurementCoefficients>;
}

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export type ProvenanceStatus = "measured" | "estimated" | "unavailable";

export interface ComponentProvenance {
  status: ProvenanceStatus;
  /** Human-readable statement of what this figure is based on (or why it is
   *  unavailable) — e.g. event counts, the coefficient applied, or which
   *  input source was missing. Always non-empty. */
  basis: string;
}

export interface MeasurementComponent {
  /** API-equivalent tokens. `null` if and only if provenance.status is
   *  "unavailable" — never a silent 0 standing in for "unknown". */
  tokens: number | null;
  /** Marginal USD, or `null` whenever no pricing config was supplied, OR
   *  whenever tokens itself is null. A null here is "unproven", not "$0". */
  cashUsd: number | null;
  provenance: ComponentProvenance;
}

export interface MeasurementDecomposition {
  direct_context_saving: MeasurementComponent;
  avoided_read_saving: MeasurementComponent;
  avoided_turn_saving: MeasurementComponent;
  tl_overhead: MeasurementComponent;
  /** direct_context_saving + avoided_read_saving + avoided_turn_saving -
   *  tl_overhead. Best-effort over whichever components are non-unavailable
   *  (never all-dash when SOME evidence exists — the shipped display DoD);
   *  cashUsd stays strictly all-or-nothing (see the header doc). */
  net: MeasurementComponent;
  /** Raw counts the components above were derived from — diagnostic only,
   *  no provenance claim of its own. */
  observedCounts: {
    totalEvents: number;
    usageLikeEvents: number;
    repeatedQuery: number;
    repeatedRange: number;
    forcedResend: number;
    postEditReadback: number;
    distinctCallIds: number;
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isUsageLikeEvent(e: MeasurementInputEvent): e is UsageLikeEvent {
  return typeof (e as { estimatedSavedTokens?: unknown }).estimatedSavedTokens === "number";
}

function isTelemetryEvent(e: MeasurementInputEvent): e is TelemetryEvent {
  return typeof (e as { event?: unknown }).event === "string";
}

function eventNameIs(e: MeasurementInputEvent, name: string): boolean {
  return isTelemetryEvent(e) && e.event === name;
}

function unavailable(basis: string): MeasurementComponent {
  return { tokens: null, cashUsd: null, provenance: { status: "unavailable", basis } };
}

function priced(tokens: number, pricing: MeasurementPricingConfig | undefined): number | null {
  return pricing === undefined ? null : (tokens * pricing.costPerMillionTokensUsd) / 1_000_000;
}

function measured(
  tokens: number,
  basis: string,
  pricing: MeasurementPricingConfig | undefined,
): MeasurementComponent {
  return { tokens, cashUsd: priced(tokens, pricing), provenance: { status: "measured", basis } };
}

function estimated(
  tokens: number,
  basis: string,
  pricing: MeasurementPricingConfig | undefined,
): MeasurementComponent {
  return { tokens, cashUsd: priced(tokens, pricing), provenance: { status: "estimated", basis } };
}

// ---------------------------------------------------------------------------
// Component computation
// ---------------------------------------------------------------------------

function computeDirectContextSaving(
  events: readonly MeasurementInputEvent[],
  pricing: MeasurementPricingConfig | undefined,
): MeasurementComponent {
  const usageLike = events.filter(isUsageLikeEvent);
  if (usageLike.length === 0) {
    return unavailable(
      "no usage-channel events (estimatedSavedTokens) were supplied — this "
      + "component surfaces the already-shipped 0.9.x usage-metrics "
      + "baseline-vs-response delta and has nothing of its own to estimate",
    );
  }
  const tokens = usageLike.reduce((sum, e) => sum + e.estimatedSavedTokens, 0);
  return measured(
    tokens,
    `sum of estimatedSavedTokens across ${usageLike.length} measured usage `
    + "event(s) (0.9.x usage-metrics channel; exact arithmetic, no coefficient)",
    pricing,
  );
}

function computeCountDrivenComponent(
  hitCount: number,
  coefficientPerHit: number,
  coefficientName: keyof MeasurementCoefficients,
  eventNames: readonly string[],
  pricing: MeasurementPricingConfig | undefined,
): MeasurementComponent {
  if (hitCount === 0) {
    return unavailable(
      `none of [${eventNames.join(", ")}] were present in the supplied events`,
    );
  }
  const tokens = hitCount * coefficientPerHit;
  return estimated(
    tokens,
    `${hitCount} [${eventNames.join(", ")}] event(s) x documented default `
    + `${coefficientName}=${coefficientPerHit} tokens/hit (UNFIT — `
    + "DESIGN-v0.10 D-8 paired calibration deferred beyond v0.10.0)",
    pricing,
  );
}

function combineNet(
  parts: {
    direct_context_saving: MeasurementComponent;
    avoided_read_saving: MeasurementComponent;
    avoided_turn_saving: MeasurementComponent;
    tl_overhead: MeasurementComponent;
  },
  pricing: MeasurementPricingConfig | undefined,
): MeasurementComponent {
  const { direct_context_saving, avoided_read_saving, avoided_turn_saving, tl_overhead } = parts;
  const named: ReadonlyArray<[string, MeasurementComponent]> = [
    ["direct_context_saving", direct_context_saving],
    ["avoided_read_saving", avoided_read_saving],
    ["avoided_turn_saving", avoided_turn_saving],
    ["tl_overhead", tl_overhead],
  ];
  const includedNames = named
    .filter(([, c]) => c.provenance.status !== "unavailable")
    .map(([name]) => name);
  if (includedNames.length === 0) {
    return unavailable(
      "direct_context_saving, avoided_read_saving, avoided_turn_saving and "
      + "tl_overhead were all unavailable",
    );
  }
  // additive: direct_context_saving + avoided_read_saving + avoided_turn_saving.
  // tl_overhead is SUBTRACTED. A component that is unavailable contributes 0
  // to this best-effort sum rather than blocking it entirely — the shipped
  // display DoD ("lower layers renderable even when upper layers are
  // unavailable") reads the same way at the engine level: partial evidence
  // beats a blank dash, as long as the status below says "estimated", never
  // "measured", whenever anything was excluded.
  const tokens =
    (direct_context_saving.tokens ?? 0)
    + (avoided_read_saving.tokens ?? 0)
    + (avoided_turn_saving.tokens ?? 0)
    - (tl_overhead.tokens ?? 0);
  const allFourPresent = includedNames.length === 4;
  const allMeasured = named.every(([, c]) => c.provenance.status === "measured");
  const status: ProvenanceStatus = allFourPresent && allMeasured ? "measured" : "estimated";
  const basis = allFourPresent
    ? `sum of direct_context_saving + avoided_read_saving + avoided_turn_saving - tl_overhead (${status})`
    : `best-effort partial sum over ${includedNames.join(" + ")} — the `
      + "remaining component(s) were unavailable and contributed 0, not a "
      + "fabricated estimate";
  // cashUsd stays strictly all-or-nothing: a partial cash total would look
  // like a complete one to a reader who does not check every component.
  const allCashKnown = pricing !== undefined && named.every(([, c]) => c.cashUsd !== null);
  const cashUsd = allCashKnown
    ? (direct_context_saving.cashUsd ?? 0)
      + (avoided_read_saving.cashUsd ?? 0)
      + (avoided_turn_saving.cashUsd ?? 0)
      - (tl_overhead.cashUsd ?? 0)
    : null;
  return { tokens, cashUsd, provenance: { status, basis } };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Decomposes a batch of telemetry/usage events into the plan's four-way
 * measurement split. Pure: identical input always yields an identical
 * (deep-equal) output, and the function never mutates `events`.
 */
export function computeMeasurementDecomposition(
  events: readonly MeasurementInputEvent[],
  config: MeasurementEngineConfig = {},
): MeasurementDecomposition {
  const coefficients: MeasurementCoefficients = {
    ...DEFAULT_COEFFICIENTS,
    ...config.coefficients,
  };
  const pricing = config.pricing;

  const repeatedQuery = events.filter((e) => eventNameIs(e, "repeated_query")).length;
  const repeatedRange = events.filter((e) => eventNameIs(e, "repeated_range")).length;
  const forcedResend = events.filter((e) => eventNameIs(e, "forced_resend")).length;
  const postEditReadback = events.filter((e) => eventNameIs(e, "post_edit_readback")).length;
  const callIds = new Set(
    events
      .filter(isTelemetryEvent)
      .map((e) => e.call_id)
      .filter((id): id is number => typeof id === "number"),
  );

  const direct_context_saving = computeDirectContextSaving(events, pricing);
  const avoided_read_saving = computeCountDrivenComponent(
    repeatedRange + postEditReadback,
    coefficients.avoidedReadTokensPerHit,
    "avoidedReadTokensPerHit",
    ["repeated_range", "post_edit_readback"],
    pricing,
  );
  const avoided_turn_saving = computeCountDrivenComponent(
    repeatedQuery + forcedResend,
    coefficients.avoidedTurnTokensPerHit,
    "avoidedTurnTokensPerHit",
    ["repeated_query", "forced_resend"],
    pricing,
  );
  const tl_overhead = computeCountDrivenComponent(
    callIds.size,
    coefficients.overheadTokensPerCall,
    "overheadTokensPerCall",
    ["call_id-bearing events"],
    pricing,
  );
  const net = combineNet(
    { direct_context_saving, avoided_read_saving, avoided_turn_saving, tl_overhead },
    pricing,
  );

  return {
    direct_context_saving,
    avoided_read_saving,
    avoided_turn_saving,
    tl_overhead,
    net,
    observedCounts: {
      totalEvents: events.length,
      usageLikeEvents: events.filter(isUsageLikeEvent).length,
      repeatedQuery,
      repeatedRange,
      forcedResend,
      postEditReadback,
      distinctCallIds: callIds.size,
    },
  };
}
