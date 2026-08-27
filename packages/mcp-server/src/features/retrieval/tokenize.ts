/**
 * retrieval/tokenize.ts — V10-08 Hybrid Retrieval v1: tokenization.
 *
 * DESIGN-v0.10-expansion-plan-v1.3.md V10-08: "camel/snake/kebab分解、error
 * code、string literal、test nameをfieldとして扱う。" Dependency-free by
 * construction (AGENTS.md's license gate forbids a new npm dependency for
 * this feature) — decomposition + free-text tokenization in well under 100
 * lines of hand-rolled logic, mirroring the decomposition regex
 * locateTaskContext.ts's own splitBasenameTokens already uses for basenames,
 * generalized to kebab-case and consecutive-caps acronyms.
 */
import { extractCjkTokens, MAX_CJK_TOKENS } from "../../util/cjkSpans.js";

/**
 * Small stop-word list — filtered out of DECOMPOSED sub-tokens only, never
 * out of a whole error-code/quoted token. Deliberately EXCLUDES negations
 * ("not"/"no") and similar — those flip meaning in code identifiers
 * ("NotFound" vs "Found", "noCache" vs "cache") in a way plain-English
 * filler words do not.
 */
const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "in", "on", "of", "to", "for",
  "with", "is", "are", "was", "were", "be", "been", "this", "that", "it",
  "as", "at", "by", "from", "into", "than", "then", "so",
]);

/**
 * True for a token shaped like an error/status code kept whole in addition to
 * its decomposed parts — "ERR_NOT_FOUND", "E1234", "TL-1234".
 */
export function isErrorCodeToken(token: string): boolean {
  return /^[A-Z][A-Z0-9]*(?:[_-][A-Z0-9]+)+$/.test(token) || /^[A-Z]{1,4}\d{2,}$/.test(token);
}

/**
 * Split one identifier-shaped token into lowercase sub-words on camelCase,
 * PascalCase, snake_case, kebab-case, consecutive-caps-acronym, and
 * letter/digit boundaries: "contentSufficiency" / "content_sufficiency" /
 * "content-sufficiency" all yield ["content", "sufficiency"];
 * "getHTTPStatus" yields ["get", "http", "status"].
 */
export function decomposeIdentifier(raw: string): string[] {
  const widened = raw
    .replace(/([a-zA-Z])(\d)/g, "$1 $2")
    .replace(/(\d)([a-zA-Z])/g, "$1 $2")
    // Acronym boundary: "HTTPServer" -> "HTTP Server"; "IOError" -> "IO Error".
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    // lower/digit -> Upper boundary: "contentSufficiency" -> "content Sufficiency".
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return widened
    .split(/[_\-\s.\/\\:]+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length > 0);
}

/**
 * The pre-CJK tokenizeText, unchanged in behavior, renamed: words and
 * identifier-shaped runs are decomposed; quoted-string contents recurse
 * (kept AND decomposed, since a queried string literal must match both as a
 * phrase and by its component words); error-code-shaped tokens are kept
 * whole (lowercased) in addition to their decomposed parts. ASCII-only by
 * construction (every pattern below is [A-Za-z0-9_-]-shaped) — a CJK
 * character simply never matches any alternative here, which is exactly
 * what keeps this helper byte-identical before and after the CJK addition
 * below.
 */
