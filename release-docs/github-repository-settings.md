# GitHub repository settings

Apply these settings to the new public repository described in [Public-source manifest](public-source-manifest.md).

## About

Suggested description:

> Local-first MCP context toolkit for coding agents, with a self-contained VS Code extension.

Suggested topics:

`mcp`, `model-context-protocol`, `coding-agents`, `vscode-extension`, `typescript`, `developer-tools`, `local-first`, `source-available`

Do not label the repository as open source or OSS.

## Repository features

- Enable Issues.
- Enable Discussions if a community question channel is wanted.
- Enable Private Vulnerability Reporting before publication.
- Enable the dependency graph, Dependabot alerts, and security updates.
- Disable the wiki unless it will be maintained as another public documentation surface.

## Default branch protection

Use `main` as the default branch. Protect it against force-push and deletion. Require the public three-operating-system CI workflow to pass before merging. A solo maintainer can keep the approval count at zero while still requiring the checks.

Do not add release, registry, or cloud credentials until an automated publication design has been separately reviewed. The v0.11.1 tag and GitHub Release remain manual.

## Visibility sequence

1. Create the new repository as private.
2. Push only the fresh-history allowlisted tree.
3. Run secret scanning and public CI.
4. Review repository files, Actions logs, artifacts, branches, and tags.
5. Enable Private Vulnerability Reporting and the selected community features.
6. Change visibility to public only after the final legal and artifact gates pass.

Never change the existing development repository to public.
