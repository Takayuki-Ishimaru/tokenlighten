import { naturalProjectionForPack } from '../naturalTaskPackIntegration.js';
// epochContract — extracted implementation; imports point to the owning modules.
import type { EpochTaskContractObservation } from "./epochContract3.js";
import type { PersistedEvidenceExpansion } from "./epochContract3.js";
import type { TaskPackResult } from "../model.js";
import type { TaskProfile } from "@tokenlighten/types";
import { MAX_BATCH_NEXT_HANDLES } from "./coverageAndContinuation.js";
import { MAX_EPOCH_CONTRACT_DISCLOSURES } from "./epochContract2.js";
import { MAX_EVIDENCE_EXPANSION_TARGETS } from "./epochContract3.js";
import { MAX_SERVED_DEFINITION_SYMBOLS } from "./epochContract3.js";
import { SURFACE_ROLE_NAMES } from "./receiptRestoration2.js";
import { UNCOVERED_EPOCH_CONCERN_PREFIX } from "./epochContract2.js";
import { UNSERVED_EPOCH_ROLE_PREFIX } from "./epochContract2.js";
import { applyEpochTaskContractObservation } from "./epochContract3.js";
import { calleesOf } from "./packTrimming.js";
import { codeTaskPackSurfaces } from "../artifactSections.js";
import { concernAnchorTokens } from "./roleAndConcernScope3.js";
import { concernTokenMatchesSurfaces } from "./roleAndConcernScope3.js";
import { continuationQuery } from "./coverageAndContinuation.js";
import { enumeratedQueryItemsForEpoch } from "./readinessFalsification.js";
import { epochConcernTokensFor } from "./epochContract2.js";
import { epochServedEvidence } from "./epochContract2.js";
import { expandOneHop } from "../openUniverseExpansion.js";
import { explicitCodeIdentifiers } from "./anchorFocus2.js";
import { extractSymbolsFromLines } from "../../../tools/readCodeModes.js";
import { hasOpenUniverseIntent } from "../openUniverseIntent.js";
import { hasServedCode } from "./wiringEvidence2.js";
import { identifierShapedConcernSet } from "./roleAndConcernScope3.js";
import { isAdditiveEnumIntent } from "../openUniverseIntent.js";
import { isCandidateListPack } from "./recursiveClosure3.js";
import { isLiteralFirstSurfaceDuty } from "./changeAndReadinessEvidence.js";
import { languageForPath } from "../../../util/languages.js";
import { literalSurfaceDutyEvidence } from "./changeAndReadinessEvidence2.js";
import { mergeUnique } from "./roleAndConcernScope.js";
import { namedAuthorityFacetProofs } from "./changeAndReadinessEvidence.js";
import { projectCompletion } from "../canonicalDecision.js";
import { queryNamedWorkspaceFiles } from "./queryIntent3.js";
import { queryTaskContract } from "../taskContractStore.js";
import { recordServedConcernEvidence } from "../taskContractStore.js";
import { recordServedRoleEvidence } from "../taskContractStore.js";
import { servedSurfaceText } from "./changeAndReadinessEvidence2.js";
import { tokenizeForEpoch } from "../../../state/session.js";
import { trustworthySurfaceAnchorPaths } from "./queryIntent.js";

