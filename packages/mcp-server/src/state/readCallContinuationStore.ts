import { createHash, randomUUID } from "node:crypto";
import { accessSync, constants as fsConstants } from "node:fs";
import * as path from "node:path";
import type { ReadCallContinuationState, ReadCallExecutionClaim, ReadCallDispatchBinding } from "@tokenlighten/types";
import { validateHandleToken, workspaceRefOf } from "./handleCodec.js";
import { FETCH_REQUEST_HANDLE_TTL_MS, fetchRequestPayloadRef, mintFetchRequestHandle, resolveFetchRequestHandle, resolveTaskHandle } from "./stateHandles.js";
import { stateStoreFor } from "./stateStore.js";
import { isReadCallDispatchCurrent } from "./readCallDispatch.js";

const MAX_INPUT_BYTES = 64 * 1024;
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function validSources(value: unknown): value is ReadCallContinuationState["source_bindings"] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) return false;
  const paths = new Set<string>();
  for (const item of value) {
    const row = object(item);
    if (!row || typeof row["path"] !== "string" || typeof row["sha"] !== "string"
      || !/^sha256:[0-9a-f]{64}$/.test(row["sha"])) return false;
    const file = row["path"];
    if (!file || file.includes("\0") || file.includes("\\") || file.includes(":")
      || path.posix.isAbsolute(file) || path.posix.normalize(file) !== file || file.split("/").includes("..")
      || paths.has(file)) return false;
    paths.add(file);
  }
  return true;
}

/** A plan restores one semantic request: a query, or the qref of the pack it re-packs. Never both, never neither. */
function namesOneRequest(input: Record<string, unknown>): boolean {
  const named = (value: unknown): boolean => typeof value === "string" && value.trim().length > 0;
  return named(input["query"]) ? input["qref"] === undefined : named(input["qref"]) && input["query"] === undefined;
}

function validInput(value: unknown, taskHandle: string): value is Record<string, unknown> {
  const input = object(value), task = object(input?.["task"]);
  return !!input && !["cwd", "lane", "cursor"].some(k => Object.hasOwn(input, k))
    && namesOneRequest(input)
    && Array.isArray(input["targets"]) && input["targets"].length > 0 && input["targets"].length <= 64
    && task?.["handle"] === taskHandle && task["epoch"] === undefined
    && Buffer.byteLength(JSON.stringify(input), "utf8") <= MAX_INPUT_BYTES;
}

function validDispatch(value: unknown): value is ReadCallDispatchBinding {
  const row = object(value);
  return !!row && typeof row["nonce"] === "string" && row["nonce"].length > 0 && row["nonce"].length <= 80
    && Number.isSafeInteger(row["generation"]) && Number(row["generation"]) >= 1;
}

function readState(data: Record<string, unknown>): ReadCallContinuationState | undefined {
  if (data["v"] !== 1 || data["family"] !== "read-call" || typeof data["id"] !== "string"
    || typeof data["workspace_ref"] !== "string" || typeof data["lane"] !== "string"
    || typeof data["task_handle"] !== "string" || typeof data["task_fingerprint"] !== "string"
    || !data["task_fingerprint"] || typeof data["input_fingerprint"] !== "string"
    || !Number.isSafeInteger(data["created_at_ms"]) || !Number.isSafeInteger(data["expires_at_ms"])
    || Number(data["expires_at_ms"]) <= Number(data["created_at_ms"])
    || Number(data["expires_at_ms"]) - Number(data["created_at_ms"]) > FETCH_REQUEST_HANDLE_TTL_MS
    || (data["response_profile"] !== undefined && data["response_profile"] !== "answer" && data["response_profile"] !== "generic")
    || (data["batch_group"] !== undefined && (typeof data["batch_group"] !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(data["batch_group"])))
    || (data["batch_group"] !== undefined && (data["response_profile"] !== "answer" || !validSources(data["batch_source_bindings"])))
    || (data["batch_source_bindings"] !== undefined && data["batch_group"] === undefined)
    || !validDispatch(data["dispatch_binding"]) || !validSources(data["source_bindings"]) || !validInput(data["original_input"], data["task_handle"])) return undefined;
  const state = data as unknown as ReadCallContinuationState;
  return digest(state.original_input) === state.input_fingerprint ? state : undefined;
}

