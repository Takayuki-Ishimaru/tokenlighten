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

## Pull requests

Keep each pull request focused, describe the user-visible behavior, add regression coverage for behavior changes, and note the commands you ran. Do not include credentials, private repositories, customer data, benchmark corpora, local usage logs, or generated build output.

TokenLighten intentionally advertises exactly three MCP tools: `read_file`, `edit_file`, and `search_files`. Changes to shared contracts belong in `packages/types/src/`.

Dependencies using GPL, AGPL, SSPL, BSL, or Elastic License 2.0 are not accepted. Run `npm run licenses` after dependency changes.

By submitting a contribution, you represent that you have the right to submit it and agree that it may be distributed under the project's current license terms.
