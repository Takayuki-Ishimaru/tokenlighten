// callerExpansion.ts — TL_CALLER_EXPANSION (WP-S9, 2026-09-20).
// Turn-economy policy, DEFAULT OFF and a member of the TL_TURN_ECONOMY
// umbrella (see util/flags.ts's `callerExpansionEnabled` for the rollout
// rationale); with the flag unset nothing here is ever reached.
//
// PROBLEM (measured 2026-09-20, live GitHub Copilot sessions): an answer query
// that asks where a request ENTERS the system ("the cancellation API
// endpoint") is answered by a pack that serves the service class, the enum and
// the payment method — and not the HTTP handler that calls
// `orderService.cancel(id)`. The words of that clause ("API", "endpoint",
// "route", "entry point") do not occur in the handler's file at all, so no
// amount of LEXICAL locating can reach it: the relation is structural. The
// model then paid three extra turns (one `find`, two ranged reads) to walk one
// call edge the server already had every ingredient to walk, and one extra
// model turn prices at roughly 9-14 KB of served source on every host
// measured.
//
// MECHANISM: from the evidence the pack ALREADY selected, name at most two
// FOCAL MEMBERS (a surface focused on a method, or a method of a served type
// that the query names), find call sites of those members outside their own
// file, and serve the enclosing function of the best one. "Who calls this" is
// found by matching a call shape and a compatible RECEIVER, never by matching
// the clause's words.
//
// PURE / INJECTED I/O ONLY, exactly like concernRecovery.ts: every function
// here takes plain data — a line of text, a list of occurrences, a path pair.
// It never touches the filesystem, never reads a flag or env var, never sees
// task state. readCodeTaskPack.ts's small hook turns a real workspace scan and
// tree-sitter parse into these inputs, so this module is unit-testable from
// hand-built strings.
//
// GENERALITY: nothing below is keyed to a fixture, project, path or framework.
// The call shapes (`.m(`, `m(`, `::m(`, `->m(`), the receiver-naming
// convention (a field named after its type), and the "a thin entry layer calls
// a member once, a utility calls everything" ranking are properties of how
// code is written, not of any corpus. No annotation, decorator or framework
// name appears anywhere in this file.

// ---------------------------------------------------------------------------
// Tunables (structural, see module doc)
// ---------------------------------------------------------------------------

/** How many members one pack ever chases callers for. Two covers "the entry point" plus one collaborator; more turns an answer pack into a call graph. */
export const MAX_FOCAL_MEMBERS = 2;
/** Hard cap on added surfaces, whatever the pack's own remaining room is. */
export const MAX_CALLER_SURFACES = 2;
/** Hard cap on the total embedded bytes those surfaces may add. */
export const MAX_CALLER_EXPANSION_BYTES = 4096;
/** Margin each side of a call site when no enclosing symbol can be resolved. */
export const CALLER_WINDOW_MARGIN_LINES = 12;
/**
 * Files whose lines are examined in full after the cheap name scan has already
 * narrowed the workspace to files mentioning the member at all. A bound on
 * READS, next to the wall-clock budget the caller also applies: a member named
 * `get` in a large repo must not turn one pack into a whole-workspace parse.
 */
export const MAX_CALLER_FILES_EXAMINED = 40;
/**
 * Minimum normalized length for the WEAK receiver arm (a receiver that merely
 * ends with the type's name). The exact arm needs no guard; this one does,
 * because a two- or three-letter type name is the tail of far too many
 * unrelated identifiers. Mirrors salientWordMatch.ts's own reasoning about
 * short stems.
 */
const MIN_WEAK_RECEIVER_TYPE_CHARS = 4;
/** Receivers that can never denote the focal type: they denote the CALLING object. */
const SELF_RECEIVERS: ReadonlySet<string> = new Set(["this", "self", "super", "base", "cls", "me"]);
/**
 * Extensions whose language starts a line comment with `#`. Anything not
 * listed keeps `#` as ordinary code (C/C++ directives, C# regions).
 *
 * C2 (eval-0927 review-r7 round 8, phpHashCommentFalseCaller): `.php` is
 * included here too -- PHP's `#` is a plain line comment exactly like `//`
 * -- but with a carve-out this set alone cannot express: `#[` opens a PHP 8
 * ATTRIBUTE (`#[Route("/x")]`), never a comment. `maskNonCode` and
 * `blockCommentLineStates` both check for that one sequence explicitly
 * (gated to `.php` via `PHP_ATTRIBUTE_EXTENSIONS`) before treating a bare
 * `#` as a comment opener; every other extension in this set has no such
 * exception and is unaffected.
 */
const HASH_COMMENT_EXTENSIONS: ReadonlySet<string> = new Set([
  ".py", ".rb", ".sh", ".bash", ".zsh", ".pl", ".pm", ".r", ".jl", ".yml", ".yaml", ".toml", ".ex", ".exs", ".cr", ".nim", ".php",
]);
/** `.php` -- see `HASH_COMMENT_EXTENSIONS`'s own doc on the `#[` attribute carve-out. */
const PHP_ATTRIBUTE_EXTENSIONS: ReadonlySet<string> = new Set([".php"]);
/**
 * C6 (eval-0927 review-r7 round 8, rubyRegexSlashStarFalseComment): extensions
 * whose language has NO C-style block-comment syntax (an opening `/` `*`
 * pair, a closing `*` `/` pair) at all -- block-comment detection (both
 * scans, plus the doc-comment-continuation whole-line shortcut at the top of
 * `maskNonCode`, which only ever means anything as an ARTIFACT of that same
 * syntax) must never even attempt to open one for these, or an unrelated
 * two-character `/` `*` sequence inside a construct their OWN language
 * actually has (a Ruby regex character class written as slash, backslash,
 * slash, star, slash) gets misread as a comment opener and can mask an
 * unbounded tail of the file -- today CONFIDENTLY, via
 * `blockCommentLineStates`'s own start-of-line confidence rule, which is
 * exactly how that stray sequence turns into a false EMPTY callers result.
 * Every extension in `HASH_COMMENT_EXTENSIONS` qualifies EXCEPT `.php`,
 * which has real PHPDoc/block comments (an opening `/` `*` `*` triple) on
 * top of its `#`/`//` line comments (see above) -- derived rather than
 * hand-duplicated so the two lists cannot drift apart.
 */
const NO_BLOCK_COMMENT_EXTENSIONS: ReadonlySet<string> = new Set(
  [...HASH_COMMENT_EXTENSIONS].filter((ext) => ext !== ".php"),
);
/** `.rs` -- Rust (see `findRustCharLiteralEnd`'s own doc, C5). */
const RUST_EXTENSIONS: ReadonlySet<string> = new Set([".rs"]);

// ---------------------------------------------------------------------------
// R6-C (eval-0927 review-r5 P1-3): per-language string-interpolation dialects
// `maskNonCode` keeps as CODE. Each is gated by file extension -- unlike the
// backtick/f-string cases (locally unambiguous from the text alone), these
// shapes (a bare `${…}` / `#{…}` / `\(…)` inside an ordinary DOUBLE-quoted
// string) collide with plain literal text in languages that do not have the
// feature (`"${API_BASE}/users"` is inert text in TS -- ts-dq-not-template),
// so every one of these sets is consulted only when `maskNonCode` is given
// the file's `relPath` (an OPTIONAL 3rd parameter -- every existing caller
// that omits it keeps its exact prior behaviour, unchanged).
// ---------------------------------------------------------------------------

/** `.cs` -- C#'s `$"…{expr}…"` / `$@"…"` / `@$"…"` interpolated strings. The `$`/`$@`/`@$` prefix itself is locally unambiguous (see `hasCSharpInterpolationPrefix`), gated here only so the dialect list stays in one place and no other language's incidental `$"` sequence is ever affected. */
const CSHARP_INTERPOLATION_EXTENSIONS: ReadonlySet<string> = new Set([".cs"]);
/** `.kt`/`.kts` -- Kotlin's `"${expr}"` / bare `"$name"` string templates. */
const KOTLIN_TEMPLATE_EXTENSIONS: ReadonlySet<string> = new Set([".kt", ".kts"]);
/** `.swift` -- Swift's `"\(expr)"` string interpolation. */
const SWIFT_INTERPOLATION_EXTENSIONS: ReadonlySet<string> = new Set([".swift"]);
/** `.rb` -- Ruby's `"#{expr}"` string interpolation (never inside a single-quoted string, which Ruby never interpolates). */
const RUBY_INTERPOLATION_EXTENSIONS: ReadonlySet<string> = new Set([".rb"]);
/** Extensions with a JS/TS bare `/regex/` literal syntax, where a quote character INSIDE the pattern (`/"/g`) must never be read as opening a string (tsRegexQuoteConst). */
const JS_REGEX_LITERAL_EXTENSIONS: ReadonlySet<string> = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);

/**
 * C2 (eval-0927 review-r6 P2-9, rubyPercentLiteralFalseCaller): Ruby's
 * `%q(…)`/`%Q[…]`/`%(…)`/`%w(…)`/`%i(…)` percent-literal openers -- `q` and
 * bare `%` are the single/double-quote-equivalent string forms, `w`/`i` the
 * word/symbol-array forms; every one of them is a LITERAL, so `%q(run(1)
 * text)`'s inner `run(1)` is text, never a call. Only the four bracket
 * delimiters are recognized (`%q|text|`-style arbitrary-punctuation
 * delimiters are a residual, left unhandled -- this module's usual
 * recall-direction abstention); a bracket delimiter NESTS, so an inner
 * `run(1)` does not close the literal early. Gated to `.rb`
 * (RUBY_INTERPOLATION_EXTENSIONS) at the call site, like every other
 * per-language dialect in this file, AND (at that same call site) to a
 * position where `looksLikeRegexContext` says an EXPRESSION is expected --
 * without that guard, `total %(2)` (modulo by a parenthesized operand, no
 * space) would misread its `%(` as this SAME opener and blank the modulo's
 * right-hand side. `%W`/`%I` (the interpolated word/symbol forms) are not in
 * this list -- an unmatched `%` is simply ordinary code, the same abstention
 * this module always falls back to.
 */
