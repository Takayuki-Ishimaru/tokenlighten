// sourceAndConcernTerms — extracted implementation; imports point to the owning modules.
import * as path from "path";
import type { FindTextUniverse } from "../../search/find/findText.js";
import type { RequestItem } from "../requestItems.js";
import type { ScanContentCache } from "../../search/find/findText.js";
import type { ScanCoverage } from "../../search/find/findText.js";
import type { TaskPackSurface } from "../model.js";
import { DOC_MENTION_WORD_RE } from "./requestItemAbsence2.js";
import { GENERIC_SOFTWARE_ABSENCE_WORDS } from "./concernProof3.js";
import { LIGHT_VERB_WORDS } from "./concernProof3.js";
import { SALIENT_WORD_EVIDENCE_STEM_MIN } from "./sourceAndConcernTerms2.js";
import { boundedTextMemo } from "../../../util/boundedTextMemo.js";
import { classifySurface } from "../../../util/impact.js";
import { containsJapanese } from "../../retrieval/jaQueryBridge.js";
import { createScanCoverage } from "../../search/find/findText.js";
import { currentFileLineCount } from "./sourceAndConcernTerms2.js";
import { declarationRangeInFile } from "./sourceAndConcernTerms2.js";
import { escapeRegExp } from "../../search/find/findText.js";
import { evidenceSurfacesForPath } from "./sourceAndConcernTerms.js";
import { getWorkspaceJaBridgeVocabulary } from "../../retrieval/jaBridgeWorkspaceVocab.js";
import { inflectionVariants } from "../salientWordMatch.js";
import { isEscapedAt } from "./sourceAndConcernTerms2.js";
import { isSalientWordEvidenceExcludedToken } from "./sourceAndConcernTerms2.js";
import { jaBridgeExpansionTokens } from "../../retrieval/queryRecoveryTerms.js";
import { jaQueryBridgeEnabled } from "../../../util/flags.js";
import { katakanaGlossarySpellings } from "../requestItems.js";
import { katakanaRunsOf } from "../requestItems.js";
import { languageForPath } from "../../../util/languages.js";
import { lightStem } from "./sourceAndConcernTerms2.js";
import { lineCommentMarkerIndex } from "./sourceAndConcernTerms2.js";
import { lineSpansCover } from "./sourceAndConcernTerms.js";
import { looksLikeFileTerm } from "../requestItems.js";
import { parsePackLineRange } from "./packState2.js";
import { readCached } from "./packBasics2.js";
import { salientWords } from "../requestItems.js";
import { scanLiteral } from "../../search/find/findText.js";
import { servedLineSpansOf } from "./sourceAndConcernTerms.js";
import { servedSurfaceText } from "./changeAndReadinessEvidence2.js";
import { splitIdentifierWords } from "./sourceAndConcernTerms2.js";
import { stemForAbsenceCheck } from "./sourceAndConcernTerms2.js";
import { textHasWordVariant } from "../salientWordMatch.js";
import { totalOmittedPaths } from "../../search/find/findText.js";
import { unresolvedKatakanaRuns } from "../../retrieval/jaQueryBridge.js";

/**
 * Review finding 2(a) fix (2026-09-08): true when `word`'s stem already
 * appears, case-insensitively, in `surface`'s served PATH or TEXT. A pack
 * must never disclose an absence for a request item its OWN evidence already
 * answers — the reviewer's exact contradiction: "its tests" reported absent
 * while `src/cache.test.ts` rides the same response's `evidence`, because the
 * literal plural "tests" never appears in that file's CONTENT and the
 * pre-existing check never looked at its PATH.
 *
 * DESIGN-v0.15 R1 §4.2 follow-up (2026-09-08): the stem/substring check
 * above only widens a PLURAL word to its singular — it still missed a
 * different LEXICAL VARIANT of an already-served identifier ("expiry"
 * disclosed absent when the served code spells it "expiresAt"). Now also
 * true when the request word's OWN light stem (`lightStem`, not
 * `stemForAbsenceCheck`'s plural-only strip) EXACTLY equals the stem of some
 * word split out of the surface's path or text (`splitIdentifierWords`),
 * excluding any served word that is itself a bare language keyword or
 * generic software term (`isSalientWordEvidenceExcludedToken` — review
 * finding 3: a fixed-length PREFIX check here previously let a short common
 * token like "const"/"entry" wrongly evidence an unrelated longer word like
 * "constant"/"entryway" merely by sharing its first few letters; exact stem
 * equality plus this exclusion closes that without reopening the
 * "expiry"/"expiresAt" case the prefix check existed for). Plural-stripping
 * and lexical-variant stem-matching are independent widenings of the same
 * "never disclose an absence evidence already answers" rule; either alone
 * still only WIDENS evidence, never narrows a genuine absence.
 */
