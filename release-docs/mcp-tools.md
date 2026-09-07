# MCP tools

TokenLighten exposes exactly three MCP tools over stdio JSON-RPC:

| Tool | Purpose |
|---|---|
| `read_file` | First stop for code, documentation, configuration, logs, supported Office files, and archives. It can locate an unknown target, return focused content, or continue a task. |
| `search_files` | Find text or symbols, enumerate references, inspect diffs, and inventory a workspace with `.gitignore`-aware coverage. |
| `edit_file` | Apply bounded text or supported artifact edits after a read has established writable context. |

## Canonical request surface (v0.14)

v0.14 advertises a closed canonical schema, unchanged in shape from v0.13; v0.14.1 adds one field, `cursor`, to `read_file`. Use these top-level fields:

- `read_file`: `query`, `qref`, `targets`, `content`, `select`, `budget`, `task`, `lane`, `cwd`, `scope`, and `cursor` (continuation only: a returned `next` carries it, and it is not combined with `targets`, `content`, `query`, or `qref`).
- `search_files`: `action`, `queries`, `scope`, `budget`, `cursor`, `task`, `lane`, and `cwd`. The advertised actions are `find`, `references`, `diff`, and `tree`; symbol lookup uses `find` with `scope.kind:"symbol"`.
- `edit_file`: `edits`, `artifact`, `operation_id`, `task`, `lane`, `cwd`, and `credentials`.

For a new task whose files are not yet known, start with a complete natural-language `query` and `task:{epoch:"new"}`. For known files, use `targets` and request `content:"auto"`, `"outline"`, or `"full"`. Searches accept up to five literal `queries` in one call. Text edits use per-item paths or read handles inside one `edits[]` batch.

Legacy v0.12/v0.13 fields such as `mode`, `paths`, `handles`, bare `maxBytes`/`maxTokens`, and old task-field spellings are refused by default in v0.14 with a `legacy-input` refusal that names the canonical shape. They are never advertised. Setting `TL_LEGACY_INPUT=accept` on the server re-enables the dispatch-side normalizer as a migration bridge only; new clients must emit canonical arguments and execute the object-shaped `next` calls the server returns.

## Tool surface

The server advertises one of two tool surfaces, chosen once at startup:

- **`full`** (default) — every capability above, including Office documents (`.docx`/`.xlsx`/`.pptx`/`.pdf`), zip archive members, and password-protected artifacts via `credentialRef`/`credentials`.
- **`code`** — code, plain-text, and configuration `read_file`/`edit_file`/`search_files` only. Office, archive-member, and credential-ref inputs (`select`'s artifact fields, `budget.rows`/`cells`, `scope`/`targets[].archive`/`credentialRef`, and `edit_file`'s whole `artifact`/`credentials` blocks) are omitted from the advertised schema. A call naming one of those fields is refused as `unknown-arguments`, the same closed-schema mechanism an unrelated unrecognized field receives.

Choose `code` for a workspace that is exclusively source code, text, or configuration: a smaller schema reduces the tool-definition context sent to the client. Choose `full` (the default) whenever the workspace may contain Office documents, zip archives, or encrypted artifacts.

Set the surface with a CLI flag or an environment variable:

```bash
tl mcp start --stdio --tool-surface code --workspace /path/to/project
```

```bash
TOKENLIGHTEN_TOOL_SURFACE=code tl mcp start --stdio --workspace /path/to/project
```

`tl workspace setup --tool-surface code|full` writes the same choice into generated client configuration for VS Code, Codex, and Claude Code; the VS Code extension exposes it as the `tokenlighten.toolSurface` setting (see [VS Code extension](vscode-extension.md)). An unrecognized value fails the server process closed at startup rather than falling back silently.

The surface is fixed for the life of a server process — reconnecting is required to change it, which produces a new schema stamp and uses the same cache-invalidation path described below under "Client compatibility".

## Completion, continuation, and receipts

Task packs can return a decision to answer, edit, discover, await input, or stop. Proof-carrying completion records monotone obligations, served evidence, authoritative absence, and continuations already executed. An exhaustive request does not close while an obligation remains unproved or undisclosed.

