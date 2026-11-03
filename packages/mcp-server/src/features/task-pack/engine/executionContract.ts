import {appendNaturalObligations, projectNaturalRequestItems, projectNaturalFacets} from '../naturalQueryAdapter.js';
import {naturalProjectionForPack, mergeNaturalContinuation, removeOwnedNaturalDisclosures} from '../naturalTaskPackIntegration.js';
// executionContract — extracted implementation; imports point to the owning modules.
import type { ContinuationCall } from "./packBasics.js";
import type { ServedWindowScope } from "./packState2.js";
import type { TaskExecutionContract } from "@tokenlighten/types";
import type { TaskPackResult } from "../model.js";
import type { TaskPackSurface } from "../model.js";
import type { TaskProfile } from "@tokenlighten/types";
import type { TaskSemanticClosure } from "@tokenlighten/types";
import type { TaskWorkspaceState } from "@tokenlighten/types";
import { ASKED_PATH_OBLIGATION_PREFIX } from "../askedPathClosure.js";
import { DOC_SLIVER_ROUTE_MARKER } from "../docSliver.js";
import { ENUMERATED_ITEM_OBLIGATION_PREFIX } from "./changeAndReadinessEvidence2.js";
import { MAX_BATCH_NEXT_HANDLES } from "./coverageAndContinuation.js";
import { REQUEST_ITEM_ABSENCE_ID_RE } from "./recursiveClosure5.js";
import { REQUEST_ITEM_OBLIGATION_PREFIX } from "./recursiveClosure5.js";
import { SAME_NAME_DISCLOSURE_PREFIX } from "./sameNameSubjects.js";
import { SHARED_BASENAME_DISCLOSURE_PREFIX } from "./sameNameSubjects.js";
import { absenceContradictsServedEvidence } from "./requestItemAbsence3.js";
import { actionFrontierForCertificate } from "./epochEvidence2.js";
import { activeEngineDiscoveryGaps } from "../../engines/config.js";
import { admitReadOnlyNextCall } from "./unresolvedCalls.js";
import { answerArtifactDiscoveryCall } from "./unresolvedCalls3.js";
import { buildCapabilityGaps } from "./epochEvidence2.js";
import { buildDecisionEvidenceModel } from "./epochEvidence2.js";
import { buildFacetReadiness } from "./facetReadiness.js";
import { buildFalsificationReport } from "./epochEvidence2.js";
import { buildReadinessObligations } from "./readinessObligations.js";
import { buildRequestItemReadiness } from "./requestItemReadiness.js";
import { buildTaskWorkspaceState } from "./epochEvidence2.js";
import { capWords } from "./requestItemAbsence2.js";
import { certificateIdentityProfile } from "./unresolvedCalls3.js";
import { citationClauseNamesOnlyServedThings } from "./identifierAbsence2.js";
import { closureAlreadyExecuted } from "./recursiveClosure2.js";
import { codeTaskPackSurfaces } from "../artifactSections.js";
import { compoundPlanForQuery } from "./packBasics2.js";
import { concernCoveredByServedEvidence } from "./concernProof.js";
import { concernTopicTerms } from "./sourceAndConcernTerms3.js";
import { concernVariantMap } from "./sourceAndConcernTerms3.js";
import { csvLookupClosedUniverse } from "./guideAndArtifactSurfaces.js";
import { currentAskedPathPlan } from "./facetClosure2.js";
import { deterministicCertificate } from "./unresolvedCalls3.js";
import { epochServedEvidence } from "./epochContract2.js";
import { estimateReadinessRisk } from "./epochEvidence2.js";
import { extractRequestItems } from "./packBasics2.js";
import { facetClauseMatchesItem } from "../facetGate.js";
import { firstUnservedPartialRange } from "./packState2.js";
import { getIntentEditObserved } from "../../../state/session.js";
import { hasOpenUniverseIntent } from "../openUniverseIntent.js";
import { hasRequiredArtifactSections } from "./artifactPackBuilder2.js";
import { hasServedCode } from "./wiringEvidence2.js";
import { hasServedZoomAffordance } from "../canonicalDecision.js";
import { identifierAbsenceDisclosures } from "./identifierAbsence.js";
import { isCandidateListPack } from "./recursiveClosure3.js";
import { isFormatOrBehaviourClause } from "./identifierAbsence2.js";
import { isImplementationPath } from "./changeAndReadinessEvidence2.js";
import { isSupportingEvidenceWhy } from "../canonicalDecision.js";
import { mergeFacetGap } from "./facetReadiness.js";
import { nextCallCoveredBySpans } from "./packState2.js";
import { nextCallForUnresolved } from "./unresolvedCalls2.js";
import { nextCallReReadsServedWindow } from "./packState.js";
import { nextCallTargetsUnreadablePath } from "./packState.js";
import { noteProofCompletionPack } from "../../../util/flags.js";
import { openEpochContractRequirements } from "./unresolvedCalls3.js";
import { packServedSpans } from "./packState2.js";
import { priorEpochActionFrontier } from "./epochEvidence.js";
import { projectCompletion } from "../canonicalDecision.js";
import { proofCompletionCountedResults } from "./identifierAbsence2.js";
import { proofCompletionEnabled } from "../../../util/flags.js";
import { queryRequestsTestEvidence } from "../../../tools/queryEvidence.js";
import { reconcileAnalysisSourceFromFacets } from "./facetReadiness.js";
import { reconcileRequestItemsWithFacets } from "./facetReadiness.js";
import { sameNameAmbiguityDisclosures } from "./sameNameSubjects.js";
import { sameNameDeclarationReadCall } from "./sameNameSubjects.js";
import { sameNameSubjectsFor } from "./sameNameSubjects.js";
import { servedSurfacesMentionIdentifier } from "./identifierAbsence.js";
import { shaOfText } from "../../../util/handles.js";
import { sharedBasenameDisclosures } from "./sameNameSubjects.js";
import { stampAnchorObligations } from "./unresolvedCalls3.js";
import { stripValueOnlyLeadClauses } from "../requestItems.js";
import { taskContractDigest } from "../taskContractStore.js";
import { taskContractDischargeCertificate } from "../taskContractStore.js";
import { taskContractGapProjection } from "../taskContractStore.js";
import { taskContractProjectionForSnapshot } from "../taskContractStore.js";
import { tokenizeForEpoch } from "../../../state/session.js";
import { valueCallBudget } from "./unresolvedCalls3.js";

