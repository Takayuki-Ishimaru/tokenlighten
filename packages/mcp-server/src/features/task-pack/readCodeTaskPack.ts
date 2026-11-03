/** Public compatibility facade. Implementation lives in engine/. */
export { MAX_TASK_PACK_BYTES } from "./engine/packBasics.js";
export { REQUIRED_MIN_TASK_PACK_BYTES } from "./engine/packBasics.js";
export { admitTaskPackBudget } from "./engine/packBasics.js";
export { LITERAL_SOURCE_RARITY_RATIO } from "./engine/packBasics2.js";
export { LITERAL_SOURCE_RARITY_FLOOR } from "./engine/packBasics2.js";
export { literalSourceRarityLimit } from "./engine/packBasics2.js";
export { FileReadCache } from "./engine/packBasics2.js";
export { centeredSliceForCap } from "./engine/packBasics2.js";
export { wholeFileRangeIfDominant } from "./engine/packBasics2.js";
export { dedupeAgentGuideSurfaces } from "./engine/guideAndArtifactSurfaces.js";
export { resetManagedGuideBlockSpanCacheForTest } from "./engine/guideAndArtifactSurfaces.js";
export { managedGuideBlockSpanForTest } from "./engine/guideAndArtifactSurfaces.js";
export { applyAgentGuideElision } from "./engine/guideAndArtifactSurfaces.js";
export { resetArtifactSectionPrefetch } from "./engine/guideAndArtifactSurfaces.js";
export { buildTaskPack } from "./engine/taskPackEntry.js";
export type { SfNamedFrontierIndexOnly } from "./engine/semanticFrontier.js";
export { sfNamedFrontierRow } from "./engine/semanticFrontier.js";
export { sfNamedFrontierDirectWindowsFor } from "./engine/semanticFrontier2.js";
export { withoutNamedFileArtifacts } from "./engine/structureMap2.js";
export type { AnswerFirstVerdict } from "./engine/structureMap2.js";
export { answerFirstPageHolds } from "./engine/structureMap2.js";
export type { StructureMapRowNote } from "./engine/structureMap2.js";
export { owedRowsFitOnePage } from "./engine/structureMap2.js";
export { setPostCertificationPassForTest } from "./engine/answerCertificates.js";
export { anchorRowIsWholeEvidence } from "./engine/answerCertificates2.js";
export type { LiteralFirstRouteAttestation } from "./engine/literalAndConcernSeeds.js";
export { literalFirstRouteAttestation } from "./engine/literalAndConcernSeeds.js";
export { propagationSeedPaths } from "./engine/literalAndConcernSeeds2.js";
export type { LightAnswerVerdict } from "./engine/seedResolution.js";
export { lightAnswerVerdictForTest } from "./engine/seedResolution.js";
export { explicitCodeIdentifiers } from "./engine/anchorFocus2.js";
export { explicitCodeIdentifierEntries } from "./engine/anchorFocus2.js";
export { markdownAnchorFocus } from "./engine/anchorFocus3.js";
export { selectAnchorFocus } from "./engine/anchorFocus3.js";
export { resetRoleInventoryCache } from "./engine/roleAndConcernScope.js";
export { roleFillScope } from "./engine/roleAndConcernScope.js";
export { queryNamedDirectoryScopes } from "./engine/roleAndConcernScope.js";
export { artifactQueryTokens } from "./engine/roleAndConcernScope2.js";
export { concernHarvestText } from "./engine/roleAndConcernScope2.js";
export { filterConcernQueryEntries } from "./engine/roleAndConcernScope2.js";
export { concernAnchorTokens } from "./engine/roleAndConcernScope3.js";
export type { RankedAnswerEvidenceCandidate } from "./engine/roleAndConcernScope3.js";
export { isNonImplementationAnswerCandidate } from "./engine/answerCandidates.js";
export { rankAnswerEvidenceCandidates } from "./engine/answerCandidates.js";
export { framedTypeInNamedFiles } from "./engine/sameNameSubjects.js";
export { concernRecoveryEntryCount } from "./engine/callerExpansion.js";
export { resetConcernRecoveryEntryCountForTest } from "./engine/answerPackBuilder.js";
export { callerExpansionEntryCount } from "./engine/callerExpansion.js";
export { resetCallerExpansionEntryCountForTest } from "./engine/answerPackBuilder.js";
export type { CallerScanResult } from "./engine/callerExpansion2.js";
export type { MentionCommentLineState } from "./engine/callerExpansion2.js";
export { memberOnlyInCommentText } from "./engine/callerExpansion2.js";
export { mentionExplainedByImportExportLine } from "./engine/callerExpansion2.js";
export { mentionExplainedByImportExport } from "./engine/callerExpansion2.js";
export { callSiteOccurrenceIsDeclaration } from "./engine/callerExpansion2.js";
export { isCallerMentionOnlyFile } from "./engine/callerExpansion3.js";
export { callSitesForFocalMember } from "./engine/callerExpansion2.js";
export { facetClosureEntryCount } from "./engine/callableResolution.js";
export { resetFacetClosureEntryCountForTest } from "./engine/facetClosure.js";
export type { FacetClosureOutcome } from "./engine/callableResolution2.js";
export { isDeclarationShapedMatchText } from "./engine/callableResolution4.js";
export { findGoPackageConstantWindow } from "./engine/constantResolution2.js";
export { MAX_GO_PACKAGE_SCAN_BYTES } from "./engine/constantResolution3.js";
export { plainFunctionCallerSites } from "./engine/focalFlow.js";
export { focalIsSoleDefaultExport } from "./engine/focalFlow.js";
export { editContextCandidates } from "./engine/focalFlow2.js";
export { readonlyAnswerBatchPlan } from "./engine/facetClosure.js";
export { FACET_CLOSURE_EMERGENCY_BUDGET_MS } from "./engine/facetClosure.js";
export { identifierGroundingScanCount } from "./engine/identifierAbsence2.js";
export { resetIdentifierGroundingScanCountForTest } from "./engine/identifierAbsence2.js";
export { resetReceiptRepairTraceOnceForTest } from "./engine/identifierAbsence2.js";
export { continuationQuery } from "./engine/coverageAndContinuation.js";
export { hasArtifactBuildIntentMarker } from "./engine/coverageAndContinuation3.js";
export { autoBoundTaskProfile } from "./engine/coverageAndContinuation4.js";
export { queryNamedWorkspaceFiles } from "./engine/queryIntent3.js";
export { UNREADABLE_NAMED_PATH_PREFIX } from "./engine/queryIntent4.js";
export { UNWRITABLE_ENCODING_RISK_PREFIX } from "./engine/queryIntent4.js";
export { capExtraEvidenceRelativeToNamedPaths } from "./engine/queryIntent.js";
export { queryNamesCreateTarget } from "./engine/createAndWiringEndpoints.js";
export { stripFencedBlocksForLocating } from "./engine/createAndWiringEndpoints2.js";
export { assertCreateRoute } from "./engine/createAndWiringEndpoints2.js";
export { qualifiedSymbolAnchors } from "./engine/wiringEvidence3.js";
export { qualifiedAnchorSiteKind } from "./engine/wiringEvidence3.js";
export { resolveQualifiedSymbolAnchors } from "./engine/wiringEvidence3.js";
export { wiringDestinationDomainEndpoint } from "./engine/wiringProfiles2.js";
export { semanticConstructionHubExcerpt } from "./engine/wiringProfiles2.js";
export { deriveTaskChangeContractVerifyObligations } from "./engine/changeAndReadinessEvidence.js";
export { surfaceAdmittedByFilenameMatchOnly } from "./engine/changeAndReadinessEvidence.js";
export { requestNamesFileByWord } from "./engine/changeAndReadinessEvidence.js";
export { servedSurfaceText } from "./engine/changeAndReadinessEvidence2.js";
export { namedAuthorityFacetProofs } from "./engine/changeAndReadinessEvidence.js";
export { enumeratedQueryObligationIds } from "./engine/readinessFalsification.js";
export { enumeratedQueryFacets } from "./engine/readinessFalsification.js";
export { statedRelationToNamedPath } from "./engine/readinessFalsification.js";
export { resetClosureExecutedCallsForTest } from "./engine/recursiveClosure2.js";
export { runRecursiveReadOnlyClosure } from "./engine/recursiveClosure4.js";
export { isRegexLiteralStartAt } from "./engine/sourceAndConcernTerms.js";
export { clauseRecoveryInventoryIsBounded } from "./engine/requestItemAbsence2.js";
export { asCreateIfIntroduced } from "./engine/requestItemAbsence3.js";
export { narrowSurfaceToFacetWindows } from "./engine/facetReadiness.js";
export { readOnlyServedViewForTest } from "./engine/epochEvidence.js";
export { recordReadOnlyServedRangedServe } from "./engine/epochEvidence.js";
export { answerArtifactDiscoveryCall } from "./engine/unresolvedCalls3.js";
export { buildTaskExecutionContract } from "./engine/executionContract.js";
export { contractForEvidenceRetention } from "./engine/contractReconciliation.js";
export { certificateBindingFor } from "./engine/contractReconciliation.js";
export { reconcileTaskPackExecutionContract } from "./engine/contractReconciliation.js";
export { enforceNoDeadEndContract } from "./engine/contractReconciliation.js";
export { styleHasLiteralEnumSite } from "./engine/contractReconciliation2.js";
export { isPerSiteCheckSurface } from "./engine/contractReconciliation2.js";
export { enumSubjectSymbols } from "./engine/contractReconciliation2.js";
export { dynamicDerivationOf } from "./engine/contractReconciliation2.js";
export { dynamicEnumConsumerVerdict } from "./engine/contractReconciliation2.js";
export { candidateToSurface } from "./engine/surfaceMaterialization.js";
export { stagePackFingerprintBinding } from "./engine/packState.js";
export { resetPackDedupeCache } from "./engine/packState.js";
export { clearServedPackClaimsForWorkspace } from "./engine/packState.js";
export { clearPackDedupeForWorkspace } from "./engine/packState.js";
export { packServedSpans } from "./engine/packState2.js";
export type { ServedWindowScope } from "./engine/packState2.js";
export { firstUnservedPartialRange } from "./engine/packState2.js";
export { markServedZoomCandidates } from "./engine/packState2.js";
export { GENERALIZED_NO_REPEAT_ACTIONS } from "./engine/receiptProgress2.js";
export { LOCATE_ONLY_NO_REPEAT_ACTIONS } from "./engine/receiptProgress2.js";
export { advanceExecutedLocateNextCall } from "./engine/receiptProgress2.js";
export { repairSuppressedNextCall } from "./engine/receiptProgress2.js";
export { canServeCachedTaskPackReceipt } from "./engine/receiptRestoration2.js";
export type { EpochTaskContractObservation } from "./engine/epochContract3.js";
export { computeEpochTaskContractObservation } from "./engine/epochContract.js";
export { attachCandidateListRecovery } from "./engine/epochContract.js";
export { resetPendingCandidatePaths } from "./engine/epochContract3.js";
export { resetCertifiedWorkingSets } from "./engine/epochContract3.js";
export { applyDocSliverHonesty } from "./engine/completionAndDocSlivers.js";
export type { DocSliverFloorRestore } from "./engine/completionAndDocSlivers.js";
export { discoverPythonInterpreters } from "./engine/runtimeAndDedup.js";
export { attachRuntimeHint } from "./engine/runtimeAndDedup.js";
export { applyEnvelopeWeightTrim } from "./engine/runtimeAndDedup.js";
export { applyResidentFileDedup } from "./engine/runtimeAndDedup.js";
export { applyPackDedupe } from "./engine/runtimeAndDedup.js";
export { applyRequiredSourceCapsuleDedup } from "./engine/runtimeAndDedup.js";
export { applyPackContainmentDedup } from "./engine/runtimeAndDedup.js";
export { persistPackFingerprints } from "./engine/runtimeAndDedup.js";
export { recomputeRouteAndNextAfterTrim } from "./engine/contentSettlement.js";
export { stampRollupContentCompleteness } from "./engine/contentSettlement.js";
export { inlineCodelessSurfaces } from "./engine/contentSettlement2.js";
export { parseUnreadableNamedPathRow } from "./engine/servedStateAndEdits3.js";
export { applyFoldSmallRemainder } from "./engine/callerRangeDelivery.js";
export { GUIDANCE_METADATA_CAP_BYTES } from "./engine/packTrimming2.js";
export { capGuidanceMetadata } from "./engine/packTrimming2.js";
export { trimToCap } from "./engine/packTrimming2.js";
export { fitsInCap } from "./engine/packTrimming2.js";
export { fitsInCapUncompacted } from "./engine/packTrimming2.js";
export { publishTaskPackAuxiliaryEnumPool } from "./engine/packTrimming3.js";
export type {
  ArtifactKind,
  ArtifactTaskPackSection,
  ArtifactTaskPackSurface,
  ConcernCoverage,
  TaskPackArgs,
  TaskPackResult,
  TaskPackResultSurface,
  TaskPackSurface,
} from "./model.js";
export { isArtifactTaskPackSurface } from "./artifactSections.js";
export {
  applyCanonicalTaskDecision,
  canonicalTaskDecisionInvariantViolations,
  deriveCanonicalTaskDecision,
  enforceCanonicalTaskDecisionAtExit,
  hasCertificateBinding,
  hasServedZoomAffordance,
  projectCompletion,
  type CanonicalDecisionFenceReport,
  type CanonicalTaskDecision,
  type CanonicalTaskDecisionKind,
} from "./canonicalDecision.js";
export { roleSearchScopePrefixes } from "../locator/locateTaskContext.js";
export { hasOpenUniverseIntent } from "./openUniverseIntent.js";
export { isAdditiveEnumIntent } from "./openUniverseIntent.js";
export {changeScopeFollowupTarget} from "./changeScopeContinuation.js";
