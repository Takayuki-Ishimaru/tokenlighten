/**
 * Compatibility barrel for the original MCP contract entry point.
 * Keep the export groups in declaration order; runtime values live only in
 * mcp/languages.ts.
 */
export { MCP_LANGS, MCP_LANG_EXTS } from "./mcp/languages.js";
// DESIGN-v0.15 §8.2 (R7 Part B): value exports for the code/full tool
// surface — `export type *` below carries `ToolSurface` itself but not these.
export { TOOL_SURFACE_VALUES, isToolSurface } from "./mcp/tool-surface.js";
export type * from "./mcp/index.js";
