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
 */

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

function tokenizeIdentifierMode(query: string, minLen: number, stopWords: ReadonlySet<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  function add(tok: string): void {
    const t = tok.trim();
    if (t.length < minLen) return;
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

  // Distinctive-first: longer, non-generic, identifier-shaped tokens sort first.
  out.sort((a, b) => scoreTokenDistinctiveness(b) - scoreTokenDistinctiveness(a));
  return out;
}

function tokenizeSimpleMode(query: string, minLen: number, stopWords: ReadonlySet<string>): string[] {
  const raw = query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 0);
  return [...new Set(raw.filter((t) => t.length >= minLen && !stopWords.has(t)))];
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
