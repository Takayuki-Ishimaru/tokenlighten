# Server implementation owners

`../server.ts` retains the public API. Its modules use direct owner imports,
without importing internal helpers back through the facade.

| Owner family | Responsibility |
| --- | --- |
| `../runtime/config.ts` | One startup configuration, live workspace/client bindings and session reset |
| `../runtime/requestState.ts` | One operations set, credited-read map and inherited-profile weak set |
| `../runtime/bootstrap.ts` | Ordered registration of advertised names, emitted-call validation and workspace guards |
| `tool-schema*`, `canonical-*` | Advertisement, input dialect and canonical normalization |
| `workspace-routing*`, `read-admission*` | Cwd, boundary and read admission |
| `task-binding*`, `task-pack-*` | Authenticated task scope and pack execution/wire projection |
| `read-receipts*`, `artifact-csv*` | Served ranges, receipts and artifact paging |
| `edit-*`, `operation-*` | Validation, edit recovery, atomic result handling and operation replay |
| `autofollow*`, `rpc.ts` | Bounded continuation composition and transport-facing entry points |

The three dispatch arms are in `../mcp/dispatch/`. Read modes have separate
modules under its `read/` directory. Mutating preflight locals remain in the
common read dispatcher; mode handlers receive explicit typed request values.
Services and live state come from their owning modules. Batch settlement and
atomic edit completion retain one path.

Bootstrap callbacks remain lazy and run once, after owner initialization, in
their original registration order. Build/package identity is derived from the
canonical server location; source builds also hash extracted implementation
paths and bytes. Keep transport entry imports on the public facade so startup
registration occurs before serving requests.

`dispatchGuardConformance.spec.ts` follows the actual switch and imported mode
handlers. `servedBytesDoors.spec.ts` scans all extracted implementation roots.
Fresh-process, pooled-reset and wire-replay checks are necessary when
changing ownership or initialization.
