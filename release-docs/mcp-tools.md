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

## v0.12.0 workflow additions

- Same-epoch continuation preserves the complete query and monotone task requirements; stale or unrelated decisions are demoted with executable recovery.
- Japanese prose participates in ranking through shared Han/kana spans and bigrams.
- Guarded known-location value changes can return a compact ready edit pack.
- `maxBytes`/`maxTokens` bound task packs and batch reads; VS Code clients use a conservative 14,336-byte task-pack default.
- Edit retries report `replayed:true`, oversized query batches return `remaining_queries`, and whole-file handle batches disclose synthesized ranges.
- UTF-16 search avoids false absence certificates; unsupported-encoding edits fail closed.
- Large Markdown skeletons return heading outlines and exact identifier routing covers 1–8 MiB.
- Compact edit proofs, optional delta-context rereads, clearer doctor/log summaries, and English/Japanese compact guides reduce overhead.

Experimental graph, retrieval, coverage-packer, reasoning, fast-path, delta-context, and adaptive-wire cores remain disabled by default unless explicitly enabled.

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

## Known limitations (0.12.0)

- The pathless task-pack locator's primary index covers files through 1 MiB. Exact identifier routing adds a wide scan for the 1–8 MiB band; larger files remain readable by explicit path/range.
- On very large repositories, the on-disk source-index cache is capped at 32 MiB; once a repository's index would exceed that, it is not persisted, so every new server process rebuilds it from scratch — the first call of a session can take 10-25 seconds. Later calls in that same process stay fast.
- In an `edit_file` response, `core.counts` counts edited files, not edited items — a single batched edit touching 3 places in 1 file reports a count of 1, not 3.
- The `TL_INDEX_CONSISTENCY_SCAN` index-freshness check is on by default; set it to `0` to disable. Other experimental flags (see `packages/mcp-server/src/util/flags.ts`) remain off by default.
