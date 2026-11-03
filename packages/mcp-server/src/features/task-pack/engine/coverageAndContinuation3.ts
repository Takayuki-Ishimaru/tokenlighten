// coverageAndContinuation — extracted implementation; imports point to the owning modules.
import { ANALYSIS_INTENT_EN_RE } from "./coverageAndContinuation2.js";
import { ANALYSIS_INTENT_JA } from "./coverageAndContinuation2.js";
import { ANSWER_INTENT_EN_RE } from "./coverageAndContinuation2.js";
import { ANSWER_INTENT_JA } from "./coverageAndContinuation2.js";
import { ANSWER_INTENT_JA_NOUN_RE } from "./coverageAndContinuation2.js";
import { ARTIFACT_BUILD_INTENT_EN_RE } from "./coverageAndContinuation2.js";
import { ARTIFACT_BUILD_INTENT_JA } from "./coverageAndContinuation2.js";
import { ARTIFACT_BUILD_REFERENCE_EN_RE } from "./coverageAndContinuation2.js";
import { ARTIFACT_BUILD_REFERENCE_JA_RE } from "./coverageAndContinuation2.js";
import { ARTIFACT_EXTS } from "../../../tools/walkRepo.js";
import { CALL_THEN_INPUT_EN_RE } from "./coverageAndContinuation2.js";
import { COMPUTATION_REQUEST_LEAD_EN_RE } from "./coverageAndContinuation2.js";
import { EDIT_VERB_JA_ROOTS } from "../requestItems.js";
import { EXPLICIT_NO_EDIT_EN_RE } from "./coverageAndContinuation2.js";
import { EXPLICIT_NO_EDIT_JA_RE } from "./coverageAndContinuation2.js";
import { MODAL_WORD_EN_RE } from "./coverageAndContinuation2.js";
import { MUTATION_VERBS_EN } from "../requestItems.js";
import { PROPAGATION_INTENT_EN_RE } from "./coverageAndContinuation2.js";
import { PROPAGATION_INTENT_JA } from "./coverageAndContinuation2.js";
import { READ_VERB_JA_STEM_ROOTS } from "../requestItems.js";
import { READ_VERB_JA_SURU_ROOTS } from "../requestItems.js";
import { REFERENCE_ANSWER_EN_RE } from "./coverageAndContinuation2.js";
import { REFERENCE_ANSWER_JA_RE } from "./coverageAndContinuation2.js";
import { REQUESTED_MUTATION_EN_CONDITIONAL_RE } from "./coverageAndContinuation2.js";
import { REQUESTED_MUTATION_EN_RE } from "./coverageAndContinuation2.js";
import { REQUESTED_MUTATION_EN_RELATION_RE } from "./coverageAndContinuation2.js";
import { REQUESTED_MUTATION_JA_LINE_RE } from "./coverageAndContinuation2.js";
import { REQUESTED_MUTATION_JA_NOUN_RE } from "./coverageAndContinuation2.js";
import { REQUESTED_MUTATION_JA_RE } from "./coverageAndContinuation2.js";
import { SHAPE_LEAD_IN } from "./coverageAndContinuation2.js";
import { SHAPE_SENTENCE_SPLIT_RE } from "./coverageAndContinuation2.js";
import { WH_SUGGESTION_OPENING_EN_RE } from "./coverageAndContinuation2.js";
import { WIRING_INTENT_EN_RE } from "./coverageAndContinuation2.js";
import { WIRING_INTENT_JA } from "./coverageAndContinuation2.js";
import { hasEditProposalMarker } from "./coverageAndContinuation2.js";
import { hasJaInterrogativeDou } from "./coverageAndContinuation2.js";
import { isStructuralQuestion } from "./coverageAndContinuation2.js";
import { proofCompletionEnabled } from "../../../util/flags.js";
import { queryAsksForChange } from "../requestItems.js";
import { shapeSentences } from "./coverageAndContinuation2.js";
import { splitIntoLeadClauses } from "../requestItems.js";

