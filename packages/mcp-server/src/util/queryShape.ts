/**
 * queryShape.ts — shared free-text query shape classifiers.
 *
 * DESIGN-v0.8 §A6 deliverable 3: `isEnumLikeQuery` was module-private in
 * readCodeTaskPack.ts. locateTaskContext.ts needs the SAME classifier (for
 * the exhaustive-initializer candidate scan and the graph-index full-
 * reference-list expansion), but readCodeTaskPack.ts already imports
 * locateTaskContext.ts, so importing readCodeTaskPack.ts's
 * `isEnumLikeQuery` INTO locateTaskContext.ts would create a cycle. Hoisting
 * the (pure, dependency-free) classifier into its own util breaks the cycle
 * cleanly — both call sites import from here instead of one importing from
 * the other.
 *
 * No behavior change: identical regex/semantics to the original
 * readCodeTaskPack.ts-private helper.
 *
 * `stripPathSpans` (W9, 2026-08-22) was hoisted here for the SAME cycle
 * reason: it generalizes what was readCodeTaskPack.ts's task-pack-only
 * `concernHarvestText`, but locateTaskContext.ts's `extractIdentifiers` needs
 * the same path-span scrubbing and cannot import readCodeTaskPack.ts.
 */

import { basename } from "node:path";
import { HAN_RUN_RE, HIRAGANA_RUN_RE, KATAKANA_RUN_RE } from "./cjkSpans.js";

/**
 * Generic query-shape classification shared by editIntentForRole,
 * doneCheckForRole, buildCompletionChecks (readCodeTaskPack.ts), and the
 * exhaustive-initializer / graph-index full-reference-list logic
 * (locateTaskContext.ts). Deliberately does NOT trigger on a bare ALL-CAPS
 * token — that matched incidental acronyms (protocol names, algorithm
 * initialisms) in queries that were not enum/variant tasks at all, and
 * forced this shape onto unrelated bug-fix queries.
 */
export function isEnumLikeQuery(query: string): boolean {
  if (/\b(enum|priority|role)\b/i.test(query)) return true;
  if (!/\bstatus\b/i.test(query)) return false;
  return /\b(add|assign|assignment|new|introduce|support|extend|variant|value|member|schema|badge)\b/i.test(query);
}

// ---------------------------------------------------------------------------
// tokenizeQuery — shared free-text query tokenization pipeline.
//
// Consolidates what were two independently-shaped tokenizers over the same
// underlying idea ("break a free-text query into significant tokens, drop
// filler words"):
//   - findText.ts's `tokenizeQuery`/`FIND_STOP_WORDS`: quoted-phrase
//     extraction, camelCase/snake_case/kebab-case splitting, min length 3,
//     distinctiveness-sorted output. Drives explore action=find's tokenized
//     AND/OR fallback — token ORDER matters there (tried most-distinctive
//     first).
//   - readCodeTaskPack.ts's `significantQueryTokens`/`CONCERN_STOP_WORDS`:
//     lowercase-first, split on non-alphanumeric only (no case-boundary
//     splitting), min length 4, insertion-order output. Drives the
//     unmatched-concern-token route-honesty check — token order feeds
//     directly into the `blocking_next_steps` entries' order, so this
//     shape must stay exactly as simple as before.
//
// The two are NOT the same algorithm (one splits on case boundaries and
// sorts by distinctiveness; the other does neither), so unifying them into
// one fixed pipeline would silently change either caller's output. Instead
// this exports ONE parameterized pipeline whose `mode` selects between the
// two prior shapes exactly, plus the shared `minLen`/`stopWords` knobs the
// two callers already varied independently. Each caller's own stop-word set
// stays caller-owned (FIND_STOP_WORDS in findText.ts, CONCERN_STOP_WORDS in
// readCodeTaskPack.ts) — see each set's own comment; they intentionally
// disagree on some filler words and are not merged here.
// ---------------------------------------------------------------------------

