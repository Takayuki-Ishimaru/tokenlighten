# Public-source manifest

## Purpose

The existing TokenLighten repository contains private development history, benchmarks, internal design material, and release working files. Do **not** make that repository public.

Create a new, empty GitHub repository and build its contents from an allowlist. Start it with a new root commit; do not copy the existing `.git` directory, branches, tags, or commit history.

This manifest is a release-selection guide, not an automated copy command. Review every copied file for secrets, customer data, absolute paths, and internal references. Start the staging repository with [the public package template](templates/public-package.json), [the public CI template](templates/public-ci.yml), and [the public `.gitignore` template](templates/public.gitignore), then regenerate and review `package-lock.json` in the staged tree.

## Allowlist for the new public repository

Include only the material required to build, test, and use the released source:

- the public root files: `README.md` (after its public rewrite), `LICENSE`, `NOTICE` or third-party notices if supplied, `CHANGELOG.md` (publicly rewritten), a public-safe `package.json`, `package-lock.json`, TypeScript/Vitest configuration, and public GitHub workflow files. The public root scripts must build only included workspaces and the default test command must not reference the excluded benchmark harness;
- build and release scripts required by the public commands, after reviewing their inputs and output paths;
- the public portions of `packages/types/`, `packages/usage/`, `packages/skeleton-engine/`, `packages/agents-md/`, `packages/cli/`, `packages/mcp-server/`, and `packages/vscode-extension/`, including source, package metadata, and public package tests. Apply the file-level exclusions below rather than copying these directories wholesale;
- a public, sanitized copy of these documents, including the reviewed v0.12.0 release note and its aggregate benchmark disclosure; and
- public release assets such as the VSIX and its checksum.

The `packages/agents-md/templates/` content is an explicit review gate. Do not copy a template that includes benchmark instructions, private repository guidance, or internal-only paths. Replace it with the approved public guidance before including it.

## Do not copy

Exclude the following from the new public repository:

- `bench/` and all benchmark inputs, outputs, fixtures, reports, billing data, and run archives;
- `packages/cli/src/commands/bench.ts` and every CLI benchmark-specific test or fixture;
- `packages/mcp-server/src/core2/`, `packages/agents-md/templates/core2.md.tmpl`, and every Core 2-specific test or fixture; the public copy of `server.ts` must not import, dispatch, advertise, or accept the private Core 2 protocol;
- the existing `docs/`, `proto/`, `prep/`, and private report directories;
- every `*.draft` file, including the maintainer-only license review draft;
- files and directories whose names begin with `TL-`, `DESIGN-`, or `tokenlighten-bench-`;
- `TL-CORE2-EVIDENCE/` and other rehearsal, adjudication, or evidence material;
- desktop application source and build outputs for this release;
- local editor/agent configuration, credentials, environment files, caches, build outputs, and all Git metadata; and
- any file that references an internal path, an undisclosed security issue, an unreviewed benchmark claim or raw benchmark data, customer data, or a private service. Only the reviewed aggregate summaries in the public `README.md`, public `CHANGELOG.md`, and `release-docs/github-release-v0.12.0.md` are allowlisted benchmark disclosures for this release.

When in doubt, leave it out and add it later through a reviewed public-repository commit.

## Fresh-history procedure

1. Create a new empty private repository on GitHub.
2. Assemble the allowlisted files in a clean staging directory outside the current repository.
3. Review the staging tree against this manifest and run secret scanning.
4. Initialize Git in that staging directory and create one new root commit.
5. Run the public build and test gates from [Release checklist](release-checklist.md).
6. Review the exact staged diff and artifact contents.
7. Change the GitHub repository visibility only after the maintainer's manual approval.

Do not push or change visibility automatically.
