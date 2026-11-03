// rpc — extracted implementation; imports point to the owning modules.
import type { JsonRpcError } from "./artifact-csv.js";
import { ALLOW_WRITE } from "../runtime/config.js";
import { ALL_TOOLS } from "./read-admission2.js";
import { HOST_ACTIVATION_ERROR_CODE } from "../mcp/hostActivation.js";
import { KILL_SWITCH } from "../runtime/config.js";
import { PROTOCOL_META } from "../protocol/envelope.js";
import { RequestCancelledError } from "../util/requestCancellation.js";
import { SERVER_BUILD_ID } from "../runtime/config.js";
import { SERVER_INSTRUCTIONS } from "../protocol/serverInstructions.js";
import { SERVER_PACKAGE_VERSION } from "../runtime/config.js";
import { activeRoot } from "../runtime/config.js";
import { advertisedTools } from "./edit-validation.js";
import { assertSemanticFrontierV2FlagConsistency } from "../util/flags.js";
import { assertStartupBudgetsAreSane } from "../protocol/budget/wireBudget.js";
import { baseServerInstructionsForClient } from "../protocol/clientAdvertisement.js";
import { callTool } from "./autofollow.js";
import { captureClientId } from "../runtime/config.js";
import { hostActivationBypass } from "../mcp/hostActivation.js";
import { hostActivationToolNotFoundMessage } from "../mcp/hostActivation.js";
import { hostActivationToolsCapability } from "../mcp/hostActivation.js";
import { portableAdvertisementForClient } from "./edit-validation.js";
import { prewarmSymbolIndex } from "../tools/searchSymbols.js";
import { realDirectory } from "../write/resolveWorkspace.js";
import { resolvedClientId } from "../runtime/config.js";
import { runHttpTransport } from "../mcp/transport/index.js";
import { runTransport } from "../mcp/transport/index.js";
import { scheduleStartupWarmup } from "../util/startupWarmup.js";
import { unknownToolMessage } from "./dispatch-funnel.js";

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 dispatcher (hand-rolled; the legacy-era stdio transport's handler)
// ---------------------------------------------------------------------------

export type RpcRequest = {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
};

export type RpcResponse = {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcError;
};

export function makeError(id: string | number | null, code: number, message: string): RpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/**
 * issue #4: the `initialize` result's `instructions` string.
 * SERVER_INSTRUCTIONS always leads; when `degraded` is non-empty the existing
 * `Degraded: ...` line is preserved verbatim, appended on its own line. Split
 * out as a pure function so this shape is unit-testable directly — `degraded`
 * currently has no live producer in `handleRequest` below, so the append
 * branch has no reachable trigger through a real `initialize` call today.
 */
export function buildInitializeInstructions(degraded: readonly string[]): string {
  return degraded.length > 0
    ? `${SERVER_INSTRUCTIONS}\nDegraded: ${degraded.join(", ")}`
    : SERVER_INSTRUCTIONS;
}

/**
 * Client-aware variant of {@link buildInitializeInstructions} (VS Code /
 * GitHub Copilot Chat disambiguation — see protocol/clientAdvertisement.ts).
 * VS Code's own `clientId` gets `VSCODE_SERVER_INSTRUCTIONS`; every other or
 * unknown `clientId` gets exactly what `buildInitializeInstructions` has
 * always returned (the two share the same degraded-append shape, so this is
 * a strict superset, never a behavior change for a non-VS-Code caller).
 */
export function buildInitializeInstructionsForClient(
  clientId: string | undefined,
  degraded: readonly string[],
): string {
  // Portable mode must not inherit VS Code instructions that omit cwd/task.
  if (portableAdvertisementForClient(clientId)) return buildInitializeInstructions(degraded);
  const base = baseServerInstructionsForClient(clientId);
  return degraded.length > 0 ? `${base}\nDegraded: ${degraded.join(", ")}` : base;
}

export async function handleRequest(req: RpcRequest): Promise<RpcResponse | null> {
  const id = req.id ?? null;

  switch (req.method) {
    case "initialize": {
      const params = (req.params ?? {}) as Record<string, unknown>;
      const clientInfo = params["clientInfo"];
      if (clientInfo) {
        const ci = clientInfo as Record<string, unknown>;
        process.stderr.write(
          `[tl-mcp] client: ${ci["name"] ?? "?"} ${ci["version"] ?? ""}\n`,
        );
        // F-A7: capture once per connection — see capturedClientId's doc comment.
        if (typeof ci["name"] === "string" && ci["name"] !== "") captureClientId(ci["name"]);
      }
      const degraded: string[] = [];
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          // `{}` for every client; `{ listChanged: true }` for the VS Code
          // client only (hostActivationToolsCapability), whose transport
          // announces a tool list the window-scoped bypass emptied or restored.
          capabilities: { tools: hostActivationToolsCapability() },
          // §1.2 announcement point 2: the AUTHORITATIVE point for a client
          // doing capability negotiation before its first call. Paid once per
          // connection, and it costs nothing against the advertised-schema
          // budget. `serverInfo` carries it too so the modern SDK transport —
          // which builds its own `initialize` result and only passes
          // `serverInfo` through — announces the same version.
          _meta: { ...PROTOCOL_META },
          serverInfo: {
            name: "@tokenlighten/mcp-server",
            version: SERVER_PACKAGE_VERSION,
            _meta: {
              ...PROTOCOL_META,
              ...(SERVER_BUILD_ID !== undefined ? { server_build: SERVER_BUILD_ID } : {}),
            },
          },
          // W3 (2026-07-30, dist build-id echo): initialize is inherently
          // one-shot per connection, so no session-state gating is needed
          // here (contrast the per-workspace claimServerBuildAnnouncement
          // gate attachServerBuildOnce uses for the first task_pack response).
          ...(SERVER_BUILD_ID !== undefined ? { server_build: SERVER_BUILD_ID } : {}),
          // issue #4: `instructions` is now ALWAYS present (previously only
          // set when degraded) so a host that surfaces it in the system
          // prompt (e.g. Claude Code's "MCP Server Instructions") routes
          // discovery-shaped tasks to TL from turn 0.
          // VS Code / GitHub Copilot Chat disambiguation: `resolvedClientId()`
          // reads back the `capturedClientId` just assigned above (or the
          // TOKENLIGHTEN_CLIENT_ID override), so a VS Code connection gets
          // VSCODE_SERVER_INSTRUCTIONS from its very first `initialize`
          // response — every other/unknown client gets exactly the
          // `buildInitializeInstructions(degraded)` output this line always
          // produced (see buildInitializeInstructionsForClient's doc comment).
          instructions: buildInitializeInstructionsForClient(resolvedClientId(), degraded),
        },
      };
    }

    case "notifications/initialized":
      // The handshake is complete and the `initialize` result already sent:
      // the idle time before the first tools/call pre-pays that call's
      // one-time costs (util/startupWarmup.ts; TL_STARTUP_WARMUP=0 disables).
      scheduleStartupWarmup(activeRoot);
      // ...and starts the workspace's symbol index (sourceIndexAccess.ts Prewarm).
      prewarmSymbolIndex(activeRoot);
      return null; // notification — no response

    case "tools/list": {
      // A live VS Code window-scoped override (mcp/hostActivation.ts) empties
      // the list; for every other client this is the same one array as ever.
      return {
        jsonrpc: "2.0",
        id,
        result: { tools: hostActivationBypass(activeRoot) === undefined ? advertisedTools() : [] },
      };
    }

    case "tools/call": {
      const params = (req.params ?? {}) as Record<string, unknown>;
      const toolName = String(params["name"] ?? "");
      const toolArgs = (params["arguments"] ?? {}) as Record<string, unknown>;

      // Before the advertised-or-refused gate below, so even an unknown name
      // gets the reason. The live override is re-checked on every call (the
      // parsed file is cached, the owner-liveness probe is not).
      const bypass = hostActivationBypass(activeRoot);
      if (bypass !== undefined) {
        return makeError(id, HOST_ACTIVATION_ERROR_CODE, hostActivationToolNotFoundMessage(toolName, bypass));
      }

      const toolDef = ALL_TOOLS.find((t) => t.name === toolName);
      // D11: the alias gate is gone with the aliases. Advertised-or-refused —
      // a pre-`tl_` name included (2026-10-02); its refusal only names the
      // replacement, for a caller holding a stale tool list.
      if (!toolDef || !toolDef.enabled) {
        return makeError(id, -32601, unknownToolMessage("Tool not found", toolName));
      }

      try {
        // PI-03: the hand-rolled JSON-RPC leg parses `params` itself, so
        // `_meta` arrives verbatim. Same pass-through, same authentication
        // downstream — both legs reach one verifier.
        const requestMeta = params["_meta"];
        const result = await callTool(
          toolName,
          toolArgs,
          typeof requestMeta === "object" && requestMeta !== null && !Array.isArray(requestMeta)
            ? (requestMeta as Record<string, unknown>)
            : undefined,
        );
        return { jsonrpc: "2.0", id, result };
      } catch (err: unknown) {
        // The client cancelled this request (MCP "Cancellation"): it has no
        // response, so let the transport see the cancellation rather than
        // turning it into a -32603 answer. Only a request the transport bound
        // a signal to can get here — see util/requestCancellation.ts.
        if (err instanceof RequestCancelledError) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        return makeError(id, -32603, `Internal error: ${msg}`);
      }
    }

    case "resources/list":
      return { jsonrpc: "2.0", id, result: { resources: [] } };

    case "prompts/list":
      return { jsonrpc: "2.0", id, result: { prompts: [] } };

    default:
      if (req.method.startsWith("notifications/")) return null;
      return makeError(id, -32601, `Method not found: ${req.method}`);
  }
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

