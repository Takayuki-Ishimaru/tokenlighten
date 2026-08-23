import { describe, expect, it } from "vitest";
import {
  estimateBilling,
  estimateBillingAcrossSnapshots,
  PRODUCTION_API_PRICING_SNAPSHOT,
  PRODUCTION_CREDITS_PRICING_SNAPSHOTS,
  PRODUCTION_PRICING_SNAPSHOTS,
  PRODUCTION_SUBSCRIPTION_PRICING_SNAPSHOTS,
  TEST_FIXTURE_PRICING_SNAPSHOT,
} from "../pricingSnapshots.js";

describe("PRODUCTION_API_PRICING_SNAPSHOT — seeded from in-repo data", () => {
  it("carries a priceAsOf date and billingMode on the snapshot itself", () => {
    expect(PRODUCTION_API_PRICING_SNAPSHOT.billingMode).toBe("api");
    expect(PRODUCTION_API_PRICING_SNAPSHOT.asOf).toBe("2026-08-10");
    expect(PRODUCTION_API_PRICING_SNAPSHOT.provenance.length).toBeGreaterThan(0);
  });

  it("has no seeded credits/subscription entries — unavailable-by-default, not fabricated", () => {
    expect(PRODUCTION_CREDITS_PRICING_SNAPSHOTS).toEqual([]);
    expect(PRODUCTION_SUBSCRIPTION_PRICING_SNAPSHOTS).toEqual([]);
    expect(PRODUCTION_PRICING_SNAPSHOTS).toEqual([PRODUCTION_API_PRICING_SNAPSHOT]);
  });

  it("prices a known model using the seeded rates", () => {
    const result = estimateBilling(PRODUCTION_API_PRICING_SNAPSHOT, {
      model: "claude-sonnet-5-20260810",
      inputTokens: 1_000_000,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
    });
    expect(result.status).toBe("estimated");
    if (result.status === "estimated") {
      expect(result.costUsd).toBeCloseTo(2, 10); // $2 / M input tokens
      expect(result.billingMode).toBe("api");
      expect(result.priceAsOf).toBe("2026-08-10");
      expect(result.snapshotId).toBe(PRODUCTION_API_PRICING_SNAPSHOT.snapshotId);
    }
  });
});

describe("estimateBilling — unknown model never substitutes another model's price", () => {
  it("returns unavailable/unknown-model for an unrecognized id", () => {
    const result = estimateBilling(PRODUCTION_API_PRICING_SNAPSHOT, {
      model: "totally-made-up-model-9000",
      inputTokens: 1000,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
    });
    expect(result).toEqual({
      status: "unavailable",
      reason: "unknown-model",
      model: "totally-made-up-model-9000",
      basis: expect.stringContaining("totally-made-up-model-9000"),
    });
  });

  it("every entry's pattern is anchored (^) so a substring never accidentally matches a different model family", () => {
    for (const entry of PRODUCTION_API_PRICING_SNAPSHOT.entries) {
      expect(entry.pattern.source.startsWith("^")).toBe(true);
    }
  });
});

describe("TEST_FIXTURE_PRICING_SNAPSHOT", () => {
  it("is clearly separate from production data and never collides with a real model id", () => {
    expect(TEST_FIXTURE_PRICING_SNAPSHOT.snapshotId).not.toBe(PRODUCTION_API_PRICING_SNAPSHOT.snapshotId);
    const fixtureModelIds = ["test-model-alpha", "test-model-beta"];
    for (const modelId of fixtureModelIds) {
      // A fixture model id never matches a PRODUCTION pattern...
      expect(PRODUCTION_API_PRICING_SNAPSHOT.entries.some((e) => e.pattern.test(modelId))).toBe(false);
    }
    const realModelIds = ["claude-sonnet-5-20260810", "gpt-5.6-terra-preview"];
    for (const modelId of realModelIds) {
      // ...and a real model id never matches a FIXTURE pattern.
      expect(TEST_FIXTURE_PRICING_SNAPSHOT.entries.some((e) => e.pattern.test(modelId))).toBe(false);
    }
  });

  it("prices a model whose cache-write category is null (not applicable) without fabricating a number", () => {
    const result = estimateBilling(TEST_FIXTURE_PRICING_SNAPSHOT, {
      model: "test-model-beta",
      inputTokens: 1_000_000,
      cacheWriteTokens: 500,
      cacheReadTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(result.status).toBe("estimated");
    if (result.status === "estimated") {
      expect(result.breakdown.cacheWriteUsd).toBeNull();
      // costUsd still sums the categories that DO apply.
      expect(result.costUsd).toBeCloseTo(2 + 0.2 + 8, 10);
    }
  });
});

describe("estimateBillingAcrossSnapshots", () => {
  it("returns the first snapshot's estimate that matches the model", () => {
    const result = estimateBillingAcrossSnapshots(
      [TEST_FIXTURE_PRICING_SNAPSHOT, PRODUCTION_API_PRICING_SNAPSHOT],
      { model: "claude-sonnet-5-20260810", inputTokens: 1_000_000, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 },
    );
    expect(result.status).toBe("estimated");
    if (result.status === "estimated") {
      expect(result.snapshotId).toBe(PRODUCTION_API_PRICING_SNAPSHOT.snapshotId);
    }
  });

  it("is unavailable/unknown-model when the model matches none of the supplied snapshots", () => {
    const result = estimateBillingAcrossSnapshots(
      [TEST_FIXTURE_PRICING_SNAPSHOT, PRODUCTION_API_PRICING_SNAPSHOT],
      { model: "nope", inputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 },
    );
    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") expect(result.reason).toBe("unknown-model");
  });

  it("is unavailable/unknown-model when no snapshot is supplied at all", () => {
    const result = estimateBillingAcrossSnapshots([], {
      model: "claude-sonnet-5-20260810",
      inputTokens: 1,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
    });
    expect(result.status).toBe("unavailable");
  });
});
