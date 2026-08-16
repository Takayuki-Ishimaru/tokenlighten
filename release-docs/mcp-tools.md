# MCP tools

TokenLighten exposes exactly three MCP tools over stdio JSON-RPC:

| Tool | Purpose |
|---|---|
| `read_file` | Read task-relevant file content, structure, and supported document artifacts. |
| `search_files` | Find files, text, symbols, and references in a workspace. |
| `edit_file` | Make bounded edits after a prior read has provided an edit handle. |

## Read and search

`read_file` can provide focused source ranges, symbols, repository maps, or a task-oriented pack of context for a request. `search_files` supports file discovery, text search, supported-language symbols, and references.

The tools work with normal source files and supported text files. They can also inspect selected document and archive formats; see [Language support](language-support.md).

## Editing

The server starts in read-only mode. `edit_file` mutations require the server to be started with `--allow-write`.

Edits are designed to be bounded: the server normally issues a handle from a preceding read, and the edit is checked against that context. Responses can also include verification material so an MCP client can run relevant checks without reopening unrelated files.

Treat `--allow-write` as permission to change the selected workspace. Enable it only for repositories and clients you trust, and review client configuration before use.

## Client compatibility

Use TokenLighten with an MCP-capable coding client. The CLI can set up supported workspace integrations:

```bash
tl workspace setup
```

Or start the server yourself:

```bash
tl mcp start --stdio --workspace /path/to/project
```

For command details, run `tl help`. For setup and operational notes, see [Getting started](getting-started.md).
