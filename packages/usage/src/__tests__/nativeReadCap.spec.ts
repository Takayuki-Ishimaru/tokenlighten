import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TokenLightenUsageEvent } from "@tokenlighten/types";
import {
  NATIVE_BASELINE_MAX_TOKENS_PER_CALL,
  NATIVE_READ_BYTES_PER_TOKEN,
  NATIVE_READ_MAX_BYTES,
  NATIVE_READ_MAX_LINES,
  NATIVE_READ_MAX_TOKENS,
  boundBaselineTokens,
  estimateTokensFromBytes,
  readUsageEvents,
  summarizeUsage,
} from "../index.js";

/**
 * The native-read ceiling on a savings baseline. A field evaluation found TL
 * cost +43% in total while `tl logs summary` printed 457,550 tokens of
 * "context avoided": the baseline assumed a client reads whole files (one 1.59
 * MB source file was worth ~397,000 tokens), which Claude Code never does (at
 * most 2,000 lines per Read, and a refusal above ~25,000 tokens). The MCP
 * server applies the rule per file when it records; these specs pin the half
 * that makes SUMMARIES of already-recorded logs robust.
 */

function event(
  index: number,
  overrides: Partial<TokenLightenUsageEvent> = {},
): TokenLightenUsageEvent {
  return {
    schemaVersion: 2,
    eventId: `evt-${index}`,
    occurredAt: "2026-10-29T00:00:00.000Z",
    workspaceId: "workspace",
    sessionId: "session",
    client: "claude-code",
    tool: "tl_read_file",
    outcome: "ok",
    durationMs: 1,
    responseBytes: 400,
    estimatedResponseTokens: 100,
    baselineTokens: 1_000,
    estimatedSavedTokens: 900,
    baselineMethod: "file-bytes",
    writeEnabled: true,
    taskRef: null,
    ...overrides,
  };
}

describe("native read constants", () => {
  it("state what one native read can return: 2,000 lines, 25,000 tokens, 100,000 bytes", () => {
    expect(NATIVE_READ_MAX_LINES).toBe(2_000);
    expect(NATIVE_READ_MAX_TOKENS).toBe(25_000);
    expect(NATIVE_READ_BYTES_PER_TOKEN).toBe(4);
    expect(NATIVE_READ_MAX_BYTES).toBe(100_000);
    // The byte limit is the token limit in the unit every baseline is measured in.
    expect(estimateTokensFromBytes(NATIVE_READ_MAX_BYTES)).toBe(NATIVE_READ_MAX_TOKENS);
    expect(NATIVE_BASELINE_MAX_TOKENS_PER_CALL).toBe(NATIVE_READ_MAX_TOKENS);
  });

  it("boundBaselineTokens lowers only what is above the window", () => {
    expect(boundBaselineTokens(397_000)).toBe(25_000);
    expect(boundBaselineTokens(25_001)).toBe(25_000);
    expect(boundBaselineTokens(25_000)).toBe(25_000);
    expect(boundBaselineTokens(1_000)).toBe(1_000);
    expect(boundBaselineTokens(0)).toBe(0);
  });
});

