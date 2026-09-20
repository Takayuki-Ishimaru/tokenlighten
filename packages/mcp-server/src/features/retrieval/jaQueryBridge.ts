// jaQueryBridge.ts — Japanese -> identifier QUERY BRIDGE (TL_JA_QUERY_BRIDGE;
// (S) supported first-pack policy, default ON since 2026-09-19 (USER ruling);
// explicit `=0` is the rollback path; see util/flags.ts's jaQueryBridgeEnabled).
// Pure, deterministic,
// zero I/O: every export here is a plain function of its arguments, with no
// filesystem/network access and no dependency on process state. The
// workspace-scoped vocabulary CACHE (which does need to walk/read the repo)
// lives in the separate jaBridgeWorkspaceVocab.ts precisely so this module
// can stay zero-I/O and trivially unit-testable.
//
// Problem this closes (measured by a sibling agent, first pack, default
// flags): a Japanese query shares no lexical token with an English-only
// codebase, so ja_single_xling / ja_katakana_xling / ja_multi_xling eval
// classes score far below ja_en_ident (a Japanese query that already embeds
// a literal English identifier, which the existing ASCII path already
// finds). This module bridges that gap two ways:
//   1. Katakana loanword -> English identifier, via a consonant-class
//      phonetic skeleton compared against the WORKSPACE's own vocabulary
//      (jaPhonetic.ts) -- "キャンセル" matches "cancel" because both reduce
//      to the same K.N.S.R skeleton, not because of any dictionary. A
//      compound run (クーポンコード) is dynamic-programmed into segments,
//      each resolved either phonetically or via a curated short-katakana
//      glossary entry (jaGlossary.ts) for loanwords too short to trust
//      phonetically on their own (エラー, コード, ...).
//   2. Kanji/kana general vocabulary -> English stems, via the same
//      longest-match glossary -- "注文" -> "order" -- gated on the stem
//      actually being present in the workspace vocabulary.
//
// Expansions are ORDINARY LEXICAL TERMS, appended after everything the
// existing pipeline already derived from the literal query text. They are
// deliberately never treated as explicit/verbatim identifiers: this module
// never sees, and never produces, anything resembling
// readCodeTaskPack.ts's explicitCodeIdentifiers output, and the one call
// site that consumes bridgeJaQuery's result (locateTaskContext.ts's
// extractIdentifiers) appends expansion tokens to its own local `tokens`
// array only -- never to the raw query string that explicitCodeIdentifiers
// independently re-derives its own evidence from. See that call site's own
// comment for the isolation argument.
import {
  englishFirstVowel,
  englishToClassKeys,
  katakanaToRomaji,
  levenshteinDistance,
  romajiFirstVowel,
  romajiToClassKeys,
  stripEpentheticVowels,
  vowelGroupCount,
} from "./jaPhonetic.js";
import { JA_GLOSSARY } from "./jaGlossary.js";
import { HAN_RUN_RE, HIRAGANA_RUN_RE, KATAKANA_RUN_RE } from "../../util/cjkSpans.js";

/** Non-global (safe for repeated .test()) presence check for any Han/Hiragana/Katakana character -- rebuilt from the shared cjkSpans.ts run patterns so this module carries no independent script-range table to drift out of sync. */
const JAPANESE_PRESENCE_RE = new RegExp(`${HAN_RUN_RE.source}|${HIRAGANA_RUN_RE.source}|${KATAKANA_RUN_RE.source}`);

/** True iff `text` contains at least one Han, Hiragana, or Katakana character. Every other export in this module is a no-op when this is false, per the design's "zero work for non-Japanese queries" requirement. */
export function containsJapanese(text: string): boolean {
  return JAPANESE_PRESENCE_RE.test(text);
}

function extractKatakanaRuns(text: string): string[] {
  const re = new RegExp(KATAKANA_RUN_RE.source, "g");
  const runs: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[0].length >= 2) runs.push(m[0]);
  }
  return runs;
}

// ---------------------------------------------------------------------------
// Vocabulary: precomputed key -> words map over the caller-supplied word
// list (the workspace's own identifier/path-segment/content vocabulary --
// see jaBridgeWorkspaceVocab.ts for how that list is actually gathered/
// cached).
// ---------------------------------------------------------------------------

