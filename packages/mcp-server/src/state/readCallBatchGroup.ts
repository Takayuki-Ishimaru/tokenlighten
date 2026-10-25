import {AsyncLocalStorage} from "node:async_hooks";
import {createHash} from "node:crypto";
import * as path from "node:path";
import type {LineWindow, ReadCallDispatchBinding} from "@tokenlighten/types";
import {readCallExecutionKey, resolveReadCallContinuation} from "./readCallContinuationStore.js";
import {resolveTaskHandle} from "./stateHandles.js";
import {isReadCallDispatchCurrent, takeReadCallSemanticLease} from "./readCallDispatch.js";
import {observeReadCallTaskMutations} from "./readCallTaskMutation.js";
import {parseWindow, normalizeWindows, subtractWindows} from "./readRequestStore.js";
import {stateStoreFor} from "./stateStore.js";
import type {HandleEntry} from "../util/handles.js";

// Integration contract:
// * Persist ReadCallContinuationState.batch_group?: string in its authenticated
//   digest BEFORE publishing any member. Marked cursors MUST NEVER use the
//   ordinary immediate semantic lease, including after reset/expiry/eviction.
// * Queue outside withReadCallDispatch. Hydration still authenticates inputs,
//   validates all source bindings, and durably claims the cursor first.
// * Invoke take only after firstClaim === true, sameBudget, !force_serve and
//   absence of explicit caller/original CAS. No caller argument is rewritten.
// * finish runs INSIDE the dispatch callback, after the entire projected final
//   reply, before dispatch.finish(). success excludes refusals/opaque/errors.
// * validate is synchronous, read-only, and checks the complete original plan
//   identity AND ALL bound source SHAs, not merely this member's targets.
type Entry = {
  id: string; workspace: string; lane: string; taskHandle: string;
  fingerprint: string; parentVersion: number; owner: ReadCallDispatchBinding;
  expiresAtMs: number; cursors: readonly string[]; used: Set<string>;
  validate: () => boolean; tainted: boolean; pending: number; tail: Promise<void>;
};
type Turn = {
  group: Entry; cursor: string; finished: boolean;
  leased?: ReadCallDispatchBinding;
  ownedVersion?: number;
  mutationLost?: boolean;
};
const groups = new Map<string, Entry>();
const cursors = new Map<string, Entry>();
const turn = new AsyncLocalStorage<Turn>();
const MAX_GROUPS = 128, MAX_MEMBERS = 4, MAX_PENDING = 16;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const cursorKey = (workspace: string, lane: string, cursor: string) =>
  JSON.stringify([workspace, lane, cursor]);
const sameBinding = (a: ReadCallDispatchBinding, b: ReadCallDispatchBinding) =>
  a.nonce === b.nonce && a.generation === b.generation;
const active = (g: Entry) => groups.get(g.id) === g && !g.tainted && Date.now() < g.expiresAtMs;
function validated(g: Entry): boolean {
  if (!active(g)) return false;
  try { return g.validate() === true; } catch { return false; }
}
function forget(g: Entry): void {
  groups.delete(g.id);
  for (const cursor of g.cursors) {
    const key = cursorKey(g.workspace, g.lane, cursor);
    if (cursors.get(key) === g) cursors.delete(key);
  }
}
function prune(): void {
  for (const g of groups.values()) if (g.pending === 0
    && (g.tainted || Date.now() >= g.expiresAtMs || g.used.size === g.cursors.length)) forget(g);
}
function memberState(g: Entry, cursor: string) {
  const r = resolveReadCallContinuation({
    workspaceRoot: g.workspace, lane: g.lane, taskHandle: g.taskHandle, cursor,
  });
  if (r.kind !== "read-call" || r.state.batch_group !== g.id
    || r.state.task_fingerprint !== g.fingerprint) return undefined;
  return r;
}

