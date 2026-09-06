# TokenLighten v0.9.0

**Public Beta.** TokenLighten v0.9 is an early public release. Interfaces and supported workflows may change as we incorporate feedback. Keep backups of important work, and do not include private source code, credentials, or customer data in public issue reports.

TokenLighten is a local-first MCP toolkit that gives coding agents focused repository context. This first public source release includes the CLI, MCP server, developer source and tests, and a self-contained VS Code extension.

## Highlights

- Exactly three MCP tools: `read_file`, `search_files`, and `edit_file`.
- Task-focused source ranges, repository structure, symbols, and bounded edit handles.
- Read-only MCP operation by default; writes require explicit `--allow-write`.
- Local repository indexing and context selection.
- VS Code workspace setup for supported MCP-capable coding agents.
- TypeScript, JavaScript, Python, Go, Java, Rust, C, C++, Kotlin, C#, PHP, and Ruby support, plus selected document and archive formats.

## Install the VS Code extension

Download `tokenlighten-vscode-extension-0.9.0.vsix` from the Assets section below. No source build or separate Node.js installation is required. This same VSIX is used on Windows, macOS, and Linux.

In VS Code, open **Extensions**, choose **Install from VSIX…**, and select the downloaded file. Or run:

```sh
code --install-extension tokenlighten-vscode-extension-0.9.0.vsix
```

Open a trusted project folder, open the TokenLighten view, and choose **Set up this workspace**.

## Build from source

Node.js 20 or later is required.

```sh
npm ci
npm run build
npm run test:packages
npm run test:bundle-cli
npm link --workspace packages/cli
tl doctor --json
```

See [Getting started](https://github.com/Takayuki-Ishimaru/tokenlighten/blob/main/release-docs/getting-started.md) for workspace setup.

## Privacy and permissions

TokenLighten indexes and selects repository context locally. It does not add an AI model or upload repository contents on its own; the selected MCP client and model provider remain responsible for their own requests.

The MCP server is read-only by default. Start it with `--allow-write` only when you intend to permit workspace changes.

## Dependency updates

This historical release has known dependency security issues. Use the latest released version and run `npm audit --omit=dev` or `npm audit` against the exact checkout you use.

## Known limitations

- The desktop application is not included in v0.9.0.
- Savings vary by task, repository, client, and model behavior; local estimates are not provider billing records.
- Rename and reference operations are conservative and lexical rather than language-server semantic operations.
- Scanned or image-only PDFs are unsupported because PDF reading requires a text layer.
- TAR, TAR.GZ/TGZ, 7Z, and RAR containers are read-only.

## License and support

TokenLighten is source-available and is not licensed under an OSI-approved open-source license. Properly attributed personal non-organizational redistribution is permitted; product/service integration and organizational or commercial redistribution require prior written permission. See [Licensing and use policy](https://github.com/Takayuki-Ishimaru/tokenlighten/blob/main/release-docs/licensing.md).

Support is best effort. No response-time, resolution-time, uptime, or compatibility SLA is provided.

## Assets

- `tokenlighten-vscode-extension-0.9.0.vsix`
- `SHA256SUMS`

Verified VSIX SHA-256:

```text
10dc680e1ce46dc0fce43445a76c9b6300ec5e8e257d8d86fa0e867c37647612  tokenlighten-vscode-extension-0.9.0.vsix
```
