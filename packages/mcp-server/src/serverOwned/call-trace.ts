// call-trace — extracted implementation; imports point to the owning modules.
import type { ReadCallReplayAuthorization } from "../protocol/readCallContinuation.js";
import type { ToolCallResult } from "../protocol/result.js";
import { ALLOW_WRITE } from "../runtime/config.js";
import { CANONICAL_ORIGINAL_INPUT } from "./canonical-input2.js";
import { CONTEXT_STATE_META_KEY } from "@tokenlighten/types";
import { QUERY_CANDIDATE_POLICY_INPUT } from "./canonical-input2.js";
import { activeEngineConfiguration } from "../features/engines/config.js";
import { activeRoot } from "../runtime/config.js";
import { asCanonicalObject } from "./canonical-input.js";
import { callToolUninstrumented } from "./dispatch-funnel2.js";
import { canonicalOriginalReadInput } from "./canonical-input3.js";
import { canonicalRequestRefusal } from "./canonical-input3.js";
import { canonicalTaskBindingForExecutedCall } from "./task-binding2.js";
import { checkCwdOrRefuse } from "./workspace-routing.js";
import { classifyRoute } from "../routing/classifier.js";
import { commitReadBaseline } from "./task-binding.js";
import { consumeIndependentRangeStalenessNote } from "../util/packServeLog.js";
import { contractLaneOf } from "./task-binding2.js";
import { cursorCoInputRefusal } from "./canonical-input2.js";
import { dispatchTaskRef } from "./task-binding2.js";
import { finalizeProtocolResponse } from "../protocol/envelope.js";
import { forgetExecutedNext } from "../util/packServeLog.js";
import { handleTable } from "../util/handles.js";
import { hydrateReadCallContinuation } from "../protocol/readCallContinuation.js";
import { legacyInputRefusal } from "./task-binding2.js";
import { modelVisibleBytes } from "./task-binding2.js";
import { observedCallMode } from "./task-binding2.js";
import { observedEnvelopeMeta } from "./task-binding2.js";
import { packBuilderQuery } from "./autofollow4.js";
import { prepareCanonicalInput } from "./canonical-input4.js";
import { projectCanonicalRequest } from "./canonical-input4.js";
import { readBaselineMeasurement } from "./dispatch-funnel2.js";
import { readBaselineTokens } from "./dispatch-funnel2.js";
import { readContinuationSource } from "./task-binding.js";
import { recordExecutedNext } from "../util/packServeLog.js";
import { recorder } from "./dispatch-funnel2.js";
import { resolveWorkspaceRoot } from "./read-admission2.js";
import { resolvedClientId } from "../runtime/config.js";
import { runWithCallWorkspace } from "../util/handles.js";
import { runWithProtocolCall } from "../protocol/envelope.js";
import { runWithSessionLane } from "../state/session.js";
import { runWithTraceCall } from "../util/trace.js";
import { runWithVerifiedContext } from "../state/contextAttestation.js";
import { sessionLaneOf } from "./task-binding2.js";
import { sessionLaneRefusal } from "./task-binding2.js";
import { setTraceContext } from "../util/trace.js";
import { settleReadBaselineSymbols } from "./dispatch-funnel2.js";
import { shaOfText } from "../util/handles.js";
import { taskAliasLaneMismatch } from "../state/taskHandleAliases.js";
import { taskHandleRecoveryEnabled } from "../util/flags.js";
import { toolStructuredError } from "../protocol/result.js";
import { trace } from "../util/trace.js";
import { traceCausalAttestation } from "../util/trace.js";
import { verifiedContextFor } from "./task-binding.js";
import { withEngineConfiguration } from "../features/engines/config.js";

