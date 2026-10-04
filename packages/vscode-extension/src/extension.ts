// Plain data output — no meta envelope. See docs/00-postmortem.md §2.2.
//
// extension.ts — activate / deactivate entry point.

import * as vscode from "vscode";
import { StatusBarManager } from "./statusBar.js";
import { WorkspaceWatcher } from "./watcher.js";
import { registerCommands, registerSetupCommand } from "./commands.js";
import { spawnTl } from "./cli.js";
import { registerMcpProvider } from "./mcpProvider.js";
import { registerHostActivation, removeOwnHostActivationOverrides } from "./hostActivation.js";
import { registerControlCenter } from "./sidebar.js";
import { checkForExtensionUpdate } from "./updateChecker.js";
import {
  invalidateWorkspaceConfigured,
  workspaceActivationState,
  workspaceActivationStateCached,
} from "./workspaceState.js";

let statusBar: StatusBarManager | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  statusBar = new StatusBarManager();
  const bar = statusBar;
  context.subscriptions.push({ dispose: () => statusBar?.dispose() });

  registerControlCenter(context);
  registerSetupCommand(context, bar);
  registerCommands(context, bar);
  registerMcpProvider(context);
  // The window-scoped off switch for a server VS Code launches from a managed
  // `.vscode/mcp.json`: syncs `tokenlighten.enabled` and the native-session
  // bypass into each folder's override file now, and on every change.
  registerHostActivation(context);
  void checkForExtensionUpdate(context);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("tokenlighten.language")) {
        bar.setActivationState(workspaceActivationStateCached());
      }
      if (event.affectsConfiguration("tokenlighten.enabled")) {
        invalidateWorkspaceConfigured();
        void workspaceActivationState().then((state) => {
          bar.setActivationState(state);
        });
      }
    }),
  );

  const state = await workspaceActivationState();
  bar.setActivationState(state);
  if (state !== "ready") return;

  const watcher = new WorkspaceWatcher(bar, spawnTl);
  context.subscriptions.push(watcher);
}

export function deactivate(): void {
  // This window's overrides end with it: a closed window must not leave a
  // folder's TokenLighten server switched off (the server also ignores a file
  // whose owner is gone, so a crash is covered too).
  removeOwnHostActivationOverrides();
  statusBar?.dispose();
  statusBar = undefined;
}