export function registerReadCallBatchGroup(input: {
  id: string; workspace: string; lane: string; taskHandle: string;
  cursors: readonly string[]; dispatchBinding: ReadCallDispatchBinding;
  validate: () => boolean; expiresAtMs: number;
}): boolean {
  prune();
  if (!UUID.test(input.id) || groups.has(input.id) || groups.size >= MAX_GROUPS
    || input.cursors.length < 2 || input.cursors.length > MAX_MEMBERS
    || new Set(input.cursors).size !== input.cursors.length
    || !Number.isSafeInteger(input.expiresAtMs) || input.expiresAtMs <= Date.now()
    || !isReadCallDispatchCurrent(input.workspace, input.lane, input.dispatchBinding)) return false;
  const parent = resolveTaskHandle(input.taskHandle, input.workspace);
  if (!parent.ok) return false;
  const g: Entry = {
    ...input, cursors: Object.freeze([...input.cursors]), owner: {...input.dispatchBinding},
    fingerprint: parent.state.taskFingerprint, parentVersion: parent.stateVersion,
    used: new Set(), tainted: false, pending: 0, tail: Promise.resolve(),
  };
  try { if (input.validate() !== true) return false; } catch { return false; }
  for (const cursor of g.cursors) {
    if (cursors.has(cursorKey(g.workspace, g.lane, cursor))) return false;
    const r = memberState(g, cursor);
    if (!r || !sameBinding(r.state.dispatch_binding, input.dispatchBinding)) return false;
    g.expiresAtMs = Math.min(g.expiresAtMs,r.state.expires_at_ms);
    const task = r.input["task"];
    if (task === null || typeof task !== "object" || Array.isArray(task)) return false;
    const t = task as Record<string, unknown>;
    if ((t["profile"] ?? r.state.response_profile) !== "answer"
      || Object.hasOwn(t, "expected_state_version") || Object.hasOwn(t, "force_serve")
      || t["epoch"] !== undefined || t["pull"] !== undefined || t["challenge"] !== undefined) return false;
  }
  // No await between the last ownership check and publishing group membership.
  const current = resolveTaskHandle(g.taskHandle, g.workspace);
  if (!current.ok || current.stateVersion !== g.parentVersion
    || current.state.taskFingerprint !== g.fingerprint
    || !isReadCallDispatchCurrent(g.workspace, g.lane, g.owner)) return false;
  groups.set(g.id, g);
  for (const cursor of g.cursors) cursors.set(cursorKey(g.workspace, g.lane, cursor), g);
  return true;
}

/** Wrap the WHOLE withReadCallDispatch call, not only the hydration stage. */
export async function withReadCallBatchQueue<T>(
  workspace: string | undefined, lane: string, cursor: string | undefined, run: () => Promise<T>,
): Promise<T> {
  const g = workspace !== undefined && cursor !== undefined
    ? cursors.get(cursorKey(workspace, lane, cursor)) : undefined;
  if (!g || !active(g)) return run();
  if (g.pending >= MAX_PENDING) { g.tainted = true; return run(); }
  g.pending++;
  const previous = g.tail;
  let release!: () => void;
  g.tail = new Promise<void>(resolve => { release = resolve; });
  await previous;
  const scope: Turn = {group: g, cursor: cursor!, finished: false};
  try {
    return await turn.run(scope, () => observeReadCallTaskMutations(run,(workspace,token,previous,next) => {
      if (workspace !== g.workspace || token !== g.taskHandle || !scope.leased) return;
      if (scope.ownedVersion !== previous || next !== previous+1) scope.mutationLost = true;
      scope.ownedVersion = next;
    }));
  } catch (error) {
    g.tainted = true;
    throw error;
  } finally {
    // A caller forgetting completion, or an aborted/fallback member, can never
    // let a later member inherit an unproved parent version.
    if (!scope.finished) g.tainted = true;
    g.pending--;
    release();
  }
}

/** Caller has already durably claimed this authenticated cursor for first use. */
export function takeReadCallBatchSemanticLease(
  workspace: string, lane: string, current: ReadCallDispatchBinding | undefined,
  groupId: string, cursor: string,
): boolean {
  const g = cursors.get(cursorKey(workspace, lane, cursor)), scope = turn.getStore();
  if (!g || g.id !== groupId || !scope || scope.group !== g || scope.cursor !== cursor) return false;
  if (scope.leased || g.used.has(cursor)) { g.tainted = true; return false; }
  g.used.add(cursor);
  const parent = resolveTaskHandle(g.taskHandle, workspace);
  if (!current || !validated(g) || !memberState(g, cursor) || !parent.ok
    || parent.stateVersion !== g.parentVersion || parent.state.taskFingerprint !== g.fingerprint
    || !takeReadCallSemanticLease(workspace, lane, current, g.owner)) {
    g.tainted = true;
    return false;
  }
  scope.leased = {...current};
  scope.ownedVersion = parent.stateVersion;
  return true;
}

