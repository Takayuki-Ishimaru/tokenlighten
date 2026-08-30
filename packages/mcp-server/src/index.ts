// @tokenlighten/mcp-server — library entry points for the TokenLighten MCP server.
//
// The served surface is the three advertised tools (`read_file`, `edit_file`,
// `search_files`), dispatched in server.ts; this module re-exports the
// library-level helpers that tooling and tests import directly.
// Tool responses carry PLAIN data — no meta envelope, no 'tokenlighten:meta'.
// Reason: docs/00-postmortem.md §2.2 — meta envelope dominated cache_write cost.
// Full spec: docs/components/02-mcp-server.md

import { advertisedTools } from "./server.js";
import { computeSchemaStamp } from "./util/schemaStamp.js";

export { run, advertisedTools } from "./server.js";
export { getFileSkeleton } from "./tools/getFileSkeleton.js";
export { getSymbolWithContext } from "./tools/getSymbolWithContext.js";
export { extractOfficeText } from "./tools/extractOfficeText.js";
export { readCodePack } from "./tools/readCodePack.js";
export { locateTaskContext } from "./features/locator/locateTaskContext.js";
export { computeSchemaStamp, stableStringify } from "./util/schemaStamp.js";

/**
 * The schema stamp for THIS process's actual advertised tool surface (see
 * util/schemaStamp.ts for why this exists — VS Code MCP definition-cache
 * mitigation, v0.13.0). Subject to the same KILL_SWITCH / experimental-
 * protocol branching advertisedTools() itself applies.
 */
export function currentSchemaStamp(): string {
  return computeSchemaStamp(advertisedTools());
}

export type { GetFileSkeletonInput } from "./tools/getFileSkeleton.js";
export type { GetSymbolWithContextInput } from "./tools/getSymbolWithContext.js";
export type { ExtractOfficeTextInput } from "./tools/extractOfficeText.js";
