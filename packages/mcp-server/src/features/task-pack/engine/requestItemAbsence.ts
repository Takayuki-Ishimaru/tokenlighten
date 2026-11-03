// requestItemAbsence — extracted implementation; imports point to the owning modules.
import type { ConcernTermVariants } from "./sourceAndConcernTerms3.js";
import type { FindTextUniverse } from "../../search/find/findText.js";
import type { LineSpan } from "./sourceAndConcernTerms.js";
import type { RequestItem } from "../requestItems.js";
import type { RequestItemPrewalk } from "./requestItemAbsence2.js";
import type { RequestItemProof } from "./recursiveClosure5.js";
import type { ScanContentCache } from "../../search/find/findText.js";
import type { TaskPackSurface } from "../model.js";
import { GENERIC_SOFTWARE_ABSENCE_WORDS } from "./concernProof3.js";
import { KANJI_CHAR_RE } from "./requestItemAbsence2.js";
import { LIGHT_VERB_WORDS } from "./concernProof3.js";
import { bridgeJaQuery } from "../../retrieval/jaQueryBridge.js";
import { capitalizationNamesSubject } from "../requestItems.js";
import { clauseNamesCodeShapedOrQuotedTerm } from "../requestItems.js";
import { collectSymbols } from "../../../symbols/collectSymbols.js";
import { concernAbsenceProbe } from "./sourceAndConcernTerms3.js";
import { concernAdmitsDocAnchor } from "./sourceAndConcernTerms3.js";
import { concernTermAnchoredInSurface } from "./sourceAndConcernTerms3.js";
import { concernTermVariants } from "./sourceAndConcernTerms3.js";
import { concernTopicTerms } from "./sourceAndConcernTerms3.js";
import { containsJapanese } from "../../retrieval/jaQueryBridge.js";
import { createRequestItemIndexView } from "../requestItems.js";
import { createScanContentCache } from "../../search/find/findText.js";
import { createScanCoverage } from "../../search/find/findText.js";
import { declarationCandidatePaths } from "./sourceAndConcernTerms.js";
import { docAnchorsEligible } from "./sourceAndConcernTerms3.js";
import { enumerateFindTextUniverse } from "../../search/find/findText.js";
import { extractRequestItems } from "./packBasics2.js";
import { getWorkspaceJaBridgeVocabulary } from "../../retrieval/jaBridgeWorkspaceVocab.js";
import { hasServedCode } from "./wiringEvidence2.js";
import { inflectionVariants } from "../salientWordMatch.js";
import { isCjkRun } from "../requestItems.js";
import { isCodeShapedTerm } from "../requestItems.js";
import { isGenericJapaneseAbsenceTerm } from "../requestItems.js";
import { isInnerSentenceLead } from "../requestItems.js";
import { isLiteralEligibleTerm } from "../requestItems.js";
import { isProseAcronym } from "../concernRecovery.js";
import { jaQueryBridgeEnabled } from "../../../util/flags.js";
import { jaTermHasUnresolvedLoanword } from "./sourceAndConcernTerms3.js";
import { jaTopicNounPhrase } from "../requestItems.js";
import { languageForPathWithContent } from "../../../util/languages.js";
import { looksLikeFileTerm } from "../requestItems.js";
import { quotedLiteralTerm } from "./sourceAndConcernTerms3.js";
import { quotedOccurrenceInText } from "../requestItems.js";
import { readCached } from "./packBasics2.js";
import { salientWords } from "../requestItems.js";
import { scanRequestItemLiteral } from "../requestItemScan.js";
import { scopeCompletenessAfterScan } from "./sourceAndConcernTerms3.js";
import { servedSurfaceText } from "./changeAndReadinessEvidence2.js";
import { surfaceEvidencesSalientWord } from "./sourceAndConcernTerms3.js";
import { textHasWordVariant } from "../salientWordMatch.js";
import { topicHeadModifiers } from "../requestItems.js";

/**
 * WP-C2 (2026-09-29, eval-0929 §6/§8, rule 1) — THE gate every
 * `request-item-absent:<term>` disclosure in this file's absence engines
 * must pass, replacing the closed vocabulary lists above as the PRIMARY
 * test. See `isLiteralEligibleTerm`'s own header comment (requestItems.ts)
 * for the three structural categories; this wrapper additionally applies
 * `GENERIC_SOFTWARE_ABSENCE_WORDS`/`isGenericJapaneseAbsenceTerm` as a
 * SECOND, narrower filter on the code-shape/existence-check branches only
 * (rule 1's own "the existing lists may stay only as a second filter") —
 * never on an explicit quote, which Decision 6 (TL142-04) already treats as
 * overriding "merely descriptive" everywhere else in this pipeline.
 *
 * The orchestrator's blind held-out set found this class of leak AFTER
 * WP-C's own list-based fix landed: an ordinary verb ("give"), an adjective
 * ("missing"), a bare content verb ("cause"), a slash-joined phrase of
 * ordinary words (`terms.join("/")` below — "payment/fails",
 * "callers/during/shutdown/sequence", an identifier glued to a plain word
 * — "TTL_SECONDS/expiry"), and a whole unsegmented Japanese clause as one
 * term — none of these are code-shaped, quoted, or an explicit
 * existence-check, so none of them may ever be the disclosed term now,
 * however "distinctive" the tiering/candidate-selection heuristics upstream
 * judge them to be. A composite disclosed term is handled by construction:
 * every caller below filters its OWN word array through this predicate
 * BEFORE joining with "/", so only the literal-eligible parts ever survive
 * into the join — never a decomposition of one already-joined string.
 *
 * WP-C3 (2026-09-29, eval-0929 §6, orchestrator RULING — "subject absence is
 * kept, descriptor absence is never certified"): the WP-C2 gate above made
 * every non-code-shaped word ineligible, which also retired the reviewed
 * 2026-09-08 Tier C behaviour ("the redis cache invalidation implementation"
 * → `redis` absent; "how does the flux capacitor work?" → flux/capacitor).
 * `isLiteralEligibleTerm` now also admits the SUBJECT noun phrase of a clause
 * that names no identifier or quote, and still never a descriptor (the facet
 * vocabulary), a predicate (a verb, auxiliary, participle or adjective, by
 * position) or a plain word beside an identifier/quote. The generic
 * vocabulary stays the second, narrower filter here — now on every
 * non-quoted branch, subject words included (it is the SAME list Tier C
 * filtered with before WP-C2: "cache"/"implementation" never absent) — plus
 * `isProseAcronym` ("HTTP"/"API": reviewed prose vocabulary, not a name).
 */
