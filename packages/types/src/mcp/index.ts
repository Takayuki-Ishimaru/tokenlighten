// ---------------------------------------------------------------------------
// The `packages/types/src/mcp` barrel.
//
// protocol v1 (A.9.1's "Barrel" paragraph): this barrel re-exports
// `ProtocolResult`, `Kind`, `Refusal` and the four family unions —
// `ReadResult` / `SearchResult` / `EditResult` / `Refusal` itself, the
// single-member refusal family. A downstream SDK's exhaustive switch (§6.1(g))
// imports `ProtocolResult` AND NOTHING ELSE, which is what makes the tier-2
// classifier meaningful: adding a member breaks that one import site.
//
// The pre-v1 modules below (`read-edit`, `artifact`, and the pre-v1 halves of
// `task-pack`/`archive`) stay exported while the emitters still read them; the
// P2 emitter migration removes their last use. D8 HAS ALREADY RUN for
// `legacy-read`: all six of its types are gone from this package — the three
// request shapes and their payload shapes now live beside their single emitter
// in `packages/mcp-server/src/tools/`, and `GetFileSkeletonOutput`'s fields
// survive on the wire as `StructuralOutline`'s `signatures` form (A.5.3).
// ---------------------------------------------------------------------------

export { MCP_LANGS, MCP_LANG_EXTS } from "./languages.js";
export type { McpLang } from "./languages.js";

// protocol v1 (A.9.1)
export type * from "./protocol.js";
export type * from "./decision.js";
export type * from "./receipts.js";
export type * from "./read-result.js";
export type * from "./search-result.js";
export type * from "./edit-result.js";
export type * from "./request-shape.js";

// pre-v1, still live
export type * from "./locate-impact.js";
export type * from "./read-edit.js";
export type * from "./task-pack.js";
export type * from "./artifact.js";
export type * from "./archive.js";
