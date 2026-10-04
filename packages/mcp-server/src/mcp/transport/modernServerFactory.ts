// Shared MCP SDK v2 `Server` factory for BOTH modern-era legs — stdio
// (modernStdio.ts) and Streamable HTTP (modernHttp.ts).
//
// v0.10 alpha.2 / PI-09 deferred cell (DESIGN-v0.10-expansion-plan-v1.3.md
// §4.5): PI-09 item 14 established "one domain contract, both ERAS" — domain
// handlers never branch on legacy vs. modern. This module extends the same
// invariant one level further, to "one domain contract, both TRANSPORTS
// within the modern era": stdio and Streamable HTTP are handed the exact
// same closure, built by the exact same code, so the two channels can never
// observably drift apart. Before this module existed, modernStdio.ts built
// this closure inline; it was extracted here verbatim when modernHttp.ts was
// added so both call sites share one definition instead of two copies that
// could silently diverge on the next edit.
//
// Type-only: `Server`'s VALUE stays behind each leg's own try/catch dynamic
// `import("@modelcontextprotocol/server")` (see modernStdio.ts's IMPORT-CYCLE
// NOTE) so a missing SDK v2 install is still catchable per leg. This module
// only needs the TYPE, so it adds no runtime import of the SDK package.

import {
  ALL_TOOLS,
  SERVER_BUILD_ID,
  SERVER_PACKAGE_VERSION,
  activeRoot,
  advertisedTools,
  callTool,
  unknownToolMessage,
} from "../../server.js";
// The VS Code window-scoped off switch, shared with the hand-rolled leg
// (server.ts's `handleRequest`) so both answer the same way.
import {
  HOST_ACTIVATION_ERROR_CODE,
  hostActivationBypass,
  hostActivationToolNotFoundMessage,
  hostActivationToolsCapability,
  startHostActivationWatch,
  type HostActivationWatch,
} from "../hostActivation.js";
// Imported from its canonical definition site rather than re-exported through
// server.ts: server.ts itself gets PROTOCOL_META from here, so this is the
// same frozen object with one less hop through the cycle.
import { PROTOCOL_META } from "../../protocol/envelope.js";
// issue #4 (host routing/discovery): same reasoning — the canonical home is
// protocol/serverInstructions.ts, not server.ts, so this leg reads the exact
// same frozen string with no hop through the cycle.
import { SERVER_INSTRUCTIONS } from "../../protocol/serverInstructions.js";
import type { CallToolResult, ListToolsResult, Server } from "@modelcontextprotocol/server";

/** The `Server` class as dynamically imported by a leg's own try/catch. */
export type ModernServerCtor = typeof Server;

/**
 * Builds a fresh SDK v2 `Server` instance wired to the three advertised
 * tools — byte-identical dispatch to the legacy leg's (server.ts's
 * `handleRequest`, reached through legacyStdio.ts): the same
 * `advertisedTools()` array verbatim for `tools/list`, the same `callTool()`
 * result shape for `tools/call`, and the same D11 advertised-or-refused gate.
 *
 * Returns a zero-argument factory, which is assignable everywhere the SDK
 * expects `McpServerFactory` (`(ctx: McpRequestContext) => …`): neither this
 * factory nor the domain handlers it dispatches to ever branch on
 * `ctx.era`/`authInfo`/`requestInfo`, so the extra context parameter would
 * go unused regardless of transport.
 */
export function makeModernServerFactory(
  ServerCtor: ModernServerCtor,
): () => InstanceType<ModernServerCtor> {
  return (): InstanceType<ModernServerCtor> => {
    const server = new ServerCtor(
      // §1.2 point 2 on the SDK path: the SDK builds `initialize`/
      // `server/discover` itself and echoes `serverInfo` verbatim, so the
      // announcement rides there. v2's `Implementation` type still predates
      // `_meta` on serverInfo; the schema itself passes unknown keys
      // through, so the cast is the narrow way to reach the wire without
      // widening the SDK's own contract.
      { name: "@tokenlighten/mcp-server", version: SERVER_PACKAGE_VERSION, _meta: {
        ...PROTOCOL_META,
        ...(SERVER_BUILD_ID !== undefined ? { server_build: SERVER_BUILD_ID } : {}),
      } } as unknown as { name: string; version: string },
      // issue #4: `instructions` here is what the SDK echoes back on
      // `initialize`/`server/discover` — the v2 `ServerOptions` type declares
      // it directly, so no cast/workaround is needed.
      // `tools: {}` for every client; `{ listChanged: true }` for the VS Code
      // client only (see hostActivationToolsCapability).
      { capabilities: { tools: hostActivationToolsCapability() }, instructions: SERVER_INSTRUCTIONS },
    );

    // tools/list — byte-identical to the legacy leg by construction: the
    // same `advertisedTools()` array, handed straight to the wire. A live VS
    // Code window-scoped override (mcp/hostActivation.ts) empties it, exactly
    // as on the legacy leg.
    server.setRequestHandler(
      "tools/list",
      async () => ({
        tools: hostActivationBypass(activeRoot) === undefined ? advertisedTools() : [],
      } as unknown as ListToolsResult),
    );

    // tools/call — the same dispatch and the same D11 advertised-or-refused
    // gate as the legacy leg (server.ts's `handleRequest`).
    server.setRequestHandler("tools/call", async (req) => {
      const r = req as unknown as { params: { name: string; arguments?: Record<string, unknown>; _meta?: Record<string, unknown> } };
      const toolName = r.params.name;
      const toolArgs = r.params.arguments ?? {};
      // The same live-override refusal as the legacy leg, ahead of the gate
      // below. The SDK answers a thrown error carrying a numeric `code` with
      // that code, so this is JSON-RPC -32601 like the hand-rolled leg's.
      const bypass = hostActivationBypass(activeRoot);
      if (bypass !== undefined) {
        throw Object.assign(
          new Error(hostActivationToolNotFoundMessage(toolName, bypass)),
          { code: HOST_ACTIVATION_ERROR_CODE },
        );
      }
      const toolDef = ALL_TOOLS.find((t) => t.name === toolName);
      if (!toolDef || !toolDef.enabled) {
        // r5 review: the same message as the hand-rolled leg, which names the
        // replacement of a pre-`tl_` name ("renamed tl_read_file; refresh the
        // tool list").
        throw new Error(unknownToolMessage("Tool not found", toolName));
      }
      // PI-03: forward the params `_meta` verbatim — the attestation channel
      // is authenticated inside dispatch; the era never reaches the verifier.
      const result = await callTool(toolName, toolArgs, r.params._meta);
      return result as unknown as CallToolResult;
    });

    // Proactive `notifications/tools/list_changed` for the VS Code window-scoped
    // override: once a 2025-era client has completed its handshake, tell it
    // whenever the override starts or ends. A 2026-07-28 connection has no
    // `initialize`, hence no hook here, and sees a change on its next
    // `tools/list`; the managed `.vscode/mcp.json` never selects that era. No
    // timer exists for any client but VS Code (startHostActivationWatch).
    let hostActivationWatch: HostActivationWatch | undefined;
    server.oninitialized = () => {
      hostActivationWatch?.stop();
      hostActivationWatch = startHostActivationWatch(activeRoot, () => {
        void server.sendToolListChanged().catch(() => undefined);
      });
    };
    server.onclose = () => {
      hostActivationWatch?.stop();
      hostActivationWatch = undefined;
    };

    return server;
  };
}
