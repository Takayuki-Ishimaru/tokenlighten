// Plain data output — no meta envelope. See docs/00-postmortem.md §2.2.
//
// diagnosticsPanel.ts — the vscode-dependent half of the "TokenLighten:
// Diagnostics" view: gathers workspace-scoped inputs, calls the pure
// collectDiagnostics() (diagnostics.ts), and renders a webview panel.
// CSP/nonce/COPY conventions follow sidebar.ts.

import { randomBytes } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import * as vscode from "vscode";
import { defaultDiagDir, diagWorkspaceKey, type DiagRingCall } from "@tokenlighten/usage/diag";
import {
  collectDiagnostics,
  formatDiagnosticsText,
  type DiagnosticsSnapshot,
} from "./diagnostics.js";
import { getDisplayLanguage } from "./statusBar.js";
import type { DisplayLanguage } from "./statusBar.js";
import { workspaceMcpSettingsCached } from "./workspaceState.js";

const WATCH_DEBOUNCE_MS = 300;

interface PanelMessage {
  action?: unknown;
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
    title: "TokenLighten Diagnostics",
    noWorkspace: "Open a workspace folder to see TokenLighten diagnostics.",
    extensionVersion: "Extension version",
    tlVersion: "TL CLI/server version",
    serverBuild: "Server build",
    nodeExecutable: "Node executable",
    serverLaunch: "Server launch",
    workspaceRoot: "Workspace root",
    writeEnabled: "Write enabled (--allow-write)",
    registration: "Registration",
    guide: "Guide (AGENTS.md / CLAUDE.md)",
    lastCalls: "Last call(s)",
    copy: "Copy diagnostics",
    copied: "TokenLighten diagnostics copied to clipboard.",
    refresh: "Refresh",
    yes: "Yes",
    no: "No",
    unknown: "Unknown",
    present: "present",
    absent: "absent",
    registered: "registered",
    notRegistered: "no tokenlighten entry",
    notInstalled: "not installed",
    upToDate: "up to date",
    outOfDate: `out of date`,
    bundled: "bundled",
    noCalls: "No calls recorded yet.",
    disabledCalls: "Recording is disabled for this workspace.",
    ok: "ok",
    error: "error",
  },
  ja: {
    title: "TokenLighten 診断",
    noWorkspace: "TokenLightenの診断を表示するには、ワークスペースフォルダーを開いてください。",
    extensionVersion: "拡張機能バージョン",
    tlVersion: "TL CLI/サーバーバージョン",
    serverBuild: "サーバービルド",
    nodeExecutable: "Node実行ファイル",
    serverLaunch: "サーバー起動コマンド",
    workspaceRoot: "ワークスペースルート",
    writeEnabled: "書き込み許可（--allow-write）",
    registration: "登録状況",
    guide: "ガイド（AGENTS.md / CLAUDE.md）",
    lastCalls: "最終呼び出し",
    copy: "診断情報をコピー",
    copied: "TokenLightenの診断情報をクリップボードにコピーしました。",
    refresh: "再読み込み",
    yes: "はい",
    no: "いいえ",
    unknown: "不明",
    present: "あり",
    absent: "なし",
    registered: "登録済み",
    notRegistered: "tokenlightenエントリなし",
    notInstalled: "未インストール",
    upToDate: "最新",
    outOfDate: "更新が必要",
    bundled: "同梱版",
    noCalls: "呼び出し記録はまだありません。",
    disabledCalls: "このワークスペースでは記録が無効です。",
    ok: "成功",
    error: "エラー",
  },
} as const;

type Copy = typeof COPY["en" | "ja"];

function boolText(copy: Copy, value: boolean | null): string {
  return value === null ? copy.unknown : value ? copy.yes : copy.no;
}

function renderRegistrationRow(
  copy: Copy,
  label: string,
  status: DiagnosticsSnapshot["registrations"]["claudeMcpJson"],
): string {
  const state = !status.fileExists
    ? copy.absent
    : status.hasTokenlighten
      ? copy.registered
      : copy.notRegistered;
  const allowWrite = status.allowWrite === null ? "" : ` · --allow-write: ${boolText(copy, status.allowWrite)}`;
  return `<div class="row"><span class="label">${escapeHtml(label)}</span><span class="value">${escapeHtml(state)}${allowWrite}</span><span class="path">${escapeHtml(status.path)}</span></div>`;
}

