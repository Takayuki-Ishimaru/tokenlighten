import * as path from "node:path";
import type {ReadCallContinuationState, ReadCallDispatchBinding} from "@tokenlighten/types";
import {takeReadCallSemanticLease} from "../state/readCallDispatch.js";
import {takeReadCallBatchSemanticLease} from "../state/readCallBatchGroup.js";
import { claimReadCallContinuation, mintReadCallContinuation, resolveReadCallContinuation } from "../state/readCallContinuationStore.js";
import { mintReadCallCursorAlias, readCallCursorAliasForCanonical, resolveReadCallCursorAlias } from "../state/readCallCursorAliases.js";
import { resolveTaskQueryRefHandle } from "../state/session.js";
import { resolveTaskHandle } from "../state/stateHandles.js";
import { expandTaskHandle } from "../state/taskHandleAliases.js";
import { parseWindow } from "../state/readRequestStore.js";
import { shaOfText, shortSha, type HandleEntry } from "../util/handles.js";
import { measureResponseBytes } from "./budget/measure.js";
import type {FinalSourceCapsule} from "../features/task-pack/sourceCapsuleCallScope.js";

type ObjectValue = Record<string, unknown>;
type SourceReader = (relativePath: string) => Promise<string | null>;
type HandleResolver = (handle: string) => HandleEntry | undefined;
const object = (value: unknown): ObjectValue | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : undefined;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
// Only protocol-owned executable-call containers, never evidence/source strings.
const CONTROL_KEYS = ["decision", "next", "next_call", "recovery", "verification", "plan", "limit", "recipe", "calls", "alternatives", "retry", "change_contract", "stages", "gaps"] as const;

/** Compact an already-persisted canonical sibling on its repeated projection. */
export function projectReadCallCursorAliasesOnNext(workspace: string, lane: string, body: ObjectValue): ObjectValue {
  const projected = clone(body);
  let changed = false;
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) { for (const item of node) visit(item); return; }
    const row = object(node);
    if (!row) return;
    const args = object(row["arguments"]);
    if (row["tool"] === "tl_read_file" && args && typeof args["cursor"] === "string") {
      const alias = readCallCursorAliasForCanonical({workspaceRoot: workspace, lane, canonicalCursor: args["cursor"]});
      if (alias) { args["cursor"] = alias; changed = true; }
    }
    for (const key of CONTROL_KEYS) visit(row[key]);
  };
  visit(projected["decision"]);
  return changed ? projected : body;
}

/**
 * The containers the root-cwd omission reaches: the control containers above, and the `receipt` of a `read.receipt`,
 * whose `next` is the continuation its `limit.next` carries (one canonical cursor on the wire, never two that differ
 * by the path: servedRequestReceipt.spec.ts, finding 7). Not widened to the compaction, which keeps `CONTROL_KEYS`.
 */
const OMISSION_KEYS = [...CONTROL_KEYS, "receipt"] as const;

/** Every `tl_read_file` or `tl_search_files` call in the protocol-owned containers of `node` (a `decision`, a `next`, a `limit`, a `receipt`, … and arrays of them), never evidence, entries or source strings. */
function eachControlWorkspaceCall(node: unknown, visit: (args: ObjectValue) => void): void {
  if (Array.isArray(node)) { for (const item of node) eachControlWorkspaceCall(item, visit); return; }
  const row = object(node);
  if (!row) return;
  const args = object(row["arguments"]);
  if ((row["tool"] === "tl_read_file" || row["tool"] === "tl_search_files") && args) visit(args);
  for (const key of OMISSION_KEYS) eachControlWorkspaceCall(row[key], visit);
}