/**
 * True when `query` reads as an explain/answer request AND carries no
 * edit-intent marker at all. Deliberately conservative — a query naming
 * BOTH an answer marker and an edit marker ("explain then fix the bug") is
 * left alone (ambiguous), same as a query with no answer marker at all;
 * buildRoute keeps whatever action its own coverage-driven logic decided in
 * either case.
 */
export function hasAnswerIntentMarker(query: string): boolean {
  return (proofCompletionEnabled() && (
    REFERENCE_ANSWER_EN_RE.test(query)
    || REFERENCE_ANSWER_JA_RE.test(query)
  ))
    || ANSWER_INTENT_EN_RE.test(query)
    || ANSWER_INTENT_JA.some((m) => query.includes(m))
    || ANSWER_INTENT_JA_NOUN_RE.test(query)
    || hasJaInterrogativeDou(query)
    || hasWhQuestionSentence(query)
    || hasComputationRequest(query)
    || hasAnalysisIntentMarker(query);
}

export function hasWhQuestionSentence(query: string): boolean {
  const sentences = shapeSentences(query);
  return sentences.some(isStructuralQuestion) && !hasEditProposalMarker(sentences);
}

export function hasComputationRequest(query: string): boolean {
  const sentences = shapeSentences(query);
  return sentences.some((sentence) => COMPUTATION_REQUEST_LEAD_EN_RE.test(sentence) && CALL_THEN_INPUT_EN_RE.test(sentence))
    && !hasEditProposalMarker(sentences);
}

export function hasAnalysisIntentMarker(query: string): boolean {
  return ANALYSIS_INTENT_EN_RE.test(query)
    || ANALYSIS_INTENT_JA.some((marker) => query.includes(marker));
}

export function hasRequestedMutationIntent(query: string): boolean {
  const positiveText = query
    .replace(EXPLICIT_NO_EDIT_EN_RE, " ")
    .replace(EXPLICIT_NO_EDIT_JA_RE, " ");
  return REQUESTED_MUTATION_EN_RE.test(positiveText)
    || REQUESTED_MUTATION_EN_CONDITIONAL_RE.test(positiveText)
    || REQUESTED_MUTATION_EN_RELATION_RE.test(positiveText)
    || REQUESTED_MUTATION_JA_RE.test(positiveText)
    || REQUESTED_MUTATION_JA_LINE_RE.test(positiveText)
    || REQUESTED_MUTATION_JA_NOUN_RE.test(positiveText);
}

/**
 * The request asks for a change: an EN mutation verb this file's own
 * profile reader recognizes (`hasRequestedMutationIntent`: "Fix Sum so …"),
 * or the explicit-path seeds' reading (requestItems.ts `queryAsksForChange`,
 * which also takes the casual JA 「修正して、…」 and an object-free "Fix it.").
 */
export function requestAsksForChange(query: string): boolean {
  return hasRequestedMutationIntent(query) || queryAsksForChange(query);
}

export function hasExplicitNoEditDeclaration(query: string): boolean {
  // The shared regexes carry /g/, so use match() rather than stateful test().
  return query.match(EXPLICIT_NO_EDIT_EN_RE) !== null
    || query.match(EXPLICIT_NO_EDIT_JA_RE) !== null;
}

// Identifier-embedded verbs are not task intent: 「renameSymbol の実装」 names
// rename only inside a camelCase identifier. The old lowercase substring test
// destroyed that boundary ("renamesymbol".includes("rename")); \brename\b on
// the RAW query cannot match inside renameSymbol/RENAME_TABLE (the next char
// is a word char), while prose requests ("rename X to Y", 「改名」) still do.
export const RENAME_REQUEST_EN_RE = /\brenam(?:e|es|ed|ing)\b/i;

export const RENAME_REQUEST_JA: readonly string[] = ["リネーム", "改名", "名前を変更", "名称を変更", "名称変更"];

