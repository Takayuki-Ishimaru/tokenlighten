// Plain data output — no meta envelope. See docs/00-postmortem.md §2.2.
//
// extension.ts — activate / deactivate entry point.

import * as vscode from "vscode";
import { StatusBarManager } from "./statusBar.js";
import { WorkspaceWatcher } from "./watcher.js";
import { registerCommands, registerSetupCommand } from "./commands.js";
import { spawnTl } from "./cli.js";
import { registerMcpProvider } from "./mcpProvider.js";
import { registerControlCenter } from "./sidebar.js";
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
  statusBar?.dispose();
  statusBar = undefined;
}
