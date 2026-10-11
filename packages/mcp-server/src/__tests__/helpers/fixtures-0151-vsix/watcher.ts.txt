// Plain data output — no meta envelope. See docs/00-postmortem.md §2.2.
//
// watcher.ts — onSave debounce → tl spawn bridge.
// Spec: docs/06-stable-prefix-rebuild.md §2.4 / §3.7.
//
// Anti-scope: this file does NOT generate skeletons or AGENTS.md directly.
// All work goes through `tl` (CLI) so skeleton-engine stays the single source
// of truth (§3.7 "VSCode 拡張は generate しない").

import * as vscode from "vscode";
import { getDisplayLanguage } from "./statusBar.js";
import type { StatusBarManager } from "./statusBar.js";
import type { SpawnResult } from "./cli.js";

const DEBOUNCE_MS = 5000;
const WATCHED_LANGUAGES = new Set([
  "typescript", "typescriptreact", "javascript", "javascriptreact",
  "python", "go", "java", "rust", "ruby", "php", "csharp", "cpp", "c",
]);

type SpawnFn = (args: string[]) => Promise<SpawnResult>;

export class WorkspaceWatcher {
  private readonly bar: StatusBarManager;
  private readonly spawn: SpawnFn;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(bar: StatusBarManager, spawn: SpawnFn) {
    this.bar = bar;
    this.spawn = spawn;

    const listener = vscode.workspace.onDidSaveTextDocument((doc) => {
      if (!this.isTracked(doc)) return;
      this.scheduleRun();
    });
    this.disposables.push(listener);
  }

  private isTracked(doc: vscode.TextDocument): boolean {
    if (!WATCHED_LANGUAGES.has(doc.languageId)) return false;
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return false;
    return folders.some((f) => doc.uri.fsPath.startsWith(f.uri.fsPath));
  }

  private scheduleRun(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.run(); }, DEBOUNCE_MS);
  }

  private async run(): Promise<void> {
    this.timer = undefined;
    this.bar.setStale();

    const agentsResult = await this.spawn(["agents-md", "write", "--for-target"]);
    if (agentsResult.code !== 0) {
      const msg = (agentsResult.stderr || agentsResult.stdout).split("\n")[0]
        || (getDisplayLanguage() === "ja"
          ? "AGENTS.mdの書き込みに失敗しました"
          : "agents-md write failed");
      this.bar.setError(msg);
      return;
    }

    const skelResult = await this.spawn(["skeleton", "build", "--compact"]);
    if (skelResult.code !== 0) {
      const msg = (skelResult.stderr || skelResult.stdout).split("\n")[0]
        || (getDisplayLanguage() === "ja"
          ? "スケルトンの構築に失敗しました"
          : "skeleton build failed");
      this.bar.setError(msg);
      return;
    }

    this.bar.setFresh();
  }

  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    for (const d of this.disposables) d.dispose();
  }
}
