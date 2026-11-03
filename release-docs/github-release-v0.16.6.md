# TokenLighten v0.16.6

**Public Beta.** This patch release improves code discovery from English and
Japanese requests, continued reads and edit summaries, and workspace setup.

## Improvements and fixes

- **Code questions retain the evidence they need.** Discovery follows the
  operations and relationships described in a request, including related
  callbacks and configuration uses. Compound requests keep their outstanding
  requirements when a later read narrows the target. A matching name or a
  document mentioning a topic does not by itself establish that the code
  implements it. Incomplete or unsupported discovery keeps its limitations
  visible and provides continuation where available.
- **Continued reads and searches preserve useful context.** An outline after
  a partial source read returns the requested signatures. Search results
  distinguish matches already read from new matches and avoid assigning hits
  across several functions to a single enclosing function.
- **Edit summaries reflect the resulting files.** Added and removed line
  counts compare the original and final text, without counting unchanged
  context or intermediate edits. Applied operation counts are reported
  separately from the number of changed files. Very large rewrites can omit
  line counts when calculating them would exceed the processing limit.
- **Workspace setup can be previewed.** `tl workspace setup --dry-run`
  reports the plan without updating workspace configuration, hooks or the
  workspace registry. Use `--root DIR` to name the workspace. Unknown options,
  missing or repeated option values, unsupported clients and unexpected
  positional arguments are rejected before setup changes are made.
- **Command and usage summaries are clearer.** `tl run` groups repeated
  TypeScript diagnostics while retaining their distinct details and source
  locations within the output budget; the full local log retains every
  occurrence. `tl logs summary` explains when session savings cannot be
  determined from local call logs and labels modeled estimates accordingly.

## Upgrade and compatibility

Install the v0.16.6 archive for your platform or the v0.16.6 VSIX. Refresh
workspace setup with `tl-setup <workspace>`, `tl workspace setup`, or the
extension's **Set up this workspace**, then start a new agent session or
reconnect your MCP client. Refreshing setup adopts the updated agent guides.

CLI workspace refresh preserves existing per-client write permissions.
Use `--read-only` or `--allow-write` to change them explicitly. Extension
setup enables writes; a manually started server requires `--allow-write`
for edits.

Setup continues to install agent hooks for the clients it configures.
`--no-hooks` skips changes to the output and compaction hooks;
`--remove-hooks` removes TokenLighten's entries. VS Code's separate
SessionStart context hint has its own option: use
`tl workspace setup --clients vscode --no-hooks --copilot-session-context keep`
to leave both hook configurations unchanged. Client trust and hook settings
still apply. Full command logs stay under `.tokenlighten/.runtime/run/`.

The three MCP tools and supported canonical top-level request fields are
unchanged from v0.16.5. Edit and search replies include additional result
details. Follow returned `next` calls and any supplied `edit_rules`.
Incomplete discovery is not proof that an implementation is absent.

Optional typed resolution, semantic search, reply selection and table-view
settings remain off by default. Existing language, format, budget and client
limitations still apply. See [MCP tools](https://github.com/Takayuki-Ishimaru/tokenlighten/blob/v0.16.6/release-docs/mcp-tools.md)
and [Agent hooks](https://github.com/Takayuki-Ishimaru/tokenlighten/blob/v0.16.6/release-docs/getting-started.md#agent-hooks).

## Assets

- `tokenlighten-0.16.6-win-x64.tgz` and `tokenlighten-0.16.6-win-x64.zip`
- `tokenlighten-0.16.6-darwin-arm64.tgz`
- `tokenlighten-0.16.6-darwin-x64.tgz`
- `tokenlighten-0.16.6-linux-x64.tgz`
- `tokenlighten-vscode-extension-0.16.6.vsix`
- `SHA256SUMS` (covers every archive and the VSIX)

## Documentation and support

- [Getting started](https://github.com/Takayuki-Ishimaru/tokenlighten/blob/v0.16.6/release-docs/getting-started.md)
- [VS Code extension](https://github.com/Takayuki-Ishimaru/tokenlighten/blob/v0.16.6/release-docs/vscode-extension.md)
- [Privacy, security, and support](https://github.com/Takayuki-Ishimaru/tokenlighten/blob/v0.16.6/release-docs/privacy-security-support.md)
- [Licensing and use policy](https://github.com/Takayuki-Ishimaru/tokenlighten/blob/v0.16.6/release-docs/licensing.md)

TokenLighten is source-available. The release's `LICENSE` file defines the
terms of use. Support is provided on a best-effort basis.
