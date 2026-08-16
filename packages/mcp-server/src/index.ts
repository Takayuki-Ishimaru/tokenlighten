// @tokenlighten/mcp-server — library entry points for the TokenLighten MCP server.
//
// The served surface is the three advertised tools (`read_file`, `edit_file`,
// `search_files`), dispatched in server.ts; this module re-exports the
// library-level helpers that tooling and tests import directly.
// Tool responses carry PLAIN data — no meta envelope, no 'tokenlighten:meta'.
// Reason: docs/00-postmortem.md §2.2 — meta envelope dominated cache_write cost.
// Full spec: docs/components/02-mcp-server.md

export { run, advertisedTools } from "./server.js";
export { getFileSkeleton } from "./tools/getFileSkeleton.js";
export { getSymbolWithContext } from "./tools/getSymbolWithContext.js";
export { extractOfficeText } from "./tools/extractOfficeText.js";
export { readCodePack } from "./tools/readCodePack.js";
export { locateTaskContext } from "./features/locator/locateTaskContext.js";

export type { GetFileSkeletonInput } from "./tools/getFileSkeleton.js";
export type { GetSymbolWithContextInput } from "./tools/getSymbolWithContext.js";
export type { ExtractOfficeTextInput } from "./tools/extractOfficeText.js";
