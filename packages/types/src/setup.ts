export type TokenLightenSetupClient = "vscode" | "codex" | "claude-code";

// VS Code Copilot Chat hides any MCP tool result over its own
// "large tool results to disk" threshold (default 8192 bytes) from the
// model, which makes an agent abandon TokenLighten mid-task. `raised` means
// this setup run wrote a higher threshold into the workspace's
// `.vscode/settings.json`; `already-sufficient` means the file already had
// an adequate value and was left untouched; `manual` means the file exists
// but could not be safely edited (not strict JSON, e.g. JSONC comments) —
// `reason` names the exact key/value to add by hand; `kept` means the
// caller opted out (`--copilot-inline-results keep`) and nothing was
// touched; `not-applicable` means this setup run did not configure the
// vscode client at all.
export type CopilotInlineResultsStatus =
  | "raised"
  | "already-sufficient"
  | "manual"
  | "kept"
  | "not-applicable";

export interface CopilotInlineResultsReport {
  status: CopilotInlineResultsStatus;
  /** Absolute path to the workspace's `.vscode/settings.json`, when relevant. */
  settingsFile?: string;
  /** The threshold this setup run wrote or found (raised/already-sufficient). */
  thresholdBytes?: number;
  /** The threshold that was in place before this run raised it, if any. */
  previousThresholdBytes?: number;
  /** Human-readable explanation, populated for `manual`. */
  reason?: string;
}

export interface TokenLightenWorkspaceSetupResult {
  schemaVersion: 1;
  workspaceRoot: string;
  clients: readonly TokenLightenSetupClient[];
  writeEnabled: true;
  usageLoggingEnabled: true;
  rulesWritten: readonly string[];
  configFilesWritten: readonly string[];
  warnings: readonly string[];
  /* DESIGN copilot-inline-results: absent only for a schema that predates
   * this field — a real setup run always populates it (see workspace.ts). */
  copilotInlineResults?: CopilotInlineResultsReport;
}

export interface TokenLightenWorkspaceSummary {
  workspaceRoot: string;
  clients: readonly TokenLightenSetupClient[];
  writeEnabled: boolean;
  usageLoggingEnabled: boolean;
  configFilesWritten: readonly string[];
  updatedAt: string;
}

export interface TokenLightenWorkspaceListResult {
  schemaVersion: 1;
  workspaces: readonly TokenLightenWorkspaceSummary[];
}