const RUBY_PERCENT_LITERAL_RE = /^%([qQwi]?)([([{<])/;
const RUBY_PERCENT_LITERAL_CLOSERS: Readonly<Record<string, string>> = { "(": ")", "[": "]", "{": "}", "<": ">" };

/** Lower-cased file extension (including the dot), or `undefined` for an unset/extensionless path. */
function extensionOf(relPath: string | undefined): string | undefined {
  if (relPath === undefined) return undefined;
  const dot = relPath.lastIndexOf(".");
  return dot > 0 ? relPath.slice(dot).toLowerCase() : undefined;
}

// ---------------------------------------------------------------------------
// Focal members
// ---------------------------------------------------------------------------

/** A member the pack's own selected evidence is focused on — the thing whose CALLERS this expansion looks for. */
export interface CallerFocalMember {
  /** Workspace-relative file that DEFINES the member. Never added as its own caller. */
  readonly path: string;
  /** Simple name of the type the member belongs to (its enclosing class/interface, else the file's own stem) — the left-hand side of the receiver test. */
  readonly typeName: string;
  /** The member's own unqualified name. */
  readonly member: string;
}

export interface FocalMemberCandidate extends CallerFocalMember {
  /** Index of the selected surface this came from. The pack's own evidence order is the primary rank: surface 0 is what the locator certified. */
  readonly surfaceIndex: number;
  /** 0 when the SURFACE is focused on this member; 1 when the surface is a whole type and the QUERY named this member. A stated focus outranks an inferred one. */
  readonly tier: number;
  /** Character offset in the query of the word that named this member; Number.MAX_SAFE_INTEGER when the surface, not the query, named it. */
  readonly queryPosition: number;
  /**
   * Another selected surface is ALREADY focused on a member of this name, so
   * chasing this one asks the same question twice. Ranks last rather than
   * being dropped: with nothing else to pick it is still a real member.
   */
  readonly redundant: boolean;
}

/**
 * At most MAX_FOCAL_MEMBERS, preferring non-redundant members, then the pack's
 * own evidence order, then a stated focus over a query-named one, then the
 * earlier-named concern. One per FILE first, so two members of one served
 * class never crowd out a second served class's member — the pack's evidence
 * spread is the best proxy for what the request spread over.
 */
export function pickFocalMembers(candidates: readonly FocalMemberCandidate[]): FocalMemberCandidate[] {
  const ordered = [...candidates].sort((a, b) =>
    Number(a.redundant) - Number(b.redundant)
    || a.surfaceIndex - b.surfaceIndex
    || a.tier - b.tier
    || a.queryPosition - b.queryPosition
    || a.member.localeCompare(b.member)
  );
  const picked: FocalMemberCandidate[] = [];
  const takenKeys = new Set<string>();
  const takenPaths = new Set<string>();
  for (const pass of [0, 1]) {
    for (const candidate of ordered) {
      if (picked.length >= MAX_FOCAL_MEMBERS) return picked;
      const key = `${candidate.path}\0${candidate.member}`;
      if (takenKeys.has(key)) continue;
      if (pass === 0 && takenPaths.has(candidate.path)) continue;
      takenKeys.add(key);
      takenPaths.add(candidate.path);
      picked.push(candidate);
    }
  }
  return picked;
}

/** Case- and underscore-insensitive identifier normalization (the same rule readCodeTaskPack.ts's `normIdent` applies to token/surface matching). */
export function normalizeCallerIdent(text: string): string {
  return text.toLowerCase().replace(/[_$]/g, "");
}

// ---------------------------------------------------------------------------
// Call-site shapes
// ---------------------------------------------------------------------------

/** How a call names its member. `bare` carries no receiver and needs the file to name the focal type independently. */
export type CallQualifier = "dot" | "scope" | "arrow" | "bare";

export interface CallSiteOccurrence {
  /** 0-based index of the member name within the line. */
  readonly column: number;
  readonly qualifier: CallQualifier;
  /** The identifier immediately left of the qualifier when there is one (`orderService` in `this.orderService.cancel(`); absent for a bare call or a chained expression (`repo.find(id).cancel(`). */
  readonly receiver?: string;
  /** Masked line text left of the member name — the caller applies its own declaration-keyword test to this (a definition is not a call). */
  readonly before: string;
}

const IDENTIFIER_CHAR_RE = /[A-Za-z0-9_$]/;
const TRAILING_IDENTIFIER_RE = /([A-Za-z_$][A-Za-z0-9_$]*)$/;

/** True when `relPath`'s language opens a line comment with `#`. */
export function hasHashComments(relPath: string): boolean {
  const dot = relPath.lastIndexOf(".");
  return dot > 0 && HASH_COMMENT_EXTENSIONS.has(relPath.slice(dot).toLowerCase());
}

/**
 * A Python string-prefix (`f`/`F`, optionally combined with `r`/`R` in
 * either order — `rf`/`fr` and their case variants; never `b`, which cannot
 * combine with `f`) sitting immediately before `before`'s end, with no
 * identifier character ahead of it — see `maskNonCode`'s own f-string case.
 */
const PY_FSTRING_PREFIX_RE = /(?:^|[^A-Za-z0-9_])([rRfF]{1,2})$/;
function hasFStringPrefix(before: string): boolean {
  const prefix = PY_FSTRING_PREFIX_RE.exec(before)?.[1]?.toLowerCase();
  return prefix === "f" || prefix === "rf" || prefix === "fr";
}

/**
 * A C# interpolated-string prefix (`$"`, `$@"`, `@$"`) sitting immediately
 * before `before`'s end (P1-3, csInterpolatedConst) -- locally unambiguous
 * exactly like `hasFStringPrefix` above: no language this module covers ever
 * juxtaposes a bare identifier directly against a string literal with no
 * operator between them, so `$`/`$@`/`@$` right before a quote is never
 * anything else. Still gated by `CSHARP_INTERPOLATION_EXTENSIONS` at the call
 * site so it is only ever consulted for a `.cs` file.
 */
const CSHARP_INTERPOLATION_PREFIX_RE = /(?:^|[^A-Za-z0-9_$])(?:\$@|@\$|\$)$/;
function hasCSharpInterpolationPrefix(before: string): boolean {
  return CSHARP_INTERPOLATION_PREFIX_RE.test(before);
}

/**
 * Cheap, bounded "does a bare `/` at this point open a REGEX LITERAL rather
 * than mean division" heuristic (P1-3, tsRegexQuoteConst) -- the standard
 * lexer shortcut: a regex can only start where an EXPRESSION is expected
 * (after an operator, an opening bracket, a separator, or a keyword that
 * cannot itself be a value), never right after something that already
 * produced a value (an identifier, `)`, `]`, a number, or a closing quote).
 * Deliberately over-approximates toward "not a division" being the ONLY
 * thing that disqualifies a slash: a slash this heuristic misses as a regex
 * opener just leaves `maskNonCode`'s prior (safe, single-line-abstaining)
 * behaviour for that one occurrence, never a new false positive.
 *
 * FIX (C3, eval-0927 review-r6 P1-6, ts-decrement-then-division-then-string):
 * a trailing `--`/`++` immediately before the slash is a POSTFIX
 * increment/decrement, which -- exactly like an identifier or a closing
 * `)`/`]` -- already produced a VALUE, so the slash that follows is division,
 * never a regex opener, even though a single trailing `-`/`+` (unary) still
 * is one. Checked first and narrowly: only the literal two-character run
 * right against the end of `before` is excluded.
 */
const REGEX_LITERAL_CONTEXT_RE = /(?:^|[([{,;:=!&|?+\-*%<>~^]|\b(?:return|typeof|instanceof|in|of|new|delete|void|throw|yield|case|do|else)\s*)$/;
const POSTFIX_INC_DEC_RE = /(?:\+\+|--)$/;
function looksLikeRegexContext(before: string): boolean {
  const trimmed = before.replace(/\s+$/, "");
  if (POSTFIX_INC_DEC_RE.test(trimmed)) return false;
  return REGEX_LITERAL_CONTEXT_RE.test(trimmed);
}

/**
 * From an opening `/` at `openAt` (already confirmed a regex context by
 * `looksLikeRegexContext`), the index of the matching unescaped closing `/`
 * on the SAME line, or -1 when none closes here (a multi-line regex is not a
 * real JS/TS shape, so this is simply an abstention, consistent with the
 * rest of this deliberately single-line module). A `[…]` character class may
 * contain an unescaped `/` that does not close the literal.
 */
function findRegexLiteralEnd(text: string, openAt: number): number {
  let inClass = false;
  for (let j = openAt + 1; j < text.length; j++) {
    const ch = text[j]!;
    if (ch === "\\") { j++; continue; }
    if (ch === "[") { inClass = true; continue; }
    if (ch === "]") { inClass = false; continue; }
    if (ch === "/" && !inClass) return j;
  }
  return -1;
}

/**
 * C3 (eval-0927 review-r7 round 8, ktNestedSingleLineFalseCaller): `closeAt`
 * is the index of the `*` that begins the block-comment closer `*\/` matching
 * the opener already found at `openAt` (`text[openAt..openAt+1] === "/*"`),
 * or -1 when it never closes within `text`. Depth-generic: when `nesting` is
 * true (a language in `NESTING_BLOCK_COMMENT_EXTENSIONS`), an inner `/*` seen
 * before the matching closer pushes the depth one deeper, so `/* a /* b *\/ c
 * *\/` only closes at the SECOND `*\/` -- exactly what `blockCommentLineStates`'s
 * own multi-line carry-over loop already does for a comment CONTINUING onto a
 * new line, applied here to one that both opens AND closes on the SAME line,
 * which used to fall back to a naive `indexOf("*\/", …)` (the FIRST `*\/`,
 * ignoring nesting entirely, so text still logically inside the comment --
 * `formatBytes(total)` in `/* old /* legacy *\/ formatBytes(total) *\/` --
 * read as real code) in both `maskNonCode` and this file's own same-line
 * opener scan. When `nesting` is false this always closes at the position of
 * the very FIRST `*\/`, identical to the old `indexOf` call -- a safe
 * drop-in replacement for every non-nesting language.
 *
 * `depth` is the nesting depth STILL OPEN when `closeAt` is -1 (always 1 for
 * a non-nesting language, or a nesting one with at most one unclosed `/*` on
 * this line; only > 1 when the line itself opens MULTIPLE nested comments
 * none of which close before EOL, e.g. `/* outer /* inner` with no `*\/` at
 * all) -- `blockCommentLineStates`'s same-line opener branch seeds its
 * cross-line `blockDepth` counter from this, not a hardcoded 1, so a later
 * line's carry-over scan requires the CORRECT number of closers before it
 * lets real code through (losing this would itself be a new false-caller
 * class: text still logically nested two levels deep exposed after only one
 * `*\/` on a later line). Meaningless (always 0) when `closeAt` is not -1.
 */
function findBlockCommentEnd(text: string, openAt: number, nesting: boolean): { readonly closeAt: number; readonly depth: number } {
  let depth = 1;
  let j = openAt + 2;
  while (j < text.length) {
    if (nesting && text[j] === "/" && text[j + 1] === "*") { depth++; j += 2; continue; }
    if (text[j] === "*" && text[j + 1] === "/") {
      depth--;
      if (depth === 0) return { closeAt: j, depth: 0 };
      j += 2;
      continue;
    }
    j++;
  }
  return { closeAt: -1, depth };
}

/**
 * C5 (eval-0927 review-r7 round 8, rustLifetimeFalseString): a Rust `'` at
 * `openAt` opens a CHAR LITERAL only when what immediately follows is a
 * valid char body -- one ordinary character, or a backslash escape (`\n`
 * `\r` `\t` `\\` `\0` `\'` `\"`, a byte escape `\xNN`, or a unicode escape
 * `\u{…}` with 1-6 hex digits) -- followed right away by a closing `'`:
 * `'a'`, `'\n'`, `'\''`, `'\u{1F600}'`. Anything else sharing the same
 * leading sigil (`'a`, `'static`, `'outer:`) is a LIFETIME or a LOOP LABEL,
 * never a string -- Rust's own grammar tells these apart only by whether a
 * closing `'` actually follows in exactly this shape, so this function
 * abstains (-1, "not a char literal") rather than guessing whenever it does
 * not, the same direction every heuristic in this module already favors.
 * Returns the index of the closing `'`, or -1.
 */
const RUST_CHAR_ESCAPE_RE = /^\\(?:[nrt0\\'"]|x[0-9A-Fa-f]{2}|u\{[0-9A-Fa-f]{1,6}\})/;
function findRustCharLiteralEnd(text: string, openAt: number): number {
  const rest = text.slice(openAt + 1);
  if (rest.length === 0 || rest[0] === "'") return -1; // nothing, or an empty '' -- not a char literal
  if (rest[0] === "\\") {
    const esc = RUST_CHAR_ESCAPE_RE.exec(rest);
    if (esc === null) return -1;
    const closeAt = openAt + 1 + esc[0].length;
    return text[closeAt] === "'" ? closeAt : -1;
  }
  const closeAt = openAt + 2; // one ordinary body character
  return text[closeAt] === "'" ? closeAt : -1;
}

/**
 * A3 (eval-0927 review-r8/r9 round 9, rustRawStringSlashStarCaller): a Rust
 * raw string opens with `r` or `br` -- LOWERCASE only, Rust's own grammar has
 * no case-insensitive raw-string prefix, unlike Python's `rb`/`Rb`/... --
 * followed by zero or more `#`, then a `"`: `r"…"`, `r#"…"#`, `br"…"`,
 * `br#"…"#` (any number of `#`, matched pairwise with the closer). Unlike an
 * ordinary string, its content has NO escape processing at all -- a `\` is a
 * literal character, and a bare `"` inside it (with fewer than `hashCount`
 * trailing `#`s, or none) never closes the string, which is exactly what
 * lets a `/*`-look-alike sequence inside one slip through as inert text
 * instead of opening a real block comment (the reported defect: a raw
 * string's own `/*` masked the rest of the file CONFIDENTLY, finding no real
 * `*\/` closer anywhere). Only fires when a `"` (after the optional `#`s)
 * immediately follows, so an ordinary identifier ending in `r`/`br`
 * (`bar(`, `attempt_r =`) never misfires -- the same narrow-positive-match
 * discipline `findRustCharLiteralEnd` already uses for `'`. Returns
 * `undefined` when `at` does not open one.
 */
function findRustRawStringOpenerAt(text: string, at: number): { hashCount: number; contentStart: number } | undefined {
  let i = at;
  if (text.startsWith("br", i)) i += 2;
  else if (text[i] === "r") i += 1;
  else return undefined;
  let hashCount = 0;
  while (text[i + hashCount] === "#") hashCount++;
  if (text[i + hashCount] !== '"') return undefined;
  return { hashCount, contentStart: i + hashCount + 1 };
}

/**
 * The index of the LAST character of a Rust raw string's closer (a `"`
 * followed by exactly `hashCount` `#`s) at or after `from` in `text`, or -1
 * when none appears. A run of MORE than `hashCount` `#`s still closes it
 * (Rust's own grammar: the closer is the FIRST `"` followed by AT LEAST
 * `hashCount` `#`s -- the string's own content can never contain that exact
 * sequence, so a run of extra trailing `#`s is simply literal text after the
 * closer), so a plain substring search for `"` + `hashCount` `#`s is exact.
 */
function findRustRawStringEnd(text: string, from: number, hashCount: number): number {
  const closer = '"' + "#".repeat(hashCount);
  const idx = text.indexOf(closer, from);
  return idx === -1 ? -1 : idx + closer.length - 1;
}

/**
 * P2-8 (eval-0927 review-r5 #8, `c-star-space-call`): a `* IDENT(args) =
 * value;` dereference-assignment (C-family pointer style, sometimes written
 * with a space after the leading `*` -- `* run(x) = 3;`) is CODE, never a
 * doc-comment continuation line, even though it starts exactly like one
 * (`* text`). Deliberately narrow: only this call-then-assignment shape
 * overrides the doc-comment-continuation default just below -- ordinary
 * JSDoc prose (`* returns the sum`) has no `(...) =` after the leading word
 * and never matches.
 */
const STAR_SPACE_CODE_RE = /^\*\s+[A-Za-z_$][\w$]*\s*\([^()]*\)\s*=(?!=)/;

/**
 * Blanks out every span of `text` that is a string literal or a line/inline
 * comment, PRESERVING LENGTH so every column stays valid. A whole line that
 * opens with a block-comment marker or continuation is blanked outright: that
 * is the Javadoc/JSDoc body, where a prose sentence naming the member reads
 * exactly like a call.
 *
 * FIX (R5-A2, eval-0927 review-r4 P1-6, cpp-deref-assign): the block-comment-
 * continuation lead is narrowed to what a doc-comment body actually looks
 * like — bare `*`, the block-comment CLOSER, `**`, or `*` followed by
 * whitespace (` * text`) — never a `*` immediately followed by an
 * identifier character, which is a
 * DEREFERENCE expression (`*run(x) = 3;`) in every C-family language this
 * module covers, not a comment. A real mid-block-comment line with no
 * opener that happens to look like code is still the same abstention this
 * function's own doc already accepts for that shape generally.
 *
 * FIX (R5-A2, eval-0927 review-r4 P1-5, ts-template-interp/py-fstring/
 * ts-tagged-template-arg): a JS/TS template-literal `${…}` interpolation and
 * a Python f-string `{…}` replacement field (never a literal `{{`) carry
 * REAL CODE — interpolating a call is completely ordinary (`` `total
 * ${run(n)} bytes` ``, `f"total {run(n)} bytes"`) — so their content is left
 * exactly as `text` has it instead of being blanked with the rest of the
 * literal. Brace depth is tracked so a nested object literal/dict inside the
 * field (`${{a: 1}}`) does not end it early; a nested quote inside the field
 * is not specially parsed (out of scope — this function abstains there the
 * same way it already abstains on a multi-line string/comment).
 *
 * Deliberately single-line: a line in the middle of a multi-line string or
 * block comment with no opener of its own cannot be classified without
 * parsing, and this module abstains rather than guessing (a FILE-LEVEL
 * companion for exactly that gap -- multi-line block comments and Python
 * docstrings -- is `computeBlockCommentMask` below). The failure direction is
 * recall (a real call missed), never a false caller.
 *
 * `relPath` is OPTIONAL and purely additive (P1-3, eval-0927 review-r5 #3):
 * every caller that omits it keeps its exact prior behaviour. When given, it
 * unlocks a handful of per-LANGUAGE double-quoted-string interpolation
 * dialects (C#, Kotlin, Swift, Ruby -- see the extension sets above) and
 * JS/TS regex-literal awareness, none of which can be told apart from plain
 * literal text without knowing the file's language.
 */
export function maskNonCode(text: string, hashComment: boolean, relPath?: string): string {
  const trimmed = text.trimStart();
  const ext = extensionOf(relPath);
  // C6 (eval-0927 review-r7 round 8, rubyRegexSlashStarFalseComment):
  // computed here, before the three shortcuts just below, because every one
  // of them means anything ONLY as an artifact of C-style block-comment
  // syntax (a comment closer line, or a JSDoc/Javadoc `* text` continuation
  // line) -- a language that has no such syntax must never take them.
  const noBlockComments = ext !== undefined && NO_BLOCK_COMMENT_EXTENSIONS.has(ext);
  // C3 bullet 1 (eval-0927 review-r6 P2-11, c-closer-with-trailing-code): a
  // line whose CODE starts with the block-comment CLOSER "*/" is a comment
  // remnant that may carry real code after it (`*/ run(2);`) -- blank
  // exactly through the closer and re-run this SAME function on the
  // remainder, rather than the whole-line blank the doc-comment-continuation
  // branch below would otherwise apply (that branch's own lead pattern
  // excludes this shape on purpose -- see its comment). A closer with
  // nothing (or only whitespace) after it still ends up entirely blank,
  // just via the recursive call on an empty/whitespace-only remainder.
  if (!noBlockComments && trimmed.startsWith("*/")) {
    const closerEnd = text.length - trimmed.length + 2;
    return " ".repeat(closerEnd) + maskNonCode(text.slice(closerEnd), hashComment, relPath);
  }
  if (
    trimmed.startsWith("//")
    || (!noBlockComments && trimmed.startsWith("*") && (trimmed.length === 1 || (/^\*[\s*]/.test(trimmed) && !STAR_SPACE_CODE_RE.test(trimmed))))
  ) {
    // C3 bullet 2 (opensBlockDeclaration-adjacent, eval-0927 review-r6 P2-11
    // class): a line starting "/*" is deliberately NOT shortcut-blanked here
    // any more -- when it closes on the SAME line (`/* note */ run(2);`) the
    // general per-character scan below (fixed for C3 bullet 3) blanks only
    // its own span and keeps the trailing code; when it genuinely does not
    // close on this line, that same scan's unconditional "/*" handling still
    // blanks straight to end of line, so the net effect for that case is
    // identical to the old whole-line shortcut. The doc-comment CONTINUATION
    // rule just below (bare `*`, `**`, `* text`) is UNCHANGED -- only the
    // "/" alternative (which used to also swallow a `*/`-led closer line
    // into this same branch) was removed from its lead pattern.
    return " ".repeat(text.length);
  }
  const kotlinFile = ext !== undefined && KOTLIN_TEMPLATE_EXTENSIONS.has(ext);
  const swiftFile = ext !== undefined && SWIFT_INTERPOLATION_EXTENSIONS.has(ext);
  const rubyFile = ext !== undefined && RUBY_INTERPOLATION_EXTENSIONS.has(ext);
  const csharpFile = ext !== undefined && CSHARP_INTERPOLATION_EXTENSIONS.has(ext);
  const jsRegexFile = ext !== undefined && JS_REGEX_LITERAL_EXTENSIONS.has(ext);
  const rustFile = ext !== undefined && RUST_EXTENSIONS.has(ext);
  const phpFile = ext !== undefined && PHP_ATTRIBUTE_EXTENSIONS.has(ext);
  const nestingComments = ext !== undefined && NESTING_BLOCK_COMMENT_EXTENSIONS.has(ext);
  // The scanner indexes UTF-16 code units; preserve them after astral text.
  const out = text.split("");
  let quote: string | undefined;
  let interpolating = false; // this quote run supports `${…}` (backtick) / `{…}` (f-string/C#) fields
  let fieldDepth = 0; // >0 while inside such a field -- code, left un-blanked
  let fieldOpen: "{" | "(" = "{"; // the field's own opener char (Swift's `\(…)` uses parens, every other dialect braces)
  let fieldClose: "}" | ")" = "}";
  let fieldQuote: string | undefined; // a string literal NESTED inside the field (P1-5, templateInnerQuoteFalseCaller) -- blanked like any other string
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote !== undefined) {
      if (fieldDepth > 0) {
        if (fieldQuote !== undefined) {
          // P1-5 (templateInnerQuoteFalseCaller): a string literal NESTED
          // inside the field is still a string -- blank it exactly like the
          // outer scan does, never leave its content readable as code.
          if (ch === "\\") {
            out[i] = " ";
            if (i + 1 < text.length) out[i + 1] = " ";
            i++;
            continue;
          }
          out[i] = " ";
          if (ch === fieldQuote) fieldQuote = undefined;
          continue;
        }
        // C2 (eval-0927 review-r6 P2-9, nestedTemplateInFieldFalseCaller): a
        // BACKTICK nested inside this field opens a NESTED template literal
        // -- treated exactly like any other nested string (blanked whole,
        // via the SAME fieldQuote mechanism just above). This is a bounded
        // simplification, not a real recursive re-lex: the nested template's
        // OWN `${…}` fields are blanked along with its literal text (a
        // recall-direction miss, never a false caller -- consistent with
        // this function's stated failure direction), rather than being
        // walked as a further level of live code.
        if (ch === '"' || ch === "'" || ch === "`") { fieldQuote = ch; out[i] = " "; continue; }
        if (ch === fieldOpen) fieldDepth++;
        else if (ch === fieldClose) fieldDepth--;
        continue; // leave the character exactly as `text` has it -- real code
      }
      if (swiftFile && quote === '"' && ch === "\\" && text[i + 1] === "(") {
        out[i] = " "; // the backslash itself carries no meaning on its own
        fieldOpen = "("; fieldClose = ")";
        fieldDepth = 1;
        i++; // the field's own `(` (already accounted for above) is left un-blanked
        continue;
      }
      if (ch === "\\") {
        out[i] = " ";
        if (i + 1 < text.length) out[i + 1] = " ";
        i++;
        continue;
      }
      if (quote === "`" && ch === "$" && text[i + 1] === "{") {
        out[i] = " "; // the `$` itself carries no meaning on its own
        fieldOpen = "{"; fieldClose = "}";
        fieldDepth = 1;
        i++; // the field's own `{` (already accounted for above) is left un-blanked
        continue;
      }
      if (kotlinFile && quote === '"' && ch === "$" && text[i + 1] === "{") {
        out[i] = " ";
        fieldOpen = "{"; fieldClose = "}";
        fieldDepth = 1;
        i++;
        continue;
      }
      if (rubyFile && quote === '"' && ch === "#" && text[i + 1] === "{") {
        out[i] = " ";
        fieldOpen = "{"; fieldClose = "}";
        fieldDepth = 1;
        i++;
        continue;
      }
      if (kotlinFile && quote === '"' && ch === "$" && /[A-Za-z_]/.test(text[i + 1] ?? "")) {
        // Kotlin's braceless `"$name"` shorthand -- the field is exactly the
        // identifier that follows, never balanced by a closer.
        out[i] = " ";
        let j = i + 1;
        while (j < text.length && IDENTIFIER_CHAR_RE.test(text[j]!)) j++;
        i = j - 1;
        continue;
      }
      if (interpolating && quote !== "`" && ch === "{") {
        if (text[i + 1] === "{") { out[i] = " "; out[i + 1] = " "; i++; continue; } // `{{` -- an escaped literal brace
        fieldOpen = "{"; fieldClose = "}";
        fieldDepth = 1;
        continue; // leave `ch` (the field's own `{`) un-blanked
      }
      if (ch === quote) { out[i] = " "; quote = undefined; continue; }
      out[i] = " ";
      continue;
    }
    // C5 (eval-0927 review-r7 round 8, rustLifetimeFalseString): checked
    // BEFORE the generic quote-open branch just below, and only for Rust --
    // a `'` there opens a real char literal only when `findRustCharLiteralEnd`
    // confirms it actually closes as one (own doc); otherwise it is a
    // lifetime/loop-label sigil and must fall through as ordinary code, never
    // start the generic (any-later-`'`-closes-it) quote scan, which would
    // otherwise blank real code between two unrelated lifetimes/labels.
    if (rustFile && ch === "'") {
      const closeAt = findRustCharLiteralEnd(text, i);
      if (closeAt === -1) continue; // a lifetime/label -- ordinary code
      for (let j = i; j <= closeAt; j++) out[j] = " ";
      i = closeAt;
      continue;
    }
    // A3 (eval-0927 review-r8/r9 round 9, rustRawStringSlashStarCaller):
    // checked BEFORE the generic quote-open branch just below, Rust only --
    // a raw string's content (including any `/*`-look-alike) has no escapes
    // and is never scanned for comment markers; blank the whole literal
    // (prefix through its closer, or to end of line when it does not close
    // here) exactly like an ordinary string -- see
    // `findRustRawStringOpenerAt`'s own doc. Without this, the bare `"` the
    // generic branch just below would open (ignoring the `r`/`br#` prefix)
    // closes on the FIRST literal `"` regardless of hash count, which is
    // wrong for `r#"…"#` and worse, wrong-DIRECTION safe (under, not over,
    // masked) whenever the string's own content holds an unmatched `"`.
    if (rustFile && (ch === "r" || ch === "b")) {
      const opener = findRustRawStringOpenerAt(text, i);
      if (opener !== undefined) {
        const closeAt = findRustRawStringEnd(text, opener.contentStart, opener.hashCount);
        const end = closeAt === -1 ? text.length - 1 : closeAt;
        for (let j = i; j <= end; j++) out[j] = " ";
        i = end;
        continue;
      }
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      interpolating = ch === "`"
        || hasFStringPrefix(text.slice(0, i))
        || (csharpFile && ch === '"' && hasCSharpInterpolationPrefix(text.slice(0, i)));
      out[i] = " ";
      continue;
    }
    // FIX (C2 hardening): a `%` immediately before one of the four bracket
    // delimiters is Ruby's percent-literal ONLY where an EXPRESSION is
    // expected -- exactly the same ambiguity `looksLikeRegexContext` already
    // resolves for a bare `/`, reused here so `total %(2)` (modulo by a
    // parenthesized operand, no space -- a value already precedes the `%`)
    // is never misread as `%(...)` and blanked.
    if (rubyFile && ch === "%" && looksLikeRegexContext(text.slice(0, i))) {
      const opener = RUBY_PERCENT_LITERAL_RE.exec(text.slice(i));
      if (opener !== null) {
        const openCh = opener[2]!;
        const closeCh = RUBY_PERCENT_LITERAL_CLOSERS[openCh]!;
        const markerLen = opener[0].length;
        for (let k = i; k < i + markerLen; k++) out[k] = " ";
        let depth = 1;
        let j = i + markerLen;
        let closedAt = -1;
        for (; j < text.length; j++) {
          const cj = text[j]!;
          if (cj === "\\") {
            out[j] = " ";
            if (j + 1 < text.length) out[j + 1] = " ";
            j++;
            continue;
          }
          out[j] = " ";
          if (cj === openCh) { depth++; continue; }
          if (cj === closeCh) {
            depth--;
            if (depth === 0) { closedAt = j; break; }
          }
        }
        if (closedAt !== -1) { i = closedAt; continue; }
        for (let k = i; k < text.length; k++) out[k] = " ";
        break;
      }
    }
    // C3 bullet 3 (eval-0927 review-r6 P2-11 class): "//" (and a hash
    // comment) always run to end of line -- unchanged. A "/*" block comment
    // now blanks ONLY ITS OWN SPAN when a "*/" closes it on this SAME line,
    // resuming normal scanning right after (today it blanked straight to
    // end of line regardless); it still blanks to end of line, unchanged,
    // when no closer appears on this line. This ordering (checking the
    // IMMEDIATE next character for "/" / "*" first) matches
    // `blockCommentLineStates` below and is what keeps a stray "/" INSIDE a
    // real comment's own text (a URL's "//", a path) from ever reaching the
    // regex check just below.
    if (ch === "/" && text[i + 1] === "/") {
      for (let j = i; j < text.length; j++) out[j] = " ";
      break;
    }
    // C2 (eval-0927 review-r7 round 8, phpHashCommentFalseCaller): `#[` is a
    // PHP 8 ATTRIBUTE opener (`#[Route("/x")]`), never a comment -- checked
    // only for `.php` (every other hash-comment language has no such
    // exception, so a bare `#[...]` in Python/Ruby/shell etc. is still an
    // ordinary comment starting with a literal `[`).
    if (hashComment && ch === "#" && !(phpFile && text[i + 1] === "[")) {
      for (let j = i; j < text.length; j++) out[j] = " ";
      break;
    }
    // C6 (eval-0927 review-r7 round 8, rubyRegexSlashStarFalseComment): a
    // language with no `/* */` syntax at all (`noBlockComments`) never opens
    // one -- see that flag's own doc. C3 (ktNestedSingleLineFalseCaller):
    // otherwise, `findBlockCommentEnd` replaces the old plain `indexOf`
    // scan so a NESTING language's inner `/*`/`*/` pair does not prematurely
    // close the outer comment and expose its still-commented tail as code.
    if (!noBlockComments && ch === "/" && text[i + 1] === "*") {
      const { closeAt } = findBlockCommentEnd(text, i, nestingComments);
      if (closeAt === -1) {
        for (let j = i; j < text.length; j++) out[j] = " ";
        break;
      }
      for (let j = i; j <= closeAt + 1; j++) out[j] = " ";
      i = closeAt + 1;
      continue;
    }
    if (jsRegexFile && ch === "/" && looksLikeRegexContext(text.slice(0, i))) {
      const closeAt = findRegexLiteralEnd(text, i);
      if (closeAt !== -1) {
        for (let k = i; k <= closeAt; k++) out[k] = " ";
        i = closeAt;
        continue;
      }
    }
  }
  return out.join("");
}

/** `.py`/`.pyi` -- the only extensions where a `"""`/`'''` run is Python's own triple-quoted docstring/string delimiter (P1-5, pyDocstringFalseCaller). Deliberately narrow: outside Python three quote characters in a row carry no special meaning, and treating them as an opener elsewhere risks masking a large, unrelated tail of the file until some later, unrelated `"""`/`'''` happens to appear. */
const PYTHON_TRIPLE_QUOTE_EXTENSIONS: ReadonlySet<string> = new Set([".py", ".pyi"]);
/**
 * C7 (eval-0927 review-r7 round 8, pyPrefixedTripleQuoteConfident): a valid
 * Python string prefix immediately before a triple-quote marker -- `r`/`R`,
 * `b`/`B`, `f`/`F`, `u`/`U` alone, or a valid two-letter raw/bytes or
 * raw/f-string combination in either order (`rb`/`br`/`rf`/`fr`, any case;
 * `u` never combines) -- with only whitespace before THAT counts as an
 * opener exactly as confident as an unprefixed `"""`/`'''`: the prefix picks
 * the string's runtime type, never whether the marker genuinely starts one.
 */
const PY_TRIPLE_QUOTE_PREFIX_RE = /^\s*(?:[rRbBfFuU]|[rR][bBfF]|[bBfF][rR])?$/;
/**
 * Extensions whose block comments NEST (C2, eval-0927 review-r6 P2-9,
 * {kt,rs}NestedBlockCommentFalseCaller): a `/*` seen while ALREADY inside an
 * open block comment starts its OWN inner span that must close before the
 * outer one does, so `/* outer /* inner *\/ still comment *\/` only ends at
 * the SECOND `*\/`. Every other extension (plain C/C++/Java/C#/JS/TS/CSS/Go,
 * none of which nest) keeps the single-level rule: the FIRST `*\/` always
 * closes.
 */
const NESTING_BLOCK_COMMENT_EXTENSIONS: ReadonlySet<string> = new Set([".kt", ".kts", ".swift", ".rs", ".scala", ".sc", ".dart"]);
/**
 * `=begin`/`=end`, Ruby's OWN embedded-documentation delimiters (C2,
 * eval-0927 review-r6 P2-9, rubyBlockCommentFalseCaller) -- gated to `.rb`
 * (RUBY_INTERPOLATION_EXTENSIONS). Unlike every other opener this module
 * recognizes, Ruby requires column 0 EXACTLY (no leading whitespace at all
 * is valid), so these are tested against the raw line, never a trimmed one.
 */
const RUBY_BEGIN_RE = /^=begin\b/;
const RUBY_END_RE = /^=end\b/;

/**
 * From a JS/TS template-literal backtick already open at the START of
 * `line` (index 0 -- carried over UNCLOSED from a prior line), the index of
 * its matching unescaped closing backtick, or -1 when none closes on this
 * line (C1, eval-0927 review-r6 P1-6 class, multiLineTemplateHidesLaterCode).
 * Deliberately shallow: it does NOT track `${…}` field depth, so a raw
 * backtick inside a field (a nested template) reads as the OUTER template's
 * own closer -- a bounded under-approximation of the real grammar, not a
 * full re-lex. `blockCommentLineStates` only uses this to decide when it is
 * safe to resume ordinary per-character scanning after a suspected close;
 * an early "close" just means that scanning (which never mis-opens a
 * comment/docstring inside a real string or field, per its own quote
 * handling) resumes a little sooner than ideal for a rare nested shape —
 * never a NEW false comment-open, matching this module's usual failure
 * direction.
 */
function findUnescapedBacktick(line: string, at: number): number {
  for (let i = at; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === "\\") { i++; continue; }
    if (ch === "`") return i;
  }
  return -1;
}

/**
 * C0 (eval-0927 review-r6 wave, round 7): FILE-LEVEL companion to
 * `maskNonCode` (P1-5, eval-0927 review-r5 #5,
 * pyDocstringFalseCaller/blockCommentInteriorFalseCaller). `maskNonCode` is
 * deliberately single-line (see its own doc) and so cannot tell an INTERIOR
 * line of a multi-line `/* ... *\/` block comment or a Python triple-quoted
 * docstring/string from ordinary code — a prose line inside either (`Usage:
 * formatBytes(1024) returns...`, `>>> format_bytes(1024)`) reads exactly
 * like a real call or a real constant reference. This walks a WHOLE file
 * once, sequentially, tracking every multi-line span a caller-expansion/
 * constant scan in this codebase needs to see, and returns one entry per
 * line (0-based, same length as `lines`):
 *
 * - `masked[i]`: true when line `i` is ENTIRELY inside such a span —
 *   including its own opener/closer line when nothing but the marker (and,
 *   for a closer, only trailing whitespace) shares it — so a consumer
 *   treats it exactly like an ordinary single-line comment: skip it
 *   outright, never a call site, never a constant reference, never an
 *   unclassified mention. A closer line that ALSO carries real code after
 *   the marker is deliberately NOT marked here (unchanged from every prior
 *   release — `maskNonCode` itself now exposes that trailing code, C3); see
 *   `codeFrom` for its column.
 * - `confident[i]`: true when `masked[i]` is true AND the span line `i`
 *   belongs to was opened at the START of ITS OWN opening line (only
 *   whitespace before `/*`, `/**`, `"""`, `'''`, `=begin`). An opener with
 *   real code before it on that same line depends on this function's own
 *   (necessarily partial) lexing of that leading code being correct, so a
 *   consumer that wants to drop a masked line outright — rather than merely
 *   excluding it from call-site classification while still treating any
 *   mention on it as unclassified — should require `confident`, not
 *   `masked` alone.
 * - `codeFrom[i]`: on a line that CLOSES an open span and carries real code
 *   after the closer (`*\/ run(2);`, an `=end` with trailing text), the
 *   column just after the closer; `undefined` otherwise (including every
 *   closer with nothing but trailing whitespace, already fully covered by
 *   `masked`).
 *
 * `computeBlockCommentMask` below is a thin wrapper returning `.masked` —
 * every existing caller (which only ever consulted the boolean) is
 * unaffected.
 *
 * Block-comment scanning is UNIVERSAL (no extension gate), matching
 * `maskNonCode`'s own unconditional `/*`/`//` handling, and NESTS for the
 * languages in `NESTING_BLOCK_COMMENT_EXTENSIONS` (C2). Triple-quote
 * scanning is gated to Python (`PYTHON_TRIPLE_QUOTE_EXTENSIONS`); `=begin`/
 * `=end` scanning to Ruby (C2). JS/TS additionally (C1, eval-0927 review-r6
 * P1-6, regexClassSlashStarHidesCallers) skip whole REGEX LITERALS before
 * ever inspecting their contents for a comment marker (a `/*` inside a
 * `[...]` character class, `/^[/*\s]+/`, is pattern syntax, never a real
 * comment opener) and track an UNCLOSED multi-line template literal across
 * lines, so the template's own inert text — which may itself contain a
 * `/*`/`"""`-lookalike sequence — is never misread as a real opener on a
 * LATER line either.
 *
 * Ordinary single/double/backtick strings and `#`/`//` line comments are
 * tracked only well enough to keep a QUOTED `/*` or `"""` from opening a
 * false span — the same bounded, no-guessing contract as the rest of this
 * module: a genuinely ambiguous line (impossible to resolve without a real
 * parser) is left `false` here and falls back to whatever the single-line
 * callers already do with it.
 */
export interface BlockCommentLineStates {
  readonly masked: boolean[];
  readonly confident: boolean[];
  readonly codeFrom: Array<number | undefined>;
}

export function blockCommentLineStates(lines: readonly string[], relPath: string): BlockCommentLineStates {
  const masked = new Array<boolean>(lines.length).fill(false);
  const confident = new Array<boolean>(lines.length).fill(false);
  const codeFrom = new Array<number | undefined>(lines.length).fill(undefined);
  const hashComment = hasHashComments(relPath);
  const ext = extensionOf(relPath);
  const pythonTriple = ext !== undefined && PYTHON_TRIPLE_QUOTE_EXTENSIONS.has(ext);
  const nestingComments = ext !== undefined && NESTING_BLOCK_COMMENT_EXTENSIONS.has(ext);
  const rubyDoc = ext !== undefined && RUBY_INTERPOLATION_EXTENSIONS.has(ext);
  const jsLike = ext !== undefined && JS_REGEX_LITERAL_EXTENSIONS.has(ext);
  const goFile = isGoLanguage(relPath); // C4
  const rustFile = ext !== undefined && RUST_EXTENSIONS.has(ext); // C5
  const phpFile = ext !== undefined && PHP_ATTRIBUTE_EXTENSIONS.has(ext); // C2
  const noBlockComments = ext !== undefined && NO_BLOCK_COMMENT_EXTENSIONS.has(ext); // C6

  let blockDepth = 0;
  let blockConfident = false;
  let docstringMarker: '"""' | "'''" | undefined;
  let docConfident = false;
  let rubyDocOpen = false;
  let templateOpen = false; // an unclosed JS/TS backtick template carried from a PRIOR line
  let goRawStringOpen = false; // an unclosed Go raw-string backtick literal carried from a PRIOR line (C4)
  let rustRawStringHashes: number | undefined; // the `hashCount` of an unclosed Rust raw string carried from a PRIOR line (A3)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (rubyDocOpen) {
      masked[i] = true;
      confident[i] = true;
      const closer = RUBY_END_RE.exec(line);
      if (closer !== null) {
        rubyDocOpen = false;
        const after = line.slice(closer[0].length);
        if (after.trim() !== "") codeFrom[i] = closer[0].length;
      }
      continue;
    }

    if (blockDepth > 0) {
      let c = 0;
      let closedAt = -1;
      while (c < line.length) {
        if (nestingComments && line.startsWith("/*", c)) { blockDepth++; c += 2; continue; }
        if (line.startsWith("*/", c)) {
          blockDepth--;
          if (blockDepth === 0) { closedAt = c; break; }
          c += 2;
          continue;
        }
        c++;
      }
      if (closedAt === -1) { masked[i] = true; confident[i] = blockConfident; continue; }
      const after = line.slice(closedAt + 2);
      if (after.trim() === "") { masked[i] = true; confident[i] = blockConfident; continue; }
      codeFrom[i] = closedAt + 2;
      continue;
    }

    if (docstringMarker !== undefined) {
      const marker = docstringMarker;
      const closeAt = line.indexOf(marker);
      if (closeAt === -1) { masked[i] = true; confident[i] = docConfident; continue; }
      docstringMarker = undefined;
      const after = line.slice(closeAt + marker.length);
      if (after.trim() === "") { masked[i] = true; confident[i] = docConfident; continue; }
      codeFrom[i] = closeAt + marker.length;
      continue;
    }

    let startAt = 0;
    if (templateOpen) {
      // C1 (eval-0927 review-r7 round 8, tsTemplateInteriorFalseCaller): a
      // line strictly inside a multi-line JS/TS template literal is masked
      // NON-confident -- excluded from call-site classification (never a
      // false call site) but kept for the mention guard (never silently
      // dropped), including any code-shaped text inside a `${…}` field on
      // this line, which this file-level scan does not itself parse out
      // (the safe direction: at worst an unclassified mention, never a
      // false caller and never a silent drop).
      const closeAt = findUnescapedBacktick(line, 0);
      if (closeAt === -1) { masked[i] = true; confident[i] = false; continue; }
      templateOpen = false;
      startAt = closeAt + 1; // resume normal scanning right after the closer
    } else if (goRawStringOpen) {
      // C4 (eval-0927 review-r7 round 8, goRawStringFalseEmpty): a Go raw
      // string (backtick-delimited, NO escape sequences at all -- unlike a
      // JS/TS template, ANY backtick closes it) may span several lines.
      // Masked non-confident on every interior line, the SAME safe
      // direction as the template case just above, and -- critically --
      // WITHOUT ever reaching the `/*` opener check further down: with no
      // cross-line tracking at all (before this fix, only `jsLike` files
      // armed `templateOpen`), a literal "/*" inside such a string's own
      // text used to be read as a REAL block-comment opener that, finding
      // no genuine `*/` later in the file, masked the ENTIRE REST OF THE
      // FILE confidently -- a false EMPTY callers result.
      const closeAt = line.indexOf("`");
      if (closeAt === -1) { masked[i] = true; confident[i] = false; continue; }
      goRawStringOpen = false;
      startAt = closeAt + 1;
    } else if (rustRawStringHashes !== undefined) {
      // A3 (eval-0927 review-r8/r9 round 9, rustRawStringSlashStarCaller): a
      // Rust raw string may span several lines and, like a Go raw string,
      // carries NO escapes at all -- masked non-confident on every interior
      // line, the SAME safe direction as the template/Go-raw-string cases
      // above, and -- critically -- WITHOUT ever reaching the `/*` opener
      // check further down: a literal "/*" inside such a string's own text
      // used to be read as a REAL block-comment opener that, finding no
      // genuine `*/` later in the file, masked the ENTIRE REST OF THE FILE
      // confidently -- a false EMPTY callers result (the reported defect).
      // The closer needs exactly `rustRawStringHashes` `#`s after the `"`
      // (see `findRustRawStringEnd`'s own doc) -- a bare `"` alone never
      // closes a hash-delimited raw string.
      const closeAt = findRustRawStringEnd(line, 0, rustRawStringHashes);
      if (closeAt === -1) { masked[i] = true; confident[i] = false; continue; }
      rustRawStringHashes = undefined;
      startAt = closeAt + 1;
    }

    if (rubyDoc && startAt === 0 && RUBY_BEGIN_RE.test(line)) {
      rubyDocOpen = true;
      masked[i] = true;
      confident[i] = true;
      continue;
    }

    let quote: string | undefined;
    let openedHere = false;
    for (let c = startAt; c < line.length; c++) {
      const ch = line[c]!;
      if (quote !== undefined) {
        if (ch === "\\") { c++; continue; }
        if (ch === quote) quote = undefined;
        continue;
      }
      if (pythonTriple && (line.startsWith('"""', c) || line.startsWith("'''", c))) {
        const marker = line.slice(c, c + 3) as '"""' | "'''";
        const closeAt = line.indexOf(marker, c + 3);
        if (closeAt === -1) {
          docstringMarker = marker;
          // C7 (eval-0927 review-r7 round 8, pyPrefixedTripleQuoteConfident):
          // a Python string prefix (`r`/`b`/`f`/`u`, or a valid two-letter
          // combination) right before the marker, with only whitespace
          // before THAT, is exactly as confident an opener as an unprefixed
          // one -- see `PY_TRIPLE_QUOTE_PREFIX_RE`'s own doc. A2 (eval-0927
          // review-r8/r9 round 9, pyFstringTripleLineStartCaller): EXCEPT an
          // `f`/`F` prefix (alone or combined, `rf`/`fr`/`Rf`/`fR`/…, any
          // case) -- an f-string's `{…}` replacement fields are live code (a
          // call can sit inside one, `f"""{format_bytes(total)}"""`), so its
          // interior is never a confident docstring even though the marker
          // itself is a perfectly valid opener shape; a bare `r`/`b`/`u`
          // prefix (no `f`) stays exactly as confident as before.
          const triplePrefixText = line.slice(0, c);
          docConfident = PY_TRIPLE_QUOTE_PREFIX_RE.test(triplePrefixText) && !/[fF]/.test(triplePrefixText);
          openedHere = docConfident;
          break;
        }
        c = closeAt + 2;
        continue;
      }
      // C5 (eval-0927 review-r7 round 8, rustLifetimeFalseString): checked
      // before the generic quote-open branch just below, Rust only -- see
      // `findRustCharLiteralEnd`'s own doc. A `'` that does not close as a
      // real char literal is a lifetime/loop-label sigil and must stay
      // ordinary code, never arm the generic "any later `'` closes it" scan
      // (which would otherwise blank real code between two unrelated
      // lifetimes/labels, or worse, run past the intended span).
      if (rustFile && ch === "'") {
        const closeAt = findRustCharLiteralEnd(line, c);
        if (closeAt === -1) continue;
        c = closeAt;
        continue;
      }
      // A3 (eval-0927 review-r8/r9 round 9, rustRawStringSlashStarCaller):
      // checked before the generic quote-open branch just below, Rust only
      // -- see `findRustRawStringOpenerAt`'s own doc. A same-line closer
      // resumes ordinary scanning right after it; an unclosed one arms
      // `rustRawStringHashes` so the NEXT line is picked up by the
      // cross-line branch above, never by this per-character loop's own
      // (single-char, escape-unaware) generic quote handling.
      if (rustFile && (ch === "r" || ch === "b")) {
        const opener = findRustRawStringOpenerAt(line, c);
        if (opener !== undefined) {
          const closeAt = findRustRawStringEnd(line, opener.contentStart, opener.hashCount);
          if (closeAt === -1) { rustRawStringHashes = opener.hashCount; break; }
          c = closeAt;
          continue;
        }
      }
      if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
      // C2 (eval-0927 review-r7 round 8, phpHashCommentFalseCaller): `#[` is
      // a PHP 8 attribute opener, never a comment -- see `maskNonCode`'s
      // identical carve-out (gated to `.php`; every other hash-comment
      // language keeps `#[` as an ordinary comment starting with `[`).
      if ((ch === "/" && line[c + 1] === "/") || (hashComment && ch === "#" && !(phpFile && line[c + 1] === "["))) break;
      // C6 (eval-0927 review-r7 round 8, rubyRegexSlashStarFalseComment): a
      // language with no `/* */` syntax at all never opens one here either
      // -- see `NO_BLOCK_COMMENT_EXTENSIONS`'s own doc (this is the file-
      // level twin of `maskNonCode`'s same fix: a Ruby regex `/\/*/ ` used
      // to be read as an opener that, finding no real closer, masked the
      // rest of the FILE confidently -- a false EMPTY callers result).
      if (!noBlockComments && ch === "/" && line[c + 1] === "*") {
        // C3 (eval-0927 review-r7 round 8, ktNestedSingleLineFalseCaller):
        // `findBlockCommentEnd` replaces the old plain `indexOf` scan here
        // too, so a NESTING language's inner `/*`/`*/` pair does not
        // prematurely close the outer comment (see its own doc). `blockDepth`
        // is seeded from the reported residual `depth` (not a hardcoded 1),
        // so a line that itself opens MULTIPLE nested, still-unclosed
        // comments correctly demands that many closers on later lines too.
        const { closeAt, depth } = findBlockCommentEnd(line, c, nestingComments);
        if (closeAt === -1) {
          blockDepth = depth;
          blockConfident = line.slice(0, c).trim() === "";
          openedHere = blockConfident;
          break;
        }
        c = closeAt + 1;
        continue;
      }
      // C1 (eval-0927 review-r6 P1-6, regexClassSlashStarHidesCallers):
      // reached only when this "/" was NOT immediately followed by "/" or
      // "*" above (checked first, so it always wins the SAME way
      // `maskNonCode` does), meaning it can never itself be a comment
      // opener -- safe to skip a same-line-closing regex literal without
      // ever inspecting ITS contents for a "/*"/'"""' lookalike.
      if (jsLike && ch === "/" && looksLikeRegexContext(line.slice(0, c))) {
        const regexEnd = findRegexLiteralEnd(line, c);
        if (regexEnd !== -1) { c = regexEnd; continue; }
      }
    }
    if (openedHere) { masked[i] = true; confident[i] = true; }
    if (jsLike && quote === "`") templateOpen = true;
    else if (goFile && quote === "`") goRawStringOpen = true; // C4
  }
  return { masked, confident, codeFrom };
}

export function computeBlockCommentMask(lines: readonly string[], relPath: string): boolean[] {
  return blockCommentLineStates(lines, relPath).masked;
}

/**
 * Every whole-word occurrence of `member` on `masked` that is shaped like a
 * CALL — the name followed by `(`, optionally preceded by `.`, `::` or `->`.
 * `masked` must already have been through `maskNonCode`.
 */
export function findCallOccurrences(masked: string, member: string): CallSiteOccurrence[] {
  if (member.length === 0) return [];
  const out: CallSiteOccurrence[] = [];
  for (let at = masked.indexOf(member); at >= 0; at = masked.indexOf(member, at + 1)) {
    const previous = at > 0 ? masked[at - 1]! : "";
    if (previous !== "" && IDENTIFIER_CHAR_RE.test(previous)) continue; // part of a longer identifier
    // R4-A2 (eval-0927 review-r3 P0-3/shape(9), genericMethodManyCallers): a
    // generic argument list may sit directly between the name and its own
    // `(` (`fetchJson<T>(`, a generic method's declaration; an explicit
    // call-site type argument reads the same way) -- skip it before testing
    // for the call-shape `(`, or this occurrence is invisible to the whole
    // classifier (neither a call nor a declaration -- simply never found).
    const afterGenericsAt = skipBalancedTypeArguments(masked, at + member.length);
    const after = masked.slice(afterGenericsAt);
    // R5-A2 (eval-0927 review-r4 P1-6, ts-optional-call): JS/TS's OPTIONAL
    // CALL operator (`run?.(x)`) puts `?.` directly between the name and its
    // own `(` -- distinct from the RECEIVER-side optional chaining
    // (`svc?.cancel(`) already handled below via `beforeTrimmed`'s trailing
    // `?`/`!` strip. `callSiteOccurrenceIsDeclaration` needs no matching
    // change: `?.` immediately after a name is never legal declaration
    // syntax in any language this module covers, so `closeOwnArgumentList`
    // (which has no such skip) correctly fails to close and the occurrence
    // falls through to `false` (a call) on its own.
    if (!/^\s*\(/.test(after) && !/^\s*\?\.\s*\(/.test(after)) continue; // a mention, not a call
    const before = masked.slice(0, at);
    const beforeTrimmed = before.replace(/\s+$/u, "");
    let qualifier: CallQualifier = "bare";
    let receiverSide = beforeTrimmed;
    if (beforeTrimmed.endsWith("->")) {
      qualifier = "arrow";
      receiverSide = beforeTrimmed.slice(0, -2);
    } else if (beforeTrimmed.endsWith("::")) {
      qualifier = "scope";
      receiverSide = beforeTrimmed.slice(0, -2);
    } else if (beforeTrimmed.endsWith(".")) {
      qualifier = "dot";
      receiverSide = beforeTrimmed.slice(0, -1);
    }
    // A trailing `?`/`!` is optional chaining / a non-null assertion sitting
    // between the receiver and the dot (`svc?.cancel(`, `svc!.cancel(`), not
    // part of the receiver and not a reason to lose it.
    const receiver = qualifier === "bare"
      ? undefined
      : TRAILING_IDENTIFIER_RE.exec(receiverSide.replace(/[?!]+$/u, ""))?.[1];
    out.push({ column: at, qualifier, ...(receiver !== undefined ? { receiver } : {}), before });
  }
  return out;
}

/**
 * The part of an occurrence's preceding text that could be a DECLARATION HEAD:
 * everything after the last statement/expression separator on the line. A
 * declaration keyword only means "declaration" when it governs this name — in
 * `var response = orderService.cancel(id)` the `var` governs `response`, and
 * testing the whole prefix would read that ordinary call as a definition
 * (`var`, `let`, `const`, `public` and `static` are all in the shared
 * `IDENTIFIER_DEFINITION_KEYWORD_RE` keyword list for good reasons of their
 * own). The caller applies that ONE shared regex to this segment, so the
 * keyword list stays single-sourced.
 *
 * FIX (R4-A2, eval-0927 review-r3 #5, goIfaceMethod/goOtherImplOnly): `(` is a
 * cut character only when it is still UNMATCHED by the end of `before` — a
 * default parameter's own call (`function f(x = loadOptions(` — `f(`'s own
 * paren never closes within `before`) still cuts exactly as before, but a
 * BALANCED, already-closed parenthetical aside — Go's receiver clause,
 * `func (m *MemoryClient) FetchJSON(` — no longer does. The old flat scan
 * treated every `(` as a cut regardless of whether it closed again, so the
 * receiver clause's own `(m *MemoryClient)` severed `func` from the name it
 * declares, and the shared keyword regex never saw it. Tracked with an
 * explicit stack (not a depth counter) so NESTED unmatched parens still cut
 * at the INNERMOST one — `function outer(a = function inner(b = ` must cut
 * right after `inner(`, not `outer(`, or `function` would wrongly appear to
 * govern a name two scopes down.
 */
export function definitionSegment(before: string): string {
  const cut = /[=;{},]/;
  let start = 0;
  const openStack: number[] = [];
  for (let i = 0; i < before.length; i++) {
    const ch = before[i]!;
    if (cut.test(ch)) {
      start = i + 1;
      continue;
    }
    if (ch === "(") openStack.push(i);
    else if (ch === ")") openStack.pop();
  }
  const innerOpen = openStack[openStack.length - 1];
  if (innerOpen !== undefined && innerOpen >= start) start = innerOpen + 1;
  return before.slice(start);
}

/**
 * FIX-FAB item 1 (eval-0927 review #1, callersLoadOptionsNoIface/
 * callersIfBlock): modifiers/qualifiers that may sit before a method's own
 * name with no other separator — TS/JS/Java/C#/Kotlin-ish. Never proof of a
 * declaration by themselves (a bare, unmodified name is just as valid a
 * declaration head); their presence never disqualifies one either. The
 * keyword-LED shapes (`function X`/`def X`/`func X`/`fn X`, or any modifier
 * this list also happens to name) are already caught by the shared
 * `IDENTIFIER_DEFINITION_KEYWORD_RE` test the caller applies to
 * `definitionSegment` before ever reaching this function — this list only
 * has to cover a modifier THAT test's own (narrower, cross-cutting) keyword
 * list does not.
 */
const DECLARATION_MODIFIER_WORD_RE =
  /^(?:public|private|protected|internal|static|final|readonly|abstract|override|virtual|async|export|default|get|set|synchronized|native|inline|sealed|open|suspend|declare|const|extern|constexpr|friend)$/;

/**
 * R5-A2 (eval-0927 review-r4 P1-11, c-unsigned-long-proto/c-long-long-def): C's
 * numeric-type-forming words, which combine across MULTIPLE head words into one
 * return type (`unsigned long`, `long long`, `unsigned long long`, `short int`,
 * `signed char`) rather than standing alone as either a modifier or the whole
 * type. Skippable like a modifier whenever NOT the last word (the combination's
 * final word, e.g. the second `long`, still must pass the ordinary last-word
 * type check) -- and when one of these words IS the last word on its own
 * (`long run(int x)`, meaning `long int`), `isTypeToken` already accepts it as a
 * plain identifier-shaped token, so no extra last-word handling is needed here.
 */
const C_NUMERIC_TYPE_WORD_RE = /^(?:unsigned|signed|long|short)$/;

/**
 * Keywords that open a control statement or another non-declaration
 * construct and can therefore never be a typed declaration's OWN return
 * type, however identifier-shaped they look — the exact words a bare
 * `case X:`/`default:`/`else`-headed line could otherwise be mistaken for
 * `<type> X(` (the trailing-token allowance below exists for a real type
 * name like `ClientOptions`, never for these). The second group are
 * operators/statements that take an expression in C-family languages
 * (`assert f(x);`, `co_await f(x);`, `not f(x)`, `sizeof f(x)`): with a
 * bare `;` after the call they read as a prototype `<type> f(x);` and the
 * call site was dropped (orchestrator probe, round 4).
 */
const NEVER_TYPE_TOKEN_RE =
  /^(?:if|else|while|for|switch|case|default|catch|do|return|yield|throw|new|typeof|instanceof|await|in|of|delete|void|break|continue|try|finally|assert|co_await|co_yield|co_return|goto|sizeof|alignof|typeid|not|and|or|is|as|lock|checked|unchecked|echo|print)$/;

/**
 * A single type-shaped unit: an identifier, optionally NAMESPACE-QUALIFIED
 * (`std::string`, `App::Handler`), optionally followed by BALANCED
 * angle-bracket generic arguments at ANY nesting depth (`Map<String,
 * Integer>`, `Foo<Bar<Baz>>`, `List<? extends T>`), then an optional
 * trailing `[]`/`*`/`&` run (Java/C#/Kotlin/C++ return-type spellings).
 *
 * FIX (eval-0927 review-r2 #12, callersJavaGenericDecl2): the old
 * `TYPE_TOKEN_RE` regex (`(?:<[^<>{}]*>)?`) could represent only ONE
 * unnested level of angle brackets, so `Foo<Bar<Baz>>` never matched at all
 * (the inner `<`/`>` are excluded from `[^<>{}]*`) — a depth counter, not a
 * fixed-nesting regex, is the only way to accept arbitrary nesting without a
 * recursive pattern.
 *
 * FIX (R4-A2, eval-0927 review-r3 #5, cppHeaderProto/cIfaceProtoTypedef):
 * the leading identifier may be C++'s `::`-qualified scope path
 * (`std::string`, `app::Handler`) — the OLD identifier regex stopped at the
 * first `:`, leaving `::string`/`::Handler` behind as unrecognized trailing
 * junk, so `declarationHeadShape` rejected every C++ prototype whose return
 * type names a namespace. `report_t *report_open(...)`'s pointer marker as
 * its OWN separate word (`splitHeadWords` never joins across whitespace) is
 * handled one level up, by `declarationHeadShape`'s own
 * `mergeTrailingPointerMarkers` — by the time a word reaches this function,
 * a space-separated `*`/`&` run is already folded onto it.
 */
function isTypeToken(token: string): boolean {
  const identifier = /^(?:[A-Za-z_$][\w$]*::)*[A-Za-z_$][\w$]*/.exec(token);
  if (!identifier) return false;
  let i = identifier[0].length;
  if (token[i] === "<") {
    let depth = 0;
    for (; i < token.length; i++) {
      const ch = token[i]!;
      if (ch === "<") depth++;
      else if (ch === ">") {
        depth--;
        if (depth === 0) { i++; break; }
      } else if (ch === "{" || ch === "}") {
        return false; // a block, never legal inside a type's angle brackets
      }
    }
    if (depth !== 0) return false; // unbalanced -- not a single closed type token
  }
  return /^(?:\[\])?[*&]{0,2}$/.test(token.slice(i));
}

/**
 * A C-style pointer/reference declarator written as its OWN word, separated
 * from the type it modifies by whitespace (`report_t *report_open(`, `Foo
 * &&f(`) — as common as the no-space spelling `isTypeToken` already accepts
 * unaided (`report_t*`). Folds a TRAILING run of pure `*`/`&` words onto the
 * word before it so the same single-type-token check governs both
 * spellings. A `*`/`&` word with nothing before it (never a valid
 * declarator on its own) is left alone; `declarationHeadShape`'s own word
 * loop then falls through to `return false` for it exactly as before.
 */
function mergeTrailingPointerMarkers(words: readonly string[]): string[] {
  if (words.length < 2) return [...words];
  const out = [...words];
  while (out.length >= 2 && /^[*&]+$/.test(out[out.length - 1]!)) {
    const marker = out.pop()!;
    out[out.length - 1] += marker;
  }
  return out;
}

/**
 * `before`, cut back to the start of the CURRENT statement: the text after
 * the last top-level `;`, `{`, `}` or `,` (a statement/block boundary, or the
 * separator between two object-literal/class members). Deliberately NEVER
 * cuts at `(` or `=` the way `definitionSegment` does: those are exactly the
 * characters a control-statement condition (`if (`) or a default parameter
 * value (`= loadOptions(`) puts between an outer, unrelated statement head
 * and the call this function must classify, and cutting there is what let
 * both read as a declaration (review #1).
 *
 * FIX (eval-0927 review-r2 #12): a `,` (or any cut character) that sits
 * INSIDE a generic type's own angle brackets — `Map<String, Integer>`'s
 * comma — is never a statement/member separator and must never cut the head
 * there; tracked with the same plain depth counter `isTypeToken` uses, for
 * the same reason (no fixed-nesting regex can do this correctly).
 *
 * FIX (R5-A2, eval-0927 review-r4 P1-11, ts-decorator-same-line): the SAME
 * reasoning applies to a `,` inside a decorator/annotation's OWN parenthesized
 * or bracketed argument list — `@HostListener('window:resize', ['$event'])`'s
 * comma is not a statement/member separator either. Tracked with the same
 * plain depth counters `isTypeToken`/`definitionSegment` already use for `(`
 * and (here, newly) `[` — a `,`/`;`/`{`/`}` nested inside either never cuts.
 */
function statementHeadSegment(before: string): string {
  const cut = /[;{},]/;
  let start = 0;
  let angleDepth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  for (let i = 0; i < before.length; i++) {
    const ch = before[i]!;
    if (ch === "<") angleDepth++;
    else if (ch === ">") angleDepth = Math.max(0, angleDepth - 1);
    else if (ch === "(") parenDepth++;
    else if (ch === ")") parenDepth = Math.max(0, parenDepth - 1);
    else if (ch === "[") bracketDepth++;
    else if (ch === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    else if (angleDepth === 0 && parenDepth === 0 && bracketDepth === 0 && cut.test(ch)) start = i + 1;
  }
  return before.slice(start);
}

/**
 * `head.split(/\s+/)` with one exception: whitespace INSIDE a generic type's
 * angle brackets (the space after `Map<String,`'s comma) never splits —
 * otherwise a multi-parameter generic return type is torn into words no
 * single `isTypeToken` check can recognize (review-r2 #12, same root cause
 * as `statementHeadSegment`'s own angle-depth fix, one level up: that fix
 * keeps the generic INSIDE the head segment at all; this one keeps it as
 * ONE word once there).
 */
function splitHeadWords(head: string): string[] {
  const words: string[] = [];
  let current = "";
  let angleDepth = 0;
  for (const ch of head) {
    if (ch === "<") angleDepth++;
    else if (ch === ">") angleDepth = Math.max(0, angleDepth - 1);
    if (angleDepth === 0 && /\s/.test(ch)) {
      if (current.length > 0) words.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.length > 0) words.push(current);
  return words;
}

/**
 * True when a BARE occurrence (no receiver at all) sits at the head of its
 * own statement and that line opens a block: a method-shorthand declaration
 * in a brace language, with only modifiers (`public async cancel(id) {`) or
 * at most one extra type token (`ClientOptions loadOptions(env) {`, Java/C#/
 * Kotlin's package-private member) before the name.
 *
 * NEVER true when the identifier sits inside an unbalanced, still-open `(`
 * from something earlier on the line — a control-statement condition
 * (`if`/`while`/`for`/`switch`/`catch`/`else if`, INCLUDING a
 * `for(init; COND; incr)` clause's own internal `;`) or another
 * declaration's own parameter list (a default value:
 * `options: T = loadOptions(env)): U {`) always puts the call inside such an
 * open paren, and in EVERY one of those shapes the call is itself a call
 * site, never a declaration of the name it invokes (review #1:
 * callersLoadOptionsNoIface, callersIfBlock — `if (isTransient(status)) {`
 * and a default-parameter `loadOptions(process.env)` in a multi-line
 * signature ending `{` were both misread as declarations by the OLD rule,
 * which only checked whether `definitionSegment` — cut at `(`/`=` too — was
 * empty). This paren-depth test is the one thing that actually tells them
 * apart from a real declaration: neither shape leaves behind an empty or
 * modifiers-only statement head the way `definitionSegment`'s wider cut set
 * did.
 *
 * Costs recall only on a bare call whose single leading word is BOTH not a
 * real type and not in `NEVER_TYPE_TOKEN_RE` (an unrecognized word used as a
 * label); never a false caller in the direction that matters here (a real
 * call in a condition/default), which is the direction this whole mechanism
 * errs in. TS/JS/Java/C#/Kotlin-ish; Python/Go/Rust always keyword-lead
 * (`def`/`func`/`fn`) and never reach this fallback at all.
 *
 * FIX (eval-0927 review-r2 #1, callersObjectArgTs/callersCallbackArgTs/
 * callersDictArgPy/callersObjectArgTsAwait): the RIGHT-hand half used to be
 * "the whole (masked) line ends with `{`", which is true of `recordEvent(
 * "orders.list", {` (an object-literal argument opened but not closed on
 * this line), `schedule("nightly", () => {` (a callback argument) and
 * `notify(order.user, {` (a Python dict argument) — none of these are X's
 * OWN body opener; the `{` belongs to an ARGUMENT the call passes, and X's
 * own paren-matched argument list never even closes on this line. Now
 * delegates to `rightHandOpensDeclarationBody`, which paren-matches `X`'s
 * OWN `(...)`  from `before`'s own end (never an argument's nested `{`/`(`)
 * and only then looks for the body opener — on this line, optionally past a
 * return annotation (`: T` / `-> T` / Java `throws T1, T2`), or on the next
 * non-blank line when the parameter list (and any annotation) closes
 * exactly at EOL. `alwaysKeywordLed` (default `false`, so the two existing
 * unit tests keep their TS-shaped meaning) — pass `true` for a file whose
 * language always keyword-leads a real declaration (Kotlin/Rust/Swift/Go/
 * Python/Ruby/Scala; see `isAlwaysKeywordLedLanguage`) to skip this whole
 * shape heuristic unconditionally: those languages have no keyword-less
 * method-shorthand OR trailing-lambda-as-declaration syntax, so a bare
 * `X(...) {` is always a CALL there (most often a trailing lambda/closure
 * argument — Kotlin `repeat(5) {`) and never X's own declaration, which —
 * when actually spelled with its keyword — the call site's OWN
 * `IDENTIFIER_DEFINITION_KEYWORD_RE` test already recognizes before this
 * function is ever reached.
 */
export function opensBlockDeclaration(
  masked: string,
  before: string,
  alwaysKeywordLed = false,
  laterMaskedLines?: readonly string[],
): boolean {
  if (alwaysKeywordLed) return false;
  if (!declarationHeadShape(before)) return false;
  return rightHandOpensDeclarationBody(masked, before.length, laterMaskedLines, hasDeclarationHeadWord(before));
}

/**
 * Whether `before`'s own statement head (`statementHeadSegment`) carries at
 * least one modifier/type word — the signal that gates whether a BODY-LESS
 * `;` alone is safe proof of a declaration (see
 * `rightHandOpensDeclarationBody`'s own doc: a bare, EMPTY head ending in
 * `;` is indistinguishable from an ordinary call statement — `cancel(id);`
 * — so only a non-empty head, which a plain call expression can never have
 * (`report_t *cancel(id);` is not a legal call in any C-family language),
 * makes the bare terminator safe to accept).
 */
export function hasDeclarationHeadWord(before: string): boolean {
  return statementHeadSegment(before).trim().length > 0;
}

/**
 * Bound on how many further lines a multi-line declaration's own parameter
 * list may span before `rightHandOpensDeclarationBody`'s scan gives up —
 * recall loss only past this (a real signature this long is exceedingly
 * rare; see its own module doc for the measured case this exists for).
 */
export const MAX_DECLARATION_HEAD_LOOKAHEAD_LINES = 20;

/**
 * Skips an optional balanced angle-bracket generic/type-argument list
 * starting at `text[i]` (`<T>`, `<K, V>`, arbitrarily nested) — the same
 * balanced-depth scan `isTypeToken` performs for a RETURN type, applied here
 * to a generic argument list written directly after a NAME (`fetchJson<T>(`,
 * a generic method declaration; C#/Java's `Foo.<T>bar()`-style explicit
 * call-site type arguments land here too). Returns `i` unchanged when there
 * is no `<` at that position, or when the brackets never balance within
 * `text` (a real `<`/`>` comparison, never a generic list — abstains rather
 * than guessing, the same direction every heuristic in this module favors).
 *
 * FIX (R4-A2, eval-0927 review-r3 P0-3/shape(9), genericMethodManyCallers):
 * `findCallOccurrences` required `(` to follow the member name IMMEDIATELY
 * (after only whitespace), so `fetchJson<T>(...)` — a generic method's own
 * declaration, or an explicit-type-argument call site — was never even
 * recognized as an OCCURRENCE at all, let alone classified.
 *
 * FIX (R5-A2, eval-0927 review-r4 P1-6, go-generic-explicit): Go spells an
 * EXPLICIT generic-instantiation argument list with square brackets instead
 * of angle brackets (`Sum[int](xs)`, both at a call site and at the
 * function's own `func Sum[T Number](xs []T) T {` declaration — no other
 * language covered by this module uses `[...]` for this) — same balanced-
 * depth scan, same abort-on-`{`/`}`/`;` safety net, just the other bracket
 * pair. No fixture/project in this repo's test corpus pairs an identifier
 * with BOTH an immediately-following `[...]` index/slice AND a same-line
 * call — `handlers[name](req)` (calling a function value looked up by index,
 * valid in every language here) is the one shape this cannot tell apart from
 * `Sum[int](xs)`; both read as "an occurrence of the name, call-shaped",
 * which is the same recall-favoring direction the rest of this scanner
 * already takes.
 */
export function skipBalancedTypeArguments(text: string, i: number): number {
  const open = text[i];
  if (open !== "<" && open !== "[") return i;
  const close = open === "<" ? ">" : "]";
  let depth = 0;
  for (let j = i; j < text.length; j++) {
    const ch = text[j]!;
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return j + 1;
    } else if (ch === "{" || ch === "}" || ch === ";") {
      return i; // never legal inside a type-argument list -- not a generic after all
    }
  }
  return i; // never balances within `text` -- abstain
}

/**
 * Weaker than `rightHandOpensDeclarationBody`: true when X's own
 * paren-matched argument list is still OPEN at the end of `text` (never
 * closes within it) and no `{` was seen while it was open (never an
 * argument's own object-literal/callback/trailing-lambda block — shape 6,
 * a call, already proof enough that this is NOT a declaration on its own).
 * `false` when the list DOES close within `text` — that (stronger) shape is
 * `rightHandOpensDeclarationBody`'s to prove, and this function never
 * duplicates it.
 *
 * This is the one-line RANKING signal `isDeclarationShapedMatchText`
 * (readCodeTaskPack.ts) needs for a bounded, single, POSSIBLY TRUNCATED
 * `scanLiteral` match line whose real declaration continues onto FURTHER
 * lines that single line structurally cannot see (R4-A2, eval-0927
 * review-r3 P0-3/shape(2), multilineSigManyCallers: with 45 ordinary call
 * sites sorting ahead of it in workspace-walk order, the real multi-line
 * declaring file never even reached the 40-file cap
 * `findEnclosingCallableForLiteral` bounds its expensive per-file parse to,
 * because nothing marked it as PROBABLY a declaration first). Its ONE
 * caller additionally requires `hasDeclarationHeadWord(before)` — a real
 * modifier/type word, never mere emptiness — before trusting this: an
 * ordinary call expression is never preceded by a stray, unattached
 * modifier/type keyword with nothing else joining them (no language in
 * this module's coverage allows `public foo(x, () => {` as a call), so
 * requiring one keeps this safe for the bare multi-line call case
 * (`schedule(x, () => {` truncated to one line) that would otherwise also
 * match. A false positive here costs nothing regardless — ranking only, see
 * `isDeclarationShapedMatchText`'s own header: the resolved symbol is still
 * re-checked by real parsing once the file is actually read.
 */
export function opensMultilineDeclarationParams(text: string, nameStart: number): boolean {
  let i = nameStart;
  while (i < text.length && IDENTIFIER_CHAR_RE.test(text[i]!)) i++;
  i = skipBalancedTypeArguments(text, i);
  while (i < text.length && /\s/.test(text[i]!)) i++;
  if (text[i] !== "(") return false;
  let depth = 0;
  for (; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return false; // closes on this line -- not this (weaker) shape
    } else if (ch === "{" && depth > 0) {
      return false; // an argument's own block -- a call, never this
    }
  }
  return depth > 0;
}

/**
 * `rest`, the text right after X's own paren-matched argument list (and
 * before any body opener), is — once an optional return annotation is
 * stripped — either the body opener `{` itself (same line), a body-less
 * TERMINATOR (`;` — a prototype / interface member / overload signature /
 * abstract method), or nothing at all (deferred to the next line). Only
 * `:`/`->`/`throws` are recognized as annotation openers, so an inline
 * object-type return annotation (`): { x: number } {`) is not stripped and
 * this abstains — recall loss only, the direction this whole mechanism
 * already favors.
 *
 * FIX (R4-A2, eval-0927 review-r3 #5, cppHeaderProto/cIfaceProtoTypedef/
 * tsIfaceNamesType/overloadSigTs): a body-less declaration is exactly as
 * much a declaration as one with a body — the OLD rule only ever recognized
 * `{`, so every `;`-terminated prototype/interface-member/overload-signature
 * was left unproven and fell through to being counted as a call site. A
 * NON-EMPTY annotation (`: T;`, `-> T;`, `throws T;` — TS/Java/C#'s
 * SUFFIX-position return type) is unambiguous proof on its own: no ordinary
 * call expression is ever followed by a bare, unattached type mention. A
 * BARE `;` with no annotation at all (C/C++'s PREFIX-position return type,
 * already consumed by `before` — `report_t *report_open(...);`) is only
 * safe when `bodylessAllowed` says the LEFT head already proved this: an
 * EMPTY head plus a bare `;` is `cancel(id);`, an ordinary call statement,
 * and must never be misread as a declaration.
 *
 * FIX (R5-A2, eval-0927 review-r4 P1-11, cpp-noexcept/cpp-usertype-const-
 * member/cs-expression-bodied-usertype): two more UNAMBIGUOUS openers, never
 * legal after an ordinary call expression's own closing paren, join the
 * annotation alternatives —  a C++ trailing member specifier (`const`,
 * `override`, `final`, `noexcept` or `noexcept(...)`, any combination) and
 * C#'s expression-bodied-member arrow (`=> expr;`, NOT `->`: `=>` is two
 * different characters and was never matched by the existing `->` branch).
 * Both are annotation-shaped in the same sense the doc above already
 * describes: their mere PRESENCE is proof enough, independent of whichever
 * terminator (`{`, `;`, or a deferred next-line `{`) follows.
 */
const TRAILING_SPECIFIER_ALTERNATION_SRC = "(?:[:]|->)\\s*[^{};]*|throws\\b[^{};]*|=>\\s*[^{};]*|(?:\\s*(?:const|override|final|noexcept(?:\\([^()]*\\))?))+";
const SAME_LINE_BODY_OPENER_RE = new RegExp(`^\\s*(?:${TRAILING_SPECIFIER_ALTERNATION_SRC})?\\s*\\{`);
const SAME_LINE_ANNOTATED_BODYLESS_RE = new RegExp(`^\\s*(?:${TRAILING_SPECIFIER_ALTERNATION_SRC})\\s*;`);
const SAME_LINE_BARE_BODYLESS_RE = /^\s*;/;
const DEFERRED_BODY_OPENER_RE = new RegExp(`^\\s*(?:${TRAILING_SPECIFIER_ALTERNATION_SRC})?\\s*$`);

/**
 * Paren-matches X's OWN argument list starting at `nameStart` in `masked`
 * (after skipping the name itself and an optional generic argument list),
 * across `masked` and then `laterMaskedLines` IN ORDER, bounded by
 * `MAX_DECLARATION_HEAD_LOOKAHEAD_LINES` — the multi-line generalization of
 * the old same-line-only scan (R4-A2, eval-0927 review-r3 P0-3/shape(2),
 * wrapperAliasMultiline/multilineSigManyCallers: `async fetchJson(\n
 * pathname: string,\n init?: RequestInit,\n): Promise<unknown> {` never
 * closes its own parameter list on the line the NAME sits on at all).
 * Returns the text right after the closing `)` (on whichever line it closed
 * on) plus whatever line follows THAT one (for the deferred-body-opener
 * check), or `undefined` when the list never closes within the lookahead
 * given, OR when a `{` opened anywhere inside the list is STILL UNCLOSED at
 * the moment X's own list would close — an object-literal / callback /
 * trailing-lambda ARGUMENT whose body extends past this scan (shape 6),
 * never X's own body, and proof enough on its own that this is a call, not a
 * declaration, however many further lines might remain.
 *
 * FIX (R5-A2, eval-0927 review-r4 P1-11, ts-shorthand-default-param-object/
 * ts-multiline-params-default-obj): the OLD rule bailed on the FIRST `{` seen
 * while X's own list was still open, full stop — which also, wrongly, caught
 * a DEFAULT PARAMETER's own self-contained object-literal value
 * (`run(opts = { a: 1 }) {`): that `{` is fully BALANCED (a `}` closes it
 * again on the very same line) well before X's own list closes, and is no
 * different in kind from the parens `run(x = f(1))` already paren-matches
 * straight through. Now tracks brace depth the same way paren depth already
 * is, and only treats an OPEN brace as disqualifying if it is STILL open —
 * i.e. never re-closed — at the exact point X's own paren depth would
 * otherwise return to 0 (a real callback/trailing-lambda body almost never
 * closes before the call's own closing paren does; when it does close first,
 * as in `run(x, () => { return 1; })`, the braces net to zero exactly like
 * the nested parens do, and this now correctly keeps scanning for X's own
 * real close instead of bailing on sight of the callback's opener).
 */
function closeOwnArgumentList(
  masked: string,
  nameStart: number,
  laterMaskedLines: readonly string[] | undefined,
): { readonly rest: string; readonly lineAfterClose: string | undefined } | undefined {
  let i = nameStart;
  while (i < masked.length && IDENTIFIER_CHAR_RE.test(masked[i]!)) i++; // skip the name itself
  i = skipBalancedTypeArguments(masked, i); // an optional `<T>` generic argument list (shape 9)
  while (i < masked.length && /\s/.test(masked[i]!)) i++;
  if (masked[i] !== "(") return undefined; // not call-shaped after all (caller already checked; defensive)
  let depth = 0;
  let braceDepth = 0;
  let lineIdx = -1; // -1 = still scanning `masked` itself; >=0 = index into laterMaskedLines
  for (;;) {
    const scanLine = lineIdx === -1 ? masked : laterMaskedLines?.[lineIdx];
    if (scanLine === undefined) return undefined; // ran out of lookahead -- recall loss only
    const startAt = lineIdx === -1 ? i : 0;
    for (let j = startAt; j < scanLine.length; j++) {
      const ch = scanLine[j]!;
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) {
          if (braceDepth > 0) return undefined; // a callback/object-literal argument's block never re-closed within X's own list
          const lineAfterClose = lineIdx === -1 ? laterMaskedLines?.[0] : laterMaskedLines?.[lineIdx + 1];
          return { rest: scanLine.slice(j + 1), lineAfterClose };
        }
      } else if (ch === "{") {
        braceDepth++;
      } else if (ch === "}") {
        braceDepth = Math.max(0, braceDepth - 1);
      }
    }
    lineIdx += 1;
    if (lineIdx >= MAX_DECLARATION_HEAD_LOOKAHEAD_LINES) return undefined;
  }
}

/**
 * The right-hand proof `opensBlockDeclaration` needs: does X's own
 * paren-matched argument list (`closeOwnArgumentList`) close into a body
 * opener, a body-less terminator, or a body opener deferred to the next
 * line? `bodylessAllowed` — pass `hasDeclarationHeadWord(before)` — gates
 * the BARE `;` case only (see `SAME_LINE_ANNOTATED_BODYLESS_RE`'s own doc);
 * the annotated (`: T;` / `-> T;` / `throws T;`) case is unconditional.
 *
 * Exported so readCodeTaskPack.ts's `isDeclarationShapedMatchText` (P0-2,
 * eval-0927 review-r2 #2) can apply the IDENTICAL right-hand proof to a
 * bounded `scanLiteral` match line when deciding whether an occurrence looks
 * DECLARED — the same question `opensBlockDeclaration` answers for a call
 * site, just reached from a different (single, possibly truncated) line and
 * so passing `laterMaskedLines: undefined` (no further lines to look ahead
 * to at all — recall loss only, same direction as everywhere else here).
 */
export function rightHandOpensDeclarationBody(
  masked: string,
  nameStart: number,
  laterMaskedLines: readonly string[] | undefined,
  bodylessAllowed = false,
): boolean {
  const closed = closeOwnArgumentList(masked, nameStart, laterMaskedLines);
  if (closed === undefined) return false;
  const { rest, lineAfterClose } = closed;
  if (SAME_LINE_BODY_OPENER_RE.test(rest)) return true;
  if (SAME_LINE_ANNOTATED_BODYLESS_RE.test(rest)) return true;
  if (bodylessAllowed && SAME_LINE_BARE_BODYLESS_RE.test(rest)) return true;
  // R5-A2 (eval-0927 review-r4 P1-6, ts-bare-multiline-call-then-block): a
  // COMPLETELY EMPTY `rest` (nothing at all between X's own closing paren and
  // EOL -- no annotation, no trailing specifier) deferring to a `{` on some
  // LATER line is exactly as ambiguous as the bare-`;` case just above: a
  // multi-line call `run(\n  a,\n)` followed, on a SEPARATE statement, by an
  // unrelated block (`{\n  x();\n}`) is valid JS/TS via ASI and reads
  // identically. An actual annotation (`rest.trim().length > 0` -- some real
  // `:`/`->`/`=>`/`throws`/trailing-specifier text was matched, as in
  // `run(x: number): number` deferring its `{` to the next line) is real
  // evidence on its own and is NEVER gated by this.
  if (DEFERRED_BODY_OPENER_RE.test(rest) && (rest.trim().length > 0 || bodylessAllowed)) {
    return lineAfterClose !== undefined && /^\s*\{/.test(lineAfterClose);
  }
  return false;
}

const GO_RETURN_TUPLE_RE = /^\s*\([^(){};]*\)\s*$/;
const GO_RETURN_TYPE_RE = /^\s*[*[\]]*[A-Za-z_][\w.]*(?:\[\])?\s*$/;

/**
 * R5-A2 (eval-0927 review-r4 P1-11, go-iface-generic-ret/go-iface-chan-ret/
 * go-iface-func-ret): `GO_RETURN_TYPE_RE` only recognizes a plain (optionally
 * dotted, optionally pointer/slice-prefixed) identifier — it cannot match
 * Go's COMPOSITE return-type spellings (`map[K]V`, `<-chan T` / `chan<- T` /
 * `chan T`, `func(...) T`). Not a full Go type-grammar parser — bounded to
 * repeatedly unwrapping ONE composite layer (a pointer/slice/array/channel
 * prefix, a `map[K]`, or a `func(...)`  parameter list) around a final plain
 * identifier, which is every shape a Go interface member's return position
 * actually uses. `GO_RETURN_TUPLE_RE` still owns the separate `(T1, T2)`
 * multi-return tuple shape and is untouched.
 */
function stripGoTypePrefixes(text: string): string {
  let out = text;
  for (;;) {
    if (out.startsWith("*")) { out = out.slice(1); continue; }
    const array = /^\[\d*\]/.exec(out);
    if (array) { out = out.slice(array[0].length); continue; }
    if (out.startsWith("<-chan ")) { out = out.slice(7); continue; }
    if (out.startsWith("chan<- ")) { out = out.slice(7); continue; }
    if (/^chan\s+/.test(out)) { out = out.replace(/^chan\s+/, ""); continue; }
    break;
  }
  return out;
}
function goCompositeReturnTypeMatches(rest: string): boolean {
  const trimmed = rest.trim();
  if (trimmed.length === 0) return false;
  const stripped = stripGoTypePrefixes(trimmed);
  if (GO_RETURN_TYPE_RE.test(stripped)) return true;
  const mapMatch = /^map\[[^[\]]*\]\s*(.*)$/.exec(stripped);
  if (mapMatch) return goCompositeReturnTypeMatches(mapMatch[1]!);
  const funcMatch = /^func\s*\(([^()]*)\)\s*(.*)$/.exec(stripped);
  if (funcMatch) return funcMatch[2]!.trim().length === 0 || goCompositeReturnTypeMatches(funcMatch[2]!);
  return false;
}

/**
 * Go's ONE keyword-less declaration shape (see `isAlwaysKeywordLedLanguage`'s
 * own doc, which otherwise treats a bare `X(...) {`/`X(...)` in an
 * always-keyword-led language as always a call): an interface member,
 * written with no `func` at all — `type Fetcher interface { FetchJSON(
 * pathname string) ([]byte, error) }` (R4-A2, eval-0927 review-r3 #5,
 * goIfaceMethod). True only when X's own argument list closes
 * (`closeOwnArgumentList`, possibly across a few lines) and what follows on
 * that line is NON-EMPTY and shaped like a Go return type or return-type
 * tuple, with NOTHING else trailing: an ordinary call's result, if used at
 * all beyond a bare statement (rest EMPTY), needs an operator, a chain
 * (`.`), or an assignment next — never a second, bare, type-shaped token
 * with nothing joining them, which no Go expression grammar allows. A
 * VOID-returning interface member (rest empty, e.g. `Close()`) is textually
 * IDENTICAL to a bare call statement with no return value and stays an
 * accepted residual gap, the same direction every other shape ambiguity in
 * this module already favors (see `declarationHeadShape`'s own doc on the
 * symmetric modifier-less-`void`-in-a-brace-language gap).
 */
function goInterfaceMemberDeclarationRest(rest: string): boolean {
  return rest.trim().length > 0
    && (GO_RETURN_TUPLE_RE.test(rest) || GO_RETURN_TYPE_RE.test(rest) || goCompositeReturnTypeMatches(rest));
}

/** True when `relPath`'s language is Go (see `goInterfaceMemberDeclarationRest`). */
export function isGoLanguage(relPath: string): boolean {
  const dot = relPath.lastIndexOf(".");
  return dot > 0 && relPath.slice(dot).toLowerCase() === ".go";
}

/**
 * The Go-only carve-out `callSiteOccurrenceIsDeclaration` (readCodeTaskPack.ts)
 * applies INSTEAD OF `opensBlockDeclaration` for a `.go` file's bare
 * occurrence with no `func` keyword hit — see `goInterfaceMemberDeclarationRest`.
 */
export function goInterfaceMemberDeclarationShape(
  masked: string,
  nameStart: number,
  laterMaskedLines: readonly string[] | undefined,
): boolean {
  const closed = closeOwnArgumentList(masked, nameStart, laterMaskedLines);
  return closed !== undefined && goInterfaceMemberDeclarationRest(closed.rest);
}

/**
 * Extensions whose language declares a function/method ONLY via its own
 * keyword (`fun`/`fn`/`func`/`def`) — there is no keyword-less method-
 * shorthand and no trailing-lambda-AS-declaration syntax, so a BARE
 * occurrence shaped like `X(...) {` in one of these files is always a CALL
 * (most often a trailing lambda/closure argument: Kotlin `repeat(5) {`,
 * Ruby `5.times {`), never a declaration of `X` — see `opensBlockDeclaration`.
 * PHP belongs here too (`function X(` is its only function/method
 * declaration, interface members included): without it `echo X($a);` /
 * `print X($a);` read as a typed prototype (orchestrator probe, round 4).
 */
const ALWAYS_KEYWORD_LED_EXTENSIONS: ReadonlySet<string> = new Set([
  ".kt", ".kts", ".rs", ".swift", ".go", ".py", ".pyi", ".rb", ".scala", ".sc", ".php",
]);

/** True when `relPath`'s language always keyword-leads a real function/method declaration (see `ALWAYS_KEYWORD_LED_EXTENSIONS`). */
export function isAlwaysKeywordLedLanguage(relPath: string): boolean {
  const dot = relPath.lastIndexOf(".");
  return dot > 0 && ALWAYS_KEYWORD_LED_EXTENSIONS.has(relPath.slice(dot).toLowerCase());
}

/** The index right after the bracket matching `text[start]` (which must be `open`), tracking nested `open`/`close` depth; `undefined` when it never balances within `text`. Depth-generic, so a DOUBLED bracket (`[[attr]]`) balances at depth 2 exactly like two singly-nested calls would, with no separate case needed. */
function matchBalancedIndex(text: string, start: number, open: string, close: string): number | undefined {
  if (text[start] !== open) return undefined;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return undefined;
}

const LEADING_ANNOTATION_AT_RE = /^@[A-Za-z_$][\w$]*/;
/** The leading identifier characters of a word, ignoring any trailing pointer/generic/array suffix — see `declarationHeadShape`'s own `core` use for why this must be tested against `NEVER_TYPE_TOKEN_RE` instead of the raw word. */
const CORE_IDENTIFIER_HEAD_RE = /^[A-Za-z_$][\w$]*/;

/**
 * R5-A2 (eval-0927 review-r4 P1-11): strips LEADING declaration-prefix
 * clauses that name no type and no modifier of their own — a decorator/
 * annotation (`@Test`, `@HostListener('window:resize', ['$event'])`,
 * repeatable), a C#-style attribute (`[HttpGet]`) or a C++ `[[attribute]]`
 * (the same balanced-bracket scan naturally covers both — a doubled bracket
 * just balances at depth 2), and a C++ `template <typename T>` introducer —
 * so the modifier/type-word parser below never has to recognize any of these
 * AS a modifier or a type; it only ever sees the REAL return-type words that
 * follow. Repeats (multiple decorators/attributes may stack); stops at the
 * first head that starts with none of these shapes, leaving it untouched —
 * including a genuinely unbalanced or unrecognized bracket, which the
 * ordinary word-shape parser then rejects exactly as before (recall loss
 * only, the same direction this whole module favors elsewhere).
 */
function stripLeadingDeclarationPrefixes(head: string): string {
  let text = head.replace(/^\s+/, "");
  for (;;) {
    if (text.startsWith("[")) {
      const end = matchBalancedIndex(text, 0, "[", "]");
      if (end === undefined) break;
      text = text.slice(end).replace(/^\s+/, "");
      continue;
    }
    const atMatch = LEADING_ANNOTATION_AT_RE.exec(text);
    if (atMatch) {
      let rest = text.slice(atMatch[0].length);
      if (rest.startsWith("(")) {
        const end = matchBalancedIndex(rest, 0, "(", ")");
        if (end === undefined) break;
        rest = rest.slice(end);
      }
      text = rest.replace(/^\s+/, "");
      continue;
    }
    if (/^template\s*</.test(text)) {
      const ltAt = text.indexOf("<");
      const end = matchBalancedIndex(text, ltAt, "<", ">");
      if (end === undefined) break;
      text = text.slice(end).replace(/^\s+/, "");
      continue;
    }
    break;
  }
  return text;
}

/**
 * FIX-FAB2 (eval-0927 orchestrator repro, afx, 2026-09-28): the LEFT-hand
 * half of `opensBlockDeclaration` — is `before` shaped like a declaration
 * HEAD by itself (not inside a still-open paren; empty, or modifiers plus at
 * most one trailing type token), with no opinion on what follows on the
 * line? Extracted so evidenceClosure.ts's `calleeNamesIn` can apply the
 * IDENTICAL left-hand test to a callee candidate whose own body may close on
 * the SAME line (a one-line method shorthand: `place() { payment(); }`),
 * where `opensBlockDeclaration`'s own right-hand "the whole line ends with
 * {" check would wrongly say no (that line ends with `}`) — `calleeNamesIn`
 * supplies its own right-hand proof instead (does a `{` immediately follow
 * THIS occurrence's own matching close-paren, wherever on the line that is).
 *
 * Also closes a gap `opensBlockDeclaration` itself had: `void` is in
 * `NEVER_TYPE_TOKEN_RE` (so a bare `void someFunction();` — the JS operator
 * that discards a call's result — is never misread as a declaration), which
 * used to also reject the extremely common Java/C# `void`-returning member
 * (`public void place() {`) as a declaration entirely. A trailing `void`
 * is now accepted as a return type when at least one modifier word precedes
 * it — `public`/`private`/etc. never appears before the JS void-operator
 * form, so this costs no precision there; a bare, modifier-less `void X()`
 * stays ambiguous and still falls through to `return false` (recall loss
 * only, the same direction this whole mechanism already favors).
 */
export function declarationHeadShape(before: string): boolean {
  let depth = 0;
  for (const ch of before) {
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
  }
  if (depth > 0) return false; // inside a still-open paren: a condition or another declaration's own parameter list
  const head = stripLeadingDeclarationPrefixes(statementHeadSegment(before).trim());
  if (head.length === 0) return true;
  const words = mergeTrailingPointerMarkers(splitHeadWords(head));
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (DECLARATION_MODIFIER_WORD_RE.test(word) || C_NUMERIC_TYPE_WORD_RE.test(word)) continue;
    const isLast = i === words.length - 1;
    if (isLast && word === "void" && i > 0) continue; // a void return type AFTER >=1 modifier (Java/C#) -- see doc above
    // R5-A2 (eval-0927 review-r4 P1-6, js-generator-method): a BARE `*` as
    // the WHOLE head is JS/TS's own generator-method-shorthand marker
    // (`*run(x) {`) -- `mergeTrailingPointerMarkers` already folds a
    // TRAILING `*` onto a PRECEDING modifier word when one exists
    // (`async *run` -> "async*", already accepted via the type-token path
    // below), so `word === "*"` can only ever occur here when it is the
    // SOLE word (`words.length === 1`, `i === 0`) -- there is no preceding
    // modifier for it to have merged onto. Never a C-style dereference: that
    // shape's right-hand side (`*run(x) = 3;`) has no annotation/specifier/
    // body-opener `rightHandOpensDeclarationBody` recognizes, so accepting
    // the bare `*` here costs nothing there.
    if (isLast && word === "*") continue;
    // R5-A2 (eval-0927 review-r4 P1-6, js-yield-star): NEVER_TYPE_TOKEN_RE is
    // tested against the word's CORE identifier (before any trailing `*`/`&`/
    // `[]`/generic suffix `isTypeToken` would otherwise accept), not the raw
    // word -- `yield*` (JS generator delegation) is `yield` plus a suffix that
    // LOOKS exactly like a C pointer-return marker, and without this, the
    // exact-match `NEVER_TYPE_TOKEN_RE.test("yield*")` silently misses (it
    // only ever matched the bare keyword), so `isTypeToken` accepted the
    // whole thing as if it were a return type and a bare `;`-terminated
    // `yield* run(x);` read as a body-less prototype.
    const core = CORE_IDENTIFIER_HEAD_RE.exec(word)?.[0] ?? word;
    if (isLast && !NEVER_TYPE_TOKEN_RE.test(core) && isTypeToken(word)) continue; // incl. a generic type (review-r2 #12)
    return false;
  }
  return true;
}

/**
 * 2 = the receiver IS the focal type (`orderService.cancel(`, `OrderService::cancel(`);
 * 1 = the receiver only ENDS WITH the type's name (`primaryOrderService`), or
 *     the receiver is unrecognized / absent but the FILE names the focal type
 *     independently (an import, a field declaration, a parameter type) — a
 *     field is very often named for its role (`store.reserve(id)` for an
 *     `InventoryStore`), so the file-level reference is the corroboration that
 *     keeps the naming convention from being a requirement;
 * 0 = no compatible relation — this occurrence is NOT a call of this member,
 *     which is the abstain the whole mechanism rests on (`cache.cancel()` in a
 *     file that never mentions the focal type adds nothing).
 *
 * A self receiver (`this`, `self`, `super`) is 0 whatever the file names: it
 * denotes the CALLING object, so the call is that class's own same-named
 * method, not the focal one.
 */
export function receiverStrength(
  receiver: string | undefined,
  typeName: string,
  fileNamesType: boolean,
): 0 | 1 | 2 {
  const normalizedType = normalizeCallerIdent(typeName);
  if (normalizedType.length === 0) return 0;
  if (receiver !== undefined) {
    const normalizedReceiver = normalizeCallerIdent(receiver);
    if (SELF_RECEIVERS.has(normalizedReceiver)) return 0;
    if (normalizedReceiver === normalizedType) return 2;
    if (
      normalizedType.length >= MIN_WEAK_RECEIVER_TYPE_CHARS
      && normalizedReceiver.length > normalizedType.length
      && normalizedReceiver.endsWith(normalizedType)
    ) return 1;
  }
  return fileNamesType ? 1 : 0;
}

/** Whole-word occurrence of `typeName` anywhere in the file's code (an import, a field, a parameter, an extends clause). Comment/string spans are masked out first, so prose naming the type does not count. */
export function fileNamesType(lines: readonly string[], typeName: string, hashComment: boolean): boolean {
  if (typeName.length === 0) return false;
  for (const line of lines) {
    if (!line.includes(typeName)) continue;
    const masked = maskNonCode(line, hashComment);
    for (let at = masked.indexOf(typeName); at >= 0; at = masked.indexOf(typeName, at + 1)) {
      const previous = at > 0 ? masked[at - 1]! : "";
      const next = masked[at + typeName.length] ?? "";
      if (previous !== "" && IDENTIFIER_CHAR_RE.test(previous)) continue;
      if (next !== "" && IDENTIFIER_CHAR_RE.test(next)) continue;
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

export interface CallerSiteCandidate {
  readonly path: string;
  readonly line: number;
  readonly strength: 1 | 2;
  /** How many compatible call sites of this member the file holds — a thin entry layer calls it once; a utility that calls everything is not "the caller". */
  readonly callsInFile: number;
  /** Leading path segments shared with the focal file. */
  readonly proximity: number;
}

/** Leading path segments two workspace-relative paths share (the file's own basename never counts). */
export function sharedPathPrefixSegments(a: string, b: string): number {
  const left = a.split("/").slice(0, -1);
  const right = b.split("/").slice(0, -1);
  let shared = 0;
  while (shared < left.length && shared < right.length && left[shared] === right[shared]) shared++;
  return shared;
}

/**
 * (a) receiver-name match strength — how sure we are this really is a call of
 * the focal member; (b) fewer call sites in the file — a thin entry layer
 * calls the member once, a utility that calls everything is not the answer to
 * "where does the request enter"; (c) path proximity to the focal file. Then
 * path and line, so the order is total and stable across runs.
 */
export function rankCallSites(sites: readonly CallerSiteCandidate[]): CallerSiteCandidate[] {
  return [...sites].sort((a, b) =>
    b.strength - a.strength
    || a.callsInFile - b.callsInFile
    || b.proximity - a.proximity
    || a.path.localeCompare(b.path)
    || a.line - b.line
  );
}

/** The bounded window served when no enclosing symbol can be resolved around a call site. */
export function boundedCallerWindow(line: number, totalLines: number): { start: number; end: number } {
  return {
    start: Math.max(1, line - CALLER_WINDOW_MARGIN_LINES),
    end: Math.min(Math.max(totalLines, 1), line + CALLER_WINDOW_MARGIN_LINES),
  };
}

/** The `why` every added surface carries, so the addition is self-describing on the wire and greppable in a trace. */
export function callerExpansionWhy(focal: CallerFocalMember): string {
  return `caller-of:${focal.typeName}.${focal.member}`;
}

/** Does the request itself ask about tests? Only then may a test file be served as a caller. */
export function queryMentionsTests(query: string): boolean {
  return /\b(?:tests?|testing|spec|specs|fixtures?)\b/i.test(query) || query.includes("テスト");
}
