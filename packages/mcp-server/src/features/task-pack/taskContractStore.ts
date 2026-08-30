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

import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { dischargeCertificate, ledgerDigest, type DischargeCertificate, type ObligationLedgerSnapshot, ObligationLedger } from "../../state/obligationLedger.js";
import { stateStoreFor } from "../../state/stateStore.js";
import { normalizeContractLane } from "../../util/packServeLog.js";
import { proofCompletionEnabled } from "../../util/flags.js";
import { hasOpenUniverseIntent, isAdditiveEnumIntent } from "./openUniverseIntent.js";

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
  /** Restart-binding digest of the projection's sole ledger source. */
  readonly ledgerDigest: string;
}

/** Stable identity for one task-contract ledger.  A workspace may host
 * several concurrent callers, so the ledger is never keyed by workspace
 * alone.  The handle is optional for callers that have not minted one yet,
 * but the lane is always explicit at the boundary. */
export interface TaskContractScope {
  readonly lane: string;
  readonly taskHandle?: string;
}

interface WorkspaceTaskContract {
  /** The FIRST pack's significant tokens — the epoch's fixed identity anchor, never widened (see the module header). */
  epochTokens: string[];
  /** First non-empty query seen in this epoch; never overwritten while the epoch stands. */
  query: string;
  /** The ledger is the sole mutable source for requirements and proofs. */
  ledger: ObligationLedger;
  scope: TaskContractScope;
  /** Stable fingerprints of executable next calls that this task still owns. */
  pendingNexts: string[];
}

// ---------------------------------------------------------------------------
// Bounds & module state
// ---------------------------------------------------------------------------

/** Role vocabulary is small and closed; this bound only stops a pathological caller-supplied `surfaceRoles`. */
const MAX_TRACKED_REQUIRED_ROLES = 16;
/** Same discipline as priorPackStore's MAX_TRACKED_OBLIGATIONS, sized for the 4-per-pack concern cap. */
const MAX_TRACKED_CONCERN_TOKENS = 32;
/** A task never needs an unbounded continuation queue; preserve newest unique calls. */
const MAX_PENDING_EXECUTABLE_NEXTS = 8;

const _contracts = new Map<string, WorkspaceTaskContract>();
const _taskContractScope = new AsyncLocalStorage<TaskContractScope>();
/** A next is an internal capability, never a wire field. `undefined` means ambiguous. */
const _nextScopes = new Map<string, TaskContractScope | undefined>();
/** Durable task-contract lifetime; expired entries are ignored on restart. */
export const TASK_CONTRACT_STATE_TTL_MS = 24 * 60 * 60 * 1000;
/** Per-lane bound across task handles, preventing one agent lane from growing unbounded state. */
export const MAX_TASK_CONTRACTS_PER_LANE = 32;
const TASK_CONTRACT_STATE_VERSION = 1;
const TASK_CONTRACT_LANE_INDEX_VERSION = 1;

function _scope(scope?: TaskContractScope): TaskContractScope {
  // A-F1: one normalization for every lane-keyed store (packServeLog.ts).
  return { lane: normalizeContractLane(scope?.lane), taskHandle: scope?.taskHandle };
}

function _effectiveScope(scope?: TaskContractScope): TaskContractScope | undefined {
  return scope ?? _taskContractScope.getStore();
}

/** Run pack construction with the caller's authenticated lane/task identity. */
export function runWithTaskContractScope<T>(scope: TaskContractScope, work: () => T): T {
  return _taskContractScope.run(_scope(scope), work);
}

function _stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(_stable).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${_stable(object[key])}`).join(",")}}`;
}

function _nextScopeKey(workspaceRoot: string, lane: string, next: { tool: string; arguments: Record<string, unknown> }): string {
  return `${workspaceRoot}\u0000${lane}\u0000${_stable(next)}`;
}

function _nextFingerprint(next: { tool: string; arguments: Record<string, unknown> }): string {
  return _stable(next);
}