describe("summarizeUsage: a recorded baseline above one native read is bounded", () => {
  it("clamps an old whole-file event (a 1.59 MB file, ~397,000 tokens) to one native read", () => {
    // schemaVersion 1 line as v0.16.4 and earlier wrote it: no taskRef, the
    // whole-file size as the baseline, and the saving that implies.
    const old = event(0, {
      schemaVersion: 1,
      baselineTokens: 397_000,
      estimatedSavedTokens: 396_900,
    });
    delete (old as { taskRef?: unknown }).taskRef;
    const summary = summarizeUsage([old]);
    expect(summary.measuredBaselineTokens).toBe(25_000);
    expect(summary.measuredBaselineBytes).toBe(100_000);
    expect(summary.estimatedSavedTokens).toBe(25_000 - 100);
    expect(summary.estimatedTokenReductionPercent).toBeCloseTo(((25_000 - 100) / 25_000) * 100);
    expect(summary.baselineCap).toEqual({
      maxTokensPerCall: 25_000,
      maxLinesPerFile: 2_000,
      clampedCalls: 1,
      clampedTokens: 397_000 - 25_000,
    });
    // Unchanged vocabulary: it is still a baseline-bearing whole-file call.
    expect(summary.baselineBasis).toBe("native-read-estimate");
    expect(summary.measuredBaselineCalls).toBe(1);
    expect(summary.measuredBaselineCallsByMethod).toEqual({ "file-bytes": 1, "range-bytes": 0 });
  });

  it("bounds the field report's total: many whole-file events no longer sum to ~457,000", () => {
    const events = [397_000, 30_000, 20_550, 10_000].map((tokens, index) =>
      event(index, { baselineTokens: tokens, estimatedSavedTokens: tokens - 100 }));
    const stored = events.reduce((sum, e) => sum + e.estimatedSavedTokens!, 0);
    expect(stored).toBe(457_550 - 400);
    const summary = summarizeUsage(events);
    // 25,000 + 25,000 + 20,550 + 10,000 baseline, 400 response tokens.
    expect(summary.measuredBaselineTokens).toBe(80_550);
    expect(summary.estimatedSavedTokens).toBe(80_550 - 400);
    expect(summary.baselineCap).toMatchObject({ clampedCalls: 2, clampedTokens: 372_000 + 5_000 });
  });

  it("leaves a small file unchanged and counts nothing as clamped", () => {
    const summary = summarizeUsage([
      event(0),
      event(1, { baselineTokens: 25_000, estimatedSavedTokens: 24_900 }),
      event(2, { baselineTokens: 0, estimatedSavedTokens: -100 }),
      event(3, { baselineTokens: 40, estimatedSavedTokens: -60, baselineMethod: "range-bytes" }),
    ]);
    expect(summary.measuredBaselineTokens).toBe(1_000 + 25_000 + 0 + 40);
    expect(summary.estimatedSavedTokens).toBe(summary.measuredBaselineTokens - 400);
    expect(summary.baselineCap).toMatchObject({ clampedCalls: 0, clampedTokens: 0 });
    expect(summary.baselineCap!.maxTokensPerCall).toBe(NATIVE_READ_MAX_TOKENS);
  });

  it("bounds one token over the window by exactly that token", () => {
    const summary = summarizeUsage([event(0, { baselineTokens: 25_001 })]);
    expect(summary.measuredBaselineTokens).toBe(25_000);
    expect(summary.baselineCap).toMatchObject({ clampedCalls: 1, clampedTokens: 1 });
  });

  it("computes the saving from the bounded baseline, not from the stored estimatedSavedTokens", () => {
    // The stored delta (what an old recorder wrote) is ignored by the summary.
    const summary = summarizeUsage([
      event(0, { baselineTokens: 100_000, estimatedSavedTokens: 99_900 }),
    ]);
    expect(summary.estimatedSavedTokens).toBe(24_900);
  });

  it("bounds a range-bytes event too (a ranged read is one window as well)", () => {
    const summary = summarizeUsage([
      event(0, { baselineTokens: 60_000, estimatedSavedTokens: 59_900, baselineMethod: "range-bytes" }),
    ]);
    expect(summary.measuredBaselineTokens).toBe(25_000);
    expect(summary.measuredBaselineCallsByMethod).toEqual({ "file-bytes": 0, "range-bytes": 1 });
  });

  it("does not look at failed calls or calls with no baseline", () => {
    const summary = summarizeUsage([
      event(0, { outcome: "error", baselineTokens: 397_000, estimatedSavedTokens: 396_900 }),
      event(1, { baselineTokens: null, estimatedSavedTokens: null, baselineMethod: null }),
    ]);
    expect(summary.measuredBaselineCalls).toBe(0);
    expect(summary.measuredBaselineTokens).toBe(0);
    expect(summary.baselineCap).toMatchObject({ clampedCalls: 0, clampedTokens: 0 });
  });

  it("bounds each call of a task group, so a task cannot add up to whole files either", () => {
    const summary = summarizeUsage([
      event(0, { taskRef: "task-a", baselineTokens: null, estimatedSavedTokens: null, baselineMethod: null }),
      event(1, { taskRef: "task-a", baselineTokens: 300_000, estimatedSavedTokens: 299_900 }),
      event(2, { taskRef: "task-a", baselineTokens: 200_000, estimatedSavedTokens: 199_900 }),
    ]);
    // Three responses of 100 tokens against two bounded baselines.
    expect(summary.measuredBaselineTokens).toBe(50_000);
    expect(summary.measuredResponseTokens).toBe(300);
    expect(summary.estimatedSavedTokens).toBe(50_000 - 300);
  });
});

