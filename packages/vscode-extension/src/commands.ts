// Plain data output — no meta envelope. See docs/00-postmortem.md §2.2.
//
// commands.ts — workspace setup and local usage controls.

import * as vscode from "vscode";
import { spawnTl } from "./cli.js";
import { showDiagnosticsPanel } from "./diagnosticsPanel.js";
import {
  getDisplayLanguage,
  getTokenLightenConfiguration,
  getTokenLightenConfigurationTarget,
} from "./statusBar.js";
import type { StatusBarManager } from "./statusBar.js";
import {
  invalidateWorkspaceConfigured,
  setWorkspaceConfigured,
  workspaceActivationState,
  workspaceMcpSettingsCached,
} from "./workspaceState.js";
import type { WorkspaceActivationState } from "./workspaceState.js";
// T3 (v0.13 review-fix wave): use the canonical GuideProfile export instead
// of re-declaring the same three-literal union locally. `import type` only
// -- it is erased entirely at compile time (never a runtime require of the
// package root), so this is unaffected by the CJS/import.meta.url bundling
// hazard that keeps diagnostics.ts's RUNTIME imports (INSTRUCTIONS_VERSION,
// parseSentinelBlock) on the /version and /sentinel subpaths instead of the
// package root -- see that file's own header comment.
import type { GuideProfile } from "@tokenlighten/agents-md";
// P2-3(1): a RUNTIME import, so — same reason as diagnostics.ts's
// INSTRUCTIONS_VERSION/parseSentinelBlock above — it must come from the
// dedicated /guideProfileDefault subpath, not the package root (whose
// index.js re-exports render.ts, which throws at module load under the
// esbuild CJS bundle; see guideProfileDefault.ts's own header comment).
import { defaultGuideProfileForSurface } from "@tokenlighten/agents-md/guideProfileDefault";
import {
  agentsMdHoldsOnlyTokenLighten,
  agentsMdPresent,
  copilotGuideIsStandalone,
  predictStandaloneCopilotGuide,
  predictStandaloneInWorkspaceFile,
} from "./copilotGuide.js";
import type { DisplayTier, MeasurementDisplayTiers } from "@tokenlighten/usage";

const firstLine = (s: string) => s.split("\n")[0] ?? s;

function localized(en: string, ja: string): string {
  return getDisplayLanguage() === "ja" ? ja : en;
}

/**
 * DESIGN-v0.14-mcp-only-install.md §4.2/§4.6 C2: "Set up this workspace" now
 * runs `tl install --from-extension` instead of `tl workspace setup`
 * directly. `--from-extension` stages the VSIX's bundled tree the same way
 * `tl-setup` stages an archive (§4.6 C2 "same landing zone"), and
 * `--workspace <root>` still runs the per-workspace step
 * (`.vscode/mcp.json` / `.mcp.json` / `.codex/config.toml` / guide blocks)
 * exactly as `tl workspace setup` did. `--clients none` keeps MACHINE-WIDE
 * vendor-CLI registration (Claude Code, Codex user scope) opt-in through
 * the extension's own clients UI, not bundled into every "Set up this
 * workspace" click — it does not affect the workspace files written by
 * install's workspace step.
 */
export function workspaceSetupArgs(
  root: string,
  profile: GuideProfile = "full",
  toolSurface?: "full" | "code",
  // Undefined (the default "Set up TokenLighten" button) omits the flag —
  // `tl install` itself already defaults to "raise" — so this function's
  // default invocation stays byte-for-byte what the existing exact-array
  // test expects. Only "keep" (the modal's second button) ever appends it.
  copilotInlineResults?: "raise" | "keep",
  // Copilot standard-setup evaluation (2026-10-02): undefined is `tl
  // install`'s own default ("standalone") and appends nothing, for the same
  // byte-for-byte reason as `copilotInlineResults` above.
  copilotGuide?: "agents-md" | "keep",
): string[] {
  return [
    "install",
    "--from-extension",
    "--workspace",
    root,
    "--clients",
    "none",
    "--yes",
    "--json",
    "--guide-profile",
    profile,
    // DESIGN-v0.15 §8.2 (R7 Part B): omitted (not merely "full") when the
    // caller did not pass one — matches every other optional-flag call site
    // this wave touches, and keeps this function's default invocation
    // (and its existing exact-array test) byte-for-byte unchanged.
    ...(toolSurface !== undefined ? ["--tool-surface", toolSurface] : []),
    ...(copilotInlineResults === "keep" ? ["--copilot-inline-results", "keep"] : []),
    ...(copilotGuide !== undefined ? ["--copilot-guide", copilotGuide] : []),
  ];
}

/**
 * The relevant subset of `tl install --json`'s report envelope
 * (`packages/cli/src/commands/install.ts`'s `InstallReport`, wrapped in
 * `{ok, exitCode, report?, message?}` by `runInstall`) — only the fields
 * this extension actually reads.
 */
interface TlInstallJsonResult {
  ok?: unknown;
  exitCode?: unknown;
  message?: unknown;
  report?: {
    writePosture?: unknown;
    workspaces?: Array<{
      copilotInlineResults?: {
        status?: unknown;
        reason?: unknown;
      };
      copilotGuide?: {
        status?: unknown;
        reason?: unknown;
      };
    }>;
  };
}

function parseTlInstallJson(stdout: string): TlInstallJsonResult | null {
  try {
    const parsed: unknown = JSON.parse(stdout);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as TlInstallJsonResult
      : null;
  } catch {
    return null;
  }
}

export function registerSetupCommand(
  context: vscode.ExtensionContext,
  bar: StatusBarManager,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("tokenlighten.setup", () => {
      void setupWorkspace(bar, context);
    }),
  );
}

export function statusMessage(state: WorkspaceActivationState): string {
  if (state === "ready") return localized(
    "TokenLighten is active in this workspace",
    "このワークスペースでTokenLightenは有効です",
  );
  if (state === "not-configured") return localized(
    "TokenLighten is not set up in this workspace",
    "このワークスペースではTokenLightenが未設定です",
  );
  if (state === "unavailable") return localized(
    "TokenLighten: tl binary not found — install tl and reload the window",
    "TokenLighten: tlバイナリが見つかりません。インストール後にウィンドウを再読み込みしてください",
  );
  if (state === "untrusted") return localized(
    "TokenLighten is disabled in untrusted workspaces",
    "信頼されていないワークスペースではTokenLightenは無効です",
  );
  if (state === "no-workspace") return localized(
    "Open a workspace folder to set up TokenLighten",
    "TokenLightenを設定するワークスペースフォルダーを開いてください",
  );
  return localized(
    "TokenLighten is disabled in this workspace",
    "このワークスペースではTokenLightenは無効です",
  );
}

