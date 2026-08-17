# Getting started

TokenLighten runs locally and provides an MCP server for coding agents.

## Install the VS Code extension without building

Most users can download **[tokenlighten-vscode-extension-0.9.2.vsix](https://github.com/Takayuki-Ishimaru/tokenlighten/releases/download/v0.9.1a/tokenlighten-vscode-extension-0.9.2.vsix)** from the v0.9.1a Public Beta release and install it with VS Code's **Extensions → Install from VSIX…** command. The same file works on Windows, macOS, and Linux. Node.js is not required for this packaged extension.

## Build from source

Building the source requires Node.js 20 or later.

```bash
git clone https://github.com/Takayuki-Ishimaru/tokenlighten.git
cd tokenlighten
npm ci
npm run build
```

Use `npm ci` for a reproducible build from the committed lockfile. Use `npm install` only when intentionally changing dependencies and updating `package-lock.json`.

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

To start the server directly instead, use:

```bash
tl mcp start --stdio --workspace /path/to/project
```

The server is read-only by default. Enable edits only when you intend to allow them:

```bash
tl mcp start --stdio --allow-write --workspace /path/to/project
```

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
