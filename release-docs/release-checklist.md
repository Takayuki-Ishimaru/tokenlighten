# Release checklist

This checklist records the v0.12.1 maintenance release described in
[Public-source manifest](public-source-manifest.md). Publishing requires
explicit maintainer approval; that approval was received on 2026-08-28.

## Current review status (2026-08-28)

- [x] Product and public workspace manifests report 0.12.1.
- [x] The v0.12.0 benchmark interpretation remains unchanged; v0.12.1
  introduces no new performance claim.
- [x] Runtime dependency audit: 0 vulnerabilities.
- [x] Full public-source staging audit: 0 vulnerabilities.
- [x] Public-source staging build and 261 test files passed: 3,850 tests
  passed and 2 were skipped.
- [x] Bundled CLI, dependency licenses, generated notices, public inventory,
  VSIX manifest, and packaged MCP smoke checks passed.
- [x] The final VSIX contains the approved license and generated notices.
- [x] The final VSIX and checksum were generated and inspected.
- [ ] Confirm the pushed public commit with GitHub Actions on Node.js 20.
- [ ] Install the VSIX in a clean VS Code profile or test machine. The local
  release host did not expose the `code` command-line launcher.

## 1. Content and legal gate

- [x] Rebuild the public tree from the allowlist without importing private
  repository history.
- [x] Confirm private benchmark, Core 2, design/history, proto, report, and
  desktop-source material is absent.
- [x] Check public documents for unreviewed claims, private paths, internal
  design links, and stale version references.
- [x] Publish only reviewed aggregate or representative-task figures, never
  raw prompts, fixtures, transcripts, billing, tables, or run archives.
- [x] State that savings are not guaranteed and that the v0.11.1 comparison
  is descriptive rather than causal.
- [x] Confirm the approved license and package metadata; run dependency
  license checks and generate required notices.
- [x] Include the approved license and notices in the VSIX.

## 2. Source build and developer-test gate

The public source must build and test without the private benchmark harness.

~~~bash
npm install
npm run build
npm run test:packages
npm run test:bundle-cli
npm run licenses
npm run licenses:notices
npm audit --omit=dev --audit-level=high
npm run doctor
~~~

- [x] Run the build, package tests, bundled-CLI test, licenses, notices, and
  audits from a clean staged-public tree.
- [x] Confirm the runtime audit remains free of Critical and High findings.
- [x] Confirm the full `npm audit` reports 0 vulnerabilities.
- [x] Ensure the staged public tests do not depend on the private benchmark
  harness.
- [ ] Run Node.js 20 CI on macOS, Ubuntu, and Windows with platform scope
  documented in the README.
- [x] Confirm generated output exposes no private benchmark command or Core 2
  implementation.
- [x] Start the packaged MCP, confirm `initialize` reports v0.12.1, and
  confirm `tools/list` returns exactly `read_file`, `edit_file`, and
  `search_files`.
- [x] Confirm all product-side `doctor` checks pass. The aggregate local
  command exited nonzero only because the host's managed Claude registration
  still records TokenLighten v0.11.1; the release did not mutate user
  registration as part of source verification.

## 3. VS Code extension gate

~~~bash
npm run package -w tokenlighten-vscode-extension
~~~

- [x] Build `tokenlighten-vscode-extension-0.12.1.vsix` from staged public
  source without a missing-license warning.
- [x] Inspect the VSIX for the approved license, generated notices, bundled
  CLI/server, version 0.12.1, and absence of private material.
- [ ] Install it in a clean VS Code profile or test machine.
- [x] Run automated setup, enable/disable, session-native bypass, status,
  Diagnostics, and update-check tests.
- [x] Confirm the packaged manifest reports version 0.12.1.

## 4. Benchmark disclosure gate

- [x] Re-aggregate the exact retained v0.12 archive snapshot.
- [x] Confirm the approximately 28% aggregate result from 16 matched pairs.
- [x] Confirm the approximately 57% and 30% positive representative medians,
  with three verified pairs each.
- [x] Describe narrowly scoped and mixed-verification task tendencies
  qualitatively rather than as a numeric ranking.
- [x] Compare the approximately 21% v0.11.1 aggregate result descriptively.
- [x] Exclude mixed-verification outcomes and avoid guaranteed-savings claims.

## 5. Artifact integrity gate

- [x] Generate the checksum only after packaging gates pass.
- [x] Record the checksum in
  [the GitHub Release notes](github-release-v0.12.1.md).
- [x] Verify the artifact name, license, notices, version, and checksum.
- [x] Preserve the VSIX and checksum as release assets.

Verified VSIX SHA-256:

~~~text
ffcc4a39c48f17f58c28461dc31fe1000bc53e0ef6aa11760cbabf7abd30c52e  tokenlighten-vscode-extension-0.12.1.vsix
~~~

## 6. GitHub release

- [x] Receive explicit maintainer approval to publish v0.12.1.
- [ ] Push and verify the reviewed public tree.
- [ ] Confirm required GitHub Actions checks.
- [ ] Create and push the approved `v0.12.1` tag.
- [ ] Attach the VSIX and checksum and publish the GitHub Release.

The desktop application remains deferred from the public v0.12.1 release.
