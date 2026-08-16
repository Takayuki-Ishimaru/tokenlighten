# @tokenlighten/mcp-server

Stdio MCP server exposing exactly 3 advertised tools — `read_file`,
`edit_file`, `search_files` — that return the exact slices, edit handles, and
verification kits a coding-agent task needs, instead of forcing an agent to
Read/Grep/cat its way through a repo one file at a time.

For the public behavior and safety overview, see the
[MCP tools guide](../../release-docs/mcp-tools.md) and
[language and file support](../../release-docs/language-support.md).

## Install

This package is part of the TokenLighten monorepo. Build it from source:

```bash
git clone https://github.com/Takayuki-Ishimaru/tokenlighten.git
cd tokenlighten
npm install
npm run build --workspace @tokenlighten/mcp-server
```

## Quickstart

```bash
# Read-only (default)
node dist/bin.js /path/to/project

# Enable the write tools (edit_file mutations, artifact rewrites)
node dist/bin.js /path/to/project --allow-write
```

Point any MCP-capable client (Claude Code, another MCP host) at that stdio
process. The bundled bin is also installed as `tl-mcp` when this package is on
`PATH`, and `tl mcp start [--stdio] [--allow-write] [--workspace DIR]` in
`@tokenlighten/cli` wraps the same binary with process lifecycle management
(`tl mcp stop` / `tl mcp status`).

## Tests

```bash
npm run test --workspace @tokenlighten/mcp-server
```