export interface TokenizeQueryOptions {
  /** Minimum token length to keep (post-trim, pre-lowercase-check). */
  minLen: number;
  /** Case-insensitive filler words to drop. */
  stopWords: ReadonlySet<string>;
  /**
   * "identifier" (findText.ts's prior shape): extracts quoted phrases
   * literally, then identifier-shaped words, additionally splitting each on
   * camelCase/PascalCase boundaries and snake_case/kebab-case separators,
   * and sorts the result most-distinctive-first.
   *
   * "simple" (readCodeTaskPack.ts's prior shape): lowercases the whole
   * query up front, splits only on runs of non-alphanumeric characters (so
   * case boundaries are NOT split — "fooBar" stays one token, "foo_bar"
   * splits into "foo"/"bar" since "_" is non-alphanumeric), and preserves
   * first-encountered order (no distinctiveness sort).
   */
  mode: "identifier" | "simple";
}

function scoreTokenDistinctiveness(token: string): number {
  let score = token.length;
  if (/^[A-Z][a-z]/.test(token) || /[a-z][A-Z]/.test(token) || /_/.test(token)) score += 4;
  if (/^[A-Z0-9_]{3,}$/.test(token)) score += 3;
  return score;
}

// ---------------------------------------------------------------------------
// extractCjkQueryTokens — CJK token extraction for FREE-TEXT QUERIES only
// (field-report fix, 2026-09-08). Deliberately NOT cjkSpans.ts's shared
// extractCjkTokens: that helper also feeds retrieval/tokenize.ts's BM25F
// CONTENT indexing (doc/body/signature/markdown/config fields — see
// units.ts), where a whole-hiragana-run token and its bigrams are harmless
// (BM25's own IDF already suppresses a term common across most documents —
// see cjkSpans.ts's own module comment) and changing that shared behavior
// is out of scope here. A free-text QUERY has different requirements: a
// tokenizeQuery caller can turn its output directly into a `search_files
// find` `queries` item (see readCodeTaskPack.ts's generic no-named-subject
// discovery fallback), where a single bad token — a hiragana fragment made
// of verb inflection and particles, with no dictionary meaning of its own —
// can never match anything and wastes the whole call. Confirmed defect:
// "エラーが起きたときのリトライ処理を説明してください" used to mint the
// token "きたときの" (a Hiragana run straddling the tail of 起きた, the
// standalone とき, and の) via extractCjkTokens's whole-run-token pass.
//
// Rules (deliberately simpler than extractCjkTokens's runs/bigrams/
// unigrams — no partial-match fallback is attempted here at all):
//   - A Hiragana run is NEVER emitted as a token, whole or partial. Kana
//     runs in ordinary prose are overwhelmingly particle strings and verb/
//     adjective inflection (の が を に へ と で は も か から まで より
//     など して する した ください, …) with no standalone lexical meaning
//     — unlike cjkSpans.ts's shared helper, there is no bigram/stopword-
//     substring compromise here; a query-token pipeline can simply drop
//     the whole script rather than gamble on a fixed stopword list.
//   - A Han (kanji) run is emitted whole when it is 2+ characters. A
//     single kanji character is emitted only when a Katakana run
//     immediately follows it — standing alone next to unrelated prose it
//     otherwise carries too little signal of its own to search on.
//   - A Katakana run — already inclusive of the long-vowel mark ー, see
//     cjkSpans.ts's KATAKANA_RUN_RE — is emitted whole when it is 2+
//     characters.
//   - A Han or Katakana run immediately followed (no gap) by a Hiragana
//     run that STARTS WITH して/する/した/ください is dropped entirely,
//     stem included — these are the top three conjugations of する ("to
//     do") plus the polite imperative auxiliary, which together build the
//     extremely common 漢語+する / カタカナ+する compound verb (説明する
//     "explain", 確認する "confirm", 修正する "fix", スタートする
//     "start", …) or a bare imperative (確認ください). A query phrased as
//     an instruction sentence ("…を[X]してください" = "please [X] …")
//     almost always ends this way, and [X] names one of a small,
//     low-signal set of generic instruction verbs that never usefully
//     narrows a code search — unlike the noun phrase earlier in the same
//     sentence (リトライ処理, 有効期限判定, …), which this rule leaves
//     untouched. This check runs BEFORE the length rules above, so it can
//     drop a run the length rule alone would have kept.
//   - A dot-qualified Latin identifier ("Cache.get", "foo.bar.baz") is
//     emitted whole, ADDITIONALLY to (never instead of) whatever the
//     caller's own ASCII word pass already produced for it ("Cache" and
//     "get" separately) — that pass's own word regex never crosses a `.`,
//     so a dotted/qualified name it can never see would otherwise vanish
//     from a CJK-mixed query even though it is usually the query's single
//     most distinctive token.
//
// Order is first-appearance in `query` (Latin dotted identifiers last);
// tokens are deduped by exact string equality. Bypasses the caller's own
// minLen/stopWords entirely, same as extractCjkTokens did — an ASCII
// minLen of 3+ has no CJK analog, and a caller's ASCII-only stopWords set
// can never match a CJK token or a dotted Latin identifier anyway.
// ---------------------------------------------------------------------------

