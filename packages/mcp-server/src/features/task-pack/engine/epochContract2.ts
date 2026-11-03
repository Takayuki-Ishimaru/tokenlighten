// epochContract — extracted implementation; imports point to the owning modules.
import * as path from "path";
import type { TaskPackArgs } from "../model.js";
import type { TaskPackResult } from "../model.js";
import type { TaskPackSurface } from "../model.js";
import type { TaskProfile } from "@tokenlighten/types";
import { MAX_FINGERPRINT_FILES } from "./packState2.js";
import { certifiedWorkingSets } from "./epochContract3.js";
import { codeTaskPackSurfaces } from "../artifactSections.js";
import { currentSessionLane } from "../../../util/laneKey.js";
import { epochServedSurfaceEntriesWithView } from "./epochEvidence.js";
import { epochsOverlap } from "./packState2.js";
import { hasOpenUniverseIntent } from "../openUniverseIntent.js";
import { isAdditiveEnumIntent } from "../openUniverseIntent.js";
import { laneScopedKey } from "../../../util/laneKey.js";
import { normalizedRequestPath } from "./guideAndArtifactSurfaces.js";
import { reconstructServedEntryEvidence } from "./epochContract3.js";
import { surfaceFileSha } from "./packState2.js";
import { tokenizeForEpoch } from "../../../state/session.js";
import { unmatchedConcernTokens } from "./roleAndConcernScope3.js";

// ---------------------------------------------------------------------------
// P0 defects 2 + 3 — the task epoch's PERSISTED requirement contract.
//
// `requiredSurfacesForTask` already carries the ROLE axis forward at inference
// time (its `carried` block), which is enough while the ordinary pipeline runs.
// It is NOT enough at the exit: `refreshAfterRecursiveClosure`'s wiring branch
// clears `missing` outright, `reconcileMissingRolesContract` can drop a label
// that no longer names anything, and the CONCERN axis never had any
// carry-forward at all. This is the fail-closed backstop for both axes at the
// one shared exit every flow passes through, so a NARROWED continuation cannot
// leave with `coverage:"complete"` — or a terminal certificate — while the
// epoch's own standing requirements are still unserved.
//
// The vocabulary is deliberately the existing one: coverage "partial",
// coverage_reason "missing-roles"/"concerns-uncovered", `missing[]`,
// `missing_required_surfaces[]`. The two markers below are disclosure NOTES in
// `missing[]` — the same shape (and same reason) as F-B3's
// `unserved-obligation:` note: a bare role name says nothing about WHERE the
// requirement came from, and canonicalDecision.ts needs an exact, narrow
// marker to demote THIS response's own certificate on.
// ---------------------------------------------------------------------------

/** Marker: a role an EARLIER pack of this epoch required and no served evidence covers. Parsed by canonicalDecision.ts's `unservedEpochContractZoom` — keep the two in sync. */
export const UNSERVED_EPOCH_ROLE_PREFIX = "unserved-required-role:";

/** Marker: a concern token an EARLIER pack of this epoch named and no served evidence matches. Same parser. */
export const UNCOVERED_EPOCH_CONCERN_PREFIX = "uncovered-concern:";

/** Bound on epoch-contract disclosures per axis — sized like unmatchedConcernTokens' own 4-token cap, with which it shares the W2 guidance-metadata budget. */
export const MAX_EPOCH_CONTRACT_DISCLOSURES = 4;

/**
 * This pack's contribution to the epoch's standing concern universe: the
 * concerns IT PUBLISHED as uncovered, and nothing else.
 *
 * Deliberately not "every identifier-shaped token in the query". A query names
 * tokens that no repository evidence can ever match — the classic one is the
 * value being ADDED ("add STALLED status to the status enum"), which is a
 * requirement on the EDIT, not on the evidence. Harvesting those made the
 * epoch permanently uncertifiable: pack 1 correctly shipped `complete`, and
 * every later pack of the same task was then demoted for failing to "cover" a
 * token that does not exist yet. Storing only what a pack itself declared
 * uncovered keeps the store's claim exactly as strong as the pack's own.
 */
