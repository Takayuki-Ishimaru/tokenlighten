# Getting started

TokenLighten runs locally and provides an MCP server for coding agents.

## Install the VS Code extension without building

Users can download **[tokenlighten-vscode-extension-0.14.1.vsix](https://github.com/Takayuki-Ishimaru/tokenlighten/releases/download/v0.14.1/tokenlighten-vscode-extension-0.14.1.vsix)** from the v0.14.1 GitHub Release and install it with VS Code's **Extensions → Install from VSIX…** command. The same file works on Windows, macOS, and Linux. Node.js is not required for this packaged extension.

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

## Set up a workspace

From the repository you want to use with an MCP-capable coding agent:

```bash
tl workspace setup
```

The setup flow configures supported clients for the workspace and manages TokenLighten's own instruction blocks. Content outside TokenLighten-managed blocks is preserved.

`tl workspace setup` configures workspace MCP access and maintains the TokenLighten guide blocks in AGENTS.md/CLAUDE.md. Keep these blocks so supported agents can follow the current tool instructions across sessions.

To register TokenLighten with Claude Code and/or Codex on this machine, so every repository you open — not only this one — picks it up automatically:

```bash
tl clients activate
tl clients status
```

`activate` registers only the hosts it finds installed on this machine; `status` reports current registration per client without changing anything. Machine registration (`tl clients ...`) and per-repository setup (`tl workspace setup`) are independent and can be used together.

To start the server directly instead, use:

```bash
tl mcp start --stdio --workspace /path/to/project
```

The server is read-only by default. Enable edits only when you intend to allow them:

```bash
tl mcp start --stdio --allow-write --workspace /path/to/project
```

## Choose a tool surface (optional)

By default the server advertises every capability (`full`), including Office documents and archives. For a workspace that is exclusively code, text, or configuration, advertise a smaller schema instead:

```bash
tl mcp start --stdio --tool-surface code --workspace /path/to/project
```

`tl workspace setup --tool-surface code` writes the same choice into generated client configuration. See [MCP tools](mcp-tools.md#tool-surface) for what each surface advertises and when to choose it.

## Verify the installation

```bash
tl doctor --json
tl mcp status
```

Run `tl help` for the complete CLI reference. If you do not want TokenLighten active for a client, use that client's normal MCP configuration controls or `tl clients profile --profile native`.

## Next steps

- Learn the available operations in [MCP tools](mcp-tools.md).
- If you use VS Code, see [VS Code extension](vscode-extension.md).
- Review the [Privacy, security, and support](privacy-security-support.md) notes before enabling write access.
- Read the [v0.14.1 release notes](github-release-v0.14.1.md) for the current changes, compatibility, and known limitations.