function tokenizeAsciiWords(text: string, opts: { keepStopWords?: boolean }): string[] {
  const out: string[] = [];
  const wordPattern = /"([^"]{1,80})"|'([^']{1,80})'|[A-Za-z][A-Za-z0-9_-]*|\d+/g;
  let m: RegExpExecArray | null;
  while ((m = wordPattern.exec(text)) !== null) {
    const quoted = m[1] ?? m[2];
    if (quoted !== undefined) {
      out.push(...tokenizeAsciiWords(quoted, opts));
      continue;
    }
    const word = m[0];
    if (isErrorCodeToken(word)) out.push(word.toLowerCase());
    for (const sub of decomposeIdentifier(word)) {
      if (!opts.keepStopWords && STOP_WORDS.has(sub)) continue;
      out.push(sub);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// CJK (Han/Hiragana/Katakana) span extraction now lives in the shared
// util/cjkSpans.ts (imported above) — factored out so util/queryShape.ts's
// tokenizeIdentifierMode/tokenizeSimpleMode and
// features/locator/locateTaskContext.ts's identifierTokensIn get the
// IDENTICAL CJK treatment instead of a second, independently-drifting
// partial reimplementation. See that module's own comment for the full
// design rationale (script-separated runs, bigrams, Han unigrams, the JA
// stopword set, the token cap) — this file's own tokenizeText behavior is
// UNCHANGED by the move. MAX_CJK_TOKENS is re-exported below so existing
// importers of tokenize.js's own MAX_CJK_TOKENS are unaffected.
// ---------------------------------------------------------------------------

export { MAX_CJK_TOKENS };

/**
 * Tokenize free text (doc/body/signature fields and query text): ASCII
 * words/identifiers/quoted-strings/error-codes (tokenizeAsciiWords), THEN
 * any CJK (Han/Hiragana/Katakana) runs found anywhere in `text`
 * (extractCjkTokens) — see each function's own comment above. Pure-ASCII
 * input is byte-identical to the pre-CJK tokenizer: extractCjkTokens
 * matches nothing and appends zero tokens.
 */
export function tokenizeText(text: string, opts: { keepStopWords?: boolean } = {}): string[] {
  return [...tokenizeAsciiWords(text, opts), ...extractCjkTokens(text, opts)];
}

/** Dedup'd query tokenization — the term set a ranker matches units against. */
export function tokenizeQuery(query: string): string[] {
  return [...new Set(tokenizeText(query))];
}

// ---------------------------------------------------------------------------
// V11-02 (Task-aware Weighted RRF v2): query normalization into identifier /
// path / error-code buckets. Purely ADDITIVE — every export above is
// unchanged, so flag-off callers (which never call normalizeQuery) see
// byte-identical tokenization. Consumed by taskFamily.ts's classifier;
// `allTokens` is exactly tokenizeQuery(query)'s own output, so this is a
// strict superset of information, never a divergent tokenization path.
// ---------------------------------------------------------------------------

/**
 * Word-shaped span matcher re-derived (not shared) from tokenizeText's own
 * `wordPattern` identifier alternative — kept as its own small regex here so
 * this additive classification helper can never perturb tokenizeText's
 * byte-for-byte output by construction.
 */
const WORD_SPAN_RE = /[A-Za-z][A-Za-z0-9_-]*/g;

/** A path-shaped span: 2+ "/"- or "\\"-separated segments, or a bare "name.ext" filename. Structural (shape-only), never a filesystem existence check. */
const PATH_SPAN_RE = /[A-Za-z0-9_.-]+(?:[\/\\][A-Za-z0-9_.-]+)+|\b[A-Za-z0-9_-]+\.[A-Za-z]{1,10}\b/g;

export interface NormalizedQuery {
  /** Decomposed identifier sub-tokens, MINUS anything already claimed by a path or error-code span below — a clean "everything else" bucket for classification. */
  identifierTokens: string[];
  /** Raw path-shaped spans found in the query, as whole strings (e.g. "docs/GUIDE.md") — not sub-split, so extension/shape checks stay simple. */
  pathTokens: string[];
  /** Raw error/status-code-shaped spans, lowercased (matches tokenizeText's own isErrorCodeToken handling). */
  errorCodeTokens: string[];
  /** The full deduplicated token set — identical to tokenizeQuery(query) for any input; this is what actually feeds BM25F term generation. */
  allTokens: string[];
  /**
   * Wave C (F-A5, graphRetriever.ts): raw, CASE-PRESERVING, UNDECOMPOSED
   * identifier-shaped spans found in the query text — e.g. a query
   * containing "reserveStock" yields the whole span "reserveStock", not the
   * decomposed/lowercased ["reserve", "stock"] identifierTokens already
   * carries. This exists because GraphIndex.definition()/.references()
   * (graph/index.ts) key their lookup maps by the symbol's exact, real
   * (un-decomposed, case-sensitive) name — a query that names a real
   * declaration verbatim (the natural way to ask "what calls X" or "who
   * references Y") is only matchable against the graph via THIS bucket;
   * identifierTokens' decomposed sub-words can never reconstruct a
   * multi-word identifier's exact original spelling. Deduplicated
   * (case-sensitively — "Foo" and "foo" are different spans), order-
   * preserving, filtered to length >= 2, capped at MAX_IDENTIFIER_SPANS.
   * Every other field above is UNCHANGED by this addition — purely
   * additive, so a caller that never reads this field observes the exact
   * pre-existing behavior.
   */
  identifierSpans: string[];
}

/**
 * Identifier-shaped span matcher: letters/digits/underscore, not starting
 * with a digit — the shape a real TS/JS/Go/Python/Java identifier takes.
 * Deliberately narrower than WORD_SPAN_RE above (which also accepts
 * hyphens, for THAT regex's own path/error-code-scanning purpose): a
 * hyphen can never appear inside a real source-level identifier, so
 * including it here would only ever produce a guaranteed-miss graph lookup
 * key.
 */
const IDENTIFIER_SPAN_RE = /[A-Za-z_][A-Za-z0-9_]*/g;

/** Bounds identifierSpans — queries are short free text, so this is a defensive cap, not an expected-to-bind limit. */
const MAX_IDENTIFIER_SPANS = 24;

/** Decompose a free-text query into identifier / path-like / error-code token buckets, feeding BM25F term generation and taskFamily.ts's structural classification (V11-02). */
export function normalizeQuery(query: string): NormalizedQuery {
  const allTokens = tokenizeQuery(query);
  const errorCodeTokens = [
    ...new Set((query.match(WORD_SPAN_RE) ?? []).filter(isErrorCodeToken).map((t) => t.toLowerCase())),
  ];
  const pathTokens = [...new Set(query.match(PATH_SPAN_RE) ?? [])];
  const claimed = new Set<string>([...errorCodeTokens, ...pathTokens.flatMap((p) => decomposeIdentifier(p))]);
  const identifierTokens = allTokens.filter((t) => !claimed.has(t));
  const identifierSpans = [...new Set(query.match(IDENTIFIER_SPAN_RE) ?? [])]
    .filter((s) => s.length >= 2)
    .slice(0, MAX_IDENTIFIER_SPANS);
  return { identifierTokens, pathTokens, errorCodeTokens, allTokens, identifierSpans };
}
