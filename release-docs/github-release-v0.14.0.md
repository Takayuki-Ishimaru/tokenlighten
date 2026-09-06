# TokenLighten v0.14.0

**Public Beta.** TokenLighten v0.14.0 improves repository discovery, task
continuation, and focused editing for coding agents. It provides the same
three MCP tools: `read_file`, `search_files`, and `edit_file`.
The server remains read-only unless started with `--allow-write`.

## Highlights

- **Clearer recovery.** When a request exceeds its response budget or needs a
  different search scope, the server provides a next call in the supported
  request format.
- **More focused edits.** Requests that identify a unique piece of source text
  use that text to narrow discovery by default.
- **Reliable continuation and retries.** Continuations preserve task and
  workspace context, including requests that start a new task. Edit retries
  with the same `operation_id` return the recorded result.
- **Consistent context handling.** Read and edit decisions use the content
  actually returned to the client.
- **Clearer local usage information.** The CLI and VS Code extension distinguish
  observed usage from estimates. Local estimates are not provider billing
  records, and savings vary by task, repository, client, and model.
- **Updated dependencies.** Dependency updates address security issues.

See the [changelog](../CHANGELOG.md) for release highlights.

## Compatibility and migration

- The three tools retain the canonical request structure introduced in v0.13.
  VS Code refreshes cached tool definitions when their schema changes.
- **Legacy input is refused by default.** Old fields such as `mode`,
  `paths`, `handles`, bare `maxBytes`/`maxTokens`, and legacy task
  fields return a `legacy-input` refusal with migration guidance. Update
  custom clients to the fields documented in [MCP tools](mcp-tools.md).
- `TL_LEGACY_INPUT=accept` temporarily enables old request fields on the
  server during migration. New integrations should use canonical arguments
  and execute the returned `next` calls.
- Literal-first discovery is enabled by default. Set
  `TL_LITERAL_FIRST_ROUTING=0` to restore the previous routing behavior.
- Workspace changes still require `--allow-write`.
- The public release includes the CLI, MCP server, source and package tests,
  and VS Code extension. The desktop application is not included.

## Known limitations

- A rare response-budget fallback can still return a generic JSON-RPC error.
  Retry with a larger `budget` or a narrower target.
- Read plain files separately from archive or document members when using
  multiple targets in one request.
- Files larger than the discovery index limit may require an explicit path
  and range. Very large repositories may take longer on the first request.
- Rename and reference operations are lexical and do not provide full
  language-server semantic resolution.
- PDF reading requires a text layer; scanned PDFs need OCR elsewhere.
  TAR, TAR.GZ/TGZ, 7Z, and RAR archives remain read-only.

See [Language and file support](language-support.md) for supported formats.

## Install the VS Code extension

Download `tokenlighten-vscode-extension-0.14.0.vsix` from the release assets.
The same file works on Windows, macOS, and Linux and includes the CLI, MCP
server, license, and third-party notices. A separate Node.js or `tl`
installation is not required.

```sh
code --install-extension tokenlighten-vscode-extension-0.14.0.vsix
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
