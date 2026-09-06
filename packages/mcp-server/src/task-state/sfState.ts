// ---------------------------------------------------------------------------
// sfState.ts — the Semantic Frontier (v0.15) state adapter over Task Reasoning
// IR v2.
//
// DESIGN-v0.15-semantic-frontier-plan.md §3.2 (state schema, keying, the
// epoch/restart/force_serve table, the served ledger), §3.3 (lifecycle), §5
// (flags), §9 row W3.
//
// D1 — A NEW SEAM, NOT A MODIFIED ONE. The ratified decision promotes IR v2
// from a trace-only shadow into a decision-path supplier. It does so by adding
// THIS module ALONGSIDE `irDispatchSeam.ts`, never by loosening that module.
// `irDispatchSeam.ts`'s three-sentence contract ("never touches the response /
// never throws / never runs with the flag off") therefore stays LITERALLY true
// of `irDispatchSeam.ts`, and `sfState.spec.ts` pins its text byte-for-byte
// against `git show HEAD:` so a future edit cannot quietly re-scope it.
//
// DC3 — TWO LEDGERS, TWO QUESTIONS, NO OVERLAP.
//   * "Does the caller still HOLD these bytes?" is answered ONLY by
//     `state/session.ts`'s `servedRangeLedger` (plus `readPaths` /
//     `verificationSurfacesServed`). That ledger is session-scoped and
//     SURVIVES `task.epoch:"new"`, because an epoch is a new task, not a
//     cleared context window.
//   * "Is this obligation discharged?" is answered ONLY by the IR v2 record's
//     `evidenceCatalog` / `obligations`. That record is PER-EPOCH and is
//     cleared by `task.epoch:"new"`.
// This module never answers the first question from the second. It reads
// residency through `SfServedLedgerReader`, an INJECTED interface — deliberately
// not an import of `state/session.ts`, so Wave 3 owns the wiring and this wave
// adds no coupling to a file another agent is editing.
//
// FAIL-OPEN IS THE WHOLE POINT (invariant I-1). Nothing here may make a read
// fail. Every exported function is total: it returns a snapshot, never throws,
// and degrades to an INERT snapshot (`active:false`) on a missing store, a CAS
// conflict, a corrupt record, or any unexpected defect. An inert snapshot means
// "SF is observation-only for this call" — the caller must behave exactly as it
// does with `TL_SF_STATEFUL` off. CAS conflicts are NEVER retried: an advisory
// projection has no business contending, exactly as `irDispatchSeam.ts` says.
//
// EPOCH / RESTART / FORCE_SERVE, in one table (§3.2.3):
//
//   event                    | IR v2 record (this module) | byte residency
//   -------------------------+----------------------------+----------------
//   task.epoch:"new"         | CLEARED, then re-opened    | kept (DC3)
//                            | fresh at the same key      |
//   task.handle resent       | reloaded from the store by | kept
//   (restart / new process)  | the same key; the LRU is   |
//                            | in-memory so it starts     |
//                            | empty and re-registers on  |
//                            | the first call             |
//   task.force_serve:true    | UNCHANGED semantics: every | kept
//                            | serve is still RECORDED,   |
//                            | only dedup/demotion is     |
//                            | bypassed downstream        |
//                            | (`snapshot.forceServe`)    |
//   CAS conflict             | not retried; inert snapshot| untouched
//   corrupt record           | inert snapshot + recovery  | untouched
//                            | trace                      |
//
// RESTART SEMANTICS ARE IR v2's, NOT NEW ONES. Persistence is
// `WorkspaceStateStore` through `irStore.ts`: one CAS'd record per
// (workspaceRef, taskRef, lane), TTL `IR_STATE_TTL_MS` (24h — the same horizon
// `stateHandles.ts` gives a task handle). A restarted server that is handed the
// same `task.handle` derives the same `taskRef`, loads the same record, and
// continues. Nothing in this module adds a second persistence mechanism.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import type {
  EvidenceIdentity,
  EvidencePredicate,
  EvidenceRole,
  EvidenceUse,
  ObligationNode,
  ObligationOrigin,
  ObligationState,
  ReasoningDelta,
  ReasoningDeltaOp,
  TaskReasoningIRv2,
} from "@tokenlighten/types";
import { sfStatefulEnabled } from "../util/flags.js";
import { LANE_KEY_MARKER } from "../util/laneKey.js";
import { trace } from "../util/trace.js";
import {
  allNonAdvisoryClosed,
  groundedEvidenceIds,
  openNonAdvisoryObligations,
  type EvidenceGroundingClass,
} from "./obligationDag.js";
import { buildReasoningDelta } from "./reasoningDelta.js";
import { deriveIrTaskRef } from "./irDispatchSeam.js";
import {
  checkpointIrState,
  clearIrState,
  IR_STATE_TTL_MS,
  irRecordVersion,
  irStateKey,
  loadIrState,
  recordIrDelta,
  type IrLoadResult,
  type IrWriteResult,
} from "./irStore.js";
import { emptyIrV2State, IRV2_EVIDENCE_MAX, IRV2_USES_MAX } from "./reasoningIrV2.js";

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/**
 * LRU ceiling on live SF task records per (workspaceRef, lane).
 *
 * `taskRef` changes on every `task.epoch:"new"`, so a long-lived session would
 * otherwise grow one record per epoch until the 24h TTL swept them — `irStore`
 * has a TTL but no record-count bound. Eviction drops the LEAST recently
 * touched record (`clearIrState`), the same shape `state/session.ts` uses for
 * idle sessions.
 *
 * The plan's §3.2.2 first estimate was 16; it is 256 here on the
 * orchestrator's instruction. Eviction destroys a task's obligation graph, and
 * a shared workspace can legitimately hold many concurrent lanes' worth of
 * short tasks, so the bound is set well above realistic concurrency. It is
 * still bounded and still cheap: the LRU holds a key string, not a record.
 */
