# VS Code extension

[English](vscode-extension.md) | [日本語](vscode-extension.ja.md)

The TokenLighten VS Code extension bundles the CLI, MCP server, parsers, and required assets in one VSIX. A separate `tl` installation is not required.

## Install without building

Download **[tokenlighten-vscode-extension-0.13.1.vsix](https://github.com/Takayuki-Ishimaru/tokenlighten/releases/download/v0.13.1/tokenlighten-vscode-extension-0.13.1.vsix)** from the v0.13.1 GitHub Release. The same VSIX works on Windows, macOS, and Linux.

1. Open **Extensions**.
2. Select **Install from VSIX…**.
3. Choose the downloaded file.
4. Reload VS Code if prompted.

~~~bash
code --install-extension tokenlighten-vscode-extension-0.13.1.vsix
~~~

To build from source:

~~~bash
npm install
npm run package -w tokenlighten-vscode-extension
~~~

## Set up a workspace

Open a trusted project folder, open the TokenLighten view, and choose **Set up this workspace**. Setup configures supported clients and TokenLighten-managed AI instructions while preserving content outside managed blocks.

The workspace switch enables or disables TokenLighten. Re-running setup enables it again, and the session-native command temporarily bypasses TokenLighten without changing the workspace's normal configuration.

v0.13.0 includes a schema stamp in the MCP provider version. When the advertised tool schema changes, VS Code refreshes its cached definition automatically; no manual provider rename or cache reset should be needed.

## Status bar and Diagnostics

Click the TokenLighten status-bar item to open actions for Diagnostics, enable/disable/setup, opening the sidebar, and status. Diagnostics reports:

- extension and TokenLighten versions plus exact `server_build`;
- Node executable and resolved server launch command;
- workspace root and effective write permission;
- MCP/Codex registration files and installed vs bundled guide version; and
- the last TokenLighten calls as tool/mode/kind/duration/error-code metadata.

The diagnostics ring is local and excludes query text, paths, handles, and content. Setting `TOKENLIGHTEN_USAGE_LOG=off` disables both usage recording and this diagnostics ring.

## Usage and calibration

The sidebar distinguishes measured paired calibration from fallback estimates and shows progress toward medium (12 paired samples) and high (24) confidence. These figures are local estimates, not provider billing records.

## Privacy and scope

Repository indexing and context selection run locally. The extension does not add a model or upload repository contents on its own. Your coding agent remains responsible for requests to its model provider. Workspace-changing operations require a trusted VS Code workspace.

## Settings

| Setting | Default | Description |
|---|---:|---|
| `tokenlighten.enabled` | `true` | Enables or disables TokenLighten for the current workspace. |
| `tokenlighten.updateCheck.enabled` | `true` | Checks published GitHub Releases for a newer VSIX at startup; installation always requires user action. |
| `tokenlighten.language` | `auto` | Uses the VS Code display language automatically or selects English/Japanese explicitly. |

The desktop application is not included in the public v0.13.1 release.