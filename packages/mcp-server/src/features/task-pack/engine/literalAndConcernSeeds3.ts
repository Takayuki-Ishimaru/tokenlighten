// literalAndConcernSeeds — extracted implementation; imports point to the owning modules.
import type { ConcernCoverage } from "../model.js";
import type { ConcernGroup } from "./roleAndConcernScope2.js";
import type { ContinuationCall } from "./packBasics.js";
import type { ContinuationPlan } from "../../../util/continuation.js";
import type { ImpactCandidate } from "@tokenlighten/types";
import type { LiteralFirstMeasurement } from "./literalAndConcernSeeds.js";
import type { TaskPackArgs } from "../model.js";
import type { TaskPackResult } from "../model.js";
import type { TaskPackSurface } from "../model.js";
import { FileReadCache } from "./packBasics2.js";
import { MAX_STAGE_CALLS } from "../../../util/continuation.js";
import { MAX_SURFACES_DISTINCT } from "./packBasics2.js";
import { META_CONCERN_EVIDENCE_TOKENS } from "./roleAndConcernScope2.js";
import { MULTI_CONCERN_ENRICHMENT_MAX_SURFACES } from "./packBasics2.js";
import { WEAK_CONCERN_TOKENS } from "./roleAndConcernScope2.js";
import { attachPlanAids } from "./packTrimming2.js";
import { augmentNativeSurfaceClosure } from "./queryIntent.js";
import { augmentQueryNamedFileSurfaces } from "./queryIntent.js";
import { buildSeededTaskPack } from "./seededPackBuilder.js";
import { candidateToSurface } from "./surfaceMaterialization.js";
import { captureServedPack } from "./packState4.js";
import { carryAuxiliaryEnumPool } from "../auxiliaryEnumContextIntegration.js";
import { classifySurface } from "../../../util/impact.js";
import { codeTaskPackSurfaces } from "../artifactSections.js";
import { commonAncestorDir } from "./seedResolution.js";
import { computePackFingerprint } from "./packState2.js";
import { concernGroupsForQuery } from "./roleAndConcernScope3.js";
import { concernTokenMatchesSurface } from "./roleAndConcernScope3.js";
import { dedupeTrimAndPersist } from "./packSettlement.js";
import { deriveNextFromPlan } from "./packBasics.js";
import { enforceContinuationBudget } from "../../../util/continuation.js";
import { hasExecutedNext } from "../../../util/packServeLog.js";
import { hasExplicitConcernList } from "./roleAndConcernScope2.js";
import { hasExplicitIndependentConcernMarker } from "./roleAndConcernScope2.js";
import { inferQueryProjectScope } from "../../locator/locateTaskContext.js";
import { isCrossMethodConcernRange } from "./literalAndConcernSeeds.js";
import { isDirectoryWithin } from "./seedResolution.js";
import { isEnumLikeQueryShaped } from "./roleAndConcernScope2.js";
import { isNativeExtPath } from "../../../util/nativeSymbolRange.js";
import { layeredControlCompanionCandidates } from "./literalAndConcernSeeds.js";
import { literalConcernCandidates } from "./literalAndConcernSeeds.js";
import { literalFirstMeasurement } from "./literalAndConcernSeeds.js";
import { literalFirstRemainingCall } from "./literalAndConcernSeeds2.js";
import { literalFirstRoutingEnabled } from "../../../util/flags.js";
import { literalSourceRarityLimit } from "./packBasics2.js";
import { locateTaskContext } from "../../locator/locateTaskContext.js";
import { nativePairCandidates } from "./queryIntent.js";
import { normalizeContractLane } from "../../../util/packServeLog.js";
import { normalizePathEntry } from "./packBasics2.js";
import { propagationSeedResolution } from "./literalAndConcernSeeds2.js";
import { rankAbstainCandidates } from "./roleAndConcernScope3.js";
import { traceLiteralFirstRouteDecision } from "./literalAndConcernSeeds.js";
import { walkCodeFiles } from "../../../tools/walkRepo.js";

