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
  setWorkspaceConfigured,
  workspaceActivationState,
  workspaceMcpSettingsCached,
} from "./workspaceState.js";
import type { WorkspaceActivationState } from "./workspaceState.js";

const firstLine = (s: string) => s.split("\n")[0] ?? s;

function localized(en: string, ja: string): string {
  return getDisplayLanguage() === "ja" ? ja : en;
}

export function workspaceSetupArgs(root: string): string[] {
  return [
    "workspace",
    "setup",
    "--root",
    root,
    "--clients",
    "vscode,codex,claude-code",
    "--json",
  ];
}

export function registerSetupCommand(
  context: vscode.ExtensionContext,
  bar: StatusBarManager,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("tokenlighten.setup", () => {
      void setupWorkspace(bar);
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
  action: "diagnostics" | "enable" | "disable" | "setup" | "sidebar" | "status";
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
    case "enable":
      await enableWorkspace();
      bar?.setActivationState(await workspaceActivationState());
      return;
    case "disable":
      await disableWorkspace();
      bar?.setActivationState(await workspaceActivationState());
      return;
    case "setup":
      if (bar) await setupWorkspace(bar);
      return;
    case "sidebar":
      await vscode.commands.executeCommand("workbench.view.extension.tokenlighten-sidebar");
      return;
    case "status":
      void vscode.window.showInformationMessage(statusMessage(state));
      return;
  }
}

export async function setupWorkspace(bar: StatusBarManager): Promise<void> {
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
  const choice = await vscode.window.showInformationMessage(
    localized(
      "Set up or repair TokenLighten for VS Code, Copilot, Codex, and Claude Code in this workspace? Write tools and local privacy-safe usage measurement are enabled only for this workspace.",
      "このワークスペースでVS Code、Copilot、Codex、Claude Code向けのTokenLighten設定をセットアップまたは修復しますか？書き込みツールとローカルのプライバシー保護使用量計測は、このワークスペースだけで有効になります。",
    ),
    { modal: true },
    confirm,
  );
  if (choice !== confirm) return;
  bar.setStale();
  const result = await spawnTl(workspaceSetupArgs(root), { cwd: root });
  if (result.code !== 0) {
    const detail = firstLine(result.stderr || result.stdout);
    bar.setError(detail);
    vscode.window.showErrorMessage(localized(
      `TokenLighten setup failed: ${detail}`,
      `TokenLightenのセットアップに失敗しました: ${detail}`,
    ));
    return;
  }
  await enableWorkspace();
  setWorkspaceConfigured(root, true, {
    writeEnabled: true,
    usageLoggingEnabled: true,
  });
  bar.setFresh();
  await vscode.window.showInformationMessage(localized(
    "TokenLighten is ready for VS Code, Copilot, Codex, and Claude Code in this workspace. Full MCP tools and local usage measurement are enabled here.",
    "このワークスペースでVS Code、Copilot、Codex、Claude Code向けのTokenLightenを利用できます。全MCPツールとローカル使用量計測が有効です。",
  ));
  await vscode.commands.executeCommand("workbench.action.reloadWindow");
}

export interface UsageSummary {
  eventCount: number;
  successfulCalls: number;
  failedCalls: number;
  estimatedResponseTokens: number;
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
<p class="note">${measuredLine}</p>
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
