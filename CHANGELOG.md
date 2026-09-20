# Changelog

User-facing release highlights for TokenLighten.

## 0.14.3

- Install from a platform archive with `tl-setup <workspace>`: no editor
  extension and no separate Node.js install. Each archive bundles its own
  Node.js runtime, registers every detected AI-agent host (Claude Code, Codex,
  Gemini CLI, Copilot CLI, and GitHub Copilot Chat in VS Code), and sets up
  the workspace. Re-running upgrades in place; `--use` rolls back;
  `--uninstall` removes the machine install and what it wrote.
- The VS Code extension's **Set up this workspace** performs the same machine
  install, no longer adds a second server definition on top of the workspace
  file, and gains an uninstall command.
- `tl doctor` reports machine-install consistency; `tl clients snippet` prints
  a pasteable entry for hosts that cannot be written directly.
- Task continuation no longer repeats an executed search, loses a pending
  file creation, or resends an already returned body; requests naming
  several files or edits are read more precisely in English and Japanese.
- A read-only question that asks several things at once now finds evidence
  for each point in its first response more often, and a Japanese question
  against an English codebase is retried with English search terms derived
  from it (katakana loanwords matched by sound, common software vocabulary
  translated, only words the workspace itself uses). Both are on by default;
  `TL_CONCERN_RECOVERY=0` and `TL_JA_QUERY_BRIDGE=0` turn them off. The same
  applies when the call also names files (the form GitHub Copilot sends), a
  type the request names is served from the file that carries its name, and
  a named file is opened at the member the request describes rather than at
  its constructor.
- A read-only task stays read-only when a continuation omits
  `task.profile`, so the task keeps one handle; and a task handle the model
  garbled (two handles merged, or trailing characters repeated) continues
  the caller's own live task on `read_file` and `search_files` instead of
  ending it. `TL_TASK_HANDLE_RECOVERY=0` restores the strict refusal.
- GitHub Copilot in VS Code: workspace setup raises Copilot's 8 KB
  tool-result spill threshold (opt out with `--copilot-inline-results keep`),
  `.github/copilot-instructions.md` becomes a short pointer with
  Copilot-specific notes, and a read-only exploration agent limited to
  TokenLighten's tools is added for VS Code workspaces.
- VS Code integration returns more relevant context per response and uses
  shorter host-specific tool definitions. Workspace setup enables this
  behavior for VS Code; other hosts keep their existing defaults. The
  extension offers a compact guide for Copilot-only workspaces.
- A `read_file` call naming several files with a line range each no longer
  loses lines when its response is shortened: following `next` to the end
  delivers every requested line of every file.
- A read-only request made of several independent questions is no longer
  reported as ready to answer while one of them has no served evidence, and
  a word is no longer certified absent when only its inflection differs from
  the code (`validated` vs `validate`).
- Every served file body goes through one decoding policy; undecodable or
  NUL-heavy files are disclosed instead of served.
- Windows: archive reads, client registration and the bundled runtime work,
  including from a folder extracted by Explorer.

### Migration

Existing VS Code extension and source installs keep working. The first run of
any v0.14.3 entry point migrates the earlier `~/.tokenlighten/bin/tl` launcher
into a forwarder and re-points the host entries it manages. After upgrading, re-run
`tl workspace setup` or the extension's **Set up this workspace** to refresh
the managed instructions and Copilot configuration. Three transitive runtime dependencies move to patched
versions within their existing ranges; no runtime dependency is added. The
three tools, read-only default, and temporary legacy-input migration bridge
are unchanged.

See the [v0.14.3 release notes](release-docs/github-release-v0.14.3.md).

## 0.14.2

- Continuing a task remembers completed reads and requirements established by
  earlier calls, avoiding repeated finished steps.
- Improved focused discovery for named files and identifiers, multi-point
  requests, and Japanese sentences.
- Topics that cannot be found are disclosed alongside the available content.
- Input-waiting decisions explain what remains unresolved and include a
  recovery call when available.
- Repeated full reads respect the requested comment projection and avoid
  resending content already in context.
- Recovery from an edit batch that includes unread files gathers the context
  needed for the whole batch.
- Explicit file-creation requests are recognized directly.
- Code-only workspace setup uses the compact agent guide by default; explicit
  guide-profile settings continue to take precedence.
- Corrected request-schema validation and improved task-state recovery after
  an interrupted state write.

### Migration

`budget.allowFull:true` now only raises the full-read size cap. Clients that
used it to force a resend should use `task.force_serve:true` instead.
Re-run workspace setup to refresh the managed agent instructions. The three
tools, read-only default, and temporary legacy-input migration bridge are
unchanged. No dependency changes are declared in this release.

See the [v0.14.2 release notes](release-docs/github-release-v0.14.2.md).

## 0.14.1

- Task completion now waits until the returned content covers every point in
  the request.
- Reads that exceed their response budget continue through a `cursor` until
  every requested line has been delivered.
- Bounded searches continue as searches instead of expanding into whole-file
  reads.