export function surfaceEvidencesSalientWord(surface: TaskPackSurface, word: string): boolean {
  const stem = stemForAbsenceCheck(word);
  if (stem.length === 0) return false;
  if (surface.path.toLowerCase().includes(stem)) return true;
  const text = servedSurfaceText(surface);
  if (text.toLowerCase().includes(stem)) return true;
  const wordStem = lightStem(word);
  if (wordStem.length < SALIENT_WORD_EVIDENCE_STEM_MIN) return false;
  return salientEvidenceStems(surface.path).has(wordStem) || salientEvidenceStems(text).has(wordStem);
}

export const salientEvidenceStems = boundedTextMemo((text: string): ReadonlySet<string> => {
  const stems = new Set<string>();
  for (const token of splitIdentifierWords(text)) {
    if (isSalientWordEvidenceExcludedToken(token)) continue;
    const tokenStem = lightStem(token);
    if (tokenStem.length >= SALIENT_WORD_EVIDENCE_STEM_MIN) stems.add(tokenStem);
  }
  return stems;
});

/**
 * TL_IDENTIFIER_GROUNDING (2026-09-20): true when `word` occurs in the SOURCE
 * lines `surface` serves -- its `range` minus every window it admits it did
 * not serve -- including the doc comments the embedded body elides. Same
 * plural-tolerant substring test `surfaceEvidencesSalientWord` opens with;
 * the lexical-variant widening stays exclusive to the visible text. Anything
 * unreadable or unparseable is "no": this only ever WIDENS what counts as
 * already served, and the safe failure is today's behaviour.
 */
export function servedRangeSourceHasSalientWord(surface: TaskPackSurface, word: string, workspace: string): boolean {
  const stem = stemForAbsenceCheck(word);
  if (stem.length === 0) return false;
  const span = parsePackLineRange(surface.range);
  if (span === undefined) return false;
  const holes: Array<[number, number]> = [];
  for (const window of surface.remaining_ranges ?? []) {
    const hole = parsePackLineRange(window);
    if (hole === undefined) return false;
    holes.push(hole);
  }
  const source = readCached(workspace, surface.path);
  if (source === undefined) return false;
  const lines = source.split(/\r?\n/);
  const last = Math.min(span[1], lines.length);
  for (let line = span[0]; line <= last; line++) {
    if (holes.some(([start, end]) => line >= start && line <= end)) continue;
    if ((lines[line - 1] ?? "").toLowerCase().includes(stem)) return true;
  }
  return false;
}

/**
 * C2 (fix-c, 2026-09-21, plan §6.1) — THE ONE generator for "every normalised
 * form of `word` this file will accept as evidence of it", consulted by BOTH
 * absence scanners (`distinctiveSalientAbsence` and
 * `proveUnbindableRequestItem`) so "found by search" and "not absent" can
 * never disagree — never a second, independently-tuned normalisation.
 * Routes to machinery already reviewed and shipped for RETRIEVAL, never a
 * fresh dictionary or heuristic of this function's own:
 *   - a word containing Japanese script: the SAME workspace-vocabulary-gated
 *     bridge retrieval already uses (`jaBridgeExpansionTokens` — katakana
 *     phonetic matching plus the kanji/kana glossary, `TL_JA_QUERY_BRIDGE`-
 *     gated, default ON); an unsegmented CJK clause is never treated as one
 *     opaque token. A bridged token this file's own Tier C would never
 *     accept as a DISTINGUISHING absence candidate (a bare "cache"/
 *     "implementation"/a light verb — `GENERIC_SOFTWARE_ABSENCE_WORDS`/
 *     `LIGHT_VERB_WORDS`) is filtered out of `variants` before it can count
 *     as evidence: a compound like レディスキャッシュ ("Redis Cache")
 *     bridging ONLY to the generic "cache" (its distinctive "Redis" half
 *     has no vocabulary match at all) must not read as "found" merely
 *     because the workspace has SOME cache — `tl_search_files`'s own recovery
 *     path is untouched and stays free to use the unfiltered token. Never
 *     filters the literal spelling itself, only bridge OUTPUT — when
 *     filtering leaves nothing, `variants` falls back to exactly the
 *     literal (untranslated) spelling, the pre-existing behaviour.
 *   - an ASCII word: `inflectionVariants` (salientWordMatch.ts) — plural/
 *     past/gerund/nominalisation, the same widening `proveUnbindableRequest
 *     Item`'s own H-1(ii) veto already trusted for English.
 * Never refactors retrieval ranking itself (C2's own limit) — this only
 * WIDENS the set of strings a caller may treat as "the same concern", the
 * same relationship `inflectionVariants` already documents for English.
 */
