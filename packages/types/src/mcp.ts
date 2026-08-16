/**
 * Compatibility barrel for the original MCP contract entry point.
 * Keep the export groups in declaration order; runtime values live only in
 * mcp/languages.ts.
 */
export { MCP_LANGS, MCP_LANG_EXTS } from "./mcp/languages.js";
export type * from "./mcp/index.js";
