/**
 * Shared, side-effect-free helpers that turn a query (or one clause of it)
 * into extra LATIN search terms taken from the workspace's own vocabulary.
 *
 * Two callers, both behind (S) supported first-pack flags -- TL_JA_QUERY_BRIDGE
 * and TL_CONCERN_RECOVERY, default ON since 2026-09-19 (USER ruling); explicit
 * `=0` on either is the rollback path -- and both used ONLY as a recovery
 * step after an ordinary locate came back empty-handed -- never to perturb a
 * query that already resolves:
 *
 *   - `buildAnswerTaskPack` (TL_JA_QUERY_BRIDGE): a Japanese query against an
 *     English codebase shares no lexical token with it.
 *   - the per-clause locate of TL_CONCERN_RECOVERY: one clause of a
 *     multi-concern query, Japanese or English.
 *
 * Nothing here reads the environment except `jaQueryBridgeEnabled()`; nothing
 * throws (a vocabulary failure means "no extra terms").
 */
import { jaQueryBridgeEnabled } from "../../util/flags.js";
import { bridgeJaQuery, containsJapanese } from "./jaQueryBridge.js";
import { getWorkspaceJaBridgeVocabulary } from "./jaBridgeWorkspaceVocab.js";
import { decomposeIdentifier } from "./tokenize.js";

const LATIN_WORD_RE = /[A-Za-z_$][A-Za-z0-9_$]{2,}/g;

/**
 * Counts every call to jaBridgeExpansionTokens that got PAST the
 * flag/language guard (i.e. that actually touched the workspace
 * vocabulary) -- mirrors readCodeTaskPack.ts's own concernRecoveryEntryCount
 * pattern, kept here instead since this is the one place that guard lives.
 * A spec can assert this stays 0 across a whole buildAnswerTaskPack run
 * with TL_JA_QUERY_BRIDGE explicitly disabled (`=0` -- the flag defaults ON
 * since 2026-09-19, so "unset" no longer means off), proving OFF-inertness
 * directly rather than only inferring it from unchanged output bytes -- the
 * call site in
 * buildAnswerTaskPack always invokes jaBridgeRecoveryQuery once
 * `!locateResult.hit`, regardless of the flag, so counting the OUTER call
 * would not distinguish "reached but declined" from "did real work".
 */
let jaBridgeExpansionEntryCountForTest = 0;
export function jaBridgeExpansionEntryCount(): number {
  return jaBridgeExpansionEntryCountForTest;
}
export function resetJaBridgeExpansionEntryCountForTest(): void {
  jaBridgeExpansionEntryCountForTest = 0;
}

/**
 * Latin expansion tokens for the Japanese parts of `text`. Empty when
 * TL_JA_QUERY_BRIDGE is off, `text` has no Japanese, or nothing in the
 * workspace vocabulary matches.
 */
