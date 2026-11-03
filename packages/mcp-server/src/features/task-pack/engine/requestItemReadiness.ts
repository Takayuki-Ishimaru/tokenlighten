// requestItemReadiness — extracted implementation; imports point to the owning modules.
import type { ConcernStatus } from "./sourceAndConcernTerms3.js";
import type { FacetFacts } from "../facetGate.js";
import type { FacetRequirement } from "../requestFacets.js";
import type { RequestItemProof } from "./recursiveClosure5.js";
import type { RequestItemReadiness } from "./concernProof2.js";
import type { TaskPackResult } from "../model.js";
import type { TaskProfile } from "@tokenlighten/types";
import type { TaskReadinessEvidence } from "@tokenlighten/types";
import type { TaskReadinessObligation } from "@tokenlighten/types";
import { EXAMPLE_FRAGMENT_LEAD_RE } from "./requestItemAbsence2.js";
import { MAX_REQUEST_ITEM_BATCH } from "./recursiveClosure5.js";
import { REQUEST_ITEM_OBLIGATION_PREFIX } from "./recursiveClosure5.js";
import { absenceContradictsServedEvidence } from "./requestItemAbsence3.js";
import { asCreateIfIntroduced } from "./requestItemAbsence3.js";
import { auxiliaryOnlyCandidatesAfterProductEvidence } from "./requestItemAbsence2.js";
import { cachedRequestItemPass } from "./requestItemAbsence2.js";
import { citationClauseNamesOnlyServedThings } from "./identifierAbsence2.js";
import { codeTaskPackSurfaces } from "../artifactSections.js";
import { concernCoveredByServedEvidence } from "./concernProof.js";
import { concernTopicTerms } from "./sourceAndConcernTerms3.js";
import { concernVariantMap } from "./sourceAndConcernTerms3.js";
import { coordinatedPointUndetermined } from "./requestItemAbsence.js";
import { createRequestItemIndexView } from "../requestItems.js";
import { distinctiveSalientAbsence } from "./requestItemAbsence.js";
import { ensureAbsenceUniverse } from "./requestItemAbsence2.js";
import { enumeratedQueryItemsForEpoch } from "./readinessFalsification.js";
import { epochServedEvidence } from "./epochContract2.js";
import { extractRequestItems } from "./packBasics2.js";
import { headIsWhAfterReadLead } from "../requestItems.js";
import { identifierGroundingEnabled } from "../../../util/flags.js";
import { isFormatOrBehaviourClause } from "./identifierAbsence2.js";
import { markFacetOwnedPoints } from "./requestItemAbsence2.js";
import { nonDocNoiseCandidatePaths } from "./requestItemAbsence2.js";
import { proofCitesCodeBearingOccurrence } from "./changeAndReadinessEvidence.js";
import { proveRequestItem } from "./concernProof.js";
import { proveUnbindableRequestItem } from "./concernProof.js";
import { queryHasQuotedLiteral } from "../requestItems.js";
import { reconcileAnalysisSourceFromRequestItems } from "./requestItemAbsence3.js";
import { requestItemTraceStatus } from "./requestItemAbsence3.js";
import { salientWords } from "../requestItems.js";
import { tokenizeForEpoch } from "../../../state/session.js";
import { traceRequestItemEpochReuse } from "./requestItemAbsence3.js";
import { traceRequestItemProof } from "./requestItemAbsence3.js";
import { traceRequestItemStatus } from "./requestItemAbsence3.js";
import { withoutCitationWords } from "./identifierAbsence2.js";

