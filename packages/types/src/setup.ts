export type TokenLightenSetupClient = "vscode" | "codex" | "claude-code";

export interface TokenLightenWorkspaceSetupResult {
  schemaVersion: 1;
  workspaceRoot: string;
  clients: readonly TokenLightenSetupClient[];
  writeEnabled: true;
  usageLoggingEnabled: true;
  rulesWritten: readonly string[];
  configFilesWritten: readonly string[];
  warnings: readonly string[];
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
