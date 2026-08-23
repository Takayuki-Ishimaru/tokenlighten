// ---------------------------------------------------------------------------
// reasoningDelta.ts — `reasoning_delta` for Task Reasoning IR v2 (V11-04).
//
// DESIGN-v0.10-expansion-plan-v1.3.md §7 V11-04: "`reasoning_delta`へ
// base_version、base_hash、new_version、new_hash、add/update/close/invalidateを
// 持たせる" / "hash mismatchでsnapshotへ戻す" / "delta applyをidempotentにする".
// Acceptance: 100% reconstruction from snapshot+delta; 100% full-snapshot
// fallback on base-hash mismatch; invalid obligation closure 0; lane conflict
// and out-of-order delta fixtures 100% refusal.
//
// PURE. No store, no clock, no filesystem. Every function returns fresh values
// and NEVER mutates its input — including on the refusal paths, which return
// the caller's ORIGINAL state object so a rejected delta cannot half-land.
//
// THE HASH BOUNDARY (§4.4), STATED ONCE AND ENFORCED HERE.
// `computeTaskStateHash` projects EXACTLY four components —
// `evidenceCatalog` / `evidenceUses` / `obligations` / `decision` — field by
// field, by name. That explicit projection IS the enforcement: a delivery,
// codec, receipt, context-handle or wire field cannot leak into the hash even
// if some future author parks it on the state object, because nothing copies
// unknown keys. `goal`, `constraints`, `tombstones`, `allowedNext`,
// `invalidationKeys` and `appliedDeltaIds` ride the STATE and are deliberately
// outside its IDENTITY.
//
// WHICH MEANS ORDERING CANNOT LEAN ON THE HASH ALONE, and does not:
//   * ORDER is `(baseVersion, baseHash)` — a delta whose base does not match
//     the live state is REFUSED with `fallback:"full-snapshot"`, never
//     best-effort patched.
//   * IDEMPOTENCY is `deltaId` — a bounded ring of applied ids on the state.
//     Re-applying a delta already in the ring is a proved no-op returning the
//     SAME state (hence the same newHash), which is what "idempotent apply"
//     has to mean for a state whose hash is narrower than its content.
//   * INTEGRITY is the post-apply check: if replaying the ops does not
//     reproduce the delta's own `newVersion`/`newHash`, the delta is refused
//     and the original state is returned untouched.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import type {
  EvidenceId,
  EvidenceIdentity,
  EvidenceUse,
  HypothesisTombstone,
  ObligationNode,
  ReasoningDelta,
  ReasoningDeltaOp,
  TaskReasoningIRv2,
} from "@tokenlighten/types";
import {
  canClose,
  deriveDagEnabled,
  normalizeObligationNode,
  validateObligationEdges,
  type ObligationClosureState,
} from "./obligationDag.js";

/** Ops per delta; a delta larger than this is a snapshot in disguise. */
export const REASONING_DELTA_OPS_MAX = 64;

/** Bounded idempotency ring carried on the state. */
export const APPLIED_DELTA_IDS_MAX = 32;

/**
 * The §4.4 task_state identity, by name. Exported so a spec can assert the
 * boundary as DATA rather than by re-deriving it — see this module's header.
 */
export const TASK_STATE_HASH_COMPONENTS = [
  "evidenceCatalog",
  "evidenceUses",
  "obligations",
  "decision",
] as const;

// ---------------------------------------------------------------------------
// Canonicalization + hashing
// ---------------------------------------------------------------------------

/**
 * Key-sorted, undefined-dropping JSON. Same contract as IR v1's private helper
 * (`reasoningIr.ts`) — reproduced rather than shared because v1 is frozen and
 * must keep no dependency on v2.
 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/** The four §4.4 components, and nothing else, of a state-shaped value. */
export type TaskStateHashSubject = Pick<
  TaskReasoningIRv2,
  "evidenceCatalog" | "evidenceUses" | "obligations" | "decision"
>;

/**
 * `task_state_hash`. Array ORDER is significant (obligations and evidence are
 * ordered projections, and reordering them is a real state change); object key
 * order is not (stableStringify sorts).
 */
export function computeTaskStateHash(state: TaskStateHashSubject): string {
  const subject = {
    evidenceCatalog: state.evidenceCatalog.map(canonicalEvidence),
    evidenceUses: state.evidenceUses.map(canonicalUse),
    obligations: state.obligations.map(canonicalObligation),
    decision: {
      state: state.decision.state,
      evidenceRefs: [...state.decision.evidenceRefs],
    },
  };
  return createHash("sha256").update(stableStringify(subject)).digest("hex");
}