export function buildRequestItemReadiness(
  workspace: string | undefined,
  query: string,
  profile: TaskProfile,
  result: TaskPackResult,
  /**
   * Finding 3 fix (2026-09-07): the SAME obligations `buildReadinessObligations`
   * already minted for this pack (identifiers, behavior-body, ...), read-only
   * — see the "shadowed identifier" reaffirm below.
   */
  otherObligations: readonly TaskReadinessObligation[] = [],
): RequestItemReadiness {
  const none: RequestItemReadiness = { obligations: [], absences: [], undetermined: [] };
  if (workspace === undefined) return none;
  // Scoped to the two profiles the R1 corpus exercises (omitted defaults to
  // "generic"); specialized profiles keep their own existing obligation
  // vocabulary untouched.
  if (profile !== "answer" && profile !== "generic") return none;
  // A resolved create_target (new-file intent) is its own self-complete
  // frontier — buildReadinessObligations's own provedCreate short-circuit
  // above already returns a single proved "surface-content" obligation for
  // it (the file does not exist yet, so there is no additional evidence for
  // request items to demand). Extracting request items from a create query
  // and requiring EXISTING candidate files for them would wrongly demote an
  // otherwise-ready create route back to discovery.
  if (result.create_target !== undefined) return none;
  // Same reasoning for a directed literal-source-absence pack (a different,
  // already-terminal proof shape buildReadinessObligations short-circuits
  // on before ever reaching request items).
  if (result.literal_source_absence !== undefined) return none;

  // Finding 5 fix: a cheap, INDEX-FREE pre-gate ahead of the workspace walk.
  // `extractRequestItems`'s item COUNT never depends on the index (an
  // `RequestItemIndexView` only ever widens `.aliases` on an item that is
  // pushed regardless — see requestItems.ts's own `aliasesFor`/`pushXxx`
  // helpers: every `items.push(...)` call site runs unconditionally, and
  // `index` only feeds the `aliases:` field of the object already being
  // constructed), so this exactly predicts the post-walk gate below and lets
  // every single-target query (the overwhelming majority) skip
  // `enumerateFindTextUniverse` entirely.
  // TL142-04 Decision 6 (2026-09-13): a single-item query naming an
  // explicitly QUOTED literal still deserves this machinery's absence-
  // disclosure/search-target treatment (report's own acceptance: a quoted
  // identical string must stay a target even though the item count alone
  // would otherwise route it away as "just one point").
  if (extractRequestItems(query).length < 2 && !queryHasQuotedLiteral(query)) return none;

  const pass = cachedRequestItemPass(workspace, result);
  if (pass === undefined) return none;
  const { universe, contentCache } = pass;
  // Review finding 2(b) fix (2026-09-08): computed once per pack build
  // (memoized on `pass`), consulted only by the two absence-proof paths
  // below — candidate resolution elsewhere in this function keeps using the
  // narrower `universe` unchanged. See `ensureAbsenceUniverse`'s own doc
  // comment.
  const absenceUniverse = ensureAbsenceUniverse(workspace, pass);
  const index = createRequestItemIndexView({ relPaths: universe.files.map((f) => f.relPath) });
  const items = extractRequestItems(query, index);
  markFacetOwnedPoints(items, query);
  // Contract §3.4: a single-item query already proved by `surface-content`
  // must stay byte-identical — only a genuinely composite request (2+
  // explicit points) engages this mechanism at all. TL142-04 Decision 6
  // exemption (2026-09-13): mirrors the index-free pre-gate above — an
  // explicitly quoted literal still earns this mechanism's treatment even
  // as this query's only point.
  if (items.length < 2 && !queryHasQuotedLiteral(query)) return none;
  // A structured signal (a named setting/config DEFINITION, a named
  // identifier's DECISION, or a producer->consumer RELATION) is required
  // before this mechanism engages at all — every item being an unstructured
  // `topic` means the split (often just a semicolon/"and" inside one prose
  // sentence, e.g. "Trace how X builds Y; identify the implementation path")
  // is far more likely to be ordinary multi-clause prose than a genuine
  // multi-point request in design §4.1's sense. Observed regression:
  // replayCorpus.spec.ts's "observed directory task_pack" and "d12a" cases
  // split on a bare semicolon/and into two topic-only fragments and blocked
  // an otherwise-ready certificate.
  if (!items.some((item) => item.kind !== "topic")) {
    // DESIGN-v0.15 R1 §4.2 (2026-09-08, P1-2 residual): the gate above keeps
    // an all-topic composite request from creating BLOCKING obligations (the
    // documented d12a/replayCorpus regression — ordinary multi-clause prose
    // split on "and"/";" must never demand evidence for fake points). That
    // guarantee is unchanged: this branch pushes no obligation, no gap, no
    // candidate path, ever. But a topic item that is independently VERIFIED
    // ABSENT — zero workspace occurrences, proved by the exact same
    // `proveUnbindableRequestItem`/`absentTerm` scan every other
    // request-item proof in this file uses, over `absenceUniverse` (never a
    // capped/partial scan: the WIDENED, find-consistent listing —
    // `ensureAbsenceUniverse`/review finding 2(b) — never the narrower
    // `enumerateFindTextUniverse` result alone) and never for a term this
    // pack's own served evidence already answers (review finding 2(a)) — is
    // real, disclosable information that costs nothing to surface and can
    // never block a certificate. An item with ANY occurrence (served or not)
    // is left alone exactly as before this fix: no readiness obligation, no
    // re-scan demanded for it.
    const epochTokens = tokenizeForEpoch(query);
    const priorEvidence = epochServedEvidence(workspace, result, epochTokens, profile);
    traceRequestItemEpochReuse(workspace, priorEvidence, codeTaskPackSurfaces(result.surfaces));
    const absences: Array<{ id: string; term: string; scope_complete: boolean; omitted_count: number; incidental?: boolean }> = [];
    // R-D2 (item B): the ALL-TOPIC pass's own could-not-determine disclosures
    // — see `RequestItemReadiness.undetermined`'s own doc comment. Populated
    // by the SAME per-item loop that fills `absences`, so every exit of this
    // branch returns both.
    const undetermined: Array<{ id: string; term: string; reason: string }> = [];
    // FIX-C2: whether the absence-only pass left any item genuinely OPEN
    // (`proof.proved === false` — a candidate exists but is not served, or the
    // scan could not be bounded). Only read by the `analysis-source`
    // reconciliation below, which refuses to discharge anything while a
    // concern of this same query is still open.
    let absencePassAnyOpen = false;

    // H-2 (2026-09-19): an all-topic composite request made of >=2
    // INDEPENDENT QUESTION clauses (each its own interrogative head, or JA
    // 疑問詞+か/？ — see requestItems.ts's `isIndependentQuestionClause` for
    // the exact boundary and its negative-case table: an imperative
    // fragment, a parenthetical list inside ONE question, a bracket tag, a
    // header line never qualify) is a genuine multi-point request (D2),
    // never the d12a/"observed directory task_pack"-style prose the gate
    // above protects. Scoped to `profile:"answer"` only (H-2 spec) — a
    // `generic` (edit) task keeps the unconditional absence-only treatment
    // below for every all-topic query, exactly as before this fix.
    //
    // H-4 (fix-b, 2026-09-21, TL-04(a)): `isIndependentQuestionClause` widened
    // to `headIsWhAfterReadLead` — a clause led by a closed, already-reviewed
    // read-only verb ("Explain how X", "Show me how X") is exactly as
    // independent a question as a bare "How is X". Without this, clause 1 of
    // `<read lead> <wh1>, <wh2>, …, and <whN>` was SYSTEMATICALLY excluded
    // from this set (it alone carries the shared lead verb, so it alone
    // failed the OLD bare-wh-head test), so its own point silently never
    // became a blocking obligation while every later clause's did. See
    // requestItems.ts's own doc comment on `headIsWhAfterReadLead` for the
    // full root-cause writeup and why this cannot widen to an arbitrary
    // imperative.
    const independentQuestions = profile === "answer"
      ? items.filter((item) => headIsWhAfterReadLead(item.text))
      : [];
    const questionIds = independentQuestions.length >= 2
      ? new Set(independentQuestions.map((item) => item.id))
      : undefined;

    for (const item of items) {
      if (questionIds?.has(item.id)) continue;
      // C5 (fix-c, 2026-09-21, plan §6.1): an item that IS ITSELF just an
      // example/elaboration fragment ("such as trailing whitespace") names
      // no independent concern of its own to disclose absent — it is
      // illustrative prose `splitEnumerated`'s comma-based split has cut
      // into its own item, not a second point the query asks about
      // (confirmed live: "Explain how the parser handles comments, such as
      // trailing whitespace, and how errors are logged." certified
      // "trailing" request-item-absent — a fragment of the FIRST point's
      // own example, never a concern on its own). Recognized structurally
      // by this item's own leading words; never a change to the splitting
      // mechanism itself (requestItems.ts, out of this fix's region) —
      // this only ever REMOVES a spurious absence claim, never widens one.
      if (EXAMPLE_FRAGMENT_LEAD_RE.test(item.text.trim())) continue;
      // Copilot retest r4 (2026-10-02): a clause that only says how to cite or
      // present the answer and names nothing unserved ("Need source line
      // numbers", "read relevant checkout source files") is no point of the
      // workspace — see `citationClauseNamesOnlyServedThings`. Without it this
      // pass certified `request-item-absent:source`, or, once citation words
      // stopped being absence candidates, `request-item-undetermined:read/...`.
      if (citationClauseNamesOnlyServedThings(item.text, priorEvidence)) continue;
      // A distinctive, non-diluted term takes priority: `cache`/
      // `implementation` co-occurring in the same clause as a genuinely
      // absent `Redis`/`redis`/`実装` otherwise satisfies the whole-item
      // union check below and hides the absence design §4.2 exists to
      // surface. `distinctiveSalientAbsence` generalizes the old
      // capitalized-only signal into three ordered tiers (capitalized/
      // identifier-shaped, CJK, lowercase-EN — see its own doc comment) so a
      // lowercase or Japanese absent topic is no longer silently dropped.
      // Both this call and the fallback below (review findings 2(a)/2(b))
      // skip a term this very pack's OWN served evidence already answers,
      // and scan the find-consistent `absenceUniverse` rather than the
      // narrower `universe`.
      // r5 review: a citation clause is judged on what it names — see
      // `withoutCitationWords`.
      const absenceItem = withoutCitationWords(item);
      const distinctive = distinctiveSalientAbsence(absenceItem, priorEvidence, workspace, absenceUniverse, contentCache);
      const distinctiveAbsence = distinctive?.kind === "absent" ? distinctive : undefined;
      if (distinctiveAbsence !== undefined) {
        // C1 (fix-c, 2026-09-21): defense-in-depth veto — see
        // `absenceContradictsServedEvidence`'s own doc comment. The
        // per-candidate scanner already skips a term ITS OWN loop finds
        // evidenced; this catches the case where a DIFFERENT surface (or a
        // later hop's evidence) answers it instead.
        const vetoed = absenceContradictsServedEvidence(distinctiveAbsence.term, item.text, priorEvidence, workspace);
        if (!vetoed) {
          absences.push(asCreateIfIntroduced(item, {
            id: item.id,
            term: distinctiveAbsence.term,
            scope_complete: distinctiveAbsence.scopeComplete,
            omitted_count: distinctiveAbsence.omittedCount,
          }));
        }
        traceRequestItemStatus(workspace, item, {
          status: vetoed ? "covered" : (distinctiveAbsence.scopeComplete ? "absent-in-scope" : "could-not-determine"),
          evidence: [],
          reason: vetoed
            ? `served evidence contradicts distinctive absence of ${distinctiveAbsence.term}`
            : `distinctive absent term ${distinctiveAbsence.term}`,
          scopeComplete: distinctiveAbsence.scopeComplete,
        });
        continue;
      }
      const proof = proveUnbindableRequestItem(absenceItem, priorEvidence, workspace, absenceUniverse, contentCache);
      const vetoedProof = proof.proved && proof.absentTerm !== undefined
        && absenceContradictsServedEvidence(proof.absentTerm, item.text, priorEvidence, workspace);
      if (proof.proved && proof.absentTerm !== undefined && !vetoedProof) {
        absences.push(asCreateIfIntroduced(item, {
          id: item.id,
          term: proof.absentTerm,
          scope_complete: proof.absentScopeComplete ?? false,
          omitted_count: proof.absentOmittedCount ?? 0,
          ...(proof.absentIncidental === true ? { incidental: true } : {}),
        }));
      } else if (!proof.proved && proof.undeterminedTerm !== undefined) {
        // R-D2 (item B): `proof.undeterminedTerm` is set ONLY when
        // `decideConcernStatus` returned `could-not-determine` with no
        // `absentTerm` (see that field's own doc comment) — the ELSE here is
        // structural, not a narrowing choice: the two never both hold on one
        // proof. Invariant (i) holds by construction: `decideConcernStatus`
        // checks coverage FIRST and only reaches could-not-determine when
        // this exact evidence already failed to cover the concern.
        undetermined.push({ id: item.id, term: proof.undeterminedTerm, reason: proof.reason });
      } else if (distinctive?.kind === "ineligible" && proof.absentTerm === undefined) {
        // WP-C3 (orchestrator RULING rule 4 — a non-eligible point is never
        // silently dropped). Before the ruling, `distinctiveSalientAbsence`
        // CERTIFIED this point absent through a word the ruling forbids — a
        // predicate or descriptor ("…how the locale tag is resolved?" →
        // `request-item-absent:resolved`, the only thing that named the point:
        // its subject occurs, in unserved README prose, so this pass leaves it
        // open and silent). The word still occurs nowhere, and nothing covers
        // the point, so it is disclosed as undetermined — the existing
        // vocabulary, non-blocking like everything this pass mints — instead
        // of certifying a term the ruling never certifies. A point the policy
        // DOES cover off served evidence stays silent, exactly as before.
        const topicTerms = concernTopicTerms(absenceItem.text);
        const coveredNow = topicTerms.length > 0
          && concernCoveredByServedEvidence(absenceItem.text, topicTerms, concernVariantMap(topicTerms, workspace), priorEvidence, workspace).covered;
        if (!coveredNow) {
          const words = topicTerms.length > 0 ? topicTerms : [distinctive.term];
          undetermined.push({
            id: item.id,
            term: words.join("/"),
            reason: `${distinctive.term} occurs nowhere but is a predicate or descriptor; nothing served covers the point — not a verified absence`,
          });
        }
      }
      // R2-T2 (2026-09-30, review-0929 P0-5, orchestrator RULING): a point a
      // coordinated noun-phrase split produced ("Explain X and the health
      // probe" → "the health probe", `RequestItem.coordinated`) is its OWN
      // point — located or disclosed, never left silently open behind the
      // other conjunct's evidence. This pass still mints no obligation (the
      // d12a guarantee above): an unproved coordinated point that no branch
      // above disclosed is disclosed here, non-blocking, naming the unserved
      // candidate(s) — the existing request-item-undetermined vocabulary.
      if (item.coordinated === true && !proof.proved
        && !absences.some((entry) => entry.id === item.id)
        && !undetermined.some((entry) => entry.id === item.id)) {
        undetermined.push(coordinatedPointUndetermined(item, proof));
      }
      // R2-T2 follow-up (orchestrator, final gate: qualityFirst0143 Q02
      // "jp-to-particle"): a NON-BLOCKING could-not-determine proof
      // (`undeterminedNonBlocking` — WP-C2's no-eligible-term arms, the
      // katakana ruling's unmapped loanword) is a final, disclosed
      // determination with nothing a later call could fetch for it, not an
      // OPEN point — the H-2 and mixed-kind loops already mint it as a
      // "proved" obligation. Counting it as open here kept `analysis-source`
      // from discharging, so 「認証情報の検証方法と、データベースマイグレーション…」
      // (its migration point undetermined since the katakana ruling) never
      // certified the served auth answer.
      if (!proof.proved && proof.undeterminedNonBlocking !== true) absencePassAnyOpen = true;
      traceRequestItemStatus(workspace, item, {
        status: vetoedProof ? "covered" : requestItemTraceStatus(proof),
        evidence: proof.evidence,
        reason: vetoedProof ? `served evidence contradicts absence of ${proof.absentTerm}` : proof.reason,
        scopeComplete: proof.absentScopeComplete,
      });
    }

    if (questionIds === undefined) {
      // FIX-C2: the absence-only pass mints no obligation of its own (the
      // reviewed d12a/"observed directory" guarantee, invariant (iv)), but it
      // DOES establish every item's status — so it can still discharge an
      // `analysis-source` obligation that is stuck on this call's own fresh
      // surfaces while the caller demonstrably holds the implementation.
      // Discharge only: this branch still adds no blocking obligation.
      reconcileAnalysisSourceFromRequestItems(otherObligations, items, absencePassAnyOpen, priorEvidence, workspace);
      return { obligations: [], absences, undetermined };
    }

    // >=2 independent questions: mint the SAME blocking obligations and
    // bounded `request_item_gap` next the mixed-kind path below already
    // mints, through the EXISTING `proveUnbindableRequestItem` proof engine
    // — reuse, never fork. `proveRequestItem` (the dispatcher) is not
    // called here: every item in this branch is `kind:"topic"` by this
    // gate's own invariant (`!items.some((item) => item.kind !== "topic")`
    // above), so it would always fall through to this same call anyway —
    // this inlines that fallthrough plus its own `ownedFacets`
    // short-circuit (copied verbatim) instead of widening
    // `proveRequestItem`'s own signature, which is out of this fix's scope.
    const ownedFacets = new Set(enumeratedQueryItemsForEpoch(query, workspace).map((facetItem) => facetItem.facet));
    const obligations: TaskReadinessObligation[] = [];
    const missingTargets = new Set<string>();
    const missingRangeTargets: Array<{ path: string; range: string }> = [];
    const gapIds: string[] = [];
    for (const item of independentQuestions) {
      let proof: RequestItemProof;
      if (ownedFacets.size > 0 && salientWords(item.text).some((word) => ownedFacets.has(word.toLowerCase()))) {
        proof = {
          proved: true,
          evidence: [],
          reason: "this point's salient wording is already tracked by the query's own enumerated-item obligation (F-V13-6/F-V14); not duplicated as a separate request-item obligation",
          candidatePaths: [],
        };
      } else {
        proof = proveUnbindableRequestItem(item, priorEvidence, workspace, absenceUniverse, contentCache, { requireDistinctConcentration: true });
      }
      // WP-C2 (2026-09-29, eval-0929 §6/§8, rule 2): a proof flagged
      // `undeterminedNonBlocking` (set ONLY by rule 1's own two
      // "no literal-eligible term" arms in `proveUnbindableRequestItem` —
      // never by the PRE-EXISTING R-D2 indeterminate arms, "unreadable
      // candidate"/"too many candidates", which keep blocking exactly as
      // before: those name a real, fetchable path a caller could still try)
      // is NON-BLOCKING, the same "at most request-item-undetermined
      // (disclosed, non-blocking)" status the absence-only pass already
      // gives it elsewhere in this file. Treating it as a required, blocking
      // `uncovered` obligation here (this loop's OLD, unconditional shape)
      // turned rule 1's own honesty tightening into a genuine DEAD END for
      // the "2 independent questions, one absent-with-no-literal-eligible-
      // term" shape: `candidatePaths` is always empty for THIS proof shape,
      // so nothing ever names a next call for it and the pack could neither
      // close nor progress (measured live: requestItemGateMatrix.spec.ts's
      // `en|Explain|and|absent|real`/`en|Walk me through|numbered|absent|
      // real` seeded cells, "c-dead-end(follow)"/"c-no-decision(follow)").
      const undeterminedNonBlocking = proof.undeterminedNonBlocking === true;
      // 2026-11 (external A/B of v0.16.4, TokenLighten's own repository, T3):
      // once a PRODUCT file is served for this question, a point whose only
      // remaining candidates are tests, bench fixtures or templates is not
      // chased into them — see `auxiliaryOnlyCandidatesAfterProductEvidence`.
      // Disclosed as could-not-determine (non-blocking, the existing
      // vocabulary), naming the files it did not fetch.
      const remainingCandidates = proof.proved || undeterminedNonBlocking ? [] : nonDocNoiseCandidatePaths(proof.candidatePaths, item.text);
      const auxiliaryOnly = remainingCandidates.length > 0
        && (proof.rangeCandidates ?? []).length === 0
        && auxiliaryOnlyCandidatesAfterProductEvidence(remainingCandidates, item.text, priorEvidence);
      obligations.push({
        id: `${REQUEST_ITEM_OBLIGATION_PREFIX}${item.id}`,
        kind: "concern",
        status: proof.proved || undeterminedNonBlocking || auxiliaryOnly ? "proved" : "uncovered",
        required: true,
        evidence: proof.evidence,
        reason: auxiliaryOnly
          ? `${proof.reason}; the only unserved candidates (${remainingCandidates.slice(0, 3).join(", ")}) are test/fixture files, not fetched after the product source was served`
          : proof.reason,
        origin: "query",
      });
      const vetoedQuestion = proof.proved && proof.absentTerm !== undefined
        && absenceContradictsServedEvidence(proof.absentTerm, item.text, priorEvidence, workspace);
      if (undeterminedNonBlocking) {
        undetermined.push({ id: item.id, term: proof.undeterminedTerm!, reason: proof.reason });
      } else if (auxiliaryOnly) {
        const topicTerms = concernTopicTerms(item.text);
        undetermined.push({
          id: item.id,
          term: topicTerms.length > 0 ? topicTerms.join("/") : item.text,
          reason: `only test/fixture files (${remainingCandidates.slice(0, 3).join(", ")}) spell this point; they were not fetched after the product source was served — answer from the served source or name the test`,
        });
      } else if (!proof.proved) {
        gapIds.push(item.id);
        for (const p of remainingCandidates) missingTargets.add(p);
        for (const rt of proof.rangeCandidates ?? []) missingRangeTargets.push(rt);
      } else if (proof.absentTerm !== undefined && !vetoedQuestion) {
        absences.push(asCreateIfIntroduced(item, {
          id: item.id,
          term: proof.absentTerm,
          scope_complete: proof.absentScopeComplete ?? false,
          omitted_count: proof.absentOmittedCount ?? 0,
          ...(proof.absentIncidental === true ? { incidental: true } : {}),
        }));
      }
      traceRequestItemStatus(workspace, item, {
        status: vetoedQuestion ? "covered" : requestItemTraceStatus(proof),
        evidence: proof.evidence,
        reason: vetoedQuestion ? `served evidence contradicts absence of ${proof.absentTerm}` : proof.reason,
        scopeComplete: proof.absentScopeComplete,
      });
    }
    reconcileAnalysisSourceFromRequestItems(
      otherObligations,
      independentQuestions,
      obligations.some((obligation) => obligation.status !== "proved"),
      priorEvidence,
      workspace,
    );
    if (missingTargets.size === 0 && missingRangeTargets.length === 0) {
      return { obligations, absences, undetermined };
    }
    const rangeTargetPaths = new Set(missingRangeTargets.map((t) => t.path));
    const pathTargets = [...missingTargets].filter((p) => !rangeTargetPaths.has(p)).map((p) => ({ path: p }));
    const rangeTargets = missingRangeTargets.map((t) => ({ path: t.path, range: t.range }));
    return {
      obligations,
      absences,
      undetermined,
      gap: {
        next_call: {
          tool: "tl_read_file",
          arguments: {
            query,
            targets: [...pathTargets, ...rangeTargets].slice(0, MAX_REQUEST_ITEM_BATCH),
            content: "auto",
          },
        },
        ids: gapIds,
      },
    };
  }

  const epochTokens = tokenizeForEpoch(query);
  const priorEvidence = epochServedEvidence(workspace, result, epochTokens, profile);
  traceRequestItemEpochReuse(workspace, priorEvidence, codeTaskPackSurfaces(result.surfaces));

  // OWNERSHIP RULE: the query's own enumerated-item facets (F-V13-6/F-V14),
  // computed the identical way `buildReadinessObligations` mints them —
  // `proveRequestItem`'s own doc comment on its `ownedFacets` parameter has
  // the full rationale for why a request item overlapping one of these must
  // defer rather than mint a second, competing obligation over the same
  // plain-prose checklist point.
  const ownedFacets = new Set(enumeratedQueryItemsForEpoch(query, workspace).map((facetItem) => facetItem.facet));

  const obligations: TaskReadinessObligation[] = [];
  const missingTargets = new Set<string>();
  // DESIGN-v0.15 R1 false-completion fix (2026-09-07, P1): a path already
  // (partially) served but not YET covering its proof-critical declaration
  // range — see `RequestItemProof.rangeCandidates`'s own doc comment.
  // Collected separately from `missingTargets` (which requests a whole
  // UNSERVED path) so the batched follow-up fetches exactly this narrower
  // declaration RANGE, never re-reading a file this task already has bytes
  // for as an undifferentiated whole.
  const missingRangeTargets: Array<{ path: string; range: string }> = [];
  const gapIds: string[] = [];
  // DESIGN-v0.15 R1 (2026-09-07): request items PROVED by verified absence
  // (`RequestItemProof.absentTerm`) — see `RequestItemReadiness.absences`'s
  // own doc comment for where this feeds the wire.
  const absences: Array<{ id: string; term: string; scope_complete: boolean; omitted_count: number; incidental?: boolean }> = [];
  // WP-C4 (2026-09-29, eval-0929 §8 item 3): the mixed-kind loop's own
  // could-not-determine disclosures — see the loop's `undeterminedNonBlocking`
  // handling below and `RequestItemReadiness.undetermined`'s own doc comment.
  const undetermined: Array<{ id: string; term: string; reason: string }> = [];

  for (const item of items) {
    // WP-S5 (A): a clause that only constrains the answer's FORM or the
    // agent's BEHAVIOUR is not an evidence point — it asks nothing about the
    // repository, so it can neither be proved nor discovered. Skipped whole
    // (no obligation, no candidate paths), never minted as "proved", so it
    // also never joins the certificate as a claim this pack did not make.
    if (identifierGroundingEnabled() && isFormatOrBehaviourClause(item.text)) continue;
    // Copilot retest r5 review (2026-10-03): the same citation-clause test the
    // all-topic pass runs, here too — "How does backoff() consume
    // RETRY_BASE_MS from config.ts? Cite file names and give code snippets."
    // certified `request-item-absent:give` without it (ungated, like the
    // all-topic call).
    if (citationClauseNamesOnlyServedThings(item.text, priorEvidence)) continue;
    const proof = proveRequestItem(withoutCitationWords(item), items, priorEvidence, workspace, universe, absenceUniverse, contentCache, ownedFacets);
    // WP-C4 (2026-09-29, eval-0929 §8 item 3): mirrors the ALL-TOPIC/H-2
    // loops' own `undeterminedNonBlocking` handling (WP-C2) — see this
    // function's post-loop `return`s for the full root-cause writeup (a
    // could-not-determine proof with no literal-eligible term names no
    // `candidatePaths` at all, so treating it as a BLOCKING `uncovered`
    // obligation here, unconditionally, was this loop's own dead end: the
    // repro "Explain how shouldRetry decides, and what happens when it
    // gives up?" — kind:"decision" for the first clause routes here, never
    // through the all-topic branch above — used to reach `await_input` with
    // no candidate and no `next` for the "gives up" clause).
    const undeterminedNonBlocking = proof.undeterminedNonBlocking === true;
    // R2-T2 (2026-09-30, orchestrator ruling on review-0929 P0-5's follow-up):
    // a COORDINATED point (`RequestItem.coordinated` — "…decides and the health
    // probe") whose candidates are all dropped as doc noise below
    // (`nonDocNoiseCandidatePaths`: a README that only narrates it), or that
    // has no candidate at all and no ranged frontier, has nothing a later call
    // could fetch. Blocking on it left the pack a `discover` whose chain never
    // certified (measured: its `next` read another point's range, then the
    // chain ended). It becomes the same NON-blocking request-item-undetermined
    // disclosure the all-topic pass emits, naming its candidates, so the rest
    // of the pack can certify. A coordinated point with a LIVE code candidate
    // (or a ranged one) keeps blocking with its ranged `next`, as before.
    const coordinatedUnfetchable = item.coordinated === true && !proof.proved && !undeterminedNonBlocking
      && nonDocNoiseCandidatePaths(proof.candidatePaths, item.text).length === 0
      && (proof.rangeCandidates ?? []).length === 0;
    // 2026-11 (external A/B of v0.16.4, TokenLighten's own repository, T3):
    // the same rule the independent-question loop applies — once product
    // source is served, a point whose only remaining candidates are tests,
    // bench fixtures or templates is disclosed, not chased
    // (`auxiliaryOnlyCandidatesAfterProductEvidence`).
    const mixedRemaining = proof.proved || undeterminedNonBlocking || coordinatedUnfetchable
      ? [] : nonDocNoiseCandidatePaths(proof.candidatePaths, item.text);
    const auxiliaryOnlyMixed = mixedRemaining.length > 0
      && (proof.rangeCandidates ?? []).length === 0
      && auxiliaryOnlyCandidatesAfterProductEvidence(mixedRemaining, item.text, priorEvidence);
    obligations.push({
      id: `${REQUEST_ITEM_OBLIGATION_PREFIX}${item.id}`,
      kind: "concern",
      status: proof.proved || undeterminedNonBlocking || coordinatedUnfetchable || auxiliaryOnlyMixed ? "proved" : "uncovered",
      required: true,
      evidence: proof.evidence,
      reason: coordinatedUnfetchable
        ? coordinatedPointUndetermined(item, proof).reason
        : auxiliaryOnlyMixed
          ? `${proof.reason}; the only unserved candidates (${mixedRemaining.slice(0, 3).join(", ")}) are test/fixture files, not fetched after the product source was served`
          : proof.reason,
      origin: "query",
    });
    // FIX-C2 (2026-09-21), invariant (i) — the mixed-kind loop was the ONE
    // request-item path that never consulted the served-evidence veto, so a
    // structured `definition`/`relation`/`decision` arm could (and did, on
    // the four-concern fixture) emit `request-item-absent` for a concern in
    // the SAME response that served the body of the file implementing it.
    // Same single policy, same call shape as the H-2 and all-topic loops.
    const vetoedMixed = proof.proved && proof.absentTerm !== undefined
      && absenceContradictsServedEvidence(proof.absentTerm, item.text, priorEvidence, workspace);
    if (undeterminedNonBlocking) {
      undetermined.push({ id: item.id, term: proof.undeterminedTerm!, reason: proof.reason });
    } else if (coordinatedUnfetchable) {
      undetermined.push(coordinatedPointUndetermined(item, proof));
    } else if (auxiliaryOnlyMixed) {
      const topicTerms = concernTopicTerms(item.text);
      undetermined.push({
        id: item.id,
        term: topicTerms.length > 0 ? topicTerms.join("/") : item.text,
        reason: `only test/fixture files (${mixedRemaining.slice(0, 3).join(", ")}) spell this point; they were not fetched after the product source was served — answer from the served source or name the test`,
      });
    } else if (!proof.proved) {
      gapIds.push(item.id);
      for (const p of mixedRemaining) missingTargets.add(p);
      for (const rt of proof.rangeCandidates ?? []) missingRangeTargets.push(rt);
    } else if (proof.absentTerm !== undefined && !vetoedMixed) {
      absences.push(asCreateIfIntroduced(item, {
        id: item.id,
        term: proof.absentTerm,
        scope_complete: proof.absentScopeComplete ?? false,
        omitted_count: proof.absentOmittedCount ?? 0,
        ...(proof.absentIncidental === true ? { incidental: true } : {}),
      }));
    }
    if (vetoedMixed) {
      traceRequestItemStatus(workspace, item, {
        status: "covered",
        evidence: proof.evidence,
        reason: `served evidence contradicts absence of ${proof.absentTerm}`,
        scopeComplete: proof.absentScopeComplete,
      });
    } else {
      traceRequestItemProof(workspace, item, proof);
    }
    // Finding 3 fix (2026-09-07, residual dead end): a PROVED `decision`
    // item here and an UNRELATED, older `identifier:<X>` obligation
    // (`buildReadinessObligations`'s `explicitCodeIdentifiers` loop) can
    // disagree about the IDENTICAL identifier. That older obligation checks
    // ONLY this turn's own freshly-served surfaces (no epoch carry-forward —
    // `epochServedEvidence`/`priorEvidence` above is this mechanism's OWN,
    // newer fix for exactly that staleness), so it can go stale precisely
    // when this item just proved the same identifier from carried-forward
    // evidence. Left alone, once every request item closes this same turn
    // (nothing left for `missingTargets`/`gapIds` to carry), the generic
    // dispatch (`nextCallForUnresolved`) picks the STALE obligation's own
    // `tl_search_files action:"symbols"` next — a call with no continuation of
    // its own, i.e. the exact dead end this finding closes (reproduced:
    // `consumer-does-not-reference`, EN_QUERY: `request-item:ri-1` proves
    // `getDisplayLanguage` from language.ts served two turns earlier, while
    // `identifier:getDisplayLanguage` — same token — sees only this turn's
    // statusBar.ts/updateChecker.ts and reports uncovered). A `next_call`
    // that RE-FETCHES language.ts is not a fix: the wire layer's own
    // already-consumed filter (correctly) drops a call targeting bytes this
    // task already has, which is exactly what silently discarded that
    // approach here. Reconciling the STALE obligation in place — never
    // touching `buildReadinessObligations`'s own code, only the one entry
    // this item ALREADY independently proved — is the narrow, safe fix: two
    // obligations about the identical fact must not disagree.
    if (proof.proved && item.kind === "decision" && item.terms.length > 0) {
      const identifier = item.terms[0]!;
      const stale = otherObligations.find(
        (obligation) => obligation.status !== "proved" && obligation.id === `identifier:${identifier}`,
      );
      // SHOULD-FIX 29 / SHOULD-FIX 28 (2026-09-14, review round 4): two
      // obligations about the identical fact must not disagree — and the one this
      // writes into has a STANDARD (`exactIdentifierEvidence`: a code-bearing
      // occurrence, or a parser-anchored `symbol`). Reconciling across the two
      // engines is only honest when the incoming proof meets that standard too;
      // otherwise this was a second door around it, and an extensionless
      // `bin/tool` certified `identifier:plasmaConduitMode` through it while the
      // direct route correctly refused. The staleness fix this guard sits on is
      // untouched for the case it was written for (a real declaration in a
      // classified language, served an earlier turn).
      if (stale !== undefined && proofCitesCodeBearingOccurrence(workspace, proof.evidence, identifier)) {
        stale.status = "proved";
        stale.evidence = proof.evidence;
        stale.reason = `reconciled from request-item:${item.id}, which independently proved identifier ${identifier} from carried-forward evidence`;
      }
    }
  }

  reconcileAnalysisSourceFromRequestItems(
    otherObligations,
    items,
    obligations.some((obligation) => obligation.status !== "proved"),
    priorEvidence,
    workspace,
  );
  if (missingTargets.size === 0 && missingRangeTargets.length === 0) {
    // WP-C4 (2026-09-29, eval-0929 §8 item 3): R-D2's own comment here used
    // to read "this side channel is scoped to that ALL-TOPIC pass only, per
    // plan §5" — but DESIGN-v0.14-plan.md §5 ("Literal-first decision run")
    // is a different feature area entirely and says nothing about request-
    // item completion; the citation was stale/mistaken, not a real
    // constraint, and nothing else in the design docs (grepped: no other
    // "R-D2" mention names this restriction as intentional either) forbids
    // widening it. A could-not-determine item with a real candidate path
    // (the PRE-EXISTING R-D2 arms this loop already handled correctly, via
    // the ordinary `uncovered` -> `gap`/`await_input` route) still blocks
    // exactly as before; only a proof with NO literal-eligible term at all
    // (WP-C2's `undeterminedNonBlocking`, `candidatePaths` always empty for
    // that shape) is now non-blocking here too — the same "disclosed, never
    // a dead end" contract the ALL-TOPIC/H-2 loops already give it, so a
    // mixed-kind pack can close on a real point instead of stalling forever
    // on one that names nothing to fetch.
    return { obligations, absences, undetermined };
  }
  // A path riding missingRangeTargets already has a scoped entry in this
  // same batch — never ALSO add its plain-path form (that would be exactly
  // the whole-file re-read this fix exists to avoid).
  const rangeTargetPaths = new Set(missingRangeTargets.map((t) => t.path));
  const pathTargets = [...missingTargets]
    .filter((p) => !rangeTargetPaths.has(p))
    .map((p) => ({ path: p }));
  const rangeTargets = missingRangeTargets.map((t) => ({ path: t.path, range: t.range }));
  return {
    obligations,
    absences,
    undetermined,
    gap: {
      next_call: {
        tool: "tl_read_file",
        arguments: {
          query,
          targets: [...pathTargets, ...rangeTargets].slice(0, MAX_REQUEST_ITEM_BATCH),
          content: "auto",
        },
      },
      ids: gapIds,
    },
  };
}

