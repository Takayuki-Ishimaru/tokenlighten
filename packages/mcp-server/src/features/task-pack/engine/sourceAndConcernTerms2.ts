// sourceAndConcernTerms — extracted implementation; imports point to the owning modules.
import type { DeclarationResolution } from "./sourceAndConcernTerms.js";
import type { FindTextUniverse } from "../../search/find/findText.js";
import type { RequestItem } from "../requestItems.js";
import { GENERIC_SOFTWARE_ABSENCE_WORDS } from "./concernProof3.js";
import { boundedTextMemo } from "../../../util/boundedTextMemo.js";
import { countLines } from "../../../util/countLines.js";
import { fileTermCandidatePaths } from "./sourceAndConcernTerms.js";
import { isRegexLiteralStartAt } from "./sourceAndConcernTerms.js";
import { looksLikeFileTerm } from "../requestItems.js";
import { productPathsFirst } from "./sourceAndConcernTerms.js";
import { readCached } from "./packBasics2.js";
import { regexLiteralCloseIndex } from "./sourceAndConcernTerms.js";
import { requestItemPrewalkStorage } from "./requestItemAbsence2.js";

export function declarationRangeInFile(workspace: string, relPath: string, identifier: string): DeclarationResolution {
  const fromAst = requestItemPrewalkStorage.getStore()?.astDeclarationRanges.get(relPath)?.get(identifier);
  if (fromAst === undefined) return { source: "unresolved" };
  const totalLines = currentFileLineCount(workspace, relPath);
  if (totalLines === undefined) return { source: "unresolved" };
  const start = Math.max(1, Math.min(fromAst.start, totalLines));
  const end = Math.max(start, Math.min(totalLines, fromAst.end));
  return { source: "ast", span: { start, end } };
}

/**
 * `relPath`'s current logical line count — `util/countLines.ts` semantics,
 * the SAME count every range-serving read path mints its own `range` strings
 * against (a trailing newline is not a phantom extra line), so a whole-file
 * requirement of `1-<count>` is exactly satisfiable by a whole-file serve.
 * `undefined` when the file cannot be read or decoded.
 */
export function currentFileLineCount(workspace: string, relPath: string): number | undefined {
  const content = readCached(workspace, relPath);
  if (content === undefined) return undefined;
  return Math.max(1, countLines(content));
}

/** Candidate consumer files for a relation's `to` — prefer index-derived aliases (already real paths), else a file-shaped `to` term. */
export function relationConsumerCandidatePaths(
  workspace: string,
  universe: FindTextUniverse,
  item: RequestItem,
  toTerms: readonly string[],
): string[] {
  const aliasPaths = item.aliases.filter((alias) => alias.includes("/") || looksLikeFileTerm(alias));
  if (aliasPaths.length > 0) return productPathsFirst([...new Set(aliasPaths)]);
  const out = new Set<string>();
  for (const term of toTerms) {
    if (looksLikeFileTerm(term)) {
      for (const p of fileTermCandidatePaths(workspace, universe, term)) out.add(p);
    }
  }
  return productPathsFirst([...out]);
}

// ---------------------------------------------------------------------------
// DESIGN-v0.15 R1 finding-2 fix (2026-09-07): structural (never bare-
// substring) proof for relation/definition request items.
//
// A `relation` item used to be "proved" by ANY textual mention of the
// producer term anywhere in the consumer's served body — a comment, a TODO,
// a string literal — because `text.includes(term)` is a raw substring test
// over the whole window, and `sharesSignificantSubstring`'s containment
// short-circuit ignored its own `min` floor (fixed separately, in
// requestItems.ts). Design §4.1 forbids exactly this ("コメント中の言及
// だけでは呼出関係を証明しない"). The whole request-item proof pipeline is
// synchronous (`buildTaskExecutionContract`, several call sites up, has 8
// internal call sites and ~17 external ones this wave must not touch), so
// this is a regex/line-based scan rather than `tools/lexicalRanges.ts`'s
// tree-sitter-backed `collectLexicalSegments`/`segmentKindAt` (both async,
// which would force this whole call chain async) — cheap and conservative in
// the direction that matters: a comment or string-literal position is
// rejected even when it looks call-shaped (a "// TODO: call foo() later"
// comment must never count), and only a "(" call or an import/require
// specifier counts as a use — never a bare identifier mention.
// ---------------------------------------------------------------------------