/**
 * B1b (2026-08-01 retrieval-scope): `coverage_reason:"missing-roles"` is a
 * claim ABOUT ROLES, so it must always NAME them.
 *
 * Live forensics (run 2026-07-31-semantic-signal5-2, T09 rep1/rep2): an
 * explicit-paths pack came back `coverage:"partial"` +
 * `coverage_reason:"missing-roles"` + `missing:[]` — a self-contradiction with
 * no recovery in it, and the solver had nothing to act on. The producing site
 * is refreshAfterRecursiveClosure, which FILTERS `missing` /
 * `missing_required_surfaces` down to the roles the closure did not cover but
 * only clears the REASON when the unmatched-concern list is empty too; the
 * "roles all covered, a concern token still unmatched" combination therefore
 * shipped the roles claim with nothing behind it. This is the same
 * empty-vs-absent family the 2026-07-31 next_call wave closed elsewhere, so it
 * is enforced HERE, once, at the shared exit — every flow reports identically.
 *
 * Repair order (never weakens an honest gap, never invents one):
 *   1. roles are named somewhere and still unserved → normalize
 *      `missing_required_surfaces` to exactly that set, so the claim and the
 *      role list agree. `missing` is deliberately NOT rewritten: several flows
 *      empty it on purpose once a stronger proof supersedes role bookkeeping
 *      (a ready wiring graph, cumulative coverage), and re-populating it there
 *      would resurrect a gap those flows just closed;
 *   2. nothing named anywhere and nothing else unresolved → the claim is simply
 *      false: drop it. Re-deriving a role set from `required_surfaces` was
 *      considered and rejected — every flow already computes
 *      missing_required_surfaces that way, so an EMPTY one means the flow
 *      decided nothing is missing, and manufacturing a gap it deliberately
 *      closed is a worse error than an unlabeled partial;
 *   3. `missing` still carries NON-role entries (an unreadable caller path, an
 *      unexpanded directory marker) → the label is imprecise but the pack does
 *      name its gap, which is what a caller needs to act on. Leave it: the
 *      invariant is "never a claim with nothing behind it", not a relabeling
 *      pass.
 */
export function reconcileMissingRolesContract(result: TaskPackResult): void {
  if (result.coverage_reason !== "missing-roles") return;
  const served = new Set(codeTaskPackSurfaces(result.surfaces).map((s) => s.role));
  const named = [...new Set([
    ...(result.missing_required_surfaces ?? []),
    ...result.missing.filter((entry) => SURFACE_ROLE_NAMES.has(entry)),
  ])].filter((role) => !served.has(role));
  if (named.length > 0) {
    result.missing_required_surfaces = named;
    return;
  }
  if (result.missing.length > 0) return;
  delete result.missing_required_surfaces;
  delete result.coverage_reason;
}

/**
 * Demote a pack that would certify against a universe smaller than the one its
 * own task epoch already established. Strictly tightening: it can only lower
 * `coverage` and add disclosures, never raise or remove either.
 */
