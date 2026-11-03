// readinessObligations — extracted implementation; imports point to the owning modules.
import type { ServedSurfaceEntry } from "../../../util/packServeLog.js";
import type { TaskPackResult } from "../model.js";
import type { TaskPackSurface } from "../model.js";

/**
 * FX-J (2026-09-03) — THE EXPLICIT CANDIDATE FEED.
 *
 * Two contract-build consumers (`priorEpochActionFrontier` and
 * `epochServedEvidence`) read the cumulative served-surface log, and until
 * FX-J the log had already been written with THIS pack's own surfaces by the
 * time they ran, so both saw them. FX-J defers that write past the SF
 * pre-booking seam whenever `TL_SF_DEMOTE` is on, because a body the seam is
 * still allowed to withhold must not be logged as served (round-14 finding 1:
 * a demoted, never-served handle rode `priorEpochActionFrontier` into the NEXT
 * same-epoch certificate's `action_frontier`, where the execution-typestate
 * gate admitted a blind edit of it).
 *
 * Deferring the write must not silently NARROW the contract, so this is the
 * ratified alternative (DESIGN-v0.15 §12 FX-J, orchestrator ruling R3 shape
 * B): feed the pack's own candidate surfaces to those consumers EXPLICITLY
 * instead of writing them to the log early. The emulation is exact — the log
 * keys entries by path and orders them by serve sequence, so a pending surface
 * REPLACES a same-path logged entry and sorts after every genuinely earlier
 * one, which is precisely what `recordServedSurfaces` would have produced.
 *
 * FX-K (round-15 finding 5): the emulation must also match the log write's
 * REFRESH semantics, not just its output. `recordServedSurfaces` rewrote each
 * of this pack's own paths with a fresh fingerprint BEFORE this read, so
 * `queryServedSurfaces`'s revalidation of those paths trivially passed. With
 * the write deferred, revalidation runs first and is DESTRUCTIVE — a stale
 * entry is deleted from `entries` and spliced out of `order`, changing that
 * path's FIFO eviction position at `MAX_LOGGED_PATHS`. The fix is to not
 * consult them at all: every pending path is supplied from `pending` below and
 * is filtered out of `logged` anyway, so excluding it from the query is
 * output-identical AND leaves the log entry exactly where the historical
 * refresh left it. `sfEpochServedEntries.spec.ts` pins both halves.
 *
 * `pendingOwnServedSurfaces` is populated for every pack whose surfaces feed
 * the booking pass; with no pending entry this function is
 * `queryServedSurfaces` verbatim.
 */
export const pendingOwnServedSurfaces = new WeakMap<TaskPackResult, TaskPackSurface[]>();

/**
 * WP-S11 (2026-09-20) — THE SAME-TASK READ-ONLY SERVE VIEW.
 *
 * `finalizePackServeState`'s `cumulativeEligible` deliberately keeps a pack
 * whose caller DECLARED `task.profile:"answer"` out of the cumulative
 * served-surface log, so a read-only task never acquires the edit-closure
 * semantics that log carries (`priorEpochActionFrontier`, the cumulative
 * coverage flip, the certificate's action frontier). That exclusion is the
 * reviewed constraint stated at the `cumulativeEligible` line, and it stays.
 *
 * Its measured side effect did not belong to it. Because a declared-answer
 * pack recorded NOTHING, a second pack OF THE SAME TASK — a `qref` replay or
 * the same task handle — consulted an empty log and re-minted identifier and
 * request-item obligations that the FIRST pack of that same task had already
 * discharged, with bodies the caller still holds and nothing changed on disk.
 * The certificate contradicted this server's own earlier evidence, and every
 * further re-pack kept the task open (measured: a three-call relay loop whose
 * third call proposed `find ["OrderService"]` for a body call one had served).
 *
 * This view closes that gap and nothing else. It is a SEPARATE store, never
 * the pack serve log, and exactly ONE reader opts into it —
 * `epochServedEvidence`, the readiness-obligation evidence reader. The edit
 * fence, `priorEpochActionFrontier`, `applyCumulativeCoverage`,
 * `attachFrontierIndex` and every other `queryServedSurfaces` consumer read
 * the real log and therefore see nothing new.
 *
 * TASK BINDING is the pack serve log's own contract: entries live under the
 * recording query's epoch tokens, a non-overlapping task resets the view
 * before recording, and a read whose tokens do not overlap returns nothing —
 * so a different task, epoch or lane can never discharge this task's
 * obligation. Unlike the log this view fails CLOSED on an empty token list on
 * both sides: an unbound entry is precisely what must not count.
 *
 * RESIDENCY is the reader's own, stricter rule. These entries carry no bytes:
 * `epochServedEvidence` reconstructs a path only from the session's
 * served-range ledger, and only while that ledger's sha still matches the file
 * on disk right now, so a file edited since it was served yields no evidence.
 * Any future opt-in reader owes the same content check.
 */
export interface ReadOnlyServedView {
  epochTokens: string[];
  entries: Map<string, ServedSurfaceEntry>;
  seq: number;
}

/** Bounded exactly like the pack serve log's FIFO, for the same reason. */
export const MAX_READ_ONLY_VIEW_PATHS = 512;

export const readOnlyServedViews = new Map<string, ReadOnlyServedView>();