export function registerCommands(
  context: vscode.ExtensionContext,
  bar?: StatusBarManager,
): void {
  const reg = (id: string, fn: () => void) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg("tokenlighten.status", () => {
    void showStatusMenu(context, bar);
  });
  reg("tokenlighten.usage.show", () => { void showUsageDashboard(context); });
  reg("tokenlighten.logs.export", () => { void exportUsageLogs(); });
  reg("tokenlighten.uninstallMachine", () => { void uninstallMachine(context); });
  reg("tokenlighten.copilotGuide.applyToWorkspaceFile", () => { void applyCopilotGuideToWorkspaceFile(context); });
}

// ---------------------------------------------------------------------------
// Copilot guide in a window opened through a `.code-workspace` file (Copilot
// standard-setup retest, 2026-10-02). VS Code registers `chat.useAgentsMdFile`
// window-scoped (and restricted): the `false` `tl install` writes to the
// folder's own .vscode/settings.json is IGNORED there — only the workspace
// file's `settings` (or the user's) apply — so Copilot would keep attaching
// AGENTS.md (the full guide) next to the compact one in
// .github/copilot-instructions.md. The CLI therefore only names such files
// (it never edits one); this extension writes the workspace-level value, after
// the user confirms, through the settings API (`ConfigurationTarget.Workspace`,
// which VS Code routes to the workspace file's `settings`). The value applies to
// EVERY folder of the workspace, so it is written only while each folder's
// AGENTS.md is absent or holds nothing but TokenLighten's block, and every
// folder that has an AGENTS.md reads the compact standalone guide (otherwise its
// Copilot file is only the pointer to the AGENTS.md the value would hide). The
// file it was written to is recorded in `context.workspaceState` so exactly that
// value — never one the user wrote — can be withdrawn.
// ---------------------------------------------------------------------------

/** `context.workspaceState` key: the `.code-workspace` file whose `chat.useAgentsMdFile` this extension set (removed with the value). */
export const WORKSPACE_FILE_SETTING_KEY = "tokenlighten.copilotGuide.workspaceFileSetting";

/** What `applyCopilotGuideToWorkspaceFile` did, for the callers and tests. */
export type WorkspaceFileApplyOutcome =
  | "not-applicable"
  | "refused"
  | "kept"
  | "already-applied"
  | "declined"
  | "applied"
  | "failed";

/** The window's `.code-workspace` file when it is a local file; an untitled or remote workspace has none this extension can write. */
function localWorkspaceFile(): vscode.Uri | undefined {
  const file = vscode.workspace.workspaceFile;
  return file?.scheme === "file" ? file : undefined;
}

/** `chat.useAgentsMdFile` as the workspace (the workspace file's `settings`) holds it. */
function workspaceFileAgentsMdValue(): boolean | undefined {
  return vscode.workspace.getConfiguration("chat").inspect<boolean>("useAgentsMdFile")?.workspaceValue;
}

/**
 * Removes the workspace-level `chat.useAgentsMdFile` this extension set, when
 * the record names THIS window's workspace file and the value is still the
 * `false` it wrote; a value the user has changed since is theirs, and only the
 * record goes. Returns whether a value was removed.
 */
export async function withdrawCopilotGuideFromWorkspaceFile(context: vscode.ExtensionContext): Promise<boolean> {
  const file = localWorkspaceFile();
  if (file === undefined) return false;
  const recorded = context.workspaceState.get<string>(WORKSPACE_FILE_SETTING_KEY);
  if (recorded === undefined || recorded !== file.fsPath) return false;
  const stillOurs = workspaceFileAgentsMdValue() === false;
  try {
    if (stillOurs) {
      await vscode.workspace.getConfiguration("chat").update("useAgentsMdFile", undefined, vscode.ConfigurationTarget.Workspace);
    }
  } finally {
    await context.workspaceState.update(WORKSPACE_FILE_SETTING_KEY, undefined);
  }
  return stillOurs;
}

/**
 * `tokenlighten.copilotGuide.applyToWorkspaceFile`: sets `chat.useAgentsMdFile`
 * to `false` in the window's `.code-workspace` file (see the section comment
 * above), after a modal confirmation naming that file. Refuses, writing
 * nothing and naming the folder, when a workspace folder's AGENTS.md holds the
 * user's own content, or when a folder that has an AGENTS.md does not read the
 * standalone guide (`copilotGuideModeForWorkspace`: its Copilot file is the
 * pointer to the AGENTS.md the setting would hide) — and then withdraws a value
 * this extension set earlier; a folder with no AGENTS.md is not checked. Leaves
 * a value the user wrote (`true`) alone; reports "already applied" for a `false`.
 */
