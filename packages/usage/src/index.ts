import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { homedir, platform, release } from "node:os";
import { dirname, join, resolve } from "node:path";
import JSZip from "jszip";
import type {
  TokenLightenClient,
  TokenLightenPrivacyReport,
  TokenLightenSessionModelUsage,
  TokenLightenSummaryScope,
  TokenLightenTool,
  TokenLightenUsageEvent,
  TokenLightenUsageExportManifest,
  TokenLightenUsageSummary,
} from "@tokenlighten/types";
import {
  canonicalWorkspacePath,
  readAiUsageLogs,
  type AiLogReadResult,
  type AiSessionMeta,
  type AiUsageRecord,
} from "./aiLogs.js";
import {
  CALIBRATION_DIRECT_MEDIUM_MAX_RELATIVE_ERROR95,
  CALIBRATION_HIGH_MAX_RELATIVE_ERROR95,
  CALIBRATION_HIGH_SAMPLE_COUNT,
  CALIBRATION_MATERIALITY,
  CALIBRATION_MIN_SAMPLE_COUNT,
  CALIBRATION_TRANSFERRED_MEDIUM_MAX_RELATIVE_ERROR95,
  RESIDUAL_TURN_SHARE,
  SESSION_ESTIMATOR_CALIBRATION,
} from "./calibration.js";

export { readAiUsageLogs } from "./aiLogs.js";
export type { TokenLightenSummaryScope as SummaryScope } from "@tokenlighten/types";

const EVENT_FIELDS = [
  "schemaVersion",
  "eventId",
  "occurredAt",
  "workspaceId",
  "sessionId",
  "client",
  "tool",
  "outcome",
  "durationMs",
  "responseBytes",
  "estimatedResponseTokens",
  "baselineTokens",
  "estimatedSavedTokens",
  "baselineMethod",
  "writeEnabled",
] as const satisfies readonly (keyof TokenLightenUsageEvent)[];

const CLIENTS = new Set<TokenLightenClient>([
  "vscode",
  "codex",
  "claude-code",
  "desktop",
  "other",
]);
const TOOLS = new Set<TokenLightenTool>(["read_file", "search_files", "edit_file"]);
const EVENT_FIELD_SET = new Set<string>(EVENT_FIELDS);
const USAGE_RESET_FILE = ".usage-reset.ndjson";

// Used only for the legacy MCP-response estimate when a provider log has no
// model id. Full-session costs use MODEL_PRICES and never guess an unknown model.
const AUTOMATIC_PRICING: TokenLightenUsageSummary["automaticPricing"] = {
  asOf: "2026-08-10",
  byClient: {
    vscode: {
      model: "GitHub Copilot / GPT-5.4 input reference",
      costPerMillionTokensUsd: 2.5,
    },
    codex: {
      model: "Codex / GPT-5.6 Terra input reference",
      costPerMillionTokensUsd: 2,
    },
    "claude-code": {
      model: "Claude Code / Claude Sonnet 4 input reference",
      costPerMillionTokensUsd: 3,
    },
    desktop: {
      model: "Desktop client input reference",
      costPerMillionTokensUsd: 2.5,
    },
    other: {
      model: "Other AI client input reference",
      costPerMillionTokensUsd: 2.5,
    },
  },
};