export async function literalFirstSafeguardPack(
  args: TaskPackArgs,
  query: string,
  workspace: string,
  literal: LiteralFirstMeasurement,
  selectedPaths: readonly string[] = [],
): Promise<TaskPackResult> {
  const collision = literal.destinationCollision === true;
  const overCap = literal.sourcePaths > literalSourceRarityLimit(literal.universePaths);
  const overSurfaceCap = literal.sourcePaths > MAX_SURFACES_DISTINCT;
  const missingImplementation = literal.kind === "present" && literal.sourceImplementationPaths === 0;
  const rootAmbiguous = literal.kind === "present" && literal.sourceRootCount !== 1;
  const { call: remainingCall } = literalFirstRemainingCall(literal, selectedPaths);
  const remainingContinuation: ContinuationPlan | undefined = remainingCall
    ? { version: 1, stages: [{ execution: "parallel", calls: [remainingCall] }] }
    : undefined;
  const missing = [collision
    ? "destination-collision"
    : overCap ? "source-cohort-over-cap"
      : overSurfaceCap ? "source-cohort-remaining"
      : missingImplementation ? "source-implementation-witness-missing"
        : rootAmbiguous ? "source-root-ambiguous"
          : "literal-universe-partial"];
  const result: TaskPackResult = {
    mode: "task_pack",
    coverage: "partial",
    coverage_reason: "missing-roles",
    surfaces: [],
    missing,
    required_surfaces: ["implementation"],
    missing_required_surfaces: ["implementation"],
    route: {
      action: "locate_missing_surfaces",
      reason: collision
        ? "directed destination is already present in the source root; resolve rename/migration intent before editing"
        : overCap
          ? "directed source cohort exceeds the surface cap; inspect the complete candidate set before editing"
          : overSurfaceCap
            ? "directed source cohort has exact witnesses beyond the initial surface cap; serve every remaining witness before editing"
          : missingImplementation
            ? "exact source occurs only in non-implementation surfaces; locate its implementation owner before editing"
            : rootAmbiguous
              ? "exact source spans multiple project roots; choose the intended root before editing"
              : "directed literal universe was incomplete; source absence is not proven",
      max_additional_tl_calls: 1,
    },
    checks: [],
    verify: [],
    ...(remainingContinuation ? { continuation: remainingContinuation, next: remainingCall } : {}),
    ...(!remainingContinuation ? {
      next: {
        tool: "tl_search_files",
        arguments: { action: "find", queries: [literal.source.value] },
      },
    } : {}),
  };
  const persisted = await dedupeTrimAndPersist(workspace, result, { query, args });
  // The generic shrinker derives a next hint from missing *roles* and does
  // not know that an exact literal cohort is an indivisible obligation. Put
  // this capability-relative continuation back after shrinking, and make the
  // ledger/typestate advertise the same follow-up. Repacking remeasures the
  // entire cohort, so a consumed target can never silently discharge siblings.
  if (remainingCall && remainingContinuation) {
    persisted.continuation = remainingContinuation;
    persisted.next = remainingCall;
    const contract = persisted.execution_contract;
    if (contract) {
      persisted.execution_contract = {
        ...contract,
        next_action: "followup",
        max_additional_discovery_calls: 1,
        reason: "exact literal source witnesses remain outside the initial surface cap",
        typestate: {
          phase: "discovery",
          allowed_actions: ["read", "search"],
          challenge_required_for: [],
        },
        ...(contract.call_budget ? {
          call_budget: {
            ...contract.call_budget,
            discovery_allowed: true,
            candidate_call: remainingCall,
            reason: "serve the remaining exact literal source witnesses before editing",
          },
        } : {}),
        next_call: remainingCall,
        ...(contract.semantic_closure ? {
          semantic_closure: {
            ...contract.semantic_closure,
            state: "open",
            unresolved: [...new Set([...contract.semantic_closure.unresolved, "literal-source-cohort-remaining"])],
          },
        } : {}),
      };
    }
  }
  // V15-NBR/FUI (2026-09-29): same default-OFF prototypes as the other hook
  // sites; runs after the continuation/execution_contract patch above, which
  // never touches `.surfaces` — this is still the final surface set.
  attachPlanAids(persisted, workspace, query);
  return persisted;
}