function _sameScope(left: TaskContractScope, right: TaskContractScope): boolean {
  return left.lane === right.lane && left.taskHandle === right.taskHandle;
}

function _forgetNextScopes(workspaceRoot: string, scope?: TaskContractScope): void {
  const prefix = `${workspaceRoot}\u0000`;
  for (const [key, value] of _nextScopes) {
    if (!key.startsWith(prefix)) continue;
    if (scope === undefined || (value !== undefined && _sameScope(value, scope))) _nextScopes.delete(key);
  }
}

/** Remove executable-next provenance only for one authenticated lane. */
function _forgetNextScopesForLane(workspaceRoot: string, lane: string): void {
  const prefix = `${workspaceRoot}\u0000${lane}\u0000`;
  for (const key of _nextScopes.keys()) {
    if (key.startsWith(prefix)) _nextScopes.delete(key);
  }
}

/**
 * Register a returned executable next against its authenticated task scope.
 * Colliding next calls in one lane become deliberately unresolvable: search
 * must never discharge either task based on an ambiguous provenance guess.
 */
export function registerExecutableNextScope(
  workspaceRoot: string,
  scope: TaskContractScope,
  next: { tool: string; arguments: Record<string, unknown> },
): void {
  const normalized = _scope(scope);
  if (normalized.taskHandle === undefined) return;
  const key = _nextScopeKey(workspaceRoot, normalized.lane, next);
  const prior = _nextScopes.get(key);
  if (prior === undefined && !_nextScopes.has(key)) {
    _nextScopes.set(key, normalized);
  } else if (prior?.taskHandle !== normalized.taskHandle) {
    _nextScopes.set(key, undefined);
  }
  const record = _load(workspaceRoot, normalized);
  if (record !== undefined) {
    const fingerprint = _nextFingerprint(next);
    record.pendingNexts = [...record.pendingNexts.filter((value) => value !== fingerprint), fingerprint]
      .slice(-MAX_PENDING_EXECUTABLE_NEXTS);
    _persist(workspaceRoot, record);
  }
}

/**
 * Resolve and consume only a unique task provenance. The durable lane index is
 * consulted after restart; more than one matching live task is ambiguous.
 */
export function consumeExecutableNextScope(
  workspaceRoot: string,
  lane: string,
  next: { tool: string; arguments: Record<string, unknown> },
): TaskContractScope | undefined {
  const normalizedLane = _scope({ lane }).lane;
  const key = _nextScopeKey(workspaceRoot, normalizedLane, next);
  let resolved = _nextScopes.get(key);
  if (resolved === undefined && !_nextScopes.has(key)) {
    const fingerprint = _nextFingerprint(next);
    const matches = _loadLaneIndex(workspaceRoot, normalizedLane)
      .filter((taskHandle) => taskHandle !== "")
      .map((taskHandle) => ({ lane: normalizedLane, taskHandle }))
      .filter((scope) => _load(workspaceRoot, scope)?.pendingNexts.includes(fingerprint));
    resolved = matches.length === 1 ? matches[0] : undefined;
    _nextScopes.set(key, resolved);
  }
  if (resolved === undefined) return undefined;
  const record = _load(workspaceRoot, resolved);
  const fingerprint = _nextFingerprint(next);
  if (record === undefined || !record.pendingNexts.includes(fingerprint)) return undefined;
  record.pendingNexts = record.pendingNexts.filter((value) => value !== fingerprint);
  _persist(workspaceRoot, record);
  _nextScopes.delete(key);
  return resolved;
}

/** Test-only view of the current resolution without consuming it. */
export function executableNextScope(
  workspaceRoot: string,
  lane: string,
  next: { tool: string; arguments: Record<string, unknown> },
): TaskContractScope | undefined {
  return _nextScopes.get(_nextScopeKey(workspaceRoot, _scope({ lane }).lane, next));
}

function _scopeKey(workspaceRoot: string, scope?: TaskContractScope): string {
  const normalized = _scope(scope);
  return `${workspaceRoot}\u0000${normalized.lane}\u0000${normalized.taskHandle ?? ""}`;
}

