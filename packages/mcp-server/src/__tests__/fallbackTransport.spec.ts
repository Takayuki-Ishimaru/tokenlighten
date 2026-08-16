// Regression tests for the hand-rolled stdio JSON-RPC fallback transport.
//
// TL-SECURITY-REVIEW-2026-08-15 finding 7 (CWE-400): runStdioFallback()
// (used only when the MCP SDK's stdio transport is unavailable — see
// tryRunWithSdk() in server.ts) used to buffer+JSON.parse any readline
// "line" of unbounded size and fire every handleRequest() concurrently
// with zero backpressure. `input`/`output`/`handler`/`maxLineBytes` are
// TEST-ONLY injection points added specifically so these tests can drive
// the transport with in-memory streams and a controllable-latency handler
// — there is no supported way to force the real SDK transport unavailable
// from outside the process, so a real-subprocess spawn (this suite's usual
// convention for transport-level coverage) cannot exercise this path.

import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import { runStdioFallback, type RpcRequest, type RpcResponse } from "../server.js";

function fakeOutput(): { stream: NodeJS.WritableStream; responses: RpcResponse[] } {
  const responses: RpcResponse[] = [];
  let buf = "";
  const stream = {
    write(chunk: string): boolean {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) responses.push(JSON.parse(line) as RpcResponse);
      }
      return true;
    },
  } as unknown as NodeJS.WritableStream;
  return { stream, responses };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("waitUntil: timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function sendLine(input: PassThrough, obj: unknown): void {
  input.write(JSON.stringify(obj) + "\n");
}

describe("runStdioFallback — resource bounds (finding 7)", () => {
  it("drops an oversized request line without dispatching it to the handler or answering it", async () => {
    const input = new PassThrough();
    const { stream: output, responses } = fakeOutput();
    let handlerCalls = 0;
    const handler = async (req: RpcRequest): Promise<RpcResponse> => {
      handlerCalls++;
      return { jsonrpc: "2.0", id: req.id ?? null, result: { ok: true } };
    };
    // A tiny maxLineBytes override (instead of the real 16 MB constant)
    // means the "oversized" line here can be well under 1 KB — no
    // multi-megabyte fixture needed to exercise the real boundary check.
    runStdioFallback(input, output, handler, 50);

    sendLine(input, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: { padding: "A".repeat(100) }, // pushes this line well over 50 bytes
    });
    sendLine(input, { jsonrpc: "2.0", id: 2, method: "tools/list" }); // ~46 bytes, under the cap

    await waitUntil(() => responses.length >= 1);
    // Only request 2 (the short one) ever reaches the handler or gets a
    // response — request 1 was dropped before JSON.parse, let alone dispatch.
    expect(responses).toHaveLength(1);
    expect(responses[0]!.id).toBe(2);
    expect(handlerCalls).toBe(1);
    input.end();
  });

  it("serializes in-flight requests — a slow request's response lands before a faster one queued right after it", async () => {
    const input = new PassThrough();
    const { stream: output, responses } = fakeOutput();
    const order: number[] = [];
    const handler = async (req: RpcRequest): Promise<RpcResponse> => {
      const id = Number(req.id);
      const delayMs = id === 1 ? 40 : 0; // request 1 is deliberately the slow one
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      order.push(id);
      return { jsonrpc: "2.0", id, result: { ok: true } };
    };
    runStdioFallback(input, output, handler);

    // Both lines arrive back-to-back, well before request 1's handler
    // resolves — an unbounded-concurrency implementation would let request
    // 2 (0ms) finish and respond FIRST, out of arrival order.
    sendLine(input, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    sendLine(input, { jsonrpc: "2.0", id: 2, method: "tools/list" });

    await waitUntil(() => responses.length >= 2);
    expect(order).toEqual([1, 2]);
    expect(responses.map((r) => r.id)).toEqual([1, 2]);
    input.end();
  });

  it("ordinary traffic (no oversized lines, one request at a time) behaves exactly as before", async () => {
    const input = new PassThrough();
    const { stream: output, responses } = fakeOutput();
    const handler = async (req: RpcRequest): Promise<RpcResponse> => ({
      jsonrpc: "2.0",
      id: req.id ?? null,
      result: { echoed: req.method },
    });
    runStdioFallback(input, output, handler);

    sendLine(input, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    await waitUntil(() => responses.length >= 1);
    expect(responses[0]).toEqual({ jsonrpc: "2.0", id: 1, result: { echoed: "tools/list" } });
    input.end();
  });
});
