import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usageWorkspaceId } from "@tokenlighten/usage";
import {
  BASELINE_NOTE,
  cliVersion,
  formatBaselineLine,
  formatContextAvoidedLine,
  formatReductionRange,
  runLogs,
} from "../commands/logs.js";

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
    tool: "tl_read_file",
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
    tool: "tl_read_file" | "tl_search_files" | "tl_edit_file",
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
    byTool: Record<"tl_read_file" | "tl_search_files" | "tl_edit_file", number>;
    method: "file-bytes";
    measurementDisplay: {
      wire: { status: string; calls: number; events: number };
      mcpResponse: { status: string };
      contextAvoided: { status: string; tokens: number | null; basis: string };
      session: { status: string; net: { status: string; tokens: number | null } };
    };
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
      toolEvent(toolWsId!, 0, "tl_read_file", 40),
      toolEvent(toolWsId!, 1, "tl_read_file", 60),
      toolEvent(toolWsId!, 2, "tl_search_files", 100),
      toolEvent(toolWsId!, 3, "tl_edit_file", 200),
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
    expect(json.byTool).toEqual({ tl_read_file: 2, tl_search_files: 1, tl_edit_file: 1 });
    expect(json.method).toBe("file-bytes");
    expect(json.measurementDisplay.wire).toMatchObject({ status: "measured", calls: 4, events: 4 });
    expect(json.measurementDisplay.mcpResponse.status).toBe("estimated");
    expect(json.measurementDisplay.contextAvoided.status).toBe("unavailable");
    expect(json.measurementDisplay.session.net.status).toBe("estimated");

    writes.length = 0;
    await runLogs(["summary", "--workspace-root", toolRoot]);
    const text = writes.join("");
    expect(text).toContain("MCP calls: 4\n");
    expect(text).toContain("TL response bytes: 400\n");
    expect(text).toContain("TL response tokens: ~100 (est.)\n");
    expect(text).toContain("TL response measurement method: file-bytes\n");
    expect(text).toContain("Context avoided: unavailable (unavailable; basis:");
    expect(text).toContain("Session net: -600 tokens (estimated; basis:");
    expect(text).toContain("By tool: tl_read_file 2, tl_search_files 1, tl_edit_file 1\n");
    // The measured block above comes only from local TL usage events, never
    // from AI-provider session logs, so it renders even though this fresh
    // workspace root cannot match any real provider session and the
    // existing fail-closed lines below remain exactly "unavailable".
    expect(text).toContain("Observed full-session tokens: unavailable\n");
    expect(text).toContain("Predicted no-TL tokens: unavailable\n");
    expect(text).toContain("Model-estimated full-session token reduction: unavailable\n");
    expect(text).toContain("Model-estimated full-session cost reduction: unavailable\n");
  });

  it("feeds the display from task-grouped successful totals and excludes errors", async () => {
    const root = join(logDirectory, "ws-task-group");
    mkdirSync(root, { recursive: true });
    const workspaceId = usageWorkspaceId(root, logDirectory)!;
    const rows = [
      {
        ...toolEvent(workspaceId, 0, "tl_read_file", 400),
        schemaVersion: 2,
        taskRef: "q-task",
        estimatedResponseTokens: 100,
      },
      {
        ...event(workspaceId, 1, 1_000),
        schemaVersion: 2,
        taskRef: "q-task",
        responseBytes: 400,
        estimatedResponseTokens: 100,
        estimatedSavedTokens: 900,
      },
      {
        ...event(workspaceId, 2, 500),
        schemaVersion: 2,
        taskRef: "q-task",
        outcome: "error",
        responseBytes: 400,
        estimatedResponseTokens: 100,
        estimatedSavedTokens: 400,
      },
      {
        ...toolEvent(workspaceId, 3, "tl_read_file", 200),
        schemaVersion: 2,
        taskRef: "q-unanchored",
        estimatedResponseTokens: 50,
      },
    ];
    writeFileSync(
      join(logDirectory, "usage-2026-08-11.ndjson"),
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    );

    await runLogs(["summary", "--json", "--workspace-root", root]);
    const json = lastJson();
    expect(json.estimatedSavedTokens).toBe(800);
    expect(json.measurementDisplay.contextAvoided).toMatchObject({
      status: "estimated",
      tokens: 800,
    });
    expect(json.measurementDisplay.contextAvoided.basis).toContain(
      "canonical task-grouped baseline minus successful responses in baseline-anchored task groups; errors and unanchored task groups excluded",
    );
    expect(json.measurementDisplay.contextAvoided.basis).toContain(
      "1 baseline-bearing call(s)",
    );
  });

  it("states that the baseline is an estimate of native reads of the same files/ranges, not billed cost", async () => {
    const root = join(logDirectory, "ws-baseline-note");
    mkdirSync(root, { recursive: true });
    const workspaceId = usageWorkspaceId(root, logDirectory)!;
    writeFileSync(
      join(logDirectory, "usage-2026-08-11.ndjson"),
      `${JSON.stringify(event(workspaceId, 0, 100))}\n`,
    );

    await runLogs(["summary", "--json", "--workspace-root", root]);
    const json = lastJson() as ReturnType<typeof lastJson> & { baselineNote: string };
    expect(json.baselineNote).toBe(BASELINE_NOTE);
    expect(json.baselineNote).toContain("native reads of the same files/ranges");
    expect(json.baselineNote).toContain("not billed cost");
    expect(json.measurementDisplay.contextAvoided.basis).toContain(
      "estimate of native reads of the same files/ranges, not billed cost",
    );

    writes.length = 0;
    await runLogs(["summary", "--workspace-root", root]);
    const text = writes.join("");
    expect(text).toContain(
      "Baseline: estimate of what native reads of the same files/ranges would have returned",
    );
    expect(text).toContain("not billed cost");
    // The note precedes the savings figures it qualifies.
    expect(text.indexOf("Baseline:")).toBeLessThan(text.indexOf("Context avoided:"));
  });

  it("formats the Baseline line with per-method call counts when the summary carries them", () => {
    expect(formatBaselineLine({ "file-bytes": 3, "range-bytes": 2 })).toBe(
      `Baseline: ${BASELINE_NOTE} [3 whole-file and 2 ranged/symbol baseline call(s)]\n`,
    );
    expect(formatBaselineLine(undefined)).toBe(`Baseline: ${BASELINE_NOTE}\n`);
  });

  // Needs a rebuilt @tokenlighten/usage (this package reads events through
  // its dist): a stale reader drops `range-bytes` lines as unknown.
  it("counts range-bytes baseline calls separately in the summary", async () => {
    const root = join(logDirectory, "ws-range-bytes");
    mkdirSync(root, { recursive: true });
    const workspaceId = usageWorkspaceId(root, logDirectory)!;
    const rows = [
      event(workspaceId, 0, 1_000),
      { ...event(workspaceId, 1, 40), baselineMethod: "range-bytes" },
    ];
    writeFileSync(
      join(logDirectory, "usage-2026-08-11.ndjson"),
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    );

    await runLogs(["summary", "--json", "--workspace-root", root]);
    expect(lastJson()).toMatchObject({
      eventCount: 2,
      measuredBaselineCalls: 2,
      baselineBasis: "native-read-estimate",
      measuredBaselineCallsByMethod: { "file-bytes": 1, "range-bytes": 1 },
    });

    writes.length = 0;
    await runLogs(["summary", "--workspace-root", root]);
    expect(writes.join("")).toContain("[1 whole-file and 1 ranged/symbol baseline call(s)]");
  });

  // A log written before the native-read cap: each event carries the whole-file
  // size of a large source file (the field report: ~397,000 tokens for one
  // 1.59 MB server.ts). The summary bounds them itself, labels the result an
  // estimated upper bound, and reports how much it removed.
  it("bounds old whole-file baselines to one native read and labels the figure an estimated upper bound", async () => {
    const root = join(logDirectory, "ws-old-wholefile");
    mkdirSync(root, { recursive: true });
    const workspaceId = usageWorkspaceId(root, logDirectory)!;
    const rows = [
      event(workspaceId, 0, 397_000),
      event(workspaceId, 1, 150_000),
      event(workspaceId, 2, 1_000),
    ];
    writeFileSync(
      join(logDirectory, "usage-2026-08-11.ndjson"),
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    );

    await runLogs(["summary", "--json", "--workspace-root", root]);
    const json = lastJson() as ReturnType<typeof lastJson> & {
      measuredBaselineTokens: number;
      baselineCap: { maxTokensPerCall: number; maxLinesPerFile: number; clampedCalls: number; clampedTokens: number };
    };
    // Counted: 25,000 + 25,000 + 1,000, each less its 10 response tokens.
    expect(json.measuredBaselineTokens).toBe(51_000);
    expect(json.estimatedSavedTokens).toBe(51_000 - 30);
    expect(json.measurementDisplay.contextAvoided.tokens).toBe(51_000 - 30);
    expect(json.baselineCap).toEqual({
      maxTokensPerCall: 25_000,
      maxLinesPerFile: 2_000,
      clampedCalls: 2,
      clampedTokens: (397_000 - 25_000) + (150_000 - 25_000),
    });
    expect(json.measurementDisplay.contextAvoided.basis).toContain("2 call(s) bounded to 25000 baseline tokens each");

    writes.length = 0;
    await runLogs(["summary", "--workspace-root", root]);
    const text = writes.join("");
    expect(text).toContain("Context avoided: 50970 tokens [estimated upper bound, not billing] (estimated; basis:");
    expect(text).toContain("an estimated upper bound, not billed cost");
    // Nothing near the ~550,000 the whole-file sizes would have claimed.
    expect(text).not.toMatch(/Context avoided: \d{6,} /);
  });

  it("prints a negative Context avoided, never a positive one, when TL returned more than the estimated reads", async () => {
    const root = join(logDirectory, "ws-net-negative");
    mkdirSync(root, { recursive: true });
    const workspaceId = usageWorkspaceId(root, logDirectory)!;
    const rows = [
      // Baseline 100, response 5,000: -4,900 each time.
      { ...event(workspaceId, 0, 100), estimatedResponseTokens: 5_000, responseBytes: 20_000, estimatedSavedTokens: -4_900 },
      // A big-file call that the cap now bounds, answered with a larger response.
      { ...event(workspaceId, 1, 397_000), estimatedResponseTokens: 30_000, responseBytes: 120_000, estimatedSavedTokens: 367_000 },
    ];
    writeFileSync(
      join(logDirectory, "usage-2026-08-11.ndjson"),
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    );

    await runLogs(["summary", "--json", "--workspace-root", root]);
    const json = lastJson();
    // (100 - 5,000) + (25,000 - 30,000): negative, and the display agrees.
    expect(json.estimatedSavedTokens).toBe(-9_900);
    expect(json.measurementDisplay.contextAvoided.tokens).toBe(-9_900);

    writes.length = 0;
    await runLogs(["summary", "--workspace-root", root]);
    const text = writes.join("");
    expect(text).toContain("Context avoided: -9900 tokens [net negative: TL returned more than the estimated native reads; not billing]");
    expect(text).not.toMatch(/Context avoided: \d/);
  });

  it("formats the Context avoided line: signed, caveated, and unavailable stays unavailable", () => {
    const tier = { status: "estimated", basis: "b" };
    expect(formatContextAvoidedLine({ ...tier, tokens: 120 }))
      .toBe("Context avoided: 120 tokens [estimated upper bound, not billing] (estimated; basis: b)\n");
    expect(formatContextAvoidedLine({ ...tier, tokens: 0 }))
      .toBe("Context avoided: 0 tokens [estimated upper bound, not billing] (estimated; basis: b)\n");
    expect(formatContextAvoidedLine({ ...tier, tokens: -5 }))
      .toBe("Context avoided: -5 tokens [net negative: TL returned more than the estimated native reads; not billing] (estimated; basis: b)\n");
    expect(formatContextAvoidedLine({ status: "unavailable", basis: "b", tokens: null }))
      .toBe("Context avoided: unavailable (unavailable; basis: b)\n");
  });

  it("shows sane zeros for the measured block on an empty store, without crashing", async () => {
    await runLogs(["summary", "--json"]);
    const json = lastJson();
    expect(json.eventCount).toBe(0);
    expect(json.totalResponseBytes).toBe(0);
    expect(json.estimatedResponseTokens).toBe(0);
    expect(json.byTool).toEqual({ tl_read_file: 0, tl_search_files: 0, tl_edit_file: 0 });

    writes.length = 0;
    await expect(runLogs(["summary"])).resolves.toBeUndefined();
    const text = writes.join("");
    expect(text).toContain("MCP calls: 0\n");
    expect(text).toContain("TL response bytes: 0\n");
    expect(text).toContain("TL response tokens: ~0 (est.)\n");
    expect(text).toContain("By tool: tl_read_file 0, tl_search_files 0, tl_edit_file 0\n");
  });
});