export function disclosableAbsenceTerm(
  word: string,
  itemText: string,
  facetSubject?: readonly string[],
  /**
   * Rule (c) (Copilot retest r3, 2026-10-02): `headRelatesPresentThings` bound to
   * the caller's own occurrence test. A caller that can look the workspace up
   * passes one; the others keep the structural gate alone.
   */
  relatesPresentThings?: (word: string) => boolean,
): boolean {
  if (quotedOccurrenceInText(word, itemText)) return true;
  // R2-T2 follow-up (orchestrator ruling on the round-2 combined run): a
  // point its facet owns through the lead's identifiers is about THAT
  // identifier (`RequestItem.facetSubject`) — only a code-shaped word of its
  // own may still be certified absent, never a plain word (rule 2(c)/(d)).
  if (facetSubject !== undefined && !isCodeShapedTerm(word)) return false;
  if (!isLiteralEligibleTerm(word, itemText)) return false;
  // Copilot retest r3 (2026-10-02, rule (a)): a capitalised word that only OPENS
  // a sentence inside the item ("... mainland. Report subtotal", "... determine
  // it? Cite file names") is an imperative, never a proper noun.
  if (isInnerSentenceLead(word, itemText)) return false;
  // Copilot retest r3 (2026-10-02, rule (c)): the head of a noun phrase whose
  // modifier is PRESENT in the workspace ("discount ORDER", "giftcard
  // ELIGIBILITY") names an aspect of present things — its own absence is no claim.
  if (relatesPresentThings?.(word) === true) return false;
  return !GENERIC_SOFTWARE_ABSENCE_WORDS.has(word.toLowerCase())
    && !isGenericJapaneseAbsenceTerm(word)
    && !isProseAcronym(word);
}

/**
 * Copilot retest r3 (2026-10-02, rule (c)) — true when `word` is the HEAD of a
 * topic noun phrase of `itemText` (the LAST word of a phrase with noun modifiers
 * in front of it: requestItems.ts `topicHeadModifiers`) and one of those
 * modifiers OCCURS in the workspace according to `occurs` — the absence
 * engine's own occurrence test (`concernAbsenceProbe`: word-level, inflection-
 * and file-name-aware).
 *
 * Such a head relates present things: "discount order" asks about the ORDER of
 * the discounts the workspace has, "giftcard eligibility" about the eligibility
 * of its gift cards, "quote calculation" about what quote() calculates — so the
 * literal word's absence ("order", "eligibility", "calculation") says nothing
 * about the workspace, exactly like a facet descriptor (rule 2(a): "descriptor
 * absence is never certified"). A phrase whose modifiers are ALSO absent ("flux
 * capacitor") keeps its head; so does a phrase that ends in a facet descriptor
 * ("the cache entryway PATH" — the descriptor is the head and "entryway" its
 * subject), and a modifier is never the one suppressed ("refund flow" with no
 * refund code still discloses "refund"). A QUESTION asks about its subject, so a
 * head in a question sentence is never suppressed (`topicHeadModifiers` leaves it
 * out): "How does the shipping webhook retry failed deliveries?" and "Does the
 * payment gateway retry on 503?" still disclose `webhook` / `gateway`, while the
 * imperative twin ("Trace the shipping webhook") keeps (c) — the accepted residual.
 * A generic-vocabulary modifier
 * ("cache", "request") is no evidence a head is about something SPECIFIC, and an
 * identifier/quoted/call-shaped clause names its subject outright, so neither
 * counts. Never a word list: the suppression follows the phrase's own shape and
 * what the workspace contains.
 */
export function headRelatesPresentThings(word: string, itemText: string, occurs: (modifier: string) => boolean): boolean {
  if (isCodeShapedTerm(word) || clauseNamesCodeShapedOrQuotedTerm(itemText)) return false;
  const modifiers = topicHeadModifiers(itemText).get(word.toLowerCase());
  return modifiers !== undefined
    && modifiers.some((modifier) => !GENERIC_SOFTWARE_ABSENCE_WORDS.has(modifier) && occurs(modifier));
}

/**
 * WP-C3 — the could-not-determine reason for a point none of whose words
 * may be certified absent. Deliberately never contains "absent"/"no
 * occurrence": on the wire those words mark a VERIFIED absence.
 */
export function noDisclosableTermReason(words: readonly string[]): string {
  return `${words.join("/")}: no subject, identifier or quoted term whose absence could be certified — not a verified absence`;
}

/**
 * WP-C3 (rule 1(d) "after removing descriptors"; rule 3 "composite terms are
 * decomposed") — the form of `word` that may be DISCLOSED absent: `word`
 * itself when it is eligible as written; for a Japanese noun phrase that is
 * only eligible once its descriptor の-segments are removed
 * (「マイグレーションの仕組み」→「マイグレーション」), that trimmed phrase —
 * flagged `trimmed`, because the caller's own scan never looked for it and
 * must verify it before claiming "no occurrence"; otherwise undefined.
 */
