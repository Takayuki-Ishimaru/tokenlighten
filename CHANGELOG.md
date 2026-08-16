# Changelog

All notable public changes to TokenLighten are documented here.

## 0.9.1

Public Beta maintenance release.

### Changed

- Corrected public documentation and simplified CLI and VS Code diagnostics.
- Added direct v0.9.1 VSIX download links for users who do not build from
  source.
- Updated package and runtime version metadata to 0.9.1.
- Updated Vitest, Vite, and esbuild so the full development audit no longer
  reports Critical or High findings.
- Added client-compatibility evidence, weekly Dependabot version updates, and
  advisory-level dependency-security documentation.
- Added the TokenLighten hummingbird header and dawn-palette Social Preview
  asset.
- Added a v0.9.1 Control Center screenshot to the English and Japanese
  READMEs.

No public MCP protocol change is intended in this maintenance release.

## 0.9.0

Initial public source release.

### Added

- MCP server with exactly three advertised tools: `read_file`, `edit_file`,
  and `search_files`.
- Task-oriented reads, exact source slices, edit handles, batched edits, and
  search across supported code and document formats.
- TokenLighten CLI for setup, diagnostics, workspace integration, MCP client
  registration, skeleton generation, and agent-guide management.
- VS Code extension with the TokenLighten CLI and public MCP runtime bundled
  into a zero-install VSIX.
- Developer build and package test workflows for Node.js 20 or newer.
- Public documentation for installation, MCP tools, language support,
  privacy, security, support, licensing, and source-release contents.
- Generated third-party dependency inventory distributed with release
  artifacts.

### Security and privacy

- File edits remain disabled unless the MCP server is started with
  `--allow-write`.
- Workspace access is restricted by resolved workspace roots and explicitly
  configured parent grants.
- Security reports are handled privately as described in `SECURITY.md`.
- Support is best effort; no support or availability SLA is provided.

### Known limitations

- The desktop application is not part of the 0.9.0 release and may be shipped
  in a later release.
- The initial VS Code extension is distributed as a manually installable VSIX.
- Token and cost reductions vary by task, model, client, and workflow; no
  specific saving is guaranteed.