export async function applyCopilotGuideToWorkspaceFile(
  context: vscode.ExtensionContext,
): Promise<WorkspaceFileApplyOutcome> {
  const file = localWorkspaceFile();
  if (file === undefined) {
    void vscode.window.showInformationMessage(localized(
      "TokenLighten: this window was not opened through a .code-workspace file, so there is no workspace file to update. A single-folder window uses its own .vscode/settings.json, which \"Set Up This Workspace\" writes.",
      "TokenLighten: このウィンドウは.code-workspaceファイルから開かれていないため、更新するワークスペースファイルがありません。単一フォルダーのウィンドウは自身の.vscode/settings.jsonを使い、「このワークスペースをセットアップ」がそれを書き込みます。",
    ));
    return "not-applicable";
  }
  const folders = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
  // Refuses without writing. A value this extension set earlier no longer
  // applies either (the workspace-level value covers every folder), so it goes.
  const refuse = async (en: string, ja: string): Promise<WorkspaceFileApplyOutcome> => {
    const withdrawn = await withdrawCopilotGuideFromWorkspaceFile(context).catch(() => false);
    void vscode.window.showWarningMessage(localized(
      en + (withdrawn ? " TokenLighten also removed the chat.useAgentsMdFile it had set there earlier." : ""),
      ja + (withdrawn ? "以前そこに設定したchat.useAgentsMdFileも削除しました。" : ""),
    ));
    return "refused";
  };
  // The workspace-level value would hide this folder's own AGENTS.md from Copilot.
  const userOwned = folders.find((folder) => !agentsMdHoldsOnlyTokenLighten(folder));
  if (userOwned !== undefined) {
    return refuse(
      `TokenLighten: not applied. ${userOwned} has an AGENTS.md with your own content, and the setting in ${file.fsPath} would hide it from GitHub Copilot in every folder of this workspace.`,
      `TokenLighten: 適用しませんでした。${userOwned}のAGENTS.mdにはユーザー自身の内容があり、${file.fsPath}に設定すると、このワークスペースのすべてのフォルダーでGitHub Copilotからそれが見えなくなります。`,
    );
  }
  // ...and it would hide the TokenLighten guide from a folder whose Copilot
  // file is only the pointer to that AGENTS.md. A folder with no AGENTS.md hides nothing.
  const readsPointer = folders.find((folder) => agentsMdPresent(folder) && !copilotGuideIsStandalone(folder));
  if (readsPointer !== undefined) {
    return refuse(
      `TokenLighten: not applied. ${readsPointer} has an AGENTS.md but its Copilot guide is not the compact one (its .vscode/settings.json does not set chat.useAgentsMdFile to false), so the setting in ${file.fsPath} would leave GitHub Copilot without TokenLighten's guide there. Set that folder up with the standalone guide first.`,
      `TokenLighten: 適用しませんでした。${readsPointer}にはAGENTS.mdがありますが、そのフォルダーのCopilotガイドはコンパクト版ではなく（.vscode/settings.jsonでchat.useAgentsMdFileがfalseになっていません）、${file.fsPath}に設定するとそこではGitHub CopilotがTokenLightenのガイドを読めなくなります。先にそのフォルダーをstandaloneガイドでセットアップしてください。`,
    );
  }
  const current = workspaceFileAgentsMdValue();
  if (current === false) {
    void vscode.window.showInformationMessage(localized(
      `TokenLighten: chat.useAgentsMdFile is already false in ${file.fsPath}; nothing to apply.`,
      `TokenLighten: ${file.fsPath}ではchat.useAgentsMdFileがすでにfalseです。適用するものはありません。`,
    ));
    return "already-applied";
  }
  if (current === true) {
    // A value the user wrote is never overridden (the CLI's rule for the folder file too).
    void vscode.window.showInformationMessage(localized(
      `TokenLighten: ${file.fsPath} sets chat.useAgentsMdFile to true, so GitHub Copilot attaches AGENTS.md in this window; TokenLighten does not override your value.`,
      `TokenLighten: ${file.fsPath}ではchat.useAgentsMdFileがtrueに設定されているため、このウィンドウではGitHub CopilotがAGENTS.mdを添付します。TokenLightenはユーザーの設定値を上書きしません。`,
    ));
    return "kept";
  }
  const confirm = localized("Apply to workspace file", "ワークスペースファイルに適用");
  const choice = await vscode.window.showInformationMessage(
    localized(
      `Set chat.useAgentsMdFile to false in ${file.fsPath}? VS Code ignores a folder's own .vscode/settings.json for this setting when the folder is opened through a .code-workspace file, so without it GitHub Copilot keeps attaching AGENTS.md (the full TokenLighten guide) next to the compact guide in .github/copilot-instructions.md. It applies to every folder of this workspace (none has an AGENTS.md of your own, and each folder with an AGENTS.md reads the compact guide) and is removed again if that stops being true, when you set up with the agents-md guide, and when TokenLighten is uninstalled.`,
      `${file.fsPath}のchat.useAgentsMdFileをfalseにしますか？.code-workspaceファイルからフォルダーを開いている場合、VS Codeはこの設定についてフォルダー自身の.vscode/settings.jsonを無視するため、設定しないとGitHub Copilotは.github/copilot-instructions.mdのコンパクトなガイドに加えてAGENTS.md（TokenLightenの完全版ガイド）も添付し続けます。この設定はワークスペースのすべてのフォルダーに適用されます（どのフォルダーにもユーザー自身のAGENTS.mdはなく、AGENTS.mdのあるフォルダーはすべてコンパクト版ガイドを読みます）。これが成り立たなくなったとき、agents-mdガイドでセットアップしたとき、TokenLightenをアンインストールしたときに、あらためて削除されます。`,
    ),
    { modal: true },
    confirm,
  );
  if (choice !== confirm) return "declined";
  try {
    await vscode.workspace.getConfiguration("chat").update("useAgentsMdFile", false, vscode.ConfigurationTarget.Workspace);
    // Recorded only once the value is written: a record that outlived a failed
    // write could later withdraw a `false` the user wrote.
    await context.workspaceState.update(WORKSPACE_FILE_SETTING_KEY, file.fsPath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(localized(
      `TokenLighten could not update ${file.fsPath}: ${detail}`,
      `TokenLightenは${file.fsPath}を更新できませんでした: ${detail}`,
    ));
    return "failed";
  }
  void vscode.window.showInformationMessage(localized(
    `TokenLighten: chat.useAgentsMdFile is now false in ${file.fsPath}; GitHub Copilot no longer attaches AGENTS.md in this window.`,
    `TokenLighten: ${file.fsPath}のchat.useAgentsMdFileをfalseにしました。このウィンドウではGitHub CopilotがAGENTS.mdを添付しなくなります。`,
  ));
  return "applied";
}

/**
 * DESIGN-v0.14-mcp-only-install.md §4.6 C10: "Removing the VSIX leaves the
 * machine install; `tl install --uninstall` (also exposed as an extension
 * command) removes it." Machine-scoped (not tied to any open workspace), so
 * this is spawned without a `cwd` — unlike setupWorkspace's `--workspace`
 * flow. Modal confirmation because uninstalling is destructive and affects
 * every workspace/host this machine's `tl install` reaches, not just the
 * current one. With the extension `context`, a successful uninstall also
 * withdraws the workspace-file `chat.useAgentsMdFile` this extension set for
 * the window that is open (best effort; see the `.code-workspace` section above).
 */
export async function uninstallMachine(context?: vscode.ExtensionContext): Promise<void> {
  const confirmLabel = localized("Uninstall TokenLighten", "TokenLightenをアンインストール");
  const choice = await vscode.window.showWarningMessage(
    localized(
      "Uninstall TokenLighten from this machine? This removes the machine-scoped install (staged runtime, host identity) and managed host registrations (Claude Code, Codex). It also removes TokenLighten's managed guide blocks and managed MCP entries from every workspace this install set up (a .tl-backup copy is kept next to each edited MCP file); your own content and other servers' entries stay untouched.",
      "このマシンからTokenLightenをアンインストールしますか？マシン単位のインストール（ステージ済みランタイムとホストID）と管理対象のホスト登録（Claude Code、Codex）に加えて、このインストールがセットアップした各ワークスペースのTokenLighten管理ブロックと管理対象のMCPエントリも削除されます（編集したMCPファイルのそばに.tl-backupのコピーを保持します）。独自に記述した内容や他のMCPサーバーのエントリはそのまま残ります。",
    ),
    { modal: true },
    confirmLabel,
  );
  if (choice !== confirmLabel) return;

  const result = await spawnTl(["install", "--uninstall", "--yes", "--json"]);
  const installJson = parseTlInstallJson(result.stdout);
  const succeeded = result.code === 0 && installJson?.ok === true;
  const summary = typeof installJson?.message === "string"
    ? installJson.message
    : firstLine(result.stderr || result.stdout);

  if (!succeeded) {
    vscode.window.showErrorMessage(localized(
      `TokenLighten uninstall failed: ${summary}`,
      `TokenLightenのアンインストールに失敗しました: ${summary}`,
    ));
    return;
  }
  // The uninstall removes the managed files and settings of every workspace it
  // set up, but VS Code's own workspace file is not among them: take back the
  // value this extension wrote there for the window that is open now.
  if (context !== undefined) {
    try {
      await withdrawCopilotGuideFromWorkspaceFile(context);
    } catch {
      // Best effort: a value left behind only keeps Copilot from attaching AGENTS.md.
    }
  }
  // G2: the status bar / sidebar / provider cached "this workspace is set
  // up" from the last probe — without this they kept saying so until the
  // next probe/reload even though the machine install (and every
  // workspace entry it owned) was just removed. The listeners this
  // notifies already refresh all three.
  invalidateWorkspaceConfigured();
  vscode.window.showInformationMessage(localized(
    `TokenLighten: ${summary}`,
    `TokenLighten: ${summary}`,
  ));
}

export async function enableWorkspace(): Promise<void> {
  await getTokenLightenConfiguration().update(
    "enabled",
    true,
    getTokenLightenConfigurationTarget(),
  );
}

export async function disableWorkspace(): Promise<void> {
  await getTokenLightenConfiguration().update(
    "enabled",
    false,
    getTokenLightenConfigurationTarget(),
  );
}

interface StatusMenuItem extends vscode.QuickPickItem {
  action: "diagnostics" | "enable" | "disable" | "setup" | "sidebar" | "uninstallMachine" | "status";
}

/**
 * tokenlighten.status now opens this menu instead of showing the old toast
 * directly — "Status" below replays exactly that toast. Enable/Disable/Set up
 * are mutually exclusive: only the one action that applies to the CURRENT
 * WorkspaceActivationState is offered, reusing enableWorkspace/
 * disableWorkspace/the existing tokenlighten.setup command rather than a new
 * write path.
 */
export async function showStatusMenu(
  context: vscode.ExtensionContext,
  bar?: StatusBarManager,
): Promise<void> {
  const state = await workspaceActivationState();
  bar?.setActivationState(state);

  const items: StatusMenuItem[] = [
    {
      action: "diagnostics",
      label: localized("Diagnostics", "診断"),
      description: localized(
        "Version, executable, write mode, registration, last call",
        "バージョン、実行ファイル、書き込みモード、登録状況、最終呼び出し",
      ),
    },
  ];
  if (state === "ready") {
    items.push({
      action: "disable",
      label: localized("Disable for This Workspace", "このワークスペースで無効化"),
    });
  } else if (state === "disabled") {
    items.push({
      action: "enable",
      label: localized("Enable for This Workspace", "このワークスペースで有効化"),
    });
  } else if (state === "not-configured") {
    items.push({
      action: "setup",
      label: localized("Set Up TokenLighten for This Workspace", "このワークスペースでTokenLightenをセットアップ"),
    });
  }
  items.push({
    action: "sidebar",
    label: localized("Open TokenLighten Sidebar", "TokenLightenサイドバーを開く"),
  });
  items.push({
    action: "uninstallMachine",
    label: localized("Uninstall TokenLighten from This Machine", "このマシンからTokenLightenをアンインストール"),
  });
  items.push({
    action: "status",
    label: localized("Status", "ステータス"),
    description: statusMessage(state),
  });

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: "TokenLighten",
  });
  if (!picked) return;

  switch (picked.action) {
    case "diagnostics":
      showDiagnosticsPanel(context);
      return;
    case "uninstallMachine":
      await uninstallMachine(context);
      return;
    case "enable":
      await enableWorkspace();
      bar?.setActivationState(await workspaceActivationState());
      return;
    case "disable":
      await disableWorkspace();
      bar?.setActivationState(await workspaceActivationState());
      return;
    case "setup":
      if (bar) await setupWorkspace(bar, context);
      return;
    case "sidebar":
      await vscode.commands.executeCommand("workbench.view.extension.tokenlighten-sidebar");
      return;
    case "status":
      void vscode.window.showInformationMessage(statusMessage(state));
      return;
  }
}

