// anchorFocus — extracted implementation; imports point to the owning modules.
import * as path from "path";
import type { CollectedSymbolKind } from "../../../symbols/collectSymbols.js";
import type { TaskPackPathEntry } from "../model.js";
import { ANSWER_RECOVERY_GENERIC_PROTOCOL_IDENTIFIERS } from "./seededPackBuilder2.js";
import { ANSWER_RECOVERY_SEMANTIC_TERMS } from "./seededPackBuilder2.js";
import { PROTOCOL_IDENTIFIERS } from "./seededPackBuilder2.js";
import { countLines } from "../../../util/countLines.js";
import { escapeRegExp } from "../../search/find/findText.js";
import { isImplementationPath } from "./changeAndReadinessEvidence2.js";
import { isTestConcernPath } from "./literalAndConcernSeeds.js";
import { readCached } from "./packBasics2.js";
import { scanLiteral } from "../../search/find/findText.js";

/**
 * Strip broad prose/tool names from an answer query before one bounded recovery
 * locate. This prevents a high-scoring bench helper from project-root-locking
 * the candidate pool away from the named protocol implementation.
 */
export function isPascalCaseIdentifier(value: string): boolean {
  if (value.length < 2 || value.charCodeAt(0) < 65 || value.charCodeAt(0) > 90) return false;
  let hasLower = false;
  let hasBoundary = false;
  for (let i = 1; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 97 && code <= 122) hasLower = true;
    if (code >= 65 && code <= 90) hasBoundary = true;
    else if (!((code >= 48 && code <= 57) || (code >= 97 && code <= 122) || code === 95)) return false;
  }
  return hasLower && hasBoundary;
}

export function answerRecoveryQuery(query: string): string | undefined {
  const tokens = query.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [];
  const seen = new Set<string>();
  const recovered: string[] = [];
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (lower === "mcp" || ANSWER_RECOVERY_GENERIC_PROTOCOL_IDENTIFIERS.has(lower)) continue;
    const protocol = PROTOCOL_IDENTIFIERS.has(lower);
    const semantic = ANSWER_RECOVERY_SEMANTIC_TERMS.has(lower);
    const codeShaped = token.includes("_")
      || token.includes("$")
      || /^[a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*$/.test(token)
      || isPascalCaseIdentifier(token);
    if (!protocol && !semantic && !codeShaped) continue;
    if (seen.has(lower)) continue;
    seen.add(lower);
    recovered.push(token);
  }
  return recovered.length >= 2 ? recovered.join(" ") : undefined;
}

/** A quoted CLI command and its literal options can identify a unique source file before prose ranking. */
export function commandLiteralAnswerTarget(query: string, workspace: string): TaskPackPathEntry | undefined {
  const commands = new Set<string>();
  for (const quoted of query.matchAll(/`([^`\r\n]+)`/gu)) {
    const words = quoted[1]!.trim().split(/\s+/u);
    if (words.length < 2 || !/^[A-Za-z0-9_./-]+$/u.test(words[0]!)) continue;
    const subcommands: string[] = [];
    for (const word of words.slice(1)) {
      if (word.startsWith("-")) break;
      if (!/^[a-z][a-z0-9_-]*$/u.test(word)) break;
      subcommands.push(word);
    }
    if (subcommands.length > 0) commands.add(subcommands[subcommands.length - 1]!);
  }
  const options = [...new Set(query.match(/--[A-Za-z][A-Za-z0-9-]*/gu) ?? [])];
  if (commands.size !== 1 || options.length === 0 || options.length > 4) return undefined;
  const command = [...commands][0]!;
  // File-stem identity and every option's exact spelling must agree. A tie
  // remains an ordinary discovery request, never a guessed project binding.
  const candidates = [...new Set(scanLiteral(options[0]!, workspace, { caseInsensitive: false }).map((hit) => hit.path))]
    .filter((candidate) => path.basename(candidate, path.extname(candidate)) === command
      && isImplementationPath(candidate) && !isTestConcernPath(candidate));
  const matches = candidates.flatMap((candidate) => {
    const content = readCached(workspace, candidate);
    if (content === undefined || !options.every((option) =>
      new RegExp(`${escapeRegExp(option)}(?![A-Za-z0-9-])`, "u").test(content))) return [];
    // Naming the command's file locates the investigation, not its answer.
    // Retain its unserved extent so a matching header/help string cannot
    // certify a description of the runtime behavior by itself.
    return [{ path: candidate, range: `1-${countLines(content)}` }];
  });
  return matches.length === 1 ? matches[0] : undefined;
}

/** Lexical-overlap weight for a query token found in the symbol's BODY text — bodies are long and noisier, so a body-only hit counts for less than a name hit. */
export const ANCHOR_FOCUS_BODY_WEIGHT = 1;

/** How many next-best-scoring symbols to name as a ready-to-run follow-up alongside the picked one. */
export const ANCHOR_FOCUS_MAX_RUNNER_UPS = 4;

export interface AnchorFocusCandidate {
  name: string;
  range: string;
  score: number;
  /**
   * D2 (2026-08-07): set when this candidate is the file's LEADING comment
   * block rather than a parsed symbol. Only affects display wording — the
   * candidate competes on the ordinary lexical score like any other.
   *
   * 2026-09-05: `"doc-section"` marks a MARKDOWN heading section picked by
   * `markdownAnchorFocus`. It never reaches the symbol-scoring path below, so
   * it changes only the `why` wording attachAnchorFocusAffordance emits.
   */
  kind?: CollectedSymbolKind | "module-header" | "doc-section";
}

export interface AnchorFocusResult {
  best: AnchorFocusCandidate;
  runnerUps: AnchorFocusCandidate[];
}
