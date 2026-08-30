# TokenLighten

[English](README.md) | [日本語](README.ja.md)

**TokenLighten** is a local-first MCP toolkit that gives coding agents focused repository context instead of repeatedly sending whole files.

It exposes exactly three tools: `read_file`, `search_files`, and `edit_file`.

## v0.13.1 release

**Public Beta reliability update.** TokenLighten v0.13.1 is the latest source release. It improves correctness for concurrent agents, multi-target reads, batched file creation, continuations, and checklist-style tasks without changing the three-tool MCP surface. Interfaces and supported workflows may continue to change as feedback is incorporated. Keep backups of important work, and do not include private source code, credentials, or customer data in public issue reports.

The public release includes:

- the TokenLighten CLI and MCP server;
- source code and public package tests for developers; and
- a self-contained VS Code extension distributed as a VSIX.

Task state is now isolated between concurrent agent lanes, ranged multi-target reads and mixed create/edit batches behave consistently, and local savings accounting follows complete tasks rather than individual calls. Proof completion remains enabled by default. Legacy v0.12 request fields remain accepted during v0.13.x but are no longer advertised.

## Why TokenLighten

Coding agents often spend multiple turns locating files, reading broad sections, and reopening context before making a small change. TokenLighten performs local repository discovery and returns compact structure, symbols, exact ranges, and bounded edit handles.

Repository indexing and context selection run locally on the CPU. TokenLighten does not add an AI model or upload repository contents on its own. Your editor, MCP client, and AI provider continue to operate under their own configuration and terms.

Savings vary by repository, task, client, and model behavior. Usage and cost figures shown by TokenLighten are local estimates, not provider billing records.

## Where TokenLighten can reduce token and task cost

TokenLighten is designed to deliver its largest advantage when an agent must identify and correctly update every affected location across multiple files, packages, or document formats. The benefit is expected to be smaller when a task is limited to one known location.

Symbol and reference search can return relevant definitions and call sites directly. Document readers can extract structured content from spreadsheets and other supported formats without loading each entire file. Together, these capabilities can reduce repeated search and rereading while the agent gathers the context required for repository-wide or cross-document work.

### What the developer benchmarks suggest

In the v0.13.1 developer benchmark, the aggregate TokenLighten/native cost ratio was **0.809**: a point estimate of **19.1% lower task cost with TokenLighten**. Both configurations solved and verified all 18 evaluated tasks.

Task-level results varied:

| Task pattern | v0.13.1 vs native |
|---|---:|
| Trace a decision across modules and connect downstream behavior | **29.0% lower** |
| Fix related bugs across control and mode transitions | **17.9% lower** |
| Build rating rules from a spreadsheet specification | **16.7% lower** |
| Make a narrow calculation or data-integrity fix | **7.3% lower** |
| Implement priority behavior across related feature paths | **7.4% lower** |

The strongest results remained on work that requires tracing and changing several related locations. Localized explanation work was more sensitive to fixed overhead and remains an area for improvement.

These are developer-run observations, not guaranteed savings or quality. Results vary by repository, task, client, model behavior, evaluation window, and provider pricing, and local estimates are not provider billing records. See the [v0.13.1 release notes](release-docs/github-release-v0.13.1.md#benchmark-disclosure) for the full disclosure.

## Install the VS Code extension (no build required)

Download **[tokenlighten-vscode-extension-0.13.1.vsix](https://github.com/Takayuki-Ishimaru/tokenlighten/releases/download/v0.13.1/tokenlighten-vscode-extension-0.13.1.vsix)** from the v0.13.1 GitHub Release. You do not need Node.js or a source build. The same VSIX is used on Windows, macOS, and Linux because this release does not include OS-specific native binaries.

Then:

1. open the VS Code **Extensions** view;
2. choose **Install from VSIX…**; and
3. select the downloaded file.

Or install it from a terminal:

```sh
code --install-extension tokenlighten-vscode-extension-0.13.1.vsix
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

For v0.13.1, the complete package test suite is a CI gate on Ubuntu and macOS. Windows CI verifies the source build, bundled CLI, dependency licenses and notices, runtime dependency audit, and diagnostics. The complete package suite is not yet a Windows release gate because some test fixtures are not portable to Windows; this does not make Windows or VSIX installation unsupported, and Windows-specific test coverage will be expanded.

## Documentation

- [Getting started](release-docs/getting-started.md)
- [MCP tools](release-docs/mcp-tools.md)
- [VS Code extension](release-docs/vscode-extension.md)
- [Language and file support](release-docs/language-support.md)
- [Privacy, security, and support](release-docs/privacy-security-support.md)
- [Licensing and use policy](release-docs/licensing.md)

The existing `docs/` directory is development history and is not part of the public v0.13.1 source release.

## Security and support

### Dependency audit snapshot

For the v0.13.1 release candidate audited on 2026-08-30, both `npm audit --omit=dev` and the full `npm audit`, including development dependencies, reported **0 vulnerabilities**.

This is a dated dependency-audit snapshot, not a guarantee that the software has no vulnerabilities. Audit data can change after publication; rerun `npm audit --omit=dev` for runtime dependencies and `npm audit` for the complete development installation.

The server is read-only unless started with `--allow-write`. Review [SECURITY.md](SECURITY.md) before reporting a vulnerability and [SUPPORT.md](SUPPORT.md) for the best-effort support policy. Do not post credentials, private source code, customer data, or unsanitized logs in public issues.

## License

TokenLighten is source-available software, not software under an OSI-approved open-source license. Personal use, individual use for employer or client work, organizational internal use, and properly attributed personal non-organizational redistribution are permitted under the release terms. Product/service integration and organizational or commercial redistribution require prior written permission from Takayuki Ishimaru (GitHub: [@Takayuki-Ishimaru](https://github.com/Takayuki-Ishimaru)).

The `LICENSE` file distributed with a release is authoritative. See [Licensing and use policy](release-docs/licensing.md) for a plain-language summary.
