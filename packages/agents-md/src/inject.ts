// Plain data output — no meta envelope. See docs/00-postmortem.md §2.2.
//
// Idempotent managed-block injection engine.
// Implements the rewrite() pseudocode from
// docs/components/04-agents-md-generator.md §2 and §3.
//
// Salvaged from: proto/src/mcp/agentInstructions.ts:364-422 (ensureAgentInstructions)
// with drift-mode and sha256 hash-line detection added.

import {
  parseSentinelBlock,
  findManagedRange,
  extractVersion,
  extractSha256,
  countSentinels,
  restoreEol,
  SENTINEL_START,
} from "./sentinel.js";

/**
 * Version-drift behaviour modes.
 * Spec: docs/components/04-agents-md-generator.md §3.
 */
export type DriftMode = "auto-rewrite" | "diff-warn" | "fail-build";

export type RewriteAction =
  | "no-op"
  | "append-block"
  | "replace-block"
  | "leave-manual"
  | "fail";

export interface RewriteResult {
  /** Final file text (UTF-8, LF). Apply EOL restoration before writing. */
  text: string;
  action: RewriteAction;
  /** Diagnostic message for warn/fail modes. */
  diagnostic?: string;
  /** True when a manual edit inside the managed block was detected (sha mismatch). */
  manualEditDetected?: boolean;
}

/**
 * Detect whether the text outside the managed block contains manual
 * TokenLighten guidance (to avoid overwriting hand-written instructions).
 *
 * Keyword set, corrected for D11 (protocol v1 P2, 2026-08-14). The advertised
 * surface is exactly three tools; the alias names this list used to call "new
 * TL tools" were DELETED with D11 and are no longer anything a caller can
 * invoke:
 *   - current: read_file, edit_file, search_files
 *   - deleted aliases / proto-era names, kept ONLY as historical markers —
 *     hand-written guidance predating v1 still mentions them, and clobbering
 *     it is the exact failure this predicate exists to prevent.
 *
 * Detection is gated on the text also mentioning "tokenlighten", so the
 * generic current names cannot false-positive on unrelated prose.
 *
 * Source: proto/src/mcp/agentInstructions.ts:286-294 (hasManualGuidance),
 * keyword set updated per docs/components/04-agents-md-generator.md §8.
 */
export function hasManualGuidance(text: string): boolean {
  const lower = text.toLowerCase();
  if (!lower.includes("tokenlighten")) return false;
  return (
    // The three advertised tools (D11: the only names that exist).
    text.includes("read_file") ||
    text.includes("edit_file") ||
    text.includes("search_files") ||
    // Deleted aliases and proto-era tools: still valid evidence that someone
    // hand-wrote TL guidance here, even though nothing answers to them now.
    text.includes("search_replace_edit") ||
    text.includes("apply_edits_multi") ||
    text.includes("get_file_skeleton") ||
    text.includes("get_symbol_with_context") ||
    text.includes("get_changed_context") ||
    text.includes("build_optimized_context")
  );
}

/**
 * Ensure a string ends with exactly one trailing newline.
 */
function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

/**
 * Core idempotent rewrite function.
 *
 * @param text       Raw file content (may be CRLF/BOM/mixed).
 * @param canonical  The full managed block text (start sentinel…end sentinel),
 *                   on LF line endings (as returned by renderBlock()).
 * @param version    The canonical version string (e.g. "2026-06-25-cheap").
 * @param sha        The canonical sha256 of the block body.
 * @param driftMode  How to handle version/sha drift.
 *
 * Output text is always LF (caller restores EOL before disk write).
 */
