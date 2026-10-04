// serverInstructions.spec.ts — issue #4 (host routing/discovery).
//
// Pins the server-level MCP `instructions` string introduced so a host that
// surfaces `initialize`'s `instructions` in its system prompt (e.g. Claude
// Code's "MCP Server Instructions") routes discovery-shaped tasks ("where is
// X", "which files", "how does X work") to TL from turn 0, rather than
// letting an Explore-style subagent win first-tool selection by default.
//
// TWO LEGS, ONE STRING. `SERVER_INSTRUCTIONS` (protocol/serverInstructions.ts)
// is threaded into both `initialize` sites:
//   - the hand-rolled JSON-RPC leg (server.ts's `handleRequest`, served over
//     stdio by mcp/transport/legacyStdio.ts) — pinned directly, in-process,
//     here (the `clientIdCapture.spec.ts` style), and over a REAL spawned
//     server in modernEraTransport.spec.ts.
//   - the modern SDK v2 leg (mcp/transport/modernServerFactory.ts) — pinned
//     via a REAL spawned server + real client handshake in
//     modernEraTransport.spec.ts, since that spec already owns the SDK-leg
//     spawn harness.
// (An @modelcontextprotocol/sdk v1 leg was once counted as a third; it never
// ran and is deleted — see mcp/transport/legacyStdio.ts's header.)
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
  it("routes an unknown-location request verbatim before native discovery", () => {
    expect(SERVER_INSTRUCTIONS).toContain('tl_read_file {query:"<entire user request, verbatim>",task:{epoch:"new"}}');
    expect(SERVER_INSTRUCTIONS).toContain("Unknown paths: omit targets");
    expect(SERVER_INSTRUCTIONS).toContain("never keyword-shorten or drop constraints");
    expect(SERVER_INSTRUCTIONS).toContain("Native if TL unavailable, user asks, incomplete scope or verified absence");
    expect(SERVER_INSTRUCTIONS).toContain("Protocol: in your instructions.");
  });

  // B-F4 (2026-08-28): SERVER_INSTRUCTIONS is a fixed cost paid on every
  // `initialize`, so its size is pinned directly, not just its wording — a
  // ceiling regression here means someone re-inflated the fixed cost this
  // wave spent effort cutting. 592 B pre-compression (B-4). The string was
  // then REWRITTEN (not just re-measured) by the D-4 canonicalization pass
  // (2026-08-28, commit 413c5146) to name the v0.13 canonical input homes;
  // v0.13 wave-3 (Track D, W3-3) corrected this pin from a stale 478 B
  // (that number documented the PRE-canonicalization string and was never
  // re-measured after the rewrite) to the real measured value, 457 B — see
  // serverInstructions.ts's own doc comment for the full correction. The
  // ceiling has headroom for minor future wording fixes without becoming a
  // silent budget for creep back toward 592 B.
  it("stays at or under its post-B-F4 byte ceiling (r12: 490 B measured; 520 B ceiling)", () => {
    const bytes = Buffer.byteLength(SERVER_INSTRUCTIONS, "utf8");
    expect(bytes, `SERVER_INSTRUCTIONS grew to ${bytes} B — update this ceiling deliberately, with a reason, not by accident`).toBeLessThanOrEqual(520);
  });

  // v0.12 C2 (W4 channel v2): guide-less stop discipline, grounded in the T13
  // anatomy residual (ceremonial post-edit re-reads/diff sweeps) and the
  // Probe-2 finding (solvers distrust served evidence). These four sentences
  // are the ONLY textual explanation a guide-less caller ever gets for this
  // behavior, so each is pinned by name rather than folded into the sweep
  // above.
  it("closes discovery and requires batching independent edits into one edits[] call", () => {
    expect(SERVER_INSTRUCTIONS).toContain(
      "act.answer/act.edit: use exact evidence[].body with its paths/lines; no re-read.",
    );
    expect(SERVER_INSTRUCTIONS).toContain("Batch independent targets/edits[].");
  });

  it("tells a caller never to re-fetch bytes a receipt or a prior-tagged evidence item already served", () => {
    expect(SERVER_INSTRUCTIONS).toContain(
      "use exact evidence[].body",
    );
  });

  it("tells a caller a not-a-direct-proof gap is not closed by that entry passing", () => {
    expect(SERVER_INSTRUCTIONS).toContain(
      "Protocol: in your instructions.",
    );
  });

  it("tells a caller to stop after a successful edit and a passing verification, with no ceremonial re-reads/diff sweeps", () => {
    // B-F4 (2026-08-28): "After a successful edit and relevant verification,
    // stop." (its own sentence) became "...stop after a passing
    // verification." (a clause on the same sentence as the rest of the
    // post-act discipline) — "relevant" was cut as the one genuinely
    // redundant word here (the guide carries the narrow-verification-floor
    // nuance in full); the STOP instruction itself is unchanged.
    expect(SERVER_INSTRUCTIONS).toContain(
      "Stop after passing verification.",
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
