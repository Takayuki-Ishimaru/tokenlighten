// clientAdvertisement.ts — per-MCP-client advertisement variants.
//
// WHY THIS EXISTS. VS Code's built-in MCP client (surfaced through GitHub
// Copilot Chat) treats a model one of two ways, and Copilot retest r4
// (2026-10-02, the request bodies of every round) measured both:
//
//  - a model with `tool_search` (GPT-6 Luna) sees only a bare tool NAME (one
//    ending in `tl_read_file`) in an `<availableDeferredTools>` list and must
//    call `tool_search` before it sees a description or a schema; Copilot puts
//    this module's `initialize`-time `instructions` string into that model's
//    system prompt (`<instruction forToolsWithPrefix="mcp_">`) on every
//    request, loaded tool or not;
//  - a model without it (MAI flash) receives every tool's FULL description and
//    schema on every round and never sees the `instructions` string at all.
//
// Before the tl_ prefix (same date) the bare name `read_file` collided with
// Copilot's OWN built-in `read_file` file reader, and the only text that told
// the two apart lived in `instructions`, which the second kind of model never
// receives; field observation also showed a model claiming to use
// TokenLighten while calling the built-in reader. The prefix ends the
// collision for both.
//
// For the first kind of model a deferred tool's description/schema costs
// nothing until it is loaded, which is why the per-tool descriptions below
// may be richer than server.ts's ~30-40 char defaults (the model calls the
// right shape on the first try instead of recovering from a malformed call).
// For the second kind they are paid on every round, so they stay short.
//
// SCOPE. This module is pure and data-only, with NO import from server.ts —
// the same discipline protocol/serverInstructions.ts's own header documents
// and for the same reason: both `initialize` sites (server.ts's hand-rolled
// `handleRequest`, served over stdio by mcp/transport/legacyStdio.ts, and the
// modern SDK v2 leg in mcp/transport/modernServerFactory.ts) can then import
// this module directly with no risk of a cycle through server.ts.
//
// TODAY, server.ts's hand-rolled leg — the legacy-era stdio transport, which
// serves EVERY legacy-era connection (an @modelcontextprotocol/sdk v1 leg was
// once believed to serve them and thought to leave a "gap" here; it never ran,
// see mcp/transport/legacyStdio.ts's header) — resolves a client end-to-end
// through this module: `handleRequest`'s "initialize" case captures
// `clientInfo.name` and both the `instructions` field and the paired
// `tools/list` response become client-aware from that same captured id
// (server.ts's `resolvedClientId()`). The modern SDK v2 leg
// (modernServerFactory.ts) is NOT wired the same way yet: the SDK resolves its
// own `initialize`/`server/discover` and nothing here reads the client's
// identity back from it or threads it into `advertisedTools()`/this module
// (TOKENLIGHTEN_CLIENT_ID can supply the id meanwhile), so wiring it remains
// an open follow-up needing its own `initialize`/`tools/list` change. This
// module's own shape does not block that follow-up: a future wiring only needs
// to call the same two functions this file exports
// (`baseServerInstructionsForClient`/`toolDescriptionForClient`) with whatever
// clientId that leg resolves.
//
// A FUTURE HOST. Nothing below is VS-Code-specific in SHAPE — only in DATA
// (the `VSCODE_SERVER_INSTRUCTIONS`/`VSCODE_TOOL_DESCRIPTIONS` constants, and
// the "vscode" profile id `resolveClientProfile` already recognizes by
// clientInfo.name substring — see codec/clientProfile.ts). Adding a second
// host with its own advertisement quirks means adding its own constants and
// one more branch inside `baseServerInstructionsForClient`/
// `toolDescriptionForClient`; callers (server.ts) do not change.
//
// Outside the validated VS Code and copilot-cli advertisements, default
// behavior remains byte-identical. Copilot CLI drops nested descriptions;
// TL_LEAN_CALLS=1 plus TL_MINIMAL_TOOLS=1 also opts it into the existing
// minimal schema. Canonical dispatch and write safeguards remain authoritative.
// The following original compatibility note describes the VS Code branch.
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
export type AdvertisedToolName = "tl_read_file" | "tl_edit_file" | "tl_search_files";

