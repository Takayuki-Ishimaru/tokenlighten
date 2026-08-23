/**
 * pricingSnapshots.ts — V11-08 Attribution & Calibration v2.
 *
 * Versioned, dated pricing snapshot table with billing mode
 * ("api" | "credits" | "subscription") kept separate — the V10-02 rule this
 * workstream extends: "API-equivalent cost、provider credit avoided、
 * marginal cash chargeを分離し、定額利用を現金削減と断定しない" (never assert
 * flat-rate/subscription usage as a cash saving). Every billing estimate
 * this module produces carries a `priceAsOf` date and a `billingMode`; an
 * unknown model produces NO estimate — `{status:"unavailable",
 * reason:"unknown-model"}` — never a substituted price from another model.
 *
 * SEEDING (task brief: "Do not invent current prices: seed the table from
 * whatever pricing data already exists in the repo"): `PRODUCTION_PRICING_
 * SNAPSHOTS` below is copied verbatim (same regex patterns, same per-million
 * rates) from index.ts's existing `MODEL_PRICES` array and its
 * `AUTOMATIC_PRICING.byClient` reference rates — both introduced together in
 * commit ad228e80 (2026-08-10), which is why every seeded entry's
 * `priceAsOf` is "2026-08-10", matching `AUTOMATIC_PRICING.asOf` exactly. No
 * repo-wide search turned up any "credits" or "subscription" mode pricing
 * data anywhere (DESIGN files, source, or docs), so the production table
 * carries ONLY "api"-mode entries; "credits" and "subscription" snapshots
 * stay structurally supported by the types below but genuinely empty —
 * unavailable-by-default is correct there, per the task brief's fallback
 * instruction, rather than fabricated.
 *
 * index.ts's own `MODEL_PRICES`/`modelPrice()` remain unchanged and
 * unreplaced — they keep backing the existing `summarizeUsage()` /
 * `sessionModelUsage()` path. This module is an ADDITIVE, independent
 * consumer of the same underlying numbers for the richer V11-08 pipeline
 * (parsers/ → sessionMatcher.ts → coefficientStore.ts → here), not a
 * refactor of the existing one.
 */

export type BillingMode = "api" | "credits" | "subscription";

export interface PricingSnapshotModelEntry {
  readonly pattern: RegExp;
  readonly label: string;
  readonly inputUsdPerMillion: number;
  /** Null when this billing mode/client genuinely has no cache-write
   *  category (never a fabricated 0 standing in for "not applicable"). */
  readonly cacheWriteUsdPerMillion: number | null;
  readonly cacheReadUsdPerMillion: number;
  readonly outputUsdPerMillion: number;
}

export interface PricingSnapshot {
  readonly snapshotId: string;
  readonly asOf: string;
  readonly billingMode: BillingMode;
  /** Where these numbers came from — always non-empty, always traceable. */
  readonly provenance: string;
  readonly entries: readonly PricingSnapshotModelEntry[];
}

// ---------------------------------------------------------------------------
// Production table — seeded verbatim from packages/usage/src/index.ts
// ---------------------------------------------------------------------------

const SEEDED_FROM_INDEX_TS =
  "seeded verbatim from @tokenlighten/usage/src/index.ts MODEL_PRICES "
  + "(commit ad228e80, 2026-08-10) — API-equivalent reference rates, not an "
  + "actual subscription or credits charge";

