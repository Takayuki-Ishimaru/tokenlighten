// packState — extracted implementation; imports point to the owning modules.
import type { ServedPackRecord } from "./packState2.js";
import type { TaskPackArgs } from "../model.js";
import type { TaskPackResult } from "../model.js";
import type { TaskPackResultSurface } from "../model.js";
import { MAX_CACHED_PACKS_PER_WORKSPACE } from "./packState2.js";
import { MAX_FINGERPRINT_FILES } from "./packState2.js";
import { answerFirstPacks } from "./packTrimming2.js";
import { computeExtraArgsKey } from "./packState2.js";
import { computePackFingerprint } from "./packState2.js";
import { computeRequestProfileKey } from "./packState2.js";
import { computeWorkspaceInventoryState } from "./epochEvidence2.js";
import { currentSessionLane } from "../../../util/laneKey.js";
import { executedSearchResultSequence } from "../../../util/packServeLog.js";
import { getPackChecks } from "../../../state/session.js";
import { handleTable } from "../../../util/handles.js";
import { isArtifactTaskPackSurface } from "../artifactSections.js";
import { isAuxiliaryEnumSurface } from "../auxiliaryEnumContextIntegration.js";
import { laneScopedKey } from "../../../util/laneKey.js";
import { namedScopeSignature } from "./packState2.js";
import { primaryEnumContextRows } from "../auxiliaryEnumContextIntegration.js";
import { recordPackServedRanges } from "./packState2.js";
import { recordWorkspaceState } from "./packState3.js";
import { requestedPathSet } from "./packState2.js";
import { servedPacksByWorkspace } from "./packState2.js";
import { servedZoomScopeForArgs } from "./packState2.js";
import { servesStructureMap } from "./facetReadiness.js";
import { shaOfText } from "../../../util/handles.js";
import { structureMapChainWasServed } from "./packState2.js";
import { surfaceFileSha } from "./packState2.js";
import { tokenizeForEpoch } from "../../../state/session.js";

export function captureServedPack(
  workspace: string,
  args: TaskPackArgs,
  fingerprint: string,
  result: TaskPackResult,
  /**
   * §3 residual (2026-08-02 serve-honesty): the pack actually RETURNED on the
   * wire, when it differs from the dedup baseline `result`. dedupeTrimAndPersist
   * deliberately captures the full `trimmed` as the FINGERPRINT baseline even
   * when it returns a compact subset receipt — that asymmetry is correct for
   * dedup and WRONG for the served-range ledger, which may only book bytes that
   * went out. Closed by construction here rather than by argument: the ledger
   * always follows this parameter, which defaults to `result` for every caller
   * where baseline and wire are the same object.
   */
  served: TaskPackResult = result,
): void {
  // B2d: ledger continuity runs for EVERY captured pack, including the artifact
  // shape writeServedPackRecord leaves unrecorded — code surfaces on a mixed
  // pack still served real lines.
  recordPackServedRanges(
    workspace,
    served,
    servedZoomScopeForArgs(args, args.query ?? args.symbol ?? args.path ?? ""),
  );
  writeServedPackRecord(workspace, args, fingerprint, result);
  // The dispatcher's receipt preflight fingerprints a request buildTaskPackCore
  // rewrote with its own named project scope as the caller sent it (see
  // TaskPackArgs.namedScopeRequest), so the same record is written under that
  // request too. A cache re-key only: the ledger above is not booked again, its
  // epoch scope (query, lane) being the caller's own.
  const named = args.namedScopeRequest;
  if (named !== undefined && named.args !== args && namedScopeSignature(args, fingerprint) === named.signature) {
    writeServedPackRecord(workspace, named.args, computePackFingerprint(named.args, workspace), result);
  }
}

