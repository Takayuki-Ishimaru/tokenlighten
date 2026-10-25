# Privacy, security, and support

## Local processing

TokenLighten is local-first. Repository indexing and context selection run on the local machine, using the CPU. Optional semantic search uses a local embedding model downloaded explicitly through `tl models install` or the VS Code analysis panel; it is off by default. Downloading public model files uses the network, while inference processes queries and repository content locally. This engine does not send repository content to a model service.

Your MCP client and chosen AI provider operate under their own configuration and terms. If that client sends repository context to a provider, that request is made by the client—not by TokenLighten. Review your client and provider settings before using them with sensitive repositories.

## Write permission

A manually started MCP server is read-only by default. File and structured-artifact changes require `--allow-write`. First workspace setup enables writes by default, CLI refresh preserves existing per-client permissions, and explicit `--read-only` or `--allow-write` flags override them. The extension's setup enables writes.

Use write access only in workspaces you trust. TokenLighten's edit flow is designed to constrain changes to prior-read context, but it does not replace code review, backups, access controls, or your normal development safeguards.

Optional typed resolution can start configured language-server executables, or discover installed servers on PATH when explicitly enabled. Both typed resolution and PATH discovery are off by default. Configure executables you trust; see [Local analysis engines](local-analysis.md).

## Credentials and protected files

For supported password-protected documents and archives, provide a credential reference and place the associated password in the server environment. Do not send raw passwords as tool arguments.

## Usage information

The VS Code extension and CLI can produce local usage and cost-savings estimates. These are estimates derived from local information; they are not AI-provider billing records. Do not export logs without reviewing them for your organization's privacy requirements.

## Dependency updates

v0.14.0 and v0.14.3 included dependency updates that address published advisories; v0.14.3 moves three transitive runtime dependencies to patched versions within their existing ranges and adds no new runtime dependency. Each install archive also bundles an official Node.js 24 LTS runtime; a Node.js security release on that line is treated as a re-release obligation. Use the latest released version. Source users can run `npm audit --omit=dev` for runtime dependencies and `npm audit` for the complete development installation. Advisory information can change after release.

## Support and service level

TokenLighten is provided without a support commitment or service-level agreement. There is no guaranteed response time, uptime commitment, maintenance window, or compatibility guarantee.

For ordinary questions and reproducible defects, use the project's public issue tracker when available. Do not put credentials, private source code, customer information, or other sensitive material in a public issue.
