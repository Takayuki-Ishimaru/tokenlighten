# TokenLighten v0.16.2

**Public Beta.** This patch release improves code explanations, protected-file
handling and CLI reliability.

## Fixes

- **Explanations include the implementation needed to answer.** Questions
  combining conditions and callers keep both requirements attached to the
  named functions. Configuration-file questions include the connected
  reader, defaults, path selection and invalid-JSON handling when available.
- **English and Japanese questions retain their intended scope.** Requests
  about values, save-event processing, called functions and error handling
  retain those details without turning explanation wording into extra search
  subjects. Function names qualified by a source file remain tied to it.
- **Related calls keep their identity.** Calls such as `tax.calculate(...)`
  and `shipping.calculate(...)` are followed separately. A local variable or
  parameter that shadows an import is not treated as that imported module.
  TypeScript type-only references no longer create false runtime-value gaps;
  missing implementations remain disclosed.
- **Protected-file lists apply to every listed file.** Comma-separated and
  Japanese coordinated lists retain each prohibition, while a later,
  separate edit command keeps its own target.
- **Optional local analysis handles more source shapes correctly.** Typed
  symbol lookup keeps distinct same-named receiver calls separate in its
  cache. Semantic-search anchors preserve line positions for LF, CRLF and
  CR source text.
- **CLI failures are reported more reliably.** MCP connection checks reject
  error or malformed replies and report early process exit or input-stream
  failure. Stopping a server preserves process metadata if a newer instance
  replaced it or the original process is still running.
- **Usage reads tolerate log rotation.** A log file removed during a read is
  skipped; permission and I/O errors continue to be reported.

## Upgrade and compatibility

Install the v0.16.2 archive for your platform or the v0.16.2 VSIX. Run
`tl-setup <workspace>`, refresh with `tl workspace setup`, or use the
extension's **Set up this workspace**. Start a new agent session or
reconnect the MCP client.

CLI workspace refresh preserves existing per-client write permissions.
Use `--read-only` or `--allow-write` to change them explicitly. The
extension's setup enables writes; a manually started server requires
`--allow-write` for edits.

The three MCP tools and canonical top-level request fields are unchanged
from v0.16.1. Preserve the original request when continuing a task and
follow returned `next` calls unchanged.

## Scope and limitations

Typed symbol resolution and semantic search remain optional and off by
default; compound request composition is on by default. See
[Local analysis engines](https://github.com/Takayuki-Ishimaru/tokenlighten/blob/v0.16.2/release-docs/local-analysis.md)
for setup and limitations.

Large reads and compound questions may require continuation. Existing
language, format, budget and client limitations apply; see
[MCP tools](https://github.com/Takayuki-Ishimaru/tokenlighten/blob/v0.16.2/release-docs/mcp-tools.md).

## Assets

- `tokenlighten-0.16.2-win-x64.tgz` and `tokenlighten-0.16.2-win-x64.zip`
- `tokenlighten-0.16.2-darwin-arm64.tgz`
- `tokenlighten-0.16.2-darwin-x64.tgz`
- `tokenlighten-0.16.2-linux-x64.tgz`
- `tokenlighten-vscode-extension-0.16.2.vsix`
- `SHA256SUMS` (covers every archive and the VSIX)

## Documentation and support

- [Getting started](https://github.com/Takayuki-Ishimaru/tokenlighten/blob/v0.16.2/release-docs/getting-started.md)
- [VS Code extension](https://github.com/Takayuki-Ishimaru/tokenlighten/blob/v0.16.2/release-docs/vscode-extension.md)
- [Privacy, security, and support](https://github.com/Takayuki-Ishimaru/tokenlighten/blob/v0.16.2/release-docs/privacy-security-support.md)
- [Licensing and use policy](https://github.com/Takayuki-Ishimaru/tokenlighten/blob/v0.16.2/release-docs/licensing.md)

TokenLighten is source-available. The release's `LICENSE` file defines
the terms of use. Support is provided on a best-effort basis.
