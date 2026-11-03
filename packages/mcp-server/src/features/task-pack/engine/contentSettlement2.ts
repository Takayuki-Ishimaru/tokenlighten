// contentSettlement — extracted implementation; imports point to the owning modules.
import * as path from "path";
import type { PendingPackBookings } from "./wiringEvidence2.js";
import type { ServedSurfaceEntry } from "../../../util/packServeLog.js";
import type { TaskPackResult } from "../model.js";
import type { TaskProfile } from "@tokenlighten/types";
import type { WorkspaceInventoryState } from "./epochEvidence2.js";
import { DEFAULT_CONTRACT_LANE } from "../../../util/packServeLog.js";
import { FileReadCache } from "./packBasics2.js";
import { applyCanonicalTaskDecision } from "../canonicalDecision.js";
import { buildTaskExecutionContract } from "./executionContract.js";
import { buildTaskWorkspaceState } from "./epochEvidence2.js";
import { centeredSliceForCap } from "./packBasics2.js";
import { certificateIdentityProfile } from "./unresolvedCalls3.js";
import { codeTaskPackSurfaces } from "../artifactSections.js";
import { directImportNeighbors } from "./contentSettlement3.js";
import { editFromHandlesRoute } from "./coverageAndContinuation4.js";
import { enforceNoDeadEndContract } from "./contractReconciliation.js";
import { fitsInCap } from "./packTrimming2.js";
import { hasServedCode } from "./wiringEvidence2.js";
import { pendingNamedFrontierOnlyEntries } from "./semanticFrontier.js";
import { pendingOwnServedSurfaces } from "./readinessObligations2.js";
import { preservePartialRangeProgress } from "./contentSettlement.js";
import { primaryEnumContextRows } from "../auxiliaryEnumContextIntegration.js";
import { projectCompletion } from "../canonicalDecision.js";
import { proofCompletionEnabled } from "../../../util/flags.js";
import { queryServedSurfaces } from "../../../util/packServeLog.js";
import { reconcileTaskPackExecutionContract } from "./contractReconciliation.js";
import { recordServedSurfaces } from "../../../util/packServeLog.js";
import { safeResolve } from "../../../util/safePath.js";
import { shaOfText } from "../../../util/handles.js";
import { shouldAttachFrontierIndex } from "../../../util/packServeLog.js";
import { shouldAttachServedEarlier } from "../../../util/packServeLog.js";
import { stampEpochServedPaths } from "../../../util/packServeLog.js";
import { taskContractDischargeCertificate } from "../taskContractStore.js";
import { tokenizeForEpoch } from "../../../state/session.js";

/** Rebuild readiness after every late trim/disclosure seam, before wire projection. */
export function rebuildFinalExecutionContract(
  result: TaskPackResult,
  profile: TaskProfile,
  query: string,
  workspace: string,
  workspaceInventory: WorkspaceInventoryState,
  proofTransition = false,
  /** The complete exact literal cohort was persisted as a ledger proof. */
  literalSourceUniverse = false,
  /** A-F2: the executed-next ledger lane, so the rebuilt contract's no-dead-end guard cannot re-open a consumed call. */
  lane: string = DEFAULT_CONTRACT_LANE,
): void {
  const rangeProgress = preservePartialRangeProgress(result);
  const proofTransitionMissing = result.missing.filter(
    (entry) => !entry.startsWith("unresolved-ledger:"),
  );
  // The provisional contract runs before recordEpochTaskContract persists a
  // current-pack capability limitation. It can therefore honestly reject an
  // otherwise complete frontier for an open-universe proof which the same
  // response subsequently discharges. Reconciliation deliberately demotes
  // the route at that provisional point; restore only this exact reversible
  // demotion before the proof-transition rebuild, never a general discovery
  // route. All required bodies and the explicit-gap-only missing projection
  // remain the guards on the terminal edit grant below. Do not consult raw
  // `coverage` here: the just-recorded capability gap temporarily stamps it
  // partial, and projectCompletion has not yet projected the now-closed
  // blocking set back to complete.
  const restoreOpenUniverseFrontier = proofTransition
    && result.route?.action === "locate_missing_surfaces"
    && (
      literalSourceUniverse
      || /^ready rejected: unresolved proof open-universe:/.test(result.route.reason ?? "")
    )
    && proofTransitionMissing.every((entry) => entry.startsWith("explicit-gap:"))
    && codeTaskPackSurfaces(result.surfaces)
      .filter((surface) => surface.required !== false)
      .every(hasServedCode);
  if (restoreOpenUniverseFrontier) {
    result.route = {
      action: "edit_from_handles",
      reason: literalSourceUniverse
        ? "complete exact literal source universe discharges the exhaustive frontier through the task ledger"
        : "current-pack evidence-expansion capability gap discharges the exhaustive frontier",
      max_additional_tl_calls: 0,
    };
    delete result.next;
    delete result.continuation;
  }
  // F-B3's prior-pack disclosure is the other late mutation that can make a
  // pre-existing certificate stale. Leave unrelated post-contract adornments
  // on their established projection path; they do not change readiness.
  const stalePriorObligation = result.missing.some((entry) => entry.startsWith("unserved-obligation:"));
  if (!rangeProgress && !stalePriorObligation && !proofTransition) {
    applyCanonicalTaskDecision(result);
    return;
  }
  result.execution_contract = buildTaskExecutionContract(
    result,
    profile,
    query,
    buildTaskWorkspaceState(result, workspace, workspaceInventory),
    workspace,
    proofTransition,
    undefined,
    literalSourceUniverse,
  );
  reconcileTaskPackExecutionContract(result);
  enforceNoDeadEndContract(result, query, { workspace, lane });
  applyCanonicalTaskDecision(result);
}

