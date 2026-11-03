// epochEvidence — extracted implementation; imports point to the owning modules.
import * as path from "path";
import type { ServedSurfaceEntry } from "../../../util/packServeLog.js";
import type { TaskPackResult } from "../model.js";
import type { TaskPackSurface } from "../model.js";
import { MAX_READ_ONLY_VIEW_PATHS } from "./readinessObligations2.js";
import { classifySurface } from "../../../util/impact.js";
import { laneScopedKey } from "../../../util/laneKey.js";
import { pendingOwnServedSurfaces } from "./readinessObligations2.js";
import { queryPriorPackObligations } from "../priorPackStore.js";
import { queryServedSurfaces } from "../../../util/packServeLog.js";
import { readOnlyServedViews } from "./readinessObligations2.js";
import { reconstructServedEntryEvidence } from "./epochContract3.js";
import { requestItemLeads } from "../requestItems.js";
import { tokenizeForEpoch } from "../../../state/session.js";

export function readOnlyServedViewKey(workspace: string): string {
  return laneScopedKey(path.resolve(workspace));
}

export function epochTokensOverlap(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const set = new Set(a);
  return b.some((token) => set.has(token));
}

export function recordReadOnlyServedSurfaces(
  workspace: string,
  surfaces: readonly TaskPackSurface[],
  epochTokens: readonly string[],
): void {
  if (epochTokens.length === 0) return;
  const key = readOnlyServedViewKey(workspace);
  let view = readOnlyServedViews.get(key);
  if (view === undefined) {
    view = { epochTokens: [], entries: new Map(), seq: 0 };
    readOnlyServedViews.set(key, view);
  } else if (view.epochTokens.length > 0 && !epochTokensOverlap(epochTokens, view.epochTokens)) {
    // A different task in the same lane — the same boundary
    // `recordServedSurfaces` applies to the real log.
    view.epochTokens = [];
    view.entries.clear();
  }
  const seen = new Set(view.epochTokens);
  for (const token of epochTokens) {
    if (seen.has(token)) continue;
    seen.add(token);
    view.epochTokens.push(token);
  }
  for (const surface of surfaces) {
    if (typeof surface.path !== "string" || surface.path.length === 0) continue;
    // Last occurrence wins AND moves to the end, matching the log's ordering.
    view.entries.delete(surface.path);
    view.entries.set(surface.path, {
      path: surface.path,
      role: surface.role,
      ...(surface.handle ? { handle: surface.handle } : {}),
      // No stat identity of its own: the one reader revalidates by content sha
      // against the served-range ledger, which is strictly stronger.
      fingerprint: "",
      servedAt: ++view.seq,
    });
  }
  while (view.entries.size > MAX_READ_ONLY_VIEW_PATHS) {
    const oldest = view.entries.keys().next();
    if (oldest.done === true) break;
    view.entries.delete(oldest.value);
  }
}

export function readOnlyServedEntries(
  workspace: string,
  epochTokens: readonly string[],
): ServedSurfaceEntry[] {
  const view = readOnlyServedViews.get(readOnlyServedViewKey(workspace));
  if (view === undefined || view.entries.size === 0) return [];
  if (!epochTokensOverlap(epochTokens, view.epochTokens)) return [];
  return [...view.entries.values()].sort((a, b) => a.servedAt - b.servedAt);
}

/**
 * Test-only inspector for the same-task read-only serve view, in the same
 * spirit as `resetPackDedupeCache` above: the view is module state with no
 * wire projection of its own, so its task/lane binding and its residency gate
 * can only be pinned from here. `paths` is what the view holds for this epoch
 * AFTER its task/lane gate; `carried` is what a readiness obligation actually
 * receives — i.e. after the served-range ledger's sha check, which is where a
 * file edited since it was served drops out.
 */
export function readOnlyServedViewForTest(
  workspace: string,
  epochTokens: readonly string[],
): { paths: string[]; carried: Array<{ path: string; range: string }> } {
  const entries = readOnlyServedEntries(workspace, epochTokens);
  return {
    paths: entries.map((entry) => entry.path),
    carried: reconstructServedEntryEvidence(workspace, entries)
      .map((surface) => ({ path: surface.path, range: surface.range ?? "" })),
  };
}