export function hasRenameRequestMarker(query: string): boolean {
  return RENAME_REQUEST_EN_RE.test(query)
    || RENAME_REQUEST_JA.some((marker) => query.includes(marker));
}

/** Exported for independentReview1010.spec.ts (the 表示 false positive). */
export function hasArtifactBuildIntentMarker(query: string): boolean {
  const positiveText = query
    .replace(EXPLICIT_NO_EDIT_EN_RE, " ")
    .replace(EXPLICIT_NO_EDIT_JA_RE, " ");
  const hasEditIntent = ARTIFACT_BUILD_INTENT_EN_RE.test(positiveText)
    || ARTIFACT_BUILD_INTENT_JA.some((marker) => positiveText.includes(marker));
  if (!hasEditIntent) return false;
  // 2026-11-02 (external evaluation T2): "document it in docs/config.rst" uses
  // `document` as a VERB — an instruction to write documentation for a code
  // change, not a reference to a document artifact to build from. The verb
  // reading is what follows the word: an object pronoun/determiner/wh-word.
  // Classified artifact_build, the request's pack anchored on the Sphinx
  // `docs/conf.py` instead of the code the change belongs to.
  const referenceText = query.replace(DOCUMENT_VERB_EN_RE, " ");
  return ARTIFACT_BUILD_REFERENCE_EN_RE.test(referenceText)
    || ARTIFACT_BUILD_REFERENCE_JA_RE.test(query)
    || ARTIFACT_EXTS.some((ext) => query.toLowerCase().includes(ext));
}

/** `document` followed by what it documents: "document it/this/the change/how …" is a verb, never an artifact reference. */
export const DOCUMENT_VERB_EN_RE = /\bdocument\s+(?:it|this|that|them|these|those|the|a|an|each|every|all|any|both|your|our|its|his|her|their|how|what|which|when|where|why|new)\b/gi;

export function hasWiringIntentMarker(query: string): boolean {
  const positiveText = query
    .replace(EXPLICIT_NO_EDIT_EN_RE, " ")
    .replace(EXPLICIT_NO_EDIT_JA_RE, " ");
  if (positiveText !== query) return false;
  return WIRING_INTENT_EN_RE.test(positiveText)
    || WIRING_INTENT_JA.some((marker) => positiveText.includes(marker));
}

export function hasPropagationIntentMarker(query: string): boolean {
  return PROPAGATION_INTENT_EN_RE.test(query)
    || PROPAGATION_INTENT_JA.some((marker) => query.includes(marker));
}

