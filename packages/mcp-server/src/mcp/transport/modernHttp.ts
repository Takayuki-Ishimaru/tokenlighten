// MODERN-era Streamable HTTP transport — MCP Specification 2026-07-28,
// TypeScript SDK v2 (`@modelcontextprotocol/server` 2.x).
//
// v0.10 PI-09 deferred cell (DESIGN-v0.10-expansion-plan-v1.3.md §4.5).
// OPT-IN and MODERN-ONLY: this leg only ever binds a socket when BOTH of the
// following hold —
//
//   TOKENLIGHTEN_HTTP_PORT is set (any non-negative integer 0-65535; 0 asks
//   the OS for an ephemeral port).
//   TOKENLIGHTEN_PROTOCOL_ERA=modern (mcp/transport/index.ts).
//
// Unset TOKENLIGHTEN_HTTP_PORT => no HTTP listener, exactly today's
// behavior — nothing here changes the default stdio-only posture. The
// interaction with the OTHER era is a deliberate refusal, not a silent
// downgrade: TOKENLIGHTEN_HTTP_PORT set while the era resolves to `legacy`
// throws a startup error (mcp/transport/index.ts's `runHttpTransport`) named
// clearly enough that a host log shows exactly what to change, BEFORE the
// stdio transport is wired up. The alternative — silently ignoring the port,
// or silently serving HTTP over the legacy wire shape — would leave an
// operator who explicitly asked for an HTTP endpoint believing one exists
// when it does not. A malformed port VALUE (not an integer, or outside
// 0-65535) is the opposite case — a typo in an opt-in secondary feature — and
// fails OPEN instead: one stderr warning, HTTP stays off, the stdio
// transport the host already depends on is unaffected (see resolveHttpPort).
//
// WHAT IS AND IS NOT DIFFERENT FROM THE MODERN STDIO LEG
//
//   Same:  the exact server factory modernStdio.ts builds — see
//          modernServerFactory.ts's header. Every tool call answers
//          byte-identically whether it arrives over stdio or HTTP.
//   New:   `createMcpHandler` (SDK v2's fetch-shaped HTTP entry, exported
//          from the package's main `.` export — no `./http` subpath exists)
//          instead of `serveStdio`. `legacy: 'reject'` is passed
//          deliberately: this leg is modern-only strict, so a 2025-era
//          request over THIS port gets the SDK's own
//          unsupported-protocol-version error rather than a second,
//          duplicate legacy implementation living beside legacyStdio.ts's.
//          `responseMode: 'json'` is pinned rather than left at the 'auto'
//          default: every tool call here answers synchronously with no
//          mid-call notification, so 'auto' would already always choose a
//          single JSON body — pinning it removes the possibility entirely
//          (never an SSE upgrade to plumb through the node:http adapter
//          below) rather than relying on that always being true. Per the
//          2026-07-28 revision this SDK entry implements: stateless, no
//          session handshake, no `Mcp-Session-Id` — every request carries
//          its own protocol version, exactly like the stdio leg's opening
//          exchange (modernStdio.ts's module header).
//
// DEPENDENCIES. Zero new packages. `@modelcontextprotocol/server` is already
// a `dependencies` entry of this package (modernStdio.ts already dynamically
// imports it); `createMcpHandler` is exported from that SAME package — no
// `@modelcontextprotocol/node` needed for the SDK side. The only remaining
// piece is bridging node:http's `(req, res)` callback shape to the
// fetch-shaped `(Request) => Promise<Response>` handler `createMcpHandler`
// returns; `toWebRequest`/`writeWebResponse` below are that bridge, written
// by hand against Node's OWN global `Request`/`Response`/`Headers` (stable,
// unflagged since Node 18; this package's `engines.node` is already ">=20").
// The SDK's docs point node:http users at `@modelcontextprotocol/node`'s
// `toNodeHandler` for this exact bridge, but that package adds a dependency
// for what Node's own globals plus ~40 lines already cover; see the
// implementation report for the full justification.
//
// SECURITY.
//
//   Bind address. Hard-coded `DEFAULT_HTTP_HOST = "127.0.0.1"` — IPv4
//   loopback ONLY, never `0.0.0.0`/`::`, and this is the default with
//   TOKENLIGHTEN_HTTP_HOST unset. Binding loopback-only is the entire
//   containment story for v0.10: the socket is reachable only from
//   processes already running on this machine. TOKENLIGHTEN_HTTP_HOST
//   widens this EXPLICITLY (an operator choice, not a default) — widening
//   to any non-loopback address exposes the tool surface (read_file,
//   edit_file when --allow-write is set, search_files) to every other host
//   that can reach that address, with NO authentication layer in front of
//   it (below). Do not widen this on a shared or otherwise untrusted
//   network.
//   No auth layer in v0.10. There is no bearer token, no API key, no
//   OAuth. The loopback bind above is the ONLY containment. Anything that
//   can open a TCP connection to the bound address can call every
//   advertised tool (subject to --allow-write for writes, exactly as
//   stdio already gates it).
//   Host/Origin validation (defense in depth, loopback bind only). Even
//   loopback-only sockets are reachable from a browser tab open on the
//   SAME machine via DNS rebinding: a page served from a public hostname
//   that later resolves to 127.0.0.1 can still point `fetch()` at this
//   port, and the browser will happily attach whatever `Origin`/`Host`
//   headers match the page's ORIGINAL hostname, not the rebound address.
//   createMcpHandler's own docs recommend exactly this guard when mounting
//   the handler bare (see `isLegacyRequest`'s example in the v2 typings);
//   `hostHeaderValidationResponse`/`originValidationResponse` with
//   `localhostAllowedHostnames`/`localhostAllowedOrigins` are exported from
//   the SAME already-a-dependency package, so this costs zero additional
//   surface. It is applied ONLY when serving the hard-coded loopback
//   default (`host === DEFAULT_HTTP_HOST`): a widened TOKENLIGHTEN_HTTP_HOST
//   cannot be pre-enumerated into a Host/Origin allowlist (the operator may
//   bind any address for any reason), so that posture relies solely on the
//   operator's own network containment, exactly as documented above.
//   Request body cap. MAX_HTTP_BODY_BYTES mirrors fallbackStdio.ts's
//   MAX_FALLBACK_LINE_BYTES ceiling class (CWE-400 finding,
//   TL-SECURITY-REVIEW-2026-08-15 #7): an oversized POST body is rejected
//   rather than buffered without bound.