export interface ConcernTermVariants {
  /** `word` itself (as written, and lowercased) plus every normalised form. */
  readonly variants: readonly string[];
  /**
   * Ruling C1/C6: whether a literal miss over `variants` may be trusted as a
   * genuine "not found" rather than "could not determine". True for an
   * ASCII word unconditionally (`inflectionVariants` needs no workspace
   * lookup). For a word containing Japanese script, this tracks the BRIDGE
   * MECHANISM's availability (`TL_JA_QUERY_BRIDGE`), never its per-word
   * outcome — see `concernTermVariants`'s own doc comment for why keying
   * this on the raw bridge output instead (tempting, and correct in
   * isolation for one candidate) is unsafe for `proveUnbindableRequestItem`
   * callers, which evaluate this per word inside one item's WHOLE
   * salient-word list: a purely meta/framing JA fragment the same clause
   * also contributed (never a real domain concept, so the bridge
   * legitimately finds nothing for it) must never poison the aggregate's
   * verdict for the item's OTHER, genuine candidate words. With the flag
   * on, even a confirmed empty (or generic-only) bridge result is itself a
   * real, checked signal; with it off, the mechanism never ran at all, so a
   * literal miss proves nothing (ruling C6: `TL_JA_QUERY_BRIDGE=0` stays a
   * retrieval-only rollback — off, JA terms have no normalisation, so they
   * are "could not determine", never "absent").
   */
  readonly hasNormalization: boolean;
  /**
   * R2-T2 (2026-09-30, orchestrator RULING): the term carries a katakana
   * loanword run that NEITHER the workspace bridge NOR the glossary can spell
   * in English — its literal miss proves nothing, so it is never certified
   * absent (`hasNormalization` is false) and the callers disclose it as
   * undetermined ("katakana term with no known English spelling").
   */
  readonly unmappedKatakana?: boolean;
}

/** R-B3 (ruling 3): true when `word` is one of `item`'s own explicitly QUOTED literals — a literal string, so its miss is checkable whatever its script (TL142-04 Decision 6). */
export function quotedLiteralTerm(item: RequestItem, word: string): boolean {
  const lower = word.toLowerCase();
  return containsJapanese(word) && item.terms.some((term) => term.toLowerCase() === lower);
}

/** R-B3 (ruling 3): true when `word` carries a katakana loanword the workspace vocabulary has no counterpart for — see `unresolvedKatakanaRuns`. A failed vocabulary lookup is "no" (the safe, weaker verdict). */
export function jaTermHasUnresolvedLoanword(word: string, workspace: string): boolean {
  try {
    return unresolvedKatakanaRuns(word, getWorkspaceJaBridgeVocabulary(workspace)).length > 0;
  } catch {
    return false;
  }
}

