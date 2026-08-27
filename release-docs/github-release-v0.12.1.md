# TokenLighten v0.12.1

**Public Beta maintenance update.** TokenLighten v0.12.1 addresses dependency, static-analysis, and source-quality findings discovered after v0.12.0. It does not introduce a new performance feature or change the v0.12.0 benchmark interpretation.

TokenLighten continues to expose exactly three MCP tools — `read_file`, `search_files`, and `edit_file` — and remains read-only by default unless the MCP server is started with `--allow-write`.

## Highlights

- **Dependency security and ownership.** Vulnerable development and transitive packages were updated or overridden, unused packaged dependencies were removed, and the CLI now declares the spreadsheet dependency it imports directly.
- **Linear-time parsing and scanning.** CodeQL-identified superlinear regular expressions in task routing, source fallback parsing, Markdown handling, tokenization, path checks, and secret scanning were replaced with bounded scanners or direct string operations.
- **Safer configuration and identifiers.** CLI dot-path configuration rejects `__proto__` pollution while preserving legitimate `constructor` and `prototype` keys. Random handle generation now uses rejection sampling to avoid modulo bias.
- **Safer document and generated-text handling.** DOCX/OOXML extraction, Markdown/table output, license rendering, and generated preload code now use single-pass or explicit escaping paths that preserve ordinary content without allowing markup or code-boundary confusion.
- **Clearer content-hash intent.** Stable SHA-256 content identifiers use shared helpers and narrowly scoped CodeQL annotations; they are integrity identifiers, not password hashes.
- **Regression coverage.** New tests cover the exact configuration-pollution, sanitizer, parser, path, test-marker, secret-path, hash, and handle-generation behaviors changed in this release.

The changes address the 12 Dependabot and 38 CodeQL Security and quality findings inventoried before this release. The release source and dependency lock were rebuilt and audited after remediation.

See the [changelog](../CHANGELOG.md) for the complete v0.12.1 change inventory.

## Compatibility

- The MCP surface remains exactly `read_file`, `search_files`, and `edit_file`.
- Writes still require explicit `--allow-write`.
- Existing content-hash values and handle wire formats remain compatible.
- Java/C# fallback parsing, PascalCase routing, test-file detection, Markdown headings (including `C#`), and ordinary DOCX/OOXML text behavior retain regression coverage.
- The desktop application and private benchmark harness are not included in the public source release.

## Benchmark disclosure

v0.12.1 is a maintenance and security-quality release. No new benchmark result or performance claim is introduced. The reviewed v0.12.0 benchmark observations and their caveats remain unchanged in the [v0.12.0 release notes](github-release-v0.12.0.md#benchmark-update).

## Install the VS Code extension

Download `tokenlighten-vscode-extension-0.12.1.vsix` from the Assets section. The same VSIX works on Windows, macOS, and Linux and does not require a separate Node.js or `tl` installation.

~~~sh
code --install-extension tokenlighten-vscode-extension-0.12.1.vsix
~~~

Open a trusted project folder, open the TokenLighten view, and choose **Set up this workspace**.

## Build from source

Node.js 20 or later is required.

~~~sh
npm ci
npm run build
npm run test:packages
npm run test:bundle-cli
npm link --workspace packages/cli
tl doctor --json
~~~

See [Getting started](getting-started.md) for workspace setup.

## Dependency security snapshot

For the v0.12.1 release candidate audited on **2026-08-28**, both `npm audit --omit=dev` and the full `npm audit` reported **0 vulnerabilities**.

These counts are a dated snapshot, not a guarantee that future advisory data will remain unchanged. Rerun the audits against the exact release or checkout you use.

## Privacy and permissions

Repository indexing and context selection run locally. TokenLighten does not add an AI model or upload repository contents on its own; the selected MCP client and model provider remain responsible for their requests.

The MCP server is read-only by default. Start it with `--allow-write` only when you intend to permit workspace changes.

## Known limitations

- Experimental retrieval, packing, reasoning, fast-path, and wire features remain off by default unless the changelog says otherwise.
- Rename and reference edits remain conservative and lexical rather than language-server semantic operations.
- Scanned or image-only PDFs require OCR elsewhere; TAR, TAR.GZ/TGZ, 7Z, and RAR containers remain read-only.
- Benchmark outcomes vary by workload and evaluation window; v0.12.1 makes no new performance claim.

## License and support

TokenLighten is source-available and is not licensed under an OSI-approved open-source license. Product/service integration and organizational or commercial redistribution require prior written permission. See [Licensing and use policy](licensing.md).

Support is best effort. No response-time, resolution-time, uptime, or compatibility SLA is provided.

## Assets

- `tokenlighten-vscode-extension-0.12.1.vsix`
- `tokenlighten-vscode-extension-0.12.1.vsix.sha256`

Verified VSIX SHA-256:

~~~text
ffcc4a39c48f17f58c28461dc31fe1000bc53e0ef6aa11760cbabf7abd30c52e  tokenlighten-vscode-extension-0.12.1.vsix
~~~