// ---------------------------------------------------------------------------
// 2026-08-23 mixed-intent guard: an explicit mutation request PLUS a distinct
// enumeration/explanation sub-request must not classify as "answer".
//
// T07 (real field query this guard was cut for): "...credit-normal を考慮し
// てないっぽい。修正して、影響の出る型一覧も列挙して。" hasRequestedMutationIntent
// (above) deliberately requires 修正/直/実装/追加/変更/削除 to be followed by an
// explicit ください/て欲しい/たい/しろ/せよ suffix — see the note above
// REQUESTED_MUTATION_JA_NOUN_RE — because a bare te-form ("修正して") is also
// how a REPORT clause reads ("すでに修正して問題ない", nothing to do here). That
// same bare te-form is ALSO the everyday Japanese instruction-chain register
// with no polite suffix at all ("Xして、Yして。": do X, then do Y) — T07's
// actual shape, and hasRequestedMutationIntent stays exactly as strict as
// before for it (every already-recognized mutation-shaped query short-circuits
// on `mutationRequested` above and never reaches this guard).
//
// This predicate only fires for a query that carries BOTH signals: the bare
// mutation verb above AND a SEPARATE sub-question asking to list/explain
// something (列挙/一覧/教えて/説明して; list/enumerate/explain/which) — the
// two-verb instruction chain T07 is shaped like. An enumeration marker with NO
// mutation verb at all (a pure 「〜一覧を教えて」 read, or 「どのcodecを選ぶか」)
// leaves hasMutationVerb false and the whole predicate short-circuits, so the
// §14 guardrail in bindTaskProfile still owns that case exactly as before.
//
// Root-cause note: bindTaskProfile's own §14 guardrail ALREADY downgraded
// T07's inferred "answer" to profile_binding.selected:"generic" (its
// defect-symptom marker "バグ" disqualified the honored-answer arm) — that
// half was never broken. The bug lived one level up: classifyTaskProfile
// itself still returned "answer" for T07, and isAnswerIntentQuery (below)
// reads that RAW result to relabel an edit_from_handles route to
// answer_from_handles, with NO §14 gate of its own — so a pack whose profile
// was already "generic" still shipped decision.kind:"act.answer". Fixing the
// shared classifier below (rather than adding a second guardrail at the route
// layer) closes both consumers at once.
// ---------------------------------------------------------------------------
// FIXALL-A group C (2026-09-14): DERIVED, never mirrored. Round 8 fixed this
// list once by hand-copying 設定/更新 out of requestItems.ts's own edit-lead
// vocabulary ("mirrored, not shared, per that module's own 'fix only at that
// door' scoping"); the copy then went stale the moment 置換/改名/リネーム were
// added there, so "置換して"/"改名して"/"リネームして" inferred
// profile:"answer" and blocked act.edit for the whole pipeline (matrix cells
// profile-c122/131/138/139/140/149). The shared half is now IMPORTED from the
// one declaration (EDIT_VERB_JA_ROOTS), exactly as MUTATION_VERBS_EN already
// is on the EN side, so it cannot drift again.
//
// 直す/実装 stay listed separately below because they are NOT edit-LEAD verbs
// in requestItems.ts's sense (neither is tail-anchored there); they belong to
// THIS door's own bare-te-form instruction-chain vocabulary (T07: "修正して、
// 影響の出る型一覧も列挙して。"), and adding them to the lead set would widen
// a different, tail-anchored gate. Every marker here is still a bare te-form,
// so JA_PROGRESSIVE_CONTINUATION_RE below applies to all of them uniformly.
export const MIXED_INTENT_MUTATION_JA: readonly string[] = [
  ...EDIT_VERB_JA_ROOTS.map((root) => `${root}して`),
  "直して", "実装して",
];

/**
 * FIXALL-A group C (2026-09-14) — the SAME roots in the two OTHER request
 * conjugations this door was blind to. The te-form list above is scanned as a
 * plain substring (with JA_PROGRESSIVE_CONTINUATION_RE below rejecting the
 * descriptive ている/ています/… continuations); these two shapes cannot be, because
 * each needs its own following-context guard:
 *
 *  - IMPERATIVE (〜しろ / 〜せよ). Unambiguous, no guard needed, and already
 *    sanctioned request endings for an overlapping root list one door up
 *    (`REQUESTED_MUTATION_JA_RE`'s own `しろ|せよ` alternatives) — this adds no new
 *    request vocabulary, only the roots that door happens not to list.
 *  - CONTINUATIVE (〜し) at a CLAUSE BOUNDARY, i.e. 「…にリネームし、…」. This is
 *    the same instruction-chain register T07 is shaped like, just with the
 *    clauses joined by a touten instead of repeated te-forms, and it is exactly
 *    what `requestItems.ts::EDIT_VERB_JA_ROOT_RE` recognizes with its own
 *    `(?:し|して)?…$` tail anchor (that regex is handed ONE clause at a time, so
 *    "tail-anchored" and "followed by a clause boundary" are the same test).
 *    The lookahead is what keeps it off the descriptive forms: 「…を設定している」
 *    leaves ている after the し and never matches, so SHOULD-FIX 43/48's own
 *    progressive cases stay read-only.
 *
 * 直 is deliberately absent: it is a godan verb (直す), whose imperative is 直せ
 * and whose continuative is 直し — different conjugations that would have to be
 * spelled out rather than derived, and nothing in scope needs them.
 */