/**
 * Bind an already-prepared response to the terminal ledger snapshot written
 * later in this same pack.  The normal epoch write is intentionally after the
 * first decision (otherwise an unresolved dependency loses its initial find),
 * but a certificate ID must not differ merely because the identical request
 * is reconstructed from that durable row after a restart.
 *
 * This is deliberately an ID-only rebind.  Re-running the contract builder
 * here would re-evaluate late route/continuation seams and can turn a valid
 * prepared wiring pack into discovery.  The proof, decision, and surface
 * projection were already adjudicated; only the durable digest component of
 * the certificate identity became available after that adjudication.
 */
export function rebindPreparedCertificateToLedger(
  result: TaskPackResult,
  profile: TaskProfile,
  query: string,
  workspace: string,
): void {
  const contract = result.execution_contract;
  const certificate = contract?.readiness_certificate;
  if (contract?.typestate.phase !== "prepared" || certificate === undefined) return;
  // A-F6: the ledger-bound id form is a proof-completion artifact. This rebind
  // was ungated, so with the compatibility switch OFF an id still acquired the
  // `ready-<ledger16>-<proof16>` shape that v0.12 never emits — measured live
  // on an OFF pack. OFF must reproduce v0.12's single-segment id.
  if (!proofCompletionEnabled()) return;
  const ledger = taskContractDischargeCertificate(workspace, tokenizeForEpoch(query));
  const workspaceFingerprint = contract.workspace_state?.fingerprint;
  if (ledger === undefined || workspaceFingerprint === undefined) return;
  const identityProfile = certificateIdentityProfile(result, profile);
  const taskHash = shaOfText(`${identityProfile}\u0000${query}`).replace(/^sha256:/, "").slice(0, 16);
  const proofHash = shaOfText(JSON.stringify({
    taskHash,
    ...(identityProfile !== profile ? {proofProfile: profile} : {}),
    obligations: certificate.obligations.map((obligation) => [
      obligation.id,
      obligation.status,
      (obligation.evidence ?? []).map((item) => item.handle),
    ]),
    actionFrontier: certificate.action_frontier,
    workspaceState: workspaceFingerprint,
    ledgerDigest: ledger.digest,
  })).replace(/^sha256:/, "").slice(0, 16);
  const id = `ready-${ledger.digest.slice(0, 16)}-${proofHash}`;
  if (certificate.id === id) return;
  certificate.id = id;
  contract.typestate.certificate_id = id;
  if (contract.semantic_closure?.state === "closed") {
    contract.semantic_closure.closure_id = id;
  }
}