export const HASH_COMMENT_LANGUAGES = new Set(["python", "ruby", "shell", "yaml", "toml"]);

export function isEscapedAt(line: string, index: number): boolean {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && line[i] === "\\"; i--) backslashes++;
  return backslashes % 2 === 1;
}

export function lineCommentMarkerIndex(line: string, language: string | undefined): number {
  const marker = language !== undefined && HASH_COMMENT_LANGUAGES.has(language) ? "#" : "//";
  for (let i = 0; i <= line.length - marker.length; i++) {
    if (line.startsWith(marker, i) && !isEscapedAt(line, i)) return i;
  }
  return -1;
}

/** True when `index` sits inside a single/double/backtick-quoted run of `line` (naive, unnested, per-line — good enough to keep a plain call/import scan off a string literal's contents). */
export function isInsideQuotesAt(line: string, index: number): boolean {
  let quote: string | undefined;
  for (let i = 0; i < index; i++) {
    const ch = line[i]!;
    if (quote === undefined) {
      if ((ch === "\"" || ch === "'" || ch === "`") && !isEscapedAt(line, i)) quote = ch;
    } else if (ch === quote && !isEscapedAt(line, i)) {
      quote = undefined;
    }
  }
  return quote !== undefined;
}

export function isIdentifierChar(c: string): boolean {
  return /[A-Za-z0-9_$]/.test(c);
}

/**
 * True when `term` occurs in `text` at a non-comment, non-string, call- or
 * import-shaped position: `term(` (a call) or a line that is import/require
 * -shaped and mentions `term` as a specifier. Never a bare mention.
 */
/**
 * True when `index` sits inside a `/regex/` literal on `line` — DESIGN-v0.15
 * R1 P1 fix (2026-09-07): the SOLE remaining consumer of
 * `isRegexLiteralStartAt`/`regexLiteralCloseIndex` above, now that the
 * declaration-extent lexer they were shared with is deleted. A miss here
 * can only mis-read one line of a call/import scan; it bounds no
 * declaration and proves no point by itself. Skips quoted spans first so a `/` inside a
 * string is never misread as a regex delimiter — naive/unnested, matching
 * `isInsideQuotesAt`'s own documented "good enough" scope just above.
 */