export const MIXED_INTENT_MUTATION_JA_SURU_ROOTS: readonly string[] = [...EDIT_VERB_JA_ROOTS, "実装"];

export const MIXED_INTENT_MUTATION_JA_NON_TE_RE = new RegExp(
  `(?:${MIXED_INTENT_MUTATION_JA_SURU_ROOTS.join("|")})`
  + "(?:しろ|せよ|し(?=[、，,。．.!?！？\\s]|$))",
  "u",
);

// Symmetric with the JA half above but deliberately NOT clause-anchored
// (unlike REQUESTED_MUTATION_EN_RE, which already recognizes a clause-initial
// or modal-led imperative on its own via hasRequestedMutationIntent — this
// predicate only runs after that stricter check has already failed). It exists
// for the embedded English mirror of the JA bare-te-form shape ("...and once
// you fix the Compute logic, list the affected types"). Requiring an object
// token after the verb keeps a bare mention ("needs a fix.", "the recent
// update.") from matching. The negative lookbehind excludes the same verb used
// as a NOUN with a determiner ("a fix for...", "the recent update...") — "This
// is a fix for the reported crash." must not count — and, separately, as the
// INFINITIVE OBJECT of an explain-shaped request ("explain how TO implement a
// change...") or under negation ("do NOT change code") — both read as
// describing/declining a change, not requesting one. Caught live in this
// change's own review: "explain how to implement a change in
// QuoteOrchestrator; do not change code" (taskProfileBinding.spec.ts) pairs
// "explain" with two now-excluded "implement"/"change" occurrences and must
// stay off this predicate entirely.
// Round-8 residual fix (adopted chip; classifyTaskProfile edit-verb
// alignment, x1_probe39e.mjs): widened to mirror requestItems.ts's own
// edit-lead vocabulary (EDIT_VERB_LEAD_RE: change/rename/replace/update/
// modify/set) plus this round's explicit "at least" list (bump/increase/
// decrease/switch/toggle/enable/disable/insert/delete) -- "Explain X, and
// SET it to 5." inferred profile:"answer" (blocking act.edit) while the
// otherwise-identical "...and CHANGE it to 5." correctly inferred
// "generic", solely because "set" was absent here. Mirrored, not
// byte-shared, with requestItems.ts's list: EDIT_VERB_LEAD_RE itself stays
// untouched (its own clause-initial anchor and BLOCKER-34/SHOULD-FIX-39
// pinned behavior are a materially different, narrower question -- see
// fix-notes-y1.md for the scope call). The same determiner-exclusion
// lookbehind and trailing-object requirement that already protect "the set
// of tests" / "the settings page" / "the update log" from the pre-existing
// verbs protect the new ones identically.
// SHOULD-FIX 43 (2026-09-14, review round 8): the verb alternation above
// matches ANY occurrence of one of these words, anywhere in the query, with
// no clause anchor -- so a pure READ question phrased as a relative/
// interrogative clause ("Explain which callers modify MAX_RETRIES in
// src/retry.ts.", "...which files set the default TTL...") matched too: the
// verb there describes EXISTING behavior ("callers [that] modify"), it is
// not a request to perform one. The negative lookbehind excludes a verb
// preceded by a WH-word within a short span -- the hallmark of a question
// ABOUT behavior rather than a request FOR it.
//
// SHOULD-FIX 45 (2026-09-14, review round 9->10): round 8 tried to bound that
// exclusion with a character budget (`[^.!?\n]{0,24}`), and the budget crossed
// CLAUSE boundaries. Measured: the exclusion reached 17 characters past the WH
// word -- straight across `, and `/`; then ` -- so 14 sentences carrying an
// EXPLICIT edit request lost their only mutation signal and `classifyTaskProfile`
// certified a read-only `act.answer` over them (`In src/retry.ts, explain what it
// does and set it to 5.`, `Explain what the TTL is and change it to 5.`,
// `Tell me what changed, and update the comment in src/a.ts.`, ...). No span
// limit can fix that, because a clause has no maximum length.
//
// So the span stays as it was, and the CALLER (hasMixedIntentMutationMarkerEn
// below) evaluates it ONE CLAUSE AT A TIME. A lookbehind that cannot see past
// the clause it is judging cannot reach into the next clause's imperative:
// clause-locality by construction instead of by calibration. The 9 WH attacks
// keep their WH word and their verb in the SAME clause and stay excluded; every
// regression above has them in DIFFERENT clauses and is admitted again.
// SHOULD-FIX 55: the verb alternation is the SHARED `MUTATION_VERBS_EN`
// (requestItems.ts). The two lookbehinds and the trailing `\s+\S` object
// requirement are this predicate's own and unchanged.
export const MIXED_INTENT_MUTATION_EN_RE = new RegExp(
  `(?<!\\b(?:a|an|the|this|that|some|any|to|not|never|no)\\s)`
  // Copilot retest r3 (2026-10-02): a passive auxiliary makes the verb a
  // state ("when the locale is set to JPY"), never a requested edit. Only the
  // finite forms: "I'd like it to BE set to 5" and "make sure it GETS set" are
  // requests (review, 2026-10-02).
  + `(?<!\\b(?:is|are|was|were)\\s)`
  // …and not the member of an access (`Context.forward`, `cache.update`): that verb names a member.
  + `(?<![A-Za-z0-9_$)\\]]\\.)`
  + `(?<!\\b(?:which|what|who|whom|how)\\b[^.!?\\n]{0,24})`
  + `\\b(?:${MUTATION_VERBS_EN})\\b\\s+\\S`,
  "i",
);

