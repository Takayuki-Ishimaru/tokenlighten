// clientAdvertisement.ts — per-MCP-client advertisement variants.
//
// WHY THIS EXISTS. VS Code's built-in MCP client (surfaced through GitHub
// Copilot Chat) defers every MCP tool's description/schema behind Copilot's
// own `tool_search` tool: the model initially sees only a bare tool NAME
// (e.g. one ending in `tokenlighten_read_file`) inside an
// `<availableDeferredTools>` list, and must call `tool_search` before it can
// see a description or a schema at all. That bare name collides in spirit
// with Copilot's OWN built-in `read_file` file reader — field observation
// has shown a model claiming to use TokenLighten while actually calling the
// built-in reader instead, having never loaded (or forgotten, after a
// conversation summary, since a deferred-tools list is re-offered but
// nothing forces a reload) the real tool. Unlike most MCP hosts, VS Code
// DOES inject the server's `initialize`-time `instructions` string into its
// system prompt on every single request, regardless of whether any tool has
// been loaded yet — so that string is the one announcement point that can
// land this disambiguation before a routing mistake happens, from turn 0.
//
// And because a deferred tool's description/schema costs nothing until the
// model actually loads it (unlike hosts that pay for every advertised
// description on every turn, which is why server.ts's `ALL_TOOLS` keeps its
// default descriptions at ~30-40 chars), VS Code can also afford noticeably
// richer per-tool descriptions once a tool IS loaded — described here too —
// so the model calls the right shape on the first try instead of spending a
// whole extra turn recovering from a malformed call.
//
// SCOPE. This module is pure and data-only, with NO import from server.ts —
// the same discipline protocol/serverInstructions.ts's own header documents
// and for the same reason: all three `initialize` sites (server.ts's
// hand-rolled `handleRequest`, the legacy SDK v1 leg in
// mcp/transport/legacyStdio.ts, and the modern SDK v2 leg in
// mcp/transport/modernServerFactory.ts) can then import this module directly
// with no risk of a cycle through server.ts.
//
// TODAY, only server.ts's hand-rolled leg (the fallback path used when the
// SDK import fails — see mcp/transport/fallbackStdio.ts) actually resolves a
// client end-to-end through this module: `handleRequest`'s "initialize" case
// captures `clientInfo.name` and both the `instructions` field and the
// paired `tools/list` response become client-aware from that same captured
// id (server.ts's `resolvedClientId()`). The two SDK-backed legs
// (legacyStdio.ts, modernServerFactory.ts) are NOT wired the same way yet —
// confirmed by reading the installed `@modelcontextprotocol/sdk` v1 source
// (node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js): its
// `Server` class captures `clientInfo` into a private `_clientVersion` field
// during its OWN internal `initialize` handling, but neither leg's code here
// reads it back (via `getClientVersion()`) or threads it into
// `advertisedTools()`/this module. Because `@modelcontextprotocol/sdk` v1 IS
// installed and that leg's `tryRunWithSdk()` therefore succeeds, it is the
// leg that actually serves a normal connection — including, in all
// likelihood, VS Code's — today, so wiring those two legs the same way
// server.ts's hand-rolled leg now is remains an open follow-up (each would
// need its own `initialize`/`tools/list` change; both files are outside this
// change's ownership boundary). This module's own shape does not block that
// follow-up: a future wiring only needs to call the same two functions this
// file exports (`baseServerInstructionsForClient`/`toolDescriptionForClient`)
// with whatever clientId that leg resolves.
//
// A FUTURE HOST. Nothing below is VS-Code-specific in SHAPE — only in DATA
// (the `VSCODE_SERVER_INSTRUCTIONS`/`VSCODE_TOOL_DESCRIPTIONS` constants, and
// the "vscode" profile id `resolveClientProfile` already recognizes by
// clientInfo.name substring — see codec/clientProfile.ts). Adding a second
// host with its own advertisement quirks means adding its own constants and
// one more branch inside `baseServerInstructionsForClient`/
// `toolDescriptionForClient`; callers (server.ts) do not change.
//
// DEFAULT BEHAVIOR IS BYTE-IDENTICAL. Every function below returns
// `undefined` (for a per-tool description override) or the pre-existing
// default text (for the base instructions) for any client that does not
// resolve to the "vscode" profile — including the "unknown" profile (no
// clientInfo captured, or a clientInfo.name nothing recognizes). That is
// what keeps every non-VS-Code host (Claude Code, Codex, etc.) byte-for-byte
// unchanged; see clientAdvertisement.spec.ts and the untouched
// serverInstructions.spec.ts / schemaSize.spec.ts / protocol-v1-snapshot.json
// pins, none of which ever thread a VS Code clientInfo through
// `handleRequest`/`advertisedTools()`.

import { SERVER_INSTRUCTIONS } from "./serverInstructions.js";
import { resolveClientProfile } from "./codec/clientProfile.js";

/** The three advertised tool names this module carries a VS Code-specific description for. */
export type AdvertisedToolName = "read_file" | "edit_file" | "search_files";

