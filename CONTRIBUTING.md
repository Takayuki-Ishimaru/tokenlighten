# Contributing to TokenLighten

Thank you for helping improve TokenLighten.

## Development setup

TokenLighten requires Node.js 20 or later.

```sh
npm ci
npm run build
npm run test:packages
npm run test:bundle-cli
npm run licenses
npm run doctor
```

Run the narrowest relevant workspace test first while developing, then run the full public checks above before opening a pull request. Tests live alongside the TypeScript source under `packages/*/src/`.

The complete package suite is a CI gate on Ubuntu and macOS. Windows CI verifies the build, bundled CLI, dependency licenses and notices, runtime dependency audit, and diagnostics. Some test fixtures are not yet portable to Windows, so the complete package suite is not a Windows release gate for v0.9.0. Windows developers can still build the source and run targeted tests; please identify the operating system in pull-request test notes.

## Pull requests

Keep each pull request focused, describe the user-visible behavior, add regression coverage for behavior changes, and note the commands you ran. Do not include credentials, private repositories, customer data, benchmark corpora, local usage logs, or generated build output.

TokenLighten intentionally advertises exactly three MCP tools: `read_file`, `edit_file`, and `search_files`. Changes to shared contracts belong in `packages/types/src/`.

Dependencies using GPL, AGPL, SSPL, BSL, or Elastic License 2.0 are not accepted. Run `npm run licenses` after dependency changes.

By submitting a contribution, you represent that you have the right to submit it and agree that it may be distributed under the project's current license terms.