export async function buildPropagationTaskPack(
  args: TaskPackArgs,
  query: string,
  workspace: string,
): Promise<TaskPackResult | undefined> {
  // Captured BEFORE `propagationSeedResolution` runs (and before the
  // `{...args, paths}` reassignment below): a directed relation can reach
  // this function even when the caller ALREADY supplied an explicit
  // `path`/`paths` (the gate above has no pathless guard, unlike the other
  // seeding branches) -- e.g. F-V13-8's `paths:["src/statusBar.ts"]` plus a
  // "replace `X` with `Y`" query. Literal-first here may still RE-DERIVE its
  // own `paths` (a rename can span files the caller never named), but a
  // caller who already gave an explicit location keeps the existing (body-
  // withheld) fast-path behavior for it regardless -- only a truly pathless
  // caller is discovering this location for the first time.
  const hadExplicitLocation = (Array.isArray(args.paths) && args.paths.length > 0)
    || (typeof args.path === "string" && args.path.length > 0);
  const resolution = await propagationSeedResolution(args, query, workspace);
  if (resolution.literal?.kind === "absent") {
    const result: TaskPackResult = {
      mode: "task_pack",
      coverage: "complete",
      surfaces: [],
      missing: [],
      required_surfaces: [],
      route: {
        action: "answer_from_handles",
        reason: `directed literal source ${resolution.literal.source.value} has zero occurrences in the measured scope`,
        max_additional_tl_calls: 0,
      },
      checks: [],
      verify: [],
      literal_source_absence: {
        subject: resolution.literal.source.value,
        role_source: resolution.literal.source.roleSource,
        scanned_paths: resolution.literal.scannedPaths,
        universe_paths: resolution.literal.universePaths,
        universe_fingerprint: resolution.literal.universeFingerprint,
        universe_complete: resolution.literal.universeComplete,
        scope: resolution.literal.universeScope,
        excluded_paths: resolution.literal.excludedPaths,
        destination_occurrences: resolution.literal.destinationOccurrences,
      },
    };
    traceLiteralFirstRouteDecision(resolution.literal, [], "source-absent", workspace);
    return dedupeTrimAndPersist(workspace, result, { query, args });
  }
  const literalRemainingCall = resolution.literal?.kind === "present"
    ? literalFirstRemainingCall(resolution.literal, resolution.paths).call
    : undefined;
  const literalContinuationConsumed = literalRemainingCall !== undefined
    && hasExecutedNext(
      workspace,
      normalizeContractLane(args.lane),
      literalRemainingCall.tool,
      literalRemainingCall.arguments as Record<string, unknown>,
      args.taskBinding,
    );
  if (
    resolution.literal?.kind === "partial"
    || resolution.literal?.destinationCollision === true
    || (
      resolution.literal?.kind === "present"
      && resolution.literal.sourcePaths > MAX_SURFACES_DISTINCT
      && !literalContinuationConsumed
    )
    || (resolution.literal?.kind === "present" && resolution.paths.length === 0)
  ) {
    traceLiteralFirstRouteDecision(resolution.literal, resolution.paths, "safeguarded", workspace);
    return literalFirstSafeguardPack(args, query, workspace, resolution.literal, resolution.paths);
  }
  const paths = resolution.paths;
  if (paths.length < (resolution.literal?.kind === "present" ? 1 : 2)) {
    traceLiteralFirstRouteDecision(resolution.literal, paths, "abstained", workspace);
    return undefined;
  }
  const seededArgs = { ...args, paths, autoDiscoveredLocation: !hadExplicitLocation };
  if (resolution.auxiliaryCandidates !== undefined) carryAuxiliaryEnumPool(seededArgs, {
    workspace, query, candidates: resolution.auxiliaryCandidates, subjects: [], primaryPaths: paths,
    scopes: resolution.auxiliaryScopes,
  });
  const result = await buildSeededTaskPack(seededArgs, query, workspace);
  // buildSeededTaskPack captures the internal seeded request. Replace that
  // cache key with the caller's original pathless request so an exact retry
  // still receives the compact pack-unchanged response.
  captureServedPack(workspace, args, computePackFingerprint(args, workspace), result);
  traceLiteralFirstRouteDecision(
    resolution.literal,
    paths,
    result.execution_contract?.typestate.phase === "prepared" ? "committed" : "abstained",
    workspace,
    literalContinuationConsumed ? 0 : undefined,
  );
  return result;
}

