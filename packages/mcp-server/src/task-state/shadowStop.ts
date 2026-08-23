// ---------------------------------------------------------------------------
// shadowStop.ts — SHADOW Stop Certificate candidates (V11-04, deviation E-5).
//
// DESIGN-v0.10-expansion-plan-v1.3.md §7 V11-04: "Stop Certificate候補をshadow
// 生成し、実際のagent trajectoryと比較する" / "Stop候補はv0.11で行動制約に使わない".
// DESIGN-v0.11-expansion-plan-reconciliation.md §4 E-5 narrows the comparison
// to a FIXTURE-BASED offline harness; live-trajectory comparison is bench spend
// the user schedules.
//
// THE POSTURE, IN FULL. A candidate produced here:
//   * is NEVER wire-visible — no kind, no field, no tool argument. Its only
//     emission is `trace("shadow_stop_candidate", …)`, i.e. the `TL_TRACE`
//     JSONL channel;
//   * NEVER constrains behaviour — nothing in dispatch reads it, no refusal
//     rides it, no `allowedNext` shrinks because of it;
//   * is DATA FOR v0.12, collected so a future Stop/Replan decision can be
//     argued from a measured false-candidate rate instead of a hope.
//
// FALSE CANDIDATE IS THE METRIC. A candidate at a state the task actually
// continued past is a false candidate; the acceptance bar is 0 on the fixtures.
// `compareShadowStopStream` is the pure offline scorer.
//
// PURE except for `emitShadowStopCandidate`, whose only effect is a trace line.
// ---------------------------------------------------------------------------

import type {
  HypothesisTombstone,
  StopCertificateCandidate,
  TaskReasoningIRv2,
  ValidityKey,
} from "@tokenlighten/types";
import { allNonAdvisoryClosed, canClose, openNonAdvisoryObligations } from "./obligationDag.js";
import { liveStrongTombstones } from "./tombstone.js";
import { trace } from "../util/trace.js";

export type ShadowStopBlockerKind =
  | "open-obligation"
  | "unclosable-obligation"
  | "coverage-incomplete"
  | "open-blocking-gap"
  | "strong-tombstone-contradiction";

export interface ShadowStopBlocker {
  kind: ShadowStopBlockerKind;
  /** Obligation id, tombstone id, gap code, or the coverage word. */
  id: string;
  detail: string;
}

export interface ShadowStopInput {
  state: TaskReasoningIRv2;
  /** The pack's own coverage claim. Only `"complete"` admits a candidate. */
  coverage: "complete" | "focused" | "partial";
  /** Blocking gaps the execution contract still reports open. */
  openGaps?: readonly string[];
  /** Live invalidation keys for the tombstone sweep; defaults to the state's own. */
  liveValidityKeys?: readonly ValidityKey[];
}

export interface ShadowStopEvaluation {
  /** Present iff EVERY condition held. */
  candidate?: StopCertificateCandidate;
  blockers: ShadowStopBlocker[];
}

/**
 * Four independent conditions, all required:
 *   1. every NON-ADVISORY obligation is closed, and closed legitimately (each
 *      one still passes `canClose` against the live state — a satisfied node
 *      whose grounding has since gone is not a closure);
 *   2. coverage is complete;
 *   3. zero open blocking gaps;
 *   4. zero live STRONG tombstones contradicting a closure.
 * Advisory (heuristic-origin) obligations may stay open — that is what advisory
 * means — and are reported on the candidate rather than suppressed.
 */
export function evaluateShadowStop(input: ShadowStopInput): ShadowStopEvaluation {
  const { state } = input;
  const blockers: ShadowStopBlocker[] = [];

  for (const node of openNonAdvisoryObligations(state)) {
    blockers.push({
      kind: "open-obligation",
      id: node.id,
      detail: `${node.id} is ${node.state}`,
    });
  }

  // A node marked satisfied must STILL earn it. This catches state that was
  // hand-edited, replayed from a stale checkpoint, or left behind by an
  // evidence invalidation that a caller failed to propagate.
  if (allNonAdvisoryClosed(state)) {
    for (const node of state.obligations) {
      if (node.advisory || node.state !== "satisfied") continue;
      const verdict = canClose(node.id, state);
      if (!verdict.ok) {
        blockers.push({
          kind: "unclosable-obligation",
          id: node.id,
          detail: `${node.id} is marked satisfied but ${verdict.reason}: ${verdict.detail}`,
        });
      }
    }
  }

  if (input.coverage !== "complete") {
    blockers.push({ kind: "coverage-incomplete", id: input.coverage, detail: `coverage is ${input.coverage}` });
  }

  for (const gap of input.openGaps ?? []) {
    blockers.push({ kind: "open-blocking-gap", id: gap, detail: `blocking gap open: ${gap}` });
  }

  const liveKeys = input.liveValidityKeys ?? state.invalidationKeys;
  for (const contradiction of strongTombstoneContradictions(state, liveKeys)) {
    blockers.push(contradiction);
  }

  if (blockers.length > 0) return { blockers };

  return {
    blockers,
    candidate: {
      taskRef: state.taskRef,
      lane: state.lane,
      stateVersion: state.stateVersion,
      stateHash: state.stateHash,
      closedObligations: state.obligations.filter((o) => o.state === "satisfied").map((o) => o.id),
      advisoryOpen: state.obligations.filter((o) => o.advisory && o.state !== "satisfied").map((o) => o.id),
      reason: "all-non-advisory-obligations-closed",
    },
  };
}