import * as http from "node:http";

import { makeModernServerFactory } from "./modernServerFactory.js";

/** Environment variable that enables this leg (unset = no HTTP; current behavior). */
export const HTTP_PORT_ENV = "TOKENLIGHTEN_HTTP_PORT";

/** Environment variable that widens the bind host beyond the loopback default. */
export const HTTP_HOST_ENV = "TOKENLIGHTEN_HTTP_HOST";

/** Hard-coded bind default — see the module header's SECURITY section. */
export const DEFAULT_HTTP_HOST = "127.0.0.1";

/** Same ceiling CLASS as fallbackStdio.ts's MAX_FALLBACK_LINE_BYTES; see SECURITY above. */
const MAX_HTTP_BODY_BYTES = 16 * 1024 * 1024;

/**
 * Resolves the configured HTTP port. `undefined` — unset/empty, OR a value
 * that fails to parse as an integer 0-65535 — means "no HTTP", today's
 * unchanged behavior. An out-of-range or non-numeric non-empty value is a
 * fail-OPEN (one stderr warning naming the value, HTTP stays off) rather
 * than a startup crash: unlike the era+port coherence check (index.ts's
 * `runHttpTransport` — a genuine "you asked for something this process
 * cannot serve" refusal), a typo'd port value should not take down the
 * stdio transport the host already depends on.
 */
export function resolveHttpPort(
  // Literal property read (not `process.env[HTTP_PORT_ENV]`):
  // protocolVersionBranch.spec.ts pins the set of computed-name env reads so
  // a new dynamic read cannot appear unnoticed.
  raw: string | undefined = process.env.TOKENLIGHTEN_HTTP_PORT,
): number | undefined {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return undefined;
  // Reject anything Number() would otherwise coerce leniently (e.g. "",
  // whitespace, hex/exponent forms a port was never meant to accept) by
  // requiring an ASCII-digit-only string before parsing.
  if (!/^\d+$/.test(trimmed)) {
    process.stderr.write(
      `[tl-mcp] invalid ${HTTP_PORT_ENV}=${JSON.stringify(raw)}; expected an integer 0-65535 — HTTP transport stays off\n`,
    );
    return undefined;
  }
  const port = Number(trimmed);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    process.stderr.write(
      `[tl-mcp] invalid ${HTTP_PORT_ENV}=${JSON.stringify(raw)}; expected an integer 0-65535 — HTTP transport stays off\n`,
    );
    return undefined;
  }
  return port;
}

/**
 * Resolves the bind host. Defaults to the hard-coded loopback-only
 * {@link DEFAULT_HTTP_HOST}; {@link HTTP_HOST_ENV} widens it EXPLICITLY —
 * see the module header's SECURITY section for what that gives up.
 */
export function resolveHttpHost(
  raw: string | undefined = process.env.TOKENLIGHTEN_HTTP_HOST,
): string {
  const trimmed = (raw ?? "").trim();
  return trimmed === "" ? DEFAULT_HTTP_HOST : trimmed;
}

/** A running Streamable HTTP listener. */
export interface HttpTransportHandle {
  /** The address `http.Server.address()` actually reports — the ground truth for loopback-only assertions. */
  readonly host: string;
  /** The port actually bound (resolves TOKENLIGHTEN_HTTP_PORT=0's ephemeral assignment). */
  readonly port: number;
  /** Closes the listener and tears down the modern-era handler's in-flight state. */
  close(): Promise<void>;
}

