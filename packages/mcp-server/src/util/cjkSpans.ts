// util/cjkSpans.ts — shared CJK (Han/Hiragana/Katakana) run extraction.
//
// Factored out of retrieval/tokenize.ts (field-report fix, 2026-08-27) so
// every ASCII-only free-text tokenizer in this package gets the identical
// CJK treatment instead of drifting into independent, partial reimplementa-
// tions. Known consumers as of this writing:
//   - features/retrieval/tokenize.ts's tokenizeText (BM25F query + content
//     fields: doc/body/signature/markdown/config — see units.ts).
//   - util/queryShape.ts's tokenizeIdentifierMode/tokenizeSimpleMode (feeds
//     readCodeTaskPack.ts's significantQueryTokens/concernAnchorTokens route-
//     honesty check, and findText.ts's own find-fallback tokenizer).
//   - features/locator/locateTaskContext.ts's identifierTokensIn (body-
//     content tokenization for the non-hybrid heuristic's filename-match
//     symbol refinement).
//
// This module intentionally has ZERO dependents in the other direction: it
// exists in util/ specifically so a feature module (retrieval) and a peer
// util module (queryShape) and another feature module (locator) can all
// depend on it without any one of them depending on another's internals.
//
// Standard CJK IR practice, no dictionary/morphology available:
//   - Runs are extracted separately per script; a script transition always
//     ends a run ("テレメトリの" is katakana-run "テレメトリ" + hiragana-run
//     "の", never fused into one run) — word boundaries in Japanese do not
//     track ASCII whitespace, and a script change is the cheapest reliable
//     proxy available without a dictionary.
//   - Every run also emits its own full text as one token, so a short run,
//     or an exact compound match, scores as a single unit.
//   - Every run of length >= 2 emits overlapping character bigrams, so a
//     query sharing only PART of a longer compound still gets partial
//     credit — the standard fallback for a language with no whitespace
//     word boundaries.
//   - Han additionally emits per-character unigrams (length floor 1): a
//     single kanji is frequently meaningful on its own (語, 用, 態, …). Kana
//     does NOT get unigrams — a lone kana character is overwhelmingly a
//     grammatical particle, not a content word; kana relies on its bigrams
//     plus the whole-run token above.
//   - A small, deliberately narrow stopword set drops a handful of
//     extremely common kana FUNCTION WORDS so a particles-only run
//     contributes nothing. Single-particle CHARACTERS (は/が/を/に/で/と/の/
//     …) are deliberately NOT blacklisted here: BM25's own IDF already
//     drives a term common across most documents to ~zero weight
//     (bm25f.ts's `idf <= 0` skip), a substring-containment matcher only
//     ever gets MORE precise from extra candidate tokens (never less), and
//     a hand-maintained single-character blacklist risks the exact
//     false-negative this fix exists to close.

/** CJK Unified Ideographs (一-鿿) + Extension A (㐀-䶿). */
export const HAN_RUN_RE = /[㐀-䶿一-鿿]+/g;
/** Hiragana block (぀-ゟ). */
export const HIRAGANA_RUN_RE = /[぀-ゟ]+/g;
/** Katakana block (゠-ヿ) + halfwidth katakana (ｦ-ﾟ). */
export const KATAKANA_RUN_RE = /[゠-ヿｦ-ﾟ]+/g;

/** Minimal JA function-word stopword set for CJK tokens — word-shaped (2+ chars) only; see the module comment above for why single kana particles are deliberately left out. */
export const JA_STOP_WORDS = new Set([
  "する", "ある", "いる", "こと", "もの", "ため", "これ", "それ", "この", "その",
  "ください", "します", "される", "など",
]);

/**
 * Hard cap on CJK-derived tokens per extractCjkTokens() call. A run's token
 * count runs roughly 2-3x its character count once unigrams/bigrams/the
 * full run are all counted, versus roughly one token per ~5 characters for
 * whitespace-delimited ASCII words — so unbounded CJK prose (a large pasted
 * document used as a query; a large machine-generated comment) inflates
 * postings/query-term counts far more per input byte than the ASCII path
 * ever could. Sized generously above any realistic single doc/body/query
 * field: retrieval/units.ts's own MAX_BODY_CHARS already caps indexed
 * body/config text at 600 characters before it ever reaches a tokenizer, so
 * this mainly protects free-text QUERY input, which carries no such
 * upstream cap.
 */
export const MAX_CJK_TOKENS = 400;

/** Push `run`'s own text, its per-character unigrams (if `unigrams`), then its overlapping bigrams — each dropped when it exactly matches a JA_STOP_WORDS entry (unless `keepStopWords`). */
function pushCjkRunTokens(out: string[], run: string, unigrams: boolean, keepStopWords: boolean | undefined): void {
  if (keepStopWords || !JA_STOP_WORDS.has(run)) out.push(run);
  if (unigrams) {
    for (const ch of run) out.push(ch);
  }
  for (let i = 0; i + 1 < run.length; i++) {
    const bigram = run.slice(i, i + 2);
    if (keepStopWords || !JA_STOP_WORDS.has(bigram)) out.push(bigram);
  }
}

/**
 * Extract Han/Hiragana/Katakana run tokens from `text` — see the module
 * comment above. Linear in text length: three single-pass regex scans, no
 * nested quantifiers or backtracking-prone alternation.
 */
export function extractCjkTokens(text: string, opts: { keepStopWords?: boolean } = {}): string[] {
  const out: string[] = [];
  const scripts: Array<[RegExp, boolean]> = [
    [HAN_RUN_RE, true],
    [HIRAGANA_RUN_RE, false],
    [KATAKANA_RUN_RE, false],
  ];
  for (const [re, unigrams] of scripts) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      pushCjkRunTokens(out, m[0], unigrams, opts.keepStopWords);
      if (out.length >= MAX_CJK_TOKENS) return out.slice(0, MAX_CJK_TOKENS);
    }
  }
  return out;
}
