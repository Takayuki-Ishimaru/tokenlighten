/**
 * parsers/codex.ts — V11-08 Attribution & Calibration v2.
 *
 * Parses Codex CLI's local JSONL session log lines — the exact shape
 * aiLogs.ts's `codexRecord()` already reads (`session_meta` / `turn_context`
 * / `response_item` function_call / `token_count` event rows) — into the
 * richer, per-turn NormalizedSessionUsage shape.
 *
 * Codex reports `info.total_token_usage` as a CUMULATIVE running total for
 * the whole session on every `token_count` event (confirmed by aiLogs.ts's
 * own baseline/latest whole-session delta logic in `codexRecord()`). This
 * parser deltas CONSECUTIVE snapshots into one NormalizedTurnUsage per
 * `token_count` event instead of aiLogs.ts's single whole-session delta, to
 * expose per-turn granularity for sessionMatcher.ts's fingerprint scoring.
 *
 * This is a NEW, stricter SIBLING of aiLogs.ts's `codexRecord()` — that
 * function keeps shipping the coarser whole-session shape index.ts's
 * summarizeUsage() already depends on; this parser does not replace it.
 */

import type {
  NormalizedSessionUsage,
  NormalizedTokenCounts,
  NormalizedTurnUsage,
  TokenCount,
} from "./types.js";
import { knownTokenCount, sumTokenCounts, unknownTokenCount } from "./types.js";

export const CODEX_PARSER_VERSION = "codex-log-parser-v1";

const TOKENLIGHTEN_TOOL = /^(?:mcp__)?tokenlighten(?:__|:)/i;
const KNOWN_USAGE_KEYS = new Set([
  "input_tokens",
  "cached_input_tokens",
  "output_tokens",
  "total_tokens",
  "reasoning_tokens",
  "output_tokens_details",
]);

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numeric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

interface CumulativeSnapshot {
  /** Raw input_tokens as reported — INCLUDES cached_input_tokens (Codex's
   *  own field semantics; see uncachedInput() below). */
  input: number | null;
  cacheRead: number | null;
  output: number | null;
  /** Present only on richer logs — most Codex sessions never report this. */
  reasoning: number | null;
}

function readSnapshot(usage: Record<string, unknown>): CumulativeSnapshot {
  const detail = objectValue(usage["output_tokens_details"]);
  const reasoningRaw = usage["reasoning_tokens"] ?? detail?.["reasoning_tokens"];
  return {
    input: numeric(usage["input_tokens"]),
    cacheRead: numeric(usage["cached_input_tokens"]),
    output: numeric(usage["output_tokens"]),
    reasoning: numeric(reasoningRaw),
  };
}

/** Codex's `input_tokens` includes `cached_input_tokens` (mirrors
 *  aiLogs.ts's codexRecord: `allInputTokens - cacheReadTokens`) — this
 *  returns the UNCACHED portion, matching Anthropic's convention of
 *  input / cache-read being mutually exclusive buckets. Null propagates
 *  when either raw field is missing, never silently substituting 0. */
function uncachedInput(snapshot: CumulativeSnapshot): number | null {
  return snapshot.input === null || snapshot.cacheRead === null
    ? null
    : snapshot.input - snapshot.cacheRead;
}

function deltaCount(
  current: number | null,
  previous: number | null,
  label: string,
  turnIndex: number,
  warnings: string[],
): TokenCount {
  if (current === null) {
    return unknownTokenCount(`token_count event omitted ${label}`);
  }
  if (previous === null) {
    // First token_count event in the session: the cumulative snapshot IS
    // the delta (nothing preceded it).
    return knownTokenCount(current);
  }
  const delta = current - previous;
  if (delta < 0) {
    warnings.push(
      `turn ${turnIndex}: ${label} counter went backwards `
      + `(${previous} -> ${current}) — treated as unknown, not clamped`,
    );
    return unknownTokenCount(`non-monotonic ${label} counter across turns`);
  }
  return knownTokenCount(delta);
}

/**
 * Parses ONE Codex session's already-JSON-parsed log lines (see jsonl.ts's
 * `splitJsonLines` for turning raw file text into this array). Pure: never
 * mutates `lines`, never touches the filesystem.
 */
export function parseCodexSession(lines: readonly unknown[]): NormalizedSessionUsage {
  let sessionCwd: string | null = null;
  let usedTokenLighten = false;
  let currentModel = "unknown";
  let pendingToolCalls: string[] = [];
  const turns: NormalizedTurnUsage[] = [];
  const warnings: string[] = [];
  let previous: CumulativeSnapshot | null = null;

  for (const line of lines) {
    const row = objectValue(line);
    if (!row) continue;
    const payload = objectValue(row["payload"]);

    if (sessionCwd === null) {
      const cwd = payload?.["cwd"] ?? row["cwd"];
      if (
        (
          row["type"] === "session_meta"
          || payload?.["type"] === "session_meta"
          || cwd !== undefined
        )
        && typeof cwd === "string"
        && cwd.length > 0
      ) {
        sessionCwd = cwd;
      }
    }
    if (!payload) continue;

    if (
      (row["type"] === "turn_context" || payload["type"] === "turn_context")
      && typeof payload["model"] === "string"
    ) {
      currentModel = payload["model"];
    }

    if (payload["type"] === "function_call" && typeof payload["name"] === "string") {
      pendingToolCalls.push(payload["name"]);
      if (TOKENLIGHTEN_TOOL.test(payload["name"])) usedTokenLighten = true;
    }

    if (payload["type"] !== "token_count") continue;
    const info = objectValue(payload["info"]);
    const usage = objectValue(info?.["total_token_usage"]);
    if (!usage) continue;

    const timestamp = typeof row["timestamp"] === "string" ? row["timestamp"] : null;
    const snapshot = readSnapshot(usage);
    const turnIndex = turns.length;
    const currentUncached = uncachedInput(snapshot);
    const previousUncached = previous ? uncachedInput(previous) : null;
    const counts: NormalizedTokenCounts = {
      input: currentUncached === null
        ? unknownTokenCount("token_count event omitted input_tokens or cached_input_tokens")
        : deltaCount(currentUncached, previousUncached, "uncached input_tokens", turnIndex, warnings),
      output: deltaCount(snapshot.output, previous?.output ?? null, "output_tokens", turnIndex, warnings),
      // OpenAI-style automatic prompt caching has no separate "cache write"
      // charge the way Anthropic's explicit cache-creation tokens do — this
      // category has nothing to ever report for Codex.
      cacheWrite: unknownTokenCount(
        "Codex's usage payload has no cache-write token category (OpenAI "
        + "prompt caching bills cache reads only, never writes)",
      ),
      cacheRead: deltaCount(snapshot.cacheRead, previous?.cacheRead ?? null, "cached_input_tokens", turnIndex, warnings),
      reasoning: deltaCount(snapshot.reasoning, previous?.reasoning ?? null, "reasoning_tokens", turnIndex, warnings),
    };
    const unrecognizedUsageKeys = Object.keys(usage).filter(
      (key) => !KNOWN_USAGE_KEYS.has(key),
    );
    turns.push({
      turnIndex,
      model: currentModel,
      timestamp,
      toolCallFingerprint: pendingToolCalls,
      counts,
      unrecognizedUsageKeys,
    });
    pendingToolCalls = [];
    previous = snapshot;
  }

  return {
    client: "codex",
    parserVersion: CODEX_PARSER_VERSION,
    sessionCwd,
    usedTokenLighten,
    turns,
    totals: sumTokenCounts(turns.map((t) => t.counts)),
    warnings,
  };
}