/**
 * A live strong tombstone contradicts the state when either
 *   (a) it explicitly names a satisfied obligation in `contradicts`, or
 *   (b) it claims a path scope is exhausted, yet a satisfied non-advisory
 *       obligation closed on evidence FROM that scope.
 * Both are "we proved nothing is here" colliding with "we closed work here",
 * and neither may ride a Stop candidate.
 */
function strongTombstoneContradictions(
  state: TaskReasoningIRv2,
  liveKeys: readonly ValidityKey[],
): ShadowStopBlocker[] {
  const out: ShadowStopBlocker[] = [];
  const satisfied = new Set(state.obligations.filter((o) => o.state === "satisfied").map((o) => o.id));
  const uriOf = new Map(state.evidenceCatalog.map((e) => [e.evidenceId, e.source.uri] as const));

  for (const t of liveStrongTombstones(state.tombstones, liveKeys)) {
    for (const id of t.contradicts ?? []) {
      if (!satisfied.has(id)) continue;
      out.push({
        kind: "strong-tombstone-contradiction",
        id: t.id,
        detail: `strong tombstone ${t.id} contradicts closed obligation ${id}`,
      });
    }
    const overlap = pathScopeOverlap(t, state, uriOf);
    if (overlap !== undefined) {
      out.push({
        kind: "strong-tombstone-contradiction",
        id: t.id,
        detail: `strong tombstone ${t.id} claims ${overlap.path} exhausted, but ${overlap.obligationId} closed on evidence there`,
      });
    }
  }
  return out;
}

function pathScopeOverlap(
  tombstone: HypothesisTombstone,
  state: TaskReasoningIRv2,
  uriOf: ReadonlyMap<string, string>,
): { path: string; obligationId: string } | undefined {
  if (tombstone.scope.kind !== "paths") return undefined;
  const paths = tombstone.scope.paths ?? [];
  if (paths.length === 0) return undefined;
  for (const node of state.obligations) {
    if (node.advisory || node.state !== "satisfied") continue;
    for (const ref of node.evidenceRefs) {
      const uri = uriOf.get(ref);
      if (uri === undefined) continue;
      const hit = paths.find((p) => uri === p || uri.startsWith(p.endsWith("/") ? p : `${p}/`));
      if (hit !== undefined) return { path: hit, obligationId: node.id };
    }
  }
  return undefined;
}

/**
 * The ONLY emission path. Trace-only, by construction — this module exports no
 * way to put a candidate anywhere else, and dispatch imports nothing from here
 * except through `irDispatchSeam.ts`, which also only traces.
 */
export function emitShadowStopCandidate(
  evaluation: ShadowStopEvaluation,
  workspaceRoot: string,
): void {
  if (evaluation.candidate === undefined) return;
  const c = evaluation.candidate;
  trace(
    "shadow_stop_candidate",
    {
      task_ref_ir: c.taskRef,
      lane: c.lane,
      state_version: c.stateVersion,
      state_hash: c.stateHash,
      closed_obligations: c.closedObligations.length,
      advisory_open: c.advisoryOpen.length,
      reason: c.reason,
    },
    workspaceRoot,
  );
}

// ---------------------------------------------------------------------------
// Offline comparison harness (E-5)
// ---------------------------------------------------------------------------

export interface ShadowStopFixtureStep {
  state: TaskReasoningIRv2;
  coverage: "complete" | "focused" | "partial";
  openGaps?: readonly string[];
  liveValidityKeys?: readonly ValidityKey[];
}

/**
 * A recorded task trajectory plus the marker for where it ACTUALLY ended.
 * `actualEndVersion: null` means the recording never reached a stop, so ANY
 * candidate in it is false by definition.
 */
export interface ShadowStopFixture {
  taskRef: string;
  steps: readonly ShadowStopFixtureStep[];
  actualEndVersion: number | null;
}

export interface ShadowStopComparison {
  candidateVersions: number[];
  /** Candidates emitted before the task really ended — the number that must be 0. */
  falseCandidateVersions: number[];
  falseCandidates: number;
  trueCandidates: number;
  /** True when the task ended but no candidate was ever produced (a MISS, not a false positive). */
  missedEnd: boolean;
  /** falseCandidates / candidateVersions.length; 0 when there were no candidates. */
  falseCandidateRate: number;
}

/**
 * Score a candidate stream against a recorded trajectory. PURE: no trace, no
 * store, no clock — so the false-candidate rate is measurable offline and in
 * CI, which is exactly what E-5 substitutes for live trajectory comparison.
 */
export function compareShadowStopStream(fixture: ShadowStopFixture): ShadowStopComparison {
  const candidateVersions: number[] = [];
  for (const step of fixture.steps) {
    const evaluation = evaluateShadowStop({
      state: step.state,
      coverage: step.coverage,
      ...(step.openGaps === undefined ? {} : { openGaps: step.openGaps }),
      ...(step.liveValidityKeys === undefined ? {} : { liveValidityKeys: step.liveValidityKeys }),
    });
    if (evaluation.candidate !== undefined) candidateVersions.push(step.state.stateVersion);
  }

  const end = fixture.actualEndVersion;
  const falseCandidateVersions = end === null
    ? [...candidateVersions]
    : candidateVersions.filter((v) => v < end);
  const trueCandidates = candidateVersions.length - falseCandidateVersions.length;
  return {
    candidateVersions,
    falseCandidateVersions,
    falseCandidates: falseCandidateVersions.length,
    trueCandidates,
    missedEnd: end !== null && trueCandidates === 0,
    falseCandidateRate: candidateVersions.length === 0 ? 0 : falseCandidateVersions.length / candidateVersions.length,
  };
}