describe("summarizeUsage: a net-negative log never reports a positive saving", () => {
  it("sums the signed per-call deltas: TL returning more than the bounded baseline subtracts", () => {
    const summary = summarizeUsage([
      // 100 - 5,000
      event(0, { baselineTokens: 100, estimatedResponseTokens: 5_000, estimatedSavedTokens: -4_900 }),
      // A 397,000-token baseline is bounded to 25,000, then 30,000 of response.
      event(1, { baselineTokens: 397_000, estimatedResponseTokens: 30_000, estimatedSavedTokens: 367_000 }),
    ]);
    expect(summary.estimatedSavedTokens).toBe(-9_900);
    expect(summary.estimatedSavedTokens).toBeLessThan(0);
    expect(summary.estimatedTokenReductionPercent).toBeLessThan(0);
  });

  it("charges the unbaselined calls of a task to its saving instead of dropping them", () => {
    const summary = summarizeUsage([
      event(0, { taskRef: "t", baselineTokens: null, estimatedResponseTokens: 20_000, estimatedSavedTokens: null, baselineMethod: null }),
      event(1, { taskRef: "t", baselineTokens: 397_000, estimatedResponseTokens: 20_000, estimatedSavedTokens: 377_000 }),
    ]);
    // 25,000 (bounded) - 40,000 (the whole task's TL responses).
    expect(summary.estimatedSavedTokens).toBe(-15_000);
  });

  it("subtracts a loss group from a gain group instead of flooring it at zero", () => {
    const summary = summarizeUsage([
      event(0, { taskRef: "gain", baselineTokens: 20_000, estimatedResponseTokens: 1_000, estimatedSavedTokens: 19_000 }),
      event(1, { taskRef: "loss", baselineTokens: 500, estimatedResponseTokens: 30_000, estimatedSavedTokens: -29_500 }),
    ]);
    expect(summary.estimatedSavedTokens).toBe(19_000 - 29_500);
    expect(summary.estimatedSavedTokens).toBeLessThan(0);
  });
});

describe("summarizeUsage over logs read from disk (schemaVersion 1 and 2 stay readable)", () => {
  function logOf(lines: unknown[]): string {
    const directory = join(tmpdir(), `tokenlighten-native-cap-${randomUUID()}`);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "usage-2026-10-29.ndjson"),
      `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    );
    return directory;
  }

  it("reads old lines unchanged and bounds them only when summarizing", () => {
    const v1 = event(0, { schemaVersion: 1, baselineTokens: 397_000, estimatedSavedTokens: 396_900 });
    delete (v1 as { taskRef?: unknown }).taskRef;
    const v2 = event(1, { baselineTokens: 120_000, estimatedSavedTokens: 119_900 });
    const events = readUsageEvents(logOf([v1, v2]));

    // The reader is untouched: the recorded values come back as written.
    expect(events.map((e) => e.baselineTokens)).toEqual([397_000, 120_000]);
    expect(events.map((e) => e.estimatedSavedTokens)).toEqual([396_900, 119_900]);
    expect(events.map((e) => e.schemaVersion)).toEqual([1, 2]);

    const summary = summarizeUsage(events);
    expect(summary.measuredBaselineTokens).toBe(50_000);
    expect(summary.estimatedSavedTokens).toBe(50_000 - 200);
    expect(summary.baselineCap).toMatchObject({
      clampedCalls: 2,
      clampedTokens: (397_000 - 25_000) + (120_000 - 25_000),
    });
  });
});
