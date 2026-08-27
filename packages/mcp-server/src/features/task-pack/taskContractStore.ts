/**
 * taskContractStore.ts — task-scoped REQUIREMENT memory (P0 defect 2/3).
 *
 * `priorPackStore.ts` STYLE, and for the same reason: an in-process,
 * per-workspace-root Map, epoch-token-overlap gating, bounded FIFO, and a
 * `resetForTest` hook. `priorPackStore` owns OBLIGATIONS (what a prior pack
 * said must be edited); this module owns the REQUIREMENT MODEL (what a prior
 * pack said must be COVERED before anything may be certified complete).
 *
 * THE DEFECT THIS CLOSES. `requiredSurfacesForTask` returned the roles it
 * could infer from THAT CALL's query text, and the concern-token axis
 * (`unmatchedConcernTokens`) was re-derived per call from the same text. Both
 * therefore SHRANK with the query: a narrowed continuation of a broad task
 * ("...now just the validator") certified `coverage:"complete"` against a
 * requirement universe the earlier, broader pack had never agreed to drop.
 * Requirements are MONOTONE within a task epoch, so the union of everything
 * the epoch has ever required is the only honest universe to certify against.
 *
 * EPOCH IDENTITY is the caller-supplied significant-token list every sibling
 * store already uses (`tokenizeForEpoch`), but the MATCH is deliberately
 * stricter than `priorPackStore`'s "share at least one token", and the stored
 * identity is deliberately NOT unioned across packs. Both departures have the
 * same cause: this store's payload is a REQUIREMENT, so a false match does not
 * merely cost a re-check the way a stale obligation does — it makes an
 * unrelated later task permanently uncertifiable. A unioned identity also
 * creeps: every pack widens the token set, so the probability of colliding
 * with a genuinely different task grows monotonically over a long-lived
 * server's life on one workspace. The predicate is `readCodeTaskPack.ts`'s own
 * `PENDING_CANDIDATE_TOKEN_OVERLAP` — "the same request restated" is a 0.6
 * share of the SMALLER token set — which is exactly the relation a narrowed
 * (or widened) continuation has to its source query, and which an unrelated
 * task that happens to mention one shared identifier does not.
 * `clearTaskContract` is the explicit `taskEpoch:"new"` boundary.
 *
 * FAIL-CLOSED means "no stored contract → exactly today's behavior": a cold
 * store, a queryless pack (no significant tokens, so nothing proves task
 * identity), or a process restart all degrade to per-call inference. That is
 * the pre-existing behavior, never a new one, so a lost store can only lose
 * the tightening — it can never invent a requirement.
 *
 * Nothing here is a wire object and nothing here does I/O. `TaskContractRecord`
 * is an INTERNAL shape; a future wire-shape churn in `TaskPackResult` cannot
 * silently change what this store persists.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The monotone requirement model accumulated across one task epoch. */
export interface TaskContractRecord {
  /**
   * The FULL source query of the FIRST pack of this epoch, verbatim — the
   * broadest statement of intent the epoch has seen, and the one a lossless
   * continuation must be able to restore. Never an excerpt.
   */
  readonly query: string;
  /** Post-inference required surface roles, unioned over the epoch. */
  readonly requiredRoles: readonly string[];
  /**
   * Identifier-shaped concern tokens, unioned over the epoch. Already
   * shape-filtered at record time: the caller that observed the query is the
   * only one that can decide shape, and re-deriving it from a LATER, narrower
   * query is exactly the shrinkage this store exists to prevent.
   */
  readonly concernTokens: readonly string[];
  /**
   * Surface roles this epoch has actually SERVED, unioned over the epoch.
   * The satisfied half of the model: coverage is monotone for the same reason
   * requirement is, and without it a role a PRIOR pack served would read as
   * unserved the moment a later pack stopped carrying that surface.
   */
  readonly servedRoles: readonly string[];
  /** Concern tokens this epoch's served evidence has already matched, unioned over the epoch. */
  readonly coveredConcernTokens: readonly string[];
}

interface WorkspaceTaskContract {
  /** The FIRST pack's significant tokens — the epoch's fixed identity anchor, never widened (see the module header). */
  epochTokens: string[];
  /** First non-empty query seen in this epoch; never overwritten while the epoch stands. */
  query: string;
  requiredRoles: string[];
  concernTokens: string[];
  servedRoles: string[];
  coveredConcernTokens: string[];
}

// ---------------------------------------------------------------------------
// Bounds & module state
// ---------------------------------------------------------------------------

/** Role vocabulary is small and closed; this bound only stops a pathological caller-supplied `surfaceRoles`. */
const MAX_TRACKED_REQUIRED_ROLES = 16;
/** Same discipline as priorPackStore's MAX_TRACKED_OBLIGATIONS, sized for the 4-per-pack concern cap. */
const MAX_TRACKED_CONCERN_TOKENS = 32;

