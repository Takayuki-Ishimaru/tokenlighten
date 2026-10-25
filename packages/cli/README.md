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

First workspace setup enables writes by default. Refresh preserves each
existing client's write permission. Use `--read-only` or `--allow-write`
to change it explicitly; these flags cannot be combined. A manually
started `tl mcp start` server requires `--allow-write` for edits.

## Local analysis engines

Use `tl engines status`, `tl engines --help`, `tl models list` and
`tl models licenses` to inspect configurable engines and model status.
`tl models install` downloads the model and enables local semantic search.
See [Local analysis engines](../../release-docs/local-analysis.md) for
defaults, language-server configuration and limitations.

## Tests

```bash
npm run test --workspace @tokenlighten/cli
```