// ---------------------------------------------------------------------------
// FIX-G (2026-09-27, eval-0927 P0) — THE FACET COMPLETION GATE.
//
// eval-0927 §3: "Explain the default HTTP_TIMEOUT_MS value, the shouldRetry
// conditions, and the callers of fetchWithRetry." certified `act.answer` with
// neither constant's definition and ZERO callers on the wire. None of the
// obligations above can see that: `identifier:<X>` is proved by any MENTION of
// X, `behavior-body` by any callable body, and the ALL-TOPIC request-item
// branch never mints a blocking obligation (d12a — see its own comment).
//
// A FACET (requestFacets.ts: value / condition / callers / flow) is a
// structural evidence duty, not a prose "point": the question names WHICH KIND
// of evidence an answer must show, and FIX-C1's closure hook resolved WHERE it
// lives (a focal callable, the module constants it reads, its call sites, its
// callees) and recorded that as a plan (facetGate.ts). So every facet mints ONE
// required obligation here — independent of the request-item item-count gates
// and of the ALL-TOPIC branch — and the d12a guarantee still holds in its own
// terms: no facet obligation is ever BLOCKING without a concrete closure
// target (a known, unserved line window that its `next` reads); a facet with no
// target is covered, verified-empty (disclosed), or could-not-determine
// (disclosed, non-blocking).
//
// STATUS goes through THE ONE policy, `decideConcernStatus`: the facts from
// facetGate.ts become a ConcernCoverageVerdict (covered: every required window
// served in this epoch — this pack's surfaces plus the same-sha served-range
// ledger, `epochServedEvidence`) and a ConcernScanOutcome (`unserved-
// candidates` → open; `indeterminate` → could-not-determine). Status →
// obligation: covered / could-not-determine → "proved" (the latter with an
// `explicit-gap:request-item-undetermined:` disclosure); open → "uncovered",
// blocking, and its exact unserved windows join `request_item_gap.next_call`
// (the batched, query-bearing ranged read every request-item path already
// rides — `nextCallForUnresolved`, the R-B1 route lift and the no-dead-end
// guard all key on the shared `request-item:` prefix).
//
// ID: `request-item:facet-<n>:<facet>`, n = the 1-based position in
// `extractFacetRequirements(query)` — deterministic per query, so a re-pack
// names the same obligation; one grep (`request-item:facet-`); and never an
// `ri-N` id, so no request-item consumer that looks an item up by id (the
// absence re-veto's REQUEST_ITEM_ABSENCE_ID_RE, the enumerated-item owner
// check) can mistake one for the other.
//
// `inventory_complete` (the certificate's workspace marker) is scan coverage
// and is never read here: readiness is decided only by served evidence.
// ---------------------------------------------------------------------------