function canonicalEvidence(e: EvidenceIdentity): Record<string, unknown> {
  return {
    evidenceId: e.evidenceId,
    kind: e.source.kind,
    uri: e.source.uri,
    contentHash: e.source.contentHash,
    indexGeneration: e.source.indexGeneration,
    lineRange: e.locator?.lineRange,
    symbol: e.locator?.symbol,
    sectionId: e.locator?.sectionId,
    evidenceClass: e.evidenceClass,
    validityKeys: e.validityKeys.map((k) => ({ type: k.type, value: k.value })),
  };
}

function canonicalUse(u: EvidenceUse): Record<string, unknown> {
  return {
    taskRef: u.taskRef,
    evidenceId: u.evidenceId,
    roles: [...u.roles],
    obligationIds: [...u.obligationIds],
    required: u.required,
  };
}

function canonicalObligation(o: ObligationNode): Record<string, unknown> {
  return {
    id: o.id,
    claim: o.claim,
    state: o.state,
    evidenceRefs: [...o.evidenceRefs],
    origin: o.origin,
    advisory: o.advisory,
    blockedBy: [...o.blockedBy],
    predicate: o.predicate,
  };
}

/** The stable identity of a delta: its base, its lane/task, and its ops. */
export function computeDeltaId(input: {
  taskRef: string;
  lane: string;
  baseVersion: number;
  baseHash: string;
  ops: readonly ReasoningDeltaOp[];
}): string {
  return createHash("sha256")
    .update(
      stableStringify({
        taskRef: input.taskRef,
        lane: input.lane,
        baseVersion: input.baseVersion,
        baseHash: input.baseHash,
        ops: input.ops,
      }),
    )
    .digest("hex")
    .slice(0, 24);
}

// ---------------------------------------------------------------------------
// Op application
// ---------------------------------------------------------------------------

export type OpRefusalReason =
  | "no-ops"
  | "too-many-ops"
  | "duplicate-evidence"
  | "duplicate-obligation"
  | "duplicate-tombstone"
  | "unknown-evidence"
  | "unknown-obligation"
  | "unknown-tombstone"
  | "invalid-closure"
  | "invalid-edges";

export type ApplyOpsResult =
  | { ok: true; state: TaskReasoningIRv2 }
  | { ok: false; reason: OpRefusalReason; detail: string };

interface Draft {
  evidenceCatalog: EvidenceIdentity[];
  evidenceUses: EvidenceUse[];
  obligations: ObligationNode[];
  tombstones: HypothesisTombstone[];
  decision: TaskReasoningIRv2["decision"];
}

function draftOf(state: TaskReasoningIRv2): Draft {
  return {
    evidenceCatalog: [...state.evidenceCatalog],
    evidenceUses: [...state.evidenceUses],
    obligations: state.obligations.map((o) => ({ ...o, evidenceRefs: [...o.evidenceRefs], blockedBy: [...o.blockedBy] })),
    tombstones: [...state.tombstones],
    decision: { state: state.decision.state, evidenceRefs: [...state.decision.evidenceRefs] },
  };
}

function closureViewOf(draft: Draft): ObligationClosureState {
  return { obligations: draft.obligations, evidenceCatalog: draft.evidenceCatalog };
}

/**
 * Replay `ops` onto `state`, producing the NEXT state (version bumped, hash
 * recomputed) or a refusal. The caller's state is never mutated.
 *
 * `appliedDeltaIds` is NOT touched here — `buildReasoningDelta` /
 * `applyReasoningDelta` own the ledger, because only they know the delta id.
 */
