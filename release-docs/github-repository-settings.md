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

Do not add release, registry, or cloud credentials until an automated publication design has been separately reviewed. The v0.13.0 tag and GitHub Release remain manual.

## Release publication sequence

1. Prepare and verify only the allowlisted tree in a local public-repository clone.
2. Review the local commit diff, tag target, release notes, VSIX, and checksum.
3. Push the reviewed commit to `main` only after explicit maintainer approval.
4. Confirm public CI and review Actions logs and artifacts.
5. Create and push the approved tag, then publish the GitHub Release with the verified assets.
6. Reconfirm Private Vulnerability Reporting and the selected community features.

Never change the private development repository to public.
