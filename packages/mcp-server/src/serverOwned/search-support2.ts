// search-support — extracted implementation; imports point to the owning modules.
import type { ToolCall } from "@tokenlighten/types";
import { canonicalToolCall } from "../protocol/envelope.js";
import { isDeadTaskHandleOutcome } from "../state/stateHandles.js";
import { isRecordLike } from "./search-support.js";
import { laneTaskHandleNearMiss } from "../state/laneTaskHandles.js";
import { noteRefusedTaskHandle } from "../protocol/envelope.js";
import { resolveTaskHandle } from "../state/stateHandles.js";
import { sessionLaneOf } from "./task-binding2.js";
import { taskPackRecoveryFor } from "./read-admission2.js";

/**
 * The original callTool body, unchanged: canonical tool name in, wire result
 * out. Split out so callTool (below) can wrap it with the Fix 3 cwd
 * auto-correction pre/post-processing without touching a single line of this
 * switch — every case here is exactly as it was before that fix.
 */
/**
 * PI-09: validate the optional explicit-state REQUEST arguments —
 * `task_handle`, its `expected_state_version` CAS guard, and `force_serve`.
 *
 * Returns null when the argument is absent (the overwhelmingly common case —
 * every legacy caller, and every first call of a task) or when the handle is
 * authentic, in-lifetime, in-workspace and still backed by live state. Anything
 * else is a structured refusal with an EXECUTABLE recovery, because the one
 * outcome PI-09 forbids outright is silently continuing against the wrong
 * state ("暗黙のprocess memoryから「たぶん同じtask」と推測しない", item 12).
 *
 * REFUSAL CODE REUSE, deliberately. `Refusal.code` is a CLOSED enum frozen by
 * Protocol v1 §A.7.1, and this wave adds no wire kinds and no codes — so the
 * six distinct causes the store layer separates (`invalid`, `wrong-purpose`,
 * `expired`, `stale`, `unknown`, `store-unavailable`) all ride the existing
 * `handle-unknown`, and `wrong-workspace` rides the existing
 * `handle-workspace-mismatch`. The CAUSE is never lost: it is named in `hint`,
 * which is what the agent reads. Promoting any of them to its own code is a
 * snapshot + classifier change for a later wave, not a silent one here.
 */