// SHOULD-FIX 41 (2026-09-14, review round 8): "説明し" (continuative, no
// ください) added -- every round since 5 uses this exact JA phrasing
// ("…役割を説明し、5 に更新してください。"), and it was invisible to this list
// (only the polite "説明して" was present), so an explicit edit request
// paired with this continuative explain clause classified profile:"answer"
// instead of "generic" for JA while the byte-identical EN phrasing did not.
// A prefix of "説明して", so this `includes`-based list gains no false
// positive from adding it.
// NOTE 66 (2026-09-14, review round 9): round 8 added the bare continuative
// "説明し" to this list, which an `includes` test also satisfies for 説明しない
// ("do NOT explain") and 説明しづらい ("hard to explain") -- and this is the
// PERMISSIVE half of the mixed-intent predicate, so a refusal-to-explain would
// have counted as an enumeration sub-request. Expressed as one regex so the
// continuative can exclude those two endings while every other entry keeps its
// plain substring semantics.
/**
 * FIXALL-A group C (2026-09-14): DERIVED from requestItems.ts's own JA read-verb
 * vocabulary (`READ_VERB_JA_SURU_ROOTS`/`READ_VERB_JA_STEM_ROOTS`) instead of
 * hand-listing a strict subset of it. The hand-written list knew 説明 but not
 * 確認 — declared side by side in requestItems.ts since SHOULD-FIX 26 — and knew
 * 教えて but neither 述べて nor 調べて nor 読んで, so a request pairing a genuine
 * edit clause with a 「…を確認してください」 reporting clause found no enumeration
 * marker and still certified a read-only `answer` (matrix cells
 * profile-c131/139/149).
 *
 * The `(?![なづ])` guard the old list carried on 説明し is preserved and now
 * applies to every suru-root uniformly (it excludes the negative 〜しない and the
 * difficulty form 〜しづらい, neither of which asks for a report). 列挙/一覧 stay
 * as literal nouns — they are this door's own enumeration vocabulary, not read
 * VERBS, and requestItems.ts has no equivalent.
 *
 * Safe by position, per SHOULD-FIX 55's own argument just below: this half only
 * ever runs once a mutation marker has already matched, so widening it can only
 * stop a read-only certificate over a query that ALREADY carries an
 * unambiguous mutation request — it can never create one.
 */
