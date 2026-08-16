/**
 * Compatibility facade for the historical task-pack module path.
 *
 * The implementation now lives under features/task-pack so the MCP tool
 * adapter layer no longer owns the task-pack domain. Keep this re-export until
 * all package-internal and downstream imports have migrated.
 */
export * from "../features/task-pack/readCodeTaskPack.js";
