// autofollow — extracted implementation; imports point to the owning modules.
import type { ReadCallReplayAuthorization } from "../protocol/readCallContinuation.js";
import type { ToolCallResult } from "../protocol/result.js";
import { ALL_TOOLS } from "./read-admission2.js";
import { activeRoot } from "../runtime/config.js";
import { applyHostCountedCodec } from "../protocol/codec/hostSelect.js";
import { asCanonicalObject } from "./canonical-input.js";
import { autofollowContinuations } from "./autofollow2.js";
import { autofollowSkipReason } from "./autofollow3.js";
import { callToolOnce } from "./call-trace.js";
import { canonicalTaskBindingForHandle } from "./task-binding2.js";
import { currentRequestSignal } from "../util/requestCancellation.js";
import { effAutofollowEnabled } from "../util/flags.js";
import { effFindPhraseEnabled } from "../util/flags.js";
import { effTolerantInputEnabled } from "../util/flags.js";
import { expandTaskAliasArguments } from "../state/taskHandleAliases.js";
import { expandTaskHandle } from "../state/taskHandleAliases.js";
import { finalizeSourceCapsules } from "../features/task-pack/sourceCapsuleCallScope.js";
import { findPhraseTokens } from "./autofollow2.js";
import { finishReadCallBatchMember } from "../state/readCallBatchGroup.js";
import { groupEvidencePaths } from "../protocol/evidencePathGroups.js";
import { handleTable } from "../util/handles.js";
import { hostCounterActive } from "../protocol/codec/hostSelect.js";
import { isCurrentSingleEditHandle } from "../state/editTaskInputRepair.js";
import { laneScopedKey } from "../util/laneKey.js";
import { mergeAutofollowReplies } from "./autofollow3.js";
import { noteCompactionMarker } from "../state/compactionEpoch.js";
import { noteToolCallStarted } from "../util/startupWarmup.js";
import { omitConfiguredRootCwdOnNext } from "../protocol/readCallContinuation.js";
import { parseWireObject } from "./autofollow2.js";
import { parseWireObjectWithRows } from "./autofollow2.js";
import { projectAuthenticatedReadBatchReplay } from "../protocol/readCallContinuation.js";
import { projectReadCallContinuations } from "../protocol/readCallContinuation.js";
import { projectReadCallCursorAliasesOnNext } from "../protocol/readCallContinuation.js";
import { projectReadOnlyBatchContinuations } from "../protocol/readOnlyBatchContinuation.js";
import { projectTaskAliasBody } from "../state/taskHandleAliases.js";
import { readContinuationSource } from "./task-binding.js";
import { readonlyAnswerBatchPlan } from "../features/task-pack/engine/facetClosure.js";
import { repairEditTaskIdEcho } from "../state/editTaskInputRepair.js";
import { resolveClientProfile } from "../protocol/codec/clientProfile.js";
import { resolveDefaultResponseByteCeiling } from "../protocol/codec/clientProfile.js";
import { resolveReadCallCursorAlias } from "../state/readCallCursorAliases.js";
import { resolveWorkspaceRoot } from "./read-admission2.js";
import { resolvedClientId } from "../runtime/config.js";
import { reuseReadCallBatchSiblingNext } from "../state/readCallBatchGroup.js";
import { runWithCallWorkspace } from "../util/handles.js";
import { runWithSessionLane } from "../state/session.js";
import { runWithSourceCapsuleCall } from "../features/task-pack/sourceCapsuleCallScope.js";
import { sessionLaneOf } from "./task-binding2.js";
import { sourceCapsulePrior } from "../features/task-pack/sourceCapsuleCallScope.js";
import { taskHandleRecoveryEnabled } from "../util/flags.js";
import { unknownToolMessage } from "./dispatch-funnel.js";
import { withReadCallBatchQueue } from "../state/readCallBatchGroup.js";
import { withReadCallDispatch } from "../state/readCallDispatch.js";

