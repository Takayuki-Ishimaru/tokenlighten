# TokenLighten v0.16.4

**Public Beta.** This patch release improves CSV lookups, focused code
discovery, continued reads and edits, and MCP server startup.

## Improvements and fixes

- **CSV questions can be answered sooner.** A supported read-only request
  naming a CSV file can receive matching rows and a whole-table match count
  in the first reply. Supported count and multi-column lookups can finish
  without listing every match. Requests needing more evidence continue
  searching. Large tables retain a bounded preview and a continuation to
  the remaining rows; each preview reports the rows it actually contains.
- **Discovery starts with the code you name.** Dotted members, identifiers
  and quoted literals guide the first lookup. JavaScript and TypeScript
  function assignments and getter-style accessors are available as symbols.
  English and Japanese explanation requests are recognized more reliably,
  and continued discovery avoids repeatedly paging unrelated documentation.
- **Bug fixes retain useful context.** Nearby matches in a short function
  can bring its full body into view. Edit replies show surrounding code
  after lines are removed, and reads of omitted comments return the requested
  comments. Verification suggestions focus on tests related to the change
  and disclose when tests cannot run.
- **Client replies use space more effectively.** Claude Code, Copilot CLI
  and Codex CLI receive smaller tool definitions while the server continues
  accepting and validating the supported request fields. Compact workspace
  guides supply edit instructions when needed and avoid repeating those
  already present in the Copilot guide. Claude Code can receive larger
  replies within its configured output limit, and large type reads under
  VS Code use their available response budget more fully. A source line too
  wide for a response is returned whole or refused rather than cut partway.
- **Direct MCP startup is more reliable.** The `tl-mcp` entry point and
  direct `dist/bin.js` launch use the same WebAssembly memory setting as
  `tl mcp start`, preventing a startup memory failure when many servers run
  together.
- **Search results distinguish skipped work from no matches.** A regex
  search that could not run explains why. Oversize-file omissions identify
  the affected paths, and searches scoped to one file support larger files.
- **Workspace setup and reporting are clearer.** Workspace status lists
  all configured clients. Claude Code-only setup avoids creating Copilot
  instructions. Shared project configuration respects normal file creation
  permissions. Usage estimates compare the requested read ranges with
  equivalent native reads.

## Optional reply and table features

Token-based reply selection, exact-repeat folding, stable key ordering,
CSV/TSV query windows, snapshots and sparse table views are available as
opt-in settings and are off by default. See
[MCP tools](https://github.com/Takayuki-Ishimaru/tokenlighten/blob/v0.16.4/release-docs/mcp-tools.md#optional-reply-and-table-settings)
for requirements and limits.

The VS Code setting `tokenlighten.hostTokenCounter.modelFamily` is also
off by default. Enabling it passes candidate reply text to the selected
model provider's token-counting API. Review that provider's data handling
before enabling it; leaving the setting empty keeps the bridge disabled.

## Upgrade and compatibility

Install the v0.16.4 archive for your platform or the v0.16.4 VSIX. Run
`tl-setup <workspace>`, refresh with `tl workspace setup`, or use the
extension's **Set up this workspace**. Start a new agent session or
reconnect the MCP client to receive the updated guides and tool definitions.

CLI workspace refresh preserves existing per-client write permissions.
Use `--read-only` or `--allow-write` to change them explicitly. Extension
setup enables writes; a manually started server requires `--allow-write`
for edits. Non-interactive install maintenance continues to require
`--yes`; use `--dry-run` to preview it.

The three MCP tools and supported canonical top-level request fields are
unchanged from v0.16.3. Some clients advertise only commonly used fields;
the server still accepts the other supported fields. Preserve the original
request when continuing a task, follow returned `next` calls unchanged,
and follow `edit_rules` when a reply supplies them.

## Scope and limitations

CSV first-reply lookups apply to supported read-only questions naming a
CSV file within the lookup size limit. Ambiguous requests, unsupported
conditions and larger files may need searches or continued reads. Partial
table views do not represent the whole table.

Typed symbol resolution and semantic search remain optional and off by
default; compound request composition is on by default. Existing language,
format, budget and client limitations still apply. See
[Local analysis engines](https://github.com/Takayuki-Ishimaru/tokenlighten/blob/v0.16.4/release-docs/local-analysis.md)
and [MCP tools](https://github.com/Takayuki-Ishimaru/tokenlighten/blob/v0.16.4/release-docs/mcp-tools.md).

## Assets

- `tokenlighten-0.16.4-win-x64.tgz` and `tokenlighten-0.16.4-win-x64.zip`
- `tokenlighten-0.16.4-darwin-arm64.tgz`
- `tokenlighten-0.16.4-darwin-x64.tgz`
- `tokenlighten-0.16.4-linux-x64.tgz`
- `tokenlighten-vscode-extension-0.16.4.vsix`
- `SHA256SUMS` (covers every archive and the VSIX)

## Documentation and support

- [Getting started](https://github.com/Takayuki-Ishimaru/tokenlighten/blob/v0.16.4/release-docs/getting-started.md)
- [VS Code extension](https://github.com/Takayuki-Ishimaru/tokenlighten/blob/v0.16.4/release-docs/vscode-extension.md)
- [Privacy, security, and support](https://github.com/Takayuki-Ishimaru/tokenlighten/blob/v0.16.4/release-docs/privacy-security-support.md)
- [Licensing and use policy](https://github.com/Takayuki-Ishimaru/tokenlighten/blob/v0.16.4/release-docs/licensing.md)

TokenLighten is source-available. The release's `LICENSE` file defines
the terms of use. Support is provided on a best-effort basis.
