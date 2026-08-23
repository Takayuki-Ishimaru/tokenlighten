# TokenLighten v0.11.1

**Public Beta update.** TokenLighten v0.11.1 is the latest source release of the local-first MCP toolkit for coding agents. It keeps exactly three advertised tools — `read_file`, `search_files`, and `edit_file` — while extending the v0.9 public beta with restart-safe task state, stronger evidence and edit guarantees, improved multi-file discovery, optional retrieval and packing experiments, and substantially better VS Code diagnostics.

## Highlights since v0.9.x

- **Restart-safe task continuity.** Optional `task_handle` values can recover task state across MCP server restarts, with purpose-bound validation, compare-and-swap protection, and executable recovery on stale or invalid handles.
- **More honest discovery.** Per-term absence status, repository scope counts, parser-provenance labels, oversize-file disclosures, and content-hash freshness checks reduce false "not found" conclusions.
- **Fewer manufactured follow-ups.** Task packs can close predictable discovery steps, batch several identifiers, batch skeleton reads, carry verification kits, and return terminal proof for successful creates.
- **Safer bounded edits.** Known-local edits gain target fingerprints, impact guards, focused verification, rollback visibility, and conservative refusal when the target has drifted.
- **Modern and experimental paths without default wire churn.** The MCP 2026-07-28 transport and the graph, weighted-RRF, coverage-packer, reasoning-IR, compound-retrieval, fast-path, and adaptive-wire cores are available behind explicit flags. They remain off by default unless documented otherwise.
- **Better local measurement.** Attribution and paired calibration are versioned, ambiguity fails closed, and the UI distinguishes measured progress from local fallback estimates.
- **A more useful VS Code surface.** The status-bar QuickPick and Diagnostics panel show versions, build identity, launch configuration, workspace registration, write permission, guide state, and recent privacy-safe TokenLighten call metadata.

See the [changelog](../CHANGELOG.md) for the complete cumulative change inventory since v0.9.x.

## v0.11.1 focus

This patch release concentrates on real-host reliability:

- improved task-profile binding and first-pack evidence focus;
- deterministic candidate selection when one source clearly dominates;
- fixed create-intent routing and terminal create proof;
- working exact-reissue receipts and served-but-unread discovery after a prepared decision;
- honest `search_files` behavior for source files between 1 MiB and 8 MiB;
- batched `queries[]`, batched skeleton reads, and paged Markdown sections;
- lenient recovery for common wire-shape mistakes instead of internal errors;
- repaired `tl agents update`, a medium managed-guide profile, and Go verification-kit discovery;
- visible `server_build` identity and expanded VS Code diagnostics.

## Benchmark update

Across 16 matched, verified task pairs in the latest six-task developer decision run, using TokenLighten reduced aggregate verified task cost by approximately **21%** compared with the same agent using native tools only.

In a cross-module telemetry-wiring task, the agent had to locate the estimator health decision and connect it to the outbound system-status path. Across three verified repetitions, the median task cost with TokenLighten was approximately **33% lower**.

In a multi-bug on-call task spanning flight control, mixer behavior, and mode transitions, the median cost among the two matched verified repetitions was approximately **29% lower**. A third repetition had different verification outcomes between the two arms and is not included in that cost comparison.

The results also show where TokenLighten may help less:

- Benefits were modest for narrowly scoped calculation fixes and artifact-driven implementations whose target package was already constrained.
- Results were more variable when a task had mixed verification outcomes; those outcomes are excluded from the numeric comparisons above.
- Small known-location tasks can see little benefit or additional fixed MCP and guide overhead.

These are developer-run observations, not guaranteed savings. The v0.11.1 suite is broader than the published v0.9.x evaluation, so the two releases are not a direct before/after experiment. Actual cost varies by repository, task, client, model behavior, and provider pricing, and local estimates are not provider billing records.

## Install the VS Code extension

After the release is published, download `tokenlighten-vscode-extension-0.11.1.vsix` from the Assets section. The same VSIX works on Windows, macOS, and Linux and does not require a separate Node.js or `tl` installation.

~~~sh
code --install-extension tokenlighten-vscode-extension-0.11.1.vsix
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

## Privacy and permissions

Repository indexing and context selection run locally. TokenLighten does not add an AI model or upload repository contents on its own; the selected MCP client and model provider remain responsible for their requests.

The MCP server is read-only by default. Start it with `--allow-write` only when you intend to permit workspace changes.

## Dependency security snapshot

For the v0.11.1 source tree audited on 2026-08-23, `npm audit --omit=dev` reported **0 Critical, 0 High, and 2 Moderate** findings. The full source-development installation, including development dependencies, reported **1 Critical, 1 High, and 5 Moderate** findings.

These counts are a dated snapshot, not a guarantee of zero vulnerabilities. Rerun `npm audit --omit=dev` or `npm audit` against the exact release you use.

## Known limitations

- The desktop application and private benchmark harness are not included in the public v0.11.1 source release.
- Experimental retrieval, packing, reasoning, fast-path, and wire features remain off by default unless the changelog says otherwise.
- Source files larger than 1 MiB are not indexed for pathless task-pack location; direct path/range reads still work, and plain text/reference search scans up to 8 MiB.
- Very large repository indexes are not persisted once the 32 MiB cache cap would be exceeded, so the first call in a new server process may rebuild the index.
- Rename and reference edits remain conservative and lexical rather than language-server semantic operations.
- Scanned or image-only PDFs require OCR elsewhere; TAR, TAR.GZ/TGZ, 7Z, and RAR containers remain read-only.
- Benchmark outcomes vary by workload and evaluation window; do not advertise a guaranteed saving.

## License and support

TokenLighten is source-available and is not licensed under an OSI-approved open-source license. Product/service integration and organizational or commercial redistribution require prior written permission. See [Licensing and use policy](licensing.md).

Support is best effort. No response-time, resolution-time, uptime, or compatibility SLA is provided.

## Assets

- `tokenlighten-vscode-extension-0.11.1.vsix`
- `tokenlighten-vscode-extension-0.11.1.vsix.sha256`

Verified VSIX SHA-256:

~~~text
b983df44abc3871c97baaf87b03b63cfb88c4bb15a962e6f295bd810233fb081
~~~
