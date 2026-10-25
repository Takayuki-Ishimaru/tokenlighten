# MCP tools

TokenLighten exposes exactly three MCP tools over stdio JSON-RPC:

| Tool | Purpose |
|---|---|
| `tl_read_file` | First stop for code, documentation, configuration, logs, supported Office files, and archives. It can locate an unknown target, return focused content, or continue a task. |
| `tl_search_files` | Find text or symbols, enumerate references, inspect diffs, and inventory a workspace with `.gitignore`-aware coverage. |
| `tl_edit_file` | Apply bounded text or supported artifact edits after a read has established writable context. |

Since v0.15.0 the tool names have the `tl_` prefix to distinguish them from
built-in editor tools. Custom clients must refresh `tools/list` and use these
names; the old unprefixed names are refused with a replacement-name hint.
`TL_LEGACY_INPUT=accept` bridges argument fields only.

## Canonical request surface

v0.14 advertises a closed canonical schema, unchanged in shape from v0.13; v0.14.1 adds one field, `cursor`, to `tl_read_file`; v0.15.0 adds no request field. Use these top-level fields:

- `tl_read_file`: `query`, `qref`, `targets`, `content`, `select`, `budget`, `task`, `lane`, `cwd`, `scope`, and `cursor` (continuation only: a returned `next` carries it, and it is not combined with `targets`, `content`, `query`, or `qref`).
- `tl_search_files`: `action`, `queries`, `scope`, `budget`, `cursor`, `task`, `lane`, and `cwd`. The advertised actions are `find`, `references`, `diff`, and `tree`; symbol lookup uses `find` with `scope.kind:"symbol"`.
- `tl_edit_file`: `edits`, `artifact`, `operation_id`, `task`, `lane`, `cwd`, and `credentials`.

For a new file task, start with the entire user request, verbatim, as `query` and `task:{epoch:"new"}`. Preserve citation and constraint sentences; omit `targets` when paths are unknown. Reuse returned evidence without rereading it, and batch independent reads. For known files, use `targets` and request `content:"auto"`, `"outline"`, or `"full"`. Searches accept up to ten literal `queries` in one call by default. Text edits use per-item paths or read handles inside one `edits[]` batch.

Legacy v0.12/v0.13 fields such as `mode`, `paths`, `handles`, bare `maxBytes`/`maxTokens`, and old task-field spellings are refused by default in v0.14 with a `legacy-input` refusal that names the canonical shape. They are never advertised. Setting `TL_LEGACY_INPUT=accept` on the server re-enables the dispatch-side normalizer as a migration bridge only; new clients must emit canonical arguments and execute the object-shaped `next` calls the server returns.

## Tool surface

The server advertises one of two tool surfaces, chosen once at startup:

- **`full`** (default) — every capability above, including Office documents (`.docx`/`.xlsx`/`.pptx`/`.pdf`), zip archive members, and password-protected artifacts via `credentialRef`/`credentials`.
- **`code`** — code, plain-text, and configuration `tl_read_file`/`tl_edit_file`/`tl_search_files` only. Office, archive-member, and credential-ref inputs (`select`'s artifact fields, `budget.rows`/`cells`, `scope`/`targets[].archive`/`credentialRef`, and `tl_edit_file`'s whole `artifact`/`credentials` blocks) are omitted from the advertised schema. A call naming one of those fields is refused as `unknown-arguments`, the same closed-schema mechanism an unrelated unrecognized field receives.

Choose `code` for a workspace that is exclusively source code, text, documentation, configuration, or logs: a smaller schema reduces the tool-definition context sent to the client. Choose `full` (the default) whenever the workspace may contain Office documents, zip archives, or encrypted artifacts. Both surfaces advertise the same three tools; `code` omits only the Office/archive/credential fields listed above. The client fetches `tools/list` when establishing a connection.