interface GuideProfileQuickPickItem extends vscode.QuickPickItem {
  profile: Extract<GuideProfile, "full" | "compact">;
}

/**
 * Sets up the first workspace folder through `tl install`. The extension
 * `context` is only needed in a window opened through a `.code-workspace`
 * file, where the Copilot guide's workspace-level setting is applied and
 * withdrawn (see the `.code-workspace` section above); without it that step is
 * skipped.
 */
export async function setupWorkspace(bar: StatusBarManager, context?: vscode.ExtensionContext): Promise<void> {
  if (!vscode.workspace.isTrusted) {
    vscode.window.showWarningMessage(localized(
      "TokenLighten: trust this workspace before running setup",
      "TokenLighten: セットアップ前にこのワークスペースを信頼してください",
    ));
    return;
  }
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    vscode.window.showWarningMessage(localized(
      "TokenLighten: no workspace folder is open",
      "TokenLighten: ワークスペースフォルダーが開かれていません",
    ));
    return;
  }
  const confirm = localized("Set up TokenLighten", "TokenLightenをセットアップ");
  // Second button: the user's consent to skip ONLY the Copilot setting
  // changes below (the inline-result limit, and the Copilot guide's
  // attachment settings) — everything else about setup (rules, MCP entries,
  // usage measurement) proceeds exactly as the first button.
  const keepCopilotSettings = localized(
    "Set up without changing Copilot settings",
    "Copilotの設定を変更せずにセットアップ",
  );
  const choice = await vscode.window.showInformationMessage(
    localized(
      "Set up or repair TokenLighten for VS Code, Copilot, Codex, and Claude Code in this workspace? Write tools and local privacy-safe usage measurement are enabled only for this workspace. Setup will also raise GitHub Copilot's inline tool-result limit for this workspace so Copilot can read TokenLighten's answers, and give Copilot a compact TokenLighten guide (.github/copilot-instructions.md) instead of attaching AGENTS.md while it holds only TokenLighten's block (both written to .vscode/settings.json).",
      "このワークスペースでVS Code、Copilot、Codex、Claude Code向けのTokenLighten設定をセットアップまたは修復しますか？書き込みツールとローカルのプライバシー保護使用量計測は、このワークスペースだけで有効になります。また、CopilotがTokenLightenの応答を読み取れるようにこのワークスペースのGitHub Copilotのインライン結果表示の上限を引き上げ、AGENTS.mdがTokenLightenのブロックだけのときは、それを添付する代わりにCopilot向けのコンパクトなTokenLightenガイド（.github/copilot-instructions.md）を使うようにします（どちらも.vscode/settings.jsonに書き込みます）。",
    ),
    { modal: true },
    confirm,
    keepCopilotSettings,
  );
  if (choice !== confirm && choice !== keepCopilotSettings) return;
  const copilotInlineResults: "raise" | "keep" = choice === keepCopilotSettings ? "keep" : "raise";
  bar.setStale();
  const workspaceConfig = vscode.workspace.getConfiguration("tokenlighten", vscode.Uri.file(root));
  // Copilot standard-setup evaluation (2026-10-02): which TokenLighten guide
  // Copilot reads (packages/cli workspace.ts's Copilot guide section). The
  // second modal button changes no Copilot setting at all (`keep`); otherwise
  // the `tokenlighten.copilotGuide` setting decides, and its default
  // ("standalone") is also `tl install`'s, so nothing is appended for it.
  const copilotGuide: "agents-md" | "keep" | undefined = choice === keepCopilotSettings
    ? "keep"
    : workspaceConfig.get<string>("copilotGuide", "standalone") === "agents-md" ? "agents-md" : undefined;
  // Whether Copilot will read the standalone guide — and so never attach
  // AGENTS.md, whatever its profile — predicted from this folder's own
  // `chat.useAgentsMdFile` the way `tl install` will decide it
  // (copilotGuide.ts). In a window opened through a `.code-workspace` file VS
  // Code ignores the folder's value (see the `.code-workspace` section above),
  // so only a workspace-file value that is already `false` counts there.
  const chatAgentsMd = vscode.workspace.getConfiguration("chat", vscode.Uri.file(root)).inspect<boolean>("useAgentsMdFile");
  const workspaceFile = localWorkspaceFile();
  const copilotReadsStandaloneGuide = workspaceFile === undefined
    ? predictStandaloneCopilotGuide(
      root,
      copilotGuide ?? "standalone",
      chatAgentsMd?.workspaceFolderValue ?? chatAgentsMd?.workspaceValue,
    )
    : predictStandaloneInWorkspaceFile(
      copilotGuide ?? "standalone",
      chatAgentsMd?.workspaceValue,
      context?.workspaceState.get<string>(WORKSPACE_FILE_SETTING_KEY) === workspaceFile.fsPath,
    );
  // DESIGN-v0.15 §8.2 (R7 Part B): keeps the generated .vscode/mcp.json /
  // .mcp.json / .codex/config.toml in sync with the SAME setting
  // mcpProvider.ts's direct-registration path reads — a Codex/Claude Code
  // user (no VS Code direct-registration API) only ever sees the surface
  // this generated file config selects.
  const configuredToolSurface = workspaceConfig.get<string>("toolSurface", "full");
  const toolSurface: "full" | "code" = configuredToolSurface === "code" ? "code" : "full";
  // P2-3(1): package.json's contributes.configuration declares "full" as
  // guideProfile's own schema default, so get(key, "full") can never tell
  // "the user never touched this setting" apart from "the user explicitly
  // chose full" — inspect() only populates *Value fields when something
  // actually wrote a value at that scope, which is what a real override
  // always does. An explicit value (workspace-folder, workspace, or user
  // scope) always wins over the toolSurface-coupled default; an unset
  // setting defers to it so --tool-surface code stops silently writing the
  // full 12 KB guide (P2-3(1), v0.14.1 hands-on report).
  const guideProfileInspect = workspaceConfig.inspect<string>("guideProfile");
  const explicitGuideProfileRaw =
    guideProfileInspect?.workspaceFolderValue
    ?? guideProfileInspect?.workspaceValue
    ?? guideProfileInspect?.globalValue;
  const explicitGuideProfile: GuideProfile | undefined =
    explicitGuideProfileRaw === "full"
    || explicitGuideProfileRaw === "medium"
    || explicitGuideProfileRaw === "compact"
      ? explicitGuideProfileRaw
      : undefined;
  let profile: GuideProfile = explicitGuideProfile ?? defaultGuideProfileForSurface(toolSurface);
  // USER RULING (2026-09-20): TL must not guess that a workspace is "VS Code
  // only" — AGENTS.md is a shared file, and Codex / Claude Code can be
  // registered machine-wide with no workspace file of their own, so silently
  // writing the compact guide here would change what those other tools read
  // too. The choice has to be the user's own, explicit and informed — ask
  // only when nothing has already decided the profile: an explicit
  // guideProfile setting at any scope (handled above) or the `code` tool
  // surface (which already defaults to compact on its own — see
  // defaultGuideProfileForSurface) both skip the question entirely — and so
  // does a workspace whose Copilot will read the standalone guide (Copilot
  // standard-setup evaluation, 2026-10-02): Copilot then never attaches
  // AGENTS.md, so the only readers left are Codex and Claude Code, which keep
  // the full guide (the profile's default).
  if (explicitGuideProfile === undefined && toolSurface === "full" && !copilotReadsStandaloneGuide) {
    const picked = await vscode.window.showQuickPick<GuideProfileQuickPickItem>(
      [
        {
          profile: "full",
          label: localized(
            "Full guide (recommended if Codex or Claude Code also work in this folder)",
            "フルガイド（このフォルダーでCodexやClaude Codeも使う場合におすすめ）",
          ),
          description: localized(
            "AGENTS.md carries the complete TokenLighten protocol (~12.5 KB)",
            "AGENTS.mdにTokenLightenの完全なプロトコル（約12.5KB）が含まれます",
          ),
        },
        {
          profile: "compact",
          label: localized(
            "Compact guide (GitHub Copilot only)",
            "コンパクトガイド（GitHub Copilotのみ）",
          ),
          description: localized(
            "about 2,600 fewer tokens on every Copilot conversation; Codex / Claude Code in this folder would read the compact guide too",
            "Copilotの会話ごとに約2,600トークン節約できます。このフォルダー内のCodex / Claude Codeもコンパクトガイドを読み込むことになります",
          ),
        },
      ],
      {
        title: localized("TokenLighten guide size", "TokenLighten ガイドのサイズ"),
        ignoreFocusOut: true,
      },
    );
    // Dismissing (Esc / undefined) or picking the first (Full) item is
    // today's behaviour exactly: `profile` already resolved to "full" above
    // and nothing is persisted. Only Compact changes anything — and it also
    // persists the choice so later repair runs and the status bar's own
    // setupWorkspace call never ask again.
    if (picked?.profile === "compact") {
      profile = "compact";
      await workspaceConfig.update(
        "guideProfile",
        "compact",
        getTokenLightenConfigurationTarget(),
      );
    }
  }
  const result = await spawnTl(
    workspaceSetupArgs(
      root,
      profile,
      toolSurface === "code" ? "code" : undefined,
      copilotInlineResults === "keep" ? "keep" : undefined,
      copilotGuide,
    ),
    { cwd: root },
  );
  const installJson = parseTlInstallJson(result.stdout);
  const succeeded = result.code === 0 && installJson?.ok === true;
  // `tl install` exit code 3 means every workspace file WAS written but its
  // own post-install verification (doctor + a real MCP handshake) failed —
  // under Electron's handshake timeout this is not rare, and is a strictly
  // weaker failure than exit 1/2 (nothing written: a bad workspace path, a
  // declined confirmation, or no host to register). Treat it as a warning:
  // still enable the workspace and reload so the just-written configuration
  // takes effect, but say verification failed instead of claiming full
  // success (getting-started.md's exit-code table; hands-on report P?).
  const verificationWarning = !succeeded && result.code === 3;
  if (!succeeded && !verificationWarning) {
    const detail = firstLine(
      (typeof installJson?.message === "string" ? installJson.message : "")
      || result.stderr
      || result.stdout,
    );
    bar.setError(detail);
    vscode.window.showErrorMessage(localized(
      `TokenLighten setup failed: ${detail}`,
      `TokenLightenのセットアップに失敗しました: ${detail}`,
    ));
    return;
  }
  await enableWorkspace();
  setWorkspaceConfigured(root, true, {
    writeEnabled: installJson?.report?.writePosture !== "read-only",
    // `tl install`'s report has no separate usage-logging toggle — the
    // workspace step it runs always writes TOKENLIGHTEN_USAGE_LOG="on" the
    // same way `tl workspace setup` did (workspace.ts's configureVsCode).
    usageLoggingEnabled: true,
  });
  bar.setFresh();
  if (verificationWarning) {
    const detail = firstLine(
      (typeof installJson?.message === "string" ? installJson.message : "")
      || result.stderr
      || result.stdout,
    );
    await vscode.window.showWarningMessage(localized(
      `TokenLighten workspace files were written, but verification failed: ${detail}. Run "tl doctor" to check further.`,
      `TokenLightenのワークスペースファイルは書き込まれましたが、検証に失敗しました: ${detail}。詳細は"tl doctor"で確認してください。`,
    ));
  } else {
    await vscode.window.showInformationMessage(localized(
      "TokenLighten is ready for VS Code, Copilot, Codex, and Claude Code in this workspace. Full MCP tools and local usage measurement are enabled here.",
      "このワークスペースでVS Code、Copilot、Codex、Claude Code向けのTokenLightenを利用できます。全MCPツールとローカル使用量計測が有効です。",
    ));
  }
  // `tl install --json`'s report.workspaces[0] is this one workspace root
  // (the extension only ever sets up the first workspace folder above).
  // `manual` means the file exists but is not strict JSON (VS Code
  // settings allow JSONC comments/trailing commas) — tell the user the
  // exact fix instead of leaving Copilot's limit silently unraised.
  const copilotStatus = installJson?.report?.workspaces?.[0]?.copilotInlineResults;
  if (copilotStatus?.status === "manual") {
    const reason = typeof copilotStatus.reason === "string" ? copilotStatus.reason : "";
    await vscode.window.showWarningMessage(localized(
      `TokenLighten could not automatically raise GitHub Copilot's inline tool-result limit. ${reason}`,
      `TokenLightenはGitHub Copilotのインライン結果表示の上限を自動的には引き上げられませんでした。${reason}`,
    ));
  }
  // Same for the Copilot guide: `manual` means settings.json could not be
  // safely edited, so Copilot keeps attaching AGENTS.md — name the fix.
  const copilotGuideStatus = installJson?.report?.workspaces?.[0]?.copilotGuide;
  if (copilotGuideStatus?.status === "manual") {
    const reason = typeof copilotGuideStatus.reason === "string" ? copilotGuideStatus.reason : "";
    await vscode.window.showWarningMessage(localized(
      `TokenLighten could not automatically give GitHub Copilot its compact guide. ${reason}`,
      `TokenLightenはGitHub Copilot向けのコンパクトなガイドを自動的には設定できませんでした。${reason}`,
    ));
  }
  // A window opened through a `.code-workspace` file ignores the folder-level
  // `chat.useAgentsMdFile` the install just wrote (see the `.code-workspace`
  // section above): once the compact guide is in place, ask to set it in the
  // workspace file too — before the reload below, so it takes effect with the
  // rest. Every other outcome gives back a value this extension set earlier
  // (`agents-md`, or a guide that did not end standalone); `keep` touches
  // nothing, as everywhere.
  if (context !== undefined && copilotGuide !== "keep" && localWorkspaceFile() !== undefined) {
    if (copilotGuide === undefined && copilotGuideStatus?.status === "standalone") {
      if (workspaceFileAgentsMdValue() !== false) await applyCopilotGuideToWorkspaceFile(context);
    } else {
      await withdrawCopilotGuideFromWorkspaceFile(context).catch(() => false);
    }
  }
  await vscode.commands.executeCommand("workbench.action.reloadWindow");
}