export function taskHandleRefusal(
  args: Record<string, unknown>,
  workspace: string,
  tool: "tl_read_file" | "tl_edit_file" | "tl_search_files",
): Record<string, unknown> | null {
  // G2: only `tl_read_file`'s own `query` is the task_pack natural-language
  // request `taskPackRecoveryFor` may echo back — see that function's doc
  // comment for why `tl_search_files`/`tl_edit_file` must not.
  const canEchoQuery = tool === "tl_read_file";
  // PI-09 close-out: `force_serve` is a BOOLEAN, and a non-boolean spelling is
  // refused rather than coerced. Coercion here has a specific hazard: every
  // non-`true` value would read as "withhold", i.e. a caller that mis-typed
  // the argument it sent BECAUSE it lost its context would silently be denied
  // the bytes it asked for. Loud is the only safe direction.
  const forceServeArg = args["force_serve"];
  if (forceServeArg !== undefined && typeof forceServeArg !== "boolean") {
    return {
      ok: false,
      reason: "invalid-input",
      field: "force_serve",
      detail: "force_serve must be true or false — re-issue this exact call with force_serve:true to resend lost context, or omit it",
    };
  }
  const token = args["task_handle"];
  if (token === undefined) {
    // PI-09 close-out: `expected_state_version` is a PRECONDITION on the state
    // a `task_handle` names. Alone it names nothing, and an ignored
    // precondition is worse than an absent one — the caller believes a guard
    // ran. Refused, never dropped (§1.3.1's own words: "a dropped argument
    // changes what the call does").
    if (args["expected_state_version"] !== undefined) {
      // G2: `taskPackRecoveryFor` echoes back `args.query` when the caller's
      // OWN request already carries it, and otherwise carries no `next` at
      // all — never the "<restate the request verbatim>" placeholder, which
      // `protocol/refusal.ts`'s `containsPlaceholder` gate silently deletes,
      // leaving this refusal with no `next` on the wire.
      return {
        ok: false,
        reason: "invalid-input",
        field: "expected_state_version",
        detail: "expected_state_version guards a task_handle's state and is meaningless without one — send both, or neither",
        ...taskPackRecoveryFor(args, canEchoQuery),
      };
    }
    return null;
  }
  if (typeof token !== "string" || token === "") {
    return {
      ok: false,
      reason: "invalid-input",
      field: "task_handle",
      detail: "task_handle must be the opaque string a prior task_pack returned as task.id",
      ...taskPackRecoveryFor(args, canEchoQuery),
    };
  }
  const resolved = resolveTaskHandle(token, workspace);
  // A live task handle carries a persisted replay qref (`state.replay`), and
  // G2 (state/stateHandles.ts's `persistQueryRef`/`rehydrateQueryRef`) durably
  // mirrors the ledger that qref names — so this recipe is now genuinely
  // executable after a restart, not merely shaped like it. When no replay
  // qref was recorded (or the handle itself did not resolve), fall back to
  // `taskPackRecoveryFor`: echo the caller's own `args.query` when this same
  // call carries it, otherwise `retry:"new-task"` + `remaining` prose rather
  // than the placeholder call this used to build — a placeholder-bearing
  // `next` is not degraded by `protocol/refusal.ts`'s placeholder gate, it is
  // deleted outright, which is the exact dead end G2 exists to close.
  const freshPack: { next?: ToolCall; retry: "new-task"; remaining?: string } =
    resolved.ok && typeof resolved.state.replay === "string" && resolved.state.replay !== ""
      ? {
          next: canonicalToolCall("tl_read_file", { mode: "task_pack", qref: resolved.state.replay, task: { epoch: "new" } }),
          retry: "new-task",
        }
      : taskPackRecoveryFor(args, canEchoQuery);
  if (resolved.ok) {
    // PI-09 close-out: the CAS guard, checked only once the handle itself is
    // proven authentic/in-workspace/live — so a mismatch report can never leak
    // the current version of state the caller was not entitled to name.
    const expected = args["expected_state_version"];
    if (expected !== undefined) {
      if (typeof expected !== "number" || !Number.isInteger(expected) || expected < 0) {
        return {
          ok: false,
          reason: "invalid-input",
          field: "expected_state_version",
          detail: "expected_state_version must be a non-negative integer — the state version a prior call reported for this task_handle",
          ...freshPack,
        };
      }
      if (expected > resolved.stateVersion) {
        // 2026-10-17 (Copilot CLI F1, DESIGN-v0.14-plan §20.10): a version
        // this task never reached cannot be a stale view — no refusal ever
        // reported it, so it was guessed, and a re-pack would change nothing
        // the caller needs. Still refused (never ignored); the sanctioned
        // transition is re-issuing this call with the reported `actual`.
        return {
          ok: false,
          reason: "invalid-input",
          field: "expected_state_version",
          detail: `task state is at version ${resolved.stateVersion} and has never reached ${expected}; nothing was done — re-issue this call with expected_state_version ${resolved.stateVersion}, or without it`,
          requested_handle: token,
          actual: resolved.stateVersion,
          retry: "call",
        };
      }
      if (expected !== resolved.stateVersion) {
        // FAIL CLOSED. The handle is live, but the state it names has moved
        // past the version the caller is reasoning about: proceeding would be
        // exactly the "silently continue against the wrong state" outcome
        // PI-09 forbids. `retry:"new-task"` is declared explicitly so the
        // sanctioned transition is the re-pack family, not a bare re-issue of
        // the same (now provably stale) precondition.
        //
        // CODE REUSE, deliberate — same reasoning as the handle causes above:
        // A.7.1 is a closed enum and this wave mints no codes, so the coarse
        // `invalid-input` carries the cause in `detail`.
        //
        // `actual` rather than a fresh `actual_state_version`: the A.8 advisory
        // allowlist (`protocol/refusal.ts` REFUSAL_ADVISORY_KEYS) is a CLOSURE,
        // not a filter, so a new key would be silently dropped by the funnel —
        // and `actual` is already declared there for exactly this shape ("what
        // the value actually is"). The EXPECTED half deliberately does not
        // ride: the caller sent it, so it is caller-recoverable, and the
        // `detail` names both numbers either way.
        //
        // This refusal is also the ONLY disclosure path for the current version
        // — D-2 forbids a `CommonStateOutput` block, so no success-path field
        // carries it. Recorded as a known gap rather than papered over.
        return {
          ok: false,
          reason: "invalid-input",
          field: "expected_state_version",
          detail: `task state is at version ${resolved.stateVersion}; this call expected ${expected} — the task advanced under you, so nothing was done`,
          requested_handle: token,
          actual: resolved.stateVersion,
          ...freshPack,
        };
      }
    }
    return null;
  }

  const hint =
    resolved.outcome === "wrong-purpose"
      ? "this is not a task handle — task_handle takes the `task.id` of a prior task_pack, never a continuation cursor or a context handle"
      : resolved.outcome === "expired"
        ? "this task handle has expired; re-pack to open a fresh task"
        : resolved.outcome === "invalid"
          ? "this task handle failed authentication (edited, truncated, or minted by another installation)"
          : resolved.outcome === "wrong-subject"
            ? "this task handle was minted by a different TokenLighten installation"
            : resolved.outcome === "stale"
              ? "the state store was rebuilt, so this task handle names a generation that no longer exists"
              : resolved.outcome === "store-unavailable"
                ? "no durable state store is available for this workspace, so no task handle can be honoured here"
                : "the state store no longer holds this task's state";

  if (resolved.outcome === "wrong-workspace") {
    return {
      ok: false,
      reason: "handle-workspace-mismatch",
      requested_handle: token,
      hint: "this task handle belongs to a different workspace; a task handle is bound to the workspace it was minted in",
      ...freshPack,
    };
  }
  // D1 (2026-09-05, measured on paid smoke r10 / SF13 call 13): before
  // declaring that no working set survives, ask whether THIS lane is holding a
  // live task whose handle the caller merely mangled. `isSplicedHandle` proves
  // the supplied string is that handle with one contiguous run deleted — the
  // measured truncation — so the answer is a correction, not a guess, and the
  // sanctioned transition is the one-field re-issue rather than a full re-pack
  // of a working set that never died. A foreign or genuinely stale handle
  // matches nothing here and keeps the shape above, byte-for-byte.
  //
  // E1 (2026-09-05, measured on paid smoke r11 / SF13-estimator-telemetry-
  // continuation): `laneTaskHandleNearMiss` also runs
  // `isEllipsisAbbreviatedHandle` alongside `isSplicedHandle` — the r11
  // capture was a DISPLAY-ABBREVIATED handle ("prefix...suffix"), which is a
  // different shape from a splice (extra marker characters, not a deletion)
  // but earns the identical refusal below: same `did_you_mean`, same
  // `retry:"call"`, no new field.
  //
  // RIDES THE DEFAULT WIRE, deliberately, unlike `TL_CWD_NEAR_MISS`. That flag
  // gates the ENUMERATION of a candidate pool (`cwd_candidates` lists the
  // registered worktrees a caller had not named). Nothing is enumerated here:
  // the one value returned is a handle the caller demonstrably already held —
  // it sent almost all of it in this very call — so there is no disclosure
  // decision to gate. What is being repaired is a factually FALSE `remaining`
  // on a refusal that already failed, and an honesty defect is not an
  // experiment. No successful call's bytes change.
  const nearMissHandle = laneTaskHandleNearMiss(
    workspace,
    sessionLaneOf(args),
    token,
    (candidate) => resolveTaskHandle(candidate, workspace).ok,
  );
  if (nearMissHandle !== undefined) {
    return {
      ok: false,
      reason: "handle-unknown",
      field: "task.handle",
      requested_handle: token,
      did_you_mean: nearMissHandle,
      detail: "this task handle is the lane's live task handle with a run of characters missing (truncated or spliced in transit) — re-issue this exact call with the handle in did_you_mean; the working set is intact and nothing was lost",
      retry: "call",
    };
  }
  // 2026-10-19 (v016 decision 6t-3, T09 rep0 #11): an EDIT whose task handle
  // is dead. The edit's items address their own files (by path, or by item
  // handles resolved through the handle table), and tl_edit_file reads its
  // task handle for nothing but this check, so the working set survives and
  // the sanctioned transition is the same call without the dead handle —
  // never the "no working set survives" re-pack below. Measured: the solver
  // typed its task handle wrong ("…PjT1JLFLH…" sent as "…PjTLLFLH…"), obeyed
  // the re-pack prose (a 23.4 KB `epoch:"new"` pack) and re-sent its edits.
  // Still a refusal (tl_edit_file keeps strict authentication: nothing is
  // written under a handle that failed), and only for the dead outcomes:
  // `wrong-workspace` returned above (a cwd mix-up), `wrong-purpose` and
  // `store-unavailable` keep the re-pack, and an `expected_state_version` names
  // that handle's state, so it is refused, never dropped.
  if (tool === "tl_edit_file" && isDeadTaskHandleOutcome(resolved.outcome) && args["expected_state_version"] === undefined) {
    // Noted BEFORE the call is minted: minting attributes the inbound task
    // handle to any continuation that has none, and this one must not get it.
    noteRefusedTaskHandle(token);
    const next = editCallWithoutTaskHandle(args);
    if (next !== undefined) {
      return {
        ok: false,
        reason: "handle-unknown",
        field: "task.handle",
        requested_handle: token,
        hint,
        detail: "nothing was written — the edit items address their own files, so the working set is intact: next is this same call without task.handle",
        retry: "call",
        next,
      };
    }
  }
  return {
    ok: false,
    reason: "handle-unknown",
    requested_handle: token,
    hint,
    ...freshPack,
  };
}

