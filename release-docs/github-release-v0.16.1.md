# TokenLighten v0.16.1

**Public Beta.** This patch release fixes edit boundaries and improves
English and Japanese explanation requests.

## Fixes

- **Ranged edits preserve surrounding source.** An explicit `edits[].range`
  applies to both replacement content and search-and-replace, whether the
  item uses a path or a handle. Bytes outside the selected lines are
  preserved, including LF, CRLF and CR line endings. Invalid or empty ranges
  and searches outside the range are refused without applying the batch.
- **Explicitly protected files stay protected during task recovery.**
  Instructions such as “Do not modify src/config.ts” continue to prevent
  edits when the file is read as context or the same task is reconstructed.
  A batch containing a prohibited edit is refused before any file is
  changed. A new task can establish new edit instructions.
- **Explanation requests retain their intended subjects.** An English
  follow-up such as “Give the conditions and callers” stays associated with
  both functions named in the preceding sentence. Japanese wording such as
  「実装に基づいて説明してください。変更は不要です。」 no longer becomes
  extra code-search subjects.

## Upgrade and compatibility

Install the v0.16.1 archive for your platform or the v0.16.1 VSIX. Run
`tl-setup <workspace>`, refresh with `tl workspace setup`, or use the
extension's **Set up this workspace**. Start a new agent session or
reconnect the MCP client.

CLI workspace refresh preserves existing per-client write permissions.
Use `--read-only` or `--allow-write` to change them explicitly. The
extension's setup enables writes; a manually started server requires
`--allow-write` for edits.

The three MCP tools and canonical top-level request fields are unchanged
from v0.16.0. Line ranges belong inside individual `edits[]` items.
Preserve the original request when continuing a task and follow returned
`next` calls unchanged.

## Scope and limitations

This release retains the local analysis engines introduced in v0.16.0.
Typed symbol resolution and semantic search are optional and off by
default; compound request composition is on by default. See
[Local analysis engines](https://github.com/Takayuki-Ishimaru/tokenlighten/blob/v0.16.1/release-docs/local-analysis.md)
for setup and limitations.

Large reads and compound questions may require continuation. Existing
language, format, budget and client limitations apply; see
[MCP tools](https://github.com/Takayuki-Ishimaru/tokenlighten/blob/v0.16.1/release-docs/mcp-tools.md).

## Assets

- `tokenlighten-0.16.1-win-x64.tgz` and `tokenlighten-0.16.1-win-x64.zip`
- `tokenlighten-0.16.1-darwin-arm64.tgz`
- `tokenlighten-0.16.1-darwin-x64.tgz`
- `tokenlighten-0.16.1-linux-x64.tgz`
- `tokenlighten-vscode-extension-0.16.1.vsix`
- `SHA256SUMS` (covers every archive and the VSIX)

## Documentation and support

- [Getting started](https://github.com/Takayuki-Ishimaru/tokenlighten/blob/v0.16.1/release-docs/getting-started.md)
- [VS Code extension](https://github.com/Takayuki-Ishimaru/tokenlighten/blob/v0.16.1/release-docs/vscode-extension.md)
- [Privacy, security, and support](https://github.com/Takayuki-Ishimaru/tokenlighten/blob/v0.16.1/release-docs/privacy-security-support.md)
- [Licensing and use policy](https://github.com/Takayuki-Ishimaru/tokenlighten/blob/v0.16.1/release-docs/licensing.md)

TokenLighten is source-available. The release's `LICENSE` file defines
the terms of use. Support is provided on a best-effort basis.
