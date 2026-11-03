// packState — extracted implementation; imports point to the owning modules.
import * as path from "path";
import type { ContinuationLike } from "./packBasics.js";
import type { ServedPackRecord } from "./packState2.js";
import type { TaskPackResult } from "../model.js";
import { certifiedWorkingSets } from "./epochContract3.js";
import { clampToActiveCeiling } from "./packBasics2.js";
import { clearExecutedNextForLane } from "../../../util/packServeLog.js";
import { clearExecutedNextForWorkspace } from "../../../util/packServeLog.js";
import { clearPriorPackObligations } from "../priorPackStore.js";
import { clearSourceCapsules } from "../sourceCapsuleCallScope.js";
import { clearSourceCapsulesWhere } from "../sourceCapsuleCallScope.js";
import { clearTaskContract } from "../taskContractStore.js";
import { clearTaskContractsForLane } from "../taskContractStore.js";
import { codeTaskPackSurfaces } from "../artifactSections.js";
import { createPackFingerprintBinding } from "../packFingerprintBinding.js";
import { hasServedCode } from "./wiringEvidence2.js";
import { laneScopedKey } from "../../../util/laneKey.js";
import { parsePackLineRange } from "./packState2.js";
import { parseSurfaceSpan } from "./packState2.js";
import { parseUnreadableNamedPathRow } from "./servedStateAndEdits3.js";
import { priorBodyRestoration } from "./packState2.js";
import { protocolCallContext } from "../../../protocol/envelope.js";
import { rawCapForResult } from "./surfaceMaterialization.js";
import { readOnlyServedViews } from "./readinessObligations2.js";
import { resetTaskContractStoreForTest } from "../taskContractStore.js";
import { rootOfLaneScopedKey } from "../../../util/laneKey.js";
import { servedPacksByWorkspace } from "./packState2.js";
import { shaOfText } from "../../../util/handles.js";
import { surfaceFileLineCount } from "./packState2.js";

/**
 * T1 (2026-08-27 field-eval): the byte budget actually enforced for `result`
 * -- rawCapForResult's type-specific tier, clamped down (never up) to
 * whatever byte ceiling is active for the buildTaskPack() call in progress
 * (see packByteCeilingStorage above). Every existing caller of the old
 * capForResult name is unaffected when no ceiling is active (the ordinary
 * case: today's corpus calls pass neither maxBytes/maxTokens nor a
 * clientInfo the vscode profile matches), since clampToActiveCeiling is then
 * the identity function.
 */
export function capForResult(result: TaskPackResult): number {
  return clampToActiveCeiling(rawCapForResult(result));
}

// ---------------------------------------------------------------------------
// DESIGN-v0.8 §C2 item 2: pack-level code-block dedupe.
//
// Scope note (per the design's own escape hatch — "if cross-call state is
// too invasive, implement the within-pack duplicate-block dedupe... and FLAG
// the cross-pack part as deferred"): this implements BOTH. Cross-pack state
// turned out NOT to be invasive here — a single module-level Map keyed by
// workspace, overwritten (never appended) on every call, so memory is
// bounded by the number of distinct workspaces this process has ever served
// (already the same shape handleTable/session.ts use for per-workspace
// state). Within-pack dedupe falls out of the SAME pass for free: fingerprints
// are checked against, and folded into, one running list that starts as a
// copy of the PRIOR pack's fingerprints and accumulates the CURRENT pack's
// surfaces as they are visited in order — so a second same-pack surface
// sharing handle+range+hash with an earlier one in the SAME pack matches
// exactly like a cross-pack match would, just against an entry that was
// added moments earlier instead of on a prior call.
// ---------------------------------------------------------------------------

export interface PackedBlockFingerprint {
  handle: string;
  range: string;
  hash: string;
  /** True when carried over from the PRIOR call's pack; false when added by the surface currently being processed in THIS pack. Decides the pointer wording at match time (a within-pack match must not claim "prior pack"). */
  fromPriorPack: boolean;
  /**
   * TL142-03: the server-resolved task identity (`TaskPackArgs.taskBinding`)
   * in force when THIS entry was recorded, so a later call can prove "this is
   * an unchanged repeat of the SAME task" rather than "a different request
   * happens to reuse this handle". `undefined` when the recording call itself
   * had no resolvable binding (e.g. a first, epoch:"new" call before any
   * qref/task.handle exists) — an undefined value never matches anything
   * (see applyPackDedupe), so identity that cannot be proven fails toward
   * resending, never toward a false "same task".
   */
  taskBinding: string | undefined;
}