/**
 * R-A2 item 1 (2026-09-21 fix wave, held item 4): admits a PLAIN
 * caller-ranged serve — server.ts's own single-target/batch
 * `targets:[{path|handle, range}]` dispatch, which never runs through
 * `buildTaskPack` at all — into this SAME read-only view. Without this,
 * "query -> discover -> the caller zooms by handle instead of running `next`
 * verbatim -> a bare `{qref}` re-pack" left the re-pack blind to bytes the
 * caller already holds: `recordReadOnlyServedSurfaces` above is reachable
 * only from `bookShippedPackServeState`, i.e. only a task-pack BUILD ever
 * wrote here.
 *
 * `epochTokens` is the CALLER's (server.ts's) determination of which
 * declared-answer epoch this serve belongs to — this function does not
 * second-guess it, except for one fallback: an EMPTY array means "no
 * explicit `task.handle` resolved to an epoch", in which case this falls
 * back to whatever epoch this SAME (workspace, lane) view already has open.
 * That fallback can never leak a generic/edit task's state, because a live
 * view only ever holds tokens a declared-answer pack's own
 * `recordReadOnlyServedSurfaces` call wrote in the first place (this
 * module's write-gate, above) — an empty/absent view (no answer epoch ever
 * opened in this lane) makes the fallback a deliberate no-op, matching "a
 * zoom with no task binding at all -> today's behaviour" exactly. A file
 * whose sha has since changed is handled by the existing reader, not here:
 * `reconstructServedEntryEvidence` re-checks the served-range ledger's sha
 * against the file on disk every time, so a stale entry simply yields no
 * evidence rather than needing a second invalidation path.
 *
 * Deliberately mirrors `recordReadOnlyServedSurfaces`'s own shape (a minimal
 * `TaskPackSurface`; `range` is unused by that function) instead of exposing
 * the view's internals to server.ts. Role is inferred the same coarse way
 * every other unclassified surface gets one (`classifySurface`), since a
 * plain ranged read carries no task-inferred role of its own.
 */
export function recordReadOnlyServedRangedServe(
  workspace: string,
  entry: { path: string; handle: string },
  epochTokens: readonly string[],
): void {
  const tokens = epochTokens.length > 0
    ? epochTokens
    : (readOnlyServedViews.get(readOnlyServedViewKey(workspace))?.epochTokens ?? []);
  if (tokens.length === 0) return;
  recordReadOnlyServedSurfaces(
    workspace,
    [{ role: classifySurface(entry.path), handle: entry.handle, path: entry.path, range: "" }],
    tokens,
  );
}

export function epochServedSurfaceEntries(
  workspace: string,
  epochTokens: readonly string[],
  result?: TaskPackResult,
): ServedSurfaceEntry[] {
  const pending = result === undefined ? undefined : pendingOwnServedSurfaces.get(result);
  if (pending === undefined || pending.length === 0) {
    return queryServedSurfaces(workspace, workspace, { epochTokens });
  }
  const byPath = new Map<string, ServedSurfaceEntry>();
  for (const surface of pending) {
    if (typeof surface.path !== "string" || surface.path.length === 0) continue;
    // Last occurrence wins AND moves to the end — `recordServedSurfaces`
    // overwrites the entry and bumps its `servedAt`.
    byPath.delete(surface.path);
    byPath.set(surface.path, {
      path: surface.path,
      role: surface.role,
      ...(surface.handle ? { handle: surface.handle } : {}),
      fingerprint: "",
      servedAt: 0,
    });
  }
  const logged = queryServedSurfaces(workspace, workspace, {
    epochTokens,
    excludePaths: new Set(byPath.keys()),
  });
  return [...logged, ...byPath.values()];
}

