// esbuild `inject` shim: every bundled source file here is ESM
// ("type":"module") and several use `import.meta.url` to find sibling files
// relative to their OWN compiled location (repoRoot.ts's sentinel walk,
// agents-md's TEMPLATE_DIR, treeSitter.ts's/indexStore.ts's
// createRequire(import.meta.url), mcp-server bin.ts's IS_MAIN check,
// server.ts's SERVER_BUILD_ID). esbuild's "cjs" output format does not
// support import.meta — see esbuild's own "empty-import-meta" warning — so
// plain bundling would silently make import.meta.url resolve to undefined.
//
// Since everything is bundled into ONE output file, __filename (a real CJS
// module-wrapper variable Node assigns to the actual file being executed)
// already names exactly what every one of those call sites wants: the
// bundle's own on-disk location. Re-deriving import.meta.url from it here,
// then swapping every `import.meta.url` reference for this value via
// esbuild's `define`, keeps that resolution intent intact post-bundle.
export const import_meta_url = require("node:url").pathToFileURL(__filename).href;
