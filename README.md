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

It exposes exactly three tools: `tl_read_file`, `tl_search_files`, and `tl_edit_file`.

## v0.15.2 release

**Public Beta.** TokenLighten v0.15.2 uses shorter setup guides and improves source fidelity, Japanese questions and search continuation. It keeps the same three MCP tools and remains read-only by default. Interfaces and supported workflows may change as feedback is incorporated.

The main changes in v0.15.2 are:

- workspace setup defaults to the compact guide for Claude Code, Codex and GitHub Copilot, while explicit guide choices take precedence;
- Claude Code loads TokenLighten upfront, and generated Codex workspace settings wait for the initial tool catalog;
- comment omission preserves accurate source lines, and repeated reads respect the selected comment view;
- Japanese explanation and return-value questions avoid false missing-code reports;
- text search, workspace trees and archive-member trees use budgeted continuations; and
- invalid requests are rejected before edits or task-state updates.

The public release includes four platform install archives (win-x64, darwin-arm64, darwin-x64, linux-x64) with the CLI, MCP server and a bundled Node.js runtime, source code with public package tests, and a self-contained VS Code VSIX. The desktop application is not included.

**Upgrade:** install the v0.15.2 archive or VSIX, re-run `tl workspace setup` or **Set up this workspace**, then start a new agent session or reconnect your MCP client. The canonical request fields and tool names are unchanged from v0.15.1. See the [v0.15.2 release notes](release-docs/github-release-v0.15.2.md) for upgrade steps and known limitations.

## Why TokenLighten

Coding agents often spend multiple turns locating files, reading broad sections, and reopening context before making a small change. TokenLighten performs local repository discovery and returns compact structure, symbols, exact ranges, and bounded edit handles.

Repository indexing and context selection run locally on the CPU. TokenLighten does not add an AI model or upload repository contents on its own. Your editor, MCP client, and AI provider continue to operate under their own configuration and terms.

Savings vary by repository, task, client, and model behavior. Usage and cost figures shown by TokenLighten are local estimates, not provider billing records.

## Where TokenLighten can reduce token and task cost

TokenLighten is designed to deliver its largest advantage when an agent must identify and correctly update every affected location across multiple files, packages, or document formats. The benefit is expected to be smaller when a task is limited to one known location.

Symbol and reference search can return relevant definitions and call sites directly. Document readers can extract structured content from spreadsheets and other supported formats without loading each entire file. Together, these capabilities can reduce repeated search and rereading while the agent gathers the context required for repository-wide or cross-document work.

### Indicative savings (v0.15.0)

These observations are from v0.15.0; they are not new measurements of v0.15.2.

#### Sonnet comparison

During preparation for v0.15.0, we compared the same Sonnet model using native file-reading and search tools alone with the model using TokenLighten. Six tasks were attempted three times each. In the 11 pairs with verified outcomes in both configurations and complete billing records, **total task cost was 33.7% lower**, calculated from recorded usage and token prices.

| Task pattern | Task-cost reduction (comparison of median costs) | Comparable pairs |
|---|---:|---:|
| Fix related bugs across control and mode transitions | **53.2%** | 2 |
| Explain a localized decision and its downstream effect | **43.6%** | 1 |
| Implement priority behavior across related feature paths | **35.9%** | 3 |
| Make a narrow calculation or data-integrity fix | **21.5%** | 2 |
| Build rating rules from a spreadsheet specification | **9.4%** | 3 |

Unfinished tasks and trials with incomplete billing records are excluded. The table compares each configuration's median cost and includes an explanation task with only one pair, so these are reference observations rather than typical savings. The spreadsheet task had a lower median cost but a slightly higher total cost across its three pairs.

#### GitHub Copilot experiment

During preparation for v0.15.0, we compared code-reading and explanation tasks in GitHub Copilot's normal **Agent** mode in VS Code. Across 24 trials with and without TokenLighten, Auto model selection and standard tools remained enabled, and we checked the calculated answers and Copilot's recorded billed credits. The table compares **mean billed-credit reductions** for the same task and model.

