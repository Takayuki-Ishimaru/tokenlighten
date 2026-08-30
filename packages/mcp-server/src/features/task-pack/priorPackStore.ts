/**
 * priorPackStore.ts — V11-03 task-scoped prior-pack obligation memory.
 *
 * `util/packServeLog.ts` STYLE (same in-process, per-workspace-root Map,
 * epoch-token-overlap gating, bounded FIFO, `resetForTest` hook), reused
 * DELIBERATELY rather than duplicated: `packServeLog.ts`'s own
 * `recordServedSurfaces` / `queryServedSurfaces` already give a v2 packer
 * everything it needs for "(a) avoid re-spending bytes on already-served
 * surfaces (identity-level only)" — content-fingerprint-revalidated served
 * PATH/ROLE/HANDLE identity, task-epoch-scoped. This module does not repeat
 * that; it owns the one thing packServeLog does not track: OBLIGATIONS.
 *
 * So: "(a) surfaces/roles" is satisfied by composition (the caller seam
 * consults `queryServedSurfaces` directly, exactly as the v1 seam already
 * does via its `priorServed` projection), and this module satisfies
 * "(b) provide the prior-obligation context that change_contract threading
 * needs" — recording, per task epoch, the change_contract obligations a
 * prior pack built (post-surfaces), so the NEXT pack in the SAME task can
 * fold them into `coveragePackerV2`'s own `obligations` input and so the
 * finalizer can detect an obligation whose target went unserved in a LATER
 * pack of the same task (see readCodeTaskPack.ts's second seam, in
 * `dedupeTrimAndPersist`).
 *
 * Explicitly NOT this module's job (reconciliation §1 D-1 / the workstream
 * brief): completeness/serve-honesty stay the receipt machinery's job. This
 * store never touches `tryServeCachedPack` / `tryServeSubsetReceipt` /
 * `revalidateRecordToReceipt` / `compactReceiptFromRecord` / certificate
 * functions, and nothing here is a wire object — `PriorObligationRecord` is
 * an INTERNAL shape, independent of (structurally similar to, but not
 * imported from) the wire `TaskChangeObligation`, so a future wire-shape
 * churn there cannot silently change this store's persisted shape.
 *
 * Process-local cache posture is fine here (v0.11 kickoff doc §1): this is
 * an optimization (fewer re-spent bytes, richer obligation context across
 * calls in the SAME task), never a correctness dependency — a cold/empty
 * store just means the next pack starts from zero prior-obligation context,
 * exactly like today.
 */

import { laneScopedKey } from "../../util/laneKey.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * One change_contract obligation a prior pack in this task built, kept just
 * long enough for the next pack in the SAME task epoch to consult it.
 * Structurally close to (but independent of) the wire `TaskChangeObligation`
 * — see the module header.
 */
export interface PriorObligationRecord {
  readonly id: string;
  readonly path: string;
  readonly role: string;
  readonly kind: string;
  readonly action: "edit" | "review";
  readonly required: boolean;
  /** Recorded open/closed at capture time. A caller re-querying this on a LATER pack decides for itself whether the target is now served — this store does not re-derive "still open" on its own. */
  readonly open: boolean;
}

interface WorkspaceObligationLog {
  /** Accumulated significant tokens of the task epoch these obligations belong to (caller-supplied, SAME convention as packServeLog). */
  epochTokens: string[];
  /** obligation id -> most recently recorded obligation. */
  entries: Map<string, PriorObligationRecord>;
  /** FIFO order of ids for bounded eviction (oldest first). */
  order: string[];
}

// ---------------------------------------------------------------------------
// Bounds & module state
// ---------------------------------------------------------------------------

/** Bounded registry: at most this many distinct tracked obligations per workspace (FIFO), same discipline as packServeLog's MAX_LOGGED_PATHS. */
const MAX_TRACKED_OBLIGATIONS = 256;

const _logs = new Map<string, WorkspaceObligationLog>();

function _emptyLog(): WorkspaceObligationLog {
  return { epochTokens: [], entries: new Map(), order: [] };
}