/**
 * VS Code / GitHub Copilot Chat's `initialize`-time `instructions` text.
 * ASCII-only, 999 B (measured; pinned in clientAdvertisement.spec.ts) —
 * under a 1000-byte budget. Unlike SERVER_INSTRUCTIONS
 * (paid once per connection by most hosts), VS Code re-injects this into its
 * system prompt on every request, so the budget is deliberately tighter than
 * "however much would fit."
 *
 * Covers, in order: (1) tool identity — TokenLighten's tools are MCP tools
 * whose names END IN tokenlighten_read_file/tokenlighten_edit_file/
 * tokenlighten_search_files (an "ends in" match, not an exact one, since the
 * exact prefix a host prepends is not this string's concern), and they are
 * DEFERRED — load with `tool_search {query:"tokenlighten"}` batched into the
 * SAME first tool call as whatever else the model calls first (never spend a
 * whole turn on tool_search alone), and again if they vanish after a
 * conversation summary; (2) disambiguation — bare read_file/edit_file/
 * search_files in TokenLighten's own text always mean these tools, never
 * Copilot's built-in read_file; (3) the same essential routing
 * SERVER_INSTRUCTIONS carries (TL first for code/doc/config; unknown-
 * location/multi-file => read_file {query:...}; act on act.answer/act.edit;
 * batch edits in one edits[] call; full protocol in AGENTS.md); (4) two VS
 * Code/Copilot-specific additions — write the query in the code's own
 * language (usually English) even when the user wrote in another language,
 * and "turns cost more than bytes": put every known file/range into one
 * targets:[...] call (or one parallel batch) rather than one call per file,
 * and continue an already-served handle via targets:[{handle,range}] with
 * no qref needed; (5) WP-V1 (2026-09-20) — under `leanCallsEnabled()` (see
 * util/flags.ts), envelope.ts's emitted read_file/search_files
 * continuations drop `cwd`/`task.handle` where they are redundant
 * (single-root workspace; a qref already carries the task), so the model
 * is told to do the same on the calls it authors itself. `targets[].purpose`
 * is NOT part of that cut: it is what tells the server what a caller-named
 * DIRECTORY is for (the directory-confined recovery in the seeded pack
 * builder locates with it first), so the text steers it onto directory
 * targets instead of asking the model to drop it.
 */
export const VSCODE_SERVER_INSTRUCTIONS =
  `TokenLighten tools are MCP tools whose names end in tokenlighten_read_file / tokenlighten_edit_file / tokenlighten_search_files; in your FIRST tool batch, next to whatever else you call first, also call tool_search {query:"tokenlighten"} - never spend a turn on it alone; again if they vanish after a conversation summary. Bare read_file/edit_file/search_files here mean these, never the built-in read_file. TL first for code/doc/config. Unknown-location/multi-file=>read_file {query:"<request>"}. Write query in the code's own language (usually English) even if the user wrote another. Turns cost more than bytes: every known file/range in ONE targets:[...] call or one parallel batch; reread served evidence via targets:[{handle,range}], no qref. On read_file/search_files omit cwd and task.handle (qref carries the task); targets[].purpose only on a directory. Act on act.answer/act.edit: use served evidence, batch edits in one edits[] call, stop after passing verification. Protocol: AGENTS.md.`;

/**
 * VS Code-specific tool descriptions — richer than the ~30-40 char defaults
 * in server.ts's `ALL_TOOLS` (those are tuned for hosts that pay for every
 * advertised description on every turn; VS Code pays nothing until the model
 * loads a deferred tool via `tool_search`, so the extra detail here is spent
 * helping it call the right shape on the FIRST try once it does). Each is
 * ~200-350 chars. Derived from AGENTS.md's "TokenLighten MCP" section; do
 * not invent a parameter here that section does not document — input
 * schemas themselves are identical across every client (see
 * clientAdvertisement.spec.ts).
 */
export const VSCODE_TOOL_DESCRIPTIONS: Readonly<Record<AdvertisedToolName, string>> = {
  read_file:
    `TokenLighten real file reader: exact code/doc/config slices plus edit handles, not a full-file read. First call: {query:"<task with code identifiers>", task:{epoch:"new"}}. Zoom via targets:[{path|handle, range}], batching several targets per call. Follow next/limit to continue. content:"full" for whole small files.`,
  edit_file:
    `TokenLighten file editor. Batch edits[] items in ONE call, each with path or handle plus search/replace (add precondition:"unique-match" for a single known value). create:true plus content makes a new file. Always pass top-level cwd so writes land in the right worktree.`,
  search_files:
    `TokenLighten code/text search. action:"find" with queries:[...] (up to 5 per call) locates identifiers or text; "references" finds call sites; "tree" inventories a directory. Set scope.path when the package/module is known.`,
};

/** True when `clientId` resolves (via clientProfile.ts's `resolveClientProfile`) to VS Code's built-in MCP client. */
function isVsCodeClient(clientId: string | undefined): boolean {
  return resolveClientProfile(clientId).id === "vscode";
}

/**
 * The base `instructions` text for this client — before any `Degraded: ...`
 * suffix, which stays server.ts's `buildInitializeInstructions*` job. VS
 * Code's own variant for the "vscode" profile; the exact
 * `SERVER_INSTRUCTIONS` every other/unknown client has always received
 * otherwise — that equality (not just similarity) is what keeps every
 * non-VS-Code host byte-for-byte unchanged.
 */
export function baseServerInstructionsForClient(clientId: string | undefined): string {
  return isVsCodeClient(clientId) ? VSCODE_SERVER_INSTRUCTIONS : SERVER_INSTRUCTIONS;
}

/**
 * This client's description override for `toolName`, or `undefined` to keep
 * that tool's own default `ALL_TOOLS` description — every client that is not
 * VS Code, including unknown, and any `toolName` this module has no VS
 * Code-specific text for. `undefined` (never a fallback string) is the
 * signal callers branch on, so an unrecognized `toolName` degrades to "no
 * override" instead of silently advertising the literal text "undefined".
 */
export function toolDescriptionForClient(
  clientId: string | undefined,
  toolName: string,
): string | undefined {
  if (!isVsCodeClient(clientId)) return undefined;
  return Object.prototype.hasOwnProperty.call(VSCODE_TOOL_DESCRIPTIONS, toolName)
    ? VSCODE_TOOL_DESCRIPTIONS[toolName as AdvertisedToolName]
    : undefined;
}
