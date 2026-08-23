// ---------------------------------------------------------------------------
// v0.10 internal domain model — wire codec decisions and measured/estimated
// contribution (savings) reporting.
//
// SOURCE: DESIGN-v0.10-expansion-plan-v1.3.md §4.3 "共通データモデル",
// "EncodingDecision" / "ContributionEstimate" (lines 651-683).
//
// THIS IS THE INTERNAL DOMAIN MODEL, NOT THE WIRE PROTOCOL (D-1). See
// `./evidence.ts`'s file header for the shared internal/wire boundary note;
// this module imports nothing from `../mcp/*`.
//
// `ContributionEstimate` backs the measured/estimated/analytic-fallback/
// unavailable split the plan's usage-metrics acceptance criteria require
// (受入基準: "measured、estimated、analytic fallback、unavailableを型で分け
// る" — "separate measured, estimated, analytic-fallback, and unavailable by
// type"; "negative savingを0へ丸めない" — "never round a negative saving to
// 0"). This type does not itself compute anything — it is the shape a future
// telemetry reducer fills in.
// ---------------------------------------------------------------------------

/**
 * §4.3 "EncodingDecision". One wire-codec choice for one response body, and
 * the byte/token accounting that justified it. The rc.1 adaptive wire codec
 * shadow (reconciliation §4) is the first intended consumer; this package
 * only declares the shape.
 */
export type EncodingDecision = {
  codec: "json" | "tl-table-1" | "toon-4.1" | "tl-raw-1";
  semanticPayloadHash: string;
  jsonBytes: number;
  encodedBytes: number;
  jsonTokens?: number;
  encodedTokens?: number;
  /** Emitted iff the chosen `codec` is a fallback FROM a non-`"json"` preference; absence means the preferred codec was used. */
  fallbackReason?: string;
};

/**
 * §4.3 "ContributionEstimate". One layer's measured-or-estimated savings
 * claim, always carrying its own confidence and method rather than a bare
 * percentage. `observed`/`counterfactual`/`saved`/`reductionPercent` are
 * `number | null` throughout: `null` means NOT COMPUTABLE for this layer,
 * which is a different fact from a computed `0`.
 */
export type ContributionEstimate = {
  layer: "wire" | "context" | "session" | "billing" | "verified-task";
  status: "measured" | "estimated" | "unavailable";
  confidence: "high" | "medium" | "low" | "unavailable";
  method: string;
  observed: number | null;
  counterfactual: number | null;
  saved: number | null;
  reductionPercent: number | null;
  /** Emitted iff `status === "measured"` with enough samples to bound an interval. */
  interval95?: { low: number; high: number };
  sampleCount?: number;
  calibrationVersion?: string;
  priceAsOf?: string;
  warnings: string[];
};