export function disclosableAbsenceForm(
  word: string,
  itemText: string,
  facetSubject?: readonly string[],
  relatesPresentThings?: (word: string) => boolean,
): { term: string; trimmed: boolean } | undefined {
  if (disclosableAbsenceTerm(word, itemText, facetSubject, relatesPresentThings)) return { term: word, trimmed: false };
  if (!isCjkRun(word)) return undefined;
  const form = jaTopicNounPhrase(word);
  if (form === undefined || form === word || !disclosableAbsenceTerm(form, itemText, facetSubject, relatesPresentThings)) return undefined;
  return { term: form, trimmed: true };
}

/**
 * WP-C3 — `words`' disclosable forms (see `disclosableAbsenceForm`), in
 * order, deduped. A trimmed Japanese form is kept only when `verifyTrimmed`
 * proves it has no occurrence of its own; `anyTrimmed` tells the caller its
 * scope qualifier must include that verification's scans too.
 */
export function disclosableAbsenceForms(
  words: readonly string[],
  itemText: string,
  verifyTrimmed: (term: string) => boolean,
  facetSubject?: readonly string[],
  relatesPresentThings?: (word: string) => boolean,
): { terms: string[]; anyTrimmed: boolean } {
  const terms: string[] = [];
  let anyTrimmed = false;
  for (const word of words) {
    const form = disclosableAbsenceForm(word, itemText, facetSubject, relatesPresentThings);
    if (form === undefined || terms.includes(form.term)) continue;
    if (form.trimmed) {
      if (!verifyTrimmed(form.term)) continue;
      anyTrimmed = true;
    }
    terms.push(form.term);
  }
  return { terms, anyTrimmed };
}

/**
 * A DISTINCTIVE salient term of `item.text` that INDIVIDUALLY has zero
 * workspace occurrences — checked separately from
 * `proveUnbindableRequestItem`'s own whole-item union check, because ONE
 * common co-occurring word in the same clause (e.g. "cache" in "the redis
 * cache invalidation implementation") can otherwise mask a genuinely absent,
 * distinguishing subject the union check never isolates.
 *
 * DESIGN-v0.15 R1 §4.2 generalization (2026-09-08): this helper used to be
 * named `capitalizedSalientAbsence` and consider ONLY a capitalized,
 * non-leading salient word — silently dropping a genuinely absent LOWERCASE
 * topic ("the redis cache invalidation implementation") or a JAPANESE one
 * entirely (capitalization has no Japanese analog). Generalized into three
 * ordered TIERS, evaluated in order (A, then B, then C) and in TEXT ORDER
 * within a tier, returning the FIRST candidate proved to have zero
 * occurrences — general, shape/frequency-based heuristics, never a
 * dictionary of specific expected-absent terms:
 *
 *   Tier A — the ORIGINAL capitalized-word signal ("a capitalized word is
 *   more likely a proper noun/product name than ordinary prose", the same
 *   heuristic `queryNamesSpecificSubject`'s own capitalized-word fallback
 *   uses for the unrelated overview-redirect gate), PLUS `item.terms`
 *   (`extractRequestItems`' own `extractTerms` output for THIS item —
 *   quoted/backticked spans, dotted keys, camelCase/PascalCase, CONST_CASE;
 *   requestItems.ts — reused as-is, never re-derived) minus anything
 *   file-shaped (`looksLikeFileTerm`): a term the query itself marked
 *   distinctive (by casing, shape, or quoting) is at least as strong a
 *   signal as capitalization alone. `item.terms` is grouped by PATTERN
 *   internally (every quoted match, then every file match, then...), not by
 *   position, so the merged tier is re-sorted to text order below.
 *
 *   Tier B — a CJK (Han/Hiragana/Katakana) run of >=2 characters
 *   (`salientWords`' own second extraction branch, isolated via
 *   `isCjkRun`), minus a short, hand-reviewed list of generic Japanese
 *   technical-prose words (`isGenericJapaneseAbsenceTerm`, requestItems.ts)
 *   too structural to ever tell a reader something distinguishing about a
 *   workspace on their own (実装/説明/テスト/…). No leading-word exclusion:
 *   Japanese does not share English's imperative-verb-at-clause-start shape.
 *
 *   Tier C — a lowercase-led ASCII salient word (`salientWords` already
 *   applies the >=4-char/STOPWORDS filter), minus the item's own leading
 *   token and the (2026-09-08, review 2 finding 5: much larger)
 *   hand-reviewed `GENERIC_SOFTWARE_ABSENCE_WORDS` list just above. Review 2
 *   finding 5: Tier C is a FALLBACK ONLY — its candidate pool stays EMPTY
 *   whenever the item has ANY Tier A or Tier B candidate, even one that
 *   later turns out not to be absent. If an item names a capitalized word,
 *   an identifier/quoted term, or a CJK run, THAT is its distinctive
 *   subject; the item's remaining lowercase ASCII words are ordinary
 *   descriptive prose around that subject, not independent candidates of
 *   their own ("the timeout handling in Cache.get" never separately checks
 *   "timeout"/"handling" once "Cache.get" is on the table as Tier A).
 *
 * Every tier's candidates are drawn from the SAME first-4-salient-words pool
 * `capitalizedSalientAbsence` always used (`salientWords(text).slice(0, 4)`)
 * — this generalizes that one existing cap across three tiers instead of
 * widening it; `item.terms` (Tier A's identifier/quoted supplement) gets its
 * own independent 4-item cap for the same reason. Tiers A and C additionally
 * exclude the item's own leading token (an imperative verb at clause start —
 * "Replace…", "Update…" — is capitalized/lowercase by sentence position, not
 * because it names the subject; a genuinely absent subject mid-clause is
 * never the clause's own leading word once ITS leading stopword is stripped
 * by `salientWords`, so this exclusion costs the real case nothing); Tier B
 * does not (design: CJK clauses do not share this shape, and a leading
 * ASCII-matched token can never equal a CJK candidate string regardless).
 *
 * Every tier shares the SAME leaf checks, in order: (1) never a term this
 * very pack's OWN served evidence already answers
 * (`surfaceEvidencesSalientWord`, review finding 2(a) — path or text,
 * stem-aware); (2) matching stays case-insensitive (`scanLiteral`) and
 * scoped to the WIDENED, find-consistent universe (`ensureAbsenceUniverse`,
 * review finding 2(b)), so this claim can never disagree with what
 * `tl_search_files find` would report for the same term. Returns the FIRST
 * candidate (across all three tiers, in the order above) proved to have
 * zero occurrences — at most one absent term per item, same as before this
 * generalization.
 */
