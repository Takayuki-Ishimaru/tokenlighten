// answerPackBuilder — extracted implementation; imports point to the owning modules.
import * as path from "path";
import type { AnswerStructureMap } from "./answerPackBuilder2.js";
import type { ContinuationCall } from "./packBasics.js";
import type { FacetClosureTrial } from "./facetClosure2.js";
import type { FacetRequirement } from "../requestFacets.js";
import type { ImpactCandidate } from "@tokenlighten/types";
import type { RankedAnswerEvidenceCandidate } from "./roleAndConcernScope3.js";
import type { TaskPackArgs } from "../model.js";
import type { TaskPackResult } from "../model.js";
import type { TaskPackSurface } from "../model.js";
import { FileReadCache } from "./packBasics2.js";
import { LOCATION_ONLY_MIN_BODY_BYTES } from "./roleAndConcernScope3.js";
import { MAX_SURFACES_DISTINCT } from "./packBasics2.js";
import { MAX_SURFACES_WITH_FACET_CLOSURE } from "./packBasics2.js";
import { MAX_SURFACE_CODE_BYTES } from "./packBasics2.js";
import { annotateSemanticFrontierContinuation } from "../semanticFrontier.js";
import { answerCertificationSnapshot } from "./answerCertificates.js";
import { answerFirstPageHolds } from "./structureMap2.js";
import { answerFirstPlanDecisions } from "./structureMap2.js";
import { answerRecoveryQuery } from "./anchorFocus.js";
import { applyDominancePromotion } from "./coverageAndContinuation.js";
import { attachAnswerFirstAdvisory } from "./packTrimming2.js";
import { attachAnswerImportEvidenceGraph } from "./wiringEvidence.js";
import { attachPlanAids } from "./packTrimming2.js";
import { attachStructureMapElsewhereNote } from "./packTrimming3.js";
import { augmentExplicitAnswerImportSurfaces } from "./answerCertificates2.js";
import { augmentQueryNamedFileSurfaces } from "./queryIntent.js";
import { boundedClauseRecoveryWork } from "./requestItemAbsence2.js";
import { callerExpansionEnabled } from "../../../util/flags.js";
import { candidateToSurface } from "./surfaceMaterialization.js";
import { capExtraEvidenceRelativeToNamedPaths } from "./queryIntent.js";
import { captureServedPack } from "./packState4.js";
import { centeredSliceForCap } from "./packBasics2.js";
import { classifySurface } from "../../../util/impact.js";
import { computePackFingerprint } from "./packState2.js";
import { concernRecoveryEnabled } from "../../../util/flags.js";
import { containsJapanese } from "../../retrieval/jaQueryBridge.js";
import { countLines } from "../../../util/countLines.js";
import { currentAskedPathPlan } from "./facetClosure2.js";
import { currentRequestSignal } from "../../../util/requestCancellation.js";
import { dedupeTrimAndPersist } from "./packSettlement.js";
import { deriveCoverage } from "./coverageAndContinuation.js";
import { discoverAnswerResponsibilityCandidates } from "./answerCandidates.js";
import { diversifyByConcern } from "../concernRecovery.js";
import { dropWeakCrossRootAndNonSourceAnswerCandidates } from "./answerCandidates.js";
import { enforceCertificateWireInvariant } from "./answerCertificates.js";
import { expansionsSupportCandidate } from "../../retrieval/queryRecoveryTerms.js";
import { explicitCodeIdentifiers } from "./anchorFocus2.js";
import { explicitIdentifierAbsences } from "./identifierAbsence2.js";
import { extractFacetRequirements } from "./packBasics2.js";
import { extractRequestItems } from "./packBasics2.js";
import { facetEvidenceStillUnserved } from "./recursiveClosure.js";
import { facetPlanFor } from "../facetGate.js";
import { facetPlanWorkspaceKey } from "./facetClosure.js";
import { freshAbsenceUniverse } from "./identifierAbsence2.js";
import { gateAnswerQueryEvidenceFocusOnNamedPathRelation } from "./queryIntent.js";
import { getWorkspaceJaBridgeVocabulary } from "../../retrieval/jaBridgeWorkspaceVocab.js";
import { hasIdentifierSegment } from "./literalAndConcernSeeds.js";
import { hasOpenUniverseIntent } from "../openUniverseIntent.js";
import { hasServedCode } from "./wiringEvidence2.js";
import { hygienicClauseWorkList } from "../concernRecovery.js";
import { importEvidenceExpansion } from "./epochContract3.js";
import { isFacetCallSiteLine } from "./changeAndReadinessEvidence2.js";
import { isLocatorOriginWhy } from "./roleAndConcernScope3.js";
import { isNonImplementationAnswerCandidate } from "./answerCandidates.js";
import { isStrongRecoveredAnswerCandidate } from "./coverageAndContinuation.js";
import { isTestConcernPath } from "./literalAndConcernSeeds.js";
import { jaBridgeExpansionTokens } from "../../retrieval/queryRecoveryTerms.js";
import { jaBridgeRecoveryQuery } from "../../retrieval/queryRecoveryTerms.js";
import { keptWindowOf } from "./answerCertificates2.js";
import { languageForPath } from "../../../util/languages.js";
import { lexicalOverlapFraction } from "./anchorFocus2.js";
import { locateTaskContext } from "../../locator/locateTaskContext.js";
import { materializeExplicitAnswerAnchorEvidence } from "./answerCertificates2.js";
import { mergeConcernAdditions } from "../concernRecovery.js";
import { namedDefinitionCandidate } from "./callerExpansion2.js";
import { namedDefinitionFiles } from "../concernRecovery.js";
import { normIdent } from "./createAndWiringEndpoints2.js";
import { noteSemanticFrontierTraceSeed } from "../../../protocol/semanticFrontierTraceContext.js";
import { orderByLocatorVerdict } from "./answerCandidates.js";
import { parsePackLineRange } from "./packState2.js";
import { persistPackFingerprints } from "./runtimeAndDedup.js";
import { pickNamedFileAbstainAnchor } from "./answerCandidates.js";
import { postCertificationPassForTest } from "./answerCertificates.js";
import { prepareSemanticFrontierTraceSeed } from "../semanticFrontier.js";
import { queryNamesWorkspaceFileUniquely } from "./queryIntent4.js";
import { queryRequestsTestEvidence } from "../../../tools/queryEvidence.js";
import { rankAbstainCandidates } from "./roleAndConcernScope3.js";
import { rankAnswerEvidenceCandidates } from "./answerCandidates.js";
import { readCached } from "./packBasics2.js";
import { recordAppendedWindow } from "./answerCertificates2.js";
import { recordClauseLocateAttempt } from "../concernRecovery.js";
import { recordIdentifierAbsences } from "./identifierAbsence2.js";
import { recordPackServedRanges } from "./packState2.js";
import { recordReadOnlyServedSurfaces } from "./epochEvidence.js";
import { recordSameNameSubjects } from "./sameNameSubjects.js";
import { recordServedSurfaces } from "../../../util/packServeLog.js";
import { recordVerifiedAbsentIdentifiers } from "./identifierAbsence.js";
import { recoverAskedPathCandidates } from "./facetClosure2.js";
import { recoverCallerExpansionCandidates } from "./callerExpansion2.js";
import { recoverConcernCandidates } from "./callerExpansion2.js";
import { recoverExplicitIdentifierAnswerCandidates } from "./answerCandidates.js";
import { recoverFacetClosureCandidates } from "./facetClosure.js";
import { recoverSameNameAnswerSubjects } from "./sameNameSubjects.js";
import { rederiveAfterPlanRestore } from "./packTrimming3.js";
import { renderStructureMapSurface } from "./structureMap2.js";
import { requestAnchorCandidates } from "./roleAndConcernScope3.js";
import { requiredQueryFacets } from "./changeAndReadinessEvidence2.js";
import { requiresRelatedAnswerContext } from "./answerCandidates.js";
import { resolveDominantSurfaceIndex } from "./coverageAndContinuation.js";
import { resolveRequestAnchorsForPack } from "./roleAndConcernScope3.js";
import { runClauseLocateRecovery } from "../concernRecovery.js";
import { sameNameRequiredDeclarations } from "./sameNameSubjects.js";
import { sameNameSubjectsByCache } from "./sameNameSubjects.js";
import { seededGenerousEnabled } from "../../../util/flags.js";
import { selectAnchorFocus } from "./anchorFocus3.js";
import { semanticFrontierGuardEnabled } from "../../../util/flags.js";
import { sfPackContextFor } from "../sfSatisfaction.js";
import { shaOfText } from "../../../util/handles.js";
import { shippedSurfaces } from "./wiringEvidence.js";
import { structureMapForAnswer } from "./structureMap.js";
import { structureMapMemberSurfaces } from "./structureMap2.js";
import { structureMapStateTypeSurfaces } from "./structureMap2.js";
import { surfaceAlreadyCoversWholeFile } from "../../../util/surfaceServedCoverage.js";
import { surfaceBodyCoversRange } from "./seedResolution.js";
import { surfaceContainsFacet } from "./changeAndReadinessEvidence2.js";
import { surfaceWhyHasMarker } from "./recursiveClosure.js";
import { tokenizeForEpoch } from "../../../state/session.js";
import { tokenizeQuery as tokenizeQueryForDiversification } from "../../retrieval/tokenize.js";
import { trace } from "../../../util/trace.js";
import { trimNextAgainstShippedEvidence } from "./answerCertificates2.js";
import { unqualifiedSymbolTail } from "./anchorFocus3.js";
import { verifiedAbsentIdentifiersByResult } from "./facetClosure2.js";
import { vocabularyStemNeighbours } from "../../retrieval/queryRecoveryTerms.js";
import { walkedFilesForQueryNamedResolution } from "./queryIntent3.js";
import { wholeTokenOccursIn } from "../askedPathClosure.js";
import { wordsFromIdentifierLikeText } from "../../retrieval/queryRecoveryTerms.js";

/**
 * WS3 answer profile: locate once, then materialize only the locator's primary
 * candidates and related symbols. Generic concern/role/style/wiring
 * augmentation is intentionally absent: an answer pack has no edit closure to
 * assemble, and every returned surface must already carry its body.
 *
 * Undefined is reserved for a truly empty locator result. An ambiguous answer
 * stays inside this profile as a bounded candidate-confirmation pack; falling
 * through to the generic flow would add edit-role/artifact augmentation to a
 * read-only investigation and reorder the locator's best candidate.
 */
