// task-binding — extracted implementation; imports point to the owning modules.
import type { ReadBaselineMeasurement } from "./dispatch-funnel2.js";
import type { TaskPackQueryResolution } from "./read-admission2.js";
import type { VerifiedContextAttestation } from "../state/contextAttestation.js";
import { activeRoot } from "../runtime/config.js";
import { autoBoundTaskProfile } from "../features/task-pack/engine/coverageAndContinuation4.js";
import { canonicalTaskBindingOf } from "./task-binding2.js";
import { creditedReadPathsByLane } from "../runtime/requestState.js";
import { inheritedTaskProfileArgs } from "../runtime/requestState.js";
import { mintContextHandle } from "../state/contextAttestation.js";
import { resolveTaskHandle } from "../state/stateHandles.js";
import { resolveTaskQueryRef } from "../state/session.js";
import { resolveTaskQueryRefBinding } from "../state/session.js";
import { resolveWorkspaceRoot } from "./read-admission2.js";
import { servedTextForRoute } from "./read-admission2.js";
import { sessionLaneOf } from "./task-binding2.js";
import { taskFingerprintFor } from "./task-binding2.js";
import { verifyContextAttestation } from "../state/contextAttestation.js";

export function commitReadBaseline(
  measurement: ReadBaselineMeasurement,
  args: Readonly<Record<string, unknown>>,
): void {
  if (measurement.uncreditedPaths.length === 0) return;
  const lane = sessionLaneOf(args as Record<string, unknown>);
  const credited = creditedReadPathsByLane.get(lane) ?? new Set<string>();
  for (const key of measurement.uncreditedPaths) credited.add(key);
  creditedReadPathsByLane.set(lane, credited);
}

/** Calls whose `taskProfile` was carried over by `inheritDeclaredTaskProfile`, not sent by the caller. */


/**
 * A DECLARED PROFILE BELONGS TO THE TASK, NOT TO THE CALL THAT DECLARED IT
 * (2026-09-19, live GitHub Copilot session). Call 1 declared
 * `task.profile:"answer"`; every re-pack of that task (`{qref, targets,
 * task:{handle}}`) omitted it, so `bindTaskProfile` re-INFERRED the profile,
 * the §14 misfire guardrail turned the inferred "answer" into "generic", and
 * the same read-only task was served as a change pack. Because task identity
 * hashes the profile, that also minted a SECOND task handle for what the
 * caller experiences as one task — two 115-character strings that differ in
 * 12 characters, which the model then spliced into a handle that
 * authenticates as neither (`handle-unknown`, two wasted turns).
 *
 * The guide tells callers to omit `task.profile` when they have nothing to
 * declare and that same-epoch requirements persist, so an omitted profile on
 * a continuation means "unchanged", not "guess again". The identity the
 * presented handle (or this call's own qref) resolves to already records
 * which profile the task was packed under: when it equals the fingerprint of
 * THIS call's resolved query under "answer", AND binding the query afresh
 * would select something else, "answer" is carried onto this call. Anything
 * else — a declared profile, a new epoch, a different query, no binding, a
 * task whose profile re-inference reproduces anyway — is left to
 * `bindTaskProfile` exactly as before.
 *
 * ONE DIRECTION ONLY. "answer" is a restriction the user declared (read-only
 * work); dropping it silently is the harmful case. "generic" is the
 * permissive default, and a question-shaped continuation of a generic task
 * narrowing to "answer" is existing, relied-upon behaviour
 * (requestItemCompletion.spec.ts: a request declared generic still closes as
 * `act.answer`) — an edit that actually arrives re-opens the write frontier.
 */