/**
 * C3 (fix-c, 2026-09-21, plan §6.1) — a participle immediately governed by
 * one of these auxiliaries/copulas in the CLAUSE's own text ("are
 * executed", "is configured", "are validated") describes HOW the topic
 * behaves, not WHAT is missing: "how database migrations are executed"
 * asks about migrations, not about the word "executed". Matched with a
 * short (<=2-word) gap so it stays anchored to a genuine auxiliary+
 * participle span rather than firing on an unrelated later verb in a long
 * clause. Deliberately narrower than the ruling's own "or a clause-final
 * -s/-ed verb after the topic" alternative, which risks false positives
 * against ordinary plural nouns ("credentials", "migrations", "notifications"
 * all end in -s) with nothing anchoring them as verbs; the auxiliary anchor
 * has no such risk (a bare plural noun is never itself captured — only a
 * later word ending -ed/-en/-ing is).
 *
 * R-B3 (2026-09-21, orchestrator ruling 2): the auxiliary still ANCHORS the
 * participle, but only a participle in the closed light/generic class
 * (`LIGHT_VERB_WORDS`) is predicate-shaped now. "are executed" stays excluded
 * (a generic process verb); "is replenished" is a topic term again — see the
 * class's own doc comment for why every other predicate names what the
 * concern is about.
 */
export const PREDICATE_AUXILIARY_RE = /\b(?:is|are|was|were|be|been|being|get|gets)\s+(?:[a-z]+\s+){0,2}([a-z]+(?:ed|en|ing))\b/giu;

/**
 * R-B3 (ruling 1): the clause's CONTENT predicates — auxiliary-governed
 * participles (`PREDICATE_AUXILIARY_RE`) OUTSIDE the light/generic class
 * ("is replenished", "are renewed", "is resolved"). The collision rule's only
 * blockers: see `concernCoveredByServedEvidence`.
 */
export function contentPredicateWords(text: string): ReadonlySet<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(PREDICATE_AUXILIARY_RE)) {
    const word = m[1]!.toLowerCase();
    if (!LIGHT_VERB_WORDS.has(word)) out.add(word);
  }
  return out;
}

/** Every clause-text word C3 identifies as predicate-shaped — see `PREDICATE_AUXILIARY_RE`'s own doc comment. */
export function structuralPredicateWords(text: string): ReadonlySet<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(PREDICATE_AUXILIARY_RE)) {
    const word = m[1]!.toLowerCase();
    if (LIGHT_VERB_WORDS.has(word)) out.add(word);
  }
  return out;
}

/**
 * WP-C3 — `distinctiveSalientAbsence`'s verdict. `absent`: the first absent
 * candidate that may be DISCLOSED (a verified absence). `ineligible`: no
 * disclosable candidate is absent, but one this function scanned in its
 * pre-ruling tier order is — a predicate, descriptor or prose word the ruling
 * never certifies. That word's absence is still real information about a
 * point the caller must not drop silently (rule 4): the absence-only pass
 * turns it into a `request-item-undetermined` disclosure when nothing else
 * covers or discloses the point.
 */
export type DistinctiveAbsence =
  | { readonly kind: "absent"; readonly term: string; readonly scopeComplete: boolean; readonly omittedCount: number }
  | { readonly kind: "ineligible"; readonly term: string };

