/**
 * parsers/types.ts — V11-08 Attribution & Calibration v2.
 *
 * Shared normalized shape produced by every client log parser in this
 * directory (claudeCode.ts, codex.ts, and any future addition). This is the
 * "normalized session-usage shape" the V11-08 task brief requires: input,
 * output, cache-write, cache-read, and reasoning tokens are ALWAYS kept as
 * five separate fields — never summed into one number anywhere in this
 * module or its consumers (sessionMatcher.ts, coefficientStore.ts,
 * pricingSnapshots.ts all read these five fields individually).
 *
 * HONESTY INVARIANT: a token category a parser could not read from the
 * source log is `{ status: "unknown", reason }`, never a fabricated `0`.
 * `reason` is required (no default) so a caller can always explain an
 * "unknown" to a user instead of silently rendering a dash — the same
 * discipline measurementEngine.ts applies to `ComponentProvenance.basis`.
 *
 * This module does no I/O and imports nothing — pure data shapes and pure
 * helpers only, mirroring coveragePacker.ts's "729 lines, pure, zero
 * imports" precedent (DESIGN-v0.11-expansion-plan-reconciliation.md §2.5).
 */

export type TokenCount =
  | { readonly status: "known"; readonly tokens: number }
  | { readonly status: "unknown"; readonly reason: string };

export interface NormalizedTokenCounts {
  readonly input: TokenCount;
  readonly output: TokenCount;
  readonly cacheWrite: TokenCount;
  readonly cacheRead: TokenCount;
  /** Never folded into `output`, even on clients that bill it that way — see
   *  each parser's own header doc for its client's exact convention. */
  readonly reasoning: TokenCount;
}

export interface NormalizedTurnUsage {
  /** 0-based, in file order — stable only within one parse call. */
  readonly turnIndex: number;
  /** "unknown" sentinel (never null/undefined) when the source log never
   *  attributed a model id to this turn — matches aiLogs.ts's convention. */
  readonly model: string;
  /** ISO-8601, or null when the source line carried no parseable timestamp. */
  readonly timestamp: string | null;
  /** Ordered TokenLighten tool-call names THIS TURN invoked (full wire form,
   *  e.g. "mcp__tokenlighten__read_file"), for sessionMatcher.ts's
   *  fingerprint-sequence scoring. Empty when the turn made no TL calls. */
  readonly toolCallFingerprint: readonly string[];
  readonly counts: NormalizedTokenCounts;
  /** Keys seen in the raw usage/token-count object that this parser version
   *  does not map to a known category. VALUES are never retained (privacy:
   *  no prompt/path/source text) — only key names, so nothing is silently
   *  dropped without a trace. */
  readonly unrecognizedUsageKeys: readonly string[];
}

export type NormalizedSessionClient = "claude-code" | "codex";

export interface NormalizedSessionUsage {
  readonly client: NormalizedSessionClient;
  /** The exact parser build that produced this session — V11-08's "a parse
   *  result records which parserVersion produced it" requirement, carried at
   *  the session level so it survives being passed around independently of
   *  a batch-level ParseResult. */
  readonly parserVersion: string;
  /** Raw filesystem path from the source log, held only in memory — see
   *  attributionPrivacy.ts for the handling contract. Null when the source
   *  log never recorded a cwd for this session. */
  readonly sessionCwd: string | null;
  readonly usedTokenLighten: boolean;
  /** Only entries that carried an actual usage/token-count report — a
   *  metadata-only log line (e.g. Codex's turn_context) never appears here,
   *  so every entry's counts reflect a REAL provider report, never a
   *  filled-in placeholder for a turn that had none. */
  readonly turns: readonly NormalizedTurnUsage[];
  /** Per category: "known" iff EVERY turn reported that category; otherwise
   *  "unknown" — a total is never a silent partial sum standing in as if it
   *  were complete (mirrors measurementEngine.ts's never-zero-an-unknown
   *  rule, applied here to the known/unknown axis instead of the
   *  measured/estimated one). */
  readonly totals: NormalizedTokenCounts;
  readonly warnings: readonly string[];
}

export interface ParseResult {
  readonly parserVersion: string;
  readonly sessions: readonly NormalizedSessionUsage[];
  readonly warnings: readonly string[];
}

/** `null` iff the category is unknown — convenience for callers (e.g.
 *  pricingSnapshots.ts) that want a plain number and are ALREADY prepared to
 *  treat null as "cannot price this," never as zero. */
export function tokenCountValue(count: TokenCount): number | null {
  return count.status === "known" ? count.tokens : null;
}

/** Raw provider token counts are never negative — clamps a malformed
 *  negative reading to 0 rather than propagating it. This is NOT the same
 *  rule as the signed SAVINGS/delta figures elsewhere in this package
 *  (measurementEngine.ts, featureContributions.ts): those preserve negative
 *  values on purpose (TL can make things worse), because they encode a
 *  comparison. A raw input/output/cache token count from a provider API is
 *  never itself a comparison, so clamping here is a defensive parse rule,
 *  not a honesty violation — do not copy this clamp onto a signed field. */
export function knownTokenCount(tokens: number): TokenCount {
  return { status: "known", tokens: Math.max(0, Math.round(tokens)) };
}

export function unknownTokenCount(reason: string): TokenCount {
  return { status: "unknown", reason };
}

const TOKEN_CATEGORIES = [
  "input",
  "output",
  "cacheWrite",
  "cacheRead",
  "reasoning",
] as const;

/** Sums a list of per-turn counts into a totals object honoring the
 *  known-iff-every-turn-known rule documented on `NormalizedSessionUsage`.
 *  An empty `turnCounts` list yields all-unknown totals (never a bogus known
 *  0 — vacuous truth would otherwise claim "0 turns all agree the total is
 *  0"). Pure: never mutates its input. */
export function sumTokenCounts(
  turnCounts: readonly NormalizedTokenCounts[],
): NormalizedTokenCounts {
  const result = {} as Record<(typeof TOKEN_CATEGORIES)[number], TokenCount>;
  for (const category of TOKEN_CATEGORIES) {
    if (turnCounts.length === 0) {
      result[category] = unknownTokenCount("no turn carried a usage report");
      continue;
    }
    const known: number[] = [];
    for (const counts of turnCounts) {
      const c = counts[category];
      if (c.status === "known") known.push(c.tokens);
    }
    result[category] = known.length === turnCounts.length
      ? knownTokenCount(known.reduce((sum, v) => sum + v, 0))
      : unknownTokenCount(
        `${turnCounts.length - known.length} of ${turnCounts.length} turn(s) `
        + `did not report ${category}`,
      );
  }
  return result as NormalizedTokenCounts;
}
