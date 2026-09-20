# TokenLighten v0.14.3

**Public Beta install update.** TokenLighten v0.14.3 adds an install path
that needs no editor extension and no separate Node.js install: download one
archive for your OS, run one command, and every AI-agent host TokenLighten
detects on the machine — including GitHub Copilot Chat in VS Code — can use
it. It keeps the same three MCP tools: `read_file`, `search_files`, and
`edit_file`. The server remains read-only unless started with
`--allow-write`.

## Highlights

- **One archive, one command.** Download a platform archive, verify it
  against the published `SHA256SUMS`, extract it, and run `./tl-setup
  /path/to/workspace` (macOS/Linux) or `tl-setup C:\path\to\workspace`
  (Windows). Each archive bundles its own Node.js runtime; nothing else is
  installed system-wide. Re-running `tl-setup` with a newer archive upgrades
  in place.
- **`tl install` under the hood.** The new `tl install` CLI subcommand
  plans and confirms in one step, stages the runtime and CLI, registers
  detected hosts, sets up any given workspace(s), and verifies the result
  with a real MCP handshake before reporting success. `tl install --use
  <version>` rolls back to a previously staged version; `tl install
  --uninstall` removes the machine install and TokenLighten-managed host
  registrations (foreign entries stay, and are reported); for every
  workspace this machine install set up, it also removes TokenLighten's
  managed guide blocks and managed MCP entries, leaving your own content
  and other servers' entries untouched.
- **Two more hosts register directly.** Gemini CLI and Copilot CLI join
  Claude Code and Codex as hosts `tl install`/`tl clients` can register
  without a manual copy-paste step. `tl clients snippet` prints a pasteable
  entry (plus a one-line add command where a vendor CLI exists) for any
  detected host that cannot be written directly.
- **One enabled TokenLighten server per VS Code workspace.** The
  extension's own MCP provider now steps aside once a workspace has been
  set up: previously it added a further same-label `tokenlighten`
  definition on top of the workspace files, and VS Code's default collision
  handling silently disabled all but one without saying why. VS Code starts
  the entry in `.vscode/mcp.json`; it still lists the copy in the root
  `.mcp.json` (written for Claude Code) and marks it disabled as a
  duplicate. A workspace that has never been set up gets a
  provider-supplied fallback definition only when this machine already has
  a `tl-setup`/`tl install` machine install; installing the extension by
  itself, with no machine install anywhere, offers no definition and
  starts no server.
- **`tl doctor` gains `install_consistency`.** It reports the machine
  install's version against the VS Code extension's bundled version and any
  `tl` found on `PATH`, whether the managed launcher still resolves to a
  live runtime, and duplicate or stale-identity host/workspace entries. When
  no machine install exists yet, this check is informational (not a
  warning) — the entire VSIX-only population has no machine install to
  compare against.
- **One fallback order for both shims.** The human-facing `tl`/`tl.cmd`
  launcher now tries the same runtime-first order on macOS/Linux and
  Windows.
- **macOS quarantine cleared on the copied runtime.** `tl install` clears
  the `com.apple.quarantine` attribute on the copy of the Node.js runtime it
  stages under `<home>` (its own copied payload only, never a system-wide
  change), so a runtime extracted by a quarantine-stamping tool (for
  example, Archive Utility on a browser-downloaded archive) is not blocked
  by Gatekeeper on first launch.
- **Task-pack continuation fixes.** A `qref` or `task.handle` re-pack against
  an unchanged workspace no longer re-presents an already-executed search,
  drops an already-served create decision, or resends a body it already
  returned. A verified absence for a search the pack itself proposed now
  closes the task instead of leaving it stuck waiting.
- **More accurate evidence selection.** A request naming two or more
  independent file-and-change pairs — in English or Japanese — reaches an edit decision with one obligation per change
  instead of an unnecessary candidate choice, and an "either this file or
  that one" alternative is never marked writable on its own. A Japanese
  request's trailing particle or verb ending is no longer disclosed as a
  missing item, and a question that names its target files explicitly (up
  to three) gets each of them served as its own evidence item, with any
  additional evidence requiring a stated relation to one of them. A file
  the request names by path that the server cannot read, or cannot decode
  as text, is now disclosed as such instead of being answered from
  unrelated evidence in its place.
- **Safer, more consistent file decoding.** Every file body a response can
  carry now goes through one decoding policy, applied the same way at every
  route: valid text is served as-is, a file with a few incidental NUL bytes
  is served with them stripped and the strip is always stated, and a file
  that is not valid UTF-8, or is mostly NUL, is disclosed instead of being
  served or used as evidence. A located declaration in a file type the
  server has no comment-syntax support for is now served, with a note that
  the identifier is unverified, instead of being silently discarded.
- **More precise edit targeting.** A request that both asks about one file
  and asks to change another now keeps the explain-only file read-only and
  makes only the real edit target writable, across several common ways of
  phrasing the same two-part request, in English and Japanese. An edit
  decision's writable list no longer includes a file that was only a loose
  keyword match, or a file whose content needed NUL bytes stripped before
  it could be served.
- **Windows compatibility.** Reading ZIP, TAR, TAR.GZ, 7Z, and RAR archives
  no longer hangs until it times out on Windows. Command-line client
  registration and bundled runtime handling also work from archives
  extracted with Explorer.
- **More useful first responses.** Read-only requests that ask several
  things at once can find evidence for each point, including when the call
  names files explicitly. Japanese questions against English codebases can
  retry with English search terms derived from the request. Named types and
  members lead to their relevant declarations instead of an unrelated file
  heading. `TL_CONCERN_RECOVERY=0` and `TL_JA_QUERY_BRIDGE=0` disable the
  corresponding recovery features.
