import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TokenLightenUsageEvent } from "@tokenlighten/types";
import {
  createUsageRecorder,
  readUsageEvents,
  summarizeUsage,
} from "../index.js";

/**
 * v0.16.4: a ranged/symbol read's baseline is its range, not the whole file
 * (the mcp-server measures that), and the event says so with
 * `baselineMethod: "range-bytes"`. These specs pin the usage package's half:
 * the recorder persists the label, the reader accepts it (and nothing else),
 * and the summary labels the number an estimate and counts calls per method.
 */

const originalNodeEnv = process.env["NODE_ENV"];
afterEach(() => {
  if (originalNodeEnv === undefined) delete process.env["NODE_ENV"];
  else process.env["NODE_ENV"] = originalNodeEnv;
});

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

function recordWith(
  observation: Parameters<ReturnType<typeof createUsageRecorder>["record"]>[0],
): { directory: string; events: TokenLightenUsageEvent[] } {
  const directory = join(tmpdir(), `tokenlighten-baseline-method-${randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  process.env["NODE_ENV"] = "development";
  createUsageRecorder({
    workspaceRoot: "/secret/customer/repository",
    client: "claude-code",
    directory,
    sessionId: "session",
  }).record(observation);
  return { directory, events: readUsageEvents(directory) };
}

describe("baselineMethod persistence", () => {
  it("persists range-bytes and reads it back", () => {
    const { events } = recordWith({
      tool: "tl_read_file",
      outcome: "ok",
      durationMs: 3,
      responseBytes: 400,
      baselineTokens: 90,
      baselineMethod: "range-bytes",
      writeEnabled: false,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      baselineTokens: 90,
      estimatedResponseTokens: 100,
      estimatedSavedTokens: -10,
      baselineMethod: "range-bytes",
    });
  });

  it("defaults a baseline with no method to file-bytes and keeps a null baseline null", () => {
    const withBaseline = recordWith({
      tool: "tl_read_file",
      outcome: "ok",
      durationMs: 3,
      responseBytes: 400,
      baselineTokens: 500,
      writeEnabled: false,
    });
    expect(withBaseline.events[0]).toMatchObject({ baselineTokens: 500, baselineMethod: "file-bytes" });

    const without = recordWith({
      tool: "tl_read_file",
      outcome: "ok",
      durationMs: 3,
      responseBytes: 400,
      baselineTokens: null,
      baselineMethod: null,
      writeEnabled: false,
    });
    expect(without.events[0]).toMatchObject({ baselineTokens: null, baselineMethod: null });
  });

  it("reads old file-bytes lines and drops a line naming an unknown method", () => {
    const { directory } = recordWith({
      tool: "tl_read_file",
      outcome: "ok",
      durationMs: 1,
      responseBytes: 4,
      baselineTokens: 1,
      baselineMethod: "file-bytes",
      writeEnabled: false,
    });
    const day = new Date().toISOString().slice(0, 10);
    const logPath = join(directory, `usage-${day}.ndjson`);
    appendFileSync(
      logPath,
      `${JSON.stringify(event(9, { baselineMethod: "guess-bytes" as never }))}\n`,
    );
    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    // Only the recorder's own valid line survives the closed-vocabulary check.
    expect(readUsageEvents(directory)).toHaveLength(1);
  });
});

describe("summarizeUsage baseline labelling", () => {
  it("labels the baseline an estimate of native reads and counts calls per method", () => {
    const summary = summarizeUsage([
      event(0),
      event(1, { baselineTokens: 30, estimatedSavedTokens: -70, baselineMethod: "range-bytes" }),
      event(2, { baselineTokens: 40, estimatedSavedTokens: -60, baselineMethod: "range-bytes" }),
      // Not counted: no baseline, a failed call.
      event(3, { baselineTokens: null, estimatedSavedTokens: null, baselineMethod: null }),
      event(4, { outcome: "error", baselineMethod: "range-bytes" }),
    ]);
    expect(summary.baselineBasis).toBe("native-read-estimate");
    expect(summary.measuredBaselineCalls).toBe(3);
    expect(summary.measuredBaselineCallsByMethod).toEqual({ "file-bytes": 1, "range-bytes": 2 });
    expect(summary.measuredBaselineCallsByMethod!["file-bytes"]
      + summary.measuredBaselineCallsByMethod!["range-bytes"]).toBe(summary.measuredBaselineCalls);
  });

  it("reports about zero savings for ranged reads, not the whole file", () => {
    // Three ranged reads whose baselines equal what TL served.
    const ranged = summarizeUsage([0, 1, 2].map((index) =>
      event(index, {
        baselineTokens: 100,
        estimatedResponseTokens: 100,
        estimatedSavedTokens: 0,
        baselineMethod: "range-bytes",
      })));
    expect(ranged.estimatedSavedTokens).toBe(0);
    expect(ranged.measuredBaselineCallsByMethod).toEqual({ "file-bytes": 0, "range-bytes": 3 });
  });

  it("keeps the existing summary fields and the file-bytes response method (backward compatible)", () => {
    const summary = summarizeUsage([event(0)]);
    expect(summary).toMatchObject({
      schemaVersion: 2,
      method: "file-bytes",
      measuredBaselineCalls: 1,
      measuredBaselineTokens: 1_000,
      measuredBaselineBytes: 4_000,
      measuredResponseTokens: 100,
      estimatedSavedTokens: 900,
      estimatedTokenReductionPercent: 90,
      estimatedReductionPercent: 90,
    });
    expect(summary.byTool.tl_read_file).toBe(1);
  });

  it("treats a baseline-bearing event with no method as a whole-file measurement", () => {
    const legacy = event(0) as unknown as Record<string, unknown>;
    delete legacy["baselineMethod"];
    const summary = summarizeUsage([legacy as unknown as TokenLightenUsageEvent]);
    expect(summary.measuredBaselineCallsByMethod).toEqual({ "file-bytes": 1, "range-bytes": 0 });
  });

  it("is all zeros for an empty log", () => {
    const summary = summarizeUsage([]);
    expect(summary.baselineBasis).toBe("native-read-estimate");
    expect(summary.measuredBaselineCallsByMethod).toEqual({ "file-bytes": 0, "range-bytes": 0 });
  });
});
