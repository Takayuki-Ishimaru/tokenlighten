/**
 * laneKey.ts — the ONE definition of "which concurrent agent is calling", and
 * the composite-key derivation every lane-partitioned store shares.
 *
 * WHY THIS IS ITS OWN LEAF MODULE (imports: `node:async_hooks` ONLY).
 *
 * Session lanes (2026-08-07) shipped inside `state/session.ts`, so only
 * `WorkspaceSession` could ask "whose call is this?". Every store BELOW that
 * layer — the served-surface log (`util/packServeLog.ts`), the prior-pack
 * obligation memory (`features/task-pack/priorPackStore.ts`), and the three
 * task_pack caches in `readCodeTaskPack.ts` (last-pack fingerprints, served
 * pack records, the retained certificate) — keyed on the workspace root ALONE.
 * Two agents multiplexed over one server process against one checkout
 * therefore shared them.
 *
 * F-V13-3 (2026-08-30 decision-run forensics) is what that costs. lane
 * `canon-plan` asked to create a new file and was refused four times running
 * with `execution-typestate`, citing a certificate (`ready-b6689a697f11ddfb`)
 * whose frontier named three files lane `canon-ledger` was editing at that
 * moment — `carryForwardCertifiedWorkingSet` had cloned the OTHER lane's
 * execution contract onto this lane's qref replay, because
 * `certifiedWorkingSets` is one slot per workspace and the last writer wins.
 * The same single-slot store runs the other way too: a lane that never served
 * `src/a.ts` inherits a peer lane's prepared certificate over it and its edit
 * is authorized on evidence it does not hold. Neither `task.epoch:"new"` nor
 * a freshly earned certificate could clear it, because the peer lane simply
 * wrote the slot again.
 *
 * Living in `state/session.ts` was not an option: `packServeLog.ts` and
 * `priorPackStore.ts` are deliberately dependency-free leaves (see their
 * module headers), and `state/session.ts` imports `util/flags.js`. A leaf
 * module keeps the import graph acyclic and lets the lowest store in the
 * stack ask the question.
 *
 * BACKWARD COMPATIBILITY IS EXACT. `laneScopedKey(root)` returns the
 * workspace string ITSELF — same identity, not merely an equal value — when
 * no lane is bound. A single agent (which never sends `lane`) therefore keys
 * every one of these stores byte-for-byte as before this module existed.
 * That is why `currentSessionLane()`'s `""` sentinel is used here and
 * `normalizeContractLane`'s `"default"` spelling deliberately is NOT: the
 * latter would rewrite every existing key.
 *
 * BOUNDS: composite keys accumulate one entry per (root, lane) pair a
 * long-lived process observes, and none of the five stores evicts by lane.
 * Each is already individually bounded (MAX_LOGGED_PATHS,
 * MAX_TRACKED_OBLIGATIONS, MAX_CACHED_PACKS_PER_WORKSPACE, one certificate
 * per key), so the growth is the lane cardinality of the orchestrator — small
 * and cooperative in every observed topology. An LRU over lanes is left for
 * whenever a real deployment shows unbounded lane churn.
 */

import { AsyncLocalStorage } from "node:async_hooks";

const _sessionLane = new AsyncLocalStorage<string>();

/** Runs fn with every lane-scoped lookup bound to the given lane ("" = default). */
export function runWithSessionLane<T>(lane: string, fn: () => T): T {
  return lane === "" ? fn() : _sessionLane.run(lane, fn);
}

/** The lane bound to the current async context; "" outside any lane. */
export function currentSessionLane(): string {
  return _sessionLane.getStore() ?? "";
}

/**
 * NUL never occurs in a filesystem path, so a composite key cannot collide
 * with a real root, and `rootOfLaneScopedKey` is an exact inverse for the
 * registry scans that must keep reporting plain roots (otherActiveRoots).
 */
export const LANE_KEY_MARKER = "\u0000lane:";

/**
 * The lane-partitioned key for a workspace-keyed store. Returns
 * `workspaceRoot` UNCHANGED in the default (lane-less) session — see the
 * backward-compatibility note in the module header.
 */
export function laneScopedKey(workspaceRoot: string): string {
  const lane = currentSessionLane();
  return lane === "" ? workspaceRoot : workspaceRoot + LANE_KEY_MARKER + lane;
}

/** Exact inverse of `laneScopedKey`: the plain root a composite key names. */
export function rootOfLaneScopedKey(key: string): string {
  const marker = key.indexOf(LANE_KEY_MARKER);
  return marker === -1 ? key : key.slice(0, marker);
}
