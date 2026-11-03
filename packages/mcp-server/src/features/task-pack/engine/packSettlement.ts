// packSettlement — extracted implementation; imports point to the owning modules.
import * as path from "path";
import type { ContinuationCall } from "./packBasics.js";
import type { PackCheckRecord } from "../../../state/session.js";
import type { PendingPackBookings } from "./wiringEvidence2.js";
import type { PersistedEvidenceExpansion } from "./epochContract3.js";
import type { PriorObligationRecord } from "../priorPackStore.js";
import type { TaskPackArgs } from "../model.js";
import type { TaskPackResult } from "../model.js";
import type { TaskPackResultSurface } from "../model.js";
import type { TaskPackSurface } from "../model.js";
import type { TaskWiringProfile } from "@tokenlighten/types";
import type { ToolCall } from "@tokenlighten/types";
import { FileReadCache } from "./packBasics2.js";
import { MAX_FALLBACK_BODY_REDUCTIONS } from "./callerRangeDelivery.js";
import { MAX_FALLBACK_MISSING_ENTRIES } from "./epochContract3.js";
import { SHED_REDUCTION_SLACK_BYTES } from "./packBasics2.js";
import { activePackByteCeiling } from "./packBasics2.js";
import { annotateBatchEditFrontier } from "./servedStateAndEdits.js";
import { annotateEditZoomAffordance } from "./runtimeAndDedup.js";
import { annotateSemanticFrontierContinuation } from "../semanticFrontier.js";
import { annotateSpannedRoots } from "./packTrimming2.js";
import { annotateUnsweptWiringEndpoints } from "./createAndWiringEndpoints2.js";
import { applyAgentGuideElision } from "./guideAndArtifactSurfaces.js";
import { applyAwaitingInputIdempotency } from "./runtimeAndDedup.js";
import { applyBodylessDiscover } from "../bodylessDiscover.js";
import { applyCanonicalTaskDecision } from "../canonicalDecision.js";
import { applyCompleteStopRouteToResult } from "./completionAndDocSlivers.js";
import { applyDocSliverHonesty } from "./completionAndDocSlivers.js";
import { applyEnvelopeWeightTrim } from "./runtimeAndDedup.js";
import { applyFoldSmallRemainder } from "./callerRangeDelivery.js";
import { applyLedgerServedSurfaces } from "./runtimeAndDedup.js";
import { applyPackContainmentDedup } from "./runtimeAndDedup.js";
import { applyPackDedupe } from "./runtimeAndDedup.js";
import { applyRequiredSourceCapsuleDedup } from "./runtimeAndDedup.js";
import { applyResidentFileDedup } from "./runtimeAndDedup.js";
import { applySemanticFrontierNamedFrontier } from "./semanticFrontier.js";
import { applySemanticFrontierPreBookingSeam } from "./semanticFrontier.js";
import { assertCreateRoute } from "./createAndWiringEndpoints2.js";
import { assertTaskPackConstructionInvariant } from "./packBasics.js";
import { attachAuxiliaryEnumContexts } from "../auxiliaryEnumContextIntegration.js";
import { attachCandidateListRecovery } from "./epochContract.js";
import { attachEnumStyleReviews } from "./focalFlow.js";
import { attachFunctionalValidationObligation } from "./runtimeAndDedup.js";
import { attachGoReturnedLocalReviews } from "./focalFlow.js";
import { attachJavaLoopGuardReviews } from "./focalFlow.js";
import { attachPrefetchedArtifactSections } from "./guideAndArtifactSurfaces.js";
import { attachPythonInterpreterHint } from "./runtimeAndDedup.js";
import { attachRuntimeHint } from "./runtimeAndDedup.js";
import { attachSingleSiteUniqueMatchFastPath } from "./servedStateAndEdits.js";
import { attachVerificationVerdict } from "./servedStateAndEdits.js";
import { auxiliaryEnumAttachmentSizePreview } from "../../../protocol/auxiliaryEnumAttachmentSizePreview.js";
import { auxiliaryEnumPool } from "../auxiliaryEnumContextIntegration.js";
import { bindTaskProfile } from "./coverageAndContinuation4.js";
import { bookShippedPackServeState } from "./servedStateAndEdits.js";
import { buildSemanticTaskWiringProfile } from "./wiringProfiles2.js";
import { buildTaskChangeContract } from "./changeAndReadinessEvidence.js";
import { buildTaskExecutionContract } from "./executionContract.js";
import { buildTaskWiringProfile } from "./wiringProfiles2.js";
import { buildTaskWorkspaceState } from "./epochEvidence2.js";
import { callerRangeElisionWindows } from "./callerRangeDelivery.js";
import { capForResult } from "./packState.js";
import { capGuidanceMetadata } from "./packTrimming2.js";
import { carryAuxiliaryEnumPool } from "../auxiliaryEnumContextIntegration.js";
import { carryForwardCertifiedWorkingSet } from "./epochContract2.js";
import { ceilingCertificationSnapshot } from "./callerRangeDelivery.js";
import { codeTaskPackSurfaces } from "../artifactSections.js";
import { collectArtifactSurfaces } from "./packBasics3.js";
import { computeWorkspaceInventoryState } from "./epochEvidence2.js";
import { contractForEvidenceRetention } from "./contractReconciliation.js";
import { contractForTrim } from "./contractReconciliation.js";
import { coveragePackerV2Enabled } from "../../../util/flags.js";
import { dedupeAgentGuideSurfaces } from "./guideAndArtifactSurfaces.js";
import { deriveNextFromPlan } from "./packBasics.js";
import { discloseUnreadableNamedPaths } from "./servedStateAndEdits3.js";
import { discloseUnservedQualifiedAnchorDefinition } from "./completionAndDocSlivers.js";
import { discloseUnwritableStrippedPaths } from "./servedStateAndEdits.js";
import { displayLineCount } from "./callerRangeDelivery.js";
import { effAutofollowEnabled } from "../../../util/flags.js";
import { enforceCeilingCertificateInvariant } from "./callerRangeDelivery.js";
import { enforceContinuationBudget } from "../../../util/continuation.js";
import { enforceNoDeadEndContract } from "./contractReconciliation.js";
import { enumNamesDeclaredWith } from "../listedScopeItems.js";
import { extractEnumValueTokens } from "./createAndWiringEndpoints2.js";
import { finalizePackServeState } from "./contentSettlement2.js";
import { fitsInCap } from "./packTrimming2.js";
import { fitsInCapUncompacted } from "./packTrimming2.js";
import { getSession } from "../../../state/session.js";
import { handleTable } from "../../../util/handles.js";
import { hasCallableDeclarationSibling } from "./createAndWiringEndpoints2.js";
import { hasCurrentEvidenceExpansionGap } from "./epochContract3.js";
import { hasExactNamedAnswerFacetEvidence } from "./recursiveClosure.js";
import { hasRequestedMutationIntent } from "./coverageAndContinuation3.js";
import { hasRequiredArtifactSections } from "./artifactPackBuilder2.js";
import { hasServedCode } from "./wiringEvidence2.js";
import { inlineCodelessSurfaces } from "./contentSettlement2.js";
import { isArtifactConsumerSurface } from "../artifactConsumers.js";
import { isArtifactTaskPackSurface } from "../artifactSections.js";
import { isCandidateListPack } from "./recursiveClosure3.js";
import { isEnumLikeQuery } from "../../../util/queryShape.js";
import { isFirstEpochPack } from "./runtimeAndDedup.js";
import { isRequiredEnumReview } from "../changeScopeContinuation.js";
import { isWiringIdentifierShape } from "./createAndWiringEndpoints2.js";
import { literalFirstMeasurement } from "./literalAndConcernSeeds.js";
import { literalFirstRoutingEnabled } from "../../../util/flags.js";
import { literalSourceUniverseProved } from "./literalAndConcernSeeds2.js";
import { markCallerRangeSurface } from "../sfWithholdingMarks.js";
import { markServedZoomCandidates } from "./packState2.js";
import { markSurfaceProvenance } from "../sfWithholdingMarks.js";
import { mayNameCallerArtifact } from "./guideAndArtifactSurfaces.js";
import { mergeRangeStrings } from "./callerRangeDelivery.js";
import { nextHintForCoverage } from "./coverageAndContinuation.js";
import { normIdent } from "./createAndWiringEndpoints2.js";
import { normalizeContractLane } from "../../../util/packServeLog.js";
import { noteDeclaredProfileCreateConflict } from "./coverageAndContinuation4.js";
import { noteInheritedTaskProfile } from "./coverageAndContinuation4.js";
import { noteSemanticFrontierTraceSeed } from "../../../protocol/semanticFrontierTraceContext.js";
import { packContainmentDedupEnabled } from "../../../util/flags.js";
import { packGuideElideEnabled } from "../../../util/flags.js";
import { packServedSpans } from "./packState2.js";
import { packWireBytes } from "./packTrimming.js";
import { parsePackLineRange } from "./packState2.js";
import { pendingCandidatePaths } from "./epochContract3.js";
import { persistPackFingerprints } from "./runtimeAndDedup.js";
import { plainAnchorReader } from "../anchorFirst.js";
import { prefetchedCallerNamedArtifacts } from "./guideAndArtifactSurfaces.js";
import { prepareSemanticFrontierTraceSeed } from "../semanticFrontier.js";
import { primaryEnumContextRows } from "../auxiliaryEnumContextIntegration.js";
import { priorBodyRestoration } from "./packState2.js";
import { projectCompletion } from "../canonicalDecision.js";
import { promoteExecutedSearchAbsences } from "./identifierAbsence.js";
import { protocolCallContext } from "../../../protocol/envelope.js";
import { pruneIrrelevantWiringImplementationSurfaces } from "./wiringProfiles2.js";
import { queryNamedArtifactTargets } from "./artifactPackBuilder2.js";
import { queryNamedWorkspaceFiles } from "./queryIntent3.js";
import { queryPriorPackObligations } from "../priorPackStore.js";
import { readCached } from "./packBasics2.js";
import { rebindPreparedCertificateToLedger } from "./contentSettlement2.js";
import { rebuildFinalExecutionContract } from "./contentSettlement2.js";
import { recallAnchorResolution } from "../anchorFirst.js";
import { recomputeRouteAndNextAfterTrim } from "./contentSettlement.js";
import { reconcileCallerPathCoverage } from "./completionAndDocSlivers.js";
import { reconcileCallerRangeRemaining } from "./callerRangeDelivery.js";
import { reconcileContentSufficiency } from "./contentSettlement.js";
import { reconcileEpochTaskContract } from "./epochContract.js";
import { reconcileMissingRolesContract } from "./epochContract.js";
import { reconcileTaskChangeContract } from "./contractReconciliation.js";
import { reconcileTaskPackExecutionContract } from "./contractReconciliation.js";
import { recordBudgetDeferredSurface } from "../changeScopeContinuation.js";
import { recordEpochTaskContract } from "./epochContract.js";
import { recordPackChecks } from "../../../state/session.js";
import { recordPriorPackObligations } from "../priorPackStore.js";
import { reduceServedBodyTail } from "./callerRangeDelivery.js";
import { refreshAfterRecursiveClosure } from "./recursiveClosure3.js";
import { requiredQueryFacets } from "./changeAndReadinessEvidence2.js";
import { resolveCreateTargetFromQuery } from "./createAndWiringEndpoints.js";
import { restoreAuxiliaryEnumPool } from "../auxiliaryEnumContextIntegration.js";
import { runAnswerDependencyClosure } from "./answerClosure.js";
import { runInternalReadinessFalsification } from "./readinessFalsification2.js";
import { runRecursiveReadOnlyClosure } from "./recursiveClosure4.js";
import { semanticCompletionCheckRecords } from "./wiringProfiles2.js";
import { semanticFrontierGuardEnabled } from "../../../util/flags.js";
import { servedRangeReceipt } from "../../../state/session.js";
import { servedZoomScopeForArgs } from "./packState2.js";
import { settleCallerRangeDelivery } from "./callerRangeDelivery.js";
import { shouldBuildTaskChangeContract } from "./changeAndReadinessEvidence.js";
import { shrinkDocSliverAffordanceToFit } from "./completionAndDocSlivers.js";
import { snapshotCallerRangeSurfaces } from "./callerRangeDelivery.js";
import { sourceLineAfterDisplayLines } from "./callerRangeDelivery.js";
import { stampExplorationState } from "../canonicalDecision.js";
import { stampRollupContentCompleteness } from "./contentSettlement.js";
import { suppressNonProgressingNextCall } from "./receiptProgress.js";
import { surfaceProvenance } from "../sfWithholdingMarks.js";
import { surfaceWhyHasMarker } from "./recursiveClosure.js";
import { taskContractDischargeCertificate } from "../taskContractStore.js";
import { tokenizeForEpoch } from "../../../state/session.js";
import { trimToCap } from "./packTrimming2.js";
import { trustworthySurfaceAnchorPaths } from "./queryIntent.js";
import { tryServeSubsetReceipt } from "./receiptRestoration2.js";
import { unmatchedConcernTokens } from "./roleAndConcernScope3.js";
import { wouldIntroduceBreach } from "../certificateWireInvariant.js";
import { writeAuthorityVeto } from "./changeAndReadinessEvidence.js";