export function inheritDeclaredTaskProfile(
  args: Record<string, unknown>,
  workspace: string,
  resolveQuery: () => TaskPackQueryResolution,
): void {
  if (args["taskProfile"] !== undefined || args["taskEpoch"] === "new") return;
  if (args["mode"] !== undefined && args["mode"] !== "task_pack" && args["mode"] !== "auto") return;
  const hasQuery = typeof args["query"] === "string" && args["query"].trim() !== "";
  const hasRef = typeof args["qref"] === "string" && args["qref"].trim() !== "";
  if (!hasQuery && !hasRef) {
    // A targets-only continuation may omit qref, but cannot discard the
    // authenticated task\'s read-only identity by inferring from an empty query.
    if (args["query"] !== undefined || args["qref"] !== undefined || typeof args["task_handle"] !== "string") return;
    const task = resolveTaskHandle(args["task_handle"], workspace);
    const ref = task.ok ? task.state.replay : undefined;
    if (ref === undefined) return;
    const original = resolveTaskQueryRef(workspace, ref);
    if (!original || !task.ok || task.state.taskFingerprint !== taskFingerprintFor("answer", original)
      || resolveTaskQueryRefBinding(workspace, ref) !== task.state.taskFingerprint) return;
    args["qref"] = ref;
  }
  const resolution = resolveQuery();
  if (resolution.error !== undefined || resolution.query === "") return;
  const binding = canonicalTaskBindingOf(args, workspace) ?? resolution.taskBinding;
  if (binding === undefined) return;
  if (binding !== taskFingerprintFor("answer", resolution.query)) return;
  // Omission only matters when re-inference would bind something else. When
  // it binds "answer" again the call is left exactly as sent: an injected
  // declaration changes the pack-dedupe fingerprint of a task that never
  // declared anything, and its re-packs would re-send bodies the caller
  // already holds (replay v0142c1).
  //
  // P2-12 (2026-09-28, review round 4/5, qrefAfterCertified) — WHY THIS STAYS
  // TRUE EVEN UNDER force_serve, so the carve-out belongs elsewhere. The
  // query+fingerprint pair available HERE cannot tell "explicitly declared,
  // and inference happens to agree" from "never declared, inference landed
  // on answer" apart — that ambiguity is exactly what this omission is
  // conservative about, and force_serve does not resolve it (a coincidentally
  // "answer"-shaped query that was NEVER declared is still never declared
  // once force_serve is added — confirmed live: injecting here unconditionally
  // under force_serve makes an UNDECLARED task also report `source:"explicit"`
  // under force_serve, fabricating a declaration the caller never made). The
  // one signal that DOES resolve the ambiguity — the stored pack record's own
  // `requestProfileKey`, which remembers whether the ORIGINAL call that
  // opened this task declared a profile or omitted it — lives in
  // readCodeTaskPack.ts, not here, and stays valid under force_serve (it is a
  // read-only fact about a past call, not a cache-hit); see
  // `declaredProfileFromRecordUnderForceServe` there, consulted right before
  // `bindTaskProfile` when `forceServe` is what skipped `tryServeCachedPack`.
  if (autoBoundTaskProfile(resolution.query) === "answer") return;
  args["taskProfile"] = "answer";
  inheritedTaskProfileArgs.add(args);
}

/**
 * PI-03: read the trusted-client-host channel and, when it VERIFIES, bind it to
 * this call and mint the host-visible `context_handle`.
 *
 * Everything about this is fail-closed. The flag is off by default, so
 * `verifyContextAttestation` returns `disabled` and this is a single boolean
 * read; with the flag on, an absent / malformed / tampered / stale / foreign
 * attestation returns `undefined`, which is byte-identically the unattested
 * path. `try/catch` around the whole thing because an attestation channel that
 * threw would otherwise be a way to fail a tool call from outside.
 */
export function verifiedContextFor(
  args: Record<string, unknown>,
  requestMeta: Record<string, unknown> | undefined,
): VerifiedContextAttestation | undefined {
  if (requestMeta === undefined) return undefined;
  try {
    const workspaceRoot = resolveWorkspaceRoot(
      typeof args["cwd"] === "string" ? args["cwd"] : undefined,
      activeRoot,
    );
    const verdict = verifyContextAttestation({ meta: requestMeta, workspaceRoot });
    if (!verdict.ok) return undefined;
    const contextHandle = mintContextHandle(workspaceRoot, verdict.attestation, verdict.generation);
    return {
      attestation: verdict.attestation,
      generation: verdict.generation,
      workspaceRoot,
      ...(contextHandle !== undefined ? { contextHandle } : {}),
    };
  } catch {
    return undefined;
  }
}

/** Hash preflight only; source delivery remains in the ordinary read funnel. */
export async function readContinuationSource(file: string, workspace: string): Promise<string | null> {
  // served-bytes: not-served (continuation revision binding; no body leaves this helper)
  const verdict = await servedTextForRoute(file, workspace);
  return verdict === null || verdict.kind === "undecodable" ? null : verdict.text;
}
