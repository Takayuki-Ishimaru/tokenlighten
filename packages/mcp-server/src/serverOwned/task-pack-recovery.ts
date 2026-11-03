import { canonicalToolCall } from "../protocol/envelope.js";
import type { ToolCall } from "@tokenlighten/types";

export function taskPackRecoveryFor(
  args: Record<string, unknown>,
  canEchoQuery = true,
): { next?: ToolCall; retry: "new-task"; remaining?: string } {
  const query = canEchoQuery && typeof args["query"] === "string" ? args["query"].trim() : "";
  if (query.length === 0) {
    return {
      retry: "new-task",
      remaining: "no working set survives this call — resend tl_read_file with your original request text as query and task.epoch=\"new\" (canonical input; legacy mode is refused)",
    };
  }
  const cwd = typeof args["cwd"] === "string" && args["cwd"] !== "" ? args["cwd"] : undefined;
  return {
    next: canonicalToolCall("tl_read_file", {
      mode: "task_pack",
      query,
      ...(cwd !== undefined ? { cwd } : {}),
      task: { epoch: "new" },
    }),
    retry: "new-task",
  };
}