/**
 * Whether a plan minted for `workspaceRoot` can be persisted at all: the state
 * store is not switched off, it opened, and its directory accepts a writer.
 * `mintReadCallContinuation` publishes nothing otherwise and the transport keeps
 * the `next` the pack built, so a size preview that counts the compact cursor
 * for such a workspace counts a call that never ships (a reply that outgrows the
 * budget it was fitted to, by the whole request and the path of the workspace).
 *
 * Decided WITHOUT writing: a state directory that exists but is read-only opens
 * (its meta file loads) and fails only when the first writer takes its lock, so
 * the permission is read here. An elevated process passes both checks, exactly
 * as it passes the lock. Other mint conditions (a concurrent call on the lane,
 * a task handle that no longer resolves) are decided at the transport and
 * cannot be known while the pack is built.
 */
export function readCallCompactionAvailable(workspaceRoot: string): boolean {
  try {
    const store = stateStoreFor(workspaceRoot);
    if (!store?.available) return false;
    accessSync(store.dir, fsConstants.W_OK);
    return true;
  } catch { return false; }
}

export function mintReadCallContinuation(input: {
  workspaceRoot: string; lane: string; taskHandle: string;
  dispatchBinding: ReadCallDispatchBinding;
  originalInput: Record<string, unknown>; sources: Array<{path: string; sha: string}>;
  responseProfile?: "answer" | "generic";
  batchGroup?: string;
  batchSources?: Array<{path: string;sha: string}>;
}): string | undefined {
  try {
    const store = stateStoreFor(input.workspaceRoot);
    if (!store?.available) return undefined;
    const parent = resolveTaskHandle(input.taskHandle, input.workspaceRoot);
    const validation = validateHandleToken({token: input.taskHandle, expectedPurpose: "task", workspaceRoot: input.workspaceRoot});
    if (!parent.ok || !validation.ok || !validInput(input.originalInput, input.taskHandle) || !validSources(input.sources) || !validDispatch(input.dispatchBinding)) return undefined;
    if (input.batchGroup !== undefined && (input.responseProfile !== "answer" || !validSources(input.batchSources)
      || object(input.originalInput["task"])?.["expected_state_version"] !== undefined)) return undefined;
    const now = Date.now(), expires = Math.min(now + FETCH_REQUEST_HANDLE_TTL_MS, validation.decoded.expiresAtMs);
    if (expires <= now) return undefined;
    const original = clone(input.originalInput);
    const state: ReadCallContinuationState = {
      v: 1, family: "read-call", id: randomUUID(), workspace_ref: workspaceRefOf(input.workspaceRoot),
      lane: input.lane, task_handle: input.taskHandle, task_fingerprint: parent.state.taskFingerprint,
      original_input: original, input_fingerprint: digest(original), dispatch_binding: clone(input.dispatchBinding), source_bindings: clone(input.sources),
      ...(input.responseProfile !== undefined ? {response_profile: input.responseProfile} : {}),
      ...(input.batchGroup !== undefined ? {batch_group: input.batchGroup} : {}),
      ...(input.batchSources !== undefined ? {batch_source_bindings: clone(input.batchSources)} : {}),
      created_at_ms: now, expires_at_ms: expires,
    };
    if (!isReadCallDispatchCurrent(input.workspaceRoot, input.lane, input.dispatchBinding)) return undefined;
    const ref = fetchRequestPayloadRef("read-call:" + state.id);
    // Publish a pending execution marker before exposing the immutable plan.
    // Losing either record later must fail closed, never create a fresh first use.
    const marker: ReadCallExecutionClaim = {v: 1, family: "read-call-execution", digest: digest(state), status: "pending"};
    const marked = store.put({key: readCallExecutionKey(state), purpose: "read-request",
      data: marker as unknown as Record<string, unknown>, ttlMs: expires - now, expectedVersion: 0});
    if (!marked.ok) return undefined;
    const put = store.put({key: ref.toString("base64url"), purpose: "read-request",
      data: state as unknown as Record<string, unknown>, ttlMs: expires - now, expectedVersion: 0});
    if (!put.ok) return undefined;
    return mintFetchRequestHandle({workspaceRoot: input.workspaceRoot, purpose: "read-request",
      payloadRef: ref, stateVersion: 1, bindingDigest: digest(state)});
  } catch { return undefined; }
}

