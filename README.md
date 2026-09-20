<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/branding/github-header-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="assets/branding/github-header-light.png">
    <img src="assets/branding/github-header-light.png" alt="TokenLighten MCP" width="100%">
  </picture>
</p>

<h1 align="center">
  <img src="assets/branding/app-icon.png" alt="" width="48" height="48">
  TokenLighten
</h1>

[English](README.md) | [日本語](README.ja.md)

**TokenLighten** is a local-first MCP toolkit that gives coding agents focused repository context instead of repeatedly sending whole files.

It exposes exactly three tools: `read_file`, `search_files`, and `edit_file`.

## v0.14.3 release

**Public Beta.** TokenLighten v0.14.3 adds an install path that needs no editor extension and no separate Node.js: one archive per OS, one command. It also improves GitHub Copilot integration, task continuation, Japanese requests, and Windows support. It keeps the same three MCP tools and remains read-only by default. Interfaces and supported workflows may change as feedback is incorporated.

The main changes in v0.14.3 are:

- `tl-setup <workspace>` installs TokenLighten from a platform archive that bundles its own Node.js runtime, registers every detected AI-agent host (Claude Code, Codex, Gemini CLI, Copilot CLI, and GitHub Copilot Chat in VS Code), and sets up the workspace; re-running it upgrades in place, `--use` rolls back, and `--uninstall` removes the machine install together with the entries and guide blocks it wrote;
- the VS Code extension's **Set up this workspace** performs the same machine install and no longer adds a second server definition on top of the workspace file, and a new command uninstalls the machine install;
- `tl doctor` reports the consistency of the machine install, the extension and any `tl` on `PATH`, and `tl clients snippet` prints a pasteable entry for hosts it cannot write directly;
- continuing a task no longer repeats a search it already ran, loses a pending file creation, or resends a body it already returned, and requests naming several files or edits — in English or Japanese — are read more precisely;
- a read-only question that asks several things at once finds evidence for each point in its first response more often, and a Japanese question against an English codebase is retried with English search terms derived from it (both on by default; `TL_CONCERN_RECOVERY=0` and `TL_JA_QUERY_BRIDGE=0` turn them off);
- a read-only task stays read-only when a continuation omits `task.profile`, and a task handle the model garbled continues the caller's own live task on `read_file`/`search_files` instead of ending it (`TL_TASK_HANDLE_RECOVERY=0` restores the strict refusal);
- GitHub Copilot in VS Code receives more of the relevant context in one response, with shorter host-specific tool definitions and updated workspace instructions; setup also offers a compact guide for Copilot-only workspaces;
- a `read_file` call naming several files with a line range each no longer loses lines when its response is shortened, and multi-question requests stay open until every question is covered;
- every file body goes through one decoding policy, so undecodable or NUL-heavy files are disclosed instead of served; and
- archive reads, client registration and the bundled runtime now work on Windows, including from a folder extracted by Explorer.

The public release includes:

- four install archives (win-x64, darwin-arm64, darwin-x64, linux-x64) with the CLI, MCP server and a bundled Node.js runtime;
- the TokenLighten CLI and MCP server as source code with public package tests for developers; and
- a self-contained VS Code extension distributed as a VSIX.

**Compatibility:** the three tools and canonical request fields remain available. After upgrading, re-run `tl workspace setup` or the extension's **Set up this workspace** to refresh the managed instructions and enable the updated Copilot configuration. The first run of any v0.14.3 entry point migrates the earlier `~/.tokenlighten/bin/tl` launcher into a forwarder and re-points the host entries it manages. Legacy v0.12/v0.13 request fields remain refused by default, with `TL_LEGACY_INPUT=accept` available as a temporary server-side migration bridge. See the [v0.14.3 release notes](release-docs/github-release-v0.14.3.md) for compatibility details and known limitations.

## Why TokenLighten

Coding agents often spend multiple turns locating files, reading broad sections, and reopening context before making a small change. TokenLighten performs local repository discovery and returns compact structure, symbols, exact ranges, and bounded edit handles.

Repository indexing and context selection run locally on the CPU. TokenLighten does not add an AI model or upload repository contents on its own. Your editor, MCP client, and AI provider continue to operate under their own configuration and terms.

Savings vary by repository, task, client, and model behavior. Usage and cost figures shown by TokenLighten are local estimates, not provider billing records.

