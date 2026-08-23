// ---------------------------------------------------------------------------
// irStore.ts — snapshot checkpoints + delta log for Task Reasoning IR v2.
//
// DESIGN-v0.10-expansion-plan-v1.3.md §7 V11-04 ("snapshot checkpoint、
// idempotent delta apply、lane isolationを実装する"); reconciliation §3 row
// V11-04 ("snapshot checkpoints via `WorkspaceStateStore`, lane isolation").
//
// ADDITIVE OVER THE EXISTING STORE. This module changes NOTHING in
// `state/stateStore.ts`: no new `StoredPurpose`, no new record field, no new
// on-disk file. It reuses the existing `"task"` purpose and carves out a key
// NAMESPACE instead — `ir2:<32 hex>`. That namespace cannot collide with the
// explicit-handle keys `stateHandles.ts` mints, because those are base64url of
// a 9-byte payload ref (12 chars, alphabet `A-Za-z0-9-_`) and therefore never
// contain `:`. Even a hypothetical collision fails CLOSED: `asTaskState()`
// requires a `taskFingerprint` string these records do not carry, so a task
// handle resolving onto one gets `unknown`, never fabricated task state.
//
// LOCK + CAS DISCIPLINE IS INHERITED, NOT REIMPLEMENTED. Every write goes
// through `WorkspaceStateStore.put({expectedVersion})`, which takes the
// cross-process writer lock, RE-SYNCS this instance from disk while holding it,
// and only then evaluates the CAS — the discipline `state/writerLock.ts`
// documents. This module therefore never takes a lock itself and never
// upgrades one; on `state-conflict` it reports the conflict and does NOT
// retry-loop, because an advisory projection has no business contending.
//
// ONE RECORD, SO A CHECKPOINT IS ATOMIC. Snapshot and delta log live in the
// SAME record. A two-record layout could tear (snapshot advanced, log not
// truncated) and produce exactly the "delta欠落・順序競合でstateがずれる"
// failure mode the plan names; one CAS'd record cannot.
//
// RECOVERY IS FAIL-CLOSED TO FRESH. A record that does not decode, a snapshot
// whose hash does not match its own content, or a delta chain that refuses
// mid-replay all return `{ok:false, reason:"corrupt"}` — "no IR state", never a
// partial reconstruction. The next checkpoint overwrites the bad record by CAS,
// so the state self-heals without any repair path of its own.
//
// LANE ISOLATION IS IN THE KEY. State is keyed by (workspaceRef, taskRef,
// lane), so two agents on different lanes of one workspace address different
// records and can never cross-apply. `applyReasoningDelta` fences the same
// boundary a second time on the delta itself.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import type {
  EvidenceIdentity,
  EvidenceUse,
  HypothesisTombstone,
  ObligationNode,
  ReasoningDelta,
  TaskReasoningIRv2,
  ValidityKey,
} from "@tokenlighten/types";
import { stateStoreFor } from "../state/stateStore.js";
import { computeTaskStateHash, replayReasoningDeltas } from "./reasoningDelta.js";

/** Deltas retained before a checkpoint is forced. */
export const IR_DELTA_LOG_MAX = 32;

/**
 * Serialized record ceiling, in JSON CHARACTERS; a checkpoint is forced before
 * crossing it. The store refuses to load a journal past `MAX_JOURNAL_BYTES` and
 * treats it as corruption, so an unbounded IR record could poison the whole
 * workspace store — hence a ceiling here even though the projection's own caps
 * already bound the snapshot.
 *
 * DELIBERATELY NOT A BYTE MEASUREMENT. Acceptance gate G8
 * (`__tests__/wireBudgetG8Fence.spec.ts`) fences the fused byte-length-over-
 * serialized-value call shape: it reserves that shape for RESPONSE
 * measurement, exempts only Class-C pre-shed CONTENT budgets by an enumerated
 * table, and ratchets that table toward zero. This measurement is neither
 * thing — it bounds a persisted CACHE RECORD that never reaches the wire — so
 * counting characters keeps the distinction legible instead of parking an
 * unrelated site in a table whose whole purpose is auditing response-level
 * measurement. (The gate's scanner reads raw source, comments included, which
 * is also why this note describes the fenced shape rather than spelling it.)
 * Characters are a sound ceiling proxy: for the ASCII-dominant JSON this
 * record holds, UTF-8 bytes never fall below UTF-16 units, and the cap is
 * defense in depth rather than an exact budget.
 */