export async function callTool(
  name: string,
  args: Record<string, unknown>,
  requestMeta?: Record<string, unknown>,
) {
  // r5 review (2026-10-03): both transports refuse an unknown name before they
  // get here; an in-process caller used to reach `advertisedPropertiesFor`'s
  // non-null lookup and die with a TypeError instead of the same "Tool not
  // found" (with the replacement for a pre-`tl_` name) the transports send.
  if (!ALL_TOOLS.some((tool) => tool.name === name)) throw new Error(unknownToolMessage("Tool not found", name));
  // The startup warm-up (util/startupWarmup.ts) runs no further step once a
  // call has begun: from here the call's own first use takes over.
  noteToolCallStarted();
  let continuationWorkspace: string | undefined;
  try { continuationWorkspace = resolveWorkspaceRoot(typeof args["cwd"] === "string" ? args["cwd"] : undefined, activeRoot); }
  catch { /* normal dispatch owns invalid workspace diagnostics */ }
  noteCompactionMarker(continuationWorkspace); // 2026-11-03: one stat; a host compaction drops the "already served" claims (state/compactionEpoch.ts).
  let batchCursor = name === "tl_read_file" && typeof args["cursor"] === "string" ? args["cursor"] : undefined;
  const initialLane = sessionLaneOf(args);
  if (continuationWorkspace !== undefined && batchCursor !== undefined && batchCursor.startsWith("tlc_s1_")) {
    const expanded = resolveReadCallCursorAlias({workspaceRoot: continuationWorkspace, lane: initialLane, cursor: batchCursor});
    if (expanded.kind === "canonical") {
      batchCursor = expanded.cursor;
      args = {...args, cursor: expanded.cursor};
    }
  }
  const initialTask = asCanonicalObject(args["task"]);
  const batchCandidate = name === "tl_read_file" && batchCursor === undefined
    && initialTask?.["epoch"] === "new" && initialTask["expected_state_version"] === undefined
    && initialTask["force_serve"] !== true && args["budget"] === undefined
    && resolvedClientId()?.toLowerCase() === "copilot-cli";
  return runWithSourceCapsuleCall(() => withReadCallBatchQueue(continuationWorkspace, initialLane, batchCursor, () =>
    withReadCallDispatch(continuationWorkspace, initialLane, async (dispatch) => {
  let restoredReplayAuthorization: ReadCallReplayAuthorization | undefined;
  const run = async (): Promise<ToolCallResult> => {
  // Keep canonical tokens inside authentication, operation replay and ledgers.
  // Compact only the Copilot transport copy, after every normal postprocessor.
  let aliasWorkspace: string | undefined;
  if (resolvedClientId()?.toLowerCase() === "copilot-cli" && taskHandleRecoveryEnabled()) {
    try {
      aliasWorkspace = resolveWorkspaceRoot(typeof args["cwd"] === "string" ? args["cwd"] : undefined, activeRoot);
      if (name === "tl_edit_file") {
        const lane = sessionLaneOf(args);
        args = await repairEditTaskIdEcho(args, aliasWorkspace, lane, (handle, candidate, workspace, candidateLane) =>
          isCurrentSingleEditHandle(candidate, handle, workspace, candidateLane, id => handleTable.get(id)));
      }
      args = expandTaskAliasArguments(aliasWorkspace, sessionLaneOf(args), args);
    } catch { /* normal cwd validation below owns invalid roots */ }
  }
  const project = async (reply: ToolCallResult): Promise<ToolCallResult> => {
    if (reply.content.length !== 1) return reply;
    const body = parseWireObject(reply.content[0]!.text);
    if (body === undefined) return reply;
    let projected = body;
    if (name === "tl_read_file" && reply.isError !== true) {
      try {
        const workspace = resolveWorkspaceRoot(typeof args["cwd"] === "string" ? args["cwd"] : undefined, activeRoot);
        const lane = sessionLaneOf(args);
        projected = await runWithCallWorkspace(workspace, () => runWithSessionLane(lane, async () => {
          // Reuse an already issued sibling before ordinary compaction can
          // mint a third plan. The batch ALS lease and exact window union are
          // checked read-only; fallback retains the normal producer unchanged.
          const sibling = reuseReadCallBatchSiblingNext({workspace, lane, cursor: batchCursor,
            dispatch, body, resolve: handle => handleTable.get(handle)});
          if (sibling !== undefined) return projectReadCallCursorAliasesOnNext(workspace, lane, sibling);
          let candidate = body;
          if (restoredReplayAuthorization !== undefined && body["kind"] === "read.batch") {
            const replayTaskBinding = canonicalTaskBindingForHandle(workspace, restoredReplayAuthorization.taskHandle);
            candidate = projectAuthenticatedReadBatchReplay(body, restoredReplayAuthorization,
              sourceCapsulePrior(laneScopedKey(workspace)), replayTaskBinding, workspace, lane,
              handle => handleTable.get(handle));
          }
          const call = asCanonicalObject(asCanonicalObject(body["decision"])?.["next"]);
          const query = asCanonicalObject(call?.["arguments"])?.["query"];
          if (batchCandidate && dispatch && typeof query === "string" && body["profile"] === "answer") {
            const plan = readonlyAnswerBatchPlan(workspace,query);
            if (plan) candidate = await projectReadOnlyBatchContinuations({workspace,lane,body,dispatch,plan,
              read:file=>readContinuationSource(file,workspace)});
          }
          return projectReadCallContinuations(workspace, lane, candidate,
            file => readContinuationSource(file, workspace), handle => handleTable.get(handle), dispatch);
        }));
      } catch { /* preserve the expanded executable next on any compaction failure */ }
    }
    if (aliasWorkspace !== undefined) projected = projectTaskAliasBody(aliasWorkspace, sessionLaneOf(args), projected);
    if (name === "tl_read_file" && reply.isError !== true) {
      // Ingress already resolves an omitted cwd to the configured root: no read next the reply publishes under it needs to copy
      // the path, whatever its shape (a cursor, the request restated, a qref re-pack over its targets, a limit.next page). Last,
      // because the task alias above compacts the handle of the calls that name this workspace by their cwd. The size preview
      // counts these very calls through the same function (taskPackSizePreview.ts).
      try {
        const workspace = resolveWorkspaceRoot(typeof args["cwd"] === "string" ? args["cwd"] : undefined, activeRoot);
        projected = omitConfiguredRootCwdOnNext(workspace, resolveWorkspaceRoot(undefined, activeRoot), projected);
      } catch { /* the nexts keep their cwd */ }
    }
    return projected === body ? reply : { ...reply, content: [{ ...reply.content[0]!, text: JSON.stringify(projected) }] };
  };
  let restoredReadInput: Record<string, unknown> | undefined;
  const result = await callToolOnce(name, args, requestMeta, dispatch, (input, replayAuthorization) => {
    restoredReadInput = input;
    restoredReplayAuthorization = replayAuthorization;
  });
  if (name === "tl_search_files" && effFindPhraseEnabled()) {
    return project((await findPhraseTokens(result, args, requestMeta)) ?? result);
  }
  if (name !== "tl_read_file") return project(result);
  // Only a first claim that runs the stored call restores a query or a qref, and its
  // normal bounded autofollow. Fixed-range recovery (which drops both) and ordinary
  // raw cursors never advance a semantic plan.
  if (typeof args["cursor"] === "string") {
    if (restoredReadInput?.["query"] === undefined && restoredReadInput?.["qref"] === undefined) return project(result);
    args = restoredReadInput;
  }
  if (effTolerantInputEnabled()) {
    const tree = await directoryReadAsTree(result, args, requestMeta);
    if (tree !== undefined) return project(tree);
  }
  if (effAutofollowEnabled()) return project(await autofollowDiscoverPack(result, args, requestMeta));
  return project(result);
  };
  try {
    const reply = await run();
    if (!currentRequestSignal()?.aborted && reply.isError !== true
      && continuationWorkspace !== undefined && reply.content.length === 1) {
      const workspace = continuationWorkspace;
      runWithSessionLane(initialLane, () => finalizeSourceCapsules(
        laneScopedKey(workspace), reply.content[0]!.text,
        handle => canonicalTaskBindingForHandle(workspace,
          expandTaskHandle(workspace, initialLane, handle) ?? handle),
      ));
    }
    const finalBody = reply.content.length === 1 ? parseWireObject(reply.content[0]!.text) : undefined;
    const finalDecision = asCanonicalObject(finalBody?.["decision"])?.["kind"];
    finishReadCallBatchMember(continuationWorkspace,initialLane,batchCursor,dispatch,
      reply.isError !== true && finalBody?.["kind"] === "read.task_pack" && finalBody["profile"] === "answer"
      && (finalDecision === "discover" || finalDecision === "act.answer"));
    // B6: the one asynchronous stage after the funnel. It re-spells a settled reply, so
    // nothing above can see the difference, and any failure sends it as it stood.
    if (hostCounterActive() && reply.isError !== true && reply.content.length === 1) {
      const spelled = await applyHostCountedCodec(reply.content[0]!.text, resolvedClientId(), continuationWorkspace, {
        ...(currentRequestSignal() !== undefined ? { signal: currentRequestSignal()! } : {}),
      });
      if (spelled !== reply.content[0]!.text) return { ...reply, content: [{ ...reply.content[0]!, text: spelled }] };
    }
    return reply;
  } catch (error) {
    finishReadCallBatchMember(continuationWorkspace,initialLane,batchCursor,dispatch,false);
    throw error;
  }
  })));
}