export function isInsideRegexLiteralAt(line: string, index: number): boolean {
  let i = 0;
  while (i < index) {
    const ch = line[i]!;
    if (ch === "\"" || ch === "'" || ch === "`") {
      const quote = ch;
      i++;
      while (i < line.length && line[i] !== quote) {
        if (line[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    if (ch === "/" && isRegexLiteralStartAt(line, i)) {
      const close = regexLiteralCloseIndex(line, i);
      if (index > i && index < close) return true;
      i = close + 1;
      continue;
    }
    i++;
  }
  return false;
}

/**
 * FIX-C2 (2026-09-21): the comment/string/regex-skipping scan skeleton
 * `isCallOrImportOccurrence` has always used, extracted VERBATIM so the
 * concern-status policy's "does this term live at a real CODE position?"
 * anchor (`concernCodeOnlyText` below) can reuse it instead of forking a
 * second, separately-tuned notion of "not in a comment". Behaviour is
 * unchanged for the original caller: the loop, the identifier-boundary
 * rejection, the quote/regex skips and the block-comment state machine are
 * the same statements in the same order; only the per-occurrence VERDICT
 * moved into `visit`.
 */
export function forEachCodePositionOccurrence(
  text: string,
  term: string,
  language: string | undefined,
  visit: (ctx: { rawLine: string; codePart: string; at: number }) => boolean,
): boolean {
  if (term.length === 0) return false;
  const lines = text.split(/\r\n|\r|\n/);
  let inBlockComment = false;
  for (const rawLine of lines) {
    let line = rawLine;
    if (inBlockComment) {
      const closeAt = line.indexOf("*/");
      if (closeAt < 0) continue;
      line = line.slice(closeAt + 2);
      inBlockComment = false;
    }
    const commentAt = lineCommentMarkerIndex(line, language);
    const codePart = commentAt >= 0 ? line.slice(0, commentAt) : line;
    let searchFrom = 0;
    for (;;) {
      const at = codePart.indexOf(term, searchFrom);
      if (at < 0) break;
      searchFrom = at + term.length;
      const before = at > 0 ? codePart[at - 1]! : "";
      const after = codePart[at + term.length] ?? "";
      if (isIdentifierChar(before) || isIdentifierChar(after)) continue;
      if (isInsideQuotesAt(codePart, at)) continue;
      if (isInsideRegexLiteralAt(codePart, at)) continue;
      if (visit({ rawLine, codePart, at })) return true;
    }
    const openAt = rawLine.indexOf("/*");
    if (openAt >= 0 && rawLine.indexOf("*/", openAt + 2) < 0) inBlockComment = true;
  }
  return false;
}

export function isCallOrImportOccurrence(text: string, term: string, language: string | undefined): boolean {
  return forEachCodePositionOccurrence(text, term, language, ({ rawLine, codePart, at }) => {
    const trailing = codePart.slice(at + term.length);
    const isCall = /^\s*\(/.test(trailing);
    const isImportShaped = /^\s*import\b/.test(rawLine.trimStart())
      || /\brequire\s*\(\s*["'][^"']*["']\s*\)/.test(rawLine)
      || /^\s*from\s+\S+\s+import\b/.test(rawLine)
      || /\bfrom\s+["'][^"']+["']\s*;?\s*$/.test(rawLine);
    return isCall || isImportShaped;
  });
}

export const JSON_KEY_TOKEN_RE = /"([A-Za-z0-9_.$-]{2,})"\s*:/gu;

export function jsonKeyTokens(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(JSON_KEY_TOKEN_RE)) out.add(m[1]!);
  return [...out];
}

export const DECLARED_IDENTIFIER_TOKEN_RE =
  /\b(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var|struct|fn|func|def)\s+([A-Za-z_][A-Za-z0-9_]*)\b/gu;

export function declaredIdentifierTokens(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(DECLARED_IDENTIFIER_TOKEN_RE)) out.add(m[1]!);
  return [...out];
}

/**
 * A definition candidate is proved only by a genuine KEY/IDENTIFIER TOKEN
 * relating to the request — a JSON object key for a manifest-shaped file, a
 * declared identifier name for code — never a raw substring hunt over the
 * whole served body (a description sentence sharing a long character run
 * with an unrelated identifier is not a definition).
 */
export function definitionKeyTokensOf(path: string, text: string): string[] {
  return /\.jsonc?$/iu.test(path) ? jsonKeyTokens(text) : declaredIdentifierTokens(text);
}

/**
 * Review finding 2(a) fix (2026-09-08): a simple trailing "s"/"es" strip —
 * never real morphology, just the one shape design §4.2's own counter-example
 * needs ("tests" vs a served `src/cache.test.ts`) — so a stem only ever
 * WIDENS what counts as evidenced, never narrows a genuine absence: the stem
 * is always a PREFIX of the original word, so anywhere the full word would
 * have matched, the stem still does.
 */
export function stemForAbsenceCheck(word: string): string {
  const lower = word.toLowerCase();
  if (lower.length > 4 && lower.endsWith("es")) return lower.slice(0, -2);
  if (lower.length > 3 && lower.endsWith("s") && !lower.endsWith("ss")) return lower.slice(0, -1);
  return lower;
}

/**
 * Adversarial review 2 finding 3 (2026-09-08): `sharesAlphabeticPrefix`'s
 * fixed 5-character PREFIX rule is retired in favour of exact STEM equality.
 * A prefix rule over-suppresses whenever a short, common served token is
 * itself a leading prefix of a longer, unrelated request word — "const" (5
 * letters) is a prefix of "constant"; "entry" is a prefix of "entryway" —
 * and a prefix check has no way to tell "the same root, spelled differently"
 * from "an unrelated longer word that merely starts the same way". Requiring
 * the STEMS to match EXACTLY (both words reduced the same way, then compared
 * whole, not just their leading run) keeps the one shape design §4.2 needs
 * ("expiry"/"expiresAt" both stem to "expir") while correctly separating
 * "constant" (stem "constant") from "const" (stem "const") and "entryway"
 * (stem "entrywa") from "entry" (stem "entr") — none of those four pairs
 * share a stem. A minimum stem length of 4 keeps very short residual stems
 * (e.g. "at" left over from splitting "expiresAt") from matching anything.
 */
export const SALIENT_WORD_EVIDENCE_STEM_MIN = 4;

/**
 * Splits an identifier/path/plain-word token into its component WORDS: every
 * maximal ASCII-letter run (a non-letter — dot, underscore, hyphen, digit,
 * slash — is already a separator, so snake_case/kebab-case/dotted paths need
 * no extra handling), further cut at a camelCase/PascalCase boundary
 * (lower-or-digit -> upper, or an uppercase run followed by a Titlecase
 * word) — "expiresAt" -> ["expires","At"], "cache.test.ts" ->
 * ["cache","test","ts"], "HTTPServer" -> ["HTTP","Server"]. Never reorders
 * or drops letters within a word.
 */
export const splitIdentifierWords = boundedTextMemo((text: string): readonly string[] => {
  const words: string[] = [];
  for (const run of text.match(/[A-Za-z]+/gu) ?? []) {
    const cut = run
      .replace(/([a-z0-9])([A-Z])/gu, "$1\0$2")
      .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1\0$2");
    for (const part of cut.split("\0")) {
      if (part.length > 0) words.push(part);
    }
  }
  return words;
});

/**
 * A light, general (never dictionary-based) single-pass suffix strip, one
 * rule firing at most once, checked in this fixed order: "ies"->"y"
 * ("studies"->"study"), "es", "s" (never a doubled "ss"), "ed", "ing", "er",
 * bare trailing "y" ("expiry"->"expir", matching "expires"->"expir" via the
 * "es" rule above it). Not real morphology — just enough to relate a handful
 * of common EN inflections the same way on both sides of a comparison
 * without a hand-maintained word list. Each length guard keeps the residual
 * stem non-empty-ish (never strips a suffix off a word barely longer than
 * the suffix itself).
 */
export function lightStem(rawWord: string): string {
  const w = rawWord.toLowerCase();
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && w.endsWith("es")) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  if (w.length > 4 && w.endsWith("ed")) return w.slice(0, -2);
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith("er")) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("y")) return w.slice(0, -1);
  return w;
}

