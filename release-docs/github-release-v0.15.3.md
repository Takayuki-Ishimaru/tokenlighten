# TokenLighten v0.15.3

**Public Beta.** This maintenance release improves compound code questions,
source ranges and continuation, and line-range editing. Workspace setup
now lets you choose write permission explicitly.

The three MCP tools remain `tl_read_file`, `tl_search_files`, and
`tl_edit_file`.

## Read and search improvements

- **Return values and computation order stay together.** Questions that
  combine a call's return value with its computation order retain both
  requirements and request the relevant helper implementations.
- **Japanese explanation questions remain read-only.** Functions named
  `add` or similar English edit verbs can be explained without the name
  being mistaken for an instruction to edit. Explicit change requests
  still take precedence.
- **Symbol source lines stay accurate.** Symbol bodies use their original
  source line numbers. Supplementary scope headers and signatures appear
  in `note`, outside the source body.
- **Budgeted reads continue through the requested lines.** Symbol and
  multi-target reads preserve the unserved ranges through continuation.
  Follow each returned `next` unchanged.
- **Search budget advice is optional.** A text-search page may suggest a
  larger byte budget for the remaining results when that advice fits.
  The suggestion is an estimate; it does not change the current budget,
  remove results from the page, or widen the executable continuation.

## Editing fix

Line-range replacements preserve the newline before an untouched following
line even when the replacement text omits its final newline. This applies
to LF, CRLF and CR files.

## Workspace write permissions

`tl workspace setup` enables writes in its generated MCP settings by
default. Use `--read-only` to omit `--allow-write` for every selected
client, or `--allow-write` to select writes explicitly. The two flags
cannot be combined. Setup reports the choice in text and JSON output;
`--rules-only` leaves MCP settings untouched.

A manually started MCP server remains read-only unless passed
`--allow-write`. The VS Code extension's **Set up this workspace** enables
writes. To generate read-only settings, use the CLI's
`tl workspace setup --read-only`; re-running the extension's setup enables
writes again.

## Upgrade

Install the v0.15.3 archive for your platform or the v0.15.3 VSIX. Run
`tl-setup <workspace>` from the new archive, or re-run `tl workspace setup`
or the extension's **Set up this workspace**. Start a new agent session or
reconnect your MCP client to load the updated server.

For read-only archive setup, use `tl-setup --read-only <workspace>`.
When refreshing CLI workspace settings, pass
`tl workspace setup --read-only` again to keep them read-only.

The canonical request fields, tool names and compact guide default are
unchanged from v0.15.2. See [Getting started](https://github.com/Takayuki-Ishimaru/tokenlighten/blob/v0.15.3/release-docs/getting-started.md)
for setup, refresh, rollback and uninstall.

## Known limitations

- Savings depend on the task, client, model and caching. No new savings
  percentage is claimed for v0.15.3. The README comparisons describe
  v0.15.0 observations.
- Some questions and large reads need continuation before all evidence is
  returned. Preserve disclosed unresolved points.
- Import and caller lookup uses supported syntax and textual relationships,
  rather than full type-aware analysis. External library definitions may
  need separate verification.
- Existing read, edit-window, budget and client limitations remain; see
  [MCP tools](https://github.com/Takayuki-Ishimaru/tokenlighten/blob/v0.15.3/release-docs/mcp-tools.md).

## Assets

- `tokenlighten-0.15.3-win-x64.tgz` and `tokenlighten-0.15.3-win-x64.zip`
- `tokenlighten-0.15.3-darwin-arm64.tgz`
- `tokenlighten-0.15.3-darwin-x64.tgz`
- `tokenlighten-0.15.3-linux-x64.tgz`
- `tokenlighten-vscode-extension-0.15.3.vsix`
- `SHA256SUMS` (covers every archive and the VSIX)

## Documentation and support

- [Getting started](https://github.com/Takayuki-Ishimaru/tokenlighten/blob/v0.15.3/release-docs/getting-started.md)
- [Managed environments](https://github.com/Takayuki-Ishimaru/tokenlighten/blob/v0.15.3/release-docs/managed-environments.md)
- [MCP tools](https://github.com/Takayuki-Ishimaru/tokenlighten/blob/v0.15.3/release-docs/mcp-tools.md)
- [VS Code extension](https://github.com/Takayuki-Ishimaru/tokenlighten/blob/v0.15.3/release-docs/vscode-extension.md)
- [Privacy, security, and support](https://github.com/Takayuki-Ishimaru/tokenlighten/blob/v0.15.3/release-docs/privacy-security-support.md)
- [Licensing and use policy](https://github.com/Takayuki-Ishimaru/tokenlighten/blob/v0.15.3/release-docs/licensing.md)

TokenLighten is source-available. The release's `LICENSE` file defines the
terms of use. Support is provided on a best-effort basis.
