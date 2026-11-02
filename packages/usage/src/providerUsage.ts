// B5: a provider's usage block in one shape, so cached input is neither double
// counted nor assumed. The two families define "input" differently: Anthropic's
// `input_tokens` EXCLUDES cache reads and writes, and OpenAI's `input_tokens`
// (`prompt_tokens`) INCLUDES `cached_tokens`. A count the provider did not report is
// `null`, never 0. These are request-level figures: they say nothing about which
// part of a request came from TokenLighten.

export type UsageProviderFamily = "anthropic" | "openai";

export interface NormalizedProviderUsage {
  family: UsageProviderFamily;
  /** Input billed at the base rate. */
  uncachedInput: number | null;
  cacheRead: number | null;
  /** `null` where the provider has no such charge reported. */
  cacheWrite: number | null;
  output: number | null;
  /** Already inside `output`, per both families' definitions: never add it again. */
  reasoningWithinOutput: number | null;
  /** uncachedInput + cacheRead + cacheWrite; `null` unless every reported part is known. */
  totalInput: number | null;
}

export interface UsageRates {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function normalizeProviderUsage(family: UsageProviderFamily, raw: unknown): NormalizedProviderUsage {
  const usage = record(raw);
  if (family === "anthropic") {
    const uncachedInput = count(usage["input_tokens"]);
    const cacheRead = count(usage["cache_read_input_tokens"]);
    const cacheWrite = count(usage["cache_creation_input_tokens"]);
    return {
      family,
      uncachedInput,
      cacheRead,
      cacheWrite,
      output: count(usage["output_tokens"]),
      reasoningWithinOutput: null,
      totalInput: uncachedInput === null || cacheRead === null || cacheWrite === null ? null : uncachedInput + cacheRead + cacheWrite,
    };
  }
  const totalInput = count(usage["input_tokens"] ?? usage["prompt_tokens"]);
  const inputDetails = record(usage["input_tokens_details"] ?? usage["prompt_tokens_details"]);
  const outputDetails = record(usage["output_tokens_details"] ?? usage["completion_tokens_details"]);
  const cacheRead = count(inputDetails["cached_tokens"]);
  return {
    family,
    uncachedInput: totalInput === null || cacheRead === null ? null : Math.max(0, totalInput - cacheRead),
    cacheRead,
    cacheWrite: null,
    output: count(usage["output_tokens"] ?? usage["completion_tokens"]),
    reasoningWithinOutput: count(outputDetails["reasoning_tokens"]),
    totalInput,
  };
}

/**
 * Cost in the rates' unit, or `null` when any figure needed is missing: an unknown
 * part is not a free part. A family with no reported write charge is priced without
 * one, because `cacheWrite` is `null` by definition there and not by omission.
 */
export function estimateUsageCost(usage: NormalizedProviderUsage, rates: UsageRates | undefined): number | null {
  if (rates === undefined || usage.uncachedInput === null || usage.cacheRead === null || usage.output === null) return null;
  if (usage.family === "anthropic" && usage.cacheWrite === null) return null;
  return usage.uncachedInput * rates.input
    + usage.cacheRead * rates.cacheRead
    + (usage.cacheWrite ?? 0) * rates.cacheWrite
    + usage.output * rates.output;
}