export function epochConcernTokensFor(result: TaskPackResult, query: string): string[] {
  const tokens = result.coverage_reason === "concerns-uncovered"
    ? unmatchedConcernTokens(query, codeTaskPackSurfaces(result.surfaces))
    : [];
  // Keep an additive open-universe mutation's requested value as a durable
  // concern so an authoritative absent find can be consumed by the next
  // same-task-handle pack (e.g. REFUNDED), even when the first pack is
  // otherwise complete.
  if (hasOpenUniverseIntent(query) && !isAdditiveEnumIntent(query)) {
    const requestedValue = query.match(/\b[A-Z][A-Z0-9_]{2,}\b/)?.[0];
    if (requestedValue !== undefined && !tokens.includes(requestedValue)) tokens.push(requestedValue);
  }
  return tokens;
}

/**
 * The evidence the CALLER holds for this epoch: this pack's own surfaces plus
 * every same-epoch surface an earlier pack served. The second half is not
 * generosity — `recordServedEditAdmissibility`'s serve-time rule already makes
 * any content-bearing serve edit-admissible for the rest of the epoch, so a
 * requirement an earlier pack served is genuinely discharged. Prior entries
 * carry no body, so they can only match on path/role identity: the strict
 * direction.
 */
export function epochServedEvidence(
  workspace: string,
  result: TaskPackResult,
  epochTokens: readonly string[],
  /**
   * WP-S11: the CONSULTING pack's profile. Only an `answer` pack may read the
   * same-task read-only serve view, so a change pack that re-packs the same
   * wording can never inherit a declared-answer task's evidence — the
   * "declared answer tasks remain excluded from edit closure" constraint at
   * `cumulativeEligible` holds from the read side too. Omitted (the readiness
   * specs' synthetic callers) reads the cumulative log alone, as before.
   */
  profile?: TaskProfile,
): TaskPackSurface[] {
  return [
    ...codeTaskPackSurfaces(result.surfaces),
    ...reconstructServedEntryEvidence(
      workspace,
      epochServedSurfaceEntriesWithView(workspace, epochTokens, result, profile === "answer"),
    ),
  ];
}

/** Remember a prepared pack's certificate so a context-only replay can reuse it. */
export function rememberCertifiedWorkingSet(
  workspace: string,
  result: TaskPackResult,
  query: string,
  /**
   * FX-J (round-14 finding 4) / FX-K (round-15 finding 3): certify only the
   * surfaces this response actually shipped, and take that list from THE one
   * `shippedSurfaces(returned)` projection the single booking pass computed —
   * never re-project here. `paths` is the set a qref replay may name WITHOUT
   * failing closed ("every path this replay ADDS must be context"), so a
   * bodyless row here let a replay claim a never-served file as
   * already-certified context and clone the whole `execution_contract`
   * forward. FX-J filtered under `TL_SF_DEMOTE` only, and did it by
   * re-projecting over a DIFFERENT object (`trimmed`, whose bodies survive a
   * receipt/awaiting-input downgrade of `returned`) — two independently
   * derived answers to "what shipped", the exact hazard `shippedSurfaces`
   * exists to remove. One list, passed in, both flag states.
   */
  shipped: readonly TaskPackSurface[],
): void {
  const contract = result.execution_contract;
  if (contract?.typestate?.phase !== "prepared") return;
  const surfaces = shipped;
  if (surfaces.length === 0) return;
  const fileShas: Array<{ path: string; sha: string }> = [];
  const seen = new Set<string>();
  for (const surface of surfaces) {
    if (seen.has(surface.path)) continue;
    seen.add(surface.path);
    const sha = surfaceFileSha(workspace, surface.path);
    if (sha !== undefined) fileShas.push({ path: surface.path, sha });
    if (fileShas.length >= MAX_FINGERPRINT_FILES) break;
  }
  certifiedWorkingSets.set(laneScopedKey(path.resolve(workspace)), {
    lane: currentSessionLane(),
    epochTokens: tokenizeForEpoch(query),
    contract: structuredClone(contract),
    concerns: result.concerns === undefined ? undefined : structuredClone(result.concerns),
    coverage: result.coverage,
    coverageReason: result.coverage_reason,
    coverageBasis: result.coverage_basis,
    routeAction: result.route?.action ?? "edit_from_handles",
    paths: [...seen].map(normalizedRequestPath),
    fileShas,
  });
}

