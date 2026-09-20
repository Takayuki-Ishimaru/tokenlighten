# VS Code extension

[English](vscode-extension.md) | [日本語](vscode-extension.ja.md)

The TokenLighten VS Code extension bundles the CLI, MCP server, parsers, and required assets in one VSIX. A separate `tl` installation is not required.

## Install without building

Download **[tokenlighten-vscode-extension-0.14.3.vsix](https://github.com/Takayuki-Ishimaru/tokenlighten/releases/download/v0.14.3/tokenlighten-vscode-extension-0.14.3.vsix)** from the v0.14.3 GitHub Release. The same VSIX works on Windows, macOS, and Linux.

1. Open **Extensions**.
2. Select **Install from VSIX…**.
3. Choose the downloaded file.
4. Reload VS Code if prompted.

~~~bash
code --install-extension tokenlighten-vscode-extension-0.14.3.vsix
~~~

To build from source:

~~~bash
npm install
npm run package -w tokenlighten-vscode-extension
~~~

## Set up a workspace

Open a trusted project folder, open the TokenLighten view, and choose **Set up this workspace**. This runs `tl install --from-extension --workspace <folder> --clients none` — the same machine install a standalone archive produces (see [Getting started](getting-started.md)), but using VS Code's own Node.js runtime instead of a bundled one: it stages the machine install if needed and writes this workspace's supported-client configuration and TokenLighten-managed AI instructions, preserving content outside managed blocks. It does not register other hosts on the machine (Claude Code, Codex) — `--clients none` keeps that opt-in; register them separately with `tl clients activate`, or with an archive's `tl-setup`.

Because the workspace's `.vscode/mcp.json` now carries a managed entry, the extension's own MCP provider stops offering a second definition for that workspace — exactly one `tokenlighten` MCP definition stays enabled, regardless of VS Code's `chat.mcp.collisionBehavior` setting. A workspace that has never been set up gets a provider-supplied fallback definition only if a machine install already exists. Installing the VSIX alone does not start a server; run **Set up this workspace** first.

The workspace switch enables or disables TokenLighten. Re-running setup enables it again, and the session-native command temporarily bypasses TokenLighten without changing the workspace's normal configuration.

v0.13.0 includes a schema stamp in the MCP provider version. When the advertised tool schema changes, VS Code refreshes its cached definition automatically; no manual provider rename or cache reset should be needed.

The `tokenlighten.toolSurface` setting (default `full`) selects the advertised tool schema: `full` includes every capability, `code` advertises code/plain-text/config `read_file`/`edit_file`/`search_files` only — a smaller schema, with Office/archive/credential inputs removed rather than merely refused. See [MCP tools](mcp-tools.md#tool-surface) for details. Changing it is a schema-affecting change like the one above, so VS Code refreshes automatically the same way.

The `tokenlighten.guideProfile` setting selects the size of guide written into AGENTS.md/CLAUDE.md during setup: `full`, `medium`, or `compact`. When it is unset and the tool surface is `full`, setup offers a choice of the full guide or a compact guide for Copilot-only workspaces. Dismissing the choice keeps the full guide. With `tokenlighten.toolSurface: code`, the default is compact without a prompt. The guide is shared with Codex and Claude Code in the same folder. Set `tokenlighten.guideProfile` explicitly to override this default in either direction.

After upgrading to v0.14.3, re-run **Set up this workspace** and reconnect the MCP client to refresh the managed instructions and Copilot configuration. See [Refresh an existing workspace](getting-started.md#refresh-an-existing-workspace-after-upgrading) for inline-result settings and the CLI opt-out.

## Uninstall

**TokenLighten: Uninstall TokenLighten from This Machine** (command `tokenlighten.uninstallMachine`) removes the machine install (staged runtime, host identity) and TokenLighten-managed host registrations (Claude Code, Codex); entries you or another tool wrote are left in place and reported. For every workspace this machine install set up, it also removes TokenLighten's managed guide blocks and its managed `tokenlighten` entries from `.vscode/mcp.json`, `.mcp.json`, and `.codex/config.toml` (a `.tl-backup` copy is kept next to an edited MCP file); your own text and other servers' entries are untouched. On Windows, a runtime file still in use by a running AI host is removed once that host is closed. Removing the VSIX by itself does not remove the machine install; run this command, or the absolute `tl install --uninstall` invocation described in [Uninstall](getting-started.md#uninstall) (nothing puts `<home>/bin` on `PATH`, so a bare `tl install --uninstall` will not resolve), first.

## Status bar and Diagnostics

Click the TokenLighten status-bar item to open actions for Diagnostics, enable/disable/setup, opening the sidebar, and status. Diagnostics reports:

- extension and TokenLighten versions plus exact `server_build`;
- Node executable and resolved server launch command;
- workspace root and effective write permission;
- MCP/Codex registration files and installed vs bundled guide version;
- `install_consistency`: the machine install's version against this extension's bundled version and any `tl` found on `PATH`; and
- the last TokenLighten calls as tool/mode/kind/duration/error-code metadata.

The diagnostics ring is local and excludes query text, paths, handles, and content. Setting `TOKENLIGHTEN_USAGE_LOG=off` disables both usage recording and this diagnostics ring.

## Usage and calibration

The sidebar shows local usage information and distinguishes measurements from fallback estimates. These estimates are not provider billing records.

## Privacy and scope

Repository indexing and context selection run locally. The extension does not add a model or upload repository contents on its own. Your coding agent remains responsible for requests to its model provider. Workspace-changing operations require a trusted VS Code workspace.

## Settings

| Setting | Default | Description |
|---|---:|---|
| `tokenlighten.enabled` | `true` | Enables or disables TokenLighten for the current workspace. |
| `tokenlighten.updateCheck.enabled` | `true` | Checks published GitHub Releases for a newer VSIX at startup; installation always requires user action. |
| `tokenlighten.language` | `auto` | Uses the VS Code display language automatically or selects English/Japanese explicitly. |
| `tokenlighten.toolSurface` | `full` | Advertised MCP tool surface: `full` (every capability) or `code` (code/plain-text/config only, a smaller tool schema). Changing this requires reconnecting. |
| `tokenlighten.guideProfile` | `full` | Guide size written during setup: `full`, `medium`, or `compact`. Left unset, setup writes `compact` instead of `full` when `tokenlighten.toolSurface` is `code`; an explicit value here always wins over that default. |

The desktop application is not included in the public v0.14.3 release.