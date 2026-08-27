// serverInstructions.spec.ts — issue #4 (host routing/discovery).
//
// Pins the server-level MCP `instructions` string introduced so a host that
// surfaces `initialize`'s `instructions` in its system prompt (e.g. Claude
// Code's "MCP Server Instructions") routes discovery-shaped tasks ("where is
// X", "which files", "how does X work") to TL from turn 0, rather than
// letting an Explore-style subagent win first-tool selection by default.
//
// THREE LEGS, ONE STRING. `SERVER_INSTRUCTIONS` (protocol/serverInstructions.ts)
// is threaded into all three `initialize` sites:
//   - the hand-rolled JSON-RPC leg (server.ts's `handleRequest`) — pinned
//     directly, in-process, here (the `clientIdCapture.spec.ts` style).
//   - the legacy SDK v1 leg (mcp/transport/legacyStdio.ts) and the modern SDK
//     v2 leg (mcp/transport/modernServerFactory.ts) — both pinned via a REAL
//     spawned server + real client handshake in modernEraTransport.spec.ts
//     (extended alongside this file in the same commit), since that spec
//     already owns the SDK-leg spawn harnesses.
//
// This file covers only the hand-rolled leg plus the pure
// `buildInitializeInstructions` helper — the `degraded` array `handleRequest`
// passes it currently has no live producer (see server.ts), so the
// degraded-append shape is unit-tested directly against the helper rather
// than through a real `initialize` call that has no way to trigger it.

import { describe, it, expect } from "vitest";

import {
  handleRequest,
  buildInitializeInstructions,
  SERVER_BUILD_ID,
  SERVER_PACKAGE_VERSION,
} from "../server.js";
import { PROTOCOL_META } from "../protocol/envelope.js";
import { SERVER_INSTRUCTIONS } from "../protocol/serverInstructions.js";

describe("issue #4: SERVER_INSTRUCTIONS content", () => {
  it("starts every code/doc/config task with TL, names unknown-location/multi-file discovery, and points at read_file mode=task_pack", () => {
    expect(SERVER_INSTRUCTIONS).toContain("TokenLighten (TL) is the first stop for every code/doc/config task");
    expect(SERVER_INSTRUCTIONS).toContain("unknown-location and multi-file discovery");
    expect(SERVER_INSTRUCTIONS).toContain("read_file mode=task_pack query=<request verbatim>");
    expect(SERVER_INSTRUCTIONS).toContain("search_files action=tree|find|references");
    expect(SERVER_INSTRUCTIONS).toContain("After task_pack returns act.answer or act.edit, discovery is closed");
    expect(SERVER_INSTRUCTIONS).toContain("Fall back to native Read/Grep/Explore only after TL reports a non-complete scope or a verified absence.");
    expect(SERVER_INSTRUCTIONS).toContain("the TokenLighten guide block in AGENTS.md/CLAUDE.md.");
  });

  // v0.12 C2 (W4 channel v2): guide-less stop discipline, grounded in the T13
  // anatomy residual (ceremonial post-edit re-reads/diff sweeps) and the
  // Probe-2 finding (solvers distrust served evidence). These four sentences
  // are the ONLY textual explanation a guide-less caller ever gets for this
  // behavior, so each is pinned by name rather than folded into the sweep
  // above.
  it("closes discovery and requires batching independent edits into one edits[] call", () => {
    expect(SERVER_INSTRUCTIONS).toContain(
      "After task_pack returns act.answer or act.edit, discovery is closed — act immediately from the served content and batch independent edits in one edits[] call.",
    );
  });

  it("tells a caller never to re-fetch bytes a receipt or a prior-tagged evidence item already served", () => {
    expect(SERVER_INSTRUCTIONS).toContain(
      "A receipt, or any evidence item marked prior, means those bytes are already in hand — never re-fetch on it.",
    );
  });

  it("tells a caller a not-a-direct-proof gap is not closed by that entry passing", () => {
    expect(SERVER_INSTRUCTIONS).toContain(
      "A gap naming an entry as not a direct proof is not closed by that entry passing — verify via the contract's per-target actions instead.",
    );
  });

  it("tells a caller to stop after a successful edit and a passing relevant verification, with no ceremonial re-reads/diff sweeps", () => {
    expect(SERVER_INSTRUCTIONS).toContain(
      "Once an edit applies and a relevant verification passes, stop: no ceremonial re-reads or diff sweeps.",
    );
  });
});

describe("issue #4: hand-rolled leg — handleRequest's initialize result carries instructions", () => {
  it("a normal (non-degraded) initialize call returns instructions === SERVER_INSTRUCTIONS exactly", async () => {
    const res = await handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "tl-instructions-spec", version: "1.0.0" } },
    });
    expect(res).not.toBeNull();
    const result = (res as { result?: Record<string, unknown> }).result;
    expect(result).toBeDefined();
    expect(result!["instructions"]).toBe(SERVER_INSTRUCTIONS);
    expect(result!["serverInfo"]).toMatchObject({
      version: SERVER_PACKAGE_VERSION,
      _meta: { ...PROTOCOL_META, server_build: SERVER_BUILD_ID },
    });
  });

  it("instructions is present even with no clientInfo (bare initialize)", async () => {
    const res = await handleRequest({ jsonrpc: "2.0", id: 2, method: "initialize", params: {} });
    const result = (res as { result?: Record<string, unknown> }).result;
    expect(result!["instructions"]).toBe(SERVER_INSTRUCTIONS);
  });
});

describe("issue #4: buildInitializeInstructions — the pure degraded-append shape", () => {
  it("no degraded reasons: returns SERVER_INSTRUCTIONS unchanged", () => {
    expect(buildInitializeInstructions([])).toBe(SERVER_INSTRUCTIONS);
  });

  it("degraded reasons present: SERVER_INSTRUCTIONS, a newline, then the existing Degraded: line verbatim", () => {
    const out = buildInitializeInstructions(["reason-a", "reason-b"]);
    expect(out).toBe(`${SERVER_INSTRUCTIONS}\nDegraded: reason-a, reason-b`);
    // The pre-existing degraded-line text/shape is unchanged by issue #4 —
    // only its prefix (now SERVER_INSTRUCTIONS + "\n") changed.
    expect(out.endsWith("Degraded: reason-a, reason-b")).toBe(true);
  });
});
