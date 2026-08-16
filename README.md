# TokenLighten

[English](README.md) | [日本語](README.ja.md)

**TokenLighten** is a local-first MCP toolkit that gives coding agents focused repository context instead of repeatedly sending whole files.

It exposes exactly three tools: `read_file`, `search_files`, and `edit_file`.

## v0.9 release

**Public Beta.** TokenLighten v0.9 is an early public release. Interfaces and supported workflows may change as we incorporate feedback. Keep backups of important work, and do not include private source code, credentials, or customer data in public issue reports.

This release includes:

- the TokenLighten CLI and MCP server;
- source code and package tests for developers; and
- a self-contained VS Code extension distributed as a VSIX.

The desktop application is not included in v0.9.

## Why TokenLighten

Coding agents often spend multiple turns locating files, reading broad sections, and reopening context before making a small change. TokenLighten performs local repository discovery and returns compact structure, symbols, exact ranges, and bounded edit handles.

Repository indexing and context selection run locally on the CPU. TokenLighten does not add an AI model or upload repository contents on its own. Your editor, MCP client, and AI provider continue to operate under their own configuration and terms.

Savings vary by repository, task, client, and model behavior. Usage and cost figures shown by TokenLighten are local estimates, not provider billing records.

## Where TokenLighten can reduce token and task cost

TokenLighten is designed to deliver its largest advantage when an agent must identify and correctly update every affected location across multiple files, packages, or document formats. The benefit is expected to be smaller when a task is limited to one known location.

Symbol and reference search can return relevant definitions and call sites directly. Document readers can extract structured content from spreadsheets and other supported formats without loading each entire file. Together, these capabilities can reduce repeated search and rereading while the agent gathers the context required for repository-wide or cross-document work.

### Early developer benchmark observations

In one multi-package code task, the agent added a value to a shared enum and propagated it consistently through a frontend component, backend validation, and category-based aggregation logic. Across six repeated benchmark runs, using TokenLighten reduced verified task cost by approximately **56%** compared with the same agent without TokenLighten.

In a cross-document implementation task, the agent combined a rate table maintained in a spreadsheet with calculation procedures described in a separate document, then implemented a new pricing module consistent with both sources. Across six repeated benchmark runs, TokenLighten reduced verified task cost by approximately **48%**.

The early results also show where TokenLighten may not help:

- No clear advantage was observed when the main task was to analyze one large spreadsheet in isolation, without combining it with other sources to produce new code.
- Results varied for small, localized changes that only passed an already-known value through an existing code path and did not require broad repository discovery. In these cases, TokenLighten's context-collection overhead can exceed the cost it saves.

These are early, developer-run benchmark results, not guaranteed savings. Actual token use and task cost vary by repository, task, client, model behavior, and provider pricing.

## Install the VS Code extension (no build required)

For most users, download **[tokenlighten-vscode-extension-0.9.0.vsix](https://github.com/Takayuki-Ishimaru/tokenlighten/releases/latest/download/tokenlighten-vscode-extension-0.9.0.vsix)** from the latest GitHub Release. You do not need Node.js or a source build. The same VSIX is used on Windows, macOS, and Linux because this release does not include OS-specific native binaries.

Then:

1. open the VS Code **Extensions** view;
2. choose **Install from VSIX…**; and
3. select the downloaded file.

Or install it from a terminal:

```sh
code --install-extension tokenlighten-vscode-extension-0.9.0.vsix
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

The MCP server is read-only by default. Enable writes only when you intend to allow workspace changes:

```sh
tl mcp start --stdio --workspace /path/to/project
tl mcp start --stdio --allow-write --workspace /path/to/project
```

Run `tl help` for the current command reference.

## MCP tools

| Tool | Purpose |
|---|---|
| `read_file` | Returns focused file content, structure, symbols, or a task-oriented context pack. |
| `search_files` | Finds files, text, symbols, and references in the selected workspace. |
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

For v0.9.0, the complete package test suite is a CI gate on Ubuntu and macOS. Windows CI verifies the source build, bundled CLI, dependency licenses and notices, runtime dependency audit, and diagnostics. The complete package suite is not yet a Windows release gate because some test fixtures are not portable to Windows; this does not make Windows or VSIX installation unsupported, and Windows-specific test coverage will be expanded.

## Documentation

- [Getting started](release-docs/getting-started.md)
- [MCP tools](release-docs/mcp-tools.md)
- [VS Code extension](release-docs/vscode-extension.md)
- [Language and file support](release-docs/language-support.md)
- [Privacy, security, and support](release-docs/privacy-security-support.md)
- [Licensing and use policy](release-docs/licensing.md)

The existing `docs/` directory is development history and is not part of the public v0.9 source release.

## Security and support

### Dependency audit snapshot

For the staged v0.9.0 public release audited on 2026-08-16, `npm audit --omit=dev` reported **0 Critical, 0 High, and 2 Moderate** findings in the dependency set used by the shipped VS Code extension and normal runtime operation.

A full source-development installation, including development dependencies, reported **1 Critical, 1 High, and 5 Moderate** findings. Those known development-toolchain findings are not a v0.9.0 release blocker and are not part of normal installed-VSIX runtime use. Contributors should review them before running development tools on untrusted source or content.

This is a dated dependency-audit snapshot, not a guarantee that the software has no vulnerabilities. Audit data can change after publication; rerun `npm audit --omit=dev` for runtime dependencies and `npm audit` for the complete development installation.

The server is read-only unless started with `--allow-write`. Review [SECURITY.md](SECURITY.md) before reporting a vulnerability and [SUPPORT.md](SUPPORT.md) for the best-effort support policy. Do not post credentials, private source code, customer data, or unsanitized logs in public issues.

## License

TokenLighten is source-available software, not software under an OSI-approved open-source license. Personal use, individual use for employer or client work, organizational internal use, and properly attributed personal non-organizational redistribution are permitted under the release terms. Product/service integration and organizational or commercial redistribution require prior written permission from Takayuki Ishimaru (GitHub: [@Takayuki-Ishimaru](https://github.com/Takayuki-Ishimaru)).

The `LICENSE` file distributed with a release is authoritative. See [Licensing and use policy](release-docs/licensing.md) for a plain-language summary.