/**
 * VS Code / GitHub Copilot Chat's `initialize`-time `instructions` text.
 * ASCII-only, under 1000 B (checked in clientAdvertisement.spec.ts) —
 * under a 1000-byte budget. Unlike SERVER_INSTRUCTIONS
 * (paid once per connection by most hosts), VS Code re-injects this into the
 * system prompt of a `tool_search` model on every request, so the budget is
 * deliberately tighter than "however much would fit."
 *
 * Covers, in order: (1) tool identity — TokenLighten's tools are MCP tools
 * whose names END IN tl_read_file/tl_edit_file/tl_search_files (an "ends in"
 * match, not an exact one, since the exact prefix a host prepends is not this
 * string's concern). Use loaded definitions directly; otherwise load once
 * with `tool_search {query:"tokenlighten"}`. Stop discovery once
 * loaded; reload only missing definitions, including after a conversation
 * summary. Batch independent work only: discovery need not be paired with
 * an unrelated call. Copilot retest r8 returned all three TL definitions in
 * every first search, but four of the six Luna runs made additional searches
 * in the same batch (five additional calls across four runs). These parallel
 * calls cannot have seen each other's results. Retest r9 captured the host's
 * advertised tool_search schema: only query is exposed. Its four Luna TL
 * runs passed no limit and each loaded two unrelated definitions. Do not
 * depend on an unadvertised limit argument to control the host's results;
 * (2) retired 2026-10-02 — the sentence "bare read_file/edit_file/search_files
 * mean these, never the built-in read_file": the tl_ prefix makes the names
 * distinct, so nothing is left to disambiguate; (3) the same essential routing
 * SERVER_INSTRUCTIONS carries (TL first for code/doc/config; unknown-
 * location/multi-file => tl_read_file {query:...}; act on act.answer/act.edit;
 * batch edits in one edits[] call; the full protocol is in the model's own
 * instructions — "Protocol: in your instructions.", never a file to fetch:
 * since the Copilot standard-setup evaluation (2026-10-02), setup's default
 * Copilot guide puts it in .github/copilot-instructions.md and stops Copilot
 * attaching AGENTS.md, so "Protocol: AGENTS.md." would send the model to read
 * a 12 KB file it was deliberately spared); (4) two VS
 * Code/Copilot-specific additions — write the query in the code's own
 * language (usually English) even when the user wrote in another language,
 * and "turns cost more than bytes": put every known file/range into one
 * targets:[...] call (or one parallel batch) rather than one call per file,
 * and continue an already-served handle via targets:[{handle,range}] with
 * no qref needed; (5) WP-V1 (2026-09-20) — under `leanCallsEnabled()` (see
 * util/flags.ts), envelope.ts's emitted tl_read_file/tl_search_files
 * continuations drop `cwd`/`task.handle` where they are redundant
 * (single-root workspace; a qref already carries the task), so the model
 * is told to do the same on the calls it authors itself. `targets[].purpose`
 * is NOT part of that cut: it is what tells the server what a caller-named
 * DIRECTORY is for (the directory-confined recovery in the seeded pack
 * builder locates with it first), so the text steers it onto directory
 * targets instead of asking the model to drop it.
 */
export const VSCODE_SERVER_INSTRUCTIONS =
  `TokenLighten tools are MCP tools ending in tl_read_file/tl_edit_file/tl_search_files; if the needed definitions are loaded, call TL directly. Otherwise load once with tool_search {query:"tokenlighten"}, then call TL. Stop tool_search once loaded; reload only missing definitions, including after a conversation summary. Batch independent context calls with TL. TL first for code/doc/config. Unknown-location/multi-file=>tl_read_file {query:"<request>"}. Pass the entire user request verbatim as query; preserve every requirement. Turns cost more than bytes: every known file/range in ONE targets:[...] call or one parallel batch; reread served evidence via targets:[{handle,range}], no qref. On tl_read_file/tl_search_files omit cwd and task.handle (qref carries the task); targets[].purpose only on a directory. Act on act.answer/act.edit: use served evidence, batch edits in one edits[] call, stop after passing verification. Protocol: in your instructions.`;

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
  // Copilot retest r3 (2026-10-02): the first-call example names
  // profile:"answer". GPT-6 Luna loads this description through tool_search
  // right before its first call, and one of its two runs copied the bare
  // {epoch:"new"} example verbatim: a read-only request was served generic and
  // cost a whole extra round.
  tl_read_file:
    `TokenLighten file reader: exact code/doc/config slices plus edit handles, not a full-file read. First call: {query:"<task with code identifiers>", task:{epoch:"new"}}, plus profile:"answer" in task when no change is wanted. Zoom via targets:[{path|handle, range}], several per call. Follow next/limit. content:"full" for whole small files.`,
  tl_edit_file:
    `TokenLighten file editor. Batch edits[] items in ONE call, each with path or handle plus search/replace (add precondition:"unique-match" for a single known value). create:true plus content makes a new file. Always pass top-level cwd so writes land in the right worktree.`,
  tl_search_files:
    `TokenLighten code/text search. action:"find" with queries:[...] (up to 10 per call) locates identifiers or text; "references" finds call sites; "tree" inventories a directory. Set scope.path when the package/module is known.`,
};