function _stateKey(workspaceRoot: string, scope?: TaskContractScope): string {
  const digest = createHash("sha256").update(_scopeKey(workspaceRoot, scope)).digest("hex").slice(0, 32);
  return `task-contract:${digest}`;
}

function _laneIndexKey(workspaceRoot: string, lane: string): string {
  const digest = createHash("sha256").update(`${workspaceRoot}\u0000${lane}`).digest("hex").slice(0, 32);
  return `task-contract-lane-index:${digest}`;
}

interface PersistedTaskContract {
  readonly version: number;
  readonly scope: TaskContractScope;
  readonly epochTokens: string[];
  readonly query: string;
  readonly ledger: ObligationLedgerSnapshot;
  readonly pendingNexts?: string[];
}

interface PersistedLaneIndex {
  readonly version: number;
  readonly lane: string;
  /** Oldest → newest task-handle keys; the empty string represents no handle. */
  readonly taskHandles: string[];
}

function _laneHandle(scope: TaskContractScope): string {
  return scope.taskHandle ?? "";
}

function _loadLaneIndex(workspaceRoot: string, lane: string): string[] {
  const store = stateStoreFor(workspaceRoot);
  const data = store?.get(_laneIndexKey(workspaceRoot, lane))?.data;
  if (typeof data !== "object" || data === null) return [];
  const persisted = data as Partial<PersistedLaneIndex>;
  if (persisted.version !== TASK_CONTRACT_LANE_INDEX_VERSION || persisted.lane !== lane || !Array.isArray(persisted.taskHandles)) return [];
  return [...new Set(persisted.taskHandles.filter((handle): handle is string => typeof handle === "string"))];
}

function _persistLaneIndex(workspaceRoot: string, lane: string, taskHandles: readonly string[]): void {
  stateStoreFor(workspaceRoot)?.put({
    key: _laneIndexKey(workspaceRoot, lane),
    purpose: "task",
    data: { version: TASK_CONTRACT_LANE_INDEX_VERSION, lane, taskHandles: [...taskHandles] },
    ttlMs: TASK_CONTRACT_STATE_TTL_MS,
  });
}

/** Refresh one scope's lane LRU and remove evicted scopes from memory and disk. */
function _touchLaneScope(workspaceRoot: string, scope: TaskContractScope): void {
  const taskHandle = _laneHandle(scope);
  const handles = _loadLaneIndex(workspaceRoot, scope.lane).filter((handle) => handle !== taskHandle);
  handles.push(taskHandle);
  while (handles.length > MAX_TASK_CONTRACTS_PER_LANE) {
    const evicted = handles.shift();
    if (evicted === undefined) break;
    const evictedScope: TaskContractScope = { lane: scope.lane, ...(evicted === "" ? {} : { taskHandle: evicted }) };
    _contracts.delete(_scopeKey(workspaceRoot, evictedScope));
    stateStoreFor(workspaceRoot)?.delete(_stateKey(workspaceRoot, evictedScope));
  }
  _persistLaneIndex(workspaceRoot, scope.lane, handles);
}

function _removeLaneScope(workspaceRoot: string, scope: TaskContractScope): void {
  const taskHandle = _laneHandle(scope);
  const handles = _loadLaneIndex(workspaceRoot, scope.lane).filter((handle) => handle !== taskHandle);
  _persistLaneIndex(workspaceRoot, scope.lane, handles);
}