/** Hiragana continuations recognized as verb/imperative inflection — see extractCjkQueryTokens's own comment above for why these five specifically. */
const CJK_VERB_INFLECTION_PREFIXES = ["して", "する", "した", "ください"];

/** A dot-qualified Latin identifier ("Cache.get", "foo.bar.baz") — at least one `.`-joined continuation; a bare word is already covered by each caller's own ASCII word pass. */
const DOTTED_LATIN_IDENTIFIER_RE = /[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+/g;

function extractCjkQueryTokens(query: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  function add(tok: string): void {
    if (seen.has(tok)) return;
    seen.add(tok);
    out.push(tok);
  }

  const runRe = new RegExp(`(${HAN_RUN_RE.source})|(${HIRAGANA_RUN_RE.source})|(${KATAKANA_RUN_RE.source})`, "g");
  const runs: Array<{ text: string; index: number; kind: "han" | "hiragana" | "katakana" }> = [];
  let m: RegExpExecArray | null;
  while ((m = runRe.exec(query)) !== null) {
    const kind = m[1] !== undefined ? "han" : m[2] !== undefined ? "hiragana" : "katakana";
    runs.push({ text: m[0], index: m.index, kind });
  }

  for (let i = 0; i < runs.length; i++) {
    const run = runs[i]!;
    if (run.kind === "hiragana") continue;

    const next = runs[i + 1];
    const adjacent = !!next && next.index === run.index + run.text.length;
    const followedByVerbHiragana =
      adjacent && next!.kind === "hiragana" && CJK_VERB_INFLECTION_PREFIXES.some((p) => next!.text.startsWith(p));
    if (followedByVerbHiragana) continue;

    if (run.kind === "han") {
      if (run.text.length >= 2) {
        add(run.text);
      } else if (adjacent && next!.kind === "katakana") {
        add(run.text);
      }
    } else if (run.text.length >= 2) {
      add(run.text);
    }
  }

  const dotted = query.match(DOTTED_LATIN_IDENTIFIER_RE) ?? [];
  for (const d of dotted) add(d);

  return out;
}

function tokenizeIdentifierMode(query: string, minLen: number, stopWords: ReadonlySet<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  function add(tok: string, opts: { bypassMinLen?: boolean } = {}): void {
    const t = tok.trim();
    if (!opts.bypassMinLen && t.length < minLen) return;
    if (stopWords.has(t.toLowerCase())) return;
    const key = t.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(t);
  }

  const quoted = query.match(/"([^"]+)"|'([^']+)'/g) ?? [];
  for (const q of quoted) add(q.slice(1, -1));

  const words = query.match(/[A-Za-z_][A-Za-z0-9_-]*/g) ?? [];
  for (const w of words) {
    add(w);
    // camelCase/PascalCase split: fooBar -> foo, Bar
    const camelSplit = w.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/\s+/);
    if (camelSplit.length > 1) for (const p of camelSplit) add(p);
    // snake_case / kebab-case split.
    if (/[_-]/.test(w)) for (const p of w.split(/[_-]+/)) add(p);
  }

  // CJK (field-report fix, 2026-08-27; refined 2026-09-08): the ASCII word/
  // quoted-phrase passes above never match a Han/Hiragana/Katakana
  // character, so a Japanese-heavy query used to contribute NOTHING here.
  // extractCjkQueryTokens's own tokens bypass this mode's minLen — an ASCII
  // minLen of 3+ has no CJK analog (a single kanji, or a 2-char kana run, is
  // already a meaningful unit; see extractCjkQueryTokens's own comment
  // above) — but still flow through `add`'s existing dedup and this
  // caller's OWN (ASCII-only) stopWords set, which can never match a CJK
  // token anyway.
  for (const t of extractCjkQueryTokens(query)) add(t, { bypassMinLen: true });

  // Distinctive-first: longer, non-generic, identifier-shaped tokens sort first.
  out.sort((a, b) => scoreTokenDistinctiveness(b) - scoreTokenDistinctiveness(a));
  return out;
}