function renderCall(copy: Copy, call: DiagRingCall): string {
  const outcome = call.ok
    ? copy.ok
    : `${copy.error}${call.error_code ? ` (${escapeHtml(call.error_code)})` : ""}`;
  const modeOrKind = [call.mode, call.kind].filter(Boolean).join(" → ");
  return `<li><code>${escapeHtml(call.at)}</code> — <strong>${escapeHtml(call.tool)}</strong>${
    modeOrKind ? ` [${escapeHtml(modeOrKind)}]` : ""
  }, ${call.ms}ms, ${escapeHtml(outcome)}</li>`;
}

function renderPanelHtml(
  webview: vscode.Webview,
  snapshot: DiagnosticsSnapshot,
  language: DisplayLanguage,
): string {
  const copy = COPY[language];
  const nonce = randomBytes(16).toString("hex");
  const guideLine = snapshot.guide.installedVersion === null
    ? `${escapeHtml(copy.notInstalled)} (${escapeHtml(copy.bundled)}: ${escapeHtml(snapshot.guide.bundledVersion)})`
    : `${escapeHtml(snapshot.guide.installedVersion)} [${escapeHtml(snapshot.guide.source ?? "")}] — ${
      snapshot.guide.upToDate ? escapeHtml(copy.upToDate) : escapeHtml(copy.outOfDate)
    } (${escapeHtml(copy.bundled)}: ${escapeHtml(snapshot.guide.bundledVersion)})`;
  const callsHtml = snapshot.ring.status === "ok" && snapshot.ring.calls.length > 0
    ? `<ul class="calls">${snapshot.ring.calls.map((call) => renderCall(copy, call)).join("")}</ul>`
    : `<p class="muted">${
      snapshot.ring.status === "disabled" ? escapeHtml(copy.disabledCalls) : escapeHtml(copy.noCalls)
    }</p>`;

  return `<!doctype html>
<html lang="${language}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 18px 22px 28px;
    color: var(--vscode-foreground);
    font: var(--vscode-font-size)/1.5 var(--vscode-font-family);
  }
  h1 { font-size: 16px; margin: 0 0 14px; }
  h2 {
    font-size: 11px;
    letter-spacing: .08em;
    text-transform: uppercase;
    color: var(--vscode-descriptionForeground);
    margin: 22px 0 8px;
  }
  .row {
    display: grid;
    grid-template-columns: 220px 1fr;
    gap: 4px 12px;
    padding: 6px 0;
    border-bottom: 1px solid var(--vscode-panel-border);
    font-size: 13px;
  }
  .row .label { color: var(--vscode-descriptionForeground); }
  .row .value { word-break: break-all; }
  .row .path {
    grid-column: 2;
    color: var(--vscode-descriptionForeground);
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px;
    word-break: break-all;
  }
  code {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 12px;
  }
  ul.calls { list-style: none; margin: 0; padding: 0; }
  ul.calls li {
    padding: 6px 0;
    border-bottom: 1px solid var(--vscode-panel-border);
    font-size: 12px;
  }
  .muted { color: var(--vscode-descriptionForeground); font-size: 12px; }
  .actions { display: flex; gap: 8px; margin-top: 20px; }
  button {
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 4px;
    padding: 6px 12px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    cursor: pointer;
  }
  button.primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
</style>
</head>
<body>
<h1>${escapeHtml(copy.title)}</h1>

<div class="row"><span class="label">${escapeHtml(copy.extensionVersion)}</span><span class="value">${escapeHtml(snapshot.extensionVersion)}</span></div>
<div class="row"><span class="label">${escapeHtml(copy.tlVersion)}</span><span class="value">${escapeHtml(snapshot.tlVersion ?? copy.unknown)}</span></div>
<div class="row"><span class="label">${escapeHtml(copy.serverBuild)}</span><span class="value">${escapeHtml(snapshot.ring.serverBuild ?? copy.unknown)}</span></div>
<div class="row"><span class="label">${escapeHtml(copy.nodeExecutable)}</span><span class="value">${escapeHtml(snapshot.nodeExecutable)}</span></div>
<div class="row"><span class="label">${escapeHtml(copy.serverLaunch)}</span><span class="value">${escapeHtml(snapshot.serverLaunch.command)} ${escapeHtml(snapshot.serverLaunch.args.join(" "))}</span></div>
<div class="row"><span class="label">${escapeHtml(copy.workspaceRoot)}</span><span class="value">${escapeHtml(snapshot.workspaceRoot)}</span></div>
<div class="row"><span class="label">${escapeHtml(copy.writeEnabled)}</span><span class="value">${escapeHtml(boolText(copy, snapshot.writeEnabledSetting))}</span></div>

<h2>${escapeHtml(copy.registration)}</h2>
${renderRegistrationRow(copy, ".mcp.json (Claude Code)", snapshot.registrations.claudeMcpJson)}
${renderRegistrationRow(copy, ".vscode/mcp.json (VS Code)", snapshot.registrations.vscodeMcpJson)}
${renderRegistrationRow(copy, ".codex/config.toml (Codex)", snapshot.registrations.codexConfigToml)}

<h2>${escapeHtml(copy.guide)}</h2>
<div class="row"><span class="value">${guideLine}</span></div>

<h2>${escapeHtml(copy.lastCalls)}</h2>
${callsHtml}

<div class="actions">
  <button class="primary" id="copy">${escapeHtml(copy.copy)}</button>
  <button id="refresh">${escapeHtml(copy.refresh)}</button>
</div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  document.getElementById("copy").addEventListener("click", () => {
    vscode.postMessage({ action: "copy" });
  });
  document.getElementById("refresh").addEventListener("click", () => {
    vscode.postMessage({ action: "refresh" });
  });
</script>
</body>
</html>`;
}

