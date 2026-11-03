/**
 * The ceiling on a "native read" savings baseline.
 *
 * The usage summary reports "context avoided" as `baseline - TL response`,
 * where the baseline is meant to be what a client WITHOUT TokenLighten would
 * have read to get the same material. Until v0.16.4 that baseline was the whole
 * byte size of every file a call named, so one `tl_read_file` of a 1.59 MB
 * source file credited ~397,000 tokens of "avoided" context. A paired field
 * evaluation (18 Claude Code A/B runs) found TL cost 43% MORE in total while
 * the summary printed 457,550 tokens avoided.
 *
 * No real client reads a file like that. Claude Code's Read tool returns at
 * most {@link NATIVE_READ_MAX_LINES} lines per call by default and refuses a
 * file whose content exceeds about {@link NATIVE_READ_MAX_TOKENS} tokens unless
 * the caller passes offset/limit; agents normally Grep first and then read a
 * range. So the most one native read of one file can put into the context is
 *
 *     min(file tokens, tokens of the first 2,000 lines, 25,000 tokens)
 *
 * and that is the most a baseline may credit for one file in one call. The
 * rule is an estimated UPPER BOUND on the context TL avoided, never billing:
 * the true native read is usually smaller (a grep hit plus a short range).
 * What it does not model, because each only lowers the true native read: a
 * client truncating a line longer than 2,000 characters, and re-reads of a file
 * the client already holds.
 *
 * Two places apply the rule, and both import it from here so they cannot
 * drift:
 *
 * - the MCP server when it records an event, per file, where the file's size
 *   and lines are known (`usage-baseline/readBaseline.ts`);
 * - {@link summarizeUsage}, per recorded event, so logs written before the
 *   rule existed (and by older servers still running it) are bounded too.
 *   A recorded event does not say how many files it covered, so the summary
 *   can only bound the call as a whole by one native read window.
 *
 * Constants only; this module has no I/O.
 */

/** Claude Code's default Read limit: lines returned per call without offset/limit. */
export const NATIVE_READ_MAX_LINES = 2_000;

/** Claude Code refuses a Read whose content exceeds about this many tokens. */
export const NATIVE_READ_MAX_TOKENS = 25_000;

/** The bytes-per-token ratio of `estimateTokensFromBytes`, the unit of every baseline. */
export const NATIVE_READ_BYTES_PER_TOKEN = 4;

/** {@link NATIVE_READ_MAX_TOKENS} in the bytes a baseline is measured in. */
export const NATIVE_READ_MAX_BYTES = NATIVE_READ_MAX_TOKENS * NATIVE_READ_BYTES_PER_TOKEN;

/**
 * The most one recorded call's baseline may contribute to a summary: one native
 * read window. A recorded event carries one summed `baselineTokens` and no file
 * count, so this is the only bound a summary can apply to it. It under-credits
 * a call that really read several large files; under-crediting is the safe
 * direction for a savings estimate.
 */
export const NATIVE_BASELINE_MAX_TOKENS_PER_CALL = NATIVE_READ_MAX_TOKENS;

/**
 * `tokens` bounded to {@link NATIVE_BASELINE_MAX_TOKENS_PER_CALL}. Only the
 * upper side is touched: a smaller baseline (including 0) is returned as is.
 */
export function boundBaselineTokens(tokens: number): number {
  return tokens > NATIVE_BASELINE_MAX_TOKENS_PER_CALL
    ? NATIVE_BASELINE_MAX_TOKENS_PER_CALL
    : tokens;
}