/** Call before withReadCallDispatch releases its exclusive lane lease. */
export function finishReadCallBatchMember(
  workspace: string | undefined, lane: string, cursor: string | undefined,
  dispatch: ReadCallDispatchBinding | undefined, success: boolean,
): void {
  if (workspace === undefined || cursor === undefined) return;
  const g = cursors.get(cursorKey(workspace, lane, cursor)), scope = turn.getStore();
  if (!g || !scope || scope.group !== g || scope.cursor !== cursor) return;
  if (scope.finished) { g.tainted = true; return; }
  scope.finished = true;
  const parent = resolveTaskHandle(g.taskHandle, workspace);
  if (!success || !dispatch || !scope.leased || !sameBinding(scope.leased, dispatch)
    || !isReadCallDispatchCurrent(workspace, lane, dispatch)
    || !validated(g) || !memberState(g, cursor) || !parent.ok
    || parent.state.taskFingerprint !== g.fingerprint || scope.mutationLost
    || parent.stateVersion !== scope.ownedVersion) {
    g.tainted = true;
    return;
  }
  g.owner = {...dispatch};
  g.parentVersion = parent.stateVersion;
}

type WireObject = Record<string, unknown>;
type WindowsByPath = Map<string, LineWindow[]>;
const object = (value: unknown): WireObject | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as WireObject : undefined;
const relativePath = (value: unknown): value is string => typeof value === "string" && value.length > 0
  && !value.includes("\\") && !value.includes("\0") && !value.includes(":")
  && !path.posix.isAbsolute(value) && path.posix.normalize(value) === value
  && !value.split("/").includes("..");

function fixedWindows(value: unknown, workspace: string, lane: string,
  resolve: (handle: string) => HandleEntry | undefined): WindowsByPath | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) return undefined;
  const result: WindowsByPath = new Map();
  let count = 0;
  for (const raw of value) {
    const t = object(raw);
    if (!t || Object.keys(t).some(k => !["path", "handle", "range", "ranges"].includes(k))) return undefined;
    if ((t["range"] === undefined) === (t["ranges"] === undefined)) return undefined;
    const ranges = t["range"] === undefined ? t["ranges"] : [t["range"]];
    if (!Array.isArray(ranges) || ranges.length === 0 || (count += ranges.length) > 64) return undefined;
    let file = t["path"];
    if (t["handle"] !== undefined) {
      if (typeof t["handle"] !== "string") return undefined;
      const entry = resolve(t["handle"]);
      if (!entry || entry.workspaceRoot !== workspace || (entry.lane ?? "") !== lane
        || !relativePath(entry.path) || (entry.kind !== "file" && entry.kind !== "range")
        || (file !== undefined && file !== entry.path)) return undefined;
      file = entry.path;
      // Read targets use handles as authenticated file identities; explicit
      // ranges may override the handle's prior read window. The complete
      // requested range is still bounded below by immutable sibling plans.
    }
    if (!relativePath(file)) return undefined;
    for (const rawRange of ranges) {
      const window = parseWindow(rawRange);
      if (!window) return undefined;
      const existing = result.get(file) ?? [];
      existing.push(window); result.set(file, existing);
    }
  }
  for (const [file, windows] of result) result.set(file, normalizeWindows(windows));
  return result;
}
function included(a: WindowsByPath, b: WindowsByPath): boolean {
  return [...a].every(([file, windows]) => subtractWindows(windows, b.get(file) ?? []).length === 0);
}
function mergeWindows(into: WindowsByPath, from: WindowsByPath): void {
  for (const [file, windows] of from) into.set(file, normalizeWindows([...(into.get(file) ?? []), ...windows]));
}

/**
 * Reuse already published siblings during their owner's final projection.
 * No mint, claim, task mutation, source booking or readiness change. A sibling
 * must cover every requested window. Its immutable, already published plan
 * may also include other original-batch windows, never newly inferred scope.
 * Returning undefined preserves the ordinary producer and its recovery path.
 */