/**
 * The `tl_read_file` and `tl_search_files` calls a reply publishes as nexts ship without the `cwd` that is the configured root. `root`
 * is where a call omitting `cwd` resolves (ingress: `resolveWorkspaceRoot(undefined, activeRoot)`), so a call
 * that names the reply's own workspace (`workspace === root`) by that `cwd` says nothing a call without it would
 * not: the cursor calls the transport mints and every other read next alike (the request re-packed by `qref` or
 * `query` over its targets, a window list, a `limit.next` page, and their copies in the control containers).
 * Before this the path was dropped from a verified cursor alias only, and a `{qref, targets, cwd, task}` next
 * carried the absolute path: +241 B between a 127- and a 368-character root, and a size preview that counted it
 * moved the reply's content with the length of the path (generality audit 2026-10-24 §3.7). The size preview
 * counts the same calls through this function (`taskPackSizePreview.ts`), so what it counts is what ships.
 *
 * Left as they are: a `cwd` that is not exactly the workspace (a subtree, another root, a worktree, a relative
 * or mistyped one), every call of another tool (`tl_edit_file` needs its `cwd`, `tl_search_files` is none of
 * this projection's business), and evidence, entries or source strings. Pure: the input body is never edited,
 * and it is returned itself when no call carries the `cwd`.
 */
export function omitConfiguredRootCwdOnNext(workspace: string, root: string, body: ObjectValue): ObjectValue {
  if (workspace !== root) return body;
  let found = false;
  eachControlWorkspaceCall(body, args => { found ||= args["cwd"] === workspace; });
  if (!found) return body;
  const projected = clone(body);
  eachControlWorkspaceCall(projected, args => { if (args["cwd"] === workspace) delete args["cwd"]; });
  return projected;
}

function relativeSource(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0")
    && !value.includes("\\") && !value.includes(":") && !path.posix.isAbsolute(value)
    && path.posix.normalize(value) === value && !value.split("/").includes("..");
}

/**
 * Admission is deliberately limited to exact, bounded source-window plans.
 * A target's `purpose` is a label the server writes beside a window it adds to a
 * bundle: it names no source and widens nothing, so it rides in the stored call
 * and nowhere else (the fixed-window recovery rebuilds targets from path and windows).
 *
 * Every target therefore names exactly one of `range` / `ranges`. A discovery
 * bundle (`{qref, targets:[{path}, …], cwd, task}`, canonicalDecision.ts
 * `discoveryBundleNext`) lists whole files: it has no window to bind to a source
 * revision and none for the fixed-window recovery to rebuild, so it is no plan this
 * admits and is never published as a cursor. It ships as the call it is, without
 * its root `cwd` like every read next (`omitConfiguredRootCwdOnNext`).
 */
function targetPaths(input: ObjectValue, workspace: string, lane: string, resolve: HandleResolver): string[] | undefined {
  const targets = input["targets"];
  if (!Array.isArray(targets) || targets.length === 0 || targets.length > 64) return undefined;
  const paths = new Set<string>();
  for (const raw of targets) {
    const target = object(raw);
    if (!target || Object.keys(target).some(key => !["path", "handle", "range", "ranges", "purpose"].includes(key))
      || (target["purpose"] !== undefined && typeof target["purpose"] !== "string")) return undefined;
    const range = target["range"], ranges = target["ranges"];
    if ((range === undefined) === (ranges === undefined)) return undefined;
    const windows = range === undefined ? ranges : [range];
    if (!Array.isArray(windows) || windows.length === 0 || windows.length > 64 || windows.some(w => parseWindow(w) === undefined)) return undefined;
    let file = target["path"];
    if (target["handle"] !== undefined) {
      if (typeof target["handle"] !== "string") return undefined;
      const entry = resolve(target["handle"]);
      if (!entry || entry.workspaceRoot !== workspace || (entry.lane ?? "") !== lane || !relativeSource(entry.path)) return undefined;
      if (file !== undefined && file !== entry.path) return undefined;
      file = entry.path;
    }
    if (!relativeSource(file)) return undefined;
    paths.add(file);
  }
  return [...paths];
}

/** A `next` the transport copy replaces by a cursor call: the call, its task member, and whether it restates the request or re-packs it by qref. */
interface CompactableRead {
  readonly args: ObjectValue;
  readonly task: ObjectValue | undefined;
  readonly byQuery: boolean;
  readonly byQref: boolean;
}