export function reconcileEpochTaskContract(
  workspace: string,
  result: TaskPackResult,
  query: string,
  /** WP-S11: see `epochServedEvidence`'s own `profile` doc — the read-only serve view is answer-only. */
  profile?: TaskProfile,
): void {
  const epochTokens = tokenizeForEpoch(query);
  const stored = queryTaskContract(workspace, epochTokens);
  if (stored === undefined) return;
  const evidence = epochServedEvidence(workspace, result, epochTokens, profile);
  const covered = new Set([...stored.servedRoles, ...evidence.map((surface) => surface.role)]);
  recordServedRoleEvidence(workspace, [...covered]);
  // A BACKSTOP, not a second narrator. When this pack already names the gap in
  // the ordinary vocabulary — which is the normal case now that
  // `requiredSurfacesForTask` carries roles forward at inference time — there
  // is nothing left to repair, and restating it would only churn the response
  // bytes (declining the subset receipt whose whole claim is that nothing
  // changed). What survives this filter is exactly the wiped case: a branch
  // that cleared `missing` after the requirement was established.
  const alreadyDisclosed = [
    ...result.missing,
    ...(result.missing_required_surfaces ?? []),
    ...(result.blocking_next_steps ?? []),
    ...(result.checks ?? []),
  ].join("\n").toLowerCase();
  const unservedRoles = stored.requiredRoles
    .filter((role) => !covered.has(role) && !alreadyDisclosed.includes(role.toLowerCase()))
    .slice(0, MAX_EPOCH_CONTRACT_DISCLOSURES);
  const coveredConcerns = new Set(stored.coveredConcernTokens);
  const contractQuery = stored.query !== "" ? stored.query : query;
  const enumeratedItems = enumeratedQueryItemsForEpoch(contractQuery, workspace);
  const enumeratedById = new Map(enumeratedItems.map((item) => [item.id, item]));
  const enumeratedProofs = namedAuthorityFacetProofs(
    evidence,
    explicitCodeIdentifiers(contractQuery),
    enumeratedItems.map((item) => item.facet),
    workspace,
  );
  // Only the exact original query's semantic enumeration can use the
  // stronger natural operation/role proof. Carried unrelated obligations and
  // all authority, role and dependency gates keep their ordinary proof rules.
  const naturalProof = naturalProjectionForPack(result, workspace, contractQuery, profile ?? "generic");
  const naturalConcerns = naturalProof?.proved === true && naturalProof.ownedFacetClauses.has(contractQuery.trim())
    ? new Set(enumeratedItems.filter(item => item.start >= 0).map(item => item.id))
    : new Set<string>();
  const concernCoveredByEvidence = (token: string): boolean => {
    if (naturalConcerns.has(token)) return true;
    const item = enumeratedById.get(token);
    if (item === undefined) return concernTokenMatchesSurfaces(token, evidence);
    const proof = enumeratedProofs.get(item.facet);
    return proof === "served" || proof === "authoritative-absent";
  };
  const newlyServedConcerns = stored.concernTokens.filter(concernCoveredByEvidence);
  // Make the durable ledger agree with the evidence reconciliation before the
  // final contract is built.  A challenge may legitimately serve the second
  // of two same-epoch frontiers; retaining the first frontier's proof is what
  // makes their union terminal rather than an awaiting-input regression.
  recordServedConcernEvidence(workspace, newlyServedConcerns);
  newlyServedConcerns.forEach((token) => coveredConcerns.add(token));
  const uncoveredConcerns = stored.concernTokens
    .filter((token) =>
      !coveredConcerns.has(token)
      && !alreadyDisclosed.includes(token.toLowerCase())
      && !concernCoveredByEvidence(token))
    .slice(0, MAX_EPOCH_CONTRACT_DISCLOSURES);
  if (unservedRoles.length === 0 && uncoveredConcerns.length === 0) {
    // `buildTaskExecutionContract` is evaluated once before this reconciliation
    // and once for the final wire result.  Drop only its *derived* prior
    // projection here so the second evaluation can project the now-discharge
    // ledger.  User-facing missing evidence and explicit capability gaps stay
    // untouched.
    const discharged = new Set([
      ...[...covered].map((role) => `unresolved-ledger:required-role:${role}`),
      ...[...coveredConcerns].map((token) => `unresolved-ledger:concern-token:${token}`),
    ]);
    result.missing = result.missing.filter((entry) => !discharged.has(entry));
    if (
      result.coverage_basis === "cumulative"
      && result.missing.length === 0
      && (result.missing_required_surfaces?.length ?? 0) === 0
    ) {
      result.coverage = projectCompletion(result, [], { promoteWhenComplete: true }).coverage;
      delete result.coverage_reason;
    }
    return;
  }

  // The epoch's SOURCE query, not this narrowed call's — a continuation that
  // re-asks with the truncated text is the defect one file over.
  const sourceQuery = continuationQuery(contractQuery);
  result.missing = [...new Set([
    ...result.missing,
    ...unservedRoles.map((role) =>
      // WP-S11 (Part B) deliberately leaves BOTH spellings below alone: these
      // are not prose either. `canonicalDecision.ts`'s UNSERVED_EPOCH_ROLE_RE
      // / UNCOVERED_EPOCH_CONCERN_RE parse them back into `decision.next_call`
      // — the canonical, projected field the caller actually executes — so a
      // canonicalized spelling here would DELETE the recovery rather than
      // improve it (same ruling as `continuationQuery`'s own doc block).
      `${UNSERVED_EPOCH_ROLE_PREFIX}${role} (required by an earlier pack in this task;`
      + ` re-request via tl_read_file mode=task_pack query="${sourceQuery}" surfaceRoles=["${role}"])`),
    ...uncoveredConcerns.map((token) =>
      `${UNCOVERED_EPOCH_CONCERN_PREFIX}${token} (named by an earlier pack in this task;`
      + ` re-request via tl_search_files action=find query=${token})`),
  ])];
  if (unservedRoles.length > 0) {
    // These ARE roles, so they belong in the role fields too — that is what
    // makes the route/next machinery name them instead of guessing.
    result.required_surfaces = mergeUnique(result.required_surfaces ?? [], unservedRoles);
    result.missing_required_surfaces = mergeUnique(result.missing_required_surfaces ?? [], unservedRoles);
  }
  result.coverage = "partial";
  if (result.coverage_reason === undefined) {
    result.coverage_reason = unservedRoles.length > 0 ? "missing-roles" : "concerns-uncovered";
  }
}