/**
 * EFF (TL_EFF_TOLERANT_INPUT, default OFF). A tl_read_file of one directory path
 * is refused `is-a-directory`, and the recorded h2 solver's next call was the
 * `tl_search_files tree` of that same path. Under the flag that tree runs here
 * as a complete tl_search_files call and replaces the refusal, with a
 * `normalized` note naming the substitution.
 */
export async function directoryReadAsTree(
  refused: ToolCallResult,
  args: Record<string, unknown>,
  requestMeta?: Record<string, unknown>,
): Promise<ToolCallResult | undefined> {
  if (refused.isError !== true || refused.content.length !== 1) return undefined;
  if (parseWireObject(refused.content[0]!.text)?.["code"] !== "is-a-directory") return undefined;
  const targets = args["targets"];
  const only = Array.isArray(targets) && targets.length === 1 ? asCanonicalObject(targets[0]) : undefined;
  const path = only?.["path"];
  if (typeof path !== "string" || path.length === 0) return undefined;
  const treeArgs: Record<string, unknown> = { action: "tree", scope: { path } };
  for (const key of ["cwd", "lane"]) if (args[key] !== undefined) treeArgs[key] = args[key];
  const tree = await callToolOnce("tl_search_files", treeArgs, requestMeta);
  if (tree.isError === true || tree.content.length !== 1) return undefined;
  const body = parseWireObject(tree.content[0]!.text);
  if (body === undefined) return undefined;
  const normalized = `tl_read_file on directory "${path}" served as tl_search_files tree`;
  return { ...tree, content: [{ type: "text", text: JSON.stringify({ ...body, normalized }) }] };
}