export const IR_RECORD_MAX_CHARS = 256 * 1024;

/** Matches the task horizon `stateHandles.ts` uses for task records. */
export const IR_STATE_TTL_MS = 24 * 60 * 60 * 1000;

/** The key namespace prefix. See this module's header for the collision argument. */
export const IR_KEY_PREFIX = "ir2:";

export interface IrStateIdentity {
  /** Canonical workspace root (the store is per-workspace; this pins the pair). */
  workspaceRef: string;
  taskRef: string;
  /** "" is the shared default lane. */
  lane: string;
}

/** The store key for one (workspace, task, lane) triple. */
export function irStateKey(identity: IrStateIdentity): string {
  const digest = createHash("sha256")
    .update(`${identity.workspaceRef} ${identity.taskRef} ${identity.lane}`, "utf8")
    .digest("hex")
    .slice(0, 32);
  return `${IR_KEY_PREFIX}${digest}`;
}

export type IrLoadResult =
  | { ok: true; state: TaskReasoningIRv2; recordVersion: number; deltaCount: number }
  | { ok: false; reason: "absent" | "corrupt" | "store-unavailable"; detail?: string };

export type IrWriteResult =
  | { ok: true; recordVersion: number; deltaCount: number }
  | { ok: false; reason: "store-unavailable" | "state-conflict" | "too-large"; detail?: string };

