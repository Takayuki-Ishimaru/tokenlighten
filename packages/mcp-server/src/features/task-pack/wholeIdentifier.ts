/**
 * wholeIdentifier.ts — WP-N (eval-0929 §8, 2026-09-29): what counts as an
 * OCCURRENCE of an explicit code identifier the request names.
 *
 * DEFECT (pre-existing in v0.14.4): a request naming `MAX_QUOTA_UNITS` in a
 * workspace that only ever says `MAX_QUOTA_UNITS_V2` certified `act.answer`
 * with `identifier:MAX_QUOTA_UNITS` and its value facet covered and NO gap.
 * Several producers read "the text of X occurs here" through segment or
 * substring matchers (`hasIdentifierSegment` treats `_` and a camelCase hump as
 * a boundary; `scanLiteral` is a plain substring scan), so `X_V2`, `APP_X` and
 * `XLimit` all "contained" X — as a mention site to read, a definition owner to
 * inject, a callable that "reads" X for its value facet, an anchor line.
 *
 * THE RULE (one definition for every explicit-identifier consumer): an
 * explicit identifier occurs only as a WHOLE identifier — the characters
 * immediately before and after it are not identifier characters
 * (`[A-Za-z0-9_$]`, the alphabet `explicitCodeIdentifiers` tokenizes the query
 * with, so the two never disagree about where a name ends). An occurrence
 * inside a longer identifier is a NEAR-MISS: never evidence, never a
 * declaration, never a value — at most advisory text ("did you mean X_V2?").
 *
 * ONE DELIBERATE REFINEMENT: a `$` directly before the name that is itself not
 * glued to a preceding word character (`$X`, `"$X"`, `$$X`) is a variable-
 * reference SIGIL — shell, Makefile, PHP, Perl and most template languages
 * spell a reference to X exactly that way — so it is a boundary, not part of a
 * longer name. Without it an env-var key referenced only as `$API_TIMEOUT` in
 * a script would be certified absent, which is the unsafe direction for an
 * absence claim. `a$X` and a trailing `X$` (RxJS `events$`, a JVM `Outer$X`)
 * stay near-misses.
 *
 * Language-independent by construction (TS/JS, Python, Go, Java, Kotlin, C#,
 * Rust, C/C++, prose, config): it reads characters, never syntax. Segment
 * matching stays where it serves CONCEPT terms (facet subject words, camelCase
 * word search) — this module is only for names the request spelled as code.
 */

/** A character that continues an identifier (the query tokenizer's alphabet). */
const IDENTIFIER_CHAR_RE = /[A-Za-z0-9_$]/;
/** A word character that glues a `$` onto a preceding name (`a$X`). */
const WORD_CHAR_RE = /[A-Za-z0-9_]/;

function isIdentifierChar(ch: string | undefined): boolean {
  return ch !== undefined && ch.length > 0 && IDENTIFIER_CHAR_RE.test(ch);
}

/** Is the character run before `at` a boundary for a name starting at `at`? */
function leftBoundary(text: string, at: number): boolean {
  const before = text[at - 1];
  if (!isIdentifierChar(before)) return true;
  // `$X` — a reference sigil, unless the `$` is itself glued to a word (`a$X`).
  if (before === "$") {
    const beforeSigil = text[at - 2];
    return beforeSigil === undefined || !WORD_CHAR_RE.test(beforeSigil);
  }
  return false;
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface WholeIdentifierOptions {
  /**
   * Compare case-insensitively (the character boundaries still apply). For the
   * consumers that historically matched a name in any case — e.g. an anchor
   * line that is a Markdown heading naming the identifier in prose case.
   */
  readonly caseInsensitive?: boolean;
}

/** Start offsets (into `text`) of every whole-identifier occurrence of `identifier`. */
export function wholeIdentifierOffsets(text: string, identifier: string, options: WholeIdentifierOptions = {}): number[] {
  if (identifier.length === 0 || text.length < identifier.length) return [];
  const matcher = new RegExp(escapeForRegExp(identifier), options.caseInsensitive === true ? "gi" : "g");
  const out: number[] = [];
  for (let match = matcher.exec(text); match !== null; match = matcher.exec(text)) {
    const at = match.index;
    // Overlapping candidates: resume one past this start, never past its end.
    matcher.lastIndex = at + 1;
    if (!leftBoundary(text, at) || isIdentifierChar(text[at + match[0].length])) continue;
    out.push(at);
  }
  return out;
}

/** Does `text` contain `identifier` as a whole identifier (never inside a longer one)? */
export function containsWholeIdentifier(text: string, identifier: string, options: WholeIdentifierOptions = {}): boolean {
  return wholeIdentifierOffsets(text, identifier, options).length > 0;
}

/**
 * The longer identifiers in `text` that merely CONTAIN `identifier` (`X_V2`,
 * `APP_X`, `XLimit`) — the near-miss names, deduped in first-seen order.
 * Advisory only: callers may show them, never treat them as `identifier`.
 */
export function nearMissIdentifiersIn(text: string, identifier: string): string[] {
  if (identifier.length === 0 || text.length < identifier.length) return [];
  const matcher = new RegExp(escapeForRegExp(identifier), "g");
  const seen = new Set<string>();
  const out: string[] = [];
  for (let match = matcher.exec(text); match !== null; match = matcher.exec(text)) {
    const at = match.index;
    matcher.lastIndex = at + 1;
    const end = at + match[0].length;
    if (leftBoundary(text, at) && !isIdentifierChar(text[end])) continue;
    let start = at;
    while (start > 0 && isIdentifierChar(text[start - 1])) start -= 1;
    let stop = end;
    while (stop < text.length && isIdentifierChar(text[stop])) stop += 1;
    const name = text.slice(start, stop);
    if (name === identifier || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}
