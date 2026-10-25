import { expect } from "vitest";
import { resolveReadCallContinuation } from "../../state/readCallContinuationStore.js";
import { resolveReadCallCursorAlias } from "../../state/readCallCursorAliases.js";
import { expandTaskHandle } from "../../state/taskHandleAliases.js";
import { resetStateStoresForTests } from "../../state/stateStore.js";

/**
 * The arguments a server-issued read `next` stands for.
 *
 * Since v0.16.0 the server writes a long read `next` as a short reference
 * (`{cwd?, lane?, cursor}`; protocol/readCallContinuation.ts
 * `projectReadCallContinuations`) and keeps the full transcript call in a
 * once-only plan on its side. A spec that asserts on what the `next` ASKS FOR
 * (its `targets`, ranges, query) expands the reference first, with this.
 *
 * Inspect the immutable expanded plan without consuming its once-only claim.
 * A compact alias next under the server's configured root carries no `cwd`
 * (it resolves there); `workspaceRoot` names that root for such a next. The
 * observer reads the same durable state a server process writes, so it can
 * only be used from the process that owns (or shares the state store of) the
 * workspace: an in-process `callTool` spec, or a spec that spawns a server over
 * a workspace it also names here. A next that is not a cursor reference is
 * returned as it is.
 */
export function expandedReadNextArguments(args: Record<string, unknown> | undefined, workspaceRoot?: string): Record<string, unknown> | undefined {
  if (typeof args?.["cursor"] !== "string") return args;
  // The spawned writer may have published a new plan since our preceding read.
  // Refresh this observer only; never mutate the server or its durable records.
  resetStateStoresForTests();
  const workspace = typeof args["cwd"] === "string" ? args["cwd"] : String(workspaceRoot), lane = typeof args["lane"] === "string" ? args["lane"] : "";
  const task = args["task"] as Record<string, unknown> | undefined;
  const supplied = task?.["handle"];
  const handle = typeof supplied === "string" ? expandTaskHandle(workspace, lane, supplied) ?? supplied : undefined;
  const alias = resolveReadCallCursorAlias({workspaceRoot: workspace, lane, cursor: args["cursor"]});
  const cursor = alias.kind === "canonical" ? alias.cursor : args["cursor"];
  const resolved = resolveReadCallContinuation({workspaceRoot: workspace, lane,
    ...(handle !== undefined ? {taskHandle: handle} : {}), cursor});
  expect(resolved.kind, "server-issued compact next must restore its exact transcript call").toBe("read-call");
  if (resolved.kind !== "read-call") throw new Error("missing read-call plan");
  return {...resolved.input, cwd: workspace, ...(lane ? {lane} : {})};
}