function _load(workspaceRoot: string, scope?: TaskContractScope): WorkspaceTaskContract | undefined {
  const key = _scopeKey(workspaceRoot, scope);
  const existing = _contracts.get(key);
  if (existing !== undefined) return existing;
  const store = stateStoreFor(workspaceRoot);
  if (store === undefined) return undefined;
  const stored = store.get(_stateKey(workspaceRoot, scope));
  const data = stored?.data;
  if (typeof data !== "object" || data === null) return undefined;
  const persisted = data as Partial<PersistedTaskContract>;
  if (persisted.version !== TASK_CONTRACT_STATE_VERSION || !Array.isArray(persisted.epochTokens)
      || typeof persisted.query !== "string" || typeof persisted.ledger !== "object" || persisted.ledger === null) return undefined;
  const snapshot = persisted.ledger as ObligationLedgerSnapshot;
  if (typeof snapshot.digest !== "string" || ledgerDigest(snapshot) !== snapshot.digest) return undefined;
  const normalized = _scope(scope);
  if (persisted.scope === undefined || persisted.scope.lane !== normalized.lane || persisted.scope.taskHandle !== normalized.taskHandle) return undefined;
  const record: WorkspaceTaskContract = {
    epochTokens: persisted.epochTokens.filter((token): token is string => typeof token === "string"),
    query: persisted.query,
    ledger: ObligationLedger.fromSnapshot(snapshot),
    scope: normalized,
    pendingNexts: Array.isArray(persisted.pendingNexts)
      ? persisted.pendingNexts.filter((value): value is string => typeof value === "string").slice(-MAX_PENDING_EXECUTABLE_NEXTS)
      : [],
  };
  _contracts.set(key, record);
  return record;
}

function _persist(workspaceRoot: string, record: WorkspaceTaskContract): void {
  const snapshot = record.ledger.snapshot();
  const data: PersistedTaskContract = {
    version: TASK_CONTRACT_STATE_VERSION,
    scope: record.scope,
    epochTokens: [...record.epochTokens],
    query: record.query,
    ledger: snapshot,
    pendingNexts: [...record.pendingNexts],
  };
  const store = stateStoreFor(workspaceRoot);
  if (store === undefined) return;
  store.put({
    key: _stateKey(workspaceRoot, record.scope),
    purpose: "task",
    data: data as unknown as Record<string, unknown>,
    ttlMs: TASK_CONTRACT_STATE_TTL_MS,
  });
}

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
function _tokens(incoming: readonly string[], cap: number): string[] {
  return [...new Set(incoming.filter((entry) => typeof entry === "string" && entry.length > 0))].slice(0, cap);
}

function _add(record: WorkspaceTaskContract, kind: "required-role" | "concern-token", incoming: readonly string[], cap: number): void {
  for (const target of _tokens(incoming, cap)) record.ledger.add({ kind, target, polarity: "evidence", origin: "query" });
}

function _prove(record: WorkspaceTaskContract, kind: "required-role" | "concern-token", incoming: readonly string[], type: "served" | "authoritative-absent"): void {
  for (const target of incoming) {
    const obligation = { kind, target, polarity: "evidence" as const };
    if (record.ledger.has(obligation)) record.ledger.prove(obligation, { type, witness: target });
  }
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
  scope?: TaskContractScope,
): void {
  if (epochTokens.length === 0) return;
  const normalizedScope = _scope(_effectiveScope(scope));
  const key = _scopeKey(workspaceRoot, normalizedScope);
  let record = _load(workspaceRoot, normalizedScope);
  if (record !== undefined && !_sameTask(epochTokens, record.epochTokens)) {
    record = undefined;
  }
  if (record === undefined) {
    // A new epoch anchors on THIS pack's tokens and keeps them: the identity
    // is the source request, not a running union of everything since.
    record = {
      epochTokens: [...epochTokens],
      query: "",
      ledger: new ObligationLedger(),
      scope: normalizedScope,
      pendingNexts: [],
    };
    _contracts.set(key, record);
  }

  // First writer wins: the epoch's source query is the request as originally
  // stated, not whatever a later continuation narrowed it to.
  if (record.query === "" && typeof observed.query === "string" && observed.query.trim() !== "") {
    record.query = observed.query;
  }
  _add(record, "required-role", observed.requiredRoles ?? [], MAX_TRACKED_REQUIRED_ROLES);
  _add(record, "concern-token", observed.concernTokens ?? [], MAX_TRACKED_CONCERN_TOKENS);
  _prove(record, "required-role", observed.servedRoles ?? [], "served");
  _prove(record, "concern-token", observed.coveredConcernTokens ?? [], "served");
  _touchLaneScope(workspaceRoot, normalizedScope);
  _persist(workspaceRoot, record);
}

