# TokenLighten v0.12.0

**Public Beta update.** TokenLighten v0.12.0 is the newest source release of the local-first MCP toolkit for coding agents. It keeps exactly three advertised tools — `read_file`, `search_files`, and `edit_file` — while extending v0.11.1 with several serving/contract correctness fixes, a new byte-economy capability, and delivery/onboarding documentation improvements.

## Highlights since v0.11.1

- **More reliable task continuation.** Continuations preserve the complete query, same-epoch requirements remain monotone, stale prepared certificates are demoted, and unrelated follow-ups no longer inherit an old decision.
- **Stronger retrieval and file honesty.** Japanese prose participates in ranking, large Markdown files return heading outlines, exact identifier routing covers the 1–8 MiB band, and UTF-16 or undecodable files no longer produce false absence or unsafe writes.
- **Lower response overhead.** Task packs and batch reads honor response-size bounds, `edit.applied` proofs are more compact, and optional `TL_DELTA_CONTEXT` rereads avoid re-serving already-held post-edit context.
- **Faster bounded edits.** Guarded known-location value changes can take a compact fast path, construction packs serve the exact landing region, and retries disclose machine-readable replay.
- **Clearer setup and diagnostics.** Runtime and development doctor checks are separated, log summaries always show measured usage, compact and Japanese guide profiles are available, and workspace status reports managed-guide presence.
- **Safer command and verification behavior.** Nested CLI help is side-effect-free, verification recipes disclose per-target proof gaps, and unsupported-encoding edits fail closed without changing bytes.

See the [changelog](../CHANGELOG.md) for the complete v0.12.0 change inventory.

## Detailed changes

Compared with v0.11.1, this release adds and tightens:

- lossless query continuation, monotone per-epoch requirements, and stale-certificate demotion;
- Japanese-language retrieval using shared Han/kana spans and bigrams;
- a guarded known-location edit fast path for natural value-change requests;
- `maxBytes`/`maxTokens` bounds for task packs and batch reads, including a 14,336-byte VS Code default;
- machine-readable edit replay, remaining-query tails, and synthesized-range disclosure;
- UTF-16-aware search plus fail-closed writes for unsupported encodings;
- exact identifier routing in the 1–8 MiB band and bounded large-file continuations;
- heading outlines for large Markdown skeletons and honest prepared-certificate search;
- compact `edit.applied` proofs (19.9% lower median response bytes across five representative scenarios);
- optional `TL_DELTA_CONTEXT` rereads (6,214→415 bytes, -93.3%, in one representative case);
- clearer runtime/development diagnostics, measured-side log summaries, compact guide profiles, and Japanese medium/compact guides;
- side-effect-free nested CLI help and more explicit verification proof gaps.

Natural-autoload delivery — the managed guide plus workspace MCP configuration,
without manual prompt injection — remains the production setup path. Three
default-off v0.11 read-economy flags were retired after live probes found no
reliable contribution; their regression coverage remains.

## Benchmark update

The retained six-task v0.12 decision archive produced **16 matched verified
pairs**; **17 of 18** scheduled repetitions verified in each arm. Aggregate
verified task cost with TokenLighten was approximately **28% lower** than
with native tools only.

For comparison, the retained v0.11.1 run showed an approximately **21% lower**
aggregate cost, also from 16 matched verified pairs. The observed reduction
widened by about **7 percentage points**. Both runs cover the same six task
classes, but use different source revisions and evaluation windows; this is
descriptive, not a causal before/after measurement of the release.

Among the clearer positive results, the artifact-driven rating-engine task
showed an approximately **57% lower** median cost and the multi-bug on-call
task showed an approximately **30% lower** median cost, across three verified
pairs each.

The narrowly scoped calculation task was close to parity. Results were more
variable when the two arms did not reach the same verification outcome, so
those cases are excluded from numeric comparisons. Small known-location tasks
can also see less benefit because fixed MCP and guide overhead accounts for a
larger share of the work.

These are developer-run observations, not guaranteed savings. Results vary
by repository, task, client, model behavior, evaluation window, and provider
pricing. Local TokenLighten estimates are not provider billing records.

## Install the VS Code extension

Download `tokenlighten-vscode-extension-0.12.0.vsix` from the Assets section. The same VSIX works on Windows, macOS, and Linux and does not require a separate Node.js or `tl` installation.

~~~sh
code --install-extension tokenlighten-vscode-extension-0.12.0.vsix
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

For the v0.12.0 public-source staging tree audited on **2026-08-27**,
`npm audit --omit=dev` reported **0 Critical, 0 High, and 2 Moderate**
findings in the runtime dependency view. The full public-source staging
installation, including development dependencies, reported **1 Critical,
1 High, and 5 Moderate** findings. Development-toolchain findings are
outside the normal installed-VSIX runtime view. Re-run both audits if the
source or lockfile changes before publication.

These counts are a dated snapshot, not a guarantee of zero vulnerabilities. Rerun `npm audit --omit=dev` or `npm audit` against the exact release you use.

## Known limitations

- The desktop application and private benchmark harness are not included in the public v0.12.0 source release.
- Experimental retrieval, packing, reasoning, fast-path, and wire features remain off by default unless the changelog says otherwise.
- The pathless task-pack locator's primary index covers files through 1 MiB; exact identifier routing adds a wide scan for the 1–8 MiB band. Larger files remain readable by explicit path/range.
- Very large repository indexes are not persisted once the 32 MiB cache cap would be exceeded, so the first call in a new server process may rebuild the index.
- Rename and reference edits remain conservative and lexical rather than language-server semantic operations.
- Scanned or image-only PDFs require OCR elsewhere; TAR, TAR.GZ/TGZ, 7Z, and RAR containers remain read-only.
- `tl workspace status`'s readiness check is VS Code-oriented: a Codex- or Claude-Code-only workspace with a valid guide setup can still report not-ready. Pre-existing, not fixed in this release.
- Benchmark outcomes vary by workload and evaluation window; do not advertise a guaranteed saving.

## License and support

TokenLighten is source-available and is not licensed under an OSI-approved open-source license. Product/service integration and organizational or commercial redistribution require prior written permission. See [Licensing and use policy](licensing.md).

Support is best effort. No response-time, resolution-time, uptime, or compatibility SLA is provided.

## Assets

- `tokenlighten-vscode-extension-0.12.0.vsix`
- `tokenlighten-vscode-extension-0.12.0.vsix.sha256`

Verified VSIX SHA-256:

~~~text
d1a2c4b844687c99a2d08880e559ebe9494a46bb30a7eb1116b5ec016c27b88c
~~~
