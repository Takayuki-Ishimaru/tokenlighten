/**
 * Copilot's compact task references. The original task record owns each
 * binding, so references survive restarts without a second eviction horizon.
 * Canonical tokens remain the only authenticated task capabilities.
 */
import { validateHandleToken } from "./handleCodec.js";
import { resolveTaskHandle } from "./stateHandles.js";
import { stateStoreFor } from "./stateStore.js";
import { TASK_ALIAS_PATTERN, taskAliasOf, taskAliasBindings } from "./taskHandleAliasFormat.js";
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : undefined;

export function compactTaskHandle(workspace: string, lane: string, token: string): string {
  if (!token.startsWith("tlh_task_v1_")) return token;
  try {
    const validation = validateHandleToken({ token, expectedPurpose: "task", workspaceRoot: workspace });
    if (!validation.ok || !resolveTaskHandle(token, workspace).ok) return token;
    const record = stateStoreFor(workspace)?.get(validation.decoded.payloadRef);
    if (!record || record.purpose !== "task" || typeof record.data["taskFingerprint"] !== "string") return token;
    const alias = taskAliasOf(validation.decoded.payloadRef, token, lane);
    return taskAliasBindings(record.data)?.some(row =>
      row.alias === alias && row.token === token && row.lane === lane && row.expiresAtMs > Date.now()) ? alias : token;
  } catch { return token; }
}

export function expandTaskHandle(workspace: string, lane: string, alias: string): string | undefined {
  const match = TASK_ALIAS_PATTERN.exec(alias);
  if (!match) return undefined;
  try {
    const record = stateStoreFor(workspace)?.get(match[1]!);
    if (!record || record.purpose !== "task" || typeof record.data["taskFingerprint"] !== "string") return undefined;
    const entry = taskAliasBindings(record.data)?.find(row => row.alias === alias && row.lane === lane && row.expiresAtMs > Date.now());
    if (!entry || taskAliasOf(match[1]!, entry.token, lane) !== alias) return undefined;
    return resolveTaskHandle(entry.token, workspace).ok ? entry.token : undefined;
  } catch { return undefined; }
}

/** Authenticated routing advice only: never expand or execute in another lane. */
export function taskAliasLaneMismatch(workspace: string, lane: string, alias: string): string | undefined {
  const match = TASK_ALIAS_PATTERN.exec(alias);
  if (!match) return undefined;
  try {
    const record = stateStoreFor(workspace)?.get(match[1]!);
    if (!record || record.purpose !== "task" || typeof record.data["taskFingerprint"] !== "string") return undefined;
    const matches = taskAliasBindings(record.data)?.filter(row => row.alias === alias);
    if (matches?.length !== 1) return undefined;
    const entry = matches[0]!;
    if (entry.lane === lane || entry.lane.length > 64 || entry.expiresAtMs <= Date.now()
      || taskAliasOf(match[1]!, entry.token, entry.lane) !== alias) return undefined;
    const check = validateHandleToken({token: entry.token, expectedPurpose: "task", workspaceRoot: workspace});
    if (!check.ok || check.decoded.payloadRef !== match[1] || !resolveTaskHandle(entry.token, workspace).ok) return undefined;
    return entry.lane;
  } catch { return undefined; }
}

export function expandTaskAliasArguments(workspace: string, lane: string, args: ObjectValue): ObjectValue {
  let task = object(args["task"]);
  const encoded = typeof args["task"] === "string";
  if (encoded) { try { task = object(JSON.parse(args["task"] as string)); } catch { return args; } }
  if (!task) return args;
  let expanded = task;
  for (const field of ["handle", "epoch"] as const) {
    const value = task[field];
    if (typeof value !== "string") continue;
    const token = expandTaskHandle(workspace, lane, value);
    if (token !== undefined) expanded = { ...expanded, [field]: token };
  }
  if (expanded === task) return args;
  return { ...args, task: encoded ? JSON.stringify(expanded) : expanded };
}

/** Only protocol-owned control fields are visited, never source/evidence. */
export function projectTaskAliasBody(workspace: string, lane: string, body: ObjectValue): ObjectValue {
  // JSON wire values cannot share identity; detach repeated JS references too.
  const copy = JSON.parse(JSON.stringify(body)) as ObjectValue;
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) { for (const child of node) visit(child); return; }
    const row = object(node);
    if (!row) return;
    const task = object(row["task"]);
    if (typeof task?.["id"] === "string") task["id"] = compactTaskHandle(workspace, lane, task["id"]);
    if (["tl_read_file", "tl_search_files", "tl_edit_file"].includes(String(row["tool"]))) {
      const args = object(row["arguments"]);
      const nextTask = object(args?.["task"]);
      const nextLane = typeof args?.["lane"] === "string" ? args["lane"] : "";
      if (args && args["cwd"] === workspace && nextLane === lane && typeof nextTask?.["handle"] === "string") {
        nextTask["handle"] = compactTaskHandle(workspace, lane, nextTask["handle"]);
      }
    }
    for (const key of ["decision", "next", "next_call", "recovery", "verification", "plan", "limit", "recipe", "calls", "alternatives", "retry", "closure", "capability_gaps"]) visit(row[key]);
  };
  visit(copy);
  return copy;
}
