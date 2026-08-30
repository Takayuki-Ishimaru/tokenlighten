# TokenLighten v0.13.1

**Public Beta reliability update.** TokenLighten v0.13.1 improves correctness
for concurrent agents and canonical v0.13 request shapes without changing the
MCP surface: `read_file`, `search_files`, and `edit_file`. The server remains
read-only unless started with `--allow-write`.

## Highlights

- **Reliable concurrent-agent lanes.** Task readiness, served context, and edit
  state are isolated per lane.
- **Consistent batch operations.** Ranged multi-target reads and batches that
  create files while editing existing files now behave as documented.
- **More honest completion.** Completed continuations are not proposed again,
  pathless tree discovery cannot loop, and checklist-style requests must prove
  or disclose every item before completion.
- **Less overhead for known targets.** Explicit creates and uniquely identified
  literal edits serve less unrelated neighboring context.
- **Task-scoped local estimates.** Savings accounting includes exploration calls
  in the task total. New logs use `schemaVersion: 2`; version-1 logs remain
  readable.
- **Explicit recovery instead of silent omission.** Unsupported mixed-target
  reads and workspace-coherence failures return a refusal with a recovery path.

See the [changelog](../CHANGELOG.md) for the complete v0.13.1 inventory.

## Compatibility

- The three advertised tools, their schemas, and the schema stamp are unchanged
  from v0.13.0.
- Writes still require explicit `--allow-write`.
- Legacy v0.12 field spellings remain compatibility-only in v0.13.x and are
  scheduled for removal in v0.14.
- `TL_PROOF_COMPLETION` defaults to on; `TL_SCHEMA_DEFS` defaults to off.
- The desktop application and private benchmark harness are not included in
  the public source release.

## Validation summary

The release candidate passed the package and benchmark-library test suites,
protocol follower and release-rehearsal checks, generated-artifact checks,
dependency-license checks, and runtime and full dependency audits. The
advertised schema remains within the v0.13.0 compatibility ceiling.

## Benchmark disclosure

The v0.13.1 developer benchmark produced a TokenLighten/native aggregate cost
ratio of **0.809**, a point estimate of **19.1% lower task cost**. Both
configurations solved and verified all 18 evaluated tasks.

| Task pattern | v0.13.1 vs native |
|---|---:|
| Cross-module decision tracing and downstream wiring | **29.0% lower** |
| Related multi-bug fix across control and mode transitions | **17.9% lower** |
| Spreadsheet-driven rating-rule implementation | **16.7% lower** |
| Narrow calculation or data-integrity fix | **7.3% lower** |
| Priority behavior spanning related feature paths | **7.4% lower** |

Localized explanation work was more sensitive to fixed overhead and remains an area for improvement.

Median solver turns were 29.2% lower with TokenLighten. These are
developer-run observations, not guaranteed savings. Results vary by repository,
task, client, model behavior, evaluation window, and provider pricing.

## Install the VS Code extension

Download `tokenlighten-vscode-extension-0.13.1.vsix` from the Assets section.
The same VSIX works on Windows, macOS, and Linux and includes the CLI, MCP
server, approved license, and generated third-party notices.

Verify the downloaded VSIX against the `SHA256SUMS` release asset:

```text
e91b790850d1211590cef91d652050f07be33245655278b8bc04f72691118865  tokenlighten-vscode-extension-0.13.1.vsix
```
