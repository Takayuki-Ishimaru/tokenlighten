// coverageAndContinuation — extracted implementation; imports point to the owning modules.
import type { TaskPackArgs } from "../model.js";
import type { TaskPackResult } from "../model.js";
import type { TaskPackSurface } from "../model.js";
import type { TaskProfile } from "@tokenlighten/types";
import type { TaskProfileBinding } from "@tokenlighten/types";
import type { TaskProfileRequest } from "@tokenlighten/types";
import { ANSWER_INTENT_JA } from "./coverageAndContinuation2.js";
import { ANSWER_INTENT_JA_NOUN_RE } from "./coverageAndContinuation2.js";
import { REFERENCE_ANSWER_EN_RE } from "./coverageAndContinuation2.js";
import { REFERENCE_ANSWER_JA_RE } from "./coverageAndContinuation2.js";
import { concernGroupsForQuery } from "./roleAndConcernScope3.js";
import { getIntentEditObserved } from "../../../state/session.js";
import { hasAnalysisIntentMarker } from "./coverageAndContinuation3.js";
import { hasAnswerIntentMarker } from "./coverageAndContinuation3.js";
import { hasArtifactBuildIntentMarker } from "./coverageAndContinuation3.js";
import { hasComputationRequest } from "./coverageAndContinuation3.js";
import { hasExplicitConcernList } from "./roleAndConcernScope2.js";
import { hasExplicitIndependentConcernMarker } from "./roleAndConcernScope2.js";
import { hasExplicitNoEditDeclaration } from "./coverageAndContinuation3.js";
import { hasIndependentEditConcernClauses } from "./roleAndConcernScope2.js";
import { hasJaInterrogativeDou } from "./coverageAndContinuation2.js";
import { hasMixedMutationAndEnumerationIntent } from "./coverageAndContinuation3.js";
import { hasPropagationIntentMarker } from "./coverageAndContinuation3.js";
import { hasRequestedMutationIntent } from "./coverageAndContinuation3.js";
import { hasServedCode } from "./wiringEvidence2.js";
import { hasWhQuestionSentence } from "./coverageAndContinuation3.js";
import { hasWiringIntentMarker } from "./coverageAndContinuation3.js";
import { isEnumLikeQueryShaped } from "./roleAndConcernScope2.js";
import { proofCompletionEnabled } from "../../../util/flags.js";
import { queryRequestsTestEvidence } from "../../../tools/queryEvidence.js";
import { resolveIntent } from "../sfIntent.js";
import { unmatchedConcernTokens } from "./roleAndConcernScope3.js";

/** WS3 binding classifier; every unbound/low-confidence shape stays generic. */
export function classifyTaskProfile(query: string): TaskProfile {
  const mutationRequested = hasRequestedMutationIntent(query);
  if (mutationRequested) {
    if (hasArtifactBuildIntentMarker(query)) return "artifact_build";
    if (hasWiringIntentMarker(query)) return "wiring";
    const concernGroups = concernGroupsForQuery(query);
    // Enum fan-out requests frequently enumerate the required layers as a
    // bullet list. Those bullets are one propagation contract, not independent
    // defects. Listed symptoms remain authoritative for non-enum work.
    if (isEnumLikeQueryShaped(query) && !hasExplicitIndependentConcernMarker(query)) {
      return "change_propagation";
    }
    if (
      concernGroups.length >= 2
      && (
        hasIndependentEditConcernClauses(query)
        || hasExplicitIndependentConcernMarker(query)
      )
    ) {
      return "multi_concern";
    }
    if (isEnumLikeQueryShaped(query)) return "change_propagation";
    if (concernGroups.length >= 2 && hasExplicitConcernList(query)) return "multi_concern";
    if (hasPropagationIntentMarker(query)) return "change_propagation";
    return "generic";
  }
  // Copilot retest r3 (2026-10-02): an explicit no-change instruction is itself
  // a read-only declaration ("which config key controls the session cookie?
  // Just read, don't edit anything." carried no other marker and bound generic).
  if (hasAnalysisIntentMarker(query) || hasAnswerIntentMarker(query) || hasExplicitNoEditDeclaration(query)) {
    // A query that only READS as answer-shaped per the markers above may still
    // carry an explicit mutation request that hasRequestedMutationIntent's
    // stricter regexes miss (see the block comment above
    // hasMixedMutationAndEnumerationIntent). When it ALSO carries a distinct
    // enumeration/explanation sub-request, the mutation intent dominates: this
    // is a change task with a reporting sub-question, not a read-only ask.
    if (hasMixedMutationAndEnumerationIntent(query)) return "generic";
    return "answer";
  }
  return "generic";
}