## Where TokenLighten can reduce token and task cost

TokenLighten is designed to deliver its largest advantage when an agent must identify and correctly update every affected location across multiple files, packages, or document formats. The benefit is expected to be smaller when a task is limited to one known location.

Symbol and reference search can return relevant definitions and call sites directly. Document readers can extract structured content from spreadsheets and other supported formats without loading each entire file. Together, these capabilities can reduce repeated search and rereading while the agent gathers the context required for repository-wide or cross-document work.

### Indicative savings (v0.14.0)

In a v0.14.0 comparison, total task cost was **36.7% lower with TokenLighten** than with the same agent using native file-reading and search tools alone. The comparison includes only work whose outcome was verified in both configurations.

| Task pattern | Median task-cost reduction |
|---|---:|
| Implement priority behavior across related feature paths | **59.1%** |
| Trace a decision across modules and connect downstream behavior | **40.5%** |
| Build rating rules from a spreadsheet specification | **39.1%** |
| Make a narrow calculation or data-integrity fix | **29.0%** |
| Explain a localized decision and its downstream effect | **25.1%** |
| Fix related bugs across control and mode transitions | **17.9%** |

**These percentages describe cost savings, not token-count reductions.** Input, output, and cached tokens have different prices, so a cost reduction cannot be converted directly into the same token reduction. The amount of context avoided depends on how much source material the agent would otherwise read and reread.

Use these results as a guide, not a guaranteed saving. These figures describe v0.14.0; they are not performance claims for v0.14.3 or for any particular host, including GitHub Copilot. Results vary by repository, task, client, model behavior, and pricing. For your own workspace, the CLI and VS Code usage views show locally measured usage and estimates; these are not provider billing records.

### Tasks that may benefit less

TokenLighten is less likely to help when little discovery or rereading is needed:

- **Small edits at one known location**, such as replacing a value or fixing a short calculation.
- **Localized explanations**, such as explaining a short function whose code has already been provided.

For these tasks, the additional context needed for tool definitions, guidance, and calls can outweigh the reading that TokenLighten avoids. Earlier comparisons included small fixes and localized explanations with similar or higher task cost. The v0.14.0 examples above showed savings, but do not establish that every small task will cost less.

TokenLighten also does not provide full type-aware semantic analysis. Cross-file renames that depend on types, imports, or overload resolution still require language-aware tools and verification. See [Language and file support](release-docs/language-support.md) for the supported boundaries.

## Install an archive (no editor, no build)

