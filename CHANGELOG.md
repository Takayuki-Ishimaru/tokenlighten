# Changelog

User-facing release highlights for TokenLighten.

## 0.14.0

- Improved continuation and recovery calls when response budgets or search
  scope prevent a request from completing.
- Made discovery more focused for edits that identify unique source text.
- Improved task and workspace continuity across retries.
- Made context handling consistent with the content returned to the client.
- Clarified local usage information in the CLI and VS Code extension.
- Updated dependencies to address security issues.

### Migration

Legacy v0.12/v0.13 request fields are refused by default. Update custom clients
to the current request format in [MCP tools](release-docs/mcp-tools.md).
`TL_LEGACY_INPUT=accept` is available as a temporary server-side migration
bridge. `TL_LITERAL_FIRST_ROUTING=0` restores the previous discovery routing.

The obsolete settings `TL_INTERFACE_AUTHORITY`, `TL_POST_READY_TRIM`,
`TL_POST_READY_TRIM_N`, `TL_OVERLAP_TRIM`, `TL_ADAPTIVE_WHOLE_FILE`,
`TL_VERIFICATION_RECIPE`, `TL_HOP1_CLOSURE`, `TL_EVIDENCE_SHADOW`,
`TL_EVIDENCE_COMPLETION`, `TL_WRITE_CAPABILITY`, and `TL_SCHEMA_DEFS`
were removed.

The following optional settings were consolidated:

| Previous setting | Replacement |
|---|---|
| `TL_RRF_PROFILES` | `TL_RRF_FUSION=profiles` |
| `TL_COVERAGE_PACKER_V2` | `TL_COVERAGE_PACKER=v2` |
| `TL_COMPOUND_RETRIEVAL` | `TL_GRAPH_EVIDENCE=compound` |

The server remains read-only by default; writes require `--allow-write`.

### Known limitations

- A rare response-budget fallback can still return a generic JSON-RPC error;
  retry with a larger `budget` or a narrower target.
- Read plain files separately from archive or document members in
  multi-target requests.

See the [v0.14.0 release notes](release-docs/github-release-v0.14.0.md).

## 0.13.1

- Isolated task and edit context between concurrent agent lanes.
- Corrected multi-target range reads and batches that create and edit files.
- Prevented repeated completed continuations and looping pathless discovery.
- Improved completion checks for requests containing multiple requirements.
- Included exploration calls in task-level local usage estimates.

See the [v0.13.1 release notes](release-docs/github-release-v0.13.1.md).

## 0.13.0

- Introduced the canonical grouped request fields for the three MCP tools.
- Improved completion checks, continuation handling, and replay-safe edits.
- Added automatic refresh of cached MCP tool definitions in VS Code.
- Updated managed agent instructions for the canonical request format.

See the [v0.13.0 release notes](release-docs/github-release-v0.13.0.md).

## 0.12.1

- Updated dependencies and removed unused packages.
- Hardened configuration parsing, source scanning, and document extraction.
- Improved handling of generated text and random edit handles.

See the [v0.12.1 release notes](release-docs/github-release-v0.12.1.md).

## 0.12.0

- Improved task continuity, Japanese-language retrieval, and large-file reads.
- Added Markdown heading outlines and more compact edit responses.
- Made unsupported-encoding writes fail without changing files.
- Improved setup guidance, diagnostics, and nested CLI help.

See the [v0.12.0 release notes](release-docs/github-release-v0.12.0.md).

## 0.11.1

- Improved task continuity across server restarts.
- Added clearer search coverage and file freshness checks.
- Improved batched discovery and bounded edits.
- Expanded workspace setup and VS Code diagnostics.

See the [v0.11.1 release notes](release-docs/github-release-v0.11.1.md).

## 0.9.0

- First public beta with the CLI, MCP server, and self-contained VS Code
  extension.
- Three tools for focused reads, searches, and bounded edits.
- Local repository indexing and read-only operation by default.
- Support for common programming languages and selected document and
  archive formats.

See the [v0.9.0 release notes](release-docs/github-release-v0.9.0.md).
