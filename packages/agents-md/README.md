# @tokenlighten/agents-md

Writes and refreshes sentinel-delimited "managed blocks" inside `AGENTS.md`
and per-tool stub files (Claude, Copilot, Cursor, Cline, Continue — Windsurf
and Roo read `AGENTS.md` natively), with drift detection so hand-edited
content inside a managed block is never silently clobbered.

Four routes drive the same injector: the `tl-agents` bin (this package),
`tl agents update` / `tl agents-md write` (`@tokenlighten/cli`), the root
`npm run generate` script, and a VS Code command
(`tokenlighten.agentsMd.write`). See the public
[getting-started guide](../../release-docs/getting-started.md) for setup.

## Install

This package is part of the TokenLighten monorepo. Build it from source:

```bash
git clone https://github.com/Takayuki-Ishimaru/tokenlighten.git
cd tokenlighten
npm install
npm run build --workspace @tokenlighten/agents-md
```

## Quickstart

```bash
# Inject / refresh managed blocks for all 5 targets (diff-warn drift mode)
node dist/cli.js update

# Only a subset of targets, or a specific locale
node dist/cli.js update --targets claude,cursor
node dist/cli.js update --locale jp

# CI gate: exit 1 on drift instead of warning
node dist/cli.js check

# Force-overwrite even if manual edits are detected inside the block
node dist/cli.js update --force
```

The equivalent through the CLI wrapper: `tl agents update [--targets <id,...>]`,
or via the root package script: `npm run generate` (runs
`tl-agents update --force`).

## Tests

```bash
npm run test --workspace @tokenlighten/agents-md
```
