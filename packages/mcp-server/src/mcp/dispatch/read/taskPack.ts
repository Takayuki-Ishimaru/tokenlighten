import type { ToolCallResult } from "../../../protocol/result.js";
import { trace } from "../../../util/trace.js";
import { recordReadMode } from "../../../state/session.js";
import { runWithTaskContractScope } from "../../../features/task-pack/taskContractStore.js";
import { buildTaskPack } from "../../../features/task-pack/engine/taskPackEntry.js";
import { ALLOW_WRITE } from "../../../runtime/config.js";
import { normalizeContractLane } from "../../../util/packServeLog.js";
import { inheritedTaskProfileArgs } from "../../../runtime/requestState.js";
import { reasoningIrV2Enabled } from "../../../util/flags.js";
import { recordReasoningIrV2FromPack } from "../../../task-state/irDispatchSeam.js";
import { attachSupply } from "../../../util/attachSupply.js";
import { toolOk } from "../../../protocol/result.js";
import { parseMcpLang, admitCallerRangedContinuation, parseTaskProfile, mapTaskPackPaths, rememberTaskPackQuery, attachServerBuildOnce, type TaskPackQueryResolution } from "../../../serverOwned/read-admission2.js";
import { taskContractScopeForPack, canonicalTaskBindingForHandle, sessionLaneOf } from "../../../serverOwned/task-binding2.js";
import { taskPackAdmission } from "../../../serverOwned/read-admission.js";
import { QUERY_CANDIDATE_POLICY_INPUT } from "../../../serverOwned/canonical-input2.js";
import { SMALL_WINDOW_RESERVE_FORCE } from "../../../serverOwned/canonical-input.js";
import { recordTaskPackSurfaceReads, recordTaskPackExecution } from "../../../serverOwned/task-pack-wire.js";