/** Bounds vocabulary size (design cap) -- protects both the one-time build cost and the katakana-key/glossary-stem lookup tables from an unbounded monorepo. */
export const MAX_VOCAB_WORDS = 20_000;

/**
 * Generic English function words and cross-language programming keywords
 * that must never be admitted as a bridge target, regardless of source
 * (path segment or file content) -- orchestrator Phase 2 requirement: a
 * content scan of real source files pulls in "return"/"const"/"class"/...
 * constantly, and none of them is ever what a Japanese query's glossary
 * stem or katakana match should resolve to.
 *
 * General knowledge, not fixture-derived, and deliberately cross-checked
 * against every stem in jaGlossary.ts so this list can never silently
 * disable a real glossary entry: words that are BOTH common English/
 * keyword-shaped AND a legitimate glossary target (state, log, get, list,
 * role, type, pass, error, item, name, set, view, ...) are intentionally
 * left OFF this list.
 */
const COMMON_WORD_STOPLIST: ReadonlySet<string> = new Set([
  // English function words / pronouns / conjunctions.
  "the", "and", "for", "with", "this", "that", "from", "an", "or", "but",
  "if", "in", "on", "of", "to", "is", "are", "was", "were", "be", "been",
  "it", "as", "at", "by", "into", "than", "then", "so", "not", "have",
  "has", "had", "will", "would", "should", "can", "could", "may", "might",
  "must", "shall", "when", "where", "which", "what", "how", "who", "why",
  "its", "our", "their", "your", "out", "also", "any", "all", "some",
  "each", "both", "being", "more", "most", "other", "such", "only", "own",
  "same", "too", "very", "just", "about", "you", "they", "them", "these",
  "those", "self", "super", "new",
  // Cross-language programming keywords (TS/JS/Python/Java/Go/Rust/C++;
  // general knowledge).
  "return", "const", "let", "var", "function", "import", "export", "class",
  "public", "private", "protected", "static", "void", "null", "undefined",
  "true", "false", "string", "number", "boolean", "object", "array",
  "interface", "extends", "implements", "namespace", "readonly",
  "abstract", "override", "async", "await", "yield", "typeof",
  "instanceof", "throw", "catch", "finally", "switch", "case", "default",
  "break", "continue", "def", "elif", "lambda", "raise", "except",
  "global", "nonlocal", "struct", "impl", "trait", "pub", "mod", "unsafe",
  "mut", "template", "virtual", "package", "module", "using", "include",
  "define", "ifdef", "endif",
]);

export interface JaBridgeVocabulary {
  /** Consonant-class key (dot-joined, e.g. "K.N.S.R") -> matching vocabulary words. */
  readonly keyToWords: ReadonlyMap<string, readonly string[]>;
  /** Exact (case-insensitive) whole-word membership. */
  hasWord(word: string): boolean;
  /** True iff `stem` (length >= 4) is itself a vocabulary word, or a prefix of one -- the glossary admission rule ("valid" -> "validate", "validation"). Stems shorter than 4 are accepted only via exact hasWord, never as a prefix (too many accidental matches otherwise). */
  hasStemPrefix(stem: string): boolean;
  /** True iff this vocabulary was built under a bound (file/word cap or wall-clock budget) that cut the scan short -- see jaBridgeWorkspaceVocab.ts. Informational only (surfaced on the `ja_bridge` trace event); never changes matching behavior. */
  readonly partial: boolean;
}

