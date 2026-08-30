# MCP tools

TokenLighten exposes exactly three MCP tools over stdio JSON-RPC:

| Tool | Purpose |
|---|---|
| `read_file` | First stop for code, documentation, configuration, logs, supported Office files, and archives. It can locate an unknown target, return focused content, or continue a task. |
| `search_files` | Find text or symbols, enumerate references, inspect diffs, and inventory a workspace with `.gitignore`-aware coverage. |
| `edit_file` | Apply bounded text or supported artifact edits after a read has established writable context. |

## Canonical v0.13 request surface

v0.13 advertises a closed canonical schema. Use these top-level fields:

- `read_file`: `query`, `qref`, `targets`, `content`, `select`, `budget`, `task`, `lane`, `cwd`, and `scope`.
- `search_files`: `action`, `queries`, `scope`, `budget`, `cursor`, `task`, `lane`, and `cwd`. The advertised actions are `find`, `references`, `diff`, and `tree`; symbol lookup uses `find` with `scope.kind:"symbol"`.
- `edit_file`: `edits`, `artifact`, `operation_id`, `task`, `lane`, `cwd`, and `credentials`.

For a new task whose files are not yet known, start with a complete natural-language `query` and `task:{epoch:"new"}`. For known files, use `targets` and request `content:"auto"`, `"outline"`, or `"full"`. Searches accept up to five literal `queries` in one call. Text edits use per-item paths or read handles inside one `edits[]` batch.

Legacy v0.12 fields such as `mode`, `paths`, `handles`, bare `maxBytes`/`maxTokens`, and old task-field spellings remain dispatch-compatible during v0.13.x. They are not advertised, should not be emitted by new clients, and are scheduled for removal in v0.14.

## Completion, continuation, and receipts

Task packs can return a decision to answer, edit, discover, await input, or stop. Proof-carrying completion records monotone obligations, served evidence, authoritative absence, and continuations already executed. An exhaustive request does not close while an obligation remains unproved or undisclosed.

Every response has a `kind`. Follow an executable `next` exactly when present. A `read.receipt` means the relevant content or decision is already current; it is not a request to repeat discovery. `task.force_serve:true` is available when a client genuinely lost previously served context.

Replay-safe writes use `operation_id`. Reusing the same identifier returns the recorded result instead of applying the mutation twice. v0.13 stores compact replay v2 outcomes while keeping old retry keys fail-safe.

## Read and search

`read_file` can return source ranges, symbols, repository maps, task-oriented context packs, and selected document or archive content. `search_files` reports whether its scanned scope was complete; a complete zero-match result can serve as authoritative absence.

Budgets are structural objects. Read budgets can constrain bytes, tokens, items, rows, cells, and full-content expansion; search budgets constrain bytes, tokens, and items. When a response is bounded, use its supplied continuation instead of reconstructing a cursor.

## Editing

The server starts in read-only mode. `edit_file` requires `--allow-write`.

Edits are checked against previously served context and can be batched across independent concerns. The result distinguishes applied, rolled-back, and state-unknown outcomes. A successful create receipt proves the exact submitted content, and a successful bounded edit carries hashes and ranges for the resulting slice.

Treat `--allow-write` as permission to change the selected workspace. Enable it only for repositories and clients you trust.

## Client compatibility

v0.13 validates and rescues JSON-stringified canonical object parameters from schema-blind clients only when the decoded value matches the advertised structure. Advertised arrays declare their item schemas.

The VS Code extension derives a stable schema stamp from the advertised tools. When the stamp changes, the provider version and change event force VS Code to refresh cached MCP definitions. Workspace setup also records the stamp in generated client configuration.

Set up supported clients with:

```bash
tl workspace setup
```

Or start the server directly:

```bash
tl mcp start --stdio --workspace /path/to/project
```

For command details, run `tl help`. See [Getting started](getting-started.md) for setup and operational notes.

## Known limitations (0.13.1)

- The pathless task-pack locator's primary index covers files through 1 MiB. Exact identifier routing adds a wide scan for the 1–8 MiB band; larger files remain readable by explicit path and range.
- On very large repositories, the on-disk source-index cache is capped at 32 MiB. A larger index is rebuilt for each new server process, so the first call can take 10–25 seconds.
- In `edit.applied`, `core.counts` counts edited files, not individual edit items.
- `TL_INDEX_CONSISTENCY_SCAN` and `TL_PROOF_COMPLETION` are enabled by default as correctness safeguards. Other experimental flags, including `TL_SCHEMA_DEFS`, remain off by default.