export type UsageMeasurementTier = DisplayTier;

function usageMeasurementStatus(status: string, language: "en" | "ja"): string {
  if (language === "ja") {
    if (status === "measured") return "実測";
    if (status === "estimated") return "推定";
    if (status === "unavailable") return "利用不可";
  }
  return status;
}

export function formatUsageMeasurementStatus(
  tier: UsageMeasurementTier,
  language: "en" | "ja",
): string {
  const status = usageMeasurementStatus(tier.status, language);
  return language === "ja"
    ? `${status}（根拠: ${tier.basis}）`
    : `${status} (basis: ${tier.basis})`;
}

export function formatUsageMeasurementTier(
  tier: UsageMeasurementTier,
  language: "en" | "ja",
): string {
  const tokens = tier.tokens === null
    ? (language === "ja" ? "利用不可" : "unavailable")
    : language === "ja"
      ? `${tier.tokens.toLocaleString("ja-JP")}トークン`
      : `${tier.tokens.toLocaleString("en-US")} tokens`;
  const status = usageMeasurementStatus(tier.status, language);
  return language === "ja"
    ? `${tokens}（${status}・根拠: ${tier.basis}）`
    : `${tokens} (${status}; basis: ${tier.basis})`;
}

export interface UsageSummary {
  eventCount: number;
  successfulCalls: number;
  failedCalls: number;
  estimatedResponseTokens: number;
  method?: "file-bytes";
  measurementDisplay?: MeasurementDisplayTiers;
  measuredBaselineCalls: number;
  measuredResponseBytes?: number;
  measuredBaselineBytes?: number;
  measurementUnavailableReason?: "recorder-off" | "log-dir-unavailable" | "scope-mismatch";
  estimatedSavedTokens: number;
  estimatedSavedCostUsd: number | null;
  estimatedTokenReductionPercent: number | null;
  estimatedCostReductionPercent: number | null;
  scope?: { kind: "machine" | "workspace"; workspaceId?: string };
  sessionEstimate?: {
    status: string;
    tokenReductionPercent: number | null;
    costReductionPercent: number | null;
    matchedSessions: number;
    confidence: string;
    calibration?: { sampleCount?: number };
    warnings?: string[];
  };
}