/** Aggregate memory bound for exact-source capsules in the single-slot cache. */
export const MAX_PACK_SOURCE_CAPSULE_BYTES = 18 * 1024;

/**
 * Last pack's embedded-code fingerprints, keyed by workspace. Intentionally
 * simple: ONE entry per workspace (the design's "module-level last-pack
 * cache"), overwritten wholesale at the end of every dedupe pass — no
 * eviction policy needed since old entries are never appended, only replaced.
 */
export const lastPackBlocksByWorkspace = new Map<string, PackedBlockFingerprint[]>();

export const packFingerprintBinding = createPackFingerprintBinding(key => lastPackBlocksByWorkspace.get(key), shaOfText);

export function stagePackFingerprintBinding(workspace: string, originalResult: object, binding: string, taskHandle: string): void {
  const context = protocolCallContext();
  if (!context || context.sizePreview === true) return;
  const finalize = packFingerprintBinding.stage(originalResult, laneScopedKey(workspace), context, binding, taskHandle);
  if (finalize) context.finalizePackFingerprintBinding = finalize;
}

/**
 * Test-only reset hook (mirrors handleTable.reset()/resetAllSessions()) so
 * cross-pack dedupe state does not bleed between unrelated test cases that
 * happen to reuse the same on-disk workspace path or run in the same process.
 */
export function resetPackDedupeCache(): void {
  priorBodyRestoration.reset();
  lastPackBlocksByWorkspace.clear();
  clearSourceCapsules();
  packFingerprintBinding.reset();
  servedPacksByWorkspace.clear();
  // WP-S11: the same-task read-only serve view is per-workspace serve state of
  // exactly this kind (see its own doc block), so it goes at the same boundary.
  readOnlyServedViews.clear();
  // C2: the retained certificate is per-workspace serve state of exactly the
  // same kind, so every suite that resets the dedupe cache gets isolation here.
  certifiedWorkingSets.clear();
  // P0 defect 2/3: so is the epoch requirement contract — and it is the one
  // piece of per-workspace state that can make a LATER, unrelated case
  // uncertifiable, so every suite already resetting here gets it for free.
  resetTaskContractStoreForTest();
}

/**
 * Explicit epoch boundary for the pack-dedupe family, mirroring
 * clearTaskQueryRef's per-workspace epoch clear in state/session.ts.
 *
 * Root cause (2026-08-21 smoke-gate forensics): lastPackBlocksByWorkspace /
 * servedPacksByWorkspace / certifiedWorkingSets are keyed ONLY by the
 * resolved workspace path, with no task-epoch or session boundary. The MCP
 * server is a long-lived process in production (not restarted per task), so
 * once ANY earlier, wholly unrelated task_pack call is served against a given
 * workspace path, its fingerprints sit in these maps indefinitely. A LATER,
 * logically independent task that happens to reuse the exact same workspace
 * path (observed live: a bench harness reseals a fixed cell directory across
 * separate smoke-gate attempts at different git heads) and touches a file
 * whose content is byte-identical to what the earlier task saw gets that
 * surface's body silently replaced with a false "<handle> — see prior pack"
 * pointer — even though THIS caller, in THIS task, never actually saw it.
 * That is exactly the class of bug taskEpoch:"new" exists to prevent
 * (AGENTS.md: "a different task re-packs with taskEpoch:'new'"), but
 * server.ts's taskEpoch:"new" handling previously called only
 * clearTaskQueryRef, never this. Workspace-scoped (not the process-wide
 * resetPackDedupeCache, which would also discard OTHER workspaces'
 * legitimate in-task history).
 */
