import {expandTaskHandle} from "./taskHandleAliases.js";
import {laneTaskHandles} from "./laneTaskHandles.js";
import {resolveTaskQueryRefBinding} from "./session.js";
import {resolveTaskHandle} from "./stateHandles.js";
import type {HandleEntry} from "../util/handles.js";
import {runWithSessionLane} from "../util/laneKey.js";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : undefined;

const TASK_KEYS = new Set([
  "id", "handle", "expected_state_version", "profile", "challenge", "force_serve", "pull", "epoch",
]);

function validTaskShape(task: ObjectValue): boolean {
  if (Object.keys(task).some(key => !TASK_KEYS.has(key)) || Object.hasOwn(task, "epoch")) return false;
  if (task["handle"] !== undefined && typeof task["handle"] !== "string") return false;
  if (task["expected_state_version"] !== undefined && typeof task["expected_state_version"] !== "number") return false;
  if (task["profile"] !== undefined && typeof task["profile"] !== "string") return false;
  if (task["challenge"] !== undefined && object(task["challenge"]) === undefined) return false;
  if (task["force_serve"] !== undefined && typeof task["force_serve"] !== "boolean") return false;
  if (task["pull"] !== undefined && task["pull"] !== "closure") return false;
  return true;
}

function sourceBoundCurrentTask(workspace: string, lane: string, token: string): boolean {
  if (laneTaskHandles(workspace, lane)[0] !== token) return false;
  const resolved = resolveTaskHandle(token, workspace);
  if (!resolved.ok || typeof resolved.state.replay !== "string" || resolved.state.replay === "") return false;
  return runWithSessionLane(lane, () =>
    resolveTaskQueryRefBinding(workspace, resolved.state.replay!) === resolved.state.taskFingerprint);
}

/**
 * Proves only that the one edits[] handle is a live content handle in this
 * workspace/lane. The normal edit pipeline still validates served source,
 * current bytes, CAS, readonly and write authorization after the task rename.
 */
export function isCurrentSingleEditHandle(
  args: ObjectValue,
  handle: string,
  workspace: string,
  lane: string,
  lookup: (id: string) => HandleEntry | undefined,
): boolean {
  const edits = args["edits"];
  if (!Array.isArray(edits) || edits.length !== 1) return false;
  const item = object(edits[0]);
  if (item?.["handle"] !== handle) return false;
  const entry = lookup(handle);
  if (!entry || entry.id !== handle || entry.purpose !== "content" || entry.workspaceRoot !== workspace || !entry.path
    || (entry.lane === undefined ? lane !== "" : entry.lane !== lane)
    || (entry.kind !== "file" && entry.kind !== "range")) return false;
  if (entry.kind === "file" && entry.range !== undefined) return false;
  return entry.kind === "file" || (typeof entry.range === "string" && /^\d+(?:-\d+)?$/.test(entry.range));
}

/** Repairs only a task.id echo that proves the lane's latest live task. */
export async function repairEditTaskIdEcho(
  args: ObjectValue,
  workspace: string,
  lane: string,
  currentItemHandle: (handle: string, args: ObjectValue, workspace: string, lane: string) => boolean,
): Promise<ObjectValue> {
  let task = object(args["task"]);
  const encoded = typeof args["task"] === "string";
  if (encoded) {
    try { task = object(JSON.parse(args["task"] as string)); } catch { return args; }
  }
  if (!task || !validTaskShape(task) || typeof task["id"] !== "string") return args;
  const alias = task["id"] as string;
  const token = expandTaskHandle(workspace, lane, alias);
  if (token === undefined || !sourceBoundCurrentTask(workspace, lane, token)) return args;
  const supplied = task["handle"];
  if (supplied !== undefined && supplied !== alias && supplied !== token) {
    if (typeof supplied !== "string") return args;
    const sameAlias = expandTaskHandle(workspace, lane, supplied);
    if (sameAlias !== token && !currentItemHandle(supplied, args, workspace, lane)) return args;
  }
  const {id: _id, ...rest} = task;
  const repaired = {...rest, handle: token};
  return {...args, task: encoded ? JSON.stringify(repaired) : repaired};
}