/**
 * Discharge already-recorded query concerns from same-epoch evidence.  This is
 * deliberately narrower than `recordTaskContract`: continuations may prove
 * only obligations the source pack minted, never add new query vocabulary.
 */
export function recordServedConcernEvidence(
  workspaceRoot: string,
  tokens: readonly string[],
  scope?: TaskContractScope,
): void {
  const record = _load(workspaceRoot, _effectiveScope(scope));
  if (record === undefined) return;
  _prove(record, "concern-token", _tokens(tokens, MAX_TRACKED_CONCERN_TOKENS), "served");
  _persist(workspaceRoot, record);
}

/** Discharge already-recorded required roles from same-epoch served evidence. */
export function recordServedRoleEvidence(
  workspaceRoot: string,
  roles: readonly string[],
  scope?: TaskContractScope,
): void {
  const record = _load(workspaceRoot, _effectiveScope(scope));
  if (record === undefined) return;
  _prove(record, "required-role", _tokens(roles, MAX_TRACKED_REQUIRED_ROLES), "served");
  _persist(workspaceRoot, record);
}

/**
 * A fresh pack learns its opaque handle only at projection time. Move its
 * already-recorded lane scope to that handle atomically before publishing a
 * next; a continuation then re-enters the same durable ledger by handle.
 */
export function bindTaskContractHandle(
  workspaceRoot: string,
  from: TaskContractScope,
  taskHandle: string,
): TaskContractScope {
  const source = _scope(from);
  const destination = _scope({ lane: source.lane, taskHandle });
  if (source.taskHandle === destination.taskHandle) return destination;
  const sourceRecord = _load(workspaceRoot, source);
  const destinationRecord = _load(workspaceRoot, destination);
  if (sourceRecord === undefined) return destination;
  // A destination can survive the source scope across an epoch boundary.  It
  // must not shadow the newly-produced ledger merely because it has the same
  // opaque handle: the act certificate was minted from `sourceRecord`, and a
  // different destination digest would make that certificate unverifiable.
  //
  // `_sameTask` is the store's identity predicate (the same one used when a
  // record is continued).  Replacing is permitted only for that identity;
  // otherwise retaining the destination is fail-closed and prevents a caller
  // from rebinding an unrelated source task onto a known task handle.  Do not
  // merge ledgers here: an added obligation changes the certificate digest
  // after it was minted, which is a CAS advance rather than a valid rebind.
  if (destinationRecord !== undefined && !_sameTask(sourceRecord.epochTokens, destinationRecord.epochTokens)) {
    return destination;
  }
  _contracts.delete(_scopeKey(workspaceRoot, source));
  _removeLaneScope(workspaceRoot, source);
  sourceRecord.scope = destination;
  _contracts.set(_scopeKey(workspaceRoot, destination), sourceRecord);
  for (const [key, value] of _nextScopes) {
    if (value !== undefined && _sameScope(value, source)) _nextScopes.set(key, destination);
  }
  _touchLaneScope(workspaceRoot, destination);
  _persist(workspaceRoot, sourceRecord);
  return destination;
}

/**
 * The standing requirement model for this epoch, or undefined when nothing is
 * stored / the tokens name a different task (both are today's behavior).
 */
/**
 * Records an authoritative negative result for a prescribed find. This is a
 * proof transition, not a new requirement: a cold or unrelated epoch remains
 * untouched (fail closed).
 */
