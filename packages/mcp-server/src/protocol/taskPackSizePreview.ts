import type {TaskExecutionContract} from "@tokenlighten/types";
import type {TaskPackResult} from "../features/task-pack/model.js";
import {deriveCanonicalTaskDecision} from "../features/task-pack/canonicalDecision.js";
import {projectEvidence, projectTaskDecision, projectTaskRef, packUnchangedPriorLabel} from "./decisionWire.js";
import {projectReadBody} from "./readFamily.js";
import {applySourceFidelity} from "./sourceFidelity.js";
import {isExactContiguousBody, preferExactAnswerBody} from "./answerBodyPolicy.js";
import {readWorkspaceFileSync} from "./lineGutter.js";
import {handleTable, type HandleEntry} from "../util/handles.js";
import {currentSessionLane} from "../util/laneKey.js";
import {omitConfiguredRootCwdOnNext, sizedCompactNext} from "./readCallContinuation.js";
import {readCallCompactionAvailable} from "../state/readCallContinuationStore.js";
import {measureResponseBytes} from "./budget/measure.js";
import {groupEvidencePaths} from "./evidencePathGroups.js";
import {protocolCallContext, runWithProtocolCall} from "./envelope.js";
import {semanticFrontierGuardEnabled, sfDemoteEnabled} from "../util/flags.js";
import {resolveReadReplyCeiling} from "./codec/clientProfile.js";

/**
 * Which `next` a size preview counts. "shipped": the calls the transport copy
 * ships (see `sizedCompactNext`) — what the client receives, and what the rows
 * a reply carries are budgeted against. "restated": the call as the pack builds
 * it and the model would have to send it were nothing compacted — the request
 * restated, every owed window listed. The restated size is what OPTIONAL content
 * of a discover (its `gaps`) is admitted against: compacting a `next` is a
 * transport optimization, and room that exists only because of it is room for
 * the reply's rows, not for advisory content.
 *
 * Both forms count every `tl_read_file` call the body publishes without the
 * workspace's `cwd` when that is the configured root (a path is no property of
 * the request): the very projection the transport applies to the reply
 * (`omitConfiguredRootCwdOnNext`), whatever shape the call has — a cursor, a
 * restated request, a `{qref, targets, cwd, task}` re-pack, a `limit.next` page,
 * a copy in a control container, an array of them. The form differs only in the
 * `next` of a discover pack that the transport replaces by a cursor call.
 *
 * "shipped" counts the cursor only where the transport can mint one
 * (`readCallCompactionAvailable`). Where it cannot (the state store is off, did
 * not open, or is read-only) the call ships as the pack built it, and that is the
 * call a reply is fitted to: a pack sized for a cursor that is never issued
 * overruns the budget by the request and the owed windows.
 */
export type PreviewNext = "shipped" | "restated";

/**
 * The body as the transport copy ships it, in the requested form: a discover
 * pack's `decision.next` that restates the request or lists its owed windows
 * becomes the cursor call that replaces it ("shipped" only, and only where a
 * cursor can be issued), in `decision` and in the exact copies `limit` holds; then
 * every read call still in the body loses the root `cwd`, as it does on the way
 * out. Without a published root (`undefined`) the `cwd` stays counted.
 */
function withNextForm(body: Record<string, unknown>, workspace: string, root: string | undefined, form: PreviewNext): Record<string, unknown> {
  let shipped = body;
  const decision = body["decision"];
  const discover = decision !== null && typeof decision === "object" && !Array.isArray(decision)
    && (decision as Record<string, unknown>)["kind"] === "discover";
  if (form === "shipped" && discover && readCallCompactionAvailable(workspace)) {
    const original = (decision as Record<string, unknown>)["next"];
    const resolve = (handle: string): HandleEntry | undefined => handleTable.get(handle);
    const replacement = sizedCompactNext(original, workspace, currentSessionLane(), root, resolve);
    if (replacement !== undefined) {
      const signature = JSON.stringify(original);
      const swap = (value: unknown): unknown => value !== null && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) =>
          [key, key === "next" && JSON.stringify(item) === signature ? replacement : item]))
        : value;
      shipped = {...body, decision: swap(decision), ...(body["limit"] !== undefined ? {limit: swap(body["limit"])} : {})};
    }
  }
  return root === undefined ? shipped : omitConfiguredRootCwdOnNext(workspace, root, shipped);
}