/**
 * C2: carry a retained certificate onto a qref replay whose added paths are all
 * context material. Runs BEFORE applyCompleteStopRouteToResult so the restored
 * route flows through the normal stop-clause / doc-sliver-honesty pipeline and
 * the replay ends up shaped exactly like the first pack.
 */
export function carryForwardCertifiedWorkingSet(
  workspace: string,
  result: TaskPackResult,
  args: TaskPackArgs | undefined,
  query: string,
): void {
  // Only a qref replay. A freshly-typed query is a new task epoch by
  // definition, and the caller is not claiming to still hold anything.
  if (args?.taskQueryRefReplay !== true) return;
  const requested = (args.paths ?? []).map((entry) =>
    normalizedRequestPath(typeof entry === "string" ? entry : entry.path));
  if (requested.length === 0) return;
  // Nothing to repair on a replay that certified itself.
  if (result.execution_contract?.typestate?.phase === "prepared") return;
  const prior = certifiedWorkingSets.get(laneScopedKey(path.resolve(workspace)));
  if (prior === undefined) return;
  // F-V13-3: a certificate rides forward only into the lane it was issued in.
  // Redundant with the lane-scoped key by construction — deliberately so: this
  // is the line that clones a whole `execution_contract` onto another response,
  // so it fails closed on its own evidence rather than trusting its filing.
  if (prior.lane !== currentSessionLane()) return;
  // Same task, and the certified files are still byte-identical: a certificate
  // is a claim about a working set, so it may only ride forward while that set
  // is provably the one it was issued over.
  if (!epochsOverlap(prior.epochTokens, tokenizeForEpoch(query))) return;
  if (prior.fileShas.length === 0) return;
  for (const { path: p, sha } of prior.fileShas) {
    if (surfaceFileSha(workspace, p) !== sha) return;
  }
  // Every path this replay ADDS must be context, not new edit scope. An added
  // path with no surface in the response is unproven, so it fails closed.
  const certified = new Set(prior.paths);
  const surfaces = codeTaskPackSurfaces(result.surfaces);
  for (const requestedPath of requested) {
    if (certified.has(requestedPath)) continue;
    const surface = surfaces.find((s) => normalizedRequestPath(s.path) === requestedPath);
    if (surface === undefined) return;
    if (surface.role !== "doc") return;
    if (surface.required === true) return;
  }

  result.coverage = prior.coverage;
  if (prior.coverageReason === undefined) delete result.coverage_reason;
  else result.coverage_reason = prior.coverageReason;
  if (prior.coverageBasis !== undefined) result.coverage_basis = prior.coverageBasis;
  if (result.concerns !== undefined && prior.concerns !== undefined) {
    const covered = new Set(
      prior.concerns.filter((concern) => concern.status === "covered").map((concern) => concern.id),
    );
    for (const concern of result.concerns) {
      if (covered.has(concern.id)) concern.status = "covered";
    }
  }
  // The three searches this pack was about to prescribe are for concerns the
  // caller already holds proof of.
  delete result.blocking_next_steps;
  if (result.checks !== undefined) {
    result.checks = result.checks.filter((check) => !check.startsWith("concern(s) not covered"));
    if (result.checks.length === 0) delete result.checks;
  }
  result.execution_contract = structuredClone(prior.contract);
  result.route = {
    action: prior.routeAction,
    reason: `certified working set carried forward (${prior.paths.length} handles, qref replay);`
      + ` this call adds context only`,
    max_additional_tl_calls: 0,
  };
}