/**
 * EFF (TL_EFF_AUTOFOLLOW, default ON since 2026-10-19; explicit `0` restores
 * the discover reply, see util/flags.ts). A `discover` task pack whose ONE
 * `next` re-issues the caller's own request — the T03 shape — is followed
 * here as a SECOND COMPLETE CALL through
 * callToolOnce (its own normalization, executed-next record, served-range
 * settlement and trace), and the client gets one reply holding both. Measured
 * on the v0.16.0 decision runs 6t-2 and 6t-3: every T03 rep sent the first
 * pack and then exactly its `next`, one model turn per cell; the merged
 * `act.answer` is smaller than the two packs together.
 *
 * WHICH PACKS (`autofollowSkipReason`, 2026-10-19). Only a discover whose one
 * executable tl_read_file `next` carries the caller's own `query` as the pack
 * builder read it (`packBuilderQuery`), in the same epoch, on a pack with no
 * `plan`; never one whose gaps include `ambiguous-target`. The first version
 * also followed plain targets/qref reads and candidate bundles, nexts the
 * v0.16.0 solvers ran 0 of 7 times (and the efficiency A/B 4 of 27), and a
 * pick among candidates (6t-2 T13 rep0 #9: +7.9 KB for a `next` the solver
 * did not take).
 *
 * NO BOOKED-BUT-UNDELIVERED BYTES (`mergeAutofollowReplies`, 2026-10-19). The
 * follow-up's own funnel exit books every byte ITS payload carried, so this
 * function may only drop that payload when it carried none (a refusal or a
 * receipt). The first version returned the discover reply unchanged whenever
 * the follow-up was not a task pack, or the two plans disagreed: the
 * follow-up's read stayed booked, and the discover's own `next`, run by the
 * client, was answered `code-unchanged` for bytes it never had (HEAD:
 * 6t-3 T10 rep2 #6 -> #8, 157 B for 5,843 B; and T09 rep1 #3,
 * rc/autofollowDiscover.rc.spec.ts). Now a task-pack follow-up merges as
 * before (no plan on the discover side, so the plans cannot disagree), a
 * follow-up answered as a plain read rides as rows after the discover pack's
 * own, and only a follow-up that served nothing leaves the discover reply as
 * it was.
 *
 * NEVER UNDER A BYTE CEILING (2026-10-19, with the default flip). A pack built
 * under a byte ceiling — the request's own `budget`, or the default one
 * (TOKENLIGHTEN_TASK_PACK_MAX_BYTES, or the client profile's: VS Code's
 * 14,336 B) — is not followed: each pack fits the ceiling, the two together
 * need not (evaluation0929.ceilingFallbackHonesty.spec.ts measured 17,421 B
 * and 21,135 B first replies under a 14,336 B budget).
 *
 * THE DISCOVER PACK'S GAPS RIDE ALONG (same day). A task-pack follow-up's
 * decision replaces the discover's, and an `act.*` decision has no `gaps`
 * member, so the merge dropped what the discover pack had disclosed: a chain
 * that showed `missing-evidence` before it closed reached the client as one
 * silent `act.answer` (requestItemCompletion.spec.ts, finding 2's fixture).
 * The discover pack's own `decision.gaps` now ride `auto_followed.gaps`.
 *
 * THE SAME TASK'S WINDOW READS CHAIN, UNDER A CAP (2026-10-19, after decision
 * run 6t-6). A follow-up that is itself a discover pack whose one `next`
 * reads more windows of the files it serves, under the same task and the
 * request's own query, is followed again (`autofollowContinuations`). Every
 * 6t-6 T03 cell ran exactly that chain by hand, one model turn per reply,
 * each turn re-reading the whole context: the merged reply (21,678 B, its
 * next OrderOrchestrator.java 471-823), that next (33,398 B, itself merged
 * with its own next, 825-1198), then that one's next (the act.answer). The
 * first follow-up stays as it was; a later one runs only while an
 * upper-bound estimate of the reply, taken BEFORE the read, stays within
 * AUTOFOLLOW_CHAIN_REPLY_CAP_BYTES, since a read that ran is booked and so is
 * delivered whatever its size. Replayed on that first call: one reply of
 * 37,201 B (`auto_followed.hops` 2, OrderOrchestrator.java through line 823;
 * the estimate for its second follow-up was 42,933 B, and for a third,
 * 825-1198, 59,899 B), whose next is the act.answer (28,239 B).
 */