/** The shape conditions of a `tl_read_file` call that `projectReadCallContinuations` compacts; `undefined` for any other call. */
function compactableReadNext(workspace: string, lane: string, nextValue: unknown): CompactableRead | undefined {
  const next = object(nextValue), args = object(next?.["arguments"]), task = object(args?.["task"]);
  if (next?.["tool"] !== "tl_read_file" || !args || args["cursor"] !== undefined
    || args["cwd"] !== workspace || (args["lane"] ?? "") !== lane
    || (args["task"] !== undefined && !task)
    || (task && (task["epoch"] !== undefined || task["pull"] !== undefined || task["challenge"] !== undefined))) return undefined;
  // The call restates the request as a query, or re-packs this task by its qref.
  // Never both: the dispatcher refuses that pair, and a plan must not choose.
  const named = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";
  return {args, task, byQuery: named(args["query"]) && args["qref"] === undefined,
    byQref: named(args["qref"]) && args["query"] === undefined};
}

/** The alias `mintReadCallCursorAlias` writes is `tlc_s1_` + 12 + `_` + 22 URL-safe characters: this one has the same length. */
const SIZING_CURSOR_ALIAS = `tlc_s1_${"x".repeat(12)}_${"x".repeat(22)}`;

/**
 * The cursor call the transport copy will ship in place of `nextValue` (the
 * pack's own `decision.next`), built for SIZING ONLY: a placeholder alias of
 * the real alias's length, nothing minted, nothing read. `undefined` when the
 * call will not be compacted, so it ships as it stands (without its root `cwd`
 * all the same: `omitConfiguredRootCwdOnNext`).
 *
 * A task pack is measured before `projectReadCallContinuations` replaces a
 * `next` that restates the request, or lists its owed windows, by one cursor
 * call, and before `omitConfiguredRootCwdOnNext` drops that call's `cwd`. A
 * budget that counts the call as the pack builds it counts the query, every
 * owed range and the workspace's absolute path: bytes that never reach the
 * client, and a reply whose measured size moves with the length of the path the
 * client works in. This is the shape both projections give it, on the same
 * conditions: `root` is where a call omitting `cwd` resolves (`undefined`:
 * unknown, so the `cwd` stays counted); the plan's task handle and the source
 * bindings are minted afterwards and change no length.
 */
export function sizedCompactNext(
  nextValue: unknown, workspace: string, lane: string, root: string | undefined, resolve: HandleResolver,
): ObjectValue | undefined {
  const compactable = compactableReadNext(workspace, lane, nextValue);
  if (!compactable || (!compactable.byQuery && !compactable.byQref)) return undefined;
  if (!targetPaths(compactable.args, workspace, lane, resolve)) return undefined;
  const rider = compactable.task?.["expected_state_version"];
  const base: ObjectValue = {...(lane ? {lane} : {}), cursor: SIZING_CURSOR_ALIAS};
  if (rider !== undefined) base["task"] = {expected_state_version: rider};
  if (measureResponseBytes(JSON.stringify({cwd: workspace, ...base})) >= measureResponseBytes(JSON.stringify(compactable.args))) return undefined;
  return {tool: "tl_read_file", arguments: workspace === root ? base : {cwd: workspace, ...base}};
}