export function recordAuthoritativeAbsentConcerns(workspaceRoot: string, tokens: readonly string[], scope?: TaskContractScope): void {
  const record = _load(workspaceRoot, _effectiveScope(scope));
  if (record === undefined) return;
  const bounded = _tokens(tokens, MAX_TRACKED_CONCERN_TOKENS);
  _prove(record, "concern-token", bounded, "authoritative-absent");
  // A prescribed absent find is a valid explicit-gap witness for the same
  // epoch's open-universe request, but only when the original query actually
  // names an exhaustive universe. Ordinary standalone finds must not create or
  // discharge a synthetic universe obligation.
  //
  // A-F6: the open-universe concept does not exist in v0.12, so the
  // compatibility switch must stop it being MINTED, not merely stop it being
  // read — a persisted obligation is state the OFF arm should not have.
  //
  // P1-e(i) (2026-08-28): this was an inline regex broader than the canonical
  // `hasOpenUniverseIntent` — a bare "all"/"each" fires on ordinary prose that
  // is not an exhaustive request at all. Route through the same canonical
  // classifier + `isAdditiveEnumIntent` pairing every other open-universe call
  // site in readCodeTaskPack.ts uses, so there is exactly one place that
  // decides what counts as exhaustive.
  const isOpenUniverseMutation = proofCompletionEnabled()
    && hasOpenUniverseIntent(record.query)
    && !isAdditiveEnumIntent(record.query);
  if (isOpenUniverseMutation) {
    const openUniverse = { kind: "dependency-definitions", target: "open-universe", polarity: "evidence" as const };
    if (!record.ledger.has(openUniverse)) record.ledger.add({ ...openUniverse, origin: "evidence-expansion" });
    record.ledger.prove(openUniverse, { type: "explicit-gap", witness: "authoritative-absent" });

    // P1-a (2026-08-28): the value this query asked to ADD (e.g. "Add
    // REFUNDED everywhere...") is a requirement on the EDIT, never on
    // evidence — see epochConcernTokensFor's doc comment in
    // readCodeTaskPack.ts. `polarity:"edit"` existed only as a type before
    // this wave; mint the edit-polarity twin obligation for the same token
    // and discharge it in the same step — the absence probe that just ran IS
    // the terminal proof an edit obligation needs (we now know for certain
    // the value must be added, not found). This is purely additive next to
    // the evidence-polarity obligation above (the ledger's monotone-add
    // contract: obligations are never removed or reclassified in place), so
    // the existing absence-consumed wire shape (sequenceCorpus I1/I3) is
    // unchanged — only the ledger's own bookkeeping gains an honestly-typed
    // record that this token's requirement is on the edit, not the evidence.
    for (const target of bounded) {
      const editObligation = { kind: "concern-token", target, polarity: "edit" as const };
      if (!record.ledger.has(editObligation)) {
        record.ledger.add({ ...editObligation, origin: "prescribed-next" });
      }
      record.ledger.prove(editObligation, { type: "authoritative-absent", witness: target });
    }
  }
  _persist(workspaceRoot, record);
}

/** Record one-hop dependencies without reclassifying them as query concerns. */
export function recordEvidenceExpansion(workspaceRoot: string, targets: readonly string[], servedDefinitions: readonly string[], scope?: TaskContractScope): void {
  const record = _load(workspaceRoot, _effectiveScope(scope));
  if (record === undefined) return;
  const served = new Set(servedDefinitions.map((value) => value.toLowerCase()));
  for (const target of targets) {
    const obligation = { kind: "dependency-definitions", target, polarity: "evidence" as const };
    record.ledger.add({ ...obligation, origin: "evidence-expansion" });
    if (served.has(target.toLowerCase())) record.ledger.prove(obligation, { type: "served", witness: target });
  }
  _persist(workspaceRoot, record);
}

/** Capability limits are terminal proof facts, but remain caller-visible gaps. */
export function recordExplicitGap(
  workspaceRoot: string,
  kind: string,
  target: string,
  witness: string,
  scope?: TaskContractScope,
): void {
  const record = _load(workspaceRoot, _effectiveScope(scope));
  if (record === undefined) return;
  const obligation = { kind, target, polarity: "evidence" as const };
  if (!record.ledger.has(obligation)) record.ledger.add({ ...obligation, origin: "evidence-expansion" });
  record.ledger.prove(obligation, { type: "explicit-gap", witness });
  _persist(workspaceRoot, record);
}

