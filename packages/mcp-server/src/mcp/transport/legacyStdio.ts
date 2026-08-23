// SDK-first stdio transport — the LEGACY 2025-era leg (@modelcontextprotocol
// /sdk v1, `protocolVersion` "2024-11-05").
//
// v0.10 alpha.1 / PI-09 implementation item 1
// (DESIGN-v0.10-expansion-plan-reconciliation.md §4 alpha.1 item 4): moved
// VERBATIM out of server.ts's transport tail so the modern 2026-07-28 entry
// (modernStdio.ts) can sit beside it behind TOKENLIGHTEN_PROTOCOL_ERA. This is
// a pure relocation: DESIGN §1 requires the legacy leg to stay byte-identical
// through the migration (70+ fixtures pin the "2024-11-05" literal and the
// `_meta` keys), so nothing here changed with the move except the imports.
//
// IMPORT-CYCLE NOTE: see fallbackStdio.ts — every server.ts binding used here
// is read inside a function body at call time, never at module evaluation.

import {
  ALL_TOOLS,
  SERVER_BUILD_ID,
  SERVER_PACKAGE_VERSION,
  advertisedTools,
  callTool,
} from "../../server.js";
// Imported from its canonical definition site rather than re-exported through
// server.ts: server.ts itself gets PROTOCOL_META from here, so this is the same
// frozen object with one less hop through the cycle.
import { PROTOCOL_META } from "../../protocol/envelope.js";
// issue #4 (host routing/discovery): same reasoning — the canonical home is
// protocol/serverInstructions.ts, not server.ts, so this leg reads the exact
// same frozen string with no hop through the cycle.
import { SERVER_INSTRUCTIONS } from "../../protocol/serverInstructions.js";

export async function tryRunWithSdk(): Promise<boolean> {
  try {
    const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
    const { StdioServerTransport } = await import(
      "@modelcontextprotocol/sdk/server/stdio.js"
    );

    const server = new Server(
      // §1.2 point 2 on the SDK path: the SDK builds `initialize` itself and
      // echoes `serverInfo` verbatim, so the announcement rides there.
      // The SDK's `Implementation` type predates `_meta` on serverInfo; the
      // schema itself passes unknown keys through, so the cast is the narrow
      // way to reach the wire without widening the SDK's own contract.
      { name: "@tokenlighten/mcp-server", version: SERVER_PACKAGE_VERSION, _meta: {
        ...PROTOCOL_META,
        ...(SERVER_BUILD_ID !== undefined ? { server_build: SERVER_BUILD_ID } : {}),
      } } as unknown as { name: string; version: string },
      // issue #4: `instructions` here is what the SDK echoes back on
      // `initialize` — the v1 `ServerOptions` type declares it directly, so
      // no cast/workaround is needed (contrast serverInfo._meta above).
      { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
    );

    // Register tools/list handler.
    server.setRequestHandler(
      { method: "tools/list" } as Parameters<typeof server.setRequestHandler>[0],
      async () => ({ tools: advertisedTools() }),
    );

    // Register tools/call handler.
    server.setRequestHandler(
      { method: "tools/call" } as Parameters<typeof server.setRequestHandler>[0],
      async (req: unknown) => {
        const r = req as {
          params: { name: string; arguments?: Record<string, unknown>; _meta?: Record<string, unknown> };
        };
        const toolName = r.params.name;
        const toolArgs = r.params.arguments ?? {};
        const toolDef = ALL_TOOLS.find((t) => t.name === toolName);
        // D11: same advertised-or-refused gate as the non-SDK transport.
        if (!toolDef || !toolDef.enabled) {
          throw new Error(`Tool not found: ${toolName}`);
        }
        // PI-03: `params._meta` carries the trusted-client-host context-state
        // channel. THE LEGACY LEG CARRIES IT TOO — `_meta` is a declared member
        // of `tools/call` params in every revision this leg serves and the SDK
        // schema passes it through, so the tier is not modern-era-only. This
        // is a pure pass-through: the value is untrusted until
        // state/contextAttestation.ts authenticates it, and with the flag off
        // it is not even parsed. Nothing about the legacy leg's own bytes
        // changes (the 70+ "2024-11-05" fixtures stay green).
        return callTool(toolName, toolArgs, r.params._meta);
      },
    );

    const transport = new StdioServerTransport();
    await server.connect(transport);
    process.stderr.write(`[tl-mcp] stdio transport (MCP SDK)\n`);
    return true;
  } catch {
    return false;
  }
}