export function applyReasoningOps(
  state: TaskReasoningIRv2,
  ops: readonly ReasoningDeltaOp[],
): ApplyOpsResult {
  if (ops.length === 0) return { ok: false, reason: "no-ops", detail: "a delta must carry at least one op" };
  if (ops.length > REASONING_DELTA_OPS_MAX) {
    return { ok: false, reason: "too-many-ops", detail: `${ops.length} ops exceeds ${REASONING_DELTA_OPS_MAX}` };
  }

  const draft = draftOf(state);

  for (const op of ops) {
    const failure = applyOne(draft, op);
    if (failure !== undefined) return { ok: false, ...failure };
  }

  // A delta may add nodes or repoint edges; re-run the SAME structural check
  // construction uses, so a cycle introduced incrementally is refused exactly
  // like a cycle present up front.
  const edges = validateObligationEdges(draft.obligations);
  if (edges !== undefined) {
    return { ok: false, reason: "invalid-edges", detail: edges.detail };
  }

  const next: TaskReasoningIRv2 = {
    ...state,
    evidenceCatalog: draft.evidenceCatalog,
    evidenceUses: draft.evidenceUses,
    obligations: draft.obligations,
    tombstones: draft.tombstones,
    decision: draft.decision,
    // Derived from the hashed obligations, so replay reproduces it exactly.
    dagEnabled: deriveDagEnabled(draft.obligations),
    stateVersion: state.stateVersion + 1,
    stateHash: "",
  };
  next.stateHash = computeTaskStateHash(next);
  return { ok: true, state: next };
}

type OpFailure = { reason: OpRefusalReason; detail: string };

function applyOne(draft: Draft, op: ReasoningDeltaOp): OpFailure | undefined {
  switch (op.op) {
    case "add":
      return applyAdd(draft, op);
    case "update":
      return applyUpdate(draft, op);
    case "close":
      return applyClose(draft, op.id);
    case "invalidate":
      return applyInvalidate(draft, op);
    default:
      return { reason: "no-ops", detail: "unrecognized op" };
  }
}

function applyAdd(draft: Draft, op: Extract<ReasoningDeltaOp, { op: "add" }>): OpFailure | undefined {
  switch (op.target) {
    case "evidence": {
      if (draft.evidenceCatalog.some((e) => e.evidenceId === op.evidence.evidenceId)) {
        return { reason: "duplicate-evidence", detail: `evidence ${op.evidence.evidenceId} already cataloged` };
      }
      draft.evidenceCatalog.push(op.evidence);
      return undefined;
    }
    case "use": {
      draft.evidenceUses.push(op.use);
      return undefined;
    }
    case "obligation": {
      if (draft.obligations.some((o) => o.id === op.obligation.id)) {
        return { reason: "duplicate-obligation", detail: `obligation ${op.obligation.id} already present` };
      }
      // An obligation may NOT arrive pre-satisfied: closure is `canClose`'s
      // decision alone, so an `add` lands it open (or blocked/invalidated) and
      // a later `close` op has to earn the promotion.
      const node = normalizeObligationNode(op.obligation);
      draft.obligations.push(node.state === "satisfied" ? { ...node, state: "open" } : node);
      return undefined;
    }
    case "tombstone": {
      if (draft.tombstones.some((t) => t.id === op.tombstone.id)) {
        return { reason: "duplicate-tombstone", detail: `tombstone ${op.tombstone.id} already present` };
      }
      draft.tombstones.push(op.tombstone);
      return undefined;
    }
    default:
      return { reason: "no-ops", detail: "unrecognized add target" };
  }
}

function applyUpdate(draft: Draft, op: Extract<ReasoningDeltaOp, { op: "update" }>): OpFailure | undefined {
  if (op.target === "decision") {
    draft.decision = { state: op.decision.state, evidenceRefs: [...op.decision.evidenceRefs] };
    return undefined;
  }
  const idx = draft.obligations.findIndex((o) => o.id === op.id);
  if (idx === -1) return { reason: "unknown-obligation", detail: `no obligation ${op.id}` };
  const before = draft.obligations[idx]!;
  const patched: ObligationNode = normalizeObligationNode({
    ...before,
    ...(op.patch.claim === undefined ? {} : { claim: op.patch.claim }),
    ...(op.patch.evidenceRefs === undefined ? {} : { evidenceRefs: [...op.patch.evidenceRefs] }),
    ...(op.patch.blockedBy === undefined ? {} : { blockedBy: [...op.patch.blockedBy] }),
    ...(op.patch.predicate === undefined ? {} : { predicate: op.patch.predicate }),
    // The requested state is applied BELOW, through the gate — never here.
    state: before.state,
  });
  draft.obligations[idx] = patched;

  if (op.patch.state === undefined || op.patch.state === patched.state) return undefined;
  if (op.patch.state === "satisfied") {
    // Same gate as `close`. An update is not a back door.
    const verdict = canClose(op.id, closureViewOf(draft));
    if (!verdict.ok) {
      return { reason: "invalid-closure", detail: `${verdict.reason}: ${verdict.detail}` };
    }
  }
  draft.obligations[idx] = { ...patched, state: op.patch.state };
  return undefined;
}