export function writeServedPackRecord(
  workspace: string,
  args: TaskPackArgs,
  fingerprint: string,
  result: TaskPackResult,
): void {
  const answerFirst = answerFirstPacks.has(result);
  // Serialized receipt rows cannot retain the private source-context marker.
  // Keep this optional data out of the semantic cache; range booking already
  // captured the real response separately in captureServedPack.
  if (result.surfaces.some(isAuxiliaryEnumSurface)) result = {...result,
    surfaces: primaryEnumContextRows(result.surfaces),
  };
  // Cached packs serialize code-surface identity (range+role). Artifact packs
  // deliberately bypass this optimization so their strict discovery shape is
  // never collapsed into, or re-served as, a code surface — so THIS pack is not
  // captured. iter-3 F1: do NOT wipe the whole per-workspace window here. The old
  // `servedPacksByWorkspace.delete(workspace)` evicted every UNRELATED code-pack
  // record too, so an artifact-bearing pack interleaved between two identical
  // code packs poisoned the first code pack's record — the identical repeat then
  // missed the cache and re-served in full (a full serve of one-call latency),
  // and only the NEXT repeat (after re-capture) received the receipt. Instead,
  // drop only any record that shares THIS request's signature (a stale code
  // record for a request that now yields an artifact pack must not be re-served),
  // leaving every other code pack's receipt eligibility intact.
  if ((result.surfaces as TaskPackResultSurface[]).some(isArtifactTaskPackSurface)) {
    const artifactSignatureKey =
      `${fingerprint} ${computeExtraArgsKey(args)} ${computeRequestProfileKey(args)}`;
    const remaining = (servedPacksByWorkspace.get(laneScopedKey(workspace)) ?? []).filter(
      (r) => `${r.fingerprint} ${r.extraArgsKey} ${r.requestProfileKey}` !== artifactSignatureKey,
    );
    if (remaining.length > 0) servedPacksByWorkspace.set(laneScopedKey(workspace), remaining);
    else servedPacksByWorkspace.delete(laneScopedKey(workspace));
    return;
  }
  const distinctPaths: string[] = [];
  const seen = new Set<string>();
  for (const s of result.surfaces) {
    if (!seen.has(s.path)) { seen.add(s.path); distinctPaths.push(s.path); }
    if (distinctPaths.length >= MAX_FINGERPRINT_FILES) break;
  }
  const fileShas: Array<{ path: string; sha: string }> = [];
  for (const p of distinctPaths) {
    const sha = surfaceFileSha(workspace, p);
    if (sha !== undefined) fileShas.push({ path: p, sha });
  }
  const inventory = computeWorkspaceInventoryState(workspace);
  // D2 (F-B2): projected ONCE and reused below, so the workspace_state stamped
  // on the record is provably computed over the very array the record carries —
  // the property that makes the revalidation equality a pure freshness test.
  const recordSurfaces: ServedPackRecord["surfaces"] = result.surfaces.map((s) => ({
    handle: s.handle,
    path: s.path,
    range: s.range,
    role: s.role,
    handleIdentity: handleTable.get(s.handle) ? { ...handleTable.get(s.handle)! } : undefined,
    // B5/P1-6: thread the honesty markers through — see ServedPackRecord.surfaces.
    ...(s.content_completeness !== undefined ? { content_completeness: s.content_completeness } : {}),
    ...(s.total_lines !== undefined ? { total_lines: s.total_lines } : {}),
    ...(s.remaining_ranges !== undefined ? { remaining_ranges: [...s.remaining_ranges] } : {}),
  }));
  const record: ServedPackRecord = {
    lane: currentSessionLane(),
    ...(typeof args.query === "string" ? { queryIdentity: shaOfText(args.query) } : {}),
    ...(args.taskBinding ? { taskBinding: args.taskBinding } : {}),
    ...(answerFirst ? { answerFirst: true as const } : {}),
    ...(args.query && (servesStructureMap(result.surfaces) || structureMapChainWasServed(workspace, args.query))
      ? { structureMapQueryKey: shaOfText(args.query) } : {}),
    fingerprint,
    extraArgsKey: computeExtraArgsKey(args),
    requestProfileKey: computeRequestProfileKey(args),
    surfaces: recordSurfaces,
    workspaceState: recordWorkspaceState(
      workspace,
      { surfaces: recordSurfaces, coverage: result.coverage, missing: result.missing },
      inventory,
    ),
    coverage: result.coverage,
    coverageReason: result.coverage_reason,
    coverageBasis: result.coverage_basis,
    route: result.route ? { ...result.route } : undefined,
    // TL142-01C: see ServedPackRecord.createTarget. Captured from the DEDUP
    // BASELINE (`result`), the same object every other certified member on
    // this record comes from — `served` can be a compact subset receipt whose
    // own create route was never re-derived.
    createTarget: result.create_target ? { ...result.create_target } : undefined,
    requestItemAbsences: result.request_item_absences ? result.request_item_absences.map((a) => ({ ...a })) : undefined,
    executedSearchSequence: executedSearchResultSequence(workspace, currentSessionLane(), args.taskBinding),
    epochTokens: tokenizeForEpoch(args.query ?? args.symbol ?? args.path ?? ""),
    requestRoles: (args.surfaceRoles ?? []).slice().sort(),
    requestPaths: requestedPathSet(args),
    inventoryFingerprint: inventory.complete ? inventory.fingerprint : "",
    missing: [...result.missing],
    next: result.next,
    profileBinding: result.profile_binding,
    taskProfile: result.task_profile,
    executionContract: result.execution_contract,
    contentSufficiency: result.content_sufficiency,
    checkIds: (getPackChecks(workspace)?.checks ?? []).map((c) => c.id),
    fileShas,
  };
  // iter-2 W1: bounded multi-slot cache. Replace any prior record with the SAME
  // request signature (fingerprint+extraArgs), then append and FIFO-evict.
  // B2b (2026-08-01 serving-completeness): the requested profile stays part of
  // the SIGNATURE (so two genuinely differently-profiled calls keep their own
  // slots) even though LOOKUP matches it loosely via packProfileCompatible.
  const signatureKey = `${fingerprint}\u0000${record.extraArgsKey}\u0000${record.requestProfileKey}`;
  const kept = (servedPacksByWorkspace.get(laneScopedKey(workspace)) ?? []).filter(
    (r) => `${r.fingerprint}\u0000${r.extraArgsKey}\u0000${r.requestProfileKey}` !== signatureKey,
  );
  kept.push(record);
  while (kept.length > MAX_CACHED_PACKS_PER_WORKSPACE) kept.shift();
  servedPacksByWorkspace.set(laneScopedKey(workspace), kept);
}

/**
 * iter-2 W2: the guidance a complete/focused working set must carry — an
 * explicit STOP signal, not just an edit route. The iter-1 loss cell issued 4
 * MORE packs (post_ready_reads=5) after coverage flipped complete because a bare
 * edit route read as "you MAY edit", not "stop discovering". GUIDANCE ONLY: it
 * never adds a refusal and never raises max_additional_tl_calls above 0 (the
 * serve-with-state gate stays the sole refusal mechanism — wave-4 proved empty
 * refusals backfire).
 */
export const COMPLETE_STOP_REASON =
  "working set complete — stop discovery; edit from resident handles now";

export const COMPLETE_STOP_REASON_ANSWER =
  "working set complete — stop discovery; answer from resident handles now";