/**
 * DESIGN-v0.9 §4.6b deterministic-next internal execution. When a
 * complete/focused pack would have emitted `tl_read_file handles=[...]` as its
 * `next` (>=2 code-less surfaces whose handles were minted moments ago), the
 * PACK BUILDER instead serves those bodies inline in the SAME response — the
 * follow-up read is deterministic and the file content is already in the pack's
 * FileReadCache, so prompting a round trip is pure waste.
 *
 * Runs INSIDE pack assembly, BEFORE trimToCap (the caller's ordering): the
 * §4.3 trim inversion then guarantees any body that does not fit is stripped
 * (content_completeness:"partial") before any handle is dropped, so an inlined
 * body can never cost a handle. Each embedded body reuses the SAME
 * centeredSliceForCap the cliff fix uses (match-centered trimmed window +
 * remaining_ranges), and stamps one "surface-body:<handle>" entry on
 * `result.inlined`. attachSupply (§4.7) later verifies every stamped handle is
 * content-bearing and drops any that trimToCap subsequently stripped.
 *
 * Budget: bounded by fitsInCap, whose capForResult grants the §4.8 must-fetch
 * expansion ONLY when the flag is on AND `inlined[]` is non-empty. With the
 * flag OFF the loop inlines only what fits today's caps and reverts the first
 * body that would overflow (the rest stay code-less; the `next`/continuation
 * covers them). A code-less surface whose path cannot be safely resolved
 * inside the workspace is skipped (centeredSliceForCap returns undefined for an
 * out-of-workspace or unreadable path — the §6 sanity guard).
 *
 * Gated on >=2 code-less surfaces to mirror EXACTLY the nextHintForCoverage
 * branch it replaces; returns the count actually inlined. Mutates `result`.
 */
export function inlineCodelessSurfaces(
  result: TaskPackResult,
  workspace: string,
  cache?: FileReadCache,
): number {
  if (result.coverage !== "complete" && result.coverage !== "focused") return 0;
  const codeless = result.surfaces.filter(
    (s) => s.code === undefined && s.code_unchanged === undefined,
  );
  if (codeless.length < 2) return 0;

  let count = 0;
  for (const surf of codeless) {
    // §6 sanity guard: never serve content for a path outside the workspace
    // root. readCached's no-cache branch does a bare path.join with no realpath
    // check, so the boundary is enforced HERE (safeResolve returns undefined
    // for an escaping/absolute path) rather than relying on the reader.
    if (safeResolve(surf.path, workspace) === undefined) continue;
    const embed = centeredSliceForCap(workspace, surf.path, surf.range, cache);
    if (!embed) continue; // I/O error, malformed range, or unreadable path.

    // Tentatively apply, then revert if the pack no longer fits its (possibly
    // must-fetch-expanded) cap. Push the inlined stamp BEFORE the fit check so
    // capForResult sees the non-empty `inlined[]` and grants the §4.8
    // expansion when the flag is on.
    const prevCode = surf.code;
    const prevCC = surf.content_completeness;
    const prevRR = surf.remaining_ranges;
    const prevInlined = result.inlined;
    surf.code = embed.code;
    if (embed.remaining_ranges.length > 0) {
      surf.content_completeness = "partial";
      surf.remaining_ranges = embed.remaining_ranges;
    }
    result.inlined = [...(prevInlined ?? []), `surface-body:${surf.handle}`];

    if (fitsInCap(result)) {
      count++;
      continue;
    }
    // Over budget — revert this body and stop; remaining surfaces stay
    // code-less and the recomputed `next` (below) covers them.
    surf.code = prevCode;
    surf.content_completeness = prevCC;
    surf.remaining_ranges = prevRR;
    result.inlined = prevInlined;
    break;
  }

  if (result.inlined !== undefined && result.inlined.length === 0) delete result.inlined;
  return count;
}

// ===========================================================================
// IMPROVEMENT A: cumulative (session-stateful) coverage, served-surface
// logging, and the complete-working-set frontier_index. IMPROVEMENT D: honest
// verification runnability verdict. All state lives in util/packServeLog.ts
// (an independent per-workspaceRoot registry — never session.ts).
// ===========================================================================

/** Cap on frontier_index entries and its serialized byte budget. */
export const MAX_FRONTIER_INDEX_ENTRIES = 200;

