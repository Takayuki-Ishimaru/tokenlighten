# @tokenlighten/cli

The `tl` command-line entry point provides version and configuration utilities,
repository skeleton generation, the AGENTS.md guide injector, MCP server
lifecycle management, local usage summaries, and editor/agent setup.

Run `tl help` for the current command reference, or start with the public
[getting-started guide](../../release-docs/getting-started.md).

## Install

This package is part of the TokenLighten monorepo. Build it from source and
link it globally:

```bash
git clone https://github.com/Takayuki-Ishimaru/tokenlighten.git
cd tokenlighten
npm install
npm run build
npm link --workspace packages/cli
```

## Quickstart

```bash
tl version                 # print the CLI version
tl doctor --json            # health-check the local environment
tl workspace setup          # one-step AI rules + MCP setup for this repo
tl help                     # full command reference
```

Workspace setup enables writes in generated MCP settings by default.
Use `tl workspace setup --read-only` to disable them or `--allow-write`
to select them explicitly. These flags cannot be combined. Pass
`--read-only` again when refreshing a read-only configuration. A manually
started `tl mcp start` server requires `--allow-write` for edits.

## Tests

```bash
npm run test --workspace @tokenlighten/cli
```