| Task pattern | Model | Reduction | Trials (native / TL) |
|---|---|---:|---:|
| Trace discount, shipping, and tax rules and explain totals for several orders | GPT-6 Luna | **9.8%** | 2 / 2 |
| Explain a retry delay sequence and its dependencies without a source location | GPT-6 Luna | **11.9%** | 2 / 2 |
| Explain a retry delay sequence and its dependencies with a source location | MAI-Code-1.1-Flash | 6.8% (no clear difference) | 5 / 6 |
| Explain a retry delay sequence and its dependencies without a source location | MAI-Code-1.1-Flash | 54.5% (strongly affected by caching) | 2 / 2 |

Copilot used TokenLighten without selecting a custom Agent. On the short MAI reading tasks, model round trips fell from three or four to two. However, the samples are small, and Auto's model allocation and cache conditions were not controlled. The billed-cost ranges overlap in the 6.8% example, and the 54.5% example should not be treated as a typical saving.

**These percentages describe cost savings, not token-count reductions.** Input, output, and cached tokens have different prices, so a cost reduction cannot be converted directly into the same token reduction. The amount of context avoided depends on how much source material the agent would otherwise read and reread.

Use these results as a guide, not a guaranteed saving. The Copilot comparison covers reading and explanation only; its models, tasks, and measurement conditions differ from the Sonnet comparison, so the figures cannot be combined. Results vary by repository, task, client, model behavior, and pricing. For your own workspace, the CLI and VS Code usage views show locally measured usage and estimates; these are not provider billing records.

### Tasks that may benefit less

TokenLighten is less likely to help when little discovery or rereading is needed:

- **Small edits at one known location**, such as replacing a value or fixing a short calculation.
- **Localized explanations**, such as explaining a short function whose code has already been provided.

For these tasks, the additional context needed for tool definitions, guidance, and calls can outweigh the reading that TokenLighten avoids. Earlier comparisons included small fixes and localized explanations with similar or higher task cost. The examples above do not establish that every small task will cost less.

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

Download **[tokenlighten-vscode-extension-0.15.2.vsix](https://github.com/Takayuki-Ishimaru/tokenlighten/releases/download/v0.15.2/tokenlighten-vscode-extension-0.15.2.vsix)** from the v0.15.2 GitHub Release. You do not need Node.js or a source build. The same VSIX is used on Windows, macOS, and Linux because this release does not include OS-specific native binaries.

Then:

1. open the VS Code **Extensions** view;
2. choose **Install from VSIX…**; and
3. select the downloaded file.

Or install it from a terminal:

```sh
code --install-extension tokenlighten-vscode-extension-0.15.2.vsix
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

The shared agent guides default to `compact` for all tool surfaces. They tell Codex and Claude Code to send the complete request to `tl_read_file`, discover unknown paths, and reuse source already returned. Choose `--guide-profile full` or `medium` explicitly for a longer guide. Codex receives the managed AGENTS.md block; Claude Code uses the CLAUDE.md import. After upgrading, re-run `tl workspace setup` for the selected clients and start a new session. Savings depend on the task, client, and model.

VS Code setup also creates a SessionStart hook that gives ordinary Agent local chats the TL first-read and no-reread workflow. It requires a trusted workspace, enabled `chat.useHooks`, and `node` on PATH. It leaves tools and approval settings unchanged and preserves existing hooks and user edits. Use `tl workspace setup --clients vscode --copilot-session-context keep` to leave these hook files untouched.

The MCP server is read-only by default. Enable writes only when you intend to allow workspace changes:

```sh
tl mcp start --stdio --workspace /path/to/project
tl mcp start --stdio --allow-write --workspace /path/to/project
```

Run `tl help` for the current command reference.

## MCP tools

| Tool | Purpose |
|---|---|
| `tl_read_file` | First stop for any task, including unknown-location and multi-file discovery. Returns focused file content, structure, symbols, or a task-oriented context pack. |
| `tl_search_files` | Finds files, text, symbols, and references across the selected workspace, repo-wide and `.gitignore`-aware. |
| `tl_edit_file` | Applies bounded edits using context established by a prior read. Requires `--allow-write`. |

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