/**
 * Copilot retest r5 (2026-10-03): the VS Code descriptions under
 * `TL_MINIMAL_TOOLS` (util/flags.ts `minimalToolsEnabled`). A model without
 * `tool_search` (MAI flash) reads these on every round and never sees the
 * `instructions` above, and in r5 its one TokenLighten run searched first,
 * then read every hit, then answered — the three rounds of the native
 * grep/read path. So `tl_read_file` leads with the one-call path (the query
 * pack locates AND serves; `act.answer` ends discovery), `tl_search_files`
 * says what it is for and points a question back at that call, and none of
 * them spends a byte on an argument the minimal advertisement no longer
 * lists. The first-call example keeps `profile:"answer"` for the reason
 * recorded on VSCODE_TOOL_DESCRIPTIONS.tl_read_file below.
 *
 * Copilot retest r6 (2026-10-03): in both small runs MAI flash again called
 * grep_search, then read_file on the three hits, then answered, with these
 * definitions in its request on every round; across r1-r6 it called
 * TokenLighten in 1 of 11 such runs, and that run followed the same
 * search-then-read habit with TokenLighten's tools. A model picks a tool by
 * the job it already has in mind, so each description now opens with the
 * Copilot built-in it replaces (this advertisement only reaches VS Code's own
 * MCP client, whose host tools are grep_search/semantic_search/read_file) and
 * says what the replacement saves: the query call returns every involved
 * file's code with line numbers at once, and a search whose whole result is a
 * few small files returns them whole (TL_FIND_SMALL_BODIES), so the read step
 * the habit expects next never comes. The search description makes that
 * promise only while TL_FIND_SMALL_BODIES is on
 * (VSCODE_MINIMAL_SEARCH_DESCRIPTION_WITHOUT_BODIES otherwise).
 */
export const VSCODE_MINIMAL_TOOL_DESCRIPTIONS: Readonly<Record<AdvertisedToolName, string>> = {
  tl_read_file:
    `FIRST workspace source inspection, instead of grep_search/semantic_search/read_file: {query:"<entire user request, verbatim>",task:{epoch:"new"}}; never shorten the query. Read-only: add task.profile:"answer". Locates AND serves source with line numbers in ONE call. Include known paths in targets:[{path},...]. act.answer = answer now; run next verbatim.`,
  tl_edit_file:
    `Edit files in ONE call: edits:[{path|handle, search, replace}] (precondition:"unique-match" for one known value) or {path, create:true, content}; pass top-level cwd.`,
  tl_search_files:
    `For source questions/tasks use tl_read_file {query} first. Identifier/reference/inventory-only: {action:"find",queries:[...]} (up to 10; scope.regex for patterns, scope.path narrows); a few small matching files come back whole, so no read follows. "references" = call sites; "tree" = inventory.`,
};

/** tl_search_files under TL_MINIMAL_TOOLS while TL_FIND_SMALL_BODIES is off: the same text without the whole-file promise. */
export const VSCODE_MINIMAL_SEARCH_DESCRIPTION_WITHOUT_BODIES =
  `For source questions/tasks use tl_read_file {query} first. Identifier/reference/inventory-only: {action:"find",queries:[...]} (up to 10; scope.regex for patterns, scope.path narrows). "references" = call sites; "tree" = inventory.`;