/** Precompute a `JaBridgeVocabulary` from a plain word list (already split on camelCase/snake/kebab and lowercased by the caller -- see the design's item 4/6). Deterministic given the same input order; the caller is responsible for making that order itself deterministic if cross-call stability matters (jaBridgeWorkspaceVocab.ts sorts its walk output before calling this). Cacheable: pure function of `words`, holds no reference to its input beyond the words themselves. */
export function buildJaBridgeVocabulary(words: Iterable<string>, opts: { partial?: boolean } = {}): JaBridgeVocabulary {
  const wordSet = new Set<string>();
  for (const raw of words) {
    if (wordSet.size >= MAX_VOCAB_WORDS) break;
    const w = raw.toLowerCase().trim();
    if (w.length < 3 || !/^[a-z][a-z0-9]*$/.test(w)) continue;
    if (COMMON_WORD_STOPLIST.has(w)) continue;
    wordSet.add(w);
  }

  const keyToWords = new Map<string, string[]>();
  for (const w of wordSet) {
    for (const key of englishToClassKeys(w)) {
      let list = keyToWords.get(key);
      if (!list) { list = []; keyToWords.set(key, list); }
      if (!list.includes(w)) list.push(w);
    }
  }
  // Deterministic per-key ordering regardless of the input iteration order.
  for (const list of keyToWords.values()) list.sort();

  const sortedWords = [...wordSet].sort();

  function hasStemPrefix(stem: string): boolean {
    const s = stem.toLowerCase();
    if (wordSet.has(s)) return true;
    if (s.length < 4) return false;
    let lo = 0;
    let hi = sortedWords.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (sortedWords[mid]! < s) lo = mid + 1;
      else hi = mid;
    }
    return lo < sortedWords.length && sortedWords[lo]!.startsWith(s);
  }

  return {
    keyToWords,
    hasWord: (word: string) => wordSet.has(word.toLowerCase()),
    hasStemPrefix,
    partial: opts.partial ?? false,
  };
}

// ---------------------------------------------------------------------------
// Glossary (kanji/kana/short-katakana -> stems), and the exact-match map a
// compound segment can hit directly (see matchCompoundRun below).
// ---------------------------------------------------------------------------

/** Longest-term-first scan order for glossaryLongestMatchScan, computed once at module load. */
const GLOSSARY_SORTED: ReadonlyArray<readonly [string, readonly string[]]> =
  [...JA_GLOSSARY].sort((a, b) => b[0].length - a[0].length);

/** O(1) exact-term lookup for compound segmentation. A kanji/kana entry can never match a katakana run substring (disjoint Unicode blocks), so including the whole glossary here is harmless -- only the short-katakana entries ever actually hit. */
const GLOSSARY_EXACT_MAP: ReadonlyMap<string, readonly string[]> = new Map(JA_GLOSSARY);

