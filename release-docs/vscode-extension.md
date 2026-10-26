# VS Code extension

[English](vscode-extension.md) | [日本語](vscode-extension.ja.md)

The TokenLighten VS Code extension bundles the CLI, MCP server, parsers, and required assets in one VSIX. A separate `tl` installation is not required.

## Install without building

Download **[tokenlighten-vscode-extension-0.16.2.vsix](https://github.com/Takayuki-Ishimaru/tokenlighten/releases/download/v0.16.2/tokenlighten-vscode-extension-0.16.2.vsix)** from the v0.16.2 GitHub Release. The same VSIX works on Windows, macOS, and Linux.

1. Open **Extensions**.
2. Select **Install from VSIX…**.
3. Choose the downloaded file.
4. Reload VS Code if prompted.

~~~bash
code --install-extension tokenlighten-vscode-extension-0.16.2.vsix
~~~

To package the VSIX from source, use Node.js 22 or later:

~~~bash
npm install
npm run package -w tokenlighten-vscode-extension
~~~

## Set up a workspace

Open a trusted project folder, open the TokenLighten view, and choose **Set up this workspace**. This runs `tl install --from-extension --workspace <folder> --clients none` — the same machine install a standalone archive produces (see [Getting started](getting-started.md)), but using VS Code's own Node.js runtime instead of a bundled one: it stages the machine install if needed and writes this workspace's supported-client configuration and TokenLighten-managed AI instructions, preserving content outside managed blocks. It does not register other hosts on the machine (Claude Code, Codex) — `--clients none` keeps that opt-in; register them separately with `tl clients activate`, or with an archive's `tl-setup`.

Because the workspace's `.vscode/mcp.json` now carries a managed entry, the extension's own MCP provider stops offering a second definition for that workspace — exactly one `tokenlighten` MCP definition stays enabled, regardless of VS Code's `chat.mcp.collisionBehavior` setting. A workspace that has never been set up gets a provider-supplied fallback definition only if a machine install already exists. Installing the VSIX alone does not start a server; run **Set up this workspace** first.

The workspace switch enables or disables TokenLighten. Re-running setup enables it again, and the session-native command temporarily bypasses TokenLighten without changing the workspace's normal configuration.

v0.13.0 includes a schema stamp in the MCP provider version. When the advertised tool schema changes, VS Code refreshes its cached definition automatically; no manual provider rename or cache reset should be needed.

The `tokenlighten.toolSurface` setting (default `full`) selects the advertised tool schema: `full` includes every capability, `code` advertises code/plain-text/config `tl_read_file`/`tl_edit_file`/`tl_search_files` only — a smaller schema, with Office/archive/credential inputs removed rather than merely refused. See [MCP tools](mcp-tools.md#tool-surface) for details. Changing it is a schema-affecting change like the one above, so VS Code refreshes automatically the same way.

The `tokenlighten.guideProfile` setting selects the guide written into
AGENTS.md/CLAUDE.md during setup: `compact` (default), `medium`, or `full`.
The default is compact on both tool surfaces and for Codex and Claude Code
in the same folder. An explicit folder, workspace or user setting takes
precedence; setup no longer asks a separate guide-size question.

Use normal Copilot **Agent** chats for source questions or changes.
**tokenlighten-explore** remains an optional mode for read-only questions;
it exposes only the TokenLighten read and search tools.

Setup writes a short, self-contained Copilot guide and avoids duplicate
TokenLighten-only attachments when safe, preserving your instructions and
settings. The `tokenlighten.copilotGuide` setting selects `standalone`
(the default) or `agents-md`; the CLI also supports preserving the existing
configuration with `--copilot-guide keep`.

VS Code setup also installs a SessionStart hint for new local Agent chats.
It requires a trusted workspace, enabled `chat.useHooks`, and `node` on PATH.
Setup preserves existing hooks and user edits and does not change tool
permissions. Use `tl workspace setup --clients vscode --copilot-session-context keep`
to leave the hook configuration unchanged. Disable/native controls turn off
TokenLighten's managed Copilot guidance too.

After upgrading to v0.16.2, re-run **Set up this workspace**, then start a
new agent session or reconnect the MCP client. This refreshes the managed
guides, Copilot configuration, and prefixed tool names. See
[Refresh an existing workspace](getting-started.md#refresh-an-existing-workspace-after-upgrading)
for inline-result settings and CLI opt-outs.

Workspace setup through the extension enables writes in generated MCP
settings. To generate read-only settings, use
`tl workspace setup --read-only` from the CLI. Re-running the extension's
setup enables writes again.

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

Repository indexing and context selection run locally. Optional semantic search uses a local embedding model downloaded at your request and is off by default. Repository content is not sent to a model service by this engine. Your coding agent remains responsible for requests to its model provider. Workspace-changing operations require a trusted VS Code workspace.

## Local analysis engines

Open **TokenLighten: Manage Local Analysis Engines** from the Command Palette to configure typed symbol resolution, compound requests and semantic search. Typed resolution and semantic search are off by default. The panel supports model download, language-server configuration and license viewing. See [Local analysis engines](local-analysis.md).

## Settings

| Setting | Default | Description |
|---|---:|---|
| `tokenlighten.enabled` | `true` | Enables or disables TokenLighten for the current workspace. |
| `tokenlighten.autoUpdate.enabled` | `true` | Automatically downloads and installs newer VSIX releases. Toggle “Automatically update the extension” in the sidebar; changes apply immediately to all workspaces. When off, updates only produce notifications. Reload from the notification when convenient. |
| `tokenlighten.updateCheck.enabled` | `true` | Checks GitHub Releases at startup and every six hours. Disabling also stops automatic updates. Enabling automatic updates in the sidebar also enables this setting. |
| `tokenlighten.confirmResetOnUpdate` | `true` | After an update to a newer version (automatic or manual), asks whether to reset your TokenLighten user settings to their defaults, listing each one that differs from the new default; closing the notification without answering asks again at the next startup. Workspace and folder settings are never changed. Choose “Don't Ask Again” in the notification to turn this off. |
| `tokenlighten.language` | `auto` | Uses the VS Code display language automatically or selects English/Japanese explicitly. |
| `tokenlighten.toolSurface` | `full` | Advertised MCP tool surface: `full` (every capability) or `code` (code/plain-text/config only, a smaller tool schema). Changing this requires reconnecting. |
| `tokenlighten.copilotGuide` | `standalone` | Copilot guide mode: short self-contained instructions, shared AGENTS.md instructions, or keep existing configuration. |
| `tokenlighten.guideProfile` | `compact` | Shared guide size written during setup: `compact`, `medium`, or `full`. An explicit value takes precedence on both tool surfaces. |

The desktop application is not included in the public v0.16.2 release.
