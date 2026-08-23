import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";

type CalibrationClient =
  | "vscode"
  | "codex"
  | "claude-code"
  | "desktop"
  | "other";
type CalibrationSource =
  | "paired-direct"
  | "paired-transferred"
  | "analytic-fallback";
interface TestCalibration {
  schemaVersion: 1;
  version: string;
  calibratedAt: string | null;
  source: "analytic-fallback" | "paired-derived";
  rawPairedBillingIncluded: false;
  sampleCount: number;
  relativeError95: number | null;
  tokenDeltaMultiplierByClient: Record<CalibrationClient, number>;
  sourceByClient: Record<CalibrationClient, CalibrationSource>;
  sampleCountByClient: Record<CalibrationClient, number>;
  relativeError95ByClient: Record<CalibrationClient, number | null>;
}

const { calibration } = vi.hoisted(() => ({
  calibration: {
    schemaVersion: 1,
    version: "analytic-v1",
    calibratedAt: null,
    source: "analytic-fallback",
    rawPairedBillingIncluded: false,
    sampleCount: 0,
    relativeError95: null,
    tokenDeltaMultiplierByClient: {
      vscode: 1,
      codex: 1,
      "claude-code": 1,
      desktop: 1,
      other: 1,
    },
    sourceByClient: {
      vscode: "analytic-fallback",
      codex: "analytic-fallback",
      "claude-code": "analytic-fallback",
      desktop: "analytic-fallback",
      other: "analytic-fallback",
    },
    sampleCountByClient: {
      vscode: 0,
      codex: 0,
      "claude-code": 0,
      desktop: 0,
      other: 0,
    },
    relativeError95ByClient: {
      vscode: null,
      codex: null,
      "claude-code": null,
      desktop: null,
      other: null,
    },
  } as TestCalibration,
}));

vi.mock("../calibration.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../calibration.js")>(),
  SESSION_ESTIMATOR_CALIBRATION: calibration,
}));

import {
  createUsageRecorder,
  exportUsageBundle,
  readAiUsageLogs,
  readDiagRingFile,
  readUsageEvents,
  resetUsageWindow,
  summarizeUsage,
  usageWindowStart,
  usageWorkspaceId,
} from "../index.js";
import { writeFileSync } from "node:fs";
import {
  cwdBelongsToRoot,
  normalizeRealPath,
  sessionCwd,
} from "../aiLogs.js";

const CALIBRATION_CLIENTS: readonly CalibrationClient[] = [
  "vscode",
  "codex",
  "claude-code",
  "desktop",
  "other",
];

function resetCalibration(): void {
  calibration.version = "analytic-v1";
  calibration.calibratedAt = null;
  calibration.source = "analytic-fallback";
  calibration.sampleCount = 0;
  calibration.relativeError95 = null;
  for (const client of CALIBRATION_CLIENTS) {
    calibration.tokenDeltaMultiplierByClient[client] = 1;
    calibration.sourceByClient[client] = "analytic-fallback";
    calibration.sampleCountByClient[client] = 0;
    calibration.relativeError95ByClient[client] = null;
  }
}

function configureCalibration(
  clients: Partial<Record<CalibrationClient, {
    source: CalibrationSource;
    sampleCount: number;
    relativeError95: number | null;
    multiplier?: number;
  }>>,
): void {
  resetCalibration();
  for (const [client, value] of Object.entries(clients) as [
    CalibrationClient,
    NonNullable<(typeof clients)[CalibrationClient]>,
  ][]) {
    calibration.tokenDeltaMultiplierByClient[client] = value.multiplier ?? 1;
    calibration.sourceByClient[client] = value.source;
    calibration.sampleCountByClient[client] = value.sampleCount;
    calibration.relativeError95ByClient[client] = value.relativeError95;
  }
  const directClients = CALIBRATION_CLIENTS.filter(
    (client) => calibration.sourceByClient[client] === "paired-direct",
  );
  const directErrors = directClients
    .map((client) => calibration.relativeError95ByClient[client])
    .filter((value): value is number => value !== null);
  calibration.version = "paired-test-v1";
  calibration.calibratedAt = "2026-08-11T00:00:00.000Z";
  calibration.source = Object.values(calibration.sourceByClient).every(
    (source) => source === "analytic-fallback",
  )
    ? "analytic-fallback"
    : "paired-derived";
  calibration.sampleCount = directClients.reduce(
    (sum, client) => sum + calibration.sampleCountByClient[client],
    0,
  );
  calibration.relativeError95 =
    directErrors.length > 0 ? Math.max(...directErrors) : null;
}

function calibratedSummary(
  savedByClient: Partial<Record<CalibrationClient, number>>,
) {
  const clients = Object.entries(savedByClient) as [CalibrationClient, number][];
  return summarizeUsage(
    clients.map(([client, saved], index) => ({
      schemaVersion: 1 as const,
      eventId: `calibration-${index}`,
      occurredAt: "2026-08-11T00:00:00.000Z",
      workspaceId: "workspace",
      sessionId: "session",
      client,
      tool: "read_file" as const,
      outcome: "ok" as const,
      durationMs: 1,
      responseBytes: 0,
      estimatedResponseTokens: 0,
      baselineTokens: saved,
      estimatedSavedTokens: saved,
      baselineMethod: "file-bytes" as const,
      writeEnabled: true,
    })),
    1_000_000,
    {
      records: clients.map(([client]) => ({
        client,
        model: "test-model",
        inputTokens: 1_000,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
        totalTokens: 1_000,
        requestCount: 1,
      })),
      scannedFiles: clients.length,
      matchedSessions: clients.length,
      skippedFiles: 0,
      warnings: [],
    },
  );
}

afterEach(resetCalibration);

