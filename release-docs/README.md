# TokenLighten release documentation

This directory contains the public documentation prepared for TokenLighten
v0.13.0, separate from private design and benchmark history.

## Start here

- [Getting started](getting-started.md) — install, build, and set up a workspace.
- [MCP tools](mcp-tools.md) — the three tools and canonical v0.13 workflow.
- [VS Code extension](vscode-extension.md) /
  [日本語](vscode-extension.ja.md) — install and diagnose the VSIX.
- [Language support](language-support.md) — languages, formats, and limits.
- [Privacy, security, and support](privacy-security-support.md).
- [Licensing](licensing.md).
- [GitHub Release v0.13.0](github-release-v0.13.0.md) — correctness,
  canonical request surface, client compatibility, and benchmark disclosure.
- [Historical GitHub Release v0.12.1](github-release-v0.12.1.md) — maintenance
  and security-quality update.
- [Historical GitHub Release v0.12.0](github-release-v0.12.0.md) — feature
  comparison and adjudicated benchmark disclosure.
- [Historical GitHub Release v0.11.1](github-release-v0.11.1.md).
- [Historical GitHub Release v0.9.0](github-release-v0.9.0.md).
- [Public-source manifest](public-source-manifest.md).
- [Release checklist](release-checklist.md).
- [GitHub repository settings](github-repository-settings.md).
- [Public package](templates/public-package.json),
  [CI](templates/public-ci.yml), and
  [`.gitignore`](templates/public.gitignore) templates.

## Release scope

The v0.13.0 public release includes the CLI, MCP server, selected developer
source/tests, and VS Code extension. The desktop application and private
benchmark harness are excluded.

TokenLighten is source-available, not OSI-approved open source. See
[Licensing](licensing.md) before redistribution or product integration.