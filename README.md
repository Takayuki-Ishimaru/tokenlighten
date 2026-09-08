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

## v0.14.2 release

**Public Beta.** TokenLighten v0.14.2 improves task continuation, interpretation of multi-point and Japanese requests, and workspace setup for code-only projects. It keeps the same three MCP tools and remains read-only by default. Interfaces and supported workflows may change as feedback is incorporated.

The main changes in v0.14.2 are:

- continuing a task remembers completed reads and previously established requirements, so it can move on without repeating a finished step;
- requests naming specific files, identifiers, or multiple topics keep their intended focus, with improved handling of Japanese sentences and topics that cannot be found;
- a task waiting for input explains what remains unresolved and supplies a recovery call when available;
- repeated full reads avoid resending content already in context, including when `budget.allowFull:true` is used; and
- code-only workspace setup uses the compact agent guide by default, while an explicit guide-profile choice is respected.

The public release includes:

- the TokenLighten CLI and MCP server;
- source code and public package tests for developers; and
- a self-contained VS Code extension distributed as a VSIX.

**Compatibility:** the three tools and canonical request fields remain available. `budget.allowFull:true` now only raises the full-read size cap; use `task.force_serve:true` when previously served context must be sent again. Refresh managed agent instructions by re-running workspace setup. Legacy v0.12/v0.13 request fields remain refused by default, with `TL_LEGACY_INPUT=accept` available as a temporary server-side migration bridge. See the [v0.14.2 release notes](release-docs/github-release-v0.14.2.md) for compatibility details and known limitations.

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

Use these results as a guide, not a guaranteed saving. The comparison was made on v0.14.0 and has not been repeated for v0.14.2. Results vary by repository, task, client, model behavior, and pricing. For your own workspace, the CLI and VS Code usage views show locally measured usage and estimates; these are not provider billing records.

### Tasks that may benefit less

TokenLighten is less likely to help when little discovery or rereading is needed:

- **Small edits at one known location**, such as replacing a value or fixing a short calculation.
- **Localized explanations**, such as explaining a short function whose code has already been provided.

For these tasks, the additional context needed for tool definitions, guidance, and calls can outweigh the reading that TokenLighten avoids. Earlier comparisons included small fixes and localized explanations with similar or higher task cost. The v0.14.0 examples above showed savings, but do not establish that every small task will cost less.

TokenLighten also does not provide full type-aware semantic analysis. Cross-file renames that depend on types, imports, or overload resolution still require language-aware tools and verification. See [Language and file support](release-docs/language-support.md) for the supported boundaries.

## Install the VS Code extension (no build required)

Download **[tokenlighten-vscode-extension-0.14.2.vsix](https://github.com/Takayuki-Ishimaru/tokenlighten/releases/download/v0.14.2/tokenlighten-vscode-extension-0.14.2.vsix)** from the v0.14.2 GitHub Release. You do not need Node.js or a source build. The same VSIX is used on Windows, macOS, and Linux because this release does not include OS-specific native binaries.

Then:

1. open the VS Code **Extensions** view;
2. choose **Install from VSIX…**; and
3. select the downloaded file.

Or install it from a terminal:

```sh
code --install-extension tokenlighten-vscode-extension-0.14.2.vsix
```

Open a trusted project folder, select the TokenLighten view, and choose **Set up this workspace**. The packaged VSIX includes the CLI, MCP server, parsers, and required assets; a separate global installation is not required.

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
