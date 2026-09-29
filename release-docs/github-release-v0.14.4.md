# TokenLighten v0.14.4

**Public Beta.** TokenLighten v0.14.4 improves ranged file reads, task
continuation, and the evidence returned for compound questions in English
and Japanese. It also reduces repeated work and memory use when exploring
large workspaces.

The same three MCP tools remain available: `read_file`, `search_files`, and
`edit_file`. The server remains read-only unless started with `--allow-write`.

## Highlights

- **Complete ranged reads across multiple files.** When a response cannot
  fit every requested line, following its returned `next` calls retrieves
  the remaining ranges for every target. A continuation no longer loses
  a file's remaining lines when the response is shortened.
- **Consistent range and budget handling.** `range`, `ranges`, and `symbol`
  select the content to read; `content:"full"` preserves that selection
  instead of widening it to the whole file. Continuations retain the
  caller's response budget. If the budget is too small, the server returns
  a refusal with a retry size.
- **Compound questions retain all their parts.** Read-only questions joined
  by conjunctions, line breaks, or lists keep their separate requirements,
  including supported Japanese phrasing. A task is ready to answer only
  when those requirements are supported by returned evidence or explicitly
  disclosed as unresolved or absent within the searched scope.
- **Answers include the evidence they depend on.** Questions about values,
  conditions, callers, and processing paths now request the relevant
  constants, call sites, and related code before the server marks the task
  ready. A mention in a README or unrelated code is not sufficient evidence.
- **More reliable Japanese and identifier matching.** Search and absence
  checks share word normalization and Japanese-to-English glossary matching.
  A question whose evidence was returned is not reported absent in the same
  response. Translation-only matches can remain undetermined; see the
  limitations below.
- **Exact source ranges and safer continuation.** Evidence bodies contain
  the source lines identified by their ranges. Re-packing a completed
  read-only task reuses its evidence while the files are unchanged. If a
  file changes during a ranged continuation, the server requests a fresh
  read instead of silently combining different versions.
- **Less repeated work in large workspaces.** File discovery, reference
  searches, and index handling avoid redundant scans. The standard MCP
  launcher uses a lower-memory WebAssembly compilation mode where supported.

## Other changes

- Updated runtime and packaging dependencies to include upstream fixes.
- Dependency, virtual-environment, and generated-cache folders such as
  `.venv`, `site-packages`, `__pycache__`, `.gradle`, `Pods`, and `DerivedData`
  are excluded from default discovery. Explicit file paths remain readable.
- Test availability is detected more accurately for monorepos and projects
  whose dependencies have not been installed.
- A nonexistent `cwd` or `--workspace` is rejected without creating a
  directory, and long repetitive questions are handled more efficiently.

## Compatibility and upgrade

- Install the v0.14.4 archive for your platform or update the VS Code
  extension with the v0.14.4 VSIX. For archive installs, re-run
  `tl-setup <workspace>` from the extracted new archive to upgrade the
  machine installation. See [Getting started](getting-started.md).
- The managed agent instructions are unchanged from v0.14.3. Workspaces
  already configured with v0.14.3 do not require a separate guide refresh
  after the runtime or extension is upgraded.
- These fixes are enabled by default. The three tools, canonical request
  fields, and read-only default remain unchanged.
- Responses add `certificate.gaps` entries for undetermined or empty
  request points and `certificate.obligations` entries for the requested
  kinds of evidence. Clients should handle these additive entries and
  include disclosed gaps when presenting an answer. See [MCP tools](mcp-tools.md).
- Workflows that read dependency or virtual-environment files should name
  those files explicitly instead of relying on default discovery.
- Legacy v0.12/v0.13 request fields remain refused by default.
  `TL_LEGACY_INPUT=accept` remains a temporary server-side migration bridge.

## Known limitations

- The improvements to compound questions and answer evidence apply to
  read-only questions. Change requests retain their existing behavior.
- Caller and value lookup uses textual matching, not full type-aware
  semantic analysis. Some unresolved forms are disclosed as undetermined: for example a call inside a
  multi-line template's `${…}`, an `import { X as y }` alias,
  `module.exports = config` or `export default Object.freeze({…})`, a Rust
  `pub use` re-export, an inline `crate::` path or inline module, a C# method
  whose body is a single switch expression, a Scala class method as the
  subject of a question, Kotlin Multiplatform `expect`/`actual`, or a getter
  that returns a nested property (`this.options.timeoutMs`).
- A PascalCase C# or Java constant that is declared outside the workspace
  and read by its bare name — inherited from a library base class, or
  brought in by `using static` from a library — may be missing from both the returned evidence and the stated gaps.
  Check external library definitions separately when the answer depends on them.
- A term matched only through the Japanese-to-English glossary can remain
  undetermined. A katakana loanword with no occurrence in the searched
  workspace can be reported absent. These disclosures do not establish an
  answer; check the returned evidence and search scope.
- Platform targets are Windows x64, macOS Apple silicon, macOS Intel, and
  Linux x64. Use the archive matching your operating system and processor.
  Managed machines may require administrator approval; see
  [Managed environments](managed-environments.md).
- On Windows, a runtime file that a running AI host still holds cannot be
  deleted immediately: an upgrade sets it aside and a later run removes it;
  an uninstall completes, names the path, and removes it in the background
  once the host is closed.
- Gemini CLI's MCP configuration only expands environment-variable
  placeholders inside the `env` block, not in `command`/`args`; a committed
  Gemini entry therefore carries an absolute, machine-specific path with a
  comment saying so, rather than a portable variable form.
- Copilot CLI's support for `${VAR}`-style placeholders is undocumented and
  is reported to have regressed between versions, so its generated entries
  also use absolute paths rather than relying on that expansion.
- The in-memory record of an executed search's own results does not survive
  a server restart; a task resumed after a restart falls back to proposing
  the search again rather than reusing a stale result.
- Extra evidence's stated relation to a named file (for example, that it
  calls or is called by it) is a lexical match on a shared declared name,
  not a resolved call graph.
- The edit gate still grants write access to any file served in the
  current lane and epoch, even one a decision marked read-only; such an
  edit applies and is marked in the response, and an opt-in strict mode
  (`TL_FRONTIER_STRICT_WRITES=1`) refuses it with a re-pack step instead.
- A Japanese noun phrase that names a concept (for example, a request to
  update a changelog by its Japanese name) does not yet resolve to the
  specific file it refers to the way the equivalent English wording does.
- Editing a file larger than 4 KiB that contains NUL bytes is refused
  safely, but with a generic write-error message rather than the read-side
  encoding wording.

## Assets

- `tokenlighten-0.14.4-win-x64.tgz` and `tokenlighten-0.14.4-win-x64.zip`
- `tokenlighten-0.14.4-darwin-arm64.tgz`
- `tokenlighten-0.14.4-darwin-x64.tgz`
- `tokenlighten-0.14.4-linux-x64.tgz`
- `tokenlighten-vscode-extension-0.14.4.vsix`
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