export function distinctiveSalientAbsence(
  item: RequestItem,
  priorEvidence: readonly TaskPackSurface[],
  workspace: string,
  universe: FindTextUniverse,
  contentCache?: ScanContentCache,
): DistinctiveAbsence | undefined {
  // C4 (fix-c, 2026-09-21): accumulates across EVERY scanLiteral call this
  // function makes, so a file the walk enumerated but could not decode as
  // text is never silently invisible to the scope-completeness verdict —
  // see `scopeCompletenessAfterScan`'s own doc comment.
  const coverage = createScanCoverage();
  const text = item.text;
  const leadWord = text.trim().match(/^[A-Za-z0-9_]+/u)?.[0];
  const pool = salientWords(text).slice(0, 4);

  // Tier A: capitalized non-leading salient words (the original signal)
  // UNION this item's own identifier/quoted terms minus file-shaped ones.
  // Keyed by lowercase so the two sources dedupe against each other; then
  // re-sorted to TEXT ORDER (item.terms's own order is pattern-grouped, not
  // positional).
  const tierACandidates = new Map<string, string>();
  for (const word of pool) {
    if (word === leadWord) continue;
    if (/^[A-Z]/u.test(word)) tierACandidates.set(word.toLowerCase(), word);
  }
  for (const term of item.terms.slice(0, 4)) {
    if (term === leadWord) continue;
    if (looksLikeFileTerm(term)) continue;
    const key = term.toLowerCase();
    if (!tierACandidates.has(key)) tierACandidates.set(key, term);
  }
  const tierAAll = [...tierACandidates.values()].sort((a, b) => {
    const ai = text.indexOf(a);
    const bi = text.indexOf(b);
    return (ai === -1 ? Number.MAX_SAFE_INTEGER : ai) - (bi === -1 ? Number.MAX_SAFE_INTEGER : bi);
  });
  // WP-C3 (orchestrator RULING): a Tier A candidate is DISCLOSED only when it
  // passes the same gate as every other tier — an identifier or quote, or a
  // capitalised proper noun in a clause that names neither (a capitalized
  // plain word beside `Cache.get` is that identifier's prose, never a second
  // subject). `tierAAll` (ungated) still decides the Tier C fallback below,
  // exactly as before: an item that NAMES a distinctive term never has its
  // lowercase prose checked on its own. Every tier is still SCANNED in its
  // pre-ruling order (`candidates` below); the gate only decides which absent
  // candidate may be disclosed.

  // Tier B: CJK/katakana runs minus the small generic-Japanese vocabulary —
  // already in text order (the pool's own order).
  //
  // WP-C2 (2026-09-29, eval-0929 §6/§8, rule 1): a CJK run this tier
  // considers must ALSO be literal-eligible (quoted, code-shaped — n/a for
  // a pure CJK run in practice, or the clause is an explicit existence
  // check) — never a bare, un-segmented Japanese clause with no such
  // marker. Measured leak (orchestrator's blind held-out set, AFTER WP-C's
  // own generic-word-list fix landed): a WHOLE noun-phrase clause
  // ("各ロールが返すステータスコードの一覧", "完全再同期が代わりにトリガーされる条件",
  // "バックオフ戦略の種類") reached the wire as ONE disclosed absent term —
  // Japanese has no word-segmentation boundary `salientWords`' own CJK
  // extraction can lean on, so a whole clause with no quote/existence
  // marker is exactly as un-distinguishing as an English verb/adjective.
  //
  // WP-C3 (orchestrator RULING rule 1(d)): a Japanese NOUN PHRASE is the
  // clause's subject and stays a candidate — as written when it holds no
  // descriptor (「キャッシュの有効期限」, 「マイグレーション」), or with its
  // descriptor の-segments removed (「バックオフ戦略の種類」→「バックオフ戦略」,
  // scanned below as that trimmed phrase, so the claim is about what was
  // actually looked for). A run that is a CLAUSE (a particle other than の,
  // or a verb/adjective ending inside it — the three runs quoted above) is
  // still never one.
  const tierBAll = pool.filter((word) => isCjkRun(word) && !isGenericJapaneseAbsenceTerm(word));

  // Tier C (review 2 finding 5, 2026-09-08): a FALLBACK ONLY — evaluated
  // (pool computed at all) only when this item has NO Tier A/B candidate
  // whatsoever. A non-empty Tier A/B means the item already names its own
  // distinctive term (capitalized word, identifier/quoted term, or CJK
  // run); the item's remaining lowercase ASCII words are then descriptive
  // prose around that term, never independently checked — this is what
  // keeps "Explain the timeout handling in Cache.get" from disclosing
  // "timeout"/"handling" as absent just because "Cache.get" itself is not
  // (yet) proved absent. When Tier A/B are both empty, lowercase-led ASCII
  // salient words minus the item's own leading token and the (2026-09-08:
  // much larger) generic-software vocabulary — already in text order.
  //
  // WP-C2 (rule 1): `disclosableAbsenceTerm` — quoted, code-shaped (a bare
  // lowercase word from THIS tier's own `/^[a-z]/` filter is essentially
  // never code-shaped, so this narrows Tier C to a quoted lowercase word or
  // an explicit existence-check clause's own residual wording), or an
  // existence-check clause — replaces the generic-list-only test. Measured
  // leak: an ordinary verb ("give") or adjective ("missing") that is
  // neither in the hand-reviewed list nor code-shaped/quoted/an existence
  // check was still Tier C's sole candidate and got certified absent.
  //
  // WP-C3: the gate now also admits the clause's SUBJECT noun phrase (the
  // reviewed Tier C cases: "the redis cache invalidation implementation" →
  // redis; "the cache entryway path" → entryway), and still never a
  // predicate or a descriptor. The fallback condition is the UNGATED tiers,
  // as it was before WP-C2 gated Tier B, and the pool is the pre-ruling one
  // (generic vocabulary excluded, nothing else): every word in it is still
  // scanned — the gate decides only what may be DISCLOSED (see `candidates`).
  const tierCPool = tierAAll.length > 0 || tierBAll.length > 0
    ? []
    : pool.filter((word) => {
        if (word === leadWord) return false;
        if (!/^[a-z]/u.test(word)) return false;
        return !GENERIC_SOFTWARE_ABSENCE_WORDS.has(word.toLowerCase());
      });
  // C3 (fix-c, 2026-09-21): a predicate/participle candidate ("executed" in
  // "how database migrations are executed") is never Tier C's reported term
  // while the SAME clause names a non-predicate topic candidate too — see
  // `PREDICATE_AUXILIARY_RE`'s own doc comment. Only when EVERY Tier C
  // candidate is predicate-shaped (nothing else to report) do they stay
  // eligible — never over-restrict to zero candidates when a predicate is
  // genuinely the only salient word left.
  const tierC = (() => {
    if (tierCPool.length === 0) return tierCPool;
    const predicateWords = structuralPredicateWords(text);
    const topicOnly = tierCPool.filter((word) => !predicateWords.has(word.toLowerCase()));
    return topicOnly.length > 0 ? topicOnly : tierCPool;
  })();

  // WP-C3: every candidate in the pre-ruling tier order, each with the form
  // that is SCANNED and whether an absence of it may be DISCLOSED. A
  // Japanese noun phrase is scanned as its disclosable (descriptor-trimmed)
  // form; a Japanese clause, and every other ineligible word, is scanned as
  // written only to learn whether it is absent (the `ineligible` verdict).
  const candidates: Array<{ word: string; disclose: boolean; tierC: boolean }> = [];
  const seenCandidate = new Set<string>();
  const addCandidate = (word: string, disclose: boolean, tierC: boolean): void => {
    if (seenCandidate.has(word)) return;
    seenCandidate.add(word);
    candidates.push({ word, disclose, tierC });
  };
  for (const word of tierAAll) {
    // Copilot retest r3 (2026-10-02, rule (a)): a capital is evidence of a proper
    // noun only in the MIDDLE of a clause. The first word of a sentence that begins
    // inside the item ("... mainland. Report subtotal", "... determine it? Cite
    // file names") is capitalised by its position — an imperative, part of the
    // request's own grammar and no word of the point — so it is neither scanned nor
    // disclosed (not even as `ineligible`, which would only turn the false absence
    // into a false `request-item-undetermined`). It still counts as the item's named
    // word in `tierAAll` above, so the Tier C fallback stays exactly as quiet as
    // before: this only ever REMOVES a disclosure, it never exposes a lowercase word
    // of the same item that was never independently checked.
    if (/^[A-Z]/u.test(word) && !capitalizationNamesSubject(word, text)) continue;
    addCandidate(word, disclosableAbsenceTerm(word, text, item.facetSubject), false);
  }
  for (const word of tierBAll) {
    const form = disclosableAbsenceForm(word, text, item.facetSubject);
    addCandidate(form?.term ?? word, form !== undefined, false);
  }
  for (const word of tierC) addCandidate(word, disclosableAbsenceTerm(word, text, item.facetSubject), true);
  // Copilot retest r3 (2026-10-02, rule (c)): an absent word that is the HEAD of a
  // noun phrase whose modifier occurs in the workspace ("discount ORDER",
  // "giftcard ELIGIBILITY", "quote CALCULATION") names an aspect of present things
  // — it is treated like every other word this tier may not disclose. Asked only
  // for a word already found absent, so the modifier lookups cost nothing on the
  // common path.
  const modifierProbe = concernAbsenceProbe(workspace, universe, new Map<string, ConcernTermVariants>(), contentCache);
  const headRelates = (word: string): boolean =>
    headRelatesPresentThings(word, text, (modifier) => !modifierProbe.provablyAbsent(modifier));
  let firstIneligible: string | undefined;
  const found = (word: string, disclose: boolean): DistinctiveAbsence | undefined => {
    if (!disclose || headRelates(word)) {
      firstIneligible ??= word;
      return undefined;
    }
    const { scopeComplete, omittedCount } = scopeCompletenessAfterScan(universe, coverage);
    return { kind: "absent", term: word, scopeComplete, omittedCount };
  };

  for (const { word, disclose, tierC: isTierC } of candidates) {
    // TL-03 root cause (fix-c, 2026-09-21, C1/C2): a Tier B (Japanese)
    // candidate's "already answered by this pack's own evidence" check, and
    // its final workspace scan below, must use the SAME normalisation
    // (`concernTermVariants`) search/retrieval already trusts — the SAME
    // workspace-vocabulary-gated JA bridge, not the candidate's raw,
    // unsegmented spelling. Without this, a CJK clause can never match
    // (typically) English source text even when the concept is fully,
    // concentratedly served (Q03: the whole cache module served, plus two
    // absence entries quoting the very clauses that module answers — the
    // absence and the evidence that contradicts it rode the SAME
    // response). Every non-Japanese candidate (tiers A/C, and any Tier B
    // entry that is somehow ASCII) keeps its existing EN-only check,
    // unchanged.
    const bridged = containsJapanese(word) ? concernTermVariants(word, workspace) : undefined;
    if (bridged !== undefined) {
      if (
        priorEvidence.some(
          (surface) =>
            hasServedCode(surface) &&
            bridged.variants.some(
              (v) => surfaceEvidencesSalientWord(surface, v) || textHasWordVariant(`${surface.path}\n${servedSurfaceText(surface)}`, v),
            ),
        )
      ) {
        continue;
      }
    } else if (priorEvidence.some((surface) => hasServedCode(surface) && surfaceEvidencesSalientWord(surface, word))) {
      continue;
    }
    // H-1(i) veto (2026-09-19, D1): scoped to Tier C (lowercase-EN) only —
    // tierA/tierB are non-empty only when tierC is forced empty (see the
    // tier computation above), so this membership check exactly identifies
    // a Tier C iteration. A common English inflection of the candidate
    // occurring as a WHOLE WORD (never a raw substring — the const/constant
    // regression salientWordMatch.ts's own guard exists for) anywhere in
    // absenceUniverse or in this pack's own served evidence means the word
    // is not absent; move on to the next candidate exactly as this
    // function does today when a word is not absent.
    if (isTierC) {
      const servedVariant = priorEvidence.some(
        (surface) => hasServedCode(surface) && textHasWordVariant(`${surface.path}\n${servedSurfaceText(surface)}`, word),
      );
      if (servedVariant) continue;
      let variantFound = false;
      for (const variant of inflectionVariants(word)) {
        if (variantFound) break;
        if (variant === word.toLowerCase()) continue;
        for (const match of scanRequestItemLiteral(variant, workspace, { files: universe.files, caseInsensitive: true, coverage, ...(contentCache ? { contentCache } : {}) })) {
          if (match.text !== undefined && textHasWordVariant(match.text, word)) {
            variantFound = true;
            break;
          }
        }
      }
      if (variantFound) continue;
    }
    // TL-03 (fix-c, 2026-09-21): the final workspace-wide scan for a
    // Japanese candidate is widened the same way — the raw clause plus
    // every bridged expansion token, never the unsegmented CJK run alone.
    if (bridged !== undefined) {
      let jaMatch = false;
      for (const candidate of bridged.variants) {
        for (const _ of scanRequestItemLiteral(candidate, workspace, { files: universe.files, caseInsensitive: true, coverage, ...(contentCache ? { contentCache } : {}) })) {
          jaMatch = true;
          break;
        }
        if (jaMatch) break;
      }
      if (jaMatch) continue;
      // R-B3 (ruling 3): an explicitly QUOTED literal is checked as the exact
      // string the caller singled out (TL142-04 Decision 6), never as a
      // bridged concept, so its miss is checkable whatever its script.
      if (!bridged.hasNormalization && !quotedLiteralTerm(item, word)) {
        // C1/C6 (fix-c, 2026-09-21): the normalisation MECHANISM never ran
        // for this candidate (`TL_JA_QUERY_BRIDGE=0`) — checked only by its
        // raw literal spelling, which is not a meaningful proof either way
        // against a typically non-Japanese codebase. "Could not determine",
        // never "absent": move on without reporting it (the next
        // tier/candidate may still be a genuine, checkable absence). With
        // the flag ON (the default), `bridged.hasNormalization` is true
        // here regardless of whether the bridge found anything — a
        // confirmed empty (or generic-only, already filtered out of
        // `bridged.variants`) result is itself a real, checked signal.
        continue;
      }
      const verdict = found(word, disclose);
      if (verdict !== undefined) return verdict;
      continue;
    }
    let hasMatch = false;
    for (const _ of scanRequestItemLiteral(word, workspace, { files: universe.files, caseInsensitive: true, coverage, ...(contentCache ? { contentCache } : {}) })) {
      hasMatch = true;
      break;
    }
    if (!hasMatch) {
      const verdict = found(word, disclose);
      if (verdict !== undefined) return verdict;
    }
  }
  return firstIneligible !== undefined ? { kind: "ineligible", term: firstIneligible } : undefined;
}