interface ModelPrice {
  pattern: RegExp;
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

// Static release-time pricing. No network request occurs while measuring.
// Unknown model ids remain unpriced instead of silently using the wrong model.
const MODEL_PRICES: readonly ModelPrice[] = [
  { pattern: /^gpt-5\.6-sol(?:$|-)/i, input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 30 },
  { pattern: /^gpt-5\.6-terra(?:$|-)/i, input: 2, cacheWrite: 2.5, cacheRead: 0.2, output: 12 },
  { pattern: /^gpt-5\.6-luna(?:$|-)/i, input: 0.2, cacheWrite: 0.25, cacheRead: 0.02, output: 1.2 },
  { pattern: /^gpt-5\.5(?:$|-)/i, input: 5, cacheWrite: 5, cacheRead: 0.5, output: 30 },
  { pattern: /^gpt-5\.4(?:$|-)/i, input: 2.5, cacheWrite: 2.5, cacheRead: 0.25, output: 15 },
  { pattern: /^gpt-5\.3-codex(?:$|-)/i, input: 1.75, cacheWrite: 1.75, cacheRead: 0.175, output: 14 },
  { pattern: /^claude-fable-5(?:$|-)/i, input: 10, cacheWrite: 12.5, cacheRead: 1, output: 50 },
  { pattern: /^claude-opus-5(?:$|-)/i, input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 },
  // Sonnet 5 introductory pricing is valid through 2026-08-31.
  { pattern: /^claude-sonnet-5(?:$|-)/i, input: 2, cacheWrite: 2.5, cacheRead: 0.2, output: 10 },
  { pattern: /^claude-haiku-4-5(?:$|-)/i, input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 },
  { pattern: /^claude-opus-4-(?:8|7|6|5)(?:$|-)/i, input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 },
  { pattern: /^claude-opus-4-1(?:$|-)/i, input: 15, cacheWrite: 18.75, cacheRead: 1.5, output: 75 },
  { pattern: /^claude-sonnet-4(?:$|-)/i, input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
  { pattern: /^claude-3-5-haiku(?:$|-)/i, input: 0.8, cacheWrite: 1, cacheRead: 0.08, output: 4 },
];

function defaultLogDir(): string {
  if (process.env["TOKENLIGHTEN_LOG_HOME"]) {
    return resolve(process.env["TOKENLIGHTEN_LOG_HOME"]);
  }
  if (process.env["TOKENLIGHTEN_HOME"]) {
    return join(resolve(process.env["TOKENLIGHTEN_HOME"]), "log");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Logs", "tokenlighten");
  }
  if (process.platform === "win32") {
    const base = process.env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local");
    return join(base, "tokenlighten", "Logs");
  }
  const state = process.env["XDG_STATE_HOME"] ?? join(homedir(), ".local", "state");
  return join(state, "tokenlighten", "log");
}

function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("TokenLighten log destination must be a real directory");
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    chmodSync(dir, 0o700);
  }
}

