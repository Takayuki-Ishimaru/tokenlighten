import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { getTlVersion } from "./cli.js";
import { loadUsageSummary } from "./commands.js";
import {
  getConfiguredLanguage,
  getDisplayLanguage,
  getLanguageConfigurationTarget,
  getTokenLightenConfiguration,
  getTokenLightenConfigurationTarget,
} from "./statusBar.js";
import type { ConfiguredLanguage } from "./statusBar.js";
import { workspaceActivationState } from "./workspaceState.js";

const VIEW_ID = "tokenlighten-control-center";

const RUNNABLE_COMMANDS = new Set([
  "tokenlighten.setup",
  "tokenlighten.logs.export",
]);

interface SidebarMessage {
  action?: unknown;
  command?: unknown;
  enabled?: unknown;
  language?: unknown;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const COPY = {
  en: {
    subtitle: "Workspace control center",
    overview: "Workspace overview",
    tokenReduction: "Estimated token reduction in this workspace (matched against local AI logs)",
    billingReduction: "Estimated billing reduction in this workspace (matched against local AI logs)",
    measuredReduction: "Measured per-call reduction",
    billingEstimate: "Billing estimate",
    billingUnavailable: "Billing estimate unavailable: no attributable local AI logs for this workspace.",
    tlStatus: "TL status",
    version: "Version",
    enabled: "Enabled",
    disabled: "Disabled",
    notConfigured: "Not set up",
    readyDetail: "TokenLighten is enabled for this workspace.",
    disabledDetail: "Enable TokenLighten below to use it in this workspace.",
    notConfiguredDetail: "Set up this workspace before enabling TokenLighten features.",
    untrustedDetail: "Trust this workspace to enable TokenLighten actions.",
    noWorkspaceDetail: "Open a folder to configure TokenLighten for a project.",
    cliUnavailableDetail: "Reinstall the extension to restore the bundled CLI.",
    workspaceSetup: "Workspace setup",
    automatic: "Automatic (VS Code language)",
    metricUnavailable: "No measured baseline yet",
    getStarted: "Get started",
    setup: "Set up this workspace",
    projectTools: "Workspace logs",
    exportLogs: "Export this workspace's privacy-safe logs",
    settings: "Settings",
    workspaceEnabled: "Enable TL in this workspace",
    language: "Display language",
    save: "Save settings",
    allSettings: "All settings",
    invalidSettings: "TokenLighten: invalid settings",
    settingsSaved: "TokenLighten settings saved.",
  },
  ja: {
    subtitle: "ワークスペース コントロールセンター",
    overview: "このワークスペース",
    tokenReduction: "このワークスペースの推定トークン削減率（実測ログ照合）",
    billingReduction: "このワークスペースの推定課金額削減率（実測ログ照合）",
    measuredReduction: "計測済み呼び出しベースの削減率",
    billingEstimate: "課金額削減推定",
    billingUnavailable: "このワークスペースで照合可能なAIログがないため請求推定は利用できません。",
    tlStatus: "TLステータス",
    version: "バージョン",
    enabled: "有効",
    disabled: "無効",
    notConfigured: "未設定",
    readyDetail: "このワークスペースでTokenLightenは有効です。",
    disabledDetail: "このワークスペースで使用するには、下の設定でTokenLightenを有効にしてください。",
    notConfiguredDetail: "TokenLightenの機能を有効にする前に、このワークスペースをセットアップしてください。",
    untrustedDetail: "TokenLightenを有効にするには、このワークスペースを信頼してください。",
    noWorkspaceDetail: "フォルダーを開いてTokenLightenを設定してください。",
    cliUnavailableDetail: "同梱CLIを復旧するには、拡張機能を再インストールしてください。",
    workspaceSetup: "ワークスペース設定",
    automatic: "自動（VS Codeの表示言語）",
    metricUnavailable: "計測済みベースラインがまだありません",
    getStarted: "はじめに",
    setup: "このワークスペースをセットアップ",
    projectTools: "ワークスペース ログ",
    exportLogs: "このワークスペースのプライバシー保護ログを出力",
    settings: "設定",
    workspaceEnabled: "このワークスペースでTLを有効にする",
    language: "表示言語",
    save: "設定を保存",
    allSettings: "すべての設定",
    invalidSettings: "TokenLighten: 設定値が正しくありません",
    settingsSaved: "TokenLightenの設定を保存しました。",
  },
} as const;

class ControlCenterProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.renderLoading(view.webview);
    void this.refresh();
    view.webview.onDidReceiveMessage((message: SidebarMessage) => {
      void this.handleMessage(message);
    });
  }

  refresh(): void {
    const view = this.view;
    if (!view) return;
    void this.render(view.webview)
      .then((html) => {
        if (this.view === view) view.webview.html = html;
      })
      .catch((error: unknown) => {
        console.error("TokenLighten sidebar render failed", error);
        if (this.view === view) view.webview.html = this.renderFailure(view.webview);
      });
  }

  private iconSrc(webview: vscode.Webview): string {
    return webview
      .asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "icon.png"))
      .toString();
  }

  private renderLoading(webview: vscode.Webview): string {
    const ja = getDisplayLanguage() === "ja";
    return this.renderMessage(
      webview,
      ja ? "TokenLightenを読み込んでいます…" : "Loading TokenLighten…",
      ja ? "ワークスペースの使用状況を集計しています。" : "Calculating workspace usage.",
    );
  }

  private renderFailure(webview: vscode.Webview): string {
    const ja = getDisplayLanguage() === "ja";
    return this.renderMessage(
      webview,
      ja ? "TokenLightenを表示できません" : "Unable to display TokenLighten",
      ja ? "VS Codeのウィンドウを再読み込みして、もう一度お試しください。" : "Reload the VS Code window and try again.",
    );
  }

  private renderMessage(webview: vscode.Webview, title: string, detail: string): string {
    return `<!doctype html>
<html><head><meta charset="utf-8"><style>
:root{--brand-orange:#FF6B1A;--brand-lavender:#C6A7E8;--brand-blue:#4057D6;--brand-black:#191827;--brand-mist:#F2EEF5}
*{box-sizing:border-box}body{min-height:100vh;margin:0;padding:18px 14px;color:var(--vscode-foreground);background:radial-gradient(320px 180px at 100% -10%,color-mix(in srgb,var(--brand-orange) 9%,transparent),transparent 68%),linear-gradient(180deg,color-mix(in srgb,var(--brand-lavender) 10%,transparent),transparent 130px),var(--vscode-sideBar-background);font:var(--vscode-font-size)/1.45 var(--vscode-font-family)}
body::before{content:"";position:fixed;inset:0 0 auto;height:3px;background:linear-gradient(90deg,var(--brand-orange),#FF9A5C 16%,var(--brand-lavender) 46%,#8B97E8 70%,var(--brand-blue));box-shadow:0 1px 12px color-mix(in srgb,var(--brand-lavender) 55%,transparent)}
::selection{background:color-mix(in srgb,var(--brand-blue) 28%,transparent)}
.message{display:flex;align-items:flex-start;gap:10px}.mark{display:block;width:34px;height:34px;flex:0 0 auto;border-radius:10px;box-shadow:0 7px 18px -8px color-mix(in srgb,var(--brand-blue) 55%,transparent)}
strong{display:block;margin-bottom:4px}.muted{color:var(--vscode-descriptionForeground)}
body.vscode-high-contrast,body.vscode-high-contrast-light{background:var(--vscode-sideBar-background)}
body.vscode-high-contrast::before,body.vscode-high-contrast-light::before{box-shadow:none}
body.vscode-high-contrast .mark,body.vscode-high-contrast-light .mark{border:1px solid var(--vscode-contrastBorder,var(--brand-black));box-shadow:none}
</style></head><body><div class="message"><img class="mark" src="${this.iconSrc(webview)}" alt=""><div><strong>${escapeHtml(title)}</strong><span class="muted">${escapeHtml(detail)}</span></div></div></body></html>`;
  }

  private async handleMessage(message: SidebarMessage): Promise<void> {
    if (message.action === "run" && typeof message.command === "string") {
      if (!RUNNABLE_COMMANDS.has(message.command)) {
        return;
      }
      await vscode.commands.executeCommand(message.command);
      this.refresh();
      return;
    }

    if (message.action === "setLanguage") {
      if (
        message.language !== "auto"
        && message.language !== "en"
        && message.language !== "ja"
      ) {
        return;
      }
      const config = getTokenLightenConfiguration();
      await config.update(
        "language",
        message.language,
        getLanguageConfigurationTarget(),
      );
      this.refresh();
      return;
    }

    if (message.action === "openSettings") {
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "@ext:tokenlighten.tokenlighten-vscode-extension",
      );
      return;
    }

    if (message.action !== "saveSettings") {
      return;
    }

    if (
      typeof message.enabled !== "boolean"
      || (
        message.language !== "auto"
        && message.language !== "en"
        && message.language !== "ja"
      )
    ) {
      vscode.window.showErrorMessage(COPY[getDisplayLanguage()].invalidSettings);
      return;
    }

    const config = getTokenLightenConfiguration();
    const previousEnabled = config.get<boolean>("enabled", true);
    await Promise.all([
      config.update(
        "enabled",
        message.enabled,
        getTokenLightenConfigurationTarget(),
      ),
      config.update(
        "language",
        message.language,
        getLanguageConfigurationTarget(),
      ),
    ]);
    const savedLanguage = message.language === "ja"
      ? "ja"
      : message.language === "en"
        ? "en"
        : getDisplayLanguage();
    await vscode.window.showInformationMessage(COPY[savedLanguage].settingsSaved);
    if (previousEnabled !== message.enabled) {
      await vscode.commands.executeCommand("workbench.action.reloadWindow");
      return;
    }
    this.refresh();
  }

  private async render(webview: vscode.Webview): Promise<string> {
    const config = getTokenLightenConfiguration();
    const enabled = config.get<boolean>("enabled", true);
    const configuredLanguage: ConfiguredLanguage = getConfiguredLanguage();
    const language = getDisplayLanguage();
    const copy = COPY[language];
    const trusted = vscode.workspace.isTrusted;
    const hasWorkspace = Boolean(vscode.workspace.workspaceFolders?.length);
    const tlVersion = getTlVersion();
    const cliAvailable = tlVersion !== undefined;
    const activationState = await workspaceActivationState();
    const active = activationState === "ready";

    let statusClass = active ? "good" : "warn";
    const statusText = activationState === "not-configured"
      ? copy.notConfigured
      : active ? copy.enabled : copy.disabled;
    let statusDetail: string = activationState === "not-configured"
      ? copy.notConfiguredDetail
      : active ? copy.readyDetail : copy.disabledDetail;
    if (!trusted) {
      statusDetail = copy.untrustedDetail;
    } else if (!hasWorkspace) {
      statusDetail = copy.noWorkspaceDetail;
    } else if (!cliAvailable) {
      statusClass = "bad";
      statusDetail = copy.cliUnavailableDetail;
    }

    let tokenReductionLabel: string = copy.tokenReduction;
    let billingReductionLabel: string = copy.billingReduction;
    let tokenReductionText = "—";
    let billingReductionText = "—";
    let billingReductionDetail = "";
    if (active) {
      try {
        const summary = await loadUsageSummary();
        if (summary.sessionEstimate?.status === "estimated") {
          tokenReductionText =
            typeof summary.sessionEstimate.tokenReductionPercent === "number"
              ? `${summary.sessionEstimate.tokenReductionPercent.toFixed(1)}%`
              : copy.metricUnavailable;
          billingReductionText =
            typeof summary.sessionEstimate.costReductionPercent === "number"
              ? `${summary.sessionEstimate.costReductionPercent.toFixed(1)}%`
              : copy.metricUnavailable;
        } else {
          tokenReductionLabel = copy.measuredReduction;
          billingReductionLabel = copy.billingEstimate;
          tokenReductionText =
            typeof summary.estimatedTokenReductionPercent === "number"
              ? `${summary.estimatedTokenReductionPercent.toFixed(1)}%`
              : copy.metricUnavailable;
          billingReductionText = "—";
          billingReductionDetail = copy.billingUnavailable;
        }
      } catch {
        tokenReductionText = copy.metricUnavailable;
        billingReductionText = copy.metricUnavailable;
      }
    }

    const setupDisabled = trusted && hasWorkspace && cliAvailable ? "" : "disabled";
    const cliDisabled = active ? "" : "disabled";
    const enabledChecked = enabled ? "checked" : "";
    const nonce = randomBytes(16).toString("hex");
    const iconSrc = this.iconSrc(webview);

    return `<!doctype html>
<html lang="${language}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root {
    color-scheme: light dark;
    --brand-orange: #FF6B1A;
    --brand-lavender: #C6A7E8;
    --brand-blue: #4057D6;
    --brand-black: #191827;
    --brand-mist: #F2EEF5;
    --tl-canvas: var(--vscode-sideBar-background);
    --tl-ink: var(--vscode-foreground, var(--brand-black));
    --tl-surface: color-mix(in srgb, var(--brand-lavender) 7%, var(--vscode-sideBar-background));
    --tl-surface-raised: color-mix(in srgb, var(--brand-lavender) 12%, var(--vscode-sideBar-background));
    --tl-border: var(--vscode-panel-border, color-mix(in srgb, var(--brand-lavender) 48%, transparent));
    --tl-foreground: var(--vscode-foreground);
    --tl-muted: var(--vscode-descriptionForeground);
    --tl-focus: var(--vscode-focusBorder, var(--brand-blue));
    --tl-radius-sm: 6px;
    --tl-radius-md: 10px;
    --tl-radius-lg: 14px;
    --tl-ribbon: linear-gradient(90deg, var(--brand-orange), #FF9A5C 16%, var(--brand-lavender) 46%, #8B97E8 70%, var(--brand-blue));
    --tl-glass-border: linear-gradient(165deg, color-mix(in srgb, var(--brand-mist) 60%, transparent), color-mix(in srgb, var(--brand-lavender) 58%, transparent) 45%, color-mix(in srgb, var(--brand-blue) 42%, transparent));
    --tl-glass: linear-gradient(var(--tl-surface), var(--tl-surface)) padding-box, var(--tl-glass-border) border-box;
    --tl-glass-hover: linear-gradient(var(--tl-surface-raised), var(--tl-surface-raised)) padding-box, var(--tl-glass-border) border-box;
    --tl-primary-gradient: linear-gradient(135deg, #5A6BEE, var(--brand-blue) 55%, #3143C4);
    --tl-primary-gradient-hover: linear-gradient(135deg, #6879F3, #4C61E4 55%, #3247BB);
    --tl-tick-gradient: linear-gradient(180deg, var(--brand-orange), var(--brand-lavender));
    --tl-number-gradient: linear-gradient(120deg, color-mix(in srgb, var(--brand-blue) 65%, var(--tl-ink)), color-mix(in srgb, #6D5BD9 65%, var(--tl-ink)) 58%, color-mix(in srgb, #A94FC2 65%, var(--tl-ink)));
  }
  * { box-sizing: border-box; }
  body {
    min-height: 100vh;
    margin: 0;
    padding: 18px 14px 22px;
    background:
      radial-gradient(360px 200px at 100% -8%, color-mix(in srgb, var(--brand-orange) 9%, transparent), transparent 68%),
      linear-gradient(180deg, color-mix(in srgb, var(--brand-lavender) 10%, transparent), transparent 150px),
      var(--tl-canvas);
    color: var(--tl-foreground);
    font: var(--vscode-font-size)/1.45 var(--vscode-font-family);
  }
  body::before {
    content: "";
    position: fixed;
    inset: 0 0 auto;
    z-index: 10;
    height: 3px;
    background: var(--tl-ribbon);
    box-shadow: 0 1px 12px color-mix(in srgb, var(--brand-lavender) 55%, transparent);
  }
  ::selection { background: color-mix(in srgb, var(--brand-blue) 28%, transparent); }
  h2 {
    position: relative;
    margin: 22px 0 9px;
    padding-left: 11px;
    color: var(--tl-foreground);
    font-size: 12px;
    letter-spacing: .08em;
    text-transform: uppercase;
  }
  h2::before {
    content: "";
    position: absolute;
    left: 0;
    top: .1em;
    bottom: .1em;
    width: 3px;
    border-radius: 999px;
    background: var(--tl-tick-gradient);
  }
  .brand { display: flex; align-items: center; gap: 11px; margin: 2px 0 17px; }
  .mark {
    display: block;
    width: 38px;
    height: 38px;
    flex: 0 0 auto;
    border-radius: 10px;
    box-shadow: 0 8px 20px -9px color-mix(in srgb, var(--brand-blue) 60%, transparent);
  }
  .brand strong { display: block; font-size: 16px; letter-spacing: -.02em; }
  .brand .muted { display: block; }
  .muted { color: var(--tl-muted); font-size: 12px; }
  .metric, .client-row {
    border: 1px solid transparent;
    border-radius: var(--tl-radius-md);
    background: var(--tl-glass);
  }
  .metrics { display: grid; gap: 8px; }
  .metric { padding: 11px; transition: box-shadow .16s ease, transform .16s ease; }
  .metric:hover {
    background: var(--tl-glass-hover);
    box-shadow: 0 10px 22px -14px color-mix(in srgb, var(--brand-black) 65%, transparent);
    transform: translateY(-1px);
  }
  .metric > span { display: block; }
  .metric-value {
    display: block;
    margin: 4px 0 2px;
    font-size: 22px;
    letter-spacing: -.02em;
    font-variant-numeric: tabular-nums;
    background: var(--tl-number-gradient);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
  }
  .metric.good { border-left: 3px solid var(--vscode-testing-iconPassed); }
  .metric.warn { border-left: 3px solid var(--vscode-editorWarning-foreground); }
  .metric.bad { border-left: 3px solid var(--vscode-testing-iconFailed); }
  .actions { display: grid; gap: 7px; }
  .client-list { display: grid; gap: 8px; }
  .client-row { padding: 11px; transition: box-shadow .16s ease; }
  .client-row:hover {
    background: var(--tl-glass-hover);
    box-shadow: 0 8px 18px -14px color-mix(in srgb, var(--brand-black) 65%, transparent);
  }
  .client-head { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; }
  .client-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; margin-top: 9px; }
  .bad-text { color: var(--vscode-testing-iconFailed); }
  button {
    width: 100%;
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: var(--tl-radius-sm);
    padding: 8px 10px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    box-shadow:
      inset 2px 0 0 color-mix(in srgb, var(--brand-lavender) 85%, transparent),
      inset 0 1px 0 color-mix(in srgb, #FFFFFF 12%, transparent);
    cursor: pointer;
    text-align: left;
    transition: background-color .16s ease, box-shadow .16s ease, transform .16s ease;
  }
  button:hover:not(:disabled) {
    background: var(--vscode-button-secondaryHoverBackground);
    box-shadow:
      inset 2px 0 0 var(--brand-lavender),
      inset 0 1px 0 color-mix(in srgb, #FFFFFF 18%, transparent),
      0 6px 14px -10px color-mix(in srgb, var(--brand-black) 70%, transparent);
    transform: translateY(-1px);
  }
  button:active:not(:disabled) { transform: translateY(0) scale(.98); }
  button.primary {
    border-color: transparent;
    background: var(--tl-primary-gradient);
    color: #FFFFFF;
    box-shadow:
      0 7px 18px -9px color-mix(in srgb, var(--brand-blue) 75%, transparent),
      inset 0 1px 0 color-mix(in srgb, #FFFFFF 30%, transparent);
    font-weight: 700;
  }
  button.primary:hover:not(:disabled) {
    background: var(--tl-primary-gradient-hover);
    box-shadow:
      0 10px 22px -9px color-mix(in srgb, var(--brand-blue) 82%, transparent),
      inset 0 1px 0 color-mix(in srgb, #FFFFFF 34%, transparent);
  }
  button:disabled { cursor: not-allowed; opacity: .45; box-shadow: none; transform: none; }
  button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid var(--tl-focus); outline-offset: 2px; }
  label { display: block; margin: 8px 0 4px; color: var(--tl-muted); font-size: 12px; }
  input, select {
    width: 100%;
    border: 1px solid var(--vscode-input-border, var(--tl-border));
    border-radius: var(--tl-radius-sm);
    padding: 7px 8px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    outline: none;
    transition: border-color .16s ease, box-shadow .16s ease;
  }
  input:focus, select:focus {
    border-color: var(--tl-focus);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--tl-focus) 20%, transparent);
  }
  .toggle { display: flex; align-items: center; gap: 8px; margin: 10px 0; color: var(--tl-foreground); }
  .toggle input { width: auto; margin: 0; accent-color: var(--brand-blue); }
  .settings-actions { display: flex; gap: 7px; margin-top: 10px; }
  .settings-actions button { text-align: center; }
  @media (prefers-reduced-motion: reduce) {
    button, input, select, .metric, .client-row { transition: none; }
    button:hover:not(:disabled), button:active:not(:disabled), .metric:hover { transform: none; }
  }
  body.vscode-high-contrast,
  body.vscode-high-contrast-light {
    background: var(--tl-canvas);
  }
  body.vscode-high-contrast::before,
  body.vscode-high-contrast-light::before { box-shadow: none; }
  body.vscode-high-contrast h2::before,
  body.vscode-high-contrast-light h2::before { background: var(--brand-orange); }
  body.vscode-high-contrast .mark,
  body.vscode-high-contrast-light .mark {
    border: 1px solid var(--vscode-contrastBorder, var(--brand-black));
    box-shadow: none;
  }
  body.vscode-high-contrast button.primary,
  body.vscode-high-contrast-light button.primary {
    border-color: var(--vscode-button-border, var(--vscode-contrastBorder));
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    box-shadow: none;
  }
  body.vscode-high-contrast button.primary:hover:not(:disabled),
  body.vscode-high-contrast-light button.primary:hover:not(:disabled) {
    background: var(--vscode-button-hoverBackground, var(--vscode-button-background));
    box-shadow: none;
  }
  body.vscode-high-contrast button,
  body.vscode-high-contrast button:hover:not(:disabled),
  body.vscode-high-contrast-light button,
  body.vscode-high-contrast-light button:hover:not(:disabled) {
    box-shadow: none;
  }
  body.vscode-high-contrast input:focus,
  body.vscode-high-contrast select:focus,
  body.vscode-high-contrast-light input:focus,
  body.vscode-high-contrast-light select:focus {
    box-shadow: none;
  }
  body.vscode-high-contrast .metric,
  body.vscode-high-contrast .metric:hover,
  body.vscode-high-contrast .client-row,
  body.vscode-high-contrast .client-row:hover,
  body.vscode-high-contrast-light .metric,
  body.vscode-high-contrast-light .metric:hover,
  body.vscode-high-contrast-light .client-row,
  body.vscode-high-contrast-light .client-row:hover {
    background: var(--tl-canvas);
    border-top-color: var(--vscode-contrastBorder, var(--tl-border));
    border-right-color: var(--vscode-contrastBorder, var(--tl-border));
    border-bottom-color: var(--vscode-contrastBorder, var(--tl-border));
    box-shadow: none;
  }
  body.vscode-high-contrast .client-row,
  body.vscode-high-contrast .client-row:hover,
  body.vscode-high-contrast-light .client-row,
  body.vscode-high-contrast-light .client-row:hover {
    border-left-color: var(--vscode-contrastBorder, var(--tl-border));
  }
  body.vscode-high-contrast .metric-value,
  body.vscode-high-contrast-light .metric-value {
    background: none;
    -webkit-text-fill-color: var(--vscode-foreground);
    color: var(--vscode-foreground);
  }
</style>
</head>
<body>
  <div class="brand">
    <img class="mark" src="${iconSrc}" alt="">
    <div><strong>TokenLighten</strong><span class="muted">${copy.subtitle}</span><span class="muted">${copy.version}: ${escapeHtml(tlVersion ?? "—")}</span></div>
  </div>

  <h2>${copy.overview}</h2>
  <div class="metrics">
    <div class="metric"><span class="muted">${tokenReductionLabel}</span><strong class="metric-value">${tokenReductionText}</strong></div>
    <div class="metric"><span class="muted">${billingReductionLabel}</span><strong class="metric-value">${billingReductionText}</strong>${billingReductionDetail ? `<span class="muted">${billingReductionDetail}</span>` : ""}</div>
    <div class="metric ${statusClass}"><span class="muted">${copy.tlStatus}</span><strong class="metric-value">${escapeHtml(statusText)}</strong><span class="muted">${escapeHtml(statusDetail)}</span></div>
  </div>

  <h2>${copy.workspaceSetup}</h2>
  <div class="actions">
    <button class="primary" data-command="tokenlighten.setup" ${setupDisabled}>${copy.setup}</button>
  </div>

  <h2>${copy.projectTools}</h2>
  <div class="actions">
    <button data-command="tokenlighten.logs.export" ${cliDisabled}>${copy.exportLogs}</button>
  </div>

  <h2>${copy.settings}</h2>
  <label class="toggle" for="workspaceEnabled"><input id="workspaceEnabled" type="checkbox" ${enabledChecked}>${copy.workspaceEnabled}</label>
  <label for="language">${copy.language}</label>
  <select id="language">
    <option value="auto" ${configuredLanguage === "auto" ? "selected" : ""}>${copy.automatic}</option>
    <option value="en" ${configuredLanguage === "en" ? "selected" : ""}>English</option>
    <option value="ja" ${configuredLanguage === "ja" ? "selected" : ""}>日本語</option>
  </select>
  <div class="settings-actions">
    <button id="saveSettings" class="primary">${copy.save}</button>
    <button id="openSettings">${copy.allSettings}</button>
  </div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  document.querySelectorAll("[data-command]").forEach((button) => {
    button.addEventListener("click", () => {
      vscode.postMessage({ action: "run", command: button.dataset.command });
    });
  });
  document.getElementById("language").addEventListener("change", (event) => {
    vscode.postMessage({
      action: "setLanguage",
      language: event.target.value,
    });
  });
  document.getElementById("saveSettings").addEventListener("click", () => {
    vscode.postMessage({
      action: "saveSettings",
      enabled: document.getElementById("workspaceEnabled").checked,
      language: document.getElementById("language").value,
    });
  });
  document.getElementById("openSettings").addEventListener("click", () => {
    vscode.postMessage({ action: "openSettings" });
  });
</script>
</body>
</html>`;
  }
}

export function registerControlCenter(context: vscode.ExtensionContext): void {
  const provider = new ControlCenterProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider),
    vscode.commands.registerCommand("tokenlighten.clients.refresh", () => provider.refresh()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("tokenlighten")) {
        provider.refresh();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => provider.refresh()),
  );
}