function applyClose(draft: Draft, id: string): OpFailure | undefined {
  const idx = draft.obligations.findIndex((o) => o.id === id);
  if (idx === -1) return { reason: "unknown-obligation", detail: `no obligation ${id}` };
  const verdict = canClose(id, closureViewOf(draft));
  if (!verdict.ok) return { reason: "invalid-closure", detail: `${verdict.reason}: ${verdict.detail}` };
  draft.obligations[idx] = { ...draft.obligations[idx]!, state: "satisfied" };
  return undefined;
}

function applyInvalidate(
  draft: Draft,
  op: Extract<ReasoningDeltaOp, { op: "invalidate" }>,
): OpFailure | undefined {
  switch (op.target) {
    case "obligation": {
      const idx = draft.obligations.findIndex((o) => o.id === op.id);
      if (idx === -1) return { reason: "unknown-obligation", detail: `no obligation ${op.id}` };
      draft.obligations[idx] = { ...draft.obligations[idx]!, state: "invalidated" };
      return undefined;
    }
    case "tombstone": {
      const before = draft.tombstones.length;
      draft.tombstones = draft.tombstones.filter((t) => t.id !== op.id);
      if (draft.tombstones.length === before) {
        return { reason: "unknown-tombstone", detail: `no tombstone ${op.id}` };
      }
      return undefined;
    }
    case "evidence":
      return invalidateEvidence(draft, op.id);
    default:
      return { reason: "no-ops", detail: "unrecognized invalidate target" };
  }
}

/**
 * Fine-grained evidence invalidation (plan §7: SHA / index generation /
 * provider coverage / user change). The evidence leaves the catalog, every
 * reference to it is stripped, and any obligation that was `"satisfied"` on the
 * strength of it is DEMOTED back to `"open"` unless it still passes the gate on
 * its remaining evidence. Stale grounding is never silently retained.
 */
function invalidateEvidence(draft: Draft, evidenceId: EvidenceId): OpFailure | undefined {
  if (!draft.evidenceCatalog.some((e) => e.evidenceId === evidenceId)) {
    return { reason: "unknown-evidence", detail: `no evidence ${evidenceId}` };
  }
  draft.evidenceCatalog = draft.evidenceCatalog.filter((e) => e.evidenceId !== evidenceId);
  draft.evidenceUses = draft.evidenceUses.filter((u) => u.evidenceId !== evidenceId);
  draft.decision = {
    state: draft.decision.state,
    evidenceRefs: draft.decision.evidenceRefs.filter((r) => r !== evidenceId),
  };
  draft.obligations = draft.obligations.map((o) =>
    o.evidenceRefs.includes(evidenceId)
      ? { ...o, evidenceRefs: o.evidenceRefs.filter((r) => r !== evidenceId) }
      : o,
  );
  const view = closureViewOf(draft);
  draft.obligations = draft.obligations.map((o) =>
    o.state === "satisfied" && !canClose(o.id, view).ok ? { ...o, state: "open" } : o,
  );
  return undefined;
}

// ---------------------------------------------------------------------------
// Delta construction
// ---------------------------------------------------------------------------

export type BuildDeltaResult =
  | { ok: true; delta: ReasoningDelta; state: TaskReasoningIRv2 }
  | { ok: false; reason: OpRefusalReason; detail: string };

/**
 * Build the delta that carries `state` through `ops`, and return the resulting
 * state with the delta recorded in its idempotency ring.
 */
export function buildReasoningDelta(
  state: TaskReasoningIRv2,
  ops: readonly ReasoningDeltaOp[],
): BuildDeltaResult {
  const applied = applyReasoningOps(state, ops);
  if (!applied.ok) return applied;

  const deltaId = computeDeltaId({
    taskRef: state.taskRef,
    lane: state.lane,
    baseVersion: state.stateVersion,
    baseHash: state.stateHash,
    ops,
  });
  const delta: ReasoningDelta = {
    taskRef: state.taskRef,
    lane: state.lane,
    baseVersion: state.stateVersion,
    baseHash: state.stateHash,
    newVersion: applied.state.stateVersion,
    newHash: applied.state.stateHash,
    deltaId,
    ops: [...ops],
  };
  return { ok: true, delta, state: withAppliedDelta(applied.state, deltaId) };
}

