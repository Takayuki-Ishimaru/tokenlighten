// Dual-era MCP transport selection.
//
// v0.10 alpha.1 / PI-09 implementation items 1-2
// (DESIGN-v0.10-expansion-plan-v1.3.md §4.5 "MCP 2026-07-28 compatibility
// boundary"; DESIGN-v0.10-expansion-plan-reconciliation.md §4 alpha.1 item 4).
//
//   legacy  2025-era compatibility  — @modelcontextprotocol/sdk v1 `Server` +
//                                     `StdioServerTransport`, hand-rolled
//                                     JSON-RPC fallback beneath it. Exactly
//                                     today's path, byte-identical.
//   modern  2026-07-28              — TypeScript SDK v2 server package.
//
// The era is a STARTUP choice, resolved once from the environment; domain
// handlers never branch on it (§4.5: "domain handlerはprotocol eraを直接分岐
// せず、正規化済み ToolCommand を受け取る" — here both legs funnel into the
// same `callTool`/`advertisedTools` pair). Default is `legacy`: the modern leg
// is opt-in for the whole v0.10 alpha line.
//
// v0.10 PI-09 deferred cell adds a SECOND, independent opt-in: `modernHttp.ts`
// serves the same modern-era server factory over Streamable HTTP when
// TOKENLIGHTEN_HTTP_PORT is set (`runHttpTransport` below). It is layered on
// TOP of the era choice, not a third era value — the wire transport (stdio vs.
// HTTP) and the protocol era (legacy vs. modern) are orthogonal axes, and the
// HTTP leg only ever serves the modern axis (see runHttpTransport's doc and
// modernHttp.ts's module header for the full policy, including why an
// era=legacy + port-set combination is a startup refusal rather than a
// silent downgrade).

export type ProtocolEra = "legacy" | "modern";

/** Environment variable that selects the transport era. */
export const PROTOCOL_ERA_ENV = "TOKENLIGHTEN_PROTOCOL_ERA";

/** The era used when the variable is unset, empty, or unrecognized. */
export const DEFAULT_PROTOCOL_ERA: ProtocolEra = "legacy";

const KNOWN_ERAS: readonly ProtocolEra[] = ["legacy", "modern"];

/**
 * Resolves the requested era. Unset/empty => `legacy` silently; an
 * unrecognized value => `legacy` plus exactly ONE stderr warning line, so a
 * typo is visible in the host's server log without turning startup into a
 * failure (fail-open to the frozen legacy wire is the safe alpha default).
 */
export function resolveProtocolEra(
  // Literal property read (not `process.env[PROTOCOL_ERA_ENV]`):
  // protocolVersionBranch.spec.ts pins the set of computed-name env reads so a
  // new dynamic read cannot appear unnoticed, and classifies this variable as
  // an out-of-contract startup toggle.
  raw: string | undefined = process.env.TOKENLIGHTEN_PROTOCOL_ERA,
): ProtocolEra {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "") return DEFAULT_PROTOCOL_ERA;
  if ((KNOWN_ERAS as readonly string[]).includes(value)) return value as ProtocolEra;
  process.stderr.write(
    `[tl-mcp] unknown ${PROTOCOL_ERA_ENV}=${JSON.stringify(raw ?? "")}; `
      + `expected ${KNOWN_ERAS.join("|")} — using ${DEFAULT_PROTOCOL_ERA}\n`,
  );
  return DEFAULT_PROTOCOL_ERA;
}

/**
 * Starts the stdio transport for `era`. Returns the era actually served, which
 * can differ from the request when the modern leg is unavailable and we
 * fail open to legacy.
 */
export async function runTransport(
  era: ProtocolEra = resolveProtocolEra(),
): Promise<ProtocolEra> {
  if (era === "modern") {
    const { tryRunWithModernSdk } = await import("./modernStdio.js");
    if (await tryRunWithModernSdk()) return "modern";
    // Fail-open to legacy: an alpha-stage opt-in must never leave the host
    // with a server that answers nothing. tryRunWithModernSdk() has already
    // written the reason line.
    process.stderr.write(
      `[tl-mcp] ${PROTOCOL_ERA_ENV}=modern requested but unavailable; falling back to legacy transport\n`,
    );
  }

  // Legacy: try SDK first; fall back to hand-rolled if SDK unavailable.
  const { tryRunWithSdk } = await import("./legacyStdio.js");
  const sdkOk = await tryRunWithSdk();
  if (!sdkOk) {
    const { runStdioFallback } = await import("./fallbackStdio.js");
    runStdioFallback();
  }
  return "legacy";
}

/**
 * Starts the opt-in Streamable HTTP leg (modernHttp.ts) when
 * TOKENLIGHTEN_HTTP_PORT is set. No-op — returns without doing anything —
 * when the port is unset, which is the default and leaves today's
 * stdio-only behavior untouched.
 *
 * THROWS when the port is set but `era` is not `modern`: the HTTP leg only
 * ever serves the modern (2026-07-28) protocol revision (modernHttp.ts's
 * module header), so an operator who set the port while the era resolves to
 * `legacy` has asked for something this process cannot serve. Refusing
 * loudly at startup — rather than silently ignoring the port, or silently
 * serving HTTP over the legacy wire shape — is deliberate: call this BEFORE
 * runTransport() so the failure surfaces before the stdio transport (which
 * a host may already be mid-handshake with) is wired up at all.
 */
export async function runHttpTransport(
  era: ProtocolEra = resolveProtocolEra(),
): Promise<void> {
  const { resolveHttpPort, resolveHttpHost, tryRunModernHttp, HTTP_PORT_ENV } = await import("./modernHttp.js");
  const port = resolveHttpPort();
  if (port === undefined) return; // Unset/invalid: no HTTP, current behavior.
  if (era !== "modern") {
    throw new Error(
      `${HTTP_PORT_ENV} is set (${port}) but ${PROTOCOL_ERA_ENV}=${era}; `
        + `the Streamable HTTP transport only serves the modern (2026-07-28) `
        + `era — set ${PROTOCOL_ERA_ENV}=modern or unset ${HTTP_PORT_ENV}.`,
    );
  }
  const host = resolveHttpHost();
  await tryRunModernHttp(port, host);
}
