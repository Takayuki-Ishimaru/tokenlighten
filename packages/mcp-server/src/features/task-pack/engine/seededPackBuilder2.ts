// seededPackBuilder — extracted implementation; imports point to the owning modules.


// ---------------------------------------------------------------------------
// Anchor-focus embedding for large caller-named file seeds (gap: transcript-
// verified in run 2026-07-10b — see buildSeededTaskPack's seed loop
// above, which is the sole call site). Scoring idea salvaged from the
// retired proto/src/mcp/core.ts's buildAnchorFocus (read-only reference, not
// imported); reworked here as a single top-scoring PICK — rather than a
// budget-packed multi-body embed — so the picked symbol's exact range can
// become the seed candidate's own `range`/`symbol`, keeping
// candidateToSurface's slice-equals-served-range (and served-range-equals-
// minted-handle) contract intact.
// ---------------------------------------------------------------------------

/**
 * Cap on how many of a file's top-level symbols are scored. Deliberately
 * higher than extractSymbolsFromFile's own default (16) — a real file large
 * enough to trip this path (content over MAX_SURFACE_CODE_BYTES) commonly
 * has more than 16 top-level declarations, and a symbol past the scan
 * cutoff is invisible to scoring, not just low-scoring.
 */
// Answer recovery may start from only a filename-level candidate in a large
// implementation module. Keep the scan bounded, but cover substantially more
// than the declaration roster returned to callers; the real task-pack module
// has its readiness builder well past the first 64 declarations.
export const ANCHOR_FOCUS_MAX_SYMBOLS = 256;

/** Lexical-overlap weight for a query token found in the SYMBOL NAME — a name hit is a strong, cheap-to-trust relevance signal. */
export const ANCHOR_FOCUS_NAME_WEIGHT = 3;

/** Prefer a symbol whose own name is covered by the query, not merely a body that repeats query prose. */
export const ANCHOR_FOCUS_SYMBOL_COVERAGE_WEIGHT = 5;

/** Edit-shaped queries should prefer executable definitions over interfaces/types carrying the same words. */
export const ANCHOR_FOCUS_CALLABLE_WEIGHT = 2;

/** An identifier explicitly written in the query outranks incidental prose overlap. */
export const ANCHOR_FOCUS_EXPLICIT_IDENTIFIER_WEIGHT = 100;

/**
 * E3: a symbol whose FULLY QUALIFIED name is the one the query spelled
 * (`EKF::isHealthy`) outranks a same-tail member of a different class, which
 * only earns the plain explicit-identifier weight. Larger than the maximum
 * lexical score (NAME 3 + COVERAGE 5 + BODY 1 + CALLABLE 2) so class identity
 * — not shared prose — decides between two same-named members.
 */
export const ANCHOR_FOCUS_QUALIFIED_MATCH_WEIGHT = 50;

/** MCP protocol vocabulary is not a request to locate a same-named code symbol. */
export const PROTOCOL_IDENTIFIERS = new Set([
  "mcp",
  "tl_read_file",
  "tl_edit_file",
  "tl_search_files",
  "task_pack",
  "execution_contract",
  "next_call",
  "answer_ready",
  "edit_ready",
  "needs_followup",
]);

/** Generic tool-surface names are too broad to improve a second locate pass. */
export const ANSWER_RECOVERY_GENERIC_PROTOCOL_IDENTIFIERS = new Set([
  "tl_read_file",
  "tl_edit_file",
  "tl_search_files",
  "task_pack",
]);

/** Plain semantic terms that become useful when paired with structured identifiers. */
export const ANSWER_RECOVERY_SEMANTIC_TERMS = new Set([
  "readiness",
  "continuation",
  "closure",
  "coverage",
]);
