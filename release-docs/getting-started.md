# Getting started

TokenLighten runs locally and provides an MCP server for coding agents.

## Install the VS Code extension without building

After v0.12.0 is published, users can download **[tokenlighten-vscode-extension-0.12.0.vsix](https://github.com/Takayuki-Ishimaru/tokenlighten/releases/download/v0.12.0/tokenlighten-vscode-extension-0.12.0.vsix)** from its GitHub Release and install it with VS Code's **Extensions → Install from VSIX…** command. The same file works on Windows, macOS, and Linux. Node.js is not required for this packaged extension.

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

This natural-autoload path — `tl workspace setup` plus the managed AGENTS.md/CLAUDE.md guide block it maintains — is the canonical way to run TokenLighten in production. Paired delivery-parity measurements found its cost within noise of manually injecting the same guide text into every prompt (cost ratio 1.038, 95% CI [0.858, 1.214] in `bench/workflows/runs/2026-08-26-natural-canonical-delivery-parity-v1`; 1.074, 95% CI [0.966, 1.126] in a same-scope follow-up — both intervals straddle parity).

Do not remove the TokenLighten-managed guide block once it is set up. A controlled isolation run found that dropping it costs far more than keeping it: the same agents cost 1.254x with no guide versus 1.059x with an equivalent guide delivered by hand (`bench/workflows/experiments/2026-08-25-guide-isolation/I-1-REPORT.md`). Losing the guide is the largest measured cost regression found to date — larger than any single server-side change tested so far.

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
- Read the [v0.12.0 release draft](github-release-v0.12.0.md) for the v0.11.1 feature comparison and adjudicated benchmark disclosure.
