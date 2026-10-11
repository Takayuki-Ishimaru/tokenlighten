# TokenLighten v0.15.2

**Public Beta.** This maintenance release uses shorter setup guides and
improves source fidelity, Japanese questions and search continuation.

The three MCP tools remain `tl_read_file`, `tl_search_files`, and
`tl_edit_file`. The server is read-only unless started with `--allow-write`.

## Setup improvements

- **Compact guides by default.** Workspace setup and guide generation use
  `compact` for Claude Code, Codex and GitHub Copilot on both tool surfaces.
  An explicit `full` or `medium` profile still takes precedence. The compact
  guides retain file creation, task continuation, write recovery and
  verification instructions. Copilot keeps its dedicated guide and the
  existing safeguards for user instructions and attachments.
- **Tools available at session startup.** Claude Code's generated
  TokenLighten entry uses `alwaysLoad: true`. Codex's generated workspace
  configuration uses the native top-level
  `mcp_optional_startup_grace_ms = 0` to wait for optional servers up to
  their individual startup timeouts. This also affects other optional
  servers in that workspace and can increase startup waiting time. Existing
  explicit workspace values are preserved. These controls require client
  support; higher-precedence configuration may override project settings.
  Machine-wide Codex registration alone does not apply the project startup
  setting. Copilot uses its existing VS Code MCP registration.

## Read and search fixes

- **Source lines remain accurate when comments are omitted.** Evidence
  bodies match the source lines they identify. Repeating a read respects
  the requested comment view; selecting a different view returns it.
- **Japanese questions retain the requested subject.** Explanation wording
  and questions about what a function returns no longer produce spurious
  missing-code reports or select an unrelated task type. Class-flow
  descriptions and tail-expression returns are handled more reliably.
- **Searches continue within the response budget.** Text search pages,
  workspace trees and archive-member trees use returned continuations to
  deliver the remaining results. Follow each `next` unchanged.

## Reliability

- Invalid canonical requests are rejected before an edit or task-state
  update. Numeric column and section selectors remain accepted.
- Initial task setup and repeated local state writes avoid unnecessary
  rescanning and rereading.
- MCP SDK dependencies are updated to upstream patched releases for
  [GHSA-6qxp-vccf-f47h](https://github.com/advisories/GHSA-6qxp-vccf-f47h).
  That advisory concerns HTTP OAuth clients; SDK-built servers and stdio
  clients are not affected.

## Upgrade

Install the v0.15.2 archive for your platform or the v0.15.2 VSIX. Run
`tl-setup <workspace>` from the new archive, or re-run `tl workspace setup`
or the extension's **Set up this workspace**. Start a new agent session or
reconnect your MCP client to load the new guides and startup configuration.

To keep a longer shared guide, use `--guide-profile full` or `medium`, or
set `tokenlighten.guideProfile` explicitly in VS Code.

The canonical request fields and three tool names are unchanged from
v0.15.1. See [Getting started](https://github.com/Takayuki-Ishimaru/tokenlighten/blob/v0.15.2/release-docs/getting-started.md) for startup settings,
workspace refresh, rollback and uninstall.

## Known limitations

- Savings depend on the task, client, model and caching. No new savings
  percentage is claimed for v0.15.2. The README comparisons describe
  v0.15.0 observations.
- Questions with multiple subjects can require a continuation before all
  evidence is returned. Follow the server's `next` and preserve disclosed
  unresolved points.
- Import and caller lookup uses supported syntax and textual relationships,
  rather than full type-aware analysis. External library definitions may
  need separate verification.
- Existing read, edit-window, budget and client limitations remain; see
  [MCP tools](https://github.com/Takayuki-Ishimaru/tokenlighten/blob/v0.15.2/release-docs/mcp-tools.md).

## Assets

- `tokenlighten-0.15.2-win-x64.tgz` and `tokenlighten-0.15.2-win-x64.zip`
- `tokenlighten-0.15.2-darwin-arm64.tgz`
- `tokenlighten-0.15.2-darwin-x64.tgz`
- `tokenlighten-0.15.2-linux-x64.tgz`
- `tokenlighten-vscode-extension-0.15.2.vsix`
- `SHA256SUMS` (covers every archive and the VSIX)

## Documentation and support

- [Getting started](https://github.com/Takayuki-Ishimaru/tokenlighten/blob/v0.15.2/release-docs/getting-started.md)
- [Managed environments](https://github.com/Takayuki-Ishimaru/tokenlighten/blob/v0.15.2/release-docs/managed-environments.md)
- [MCP tools](https://github.com/Takayuki-Ishimaru/tokenlighten/blob/v0.15.2/release-docs/mcp-tools.md)
- [VS Code extension](https://github.com/Takayuki-Ishimaru/tokenlighten/blob/v0.15.2/release-docs/vscode-extension.md)
- [Privacy, security, and support](https://github.com/Takayuki-Ishimaru/tokenlighten/blob/v0.15.2/release-docs/privacy-security-support.md)
- [Licensing and use policy](https://github.com/Takayuki-Ishimaru/tokenlighten/blob/v0.15.2/release-docs/licensing.md)

TokenLighten is source-available. The release's `LICENSE` file defines the
terms of use. Support is provided on a best-effort basis.