Download an archive for your OS from the [latest GitHub Release](https://github.com/Takayuki-Ishimaru/tokenlighten/releases), verify it against the published `SHA256SUMS`, extract it, and run:

```sh
./tl-setup /path/to/workspace       # macOS/Linux
tl-setup C:\path\to\workspace       # Windows
```

Each archive bundles its own copy of Node.js — no separate runtime install, no editor extension. This registers TokenLighten as a machine-scoped MCP server for every detected AI-agent host (Claude Code, Codex, Gemini CLI, Copilot CLI, and GitHub Copilot Chat in VS Code) and sets up the given workspace. See [Getting started](release-docs/getting-started.md) for verification, upgrade, rollback, and uninstall.

Prefer VS Code's own extension instead? See the next section.

## Install the VS Code extension (no build required)

Download **[tokenlighten-vscode-extension-0.14.3.vsix](https://github.com/Takayuki-Ishimaru/tokenlighten/releases/download/v0.14.3/tokenlighten-vscode-extension-0.14.3.vsix)** from the v0.14.3 GitHub Release. You do not need Node.js or a source build. The same VSIX is used on Windows, macOS, and Linux because this release does not include OS-specific native binaries.

Then:

1. open the VS Code **Extensions** view;
2. choose **Install from VSIX…**; and
3. select the downloaded file.

Or install it from a terminal:

```sh
code --install-extension tokenlighten-vscode-extension-0.14.3.vsix
```

Open a trusted project folder, select the TokenLighten view, and choose **Set up this workspace**. The packaged VSIX includes the CLI, MCP server, parsers, and required assets; a separate global installation is not required. This performs the same machine install as the archive above (`tl install --from-extension`) and sets up the current workspace, but leaves other hosts on the machine — Claude Code, Codex — unregistered (`--clients none`); register them separately with `tl clients activate`, or with an archive's `tl-setup`.

See [VS Code extension](release-docs/vscode-extension.md) for details.

## Build from source

Requirements:

- Node.js 20 or later;
- npm; and
- Git when using write-enabled repository operations.

```sh
git clone https://github.com/Takayuki-Ishimaru/tokenlighten.git
cd tokenlighten
npm ci
npm run build
npm link --workspace packages/cli
tl version
tl doctor --json
```

`npm link` gives you a `tl` command for this checkout only; run `tl install --dev` afterward to make the checkout the machine install other hosts can find — the same identity an archive install produces.

Set up TokenLighten in another workspace:

```sh
cd /path/to/project
tl workspace setup
```

`tl workspace setup` configures workspace MCP access and maintains the TokenLighten guide blocks in AGENTS.md/CLAUDE.md. Keep those blocks so supported agents can follow the current tool instructions across sessions. See [Getting started](release-docs/getting-started.md#set-up-a-workspace) for details and for machine-wide client registration with `tl clients activate`.

The MCP server is read-only by default. Enable writes only when you intend to allow workspace changes:

```sh
tl mcp start --stdio --workspace /path/to/project
tl mcp start --stdio --allow-write --workspace /path/to/project
```

Run `tl help` for the current command reference.

## MCP tools

| Tool | Purpose |
|---|---|
| `read_file` | First stop for any task, including unknown-location and multi-file discovery. Returns focused file content, structure, symbols, or a task-oriented context pack. |
| `search_files` | Finds files, text, symbols, and references across the selected workspace, repo-wide and `.gitignore`-aware. |
| `edit_file` | Applies bounded edits using context established by a prior read. Requires `--allow-write`. |

See [MCP tools](release-docs/mcp-tools.md) for behavior and safety notes.

## Packages

| Package | Purpose |
|---|---|
| `@tokenlighten/mcp-server` | Stdio MCP server and the three advertised tools. |
| `@tokenlighten/cli` | The `tl` command and workspace/client setup. |
| `@tokenlighten/skeleton-engine` | Repository maps, symbols, ranges, and route extraction. |
| `@tokenlighten/agents-md` | Managed agent-instruction blocks with drift detection. |
| `@tokenlighten/usage` | Local usage and savings estimates. |
| `@tokenlighten/types` | Shared public TypeScript contracts. |
| `tokenlighten-vscode-extension` | Self-contained VS Code integration. |

## Language and file support

Primary programming-language support currently covers TypeScript, JavaScript, Python, Go, Java, Rust, C, C++, Kotlin, C#, PHP, and Ruby.

TokenLighten can also read supported text, Office, PDF, and archive formats. Some formats are read-only, and PDF support requires a text layer. See [Language and file support](release-docs/language-support.md) for the current boundaries.

## Development

Run the public developer checks from the repository root:

```sh
npm ci
npm run build
npm run test:packages
npm run test:bundle-cli
npm run licenses
npm run doctor
```

Build the VSIX:

```sh
npm run package -w tokenlighten-vscode-extension
```

See [CONTRIBUTING.md](CONTRIBUTING.md) before submitting a change.

## Documentation

- [Getting started](release-docs/getting-started.md)
- [MCP tools](release-docs/mcp-tools.md)
- [VS Code extension](release-docs/vscode-extension.md)
- [Language and file support](release-docs/language-support.md)
- [Privacy, security, and support](release-docs/privacy-security-support.md)
- [Licensing and use policy](release-docs/licensing.md)

## Security and support

The server is read-only unless started with `--allow-write`. Review [SECURITY.md](SECURITY.md) before reporting a vulnerability and [SUPPORT.md](SUPPORT.md) for the best-effort support policy. Do not post credentials, private source code, customer data, or unsanitized logs in public issues.

## License

TokenLighten is source-available software, not software under an OSI-approved open-source license. Personal use, individual use for employer or client work, organizational internal use, and properly attributed personal non-organizational redistribution are permitted under the release terms. Product/service integration and organizational or commercial redistribution require prior written permission from Takayuki Ishimaru (GitHub: [@Takayuki-Ishimaru](https://github.com/Takayuki-Ishimaru)).

The `LICENSE` file distributed with a release is authoritative. See [Licensing and use policy](release-docs/licensing.md) for a plain-language summary.