Since v0.15.0 the schema every client receives is lean: `tools/list` no longer carries each tool's top-level `oneOf`/`anyOf` (the mutually exclusive request shapes) or the `task` dependency rule (`task.expected_state_version` only together with a `task.handle`). The server enforces both on every call and refuses a violation exactly as before, so only the size of the advertised definition changes; the VS Code setup keeps its own, leaner definition. Set `TL_LEAN_SCHEMA=0` on the server to advertise the complete pre-v0.15.0 schema.

Claude Code, GitHub Copilot CLI and Codex CLI receive compact portable tool descriptions by default. Claude Code and Codex CLI also receive line-numbered answer content; for Copilot CLI, an answer body that is an exact contiguous source slice is sent without line-number prefixes (its line range is given with it), and other answer bodies stay numbered. `TL_PORTABLE_TOOLS` and `TL_ANSWER_LINE_GUTTER` explicitly override these defaults. VS Code receives a smaller client-specific definition of commonly used fields.
Portable edit/search definitions omit the read-only `task.epoch`,
`task.force_serve` and `task.pull` controls. The server still accepts returned
recovery and continuation calls, with argument validation enforced by the
server. Execute each `next` unchanged.

Per-response metadata is kept to what the caller does not already know. The server build stamp (`server_build`) rides only the first `read.task_pack` of a session, never every response after it. `profile_binding` — the readback of which task shape (`answer`/`generic`/...) the server selected — is included only when it discloses something the caller's own request did not already state: an inferred, fallback, or evidence-derived selection, an explicit request the server overrode, or a profile carried over from an earlier call of the same task. A call that explicitly declares `task.profile` and gets exactly that profile back omits `profile_binding` entirely; the top-level `profile` field already states the whole fact.

A ready task pack may omit `verify` when it is exactly the same single
command already supplied in `plan.verification`. Distinct commands and
incomplete verification instructions are retained.

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

