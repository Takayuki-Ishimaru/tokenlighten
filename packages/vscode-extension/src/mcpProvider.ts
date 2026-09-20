import * as vscode from "vscode";
import {
  COPILOT_LARGE_RESULTS_SECTION,
  isCopilotInlineResultsSufficient,
} from "./diagnostics.js";
import {
  machineInstallCached,
  onWorkspaceSetupStateChanged,
  vscodeMcpJsonManaged,
  workspaceMcpSettingsCached,
  type WorkspaceMcpSettings,
} from "./workspaceState.js";
import { TOKENLIGHTEN_SCHEMA_STAMP } from "./generated/schemaStamp.js";

/**
 * Safe defaults for a "never-set-up" workspace's fallback definition
 * (DESIGN-v0.14-mcp-only-install.md §4.6 C5): no explicit consent for
 * writes or usage logging has been recorded for this workspace (that only
 * happens via "Set up this workspace"), so the fallback stays read-only
 * and does not record local usage until the user opts in.
 */
const FALLBACK_WORKSPACE_SETTINGS: WorkspaceMcpSettings = {
  writeEnabled: false,
  usageLoggingEnabled: false,
};

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
  | "host-unsupported"
  | "file-managed";

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
      // DESIGN-v0.15 §8.2 (R7 Part B): the tool surface is fixed per
      // connection (server.ts's ACTIVE_TOOL_SURFACE, resolved once at
      // process start) — a setting change needs a NEW server process, which
      // only happens if this fires a definitions-changed event so VS Code
      // re-registers (and the `version` string below actually changed, or
      // this fire is a no-op).
      if (
        event.affectsConfiguration("tokenlighten.enabled")
        || event.affectsConfiguration("tokenlighten.toolSurface")
        // The never-set-up fallback below also folds this setting into its
        // own env/version (TOKENLIGHTEN_TASK_PACK_MAX_BYTES / `+inline`) —
        // a change here needs the same re-registration as toolSurface.
        || event.affectsConfiguration(COPILOT_LARGE_RESULTS_SECTION)
      ) changed.fire();
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
        if (!root) {
          observeActivation("not-configured");
          return [];
        }
        // DESIGN-v0.14-mcp-only-install.md §4.6 C5: VS Code identifies a
        // server by (collectionId, definitionId) and treats the label as a
        // case-insensitive COLLISION key — a set-up workspace's
        // `.vscode/mcp.json` (sort order 0) always outranks this provider
        // (order 300), so registering a definition here too just gets it
        // silently auto-disabled (vscode#334069) while looking "inert" to
        // the user. Suppress entirely once the file carries a managed
        // entry; only a workspace that was NEVER set up gets a provider
        // fallback definition below.
        if (vscodeMcpJsonManaged(root.uri.fsPath)) {
          observeActivation("file-managed");
          return [];
        }
        // DESIGN-v0.14-mcp-only-install.md §4.6 C5, hands-on report
        // (2026-09-08): a never-set-up workspace only gets a fallback
        // definition when this MACHINE already has a `tl-setup`/`tl install`
        // machine install (checked via the cached record, never a fresh
        // spawn from provideMcpServerDefinitions()). Without one, the VSIX
        // alone has nothing durable to launch here — falling back to VS
        // Code's own bundled CLI under Electron (getMcpLaunchConfig) would
        // start a TokenLighten MCP server, and pay its tool-definition
        // tokens, in EVERY folder the user opens, merely from installing the
        // extension, with no guide block and no recorded consent. Report
        // "not-configured" exactly as the no-workspace-folder case above.
        const machineInstall = machineInstallCached();
        if (!machineInstall) {
          observeActivation("not-configured");
          return [];
        }
        observeActivation("active");
        // DESIGN-v0.15 §8.2 (R7 Part B): resource-scoped so a multi-root
        // workspace can carry a per-folder value, matching guideProfile's
        // own scope. Read fresh on every provideMcpServerDefinitions() call
        // (VS Code re-invokes this on definitions-changed, which the
        // configuration-change listener above fires for this exact key) —
        // never cached across calls, so a setting change is reflected on
        // the very next reconnect.
        const toolSurface = vscode.workspace
          .getConfiguration("tokenlighten", root.uri)
          .get<string>("toolSurface", "full");
        // A never-set-up workspace has no recorded consent to WRITE any
        // setting (that only happens via "Set up this workspace"/`tl
        // workspace setup`), so this only ever READS Copilot's current
        // effective large-tool-result setting, never raises it itself.
        // "Sufficient" mirrors ensureCopilotSettings()'s alreadySufficient
        // check in packages/cli/src/commands/workspace.ts — see
        // diagnostics.ts's isCopilotInlineResultsSufficient doc comment.
        // vscode.workspace.getConfiguration can be absent/throw on an odd
        // host, or in a test double that only stubs the sections it
        // exercises — either way, treat that as "not sufficient" and keep
        // today's (un-linked) launch env/version untouched.
        let copilotInlineResultsSufficient: boolean;
        try {
          const copilotConfig = vscode.workspace.getConfiguration(COPILOT_LARGE_RESULTS_SECTION, root.uri);
          copilotInlineResultsSufficient = isCopilotInlineResultsSufficient({
            enabled: copilotConfig.get<boolean>("enabled", true),
            thresholdBytes: copilotConfig.get<number>("thresholdBytes", 8192),
          });
        } catch {
          copilotInlineResultsSufficient = false;
        }
        // A never-set-up workspace has no recorded write/usage-log
        // consent (workspaceMcpSettingsCached() only populates once "Set
        // up this workspace" has run) — fall back to safe, read-only,
        // no-logging defaults. If the workspace DOES happen to be
        // configured (e.g. the managed file was removed by hand after
        // setup), reuse its recorded settings instead of resetting them.
        const settings = workspaceMcpSettingsCached() ?? FALLBACK_WORKSPACE_SETTINGS;
        const mcpArgs = [
          "mcp",
          "start",
          "--stdio",
          ...(settings.writeEnabled ? ["--allow-write"] : []),
          // Omitted (not merely "full") for the common case — matches every
          // other optional flag here (--allow-write above).
          ...(toolSurface === "code" ? ["--tool-surface", "code"] : []),
        ];
        // DESIGN-v0.14-mcp-only-install.md §4.6 C5: a never-set-up
        // workspace on a machine that already ran `tl-setup`/`tl install`
        // gets that machine-scoped, version-independent identity — the
        // `machineInstall` presence check above guarantees this is defined.
        const launch = {
          command: machineInstall.identity.command,
          args: [...machineInstall.identity.argsPrefix, ...mcpArgs],
          env: machineInstall.identity.env,
        };
        const definition = new vscode.McpStdioServerDefinition(
          "TokenLighten",
          launch.command,
          launch.args,
          {
            ...launch.env,
            TOKENLIGHTEN_CLIENT: "vscode",
            // GitHub Copilot Chat fixed-overhead reduction (WP-C1): pins the
            // VS Code advertisement profile (protocol/clientAdvertisement.ts)
            // even on a transport leg that never threads a real
            // clientInfo.name through to resolvedClientId(), and turns on
            // the server's default-OFF turn-economy serving policies
            // (util/flags.ts's turnEconomyEnabled()) for this host only.
            // Unconditional, like TOKENLIGHTEN_CLIENT above — never gated on
            // copilotInlineResultsSufficient.
            TOKENLIGHTEN_CLIENT_ID: "vscode",
            TL_TURN_ECONOMY: "1",
            TOKENLIGHTEN_USAGE_LOG: settings.usageLoggingEnabled ? "on" : "off",
            TOKENLIGHTEN_ACTIVATION: "host-auto",
            // Lifts TL's own client-profile response ceiling (14,336 bytes)
            // to match Copilot's now-sufficient inline threshold — the same
            // pairing `tl workspace setup` writes, see
            // packages/cli/src/commands/workspace.ts. Present only when
            // copilotInlineResultsSufficient; this read-only fallback path
            // never writes any setting itself.
            ...(copilotInlineResultsSufficient ? { TOKENLIGHTEN_TASK_PACK_MAX_BYTES: "0" } : {}),
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
          // bump the extension version. DESIGN-v0.15 §8.2 (R7 Part B): the
          // literal `toolSurface` setting value is ALSO folded in — the
          // baked-in TOKENLIGHTEN_SCHEMA_STAMP is computed once at this
          // extension's BUILD time under the full surface, so it alone
          // would not change when a user only toggles this per-workspace
          // setting; appending the setting's own value guarantees the
          // `version` string changes on every surface toggle too, the exact
          // property this cache-invalidation contract requires. The
          // trailing `+inline` marker (same mechanism) changes whenever the
          // Copilot link state above flips, so VS Code restarts the server
          // with the (un)linked env in step with it.
          `${packageVersion}+${TOKENLIGHTEN_SCHEMA_STAMP}+${toolSurface}${copilotInlineResultsSufficient ? "+inline" : ""}`,
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