export const MAX_FRONTIER_INDEX_BYTES = 8192;

/**
 * IMPROVEMENT A part 2: flip coverage to cumulative-complete when the UNION of
 * this call's surfaces and the still-valid surfaces earlier calls served closes
 * every required role that THIS pack alone reported missing. Mutates `result`
 * into the same trustworthy shape a single-call complete pack carries (coverage
 * complete, no missing/blocking, edit/answer route with 0 extra calls) and adds
 * `coverage_basis:"cumulative"` + a `served_earlier` list naming exactly what
 * prior calls already served (so the model does not re-fetch it). Returns true
 * when the flip fired. Conservative: fires ONLY when a required role is
 * genuinely absent from the current surfaces yet fully covered by valid prior
 * surfaces of the SAME task epoch.
 */
export function applyCumulativeCoverage(
  result: TaskPackResult,
  prior: ServedSurfaceEntry[],
  query: string,
): boolean {
  const required = new Set(result.required_surfaces ?? []);
  if (required.size === 0) return false;
  const missingRequired = result.missing_required_surfaces ?? [];
  if (missingRequired.length === 0 || prior.length === 0) return false;
  // A partial body proves only its shipped windows, never a whole missing role.
  const completePrior = prior.filter((entry) => entry.fullyServed !== false);
  const priorRoles = new Set(completePrior.map((p) => p.role));
  // Every currently-missing required role must be covered by a valid prior surface.
  if (missingRequired.some((role) => !priorRoles.has(role))) return false;
  const servedEarlier = completePrior
    .filter((p) => missingRequired.includes(p.role))
    .map((p) => ({ path: p.path, role: p.role, ...(p.handle ? { handle: p.handle } : {}) }));
  if (servedEarlier.length === 0) return false;

  result.coverage = projectCompletion(result, [], { promoteWhenComplete: true }).coverage;
  result.coverage_basis = "cumulative";
  result.served_earlier = servedEarlier;
  result.missing = (result.missing ?? []).filter((m) => !missingRequired.includes(m));
  delete result.missing_required_surfaces;
  delete result.blocking_next_steps;
  if (result.coverage_reason === "missing-roles") delete result.coverage_reason;
  result.content_sufficiency = undefined;
  // The role-specific structure was proven across the earlier calls; the
  // stateless contract cannot re-verify it, so drop the change_contract whose
  // per-role obligations would otherwise read "uncovered" for the prior roles.
  result.change_contract = undefined;
  delete result.next;
  const coveredRoles = [...new Set(servedEarlier.map((s) => s.role))].join(",");
  // Route must STOP emitting locate_missing_surfaces for roles now in the union.
  result.route = editFromHandlesRoute(
    `required roles covered cumulatively (${coveredRoles} served by earlier calls this task; see served_earlier)`,
    0,
    query,
  );
  return true;
}

/** Byte+count cap for frontier_index; the overflow tail becomes per-directory rollup entries. */
export function capFrontierIndex(
  entries: Array<{ path: string; role: string; handle?: string }>,
): Array<{ path: string; role: string; handle?: string }> {
  const head: Array<{ path: string; role: string; handle?: string }> = [];
  const overflow: Array<{ path: string; role: string; handle?: string }> = [];
  for (const e of entries) {
    if (
      head.length < MAX_FRONTIER_INDEX_ENTRIES
      && Buffer.byteLength(JSON.stringify([...head, e]), "utf8") <= MAX_FRONTIER_INDEX_BYTES
    ) {
      head.push(e);
    } else {
      overflow.push(e);
    }
  }
  if (overflow.length === 0) return head;
  const byDir = new Map<string, number>();
  for (const e of overflow) {
    const dir = path.posix.dirname(e.path);
    byDir.set(dir, (byDir.get(dir) ?? 0) + 1);
  }
  for (const [dir, n] of byDir) {
    if (head.length >= MAX_FRONTIER_INDEX_ENTRIES) break;
    head.push({ path: `${dir}/`, role: `dir-rollup:+${n}` });
  }
  return head;
}

