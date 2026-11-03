// partialPackBuilder — extracted implementation; imports point to the owning modules.
import * as path from "path";
import type { CoverageObligationV2 } from "../coveragePackerV2.js";
import type { ImpactCandidate } from "@tokenlighten/types";
import type { ImpactSurface } from "@tokenlighten/types";
import type { LocateCandidateDetail } from "@tokenlighten/types";
import type { RankedDetail } from "./partialPackBuilder.js";
import type { TaskPackArgs } from "../model.js";
import type { TaskPackResult } from "../model.js";
import type { TaskPackSurface } from "../model.js";
import { FileReadCache } from "./packBasics2.js";
import { MAX_SURFACES_DISTINCT } from "./packBasics2.js";
import { MAX_SURFACE_CODE_BYTES } from "./packBasics2.js";
import { SIBLING_SEED_WEAK_WHY } from "../../locator/locateTaskContext.js";
import { SURFACE_ROLE_PRIORITY } from "./partialPackBuilder.js";
import { applyDominancePromotion } from "./coverageAndContinuation.js";
import { attachPartialTree } from "./surfaceMaterialization.js";
import { attachPlanAids } from "./packTrimming2.js";
import { augmentConcernGroupSurfaces } from "./coverageAndContinuation.js";
import { augmentMissingRequiredRoleSurfaces } from "./queryIntent.js";
import { augmentNativeIdentifierCooccurrenceSurface } from "./queryIntent.js";
import { augmentNativeSurfaceClosure } from "./queryIntent.js";
import { augmentNativeWiringSurface } from "./queryIntent.js";
import { augmentQueryNamedFileSurfaces } from "./queryIntent.js";
import { augmentStyleSurface } from "./queryIntent.js";
import { buildBlockingNextSteps } from "./coverageAndContinuation.js";
import { buildCompletionChecks } from "./contractReconciliation.js";
import { buildRoute } from "./coverageAndContinuation4.js";
import { buildSeededTaskPack } from "./seededPackBuilder.js";
import { candidateToSurface } from "./surfaceMaterialization.js";
import { captureServedPack } from "./packState4.js";
import { compareDetails } from "./partialPackBuilder.js";
import { computePackFingerprint } from "./packState2.js";
import { concernGroupsForQuery } from "./roleAndConcernScope3.js";
import { continuationQuery } from "./coverageAndContinuation.js";
import { coveragePackerEnabled } from "../../../util/flags.js";
import { coveragePackerV2Enabled } from "../../../util/flags.js";
import { dedupeTrimAndPersist } from "./packSettlement.js";
import { definitionVsDerivedAdjustment } from "./partialPackBuilder.js";
import { discoverVerificationHints } from "./surfaceMaterialization.js";
import { estimateBodyBytes } from "../coveragePacker.js";
import { finalizePrimarySurface } from "./createAndWiringEndpoints2.js";
import { getFunctionalValidationObligation } from "../../../util/packServeLog.js";
import { hasRequestedMutationIntent } from "./coverageAndContinuation3.js";
import { isEnumLikeQuery } from "../../../util/queryShape.js";
import { isMultiSurfaceQuery } from "./partialPackBuilder.js";
import { isWithinRoleSearchScope } from "../../locator/locateTaskContext.js";
import { nextHintForCoverage } from "./coverageAndContinuation.js";
import { parseSurfaceSpan } from "./packState2.js";
import { perRoleCap } from "./partialPackBuilder.js";
import { promoteVariantSurfaces } from "./queryIntent.js";
import { protectedNamedPaths } from "../requestItems.js";
import { queryPriorPackObligations } from "../priorPackStore.js";
import { requiredSurfacesForTask } from "./roleAndConcernScope.js";
import { resolveDominantSurfaceIndex } from "./coverageAndContinuation.js";
import { roleSearchScopePrefixes } from "../../locator/locateTaskContext.js";
import { sameIdentityCandidates } from "./partialPackBuilder.js";
import { selectCoverageOrderedEntries } from "../coveragePacker.js";
import { selectCoverageOrderedEntriesV2 } from "../coveragePackerV2.js";
import { servedFindWindowHasUnservedLines } from "../../../state/session.js";
import { tokenizeForEpoch } from "../../../state/session.js";
import { trace } from "../../../util/trace.js";
import { uniqueExplicitIdentityCandidate } from "./partialPackBuilder.js";
import { uniqueSpelledDefinitionCandidate } from "./partialPackBuilder.js";
import { unmatchedConcernTokens } from "./roleAndConcernScope3.js";