- **Reliable task continuity.** A read-only task stays read-only when a
  continuation omits `task.profile`. On `read_file` and `search_files`, a
  malformed task handle can recover the caller's own live task when there
  is exactly one matching candidate in the same workspace and lane.
  `edit_file` remains strict; `TL_TASK_HANDLE_RECOVERY=0` disables recovery.
- **Updated GitHub Copilot integration in VS Code.** Workspace setup keeps
  larger tool results inline, replaces duplicate Copilot instructions with
  a short reference to the shared guide, and adds a read-only exploration
  agent restricted to TokenLighten's tools. Named files and relevant ranges
  are returned more fully, code evidence includes line numbers, and
  host-specific tool definitions and follow-up calls are shorter. These
  serving changes are enabled for VS Code by setup (`TL_TURN_ECONOMY=1`);
  other hosts keep their existing defaults. To keep the current inline
  result setting, use `--copilot-inline-results keep`. Settings files with
  comments or trailing commas are left unchanged with manual instructions.
- **Choose the guide for your workspace.** A Copilot-only workspace can use
  `tl workspace setup --guide-profile compact`. The VS Code extension also
  offers this choice when no explicit guide profile or code-only tool
  surface has already selected one. AGENTS.md is shared with Codex and
  Claude Code, so choose the full guide when those clients also need the
  detailed instructions. Smaller guides and fewer follow-up calls do not
  guarantee lower provider charges.
- **A ranged multi-file read no longer loses lines.** A `read_file` call
  that names several files, each with its own line range, previously could
  return a `next` that began after lines that were never sent, continued
  only the first file, or stopped short of the requested end when the
  response had to be shortened. Following `next` until none is left now
  delivers every requested line of every named file, and complete,
  commented code is no longer reported as partial.
- **Honest completion for requests made of several questions.** A
  read-only request such as "where does the order status change, how is a
  coupon validated, and where are failed notifications retried?" was
  reported as ready to answer once ONE of its questions had evidence. It
  now says `discover` and names one bounded follow-up for each question
  that has none, then closes once every question is served (two responses
  instead of one silent, incomplete one). The rule is deliberately narrow:
  it applies only when the request contains two or more independent
  questions; a single question that lists details in parentheses is
  treated exactly as before, and two questions joined by a bare "and" are
  recognised as two. Absence is also stricter: a word is not certified
  absent when only its inflection differs from what the code uses
  (`validated`/`validate`, `retried`/`retry`, `invoices`/`invoice`), and no
  response certifies a word absent while serving a file that contains it.

## Compatibility and migration

- Existing VS Code extension and source-checkout (`npm link`) installs
  continue to work. The first time any entry point runs under v0.14.3 —
  `tl-setup`, **Set up this workspace**, or `tl clients activate` — it
  migrates the legacy `~/.tokenlighten/bin/tl` shim into a forwarder to the
  new machine-install location and re-points every managed host
  registration it can reach at the new, version-independent identity.
  The legacy forwarder is kept for this one release for anything still
  reading it directly, and is removed by `tl install --uninstall`.
- Host entries do not need manual re-registration: re-running any entry
  point re-points what it manages automatically. Hand-written or foreign
  entries are reported, never modified without `--force`.
- The diagnostics ring's location is unchanged in this release.
- Three transitive runtime dependencies (`hono`, `smol-toml`, `js-yaml`)
  move to patched versions within their existing ranges; no runtime
  dependency is added. The development-only test runner moves to vitest 4.
- After upgrading, re-run `tl workspace setup` or the extension's **Set up
  this workspace** to refresh the managed instructions and Copilot
  configuration. Restart or reconnect the MCP client afterward.

## Known limitations

- The two first-response improvements (several points at once, Japanese
  questions) apply to read-only questions; responses to change requests
  are built as before.
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
- A `find` call naming more than one search term does not yet fold a
  located file back into the task the way a single-term search does.
- A pathless request that must first search for a missing symbol reaches
  its answer one extra round trip later than a request whose target is
  already named.
- Extra evidence's stated relation to a named file (for example, that it
  calls or is called by it) is a lexical match on a shared declared name,
  not a resolved call graph.
- The edit gate still grants write access to any file served in the
  current lane and epoch, even one the decision marked read-only; such an
  edit applies and is marked in the response, and an opt-in strict mode
  (`TL_FRONTIER_STRICT_WRITES=1`) refuses it with a re-pack step instead.
- An identifier that occurs only inside a string literal (not a comment)
  in a served file still counts as discharging that identifier.
- A small number of less common edit verbs, and a rename request, reach
  the edit decision after one extra search round trip rather than
  immediately.
- A Japanese noun phrase that names a concept (for example, a request to
  update a changelog by its Japanese name) does not yet resolve to the
  specific file it refers to the way the equivalent English wording does.
- Editing a file larger than 4 KiB that contains NUL bytes is refused safely, but with a generic write-error message rather than the read-side encoding wording.
- Full-width "！" or "？" between two edit clauses can leave the clause before the mark read-only (served, not offered for editing); half-width forms and the other clause boundaries behave as documented.


## Assets

- `tokenlighten-0.14.3-win-x64.tgz` and `tokenlighten-0.14.3-win-x64.zip`
- `tokenlighten-0.14.3-darwin-arm64.tgz`
- `tokenlighten-0.14.3-darwin-x64.tgz`
- `tokenlighten-0.14.3-linux-x64.tgz`
- `tokenlighten-vscode-extension-0.14.3.vsix`
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
