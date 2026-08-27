// ---------------------------------------------------------------------------
// irDispatchSeam.ts — the ONE advisory dispatch seam for Task Reasoning IR v2.
//
// Reconciliation §3 row V11-04: "ONE flag-gated advisory build seam in dispatch
// (trace emission only, no wire field)."
//
// THE WHOLE CONTRACT OF THIS MODULE, IN THREE SENTENCES:
//   1. It NEVER touches the response. It receives the `TaskPackResult` by
//      reference and reads it; it returns `void`; no caller may thread its
//      output anywhere. There is no wire field, no new kind, no argument.
//   2. It NEVER throws. Every path is inside one try/catch whose only handler
//      is `trace("reasoning_ir_error", …)`. An IR defect degrades to a trace
//      line and nothing else — the pack the agent receives is byte-identical.
//   3. It NEVER runs with the flag off. `reasoningIrV2Enabled()` is checked
//      here AND at the server.ts call site, so flag-off is unreachable twice
//      over and the default path pays a single boolean read.
//
// It also never blocks on a lock it holds, never retries a CAS conflict, and
// never fails a task because state could not be written: advisory projection
// state that cannot be persisted is simply not persisted.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import type { ReasoningDeltaOp, TaskReasoningIRv2 } from "@tokenlighten/types";
import type { TaskPackResult } from "../features/task-pack/model.js";
import { reasoningIrV2Enabled } from "../util/flags.js";
import { trace } from "../util/trace.js";
import { buildReasoningDelta, computeTaskStateHash } from "./reasoningDelta.js";
import {
  checkpointIrState,
  irRecordVersion,
  irStateKey,
  loadIrState,
  recordIrDelta,
} from "./irStore.js";
import {
  deriveEditClosureOps,
  deriveProjectionOps,
  projectTaskReasoningIrV2,
  staleTombstoneOps,
} from "./reasoningIrV2.js";
import { emitShadowStopCandidate, evaluateShadowStop } from "./shadowStop.js";

export interface ReasoningIrSeamInput {
  result: TaskPackResult;
  workspaceRoot: string;
  /** The task query text, when dispatch still holds it. */
  query?: string;
  /** Stable task identity; falls back to the pack's qref, then to the query. */
  taskId?: string;
  /** The caller's session lane; "" is the shared default lane. */
  lane: string;
}

/**
 * The stable task identity IR state is keyed by.
 *
 * NOTE ON ORDER: at the seam the pack's `qref` is usually still UNSET —
 * dispatch attaches the replay ref to the outgoing body AFTER this point (see
 * `server.ts`'s `issuedRef`). Falling back to a constant would file every task
 * in a workspace+lane under ONE record, silently merging unrelated reasoning
 * state, so the query text is hashed instead: same task re-packed twice = same
 * ref, which is exactly the accumulation key v2 needs. Exported so a spec keys
 * by the same derivation rather than re-deriving it.
 */
export function deriveIrTaskRef(input: { taskId?: string; qref?: string; query?: string }): string {
  if (input.taskId !== undefined && input.taskId !== "") return input.taskId;
  if (input.qref !== undefined && input.qref !== "") return input.qref;
  if (input.query !== undefined && input.query !== "") {
    return `q:${createHash("sha256").update(input.query, "utf8").digest("hex").slice(0, 16)}`;
  }
  return "task";
}

/**
 * Build (or advance) IR v2 state for a completed task pack and emit the
 * trace-only shadow Stop candidate. Total: it swallows every failure.
 */