interface IrRecordShape {
  v: 1;
  snapshot: TaskReasoningIRv2;
  deltas: ReasoningDelta[];
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/** Load and fully reconstruct the state for `key`; fail-closed on any defect. */
export function loadIrState(workspaceRoot: string, key: string): IrLoadResult {
  const store = stateStoreFor(workspaceRoot);
  if (store === undefined || !store.available) return { ok: false, reason: "store-unavailable" };

  const record = store.get(key);
  if (record === undefined) return { ok: false, reason: "absent" };

  const decoded = decodeIrRecord(record.data);
  if (decoded === undefined) return { ok: false, reason: "corrupt", detail: "record did not decode" };

  // The snapshot must be self-consistent before anything is replayed onto it.
  if (computeTaskStateHash(decoded.snapshot) !== decoded.snapshot.stateHash) {
    return { ok: false, reason: "corrupt", detail: "snapshot hash does not match its content" };
  }

  const replayed = replayReasoningDeltas(decoded.snapshot, decoded.deltas);
  if (!replayed.ok) {
    return {
      ok: false,
      reason: "corrupt",
      detail: `delta ${replayed.index} refused (${replayed.outcome}): ${replayed.detail}`,
    };
  }
  return {
    ok: true,
    state: replayed.state,
    recordVersion: record.version,
    deltaCount: decoded.deltas.length,
  };
}

/** The store record's current CAS version for `key`; 0 when absent. */
export function irRecordVersion(workspaceRoot: string, key: string): number {
  const store = stateStoreFor(workspaceRoot);
  if (store === undefined || !store.available) return 0;
  return store.versionOf(key);
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/** Publish `state` as the new checkpoint and TRUNCATE the delta log. */
export function checkpointIrState(
  workspaceRoot: string,
  key: string,
  state: TaskReasoningIRv2,
  expectedVersion?: number,
): IrWriteResult {
  return writeRecord(workspaceRoot, key, { v: 1, snapshot: state, deltas: [] }, expectedVersion);
}

/**
 * Append `delta` to the log. When the log is full, or the record would exceed
 * its byte ceiling, this CHECKPOINTS `resultingState` instead — same single
 * CAS, so the caller never has to sequence two writes.
 */
export function recordIrDelta(
  workspaceRoot: string,
  key: string,
  delta: ReasoningDelta,
  resultingState: TaskReasoningIRv2,
  expectedVersion?: number,
): IrWriteResult {
  const store = stateStoreFor(workspaceRoot);
  if (store === undefined || !store.available) return { ok: false, reason: "store-unavailable" };

  const record = store.get(key);
  const decoded = record === undefined ? undefined : decodeIrRecord(record.data);
  if (decoded === undefined) {
    // No usable prior record: the honest move is a fresh checkpoint of the
    // state the caller already holds, not a log entry with no base.
    return checkpointIrState(workspaceRoot, key, resultingState, expectedVersion ?? record?.version ?? 0);
  }

  const appended: IrRecordShape = { v: 1, snapshot: decoded.snapshot, deltas: [...decoded.deltas, delta] };
  if (appended.deltas.length > IR_DELTA_LOG_MAX || serializedLength(appended) > IR_RECORD_MAX_CHARS) {
    return checkpointIrState(workspaceRoot, key, resultingState, expectedVersion ?? record?.version ?? 0);
  }
  return writeRecord(workspaceRoot, key, appended, expectedVersion ?? record?.version ?? 0);
}

/** Drop the record entirely (a new task epoch, or an operator reset). */
export function clearIrState(workspaceRoot: string, key: string): void {
  const store = stateStoreFor(workspaceRoot);
  if (store === undefined || !store.available) return;
  store.delete(key);
}

function writeRecord(
  workspaceRoot: string,
  key: string,
  payload: IrRecordShape,
  expectedVersion: number | undefined,
): IrWriteResult {
  const store = stateStoreFor(workspaceRoot);
  if (store === undefined || !store.available) return { ok: false, reason: "store-unavailable" };
  if (serializedLength(payload) > IR_RECORD_MAX_CHARS) {
    return { ok: false, reason: "too-large", detail: "IR record exceeds its serialized ceiling" };
  }
  const outcome = store.put({
    key,
    purpose: "task",
    data: payload as unknown as Record<string, unknown>,
    ttlMs: IR_STATE_TTL_MS,
    ...(expectedVersion === undefined ? {} : { expectedVersion }),
  });
  if (!outcome.ok) {
    return outcome.outcome === "state-conflict"
      // Advisory state does not contend: report and let the caller re-load.
      ? { ok: false, reason: "state-conflict", detail: `store is at version ${outcome.currentVersion}` }
      : { ok: false, reason: "store-unavailable" };
  }
  return { ok: true, recordVersion: outcome.record.version, deltaCount: payload.deltas.length };
}

/** JSON length of a record in characters; an unserializable record is infinite. */
function serializedLength(payload: IrRecordShape): number {
  try {
    return JSON.stringify(payload).length;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

// ---------------------------------------------------------------------------
// Structural decoding — the fail-closed boundary
// ---------------------------------------------------------------------------

function obj(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function arr(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function decodeStringArray(value: unknown): string[] | undefined {
  const items = arr(value);
  if (items === undefined) return undefined;
  const out: string[] = [];
  for (const item of items) {
    const s = str(item);
    if (s === undefined) return undefined;
    out.push(s);
  }
  return out;
}

function decodeValidityKeys(value: unknown): ValidityKey[] | undefined {
  const items = arr(value);
  if (items === undefined) return undefined;
  const out: ValidityKey[] = [];
  for (const item of items) {
    const o = obj(item);
    const type = o === undefined ? undefined : str(o["type"]);
    const val = o === undefined ? undefined : str(o["value"]);
    if (type === undefined || val === undefined) return undefined;
    out.push({ type, value: val });
  }
  return out;
}

/**
 * `IrRecordShape` from untrusted JSON. Every decoder below returns `undefined`
 * on the FIRST defect and the whole load fails closed — a half-decoded state is
 * exactly the partial reconstruction this module forbids.
 */
export function decodeIrRecord(value: unknown): IrRecordShape | undefined {
  const o = obj(value);
  if (o === undefined || o["v"] !== 1) return undefined;
  const snapshot = decodeIrState(o["snapshot"]);
  if (snapshot === undefined) return undefined;
  const rawDeltas = arr(o["deltas"]);
  if (rawDeltas === undefined) return undefined;
  const deltas: ReasoningDelta[] = [];
  for (const raw of rawDeltas) {
    const delta = decodeDelta(raw);
    if (delta === undefined) return undefined;
    deltas.push(delta);
  }
  return { v: 1, snapshot, deltas };
}

export function decodeIrState(value: unknown): TaskReasoningIRv2 | undefined {
  const o = obj(value);
  if (o === undefined || o["irVersion"] !== 2) return undefined;

  const taskRef = str(o["taskRef"]);
  const lane = str(o["lane"]);
  const stateVersion = num(o["stateVersion"]);
  const stateHash = str(o["stateHash"]);
  const goal = str(o["goal"]);
  if (taskRef === undefined || lane === undefined || stateVersion === undefined) return undefined;
  if (stateHash === undefined || goal === undefined) return undefined;

  const constraints = decodeConstraints(o["constraints"]);
  const evidenceCatalog = decodeEvidenceCatalog(o["evidenceCatalog"]);
  const evidenceUses = decodeEvidenceUses(o["evidenceUses"]);
  const obligations = decodeObligations(o["obligations"]);
  const decision = decodeDecision(o["decision"]);
  const tombstones = decodeTombstones(o["tombstones"]);
  const allowedNext = decodeAllowedNext(o["allowedNext"]);
  const invalidationKeys = decodeValidityKeys(o["invalidationKeys"]);
  const appliedDeltaIds = decodeStringArray(o["appliedDeltaIds"]);
  const dagEnabled = o["dagEnabled"];
  if (
    constraints === undefined || evidenceCatalog === undefined || evidenceUses === undefined
    || obligations === undefined || decision === undefined || tombstones === undefined
    || allowedNext === undefined || invalidationKeys === undefined || appliedDeltaIds === undefined
    || typeof dagEnabled !== "boolean"
  ) {
    return undefined;
  }

  return {
    irVersion: 2,
    taskRef,
    lane,
    stateVersion,
    stateHash,
    goal,
    constraints,
    evidenceCatalog,
    evidenceUses,
    obligations,
    decision,
    tombstones,
    allowedNext,
    invalidationKeys,
    appliedDeltaIds,
    dagEnabled,
  };
}

function decodeConstraints(value: unknown): TaskReasoningIRv2["constraints"] | undefined {
  const items = arr(value);
  if (items === undefined) return undefined;
  const out: TaskReasoningIRv2["constraints"] = [];
  for (const item of items) {
    const o = obj(item);
    const id = o === undefined ? undefined : str(o["id"]);
    const text = o === undefined ? undefined : str(o["text"]);
    const source = o === undefined ? undefined : str(o["source"]);
    if (id === undefined || text === undefined) return undefined;
    if (source !== "user" && source !== "repository") return undefined;
    out.push({ id, text, source });
  }
  return out;
}

function decodeEvidenceCatalog(value: unknown): EvidenceIdentity[] | undefined {
  const items = arr(value);
  if (items === undefined) return undefined;
  const out: EvidenceIdentity[] = [];
  for (const item of items) {
    const o = obj(item);
    if (o === undefined) return undefined;
    const evidenceId = str(o["evidenceId"]);
    const source = obj(o["source"]);
    const cls = str(o["evidenceClass"]);
    const validityKeys = decodeValidityKeys(o["validityKeys"]);
    if (evidenceId === undefined || source === undefined || validityKeys === undefined) return undefined;
    if (cls !== "direct" && cls !== "structural" && cls !== "heuristic") return undefined;
    const kind = str(source["kind"]);
    const uri = str(source["uri"]);
    const contentHash = str(source["contentHash"]);
    if (uri === undefined || contentHash === undefined) return undefined;
    if (kind !== "file" && kind !== "artifact" && kind !== "index" && kind !== "verification") return undefined;
    const indexGeneration = str(source["indexGeneration"]);
    const locator = obj(o["locator"]);
    out.push({
      evidenceId,
      source: {
        kind,
        uri,
        contentHash,
        ...(indexGeneration === undefined ? {} : { indexGeneration }),
      },
      ...(locator === undefined ? {} : { locator: decodeLocator(locator) }),
      evidenceClass: cls,
      validityKeys,
    });
  }
  return out;
}

function decodeLocator(o: Record<string, unknown>): NonNullable<EvidenceIdentity["locator"]> {
  const range = obj(o["lineRange"]);
  const startLine = range === undefined ? undefined : num(range["startLine"]);
  const endLine = range === undefined ? undefined : num(range["endLine"]);
  const symbol = obj(o["symbol"]);
  const symbolId = symbol === undefined ? undefined : str(symbol["id"]);
  const symbolName = symbol === undefined ? undefined : str(symbol["name"]);
  const symbolKind = symbol === undefined ? undefined : str(symbol["kind"]);
  const sectionId = str(o["sectionId"]);
  return {
    ...(startLine === undefined || endLine === undefined ? {} : { lineRange: { startLine, endLine } }),
    ...(symbolId === undefined || symbolName === undefined || symbolKind === undefined
      ? {}
      : { symbol: { id: symbolId, name: symbolName, kind: symbolKind } }),
    ...(sectionId === undefined ? {} : { sectionId }),
  };
}

function decodeEvidenceUses(value: unknown): EvidenceUse[] | undefined {
  const items = arr(value);
  if (items === undefined) return undefined;
  const out: EvidenceUse[] = [];
  for (const item of items) {
    const o = obj(item);
    if (o === undefined) return undefined;
    const taskRef = str(o["taskRef"]);
    const evidenceId = str(o["evidenceId"]);
    const roles = decodeStringArray(o["roles"]);
    const obligationIds = decodeStringArray(o["obligationIds"]);
    const required = o["required"];
    if (taskRef === undefined || evidenceId === undefined || roles === undefined) return undefined;
    if (obligationIds === undefined || typeof required !== "boolean") return undefined;
    out.push({ taskRef, evidenceId, roles: roles as EvidenceUse["roles"], obligationIds, required });
  }
  return out;
}

function decodeObligations(value: unknown): ObligationNode[] | undefined {
  const items = arr(value);
  if (items === undefined) return undefined;
  const out: ObligationNode[] = [];
  for (const item of items) {
    const o = obj(item);
    if (o === undefined) return undefined;
    const id = str(o["id"]);
    const claim = str(o["claim"]);
    const state = str(o["state"]);
    const evidenceRefs = decodeStringArray(o["evidenceRefs"]);
    const origin = str(o["origin"]);
    const advisory = o["advisory"];
    const blockedBy = decodeStringArray(o["blockedBy"]);
    const predicate = decodePredicate(o["predicate"]);
    if (id === undefined || claim === undefined || evidenceRefs === undefined) return undefined;
    if (blockedBy === undefined || predicate === undefined || typeof advisory !== "boolean") return undefined;
    if (state !== "open" && state !== "satisfied" && state !== "blocked" && state !== "invalidated") return undefined;
    if (
      origin !== "source-requirement" && origin !== "direct-evidence"
      && origin !== "existing-check" && origin !== "heuristic"
    ) {
      return undefined;
    }
    // `advisory` is derived from `origin`; a record that disagrees has been
    // tampered with or written by a different version. Fail closed.
    if (advisory !== (origin === "heuristic")) return undefined;
    out.push({ id, claim, state, evidenceRefs, origin, advisory, blockedBy, predicate });
  }
  return out;
}

function decodePredicate(value: unknown): ObligationNode["predicate"] | undefined {
  const o = obj(value);
  if (o === undefined) return undefined;
  const kind = str(o["kind"]);
  switch (kind) {
    case "any-grounded-evidence":
      return { kind: "any-grounded-evidence" };
    case "manual":
      return { kind: "manual" };
    case "min-grounded-evidence": {
      const count = num(o["count"]);
      return count === undefined ? undefined : { kind: "min-grounded-evidence", count };
    }
    case "named-evidence": {
      const ids = decodeStringArray(o["evidenceIds"]);
      return ids === undefined ? undefined : { kind: "named-evidence", evidenceIds: ids };
    }
    default:
      return undefined;
  }
}

function decodeDecision(value: unknown): TaskReasoningIRv2["decision"] | undefined {
  const o = obj(value);
  const state = o === undefined ? undefined : str(o["state"]);
  const evidenceRefs = o === undefined ? undefined : decodeStringArray(o["evidenceRefs"]);
  if (evidenceRefs === undefined) return undefined;
  if (
    state !== "pending" && state !== "prepared" && state !== "acting"
    && state !== "verifying" && state !== "done"
  ) {
    return undefined;
  }
  return { state, evidenceRefs };
}

function decodeTombstones(value: unknown): HypothesisTombstone[] | undefined {
  const items = arr(value);
  if (items === undefined) return undefined;
  const out: HypothesisTombstone[] = [];
  for (const item of items) {
    const o = obj(item);
    if (o === undefined) return undefined;
    const id = str(o["id"]);
    const claim = str(o["claim"]);
    const scope = obj(o["scope"]);
    const evidenceRefs = decodeStringArray(o["evidenceRefs"]);
    const strength = str(o["strength"]);
    const reviveCondition = str(o["reviveCondition"]);
    const validityKeys = decodeValidityKeys(o["validityKeys"]);
    if (id === undefined || claim === undefined || scope === undefined) return undefined;
    if (evidenceRefs === undefined || reviveCondition === undefined || validityKeys === undefined) return undefined;
    if (strength !== "weak" && strength !== "strong") return undefined;

    const scopeKind = str(scope["kind"]);
    const description = str(scope["description"]);
    const complete = scope["complete"];
    if (description === undefined || typeof complete !== "boolean") return undefined;
    if (scopeKind !== "repository" && scopeKind !== "paths" && scopeKind !== "symbol" && scopeKind !== "query") {
      return undefined;
    }
    const paths = scope["paths"] === undefined ? undefined : decodeStringArray(scope["paths"]);
    if (scope["paths"] !== undefined && paths === undefined) return undefined;

    const absence = o["absence"] === undefined ? undefined : decodeAbsence(o["absence"]);
    if (o["absence"] !== undefined && absence === undefined) return undefined;
    // A strong tombstone with no absence proof cannot be reconstituted: that is
    // the "strong requires complete scope + direct absence" rule surviving a
    // round trip through disk, not just the constructor.
    if (strength === "strong" && (absence === undefined || complete !== true)) return undefined;

    const contradicts = o["contradicts"] === undefined ? undefined : decodeStringArray(o["contradicts"]);
    if (o["contradicts"] !== undefined && contradicts === undefined) return undefined;

    out.push({
      id,
      claim,
      scope: {
        kind: scopeKind,
        description,
        ...(paths === undefined ? {} : { paths }),
        complete,
      },
      evidenceRefs,
      strength,
      reviveCondition,
      validityKeys,
      ...(absence === undefined ? {} : { absence }),
      ...(contradicts === undefined ? {} : { contradicts }),
    });
  }
  return out;
}

function decodeAbsence(value: unknown): HypothesisTombstone["absence"] | undefined {
  const o = obj(value);
  if (o === undefined) return undefined;
  const evidenceId = str(o["evidenceId"]);
  const provider = str(o["provider"]);
  if (evidenceId === undefined || provider === undefined) return undefined;
  if (o["scopeComplete"] !== true || o["observedMatches"] !== 0) return undefined;
  return { evidenceId, scopeComplete: true, observedMatches: 0, provider };
}

function decodeAllowedNext(value: unknown): TaskReasoningIRv2["allowedNext"] | undefined {
  const items = arr(value);
  if (items === undefined) return undefined;
  const out: TaskReasoningIRv2["allowedNext"] = [];
  for (const item of items) {
    const o = obj(item);
    const tool = o === undefined ? undefined : str(o["tool"]);
    const reason = o === undefined ? undefined : str(o["reason"]);
    if (tool === undefined || reason === undefined) return undefined;
    out.push({ tool, reason });
  }
  return out;
}

export function decodeDelta(value: unknown): ReasoningDelta | undefined {
  const o = obj(value);
  if (o === undefined) return undefined;
  const taskRef = str(o["taskRef"]);
  const lane = str(o["lane"]);
  const baseVersion = num(o["baseVersion"]);
  const baseHash = str(o["baseHash"]);
  const newVersion = num(o["newVersion"]);
  const newHash = str(o["newHash"]);
  const deltaId = str(o["deltaId"]);
  const ops = arr(o["ops"]);
  if (taskRef === undefined || lane === undefined || baseVersion === undefined) return undefined;
  if (baseHash === undefined || newVersion === undefined || newHash === undefined) return undefined;
  if (deltaId === undefined || ops === undefined || ops.length === 0) return undefined;
  // Ops are re-validated by `applyReasoningOps` during replay: a structurally
  // wrong op refuses there and the whole load fails closed, so this decoder
  // deliberately does not duplicate the op union's semantics.
  return {
    taskRef,
    lane,
    baseVersion,
    baseHash,
    newVersion,
    newHash,
    deltaId,
    ops: ops as ReasoningDelta["ops"],
  };
}
