// Stdio JSON-RPC 2.0 transport of the LEGACY 2025-era protocol
// (`protocolVersion` "2024-11-05") — hand-rolled, and the only legacy-era wire
// this server has ever shipped.
//
// HISTORY. v0.10 alpha.1 / PI-09 implementation item 1
// (DESIGN-v0.10-expansion-plan-reconciliation.md §4 alpha.1 item 4) moved
// this transport VERBATIM out of server.ts's transport tail so a second
// (modern 2026-07-28) era entry could sit beside it, under the name
// "fallback": it was believed to run only when an @modelcontextprotocol/sdk
// v1 `Server` leg, tried first, was unavailable. That SDK leg never worked. It
// registered its handlers with plain objects instead of the SDK's Zod request
// schemas, so the SDK threw "Schema is missing a method literal", the
// swallowed error reported the SDK as unavailable, and every build — the
// repository's dev dist and the bundled VSIX alike — ran this transport. The
// SDK leg is deleted (DESIGN-v0.14-plan.md §19.14); this file is, explicitly,
// the legacy-era transport. The wire did not change: 70+ fixtures pin its
// bytes (responses, the `initialize` result, error shapes).
//
// REQUEST CANCELLATION. The client may send `notifications/cancelled` for a
// request it no longer wants (MCP "Cancellation"). This transport handles it
// OUT OF BAND — the moment its line is read, never behind the request it
// names — and a cancelled request gets no response: one still waiting its turn
// never runs, one in flight has its signal aborted (see
// util/requestCancellation.ts, which also says where the edit tools honour
// that signal so a cancelled edit never writes).
//
// IMPORT-CYCLE NOTE: this module imports from ../../server.js, which imports
// ./index.js, which imports this file. The cycle is safe because every
// server.ts binding used here is read INSIDE a function body at call time
// (run() -> runTransport() -> here), long after both modules finish
// evaluating. There is no top-level access to a server.ts binding, and
// `handleRequest` as a default parameter value is likewise evaluated per call.

import * as readline from "readline";

import {
  activeRoot,
  handleRequest,
  makeError,
  type RpcRequest,
  type RpcResponse,
} from "../../server.js";
import { RequestCancelledError, runWithRequestSignal } from "../../util/requestCancellation.js";
import { startHostActivationWatch, type HostActivationWatch } from "../hostActivation.js";

// SECURITY (TL-SECURITY-REVIEW-2026-08-15 finding 7, CWE-400): this transport
// used to buffer+JSON.parse any readline "line" of any size and fire every
// handleRequest() concurrently with zero backpressure. 16 MB matches this
// server's existing 16 MB-class per-unit ceiling family
// (office/zipPreflight.ts ZIP_LIMITS.maxPartUncompressedBytes, tools/archive
// .ts ARCHIVE_LIMITS.maxMemberBytes/maxScanBytes) — comfortably above any
// legitimate single JSON-RPC request this server accepts (a create:true
// file body alone is capped at 32 KiB per AGENTS.md; a large batched
// edits[] call stays orders of magnitude under this), while still being a
// hard, known ceiling rather than "whatever fits in memory".
const MAX_LEGACY_LINE_BYTES = 16 * 1024 * 1024;

/**
 * A request that has been read and neither answered nor dropped yet — queued
 * behind an earlier one, or running. Only these can be cancelled.
 */
interface LiveRequest {
  readonly id: string | number;
  readonly controller: AbortController;
  /** Set once the client cancelled it; from then on it never gets a response. */
  cancelled: boolean;
}

/**
 * `input`/`output`/`handler` are TEST-ONLY injection points (mirrors this
 * codebase's established quota-override-seam convention — see office/pdf.ts's
 * PdfExtractionQuotaOverrides) so a regression test can drive this transport
 * with in-memory streams and a controllable-latency handler instead of real
 * stdio and the full tool dispatch. Production always calls this with zero
 * arguments (see runTransport(), index.ts), so the defaults are the only path
 * that ever executes outside tests.
 */