export const MIXED_INTENT_ENUMERATION_JA_RE = new RegExp(
  `列挙|一覧|(?:${READ_VERB_JA_SURU_ROOTS.join("|")})し(?![なづ])`
  + `|(?:${READ_VERB_JA_STEM_ROOTS.join("|")})て|読んで`,
  "u",
);

/**
 * SHOULD-FIX 55 (AB1, 2026-09-14, review round 11): the WH words belong here.
 *
 * This is the RESCUE half of `hasMixedMutationAndEnumerationIntent` — it only
 * ever runs once a mutation marker has already been found, and all it decides is
 * whether the request ALSO carries a reporting sub-question, in which case
 * `classifyTaskProfile` must not certify a read-only answer. A WH question is
 * the single commonest way to ask one, and the list had none: `What does
 * MAX_RETRIES do in src/retry.ts? Set it to 5.` carried the mutation marker
 * (`MIXED_INTENT_MUTATION_EN_RE` has `set`), found no enumeration marker, and so
 * fell through to `return "answer"` — dropping the caller's explicit edit
 * request under a CERTIFIED read-only decision.
 *
 * Safe by position: a PURE WH read question ("Explain which callers modify
 * MAX_RETRIES in src/retry.ts.") never reaches this test, because the mutation
 * half is false for it — SHOULD-FIX 43's clause-local WH lookbehind is what
 * decides that, and it is untouched. Widening this list can therefore only ever
 * stop a read-only certificate over a query that ALREADY carries an
 * unambiguous mutation request.
 */
export const MIXED_INTENT_ENUMERATION_EN_RE = /\b(?:list|enumerate|explain|which|what|why|who|whom|where|when|how)\b/i;

// SHOULD-FIX 43 (2026-09-14, review round 8): every MIXED_INTENT_MUTATION_JA
// marker is a bare te-form (Xして) -- also the shared leading substring of
// that SAME verb's progressive/conditional form (Xしている/Xしていた/
// Xしていれば), which describes ongoing or existing behavior ("どの関数が
// TTL を設定しているか説明してください。" = "explain WHICH FUNCTION IS
// SETTING the TTL", a read-only question), never a request to perform the
// action. A plain `.includes` cannot tell "設定して" apart from
// "設定している"'s own leading substring. Scans every occurrence of every
// marker (not just the first) so one progressive occurrence never blocks a
// LATER, genuine imperative occurrence of the same marker from counting.
// SHOULD-FIX 48 (2026-09-14, review round 9->10): round 8's guard covered only
// いる/いた/いれば, i.e. the three LEAST common of the forms it exists for. います
// is the commonest polite progressive in real Japanese query text, so
// 「…を設定していますか。説明してください。」 (a read-only question) still
// classified `generic`; so did the negative 設定していない and the contracted
// 設定してる. Every one of these makes the te-form marker DESCRIPTIVE:
//   ている / ています / ていた / ていました / ていない / ていません / ていれば
//   てる / てた            (contracted -- the remainder starts with る/た directly)
export const JA_PROGRESSIVE_CONTINUATION_RE = /^(?:い(?:る|た|れば|ま[すし]|な(?:い|かった)|ません)|[るた])/u;

/**
 * True when some clause of `query` uses one of the JA mutation markers as a
 * REQUEST rather than a description. Scans every occurrence of every marker (not
 * just the first) so one progressive occurrence never blocks a LATER, genuine
 * imperative use of the same marker.
 */
export function hasMixedIntentMutationMarkerJa(text: string): boolean {
  // FIXALL-A group C (2026-09-14): the imperative/continuative conjugations of
  // the SAME roots (see MIXED_INTENT_MUTATION_JA_NON_TE_RE). Each carries its
  // own following-context guard inside the regex, so neither needs — nor would
  // be served by — the te-form progressive scan below.
  if (MIXED_INTENT_MUTATION_JA_NON_TE_RE.test(text)) return true;
  return MIXED_INTENT_MUTATION_JA.some((marker) => {
    for (let from = 0; ;) {
      const at = text.indexOf(marker, from);
      if (at === -1) return false;
      if (!JA_PROGRESSIVE_CONTINUATION_RE.test(text.slice(at + marker.length))) return true;
      from = at + marker.length;
    }
  });
}

