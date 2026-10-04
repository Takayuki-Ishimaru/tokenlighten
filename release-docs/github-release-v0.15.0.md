# TokenLighten v0.15.0

**Public Beta.** TokenLighten v0.15.0 makes answers to read-only questions
more dependable and reduces repeated source discovery and reading. Savings depend on the task, client, and model. A value that reaches a
function through an alias, a re-export or a rename is returned or disclosed;
an answer is marked ready only when the evidence it depends on was actually
sent; an edit returns the text it produced so that a confirming read is not
needed; budgeted reads and searches fill their pages; and the tool
definition advertised to every client is smaller.

Three MCP tools are available: `tl_read_file`, `tl_search_files`, and
`tl_edit_file`. The server remains read-only unless started with `--allow-write`.

## Highlights

- **Values behind aliases, re-exports, and renames are returned.** A
  question about a default value or a condition now follows the constant
  through `import { A as B }`, `export { A as B } from`, CommonJS
  destructuring renames, Python `from m import A as B`, Kotlin and Scala
  member imports with `as`, Rust `use … as`, and Go package constants. A
  chain that cannot be followed is disclosed as undetermined instead of the
  answer being marked ready without the value.
- **A file path in the question no longer drops a constant.** Naming a file
  in a question focuses the answer on it; the constants and dependencies its
  code reads are still returned.
- **A ready answer is backed by evidence that reached you.** After every step
  that can shorten or reshape a response, including a byte ceiling such as
  VS Code's, the server checks that requirements the answer claims are
  supported by a body in that response or a range already served in the
  task. If it is not, the response asks for the missing range or discloses
  the point instead of claiming readiness.
- **Explanatory words are not reported as "not found".** Only the subject of
  a clause — an identifier, a quoted string, a term you asked to check for,
  or the main noun of a clause — can be reported absent. Words that describe
  the kind of information you asked for, such as conditions, callers, or
  values, are never reported absent. A second topic joined by "and" or 「と」
  is kept as its own point, and a katakana term the server cannot map is
  disclosed as undetermined.
- **Same-name functions are told apart.** When several files declare the same
  name, the server uses your file path, then the import relationship, to pick
  the declaration; if nothing decides, it returns every declaration and says
  so. An "Explain X" question is not answered from X's call sites alone.
- **Edits return the text they produced.** A successful edit includes, for
  each edited file, the verbatim text around the change
  (`applied[].after`: the changed lines with three lines of context), so a
  confirming read is usually unnecessary. A later read of those lines answers
  with a receipt naming the edit. Under a host size limit the window is
  shortened first and `remaining` names anything not shown. The edit's
  verification kit names the tests and mocks to read by handle, in one
  batched call, instead of inlining them.
- **Near-miss requests are served.** A one-element `ranges` in a
  multi-target read, a package-qualified name such as `pkg.Func` for
  `references`, or a directory given to `tl_read_file` used to be refused with a
  one-step fix; it is now served, with a `normalized` note naming the
  rewrite.
- **Budgeted reads fill their pages.** With a declared `budget` (or a host
  limit), a read that fits is returned whole and a longer one is returned in
  pages that fill the budget, so it takes fewer follow-up calls and still
  delivers every requested line once.
- **Search pages fit your client's limit.** `tl_search_files` `find` results
  are sized to the response limit your client or your `budget` allows, so a
  small result no longer takes two calls.
- **A smaller tool definition for every client.** The advertised tool schema
  no longer lists the mutually exclusive request shapes and one field
  dependency; the server still enforces them on every call. VS Code already
  used a leaner definition.

## Other changes

- A continuation of a read whose file changed keeps your budget, and a
  refusal's `next` never repeats the call that was refused.
- A read of several targets never silently drops one, and a chain that runs
  out of new candidates ends with the open point disclosed instead of
  cycling.
- Resuming a completed task after a file changed outside the session
  recomputes the changed value.
- Type names that end in digits (`u64`, `int8_t`, `Float64`) are no longer
  mistaken for numeric literals.
- Small search results can include complete file bodies, avoiding a separate
  read when those bodies already cover the request.
- Questions that name a project nested inside a larger workspace use that
  project's scope, while continuation retains the original request.
- Updated runtime dependencies to include upstream fixes. The VSIX packaging
  tool is updated; packaging a VSIX from source requires Node.js 22 or later.
  Installing a release archive or VSIX still needs no separate Node.js install.

## Indicative savings

