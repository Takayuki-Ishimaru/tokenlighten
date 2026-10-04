// ---------------------------------------------------------------------------
// The three advertised tool names, and the names they had before the `tl_`
// prefix (2026-10-02, Copilot retest r4).
//
// Why the prefix: GitHub Copilot's own built-in file reader is called
// `read_file` (Cline's built-ins include `read_file` and `search_files` too),
// and a model that only sees TokenLighten's guide — Copilot never shows its
// `tool_search`-less models the server's `instructions` — could not tell which
// tool a guide's `read_file {query:...}` meant.
//
// The old names are NOT accepted aliases: the advertised set and the accepted
// set stay the same set (server.ts D11), so a call to `read_file` is refused
// like any other unknown tool. They exist only to read records written before
// the rename (usage logs, host transcripts) and to name the replacement in
// that refusal.
// ---------------------------------------------------------------------------

import type { ToolName } from "./protocol.js";

/** Every advertised tool name, in declaration order. */
export const TOOL_NAMES: readonly ToolName[] = ["tl_read_file", "tl_edit_file", "tl_search_files"];

/** Pre-rename tool name → its current name. */
export const LEGACY_TOOL_NAMES: Readonly<Record<string, ToolName>> = {
  read_file: "tl_read_file",
  edit_file: "tl_edit_file",
  search_files: "tl_search_files",
};

/** The current name of a pre-rename tool name, or `undefined` for any other string. */
export function renamedToolName(name: string): ToolName | undefined {
  return Object.prototype.hasOwnProperty.call(LEGACY_TOOL_NAMES, name) ? LEGACY_TOOL_NAMES[name] : undefined;
}