export const PRODUCTION_API_PRICING_SNAPSHOT: PricingSnapshot = {
  snapshotId: "api-reference-2026-08-10",
  asOf: "2026-08-10",
  billingMode: "api",
  provenance: SEEDED_FROM_INDEX_TS,
  entries: [
    { pattern: /^gpt-5\.6-sol(?:$|-)/i, label: "GPT-5.6 Sol", inputUsdPerMillion: 5, cacheWriteUsdPerMillion: 6.25, cacheReadUsdPerMillion: 0.5, outputUsdPerMillion: 30 },
    { pattern: /^gpt-5\.6-terra(?:$|-)/i, label: "GPT-5.6 Terra", inputUsdPerMillion: 2, cacheWriteUsdPerMillion: 2.5, cacheReadUsdPerMillion: 0.2, outputUsdPerMillion: 12 },
    { pattern: /^gpt-5\.6-luna(?:$|-)/i, label: "GPT-5.6 Luna", inputUsdPerMillion: 0.2, cacheWriteUsdPerMillion: 0.25, cacheReadUsdPerMillion: 0.02, outputUsdPerMillion: 1.2 },
    { pattern: /^gpt-5\.5(?:$|-)/i, label: "GPT-5.5", inputUsdPerMillion: 5, cacheWriteUsdPerMillion: 5, cacheReadUsdPerMillion: 0.5, outputUsdPerMillion: 30 },
    { pattern: /^gpt-5\.4(?:$|-)/i, label: "GPT-5.4", inputUsdPerMillion: 2.5, cacheWriteUsdPerMillion: 2.5, cacheReadUsdPerMillion: 0.25, outputUsdPerMillion: 15 },
    { pattern: /^gpt-5\.3-codex(?:$|-)/i, label: "GPT-5.3 Codex", inputUsdPerMillion: 1.75, cacheWriteUsdPerMillion: 1.75, cacheReadUsdPerMillion: 0.175, outputUsdPerMillion: 14 },
    { pattern: /^claude-fable-5(?:$|-)/i, label: "Claude Fable 5", inputUsdPerMillion: 10, cacheWriteUsdPerMillion: 12.5, cacheReadUsdPerMillion: 1, outputUsdPerMillion: 50 },
    { pattern: /^claude-opus-5(?:$|-)/i, label: "Claude Opus 5", inputUsdPerMillion: 5, cacheWriteUsdPerMillion: 6.25, cacheReadUsdPerMillion: 0.5, outputUsdPerMillion: 25 },
    // Sonnet 5 introductory pricing is valid through 2026-08-31 (same caveat
    // as index.ts's MODEL_PRICES comment — this snapshot inherits it as-is).
    { pattern: /^claude-sonnet-5(?:$|-)/i, label: "Claude Sonnet 5", inputUsdPerMillion: 2, cacheWriteUsdPerMillion: 2.5, cacheReadUsdPerMillion: 0.2, outputUsdPerMillion: 10 },
    { pattern: /^claude-haiku-4-5(?:$|-)/i, label: "Claude Haiku 4.5", inputUsdPerMillion: 1, cacheWriteUsdPerMillion: 1.25, cacheReadUsdPerMillion: 0.1, outputUsdPerMillion: 5 },
    { pattern: /^claude-opus-4-(?:8|7|6|5)(?:$|-)/i, label: "Claude Opus 4.5-4.8", inputUsdPerMillion: 5, cacheWriteUsdPerMillion: 6.25, cacheReadUsdPerMillion: 0.5, outputUsdPerMillion: 25 },
    { pattern: /^claude-opus-4-1(?:$|-)/i, label: "Claude Opus 4.1", inputUsdPerMillion: 15, cacheWriteUsdPerMillion: 18.75, cacheReadUsdPerMillion: 1.5, outputUsdPerMillion: 75 },
    { pattern: /^claude-sonnet-4(?:$|-)/i, label: "Claude Sonnet 4", inputUsdPerMillion: 3, cacheWriteUsdPerMillion: 3.75, cacheReadUsdPerMillion: 0.3, outputUsdPerMillion: 15 },
    { pattern: /^claude-3-5-haiku(?:$|-)/i, label: "Claude 3.5 Haiku", inputUsdPerMillion: 0.8, cacheWriteUsdPerMillion: 1, cacheReadUsdPerMillion: 0.08, outputUsdPerMillion: 4 },
  ],
};

/** No "credits"-mode pricing data exists anywhere in this repo — see this
 *  file's header doc. Structurally present, genuinely empty:
 *  unavailable-by-default is the correct posture, not a fabricated table. */
export const PRODUCTION_CREDITS_PRICING_SNAPSHOTS: readonly PricingSnapshot[] = [];

/** No "subscription"-mode unit pricing exists anywhere in this repo either —
 *  a subscription's marginal per-token cash cost is not a number this repo
 *  has ever recorded (correctly: it is usually $0 marginal, which is exactly
 *  the "never claim flat-rate usage as cash savings" case V10-02 warns
 *  about). Structurally present, genuinely empty. */
export const PRODUCTION_SUBSCRIPTION_PRICING_SNAPSHOTS: readonly PricingSnapshot[] = [];

export const PRODUCTION_PRICING_SNAPSHOTS: readonly PricingSnapshot[] = [
  PRODUCTION_API_PRICING_SNAPSHOT,
  ...PRODUCTION_CREDITS_PRICING_SNAPSHOTS,
  ...PRODUCTION_SUBSCRIPTION_PRICING_SNAPSHOTS,
];

// ---------------------------------------------------------------------------
// Test-only fixture snapshot (task brief: "ship a clearly-labeled fixture
// snapshot used only by tests" — kept independent of production data so
// specs never depend on real pricing numbers drifting or getting re-seeded).
// ---------------------------------------------------------------------------