export async function buildMultiConcernTaskPack(
  args: TaskPackArgs,
  query: string,
  workspace: string,
): Promise<TaskPackResult | undefined> {
  const groups = concernGroupsForQuery(query);
  if (groups.length < 2) return undefined;
  // Enum/role fan-out and explicit Markdown-contract references are one
  // cross-surface change, not independent symptoms; keep their established
  // required-role, section-selection, and closure machinery via binding fallback.
  if ((isEnumLikeQueryShaped(query) && !hasExplicitIndependentConcernMarker(query)) ||
      (/\b[\w.-]+\.md\b/i.test(query) && !hasExplicitConcernList(query))) {
    return undefined;
  }

  const cache = new FileReadCache();
  // A multi-concern request may include one exact directed relation plus
  // independent documentation/test/manifest duties.  Do not let the latter
  // route erase the relation's complete source cohort merely because the
  // multi-concern builder runs first.  This is deliberately a *hard union*,
  // not a score bonus: every exact ordinary-find witness is an edit-grade
  // required surface before concern ranking/deduplication begins.
  const literal = literalFirstRoutingEnabled()
    ? literalFirstMeasurement(args, query, workspace, undefined)
    : undefined;
  const literalSafeguardReason = literal === undefined || literal.kind !== "present"
    ? undefined
    : literal.destinationCollision
      ? "destination-collision"
      : literal.sourcePaths > literalSourceRarityLimit(literal.universePaths)
        ? "source-cohort-over-cap"
        : literal.sourcePaths > MAX_SURFACES_DISTINCT
          ? "source-cohort-remaining"
          : literal.sourceImplementationPaths === 0
            ? "source-implementation-witness-missing"
            : literal.sourceRootCount !== 1
              ? "source-root-ambiguous"
              : !literal.universeComplete
                ? "literal-universe-partial"
                : undefined;
  const literalHardSurfaces = literal?.kind === "present" && literalSafeguardReason === undefined
    ? await Promise.all(literal.sourceWitnesses.map((witness) => candidateToSurface({
        path: witness.path,
        line: witness.line,
        range: `${witness.line}-${witness.line}`,
        surface: classifySurface(witness.path),
        why: "literal-first-source",
        confidence: 1,
        required: true,
        // Exact witness lines are an indivisible proof obligation.  The
        // normal candidate widening is useful for concern ranking, but must
        // not substitute a different window for this source occurrence.
        callerRange: true,
      }, workspace, [], query, cache)))
    : [];
  const explicitPaths = (args.paths ?? [])
    .map(normalizePathEntry)
    .map((entry) => entry.path)
    .filter((entryPath) => entryPath.length > 0);
  const explicitScope = explicitPaths.length > 0
    ? commonAncestorDir(explicitPaths.map((entryPath) =>
        isDirectoryWithin(entryPath, workspace) ? `${entryPath}/.` : entryPath
      ))
    : undefined;
  const effectiveScope = args.path ?? explicitScope ?? inferQueryProjectScope(workspace, query);
  // paths[] is a hard union, not merely a ranking hint. This keeps a scoped
  // retry from reintroducing same-token files from sibling applications.
  const concernFiles = new Set(
    (explicitPaths.length > 0
      ? explicitPaths.flatMap((entryPath) =>
          walkCodeFiles(workspace, { subPath: entryPath }).map((file) => file.relPath)
        )
      : walkCodeFiles(workspace, effectiveScope ? { subPath: effectiveScope } : {}).map((file) => file.relPath)),
  );
  const ambiguityByGroup = new Map<number, string[]>();
  const matchesByGroup = await Promise.all(groups.map(async (group, groupIndex) => {
    let candidates = await literalConcernCandidates(workspace, group, concernFiles);
    if (candidates.length === 0) {
      const located = await locateTaskContext(workspace, {
        action: "locate",
        query: group.query,
        ...(effectiveScope ? { path: effectiveScope } : {}),
        ...(args.symbol ? { symbol: args.symbol } : {}),
        ...(args.lang ? { lang: args.lang } : {}),
        limit: 3,
      });
      candidates = (located.hit
        ? [...located.primary, ...located.related]
        : rankAbstainCandidates(located.candidateDetails ?? []))
        .filter((candidate) => concernFiles.has(candidate.path));
    }

    const causalPrimaryPath = candidates[0]?.path;
    const causalCompanions = await layeredControlCompanionCandidates(
      workspace,
      group,
      concernFiles,
      candidates.slice(0, 3),
    );
    if (causalCompanions.length > 0) {
      candidates = candidates.map((candidate) =>
        candidate.path === causalPrimaryPath
          ? { ...candidate, why: "concern-causal-layer" }
          : candidate
      );
      const seenPaths = new Set(causalCompanions.map((candidate) => candidate.path));
      // The user-visible controller owns the output state and should lead the
      // edit frontier; a math primitive remains the bounded second layer.
      const companionIsControl = /(?:^|\/)(?:control|controllers?)(?:\/|$)/i
        .test(causalCompanions[0]!.path);
      candidates = companionIsControl
        ? [...causalCompanions, ...candidates.filter((candidate) => !seenPaths.has(candidate.path))]
        : [...candidates, ...causalCompanions.filter((candidate) =>
            !candidates.some((existing) => existing.path === candidate.path)
          )];
    }

    if (
      candidates[0]?.why === "concern-literal"
      && candidates[1]?.why === "concern-literal"
      && Math.abs(candidates[0].confidence - candidates[1].confidence) < 0.001
    ) {
      // No query/repository evidence distinguishes these files. Returning a
      // lexicographic winner would merely replace the removed fixed alias
      // table with a different guess, so keep this concern unresolved.
      ambiguityByGroup.set(groupIndex, candidates.slice(0, 3).map((candidate) => candidate.path));
      candidates = [];
    }

    const selectedCandidates: ImpactCandidate[] = [];
    const seenCandidates = new Set<string>();
    for (const candidate of candidates) {
      const range = candidate.range ?? `${candidate.line}-${candidate.line}`;
      const key = `${candidate.path}\0${candidate.symbol ?? ""}\0${range}`;
      if (seenCandidates.has(key)) continue;
      seenCandidates.add(key);
      selectedCandidates.push(candidate);
      if (selectedCandidates.length >= 3) break;
    }

    const built = await Promise.all(selectedCandidates.map((candidate) =>
      candidateToSurface(
        { ...candidate, required: true },
        workspace,
        [],
        query,
        cache,
        {
          // 2026-08-02 anti-overfit: read the width literalConcernCandidates
          // already chose from structural evidence, instead of re-testing the
          // query against the same EN/JA word list a third time.
          causalMultiMethod: isCrossMethodConcernRange(candidate.range)
            || group.tokens.includes("race"),
        },
      )
    ));

    const seenSurfaces = new Set<string>();
    return built.filter((surface) => {
      const key = `${surface.path}\0${surface.symbol ?? ""}\0${surface.range}`;
      if (seenSurfaces.has(key)) return false;
      // Meta vocabulary such as "JSON", "auto", or "regression"
      // describes the retrieval problem but is not enough to prove that the
      // served surface addresses the concern. Require at least one substantive
      // group token in the actual path/symbol/body before declaring coverage.
      const evidenceTokens = group.tokens.filter((token) =>
        // R0 (2026-08-21, W4-A): compare case-insensitively — group.tokens
        // (concernAnchorTokens) may now carry a case-preserved identifier
        // (e.g. "buildInitializeInstructions") since orderedUniqueTokens
        // stopped silently lowercasing its output; META_CONCERN_EVIDENCE_TOKENS
        // is lowercase-only.
        !META_CONCERN_EVIDENCE_TOKENS.has(token.toLowerCase())
      );
      const matches = surface.why === "concern-causal-layer"
        || evidenceTokens.some((token) => concernTokenMatchesSurface(token, surface));
      if (matches) seenSurfaces.add(key);
      return matches;
    });
  }));

  const surfaceKey = (surface: TaskPackSurface): string =>
    `${surface.path}\0${surface.symbol ?? ""}\0${surface.range}`;
  const surfaces: TaskPackSurface[] = [];
  const selectedKeys = new Set<string>();
  const literalSourcePaths = new Set(literal?.sourceWitnesses.map((witness) => witness.path) ?? []);
  // The multi-concern builder already has an eight-surface enrichment budget.
  // A bounded exact cohort (at most six) plus independently required facets
  // must use that same bounded envelope; otherwise a docs/tests concern could
  // displace an exact source witness or vice versa.
  const surfaceLimit = literalHardSurfaces.length > 0
    ? MULTI_CONCERN_ENRICHMENT_MAX_SURFACES
    : MAX_SURFACES_DISTINCT;
  const addSurface = (surface: TaskPackSurface): void => {
    if (surfaces.length >= surfaceLimit) return;
    const key = surfaceKey(surface);
    if (selectedKeys.has(key)) return;
    selectedKeys.add(key);
    surfaces.push(surface);
  };

  // Hard sources precede every ranked concern candidate.  Keep one witness
  // per path: scanLiteral supplies a deterministic first occurrence, and the
  // obligation is the file-level source cohort rather than duplicate text in
  // the same file.
  for (const surface of literalHardSurfaces) addSurface(surface);

  // Preserve one edit-grade surface per covered concern by default. A
  // stateful saturation defect is the bounded exception: the externally
  // visible controller and its reusable numerical primitive can each own a
  // different half of anti-windup semantics. Keep exactly one cross-layer
  // companion when repository evidence found both, rather than treating the
  // helper as a locator runner-up or forcing another discovery turn.
  // (`index` is gone with the per-group query gate this loop used to consult;
  // the pairing decision is now made entirely from the surfaces themselves.)
  for (const matches of matchesByGroup) {
    const primary = matches[0];
    if (!primary) continue;
    addSurface(primary);
    // Structural admission, same rationale as layeredControlCompanionCandidates
    // above — this was a verbatim second copy of the same eight-word EN/JA
    // gate. The cross-layer pairing test below (native extension AND a
    // control⇄math directory crossing) is the structural signal it was
    // pre-filtering, and it stands on its own.
    if (!isNativeExtPath(primary.path)) continue;
    const primaryInControl = /(?:^|\/)(?:control|controllers?)(?:\/|$)/i.test(primary.path);
    const primaryInMath = /(?:^|\/)(?:math|numeric|algorithm)(?:\/|$)/i.test(primary.path);
    const companion = matches.slice(1).find((surface) => {
      if (!isNativeExtPath(surface.path)) return false;
      const inControl = /(?:^|\/)(?:control|controllers?)(?:\/|$)/i.test(surface.path);
      const inMath = /(?:^|\/)(?:math|numeric|algorithm)(?:\/|$)/i.test(surface.path);
      return (primaryInControl && inMath) || (primaryInMath && inControl);
    });
    if (companion) addSurface(companion);
  }

  // A concurrency defect often spans private state declared in a native
  // header and methods implemented in its source. The source alone can expose
  // the race while hiding the repository's existing mutex/atomic primitive,
  // which invites an incompatible synchronization mechanism. Add exactly one
  // header companion for such a concern; other concerns keep the one-surface
  // budget.
  for (const [index, group] of groups.entries()) {
    const primary = matchesByGroup[index]?.[0];
    if (!primary || surfaces.length >= MAX_SURFACES_DISTINCT) continue;
    // 2026-08-02 anti-overfit: a third, slightly-drifted copy of the same
    // EN/JA race word list used to gate here. The concern's own served window
    // already encodes that verdict structurally (see isCrossMethodConcernRange).
    if (!isCrossMethodConcernRange(primary.range) && !group.tokens.includes("race")) continue;
    const companionSet = [primary];
    await augmentNativeSurfaceClosure(companionSet, workspace, query, [], cache);
    for (const companion of companionSet.slice(1)) {
      // For a race fix the state declaration and its repository-native
      // synchronization primitive are part of the edit proof, not optional
      // review context. Keeping the header required also prevents response
      // compaction from retaining an implementation handle that refers to a
      // surface no longer present in the pack.
      companion.required = true;
      addSurface(companion);
    }
  }

  // B1c parity (2026-08-01): the multi_concern builder was the one pack path
  // that never force-included files the query literally names (T05c rep2: the
  // query said "CONTRACT.md に FR/BL/FL/BR の規定があるはず" and the pack
  // neither served nor disclosed it, then certified prepared/complete). A
  // stated requirement outranks ranked candidates, so this runs even when
  // every concern is covered, ahead of pair enrichment in cap priority.
  await augmentQueryNamedFileSurfaces(
    surfaces, query, workspace, [], cache, undefined, MULTI_CONCERN_ENRICHMENT_MAX_SURFACES,
  );

  // Serve the header/source sibling for EVERY native concern primary, not only
  // concurrency-flavored ones. A header routinely DECLARES the contract (sign
  // conventions, units, locking rules) that its source visibly violates —
  // serving the source alone yields self-consistent-but-wrong evidence (T05c
  // rep2: mixer.cpp's flipped yaw table cited "CONTRACT §7.6" as authoritative
  // while the contradicting mixer.hpp went unserved, so an obedient
  // prepared-fence caller judged bug ② absent). Enrichment pairs stay
  // required:false — they must never veto readiness — and the byte-budget trim
  // may still shed them, now with an explicit re-request disclosure.
  const addEnrichmentSurface = (surface: TaskPackSurface): void => {
    if (surfaces.length >= MULTI_CONCERN_ENRICHMENT_MAX_SURFACES) return;
    const key = surfaceKey(surface);
    if (selectedKeys.has(key)) return;
    selectedKeys.add(key);
    surfaces.push(surface);
  };
  for (const [index] of groups.entries()) {
    if (surfaces.length >= MULTI_CONCERN_ENRICHMENT_MAX_SURFACES) break;
    const primary = matchesByGroup[index]?.[0];
    if (!primary || !isNativeExtPath(primary.path)) continue;
    if (!surfaces.some((surface) => surface.path === primary.path)) continue;
    const pairPaths = nativePairCandidates(primary.path);
    if (surfaces.some((surface) => pairPaths.includes(surface.path))) continue;
    const companionSet = [primary];
    await augmentNativeSurfaceClosure(companionSet, workspace, query, [], cache);
    for (const companion of companionSet.slice(1)) addEnrichmentSurface(companion);
  }

  const concerns: ConcernCoverage[] = groups.map((_group, index) => {
    const handles = [...new Set(
      matchesByGroup[index]!
        .filter((surface) => selectedKeys.has(surfaceKey(surface)))
        .map((surface) => surface.handle),
    )];
    return {
      id: `c${index + 1}`,
      status: handles.length > 0 ? "covered" : "needs-followup",
      handles,
    };
  });
  const unresolved = concerns.flatMap((coverage, index) =>
    coverage.status === "needs-followup"
      ? [{ coverage, group: groups[index]! }]
      : []
  );
  const concernAmbiguities = [...ambiguityByGroup.entries()]
    .sort(([left], [right]) => left - right)
    .map(([index, candidates]) => ({ id: `c${index + 1}`, candidates }));
  const ambiguousIds = new Set(concernAmbiguities.map((ambiguity) => ambiguity.id));
  const discoverableUnresolved = unresolved.filter(({ coverage }) => !ambiguousIds.has(coverage.id));
  const representativeTokenFor = (group: ConcernGroup): string =>
    // R0 (2026-08-21, W4-A): case-insensitive compare — see orderedUniqueTokens.
    group.tokens.find((token) => !WEAK_CONCERN_TOKENS.has(token.toLowerCase())) ?? group.tokens[0]!;

  const result: TaskPackResult = {
    mode: "task_pack",
    coverage: unresolved.length > 0 ? "partial" : "complete",
    ...(unresolved.length > 0 ? { coverage_reason: "concerns-uncovered" as const } : {}),
    surfaces,
    missing: [],
    concerns,
    ...(concernAmbiguities.length > 0 ? { concern_ambiguities: concernAmbiguities } : {}),
    ...(discoverableUnresolved.length > 0 ? {
      blocking_next_steps: discoverableUnresolved.map(({ group }) =>
        `tl_search_files {action:"find", queries:["${representativeTokenFor(group)}"]}`
      ),
    } : {}),
    route: {
      action: concernAmbiguities.length > 0
        ? "confirm_candidates"
        : unresolved.length > 0
          ? "locate_missing_surfaces"
          : "edit_from_handles",
      reason: concernAmbiguities.length > 0
        ? `ambiguous concern candidate(s): ${concernAmbiguities.map(({ id }) => id).join(",")}`
        : unresolved.length > 0
        ? `unresolved concern(s): ${unresolved.map(({ coverage }) => coverage.id).join(",")}`
        : "all concern surfaces located",
      max_additional_tl_calls: discoverableUnresolved.length > 0
        ? Math.ceil(discoverableUnresolved.length / MAX_STAGE_CALLS)
        : 0,
    },
  };

  // Preserve the normal multi-concern evidence and contracts, but downgrade
  // the final route whenever the exact cohort cannot be proved safe.  In
  // particular, never turn the set-cover projection into an edit decision;
  // the continuation carries the omitted exact witnesses canonically.
  if (literal?.kind === "present" && literalSafeguardReason !== undefined) {
    const { call: remainingCall } = literalFirstRemainingCall(literal, []);
    result.coverage = "partial";
    result.coverage_reason = "missing-roles";
    result.missing = [...new Set([...result.missing, literalSafeguardReason])];
    result.route = {
      action: "locate_missing_surfaces",
      reason: `literal-first safeguard: ${literalSafeguardReason}`,
      max_additional_tl_calls: remainingCall ? 1 : 0,
    };
    if (remainingCall) {
      result.continuation = { version: 1, stages: [{ execution: "parallel", calls: [remainingCall] }] };
      result.next = remainingCall;
    }
  }

  if (discoverableUnresolved.length > 0) {
    const calls: ContinuationCall[] = discoverableUnresolved.map(({ coverage, group }): ContinuationCall => {
      if (coverage.handles.length > 0) {
        return { tool: "tl_read_file", arguments: { handles: coverage.handles } };
      }
      const representative = representativeTokenFor(group);
      return {
        tool: "tl_search_files",
        arguments: { action: "find", query: representative },
      };
    });
    const plan: ContinuationPlan = { version: 1, stages: [] };
    for (let index = 0; index < calls.length; index += MAX_STAGE_CALLS) {
      plan.stages.push({
        execution: "parallel",
        calls: calls.slice(index, index + MAX_STAGE_CALLS),
      });
    }
    const bounded = enforceContinuationBudget(plan);
    if (bounded) {
      result.continuation = bounded;
      const next = deriveNextFromPlan(bounded);
      if (next !== undefined) result.next = next;
    }
  }

  const persisted = await dedupeTrimAndPersist(workspace, result, {
    protectedSurfaces: new Set(surfaces),
    args,
  });
  if (literal?.kind === "present") {
    const representedSourcePaths = codeTaskPackSurfaces(persisted.surfaces)
      .map((surface) => surface.path)
      .filter((entryPath) => literalSourcePaths.has(entryPath));
    const remaining = literalFirstRemainingCall(literal, representedSourcePaths).remaining;
    const prepared = persisted.execution_contract?.typestate.phase === "prepared";
    const committed = literalSafeguardReason === undefined
      && remaining.length === 0
      && prepared;
    traceLiteralFirstRouteDecision(
      literal,
      representedSourcePaths,
      committed ? "committed" : literalSafeguardReason !== undefined ? "safeguarded" : "abstained",
      workspace,
      remaining.length,
    );
  }
  // V15-NBR/FUI (2026-09-29): same default-OFF prototypes as the other hook
  // sites; the literal-tracking block above only READS `persisted.surfaces`.
  attachPlanAids(persisted, workspace, query);
  return persisted;
}