/**
 * IMPROVEMENT A part 3: attach a complete, code-less inventory of the ENTIRE
 * known working set whenever coverage is NOT single-call complete (or the
 * working set overflowed byte caps): current surfaces + still-valid prior
 * served surfaces + budget-trimmed candidates + resolvable depth-1 import
 * neighbours. The model zooms via these handles/paths instead of re-searching.
 */
export function attachFrontierIndex(
  workspace: string,
  result: TaskPackResult,
  prior: ServedSurfaceEntry[],
): void {
  if (result.ok === false) return; // broad-overview envelope: nothing to inventory
  // iter-2 W3: NEVER on a complete/cumulative-complete pack. The iter-1 forensics
  // paid frontier_index (9KB across 6 packs) that the model re-searched instead
  // of navigating; a complete pack should say "stop", not hand back a re-search
  // inventory. (Previously an overflowed-complete pack still attached it.)
  if (result.coverage === "complete" || result.coverage === "focused") return;

  const surfaces = primaryEnumContextRows(codeTaskPackSurfaces(result.surfaces));
  const seen = new Set<string>();
  const entries: Array<{ path: string; role: string; handle?: string }> = [];
  const add = (relPath: string, role: string, handle?: string): void => {
    if (relPath.length === 0 || seen.has(relPath)) return;
    seen.add(relPath);
    entries.push({ path: relPath, role, ...(handle ? { handle } : {}) });
  };
  for (const s of surfaces) add(s.path, s.role, s.handle);
  for (const p of prior) add(p.path, p.role, p.handle);
  for (const t of result.trimmed ?? []) add(t, "candidate");
  for (const nb of directImportNeighbors(workspace, surfaces, seen)) add(nb, "import-neighbor");
  // Ruling F1' (FX-OH2): an over-bound caller-named file joined with NO
  // evidence row (`applySemanticFrontierNamedFrontier`) still needs to reach
  // the caller as an address — this is the ONLY place it does.
  const namedFrontierOnly = pendingNamedFrontierOnlyEntries.get(result);
  if (namedFrontierOnly !== undefined) {
    pendingNamedFrontierOnlyEntries.delete(result);
    for (const entry of namedFrontierOnly) add(entry.path, "domain", entry.handle);
  }
  if (entries.length === 0) return;

  const capped = capFrontierIndex(entries);
  if (capped.length === 0) return;
  // iter-2 W3: attach only when it carries NEW information — the first
  // attachment of the epoch, or a changed inventory since the last one. An
  // identical re-attachment is pure resident-byte tax (the model already holds
  // the same paths/handles), so suppress it.
  const sig = shaOfText(JSON.stringify(capped));
  if (!shouldAttachFrontierIndex(workspace, sig)) return;
  result.frontier_index = capped;
  if (result.route !== undefined && !/frontier_index/.test(result.route.reason)) {
    result.route = {
      ...result.route,
      reason: `${result.route.reason}; frontier_index is the complete known working set — zoom via its handles/paths instead of re-searching`,
    };
  }
}

/**
 * IMPROVEMENT A orchestration — runs once inside dedupeTrimAndPersist, just
 * BEFORE the contract build (not at the exit; the exit is
 * `bookShippedPackServeState`). (1) consults the served-surface log for
 * still-valid prior surfaces of this task epoch, (2) flips to cumulative
 * coverage when the union closes the required roles, (3) hands THIS call's
 * candidate surfaces to the contract build and to the single booking pass,
 * (4) attaches frontier_index.
 *
 * FX-J/FX-K (2026-09-03) — WHY NOTHING IS BOOKED HERE, IN EITHER FLAG STATE.
 * Two producers naturally belong here: the edit gate's admissible union and
 * the cumulative served-surface log. Both read `surface.code` (directly or
 * through `hasServedCode`) as the truth about what this response sends, and
 * this function runs BEFORE `trimToCap` (Phase E strips a surviving surface's
 * body; Phase F splices a whole surface out) and before the SF pre-booking
 * seam. Booking here therefore asserts bytes the response may never send.
 *
 * FX-J left the flag-off path booking here, over the pre-trim list, to keep
 * `8ea1eb52`'s session state byte-identical; gap (o) justified that partly on
 * "Phase-E-on-survivor is unreachable from the production entrance".
 * Round-15 falsified it with a one-call `budget:{bytes}` repro that ends in
 * `edit.applied` against a bodyless-shipped file. FX-K therefore collapses the
 * two sites into ONE unconditional post-trim pass
 * (`bookShippedPackServeState`), and this function books nothing.
 *
 * What still happens here, in both flag states:
 *   - the epoch bookkeeping half of `recordServedSurfaces` (reset on a
 *     non-overlapping task, union the tokens), which `attachFrontierIndex`'s
 *     attach-discipline latch and every same-call `queryServedSurfaces` epoch
 *     gate depend on. It records no ENTRY, so nothing about what this response
 *     served is asserted;
 *   - the explicit candidate feed to the contract build
 *     (`pendingOwnServedSurfaces` / `epochServedSurfaceEntries`). The contract
 *     must see the pre-trim candidate list (FX-J), so deferring the log write
 *     cannot narrow the certificate.
 */