export async function autofollowDiscoverPack(
  first: ToolCallResult,
  requestArgs: Record<string, unknown>,
  requestMeta?: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (first.isError === true || first.content.length !== 1) return first;
  const firstPack = parseWireObjectWithRows(first.content[0]!.text);
  // The same default ceiling dispatchTool resolved for the pack just built.
  const defaultByteCeiling = resolveDefaultResponseByteCeiling(
    resolveClientProfile(resolvedClientId()),
    process.env["TOKENLIGHTEN_TASK_PACK_MAX_BYTES"],
  );
  if (firstPack === undefined || autofollowSkipReason(firstPack, requestArgs, defaultByteCeiling) !== undefined) return first;
  const decision = firstPack["decision"] as Record<string, unknown>;
  const repack = (decision["next"] as Record<string, unknown>)["arguments"] as Record<string, unknown>;
  const second = await callToolOnce("tl_read_file", repack, requestMeta);
  // A refusal's payload carries no bytes, so its funnel exit booked none.
  if (second.isError === true) return first;
  const secondBody = second.content.length === 1 ? parseWireObjectWithRows(second.content[0]!.text) : undefined;
  if (secondBody === undefined) {
    // Not one JSON object (unreachable for a client whose discover reply just
    // parsed as one): both replies go out as they are, never one dropped.
    return { ...first, content: [...first.content, ...second.content] };
  }
  const merged = mergeAutofollowReplies(firstPack, secondBody);
  if (merged === undefined) return first;
  if (secondBody["kind"] !== "read.task_pack") return { ...first, content: [{ type: "text", text: JSON.stringify(groupEvidencePaths(merged)) }] };
  return autofollowContinuations(second, merged, requestArgs, requestMeta, defaultByteCeiling);
}
