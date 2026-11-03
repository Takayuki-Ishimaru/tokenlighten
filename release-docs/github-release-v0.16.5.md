# TokenLighten v0.16.5

**Public Beta.** This patch release improves focused code discovery, symbol
reads, large-workspace startup, usage estimates and workspace setup. It also
adds agent hooks and a command runner for compact test and build output.

## Improvements and fixes

- **Discovery follows the code and values you name.** Distinctive identifiers
  and quoted strings guide the first lookup toward product source. Quoted
  values match whole tokens, and named files take priority over test and
  fixture copies. Related method calls, including inherited methods in other
  files, contribute context needed to answer a question. Requests to add a
  member to an existing configuration or constant family can bring its
  definitions, readers, documentation and tests into the first reply.
- **Symbol reads preserve exact source.** A method read returns the original
  lines for its reported range. Class headers, imports and sibling signatures
  appear separately, so surrounding documentation cannot obscure the method.
  Retrying an edit that already succeeded reports where it was applied.
- **Large workspaces can respond while indexing continues.** The symbol index
  builds in the background for large workspaces. Initial discovery can use
  text search while clearly reporting incomplete index coverage. Persisted
  indexes support larger repositories and can be warmed after the MCP
  handshake. Symbol searches and edits still wait for the index they need.
- **Exploratory replies carry less speculative content.** When initial
  discovery is uncertain, candidate locations can be returned without source
  bodies; the agent can read the relevant candidate next. Updated guides use
  TokenLighten for unknown locations, multiple files, call graphs, large files
  and supported document formats, and native tools for small tasks in a file
  the user already named. Claude Code also handles low output-limit settings
  more reliably.
- **Usage summaries explain their limits.** Estimated context avoided is
  bounded by an equivalent native read and labelled as an estimated upper
  bound. Negative totals remain visible. These figures are not provider
  billing records and do not establish session cost savings.
- **Setup follows detected clients.** Archive setup creates workspace files
  for the clients it detects, with an explicit client selection available.
  Default Claude Code workspace configuration avoids embedding a machine
  path, and setup identifies generated files that can be shared.

## Agent hooks and command output

Setup installs TokenLighten hooks for the clients it configures: Claude Code,
Codex and GitHub Copilot. Existing user hook entries are preserved. Use
`--no-hooks` to leave hook configuration unchanged, or `--remove-hooks` to
remove TokenLighten's entries. Hooks run subject to the client's trust and
hook settings; setup does not grant trust.

For supported test and build commands, Claude Code and Copilot hooks can
shorten the output shown to the agent after the command runs. The command
and its permission checks are unchanged. The full output is saved locally
under `.tokenlighten/.runtime/run/`; summaries retain failure details and the
runner's summary within the available output budget. Review logs before
sharing them because they can contain command output and workspace paths.

Claude Code's automatic output shortening applies to successful commands;
its failure hook cannot replace output. Copilot can also shorten failed
command results. Host support varies, and the original output remains when
replacement is unavailable. Codex has no automatic output replacement.
Use `tl run -- <command>` directly with any client, including for failed
commands on Claude Code.

Compaction and session-reset hooks let the MCP server resend context that
the agent may no longer hold. See [Agent hooks](https://github.com/Takayuki-Ishimaru/tokenlighten/blob/v0.16.5/release-docs/getting-started.md#agent-hooks)
for client behavior, trust requirements and setup options.

## Upgrade and compatibility

Install the v0.16.5 archive for your platform or the v0.16.5 VSIX. Refresh
workspace setup with `tl-setup <workspace>`, `tl workspace setup`, or the
extension's **Set up this workspace**, then start a new agent session or
reconnect your MCP client. Setup refresh is needed to adopt the updated
guides and hooks. Review hook settings before refreshing if you prefer to
opt out.

CLI workspace refresh preserves existing per-client write permissions.
Use `--read-only` or `--allow-write` to change them explicitly. Extension
setup enables writes; a manually started server requires `--allow-write`
for edits. Non-interactive install maintenance continues to require `--yes`;
use `--dry-run` to preview it.

The three MCP tools and supported canonical top-level request fields are
unchanged from v0.16.4. Follow returned `next` calls and any supplied
`edit_rules`. Partial discovery coverage is not proof of absence; follow
the returned continuation when more evidence is needed.

Optional typed resolution, semantic search, reply selection and table-view
settings remain off by default. The optional VS Code model token counter is
also off by default; when configured, candidate reply text reaches the
selected provider's counting API. Existing language, format, budget and
client limitations still apply. See [MCP tools](https://github.com/Takayuki-Ishimaru/tokenlighten/blob/v0.16.5/release-docs/mcp-tools.md)
and [Privacy, security, and support](https://github.com/Takayuki-Ishimaru/tokenlighten/blob/v0.16.5/release-docs/privacy-security-support.md).

## Assets

- `tokenlighten-0.16.5-win-x64.tgz` and `tokenlighten-0.16.5-win-x64.zip`
- `tokenlighten-0.16.5-darwin-arm64.tgz`
- `tokenlighten-0.16.5-darwin-x64.tgz`
- `tokenlighten-0.16.5-linux-x64.tgz`
- `tokenlighten-vscode-extension-0.16.5.vsix`
- `SHA256SUMS` (covers every archive and the VSIX)

## Documentation and support

- [Getting started](https://github.com/Takayuki-Ishimaru/tokenlighten/blob/v0.16.5/release-docs/getting-started.md)
- [VS Code extension](https://github.com/Takayuki-Ishimaru/tokenlighten/blob/v0.16.5/release-docs/vscode-extension.md)
- [Licensing and use policy](https://github.com/Takayuki-Ishimaru/tokenlighten/blob/v0.16.5/release-docs/licensing.md)

TokenLighten is source-available. The release's `LICENSE` file defines the
terms of use. Support is provided on a best-effort basis.