export async function callToolOnce(
  name: string,
  args: Record<string, unknown>,
  requestMeta?: Record<string, unknown>,
  readCallDispatch?: import("@tokenlighten/types").ReadCallDispatchBinding,
  onRestoredReadInput?: (input: Record<string, unknown>, replayAuthorization?: ReadCallReplayAuthorization) => void,
): Promise<ToolCallResult> {
  const editOperationCount = name === "tl_edit_file" && Array.isArray(args["edits"]) ? args["edits"].length : undefined;
  const refusal = legacyInputRefusal(args);
  if (refusal !== undefined) {
    return runWithProtocolCall({ tool: name, kind: "refusal" }, () => finalizeProtocolResponse(name, refusal));
  }
  // DESIGN-v0.15 §5.2 (R2): a cursor continuation may not silently change WHAT
  // was asked for. Checked here, on the caller's OWN canonical arguments, one
  // statement before the legacy projection erases the distinction between
  // `content:"full"` and `mode=full`.
  const cursorRefusal = cursorCoInputRefusal(name, args);
  if (cursorRefusal !== undefined) {
    return runWithProtocolCall(
      { tool: name, kind: "refusal" },
      () => finalizeProtocolResponse(name, toolStructuredError(cursorRefusal)),
    );
  }
  // 2026-10-10 review (P1 + P3): the canonical request is validated against
  // the advertised schema between repair and projection — see
  // `canonicalRequestRefusal`.
  let prepared = prepareCanonicalInput(name, args);
  const shapeRefusal = canonicalRequestRefusal(name, prepared);
  if (shapeRefusal !== undefined) {
    return runWithProtocolCall(
      { tool: name, kind: "refusal" },
      () => finalizeProtocolResponse(name, toolStructuredError(shapeRefusal)),
    );
  }
  // A valid compact reference in the wrong lane is not a dead task. Preserve
  // the complete request and capability; never suggest dropping task.handle.
  if (resolvedClientId()?.toLowerCase() === "copilot-cli" && taskHandleRecoveryEnabled()
    && sessionLaneRefusal(prepared) === null
    && (prepared["cwd"] === undefined || typeof prepared["cwd"] === "string")) {
    const cwdRefusal = checkCwdOrRefuse(prepared["cwd"], activeRoot);
    if (cwdRefusal !== null) return runWithProtocolCall({tool: name, kind: "refusal"}, () =>
      finalizeProtocolResponse(name, toolStructuredError(cwdRefusal)));
    try {
      const workspace = resolveWorkspaceRoot(typeof prepared["cwd"] === "string" ? prepared["cwd"] : undefined, activeRoot);
      const task = asCanonicalObject(prepared["task"]);
      const lane = typeof task?.["handle"] === "string"
        ? taskAliasLaneMismatch(workspace, sessionLaneOf(prepared), task["handle"]) : undefined;
      if (lane !== undefined) {
        const corrected: Record<string, unknown> = { ...prepared, cwd: workspace };
        if (lane === "") delete corrected["lane"];
        else corrected["lane"] = lane;
        // A fresh, corrected protocol context prevents inbound lane inheritance
        // at every canonicalization. Emitting refusal recovery grants no ranges.
        return runWithProtocolCall({ tool: name, kind: "refusal", args: corrected,
          continuationWorkspace: workspace, refusalRecovery: true }, () =>
          finalizeProtocolResponse(name, toolStructuredError({
            ok: false, code: "invalid-lane", field: "lane", retry: "call",
            detail: "task.handle belongs to a different lane; nothing was executed. Follow next without dropping task.handle.",
            next: { tool: name, arguments: corrected },
          })));
      }
    } catch { /* ordinary workspace validation owns invalid roots */ }
  }
  if (name === "tl_read_file" && typeof prepared["cursor"] === "string") {
    let workspace: string | undefined;
    try { workspace = resolveWorkspaceRoot(typeof prepared["cwd"] === "string" ? prepared["cwd"] : undefined, activeRoot); }
    catch { /* ordinary dispatch owns invalid workspace diagnostics */ }
    if (workspace !== undefined) {
      const root = workspace, lane = sessionLaneOf(prepared);
      let hydrated: Awaited<ReturnType<typeof hydrateReadCallContinuation>>;
      try {
        hydrated = await runWithCallWorkspace(root, () => runWithSessionLane(lane, () =>
          hydrateReadCallContinuation(root, lane, prepared,
            file => readContinuationSource(file, root), handle => handleTable.get(handle),
            candidate => canonicalRequestRefusal("tl_read_file", prepareCanonicalInput("tl_read_file", candidate)), readCallDispatch)));
      } catch {
        hydrated = {kind: "refusal", refusal: {ok: false, code: "cursor-invalid", field: "cursor",
          detail: "read-call continuation could not be restored; restart the original request", retry: "call"}};
      }
      if (hydrated.kind === "refusal") {
        return runWithProtocolCall({tool: name, kind: "refusal"}, () =>
          finalizeProtocolResponse(name, toolStructuredError(hydrated.refusal)));
      }
      if (hydrated.kind === "hydrated") {
        args = hydrated.input;
        prepared = prepareCanonicalInput(name, args);
        const restoredRefusal = canonicalRequestRefusal(name, prepared);
        if (restoredRefusal !== undefined) {
          return runWithProtocolCall({tool: name, kind: "refusal"}, () =>
            finalizeProtocolResponse(name, toolStructuredError(restoredRefusal)));
        }
        onRestoredReadInput?.(args, hydrated.replayAuthorization);
      }
    }
  }
  const legacyArgs = projectCanonicalRequest(name, prepared);
  // The canonical original, for the restart `next` a `cursor-stale` refusal and
  // a stored request record owe (see `CANONICAL_ORIGINAL_INPUT`).
  if (name === "tl_read_file") {
    // Explicit legacy modes are opt-in compatibility requests. Read the raw
    // input here: canonical queries acquire mode:"task_pack" during projection.
    Object.defineProperty(legacyArgs, QUERY_CANDIDATE_POLICY_INPUT, {
      value: args["mode"] === undefined,
      enumerable: true,
      configurable: true,
    });
    Object.defineProperty(legacyArgs, CANONICAL_ORIGINAL_INPUT, {
      value: canonicalOriginalReadInput(args),
      enumerable: true,
      configurable: true,
    });
    // The pack builder reads the query as `packBuilderQuery` projects it:
    // literal `\n` escapes read as line breaks (window 6t-8), then the task's
    // process sections set aside (window 6t-7). The canonical original above
    // keeps the caller's text.
    if (typeof legacyArgs["query"] === "string") {
      legacyArgs["query"] = packBuilderQuery(legacyArgs["query"]);
    }
  }
  return runWithTraceCall(() => withEngineConfiguration(activeEngineConfiguration(), () => callToolTraced(name, legacyArgs, requestMeta, editOperationCount)));
}