export function concernTermVariants(word: string, workspace: string): ConcernTermVariants {
  const trimmed = word.trim();
  if (trimmed.length === 0) return { variants: [], hasNormalization: false };
  const variants = new Set<string>([trimmed, trimmed.toLowerCase()]);
  if (containsJapanese(trimmed)) {
    const bridged = jaBridgeExpansionTokens(trimmed, workspace);
    const meaningful = bridged.filter((t) => !GENERIC_SOFTWARE_ABSENCE_WORDS.has(t.toLowerCase()) && !LIGHT_VERB_WORDS.has(t.toLowerCase()));
    for (const token of meaningful) {
      variants.add(token);
      variants.add(token.toLowerCase());
    }
    // Ruling C1/C6: `hasNormalization` tracks the BRIDGE MECHANISM's
    // availability (`TL_JA_QUERY_BRIDGE`), not its per-word outcome.
    // Considered, and REJECTED, keying this on the raw bridge output
    // instead (`bridged.length > 0`): correct in isolation for a single
    // candidate (a compound like レディスキャッシュ bridging only to
    // generic "cache" still gets a real, checked "absent" — the bridge
    // confirmed nothing more specific exists), but `proveUnbindableRequest
    // Item` evaluates this per WORD inside one item's whole salient-word
    // list, and a purely meta/framing JA fragment salientWords() also
    // extracted from the SAME clause (confirmed live: "3点すべてに触れて
    // ください" -- "please touch on all 3 points" -- contributes
    // "点すべて"/"触れて", neither a real domain concept, so the bridge
    // legitimately finds nothing for either) would then poison the WHOLE
    // aggregate's `everyWordHasNormalization` into "could not determine",
    // silently blocking a genuine, reviewed absence disclosure
    // (requestItemCompletion.spec.ts's "splitLeadAndBody JA parity" case).
    // The flag is the one signal available uniformly at both call sites
    // without that risk: on, even a confirmed empty (or generic-only)
    // bridge result for a GENUINE candidate is itself a real, checked
    // outcome; off, the mechanism never ran at all, so a literal miss
    // proves nothing (ruling C6: `TL_JA_QUERY_BRIDGE=0` stays a
    // retrieval-only rollback — off, JA terms have no normalisation, so
    // they are "could not determine", never "absent").
    //
    // R-B3 (2026-09-21, orchestrator ruling 3; plan §6.1 「日本語原文の不一致を
    // 機能不在へ格上げしない」): with the flag ON, the per-word STRENGTH of a
    // miss now depends on the CHANNEL that could have found the term, never
    // on whether it did. A katakana loanword is bridged PHONETICALLY against
    // the workspace vocabulary (`unresolvedKatakanaRuns`), so a loanword with
    // no counterpart is a checkable miss, exactly as strong as an English
    // word (Q02's マイグレーション, a coined ヴァントレル). A term reachable only
    // through the hand-kept kanji glossary is a SEMANTIC guess — code spells
    // 期限切れ as ttl / maxAge / stale as often as expire — so its miss is
    // "could not determine", never absent-in-scope. A term whose loanword
    // part DID resolve (キャッシュ -> cache) leaves only its kanji remainder
    // unmatched, which is semantic. The aggregate over one item's words
    // still never lets a weak meta fragment poison a strong word (the
    // reviewed 3点すべてに触れてください case above): the callers certify
    // absence off the item's STRONG words only.
    //
    // R2-T2 (2026-09-30, orchestrator RULING — supersedes ruling 3's "a
    // loanword with no counterpart is a checkable miss"): a katakana loanword
    // names a concept the workspace would spell in ENGLISH, and the bridge's
    // workspace channel only knows the words the workspace already uses — a
    // concept spelled only in prose it does not index (a README's "health
    // probe" beside 「ヘルスプローブ」) is "unresolved" there too. So a literal
    // katakana miss is checkable only when an English spelling of it is
    // checked with it. Per katakana run:
    //   - resolved by the workspace bridge (キャッシュ -> cache): unchanged —
    //     the concept is spelled in this workspace, the term stays weak, its
    //     variants are the (non-generic) bridged tokens as before;
    //   - unresolved, but spelled completely by the glossary
    //     (`katakanaGlossarySpellings`, workspace-independent): that spelling
    //     joins the scan variants, and a term whose Japanese is nothing but
    //     such runs is STRONG — 「ダッシュボード」 with no "dashboard" anywhere
    //     is a verified absence, one with "dashboard" in a README is not;
    //   - unresolved and unspelled (ヘルスプローブ, a coined name): the term is
    //     weak and flagged `unmappedKatakana` — never certified absent, the
    //     callers disclose it undetermined.
    // A term with kanji/hiragana content keeps the semantic verdict: weak.
    const bridgeOn = jaQueryBridgeEnabled();
    const runs = katakanaRunsOf(trimmed);
    let unresolved: string[] = [];
    if (runs.length > 0) {
      try {
        unresolved = unresolvedKatakanaRuns(trimmed, getWorkspaceJaBridgeVocabulary(workspace));
      } catch {
        unresolved = [...runs];
      }
    }
    let unmappedKatakana = false;
    for (const run of unresolved) {
      const spellings = katakanaGlossarySpellings(run);
      if (spellings === undefined) {
        unmappedKatakana = true;
        continue;
      }
      for (const spelling of spellings) variants.add(spelling);
    }
    // Every katakana run glossary-spelled (none resolved by the workspace,
    // none unspelled) and no kanji/hiragana: an ASCII word written beside the
    // katakana is checked too, so the claim covers the whole term.
    const glossaryOnly = runs.length > 0 && unresolved.length === runs.length && !unmappedKatakana
      && !/[぀-ゟ㐀-䶿一-鿿々]/u.test(trimmed);
    if (glossaryOnly) {
      for (const word of trimmed.match(/[A-Za-z][A-Za-z0-9_]{2,}/gu) ?? []) {
        variants.add(word);
        variants.add(word.toLowerCase());
      }
    }
    return {
      variants: [...variants],
      hasNormalization: bridgeOn && glossaryOnly,
      ...(bridgeOn && unmappedKatakana ? { unmappedKatakana: true } : {}),
    };
  }
  for (const variant of inflectionVariants(trimmed)) variants.add(variant);
  return { variants: [...variants], hasNormalization: true };
}

/**
 * C4 (fix-c, 2026-09-21, plan §6.1 last paragraph / Q06) — an absence
 * statement's scope must be honest about everything it did NOT actually
 * search, not just what the workspace WALK excluded up front
 * (`WalkOmissions` — .gitignore/.tokenlightenignore/oversize/symlinks/...,
 * computed once at enumeration time). A file the walk enumerated and opened
 * but could not decode as text is invisible to `WalkOmissions` — findText.ts's
 * own `ScanCoverage.undecodable` doc comment: "never folded into scanned...
 * that would certify absence over content nobody actually read" — but is
 * exactly the same honesty risk: a term whose only occurrence sits inside
 * that unreadable file must never be certified "scope complete". Combines
 * both signals the same way `findText.ts`'s own absence-extra machinery
 * already does for `tl_search_files find`
 * (`anyWalkOmission(...) || coverage.undecodable.size > 0`) — every
 * `scanLiteral` call in the two functions below shares ONE per-call
 * `ScanCoverage` so this can see every file either scanner skipped.
 */