/** Replace one authoritative large next and its exact copies, after finalization. */
export async function projectReadCallContinuations(
  workspace: string, lane: string, body: ObjectValue, read: SourceReader, resolve: HandleResolver,
  dispatch?: ReadCallDispatchBinding,
): Promise<ObjectValue> {
  if (!dispatch || body["kind"] !== "read.task_pack") return body;
  const decision = object(body["decision"]);
  if (decision?.["kind"] !== "discover") return body;
  const compactable = compactableReadNext(workspace, lane, decision["next"]);
  if (!compactable) return body;
  const {args, task, byQuery, byQref} = compactable;
  // A query call names its parent task. A qref call (the qref binds the task on
  // its own, so the next may carry no handle) belongs to the task of the reply
  // that publishes it: the plan binds to that reply's task id, which the mint
  // then authenticates as this workspace's task (resolveTaskHandle and the
  // task-purpose token check) or publishes nothing. A reply that states its own
  // replay token must be the one the next re-packs by.
  const carried = task?.["handle"], replied = object(body["task"]);
  const repliedTask = replied?.["id"];
  // The qref must itself belong to that task (its recorded wire handle), so the
  // plan binds exactly the task the expanded call would re-pack.
  const taskHandle = typeof carried === "string" ? carried
    : byQref && carried === undefined && typeof repliedTask === "string" && repliedTask !== ""
      && (replied?.["replay"] === undefined || replied["replay"] === args["qref"])
      && resolveTaskQueryRefHandle(workspace, args["qref"] as string) === repliedTask
      && (!task || Object.keys(task).every(key => key === "profile")) ? repliedTask : undefined;
  if ((!byQuery && !byQref) || taskHandle === undefined) return body;
  try {
    const paths = targetPaths(args, workspace, lane, resolve);
    if (!paths) return body;
    const sources: Array<{path: string; sha: string}> = [];
    for (const file of paths) {
      const text = await read(file);
      if (text === null) return body;
      sources.push({path: file, sha: shaOfText(text)});
    }
    const originalInput = clone(args);
    delete originalInput["cwd"]; delete originalInput["lane"];
    // Hydration always restores `task.handle`; storing the handle the qref binds
    // keeps the stored call and the plan's parent task one and the same.
    if (carried === undefined) originalInput["task"] = {...task, handle: taskHandle};
    const responseProfile = body["profile"] === "answer" || body["profile"] === "generic" ? body["profile"] : undefined;
    const cursor = mintReadCallContinuation({workspaceRoot: workspace, lane, taskHandle, dispatchBinding: dispatch, originalInput, sources,
      ...(responseProfile !== undefined ? {responseProfile} : {})});
    if (!cursor) return body;
    const exposedCursor = mintReadCallCursorAlias({workspaceRoot: workspace, lane, canonicalCursor: cursor}) ?? cursor;
    // The authenticated immutable cursor already binds its exact parent task.
    // Avoid making the client transcribe the same capability a second time.
    const compact: ObjectValue = {cwd: workspace, ...(lane ? {lane} : {}), cursor: exposedCursor};
    if (task?.["expected_state_version"] !== undefined) compact["task"] = {expected_state_version: task["expected_state_version"]};
    if (Buffer.byteLength(JSON.stringify(compact)) >= Buffer.byteLength(JSON.stringify(args))) return body;
    const signature = JSON.stringify(args), projected = clone(body);
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) { for (const item of node) visit(item); return; }
      const row = object(node);
      if (!row) return;
      if (row["tool"] === "tl_read_file" && JSON.stringify(row["arguments"]) === signature) row["arguments"] = clone(compact);
      for (const key of CONTROL_KEYS) visit(row[key]);
    };
    visit(projected);
    return projected;
  } catch {
    // Compaction is an optimization: never publish an unpersisted reference.
    return body;
  }
}

export type HydratedReadCall =
  | {kind: "unchanged"}
  | {kind: "hydrated"; input: ObjectValue; replayAuthorization?: ReadCallReplayAuthorization}
  | {kind: "refusal"; refusal: ObjectValue};

export interface ReadCallReplayAuthorization {
  readonly taskHandle: string;
  readonly sourceBindings: readonly {readonly path: string; readonly sha: string}[];
  readonly targets: readonly {readonly path: string; readonly ranges: readonly string[]}[];
}

function replayAuthorization(state: ReadCallContinuationState, input: ObjectValue): ReadCallReplayAuthorization | undefined {
  if (typeof state.task_handle !== "string") return undefined;
  const bindings = state.source_bindings;
  const rawTargets = input["targets"];
  if (!Array.isArray(bindings) || !Array.isArray(rawTargets) || rawTargets.length === 0) return undefined;
  const sourceBindings: {path: string; sha: string}[] = [];
  for (const value of bindings) {
    const row = object(value);
    if (!row || !relativeSource(row["path"]) || typeof row["sha"] !== "string") return undefined;
    sourceBindings.push({path: row["path"], sha: row["sha"]});
  }
  const targets: {path: string; ranges: string[]}[] = [];
  for (const value of rawTargets) {
    const row = object(value);
    if (!row || !relativeSource(row["path"])) return undefined;
    const windows = row["range"] !== undefined ? [row["range"]] : row["ranges"];
    if (!Array.isArray(windows)) return undefined;
    const ranges: string[] = [];
    for (const raw of windows) {
      const window = parseWindow(raw);
      if (!window) return undefined;
      ranges.push(`${window.start}-${window.end}`);
    }
    targets.push({path: row["path"], ranges});
  }
  return {taskHandle: state.task_handle, sourceBindings, targets};
}