export async function callToolTraced(
  name: string,
  args: Record<string, unknown>,
  requestMeta?: Record<string, unknown>,
  editOperationCount?: number,
) {
  const canonical = name;
  // V10-04 (beta.1): advisory route classification (routing/classifier.ts) —
  // observability only, nothing below branches on it. Cheap pure string
  // classification, computed unconditionally so the trace call always has a
  // decision to record.
  const routeDecision = classifyRoute(canonical, args);
  setTraceContext({ route: routeDecision.route });
  // V13 (2026-08-30): hoisted out of the trace try-block below so the usage
  // recorder — in the SEPARATE try/catch further down, success path AND the
  // outer catch's error path — can stamp the SAME per-call task_ref onto its
  // NDJSON event. Was previously a `const` scoped entirely inside that first
  // try block, invisible to both `recorder().record()` call sites; see
  // `TokenLightenUsageEvent.taskRef`'s doc for what the recorder does with it
  // (task-grouped `summarizeUsage` accounting). Left `undefined` when the
  // trace try-block below throws before assigning it, or never runs at all —
  // exactly the "call named no task" case the recorder already treats as
  // `taskRef: null`.
  let dispatchQueryRef: { ref: string; repeated: boolean } | undefined;
  try {
    const cwd = typeof args["cwd"] === "string" ? args["cwd"] : undefined;
    const workspaceRoot = resolveWorkspaceRoot(cwd, activeRoot);
    traceCausalAttestation(workspaceRoot);
    // V10-02: resolve task_ref BEFORE route_decision fires (must run inside
    // the CALLER's session lane -- 2026-08-07 concurrent-agent lanes -- so a
    // non-default-lane caller's qref resolves against ITS OWN session, not
    // the shared default one) so route_decision, and every trace() line
    // after it, carries the fullest context this call ever resolves rather
    // than only the ones emitted after the fact.
    dispatchQueryRef = runWithSessionLane(
      sessionLaneOf(args),
      () => dispatchTaskRef(args, workspaceRoot),
    );
    if (dispatchQueryRef !== undefined) setTraceContext({ taskRef: dispatchQueryRef.ref });
    trace("route_decision", { tool: canonical, route: routeDecision.route, reason: routeDecision.reason }, workspaceRoot);
    // V10-02: forced_resend — a generic force_serve-style bypass arg, read
    // structurally off the raw request args so this has NO hard dependency
    // on the not-yet-landed PI-09 wire arg of the same name (D-8/deviation
    // register). The event simply never fires while the arg does not exist
    // in this tree, which is every call today.
    if (args["force_serve"] === true) {
      trace("forced_resend", { tool: canonical }, workspaceRoot);
    }
    if (dispatchQueryRef?.repeated === true) {
      trace("repeated_query", { task_ref: dispatchQueryRef.ref }, workspaceRoot);
    }
  } catch {
    // Attestation/route tracing is observability only and must never alter an MCP outcome.
  }
  const startedAt = performance.now();
  let baselineMeasurement = readBaselineMeasurement(canonical, args);
  // R1: declared outside the try so BOTH failure exits — an `isError` result
  // and a thrown one — can withdraw the in-flight pre-record made below.
  let inFlight: { workspace: string; lane: string; taskBinding?: string } | undefined;
  let inFlightWasKnown = true;
  try {
    // 2026-08-07 concurrent-agent lanes: both transports funnel through this
    // function, so binding the async context here scopes EVERY session lookup
    // of the call — dispatch, features, guards — to the caller's lane. The
    // refusal flows through the recorder below like any other result.
    const laneRefusal = sessionLaneRefusal(args);
    // PI-03: verified BEFORE dispatch so the binding covers the whole call —
    // the receipt projector that consults it runs deep inside the funnel.
    // `undefined` (the default, and every rejection) means the dispatch below
    // runs with no binding at all, which is today's behavior exactly.
    const verifiedContext = verifiedContextFor(args, requestMeta);
    // -----------------------------------------------------------------------
    // R1 (2026-08-28): THE IN-FLIGHT CALL IS CONSUMED WORK, AND ITS OWN
    // RESPONSE MUST SEE THAT.
    //
    // The executed-next ledger was written only AFTER `callToolUninstrumented`
    // returned, so the response BUILT BY a prescribed next could not observe
    // that the very call producing it had just consumed that next. Both
    // no-repeat gates (readCodeTaskPack's `suppressNonProgressingNextCall` and
    // the shared producer exit) therefore compared against a ledger exactly one
    // call stale and re-emitted the prescribed call byte-identically; only a
    // THIRD identical call finally saw it and advanced. Reproduced live on the
    // follower's f03 and Tier-3 enum-refunded shapes, where step 0 prescribes
    // `tl_read_file mode=task_pack query=<verbatim> surfaceRoles=[…]` and step 1 —
    // that exact call — hands the same call back with the same open gaps.
    //
    // Recording at dispatch is the ledger's own rule applied at the honest
    // moment: a caller who has spent this call cannot be told to spend it
    // again, whatever the result turns out to be. `recordExecutedNext` returns
    // whether the shape was ALREADY known, so a call that ends in error
    // withdraws only a pre-record that it introduced (below), leaving a
    // genuinely earlier execution of the same shape intact. The success path
    // still records again with the result digest, which is what stamps
    // `resultDigest` — this only moves WHEN the fingerprint becomes visible.
    // -----------------------------------------------------------------------
    if (!laneRefusal && (canonical === "tl_read_file" || canonical === "tl_search_files")) {
      try {
        const workspace = resolveWorkspaceRoot(typeof args["cwd"] === "string" ? args["cwd"] : undefined, activeRoot);
        const lane = contractLaneOf(args);
        const taskBinding = canonicalTaskBindingForExecutedCall(canonical, args, workspace);
        inFlightWasKnown = recordExecutedNext(workspace, lane, canonical, args, undefined, taskBinding);
        inFlight = { workspace, lane, ...(taskBinding !== undefined ? { taskBinding } : {}) };
      } catch {
        // An unresolvable workspace is the dispatch's own problem to report;
        // the ledger simply learns nothing about this call.
      }
    }
    const result = laneRefusal
      // protocol v1: the lane refusal short-circuits BEFORE the dispatch funnel,
      // so it needs its own envelope. D1 admits no exceptions — a refusal a
      // client cannot version-identify is the class §1.2 exists to remove.
      ? runWithProtocolCall({ tool: canonical, kind: "refusal" }, () =>
          finalizeProtocolResponse(canonical, laneRefusal))
      : await runWithVerifiedContext(verifiedContext, () =>
          runWithSessionLane(sessionLaneOf(args), () => callToolUninstrumented(name, args, editOperationCount)));
    // PI-03: the ISSUED handle rides result `_meta`, host-visible and never in
    // `content[*].text` — plan invariant 15's other half, the one that keeps a
    // context handle out of the model's reach in BOTH directions.
    if (verifiedContext?.contextHandle !== undefined) {
      (result as ToolCallResult)._meta = {
        ...(result as ToolCallResult)._meta,
        [CONTEXT_STATE_META_KEY]: {
          context_handle: verifiedContext.contextHandle,
          context_generation: verifiedContext.generation,
        },
      };
    }
    const outcomeIsError = "isError" in result && result.isError === true;
    // R1: withdraw an in-flight pre-record this call INTRODUCED when the call
    // failed — a failed call spent no work the ledger may hold a later next
    // against. A shape already present before the pre-record is left alone.
    if (outcomeIsError && inFlight !== undefined && !inFlightWasKnown) {
      forgetExecutedNext(inFlight.workspace, inFlight.lane, canonical, args, inFlight.taskBinding);
    }
    // GATE-A (2026-09-21, item 2): an independent caller-ranged read that hit
    // a since-changed revision it does not itself re-cover left a one-line
    // disclosure for THIS call to attach — consumed here, once, right after
    // the call that produced it returns (never on an error/refusal result,
    // and never overwriting a `note` the response already carries).
    if (!outcomeIsError && canonical === "tl_read_file") {
      const workspace = resolveWorkspaceRoot(typeof args["cwd"] === "string" ? args["cwd"] : undefined, activeRoot);
      const independentStalenessNote = consumeIndependentRangeStalenessNote(workspace);
      if (independentStalenessNote !== undefined) {
        const first = (result as ToolCallResult).content?.[0];
        if (first !== undefined && typeof first.text === "string") {
          try {
            const parsed: unknown = JSON.parse(first.text);
            if (
              parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
              && (parsed as Record<string, unknown>)["kind"] !== "refusal"
              && typeof (parsed as Record<string, unknown>)["note"] !== "string"
            ) {
              (parsed as Record<string, unknown>)["note"] = independentStalenessNote;
              first.text = JSON.stringify(parsed);
            }
          } catch {
            // Not JSON (should not happen for tl_read_file) — leave the result untouched.
          }
        }
      }
    }
    if (!outcomeIsError && (canonical === "tl_read_file" || canonical === "tl_search_files")) {
      const workspace = resolveWorkspaceRoot(typeof args["cwd"] === "string" ? args["cwd"] : undefined, activeRoot);
      recordExecutedNext(
        workspace,
        // A-F1: `?? "default"` never fired — sessionLaneOf returns "" (not
        // undefined) for a lane-less call, so every default-path write landed
        // in a partition no reader consults.
        contractLaneOf(args),
        canonical,
        args,
        shaOfText(JSON.stringify(result.content)),
        canonicalTaskBindingForExecutedCall(canonical, args, workspace),
      );
    }
    if (!outcomeIsError) commitReadBaseline(baselineMeasurement, args);
    baselineMeasurement = outcomeIsError
      ? { ...baselineMeasurement, pendingSymbols: [] }
      : settleReadBaselineSymbols(baselineMeasurement, args, result);
    try {
      if (
        canonical === "tl_read_file"
        || canonical === "tl_search_files"
        || canonical === "tl_edit_file"
      ) {
        const envelopeMeta = observedEnvelopeMeta(result);
        recorder().record({
          tool: canonical,
          outcome: outcomeIsError ? "error" : "ok",
          durationMs: performance.now() - startedAt,
          responseBytes: modelVisibleBytes(result),
          baselineTokens: readBaselineTokens(baselineMeasurement),
          baselineMethod: baselineMeasurement.method,
          writeEnabled: ALLOW_WRITE,
          // V13: same task_ref on a query's first call and every qref
          // continuation of it — see the hoisted `dispatchQueryRef` doc above.
          taskRef: dispatchQueryRef?.ref ?? null,
          kind: envelopeMeta.kind,
          mode: observedCallMode(canonical, args),
          errorCode: outcomeIsError ? envelopeMeta.errorCode : undefined,
          retry: outcomeIsError ? envelopeMeta.retry : undefined,
          field: outcomeIsError ? envelopeMeta.field : undefined,
        });
      }
    } catch {
      // Usage measurement must never alter an MCP call outcome.
    }
    return result;
  } catch (error: unknown) {
    try {
      if (
        canonical === "tl_read_file"
        || canonical === "tl_search_files"
        || canonical === "tl_edit_file"
      ) {
        recorder().record({
          tool: canonical,
          outcome: "error",
          durationMs: performance.now() - startedAt,
          responseBytes: 0,
          baselineTokens: readBaselineTokens(baselineMeasurement),
          baselineMethod: baselineMeasurement.method,
          writeEnabled: ALLOW_WRITE,
          // V13: the thrown-dispatch failure exit — same `dispatchQueryRef`
          // as the success-path record above, so a failed call still
          // correlates to its task_ref instead of falling out of every group.
          taskRef: dispatchQueryRef?.ref ?? null,
          mode: observedCallMode(canonical, args),
        });
      }
    } catch {
      // Preserve the original failure.
    }
    // R1: a thrown dispatch is the other failure exit — withdraw on the same
    // rule as the `isError` path above.
    if (inFlight !== undefined && !inFlightWasKnown) {
      try {
        forgetExecutedNext(inFlight.workspace, inFlight.lane, canonical, args, inFlight.taskBinding);
      } catch {
        // Preserve the original failure.
      }
    }
    throw error;
  }
}