/**
 * N7(c) (r-b2, 2026-09-21, review finding N7) — `WalkOmissions.ignored`
 * (DEFAULT_IGNORE's heuristic layer) is where a top-level `.git` directory
 * always lands, so `anyWalkOmission`/`totalOmittedPaths` alone make EVERY
 * git-tracked workspace's scan "incomplete" purely from skipping VCS
 * plumbing no query could ever mean to search — confirmed live: an ordinary
 * two-file workspace with nothing else excluded still reported
 * `scope_complete:false, omitted_count:1` for its `.git` directory alone.
 * `vcs_metadata` (walkRepo.ts) is a SUBSET of `ignored` (the walker
 * increments both for the same `.git` entry, never one without the other),
 * so subtracting it back out here can never go negative and never hides a
 * DIFFERENT DEFAULT_IGNORE exclusion sharing the same `ignored` bucket
 * (`node_modules/`, `dist/`, `vendor/`, …stay real, disclosed omissions).
 * Deliberately does NOT call `anyWalkOmission`/reuse its exact boolean —
 * those stay untouched for every OTHER caller (e.g. `search.tree`'s own
 * `scope_report`, whose `excluded_by_reason`/`counts.excluded` invariant
 * this must not perturb: `ignored` itself, and everything derived from it
 * there, is unchanged by this fix) — this is a second, narrower honesty
 * question local to the absence-scope wording built below.
 */
export function scopeCompletenessAfterScan(universe: FindTextUniverse, coverage: ScanCoverage): { scopeComplete: boolean; omittedCount: number } {
  const o = universe.omissions;
  const meaningfulIgnored = Math.max(0, o.ignored - o.vcs_metadata);
  const meaningfulOmission =
    meaningfulIgnored > 0
    || o.gitignored > 0
    || o.tokenlighten_ignored > 0
    || o.oversize > 0
    || o.symlinks > 0
    || o.non_text > 0
    || o.secrets > 0
    || o.unreadable_dirs > 0
    || o.outside_workspace > 0
    || o.source_only_excluded > 0;
  const scopeComplete = !meaningfulOmission && coverage.undecodable.size === 0;
  const omittedCount = scopeComplete ? 0 : Math.max(0, totalOmittedPaths(o) - o.vcs_metadata) + coverage.undecodable.size;
  return { scopeComplete, omittedCount };
}

// ---------------------------------------------------------------------------
// FIX-C2 (2026-09-21, plan §5「完了ゲート」/ §6.1) — THE ONE CONCERN-STATUS
// POLICY.
//
// Before this section a concern's status was decided in FOUR places with four
// rule sets that disagreed: `proveUnbindableRequestItem`'s pre-search
// `alreadyServed` (two different bars depending on an opt-in flag), its
// post-search `majorityFloor` check, `absenceContradictsServedEvidence`'s C1
// veto, and — in the mixed-kind loop — nothing at all. Three consecutive
// waves each fixed one edge and each fix exposed the next:
//
//  - Q05 (four concerns): "Explain how authentication works" reduces to ONE
//    real topic word after light-verb filtering, and the two floors were
//    sized from the PRE-filter word count (`min(2, rawWordCount)` = 2), so
//    the bar was UNREACHABLE — `src/auth.ts` could be served in the SAME
//    response that reported its concern still open.
//  - Q02 (JA, asymmetric fixture): the mirror image. A JA clause is ONE
//    unsegmented salient word, so `min(2, 1)` = 1 and a single incidental
//    bridged mention inside a comment that explicitly DISCLAIMS the concept
//    ("no migration/DDL code lives in this fixture") certified a genuinely
//    absent concern COVERED — and so never disclosed it at all.
//
// Both are the same mistake: counting HOW MANY DIFFERENT WORDS a clause has
// instead of asking WHERE the concern's term lives in the surface that is
// supposed to answer it. This section replaces both floors with one rule:
//
//    covered(surface) := the surface carries served CODE, at least ONE of the
//    concern's topic terms is evidenced in it, and either TWO distinct topic
//    terms are (today's concentration bar, kept for multi-word clauses) or
//    the term is ANCHORED there — it is in the file's PATH, it occurs at a
//    real CODE position (outside comments and string literals), or it occurs
//    more than once in that one surface.
//
// The anchor is what makes the bar reachable for a one-topic-word concern
// without reopening the defect FIX-C's `rawWordCount` sizing was written for
// (its own comment, now superseded, is reproduced in this wave's report): a
// README that merely narrates "authentication (`src/auth.ts`)" is a DOC-role
// surface, so it can never anchor, and a single prose/comment mention in a
// code file is not a code position and is not a repeat. The implementing
// module always anchors — `authenticateRequest` sits at a code position in
// `src/auth.ts`, `lookupStoredCredential` in `store.ts` — in ANY language,
// because the anchor is positional, never a hand-kept keyword list.
//
// INVARIANT (i) "covered => never absent in the same response" is enforced by
// this being the FIRST question every path asks, so no path can skip it.
// INVARIANT (ii) holds because the evidence it reads is the epoch-served view
// (`epochServedEvidence`, sha-gated) rather than one call's fresh surfaces.
// Each path keeps its OWN reviewed routing of what a non-covered status DOES
// (the ALL-TOPIC branch still mints no blocking obligation — invariant (iv);
// only `requireDistinctConcentration` callers may mint an absence out of
// "every candidate served but unconcentrated").
// ---------------------------------------------------------------------------

/** plan §5's status vocabulary (also `TL_TRACE`'s `request_item_status`). */
export type ConcernStatus = "covered" | "absent-in-scope" | "could-not-determine" | "open";

