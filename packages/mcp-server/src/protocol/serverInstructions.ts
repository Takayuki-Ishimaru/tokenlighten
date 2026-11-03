// ---------------------------------------------------------------------------
// Server-level MCP `instructions` — issue #4 (host routing/discovery).
//
// WHY THIS EXISTS. For "target location unknown / multi-file cross-cutting"
// tasks, a host's own Explore-style subagent tends to win first-tool
// selection over TL: TL's advertised tool descriptions read as a file
// reader, and (until this change) TL contributed nothing to the host's
// system prompt. Hosts such as Claude Code inject an MCP server's
// `initialize`-time `instructions` string into the system prompt verbatim
// (as "MCP Server Instructions") — this is the one announcement point that
// reaches the host BEFORE any per-tool description is read or a routing
// decision is made. `SERVER_INSTRUCTIONS` is that string.
//
// CANONICAL HOME. This lives in its own module — not in server.ts — so both
// initialize sites (the hand-rolled JSON-RPC leg in server.ts, served by
// mcp/transport/legacyStdio.ts, and the modern SDK v2 leg in
// mcp/transport/modernServerFactory.ts) import the SAME frozen string
// directly, with no hop through server.ts and no exposure to its import
// cycle (see legacyStdio.ts's IMPORT-CYCLE NOTE — the same reasoning that
// keeps `PROTOCOL_META` in protocol/envelope.ts rather than re-exported
// through server.ts).
//
// TEXT IS NORMATIVE. The string below is pinned verbatim by the
// initialize-leg specs (serverInstructions.spec.ts,
// modernEraTransport.spec.ts); do not paraphrase it in one leg without
// updating both. It is NOT part of __tests__/fixtures/
// protocol-v1-snapshot.json — that pin's scope is limited to
// advertisedTools()'s input schema (protocolConformance.spec.ts's own
// SCOPE BOUNDARY note says so; verified empirically at the v0.12 C2 wave:
// regenerating the snapshot after a SERVER_INSTRUCTIONS wording change
// produced a byte-identical file). A wording change here still follows the
// freeze procedure as a matter of process discipline for the advertised
// surface, but expect a no-op snapshot diff, not a required one.
// ---------------------------------------------------------------------------

/**
 * Shared initialize-time routing hint (r12, 2026-10-04).
 * Portable parts of Copilot r11: full-query location discovery, exact served
 * evidence, batching, and explicit fallback. The schemas carry input homes;
 * keep this hint within the existing 520 B ceiling instead of copying a
 * client-specific SessionStart hook or tool-name prefix into other hosts.
 *
 * Routing (2026-11-03): TL where its first pack pays for itself (unknown
 * location, several files or the call graph, Office/CSV/archive, large
 * files); native Read/Grep/Edit when the user names the file (or the exact
 * symbol and its file) and the task is small and local. Paired billing on
 * Claude Code showed small known-location work costing more through TL (its
 * speculative task pack is paid up front), and a wrong first guess paying
 * twice. Held at the r12 byte count: "unknown paths: omit targets" and the
 * "user asks"/"TL unavailable" native clauses went (the first call shape
 * carries no targets; the guides keep both fallbacks).
 */
export const SERVER_INSTRUCTIONS =
  `TL for unknown location, multi-file/call-graph, Office/CSV/archive/large files: tl_read_file {query:"<entire user request, verbatim>",task:{epoch:"new"}} (never keyword-shorten). Native Read/Grep/Edit: user-named file/symbol + small local task; incomplete scope/verified absence. act.answer/act.edit: use evidence[].body; no re-read. Batch independent targets/edits[]. Run next verbatim; lost context: task.force_serve:true. Stop after passing verification. Protocol: in your instructions.`;