/**
 * Mints one required `concern` obligation per explicit request item (design
 * §4.1/§4.2) and, when any is uncovered, ONE batched discover call for every
 * independently-fetchable missing candidate (contract §3.4). Never gated on
 * any Semantic Frontier flag (design §4.1: this is the default path).
 */
/**
 * Finding 5 fix (2026-09-07): `enumerateFindTextUniverse` + a shared
 * `ScanContentCache` for every `scanLiteral` call this mechanism issues,
 * memoized per `TaskPackResult` OBJECT IDENTITY — the same "dedupe on
 * result identity" idiom `proofCompletionCountedResults` (just above
 * `buildTaskExecutionContract`) already uses for the SAME reason: that
 * builder runs several times per pack build (P2(b))'s doc comment), and
 * every prior run re-walked the whole workspace even though the file list
 * cannot have changed between re-evaluations of the SAME pack. A WeakMap
 * means this never persists across pack builds and never leaks: a fresh
 * `result` object gets a fresh entry, and a stale one is GC-eligible the
 * moment nothing else references it.
 */
// ---------------------------------------------------------------------------
// DESIGN-v0.15 R1 P1 fix continued (2026-09-07): async AST
// declaration-range pre-pass — the proof path's ONLY declaration-range
// source since the P1 ruling deleted the lexical fallback.
//
// `proveRequestItem`/`buildRequestItemReadiness` (and everything between
// them and `buildTaskExecutionContract`) are synchronous by design (see this
// module's own "R1 finding-2 fix" doc comment far above, near
// `HASH_COMMENT_LANGUAGES`: the whole request-item proof pipeline is
// synchronous, several call sites deep, and that wave must not touch it).
// `collectSymbols` (symbols/collectSymbols.ts) — the tree-sitter walk
// itself, deliberately NOT `getSymbolWithContext`, whose regex fallback the
// P1 ruling forbids as a proof source — is async, so it cannot be called
// from inside that chain directly.
// Instead it runs ONCE, early, in `buildTaskPack`'s own async body
// (mirroring `packByteCeilingStorage`'s own doc comment far above: an
// `AsyncLocalStorage`, never a bare module `let` that would leak across two
// interleaved `buildTaskPack` calls for different workspaces on the same
// event loop), and the synchronous chain reads the result back out through
// `getStore()` (see `declarationRangeInFile` above).
//
// Reuses the SAME `enumerateFindTextUniverse` walk `cachedRequestItemPass`
// would otherwise perform on its own (see its modified body just below) so a
// composite pack still walks the workspace exactly once for the whole
// build — finding 5's own perf contract (requestItemCompletion.spec.ts's
// "enumerateFindTextUniverse walk count" describe block) — instead of once
// here PLUS once there.
// ---------------------------------------------------------------------------

