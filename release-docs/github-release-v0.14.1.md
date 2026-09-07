# TokenLighten v0.14.1

**Public Beta reliability update.** TokenLighten v0.14.1 improves how coding
agents decide that they have read enough, and how interrupted reads and
searches continue. It keeps the same three MCP tools: `read_file`,
`search_files`, and `edit_file`. The server remains read-only unless started
with `--allow-write`.

## Highlights

- **Completion waits for the evidence.** A task pack is not reported as ready
  to answer or edit until the content actually returned covers every point in
  the request, including the full declaration of a function the decision
  depends on. A point the workspace verifiably lacks is disclosed as absent
  instead of being dropped.
- **Full reads finish.** A `read_file` that exceeds its response budget
  returns a `cursor` that continues the original request until every
  requested line has been delivered. Run the returned `next` as given; the
  response also names the remainder still outstanding.
- **Searches stay searches.** A bounded `search_files` continues through a
  cursor over its matches in a stable order. It no longer proposes a
  whole-file read to finish a search.
- **Receipts without detours.** When requested content is already in the
  client's context, the receipt carries a `next` only if that request still
  has undelivered lines.
- **Explicit resend.** `content:"full"` selects what to read; it no longer
  forces content already in context to be sent again. Use
  `task.force_serve:true` when the client has genuinely lost that context.
- **Edits that quote unique text stay local.** A request that identifies a
  unique piece of source text narrows discovery to that occurrence and
  returns its source with the edit context.
- **Batch edits behave as advertised.** `target:"all"` replaces every match
  of a path-based edit and reports the count, a new file can be created in
  the same batch as other edits, and a refused batch's recovery names every
  file it needs.
- **Smaller tool surface for code-only workspaces.** `--tool-surface code`
  (also `TOKENLIGHTEN_TOOL_SURFACE=code`, `tl workspace setup --tool-surface
  code`, or the VS Code setting `tokenlighten.toolSurface`) advertises a
  smaller schema without Office, archive, or credential inputs. `full`
  remains the default.

See the [changelog](../CHANGELOG.md) for release highlights.

## Compatibility and migration

- The three tools and their canonical request structure are unchanged apart
  from the added `read_file` `cursor` field. The schema stamp changes, so the
  VS Code extension refreshes its cached tool definitions; other clients pick
  up the new definitions when they reconnect.
- `content:"full"` no longer forces a resend. A custom client that relied on
  it to re-fetch content should send `task.force_serve:true` instead.
- Continuations may now carry an opaque `cursor`. Execute the returned `next`
  exactly as given. A `cursor-stale` refusal carries a restart `next`, and a
  `cursor-invalid` refusal means the original call should be re-issued.
- Legacy v0.12/v0.13 request fields remain refused by default;
  `TL_LEGACY_INPUT=accept` is still available as a temporary server-side
  migration bridge.
- Under an active task, `edit_file` changes only files the server served in
  that task; an edit to any other file is refused with a `next` that reads
  every refused file first. `target:"all"` now replaces every match of a
  path-based item and reports the count, and a `create:true` item can ride
  the same batch as other edits. See [MCP tools](mcp-tools.md#editing).
- The managed agent instructions (the TokenLighten blocks in AGENTS.md and
  CLAUDE.md) were updated for cursor continuation, receipts, and these edit
  rules. Re-run `tl workspace setup`, or **Set up this workspace** in
  VS Code, to refresh them.
- Changing the tool surface requires restarting or reconnecting the server.
- This release declares no dependency changes; the runtime dependency set is
  the same as v0.14.0. Workspace changes still require `--allow-write`.
- The public release includes the CLI, MCP server, source and package tests,
  and VS Code extension. The desktop application is not included.

## Known limitations

- A rare response-budget fallback can still return a generic JSON-RPC error.
  Retry with a larger `budget` or a narrower target.
- Read plain files separately from archive or document members when using
  multiple targets in one request.
- `budget.allowFull:true` still re-sends full content that is already in
  context; only `content:"full"` gained receipt behavior in this release.
- For a file the built-in parser cannot analyze, a decision that depends on
  that file closes only after the whole file has been served; the returned
  `next` names the unserved range.
- When a quoted literal occurs twice in one large file, the narrowed edit
  context may include only one occurrence. Read the other occurrence
  explicitly before an edit that must change both.
- Files larger than the discovery index limit may require an explicit path
  and range. Very large repositories may take longer on the first request.
- Rename and reference operations are lexical and do not provide full
  language-server semantic resolution.
- PDF reading requires a text layer; scanned PDFs need OCR elsewhere.
  TAR, TAR.GZ/TGZ, 7Z, and RAR archives remain read-only.

See [Language and file support](language-support.md) for supported formats.

## Install the VS Code extension

Download `tokenlighten-vscode-extension-0.14.1.vsix` from the release assets.
The same file works on Windows, macOS, and Linux and includes the CLI, MCP
server, license, and third-party notices. A separate Node.js or `tl`
installation is not required.

```sh
code --install-extension tokenlighten-vscode-extension-0.14.1.vsix
```

Open a trusted project folder, open the TokenLighten view, and choose
**Set up this workspace**. Compare the downloaded file's SHA-256 with the
`SHA256SUMS` release asset.

## Documentation and support

- [Getting started](getting-started.md)
- [MCP tools](mcp-tools.md)
- [VS Code extension](vscode-extension.md)
- [Privacy, security, and support](privacy-security-support.md)
- [Licensing and use policy](licensing.md)

TokenLighten is source-available. The release's `LICENSE` file defines the
terms of use. Support is provided on a best-effort basis.