describe("AI log workspace attribution", () => {
  it("extracts Claude and Codex session cwd values", () => {
    expect(sessionCwd("claude-code", [
      { type: "assistant", cwd: "/work/claude" },
    ])).toBe("/work/claude");
    expect(sessionCwd("codex", [
      {
        type: "session_meta",
        payload: { type: "session_meta", cwd: "/work/codex" },
      },
    ])).toBe("/work/codex");
    expect(sessionCwd("codex", [{ type: "event" }])).toBeNull();
  });

  it("normalizes real paths and rejects sibling-prefix paths", async () => {
    const { symlinkSync } = await import("node:fs");
    const directory = join(tmpdir(), `tokenlighten-ai-path-${randomUUID()}`);
    const root = join(directory, "workspace");
    const child = join(root, "packages", "usage");
    const sibling = join(directory, "workspace-copy");
    const alias = join(directory, "workspace-alias");
    mkdirSync(child, { recursive: true });
    mkdirSync(sibling, { recursive: true });
    symlinkSync(root, alias, "dir");

    const normalizedRoot = normalizeRealPath(root);
    expect(cwdBelongsToRoot(root, normalizedRoot)).toBe(true);
    expect(cwdBelongsToRoot(child, normalizedRoot)).toBe(true);
    expect(cwdBelongsToRoot(sibling, normalizedRoot)).toBe(false);
    expect(normalizeRealPath(alias)).toBe(normalizedRoot);
    expect(cwdBelongsToRoot(join(alias, "packages"), normalizedRoot)).toBe(true);
  });

  it("derives one workspaceId for symlinked, trailing-sep, and direct roots", async () => {
    const { symlinkSync } = await import("node:fs");
    const directory = join(tmpdir(), `tokenlighten-ws-id-${randomUUID()}`);
    const logDirectory = join(directory, "log");
    const root = join(directory, "workspace");
    const alias = join(directory, "workspace-alias");
    mkdirSync(logDirectory, { recursive: true });
    mkdirSync(root, { recursive: true });
    symlinkSync(root, alias, "dir");
    writeFileSync(join(logDirectory, ".privacy-salt"), "test-salt");

    const direct = usageWorkspaceId(root, logDirectory);
    expect(direct).not.toBeNull();
    expect(usageWorkspaceId(alias, logDirectory)).toBe(direct);
    expect(usageWorkspaceId(`${root}/`, logDirectory)).toBe(direct);
  });

  it("filters whole sessions by workspace and reports turns and unknown cwd", () => {
    const directory = join(tmpdir(), `tokenlighten-ai-scope-${randomUUID()}`);
    const workspaceRoot = join(directory, "workspace");
    const childRoot = join(workspaceRoot, "package");
    const siblingRoot = join(directory, "workspace-copy");
    const claudeDirectory = join(directory, "claude");
    const codexDirectory = join(directory, "codex");
    mkdirSync(workspaceRoot, { recursive: true });
    mkdirSync(childRoot, { recursive: true });
    mkdirSync(siblingRoot, { recursive: true });
    mkdirSync(claudeDirectory, { recursive: true });
    mkdirSync(codexDirectory, { recursive: true });

    const claudeSession = (cwd: string | undefined, id: string) => [
      { type: "ai-title", title: id },
      {
      type: "assistant",
      ...(cwd === undefined ? {} : { cwd }),
      timestamp: "2026-08-11T00:00:00.000Z",
      message: {
        id,
        model: "claude-test",
        content: [{ type: "tool_use", name: "mcp__tokenlighten__read_file" }],
        usage: {
          input_tokens: 10,
          cache_creation_input_tokens: 2,
          cache_read_input_tokens: 3,
          output_tokens: 4,
        },
      },
    }];
    const writeJsonl = (path: string, rows: readonly unknown[]) => {
      writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    };
    writeJsonl(join(claudeDirectory, "root.jsonl"), claudeSession(workspaceRoot, "root"));
    writeJsonl(join(claudeDirectory, "child.jsonl"), claudeSession(childRoot, "child"));
    writeJsonl(join(claudeDirectory, "sibling.jsonl"), claudeSession(siblingRoot, "sibling"));
    writeJsonl(join(claudeDirectory, "unknown.jsonl"), claudeSession(undefined, "unknown"));
    writeJsonl(join(claudeDirectory, "nontl.jsonl"), [{
      type: "assistant",
      timestamp: "2026-08-11T00:00:00.000Z",
      message: {
        id: "nontl",
        model: "claude-test",
        content: [{ type: "text", text: "no TokenLighten usage here" }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    }]);
    const codexSession = (cwd: string) => [
      {
        type: "session_meta",
        payload: { type: "session_meta", cwd },
      },
      {
        type: "turn_context",
        payload: { type: "turn_context", model: "codex-test" },
      },
      {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "mcp__tokenlighten__read_file",
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 30,
              cached_input_tokens: 10,
              output_tokens: 5,
              total_tokens: 35,
            },
          },
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 60,
              cached_input_tokens: 20,
              output_tokens: 10,
              total_tokens: 70,
            },
          },
        },
      },
    ];
    writeJsonl(join(codexDirectory, "root.jsonl"), codexSession(workspaceRoot));
    writeJsonl(join(codexDirectory, "child.jsonl"), codexSession(childRoot));
    writeJsonl(join(codexDirectory, "sibling.jsonl"), codexSession(siblingRoot));

    const scoped = readAiUsageLogs({
      codexSessionsDirectory: codexDirectory,
      claudeProjectsDirectory: claudeDirectory,
      workspaceRoot,
    });
    expect(scoped.scannedFiles).toBe(8);
    expect(scoped.matchedSessions).toBe(4);
    expect(scoped.unattributableSessions).toBe(1);
    expect(scoped.records).toHaveLength(4);
    expect(scoped.sessions.map((session) => session.turns).sort()).toEqual([1, 1, 2, 2]);
    expect(scoped.warnings).toContain("unattributable-ai-sessions-excluded");

    const machine = readAiUsageLogs({
      codexSessionsDirectory: codexDirectory,
      claudeProjectsDirectory: claudeDirectory,
    });
    expect(machine.matchedSessions).toBe(7);
    expect(machine.sessions).toHaveLength(7);
    expect(machine.unattributableSessions).toBe(0);
    expect(machine.warnings).not.toContain("unattributable-ai-sessions-excluded");
  });
});