/**
 * 2026-11-03 (compaction marker, state/compactionEpoch.ts): forget, in every
 * lane of `workspace`, what this module believes the CLIENT holds: the served
 * pack records behind cached-pack, subset and semantic-duplicate receipts and
 * prior-pack pointers, the last pack's block fingerprints, the same-task
 * read-only serve view and the source capsules. After the agent host compacted
 * its conversation those claims are false, and the next pack re-sends instead.
 * The retained certificate and the epoch requirement contract stay: they are
 * the server's own proof a task's edits rest on, and the `task.epoch:"new"`
 * boundary (`clearPackDedupeForWorkspace`) is the one that drops them.
 */
export function clearServedPackClaimsForWorkspace(workspace: string): void {
  const spell = (root: string): string => {
    const resolved = path.resolve(root);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  const root = spell(workspace);
  const belongsToRoot = (key: string): boolean => spell(rootOfLaneScopedKey(key)) === root;
  for (const map of [servedPacksByWorkspace, lastPackBlocksByWorkspace, readOnlyServedViews] as Array<Map<string, unknown>>) {
    for (const key of [...map.keys()]) if (belongsToRoot(key)) map.delete(key);
  }
  clearSourceCapsulesWhere(belongsToRoot);
}

export function clearPackDedupeForWorkspace(workspace: string, lane?: string): void {
  const key = path.resolve(workspace);
  // F-V13-3: lane-scoped, so `task.epoch:"new"` clears THIS agent's caches
  // and never a peer lane's. The key SPELLING is preserved verbatim (this
  // function has always resolved, while captureServedPack keys on the raw
  // `workspace` string its caller passes); unifying it is a separate change.
  lastPackBlocksByWorkspace.delete(laneScopedKey(key));
  clearSourceCapsules(laneScopedKey(key));
  servedPacksByWorkspace.delete(laneScopedKey(key));
  certifiedWorkingSets.delete(laneScopedKey(key));
  // WP-S11: `task.epoch:"new"` is the declared task boundary, so the same-task
  // read-only serve view goes with the rest of this lane's task-scoped state —
  // its own token-overlap reset is the heuristic backstop, not a substitute.
  readOnlyServedViews.delete(laneScopedKey(key));
  // P0 defect 2 (2026-08-27): the epoch requirement contract is the same class
  // of workspace-keyed, task-scoped state, and `taskEpoch:"new"` is exactly
  // the boundary at which it must go. Doing it HERE rather than in server.ts's
  // `taskEpoch:"new"` branch keeps that branch's call list unchanged: the
  // branch already calls this function for the identical reason (see the doc
  // comment above), so the epoch reset the guide promises stays one edit.
  // Both spellings: the store keys on the string its writers pass, and those
  // writers take `workspace` verbatim while this function's own siblings key
  // on the resolved path.
  if (lane === undefined) {
    // Legacy/internal callers do not have an authenticated lane. Preserve
    // their old in-memory clearing semantics; the public server always passes
    // its validated lane below and therefore never broad-clears peer lanes.
    clearTaskContract(workspace);
    clearTaskContract(key);
    // P1-c(i): same incident class as the epoch requirement contract above
    // (see that comment) — the executed-next ledger is the other per-lane,
    // task-scoped store that must not let a later, unrelated task inherit an
    // earlier one's "already ran this" suppression.
    clearExecutedNextForWorkspace(workspace);
    clearExecutedNextForWorkspace(key);
  } else {
    clearTaskContractsForLane(workspace, lane);
    if (key !== workspace) clearTaskContractsForLane(key, lane);
    clearExecutedNextForLane(workspace, lane);
    if (key !== workspace) clearExecutedNextForLane(key, lane);
  }
  // Same incident class, one store over (2026-08-27 field-eval follow-up).
  // `priorPackStore` shipped `clearPriorPackObligations` as its declared epoch
  // boundary and then never called it from production — so an explicit
  // `taskEpoch:"new"` left a prior task's open, required, action:"edit"
  // obligations standing on a workspace path a later task reuses. The next
  // pack of that unrelated task then either packs against them (SEAM 1's
  // `queryPriorPackObligations` read) or has its OWN certificate demoted by
  // F-B3's `unserved-obligation:` disclosure — the exact "a later, logically
  // independent task inherits the earlier one's state" failure this function's
  // doc comment above describes for the dedupe maps.
  clearPriorPackObligations(workspace);
  clearPriorPackObligations(key);
}

/**
 * B5 extension (2026-09-05, markdown anchor-focus): is THIS record's own DOC
 * surface a partial serve of its file?
 *
 * `revalidateRecordToReceipt`'s B5 guard originally read one field —
 * `content_completeness:"partial"` — because on the shape it was built for
 * (a 1-line "sliver" of CONTRACT.md) that stamp was always there:
 * `applyDocSliverHonesty`'s floor put it on. The Markdown anchor-focus fix
 * removed the cause of those slivers, so an authority document is now served
 * as a coherent SECTION and `servedSpanIsSection` deliberately leaves it
 * alone — no stamp, and the guard went blind to the exact case it exists for.
 * Measured on cumulativeReissueReceipt's B5 case: a qref replay holding 11 of
 * a 1,514-line contract collapsed into a compact `pack-unchanged` receipt,
 * which has no per-evidence slot to say so.
 *
 * The repair reads the FACT instead of the stamp: a doc surface whose served
 * window provably does not cover its own file is partial, stamp or no stamp.
 * Deliberately scoped to `role === "doc"` — the class the stamp used to
 * cover — so an anchor-focused CODE symbol (a precise body, which is what
 * task_pack is for, and never a stamped partial either) keeps its receipt on
 * a replay exactly as before. Line count is read live from disk in the same
 * pass that re-verifies the surface shas, and any file it cannot measure is
 * treated as NOT partial: this guard may only ever DECLINE a receipt on
 * evidence, never on a failed read.
 */
export function recordDocSurfaceIsPartial(
  workspace: string,
  surface: ServedPackRecord["surfaces"][number],
): boolean {
  if (surface.content_completeness === "partial") return true;
  if (surface.role !== "doc") return false;
  const span = parseSurfaceSpan(surface.range);
  if (span === undefined) return false;
  const total = surface.total_lines ?? surfaceFileLineCount(workspace, surface.path);
  if (total === undefined || total <= 0) return false;
  return span.start > 1 || span.end < total;
}

/**
 * SHOULD-FIX 59 (AB1, 2026-09-14, review round 11) — A HANDLE THIS RESPONSE
 * ALREADY SERVED WHOLE IS NOT A `next`.
 *
 * `nextCallCoveredBySpans` below can only judge a call that names a RANGE
 * (`parsePackLineRange(args.range)` returns `undefined` otherwise), so the
 * commonest dead end walked straight past it: a bare `tl_read_file
 * targets:[{handle}] content:"auto"` over a handle whose body is in the SAME
 * response. Measured (round 10, the mandate's own pinned input `In src/retry.ts,
 * explain what it does and set it to 5.`): `decision.kind:"discover"` +
 * `gaps:[missing-evidence surface-content]` + a `next` re-reading handle
 * `h9uw6idmtjd`, whose 2-2 body the same pack served — and the receipt that
 * `next` produces correctly answers "you already have this" and carries NO
 * `next`, so `discover`'s own contract ("run its `next`") terminates with
 * nothing certified and no continuation. That is the dead-end-receipt class the
 * TL142-01 wave closed for the qref and `task.handle` doors, reappearing on the
 * `discover` door.
 *
 * The rule is narrow on purpose:
 *   - a call naming a range, `ranges` or a symbol is a ZOOM, judged by
 *     `nextCallCoveredBySpans` (a sub-window may genuinely be unserved);
 *   - a handle whose surface has NO served code is a real affordance (that is
 *     exactly what `gapFallback` exists for) and is never filtered;
 *   - only a bodyless RE-READ of a fully-served window is dropped, which lets
 *     the contract fall through to the next candidate, and — when nothing
 *     remains — to `requiredServed`'s "act on the served evidence" verdict
 *     (`await_input` naming the open concerns) instead of a dead end.
 */
/**
 * SHOULD-FIX 58 (AB1, 2026-09-14, review round 11) — A PATH THIS RESPONSE
 * DISCLOSED AS UNREADABLE IS NOT A `next`.
 *
 * Measured (round 10 + this wave's own door matrix): for 4 of the 5 undecodable
 * fixtures, door 1 answered `discover` with a bodyless `{why:"filename-match",
 * len:0}` surface and a prescribed `next` that returns
 * `refusal read-error` — the pack naming, as the caller's one sanctioned
 * transition, the exact read its own `missing[]` row says cannot succeed. The
 * disclosure is now reliable (see `candidateToSurface`), which makes the dead
 * end the remaining half: the same fact that produced the row must also
 * disqualify the call.
 *
 * Reads the DISCLOSURE off `result`, not the ALS store, so it holds on a re-pack
 * too (`discloseUnreadableNamedPaths` restores the rows from `missing[]`).
 */
export function nextCallTargetsUnreadablePath(result: TaskPackResult, call: ContinuationLike): boolean {
  const disclosed = new Set<string>([
    ...(result.unreadable_named_paths ?? []).map((row) => row.path),
    ...result.missing
      .map(parseUnreadableNamedPathRow)
      .filter((row): row is NonNullable<ReturnType<typeof parseUnreadableNamedPathRow>> => row !== undefined)
      .map((row) => row.path),
  ]);
  if (disclosed.size === 0) return false;
  if (call.tool !== "tl_read_file") return false;
  const args = call.arguments as Record<string, unknown>;
  const paths: string[] = [];
  if (typeof args["path"] === "string") paths.push(args["path"]);
  if (Array.isArray(args["paths"])) {
    for (const entry of args["paths"]) {
      if (typeof entry === "string") paths.push(entry);
      else if (entry !== null && typeof entry === "object" && typeof (entry as Record<string, unknown>)["path"] === "string") {
        paths.push((entry as Record<string, unknown>)["path"] as string);
      }
    }
  }
  if (Array.isArray(args["targets"])) {
    for (const entry of args["targets"]) {
      if (entry === null || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      if (typeof record["path"] === "string") paths.push(record["path"]);
      if (typeof record["handle"] === "string") {
        const owner = codeTaskPackSurfaces(result.surfaces).find((surface) => surface.handle === record["handle"]);
        if (owner !== undefined) paths.push(owner.path);
      }
    }
  }
  if (typeof args["handle"] === "string") {
    const owner = codeTaskPackSurfaces(result.surfaces).find((surface) => surface.handle === args["handle"]);
    if (owner !== undefined) paths.push(owner.path);
  }
  // Only a call whose ENTIRE target set is disclosed-unreadable is a dead end;
  // a batch that also names a readable path still advances.
  return paths.length > 0 && paths.every((candidate) => disclosed.has(candidate));
}

export function nextCallReReadsServedWindow(
  result: TaskPackResult,
  call: ContinuationLike,
  spans: ReadonlyMap<string, ReadonlyArray<readonly [number, number]>>,
): boolean {
  if (call.tool !== "tl_read_file") return false;
  const args = call.arguments as Record<string, unknown>;
  // A zoom/symbol request is a different question — see the doc comment.
  if (args["range"] !== undefined || args["ranges"] !== undefined || args["symbol"] !== undefined) return false;
  const firstTarget = Array.isArray(args["targets"]) && args["targets"].length === 1
    ? args["targets"][0]
    : undefined;
  const targetRecord = firstTarget !== null && typeof firstTarget === "object"
    ? firstTarget as Record<string, unknown>
    : undefined;
  if (targetRecord !== undefined
    && (targetRecord["range"] !== undefined || targetRecord["ranges"] !== undefined || targetRecord["symbol"] !== undefined)) {
    return false;
  }
  const handle = typeof args["handle"] === "string"
    ? args["handle"]
    : typeof targetRecord?.["handle"] === "string"
      ? targetRecord["handle"] as string
      : undefined;
  if (handle === undefined) return false;
  const surface = codeTaskPackSurfaces(result.surfaces).find((candidate) => candidate.handle === handle);
  if (surface === undefined || !hasServedCode(surface)) return false;
  const range = parsePackLineRange(surface.range);
  if (range === undefined) return false;
  return spans.get(surface.path)?.some(([start, end]) => start <= range[0] && end >= range[1]) === true;
}