export function jaBridgeExpansionTokens(text: string, workspace: string): string[] {
  if (!jaQueryBridgeEnabled() || !containsJapanese(text)) return [];
  jaBridgeExpansionEntryCountForTest += 1;
  try {
    const vocab = getWorkspaceJaBridgeVocabulary(workspace);
    const out: string[] = [];
    for (const expansion of bridgeJaQuery(text, vocab).expansions) {
      for (const token of expansion.tokens) if (!out.includes(token)) out.push(token);
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * A Latin-only recovery query for a Japanese `text`: the Latin words the
 * caller wrote themselves (identifiers, file names) followed by the
 * bridge's expansions, in order, deduplicated. `undefined` when there is
 * nothing to add -- the caller must then keep its original result
 * untouched.
 *
 * Orchestrator Phase 4 (2026-09-19), Defect 2: this used to drop expansion
 * tokens of <= 4 letters once >= 2 longer ones were present (a length-based
 * noise filter meant to protect precision against short, high-collision
 * words like "code"). A held-out probe showed it removing the MOST
 * discriminating token instead: フラグ + 有効 legitimately expands to
 * "flag" (4 letters) + "valid"/"enable" (5/6 letters), and the filter kept
 * exactly the two generic verbs while dropping "flag", the one word that
 * actually distinguishes this query from any other config-adjacent one.
 * Length is not a reliable proxy for specificity. Precision here is now the
 * job of buildAnswerTaskPack's own adoption gate (Defect 3's support
 * check), which looks at whether expansions actually appear in the
 * RECOVERED candidate rather than guessing from token length in advance.
 */
export function jaBridgeRecoveryQuery(text: string, workspace: string): string | undefined {
  const expansions = jaBridgeExpansionTokens(text, workspace);
  if (expansions.length === 0) return undefined;
  const written = text.match(LATIN_WORD_RE) ?? [];
  return [...new Set([...written, ...expansions])].join(" ");
}

function commonPrefixLength(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i += 1;
  return i;
}

/**
 * Workspace words morphologically next to `token` ("authentication" ->
 * "authenticate", "auth"). Only for a token of >= 6 letters that the
 * workspace does NOT contain as a word itself -- a token the code already
 * uses needs no help. A neighbour shares a common prefix of >= 5 letters with
 * the token, or is itself (>= 4 letters) a prefix of it. Longest shared prefix
 * first, then the shorter word, then alphabetical; at most `max`. Independent
 * of any flag: the caller gates.
 */
export function vocabularyStemNeighbours(token: string, workspace: string, max = 2): string[] {
  const word = token.toLowerCase();
  if (word.length < 6 || !/^[a-z]+$/.test(word)) return [];
  try {
    const vocab = getWorkspaceJaBridgeVocabulary(workspace);
    if (vocab.hasWord(word)) return [];
    const scored: Array<{ word: string; shared: number }> = [];
    const seen = new Set<string>();
    for (const words of vocab.keyToWords.values()) {
      for (const candidate of words) {
        if (candidate === word || seen.has(candidate)) continue;
        seen.add(candidate);
        const shared = commonPrefixLength(word, candidate);
        const isPrefixOfToken = candidate.length >= 4 && shared === candidate.length;
        if (shared >= 5 || isPrefixOfToken) scored.push({ word: candidate, shared });
      }
    }
    scored.sort((a, b) =>
      b.shared - a.shared || a.word.length - b.word.length || a.word.localeCompare(b.word));
    return scored.slice(0, Math.max(0, max)).map((entry) => entry.word);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Adoption evidence (orchestrator Phase 4, 2026-09-19, Defect 3): a bridged
// recovery query reaching `locateTaskContext.hit` is NOT by itself proof
// the candidate it found is right -- a locator confidence threshold can
// clear on an unrelated file the expansions never actually named. Before
// this, buildAnswerTaskPack adopted on `jaRecovered.hit` alone, which is
// exactly how the reported dangerous defect served a wrong file with a
// confident act-answer instead of the default's honest, empty `discover`.
// This function is the pure decision core; buildAnswerTaskPack supplies the
// candidate's own words (no I/O, no vocabulary access here).
// ---------------------------------------------------------------------------

/** Minimum prefix length for an expansion token to count via a PREFIX match ("valid" -> "validate") rather than requiring an exact word. */
const SUPPORT_PREFIX_MIN_LEN = 4;
/** Minimum length for a SINGLE expansion token, exactly equaling a path/symbol word, to count as support on its own (no second corroborating token needed). */
const SUPPORT_SOLE_TOKEN_MIN_LEN = 6;

/** Split `text` on camelCase/snake/kebab boundaries into lowercase words (length >= 3) -- the same decomposition tokenize.ts already applies elsewhere in this family. */
export function wordsFromIdentifierLikeText(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[^A-Za-z0-9]+/)) {
    if (!raw) continue;
    for (const w of decomposeIdentifier(raw)) {
      if (w.length >= 3) out.push(w);
    }
  }
  return out;
}

export interface CandidateSupportWords {
  /** Words from the candidate's own path segments and resolved symbol name -- the narrower, more trustworthy source (structural, not prose). */
  readonly pathAndSymbolWords: readonly string[];
  /** Words from the candidate's served text/code window, if read. Widens the evidence pool for the >=2-token rule only; the single-strong-token rule never consults this. */
  readonly textWords: readonly string[];
}

/**
 * True iff `expansions` are evidenced by `words` well enough to adopt a
 * bridged recovery result: EITHER (a) at least 2 DISTINCT expansion tokens
 * occur in pathAndSymbolWords/textWords combined (an expansion token also
 * counts when it is a >=4-letter PREFIX of a candidate word), OR (b) at
 * least one expansion token of >=6 letters EXACTLY equals a
 * pathAndSymbolWords entry (the narrower source -- a long, exact structural
 * match is trusted alone; a prose/text match never is, and neither is a
 * short one). Pure and total: never throws, no I/O.
 */
export function expansionsSupportCandidate(
  expansions: readonly string[],
  words: CandidateSupportWords,
): boolean {
  const pathAndSymbol = words.pathAndSymbolWords.map((w) => w.toLowerCase());
  const pathAndSymbolSet = new Set(pathAndSymbol);
  const combined = [...pathAndSymbol, ...words.textWords.map((w) => w.toLowerCase())];
  const combinedSet = new Set(combined);

  function occurs(token: string, set: ReadonlySet<string>, list: readonly string[]): boolean {
    if (set.has(token)) return true;
    if (token.length >= SUPPORT_PREFIX_MIN_LEN) return list.some((w) => w.startsWith(token));
    return false;
  }

  const matched = new Set<string>();
  for (const e of expansions) {
    const t = e.toLowerCase();
    if (occurs(t, combinedSet, combined)) matched.add(t);
  }
  if (matched.size >= 2) return true;

  for (const e of expansions) {
    const t = e.toLowerCase();
    if (t.length >= SUPPORT_SOLE_TOKEN_MIN_LEN && pathAndSymbolSet.has(t)) return true;
  }
  return false;
}
