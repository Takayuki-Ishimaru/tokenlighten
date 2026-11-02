import { describe, expect, it } from "vitest";
import { estimateUsageCost, normalizeProviderUsage } from "./providerUsage.js";

const RATES = { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 };

describe("normalizeProviderUsage", () => {
  it("anthropic: input excludes the cache, so the total is the sum of its parts", () => {
    const usage = normalizeProviderUsage("anthropic", { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 50, output_tokens: 20 });
    expect(usage).toMatchObject({ uncachedInput: 100, cacheRead: 900, cacheWrite: 50, output: 20, totalInput: 1050 });
    expect(estimateUsageCost(usage, RATES)).toBe(100 * 5 + 900 * 0.5 + 50 * 6.25 + 20 * 25);
  });

  it("openai: input includes the cache, and subtracting it never counts it twice", () => {
    const usage = normalizeProviderUsage("openai", {
      input_tokens: 1000,
      input_tokens_details: { cached_tokens: 900 },
      output_tokens: 20,
      output_tokens_details: { reasoning_tokens: 15 },
    });
    expect(usage).toMatchObject({ uncachedInput: 100, cacheRead: 900, cacheWrite: null, output: 20, reasoningWithinOutput: 15, totalInput: 1000 });
    expect(estimateUsageCost(usage, RATES)).toBe(100 * 5 + 900 * 0.5 + 20 * 25);
  });

  it("reads the chat-completions spellings too", () => {
    expect(normalizeProviderUsage("openai", { prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 4 }, completion_tokens: 2 }))
      .toMatchObject({ uncachedInput: 6, cacheRead: 4, output: 2, totalInput: 10 });
  });

  it("an unreported part is null, not zero, and leaves the cost unknown", () => {
    const noCache = normalizeProviderUsage("anthropic", { input_tokens: 100, output_tokens: 20 });
    expect(noCache).toMatchObject({ cacheRead: null, cacheWrite: null, totalInput: null });
    expect(estimateUsageCost(noCache, RATES)).toBeNull();

    const noDetails = normalizeProviderUsage("openai", { input_tokens: 100, output_tokens: 20 });
    expect(noDetails).toMatchObject({ uncachedInput: null, cacheRead: null, totalInput: 100 });
    expect(estimateUsageCost(noDetails, RATES)).toBeNull();
  });

  it("garbage is unknown, and an unknown price is an unknown cost", () => {
    for (const raw of [undefined, null, "x", [], { input_tokens: -1 }, { input_tokens: 1.5 }, { input_tokens: "3" }]) {
      expect(normalizeProviderUsage("anthropic", raw).uncachedInput).toBeNull();
    }
    const usage = normalizeProviderUsage("anthropic", { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 });
    expect(usage.totalInput).toBe(1);
    expect(estimateUsageCost(usage, undefined)).toBeNull();
  });
});