Task packs can return a decision to answer, edit, discover, await input, or stop. An `await_input` decision names what it is waiting on: `decision.unresolved[]` carries up to four entries, each with a `kind` and a non-empty `reason`, plus `id`/`path`/`handle`/`range` when the server can point at the thing (`handle` joins this response's `evidence[]`). The five `code` values are unchanged — the code says which branch stopped, `unresolved` says what it stopped on — and the field is omitted, never empty, when the server can name nothing. An `await_input` may also carry a `next`: today only for an explicit create request made under a declared read-only `task.profile:"answer"`, where the declared profile is kept and the `next` re-packs the same question under `task.profile:"generic"`. Run it, then act on the `act.edit` it returns. A task is ready only when every requested point is covered by returned content from the code that implements it or is explicitly disclosed. A compound question keeps each of its points (questions joined by `and`, `as well as`, `plus`, `; also`, line breaks, numbered or bulleted lists, and Japanese two-question prompts). A document that only mentions a topic is not evidence for it. A read-only question that asks for a value, a condition, the callers or a processing path (in English or Japanese) carries one `request-item:facet-<n>:<kind>` entry in `decision.certificate.obligations` per kind asked: the task pack serves the constants the code reads, one hop of callees and the call sites, and the decision stays `discover`, with a `tl_read_file` `next` naming the exact ranges, until that evidence has been sent. A value that exists only at run time, or a function that nothing calls, is disclosed as `explicit-gap:request-item-empty:<term> (<reason>)` instead of blocking the answer. A constant reached through an alias, a re-export or a rename (`import { A as B }`, `export { A as B } from`, a CommonJS destructuring rename, a Python `from m import A as B`, and their Kotlin, Scala, Rust and Go counterparts) is followed to its declaration, and a chain that cannot be followed is disclosed as undetermined rather than answered without the value. Every requirement of a ready `act.answer` is backed by a body in that response or by a range already served in the task; when a size limit or a later step removes the evidence a requirement needs, the pack answers `discover` with a ranged `next`, or discloses the point, instead of keeping the claim. `inventory_complete` reports how much of the workspace a scan covered, never whether an answer is complete: readiness is `decision.kind` together with `certificate.obligations`, and every `explicit-gap:` entry is part of the answer. A point whose status cannot be determined is never reported absent: it keeps the task open (`next`, or `await_input` naming it in `unresolved[]`) or, when it does not block the answer, is named in `decision.certificate.gaps` as `explicit-gap:request-item-undetermined:<term> (<reason>)`; on an intermediate `discover` the same disclosure appears in `decision.gaps` with the code `request-item-undetermined` and carries no call. Continuing the same task retains its requirements and completed steps. A certified `act.answer`/`act.edit` decision can still disclose a verified absence: `decision.certificate.gaps` names a request point with no occurrence in the scanned workspace files, and each entry says whether the scan was complete or how many paths were excluded from it (the same scope the `tl_search_files` absence reports). This is distinct from `decision.gaps`, which appears only while the pack is still discovering. A Japanese term is matched through the same normalisation as English words (identifier splitting, inflection, and the Japanese-to-English glossary); a katakana loanword with a known English spelling that appears nowhere can be disclosed as absent, while a term that can only be matched through a translated glossary word, or a katakana loanword with no known English spelling, is disclosed as undetermined. Only the subject of a request point can be reported absent: an identifier, a quoted string, a term the request asks to check for, or the head noun of a clause that names no identifier. The words that name the kind of information asked (conditions, callers, values, defaults, flow), predicates and modifiers, and the plain words of a clause that already names an identifier are never reported absent, and a second topic joined by `and` or 「と」 is kept as its own point.

Every response has a `kind`. Follow an executable `next` exactly when present. Since v0.14.1 a bounded read or search continues through an opaque `cursor` carried by its `next`: run that call as given, changing only `budget` or `task.force_serve` if needed, and never reconstruct a cursor or re-slice by hand. For a `cursor-stale` refusal, follow its restart `next` when supplied; otherwise re-issue the original request. A `cursor-invalid` refusal also requires the original call to be re-issued. A `tl_read_file` call carrying only `task:{handle:...}` resumes that bound task directly. A bare `tl_read_file {qref}` re-pack now also recovers that same task's own handle automatically — including its required scope and its record of already-executed continuations — so it keeps the task whether or not `task.handle` is resent; an explicit `task.handle` still wins when both are given, and `task.epoch:"new"` always starts a fresh one. A re-pack of a finished read-only task counts the evidence the task already received, including windows read directly by handle, and restates its answer while the files are unchanged. If a file changes while a continuation the server wrote for a ranged read is being followed, the next call is refused as `cursor-stale`; its `next` re-reads that file's already-served and still-owed lines under the new version. An independent read of a changed file is served fresh, with a one-line `note` naming earlier ranges of that file that are now out of date. Changes made through `tl_edit_file` in the same session, a new `task.epoch` and another `lane` are not affected.

Since v0.16.0, a long task-pack continuation with explicit source ranges can use a short `cursor` reference to the query and ranges stored in the local server. Follow the returned `next` unchanged; do not add the saved query or targets. These references last at most one hour, subject to the parent task's expiry. When replayed, followed after other calls or a server restart, or used with a resend or changed budget, the reference recovers the saved ranges as an ordinary bounded read. It does not issue a new task-readiness decision; resume with `tl_read_file {task:{handle:...}}` if that decision is needed. Source changes require restarting the original request. If a reference cannot safely be stored, the server keeps the expanded continuation call.

A `read.receipt` means the relevant content or decision is already current; it is not a request to repeat discovery. A receipt carries a `next` only when the request it answers still has undelivered content. A full read is deduplicated by its requested projection: an identical repeat under the same `select:{comments:"keep"|"elide"}` choice returns a receipt, and a different projection serves the body again. `content:"full"` requests an unelided view of the selected content and does not force a resend, and neither does `budget.allowFull:true` — it only raises the full-read size cap. `task.force_serve:true` is the explicit resend switch for a client that genuinely lost previously served context. Every `evidence[]` `body` is verbatim source of that item's own `path` and `range` — never an outline, a pointer to an earlier response, or lines from elsewhere in the file. `prior` stands for content that was actually sent earlier in the session, and `remaining` names the windows of that item that were not sent.

Replay-safe writes use `operation_id`. Reusing the same identifier returns the recorded result instead of applying the mutation twice. Since v0.13 the server stores compact replay v2 outcomes while keeping old retry keys fail-safe. Since v0.15.1, a replay includes the original `applied[].after` window and `current` (`unchanged` or `changed`). If files changed after the edit, a returned `next` reads their current contents; the saved window still describes the original edit. Outcomes recorded before v0.15.1 retain their earlier format.

## Read and search

`tl_read_file` can return source ranges, symbols, repository maps, task-oriented context packs, and selected document or archive content. `tl_search_files` reports whether its scanned scope was complete; a complete zero-match result can serve as authoritative absence.

Budgets are structural objects. Read budgets can constrain bytes, tokens, items, rows, cells, and full-content expansion; search budgets constrain bytes, tokens, and items. `budget.bytes` and `budget.tokens` cap one response (the MCP text result). A server-written `next` that continues the same request carries the caller's budget as `budget.bytes`; the caller may change it on any hop. When a response is bounded, use its supplied continuation instead of reconstructing a cursor: following the returned `next` calls to the end delivers exactly the requested lines of every target. A budget too small for the response to name everything still owed is refused as `budget-below-minimum`; its `required_min_bytes` works on the first retry and its `next` re-issues the request at that size. The refusal itself can be larger than a very small budget. With a declared budget (or a host ceiling), a range or file that fits is returned whole, and otherwise each page carries as many whole lines as fit, filling the budget rather than stopping well short of it. `find` result pages are sized to the effective response ceiling — the caller's `budget`, else the host ceiling, else 16 KB — and list up to 64 matching line numbers per file; a file with more hits is paged, never silently cut. `TL_FIND_WIDE_PAGE=0` restores the earlier, narrower page.

Whole-file reads of small files are capped per task (six by default); past the cap the response downgrades to a structural skeleton with `remaining_ranges` and a `next` that zooms by range. A multi-target batch accepts each target's `range` or `ranges[]`; each selected range is read as its own window.

Discovery continuations can group separate ranges under one target. Smaller
required windows may fit while an earlier large window remains queued; the
returned source does not fill the gaps between disjoint ranges. Follow the
complete `next` call to obtain any remaining evidence.

`range`, `ranges` and `symbol` select what to read; `content:"full"` only asks for that selection unelided (doc comments kept), across every continuation, and never widens it to the whole file. Without a selection, `content:"full"` reads the whole file.

## Local analysis engines

Optional typed symbol resolution and local multilingual semantic search
supplement the existing tools. Both are off by default. Compound request
composition is on by default. See [Local analysis engines](local-analysis.md)
for user-scoped configuration, model download and language-server setup.

## Editing

A manually started server is read-only unless passed `--allow-write`;
`tl_edit_file` requires that permission. Workspace setup enables writes in
generated settings by default; use `tl workspace setup --read-only` to
generate read-only settings.

Edits are checked against previously served context and can be batched across independent concerns. The result distinguishes applied, rolled-back, and state-unknown outcomes. A successful create receipt proves the exact submitted content, and a successful bounded edit carries hashes and ranges for the resulting slice.

A successful edit can carry, for each edited file, the post-edit window `applied[].after`: the verbatim text now on disk for the changed lines plus three lines of context on each side (at most 6 KiB per hunk and 16 KiB per response; `TL_EFF_SLIM_EDIT=0` widens it to about 20 lines, extended to the enclosing symbol when it fits), as `range` and `body`, with `remaining` naming any post-edit span that was not shown. Those lines count as served in the session: a later read of them returns a `read.receipt` that names the edit instead of resending them, and a later edit may use them. Under a host or caller byte ceiling the windows are shortened from their tail first, so they never push the response past the ceiling and a hunk can fall outside its window; `remaining` names every unshown span. `edit.rolled_back` and `edit.state_unknown` never carry `after`.

While a task pack has certified an edit, `tl_edit_file` may change only files the server served during that task. An edit to any other file is refused as `execution-typestate`, and the refusal's `next` reads every refused file so the edit can be re-issued (an overflow beyond 64 paths is listed as `remaining`). A `create:true` item may ride the same batch as other edits; it is admitted when the call carries an explicit `cwd` (or a rooted handle) or the task pack named the new path. `target:"all"` replaces every exact occurrence of `search` in a path-based item or a range-less handle item and reports the count as `applied[].replaced`; it cannot be combined with `precondition:"unique-match"`. Without `target`, a search that matches several places is refused as `ambiguous`.

A verification kit states whether the project's tests can run here. A Node.js project counts as runnable when `node_modules` is present in its directory or in a parent directory inside the workspace, or when it declares no dependencies and its test script uses only built-in commands (for example `node --test`); a project that declares dependencies without installing them is reported as not runnable. When a verification kit includes entries with an `omitted` body label and a batched `next_call`, read them before compiling or testing. CLI-host replies can omit replacement text already supplied by the caller and kit entries already served; when a build/test command is returned, follow that command. `TL_EFF_SLIM_EDIT=0` restores inline bodies.

For Go files in one detected module, task packs and edit verification kits
use `go test ./...` from the same module directory. The kit carries that
directory as `toolchain.test_entry_dir`. When a single module cannot be
established, TL does not invent a workspace-wide Go command; preserve any
disclosed verification gap.

Treat `--allow-write` as permission to change the selected workspace. Enable it only for repositories and clients you trust.

## Client compatibility

The server validates and rescues JSON-stringified canonical object parameters from schema-blind clients only when the decoded value matches the advertised structure. Advertised arrays declare their item schemas and are typed as arrays explicitly, so a bare string in an array-shaped field is rejected by validation rather than reaching the server. `tl_read_file`'s addressing branches — `query`, `targets`, `qref`, `cursor`, and task-only control fields — are mutually exclusive: the server enforces this on every call, and with `TL_LEAN_SCHEMA=0` (the pre-v0.15.0 schema) a valid call matches exactly one advertised branch. A wire budget below the 6144-byte admission floor is refused with a structured recovery rather than a generic error.

Since v0.15.0 a few near-miss requests are served instead of refused, each with a `normalized` note naming the rewrite: a one-element `ranges` on a target of a multi-target `tl_read_file` (read as that target's `range`), a package-qualified `references` name such as `pkg.Func` (resolved to the member), a `tl_read_file` of a directory (served as `tl_search_files` `tree` of that directory), and `task.taskProfile` (read as `task.profile`); `tl_edit_file` also accepts its own `task.profile`. `TL_EFF_TOLERANT_INPUT=0` restores the refusals. A `find` with more than ten `queries` is refused by default; `TL_EFF_WIDE_FIND=0` restores the five-query cap.

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

## v0.16.0 updates

Follow-up reads return requested unserved ranges under the same task handle.
Mixed handle/path batches and per-target `ranges[]` are accepted. Receipts
acknowledge source actually delivered, including its comment projection.
Brief questions about large types can return a structure map; compatible
discovery continuations can be followed within one bounded response.

Named members, multiple requirements and protected-file constraints are
retained more reliably. Edit packs include relevant declarations and
artifact-consuming code. Search accepts ten literal queries by default,
and changed-scope cursors receive executable restart calls.

CLI workspace refresh preserves existing per-client write permissions;
explicit `--read-only` or `--allow-write` overrides them.

## v0.15.3 updates

- Questions combining a call's return value and computation order retain
  both requirements and request the helper implementations needed to answer.
  Japanese explanations of functions named like English edit verbs remain
  read-only questions; explicit edit requests still take precedence.
- Symbol bodies retain their original source line coordinates. Supplementary
  scope headers and signatures appear in `note`, outside the source body.
  Budgeted symbol and multi-target reads continue through the remaining
  requested lines. Follow the returned `next` unchanged.
- A budgeted text-search page may suggest a larger `budget.bytes` for
  fetching the remaining results. This is an estimate, and it does not
  change the current budget or the executable continuation.
- Line-range replacement retains the boundary before an untouched following
  line even when replacement text omits its final newline. Existing LF,
  CRLF and CR line endings are preserved.

## v0.15.2 updates

Workspace setup defaults to the compact guide for both tool surfaces. Claude
Code loads TokenLighten upfront; Codex workspace settings wait for the initial
optional-server catalog. Explicit workspace startup values are preserved.
See [Client startup settings](getting-started.md#client-startup-settings) for
scope, timeouts and overrides.

Evidence retains source line fidelity when comments are omitted. An
identical read respects its comment projection, while a changed projection
serves the requested view. Japanese explanation and return-value questions
keep their subjects without treating request wording as missing source.

Workspace and archive-member `tree` results use budgeted continuations;
execute the returned `next` unchanged. Canonical argument validation occurs
before edits or task-state updates. Numeric column and section selectors
remain accepted.

## v0.15.1 evidence selection

For an answer that explains behaviour or computes a value, complete returned
functions relevant to the question also bring their referenced constants,
including imports, aliases and re-exports. Unserved evidence keeps a
continuation open, and unresolved declarations are disclosed. Questions that
only locate code or ask about relationships do not gather these extra values.
An explicitly named function such as “the retry function” or “retry 関数”
selects that identifier. Caller requests retain each named subject and include
same-file call sites. Explanation wording such as “edge cases” and 「金額」
is not treated as a missing source term, and function-argument commas do not
split a request into separate points.

Task-pack discovery does not read imports or symlinks that resolve outside
the workspace; values depending on them are disclosed as unresolved.

## Known limitations

- A question with multiple subjects can require a continuation. Values used only by code that was not returned may require an explicit question naming that code or value.
- A single multi-target read that mixes plain files with archive or artifact members is refused with a recovery path rather than routed per target; issue those reads as separate calls.
- In a rare wire-budget fallback path the server can still return a generic JSON-RPC error instead of a structured refusal; retry with a larger `budget` or a narrower target.
- When the built-in parser cannot resolve a declaration in a file, a decision that depends on that file closes only after the whole file has been served at its current hash; the returned `next` names the unserved range.
- When a quoted literal occurs twice in one large file, occurrence-level discovery may serve only one of the occurrences; read the other explicitly before an edit that must change both.
- The pathless task-pack locator's primary index covers files through 1 MiB. Exact identifier routing adds a wide scan for the 1–8 MiB band; larger files remain readable by explicit path and range.
- On very large repositories, the on-disk source-index cache is capped at 32 MiB. A larger index is rebuilt for each new server process, so the first call may take longer.
- In `edit.applied`, `core.counts` counts edited files, not individual edit items.
- Under a host byte ceiling the `applied[].after` window is cut from its tail, so an edited line can fall outside it (`remaining` names it), and a hunk that only deletes lines is not named.
- A `content:"auto"` read of a whole file of 300 or more lines at a 6,144-byte budget is refused as `cap-exceeded` without a `next`; use `content:"full"`. A continuation the server builds without a caller budget can exceed VS Code's response limit.
- The `scope` parameter is advertised without `"type":"object"`; a JSON-string `scope` is accepted.
- `TL_INDEX_CONSISTENCY_SCAN`, `TL_PROOF_COMPLETION`, and `TL_LITERAL_FIRST_ROUTING` are enabled by default. Set `TL_LITERAL_FIRST_ROUTING=0` to restore the previous routing behavior.
- The record of an executed search's own results is kept in memory only; it does not survive a server restart, and a task resumed after one falls back to proposing the search again.
- A search naming more than one term in `queries[]` does not attribute individual matches to a specific term, so a file it locates is not folded back into a task the way a single-term search's hit is; a caveat-free, all-absent multi-term result is still recorded as verified absence.
- The edit gate grants write access to any file whose bytes were served in the current lane and epoch, even when the task-pack decision listed that file as read-only or left it out of the edit frontier. Such an edit applies and is marked (`reclassification.trigger:"outside-certified-frontier"` with `frontier_status`); set `TL_FRONTIER_STRICT_WRITES=1` to have it refused with `frontier-read-only` and an executable re-pack `next` instead.