In a Sonnet comparison, total task cost was 33.7% lower across the 11 pairs
with verified outcomes in both configurations and complete billing records,
calculated from recorded usage and token prices. Unfinished tasks and trials
with incomplete records are excluded; task-level samples are small. See the
[README comparison](../README.md#indicative-savings-v0150) for the task results
and limitations.

## GitHub Copilot and shared agent guides

- The tools now use the `tl_` prefix to distinguish them from built-in editor
  tools. Refresh the MCP tool list after upgrading.
- VS Code setup writes a short, self-contained Copilot guide. It preserves
  your instructions and settings, and avoids attaching duplicate
  TokenLighten-only guides when it can safely do so.
- Normal Copilot **Agent** chats can use TokenLighten directly. The optional
  **tokenlighten-explore** agent remains available for read-only work.
- VS Code workspace setup adds a SessionStart hook that tells a new local
  Agent chat to send the complete request to `tl_read_file` and reuse returned
  source. It requires a trusted workspace, `chat.useHooks` enabled, and `node`
  on PATH. Setup preserves existing hooks and user edits; it does not change
  tool permissions. To keep the existing hook configuration, use
  `tl workspace setup --clients vscode --copilot-session-context keep`.
- Codex and Claude Code receive the same full-request discovery and
  served-source reuse instructions through their managed workspace guides.
- Copilot's advertised tool definition is smaller while continuing to accept
  the server's recovery and continuation calls. Disabling TokenLighten or
  switching to the native profile also disables its managed Copilot guidance.

In a small comparison using normal Copilot Agent chats, code-reading and
explanation tasks with GPT-6 Luna used 9.8–11.9% fewer billed credits on
average. MAI results varied with cache conditions; short reading tasks took
two model round trips instead of three or four. These are limited observations,
not guaranteed savings. See the [README comparison](../README.md#indicative-savings-v0150)
for the tasks, sample sizes, and caveats.

## Compatibility and upgrade

- Install the v0.15.0 archive for your platform or update the VS Code
  extension with the v0.15.0 VSIX. For archive installs, re-run
  `tl-setup <workspace>` from the extracted new archive to upgrade the
  machine installation. See [Getting started](getting-started.md).
- Re-run `tl workspace setup` or the extension's **Set up this workspace**
  after upgrading, then start a new agent session or reconnect the MCP client.
  Installing a new binary alone does not refresh the workspace guides,
  Copilot configuration, or cached tool definitions.
- Custom clients must call `tl_read_file`, `tl_search_files`, and
  `tl_edit_file`. The previous unprefixed tool names are refused with a
  message naming the replacement; `TL_LEGACY_INPUT=accept` does not restore
  those tool names.
- These changes are enabled by default. `TL_LEAN_SCHEMA=0` restores the
  previous advertised tool definition, `TL_FIND_WIDE_PAGE=0` the previous
  find page size, `TL_EFF_SLIM_EDIT=0` the wider post-edit window and inline
  kit bodies, and `TL_EFF_TOLERANT_INPUT=0` the near-miss refusals. Canonical request fields and the read-only default remain unchanged.
- Responses add `applied[].after` to `edit.applied` and a
  `request-item-undetermined` entry to `decision.gaps`. Clients that ignore
  unknown members are unaffected; clients should include disclosed gaps when
  presenting an answer. See [MCP tools](mcp-tools.md).
- Legacy v0.12/v0.13 request fields remain refused by default.
  `TL_LEGACY_INPUT=accept` remains a temporary server-side migration bridge.

## Known limitations

- **Questions and answers.**
  - A Japanese question that joins two topics with 「と」 and no comma is
    treated as one point, so its second topic can go unaddressed; the
    response does not claim that it was covered.
  - A question about the conditions of a function longer than about 80 lines
    whose name is a single lowercase word can be marked ready with only part
    of the function body; `remaining` names the rest.
  - "What does it return" is supported by evidence from the right file, not
    necessarily by the exact return statements.
  - If you pass call-site files as `targets` for an "Explain X" question and
    X has a single declaration, the answer can still be marked ready from
    those call sites. Name the declaring file too.
  - When an unrelated function with the same name exists and nothing says
    which one you mean, the response discloses the ambiguity and returns both
    bodies, but not the constants they read. Ask again naming the file.
  - A katakana loanword with no known English spelling is reported as
    undetermined.
- **Values and constants.**
  - A Go constant that exists only in a file the scan skips (larger than
    1 MB, generated `*.pb.*` files, or ignored files) can be reported empty,
    and a deeply nested package-qualified Go constant is disclosed rather
    than returned.
  - A single-character constant name or alias is not followed.
  - `import { default as x }` and `require('./x').default` are disclosed as
    unresolved.
  - A misspelled name is not corrected in the absence disclosure, and a
    symbol search for an absent name returns near matches.
  - Caller and value lookup uses textual matching, not full type-aware
    analysis. Some forms are disclosed as undetermined, for example a call
    inside a multi-line template's `${…}`, `module.exports = config` or
    `export default Object.freeze({…})`, a Rust `pub use` re-export, an
    inline `crate::` path or inline module, a C# method whose body is a
    single switch expression, a Scala class method as the subject of a
    question, Kotlin Multiplatform `expect`/`actual`, or a getter that
    returns a nested property (`this.options.timeoutMs`).
  - A PascalCase C# or Java constant that is declared outside the workspace
    and read by its bare name — inherited from a library base class, or
    brought in by `using static` from a library — may be missing from both
    the returned evidence and the stated gaps. Check external library
    definitions separately when the answer depends on them.
- **Edits.** Under a host size limit, the post-edit window is cut from its
  tail, so an edited line can fall outside it; `remaining` names the unshown
  lines. A change that only deletes lines is not named.
- **Reads and budgets.** Very long functions read under a small budget take
  many follow-up calls. A continuation the server builds without a budget of
  yours can exceed VS Code's response limit. A `content:"auto"` read of a
  whole file of 300 or more lines at a 6,144-byte budget is refused as
  `cap-exceeded` without a `next`; use `content:"full"`.
- **Tool schema.** The `scope` parameter is advertised without
  `"type":"object"`; a JSON-string `scope` is accepted.
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

- `tokenlighten-0.15.0-win-x64.tgz` and `tokenlighten-0.15.0-win-x64.zip`
- `tokenlighten-0.15.0-darwin-arm64.tgz`
- `tokenlighten-0.15.0-darwin-x64.tgz`
- `tokenlighten-0.15.0-linux-x64.tgz`
- `tokenlighten-vscode-extension-0.15.0.vsix`
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
