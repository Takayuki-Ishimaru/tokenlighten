import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { MULTILINGUAL_E5_MODEL, E5_MIT_NOTICE } from "@tokenlighten/types";
import { getDisplayLanguage } from "./statusBar.js";
import { spawnTl } from "./cli.js";
import { renderLicenseContent } from "./licenseContent.js";

function html(value: unknown): string {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

async function cliJson(args: string[]): Promise<Record<string, unknown>> {
  const result = await spawnTl(args);
  if (result.code !== 0) throw new Error(result.stderr || "TokenLighten CLI is unavailable");
  const parsed: unknown = JSON.parse(result.stdout);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid TokenLighten status");
  return parsed as Record<string, unknown>;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function engineStatus(): Promise<Record<string, unknown>> {
  const status = await cliJson(["engines", "status", "--json"]);
  const config = status.config;
  if (!record(config) || ["typedSymbols", "compoundRequests", "semanticSearch"].some(key =>
    !record(config[key]) || typeof config[key].enabled !== "boolean")
    || !record(config.typedSymbols) || typeof config.typedSymbols.discoverServers !== "boolean"
    || !record(config.typedSymbols.servers)) throw new Error("Invalid TokenLighten engine status");
  return status;
}

async function modelStatus(): Promise<Record<string, unknown>> {
  const status = await cliJson(["models", "list", "--json"]);
  if (typeof status.status !== "string" || !["ready", "missing", "incomplete"].includes(status.status)) {
    throw new Error("Invalid TokenLighten model status");
  }
  return status;
}

async function notices(context: vscode.ExtensionContext): Promise<string> {
  for (const path of [join(context.extensionPath, "THIRD_PARTY_NOTICES.md"), join(context.extensionPath, "dist", "THIRD_PARTY_NOTICES.md")]) {
    try { return await readFile(path, "utf8"); } catch { /* Try the other packaged notice location. */ }
  }
  return getDisplayLanguage() === "ja" ? "ライセンス文書を読み込めません。拡張機能を再インストールしてください。" : "The license document is missing. Reinstall the extension.";
}

export function registerLicenseCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.commands.registerCommand("tokenlighten.licenses.show", async () => {
    const panel = vscode.window.createWebviewPanel("tokenlighten-licenses", getDisplayLanguage() === "ja" ? "TokenLighten ライセンス" : "TokenLighten Licenses", vscode.ViewColumn.One, { enableScripts: true, localResourceRoots: [] });
    const text = await notices(context);
    let installed = false;
    try { installed = (await modelStatus()).status === "ready"; } catch { /* License viewing works without a CLI or installed model. */ }
    panel.webview.html = renderLicenseContent({ notices: text, models: [{ id: MULTILINGUAL_E5_MODEL.id,
      revision: MULTILINGUAL_E5_MODEL.revision, license: MULTILINGUAL_E5_MODEL.license,
      source: MULTILINGUAL_E5_MODEL.source, licenseText: E5_MIT_NOTICE, notice: MULTILINGUAL_E5_MODEL.note, installed }],
      language: getDisplayLanguage(), nonce: randomBytes(16).toString("hex") });
  }));
  context.subscriptions.push(vscode.commands.registerCommand("tokenlighten.engines.show", async () => {
    const ja = getDisplayLanguage() === "ja";
    const panel = vscode.window.createWebviewPanel("tokenlighten-engines", ja ? "TokenLighten 解析エンジン" : "TokenLighten Analysis Engines", vscode.ViewColumn.One, { enableScripts: true, localResourceRoots: [] });
    const refresh = async (): Promise<void> => {
      const nonce = randomBytes(16).toString("hex");
      let status: Record<string, unknown> = {}; let model: Record<string, unknown> = {}; let error = "";
      const [engineRead, modelRead] = await Promise.allSettled([engineStatus(), modelStatus()]);
      if (engineRead.status === "fulfilled") status = engineRead.value;
      if (modelRead.status === "fulfilled") model = modelRead.value;
      error = [engineRead, modelRead].flatMap(read => read.status === "rejected"
        ? [read.reason instanceof Error ? read.reason.message : String(read.reason)] : []).join("; ");
      const config = status.config as Record<string, { enabled?: boolean; discoverServers?: boolean; servers?: unknown }> | undefined;
      const ready = model.status === "ready";
      const label = (en: string, jp: string): string => ja ? jp : en;
      const toggle = (key: string, en: string, jp: string): string => `<label><input type="checkbox" data-engine="${key}" ${config?.[key]?.enabled ? "checked" : ""}${engineRead.status === "rejected" ? " disabled" : ""}>${label(en, jp)}</label>`;
      panel.webview.html = `<!doctype html><html lang="${ja ? "ja" : "en"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'"><style>body{font:var(--vscode-font-size)/1.6 var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:24px;max-width:980px}section{border:1px solid var(--vscode-panel-border);padding:18px;margin:16px 0;border-radius:8px}label{display:block;margin:12px 0}button{color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;padding:9px 14px;margin:4px;cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere}.muted{color:var(--vscode-descriptionForeground)}</style></head><body><h1>${label("Local analysis engines", "ローカル解析エンジン")}</h1><p class="muted">${label("Settings apply to this user. Reconnect MCP clients after changing engines.", "設定はこのユーザーに適用されます。変更後はMCPクライアントを再接続してください。")}</p><p>${html(error)}</p><section><h2>${label("Typed symbols and compound requests", "型付きシンボル解決・複合依頼")}</h2>${toggle("typedSymbols", "Typed symbol resolution", "型付きシンボル解決")}${toggle("compoundRequests", "Compound request composition", "複合依頼の分解・統合")}<p>${label("Built-in TypeScript/JavaScript; Python, Go, Rust, Java, C/C++, C#, Kotlin, PHP and Ruby use installed language servers.", "TS/JSは内蔵解析。Python・Go・Rust・Java・C/C++・C#・Kotlin・PHP・Rubyはインストール済みLanguage Serverを使用します。")}</p><label><input id="discover" type="checkbox" ${config?.typedSymbols?.discoverServers ? "checked" : ""}${engineRead.status === "rejected" ? " disabled" : ""}>${label("Discover installed servers on PATH", "PATH上のLanguage Serverを探す")}</label><button data-action="server">${label("Configure a language server", "Language Serverを設定")}</button><details><summary>${label("Configured servers", "設定済みサーバー")}</summary><pre>${html(JSON.stringify(config?.typedSymbols?.servers ?? {}, null, 2))}</pre></details></section><section><h2>${label("Local multilingual semantic search", "ローカル多言語の意味検索")}</h2><p>${html(MULTILINGUAL_E5_MODEL.id)} · MIT</p><p>${label("Model", "モデル")}: ${modelRead.status === "rejected" ? label("Status unavailable", "取得状況を確認できません") : ready ? label("Downloaded", "取得済み") : label("Not downloaded / incomplete", "未取得・不完全")}</p><p class="muted">${label("Download public model files once; queries and repository content remain on this computer. Model files are stored in the user cache.", "公開モデルを一度取得します。検索文とリポジトリ内容はこのコンピューターで処理します。モデルはユーザーのキャッシュに保存します。")}</p>${toggle("semanticSearch", "Enable semantic search", "意味検索を有効にする")}<button data-action="install">${label("Download model and enable", "モデルを取得して有効化")}</button><button data-action="licenses">${label("View all licenses", "ライセンス一覧を見る")}</button><details><summary>${label("Model revision and provenance", "モデルの版・出典")}</summary><pre>${html(JSON.stringify(MULTILINGUAL_E5_MODEL, null, 2))}</pre></details></section><script nonce="${nonce}">const vscode=acquireVsCodeApi();document.querySelectorAll('[data-action]').forEach(button=>button.addEventListener('click',()=>vscode.postMessage({action:button.dataset.action})));document.querySelectorAll('[data-engine]').forEach(input=>input.addEventListener('change',()=>vscode.postMessage({action:'set',engine:input.dataset.engine,enabled:input.checked})));document.getElementById('discover').addEventListener('change',event=>vscode.postMessage({action:'discovery',enabled:event.target.checked}));</script></body></html>`;
    };
    const receive = async (message: { action?: unknown; engine?: unknown; enabled?: unknown }): Promise<void> => {
      let attemptedMutation = false;
      try {
        if (message.action === "licenses") { await vscode.commands.executeCommand("tokenlighten.licenses.show"); return; }
        if (!vscode.workspace.isTrusted) throw new Error(ja ? "信頼済みワークスペースで設定してください。" : "Configure engines from a trusted workspace.");
        if (message.action === "set" && typeof message.enabled === "boolean" && typeof message.engine === "string" && ["typedSymbols", "compoundRequests", "semanticSearch"].includes(message.engine)) {
          attemptedMutation = true;
          await cliJson(["engines", "set", message.engine, message.enabled ? "on" : "off"]);
        } else if (message.action === "discovery" && typeof message.enabled === "boolean") {
          attemptedMutation = true;
          await cliJson(["engines", "discovery", message.enabled ? "on" : "off"]);
        } else if (message.action === "server") {
          const language = await vscode.window.showQuickPick(["py", "go", "rs", "java", "c", "cpp", "cs", "kt", "php", "rb"], { title: ja ? "Language Serverの言語" : "Language server language" });
          if (!language) return;
          const executable = await vscode.window.showInputBox({ title: ja ? "Language Serverの実行ファイル" : "Language server executable", ignoreFocusOut: true });
          if (!executable) return;
          const rawArgs = await vscode.window.showInputBox({ title: ja ? "引数（JSON配列）" : "Arguments (JSON array)", value: "[]", ignoreFocusOut: true });
          if (rawArgs === undefined) return;
          const args: unknown = JSON.parse(rawArgs);
          if (!Array.isArray(args) || !args.every(arg => typeof arg === "string")) throw new Error("Expected a JSON string array");
          attemptedMutation = true;
          await cliJson(["engines", "server", language, executable, ...args as string[]]);
        } else if (message.action === "install") {
          attemptedMutation = true;
          await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: ja ? "TokenLighten: 多言語モデルを取得中" : "TokenLighten: Downloading multilingual model", cancellable: true }, async (_progress, token) => {
            const controller = new AbortController();
            const cancellation = token.onCancellationRequested(() => controller.abort());
            if (token.isCancellationRequested) controller.abort();
            try {
              const result = await spawnTl(["models", "install", "--json"], { timeoutMs: 900_000, signal: controller.signal });
              if (result.code !== 0) throw new Error(result.stderr || (ja ? "モデル取得を完了できませんでした。" : "Model installation did not complete."));
            } finally { cancellation.dispose(); }
          });
        } else return;
        await refresh();
      } catch (error) {
        void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
        if (attemptedMutation) await refresh();
      }
    };
    let pending = Promise.resolve();
    const subscription = panel.webview.onDidReceiveMessage((message: { action?: unknown; engine?: unknown; enabled?: unknown }) => {
      pending = pending.then(() => receive(message), () => receive(message));
      return pending;
    });
    panel.onDidDispose(() => subscription.dispose());
    await refresh();
  }));
}