const _contracts = new Map<string, WorkspaceTaskContract>();

/** Minimum share of the SMALLER token set two queries must share to be "the same request restated" — `readCodeTaskPack.ts`'s PENDING_CANDIDATE_TOKEN_OVERLAP, duplicated rather than imported so this module keeps depending on nothing. */
const SAME_TASK_TOKEN_OVERLAP = 0.6;

/** True when `incoming` and the stored identity are the same request restated. See the module header for why this is stricter than priorPackStore's any-shared-token rule. */
function _sameTask(incoming: readonly string[], stored: readonly string[]): boolean {
  if (incoming.length === 0 || stored.length === 0) return false;
  const set = new Set(stored);
  const shared = incoming.filter((token) => set.has(token)).length;
  return shared / Math.min(incoming.length, stored.length) >= SAME_TASK_TOKEN_OVERLAP;
}

/** Append unique entries, evicting OLDEST first once the cap binds. */
function _appendBounded(list: string[], incoming: readonly string[], cap: number): void {
  const seen = new Set(list);
  for (const entry of incoming) {
    if (typeof entry !== "string" || entry.length === 0 || seen.has(entry)) continue;
    seen.add(entry);
    list.push(entry);
  }
  while (list.length > cap) list.shift();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Record what THIS pack of the epoch requires. Union-merges into the standing
 * record (requirements are monotone); a non-overlapping epoch resets first.
 *
 * A pack with no significant tokens is ignored outright — it cannot prove task
 * identity, and folding it into a standing record would let an unrelated
 * pathless/symbol-only call inherit (or widen) another task's requirements.
 */
export function recordTaskContract(
  workspaceRoot: string,
  epochTokens: readonly string[],
  observed: {
    query?: string;
    requiredRoles?: readonly string[];
    concernTokens?: readonly string[];
    servedRoles?: readonly string[];
    coveredConcernTokens?: readonly string[];
  },
): void {
  if (epochTokens.length === 0) return;
  let record = _contracts.get(workspaceRoot);
  if (record !== undefined && !_sameTask(epochTokens, record.epochTokens)) {
    record = undefined;
  }
  if (record === undefined) {
    // A new epoch anchors on THIS pack's tokens and keeps them: the identity
    // is the source request, not a running union of everything since.
    record = {
      epochTokens: [...epochTokens],
      query: "",
      requiredRoles: [],
      concernTokens: [],
      servedRoles: [],
      coveredConcernTokens: [],
    };
    _contracts.set(workspaceRoot, record);
  }

  // First writer wins: the epoch's source query is the request as originally
  // stated, not whatever a later continuation narrowed it to.
  if (record.query === "" && typeof observed.query === "string" && observed.query.trim() !== "") {
    record.query = observed.query;
  }
  _appendBounded(record.requiredRoles, observed.requiredRoles ?? [], MAX_TRACKED_REQUIRED_ROLES);
  _appendBounded(record.concernTokens, observed.concernTokens ?? [], MAX_TRACKED_CONCERN_TOKENS);
  _appendBounded(record.servedRoles, observed.servedRoles ?? [], MAX_TRACKED_REQUIRED_ROLES);
  _appendBounded(record.coveredConcernTokens, observed.coveredConcernTokens ?? [], MAX_TRACKED_CONCERN_TOKENS);
}

/**
 * The standing requirement model for this epoch, or undefined when nothing is
 * stored / the tokens name a different task (both are today's behavior).
 */
export function queryTaskContract(
  workspaceRoot: string,
  epochTokens: readonly string[],
): TaskContractRecord | undefined {
  if (epochTokens.length === 0) return undefined;
  const record = _contracts.get(workspaceRoot);
  if (record === undefined) return undefined;
  if (!_sameTask(epochTokens, record.epochTokens)) return undefined;
  if (record.requiredRoles.length === 0 && record.concernTokens.length === 0) return undefined;
  return {
    query: record.query,
    requiredRoles: [...record.requiredRoles],
    concernTokens: [...record.concernTokens],
    servedRoles: [...record.servedRoles],
    coveredConcernTokens: [...record.coveredConcernTokens],
  };
}

/** Drop the requirement model for a workspace (epoch reset / taskEpoch:"new"). */
export function clearTaskContract(workspaceRoot: string): void {
  _contracts.delete(workspaceRoot);
}

// ---------------------------------------------------------------------------
// Test hook
// ---------------------------------------------------------------------------

/** Clear ALL per-workspace state — used by specs' beforeEach for isolation. */
export function resetTaskContractStoreForTest(): void {
  _contracts.clear();
}
