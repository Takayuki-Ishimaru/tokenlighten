// seededPackBuilder — extracted implementation; imports point to the owning modules.
import * as path from "path";
import type { AnchorFocusCandidate } from "./anchorFocus.js";
import type { AnchorFocusResult } from "./anchorFocus.js";
import type { ContinuationCall } from "./packBasics.js";
import type { DiscoveredArtifactFile } from "./packBasics2.js";
import type { DiversifyCandidate } from "../concernRecovery.js";
import type { ExplicitIdentifierAbsence } from "./identifierAbsence2.js";
import type { ImpactCandidate } from "@tokenlighten/types";
import type { ImpactSurface } from "@tokenlighten/types";
import type { MintedArtifactSurface } from "./packBasics2.js";
import type { SameNameSubject } from "./sameNameSubjects.js";
import type { SeededCoverageSurface } from "../concernRecovery.js";
import type { TaskPackArgs } from "../model.js";
import type { TaskPackPathEntry } from "../model.js";
import type { TaskPackResult } from "../model.js";
import type { TaskPackSurface } from "../model.js";
import { ANCHOR_FOCUS_EXPLICIT_IDENTIFIER_WEIGHT } from "./seededPackBuilder2.js";
import { ARTIFACT_EXT_SET } from "./packBasics2.js";
import { EXECUTED_SEARCH_LOCATED_WHY } from "./seedAdmission.js";
import { EXECUTED_SEARCH_UNCLASSIFIED_WHY } from "./seedAdmission.js";
import { FileReadCache } from "./packBasics2.js";
import { MAX_COMPLETION_CHECKS } from "./createAndWiringEndpoints2.js";
import { MAX_EDIT_CONTEXT_CALLER_TARGETS } from "./focalFlow.js";
import { MAX_NAMED_DIR_SURFACES } from "./seedResolution.js";
import { MAX_NAMED_DIR_SURFACES_TOTAL } from "./seedResolution.js";
import { MAX_SEEDED_CODE_SURFACES } from "./artifactPackBuilder3.js";
import { MAX_SEEDED_CODE_SURFACES_FAIR } from "./artifactPackBuilder3.js";
import { MAX_SURFACES_DISTINCT } from "./packBasics2.js";
import { MAX_SURFACE_CODE_BYTES } from "./packBasics2.js";
import { MAX_TASK_PACK_BYTES } from "./packBasics.js";
import { MAX_TASK_PACK_BYTES_MULTI_CONCERN } from "./packBasics.js";
import { NAMED_DIR_LOCATE_BUDGET_MS } from "./seedResolution.js";
import { NAMED_DIR_PURPOSE_CLAUSE_PREFIX } from "./seedResolution.js";
import { SEEDED_ANSWER_ENVELOPE_RESERVE } from "./packBasics2.js";
import { SEEDED_ANSWER_SURFACE_CODE_BYTES } from "./packBasics2.js";
import { SEEDED_GENEROUS_PACK_BYTES } from "./packBasics2.js";
import { SEEDED_GENEROUS_PACK_MIN_FILES } from "./packBasics2.js";
import { accountForListedScopeItems } from "./seedResolution4.js";
import { activePackByteCeiling } from "./packBasics2.js";
import { anchorFocusForLocatorCandidate } from "./anchorFocus4.js";
import { anchorWindowStartLine } from "./anchorFocus3.js";
import { artifactBuildRelevance } from "./artifactPackBuilder.js";
import { asImpactSurface } from "./wiringEvidence2.js";
import { attachAnchorFocusAffordance } from "./anchorFocus4.js";
import { attachArtifactBuildSections } from "./artifactPackBuilder2.js";
import { attachPartialTree } from "./surfaceMaterialization.js";
import { attachPlanAids } from "./packTrimming2.js";
import { augmentConcernGroupSurfaces } from "./coverageAndContinuation.js";
import { augmentEditContextSurfaces } from "./focalFlow2.js";
import { augmentMissingRequiredRoleSurfaces } from "./queryIntent.js";
import { augmentNativeIdentifierCooccurrenceSurface } from "./queryIntent.js";
import { augmentNativeSurfaceClosure } from "./queryIntent.js";
import { augmentNativeWiringSurface } from "./queryIntent.js";
import { augmentStyleSurface } from "./queryIntent.js";
import { auxiliaryEnumPool } from "../auxiliaryEnumContextIntegration.js";
import { bindTaskProfile } from "./coverageAndContinuation4.js";
import { boundedClauseRecoveryWork } from "./requestItemAbsence2.js";
import { buildCompletionChecks } from "./contractReconciliation.js";
import { buildCreateTargetNote } from "./queryIntent4.js";
import { buildRoute } from "./coverageAndContinuation4.js";
import { candidateToSurface } from "./surfaceMaterialization.js";
import { carryAuxiliaryEnumPool } from "../auxiliaryEnumContextIntegration.js";
import { classifySurface } from "../../../util/impact.js";
import { clauseCoverageTokenSet } from "../concernRecovery.js";
import { collectNeighbourWords } from "../concernRecovery.js";
import { commonAncestorDir } from "./seedResolution.js";
import { concernRecoveryEnabled } from "../../../util/flags.js";
import { containsJapanese } from "../../retrieval/jaQueryBridge.js";
import { countLines } from "../../../util/countLines.js";
import { currentRequestSignal } from "../../../util/requestCancellation.js";
import { dedupeTrimAndPersist } from "./packSettlement.js";
import { definitionVsDerivedAdjustment } from "./partialPackBuilder.js";
import { delimitedExplicitCodeIdentifiers } from "./anchorFocus3.js";
import { discoverArtifactFiles } from "../../locator/locateTaskContext.js";
import { discoverVerificationHints } from "./surfaceMaterialization.js";
import { explicitCodeIdentifiers } from "./anchorFocus2.js";
import { explicitFacetSelectionRange } from "./callableResolution4.js";
import { explicitIdentifierAbsences } from "./identifierAbsence2.js";
import { extractFacetRequirements } from "./packBasics2.js";
import { extractRequestItems } from "./packBasics2.js";
import { extractSymbolsFromFile } from "../../../tools/readCodeModes.js";
import { facetPlanFor } from "../facetGate.js";
import { facetPlanWorkspaceKey } from "./facetClosure.js";
import { finalizePrimarySurface } from "./createAndWiringEndpoints2.js";
import { getSession } from "../../../state/session.js";
import { hygienicClauseWorkList } from "../concernRecovery.js";
import { identifierNamesSymbol } from "./anchorFocus3.js";
import { isAgentGuideElidePath } from "./guideAndArtifactSurfaces.js";
import { isClauseCoveredBySeededSurfaces } from "../concernRecovery.js";
import { isDirectoryWithin } from "./seedResolution.js";
import { isExplicitRangeSurface } from "../sfWithholdingMarks.js";
import { isImplementationPath } from "./changeAndReadinessEvidence2.js";
import { isMultiSurfaceQuery } from "./partialPackBuilder.js";
import { isNonImplementationAnswerCandidate } from "./answerCandidates.js";
import { isTestConcernPath } from "./literalAndConcernSeeds.js";
import { isUnderAncestor } from "./seedResolution.js";
import { isWiringIdentifierShape } from "./createAndWiringEndpoints2.js";
import { jaBridgeExpansionTokens } from "../../retrieval/queryRecoveryTerms.js";
import { jaBridgeRecoveryQuery } from "../../retrieval/queryRecoveryTerms.js";
import { locateTaskContext } from "../../locator/locateTaskContext.js";
import { markSeededGenerousPack } from "./surfaceMaterialization2.js";
import { mergeUnique } from "./roleAndConcernScope.js";
import { mintArtifactSurface } from "./packBasics2.js";
import { moduleShapedQueryTokens } from "./queryIntent4.js";
import { multiWindowAnchorFocus } from "./anchorFocus4.js";
import { namedDirClauseLocate } from "./seedResolution.js";
import { namedDirClauseWorkList } from "./seedResolution.js";
import { namedTargetResolutionEnabled } from "../../../util/flags.js";
import { nextHintForCoverage } from "./coverageAndContinuation.js";
import { normIdent } from "./createAndWiringEndpoints2.js";
import { normalizePathEntry } from "./packBasics2.js";
import { noteUnreadableNamedPath } from "./queryIntent3.js";
import { packFairTrimEnabled } from "../../../util/flags.js";
import { packGuideElideEnabled } from "../../../util/flags.js";
import { parseSurfaceSpan } from "./packState2.js";
import { partitionAnchorWindowRemainders } from "./anchorFocus4.js";
import { promoteVariantSurfaces } from "./queryIntent.js";
import { proofCompletionEnabled } from "../../../util/flags.js";
import { queryIdentifierContext } from "./anchorFocus3.js";
import { rankAbstainCandidates } from "./roleAndConcernScope3.js";
import { readCached } from "./packBasics2.js";
import { readServedTextSafe } from "../../../util/safePath.js";
import { recordClauseLocateAttempt } from "../concernRecovery.js";
import { recordIdentifierAbsences } from "./identifierAbsence2.js";
import { recordSameNameSubjects } from "./sameNameSubjects.js";
import { recordSeededClauseRecoveryEntry } from "../concernRecovery.js";
import { recordVerifiedAbsentIdentifiers } from "./identifierAbsence.js";
import { recoverFacetClosureCandidates } from "./facetClosure.js";
import { requiredSurfacesForTask } from "./roleAndConcernScope.js";
import { resolveGuessedSeedPaths } from "./seedResolution.js";
import { resolvedSeedHonorsSlice } from "./seedResolution.js";
import { restoreAuxiliaryEnumPool } from "../auxiliaryEnumContextIntegration.js";
import { resultAbsenceUniverse } from "./identifierAbsence2.js";
import { runClauseLocateRecovery } from "../concernRecovery.js";
import { sameNameSubjectsByCache } from "./sameNameSubjects.js";
import { scanLiteral } from "../../search/find/findText.js";
import { seededGenerousEnabled } from "../../../util/flags.js";
import { seededSameNameSubjects } from "./sameNameSubjects.js";
import { selectAnchorFocus } from "./anchorFocus3.js";
import { shaOfText } from "../../../util/handles.js";
import { surfaceGroundedInQuery } from "./roleAndConcernScope3.js";
import { tokenizeQuery as tokenizeQueryForDiversification } from "../../retrieval/tokenize.js";
import { uniqueExplicitIdentityCandidate } from "./partialPackBuilder.js";
import { unmatchedConcernTokens } from "./roleAndConcernScope3.js";
import { vocabularyStemNeighbours } from "../../retrieval/queryRecoveryTerms.js";
import { walkCodeFiles } from "../../../tools/walkRepo.js";
import { wholeFileEmbedBytes } from "./packBasics2.js";
import { wholeIdentifierOnHitLine } from "./identifierAbsence2.js";
import { whyWithQualifier } from "./seedResolution.js";

