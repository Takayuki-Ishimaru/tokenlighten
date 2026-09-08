# TokenLighten v0.14.2

**Public Beta reliability update.** TokenLighten v0.14.2 improves task
continuation, interpretation of multi-point and Japanese requests, and
workspace setup for code-only projects. It keeps the same three MCP tools:
`read_file`, `search_files`, and `edit_file`. The server remains read-only
unless started with `--allow-write`.

## Highlights

- **Continue without repeating finished steps.** A task resumed through its
  returned `qref` remembers completed reads and requirements established by
  earlier calls. It moves to the answer, edit, or next unfinished step.
- **Keep the request's focus.** Requests naming specific files, identifiers,
  or quoted topics no longer fall back to a generic overview. Multi-sentence
  Japanese requests retain their opening sentence, and discovery handles
  Japanese topic words more accurately.
- **Explain what is missing.** Topics that cannot be found are disclosed
  alongside the content that is available. When a task waits for input, it
  names what remains unresolved and provides a recovery call when available.
- **Avoid unnecessary resends.** Repeated full reads respect the requested
  comment projection. `budget.allowFull:true` raises the size cap without
  forcing content already in context to be sent again.
- **Recover batch edits together.** If a batch includes files that have not
  been read, its recovery call gathers the context needed for the entire
  batch. Explicit file-creation requests are recognized directly.
- **Use a smaller guide for code-only projects.** Workspace setup with the
  `code` tool surface now selects the compact agent guide by default. An
  explicit CLI or VS Code guide-profile setting still takes precedence.
- **More reliable client validation and task state.** Valid cursor
  continuations with task or budget fields pass the advertised schema;
  invalid field combinations and incorrectly typed arrays are rejected.
  Task state also recovers more reliably after an interrupted state write.

## Compatibility and migration

- The three tools and canonical request fields remain available. Reconnect
  custom MCP clients to pick up the updated tool definitions; VS Code uses
  the bundled schema stamp to refresh its cached definitions.
- `budget.allowFull:true` no longer forces a resend. Use
  `task.force_serve:true` when previously served context has been lost and
  must be sent again. `content:"full"` keeps its existing receipt behavior.
- An `await_input` decision may include `unresolved[]` and `next`. Read
  the unresolved reason and execute any returned continuation as given.
- Re-run `tl workspace setup`, or **Set up this workspace** in VS Code, to
  refresh managed agent instructions. With `--tool-surface code`, setup now
  writes the compact guide unless a guide profile is explicitly selected.
  Use `--guide-profile full` or `medium`, or the VS Code setting
  `tokenlighten.guideProfile`, to override that default.
- Legacy v0.12/v0.13 request fields remain refused by default.
  `TL_LEGACY_INPUT=accept` remains a temporary server-side migration bridge.
- No dependency changes are declared relative to v0.14.1.
- The public release includes the CLI, MCP server, source and package tests,
  and VS Code extension. The desktop application is not included.

## Known limitations

- A rare response-budget fallback can still return a generic JSON-RPC error.
  Retry with a larger `budget` or a narrower target.
- Read plain files separately from archive or document members when using
  multiple targets in one request.
- For a file the built-in parser cannot analyze, a decision depending on
  that file may need the whole file to be served; follow the returned `next`.
- When quoted text occurs twice in one large file, the narrowed edit context
  may include only one occurrence. Read the other explicitly before changing
  both.
- Files larger than the discovery index limit may require an explicit path
  and range. Very large repositories may take longer on the first request.
- Rename and reference operations are lexical and do not provide full
  language-server semantic resolution.
- PDF reading requires a text layer; scanned PDFs need OCR elsewhere.
  TAR, TAR.GZ/TGZ, 7Z, and RAR archives remain read-only.

See [Language and file support](language-support.md) for supported formats.

## Install the VS Code extension

Download `tokenlighten-vscode-extension-0.14.2.vsix` from the release assets.
The same file works on Windows, macOS, and Linux and includes the CLI, MCP
server, license, and third-party notices. A separate Node.js or `tl`
installation is not required.

```sh
code --install-extension tokenlighten-vscode-extension-0.14.2.vsix
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