function tokenizeSimpleMode(query: string, minLen: number, stopWords: ReadonlySet<string>): string[] {
  const raw = query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 0);
  const asciiTokens = raw.filter((t) => t.length >= minLen && !stopWords.has(t));
  // CJK (field-report fix, 2026-08-27; refined 2026-09-08): `.split(/[^a-z0-9]+/)`
  // treats every Han/Hiragana/Katakana character as a separator, discarding
  // it — the same defect as tokenizeIdentifierMode above. CJK tokens bypass
  // this mode's minLen/stopWords for the same reason (extractCjkQueryTokens
  // already applies its own JA-specific filtering internally — see its own
  // comment above).
  const cjkTokens = extractCjkQueryTokens(query);
  return [...new Set([...asciiTokens, ...cjkTokens])];
}

/**
 * Split a free-text query into significant tokens per `options.mode` — see
 * TokenizeQueryOptions for the two supported shapes. Each existing caller
 * passes its own prior `minLen`/`stopWords`/`mode`, so behavior is
 * unchanged from before this consolidation.
 */
export function tokenizeQuery(query: string, options: TokenizeQueryOptions): string[] {
  return options.mode === "identifier"
    ? tokenizeIdentifierMode(query, options.minLen, options.stopWords)
    : tokenizeSimpleMode(query, options.minLen, options.stopWords);
}

// ---------------------------------------------------------------------------
// stripPathSpans — remove filesystem-path-shaped spans from free-text query
// prose BEFORE identifier/concern-token extraction (W9, 2026-08-22).
//
// A task_pack query that mentions an absolute path in prose — "…in
// /path/to/workspace/packages/… how does X work" — used to
// have every path SEGMENT ("users", "takayuki", "git", "token", "lighten", …)
// tokenized as if it were free-text/identifier content. Path segments are not
// identifiers: the task pack already resolves real paths structurally
// elsewhere (paths[]/basename matching), so a path span mentioned in prose
// carries no free-text concern of its own and should contribute NOTHING to
// (a) `explicit-identifier`/wiring obligations, or (b) a `search_files
// action=find` `next`/`next_call` suggestion built from query tokens. Left
// unfixed, a `discover` decision could hand back a `find` over pure path
// segments — wasted at best, and if a segment coincidentally became an
// `explicit-identifier` obligation, the pack could never certify (the
// identifier is provably absent from every served surface).
//
// This scrubs the SOURCE TEXT before tokenization, not the derived tokens
// after the fact: a plain word like "mount" is a legitimate concern token in
// a mounting-related bug report, so any rule keyed on the word alone either
// keeps the leak or drops real concerns. Stripping the path SPAN instead
// (root-prefixed, or generically path-shaped) removes exactly the segments
// that only exist because they happen to sit inside a path, while standalone
// dictionary words elsewhere in the same query are left untouched.
//
// A bare FILE STEM mentioned without a directory prefix — "policy.ts",
// "NativeMethods.cs" — is deliberately NOT a path span: the filename-match
// layer (named-file obligations, basename probes) still needs it, and a
// single `name.ext` token carries no directory segment to strip. Only a
// span with at least one directory separator qualifies.
//
// This is a superset of what was readCodeTaskPack.ts's task-pack-only
// `concernHarvestText` (root-prefixed spans, extension-terminated `/`- or
// `\`-joined spans, and the root's own basename word) — those three rules
// are unchanged here — generalized with anchored-but-extensionless spans
// (absolute, home-relative, explicit-relative, Windows drive) and a bare
// unanchored multi-segment span, so the SAME scrub now also covers a path
// that ends in a directory name rather than a file.
// ---------------------------------------------------------------------------

function escapeRegExpLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Segment charset shared by every path-span pattern below: word chars, dot, hyphen. */
const PATH_SEGMENT_CHARS = "[\\w.-]+";

// A `/`- or `\`-joined segment run ending in a file extension —
// "src/Native/NativeMethods.cs", "C:\\proj\\Foo.d.ts" — regardless of
// whether it sits under the workspace root; an in-prose path mention is
// still a path, not a concern word. (Originally concernHarvestText's own
// PATH_EXTENSION_SPAN_RE — unchanged.)
const PATH_EXTENSION_SPAN_RE = new RegExp(
  `(?:[A-Za-z]:)?(?:${PATH_SEGMENT_CHARS}[/\\\\])+${PATH_SEGMENT_CHARS}\\.[A-Za-z][A-Za-z0-9]{0,9}\\b`,
  "g",
);

// Same shape as PATH_EXTENSION_SPAN_RE but captures the trailing filename —
// used only by fileNamesInPathSpans below, never by stripPathSpans's own
// replace passes.
const PATH_EXTENSION_SPAN_CAPTURE_RE = new RegExp(
  `(?:[A-Za-z]:)?(?:${PATH_SEGMENT_CHARS}[/\\\\])+(${PATH_SEGMENT_CHARS}\\.[A-Za-z][A-Za-z0-9]{0,9})\\b`,
  "g",
);

/**
 * The trailing FILENAME (basename, extension included) of every
 * extension-terminated path span in `text` — e.g. "docs/rate-table.xlsx"
 * yields ["rate-table.xlsx"]; the directory segments ("docs") are
 * deliberately dropped, only the file's own name is returned.
 *
 * For callers where "the query named this FILE" must keep working even
 * after `stripPathSpans` removes the directory-qualified mention entirely —
 * the filename-match layer / named-file obligations stripPathSpans's own
 * doc comment references. See locateTaskContext.ts's `extractIdentifiers`:
 * without this, "audit docs/rate-table.xlsx for …" lost the ONLY token
 * ("rate"/"table"/"xlsx") the locator had to recognize and attach the
 * caller-named file by, even though a separate, independent mechanism
 * (prefetchArtifactSurfaceSections/callerNamedArtifacts in
 * readCodeTaskPack.ts) already correctly extracted its content — the two
 * mechanisms disagreeing left the extracted content stranded, unattached to
 * any surface. Re-tokenizing these basenames alongside the scrubbed text
 * restores the match without reintroducing "docs" as a free identifier.
 */
export function fileNamesInPathSpans(text: string): string[] {
  return [...text.matchAll(PATH_EXTENSION_SPAN_CAPTURE_RE)].map((match) => match[1]!);
}

// Every anchored pattern below is guarded by this negative lookbehind: the
// anchor character itself must NOT be preceded by another path-segment
// character. Without it, a BARE unanchored run like "packages/mcp-server/src"
// let POSIX_ABSOLUTE_SPAN_RE match the "/mcp-server/src" tail on its own (a
// perfectly valid "/seg/seg" shape starting mid-string), stripping that tail
// but ORPHANING the leading "packages" segment — which then had no `/`
// continuation left for BARE_MULTI_SEGMENT_SPAN_RE to find. Confirmed via a
// unit test before this guard existed: `packages/mcp-server/src` reduced to
// a stray, unstripped "packages". The same reasoning applies to the drive
// letter (a trailing letter of an ordinary word followed by ":/" in some
// unrelated construct) and the leading dot of ".{1,2}/" — `~` is not itself a
// path-segment character so it is not actually at risk, but the guard is
// applied uniformly rather than reasoned about per anchor.
const NOT_PRECEDED_BY_SEGMENT_CHAR = `(?<![\\w.-])`;