/**
 * FIX-FD (2026-09-28, external v0.14.3 evaluation §6.2, bogus-workspace-root
 * finding): `activeRoot` (a `--workspace`/positional CLI arg, or
 * TOKENLIGHTEN_ROOT) was never checked for existence. The first writer that
 * opened a workspace-scoped store against it — `WorkspaceStateStore.open`'s
 * `mkdirSync(dir, {recursive:true})` chief among them — then silently
 * MATERIALIZED the entire missing chain, including the workspace root itself,
 * wherever this process's own OS cwd happened to be at launch:
 * `pack/.tokenlighten/state/meta.json` and `no-import/.tokenlighten/
 * state/meta.json`, both found sitting directly at THIS repository's own
 * root, trace to exactly this gap. `.tokenlighten/` may only ever be created
 * inside an existing, validated root — a root that fails this check must
 * never reach a writer.
 */
export function assertActiveRootExists(): void {
  if (realDirectory(activeRoot) === undefined) {
    // No "[tl-mcp] " prefix here (round-2 evaluation finding P2-17(b)): bin.ts's
    // catch-all already writes "[tl-mcp] fatal: <message>", so baking the same
    // tag into the thrown message doubled it to "[tl-mcp] fatal: [tl-mcp]
    // workspace root …" at startup.
    throw new Error(`workspace root does not exist or is not a directory: ${activeRoot}`);
  }
}