/** What `taskPackSizePreview` keeps in reserve beside a pack whose decision it already counts (a prepared pack: its contract is built). */
export const TASK_PACK_PREVIEW_PREPARED_RESERVE_BYTES = 512;
/** …and beside a pack whose decision is derived later (a discover pack): the task/call defaults and the decision the contract adds. */
export const TASK_PACK_PREVIEW_DISCOVER_RESERVE_BYTES = 2048;

/** Size eligible answer and bounded semantic-wiring packs with the wire projectors.
 * Construction-only contracts and routes do not consume response capacity.
 * This preview never books evidence, aliases, task state or write authority.
 */
export function taskPackSizePreview(result: TaskPackResult, clientId: string | undefined, next: PreviewNext = "shipped"): number | undefined {
  const semanticWiring = result.task_profile !== "answer" && result.wiring?.strategy === "semantic-multihop"
    && resolveReadReplyCeiling(clientId) !== undefined;
  if ((!semanticWiring && (result.task_profile !== "answer" || !preferExactAnswerBody(clientId)))
    || semanticFrontierGuardEnabled() || sfDemoteEnabled()) return undefined;
  const context = protocolCallContext();
  return runWithProtocolCall({...context, tool: context?.tool ?? "tl_read_file", clientId, sizePreview: true}, () => {
  const copy = JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
  const contract = copy["execution_contract"] as TaskExecutionContract | undefined;
  const prepared = contract?.typestate !== undefined;
  const evidence = projectEvidence(copy["surfaces"], packUnchangedPriorLabel(copy));
  const canonical = prepared ? deriveCanonicalTaskDecision(copy as unknown as TaskPackResult) : undefined;
  const decision = projectTaskDecision({result: copy, contract, canonicalKind: canonical?.kind, evidence});
  const task = {...projectTaskRef(copy, contract, "size-preview"), id: "x".repeat(192)};
  const projected = projectReadBody("read.task_pack", {...copy, task, profile: result.task_profile === "answer" ? "answer" : "generic", evidence,
    ...(decision !== undefined ? {decision} : {})});
  const first = result.surfaces.find(row => row.handle !== undefined);
  const workspace = context?.workspace ?? context?.codecTraceWorkspace
    ?? (first === undefined ? undefined : handleTable.get(first.handle)?.workspaceRoot);
  if (workspace === undefined || workspace === "") return undefined;
  const faithful = applySourceFidelity(projected, "read.task_pack", {readServeWorkspace: workspace});
  // Ambiguous answer bodies retain the old conservative accounting.
  const rows = faithful["evidence"];
  const sourceCache = new Map<string, string | undefined>();
  // Wiring's disjoint construction excerpts are already measured in their
  // final source-fidelity presentation. They do not receive an answer gutter,
  // so an intentionally assembled body need not be a contiguous answer slice.
  if (!Array.isArray(rows) || (!semanticWiring && rows.some(row => {
    if (row === null || typeof row !== "object") return true;
    const entry = row as Record<string, unknown>;
    if (typeof entry["body"] !== "string") return false;
    const span = typeof entry["range"] === "string" ? /^([0-9]+)-([0-9]+)$/.exec(entry["range"]) : null;
    const filePath = entry["path"];
    if (span === null || typeof filePath !== "string") return true;
    const bound = typeof entry["handle"] === "string" ? handleTable.get(entry["handle"]) : undefined;
    if (typeof entry["handle"] === "string"
      && (bound === undefined || bound.path !== filePath || bound.workspaceRoot !== workspace)) return true;
    if (!sourceCache.has(filePath)) sourceCache.set(filePath, readWorkspaceFileSync(filePath, workspace));
    const source = sourceCache.get(filePath);
    return source === undefined || !isExactContiguousBody(entry["body"], source, Number(span[1]), Number(span[2]));
  }))) return undefined;
  // Future task/call defaults and, before contract construction, its decision.
  // TL_EFF_EVIDENCE_PATH_GROUPS: the rows ship grouped (emit.ts), so they are
  // priced grouped; the proof loop above has already read each row whole, and
  // the call is the identity while the flag is off.
  const shipped = groupEvidencePaths({v: 1, kind: "read.task_pack", ...withNextForm(faithful, workspace, context?.configuredRoot, next)});
  return measureResponseBytes(JSON.stringify(shipped)) + (prepared ? TASK_PACK_PREVIEW_PREPARED_RESERVE_BYTES : TASK_PACK_PREVIEW_DISCOVER_RESERVE_BYTES);
  });
}
