import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { TokenLightenClient } from "@tokenlighten/types";

const JSONL_FILE = /\.jsonl$/i;
const TOKENLIGHTEN_TOOL = /^(?:mcp__)?tokenlighten(?:__|:|$)/i;
const TOOL_NAME_KEYS = new Set([
  "name",
  "tool",
  "tool_name",
  "server",
  "server_name",
]);
const MAX_LOG_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_FILES = 2_000;

export interface AiUsageRecord {
  client: TokenLightenClient;
  model: string;
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  totalTokens: number;
  requestCount: number;
}

export interface AiSessionMeta {
  client: "codex" | "claude-code";
  /** Model requests in the usage window for this session (proxy for turns). */
  turns: number;
}

export interface AiLogReadResult {
  records: AiUsageRecord[];
  sessions: AiSessionMeta[];
  scannedFiles: number;
  matchedSessions: number;
  unattributableSessions: number;
  skippedFiles: number;
  warnings: string[];
}

export interface AiLogReadOptions {
  codexSessionsDirectory?: string | null;
  claudeProjectsDirectory?: string | null;
  maxFiles?: number;
  since?: string | null;
  /** Absolute workspace root used to include only attributable sessions. */
  workspaceRoot?: string | null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function sessionCwd(
  client: "codex" | "claude-code",
  values: readonly unknown[],
): string | null {
  for (const value of values) {
    const row = objectValue(value);
    if (!row) continue;
    if (client === "claude-code") {
      const cwd = row["cwd"];
      if (typeof cwd === "string" && cwd.length > 0) return cwd;
    } else {
      const payload = objectValue(row["payload"]);
      const cwd = payload?.["cwd"] ?? row["cwd"];
      if (
        (
          row["type"] === "session_meta"
          || payload?.["type"] === "session_meta"
          || cwd !== undefined
        )
        && typeof cwd === "string"
        && cwd.length > 0
      ) return cwd;
    }
  }
  return null;
}

/** Launch-context-stable form of a workspace path: symlinks resolved (realpath
 *  also restores on-disk casing on case-folding filesystems), trailing
 *  separators stripped, original case preserved. This exact string feeds the
 *  workspaceId hash, so it must not vary with how the process was launched. */
export function canonicalWorkspacePath(path: string): string {
  let canonical = resolve(path);
  try {
    canonical = realpathSync.native(canonical);
  } catch {
    // Preserve the resolved path when the target does not exist.
  }
  if (canonical.length > 1) {
    let end = canonical.length;
    while (end > 1 && (canonical[end - 1] === "/" || canonical[end - 1] === "\\")) end--;
    canonical = canonical.slice(0, end);
  }
  return canonical;
}

export function normalizeRealPath(path: string): string {
  const canonical = canonicalWorkspacePath(path);
  return process.platform === "win32" || process.platform === "darwin"
    ? canonical.toLowerCase()
    : canonical;
}

export function cwdBelongsToRoot(cwd: string, normalizedRoot: string): boolean {
  const normalizedCwd = normalizeRealPath(cwd);
  return normalizedCwd === normalizedRoot
    || normalizedCwd.startsWith(normalizedRoot + sep);
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.round(value))
    : 0;
}

function sinceMilliseconds(since: string | null | undefined): number | null {
  if (since === undefined || since === null) return null;
  const parsed = Date.parse(since);
  if (!Number.isFinite(parsed)) throw new Error("Invalid AI usage window start");
  return parsed;
}

function rowTimestampMilliseconds(value: unknown): number | null {
  const row = objectValue(value);
  const candidate = row?.["timestamp"] ?? row?.["created_at"];
  if (typeof candidate !== "string") return null;
  const parsed = Date.parse(candidate);
  return Number.isFinite(parsed) ? parsed : null;
}

function isInUsageWindow(value: unknown, sinceMs: number | null): boolean {
  if (sinceMs === null) return true;
  const timestamp = rowTimestampMilliseconds(value);
  return timestamp !== null && timestamp >= sinceMs;
}

function containsTokenLightenTool(value: unknown, depth = 0): boolean {
  if (depth > 12) return false;
  if (Array.isArray(value)) {
    return value.some((item) => containsTokenLightenTool(item, depth + 1));
  }
  const object = objectValue(value);
  if (!object) return false;
  for (const [key, child] of Object.entries(object)) {
    if (
      TOOL_NAME_KEYS.has(key)
      && typeof child === "string"
      && TOKENLIGHTEN_TOOL.test(child)
    ) {
      return true;
    }
    if (typeof child === "object" && containsTokenLightenTool(child, depth + 1)) {
      return true;
    }
  }
  return false;
}

function jsonLines(text: string): unknown[] {
  const values: unknown[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      values.push(JSON.parse(line) as unknown);
    } catch {
      // A partial final line is expected when a client is still writing.
    }
  }
  return values;
}