export async function buildAnswerTaskPack(
  args: TaskPackArgs,
  query: string,
  workspace: string,
): Promise<TaskPackResult | undefined> {
  let locateResult = await locateTaskContext(workspace, {
    action: "locate",
    query,
    ...(args.path ? { path: args.path } : {}),
    ...(args.symbol ? { symbol: args.symbol } : {}),
    ...(args.lang ? { lang: args.lang } : {}),
    limit: Math.min(args.limit ?? MAX_SURFACES_DISTINCT, MAX_SURFACES_DISTINCT),
  });
  let rankingQuery = query;
  if (!locateResult.hit && !requiresRelatedAnswerContext(query)) {
    const recoveryQuery = answerRecoveryQuery(query);
    if (recoveryQuery !== undefined && recoveryQuery.toLowerCase() !== query.trim().toLowerCase()) {
      const recovered = await locateTaskContext(workspace, {
        action: "locate",
        query: recoveryQuery,
        ...(args.path ? { path: args.path } : {}),
        ...(args.symbol ? { symbol: args.symbol } : {}),
        ...(args.lang ? { lang: args.lang } : {}),
        limit: Math.min(args.limit ?? MAX_SURFACES_DISTINCT, MAX_SURFACES_DISTINCT),
      });
      const currentCandidates: ImpactCandidate[] = [...(locateResult.candidateDetails ?? [])];
      const recoveredCandidates: ImpactCandidate[] = recovered.hit
        ? [...recovered.primary, ...recovered.related]
        : [...(recovered.candidateDetails ?? [])];
      const currentHasImplementation = currentCandidates.some((candidate) => !isNonImplementationAnswerCandidate(candidate));
      const recoveredHasImplementation = recoveredCandidates.some((candidate) => !isNonImplementationAnswerCandidate(candidate));
      if (recoveredHasImplementation && (!currentHasImplementation || recoveryQuery.length < query.trim().length)) {
        locateResult = recovered;
        rankingQuery = recoveryQuery;
      }
    }
  }
  // TL_JA_QUERY_BRIDGE ((S) supported first-pack policy, default ON since
  // 2026-09-19 (USER ruling); explicit `=0` is the rollback path; MISS-ONLY
  // recovery, orchestrator Phase 3, 2026-09-19): a Japanese query against an
  // English-only codebase shares no lexical token with it. This never runs
  // unless the query above (and the text recovery above it) both already
  // abstained -- it can only ever turn a miss into a hit, never touch a
  // query that already resolves.
  if (!locateResult.hit) {
    const jaRecoveryQuery = jaBridgeRecoveryQuery(query, workspace);
    if (jaRecoveryQuery !== undefined) {
      const jaRecovered = await locateTaskContext(workspace, {
        action: "locate",
        query: jaRecoveryQuery,
        ...(args.path ? { path: args.path } : {}),
        ...(args.symbol ? { symbol: args.symbol } : {}),
        ...(args.lang ? { lang: args.lang } : {}),
        limit: Math.min(args.limit ?? MAX_SURFACES_DISTINCT, MAX_SURFACES_DISTINCT),
      });
      const jaCurrentCandidates: ImpactCandidate[] = [...(locateResult.candidateDetails ?? [])];
      const jaRecoveredCandidates: ImpactCandidate[] = jaRecovered.hit
        ? [...jaRecovered.primary, ...jaRecovered.related]
        : [...(jaRecovered.candidateDetails ?? [])];
      const jaCurrentHasImplementation = jaCurrentCandidates.some((c) => !isNonImplementationAnswerCandidate(c));
      const jaRecoveredHasImplementation = jaRecoveredCandidates.some((c) => !isNonImplementationAnswerCandidate(c));
      const jaExpansions = jaBridgeExpansionTokens(query, workspace);
      // Defect 3 (orchestrator Phase 4, 2026-09-19): a locator hit is not by
      // itself proof the TOP candidate is what the expansions actually
      // named -- require the top candidate's own path/symbol (and, when
      // read, its served text) to be EVIDENCED by the expansions before
      // ever adopting. This is the fix for the reported dangerous defect
      // (a confident act-answer serving an unrelated file): the locator
      // hit alone used to be sufficient.
      // Two measured misses shaped this (2026-09-19, dev eval): (1) the
      // locator often matches BODY text (why "exact-text") in a file whose
      // path says little -- "orderStateMachine.ts" for a cancel/coupon/stock
      // question -- so the window around the matched line counts as evidence
      // too, not only path and symbol words; (2) an ABSTAIN's loudest
      // candidate can be an unsupported filename match ("errorCodes.ts" for
      // コード) standing in front of supported ones, so an abstain is judged
      // on, and adopted with, its SUPPORTED candidates only.
      const jaSupportCache = new FileReadCache();
      const jaCandidateWords = (candidate: ImpactCandidate): { pathAndSymbolWords: string[]; textWords: string[] } => {
        const pathAndSymbolWords = [
          ...wordsFromIdentifierLikeText(candidate.path),
          ...(candidate.symbol ? wordsFromIdentifierLikeText(candidate.symbol) : []),
        ];
        const content = readCached(workspace, candidate.path, jaSupportCache);
        if (content === undefined) return { pathAndSymbolWords, textWords: [] };
        const lines = content.split(/\r?\n/);
        const span = /^(\d+)-(\d+)$/.exec(candidate.range ?? "");
        const from = Math.max(1, (span ? Number(span[1]) : candidate.line) - 12);
        const to = Math.min(lines.length, (span ? Number(span[2]) : candidate.line) + 24);
        return { pathAndSymbolWords, textWords: wordsFromIdentifierLikeText(lines.slice(from - 1, to).join("\n")) };
      };
      const jaSupportedCandidates = jaRecoveredCandidates.filter((candidate) =>
        expansionsSupportCandidate(jaExpansions, jaCandidateWords(candidate)));
      const jaSupported = jaRecovered.hit
        ? jaRecoveredCandidates[0] !== undefined && jaSupportedCandidates.includes(jaRecoveredCandidates[0])
        : jaSupportedCandidates.length > 0;
      const jaAdopted = jaSupported && (jaRecovered.hit || (jaRecoveredHasImplementation && !jaCurrentHasImplementation));
      trace("ja_bridge", {
        expansions: jaExpansions,
        vocab_partial: getWorkspaceJaBridgeVocabulary(workspace).partial,
        adopted: jaAdopted,
        ...(jaAdopted ? {} : { reason: jaSupported ? "no-implementation-gain" : "unsupported" }),
      }, workspace);
      if (jaAdopted) {
        const jaSupportedSet = new Set<ImpactCandidate>(jaSupportedCandidates);
        locateResult = jaRecovered.hit
          ? jaRecovered
          : { ...jaRecovered, candidateDetails: (jaRecovered.candidateDetails ?? []).filter((c) => jaSupportedSet.has(c)) };
        rankingQuery = jaRecoveryQuery;
      }
    }
  }
  // 2026-08-21 answer-path-inherits-locator fix (W4-B, defect 1): the text
  // recovery above can still leave an "ambiguous" abstain when the
  // candidate pool is crowded by same- or higher-confidence noise a plain-
  // word query cannot out-rank (a bench/fixture's loose prose match, or a
  // spec file that quotes the query text verbatim, both out-score a real
  // "query-symbol" hit on raw locator confidence). When the query
  // explicitly NAMES one candidate's own file — its basename appears in the
  // query as a whole word — and that candidate already carries a resolved
  // `.symbol` from a real structural locator match (not a symbol-less
  // prose/variant-text hit), retry the locator anchored on that exact file
  // + symbol: `symbol` makes Layer 1 resolve it directly (bypassing the
  // confidence race entirely), and scoping `path` to the file's DIRECTORY
  // (not the bare file) keeps sibling files in the walk so import-edge
  // related surfaces can still resolve. A successful, matching hit REPLACES
  // `locateResult` so the primary + required-related handling below runs
  // exactly as it would for a query the locator resolved cleanly on the
  // first try.
  if (!locateResult.hit && !requiresRelatedAnswerContext(query)) {
    const anchor = pickNamedFileAbstainAnchor(locateResult.candidateDetails ?? [], query);
    if (anchor !== undefined && anchor.symbol !== undefined) {
      const anchorSymbol = anchor.symbol;
      const anchored = await locateTaskContext(workspace, {
        action: "locate",
        query,
        path: path.dirname(anchor.path),
        symbol: anchorSymbol,
        ...(args.lang ? { lang: args.lang } : {}),
        limit: Math.min(args.limit ?? MAX_SURFACES_DISTINCT, MAX_SURFACES_DISTINCT),
      });
      if (
        anchored.hit
        && anchored.primary.some((p) => p.path === anchor.path && p.symbol === anchorSymbol)
      ) {
        locateResult = anchored;
      }
    }
  }
  const cache = new FileReadCache();
  const selected: ImpactCandidate[] = [];
  const seen = new Set<string>();
  const primaryCount = locateResult.hit ? locateResult.primary.length : 0;
  const locatorCandidates: ImpactCandidate[] = locateResult.hit
    ? [...locateResult.primary, ...locateResult.related]
    : rankAbstainCandidates(locateResult.candidateDetails ?? []);
  // 2026-08-21 answer-path-inherits-locator fix (W4-B, defect 1, rule b/c):
  // once the locator resolves a primary, its own verdict — the primary
  // itself plus any related surface it flagged `required` (an import-edge
  // callee or a query-symbol neighbour) — must win a guaranteed front seat
  // in the served evidence. Recorded here, before rankAnswerEvidenceCandidates
  // re-scores everything from its own independent content/focus signal, so
  // a textually louder but structurally uninvolved extra (a facet/
  // responsibility hit) can never crowd a required surface out of a capped
  // selection — see orderByLocatorVerdict below.
  const requiredLocatorPaths = new Set<string>(
    locateResult.hit
      ? [
          ...locateResult.primary.map((c) => c.path),
          ...locateResult.related.filter((c) => c.required === true).map((c) => c.path),
        ]
      : [],
  );
  const primaryLocatorPath = locateResult.hit ? locateResult.primary[0]?.path : undefined;
  const responsibilityCandidates = await discoverAnswerResponsibilityCandidates(
    args,
    query,
    workspace,
    cache,
  );
  // 2026-10-29 (first-hop field report): the anchors the request NAMES — a dotted
  // member (`res.redirect`), an identifier, a quoted or bracketed literal — are
  // looked up in the workspace before any lexical ranking, and their declaration /
  // exact-text windows lead the candidate list (anchorFirst.ts).
  const anchorResolution = await resolveRequestAnchorsForPack(args, query, workspace, cache);
  const anchorCandidates = requestAnchorCandidates(anchorResolution);
  const locatedCandidates = [...anchorCandidates, ...locatorCandidates, ...responsibilityCandidates]
    .filter((candidate, index, all) => all.findIndex((other) =>
      other.path === candidate.path
      && other.symbol === candidate.symbol
      && other.range === candidate.range
    ) === index);
  // A successful locator hit can still be only a keyword-sized range on the
  // exact class/module named by the caller. Rank and refocus both hit and
  // abstain candidates so explicit identifiers expand to their implementation
  // symbol before the answer contract is certified.
  const rankingEvidenceQuery = rankingQuery === query
    ? query
    : `${query}\n${rankingQuery}`;
  const rankedAnswerCandidates = await rankAnswerEvidenceCandidates(
    locatedCandidates,
    rankingEvidenceQuery,
    workspace,
    cache,
  );
  const explicitAnswerNames = new Set(explicitCodeIdentifiers(query).map(normIdent));
  // The anchors lead the answer (their declaration IS the subject) only where the locator agrees
  // that subject is in their file. A locator that found its primary elsewhere (the focal the
  // request names in plain words, `resend300`; a test file the request also asks for) has
  // understood something the anchors do not cover: the pack is then decided exactly as it would
  // have been without them, and the anchors only LEAD the evidence it serves (the lead block
  // below) — they neither settle the decision state nor displace the locator's own selection.
  const anchorRankedEntries = rankedAnswerCandidates.filter((entry) => entry.anchorDefinition === true || entry.anchorLiteral === true);
  const anchorOwnedPaths = new Set(anchorRankedEntries.map((entry) => entry.candidate.path));
  // A request that also asks for test evidence ("Explain Cache.get … its tests") is not only about
  // the declaration either: the locator's own selection decides, the anchors lead.
  // …nor when the ranking itself already holds exact identifiers the request names in other files
  // (`OrderService`, `PaymentService` beside a `cancelOrder` that is defined in the frontend): that
  // is the baseline's answer, and its primary stays.
  const exactElsewhere = rankedAnswerCandidates.some((entry) =>
    entry.anchorDefinition !== true && entry.anchorLiteral !== true
    && entry.exactIdentifier && !anchorOwnedPaths.has(entry.candidate.path));
  const anchorsAgreeWithLocator = anchorRankedEntries.length === 0
    || (
      !queryRequestsTestEvidence(query)
      && !exactElsewhere
      && (!locateResult.hit || primaryLocatorPath === undefined || anchorOwnedPaths.has(primaryLocatorPath))
    );
  const deferredAnchorEntries: RankedAnswerEvidenceCandidate[] = [];
  if (!anchorsAgreeWithLocator) {
    for (const entry of anchorRankedEntries) {
      deferredAnchorEntries.push(entry);
      rankedAnswerCandidates.splice(rankedAnswerCandidates.indexOf(entry), 1);
    }
  }
  rankedAnswerCandidates.sort((a, b) => {
    const namedPath = (entry: RankedAnswerEvidenceCandidate): number => Number(
      explicitAnswerNames.has(normIdent(path.basename(
        entry.candidate.path,
        path.extname(entry.candidate.path),
      ))),
    );
    return Number(b.anchorDefinition === true) - Number(a.anchorDefinition === true)
      || Number(b.anchorLiteral === true) - Number(a.anchorLiteral === true)
      || namedPath(b) - namedPath(a);
  });
  if (
    rankedAnswerCandidates[0] !== undefined
    && !isNonImplementationAnswerCandidate(rankedAnswerCandidates[0].candidate)
    && !/\b(?:test|tests|spec|fixture|bench|benchmark)\b/i.test(query)
  ) {
    const implementationOwned = rankedAnswerCandidates.filter((entry) =>
      !isNonImplementationAnswerCandidate(entry.candidate)
      || entry.anchorDefinition === true
      || entry.anchorLiteral === true
      || (
        entry.candidate.symbol !== undefined
        && explicitAnswerNames.has(normIdent(entry.candidate.symbol))
      )
    );
    rankedAnswerCandidates.splice(0, rankedAnswerCandidates.length, ...implementationOwned);
  }
  // 2026-08-21 answer-focus precision fix, item (b): see
  // dropWeakCrossRootAndNonSourceAnswerCandidates — must run AFTER the
  // implementation-ownership filter above (which already needs real
  // candidates to compare) and BEFORE `candidates`/`selected`/`surfaces` are
  // derived from rankedAnswerCandidates below, so a weak/off-root/non-source
  // entry never reaches the served pack. `weakEvidenceDropped` feeds the
  // coverage-honesty override further down.
  const weakEvidenceDropped = dropWeakCrossRootAndNonSourceAnswerCandidates(rankedAnswerCandidates);
  // C-1 (wave 4): when the caller literally named an identifier and no ranked
  // candidate carries it, run the literal scan the model would otherwise be
  // routed into (confirm_candidates -> tl_search_files find) and serve the
  // definition directly. Absent identifiers are remembered for the readiness
  // obligation's decision-grade absence wording.
  //
  // WP-N (eval-0929 §8): "absent" is the whole-identifier verdict
  // (`explicitIdentifierAbsence`) for every named identifier no ranked
  // candidate already declares under exactly that name (a ranked symbol
  // spelled as the query spelled it IS a whole occurrence — no scan needed).
  const identifierAbsences = explicitIdentifierAbsences(
    workspace,
    explicitCodeIdentifiers(query).slice(0, 6).filter((identifier) =>
      !anchorResolution.definedIds.some((defined) => normIdent(defined) === normIdent(identifier))
      && !rankedAnswerCandidates.some((entry) =>
        entry.candidate.symbol !== undefined && unqualifiedSymbolTail(entry.candidate.symbol) === identifier)),
    () => freshAbsenceUniverse(workspace),
    cache,
  );
  // WP-O: read BEFORE the recovery below can inject anything — whether that
  // function reaches its per-identifier loop at all (its own early return).
  const explicitRecoveryRan = !rankedAnswerCandidates.some((entry) => entry.exactIdentifier);
  const verifiedAbsentIdentifiers = await recoverExplicitIdentifierAnswerCandidates(
    args,
    query,
    workspace,
    rankedAnswerCandidates,
    cache,
    identifierAbsences,
  );
  // WP-O (eval-0929 §8): an explicitly named subject with no located
  // declaration of its own is answered from the declaration it means, never
  // from the locator's call-site candidates — see the "WP-O" section header
  // beside `recoverSameNameAnswerSubjects`.
  const { subjects: sameNameSubjects, additions: sameNameAdditions } = await recoverSameNameAnswerSubjects(
    args,
    query,
    workspace,
    rankedAnswerCandidates,
    cache,
    identifierAbsences,
    explicitRecoveryRan,
  );
  if (sameNameSubjects.size > 0) sameNameSubjectsByCache.set(cache, sameNameSubjects);
  // …and the anchor's declaration does the recovery's job: with no locator-ranked candidate for the
  // named identifier, the pack baseline would have injected it as `answer-explicit-identifier-recovery`
  // (recoverExplicitIdentifierAnswerCandidates stands down once any exact candidate leads).
  // The exact candidates the ranking WITHOUT the anchors' declarations would have carried: an
  // anchor's declaration counts only where the locator's own candidate for that file ranked as the
  // named identifier too (`locatorAlsoExact`). The decision state of a pack — one exact site
  // (`exactLocatedAnswer`), a recovered one, a candidate list — is read from these, so naming a
  // second identifier that the workspace merely DEFINES (a constant `isRetryable` reads) does not
  // turn a settled answer into a choice between two files.
  const decisionExactEntries = rankedAnswerCandidates.filter((entry) =>
    entry.exactIdentifier && (entry.anchorDefinition !== true || entry.locatorAlsoExact === true));
  const recoveredExactAnswer =
    rankedAnswerCandidates[0]?.candidate.why === "answer-explicit-identifier-recovery"
    || (rankedAnswerCandidates[0]?.anchorDefinition === true && decisionExactEntries.length === 0);
  const strongEvidenceAnswer = rankingQuery !== query
    && !locateResult.hit
    && rankedAnswerCandidates[0]?.strongEvidence === true
    && !isNonImplementationAnswerCandidate(rankedAnswerCandidates[0].candidate);
  const topResponsibility = rankedAnswerCandidates[0];
  const responsibilityRunnerUp = rankedAnswerCandidates[1];
  // 2026-08-21 answer-path-inherits-locator fix (W4-B, defect 1, rule c):
  // "semantic-responsibility" resolution corrects the locator's SYMBOL-level
  // focus within a file it already got right just as often as it resolves a
  // colloquial identifier the codebase never literally used (T03's fixture:
  // "OrderOrchestrator" -> OrderService.java) — semanticSignalRegression's
  // T03 pin is exactly the former: the locator DOES resolve OrderService.java
  // as primary, just anchored on the wrong member (`cancel`, a strong lexical
  // match but not what the query asks about); responsibility-discovery names
  // the SAME FILE and must still be allowed to trigger the multi-facet
  // member-expansion below (materializeNamedAnswer) that widens a narrow,
  // wrongly-focused single-method hit into the real class-level answer. What
  // rule (c) actually forbids is a DIFFERENT file — one with no structural
  // relation to the locator's primary — winning the sole-answer slot on raw
  // textual density alone. Gate on that (path identity), not on
  // `locateResult.hit`/content-strength, which cannot tell the two apart:
  // both look like "a strong-evidence responsibility hit at rankedAnswerCandidates[0]".
  const responsibilityDisplacesLocatorPrimary = locateResult.hit
    && primaryLocatorPath !== undefined
    && topResponsibility !== undefined
    && topResponsibility.candidate.path !== primaryLocatorPath;
  const responsibilityResolved = !responsibilityDisplacesLocatorPrimary
    && topResponsibility !== undefined
    && responsibilityCandidates.some((candidate) => candidate.path === topResponsibility.candidate.path)
    && topResponsibility.strongEvidence
    && (
      responsibilityRunnerUp === undefined
      || !responsibilityRunnerUp.strongEvidence
      || topResponsibility.score - responsibilityRunnerUp.score >= 1
    );
  const strongRecoveredAnswer = !requiresRelatedAnswerContext(query) && (
    responsibilityResolved || strongEvidenceAnswer
      || (!locateResult.hit && isStrongRecoveredAnswerCandidate(rankedAnswerCandidates, rankingEvidenceQuery))
  );
  const exactLocatedPaths = new Set(
    (decisionExactEntries.length > 0 ? decisionExactEntries : rankedAnswerCandidates.filter((entry) => entry.exactIdentifier))
      .map((entry) => entry.candidate.path),
  );
  const topAnswerPathStem = rankedAnswerCandidates[0]
    ? normIdent(path.basename(
        rankedAnswerCandidates[0].candidate.path,
        path.extname(rankedAnswerCandidates[0].candidate.path),
      ))
    : "";
  const exactIdentifierNames = new Set(explicitCodeIdentifiers(query).map(normIdent));
  // Naming one symbol makes its own definition an exact answer, but it does
  // not make a request to trace a relation or retain supporting context a
  // single-surface question.  Collapsing that shape here prevented the
  // producer from ever emitting the optional context which the semantic
  // frontier is meant to suppress only from continuations.  Keep this a
  // bounded answer-pack concern (rather than an open-universe obligation):
  // the caller asked for the named answer plus one contextual relationship,
  // not every consumer or reference in the repository.
  const exactNamedFileAnswer = exactIdentifierNames.has(topAnswerPathStem)
    && rankedAnswerCandidates[0] !== undefined
    && !isNonImplementationAnswerCandidate(rankedAnswerCandidates[0].candidate);
  // An exact identifier locates the start of an exhaustive scan; it cannot
  // collapse the open universe to one answer surface.
  // WP-O (eval-0929 §8): a question about an AMBIGUOUS same-name subject (see
  // `recoverSameNameAnswerSubjects`) is answered in THIS pack from every one
  // of its declarations — the certificate discloses the ambiguity by name
  // (`sameNameAmbiguityDisclosures`). Without this the injected declarations
  // tie as exact candidates, the pack drops to a candidate list, and its
  // `discover` defers the same choice to a second hop. Only when every exact
  // candidate of the pack IS such a declaration: a question with another
  // located subject keeps the ordinary multi-candidate selection.
  const sameNameAnswerPaths = new Set([...sameNameSubjects.values()]
    .flatMap((subject) => sameNameRequiredDeclarations(subject).map((declaration) => declaration.path)));
  const sameNameAmbiguousAnswer = [...sameNameSubjects.values()].some((subject) => subject.bound === undefined)
    && !hasOpenUniverseIntent(query)
    && !requiresRelatedAnswerContext(query)
    && exactLocatedPaths.size > 0
    && [...exactLocatedPaths].every((exactPath) => sameNameAnswerPaths.has(exactPath));
  // 2026-10-29: the declaration(s) of the anchors the request names, when they
  // are the ONLY exact-identifier site of the pack (one file): that file's
  // declarations ARE the answer's subject, located or not by the lexical locator.
  const anchorEntries = anchorsAgreeWithLocator
    ? rankedAnswerCandidates.filter((entry) => entry.anchorDefinition === true || entry.anchorLiteral === true)
    : deferredAnchorEntries;
  const anchorDefinitionLed = rankedAnswerCandidates[0]?.anchorDefinition === true
    // The decision state stays the locator's: an anchor the locator itself did not hit
    // leads the evidence but does not turn a candidate list into a settled answer.
    && locateResult.hit
    && exactLocatedPaths.size === 1
    && !sameNameAmbiguousAnswer && !hasOpenUniverseIntent(query) && !requiresRelatedAnswerContext(query);
  const exactLocatedAnswer = !sameNameAmbiguousAnswer && !hasOpenUniverseIntent(query) && !requiresRelatedAnswerContext(query) && (exactNamedFileAnswer
    || anchorDefinitionLed
    || (recoveredExactAnswer && exactLocatedPaths.size === 1)
    || (locateResult.hit
      && rankedAnswerCandidates[0]?.exactIdentifier === true
      && exactLocatedPaths.size === 1));
  let candidates = anchorDefinitionLed
    ? rankedAnswerCandidates.filter((entry) => entry.anchorDefinition === true || entry.anchorLiteral === true).map((entry) => entry.candidate)
    : exactLocatedAnswer
    ? [rankedAnswerCandidates[0]!.candidate]
    : sameNameAmbiguousAnswer
    ? rankedAnswerCandidates
        .filter((entry) => entry.exactIdentifier)
        .slice(0, MAX_SURFACES_DISTINCT)
        .map((entry) => entry.candidate)
    : strongEvidenceAnswer
    ? rankedAnswerCandidates
        .filter((entry) => entry.strongEvidence && !isNonImplementationAnswerCandidate(entry.candidate))
        .slice(0, 3)
        .map((entry) => entry.candidate)
    : strongRecoveredAnswer
    ? [rankedAnswerCandidates[0]!.candidate]
    : orderByLocatorVerdict(rankedAnswerCandidates, requiredLocatorPaths, primaryLocatorPath);
  let selectionLimit = sameNameAmbiguousAnswer || anchorDefinitionLed
    ? candidates.length
    : locateResult.hit
    ? exactLocatedAnswer ? 1 : MAX_SURFACES_DISTINCT
    : strongEvidenceAnswer
    ? 3
    : strongRecoveredAnswer
    ? 1
    : 3;
  // The anchors lead whatever the selection above chose (orderByLocatorVerdict
  // puts the locator's primary first); the rest of the selection follows them.
  if (anchorEntries.length > 0 && !anchorDefinitionLed) {
    const anchorCandidateKey = (candidate: ImpactCandidate): string => `${candidate.path}\0${candidate.range ?? candidate.line}`;
    const anchorKeys = new Set(anchorEntries.map((entry) => anchorCandidateKey(entry.candidate)));
    // Anchors the locator does not agree with (`anchorsAgreeWithLocator`) follow the locator's own
    // front instead: its primary stays the pack's primary (the surface the member excerpts, the
    // structure map and the focus are planned against).
    const selectionWithoutAnchors = candidates.filter((candidate) => !anchorKeys.has(anchorCandidateKey(candidate)));
    const front = anchorsAgreeWithLocator ? 0 : Math.max(1, primaryCount);
    candidates = [
      ...selectionWithoutAnchors.slice(0, front),
      ...anchorEntries.map((entry) => entry.candidate),
      ...selectionWithoutAnchors.slice(front),
    ];
    selectionLimit = Math.max(selectionLimit, anchorEntries.length + 1);
  }
  // TL_CONCERN_RECOVERY / prose diversification (Phase 3, orchestrator
  // adjudication 2026-09-19). Both gated on concernRecoveryEnabled() and both
  // computed ONLY from `candidates`/`selectionLimit` as derived above this
  // line — every decision value above (recoveredExactAnswer,
  // strongEvidenceAnswer, exactLocatedPaths, responsibilityResolved,
  // strongRecoveredAnswer, exactLocatedAnswer) was computed from
  // rankedAnswerCandidates BEFORE either mechanism ever runs, so both
  // evaluate identically to the flag-off case (Blocker 1: an earlier version
  // injected into rankedAnswerCandidates itself and collapsed a
  // multi-concern query to one certified surface — see concernRecovery.ts's
  // module doc).
  const concernRecoveredPaths = new Set<string>();
  if (concernRecoveryEnabled()) {
    concernRecoveryEntryCountForTest += 1;
    // Diversification only reorders the multi-surface orderByLocatorVerdict
    // list — never a mode that already certified a narrow single/triple
    // answer, and it never adds or drops a candidate the locator produced.
    // FX-CR3 (2026-09-19): pinned to `primaryCount` (floored at 1, same
    // floor mergeConcernAdditions's own displacement math uses below) so
    // diversify can freely reorder everything ELSE but never pulls the
    // locator's own top-ranked candidate out of the front slot --
    // extractRequestItems does not promise clause order follows query-text
    // order, so clause-order-first reordering could otherwise swap it out
    // from under downstream consumers that key off slot 0 (SF-demote's
    // primary/non-demotable classification; see diversifyByConcern's own
    // doc for the measured sfShippedBookings.spec.ts failure this closes).
    if (!exactLocatedAnswer && !sameNameAmbiguousAnswer && !strongEvidenceAnswer && !strongRecoveredAnswer) {
      const clauseTexts = extractRequestItems(query).map((requestItem) => requestItem.text);
      candidates = diversifyByConcern(candidates, clauseTexts, tokenizeQueryForDiversification, Math.max(1, primaryCount));
    }
    const concernCandidates = await recoverConcernCandidates(args, query, workspace, cache);
    const existingConcernKeys = new Set(
      candidates.map((c) => `${c.path}\0${c.symbol ?? ""}\0${c.range ?? c.line}`),
    );
    let concernDisplacementBudget = 2;
    // Named definitions (concernRecovery.ts's own block doc): a type the
    // request names, whose name is the stem of exactly one implementation
    // file, is served in THIS pack. Merged before the literal and per-clause
    // mechanisms so a stated name outranks an inferred one for the room and
    // the two-slot displacement budget all three share.
    const namedIdentifiers = explicitCodeIdentifiers(query);
    const namedFiles = namedIdentifiers.length === 0 ? [] : namedDefinitionFiles(
      namedIdentifiers,
      walkedFilesForQueryNamedResolution(workspace, false),
      {
        ...(args.path ? { scopePath: args.path } : {}),
        isTestPath: isTestConcernPath,
        servedPaths: new Set(candidates.slice(0, Math.min(candidates.length, selectionLimit)).map((c) => c.path)),
      },
    );
    if (namedFiles.length > 0) {
      const namedAdditions: ImpactCandidate[] = [];
      for (const named of namedFiles) {
        const addition = await namedDefinitionCandidate(named, query, namedIdentifiers, workspace, cache);
        if (addition === undefined) continue;
        const key = `${addition.path}\0${addition.symbol ?? ""}\0${addition.range ?? addition.line}`;
        if (existingConcernKeys.has(key)) continue;
        existingConcernKeys.add(key);
        namedAdditions.push(addition);
      }
      const namedMerge = mergeConcernAdditions(
        candidates,
        selectionLimit,
        namedAdditions,
        primaryCount,
        concernDisplacementBudget,
        MAX_SURFACES_DISTINCT,
      );
      candidates = namedMerge.candidates;
      selectionLimit = namedMerge.selectionLimit;
      concernDisplacementBudget -= namedMerge.displacedUsed;
      for (const path of namedMerge.appliedPaths) concernRecoveredPaths.add(path);
    }
    if (concernCandidates.length > 0) {
      const additions: ImpactCandidate[] = [];
      for (const concernCandidate of concernCandidates) {
        const impact: ImpactCandidate = {
          path: concernCandidate.path,
          line: concernCandidate.line,
          range: concernCandidate.range,
          surface: classifySurface(concernCandidate.path),
          why: "answer-explicit-identifier-recovery",
          confidence: 0.95,
          ...(concernCandidate.symbol ? { symbol: concernCandidate.symbol } : {}),
        };
        const key = `${impact.path}\0${impact.symbol ?? ""}\0${impact.range ?? impact.line}`;
        if (existingConcernKeys.has(key)) continue;
        existingConcernKeys.add(key);
        additions.push(impact);
      }
      // Additive only: candidates gained, selectionLimit only ever raised
      // (never lowered), by the count of entries actually promoted or added.
      // Where the additions go decides whether they are ever selected.
      // FX-CR1 (2026-09-19): a concern whose file is ALREADY inside the
      // selection window is DROPPED outright -- the window's own entry
      // stands, never a duplicate row for the same path (this used to be
      // "appended harmlessly", but "harmlessly" was false whenever a later
      // stage keyed off row identity, e.g. TL_SF_DEMOTE's sibling-window
      // check). A concern whose file exists in `candidates` beyond the
      // window PROMOTES that same existing entry into the window (never a
      // second object for the same path); a genuinely new path is added.
      // Either way: free room first, then one of the window's LAST slots --
      // at most two combined across both mechanisms, and never a locator
      // primary. mergeConcernAdditions (concernRecovery.ts) implements this
      // so the per-clause mechanism below can share it, spending ONE
      // two-slot displacement budget ACROSS both mechanisms via
      // `concernDisplacementBudget` rather than two-per-mechanism.
      const literalMerge = mergeConcernAdditions(
        candidates,
        selectionLimit,
        additions,
        primaryCount,
        concernDisplacementBudget,
        MAX_SURFACES_DISTINCT,
      );
      candidates = literalMerge.candidates;
      selectionLimit = literalMerge.selectionLimit;
      concernDisplacementBudget -= literalMerge.displacedUsed;
      for (const path of literalMerge.appliedPaths) concernRecoveredPaths.add(path);
    }
    // Per-CLAUSE locate recovery (Phase 4/5, Agent D, 2026-09-19): the two
    // mechanisms above close a clause that names an enumerated/sibling
    // LITERAL. A clause with no literal at all -- a plain prose question,
    // e.g. "..., and where is user authentication performed?" -- seeds
    // nothing in either of them, and reordering cannot manufacture a
    // candidate the locator's ONE fused search over the WHOLE query never
    // produced in the first place. Re-locates on each UNCOVERED clause's
    // OWN text (never the whole query, never `symbol`) and folds in at
    // most one pick per clause through the same merge planning above.
    // hygienicClauseWorkList (concernRecovery.ts) first collapses the
    // budget-burning shapes diagnosed in the Phase 4 report -- several
    // BYTE-IDENTICAL relation-clause copies (one per enumerated actor noun),
    // and one topic item PER enumerated/backtick literal member -- to one
    // representative each, and orders genuinely literal-free prose clauses
    // first, so a real per-clause locate is never starved by its own
    // query's fragmentation. Cost guard: never locates when the query has
    // <2 clauses after hygiene, or every clause is already covered.
    const clauseWorkList = hygienicClauseWorkList(extractRequestItems(query));
    if (clauseWorkList.length >= 2) {
      const coverageWindowSize = Math.min(candidates.length, selectionLimit);
      const coverageWindow = candidates.slice(0, coverageWindowSize);
      const clauseRecovery = await runClauseLocateRecovery<ImpactCandidate>(clauseWorkList, coverageWindow, {
        tokenize: tokenizeQueryForDiversification,
        // `limit` is decided PER CALL by runClauseLocateRecovery itself
        // (FIRST_ATTEMPT_LOCATE_LIMIT vs the wider RETRY_LOCATE_LIMIT) --
        // measured (diagnose_phase2_limit.mts): a uniformly narrow limit
        // does not meaningfully reduce locate wall-clock (the underlying
        // multi-layer search/walk still runs; `limit` mostly truncates
        // OUTPUT) but DOES actively crowd out a retry's own rescue
        // candidate behind closer-but-wrong lexical matches, defeating the
        // mechanism outright.
        locate: (queryText, limit) => locateTaskContext(workspace, {
          action: "locate",
          query: queryText,
          ...(args.path ? { path: args.path } : {}),
          ...(args.lang ? { lang: args.lang } : {}),
          limit,
        }),
        rankAbstain: rankAbstainCandidates,
        isImplementation: (candidate) => !isNonImplementationAnswerCandidate(candidate),
        hasSymbol: (candidate) => candidate.symbol !== undefined,
        isTestPath: (candidate) => isTestConcernPath(candidate.path),
        isDocPath: (candidate) => candidate.surface === "doc",
        containsJapanese,
        stemNeighbours: (token) => vocabularyStemNeighbours(token, workspace),
        jaExpansionTokens: (clauseText) => jaBridgeExpansionTokens(clauseText, workspace),
        jaRecoveryQuery: (clauseText) => jaBridgeRecoveryQuery(clauseText, workspace),
        now: () => Date.now(),
        boundedWork: boundedClauseRecoveryWork(),
        signal: currentRequestSignal(),
        onLocateAttempt: recordClauseLocateAttempt,
      });
      if (clauseRecovery.picks.length > 0) {
        const clauseAdditions: ImpactCandidate[] = [];
        for (const { candidate } of clauseRecovery.picks) {
          const key = `${candidate.path}\0${candidate.symbol ?? ""}\0${candidate.range ?? candidate.line}`;
          if (existingConcernKeys.has(key)) continue;
          existingConcernKeys.add(key);
          clauseAdditions.push(candidate);
        }
        if (clauseAdditions.length > 0) {
          // Same rule as the literal merge above (FX-CR1): drop/promote/add
          // by path, never a duplicate row for a path already in `candidates`.
          const clauseMerge = mergeConcernAdditions(
            candidates,
            selectionLimit,
            clauseAdditions,
            primaryCount,
            concernDisplacementBudget,
            MAX_SURFACES_DISTINCT,
          );
          candidates = clauseMerge.candidates;
          selectionLimit = clauseMerge.selectionLimit;
          concernDisplacementBudget -= clauseMerge.displacedUsed;
          for (const path of clauseMerge.appliedPaths) concernRecoveredPaths.add(path);
        }
      }
    }
  }
  // WP-O (eval-0929 §8): the declaration(s) a same-name subject binds to,
  // when the question's OTHER subjects already decided the answer mode (see
  // `recoverSameNameAnswerSubjects`) — strictly additive, zero displacement,
  // before the facet hook below so its closure sees the bound focal as
  // already selected.
  if (sameNameAdditions.length > 0) {
    const sameNameMerge = mergeConcernAdditions(
      candidates,
      selectionLimit,
      sameNameAdditions,
      primaryCount,
      0,
      MAX_SURFACES_DISTINCT,
    );
    candidates = sameNameMerge.candidates;
    selectionLimit = sameNameMerge.selectionLimit;
    for (const path of sameNameMerge.appliedPaths) concernRecoveredPaths.add(path);
  }
  // TL_CALLER_EXPANSION (WP-S9, 2026-09-20; DEFAULT OFF — util/flags.ts's
  // `callerExpansionEnabled` carries the full rationale). Runs AFTER every
  // mechanism above, on the selection those mechanisms settled, and only on
  // the FIRST pack of the task (a `qref` replay re-serves a decided pack, the
  // same rule the seeded per-clause recovery applies to itself). "Where does
  // the request enter" is a STRUCTURAL relation: the entry point's file holds
  // none of the clause's words, so no amount of lexical locating above can
  // reach it, and a re-pack cannot either.
  //
  // Strictly additive, and more conservative than the concern mechanisms
  // above: the displacement budget passed to mergeConcernAdditions is ZERO, so
  // an addition takes free room inside the window or lands beyond it, and a
  // surface the pack already selected is never replaced, reordered or dropped.
  // Readiness and obligations are untouched — a caller is evidence, not an
  // obligation — and the additions ride the SAME candidateToSurface/served
  // ledger path as every other surface, so `remaining`, the served ledger and
  // the certificates keep describing exactly what shipped.
  if (callerExpansionEnabled() && args.taskQueryRefReplay !== true) {
    callerExpansionEntryCountForTest += 1;
    const callerWindow = candidates.slice(0, Math.min(candidates.length, selectionLimit));
    const callerAdditions = await recoverCallerExpansionCandidates(args, query, workspace, cache, callerWindow);
    if (callerAdditions.length > 0) {
      const callerMerge = mergeConcernAdditions(
        candidates,
        selectionLimit,
        callerAdditions,
        primaryCount,
        0, // never displace: a caller is a bonus surface, never a replacement
        MAX_SURFACES_DISTINCT,
      );
      candidates = callerMerge.candidates;
      selectionLimit = callerMerge.selectionLimit;
      // Same drop-rule exemption the concern additions take below: an addition
      // whose call site has no resolvable enclosing symbol carries no
      // `.symbol`, and the "range-only hit past primaryCount is locator noise"
      // rule would otherwise silently drop the very surface this mechanism
      // went and proved.
      for (const path of callerMerge.appliedPaths) concernRecoveredPaths.add(path);
    }
  }
  // v0.16 6t-7 T03: a short, map-shaped question about a type too large for
  // one surface is answered from the type's STRUCTURE MAP (structureMap.ts).
  // Decided here, on the candidate the pack serves first, so the facet hook
  // just below plans the flow facets against the same windows the surface
  // then serves (`renderStructureMapSurface`).
  const structureMapChoice = await structureMapForAnswer(query, candidates[0], workspace, cache);
  // The map the pack serves. TL_EFF_MAP_ANSWER_FIRST: the ordinary one — the reply of the
  // request without the flag — unless the answer-first candidate's first page holds
  // everything the facets plan against it, which the facet hook seat just below decides
  // BEFORE anything is built or booked (`answerFirstPageHolds`).
  let structureMap: AnswerStructureMap | undefined = structureMapChoice.ordinary;
  // …and, when the answer-first page is adopted, what puts the chain back on the ordinary
  // map's requirements should the pack not ship as the answer after all (`restoreOrdinaryFacetPlan`).
  let restoreOrdinaryFacetPlan: (() => Promise<void>) | undefined;
  // FIX-C1 (2026-09-27, eval-0927 P0-1/P0-2): a facet-driven bounded evidence
  // closure. Beside the caller-expansion hook above, same seat (after every
  // selection mechanism has settled, first pack of the task only -- no
  // separate "answer profile" check needed: this function, buildAnswerTaskPack,
  // is itself only ever reached when the pack's own profile inference already
  // resolved to "answer" -- see its call sites), same strictly-additive merge
  // with a ZERO displacement budget. `extractFacetRequirements` (requestFacets.ts)
  // returns [] for an ordinary query with no value/condition/callers/flow ask,
  // so this block is a no-op and every ordinary answer pack stays
  // byte-identical -- see this wave's rule-19 table.
  //
  // WP-E (eval-0929 §7 bullet 2 / §8): "first pack of the task only" held the
  // C2 rationale (a qref replay is a call over a working set the caller still
  // holds, so a context-only addition must not re-derive coverage) as an
  // UNCONDITIONAL replay skip -- correct while the plan this hook recorded
  // for the exact query text is still valid, but not once a file the plan
  // depends on changed: the caller's held working set is then stale for
  // exactly those files, and skipping unconditionally left the resume's
  // completion gate with no plan to judge against, disclosing every facet
  // "the evidence closure for this clause was not computed" instead of
  // re-deriving the new bytes (eval-0929's `7231` repro). A replay now also
  // runs this hook -- the SAME serving mode a first pack uses, never a lesser
  // one -- exactly when `facetPlanFor` (facetGate.ts) reports no valid plan
  // (missing, or invalidated by a mismatched file sha). A replay whose plan
  // is still valid (no named file changed) takes neither branch below and
  // stays byte-identical to before this fix -- the recall control.
  const replayedFacetPlan = args.taskQueryRefReplay === true
    ? facetPlanFor(facetPlanWorkspaceKey(workspace), query, (relPath) => {
      const content = readCached(workspace, relPath, cache);
      return content === undefined ? undefined : shaOfText(content);
    })
    : undefined;
  // The selection the hook plans against, as it stands before the hook widens any of it: what
  // `restoreOrdinaryFacetPlan` plans the ordinary map against again (only answer-first needs it).
  const pristineFacetWindow = structureMapChoice.answerFirst === undefined
    ? []
    : candidates.slice(0, Math.min(candidates.length, selectionLimit)).map((entry) => ({ ...entry }));
  const sourceLinesOf = (relPath: string): string[] | undefined => readCached(workspace, relPath, cache)?.split(/\r?\n/);
  /** The plan the hook recorded for this request just now, remembered as the plan of an adopted answer-first page or of the ordinary map (a replay decides the same again). */
  const rememberAnswerFirstDecision = (adopted: boolean): void => {
    const recorded = facetPlanFor(facetPlanWorkspaceKey(workspace), query, (relPath) => {
      const content = readCached(workspace, relPath, cache);
      return content === undefined ? undefined : shaOfText(content);
    });
    if (recorded !== undefined) answerFirstPlanDecisions.set(recorded, adopted);
  };
  const planOrdinaryFacets = async (): Promise<void> => {
    await recoverFacetClosureCandidates(args, query, workspace, cache, pristineFacetWindow, extractFacetRequirements(query), true, structureMapChoice.ordinary);
    rememberAnswerFirstDecision(false);
  };
  if (replayedFacetPlan !== undefined) {
    // TL_EFF_MAP_ANSWER_FIRST: this replay runs no hook, so the plan the first call recorded
    // decides again which map the pack is — the decision that call made, remembered with the
    // plan, or (a plan recorded by no answer-first decision) what the plan itself says.
    const candidate = structureMapChoice.answerFirst;
    if (candidate !== undefined && (answerFirstPlanDecisions.get(replayedFacetPlan) ?? answerFirstPageHolds(candidate.map, replayedFacetPlan.entries, [], sourceLinesOf).holds)) {
      structureMap = candidate.map;
      restoreOrdinaryFacetPlan = planOrdinaryFacets;
    }
  }
  if (replayedFacetPlan === undefined) {
    const facetRequirements = extractFacetRequirements(query);
    if (facetRequirements.length > 0) {
      const facetWindow = candidates.slice(0, Math.min(candidates.length, selectionLimit));
      // TL_EFF_MAP_ANSWER_FIRST: a DRY RUN of this very hook against the answer-first page decides
      // whether the page is adopted. It is the real hook on COPIES of the selection: the windows it
      // serves and widens are the copies', it does not count as a run of the hook and it records no
      // plan; when the page holds every window the facets require (and every window the run served),
      // the real hook below runs once against it (with the requirements it was planned against),
      // and otherwise once against the ordinary map with the request's own requirements — the run
      // a request without the flag gets.
      let hookRequirements: readonly FacetRequirement[] = facetRequirements;
      const candidate = structureMapChoice.answerFirst;
      if (candidate !== undefined) {
        const trial: FacetClosureTrial = { served: [] };
        try {
          await recoverFacetClosureCandidates(args, query, workspace, cache, facetWindow.map((entry) => ({ ...entry })), candidate.requirements, false, candidate.map, trial);
          if (trial.plan !== undefined && answerFirstPageHolds(candidate.map, trial.plan.entries, trial.served, sourceLinesOf).holds) {
            structureMap = candidate.map;
            hookRequirements = candidate.requirements;
            restoreOrdinaryFacetPlan = planOrdinaryFacets;
          }
        } catch {
          // A dry run that fails decides nothing: the run below meets what the same request meets without the flag.
        }
      }
      const { additions: facetAdditions, widenedPaths } = await recoverFacetClosureCandidates(
        args,
        query,
        workspace,
        cache,
        facetWindow,
        hookRequirements,
        false,
        structureMap,
      );
      if (candidate !== undefined) rememberAnswerFirstDecision(structureMap === candidate.map);
      // A widened path's candidate object was mutated IN PLACE (it was
      // already one of `candidates`' own elements — see
      // `recoverFacetClosureCandidates`'s own `tryAddWindow` doc comment for
      // why this exists at all: `mergeConcernAdditions` would otherwise
      // silently DROP a same-path addition and keep the narrower pre-closure
      // range). Its `.symbol` was cleared, so it needs the SAME drop-rule
      // exemption a genuinely new addition gets below.
      for (const path of widenedPaths) concernRecoveredPaths.add(path);
      if (facetAdditions.length > 0) {
        const facetMerge = mergeConcernAdditions(
          candidates,
          selectionLimit,
          facetAdditions,
          primaryCount,
          0, // never displace: closure evidence is a bonus surface, never a replacement
          // Copilot retest (2026-10-02): closure windows are byte-bounded
          // already; see MAX_SURFACES_WITH_FACET_CLOSURE.
          MAX_SURFACES_WITH_FACET_CLOSURE,
        );
        candidates = facetMerge.candidates;
        selectionLimit = facetMerge.selectionLimit;
        // Same drop-rule exemption callerMerge takes above: a constant/callee
        // window rarely carries a `.symbol` the "range-only hit past
        // primaryCount is locator noise" rule would otherwise want.
        for (const path of facetMerge.appliedPaths) concernRecoveredPaths.add(path);
      }
    }
  }
  // 2026-11 (external A/B of v0.16.4): the asked path's own self-method and a
  // quoted literal's source absence — see `recoverAskedPathCandidates`. Merged
  // exactly like the facet closure's additions: a bonus surface, never a
  // replacement, under the same distinct-surface ceiling.
  if (candidates.length > 0) {
    let askedPathAdditions: ImpactCandidate[] = [];
    try {
      askedPathAdditions = await recoverAskedPathCandidates(
        query, workspace, cache, candidates.slice(0, Math.min(candidates.length, selectionLimit)),
      );
    } catch {
      // A defect in this closure must never turn the pack into a refusal: the
      // pack then ships exactly what it would have shipped before the hook.
      askedPathAdditions = [];
    }
    if (askedPathAdditions.length > 0) {
      const askedPathMerge = mergeConcernAdditions(
        candidates, selectionLimit, askedPathAdditions, primaryCount, 0, MAX_SURFACES_WITH_FACET_CLOSURE,
      );
      candidates = askedPathMerge.candidates;
      selectionLimit = askedPathMerge.selectionLimit;
      for (const path of askedPathMerge.appliedPaths) concernRecoveredPaths.add(path);
    }
  }
  if (candidates.length === 0) return undefined;
  // 2026-08-21 directory-scoped-answer fix (Issue #4 follow-up): a candidate
  // past the locator's own primary/required-related front (index >=
  // primaryCount) with no resolved `.symbol` is USUALLY locator context (an
  // import-edge neighbour or sibling-file range carried along for
  // background, not a real answer) — the loop below still drops those. But
  // rankAnswerEvidenceCandidates already distinguishes that weak case from a
  // genuinely strong, symbol-less hit: `strongEvidence: true` means its own
  // evidence scan found a concentrated, literal match for the query's own
  // terms (selectQueryEvidence), just inside a block with no enclosing
  // function/method/class to name as `.symbol` — a top-level test body
  // (`describe(...) { it(...) { ... } }`) being the common case. Treating
  // that the same as ordinary locator noise silently dropped the exact
  // regression test a directory-scoped answer query asked for once
  // orderByLocatorVerdict (W4-B) front-loads the locator's primary and pushes
  // every other candidate — regardless of strength — past primaryCount.
  // Recorded by path (rankAnswerEvidenceCandidates already dedupes to one
  // entry per path via its own `focusedPaths` guard) so the exemption
  // survives whichever branch above produced `candidates` (all of them
  // trace back to rankedAnswerCandidates).
  const strongEvidencePaths = new Set(
    rankedAnswerCandidates.filter((entry) => entry.strongEvidence).map((entry) => entry.candidate.path),
  );
  for (const [index, candidate] of candidates.entries()) {
    // Related range-only hits are locator context, not a related symbol
    // body — unless already certified strong evidence (see above).
    if (
      locateResult.hit
      && index >= primaryCount
      && candidate.symbol === undefined
      && !responsibilityCandidates.some((responsibility) => responsibility.path === candidate.path)
      && !strongEvidencePaths.has(candidate.path)
      && !concernRecoveredPaths.has(candidate.path)
    ) continue;
    const range = candidate.range ?? `${candidate.line}-${candidate.line}`;
    const key = `${candidate.path}\0${candidate.symbol ?? ""}\0${range}`;
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(candidate);
    if (selected.length >= selectionLimit) break;
  }
  if (selected.length === 0) return undefined;

  const built = await Promise.all(
    selected.map((candidate) =>
      candidateToSurface(candidate, workspace, [], query, cache, { answerProfile: true })
    ),
  );
  const surfaces = built.filter(
    (surface): surface is TaskPackSurface =>
      typeof surface.code === "string" && surface.code.length > 0,
  );
  if (surfaces.length === 0) return undefined;
  // 2026-10-29: the rows the LOCATOR contributed that nothing supports (see the
  // location-only pass below) — identified by object, so a row another mechanism
  // adds later (a facet closure window, a caller, a counterexample) is never one.
  const locationOnlySurfaces = new Set<TaskPackSurface>();
  if (anchorEntries.length > 0) {
    const supportedPaths = new Set<string>([
      ...anchorEntries.map((entry) => entry.candidate.path),
      // A window a facet closure, a caller or a concern recovery added is that mechanism's evidence
      // (the focal the request names in plain words: `resend300`), not a bare locator hit.
      ...concernRecoveredPaths,
      ...rankedAnswerCandidates
        .filter((entry) => entry.exactIdentifier || (entry.strongEvidence && classifySurface(entry.candidate.path) !== "doc"))
        .map((entry) => entry.candidate.path),
    ]);
    built.forEach((surface, index) => {
      const why = selected[index]!.why;
      if (!supportedPaths.has(selected[index]!.path) && isLocatorOriginWhy(why)) locationOnlySurfaces.add(surface);
    });
  }
  // v0.16 6t-7 T03: the structure map replaces the primary type's centered
  // slice, and the enum types its header is declared in (the state a
  // transition table maps) ride beside it. The query-focused member excerpts
  // below then add nothing: the map already carries every member's signature
  // and every call of the named concerns.
  const structureMapRendered = structureMap !== undefined && surfaces[0] !== undefined
    && renderStructureMapSurface(surfaces[0], structureMap, workspace, cache);
  if (structureMap?.answerFirst !== undefined && !structureMapRendered) {
    // The pack's primary surface is not the mapped type's: the answer-first page was adopted for a pack that cannot carry it.
    await restoreOrdinaryFacetPlan?.();
    restoreOrdinaryFacetPlan = undefined;
    structureMap = structureMapChoice.ordinary;
  }
  if (structureMap !== undefined && structureMapRendered) {
    const memberSurfaces = await structureMapMemberSurfaces(structureMap, query, workspace, cache);
    surfaces.splice(1, 0, ...memberSurfaces);
    const stateSurfaces = await structureMapStateTypeSurfaces(structureMap, query, workspace, cache, surfaces);
    surfaces.splice(1 + memberSurfaces.length, 0, ...stateSurfaces);
  }

  const materializeNamedAnswer = responsibilityResolved || exactLocatedAnswer || explicitAnswerNames.has(normIdent(path.basename(
    surfaces[0]!.path,
    path.extname(surfaces[0]!.path),
  )));
  if (
    !structureMapRendered
    && materializeNamedAnswer
    && (
      surfaces[0]?.content_completeness === "partial"
      // 2026-11 (external A/B, express `res.redirect('back')`): a query facet
      // is a whole token, never a substring — `'back'` is not in `callback` —
      // and a quoted literal the asked-path hook proved absent from every
      // source file cannot be materialized from a sibling member either: it
      // is answered by the disclosed absence (and the changelog line the hook
      // surfaced), so it must not pull the primary's anchor-focus siblings in.
      || requiredQueryFacets(query).some((facet) =>
        !wholeTokenOccursIn(surfaces[0]?.code ?? "", facet)
        && !(currentAskedPathPlan(workspace, query)?.literalAbsences ?? []).some((absence) => absence.term.toLowerCase() === facet)
      )
    )
  ) {
    const primary = rankedAnswerCandidates[0]!.candidate;
    const content = readCached(workspace, primary.path, cache);
    const focus = content === undefined
      ? undefined
      : await selectAnchorFocus(content, primary.path, query, cache);
    const lang = languageForPath(primary.path);
    const parsed = content !== undefined && lang
      ? await cache.parsedSymbols(content, lang, primary.path)
      : null;
    const queryFacets = requiredQueryFacets(query);
    const lines = content?.split(/\r?\n/) ?? [];
    const primaryBounds = primary.range?.match(/^(\d+)-(\d+)$/);
    const primaryStart = Number(primaryBounds?.[1] ?? 1);
    const primaryEnd = Number(primaryBounds?.[2] ?? lines.length);
    const rankedMembers = (parsed ?? [])
      .filter((symbol) =>
        (symbol.kind === "method" || symbol.kind === "function")
        && (
          materializeNamedAnswer
          // A semantic-responsibility match proves the enclosing file/class,
          // even when the locator's initial keyword window happened to name a
          // sibling method such as cancel(). Rank all callable members in
          // that proved owner so requested facets can come from place().
          ||
          !primary.symbol
          || symbol.enclosingSymbol?.name === primary.symbol
          // Some language backends return flat method symbols. An exact-file
          // class range still gives us a safe structural enclosure.
          || (symbol.startLine >= primaryStart && symbol.endLine <= primaryEnd)
        )
      )
      .map((symbol) => {
        const body = lines.slice(symbol.startLine - 1, symbol.endLine).join("\n");
        // 2026-11 (external A/B, express `res.redirect('back')`): whole-token
        // facet hits. The substring test ranked `res.jsonp`/`res.sendFile`/
        // `res.download` as `'back'` evidence through their `callback`
        // parameters and shipped three unrelated bodies beside the answer.
        const facetHits = queryFacets.filter((facet) => wholeTokenOccursIn(body, facet)).length;
        const executableFacetLines = queryFacets.flatMap((facet) => {
          const matches: number[] = [];
          for (let line = symbol.signatureStartLine ?? symbol.startLine; line <= symbol.endLine; line++) {
            if (wholeTokenOccursIn(lines[line - 1] ?? "", facet)) matches.push(line);
          }
          return matches;
        });
        const facetWindows = queryFacets.flatMap((facet) => {
          // B1d (2026-08-01 retrieval-scope): a facet's real behavior lives at
          // its COLLABORATOR CALL SITE (`shippingService.requestLabel(...)`),
          // not wherever the word happens to appear. The first-match scan below
          // used to stop at any lexical hit, so a `shipping` COST field in the
          // class head won the window and the actual shipping call in the tail
          // was never served — while hasExactNamedAnswerFacetEvidence then read
          // that head match as "the facet is bundled" (T03). Scan for a call
          // site FIRST; fall back to the plain lexical match only when the
          // symbol has none.
          const scan = (
            accept: (source: string) => boolean,
          ): Array<{ facet: string; line: number; range: string }> => {
            for (let line = symbol.signatureStartLine ?? symbol.startLine; line <= symbol.endLine; line++) {
              const source = lines[line - 1] ?? "";
              if (/^\s*(?:\/\/|\/\*|\*)/.test(source) || !hasIdentifierSegment(source, facet)) continue;
              if (!accept(source)) continue;
              return [{ facet, line, range: `${Math.max(symbol.startLine, line - 2)}-${Math.min(symbol.endLine, line + 3)}` }];
            }
            return [];
          };
          const callSite = scan((source) => isFacetCallSiteLine(source, facet));
          return callSite.length > 0 ? callSite : scan(() => true);
        });
        const centerLine = executableFacetLines.length > 0
          ? Math.round((Math.min(...executableFacetLines) + Math.max(...executableFacetLines)) / 2)
          : symbol.signatureStartLine ?? symbol.startLine;
        return {
          name: symbol.name,
          range: `${symbol.startLine}-${symbol.endLine}`,
          signatureRange: `${symbol.signatureStartLine ?? symbol.startLine}-${Math.min(symbol.endLine, (symbol.signatureEndLine ?? symbol.startLine) + 1)}`,
          centerLine,
          facetHits,
          facetWindows,
          score: lexicalOverlapFraction(tokenizeForEpoch(query), tokenizeForEpoch(symbol.name)),
        };
      })
      .filter((item) => item.facetHits > 0 || item.score > 0)
      .sort((a, b) => {
        const facetDelta = b.facetHits - a.facetHits;
        if (facetDelta !== 0) return facetDelta;
        if (a.facetHits > 0) {
          return Number.parseInt(a.range, 10) - Number.parseInt(b.range, 10);
        }
        return b.score - a.score;
      });
    const focusedMembers = (focus ? [focus.best, ...focus.runnerUps] : []).map((item) => ({
      ...item,
      centerLine: Number.parseInt(item.range.split("-", 1)[0] ?? "1", 10),
      facetWindows: [] as Array<{ facet: string; line: number; range: string }>,
      signatureRange: item.range,
    }));
    const members = [...rankedMembers, ...focusedMembers]
      .filter((item, index, all) =>
        item.name.toLowerCase() !== surfaces[0]!.symbol?.toLowerCase()
        && all.findIndex((candidate) => candidate.name === item.name && candidate.range === item.range) === index
      )
      .slice(0, 3);
    // Keep an exact large-class answer as one coherent surface: append bounded,
    // query-ranked member bodies to the class header/table slice. Separate
    // same-file surfaces are vulnerable to pack trimming and make the client
    // reconstruct a structural answer from several handles.
    const primarySurface = surfaces[0]!;
    for (const member of members) {
      // TL_SEEDED_GENEROUS (2026-09-20): the appends below exist because the
      // primary surface used to be a bounded class-header slice that did NOT
      // contain the member. Under the widened answer allowance the primary
      // body can already hold the whole class, and then an excerpt of one of
      // its own members is a duplicate that also merges the excerpt's
      // `remaining_ranges` into a surface that has no such hole -- measured on
      // a live GitHub Copilot pack: `27-420` served whole, followed by an
      // appended `query-focused member place (80-197)` tail and a false
      // `remaining:["80-179"]`, which also made the body unequal to its own
      // rendering, so the answer line gutter refused to number it and the
      // model spent three requests re-reading lines it already held. Flag
      // off, the primary slice keeps today's bounds and nothing is skipped.
      if (seededGenerousEnabled() && surfaceBodyCoversRange(primarySurface, member.range)) continue;
      const distinctFacetWindows = member.facetWindows.filter((window, index, all) =>
        all.findIndex((candidate) => candidate.range === window.range) === index
      );
      if (
        queryFacets.length > 1
        && new Set(member.facetWindows.map((window) => window.facet)).size === queryFacets.length
      ) {
        let added = 0;
        const signatureStart = Number.parseInt(member.signatureRange, 10);
        const signatureEnd = Number.parseInt(member.signatureRange.split("-")[1] ?? member.signatureRange, 10);
        const signatureMarker = `\n\n/* query-focused member ${member.name} (${member.signatureRange}) */\n`;
        const signatureSnippet = lines.slice(signatureStart - 1, signatureEnd).join("\n");
        if (
          Buffer.byteLength((primarySurface.code ?? "") + signatureMarker + signatureSnippet, "utf8")
          <= MAX_SURFACE_CODE_BYTES
        ) {
          primarySurface.code = (primarySurface.code ?? "") + signatureMarker + signatureSnippet;
          recordAppendedWindow(primarySurface, signatureMarker, member.signatureRange);
        }
        for (const window of distinctFacetWindows) {
          const current = primarySurface.code ?? "";
          const marker = `\n\n/* query facet ${window.facet} (${window.range}) */\n`;
          const snippet = lines.slice(
            Number.parseInt(window.range, 10) - 1,
            Number.parseInt(window.range.split("-")[1] ?? window.range, 10),
          ).join("\n");
          if (
            Buffer.byteLength(current + marker + snippet, "utf8") > MAX_SURFACE_CODE_BYTES
          ) break;
          primarySurface.code = current + marker + snippet;
          recordAppendedWindow(primarySurface, marker, window.range);
          added++;
        }
        if (added === distinctFacetWindows.length) {
          primarySurface.required = false;
          primarySurface.content_completeness = "partial";
          delete primarySurface.outline;
          break;
        }
      }
      const current = primarySurface.code ?? "";
      // Budgeted with the member's whole range in the marker: the window the
      // slice keeps lies inside it, so its own range string is never longer.
      const budgetMarker = `\n\n/* query-focused member ${member.name} (${member.range}) */\n`;
      const remainingBudget = MAX_SURFACE_CODE_BYTES
        - Buffer.byteLength(current, "utf8")
        - Buffer.byteLength(budgetMarker, "utf8");
      if (remainingBudget < 512) break;
      const focused = centeredSliceForCap(
        workspace,
        primary.path,
        member.range,
        cache,
        member.centerLine,
        remainingBudget,
      );
      if (!focused) continue;
      // The marker names the lines the excerpt holds (the member's range minus
      // the slice's own unserved spans), not the whole member.
      const excerptRange = keptWindowOf(member.range, focused.remaining_ranges);
      const marker = `\n\n/* query-focused member ${member.name} (${excerptRange}) */\n`;
      primarySurface.code = current + marker + focused.code;
      recordAppendedWindow(primarySurface, marker, excerptRange);
      primarySurface.required = true;
      primarySurface.remaining_ranges = [...new Set([
        ...(primarySurface.remaining_ranges ?? []),
        ...focused.remaining_ranges,
      ])];
      primarySurface.content_completeness = "partial";
    }
  }

  // B1c (2026-08-01 retrieval-scope): an ANSWER pack that could not resolve one
  // target ships a candidate list — and T05c's live candidate lists contained
  // none of the three files the query named. Serve those first, content-bearing.
  await augmentQueryNamedFileSurfaces(surfaces, query, workspace, [], cache);
  // TL142-05 (2026-09-13): now that every explicitly-named file has its own
  // slot, the general fallback admission may not ALSO add an unrelated file
  // alongside them — see the function's own doc comment for the exact gate.
  gateAnswerQueryEvidenceFocusOnNamedPathRelation(surfaces, query, workspace, cache);
  // BLOCKER 12 (review round 3, 2026-09-13): the two passes above each carry
  // their own "never drop the last surviving surface" floor at their splice
  // sites (see there), but this is a second, independent backstop at the one
  // place every downstream read in THIS function dereferences `surfaces[0]`
  // unconditionally (`surfaces[0]!.range` a few lines below, and more after
  // it) — the exact site a named-but-unreadable path (queryNamedWorkspaceFiles
  // resolves it, readCached cannot read it, e.g. chmod 000) used to crash on
  // when the gate above emptied `surfaces` with no floor of its own. Same
  // contract as every other early `return undefined` already in this
  // function (e.g. `candidates.length === 0`/`selected.length === 0` above):
  // buildTaskPack's caller falls through to its own further strategies
  // instead of this function ever throwing a bare, unstructured JSON-RPC
  // error with no `v:1` envelope.
  if (surfaces.length === 0) return undefined;
  // 2026-10-29: once the request's own anchors are served, every other row that
  // is neither an exact-identifier site nor strong code evidence is a LOCATION —
  // path, range, handle and `remaining` = its whole range, no body (a changelog
  // that repeats the word, a filename-match neighbour). The caller reads it by
  // handle if it wants it; the answer does not pay for it.
  if (locationOnlySurfaces.size > 0) {
    for (const surface of surfaces) {
      if (!locationOnlySurfaces.has(surface) || surfaceWhyHasMarker(surface.why, "query-named-file")) continue;
      // A few lines cost less than the location that replaces them (path, range, handle, remaining).
      if (Buffer.byteLength(surface.code ?? "", "utf8") < LOCATION_ONLY_MIN_BODY_BYTES) continue;
      // Bytes another row of the same file already carries are not a location to point at.
      const bounds = parsePackLineRange(surface.range);
      if (surfaces.some((other) => {
        if (other === surface || other.path !== surface.path || other.code === undefined || locationOnlySurfaces.has(other)) return false;
        const otherBounds = parsePackLineRange(other.range);
        return bounds === undefined || otherBounds === undefined || (otherBounds[0] <= bounds[1] && bounds[0] <= otherBounds[1]);
      })) continue;
      delete surface.code;
      delete surface.outline;
      delete surface.appended_windows;
      surface.required = false;
      surface.content_completeness = "partial";
      surface.remaining_ranges = [surface.range];
    }
  }

  // Issue #3 dominance tie-break: computed once, reused below (after `result`
  // exists) to serve the winner's body — see `applyDominancePromotion`.
  const dominantSurfaceIndex = resolveDominantSurfaceIndex(surfaces);
  const derivedAnswerCoverage = exactLocatedAnswer || sameNameAmbiguousAnswer
    ? { coverage: "focused" as const, reason: undefined, dominancePromoted: undefined }
    : locateResult.hit
    ? deriveCoverage(
        {
          // 2026-08-21 answer-focus precision fix (coverage honesty): the
          // pack's own admission filter had to drop weak-token,
          // non-dominant-root, or non-source-role evidence to reach this
          // surface set — a pack built partly FROM discarded evidence must
          // not report "complete" even when the locator itself said so.
          completeness: weakEvidenceDropped ? "partial" : locateResult.completeness,
          confidence: locateResult.confidence,
          primaryCount: locateResult.primary.length,
          ...(locateResult.missingSurfaces ? { missingSurfaces: locateResult.missingSurfaces } : {}),
        },
        [],
        [],
        dominantSurfaceIndex,
      )
    : strongRecoveredAnswer
      ? { coverage: "focused" as const, reason: undefined, dominancePromoted: undefined }
      : { coverage: "partial" as const, reason: "candidate-list" as const, dominancePromoted: undefined };
  // v0.15.1 runtime review TL-REVIEW-3 (2026-10-06): a locator HIT whose ONE
  // primary is a file the question names by path — a name no other
  // workspace file shares — and whose body this pack serves is not a choice
  // between candidates. The locator scores a filename match at 0.625, under
  // `deriveCoverage`'s 0.7 "single-site" bar, so rule 6 used to brand it
  // "candidate-list": 「http.ts の retry 関数について…」 came back as
  // `await_input`/`choose-candidate` naming http.ts as its ONE candidate, and
  // "Explain the retry function in http.ts." as a `discover` whose only gap
  // was `ambiguous-target` and whose bundle re-served the bytes it already
  // held. The question settled the target; the file's supporting evidence
  // (closure constants, callers, counterexamples) is never a rival for it.
  // Only the candidate-list verdict changes — a missing role, an uncovered
  // concern or an open request item still keeps the pack open, and the
  // certificate gates below are untouched.
  const namedSinglePrimaryAnswer = locateResult.hit
    && derivedAnswerCoverage.reason === "candidate-list"
    && locateResult.primary.length === 1
    && surfaces[0] !== undefined
    && surfaces[0].path === locateResult.primary[0]!.path
    && hasServedCode(surfaces[0])
    && queryNamesWorkspaceFileUniquely(query, workspace, surfaces[0].path);
  const { coverage, reason, dominancePromoted } = namedSinglePrimaryAnswer
    ? { coverage: "focused" as const, reason: "single-site" as const, dominancePromoted: undefined }
    : derivedAnswerCoverage;
  const needsConfirmation = !locateResult.hit && !strongRecoveredAnswer && !sameNameAmbiguousAnswer;
  const topRange = surfaces[0]!.range.match(/^(\d+)-(\d+)$/);
  // The ±40-line confirmation window stops at the file's last line — the
  // unclamped end asked for `1-47` of a 7-line file (orchestrator, round 4;
  // the producer class of eval-0927 review-r2 P1-9).
  const topLineCount = topRange === null ? 0 : countLines(readCached(workspace, surfaces[0]!.path, cache) ?? "");
  const confirmationNext: ContinuationCall = {
    tool: "tl_read_file",
    arguments: {
      mode: "slice",
      handle: surfaces[0]!.handle,
      ...(topRange
        ? {
          range: `${Math.max(1, Number(topRange[1]) - 40)}-${topLineCount > 0
            ? Math.max(Number(topRange[2]), Math.min(topLineCount, Number(topRange[2]) + 40))
            : Number(topRange[2]) + 40}`,
        }
        : {}),
    },
  };
  if (responsibilityResolved && surfaces[0]) {
    surfaces[0].symbol = path.basename(
      surfaces[0].path,
      path.extname(surfaces[0].path),
    );
  }
  const result: TaskPackResult = {
    mode: "task_pack",
    coverage,
    ...(reason ? { coverage_reason: reason } : {}),
    surfaces,
    missing: [],
    route: {
      action: needsConfirmation ? "confirm_candidates" : "answer_from_handles",
      reason: needsConfirmation
        ? "answer candidates are ambiguous; inspect the top handle before answering"
        : "query reads as explain/answer — no edit expected",
      max_additional_tl_calls: needsConfirmation ? 1 : 0,
    },
    ...(responsibilityResolved && explicitCodeIdentifiers(query)[0] && surfaces[0]
      ? {
          answer_resolution: {
            strategy: "semantic-responsibility" as const,
            requested_identifier: explicitCodeIdentifiers(query)[0]!,
            resolved_handle: surfaces[0].handle,
            // B1d (2026-08-01 retrieval-scope): `matched_facets` used to echo
            // the QUERY's facet list verbatim — it asserted a match nothing had
            // checked, and downstream (dedupeTrimAndPersist's answer stop) that
            // unverified assertion short-circuited the real facet check. T03
            // shipped `matched_facets:["payment","inventory","shipping"]` while
            // every shippingService.* call site sat in remaining_ranges. Report
            // only the facets this surface's SERVED text actually evidences.
            matched_facets: requiredQueryFacets(query).filter((facet) =>
              surfaceContainsFacet(surfaces[0]!, facet)
              && !facetEvidenceStillUnserved(surfaces[0]!, facet, workspace)
            ),
          },
        }
      : {}),
    ...(needsConfirmation ? { next: confirmationNext } : {}),
  };
  if (dominancePromoted) applyDominancePromotion(result, surfaces, dominantSurfaceIndex, workspace);

  const evidenceExpansion = await importEvidenceExpansion(workspace, locateResult.hit ? locateResult.primary : [], query, surfaces);
  // WP-N (eval-0929 §8): the absence FACTS ride into certification so a proved
  // `identifier:<X>` whose name does not exist is disclosed
  // (`identifierAbsenceDisclosures`). The PROOF set keeps its post-
  // certification timing below for a name with no occurrence at all (replay
  // v0142a2a: the first pack prescribes the confirming literal search, whose
  // caveat-free absence certificate then closes the resume) — except a name
  // that occurs ONLY inside longer identifiers: no search can confirm that
  // absence (every literal find returns the near-miss lines as hits, a symbol
  // search returns fuzzy neighbours), so this pack's own whole-identifier scan
  // over the same find universe is the only proof there is, and prescribing a
  // search would be a guaranteed non-confirming call.
  recordIdentifierAbsences(result, identifierAbsences);
  recordVerifiedAbsentIdentifiers(
    result,
    [...identifierAbsences].filter(([, absence]) => absence.nearMisses.length > 0).map(([identifier]) => identifier),
  );
  // WP-O: before the certificate is built (inside dedupeTrimAndPersist).
  recordSameNameSubjects(result, sameNameSubjects);
  const finalResult = await dedupeTrimAndPersist(workspace, result, { args, evidenceExpansion });
  // WP-B (eval-0929 §5/§8): what the certificate was issued over, read BEFORE
  // any post-certification pass below can change the surface set — see
  // `enforceCertificateWireInvariant`.
  const certification = answerCertificationSnapshot(finalResult);
  // Post-trim is the only safe point to add explicit relation providers: the
  // generic answer admission filter may legitimately discard a weak locator
  // candidate, but it must not discard an observed import target the caller
  // named.  These helpers never grow beyond direct imports or guess endpoints.
  await augmentExplicitAnswerImportSurfaces(finalResult.surfaces, query, workspace, cache);
  materializeExplicitAnswerAnchorEvidence(finalResult.surfaces, query, workspace, cache);
  // Keep answer packs read-only while still preserving an explicit, observed
  // import relation for the semantic-frontier trace.  This runs after trim so
  // every graph endpoint is guaranteed to be present in the actual pack.
  attachAnswerImportEvidenceGraph(finalResult, query, workspace, cache);
  // dedupeTrimAndPersist registers its seed before this answer-only final
  // projection.  Replace it with the final, graph-bearing snapshot so the
  // attestation cannot report a stale pre-provider candidate set.
  const semanticGuard = semanticFrontierGuardEnabled();
  // D4 (FX-R3): under TL_SF_DEMOTE the marking source is this pack's grounded
  // structural concerns, published by the pre-booking seam that already ran
  // inside `dedupeTrimAndPersist` above. Absent (flag off / no context) it is
  // `undefined`, and the v2 arm then marks nothing — the conservative answer.
  annotateSemanticFrontierContinuation(
    finalResult,
    query,
    semanticGuard,
    sfPackContextFor(finalResult)?.concerns,
  );
  noteSemanticFrontierTraceSeed(prepareSemanticFrontierTraceSeed(finalResult, query, semanticGuard));
  if (verifiedAbsentIdentifiers.length > 0) {
    recordVerifiedAbsentIdentifiers(finalResult, verifiedAbsentIdentifiers);
    if (result !== finalResult) recordVerifiedAbsentIdentifiers(result, verifiedAbsentIdentifiers);
  }
  if (result !== finalResult) {
    recordIdentifierAbsences(finalResult, identifierAbsences);
    recordVerifiedAbsentIdentifiers(finalResult, verifiedAbsentIdentifiersByResult.get(result) ?? []);
    recordSameNameSubjects(finalResult, sameNameSubjects);
  }
  // TL142-05 (2026-09-13): last-of-all — after dedupeTrimAndPersist's own
  // counterexample/trim pass AND the post-trim import/anchor augmenters
  // above have all had their chance to add surfaces, cap non-named evidence
  // relative to the named files' own size (report's own 1.25x bound). WP-B:
  // never a surface carrying evidence the certificate cites.
  capExtraEvidenceRelativeToNamedPaths(finalResult.surfaces, query, workspace, certification.keep);
  postCertificationPassForTest?.(finalResult.surfaces);
  // FIX-FC (eval-0927 review finding 8, 2026-09-27): AFTER every augmenter
  // above (anchor/import/graph) and the cap just above have all had their
  // final say over `finalResult.surfaces` — see trimNextAgainstShippedEvidence's
  // own doc comment for the live repro (a `next` re-reading a line the
  // anchor pass just served in THIS SAME response).
  trimNextAgainstShippedEvidence(finalResult);
  // WP-B (eval-0929 §5/§8): THE ONE POINT after the last pass that can change
  // the final surface set, and before the re-booking below records it: a
  // certificate never outlives its evidence.
  enforceCertificateWireInvariant(finalResult, certification, args, workspace);
  // V15-NBR/FUI (2026-09-29): default-OFF prototypes, AFTER the wire
  // invariant above (so they can never affect what the certificate is
  // issued over) and before the re-booking below. Both only ever ADD
  // `result.neighbours`/`result.usages` — neither touches `finalResult.
  // surfaces`, so this ordering is immaterial to what gets booked; placed
  // here anyway to match the "final surfaces are known" contract both
  // modules document. Flags OFF (default): both calls return on their first
  // line, byte-identical to pre-V15-NBR/FUI output.
  attachPlanAids(finalResult, workspace, query);
  const answerFirstShip = attachAnswerFirstAdvisory(finalResult, structureMap);
  if (answerFirstShip === "not-answer" || answerFirstShip === "no-room") {
    // The page was adopted for an answer it did not become: the rest of the chain runs under the ordinary map's requirements.
    await restoreOrdinaryFacetPlan?.();
    if (answerFirstShip === "no-room") rederiveAfterPlanRestore(finalResult, args, workspace);
  }
  attachStructureMapElsewhereNote(finalResult, structureMap, structureMapRendered, workspace, cache);
  // FIX-ORIG (2026-09-27, orchestrator ruling — see sfBookingOrderFence.spec.ts's
  // PRODUCERS entries for both producers below, "buildAnswerTaskPack, post-answer-
  // augmenters" site): every serve-booking producer (the edit gate's admissible
  // union, rememberCertifiedWorkingSet, captureServedPack's
  // recordPackServedRanges, bookShippedPackServeState's recordServedSurfaces/
  // recordReadOnlyServedSurfaces) lives INSIDE dedupeTrimAndPersist, called
  // above — so augmentExplicitAnswerImportSurfaces / materializeExplicit-
  // AnswerAnchorEvidence / attachAnswerImportEvidenceGraph /
  // capExtraEvidenceRelativeToNamedPaths all run AFTER booking already
  // happened, and anything any of them add or widen would otherwise never
  // reach either ledger — exactly the P1 hybrid-body finding's root cause.
  // `shippedSurfaces` is THE canonical "what did this response actually ship
  // bytes for" projection (its own doc: "so the next producer added
  // downstream cannot disagree with the others about what shipped") — reused
  // here, not re-derived, so this call can never disagree with
  // bookShippedPackServeState's own projection over the SAME `finalResult`.
  // Both producers below are idempotent, self-contained re-scans of
  // `finalResult`'s CURRENT state (fresh disk reads, no cached pre-image), so
  // calling them again here — on the truly final surface set, after the cap
  // above can no longer remove anything — safely extends both ledgers to
  // cover exactly what this response ships.
  //
  // repackMonotonicity.spec.ts fix (2026-09-27, this wave): the ORIGINAL text
  // here unconditionally called `recordReadOnlyServedSurfaces`, on the belief
  // that "an answer pack must never enter [the cumulative log]" — true for a
  // DECLARED answer task (`profile_binding.source === "explicit"`), false for
  // an INFERRED one (an undeclared query this router still answers from
  // handles). `finalizePackServeState`/`bookShippedPackServeState` already
  // drew that exact line (`cumulativeEligible`, ~line 43012) and branch on it;
  // this call must branch the SAME way over the SAME final surface set, or an
  // inferred answer task's re-pack loses the augmenters' surfaces from the
  // cumulative log it is entitled to (measured: `repackMonotonicity.spec.ts`
  // "leaves an INFERRED answer pack exactly as it was" — the unconditional
  // call put the augmenters' surfaces in the read-only view instead, which
  // only `epochServedEvidence` reads, not `priorEpochActionFrontier`).
  recordPackServedRanges(workspace, finalResult);
  const rebookedShipped = shippedSurfaces(finalResult);
  const rebookCumulativeEligible = finalResult.task_profile !== "answer"
    || finalResult.profile_binding?.source !== "explicit";
  if (rebookCumulativeEligible) {
    if (rebookedShipped.length > 0) {
      recordServedSurfaces(
        workspace,
        workspace,
        rebookedShipped.map((s) => ({
          path: s.path,
          role: s.role,
          handle: s.handle,
          fullyServed: surfaceAlreadyCoversWholeFile(s),
        })),
        tokenizeForEpoch(query),
      );
    }
  } else if (rebookedShipped.length > 0) {
    recordReadOnlyServedSurfaces(workspace, rebookedShipped, tokenizeForEpoch(query));
  }
  // FIX-FC (eval-0927 review finding 3, 2026-09-27): the FIX-ORIG rebooking
  // just above re-derives the served-range ledger and the cumulative log
  // from the truly-final `finalResult`, but `captureServedPack`'s OWN
  // record — `servedPacksByWorkspace`'s `ServedPackRecord.surfaces`, the
  // ONE index `residentSurfaceKeys`/`residentBodyIndex` consult to grant a
  // `prior`/`code_unchanged` residency claim on a LATER call — was captured
  // inside `dedupeTrimAndPersist` above, BEFORE `capExtraEvidenceRelative-
  // ToNamedPaths` (or any other post-trim augmenter) can still remove a
  // surface it had already added. Live repro (`priorProbe`, this wave): a
  // query naming one file (`src/config.ts`) pulls in a same-file
  // "readiness-falsification-counterexample" surface (`src/httpClient.ts`)
  // with a real body; `dedupeTrimAndPersist` books it as shipped, then the
  // 1.25x named-path cap a few lines above splices it out of
  // `finalResult.surfaces` for being far larger than the named evidence — so
  // the WIRE never sends it, yet the stale record still claims it resident.
  // A later same-session re-pack resolves `httpClient.ts` again with a
  // FRESH body, and `applyResidentFileDedup` (correctly, given that stale
  // record) demotes it to a `prior` claim for bytes that were never on the
  // wire. Re-capturing here — over `finalResult`, AFTER every post-dedup
  // augmenter and cap has had its final say — closes the gap: the SAME
  // fingerprint/signature this pack already registered inside
  // `dedupeTrimAndPersist` is superseded (`captureServedPack`'s own "iter-2
  // W1" replace-by-signature rule), so `servedPacksByWorkspace` ends up with
  // exactly one record for this pack, and it is the accurate one. The
  // resulting second `recordPackServedRanges` call (inside
  // `captureServedPack`) is a harmless re-run over the same, now-corrected
  // span set — the FIX-ORIG call three lines above already established that
  // this function tolerates running twice per pack.
  captureServedPack(workspace, args, computePackFingerprint(args, workspace), finalResult);
  // FIX-FC2 (eval-0927 review finding 3 residual, VS Code config, 2026-09-27):
  // `captureServedPack` just above is NOT the only ledger `dedupeTrimAndPersist`
  // populates from its OWN pre-cap `trimmed` before returning to this function.
  // `persistPackFingerprints(workspace, trimmed, ...)` (called near the end of
  // `dedupeTrimAndPersist`, BEFORE the cap a few lines above ever runs) stamps
  // `lastPackBlocksByWorkspace` — the single-slot cache `applyPackDedupe` reads
  // at the TOP of the NEXT `dedupeTrimAndPersist` call — from that same stale,
  // pre-cap surface list. Live repro (`priorProbe`, VS Code config: `TL_TURN_
  // ECONOMY=1 TOKENLIGHTEN_TASK_PACK_MAX_BYTES=0`; also reproduces on c0922):
  // under this config the single-candidate answer resolves in ONE pass (no
  // `confirm_candidates` round trip), so `dedupeTrimAndPersist` adds the
  // `src/httpClient.ts` counterexample AND stamps its fingerprint into
  // `lastPackBlocksByWorkspace` BEFORE the 1.25x named-path cap splices it back
  // out of `finalResult.surfaces` — the wire never ships it, exactly as
  // `captureServedPack`'s own repro above. A later bare-`{qref}` replay takes a
  // DIFFERENT internal rebuild path (a fresh fingerprint, so `tryServeCachedPack`
  // misses `servedPacksByWorkspace` entirely — the ledger `captureServedPack`
  // above corrects), re-derives the identical, content-addressed `httpClient.ts`
  // surface, and `applyPackDedupe` (top of `dedupeTrimAndPersist`) matches it
  // against the stale `lastPackBlocksByWorkspace` entry and demotes it to
  // `code_unchanged: "<handle> — see prior pack"` — a `prior` claim for bytes
  // this task never actually shipped. Re-running `persistPackFingerprints` here,
  // over the SAME final, post-cap `finalResult` `captureServedPack` just used,
  // closes the gap the same way: its own `.set()` (never an append/merge across
  // calls — see its doc comment) replaces the whole per-workspace slot, so
  // `lastPackBlocksByWorkspace` ends up describing exactly what this response
  // shipped, not what an internal pre-cap draft once held.
  persistPackFingerprints(workspace, finalResult, args.taskBinding);
  return finalResult;
}

