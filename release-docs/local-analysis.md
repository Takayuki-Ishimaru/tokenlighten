# Local analysis engines

TokenLighten v0.16.0 adds configurable local analysis behind the existing
three MCP tools. No additional MCP tool is required.

## Defaults and scope

| Engine | Default | Requirements |
|---|---|---|
| Compound request composition | On | No separate installation. |
| Typed symbol resolution | Off | Built-in TypeScript/JavaScript compiler integration, or an installed language server for other supported languages. |
| Multilingual semantic search | Off | An explicitly downloaded local model. |

Settings apply to the current user and are stored in
`~/.tokenlighten/engines.json`. The model cache defaults to
`~/.tokenlighten/models`. Reconnect MCP clients after changing settings.

Inspect the effective configuration:

```sh
tl engines status --json
tl engines --help
tl models list --json
```

For an archive installation whose launcher is not on PATH, replace `tl`
with the absolute installed launcher described in
[Getting started](getting-started.md#roll-back).

## Typed symbol resolution

Enable resolution for supported definition, type-definition and reference
lookups:

```sh
tl engines set typedSymbols on
```

TypeScript and JavaScript use the built-in compiler integration unless a
server is configured. Python, Go, Rust, Java, C, C++, C#, Kotlin, PHP and
Ruby require an appropriate language server installed separately.

For example, configure an installed Go language server:

```sh
tl engines server go gopls
```

Automatic discovery of installed servers on PATH is off by default.
Opt into it explicitly if desired:

```sh
tl engines discovery on
```

Configure executables you trust. TokenLighten does not install language
servers. Resolution depends on the server and project configuration;
unresolved or ambiguous locations remain disclosed. This feature does not
turn lexical rename and edit operations into fully type-aware refactoring.

## Local multilingual semantic search

Review model status and licensing before downloading:

```sh
tl models list --json
tl models licenses
tl models install
```

`tl models install` downloads the pinned
`Xenova/multilingual-e5-small` model and enables semantic search after the
download completes successfully. Model weights are not bundled in the
archives or VSIX. Downloads require network access; subsequent embedding
inference uses local files and the CPU. The packaged runtime includes a
portable CPU WASM backend.

Queries and repository content are processed locally by this engine.
Your coding agent's separate requests to its model provider still follow
that client's own settings and terms. See
[Privacy, security, and support](privacy-security-support.md).

Long source lines are split into bounded windows without dropping text.
The engine can retain several relevant regions from the same file, expand a
region to its containing function when it fits, and merge adjacent or
overlapping windows from the same source snapshot. Disjoint regions retain
their original source locations. These bounds can leave a larger function
only partially represented.

The tokenizer checks the complete formatted model input, including path and
prefix, before inference. Inputs exceeding the model limit use the bounded
fallback instead of being silently truncated. The model and default settings
are unchanged.

Semantic similarity helps discover candidates. It does not prove complete
coverage, a correct answer, or the absence of a symbol. Missing model
files, time limits or unavailable backends can leave the engine unavailable
or its results partial.

## Disable an engine

```sh
tl engines set typedSymbols off
tl engines set semanticSearch off
tl engines set compoundRequests off
tl engines discovery off
```

These commands change configuration; disabling semantic search does not
delete its downloaded model cache.

## VS Code controls

Open **TokenLighten: Manage Local Analysis Engines** from the Command Palette. The panel
shows engine settings, configured language servers and model status. It can
download the model, configure a server, and open the licenses view.
Changes require a trusted workspace. Reconnect MCP clients afterward.

Open **TokenLighten: View Licenses** for bundled notices and model licensing.
The pinned model metadata is also included in
[MODEL_LICENSES.json](../MODEL_LICENSES.json), with the upstream MIT notice.
