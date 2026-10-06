# TokenLighten v0.15.1

**Public Beta.** This maintenance release improves the evidence returned for
code explanations and calculations, keeps task-pack reads inside the
workspace, and makes retried edits show their recorded result.

The three MCP tools remain `tl_read_file`, `tl_search_files`, and
`tl_edit_file`. The server is read-only unless started with `--allow-write`.

## Fixes

- **Calculations include the constants they need.** When an answer pack
  returns a complete function relevant to your question, it also follows
  the constants that function reads through imports, aliases and re-exports.
  For example, a question asking to calculate an invoice amount includes
  the imported tax rate. Missing evidence is requested through a continuation
  or disclosed as unresolved. Questions that only locate code or ask about
  relationships do not gather these additional values.
- **An explicitly named function takes precedence over similar names.**
  A question about “the retry function” or “retry 関数” selects `retry`
  rather than `retryDelay`. Evidence selection also uses whole identifiers
  so a similar name cannot stand in for the requested one.
- **Caller questions cover each named subject.** When you ask for the
  callers of two functions, both remain part of the request. Call sites in
  the same file are included, and evidence still owed is requested before
  the answer is marked ready.
- **Explanation wording is not treated as missing code.** Phrases such as
  “edge cases” and 「金額」 describe what to explain instead of becoming false
  “not found” reports. A comma between a function's arguments no longer
  splits the question into separate topics.
- **Task-pack evidence stays inside the workspace.** An import or symlink
  leading outside the workspace is not read by task-pack discovery. A value
  that depends on such a file is disclosed as unresolved.
- **Retrying an edit shows its recorded result.** Reusing an `operation_id`
  returns the saved post-edit text without applying the mutation again.
  `current` indicates whether the files still match that result; if they
  changed, a returned `next` reads their current contents. The saved window
  describes the original edit, not later changes. Older recorded outcomes
  retain their earlier replay format.

- Updated runtime and build dependencies to include upstream fixes. The
  document-conversion command uses a newer argument parser without the
  affected formatting dependency.

## Upgrade

Install the v0.15.1 archive for your platform or the v0.15.1 VSIX. For an
archive installation, run `tl-setup <workspace>` from the new archive.
Re-run `tl workspace setup` or the extension's **Set up this workspace**,
then start a new agent session or reconnect your MCP client.

The canonical request fields and three tool names are unchanged from
v0.15.0. Custom clients should accept the additional edit-replay fields and
follow a returned `next` when they need current file contents.

## Known limitations

- A question with multiple subjects can require a continuation before all
  evidence is returned. Follow the server's `next`.
- The server does not infer every semantically related value. A limit used
  only by code that was not returned may need a separate question naming
  that code or value.
- Import and caller lookup still uses supported syntax and textual
  relationships, rather than a full type-aware analysis. External library
  definitions may need to be checked separately.
- Existing read, edit-window, budget and client limitations remain; see
  [MCP tools](mcp-tools.md) and the [v0.15.0 release notes](github-release-v0.15.0.md).
- Savings depend on the task, client, model and caching. The README's
  comparisons describe v0.15.0 observations; they are not new measurements
  of v0.15.1.

## Assets

- `tokenlighten-0.15.1-win-x64.tgz` and `tokenlighten-0.15.1-win-x64.zip`
- `tokenlighten-0.15.1-darwin-arm64.tgz`
- `tokenlighten-0.15.1-darwin-x64.tgz`
- `tokenlighten-0.15.1-linux-x64.tgz`
- `tokenlighten-vscode-extension-0.15.1.vsix`
- `SHA256SUMS` (covers every archive and the VSIX)

## Documentation and support

- [Getting started](getting-started.md)
- [Managed environments](managed-environments.md)
- [MCP tools](mcp-tools.md)
- [VS Code extension](vscode-extension.md)
- [Privacy, security, and support](privacy-security-support.md)
- [Licensing and use policy](licensing.md)

TokenLighten is source-available. The release's `LICENSE` file defines the
terms of use. Support is provided on a best-effort basis.