function glossaryLongestMatchScan(query: string): Array<{ term: string; stems: readonly string[] }> {
  const hits: Array<{ term: string; stems: readonly string[] }> = [];
  let i = 0;
  while (i < query.length) {
    let matchedLen = 0;
    for (const [term, stems] of GLOSSARY_SORTED) {
      if (query.startsWith(term, i)) {
        hits.push({ term, stems });
        matchedLen = term.length;
        break;
      }
    }
    i += matchedLen > 0 ? matchedLen : 1;
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Katakana matching: a run resolves via a TWO-PASS DP over KATAKANA
// CHARACTER positions (see matchCompoundRun's own doc for why segment count
// alone is not a safe objective -- orchestrator Phase 4, Defect 1a). Pass 1
// looks for a full cover using ONLY exact short-katakana glossary segments;
// if one exists it wins outright, no phonetic segment is even attempted for
// that run. Pass 2 (glossary-or-phonetic per segment, run only when pass 1
// found nothing) prefers more glossary content, then fewer segments. A
// plain single-word run is just the degenerate 1-segment cover either pass
// can find -- one mechanism covers "キャンセル" (1 segment, pass 2),
// "クーポンコード" (2 glossary segments, pass 1), and "エラーコード" (2
// glossary segments, pass 1 -- which is what keeps it from ever being
// tried as a 1-segment phonetic match against an unrelated word).
// ---------------------------------------------------------------------------

const MIN_KEY_CLASSES_ACCEPT = 2;
const MIN_KEY_CLASSES_AUTO = 3;
const MAX_WORDS_PER_RUN = 3;
/** Generous character bound on one DP segment -- large enough that the longest realistic single loanword (e.g. 11-character ノーティフィケーション) is still tried as ONE whole-span segment, while still keeping the O(n * cap) search trivially cheap. */
const MAX_COMPOUND_SEGMENT_CHARS = 24;

function keyClassCount(key: string): number {
  return key.split(".").length;
}

function collectKeyMatches(key: string, vocab: JaBridgeVocabulary, into: Set<string>): void {
  const classCount = keyClassCount(key);
  if (classCount < MIN_KEY_CLASSES_ACCEPT) return; // 1-class keys: never accepted, too ambiguous
  const words = vocab.keyToWords.get(key);
  if (!words || words.length === 0) return;
  if (classCount < MIN_KEY_CLASSES_AUTO) {
    if (words.length !== 1) return; // 2-class key: only when exactly one vocab word matches
    into.add(words[0]!);
    return;
  }
  for (const w of words) into.add(w); // >=3 classes: every match is trusted
}

/** A whole-run phonetic match this short is trusted on the class key plus vowel-tier/Levenshtein alone; see PLAUSIBILITY_MIN_RUN_CHARS's own doc for why longer runs need one more, independent check. */
const PLAUSIBILITY_MIN_RUN_CHARS = 5;

/**
 * Phonetic match for ONE katakana segment: tries every branch-variant key
 * (not just the primary alternative), so a branch-dependent word like
 * "feature" (FH.S -- the SECOND "chi/cha" alternative, not the primary T)
 * is never lost.
 *
 * `wholeRun` (orchestrator Phase 4, 2026-09-19 -- Defect 1b): true only when
 * this segment is the ENTIRE katakana run (matchCompoundRun's start===0,
 * end===n case), never a sub-segment of a multi-segment compound. A
 * consonant-class key can accidentally equate two semantically unrelated
 * words ("erakoodo" and "record" both key to the same skeleton); for a run
 * long enough to plausibly BE a real compound (>= 5 characters) that also
 * has more than one candidate at its key (a genuine ambiguity, not a lone
 * match nothing else could confirm or deny), require the candidate's own
 * vowel-GROUP count (a maximal run of vowel letters = one group) to equal
 * the run's OWN group count, computed on the epenthetic-stripped romaji.
 * This is deliberately STRICT (equality, not "close enough"): applied only
 * to genuine multi-candidate collisions, it never touches a run's single,
 * uncontested candidate (every other >=5-character sanity pair in this
 * module's own vocabulary is alone at its key and passes through
 * unfiltered), while it does reject a same-key, different-shape intruder
 * ("shortages"/"charts" both survive the existing vowel-tier/Levenshtein
 * tiebreak against "status" well enough to place in the top 3 without this
 * check -- see the report's full pair table). If the filter would remove
 * every candidate (a pathological all-different-shape collision), it is
 * skipped rather than returning nothing.
 */
function phoneticSegmentWords(kanaSegment: string, vocab: JaBridgeVocabulary, wholeRun: boolean): string[] | undefined {
  const romaji = katakanaToRomaji(kanaSegment);
  if (!romaji) return undefined;
  const candidates = new Set<string>();
  for (const key of romajiToClassKeys(romaji)) collectKeyMatches(key, vocab, candidates);
  if (candidates.size === 0) return undefined;

  if (wholeRun && kanaSegment.length >= PLAUSIBILITY_MIN_RUN_CHARS && candidates.size > 1) {
    const runGroups = vowelGroupCount(stripEpentheticVowels(romaji));
    const plausible = [...candidates].filter((w) => vowelGroupCount(w) === runGroups);
    if (plausible.length > 0) return plausible;
  }
  return [...candidates];
}

/** Glossary match for ONE katakana segment (short-katakana entries -- エラー, コード, ...): exact term lookup, then the ordinary workspace-vocabulary stem filter. */
function glossarySegmentWords(kanaSegment: string, vocab: JaBridgeVocabulary): string[] | undefined {
  const stems = GLOSSARY_EXACT_MAP.get(kanaSegment);
  if (!stems) return undefined;
  const admitted = [...new Set(stems.filter((s) => vocab.hasStemPrefix(s)).map((s) => s.toLowerCase()))];
  return admitted.length > 0 ? admitted : undefined;
}

/**
 * Levenshtein-rank `candidates` against `strippedRomaji`, keeping the best
 * (lowest-distance) candidate and any candidate within 1 edit of it,
 * ordered CLOSEST-DISTANCE-FIRST (then alphabetically within a tied
 * distance) so that if the caller later caps the list (MAX_WORDS_PER_RUN),
 * the words it keeps are always the closest ones, never an arbitrary
 * alphabetical prefix of a larger tied group.
 */
function applyLevenshteinTiebreak(candidates: readonly string[], strippedRomaji: string): string[] {
  const sorted = [...candidates].sort();
  if (sorted.length <= 1 || strippedRomaji.length === 0) return sorted;
  const scored = sorted.map((w) => ({ w, d: levenshteinDistance(strippedRomaji, w.toLowerCase()) }));
  const bestD = Math.min(...scored.map((s) => s.d));
  return scored
    .filter((s) => s.d <= bestD + 1)
    .sort((a, b) => a.d - b.d || (a.w < b.w ? -1 : a.w > b.w ? 1 : 0))
    .map((s) => s.w);
}

/**
 * Rank candidates that share one consonant-class key against
 * `segmentRomaji` -- that specific run/segment's OWN romaji, never a
 * sibling segment's or a different segment's, so a compound's later
 * segment is never penalized for not matching an earlier segment's vowel
 * (the bug this two-argument shape replaced: "status" used to be dropped
 * from "ステータスコード" because the WHOLE run's first vowel was used to
 * rank every segment).
 *
 * Two stages, NOT three: an EXACT first-vowel match is trusted outright
 * when it uniquely identifies one candidate (separates cancel/console,
 * token/taken -- both real minimal pairs where the correct answer's own
 * spelling starts with exactly the query's own first vowel and the wrong
 * one does not). Everything else -- no exact match at all, or more than
 * one -- falls through to Levenshtein distance between the candidate and
 * the romaji with epenthetic vowels stripped, run over the candidates that
 * DO exact-match if there is more than one, or over ALL candidates
 * otherwise.
 *
 * The design's own loose first-vowel table (VOWEL_COMPAT) is deliberately
 * NOT used as an independent tier here anymore: an earlier version tried
 * exact vowel, then the loose table, then Levenshtein only as a last
 * resort -- and a real vocabulary (bench/fixtures/shopflow) falsified it.
 * "ステータス" (query first vowel "u") against a key shared by 11 real
 * words: none of them starts with "u", but "shortages" starts with "o",
 * and VOWEL_COMPAT's o-row loosely accepts "u" -- so the loose tier
 * "resolved" to the single, wrong candidate "shortages" (5 edits from the
 * query) and never let "status"/"states"/"sets" (2 edits) compete at all.
 * Skipping straight to Levenshtein over the full candidate set once no
 * candidate is an EXACT vowel match avoids that trap: a coincidental loose
 * vowel match can no longer outrank a much closer spelling.
 */
function rankCandidates(candidates: readonly string[], segmentRomaji: string): string[] {
  const sorted = [...candidates].sort();
  if (sorted.length <= 1) return sorted;
  const stripped = stripEpentheticVowels(segmentRomaji);
  const queryVowel = romajiFirstVowel(segmentRomaji);
  if (queryVowel !== null) {
    const exact = sorted.filter((w) => englishFirstVowel(w) === queryVowel);
    if (exact.length === 1) return exact;
    if (exact.length > 1) return applyLevenshteinTiebreak(exact, stripped);
  }
  return applyLevenshteinTiebreak(sorted, stripped);
}

interface CoverDp {
  readonly bounds: readonly number[];
  readonly segWords: ReadonlyArray<string[] | undefined>;
}

/** Reconstruct the boundary list [0, ..., n] from a `back` array built by either DP pass below. */
function reconstructBounds(n: number, back: readonly number[]): number[] {
  const bounds: number[] = [];
  for (let cur = n; cur > 0; cur = back[cur]!) bounds.push(cur);
  bounds.push(0);
  bounds.reverse();
  return bounds;
}

/**
 * Pass 1 (orchestrator Phase 4, 2026-09-19 -- Defect 1a): a full cover of
 * `run` using ONLY exact short-katakana glossary segments (each >= 2
 * characters), minimizing segment count among such all-glossary covers.
 * `undefined` when no such cover exists -- callers must then fall back to
 * the mixed pass, never treat this as "no match".
 */
function matchAllGlossaryCover(run: string, vocab: JaBridgeVocabulary): CoverDp | undefined {
  const n = run.length;
  const INF = Number.POSITIVE_INFINITY;
  const dp: number[] = new Array(n + 1).fill(INF);
  const back: number[] = new Array(n + 1).fill(-1);
  const segWords: Array<string[] | undefined> = new Array(n + 1);
  dp[0] = 0;
  for (let end = 2; end <= n; end++) {
    const startFloor = Math.max(0, end - MAX_COMPOUND_SEGMENT_CHARS);
    for (let start = startFloor; start <= end - 2; start++) {
      if (dp[start] === INF) continue;
      const words = glossarySegmentWords(run.slice(start, end), vocab);
      if (!words) continue;
      if (dp[start]! + 1 < dp[end]!) {
        dp[end] = dp[start]! + 1;
        back[end] = start;
        segWords[end] = words;
      }
    }
  }
  if (dp[n] === INF) return undefined;
  return { bounds: reconstructBounds(n, back), segWords };
}

interface CoverState {
  readonly glossaryChars: number;
  readonly segments: number;
}

/** `a` is preferred over `b`: MORE exact-glossary characters wins outright regardless of segment count (Defect 1a's "more generally prefer covers with more exact-glossary characters"); fewer segments only breaks a glossary-character tie. */
function coverBetter(a: CoverState, b: CoverState): boolean {
  if (a.glossaryChars !== b.glossaryChars) return a.glossaryChars > b.glossaryChars;
  return a.segments < b.segments;
}

/**
 * Pass 2: a full cover of `run` where each segment resolves either as an
 * exact short-katakana glossary entry or, failing that, a phonetic
 * class-key match -- only reached when pass 1 found no all-glossary cover
 * at all. Ranked by coverBetter (glossary characters first, segment count
 * second), so a mixed cover with more glossary content is still preferred
 * over one with less, even though neither is a pure win.
 */
function matchMixedCover(run: string, vocab: JaBridgeVocabulary): CoverDp | undefined {
  const n = run.length;
  const dp: Array<CoverState | undefined> = new Array(n + 1);
  const back: number[] = new Array(n + 1).fill(-1);
  const segWords: Array<string[] | undefined> = new Array(n + 1);
  dp[0] = { glossaryChars: 0, segments: 0 };
  for (let end = 2; end <= n; end++) {
    const startFloor = Math.max(0, end - MAX_COMPOUND_SEGMENT_CHARS);
    for (let start = startFloor; start <= end - 2; start++) {
      const startState = dp[start];
      if (!startState) continue;
      const segment = run.slice(start, end);
      const isWholeRun = start === 0 && end === n;
      const glossaryWords = glossarySegmentWords(segment, vocab);
      const words = glossaryWords ?? phoneticSegmentWords(segment, vocab, isWholeRun);
      if (!words) continue;
      const candidateState: CoverState = {
        glossaryChars: startState.glossaryChars + (glossaryWords ? segment.length : 0),
        segments: startState.segments + 1,
      };
      if (!dp[end] || coverBetter(candidateState, dp[end]!)) {
        dp[end] = candidateState;
        back[end] = start;
        segWords[end] = words;
      }
    }
  }
  if (!dp[n]) return undefined;
  return { bounds: reconstructBounds(n, back), segWords };
}

function collectCoverWords(run: string, cover: CoverDp): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i + 1 < cover.bounds.length; i++) {
    const start = cover.bounds[i]!;
    const end = cover.bounds[i + 1]!;
    const words = cover.segWords[end] ?? [];
    const segmentRomaji = katakanaToRomaji(run.slice(start, end));
    for (const w of rankCandidates(words, segmentRomaji)) {
      if (seen.has(w)) continue;
      seen.add(w);
      out.push(w);
    }
  }
  return out;
}

