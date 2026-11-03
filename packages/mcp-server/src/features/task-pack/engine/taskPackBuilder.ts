// taskPackBuilder — extracted implementation; imports point to the owning modules.
import * as fs from "fs";
import * as path from "path";
import type { ContinuationCall } from "./packBasics.js";
import type { ImpactCandidate } from "@tokenlighten/types";
import type { PackCheckRecord } from "../../../state/session.js";
import type { TaskPackArgs } from "../model.js";
import type { TaskPackPathEntry } from "../model.js";
import type { TaskPackResult } from "../model.js";
import type { TaskPackSurface } from "../model.js";
import { DOC_MENTION_WORD_RE } from "./requestItemAbsence2.js";
import { FileReadCache } from "./packBasics2.js";
import { MAX_SURFACES_DISTINCT } from "./packBasics2.js";
import { REQUEST_ANCHOR_DEFINITION_WHY } from "./roleAndConcernScope3.js";
import { addSameNameDefinitionCandidates } from "./queryIntent4.js";
import { applyDominancePromotion } from "./coverageAndContinuation.js";
import { asksBeyondOneNamedSite } from "./seedAdmission.js";
import { attachPartialTree } from "./surfaceMaterialization.js";
import { attachPlanAids } from "./packTrimming2.js";
import { augmentConcernGroupSurfaces } from "./coverageAndContinuation.js";
import { augmentEditContextSurfaces } from "./focalFlow2.js";
import { augmentMissingRequiredRoleSurfaces } from "./queryIntent.js";
import { augmentNativeIdentifierCooccurrenceSurface } from "./queryIntent.js";
import { augmentNativeSurfaceClosure } from "./queryIntent.js";
import { augmentNativeWiringSurface } from "./queryIntent.js";
import { augmentQueryNamedFileSurfaces } from "./queryIntent.js";
import { augmentStyleSurface } from "./queryIntent.js";
import { bindTaskProfile } from "./coverageAndContinuation4.js";
import { buildAnswerTaskPack } from "./answerPackBuilder.js";
import { buildArtifactTaskPack } from "./artifactPackBuilder3.js";
import { buildBlockingNextSteps } from "./coverageAndContinuation.js";
import { buildCompletionChecks } from "./contractReconciliation.js";
import { buildDiffTaskPack } from "./partialPackBuilder.js";
import { buildLightAnswerPack } from "./seedResolution3.js";
import { buildMultiConcernTaskPack } from "./literalAndConcernSeeds3.js";
import { buildPartialPack } from "./partialPackBuilder2.js";
import { buildPropagationTaskPack } from "./literalAndConcernSeeds3.js";
import { buildRoute } from "./coverageAndContinuation4.js";
import { buildSeededTaskPack } from "./seededPackBuilder.js";
import { candidateToSurface } from "./surfaceMaterialization.js";
import { captureServedPack } from "./packState4.js";
import { commandLiteralAnswerTarget } from "./anchorFocus.js";
import { computePackFingerprint } from "./packState2.js";
import { concernAnchorTokens } from "./roleAndConcernScope3.js";
import { concernHarvestText } from "./roleAndConcernScope2.js";
import { continuationQuery } from "./coverageAndContinuation.js";
import { declaredProfileFromRecordUnderForceServe } from "./receiptRestoration.js";
import { dedupeTrimAndPersist } from "./packSettlement.js";
import { deriveCheckId } from "../../../state/session.js";
import { deriveCoverage } from "./coverageAndContinuation.js";
import { discoverGenericTaskPackFallback } from "./guideAndArtifactSurfaces.js";
import { discoverVerificationHints } from "./surfaceMaterialization.js";
import { effLightAnswerEnabled } from "../../../util/flags.js";
import { executedSearchHitSeeds } from "./seedAdmission.js";
import { explicitMixedEditReadRequestPaths } from "../requestItems.js";
import { explicitMultiEditRequestPaths } from "../requestItems.js";
import { explicitSingleEditRequestPath } from "../requestItems.js";
import { familyMemberAdvisory } from "../familyMemberSeeds.js";
import { familyMemberSeedPlan } from "../familyMemberSeeds.js";
import { finalizePrimarySurface } from "./createAndWiringEndpoints2.js";
import { handleTable } from "../../../util/handles.js";
import { hasCreateOrPlacementIntent } from "./createAndWiringEndpoints.js";
import { hasServedCode } from "./wiringEvidence2.js";
import { importEvidenceExpansion } from "./epochContract3.js";
import { inferQueryProjectScope } from "../../locator/locateTaskContext.js";
import { isCandidateListPackPending } from "../../../state/session.js";
import { isDirectoryWithin } from "./seedResolution.js";
import { isExistingWorkspaceFile } from "./seedAdmission.js";
import { isPendingCandidateRestatement } from "./epochContract3.js";
import { isSymptomShapedQuery } from "./partialPackBuilder.js";
import { isUnderAncestor } from "./seedResolution.js";
import { isWithin } from "../../../util/safePath.js";
import { lightAnswerVerdict } from "./seedResolution.js";
import { literalFirstMultipleRelations } from "./literalAndConcernSeeds.js";
import { literalFirstRelation } from "./literalAndConcernSeeds.js";
import { literalFirstRoutingEnabled } from "../../../util/flags.js";
import { literalSeedAdvisory } from "../literalSeeds.js";
import { literalSeedPlanFor } from "./identifierAbsence2.js";
import { locateTaskContext } from "../../locator/locateTaskContext.js";
import { mergeUnique } from "./roleAndConcernScope.js";
import { moveNamedDeclarationFirst } from "./roleAndConcernScope3.js";
import { namedCallableDefinitions } from "./queryIntent4.js";
import { namedScopeSignature } from "./packState2.js";
import { namedTargetResolutionEnabled } from "../../../util/flags.js";
import { nextHintForCoverage } from "./coverageAndContinuation.js";
import { normalizePathEntry } from "./packBasics2.js";
import { normalizedRequestPath } from "./guideAndArtifactSurfaces.js";
import { noteInheritedTaskProfile } from "./coverageAndContinuation4.js";
import { noteSemanticFrontierTraceSeed } from "../../../protocol/semanticFrontierTraceContext.js";
import { parseSurfaceSpan } from "./packState2.js";
import { pendingCandidatePaths } from "./epochContract3.js";
import { preferDefinitionSites } from "./partialPackBuilder2.js";
import { prepareSemanticFrontierTraceSeed } from "../semanticFrontier.js";
import { projectRootOf } from "../../locator/locateTaskContext.js";
import { promoteVariantSurfaces } from "./queryIntent.js";
import { queryNamedPathTokens } from "./queryIntent3.js";
import { queryNamesCreateTarget } from "./createAndWiringEndpoints.js";
import { recordConcernTokens } from "../../../state/session.js";
import { requestAsksForChange } from "./coverageAndContinuation3.js";
import { requestsWorkingTreeInvestigation } from "./partialPackBuilder.js";
import { requiredSurfacesForTask } from "./roleAndConcernScope.js";
import { resolveDominantSurfaceIndex } from "./coverageAndContinuation.js";
import { resolveReal } from "../../../util/safePath.js";
import { retainedServedSeedPaths } from "./seedAdmission.js";
import { rootMarkdownTitleMatch } from "./partialPackBuilder.js";
import { safeResolve } from "../../../util/safePath.js";
import { selectClosureCandidates } from "./partialPackBuilder2.js";
import { semanticFrontierGuardEnabled } from "../../../util/flags.js";
import { setActiveRootWorkspace } from "../../locator/locateTaskContext.js";
import { shouldRedirectToOverview } from "./partialPackBuilder.js";
import { singleSiteShortCircuitSeed } from "./seedAdmission.js";
import { stripDelegationActorSpans } from "../requestItems.js";
import { stripFencedBlocksForLocating } from "./createAndWiringEndpoints2.js";
import { tryServeCachedPack } from "./receiptRestoration2.js";
import { tryServeSemanticDuplicatePack } from "./receiptRestoration2.js";
import { tryServeSupersedingCertifiedRecord } from "./receiptRestoration2.js";
import { unmatchedConcernTokens } from "./roleAndConcernScope3.js";
import { withNamedDeclarationLead } from "./roleAndConcernScope.js";

