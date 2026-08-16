# Dependency security status

This document records the dependency advisories evaluated for TokenLighten v0.9.1. It is a dated engineering assessment, not a guarantee that no vulnerability exists. Re-run `npm audit --omit=dev` for the shipped runtime view and `npm audit` for the complete source-development view.

## Audit snapshot

Audit date: **2026-08-16**

| Installation | Critical | High | Moderate | Low |
|---|---:|---:|---:|---:|
| Runtime dependencies (`npm audit --omit=dev`) | 0 | 0 | 2 | 0 |
| Complete development installation (`npm audit`) | 0 | 0 | 2 | 0 |

The two Moderate scanner entries are `uuid` plus its parent package `exceljs`; they represent one underlying advisory.

## Current advisory assessment

| Advisory | Package path | Scope | Reachable from TokenLighten use? | Why it is not updated yet | Update plan |
|---|---|---|---|---|---|
| [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq) / CVE-2026-41907, Moderate | `exceljs@4.4.0` → `uuid@8.3.2` | Runtime and development | **No known reachable path.** The advisory requires `uuid` v3, v5, or v6 with a caller-provided output buffer. ExcelJS 4.4.0 imports and calls `uuid.v4()` only, and TokenLighten uses ExcelJS to load workbook data. | ExcelJS 4.4.0 is the current release and still declares `uuid ^8.3.0`. npm's automated suggestion is a downgrade to ExcelJS 3.4.0, which is not an acceptable remediation and does not move the dependency to a patched UUID generation. | Monitor ExcelJS releases and Dependabot weekly. Adopt a compatible upstream dependency update, then rerun workbook tests and both audits. Reassess immediately if TokenLighten or ExcelJS begins using the affected UUID APIs. |

## Development advisories resolved for v0.9.1

The following development-only advisories were resolved before v0.9.1 by updating the development toolchain:

| Advisory | Package | Scope and reachability before update | Resolution |
|---|---|---|---|
| [GHSA-5xrq-8626-4rwp](https://github.com/advisories/GHSA-5xrq-8626-4rwp), Critical | Vitest | Development only; the vulnerable UI/API server is not started by TokenLighten's normal test command or shipped VSIX. | Updated Vitest; the v0.9.1 lockfile resolves 3.2.7. |
| [GHSA-fx2h-pf6j-xcff](https://github.com/advisories/GHSA-fx2h-pf6j-xcff), High | Vite | Development only; TokenLighten does not ship or start a Vite development server. | Pinned Vite 6.4.3 through the root lockfile override. |
| [GHSA-4w7w-66w2-5vf9](https://github.com/advisories/GHSA-4w7w-66w2-5vf9), Moderate | Vite | Development only; requires a running Vite development server. | Pinned Vite 6.4.3. |
| [GHSA-v6wh-96g9-6wx3](https://github.com/advisories/GHSA-v6wh-96g9-6wx3), Moderate | Vite / launch-editor | Development only; requires the development-server editor-launch middleware on Windows. | Pinned Vite 6.4.3. |
| [GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99), Moderate | esbuild | Development only; TokenLighten uses esbuild's build API and does not start its vulnerable serve mode. | Updated direct esbuild use to 0.28.2; the audited dependency tree is patched. |

## Release policy

Critical or High findings in dependencies used by the installed VSIX or normal runtime block a release unless a documented reachability review proves that the vulnerable path cannot be invoked. Development-only findings are disclosed and prioritized, but are evaluated separately from the runtime release gate.
