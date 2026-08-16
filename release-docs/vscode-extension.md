# VS Code extension

[English](vscode-extension.md) | [日本語](vscode-extension.ja.md)

The TokenLighten VS Code extension bundles the TokenLighten CLI, MCP server, parsers, and required assets in a VSIX. A separate `tl` installation is not required when you use the packaged extension.

## Install without building

Download **[tokenlighten-vscode-extension-0.9.1.vsix](https://github.com/Takayuki-Ishimaru/tokenlighten/releases/download/v0.9.1/tokenlighten-vscode-extension-0.9.1.vsix)** from the v0.9.1 Public Beta GitHub Release. You do not need Node.js or a source build. The same VSIX is used on Windows, macOS, and Linux because this release does not include OS-specific native binaries.

Install it from VS Code:

1. Open **Extensions**.
2. Select **Install from VSIX…** from the Extensions view menu.
3. Choose the downloaded `.vsix` file.
4. Reload VS Code if prompted.

You can also install it from the command line:

```bash
code --install-extension tokenlighten-vscode-extension-<version>.vsix
```

To build the VSIX from source:

```bash
npm ci
npm run package -w tokenlighten-vscode-extension
```

Use `npm install` instead only when intentionally changing dependencies and updating the lockfile.

## Set up a workspace

Open a trusted project folder, then open the TokenLighten view from the Activity Bar and choose **Set up this workspace**. The setup flow configures supported clients and TokenLighten-managed AI instructions for that workspace.

The extension supports a workspace switch to enable or disable TokenLighten. Re-running workspace setup enables it again. A session-level native-tools option is available when you need to temporarily bypass TokenLighten.

## Privacy and scope

Repository indexing and context selection run locally. The extension does not add a model or upload repository contents on its own. Your chosen coding agent remains responsible for any requests it sends to its model provider.

Usage and saving figures shown by the extension are local estimates, not provider billing records. Workspace-changing operations require a trusted VS Code workspace.

## Settings

| Setting | Default | Description |
|---|---:|---|
| `tokenlighten.enabled` | `true` | Enables or disables TokenLighten for the current workspace. |
| `tokenlighten.language` | `auto` | Uses the VS Code display language automatically, or selects English or Japanese explicitly. |

The desktop application is not included in this release.
