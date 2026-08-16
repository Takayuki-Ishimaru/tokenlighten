# TokenLighten release documentation

This directory contains the public documentation for the TokenLighten v0.9 release. It is intentionally separate from `docs/`, which preserves project design and development history.

## Start here

- [Getting started](getting-started.md) — build from source and set up a workspace.
- [MCP tools](mcp-tools.md) — the three tools exposed by the server.
- [VS Code extension](vscode-extension.md) — install and use the VSIX.
- [Language support](language-support.md) — supported languages, file formats, and limits.
- [Privacy, security, and support](privacy-security-support.md) — local processing, write permissions, and support expectations.
- [Licensing](licensing.md) — source-available use and redistribution policy.
- [Public-source manifest](public-source-manifest.md) — material permitted in the new public repository.
- [Release checklist](release-checklist.md) — required manual release gates.
- [GitHub Release v0.9.0 draft](github-release-v0.9.0.md) — public release-note copy with an artifact checksum placeholder.
- [GitHub repository settings](github-repository-settings.md) — About text, topics, security features, and visibility sequence.
- [Public root package template](templates/public-package.json) — build/test scripts with desktop and benchmark workspaces removed.
- [Public CI template](templates/public-ci.yml) — Node.js 20 checks on Ubuntu, macOS, and Windows plus VSIX packaging.
- [Public `.gitignore` template](templates/public.gitignore) — generated files and local secrets only; it is not a substitute for source selection.

## Release scope

TokenLighten is a local-first toolkit for giving MCP-capable coding agents focused repository context. The v0.9 release includes the CLI, MCP server, and VS Code extension. The desktop application is not part of this release.

TokenLighten is source-available software. It is not an OSI-approved open-source license. See [Licensing](licensing.md) before redistributing it or including it in a product or service.