export const SF_TASK_RECORDS_MAX = 256;

/**
 * LRU ceiling on distinct LANES held per workspace (SF-F6/F7).
 *
 * `SF_TASK_RECORDS_MAX` bounds records WITHIN one (workspace, lane) group, but
 * the group table itself was unbounded: a caller that sends a fresh `lane` on
 * every call — a shared workspace whose orchestrator mints per-subagent lane
 * ids is the realistic shape — grew one live group per lane forever, each
 * holding up to 256 record keys, and nothing ever dropped one.
 *
 * A lane is evicted whole: every record key it holds is cleared through the
 * store port, exactly as a record eviction does, so an evicted lane leaks
 * neither memory nor a persisted record. 32 is well above the lane cardinality
 * of every observed orchestrator topology (`util/laneKey.ts`'s own BOUNDS
 * note), so a cooperative deployment never reaches it.
 */
export const SF_LANES_PER_WORKSPACE_MAX = 32;

/**
 * Ceiling on SF-authored concerns in one record. `IRV2_OBLIGATIONS_MAX` is 32;
 * SF takes at most half and leaves the rest for check-derived obligations
 * (§3.2.2).
 */
export const SF_CONCERN_MAX = 16;

/** TTL is IR v2's, reused verbatim — this module introduces no second horizon. */
export const SF_STATE_TTL_MS = IR_STATE_TTL_MS;

// ---------------------------------------------------------------------------
// Ports: everything this module touches that it does not own
// ---------------------------------------------------------------------------

/**
 * The byte-residency reader (DC3). Wave 3 supplies an implementation backed by
 * `state/session.ts` — `getReadPaths` / `wasFullyServed` / `servedRangeCoverage`,
 * whose signatures these methods mirror minus the leading `workspaceRoot`.
 * Declared as an interface rather than imported so this wave adds NO dependency
 * on a file a concurrent agent is editing.
 *
 * Every method is a pure query. This module never WRITES to the served ledger:
 * recording a serve belongs to the read path, and duplicating it here would be
 * exactly the double-ledger the plan forbids.
 */
export interface SfServedLedgerReader {
  /** `getReadPaths()` membership: has any body of this path been served? */
  hasServedPath(path: string): boolean;
  /** `wasFullyServed(workspaceRoot, path, sha)`. */
  wasFullyServed(path: string, sha: string): boolean;
  /**
   * `servedRangeCoverage(workspaceRoot, path, sha, totalLines)`. `undefined` is
   * the conservative "no claim" answer, never "nothing was served".
   */
  servedRangeCoverage(
    path: string,
    sha: string,
    totalLines: number,
  ): { served: Array<[number, number]>; unserved: string[]; complete: boolean } | undefined;
}

/**
 * The IR v2 store port. Defaults to the real `irStore` functions; a spec (or a
 * future in-memory harness) substitutes one to inject a CAS conflict, an
 * unavailable store, or a corrupt record — which is how invariant I-1 is
 * TESTED rather than merely asserted.
 */
export interface SfIrStorePort {
  load(workspaceRoot: string, key: string): IrLoadResult;
  version(workspaceRoot: string, key: string): number;
  checkpoint(
    workspaceRoot: string,
    key: string,
    state: TaskReasoningIRv2,
    expectedVersion: number,
  ): IrWriteResult;
  delta(
    workspaceRoot: string,
    key: string,
    delta: ReasoningDelta,
    state: TaskReasoningIRv2,
    expectedVersion: number,
  ): IrWriteResult;
  clear(workspaceRoot: string, key: string): void;
}

/** The production port: `irStore.ts`, unwrapped. */
export const defaultSfStorePort: SfIrStorePort = {
  load: (workspaceRoot, key) => loadIrState(workspaceRoot, key),
  version: (workspaceRoot, key) => irRecordVersion(workspaceRoot, key),
  checkpoint: (workspaceRoot, key, state, expectedVersion) =>
    checkpointIrState(workspaceRoot, key, state, expectedVersion),
  delta: (workspaceRoot, key, delta, state, expectedVersion) =>
    recordIrDelta(workspaceRoot, key, delta, state, expectedVersion),
  clear: (workspaceRoot, key) => clearIrState(workspaceRoot, key),
};

// ---------------------------------------------------------------------------
// Context and inputs
// ---------------------------------------------------------------------------

/**
 * Everything one SF call knows about its task. Carried per call rather than
 * held in a module singleton, so two lanes of one workspace can never share
 * accidental state.
 */
export interface SfTaskContext {
  /** Resolved worktree root. Also the store's own scope. */
  workspaceRoot: string;
  /** The caller's fixed lane; "" (or absent) is the shared default lane. */
  lane?: string;
  /** Task fingerprint resolved from `task.handle` — the strongest identity. */
  taskId?: string;
  /** The pack's replay ref, when dispatch already holds one. */
  qref?: string;
  /** Verbatim request text; hashed as the last-resort identity. */
  query?: string;
  /** `task.epoch:"new"` — clears the IR record (never the served ledger). */
  epochNew?: boolean;
  /** `task.force_serve:true` — record everything, suppress nothing. */
  forceServe?: boolean;
  /** DC3 byte-residency reader. Absent means residency is UNKNOWN, never "no". */
  ledger?: SfServedLedgerReader;
  /** Store override; production leaves it unset. */
  store?: SfIrStorePort;
}