/**
 * AA1 (2026-09-14, review round 10): CLAUSE-LOCAL mutation detection -- the
 * structural half of finding 45's fix. `splitIntoLeadClauses` (requestItems.ts,
 * `splitCoordinators` on) is the ONE clause splitter; each clause is judged on
 * its own, so `MIXED_INTENT_MUTATION_EN_RE`'s WH-word lookbehind can never reach
 * from a question clause into the NEXT clause's imperative. The whole query is
 * still tested as well, which can only ADD matches (a verb whose object sits
 * across a boundary), never remove one: the predicate is an OR over clauses.
 */
/**
 * 2026-10-29: "How does res.send choose the Content-Type and generate the ETag?" asks how a
 * subject BEHAVES; its coordinated "generate" is the subject's predicate, not an imperative.
 * A sentence that opens "how / what / why does|do|did <subject> …" and ends with "?", with
 * no I / we / you / let's subject and no modal, is a description request: it carries no
 * requested mutation. The next sentence is judged on its own ("How does X work? Fix it."
 * still carries "Fix it"), and a sentence that opens any other way (an imperative
 * "Explain X and change it to 5.") is untouched.
 */
export const DESCRIPTIVE_INTERROGATIVE_OPENING_EN_RE = new RegExp(`${SHAPE_LEAD_IN}(?:how|what|why)\\s+(?:does|do|did)\\s+(?!(?:i|we|you)\\b)\\S`, "i");

export const FIRST_OR_SECOND_PERSON_EN_RE = /\b(?:i|we|you|let['’]?s|please)\b/i;

export function isDescriptiveInterrogative(sentence: string): boolean {
  return /\?\s*$/u.test(sentence)
    && DESCRIPTIVE_INTERROGATIVE_OPENING_EN_RE.test(sentence)
    && !MODAL_WORD_EN_RE.test(sentence)
    && !FIRST_OR_SECOND_PERSON_EN_RE.test(sentence)
    && !WH_SUGGESTION_OPENING_EN_RE.test(sentence);
}

export function withoutDescriptiveInterrogatives(text: string): string {
  return text.split(SHAPE_SENTENCE_SPLIT_RE).filter((sentence) => !isDescriptiveInterrogative(sentence)).join("\n");
}

export function hasMixedIntentMutationMarkerEn(query: string): boolean {
  // In Japanese prose, "add 関数" names a declaration; the Latin name is
  // not an English imperative. Keep requested edits elsewhere in the query.
  const prose = withoutDescriptiveInterrogatives(query).replace(/\b[A-Za-z_$][\w$]*\s*(?=(?:関数|メソッド|クラス)(?:[をのがは]|について|\s|[。、]|$))/gu,
    name => " ".repeat(name.length));
  if (MIXED_INTENT_MUTATION_EN_RE.test(prose)) return true;
  return splitIntoLeadClauses(prose, { splitCoordinators: true })
    .some((clause) => MIXED_INTENT_MUTATION_EN_RE.test(clause));
}

export function hasMixedMutationAndEnumerationIntent(query: string): boolean {
  // The mutation half is clause-local (see above); the ENUMERATION half stays
  // whole-query on purpose -- this predicate is about a request that carries BOTH
  // an edit and a reporting sub-question, and those live in DIFFERENT clauses by
  // definition (「…してください。説明してください。」).
  const hasMutationVerb = hasMixedIntentMutationMarkerJa(query)
    || hasMixedIntentMutationMarkerEn(query);
  if (!hasMutationVerb) return false;
  return MIXED_INTENT_ENUMERATION_JA_RE.test(query)
    || MIXED_INTENT_ENUMERATION_EN_RE.test(query);
}
