# TokenLighten for VS Code

TokenLighten (TL) helps coding agents use fewer input tokens by giving them precise, task-relevant code context through MCP. This extension provides a self-contained TL installation for VS Code: the CLI, MCP server, parsers, and required assets are bundled in the VSIX.

## What the extension does

The TokenLighten Workspace view is for developers using GitHub Copilot, the VS Code Codex extension, or Claude Code in VS Code. It provides only workspace-scoped controls and data:

- One-click setup for VS Code, GitHub Copilot, Codex, and Claude Code in the current workspace.
- A workspace switch for enabling or temporarily disabling TokenLighten.
- Automatic re-enabling when workspace setup is run again.
- Current TL status and the version reported by the bundled TL CLI.
- Local estimates of this workspace's token and billing reduction rates.
- Export of privacy-safe usage logs for this workspace.
- Japanese and English display languages.

For normal installation or recovery, use **Set up this workspace**. It installs or repairs the TokenLighten MCP configuration and managed AI instructions in one operation, then enables TL for the workspace. Existing project instructions outside TokenLighten-managed sections are preserved.

If TokenLighten causes a problem, clear **Enable TL in this workspace** and save the setting. Check it again, or rerun workspace setup, to restore TL.

## How token reduction works

Coding agents often spend many tokens reading entire files, repeating searches, and asking predictable follow-up questions before they can make a small change. TokenLighten moves that context-selection work into a local MCP server.

TokenLighten exposes three MCP tools: `read_file`, `search_files`, and `edit_file`. For each task, it can return compact structure, symbols, exact source ranges, and stable edit handles instead of repeatedly sending whole files. Searches can lazily build the compact workspace skeleton when it is first needed. The server also closes predictable discovery follow-ups by returning the next relevant context in the same workflow.

The coding agent and its model do not change. TokenLighten reduces the amount of repository context that must be placed in the model's prompt. Savings vary by task, language, repository, and agent behavior; the Control Center figures are local estimates rather than provider billing records.

## 日本語での要点

- **「このワークスペースをセットアップ」だけでTokenLighten（以下「TL」）を導入・修復できます。**
- セットアップするとTLが自動的に有効になります。
- 不具合時は「このワークスペースでTLを有効にする」を外すと、一時的に無効化できます。
- TLはファイル全体ではなく、タスクに必要な構造・シンボル・コード範囲を優先してAIへ渡し、入力トークンを削減します。
- 既存のAI向けルールは、TokenLighten管理領域の外では保持されます。
- 削減率はローカルな推定値であり、AI事業者の請求明細そのものではありません。

## Requirements and privacy

No separate `tl` installation is required. The packaged VSIX includes a zero-install CLI and MCP server, including the parsers and WASM assets they need.

TokenLighten performs repository indexing and context selection locally. The extension does not add another model or upload repository contents on its own. Your selected coding agent remains responsible for any model requests it makes.

Workspace-changing actions require a trusted VS Code workspace.

## Settings

| Setting | Default | Description |
|---|---:|---|
| `tokenlighten.enabled` | `true` | Enables or disables TokenLighten for the current workspace. |
| `tokenlighten.language` | `auto` | Uses the VS Code display language automatically, or selects Japanese or English explicitly. |

## Main workflow

1. Open a project folder in a trusted VS Code workspace.
2. Open the TokenLighten view from the Activity Bar.
3. Select **Set up this workspace** and confirm.
4. Use GitHub Copilot, Codex, Claude Code, or another MCP-capable coding agent normally.

The setup command configures supported clients and managed AI instructions together for the current workspace.

## Status bar

The status bar shows whether the local TokenLighten workspace data is fresh, refreshing, disabled, or in an error state. Saving a supported source file schedules a background refresh of the managed guidance and compact skeleton.

## Install from VSIX

Download **[tokenlighten-vscode-extension-0.9.1.vsix](https://github.com/Takayuki-Ishimaru/tokenlighten/releases/download/v0.9.1/tokenlighten-vscode-extension-0.9.1.vsix)** from the v0.9.1 Public Beta GitHub Release, then use VS Code's **Extensions → Install from VSIX…** command. No source build or separate Node.js installation is required.

ソースからビルドせずに、v0.9.1 Public BetaのGitHub Releaseから上記のVSIXをダウンロードし、VS Codeの**拡張機能 → VSIXからのインストール…**を選択してください。Node.jsを別途インストールする必要はありません。

Developers can instead build the self-contained VSIX from the repository:

```bash
npm run package -w tokenlighten-vscode-extension
code --install-extension packages/vscode-extension/tokenlighten-vscode-extension-<version>.vsix
```

See the [project README](../../README.md) / [日本語](../../README.ja.md) and [documentation](../../release-docs/README.md) for setup, MCP tools, language support, privacy, and licensing.
