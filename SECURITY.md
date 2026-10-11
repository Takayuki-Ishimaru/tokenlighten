# Security Policy

## Supported versions

Security fixes are provided for the latest released version of TokenLighten. Older releases may be asked to upgrade before a fix is evaluated.

## Dependency updates

v0.14.4 updated the transitive runtime dependency `ip-address` and the packaging dependency `undici` to include upstream fixes for published advisories. v0.14.0 and v0.14.3 also included dependency updates; v0.14.1 and v0.14.2 declared no dependency changes. v0.15.0 updates transitive runtime dependencies and the VSIX packaging tool to include upstream fixes. v0.15.1 prevents task-pack evidence reads through imports or symlinks outside the workspace and updates runtime and build dependencies to include upstream fixes. v0.15.2 validates canonical requests before edits or task-state updates and updates MCP SDK dependencies to patched releases for [GHSA-6qxp-vccf-f47h](https://github.com/advisories/GHSA-6qxp-vccf-f47h). The advisory concerns HTTP OAuth clients; SDK-built servers and stdio clients are not affected. Advisory information can change after release. Users and contributors can run `npm audit --omit=dev` and, for source development, `npm audit` against the exact release or checkout they use.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private vulnerability reporting for this repository from the **Security** tab. If that feature is unavailable, contact the repository owner privately through the contact method shown on their GitHub profile.

Include the affected version, operating system, installation method, reproduction steps, impact, and any suggested mitigation. Remove repository contents, credentials, personal information, and other confidential data from logs or screenshots.

Reports are reviewed on a best-effort basis. TokenLighten does not currently provide a response-time or remediation-time SLA. Please allow the maintainer time to confirm the report and coordinate disclosure before publishing details.

## Scope

Reports about TokenLighten's own CLI, MCP server, VS Code extension, desktop application, file handling, or local data handling are in scope. Vulnerabilities in an AI provider, editor, operating system, or unrelated third-party service should be reported to that vendor.
