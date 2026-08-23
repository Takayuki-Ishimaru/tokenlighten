# MCP tools

TokenLighten exposes exactly three MCP tools over stdio JSON-RPC:

| Tool | Purpose |
|---|---|
| `read_file` | First stop for any code, doc, or config task, including unknown-location and multi-file discovery. Reads task-relevant file content, structure, and supported document artifacts. |
| `search_files` | Locate files, text, symbols, and references across the workspace, repo-wide and `.gitignore`-aware. |
| `edit_file` | Make bounded edits after a prior read has provided an edit handle. |

## Read and search

`read_file` is the first stop for a task, even when you do not yet know which file or files are involved: it can provide focused source ranges, symbols, repository maps, or a task-oriented pack of context for a request, in place of manually reading and grepping through candidate files. `search_files` supports file discovery, text search, supported-language symbols, and references.

The tools work with normal source files and supported text files. They can also inspect selected document and archive formats; see [Language support](language-support.md).

## v0.11.1 workflow additions

- Pass `task_handle` to continue a task across a server restart; invalid, expired, or wrong-purpose handles fail closed with recovery.
- Batch several identifiers with `search_files queries=[…]` and batch known skeleton reads with `read_file mode=skeleton paths=[…]`.
- Task packs can return explicit answer/edit decisions, create targets, served-range provenance, and compact receipts for unchanged replays.
- Successful edits can include verification kits; successful creates include terminal SHA/byte/line proof so clients do not need a read-back.
- MCP `initialize` announces first-stop instructions, and diagnostics expose the exact `server_build` without recording source content.

Experimental graph, retrieval, coverage-packer, reasoning, fast-path, and adaptive-wire cores remain disabled by default unless explicitly enabled.

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

## Known limitations (0.11.1)

- Source files larger than 1 MB are not included in the task-pack location index that `read_file mode=task_pack` uses to find relevant files by query; a pack that names such a file may resolve to a re-export file with the same name instead, or find nothing. The file is still readable directly by path/range, and `search_files find`/`references` still scan it (their own limit is 8 MiB). Workaround: pass the file explicitly in `paths`, or read it by path.
- On very large repositories, the on-disk source-index cache is capped at 32 MiB; once a repository's index would exceed that, it is not persisted, so every new server process rebuilds it from scratch — the first call of a session can take 10-25 seconds. Later calls in that same process stay fast.
- In an `edit_file` response, `core.counts` counts edited files, not edited items — a single batched edit touching 3 places in 1 file reports a count of 1, not 3.
- The `TL_INDEX_CONSISTENCY_SCAN` index-freshness check is on by default; set it to `0` to disable. Other experimental flags (see `packages/mcp-server/src/util/flags.ts`) remain off by default.
