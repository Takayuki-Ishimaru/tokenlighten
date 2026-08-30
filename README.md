# TokenLighten

[English](README.md) | [日本語](README.ja.md)

**TokenLighten** is a local-first MCP toolkit that gives coding agents focused repository context instead of repeatedly sending whole files.

It exposes exactly three tools: `read_file`, `search_files`, and `edit_file`.

## v0.13.0 release

**Public Beta correctness and compatibility update.** TokenLighten v0.13.0 is the latest source release. Interfaces and supported workflows may continue to change as feedback is incorporated. Keep backups of important work, and do not include private source code, credentials, or customer data in public issue reports.

The public release includes:

- the TokenLighten CLI and MCP server;
- source code and public package tests for developers; and
- a self-contained VS Code extension distributed as a VSIX.

v0.13.0 adds proof-carrying completion, canonical MCP request schemas, compact replay receipts, stricter client-schema compatibility, and automatic VS Code schema-cache recovery. Proof completion is enabled by default as a correctness safeguard; experimental schema definitions, retrieval, reasoning, fast-path, delta-context, and adaptive-wire capabilities remain off by default unless explicitly enabled. Legacy v0.12 request fields remain accepted during v0.13.x but are no longer advertised.

The public release does not include the desktop application or the private benchmark harness.

## Why TokenLighten

Coding agents often spend multiple turns locating files, reading broad sections, and reopening context before making a small change. TokenLighten performs local repository discovery and returns compact structure, symbols, exact ranges, and bounded edit handles.

Repository indexing and context selection run locally on the CPU. TokenLighten does not add an AI model or upload repository contents on its own. Your editor, MCP client, and AI provider continue to operate under their own configuration and terms.

Savings vary by repository, task, client, and model behavior. Usage and cost figures shown by TokenLighten are local estimates, not provider billing records.

## Where TokenLighten can reduce token and task cost

TokenLighten is designed to deliver its largest advantage when an agent must identify and correctly update every affected location across multiple files, packages, or document formats. The benefit is expected to be smaller when a task is limited to one known location.

Symbol and reference search can return relevant definitions and call sites directly. Document readers can extract structured content from spreadsheets and other supported formats without loading each entire file. Together, these capabilities can reduce repeated search and rereading while the agent gathers the context required for repository-wide or cross-document work.

### What the developer benchmarks suggest

In the v0.13 developer benchmark, the aggregate TokenLighten/native cost ratio was **0.735**. In other words, the point estimate for completing the evaluated work was **26.5% lower with TokenLighten**.

v0.12.1 was a maintenance release with no performance change, so v0.12.0 is the relevant historical comparison. Its overall point estimate was approximately **28% lower**, while v0.11.1 measured approximately **21% lower**. v0.13 therefore remained close to v0.12 overall and was about 5.5 percentage points better than v0.11.1. These runs used different source revisions and evaluation windows, so the comparison describes an observed trend rather than a causal release-over-release improvement.

Task-level median costs show where v0.13 helped most and where it did not:

| Task pattern | v0.13 vs native | Compared with v0.12 |
|---|---:|---|
| Trace a health decision across modules and wire it into outbound telemetry | **42.5% lower** | The advantage widened from 19.6% lower by 22.9 percentage points. |
| Fix several related control and mode-transition bugs | **20.3% lower** | Still favorable, but smaller than v0.12's 29.7%. |
| Implement priority behavior across related feature paths | **12.0% lower** | Smaller than v0.12's 24.9%. |
| Build rating rules from a spreadsheet specification | **18.0% lower** | Smaller and more variable than v0.12's 56.8%. |
| Explain a localized orchestration path | **4.1% higher** | This small task was near parity in both releases. |
| Make a narrowly scoped calculation or data-integrity fix | **1.1% higher** | v0.12 measured 17.9% lower, so v0.13 showed no advantage here. |