/**
 * 2026-10-19 (v016 decision 6t-3): `args` (a `tl_edit_file` call, legacy
 * projection) re-issued without its task handle, as the canonical call a
 * dead-handle refusal's `next` names. `undefined` when the call carries
 * nothing to edit — that call is refused for its own shape, not here.
 * The caller's dead handle is kept off the continuation by
 * `noteRefusedTaskHandle` (protocol/envelope.ts), not by this projection.
 */
export function editCallWithoutTaskHandle(args: Record<string, unknown>): ToolCall | undefined {
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (key !== "task_handle") rest[key] = value;
  }
  const addressed = Array.isArray(rest["edits"])
    || typeof rest["path"] === "string"
    || typeof rest["handle"] === "string"
    || rest["artifact"] !== undefined;
  // 2026-10-22: the refusal's own claim is that "the edit items address their
  // own files". An item that names neither a `path` nor a `handle` is refused
  // by the dispatcher's pre-pass (`edits-item-missing-target`) and by the
  // act.edit fence's address correction, so re-sending it without the dead
  // task handle would prescribe a call this server certainly refuses (the
  // advertised item `anyOf` and emittedToolCallShape.spec.ts W2-3 hold it to
  // that). Such a call falls through to the re-pack refusal below. A lone
  // intent item never gets here as an `edits[]` item: it is unpacked to the
  // flat `mode`/`intent` form first.
  const itemsNameFiles = !Array.isArray(rest["edits"])
    || rest["edits"].every((item) => !isRecordLike(item) || typeof item["path"] === "string" || typeof item["handle"] === "string");
  return addressed && itemsNameFiles ? canonicalToolCall("tl_edit_file", rest) : undefined;
}