export const FACET_OBLIGATION_ID_PREFIX = `${REQUEST_ITEM_OBLIGATION_PREFIX}facet-`;

export interface FacetReadinessEntry {
  /** The id's own part: `<n>`, the 1-based position in `extractFacetRequirements(query)`, or `dependency:<callable>` for a dependency entry (`dependency`). */
  readonly label: string;
  /** 2026-10-06 (P1-1/P1-2): an entry for the constants a served callable reads (`FacetPlanEntry.dependency`), present only while it is open or disclosed. Never owns a request item, never grounds `analysis-source`. */
  readonly dependency?: true;
  readonly requirement: FacetRequirement;
  readonly facts: FacetFacts;
  readonly status: ConcernStatus;
  readonly obligation: TaskReadinessObligation;
  /** The served surfaces behind `facts.servedWindows`, whatever the status (an OPEN facet can still have part of its closure on the wire). */
  readonly servedEvidence: readonly TaskReadinessEvidence[];
}

export interface FacetReadiness {
  readonly entries: readonly FacetReadinessEntry[];
  /** Exact unserved windows of every OPEN facet, in requirement order, deduped. */
  readonly openTargets: ReadonlyArray<{ readonly path: string; readonly range: string }>;
  /** `certificate.gaps` disclosures (verified-empty / could-not-determine), ids `facet-<n>`. */
  readonly disclosures: ReadonlyArray<{ readonly id: string; readonly term: string; readonly word: "request-item-empty" | "request-item-undetermined"; readonly reason: string }>;
}