/** Copilot CLI 1.0.96 reports this exact initialize clientInfo.name. */
export function isCopilotCliClient(clientId: string | undefined): boolean {
  return clientId?.toLowerCase() === "copilot-cli";
}

/** Claude Code (2.1.x) reports this exact initialize clientInfo.name. */
export function isClaudeCodeClient(clientId: string | undefined): boolean {
  return clientId?.toLowerCase() === "claude-code";
}

/** Codex CLI (0.159.x, also its IDE and `exec` modes) reports this exact initialize clientInfo.name. */
export function isCodexCliClient(clientId: string | undefined): boolean {
  return clientId?.toLowerCase() === "codex-mcp-client";
}

/**
 * The terminal coding agents of the 2026-10-16 simple paired bench
 * (DESIGN-v0.14-plan §20.7-20.8): every model request carries every
 * advertised schema (Claude Code registers TokenLighten with `alwaysLoad`, so
 * its tools are never deferred), and their answers cite `file:line`. Codex
 * CLI is the same kind of host (2026-10-17, §20.11): it lists the tools on
 * every request, runs the tests itself, and its 2026-10-16 portable smoke
 * (`portable-20261016-hosts-final`) passed in one TokenLighten call.
 */
export function isCliCodingHost(clientId: string | undefined): boolean {
  return isClaudeCodeClient(clientId) || isCopilotCliClient(clientId) || isCodexCliClient(clientId);
}

/** CLI eagerly sends definitions, so put routing rules here and avoid duplication. */
const COPILOT_CLI_TOOL_DESCRIPTIONS: Readonly<Record<AdvertisedToolName, string>> = {
  tl_read_file: 'FIRST source lookup instead of grep/view: {cwd,query:"<entire user request, verbatim>",task:{epoch:"new"}}. Read-only: add task.profile:"answer". Locates and serves needed code; act.answer means answer now; otherwise run next verbatim.',
  tl_edit_file: 'Batch edits[] with served handles; pass cwd. For one known replacement use precondition:"unique-match",allowPathFallback:false. Writes require --allow-write.',
  tl_search_files: 'Source tasks: use tl_read_file first. Find/references/diff/tree via action and queries[]; scope.path narrows the search.',
};

/** True when `clientId` resolves (via clientProfile.ts's `resolveClientProfile`) to VS Code's built-in MCP client. */
function isVsCodeClient(clientId: string | undefined): boolean {
  return resolveClientProfile(clientId).id === "vscode";
}

/**
 * The base `instructions` text for this client — before any `Degraded: ...`
 * suffix, which stays server.ts's `buildInitializeInstructions*` job. VS
 * Code's own variant for the "vscode" profile; the shared
 * `SERVER_INSTRUCTIONS` for every other/unknown client otherwise. r12's
 * portable routing updates that shared constant for Codex/Claude Code;
 * it leaves the dedicated VS Code variant unchanged.
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
 * `minimal` (server.ts passes it under `TL_MINIMAL_TOOLS`, only where the
 * vscode lean advertisement applies) selects VSCODE_MINIMAL_TOOL_DESCRIPTIONS;
 * `smallFindBodies` (`TL_FIND_SMALL_BODIES`) keeps its search description's
 * whole-file promise, which VSCODE_MINIMAL_SEARCH_DESCRIPTION_WITHOUT_BODIES
 * leaves out.
 */
export function toolDescriptionForClient(
  clientId: string | undefined,
  toolName: string,
  minimal = false,
  smallFindBodies = false,
): string | undefined {
  if (isCopilotCliClient(clientId)) {
    return Object.prototype.hasOwnProperty.call(COPILOT_CLI_TOOL_DESCRIPTIONS, toolName)
      ? COPILOT_CLI_TOOL_DESCRIPTIONS[toolName as AdvertisedToolName]
      : undefined;
  }
  if (!isVsCodeClient(clientId)) return undefined;
  if (minimal && !smallFindBodies && toolName === "tl_search_files") return VSCODE_MINIMAL_SEARCH_DESCRIPTION_WITHOUT_BODIES;
  const table = minimal ? VSCODE_MINIMAL_TOOL_DESCRIPTIONS : VSCODE_TOOL_DESCRIPTIONS;
  return Object.prototype.hasOwnProperty.call(table, toolName)
    ? table[toolName as AdvertisedToolName]
    : undefined;
}