/**
 * NOT real pricing. Model ids are deliberately fictional
 * ("test-model-alpha"/"test-model-beta") so they can never collide with a
 * real model id and never accidentally get exercised outside this package's
 * own tests. Do not import this into production code paths.
 */
export const TEST_FIXTURE_PRICING_SNAPSHOT: PricingSnapshot = {
  snapshotId: "test-fixture-v1",
  asOf: "2026-01-01",
  billingMode: "api",
  provenance: "synthetic fixture for pricingSnapshots.spec.ts only — not real pricing",
  entries: [
    {
      pattern: /^test-model-alpha(?:$|-)/i,
      label: "Test Model Alpha",
      inputUsdPerMillion: 1,
      cacheWriteUsdPerMillion: 1.25,
      cacheReadUsdPerMillion: 0.1,
      outputUsdPerMillion: 5,
    },
    {
      pattern: /^test-model-beta(?:$|-)/i,
      label: "Test Model Beta (no cache-write category)",
      inputUsdPerMillion: 2,
      cacheWriteUsdPerMillion: null,
      cacheReadUsdPerMillion: 0.2,
      outputUsdPerMillion: 8,
    },
  ],
};

// ---------------------------------------------------------------------------
// Billing estimation
// ---------------------------------------------------------------------------

export interface BillingUsage {
  readonly model: string;
  readonly inputTokens: number;
  readonly cacheWriteTokens: number;
  readonly cacheReadTokens: number;
  readonly outputTokens: number;
}

export interface BillingEstimateBreakdown {
  readonly inputUsd: number;
  readonly cacheWriteUsd: number | null;
  readonly cacheReadUsd: number;
  readonly outputUsd: number;
}

export type BillingEstimateResult =
  | {
      readonly status: "estimated";
      readonly model: string;
      readonly billingMode: BillingMode;
      readonly priceAsOf: string;
      readonly snapshotId: string;
      readonly costUsd: number;
      readonly breakdown: BillingEstimateBreakdown;
    }
  | {
      readonly status: "unavailable";
      readonly reason: "unknown-model";
      readonly model: string;
      readonly basis: string;
    };

/**
 * Prices `usage` against exactly ONE snapshot. An unmatched model NEVER
 * falls back to another entry's price — it is `status:"unavailable",
 * reason:"unknown-model"`, full stop. Pure, deterministic.
 */
export function estimateBilling(
  snapshot: PricingSnapshot,
  usage: BillingUsage,
): BillingEstimateResult {
  const entry = snapshot.entries.find((e) => e.pattern.test(usage.model));
  if (!entry) {
    return {
      status: "unavailable",
      reason: "unknown-model",
      model: usage.model,
      basis: `no pricing entry in snapshot "${snapshot.snapshotId}" matches `
        + `model "${usage.model}" — never substituting another model's price`,
    };
  }
  const inputUsd = (usage.inputTokens * entry.inputUsdPerMillion) / 1_000_000;
  const cacheWriteUsd = entry.cacheWriteUsdPerMillion === null
    ? null
    : (usage.cacheWriteTokens * entry.cacheWriteUsdPerMillion) / 1_000_000;
  const cacheReadUsd = (usage.cacheReadTokens * entry.cacheReadUsdPerMillion) / 1_000_000;
  const outputUsd = (usage.outputTokens * entry.outputUsdPerMillion) / 1_000_000;
  const costUsd = inputUsd + (cacheWriteUsd ?? 0) + cacheReadUsd + outputUsd;
  return {
    status: "estimated",
    model: usage.model,
    billingMode: snapshot.billingMode,
    priceAsOf: snapshot.asOf,
    snapshotId: snapshot.snapshotId,
    costUsd,
    breakdown: { inputUsd, cacheWriteUsd, cacheReadUsd, outputUsd },
  };
}

/**
 * Tries a list of snapshots IN ORDER, returning the first estimate whose
 * model matches. Useful when a caller wants to check "api" first and fall
 * back to a "credits"/"subscription" snapshot if one is ever seeded — never
 * mixes rates FROM two snapshots into one estimate (each result's
 * billingMode/priceAsOf/snapshotId trace to exactly one snapshot).
 */
export function estimateBillingAcrossSnapshots(
  snapshots: readonly PricingSnapshot[],
  usage: BillingUsage,
): BillingEstimateResult {
  for (const snapshot of snapshots) {
    const result = estimateBilling(snapshot, usage);
    if (result.status === "estimated") return result;
  }
  return {
    status: "unavailable",
    reason: "unknown-model",
    model: usage.model,
    basis: snapshots.length === 0
      ? "no pricing snapshot was supplied"
      : `model "${usage.model}" matched none of ${snapshots.length} pricing snapshot(s)`,
  };
}