function listJsonlFiles(root: string, limit: number): string[] {
  if (!existsSync(root)) return [];
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return [];
  const files: string[] = [];
  const pending = [root];
  while (pending.length && files.length < limit) {
    const directory = pending.pop()!;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (files.length >= limit || entry.isSymbolicLink()) break;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && JSONL_FILE.test(entry.name)) files.push(path);
    }
  }
  return files;
}

function readLog(path: string): string | null {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_LOG_BYTES) {
      return null;
    }
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function claudeRecords(
  values: readonly unknown[],
  sinceMs: number | null,
): AiUsageRecord[] {
  if (!values.some(
    (value) => isInUsageWindow(value, sinceMs) && containsTokenLightenTool(value),
  )) return [];
  const messages = new Map<string, AiUsageRecord>();
  let sequence = 0;
  for (const value of values) {
    const row = objectValue(value);
    if (
      !row
      || row["type"] !== "assistant"
      || !isInUsageWindow(value, sinceMs)
    ) continue;
    const message = objectValue(row["message"]);
    const usage = objectValue(message?.["usage"]);
    if (!message || !usage) continue;
    const model = typeof message["model"] === "string"
      ? message["model"]
      : "unknown";
    const inputTokens = nonNegativeInteger(usage["input_tokens"]);
    const cacheWriteTokens = nonNegativeInteger(
      usage["cache_creation_input_tokens"],
    );
    const cacheReadTokens = nonNegativeInteger(usage["cache_read_input_tokens"]);
    const outputTokens = nonNegativeInteger(usage["output_tokens"]);
    const totalTokens =
      inputTokens + cacheWriteTokens + cacheReadTokens + outputTokens;
    const keyCandidate =
      typeof message["id"] === "string" ? message["id"]
      : typeof row["requestId"] === "string" ? row["requestId"]
      : typeof row["uuid"] === "string" ? row["uuid"]
      : `line-${sequence++}`;
    const key = `${model}\0${keyCandidate}`;
    const candidate: AiUsageRecord = {
      client: "claude-code",
      model,
      inputTokens,
      cacheWriteTokens,
      cacheReadTokens,
      outputTokens,
      totalTokens,
      requestCount: 1,
    };
    const previous = messages.get(key);
    if (!previous || candidate.totalTokens > previous.totalTokens) {
      messages.set(key, candidate);
    }
  }
  const byModel = new Map<string, AiUsageRecord>();
  for (const record of messages.values()) {
    const total = byModel.get(record.model) ?? {
      client: "claude-code",
      model: record.model,
      inputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      requestCount: 0,
    };
    total.inputTokens += record.inputTokens;
    total.cacheWriteTokens += record.cacheWriteTokens;
    total.cacheReadTokens += record.cacheReadTokens;
    total.outputTokens += record.outputTokens;
    total.totalTokens += record.totalTokens;
    total.requestCount += 1;
    byModel.set(record.model, total);
  }
  return [...byModel.values()];
}