/**
 * A concern's TOPIC terms — the ONE derivation every path uses. `salientWords`
 * minus `LIGHT_VERB_WORDS` (C3: "Explain how authentication works" asks about
 * authentication, never about the word "works").
 *
 * WP-C (2026-09-29, eval-0929 §6/§8) tried, then REVERTED, widening this
 * filter to also drop `GENERIC_SOFTWARE_ABSENCE_WORDS`/JA generic terms: this
 * pool is not only the absence-scan candidate list — `proveUnbindableRequest
 * Item` also feeds it, UNFILTERED, to `concernCoveredByServedEvidence` to
 * decide whether the item is covered AT ALL. Measured regression
 * (requestItemCompletion.spec.ts "expiry stays suppressed by the served
 * expiresAt"): the query names "the Cache.get expiry"; "Cache" (a listed
 * generic word) is what made `concernCoveredByServedEvidence` see the served
 * Cache.get surface as covering this item at all — dropping "Cache" from the
 * pool here left only "expiry" for BOTH the coverage check and the absence
 * scan, so coverage failed and "expiry" (never itself generic) was then
 * certified absent, though the same served surface already answers the
 * point. The generic-word exclusion this fix needs is scoped to
 * `proveUnbindableRequestItem`'s OWN final reporting step instead (see its
 * "no occurrence" branch below), which never touches the coverage check.
 */
export function concernTopicTerms(itemText: string): string[] {
  return salientWords(itemText).filter((word) => !LIGHT_VERB_WORDS.has(word.toLowerCase()));
}

/**
 * R-B3 (2026-09-21, orchestrator ruling 1) — "is this topic term provably
 * absent from the WHOLE scanned scope?", the collision rule's test (see
 * `concernCoveredByServedEvidence`). A term is provably absent only when NONE
 * of its forms occurs anywhere in the scan universe: not the literal, not an
 * inflected or derived variant (`concernTermVariants` — the SAME generator
 * every absence scanner uses), not inside an identifier (`textHasWordVariant`
 * re-verifies every substring hit on its own line, so `tag` inside `stage`
 * is no occurrence while `replenish` inside `replenishInventory` is one), and
 * not in any file NAME (the path-name occurrence rule of
 * `proveUnbindableRequestItem`). A Japanese term counts only when its miss is
 * checkable (ruling 3: `hasNormalization` — a loanword with no counterpart);
 * a glossary-only term is never "provably absent". Memoised per scan
 * universe and term; every scan books into ONE coverage record so the
 * absence's scope qualifier is honest (C4).
 */
export interface ConcernAbsenceProbe {
  provablyAbsent(term: string): boolean;
  scope(): { scopeComplete: boolean; omittedCount: number };
}

export interface ConcernAbsenceMemoEntry { absent: boolean; scopeComplete: boolean; omittedCount: number }

export const concernAbsenceMemo = new WeakMap<FindTextUniverse, Map<string, ConcernAbsenceMemoEntry>>();

export function concernAbsenceProbe(
  workspace: string,
  universe: FindTextUniverse,
  variantsByTerm: ReadonlyMap<string, ConcernTermVariants>,
  contentCache?: ScanContentCache,
): ConcernAbsenceProbe {
  let memo = concernAbsenceMemo.get(universe);
  if (memo === undefined) {
    memo = new Map();
    concernAbsenceMemo.set(universe, memo);
  }
  const cache = memo;
  const consulted: ConcernAbsenceMemoEntry[] = [];
  const occurs = (term: string, entry: ConcernTermVariants, coverage: ScanCoverage): boolean => {
    const japanese = containsJapanese(term);
    const variants = entry.variants.filter((variant) => variant.length > 0);
    for (const variant of variants) {
      for (const match of scanLiteral(variant, workspace, { files: universe.files, caseInsensitive: true, coverage, ...(contentCache ? { contentCache } : {}) })) {
        if (japanese || containsJapanese(variant)) return true;
        if (match.text === undefined || textHasWordVariant(match.text, term) || textHasWordVariant(match.text, variant)) return true;
      }
    }
    for (const file of universe.files) {
      const nameWithoutExtension = file.relPath.replace(/\.[^./]+$/u, "");
      if (variants.some((variant) => (containsJapanese(variant) ? nameWithoutExtension.includes(variant) : textHasWordVariant(nameWithoutExtension, variant)))) return true;
    }
    return false;
  };
  return {
    provablyAbsent(term: string): boolean {
      const key = term.toLowerCase();
      let known = cache.get(key);
      if (known === undefined) {
        const entry = variantsByTerm.get(term) ?? concernTermVariants(term, workspace);
        const coverage = createScanCoverage();
        // Generic software vocabulary ("entries", "value", "cache", …) is never
        // a DISCLOSABLE absence (`GENERIC_SOFTWARE_ABSENCE_WORDS`'s own test:
        // its absence tells a reader nothing distinguishing), so it can never
        // be the term that blocks an anchor either — "how entries are
        // invalidated" against a map-backed `invalidate(k)` is not a collision.
        const absent = !GENERIC_SOFTWARE_ABSENCE_WORDS.has(key)
          && entry.hasNormalization
          && entry.variants.length > 0
          && !occurs(term, entry, coverage);
        known = { absent, ...scopeCompletenessAfterScan(universe, coverage) };
        cache.set(key, known);
      }
      consulted.push(known);
      return known.absent;
    },
    // The weakest qualifier among every term this probe decided: an absence
    // is "scope complete" only when none of the scans behind it skipped a file.
    scope: () => ({
      scopeComplete: consulted.every((entry) => entry.scopeComplete),
      omittedCount: consulted.reduce((max, entry) => Math.max(max, entry.omittedCount), 0),
    }),
  };
}