function renderNoWorkspaceHtml(webview: vscode.Webview, language: DisplayLanguage): string {
  const copy = COPY[language];
  return `<!doctype html>
<html lang="${language}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline';">
<style>body{font:var(--vscode-font-size)/1.5 var(--vscode-font-family);color:var(--vscode-foreground);padding:24px}</style>
</head><body>${escapeHtml(copy.noWorkspace)}</body></html>`;
}

export function showDiagnosticsPanel(context: vscode.ExtensionContext): void {
  const language = getDisplayLanguage();
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const panel = vscode.window.createWebviewPanel(
    "tokenlightenDiagnostics",
    COPY[language].title,
    vscode.ViewColumn.One,
    { enableScripts: true },
  );

  if (!workspaceRoot) {
    panel.webview.html = renderNoWorkspaceHtml(panel.webview, language);
    return;
  }

  let watcher: FSWatcher | undefined;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let latestSnapshot: DiagnosticsSnapshot | undefined;

  const render = (): void => {
    const settings = workspaceMcpSettingsCached();
    const currentLanguage = getDisplayLanguage();
    const snapshot = collectDiagnostics({
      extensionVersion: typeof context.extension.packageJSON["version"] === "string"
        ? context.extension.packageJSON["version"]
        : "unknown",
      workspaceRoot,
      writeEnabledSetting: settings?.writeEnabled ?? null,
      usageLoggingEnabledSetting: settings?.usageLoggingEnabled ?? null,
    });
    latestSnapshot = snapshot;
    panel.webview.html = renderPanelHtml(panel.webview, snapshot, currentLanguage);
  };

  const scheduleRender = (): void => {
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(render, WATCH_DEBOUNCE_MS);
  };

  // Best-effort live refresh: watch the diagnostics directory (not the ring
  // file itself, which may not exist yet, and which this session's own
  // server updates via atomic tmp+rename — a directory watch survives that
  // rename where a direct file watch on some platforms would not) and
  // re-render only on the one filename that belongs to this workspace.
  try {
    const diagDir = defaultDiagDir();
    const expectedName = `${diagWorkspaceKey(workspaceRoot)}.json`;
    watcher = watch(diagDir, { persistent: false }, (_event, filename) => {
      if (filename === expectedName || filename === null) scheduleRender();
    });
  } catch {
    // No diagnostics directory yet, or fs.watch unsupported here — the
    // Refresh button remains the reliable fallback either way.
  }

  panel.webview.onDidReceiveMessage((message: PanelMessage) => {
    if (message.action === "refresh") {
      render();
      return;
    }
    if (message.action === "copy") {
      if (latestSnapshot) {
        void vscode.env.clipboard.writeText(
          formatDiagnosticsText(latestSnapshot, getDisplayLanguage()),
        );
        void vscode.window.showInformationMessage(COPY[getDisplayLanguage()].copied);
      }
    }
  });

  panel.onDidDispose(() => {
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    watcher?.close();
  });

  context.subscriptions.push(panel);
  render();
}