function codexRecord(
  values: readonly unknown[],
  sinceMs: number | null,
): AiUsageRecord | null {
  if (!values.some(
    (value) => isInUsageWindow(value, sinceMs) && containsTokenLightenTool(value),
  )) return null;
  let model = "unknown";
  type Snapshot = {
    inputTokens: number;
    cacheReadTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  let baseline: Snapshot | undefined;
  let latest: Snapshot | undefined;
  let requestCount = 0;
  for (const value of values) {
    const row = objectValue(value);
    const payload = objectValue(row?.["payload"]);
    if (!row || !payload) continue;
    if (
      (row["type"] === "turn_context" || payload["type"] === "turn_context")
      && typeof payload["model"] === "string"
    ) {
      model = payload["model"];
    }
    if (payload["type"] !== "token_count") continue;
    const info = objectValue(payload["info"]);
    const usage = objectValue(info?.["total_token_usage"]);
    if (!usage) continue;
    const allInputTokens = nonNegativeInteger(usage["input_tokens"]);
    const cacheReadTokens = nonNegativeInteger(usage["cached_input_tokens"]);
    const outputTokens = nonNegativeInteger(usage["output_tokens"]);
    const reportedTotal = nonNegativeInteger(usage["total_tokens"]);
    const snapshot: Snapshot = {
      inputTokens: Math.max(0, allInputTokens - cacheReadTokens),
      cacheReadTokens,
      outputTokens,
      totalTokens: reportedTotal || allInputTokens + outputTokens,
    };
    if (sinceMs !== null) {
      const timestamp = rowTimestampMilliseconds(value);
      if (timestamp === null) continue;
      if (timestamp < sinceMs) {
        baseline = snapshot;
        continue;
      }
    }
    latest = snapshot;
    requestCount++;
  }
  if (!latest) return null;
  const previous = baseline ?? {
    inputTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
  const inputTokens = Math.max(0, latest.inputTokens - previous.inputTokens);
  const cacheReadTokens = Math.max(
    0,
    latest.cacheReadTokens - previous.cacheReadTokens,
  );
  const outputTokens = Math.max(0, latest.outputTokens - previous.outputTokens);
  const totalTokens = Math.max(0, latest.totalTokens - previous.totalTokens);
  return {
    client: "codex",
    model,
    inputTokens,
    cacheWriteTokens: 0,
    cacheReadTokens,
    outputTokens,
    totalTokens,
    requestCount,
  };
}

function defaultCodexDirectory(): string {
  return resolve(
    process.env["TOKENLIGHTEN_CODEX_LOG_HOME"]
      ?? join(homedir(), ".codex", "sessions"),
  );
}

function defaultClaudeDirectory(): string {
  return resolve(
    process.env["TOKENLIGHTEN_CLAUDE_LOG_HOME"]
      ?? join(homedir(), ".claude", "projects"),
  );
}

/**
 * Reads structured usage counters from local AI-client logs.
 *
 * Prompt text, source text, file paths, and tool arguments are neither retained
 * nor returned. Files are accepted only when a structured tool-name field shows
 * that the session actually used TokenLighten.
 */
export function readAiUsageLogs(options: AiLogReadOptions = {}): AiLogReadResult {
  const disabledByEnvironment = /^(0|false|off|no)$/i.test(
    process.env["TOKENLIGHTEN_AI_LOG_SCAN"] ?? "",
  );
  const disabledImplicitTestScan =
    process.env["NODE_ENV"] === "test"
    && options.codexSessionsDirectory === undefined
    && options.claudeProjectsDirectory === undefined;
  if (disabledByEnvironment || disabledImplicitTestScan) {
    return {
      records: [],
      sessions: [],
      scannedFiles: 0,
      matchedSessions: 0,
      unattributableSessions: 0,
      skippedFiles: 0,
      warnings: [
        disabledImplicitTestScan
          ? "implicit-ai-log-scan-disabled-in-tests"
          : "ai-log-scan-disabled",
      ],
    };
  }
  const sinceMs = sinceMilliseconds(options.since);
  const workspaceRoot = options.workspaceRoot == null
    ? null
    : normalizeRealPath(options.workspaceRoot);
  const maxFiles = Math.max(
    1,
    Math.min(options.maxFiles ?? DEFAULT_MAX_FILES, DEFAULT_MAX_FILES),
  );
  const roots: Array<{
    client: "codex" | "claude-code";
    directory: string | null;
  }> = [
    {
      client: "codex",
      directory: options.codexSessionsDirectory === undefined
        ? defaultCodexDirectory()
        : options.codexSessionsDirectory,
    },
    {
      client: "claude-code",
      directory: options.claudeProjectsDirectory === undefined
        ? defaultClaudeDirectory()
        : options.claudeProjectsDirectory,
    },
  ];
  const records: AiUsageRecord[] = [];
  const sessions: AiSessionMeta[] = [];
  let scannedFiles = 0;
  let matchedSessions = 0;
  let unattributableSessions = 0;
  let skippedFiles = 0;
  const warnings = new Set<string>();
  for (const root of roots) {
    if (root.directory === null) continue;
    const files = listJsonlFiles(resolve(root.directory), maxFiles - scannedFiles);
    if (files.length === 0) warnings.add(`${root.client}-logs-unavailable`);
    for (const path of files) {
      scannedFiles++;
      const text = readLog(path);
      if (text === null) {
        skippedFiles++;
        continue;
      }
      const values = jsonLines(text);
      const sessionRecords = root.client === "codex"
        ? [codexRecord(values, sinceMs)].filter(
          (record): record is AiUsageRecord => record !== null,
        )
        : claudeRecords(values, sinceMs);
      // Sessions that never used TokenLighten are out of scope entirely, so
      // they must not count toward (or warn about) unattributable exclusions.
      if (sessionRecords.length === 0) continue;
      if (workspaceRoot !== null) {
        const cwd = sessionCwd(root.client, values);
        if (cwd === null) {
          unattributableSessions++;
          warnings.add("unattributable-ai-sessions-excluded");
          continue;
        }
        if (!cwdBelongsToRoot(cwd, workspaceRoot)) continue;
      }
      if (sessionRecords.length > 0) {
        matchedSessions++;
        records.push(...sessionRecords);
        const turns = sessionRecords.reduce(
          (sum, record) => sum + record.requestCount,
          0,
        );
        if (turns > 0) sessions.push({ client: root.client, turns });
      }
    }
    if (scannedFiles >= maxFiles) {
      warnings.add("ai-log-file-limit-reached");
      break;
    }
  }
  return {
    records,
    sessions,
    scannedFiles,
    matchedSessions,
    unattributableSessions,
    skippedFiles,
    warnings: [...warnings],
  };
}
