# Privacy, security, and support

## Local processing

TokenLighten is local-first. Repository indexing and context selection run on the local machine, using the CPU. TokenLighten does not add a remote API, a background network service, or another AI model.

Your MCP client and chosen AI provider operate under their own configuration and terms. If that client sends repository context to a provider, that request is made by the client—not by TokenLighten. Review your client and provider settings before using them with sensitive repositories.

## Write permission

The MCP server is read-only by default. File and structured-artifact changes require starting it with `--allow-write`.

Use write access only in workspaces you trust. TokenLighten's edit flow is designed to constrain changes to prior-read context, but it does not replace code review, backups, access controls, or your normal development safeguards.

## Credentials and protected files

For supported password-protected documents and archives, provide a credential reference and place the associated password in the server environment. Do not send raw passwords as tool arguments.

## Usage information

The VS Code extension and CLI can produce local usage and cost-savings estimates. These are estimates derived from local information; they are not AI-provider billing records. Do not export logs without reviewing them for your organization's privacy requirements.

## Dependency security status

TokenLighten v0.9.1 dependencies were audited on 2026-08-16. `npm audit --omit=dev` reported **0 Critical, 0 High, and 2 Moderate** findings in the dependency set used for normal VS Code extension/runtime operation.

After the v0.9.1 development-toolchain updates, the complete source-development installation reported the same **0 Critical, 0 High, and 2 Moderate** findings. The two scanner entries represent one transitive `uuid` advisory through `exceljs`; the affected API path is not used by TokenLighten. See [Dependency security status](dependency-security.md) for advisory-level details.

Audit results can change as advisories are published or dependencies change. This dated snapshot is not a guarantee of zero risk. Run `npm audit --omit=dev` for the runtime view and `npm audit` for the full development view.

## Support and service level

TokenLighten is provided without a support commitment or service-level agreement. There is no guaranteed response time, uptime commitment, maintenance window, or compatibility guarantee.

For ordinary questions and reproducible defects, use the project's public issue tracker when available. Do not put credentials, private source code, customer information, or other sensitive material in a public issue.