export function reuseReadCallBatchSiblingNext(input: {
  workspace: string; lane: string; cursor: string | undefined;
  dispatch: ReadCallDispatchBinding | undefined; body: WireObject;
  resolve: (handle: string) => HandleEntry | undefined;
}): WireObject | undefined {
  try {
    const {workspace, lane, cursor, dispatch, body, resolve} = input;
    if (cursor === undefined || !dispatch || body["kind"] !== "read.task_pack" || body["profile"] !== "answer") return undefined;
    const g = cursors.get(cursorKey(workspace, lane, cursor)), scope = turn.getStore();
    if (!g || !scope || scope.group !== g || scope.cursor !== cursor || scope.finished
      || !scope.leased || !sameBinding(scope.leased, dispatch) || scope.mutationLost
      || !isReadCallDispatchCurrent(workspace, lane, dispatch) || !validated(g)
      || !memberState(g, cursor)) return undefined;
    const parent = resolveTaskHandle(g.taskHandle, workspace);
    if (!parent.ok || parent.state.taskFingerprint !== g.fingerprint || parent.stateVersion !== scope.ownedVersion
      || object(body["task"])?.["id"] !== g.taskHandle) return undefined;
    const decision = object(body["decision"]), next = object(decision?.["next"]);
    const args = object(next?.["arguments"]), task = object(args?.["task"]);
    if (decision?.["kind"] !== "discover" || next?.["tool"] !== "tl_read_file" || !args || !task
      || Object.keys(next).some(k => !["tool", "arguments"].includes(k))
      || Object.keys(args).some(k => !["cwd", "lane", "query", "targets", "task", "content"].includes(k))
      || Object.keys(task).some(k => !["handle", "profile"].includes(k))
      || (args["content"] !== undefined && args["content"] !== "full" && args["content"] !== "auto")
      || args["cwd"] !== workspace || (args["lane"] ?? "") !== lane
      || typeof args["query"] !== "string" || task["handle"] !== g.taskHandle
      || (task["profile"] !== undefined && task["profile"] !== "answer")) return undefined;
    const requested = fixedWindows(args["targets"], workspace, lane, resolve);
    if (!requested) return undefined;
    const covered: WindowsByPath = new Map(), calls: WireObject[] = [];
    for (const sibling of g.cursors) {
      if (g.used.has(sibling)) continue;
      const r = memberState(g, sibling);
      if (!r || r.input["query"] !== args["query"] || r.input["content"] !== args["content"]
        || Object.keys(r.input).some(k => !["query", "targets", "task", "content"].includes(k))) continue;
      // An evicted or already claimed durable marker cannot be advertised as
      // an unused semantic sibling merely because the process map survives.
      const marker = stateStoreFor(workspace)?.get(readCallExecutionKey(r.state));
      const digest = createHash("sha256").update(JSON.stringify(r.state)).digest("hex");
      if (!marker || marker.purpose !== "read-request" || marker.version !== 1
        || marker.data["v"] !== 1 || marker.data["family"] !== "read-call-execution"
        || marker.data["status"] !== "pending" || marker.data["digest"] !== digest) continue;
      const windows = fixedWindows(r.input["targets"], workspace, lane, resolve);
      if (!windows || ![...windows].some(([file, spans]) => spans.some(a =>
        (requested.get(file) ?? []).some(b => a.start <= b.end && b.start <= a.end)))) continue;
      mergeWindows(covered, windows);
      calls.push({tool: "tl_read_file", arguments: {cwd: workspace, ...(lane ? {lane} : {}), cursor: sibling}});
    }
    if (calls.length === 0 || !included(requested, covered)) return undefined;
    const replacement = calls.length === 1 ? calls[0] : calls;
    const projected = {...body, decision: {...decision, next: replacement}};
    // Projection is late: it must never increase the already proved wire size.
    // `projected` differs from `body` ONLY in the value of `decision.next` (same
    // keys, same order), so compare the call arguments themselves -- the replaced
    // `next` against its replacement -- never the whole response (G8:
    // wireBudgetG8Fence.spec.ts lists these two sites under REQUEST_PLAN_SIZE_EXEMPT).
    if (Buffer.byteLength(JSON.stringify(replacement)) > Buffer.byteLength(JSON.stringify(next))) return undefined;
    return projected;
  } catch { return undefined; }
}

/** Reset never clears persistent batch_group: marked unknown cursors recover only. */
export function resetReadCallBatchGroupsForTests(): void {
  for (const g of groups.values()) g.tainted = true;
  groups.clear();
  cursors.clear();
}