/** One SF concern, in the shape `openSfTask` seeds an `ObligationNode` from. */
export interface SfConcernInput {
  id: string;
  claim: string;
  /** Default `"source-requirement"`. `"heuristic"` is the only advisory origin. */
  origin?: ObligationOrigin;
  blockedBy?: readonly string[];
  /** Default `{kind:"any-grounded-evidence"}`. */
  predicate?: EvidencePredicate;
  /**
   * What the caller wants DONE with this concern, in the FOUR-value vocabulary
   * `ObligationNode.disposition` (§3.2.1) spells — written straight through the
   * `add` op, so a record round-trips it (`irStore.decodeObligations` and
   * `obligationDag.normalizeNode` already carry the field; nothing was
   * WRITING it, which is why every persisted node had it absent).
   *
   * DELIBERATELY NOT NAMED `disposition`: `sfConcerns.SfStructuralConcern`
   * carries a five-value SF vocabulary under that name (it adds `answer`, the
   * read-only sibling of `edit`), and that interface EXTENDS this one. Two
   * different value sets cannot share one property name across an `extends`,
   * so the extractor maps its own value through `obligationDisposition()` and
   * assigns the result here.
   */
  nodeDisposition?: ObligationNode["disposition"];
}

/** One served surface, in the shape `recordServed` catalogs it. */
export interface SfServedEvidence {
  /** Stable id; derived from (path, range, symbol, section, sha) when omitted. */
  evidenceId?: string;
  /** Source uri — a workspace-relative path for `kind:"file"`. */
  path: string;
  /** Content hash of the bytes served. Absent or "" means STRUCTURAL, never direct. */
  sha?: string;
  lineRange?: { startLine: number; endLine: number };
  symbol?: string;
  sectionId?: string;
  sourceKind?: EvidenceIdentity["source"]["kind"];
  /** Default: `"direct"` with a sha, `"structural"` without one. */
  evidenceClass?: EvidenceIdentity["evidenceClass"];
  roles?: readonly EvidenceRole[];
  /** Concerns this serve contributes to; their `evidenceRefs` gain the id. */
  concernIds?: readonly string[];
  /**
   * I-2: true when the CALLER named this address (explicit `targets`). A
   * required use is permanent and puts the address permanently out of reach of
   * demotion.
   */
  required?: boolean;
}

/** The decision state SF observed for this task. */
export interface SfDecisionInput {
  state: TaskReasoningIRv2["decision"]["state"];
  evidenceRefs?: readonly string[];
}

