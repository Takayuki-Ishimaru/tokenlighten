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

// Copilot standard-setup evaluation (2026-10-02): which TokenLighten guide
// GitHub Copilot reads in this workspace (@tokenlighten/agents-md's
// copilotGuide.ts). `standalone` means Copilot does not attach AGENTS.md
// (the workspace's `chat.useAgentsMdFile` is false — written by this run, by
// an earlier one, or by the user) and `.github/copilot-instructions.md`
// carries the compact, self-contained guide; `agents-md` means Copilot reads
// AGENTS.md and the Copilot file is a pointer to it; `manual` means
// `.vscode/settings.json` could not be safely read or edited (JSONC, a
// symlink, ...) and `reason` says what to add by hand; `not-applicable`
// means this run did not configure the vscode client.
export type CopilotGuideStatus = "standalone" | "agents-md" | "manual" | "not-applicable";

export interface CopilotGuideReport {
  status: CopilotGuideStatus;
  /** Absolute path to the workspace's `.vscode/settings.json`, when relevant. */
  settingsFile?: string;
  /** Attachment settings this run set to `false` (only ever `chat.useAgentsMdFile`). */
  settingsWritten?: readonly string[];
  /**
   * Attachment settings this run removed: TokenLighten had set them, and they
   * no longer apply (`chat.useAgentsMdFile`), or it no longer writes them (the
   * legacy `chat.useClaudeMdFile` an earlier build wrote).
   */
  settingsRemoved?: readonly string[];
  /**
   * Absolute paths of the `.code-workspace` files (in the workspace root or its
   * parent) that list this folder, set only when `status` is `standalone`.
   * VS Code ignores the folder's `chat.useAgentsMdFile` while the folder is
   * opened through such a file: the value has to be in the workspace file.
   * Setup never edits those files.
   */
  workspaceFiles?: readonly string[];
  /** Why the requested guide did not result, or what to do by hand for `manual`. */
  reason?: string;
}

export interface TokenLightenWorkspaceSetupResult {
  schemaVersion: 1;
  workspaceRoot: string;
  clients: readonly TokenLightenSetupClient[];
  /** Whether all selected clients allow writes. */
  writeEnabled: boolean;
  /** Present when selected clients have different write permissions. */
  writeEnabledByClient?: Partial<Record<TokenLightenSetupClient, boolean>>;
  usageLoggingEnabled: true;
  rulesWritten: readonly string[];
  configFilesWritten: readonly string[];
  warnings: readonly string[];
  /** Setup introduced Codex's default startup grace value where none existed. */
  managedCodexStartupGrace?: boolean;
  /** Setup created `.codex/config.toml` because it did not previously exist. */
  codexConfigCreated?: boolean;
  /** Setup created `.vscode/settings.json` because it did not previously exist. */
  copilotSettingsCreated?: boolean;
  /** Absolute paths of setup outputs that did not exist before this run. */
  createdFiles?: readonly string[];
  /* DESIGN copilot-inline-results: absent only for a schema that predates
   * this field — a real setup run always populates it (see workspace.ts). */
  copilotInlineResults?: CopilotInlineResultsReport;
  /** Copilot standard-setup evaluation (2026-10-02); absent only for a schema that predates it. */
  copilotGuide?: CopilotGuideReport;
}

export interface TokenLightenWorkspaceSummary {
  workspaceRoot: string;
  clients: readonly TokenLightenSetupClient[];
  writeEnabled: boolean;
  /** Per-client posture for mixed permissions; absent in older uniform entries. */
  writeEnabledByClient?: Partial<Record<TokenLightenSetupClient, boolean>>;
  usageLoggingEnabled: boolean;
  configFilesWritten: readonly string[];
  updatedAt: string;
}

export interface TokenLightenWorkspaceListResult {
  schemaVersion: 1;
  workspaces: readonly TokenLightenWorkspaceSummary[];
}