export async function buildTaskPackCore(
  args: TaskPackArgs,
  workspace: string,
): Promise<TaskPackResult> {
  const query = args.query ?? args.symbol ?? args.path ?? "";

  // F-R14 (2026-08-22, DESIGN-v0.11 §9 residual): a create-with-content
  // query's fenced block is the new file's own body, not a locating signal
  // — see queryNamesCreateTarget/stripFencedBlocksForLocating below for the
  // gate and the strip. `locatingQuery` feeds the locator/evidence/concern/
  // wiring consumers in this function; `query` itself is untouched and
  // still feeds create-target resolution (dedupeTrimAndPersist's
  // effectiveQuery -> resolveCreateTargetFromQuery), the wire task.query
  // echo, profile binding, and the pack fingerprint/dedupe ledger.
  // Explicit delegation actors are also omitted from retrieval; their work
  // instructions and any quoted source literals remain intact.
  const locatingQuery = stripDelegationActorSpans(queryNamesCreateTarget(query, workspace)
    ? stripFencedBlocksForLocating(query)
    : query);

  // Guard 2 (2026-07-12b decoy-fix forensics): harvest this query's FIX-A-
  // filtered concern-anchor tokens into the session's rolling set so a later
  // PARTIAL slice of a file can warn when the interesting region — the one
  // this very query is about — sits outside what got served (see
  // readCodeModes.ts resolveSlice's range path / buildConcernNote). Fired
  // unconditionally, before any redirect/cache-dedup/branch below, so every
  // call into buildTaskPack contributes regardless of which branch ends up
  // serving it.
  //
  // W9 (root-leak forensics): harvest from args.query / args.symbol only — a
  // bare `path` fallback (no query/symbol given) is a structural locator the
  // pack already resolves, not a free-text concern; recording it made a
  // path-only task_pack call harvest its own directory name as if it were a
  // query. Whatever text IS harvested is also scrubbed of the workspace
  // root's own folder name and any path-shaped spans BEFORE tokenization
  // (concernHarvestText), so a query that happens to mention the project by
  // folder name ("fix the m365-drive-mount project ...") cannot leak that
  // name in as a concern token either.
  const concernHarvestSource = args.query ?? args.symbol ?? "";
  // F-R14: concernHarvestSource mirrors `query` whenever args.query/symbol is
  // what fed it (the common case for a create-with-content request) — reuse
  // the already-stripped locatingQuery then, rather than re-deriving a
  // second strip decision. The rarer args.path-fallback case
  // (concernHarvestSource === "") is intentionally left untouched, matching
  // the existing W9 exclusion of the path fallback from concern harvesting.
  const locatingConcernHarvestSource = concernHarvestSource === query
    ? locatingQuery
    : concernHarvestSource;
  recordConcernTokens(workspace, concernAnchorTokens(concernHarvestText(workspace, locatingConcernHarvestSource)));

  // General project-root model (DESIGN-v0.8 §A2): register this workspace so
  // the pack's own projectRootOf(path) root-grouping (dominant-root vote for
  // verify-hint scoping, in-root inventory, native-wiring confinement) uses
  // the same marker/VCS-based resolver the locator does — not a bench-specific
  // path boundary. buildSeededTaskPack / the diff path all run under this.
  setActiveRootWorkspace(workspace);

  // Agents sometimes use the prose sentinel "auto" as though it were a real
  // path, or pass broad guessed directories before the target project has been
  // located. Neither is exact-file evidence. Drop the sentinel and, for a
  // strongly shaped task that names one uniquely resolvable project root,
  // convert directory-only guesses into that project exploration scope. Exact
  // file paths remain authoritative.
  const cleanedPath = args.path && normalizedRequestPath(args.path) !== "auto"
    ? args.path
    : undefined;
  const cleanedEntries = (args.paths ?? [])
    .map(normalizePathEntry)
    .filter((entry) => normalizedRequestPath(entry.path) !== "auto");
  // P1-2 (hands-on report): capture the FULL binding, not just `.selected` —
  // an early-return branch below (shouldRedirectToOverview) used to return
  // before this binding's result ever reached the wire, so an explicit
  // task.profile:"answer" silently echoed back as "generic". Threading the
  // already-computed binding onto that stub is additive; every other reader
  // of `cleanedProfile` is unaffected.
  const taskProfileBinding = noteInheritedTaskProfile(bindTaskProfile(args.taskProfile, query, args.writeAllowed), args);
  const cleanedProfile = taskProfileBinding.selected;
  // TL_EFF_LIGHT_ANSWER (class (B), default OFF): a fresh answer question about
  // ONE small, self-contained file skips everything below that discovers —
  // the named-project inference, the routing, the pathless locator — and is
  // built by the seeded builder a caller-supplied target takes (see
  // `lightAnswerTarget`). OFF, `lightAnswerTarget` returns at its first line.
  if (locatingQuery === query && effLightAnswerEnabled()) {
    const light = await lightAnswerVerdict(args, query, workspace, taskProfileBinding);
    if ("target" in light) return buildLightAnswerPack(args, query, workspace, light.target);
  }
  const directoryLike = (candidatePath: string): boolean =>
    isDirectoryWithin(candidatePath, workspace) || path.extname(candidatePath) === "";
  const directoryEntries = cleanedEntries.filter((entry) => directoryLike(entry.path));
  const exactFileEntries = cleanedEntries.filter((entry) => !directoryLike(entry.path));
  const directoryOnly = cleanedEntries.length > 0
    && cleanedEntries.every((entry) => directoryLike(entry.path));
  const inferredNamedProjectScope = cleanedProfile !== "generic"
    && !args.symbol
    && (!cleanedPath || directoryLike(cleanedPath))
    ? inferQueryProjectScope(workspace, locatingQuery)
    : undefined;
  const directoryGuessesMissNamedScope = inferredNamedProjectScope !== undefined
    && directoryEntries.length > 0
    && !directoryEntries.some((entry) =>
      isUnderAncestor(inferredNamedProjectScope, normalizedRequestPath(entry.path))
    );
  const namedProjectScope = inferredNamedProjectScope !== undefined
    && (
      cleanedEntries.length === 0
      || directoryOnly
      // Preserve exact files such as a caller-named contract, but do not let
      // an unrelated broad directory guess confine a strongly named project
      // out of existence. This repairs mixed calls like [generic-dir,
      // root-contract] without weakening exact-file authority.
      || directoryGuessesMissNamedScope
    )
      ? inferredNamedProjectScope
      : undefined;
  if (cleanedProfile === "answer" && !cleanedPath && !args.symbol && cleanedEntries.length === 0
    && namedProjectScope === undefined && queryNamedPathTokens(locatingQuery).length === 0
    && !DOC_MENTION_WORD_RE.test(locatingQuery)) {
    const commandTarget = commandLiteralAnswerTarget(locatingQuery, workspace);
    if (commandTarget !== undefined) {
      return buildSeededTaskPack({ ...args, paths: [commandTarget], autoDiscoveredLocation: true }, query, workspace);
    }
  }
  // WP-S8 (TL_NAMED_TARGET_RESOLUTION, 2026-09-20): the repair above was
  // written for a directory the model GUESSED before it had located the
  // project ("src", "backend") -- but it drops EVERY directory entry once an
  // inferred scope stands in for them. A caller-named directory that really
  // EXISTS in this workspace is not that guess. On the recorded GitHub Copilot
  // session the caller named three existing directories, each with its own
  // `purpose`, and one inferred scope replaced all three before the seeded
  // builder ever saw them -- so the directory-evidence rule in
  // `buildSeededTaskPack` had nothing left to work with, and the service
  // directory holding the classes the question was about was never opened.
  // Keep those entries, AHEAD of the inference (which is the weaker claim,
  // being this server's own reading of the query rather than something the
  // caller wrote); an extensionless path that does NOT exist is still a guess
  // and is still repaired exactly as before. OFF, this list is empty and
  // `repairedEntries` is byte-identical to before this flag.
  const keptNamedDirEntries = namedProjectScope !== undefined && namedTargetResolutionEnabled()
    ? directoryEntries.filter((entry) =>
        isDirectoryWithin(entry.path, workspace)
        && normalizedRequestPath(entry.path) !== normalizedRequestPath(namedProjectScope)
      )
    : [];
  const repairedEntries = namedProjectScope
    ? directoryOnly || cleanedEntries.length === 0
      ? [...keptNamedDirEntries, { path: namedProjectScope }]
      : [
          ...keptNamedDirEntries,
          { path: namedProjectScope },
          ...exactFileEntries.filter((entry) =>
            normalizedRequestPath(entry.path) !== normalizedRequestPath(namedProjectScope)
          ),
        ]
    : cleanedEntries;
  const requestArgs = args;
  args = {
    ...args,
    ...(namedProjectScope
      ? { path: undefined, paths: repairedEntries }
      : {
          path: cleanedPath,
          paths: cleanedEntries.length > 0 ? cleanedEntries : undefined,
        }),
  };
  // Every capture below keys the served-pack record by these rewritten paths,
  // while the receipt preflight fingerprints the request as sent (see
  // TaskPackArgs.namedScopeRequest). 2026-10-04: a legacy mode:"task_pack"
  // re-ask of a question naming aeroctl, in a workspace that also held
  // ledgerd, missed its record and got `decision-unchanged`.
  if (namedProjectScope) {
    args.namedScopeRequest = {
      args: requestArgs,
      signature: namedScopeSignature(args, computePackFingerprint(args, workspace)),
    };
  }

  // Some clients emit both path and paths=[path] for the same already-known
  // answer target. That duplicate is one exact file, not a multi-file seeded
  // request. Normalize it before branch routing so semantic-responsibility
  // resolution is not accidentally bypassed by a syntactic duplicate.
  if (cleanedProfile === "answer" && !args.symbol) {
    const entries: TaskPackPathEntry[] = [
      ...(args.path ? [{ path: args.path }] : []),
      ...(args.paths ?? []).map(normalizePathEntry),
    ];
    const unique = new Map(
      entries.map((entry) => [normalizedRequestPath(entry.path), entry] as const),
    );
    const only = [...unique.values()][0];
    if (
      args.path !== undefined
      && unique.size === 1
      && only !== undefined
      && !directoryLike(only.path)
      && entries.every((entry) => entry.range === undefined && entry.symbol === undefined)
    ) {
      args = { ...args, path: only.path, paths: undefined };
    }
  }

  // B1c (2026-08-01 retrieval-scope): a candidate choice is still PENDING and
  // the caller re-asked with nothing but the query. Re-deriving from scratch
  // reproduces the same ambiguity — a second candidate list over the same
  // files, which is the degradation T05c rep0 spent turns on. Bind the pending
  // candidates as paths so the re-pack CONVERGES on them (the seeded flow then
  // serves their bodies and, with the choice resolved, the brake releases).
  // Never overrides a caller who supplied their own scope, and never fires
  // outside an armed brake (a resolved choice, an edit, or taskEpoch:"new" all
  // clear it — see state/session.ts's candidatePackPending).
  if (
    !args.path
    && !args.symbol
    && !(args.paths?.length)
    && query.trim().length > 0
    && isCandidateListPackPending(workspace)
  ) {
    const pending = pendingCandidatePaths.get(path.resolve(workspace));
    // Only a RESTATEMENT of the pending request may inherit its candidates —
    // the session brake stays armed across an unrelated next task, and binding
    // that task to the previous one's files would be a hard mis-scope.
    const bindable = pending !== undefined && isPendingCandidateRestatement(pending, query)
      ? pending.paths.filter((rel) => {
          const abs = safeResolve(rel, workspace);
          return abs !== undefined && fs.existsSync(abs);
        })
      : [];
    if (bindable.length > 0) {
      args = { ...args, paths: bindable.map((rel) => ({ path: rel })) };
    }
  }

  // -------------------------------------------------------------------------
  // TL142-01A (2026-09-13, v0.14.2 hands-on report §4 TL142-01 "A") —
  // WHAT AN EXECUTED SEARCH LOCATED IS THIS REBUILD'S SEED.
  //
  // A pack that cannot place an identifier the query names asks the caller to
  // run `tl_search_files` for it. The caller runs it, the search finds the file —
  // and before this wave that fact reached nothing: the next rebuild of the
  // same task re-derived its candidate set from the query alone, did not
  // include the located file, left the identifier obligation uncovered, and
  // fell through to re-reading an already-served window of an UNRELATED
  // surface (which answers as a `read.receipt`) or to re-proposing the same
  // search under a different argument spelling. Reproduced end-to-end: first
  // pack serves `src/auth.ts`, prescribes `find MAX_RETRIES`, the search
  // returns `src/retry.ts:1`, and three successive resumes never serve
  // retry.ts.
  //
  // Promoting the hit to a SEED (rather than only to a `next`, which
  // `alternativeProgressAxis`' Rule 1b now also does as the second line of
  // defence) is what makes the located file a REQUIRED SURFACE of this
  // rebuild: the ordinary serve path ships its body, the ordinary obligation
  // pass proves the identifier from it, and the certificate covers it. Marked
  // `autoDiscoveredLocation` for the same reason the literal-first seed at
  // `buildPropagationTaskPack` is — the paths did not come from the caller.
  //
  // CONTINUATIONS ONLY. A fresh `task.epoch:"new"` build is left byte-identical
  // to before: the ledger is a continuation aid, and two fresh builds of one
  // query must still agree with each other. Terms are matched VERBATIM against
  // the query text, so a search another task ran in this lane can never inject
  // its files here.
  // -------------------------------------------------------------------------
  if (
    !args.path && !args.symbol && !(args.paths?.length)
    && query.trim().length > 0
    && args.taskEpoch !== "new"
  ) {
    const { code: locatedCode, unclassified: locatedUnclassified } = executedSearchHitSeeds(workspace, args, query);
    // SHOULD-FIX 28: both classes are SEEDS (the file is served either way);
    // only the `why` stamp and what may discharge an obligation differ.
    const located = [...locatedCode, ...locatedUnclassified].sort();
    if (located.length > 0) {
      // R1-B2 (2026-09-13 review round): SEEDS ADD, THEY DO NOT REPLACE.
      //
      // Setting `paths` routes the build through `buildSeededTaskPack`, which
      // treats that list as the WHOLE located set — so promoting one hit
      // silently evicted every surface this task had already served, re-opening
      // an obligation the earlier pack had closed (observed: a resume whose pack
      // was only the newly-located file, with the previously served, correct
      // surface gone from `evidence` entirely). The still-valid surfaces this
      // epoch already served are carried alongside the located paths, located
      // FIRST so the new evidence keeps first claim on the byte budget and the
      // carried ones dedupe to `prior` instead of re-sending bytes.
      const carried = retainedServedSeedPaths(workspace, query, located);
      args = {
        ...args,
        paths: [...located, ...carried].map((relPath) => ({ path: relPath })),
        autoDiscoveredLocation: true,
        // R1-B2: the seeded paths' honest provenance. Routing them through
        // `paths` made `buildSeededTaskPack` stamp `why:"caller-supplied"` on a
        // path the caller never supplied (and `whySummary` then doubled it to
        // "caller-supplied; caller-supplied"). Naming them here lets that
        // builder say where they actually came from.
        executedSearchLocated: locatedCode,
        // SHOULD-FIX 28: stamped separately so the surface SAYS the declaration
        // is unverified rather than implying a classified code hit.
        executedSearchLocatedUnclassified: locatedUnclassified,
      };
    }
  }

  if (shouldRedirectToOverview(args, locatingQuery)) {
    return {
      mode: "task_pack",
      coverage: "partial",
      surfaces: [],
      missing: [],
      ok: false,
      reason: "broad-overview-query",
      next: { tool: "tl_read_file", arguments: { mode: "overview" } },
      alternatives: [
        "tl_search_files {action:\"tree\"}",
        "tl_read_file {query:\"<specific subsystem>\", content:\"outline\"}",
        "tl_search_files {action:\"find\", queries:[\"<specific symbol>\"], scope:{kind:\"symbol\"}}",
      ],
      // P1-2 (hands-on report): thread the already-computed profile binding
      // through this early return too, mirroring dedupeTrimAndPersist's own
      // `result.profile_binding = binding; if (profile !== "generic")
      // result.task_profile = profile;` pattern — an explicit
      // task.profile:"answer" must survive this branch, not silently flip to
      // "generic" for lack of anywhere to land.
      profile_binding: taskProfileBinding,
      ...(taskProfileBinding.selected !== "generic" ? { task_profile: taskProfileBinding.selected } : {}),
    };
  }

  // Ensure the repo handle exists so read_code can canonicalize against it.
  handleTable.upsert({ kind: "repo", workspaceRoot: workspace });

  // -------------------------------------------------------------------------
  // Behavior 3: task_pack re-call dedup. Compute the request fingerprint ONCE
  // and, if this call exactly re-issues the last served pack for this
  // workspace AND every surface file is unchanged, return the sub-1KB compact
  // acknowledgement instead of recomputing the whole pack. Placed before every
  // build branch (seeded / diff / locate) so any flow's prior pack can dedup a
  // repeat. A differing "extra" arg (path/symbol/lang/limit) or any changed
  // surface file makes tryServeCachedPack return undefined -> full recompute.
  // -------------------------------------------------------------------------
  // PI-09 close-out: `force_serve:true` says the caller's context was
  // compacted, so every proof this dedup rests on ("you already hold these
  // bytes") is proof about a context that no longer exists. The two receipt
  // paths below are skipped outright — the SAFE direction, more bytes never
  // fewer — while the record capture at the end of the build is untouched, so
  // the caller's next ordinary call dedups against the freshly served pack.
  const fingerprint = computePackFingerprint(args, workspace);
  const forceServe = args.forceServe === true;
  // P2-12: force_serve skips every cache door below, but the task's own
  // DECLARED profile is not a cache fact — restore it from the stored
  // record (read-only; see that function's own doc comment) before anything
  // below reads `args.taskProfile`, so a force-served rebuild binds and
  // reports `profile_binding` exactly as an ordinary continuation would.
  if (forceServe) {
    const declared = declaredProfileFromRecordUnderForceServe(workspace, args, fingerprint);
    if (declared !== undefined) {
      args.taskProfile = declared as TaskPackArgs["taskProfile"];
      args.taskProfileInherited = true;
    }
  }
  const cached = forceServe ? undefined : tryServeCachedPack(workspace, args, fingerprint);
  if (cached !== undefined) {
    // Receipt/qref exits bypass the common build tail, but they still crossed
    // this call's task-pack producer.  Register the same opaque seed here so
    // funnel finalization records exactly one honest receipt attestation.
    noteSemanticFrontierTraceSeed(
      prepareSemanticFrontierTraceSeed(cached, query, semanticFrontierGuardEnabled()),
    );
    return cached;
  }
  // iter-3 F2: the exact-fingerprint dedup misses a re-issue that was merely
  // truncated mid-word (or tokenizes slightly differently) though it names the
  // same working set. Recognize such a near-identical re-ask and serve the same
  // compact receipt, gated on path-subset ∧ high token overlap ∧ unchanged
  // workspace so distinct-concern packs never collapse into one another.
  const semanticDup = forceServe ? undefined : tryServeSemanticDuplicatePack(workspace, args);
  if (semanticDup !== undefined) {
    noteSemanticFrontierTraceSeed(
      prepareSemanticFrontierTraceSeed(semanticDup, query, semanticFrontierGuardEnabled()),
    );
    return semanticDup;
  }
  // R-D2 (item A rule 2): both doors above can only ever rediscover a
  // pathless SEED record (their own fingerprint/requestPaths matching is by
  // design), which `recordPredatesAdditionalServedEvidence` may correctly
  // decline once this task has moved on. Before falling all the way through
  // to a full REBUILD from that seed shape, check whether this SAME task
  // already reached a certified decision that is still current — see
  // `tryServeSupersedingCertifiedRecord`'s own doc comment.
  const superseding = forceServe ? undefined : tryServeSupersedingCertifiedRecord(workspace, args, fingerprint);
  if (superseding !== undefined) {
    noteSemanticFrontierTraceSeed(
      prepareSemanticFrontierTraceSeed(superseding, query, semanticFrontierGuardEnabled()),
    );
    return superseding;
  }

  const initialProfile = bindTaskProfile(args.taskProfile, query, args.writeAllowed).selected;

  if (!args.path && !args.symbol && !(args.paths?.length)) {
    const docPath = rootMarkdownTitleMatch(workspace, query);
    if (docPath !== undefined) {
      return buildSeededTaskPack({ ...args, paths: [docPath], taskProfile: "answer" }, query, workspace);
    }
  }

  // T2: scoped to the exact shape attachSingleSiteUniqueMatchFastPath already
  // trusts (a plain, non-specialized generic edit request naming no
  // structured path) so every other profile's routing below is completely
  // unaffected, and placed before it so a real hit never pays for the
  // multi_concern/wiring/artifact_build/answer builders' own discovery cost.
  if (
    initialProfile === "generic"
    && !args.path
    && !args.symbol
    && !(args.paths?.length)
  ) {
    const shortCircuitSeed = singleSiteShortCircuitSeed(query, workspace);
    if (shortCircuitSeed !== undefined) {
      return buildSeededTaskPack({ ...args, paths: [shortCircuitSeed], autoDiscoveredLocation: true }, query, workspace);
    }
  }

  // 2026-11-02 (external evaluation T2, "add a SESSION_COOKIE_SALT config
  // key"): a request that ADDS a new member of an existing identifier family
  // names something that occurs nowhere yet, so every lexical locator layer
  // abstains on it and the pack fell back to the Sphinx conf.py of an inferred
  // `docs/` scope or a fixture whose file name was the project name. The
  // siblings (`SESSION_COOKIE_NAME`, …) already say where the change goes:
  // seed their definition site, consumers, documentation and a test through
  // the seeded builder, so the agent can edit from the first reply. Only for
  // a change request on the generic/artifact_build/multi_concern profiles
  // (`change_propagation` keeps its own enum-extension builder, `wiring`/
  // `answer` are different shapes) and only when `familyMemberSeedPlan`
  // proves the family; every other request is untouched.
  if (
    !args.path
    && !args.symbol
    && !(args.paths?.length)
    && (initialProfile === "generic" || initialProfile === "artifact_build" || initialProfile === "multi_concern")
    && requestAsksForChange(query)
  ) {
    const family = familyMemberSeedPlan(query, workspace);
    if (family !== undefined) {
      const seeded = await buildSeededTaskPack({ ...args, paths: [...family.seeds], autoDiscoveredLocation: true }, query, workspace);
      if (seeded.surfaces.length > 0) {
        const result: TaskPackResult = {
          ...seeded,
          ...(seeded.advisory === undefined ? { advisory: familyMemberAdvisory(family) } : {}),
        };
        // The seeded builder cached its internal paths[] call; rebind the
        // cache to the caller's own pathless request (as the inferred-scope
        // retry below does).
        captureServedPack(workspace, args, computePackFingerprint(args, workspace), result);
        return result;
      }
    }
  }

  // -------------------------------------------------------------------------
  // TL142-02 (2026-09-13, v0.14.2 hands-on report §4 TL142-02) — "N >= 2
  // INDEPENDENT NAMED EDITS" is its own recognized query shape, checked
  // AHEAD of both the multi-concern classifier immediately below and
  // literalFirstRelation's single-relation grammar (further below): a query
  // naming >=2 explicit (file, identifier) pairs is counted by TARGETS, not
  // matched by a single-relation verb regex that can only ever describe one
  // rename ("replace/rename/change A to/with/into B") — that regex has zero
  // tolerance for the "in <path> from <old> to <new>" clause shape English
  // (and, coincidentally, a Japanese digit fragment) actually use, which is
  // why "Change DEFAULT_TTL_MS in src/cache.ts from 60000 to 30000, and
  // MAX_RETRIES in src/retry.ts from 3 to 5." fell through to the ambiguous
  // role-locator and dead-ended in choose-candidate (missing:["contract",
  // "api","domain"]) despite naming both files, both identifiers, and both
  // old/new values explicitly, and why a two-SENTENCE phrasing of the same
  // request landed in the multi-concern builder instead (whose own `next`
  // separately dead-ends into a bodyless read.receipt — a distinct defect
  // this recognizer also sidesteps by claiming the query first). Reuses
  // extractRequestItems (requestItems.ts's `explicitMultiEditRequestPaths`)
  // — the one part of this pipeline the report's own repro already showed
  // generalizes correctly across EN "and"/comma/two-sentences/bullets and JA
  // "、" — so this recognizer is language-neutral BY CONSTRUCTION, not by a
  // second, parallel EN/JA regex pair. A single directed rename ("rename X
  // to Y") never qualifies (one item, or one item naming no separate
  // identifier alongside its file); a genuinely ambiguous alternative list
  // ("change X to Y or Z") never qualifies either (no item names an
  // explicit file at all) — both keep falling through to
  // literalFirstRelation/the role-locator's choose-candidate exactly as
  // before. Routes into the SAME builder the JA phrasing already reaches
  // (buildSeededTaskPack, via literalFirstRelation below) — never the
  // multi-concern builder — so the result is always `act.edit` with one
  // "edit" obligation per named file, never `await_input`.
  // -------------------------------------------------------------------------
  // -------------------------------------------------------------------------
  // Round 4 (2026-09-14, T4 — review-findings-3.md SHOULD-FIX 15's wire-
  // routing residual / fix-notes-t3.md's EN-sibling caveat): the recognizer
  // above only ever seeds the WRITABLE set (`explicitMultiEditRequestPaths`
  // itself drops any path whose own governing lead is "read", by design), so
  // a genuinely MIXED request ("Explain X in a.ts, and change Y in b.ts.")
  // has only ONE qualifying path, fails the ">=2" gate, and — since this
  // exact clause shape also defeats `literalFirstRelation` below — falls all
  // the way through to the ambiguous role-locator and dead-ends in
  // `choose-candidate`, despite naming both files and both identifiers
  // explicitly. `explicitMixedEditReadRequestPaths` (requestItems.ts) is the
  // exact same `requestItemLeads` classification, seeding the READ-lead
  // path ALONGSIDE the edit-lead one instead of dropping it entirely —
  // `buildTaskChangeContract`'s own `readOnlyLeadPaths` veto (below) then
  // assigns `action:"review"` to it and `action:"edit"` only to the genuine
  // target, so the result is `act.edit` with exactly the edit-lead path(s)
  // writable and the read-lead path(s) served as evidence — never
  // `choose-candidate`. Tried only after the pure multi-edit recognizer
  // declines, so a genuinely ambiguous alternative list (no second path at
  // all) still falls through unchanged.
  // -------------------------------------------------------------------------
  if (
    !args.path && !args.symbol && !(args.paths?.length)
    && literalFirstRoutingEnabled()
  ) {
    const explicitEditPaths = explicitMultiEditRequestPaths(query) ?? explicitMixedEditReadRequestPaths(query);
    if (explicitEditPaths !== undefined) {
      return buildSeededTaskPack({ ...args, paths: explicitEditPaths, autoDiscoveredLocation: true }, query, workspace);
    }
  }

  // A multi-concern request must keep its concern boundaries when the caller
  // narrows a follow-up with paths=[...]. Generic seeded routing discards the
  // per-concern contract and can collapse several independent defects into one
  // role-ranked surface set. Try the specialized builder before path seeding;
  // it applies the supplied paths as a hard file scope below.
  if (
    initialProfile === "multi_concern"
    || (literalFirstRoutingEnabled() && literalFirstMultipleRelations(query))
  ) {
    const multiConcernPack = await buildMultiConcernTaskPack(args, query, workspace);
    if (multiConcernPack !== undefined) return multiConcernPack;
  }

  const suppliedPathEntries = (args.paths ?? []).map(normalizePathEntry);
  const directoryScopesOnly = suppliedPathEntries.length > 0
    && suppliedPathEntries.every((entry) => directoryLike(entry.path));
  const singleDirectoryScope = suppliedPathEntries.length === 1
    && isDirectoryWithin(suppliedPathEntries[0]!.path, workspace)
    ? suppliedPathEntries[0]!.path
    : undefined;
  const scopedSpecializedArgs = singleDirectoryScope
    ? { ...args, path: singleDirectoryScope, paths: undefined }
    : args;

  // A pathless propagation request often names the definition and several
  // consumers explicitly (enum/type, aggregate, UI component, etc.). Resolve
  // those identifiers into a bounded seed union before the generic locator
  // chooses a single primary. The seeded builder then applies the normal
  // required-role, style, closure, and change-contract machinery.
  // D10 (2026-08-14): `TL_EVIDENCE_RELATIONS` is deleted; relation-backed
  // propagation is unconditional.
  // A validated same-task qref continuation names exact source windows.
  // Re-running propagation discovery would replace them with path-only seeds.
  const replayedRangedScope = args.taskQueryRefReplay === true
    && typeof args.taskBinding === "string" && args.taskBinding.length > 0
    && suppliedPathEntries.length > 0
    && suppliedPathEntries.some(entry => parseSurfaceSpan(entry.range ?? "") !== undefined)
    && suppliedPathEntries.every(entry => !directoryLike(entry.path));
  if (
    (initialProfile === "change_propagation" && !replayedRangedScope)
    // Directed relations are propagation work even when profile inference does
    // not know the verb (notably Japanese リネーム); still fully flag-gated.
    || (literalFirstRoutingEnabled() && literalFirstRelation(query, args.symbol) !== undefined)
    || (
      (!(args.paths?.length) || directoryScopesOnly)
      && initialProfile === "wiring"
    )
  ) {
    const propagationPack = await buildPropagationTaskPack(args, query, workspace);
    if (propagationPack !== undefined) return propagationPack;
  }

  // 2026-11-03 (TL_LITERAL_FIRST_SEEDS, literalSeeds.ts; billing analysis of
  // Claude Code sessions, where cost is new tokens entering context): a
  // pathless ANSWER request that ASKS ABOUT a distinctive exact literal — an
  // UPPER_SNAKE constant or env var, a quoted string, a long lowercase dotted
  // key, with a lookup lead and no other code-shaped term beside it
  // (`literalIsLookupSubject`) — is answered from where that literal is
  // SPELLED, not from the fuzzy-ranked candidates. Measured on this repository,
  // "Where is <the tool-surface env var> read and what values does it accept?"
  // (the token is not spelled here, so this file never joins its hit set) put a
  // bench experiment's scripts ahead of `server.ts`'s `resolveToolSurface`
  // and reached `act.answer` after three turns and 33.6 KB; `find` for the
  // token had the reading site in 2.7 KB. The plan runs the `find` engine for
  // the literal, keeps the files whose hits concentrate (product source ahead
  // of bench/tests/examples, one doc window when the code seeds are few), and
  // seeds their hit windows through the seeded builder, so the normal
  // readiness, closure and certificate machinery owns the result. A literal
  // with no code-position hit, or one spread over more files than the caps,
  // yields no plan and the request keeps the routing below — including the
  // quoted-literal absence reporting. Answer profile only: a change request
  // keeps its own seeding (the family plan above, the literal-first relation
  // route, the single-site short circuit), and `generic` reads keep the
  // locator so a bare identifier question is unchanged.
  if (
    !args.path
    && !args.symbol
    && !(args.paths?.length)
    && initialProfile === "answer"
    && query.trim().length > 0
  ) {
    const literalPlan = await literalSeedPlanFor(query, workspace);
    if (literalPlan !== undefined) {
      const seeded = await buildSeededTaskPack({ ...args, paths: [...literalPlan.seeds], autoDiscoveredLocation: true }, query, workspace);
      if (seeded.surfaces.length > 0) {
        const result: TaskPackResult = {
          ...seeded,
          ...(seeded.advisory === undefined ? { advisory: literalSeedAdvisory(literalPlan) } : {}),
        };
        // The seeded builder cached its internal paths[] call; rebind the
        // cache to the caller's own pathless request (as the family plan
        // above and the inferred-scope retry below do).
        captureServedPack(workspace, args, computePackFingerprint(args, workspace), result);
        return result;
      }
    }
  }

  // A single directory in paths[] is a search scope, not a declaration that
  // every file below it is already an exact candidate. Preserve specialized
  // answer/artifact selection inside that scope before the exact-file seeded
  // branch below.
  if ((!(args.paths?.length) || directoryScopesOnly) && initialProfile === "artifact_build") {
    const artifactArgs = singleDirectoryScope !== undefined
      ? scopedSpecializedArgs
      : { ...args, paths: undefined };
    const artifactPack = await buildArtifactTaskPack(artifactArgs, query, workspace);
    if (artifactPack !== undefined) return artifactPack;
  }
  if ((!(args.paths?.length) || directoryScopesOnly) && initialProfile === "answer") {
    const answerArgs = singleDirectoryScope !== undefined
      ? scopedSpecializedArgs
      : { ...args, paths: undefined };
    const answerPack = await buildAnswerTaskPack(answerArgs, query, workspace);
    if (answerPack !== undefined) return answerPack;
  }

  // -------------------------------------------------------------------------
  // A1: caller-supplied paths[] seeding. When the agent already knows the
  // exact files a task needs (e.g. replaying a prior locate, or following a
  // partial pack's own surfaces), seed those files as surfaces directly
  // instead of running the pathless locator, which returns cross-fixture and
  // host-repo noise when a query happens to text-match unrelated files.
  // Placed BEFORE the symptom-shaped diff routing and the pathless locate
  // call: an explicit paths[] is a stronger signal than either.
  // -------------------------------------------------------------------------
  if (args.paths && args.paths.length > 0) {
    return buildSeededTaskPack(args, query, workspace);
  }

  // 2026-10-17 (DESIGN-v0.14-plan §20.8): one named, existing workspace file
  // carrying an edit lead of its own is the request's target, with the same
  // standing as a caller's paths[] above (`explicitSingleEditRequestPath`).
  if (!args.path && !args.symbol && literalFirstRoutingEnabled() && !hasCreateOrPlacementIntent(query) && !asksBeyondOneNamedSite(query)) {
    const single = explicitSingleEditRequestPath(query);
    if (single !== undefined && isExistingWorkspaceFile(single, workspace)) {
      return buildSeededTaskPack({ ...args, paths: [{ path: single }], autoDiscoveredLocation: true }, query, workspace);
    }
  }

  // DESIGN-v0.9 §8 WS3: specialized profiles branch before generic locator
  // augmentation. artifact_build wins before answer/generic because an
  // implement-from-document query necessarily carries a positive edit marker.
  // A builder that cannot bind (notably: no discoverable artifact) falls
  // through to the generic pack, preserving the low-confidence contract.
  const profile = initialProfile;
  if (profile === "artifact_build") {
    const artifactPack = await buildArtifactTaskPack(args, query, workspace);
    if (artifactPack !== undefined) return artifactPack;
  }
  if (profile === "answer") {
    const answerPack = await buildAnswerTaskPack(args, query, workspace);
    if (answerPack !== undefined) return answerPack;
  }

  // -------------------------------------------------------------------------
  // A defect can already be committed. Use drift as the requested scope only
  // when the caller explicitly ties the defect to their working-tree changes.
  // Incidental setup files and runtime journals are never evidence of its cause.
  // -------------------------------------------------------------------------
  if (!args.path && !args.symbol && isSymptomShapedQuery(query) && requestsWorkingTreeInvestigation(query)) {
    const diffPack = await buildDiffTaskPack(query, workspace);
    if (diffPack) {
      // DESIGN-v0.8 coverage-honesty (Part 5): a symptom/bug query records its
      // advisory check line as a token-less record (never reported open by
      // closure tracking), so the diff flow still populates session checks.
      const diffRecords: PackCheckRecord[] = (diffPack.checks ?? []).map((desc) => ({ id: deriveCheckId({ desc }), desc }));
      const diffFinal = await dedupeTrimAndPersist(workspace, diffPack, { query, checkRecords: diffRecords, args });
      // V15-NBR/FUI (2026-09-29): symptom/bug-shaped queries route through
      // buildDiffTaskPack's drift surfaces — same default-OFF prototypes.
      attachPlanAids(diffFinal, workspace, query);
      return diffFinal;
    }
  }

  // Locate task surfaces using the existing multi-layer locator.
  const locateResult = await locateTaskContext(workspace, {
    action: "locate",
    query: locatingQuery,
    ...(args.path ? { path: args.path } : {}),
    ...(args.symbol ? { symbol: args.symbol } : {}),
    ...(args.lang ? { lang: args.lang } : {}),
    limit: Math.min(args.limit ?? MAX_SURFACES_DISTINCT, MAX_SURFACES_DISTINCT),
  });

  const rootSuggestion = locateResult.rootSuggestion;
  let rootSuggestionCwd: string | undefined;
  if (rootSuggestion !== undefined) {
    const candidate = safeResolve(rootSuggestion, workspace);
    if (candidate !== undefined) {
      try {
        const real = fs.realpathSync(candidate);
        if (isWithin(real, resolveReal(workspace)) && fs.statSync(real).isDirectory()) {
          rootSuggestionCwd = real;
        }
      } catch {
        // The suggested project moved after locator enumeration. Fall through
        // to the ordinary locate result instead of emitting a stale cwd.
      }
    }
  }
  // A marker root is an executable workspace transition. A manifest-less
  // common directory is only a ranking hint: keep the locator's useful
  // surfaces in this call instead of discarding them for a premature re-scope.
  const rootSuggestionIsMarkerRoot = rootSuggestion !== undefined
    && projectRootOf(rootSuggestion, workspace) === rootSuggestion;
  if (rootSuggestionCwd !== undefined && rootSuggestionIsMarkerRoot) {
    const requiredRoles = requiredSurfacesForTask(locatingQuery, workspace, args.surfaceRoles);
    const suggestedMissing = locateResult.hit
      ? locateResult.missingSurfaces
      : locateResult.missing;
    const missingRoles = suggestedMissing ?? args.surfaceRoles ?? ["contract", "api"];
    const noSurfaceMissing = mergeUnique(missingRoles.map(String), requiredRoles);
    const { lines: checkLines, records: checkRecords } = buildCompletionChecks(
      locatingQuery,
      [],
      noSurfaceMissing,
      workspace,
    );
    const base: TaskPackResult = {
      mode: "task_pack",
      coverage: "partial",
      coverage_reason: "missing-roles",
      surfaces: [],
      missing: noSurfaceMissing,
      required_surfaces: requiredRoles,
      missing_required_surfaces: requiredRoles,
      route: {
        action: "locate_missing_surfaces",
        reason: `strong query tokens matched only outside the current scope; re-scope to ${rootSuggestion}`,
        max_additional_tl_calls: 1,
      },
      checks: checkLines,
      verify: discoverVerificationHints(workspace, locatingQuery, []),
      next: {
        tool: "tl_read_file",
        arguments: {
          query: continuationQuery(query),
          task: { epoch: "new" },
          cwd: rootSuggestionCwd,
        },
      },
    };
    return dedupeTrimAndPersist(workspace, base, { query, checkRecords, args });
  }

  if (!locateResult.hit) {
    const requiredRoles = requiredSurfacesForTask(locatingQuery, workspace, args.surfaceRoles);
    // M3: a pathless request can leave the locator with only weak
    // candidates even when its query uniquely names one project subtree. The
    // resolver's inference is deliberately conservative (undefined unless it
    // has one high-confidence root); when it does bind, re-enter the existing
    // seeded path exactly once so the normal readiness/coverage machinery owns
    // the result. This does NOT promote the legacy partial pack to complete.
    const inferredScope = !args.path
      && !args.symbol
      && !(args.paths?.length)
      ? inferQueryProjectScope(workspace, locatingQuery)
      : undefined;
    if (inferredScope !== undefined) {
      const retried = await buildSeededTaskPack(
        { ...args, paths: [{ path: inferredScope }], autoDiscoveredLocation: true },
        query,
        workspace,
      );
      // A directory-scoped retry that still cannot surface any evidence is an
      // abstain, not a license to hide the original locator's honest partial
      // candidate list. Fall through to that legacy path unchanged.
      if (retried.surfaces.length > 0) {
        const result: TaskPackResult = {
          ...retried,
          scope_inferred: { path: inferredScope, reason: "pathless-locator-abstain" },
        };
        // The seeded builder cached its internal paths[] call. Rebind the
        // cache to the caller's original pathless request, exactly as the
        // existing propagation/identity seeded paths do.
        captureServedPack(workspace, args, computePackFingerprint(args, workspace), result);
        return result;
      }
    }

    // Check if the abstain response has candidate details we can use.
    const details = locateResult.candidateDetails;
    if (details && details.length > 0) {
      // Build partial surfaces from candidate details using surface grouping.
      return buildPartialPack(details, args, query, workspace);
    }
    // turn-economy wave 3 (V1, requirement b): the locator abstained WITHOUT rich
    // candidateDetails but still ranked weak top candidates it could not
    // confidently pick. Rather than hand back a bare pointer that costs the caller
    // a whole extra turn to fetch those files (the very anti-pattern this wave
    // closes), SEED them as real surfaces so their code ships NOW and the caller
    // can judge them. Skipped when (a) the evidence was OUT-OF-ROOT — the
    // re-scope `next` below is the right guidance, not in-scope noise — or (b) the
    // query is a create/placement request, whose answer is the create ROUTE that
    // the bare envelope resolves downstream in dedupeTrimAndPersist (seeding
    // unrelated files would bury it under noise surfaces).
    if (!hasCreateOrPlacementIntent(locatingQuery)) {
      const weakPaths: string[] = [];
      const seenWeak = new Set<string>();
      for (const cand of locateResult.candidates ?? []) {
        if (seenWeak.has(cand.path)) continue;
        seenWeak.add(cand.path);
        const abs = safeResolve(cand.path, workspace);
        if (abs !== undefined && fs.existsSync(abs)) weakPaths.push(cand.path);
      }
      if (weakPaths.length > 0) {
        return buildSeededTaskPack({ ...args, paths: weakPaths.map((p) => ({ path: p })), autoDiscoveredLocation: true }, query, workspace);
      }
    }

    // P1 generic-text lane: only the final, truly empty semantic state may
    // widen to unknown-extension / extensionless UTF-8 files. A hit is seeded
    // immediately so this same call serves content plus an edit-grade handle;
    // supported semantic hits above never pay for or observe this fallback.
    const genericFallback = discoverGenericTaskPackFallback(args, locatingQuery, workspace);
    if (genericFallback.paths.length > 0) {
      return buildSeededTaskPack(
        { ...args, paths: genericFallback.paths.map((p) => ({ path: p })), autoDiscoveredLocation: true },
        query,
        workspace,
      );
    }

    // No candidate details — return empty pack with redirect. route.action
    // is always locate_missing_surfaces here (no surfaces), so
    // blocking_next_steps is dropped (item 3) in favor of the single `next`
    // hint below (item 4).
    const missingRoles = locateResult.missing ?? args.surfaceRoles ?? ["contract", "api"];
    const noSurfaceMissing = mergeUnique(missingRoles.map(String), requiredRoles);
    const { lines: checkLines, records: checkRecords } = buildCompletionChecks(locatingQuery, [], noSurfaceMissing, workspace);
    // General root model (DESIGN-v0.8 §A5): if the locator determined the
    // query's strong identifiers only matched OUT-OF-ROOT candidates, the
    // caller is almost certainly scoped to the wrong subtree — tell them to
    // re-scope (cwd or paths) at that project root instead of re-running the
    // same pathless locate, which would just return the same junk.
    const fallbackQuery = (genericFallback.probe ?? query).replace(/\"/g, "").slice(0, 80);
    const next: ContinuationCall | undefined = genericFallback.attempted
      ? { tool: "tl_search_files", arguments: { action: "find", query: fallbackQuery } }
      : { tool: "tl_search_files", arguments: { action: "locate", query: continuationQuery(query) } };
    const base: TaskPackResult = {
      mode: "task_pack",
      coverage: "partial",
      // DESIGN-v0.8 coverage-honesty: an abstain with no usable candidate
      // details left every required role uncovered — name it "missing-roles".
      coverage_reason: "missing-roles",
      surfaces: [],
      missing: noSurfaceMissing,
      required_surfaces: requiredRoles,
      missing_required_surfaces: requiredRoles,
      route: buildRoute([], requiredRoles, "partial", noSurfaceMissing, locatingQuery, "missing-roles"),
      checks: checkLines,
      verify: discoverVerificationHints(workspace, locatingQuery, []),
      ...(next !== undefined ? { next } : {}),
    };
    return dedupeTrimAndPersist(workspace, base, { query, checkRecords, args });
  }

  // Build surfaces from primary + related candidates using surface grouping.
  const rawCandidates: ImpactCandidate[] = [
    ...locateResult.primary,
    ...locateResult.related,
  ];
  // Efficiency: one per-pack read/parse memo shared by every file-touching
  // step below, so each file is read once and parsed at most once per pack.
  const cache = new FileReadCache();
  // Item 9: for enum/value-addition tasks, boost definition sites and
  // demote pure-derivation sites (e.g. z.enum(Object.values(X))) before
  // role-diversity selection runs, so the exhaustive-initializer
  // definition wins over an auto-deriving consumer that needs no edit.
  const allCandidates = preferDefinitionSites(workspace, locatingQuery, rawCandidates, cache);

  const selectedCandidates = selectClosureCandidates(
    allCandidates,
    locateResult.primary.map((c) => c.path),
  );
  // A4 "stop reporting partial-by-budget": candidates dropped here were
  // FOUND, just trimmed for exceeding MAX_SURFACES_DISTINCT — that is not a
  // missing-required-role situation, so their PATHS go under the
  // non-alarming `trimmed` key, not into `missing` (which previously
  // branded a pack "partial" merely for having more candidates than the
  // surface budget, independent of whether anything required was absent).
  const trimmedPaths = allCandidates
    .map((c) => c.path)
    .filter((_p, idx) => !selectedCandidates.some((sc) => sc.path === allCandidates[idx]?.path));

  // Build surface objects.
  const surfaces: TaskPackSurface[] = [];
  // DESIGN-v0.8 coverage-honesty: scope the ui/style requirement to the
  // located candidates' own dominant root (whole located pool, the strongest
  // root signal we have), not the whole workspace.
  const requiredRoles = requiredSurfacesForTask(
    locatingQuery, workspace, args.surfaceRoles, allCandidates.map((c) => c.path),
  );

  // 2026-10-29 (first-hop field report): a generic first pack that names a declaration the
  // workspace defines in one implementation file (`res.send`, `req.protocol`, `click.prompt`)
  // leads with that declaration's body. Only the surfaces built from the SELECTION change; the
  // locator's verdict, `anchorPaths` and `trimmedPaths` below stay what the locator made them.
  const { candidates: surfaceCandidates, declaration: namedDeclaration } =
    await withNamedDeclarationLead(selectedCandidates, args, query, workspace, cache, profile);
  const builtSurfaces = await Promise.all(
    surfaceCandidates.map((candidate) => candidateToSurface(candidate, workspace, requiredRoles, locatingQuery, cache)),
  );
  // The lead is context, not a write frontier: the role-derived `required` candidateToSurface
  // gives any surface of a required role is not claimed for it (the locator's own pack decides).
  surfaceCandidates.forEach((candidate, index) => {
    if (candidate.why === REQUEST_ANCHOR_DEFINITION_WHY && candidate.required !== true) delete builtSurfaces[index]!.required;
  });
  surfaces.push(...builtSurfaces);
  const protectedSurfaces = new Set<TaskPackSurface>();
  await augmentConcernGroupSurfaces(surfaces, locatingQuery, workspace, requiredRoles, cache, protectedSurfaces);
  await augmentNativeSurfaceClosure(surfaces, workspace, locatingQuery, requiredRoles, cache);
  await augmentNativeWiringSurface(surfaces, workspace, cache);
  await augmentNativeIdentifierCooccurrenceSurface(surfaces, workspace, locatingQuery, requiredRoles, cache);
  // Item 1: resolve a REQUIRED "style" role to a NAMED surface (handle + code)
  // instead of leaving it a bare `missing:["style"]` the agent has to guess at.
  // B1a (2026-08-01 retrieval-scope): the role/style search anchors on the
  // LOCATED cluster, not on the running `surfaces` array — otherwise an earlier
  // augmenter's own pick widens the scope for every augmenter after it.
  const anchorPaths = selectedCandidates.map((c) => c.path);
  await augmentStyleSurface(surfaces, locatingQuery, workspace, requiredRoles, cache, anchorPaths);
  // FIX-B2: attempt every OTHER still-missing required role in this SAME
  // call — see the function's own doc comment for the surfaceRoles-retry
  // root cause this closes.
  await augmentMissingRequiredRoleSurfaces(surfaces, locatingQuery, workspace, requiredRoles, cache, undefined, anchorPaths);
  // B1c (2026-08-01 retrieval-scope): a file the QUERY names by name is a
  // stated requirement, not a candidate to be ranked — serve it content-bearing.
  await augmentQueryNamedFileSurfaces(surfaces, locatingQuery, workspace, requiredRoles, cache, protectedSurfaces);
  // DESIGN-v0.8 coverage-honesty (Part 5 B-1): promote a config/data/doc
  // surface whose already-read content already names the enum's new value.
  promoteVariantSurfaces(surfaces, locatingQuery, workspace, cache);
  // Edit context (2026-10-16 bench): the located edit target's dependencies.
  if (profile !== "answer") await augmentEditContextSurfaces(surfaces, locatingQuery, workspace, requiredRoles, cache, profile === "generic");
  finalizePrimarySurface(surfaces);

  const missingRequired = requiredRoles.filter((role) => !surfaces.some((s) => s.role === role));
  // `missing` now reports ONLY genuinely-missing required roles — budget
  // trims are reported separately under `trimmed` (see above).
  const allMissing = mergeUnique(missingRequired, []);

  // FIX-A: a broader "known identifier" pool for the concern gate's OR-clause
  // ("matches an identifier that actually exists in the repo index/symbol
  // map") — the pre-trim located candidates (path basenames + symbols), which
  // is strictly BIGGER than the final selected `surfaces` (some candidates
  // were dropped by the surface budget/role-diversity selection, but they
  // were still real files the locator found for this query).
  const knownIdentifiers = new Set<string>(
    allCandidates.flatMap((c) => {
      const base = path.basename(c.path).replace(/\.[^.]+$/, "").toLowerCase();
      return c.symbol ? [base, c.symbol.toLowerCase()] : [base];
    }),
  );

  // DESIGN-v0.8 coverage-honesty: compute the unmatched-concern token list
  // ONCE and reuse it for the coverage label, the route flip, and the
  // per-token blocking_next_steps — so all three agree by construction.
  const unmatchedConcern = unmatchedConcernTokens(locatingQuery, surfaces, knownIdentifiers);

  // DESIGN-v0.8 coverage-honesty: three-way coverage + telemetry reason,
  // replacing the old binary complete|partial mapping.
  // Issue #3 dominance tie-break: computed once, reused below (after `result`
  // exists) to serve the winner's body — see `applyDominancePromotion`.
  const dominantSurfaceIndex = resolveDominantSurfaceIndex(surfaces);
  const derivedCoverage = deriveCoverage(
    {
      completeness: locateResult.completeness,
      confidence: locateResult.confidence,
      primaryCount: locateResult.primary.length,
      ...(locateResult.missingSurfaces ? { missingSurfaces: locateResult.missingSurfaces } : {}),
    },
    missingRequired,
    unmatchedConcern,
    dominantSurfaceIndex,
  );
  // A locator HIT whose ONE primary defines the callable the request names
  // (`(Sum)`, `meter.Sum`), which no other workspace file defines, is the
  // request's target rather than a one-entry candidate list (deriveCoverage
  // rule 6's residual; the answer route settles a uniquely named FILE the same
  // way, TL-REVIEW-3). Gauge fixture, 2026-10-17: 「gauge の集計 (Sum) …修正して」
  // located meter/sum.go alone at the filename-match 0.625 and still asked
  // the caller to name it. Only for a request that asks for the change: a
  // bare name ("parseConfig function") stays a candidate to confirm, and an
  // implement-from-document request whose document was not found keeps its
  // low-confidence fall-through (artifact_build, WS3).
  //
  // When OTHER files define that callable too (`meter.Sum` and `stats.Sum`,
  // neither qualified), the choice is between them: each is served as a
  // candidate beside the located one, and the located one's edit context is
  // dropped until the caller has chosen (gauge fixture, 2026-10-17: the
  // await_input listed the located file alone, "1 candidate target(s)").
  const namedDefinitions = derivedCoverage.reason === "candidate-list"
    && profile !== "artifact_build"
    && locateResult.hit
    && locateResult.primary.length === 1
    && surfaces[0] !== undefined
    && surfaces[0].path === locateResult.primary[0]!.path
    && hasServedCode(surfaces[0])
    ? await namedCallableDefinitions(locatingQuery, workspace, surfaces[0].path, cache)
    : undefined;
  const definedSinglePrimary = namedDefinitions !== undefined
    && namedDefinitions.complete
    && namedDefinitions.paths.length === 1
    && requestAsksForChange(locatingQuery);
  if (namedDefinitions !== undefined && namedDefinitions.paths.length > 1) {
    await addSameNameDefinitionCandidates(surfaces, namedDefinitions, workspace, requiredRoles, locatingQuery, cache);
  }
  const { coverage: coverageStr, reason: coverageReason, dominancePromoted } = definedSinglePrimary
    ? { coverage: "focused" as const, reason: "single-site" as const, dominancePromoted: undefined }
    : derivedCoverage;

  const route = buildRoute(surfaces, missingRequired, coverageStr, allMissing, locatingQuery, coverageReason);

  // DESIGN-v0.8 coverage-honesty (Part 3): the single best `next` for this
  // coverage state (batch read of code-less handles, direct edit, targeted
  // re-locate, or a scoped find) — no longer always a bare single slice.
  const nextHint = nextHintForCoverage(
    surfaces, coverageStr, coverageReason, locatingQuery, missingRequired, unmatchedConcern,
  );

  // Only populate blocking_next_steps when there is actual per-token content
  // — the route can also flip to locate_missing_surfaces via missingRequired
  // alone (unmatchedConcernTokens then empty), which must not serialize a
  // vacuous empty array.
  const blockingNextSteps = route.action === "locate_missing_surfaces"
    ? buildBlockingNextSteps(locatingQuery, surfaces)
    : [];

  const { lines: checkLines, records: checkRecords } = buildCompletionChecks(locatingQuery, surfaces, allMissing, workspace, unmatchedConcern);
  const result: TaskPackResult = {
    mode: "task_pack",
    coverage: coverageStr,
    ...(coverageReason ? { coverage_reason: coverageReason } : {}),
    surfaces,
    missing: allMissing,
    ...(trimmedPaths.length > 0 ? { trimmed: trimmedPaths } : {}),
    required_surfaces: requiredRoles,
    ...(missingRequired.length > 0 ? { missing_required_surfaces: missingRequired } : {}),
    route,
    ...(blockingNextSteps.length > 0 ? { blocking_next_steps: blockingNextSteps } : {}),
    checks: checkLines,
    verify: discoverVerificationHints(workspace, locatingQuery, surfaces),
    ...(nextHint ? { next: nextHint } : {}),
  };
  if (dominancePromoted) applyDominancePromotion(result, surfaces, dominantSurfaceIndex, workspace);

  attachPartialTree(result, workspace);
  const evidenceExpansion = await importEvidenceExpansion(workspace, locateResult.primary, locatingQuery, surfaces);
  const finalResult = await dedupeTrimAndPersist(workspace, result, {
    ...(protectedSurfaces.size > 0 ? { protectedSurfaces } : {}),
    query,
    checkRecords,
    args,
    // DESIGN-v0.9 §4.3: recompute next/route if trimToCap flips coverage.
    recompute: { query, missingRequired, unmatchedConcern },
    // DESIGN-v0.9 §4.6b: share the pack's read cache for codeless-surface inlining.
    cache,
    evidenceExpansion,
  });
  // V15-NBR/FUI (2026-09-29): buildTaskPackCore's own inline "report the
  // locator's findings" tail — reached whenever the query does not match a
  // more specific redirect (create-target/propagation/multi-concern/
  // artifact/explicit-answer/seeded-paths), which makes this the highest-
  // traffic generic-profile path. Same default-OFF prototypes as the other
  // hook sites; see frontierNeighbours.ts/usageInventory.ts's doc comments.
  attachPlanAids(finalResult, workspace, query);
  moveNamedDeclarationFirst(finalResult, namedDeclaration);
  return finalResult;
}
