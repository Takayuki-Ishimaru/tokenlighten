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
// CANONICAL HOME. This lives in its own module — not in server.ts — so all
// three initialize sites (the hand-rolled JSON-RPC leg in server.ts, the
// legacy SDK v1 leg in mcp/transport/legacyStdio.ts, and the modern SDK v2
// leg in mcp/transport/modernServerFactory.ts) import the SAME frozen string
// directly, with no hop through server.ts and no exposure to its import
// cycle (see legacyStdio.ts's IMPORT-CYCLE NOTE — the same reasoning that
// keeps `PROTOCOL_META` in protocol/envelope.ts rather than re-exported
// through server.ts).
//
// TEXT IS NORMATIVE. The string below is pinned verbatim by the
// initialize-leg specs (serverInstructions.spec.ts,
// modernEraTransport.spec.ts); do not paraphrase it in one leg without
// updating all three. It is NOT part of __tests__/fixtures/
// protocol-v1-snapshot.json — that pin's scope is limited to
// advertisedTools()'s input schema (protocolConformance.spec.ts's own
// SCOPE BOUNDARY note says so; verified empirically at the v0.12 C2 wave:
// regenerating the snapshot after a SERVER_INSTRUCTIONS wording change
// produced a byte-identical file). A wording change here still follows the
// freeze procedure as a matter of process discipline for the advertised
// surface, but expect a no-op snapshot diff, not a required one.
// ---------------------------------------------------------------------------

/** Server-level `instructions` announced on every MCP `initialize` result. */
export const SERVER_INSTRUCTIONS =
  `TokenLighten (TL) is the first stop for every code/doc/config task in this workspace — including unknown-location and multi-file discovery ("where is X", "which files", "how does X work"). Start with read_file mode=task_pack query=<request verbatim> (+paths when known): one call locates, ranks and serves the relevant slices with edit handles, replacing Explore/Grep/Read fan-out. Inventory and call sites: search_files action=tree|find|references. Fall back to native Read/Grep/Explore only after TL reports a non-complete scope or a verified absence. After task_pack returns act.answer or act.edit, discovery is closed — act immediately from the served content and batch independent edits in one edits[] call. A receipt, or any evidence item marked prior, means those bytes are already in hand — never re-fetch on it. A gap naming an entry as not a direct proof is not closed by that entry passing — verify via the contract's per-target actions instead. Once an edit applies and a relevant verification passes, stop: no ceremonial re-reads or diff sweeps. Full protocol: the TokenLighten guide block in AGENTS.md/CLAUDE.md.`;
