# TokenLighten v0.13.0

**Public Beta update.** TokenLighten v0.13.0 strengthens completion honesty and the canonical MCP request surface while keeping exactly three advertised tools: `read_file`, `search_files`, and `edit_file`. The server remains read-only unless it is started with `--allow-write`.

## Highlights

- **Proof-carrying completion.** Task packs now keep an obligation ledger, executed-continuation history, and open-universe completeness evidence so an answer or edit decision is emitted only when its required work is demonstrably closed.
- **Canonical request surface.** The three tools use grouped canonical fields for task state, scope, budgets, targets, selectors, and edits. Pre-canonical v0.12 request fields remain accepted through v0.13.x as a migration bridge.
- **Honest continuations and compact replay.** Executable `next` calls, served-content receipts, replay v2, and force-serve recovery reduce predictable follow-up calls without treating omitted bytes as served.
- **Schema-aware client delivery.** The VS Code extension stamps the MCP schema, refreshes stale cached definitions, and retains compatibility for hosts such as GitHub Copilot that stringify structured object arguments.
- **Updated agent guidance.** The managed v80 guide documents the canonical surface, refusal transitions, receipts, range continuation, batching, and verification behavior.
- **Safer default rollout.** Proof completion is enabled by default in v0.13.0. Tool-local `$defs` emission remains disabled by default while client compatibility continues to be evaluated.

See the [changelog](../CHANGELOG.md) for release highlights.

## Compatibility

- The MCP surface remains exactly `read_file`, `search_files`, and `edit_file`.
- Writes still require explicit `--allow-write`.
- The legacy v0.12 field spellings are compatibility-only in v0.13.x and are scheduled for removal in v0.14.
- `TL_PROOF_COMPLETION` defaults to on; `TL_SCHEMA_DEFS` defaults to off.
- The desktop application is not included in the public source release.

## Install the VS Code extension

Download `tokenlighten-vscode-extension-0.13.0.vsix` from the Assets section. The same VSIX works on Windows, macOS, and Linux and includes the CLI, MCP server, approved license, and generated third-party notices.

~~~sh
code --install-extension tokenlighten-vscode-extension-0.13.0.vsix
~~~

Open a trusted project folder, open the TokenLighten view, and choose **Set up this workspace**. Workspace setup writes the managed instructions used by supported clients, including GitHub Copilot.

## Build from source

Node.js 20 or later is required.

~~~sh
npm ci
npm run build
npm run test:packages
npm run test:bundle-cli
npm run licenses
npm run doctor
~~~

See [Getting started](getting-started.md) for workspace setup.

## Dependency updates

Use the latest released version for dependency security fixes. Advisory information can change; run `npm audit --omit=dev` or `npm audit` against the exact checkout you use.

## Privacy and permissions

Repository indexing and context selection run locally. TokenLighten does not add an AI model or upload repository contents on its own; the selected MCP client and model provider remain responsible for their requests.

The MCP server is read-only by default. Start it with `--allow-write` only when you intend to permit workspace changes.

## Known limitations

- A multi-target range read can re-serve a previously supplied window or refuse a mixed continuation; issue separate canonical range calls when this occurs.
- A mixed edit batch that combines a new-file creation with edits to existing files can fail closed; create the new file and edit existing files in separate calls.
- Concurrent agents must pass distinct `lane` values. Omitting lanes can let one agent's frontier influence another agent's same-session decision.
- Rename and reference edits remain conservative and lexical rather than language-server semantic operations.
- Scanned or image-only PDFs require OCR elsewhere; TAR, TAR.GZ/TGZ, 7Z, and RAR containers remain read-only.

## License and support

TokenLighten is source-available and is not licensed under an OSI-approved open-source license. Product/service integration and organizational or commercial redistribution require prior written permission. See [Licensing and use policy](licensing.md).

Support is best effort. No response-time, resolution-time, uptime, or compatibility SLA is provided.

## Assets

- `tokenlighten-vscode-extension-0.13.0.vsix`
- `tokenlighten-vscode-extension-0.13.0.vsix.sha256`

Verified VSIX SHA-256:

~~~text
e2f87851f98187e07826e9c942d5c3d18c7df9a216d5ad60ba0330ce4d66c6f5  tokenlighten-vscode-extension-0.13.0.vsix
~~~