export function recordReasoningIrV2FromPack(input: ReasoningIrSeamInput): void {
  if (!reasoningIrV2Enabled()) return;
  const { result, workspaceRoot, lane } = input;
  try {
    const taskRef = deriveIrTaskRef({
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      ...(result.qref === undefined ? {} : { qref: result.qref }),
      ...(input.query === undefined ? {} : { query: input.query }),
    });
    const key = irStateKey({ workspaceRef: workspaceRoot, taskRef, lane });

    const loaded = loadIrState(workspaceRoot, key);
    if (!loaded.ok && loaded.reason === "corrupt") {
      // Fail-closed to fresh, and SAY SO — a silent reset would hide the one
      // event that explains a suddenly-empty reasoning state.
      trace("reasoning_ir_recovery", { reason: loaded.reason, detail: loaded.detail ?? "" }, workspaceRoot);
    }
    const prior = loaded.ok ? loaded.state : undefined;
    const expectedVersion = loaded.ok ? loaded.recordVersion : irRecordVersion(workspaceRoot, key);

    const projected = projectTaskReasoningIrV2({
      result,
      taskId: taskRef,
      lane,
      ...(input.query === undefined ? {} : { query: input.query }),
      ...(prior === undefined ? {} : { prior }),
    });

    const advanced = prior === undefined
      ? checkpoint(workspaceRoot, key, projected, expectedVersion, "initial")
      : advance(workspaceRoot, key, prior, projected, expectedVersion);

    const evaluation = evaluateShadowStop({
      state: advanced,
      coverage: result.coverage,
      openGaps: blockingGapsOf(result),
    });
    emitShadowStopCandidate(evaluation, workspaceRoot);

    trace(
      "reasoning_ir_v2",
      {
        task_ref_ir: advanced.taskRef,
        lane,
        state_version: advanced.stateVersion,
        state_hash: advanced.stateHash,
        evidence: advanced.evidenceCatalog.length,
        obligations: advanced.obligations.length,
        tombstones: advanced.tombstones.length,
        dag: advanced.dagEnabled,
        shadow_stop_candidate: evaluation.candidate !== undefined,
        blockers: evaluation.blockers.length,
      },
      workspaceRoot,
    );
  } catch (err) {
    try {
      trace("reasoning_ir_error", { message: err instanceof Error ? err.message : String(err) }, workspaceRoot);
    } catch {
      /* the trace channel is best-effort; an IR defect never reaches the caller */
    }
  }
}

export interface ReasoningIrEditClosureInput {
  workspaceRoot: string;
  /** The caller's session lane; "" is the shared default lane. */
  lane: string;
  /**
   * The taskRef this edit correlates to — the SAME identity `deriveIrTaskRef`
   * produced for the task_pack call that opened the certificate this edit
   * discharges. That call's own seam site (server.ts, the task_pack branch)
   * never passes an explicit `taskId`, and `buildTaskPack`'s own result never
   * sets `.qref` itself (only server.ts's post-seam `supplied.qref`
   * reassignment does, AFTER the seam already ran), so `deriveIrTaskRef` fell
   * through to hashing the query alone. server.ts's edit call site
   * recomputes it the SAME way — `deriveIrTaskRef({ query: fence.epochQuery })`
   * — never `taskQueryRef` (that produces a DIFFERENT, workspace-bound
   * identity used only for the wire `qref` field, which is unrelated to this
   * store's key). Absent or "" means "no provable correlation": the caller
   * must not guess one.
   */
  taskId?: string;
  /** Workspace-relative paths the edit ACTUALLY wrote (`editedPathsOf`'s own accounting — never a claim). */
  editedPaths: readonly string[];
}

/**
 * A1-pre — the edit-side half of the V11-04 obligation-closure gap
 * (DESIGN-v0.12-plan.md §2 row A1-pre; see `deriveEditClosureOps`'s own doc
 * comment for the closure rule itself). Same three-sentence contract as
 * `recordReasoningIrV2FromPack` above: never touches the response, never
 * throws past this function, never runs with the flag off (checked here AND
 * at the server.ts call site).
 *
 * Deliberately does NOT run `evaluateShadowStop` here: that needs a coverage
 * claim, and an edit call has none to offer honestly. The closure this
 * persists is picked up by the NEXT task_pack call for this (task, lane) —
 * `mergeWithPrior`/`deriveProjectionOps` already carry a prior "satisfied"
 * obligation forward unchanged (they only ever ADD), so that call's own
 * (pre-existing, unchanged) `evaluateShadowStop` invocation sees the closed
 * obligation against ITS fresh coverage.
 */
