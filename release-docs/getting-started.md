# Getting started

TokenLighten runs locally and provides an MCP server for coding agents.

## Install an archive (no editor extension, no separate Node.js install)

1. Download the archive for your OS from [GitHub Releases](https://github.com/Takayuki-Ishimaru/tokenlighten/releases): `tokenlighten-<version>-darwin-arm64.tgz`, `tokenlighten-<version>-darwin-x64.tgz`, `tokenlighten-<version>-linux-x64.tgz`, or `tokenlighten-<version>-win-x64.tgz` (Windows also ships a `.zip`). Each archive bundles the CLI, MCP server, and its own copy of Node.js — you do not install or configure Node.js yourself.
2. Verify the download against the `SHA256SUMS` file published alongside the archives, for example:

   ```bash
   shasum -a 256 -c SHA256SUMS
   ```
3. Extract the archive anywhere on disk.
4. Run the setup script with the path to the workspace you want TokenLighten enabled in:

   ```bash
   ./tl-setup /path/to/workspace
   ```

   ```
   tl-setup C:\path\to\workspace
   ```

   (macOS/Linux, then Windows). Pass more than one path to set up several workspaces in one run.

   On Windows, run `tl-setup` from a terminal as shown. If you double-click `tl-setup.cmd` in a folder that Explorer extracted from a downloaded archive, Windows first shows its standard "Open File - Security Warning" for a downloaded script from an unknown publisher; choosing **Run** opens the same plan and confirmation prompt, without a workspace. The bundled `node.exe` is signed by the OpenJS Foundation.

`tl-setup` runs `tl install` under the bundled runtime. It:

- detects the AI-agent hosts already on this machine (Claude Code, Codex, Gemini CLI, Copilot CLI) and prints the plan — what will be written, and where — then asks for one yes/no confirmation (a non-interactive shell needs `--yes`);
- stages the bundle and the bundled Node.js runtime under a per-machine install directory, and writes the stable launcher every host will spawn (`<home>/bin/node` plus `<home>/bin/tl.js`); this identity does not change between versions, so re-running to upgrade never needs host entries to be rewritten;
- registers each detected host, one vendor command or config file per host;
- sets up each given workspace the same way `tl workspace setup` does today: `.vscode/mcp.json` (for GitHub Copilot Chat), `.mcp.json` (Claude Code), `.codex/config.toml` (Codex), and the TokenLighten guide blocks in `AGENTS.md`/`CLAUDE.md`;
- verifies the result with `tl doctor` and a real MCP `initialize`/`tools/list` handshake before reporting success.

Generated entries default to write-enabled (`--allow-write`), matching today's `tl workspace setup`; pass `--read-only` to opt out.

Exit code `0` means installed and verified. `2` means installed and verified, but no host ended up registered; snippets were printed instead (see `tl clients snippet`) — passing `--clients none` exits `0` instead, since no registration was requested. `3` means installation finished but verification failed; the printed report names what to check. `1` means nothing was written (a bad workspace path, a declined confirmation, or a non-interactive shell without `--yes`).

Administrators deploying TokenLighten across a fleet, under AppLocker/WDAC, or through a proxy should read [Managed environments](managed-environments.md) before rolling this out.

### Upgrade

Download the newer archive, extract it, and run `tl-setup` again — with or without workspace arguments. Because the host identity does not change between versions, nothing needs to be re-registered by hand; every workspace recorded by a previous run is re-set-up automatically, so its guide block and generated MCP configuration move to the new version too.

### Roll back

Nothing puts `<home>/bin` on `PATH` (by design — see [Managed environments](managed-environments.md#the-identity-to-allowlist) for what `<home>` is on your platform), so the invocation is the absolute path to the launcher, never a bare `tl`:

```bash
"<home>/bin/tl" install --use <version>                                # macOS/Linux
"<home>\bin\node.exe" "<home>\bin\tl.js" install --use <version>       # Windows
```

This re-points the machine install at a version already staged on this machine — typically the one you just upgraded from. It does not download an older archive for you; to go back further, extract that older archive again and run its own `tl-setup`.

### Uninstall

```bash
"<home>/bin/tl" install --uninstall                                # macOS/Linux
"<home>\bin\node.exe" "<home>\bin\tl.js" install --uninstall       # Windows
```

Removes the machine install (staged runtime and app files) and TokenLighten-managed host registrations — any foreign host entry stays, and is reported. For every workspace this machine install recorded, it also removes TokenLighten's managed guide blocks and the managed `tokenlighten` entries from `.vscode/mcp.json`, `.mcp.json`, and `.codex/config.toml`, keeping a `.tl-backup` copy next to each edited MCP file; your own content, other servers' entries, and workspaces it never set up stay untouched. On Windows, a file still open in a running AI host cannot be removed immediately — the uninstaller retries in the background for about a minute after that host closes.

### Flags

| Flag | Effect |
|---|---|
| `--clients <list>\|auto\|none` | Which hosts to register (default `auto`: whatever this machine has). |
| `--read-only` | Generated entries omit `--allow-write`. |
| `--dry-run` | Print the plan and exit without writing anything. |
| `--json` | Emit a structured report instead of the human-readable summary. |
| `--yes` | Skip the interactive confirmation; required outside a terminal. |
| `--home <dir>` | Install under a directory other than the platform default — see [Managed environments](managed-environments.md) for when this is needed. |

`tl install --help` (or `tl help` once installed) lists the complete flag set, including `--tool-surface`, `--guide-profile`, `--prune`, `--use`, and `--force`.

## Install the VS Code extension without building

Users can download **[tokenlighten-vscode-extension-0.14.3.vsix](https://github.com/Takayuki-Ishimaru/tokenlighten/releases/download/v0.14.3/tokenlighten-vscode-extension-0.14.3.vsix)** from the v0.14.3 GitHub Release and install it with VS Code's **Extensions → Install from VSIX…** command. The same file works on Windows, macOS, and Linux. Node.js is not required for this packaged extension.

Open a trusted project folder, open the TokenLighten view, and choose **Set up this workspace**. This runs the same machine install described above (`tl install --from-extension --clients none`), using VS Code's own Node.js runtime instead of a bundled one: it stages the extension's bundled CLI as the machine install and sets up the current workspace, all in one operation — it does not register other hosts on the machine (Claude Code, Codex); do that separately with `tl clients activate`, or with an archive's `tl-setup`. Remove it with **TokenLighten: Uninstall TokenLighten from This Machine** from the command palette, or the absolute `tl install --uninstall` invocation described in [Uninstall](#uninstall) below.

## Build from source

Building the source requires Node.js 20 or later.

```bash
git clone https://github.com/Takayuki-Ishimaru/tokenlighten.git
cd tokenlighten
npm install
npm run build
```

To make the `tl` command available in your shell:

```bash
npm link --workspace packages/cli
tl version
tl doctor --json
```

`npm link` gives you a `tl` command for this checkout only; other hosts on the machine still look for a machine install. Run `tl install --dev` from the checkout to make it the machine install instead, with the same identity an archive install would produce.

## Set up a workspace

From the repository you want to use with an MCP-capable coding agent:

```bash
tl workspace setup
```

The setup flow configures supported clients for the workspace and manages TokenLighten's own instruction blocks. Content outside TokenLighten-managed blocks is preserved. (An archive install or the VS Code extension's **Set up this workspace** already runs this step as part of `tl install`; use `tl workspace setup` directly when you built from source, or to set up an additional workspace without touching the machine install.)

`tl workspace setup` configures workspace MCP access and maintains the TokenLighten guide blocks in AGENTS.md/CLAUDE.md. Keep these blocks so supported agents can follow the current tool instructions across sessions.

To register TokenLighten with Claude Code and/or Codex on this machine, so every repository you open — not only this one — picks it up automatically:

```bash
tl clients activate
tl clients status
```

`activate` registers only the hosts it finds installed on this machine; `status` reports current registration per client without changing anything. Machine registration (`tl clients ...`) and per-repository setup (`tl workspace setup`) are independent and can be used together. (An archive install already registers detected hosts as part of `tl install`, under its default `--clients auto`. The VS Code extension's **Set up this workspace** does not — it runs `tl install` with `--clients none`, so registering other hosts on the machine is a separate step: `tl clients activate` above, or an archive's `tl-setup`.)

To start the server directly instead, use:

```bash
tl mcp start --stdio --workspace /path/to/project
```

The server is read-only by default. Enable edits only when you intend to allow them:

```bash
tl mcp start --stdio --allow-write --workspace /path/to/project
```

## Refresh an existing workspace after upgrading

Re-run `tl workspace setup` or the extension's **Set up this workspace** to
refresh TokenLighten-managed instructions and client configuration, then
restart or reconnect your MCP client. This is needed to adopt v0.14.3's
updated Copilot setup; installing a new binary alone does not refresh the
workspace files.

For VS Code, setup raises the inline tool-result threshold to 65,536 bytes
unless it is already sufficient or writing results to disk is disabled.
It also enables fuller context responses for the VS Code server entry,
shortens the Copilot instruction file, and adds a read-only exploration
agent. Files with comments or trailing commas are preserved, and setup
prints the setting to change manually. To keep your existing setting:

```bash
tl workspace setup --copilot-inline-results keep
```

For a Copilot-only workspace, `--guide-profile compact` selects a shorter
shared guide. This also changes the guide read by Codex and Claude Code in
the same workspace; keep the full guide if they need the detailed
instructions.

## Choose a tool surface (optional)

By default the server advertises every capability (`full`), including Office documents and archives. For a workspace that is exclusively code, text, or configuration, advertise a smaller schema instead:

```bash
tl mcp start --stdio --tool-surface code --workspace /path/to/project
```

`tl workspace setup --tool-surface code` writes the same choice into generated client configuration. See [MCP tools](mcp-tools.md#tool-surface) for what each surface advertises and when to choose it.

With `--tool-surface code` and no explicit `--guide-profile`, `tl workspace setup` writes the **compact** guide instead of the full one — a code-only server has nothing to gain from the full guide's Office/archive/credential instructions, and the compact guide is the smaller default footprint. Pass `--guide-profile full` (or `medium`) explicitly to keep a larger guide under `--tool-surface code`; an explicit `--guide-profile` always wins over this default. See [Choose a guide profile](#choose-a-guide-profile-optional) below for the three guide profiles.

## Choose a guide profile (optional)

`tl workspace setup` writes one of three guide sizes into AGENTS.md/CLAUDE.md: `full` (the default for the `full` tool surface, with detailed instructions), `medium` (shorter instructions), or `compact` (essential routing rules, with capability details provided when needed). Choose explicitly with:

```bash
tl workspace setup --guide-profile compact
```

An explicit `--guide-profile` always wins over any default, including the `--tool-surface code` default described above.

## Verify the installation

```bash
tl doctor --json
tl mcp status
```

`tl doctor` also reports `install_consistency`: the machine install's version against the extension's bundled version and any `tl` found on `PATH`, whether the managed launcher resolves to a live runtime, and whether a workspace's generated entries still match the current machine identity.

Run `tl help` for the complete CLI reference. If you do not want TokenLighten active for a client, use that client's normal MCP configuration controls or `tl clients profile --profile native`.

## Next steps

- Learn the available operations in [MCP tools](mcp-tools.md).
- If you use VS Code, see [VS Code extension](vscode-extension.md).
- Deploying to a fleet or a policy-managed machine? See [Managed environments](managed-environments.md).
- Review the [Privacy, security, and support](privacy-security-support.md) notes before enabling write access.
- Read the [v0.14.3 release notes](github-release-v0.14.3.md) for the current changes, compatibility, and known limitations.
