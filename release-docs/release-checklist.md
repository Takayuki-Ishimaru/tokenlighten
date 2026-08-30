# Release checklist

This checklist records the v0.13.0 public release described in
[Public-source manifest](public-source-manifest.md). Preparation may proceed
locally, but pushing, tagging, changing repository settings, or publishing a
GitHub Release requires a separate explicit maintainer approval.

## Current review status (2026-08-30)

- [x] Product and public workspace manifests report 0.13.0.
- [x] Public release notes and compatibility documentation describe the
  canonical v0.13 surface and the v0.13.x-only legacy bridge.
- [x] The private source build and full test suite passed: 433 package test
  files with 8,498 tests passed and 2 skipped; 48 benchmark-library test files
  with 941 tests passed; 96 Node benchmark tests passed.
- [x] The Python benchmark library passed 1,035 tests with 36 skipped.
- [x] The clean public-source staging build and 283 test files passed:
  4,008 tests passed and 2 were skipped.
- [x] Runtime and full dependency audits both report 0 vulnerabilities.
- [x] Bundled CLI, dependency licenses, generated notices, public inventory,
  package version smoke, and exact three-tool smoke checks passed.
- [x] The final public-staging VSIX contains the approved license and generated
  notices; its checksum was generated and verified.
- [x] Fetch the public `main` history into an isolated ready tree, disable its
  push URL, and prepare a local release candidate commit without creating a tag.
- [ ] Install the VSIX in a clean VS Code profile or test machine.
- [ ] Push the reviewed public commit, then confirm GitHub Actions on Node.js
  20 for macOS, Ubuntu, and Windows.

## 1. Content and legal gate

- [x] Build the public tree from the reviewed allowlist without importing the
  private repository's history.
- [x] Confirm private benchmark, Core 2, design/history, proto, report, and
  desktop-source material is absent from the public inventory.
- [x] Check public documents for private paths, internal design links, stale
  version references, and claims not supported by reviewed aggregate evidence.
- [x] Publish only reviewed aggregate figures, never raw prompts, fixtures,
  transcripts, billing records, cell data, or run archives.
- [x] Present the v0.13 point estimate and task-level strengths and weaknesses
  in general-audience language without treating an internal statistical
  threshold as a release criterion.
- [x] Confirm the approved source-available license and package metadata; run
  dependency license checks and generate required notices.
- [x] Include the approved license and generated notices in the VSIX.

## 2. Source build and developer-test gate

The public source must build and test without the private benchmark harness.

~~~bash
npm ci
npm run build
npm run test:packages
npm run test:bundle-cli
npm run licenses
npm run licenses:notices
npm audit --omit=dev --audit-level=high
npm audit
npm run doctor
~~~

- [x] Run build, package tests, bundled-CLI tests, licenses, notices, and both
  audits from a clean staged-public tree.
- [x] Confirm the runtime and full audits each report 0 vulnerabilities.
- [x] Confirm the staged public tests do not depend on the private benchmark
  harness.
- [x] Confirm generated output exposes no private benchmark command or Core 2
  implementation.
- [x] Start the packaged MCP, confirm `initialize` reports 0.13.0, and confirm
  `tools/list` returns exactly `read_file`, `edit_file`, and
  `search_files`.
- [x] Confirm all product-side `doctor` checks pass. The aggregate staged
  command exited nonzero only because the host's managed Claude registration
  still points to TokenLighten 0.12.1; release verification did not mutate the
  user's registration.
- [ ] Confirm required Node.js 20 GitHub Actions checks after the public commit
  is pushed.

## 3. VS Code and GitHub Copilot extension gate

~~~bash
npm run package -w tokenlighten-vscode-extension
~~~

- [x] Build `tokenlighten-vscode-extension-0.13.0.vsix` from staged public
  source without a missing-license warning.
- [x] Inspect the VSIX for the approved license, generated notices, bundled
  CLI/server, manifest version 0.13.0, schema stamp, and absence of private
  material.
- [x] Run automated setup, enable/disable, session-native bypass, status,
  Diagnostics, schema-cache, and update-check tests.
- [x] Confirm workspace setup maintains GitHub Copilot instructions alongside
  the supported MCP client configuration.
- [ ] Install the VSIX in a clean VS Code profile or test machine.

## 4. Benchmark disclosure review

- [x] Record the v0.13 aggregate cost ratio of 0.735 and explain it as a 26.5%
  lower point estimate than native tools on the evaluated work.
- [x] Explain that v0.12.1 introduced no performance change, so v0.12.0 is the
  relevant historical comparator; include the v0.12 and v0.11.1 overall point
  estimates with a descriptive-comparison caveat.
- [x] Describe the strongest task pattern (cross-module decision tracing and
  downstream wiring), the still-favorable multi-location tasks, and the weak
  small known-location and narrow-calculation tasks with reviewed percentages.
- [x] Avoid internal cell, pair, and confidence-interval details in public
  user-facing copy, and avoid guaranteed or universal savings claims.

## 5. Artifact integrity gate

- [x] Generate the checksum only after public-staging package gates pass.
- [x] Record the checksum in
  [the GitHub Release notes](github-release-v0.13.0.md).
- [x] Verify the artifact name, approved license, notices, version, archive
  contents, and checksum.
- [x] Preserve the VSIX and checksum together as release assets.

Verified VSIX SHA-256:

~~~text
e2f87851f98187e07826e9c942d5c3d18c7df9a216d5ad60ba0330ce4d66c6f5  tokenlighten-vscode-extension-0.13.0.vsix
~~~

## 6. GitHub release

- [x] Prepare the reviewed local public commit with the push URL disabled and
  no `v0.13.0` tag.
- [ ] Receive explicit maintainer approval for the remote publication step.
- [ ] Push the reviewed public commit.
- [ ] Confirm required GitHub Actions checks.
- [ ] Create and push the approved `v0.13.0` tag.
- [ ] Attach the VSIX and checksum and publish the GitHub Release.

The desktop application remains deferred from the public v0.13.0 release.
