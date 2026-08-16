// Plain data output — no meta envelope. See docs/00-postmortem.md §2.2.
//
// Sentinel grammar (EBNF from docs/components/04-agents-md-generator.md §1):
//
//   managed-block  ::= start-sentinel NEWLINE version-line NEWLINE [hash-line NEWLINE] body NEWLINE end-sentinel
//   start-sentinel ::= "<!-- tokenlighten:mcp-instructions:start -->"
//   end-sentinel   ::= "<!-- tokenlighten:mcp-instructions:end -->"
//   version-line   ::= "<!-- tl-instructions-version: " version-string " -->"
//   hash-line      ::= "<!-- tl-instructions-sha256: " 64-hex " -->"
//
// Source: proto/src/mcp/agentInstructions.ts:41-42 (sentinel strings kept identical
// for backward compatibility). Hash-line added in new TL (not present in proto).

import type { SentinelBlock } from "@tokenlighten/types";
import { createHash } from "node:crypto";

export const SENTINEL_START = "<!-- tokenlighten:mcp-instructions:start -->";
export const SENTINEL_END = "<!-- tokenlighten:mcp-instructions:end -->";

// Regex patterns (multiline, dotAll where needed).
// \r?\n equivalent via flexible whitespace at line ends.
const VERSION_RE =
  /^<!--\s*tl-instructions-version:\s*(?<ver>[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9-]+)\s*-->\s*$/m;
const HASH_RE =
  /^<!--\s*tl-instructions-sha256:\s*(?<sha>[0-9a-f]{64})\s*-->\s*$/m;

/** UTF-8 BOM prefix that Windows Notepad may insert. */
const BOM = "﻿";

/**
 * Detect the dominant line ending in a string.
 * Returns "\r\n" if CRLF count >= LF-only count, else "\n".
 * New files default to "\n".
 */
export function detectEol(text: string): "\r\n" | "\n" {
  const crlfCount = (text.match(/\r\n/g) ?? []).length;
  const lfOnlyCount = (text.match(/(?<!\r)\n/g) ?? []).length;
  return crlfCount >= lfOnlyCount && crlfCount > 0 ? "\r\n" : "\n";
}

/**
 * Strip leading BOM if present, returning { stripped, hasBom }.
 */
export function stripBom(text: string): { stripped: string; hasBom: boolean } {
  if (text.startsWith(BOM)) {
    return { stripped: text.slice(BOM.length), hasBom: true };
  }
  return { stripped: text, hasBom: false };
}

/**
 * Normalise CRLF to LF for internal processing.
 * Restore the original EOL before writing with `restoreEol`.
 */
export function normalizeCrlf(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

/**
 * Replace all LF with the given EOL (for write-back after processing).
 */
export function restoreEol(text: string, eol: "\r\n" | "\n"): string {
  if (eol === "\r\n") {
    // Replace lone \n (not already preceded by \r) with \r\n
    return text.replace(/(?<!\r)\n/g, "\r\n");
  }
  return text;
}

/**
 * Compute the SHA-256 hex digest of a string (UTF-8 encoded).
 * Used for block body fingerprinting.
 */
export function sha256hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export interface ParsedSentinel {
  /** Start byte offset in the normalised (LF) text. */
  start: number;
  /** End byte offset (exclusive) in the normalised (LF) text. */
  end: number;
}

/**
 * Find the managed block range in normalised (LF) text using indexOf.
 * Returns undefined when no complete start+end pair is found.
 * Source: proto/src/mcp/agentInstructions.ts:273-279 (managedRange).
 */
export function findManagedRange(text: string): ParsedSentinel | undefined {
  const startIdx = text.indexOf(SENTINEL_START);
  if (startIdx < 0) return undefined;
  const endIdx = text.indexOf(SENTINEL_END, startIdx + SENTINEL_START.length);
  if (endIdx < 0) return undefined;
  return { start: startIdx, end: endIdx + SENTINEL_END.length };
}

/**
 * Count how many start/end sentinels appear in the text.
 * Used to detect malformed files (§9.1, §9.2).
 */
export function countSentinels(text: string): { starts: number; ends: number } {
  const starts = (text.match(new RegExp(escapeRegex(SENTINEL_START), "g")) ?? []).length;
  const ends = (text.match(new RegExp(escapeRegex(SENTINEL_END), "g")) ?? []).length;
  return { starts, ends };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Extract the version string from a block.
 * Returns undefined if not found.
 */
export function extractVersion(block: string): string | undefined {
  const m = block.match(VERSION_RE);
  return m?.groups?.["ver"];
}

/**
 * Extract the sha256 hex digest from a block.
 * Returns undefined if not found (proto-compat blocks lack it).
 */
export function extractSha256(block: string): string | undefined {
  const m = block.match(HASH_RE);
  return m?.groups?.["sha"];
}

/**
 * Parse a managed block string (start sentinel … end sentinel) into a
 * SentinelBlock value. Throws if the string is malformed.
 */
export function parseBlock(
  raw: string,
  startOffset: number,
  endOffset: number
): SentinelBlock {
  const version = extractVersion(raw);
  if (!version) {
    throw new Error(
      "Malformed sentinel block: missing <!-- tl-instructions-version: ... --> line"
    );
  }
  const sha256 = extractSha256(raw) ?? "";
  return {
    start: startOffset,
    end: endOffset,
    version,
    sha256,
    body: raw,
  };
}

/**
 * Full parse of a document: strip BOM, detect EOL, normalise to LF, locate
 * the managed block.
 *
 * Returns { normalised, eol, hasBom, block } where `block` is undefined if
 * no managed sentinel pair was found.
 *
 * Throws with a descriptive message when the file contains multiple or
 * mismatched sentinel pairs (§9.1, §9.2).
 */
export function parseSentinelBlock(text: string): {
  normalised: string;
  eol: "\r\n" | "\n";
  hasBom: boolean;
  block: SentinelBlock | undefined;
} {
  const { stripped, hasBom } = stripBom(text);
  const eol = detectEol(stripped);
  const normalised = normalizeCrlf(stripped);

  const { starts, ends } = countSentinels(normalised);
  if (starts !== ends || starts > 1) {
    throw new Error(
      `AGENTS.md has malformed sentinels (start=${starts}, end=${ends}); fix manually`
    );
  }

  const range = findManagedRange(normalised);
  if (!range) {
    return { normalised, eol, hasBom, block: undefined };
  }

  const raw = normalised.slice(range.start, range.end);
  const block = parseBlock(raw, range.start, range.end);
  return { normalised, eol, hasBom, block };
}