/**
 * Resolve a katakana run into English words. Two-PASS by design (Defect
 * 1a): an all-glossary full cover, when one exists, wins OUTRIGHT over any
 * cover using even one phonetic segment -- computed and returned first, so
 * a phonetic alternative for the SAME run is never even attempted, let
 * alone compared. This is the actual fix for the reported dangerous
 * defect: the previous single-pass "fewest segments wins" DP preferred a
 * 1-segment ACCIDENTAL phonetic collision ("エラーコード" -> "record",
 * both keying to the same consonant skeleton) over the CORRECT 2-segment
 * glossary decomposition (エラー + コード) for no reason other than 1 < 2.
 * Only when no all-glossary cover exists at all does the mixed pass run,
 * itself preferring more glossary content over less. A plain single-word
 * run is just the degenerate 1-segment case either pass can find -- one
 * mechanism covers "キャンセル", "クーポンコード", and "エラーコード"
 * without separate code paths.
 */
function matchCompoundRun(run: string, vocab: JaBridgeVocabulary): string[] {
  const n = run.length;
  if (n < 2) return [];

  const allGlossary = matchAllGlossaryCover(run, vocab);
  if (allGlossary) return collectCoverWords(run, allGlossary);

  const mixed = matchMixedCover(run, vocab);
  return mixed ? collectCoverWords(run, mixed) : [];
}