export interface read_taskPackPort {
  "mode": string;
  "taskPackQuery": TaskPackQueryResolution;
  "args": Record<string, unknown>;
  "workspace": string;
  "resolvedPath": string | undefined;
  "resolvedRange": string | undefined;
  "defaultResponseByteCeiling": number | undefined;
  "taskCredential": { credentialRef: string; credentialPassword: string; } | { credentialRef?: undefined; credentialPassword?: undefined; };
  "resolvedSymbol": string | undefined;
}
export async function read_taskPack(port: read_taskPackPort): Promise<ToolCallResult | undefined> {
  const { mode, taskPackQuery, args, workspace, resolvedPath, resolvedRange, defaultResponseByteCeiling, taskCredential, resolvedSymbol } = port;
if (mode === "task_pack") {
        const taskPackStartedAt = Date.now();
        trace("task_pack_start", {
          query_chars: taskPackQuery.query.length,
          task_profile: args["taskProfile"] ?? null,
        }, workspace);
        recordReadMode(workspace, "task_pack");
        // D10 (2026-08-14): `TL_TASK_PACK` is deleted; the flagship pack is
        // unconditional, so the `task-pack-disabled` refusal is unreachable and
        // is gone with it.
        const tpLang = parseMcpLang(args["lang"]);
        const tpHasPaths = Array.isArray(args["paths"]) && (args["paths"] as unknown[]).length > 0;
        // 11a parity for the pack path (2026-07-30): a caller-supplied range
        // must actually reach the pack builder. It was dropped here entirely,
        // so a remaining_ranges zoom (task_pack handle+range) rebuilt the
        // handle's SYMBOL view and re-served the same head — remaining_ranges
        // never advanced (live loop, run 2026-07-30-semantic-signal5-2 T03).
        const tpZoomPaths = !tpHasPaths && resolvedPath !== undefined && resolvedRange !== undefined
          ? [{ path: resolvedPath, range: resolvedRange }]
          : undefined;
        const taskContractScope = taskContractScopeForPack(args, workspace, taskPackQuery.query);
        // G3 (2026-09-08, qref-binding fix): `taskContractScopeForPack` only
        // recovers a handle-backed scope when this lane already has exactly
        // one live task whose OWN stored query matches verbatim
        // (`uniqueTaskScopeForExactQuery`) — it has nothing to match for the
        // FIRST pack of an epoch, which registers its contract before any
        // handle is minted. Fall back to the binding this call's own qref
        // carries (resolveTaskPackQueryArg), same rationale as the sibling
        // pathless-exploratory branch above.
        const taskBinding = canonicalTaskBindingForHandle(workspace, taskContractScope.taskHandle) ?? taskPackQuery.taskBinding;
        const admission = taskPackAdmission(args, defaultResponseByteCeiling);
        if (admission !== undefined) return admission;
        // TL-06 (plan-0143 §4/§8.1, R04): covers both an explicit paths[]/
        // targets[] task_pack call and the single-target handle+range zoom
        // continuation (tpZoomPaths) this same branch mints for — see
        // admitCallerRangedContinuation's own doc comment.
        const rangeAdmission = await admitCallerRangedContinuation(
          workspace,
          tpHasPaths ? args["paths"] : tpZoomPaths,
          args,
        );
        if (rangeAdmission !== undefined) return rangeAdmission;
        const result = await runWithTaskContractScope(taskContractScope, () => buildTaskPack(
          ({
            ...taskCredential,
            // DESIGN-v0.15-sf-intent-layers.md §4.1: see the sibling
            // promotion branch above.
            writeAllowed: ALLOW_WRITE,
            ...((args as Record<PropertyKey, unknown>)[QUERY_CANDIDATE_POLICY_INPUT] === true
              ? { queryCandidatePolicy: "unanchored" as const } : {}),
            // Internal-only execution identity; never projected to the wire.
            lane: normalizeContractLane(taskContractScope.lane),
            ...(taskBinding !== undefined ? { taskBinding } : {}),
            ...(typeof args["taskEpoch"] === "string" ? { taskEpoch: args["taskEpoch"] } : {}),
            // PI-09 close-out: the explicit "I lost my context" switch.
            ...(args["force_serve"] === true ? { forceServe: true as const } : {}),
            ...((args as Record<PropertyKey, unknown>)[SMALL_WINDOW_RESERVE_FORCE] === true ? { forceServeCallerTargetsOnly: true as const } : {}),
            query: taskPackQuery.query.length > 0 ? taskPackQuery.query : undefined,
            // C2: see the sibling promotion branch above.
            ...(taskPackQuery.fromRef === true ? { taskQueryRefReplay: true as const } : {}),
            ...(parseTaskProfile(args["taskProfile"]) ? { taskProfile: parseTaskProfile(args["taskProfile"]), ...(inheritedTaskProfileArgs.has(args) ? { taskProfileInherited: true as const } : {}) } : {}),
            ...(resolvedPath && tpZoomPaths === undefined ? { path: resolvedPath } : {}),
            ...(resolvedSymbol ? { symbol: resolvedSymbol } : {}),
            ...(tpLang ? { lang: tpLang } : {}),
            ...(typeof args["limit"] === "number" ? { limit: args["limit"] } : {}),
            ...(Array.isArray(args["surfaceRoles"]) ? { surfaceRoles: (args["surfaceRoles"] as unknown[]).map(String) } : {}),
            // A1: paths[] was advertised in the schema but silently dropped
            // here — an agent handing task_pack the exact correct files got
            // 0 of them back and escaped to native reads. Same shape-map as
            // mode=pack (below) so both entry points parse identically.
            // FIX (2026-07-09e forensics): a bare-string entry has no .path,
            // so the object-shaped mapping used to coerce it straight to
            // path:"" before buildTaskPack's own bare-string normalizer
            // (readCodeTaskPack.ts's normalizePathEntry) ever saw the
            // original string — mirror mode=full's paths[] coercion (~:6871)
            // so a bare string becomes {path: String(p)} instead. Factored
            // into mapTaskPackPaths (2026-07-10a) so the mode-unspecified/
            // "auto" promotion above shares the identical mapping.
            ...(tpHasPaths
              ? { paths: mapTaskPackPaths(args["paths"] as unknown[]) }
              : tpZoomPaths !== undefined
                ? { paths: tpZoomPaths }
                : {}),
            ...(typeof args["maxBytes"] === "number" ? { maxBytes: args["maxBytes"] } : {}),
            ...(typeof args["maxTokens"] === "number" ? { maxTokens: args["maxTokens"] } : {}),
            ...(defaultResponseByteCeiling !== undefined ? { clientDefaultByteCeilingHint: defaultResponseByteCeiling } : {}),
          }) as unknown as Parameters<typeof buildTaskPack>[0],
          workspace,
        ));
        // Feature 1 (2026-07-12b2): task_pack surfaces with embedded code count as read.
        recordTaskPackSurfaceReads(workspace, result);
        // V11-04 (TL_REASONING_IR_V2, class (B), default OFF): the ONE advisory
        // Task Reasoning IR v2 seam. It reads the finished pack BEFORE protocol
        // projection, persists IR state, and emits trace-only shadow Stop
        // candidates. It returns void and cannot touch `result`: with the flag
        // unset this branch is not entered, and with it set the helper is
        // try/catch-total, so an IR failure traces `reasoning_ir_error` and the
        // response bytes are unchanged either way. No wire field, no new kind.
        if (reasoningIrV2Enabled()) {
          recordReasoningIrV2FromPack({
            result,
            workspaceRoot: workspace,
            lane: sessionLaneOf(args as Record<string, unknown>),
            ...(taskPackQuery.query.length > 0 ? { query: taskPackQuery.query } : {}),
          });
        }
        // DESIGN-v0.9 §4.7: shared read-side post-processor (see the sibling
        // pack sites) — continuation/inlined normalization + FORBIDDEN_KEYS.
        const suppliedBase = attachSupply(result as unknown as Record<string, unknown>, workspace);
        // W2 (2026-07-30): see the sibling pathless-exploratory branch above —
        // re-issue on any non-empty resolved query (fresh OR qref-replay) so a
        // qref never reads as expired after a single use.
        const issuedRef = taskPackQuery.query.length > 0
          ? rememberTaskPackQuery(workspace, taskPackQuery.query, args)
          : undefined;
        const supplied = issuedRef !== undefined
          ? { ...suppliedBase, qref: issuedRef }
          : suppliedBase;
        recordTaskPackExecution(
          workspace,
          taskPackQuery.query,
          supplied,
          taskContractScope,
          taskPackQuery.taskBinding,
          result,
        );
        trace("task_pack_end", {
          elapsed_ms: Date.now() - taskPackStartedAt,
          bytes: Buffer.byteLength(JSON.stringify(supplied), "utf8"),
          coverage: result.coverage,
          surfaces: result.surfaces.length,
        }, workspace);
        return toolOk(attachServerBuildOnce(supplied, workspace));
      }
  return undefined;
}