// Windows drive-letter absolute: "C:\Users\name\project" or "C:/Users/name"
// — >=1 segment after the drive; the "X:\" / "X:/" anchor is unambiguous.
const WINDOWS_DRIVE_SPAN_RE = new RegExp(
  `${NOT_PRECEDED_BY_SEGMENT_CHAR}[A-Za-z]:[\\\\/]${PATH_SEGMENT_CHARS}(?:[\\\\/]${PATH_SEGMENT_CHARS})*`,
  "g",
);

// POSIX absolute: "/seg/seg…" — requires >=2 segments (>=2 slashes total).
// A single leading slash is too weak a signal on its own: ordinary prose
// uses one slash for "and/or", "read/write", fractions, or a date.
const POSIX_ABSOLUTE_SPAN_RE = new RegExp(
  `${NOT_PRECEDED_BY_SEGMENT_CHAR}/${PATH_SEGMENT_CHARS}(?:/${PATH_SEGMENT_CHARS})+`,
  "g",
);

// Home-relative: "~/seg…" or "~\seg…" — >=1 segment; the "~/" anchor alone
// is unambiguous (never occurs in ordinary prose).
const HOME_RELATIVE_SPAN_RE = new RegExp(
  `${NOT_PRECEDED_BY_SEGMENT_CHAR}~[\\\\/]${PATH_SEGMENT_CHARS}(?:[\\\\/]${PATH_SEGMENT_CHARS})*`,
  "g",
);

// Explicit relative: "./seg…", "../seg…", ".\\seg…", "..\\seg…" — >=1
// segment; these anchors never occur in ordinary prose either.
const EXPLICIT_RELATIVE_SPAN_RE = new RegExp(
  `${NOT_PRECEDED_BY_SEGMENT_CHAR}\\.{1,2}[\\\\/]${PATH_SEGMENT_CHARS}(?:[\\\\/]${PATH_SEGMENT_CHARS})*`,
  "g",
);

// Bare, unanchored multi-segment span: no recognizable anchor and no
// extension, but >=2 separators (>=3 segments) — e.g. "packages/mcp-server/
// src" mentioned without a "./" prefix. Strong enough on its own that it is
// not an ordinary two-word slash pairing (which has only one separator).
const BARE_MULTI_SEGMENT_SPAN_RE = new RegExp(
  `${PATH_SEGMENT_CHARS}(?:/${PATH_SEGMENT_CHARS}){2,}|${PATH_SEGMENT_CHARS}(?:\\\\${PATH_SEGMENT_CHARS}){2,}`,
  "g",
);

/**
 * Remove workspace-identity and generically path-shaped text from `text`
 * BEFORE tokenization — see the module comment above. A no-op on
 * already-clean prose: absent a literal root basename, a root-prefixed
 * span, or a generic path span, the text passes through unchanged.
 *
 * `workspaceRoot` may be `""` — every root-specific rule (the exact-root
 * prefix and the root's own basename word) is then skipped, leaving only
 * the generic, workspace-agnostic path-span rules. This lets any pure
 * text/identifier helper call `stripPathSpans("", text)` without needing to
 * thread an actual workspace root through its signature.
 */
export function stripPathSpans(workspaceRoot: string, text: string): string {
  if (!text) return text;
  let out = text;

  const root = (workspaceRoot ?? "").trim();
  if (root.length > 1) {
    out = out.replace(new RegExp(`${escapeRegExpLiteral(root)}[^\\s"'\`]*`, "g"), " ");
  }

  out = out.replace(WINDOWS_DRIVE_SPAN_RE, " ");
  out = out.replace(PATH_EXTENSION_SPAN_RE, " ");
  out = out.replace(POSIX_ABSOLUTE_SPAN_RE, " ");
  out = out.replace(HOME_RELATIVE_SPAN_RE, " ");
  out = out.replace(EXPLICIT_RELATIVE_SPAN_RE, " ");
  out = out.replace(BARE_MULTI_SEGMENT_SPAN_RE, " ");

  const base = basename(root);
  if (base) {
    out = out.replace(
      new RegExp(`(?<![A-Za-z0-9_.-])${escapeRegExpLiteral(base)}(?![A-Za-z0-9_.-])`, "gi"),
      " ",
    );
  }

  return out;
}