Every response has a `kind`. Follow an executable `next` exactly when present. Since v0.14.1 a bounded read or search continues through an opaque `cursor` carried by its `next`: run that call as given, changing only `budget` or `task.force_serve` if needed, and never reconstruct a cursor or re-slice by hand. A `cursor-stale` refusal carries a restart `next`; a `cursor-invalid` refusal means the original call should be re-issued.

A `read.receipt` means the relevant content or decision is already current; it is not a request to repeat discovery. A receipt carries a `next` only when the request it answers still has undelivered content. `content:"full"` selects what to read and does not force a resend; `task.force_serve:true` is the explicit resend switch for a client that genuinely lost previously served context.

Replay-safe writes use `operation_id`. Reusing the same identifier returns the recorded result instead of applying the mutation twice. Since v0.13 the server stores compact replay v2 outcomes while keeping old retry keys fail-safe.

## Read and search

`read_file` can return source ranges, symbols, repository maps, task-oriented context packs, and selected document or archive content. `search_files` reports whether its scanned scope was complete; a complete zero-match result can serve as authoritative absence.

Budgets are structural objects. Read budgets can constrain bytes, tokens, items, rows, cells, and full-content expansion; search budgets constrain bytes, tokens, and items. When a response is bounded, use its supplied continuation instead of reconstructing a cursor.

Whole-file reads of small files are capped per task (six by default); past the cap the response downgrades to a structural skeleton with `remaining_ranges` and a `next` that zooms by range. In a multi-target batch give each target one `range`; `ranges` is accepted only on a single-target request.

## Editing

The server starts in read-only mode. `edit_file` requires `--allow-write`.

Edits are checked against previously served context and can be batched across independent concerns. The result distinguishes applied, rolled-back, and state-unknown outcomes. A successful create receipt proves the exact submitted content, and a successful bounded edit carries hashes and ranges for the resulting slice.

While a task pack has certified an edit, `edit_file` may change only files the server served during that task. An edit to any other file is refused as `execution-typestate`, and the refusal's `next` reads every refused file so the edit can be re-issued (an overflow beyond 64 paths is listed as `remaining`). A `create:true` item may ride the same batch as other edits; it is admitted when the call carries an explicit `cwd` (or a rooted handle) or the task pack named the new path. `target:"all"` replaces every exact occurrence of `search` in a path-based item or a range-less handle item and reports the count as `applied[].replaced`; it cannot be combined with `precondition:"unique-match"`. Without `target`, a search that matches several places is refused as `ambiguous`.

Treat `--allow-write` as permission to change the selected workspace. Enable it only for repositories and clients you trust.

## Client compatibility

The server validates and rescues JSON-stringified canonical object parameters from schema-blind clients only when the decoded value matches the advertised structure. Advertised arrays declare their item schemas. A wire budget below the 6144-byte admission floor is refused with a structured recovery rather than a generic error.

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

## Known limitations (0.14.1)

- A single multi-target read that mixes plain files with archive or artifact members is refused with a recovery path rather than routed per target; issue those reads as separate calls.
- In a rare wire-budget fallback path the server can still return a generic JSON-RPC error instead of a structured refusal; retry with a larger `budget` or a narrower target.
- `budget.allowFull:true` still re-sends full content that is already in the caller's context; only `content:"full"` gained receipt behavior in v0.14.1.
- When the built-in parser cannot resolve a declaration in a file, a decision that depends on that file closes only after the whole file has been served at its current hash; the returned `next` names the unserved range.
- When a quoted literal occurs twice in one large file, occurrence-level discovery may serve only one of the occurrences; read the other explicitly before an edit that must change both.
- The pathless task-pack locator's primary index covers files through 1 MiB. Exact identifier routing adds a wide scan for the 1–8 MiB band; larger files remain readable by explicit path and range.
- On very large repositories, the on-disk source-index cache is capped at 32 MiB. A larger index is rebuilt for each new server process, so the first call can take 10–25 seconds.
- In `edit.applied`, `core.counts` counts edited files, not individual edit items.
- `TL_INDEX_CONSISTENCY_SCAN`, `TL_PROOF_COMPLETION`, and `TL_LITERAL_FIRST_ROUTING` are enabled by default. Set `TL_LITERAL_FIRST_ROUTING=0` to restore the previous routing behavior.
