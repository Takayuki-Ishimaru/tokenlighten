// Hand-rolled stdio JSON-RPC 2.0 transport (the legacy-era fallback leg).
//
// v0.10 alpha.1 / PI-09 implementation item 1
// (DESIGN-v0.10-expansion-plan-reconciliation.md §4 alpha.1 item 4): moved
// VERBATIM out of server.ts's transport tail so a second (modern 2026-07-28)
// era entry can sit beside it. This is a pure relocation — the legacy leg
// must stay byte-identical on the wire (70+ fixtures pin it), so nothing here
// changed with the move except the imports.
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

// SECURITY (TL-SECURITY-REVIEW-2026-08-15 finding 7, CWE-400): this legacy
// path only runs when the SDK transport (tryRunWithSdk, legacyStdio.ts) is
// unavailable — it used to buffer+JSON.parse any readline "line" of any
// size and fire every handleRequest() concurrently with zero backpressure.
// 16 MB matches this server's existing 16 MB-class per-unit ceiling family
// (office/zipPreflight.ts ZIP_LIMITS.maxPartUncompressedBytes, tools/archive
// .ts ARCHIVE_LIMITS.maxMemberBytes/maxScanBytes) — comfortably above any
// legitimate single JSON-RPC request this server accepts (a create:true
// file body alone is capped at 32 KiB per AGENTS.md; a large batched
// edits[] call stays orders of magnitude under this), while still being a
// hard, known ceiling rather than "whatever fits in memory".
const MAX_FALLBACK_LINE_BYTES = 16 * 1024 * 1024;

/**
 * `input`/`output`/`handler` are TEST-ONLY injection points (mirrors this
 * codebase's established quota-override-seam convention — see office/pdf.ts's
 * PdfExtractionQuotaOverrides) so a regression test can drive this transport
 * with in-memory streams and a controllable-latency handler instead of real
 * stdio and the full tool dispatch. Production always calls this with zero
 * arguments (see runTransport(), index.ts), so the defaults are the only path
 * that ever executes outside tests.
 */
export function runStdioFallback(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
  handler: (req: RpcRequest) => Promise<RpcResponse | null> = handleRequest,
  maxLineBytes: number = MAX_FALLBACK_LINE_BYTES,
): void {
  process.stderr.write(`[tl-mcp] stdio transport (hand-rolled JSON-RPC 2.0)\n`);
  process.stderr.write(`[tl-mcp] workspace root: ${activeRoot}\n`);

  const rl = readline.createInterface({ input });
  // In-flight requests are fully serialized (a queued line always gets its
  // turn, in order) rather than firing unboundedly — this fallback is a
  // degraded/legacy path, not the primary SDK transport, so trading away
  // concurrency for a hard resource bound is the right tradeoff here.
  let queueTail: Promise<void> = Promise.resolve();
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (Buffer.byteLength(trimmed, "utf8") > maxLineBytes) {
      // Ignored + warned, matching the (pre-existing, just below) convention
      // for a line this transport cannot otherwise process: invalid JSON is
      // also silently dropped rather than answered, since a request id
      // cannot be trusted from an input we refuse to parse.
      process.stderr.write(
        `[tl-mcp] fallback transport: dropped oversized request line (> ${maxLineBytes} bytes)\n`,
      );
      return;
    }
    let msg: unknown;
    try { msg = JSON.parse(trimmed); } catch { return; }
    if (!msg || typeof msg !== "object") return;

    const req = msg as RpcRequest;
    queueTail = queueTail.then(() => handler(req)).then((res) => {
      if (res) output.write(JSON.stringify(res) + "\n");
    }).catch(() => {
      const id = (req as RpcRequest).id ?? null;
      output.write(
        JSON.stringify(makeError(id, -32603, "Internal error")) + "\n",
      );
    });
  });
}
