import type { TokenLightenSetupClient } from "./setup.js";

/**
 * Agent hooks (2026-11-03): the contracts the CLI's hook adapters and
 * installer share with the MCP server's compaction check. Kept here so the
 * two packages never carry a second spelling of the same path.
 */

/**
 * The compaction marker: one small JSON file in the workspace's private
 * runtime directory, rewritten atomically by `tl hook pre-compact` /
 * `tl hook session-start` (any client) and `stat`ed by the MCP server on every
 * tool call. A changed stat signature means a host compacted or cleared its
 * conversation since this server process last looked, so every claim of
 * "the client already holds these bytes" is dropped (over-resetting costs a
 * re-send; under-resetting costs a held receipt for content the model lost).
 */
export const COMPACTION_MARKER_RELATIVE_PATH = ".tokenlighten/.runtime/compaction-epoch.json";

/** The marker's body. `epoch` only grows; the server compares the stat, not the body. */
export interface CompactionMarker {
  schemaVersion: 1;
  epoch: number;
  /** ISO-8601 time of the write. */
  at: string;
  /** The hook event that wrote it (`pre-compact`, `post-compact`, `session-start`). */
  event: string;
  /** The host's own reason when it sends one (`compact`, `clear`, `new`, `manual`, `auto`). */
  source?: string;
  /** The adapter that wrote it (`claude-code`, `codex`, `copilot`). */
  client?: string;
}

/** Hook adapters `tl hook` offers; `copilot` covers Copilot CLI and VS Code's `.github/hooks`. */
export type AgentHookClient = "claude-code" | "codex" | "copilot";

/**
 * Hook events `tl hook <event>` handles, in TokenLighten's own spelling.
 * `post-tool-use` (2026-11-03) is the Claude Code and Copilot output
 * compression after the command ran; `pre-tool-use` prints nothing for every
 * client, so a hook file from an earlier install stays harmless.
 */
export type AgentHookEvent = "pre-tool-use" | "post-tool-use" | "pre-compact" | "post-compact" | "session-start";

/** What one setup client's hook configuration carries after setup installed the hooks (the default). */
export interface AgentHooksClientReport {
  client: TokenLightenSetupClient;
  /** The configuration file written or cleaned, when the run touched one. */
  file?: string;
  /** The hook events now configured for this client. */
  events: readonly string[];
  /** Capabilities this client's documented hook contract does not offer (never faked). */
  unsupported: readonly string[];
}

/** The agent-hook outcome of one workspace setup: installed (the default) or removed (`--remove-hooks`). */
export interface AgentHooksReport {
  action: "installed" | "removed";
  clients: readonly AgentHooksClientReport[];
  /** Files that became `{}` after a removal; the caller may delete those it created. */
  emptied: readonly string[];
  warnings: readonly string[];
}