describe("privacy-preserving usage recording", () => {
  it("writes only the fixed event schema and computes savings", () => {
    const directory = join(tmpdir(), `tokenlighten-usage-${randomUUID()}`);
    mkdirSync(directory, { recursive: true });
    const previous = process.env["NODE_ENV"];
    process.env["NODE_ENV"] = "development";
    try {
      const recorder = createUsageRecorder({
        workspaceRoot: "/secret/customer/repository",
        client: "codex",
        directory,
        sessionId: "session",
      });
      recorder.record({
        tool: "read_file",
        outcome: "ok",
        durationMs: 12,
        responseBytes: 400,
        baselineTokens: 500,
        baselineMethod: "file-bytes",
        writeEnabled: true,
      });
    } finally {
      process.env["NODE_ENV"] = previous;
    }

    const events = readUsageEvents(directory);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      client: "codex",
      tool: "read_file",
      estimatedResponseTokens: 100,
      estimatedSavedTokens: 400,
    });
    expect(summarizeUsage(events)).toMatchObject({
      measuredResponseTokens: 100,
      measuredBaselineTokens: 500,
      measuredResponseBytes: 400,
      measuredBaselineBytes: 2000,
      estimatedReductionPercent: 80,
      estimatedTokenReductionPercent: 80,
      estimatedBaselineCostUsd: 0.001,
      estimatedCostReductionPercent: 80,
      pricingMode: "automatic",
      costPerMillionTokensUsd: null,
      estimatedSavedCostUsd: 0.0008,
    });
    const raw = readFileSync(
      join(directory, `usage-${events[0]!.occurredAt.slice(0, 10)}.ndjson`),
      "utf8",
    );
    expect(raw).not.toContain("/secret/customer/repository");
    expect(raw).not.toContain("query");
    expect(raw).not.toContain("content");
  });

  it("filters summaries and exports to one opaque workspace id", async () => {
    const directory = join(tmpdir(), `tokenlighten-workspaces-${randomUUID()}`);
    const firstRoot = join(directory, "workspace-a");
    const secondRoot = join(directory, "workspace-b");
    const outputPath = join(directory, "workspace-a.tl-usage.zip");
    mkdirSync(directory, { recursive: true });
    const previous = process.env["NODE_ENV"];
    process.env["NODE_ENV"] = "development";
    try {
      for (const [workspaceRoot, client] of [
        [firstRoot, "codex"],
        [secondRoot, "claude-code"],
      ] as const) {
        createUsageRecorder({
          workspaceRoot,
          client,
          directory,
          sessionId: `session-${client}`,
        }).record({
          tool: "read_file",
          outcome: "ok",
          durationMs: 1,
          responseBytes: 40,
          baselineTokens: 20,
          baselineMethod: "file-bytes",
          writeEnabled: true,
        });
      }
    } finally {
      process.env["NODE_ENV"] = previous;
    }

    const workspaceId = usageWorkspaceId(firstRoot, directory);
    expect(workspaceId).not.toBeNull();
    expect(readUsageEvents(directory, null, workspaceId)).toEqual([
      expect.objectContaining({ workspaceId, client: "codex" }),
    ]);

    await exportUsageBundle({ outputPath, directory, workspaceId });
    const zip = await JSZip.loadAsync(readFileSync(outputPath));
    const events = (await zip.file("usage.ndjson")!.async("string"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { workspaceId: string; client: string });
    expect(events).toEqual([
      expect.objectContaining({ workspaceId, client: "codex" }),
    ]);
    const summary = JSON.parse(
      await zip.file("summary.json")!.async("string"),
    ) as { eventCount: number; byClient: Record<string, number> };
    expect(summary.eventCount).toBe(1);
    expect(summary.byClient).toMatchObject({ codex: 1, "claude-code": 0 });
  });

  it("records TL overhead as negative savings", () => {
    const directory = join(tmpdir(), `tokenlighten-usage-${randomUUID()}`);
    mkdirSync(directory, { recursive: true });
    const previous = process.env["NODE_ENV"];
    process.env["NODE_ENV"] = "development";
    try {
      const recorder = createUsageRecorder({
        workspaceRoot: "/workspace",
        client: "codex",
        directory,
        sessionId: "overhead-session",
      });
      recorder.record({
        tool: "read_file",
        outcome: "ok",
        durationMs: 5,
        responseBytes: 400,
        baselineTokens: 50,
        baselineMethod: "file-bytes",
        writeEnabled: true,
      });
    } finally {
      process.env["NODE_ENV"] = previous;
    }

    const events = readUsageEvents(directory);
    expect(events[0]).toMatchObject({
      estimatedResponseTokens: 100,
      baselineTokens: 50,
      estimatedSavedTokens: -50,
    });
    expect(summarizeUsage(events)).toMatchObject({
      estimatedSavedTokens: -50,
      estimatedTokenReductionPercent: -100,
      estimatedSavedCostUsd: -0.0001,
      estimatedCostReductionPercent: -100,
    });
  });

  it("exports the same five-file bundle used by every UI", async () => {
    const directory = join(tmpdir(), `tokenlighten-usage-${randomUUID()}`);
    mkdirSync(directory, { recursive: true });
    const outputPath = join(directory, "export.tl-usage.zip");
    await exportUsageBundle({ outputPath, directory, costPerMillionTokensUsd: 3 });
    const zip = await JSZip.loadAsync(readFileSync(outputPath));
    expect(Object.keys(zip.files).sort()).toEqual([
      "diagnostics.json",
      "manifest.json",
      "privacy-report.json",
      "summary.json",
      "usage.ndjson",
    ]);
    const privacy = JSON.parse(
      await zip.file("privacy-report.json")!.async("string"),
    ) as Record<string, unknown>;
    expect(privacy).toMatchObject({
      localOnly: true,
      automaticUpload: false,
      containsPromptText: false,
      containsFilePaths: false,
    });
  });

  it("uses automatic client pricing until the user supplies an override", () => {
    const automatic = summarizeUsage([]);
    expect(automatic.estimatedSavedCostUsd).toBe(0);
    expect(automatic.pricingMode).toBe("automatic");
    expect(automatic.costPerMillionTokensUsd).toBeNull();
    expect(automatic.automaticPricing.byClient["claude-code"]).toMatchObject({
      model: "Claude Code / Claude Sonnet 4 input reference",
      costPerMillionTokensUsd: 3,
    });

    const manual = summarizeUsage([], 7);
    expect(manual.pricingMode).toBe("manual");
    expect(manual.costPerMillionTokensUsd).toBe(7);

    const sonnet5 = summarizeUsage([], null, {
      records: [
        {
          client: "claude-code",
          model: "claude-sonnet-5",
          inputTokens: 10,
          cacheWriteTokens: 20,
          cacheReadTokens: 30,
          outputTokens: 40,
          totalTokens: 100,
          requestCount: 1,
        },
        {
          client: "claude-code",
          model: "claude-sonnet-5",
          inputTokens: 10,
          cacheWriteTokens: 20,
          cacheReadTokens: 30,
          outputTokens: 40,
          totalTokens: 100,
          requestCount: 1,
        },
      ],
      scannedFiles: 1,
      matchedSessions: 1,
      skippedFiles: 0,
      warnings: [],
    });
    expect(sonnet5.sessionEstimate.models).toHaveLength(1);
    expect(sonnet5.sessionEstimate.models[0]).toMatchObject({
      model: "claude-sonnet-5",
      pricingStatus: "model",
      totalTokens: 200,
      requestCount: 2,
      actualCostUsd: 0.000952,
    });
  });

  it("subtracts regressions, including legacy records whose savings were clipped to zero", () => {
    const base = {
      schemaVersion: 1,
      occurredAt: "2026-08-10T00:00:00.000Z",
      workspaceId: "workspace",
      sessionId: "session",
      tool: "read_file",
      outcome: "ok",
      durationMs: 1,
      baselineMethod: "file-bytes",
      writeEnabled: true,
    } as const;
    const summary = summarizeUsage([
      {
        ...base,
        eventId: "codex-event",
        client: "codex",
        responseBytes: 80,
        estimatedResponseTokens: 20,
        baselineTokens: 100,
        estimatedSavedTokens: 80,
      },
      {
        ...base,
        eventId: "claude-event",
        client: "claude-code",
        responseBytes: 960,
        estimatedResponseTokens: 240,
        baselineTokens: 200,
        // Historical recorders clipped this regression to zero. Summary must
        // recover the signed -40 delta from baseline and response tokens.
        estimatedSavedTokens: 0,
      },
    ]);

    expect(summary.byClient).toMatchObject({ codex: 1, "claude-code": 1 });
    expect(summary.estimatedReductionPercent).toBeCloseTo(40 / 3);
    expect(summary.estimatedTokenReductionPercent).toBeCloseTo(40 / 3);
    expect(summary.estimatedSavedCostUsd).toBeCloseTo(0.00004);
    expect(summary.estimatedBaselineCostUsd).toBeCloseTo(0.0008);
    expect(summary.estimatedCostReductionPercent).toBeCloseTo(5);
  });

  it("reads only structured usage from AI sessions that used TokenLighten", () => {
    const root = join(tmpdir(), `tokenlighten-ai-logs-${randomUUID()}`);
    const codexDirectory = join(root, "codex");
    const claudeDirectory = join(root, "claude");
    mkdirSync(codexDirectory, { recursive: true });
    mkdirSync(claudeDirectory, { recursive: true });
    appendFileSync(
      join(codexDirectory, "rollout.jsonl"),
      [
        {
          type: "turn_context",
          payload: { type: "turn_context", model: "gpt-5.6-terra" },
        },
        {
          type: "response_item",
          payload: {
            type: "mcp_tool_call_begin",
            server: "tokenlighten",
            tool: "read_file",
          },
        },
        {
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 1_000,
                cached_input_tokens: 200,
                output_tokens: 100,
                total_tokens: 1_100,
              },
            },
          },
        },
      ].map((value) => JSON.stringify(value)).join("\n") + "\n",
    );
    appendFileSync(
      join(claudeDirectory, "session.jsonl"),
      [
        {
          type: "assistant",
          message: {
            id: "tool",
            model: "claude-sonnet-4-20250514",
            content: [{
              type: "tool_use",
              name: "mcp__tokenlighten__search_files",
            }],
            usage: {
              input_tokens: 10,
              cache_creation_input_tokens: 20,
              cache_read_input_tokens: 30,
              output_tokens: 40,
            },
          },
        },
        {
          // Duplicate streamed record: the message id must be counted once.
          type: "assistant",
          message: {
            id: "tool",
            model: "claude-sonnet-4-20250514",
            usage: {
              input_tokens: 10,
              cache_creation_input_tokens: 20,
              cache_read_input_tokens: 30,
              output_tokens: 40,
            },
          },
        },
      ].map((value) => JSON.stringify(value)).join("\n") + "\n",
    );

    const logs = readAiUsageLogs({
      codexSessionsDirectory: codexDirectory,
      claudeProjectsDirectory: claudeDirectory,
    });

    expect(logs.matchedSessions).toBe(2);
    expect(logs.records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        client: "codex",
        model: "gpt-5.6-terra",
        inputTokens: 800,
        cacheReadTokens: 200,
        outputTokens: 100,
        totalTokens: 1_100,
      }),
      expect.objectContaining({
        client: "claude-code",
        inputTokens: 10,
        cacheWriteTokens: 20,
        cacheReadTokens: 30,
        outputTokens: 40,
        totalTokens: 100,
        requestCount: 1,
      }),
    ]));
    expect(JSON.stringify(logs)).not.toContain("mcp__tokenlighten");
  });

  it("computes the full-session counterfactual without runtime AI", () => {
    const event = {
      schemaVersion: 1,
      eventId: "codex-event",
      occurredAt: "2026-08-10T00:00:00.000Z",
      workspaceId: "workspace",
      sessionId: "session",
      client: "codex",
      tool: "read_file",
      outcome: "ok",
      durationMs: 1,
      responseBytes: 800,
      estimatedResponseTokens: 200,
      baselineTokens: 1_000,
      estimatedSavedTokens: 800,
      baselineMethod: "file-bytes",
      writeEnabled: true,
    } as const;
    const summary = summarizeUsage([event], null, {
      records: [{
        client: "codex",
        model: "gpt-5.6-terra",
        inputTokens: 800,
        cacheWriteTokens: 0,
        cacheReadTokens: 200,
        outputTokens: 100,
        totalTokens: 1_100,
        requestCount: 3,
      }],
      scannedFiles: 1,
      matchedSessions: 1,
      skippedFiles: 0,
      warnings: [],
    });

    expect(summary.sessionEstimate).toMatchObject({
      status: "estimated",
      actualTotalTokens: 1_100,
      predictedWithoutTlTokens: 1_900,
      predictedSavedTokens: 800,
      confidence: "low",
      matchedSessions: 1,
      calibration: {
        version: "analytic-v1",
        source: "analytic-fallback",
        rawPairedBillingIncluded: false,
        sampleCount: 0,
      },
    });
    expect(summary.sessionEstimate.tokenReductionPercent).toBeCloseTo(800 / 1_900 * 100);
    expect(summary.sessionEstimate.actualTotalCostUsd).toBeCloseTo(0.00284);
    expect(summary.sessionEstimate.predictedWithoutTlCostUsd).toBeCloseTo(0.00484);
    expect(summary.sessionEstimate.costReductionPercent).toBeCloseTo(0.002 / 0.00484 * 100);

    const regression = summarizeUsage([
      {
        ...event,
        eventId: "regression",
        estimatedResponseTokens: 200,
        baselineTokens: 100,
        estimatedSavedTokens: -100,
      },
    ], null, {
      records: [{
        client: "codex",
        model: "gpt-5.6-terra",
        inputTokens: 800,
        cacheWriteTokens: 0,
        cacheReadTokens: 200,
        outputTokens: 100,
        totalTokens: 1_100,
        requestCount: 3,
      }],
      scannedFiles: 1,
      matchedSessions: 1,
      skippedFiles: 0,
      warnings: [],
    });
    expect(regression.sessionEstimate.predictedWithoutTlTokens).toBe(1_000);
    expect(regression.sessionEstimate.tokenReductionPercent).toBe(-10);

    const unattributed = summarizeUsage([
      {
        ...event,
        eventId: "legacy-unattributed",
        client: "other",
      },
    ], null, {
      records: [{
        client: "codex",
        model: "gpt-5.6-terra",
        inputTokens: 800,
        cacheWriteTokens: 0,
        cacheReadTokens: 200,
        outputTokens: 100,
        totalTokens: 1_100,
        requestCount: 3,
      }],
      scannedFiles: 1,
      matchedSessions: 1,
      skippedFiles: 0,
      warnings: [],
    });
    expect(unattributed.sessionEstimate.predictedWithoutTlTokens).toBe(1_900);
    expect(unattributed.sessionEstimate.warnings).toContain(
      "unattributed-mcp-events-allocated",
    );
  });

  it("derives direct high and medium confidence with weighted 95% intervals", () => {
    configureCalibration({
      "claude-code": {
        source: "paired-direct",
        sampleCount: 24,
        relativeError95: 0.25,
      },
    });
    const high = calibratedSummary({ "claude-code": 100 });
    expect(high.sessionEstimate.confidence).toBe("high");
    expect(high.sessionEstimate.tokenReductionPercent95).toEqual({
      low: 75 / 1_075 * 100,
      high: 125 / 1_125 * 100,
    });
    expect(high.sessionEstimate.costReductionPercent95).toEqual({
      low: 75 / 1_075 * 100,
      high: 125 / 1_125 * 100,
    });

    configureCalibration({
      "claude-code": {
        source: "paired-direct",
        sampleCount: 24,
        relativeError95: 0.1,
      },
      codex: {
        source: "paired-direct",
        sampleCount: 24,
        relativeError95: 0.25,
      },
    });
    const weighted = calibratedSummary({
      "claude-code": 300,
      codex: 100,
    });
    expect(weighted.sessionEstimate.confidence).toBe("high");
    expect(weighted.sessionEstimate.tokenReductionPercent95?.low)
      .toBeCloseTo(345 / 2_345 * 100);
    expect(weighted.sessionEstimate.tokenReductionPercent95?.high)
      .toBeCloseTo(455 / 2_455 * 100);

    configureCalibration({
      "claude-code": {
        source: "paired-direct",
        sampleCount: 12,
        relativeError95: 0.5,
      },
    });
    expect(calibratedSummary({ "claude-code": 100 }).sessionEstimate.confidence)
      .toBe("medium");
  });

  it("includes submaterial paired contributions in the weighted interval", () => {
    configureCalibration({
      "claude-code": {
        source: "paired-direct",
        sampleCount: 24,
        relativeError95: 0.2,
      },
      codex: {
        source: "paired-direct",
        sampleCount: 24,
        relativeError95: 0.6,
      },
    });
    const summary = calibratedSummary({
      "claude-code": 910,
      codex: 90,
    });
    expect(summary.sessionEstimate.confidence).toBe("high");
    expect(summary.sessionEstimate.tokenReductionPercent95?.low)
      .toBeCloseTo(764 / 2_764 * 100);
    expect(summary.sessionEstimate.tokenReductionPercent95?.high)
      .toBeCloseTo(1_236 / 3_236 * 100);
  });

  it("caps transferred confidence at medium and requires direct support", () => {
    configureCalibration({
      "claude-code": {
        source: "paired-direct",
        sampleCount: 24,
        relativeError95: 0.25,
      },
      vscode: {
        source: "paired-transferred",
        sampleCount: 24,
        relativeError95: 0.6,
      },
    });
    expect(calibratedSummary({ vscode: 100 }).sessionEstimate.confidence)
      .toBe("medium");

    configureCalibration({
      vscode: {
        source: "paired-transferred",
        sampleCount: 24,
        relativeError95: 0.6,
      },
    });
    expect(calibratedSummary({ vscode: 100 }).sessionEstimate.confidence)
      .toBe("low");
  });

  it("fails intervals closed for material analytic clients", () => {
    configureCalibration({
      "claude-code": {
        source: "paired-direct",
        sampleCount: 24,
        relativeError95: 0.25,
      },
    });
    const mixed = calibratedSummary({
      "claude-code": 100,
      codex: 100,
    });
    expect(mixed.sessionEstimate.confidence).toBe("low");
    expect(mixed.sessionEstimate.tokenReductionPercent95).toBeNull();
    expect(mixed.sessionEstimate.costReductionPercent95).toBeNull();
  });

  it("ignores analytic contributions at the strict materiality boundary", () => {
    configureCalibration({
      "claude-code": {
        source: "paired-direct",
        sampleCount: 24,
        relativeError95: 0.25,
      },
    });
    const summary = calibratedSummary({
      "claude-code": 900,
      codex: 100,
    });
    expect(summary.sessionEstimate.confidence).toBe("high");
    expect(summary.sessionEstimate.tokenReductionPercent95).toEqual({
      low: 750 / 2_750 * 100,
      high: 1_250 / 3_250 * 100,
    });
  });

  it("reports unavailable confidence when no counterfactual exists", () => {
    configureCalibration({
      "claude-code": {
        source: "paired-direct",
        sampleCount: 24,
        relativeError95: 0.25,
      },
    });
    const summary = calibratedSummary({});
    expect(summary.sessionEstimate.confidence).toBe("unavailable");
    expect(summary.sessionEstimate.tokenReductionPercent95).toBeNull();
  });

  it("applies scoped residual turns, cache-aware costs, and partial pricing", () => {
    const base = {
      schemaVersion: 1,
      occurredAt: "2026-08-11T00:00:00.000Z",
      workspaceId: "workspace-id",
      sessionId: "session",
      client: "claude-code",
      tool: "read_file",
      durationMs: 1,
      responseBytes: 0,
      estimatedResponseTokens: 0,
      baselineMethod: "file-bytes",
      writeEnabled: true,
    } as const;
    const events = [
      {
        ...base,
        eventId: "ok",
        outcome: "ok" as const,
        baselineTokens: 1_000_000,
        estimatedSavedTokens: 1_000_000,
      },
      {
        ...base,
        eventId: "error",
        outcome: "error" as const,
        baselineTokens: 100_000,
        estimatedSavedTokens: 100_000,
      },
    ];
    const aiLogs = {
      records: [
        {
          client: "claude-code" as const,
          model: "claude-sonnet-4",
          inputTokens: 25,
          cacheWriteTokens: 25,
          cacheReadTokens: 25,
          outputTokens: 25,
          totalTokens: 100,
          requestCount: 3,
        },
        {
          client: "claude-code" as const,
          model: "claude-3-5-sonnet-20241022",
          inputTokens: 25,
          cacheWriteTokens: 25,
          cacheReadTokens: 25,
          outputTokens: 25,
          totalTokens: 100,
          requestCount: 3,
        },
      ],
      sessions: [10, 20, 30].map((turns) => ({
        client: "claude-code" as const,
        turns,
      })),
      scannedFiles: 3,
      matchedSessions: 3,
      unattributableSessions: 0,
      skippedFiles: 0,
      warnings: [],
    };
    const summary = summarizeUsage(events, null, aiLogs, {
      scope: { kind: "workspace", workspaceId: "workspace-id" },
    });

    expect(summary.schemaVersion).toBe(2);
    expect(summary.scope).toEqual({ kind: "workspace", workspaceId: "workspace-id" });
    expect(summary.measuredBaselineCalls).toBe(1);
    expect(summary.measuredBaselineTokens).toBe(1_000_000);
    expect(summary.estimatedSavedTokens).toBe(1_000_000);
    expect(summary.sessionEstimate.predictedSavedTokens).toBe(11_000_000);
    expect(summary.sessionEstimate.predictedSavedCostUsd).toBeCloseTo(6.75);
    expect(summary.sessionEstimate.actualTotalCostUsd).not.toBeNull();
    expect(summary.sessionEstimate.costReductionPercent).not.toBeNull();
    expect(summary.sessionEstimate.unpricedTokenShare).toBe(0.5);
    expect(summary.sessionEstimate.warnings).toContain("one-or-more-models-unpriced");
    expect(summary.sessionEstimate.residencyModel).toMatchObject({
      version: "residual-turns-v1",
      meanTurnsByClient: { "claude-code": 20 },
      residualFactorByClient: { "claude-code": 11 },
    });

    const manual = summarizeUsage(events, 5, aiLogs);
    expect(manual.sessionEstimate.predictedSavedCostUsd).toBeCloseTo(55);

    const allUnpriced = summarizeUsage(events, null, {
      ...aiLogs,
      records: [aiLogs.records[1]!],
    });
    expect(allUnpriced.sessionEstimate.actualTotalCostUsd).toBeNull();
    expect(allUnpriced.sessionEstimate.costReductionPercent).toBeNull();
  });

  it("machine scope equals the sum of workspace scopes over the same events", () => {
    const base = {
      schemaVersion: 1,
      occurredAt: "2026-08-11T00:00:00.000Z",
      sessionId: "session",
      client: "claude-code",
      tool: "read_file",
      outcome: "ok",
      durationMs: 1,
      baselineMethod: "file-bytes",
      writeEnabled: true,
    } as const;
    const event = (workspaceId: string, index: number, baselineTokens: number) => ({
      ...base,
      eventId: `${workspaceId}-${index}`,
      workspaceId,
      responseBytes: 40,
      estimatedResponseTokens: 10,
      baselineTokens,
      estimatedSavedTokens: baselineTokens - 10,
    });
    const all = [
      event("ws-a", 0, 100),
      event("ws-a", 1, 100),
      event("ws-a", 2, 100),
      event("ws-b", 0, 50),
      event("ws-b", 1, 50),
    ];
    const machine = summarizeUsage(all);
    const wsA = summarizeUsage(all.filter((entry) => entry.workspaceId === "ws-a"));
    const wsB = summarizeUsage(all.filter((entry) => entry.workspaceId === "ws-b"));

    expect(machine.scope).toEqual({ kind: "machine" });
    expect(machine.eventCount).toBe(wsA.eventCount + wsB.eventCount);
    expect(machine.estimatedResponseTokens)
      .toBe(wsA.estimatedResponseTokens + wsB.estimatedResponseTokens);
    expect(machine.measuredBaselineCalls)
      .toBe(wsA.measuredBaselineCalls + wsB.measuredBaselineCalls);
    expect(machine.measuredBaselineTokens)
      .toBe(wsA.measuredBaselineTokens + wsB.measuredBaselineTokens);
    expect(machine.estimatedSavedTokens)
      .toBe(wsA.estimatedSavedTokens + wsB.estimatedSavedTokens);
  });

  it("resets the displayed window without deleting source logs", () => {
    const directory = join(tmpdir(), `tokenlighten-reset-${randomUUID()}`);
    mkdirSync(directory, { recursive: true });
    const { resetAt } = resetUsageWindow(directory);
    expect(usageWindowStart(directory)).toBe(resetAt);

    const resetMs = Date.parse(resetAt);
    const base = {
      schemaVersion: 1,
      workspaceId: "workspace",
      sessionId: "session",
      client: "codex",
      tool: "read_file",
      outcome: "ok",
      durationMs: 1,
      responseBytes: 40,
      estimatedResponseTokens: 10,
      baselineTokens: 20,
      estimatedSavedTokens: 10,
      baselineMethod: "file-bytes",
      writeEnabled: true,
    } as const;
    const events = [
      {
        ...base,
        eventId: "before-reset",
        occurredAt: new Date(resetMs - 1_000).toISOString(),
      },
      {
        ...base,
        eventId: "after-reset",
        occurredAt: new Date(resetMs + 1_000).toISOString(),
      },
    ];
    for (const event of events) {
      appendFileSync(
        join(directory, `usage-${event.occurredAt.slice(0, 10)}.ndjson`),
        `${JSON.stringify(event)}\n`,
      );
    }

    expect(readUsageEvents(directory)).toHaveLength(2);
    expect(readUsageEvents(directory, usageWindowStart(directory))).toEqual([
      expect.objectContaining({ eventId: "after-reset" }),
    ]);
  });

  it("reads only post-reset AI usage, including active-session deltas", () => {
    const root = join(tmpdir(), `tokenlighten-ai-reset-${randomUUID()}`);
    const codexDirectory = join(root, "codex");
    const claudeDirectory = join(root, "claude");
    mkdirSync(codexDirectory, { recursive: true });
    mkdirSync(claudeDirectory, { recursive: true });
    const before = "2026-08-10T00:00:00.000Z";
    const since = "2026-08-10T01:00:00.000Z";
    const after = "2026-08-10T02:00:00.000Z";

    appendFileSync(
      join(codexDirectory, "active.jsonl"),
      [
        {
          timestamp: before,
          type: "turn_context",
          payload: { type: "turn_context", model: "gpt-5.6-terra" },
        },
        {
          timestamp: before,
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 1_000,
                cached_input_tokens: 200,
                output_tokens: 100,
                total_tokens: 1_100,
              },
            },
          },
        },
        {
          timestamp: after,
          type: "response_item",
          payload: {
            type: "mcp_tool_call_begin",
            server: "tokenlighten",
            tool: "read_file",
          },
        },
        {
          timestamp: after,
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 1_500,
                cached_input_tokens: 300,
                output_tokens: 200,
                total_tokens: 1_700,
              },
            },
          },
        },
      ].map((value) => JSON.stringify(value)).join("\n") + "\n",
    );
    appendFileSync(
      join(claudeDirectory, "session.jsonl"),
      [
        {
          timestamp: before,
          type: "assistant",
          message: {
            id: "before",
            model: "claude-sonnet-4-20250514",
            usage: {
              input_tokens: 100,
              cache_creation_input_tokens: 200,
              cache_read_input_tokens: 300,
              output_tokens: 400,
            },
          },
        },
        {
          timestamp: after,
          type: "assistant",
          message: {
            id: "after",
            model: "claude-sonnet-4-20250514",
            content: [{
              type: "tool_use",
              name: "mcp__tokenlighten__search_files",
            }],
            usage: {
              input_tokens: 10,
              cache_creation_input_tokens: 20,
              cache_read_input_tokens: 30,
              output_tokens: 40,
            },
          },
        },
      ].map((value) => JSON.stringify(value)).join("\n") + "\n",
    );

    const logs = readAiUsageLogs({
      codexSessionsDirectory: codexDirectory,
      claudeProjectsDirectory: claudeDirectory,
      since,
    });
    expect(logs.matchedSessions).toBe(2);
    expect(logs.records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        client: "codex",
        model: "gpt-5.6-terra",
        inputTokens: 400,
        cacheReadTokens: 100,
        outputTokens: 100,
        totalTokens: 600,
      }),
      expect.objectContaining({
        client: "claude-code",
        inputTokens: 10,
        cacheWriteTokens: 20,
        cacheReadTokens: 30,
        outputTokens: 40,
        totalTokens: 100,
      }),
    ]));
  });

  it("drops records containing fields outside the privacy schema", () => {
    const directory = join(tmpdir(), `tokenlighten-usage-${randomUUID()}`);
    mkdirSync(directory, { recursive: true });
    const occurredAt = new Date().toISOString();
    appendFileSync(
      join(directory, `usage-${occurredAt.slice(0, 10)}.ndjson`),
      `${JSON.stringify({
        schemaVersion: 1,
        eventId: randomUUID(),
        occurredAt,
        workspaceId: "opaque",
        sessionId: "opaque",
        client: "other",
        tool: "read_file",
        outcome: "ok",
        durationMs: 1,
        responseBytes: 4,
        estimatedResponseTokens: 1,
        baselineTokens: null,
        estimatedSavedTokens: null,
        baselineMethod: null,
        writeEnabled: true,
        query: "must never be exported",
      })}\n`,
    );
    expect(readUsageEvents(directory)).toEqual([]);
  });
});