export function finalizePackServeState(
  workspace: string,
  result: TaskPackResult,
  effectiveQuery: string,
  profile: TaskProfile,
  bookings: PendingPackBookings,
): boolean {
  // Route classification is a response affordance, not the caller's task
  // identity. A generic task can temporarily route through answer handles and
  // must still retain required-role evidence for its same-epoch cumulative
  // continuation; declared answer tasks remain excluded from edit closure.
  const cumulativeEligible = profile !== "answer" || result.profile_binding?.source !== "explicit";
  const surfaces = codeTaskPackSurfaces(result.surfaces);
  const currentPaths = new Set(surfaces.map((s) => s.path));
  const epochTokens = tokenizeForEpoch(effectiveQuery);

  // Consult BEFORE recording this call's surfaces (exclude the current paths).
  const prior = (cumulativeEligible && surfaces.length > 0)
    ? queryServedSurfaces(workspace, workspace, { excludePaths: currentPaths, epochTokens })
    : [];
  // E2 (2026-09-05): carry the epoch's served paths to the wire-side
  // continuation projectors, which have no workspace handle of their own, so a
  // `decision.next` can never re-request evidence this task already holds.
  // Symbol-keyed, therefore invisible to JSON.stringify — zero wire bytes.
  // C1 (DESIGN-v0.15 §12 rows 82-84, R31-FIX regression): a path an earlier
  // call only partially (and re-packably) served — `fullyServed === false`,
  // computed by `bookShippedPackServeState` via `surfaceAlreadyCoversWholeFile`
  // — must NOT be treated as closed here; only `undefined` (a caller that
  // never threaded the verdict through) or `true` counts as spent.
  stampEpochServedPaths(result, prior.filter((entry) => entry.fullyServed !== false).map((entry) => entry.path));
  const flipped = applyCumulativeCoverage(result, prior, effectiveQuery);

  // iter-2 W3: served_earlier is attached ONCE — on the cumulative FLIP call —
  // not repeated on every subsequent cumulative pack (the iter-1 forensics paid
  // the same ~3.5KB list ×N). The model already holds the earlier surfaces after
  // the first flip; the frontier_index / coverage_basis still signal cumulative.
  if (flipped && result.served_earlier !== undefined && !shouldAttachServedEarlier(workspace)) {
    delete result.served_earlier;
  }

  bookings.epochTokens = [...epochTokens];
  bookings.cumulativeEligible = cumulativeEligible;
  // The contract build below reads the served-surface log for this epoch. The
  // log write happens at the single post-trim booking pass, so hand it the
  // same candidates explicitly.
  if (cumulativeEligible && surfaces.length > 0) {
    bookings.pack = result;
    pendingOwnServedSurfaces.set(result, surfaces);
    // FX-K: epoch bookkeeping ONLY, and deliberately NOT a booking — the empty
    // entry list is what makes it one. `recordServedSurfaces` resets the log
    // when this query's tokens do not overlap the stored epoch and then unions
    // them in; `attachFrontierIndex` below, the receipt/attach latches and
    // every same-call `queryServedSurfaces` epoch gate read that state. The
    // guard is the historical one (`cumulativeEligible && surfaces.length > 0`)
    // so the reset/union fires on exactly the calls it always did.
    recordServedSurfaces(workspace, workspace, [], epochTokens);
  }

  attachFrontierIndex(workspace, result, prior);
  return flipped;
}