/** One `concernTermVariants` set per topic term, computed once per concern and reused by every check below. */
export function concernVariantMap(terms: readonly string[], workspace: string): Map<string, ConcernTermVariants> {
  const map = new Map<string, ConcernTermVariants>();
  for (const term of terms) {
    if (!map.has(term)) map.set(term, concernTermVariants(term, workspace));
  }
  return map;
}

/**
 * May a DOC-role surface anchor this concern? Only when the concern itself
 * asks about documentation — the same recall control `nonDocNoiseCandidate-
 * Paths` and `isClauseCoveredBySeededSurfaces` already apply, so the three
 * places that judge "is a README the answer?" agree. A doc surface is never
 * excluded outright (it can still satisfy the two-distinct-terms bar), so
 * this never drops the last surface: it only stops a narration of a concern's
 * NAME from outranking the module that implements it.
 */
export function concernAdmitsDocAnchor(itemText: string): boolean {
  return DOC_MENTION_WORD_RE.test(itemText);
}

/** A doc-role surface speaks for a concern only when the concern asks about docs — the same recall control, reused by the absence veto. */
export function docAnchorsEligible(itemText: string, surface: TaskPackSurface): boolean {
  return classifySurface(surface.path) !== "doc" || concernAdmitsDocAnchor(itemText);
}

/**
 * The served text with line comments, block comments and quoted runs removed,
 * so "occurs at a code position" can be asked with the SAME camelCase-aware
 * whole-word matcher (`textHasWordVariant`) every other check uses — a bare
 * `indexOf` cannot, because "authenticate" inside `authenticateRequest` fails
 * its own identifier-boundary test. Same line-comment / block-comment /
 * quoted-run rules as `forEachCodePositionOccurrence` above (that function
 * decides per OCCURRENCE and so cannot hand back a per-line projection).
 */
export function concernCodeOnlyText(text: string, language: string | undefined): string {
  let memo = concernCodeOnlyTextByLanguage.get(language);
  if (memo === undefined) {
    memo = boundedTextMemo((source) => deriveConcernCodeOnlyText(source, language));
    concernCodeOnlyTextByLanguage.set(language, memo);
  }
  return memo(text);
}

export const concernCodeOnlyTextByLanguage = new Map<string | undefined, (text: string) => string>();

export function deriveConcernCodeOnlyText(text: string, language: string | undefined): string {
  const parts: string[] = [];
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
    parts.push(stripQuotedRuns(codePart));
    const openAt = rawLine.indexOf("/*");
    if (openAt >= 0 && rawLine.indexOf("*/", openAt + 2) < 0) inBlockComment = true;
  }
  return parts.join("\n");
}

/** Replace every single/double/backtick-quoted run of ONE line with spaces (naive, unnested — the same "good enough" scope `isInsideQuotesAt` documents). */
export function stripQuotedRuns(line: string): string {
  let out = "";
  let quote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote === undefined) {
      if ((ch === "\"" || ch === "'" || ch === "`") && !isEscapedAt(line, i)) {
        quote = ch;
        out += " ";
        continue;
      }
      out += ch;
    } else {
      out += " ";
      if (ch === quote && !isEscapedAt(line, i)) quote = undefined;
    }
  }
  return out;
}

/** Whole-word (camelCase-aware) occurrences of `variant` in `text`, counted up to `cap`. CJK variants have no identifier decomposition, so they fall back to a substring count. */
export function concernVariantOccurrences(text: string, variant: string, cap = 2): number {
  if (variant.length === 0) return 0;
  if (containsJapanese(variant)) {
    const hay = text.toLowerCase();
    const needle = variant.toLowerCase();
    let count = 0;
    let from = 0;
    for (;;) {
      const at = hay.indexOf(needle, from);
      if (at < 0) return count;
      count += 1;
      if (count >= cap) return count;
      from = at + needle.length;
    }
  }
  const target = variant.toLowerCase();
  let count = 0;
  for (const word of splitIdentifierWords(text)) {
    if (word.toLowerCase() === target) {
      count += 1;
      if (count >= cap) return count;
    }
  }
  return count;
}

/**
 * WHERE the term lives: the three positional signals that distinguish "this
 * surface is about the concern" from "this surface mentions the concern once,
 * in prose". Never a word count.
 */