/** Bound on candidate declaration files resolved via tree-sitter per `decision` item — mirrors `declarationCandidatePaths`' own unbounded return with a pass-wide cap so a pathological identifier with many same-named candidates cannot inflate one `buildTaskPack` call's async pre-pass. */
export const MAX_DECISION_TREE_SITTER_CANDIDATES = 8;

/**
 * Resolves the AST-backed declaration range for every `decision` request
 * item's candidate declaration files found in `query`, bounded per item by
 * `MAX_DECISION_TREE_SITTER_CANDIDATES`.
 *
 * `collectSymbols` (symbols/collectSymbols.ts) is the AST itself — the same
 * tree-sitter walk `getSymbolWithContext`'s own `findSymbolWithTreeSitter`
 * performs, and the reason this no longer goes through
 * `getSymbolWithContext`: that tool answers `ok:true` from a REGEX fallback
 * when the grammar misses, and a regex-derived range is exactly the class of
 * evidence the P1 ruling (2026-09-07) forbids as a proof source. A language
 * with no collector, a grammar that fails to load, or a parse that finds no
 * such declaration all leave this map WITHOUT an entry, which
 * `declarationRangeInFile` reports as `{source:"unresolved"}` — honestly
 * unconfirmed, never estimated. A throw is likewise skipped: an AST defect
 * must never fail the whole pack, it just makes that candidate unconfirmed.
 */