function saltFor(dir: string): Buffer {
  const saltPath = join(dir, ".privacy-salt");
  if (existsSync(saltPath)) {
    const stat = lstatSync(saltPath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Invalid privacy salt");
    return readFileSync(saltPath);
  }
  const salt = randomBytes(32);
  writeFileSync(saltPath, salt, { mode: 0o600, flag: "wx" });
  return salt;
}

function opaqueId(salt: Buffer, namespace: string, value: string): string {
  return createHash("sha256")
    .update(salt)
    .update("\0")
    .update(namespace)
    .update("\0")
    .update(value)
    .digest("hex")
    .slice(0, 24);
}

export function usageWorkspaceId(
  workspaceRoot: string,
  directory = defaultLogDir(),
): string | null {
  const dir = resolve(directory);
  const saltPath = join(dir, ".privacy-salt");
  if (!existsSync(dir) || !existsSync(saltPath)) return null;
  const stat = lstatSync(saltPath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("Invalid privacy salt");
  }
  return opaqueId(readFileSync(saltPath), "workspace", canonicalWorkspacePath(workspaceRoot));
}

function normalizedClient(value: string | undefined): TokenLightenClient {
  return CLIENTS.has(value as TokenLightenClient)
    ? value as TokenLightenClient
    : "other";
}

function clampInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

export function estimateTokensFromBytes(bytes: number): number {
  return Math.ceil(clampInteger(bytes) / 4);
}

export interface UsageObservation {
  tool: TokenLightenTool;
  outcome: "ok" | "error";
  durationMs: number;
  responseBytes: number;
  baselineTokens?: number | null;
  baselineMethod?: "file-bytes" | null;
  writeEnabled: boolean;
}

export interface UsageRecorder {
  readonly enabled: boolean;
  readonly directory: string;
  record(observation: UsageObservation): void;
}

export function createUsageRecorder(options: {
  workspaceRoot: string;
  client?: string;
  sessionId?: string;
  directory?: string;
  enabled?: boolean;
}): UsageRecorder {
  const directory = resolve(options.directory ?? defaultLogDir());
  const disabledByEnv = /^(0|false|off|no)$/i.test(
    process.env["TOKENLIGHTEN_USAGE_LOG"] ?? "",
  );
  const enabled =
    options.enabled !== false
    && !disabledByEnv
    && process.env["NODE_ENV"] !== "test";
  if (!enabled) return { enabled: false, directory, record: () => undefined };

  ensurePrivateDir(directory);
  const salt = saltFor(directory);
  const workspaceId = opaqueId(salt, "workspace", canonicalWorkspacePath(options.workspaceRoot));
  const sessionId = opaqueId(
    salt,
    "session",
    options.sessionId ?? randomBytes(16).toString("hex"),
  );
  const client = normalizedClient(options.client ?? process.env["TOKENLIGHTEN_CLIENT"]);

  return {
    enabled: true,
    directory,
    record(observation): void {
      if (!TOOLS.has(observation.tool)) return;
      const responseBytes = clampInteger(observation.responseBytes);
      const estimatedResponseTokens = estimateTokensFromBytes(responseBytes);
      const baselineTokens =
        observation.baselineTokens === null || observation.baselineTokens === undefined
          ? null
          : clampInteger(observation.baselineTokens);
      const event: TokenLightenUsageEvent = {
        schemaVersion: 1,
        eventId: randomUUID(),
        occurredAt: new Date().toISOString(),
        workspaceId,
        sessionId,
        client,
        tool: observation.tool,
        outcome: observation.outcome,
        durationMs: clampInteger(observation.durationMs),
        responseBytes,
        estimatedResponseTokens,
        baselineTokens,
        estimatedSavedTokens:
          baselineTokens === null
            ? null
            : baselineTokens - estimatedResponseTokens,
        baselineMethod:
          baselineTokens === null
            ? null
            : observation.baselineMethod ?? "file-bytes",
        writeEnabled: observation.writeEnabled,
      };
      const day = event.occurredAt.slice(0, 10);
      const logPath = join(directory, `usage-${day}.ndjson`);
      if (existsSync(logPath)) {
        const stat = lstatSync(logPath);
        if (stat.isSymbolicLink() || !stat.isFile()) {
          throw new Error("Invalid TokenLighten usage log file");
        }
      }
      appendFileSync(
        logPath,
        `${JSON.stringify(event)}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
    },
  };
}

function isUsageEvent(value: unknown): value is TokenLightenUsageEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (
    keys.length !== EVENT_FIELDS.length
    || keys.some((key) => !EVENT_FIELD_SET.has(key))
  ) {
    return false;
  }
  const event = value as Partial<TokenLightenUsageEvent>;
  return event.schemaVersion === 1
    && typeof event.eventId === "string"
    && typeof event.occurredAt === "string"
    && typeof event.workspaceId === "string"
    && typeof event.sessionId === "string"
    && CLIENTS.has(event.client as TokenLightenClient)
    && TOOLS.has(event.tool as TokenLightenTool)
    && (event.outcome === "ok" || event.outcome === "error")
    && typeof event.durationMs === "number"
    && typeof event.responseBytes === "number"
    && typeof event.estimatedResponseTokens === "number"
    && (event.baselineTokens === null || typeof event.baselineTokens === "number")
    && (event.estimatedSavedTokens === null || typeof event.estimatedSavedTokens === "number")
    && (event.baselineMethod === null || event.baselineMethod === "file-bytes")
    && typeof event.writeEnabled === "boolean";
}

export function usageWindowStart(directory = defaultLogDir()): string | null {
  const dir = resolve(directory);
  const resetPath = join(dir, USAGE_RESET_FILE);
  if (!existsSync(resetPath)) return null;
  const stat = lstatSync(resetPath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("Invalid TokenLighten usage reset marker");
  }
  let latest: string | null = null;
  for (const line of readFileSync(resetPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const keys = Object.keys(value);
      const candidate = value as { schemaVersion?: unknown; resetAt?: unknown };
      if (
        keys.length !== 2
        || !keys.includes("schemaVersion")
        || !keys.includes("resetAt")
        || candidate.schemaVersion !== 1
        || typeof candidate.resetAt !== "string"
        || !Number.isFinite(Date.parse(candidate.resetAt))
      ) continue;
      latest = candidate.resetAt;
    } catch {
      // A partial final line after a crash leaves the previous reset active.
    }
  }
  return latest;
}

export function resetUsageWindow(
  directory = defaultLogDir(),
): { resetAt: string } {
  const dir = resolve(directory);
  ensurePrivateDir(dir);
  const resetPath = join(dir, USAGE_RESET_FILE);
  if (existsSync(resetPath)) {
    const stat = lstatSync(resetPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error("Invalid TokenLighten usage reset marker");
    }
  }
  const resetAt = new Date().toISOString();
  appendFileSync(
    resetPath,
    `${JSON.stringify({ schemaVersion: 1, resetAt })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  return { resetAt };
}

export function readUsageEvents(
  directory = defaultLogDir(),
  since?: string | null,
  workspaceId?: string | null,
): TokenLightenUsageEvent[] {
  const dir = resolve(directory);
  const sinceMs = since === undefined || since === null ? null : Date.parse(since);
  if (sinceMs !== null && !Number.isFinite(sinceMs)) {
    throw new Error("Invalid TokenLighten usage window start");
  }
  if (!existsSync(dir)) return [];
  const events: TokenLightenUsageEvent[] = [];
  const names = readdirSync(dir)
    .filter((entry) => /^usage-\d{4}-\d{2}-\d{2}\.ndjson$/.test(entry))
    .sort();
  for (const name of names) {
    const logPath = join(dir, name);
    const stat = lstatSync(logPath);
    if (stat.isSymbolicLink() || !stat.isFile()) continue;
    const text = readFileSync(logPath, "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (
          isUsageEvent(parsed)
          && (
            sinceMs === null
            || Date.parse(parsed.occurredAt) >= sinceMs
          )
          && (
            workspaceId === undefined
            || parsed.workspaceId === workspaceId
          )
        ) events.push(parsed);
      } catch {
        // A partial final line after a crash is ignored. Existing evidence
        // remains append-only and is never rewritten during normal recording.
      }
    }
  }
  return events;
}

const EMPTY_AI_LOG_RESULT: AiLogReadResult = {
  records: [],
  sessions: [],
  scannedFiles: 0,
  matchedSessions: 0,
  unattributableSessions: 0,
  skippedFiles: 0,
  warnings: [],
};

function modelPrice(model: string): ModelPrice | null {
  return MODEL_PRICES.find((entry) => entry.pattern.test(model)) ?? null;
}

function sessionModelUsage(
  record: AiUsageRecord,
  manualPrice: number | null,
): TokenLightenSessionModelUsage {
  const price = modelPrice(record.model);
  const actualCostUsd = manualPrice !== null
    ? record.totalTokens * manualPrice / 1_000_000
    : price
      ? (
        record.inputTokens * price.input
        + record.cacheWriteTokens * price.cacheWrite
        + record.cacheReadTokens * price.cacheRead
        + record.outputTokens * price.output
      ) / 1_000_000
      : null;
  return {
    ...record,
    actualCostUsd,
    pricingStatus:
      manualPrice !== null ? "manual"
      : price ? "model"
      : "unknown",
  };
}

function reductionPercent(actual: number, predictedBaseline: number): number | null {
  return predictedBaseline > 0
    ? (predictedBaseline - actual) / predictedBaseline * 100
    : null;
}

function reductionInterval(
  actual: number,
  delta: number,
  relativeError95: number | null,
): { low: number; high: number } | null {
  if (relativeError95 === null) return null;
  const first = reductionPercent(actual, actual + delta * (1 - relativeError95));
  const second = reductionPercent(actual, actual + delta * (1 + relativeError95));
  if (first === null || second === null) return null;
  return { low: Math.min(first, second), high: Math.max(first, second) };
}

interface ClientRateProfile {
  input: number;
  cacheWrite: number;
  cacheRead: number;
}

function rateProfileForClient(
  records: readonly AiUsageRecord[],
  client?: TokenLightenClient,
): ClientRateProfile | null {
  let input = 0;
  let cacheWrite = 0;
  let cacheRead = 0;
  let weight = 0;
  for (const record of records) {
    if (client !== undefined && record.client !== client) continue;
    const price = modelPrice(record.model);
    if (!price) continue;
    const recordWeight = Math.max(
      1,
      record.inputTokens + record.cacheWriteTokens + record.cacheReadTokens,
    );
    input += price.input * recordWeight;
    cacheWrite += price.cacheWrite * recordWeight;
    cacheRead += price.cacheRead * recordWeight;
    weight += recordWeight;
  }
  return weight > 0
    ? { input: input / weight, cacheWrite: cacheWrite / weight, cacheRead: cacheRead / weight }
    : null;
}

function meanTurnsByClient(
  sessions: readonly AiSessionMeta[],
): Partial<Record<TokenLightenClient, number>> {
  const totals = new Map<TokenLightenClient, { turns: number; sessions: number }>();
  for (const session of sessions) {
    const current = totals.get(session.client) ?? { turns: 0, sessions: 0 };
    current.turns += session.turns;
    current.sessions++;
    totals.set(session.client, current);
  }
  const means: Partial<Record<TokenLightenClient, number>> = {};
  for (const [client, value] of totals) {
    means[client] = value.turns / value.sessions;
  }
  return means;
}

function aggregateAiRecords(
  records: readonly AiUsageRecord[],
): AiUsageRecord[] {
  const grouped = new Map<string, AiUsageRecord>();
  for (const record of records) {
    const key = `${record.client}\0${record.model}`;
    const aggregate = grouped.get(key) ?? {
      client: record.client,
      model: record.model,
      inputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      requestCount: 0,
    };
    aggregate.inputTokens += record.inputTokens;
    aggregate.cacheWriteTokens += record.cacheWriteTokens;
    aggregate.cacheReadTokens += record.cacheReadTokens;
    aggregate.outputTokens += record.outputTokens;
    aggregate.totalTokens += record.totalTokens;
    aggregate.requestCount += record.requestCount;
    grouped.set(key, aggregate);
  }
  return [...grouped.values()].filter((record) => record.totalTokens > 0);
}

function sessionEstimate(
  aiLogs: AiLogReadResult,
  savedTokensByClient: Readonly<Record<TokenLightenClient, number>>,
  measuredCallsByClient: Readonly<Record<TokenLightenClient, number>>,
  manualPrice: number | null,
): TokenLightenUsageSummary["sessionEstimate"] {
  const aggregateRecords = aggregateAiRecords(aiLogs.records);
  const models = aggregateRecords.map(
    (record) => sessionModelUsage(record, manualPrice),
  );
  const observedClients = new Set(aggregateRecords.map((record) => record.client));
  const actualTotalTokens = models.length
    ? models.reduce((sum, model) => sum + model.totalTokens, 0)
    : null;
  const allocateUnattributed =
    !observedClients.has("other")
    && measuredCallsByClient.other > 0
    && observedClients.size > 0;
  const hasCounterfactual =
    allocateUnattributed
    || [...observedClients].some(
      (client) => measuredCallsByClient[client] > 0,
    );
  const sessions = aiLogs.sessions ?? [];
  const meanTurns = meanTurnsByClient(sessions);
  const overallMeanTurns = sessions.length > 0
    ? sessions.reduce((sum, session) => sum + session.turns, 0)
      / sessions.length
    : null;
  const residualFactorForClient = (client: TokenLightenClient): number => {
    const turns = meanTurns[client] ?? overallMeanTurns;
    return turns === null ? 1 : 1 + RESIDUAL_TURN_SHARE * turns;
  };
  const residencyClients = new Set<TokenLightenClient>([
    ...(Object.keys(meanTurns) as TokenLightenClient[]),
    ...observedClients,
  ]);
  if (allocateUnattributed) residencyClients.add("other");
  const residualFactorByClient: Partial<Record<TokenLightenClient, number>> = {};
  for (const client of residencyClients) {
    residualFactorByClient[client] = residualFactorForClient(client);
  }
  const residencyModel = sessions.length > 0
    ? {
        version: "residual-turns-v1" as const,
        meanTurnsByClient: meanTurns,
        residualFactorByClient,
      }
    : null;
  const signedContributionByClient = new Map<TokenLightenClient, number>();
  for (const client of observedClients) {
    signedContributionByClient.set(
      client,
      savedTokensByClient[client]
        * residualFactorForClient(client)
        * SESSION_ESTIMATOR_CALIBRATION.tokenDeltaMultiplierByClient[client],
    );
  }
  if (allocateUnattributed) {
    signedContributionByClient.set(
      "other",
      savedTokensByClient.other
        * residualFactorForClient("other")
        * SESSION_ESTIMATOR_CALIBRATION.tokenDeltaMultiplierByClient.other,
    );
  }
  const predictedSavedTokens = [...signedContributionByClient.values()]
    .reduce((sum, contribution) => sum + contribution, 0);
  const absoluteContributions = [...signedContributionByClient.entries()].map(
    ([client, contribution]) => ({
      client,
      contribution: Math.abs(contribution),
    }),
  );
  const totalAbsoluteContribution = absoluteContributions.reduce(
    (sum, { contribution }) => sum + contribution,
    0,
  );
  const materialContributions = totalAbsoluteContribution > 0
    ? absoluteContributions.filter(
      ({ contribution }) =>
        contribution / totalAbsoluteContribution > CALIBRATION_MATERIALITY,
    )
    : [];
  const hasDirectMediumOrBetter = [...CLIENTS].some((client) => {
    const relativeError95 =
      SESSION_ESTIMATOR_CALIBRATION.relativeError95ByClient[client];
    return SESSION_ESTIMATOR_CALIBRATION.sourceByClient[client] === "paired-direct"
      && SESSION_ESTIMATOR_CALIBRATION.sampleCountByClient[client]
        >= CALIBRATION_MIN_SAMPLE_COUNT
      && relativeError95 !== null
      && relativeError95 <= CALIBRATION_DIRECT_MEDIUM_MAX_RELATIVE_ERROR95;
  });
  const pairedContributions = absoluteContributions.filter(({ client }) =>
    SESSION_ESTIMATOR_CALIBRATION.sourceByClient[client] !== "analytic-fallback"
    && SESSION_ESTIMATOR_CALIBRATION.relativeError95ByClient[client] !== null
  );
  const totalPairedContribution = pairedContributions.reduce(
    (sum, { contribution }) => sum + contribution,
    0,
  );
  const scopeRelativeError95 =
    materialContributions.length > 0
    && materialContributions.every(({ client }) =>
      SESSION_ESTIMATOR_CALIBRATION.sourceByClient[client] !== "analytic-fallback"
      && SESSION_ESTIMATOR_CALIBRATION.relativeError95ByClient[client] !== null
    )
    && totalPairedContribution > 0
      ? pairedContributions.reduce(
        (weightedError, { client, contribution }) =>
          weightedError
          + contribution
            * SESSION_ESTIMATOR_CALIBRATION.relativeError95ByClient[client]!,
        0,
      ) / totalPairedContribution
      : null;
  const predictedWithoutTlTokens =
    actualTotalTokens !== null && hasCounterfactual
      ? Math.max(0, actualTotalTokens + predictedSavedTokens)
      : null;
  const pricedModels = models.filter((model) => model.actualCostUsd !== null);
  const actualTotalCostUsd = pricedModels.length > 0
    ? pricedModels.reduce((sum, model) => sum + model.actualCostUsd!, 0)
    : null;
  const totalTokensAll = models.reduce((sum, model) => sum + model.totalTokens, 0);
  const unpricedTokens = models
    .filter((model) => model.actualCostUsd === null)
    .reduce((sum, model) => sum + model.totalTokens, 0);
  const unpricedTokenShare = totalTokensAll > 0
    ? unpricedTokens / totalTokensAll
    : null;
  let predictedSavedCostUsd = 0;
  const costAvailable = hasCounterfactual;
  if (manualPrice !== null) {
    predictedSavedCostUsd = predictedSavedTokens * manualPrice / 1_000_000;
  } else {
    for (const client of observedClients) {
      if (measuredCallsByClient[client] === 0) continue;
      const profile = rateProfileForClient(aggregateRecords, client);
      if (profile === null) continue;
      const avoidedPerMillion = profile.cacheWrite
        + (residualFactorForClient(client) - 1) * profile.cacheRead;
      predictedSavedCostUsd +=
        savedTokensByClient[client]
        * SESSION_ESTIMATOR_CALIBRATION.tokenDeltaMultiplierByClient[client]
        * avoidedPerMillion / 1_000_000;
    }
    if (allocateUnattributed) {
      const profile = rateProfileForClient(aggregateRecords);
      if (profile !== null) {
        const avoidedPerMillion = profile.cacheWrite
          + (residualFactorForClient("other") - 1) * profile.cacheRead;
        predictedSavedCostUsd +=
          savedTokensByClient.other
          * SESSION_ESTIMATOR_CALIBRATION.tokenDeltaMultiplierByClient.other
          * avoidedPerMillion / 1_000_000;
      }
    }
  }
  const predictedWithoutTlCostUsd =
    actualTotalCostUsd !== null && costAvailable
      ? Math.max(0, actualTotalCostUsd + predictedSavedCostUsd)
      : null;
  const warnings = new Set(aiLogs.warnings);
  if (allocateUnattributed) warnings.add("unattributed-mcp-events-allocated");
  if (models.length === 0) warnings.add("provider-usage-logs-unavailable");
  if (!hasCounterfactual) warnings.add("matching-mcp-baseline-unavailable");
  if (unpricedTokenShare !== null && unpricedTokenShare > 0) {
    warnings.add("one-or-more-models-unpriced");
  }
  if ([...CLIENTS].some(
    (client) => client !== "other"
      && measuredCallsByClient[client] > 0
      && !observedClients.has(client),
  )) {
    warnings.add("unmatched-mcp-client-savings-excluded");
  }
  if (SESSION_ESTIMATOR_CALIBRATION.source === "analytic-fallback") {
    warnings.add("analytic-fallback-no-paired-coefficients");
  }
  const status =
    actualTotalTokens !== null && predictedWithoutTlTokens !== null
      ? "estimated"
      : "provider-logs-unavailable";
  let contributionConfidence: "low" | "medium" | "high" = "high";
  if (materialContributions.length === 0) {
    contributionConfidence = "low";
  } else {
    for (const { client } of materialContributions) {
      const source = SESSION_ESTIMATOR_CALIBRATION.sourceByClient[client];
      const sampleCount =
        SESSION_ESTIMATOR_CALIBRATION.sampleCountByClient[client];
      const relativeError95 =
        SESSION_ESTIMATOR_CALIBRATION.relativeError95ByClient[client];
      const clientConfidence =
        source === "paired-direct"
          && sampleCount >= CALIBRATION_HIGH_SAMPLE_COUNT
          && relativeError95 !== null
          && relativeError95 <= CALIBRATION_HIGH_MAX_RELATIVE_ERROR95
          ? "high"
          : source === "paired-direct"
            && sampleCount >= CALIBRATION_MIN_SAMPLE_COUNT
            && relativeError95 !== null
            && relativeError95
              <= CALIBRATION_DIRECT_MEDIUM_MAX_RELATIVE_ERROR95
            ? "medium"
            : source === "paired-transferred"
              && hasDirectMediumOrBetter
              && relativeError95 !== null
              && relativeError95
                <= CALIBRATION_TRANSFERRED_MEDIUM_MAX_RELATIVE_ERROR95
              ? "medium"
              : "low";
      if (clientConfidence === "low") {
        contributionConfidence = "low";
        break;
      }
      if (clientConfidence === "medium") {
        contributionConfidence = "medium";
      }
    }
  }
  const confidence =
    status === "estimated" ? contributionConfidence : "unavailable";
  return {
    status,
    method: "local-ai-logs+deterministic-calibration",
    actualTotalTokens,
    predictedWithoutTlTokens,
    predictedSavedTokens: hasCounterfactual ? predictedSavedTokens : null,
    tokenReductionPercent:
      actualTotalTokens !== null && predictedWithoutTlTokens !== null
        ? reductionPercent(actualTotalTokens, predictedWithoutTlTokens)
        : null,
    tokenReductionPercent95:
      actualTotalTokens !== null && hasCounterfactual
        ? reductionInterval(
          actualTotalTokens,
          predictedSavedTokens,
          scopeRelativeError95,
        )
        : null,
    actualTotalCostUsd,
    predictedWithoutTlCostUsd,
    predictedSavedCostUsd:
      actualTotalCostUsd !== null && costAvailable
        ? predictedSavedCostUsd
        : null,
    costReductionPercent:
      actualTotalCostUsd !== null && predictedWithoutTlCostUsd !== null
        ? reductionPercent(actualTotalCostUsd, predictedWithoutTlCostUsd)
        : null,
    costReductionPercent95:
      actualTotalCostUsd !== null && costAvailable
        ? reductionInterval(
          actualTotalCostUsd,
          predictedSavedCostUsd,
          scopeRelativeError95,
        )
        : null,
    confidence,
    matchedSessions: aiLogs.matchedSessions,
    models,
    residencyModel,
    unpricedTokenShare,
    warnings: [...warnings],
    calibration: {
      version: SESSION_ESTIMATOR_CALIBRATION.version,
      calibratedAt: SESSION_ESTIMATOR_CALIBRATION.calibratedAt,
      source: SESSION_ESTIMATOR_CALIBRATION.source,
      rawPairedBillingIncluded:
        SESSION_ESTIMATOR_CALIBRATION.rawPairedBillingIncluded,
      sampleCount: SESSION_ESTIMATOR_CALIBRATION.sampleCount,
    },
  };
}

export function summarizeUsage(
  events: readonly TokenLightenUsageEvent[],
  costPerMillionTokensUsd?: number | null,
  aiLogs: AiLogReadResult = EMPTY_AI_LOG_RESULT,
  options?: { scope?: TokenLightenSummaryScope },
): TokenLightenUsageSummary {
  const byTool: TokenLightenUsageSummary["byTool"] = {
    read_file: 0,
    search_files: 0,
    edit_file: 0,
  };
  const byClient: TokenLightenUsageSummary["byClient"] = {
    vscode: 0,
    codex: 0,
    "claude-code": 0,
    desktop: 0,
    other: 0,
  };
  const savedTokensByClient: Record<TokenLightenClient, number> = {
    vscode: 0,
    codex: 0,
    "claude-code": 0,
    desktop: 0,
    other: 0,
  };
  const measuredCallsByClient: Record<TokenLightenClient, number> = {
    vscode: 0,
    codex: 0,
    "claude-code": 0,
    desktop: 0,
    other: 0,
  };
  let successfulCalls = 0;
  let estimatedResponseTokens = 0;
  let measuredBaselineCalls = 0;
  let measuredResponseTokens = 0;
  let measuredBaselineTokens = 0;
  let estimatedSavedTokens = 0;
  let automaticallyEstimatedSavedCostUsd = 0;
  let automaticallyEstimatedBaselineCostUsd = 0;
  for (const event of events) {
    byTool[event.tool]++;
    byClient[event.client]++;
    if (event.outcome === "ok") successfulCalls++;
    estimatedResponseTokens += event.estimatedResponseTokens;
    if (event.outcome === "ok" && event.baselineTokens !== null) {
      const signedSavedTokens =
        event.baselineTokens - event.estimatedResponseTokens;
      measuredBaselineCalls++;
      measuredCallsByClient[event.client]++;
      measuredResponseTokens += event.estimatedResponseTokens;
      measuredBaselineTokens += event.baselineTokens;
      estimatedSavedTokens += signedSavedTokens;
      savedTokensByClient[event.client] += signedSavedTokens;
      const automaticRate =
        AUTOMATIC_PRICING.byClient[event.client].costPerMillionTokensUsd;
      automaticallyEstimatedSavedCostUsd +=
        signedSavedTokens * automaticRate / 1_000_000;
      automaticallyEstimatedBaselineCostUsd +=
        event.baselineTokens * automaticRate / 1_000_000;
    }
  }
  const price =
    costPerMillionTokensUsd !== undefined
      && costPerMillionTokensUsd !== null
      && Number.isFinite(costPerMillionTokensUsd)
      && costPerMillionTokensUsd >= 0
      ? costPerMillionTokensUsd
      : null;
  const estimatedTokenReductionPercent =
    measuredBaselineTokens > 0
      ? estimatedSavedTokens / measuredBaselineTokens * 100
      : null;
  const estimatedSavedCostUsd =
    price === null
      ? automaticallyEstimatedSavedCostUsd
      : estimatedSavedTokens * price / 1_000_000;
  const estimatedBaselineCostUsd =
    price === null
      ? automaticallyEstimatedBaselineCostUsd
      : measuredBaselineTokens * price / 1_000_000;
  return {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    scope: options?.scope ?? { kind: "machine" },
    eventCount: events.length,
    successfulCalls,
    failedCalls: events.length - successfulCalls,
    estimatedResponseTokens,
    measuredBaselineCalls,
    measuredResponseTokens,
    measuredBaselineTokens,
    estimatedSavedTokens,
    estimatedReductionPercent: estimatedTokenReductionPercent,
    estimatedTokenReductionPercent,
    estimatedBaselineCostUsd,
    estimatedCostReductionPercent:
      estimatedBaselineCostUsd > 0
        ? estimatedSavedCostUsd / estimatedBaselineCostUsd * 100
        : null,
    pricingMode: price === null ? "automatic" : "manual",
    costPerMillionTokensUsd: price,
    automaticPricing: AUTOMATIC_PRICING,
    estimatedSavedCostUsd,
    sessionEstimate: sessionEstimate(
      aiLogs,
      savedTokensByClient,
      measuredCallsByClient,
      price,
    ),
    byTool,
    byClient,
  };
}

export function privacyReport(): TokenLightenPrivacyReport {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    localOnly: true,
    automaticUpload: false,
    containsPromptText: false,
    containsFilePaths: false,
    containsSourceText: false,
    containsToolArguments: false,
    containsErrorMessages: false,
    recordedFields: EVENT_FIELDS,
  };
}

export async function exportUsageBundle(options: {
  outputPath: string;
  directory?: string;
  costPerMillionTokensUsd?: number | null;
  appVersion?: string;
  workspaceId?: string | null;
  workspaceRoot?: string | null;
}): Promise<{ outputPath: string; summary: TokenLightenUsageSummary }> {
  const outputPath = resolve(options.outputPath);
  const since = usageWindowStart(options.directory);
  const events = options.workspaceId === null
    ? []
    : readUsageEvents(
      options.directory,
      since,
      options.workspaceId,
    );
  const scope: TokenLightenSummaryScope = options.workspaceId === undefined
    ? { kind: "machine" }
    : { kind: "workspace", workspaceId: options.workspaceId };
  const aiLogs = options.workspaceId !== undefined && options.workspaceRoot == null
    ? EMPTY_AI_LOG_RESULT
    : readAiUsageLogs({ since, workspaceRoot: options.workspaceRoot ?? null });
  const summary = summarizeUsage(
    events,
    options.costPerMillionTokensUsd,
    aiLogs,
    { scope },
  );
  const manifest: TokenLightenUsageExportManifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    format: "tokenlighten-usage-bundle",
    files: [
      "manifest.json",
      "usage.ndjson",
      "summary.json",
      "diagnostics.json",
      "privacy-report.json",
    ],
  };
  const diagnostics = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    appVersion: options.appVersion ?? "unknown",
    nodeMajor: Number(process.versions.node.split(".")[0]),
    platform: platform(),
    platformReleaseMajor: release().split(".")[0],
  };
  const zip = new JSZip();
  zip.file("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
  zip.file(
    "usage.ndjson",
    events.map((event) => JSON.stringify(event)).join("\n")
      + (events.length ? "\n" : ""),
  );
  zip.file("summary.json", `${JSON.stringify(summary, null, 2)}\n`);
  zip.file("diagnostics.json", `${JSON.stringify(diagnostics, null, 2)}\n`);
  zip.file("privacy-report.json", `${JSON.stringify(privacyReport(), null, 2)}\n`);
  const bytes = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
  });
  mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
  const temporary =
    `${outputPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temporary, bytes, { mode: 0o600 });
  renameSync(temporary, outputPath);
  return { outputPath, summary };
}

export function usageLogDirectory(options?: { ensure?: boolean }): string {
  const directory = defaultLogDir();
  if (options?.ensure) ensurePrivateDir(directory);
  return directory;
}