/** An extractor limit discharges the parent universe and every concrete target it could name. */
export function recordExpansionExplicitGap(
  workspaceRoot: string,
  parent: { kind: string; target: string },
  targets: readonly string[],
  witness: string,
  scope?: TaskContractScope,
): void {
  recordExplicitGap(workspaceRoot, parent.kind, parent.target, witness, scope);
  for (const target of targets) recordExplicitGap(workspaceRoot, "dependency-definitions", target, witness, scope);
}

export function queryTaskContract(
  workspaceRoot: string,
  epochTokens: readonly string[],
  scope?: TaskContractScope,
): TaskContractRecord | undefined {
  if (epochTokens.length === 0) return undefined;
  const record = _load(workspaceRoot, _effectiveScope(scope));
  if (record === undefined) return undefined;
  if (!_sameTask(epochTokens, record.epochTokens)) return undefined;
  const snapshot = record.ledger.snapshot();
  const requiredRoles = snapshot.obligations.filter((entry) => entry.kind === "required-role");
  const concernTokens = snapshot.obligations.filter((entry) => entry.kind === "concern-token");
  if (requiredRoles.length === 0 && concernTokens.length === 0) return undefined;
  return {
    query: record.query,
    requiredRoles: requiredRoles.map((entry) => entry.target),
    concernTokens: concernTokens.map((entry) => entry.target),
    servedRoles: requiredRoles.filter((entry) => entry.proof?.type === "served").map((entry) => entry.target),
    coveredConcernTokens: concernTokens.filter((entry) => entry.proof !== undefined).map((entry) => entry.target),
    ledgerDigest: snapshot.digest,
  };
}

/** Digest for a minted task handle; undefined means no established epoch. */
export function taskContractDigest(workspaceRoot: string, scope?: TaskContractScope): string | undefined {
  return _load(workspaceRoot, _effectiveScope(scope))?.ledger.snapshot().digest;
}

/** Terminal proof is available only for the matching epoch's fully discharged ledger. */
export function taskContractDischargeCertificate(
  workspaceRoot: string,
  epochTokens: readonly string[],
  scope?: TaskContractScope,
): DischargeCertificate | undefined {
  const record = _load(workspaceRoot, _effectiveScope(scope));
  if (record === undefined || !_sameTask(epochTokens, record.epochTokens)) return undefined;
  return dischargeCertificate(record.ledger);
}

/**
 * Deterministic wire-safe projection of ledger facts that remain material to
 * the caller.
 *
 * THREE COLUMNS, NOT TWO (R2, 2026-08-28). `open` and `explicitGaps` are the
 * two ways an obligation can still be MATERIAL — nothing proved it, or a
 * capability limit proved it unprovable. `resolved` is the third outcome the
 * ledger already records and this projection dropped: an obligation
 * `recordEvidenceExpansion` proved with `{type:"served"}`, i.e. the expansion
 * SUCCEEDED and the target's definition is resident evidence.
 *
 * Dropping it made a fully-successful expansion indistinguishable from one that
 * never happened: `buildTaskExecutionContract`'s `openUniverseDischarged` could
 * only ever discharge through the explicit-gap arm, so a pack that served every
 * direct-callee definition (missing:[], coverage "complete", zero gaps) kept its
 * `open-universe:dependency-definitions` obligation "uncovered" forever and its
 * `act.answer` was suppressed on evidence it actually held.
 *
 * A-1(e) / `ledgerProjectionArchitecture.spec.ts` require ONE projector, so the
 * third column is added HERE rather than re-derived by the consumer — a second
 * derivation of "what did the ledger prove" is the exact class that spec exists
 * to forbid.
 */
