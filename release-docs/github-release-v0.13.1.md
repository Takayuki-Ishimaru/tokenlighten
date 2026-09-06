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

See the [changelog](../CHANGELOG.md) for release highlights.

## Compatibility

- The three advertised tools, their schemas, and the schema stamp are unchanged
  from v0.13.0.
- Writes still require explicit `--allow-write`.
- Legacy v0.12 field spellings remain compatibility-only in v0.13.x and are
  scheduled for removal in v0.14.
- `TL_PROOF_COMPLETION` defaults to on; `TL_SCHEMA_DEFS` defaults to off.
- The desktop application is not included in
  the public source release.

## Install the VS Code extension

Download `tokenlighten-vscode-extension-0.13.1.vsix` from the Assets section.
The same VSIX works on Windows, macOS, and Linux and includes the CLI, MCP
server, approved license, and generated third-party notices.

Verify the downloaded VSIX against the `SHA256SUMS` release asset:

```text
e91b790850d1211590cef91d652050f07be33245655278b8bc04f72691118865  tokenlighten-vscode-extension-0.13.1.vsix
```