export function recordReasoningIrV2ClosureFromEdit(input: ReasoningIrEditClosureInput): void {
  if (!reasoningIrV2Enabled()) return;
  const { workspaceRoot, lane, taskId, editedPaths } = input;
  if (taskId === undefined || taskId === "" || editedPaths.length === 0) return;
  try {
    const key = irStateKey({ workspaceRef: workspaceRoot, taskRef: taskId, lane });
    const loaded = loadIrState(workspaceRoot, key);
    if (!loaded.ok) {
      // "absent": no task_pack ever ran for this (task, lane) — nothing to
      // close. "corrupt": fail closed exactly like the pack seam does, and
      // say so; there is no snapshot here to recover FROM.
      if (loaded.reason === "corrupt") {
        trace("reasoning_ir_recovery", { reason: loaded.reason, detail: loaded.detail ?? "", seam: "edit" }, workspaceRoot);
      }
      return;
    }

    const ops = deriveEditClosureOps(loaded.state, editedPaths);
    if (ops.length === 0) return;

    const built = buildReasoningDelta(loaded.state, ops);
    if (!built.ok) {
      // Unreachable in practice — `deriveEditClosureOps` only emits a `close`
      // op for an id its OWN canClose check already accepted against this
      // exact state, and `buildReasoningDelta`'s only failure mode is that
      // same check. Traced, not thrown: an IR defect degrades to a trace
      // line everywhere else in this module too.
      trace("reasoning_ir_delta_refused", { reason: built.reason, detail: built.detail, seam: "edit" }, workspaceRoot);
      return;
    }

    const write = recordIrDelta(workspaceRoot, key, built.delta, built.state, loaded.recordVersion);
    if (!write.ok) {
      trace("reasoning_ir_write_skipped", { reason: write.reason, detail: write.detail ?? "", seam: "edit" }, workspaceRoot);
      return;
    }

    trace(
      "reasoning_ir_v2_edit_closure",
      {
        task_ref_ir: built.state.taskRef,
        lane,
        state_version: built.state.stateVersion,
        state_hash: built.state.stateHash,
        closed: ops.length,
        edited_paths: editedPaths.length,
      },
      workspaceRoot,
    );
  } catch (err) {
    try {
      trace("reasoning_ir_error", { message: err instanceof Error ? err.message : String(err), seam: "edit" }, workspaceRoot);
    } catch {
      /* the trace channel is best-effort; an IR defect never reaches the caller */
    }
  }
}

/** Carry `prior` forward by delta, falling back to a full snapshot on refusal. */
function advance(
  workspaceRoot: string,
  key: string,
  prior: TaskReasoningIRv2,
  projected: TaskReasoningIRv2,
  expectedVersion: number,
): TaskReasoningIRv2 {
  const ops: ReasoningDeltaOp[] = [
    ...staleTombstoneOps(prior, projected.invalidationKeys),
    ...deriveProjectionOps(prior, projected),
  ];
  if (ops.length === 0) return prior;

  const built = buildReasoningDelta(prior, ops);
  if (!built.ok) {
    trace("reasoning_ir_delta_refused", { reason: built.reason, detail: built.detail }, workspaceRoot);
    // The sanctioned recovery, everywhere in V11-04: a full snapshot.
    return checkpoint(workspaceRoot, key, bumped(projected, prior.stateVersion + 1), expectedVersion, "delta-refused");
  }

  const write = recordIrDelta(workspaceRoot, key, built.delta, built.state, expectedVersion);
  if (!write.ok) {
    trace("reasoning_ir_write_skipped", { reason: write.reason, detail: write.detail ?? "" }, workspaceRoot);
  }
  return built.state;
}

function checkpoint(
  workspaceRoot: string,
  key: string,
  state: TaskReasoningIRv2,
  expectedVersion: number,
  cause: string,
): TaskReasoningIRv2 {
  const write = checkpointIrState(workspaceRoot, key, state, expectedVersion);
  if (!write.ok) {
    trace("reasoning_ir_write_skipped", { reason: write.reason, cause, detail: write.detail ?? "" }, workspaceRoot);
  }
  return state;
}

/** Re-stamp a state at `version`, recomputing its hash so the pair stays honest. */
function bumped(state: TaskReasoningIRv2, version: number): TaskReasoningIRv2 {
  const next: TaskReasoningIRv2 = { ...state, stateVersion: version, stateHash: "" };
  return { ...next, stateHash: computeTaskStateHash(next) };
}

/**
 * The pack's own still-blocking work. Shadow Stop requires this empty, so it
 * reads exactly the fields the pack already publishes as blocking — never a
 * heuristic re-derivation.
 */
function blockingGapsOf(result: TaskPackResult): string[] {
  return [
    ...(result.missing_required_surfaces ?? []),
    ...(result.blocking_next_steps ?? []),
    ...(result.checks_open ?? []),
  ];
}