describe("createUsageRecorder — diagnostics ring integration", () => {
  it("mirrors kind/mode/errorCode into the ring file, keyed by workspace, without joining the NDJSON event schema", () => {
    const workspaceRoot = tmpdir();
    const directory = join(tmpdir(), `tokenlighten-diag-ndjson-${randomUUID()}`);
    const diagDirectory = join(tmpdir(), `tokenlighten-diag-ring-${randomUUID()}`);
    mkdirSync(directory, { recursive: true });
    const previous = process.env["NODE_ENV"];
    process.env["NODE_ENV"] = "development";
    try {
      const recorder = createUsageRecorder({
        workspaceRoot,
        client: "vscode",
        directory,
        diagDirectory,
        sessionId: "diag-session",
        serverVersion: "9.9.9-test",
      });
      recorder.record({
        tool: "search_files",
        outcome: "error",
        durationMs: 7,
        responseBytes: 0,
        writeEnabled: false,
        kind: "refusal",
        mode: "tree",
        errorCode: "cwd-required-for-edit",
      });
    } finally {
      process.env["NODE_ENV"] = previous;
    }

    const events = readUsageEvents(directory);
    expect(events).toHaveLength(1);
    expect(events[0]).not.toHaveProperty("kind");
    expect(events[0]).not.toHaveProperty("mode");
    expect(events[0]).not.toHaveProperty("errorCode");

    const ring = readDiagRingFile(workspaceRoot, diagDirectory);
    expect(ring?.server_version).toBe("9.9.9-test");
    expect(ring?.calls).toEqual([
      expect.objectContaining({
        tool: "search_files",
        mode: "tree",
        kind: "refusal",
        ok: false,
        error_code: "cwd-required-for-edit",
      }),
    ]);
  });

  it("skips the ring file under the same gate as the NDJSON recorder (NODE_ENV=test / TOKENLIGHTEN_USAGE_LOG=off)", () => {
    const workspaceRoot = tmpdir();
    const directory = join(tmpdir(), `tokenlighten-diag-off-ndjson-${randomUUID()}`);
    const diagDirectory = join(tmpdir(), `tokenlighten-diag-off-ring-${randomUUID()}`);
    mkdirSync(directory, { recursive: true });

    // Gate 1: default test NODE_ENV (no override) disables the recorder entirely.
    const testGated = createUsageRecorder({ workspaceRoot, directory, diagDirectory });
    testGated.record({
      tool: "read_file",
      outcome: "ok",
      durationMs: 1,
      responseBytes: 1,
      writeEnabled: false,
      kind: "read.task_pack",
      mode: "task_pack",
    });
    expect(readUsageEvents(directory)).toEqual([]);
    expect(readDiagRingFile(workspaceRoot, diagDirectory)).toBeNull();

    // Gate 2: NODE_ENV=development but TOKENLIGHTEN_USAGE_LOG=off — same result.
    const previousNodeEnv = process.env["NODE_ENV"];
    const previousUsageLog = process.env["TOKENLIGHTEN_USAGE_LOG"];
    process.env["NODE_ENV"] = "development";
    process.env["TOKENLIGHTEN_USAGE_LOG"] = "off";
    try {
      const envGated = createUsageRecorder({ workspaceRoot, directory, diagDirectory });
      envGated.record({
        tool: "read_file",
        outcome: "ok",
        durationMs: 1,
        responseBytes: 1,
        writeEnabled: false,
        kind: "read.task_pack",
        mode: "task_pack",
      });
    } finally {
      process.env["NODE_ENV"] = previousNodeEnv;
      if (previousUsageLog === undefined) delete process.env["TOKENLIGHTEN_USAGE_LOG"];
      else process.env["TOKENLIGHTEN_USAGE_LOG"] = previousUsageLog;
    }
    expect(readUsageEvents(directory)).toEqual([]);
    expect(readDiagRingFile(workspaceRoot, diagDirectory)).toBeNull();
  });
});