/**
 * WP-S11 — `epochServedSurfaceEntries` plus, for an ANSWER pack only, the
 * same-task read-only serve view.
 *
 * A wrapper rather than a fourth parameter on purpose: FX-K's refresh/
 * revalidation contract for this pack's own pending paths lives inside
 * `epochServedSurfaceEntries` and `sfEpochServedEntries.spec.ts` pins its
 * source shape, so the merge belongs strictly outside it. A logged entry
 * always wins over a view entry for the same path — it went through
 * `queryServedSurfaces`'s revalidation and may carry the range-aware
 * `fullyServed` verdict this view has no opinion about.
 */
export function epochServedSurfaceEntriesWithView(
  workspace: string,
  epochTokens: readonly string[],
  result: TaskPackResult | undefined,
  includeReadOnlyServedView: boolean,
): ServedSurfaceEntry[] {
  const base = epochServedSurfaceEntries(workspace, epochTokens, result);
  if (!includeReadOnlyServedView) return base;
  const readOnly = readOnlyServedEntries(workspace, epochTokens);
  if (readOnly.length === 0) return base;
  const known = new Set(base.map((entry) => entry.path));
  return [...base, ...readOnly.filter((entry) => !known.has(entry.path))];
}

/**
 * P0 defect 3: same-epoch evidence the caller ALREADY holds, as certificate
 * frontier entries — served-surface handles plus the still-open edit
 * obligations an earlier pack of this task recorded.
 *
 * Not a widening of write permission: `recordServedEditAdmissibility` already
 * admits every content-bearing serve for the rest of the epoch, and
 * priorPackStore's entries are obligations this server itself published. What
 * this closes is the DISAGREEMENT — the primary certificate named only the
 * current call's frontier, so the three existing nets (session's admissible
 * union via the mid-fence receipt, the qref-replay carry-forward, F-B3) were
 * the only things that remembered pack 1, and none of them reaches this path.
 *
 * Bounded at FRONTIER_HANDLE_CAP parity (32) before the certificate applies
 * its own 12-entry cap; current-call entries always sort first, so prior
 * evidence can only fill slots the current call left empty.
 */
export const PRIOR_EPOCH_FRONTIER_CAP = 32;

export function priorEpochActionFrontier(
  workspace: string,
  query: string,
  result?: TaskPackResult,
  // GATE-A (2026-09-14): DESIGN-v0.15 §4.2 (IL-W2) — once an `tl_edit_file` has
  // landed this task epoch the request's own wording is no longer the
  // authority about what the task may write; see `writeAuthorityVeto`.
  editObserved = false,
): string[] {
  const epochTokens = tokenizeForEpoch(query);
  if (epochTokens.length === 0) return [];
  // r4-should-fix-26-propagation-route residual (2026-09-14): this ledger's
  // own contract is "every content-bearing serve is admissible for the rest
  // of the epoch" (see this function's own doc comment) — deliberately
  // broad for the ordinary "read it, then decide to edit it" workflow, but
  // it must not re-open write authority THIS SAME query's own wording just
  // closed for a path served ONLY as read/explain evidence (the reviewer's
  // repro: `buildTaskChangeContract` already marks src/cache.ts
  // `action:"review"`, yet its served handle re-entered here on the very
  // next internal pass of the same call). Same veto, same shared source of
  // truth as `buildTaskChangeContract`/`actionFrontierForCertificate`.
  const readOnlyLeadPaths: ReadonlySet<string> = editObserved
    ? new Set<string>()
    : new Set(
      requestItemLeads(query).filter((entry) => entry.lead === "read").map((entry) => entry.path),
    );
  const handles = epochServedSurfaceEntries(workspace, epochTokens, result)
    .filter((entry) => !readOnlyLeadPaths.has(entry.path))
    .map((entry) => entry.handle)
    .filter((handle): handle is string => typeof handle === "string" && handle.length > 0);
  const obligationPaths = queryPriorPackObligations(workspace, epochTokens)
    .filter((obligation) => obligation.open && obligation.action === "edit" && !readOnlyLeadPaths.has(obligation.path))
    .map((obligation) => obligation.path);
  return [...new Set([...handles, ...obligationPaths])].slice(0, PRIOR_EPOCH_FRONTIER_CAP);
}
