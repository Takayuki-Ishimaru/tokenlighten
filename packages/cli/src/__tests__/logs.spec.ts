import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usageWorkspaceId } from "@tokenlighten/usage";
import { cliVersion, formatReductionRange, runLogs } from "../commands/logs.js";

describe("formatReductionRange", () => {
  it("prints one decimal 95% range only when an interval is available", () => {
    expect(formatReductionRange({ low: 12.34, high: 45.67 }))
      .toBe("Reduction range: 12.3–45.7% (95%)\n");
    expect(formatReductionRange(null)).toBe("");
  });
});

describe("cliVersion", () => {
  it("derives from packages/cli's own package.json, not a hardcoded literal", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const manifest = JSON.parse(
      readFileSync(join(here, "..", "..", "package.json"), "utf8"),
    ) as { name: string; version: string };
    expect(manifest.name).toBe("@tokenlighten/cli");
    expect(cliVersion()).toBe(manifest.version);
  });
});

describe("tl logs summary scoping", () => {
  const writes: string[] = [];
  let logDirectory = "";

  beforeEach(() => {
    writes.length = 0;
    logDirectory = join(tmpdir(), `tokenlighten-cli-logs-${randomUUID()}`);
    mkdirSync(logDirectory, { recursive: true });
    writeFileSync(join(logDirectory, ".privacy-salt"), "cli-logs-test-salt");
    process.env["TOKENLIGHTEN_LOG_HOME"] = logDirectory;
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as unknown as typeof process.stdout.write);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env["TOKENLIGHTEN_LOG_HOME"];
  });

  const event = (workspaceId: string, index: number, baselineTokens: number) => ({
    schemaVersion: 1,
    eventId: `${workspaceId}-${index}`,
    occurredAt: "2026-08-11T00:00:00.000Z",
    workspaceId,
    sessionId: "session",
    client: "claude-code",
    tool: "read_file",
    outcome: "ok",
    durationMs: 1,
    responseBytes: 40,
    estimatedResponseTokens: 10,
    baselineTokens,
    estimatedSavedTokens: baselineTokens - 10,
    baselineMethod: "file-bytes",
    writeEnabled: true,
  });

  // Same event shape, but with a caller-chosen tool and responseBytes and no
  // per-call baseline -- used to exercise the always-on "measured" block
  // (call count, total bytes, bytes/4 token estimate, per-tool breakdown),
  // which must render independent of baseline/AI-log availability.
  const toolEvent = (
    workspaceId: string,
    index: number,
    tool: "read_file" | "search_files" | "edit_file",
    responseBytes: number,
  ) => ({
    schemaVersion: 1,
    eventId: `${workspaceId}-tool-${index}`,
    occurredAt: "2026-08-11T00:00:00.000Z",
    workspaceId,
    sessionId: "session",
    client: "claude-code",
    tool,
    outcome: "ok",
    durationMs: 1,
    responseBytes,
    estimatedResponseTokens: Math.ceil(responseBytes / 4),
    baselineTokens: null,
    estimatedSavedTokens: null,
    baselineMethod: null,
    writeEnabled: true,
  });

  const lastJson = () => JSON.parse(writes.join("").trim()) as {
    scope: { kind: string; workspaceId?: string | null };
    eventCount: number;
    estimatedSavedTokens: number;
    measurementUnavailableReason?: string;
    totalResponseBytes: number;
    estimatedResponseTokens: number;
    byTool: Record<"read_file" | "search_files" | "edit_file", number>;
  };

  it("reports machine scope over all events and workspace scope over its own", async () => {
    const rootA = join(logDirectory, "ws-a");
    const rootB = join(logDirectory, "ws-b");
    mkdirSync(rootA, { recursive: true });
    mkdirSync(rootB, { recursive: true });
    const idA = usageWorkspaceId(rootA, logDirectory);
    const idB = usageWorkspaceId(rootB, logDirectory);
    expect(idA).not.toBeNull();
    expect(idB).not.toBeNull();
    const rows = [
      event(idA!, 0, 100),
      event(idA!, 1, 100),
      event(idA!, 2, 100),
      event(idB!, 0, 50),
      event(idB!, 1, 50),
    ];
    writeFileSync(
      join(logDirectory, "usage-2026-08-11.ndjson"),
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    );

    await runLogs(["summary", "--json"]);
    const machine = lastJson();
    expect(machine.scope).toEqual({ kind: "machine" });
    expect(machine.eventCount).toBe(5);
    expect(machine.estimatedSavedTokens).toBe(3 * 90 + 2 * 40);

    writes.length = 0;
    await runLogs(["summary", "--json", "--workspace-root", rootA]);
    const scoped = lastJson();
    expect(scoped.scope).toEqual({ kind: "workspace", workspaceId: idA });
    expect(scoped.eventCount).toBe(3);
    expect(scoped.estimatedSavedTokens).toBe(3 * 90);

    writes.length = 0;
    await runLogs(["summary", "--workspace-root", rootA]);
    const text = writes.join("");
    expect(text).toContain("Scope: workspace\n");
    expect(text).toContain("MCP calls: 3\n");
  });

  it("distinguishes a workspace scope mismatch from a fresh empty log", async () => {
    const recordedRoot = join(logDirectory, "recorded");
    const otherRoot = join(logDirectory, "other");
    mkdirSync(recordedRoot, { recursive: true });
    mkdirSync(otherRoot, { recursive: true });
    const recordedId = usageWorkspaceId(recordedRoot, logDirectory)!;
    writeFileSync(
      join(logDirectory, "usage-2026-08-11.ndjson"),
      JSON.stringify(event(recordedId, 0, 100)) + "\n",
    );

    await runLogs(["summary", "--json", "--workspace-root", otherRoot]);
    expect(lastJson()).toMatchObject({
      eventCount: 0,
      measurementUnavailableReason: "scope-mismatch",
    });
  });

  it("always shows the measured TL call/byte/token/per-tool block, with baseline still unavailable", async () => {
    const toolRoot = join(logDirectory, "ws-tool");
    mkdirSync(toolRoot, { recursive: true });
    const toolWsId = usageWorkspaceId(toolRoot, logDirectory);
    expect(toolWsId).not.toBeNull();
    const rows = [
      toolEvent(toolWsId!, 0, "read_file", 40),
      toolEvent(toolWsId!, 1, "read_file", 60),
      toolEvent(toolWsId!, 2, "search_files", 100),
      toolEvent(toolWsId!, 3, "edit_file", 200),
    ];
    writeFileSync(
      join(logDirectory, "usage-2026-08-11.ndjson"),
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    );

    await runLogs(["summary", "--json", "--workspace-root", toolRoot]);
    const json = lastJson();
    expect(json.eventCount).toBe(4);
    expect(json.totalResponseBytes).toBe(400);
    expect(json.estimatedResponseTokens).toBe(100);
    expect(json.byTool).toEqual({ read_file: 2, search_files: 1, edit_file: 1 });

    writes.length = 0;
    await runLogs(["summary", "--workspace-root", toolRoot]);
    const text = writes.join("");
    expect(text).toContain("MCP calls: 4\n");
    expect(text).toContain("TL response bytes: 400\n");
    expect(text).toContain("TL response tokens: ~100 (est.)\n");
    expect(text).toContain("By tool: read_file 2, search_files 1, edit_file 1\n");
    // The measured block above comes only from local TL usage events, never
    // from AI-provider session logs, so it renders even though this fresh
    // workspace root cannot match any real provider session and the
    // existing fail-closed lines below remain exactly "unavailable".
    expect(text).toContain("Observed full-session tokens: unavailable\n");
    expect(text).toContain("Predicted no-TL tokens: unavailable\n");
    expect(text).toContain("Full-session token reduction: unavailable\n");
    expect(text).toContain("Full-session cost reduction: unavailable\n");
  });

  it("shows sane zeros for the measured block on an empty store, without crashing", async () => {
    await runLogs(["summary", "--json"]);
    const json = lastJson();
    expect(json.eventCount).toBe(0);
    expect(json.totalResponseBytes).toBe(0);
    expect(json.estimatedResponseTokens).toBe(0);
    expect(json.byTool).toEqual({ read_file: 0, search_files: 0, edit_file: 0 });

    writes.length = 0;
    await expect(runLogs(["summary"])).resolves.toBeUndefined();
    const text = writes.join("");
    expect(text).toContain("MCP calls: 0\n");
    expect(text).toContain("TL response bytes: 0\n");
    expect(text).toContain("TL response tokens: ~0 (est.)\n");
    expect(text).toContain("By tool: read_file 0, search_files 0, edit_file 0\n");
  });
});