// ---------------------------------------------------------------------------
// 2026-08-21 §14 tiered guardrail (issue #1, revised twice): the
// ANSWER_INTENT_* markers above were widened so genuinely comprehension-
// shaped queries (「〜を理解したい」, "which codec does the pipeline
// select") classify as "answer" in the first place — previously they carried
// no recognized marker at all and never reached this branch. Widening recall
// alone would just make the §14 misfire guardrail below fire MORE often,
// since every inferred "answer" still fell back to generic. Two follow-on
// refinements to which inferred-"answer" queries that guardrail honors:
//   1. An early revision required a STRONG, unambiguous comprehension marker
//      (understand/explain/overview/...) before honoring — too narrow, since
//      a plain interrogative ("which codec does the pipeline choose for a
//      response?", 「pipelineがどのcodecを選ぶか」) carries an ordinary
//      ANSWER_INTENT_* marker but no "strong" one, so it still paid the
//      round trip for no reason.
//   2. Dropping that requirement entirely (honor unless defect-symptom) was
//      too broad the other way: hasAnswerIntentMarker also ORs in
//      hasAnalysisIntentMarker, so open-ended analysis/investigation asks
//      ("assess/trace/determine/investigate X", "analyze X and propose
//      improvements") — the SYMPTOM-ADJACENT shape the original 2026-07-25
//      misfire guardrail exists to catch (DESIGN-v0.9 §14 item 3, tripped by
//      "why does the checkout total come out wrong?"-shaped asks on edit
//      tasks) — got swept in too.
// The rule below now requires BOTH a genuine interrogative/comprehension
// marker (hasInterrogativeAnswerMarker — ANSWER_INTENT_JA/NOUN_RE plus a
// phrase-gated EN variant, see the comment above that function) AND no
// defect-symptom marker (hasDefectSymptomMarker). Pure analysis-intent
// wording, and a BARE investigation verb with no interrogative clause,
// stays on the §14 fallback exactly as before.
// ---------------------------------------------------------------------------
export const DEFECT_SYMPTOM_EN_RE = /\b(?:bugs?|fail(?:s|ed|ing|ure)?|errors?|broken|wrong|incorrect(?:ly)?|crash(?:es|ed|ing)?|regression|doesn't|does not|isn't|not working|unexpected(?:ly)?|mismatch|flaky|hang(?:s|ing)?|leak(?:s|ing)?|missing|ignore(?:s|d)?|skip(?:s|ped)?|duplicate(?:s|d)?|twice|double[- ]?(?:counted|charged|applied)|slow(?:ly)?|timeout(?:s)?|times? out|inconsistent|never|should (?:be|have|not)|supposed to|instead of|even though|despite|why (?:isn't|aren't|doesn't|don't|won't|can't|didn't))\b/i;

export const DEFECT_SYMPTOM_JA: readonly string[] = [
  "不具合", "失敗", "エラー", "バグ", "壊れ", "おかしい", "誤", "動かない", "期待通り", "ずれ", "違う", "異常", "落ち",
  "抜け", "漏れ", "無視", "重複", "二重", "遅い", "固まる", "されない", "ならない", "はず", "できない", "出ない", "消え", "消える", "返らない", "効かない", "反映されない",
];

/**
 * The request names its deliverable as an answer and only an answer: "Return
 * only a JSON object", "Respond only with …", "Answer with …", "Use keys a and
 * b", 「JSON だけで返して」. See `bindTaskProfile`'s §14 branch.
 */
export const ANSWER_ONLY_DELIVERABLE_EN_RE = /\b(?:return|respond|reply|answer|output)\s+(?:with\s+)?only\b|\b(?:return|respond|reply|answer)\s+(?:with\s+)?(?:a|an|the)?\s*json\b|\buse\s+(?:the\s+)?keys?\s+[\w"'`]+/i;

export const ANSWER_ONLY_DELIVERABLE_JA_RE = /JSON\s*(?:のみ|だけ)\s*(?:で|を)?\s*(?:返|答|回答|出力)|(?:回答|答え)\s*(?:のみ|だけ)\s*(?:を)?\s*(?:返|出力)/;

export function hasAnswerOnlyDeliverable(query: string): boolean {
  return ANSWER_ONLY_DELIVERABLE_EN_RE.test(query) || ANSWER_ONLY_DELIVERABLE_JA_RE.test(query);
}

export function hasDefectSymptomMarker(query: string): boolean {
  return DEFECT_SYMPTOM_EN_RE.test(query)
    || DEFECT_SYMPTOM_JA.some((marker) => query.includes(marker));
}

// hasAnswerIntentMarker ORs in hasAnalysisIntentMarker (assess/analyze/
// review/measure/propose/investigate-as-analysis-noun, plus the JA analysis
// list), so classifyTaskProfile can still infer "answer" for pure analysis
// wording. That inference must keep paying the §14 round trip under auto
// (see the block comment above DEFECT_SYMPTOM_EN_RE) — only a genuine
// INTERROGATIVE/comprehension marker earns the honored one-call fast path.
//
// ANSWER_INTENT_EN_RE itself also carries four bare investigation verbs
// (assess/trace/determine/investigate) so classifyTaskProfile infers
// "answer" for them too (ANSWER_INTENT_EN_RE is untouched here, so that
// stays exactly as before). But a BARE "assess X" / "trace X" /
// "determine X" / "investigate X" is the same open-ended shape as the
// analysis-intent wording above, not a genuine interrogative. Moving those
// four words into ANALYSIS_INTENT_EN_RE wholesale is NOT safe: it would
// also flip "trace how tl_read_file task_pack builds execution_contract
// readiness..." (a real interrogative that must stay honored) off the fast
// path, AND it would leak into the unrelated analysis-source readiness
// obligation gate (~L13936, `if (hasAnalysisIntentMarker(query))`) that
// reads the very same shared regex. So this predicate uses its own
// INTERROGATIVE_ANSWER_EN_RE: identical to ANSWER_INTENT_EN_RE except those
// four verbs require an explicit "how"/"why" clause ("trace how X builds
// Y") to count; a bare "trace X" does not, and keeps paying the §14 round
// trip like any other analysis-shaped ask.
export const INTERROGATIVE_ANSWER_EN_RE = /\b(explain|describe|(?:assess|trace|determine|investigate)\s+(?:how|why)|why|how does|what happens|what conditions|when (?:does|do|is|are|must|should|can|will)|walk (?:me )?through|where (?:is|are|does|do|did|was|were)|what (?:is|are|does|do|did)|which (?:file|files|function|functions|class|classes|module|modules|method|methods)|understand(?:ing)?|overview|summar(?:y|ies|ize[sd]?|ise[sd]?|izing|ising)|clarify|tell me|show me (?:how|where|what|which)|how (?:is|are|do|did|can|would|should|were|was)|which \w+ (?:does|do|is|are|gets?|selects?|chooses?|uses?|handles?|calls?|owns?))\b/i;

export function hasInterrogativeAnswerMarker(query: string): boolean {
  return (proofCompletionEnabled() && (
    REFERENCE_ANSWER_EN_RE.test(query)
    || REFERENCE_ANSWER_JA_RE.test(query)
  ))
    || INTERROGATIVE_ANSWER_EN_RE.test(query)
    || hasWhQuestionSentence(query)
    || hasComputationRequest(query)
    || ANSWER_INTENT_JA.some((m) => query.includes(m))
    || ANSWER_INTENT_JA_NOUN_RE.test(query)
    || hasJaInterrogativeDou(query);
}

/**
 * An explicit profile is the caller's structured semantic declaration.  The
 * server does not use incidental analysis/wiring words to choose between
 * declared change shapes, and — since DESIGN-v0.15-sf-intent-layers.md §3
 * (2026-09-05) — it does not use them to override a declared
 * `taskProfile:"answer"` into a change profile either (the retired V4
 * override; see the `request === "answer"` branch below).
 *
 * NOTE on §4.1 scope: `profile_binding.selected` here classifies the SHAPE of
 * the request (a planning/certification question the caller may legitimately
 * ask with `--allow-write` absent — the replay corpus's many spawned-server
 * and in-process groups that omit `--allow-write` and still expect a
 * `wiring`/`change_propagation`/`multi_concern`/`artifact_build` profile with
 * a prepared `change_contract` are exactly this). §4.1's actual write veto is
 * wired at the two places an unwritable "edit" would otherwise be acted on or
 * certified: `extractConcerns`'s per-concern disposition (`sfConcerns.ts`,
 * downgrading `edit` to `review` with `dispositionDowngradedFrom`) and the
 * real `tl_edit_file` dispatch (already gated on `ALLOW_WRITE` independently of
 * this module). `writeAllowed` is still threaded into `resolveIntent` below
 * (via the `request === "answer"` branch) for `IntentDecision` parity with
 * that consumer — it does not change `selected` here.
 *
 * 2026-08-21: `auto`'s §14 misfire guardrail below honors an inferred
 * "answer" only when the query carries an interrogative/comprehension
 * marker (hasInterrogativeAnswerMarker) and no defect-symptom marker — pure
 * analysis-intent wording (hasAnalysisIntentMarker) stays on the §14
 * fallback.
 */
export function bindTaskProfile(
  requested: TaskProfileRequest | undefined,
  query: string,
  writeAllowed = true,
  // DESIGN-v0.15-sf-intent-layers.md §4.2 (IL-W2): optional so every existing
  // call site keeps compiling without an audit; omitted only means "this
  // caller has no workspace root to ask" (never observed), not "definitely
  // not observed" — see the `request === "answer"` branch's `resolveIntent`
  // call below, the sole place this parameter is read.
  workspace?: string,
): TaskProfileBinding {
  const request = requested ?? "auto";
  const inferred = classifyTaskProfile(query);
  if (request === "auto") {
    // DESIGN-v0.9 §14 pre-registered guardrail, tripped live 2026-07-25
    // (answer-profile misfire 60% vs the 10% ceiling): an INFERRED "answer"
    // falls back to the generic pack unless the query itself DECLARES
    // read-only work (explicit no-edit wording) — the misfires were
    // symptom-question phrasings on edit tasks, not declared-no-edit asks.
    // A caller-pinned taskProfile:"answer" is honored below unless the
    // request itself contains an unmistakable, non-negated mutation command.
    // (.match, not .test: the shared regexes carry /g/ and .test would be
    // lastIndex-stateful across calls.)
    //
    // 2026-08-21 (revised again): explicitNoEdit stays an unconditional
    // override; otherwise an inferred "answer" is honored only when the
    // query carries a genuine interrogative/comprehension marker
    // (hasInterrogativeAnswerMarker) with no defect-symptom wording. An
    // inferred "answer" driven ONLY by analysis-intent wording (assess/
    // analyze/review/measure/propose/investigate a symptom-free subject, no
    // interrogative marker present) still pays the round trip — that shape
    // is exactly what the original 2026-07-25 misfire guardrail protects.
    const explicitNoEdit = hasExplicitNoEditDeclaration(query);
    const interrogativeAnswer = inferred === "answer" && hasInterrogativeAnswerMarker(query);
    const defectSymptom = inferred === "answer" && hasDefectSymptomMarker(query);
    // 2026-10-17 (DESIGN-v0.14-plan §20.10): a question that restricts its own
    // deliverable to an answer ("Return only a JSON object", "Use keys errors
    // and sources") and asks no change is read-only even when it NAMES error
    // values ("which sentinel error does each failing check return") — the
    // guardrail's misfires were bug reports that wanted a fix, never ones that
    // dictated an answer format. Measured: a solver dropped the request's
    // "Do not modify files" sentence and the pack fell back to generic (M1).
    const answerOnlyDeliverable = defectSymptom && hasAnswerOnlyDeliverable(query) && !hasRequestedMutationIntent(query);
    const honorInferredAnswer = explicitNoEdit || (interrogativeAnswer && (!defectSymptom || answerOnlyDeliverable));
    const selected = inferred === "answer" && !honorInferredAnswer ? "generic" : inferred;
    return {
      requested: "auto",
      selected,
      source: "inferred",
      confidence: selected === "generic" ? 0.4 : 0.8,
      // P1 (hands-on report, 2026-09-20): these two strings named the LEGACY
      // argument `taskProfile`, which the server refuses by default
      // (TL_LEGACY_INPUT), and recorded sessions show models copying the name
      // straight out of this advice into their next call and collecting an
      // `unknown-arguments` refusal for it. Canonical spelling only.
      reason: inferred === "answer" && selected === "generic"
        ? "answer-shaped query served as generic per §14 misfire guardrail; declare task.profile:\"answer\" for a read-only pack"
        : inferred === "answer" && selected === "answer" && !explicitNoEdit
          ? "answer-shaped read-only query; task.profile overrides"
          : selected === "generic"
            ? "no high-confidence task-shape marker"
            : `query matched ${selected}`,
    };
  }

  // DESIGN-v0.15-sf-intent-layers.md §3 (2026-09-05): V4 retired. A declared
  // taskProfile:"answer" used to be overridden to generic/change_propagation
  // HERE when the query also carried an unmistakable, non-negated mutation
  // command (the "stale or mis-copied answer hint" rationale below, kept for
  // history) — the declaration lost to the query's own vocabulary. Layer 1 of
  // the intent model (`sfIntent.ts`'s `resolveIntent`) makes the declaration
  // win outright instead: mutation wording is recorded in `reason` only,
  // never used to flip `selected`. An edit that actually arrives opens the
  // write frontier at layer 2 (§4.2, W2's `editObserved`) rather than being
  // guessed from words at profile-binding time.
  if (request === "answer") {
    // `extractConcerns` (sfConcerns.ts) reads the identical `IntentDecision`
    // for its own "is edit permitted" question — this call keeps the two
    // consumers answering from one decision, per DESIGN-v0.15 §2. Its
    // disposition is not consulted for `selected` below: a declared "answer"
    // is unconditionally honored (that IS the fix, both directions), while
    // `resolveIntent`'s finer edit/verify/measure/review classification
    // serves a different, per-CONCERN question `extractConcerns` owns.
    const decision = resolveIntent({
      declaredProfile: "answer",
      // A declared "answer" alone forbids a LEXICAL guess of "edit"
      // (`resolveIntent`'s `editForbidden`), so absent an observed edit
      // `writeFrontier` comes out "closed" regardless of `writeAllowed` —
      // threaded through anyway for an accurate `reason`. §4.2 is the one
      // exception: an edit that has ALREADY passed `guardExecutionEdit` this
      // task epoch (`editObserved` below) opens the frontier even here,
      // per DESIGN-v0.15 §3's 「edit が本当に来るなら層2で開く」.
      writeAllowed,
      // §4.2 (W2): has an tl_edit_file call already passed guardExecutionEdit
      // this task epoch? `workspace` is undefined only for a caller that has
      // none to ask (never observed, safe default).
      editObserved: workspace !== undefined && getIntentEditObserved(workspace),
      referencesObserved: false, // TODO(W3): thread executedLocates' "references" flag (§4.4)
      qualifiedAnchorResolved: false, // TODO(W3): thread sfQualifiedAnchors + anchorResolver hit (§4.4)
      explicitTargets: [], // TODO(W3): thread args.paths as SfExplicitTarget[] (§4.3)
      query,
    });
    const mutationWordSeen = !hasExplicitNoEditDeclaration(query) && hasRequestedMutationIntent(query);
    return {
      requested: request,
      selected: "answer",
      source: "explicit",
      confidence: 0.98,
      reason: decision.writeFrontier === "open"
        ? `caller supplied validated ${request} task shape; an tl_edit_file call already passed guardExecutionEdit this task epoch, so the write frontier stays open (§4.2) even though the declared profile is unchanged`
        : mutationWordSeen
          ? `caller supplied validated ${request} task shape; mutation wording present but the declaration is authoritative (write frontier: ${decision.writeFrontier})`
          : `caller supplied validated ${request} task shape`,
    };
  }

  // The caller supplies taskProfile only for user-declared operation intent.
  // Lexical mutation/no-edit phrases are weaker evidence and must not reverse
  // that declaration — this already holds below for the reverse direction
  // (a declared non-answer profile plus no-edit-shaped wording, e.g. inferred
  // "answer" from `classifyTaskProfile`): the guard immediately below only
  // fires when `inferred` is itself a DIFFERENT change subtype (never
  // "answer", never "generic"), so `inferred === "answer"` here falls
  // straight through to the final `source:"explicit"` return, keeping the
  // declared profile — DESIGN-v0.15 §3's "declaration wins in both
  // directions" invariant, confirmed rather than newly coded. Evidence may
  // still refine one change subtype into another without changing the
  // read-only-versus-write operation. (`request === "answer"` always
  // returned above, so `request` can no longer be "answer" here — narrowed
  // out by the compiler, not re-checked.)
  if (
    inferred !== "answer"
    && inferred !== "generic"
    && inferred !== request
  ) {
    return {
      requested: request,
      selected: inferred,
      source: "evidence",
      confidence: 0.85,
      reason: `request-shaped operation evidence refines ${request} to ${inferred}`,
    };
  }
  return {
    requested: request,
    selected: request,
    source: "explicit",
    confidence: 0.98,
    reason: `caller supplied validated ${request} task shape`,
  };
}

/**
 * What an UNDECLARED call would bind `query` to — `bindTaskProfile`'s own auto
 * branch, exposed for the dispatcher's continuation check (server.ts's
 * `inheritDeclaredTaskProfile`), which carries a task's profile over only when
 * omitting it would otherwise bind a different one.
 */
export function autoBoundTaskProfile(query: string): TaskProfile {
  return bindTaskProfile(undefined, query).selected;
}

/** The note `noteInheritedTaskProfile` appends; readFamily.ts detects it by its "kept for this continuation" phrase. */
export const INHERITED_TASK_PROFILE_NOTE = "declared when this task was opened and kept for this continuation — send task.profile to change it";

/**
 * A profile the dispatcher carried over from the task this call continues
 * (server.ts's `inheritDeclaredTaskProfile`) binds exactly like a restated
 * declaration — that is the point — but the caller did not send it on THIS
 * call, and `profile_binding` is the field the guide tells callers to
 * observe. The reason says where the declaration came from and how to change
 * it; `requested`/`selected`/`source`/`confidence` stay what a restated
 * declaration would have produced.
 */
export function noteInheritedTaskProfile(
  binding: TaskProfileBinding,
  args: Pick<TaskPackArgs, "taskProfileInherited"> | undefined,
): TaskProfileBinding {
  if (args?.taskProfileInherited !== true) return binding;
  // A stored binding replayed by a later door (a receipt, a cached-pack
  // serve) is noted here too, but only a declaration was "declared when this
  // task was opened" — an undeclared, inferred one stays as it was — and one
  // that already carries the note is not noted twice (both measured on a
  // qref replay after `act.answer`).
  if (binding.requested === "auto") return binding;
  if (binding.reason.includes(INHERITED_TASK_PROFILE_NOTE)) return binding;
  return {
    ...binding,
    reason: `${binding.reason}; ${INHERITED_TASK_PROFILE_NOTE}`,
  };
}

/**
 * THE BINDING MUST SAY THE CONFLICT (reviewer note 5, 2026-09-08).
 *
 * A declared `task.profile:"answer"` plus a query that resolves an explicit
 * `create_target` is two caller-supplied facts that cannot both be honoured:
 * DESIGN-v0.15 §3 makes the declaration authoritative (mutation wording never
 * flips `selected`, in either direction), and a create is a mutation. The
 * server's job is to keep the declaration AND say why the pack then stops —
 * the guide's own instruction for this field is "omit if unknown and observe
 * `profile_binding`", so a binding whose `reason` does not name the blocker
 * sends the caller to the one field that was supposed to explain it.
 *
 * RUNS LATE, AND AFTER THE CREATE ROUTE, because `create_target` is resolved
 * long after the binding is built; the binding exists by then, so this appends
 * rather than re-deriving (the pre-existing reason — e.g. §4.2's open-frontier
 * or the mutation-wording note — is evidence in its own right and is kept).
 * Idempotent: the sentence is appended at most once.
 *
 * ONE PREDICATE, TWO READERS. `protocol/decisionWire.ts`'s
 * `declaredProfileCreateConflict` asks the SAME question of the SAME two
 * published facts to mint `decision.unresolved[0]` and the `next`. It is
 * restated there rather than imported because `readCodeTaskPack.ts` does not
 * depend on the protocol layer (only `semanticFrontierTraceContext.ts`) and
 * adding that edge would close a `decisionWire -> ... -> envelope` cycle back
 * onto the producer. Keep the three conjuncts identical.
 */
export function noteDeclaredProfileCreateConflict(result: TaskPackResult): void {
  const binding = result.profile_binding;
  const target = result.create_target?.path;
  if (binding === undefined || target === undefined || target === "") return;
  if (binding.source !== "explicit" || binding.requested !== "answer" || binding.selected !== "answer") return;
  const conflict = `explicit create of ${target} needs task.profile generic (declared: answer)`;
  if (binding.reason.includes(conflict)) return;
  binding.reason = binding.reason === "" ? conflict : `${binding.reason}; ${conflict}`;
}

export function isAnswerIntentQuery(query: string): boolean {
  // 2026-07-25 note: classifyTaskProfile only reaches its "answer" branch when
  // hasRequestedMutationIntent is false, so an edit request that the mutation
  // regexes RECOGNIZE can never relabel here. The T10 run-2 dead end (route
  // answer_from_handles + allowed:["request-user-input"] on an edit task) was
  // a mutation-intent MISS on 体言止め phrasing — fixed at the classifier
  // (REQUESTED_MUTATION_JA_NOUN_RE), which is the root; a stricter gate here
  // was tried and reverted because it broke explicit-answer route coherence.
  return classifyTaskProfile(query) === "answer";
}

/**
 * Every buildRoute branch that would otherwise return `edit_from_handles`
 * (the pack is done; nothing required is missing) funnels through here so
 * the answer/explain relabeling lives in ONE place. `max_additional_tl_calls`
 * semantics are unchanged — every edit_from_handles branch already passes 0
 * (this pack closes the task in zero more calls); the override only swaps
 * `action`/`reason`, never the call-budget number. `query` is optional
 * (some historical callers omit it) — undefined means "ambiguous", which
 * keeps the current action.
 */
export function editFromHandlesRoute(reason: string, maxCalls: number, query?: string, zoomNote?: string): NonNullable<TaskPackResult["route"]> {
  if (query !== undefined && isAnswerIntentQuery(query)) {
    // A5 (2026-08-01 signal5-2 T03): the answer rewrite used to DISCARD the
    // caller-composed reason — including the remaining_ranges zoom affordance —
    // so an answer pack with a partial primary claimed closure with no zoom
    // path. Preserve the zoom note and grant the one sanctioned zoom call.
    return {
      action: "answer_from_handles",
      reason: zoomNote !== undefined
        ? `query reads as explain/answer — no edit expected; ${zoomNote}`
        : "query reads as explain/answer — no edit expected",
      max_additional_tl_calls: zoomNote !== undefined ? Math.max(maxCalls, 1) : maxCalls,
    };
  }
  return { action: "edit_from_handles", reason, max_additional_tl_calls: maxCalls };
}

export function buildRoute(
  surfaces: TaskPackSurface[],
  missingRequired: string[],
  coverage?: "complete" | "focused" | "partial",
  allMissing?: string[],
  query?: string,
  coverageReason?: TaskPackResult["coverage_reason"],
): NonNullable<TaskPackResult["route"]> {
  if (surfaces.length === 0) {
    return {
      action: "locate_missing_surfaces",
      reason: "no editable handles returned",
      max_additional_tl_calls: 1,
    };
  }
  if (missingRequired.length > 0) {
    return {
      action: "locate_missing_surfaces",
      reason: `missing required surface(s): ${missingRequired.join(",")}`,
      max_additional_tl_calls: 1,
    };
  }

  // Wave 4 (2026-07-24 T10/T13 forensics): a done-route that stays silent
  // while a required surface is disclosed-partial reads as a false "complete"
  // — the model re-probes empirically and learns to distrust the stop signal.
  // Name the zoom affordance in the reason. The call budget stays 0: under the
  // serve-with-state gate a re-slice of a served handle is always available,
  // and max_additional_tl_calls keeps its "calls needed to CLOSE the task"
  // meaning (certification acceptance requires 0 — a zoom affordance is not
  // missing evidence).
  const partialRequired = surfaces.filter((surface) =>
    surface.required !== false
    && (surface.content_completeness === "partial" || (surface.remaining_ranges?.length ?? 0) > 0)
  ).length;
  const zoomNote = partialRequired > 0
    ? `${partialRequired} surface(s) have remaining lines (re-slice to zoom, or ONE tl_read_file {targets:[{handle}], content:"full"} when most of the file is needed)`
    : undefined;
  const doneRoute = (reason: string): NonNullable<TaskPackResult["route"]> =>
    zoomNote !== undefined
      ? editFromHandlesRoute(`${reason}; ${zoomNote}`, 0, query, zoomNote)
      : editFromHandlesRoute(reason, 0, query);

  // DESIGN-v0.8 coverage-honesty: a "focused" pack is a single confident site
  // with no cross-surface fan-out — the pack covers the whole change, so edit
  // directly (no extra TL calls), same trust level as "complete".
  if (coverage === "focused") {
    return doneRoute("single confident site; pack covers it");
  }

  // DESIGN-v0.8 coverage-honesty: a "candidate-list" partial means several
  // plausible primaries were returned and the agent should CONFIRM which one
  // before editing (one targeted slice), not locate more surfaces.
  if (coverageReason === "candidate-list") {
    const focusedAnswerEvidence = query !== undefined
      && isAnswerIntentQuery(query)
      && queryRequestsTestEvidence(query)
      && surfaces.some((surface) =>
        surface.role === "test"
        && /query-(?:identifier|evidence)-test-match/.test(surface.why ?? "")
        && hasServedCode(surface)
      )
      && surfaces.every((surface) => hasServedCode(surface));
    if (focusedAnswerEvidence) {
      return {
        action: "answer_from_handles",
        reason: "implementation and query-focused regression evidence are bundled",
        max_additional_tl_calls: 0,
      };
    }
    return {
      action: "confirm_candidates",
      reason: "multiple candidate primaries returned; confirm the target before editing — if required sites are missing from the candidates, ONE tl_read_file {query, targets:[chosen + missing]} is sanctioned",
      max_additional_tl_calls: 2,
    };
  }

  // A4: gated flip. coverage:partial alone is NOT sufficient (that fired on
  // 22/22 packs in the DESIGN-v0.8 replay and would waste a locate turn on
  // tasks that were already fine handle-first) — only unmatched CONCERN
  // tokens justify telling the agent it still needs to look further. A4
  // refinement: and ONLY when coverage is not already "complete" — a complete
  // pack covers every required role, so unmatched query filler on top of that
  // (e.g. "fix", "behavior") must not flip an otherwise-done pack into an
  // extra locate call. Undefined coverage (older callers) keeps the prior
  // permissive behavior.
  const unmatched =
    query !== undefined && coverage !== "complete" ? unmatchedConcernTokens(query, surfaces) : [];
  if (unmatched.length > 0) {
    return {
      action: "locate_missing_surfaces",
      reason: `located surfaces returned; concern(s) not covered: ${unmatched.join(",")}`,
      max_additional_tl_calls: unmatched.length,
    };
  }

  // Never claim "covered" while coverage itself reads partial — that is the
  // self-contradiction this design item closes. Falls through to an honest
  // (still edit_from_handles — nothing REQUIRED is missing and every
  // concern token matched) reason instead of the old "covered" phrasing.
  if (coverage === "partial") {
    const reason = allMissing !== undefined && allMissing.length > 0
      ? `located surfaces returned; not all query concerns covered (missing: ${allMissing.join(",")})`
      : "located surfaces returned; not all query concerns covered";
    return doneRoute(reason);
  }

  return doneRoute("required surfaces covered by returned handles");
}
