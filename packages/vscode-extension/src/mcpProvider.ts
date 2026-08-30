import * as vscode from "vscode";
import { getMcpLaunchConfig } from "./cli.js";
import {
  onWorkspaceSetupStateChanged,
  workspaceMcpSettingsCached,
} from "./workspaceState.js";
import { TOKENLIGHTEN_SCHEMA_STAMP } from "./generated/schemaStamp.js";

/**
 * globalState key recording the last schema stamp this install has
 * registered a definition under. VS Code MCP definition-cache mitigation
 * (v0.13.0): see packages/mcp-server/src/util/schemaStamp.ts for the full
 * incident/rationale — real-machine reproduction showed a bad cached tool
 * schema can wedge VS Code's MCP definition cache past a plain reload or
 * extension reinstall. globalState (not workspaceState) because the wedged
 * cache this mitigates is itself a per-installation, not per-workspace,
 * VS Code concern.
 */
const SCHEMA_STAMP_STATE_KEY = "tokenlighten.mcpSchemaStamp";

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
          // VS Code MCP definition-cache mitigation (v0.13.0): `version` is
          // an official VS Code contract — "If this changes, the editor
          // will indicate that tools have changed and prompt to refresh
          // them" (McpStdioServerDefinition.version doc comment,
          // @types/vscode). Combining the extension's own release version
          // with the schema stamp (packages/mcp-server/src/util/
          // schemaStamp.ts) keeps today's per-release change signal while
          // ALSO changing whenever the advertised tool schema content
          // itself changes, independent of whether that release happened to
          // bump the extension version.
          `${packageVersion}+${TOKENLIGHTEN_SCHEMA_STAMP}`,
        );
        definition.cwd = root.uri;
        return [definition];
      },
    }),
  );
  // VS Code MCP definition-cache mitigation (v0.13.0), continued: real-
  // machine reproduction showed that once VS Code's MCP definition cache is
  // wedged by a bad cached tool schema, neither a plain window reload nor an
  // extension reinstall reliably re-invokes provideMcpServerDefinitions()
  // soon enough to observe the new `version` above — only an explicit
  // onDidChangeMcpServerDefinitions fire (below) reliably forces VS Code to
  // re-poll immediately on THIS activation, rather than waiting on VS Code's
  // own eager-polling schedule. Fires only when a PREVIOUSLY recorded stamp
  // exists and differs from the current one — a first-ever activation has
  // nothing to have "changed" from, so it is left to the ordinary initial
  // registration above.
  const previousSchemaStamp = context.globalState.get<string>(SCHEMA_STAMP_STATE_KEY);
  void context.globalState.update(SCHEMA_STAMP_STATE_KEY, TOKENLIGHTEN_SCHEMA_STAMP);
  if (previousSchemaStamp !== undefined && previousSchemaStamp !== TOKENLIGHTEN_SCHEMA_STAMP) {
    changed.fire();
  }
}