/** What is offered as proof that a concern is discharged. */
export interface SfSatisfactionProof {
  /** Evidence ids that ground the closure. Merged into the concern's refs. */
  evidenceIds?: readonly string[];
  /** Free-text provenance for the trace line; never load-bearing. */
  note?: string;
  /**
   * The grounding CLASS this concern's claim demands (SF-F2). `"direct"` means
   * the claim is about BYTES — a definition, a template/generated product, a
   * verification, an explanation — so a `structural` catalog entry (an address
   * that exists, whose bytes never went out) may not close it. Omitted means
   * `"structural"`, the permissive default every pre-existing caller had.
   *
   * Checked HERE rather than inside `obligationDag.canClose`, because the
   * class is a property of the SF CONCERN (its kind), not of the generic
   * obligation node — `reasoningDelta`'s `close` op carries no room for it,
   * and check-derived obligations keep their own, unrelated, semantics.
   */
  grounding?: EvidenceGroundingClass;
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

export type SfInertReason =
  | "flag-off"
  | "no-workspace"
  | "absent"
  | "store-unavailable"
  | "cas-conflict"
  | "corrupt"
  | "record-too-large"
  | "internal-error";

export interface SfConcernView {
  id: string;
  claim: string;
  state: ObligationState;
  advisory: boolean;
  blockedBy: readonly string[];
  evidenceRefs: readonly string[];
}

/**
 * The adapter's whole output. An INERT snapshot (`active:false`) carries a
 * `reason` and nothing else of substance: the caller must then behave exactly
 * as it does with the flag off.
 */
export interface SfSnapshot {
  active: boolean;
  /** Present iff `active === false`. */
  reason?: SfInertReason;
  /**
   * Present on an ACTIVE snapshot whose last requested mutation was refused by
   * the IR gate (e.g. `invalid-closure`). The state is unchanged and readable;
   * this is a refusal, not a failure.
   */
  lastRefusal?: string;
  taskRef: string;
  lane: string;
  key: string;
  stateVersion: number;
  stateHash: string;
  concerns: readonly SfConcernView[];
  satisfied: readonly string[];
  openNonAdvisory: readonly string[];
  allNonAdvisoryClosed: boolean;
  evidenceCount: number;
  /** Source uris of every `required:true` use — permanently un-demotable (I-2). */
  requiredAddresses: readonly string[];
  /** Mirrors `ctx.forceServe`: downstream must suppress nothing on this call. */
  forceServe: boolean;
  /** True when this call opened a fresh record for `task.epoch:"new"`. */
  epochFresh: boolean;
  /** False when no `SfServedLedgerReader` was injected: residency is UNKNOWN. */
  ledgerWired: boolean;
}

/** Byte residency, as answered by the served ledger ALONE (DC3). */
export type SfResidency =
  | { known: false; reason: "no-ledger" }
  | {
      known: true;
      servedPath: boolean;
      fullyServed: boolean;
      complete: boolean;
      unserved: readonly string[];
    };

function inert(
  reason: SfInertReason,
  taskRef = "",
  lane = "",
  key = "",
  forceServe = false,
): SfSnapshot {
  return {
    active: false,
    reason,
    taskRef,
    lane,
    key,
    stateVersion: 0,
    stateHash: "",
    concerns: [],
    satisfied: [],
    openNonAdvisory: [],
    allNonAdvisoryClosed: false,
    evidenceCount: 0,
    requiredAddresses: [],
    forceServe,
    epochFresh: false,
    ledgerWired: false,
  };
}

function closureViewOf(state: TaskReasoningIRv2): {
  obligations: readonly ObligationNode[];
  evidenceCatalog: readonly EvidenceIdentity[];
} {
  return { obligations: state.obligations, evidenceCatalog: state.evidenceCatalog };
}

function snapshotOf(
  state: TaskReasoningIRv2,
  ctx: SfTaskContext,
  key: string,
  extra: { epochFresh?: boolean; lastRefusal?: string } = {},
): SfSnapshot {
  const concerns: SfConcernView[] = state.obligations.map((o) => ({
    id: o.id,
    claim: o.claim,
    state: o.state,
    advisory: o.advisory,
    blockedBy: [...o.blockedBy],
    evidenceRefs: [...o.evidenceRefs],
  }));
  const uriOf = new Map(state.evidenceCatalog.map((e) => [e.evidenceId, e.source.uri] as const));
  const required = new Set<string>();
  for (const use of state.evidenceUses) {
    if (!use.required) continue;
    const uri = uriOf.get(use.evidenceId);
    if (uri !== undefined) required.add(uri);
  }
  const view = closureViewOf(state);
  return {
    active: true,
    ...(extra.lastRefusal === undefined ? {} : { lastRefusal: extra.lastRefusal }),
    taskRef: state.taskRef,
    lane: state.lane,
    key,
    stateVersion: state.stateVersion,
    stateHash: state.stateHash,
    concerns,
    satisfied: concerns.filter((c) => c.state === "satisfied").map((c) => c.id),
    openNonAdvisory: openNonAdvisoryObligations(view).map((o) => o.id),
    allNonAdvisoryClosed: allNonAdvisoryClosed(view),
    evidenceCount: state.evidenceCatalog.length,
    requiredAddresses: [...required].sort(),
    forceServe: ctx.forceServe === true,
    epochFresh: extra.epochFresh === true,
    ledgerWired: ctx.ledger !== undefined,
  };
}

// ---------------------------------------------------------------------------
// LRU over live task records, per (workspaceRef, lane)
// ---------------------------------------------------------------------------

/** groupKey -> (recordKey -> workspaceRoot). A JS `Map` iterates in insertion order. */
const liveRecords = new Map<string, Map<string, string>>();
/** workspaceRoot -> its live lanes, least-recently-touched first (SF-F6/F7). */
const liveLanes = new Map<string, Set<string>>();

/**
 * The (workspace, lane) group key.
 *
 * `LANE_KEY_MARKER` (`util/laneKey.ts`) rather than a space: it is this
 * codebase's ONE lane-composition convention, and it is a NUL, which cannot
 * occur in a filesystem path — so `"/ws a" + lane ""` and `"/ws" + lane "a"`
 * can no longer produce the same group, which the old `${root} ${lane}`
 * spelling allowed. A lane-less call keys on the plain root, identically to
 * `laneScopedKey`, so the default single-agent shape is unchanged.
 */
function groupKeyOf(workspaceRoot: string, lane: string): string {
  return lane === "" ? workspaceRoot : workspaceRoot + LANE_KEY_MARKER + lane;
}

/** Drop `lane` from `workspaceRoot`, clearing every record it still holds. */
function evictLane(workspaceRoot: string, lane: string, port: SfIrStorePort): void {
  const group = groupKeyOf(workspaceRoot, lane);
  const records = liveRecords.get(group);
  liveRecords.delete(group);
  liveLanes.get(workspaceRoot)?.delete(lane);
  for (const [recordKey, root] of records ?? []) {
    try {
      port.clear(root, recordKey);
    } catch {
      /* fail-open: an un-evictable record is a leak, never a failed read */
    }
  }
  emit(
    "sf_state_lane_evicted",
    { lane, records: records?.size ?? 0, live_lanes: liveLanes.get(workspaceRoot)?.size ?? 0 },
    workspaceRoot,
  );
}

/** Move `lane` to the most-recent end, then evict past `SF_LANES_PER_WORKSPACE_MAX`. */
function touchLane(workspaceRoot: string, lane: string, port: SfIrStorePort): void {
  let lanes = liveLanes.get(workspaceRoot);
  if (lanes === undefined) {
    lanes = new Set<string>();
    liveLanes.set(workspaceRoot, lanes);
  }
  lanes.delete(lane);
  lanes.add(lane);
  while (lanes.size > SF_LANES_PER_WORKSPACE_MAX) {
    const oldest = lanes.values().next().value as string | undefined;
    if (oldest === undefined || oldest === lane) break;
    evictLane(workspaceRoot, oldest, port);
  }
}

/** Move `key` to the most-recent end, then evict past `SF_TASK_RECORDS_MAX`. */
function touchRecord(ctx: SfTaskContext, lane: string, key: string, port: SfIrStorePort): void {
  const group = groupKeyOf(ctx.workspaceRoot, lane);
  touchLane(ctx.workspaceRoot, lane, port);
  let records = liveRecords.get(group);
  if (records === undefined) {
    records = new Map();
    liveRecords.set(group, records);
  }
  records.delete(key);
  records.set(key, ctx.workspaceRoot);
  while (records.size > SF_TASK_RECORDS_MAX) {
    const oldest = records.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    const root = records.get(oldest) ?? ctx.workspaceRoot;
    records.delete(oldest);
    // Eviction DROPS the record: a task nobody can name any more is a task
    // whose obligation graph nobody can honestly continue.
    try {
      port.clear(root, oldest);
    } catch {
      /* fail-open: an un-evictable record is a leak, never a failed read */
    }
    emit("sf_state_evicted", { lane, evicted: oldest, live: records.size }, root);
  }
}

function forgetRecord(workspaceRoot: string, lane: string, key: string): void {
  const group = groupKeyOf(workspaceRoot, lane);
  const records = liveRecords.get(group);
  if (records === undefined) return;
  records.delete(key);
  if (records.size === 0) {
    liveRecords.delete(group);
    const lanes = liveLanes.get(workspaceRoot);
    lanes?.delete(lane);
    if (lanes !== undefined && lanes.size === 0) liveLanes.delete(workspaceRoot);
  }
}

/** Test hook: drop the in-memory LRU. Never touches persisted records. */
export function resetSfStateForTests(): void {
  liveRecords.clear();
  liveLanes.clear();
}

/** Test hook: the live lanes for one workspace, least-recently-touched first. */
export function sfLiveLanesForTest(workspaceRoot: string): string[] {
  return [...(liveLanes.get(workspaceRoot) ?? [])];
}

/** Test hook: the live record keys for one (workspaceRef, lane), oldest first. */
export function sfLiveRecordKeysForTest(workspaceRoot: string, lane = ""): string[] {
  return [...(liveRecords.get(groupKeyOf(workspaceRoot, lane))?.keys() ?? [])];
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * The SF task ref. Identical to `deriveIrTaskRef`'s chain — task fingerprint ->
 * qref -> sha256(query) -> `"task"` — reused rather than re-derived, so the two
 * seams can never key the same task differently (§3.2.2).
 */
export function deriveSfTaskRef(ctx: SfTaskContext): string {
  return deriveIrTaskRef({
    ...(ctx.taskId === undefined ? {} : { taskId: ctx.taskId }),
    ...(ctx.qref === undefined ? {} : { qref: ctx.qref }),
    ...(ctx.query === undefined ? {} : { query: ctx.query }),
  });
}

interface Resolved {
  lane: string;
  taskRef: string;
  key: string;
  port: SfIrStorePort;
}

function resolve(ctx: SfTaskContext): Resolved | undefined {
  if (typeof ctx.workspaceRoot !== "string" || ctx.workspaceRoot === "") return undefined;
  const lane = ctx.lane ?? "";
  const taskRef = deriveSfTaskRef(ctx);
  return {
    lane,
    taskRef,
    key: irStateKey({ workspaceRef: ctx.workspaceRoot, taskRef, lane }),
    port: ctx.store ?? defaultSfStorePort,
  };
}

function emit(event: string, payload: object, workspaceRoot: string): void {
  try {
    trace(event, payload, workspaceRoot);
  } catch {
    /* the trace channel is best-effort; an SF defect never reaches the caller */
  }
}

// ---------------------------------------------------------------------------
// The one load/commit path every mutation shares
// ---------------------------------------------------------------------------

type Loaded =
  | { ok: true; state: TaskReasoningIRv2; expectedVersion: number; fresh: boolean }
  | { ok: false; inertReason: SfInertReason };

function loadFor(ctx: SfTaskContext, at: Resolved, createIfAbsent: boolean): Loaded {
  const loaded = at.port.load(ctx.workspaceRoot, at.key);
  if (loaded.ok) {
    return { ok: true, state: loaded.state, expectedVersion: loaded.recordVersion, fresh: false };
  }
  if (loaded.reason === "corrupt") {
    // Fail-closed to fresh, and SAY SO — the same recovery `irDispatchSeam.ts`
    // performs. SF itself degrades to observation-only for THIS call.
    emit("sf_state_recovery", { reason: loaded.reason, detail: loaded.detail ?? "" }, ctx.workspaceRoot);
    return { ok: false, inertReason: "corrupt" };
  }
  if (loaded.reason === "store-unavailable") return { ok: false, inertReason: "store-unavailable" };
  if (!createIfAbsent) return { ok: false, inertReason: "absent" };
  return {
    ok: true,
    state: emptyIrV2State(at.taskRef, at.lane),
    expectedVersion: at.port.version(ctx.workspaceRoot, at.key),
    fresh: true,
  };
}

function writeReasonToInert(reason: "store-unavailable" | "state-conflict" | "too-large"): SfInertReason {
  if (reason === "state-conflict") return "cas-conflict";
  if (reason === "too-large") return "record-too-large";
  return "store-unavailable";
}

/**
 * Apply `ops` and persist. Never throws, never retries a CAS conflict.
 *
 * - `ops` empty: the state is returned unchanged (a no-op is not a failure).
 * - the IR gate refuses: ACTIVE snapshot of the UNCHANGED state plus
 *   `lastRefusal`. The caller keeps a usable view; the requested transition
 *   simply did not earn itself.
 * - the store refuses: INERT snapshot (I-1).
 */
function commit(
  ctx: SfTaskContext,
  at: Resolved,
  loaded: Extract<Loaded, { ok: true }>,
  ops: readonly ReasoningDeltaOp[],
  epochFresh: boolean,
): SfSnapshot {
  if (ops.length === 0 && !loaded.fresh) {
    touchRecord(ctx, at.lane, at.key, at.port);
    return snapshotOf(loaded.state, ctx, at.key, { epochFresh });
  }

  let next = loaded.state;
  let delta: ReasoningDelta | undefined;
  if (ops.length > 0) {
    const built = buildReasoningDelta(loaded.state, ops);
    if (!built.ok) {
      emit("sf_state_refused", { reason: built.reason, detail: built.detail, lane: at.lane }, ctx.workspaceRoot);
      touchRecord(ctx, at.lane, at.key, at.port);
      return snapshotOf(loaded.state, ctx, at.key, { epochFresh, lastRefusal: built.reason });
    }
    next = built.state;
    delta = built.delta;
  }

  const write =
    loaded.fresh || delta === undefined
      ? at.port.checkpoint(ctx.workspaceRoot, at.key, next, loaded.expectedVersion)
      : at.port.delta(ctx.workspaceRoot, at.key, delta, next, loaded.expectedVersion);
  if (!write.ok) {
    const reason = writeReasonToInert(write.reason);
    emit("sf_state_inert", { reason, detail: write.detail ?? "", lane: at.lane }, ctx.workspaceRoot);
    return inert(reason, at.taskRef, at.lane, at.key, ctx.forceServe === true);
  }

  touchRecord(ctx, at.lane, at.key, at.port);
  return snapshotOf(next, ctx, at.key, { epochFresh });
}

/** The uniform fail-open wrapper. NOTHING in this module escapes it. */
function guarded(ctx: SfTaskContext, run: () => SfSnapshot): SfSnapshot {
  if (!sfStatefulEnabled()) return inert("flag-off");
  try {
    return run();
  } catch (err) {
    emit(
      "sf_state_error",
      { message: err instanceof Error ? err.message : String(err) },
      typeof ctx?.workspaceRoot === "string" ? ctx.workspaceRoot : "",
    );
    return inert("internal-error");
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Open (or re-open) the SF record for this task and seed `concerns`.
 *
 * `ctx.epochNew` CLEARS the record first and re-opens it empty at the same key
 * (§3.2.3). Clearing rather than relying on a changed `taskRef` keeps epoch
 * isolation true even when the caller re-packs the identical query with no
 * handle, which would otherwise derive the same key. The served ledger is NOT
 * touched — that is DC3's whole point.
 *
 * Concerns already present (by id) are left exactly as they are: re-opening a
 * task must never reset progress. At most `SF_CONCERN_MAX` concerns live in one
 * record; the surplus is dropped rather than crowding out check-derived
 * obligations.
 */
export function openSfTask(ctx: SfTaskContext, concerns: readonly SfConcernInput[] = []): SfSnapshot {
  return guarded(ctx, () => {
    const at = resolve(ctx);
    if (at === undefined) return inert("no-workspace");

    let epochFresh = false;
    if (ctx.epochNew === true) {
      at.port.clear(ctx.workspaceRoot, at.key);
      forgetRecord(ctx.workspaceRoot, at.lane, at.key);
      epochFresh = true;
    }

    const loaded = loadFor(ctx, at, true);
    if (!loaded.ok) return inert(loaded.inertReason, at.taskRef, at.lane, at.key, ctx.forceServe === true);

    const present = new Set(loaded.state.obligations.map((o) => o.id));
    let budget = SF_CONCERN_MAX - loaded.state.obligations.length;
    const ops: ReasoningDeltaOp[] = [];
    for (const concern of concerns) {
      if (budget <= 0) break;
      if (concern.id === "" || present.has(concern.id)) continue;
      present.add(concern.id);
      budget -= 1;
      ops.push({ op: "add", target: "obligation", obligation: obligationFrom(concern) });
    }
    return commit(ctx, at, loaded, ops, epochFresh);
  });
}

/**
 * Catalog the surfaces this response actually SERVED, and point the concerns
 * they contribute to at them.
 *
 * `ctx.forceServe` changes NOTHING here: a force-served body is still bytes on
 * the wire, so it is still recorded. What `force_serve` bypasses is dedup and
 * demotion, which live downstream and read `snapshot.forceServe`.
 *
 * A surface with no `sha` is cataloged as STRUCTURAL, never `direct`: with no
 * content hash there is nothing binding the claim to bytes, and structural
 * evidence cannot close a body obligation (`obligationDag.canClose`'s rule).
 */
export function recordServed(ctx: SfTaskContext, evidenceRefs: readonly SfServedEvidence[]): SfSnapshot {
  return guarded(ctx, () => {
    const at = resolve(ctx);
    if (at === undefined) return inert("no-workspace");
    const loaded = loadFor(ctx, at, true);
    if (!loaded.ok) return inert(loaded.inertReason, at.taskRef, at.lane, at.key, ctx.forceServe === true);

    const cataloged = new Set(loaded.state.evidenceCatalog.map((e) => e.evidenceId));
    const useKeys = new Set(loaded.state.evidenceUses.map(useSignature));
    const refsByConcern = new Map<string, string[]>();
    const ops: ReasoningDeltaOp[] = [];
    let evidenceBudget = IRV2_EVIDENCE_MAX - loaded.state.evidenceCatalog.length;
    let useBudget = IRV2_USES_MAX - loaded.state.evidenceUses.length;

    for (const ref of evidenceRefs) {
      if (ref === undefined || ref === null) continue;
      if (typeof ref.path !== "string" || ref.path === "") continue;
      const evidenceId = ref.evidenceId ?? deriveEvidenceId(ref);
      if (!cataloged.has(evidenceId)) {
        if (evidenceBudget <= 0) continue;
        evidenceBudget -= 1;
        cataloged.add(evidenceId);
        ops.push({ op: "add", target: "evidence", evidence: identityFrom(evidenceId, ref) });
      }
      const use: EvidenceUse = {
        taskRef: at.taskRef,
        evidenceId,
        roles: [...(ref.roles ?? [])],
        obligationIds: [...(ref.concernIds ?? [])],
        required: ref.required === true,
      };
      const signature = useSignature(use);
      if (useBudget > 0 && !useKeys.has(signature)) {
        useBudget -= 1;
        useKeys.add(signature);
        ops.push({ op: "add", target: "use", use });
      }
      for (const concernId of ref.concernIds ?? []) {
        const list = refsByConcern.get(concernId) ?? [];
        list.push(evidenceId);
        refsByConcern.set(concernId, list);
      }
    }

    // Point each named concern at the evidence that just landed. This is an
    // `update` of `evidenceRefs` ONLY — the node's STATE is never patched here,
    // so closure stays `canClose`'s decision alone.
    for (const [concernId, ids] of refsByConcern) {
      const node = loaded.state.obligations.find((o) => o.id === concernId);
      if (node === undefined) continue;
      const merged = [...new Set([...node.evidenceRefs, ...ids])];
      if (merged.length === node.evidenceRefs.length) continue;
      ops.push({ op: "update", target: "obligation", id: concernId, patch: { evidenceRefs: merged } });
    }

    return commit(ctx, at, loaded, ops, false);
  });
}

/** Record the decision state SF observed (`pending` through `done`). */
export function recordDecision(ctx: SfTaskContext, decision: SfDecisionInput): SfSnapshot {
  return guarded(ctx, () => {
    const at = resolve(ctx);
    if (at === undefined) return inert("no-workspace");
    const loaded = loadFor(ctx, at, true);
    if (!loaded.ok) return inert(loaded.inertReason, at.taskRef, at.lane, at.key, ctx.forceServe === true);

    const next = { state: decision.state, evidenceRefs: [...(decision.evidenceRefs ?? [])] };
    const unchanged =
      loaded.state.decision.state === next.state &&
      loaded.state.decision.evidenceRefs.length === next.evidenceRefs.length &&
      loaded.state.decision.evidenceRefs.every((ref, i) => ref === next.evidenceRefs[i]);
    const ops: ReasoningDeltaOp[] = unchanged
      ? []
      : [{ op: "update", target: "decision", decision: next }];
    return commit(ctx, at, loaded, ops, false);
  });
}

/**
 * Ask the ONE closure gate to discharge `concernId`.
 *
 * `proof.evidenceIds` are merged into the concern's refs first, then a `close`
 * op runs — and `reasoningDelta`'s `close` routes through
 * `obligationDag.canClose`, so an unearned closure is REFUSED here exactly as
 * it is everywhere else in IR v2. A refusal returns the unchanged state with
 * `lastRefusal` set; it never throws and never leaves a concern half-closed.
 *
 * An already-satisfied concern is a NO-OP, never a re-open: monotonicity (P-1)
 * is a property of this adapter, not just of the ops it emits.
 */
export function markConcernSatisfied(
  ctx: SfTaskContext,
  concernId: string,
  proof: SfSatisfactionProof = {},
): SfSnapshot {
  return guarded(ctx, () => {
    const at = resolve(ctx);
    if (at === undefined) return inert("no-workspace");
    const loaded = loadFor(ctx, at, false);
    if (!loaded.ok) return inert(loaded.inertReason, at.taskRef, at.lane, at.key, ctx.forceServe === true);

    const node = loaded.state.obligations.find((o) => o.id === concernId);
    if (node === undefined) {
      touchRecord(ctx, at.lane, at.key, at.port);
      return snapshotOf(loaded.state, ctx, at.key, { lastRefusal: "unknown-obligation" });
    }
    if (node.state === "satisfied") {
      touchRecord(ctx, at.lane, at.key, at.port);
      return snapshotOf(loaded.state, ctx, at.key);
    }

    const ops: ReasoningDeltaOp[] = [];
    const merged = [...new Set([...node.evidenceRefs, ...(proof.evidenceIds ?? [])])];
    // SF-F2: the grounding-class gate, applied to the refs this closure would
    // actually stand on. A `direct` claim (a body: definition, template,
    // generated product, verification, explanation) may not be closed by a
    // `structural` catalog entry — an address that exists but whose bytes
    // never went on the wire. Refused exactly like the IR gate's own refusal:
    // unchanged state, `lastRefusal`, no half-closed node.
    if (
      proof.grounding === "direct"
      && groundedEvidenceIds(merged, loaded.state.evidenceCatalog, "direct").size === 0
    ) {
      touchRecord(ctx, at.lane, at.key, at.port);
      emit(
        "sf_state_refused",
        { reason: "invalid-closure", detail: `${concernId}: no direct evidence grounds a body claim`, lane: at.lane },
        ctx.workspaceRoot,
      );
      return snapshotOf(loaded.state, ctx, at.key, { lastRefusal: "invalid-closure" });
    }
    if (merged.length !== node.evidenceRefs.length) {
      ops.push({ op: "update", target: "obligation", id: concernId, patch: { evidenceRefs: merged } });
    }
    ops.push({ op: "close", target: "obligation", id: concernId });

    const result = commit(ctx, at, loaded, ops, false);
    if (result.active && result.lastRefusal === undefined) {
      emit(
        "sf_concern_satisfied",
        { concern: concernId, lane: at.lane, note: proof.note ?? "", state_version: result.stateVersion },
        ctx.workspaceRoot,
      );
    }
    return result;
  });
}

/** Read the current record without changing it. Absent state is INERT, not empty. */
export function snapshot(ctx: SfTaskContext): SfSnapshot {
  return guarded(ctx, () => {
    const at = resolve(ctx);
    if (at === undefined) return inert("no-workspace");
    const loaded = loadFor(ctx, at, false);
    if (!loaded.ok) return inert(loaded.inertReason, at.taskRef, at.lane, at.key, ctx.forceServe === true);
    touchRecord(ctx, at.lane, at.key, at.port);
    return snapshotOf(loaded.state, ctx, at.key);
  });
}

/**
 * Finish with this task: mark the decision `done` and drop the LRU entry.
 *
 * The RECORD is deliberately KEPT. Restart semantics are IR v2's (§3.2.3): a
 * caller that resends `task.handle` inside the 24h TTL must find the same
 * concern graph, and a just-closed task is the likeliest thing to be resumed.
 * `task.epoch:"new"` is the only caller-visible eraser.
 */
export function closeSfTask(ctx: SfTaskContext): SfSnapshot {
  const result = recordDecision(ctx, { state: "done" });
  if (!sfStatefulEnabled()) return result;
  try {
    const at = resolve(ctx);
    if (at !== undefined) forgetRecord(ctx.workspaceRoot, at.lane, at.key);
  } catch {
    /* fail-open */
  }
  return result;
}

/**
 * Byte residency for one address (DC3). Answered ONLY by the injected served
 * ledger — never by the IR record, which knows about obligation closure and
 * nothing about what the caller still holds. No reader wired means
 * `known:false`, which downstream must read as UNKNOWN (and therefore "do not
 * suppress"), never as "not served".
 */
export function sfByteResidency(
  ctx: SfTaskContext,
  address: { path: string; sha?: string; totalLines?: number },
): SfResidency {
  const ledger = ctx.ledger;
  if (ledger === undefined) return { known: false, reason: "no-ledger" };
  try {
    const sha = address.sha ?? "";
    const coverage =
      sha === "" || address.totalLines === undefined
        ? undefined
        : ledger.servedRangeCoverage(address.path, sha, address.totalLines);
    return {
      known: true,
      servedPath: ledger.hasServedPath(address.path),
      fullyServed: sha === "" ? false : ledger.wasFullyServed(address.path, sha),
      complete: coverage?.complete === true,
      unserved: coverage?.unserved ?? [],
    };
  } catch {
    // A ledger defect must never become a suppression decision.
    return { known: false, reason: "no-ledger" };
  }
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function obligationFrom(concern: SfConcernInput): ObligationNode {
  const origin = concern.origin ?? "source-requirement";
  return {
    id: concern.id,
    claim: concern.claim,
    state: "open",
    evidenceRefs: [],
    origin,
    // Derived, never supplied: a heuristic concern cannot launder itself.
    advisory: origin === "heuristic",
    blockedBy: [...(concern.blockedBy ?? [])],
    predicate: concern.predicate ?? { kind: "any-grounded-evidence" },
    // SF-F8/F9: the field the decoder, the DAG normalizer and the state hash
    // have all carried since W-DISPOSITION-PERSIST, and that nothing was
    // writing. Absent stays absent — "unstated" is a real value.
    ...(concern.nodeDisposition === undefined ? {} : { disposition: concern.nodeDisposition }),
  };
}

function identityFrom(evidenceId: string, ref: SfServedEvidence): EvidenceIdentity {
  const sha = ref.sha ?? "";
  const locator: NonNullable<EvidenceIdentity["locator"]> = {
    ...(ref.lineRange === undefined ? {} : { lineRange: ref.lineRange }),
    ...(ref.symbol === undefined ? {} : { symbol: { id: ref.symbol, name: ref.symbol, kind: "unknown" } }),
    ...(ref.sectionId === undefined ? {} : { sectionId: ref.sectionId }),
  };
  return {
    evidenceId,
    source: { kind: ref.sourceKind ?? "file", uri: ref.path, contentHash: sha },
    ...(Object.keys(locator).length === 0 ? {} : { locator }),
    // No hash means nothing binds the claim to bytes: structural, not direct.
    evidenceClass: ref.evidenceClass ?? (sha === "" ? "structural" : "direct"),
    validityKeys: sha === "" ? [] : [{ type: "file-sha", value: `${ref.path}@${sha}` }],
  };
}

/**
 * The CATALOG's evidence-id scheme, and the only one (SF-F10).
 *
 * Exported because the task_pack seam must stamp `evidenceId` on the records
 * it hands to BOTH `recordServed` (which catalogs them) and the satisfaction
 * updater (whose proofs name them). Before this, the updater fell back to its
 * own `path:start-end` spelling for a record with no `evidenceId`, and those
 * ids resolved against nothing in the catalog — so every proof it produced was
 * a set of DANGLING refs, `groundedEvidenceIds` dropped them all, and the
 * closure the seam nominated was refused for want of evidence it had served.
 */
export function sfEvidenceIdFor(ref: SfServedEvidence): string {
  return deriveEvidenceId(ref);
}

function deriveEvidenceId(ref: SfServedEvidence): string {
  const range = ref.lineRange === undefined ? "" : `${ref.lineRange.startLine}-${ref.lineRange.endLine}`;
  const material = [ref.path, range, ref.symbol ?? "", ref.sectionId ?? "", ref.sha ?? ""].join(" ");
  return `sf-${createHash("sha256").update(material, "utf8").digest("hex").slice(0, 16)}`;
}

function useSignature(use: EvidenceUse): string {
  return [
    use.evidenceId,
    [...use.roles].sort().join(","),
    [...use.obligationIds].sort().join(","),
    String(use.required),
  ].join(" ");
}
