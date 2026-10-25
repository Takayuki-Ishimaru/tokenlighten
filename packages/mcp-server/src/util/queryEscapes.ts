/**
 * Line breaks escaped twice in a task query (decision window 6t-8, 2026-10-20,
 * bench/workflows/runs/2026-10-20-v016-decision-6t-8-disclosure.md).
 *
 * T09 rep 2 sent its request with every line break as the two characters `\`
 * and `n`, and no real line break (292 characters): the solver had escaped the
 * JSON string twice. Reps 0 and 1 sent the same request with real line breaks
 * (287 characters) and got the 24,435 B act.edit; rep 2's request read as one
 * line, and its pack came back a 17,756 B discover (gap surface-content).
 * Window 6t-7's T03 rep 0 re-typed its first reply's next the same way (#4,
 * two escapes; replay corpus v016el2).
 *
 * The pack builder reads such a query with those escapes as line breaks: T09
 * rep 2's query then is reps 0 and 1's, character for character, and gets
 * their pack. Four conditions keep this narrow:
 *  - the query has no real line break (CR or LF) at all. One that has a line
 *    break was not escaped twice, and a `\n` in it is text;
 *  - it has at least two `\n` escapes. A lone `\n` is as likely a one-line
 *    Windows path whose next segment starts with `n` (`lib\net`, `D:\notes`)
 *    as an escaped line break, and a request escaped twice has two or more:
 *    the three recorded under bench/ have five (6t-8 T09 rep 2) and two (6t-7
 *    T03 rep 0 #4, the 2026-10-16 simple-bench F1 call);
 *  - every backslash in it begins a `\n`. A Windows path (`C:\Users`), a regex
 *    (`\s+`), `\r`, `\t`, `\"` or `\\` means the backslashes are text, or are
 *    escapes no cell sent, and the query is read as sent;
 *  - no `\n` stands as a word of its own: between spaces (`the \n character`)
 *    or between two identical quotes or backticks (`'\n'`). That one names the
 *    character, and the query is read as sent.
 * server.ts decodes only the projection the pack builder reads
 * (packBuilderQuery, which then applies util/queryFocus.ts); the caller's own
 * input stays under CANONICAL_ORIGINAL_INPUT for replay and restarts. A pack's
 * next restates the query as read, so TL_EFF_AUTOFOLLOW, which follows only a
 * next that re-issues the caller's own query, compares that next with the
 * caller's query projected the same way (server.ts autofollowSkipReason):
 * otherwise T03 rep 0 #4 stays a discover, where the same call with real line
 * breaks is followed into the act.answer (replay corpus v016nl).
 */

/** A real line break: the query was not escaped twice. */
const REAL_LINE_BREAK_RE = /[\r\n]/u;
/** A backslash that does not begin `\n`. */
const OTHER_BACKSLASH_RE = /\\(?!n)/u;
/** A `\n` that names the character: between spaces (or a space and the query's end), or between two identical quotes or backticks. */
const NAMED_ESCAPE_RE = /(?:^|[ \t])\\n(?=[ \t]|$)|(['"`])\\n\1/u;

/** Fewer `\n` escapes than this: as likely a one-line Windows path (`lib\net`) as a line break. */
const MIN_ESCAPED_LINE_BREAKS = 2;

/** The query with its escaped line breaks read as line breaks, or the input itself (the same string). */
export function decodeEscapedLineBreaks(raw: string): string {
  if (REAL_LINE_BREAK_RE.test(raw) || !raw.includes("\\n")) return raw;
  if (raw.split("\\n").length - 1 < MIN_ESCAPED_LINE_BREAKS) return raw;
  if (OTHER_BACKSLASH_RE.test(raw) || NAMED_ESCAPE_RE.test(raw)) return raw;
  return raw.replaceAll("\\n", "\n");
}
