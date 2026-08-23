/**
 * parsers/claudeCode.ts — V11-08 Attribution & Calibration v2.
 *
 * Parses Claude Code's local JSONL session log lines — the exact shape
 * aiLogs.ts's `claudeRecords()` already reads (`type:"assistant"` rows with
 * a `message.usage` block; TokenLighten usage detected via a `tool_use`
 * content block whose `name` matches the TL tool-name convention) — into the
 * richer, per-turn NormalizedSessionUsage shape this workstream adds: token
 * categories stay separated (never summed), and a category the log did not
 * report is `{status:"unknown"}`, never a fabricated 0.
 *
 * This is a NEW, stricter SIBLING of aiLogs.ts's `claudeRecords()` — that
 * function keeps shipping the coarser per-model-total shape index.ts's
 * summarizeUsage() already depends on; this parser does not replace it.
 */

import type {
  NormalizedSessionUsage,
  NormalizedTokenCounts,
  NormalizedTurnUsage,
  TokenCount,
} from "./types.js";
import { knownTokenCount, sumTokenCounts, unknownTokenCount } from "./types.js";

export const CLAUDE_CODE_PARSER_VERSION = "claude-code-log-parser-v1";

const TOKENLIGHTEN_TOOL = /^(?:mcp__)?tokenlighten(?:__|:)/i;
const KNOWN_USAGE_KEYS = new Set([
  "input_tokens",
  "output_tokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
]);

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function toolUseNames(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const names: string[] = [];
  for (const block of content) {
    const row = objectValue(block);
    const name = row?.["name"];
    if (row?.["type"] === "tool_use" && typeof name === "string") names.push(name);
  }
  return names;
}

function fieldCount(usage: Record<string, unknown>, key: string): TokenCount {
  const value = usage[key];
  return typeof value === "number" && Number.isFinite(value)
    ? knownTokenCount(value)
    : unknownTokenCount(`usage.${key} was not reported on this turn`);
}

/**
 * Parses ONE Claude Code session's already-JSON-parsed log lines (see
 * jsonl.ts's `splitJsonLines` for turning raw file text into this array).
 * Pure: never mutates `lines`, never touches the filesystem.
 */
export function parseClaudeCodeSession(
  lines: readonly unknown[],
): NormalizedSessionUsage {
  let sessionCwd: string | null = null;
  let usedTokenLighten = false;
  const turns: NormalizedTurnUsage[] = [];
  const warnings: string[] = [];

  for (const line of lines) {
    const row = objectValue(line);
    if (!row) continue;
    if (
      sessionCwd === null
      && typeof row["cwd"] === "string"
      && row["cwd"].length > 0
    ) {
      sessionCwd = row["cwd"];
    }
    if (row["type"] !== "assistant") continue;
    const message = objectValue(row["message"]);
    if (!message) continue;
    const toolNames = toolUseNames(message["content"]);
    if (toolNames.some((name) => TOKENLIGHTEN_TOOL.test(name))) {
      usedTokenLighten = true;
    }
    const usage = objectValue(message["usage"]);
    if (!usage) {
      warnings.push(`turn ${turns.length}: assistant message carried no usage block`);
      continue;
    }
    const model = typeof message["model"] === "string" ? message["model"] : "unknown";
    const timestamp = typeof row["timestamp"] === "string" ? row["timestamp"] : null;
    const counts: NormalizedTokenCounts = {
      input: fieldCount(usage, "input_tokens"),
      output: fieldCount(usage, "output_tokens"),
      cacheWrite: fieldCount(usage, "cache_creation_input_tokens"),
      cacheRead: fieldCount(usage, "cache_read_input_tokens"),
      // Anthropic's Messages API usage object has no separate reasoning /
      // extended-thinking token count as of this parser version — those
      // tokens are folded into output_tokens with no way to split them back
      // out here. This is a real, permanent absence for this client, not a
      // parse failure — always unknown, never 0.
      reasoning: unknownTokenCount(
        "Claude Code's usage block does not separate reasoning/thinking "
        + "tokens from output_tokens",
      ),
    };
    const unrecognizedUsageKeys = Object.keys(usage).filter(
      (key) => !KNOWN_USAGE_KEYS.has(key),
    );
    turns.push({
      turnIndex: turns.length,
      model,
      timestamp,
      toolCallFingerprint: toolNames,
      counts,
      unrecognizedUsageKeys,
    });
  }

  return {
    client: "claude-code",
    parserVersion: CLAUDE_CODE_PARSER_VERSION,
    sessionCwd,
    usedTokenLighten,
    turns,
    totals: sumTokenCounts(turns.map((t) => t.counts)),
    warnings,
  };
}