/**
 * F-V13-3 (2026-08-30): keyed by (workspace root, CALLER'S LANE), the same
 * `packServeLog` discipline this module mirrors everywhere else. Obligations
 * are per-agent by nature — `priorEpochActionFrontier` turns an open
 * `action:"edit"` obligation into a certificate frontier entry, so a
 * workspace-only key let one agent's edit obligations authorize (and, via
 * F-B3's unserved-obligation disclosure, demote) another agent's pack.
 * `laneScopedKey` returns the root string itself when no lane is bound, so a
 * single agent keys exactly as before.
 *
 * The lane ALS lives in the dependency-free `util/laneKey.ts` leaf precisely so
 * this module keeps its "only dependency is the I/O it does not do" posture.
 */
function _logKey(workspaceRoot: string): string {
  return laneScopedKey(workspaceRoot);
}

function _getLog(workspaceRoot: string): WorkspaceObligationLog {
  const key = _logKey(workspaceRoot);
  let log = _logs.get(key);
  if (log === undefined) {
    log = _emptyLog();
    _logs.set(key, log);
  }
  return log;
}

/** True when the two token lists share at least one entry (both non-empty). Same predicate packServeLog.ts uses, duplicated rather than imported to keep this module's only dependency the (nonexistent) I/O it does not do. */
function _tokensOverlap(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const set = new Set(a);
  return b.some((t) => set.has(t));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Record the obligations a freshly-finalized change_contract carries, under
 * the task epoch identified by `epochTokens`. A genuinely NEW task
 * (non-empty incoming tokens with ZERO overlap against the stored epoch)
 * resets the log first — same "new task, clean slate" rule as
 * `packServeLog.recordServedSurfaces`, so an unrelated later task can never
 * inherit a prior task's obligations. Idempotent per obligation id (a later
 * call with the same id replaces the earlier record).
 */
export function recordPriorPackObligations(
  workspaceRoot: string,
  epochTokens: readonly string[],
  obligations: readonly PriorObligationRecord[],
): void {
  const log = _getLog(workspaceRoot);
  if (
    epochTokens.length > 0
    && log.epochTokens.length > 0
    && !_tokensOverlap(epochTokens, log.epochTokens)
  ) {
    log.epochTokens = [];
    log.entries = new Map();
    log.order = [];
  }

  const seenTok = new Set(log.epochTokens);
  for (const t of epochTokens) {
    if (!seenTok.has(t)) {
      seenTok.add(t);
      log.epochTokens.push(t);
    }
  }

  for (const o of obligations) {
    if (typeof o.id !== "string" || o.id.length === 0) continue;
    if (!log.entries.has(o.id)) log.order.push(o.id);
    log.entries.set(o.id, o);
  }

  while (log.order.length > MAX_TRACKED_OBLIGATIONS) {
    const evict = log.order.shift();
    if (evict !== undefined) log.entries.delete(evict);
  }
}

/**
 * The obligations recorded so far for this task epoch, oldest first. Returns
 * `[]` when the stored epoch does not overlap `epochTokens` (a different
 * task) or nothing has been recorded yet — never throws, never guesses.
 */
export function queryPriorPackObligations(
  workspaceRoot: string,
  epochTokens: readonly string[],
): PriorObligationRecord[] {
  const log = _logs.get(_logKey(workspaceRoot));
  if (log === undefined || log.entries.size === 0) return [];
  if (
    epochTokens.length > 0
    && log.epochTokens.length > 0
    && !_tokensOverlap(epochTokens, log.epochTokens)
  ) {
    return [];
  }
  return log.order
    .map((id) => log.entries.get(id))
    .filter((entry): entry is PriorObligationRecord => entry !== undefined);
}

/** Drop every tracked obligation for a workspace (epoch reset / taskEpoch:"new"). */
export function clearPriorPackObligations(workspaceRoot: string): void {
  const log = _logs.get(_logKey(workspaceRoot));
  if (log === undefined) return;
  log.epochTokens = [];
  log.entries = new Map();
  log.order = [];
}

// ---------------------------------------------------------------------------
// Test hook
// ---------------------------------------------------------------------------

/** Clear ALL per-workspace state — used by specs' beforeEach for isolation. */
export function resetPriorPackStoreForTest(): void {
  _logs.clear();
}
