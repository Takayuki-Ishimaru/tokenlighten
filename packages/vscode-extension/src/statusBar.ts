// Plain data output — no meta envelope. See docs/00-postmortem.md §2.2.
//
// statusBar.ts — workspace activation and skeleton freshness indicator.

import * as vscode from "vscode";
import type { WorkspaceActivationState } from "./workspaceState.js";

export type DisplayLanguage = "en" | "ja";
export type ConfiguredLanguage = "auto" | DisplayLanguage;
export type OffReason =
  | "disabled"
  | "untrusted"
  | "no-workspace"
  | "unavailable"
  | "not-configured";

export function getTokenLightenConfiguration(): vscode.WorkspaceConfiguration {
  const resource = vscode.workspace.workspaceFolders?.[0]?.uri;
  return vscode.workspace.getConfiguration("tokenlighten", resource);
}

export function getTokenLightenConfigurationTarget(): vscode.ConfigurationTarget {
  return vscode.workspace.workspaceFolders?.length
    ? vscode.ConfigurationTarget.WorkspaceFolder
    : vscode.ConfigurationTarget.Workspace;
}

export function getLanguageConfigurationTarget(): vscode.ConfigurationTarget {
  return vscode.ConfigurationTarget.Global;
}

export function getConfiguredLanguage(): ConfiguredLanguage {
  const configured = getTokenLightenConfiguration()
    .get<ConfiguredLanguage>("language", "auto");
  return configured === "en" || configured === "ja" ? configured : "auto";
}

export function getDisplayLanguage(): DisplayLanguage {
  const configured = getConfiguredLanguage();
  if (configured !== "auto") return configured;
  return vscode.env.language.toLowerCase().startsWith("ja") ? "ja" : "en";
}

export class StatusBarManager {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = "tokenlighten.status";
    this.item.show();
    this.setOff();
  }

  setActivationState(state: WorkspaceActivationState): void {
    if (state === "ready") this.setFresh();
    else this.setOff(state);
  }

  setFresh(): void {
    const ja = getDisplayLanguage() === "ja";
    this.item.text = ja ? "TL: 有効" : "TL: enabled";
    this.item.tooltip = ja
      ? "TokenLightenは有効です。スケルトンは最新です"
      : "TokenLighten is enabled; the skeleton is up-to-date";
  }

  setStale(): void {
    const ja = getDisplayLanguage() === "ja";
    this.item.text = ja ? "TL: 有効（保存中…）" : "TL: enabled (saving…)";
    this.item.tooltip = ja
      ? "TokenLightenがスケルトンを再生成しています"
      : "TokenLighten is regenerating the skeleton";
  }

  setError(message: string): void {
    this.item.text = getDisplayLanguage() === "ja" ? "TL: エラー" : "TL: error";
    this.item.tooltip = message.slice(0, 200);
  }

  setOff(reason: OffReason = "unavailable"): void {
    const ja = getDisplayLanguage() === "ja";
    this.item.text = reason === "not-configured"
      ? ja ? "TL: 未設定" : "TL: not set up"
      : ja ? "TL: 無効" : "TL: disabled";
    const details: Record<OffReason, { en: string; ja: string }> = {
      disabled: {
        en: "TokenLighten is disabled in this workspace",
        ja: "このワークスペースではTokenLightenは無効です",
      },
      untrusted: {
        en: "TokenLighten is inactive because the workspace is not trusted",
        ja: "ワークスペースが信頼されていないためTokenLightenは無効です",
      },
      "no-workspace": {
        en: "Open a workspace folder to set up TokenLighten",
        ja: "TokenLightenを設定するワークスペースフォルダーを開いてください",
      },
      unavailable: {
        en: "TokenLighten extension is inactive (no tl binary)",
        ja: "tlバイナリがないためTokenLighten拡張機能は無効です",
      },
      "not-configured": {
        en: "TokenLighten is not set up in this workspace",
        ja: "このワークスペースではTokenLightenが未設定です",
      },
    };
    this.item.tooltip = details[reason][ja ? "ja" : "en"];
  }

  dispose(): void {
    this.item.dispose();
  }
}