// Preserve internal line separators; only a final source-line terminator may
// be absent from a delivered capsule or the current wire projection.
function replaySourceLines(body: string): {text: string; separator: string}[] {
  const parts = body.split(/(\r\n|\r|\n)/), lines: {text: string; separator: string}[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    if (i > 0 && i === parts.length - 1 && parts[i] === "") break;
    lines.push({text: parts[i]!, separator: parts[i + 1] ?? ""});
  }
  return lines;
}

/** Prove every returned line against finalized, byte-matching source fragments. */
function finalizedFragmentsCover(
  capsules: readonly FinalSourceCapsule[], start: number, end: number, body: string,
): boolean {
  const lines = replaySourceLines(body);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start <= 0 || end < start
    || lines.length !== end - start + 1) return false;
  const covered = new Set<number>();
  for (const {capsule: cap} of capsules) {
    if (!Number.isSafeInteger(cap.startLine) || !Number.isSafeInteger(cap.endLine)
      || cap.startLine <= 0 || cap.endLine < cap.startLine || cap.endLine < start || cap.startLine > end) continue;
    const fragment = replaySourceLines(cap.body);
    if (fragment.length !== cap.endLine - cap.startLine + 1) continue;
    const first = Math.max(start, cap.startLine), last = Math.min(end, cap.endLine);
    let matches = true;
    for (let line = first; line <= last; line += 1) {
      const current = lines[line - start]!, prior = fragment[line - cap.startLine]!;
      if (current.text !== prior.text || (current.separator && prior.separator && current.separator !== prior.separator)) {
        matches = false;
        break;
      }
    }
    if (matches) for (let line = first; line <= last; line += 1) covered.add(line);
  }
  return covered.size === lines.length;
}

/** Compact only exact batch rows backed by prior finalized task-pack bodies. */
export function projectAuthenticatedReadBatchReplay(
  body: ObjectValue,
  authorization: ReadCallReplayAuthorization,
  prior: readonly FinalSourceCapsule[],
  taskBinding: string | undefined,
  workspace: string,
  lane: string,
  resolve: HandleResolver,
): ObjectValue {
  if (body["kind"] !== "read.batch" || !Array.isArray(body["entries"]) || !taskBinding) return body;
  const projected = clone(body), entries = projected["entries"] as unknown[];
  let changed = false;
  // `projected` differs from `body` ONLY in the entries replaced below, so the
  // response grows by exactly the sum of what those entries grow by. Track that
  // delta entry by entry (G8: the replaced entry against its replacement, never
  // the whole response -- wireBudgetG8Fence.spec.ts lists these two sites under
  // REQUEST_PLAN_SIZE_EXEMPT).
  let growth = 0;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = object(entries[index]);
    if (!entry || (entry["form"] !== "handle" && entry["form"] !== "file")
      || typeof entry["path"] !== "string" || typeof entry["range"] !== "string"
      || typeof entry["handle"] !== "string" || typeof entry["sha"] !== "string"
      || typeof entry["content"] !== "string" || entry["truncated"] === true
      || entry["remaining_ranges"] !== undefined || entry["elided"] !== undefined) continue;
    const entryPath = entry["path"] as string, entryRange = entry["range"] as string;
    const entryHandle = entry["handle"] as string, entrySha = entry["sha"] as string, entryContent = entry["content"] as string;
    const requested = authorization.targets.some(target => target.path === entryPath && target.ranges.includes(entryRange));
    if (!requested) continue;
    const source = authorization.sourceBindings.find(binding => binding.path === entryPath);
    if (!source) continue;
    const currentHandle = resolve(entryHandle), startEnd = entryRange.match(/^(\d+)-(\d+)$/);
    const requestedStart = startEnd ? Number(startEnd[1]) : NaN, requestedEnd = startEnd ? Number(startEnd[2]) : NaN;
    const currentHandleWindow = currentHandle?.range === undefined ? undefined : parseWindow(currentHandle.range);
    if (!currentHandle || currentHandle.kind !== "range" || currentHandle.workspaceRoot !== workspace || (currentHandle.lane ?? "") !== lane
      || currentHandle.path !== entryPath || !startEnd
      || currentHandle.sha !== shaOfText(entryContent)
      || (currentHandle.range !== undefined && (!currentHandleWindow
        || currentHandleWindow.start > requestedStart || currentHandleWindow.end < requestedEnd))) continue;
    const start = requestedStart, end = requestedEnd;
    if (entrySha !== shortSha(shaOfText(entryContent))) continue;
    const capsules = prior.filter(candidate => {
      if (candidate.taskBinding !== taskBinding) return false;
      const cap = candidate.capsule, priorHandle = resolve(cap.handle);
      const priorHandleWindow = priorHandle?.range === undefined ? undefined : parseWindow(priorHandle.range);
      return cap.path === entryPath && cap.sha === source.sha && cap.handle.length > 0
        && priorHandle !== undefined && priorHandle.kind === "range" && priorHandle.workspaceRoot === workspace && (priorHandle.lane ?? "") === lane
        && priorHandle.path === entryPath
        && (priorHandle.range === undefined || (priorHandleWindow !== undefined
          && priorHandleWindow.start <= cap.startLine && priorHandleWindow.end >= cap.endLine));
    });
    const exact = capsules.some(({capsule: cap}) => cap.startLine === start && cap.endLine === end && cap.body === entryContent);
    if (!exact && !finalizedFragmentsCover(capsules, start, end, entryContent)) continue;
    const replacement = {
      form: "file-downgraded", path: entryPath, range: entryRange, handle: entryHandle,
      downgraded_from: "range", reason: "already-served", sha: entrySha, code_unchanged: true,
      summary: {served: [entryRange], complete: false},
      note: `lines ${entryRange} were served earlier in this task and are unchanged; task.force_serve:true resends them`,
    };
    growth += Buffer.byteLength(JSON.stringify(replacement)) - Buffer.byteLength(JSON.stringify(entries[index]));
    entries[index] = replacement;
    changed = true;
  }
  // The receipt form may only shrink the already-fitted response.
  if (!changed || growth > 0) return body;
  return projected;
}

