/**
 * Runtime registry for the advertised tool names.
 *
 * The protocol helpers need a tool-name guard, but importing `server.ts` from
 * them would create a cycle (the server owns the declaration schema). Keep a
 * small compatibility fallback for standalone protocol tests, then let the
 * server replace it from `ALL_TOOLS` during bootstrap. This makes the live
 * allowlist follow the declaration rather than a second hand-maintained list.
 */
const FALLBACK_TOOL_NAMES = new Set(["read_file", "edit_file", "search_files"]);
let currentToolNames: ReadonlySet<string> = FALLBACK_TOOL_NAMES;

export function setAdvertisedToolNames(names: Iterable<string>): void {
  currentToolNames = new Set(names);
}

export function isAdvertisedToolName(name: string): boolean {
  return currentToolNames.has(name);
}

/** Test/readback hook for the schema-derived registry. */
export function advertisedToolNames(): ReadonlySet<string> {
  return currentToolNames;
}