// Exported for readinessSemantics.spec.ts — synthetic TaskPackResult inputs are
// the only practical way to pin the per-profile risk/fallback branches.
export function buildTaskExecutionContract(
  result: TaskPackResult,
  profile: TaskProfile,
  query: string,
  workspaceState: TaskWorkspaceState = buildTaskWorkspaceState(result),
  /** P0 defect 3: the workspace root, so the certificate can name same-epoch evidence the caller already holds. Optional — the readiness specs build contracts from synthetic results with no workspace, and omitting it is exactly the pre-defect-3 frontier. */
  workspace?: string,
  /** A verified expansion gap from this response, before its durable replay projection is consulted. */
  currentOpenUniverseExplicitGap = false,
  servedZoomScope?: ServedWindowScope,
  /** Exact literal cohort evidence, admitted only after its bound continuation and ledger proof. */
  literalSourceUniverse = false,
  /** Optional detached ledger evaluation; default callers retain the workspace-backed read path. */
  ledgerEvaluationInput?: ReturnType<typeof taskContractProjectionForSnapshot>,
): TaskExecutionContract {
  // FIXALL-A group D (2026-09-14): stamp `request_names_no_target` here, the ONE
  // choke point every decision path passes through with the query text in hand
  // (`applyCanonicalTaskDecision` is called from four sites in this module and
  // only ever sees the result). Idempotent and monotone: it is only ever set,
  // never cleared, so a later rebuild of the same pack cannot lose it. See the
  // field's own doc on `TaskPackResult` and its single consumer,
  // `deriveCanonicalTaskDecisionRaw`.
  if (stripValueOnlyLeadClauses(query).trim() === "" && query.trim() !== "") {
    result.request_names_no_target = true;
  }
  const proofCompletion = proofCompletionEnabled();
  // P2(b) (2026-08-28 review-fix wave): this builder runs at least twice per
  // pack (this doc comment's own next line: "before and after final
  // same-epoch reconciliation"), and up to four call sites in this module can
  // each invoke it for the SAME pack. The engagement counter exists to
  // measure live PACK decisions, not internal re-evaluations of one —
  // dedupe on the `result` object identity (the same TaskPackResult is
  // threaded through every re-evaluation within one pack build) so a pack
  // that gets rebuilt three times still counts once.
  if (proofCompletion && !proofCompletionCountedResults.has(result)) {
    proofCompletionCountedResults.add(result);
    noteProofCompletionPack();
  }
  // This builder runs before and after final same-epoch reconciliation. Its
  // ledger rows are derived projection, so do not carry a discharged row from
  // the preliminary evaluation into the final one.
  result.missing = result.missing.filter((entry) => !entry.startsWith("unresolved-ledger:"));
  const ledgerEpochTokens = tokenizeForEpoch(query);
  const ledgerEvaluation = ledgerEvaluationInput;
  const ledger = !proofCompletion
    ? { open: [] as string[], explicitGaps: [] as string[], resolved: [] as string[] }
    : ledgerEvaluation?.projection ?? (workspace === undefined
      ? { open: [] as string[], explicitGaps: [] as string[], resolved: [] as string[] }
      : taskContractGapProjection(workspace, ledgerEpochTokens));
  if (ledger.open.length > 0 || ledger.explicitGaps.length > 0) {
    result.missing = [...new Set([
      ...result.missing,
      ...ledger.open.map((entry) => `unresolved-ledger:${entry}`),
      ...ledger.explicitGaps.map((entry) => `explicit-gap:${entry}`),
    ])];
    if (ledger.open.length > 0) {
      result.coverage = "partial";
      result.coverage_reason ??= "concerns-uncovered";
    }
  }
  const ledgerCertificate = !proofCompletion
    ? undefined
    : ledgerEvaluationInput !== undefined
      ? ledgerEvaluationInput.certificate
      : workspace === undefined
        ? undefined
        : taskContractDischargeCertificate(workspace, ledgerEpochTokens);
  // -------------------------------------------------------------------------
  // R2 (2026-08-28): THE EXPANSION-SUCCEEDED ARM.
  //
  // Until this, `openUniverseDischarged` had exactly one route — an explicit
  // capability gap — so the open universe could be closed only by FAILING to
  // expand it. A pack whose expansion fully SUCCEEDED had no discharge route at
  // all: `recordEvidenceExpansion` proves each served target `{type:"served"}`,
  // but the two-column gap projection dropped those proofs, so the
  // `open-universe:*` obligation stayed "uncovered" with `missing:[]`,
  // `coverage:"complete"` and zero gaps on the wire, and the certificate that
  // would authorise `act.answer` was never minted. Reproduced on the TS
  // 4-definition fixture in `ledgerDecisionIntegration.spec.ts`, where all four
  // direct-callee bodies are served.
  //
  // THE CONDITION IS DELIBERATELY THE STRONGEST ONE THAT STILL FIRES, because a
  // weaker one reopens P0-1 (an `act.answer` over an unresolved callee):
  //
  //   1. `ledger.open` is EMPTY — not "no open dependency-definitions", but
  //      nothing open at all. With 2 of 4 targets served and 2 still open, this
  //      is false and no discharge happens. That is the negative example, and
  //      it is the whole safety argument: an obligation with no proof is
  //      exactly what `open` means.
  //   2. At least one `dependency-definitions:` obligation is actually PROVED
  //      (served, or explicit-gap). An epoch that recorded no expansion at all
  //      also has an empty `open`, and it must not discharge on that emptiness —
  //      silence is not proof. This is what keeps the provisional contract
  //      rebuilds (`rebuildFinalExecutionContract`, which can run BEFORE this
  //      pack's own facts are persisted) fail-closed: they see an empty
  //      projection, so this arm cannot fire on a not-yet-recorded expansion.
  // -------------------------------------------------------------------------
  const dependencyDefinitionsSettled = ledger.open.length === 0
    && [...ledger.resolved, ...ledger.explicitGaps]
      .some((entry) => entry.startsWith("dependency-definitions:"));
  const openUniverseDischarged = hasOpenUniverseIntent(query)
    // An explicit capability gap discharges only the open-universe axis. Other
    // ledger obligations can still keep the terminal act locked, but the
    // prescribed absence probe must not be re-issued while those unrelated
    // obligations remain unresolved.
    && (
      currentOpenUniverseExplicitGap
      || ledger.explicitGaps.some((entry) => entry.startsWith("dependency-definitions:open-universe "))
      || dependencyDefinitionsSettled
    );
  // I-7: forwards this builder's OWN `workspace` param (undefined for the
  // synthetic/unit-built contracts several readiness specs construct — same
  // optionality this whole function already has) so buildReadinessObligations
  // can trace-summarize an enumerated-item mint. NOT threaded into
  // runInternalReadinessFalsification's OWN preview call, above this
  // function's definition — that call's `initialObligations` is a throwaway
  // internal check (never assigned to result.execution_contract, never
  // returned to a caller), so it must never win the one-emission-per-pack
  // dedup below. This function itself runs multiple times per pack (its own
  // P2(b) comment above, and runRecursiveReadOnlyClosure's discovery-loop
  // callers re-invoke it once per depth as evidence grows), so the dedup can
  // land on an early, not-yet-fully-settled evaluation for a pack that engages
  // that loop — an accepted, disclosed imprecision for a trace-only summary,
  // never a wire effect. See enumeratedObligationSummaryCountedResults' doc
  // comment.
  const obligations = buildReadinessObligations(result, profile, query, openUniverseDischarged, workspace);
  const compoundPlan = compoundPlanForQuery(query);
  const compoundBudgetGaps = compoundPlan?.outstanding.map((gap) => `compound-request:query:${gap.reason}`) ?? [];
  const compoundDiscoveryGaps = activeEngineDiscoveryGaps();
  const compoundGaps = [...new Set([...compoundBudgetGaps, ...compoundDiscoveryGaps.filter((gap) => /:(?:query|clause|candidate|wire)-budget$/u.test(gap))])];
  result.missing = result.missing.filter((entry) => !entry.startsWith("unresolved-compound-request:"));
  for (const gap of compoundGaps) {
    // Discovery remains useful, but evidence about the retained prefix cannot
    // discharge an uninspected clause or a dropped mandatory candidate.
    obligations.push({
      id: `request-item:${gap}`,
      kind: "concern", status: "uncovered", required: true, evidence: [],
      reason: `${gap}: compound discovery did not inspect or retain every requested point; not a verified absence`,
      origin: "query",
    });
    result.missing.push(`unresolved-compound-request:${gap}`);
  }
  if (compoundGaps.length > 0) {
    result.coverage = "partial";
    result.coverage_reason = "concerns-uncovered";
  }
  // DESIGN-v0.15 R1: request-item obligations join the SAME array the
  // certificate gate below reads, so an uncovered explicit point demotes
  // `discovery_complete` exactly like any other open obligation — no second,
  // independent correctness ledger (design §4.1). Must run before
  // `projectCompletion` so its verdict already reflects them.
  const naturalProjection = naturalProjectionForPack(result, workspace, query, profile);
  removeOwnedNaturalDisclosures(result, naturalProjection);
  const rawRequestItemReadiness = buildRequestItemReadiness(workspace, query, profile, result, obligations);
  const requestItemReadiness = naturalProjection === undefined ? rawRequestItemReadiness : projectNaturalRequestItems(rawRequestItemReadiness, naturalProjection);
  // FIX-G (2026-09-27): the facet completion gate — see `buildFacetReadiness`'s
  // own header. `undefined` for every facet-free query (no read, no mutation),
  // so an ordinary pack is byte-identical. Reconciled BEFORE the request-item
  // obligations join the array: a point a resolved facet owns must not also
  // block (or be disclosed undetermined) under its request-item id.
  const rawFacetReadiness = buildFacetReadiness(workspace, query, profile, result);
  const facetReadiness = naturalProjection === undefined ? rawFacetReadiness : projectNaturalFacets(rawFacetReadiness, naturalProjection);
  const facetOwnedItemIds = facetReadiness === undefined
    ? new Set<string>()
    : reconcileRequestItemsWithFacets(requestItemReadiness, facetReadiness, query);
  // A locator's abstention is not an evidence verdict. The normal positional
  // and facet proofs can still cover that clause, or verify scoped absence;
  // only a genuinely unresolved point earns the shared unknown disclosure.
  if (workspace !== undefined && compoundPlan !== undefined) {
    const evidenceNow = epochServedEvidence(workspace, result, tokenizeForEpoch(query), profile);
    const items = extractRequestItems(query);
    for (const gap of compoundDiscoveryGaps.filter((entry) => /:(?:discovery-incomplete|not-located)$/u.test(entry))) {
      const clauseId = /^compound-request:(cr-\d+):/u.exec(gap)?.[1];
      const clause = compoundPlan.clauses.find((entry) => entry.id === clauseId);
      if (clause === undefined) continue;
      if (isFormatOrBehaviourClause(clause.text) || citationClauseNamesOnlyServedThings(clause.text, evidenceNow)) continue;
      if (facetReadiness?.entries.some((entry) => facetClauseMatchesItem(entry.requirement.clause, clause.text)
        && (entry.facts.kind === "covered" || entry.facts.kind === "empty"))) continue;
      const clauseItems = items.filter((item) => item.text === clause.text || clause.text.includes(item.text));
      if (clauseItems.length > 0 && clauseItems.every((item) => requestItemReadiness.absences.some((absence) => absence.id === item.id)
        || requestItemReadiness.obligations.some((obligation) => obligation.id === `request-item:${item.id}` && obligation.status === "proved"))) continue;
      const terms = concernTopicTerms(clause.text);
      if (concernCoveredByServedEvidence(clause.text, terms, concernVariantMap(terms, workspace), evidenceNow, workspace).covered) continue;
      requestItemReadiness.undetermined.push({ id: gap, term: capWords(clause.text, 24), reason: "the independent clause could not be located; not a verified absence" });
    }
  }
  if (facetReadiness !== undefined) reconcileAnalysisSourceFromFacets(obligations, facetReadiness);
  obligations.push(...requestItemReadiness.obligations);
  if (facetReadiness !== undefined) obligations.push(...facetReadiness.entries.map((entry) => entry.obligation));
  if (naturalProjection !== undefined) appendNaturalObligations(obligations, naturalProjection);
  const requestItemGap = mergeNaturalContinuation(mergeFacetGap(requestItemReadiness.gap, facetReadiness, query, workspace, result.surfaces, profile === "answer"), naturalProjection, query);
  if (requestItemGap !== undefined) {
    result.request_item_gap = requestItemGap;
  } else if (naturalProjection?.active) {
    delete result.request_item_gap;
  }
  stampAnchorObligations(result, obligations, query, workspace, profile);
  // DESIGN-v0.15 R1: see `TaskPackResult.request_item_absences`'s own doc
  // comment for the wire path this feeds (`buildCapabilityGaps`, gated to a
  // `discover` decision by D-4).
  {
    // TL142-01B: MERGE, never overwrite. `promoteExecutedSearchAbsences` may
    // already have recorded an absence an EXTERNAL executed search proved, and
    // this builder runs several times per pack — a plain assignment silently
    // discarded that disclosure on any pack whose own request-item pass also
    // found something.
    //
    // R-B1 (2026-09-21, review B3) — THE ONE EMISSION POINT for this pack's
    // OWN request-item absences (ids `ri-N`; every path in
    // `buildRequestItemReadiness` applies the served-evidence veto before an
    // entry reaches `absences`). The merge above kept them append-only across
    // those builder runs, so an absence minted by an EARLY run — before a
    // later stage put the implementing file on the wire — survived the later
    // run whose veto rejected it, and the certificate shipped the absence
    // beside the very body that contradicts it. Every carried `ri-N` entry is
    // therefore RE-VETOED here against the evidence of THIS run (the same
    // single policy, `absenceContradictsServedEvidence`), so accumulation can
    // keep a still-true disclosure but can never keep a contradicted one.
    // External (`identifier:*`) proofs keep the merge-never-overwrite rule
    // and their own staleness gate.
    const carried = (result.request_item_absences ?? []).filter((entry) => !entry.id.startsWith("compound-request:"));
    let keptCarried = carried;
    if (workspace !== undefined && carried.some((entry) => REQUEST_ITEM_ABSENCE_ID_RE.test(entry.id))) {
      const itemTextById = new Map(extractRequestItems(query).map((item) => [item.id, item.text]));
      const evidenceNow = epochServedEvidence(workspace, result, tokenizeForEpoch(query), profile);
      keptCarried = carried.filter((entry) => !REQUEST_ITEM_ABSENCE_ID_RE.test(entry.id)
        || !absenceContradictsServedEvidence(entry.term, itemTextById.get(entry.id) ?? entry.term, evidenceNow, workspace));
    }
    // FIX-G: a facet's disclosure is recomputed on every build of this pack
    // (its served spans can only shrink under a trim), so a carried `facet-<n>`
    // entry is replaced, never accumulated; and a carried could-not-determine
    // for a point a resolved facet now owns is superseded by the facet's own
    // determination (G5) — the same rule `reconcileRequestItemsWithFacets`
    // applied to this build's own entries.
    // WP-C3 (rule 2(d)): a carried request-item ABSENCE for an owned point is
    // superseded the same way — `reconcileRequestItemsWithFacets` drops this
    // build's own owned absences, and a carried one is the identical claim.
    if (facetReadiness !== undefined) {
      keptCarried = keptCarried.filter((entry) => !entry.id.startsWith("facet-")
        && !((entry.undetermined === true || REQUEST_ITEM_ABSENCE_ID_RE.test(entry.id)) && facetOwnedItemIds.has(entry.id)));
    }
    const merged = [...keptCarried];
    for (const absence of requestItemReadiness.absences) {
      if (!merged.some((entry) => entry.term === absence.term)) merged.push(absence);
    }
    // 2026-11 (external A/B of v0.16.4, express `res.redirect('back')`): a
    // quoted literal the asked-path hook proved absent from every source file
    // is disclosed as a verified absence (`request-item-absent:<literal>`,
    // with the scan's own scope verdict), and a self-method on the asked
    // path whose definition the workspace does not hold as a could-not-
    // determine — both on this same array, the same projector.
    const askedPathDisclosure = currentAskedPathPlan(workspace, query);
    for (const absence of askedPathDisclosure?.literalAbsences ?? []) {
      if (merged.some((entry) => entry.term === absence.term)) continue;
      merged.push({ id: `literal:${absence.term}`, term: absence.term, scope_complete: absence.scopeComplete, omitted_count: absence.omittedCount });
    }
    for (const open of askedPathDisclosure?.unresolved ?? []) {
      if (merged.some((entry) => entry.term === open.name)) continue;
      merged.push({
        id: `${ASKED_PATH_OBLIGATION_PREFIX}${open.name}`,
        term: open.name,
        scope_complete: false,
        omitted_count: 0,
        undetermined: true,
        undetermined_reason: capWords(open.reason, 32),
      });
    }
    // R-D2 (item B): the SAME array, the SAME carry-forward/re-veto
    // discipline just above (a later run's evidence can invalidate an
    // undetermined disclosure exactly as it invalidates a verified-absent
    // one — `REQUEST_ITEM_ABSENCE_ID_RE`/`absenceContradictsServedEvidence`
    // key on `id`/`term` alone and do not care which flavor an entry is), so
    // this reuses that protection rather than re-implementing it. Tagged
    // with `undetermined:true` so `decisionWire.ts`'s projector renders the
    // NEW `request-item-undetermined` code word instead of
    // `request-item-absent`; `scope_complete`/`omitted_count` do not apply
    // to a could-not-determine verdict and are never read for a tagged
    // entry (see the projector), so they are set to their inert defaults.
    for (const item of requestItemReadiness.undetermined) {
      if (merged.some((entry) => entry.term === item.term)) continue;
      merged.push({
        id: item.id,
        term: item.term,
        scope_complete: false,
        omitted_count: 0,
        undetermined: true,
        undetermined_reason: capWords(item.reason, 20),
      });
    }
    // FIX-G: facet disclosures ride the SAME array (decisionWire.ts's
    // `projectCertificate` renders them into `certificate.gaps`): a verified-
    // empty facet as `explicit-gap:request-item-empty:<facet>:<subject> (...)`,
    // a could-not-determine one as the existing
    // `explicit-gap:request-item-undetermined:<facet>:<subject> (...)`.
    // Neither is a verified absence, so neither claims a scan scope.
    for (const disclosure of facetReadiness?.disclosures ?? []) {
      if (merged.some((entry) => entry.term === disclosure.term)) continue;
      merged.push(disclosure.word === "request-item-empty"
        ? { id: disclosure.id, term: disclosure.term, scope_complete: false, omitted_count: 0, empty: true, empty_reason: capWords(disclosure.reason, 24) }
        : { id: disclosure.id, term: disclosure.term, scope_complete: false, omitted_count: 0, undetermined: true, undetermined_reason: capWords(disclosure.reason, 24) });
    }
    // WP-N rule 2 (eval-0929 §8): a PROVED `identifier:<X>` whose name has no
    // whole-identifier occurrence is disclosed on the same array, under the
    // `identifier:<X>` id `promoteExecutedSearchAbsences` already uses — see
    // `identifierAbsenceDisclosures`. Before this, only the obligation's
    // internal `reason` said "verified absent", and the certificate shipped
    // the identifier as satisfied with no gap. A carried `identifier:*` entry
    // this response's own served bytes contradict is dropped (SHOULD-FIX 28's
    // withdrawal test, the one `verifiedAbsentIdentifiersFor` applies).
    const servedNow = codeTaskPackSurfaces(result.surfaces ?? []);
    for (let index = merged.length - 1; index >= 0; index--) {
      const entry = merged[index]!;
      if (entry.id.startsWith("identifier:") && servedSurfacesMentionIdentifier(servedNow, entry.term)) merged.splice(index, 1);
    }
    for (const disclosure of identifierAbsenceDisclosures(result, obligations)) {
      if (merged.some((entry) => entry.term === disclosure.term)) continue;
      merged.push(disclosure);
    }
    // WP-O (eval-0929 §8): an AMBIGUOUS same-name subject the certificate
    // proved from every one of its declarations is disclosed by name (X and
    // its declaring files). Recomputed on every build, like a facet's own
    // disclosure: a carried entry is replaced, never accumulated.
    for (let index = merged.length - 1; index >= 0; index--) {
      if (merged[index]!.id.startsWith(SAME_NAME_DISCLOSURE_PREFIX)) merged.splice(index, 1);
    }
    for (const disclosure of sameNameAmbiguityDisclosures(result, obligations)) {
      if (merged.some((entry) => entry.term === disclosure.term)) continue;
      // A facet of the same subject already disclosed this very ambiguity
      // (WP-F's `ambiguousFocal`, worded identically): one disclosure, not two.
      if (merged.some((entry) => entry.undetermined === true
        && (entry.undetermined_reason ?? "").includes(`${disclosure.term} is declared in`))) continue;
      merged.push(disclosure);
    }
    // v0.15.1 runtime review (2026-10-06): a bare basename several roots
    // share does not say which file the question means — see
    // `sharedBasenameDisclosures`. Recomputed every build, like WP-O's.
    if (workspace !== undefined) {
      for (let index = merged.length - 1; index >= 0; index--) {
        if (merged[index]!.id.startsWith(SHARED_BASENAME_DISCLOSURE_PREFIX)) merged.splice(index, 1);
      }
      if (profile === "answer") {
        for (const disclosure of sharedBasenameDisclosures(result, query, workspace)) {
          if (merged.some((entry) => entry.term === disclosure.term)) continue;
          merged.push(disclosure);
        }
      }
    }
    if (merged.length > 0) result.request_item_absences = merged;
    else delete result.request_item_absences;
  }
  const completion = projectCompletion(result, obligations);
  result.coverage = completion.coverage;
  const blockingObligations = completion.blocking;
  const falsification = buildFalsificationReport(result, profile, obligations);
  const risk = estimateReadinessRisk(result, profile, query, blockingObligations, falsification);
  const focusedAnswerCandidate = profile === "answer"
    && result.route?.action === "confirm_candidates"
    && queryRequestsTestEvidence(query)
    && codeTaskPackSurfaces(result.surfaces).some((surface) => surface.role === "test" && hasServedCode(surface))
    && codeTaskPackSurfaces(result.surfaces).some((surface) => isImplementationPath(surface.path) && hasServedCode(surface))
    && codeTaskPackSurfaces(result.surfaces).every(hasServedCode);
  // A route may retain `needs-followup` after the router has already served
  // every required primary body.  Treating that conservative routing hint as
  // stronger than the completed, falsifiable readiness obligations strands a
  // caller at `await_input:act-on-served-evidence`: there is no executable
  // discovery call, but the missing certificate also prevents the decision
  // projection from emitting the answer.  A fully served, gap-free answer
  // route is instead a legitimate *candidate*; the proof/ledger gates below
  // still decide whether it receives an act certificate.
  const fullyServedAnswerRoute = result.route?.action === "answer_from_handles"
    && result.missing.every((entry) => entry.startsWith("explicit-gap:"))
    && codeTaskPackSurfaces(result.surfaces)
      .filter((surface) => surface.required !== false)
      .every(hasServedCode);
  const answerCandidate = profile === "answer"
    && (
      (result.route?.action === "answer_from_handles"
        && (result.content_sufficiency !== "needs-followup" || fullyServedAnswerRoute))
      || focusedAnswerCandidate
    );
  // 2026-08-01: answer_from_handles is the same "working set complete" verdict
  // as edit_from_handles with an answer act — excluding it made answer-shaped
  // packs structurally unable to reach prepared, so a fully-served explain
  // query fell to awaiting-input with allowed:["edit","request-user-input"]
  // (an edit grant and no answer affordance, on a question).
  // D1 (2026-08-07): two shipped rules disagreed about what
  // `route.max_additional_tl_calls` MEANS, and nothing reconciled them.
  // buildRoute's Wave-4 contract (2026-07-24) keeps it as "calls needed to
  // CLOSE the task", explicitly noting that "certification acceptance
  // requires 0 — a zoom affordance is not missing evidence". A5 (2026-08-01
  // signal5-2 T03) then started SPENDING that field to advertise the one
  // sanctioned same-handle zoom over a disclosed-partial primary. The result
  // was a pack that could never be both: routeCandidate demanded 0, the
  // answer route carried 1, so every partial-primary answer pack was
  // structurally barred from `prepared` and fell to discovery /
  // awaiting-input while its own route said "answer from handles" — the
  // self-contradiction observed live (route budget + prose granting a widen,
  // contract phase refusing to authorize the answer).
  //
  // AGENTS.md states the intended joint shape directly: "prepared+partial
  // primary grants `route.max_additional_tl_calls=1` — spend it on the served
  // zoom". So the zoom grant is an AFFORDANCE, and `prepared` must survive
  // it. Scoped to the answer route because editFromHandlesRoute only mints
  // the grant there; on an edit route a nonzero budget still means evidence
  // the pack owes, and reconcileTaskChangeContract sets exactly that.
  // Shared with canonicalDecision.ts's deriveCanonicalTaskDecision and this
  // function's own reconcileContentSufficiency (§3.4.1 / D1): ONE predicate
  // for "does this pack carry the sanctioned served-zoom affordance", so the
  // three sites cannot disagree about the shape again.
  const servedZoomAffordance = hasServedZoomAffordance(result);
  // L1 (2026-08-08): the doc-authority sliver grant, same shape as
  // servedZoomAffordance but reachable on an EDIT route. One sanctioned section
  // zoom over an already-complete CODE working set is an affordance, not missing
  // evidence, so `prepared` must survive it — exactly the D1 reconciliation.
  // (In the main path the grant is applied after this contract is built; this
  // keeps the invariant true in either order.)
  const servedDocSliverAffordance = (result.route?.max_additional_tl_calls ?? 0) === 1
    && (result.route?.reason?.includes(DOC_SLIVER_ROUTE_MARKER) ?? false);
  const routeCandidate = (result.route?.action === "edit_from_handles"
      || result.route?.action === "answer_from_handles")
    && result.missing.every((entry) => entry.startsWith("explicit-gap:"))
    && result.content_sufficiency !== "needs-followup"
    && ((result.route.max_additional_tl_calls ?? 0) === 0 || servedZoomAffordance || servedDocSliverAffordance);
  // A resolved non-artifact create target is its own terminal frontier. The
  // fenced content can make profile inference look multi-concern, but those
  // content tokens describe the new file; they are not pre-existing concerns
  // that must independently resolve before create:true is authorized.
  const resolvedCreateCandidate = profile !== "artifact_build"
    && result.create_target !== undefined;
  const profileCandidate = resolvedCreateCandidate
    ? true
    : profile === "wiring"
      ? result.wiring?.status === "ready"
    : profile === "artifact_build"
      ? hasRequiredArtifactSections(result, query)
      : profile === "change_propagation"
        // The normal change contract is normally the profile-specific edit
        // proof. A capped literal cohort cannot retain a conventional contract
        // for its continuation-only witness, so admit its equally strict
        // authenticated source-universe proof here. This remains inside the
        // ordinary readiness/rebuild gates (route, served content, theorem,
        // ledger discharge, falsification, and risk); it is not a direct
        // prepared-state override.
        ? result.change_contract?.status === "ready" || literalSourceUniverse
        : profile === "multi_concern"
          ? (result.concerns?.length ?? 0) > 0 && result.concerns?.every((concern) => concern.status === "covered") === true
          : true;
  const baseReady = result.literal_source_absence !== undefined
    || answerCandidate
    || (routeCandidate && profileCandidate);
  const proofComplete = completion.complete;
  // D1's own comment says the quiet part: "a zoom affordance is not missing
  // evidence". The falsification/risk engine still (correctly) flags the
  // affordance surface's own undisclosed remainder as unresolved — that is
  // exactly what the affordance's one sanctioned call is FOR — so that
  // unresolved obligation alone must not reject a served-zoom-affordance
  // pack. Scoped tightly: every OTHER required surface must already carry
  // served code, or a genuinely starved surface the affordance does not name
  // still blocks acceptance exactly as before.
  const hasUnservedRequiredSurface = codeTaskPackSurfaces(result.surfaces)
    .some((surface) => surface.required !== false && !hasServedCode(surface));
  // A digest alone is not evidence that THIS epoch has an obligation to
  // discharge: lane state is created before the first obligation is added and
  // may also contain an unrelated, non-matching epoch after a restart. A
  // matching ledger with obligations still requires its branded discharge
  // certificate; only an empty projection may proceed without one.
  //
  // A-F3 (2026-08-28): THAT RULE WAS FAIL-OPEN ON ITS OWN TARGET CLASS.
  // `taskContractDigest(workspace) === undefined` — no ledger at all — read as
  // ESTABLISHED, so the one state in which nothing has been proved was the
  // easiest way to satisfy the theorem. Combined with the vacuous certificate
  // an empty ledger used to mint, an exhaustive request could reach `accepted`
  // having recorded no requirement whatsoever. An open-universe query is
  // exactly the class A-4..A-7 exist for: for it, no ledger means NOT
  // established, and only the branded discharge certificate over a non-empty
  // ledger admits the act. `currentOpenUniverseExplicitGap` is deliberately not
  // an escape here — this builder's final invocation runs after
  // `recordEpochTaskContract` has persisted that same gap, so the durable proof
  // is available by the time the decision ships.
  //
  // Non-exhaustive tasks keep the v0.12-compatible empty/absent-ledger accept.
  // What they may NOT do is claim a ledger discharge while doing it, and
  // `dischargeCertificate` now enforces that half: with no obligations there is
  // no certificate, so the id stays in the legacy single-segment form.
  // Literal-first source=0 is a closed-world measurement, not an omitted
  // open-universe expansion. Admit it without a durable expansion-ledger
  // certificate only when all three recorded conditions agree: the raw
  // grammar-bound absence marker is present, the workspace inventory snapshot
  // count matches the measured count, and the readiness projection retained
  // the matching proved obligation. These conditions are not independent
  // witnesses; the flag remains OFF until one shared enumeration universe
  // makes the absence proof self-contained. A scoped/truncated or merely
  // empty ledger cannot satisfy this exception.
  const literalAbsenceClosedWorld = result.literal_source_absence !== undefined
    && result.literal_source_absence.universe_complete === true
    && result.literal_source_absence.scanned_paths === result.literal_source_absence.universe_paths
    && workspaceState.inventory_complete === true
    && result.literal_source_absence.universe_paths === workspaceState.inventory_files
    && /^sha256:[a-f0-9]{64}$/.test(result.literal_source_absence.universe_fingerprint)
    && obligations.some((obligation) =>
      obligation.status === "proved"
      && obligation.id === `literal-source-absent:${result.literal_source_absence!.subject}`
    );
  // A completed literal cohort has its own authenticated ledger witness: the
  // final source range was executed under the canonical task binding, and
  // `literalSourceUniverseProved` admitted this branch only after the exact
  // ordinary-find universe, root, collision, and every witness checks. The
  // generic epoch certificate can be absent here because the capped pack does
  // not retain the continuation-only surface as a conventional contract
  // obligation. Treat that typed witness as an established ledger proof, not
  // as a shortcut around the normal theorem/risk/route gates below.
  const ledgerEstablished = literalAbsenceClosedWorld || literalSourceUniverse || csvLookupClosedUniverse(workspace) || (hasOpenUniverseIntent(query)
    ? ledgerCertificate !== undefined
    : workspace === undefined
      || taskContractDigest(workspace) === undefined
      || ledgerCertificate !== undefined
      // The current response's expansion limitation is already verified; the
      // durable ledger is its continuation/replay record, not a prerequisite
      // for recognizing this pack's own explicit capability gap.
      || currentOpenUniverseExplicitGap
      || (ledger.open.length === 0 && ledger.explicitGaps.length === 0));
  // -------------------------------------------------------------------------
  // A-F6 (2026-08-28): THE ACCEPTANCE LAYERS, and the OFF arm that is exactly
  // v0.12.
  //
  // The shipped expression read `(!proofCompletion || proofComplete) &&
  // (!proofCompletion || ledgerEstablished)`, which collapses to `true` when
  // the switch is OFF — so OFF was neither v0.13 nor v0.12 but a THIRD, LOOSER
  // behavior in which `baseReady` alone certified. The compatibility switch has
  // to mean "v0.12 semantics", or the parity spec measures nothing and the
  // escape hatch is more permissive than either release.
  //
  // LAYER 1, the theorem (A-6(1)): every readiness obligation carries a proof,
  // and — under proof completion — the durable ledger backing them is
  // established and discharged. Coverage classification and the risk score are
  // NOT premises of it.
  //
  // LAYER 2, risk, as SUPPRESSION ONLY: it can withhold a theorem that holds,
  // never admit one that does not. That keeps ON a restriction of OFF rather
  // than a different rule, which is what makes the two comparable in a decision
  // run.
  const theoremHolds = proofComplete && (!proofCompletion || ledgerEstablished);
  const riskSuppresses = risk.decision === "reject";
  // E-1: every terminal act remains theorem-backed. A served-zoom
  // affordance authorizes one bounded follow-up, but it is not a proof of
  // unrelated answer obligations or of the task ledger's discharge. The
  // affordance may absorb only the expected residual on the selected evidence
  // surface (including its behavior body); an open-universe, identifier,
  // concern, or ledger obligation still blocks the act.
  const affordanceResidual = obligations.some((obligation) =>
    obligation.status !== "proved"
    && obligation.id !== "surface-content"
    && obligation.id !== "behavior-body"
  );
  const accepted = baseReady
    && (
      (theoremHolds && !riskSuppresses)
      || (servedZoomAffordance && !hasUnservedRequiredSurface && !affordanceResidual)
    );
  // The route relabel (answer_from_handles) is query-shape truth even when §14
  // serves the pack as generic; the terminal act must agree with it, or the
  // contract instructs an edit on a question.
  const answerShapedRoute = result.route?.action === "answer_from_handles";
  // DESIGN-v0.15-sf-intent-layers.md §4.2 (IL-W2): an tl_edit_file call that
  // already passed `guardExecutionEdit` THIS task epoch opens the write
  // frontier for every later pack of the SAME task, even one whose declared
  // `task.profile` stayed "answer" and even over `answerShapedRoute` — §3's
  // 「edit が本当に来るなら層2(§4.2)で開く」, the exact shape V4 used to
  // mishandle, generalized to this contract's own terminal action rather
  // than only `bindTaskProfile`'s narrative `reason` text. `writeAllowed` is
  // not re-checked here: `ALLOW_WRITE` is a module-level constant fixed at
  // process start (server.ts:452) and cannot flip mid-session, and
  // `getIntentEditObserved` can only ever be true via a call
  // `guardWriteRouting` (server.ts) already required ALLOW_WRITE true for —
  // see `state/session.ts`'s `guardExecutionEdit` wrapper.
  const editObserved = workspace !== undefined && getIntentEditObserved(workspace);
  const terminalAction: "answer" | "edit" =
    editObserved ? "edit" : profile === "answer" || answerShapedRoute ? "answer" : "edit";
  const continuationCallRaw = result.continuation?.stages[0]?.calls[0];
  // D1 (FX-R3): the planned continuation is a PRE-closure artifact too — the
  // deep loop reads its stage-0 calls as candidates and runs them. A call it
  // ran is evidence already folded into this pack, never a follow-up for the
  // caller. Same filter, same reason as `parsedNextAfterProof` below; the
  // obligation-specific fallbacks and `proofNext` are re-derived against the
  // CURRENT proof model and so are never filtered.
  const continuationCall = closureAlreadyExecuted(result, continuationCallRaw, query)
    ? undefined
    : continuationCallRaw;
  const parsedNextCandidate = result.next;
  const currentPackSpans = packServedSpans(result);
  // The route builder can publish a zoom before same-pack sibling evidence is
  // folded into the served-window ledger. Treat that parsed next as consumed
  // immediately when the current response already covers its exact range; the
  // later persisted ledger cannot repair a stale candidate that wins here.
  const parsedNext = parsedNextCandidate !== undefined
    && nextCallCoveredBySpans(result, parsedNextCandidate, currentPackSpans)
    ? undefined
    : parsedNextCandidate;
  const proofNext = naturalProjection?.missingTargets.length
    ? result.request_item_gap?.next_call
    : nextCallForUnresolved(result, blockingObligations, query, workspace);
  // A pre-contract next can be stale after an authoritative absence has
  // discharged the open-universe axis. Keep it only when the current proof
  // model still has a matching unresolved call; otherwise the same search
  // would be emitted again despite the durable explicit-gap witness.
  const parsedNextAfterProofRaw = openUniverseDischarged && proofNext === undefined
    ? undefined
    : parsedNext;
  // D1 (FX-R3, 2026-09-04): a `next` the DEEP recursive read closure of this
  // build already EXECUTED itself is not an affordance — it is an instruction
  // to re-run a call whose evidence is already folded into this pack. Dropping
  // it here (and only here: `proofNext` is re-derived against the CURRENT
  // proof model, and the fallbacks below are obligation-specific by
  // construction) lets the chain fall through to the call that can actually
  // close the open obligation. See the block comment on
  // `closureExecutedCallSignatures`.
  const parsedNextAfterProof = closureAlreadyExecuted(result, parsedNextAfterProofRaw, query)
    ? undefined
    : parsedNextAfterProofRaw;
  // No unconditional tree fallback: every fallback must name evidence that
  // can resolve the current proof gap. Codeless surfaces re-serve their handle;
  // partial surfaces request the first explicitly omitted range.
  const requiredSurfaces = codeTaskPackSurfaces(result.surfaces)
    .filter((surface) => surface.required !== false);
  const codelessRequired = requiredSurfaces.find((surface) => !hasServedCode(surface));
  const gapFallback: ContinuationCall | undefined = codelessRequired
    ? { tool: "tl_read_file", arguments: { handle: codelessRequired.handle } }
    : undefined;
  const partialRequired = requiredSurfaces
    .map((surface) => ({ surface, range: firstUnservedPartialRange(workspace, surface, servedZoomScope, packServedSpans(result)) }))
    .find((entry): entry is { surface: TaskPackSurface; range: string } => entry.range !== undefined);
  const partialFallback: ContinuationCall | undefined = partialRequired
    ? {
        tool: "tl_read_file",
        arguments: { handle: partialRequired.surface.handle, range: partialRequired.range },
      }
    : undefined;
  // Serve-honesty (2026-08-01): a disclosed-but-unserved file — byte-budget
  // shed with an embedded re-request handle, or a caller/query-named path that
  // never served — is a concrete read affordance. Without it, a pack whose
  // only gap sits in missing[] falls to awaiting-input and the observed caller
  // fallback is native IO on exactly that path.
  const missingAffordance: ContinuationCall | undefined = ((): ContinuationCall | undefined => {
    for (const item of result.missing) {
      const handleMatch = /tl_read_file handle=(h[0-9a-z]+)/.exec(item);
      if (handleMatch) return { tool: "tl_read_file", arguments: { handle: handleMatch[1]! } };
      const namedMatch = /^(.+?) \((?:named but unserved|query-named unserved)\)$/.exec(item);
      if (namedMatch) return { tool: "tl_read_file", arguments: { path: namedMatch[1]! } };
    }
    return undefined;
  })();
  const artifactFallback = profile === "answer" && isCandidateListPack(result)
    ? answerArtifactDiscoveryCall(result, query)
    : undefined;
  // choose-candidate close (2026-07-19a): once every candidate body is served
  // inline, no read-only follow-up can disambiguate further — the choice is
  // the caller's. Suppressing the bounded-call fallbacks here is what lands
  // the typestate on awaiting-input instead of a discovery next_call that
  // re-serves already-served handles (the T13 rep0 thrash fuel).
  // v0.15.1 runtime review TL-REVIEW-3: a closure window or a falsification
  // counterexample supports the target; it is never one of the candidates a
  // choice is pending between (canonicalDecision.ts `isSupportingEvidenceWhy`).
  const contractSurfaces = codeTaskPackSurfaces(result.surfaces);
  const choiceSurfaces = contractSurfaces.filter((surface) => !isSupportingEvidenceWhy(surface.why));
  const candidateChoicePending = !accepted
    && (result.route?.action === "confirm_candidates" || result.coverage_reason === "candidate-list")
    && new Set(choiceSurfaces.map((surface) => surface.path)).size > 1
    && choiceSurfaces.every(hasServedCode)
    && artifactFallback === undefined;
  const concernChoicePending = !accepted
    && result.route?.action === "confirm_candidates"
    && (result.concern_ambiguities?.length ?? 0) > 0;
  const humanChoicePending = candidateChoicePending || concernChoicePending;
  // 2026-07-31: `answer_from_handles` is the pack's OWN verdict that discovery
  // is closed and the bundled evidence is the answer. recomputeRouteAndNextAfterTrim
  // already strips `next`/`continuation` on that route — but this contract is
  // assembled independently of the route, so it re-minted the very call the
  // route had just dropped. Observed live: route.action=answer_from_handles with
  // max_additional_tl_calls:0 served in the same envelope as phase:"discovery"
  // plus a tl_search_files next_call. Deliberately scoped to the answer route: the
  // edit side keeps its no-dead-end override below, which exists for starved
  // required surfaces.
  // F-V13-6: "the pack's OWN verdict that discovery is closed" is exactly what
  // an unproved ENUMERATED item contradicts — the same proof model, saying the
  // request named something the served bytes do not cover. Without this the
  // stricter obligation would land the caller on a bare
  // `await_input:"act-on-served-evidence"`, whose frozen wire member carries no
  // `gaps` key, so the open items could not be NAMED and the honest disclosure
  // would be silent. Scoped to the new obligation class: a pack that could not
  // previously mint one is byte-identical to before. The escape is bounded by
  // `enumeratedItemFindCall`, which proposes each item's find at most once per
  // session and nothing at all once they are spent.
  const enumeratedItemOpen = obligations.some((obligation) =>
    obligation.status !== "proved"
    && obligation.id.startsWith(ENUMERATED_ITEM_OBLIGATION_PREFIX));
  // R-B1 (2026-09-21, review B2): the SAME contradiction F-V13-6 documents
  // just above, for the other stricter obligation class. An uncovered
  // BLOCKING request item (`request-item:*` — only ever minted for a
  // mixed-kind point or an independent-question clause; the ALL-TOPIC branch
  // mints none, invariant (iv)) is the proof model saying a point the caller
  // asked about has no served body yet. Before this, the route's own
  // "discovery is closed" verdict suppressed EVERY candidate — including
  // `request_item_gap.next_call`, the one bounded read of that point's own
  // candidates — so the contract fell to awaiting-input and the no-dead-end
  // guard rewrote it to a bare `tl_search_files tree`, whose response carries
  // no `next` and no decision (confirmed live: the concern's evidence sat in
  // the unserved remainder of the very file the pack had half-served). The
  // escape stays bounded: the gap call is re-derived from the CURRENT proof
  // model each turn and targets only unserved candidate windows, so once
  // they are served the item is covered, absent, or could-not-determine and
  // nothing is proposed again.
  //
  // Lifted ONLY when that point actually has its own bounded call. A request
  // item with no candidate to read (a doc-only mention, an unreadable file,
  // an unbounded scan) is not helped by re-opening discovery — that would
  // only let an unrelated generic fallback (a zoom of some other surface)
  // through, and the honest state for such an item is the awaiting-input
  // that names it.
  const requestItemOpen = obligations.some((obligation) =>
    obligation.status !== "proved"
    && obligation.id.startsWith(REQUEST_ITEM_OBLIGATION_PREFIX));
  const requestItemCall = requestItemOpen ? result.request_item_gap?.next_call : undefined;
  // WP-O (eval-0929 §8): the SAME contradiction once more, for an open
  // same-name subject — `identifier:X` refused a call site as X's proof (see
  // `sameNameIdentifierObligation`), so the pack's "discovery is closed"
  // verdict must not suppress the one bounded read that closes it: the
  // declaration(s) the question means, as ranged targets
  // (`sameNameDeclarationReadCall`). Same bound as the request-item escape:
  // re-derived from the current proof each turn, unserved windows only, and
  // lifted only when such a call exists.
  const sameNameCall = (() => {
    for (const obligation of blockingObligations) {
      if (obligation.status === "proved" || !obligation.id.startsWith("identifier:")) continue;
      const subject = sameNameSubjectsFor(result).get(obligation.id.slice("identifier:".length));
      if (subject === undefined) continue;
      const call = sameNameDeclarationReadCall(result, subject, query, workspace);
      if (call !== undefined) return call;
    }
    return undefined;
  })();
  const routeClosedAnswer = result.route?.action === "answer_from_handles"
    && (result.route.max_additional_tl_calls ?? 0) === 0
    && !enumeratedItemOpen
    && requestItemCall === undefined
    && sameNameCall === undefined;
  // R-B1 (review B2): `proofNext` only reaches the request-item batch when
  // the FIRST uncovered obligation is itself a request item. When it is not
  // (a pack that served nothing yet leaves `surface-content` first), the
  // point's own candidate read must still outrank the pack's generic
  // pre-contract next — confirmed live: a `find` for the request's LEAD VERB
  // ("walk", from "Walk me through …") was prescribed while the batched read
  // of the one file that answers both points sat unused. Order for an open
  // request item: its candidate windows first, the generic fallbacks after.
  const requestItemNext = requestItemCall;
  const candidateCall = accepted || humanChoicePending || routeClosedAnswer
    ? undefined
    : [artifactFallback, continuationCall, proofNext, requestItemNext, sameNameCall, parsedNextAfterProof, gapFallback, partialFallback, missingAffordance]
        .filter((call): call is ContinuationCall => call !== undefined)
        .map((call) => admitReadOnlyNextCall(call, query))
        .filter((call): call is ContinuationCall => call !== undefined)
        // SHOULD-FIX 59: applied to the WHOLE chain, not just `parsedNext`. Any
        // candidate that merely re-reads a window this response already served
        // is dropped here, so a `discover` can never prescribe a call whose only
        // possible answer is a bodyless `code-unchanged` receipt with no `next`.
        // SHOULD-FIX 59: applied to the WHOLE chain, not just `parsedNext`. Any
        // candidate that merely re-reads a window this response already served
        // is dropped here, so a `discover` can never prescribe a call whose only
        // possible answer is a bodyless `code-unchanged` receipt with no `next`.
        // Both forms of "already served" are covered: a RANGED re-read
        // (`nextCallCoveredBySpans`, which round 10 applied to `parsedNext`
        // alone — `proofNext` and the fallbacks walked straight past it) and a
        // BODYLESS whole-handle re-read (`nextCallReReadsServedWindow`, the form
        // that regex could never judge because it requires a `range`).
        .find((call) => !nextCallCoveredBySpans(result, call, currentPackSpans)
          && !nextCallReReadsServedWindow(result, call, currentPackSpans)
          && !nextCallTargetsUnreadablePath(result, call));
  const callBudget = valueCallBudget(
    terminalAction,
    baseReady,
    accepted,
    falsification.unresolved.length,
    risk,
    candidateCall,
  );
  let nextCall = callBudget.discovery_allowed ? candidateCall : undefined;
  // No-dead-end rule (2026-07-30): while required surfaces are still
  // code-starved, one bounded evidence-grounded call always beats an
  // awaiting-input verdict an autonomous caller cannot act on — the
  // value-of-information budget does not price in the cost of a contract
  // whose only remaining action is request-user-input.
  // Artifact surfaces carry their content in artifact_sections, not in
  // surface.code — a fully-inlined deck/sheet must count as served evidence
  // for the terminal grant (observed: a named-deck audit pack served both
  // decks inline yet still verdicted awaiting-input/"request user input").
  // Deliberately NOT folded into hasServedCode: slide text is answer
  // evidence, never editable code, and the edit-side sufficiency checks
  // must keep rejecting it.
  const artifactContentByPath = new Map<string, boolean>();
  for (const entry of result.artifact_sections ?? []) {
    if (entry === null || typeof entry !== "object") continue;
    const path = (entry as { path?: unknown }).path;
    const section = (entry as { section?: unknown }).section;
    if (typeof path !== "string" || section === undefined) continue;
    const bytes = Buffer.byteLength(JSON.stringify(section), "utf8");
    if (bytes > 200) artifactContentByPath.set(path, true);
  }
  const servedForGrant = (surface: TaskPackSurface): boolean =>
    hasServedCode(surface) || artifactContentByPath.get(surface.path) === true;
  // codeTaskPackSurfaces() excludes kind:"artifact" entries, so an all-artifact
  // pack would leave requiredSurfaces empty and the grant permanently off —
  // judge the grant over the FULL surface list (code + artifact), same
  // required!==false convention.
  const grantSurfaces = result.surfaces.filter(
    (surface): surface is TaskPackSurface =>
      typeof (surface as { path?: unknown }).path === "string"
      && (surface as { required?: boolean }).required !== false,
  );
  const requiredServed = grantSurfaces.length > 0 && grantSurfaces.every(servedForGrant);
  const tiedConcernAmbiguity = (result.concern_ambiguities?.length ?? 0) > 0;
  if (!accepted && nextCall === undefined && candidateCall !== undefined && !requiredServed && !tiedConcernAmbiguity) {
    // Tied concern candidates are excluded: repository evidence cannot break
    // a tie, so expanding it is bounded-waste by design (multiConcern spec) —
    // that verdict stays with the user. Plain starvation is different: the
    // named call fetches evidence that does not exist in context yet.
    nextCall = candidateCall;
  }
  const effectiveBudget = nextCall !== undefined && !callBudget.discovery_allowed
    ? {
        ...callBudget,
        discovery_allowed: true,
        reason: `${callBudget.reason}; overridden: starved required surfaces make one bounded call cheaper than a dead end`,
      }
    : callBudget;
  // A rejected ready candidate with no bounded discovery call must not fall
  // through to the eventual terminal action. There is no certificate, so
  // answer/edit would bypass the readiness gate; ask the user to resolve the
  // ambiguity instead.
  const awaitingUserInput = !accepted && nextCall === undefined;
  const readiness: TaskExecutionContract["readiness"] = accepted
    ? terminalAction === "answer" ? "answer-ready" : "edit-ready"
    : result.route?.action === "confirm_candidates" || result.coverage_reason === "candidate-list"
      ? "choose-candidate"
      : "needs-followup";
  // Grant the terminal action on a served-but-proof-rejected pack ONLY for the
  // needs-followup family (e.g. concern proof rejected a fully-served frontier).
  // choose-candidate keeps the 2026-07-16a fence: a single served candidate is
  // not authorization — its route already sanctions a bounded follow-up, so it
  // is not a dead end.
  // R-B1 (2026-09-21, review B2): never while a BLOCKING request item is
  // still uncovered. The grant's own words are "the selected windows of every
  // required surface are served — act on the served evidence"; an uncovered
  // `request-item:*` is the proof model saying a point the caller asked about
  // has NO served body, so that guidance is false for it. Worse, the wire
  // re-sites this branch onto `discover` with a restoring zoom of evidence the
  // caller already holds (decisionWire.ts, ruling 6 step 2), which executes to
  // a bodyless receipt with no decision — confirmed live for a concern whose
  // only candidate is an undecodable file. Without the grant the branch is
  // "no evidence-grounded call remains", whose `await_input` NAMES the open
  // concern (invariant (iii)). A request item with a call never reaches here
  // (`requestItemCall` keeps `nextCall` defined).
  const grantServedTerminal = requiredServed && readiness === "needs-followup" && !humanChoicePending && !requestItemOpen;
  const actionFrontier = actionFrontierForCertificate(
    result,
    profile,
    obligations,
    query,
    workspace !== undefined ? priorEpochActionFrontier(workspace, query, result, editObserved) : [],
    editObserved,
    workspace,
  );
  const certificate = accepted
    ? deterministicCertificate(query, profile, obligations, falsification, risk, actionFrontier, workspaceState, ledgerCertificate?.digest,
      certificateIdentityProfile(result, profile))
    : undefined;
  const reason = accepted
    ? terminalAction === "answer"
      ? "proof-carrying answer evidence passed falsification and risk gates"
      : "proof-carrying edit frontier passed falsification and risk gates"
    : falsification.unresolved.length > 0
      ? `ready rejected: unresolved proof ${falsification.unresolved[0]}`
      : risk.decision === "reject"
        ? `ready rejected: false-ready risk ${risk.estimated_false_ready_risk} exceeds ${risk.max_false_ready_risk}`
        : result.route?.reason ?? "task surfaces still need bounded follow-up";
  const chooseCandidateHandles = candidateChoicePending
    ? [...new Set(choiceSurfaces.map((surface) => surface.handle))].slice(0, MAX_BATCH_NEXT_HANDLES)
    : [];
  const reasonFinal = awaitingUserInput
    ? candidateChoicePending
      ? `choose-candidate: every candidate body is served inline (handles ${chooseCandidateHandles.join(",")}); pick the surface matching the task and act on it — bounded expansion is closed`
      : concernChoicePending
        ? `choose-candidate: repository evidence leaves concern candidates tied (${result.concern_ambiguities?.map(({ id }) => id).join(",")}); request the intended target before acting`
        : grantServedTerminal
          ? `${reason}; the selected windows of every required surface are served — act on the served evidence (${terminalAction} against the served handles), widening a window via its handle first if the target lies outside what was served; evidence_model.unresolved lists the open concerns`
          : `${reason}; no evidence-grounded read/search call remains, so request user input before acting`
    : reason;
  // protocol v1, A.7.2 / A.9.2 row 21: emit the awaiting-input CODE from the
  // branch that took the decision. The four arms below are the complete arm set
  // of the ternary above (one conditional under one guard,
  // `awaitingUserInput = !accepted && nextCall === undefined`), so the mapping
  // is exhaustive here rather than a sample — and it is derived from the same
  // booleans the prose is, never parsed back out of the prose.
  //
  // ARM 3 IS RE-SITED ON THE WIRE — [R5-30] / ruling 6, 2026-08-14. This file
  // still MARKS the branch with `"act-on-served-evidence"`, because the token
  // names which branch took the decision and that is exactly what it is for;
  // what changed is that the token is no longer the last word on the DECISION
  // KIND. `protocol/decisionWire.ts`'s `projectTaskDecision` reads it and
  // re-sites the branch onto `act.answer`/`act.edit` when §2.1.1's floor
  // genuinely holds, onto `discover` with a concrete restoring call when it
  // does not, and leaves it here only when neither is true. The contract's
  // in-process `next_action`/`allowed_actions` grant below is deliberately NOT
  // touched: [R5-12] ratified it as alive in-process, and ruling 9 schedules
  // the three "gate open in-process, decision not `act.*`" branches — this is
  // the third — for a post-P3a audit of the GRANT. Ruling 6 does the decision
  // half only.
  const awaitInputCode: TaskExecutionContract["await_input_code"] = awaitingUserInput
    ? candidateChoicePending
      ? "choose-candidate"
      : concernChoicePending
        ? "name-intended-target"
        : grantServedTerminal
          ? "act-on-served-evidence"
          : "no-grounded-call-remains"
    : undefined;
  const evidenceModel = buildDecisionEvidenceModel(terminalAction, obligations, falsification, risk);
  const capabilityGaps = buildCapabilityGaps(result, blockingObligations, nextCall, awaitingUserInput, query, workspace);
  // -------------------------------------------------------------------------
  // P2-4 (2026-09-08, v0.14.1 hands-on report): THE SERVED-TERMINAL GRANT IS
  // CERTIFIABLE — WHICH IS WHAT MAKES ruling 6's STEP 1 REACHABLE.
  //
  // `decisionWire.ts`'s branch-3 re-siting ([R5-30] / ruling 6, 2026-08-14)
  // has three ordered steps, and its own comment records that step 1 —
  // "a REAL certificate plus a satisfied §2.1.1 floor -> `act.*`" — could not
  // fire at HEAD: `grantServedTerminal` requires `readiness ===
  // "needs-followup"` (i.e. `!accepted`) while the only certificate minted
  // above requires `accepted`. `packages/types/src/mcp/decision.ts`'s
  // `AwaitInputCode` doc records the same thing as an unresolved honesty
  // tension: a token spelled *act*-on-served-evidence riding the one decision
  // kind whose meaning is "I cannot proceed". The gap is HERE, in the
  // producer, not in the projector.
  //
  // WHAT THIS CERTIFIES, EXACTLY. `grantServedTerminal`'s own precondition is
  // `requiredServed` — every required surface's selected window is provably
  // delivered (`servedForGrant`: an inlined body, a `code_unchanged`
  // restatement, or inlined artifact sections). That is a real, checked
  // property of THIS response, and it is the only thing this certificate
  // claims: its obligations are exactly the PROVED ones, so an obligation the
  // proof model rejected is never laundered into the certificate by being
  // adjacent to one that passed. The falsification report and the risk model
  // stay on the contract beside it (see the spread below) rather than being
  // trimmed away, so the residual is still nameable — what a caller must not
  // get is a certificate that SILENTLY absorbs it.
  //
  // WHAT IT DOES NOT DO — three fences, all unchanged:
  //   1. `state` stays `"needs-followup"`, so `state/session.ts`'s
  //      `recordExecutionContract` CLEARS the execution fence exactly as
  //      before ("if (contract?.state !== \"ready\") ... return \"cleared\"").
  //      This is wire guidance, never write authority — the same standing
  //      `grantServedTerminal`'s `allowed_actions` grant already has.
  //   2. `discovery_complete` stays false and `typestate.phase` stays
  //      `awaiting-input`, so `hasCertificateForTerminal` (canonicalDecision.ts)
  //      still refuses to promote the CANONICAL decision to `act-*`. The act
  //      can only arrive through branch 3's floor check, which is where ruling
  //      6 put it.
  //   3. `semantic_closure.closure_id` keeps deriving from `certificate`
  //      (the accepted one) only, so an un-accepted pack's closure id is
  //      byte-identical to before.
  //
  // The no-certificate fallback stays REACHABLE, which `wireActFloor.spec.ts`
  // pins: no proved obligation (nothing to certify), or a floor the served
  // frontier cannot satisfy, still lands on branch 3's step 2/3.
  // -------------------------------------------------------------------------
  // WHAT "SCOPED TO THE SERVED SURFACES" HAS TO MEAN. A certificate is a proof
  // claim, so the grant may only cover a pack whose OWN proof model has nothing
  // outstanding: every obligation proved and no unresolved falsification —
  // `evidence_model.unresolved` empty, stated from its two inputs so the check
  // is the same set the model publishes. What keeps such a pack out of
  // `accepted` is then never an unproved obligation; it is a NON-EVIDENCE gate
  // (base readiness, an unestablished durable ledger), and that is exactly the
  // state ruling 6 describes when it says a served-terminal contract "must get
  // the act it earned".
  //
  // RISK IS STILL SUPPRESSION-ONLY, AND STILL SUPPRESSES. A rejected
  // false-ready risk withholds a theorem that holds (A-F6 layer 2); certifying
  // past it here would turn that layer off through a side door.
  const proofModelSettled = obligations.every((obligation) => obligation.status === "proved")
    && falsification.unresolved.length === 0
    && risk.decision !== "reject";
  // STEP 2 STILL OUTRANKS STEP 1 WHEN A RECOVERY IS NAMED. Ruling 6's order is
  // "certificate, else a concrete restoring call, else await" — but its step 1
  // was written for a contract that arrives certified, not for one this
  // producer could choose to certify while it is simultaneously publishing a
  // gap that NAMES the call which would close it (W9's `ambiguous-target` gap
  // and its batched `tl_search_files action=find` over the still-uncovered
  // explicit identifiers). Certifying past that would answer an uncovered
  // request item from surfaces that provably do not contain it — the exact
  // regression `w9a`/`w9c` pin. So the grant is withheld while any capability
  // gap still names an executable recovery: something remains to FETCH, which
  // is not the state `grantServedTerminal` describes.
  const gapNamesRecovery = (capabilityGaps ?? []).some((gap) => gap.next_call !== undefined);
  // AND THE EPOCH'S OWN CONTRACT MUST BE CLOSED (2026-09-08 regression fix,
  // `fieldEvalFixtures.spec.ts` FIXTURE A release gate — false_complete_rate=0).
  //
  // `gapNamesRecovery` and `proofModelSettled` both judge THIS response in
  // isolation: this pack's capability gaps, this pack's obligations. Neither
  // can see the standing requirement contract the TASK EPOCH carries — the
  // durable role/concern ledger (`taskContractStore.ts`) whose open rows this
  // very function projects into `result.missing` as `unresolved-ledger:` a
  // few hundred lines above, and which `reconcileEpochTaskContract` /
  // `reconcileTaskChangeContract` restate as `unserved-required-role:` /
  // `uncovered-concern:` / `missing_required_surfaces[]` /
  // `change_contract.missing[]`.
  //
  // MEASURED: a broad propagation pack (`surfaceRoles:["contract","api","ui",
  // "test"]`) followed by the SAME-EPOCH narrowed continuation shipped
  // `task.coverage:"partial"`, `coverage_reason:"concerns-uncovered"`,
  // `change_contract.status:"needs-followup"` with
  // `missing:["unresolved-ledger:required-role:api",
  // "unresolved-ledger:required-role:contract"]` — and, because every surface
  // it DID select was inlined, `grantServedTerminal` held, the proof model was
  // settled over the obligations it had minted, no gap named a recovery, and
  // the new certificate promoted the wire decision to a 7-file `act.edit`.
  // That is the false-complete shape the release gate exists to forbid: one
  // response asserting "still open" in its contract and "certified, act now"
  // in its decision. The pack is not wrong about either half — it is wrong to
  // publish both, and the certificate is the half that must yield, because a
  // certificate is the claim that nothing is outstanding.
  //
  // THE PREDICATE IS THE RESPONSE'S OWN DISCLOSURE, NOT A SECOND OPINION.
  // Everything it reads is already on this result and already shipped; the
  // gate cannot invent a gap the response does not itself publish, so it can
  // only ever demote a pack that was contradicting itself.
  //
  // STRICTLY SUBTRACTIVE, AND ONLY HERE. A pack whose epoch contract is closed
  // — the P2-4 repro, and every fresh-epoch pack, whose ledger has nothing open
  // — certifies byte-identically to before, which is what keeps
  // `p2-4-served-terminal` and P1-1's `act.edit` continuation green. When it
  // DOES fire, the response is exactly the pre-P2-4 one for that pack:
  // `decisionWire.ts`'s branch-3 falls through to step 2 (`discover` with the
  // restoring call when one exists) and otherwise to step 3 (`await_input`).
  // `grantServedTerminal` itself is deliberately NOT withheld: [R5-12]
  // ratified its in-process `next_action`/`allowed_actions` grant as alive
  // independently of the wire siting, and dropping the `edit` affordance would
  // cost an ask turn without making any claim more honest.
  const epochContractOpen = openEpochContractRequirements(result, obligations, terminalAction);
  const servedTerminalCertificate = certificate === undefined
    && grantServedTerminal
    && !gapNamesRecovery
    && proofModelSettled
    && epochContractOpen.length === 0
    && obligations.length > 0
    ? deterministicCertificate(
        query,
        profile,
        obligations,
        falsification,
        risk,
        actionFrontier,
        workspaceState,
        ledgerCertificate?.digest,
        certificateIdentityProfile(result, profile),
      )
    : undefined;
  const semanticClosure: TaskSemanticClosure = {
    version: 1,
    state: accepted ? "closed" : awaitingUserInput ? "awaiting-input" : "open",
    closure_id: certificate?.id ?? `open-${shaOfText(JSON.stringify({
      task: `${profile}\u0000${query}`,
      workspace: workspaceState.fingerprint,
      unresolved: evidenceModel.unresolved,
    })).replace(/^sha256:/, "").slice(0, 16)}`,
    obligations_total: obligations.length,
    obligations_proved: obligations.filter((obligation) => obligation.status === "proved").length,
    unresolved: evidenceModel.unresolved,
  };
  return {
    version: 1,
    state: accepted ? "ready" : "needs-followup",
    readiness,
    discovery_complete: accepted,
    next_action: accepted
      ? terminalAction
      : awaitingUserInput
        ? grantServedTerminal ? terminalAction : "request-user-input"
        : "followup",
    max_additional_discovery_calls: nextCall ? 1 : 0,
    reason: reasonFinal,
    ...(awaitInputCode !== undefined ? { await_input_code: awaitInputCode } : {}),
    workspace_state: workspaceState,
    evidence_model: evidenceModel,
    semantic_closure: semanticClosure,
    ...(capabilityGaps ? { capability_gaps: capabilityGaps } : {}),
    // P2-4: a served-terminal certificate rides ALONGSIDE the rejection report
    // it does not resolve — `falsification`/`readiness_risk` stay, so the
    // residual the pack could not prove is still named on the same contract.
    ...(certificate
      ? { readiness_certificate: certificate }
      : {
          ...(servedTerminalCertificate ? { readiness_certificate: servedTerminalCertificate } : {}),
          falsification,
          readiness_risk: risk,
        }),
    typestate: accepted
      ? {
          phase: "prepared",
          certificate_id: certificate!.id,
          // Declared answer keeps the strict read-only grant. An INFERRED
          // answer shape (§14 serves the pack as generic) stays permissive:
          // answer leads, edit remains reachable without a challenge turn —
          // the 2026-07-25 misfire measurement showed answer-shaped queries
          // are often edit tasks, so blocking edit here would re-create that
          // regression in the other direction.
          allowed_actions: terminalAction === "answer"
            ? profile === "answer" ? ["answer", "challenge"] : ["answer", "edit", "challenge"]
            : ["edit", "challenge"],
          challenge_required_for: terminalAction === "answer" && profile === "answer"
            ? ["read", "search", "edit"]
            : ["read", "search"],
        }
      : awaitingUserInput
        ? {
            phase: "awaiting-input",
            // choose-candidate: the pending input IS the choice, and acting on
            // a served candidate is how the caller supplies it — edit stays
            // allowed so closing discovery never costs an extra ask turn. No
            // fence is installed for a non-ready contract, so this is wire
            // guidance, not a guard change.
            allowed_actions: candidateChoicePending
              ? terminalAction === "answer"
                ? ["answer", "edit", "request-user-input"]
                : ["edit", "request-user-input"]
              : grantServedTerminal
                // Same rationale as choose-candidate above: every required
                // body is already in context, so acting on it is the one
                // move that closes the task without an ask turn. No fence is
                // installed for a non-ready contract — wire guidance only.
                ? [terminalAction, "request-user-input"]
                : ["request-user-input"],
            challenge_required_for: [],
          }
        : {
            phase: "discovery",
            allowed_actions: ["read", "search"],
            challenge_required_for: [],
          },
    call_budget: effectiveBudget,
    ...(nextCall ? { next_call: nextCall } : {}),
  };
}