export async function hydrateReadCallContinuation(
  workspace: string, lane: string, args: ObjectValue, read: SourceReader, resolve: HandleResolver,
  validate?: (input: ObjectValue) => ObjectValue | undefined,
  dispatch?: ReadCallDispatchBinding,
): Promise<HydratedReadCall> {
  if (typeof args["cursor"] !== "string") return {kind: "unchanged"};
  const task = object(args["task"]);
  const supplied = task?.["handle"];
  const explicitHandle = task !== undefined && Object.hasOwn(task, "handle");
  const suppliedCanonical = typeof supplied === "string" && supplied.length > 0
    ? expandTaskHandle(workspace, lane, supplied) ?? supplied : undefined;
  let canonicalCursor = args["cursor"];
  const alias = resolveReadCallCursorAlias({workspaceRoot: workspace, lane, cursor: canonicalCursor});
  if (alias.kind === "refusal") return {kind: "refusal", refusal: {ok: false, code: "cursor-invalid", field: "cursor",
    detail: alias.detail, retry: "call"}};
  if (alias.kind === "canonical") canonicalCursor = alias.cursor;
  const result = resolveReadCallContinuation({workspaceRoot: workspace, lane,
    ...(suppliedCanonical !== undefined ? {taskHandle: suppliedCanonical} : {}), cursor: canonicalCursor});
  if (result.kind === "other") return {kind: "unchanged"};
  const refuse = (code: string, detail: string, extra: ObjectValue = {}): HydratedReadCall =>
    ({kind: "refusal", refusal: {ok: false, code, field: "cursor", detail, retry: "call", ...extra}});
  if (result.kind === "refusal") return refuse("cursor-invalid", result.detail);
  if ((Object.hasOwn(args, "task") && task === undefined)
    || (explicitHandle && suppliedCanonical === undefined)) {
    return refuse("invalid-input", "task and any explicitly supplied task.handle must be valid objects and non-empty references");
  }
  const state = result.state, original = result.input, canonical = state.task_handle;
  if (task && Object.keys(task).some(key => !["handle", "profile", "force_serve", "expected_state_version"].includes(key))) {
    return refuse("invalid-input", "read-call cursor accepts only task.handle, matching task.profile, task.force_serve and task.expected_state_version");
  }
  if (task && Object.hasOwn(task, "profile")
    && (typeof task["profile"] !== "string" || task["profile"] !== (object(original["task"])?.["profile"] ?? state.response_profile))) {
    return refuse("invalid-input", "task.profile must exactly match the stored continuation profile", {field: "task.profile"});
  }
  const input = clone(original);
  input["cwd"] = workspace;
  if (lane) input["lane"] = lane;
  const storedTask = object(input["task"]) ?? {};
  input["task"] = {...storedTask, handle: canonical,
    ...(task?.["force_serve"] !== undefined ? {force_serve: task["force_serve"]} : {}),
    ...(task?.["expected_state_version"] !== undefined ? {expected_state_version: task["expected_state_version"]} : {})};
  if (args["budget"] !== undefined) input["budget"] = clone(args["budget"]);
  const expected = (input["task"] as ObjectValue)["expected_state_version"];
  const parent = resolveTaskHandle(canonical, workspace);
  if (!parent.ok) return refuse("cursor-invalid", "the parent task is no longer available");
  if (expected !== undefined && expected !== parent.stateVersion) {
    return refuse("state-conflict", "task state version changed", {field: "task.expected_state_version", expected, actual: parent.stateVersion});
  }
  const paths = targetPaths(input, workspace, lane, resolve);
  if (!paths || paths.length !== state.source_bindings.length || paths.some(p => !state.source_bindings.some(s => s.path === p))) {
    return refuse("cursor-invalid", "stored source targets no longer resolve to the bound paths");
  }
  for (const source of [...state.source_bindings,...(state.batch_source_bindings ?? [])]) {
    const text = await read(source.path);
    if (text === null || shaOfText(text) !== source.sha) {
      return refuse("cursor-stale", "a source revision changed; restart the original request");
    }
  }
  // Validate both possible dispatch shapes before consuming the once-only claim.
  // The recovery drops the query or the qref alike (and the targets' purposes with
  // them): it re-reads the stored windows and never re-packs.
  const recovery = clone(input);
  delete recovery["query"]; delete recovery["qref"]; delete recovery["scope"];
  recovery["content"] = "full";
  recovery["targets"] = (recovery["targets"] as ObjectValue[]).map(target => ({
    path: target["path"] ?? resolve(target["handle"] as string)!.path,
    ...(target["range"] !== undefined ? {range: target["range"]} : {ranges: clone(target["ranges"])}),
  }));
  const invalid = validate?.(input) ?? validate?.(recovery);
  if (invalid) return {kind: "refusal", refusal: invalid};
  const first = claimReadCallContinuation(workspace, state);
  if (first === undefined) return refuse("cursor-invalid", "cannot establish durable continuation execution; restart the original request");
  // A qref plan's stored call is an ordinary re-pack: the dispatcher accepts it at any
  // time, and its own qref checks (known, current, this task's) run when it executes.
  // So the FIRST claim of a qref cursor runs that call whenever it comes -- after an
  // intervening call or a restart, with a budget, task.force_serve or
  // task.expected_state_version rider, all already applied to `input` as they apply to
  // the call itself -- and holds no lane lease: it is the call the client could have
  // sent expanded. A query plan rebuilds semantic evidence from session state instead,
  // which only an immediate, uncontended use may do: overrides, intervening calls and
  // restart recover exact windows. A replay of either recovers exact windows.
  const repack = state.batch_group === undefined && typeof original["qref"] === "string";
  const sameBudget = args["budget"] === undefined || JSON.stringify(args["budget"]) === JSON.stringify(original["budget"]);
  const semantic = first && (repack || ((input["task"] as ObjectValue)["force_serve"] !== true && sameBudget
    && (state.batch_group === undefined || expected === undefined)
    && (state.batch_group !== undefined
      ? takeReadCallBatchSemanticLease(workspace,lane,dispatch,state.batch_group,canonicalCursor)
      : takeReadCallSemanticLease(workspace, lane, dispatch, state.dispatch_binding))));
  const replay = first === false && args["budget"] === undefined
    && (input["task"] as ObjectValue)["force_serve"] !== true ? replayAuthorization(state, recovery) : undefined;
  return {kind: "hydrated", input: semantic ? input : recovery, ...(replay ? {replayAuthorization: replay} : {})};
}