export async function run(): Promise<void> {
  // Strictly before any transport is wired up, alongside this function's
  // other pre-transport startup assertions below (assertStartupBudgetsAreSane,
  // assertSemanticFrontierV2FlagConsistency) — a throw here propagates through
  // this function's promise to bin.ts's existing fatal catch ([tl-mcp] fatal:
  // <message>, exit 1), zero bytes ever written to stdout, exactly like those.
  assertActiveRootExists();

  // v0.10 PI-09 deferred cell: resolved and validated BEFORE any transport
  // is wired up, so a TOKENLIGHTEN_HTTP_PORT set alongside
  // TOKENLIGHTEN_PROTOCOL_ERA=legacy fails fast with a clear message rather
  // than leaving the stdio transport connected while this call unwinds. See
  // mcp/transport/index.ts's runHttpTransport and mcp/transport/modernHttp.ts's
  // module header for the full policy.
  await runHttpTransport();

  process.stderr.write(
    `[tl-mcp] starting v${SERVER_PACKAGE_VERSION} server, root: ${activeRoot}\n`,
  );

  if (ALLOW_WRITE) {
    process.stderr.write(`[tl-mcp] --allow-write enabled, writable workspace: ${activeRoot}\n`);
  }
  if (KILL_SWITCH) {
    process.stderr.write("[tl-mcp] TL_KILL_SWITCH=1: all tools disabled\n");
  }

  // P3a S4 / gate G9: a misconfigured budget table or reserve is a STARTUP
  // error (plan §7.4), never a wire outcome -- checked here, strictly before
  // the transport starts accepting requests. A throw propagates through this
  // function's promise to bin.ts's existing fatal catch ([tl-mcp] fatal:
  // <message>, exit 1), with zero bytes ever written to stdout.
  assertStartupBudgetsAreSane();

  // R11 SF-7/R-8 (independent review, 2026-09-03): util/flags.ts's own doc
  // comment for this function said "No startup path calls this yet ... exists
  // for tests today and for that future wave to call explicitly once one
  // exists" — but three other modules' comments already asserted it DID run
  // at startup (features/task-pack/sfRelationSeam.ts,
  // features/task-pack/canonicalDecision.ts, protocol/decisionWire.ts), which
  // was simply false: grep found zero production callers. Wired here, next to
  // the other startup-only validation, on the same fail-fast contract — a
  // conflicting TL_SF_* combination throws before the transport ever accepts
  // a request, never as a wire outcome.
  assertSemanticFrontierV2FlagConsistency();

  // Era-selected stdio transport. Default (`legacy`, or an unset/unknown
  // TOKENLIGHTEN_PROTOCOL_ERA) is exactly the pre-v0.10 path: the hand-rolled
  // JSON-RPC transport (mcp/transport/legacyStdio.ts), started directly.
  await runTransport();
}