function matchKatakanaRun(run: string, vocab: JaBridgeVocabulary): string[] {
  return matchCompoundRun(run, vocab).slice(0, MAX_WORDS_PER_RUN);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface JaBridgeExpansion {
  source: string;
  tokens: string[];
  via: "katakana" | "glossary";
}

export interface JaBridgeResult {
  expansions: JaBridgeExpansion[];
}

/** Total lexical-term budget across every expansion in one bridgeJaQuery call (design cap). */
export const MAX_TOTAL_TOKENS = 12;

/**
 * Bridge a (possibly Japanese) free-text query into extra ASCII lexical
 * terms drawn from `vocab`. Deterministic: same `query`/`vocab` always
 * yields the same expansions in the same order (katakana runs in
 * left-to-right query order, then glossary hits in left-to-right query
 * order; each run/segment's own word list is vowel- and Levenshtein-ranked,
 * then alphabetically tiebroken). Returns `{ expansions: [] }` immediately,
 * doing no vocabulary lookups at all, when `query` has no Han/Hiragana/
 * Katakana character. Never throws: any internal failure surfaces as "no
 * expansion found" for the affected run/term, never as an exception --
 * jaQueryBridge.ts's own logic has no I/O to fail on, but callers pass in
 * a `vocab` built elsewhere and this function makes no assumption about it
 * beyond the documented interface.
 */
export function bridgeJaQuery(query: string, vocab: JaBridgeVocabulary): JaBridgeResult {
  if (!containsJapanese(query)) return { expansions: [] };

  const expansions: JaBridgeExpansion[] = [];
  const emitted = new Set<string>();
  let totalTokens = 0;

  for (const run of extractKatakanaRuns(query)) {
    if (totalTokens >= MAX_TOTAL_TOKENS) break;
    let words: string[];
    try {
      words = matchKatakanaRun(run, vocab).filter((w) => !emitted.has(w));
    } catch {
      words = [];
    }
    if (words.length === 0) continue;
    const tokens = words.slice(0, MAX_TOTAL_TOKENS - totalTokens);
    if (tokens.length === 0) continue;
    for (const t of tokens) emitted.add(t);
    expansions.push({ source: run, tokens, via: "katakana" });
    totalTokens += tokens.length;
  }

  if (totalTokens < MAX_TOTAL_TOKENS) {
    for (const { term, stems } of glossaryLongestMatchScan(query)) {
      if (totalTokens >= MAX_TOTAL_TOKENS) break;
      const admitted = stems.filter((s) => vocab.hasStemPrefix(s) && !emitted.has(s.toLowerCase()));
      if (admitted.length === 0) continue;
      const tokens = admitted.slice(0, MAX_TOTAL_TOKENS - totalTokens).map((s) => s.toLowerCase());
      if (tokens.length === 0) continue;
      for (const t of tokens) emitted.add(t);
      expansions.push({ source: term, tokens, via: "glossary" });
      totalTokens += tokens.length;
    }
  }

  return { expansions };
}