- `content:"full"` no longer forces content already in context to be re-sent;
  use `task.force_serve:true` to request a resend. The existing
  `budget.allowFull:true` behavior is unchanged.
- Edits that quote unique source text keep discovery local to that text.
- `target:"all"` now replaces every match of a path-based edit and reports the
  count; new files can be created in the same batch as other edits.
- Added the `code` tool surface for code-only workspaces
  (`--tool-surface code`, `TOKENLIGHTEN_TOOL_SURFACE`, or the VS Code setting
  `tokenlighten.toolSurface`).
- Updated the managed agent instructions, including the edit rules.

### Migration

Custom clients that used `content:"full"` to force a resend should send
`task.force_serve:true`. Continuations may carry an opaque `cursor`; execute
the returned `next` as given. Legacy v0.12/v0.13 request fields remain refused
by default; `TL_LEGACY_INPUT=accept` is still the temporary migration bridge.
No dependency changes are declared in this release.

See the [v0.14.1 release notes](release-docs/github-release-v0.14.1.md).

## 0.14.0

- Improved continuation and recovery calls when response budgets or search
  scope prevent a request from completing.
- Made discovery more focused for edits that identify unique source text.
- Improved task and workspace continuity across retries.
- Made context handling consistent with the content returned to the client.
- Clarified local usage information in the CLI and VS Code extension.
- Updated dependencies to address security issues.

### Migration

Legacy v0.12/v0.13 request fields are refused by default. Update custom clients
to the current request format in [MCP tools](release-docs/mcp-tools.md).
`TL_LEGACY_INPUT=accept` is available as a temporary server-side migration
bridge. `TL_LITERAL_FIRST_ROUTING=0` restores the previous discovery routing.

The obsolete settings `TL_INTERFACE_AUTHORITY`, `TL_POST_READY_TRIM`,
`TL_POST_READY_TRIM_N`, `TL_OVERLAP_TRIM`, `TL_ADAPTIVE_WHOLE_FILE`,
`TL_VERIFICATION_RECIPE`, `TL_HOP1_CLOSURE`, `TL_EVIDENCE_SHADOW`,
`TL_EVIDENCE_COMPLETION`, `TL_WRITE_CAPABILITY`, and `TL_SCHEMA_DEFS`
were removed.

The following optional settings were consolidated:

| Previous setting | Replacement |
|---|---|
| `TL_RRF_PROFILES` | `TL_RRF_FUSION=profiles` |
| `TL_COVERAGE_PACKER_V2` | `TL_COVERAGE_PACKER=v2` |
| `TL_COMPOUND_RETRIEVAL` | `TL_GRAPH_EVIDENCE=compound` |

The server remains read-only by default; writes require `--allow-write`.

### Known limitations

- A rare response-budget fallback can still return a generic JSON-RPC error;
  retry with a larger `budget` or a narrower target.
- Read plain files separately from archive or document members in
  multi-target requests.

See the [v0.14.0 release notes](release-docs/github-release-v0.14.0.md).

## 0.13.1

- Isolated task and edit context between concurrent agent lanes.
- Corrected multi-target range reads and batches that create and edit files.
- Prevented repeated completed continuations and looping pathless discovery.
- Improved completion checks for requests containing multiple requirements.
- Included exploration calls in task-level local usage estimates.

See the [v0.13.1 release notes](release-docs/github-release-v0.13.1.md).

## 0.13.0

- Introduced the canonical grouped request fields for the three MCP tools.
- Improved completion checks, continuation handling, and replay-safe edits.
- Added automatic refresh of cached MCP tool definitions in VS Code.
- Updated managed agent instructions for the canonical request format.

See the [v0.13.0 release notes](release-docs/github-release-v0.13.0.md).

## 0.12.1

- Updated dependencies and removed unused packages.
- Hardened configuration parsing, source scanning, and document extraction.
- Improved handling of generated text and random edit handles.

See the [v0.12.1 release notes](release-docs/github-release-v0.12.1.md).

## 0.12.0

- Improved task continuity, Japanese-language retrieval, and large-file reads.
- Added Markdown heading outlines and more compact edit responses.
- Made unsupported-encoding writes fail without changing files.
- Improved setup guidance, diagnostics, and nested CLI help.

See the [v0.12.0 release notes](release-docs/github-release-v0.12.0.md).

## 0.11.1

- Improved task continuity across server restarts.
- Added clearer search coverage and file freshness checks.
- Improved batched discovery and bounded edits.
- Expanded workspace setup and VS Code diagnostics.

See the [v0.11.1 release notes](release-docs/github-release-v0.11.1.md).

## 0.9.0

- First public beta with the CLI, MCP server, and self-contained VS Code
  extension.
- Three tools for focused reads, searches, and bounded edits.
- Local repository indexing and read-only operation by default.
- Support for common programming languages and selected document and
  archive formats.

See the [v0.9.0 release notes](release-docs/github-release-v0.9.0.md).