export async function buildPartialPack(
  details: LocateCandidateDetail[],
  args: TaskPackArgs,
  query: string,
  workspace: string,
): Promise<TaskPackResult> {
  // 1. Drop only truly unusable candidates (generated/build outputs).
  // A surface classification of "unknown" is NOT a reason to drop a
  // candidate — classifySurface's role heuristics are necessarily
  // incomplete, and a candidate the locator was confident enough to
  // surface is still useful for the agent to inspect even if this pack
  // cannot name its role. Dropping it here previously caused the pack to
  // report a real, already-found file as a "missing required surface" and
  // send the agent on an unnecessary extra locate/task_pack call.
  // Stamp each candidate with its ORIGINAL locator rank (best-first) BEFORE any
  // reordering below, so confidence ties preserve the locator's ranking instead
  // of collapsing to path-alphabetical (which dropped the top-ranked file).
  // Efficiency: one per-pack read/parse memo shared across every file-touching
  // step (widen/slice/outline/tiny-clamp/preferDefinitionSites) — the same
  // detail path is otherwise re-read and re-parsed at each of them.
  const cache = new FileReadCache();
  const ranked: RankedDetail[] = details.map((d, i) => ({ ...d, __rank: i }));
  const filtered = ranked.filter((d) => !/\/(dist|build|__pycache__|node_modules)\//.test(d.path));
  // Item 9: boost definition sites / demote pure-derivation sites before
  // picking the "best per role" candidate below.
  const boosted = preferDefinitionSites(workspace, query, filtered, cache);
  // Collapse duplicate candidateDetails that point at the SAME file (the
  // locator commonly returns the same path several times at different line
  // ranges). Keeping the single highest-confidence entry per path frees the
  // per-role budget for genuinely distinct files instead of spending it on
  // repeats of one file — important for multi-file (C2) fix packs.
  const bestByPath = new Map<string, RankedDetail>();
  for (const d of boosted) {
    const existing = bestByPath.get(d.path);
    if (!existing || d.confidence > existing.confidence) bestByPath.set(d.path, d);
  }
  const pool = [...bestByPath.values()];

  // A locator abstain can mix a strong code-identity hit with prose-only
  // decoys. For example, a user-spelled `(Compute)` symbol can lose to an API
  // error string that merely repeats the requested account-type names. When
  // exactly one distinct candidate path has an exact symbol/basename identity
  // match, ambiguity is resolved by repository identity rather than text
  // density. Re-enter the normal seeded pipeline so readiness, caps, handles,
  // and closure remain identical to an explicit caller-provided path.
  //
  // This deliberately does not guess when two paths define the same requested
  // identity: those remain a candidate-list for the caller to disambiguate.
  //
  // A prose-cased name the request spells mid-clause ("Fix Sum so …") is no
  // explicit identifier; it settles the target the same way only for a
  // request that asks for the change, when exactly one candidate declares it
  // and no other implementation file defines it (`namedCallableDefinitions`,
  // the generic route's own single-primary rule).
  const identityMatch = uniqueExplicitIdentityCandidate(pool, query)
    ?? await uniqueSpelledDefinitionCandidate(pool, query, workspace, cache);
  if (identityMatch !== undefined) {
    const { candidate: matched, exactSymbol } = identityMatch;
    const result = await buildSeededTaskPack({
      ...args,
      path: undefined,
      symbol: undefined,
      paths: [{
        path: matched.path,
        ...(exactSymbol ? { symbol: matched.symbol } : {}),
      }],
      autoDiscoveredLocation: true,
    }, query, workspace);
    // buildSeededTaskPack captures the internal identity-seeded request.
    // Replace that cache key with the caller's original ambiguous/pathless
    // request so a retry remains a compact, stable pack-unchanged response.
    captureServedPack(workspace, args, computePackFingerprint(args, workspace), result);
    return result;
  }

  // 2. Group by surface role. A single-target task keeps exactly the best
  //    candidate per role (compact, handle-first). A MULTI-SURFACE task
  //    (e.g. "fix the checksum overflow AND the parser sign AND the scheduler
  //    mutex") legitimately needs several same-role files — three separate
  //    domain-logic fixes all classify as "domain", so a strict one-per-role
  //    map would surface only one of them and hide the rest. Keep up to a
  //    small, bounded number of high-confidence candidates per role in that
  //    case (C2), still capped overall by MAX_SURFACES_DISTINCT and the pack
  //    byte cap. Selection is deterministic: confidence desc, then path asc.
  const multiSurface = isMultiSurfaceQuery(query);
  const byRoleList = new Map<string, RankedDetail[]>();
  for (const d of pool) {
    const list = byRoleList.get(d.surface);
    if (list) list.push(d);
    else byRoleList.set(d.surface, [d]);
  }

  // 3. Sort roles by priority, and within each role keep up to K candidates.
  const sortedRoles = [...byRoleList.keys()].sort(
    (a, b) => (SURFACE_ROLE_PRIORITY[a] ?? 9) - (SURFACE_ROLE_PRIORITY[b] ?? 9)
  );
  const topRole = sortedRoles[0];
  const sortedEntries: Array<[string, RankedDetail]> = [];
  for (const role of sortedRoles) {
    const perRole = multiSurface ? perRoleCap(role, topRole) : 1;
    const ranked = [...(byRoleList.get(role) ?? [])].sort(compareDetails);
    for (const detail of ranked.slice(0, perRole)) {
      sortedEntries.push([role, detail]);
    }
  }
  // Every candidate that is the requested identity stays one: two files
  // defining the named callable are the choice the pack asks the caller to
  // make, and the one-per-role compaction above kept only the first (gauge
  // fixture, 2026-10-17: "Fix Sum so drains count down." beside a stats.Sum
  // listed meter/sum.go alone).
  for (const detail of sameIdentityCandidates(pool, query)) {
    if (sortedEntries.length >= MAX_SURFACES_DISTINCT) break;
    if (sortedEntries.some(([, entry]) => entry.path === detail.path)) continue;
    sortedEntries.push([detail.surface, detail]);
  }

  // 4. Build surfaces, capped at MAX_SURFACES_DISTINCT.
  const surfaces: TaskPackSurface[] = [];
  const coveredRoles = new Set<string>();
  const seenPaths = new Set<string>();
  // DESIGN-v0.8 coverage-honesty: scope ui/style requirement to the abstain
  // candidates' dominant root (the located set for this partial pack).
  const requiredRoles = requiredSurfacesForTask(
    query, workspace, args.surfaceRoles, details.map((d) => d.path),
  );

  // -------------------------------------------------------------------------
  // V10-09 SEAM (TL_COVERAGE_PACKER, default OFF) — the ONE place in this file
  // where a ranked candidate list becomes the served set.
  //
  // OFF: `sortedEntries` above is served verbatim, so the pack stays
  // byte-identical to the relevance-first behaviour the wire baselines and the
  // replay corpus pin. There is no second branch anywhere downstream.
  //
  // ON: the same pool is re-selected for coverage-per-token by
  // `coveragePacker.ts`, which consumes this task's own state DIRECTLY — the
  // query's concern clauses, the cross-call functional-validation obligation,
  // the served-range ledger, and the required roles computed just above. It
  // never reads the advisory reasoning IR. Selection happens BEFORE the
  // downstream budget ladder and does not touch its per-kind required sets.
  // -------------------------------------------------------------------------
  let packedEntries = sortedEntries;
  if (coveragePackerEnabled()) {
    const concernGroups = concernGroupsForQuery(query);
    const concernVocabulary = [...new Set(concernGroups.flatMap((group) => group.tokens))];
    const validation = getFunctionalValidationObligation(workspace, tokenizeForEpoch(query));
    const requestedPaths = [
      ...(args.path !== undefined ? [args.path] : []),
      ...(args.paths ?? []).map((entry) => (typeof entry === "string" ? entry : entry.path)),
    ];
    const queryLower = query.toLowerCase();
    // Shared by both the v1 and v2 (V11-03) branches below — same projection,
    // same base context, so the two selections stay directly comparable and
    // this seam's diff stays a branch, not a duplicated pipeline.
    const coverageProjection = {
      path: (d: RankedDetail) => d.path,
      role: (d: RankedDetail) => d.surface,
      rank: (d: RankedDetail) => d.__rank,
      confidence: (d: RankedDetail) => d.confidence,
      bytes: (d: RankedDetail) => estimateBodyBytes(d.range, cache.read(workspace, d.path), MAX_SURFACE_CODE_BYTES),
      // A direct reference: the caller named the path, or the query names the
      // file itself. Both are shed-forbidden at pack level.
      direct: (d: RankedDetail) => requestedPaths.includes(d.path)
        || queryLower.includes(path.basename(d.path).toLowerCase())
        || queryLower.includes(path.basename(d.path, path.extname(d.path)).toLowerCase()),
      priorServed: (d: RankedDetail) => {
        const span = parseSurfaceSpan(d.range);
        return span !== undefined
          && !servedFindWindowHasUnservedLines(workspace, d.path, span.start, span.end);
      },
      concernTokens: (d: RankedDetail) => {
        const haystack = `${d.path} ${d.symbol ?? ""} ${d.why}`.toLowerCase();
        return concernVocabulary.filter((token) => haystack.includes(token.toLowerCase()));
      },
      // V11-03: symbol name feeds coveragePackerV2's concern classification
      // and overload dedup-exemption inference. No effect on the v1 call
      // below — v1's projection type does not read this field.
      symbol: (d: RankedDetail) => d.symbol,
    };
    const coverageBaseContext = {
      requiredRoles,
      requiredPaths: [
        ...requestedPaths,
        ...(validation !== undefined ? [validation.targetPath] : []),
      ],
      concerns: concernGroups.map((group, index) => ({ id: `concern-${index + 1}`, tokens: group.tokens })),
      byteBudget: MAX_SURFACE_CODE_BYTES * 2,
      hasWriteFrontier: hasRequestedMutationIntent(query),
    };
    const functionalValidationObligation = validation !== undefined
      ? [{ id: "functional-validation", open: true, required: true, paths: [validation.targetPath] }]
      : [];
    // V11-03 (TL_COVERAGE_PACKER=v2 — see util/flags.ts's "V11-03
    // addendum"): coveragePackerV2 additionally folds in the OPEN
    // change_contract obligations the SECOND seam (dedupeTrimAndPersist,
    // below) recorded for this task from a PRIOR pack, via priorPackStore.
    // This is the read half of the obligation-threading loop the second seam
    // writes; a first pack in a task (nothing recorded yet) sees an empty
    // list here and behaves exactly like a fresh v2 selection.
    if (coveragePackerV2Enabled()) {
      const priorObligations: CoverageObligationV2[] = queryPriorPackObligations(
        workspace, tokenizeForEpoch(query),
      ).map((o) => ({
        id: `prior:${o.id}`,
        open: o.open,
        required: o.required,
        roles: [o.role],
        paths: [o.path],
      }));
      const packedV2 = selectCoverageOrderedEntriesV2(pool, coverageProjection, {
        ...coverageBaseContext,
        obligations: [...functionalValidationObligation, ...priorObligations],
      });
      if (packedV2.entries.length > 0) packedEntries = packedV2.entries;
      // Trace-only (util/trace.ts self-gates on TL_TRACE) — never wired, per
      // coveragePackerV2.ts's module header and this workstream's brief.
      trace("coverage_packer_v2_decision", {
        level: packedV2.output.level,
        stop_reason: packedV2.output.stopReason,
        fallback_to_v1: packedV2.output.fallbackToV1,
        body_count: packedV2.output.body.length,
        inventory_count: packedV2.output.inventory.length,
        concern_coverage: packedV2.output.concernCoverage,
        complementarity_promotions: packedV2.output.complementarityPromotions.length,
        prior_obligations: priorObligations.length,
      }, workspace);
    } else {
      const packed = selectCoverageOrderedEntries(pool, coverageProjection, {
        ...coverageBaseContext,
        obligations: functionalValidationObligation,
      });
      // An empty selection would be a silently emptied pack; fall back to the
      // relevance-first order rather than serve nothing.
      if (packed.entries.length > 0) packedEntries = packed.entries;
    }
  }

  // Convert each selected (role, detail) pair to an ImpactCandidate and
  // delegate to the SAME candidateToSurface used by buildSeededTaskPack,
  // instead of re-implementing range widening, handle minting, the embed
  // gate, likely_edits, and outline inline a second time (this path and
  // buildSeededTaskPack's had already drifted once — the B4 tiny-file
  // clamp needed patching in both independently). LocateCandidateDetail has
  // no `required` field of its own; candidateToSurface derives `required`
  // from `requiredRoles.includes(candidate.surface)` (OR'd with
  // `candidate.required`, left unset here), which is exactly this loop's
  // own `required` calculation, so passing requiredRoles through has the
  // identical effect.
  for (const [role, detail] of packedEntries) {
    if (surfaces.length >= MAX_SURFACES_DISTINCT) break;
    // Multiple same-role candidates may share a path (e.g. two hits in the
    // same file at different ranges); keep the pack's one-surface-per-path
    // invariant regardless of the per-role expansion above.
    if (seenPaths.has(detail.path)) continue;
    seenPaths.add(detail.path);
    const candidate: ImpactCandidate = {
      path: detail.path,
      line: detail.line,
      range: detail.range,
      ...(detail.symbol ? { symbol: detail.symbol } : {}),
      surface: role as ImpactSurface,
      why: detail.why,
      confidence: detail.confidence,
      handle: detail.handle,
    };
    surfaces.push(await candidateToSurface(candidate, workspace, requiredRoles, query, cache));
    coveredRoles.add(role);
  }
  const protectedSurfaces = new Set<TaskPackSurface>();
  // B1a (2026-08-01 retrieval-scope): anchors = the abstain candidates this
  // pack was built from, snapshotted BEFORE any augmenter appends its own pick.
  const partialAnchorPaths = surfaces.map((s) => s.path);
  await augmentConcernGroupSurfaces(surfaces, query, workspace, requiredRoles, cache, protectedSurfaces);
  await augmentNativeSurfaceClosure(surfaces, workspace, query, requiredRoles, cache);
  await augmentNativeWiringSurface(surfaces, workspace, cache);
  await augmentNativeIdentifierCooccurrenceSurface(surfaces, workspace, query, requiredRoles, cache);
  // Item 1: resolve a REQUIRED "style" role to a NAMED surface (handle + code).
  await augmentStyleSurface(surfaces, query, workspace, requiredRoles, cache, partialAnchorPaths);
  // FIX-B2: attempt every OTHER still-missing required role in this SAME
  // call — see augmentMissingRequiredRoleSurfaces's doc comment for the
  // surfaceRoles-retry root cause this closes.
  await augmentMissingRequiredRoleSurfaces(surfaces, query, workspace, requiredRoles, cache, undefined, partialAnchorPaths);
  // B1c (2026-08-01 retrieval-scope): the abstain-candidate flow is exactly the
  // one that ships candidate LISTS, so a file the query names by name must be
  // in that list content-bearing — see augmentQueryNamedFileSurfaces (T05c).
  await augmentQueryNamedFileSurfaces(surfaces, query, workspace, requiredRoles, cache, protectedSurfaces);
  for (const surface of surfaces) {
    coveredRoles.add(surface.role);
  }
  // DESIGN-v0.8 coverage-honesty (Part 5 B-1): promote a config/data/doc
  // surface whose already-read content already names the enum's new value.
  promoteVariantSurfaces(surfaces, query, workspace, cache);
  finalizePrimarySurface(surfaces);

  // 5. Determine missing roles.
  // `missing` uses a broader heuristic (fall back to contract/api/domain when
  // nothing was explicitly required) so coverage can still read "partial" when
  // a common role is uncovered. But the REQUIRED framing must stay
  // self-consistent: missing_required_surfaces must always be a subset of
  // required_surfaces. When requiredRoles is empty, nothing is required, so
  // missing_required_surfaces must be empty too — reporting
  // required_surfaces:[] alongside missing_required_surfaces:["api"] is a
  // contradiction (the field claims "api" is required-and-missing when no
  // role was required at all).
  const allExpected = requiredRoles.length > 0 ? requiredRoles : ["contract", "api", "domain"];
  const missing = allExpected.filter((r) => !coveredRoles.has(r));
  const missingRequired = missing.filter((r) => requiredRoles.includes(r));

  // DESIGN-v0.8 coverage-honesty: this path was reached via the locator's
  // AMBIGUOUS abstain — the primary target was never confidently resolved, so
  // the pack is always "partial", never "complete"/"focused" (it stopped
  // claiming complete-when-nothing-missing, which was the self-contradiction
  // the taxonomy closes). The reason names WHAT is unresolved, in the same
  // precedence buildRoute itself uses so the label and route agree:
  //   missing required role → "missing-roles" (route: locate_missing_surfaces)
  //   else unmatched concern → "concerns-uncovered" (route: locate_missing_surfaces)
  //   else → "candidate-list" (route: confirm_candidates), UNLESS one ranked
  //     surface strictly dominates the rest on role/evidence/source-ness (see
  //     `resolveDominantSurfaceIndex`'s doc comment, issue #3) — a genuinely
  //     resolved choice is not an open one. The reason is then dropped
  //     (coverage stays "partial", never "focused"/"complete": those would
  //     suppress `frontier_index`, and the dominated candidate must stay
  //     inventoried) and `buildRoute` falls through past its "candidate-list"
  //     branch to the plain partial-coverage route below, unmodified.
  const unmatchedConcern = unmatchedConcernTokens(query, surfaces);
  const coverageStr = "partial" as const;
  // A candidate the request explicitly protects ("Keep src/b.ts unchanged")
  // is context, not a choice: when it leaves exactly one candidate, that one
  // is resolved. The 2026-10-16 bench's "Change batch … in src/limits.mjs.
  // Keep max at 24 and src/window.mjs unchanged." otherwise asked the caller
  // to choose between the two files (choose-candidate).
  const protectedPaths = protectedNamedPaths(query);
  const unprotectedSurfaces = surfaces.flatMap((surface, index) => (protectedPaths.has(surface.path) ? [] : [index]));
  const dominantAbstainSurface = missingRequired.length === 0 && unmatchedConcern.length === 0
    ? protectedPaths.size > 0 && unprotectedSurfaces.length === 1 && surfaces.length > 1
      ? unprotectedSurfaces[0]!
      : resolveDominantSurfaceIndex(surfaces)
    : -1;
  const coverageReason: TaskPackResult["coverage_reason"] =
    missingRequired.length > 0
      ? "missing-roles"
      : unmatchedConcern.length > 0
        ? "concerns-uncovered"
        : dominantAbstainSurface !== -1
          ? undefined
          : "candidate-list";

  // A4: route now depends on coverage/allMissing/query, so it can flip to
  // locate_missing_surfaces on unmatched CONCERN tokens (or confirm_candidates
  // on a candidate-list) even though `next` below points at the returned
  // handles first — blocking_next_steps carries the per-token follow-up when
  // the flip fires.
  const route = buildRoute(surfaces, missingRequired, coverageStr, missing, query, coverageReason);
  // 6. Build next hint — coverage-driven (candidate-list batches the ranked
  // handles; a missing-roles flip re-locates the role; concerns-uncovered
  // finds the token), falling back to a bare locate only when no surface
  // exists at all.
  const next = nextHintForCoverage(
    surfaces, coverageStr, coverageReason, query, missingRequired, unmatchedConcern,
  ) ?? { tool: "tl_search_files", arguments: { action: "locate", query: continuationQuery(query) } };
  // blocking_next_steps was previously ALWAYS dropped here (item 3): route
  // honesty (A4) now populates it, but ONLY when the route actually flipped
  // to locate_missing_surfaces AND there is real per-token content (the
  // flip can also come from missingRequired alone, in which case
  // unmatchedConcernTokens is empty and a vacuous [] must not serialize).
  const blockingNextSteps = route.action === "locate_missing_surfaces"
    ? buildBlockingNextSteps(query, surfaces)
    : [];

  const { lines: checkLines, records: checkRecords } = buildCompletionChecks(query, surfaces, missing, workspace, unmatchedConcern);
  const result: TaskPackResult = {
    mode: "task_pack",
    coverage: coverageStr,
    coverage_reason: coverageReason,
    surfaces,
    missing,
    required_surfaces: requiredRoles,
    ...(missingRequired.length > 0 ? { missing_required_surfaces: missingRequired } : {}),
    route,
    ...(blockingNextSteps.length > 0 ? { blocking_next_steps: blockingNextSteps } : {}),
    checks: checkLines,
    verify: discoverVerificationHints(workspace, query, surfaces),
    next,
  };
  if (dominantAbstainSurface !== -1) {
    applyDominancePromotion(result, surfaces, dominantAbstainSurface, workspace);
  }

  attachPartialTree(result, workspace);
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
  // V15-NBR/FUI (2026-09-29): same default-OFF prototypes as buildAnswer-
  // TaskPack/buildSeededTaskPack's tails — see frontierNeighbours.ts/
  // usageInventory.ts's module doc comments.
  attachPlanAids(finalResult, workspace, query);
  return finalResult;
}

/**
 * For enum-like queries, adjust each candidate's confidence so that a
 * DEFINITION site consistently outranks a DERIVED site that happens to
 * share the same surface role and text-match the query — without this,
 * `z.enum(Object.values(TicketPriority))` (which needs no edit at all when
 * a value is added) can outscore the actual `enums.ts` declaration purely
 * because the query's literal tokens appear more densely near the derived
 * usage site.
 */
export function preferDefinitionSites<T extends { path: string; line: number; symbol?: string; confidence: number }>(
  workspace: string,
  query: string,
  candidates: T[],
  cache?: FileReadCache,
): T[] {
  if (!isEnumLikeQuery(query)) return candidates;
  return candidates.map((c) => {
    if (c.symbol) return c; // exact symbol hits are already precise; leave as-is
    const adjustment = definitionVsDerivedAdjustment(workspace, c.path, c.line, cache);
    if (adjustment === 0) return c;
    const delta = adjustment > 0 ? 0.25 : -0.35;
    return { ...c, confidence: Math.max(0, Math.min(1, c.confidence + delta)) };
  });
}

export function candidatePathKey(c: ImpactCandidate): string {
  return c.path;
}

// Generic architectural-role vocabulary only — deliberately excludes any
// domain-specific protocol/algorithm acronym (e.g. a wire-protocol name or
// an estimator algorithm's initialism), which would only ever match one
// project's vocabulary instead of a general directory/file naming pattern.
export function closureSlot(c: ImpactCandidate): string {
  const base = path.basename(c.path).toLowerCase();
  const dir = path.dirname(c.path).toLowerCase();
  if (/(admin|stats|aggregate)/.test(base + dir)) return `${c.surface}:admin`;
  if (/(search|query|filter)/.test(base + dir)) return `${c.surface}:search`;
  if (/(repository|repo|store)/.test(base + dir)) return `${c.surface}:repository`;
  if (/(transition|state|lifecycle)/.test(base + dir)) return `${c.surface}:state`;
  if (/(route|controller|handler)/.test(base + dir)) return `${c.surface}:route`;
  return `${c.surface}:${base.replace(/\.[^.]+$/, "")}`;
}

export function isClosureImportant(c: ImpactCandidate): boolean {
  // "import-edge": the definition the primary DELEGATES TO (locator issue #2).
  // It shares the primary's role by construction — a callee usually sits in
  // its caller's layer — so the role-diversity pass above can never reach it,
  // and without this it would be found and then silently dropped.
  if (["structural", "enum-family", "presentation-family", "import-edge"].some((w) => c.why.includes(w))) {
    return true;
  }
  return /(admin|stats|aggregate|search|filter|repository|transition|lifecycle|route|controller|handler)/i.test(c.path);
}

export function compareCandidates(a: ImpactCandidate, b: ImpactCandidate): number {
  const roleDiff = (SURFACE_ROLE_PRIORITY[a.surface] ?? 9) - (SURFACE_ROLE_PRIORITY[b.surface] ?? 9);
  if (roleDiff !== 0) return roleDiff;
  const confidenceDiff = b.confidence - a.confidence;
  if (Math.abs(confidenceDiff) > 0.001) return confidenceDiff;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

export function selectClosureCandidates(
  allCandidates: ImpactCandidate[],
  primaryPaths: readonly string[] = [],
): ImpactCandidate[] {
  const sorted = [...allCandidates].sort(compareCandidates);
  const selected: ImpactCandidate[] = [];
  const selectedPaths = new Set<string>();
  const selectedRoles = new Set<string>();
  const selectedSlots = new Set<string>();

  function add(c: ImpactCandidate): void {
    if (selected.length >= MAX_SURFACES_DISTINCT) return;
    const pathKey = candidatePathKey(c);
    if (selectedPaths.has(pathKey)) return;
    selected.push(c);
    selectedPaths.add(pathKey);
    selectedRoles.add(c.surface);
    selectedSlots.add(closureSlot(c));
  }

  // R0 (2026-08-21, W4-A pack-augmentation-pollution forensics): a candidate
  // reached only through weak evidence (SIBLING_SEED_WEAK_WHY — a plain
  // full-text/variant/reference hit, never a targeted symbol/name/filename
  // match) AND sitting outside the primary's own project root must not win a
  // surface ROLE SLOT merely because nothing else offers that role. Before
  // this fix, the diversity passes below picked the best-scoring candidate
  // per role/slot unconditionally — including one the out-of-root demotion
  // pass in locateTaskContext.ts had already driven to (near) zero
  // confidence. "One representative of every role" is not evidence the role
  // is genuinely covered; an honestly-missing role (surfaced downstream by
  // requiredSurfacesForTask/missing_required_surfaces) is the correct
  // outcome when only worthless evidence exists for it. Scoped to weak AND
  // out-of-root together, never either alone, so a genuine cross-package
  // symbol/filename hit still fills a role the primary's own root lacks.
  const scopePrefixes = roleSearchScopePrefixes(primaryPaths);
  const isTrustworthyRoleFiller = (c: ImpactCandidate): boolean =>
    !SIBLING_SEED_WEAK_WHY.has(c.why) || isWithinRoleSearchScope(c.path, scopePrefixes);

  for (const c of sorted) {
    if (!selectedRoles.has(c.surface) && isTrustworthyRoleFiller(c)) add(c);
  }

  for (const c of sorted) {
    if (selected.length >= MAX_SURFACES_DISTINCT) break;
    const slot = closureSlot(c);
    if (!selectedSlots.has(slot) && isClosureImportant(c) && isTrustworthyRoleFiller(c)) add(c);
  }

  return selected;
}