The clearest v0.13 strength is work that requires tracing a decision through several components and connecting it to downstream consumers. Multi-location bug fixes and rule implementations also benefited, but less consistently. Small known-location tasks, localized explanations, and narrow calculations remain the weak area because fixed MCP, guidance, and verification overhead can outweigh the discovery saved. An artifact-driven task is not automatically a win when its target package is already tightly constrained.

These are developer-run observations, not guaranteed savings or quality. Actual outcomes vary by repository, task, client, model behavior, evaluation window, and provider pricing, and local estimates are not provider billing records. See the [v0.13.0 release notes](release-docs/github-release-v0.13.0.md#benchmark-disclosure) for the current disclosure and [v0.12.0 release notes](release-docs/github-release-v0.12.0.md#benchmark-update) for the historical details.

## Install the VS Code extension (no build required)

Download **[tokenlighten-vscode-extension-0.13.0.vsix](https://github.com/Takayuki-Ishimaru/tokenlighten/releases/download/v0.13.0/tokenlighten-vscode-extension-0.13.0.vsix)** from the v0.13.0 GitHub Release. You do not need Node.js or a source build. The same VSIX is used on Windows, macOS, and Linux because this release does not include OS-specific native binaries.

Then:

1. open the VS Code **Extensions** view;
2. choose **Install from VSIX…**; and
3. select the downloaded file.

Or install it from a terminal:

```sh
code --install-extension tokenlighten-vscode-extension-0.13.0.vsix
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

This natural-autoload setup — the managed AGENTS.md/CLAUDE.md guide block plus workspace MCP configuration — is the canonical way to run TokenLighten in production. Developer comparisons found that it performed about the same as manually injecting the same guide text into every prompt. Keep the managed guide block after setup: removing it materially increased measured cost and can allow instructions to drift between sessions. See [Getting started](release-docs/getting-started.md#set-up-a-workspace) for details and for `tl clients activate` (machine-wide registration with Claude Code and Codex).

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

For v0.13.0, the complete package test suite is a CI gate on Ubuntu and macOS. Windows CI verifies the source build, bundled CLI, dependency licenses and notices, runtime dependency audit, and diagnostics. The complete package suite is not yet a Windows release gate because some test fixtures are not portable to Windows; this does not make Windows or VSIX installation unsupported, and Windows-specific test coverage will be expanded.

## Documentation

- [Getting started](release-docs/getting-started.md)
- [MCP tools](release-docs/mcp-tools.md)
- [VS Code extension](release-docs/vscode-extension.md)
- [Language and file support](release-docs/language-support.md)
- [Privacy, security, and support](release-docs/privacy-security-support.md)
- [Licensing and use policy](release-docs/licensing.md)

The existing `docs/` directory is development history and is not part of the public v0.13.0 source release.

## Security and support

### Dependency audit snapshot

For the v0.13.0 release candidate audited on 2026-08-30, both `npm audit --omit=dev` and the full `npm audit`, including development dependencies, reported **0 vulnerabilities**.

This is a dated dependency-audit snapshot, not a guarantee that the software has no vulnerabilities. Audit data can change after publication; rerun `npm audit --omit=dev` for runtime dependencies and `npm audit` for the complete development installation.

The server is read-only unless started with `--allow-write`. Review [SECURITY.md](SECURITY.md) before reporting a vulnerability and [SUPPORT.md](SUPPORT.md) for the best-effort support policy. Do not post credentials, private source code, customer data, or unsanitized logs in public issues.

## License

TokenLighten is source-available software, not software under an OSI-approved open-source license. Personal use, individual use for employer or client work, organizational internal use, and properly attributed personal non-organizational redistribution are permitted under the release terms. Product/service integration and organizational or commercial redistribution require prior written permission from Takayuki Ishimaru (GitHub: [@Takayuki-Ishimaru](https://github.com/Takayuki-Ishimaru)).

The `LICENSE` file distributed with a release is authoritative. See [Licensing and use policy](release-docs/licensing.md) for a plain-language summary.
