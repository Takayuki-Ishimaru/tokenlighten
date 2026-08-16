import * as vscode from "vscode";
import { getMcpLaunchConfig } from "./cli.js";
import {
  onWorkspaceSetupStateChanged,
  workspaceMcpSettingsCached,
} from "./workspaceState.js";

export type HostMcpActivationState =
  | "active"
  | "native-bypass"
  | "not-configured"
  | "host-unsupported";

let nativeSessionBypass = false;
let definitionsChanged: vscode.EventEmitter<void> | undefined;

export function nativeSessionBypassEnabled(): boolean {
  return nativeSessionBypass;
}

export function setNativeSessionBypass(enabled: boolean): void {
  nativeSessionBypass = enabled;
  definitionsChanged?.fire();
  void vscode.commands.executeCommand(
    "setContext",
    "tokenlighten.mcpActivation",
    enabled ? "native-bypass" : "auto",
  );
}

function observeActivation(state: HostMcpActivationState): void {
  void vscode.commands.executeCommand(
    "setContext",
    "tokenlighten.mcpActivation",
    state,
  );
}

/**
 * Register TokenLighten directly with VS Code/Copilot. This avoids requiring
 * users to maintain a machine-specific .vscode/mcp.json just to use the CLI
 * bundled with this extension.
 */
export function registerMcpProvider(context: vscode.ExtensionContext): void {
  const packageVersion = typeof context.extension.packageJSON["version"] === "string"
    ? context.extension.packageJSON["version"]
    : "unknown";
  const changed = new vscode.EventEmitter<void>();
  definitionsChanged = changed;
  context.subscriptions.push(changed, {
    dispose: () => {
      if (definitionsChanged === changed) definitionsChanged = undefined;
    },
  });
  context.subscriptions.push(
    vscode.commands.registerCommand("tokenlighten.session.native", () => {
      setNativeSessionBypass(true);
      void vscode.window.showInformationMessage(
        "TokenLighten MCP is bypassed for this VS Code session. Native tools remain available.",
      );
    }),
    vscode.commands.registerCommand("tokenlighten.session.tl", () => {
      setNativeSessionBypass(false);
      void vscode.window.showInformationMessage(
        "TokenLighten MCP automatic activation resumed for this VS Code session.",
      );
    }),
  );
  context.subscriptions.push(
    onWorkspaceSetupStateChanged(() => changed.fire()),
  );
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => changed.fire()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("tokenlighten.enabled")) changed.fire();
    }),
  );
  const registerProvider = vscode.lm?.registerMcpServerDefinitionProvider;
  if (typeof registerProvider !== "function") {
    observeActivation("host-unsupported");
    return;
  }
  context.subscriptions.push(
    registerProvider.call(vscode.lm, "tokenlighten.mcp", {
      onDidChangeMcpServerDefinitions: changed.event,
      provideMcpServerDefinitions: () => {
        if (nativeSessionBypass) {
          observeActivation("native-bypass");
          return [];
        }
        const root = vscode.workspace.workspaceFolders?.[0];
        const settings = workspaceMcpSettingsCached();
        if (!root || !settings) {
          observeActivation("not-configured");
          return [];
        }
        observeActivation("active");
        const launch = getMcpLaunchConfig([
          "mcp",
          "start",
          "--stdio",
          ...(settings.writeEnabled ? ["--allow-write"] : []),
        ]);
        const definition = new vscode.McpStdioServerDefinition(
          "TokenLighten",
          launch.command,
          launch.args,
          {
            ...launch.env,
            TOKENLIGHTEN_CLIENT: "vscode",
            TOKENLIGHTEN_USAGE_LOG: settings.usageLoggingEnabled ? "on" : "off",
            TOKENLIGHTEN_ACTIVATION: "host-auto",
          },
          packageVersion,
        );
        definition.cwd = root.uri;
        return [definition];
      },
    }),
  );
}
