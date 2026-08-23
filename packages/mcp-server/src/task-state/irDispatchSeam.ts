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