export type ReadCallContinuationResolution =
  | {kind: "other"}
  | {kind: "refusal"; detail: string}
  | {kind: "read-call"; state: ReadCallContinuationState; input: Record<string, unknown>};

/** No writes, no advancing pointer, and no served-range accounting. */
export function resolveReadCallContinuation(input: {
  workspaceRoot: string; lane: string; taskHandle?: string; cursor: string;
}): ReadCallContinuationResolution {
  try {
    const resolved = resolveFetchRequestHandle(input.cursor, input.workspaceRoot, "read-request");
    if (!resolved.ok) return {kind: "other"}; // ordinary cursor handler owns its error ladder
    if (resolved.record.data["family"] !== "read-call") return {kind: "other"};
    const refuse = (detail: string): ReadCallContinuationResolution => ({kind: "refusal", detail});
    const state = readState(resolved.record.data);
    if (!state || resolved.record.version !== 1 || resolved.stateVersion !== 1) return refuse("stored read-call plan is invalid or was rewritten");
    const validation = validateHandleToken({token: input.cursor, expectedPurpose: "read-request", workspaceRoot: input.workspaceRoot});
    if (!validation.ok || validation.aad.toString("utf8") !== digest(state)) return refuse("read-call plan does not match its authenticated binding");
    if (Date.now() >= state.expires_at_ms) return refuse("read-call plan expired; restart the original request");
    if ((Object.hasOwn(input, "taskHandle") && (typeof input.taskHandle !== "string" || input.taskHandle.length === 0))
      || state.workspace_ref !== workspaceRefOf(input.workspaceRoot) || state.lane !== input.lane
      || (input.taskHandle !== undefined && state.task_handle !== input.taskHandle)) {
      return refuse("read-call plan belongs to another workspace, lane or task");
    }
    const parent = resolveTaskHandle(state.task_handle, input.workspaceRoot);
    if (!parent.ok || parent.state.taskFingerprint !== state.task_fingerprint) return refuse("parent task is no longer available");
    const copy = clone(state);
    return {kind: "read-call", state: copy, input: clone(copy.original_input)};
  } catch { return {kind: "refusal", detail: "read-call plan could not be validated; restart the original request"}; }
}

/** A missing/evicted marker never grants another semantic execution. */
export function readCallExecutionKey(state: ReadCallContinuationState): string {
  return fetchRequestPayloadRef("read-call-execution:" + state.id + ":" + state.input_fingerprint).toString("base64url");
}

export function claimReadCallContinuation(workspace: string, state: ReadCallContinuationState): boolean | undefined {
  try {
    const store = stateStoreFor(workspace);
    if (!store?.available) return undefined;
    const key = readCallExecutionKey(state), binding = digest(state);
    const inspect = () => {
      const record = store.get(key);
      if (!record || record.purpose !== "read-request" || record.data["v"] !== 1
        || record.data["family"] !== "read-call-execution" || record.data["digest"] !== binding) return undefined;
      if (record.version === 1 && record.data["status"] === "pending") return {record, pending: true};
      if (record.version === 2 && record.data["status"] === "claimed") return {record, pending: false};
      return undefined;
    };
    const marker = inspect();
    if (!marker) return undefined;
    if (!marker.pending) return false;
    const ttlMs = state.expires_at_ms - Date.now();
    if (ttlMs <= 0) return undefined;
    const data: ReadCallExecutionClaim = {v: 1, family: "read-call-execution", digest: binding, status: "claimed"};
    const put = store.put({key, purpose: "read-request", data: data as unknown as Record<string, unknown>,
      ttlMs, expectedVersion: marker.record.version});
    if (put.ok) return true;
    return inspect()?.pending === false ? false : undefined;
  } catch { return undefined; }
}