/**
 * TL_CONCERN_RECOVERY (Agent B, Phase 2 2026-09-19, fixed Phase 3
 * 2026-09-19): sibling co-occurrence recovery for a MULTI-member query list
 * — see concernRecovery.ts's module doc for the full rationale (picking one
 * arbitrary occurrence of an ambiguous literal is a guess; the file where
 * several members of the SAME user-written list occur together is evidence
 * a lone literal never was).
 *
 * Gathers literals from the three sources the query already yields
 * elsewhere in this file — the enumerated-item list parser
 * (currentEnumeratedQueryItems), the backticked/quoted/slash-joined facet
 * extractor (requiredQueryFacets), and explicitCodeIdentifiers's own
 * code-shape oracle, reused here ONLY as a membership test, never
 * re-derived — and hands them to the pure grouping/scoring/windowing module.
 * Never writes a second list parser or a second shape classifier.
 */
/**
 * Test-only observability (Phase 3, 2026-09-19, matching the existing
 * `sfAwaitInputInvariantFallbackCountForTest`-style counters in
 * canonicalDecision.ts): increments exactly once per `buildAnswerTaskPack`
 * call that enters the `concernRecoveryEnabled()` block — the ONLY place
 * `diversifyByConcern`/`recoverConcernCandidates` are ever reached from. A
 * spec can assert this stays 0 across a whole run with the flag unset,
 * proving OFF-inertness directly rather than only inferring it from
 * unchanged output bytes.
 */
export let concernRecoveryEntryCountForTest = 0;

export function resetConcernRecoveryEntryCountForTest(): void {
  concernRecoveryEntryCountForTest = 0;
}

/**
 * Test-only observability, mirroring `concernRecoveryEntryCount` above:
 * increments exactly once per `buildAnswerTaskPack` call that actually enters
 * the caller-expansion hook, so a spec can prove OFF-inertness directly
 * instead of only inferring it from unchanged output bytes.
 */
export let callerExpansionEntryCountForTest = 0;

export function resetCallerExpansionEntryCountForTest(): void {
  callerExpansionEntryCountForTest = 0;
}