export async function loadUsageSummary(): Promise<UsageSummary> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    throw new Error(localized(
      "Open a workspace folder before loading usage",
      "使用状況を読み込む前にワークスペースフォルダーを開いてください",
    ));
  }
  const result = await spawnTl(
    ["logs", "summary", "--json", "--workspace-root", root],
    { cwd: root },
  );
  if (result.code !== 0) {
    throw new Error(firstLine(result.stderr || result.stdout));
  }
  const summary = JSON.parse(result.stdout) as UsageSummary;
  if (workspaceMcpSettingsCached()?.usageLoggingEnabled === false) {
    summary.measurementUnavailableReason = "recorder-off";
  }
  return summary;
}

export async function showUsageDashboard(
  context: vscode.ExtensionContext,
): Promise<void> {
  let summary: UsageSummary;
  try {
    summary = await loadUsageSummary();
  } catch (error: unknown) {
    vscode.window.showErrorMessage(localized(
      `TokenLighten usage could not be loaded: ${String(error)}`,
      `TokenLightenの使用状況を読み込めませんでした: ${String(error)}`,
    ));
    return;
  }
  const language = getDisplayLanguage();
  const copy = language === "ja"
    ? {
        title: "TokenLighten ワークスペース使用状況",
        tokenReduction: "このワークスペースの推定トークン削減率",
        billingReduction: "このワークスペースの推定課金額削減率",
        status: "このワークスペースでのTLステータス",
        enabled: "有効",
        disabled: "無効",
        measured: "計測済み呼び出し",
        export: "このワークスペースのログを出力",
      }
    : {
        title: "TokenLighten Workspace Usage",
        tokenReduction: "Estimated token reduction rate in this workspace",
        billingReduction: "Estimated billing reduction rate in this workspace",
        status: "TL status in this workspace",
        enabled: "Enabled",
        disabled: "Disabled",
        measured: "Measured calls",
        export: "Export logs for this workspace",
      };
  const estimateStatus = summary.sessionEstimate?.status;
  const estimateConfidence = summary.sessionEstimate?.confidence;
  const publishableEstimate = estimateStatus === "estimated"
    && (estimateConfidence === "medium" || estimateConfidence === "high");
  const tokenReduction = publishableEstimate
    ? summary.sessionEstimate?.tokenReductionPercent ?? null
    : null;
  const billingReduction = publishableEstimate
    ? summary.sessionEstimate?.costReductionPercent ?? null
    : null;
  const tokenPercentage = tokenReduction === null
    ? "—"
    : `${tokenReduction.toFixed(1)}%`;
  const billingPercentage = billingReduction === null
    ? "—"
    : `${billingReduction.toFixed(1)}%`;
  const tokenLabel = localized(
    "Estimated token reduction in this workspace (matched against local AI logs)",
    "このワークスペースの推定トークン削減率（実測ログ照合）",
  );
  const billingLabel = localized(
    "Estimated billing reduction in this workspace (matched against local AI logs)",
    "このワークスペースの推定課金額削減率（実測ログ照合）",
  );
  const calibrationSamples = summary.sessionEstimate?.calibration?.sampleCount ?? 0;
  const calibrationTarget = 24;
  const calibrationLine = estimateConfidence !== "high" && calibrationSamples < calibrationTarget
    ? localized(`Calibrating: ${calibrationSamples}/${calibrationTarget} paired samples (medium 12 / high 24).`, `調整中: ペアサンプル ${calibrationSamples}/${calibrationTarget}（medium 12 / high 24）。`)
    : null;
  const responseBytes = summary.measuredResponseBytes ?? null;
  const baselineBytes = summary.measuredBaselineBytes ?? null;
  const measuredRatio = responseBytes !== null && baselineBytes !== null && baselineBytes > 0 ? responseBytes / baselineBytes : null;
  const measuredLine = localized(
    `Measured calls: ${summary.measuredBaselineCalls}; response bytes vs baseline: ${measuredRatio === null ? "unavailable" : `${(measuredRatio * 100).toFixed(1)}%`}.`,
    `実測呼び出し: ${summary.measuredBaselineCalls}、応答バイト対ベースライン比: ${measuredRatio === null ? "利用不可" : `${(measuredRatio * 100).toFixed(1)}%`}。`,
  );
  const measurementLine = summary.measurementDisplay
    ? language === "ja"
      ? `TL応答合計: 約${summary.estimatedResponseTokens.toLocaleString("ja-JP")}トークン（方式: ${summary.method ?? "file-bytes"}）、観測usage: ${formatUsageMeasurementStatus(summary.measurementDisplay.wire, "ja")}、MCP応答オーバーヘッド: ${formatUsageMeasurementTier(summary.measurementDisplay.mcpResponse, "ja")}、回避コンテキスト: ${formatUsageMeasurementTier(summary.measurementDisplay.contextAvoided, "ja")}、セッション回避ターン: ${formatUsageMeasurementTier(summary.measurementDisplay.session, "ja")}、純減: ${summary.measurementDisplay.session.net ? formatUsageMeasurementTier(summary.measurementDisplay.session.net, "ja") : "利用不可"}。`
      : `TL response total: ~${summary.estimatedResponseTokens.toLocaleString("en-US")} tokens (method: ${summary.method ?? "file-bytes"}); observed usage: ${formatUsageMeasurementStatus(summary.measurementDisplay.wire, "en")}; MCP response overhead: ${formatUsageMeasurementTier(summary.measurementDisplay.mcpResponse, "en")}; context avoided: ${formatUsageMeasurementTier(summary.measurementDisplay.contextAvoided, "en")}; session avoided-turn: ${formatUsageMeasurementTier(summary.measurementDisplay.session, "en")}; net: ${summary.measurementDisplay.session.net ? formatUsageMeasurementTier(summary.measurementDisplay.session.net, "en") : "unavailable"}.`
    : localized("Response/context/session tiers unavailable.", "応答・回避コンテキスト・セッション層は利用できません。");
  const warnings = summary.sessionEstimate?.warnings ?? [];
  const unavailableReason = summary.measurementUnavailableReason
    ?? (warnings.includes("recorder-off") ? "recorder-off"
      : warnings.includes("log-dir-unavailable") ? "log-dir-unavailable"
        : warnings.includes("scope-mismatch") ? "scope-mismatch" : undefined);
  const reason = unavailableReason === "recorder-off"
    ? localized("Recorder is off.", "レコーダーが無効です。")
    : unavailableReason === "log-dir-unavailable"
      ? localized("Usage log directory is unavailable.", "使用状況ログのディレクトリに到達できません。")
      : unavailableReason === "scope-mismatch"
        ? localized("Usage logs do not match this workspace scope.", "使用状況ログのスコープがこのワークスペースと一致しません。")
        : null;
  const metricNote = `${
    publishableEstimate
      ? localized(
        "Estimates are matched against attributable local AI usage logs.",
        "この推定は帰属可能なローカルAI利用ログと照合しています。",
      )
      : estimateStatus === "estimated"
        ? localized(
          "Reduction estimates are hidden because confidence is low. Use paired billing evidence for decisions.",
          "信頼度が低いため削減率を表示していません。判断にはペア課金の検証結果を使用してください。",
        )
        : localized(
          "Token and billing reduction estimates are unavailable: no attributable local AI logs for this workspace.",
          "このワークスペースで照合可能なAIログがないため、トークンと課金額の削減率は利用できません。",
        )
  } ${localized(
    `Confidence: ${estimateConfidence ?? "unavailable"}.`,
    `信頼度: ${estimateConfidence ?? "unavailable"}。`,
  )}`;
  const active = await workspaceActivationState() === "ready";
  const panel = vscode.window.createWebviewPanel(
    "tokenlightenUsage",
    copy.title,
    vscode.ViewColumn.One,
    { enableScripts: true },
  );
  panel.webview.html = `<!doctype html>
<html lang="${language}"><head><meta charset="utf-8"><style>
body{font-family:var(--vscode-font-family);padding:24px;color:var(--vscode-foreground)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}
.card{padding:16px;border:1px solid var(--vscode-panel-border);border-radius:8px}
.value{font-size:28px;font-weight:600;margin-top:8px}
.note{color:var(--vscode-descriptionForeground)}
button{margin-top:20px;padding:8px 14px}
</style></head><body>
<h1>${copy.title}</h1>
<div class="grid">
<div class="card">${tokenLabel}<div class="value">${tokenPercentage}</div></div>
<div class="card">${billingLabel}<div class="value">${billingPercentage}</div></div>
<div class="card">${copy.status}<div class="value">${active ? copy.enabled : copy.disabled}</div></div>
</div>
<p class="note">${metricNote} ${copy.measured}: ${summary.measuredBaselineCalls}</p>
${calibrationLine ? `<p class="note">${calibrationLine}</p>` : ""}
<p class="note">${measuredLine}</p>\n<p class="note">${measurementLine}</p>
${reason ? `<p class="note">${reason}</p>` : ""}
<button id="export">${copy.export}</button>
<script>
const vscode = acquireVsCodeApi();
document.getElementById("export").addEventListener("click", () => vscode.postMessage({action:"export"}));
</script></body></html>`;
  context.subscriptions.push(
    panel.webview.onDidReceiveMessage((message: unknown) => {
      if (
        message
        && typeof message === "object"
        && (message as { action?: string }).action === "export"
      ) {
        void exportUsageLogs();
      }
    }),
  );
}