export function taskContractGapProjection(workspaceRoot: string, epochTokens: readonly string[], scope?: TaskContractScope): {
  open: string[];
  explicitGaps: string[];
  resolved: string[];
} {
  const record = _load(workspaceRoot, _effectiveScope(scope));
  if (record === undefined || !_sameTask(epochTokens, record.epochTokens)) return { open: [], explicitGaps: [], resolved: [] };
  const entries = record.ledger.snapshot().obligations;
  return {
    open: entries.filter((entry) => entry.proof === undefined).map((entry) => `${entry.kind}:${entry.target}`),
    explicitGaps: entries
      .filter((entry) => entry.proof?.type === "explicit-gap")
      .map((entry) => `${entry.kind}:${entry.target} (${entry.proof!.witness})`),
    // Same `kind:target` spelling as `open`, so the two are directly
    // comparable: an id appears in exactly one of the three columns.
    resolved: entries
      .filter((entry) => entry.proof?.type === "served")
      .map((entry) => `${entry.kind}:${entry.target}`),
  };
}

/** Drop the requirement model for a workspace (epoch reset / taskEpoch:"new"). */
export function clearTaskContract(workspaceRoot: string, scope?: TaskContractScope): void {
  if (scope !== undefined) {
    _contracts.delete(_scopeKey(workspaceRoot, scope));
    stateStoreFor(workspaceRoot)?.delete(_stateKey(workspaceRoot, scope));
    _removeLaneScope(workspaceRoot, _scope(scope));
    _forgetNextScopes(workspaceRoot, _scope(scope));
    return;
  }
  for (const [key, record] of _contracts) {
    if (key.startsWith(`${workspaceRoot}\u0000`)) {
      _contracts.delete(key);
      stateStoreFor(workspaceRoot)?.delete(_stateKey(workspaceRoot, record.scope));
    }
  }
  _forgetNextScopes(workspaceRoot);
}

/**
 * Drop every durable contract belonging to one lane at an explicit new-task
 * boundary.  Task handles intentionally stay stable across epochs, so clearing
 * only the unscoped/default record would allow a previous handle-scoped ledger
 * to be reloaded from the lane index on the next pack.  The persisted lane
 * index is the authoritative bounded enumeration; no other lane is examined
 * or removed.
 */
export function clearTaskContractsForLane(workspaceRoot: string, lane: string): void {
  const normalizedLane = _scope({ lane }).lane;
  const handles = new Set(_loadLaneIndex(workspaceRoot, normalizedLane));
  // A previous buggy/mid-upgrade handle move can have left the unscoped source
  // out of the lane index. It belongs to this lane and is safe to remove here;
  // no other lane shares its state key.
  handles.add("");
  for (const [key, record] of _contracts) {
    if (key.startsWith(`${workspaceRoot}\u0000`) && record.scope.lane === normalizedLane) {
      handles.add(_laneHandle(record.scope));
    }
  }
  for (const taskHandle of handles) {
    const scope: TaskContractScope = {
      lane: normalizedLane,
      ...(taskHandle === "" ? {} : { taskHandle }),
    };
    _contracts.delete(_scopeKey(workspaceRoot, scope));
    stateStoreFor(workspaceRoot)?.delete(_stateKey(workspaceRoot, scope));
  }
  stateStoreFor(workspaceRoot)?.delete(_laneIndexKey(workspaceRoot, normalizedLane));
  _forgetNextScopesForLane(workspaceRoot, normalizedLane);
}

// ---------------------------------------------------------------------------
// Test hook
// ---------------------------------------------------------------------------

/** Read the private ledger for focused regression assertions only. */
export function taskContractLedgerSnapshotForTest(workspaceRoot: string, scope?: TaskContractScope) {
  return _load(workspaceRoot, scope)?.ledger.snapshot();
}

/** In-process producer access for certificate binding; the snapshot is never
 * serialized and is immutable once captured. */
export function taskContractLedgerSnapshot(workspaceRoot: string, scope?: TaskContractScope): ObligationLedgerSnapshot | undefined {
  return _load(workspaceRoot, scope)?.ledger.snapshot();
}

/** Clear ALL per-workspace state — used by specs' beforeEach for isolation. */
export function resetTaskContractStoreForTest(): void {
  _contracts.clear();
  _nextScopes.clear();
}
