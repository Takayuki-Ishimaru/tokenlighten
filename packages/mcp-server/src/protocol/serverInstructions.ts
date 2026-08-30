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

/**
 * Server-level `instructions` announced on every MCP `initialize` result.
 *
 * B-F4 (2026-08-28): re-compressed from 592 B to 478 B. Cut only
 * unambiguous redundancy — the "(+paths when known)" aside, the duplicate
 * "/calls" on the search_files clause, the repeated "TL reports" subject
 * (the fallback sentence's subject already carries from the prior
 * sentence), and "relevant" before "verification" (still unambiguous: the
 * guide is the place for the narrow-verification-floor nuance). Every
 * concept from the 592 B string is still present, INCLUDING the
 * post-edit-discipline sentence (reuse receipt/prior evidence; batch edits
 * in one call; stop after a passing verification) — that sentence is not
 * decorative: serverInstructions.spec.ts's own comment ties it to the T13
 * anatomy finding (ceremonial post-edit re-reads/diff sweeps) and the
 * Probe-2 finding (solvers distrust served evidence), and it is the ONLY
 * textual explanation of that discipline a guide-less caller ever gets. A
 * ~400 B target was in reach only by deleting that sentence outright, which
 * would be reintroducing a measured defect to save ~60 B; 478 B was this
 * wording's routing-signal-preserving floor. See the B-REPORT for the
 * before/after measurements and the rejected sub-450 B drafts.
 *
 * D-4 canonicalization (2026-08-28, commit 413c5146): the string below was
 * REWRITTEN, not merely re-measured, to name the canonical v0.13 input homes
 * (`task.force_serve`/`task.pull`, `scope.includeClosure`/`surfaceRoles`/
 * `kind`, `budget`, read `targets`/`content`, search `action`+`queries`,
 * edit `edits`) in place of the pre-diet `mode=task_pack`/`action=tree|find|
 * references` phrasing — the same routing intent, restated for the surface
 * this schema now advertises. Every concept the B-F4 paragraph above
 * describes (post-edit stop discipline included) is still present verbatim.
 * v0.13 wave-3 (Track D, W3-3): the rewrite's actual measured size is 457 B,
 * not 478 — the 478 figure above documents the PRE-canonicalization string
 * and was never re-measured after the rewrite landed. Both
 * rehearsal-ceiling.json's `server_instructions_bytes` and
 * serverInstructions.spec.ts's ceiling-test title/comment are corrected to
 * 457 alongside this comment; the 520 B ceiling itself is unchanged (457 is
 * comfortably under it).
 */
export const SERVER_INSTRUCTIONS =
  `TL first for code/doc/config. Unknown-location/multi-file=>read_file {query:"<request>"}. Canonical only: task.force_serve/task.pull; scope.includeClosure/scope.surfaceRoles/scope.kind; budget; read targets/content; search action+queries; edit edits. Native only after incomplete scope or verified absence. Act on act.answer/act.edit: use served evidence, batch edits in one edits[] call, stop after passing verification. Full protocol: AGENTS.md/CLAUDE.md.`;