export async function exportUsageLogs(): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    vscode.window.showWarningMessage(localized(
      "TokenLighten: open a workspace folder before exporting logs",
      "TokenLighten: ログを出力する前にワークスペースフォルダーを開いてください",
    ));
    return;
  }
  const state = await workspaceActivationState();
  if (state !== "ready") {
    vscode.window.showWarningMessage(statusMessage(state));
    return;
  }
  const japanese = getDisplayLanguage() === "ja";
  const target = await vscode.window.showSaveDialog({
    filters: {
      [japanese ? "TokenLighten使用状況バンドル" : "TokenLighten usage bundle"]: ["zip"],
    },
    saveLabel: japanese ? "このワークスペースのログを出力" : "Export this workspace's logs",
    defaultUri: vscode.Uri.file("tokenlighten-workspace-usage.tl-usage.zip"),
  });
  if (!target) return;
  const args = [
    "logs",
    "export",
    "--output",
    target.fsPath,
    "--workspace-root",
    root,
  ];
  const result = await spawnTl(args, { cwd: root });
  if (result.code !== 0) {
    const detail = firstLine(result.stderr || result.stdout);
    vscode.window.showErrorMessage(localized(
      `TokenLighten export failed: ${detail}`,
      `TokenLightenの出力に失敗しました: ${detail}`,
    ));
    return;
  }
  vscode.window.showInformationMessage(localized(
    "TokenLighten: this workspace's privacy-safe usage bundle was exported locally",
    "TokenLighten: このワークスペースのプライバシー保護使用状況バンドルをローカルに出力しました",
  ));
}
