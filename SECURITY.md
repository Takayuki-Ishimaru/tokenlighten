# Security Policy

## Supported versions

Security fixes are provided for the latest released version of TokenLighten. Older releases may be asked to upgrade before a fix is evaluated.

## Dependency audit status

For TokenLighten v0.9.1 dependencies audited on 2026-08-16, both `npm audit --omit=dev` and the full `npm audit` reported 0 Critical, 0 High, and 2 Moderate findings. The two scanner entries represent one transitive `uuid` advisory through `exceljs`; the affected API path is not used by TokenLighten.

See [Dependency security status](release-docs/dependency-security.md) for advisory IDs, runtime/development classification, reachability, remediation constraints, and the update plan. These counts are a dated snapshot rather than a statement that TokenLighten is free of vulnerabilities.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private vulnerability reporting for this repository from the **Security** tab. If that feature is unavailable, contact the repository owner privately through the contact method shown on their GitHub profile.

Include the affected version, operating system, installation method, reproduction steps, impact, and any suggested mitigation. Remove repository contents, credentials, personal information, and other confidential data from logs or screenshots.

Reports are reviewed on a best-effort basis. TokenLighten does not currently provide a response-time or remediation-time SLA. Please allow the maintainer time to confirm the report and coordinate disclosure before publishing details.

## Scope

Reports about TokenLighten's own CLI, MCP server, VS Code extension, file handling, or local data handling are in scope. Vulnerabilities in an AI provider, editor, operating system, or unrelated third-party service should be reported to that vendor.