export async function resolveDecisionAstRanges(
  workspace: string,
  query: string,
  universe: FindTextUniverse,
  contentCache: ScanContentCache,
): Promise<Map<string, Map<string, LineSpan>>> {
  const out = new Map<string, Map<string, LineSpan>>();
  const index = createRequestItemIndexView({ relPaths: universe.files.map((f) => f.relPath) });
  const items = extractRequestItems(query, index);
  for (const item of items) {
    if (item.kind !== "decision" || item.terms.length === 0) continue;
    const identifier = item.terms[0]!;
    const candidates = declarationCandidatePaths(workspace, universe, identifier, contentCache)
      .slice(0, MAX_DECISION_TREE_SITTER_CANDIDATES);
    for (const candidate of candidates) {
      const content = readCached(workspace, candidate);
      if (content === undefined) continue;
      const lang = languageForPathWithContent(candidate, content);
      if (lang === undefined) continue;
      let symbols: Awaited<ReturnType<typeof collectSymbols>>;
      try {
        symbols = await collectSymbols(content, lang, {});
      } catch {
        continue;
      }
      const match = symbols.find((symbol) => symbol.name === identifier);
      if (match === undefined) continue;
      let byIdentifier = out.get(candidate);
      if (byIdentifier === undefined) { byIdentifier = new Map(); out.set(candidate, byIdentifier); }
      byIdentifier.set(identifier, { start: match.startLine, end: match.endLine });
    }
  }
  return out;
}

/**
 * Async pre-pass entry point — called once near the top of `buildTaskPack`,
 * before `packByteCeilingStorage.run`/`buildTaskPackCore` (see the module
 * doc comment above `MAX_DECISION_TREE_SITTER_CANDIDATES`). Mirrors
 * `buildRequestItemReadiness`'s own cheap, index-free pre-gate
 * (`extractRequestItems(query).length < 2`) so the overwhelming majority of
 * single-target queries pay for neither a universe walk nor any AST parse
 * here.
 */
export async function prepareRequestItemPrewalk(workspace: string, query: string): Promise<RequestItemPrewalk | undefined> {
  if (extractRequestItems(query).length < 2) return undefined;
  let universe: FindTextUniverse;
  try {
    universe = enumerateFindTextUniverse(workspace);
  } catch {
    return undefined;
  }
  const contentCache = createScanContentCache();
  const astDeclarationRanges = await resolveDecisionAstRanges(workspace, query, universe, contentCache);
  return { universe, contentCache, astDeclarationRanges };
}

export function coordinatedPointUndetermined(item: RequestItem, proof: RequestItemProof): { id: string; term: string; reason: string } {
  const pointWords = concernTopicTerms(item.text);
  const candidates = proof.candidatePaths.slice(0, 3);
  return {
    id: item.id,
    term: (pointWords.length > 0 ? pointWords : [item.text.trim()]).join("/"),
    reason: candidates.length > 0
      ? `unserved candidate(s) ${candidates.join(", ")}${proof.candidatePaths.length > candidates.length ? ` and ${proof.candidatePaths.length - candidates.length} more` : ""} — not located in this pack; not a verified absence`
      : "nothing served covers this point — not located in this pack; not a verified absence",
  };
}

/**
 * R-B1 (2026-09-21, review B3 / held 9) — "disclose truthfully or not at
 * all" for a Japanese clause. `concernTermVariants` drops GENERIC bridge
 * tokens ("cache") from a JA term's search variants, and rightly so for
 * CANDIDACY: a compound like レディスキャッシュ must still be disclosed absent
 * when only the generic half exists. But the same filtering made the veto
 * blind to what the clause's statement is ABOUT: キャッシュが期限切れの場合の処理
 * ("the processing when the cache has expired") shipped "no occurrence …;
 * scope complete" beside the served `class Cache` whose `get()` performs the
 * very expiry check — the clause's subject was on the wire, only its kanji
 * predicate had no glossary counterpart in the workspace vocabulary.
 *
 * The two cases differ in the MECHANISM that failed to find the missing
 * part, which is what makes the rule general rather than lexical luck: a
 * katakana loanword is transliterated phonetically against the workspace
 * vocabulary (`bridgeJaQuery`'s katakana route), so a miss means that name
 * genuinely has no counterpart here — a checkable absence (Redis). A kanji
 * concept word reaches English only through the hand-kept glossary, whose
 * miss is NOT proof: code spells expiry as ttl / maxAge / stale as often as
 * expire. So: when some bridged part of the clause (generic included) sits at
 * a real CODE position in a served code surface, and what is left unbridged
 * still carries a kanji concept word, the claim cannot be verified and is
 * not made. It only ever REMOVES an absence; a clause with no served subject,
 * or whose unbridged remainder is a loanword, keeps today's disclosure.
 */
export function japaneseClauseUnverifiableBesideServedSubject(
  word: string,
  itemText: string,
  priorEvidence: readonly TaskPackSurface[],
  workspace: string,
): boolean {
  if (!containsJapanese(word) || !jaQueryBridgeEnabled()) return false;
  // R-B3 (ruling 3): a term carrying a loanword with no counterpart in the
  // workspace is a CHECKABLE absence (this veto's own premise: "a miss means
  // that name genuinely has no counterpart here") — never vetoed as
  // unverifiable, even when a generic half such as キャッシュ is served.
  if (jaTermHasUnresolvedLoanword(word, workspace)) return false;
  let expansions: ReturnType<typeof bridgeJaQuery>["expansions"];
  try {
    expansions = bridgeJaQuery(word, getWorkspaceJaBridgeVocabulary(workspace)).expansions;
  } catch {
    return false;
  }
  if (expansions.length === 0) return false;
  let remainder = word;
  for (const expansion of expansions) {
    if (expansion.source.length > 0) remainder = remainder.split(expansion.source).join(" ");
  }
  if (!KANJI_CHAR_RE.test(remainder)) return false;
  const tokens = [...new Set(expansions.flatMap((expansion) => expansion.tokens))]
    .filter((token) => token.length > 0 && !LIGHT_VERB_WORDS.has(token.toLowerCase()));
  if (tokens.length === 0) return false;
  const docAnchorsAllowed = concernAdmitsDocAnchor(itemText);
  return priorEvidence.some((surface) => hasServedCode(surface)
    && docAnchorsEligible(itemText, surface)
    && tokens.some((token) => concernTermAnchoredInSurface(surface, token, docAnchorsAllowed).codePosition));
}