function withAppliedDelta(state: TaskReasoningIRv2, deltaId: string): TaskReasoningIRv2 {
  const ring = [...state.appliedDeltaIds.filter((id) => id !== deltaId), deltaId];
  return { ...state, appliedDeltaIds: ring.slice(-APPLIED_DELTA_IDS_MAX) };
}

// ---------------------------------------------------------------------------
// Delta application
// ---------------------------------------------------------------------------

export type DeltaRefusalOutcome =
  | "task-mismatch"
  | "lane-mismatch"
  | "out-of-order"
  | "base-hash-mismatch"
  | "hash-divergence"
  | "op-refused";

export type ApplyDeltaResult =
  | { ok: true; outcome: "applied" | "already-applied"; state: TaskReasoningIRv2 }
  | {
      ok: false;
      outcome: DeltaRefusalOutcome;
      /** ALWAYS `"full-snapshot"`: there is no partial-patch recovery in this model. */
      fallback: "full-snapshot";
      detail: string;
      expected?: string | number;
      actual?: string | number;
      /** The caller's state, unchanged — a refused delta lands nothing. */
      state: TaskReasoningIRv2;
    };

/**
 * Apply one delta. Every refusal returns `fallback:"full-snapshot"` and the
 * ORIGINAL state: hash mismatch, version skew, cross-lane delivery and internal
 * divergence all recover the same way — re-read the snapshot — and none of them
 * ever produces a half-patched state.
 */
export function applyReasoningDelta(
  state: TaskReasoningIRv2,
  delta: ReasoningDelta,
): ApplyDeltaResult {
  if (delta.taskRef !== state.taskRef) {
    return refuse(state, "task-mismatch", "delta belongs to another task", state.taskRef, delta.taskRef);
  }
  if (delta.lane !== state.lane) {
    // Lane isolation: two agents multiplexed over one workspace must never
    // cross-apply. The store keys by lane too, so this is the second fence.
    return refuse(state, "lane-mismatch", "delta belongs to another lane", state.lane, delta.lane);
  }

  // IDEMPOTENCY FIRST: a duplicate replay is a no-op even when the state has
  // since moved on, so a retried transport never double-applies.
  if (state.appliedDeltaIds.includes(delta.deltaId)) {
    return { ok: true, outcome: "already-applied", state };
  }

  if (delta.baseVersion !== state.stateVersion) {
    return refuse(state, "out-of-order", "delta base version does not match live state", state.stateVersion, delta.baseVersion);
  }
  if (delta.baseHash !== state.stateHash) {
    return refuse(state, "base-hash-mismatch", "delta base hash does not match live state", state.stateHash, delta.baseHash);
  }

  const applied = applyReasoningOps(state, delta.ops);
  if (!applied.ok) {
    return refuse(state, "op-refused", `${applied.reason}: ${applied.detail}`);
  }
  if (applied.state.stateVersion !== delta.newVersion) {
    return refuse(state, "hash-divergence", "replay produced a different version", delta.newVersion, applied.state.stateVersion);
  }
  if (applied.state.stateHash !== delta.newHash) {
    return refuse(state, "hash-divergence", "replay produced a different state hash", delta.newHash, applied.state.stateHash);
  }
  return { ok: true, outcome: "applied", state: withAppliedDelta(applied.state, delta.deltaId) };
}

function refuse(
  state: TaskReasoningIRv2,
  outcome: DeltaRefusalOutcome,
  detail: string,
  expected?: string | number,
  actual?: string | number,
): ApplyDeltaResult {
  return {
    ok: false,
    outcome,
    fallback: "full-snapshot",
    detail,
    ...(expected === undefined ? {} : { expected }),
    ...(actual === undefined ? {} : { actual }),
    state,
  };
}

/**
 * Replay a whole delta log onto a checkpoint. ALL-OR-NOTHING: the first refusal
 * aborts, because a partially replayed log is exactly the "state drift" failure
 * mode plan §7 names ("delta欠落・順序競合でstateがずれる").
 */
export function replayReasoningDeltas(
  checkpoint: TaskReasoningIRv2,
  deltas: readonly ReasoningDelta[],
): { ok: true; state: TaskReasoningIRv2 } | { ok: false; index: number; outcome: DeltaRefusalOutcome; detail: string } {
  let state = checkpoint;
  for (let i = 0; i < deltas.length; i += 1) {
    const result = applyReasoningDelta(state, deltas[i]!);
    if (!result.ok) return { ok: false, index: i, outcome: result.outcome, detail: result.detail };
    state = result.state;
  }
  return { ok: true, state };
}
