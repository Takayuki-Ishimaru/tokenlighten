# TokenLighten release documentation

This directory contains the public documentation prepared for TokenLighten v0.11.1. It is intentionally separate from the private design and benchmark history.

## Start here

- [Getting started](getting-started.md) — install the VSIX, build from source, and set up a workspace.
- [MCP tools](mcp-tools.md) — the three tools exposed by the server and the v0.11.1 workflow additions.
- [VS Code extension](vscode-extension.md) / [日本語](vscode-extension.ja.md) — install, diagnose, and use the VSIX.
- [Language support](language-support.md) — supported languages, file formats, and limits.
- [Privacy, security, and support](privacy-security-support.md) — local processing, write permissions, current audit snapshot, and support expectations.
- [Licensing](licensing.md) — source-available use and redistribution policy.
- [GitHub Release v0.11.1 draft](github-release-v0.11.1.md) — public release-note copy, feature comparison, benchmark disclosure, and pending asset checksum.
- [Historical GitHub Release v0.9.0 draft](github-release-v0.9.0.md) — retained for release-history review.
- [Public-source manifest](public-source-manifest.md) — material permitted in the new public repository.
- [Release checklist](release-checklist.md) — required manual release gates and current blockers.
- [GitHub repository settings](github-repository-settings.md) — About text, topics, security features, and visibility sequence.
- [Public root package template](templates/public-package.json) — build/test scripts with desktop and benchmark workspaces removed.
- [Public CI template](templates/public-ci.yml) — Node.js 20 checks on Ubuntu, macOS, and Windows plus VSIX packaging.
- [Public `.gitignore` template](templates/public.gitignore) — generated files and local secrets only; it is not a substitute for source selection.

## Release scope

TokenLighten is a local-first toolkit for giving MCP-capable coding agents focused repository context. The v0.11.1 public release includes the CLI, MCP server, developer source/tests selected by the public manifest, and the VS Code extension. The desktop application and private benchmark harness are not part of this public release.

TokenLighten is source-available software. It is not under an OSI-approved open-source license. See [Licensing](licensing.md) before redistributing it or including it in a product or service.