export function runLegacyStdio(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
  handler: (req: RpcRequest) => Promise<RpcResponse | null> = handleRequest,
  maxLineBytes: number = MAX_LEGACY_LINE_BYTES,
): void {
  process.stderr.write(`[tl-mcp] stdio transport (JSON-RPC 2.0)\n`);
  process.stderr.write(`[tl-mcp] workspace root: ${activeRoot}\n`);

  const rl = readline.createInterface({ input });

  // Requests are fully serialized (a queued line always gets its turn, in
  // order) rather than fired unboundedly: trading away concurrency for a hard
  // resource bound is the right tradeoff for a stdio server whose one client
  // waits on each answer anyway — and it is what lets an edit's commit point
  // (util/requestCancellation.ts) trust that no other request is writing.
  let queueTail: Promise<void> = Promise.resolve();

  // Every request read and not yet answered or dropped, by JSON-RPC id (a
  // number and its string spelling are different ids, as in JSON-RPC). Only a
  // request with a string|number id can be named by a cancel; `initialize` is
  // never tracked because the MCP spec forbids cancelling it, so a cancel
  // naming its id finds nothing and is ignored like any other unknown id.
  const live = new Map<string | number, LiveRequest>();

  const track = (req: RpcRequest): LiveRequest | undefined => {
    const id = req.id;
    if (typeof req.method !== "string" || req.method === "initialize") return undefined;
    if (typeof id !== "string" && typeof id !== "number") return undefined;
    const entry: LiveRequest = { id, controller: new AbortController(), cancelled: false };
    live.set(id, entry);
    return entry;
  };

  const untrack = (entry: LiveRequest | undefined): void => {
    // Identity check: an id the client reused (a cancelled request's id, say)
    // may already name a newer request.
    if (entry !== undefined && live.get(entry.id) === entry) live.delete(entry.id);
  };

  /**
   * `notifications/cancelled` `{requestId, reason?}`. MAY be ignored when the
   * request is unknown, already completed, or cannot be cancelled, and
   * malformed params are not worth an error: this is a notification, so there
   * is nobody to tell.
   */
  const cancel = (params: unknown): void => {
    if (params === null || typeof params !== "object") return;
    const { requestId, reason } = params as { requestId?: unknown; reason?: unknown };
    if (typeof requestId !== "string" && typeof requestId !== "number") return;
    const entry = live.get(requestId);
    if (entry === undefined) return;
    live.delete(requestId);
    entry.cancelled = true;
    entry.controller.abort(
      new RequestCancelledError(
        typeof reason === "string" && reason !== "" ? `request cancelled: ${reason.slice(0, 200)}` : undefined,
      ),
    );
    process.stderr.write(`[tl-mcp] stdio transport: request ${JSON.stringify(requestId)} cancelled by the client\n`);
  };

  // VS Code window-scoped bypass (mcp/hostActivation.ts). Once the client has
  // completed the handshake, poll whether the override started or ended (a
  // file nobody refreshes ends by ageing out, like a removed one) and tell the
  // host with one whole-line `notifications/tools/list_changed` per
  // transition, so it re-lists (empty while the override is live). The
  // watch exists only for the VS Code client by environment — for every other
  // client `startHostActivationWatch` returns no timer and nothing is ever
  // written — and it ends with the input.
  let hostActivationWatch: HostActivationWatch | undefined;
  const watchHostActivation = (): void => {
    if (hostActivationWatch !== undefined) return;
    hostActivationWatch = startHostActivationWatch(activeRoot, () => {
      output.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }) + "\n");
    });
  };
  rl.on("close", () => {
    hostActivationWatch?.stop();
  });

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (Buffer.byteLength(trimmed, "utf8") > maxLineBytes) {
      // Ignored + warned, matching the (pre-existing, just below) convention
      // for a line this transport cannot otherwise process: invalid JSON is
      // also silently dropped rather than answered, since a request id
      // cannot be trusted from an input we refuse to parse.
      process.stderr.write(
        `[tl-mcp] stdio transport: dropped oversized request line (> ${maxLineBytes} bytes)\n`,
      );
      return;
    }
    let msg: unknown;
    try { msg = JSON.parse(trimmed); } catch { return; }
    if (!msg || typeof msg !== "object") return;

    const req = msg as RpcRequest;

    // OUT OF BAND: handled right here, as soon as the line is read, instead of
    // being queued — a cancel queued behind the call it names would reach the
    // handler only after that call had finished, which is no cancel at all.
    // It is a notification, so there is no response either way, and the
    // handler (which answers every `notifications/*` with nothing) is not
    // consulted.
    if (req.method === "notifications/cancelled") {
      cancel(req.params);
      return;
    }

    // The handshake is complete: from here the host can act on a changed tool
    // list. The notification itself still takes the normal queue below (the
    // handler answers it with nothing).
    if (req.method === "notifications/initialized") watchHostActivation();

    const entry = track(req);
    queueTail = queueTail.then(() => {
      // Cancelled while it waited its turn: never run, never answered.
      if (entry?.cancelled) return null;
      return entry === undefined
        ? handler(req)
        : runWithRequestSignal(entry.controller.signal, () => handler(req));
    }).then((res) => {
      // Cancelled while it ran: whatever the handler returned is dropped (MCP:
      // the receiver SHOULD NOT answer a cancelled request).
      if (res && !entry?.cancelled) output.write(JSON.stringify(res) + "\n");
    }).catch(() => {
      if (entry?.cancelled) return;
      const id = (req as RpcRequest).id ?? null;
      output.write(
        JSON.stringify(makeError(id, -32603, "Internal error")) + "\n",
      );
    }).finally(() => {
      // Answered or dropped: from here a cancel naming this id is ignored.
      untrack(entry);
    });
  });
}
