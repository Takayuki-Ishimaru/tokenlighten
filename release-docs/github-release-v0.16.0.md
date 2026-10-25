# TokenLighten v0.16.0

**Public Beta.** This release improves discovery, follow-up reads and edit
context, and introduces configurable local analysis engines. The three MCP
tools remain `tl_read_file`, `tl_search_files`, and `tl_edit_file`.

## Local analysis engines

- **Typed symbol resolution (optional, off by default).** TypeScript and
  JavaScript use the built-in compiler integration. Other supported
  languages use separately installed language servers that you configure
  explicitly, or opt into discovering on PATH.
- **Compound request composition (on by default).** Requests with several
  requirements can be decomposed and combined while retaining their
  individual obligations.
- **Local multilingual semantic search (optional, off by default).**
  Download the pinned multilingual E5 model explicitly, then use it to
  supplement candidate discovery on the local CPU. Queries and repository
  content stay on your computer during this processing. Model weights are
  not included in the archives or VSIX. Long source lines are split without
  dropping text, and separate relevant regions of one file can be retained
  and combined within source and model limits.

Use `tl engines status`, `tl engines --help`, or VS Code's
**TokenLighten: Manage Local Analysis Engines** command to inspect and configure these
features. `tl models install` downloads the model and enables semantic
search after a successful installation. Reconnect MCP clients after
changing engine settings. See [Local analysis engines](https://github.com/Takayuki-Ishimaru/tokenlighten/blob/v0.16.0/release-docs/local-analysis.md)
for defaults, commands, prerequisites and limitations.

## Discovery and source reads

- Named members, including qualified calls and Go receiver methods, are
  located more reliably. Questions that request an answer without changes
  remain read-only.
- Change requests retain every listed target and treat explicitly protected
  files as review context. Relevant declarations and existing code that
  consumes workspace artifacts accompany the edit target.
- Follow-up reads return requested ranges that have not been delivered.
  Repeated reads acknowledge only source actually returned, including the
  requested comment view. Mixed handle/path batches and per-target
  `ranges[]` are supported.
- Required follow-up reads can reuse exact source bytes already delivered in
  the same task, including through narrower ranges or recovered handles.
  Changed files and new bytes are served; `task.force_serve:true` remains
  available to request a resend.
- Partially overlapping reads reuse previously delivered source before
  budget trimming, reducing repeated content in continuation.
- Long bounded read continuations keep their query and selected ranges in
  the local server. Clients follow a short reference instead of repeating
  the full arguments.
- Brief questions about large types can return a structure map with member
  signatures and relevant statements, with the remaining bodies available
  through follow-up reads.
- Compatible discovery follow-ups can be completed within one bounded
  response. Smaller required windows can share a response even when an
  earlier large window needs continuation; separate ranges retain their
  original source coordinates. Requests containing separate workflow or
  report instructions keep their code requirements as the focus.

## Search, editing and client workflow

- Text search accepts up to ten literal queries by default. Matching lines
  remain available when snippet output is limited, and a changed search
  scope receives an executable restart call.
- Claude Code, GitHub Copilot CLI and Codex CLI receive compact portable
  tool descriptions by default. Claude Code and Codex CLI also receive
  line-numbered answer content by default. For Copilot CLI, an answer body
  that is an exact contiguous source slice is sent without line-number
  prefixes (its line range is given with it); other answer bodies stay
  numbered. `TL_ANSWER_LINE_GUTTER` overrides this.
- Successful edit replies can omit replacement text the caller already
  supplied and verification entries already delivered. Ready task packs
  avoid repeating an identical verification command. Go verification
  guidance uses the detected module and its working directory consistently
  before and after an edit. Verification instructions explicitly name the
  test command and working directory. The supplied verification kit can
  be used without retrieving it again; required follow-up reads and
  recipe gaps still take precedence. Managed guides direct clients to
  repair unfinished requested work exposed by related test failures and
  report unrelated or pre-existing failures.
- For Go returned-value edits, the first response can include bounded literal
  call, later-assignment and return lines for review when their source
  relationship is established and the context fits.
- Failed edits preserve the failed item and nearby current source. A
  complete diagnostic can support a corrected retry without another read.
  Exact matching and atomic validation remain required.
- Read/search follow-ups can recover a uniquely identifiable long shortened
  task handle within the same workspace and lane. Edit authentication stays
  strict. Copilot CLI uses a smaller default limit for task packs and batched
  reads; large requests may continue across pages.
- New Copilot CLI registrations and snippets set `deferTools: "never"` so
  TokenLighten's three tools remain loaded. Refreshing a managed entry
  preserves an existing explicit `"auto"` or `"never"` setting.
- C/C++ edits without a detected build system can receive syntax-check
  commands when a compiler is available. Python verification guidance
  identifies interpreter requirements.
- CLI workspace refresh preserves existing write permission for each
  client. First setup remains write-enabled by default; `--read-only`
  and `--allow-write` explicitly override the choice.
- After a VS Code extension update, a prompt can offer to reset
  TokenLighten user settings that differ from the new defaults.
  Workspace and folder settings are preserved. An unanswered prompt is
  offered again at the next startup; `tokenlighten.confirmResetOnUpdate`
  controls it.

## Runtime and dependencies

Platform install archives include Node.js 24.22.1. Runtime dependencies
have been updated to upstream patched releases, with refreshed bundled
license notices.

## Upgrade

Install the v0.16.0 archive for your platform or the v0.16.0 VSIX. Run
`tl-setup <workspace>` from the new archive, refresh with
`tl workspace setup`, or use the extension's **Set up this workspace**.
Start a new agent session or reconnect the MCP client.

CLI workspace refresh preserves existing per-client write permissions.
Use `tl workspace setup --read-only` or `--allow-write` to change them
explicitly. The extension's setup enables writes. A manually started
server requires `--allow-write` for edits.

Tool names and canonical top-level request fields are unchanged from
v0.15.3. Refresh managed guides during setup and follow each returned
`next` call unchanged.

## Indicative savings

A 20 October 2026 comparison in Claude Code, using a v0.16.0 prerelease
candidate at default settings and the same Sonnet 5 model, found **37.8%
lower total task cost** across 12 pairs with verified outcomes and complete
usage records. Six of 18 attempted pairs lacked complete usage records.
A separate conservative estimate retained 16 pairs and found 35.2% lower
cost; it is distinct from the complete-record result.

This prerelease comparison was not remeasured after subsequent fixes.
Results depend on task, client, model and caching. Task-cost changes
are not token-count reductions. See [Indicative savings](https://github.com/Takayuki-Ishimaru/tokenlighten/blob/v0.16.0/README.md#indicative-savings-v0160)
for task-level results, exclusions, estimation methods and limitations.

## Known limitations

- Optional language-server resolution depends on the installed server and
  workspace configuration. It does not make lexical rename or edit
  operations fully type-aware.
- Semantic search supplements candidate discovery; similarity is not
  proof that an answer is complete or a symbol is absent. Missing model
  files or unavailable backends leave the optional engine unavailable.
- Large reads and compound questions may need continuation. Preserve
  disclosed unresolved points.
- Savings depend on the task, client, model and caching. The v0.16.0 figures
  describe a prerelease comparison with limited samples.
- Existing format, budget and client limitations apply; see
  [MCP tools](https://github.com/Takayuki-Ishimaru/tokenlighten/blob/v0.16.0/release-docs/mcp-tools.md).

## Assets

- `tokenlighten-0.16.0-win-x64.tgz` and `tokenlighten-0.16.0-win-x64.zip`
- `tokenlighten-0.16.0-darwin-arm64.tgz`
- `tokenlighten-0.16.0-darwin-x64.tgz`
- `tokenlighten-0.16.0-linux-x64.tgz`
- `tokenlighten-vscode-extension-0.16.0.vsix`
- `SHA256SUMS` (covers every archive and the VSIX)

## Documentation and support

- [Getting started](https://github.com/Takayuki-Ishimaru/tokenlighten/blob/v0.16.0/release-docs/getting-started.md)
- [Local analysis engines](https://github.com/Takayuki-Ishimaru/tokenlighten/blob/v0.16.0/release-docs/local-analysis.md)
- [Managed environments](https://github.com/Takayuki-Ishimaru/tokenlighten/blob/v0.16.0/release-docs/managed-environments.md)
- [VS Code extension](https://github.com/Takayuki-Ishimaru/tokenlighten/blob/v0.16.0/release-docs/vscode-extension.md)
- [Privacy, security, and support](https://github.com/Takayuki-Ishimaru/tokenlighten/blob/v0.16.0/release-docs/privacy-security-support.md)
- [Licensing and use policy](https://github.com/Takayuki-Ishimaru/tokenlighten/blob/v0.16.0/release-docs/licensing.md)

TokenLighten is source-available. The release's `LICENSE` file defines the
terms of use. Support is provided on a best-effort basis.