/**
 * Bare language keywords a served surface's tokenization will turn up in
 * almost any JS/TS file, carrying no project-specific meaning of their own —
 * belt-and-suspenders alongside exact-stem-equality above, and alongside
 * `GENERIC_SOFTWARE_ABSENCE_WORDS` (below: the Tier C absence-candidate
 * exclusion list, reused here per review finding 3 rather than duplicated —
 * "function"/"class"/"value"/"type"/"data" already live there) for the
 * handful of pure syntax keywords that list has no reason to also carry.
 */
export const SALIENT_WORD_EVIDENCE_KEYWORD_TOKENS: ReadonlySet<string> = new Set([
  "const", "let", "var", "function", "return", "class", "interface", "enum",
  "import", "export", "extends", "implements", "new", "this", "null",
  "undefined", "true", "false", "void", "async", "await", "try", "catch",
  "finally", "throw", "switch", "case", "break", "continue", "instanceof",
  "typeof", "yield", "static", "public", "private", "protected", "readonly",
  "abstract", "super", "delete", "package", "namespace",
]);

/** True when `token` (already lowercased by the caller's comparison, but accepted either case here) must never evidence anything, however its stem compares. */
export function isSalientWordEvidenceExcludedToken(token: string): boolean {
  const lower = token.toLowerCase();
  return SALIENT_WORD_EVIDENCE_KEYWORD_TOKENS.has(lower) || GENERIC_SOFTWARE_ABSENCE_WORDS.has(lower);
}
