import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readAiUsageLogs } from "../aiLogs.js";
import { summarizeUsage } from "../index.js";
import { symlinkSupported } from "./helpers/symlinkSupported.js";

// Directory order is unspecified. Put links first to exercise the regression
// deterministically on every filesystem.
vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, readdirSync: (...args: Parameters<typeof fs.readdirSync>) => {
    const entries = fs.readdirSync(...args);
    return entries.sort((a, b) => Number(b.isSymbolicLink()) - Number(a.isSymbolicLink()));
  } };
});

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function log(path: string, id: string): void {
  writeFileSync(path, JSON.stringify({ type: "assistant", message: {
    id, model: "test-model", content: [{ type: "tool_use", name: "mcp__tokenlighten__tl_read_file" }],
    usage: { input_tokens: 10, output_tokens: 5 },
  } }) + "\n");
}

describe("AI usage log enumeration", () => {
  it.skipIf(!symlinkSupported()).each(["dir", "file"] as const)("skips a %s symlink and still scans sibling and nested logs", kind => {
    const root = mkdtempSync(join(tmpdir(), "tl-ai-logs-"));
    roots.push(root);
    const logs = join(root, "logs");
    const outside = join(root, "outside");
    mkdirSync(join(logs, "nested"), { recursive: true });
    mkdirSync(outside);
    log(join(outside, "foreign.jsonl"), "foreign");
    symlinkSync(kind === "dir" ? outside : join(outside, "foreign.jsonl"), join(logs, "link.jsonl"), kind);
    log(join(logs, "sibling.jsonl"), "sibling");
    log(join(logs, "nested", "child.jsonl"), "nested");
    const result = readAiUsageLogs({ codexSessionsDirectory: null, claudeProjectsDirectory: logs });
    expect(result.scannedFiles).toBe(2);
    expect(result.records).toHaveLength(2);
    expect(result.records.every(record => record.totalTokens === 15)).toBe(true);
    expect(result.warnings).not.toContain("claude-code-logs-unavailable");
    const bounded = readAiUsageLogs({ codexSessionsDirectory: null, claudeProjectsDirectory: logs, maxFiles: 1 });
    expect(bounded.scannedFiles).toBe(1);
    expect(bounded.records).toHaveLength(1);
  });
});

describe("Codex usage attribution across model switches", () => {
  const before = "2026-10-01T00:00:00.000Z";
  const after = "2026-10-01T02:00:00.000Z";
  const context = (model: string, timestamp = after) => ({ timestamp, type: "turn_context", payload: { model } });
  const count = (input: number, cached: number, output: number, timestamp = after) => ({
    timestamp, type: "event_msg", payload: { type: "token_count", info: {
      total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, total_tokens: input + output },
    } },
  });
  function read(rows: unknown[], since?: string) {
    const root = mkdtempSync(join(tmpdir(), "tl-model-attribution-"));
    roots.push(root);
    writeFileSync(join(root, "session.jsonl"), [...rows, {
      timestamp: after, type: "response_item", payload: { type: "function_call", name: "mcp__tokenlighten__tl_read_file" },
    }].map(row => JSON.stringify(row)).join("\n") + "\n");
    return readAiUsageLogs({ codexSessionsDirectory: root, claudeProjectsDirectory: null, since });
  }

  it("attributes each cumulative increment to its active model and merges later returns to the same model", () => {
    const result = read([context("model-a"), count(100, 20, 10), context("model-b"), count(160, 40, 20), context("model-a"), count(200, 50, 30)]);
    expect(result.records).toEqual([
      { client: "codex", model: "model-a", inputTokens: 110, cacheWriteTokens: 0, cacheReadTokens: 30, outputTokens: 20, totalTokens: 160, requestCount: 2 },
      { client: "codex", model: "model-b", inputTokens: 40, cacheWriteTokens: 0, cacheReadTokens: 20, outputTokens: 10, totalTokens: 70, requestCount: 1 },
    ]);
    expect(result.matchedSessions).toBe(1);
    expect(result.sessions).toEqual([{ client: "codex", turns: 3 }]);
    const summary = summarizeUsage([], null, result);
    expect(summary.sessionEstimate.models.map(row => row.model)).toEqual(["model-a", "model-b"]);
    expect(summary.sessionEstimate.actualTotalTokens).toBe(230);
  });

  it("keeps the pre-window counter as a baseline across a model switch", () => {
    const result = read([context("model-a", before), count(100, 20, 10, before), context("model-b"), count(160, 40, 20)], "2026-10-01T01:00:00.000Z");
    expect(result.records).toEqual([
      { client: "codex", model: "model-b", inputTokens: 40, cacheWriteTokens: 0, cacheReadTokens: 20, outputTokens: 10, totalTokens: 70, requestCount: 1 },
    ]);
  });

  it("does not reattribute usage to a subsequent model with no token event", () => {
    const result = read([context("model-a"), count(100, 20, 10), context("unused-model")]);
    expect(result.records).toEqual([expect.objectContaining({ model: "model-a", totalTokens: 110 })]);
  });

  it("retains unknown-model increments before a model becomes known", () => {
    const result = read([count(100, 20, 10), context("model-b"), count(160, 40, 20)]);
    expect(result.records).toEqual([
      expect.objectContaining({ model: "unknown", totalTokens: 110 }),
      expect.objectContaining({ model: "model-b", totalTokens: 70 }),
    ]);
  });
});
