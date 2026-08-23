# Release checklist

This checklist is for the v0.11.1 public repository described in [Public-source manifest](public-source-manifest.md). Do not publish, push, tag, or change repository visibility automatically.

## Current review status (2026-08-23)

- [x] Product and workspace manifests report 0.11.1.
- [x] The v0.9 → v0.11.1 feature comparison and benchmark interpretation are reflected in the public release draft.
- [x] The benchmark follows the v0.9.x README format: selected verified positive results are numeric, weaker task classes are described qualitatively, and no guaranteed-savings claim is made.
- [x] Runtime dependency audit: 0 Critical, 0 High, 2 Moderate.
- [x] Full public-source development audit: 1 Critical, 1 High, 5 Moderate.
- [x] The approved TokenLighten Source-Available License Version 0.9 is packaged in the VSIX without a missing-license warning.
- [x] The final VSIX was rebuilt and its SHA-256 is `b983df44abc3871c97baaf87b03b63cfb88c4bb15a962e6f295bd810233fb081`.
- [x] Public-staging build, tests, notices, inventory validation, and VSIX manifest review completed.

## 1. Content and legal gate

- [ ] Build the new repository from the allowlist, with a fresh root commit and no imported Git history.
- [ ] Confirm that `bench/`, the CLI benchmark command/tests, MCP Core 2 source/tests, the Core 2 agent template, historical private docs, `proto/`, `TL-*`, `DESIGN-*`, private reports, and desktop source are absent.
- [ ] Check every public document and package README for unreviewed benchmark claims, private paths, internal design links, and stale proxy references.
- [ ] Confirm the public benchmark text contains only reviewed positive aggregate or representative-task figures, qualitative descriptions of weaker task classes, and the required comparison caveats; do not publish full numeric result tables, raw prompts, fixtures, transcripts, billing, or run archives.
- [ ] Obtain appropriate legal review of the maintainer license draft kept outside the public staging tree, then use only the approved text as the release's `LICENSE`.
- [ ] Confirm the public root `LICENSE` contains the approved source-available terms, every public package metadata license field says `SEE LICENSE IN LICENSE`, and no public TokenLighten package retains a legacy MIT label.
- [ ] Run the third-party dependency license check and publish the required notices.
- [ ] Include the approved license text in the VSIX and confirm the packaging command emits no missing-license warning.

## 2. Source build and developer-test gate

The public source must support building and testing without the private benchmark harness.

~~~bash
npm install
npm run build
npm run test:packages
npm run test:bundle-cli
npm run licenses
npm run licenses:notices
git diff --exit-code -- THIRD_PARTY_NOTICES.md
npm audit --omit=dev --audit-level=high
npm run doctor
~~~

- [ ] Run the commands above from a clean clone of the staged public repository.
- [ ] Confirm the runtime audit remains free of Critical and High findings. This is the v0.11.1 runtime dependency gate.
- [ ] Run a separate full `npm audit` and update the dated development-toolchain disclosure if it differs from 1 Critical, 1 High, and 5 Moderate.
- [ ] Ensure the public root `npm test` runs only included package and VSIX tests and does not reference the private benchmark harness.
- [ ] Configure GitHub Actions for Node.js 20 on macOS, Ubuntu, and Windows. Run the complete package suite on Ubuntu and macOS; on Windows, gate the build, bundled CLI, dependency licenses/notices, runtime audit, and diagnostics while the remaining non-portable fixtures stay disclosed.
- [ ] Confirm `tl help` contains no private benchmark command, `tl bench` returns the ordinary unknown-command error, and generated output contains no private benchmark or Core 2 implementation.
- [ ] Confirm generated package output and tests do not depend on excluded files.
- [ ] Install the packed CLI/MCP packages in a clean temporary consumer and confirm module import plus MCP `initialize` and `tools/list` succeed with exactly three tools.

## 3. VS Code extension gate

~~~bash
npm run package -w tokenlighten-vscode-extension
~~~

- [ ] Build `tokenlighten-vscode-extension-0.11.1.vsix` from the public repository without a missing-license warning.
- [ ] Inspect the VSIX contents for the approved license, third-party notices, bundled CLI/server, and absence of private benchmark material.
- [ ] Install the VSIX in a clean VS Code profile or test machine.
- [ ] Open a trusted sample workspace and run **Set up this workspace**.
- [ ] Confirm enable/disable, session-native bypass, status-bar QuickPick, Diagnostics, and update checks.
- [ ] Confirm Diagnostics reports version 0.11.1 and the expected `server_build`.

## 4. Benchmark disclosure gate

- [ ] Re-run the snapshot-aware aggregate command against the exact retained v0.11.1 decision archive.
- [ ] Confirm each selected positive figure matches the retained archive and that weaker task classes remain qualitative rather than a numeric ranking.
- [ ] Do not claim guaranteed savings.
- [ ] Keep the v0.9 comparison labeled non-causal and non-direct because the task suite and window changed.

## 5. Artifact integrity gate

~~~bash
shasum -a 256 tokenlighten-vscode-extension-0.11.1.vsix > tokenlighten-vscode-extension-0.11.1.vsix.sha256
~~~

- [ ] Generate the checksum only after every packaging gate passes.
- [ ] Replace the checksum placeholder in [the GitHub Release draft](github-release-v0.11.1.md).
- [ ] Verify the checksum file names the exact artifact to upload.
- [ ] Preserve the VSIX and checksum as release assets.
- [ ] Verify the source commit SHA that produced the VSIX.

## 6. Manual GitHub release

- [ ] Review the final public repository tree, fresh root commit, CI results, release-note copy, and artifact contents.
- [ ] Create and push the approved `v0.11.1` tag manually from the reviewed public commit.
- [ ] Attach the VSIX and its checksum file.
- [ ] Publish the GitHub Release only after a final maintainer review.

The desktop application remains deferred from the public v0.11.1 release.