export function rewrite(
  text: string,
  canonical: string,
  version: string,
  sha: string,
  driftMode: DriftMode = "diff-warn"
): RewriteResult {
  // Pre-flight: detect malformed multiple sentinels before any processing.
  const { starts, ends } = countSentinels(text.replace(/\r\n/g, "\n"));
  if (starts !== ends || starts > 1) {
    return {
      text,
      action: "fail",
      diagnostic: `AGENTS.md has malformed sentinels (start=${starts}, end=${ends}); fix manually or run \`tl-agents doctor\`.`,
    };
  }

  // Normalise for processing (BOM strip + CRLF normalise)
  let { normalised, hasBom: _hasBom } = { normalised: text.replace(/\r\n/g, "\n"), hasBom: false };
  try {
    const parsed = parseSentinelBlock(text);
    normalised = parsed.normalised;
  } catch {
    // parseSentinelBlock throws on malformed — already handled above
    return {
      text,
      action: "fail",
      diagnostic: "AGENTS.md has malformed sentinels; fix manually.",
    };
  }

  const range = findManagedRange(normalised);
  const canonicalStart = canonical.indexOf(SENTINEL_START);
  const canonicalPrefix = canonicalStart > 0 ? canonical.slice(0, canonicalStart) : "";
  const canonicalBlock = canonicalStart >= 0 ? canonical.slice(canonicalStart) : canonical;
  const canonicalHasYamlPrefix = canonicalPrefix.startsWith("---\n");

  // (A) No managed block found
  if (!range) {
    const outsideText = normalised;
    if (hasManualGuidance(outsideText)) {
      // Manual prose detected — leave untouched
      return { text: normalised, action: "leave-manual" };
    }
    // YAML metadata must stay at byte zero. Preserve user-owned frontmatter;
    // otherwise place our target metadata before existing prose.
    if (canonicalHasYamlPrefix && normalised.trim().length > 0) {
      const existingWithMetadata = normalised.startsWith("---\n")
        ? normalised.trimEnd()
        : `${canonicalPrefix}${normalised.trimEnd()}`;
      return {
        text: ensureTrailingNewline(`${existingWithMetadata}\n\n${canonicalBlock}`),
        action: "append-block",
      };
    }

    // Append the canonical block
    const prefix = normalised.trim().length ? `${normalised.trimEnd()}\n\n` : "";
    return {
      text: ensureTrailingNewline(`${prefix}${canonical}`),
      action: "append-block",
    };
  }

  // (B) Managed block present — extract and compare
  const blockText = normalised.slice(range.start, range.end);
  const blockVersion = extractVersion(blockText);
  const blockSha = extractSha256(blockText);

  // Target-native frontmatter/prologues live immediately before the managed
  // sentinel. Include them in idempotency and replacement so an update never
  // duplicates YAML frontmatter or the CLAUDE.md import line.
  const prefixStart = range.start - canonicalPrefix.length;
  const exactPrefixMatch =
    canonicalPrefix.length === 0 ||
    (prefixStart >= 0 && normalised.slice(prefixStart, range.start) === canonicalPrefix);
  const yamlEnd = canonicalHasYamlPrefix && normalised.startsWith("---\n")
    ? normalised.indexOf("\n---\n", 4)
    : -1;
  const compatibleYamlPrefix = yamlEnd >= 0 && yamlEnd + 5 <= range.start;
  const yamlPrefixOnly =
    compatibleYamlPrefix &&
    normalised.slice(yamlEnd + 5, range.start).trim().length === 0;
  const existingYamlPrefix = compatibleYamlPrefix
    ? normalised.slice(0, range.start)
    : "";
  const managedYamlPrefixMismatch =
    yamlPrefixOnly &&
    !exactPrefixMatch &&
    (existingYamlPrefix.includes("name: TokenLighten MCP workflow") ||
      existingYamlPrefix.includes("description: TokenLighten MCP "));
  const prefixMatch =
    exactPrefixMatch || (compatibleYamlPrefix && !managedYamlPrefixMismatch);

  // Proto-compat: block lacks hash-line → add it on next rewrite
  const shaMatch = blockSha === sha;
  const versionMatch = blockVersion === version;

  if (versionMatch && shaMatch && prefixMatch) {
    // (B-1) Fully current — no-op
    return { text: ensureTrailingNewline(normalised), action: "no-op" };
  }

  // (B-2) Drift: version old or sha mismatch
  const manualEditDetected = blockSha !== undefined && !shaMatch && versionMatch;
  const wrapperMismatch = versionMatch && shaMatch && !prefixMatch;

  if (driftMode === "fail-build") {
    return {
      text: normalised,
      action: "fail",
      diagnostic: wrapperMismatch
        ? "Target-specific instruction metadata is missing or outdated. Re-run `tl-agents update`."
        : `AGENTS.md sentinel is ${blockVersion ?? "(unknown)"}, generator wants ${version}. Re-run \`tl-agents update\`.`,
      manualEditDetected,
    };
  }

  if (driftMode === "diff-warn") {
    const msg = wrapperMismatch
      ? "Target-specific instruction metadata is missing or outdated; re-run `tl-agents update`"
      : manualEditDetected
        ? `AGENTS.md managed block contains manual edits (sha mismatch); not overwriting. Move edits outside the sentinel block or run with --force.`
        : `AGENTS.md outdated (${blockVersion ?? "?"} → ${version}); re-run \`tl-agents update\``;
    process.stderr.write(`[tl-agents] WARN: ${msg}\n`);
    return { text: normalised, action: "no-op", diagnostic: msg, manualEditDetected };
  }

  // auto-rewrite: replace block in-place
  if (manualEditDetected) {
    process.stderr.write(
      `[tl-agents] WARN: manual edits in managed block detected; overwriting (--force not required in auto-rewrite mode). Back up created.\n`
    );
  }
  const replaceStart = exactPrefixMatch
    ? prefixStart
    : managedYamlPrefixMismatch
      ? 0
      : range.start;
  const replacement =
    compatibleYamlPrefix && !exactPrefixMatch && !managedYamlPrefixMismatch
      ? canonicalBlock
      : canonical;
  let suffix = normalised.slice(range.end);
  if (replacement.endsWith("\n") && suffix.startsWith("\n")) suffix = suffix.slice(1);
  const next =
    normalised.slice(0, replaceStart) + replacement + suffix;
  return {
    text: ensureTrailingNewline(next),
    action: "replace-block",
    manualEditDetected,
  };
}

/**
 * Remove the managed block from text.
 * Source: proto/src/mcp/agentInstructions.ts:424-448 (removeAgentInstructions).
 */
export function removeBlock(text: string): { text: string; changed: boolean } {
  const normalised = text.replace(/\r\n/g, "\n");
  const range = findManagedRange(normalised);
  if (!range) return { text: normalised, changed: false };

  const before = normalised.slice(0, range.start).trimEnd();
  const after = normalised.slice(range.end).trimStart();
  const next = before && after ? `${before}\n\n${after}` : before || after;
  const normalized = next ? `${next.trimEnd()}\n` : "";
  return { text: normalized, changed: true };
}

export { restoreEol };
