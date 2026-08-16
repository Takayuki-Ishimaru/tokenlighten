# Release checklist

This checklist is for the new public repository described in [Public-source manifest](public-source-manifest.md). Do not publish, push, tag, or change repository visibility automatically.

## 1. Content and legal gate

- [ ] Build the new repository from the allowlist, with a fresh root commit and no imported Git history.
- [ ] Confirm that `bench/`, the CLI benchmark command/tests, MCP Core 2 source/tests, the Core 2 agent template, historical `docs/`, `proto/`, `TL-*`, `DESIGN-*`, private reports, and desktop source are absent.
- [ ] Check every public document and package README for benchmark claims, private paths, internal design links, and stale LiteLLM-proxy references.
- [ ] Obtain appropriate legal review of the maintainer license draft kept outside the public staging tree, then use only the approved text as the release's `LICENSE`.
- [ ] Replace the root `LICENSE` and every package metadata license field with the approved source-available terms before publishing. The currently checked-in MIT labels must not be released alongside the policy in [Licensing](licensing.md).
- [ ] Run the third-party dependency license check and publish the required notices.
- [ ] Include the approved license text in the VSIX and confirm the packaging command emits no missing-license warning.

## 2. Source build and developer-test gate

The public source must support building and testing without the private benchmark harness.

```bash
npm install
npm run build
npm run test:packages
npm run test:bundle-cli
npm run licenses
npm run licenses:notices
git diff --exit-code -- THIRD_PARTY_NOTICES.md
npm audit --omit=dev --audit-level=high
npm run doctor
```

- [ ] Run the commands above from a clean clone of the staged public repository.
- [ ] Confirm the runtime audit remains free of Critical and High findings. This is the v0.9.0 release gate.
- [ ] Run a separate full `npm audit` and record the development-toolchain result. The 2026-08-16 known baseline is 1 Critical, 1 High, and 5 Moderate findings; these development-only findings are disclosed but are not a v0.9.0 release blocker.
- [ ] Do not use the root `npm test` command in public CI unless it has been changed: it currently includes private benchmark tests.
- [ ] Configure GitHub Actions for Node.js 20 on macOS, Ubuntu, and Windows, running the six public commands above.
- [ ] Rewrite the staged public `package.json` scripts so `npm run build` references only included workspaces and `npm test` runs only public package and VSIX bundle tests; remove the private benchmark commands.
- [ ] Confirm `tl help` contains no benchmark command, `tl bench` returns the ordinary unknown-command error, and generated package output contains no benchmark or Core 2 implementation.
- [ ] Confirm that generated package output and tests do not depend on excluded files.
- [ ] Install the packed CLI/MCP packages in a clean temporary consumer and confirm module import plus MCP `initialize` and `tools/list` succeed with exactly three tools.

## 3. VS Code extension gate

```bash
npm run package -w tokenlighten-vscode-extension
```

- [ ] Build the VSIX from the public repository without a missing-license warning, and inspect its contents for the approved license file.
- [ ] Install the VSIX in a clean VS Code profile or test machine.
- [ ] Open a trusted sample workspace and run **Set up this workspace**.
- [ ] Confirm the extension can be disabled and re-enabled for that workspace.
- [ ] Record the exact VSIX filename and version.

## 4. Artifact integrity gate

Generate a checksum for the exact VSIX that will be uploaded.

macOS and Linux:

```bash
shasum -a 256 tokenlighten-vscode-extension-<version>.vsix > tokenlighten-vscode-extension-<version>.vsix.sha256
```

Windows PowerShell:

```powershell
Get-FileHash .\tokenlighten-vscode-extension-<version>.vsix -Algorithm SHA256
```

- [ ] Verify the checksum file names the correct artifact.
- [ ] Preserve the VSIX and checksum as release assets.
- [ ] Verify the source commit SHA that produced the VSIX.

## 5. Manual GitHub release

- [ ] Review the final public repository tree, the fresh root commit, and GitHub Actions results.
- [ ] Create and push the approved `v0.9.0` tag manually from the reviewed public commit.
- [ ] Draft the GitHub Release with a concise description, installation steps, licensing summary, known limitations, and the VSIX checksum.
- [ ] Attach the VSIX and its checksum file.
- [ ] Publish the GitHub Release only after a final maintainer review.

The desktop application is deferred from this release.