export function concernTermAnchoredInSurface(
  surface: TaskPackSurface,
  variant: string,
  docAnchorsAllowed: boolean,
): { anchored: boolean; codePosition: boolean } {
  const none = { anchored: false, codePosition: false };
  if (!docAnchorsAllowed && classifySurface(surface.path) === "doc") return none;
  const text = servedSurfaceText(surface);
  // (a) CODE POSITION — outside comments and string literals, in any
  // language (positional, never a per-language declaration keyword list).
  if (textHasWordVariant(concernCodeOnlyText(text, languageForPath(surface.path)), variant)) {
    return { anchored: true, codePosition: true };
  }
  // A PATH match is deliberately NOT an anchor. It still EVIDENCES the term
  // (the caller's `surfaceEvidencesSalientWord` channel — the reviewed "its
  // tests" vs a served `src/cache.test.ts` case), but it says nothing about
  // whether the bytes actually delivered explain the concern. Confirmed live
  // on the matrix: a one-topic-word concern ("how renewal works") certified
  // itself covered from a single served line of `src/sessionRenewal.ts` —
  // the file's interface header — while `renewSessionToken`, the function
  // that answers it, was never on the wire. Anchors are about the SERVED
  // CONTENT; the path only ever contributes a term to the two-term bar.
  //
  // (b) REPEATED use inside this ONE surface's served content.
  return concernVariantOccurrences(text, variant) >= 2 ? { anchored: true, codePosition: false } : none;
}

/**
 * GATE-B (2026-09-21, closes the confirmed `calc.ts` request-side
 * regression): true when `itemText` NAMES `relPath` directly — its full
 * relative path, or its basename WITH EXTENSION, spelled out verbatim
 * (case-insensitive, word-boundary guarded so "calc.ts" never matches
 * inside "calc.tsx" or "mycalc.ts"). Deliberately narrower than the
 * pre-existing bare path-NAME-match pass (`proveUnbindableRequestItem`'s own
 * "a file whose own NAME carries the concern's term" scan, which strips the
 * extension and accepts any path SEGMENT): a bare directory name, or an
 * extension-less word that merely equals a path segment, must stay exactly
 * as unnamed as FIX-C2 left it (its own false anchor: a clause naming
 * "session renewal" credited by the fragment "renewal" inside
 * `src/sessionRenewal.ts`). The dot (or a real leading directory component)
 * is exactly what makes the reference unambiguous enough to name an
 * artefact on its own.
 */
export function concernNamesServedPath(itemText: string, relPath: string): boolean {
  const base = path.basename(relPath);
  const candidates = new Set<string>();
  if (relPath.includes("/")) candidates.add(relPath);
  if (looksLikeFileTerm(base)) candidates.add(base);
  for (const candidate of candidates) {
    if (new RegExp(`\\b${escapeRegExp(candidate)}\\b`, "iu").test(itemText)) return true;
  }
  return false;
}

/**
 * True when THIS epoch's served spans for `relPath` cover the file's WHOLE
 * current line range — "no real remainder" (GATE-B's ruling). Deliberately
 * NOT the same question `proveUnbindableRequestItem`'s own
 * `candidateFullyServed` asks (whether some one surface's OWN claimed range
 * came through with nothing trimmed FROM IT — true even for a narrow
 * symbol-scoped slice): a concern whose only wording IS the file's name has
 * nothing else to concentrate on, so nothing short of the WHOLE file
 * answers it. Reuses the exact union machinery DESIGN-v0.15 R1 built for
 * declaration-range coverage rather than a second line-math implementation.
 */
export function pathServedWholeFile(priorEvidence: readonly TaskPackSurface[], relPath: string, workspace: string): boolean {
  const surfacesForPath = evidenceSurfacesForPath(priorEvidence, relPath);
  if (surfacesForPath.length === 0) return false;
  const totalLines = currentFileLineCount(workspace, relPath);
  if (totalLines === undefined) return false;
  return lineSpansCover(servedLineSpansOf(surfacesForPath), { start: 1, end: totalLines });
}

/**
 * GATE-B: true when `term` is a symbol AST-DECLARED in `relPath`, and that
 * declaration's own range lies inside this epoch's served spans for it — the
 * same "named artefact is covered by serving it" rule as
 * `concernNamesServedPath` above, for a symbol instead of a file. Deliberately
 * authoritative (AST-resolved) rather than routed through the code-position
 * anchor's own literal-EN/two-term gate above, so a declared symbol named as
 * a concern's ONLY topic term (amid unrelated prose the anchor's
 * `anchorRouteAvailable` gate would otherwise require) is still covered.
 */
export function concernNamesDeclaredSymbol(
  term: string,
  relPath: string,
  priorEvidence: readonly TaskPackSurface[],
  workspace: string,
): boolean {
  const decl = declarationRangeInFile(workspace, relPath, term);
  if (decl.source !== "ast") return false;
  const served = servedLineSpansOf(evidenceSurfacesForPath(priorEvidence, relPath));
  return lineSpansCover(served, decl.span);
}