/**
 * Compute the exact ordered task-contract observations for one finalized pack.
 * This performs bounded, read-only workspace inspection through the existing
 * surface-proof helpers (`namedAuthorityFacetProofs` may read source files;
 * this is not a claim that every helper is pure or memo-free). Prior
 * enumerated concerns are an explicit snapshot so this calculation does not
 * read or mutate the task-contract store.
 */
export function computeEpochTaskContractObservation(
  workspace: string,
  result: TaskPackResult,
  query: string,
  expansion?: PersistedEvidenceExpansion,
  literalSourceUniverse = false,
  priorConcernTokens: readonly string[] = [],
): EpochTaskContractObservation | undefined {
  const epochTokens = tokenizeForEpoch(query);
  if (epochTokens.length === 0) return undefined;
  const served = codeTaskPackSurfaces(result.surfaces).filter(hasServedCode);
  const shaped = identifierShapedConcernSet(query);
  const queryTokens = concernAnchorTokens(query, 8).filter((token) => shaped.has(token.toLowerCase()));
  const requestedSymbols = explicitCodeIdentifiers(query).slice(0, 1);
  const localExpansions: PersistedEvidenceExpansion[] = !hasOpenUniverseIntent(query)
    || isAdditiveEnumIntent(query)
    ? []
    : served.map((surface) => {
      const local = expandOneHop(
        languageForPath(surface.path) ?? "unknown",
        calleesOf(servedSurfaceText(surface), surface.symbol ? [surface.symbol] : requestedSymbols),
        MAX_EVIDENCE_EXPANSION_TARGETS,
      );
      return {
        targets: local.targets.map((entry) => entry.target),
        remaining: [...local.remaining],
        gaps: local.explicitGap === undefined ? [] : [local.explicitGap],
      } satisfies PersistedEvidenceExpansion;
    });
  const expansionParts = [expansion, ...localExpansions].filter(
    (entry): entry is PersistedEvidenceExpansion => entry !== undefined,
  );
  const effectiveExpansion = expansionParts.length === 0 ? undefined : {
    targets: [...new Set(expansionParts.flatMap((entry) => entry.targets))].sort((a, b) => a.localeCompare(b)),
    remaining: [...new Set(expansionParts.flatMap((entry) => entry.remaining))].sort((a, b) => a.localeCompare(b)),
    gaps: [...new Set(expansionParts.flatMap((entry) => entry.gaps))].sort((a, b) => a.localeCompare(b)),
  } satisfies PersistedEvidenceExpansion;
  const enumeratedItems = enumeratedQueryItemsForEpoch(query, workspace, priorConcernTokens);
  const literalSurfaceDuty = isLiteralFirstSurfaceDuty(query);
  const enumeratedProofs = namedAuthorityFacetProofs(
    served,
    explicitCodeIdentifiers(query),
    enumeratedItems.map((item) => item.facet),
    workspace,
  );
  const coveredEnumeratedIds = enumeratedItems
    .filter((item) => {
      if (literalSurfaceDuty) return literalSurfaceDutyEvidence(served, item.facet).length > 0;
      const proof = enumeratedProofs.get(item.facet);
      return proof === "served" || proof === "authoritative-absent";
    })
    .map((item) => item.id);
  const taskContract = Object.freeze({
    query,
    requiredRoles: Object.freeze([...(result.required_surfaces ?? [])]),
    concernTokens: Object.freeze([
      ...epochConcernTokensFor(result, query),
      ...(literalSurfaceDuty ? [] : enumeratedItems.map((item) => item.id)),
    ]),
    servedRoles: Object.freeze(literalSourceUniverse ? ["implementation"] : served.map((surface) => surface.role)),
    coveredConcernTokens: Object.freeze([
      ...queryTokens.filter((token) => concernTokenMatchesSurfaces(token, served)),
      ...(literalSurfaceDuty ? [] : coveredEnumeratedIds),
    ]),
  });
  const queryOwnIdentifiers = new Set(explicitCodeIdentifiers(query));
  const expansionTargets = literalSourceUniverse || !hasOpenUniverseIntent(query) || isAdditiveEnumIntent(query)
    ? []
    : [...(effectiveExpansion?.targets ?? [])].filter((target) => !queryOwnIdentifiers.has(target));
  const servedDefinitions = [...new Set([
    ...served.map((surface) => surface.symbol).filter((symbol): symbol is string => symbol !== undefined),
    ...served.flatMap((surface) => extractSymbolsFromLines(
      servedSurfaceText(surface),
      MAX_SERVED_DEFINITION_SYMBOLS,
      new Set(expansionTargets.map((target) => target.toLowerCase())),
    ).map((entry) => entry.name)),
  ])];
  const expansionObservation = Object.freeze({
    targets: Object.freeze(expansionTargets),
    servedDefinitions: Object.freeze(servedDefinitions),
  });
  const expansionGaps = !literalSourceUniverse && hasOpenUniverseIntent(query)
    ? [...new Set(effectiveExpansion?.gaps ?? [])].sort((a, b) => a.localeCompare(b))
    : [];
  const explicitGap = expansionGaps.length > 0 ? Object.freeze({
    parent: Object.freeze({kind: "dependency-definitions", target: "open-universe"}),
    targets: Object.freeze([...expansionTargets]),
    witness: expansionGaps.join("; "),
  }) : undefined;
  return Object.freeze({
    epochTokens: Object.freeze([...epochTokens]),
    query,
    taskContract,
    expansion: expansionObservation,
    literalSourceUniverse,
    ...(explicitGap === undefined ? {} : {explicitGap}),
    transition: expansionGaps.length > 0 || literalSourceUniverse,
  });
}