export async function buildSeededTaskPack(
  args: TaskPackArgs,
  query: string,
  workspace: string,
): Promise<TaskPackResult> {
  const selectedProfile = bindTaskProfile(args.taskProfile, query, args.writeAllowed).selected;
  const answerProfile = selectedProfile === "answer";
  // FIX-B3: normalize every entry to the canonical {path,...} shape ONCE —
  // downstream code (SeedInfo.entry, toRead, seeds, prioritized) can then
  // keep dereferencing `.path`/`.range`/`.symbol`/`.purpose` exactly as
  // before, regardless of whether the caller supplied bare strings, objects,
  // or a mix of both.
  const entries = args.paths!.map(normalizePathEntry);
  // R1-B2: paths this build promoted out of the executed-search ledger — see
  // `TaskPackArgs.executedSearchLocated` and the `why` stamp in the seed loop.
  const executedSearchLocatedPaths = new Set(args.executedSearchLocated ?? []);
  // SHOULD-FIX 28 (2026-09-14, review round 4): same provenance, weaker claim —
  // see `EXECUTED_SEARCH_UNCLASSIFIED_WHY`.
  const executedSearchUnclassifiedPaths = new Set(args.executedSearchLocatedUnclassified ?? []);
  // DESIGN-v0.8 coverage-honesty: the caller-supplied paths ARE the located
  // set, so scope the ui/style requirement to their dominant root.
  // An explicit answer profile is evidence retrieval, not change planning.
  // Do not infer edit-only api/test/style obligations from explanatory prose.
  const requiredRoles = answerProfile
    ? []
    : requiredSurfacesForTask(
        query, workspace, args.surfaceRoles, entries.map((e) => e.path).filter((p) => p.length > 0),
      );
  // Efficiency: one per-pack read/parse memo, seeded below with the seed
  // reads so downstream slice/widen calls never re-read the same file.
  const cache = new FileReadCache();
  const auxiliarySeed = auxiliaryEnumPool(args) ?? restoreAuxiliaryEnumPool(
    getSession(workspace).activeTaskQuery, workspace, query, args.taskBinding, args.taskQueryRefReplay === true,
  );
  if (auxiliarySeed !== undefined) carryAuxiliaryEnumPool(cache, auxiliarySeed);

  // 1. Read every supplied path. Missing/outside-workspace entries are
  //    recorded in `missing` and never fabricated as a surface.
  // Efficiency: the reads run in PARALLEL (Promise.all) rather than awaited
  // one at a time — a paths[] of N files no longer serializes N disk reads.
  // De-dupe and the P4 malformed-entry guard run first (order-preserving),
  // then the survivors are read concurrently.
  type SeedInfo = { entry: TaskPackPathEntry; content: string; role: ImpactSurface };
  const missing: string[] = [];
  // Caller-supplied directories that produced no surface at all. Tracked apart
  // from `missing` because a PATH gap and a ROLE gap need different follow-ups:
  // only a re-seed scoped to the directory can close this one (see the
  // unexpandedDirNext hint below).
  const unresolvedDirs: string[] = [];
  const unresolvedFileParents: string[] = [];
  const seededArtifacts: MintedArtifactSurface[] = [];
  const seenPaths = new Set<string>();
  const seenEntries = new Set<string>();
  const toRead: TaskPackPathEntry[] = [];
  for (const entry of entries) {
    const relPath = entry.path;
    // P4: a malformed paths[] entry (missing/empty path) must SURFACE in
    // `missing` so the caller sees the entry was dropped — silently
    // `continue`ing left the agent believing a supplied path was honored.
    //
    // FX-M1/E1: an entry that named a `handle` (normalizePathEntry's own
    // unresolved-handle marker, threaded through with `path:""`) is reported
    // by that handle, never by the internal "paths[] entry" wire-dialect
    // name — the caller sent a canonical `targets:[{handle}]` batch, not a
    // legacy `paths[]` one, and naming OUR internal projection back to them
    // would both mean nothing to them and leak legacy vocabulary onto the
    // wire (AGENTS.md: "never emit legacy input").
    if (relPath.length === 0) {
      const unresolvedHandle = typeof (entry as unknown as Record<string, unknown>)["handle"] === "string"
        ? (entry as unknown as Record<string, unknown>)["handle"] as string
        : undefined;
      missing.push(unresolvedHandle !== undefined
        ? `handle:${unresolvedHandle} did not resolve to a servable path in this workspace`
        : "(invalid paths[] entry: missing path)");
      continue;
    }
    // Distinct symbols/ranges in one file are distinct caller requirements.
    // De-duping only by path silently discarded every entry after the first
    // and could certify a pack without serving the requested implementation
    // functions. Read the file once below, but preserve each distinct slice.
    const entryKey = [relPath, entry.range ?? "", entry.symbol ?? ""].join("\u0000");
    if (seenEntries.has(entryKey)) continue;
    seenEntries.add(entryKey);
    seenPaths.add(relPath);
    if (ARTIFACT_EXT_SET.has(path.extname(relPath).toLowerCase())) {
      if (seededArtifacts.some((item) => item.surface.path === relPath)) continue;
      const found = discoverArtifactFiles(workspace, { path: relPath, includeAll: true });
      const exact = found.find((file) => file.relPath === relPath);
      const minted = exact ? mintArtifactSurface(exact, workspace, args) : undefined;
      if (minted) seededArtifacts.push(minted);
      else missing.push(relPath);
      continue;
    }
    toRead.push(entry);
  }
  // WP-S8 (TL_NAMED_TARGET_RESOLUTION, 2026-09-20): a caller-named file path
  // that does not exist is re-pointed at the workspace's unique same-basename
  // file BEFORE the read below, so a resolved target is read, embedded,
  // budgeted and trimmed exactly as if the caller had spelled it -- see
  // `resolveGuessedSeedPaths`. Live GitHub Copilot sessions guess the FOLDER
  // routinely (`frontend/order.js` for `frontend/js/order.js`), and every
  // guess costs the model a whole recovery turn for a file this server could
  // already name. OFF (the default) the list below is untouched and every
  // such path falls through to `missing` exactly as before.
  const namedTargetResolution = namedTargetResolutionEnabled();
  const resolvedFromByPath = new Map<string, string>();
  if (namedTargetResolution) {
    resolveGuessedSeedPaths(toRead, workspace, seenPaths, resolvedFromByPath);
  }
  const uniqueReadPaths = [...new Set(toRead.map((entry) => entry.path))];
  // AA1 (2026-09-14, review round 10): `readServedTextSafe`, not `readFileSafe`
  // — the same confinement/size/FIFO guards, plus the ONE serve-side decode
  // verdict (see the comment on the loop below). `null` still means exactly
  // what `readFileSafe`'s `null` meant (outside the workspace, unreadable, a
  // directory, over the cap), so the directory-vs-missing branch below is
  // unchanged.
  const verdictByPath = new Map(await Promise.all(
    // served-bytes: readServedText
    uniqueReadPaths.map(async (relPath) => [relPath, await readServedTextSafe(relPath, workspace)] as const),
  ));
  const readResults = toRead.map((entry) => ({ entry, verdict: verdictByPath.get(entry.path) ?? null }));
  const seeds: SeedInfo[] = [];
  // Behavior 2: caller-supplied paths[] entries that resolve to a DIRECTORY
  // (readFileSafe null → in-workspace directory) are not surfaces themselves —
  // they are a confinement scope. Held here and resolved via a directory-
  // confined locate below (fill candidates), so a supplied dir stops being a
  // bare `missing` entry with an empty pack.
  const dirEntries: TaskPackPathEntry[] = [];
  // SHOULD-FIX 37 (2026-09-14, review round 7): this read used to go through
  // `readFileSafe`, the LENIENT decoder -- unlike `FileReadCache.read`'s own
  // decode, it never fails on undecodable content, so a NUL-riddled or
  // BOM-less-UTF-16 buffer used to reach `cache.seed`/`seeds.push` as mojibake,
  // unexamined. That is the "seeded-targets door" the review found certifying
  // `act.answer` over a literal NUL on the wire -- including on a re-pack that
  // runs the pack's OWN prescribed `next` (`qref` + `targets`) -- for a file
  // `augmentQueryNamedFileSurfaces` would have disclosed as unreadable, or
  // served nul-stripped, for the identical reason.
  //
  // AA1 (2026-09-14, review round 10): rounds 7-9 fixed that by importing a
  // SECOND predicate here (`classifyLenientText`), then gating it (BLOCKER 40),
  // then discovering the gate's own two blind spots (findings 50 and 51). This
  // door now asks the ONE question every other door asks -- `readServedText`
  // via `readServedTextSafe` -- so the doors agree BY CONSTRUCTION rather than
  // by two hand-aligned approximations of each other:
  //
  //   - `"undecodable"` is disclosed exactly like a query-named file this server
  //     cannot read (never seeded, never served): `noteUnreadableNamedPath`
  //     feeds `unreadable_named_paths`/`missing`/`coverage` via
  //     `discloseUnreadableNamedPaths`, the same choke point this builder's own
  //     `dedupeTrimAndPersist` call below already reaches. This now covers BOTH
  //     of round 9's escapes: a file whose NULs begin past byte 4096 (finding
  //     50 -- the old 4 KB probe said "decodable", the density rule says
  //     otherwise), and a buffer that is 63% U+FFFD because its bytes were
  //     never valid UTF-8 at all (finding 51 -- strict decode refuses it, and
  //     no ratio has to be guessed).
  //   - `"clean"` includes an ordinary UTF-8 file that happens to CONTAIN a
  //     literal U+FFFD character (round 8's BLOCKER 40 repro): strict decode
  //     accepts those bytes, so every door serves them unchanged.
  //   - `"stripped"` (a RARE incidental NUL) is seeded via `reseed` (not `seed`
  //     -- this loop is this `cache`'s first use, so both are equivalent today,
  //     but `reseed` states the intent: this content deliberately replaces what
  //     a naive read produced) with the NUL-stripped text, so every downstream
  //     step for that seed (line count, anchor-focus, `candidateToSurface`'s own
  //     `cache.read`, sha/handle minting) sees the same clean text; its `why`
  //     records the stripping below, the same way the augmentation's does.
  const nulStrippedSeedPaths = new Set<string>();
  for (const { entry, verdict } of readResults) {
    if (verdict === null) {
      if (isDirectoryWithin(entry.path, workspace)) {
        dirEntries.push(entry);
      } else {
        // WP-S8: a resolution whose target turns out unreadable is reported as
        // the path the CALLER wrote -- re-pointing it was this server's own
        // inference, so `missing` must never name a path they did not ask for.
        // Empty unless TL_NAMED_TARGET_RESOLUTION resolved something.
        const requestedPath = resolvedFromByPath.get(entry.path) ?? entry.path;
        missing.push(requestedPath);
        const parent = path.dirname(requestedPath);
        if (isDirectoryWithin(parent, workspace) && !unresolvedFileParents.includes(parent)) {
          unresolvedFileParents.push(parent);
        }
        resolvedFromByPath.delete(entry.path);
      }
      continue;
    }
    if (verdict.kind === "undecodable") {
      // WP-S8: same reasoning as the `null` branch above -- a resolved path is
      // not a path the request named, so it must not be disclosed through
      // `unreadable_named_paths`; the resolution simply does not hold.
      const undecodableNamedAs = resolvedFromByPath.get(entry.path);
      if (undecodableNamedAs !== undefined) {
        resolvedFromByPath.delete(entry.path);
        missing.push(undecodableNamedAs);
        continue;
      }
      // SHOULD-FIX 65 (AC1, round 12): a caller-supplied `targets[]` entry IS
      // named by the request.
      noteUnreadableNamedPath(workspace, entry.path, "request");
      continue;
    }
    // WP-S8: the caller's own range/symbol has to still mean something on the
    // file this server resolved their path to, or the resolution does not
    // hold and the named path is reported as today.
    const resolvedNamedAs = resolvedFromByPath.get(entry.path);
    if (resolvedNamedAs !== undefined && !(await resolvedSeedHonorsSlice(entry, verdict.text))) {
      resolvedFromByPath.delete(entry.path);
      seenPaths.delete(entry.path);
      missing.push(resolvedNamedAs);
      continue;
    }
    if (verdict.kind === "stripped") {
      nulStrippedSeedPaths.add(entry.path);
      cache.reseed(entry.path, verdict.text, verdict);
      seeds.push({ entry, content: verdict.text, role: classifySurface(entry.path, entry.symbol) });
      continue;
    }
    cache.seed(entry.path, verdict.text, verdict);
    seeds.push({ entry, content: verdict.text, role: classifySurface(entry.path, entry.symbol) });
  }

  // 2. Priority order for the embed budget: required-role seeds first (item
  //    3b — "required-role seeded surfaces embed first"), then the rest in
  //    supplied order. Both groups still get a surface either way; this only
  //    decides which ones get embedded `code` vs handle+skeleton-only.
  const requiredSet = new Set(requiredRoles);
  // EXPERIMENT (TL_PACK_GUIDE_ELIDE): an agent-guide file (AGENTS.md, ...)
  // is already in the model's instructions and its managed block is elided
  // before trimming, so it must not spend one of the embed slots that a
  // caller-named source file needs -- models routinely list it FIRST. OFF
  // keeps the legacy order byte-for-byte.
  const guideLast = packGuideElideEnabled();
  const prioritized = [...seeds].sort((a, b) => {
    if (guideLast) {
      const aGuide = isAgentGuideElidePath(a.entry.path) ? 1 : 0;
      const bGuide = isAgentGuideElidePath(b.entry.path) ? 1 : 0;
      if (aGuide !== bGuide) return aGuide - bGuide;
    }
    const aReq = requiredSet.has(a.role) ? 0 : 1;
    const bReq = requiredSet.has(b.role) ? 0 : 1;
    if (aReq !== bReq) return aReq - bReq;
    return seeds.indexOf(a) - seeds.indexOf(b); // stable: preserve supplied order within each group
  });

  // WP-S2 rules 1+2 (TL_SEEDED_GENEROUS): per-seed whole-file embed allowance.
  //
  // Today every seed is measured against MAX_SURFACE_CODE_BYTES on RAW bytes,
  // so a caller-NAMED file over that cap is re-pointed at ONE anchor symbol
  // (the loop below) even when the caller will obviously read all of it. On an
  // `answer` (read-only) profile the file is evidence, not an edit frontier:
  // serve it whole while it fits SEEDED_ANSWER_SURFACE_CODE_BYTES and the
  // pack budget allows, and let only the genuinely oversized ones fall to the
  // multi-window anchor focus (rule 3). Allocation is water-filling —
  // SMALLEST embedded size first — so one large file cannot starve the small
  // ones that would each have fitted on their own; the loser of the
  // water-filling keeps exactly today's MAX_SURFACE_CODE_BYTES allowance.
  // `generic` (change) packs keep that allowance for every seed: rule 1 (the
  // elided-size measure) still applies to them, rule 2 does not.
  const seededGenerous = seededGenerousEnabled();
  const wholeFileSeedAllowance = new Map<SeedInfo, number>();
  let seededGenerousBudgetTier = false;
  let seededGenerousTierBytes = MAX_TASK_PACK_BYTES_MULTI_CONCERN;
  let seededWindowBudget = MAX_SURFACE_CODE_BYTES;
  if (seededGenerous) {
    const namedWholeFileSeeds = prioritized.filter(
      (seed, idx) =>
        idx < (packFairTrimEnabled() ? MAX_SEEDED_CODE_SURFACES_FAIR : MAX_SEEDED_CODE_SURFACES)
        && seed.entry.range === undefined
        && seed.entry.symbol === undefined,
    );
    if (answerProfile && namedWholeFileSeeds.length > 0) {
      // The 32 KB tier is the one a multi-concern pack already uses for the
      // same reason: several independently required bodies have a real
      // additive floor. Claimed only for a seeded ANSWER pack naming >= 2
      // files, and only as a floor on rawCapForResult (never a narrowing).
      //
      // T1 CEILING (measured 2026-09-20): a client profile's own ceiling
      // (VS Code: 14,336) clamps `capForResult` BELOW any tier this builder
      // can claim, so granting a body the pack cannot carry does not serve it
      // -- `trimToCap` halves every caller body and the response comes back
      // capped, with a `limit`, which is strictly worse than the single
      // anchor window it replaced. Water-fill against whichever is smaller.
      const packBudget = Math.min(
        namedWholeFileSeeds.length >= SEEDED_GENEROUS_PACK_MIN_FILES
          ? SEEDED_GENEROUS_PACK_BYTES
          : namedWholeFileSeeds.length >= 2 ? MAX_TASK_PACK_BYTES_MULTI_CONCERN : MAX_TASK_PACK_BYTES,
        activePackByteCeiling() ?? Number.MAX_SAFE_INTEGER,
      );
      const bodyBudget = Math.max(0, packBudget - SEEDED_ANSWER_ENVELOPE_RESERVE);
      let spent = 0;
      const bySize = namedWholeFileSeeds
        .map((seed) => ({ seed, bytes: wholeFileEmbedBytes(seed.content, seed.entry.path) }))
        .sort((a, b) => a.bytes - b.bytes);
      for (const { seed, bytes } of bySize) {
        // A file that already fits today's allowance is served whole either
        // way; it is charged, not granted, so the big file's decision is made
        // against what is actually LEFT rather than the whole budget.
        if (bytes <= MAX_SURFACE_CODE_BYTES) {
          spent += bytes;
          continue;
        }
        if (bytes > SEEDED_ANSWER_SURFACE_CODE_BYTES) continue;
        if (spent + bytes > bodyBudget) continue;
        spent += bytes;
        wholeFileSeedAllowance.set(seed, SEEDED_ANSWER_SURFACE_CODE_BYTES);
      }
      // What is left after the whole bodies is what rule 3's windows may
      // spend on ONE file — never more than the shared per-surface cap, and
      // never more than this pack can actually carry (same ceiling reasoning
      // as `packBudget` above: windows the pack cannot carry come back
      // halved and capped, which is worse than fewer honest windows).
      seededWindowBudget = Math.max(0, Math.min(MAX_SURFACE_CODE_BYTES, bodyBudget - spent));
      // The additive tier is claimed when a mid-size body was granted whole
      // (the original rule), AND — measured on a live Copilot call naming ten
      // targets, none of them over the base per-surface allowance — whenever
      // the caller named SEEDED_GENEROUS_PACK_MIN_FILES or more files: their
      // bodies are individually small but additively exceed the base tier, and
      // the shared trimmer then sheds the LARGEST caller-named body whole (the
      // resolved `frontend/js/api.js` in that recording), which the caller
      // immediately re-requests.
      seededGenerousBudgetTier = namedWholeFileSeeds.length >= 2
        && (wholeFileSeedAllowance.size > 0 || namedWholeFileSeeds.length >= SEEDED_GENEROUS_PACK_MIN_FILES);
      seededGenerousTierBytes = namedWholeFileSeeds.length >= SEEDED_GENEROUS_PACK_MIN_FILES
        ? SEEDED_GENEROUS_PACK_BYTES
        : MAX_TASK_PACK_BYTES_MULTI_CONCERN;
    }
  }

  // 3. Build ImpactCandidates and convert via the SAME candidateToSurface
  //    used by the locate path, so handle-minting, the embed gate, and
  //    likely_edits stay identical. Candidates within the first
  //    MAX_SEEDED_CODE_SURFACES get a high confidence (clears the
  //    candidateToSurface embed gate); the rest get a low confidence so they
  //    land as handle+skeleton-only (widen via `read_code mode=slice
  //    handle=<handle>`) — sliceCode's own per-surface byte cap (and
  //    trimToCap's byte cap below) still bound how much code actually
  //    survives even within the "wants embed" group.
  //
  // WP-S2: one seed can now produce SEVERAL surfaces (rule 3's multi-window
  // anchor focus), so the map returns an array and the result is flattened.
  // Every other path returns exactly one, as before.
  const seededSurfaces: TaskPackSurface[] = (await Promise.all(
    prioritized.map(async (seed, idx): Promise<TaskPackSurface[]> => {
      // BUG FIX: was raw.split(/\r?\n/).length, which counts a phantom final
      // segment for trailing-newline content and mints a whole-file range
      // one line past the end (see util/countLines.ts doc comment).
      const lineCount = countLines(seed.content);
      let range = seed.entry.range ?? (seed.entry.symbol ? undefined : `1-${Math.max(1, lineCount)}`);
      let symbol = seed.entry.symbol;
      let focusedLine = 1;
      // 11a parity (2026-07-30): a caller-EXPLICIT range is a zoom window —
      // anchor the embed at its start so a remaining_ranges continuation
      // serves the NEXT chunk. A midpoint-centered window re-serves bytes on
      // both sides and the follow-up's remaining_ranges never advance.
      const explicitSeedStart = seed.entry.range === undefined
        ? undefined
        : /^(\d+)-\d+$/.exec(seed.entry.range)?.[1];
      if (explicitSeedStart !== undefined) focusedLine = parseInt(explicitSeedStart, 10);
      const identifierContext =
        seed.role === "test"
        && seed.entry.range === undefined
        && seed.entry.symbol === undefined
          ? queryIdentifierContext(seed.content, query)
          : undefined;
      if (identifierContext !== undefined) {
        range = identifierContext.range;
        focusedLine = identifierContext.line;
      }
      // Anchor-focus embedding (gap: transcript-verified in run 2026-07-10b;
      // selectAnchorFocus + friends are defined just below this
      // function). A caller-named FILE seed with no explicit range/symbol
      // defaults to the whole-file range above, but candidateToSurface only
      // embeds `code` when the slice fits MAX_SURFACE_CODE_BYTES — a file
      // over that cap silently ships a code-less pack even though `query`
      // often names exactly what it needs. When the caller gave neither a
      // range nor a symbol, supplied a non-empty query, and this seed's
      // content overflows the embed cap, re-point the seed at its single
      // best query-matching symbol instead of the whole file. Never a
      // guess: selectAnchorFocus returns undefined (today's whole-file
      // behavior, unchanged) when nothing scores above zero overlap.
      //
      // WP-S2 rules 1+2 (TL_SEEDED_GENEROUS): the OVERFLOW test is the only
      // thing that moved. ON, it asks what the surface would really EMBED
      // (`wholeFileEmbedBytes` — the elided text this layer's own
      // centeredSliceForCap measures) against this seed's allowance from the
      // water-filling pass above, which is SEEDED_ANSWER_SURFACE_CODE_BYTES
      // for a named file an answer pack can afford whole and
      // MAX_SURFACE_CODE_BYTES otherwise. OFF, it is the raw-byte test
      // against MAX_SURFACE_CODE_BYTES, byte-for-byte as before.
      const seedEmbedAllowance = wholeFileSeedAllowance.get(seed) ?? MAX_SURFACE_CODE_BYTES;
      const overflowsEmbedAllowance = seededGenerous
        ? wholeFileEmbedBytes(seed.content, seed.entry.path) > seedEmbedAllowance
        : Buffer.byteLength(seed.content, "utf8") > MAX_SURFACE_CODE_BYTES;
      let anchorFocus: AnchorFocusResult | undefined;
      let anchorWindows: AnchorFocusCandidate[] = [];
      if (
        identifierContext === undefined &&
        seed.entry.range === undefined &&
        seed.entry.symbol === undefined &&
        query.trim().length > 0 &&
        overflowsEmbedAllowance
      ) {
      anchorFocus = await selectAnchorFocus(seed.content, seed.entry.path, query, cache);
        if (anchorFocus) {
          range = anchorFocus.best.range;
          symbol = anchorFocus.best.name;
          // WP-S2 rule 3: on an answer profile a file that STILL does not fit
          // serves several distinct windows instead of one — see
          // `multiWindowAnchorFocus`. `[]` (never entered, or nothing extra
          // qualified) keeps the single-window shape exactly as before.
          if (seededGenerous && answerProfile) {
            anchorWindows = multiWindowAnchorFocus(
              anchorFocus, seed.content, seed.entry.path, seededWindowBudget,
            );
          }
        }
      }
      const wantsEmbed = idx < (packFairTrimEnabled() ? MAX_SEEDED_CODE_SURFACES_FAIR : MAX_SEEDED_CODE_SURFACES);
      // SHOULD-FIX 37 (2026-09-14, review round 7): disclose when this
      // seed's content is not byte-identical to the file on disk (the
      // NUL-stripped case the read loop above records in
      // `nulStrippedSeedPaths`) -- mirroring `augmentQueryNamedFileSurfaces`'s
      // own "query-named-file; nul-stripped" suffix so both routes disclose
      // the same fact about the same file the same way. Inserted BEFORE a
      // trailing "caller-supplied" token (rather than appended after it)
      // because `candidateToSurface` (below) re-appends "; caller-supplied"
      // whenever ANY `;`-separated segment of this `why` is exactly
      // "caller-supplied" (`surfaceWhyHasMarker`) -- appending "nul-stripped"
      // after that segment would still trigger the same re-append (see the
      // R1-B2 comment just below for the pre-existing, unrelated case where
      // that re-append fires on a bare "caller-supplied" why too) and
      // sandwich "nul-stripped" between two "caller-supplied" tokens instead
      // of reading as one clean qualifier list.
      const nulStripped = nulStrippedSeedPaths.has(seed.entry.path);
      // TL_EFF_LIGHT_ANSWER: a light pack's file the QUERY named is stamped
      // like the full pipeline's own query-named surface
      // (`augmentQueryNamedFileSurfaces`: `query-named-file`, required), never
      // as caller-supplied — the caller supplied no target.
      const lightQueryNamed = args.lightAnswer === "query-named" && !nulStripped;
      const baseWhy = args.naturalInferredTargets === true
        ? nulStripped ? "natural-query-operation; nul-stripped" : "natural-query-operation"
        : lightQueryNamed
        ? "query-named-file"
        : executedSearchLocatedPaths.has(seed.entry.path)
        ? nulStripped ? `${EXECUTED_SEARCH_LOCATED_WHY}; nul-stripped` : EXECUTED_SEARCH_LOCATED_WHY
        : executedSearchUnclassifiedPaths.has(seed.entry.path)
        ? nulStripped ? `${EXECUTED_SEARCH_UNCLASSIFIED_WHY}; nul-stripped` : EXECUTED_SEARCH_UNCLASSIFIED_WHY
        : seed.entry.purpose === undefined
        ? identifierContext
          ? nulStripped ? "query-identifier-test-match; nul-stripped" : "query-identifier-test-match"
          : nulStripped ? "nul-stripped; caller-supplied" : "caller-supplied"
        : nulStripped
        ? `${seed.entry.purpose}; nul-stripped; caller-supplied`
        : `${seed.entry.purpose}; caller-supplied`;
      // WP-S8: disclose that THIS server picked the file, not the caller --
      // the pack served a path they did not spell, and the ledger has to say
      // which of their paths it stands in for. Empty unless
      // TL_NAMED_TARGET_RESOLUTION resolved this seed.
      const resolvedFromNamedPath = resolvedFromByPath.get(seed.entry.path);
      const seedWhy = resolvedFromNamedPath === undefined
        ? baseWhy
        : whyWithQualifier(baseWhy, `resolved-from:${resolvedFromNamedPath}`);
      const candidate: ImpactCandidate = {
        path: seed.entry.path,
        line: focusedLine,
        ...(range ? { range } : {}),
        ...(seed.entry.range !== undefined ? { callerRange: true } : {}),
        ...(symbol ? { symbol } : {}),
        surface: seed.role,
        // R1-B2 (2026-09-13 review round): an executed search’s located path is
        // NOT caller-supplied. Stamping it so put a false provenance claim on the
        // wire (and `whySummary`, seeing the marker it appends, doubled it to
        // "caller-supplied; caller-supplied"). Every OTHER seeding site keeps its
        // existing `why` byte-for-byte — only paths this build promoted out of
        // the executed-search ledger are renamed.
        why: seedWhy,
        confidence: wantsEmbed ? 0.85 : 0.3,
        required: lightQueryNamed || requiredSet.has(seed.role),
      };
      // WP-S2 rule 2: spend the widened allowance ONLY on the whole-file body
      // the water-filling pass actually budgeted for, and only when the body
      // genuinely needs it. A seed that overflowed the allowance (and is
      // therefore serving an anchor window, or abstained back to a trimmed
      // whole-file window) keeps the shared MAX_SURFACE_CODE_BYTES — and so
      // does a named file that already fitted it, whose bytes then stay
      // byte-identical to the flag-off output.
      const surfaceCodeBytes = !overflowsEmbedAllowance
        && seedEmbedAllowance > MAX_SURFACE_CODE_BYTES
        && wholeFileEmbedBytes(seed.content, seed.entry.path) > MAX_SURFACE_CODE_BYTES
        ? seedEmbedAllowance
        : undefined;
      const surface = await candidateToSurface(
        candidate, workspace, requiredRoles, query, cache,
        { answerProfile, ...(surfaceCodeBytes !== undefined ? { surfaceCodeBytes } : {}) },
      );
      // Transparency + a ready-to-run follow-up (see
      // attachAnchorFocusAffordance — factored out verbatim so the
      // fill/dir locator-candidate paths attach the identical affordance).
      if (anchorFocus) attachAnchorFocusAffordance(surface, anchorFocus, seed.entry.path, workspace);
      // WP-S2 rule 3: the extra windows, built through the SAME
      // candidateToSurface so handle-minting and the embed gate stay
      // identical, then re-stamped so the file's uncovered spans are
      // partitioned across the windows exactly once.
      if (anchorWindows.length > 1) {
        const extras = await Promise.all(
          anchorWindows.slice(1).map(async (window) => {
            const extra = await candidateToSurface(
              {
                ...candidate,
                line: anchorWindowStartLine(window.range) ?? candidate.line,
                range: window.range,
                symbol: window.name,
              },
              workspace,
              requiredRoles,
              query,
              cache,
              { answerProfile },
            );
            // Same wording the primary window gets, so every window of the
            // file states which symbol it is and why it is here. No
            // runner-up outline: the primary window already carries it.
            attachAnchorFocusAffordance(extra, { best: window, runnerUps: [] }, seed.entry.path, workspace);
            return extra;
          }),
        );
        const windows = [surface, ...extras]
          .sort((a, b) => (anchorWindowStartLine(a.range) ?? 0) - (anchorWindowStartLine(b.range) ?? 0));
        partitionAnchorWindowRemainders(windows, lineCount);
        return windows;
      }
      return [surface];
    }),
  )).flat();
  // Snapshot the surfaces built DIRECTLY from caller-supplied paths (object
  // identity, not array position) before augmentation/locator-fill append
  // more surfaces — augmentNativeSurfaceClosure splices new sibling surfaces
  // into the middle of this array, so a position-based prefix would no
  // longer correspond to "the seeded ones" afterward.
  const protectedSurfaces = new Set(seededSurfaces);
  // Native header/source pairing (e.g. a supplied .cpp without its .hpp)
  // reuses the existing closure augmenter — same as the locate path. Its
  // spliced-in siblings are NOT in `protectedSurfaces` (they were not
  // caller-supplied) and stay droppable under trimToCap.
  if (!answerProfile) {
    await augmentNativeSurfaceClosure(seededSurfaces, workspace, query, requiredRoles, cache);
    await augmentNativeWiringSurface(seededSurfaces, workspace, cache);
    await augmentNativeIdentifierCooccurrenceSurface(seededSurfaces, workspace, query, requiredRoles, cache);
  }

  // 4. Locator fill for required roles the seeds did not cover, confined to
  //    the seeds' own common ancestor directory (never the whole workspace)
  //    so a required-role gap cannot reintroduce cross-project noise. The
  //    locator commonly ABSTAINS ("ambiguous") on a short synthetic/narrow
  //    scope rather than returning hit:true — same as the top-level
  //    buildTaskPack flow, candidateDetails on an abstain are still usable
  //    fill candidates, so both branches are folded into one candidate list
  //    here rather than only handling the hit:true case.
  const coveredRoles = new Set(seededSurfaces.map((s) => s.role));
  const stillMissingRequired = requiredRoles.filter((r) => !coveredRoles.has(r));
  // Ancestor is computed from FOUND paths only (`seeds`, not `seenPaths`) —
  // a typo'd/nonexistent supplied path must not drag the confinement
  // boundary out to a broader, less-precise ancestor than the real seeds
  // actually share. Behavior 2: caller-supplied DIRECTORY entries are scope
  // evidence too — each participates as the directory ITSELF (a synthetic
  // "<dir>/." child makes commonAncestorDir's basename-drop yield the dir),
  // so a dir-only paths[] confines the required-role fill to that dir instead
  // of degenerating to "" (whole-workspace) because `seeds` is empty.
  const ancestor = commonAncestorDir([
    ...seeds.map((s) => s.entry.path),
    ...dirEntries.map((d) => `${d.path}/.`),
  ]);

  // IMPROVEMENT F: when a task QUERY is present and the caller volunteered FILE
  // paths[] (not a directory scope), those paths are ADDITIVE SEEDS and the
  // relatedness-gated CONCERN-GROUP closure (augmentConcernGroupSurfaces below)
  // must run under the SAME budgets as the query-only (pathless) flow — never
  // confined to the seeds' own common-ancestor subtree. The 2026-07-12d
  // `ancestor` confinement made volunteering MORE (clustered) paths SHRINK the
  // discovered closure below what the identical task found with ONE path (a
  // query-related concern surface OUTSIDE the seeds' subtree was dropped).
  //
  // Confinement is LIFTED ONLY for augmentConcernGroupSurfaces: it locates a
  // real, query-matched surface PER concern group, so unconfining it can only
  // add GENUINELY-related closure, never fabricate an unrelated file. The
  // required-role FILL (step-4 above) and augmentMissingRequiredRoleSurfaces
  // (below) deliberately KEEP their `ancestor` confinement — those fill by
  // structural role hint and can pull in a textually-unrelated sibling, which is
  // exactly the false-coverage inflation the 2026-07-12d confinement closed.
  // A caller-supplied DIRECTORY keeps confinement (explicit "look only here"),
  // and a pure path-fetch with NO query stays confined (focused). "" = unconfined.
  const concernClosureScope: string =
    query.trim().length > 0 && seeds.length > 0 && dirEntries.length === 0
      ? ""
      : ancestor;
  // B1a (2026-08-01 retrieval-scope): the caller's OWN territory. `ancestor`
  // collapses it to one directory (which for paths spanning several project
  // trees is their shared parent — i.e. permission to search every sibling
  // tree); these keep the individual anchors so roleSearchScope can narrow to
  // the ancestor-children that actually hold one. Directory entries contribute
  // as the directory itself (the synthetic "/." child makes commonAncestorDir's
  // basename-drop yield the dir, same trick `ancestor` above uses).
  const callerAnchorPaths: string[] = [
    ...seeds.map((s) => s.entry.path),
    ...dirEntries.map((d) => `${d.path}/.`),
  ];
  // Confinement for a directory the QUERY names: the caller's own family root.
  // (Their individual parent directories would be too tight — a query naming
  // "packages/shared" must still resolve when the caller seeded
  // "packages/shared/src/enums.ts".)
  const callerScopePaths: string[] = ancestor !== "" ? [ancestor] : [];

  if (stillMissingRequired.length > 0 && query.trim().length > 0) {
    const fillResult = await locateTaskContext(workspace, {
      action: "locate",
      query,
      ...(ancestor ? { path: ancestor } : {}),
      limit: MAX_SURFACES_DISTINCT,
    });
    const fillRaw: ImpactCandidate[] = fillResult.hit
      ? [...fillResult.primary, ...fillResult.related]
      : (fillResult.candidateDetails ?? []).map((d) => ({
          path: d.path,
          line: d.line,
          range: d.range,
          ...(d.symbol ? { symbol: d.symbol } : {}),
          surface: d.surface,
          why: d.why,
          confidence: d.confidence,
        }));
    // Defensive re-confinement: locateTaskContext's own hard-scope filter
    // already restricts to `ancestor` when set, but this stays explicit and
    // self-contained rather than relying solely on that internal filter, and
    // also excludes anything already seeded. Sort best-first (confidence
    // desc) so the fill loop below picks the strongest candidate per role.
    const fillCandidates = fillRaw
      .filter((c) => isUnderAncestor(c.path, ancestor) && !seenPaths.has(c.path))
      .filter((c) => stillMissingRequired.includes(c.surface))
      .sort((a, b) => b.confidence - a.confidence);
    // Fill exactly one surface per still-missing required role — shrinks as
    // roles get covered so two same-role candidates (e.g. types.ts AND
    // schema.ts both classifying "contract") do not both get added.
    const rolesToFill = new Set(stillMissingRequired);
    for (const c of fillCandidates) {
      if (!rolesToFill.has(c.surface)) continue;
      rolesToFill.delete(c.surface);
      // 2026-07-10c anchor-focus reach: a fill candidate on a >4KB file with
      // no symbol pin gets re-pointed at its best query-matching symbol so
      // the filled surface embeds that body (instead of a code-less window
      // whose widened slice overflows the cap) — see
      // anchorFocusForLocatorCandidate. Zero overlap keeps `c` as-is.
      const anchored = await anchorFocusForLocatorCandidate(c, workspace, query, cache);
      const surface = await candidateToSurface(
        anchored?.candidate ?? c, workspace, requiredRoles, query, cache, { answerProfile },
      );
      if (anchored) attachAnchorFocusAffordance(surface, anchored.focus, c.path, workspace);
      seededSurfaces.push(surface);
      coveredRoles.add(c.surface);
    }
  }

  // Behavior 2: resolve caller-supplied DIRECTORY entries via a locate confined
  // to each directory. A supplied dir is a "look here" scope, not a surface —
  // fold whatever it yields in as fill candidates (same shape/discipline as the
  // required-role fill above: MAX_SURFACES_DISTINCT-bounded, one surface per
  // role, never a seed already covered). If the confined locate yields nothing
  // (or there is no query to locate with), the directory becomes a clearer
  // `missing` marker telling the caller HOW to make it usable — never a bare
  // path that reads as "file not found".
  // WP-S8 (TL_NAMED_TARGET_RESOLUTION): shared bounds for the per-directory
  // clause recovery below -- see MAX_NAMED_DIR_SURFACES_TOTAL /
  // NAMED_DIR_LOCATE_BUDGET_MS.
  let namedDirSurfacesAdded = 0;
  let namedDirLocateElapsedMs = 0;
  for (const dirEntry of dirEntries) {
    const dir = dirEntry.path;
    let foldedAny = false;
    if (query.trim().length > 0) {
      const dirResult = await locateTaskContext(workspace, {
        action: "locate",
        query,
        path: dir,
        limit: MAX_SURFACES_DISTINCT,
      });
      const dirRaw: ImpactCandidate[] = dirResult.hit
        ? [...dirResult.primary, ...dirResult.related]
        : (dirResult.candidateDetails ?? []).map((d) => ({
            path: d.path,
            line: d.line,
            range: d.range,
            ...(d.symbol ? { symbol: d.symbol } : {}),
            surface: d.surface,
            why: d.why,
            confidence: d.confidence,
          }));
      const dirFiles = new Set(walkCodeFiles(workspace, { subPath: dir }).map((file) => file.relPath));
      const explicitCodeIdentities = explicitCodeIdentifiers(query);
      const delimitedCodeIdentities = delimitedExplicitCodeIdentifiers(query);
      const singularExplicitCodeIdentity = delimitedCodeIdentities.length === 1
        && !isMultiSurfaceQuery(query);
      const explicitCodeIdentityKeys = new Set(delimitedCodeIdentities.map(normIdent));
      const rawShapeIdentifiers = (query.match(/\b[A-Za-z_$][A-Za-z0-9_$-]*\b/g) ?? [])
        .filter(isWiringIdentifierShape);
      const explicitDirIdentifiers = [
        ...explicitCodeIdentities,
        ...rawShapeIdentifiers,
      ].filter((identifier, index, all) =>
        all.findIndex((candidate) => normIdent(candidate) === normIdent(identifier)) === index
      );
      // WP-P2 C2 (2026-09-20, TL_NAMED_TARGET_RESOLUTION, answer profile only):
      // resolve a query identifier to its DEFINITION inside the named
      // directory, not just to its first literal occurrence.
      //
      // MEASURED: the identical question asked with ONLY the directory routes
      // through the pathless answer path, which resolves definitions
      // (`answer-explicit-symbol-focus` / `answer-explicit-identifier-recovery`)
      // and served the service class, the status enum and the refund member.
      // Adding ONE doc file to the same targets routes it HERE instead, where
      // `explicitCodeIdentityKeys` only admits DELIMITED identities -- a prose
      // question (the recorded one is Japanese, with the class names spelled
      // bare) has none, so every identifier fell to the literal arm below,
      // whose `exactMatches[0]` is whichever file merely MENTIONS the name
      // first: a config class and a controller, which then won the role slots
      // the real definitions needed. The caller paid three extra requests for
      // that. Trying the definition arm first costs one symbol extraction per
      // identifier and falls through to exactly today's literal candidate
      // whenever no definition exists.
      const resolveDirDefinitions = namedTargetResolution && answerProfile;
      let resolvedDirDefinition = false;
      for (const identifier of explicitDirIdentifiers.slice(0, 6)) {
        const codeIdentity = explicitCodeIdentityKeys.has(normIdent(identifier)) || resolveDirDefinitions;
        // WP-N (eval-0929 §8): whole-identifier occurrences only — a line
        // holding `X_V2` is no literal candidate for the identifier X.
        const exactMatches = scanLiteral(identifier, workspace, {
          caseInsensitive: false,
          onlyFiles: dirFiles,
        }).filter((match) => wholeIdentifierOnHitLine(workspace, match, identifier, cache) !== undefined);
        exactMatches.sort((left, right) =>
          definitionVsDerivedAdjustment(workspace, right.path, right.line, cache)
          - definitionVsDerivedAdjustment(workspace, left.path, left.line, cache)
          || Number(isImplementationPath(right.path)) - Number(isImplementationPath(left.path))
          || left.path.localeCompare(right.path)
          || left.line - right.line
        );
        if (codeIdentity) {
          const definitions: ImpactCandidate[] = [];
          for (const relPath of [...new Set(exactMatches.map((match) => match.path))]) {
            const content = cache.read(workspace, relPath);
            if (content === undefined) continue;
            const symbols = await extractSymbolsFromFile(content, relPath, 256, [identifier]);
            for (const symbol of symbols) {
              // E3: `extractSymbolsFromFile` names a C++ member QUALIFIED
              // (`EKF::isHealthy`) while `identifier` is the bare token the
              // query spelled, so the exact-name test dropped every qualified
              // definition. See `unqualifiedSymbolTail`.
              if (!identifierNamesSymbol(symbol.name, identifier)) continue;
              const classified = classifySurface(relPath, symbol.name);
              definitions.push({
                path: relPath,
                line: symbol.line,
                range: symbol.range,
                symbol: symbol.name,
                surface: singularExplicitCodeIdentity
                  && classified === "unknown"
                  && !isTestConcernPath(relPath)
                    ? "domain"
                    : classified,
                why: "explicit-query-identifier",
                confidence: 1,
                ...(singularExplicitCodeIdentity ? { required: true } : {}),
              });
            }
          }
          const nonTestDefinitions = definitions.filter((candidate) => !isTestConcernPath(candidate.path));
          const preferredDefinitions = nonTestDefinitions.length > 0 ? nonTestDefinitions : definitions;
          preferredDefinitions.sort((left, right) =>
            Number(isImplementationPath(right.path)) - Number(isImplementationPath(left.path))
            || left.path.localeCompare(right.path)
            || left.line - right.line
          );
          if (preferredDefinitions.length > 0) {
            resolvedDirDefinition = true;
            for (const definition of preferredDefinitions.slice(0, MAX_SURFACES_DISTINCT)) {
              const existingIndex = dirRaw.findIndex((candidate) => candidate.path === definition.path);
              if (existingIndex >= 0) dirRaw[existingIndex] = definition;
              else dirRaw.push(definition);
            }
            continue;
          }
        }
        const exact = exactMatches[0];
        if (exact === undefined) continue;
        const literalCandidate: ImpactCandidate = {
          path: exact.path,
          line: exact.line,
          range: `${exact.line}-${exact.line}`,
          surface: classifySurface(exact.path),
          why: "explicit-query-identifier",
          confidence: 1,
        };
        const existingIndex = dirRaw.findIndex((candidate) => candidate.path === exact.path);
        if (existingIndex >= 0) dirRaw[existingIndex] = literalCandidate;
        else dirRaw.push(literalCandidate);
      }
      // Confine to the supplied dir (defense-in-depth beyond locate's own
      // hard-scope filter), drop anything already seeded/covered, best-first.
      // W5-B (2026-08-21, R3 text-floor regression fix): also drop a
      // "header-source-pair" candidate here — a DERIVED pairing (added
      // because a SIBLING file matched, not because this file itself was a
      // query hit), which this confined loop's own role-fill treats as an
      // ordinary direct hit. The dedicated, properly scope-confined pairing
      // step (augmentNativeSurfaceClosure, later in the pipeline) already
      // owns header/source pairing FOR WHATEVER SURFACE SET SURVIVES here —
      // letting a bare header win a role slot in THIS loop let a
      // declaration-only surface masquerade as "the query's own hit" for a
      // role no real hit claimed, which downstream concern-coverage checks
      // (concernGroupMatchesSurfaces) then read as the concern already
      // being satisfied on nothing but an incidental path-substring tie.
      const dirCandidates = dirRaw
        .filter((c) => isUnderAncestor(c.path, dir) && !seenPaths.has(c.path) && c.why !== "header-source-pair")
        .sort((a, b) =>
          b.confidence - a.confidence
          || Number(b.why === "explicit-query-identifier") - Number(a.why === "explicit-query-identifier")
          // W5-B: an IMPLEMENTATION file wins a same-confidence tie over a
          // declaration/header — a short (post-R3, 4-7 char) discriminating
          // token now commonly matches a symbol's declaration and its
          // definition equally, which previously only a longer/rarer token
          // did (and always favored whichever body used it more precisely,
          // rarely a bare tie). Mirrors the same isImplementationPath
          // preference this file already applies to explicit-identifier
          // definition ranking above (preferredDefinitions.sort).
          || Number(isImplementationPath(b.path)) - Number(isImplementationPath(a.path))
          || a.path.localeCompare(b.path)
        );
      // Role-fill discipline: one surface per role not already covered, and
      // never exceed the overall surface budget.
      const dirRolesFilled = new Set<ImpactSurface>();
      for (const c of dirCandidates) {
        if (seededSurfaces.length >= MAX_SURFACES_DISTINCT) break;
        // 2026-07-10c anchor-focus reach: same re-point as the required-role
        // fill loop above — real packs open with paths=["<dir>"]+query, so
        // THIS loop is where a >4KB file's candidate must consult the query
        // for symbol selection. Zero overlap keeps today's behavior.
        // WP-P2 C2: a candidate THIS build resolved to the DEFINITION of an
        // identifier the query spells is already symbol-exact, so it keeps its
        // own window -- anchor focus exists to pick a symbol for a candidate
        // that has none (or whose symbol is a bare literal line), and letting
        // it re-point a resolved definition serves a different member than the
        // one the caller asked about.
        const resolvedDefinitionCandidate = resolveDirDefinitions
          && c.why === "explicit-query-identifier"
          && c.symbol !== undefined;
        const anchored = resolvedDefinitionCandidate
          ? undefined
          : await anchorFocusForLocatorCandidate(c, workspace, query, cache);
        const explicitAnchor = (anchored?.focus.best.score ?? 0) >= ANCHOR_FOCUS_EXPLICIT_IDENTIFIER_WEIGHT;
        const explicitIdentity = (singularExplicitCodeIdentity || resolveDirDefinitions)
          && c.why === "explicit-query-identifier"
          && c.symbol !== undefined;
        // WP-P2 C2: once a definition the QUERY names has resolved inside this
        // directory, a candidate that is only a FILE (no resolved symbol) is a
        // role fill, and the answer path this shape is supposed to match does
        // not make them -- it is how the recorded pack came back carrying a
        // whole `AdminController` and a framework config class while the two
        // classes the question named were absent. Symbol-precise candidates
        // (the definitions themselves, and the locator's own query-symbol
        // hits) still compete normally.
        if (resolveDirDefinitions && resolvedDirDefinition && c.symbol === undefined) continue;
        if (
          (coveredRoles.has(c.surface) || dirRolesFilled.has(c.surface))
          && !explicitAnchor
          && !explicitIdentity
        ) continue;
        dirRolesFilled.add(c.surface);
        seenPaths.add(c.path);
        const selectedCandidate = anchored?.candidate ?? c;
        const surface = await candidateToSurface(
          {
            ...selectedCandidate,
            why: explicitIdentity ? "explicit-query-identifier" : "caller-supplied-dir",
          },
          workspace,
          requiredRoles,
          query,
          cache,
          { answerProfile },
        );
        if (anchored) attachAnchorFocusAffordance(surface, anchored.focus, c.path, workspace);
        seededSurfaces.push(surface);
        coveredRoles.add(c.surface);
        foldedAny = true;
      }
    }
    // WP-S8 (TL_NAMED_TARGET_RESOLUTION, 2026-09-20): a caller-named DIRECTORY
    // still contributes NOTHING when the locate above abstains -- which is what
    // the whole-query locate does on a multi-point question, and what it did on
    // every one of the three directories in the recorded GitHub Copilot session
    // (the service directory holding the three classes the question was about
    // came back empty, and the model spent two turns recovering it). Locate
    // inside the directory ONE MORE TIME, through the SAME per-clause recovery
    // `concernRecovery.ts` already runs for the answer path -- which is also
    // what brings the Japanese query bridge along (`jaBridgeExpansionTokens`/
    // `jaBridgeRecoveryQuery` are themselves TL_JA_QUERY_BRIDGE-gated, so this
    // re-uses that policy rather than restating it) -- driven by the target's
    // OWN `purpose` text first and confined to this directory.
    //
    // ANSWER profile only, and never on a `qref` replay: a change pack derives
    // required-role coverage and obligations from its surface set, and this is
    // evidence, not a role fill -- an answer pack has no required roles at all
    // (`requiredRoles` is `[]` above), so readiness and obligations are
    // untouched by construction rather than by careful bookkeeping. The replay
    // rule is the seeded clause recovery's own, for its own reason: a replay
    // adds files to a working set the caller already holds.
    //
    // Strictly ADDITIVE: every pick is appended after the caller-named file
    // surfaces (never a replacement, reorder or promotion of them), deduped
    // against what is already seeded, bounded per directory and per pack, and
    // NOT added to `protectedSurfaces` -- so `trimToCap` sheds these before any
    // caller-named body, which is what "subject to the pack budget" means here.
    // A directory whose recovery abstains contributes nothing; there is no
    // fallback guess.
    //
    // NOT gated on `MAX_SURFACES_DISTINCT`, unlike the confined loop above:
    // that is the LOCATE path's distinct-surface budget, and a seeded pack
    // deliberately does not honor it for caller-named paths (see
    // MAX_SEEDED_CODE_SURFACES's own doc -- every supplied path still gets a
    // surface). On the recorded session the ten named targets had already
    // filled it, so the pre-existing directory fill could not have run whatever
    // it located. MAX_NAMED_DIR_SURFACES(_TOTAL) is this mechanism's own bound;
    // the BYTE budget is `trimToCap`'s, and it sheds these first.
    if (
      namedTargetResolution
      && answerProfile
      && args.taskQueryRefReplay !== true
      && namedDirSurfacesAdded < MAX_NAMED_DIR_SURFACES_TOTAL
      && namedDirLocateElapsedMs < NAMED_DIR_LOCATE_BUDGET_MS
    ) {
      // WP-P2 A (2026-09-20): a caller may name the SAME directory more than
      // once, each time with a DIFFERENT purpose -- the recorded session named
      // the service directory twice ("order service cancellation, payment
      // refund, inventory restoration" and "payment and inventory service
      // implementations"). The targets de-dupe above keys on path+range+symbol,
      // so only the first entry survives into `dirEntries`; read every purpose
      // the caller attached to THIS directory back off their own entry list,
      // because each one is a "look in here for this" the pack owes an answer
      // to. One entry (the ordinary case) yields exactly that entry's purpose.
      const dirPurposeText = entries
        .filter((entry) => entry.path === dir)
        .map((entry) => entry.purpose?.trim() ?? "")
        .filter((text, index, all) => text.length > 0 && all.indexOf(text) === index)
        .join("; ");
      const dirClauses = namedDirClauseWorkList(dirPurposeText, query);
      if (dirClauses.length > 0) {
        // What this pack ALREADY serves is the coverage window, so a clause the
        // caller-named files already answer does not spend one of this
        // directory's slots -- the directory gets the concerns nothing else
        // covered, which on the recorded session is exactly the service-layer,
        // refund and inventory ones.
        const dirCoverageWindow: DiversifyCandidate[] = seededSurfaces.map((surface) => ({
          path: surface.path,
          ...(surface.symbol !== undefined ? { symbol: surface.symbol } : {}),
        }));
        // WP-P2 A: ... EXCEPT for a concern the caller wrote on the DIRECTORY
        // itself. "Look IN HERE for this" is not discharged by a file that
        // lies somewhere else, and on the recorded session that is precisely
        // what happened: the whole-pack window let the caller's own
        // `PaymentController.java` seed cover the directory purpose "payment
        // refund" and `OrderController.java` cover "order service
        // cancellation", so `PaymentService.refund` and `OrderService.cancel`
        // -- the centre of the question -- were never located, and the pack
        // still certified `act.answer`. A `dir-purpose-*` clause is therefore
        // judged only against what this pack serves from UNDER this directory;
        // a `dir-query-*` clause comes from the request's own query, carries no
        // scope of its own, and keeps the whole-pack window unchanged.
        const dirPurposeCoverageWindow = dirCoverageWindow.filter((candidate) =>
          isUnderAncestor(candidate.path, dir)
        );
        const dirLocateStartedAt = Date.now();
        const dirFocusByCandidate = new Map<ImpactCandidate, AnchorFocusResult>();
        const dirClauseRecovery = await runClauseLocateRecovery<ImpactCandidate>(
          dirClauses,
          (clause) => clause.id.startsWith(NAMED_DIR_PURPOSE_CLAUSE_PREFIX)
            ? dirPurposeCoverageWindow
            : dirCoverageWindow,
          {
            tokenize: tokenizeQueryForDiversification,
            locate: (queryText, limit) => namedDirClauseLocate(queryText, limit, {
              dir,
              workspace,
              lang: args.lang,
              cache,
              focusByCandidate: dirFocusByCandidate,
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
          },
        );
        namedDirLocateElapsedMs += Date.now() - dirLocateStartedAt;
        let addedForThisDir = 0;
        for (const { candidate } of dirClauseRecovery.picks) {
          if (addedForThisDir >= MAX_NAMED_DIR_SURFACES) break;
          if (namedDirSurfacesAdded >= MAX_NAMED_DIR_SURFACES_TOTAL) break;
          if (seenPaths.has(candidate.path)) continue;
          // Defense-in-depth beyond locate's own hard-scope filter, exactly as
          // the confined loop above re-checks it: this directory is the scope
          // the caller named, and nothing outside it was asked for.
          if (!isUnderAncestor(candidate.path, dir)) continue;
          seenPaths.add(candidate.path);
          // WP-P2 C (2026-09-20): the clause locate above re-points EVERY
          // symbol-less candidate at one symbol window, because that is what
          // makes it addressable to `pickCoveredClauseLocateCandidate` -- but
          // narrowing is only worth its cost on a file too large to serve
          // whole. `anchorFocusForLocatorCandidate` draws that line at
          // MAX_SURFACE_CODE_BYTES and the same line applies here: an 80-line
          // controller costs ~2 KB whole and answers the request item outright,
          // where the 8-line endpoint window it was narrowed to did not, and
          // the caller paid a follow-up request for the rest.
          const pickContent = cache.read(workspace, candidate.path);
          const serveWhole = pickContent !== undefined
            && Buffer.byteLength(pickContent, "utf8") <= MAX_SURFACE_CODE_BYTES;
          const { symbol: _narrowedSymbol, ...pickWithoutSymbol } = candidate;
          const surface = await candidateToSurface(
            serveWhole
              ? {
                ...pickWithoutSymbol,
                line: 1,
                range: `1-${Math.max(1, countLines(pickContent))}`,
                why: "caller-supplied-dir",
              }
              : { ...candidate, why: "caller-supplied-dir" },
            workspace,
            requiredRoles,
            query,
            cache,
            { answerProfile },
          );
          // Same transparency + ready-to-run widen affordance every other
          // anchor-focused surface in this builder carries, so a caller whose
          // answer needs more than the one window can ask for it directly.
          const dirFocus = dirFocusByCandidate.get(candidate);
          if (dirFocus !== undefined) {
            attachAnchorFocusAffordance(surface, dirFocus, candidate.path, workspace);
          }
          seededSurfaces.push(surface);
          addedForThisDir += 1;
          namedDirSurfacesAdded += 1;
          foldedAny = true;
        }
      }
    }
    // The marker means "this directory contributed NOTHING to the pack". The
    // required-role fill above is also ancestor-confined (the supplied dirs
    // participate in the ancestor), so it may already have surfaced files from
    // INSIDE this dir before this loop ran — that dir has been honored, and
    // re-flagging it as unusable would be wrong. Emit the marker only when no
    // surface at all lies under the dir.
    const dirRepresented =
      foldedAny ||
      seededSurfaces.some((s) => isUnderAncestor(s.path, dir)) ||
      discoverArtifactFiles(workspace, { path: dir, includeAll: true }).length > 0;
    if (!dirRepresented) {
      // Short marker, not a remedy sentence. `missing` is consumed downstream
      // as a list of surface ROLE names, and the old prose rode that path into
      // `surfaceRoles=["<dir>/ (directory — pass cwd=…)"]` — a filter no pack
      // can ever satisfy, so the caller looped. The trailing "/ (directory)"
      // still separates an unusable DIRECTORY from a not-found file (a bare
      // path reads as the latter), while the remedy itself now ships as a
      // machine-executable call in `next`/`next_call` — see unexpandedDirNext.
      missing.push(`${dir}/ (directory)`);
      unresolvedDirs.push(dir);
    }
  }

  // A caller-spelled code identity is stronger than a prose/token candidate
  // found in the same directory. Keep supporting surfaces, but make the one
  // uniquely matching definition the primary edit frontier. Without this
  // reorder a directory locator's earlier same-role decoy owns surfaces[0],
  // and the otherwise exact implementation is presented as a secondary
  // candidate, which reopens discovery.
  const explicitIdentityPrimary = dirEntries.length > 0
    && delimitedExplicitCodeIdentifiers(query).length === 1
    && !isMultiSurfaceQuery(query)
    ? uniqueExplicitIdentityCandidate(seededSurfaces, query)
    : undefined;
  if (explicitIdentityPrimary !== undefined) {
    const primary = explicitIdentityPrimary.candidate;
    primary.required = true;
    for (const surface of seededSurfaces) {
      if (surface !== primary && surface.required !== true) surface.required = false;
    }
    const primaryIndex = seededSurfaces.indexOf(primary);
    if (primaryIndex > 0) {
      seededSurfaces.splice(primaryIndex, 1);
      seededSurfaces.unshift(primary);
    }
  }

  // Registration-reach fix (2026-07-12c forensics): a caller-supplied
  // DIRECTORY only becomes concrete surfaces once the dirEntries loop above
  // runs — for a pure-dir pack `seededSurfaces` is still EMPTY at the top of
  // this function, so augmentConcernGroupSurfaces/augmentMissingRequiredRoleSurfaces
  // must sit HERE (after seed assembly genuinely completes for a dir-scoped
  // pack), not alongside the native-closure/wiring/cooccurrence trio above
  // (which already runs before this point and is therefore a structural
  // no-op for a pure-dir pack — those three are pre-existing/out of scope
  // for this fix; the required-role-fill loop and this pair are what a
  // dir-seeded pack actually gets a second chance from). Same six-function
  // pipeline the pathless flow (buildTaskPack) and the abstain-candidate
  // flow (buildPartialPack) already run, reused verbatim — only the call
  // SITE moved to match this flow's own seed-assembly order.
  //
  // Reuses the SAME `protectedSurfaces` set already seeded with the
  // caller-named files above (empty for a pure-dir pack): concern-group
  // additions are appended (never reordered ahead of what is already
  // present) and become protected themselves, exactly mirroring the
  // pathless flow's own behavior — trimToCap's Phase 1 still sheds
  // unprotected surfaces from the END first, so anything this pass adds to
  // a FILE-seeded pack is shed before the caller's own named files, and for
  // a pure-dir pack (nothing protected at all) it is still the newest,
  // last-appended content and so the first to go.
  //
  // 2026-07-12d confinement fix (accepted-invariant-breach repair): both
  // calls below now receive `ancestor` — the caller-supplied entries' own
  // common ancestor directory computed above, empty string when the seeds
  // share no ancestor (both augmenters already treat "" as "no additional
  // restriction" via isUnderAncestor). Before this fix the two calls were
  // deliberately UNCONFINED (no scope/ancestor parameter at all), so a
  // concern-group or required-role candidate found ANYWHERE in the
  // workspace could get appended to a caller-SEEDED pack and — since
  // coverage is recomputed from the post-augmentation surface set below —
  // silently promote coverage from partial to complete on material the
  // caller never named. Passing `ancestor` closes that gap: a candidate
  // outside the caller's own named territory is dropped by the augmenter's
  // own defensive isUnderAncestor filter, never added, never
  // coverage-bearing. The other two call sites (buildTaskPack's pathless
  // flow, buildPartialPack's abstain-candidate flow) still call both
  // functions with no scope argument — there is no caller-named scope to
  // respect there, so they keep today's unconfined behavior unchanged.
  if (!answerProfile) {
    await augmentConcernGroupSurfaces(seededSurfaces, query, workspace, requiredRoles, cache, protectedSurfaces, concernClosureScope, callerAnchorPaths);

    // Item 1: resolve a REQUIRED "style" role the seeds/fill did not cover to a
    // NAMED surface (handle + code), scoped to the seeds' dominant root.
    // B1a (2026-08-01 retrieval-scope): the CALLER's own paths are the anchors —
    // a role fill on an explicit-paths pack must stay inside the territory the
    // caller named (and any directory the query itself named), never spill into
    // a sibling project tree that shares only a distant ancestor.
    await augmentStyleSurface(seededSurfaces, query, workspace, requiredRoles, cache, callerAnchorPaths, callerScopePaths);
    // FIX-B2 (ported alongside augmentConcernGroupSurfaces above, same
    // rationale): attempt every OTHER still-missing required role in this SAME
    // call — see augmentMissingRequiredRoleSurfaces's own doc comment. Runs
    // LAST of the six, matching its role as the final catch-all in both other
    // flows: it recomputes stillMissingRequiredRoles fresh, so it only ever
    // acts on roles that survive the required-role-fill loop, the dirEntries
    // loop, and augmentStyleSurface above. Also confined to `ancestor` (same
    // 2026-07-12d fix as augmentConcernGroupSurfaces above).
    await augmentMissingRequiredRoleSurfaces(seededSurfaces, query, workspace, requiredRoles, cache, ancestor, callerAnchorPaths);
    // DESIGN-v0.8 coverage-honesty (Part 5 B-1): promote a config/data/doc seed
    // whose already-read content already names the enum's new value.
    promoteVariantSurfaces(seededSurfaces, query, workspace, cache);
  }

  // 2026-07-10a forensics: a PURE-directory pack (no caller-named files — every
  // surface was the server's own pick) put the decoy's TEST file in the
  // primary slot, so `next` said "tl_edit_file handle=<the test>". A test/doc
  // surface must not headline a pack the caller gave no file for when an
  // implementation-role surface exists — the primary slot drives next +
  // likely_edits.
  const pureDirScope = seeds.length === 0 && dirEntries.length > 0;
  if (pureDirScope && seededSurfaces.length >= 2) {
    const first = seededSurfaces[0]!;
    if (first.role === "test" || first.role === "doc") {
      const implIdx = seededSurfaces.findIndex(
        (s) => s.role === "domain" || s.role === "api" || s.role === "config" || s.role === "contract",
      );
      if (implIdx > 0) {
        const [impl] = seededSurfaces.splice(implIdx, 1);
        seededSurfaces.unshift(impl!);
      }
    }
  }
  finalizePrimarySurface(seededSurfaces);

  // TL_CONCERN_RECOVERY / seeded-pack clause coverage (Agent J, 2026-09-19):
  // the GitHub Copilot call shape -- tl_read_file {query:"<multi-point
  // question>", targets:[1-4 guessed files]} -- routes HERE (caller-supplied
  // paths), never through buildAnswerTaskPack, so the per-clause locate
  // recovery there never ran before this hook existed: a query clause the
  // guessed files do not cover stayed silently unserved even though this
  // pack still reported every caller-named path found. Same flag, same
  // MAX_CLAUSE_LOCATES/time budget as the answer path's own mechanism
  // (concernRecovery.ts) -- the coverage GATE differs: a locate-path clause
  // is judged covered by a ranked candidate's path/symbol alone, but a
  // seeded pack has already READ every caller-named file (`seeds`), so a
  // seeded clause is judged against real served content too
  // (isClauseCoveredBySeededSurfaces). Strictly additive: a pick becomes a
  // brand NEW surface appended after every caller-named one -- never a
  // replacement/reorder/promotion of them, and mergeConcernAdditions's
  // window/displacement machinery does not apply here (a seeded pack has no
  // selection window to begin with; every caller path already stands).
  // First pack of the task only: a qref replay adds files to a working set
  // the caller already holds (the C2 rule at the dispatch site -- a
  // context-only addition never re-derives coverage), and judging the
  // request's clauses against THIS call's few added files alone would find
  // them all "uncovered" and spend the locate budget a second time.
  if (answerProfile && concernRecoveryEnabled() && args.taskQueryRefReplay !== true) {
    const seededClauseWorkList = hygienicClauseWorkList(extractRequestItems(query));
    if (seededClauseWorkList.length >= 2) {
      recordSeededClauseRecoveryEntry();
      // B5 (fix-b, 2026-09-21): `isDocSurface` lets isClauseCoveredBySeededSurfaces
      // gate its own body-text branch (see that function's doc comment) — this
      // pack's own `role` classification, never a fresh heuristic.
      const seededCoverageSurfaces: SeededCoverageSurface[] = seededSurfaces.map((surface) => ({
        path: surface.path,
        symbol: surface.symbol,
        bodyText: surface.code,
        isDocSurface: surface.role === "doc",
      }));
      const seededUncoveredClauses = seededClauseWorkList.filter((clause) => {
        const isJapanese = containsJapanese(clause.text);
        const jaExtras = isJapanese ? jaBridgeExpansionTokens(clause.text, workspace) : [];
        const baseTokens = clauseCoverageTokenSet(clause.text, tokenizeQueryForDiversification, jaExtras);
        const stemExtras = isJapanese
          ? []
          : collectNeighbourWords(baseTokens, (token) => vocabularyStemNeighbours(token, workspace));
        const tokens = stemExtras.length > 0 ? new Set([...baseTokens, ...stemExtras]) : baseTokens;
        return !isClauseCoveredBySeededSurfaces(tokens, seededCoverageSurfaces, tokenizeQueryForDiversification);
      });
      if (seededUncoveredClauses.length > 0) {
        const seededClauseRecovery = await runClauseLocateRecovery<ImpactCandidate>(
          seededUncoveredClauses,
          [],
          {
            tokenize: tokenizeQueryForDiversification,
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
          },
        );
        const seededPresentPaths = new Set(seededSurfaces.map((s) => s.path));
        for (const { candidate } of seededClauseRecovery.picks) {
          if (seededSurfaces.length >= MAX_SURFACES_DISTINCT) break;
          if (seededPresentPaths.has(candidate.path)) continue;
          seededPresentPaths.add(candidate.path);
          const surface = await candidateToSurface(candidate, workspace, requiredRoles, query, cache, { answerProfile });
          seededSurfaces.push(surface);
        }
      }
    }
  }

  // Edit context (2026-10-16 bench): an edit target carries the definitions
  // its body depends on — one the server located itself (pathless, or inside
  // the caller's one directory scope), or the single target the caller named
  // alongside its request (a caller-named set of several stands exactly as
  // named). Only a callable the request names, or the single one in a served
  // window, is a focal, so a plain read target adds nothing.
  if (!answerProfile && (args.autoDiscoveredLocation === true || (args.paths?.length ?? 0) <= MAX_EDIT_CONTEXT_CALLER_TARGETS)) {
    await augmentEditContextSurfaces(seededSurfaces, query, workspace, requiredRoles, cache, selectedProfile === "generic");
  }

  // WP-O (eval-0929 §8): a same-name subject none of the caller's targets
  // declares — its call sites never prove it; the certificate names the
  // declaration the question means as a ranged `next` (see
  // `seededSameNameSubjects`). Computed BEFORE the facet plan (FIX-G, below) so a
  // value/condition facet asked of it settles on the same declaration.
  const seededSameName = answerProfile
    ? await seededSameNameSubjects(args, query, workspace, seededSurfaces, entries.map((entry) => entry.path).filter((entryPath) => entryPath.length > 0), cache)
    : new Map<string, SameNameSubject>();
  if (seededSameName.size > 0) sameNameSubjectsByCache.set(cache, seededSameName);
  // FIX-G (2026-09-27, eval-0927 P0): a seeded answer pack never runs the
  // facet-closure hook (it lives in buildAnswerTaskPack), so a faceted
  // question asked WITH explicit targets would reach the completion gate with
  // no plan and could only be disclosed "not computed". Plan ONLY here —
  // nothing is served and no caller-named surface is widened or reordered
  // (`planOnly`): the gate then judges the caller's own served windows against
  // the same closure a pathless ask would require, and names any missing
  // window as a ranged `next`. First pack of the query only (a replay, or a
  // follow-up of a query whose plan is already recorded and still valid,
  // reuses that plan — see facetGate.ts's memo).
  //
  // WP-E (eval-0929 §7 bullet 2 / §8): "a replay ... reuses that plan" above
  // is true only while the plan IS still valid. This used to be a separate,
  // unconditional `taskQueryRefReplay !== true` gate around the whole block,
  // so a replay whose plan was invalidated by an external file change (or
  // never recorded at all — the same "missing" case a first pack of a
  // never-before-seen query hits) skipped re-planning outright and left
  // `buildFacetReadiness` with nothing to judge, disclosing "not computed"
  // forever rather than for one hop. `planRecorded` already IS the exact
  // "missing or invalidated" test (facetPlanFor re-checks every named file's
  // sha) — the replay/first-pack distinction adds nothing a valid-plan check
  // does not already decide correctly, so it is folded into `planRecorded`
  // instead of gating around it: a replay with a still-valid plan takes the
  // same no-op it always did (byte-identical — the recall control); a replay
  // whose plan is missing or stale now re-plans exactly like a first pack of
  // this same query would.
  if (answerProfile) {
    const facetRequirements = extractFacetRequirements(query);
    const planRecorded = facetRequirements.length === 0
      || facetPlanFor(facetPlanWorkspaceKey(workspace), query, (relPath) => {
        const content = readCached(workspace, relPath, cache);
        return content === undefined ? undefined : shaOfText(content);
      }) !== undefined;
    if (!planRecorded) {
      const planSelection: ImpactCandidate[] = seededSurfaces.map((surface) => {
        const candidate: ImpactCandidate = {
          path: surface.path,
          line: parseSurfaceSpan(surface.range)?.start ?? 1,
          range: surface.range,
          ...(surface.symbol !== undefined ? { symbol: surface.symbol } : {}),
          surface: asImpactSurface(surface.role),
          // A query-named file keeps that provenance for facet resolution.
          why: args.lightAnswer === "query-named" ? "query-named-file" : "caller-supplied",
          confidence: 1,
        };
        const span = isExplicitRangeSurface(surface) ? parseSurfaceSpan(surface.range) : undefined;
        if (span !== undefined) explicitFacetSelectionRange.set(candidate, span);
        return candidate;
      });
      await recoverFacetClosureCandidates(args, query, workspace, cache, planSelection, facetRequirements, true);
    }
  }

  // 5. Route/checks/verify/coverage, same shape as the locate path.
  // Derive from the ACTUAL surface set (not the running `coveredRoles` tally)
  // so a role added late by augmentStyleSurface (item 1) counts as covered.
  const missingRequired = requiredRoles.filter((r) => !seededSurfaces.some((s) => s.role === r));
  const allMissing = mergeUnique(missing, missingRequired);
  // DESIGN-v0.8 coverage-honesty: a seeded pack is complete when it covers
  // everything asked for; otherwise a required role (or a nonexistent supplied
  // path) is missing — "missing-roles".
  let coverageStr: "complete" | "partial" = allMissing.length === 0 ? "complete" : "partial";
  let coverageReason: TaskPackResult["coverage_reason"] | undefined =
    coverageStr === "partial" ? "missing-roles" : undefined;
  // 2026-07-11c false-"complete" (dir-seeded concern gap): a
  // caller-supplied DIRECTORY (dirEntries.length>0 — whether or not file
  // seeds are ALSO present) is a "look here" scope, not an earned file list
  // — its surfaces are locator picks, same trust level as a pathless
  // locate. Run 2026-07-11c's live pack claimed complete on a 3-symptom
  // query while surfacing an off-target header, an unrelated boilerplate
  // startup file, and two test slices — none of the planted-bug files — and
  // the agent trusted "complete", stopped searching, and edited a decoy.
  // Reuses the IDENTICAL unmatchedConcernTokens the pathless locate path
  // already gates on (deriveCoverage rule 2 / buildRoute's own A4 flip),
  // computed over the FINAL surface set (after augmentStyleSurface/
  // promoteVariantSurfaces/reordering) so late augmenters are accounted
  // for. Packs seeded ONLY by caller-NAMED files (dirEntries.length===0)
  // keep the pre-11c earned-trust rule unchanged — naming an exact file is
  // a stronger signal than a directory scope, and this gate never
  // second-guesses it.
  let unmatchedConcern: string[] = [];
  if (dirEntries.length > 0 && query.trim().length > 0) {
    unmatchedConcern = unmatchedConcernTokens(query, seededSurfaces);
    if (coverageStr === "complete" && unmatchedConcern.length > 0) {
      coverageStr = "partial";
      coverageReason = "concerns-uncovered";
    }
  }
  // 2026-07-10a pure-dir false-"complete": the seeded complete rule ("caller's
  // paths ARE the located set") is earned by caller-NAMED files. A pure-dir
  // pack's surfaces are locator picks — same trust level as a pathless
  // locate — and that run's pack claimed complete while embedding only a
  // test, two headers and a doc (zero implementation bodies), steering the
  // agent to the decoy. Claiming complete now additionally requires at least
  // one embedded implementation-body surface. 10c tightening: the first cut
  // ("role not test/doc, not a C/C++ header") let a ONE-LINE __init__.py
  // stub (role "unknown") count as a body and re-opened the false-complete
  // live — the role must now be a recognized implementation role and the
  // embedded code non-trivial. 11c tightening: role+size alone was STILL not
  // enough — an implementation-role boilerplate file with ZERO relation to
  // the query (startup.c, sharing no token with the 11c query) also passed
  // this test, so the qualifying surface must now also be GROUNDED in the
  // query (surfaceGroundedInQuery) whenever the query is non-blank; a blank
  // query keeps the pre-11c ungrounded behavior (nothing to ground against).
  const IMPLEMENTATION_BODY_ROLES: ReadonlySet<string> = new Set(["domain", "api", "config", "contract"]);
  let dirPackDemotionCheck: string | undefined;
  if (pureDirScope && coverageStr === "complete") {
    const queryGiven = query.trim().length > 0;
    // The surfaces' OWN deepest common ancestor directory is stripped before
    // grounding (see surfaceGroundedInQuery's doc comment) — every surface in
    // a pureDirScope pack shares at least the caller-supplied directory, and
    // often a deeper shared subtree too (e.g. every firmware file living
    // under ".../firmware/"). Left unstripped, a query that simply names the
    // project/directory ("acme firmware...") would trivially ground every
    // surface regardless of actual relevance.
    const groundingScope = commonAncestorDir(seededSurfaces.map((s) => s.path));
    const scopePrefixes = groundingScope.length > 0 ? [groundingScope] : [];
    const hasImplementationBody = seededSurfaces.some(
      (s) =>
        s.code !== undefined &&
        countLines(s.code) > 3 &&
        IMPLEMENTATION_BODY_ROLES.has(s.role) &&
        !/\.(h|hpp|hh|hxx)$/i.test(s.path) &&
        (!queryGiven || surfaceGroundedInQuery(s, query, scopePrefixes)),
    );
    if (!hasImplementationBody) {
      coverageStr = "partial";
      coverageReason = "candidate-list";
      // 11c: with grounding in play the pack may well EMBED an implementation
      // body (the irrelevant startup.c did) — the honest complaint is that no
      // embedded body relates to the query.
      dirPackDemotionCheck = queryGiven
        ? "dir-scoped pack embeds no query-grounded implementation body — slice the implicated source before editing"
        : "dir-scoped pack embeds no implementation body — slice the implicated source before editing";
    }
  }
  // Listed scope items (2026-10-19, v016 6t-4 T09): a pack the server located
  // itself claims "complete" only when every place the request lists maps to
  // a served surface or to a row that discharges it (accountForListedScopeItems).
  // A caller-named file set keeps the earned-trust rule above.
  if (!answerProfile && coverageStr === "complete" && args.autoDiscoveredLocation === true) {
    const listed = await accountForListedScopeItems(query, seededSurfaces, workspace, ancestor, cache);
    for (const row of listed.added) protectedSurfaces.add(row);
    if (listed.uncovered.length > 0) {
      coverageStr = "partial";
      coverageReason = "concerns-uncovered";
      allMissing.push(...listed.uncovered.map((item) => `listed-item:${item}`));
      unmatchedConcern = listed.unmatchedTokens;
    }
  }
  const route = buildRoute(seededSurfaces, missingRequired, coverageStr, allMissing, query, coverageReason);
  // 2026-07-31: a caller-supplied directory that produced no surface is a PATH
  // gap, and every hint nextHintForCoverage can emit is role- or token-shaped,
  // so none of them close it. Name the call that does — re-seed the pack scoped
  // to that directory — as the last-resort hint. Ranked BELOW the role/token
  // hints: a genuinely missing required role is the better lead when both hold.
  // JSON.stringify per item, not bare interpolation: these are caller-supplied
  // paths, and a path may legally contain a double quote. Raw interpolation made
  // parseQuotedList stop at it and hand back a TRUNCATED path that can itself
  // exist — a wrong-file read that looks like a success. (Role and handle lists
  // nearby are safe: neither alphabet admits a quote.)
  // D1 (2026-08-01 probe sweep): the old remedy re-issued THIS call (same
  // query + same dirs) — for a caller whose invocation WAS query+those dirs
  // that is an identity next_call, and an obedient agent loops on it. A dir
  // that contributed nothing needs an INVENTORY step, not a re-scan: name the
  // tree call for the first unresolved dir instead.
  const unexpandedDirNext: ContinuationCall | undefined = unresolvedDirs.length > 0
    ? { tool: "tl_search_files", arguments: { action: "tree", path: unresolvedDirs[0] } }
    : undefined;
  const nextHint = nextHintForCoverage(
    seededSurfaces, coverageStr, coverageReason, query, missingRequired, unmatchedConcern,
  ) ?? unexpandedDirNext;

  const { lines: checkLines, records: checkRecords } = buildCompletionChecks(query, seededSurfaces, allMissing, workspace);
  if (dirPackDemotionCheck !== undefined) {
    checkLines.unshift(dirPackDemotionCheck);
    if (checkLines.length > MAX_COMPLETION_CHECKS) checkLines.length = MAX_COMPLETION_CHECKS;
  }
  // Item 4: computed over the FINAL (post-augmentation) surface set, same as
  // every other coverage-facing computation above — a token the pre-
  // augmentation seeds/dirEntries missed but augmentConcernGroupSurfaces (or
  // the required-role fill) went on to actually find must not be reported as
  // a create-target.
  const createNote = buildCreateTargetNote(query, seededSurfaces, workspace);
  const result: TaskPackResult = {
    mode: "task_pack",
    coverage: coverageStr,
    ...(coverageReason ? { coverage_reason: coverageReason } : {}),
    surfaces: seededSurfaces,
    missing: allMissing,
    required_surfaces: requiredRoles,
    ...(missingRequired.length > 0 ? { missing_required_surfaces: missingRequired } : {}),
    route,
    checks: checkLines,
    verify: discoverVerificationHints(workspace, query, seededSurfaces),
    ...(nextHint ? { next: nextHint } : {}),
    ...(createNote ? { create_note: createNote } : {}),
  };

  // A caller that already knows the artifact and implementation paths should
  // receive the same one-turn artifact_build contract as the pathless
  // specialized builder. Previously paths[] forced the generic seeded branch:
  // artifact handles were appended only at the final wire choke point, no
  // section was extracted, yet route/change_contract still claimed ready.
  // That contradictory shape produced coverage=complete + edit_from_handles +
  // execution_contract=awaiting-input in the T10 Claude run.
  if (selectedProfile === "artifact_build" && seededArtifacts.length === 0) {
    const discovered = new Map<string, DiscoveredArtifactFile>();
    for (const entry of entries) {
      for (const file of discoverArtifactFiles(workspace, { path: entry.path, query })) {
        discovered.set(file.relPath, file);
      }
    }
    const ranked = [...discovered.values()].sort((a, b) =>
      artifactBuildRelevance(b, args, query) - artifactBuildRelevance(a, args, query)
        || a.relPath.localeCompare(b.relPath)
    );
    for (const file of ranked.slice(0, MAX_SURFACES_DISTINCT)) {
      const minted = mintArtifactSurface(file, workspace, args);
      if (minted) seededArtifacts.push(minted);
    }
  }
  if (selectedProfile === "artifact_build" && seededArtifacts.length > 0) {
    const explicitFileTokens = (query.match(/[A-Za-z_$][A-Za-z0-9_$.-]*\.(?:c|cc|cpp|cxx|go|java|js|jsx|py|rs|ts|tsx)\b/gi) ?? [])
      .map((fileName) => normIdent(path.basename(fileName, path.extname(fileName))));
    const explicitTargetTokens = new Set([
      ...moduleShapedQueryTokens(query).map((token) => normIdent(token)),
      ...explicitFileTokens,
    ]);
    let explicitTargets = seededSurfaces.filter((surface) =>
      explicitTargetTokens.has(normIdent(path.basename(surface.path, path.extname(surface.path))))
    );
    if (explicitTargets.length === 0 && explicitTargetTokens.size > 0) {
      const hardScopes = (args.paths ?? []).map(normalizePathEntry).map((entry) => entry.path);
      const files = hardScopes.length > 0
        ? hardScopes.flatMap((scope) => walkCodeFiles(workspace, { subPath: scope }))
        : walkCodeFiles(workspace, args.path ? { subPath: args.path } : {});
      const exactFile = files.find((file) =>
        explicitTargetTokens.has(normIdent(path.basename(file.relPath, path.extname(file.relPath))))
      );
      if (exactFile) {
        const content = readCached(workspace, exactFile.relPath, cache);
        if (content !== undefined) {
          const target = await candidateToSurface({
            path: exactFile.relPath,
            line: 1,
            range: `1-${Math.max(1, countLines(content))}`,
            surface: classifySurface(exactFile.relPath),
            why: "query-identifier-implementation-match",
            confidence: 1,
            required: true,
          }, workspace, [], query, cache);
          seededSurfaces.unshift(target);
          explicitTargets = [target];
        }
      }
    }
    if (explicitTargets.length > 0) {
      for (const surface of explicitTargets) protectedSurfaces.add(surface);
      seededSurfaces.splice(0, seededSurfaces.length, ...explicitTargets);
    }
    if (!result.missing.includes("artifact-section")) result.missing.push("artifact-section");
    const bundle = await attachArtifactBuildSections(result, seededArtifacts, query, args);
    if (bundle.complete && seededSurfaces.length > 0) {
      result.coverage = "focused";
      result.coverage_reason = "single-site";
      if (explicitTargets.length > 0) {
        delete result.content_sufficiency;
        delete result.content_completeness;
      }
      result.route = {
        action: "edit_from_handles",
        reason: bundle.truncated
          ? "bounded artifact previews and caller-supplied implementation handles are bundled"
          : "artifact sections and caller-supplied implementation handles are bundled for editing",
        max_additional_tl_calls: 0,
      };
      delete result.continuation;
    }
  }

  // A1: seeded surfaces (see `protectedSurfaces` above) are protected from
  // removal — trimToCap may degrade their code to handle+skeleton under
  // budget pressure but must never drop the surface itself. Native-pair
  // siblings and locator-filled roles are NOT in `protectedSurfaces` and
  // stay droppable, same as any other pack.
  // Answer packs can prove an explicitly named identifier absent only after
  // scanning the bounded source universe. Register that fact before the shared
  // readiness contract is built; recording it after dedupe would leave the
  // current response permanently stuck at act-on-served-evidence.
  //
  // WP-N (eval-0929 §8): "absent" means no WHOLE-identifier occurrence in the
  // code universe nor in the find universe widened for absence
  // (`explicitIdentifierAbsence`). This scan used to be a code-only SUBSTRING
  // test, so it was wrong both ways: `X_V2` in code made X "present", and X
  // written whole only in a doc this pack did not serve made it "absent" —
  // proving `identifier:X` with nothing on the certificate to say so.
  const identifierAbsences = proofCompletionEnabled() && answerProfile
    ? explicitIdentifierAbsences(workspace, explicitCodeIdentifiers(query), () => resultAbsenceUniverse(workspace, result), cache)
    : new Map<string, ExplicitIdentifierAbsence>();
  const verifiedAbsent = [...identifierAbsences.keys()];
  if (verifiedAbsent.length > 0) {
    recordVerifiedAbsentIdentifiers(result, verifiedAbsent);
    recordIdentifierAbsences(result, identifierAbsences);
  }
  // WP-O: computed before the facet plan (see there); recorded before the
  // certificate is built.
  recordSameNameSubjects(result, seededSameName);
  attachPartialTree(result, workspace, unresolvedFileParents);
  // WP-S2 rule 2 (TL_SEEDED_GENEROUS): claim the additive tier for a pack whose
  // caller named >= 2 files this build decided to serve whole. Marked HERE, the
  // last point before `dedupeTrimAndPersist` hands this exact object to
  // `trimToCap`, whose `fitsInCap` -> `capForResult` chain is the only reader.
  if (seededGenerousBudgetTier) markSeededGenerousPack(result, seededGenerousTierBytes);
  const finalResult = await dedupeTrimAndPersist(workspace, result, {
    ...(protectedSurfaces.size > 0 ? { protectedSurfaces } : {}),
    query,
    checkRecords,
    args,
    // DESIGN-v0.9 §4.3: recompute next/route if trimToCap flips coverage.
    recompute: { query, missingRequired, unmatchedConcern },
    // DESIGN-v0.9 §4.6b: share the pack's read cache for codeless-surface inlining.
    cache,
  });
  if (verifiedAbsent.length > 0) {
    recordVerifiedAbsentIdentifiers(finalResult, verifiedAbsent);
    recordIdentifierAbsences(finalResult, identifierAbsences);
  }
  recordSameNameSubjects(finalResult, seededSameName);
  // V15-NBR/FUI (2026-09-29): default-OFF prototypes, after `dedupeTrim-
  // AndPersist` (the generic pack's own single booking pass, above) has
  // fixed the final surface set. Both only ever ADD `result.neighbours`/
  // `result.usages` — see frontierNeighbours.ts/usageInventory.ts's module
  // doc comments. Flags OFF (default): byte-identical to pre-V15-NBR/FUI
  // output.
  attachPlanAids(finalResult, workspace, query);
  return finalResult;
}