export async function dedupeTrimAndPersist(
  workspace: string,
  result: TaskPackResult,
  opts?: {
    protectedSurfaces?: ReadonlySet<TaskPackSurface>;
    query?: string;
    checkRecords?: PackCheckRecord[];
    /** Behavior 3: the original request args, so this choke point can capture the served-pack essentials for a future exact re-call dedup. Omit to skip capture (a caller with nothing to dedup against). */
    args?: TaskPackArgs;
    /**
     * DESIGN-v0.9 §4.3: recompute inputs. When supplied AND trimToCap flips
     * coverage (whole-surface drop), route/next are recomputed against the
     * post-trim state. The three locate-derived flows (buildTaskPack,
     * buildSeededTaskPack, buildPartialPack) pass this; buildDiffTaskPack
     * deliberately omits it to keep its hardcoded next (§4.5).
     */
    recompute?: { query: string; missingRequired: string[]; unmatchedConcern: string[] };
    /**
     * DESIGN-v0.9 §4.6b: the pack's shared FileReadCache, so the codeless-
     * surface internal execution can re-slice bodies without extra disk reads.
     * The three locate-derived flows (buildTaskPack, buildSeededTaskPack,
     * buildPartialPack) pass it; buildDiffTaskPack omits it (its surfaces are
     * already embedded via centeredSliceForCap and it keeps its hardcoded next,
     * §4.5), so it never inlines here.
     */
    cache?: FileReadCache;
    evidenceExpansion?: PersistedEvidenceExpansion;
    /** artifact_build already attached its ranked discovery surfaces. */
    artifactSurfacesAlreadyAttached?: boolean;
  },
): Promise<TaskPackResult> {
  const effectiveQuery = opts?.query
    ?? opts?.args?.query
    ?? opts?.args?.symbol
    ?? opts?.args?.path
    ?? "";
  const auxiliarySeed = auxiliaryEnumPool(opts?.cache) ?? auxiliaryEnumPool(opts?.args) ?? restoreAuxiliaryEnumPool(
    getSession(workspace).activeTaskQuery, workspace, effectiveQuery,
    opts?.args?.taskBinding, opts?.args?.taskQueryRefReplay === true,
  );
  // Capture names from actual selected source before any primary trim. This is
  // a context subject, never an assertion that the consumers need no changes.
  const auxiliaryPrimaryPaths = [...new Set([
    ...(auxiliarySeed?.primaryPaths ?? []), ...result.surfaces.map(surface => surface.path),
  ])];
  const auxiliarySubjects = auxiliarySeed === undefined ? [] : [...new Set([
    ...auxiliarySeed.subjects,
    ...codeTaskPackSurfaces(result.surfaces).flatMap(surface =>
      surface.role === "contract" && surface.code !== undefined
        ? enumNamesDeclaredWith(surface.code, new Set(extractEnumValueTokens(effectiveQuery))) : []),
  ])];
  const servedZoomScope = servedZoomScopeForArgs(opts?.args, effectiveQuery);
  // BLOCKER 25 (2026-09-14, review round 4): FIRST, before any contract,
  // gap or decision is computed over this pack — see the function's own
  // doc comment for why the disclosure has to precede all three.
  discloseUnreadableNamedPaths(result, effectiveQuery);
  // BLOCKER 62 (AC1, round 12): the same "before any contract, gap or decision"
  // position, for the same reason.
  discloseUnwritableStrippedPaths(result, effectiveQuery);
  let semanticCheckRecords: PackCheckRecord[] = [];
  let binding = noteInheritedTaskProfile(
    bindTaskProfile(opts?.args?.taskProfile, effectiveQuery, opts?.args?.writeAllowed),
    opts?.args,
  );
  let profile = binding.selected;
  result.profile_binding = binding;
  if (profile !== "generic") result.task_profile = profile;
  if (
    profile === "answer"
    && result.route?.action === "edit_from_handles"
  ) {
    result.route = {
      action: "answer_from_handles",
      reason: "validated answer profile — no edit expected",
      max_additional_tl_calls: 0,
    };
    delete result.next;
    delete result.continuation;
  }
  if (
    profile !== "answer"
    && binding.requested !== "auto"
    && binding.requested !== "answer"
    && result.route?.action === "answer_from_handles"
  ) {
    result.route = {
      action: "edit_from_handles",
      reason: `caller-declared ${profile} change profile — structural readiness still required`,
      max_additional_tl_calls: 0,
    };
  }

  // 2026-07-12d answer-pack purification: route:"answer_from_handles" is a
  // promise that no edit is expected (see editFromHandlesRoute's own
  // isAnswerIntentQuery gate, shared by every buildRoute caller) — the pack
  // must not then turn around and carry edit-flavored payload. likely_edits
  // (per-surface "here is how to change this"), checks[] (closure/wiring
  // completion checks), and verify[] (test/build commands) are all
  // edit-shaped content with nothing honest to say to a pack that was never
  // asked to produce an edit. dedupeTrimAndPersist is the single choke point
  // every builder (buildTaskPack, buildSeededTaskPack, buildPartialPack,
  // buildDiffTaskPack) already funnels through, so gating here covers
  // route:"answer_from_handles" regardless of which flow produced it — no
  // per-flow duplication needed.
  if (result.route?.action === "answer_from_handles") {
    delete result.next;
    delete result.continuation;
    for (const surf of codeTaskPackSurfaces(result.surfaces)) {
      delete surf.likely_edits;
      delete surf.edit_intent;
      delete surf.done_check;
    }
    delete result.checks;
    delete result.verify;
  }
  result.surfaces = dedupeAgentGuideSurfaces(result.surfaces, opts?.args);
  // PI-09 close-out: both SURFACE-level body strips below replace real bodies
  // with a `code_unchanged` pointer at "you already hold this". Under
  // `force_serve` that premise is exactly what the caller has denied, and a
  // pack that skipped the three RESPONSE-level receipts only to hand back
  // pointer strings would honour the argument in name and not in bytes — the
  // failure mode this whole close-out exists to remove.
  //
  // The intra-pack half of applyPackDedupe (a surface duplicating an EARLIER
  // surface in the SAME response) is suppressed with it, and deliberately: the
  // response then repeats those bytes, which is what "send it again" means
  // when the caller cannot be assumed to have read the first copy.
  const forceServePack = opts?.args?.forceServe === true && opts?.args?.forceServeCallerTargetsOnly !== true;
  // A small-window reserve force (`forceServeCallerTargetsOnly`) keeps the
  // dedup passes for everything the SERVER adds; only the caller's own
  // requested windows are exempt, so they come back as bodies.
  const dedupExempt = opts?.args?.forceServeCallerTargetsOnly === true
    ? (surface: TaskPackSurface): boolean => surfaceWhyHasMarker(surface.why, "caller-supplied")
    : undefined;
  if (!forceServePack) {
    applyPackDedupe(workspace, result, opts?.args?.taskBinding, dedupExempt);
    // iter-3 F3: after the prior-pack (handle-keyed) dedup, strip any NON-required
    // body whose exact (path,range) was already served this epoch and is
    // byte-unchanged — the cross-pack, content-addressed case applyPackDedupe's
    // single-slot handle match misses (a shared file resurfacing two packs later or
    // under a fresh handle). Runs pre-trim so the freed bytes feed the trim ladder.
    // FIX-FC finding 15: `allowRequiredDedup` for an answer pack — see
    // `applyResidentFileDedup`'s own doc comment, fix (1); an answer profile
    // never carries an edit frontier, so nothing `required` here is an edit
    // target the dedup would wrongly hide.
    applyResidentFileDedup(workspace, result, tokenizeForEpoch(effectiveQuery), { allowRequiredDedup: profile === "answer", ...(dedupExempt ? { exempt: dedupExempt } : {}) });
    // P1-1 item 2: the codeless half of the same residency fact. Inside the
    // `force_serve` guard with its siblings, and for the same reason — that
    // switch is the caller's "I lost my context", which denies the premise
    // every residency claim rests on. A forced pack therefore keeps its
    // honest code-starved gap and re-fetches.
    applyLedgerServedSurfaces(workspace, result);
  }

  let evidencePromotedWiring: TaskWiringProfile | undefined;
  // D10 (2026-08-14): `TL_EVIDENCE_RELATIONS` / `TL_SEMANTIC_WIRING` are deleted;
  // evidence-driven profile promotion is unconditional.
  if (
    (
      profile === "generic"
      || (
        profile === "multi_concern"
        && result.concerns?.some((concern) => concern.status !== "covered")
      )
    )
    && (hasRequestedMutationIntent(effectiveQuery) || profile === "multi_concern")
    && result.route?.action !== "answer_from_handles"
  ) {
    // Probe on a copy because a failed profile promotion must not silently
    // widen the caller's surface set. A successful graph-backed promotion
    // adopts the bounded endpoint closure built by the probe.
    const probeSurfaces = result.surfaces.map((surface) => ({ ...surface }));
    const candidate = profile === "multi_concern"
      ? buildSemanticTaskWiringProfile(effectiveQuery, probeSurfaces, workspace, opts?.cache)
      : buildTaskWiringProfile(effectiveQuery, probeSurfaces, workspace, opts?.cache);
    if (candidate !== undefined) {
    const connection = candidate.connections[0];
    const crossRelations = candidate.evidence_graph?.relations.filter((relation) =>
      relation.kind === "imports" || relation.kind === "references" || relation.kind === "direct_calls"
    ) ?? [];
    const callableInsertionEvidence = connection?.source !== undefined
      && connection.source.evidence.includes("workspace-definition")
      && hasCallableDeclarationSibling(
        connection.source.token,
        connection.source.path,
        workspace,
        opts?.cache,
      )
      && connection.destination !== undefined
      && connection.insertion_handle === connection.destination.handle
      && connection.supporting_handles.length > 0
      && connection.evidence.includes("callable-insertion-site");
    if (
      candidate.status === "ready"
      && connection?.source !== undefined
      && connection.destination !== undefined
      && connection.source.handle !== connection.destination.handle
      && (crossRelations.length > 0 || callableInsertionEvidence)
    ) {
      result.surfaces = probeSurfaces;
      evidencePromotedWiring = candidate;
      profile = "wiring";
      // Generic role guesses are no longer authoritative after the graph has
      // proved the wiring-specific producer/consumer obligations.
      result.missing = [];
      delete result.missing_required_surfaces;
      if (result.concerns) {
        const evidenceHandles = [...new Set([
          ...candidate.edit_frontier,
          ...candidate.review_frontier,
        ])];
        for (const concern of result.concerns) {
          concern.status = "covered";
          concern.handles = evidenceHandles;
        }
        delete result.concern_ambiguities;
      }
      if (result.coverage_reason === "candidate-list" || result.coverage_reason === "concerns-uncovered") {
        // The graph resolved the locator tie with an observed directional
        // relation; keeping choose-candidate would discard that evidence.
        result.coverage = projectCompletion(result, [], { promoteWhenComplete: true }).coverage;
        delete result.coverage_reason;
        delete result.content_sufficiency;
        delete result.blocking_next_steps;
      }
      binding = {
        requested: binding.requested,
        selected: "wiring",
        source: "evidence",
        confidence: crossRelations.length > 0
          ? Math.min(0.97, Math.max(...crossRelations.map((relation) => relation.confidence)))
          : 0.9,
        reason: crossRelations.length > 0
          ? "served repository evidence proves a producer-to-consumer relation"
          : "unique producer definition and callable consumer insertion site close the new connection",
      };
      result.profile_binding = binding;
      result.task_profile = "wiring";
    }
    }
  }

  // A wiring profile is a structured projection over the same conservative
  // locator/closure evidence used by the generic pack. It can add a missing
  // endpoint surface, but never generates the connecting code itself.
  if (profile === "wiring" && result.route?.action !== "answer_from_handles") {
    const wiring = evidencePromotedWiring ?? buildTaskWiringProfile(
      effectiveQuery,
      result.surfaces,
      workspace,
      opts?.cache,
    );
    result.wiring = wiring;
    pruneIrrelevantWiringImplementationSurfaces(result);
    if (wiring.status === "ready" && wiring.evidence_graph !== undefined) {
      result.missing = [];
      delete result.missing_required_surfaces;
      if (result.coverage_reason === "candidate-list") {
        result.coverage = projectCompletion(result, [], { promoteWhenComplete: true }).coverage;
        delete result.coverage_reason;
        delete result.content_sufficiency;
      }
    }
    if (wiring.status === "ready" && result.missing.length === 0) {
      result.route = {
        action: "edit_from_handles",
        reason: "wiring source, consumer, and insertion handle are bundled",
        max_additional_tl_calls: 0,
      };
      delete result.next;
      delete result.continuation;
    } else {
      // Endpoint sweeps run ONLY on caller-typed identifier-shaped tokens the
      // pack could NOT ground in its served surfaces. 2026-07-31 forensics
      // (T13 rep0): follow-up detail queries under a pinned wiring profile
      // ("<struct> fields (accel gyro) … for update()") carry no unresolved
      // identifier; tokens.at(-1) plus the effectiveQuery fallback
      // manufactured `references query="for"` sweeps while the pack itself
      // was coverage:"complete" — a self-contradictory route ("complete" +
      // "missing wiring endpoint") that pushed solvers off TL for the rest of
      // the cell. An UNRESOLVED identifier (named by the caller, absent from
      // the served set — e.g. the not-yet-located consumer) is exactly what
      // the born-dead gate must keep sweeping; when every query identifier
      // grounds, the wiring layer leaves the coverage pipeline's route alone
      // and the finalizer's annotateUnsweptWiringEndpoints says why.
      const unresolvedIdentifiers = unmatchedConcernTokens(
        effectiveQuery,
        codeTaskPackSurfaces(result.surfaces),
      ).filter(isWiringIdentifierShape);
      const sourceToken = unresolvedIdentifiers[0];
      const destinationToken = unresolvedIdentifiers.length > 1
        ? unresolvedIdentifiers.at(-1)
        : unresolvedIdentifiers[0];
      const calls: ContinuationCall[] = [];
      for (const missing of wiring.missing) {
        const token = missing === "source" ? sourceToken : destinationToken;
        if (token === undefined) continue;
        calls.push({
          tool: "tl_search_files",
          arguments: {
            action: missing === "source" ? "find" : "references",
            query: token,
          },
          purpose: missing === "source" ? "locate wiring producer" : "locate wiring consumer",
        });
      }
      if (calls.length > 0) {
        result.route = {
          action: "locate_missing_surfaces",
          reason: "missing wiring endpoint(s): " + wiring.missing.join(","),
          max_additional_tl_calls: calls.length,
        };
        const plan = enforceContinuationBudget({
          version: 1,
          stages: [{ execution: "parallel", calls }],
        });
        if (plan !== undefined) {
          result.continuation = plan;
          const next = deriveNextFromPlan(plan);
          if (next !== undefined) result.next = next;
        }
      }
      // No else: annotateUnsweptWiringEndpoints (the emit-time finalizer
      // invariant) explains a missing-endpoint state whenever no sweep
      // survives — later trim/reconcile passes can strip a sweep planned
      // here, so a branch-local note would under-cover.
    }
  }
  // DESIGN-v0.9 §4.6b internal execution — BEFORE trimToCap so the §4.3 trim
  // inversion strips any over-budget inlined body (not a handle). Only the
  // locate flows pass `cache`; the diff flow omits it and never inlines here.
  if (opts?.cache !== undefined && result.route?.action !== "answer_from_handles") {
    const inlinedCount = inlineCodelessSurfaces(result, workspace, opts.cache);
    // The `next` was computed against the PRE-inline codeless set (a
    // `tl_read_file handles=[...]` batch); once bodies are inlined that batch is
    // stale, so recompute it against the post-inline surfaces. Route is
    // unchanged (a complete/focused pack stays edit_from_handles), so only
    // `next` is refreshed. Skipped when nothing inlined.
    if (inlinedCount > 0 && opts.recompute !== undefined) {
      const nh = nextHintForCoverage(
        codeTaskPackSurfaces(result.surfaces), result.coverage, result.coverage_reason,
        opts.recompute.query, opts.recompute.missingRequired, opts.recompute.unmatchedConcern,
      );
      if (nh !== undefined) result.next = nh;
      else delete result.next;
    }
  }
  const coverageBefore = result.coverage;
  if (
    opts?.args !== undefined
    && opts.artifactSurfacesAlreadyAttached !== true
    // 残Stage2 (2026-08-01 probe F1): this wire choke point appended
    // query-token-matched artifact files to EVERY pack — a code question
    // mentioning "skeleton" picked up a microbench CSV as a surface. Gate on
    // the same caller-spoke-artifacts test prefetch already uses (see
    // decoyDemotion.spec.ts's own regression test, whose comment names this
    // exact gate as the fix); the T10 caller-NAMED artifact path in paths[]
    // keeps passing it.
    && result.route?.action !== "answer_from_handles"
    && mayNameCallerArtifact(opts.args, effectiveQuery)
  ) {
    const artifacts = collectArtifactSurfaces(opts.args, workspace);
    const seenPaths = new Set(result.surfaces.map((surface) => surface.path));
    (result.surfaces as TaskPackResultSurface[]).push(
      ...artifacts.filter((surface) => !seenPaths.has(surface.path)),
    );
  }
  // A1: a resolved, CALLER-NAMED artifact surface must carry its extracted text,
  // not just a size + an `extract` call. Attached HERE — after the surfaces
  // exist, before coverage/readiness/the execution contract are computed — so
  // the certificate is decided over the artifact content this pack actually
  // serves (a post-exit inline would ship content beside an "ask the user"
  // contract). No-op for artifact_build (it bundles its own sections) and for
  // any pack whose request named no artifact.
  attachPrefetchedArtifactSections(result, workspace, profile);
  if (
    effectiveQuery.length > 0
    && shouldBuildTaskChangeContract(effectiveQuery, result, profile)
  ) {
    result.change_contract = buildTaskChangeContract(effectiveQuery, result, workspace);
  }
  // A provisional ready route is not authoritative until a bounded negative
  // retrieval pass has tried to disprove it. Counterexamples are embedded in
  // this same response, then every proof/risk decision below is recomputed
  // over the enriched surface set. This spends server I/O, not another agent
  // turn, and is deliberately capped at two surfaces / 120 files.
  const artifactTargetNames = queryNamedArtifactTargets(effectiveQuery);
  const exactArtifactTargetServed = profile === "artifact_build"
    && hasRequiredArtifactSections(result, effectiveQuery)
    && (
      result.create_target !== undefined
      || codeTaskPackSurfaces(result.surfaces).some((surface) =>
        !isArtifactConsumerSurface(surface)
        && artifactTargetNames.has(normIdent(path.basename(surface.path, path.extname(surface.path))))
        && hasServedCode(surface)
      )
    );
  const exactAnswerTargetServed = profile === "answer"
    && (
      result.answer_resolution !== undefined
      // B1d (2026-08-01 retrieval-scope): `workspace` is what lets the facet
      // check see that a facet's call sites are still in remaining_ranges.
      || hasExactNamedAnswerFacetEvidence(result, effectiveQuery, workspace)
    );
  const falsificationAdded = result.literal_source_absence !== undefined
    || exactArtifactTargetServed
    || exactAnswerTargetServed
    ? 0
    : runInternalReadinessFalsification(
        result,
        profile,
        effectiveQuery,
        workspace,
        opts?.args?.paths?.map((entry) => typeof entry === "string" ? entry : entry.path),
      );
  if (falsificationAdded > 0) {
    // Counterexample retrieval can reveal the real wiring consumer after an
    // API/header was provisionally chosen as the endpoint. Rebuild all
    // derived frontiers before certifying the enriched evidence set.
    refreshAfterRecursiveClosure(result, profile, effectiveQuery, workspace, opts?.cache);
  }
  // 2026-10-06 independent review (P1-1/P1-2): the constants every served
  // callable reads — the counterexamples just admitted included — before
  // anything below certifies this evidence set. No frontier refresh after
  // it: a constant window changes no role, wiring or concern frontier, and
  // `refreshAfterRecursiveClosure`'s re-derivation of `missing` for an answer
  // pack turned a progressing ranged `next` into a closure tree search that
  // re-served the same pack forever (concernStatusPolicyMatrix readme-only).
  if (
    profile === "answer"
    && effectiveQuery.length > 0
    && result.literal_source_absence === undefined
    && result.create_target === undefined
  ) {
    await runAnswerDependencyClosure(result, effectiveQuery, workspace, opts?.cache);
  }
  if (
    falsificationAdded > 0
    && effectiveQuery.length > 0
    && shouldBuildTaskChangeContract(effectiveQuery, result, profile)
  ) {
    result.change_contract = buildTaskChangeContract(effectiveQuery, result, workspace);
  }
  if (profile !== "answer") {
    // Answer packs need responsibility evidence, not transitive edit closure.
    // Expanding imports from an explanatory surface can pull unrelated
    // exceptions/serializers into the pack and displace the actual structural
    // map under the byte cap.
    runRecursiveReadOnlyClosure(
      result,
      profile,
      effectiveQuery,
      workspace,
      opts?.cache,
      [
        ...(typeof opts?.args?.path === "string" ? [opts.args.path] : []),
        ...(opts?.args?.paths?.map((entry) => typeof entry === "string" ? entry : entry.path) ?? []),
      ],
    );
  }
  // For a broad independent-concern pack, the per-surface concern map and
  // execution certificate already encode the action frontier. A second
  // change_contract repeats every handle and can force a required header or
  // the authoritative typestate out of the fixed response budget. Keep the
  // richer staged contract for smaller packs, where it still fits cheaply.
  if (
    profile === "multi_concern"
    && result.wiring?.strategy !== "semantic-multihop"
    && codeTaskPackSurfaces(result.surfaces).filter((surface) => surface.required === true).length >= 5
  ) {
    result.change_contract = undefined;
  }
  // W3 (turn-economy wave 2): a create-intent query that NAMES a not-yet-existing
  // file must answer with the create ROUTE — create_target + an `tl_edit_file
  // create:true` next, alongside whatever related context the pack already
  // served — never a contentless "search for it" envelope (E3: a clear "Add a
  // new pytest regression test file tests/…" returned ~511 bytes with no
  // coverage/surfaces/create_target twice in a row). create_target is resolved
  // HERE (before the execution contract is built) so buildReadinessObligations'
  // provedCreate treats the new-file frontier as an actionable target and the
  // contract certifies prepared, instead of falling to needs-followup and
  // demoting the create route. The concrete `next`/`route` are re-asserted
  // AFTER the contract machinery (which drops a prepared pack's discovery
  // `next`) — see the assertCreateRoute call below. Idempotent: skipped when a
  // flow (e.g. artifact_build) already resolved create_target, and never on an
  // answer pack (a create is a mutation).
  if (
    result.create_target === undefined
    && profile !== "artifact_build"
    && result.route?.action !== "answer_from_handles"
    && effectiveQuery.length > 0
  ) {
    const createTarget = resolveCreateTargetFromQuery(effectiveQuery, workspace, result.surfaces);
    if (createTarget !== undefined) {
      result.create_target = createTarget;
      // The new file IS the self-complete action frontier: its path came from
      // the caller's explicit request and its parent directory exists, so the
      // pack is a single confident create site (not an "uncovered concern").
      // Set the terminal create route HERE so the contract certifies prepared
      // rather than needs-followup (which would demote it back to "search").
      result.coverage = "focused";
      result.coverage_reason = "single-site";
      result.missing = [];
      result.content_sufficiency = undefined;
      // The old "go find the file that doesn't exist yet" guidance is exactly
      // the manufactured extra turn this create route replaces.
      result.blocking_next_steps = undefined;
      result.create_note = undefined; // superseded by the concrete create_target
      result.change_contract = undefined; // the create frontier supersedes it
      result.route = {
        action: "edit_from_handles",
        reason: "requested new file resolved; create it with tl_edit_file create:true, imitating the served sibling(s)/module",
        max_additional_tl_calls: 0,
      };
      delete result.next;
    }
  }
  noteDeclaredProfileCreateConflict(result);
  // TL142-01B: fold every absence the CALLER's own executed searches proved
  // into this pack's absence vocabulary, before the contract builder reads
  // either carrier. See `promoteExecutedSearchAbsences`.
  if (effectiveQuery.length > 0) {
    promoteExecutedSearchAbsences(workspace, effectiveQuery, result, opts?.args?.taskBinding);
  }
  // IMPROVEMENT A: consult/record the session-stateful served-surface log,
  // flip coverage to cumulative-complete when the union of this call's surfaces
  // and still-valid prior surfaces closes every required role, and attach the
  // complete-working-set frontier_index. Runs BEFORE the contract build so a
  // cumulative flip certifies exactly like a single-call complete pack. When it
  // fires, the remaining proof is a plain surface-content proof over the served
  // surfaces (the role-specific structure was proven across the earlier calls,
  // which the stateless contract builder cannot re-verify), so the contract is
  // certified under the generic obligation set.
  // B1b (2026-08-01 retrieval-scope): enforce the missing-roles naming
  // invariant BEFORE the contract/route machinery reads it, so a repaired
  // (or dropped) reason is what the readiness proof and `next` are built from.
  // D8 (FX-R3c): the caller-named frontier join. Runs BEFORE the missing-roles
  // reconciliation, `attachFrontierIndex`, the contract build, `trimToCap` and
  // every booking producer, so a file the caller NAMED is inventoried, is
  // certified over, is shed by the one shedding policy, and is booked exactly
  // like any other surface. Flag-fenced inside; a flag-off pack never enters.
  applySemanticFrontierNamedFrontier(workspace, result, opts?.args, effectiveQuery);
  reconcileMissingRolesContract(result);
  semanticCheckRecords = semanticCompletionCheckRecords(result.wiring, result.surfaces);
  if (semanticCheckRecords.length > 0) {
    result.checks = semanticCheckRecords.map((check) => check.desc);
  }
  // FX-J/FX-K (2026-09-03): every booking — the edit gate's admissible union,
  // the cumulative served-surface log, the certified working set, the
  // served-range ledger and the served-pack record — happens at this
  // function's exit, from ONE `shippedSurfaces` projection over the FINAL
  // pack: after every shedding phase and after the SF pre-booking seam has had
  // its one chance to withhold a body. Unconditional since FX-K (round-15
  // finding 1 proved the pre-trim flag-off booking grants write authority over
  // bodyless-shipped files). See `finalizePackServeState`'s doc.
  const pendingBookings: PendingPackBookings = { epochTokens: [], cumulativeEligible: false };
  const cumulativeComplete = finalizePackServeState(
    workspace, result, effectiveQuery, profile, pendingBookings,
  );
  // IMPROVEMENT D: honest, machine-readable verification runnability verdict.
  attachVerificationVerdict(workspace, result);
  const workspaceInventory = computeWorkspaceInventoryState(workspace);
  result.execution_contract = contractForTrim(
    buildTaskExecutionContract(
      result,
      cumulativeComplete ? "generic" : profile,
      effectiveQuery,
      buildTaskWorkspaceState(result, workspace, workspaceInventory),
      workspace,
      false,
      servedZoomScope,
    ),
  );
  // IMPROVEMENT A part 4: a prepared edit pack with >=2 known edit sites should
  // be closed in ONE edits[] batch, not site-by-site — say so on the route.
  // Wiring packs are exempt: their writable set is the edit_frontier alone, so
  // a "batch all N sites" nudge would contradict the wiring write protocol
  // (and its presence must not depend on which wiring flow assembled the pack).
  if (result.execution_contract?.typestate.phase === "prepared" && result.wiring === undefined) {
    annotateBatchEditFrontier(result);
  }
  if (result.wiring?.strategy === "semantic-multihop") {
    // The readiness proof still needs the generic contract while it evaluates
    // the edit frontier. Once certified, wiring itself carries the same
    // handle-backed obligations, so omit only the serialized duplicate.
    result.change_contract = undefined;
  }
  if (
    result.wiring?.strategy === "semantic-multihop"
    && result.execution_contract?.typestate.phase === "prepared"
  ) {
    // The semantic frontier supersedes locator-era discovery checks. Keeping
    // those checks beside a prepared/edit-only contract gives clients two
    // contradictory next actions and reopens the follow-up loop this pack
    // already closed.
    if (semanticCheckRecords.length === 0) delete result.checks;
  }
  // FX-M Change A (TL_PACK_GUIDE_ELIDE, 2026-09-19): elide the redundant
  // TokenLighten-managed guide block BEFORE trimToCap ever runs -- every host
  // that serves one of these files already injects the identical block into
  // the model's own instructions, so shipping it again is pure duplication
  // that starves genuinely novel bytes out of the fixed cap, whether or not
  // this pack is currently over budget. Flag-gated: OFF (the default) never
  // calls this, so a served guide file's body is byte-identical to
  // pre-FX-M output.
  if (packGuideElideEnabled()) {
    applyAgentGuideElision(result);
  }
  // P2 fix (2026-09-19): mark the caller-range surfaces BEFORE trimToCap
  // runs — its own Phase B unconditionally clears `why` from every surface
  // ("drop why from all surfaces") once the pack needs enough trimming to
  // reach Phase E, so re-deriving this predicate from `why` AFTER trimToCap
  // returns (as trimToCap's OWN internal `callerRangeBodySurfaces` filter
  // does, safely, before its own Phase B) would silently match nothing. The
  // mark is a Symbol-keyed own property (sfWithholdingMarks.ts's established
  // carrier for exactly this class of problem), so it survives Phase B.
  // NARROWER than trimToCap's own `callerRangeBodySurfaces` filter on purpose
  // (measured, replayCorpus.spec.ts): "caller-supplied" is appended onto
  // several UNRELATED `why` shapes this reconciliation/bundling must not
  // touch — e.g. "anchor-focus: query-matched symbol X; caller-supplied"
  // (a symbol-anchored surface, which already carries its OWN, intentional
  // remaining/pointer semantics tied to the symbol span, not the plain
  // line-range semantics this fix assumes) and other query-driven joins.
  // `symbol === undefined` isolates the plain path+range shape this defect
  // was pinned against (server.ts's `targets[]`/`paths[]` entries with a
  // `range` and no `symbol`) without narrowing trimToCap's OWN halving
  // population, which is untouched and stays byte-identical.
  //
  // DELIBERATELY UNCHANGED by the B1 fix (2026-09-21) despite covering every
  // NAMED target, ranged or not: `isCallerRangeSurface` here feeds
  // `settleCallerRangeDelivery`/`reconcileCallerRangeRemaining`/
  // `snapshotCallerRangeSurfaces`/`applyFoldSmallRemainder` — disclosure and
  // remaining_ranges-accuracy functions, never a withholding gate — and
  // `firstPackCompleteness.spec.ts`'s "B" suite (pre-existing, unrelated to
  // this wave) proves those must keep reconciling `remaining_ranges` for ANY
  // caller-named surface: narrowing this mark left a range-less named
  // target's stale, self-contradictory `remaining_ranges` (double-booked
  // with its own whole `range`) unreconciled. The actual completeness-GATE
  // fix lives in `candidateToSurface`'s separate, narrower
  // `markExplicitRangeSurface` call (see its own doc comment) and
  // `unservedCallerRangedTargetsNext` (canonicalDecision.ts), which consumes
  // that new mark instead of this one.
  for (const surface of result.surfaces) {
    if (surface.why?.includes("caller-supplied") === true && surface.symbol === undefined) {
      markCallerRangeSurface(surface);
    }
    // TL-01 (2026-09-21): the SAME Phase-B problem, for the two provenance
    // predicates the post-contract shed tiers below re-derive from `why`
    // (`callerNamedSurface` / `explicitlyProvenanced`). They cannot use the
    // boolean mark above — it is deliberately NARROWER than either of them
    // (see its own comment) — so carry the string itself and let each keep its
    // own reviewed matching rule. See `SURFACE_PROVENANCE_KEY`.
    if (surface.why !== undefined) markSurfaceProvenance(surface, surface.why);
  }
  // WP-S7 (2026-09-20, TL_FOLD_SMALL_REMAINDER): widen a surface whose only
  // unserved lines are a small file-boundary remainder to the whole file.
  // Runs here — after the caller-range marks above (so isCallerRangeSurface
  // is authoritative) and before trimToCap/the caller-range snapshot below
  // (so a rejected or accepted widen is what both of them see; the flag-off
  // path returns immediately and this call is inert).
  applyFoldSmallRemainder(workspace, result, opts?.cache);
  // Inspect the complete focal after bounded widening, before budget admission.
  // `profile` is the classifier selection, which can be artifact_build even
  // when no required artifact sections were bound and this builder falls back
  // to the generic code pack. Gate on the pack actually built, preserving the
  // artifact route when its required sections are present.
  const genericPack = profile === "generic"
    || (profile === "artifact_build" && !hasRequiredArtifactSections(result, effectiveQuery));
  if (genericPack) await attachGoReturnedLocalReviews(codeTaskPackSurfaces(result.surfaces), workspace, opts?.cache);
  if ((profile === "generic" || profile === "change_propagation") && isEnumLikeQuery(effectiveQuery)) await attachEnumStyleReviews(codeTaskPackSurfaces(result.surfaces), workspace, effectiveQuery, opts?.cache);
  if (profile === "answer") await attachJavaLoopGuardReviews(codeTaskPackSurfaces(result.surfaces), workspace, opts?.cache);
  const deliveryVeto = writeAuthorityVeto(effectiveQuery, false, workspace);
  for (const surface of codeTaskPackSurfaces(result.surfaces)) {
    const action = result.change_contract?.obligations.find(row => row.path === surface.path && row.handle === surface.handle)?.action;
    recordBudgetDeferredSurface(result, {path: surface.path, handle: surface.handle, range: surface.range,
      action: action === "review" || deliveryVeto.reasonFor(surface.path, surface.why) !== undefined ? "review" : "edit",
      evidenceRequired: isRequiredEnumReview(surface.why)});
  }
  // Requirement 1 (P3 correction): snapshot every marked surface's body
  // BEFORE trimToCap can touch it, so reconciliation can tell "trimToCap
  // changed this body" from "trimToCap left it exactly as constructed" and
  // touch only the former.
  // Semantic wiring replaces the locator surfaces after the early dedupe pass.
  // Reuse only proven same-task bodies on those new objects before budgeting:
  // stripping them at the exit is too late to make room for the next page.
  if (!forceServePack && result.wiring?.strategy === "semantic-multihop") {
    applyPackDedupe(workspace, result, opts?.args?.taskBinding, dedupExempt);
  }
  priorBodyRestoration.strip(codeTaskPackSurfaces(result.surfaces), forceServePack);
  const callerRangePreTrim = snapshotCallerRangeSurfaces(result);
  // Surfaces added AFTER the early residency pass above (the readiness-
  // falsification counterexample, closure retries) get the same residency
  // check BEFORE the trim ladder spends the byte budget on them: a resident
  // counterexample that is only demoted by the late pass further down has
  // already crowded a caller-requested window out of the pack by then
  // (servedRangeBookingHonesty, VS Code config, 2026-09-28). Idempotent over
  // surfaces the early pass already handled (no `code` left to strip).
  if (!forceServePack) {
    applyResidentFileDedup(workspace, result, tokenizeForEpoch(effectiveQuery), { allowRequiredDedup: profile === "answer", ...(dedupExempt ? { exempt: dedupExempt } : {}) });
  }
  // TL_PACK_CONTAINMENT_DEDUP (2026-10-19, default ON): a row inside another
  // row of the same file ships once — see `applyPackContainmentDedup`. Last
  // before the trim ladder, so it sees every surface the passes above added
  // and the bytes it frees go back to `trimToCap`. Inside the same
  // `force_serve` guard as `applyPackDedupe`'s intra-pack half.
  if (!forceServePack && packContainmentDedupEnabled()) {
    applyPackContainmentDedup(result, workspace, {
      ...(opts?.protectedSurfaces !== undefined ? { protectedSurfaces: opts.protectedSurfaces } : {}),
      ...(dedupExempt !== undefined ? { exempt: dedupExempt } : {}),
      ...(opts?.cache !== undefined ? { cache: opts.cache } : {}),
    });
  }
  const trimmed = trimToCap(
    result,
    opts?.protectedSurfaces,
    prefetchedCallerNamedArtifacts(workspace),
  );
  // Retry the bounded fold after internal envelope compaction, before final
  // settlement/certification. Only the final emitted body enters the ledger.
  applyFoldSmallRemainder(workspace, trimmed, opts?.cache);
  // Settle caller-ranged remaining/coverage against what trimToCap actually
  // shipped — see reconcileCallerRangeRemaining's own doc comment above for
  // the pinned defect this closes.
  reconcileCallerRangeRemaining(trimmed, workspace, callerRangePreTrim, opts?.cache);
  // TL-01 (2026-09-21): and then state `U = R − S` against the bodies
  // themselves, not against the snapshot. `reconcileCallerRangeRemaining` above
  // deliberately touches ONLY surfaces trimToCap changed; a caller-ranged
  // surface whose body was already short of the caller's window when it was
  // CONSTRUCTED is therefore settled by nobody. Widening-only and idempotent
  // (see its own doc comment), and re-run after the post-contract shed tiers
  // below, which are the only later stage that can shrink a body.
  settleCallerRangeDelivery(trimmed, workspace, opts?.cache);
  // DESIGN-v0.9 §4.3 post-trim recompute: a whole-surface drop that FLIPS
  // coverage invalidates the next/route computed against the fuller pre-trim
  // pack (the classic stale "you're done" next on a now-partial pack).
  // IMPROVEMENT A: a cumulative-coverage flip (coverage_basis:"cumulative") is a
  // DELIBERATE partial->complete promotion the recompute must not undo — it
  // recomputes route/next from the pre-cumulative `missingRequired`, which would
  // resurrect the very locate_missing_surfaces route cumulative coverage closes.
  if (
    opts?.recompute !== undefined
    && trimmed.coverage !== coverageBefore
    && trimmed.coverage_basis === undefined
  ) {
    recomputeRouteAndNextAfterTrim(trimmed, opts.recompute);
  }
  // DESIGN-v0.9 §4.4 rollup: stamped BEFORE annotateSpannedRoots so its
  // fitsInCap accounting sheds the advisory `roots`/route-suffix first under
  // any residual byte pressure (content_completeness is load-bearing honesty,
  // never shed).
  stampRollupContentCompleteness(trimmed);
  reconcileTaskChangeContract(trimmed);
  reconcileContentSufficiency(trimmed, workspace);
  if (
    profile === "answer"
    && (
      // R3 (2026-08-01, B1d completion): the answer_resolution arm is now
      // gated on its (post-B1d honest) matched_facets covering every
      // requested facet — an answer_resolution whose evidence covers only
      // SOME of the queried behaviors must not delete `next` and pin the
      // call budget to 0 over the uncovered rest (the T03 contradiction in
      // its second form). Facet-less queries keep the old behavior: no
      // requested facets means nothing to be uncovered.
      (
        trimmed.answer_resolution !== undefined
        && requiredQueryFacets(effectiveQuery).every((facet) =>
          (trimmed.answer_resolution?.matched_facets ?? []).some((m) =>
            m.toLowerCase() === facet.toLowerCase()))
      )
      // B1d (2026-08-01 retrieval-scope): THIS is the branch that deletes
      // `next`/`continuation` and pins max_additional_tl_calls to 0 on an
      // answer pack. Claiming "every requested behavior facet is bundled" while
      // a facet's own call sites sit unserved in remaining_ranges is exactly
      // the T03 contradiction — `workspace` is what makes the claim checkable.
      || hasExactNamedAnswerFacetEvidence(trimmed, effectiveQuery, workspace)
    )
  ) {
    // The answer's named target and every requested behavioral facet are
    // already served. Preserve the surface-level partial stamp (the whole
    // large class is intentionally not dumped), but do not reopen discovery
    // merely to fetch unrelated members from that class.
    delete trimmed.content_sufficiency;
    delete trimmed.blocking_next_steps;
    delete trimmed.next;
    delete trimmed.continuation;
    trimmed.route = {
      action: "answer_from_handles",
      reason: "named implementation and requested behavior facets are bundled",
      max_additional_tl_calls: 0,
    };
  }
  // A1 (2026-07-30): an ANSWER pack whose evidence IS caller-named artifact
  // content has nothing left to locate — the inlined sections are the answer's
  // source. buildRoute's zero-code-surface branch labels it "no editable handles
  // returned", which with 0 remaining discovery calls certifies
  // `request-user-input` while the pack holds the exact content the request asked
  // about (T14 two-deck audit). Gated on every caller-named artifact carrying a
  // MEANINGFUL section (hasRequiredArtifactSections) and on `missing` being empty,
  // so a genuinely incomplete pack still routes to discovery.
  if (
    profile === "answer"
    && codeTaskPackSurfaces(trimmed.surfaces).length === 0
    && (trimmed.artifact_sections?.length ?? 0) > 0
    && trimmed.missing.length === 0
    && hasRequiredArtifactSections(trimmed, effectiveQuery)
  ) {
    delete trimmed.content_sufficiency;
    delete trimmed.blocking_next_steps;
    delete trimmed.next;
    delete trimmed.continuation;
    trimmed.route = {
      action: "answer_from_handles",
      reason: "every caller-named artifact source is inlined content-bearing",
      max_additional_tl_calls: 0,
    };
  }
  if (
    profile === "wiring"
    && trimmed.wiring?.status === "ready"
    && (
      trimmed.change_contract?.status === "ready"
      || trimmed.wiring.strategy === "semantic-multihop"
    )
    && trimmed.route === undefined
  ) {
    // trimToCap may shed advisory route text before the final proof is rebuilt.
    // A proved wiring frontier still needs its terminal action reconstructed;
    // otherwise the same evidence is mislabeled awaiting-input.
    trimmed.route = {
      action: "edit_from_handles",
      reason: "proved wiring consumer and insertion frontier",
      max_additional_tl_calls: 0,
    };
  }
  if (
    profile !== "answer"
    && binding.requested !== "auto"
    && binding.requested !== "answer"
    && trimmed.route?.action === "answer_from_handles"
  ) {
    // Post-trim route recomputation sees only the raw query and can otherwise
    // resurrect a lexical answer route after a structured change declaration.
    trimmed.route = {
      action: "edit_from_handles",
      reason: `caller-declared ${profile} change profile — structural readiness proved separately`,
      max_additional_tl_calls: 0,
    };
  }
  if (trimmed.route?.action === "answer_from_handles") {
    // Recursive closure and post-trim route repair run after the early answer
    // purification pass. Reassert the answer invariant at the finalizer so a
    // stale edit-style `next` can never be folded into a discovery contract.
    delete trimmed.next;
    delete trimmed.continuation;
  }
  // Persist same-epoch role/concern evidence before the final certificate is
  // evaluated. A continuation may legitimately serve a different frontier;
  // the ledger must see the union it already served, not only this body.
  reconcileEpochTaskContract(workspace, trimmed, effectiveQuery, profile);
  // A resolved create target is the terminal frontier. Post-trim route
  // recomputation sees zero editable surfaces for a not-yet-existing file and
  // can restore `locate_missing_surfaces`; reassert the create route BEFORE
  // rebuilding the contract so its prepared certificate agrees with the
  // executable edit next_call (the later assertion preserves wire guidance).
  assertCreateRoute(trimmed, profile, workspace);
  trimmed.execution_contract = buildTaskExecutionContract(
    trimmed,
    // IMPROVEMENT A: a cumulative-complete pack certifies as a generic
    // surface-content proof (the role-specific structure was proven across the
    // earlier calls) — the FINAL rebuild must honor that too, else a non-generic
    // profile's role obligations reopen the contract this pack already closed.
    cumulativeComplete && trimmed.coverage_basis === "cumulative" ? "generic" : profile,
    effectiveQuery,
    buildTaskWorkspaceState(trimmed, workspace, workspaceInventory),
    workspace,
    false,
    servedZoomScope,
  );
  reconcileTaskPackExecutionContract(trimmed);
  if (
    trimmed.wiring?.strategy === "semantic-multihop"
    && trimmed.execution_contract?.typestate.phase === "prepared"
  ) {
    // Re-apply after trim/reconciliation because both can rebuild the final
    // contract. A prepared semantic response exposes one authoritative
    // pre-edit instruction: execute the certified frontier.
    if (semanticCheckRecords.length === 0) delete trimmed.checks;
  }
  if (
    trimmed.execution_contract?.readiness === "answer-ready"
    || trimmed.execution_contract?.call_budget?.discovery_allowed === false
  ) {
    delete trimmed.next;
    delete trimmed.continuation;
  }
  // After the last pass that can strip a planned sweep (the answer-ready /
  // exhausted-budget deletion above) — an earlier annotate call read
  // continuation state that no longer reached the wire.
  annotateUnsweptWiringEndpoints(trimmed);
  // TL-01: set by `shedSurface` below whenever it actually reduces or removes a
  // body, so the post-shed re-derivation runs exactly when a surface changed
  // after the contract was first built — and never on a pack the tiers left
  // byte-identical (which stays byte-identical on the wire too).
  let shedMutatedSurfaces = false;
  // R2-T1 (eval-0929 review P0-3/P1-1): the certificate every tier below is
  // judged against — see `ceilingCertificationSnapshot`'s section header.
  // Before the first compaction, which drops the per-obligation evidence.
  const ceilingCertification = fitsInCapUncompacted(trimmed)
    ? undefined
    : ceilingCertificationSnapshot(trimmed, workspace);
  let ceilingDemoted = false;
  // The first rung admits the FULL contract (its capability gaps among it) only
  // while the pack also fits with its `next` restated -- see
  // `fitsInCapUncompacted`; the rungs after it judge what ships.
  if (!fitsInCapUncompacted(trimmed) && trimmed.execution_contract) {
    // Preserve authoritative typestate when the rich proof payload is the
    // only thing pushing an otherwise valid pack over its byte cap. Dropping
    // execution_contract entirely recreates the exact ambiguity the contract
    // is meant to eliminate (observed on T10 after inlining the DOCX section).
    // The compact form retains phase/certificate/allowed actions and the one
    // bounded next_call, while shedding duplicated proof evidence.
    trimmed.execution_contract = contractForTrim(trimmed.execution_contract);
  }
  if (!fitsInCap(trimmed) && trimmed.execution_contract) {
    // Certificate ids commit to the full proof, so remove duplicated proof
    // narration before sacrificing source evidence needed to review the edit.
    trimmed.execution_contract = contractForEvidenceRetention(trimmed.execution_contract);
  }
  if (!fitsInCap(trimmed) && trimmed.execution_contract) {
    // Prefer the authoritative typestate over advisory review surfaces only
    // after both proof-compaction levels have been exhausted. The edit
    // endpoints and every explicitly required surface remain protected.
    const protectedHandles = new Set([
      trimmed.wiring?.connections[0]?.source?.handle,
      trimmed.wiring?.connections[0]?.destination?.handle,
    ].filter((handle): handle is string => handle !== undefined));
    const codeBytesOf = (surface: TaskPackSurface): number =>
      Buffer.byteLength(surface.code ?? surface.code_unchanged ?? "", "utf8");
    /**
     * The three markers that make a surface's presence the CALLER's own doing.
     *
     * TL-01 (2026-09-21): callers pass `surfaceProvenance(surface)`, never
     * `surface.why` — `trimToCap`'s Phase B has already run by the time this
     * tier does and clears `why` from EVERY surface, so a raw `why` read here
     * was unconditionally `undefined` and this predicate (and
     * `callerNamedSurface` below) silently matched nothing.
     */
    const explicitlyProvenanced = (why: string | undefined): boolean =>
      why !== undefined
      && (why.includes("caller-supplied")
        || why.includes("query-named-file")
        || why.includes("header-source-pair"));
    /**
     * Drop ONE surface and re-derive everything that named it. `discloseAlways`
     * is the required tier below: a surface the pack itself marked `required`
     * is never dropped silently, whatever its provenance.
     */
    /**
     * WP-P2 B (2026-09-20) -- DEFECT, unconditional. True when one of `why`'s
     * own `;`-separated segments says the CALLER spelled THIS path.
     * Deliberately segment-EXACT where `explicitlyProvenanced` above is a
     * substring test: `caller-supplied-dir` (a locator pick from inside a
     * directory the caller named) and `header-source-pair` (a derived sibling)
     * both contain a marker, but they are this server's choices, not paths the
     * caller asked for, and they stay droppable exactly as before.
     */
    const callerNamedSurface = (why: string | undefined): boolean =>
      why !== undefined
      && why.split(";").some((segment) => {
        const marker = segment.trim();
        return marker === "caller-supplied" || marker === "query-named-file";
      });
    /**
     * WP-P2 B -- reduce a caller-named surface's BODY by at least `needed`
     * bytes, keeping its leading lines (and an honest `remaining_ranges`)
     * whenever any of them survive. Same shape as `trimToCap`'s own Phase E
     * ladder, whose whole point is that the surface, its role and its HANDLE
     * outlive their embedded code. Returns false only when there is no body
     * left to take, which is the one case the caller may still remove.
     */
    const reduceCallerNamedBody = (surface: TaskPackSurface, needed: number): boolean => {
      const code = surface.code;
      if (code === undefined) return false;
      const lines = code.split("\n");
      let kept = lines.length;
      let freed = 0;
      while (kept > 0 && freed < needed) {
        kept -= 1;
        freed += Buffer.byteLength(lines[kept]!, "utf8") + 1;
      }
      surface.code = kept > 0 ? `${lines.slice(0, kept).join("\n")}\n` : undefined;
      surface.content_completeness = "partial";
      // State the remainder PRECISELY. `trimToCap`'s own Phase E stamps the
      // whole range and relies on `reconcileCallerRangeRemaining` to narrow it
      // afterwards -- but that pass has already run by the time this tier
      // does, so a whole-range claim written here would reach the wire as is
      // (measured: a 374-line file served to line ~234 advertised
      // `remaining:["1-374"]`, i.e. "re-read all of it"). The kept body is a
      // whole-line PREFIX of the display text, so the same display-line
      // accounting the reconciler uses gives the source line it now reaches.
      const requested = parsePackLineRange(surface.range);
      if (requested !== undefined) {
        const [requestedStart, requestedEnd] = requested;
        const deliveredEnd = surface.code === undefined
          ? requestedStart - 1
          : sourceLineAfterDisplayLines(
              requestedStart,
              callerRangeElisionWindows(workspace, surface.path, requestedStart, requestedEnd),
              displayLineCount(surface.code),
              requestedEnd,
            );
        if (deliveredEnd < requestedEnd) {
          surface.remaining_ranges = mergeRangeStrings([
            `${deliveredEnd + 1}-${requestedEnd}`,
            ...(surface.remaining_ranges ?? []),
          ]);
        }
      }
      return true;
    };
    const shedSurface = (surface: TaskPackSurface, discloseAlways: boolean): void => {
      const index = trimmed.surfaces.findIndex((candidate) => candidate.handle === surface.handle);
      if (index < 0) return;
      // WP-P2 B -- THE DEFECT THIS CLOSES. `trimToCap` above honours
      // `protectedSurfaces`: a caller-named seed may lose its code there, never
      // its row (`MAX_SEEDED_CODE_SURFACES`'s own doc: "never dropping one,
      // whatever the byte budget does to its embedded code"). This tier runs
      // AFTER it, re-derives its own protection from the wiring endpoints
      // alone, and so removed a caller-named path outright -- measured on a
      // live GitHub Copilot shape naming nine files: the pack FIT at
      // `trimToCap`, the contract/readiness passes between then and here
      // inflated it 1,224 bytes past the cap, and this loop paid for that by
      // deleting the single LARGEST caller-named body (9,387 bytes). The v1
      // wire carries no `missing`, so the file vanished with no row, no
      // `remaining` and no disclosure, and the caller re-read it natively.
      //
      // Take only the bytes the overflow actually needs, from the body, and
      // leave the addressable row behind. A caller-named path with nothing
      // left to give falls through to the removal below, exactly as before.
      if (callerNamedSurface(surfaceProvenance(surface))) {
        const overflow = packWireBytes(trimmed) - capForResult(trimmed);
        if (overflow > 0 && reduceCallerNamedBody(surface, overflow + SHED_REDUCTION_SLACK_BYTES)) {
          shedMutatedSurfaces = true;
          return;
        }
      }
      const deferredAction = trimmed.change_contract?.obligations.find(row => row.path === surface.path && row.handle === surface.handle)?.action;
      const reviewOnly = writeAuthorityVeto(effectiveQuery, false, workspace).reasonFor(surface.path, surface.why) !== undefined;
      recordBudgetDeferredSurface(trimmed, {path: surface.path, handle: surface.handle, range: surface.range,
        action: deferredAction === "edit" && !reviewOnly ? "edit" : "review",
        evidenceRequired: isRequiredEnumReview(surface.why)});
      trimmed.surfaces.splice(index, 1);
      shedMutatedSurfaces = true;
      if (discloseAlways || explicitlyProvenanced(surfaceProvenance(surface))
        || isRequiredEnumReview(surface.why)) {
        // Never silently drop an explicitly requested file (or a query-named /
        // pair-contract enrichment surface): the caller cannot tell "trimmed
        // for byte budget" apart from "does not exist", and the observed
        // fallback is a native read of exactly that path.
        trimmed.missing = [...new Set([
          ...trimmed.missing,
          // Canonical vocabulary only (2026-09-19 P2/F5 fix): the legacy
          // `paths=[…]` alternative this used to advertise needs
          // TL_LEGACY_INPUT=accept and must never be minted (AGENTS.md).
          // `targets=[{handle:...}]` matches canonicalDecision.ts's
          // `unservedCallerRangedTargetsNext`, which parses this exact shape
          // to re-bundle a wholly-dropped caller-named surface.
          `dropped-by-byte-budget:${surface.path} (re-request via tl_read_file targets=[{handle:"${surface.handle}"}])`,
        ])];
      }
      const servedHandles = new Set(trimmed.surfaces.map((candidate) => candidate.handle));
      if (trimmed.wiring) {
        trimmed.wiring.edit_frontier = trimmed.wiring.edit_frontier.filter((handle) => servedHandles.has(handle));
        trimmed.wiring.review_frontier = trimmed.wiring.review_frontier.filter((handle) => servedHandles.has(handle));
        for (const connection of trimmed.wiring.connections) {
          connection.supporting_handles = connection.supporting_handles.filter((handle) => servedHandles.has(handle));
        }
      }
      if (trimmed.change_contract) {
        trimmed.change_contract = buildTaskChangeContract(effectiveQuery, trimmed, workspace);
        reconcileTaskChangeContract(trimmed);
      }
    };
    /**
     * R2-T1: would withdrawing `surface` break a citation of the certificate
     * this pack was minted with (`wouldIntroduceBreach`, WP-B's prevention)?
     * Always false for a pack with nothing certified to protect.
     */
    const withdrawalBreaksCertificate = (surface: TaskPackSurface): boolean =>
      ceilingCertification !== undefined
      && wouldIntroduceBreach(
        ceilingCertification.citations,
        ceilingCertification.certifiedSpans,
        packServedSpans(trimmed),
        packServedSpans({ ...trimmed, surfaces: trimmed.surfaces.filter((candidate) => candidate !== surface) }),
      );
    // Already-incomplete caller windows will need a continuation anyway.
    // Move only their exact tail before surrendering complete ready evidence.
    if (trimmed.execution_contract?.typestate.phase !== "prepared") {
      const partialBodies = codeTaskPackSurfaces(trimmed.surfaces)
        .filter(surface => surface.content_completeness === "partial"
          && (surface.code?.length ?? 0) > 0 && callerNamedSurface(surfaceProvenance(surface))
          && !protectedHandles.has(surface.handle) && !withdrawalBreaksCertificate(surface))
        .sort((a, b) => codeBytesOf(b) - codeBytesOf(a));
      for (const surface of partialBodies) {
        if (fitsInCap(trimmed)) break;
        const overflow = packWireBytes(trimmed) - capForResult(trimmed);
        if (overflow > 0 && reduceServedBodyTail(surface, overflow + SHED_REDUCTION_SLACK_BYTES, workspace, opts?.cache)) shedMutatedSurfaces = true;
      }
    }
    const optional = codeTaskPackSurfaces(trimmed.surfaces)
      .filter((surface) => surface.required !== true && !protectedHandles.has(surface.handle))
      .sort((a, b) => codeBytesOf(b) - codeBytesOf(a));
    for (const surface of optional) {
      if (fitsInCap(trimmed)) break;
      // R2-T1 PREVENTION: an optional surface the certificate cites is not
      // "evidence nothing required" — it is the evidence (measured: the whole
      // 300-line focal body of eval-0929 review P0-3 went here, largest first).
      if (withdrawalBreaksCertificate(surface)) continue;
      shedSurface(surface, false);
      if (fitsInCap(trimmed)) break;
    }
    // R2-T1: still over, and every remaining surface is cited evidence (or
    // required). No response under this cap carries both the certificate and
    // its evidence, so keep the EVIDENCE: reduce bodies from the tail until
    // the pack fits, and let the invariant turn the certificate into
    // `discover` with the read that restores what was cut
    // (`enforceCeilingCertificateInvariant`, below and at the exit). Order: a
    // body whose withdrawal breaks no citation AND that alone covers the
    // overflow goes first (lossless for the certificate); otherwise the
    // largest body, so the cut costs one surface a tail instead of wiping
    // small rows that cannot cover it. Rows, handles and `remaining_ranges`
    // stay, so GATE-A below and the fallback are reached only when no body is
    // left to give.
    if (!fitsInCap(trimmed) && ceilingCertification !== undefined) {
      const needed = packWireBytes(trimmed) - capForResult(trimmed) + SHED_REDUCTION_SLACK_BYTES;
      const bodies = codeTaskPackSurfaces(trimmed.surfaces)
        .filter((surface) => (surface.code?.length ?? 0) > 0 && !protectedHandles.has(surface.handle))
        .map((surface) => {
          const bytes = codeBytesOf(surface);
          return { surface, bytes, lossless: bytes >= needed && !withdrawalBreaksCertificate(surface) };
        })
        .sort((a, b) => Number(b.lossless) - Number(a.lossless) || b.bytes - a.bytes);
      for (const { surface } of bodies) {
        const overflow = packWireBytes(trimmed) - capForResult(trimmed);
        if (overflow <= 0) break;
        if (reduceServedBodyTail(surface, overflow + SHED_REDUCTION_SLACK_BYTES, workspace, opts?.cache)) {
          shedMutatedSurfaces = true;
        }
      }
    }
    // GATE-A (2026-09-14) — THE LAST DISCLOSED TIER: one required surface is
    // shed before the WHOLE PACK is.
    //
    // MEASURED, not reasoned (cumulativeReissueReceipt's F-B2 fixture, this
    // wave): a pack of SEVEN required surfaces came in 533 bytes over a 32,768
    // cap. Nothing was optional, so the pass above dropped nothing, and the
    // emergency envelope below — whose whole job is to keep the response under
    // the cap — threw away six of the seven surfaces and demoted a `prepared`
    // certificate to `discovery`. A 1.6% overflow costing 86% of the evidence
    // is not a budget decision, it is a cliff.
    //
    // The condition became reachable when TL142-05 stamped a QUERY-NAMED file
    // `required: true` (rightly — an explicitly named path must survive), which
    // also made the pass above's own `query-named-file` disclosure arm dead
    // code for that class. This tier restores it: the surface still goes, but
    // as ONE disclosed drop instead of six silent ones.
    //
    // THE ORDER IS WEAKEST-FIRST, TWICE OVER, so the pack gives up as little as
    // it can: surfaces the CALLER did not name go before ones it did (TL142-05's
    // "explicit paths first", the same tie-break `capExtraEvidenceRelativeTo
    // NamedPaths` states), and within each tier the SMALLEST body goes first —
    // the opposite of the optional pass above, and deliberately: there the goal
    // is to free the most bytes from evidence nothing required, here it is to
    // surrender the least evidence that still gets under the cap.
    //
    // FLOOR: two surfaces. Below that the emergency envelope is the right
    // shape (it rebuilds the route, the contract and the bounded continuation
    // around a single retained handle), so this tier never races it to one.
    if (!fitsInCap(trimmed)) {
      const requiredTier = [false, true].flatMap((explicit) =>
        codeTaskPackSurfaces(trimmed.surfaces)
          // TL-01 (2026-09-21): `surfaceProvenance`, for the same reason the
          // two predicates' own doc comments now give — Phase B has cleared
          // `why` by the time this tier runs, so the `[false, true]` split
          // silently put EVERY surface in the first bucket and this tier's
          // stated "surfaces the CALLER did not name go before ones it did"
          // order never happened. Measured on `cumulativeReissueReceipt.spec.ts`'s
          // aeroctl fixture (6 surfaces, 2 shed): restoring it selects the
          // same two surfaces there, so no pinned shed set moves on the
          // evidence available; it only makes the documented tie-break real
          // for a pack whose provenance classes actually differ in size order.
          .filter((surface) =>
            !protectedHandles.has(surface.handle)
            && explicitlyProvenanced(surfaceProvenance(surface)) === explicit)
          .sort((a, b) => codeBytesOf(a) - codeBytesOf(b)));
      for (const surface of requiredTier) {
        if (fitsInCap(trimmed) || trimmed.surfaces.length <= 2) break;
        shedSurface(surface, true);
      }
    }
  }
  // -------------------------------------------------------------------------
  // TL-01 (2026-09-21) — THE ONE POST-MUTATION DERIVATION.
  //
  // The shed tiers above are the LAST stage of this function that can shrink or
  // remove a served body, and they run AFTER `buildTaskExecutionContract`
  // (whose `partialFallback`/`firstUnservedPartialRange` chain mints
  // `next_call` straight out of `remaining_ranges`). Before this block nothing
  // re-derived either, so a pack that reached them shipped a `next` computed
  // against bodies that no longer existed — measured on the plan-0143 §4 repro:
  // two caller-ranged targets, one of them shed here entirely, `missing[]`
  // saying it was 0 % served and `decision.next` asking only for its TAIL.
  //
  // So: settle `remaining_ranges` against the bodies that ACTUALLY SHIP, then
  // rebuild the contract from that settled state. Bounded by construction —
  // exactly one rebuild, then the same two contract-compaction rungs the first
  // build already gets, and then the proof-preserving fallback below, which is
  // itself cap-asserted. No pass here can shed another body, so the fixpoint
  // cannot oscillate.
  // -------------------------------------------------------------------------
  if (shedMutatedSurfaces) {
    settleCallerRangeDelivery(trimmed, workspace, opts?.cache);
    trimmed.execution_contract = buildTaskExecutionContract(
      trimmed,
      cumulativeComplete && trimmed.coverage_basis === "cumulative" ? "generic" : profile,
      effectiveQuery,
      buildTaskWorkspaceState(trimmed, workspace, workspaceInventory),
      workspace,
      false,
      servedZoomScope,
    );
    reconcileTaskPackExecutionContract(trimmed);
    // R2-T1: the re-derivation above re-judges each obligation over what is
    // left, with evaluators that accept surrogates (see the section header of
    // `ceilingCertificationSnapshot`). A certificate that lost cited lines
    // does not stand on them — and the smaller discovery contract is what the
    // cap is then measured against, so the fallback is not reached for it.
    if (ceilingCertification !== undefined) {
      ceilingDemoted = enforceCeilingCertificateInvariant(trimmed, ceilingCertification, workspace, false) || ceilingDemoted;
    }
    if (!fitsInCapUncompacted(trimmed) && trimmed.execution_contract) {
      trimmed.execution_contract = contractForTrim(trimmed.execution_contract);
    }
    if (!fitsInCap(trimmed) && trimmed.execution_contract) {
      trimmed.execution_contract = contractForEvidenceRetention(trimmed.execution_contract);
    }
  }
  if (!fitsInCap(trimmed)) {
    // Every rich trim pass failed. Preserve one concrete piece of evidence and
    // the exact read-only continuation that can expand it; never turn an
    // internal byte budget into a user decision, and never bless an empty pack
    // as a terminal answer.
    const retained = trimmed.surfaces[0];
    assertTaskPackConstructionInvariant(
      retained !== undefined,
      "byte-budget fallback has no evidence surface",
    );
    /** The proof-preserving envelope around `retained` as it stands now (re-run after each body reduction below). */
    const buildFallback = (): TaskPackResult => {
      const next: ToolCall = isArtifactTaskPackSurface(retained)
        ? { tool: "tl_read_file", arguments: { mode: "artifact", handle: retained.handle } }
        : {
            tool: "tl_read_file",
            arguments: {
              mode: "slice",
              handle: retained.handle,
              range: retained.remaining_ranges?.[0] ?? retained.range,
            },
          };
      const fallback: TaskPackResult = {
        mode: "task_pack",
        coverage: "partial",
        coverage_reason: "missing-roles",
        surfaces: [retained] as TaskPackSurface[],
        missing: trimmed.missing.slice(0, 3),
        ...(trimmed.task_profile === undefined ? {} : { task_profile: trimmed.task_profile }),
        // W9 follow-up (2026-08-22): `trimmed.create_target` must survive onto
        // this rebuilt envelope. Before this, a create pack that overflowed the
        // byte cap lost create_target here (this object never carried it), so
        // the assertCreateRoute call below no-op'd on its early-return guard and
        // the response fell back to a plain "inspect this one retained surface"
        // discovery envelope for a file that does not exist yet.
        ...(trimmed.create_target === undefined ? {} : { create_target: trimmed.create_target }),
        route: {
          action: "inspect_handles",
          reason: "byte budget retained one evidence surface; expand only its bounded continuation",
          max_additional_tl_calls: 1,
        },
        next,
      };
      // W9 follow-up: re-assert the create route BEFORE any of the passes below
      // (reconcile/contract/decision) so — mirroring the un-trimmed pack's own
      // "assertCreateRoute before rebuilding the contract" ordering just above —
      // buildReadinessObligations' provedCreate sees a coherent create-route
      // envelope (missing=[], route=edit_from_handles) at contract-build time
      // and certifies "prepared" here exactly as it does for the un-trimmed
      // pack, instead of the single retained sibling being judged a codeless/
      // uncovered edit target.
      assertCreateRoute(fallback, profile, workspace);
      // B1b (2026-08-01 retrieval-scope): this fallback keeps exactly ONE surface
      // and stamps `missing-roles` unconditionally — so when `trimmed.missing`
      // was empty it shipped the T09 shape verbatim (`partial` + `missing-roles`
      // + `missing:[]`, one surface for a twelve-path request, nothing said about
      // the other eleven). Both invariants apply here BEFORE the contract is
      // built: name the roles the label is asserting, and disclose the
      // caller-named paths this shed away. A no-op on the create-route path
      // above (coverage_reason is already "single-site", not "missing-roles").
      reconcileMissingRolesContract(fallback);
      reconcileCallerPathCoverage(fallback, opts?.args, workspace);
      discloseUnservedQualifiedAnchorDefinition(fallback, effectiveQuery, workspace);
      // This envelope is the last thing standing between the caller and a hard
      // invariant throw below, so keep the disclosure list at the same bounded
      // size the pre-B1b fallback shipped.
      fallback.missing = fallback.missing.slice(0, MAX_FALLBACK_MISSING_ENTRIES);
      fallback.execution_contract = buildTaskExecutionContract(
        fallback,
        profile,
        effectiveQuery,
        buildTaskWorkspaceState(fallback, workspace, workspaceInventory),
        workspace,
        false,
        servedZoomScope,
      );
      // P0a §6.1: this envelope returns BEFORE the shared exit below, so it must
      // run the same canonical projection itself — otherwise the last envelope
      // standing between the caller and a hard invariant throw is the one exit
      // that never proved route/contract/continuation agree. Applied before the
      // cap assertion so any continuation it stamps is inside the measured size.
      applyCanonicalTaskDecision(fallback);
      // R2-T1: this envelope keeps ONE surface of a pack whose certificate was
      // minted over more; it is held to the same invariant as the tiers above
      // (`force`: its own `next` expands only the one surface it kept, never
      // the cited evidence it dropped).
      if (ceilingCertification !== undefined) {
        enforceCeilingCertificateInvariant(fallback, ceilingCertification, workspace, true);
      }
      // This rebuilt envelope did not pass through the normal post-trim rollup.
      // Preserve the wire-visible truncation marker before compacting metadata.
      stampRollupContentCompleteness(fallback);
      if (!fitsInCap(fallback) && !isArtifactTaskPackSurface(retained)) {
        // The rebuilt canonical contract can add structural bytes after
        // trimToCap's last fit check. Re-enter only its advisory rungs, in the
        // same order, while retaining the body/address, canonical ToolCall, and
        // execution proof. Stop as soon as the response fits.
        if (retained.outline !== undefined) delete retained.outline;
        if (!fitsInCap(fallback) && retained.facts !== undefined) delete retained.facts;
        if (!fitsInCap(fallback) && retained.why !== undefined) delete retained.why;
        if (!fitsInCap(fallback) && retained.likely_edits !== undefined) delete retained.likely_edits;
        if (!fitsInCap(fallback) && retained.edit_intent !== undefined) delete retained.edit_intent;
        if (!fitsInCap(fallback) && retained.done_check !== undefined) delete retained.done_check;
      }
      if (!fitsInCap(fallback) && fallback.continuation !== undefined && fallback.next !== undefined) {
        const planned = deriveNextFromPlan(fallback.continuation);
        if (planned !== undefined && JSON.stringify(planned) === JSON.stringify(fallback.next)) {
          // The canonical `next` and contract `next_call` remain executable and
          // proof-bound; this plan wrapper is only a byte-for-byte duplicate.
          delete fallback.continuation;
        }
      }
      if (!fitsInCap(fallback) && fallback.execution_contract !== undefined) {
        fallback.execution_contract = contractForTrim(fallback.execution_contract);
      }
      if (!fitsInCap(fallback) && fallback.execution_contract !== undefined) {
        fallback.execution_contract = contractForEvidenceRetention(fallback.execution_contract);
      }
      return fallback;
    };
    let fallback = buildFallback();
    // R2-T1 (eval-0929 review P1-1): the one retained body can itself be
    // larger than the cap (measured: a 160-branch function under the VS Code
    // 14,336-byte ceiling — every rung above ran and the assertion below threw
    // a JSON-RPC -32603). Shrink THAT body from the tail, keeping its row,
    // handle and an honest `remaining_ranges`, and rebuild the envelope around
    // what is left — its `next` then reads the rest. Bounded: each round frees
    // at least the measured overflow, and a body with nothing left to give
    // ends the loop.
    for (
      let attempt = 0;
      attempt < MAX_FALLBACK_BODY_REDUCTIONS && !fitsInCap(fallback) && !isArtifactTaskPackSurface(retained);
      attempt += 1
    ) {
      const overflow = packWireBytes(fallback) - capForResult(fallback);
      if (!reduceServedBodyTail(retained, overflow + SHED_REDUCTION_SLACK_BYTES, workspace, opts?.cache)) break;
      fallback = buildFallback();
    }
    assertTaskPackConstructionInvariant(
      fitsInCap(fallback),
      "proof-preserving byte-budget fallback exceeds cap",
    );
    // W3: the create route is the final word even on the proof-preserving
    // fallback (its next is the edit action, not a dropped discovery call).
    assertCreateRoute(fallback, profile, workspace);
    // W2: bound the guidance-metadata inventory at ANY pack size.
    capGuidanceMetadata(fallback);
    persistPackFingerprints(workspace, fallback, opts?.args?.taskBinding);
    // FX-J/FX-K: this EARLY exit ships `fallback` and never reaches the seam,
    // so nothing was withheld — but the bookings must still land, or a surface
    // this response really served would be missing from the epoch's admissible
    // union (the T09 "the gate refused handles this server itself had served"
    // class). It is the SAME single pass, so `fallback` — not the pre-trim
    // list — is what it books. The certified working set is deliberately left
    // untouched here, exactly as it was before FX-J.
    bookShippedPackServeState(
      workspace,
      fallback,
      effectiveQuery,
      pendingBookings,
      undefined,
      opts?.args !== undefined ? { args: opts.args, captureTarget: fallback } : undefined,
    );
    return fallback;
  }
  // W3: re-assert the concrete create route as the FINAL word (the prepared
  // contract above legitimately drops a discovery `next`; a create's next is
  // the edit action itself and must survive).
  assertCreateRoute(trimmed, profile, workspace);
  // C2 (2026-08-09): BEFORE the stop-route/doc-sliver passes, so a qref replay
  // that only adds context is shaped by exactly the same pipeline as the first
  // pack instead of shipping a demoted certificate plus three prescribed finds.
  carryForwardCertifiedWorkingSet(workspace, trimmed, opts?.args, effectiveQuery);
  // iter-2 W2: a complete/focused working set (single-call OR cumulative) carries
  // an explicit STOP signal on its route, so a pack whose coverage just flipped
  // complete reads as "edit now", never as license to issue more discovery packs
  // (the iter-1 loss cell issued 4 more; the win cell issued 0). Guidance only.
  applyCompleteStopRouteToResult(trimmed, workspace);
  // iter-2 W5: name the functional-validation obligation for an artifact-sourced
  // runnable target — an honest verify line + a session-recorded OPEN item, never
  // a block. Runs before the guidance cap so its verify line is accounted for.
  attachFunctionalValidationObligation(workspace, trimmed);
  // 2026-10-20: and for a Python target, the interpreter that smoke run needs
  // when the PATH's python3 falls short of the project.
  attachPythonInterpreterHint(workspace, trimmed);
  // iter-3 F5: for an Office-source → Python-module build, attach the compact
  // runtime hint (discovered interpreters + module presence) so the build cell
  // does not burn its tail hunting a python that can import the library.
  attachRuntimeHint(trimmed);
  // iter-3 F4: shed orientation-only envelope weight (tree / full-code outline+why
  // / read-pack likely_edits / overlong route.reason) on packs 2+ and on any
  // prepared/complete pack — the first exploratory pack keeps the full envelope.
  // BEFORE annotateSpannedRoots so the reason cap precedes the span-remedy suffix
  // (which is load-bearing honesty and must survive), and before capture so the
  // served AND captured pack is the trimmed one.
  applyEnvelopeWeightTrim(
    trimmed,
    isFirstEpochPack(workspace, tokenizeForEpoch(effectiveQuery)),
    profile !== "answer",
  );
  // Serve-honesty (2026-08-01): AFTER the reason cap — see its doc comment.
  annotateEditZoomAffordance(trimmed);
  // L1 (2026-08-08): same reason — the doc-authority honesty clause replaces the
  // stop clause in place, so it must land after applyEnvelopeWeightTrim or the
  // 200-char reason cap would shear it (and the code working set off) again.
  const routeBeforeDocSliverHonesty = trimmed.route;
  const docSliverFloorRestore = applyDocSliverHonesty(workspace, trimmed, effectiveQuery);
  // L1 follow-up (2026-08-08, T05c smoke-gate escape): applyDocSliverHonesty
  // runs after the last fitsInCap-enforcing gate above (line ~19084), so its
  // heading-index affordance (up to DOC_SLIVER_HEADINGS_CAP_BYTES=2048/surface,
  // plus sections_hint/next_call/the longer route clause) was landing with no
  // size check at all. Measured: a multi_concern pack already at the 32768
  // ceiling (large required C++ surfaces across 3 concerns, plus small but
  // uncapped additions from applyCompleteStopRouteToResult and
  // annotateEditZoomAffordance just above) plus one doc-sliver affordance came
  // back at 34233B — refused by the bench smoke gate before any solver cell
  // launched. Degrade the just-attached affordance (never touched by the
  // earlier trim phases, so it has never been size-checked) rather than let it
  // silently blow the transport ceiling.
  if (!fitsInCap(trimmed)) {
    shrinkDocSliverAffordanceToFit(trimmed, routeBeforeDocSliverHonesty, docSliverFloorRestore);
  }
  // B1b (2026-08-01 retrieval-scope): re-run the missing-roles naming invariant
  // against the POST-trim state (a whole-surface drop or the cumulative flip can
  // both rewrite the role bookkeeping), and disclose any caller-named path this
  // pack narrowed away. Both run BEFORE capGuidanceMetadata so their additions
  // share the same bounded guidance budget as every other unserved-file note.
  reconcileMissingRolesContract(trimmed);
  reconcileCallerPathCoverage(trimmed, opts?.args, workspace);
  discloseUnservedQualifiedAnchorDefinition(trimmed, effectiveQuery, workspace);
  // B1c (2026-08-01 retrieval-scope): make a candidate list's own advice
  // runnable, and remember WHICH candidates are pending so a query-only re-pack
  // can bind them instead of re-deriving the same ambiguity.
  attachCandidateListRecovery(trimmed, effectiveQuery, workspace);
  if (isCandidateListPack(trimmed)) {
    const candidatePaths = [...new Set(codeTaskPackSurfaces(trimmed.surfaces).map((s) => s.path))];
    if (candidatePaths.length > 0) {
      pendingCandidatePaths.set(path.resolve(workspace), {
        paths: candidatePaths,
        tokens: tokenizeForEpoch(effectiveQuery),
      });
    }
  } else {
    pendingCandidatePaths.delete(path.resolve(workspace));
  }
  // W2: bound the combined size of the candidates/missing/notes guidance lists
  // so the raised pack budget flows to code bodies, not to a longer inventory
  // of unserved files. Applied here (post-trim, at the shared choke point) so
  // it fires at ANY pack size, not only when the overall cap binds.
  capGuidanceMetadata(trimmed);
  annotateSpannedRoots(trimmed);
  // A-F2 ORDER: suppress the consumed next FIRST, then repair whatever that
  // leaves. The reverse order let a suppression that ran after the guard strip
  // the last machine-executable action with nothing left to notice.
  const packLane = normalizeContractLane((opts?.args as { lane?: unknown } | undefined)?.lane);
  suppressNonProgressingNextCall(workspace, trimmed, opts?.args, effectiveQuery, servedZoomScope);
  enforceNoDeadEndContract(trimmed, effectiveQuery, { workspace, lane: packLane });
  // Evidence-expansion is a proof transition, not post-response bookkeeping.
  // Persist its explicit capability gap before the final contract rebuild so
  // this very pack can discharge its open-universe parent. Recording it below
  // the rebuild made the first fresh exhaustive Go pack emit `discover` and
  // only a later re-pack see the terminal explicit-gap proof.
  const importedEvidenceExpansionGaps = opts?.evidenceExpansion?.gaps ?? [];
  const literalSourceUniverse = literalFirstRoutingEnabled() && opts?.args !== undefined
    ? literalSourceUniverseProved(
        trimmed,
        literalFirstMeasurement(opts.args, effectiveQuery, workspace, undefined),
        { workspace, args: opts.args },
      )
    : false;
  if (literalSourceUniverse) {
    // `source-cohort-remaining` is discharged only by the exact, bound
    // continuation witness above. Keeping the marker after that proof would
    // rebuild the final contract as discovery despite every source witness
    // being accounted for.
    trimmed.missing = trimmed.missing.filter((entry) => entry !== "source-cohort-remaining");
    // The cohort witness is an exact, content-bearing occurrence range for
    // every source path, including the one served through the authenticated
    // continuation.  The generic edit-content heuristic is intentionally
    // conservative about a one-line slice, but retaining its
    // `needs-followup` marker here would reject that already-proved exact
    // frontier without offering any evidence-grounded call.  Clear only this
    // stale heuristic result; the normal readiness rebuild below still checks
    // every required body, the literal universe proof, ledger discharge, and
    // risk before it can prepare an edit.
    delete trimmed.content_sufficiency;
    if (trimmed.missing.length === 0) {
      trimmed.coverage = "complete";
      delete trimmed.coverage_reason;
    }
    // A pure change-propagation relation has no independently requested API or
    // test duty. Those generic role placeholders were useful before the exact
    // source universe was proved, but must not keep a fully witnessed rename
    // in discovery after its one sanctioned cohort continuation succeeds.
    // `task.profile` is canonical wire input; server normalization keeps its
    // selected value in `profile` even when no legacy `taskProfile` key is
    // present in TaskPackArgs. Use that authoritative selected profile so a
    // handle-based canonical re-pack gets the same cohort discharge as the
    // initial pack.
    if (profile === "change_propagation") {
      const genericRoleMarkers = new Set([
        "implementation",
        "contract",
        "api",
        "test",
        "unresolved-ledger:required-role:implementation",
        "unresolved-ledger:required-role:contract",
        "unresolved-ledger:required-role:api",
        "unresolved-ledger:required-role:test",
      ]);
      trimmed.missing = trimmed.missing.filter((entry) => !genericRoleMarkers.has(entry));
      trimmed.required_surfaces = ["implementation"];
      trimmed.missing_required_surfaces = [];
      if (trimmed.missing.length === 0) {
        trimmed.coverage = "complete";
        delete trimmed.coverage_reason;
      }
    }
  }
  const preFinalExpansionGap = !literalSourceUniverse && hasCurrentEvidenceExpansionGap(
    trimmed,
    effectiveQuery,
  );
  const evidenceExpansionGap = preFinalExpansionGap
    && importedEvidenceExpansionGaps.length > 0;
  if (evidenceExpansionGap) {
    trimmed.missing = [...new Set([...trimmed.missing, ...importedEvidenceExpansionGaps.map((gap) => `explicit-gap:${gap}`)])];
    trimmed.coverage = "partial";
    trimmed.coverage_reason ??= "concerns-uncovered";
  }
  const recordedExpansionGap = preFinalExpansionGap || literalSourceUniverse
    ? recordEpochTaskContract(
        workspace,
        trimmed,
        effectiveQuery,
        opts?.evidenceExpansion,
        literalSourceUniverse,
      )
    : false;
  if (literalSourceUniverse && trimmed.change_contract !== undefined) {
    const missing = trimmed.change_contract.missing.filter(
      (entry) => entry !== "execution:open-universe:dependency-definitions",
    );
    trimmed.change_contract = {
      ...trimmed.change_contract,
      missing,
      discovery_complete: missing.length === 0,
      status: missing.length === 0 ? "ready" : trimmed.change_contract.status,
      max_additional_tl_calls: missing.length === 0 ? 0 : trimmed.change_contract.max_additional_tl_calls,
    };
  }
  // The seams above can add a missing disclosure or retain a clipped range
  // after the first contract build. Rebuild and project together so the wire
  // never pairs that post-contract state with a stale prepared certificate.
  rebuildFinalExecutionContract(
    trimmed,
    cumulativeComplete && trimmed.coverage_basis === "cumulative" ? "generic" : profile,
    effectiveQuery,
    workspace,
    workspaceInventory,
    (preFinalExpansionGap || literalSourceUniverse) && recordedExpansionGap,
    literalSourceUniverse,
    packLane,
  );
  // TL_PACK_BODYLESS_DISCOVER (2026-11-03, default ON): a task's FIRST
  // pathless-query reply whose decision is `discover` over partial coverage
  // ships its rows body-less — see bodylessDiscover.ts for the rule. It runs
  // HERE: after the last contract rebuild (`rebuildFinalExecutionContract`
  // above, so the decision it reads is the one the wire projects) and BEFORE
  // every producer that records what this pack served from its BODIED rows —
  // `persistPackFingerprints` (the cross-pack block fingerprints
  // `applyPackDedupe` turns into `code_unchanged` pointers, and the staged
  // source capsules a later pack restores a body from), `recordEpochTaskContract`
  // (the monotone task-contract ledger's served roles, concern tokens and
  // definitions), the receipt passes and the single booking pass
  // (`shippedSurfaces` is body presence). A body stripped after any of them
  // would let a later same-epoch pack restate or certify over bytes the caller
  // never received (measured: concernStatusPolicyMatrix's 4-concern
  // derived-name cell certified `act.answer` without ever serving the renewal
  // concern while this pass still ran at the booking seam). Auxiliary enum
  // contexts, which size themselves against the pack's spare capacity, are not
  // attached when this pass withheld bodies (see the attach below); nothing
  // else adds a body after this line.
  const bodylessWithheld = applyBodylessDiscover(trimmed, {
    args: opts?.args,
    receipt: false,
    // Clause 2's prose half: a file the query itself names ("check
    // control/mixer.cpp against CONTRACT.md") is a stated requirement, resolved
    // by the same walk `augmentQueryNamedFileSurfaces` seeds from.
    requestNamesFile: () => queryNamedWorkspaceFiles(
      effectiveQuery, workspace, trustworthySurfaceAnchorPaths(codeTaskPackSurfaces(trimmed.surfaces)),
    ).length > 0,
    // A row the request's own anchors resolved to keeps its body.
    anchoredSpans: () => {
      const resolution = recallAnchorResolution({ workspace, read: plainAnchorReader(workspace) }, effectiveQuery);
      return resolution === undefined ? [] : [...resolution.definitions, ...resolution.literalHits];
    },
    // The server follows a discover that re-issues the request in the same
    // call when nothing bounds the reply (server.ts `autofollowSkipReason`).
    autofollowPossible: effAutofollowEnabled() && activePackByteCeiling() === undefined,
  }, workspace);
  // A1: `paths`/`targets` naming this file is the caller's own explicit
  // location. A recursive internal seed (literal-first discovery, the
  // identity-match/short-circuit/directory-retry/generic-text-lane
  // fallbacks) ALSO leaves `args.paths` non-empty by the time it reaches
  // this tail, so `autoDiscoveredLocation` -- stamped by every such site,
  // never present on a wire call's own args -- is required to tell the two
  // apart. See attachSingleSiteUniqueMatchFastPath's own doc comment on its
  // last parameter for why the two must diverge.
  const hasCallerSuppliedLocation = Array.isArray(opts?.args?.paths)
    && opts.args.paths.length > 0
    && opts.args.autoDiscoveredLocation !== true;
  attachSingleSiteUniqueMatchFastPath(trimmed, workspace, effectiveQuery, profile, opts?.cache, hasCallerSuppliedLocation);
  persistPackFingerprints(workspace, trimmed, opts?.args?.taskBinding);
  // Session-state registration is skipped too for an answer pack — a later
  // `tl_read_file mode=closure` call must have nothing open to report for a
  // pack that never registered a closure/wiring check in the first place
  // (registering one here, then never expecting the edit that would satisfy
  // it, is exactly the stale-check shape closure hardening exists to avoid).
  const checkRecords = [...new Map([
    ...(opts?.checkRecords ?? []),
    ...semanticCheckRecords,
  ].map((check) => [check.id, check] as const)).values()];
  if (
    opts?.query !== undefined &&
    (opts.checkRecords !== undefined || semanticCheckRecords.length > 0) &&
    result.route?.action !== "answer_from_handles"
  ) {
    recordPackChecks(workspace, opts.query, checkRecords);
  }
  // ---------------------------------------------------------------------
  // V11-03 SECOND SEAM (TL_COVERAGE_PACKER=v2 since the v0.14 consolidation;
  // the tri-state value now enforces by construction the base-flag conjunct
  // this seam's old comment claimed but never checked) —
  // change_contract obligation threading, post-surfaces.
  //
  // WRITE: `trimmed.change_contract` is fully finalized by this point (every
  // rebuild above has already run) and `trimmed.surfaces` is the FINAL served
  // set (post-trim, post-shed). Record its obligations into priorPackStore so
  // the NEXT pack in the SAME task (via SEAM 1's `queryPriorPackObligations`
  // read, above in this file) packs against them as real coverage-packer
  // obligations — the "prior-pack store + second seam" the V10-09 shipping
  // notes (DESIGN-v0.10-expansion-plan-reconciliation.md §6 "B2-redo") named
  // as undone: "change_contract obligations NOT threaded (contract is built
  // after surfaces — a prior-pack store + second seam would be needed)".
  //
  // DETECT (gap disclosure), the mirror direction: an EARLIER pack's open,
  // required, action:"edit" obligation whose target path THIS pack neither
  // served (a code-bearing surface) nor inventory-listed (named in this
  // pack's own change_contract obligations) must never go silently missing —
  // appended to `trimmed.missing`, the EXISTING general-disclosure array this
  // file already uses for the identical shape of note (see the
  // "dropped-by-byte-budget:" entries above). This is the detection half of
  // "reconcile... where cheaply possible without reordering the build": it
  // deliberately does NOT attempt to re-flip `coverage` / re-run
  // `execution_contract` (both are long finalized above, and
  // `buildTaskExecutionContract`/its capability_gaps computation sit in the
  // receipt/certificate territory this workstream does not touch) — a fully
  // re-certified in-pack reconciliation was judged to need pipeline
  // restructuring and is recorded as a finding instead, per the brief's own
  // escape hatch for this seam.
  //
  // POSITION matters: this MUST run before `returned` (a few lines below) is
  // derived from `trimmed`/`subset`/`idempotent` — a receipt/idempotent
  // downgrade is a SEPARATE object, and a `trimmed.missing` mutation applied
  // after that point would never reach the wire (found live: an earlier
  // version of this seam sat after `captureServedPack`, past the `returned`
  // assignment, and its disclosure silently never shipped).
  //
  // Kept surgical: one contiguous block, gated on the same flag as SEAM 1,
  // runs once, mutates only `trimmed.missing` (an existing optional field)
  // plus priorPackStore's own state — never a receipt/certificate function.
  // ---------------------------------------------------------------------
  if (coveragePackerV2Enabled() && opts?.args !== undefined) {
    const obligationEpochTokens = tokenizeForEpoch(effectiveQuery);
    const servedPaths = new Set(codeTaskPackSurfaces(trimmed.surfaces).map((s) => s.path));
    const inventoryPaths = new Set((trimmed.change_contract?.obligations ?? []).map((o) => o.path));
    const priorObligations = queryPriorPackObligations(workspace, obligationEpochTokens);
    const unservedPriorEdits = priorObligations.filter((o) =>
      o.open && o.required && o.action === "edit"
      && !servedPaths.has(o.path) && !inventoryPaths.has(o.path)
    );
    if (unservedPriorEdits.length > 0) {
      trimmed.missing = [...new Set([
        ...trimmed.missing,
        ...unservedPriorEdits.map((o) =>
          `unserved-obligation:${o.path} (edit obligation from an earlier pack this task; re-request via tl_read_file {targets:[{path:"${o.path}"}]})`
        ),
      ])];
    }

    // Every obligation a change_contract carries is recorded as OPEN: a
    // change_contract is rebuilt fresh from THIS pack's own surfaces and
    // carries no "already edited" signal (that is the edit tool's ledger,
    // out of scope here — see the module header's honest-limitation note).
    // Treating a recorded obligation as still-open is the conservative
    // direction: it can cost the caller one avoidable re-check; silently
    // treating a genuinely-open one as closed would drop a real gap.
    const currentObligations: PriorObligationRecord[] = (trimmed.change_contract?.obligations ?? []).map((o) => ({
      id: o.id,
      path: o.path,
      role: o.role,
      kind: o.kind,
      action: o.action,
      required: o.required,
      open: true,
    }));
    if (currentObligations.length > 0) {
      recordPriorPackObligations(workspace, obligationEpochTokens, currentObligations);
    }
  }
  // Non-gap expansion remains deliberately after final decision construction:
  // it must not suppress the initial authoritative discovery call for an
  // unresolved direct callee/value. Gap-bearing current evidence was recorded
  // above because it is terminal proof for this very response.
  // A proved literal cohort was recorded before the final rebuild above. Do
  // not run the ordinary post-decision expansion recorder a second time: that
  // reconstruction lacks the continuation witness and would overwrite the
  // just-certified literal profile proof with an awaiting-input contract.
  if (!preFinalExpansionGap && !literalSourceUniverse) {
    recordEpochTaskContract(workspace, trimmed, effectiveQuery, opts?.evidenceExpansion);
    const persistedDischarge = taskContractDischargeCertificate(
      workspace,
      tokenizeForEpoch(effectiveQuery),
    );
    // A complete same-pack expansion is terminal proof, not merely a
    // post-decision cache write. Rebuild the contract after persistence so the
    // certificate and act.* decision are based on the fully discharged ledger.
    // Keep the first unresolved expansion conservative: without a discharge
    // certificate it retains its evidence-grounded discovery path.
    if (
      persistedDischarge !== undefined
      && (trimmed.route?.action === "answer_from_handles"
        || trimmed.route?.action === "edit_from_handles")
    ) {
      trimmed.execution_contract = buildTaskExecutionContract(
        trimmed,
        cumulativeComplete && trimmed.coverage_basis === "cumulative" ? "generic" : profile,
        effectiveQuery,
        buildTaskWorkspaceState(trimmed, workspace, workspaceInventory),
        workspace,
        false,
        servedZoomScope,
      );
      reconcileTaskPackExecutionContract(trimmed);
    }
    // The normal expansion path deliberately records only AFTER the first
    // decision: an unresolved direct dependency must still emit its initial
    // authoritative discovery call (I1), rather than being hidden by a
    // ledger row made too early. A pack which was already prepared is the
    // opposite case: its certificate is about to become a public identity,
    // and it must bind the very ledger snapshot this call just persisted.
    if (
      trimmed.execution_contract?.typestate.phase === "prepared"
      && persistedDischarge !== undefined
    ) {
      rebindPreparedCertificateToLedger(
        trimmed,
        cumulativeComplete && trimmed.coverage_basis === "cumulative" ? "generic" : profile,
        effectiveQuery,
        workspace,
      );
    }
  }
  // R2-T1 (eval-0929 review P0-3): THE ONE ENFORCEMENT AT THE EXIT, after the
  // last contract rebuild of this function (rebuildFinalExecutionContract, the
  // ledger-discharge rebuild above) and before the idempotency / receipt
  // passes and the booking read the decision. A demotion the byte-budget tiers
  // forced is re-applied — no rebuild may re-certify over the surrogates the
  // tiers left behind — and a cited line any other tier withdrew is caught
  // here. A pack with nothing certified to protect never gets here.
  if (ceilingCertification !== undefined) {
    enforceCeilingCertificateInvariant(trimmed, ceilingCertification, workspace, ceilingDemoted);
  }
  // iter-2 W4 (awaiting-input idempotency) + W1 (subset receipt): consult the
  // session state BEFORE capturing this pack, so neither can match the current
  // pack against itself. W4 first: a still-unresolved proof re-grants the SAME
  // awaiting-input verdict (never `prepared`) as a compact receipt. Otherwise a
  // pack whose every body is already resident-and-unchanged re-serves a compact
  // subset receipt instead of the bodies. The full `trimmed` record is still
  // captured below, so a future EXACT re-call dedups against it.
  const epochTokens = tokenizeForEpoch(effectiveQuery);
  const idempotent = opts?.args !== undefined
    ? applyAwaitingInputIdempotency(workspace, trimmed, opts.args, effectiveQuery)
    : undefined;
  // PI-09 close-out: `force_serve:true` skips the subset receipt for the same
  // reason it skips the two dedup paths at the entry — "every body is already
  // resident" is a claim about a context the caller has just told us it lost.
  // `applyAwaitingInputIdempotency` above is deliberately NOT skipped: it is a
  // DECISION idempotency guarantee (the same unresolved proof must not flip to
  // `prepared` on a re-ask), not a body-withholding dedup, and re-serving
  // bodies must never move a verdict.
  const subset = idempotent === undefined && opts?.args !== undefined && opts.args.forceServe !== true
    // G4 (2026-09-08, qref-binding follow-up): thread this request's own
    // recovered task binding through the subset receipt's own stale-search
    // repair too — see receiptContractWithoutConsumedSearch's doc comment.
    ? tryServeSubsetReceipt(workspace, trimmed, epochTokens, opts.args.taskQueryRefReplay === true, opts.args.taskBinding)
    : undefined;
  // Behavior 3: capture LAST (after recordPackChecks) so the captured check ids
  // reflect this pack's session state. Recompute the fingerprint from the same
  // args the top-level dedup interception used — deterministic, so both agree by
  // construction. The capture BASELINE differs by served shape:
  //   - W4 downgrade → capture the AWAITING-INPUT verdict, so a future exact
  //     re-call of the same signature also stays awaiting-input (the idempotency
  //     guarantee would leak if we captured the pre-downgrade prepared pack).
  //   - subset receipt → capture the full `trimmed` (the receipt is only a wire
  //     optimization for THIS call; keep the full baseline for exact re-calls).
  const returned = idempotent ?? subset ?? trimmed;
  // Receipts are alternate wire shapes, not alternate decision semantics.
  markServedZoomCandidates(
    workspace,
    returned,
    opts?.args?.forceServe === true,
    servedZoomScope,
  );
  annotateSemanticFrontierContinuation(returned, effectiveQuery, semanticFrontierGuardEnabled());
  applyCanonicalTaskDecision(returned);
  // FX-I-A/FX-J (2026-09-03): THE SF PRE-BOOKING SEAM — the last pass that can
  // shed a body, run before the one pass that books one.
  //
  // It cannot run earlier than this line: eligibility starts at
  // `isSemanticFrontierContinuationOptional`, and the classification that
  // marks a surface SF-supporting is `annotateSemanticFrontierContinuation`
  // immediately above, which needs the finalized `execution_contract`
  // (`contractEvidenceAddresses`) to tell a required surface from a supporting
  // one. It must not run any later: `bookShippedPackServeState` below is the
  // single booking pass, and it derives EVERY producer — the cumulative
  // served-surface log (and so the next pack's `priorEpochActionFrontier` /
  // certificate `action_frontier`), the edit gate's admissible union, the
  // certified working set, the served-range ledger and the served-pack record
  // — from one `shippedSurfaces` projection over `returned`, in BOTH flag
  // states (FX-K). The pack that gets booked IS the pack that ships. The
  // static ordering fence in `sfBookingOrderFence.spec.ts` holds this by
  // parse, not by review.
  applySemanticFrontierPreBookingSeam(workspace, returned, opts?.args, effectiveQuery);
  noteSemanticFrontierTraceSeed(
    prepareSemanticFrontierTraceSeed(returned, effectiveQuery, semanticFrontierGuardEnabled()),
  );
  // A receipt can omit the body whose exact text this shortcut certifies. Never
  // carry it across an idempotent/subset downgrade or a non-ready exit.
  if (returned !== trimmed || returned.execution_contract?.typestate.phase !== "prepared") {
    delete returned.fast_path;
  }
  // FIX-FC (eval-0927 review finding 15, 2026-09-27): a LATE producer — the
  // facet/closure chain's own re-added "anchor" surface (a
  // `runInternalReadinessFalsification` counterexample, re-selected on a
  // later hop of the same task) — can add a surface with a fresh `code` body
  // AFTER this same request's EARLY `applyResidentFileDedup` call above
  // already ran, so it never gets the residency check every other surface in
  // this response already passed; only the booking pass a few lines below
  // had seen every instance of it. This second, idempotent pass runs the
  // SAME dedup over whatever `returned.surfaces` ends up holding — including
  // anything added between the early pass and here — so a repeat is caught
  // regardless of which producer re-added it. `allowRequiredDedup` matches
  // the early call for the same reason (see `applyResidentFileDedup`'s own
  // doc comment, fix (1) — the counterexample surface above is exactly the
  // `required:true`, answer-profile case that fix targets). Gated on the
  // SAME `forceServePack` the early pass observes (declared once, above, and
  // still in scope): `force_serve` denies every residency claim in this
  // response, and a surface it would otherwise demote here must stay exactly
  // as fresh as `force_serve` promises. A no-op for every response where
  // nothing was added after the early pass (nothing left for it to find).
  if (!forceServePack) {
    applyResidentFileDedup(workspace, returned, tokenizeForEpoch(effectiveQuery), { allowRequiredDedup: profile === "answer", ...(dedupExempt ? { exempt: dedupExempt } : {}) });
  }
  priorBodyRestoration.strip(codeTaskPackSurfaces(returned.surfaces), forceServePack);
  // Semantic/certification passes are complete. Auxiliary source consumes only
  // remaining wire capacity and never participates in the primary decision.
  // TL_PACK_BODYLESS_DISCOVER (2026-11-03): a first reply that just went
  // body-less carries no optional context either — the contexts size
  // themselves against the pack's spare capacity, which the withheld bodies
  // would otherwise have handed them.
  if (auxiliarySeed !== undefined && auxiliarySubjects.length > 0 && bodylessWithheld === 0
    && returned.ok !== false && protocolCallContext()?.sizePreview !== true) {
    carryAuxiliaryEnumPool(returned, {...auxiliarySeed, subjects: auxiliarySubjects,
      primaryPaths: [...new Set([...auxiliaryPrimaryPaths,
        ...primaryEnumContextRows(returned.surfaces).map(surface => surface.path)])],
    });
    const pool = auxiliaryEnumPool(returned)!;
    const added = await attachAuxiliaryEnumContexts({
      pool, primary: returned.surfaces,
      read: relPath => readCached(workspace, relPath),
      held: (plan, start, end, totalLines) => servedRangeReceipt(
        workspace, plan.path, `sha256:${plan.sourceSha}`, start, end, totalLines, undefined, true,
      ) !== undefined,
      fits: rows => {
        const candidate = {...returned, surfaces: [...rows]} as TaskPackResult;
        const preview = auxiliaryEnumAttachmentSizePreview(candidate, protocolCallContext()?.clientId);
        return preview !== undefined && preview <= Math.min(18 * 1024, capForResult(returned));
      },
      mint: (relPath, range) => handleTable.upsert({kind: "range", path: relPath, range, workspaceRoot: workspace}).id,
      forceServe: forceServePack,
    });
    (returned.surfaces as TaskPackResultSurface[]).push(...added);
  }
  if (!forceServePack) {
    applyRequiredSourceCapsuleDedup(workspace, returned, opts?.args?.taskBinding, {
      forceServe: opts?.args?.forceServe === true,
      ...(dedupExempt !== undefined ? {exempt: dedupExempt} : {}),
    });
  }
  // New late demotions remain proof-visible through dedupedSurfaceBody, then
  // this guarded strip removes only the unchanged body from the wire object.
  priorBodyRestoration.strip(codeTaskPackSurfaces(returned.surfaces), forceServePack);
  // FX-J: THE SINGLE BOOKING PASS. Every producer that asserts what this
  // response served runs inside it, downstream of the seam, off one
  // `shippedSurfaces` projection over the pack that ships.
  bookShippedPackServeState(
    workspace,
    returned,
    effectiveQuery,
    pendingBookings,
    { trimmed },
    opts?.args !== undefined ? { args: opts.args, captureTarget: idempotent ?? trimmed } : undefined,
  );
  // 2026-10-29 (first-hop field report): the task's exploration spend against
  // TASK_EXPLORATION_MAX_HOPS / _MAX_BYTES, plus which served surfaces the
  // request names. Stamped LAST, on the pack that ships; the exit fence
  // (`enforceCanonicalTaskDecisionAtExit`) re-derives the decision from it, so
  // an exhausted budget stops proposing document pages without touching a body.
  stampExplorationState(returned, workspace, effectiveQuery);
  return returned;
}