export function recordEpochTaskContract(
  workspace: string,
  result: TaskPackResult,
  query: string,
  expansion?: PersistedEvidenceExpansion,
  literalSourceUniverse = false,
): boolean {
  const epochTokens = tokenizeForEpoch(query);
  if (epochTokens.length === 0) return false;
  const priorConcernTokens = queryTaskContract(workspace, epochTokens)?.concernTokens ?? [];
  const observation = computeEpochTaskContractObservation(
    workspace, result, query, expansion, literalSourceUniverse, priorConcernTokens,
  );
  if (observation === undefined) return false;
  applyEpochTaskContractObservation(workspace, observation);
  return observation.transition;
}

/**
 * B1c (2026-08-01 retrieval-scope): a candidate-list pack's recovery must be
 * EXECUTABLE.
 *
 * buildRoute tells such a pack's caller "if required sites are missing from the
 * candidates, ONE tl_read_file {query, targets:[chosen + missing]} is sanctioned" — as
 * PROSE inside route.reason, which the caller has to parse and transcribe into
 * a call. Live forensics (run 2026-07-31-semantic-signal5-2, T05c rep0): the
 * caller never did; it re-issued the same query-only pack and got another
 * candidate list. Ship the call itself.
 *
 * Only fires when the pack is genuinely still short of something the caller
 * NAMED — a candidate list whose bodies are all served and whose query named
 * nothing unserved keeps today's no-`next` close (choosing IS the next act; a
 * `next` there would re-serve served handles, the 2026-07-19a T13 thrash).
 */
export function attachCandidateListRecovery(
  result: TaskPackResult,
  query: string,
  workspace: string,
): void {
  if (!isCandidateListPack(result)) return;
  if (result.next !== undefined) return;
  const candidateSurfaces = codeTaskPackSurfaces(result.surfaces);
  const served = new Set(candidateSurfaces.map((s) => s.path));
  // R0 (2026-08-21, W4-A): same root-disambiguation as augmentQueryNamedFileSurfaces.
  const unresolved = queryNamedWorkspaceFiles(query, workspace, trustworthySurfaceAnchorPaths(candidateSurfaces))
    .filter((rel) => !served.has(rel));
  if (unresolved.length === 0) return;
  const paths = [...new Set([...unresolved, ...served])].slice(0, MAX_BATCH_NEXT_HANDLES);
  result.next = {
    tool: "tl_read_file",
    arguments: { mode: "task_pack", query: continuationQuery(query), paths },
  };
}
