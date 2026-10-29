# TokenLighten v0.16.3

**Public Beta.** This patch release improves repository discovery, continued
reads, and installation and removal workflows.

## Fixes

- **Dependency maintenance.** Updated the MCP transport dependency
  `@hono/node-server` to the upstream patched release, 2.1.3.
- **Discovery stays focused on the requested implementation.** Questions
  containing a quoted CLI command and its options can locate the matching
  command source while retaining explicitly named files and projects.
  Bug reports no longer treat incidental working-tree changes as the cause
  unless the request asks to investigate those changes.
- **Compound questions retain more of their scope.** Long English and
  Japanese requests keep their individual requirements through continued
  discovery. Large questions may still require follow-up calls.
- **Python symbol reads prefer the implementation.** Explicit overload
  declarations no longer displace a unique implementation in the same
  scope. Same-named methods in different classes remain distinct;
  ambiguous names require a more specific selection.
- **Continued reads preserve the requested content.** Forced resends and
  budgeted batches continue returning source through the remaining pages.
  Reads that request previously omitted comments retain the follow-up
  needed to retrieve them. Compact acknowledgements of earlier reads keep
  valid edit addresses for the current task.
- **Windows C/C++ include discovery preserves native paths.** Compilation
  commands retain drive-letter and UNC paths, including quoted include
  directories containing spaces.
- **Installation controls behave more consistently.** `--dry-run` also
  previews version switching, pruning and uninstall without changing files.
  These operations require `--yes` in a non-interactive shell. For files
  whose creation was recorded by setup, uninstall removes empty generated
  configuration and guide files while preserving user content.
- **Runtime and usage reporting are clearer.** New `.tokenlighten` runtime
  directories include a local ignore file. Setup reports the actual usage
  log location, and ordinary `tl doctor` checks omit contributor-only
  prerequisites. Usage summaries keep token estimates separate from cost
  estimates and leave full-session cost reductions unavailable when some
  usage cannot be priced.

## Upgrade and compatibility

Install the v0.16.3 archive for your platform or the v0.16.3 VSIX. Run
`tl-setup <workspace>`, refresh with `tl workspace setup`, or use the
extension's **Set up this workspace**. Start a new agent session or
reconnect the MCP client.

CLI workspace refresh preserves existing per-client write permissions.
Use `--read-only` or `--allow-write` to change them explicitly. The
extension's setup enables writes; a manually started server requires
`--allow-write` for edits.

Scripts that invoke `tl install --use`, `--prune` or `--uninstall` without
an interactive terminal must now pass `--yes`. Use `--dry-run` to preview
the operation first.

The three MCP tools and canonical top-level request fields are unchanged
from v0.16.2. Preserve the original request when continuing a task and
follow returned `next` calls unchanged.

## Scope and limitations

Typed symbol resolution and semantic search remain optional and off by
default; compound request composition is on by default. See
[Local analysis engines](https://github.com/Takayuki-Ishimaru/tokenlighten/blob/v0.16.3/release-docs/local-analysis.md)
for setup and limitations.

Large reads and compound questions may require continuation. Existing
language, format, budget and client limitations apply; see
[MCP tools](https://github.com/Takayuki-Ishimaru/tokenlighten/blob/v0.16.3/release-docs/mcp-tools.md).

## Assets

- `tokenlighten-0.16.3-win-x64.tgz` and `tokenlighten-0.16.3-win-x64.zip`
- `tokenlighten-0.16.3-darwin-arm64.tgz`
- `tokenlighten-0.16.3-darwin-x64.tgz`
- `tokenlighten-0.16.3-linux-x64.tgz`
- `tokenlighten-vscode-extension-0.16.3.vsix`
- `SHA256SUMS` (covers every archive and the VSIX)

## Documentation and support

- [Getting started](https://github.com/Takayuki-Ishimaru/tokenlighten/blob/v0.16.3/release-docs/getting-started.md)
- [VS Code extension](https://github.com/Takayuki-Ishimaru/tokenlighten/blob/v0.16.3/release-docs/vscode-extension.md)
- [Privacy, security, and support](https://github.com/Takayuki-Ishimaru/tokenlighten/blob/v0.16.3/release-docs/privacy-security-support.md)
- [Licensing and use policy](https://github.com/Takayuki-Ishimaru/tokenlighten/blob/v0.16.3/release-docs/licensing.md)

TokenLighten is source-available. The release's `LICENSE` file defines
the terms of use. Support is provided on a best-effort basis.
