// MODERN-era stdio transport — MCP Specification 2026-07-28, TypeScript SDK v2
// (`@modelcontextprotocol/server` 2.x).
//
// v0.10 alpha.1 / PI-09 implementation items 1-2 and 14
// (DESIGN-v0.10-expansion-plan-v1.3.md §4.5). OPT-IN: reached only via
// TOKENLIGHTEN_PROTOCOL_ERA=modern. The legacy leg (legacyStdio.ts +
// fallbackStdio.ts) is untouched and stays the default.
//
// WHAT IS AND IS NOT DIFFERENT HERE
//
//   Same:  the three advertised tools, their EXACT `advertisedTools()`
//          definitions (schemas, descriptions, `_meta`, annotations), the
//          `callTool()` dispatch, and its `content:[{type:"text",text}]`
//          + `isError` result shape. PI-09 item 14: one domain contract, both
//          eras — the era never reaches a domain handler.
//   New:   `serveStdio()` owns the opening exchange and picks the era for the
//          connection. A 2026-07-28 client opens WITHOUT `initialize` (the
//          revision has no handshake and no `Mcp-Session-Id`; every request
//          carries its own protocol version), which is exactly why PI-09 has
//          to move cross-call state onto explicit handles — that work lands in
//          alpha.2, not here.
//
// The SDK v2 `Server` is the LOW-LEVEL class, chosen deliberately over
// `McpServer`: `McpServer.registerTool()` advertises a schema it derives from
// a Standard Schema (zod/`fromJsonSchema`), whereas `setRequestHandler`
// returns OUR `advertisedTools()` array verbatim. The advertised surface is
// frozen (protocol-v1-snapshot.json, schemaSize.spec.ts), so verbatim is the
// only acceptable answer — see modernEraTransport.spec.ts, which deep-equals
// the served `tools/list` against `advertisedTools()`.
//
// IMPORT-CYCLE NOTE: see fallbackStdio.ts — every server.ts binding used here
// is read inside a function body at call time, never at module evaluation.
// (modernServerFactory.ts, imported below, keeps that same property: its
// server.ts bindings are read inside the closure it RETURNS, not at its own
// module evaluation, so sharing it here does not change this file's cycle
// safety.)

import { makeModernServerFactory } from "./modernServerFactory.js";

/**
 * Starts the modern (2026-07-28) stdio transport. Returns false — after one
 * stderr line naming the reason — when the SDK v2 packages cannot be loaded or
 * the entry rejects, so the caller can fail open to the legacy leg.
 */
export async function tryRunWithModernSdk(): Promise<boolean> {
  try {
    const { Server } = await import("@modelcontextprotocol/server");
    const { serveStdio } = await import("@modelcontextprotocol/server/stdio");

    // `serveStdio` pins ONE instance from this factory for the connection's
    // lifetime, after the opening exchange has decided the era. Building a
    // fresh instance per call (rather than closing over a single pre-built
    // one) is what the SDK's own entry contract asks for. Same factory the
    // Streamable HTTP leg builds (modernHttp.ts, PI-09 deferred cell) — see
    // modernServerFactory.ts's header for why it is shared rather than
    // duplicated per leg.
    const buildServer = makeModernServerFactory(Server);

    // `legacy: 'serve'` (the default) is deliberate: §4.5 requires the modern
    // entry to keep serving 2025-era clients through the compat adapter rather
    // than rejecting them, and the SDK entry does that from this same factory.
    serveStdio(buildServer);
    process.stderr.write(`[tl-mcp] stdio transport (MCP SDK v2, era=modern)\n`);
    return true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[tl-mcp] modern transport unavailable: ${msg}\n`);
    return false;
  }
}