/** Reads a node:http request body into a single Buffer, capped at {@link MAX_HTTP_BODY_BYTES}. */
function readRequestBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_HTTP_BODY_BYTES) {
        req.destroy();
        reject(new Error(`request body exceeds ${MAX_HTTP_BODY_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * Thin node:http -> web-standard `Request` adapter. Buffers the body
 * (bounded by {@link MAX_HTTP_BODY_BYTES}) rather than passing a streamed
 * `ReadableStream` body: every request this server accepts is a small
 * JSON-RPC envelope (AGENTS.md's existing 32 KiB `create:true` ceiling is
 * the largest single field in the largest realistic call), so buffering
 * costs nothing observable and sidesteps `RequestInit.duplex` entirely —
 * that option is only required when the body itself is a stream.
 */
async function toWebRequest(req: http.IncomingMessage, fallbackHost: string): Promise<Request> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? fallbackHost}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) { for (const v of value) headers.append(key, v); }
    else headers.append(key, value);
  }
  const method = (req.method ?? "GET").toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";
  const body = hasBody ? await readRequestBody(req) : undefined;
  return new Request(url, { method, headers, body });
}

/** Pumps a web-standard `Response` onto a node:http `ServerResponse`. */
async function writeWebResponse(response: Response, res: http.ServerResponse): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => { res.setHeader(key, value); });
  if (!response.body) { res.end(); return; }
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } finally {
    res.end();
  }
}

/**
 * Attempts to start the modern-era Streamable HTTP leg on `host`:`port`.
 * Returns the bound handle on success; returns `undefined` — after one
 * stderr line naming the reason — when the SDK v2 packages cannot be loaded,
 * mirroring modernStdio.ts's `tryRunWithModernSdk` fail-open shape (an
 * unavailable SECONDARY transport must not take down the primary stdio one).
 */
export async function tryRunModernHttp(port: number, host: string): Promise<HttpTransportHandle | undefined> {
  try {
    const {
      Server,
      createMcpHandler,
      hostHeaderValidationResponse,
      localhostAllowedHostnames,
      originValidationResponse,
      localhostAllowedOrigins,
    } = await import("@modelcontextprotocol/server");

    // Same factory the stdio leg builds — see modernServerFactory.ts.
    const buildServer = makeModernServerFactory(Server);
    const handler = createMcpHandler(buildServer, { legacy: "reject", responseMode: "json" });

    // DNS-rebinding defense in depth (module header SECURITY section) —
    // applied only on the safe, hard-coded loopback default.
    const applyRebindingGuard = host === DEFAULT_HTTP_HOST;
    const allowedHostnames = localhostAllowedHostnames();
    const allowedOrigins = localhostAllowedOrigins();

    async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
      try {
        const request = await toWebRequest(req, `${host}:${port}`);
        const rejected = applyRebindingGuard
          ? (hostHeaderValidationResponse(request, allowedHostnames) ?? originValidationResponse(request, allowedOrigins))
          : undefined;
        const response = rejected ?? await handler.fetch(request);
        await writeWebResponse(response, res);
      } catch (err: unknown) {
        // writeWebResponse's own `finally` may already have ended the
        // response (a stream read failing mid-pump, for example) before
        // this catch runs — a second res.end() on an ended response is a
        // "write after end" fault, not a client-visible error, so guard it.
        if (res.writableEnded) return;
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader("content-type", "application/json");
        }
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32603, message: err instanceof Error ? err.message : "Internal error" },
        }));
      }
    }

    const httpServer = http.createServer((req, res) => {
      void handleRequest(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(port, host, () => {
        httpServer.removeListener("error", reject);
        resolve();
      });
    });

    // Post-listen: a socket-level fault on an already-bound server (rare) is
    // logged, not left to Node's default unhandled-'error' crash — a
    // SECONDARY transport's later fault must not take the whole process
    // down, exactly like tryRunModernHttp's own try/catch below.
    httpServer.on("error", (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[tl-mcp] http transport error: ${msg}\n`);
    });

    // The OS's own report of what got bound — the ground truth for the
    // loopback-only assertion (resolves TOKENLIGHTEN_HTTP_PORT=0's ephemeral
    // port, and would reveal a mistaken 0.0.0.0/:: bind if one ever crept in).
    const bound = httpServer.address();
    const boundHost = bound && typeof bound === "object" ? bound.address : host;
    const boundPort = bound && typeof bound === "object" ? bound.port : port;

    // Human-readable AND machine-parseable (see modernHttpTransport.spec.ts):
    // one line, `host:port` in the established [tl-mcp] stderr convention —
    // no separate JSON-on-stderr format invented for this alone.
    process.stderr.write(
      `[tl-mcp] http transport (MCP SDK v2, era=modern) listening on ${boundHost}:${boundPort}\n`,
    );

    return {
      host: boundHost,
      port: boundPort,
      close: () => new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
        void handler.close();
      }),
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[tl-mcp] http transport unavailable: ${msg}\n`);
    return undefined;
  }
}
