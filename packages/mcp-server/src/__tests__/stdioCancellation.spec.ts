// stdioCancellation.spec.ts — MCP `notifications/cancelled` over the legacy-era
// stdio transport (mcp/transport/legacyStdio.ts).
//
// THE RULES UNDER TEST (MCP 2025-06-18, "Cancellation"): a client may cancel a
// request it no longer wants with `notifications/cancelled {requestId, reason?}`.
// The receiver SHOULD stop processing it, SHOULD NOT answer it, and MAY ignore a
// cancel for a request that is unknown, already finished, or cannot be
// cancelled. `initialize` MUST NOT be cancelled.
//
// WHY THIS NEEDED ITS OWN TRANSPORT CODE. The transport serializes requests
// through a promise queue so that only one runs at a time. It used to put every
// line — a cancel notification included — through that same queue, so the
// cancel for an in-flight call was dispatched only after the call had returned:
// a cancelled edit still wrote (reproduced by an external evaluator with a
// paused edit handler). The transport now handles a cancel the moment its line
// is read.
//
// Method: in-process, with PassThrough input, an in-memory output and
// gate-controlled handlers, exactly like fallbackTransport.spec.ts — no server
// is spawned. The transport only logs a line to stderr when it honours a
// cancel, which is how these tests know a cancel line has been consumed (lines
// are read in order, so a later cancel's log line proves every earlier line was
// processed — the "ignored" cases below rely on that, with a sentinel request).
// The edit side — a cancelled edit never writes — is
// editCancellationCommitPoint.spec.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { runLegacyStdio, type RpcRequest, type RpcResponse } from "../server.js";
import { currentRequestSignal, RequestCancelledError } from "../util/requestCancellation.js";

const TEST_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function fakeOutput(): { stream: NodeJS.WritableStream; responses: RpcResponse[]; raw: string[] } {
  const responses: RpcResponse[] = [];
  const raw: string[] = [];
  let buf = "";
  const stream = {
    write(chunk: string): boolean {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        raw.push(line);
        responses.push(JSON.parse(line) as RpcResponse);
      }
      return true;
    },
  } as unknown as NodeJS.WritableStream;
  return { stream, responses, raw };
}

async function waitUntil(predicate: () => boolean, what: string, timeoutMs = 4000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`waitUntil: timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Settle time for "nothing more should happen" assertions. */
const quiet = (ms = 40): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Gate {
  readonly promise: Promise<void>;
  open(): void;
}

function gate(): Gate {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

type Handler = (req: RpcRequest) => Promise<RpcResponse | null>;

const ok = (req: RpcRequest): RpcResponse => ({ jsonrpc: "2.0", id: req.id ?? null, result: { ok: true } });

let stderrLines: string[];
let inputs: PassThrough[];

beforeEach(() => {
  stderrLines = [];
  inputs = [];
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    stderrLines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
});

afterEach(() => {
  for (const input of inputs) input.end();
  vi.restoreAllMocks();
});

interface Harness {
  responses: RpcResponse[];
  /** Every output line, as written. */
  raw: string[];
  send(obj: unknown): void;
  sendRaw(text: string): void;
  cancel(requestId: unknown, reason?: string): void;
  /** Resolves once the transport has logged that it honoured a cancel of `id`. */
  cancelHonoured(id: string | number): Promise<void>;
  cancelsHonoured(): number;
}

function start(handler: Handler): Harness {
  const input = new PassThrough();
  inputs.push(input);
  const { stream, responses, raw } = fakeOutput();
  runLegacyStdio(input, stream, handler);
  const noticeFor = (id: string | number): string => `request ${JSON.stringify(id)} cancelled by the client`;
  return {
    responses,
    raw,
    send: (obj) => { input.write(JSON.stringify(obj) + "\n"); },
    sendRaw: (text) => { input.write(text); },
    cancel: (requestId, reason) => {
      input.write(JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: reason === undefined ? { requestId } : { requestId, reason },
      }) + "\n");
    },
    cancelHonoured: (id) =>
      waitUntil(() => stderrLines.some((line) => line.includes(noticeFor(id))), `the transport to honour a cancel of ${JSON.stringify(id)}`),
    cancelsHonoured: () => stderrLines.filter((line) => line.includes("cancelled by the client")).length,
  };
}

const call = (id: string | number, method = "tools/list"): RpcRequest => ({ jsonrpc: "2.0", id, method });

// ---------------------------------------------------------------------------
// A queued request, cancelled before its turn
// ---------------------------------------------------------------------------

describe("notifications/cancelled — a request still waiting its turn", () => {
  it("never reaches the handler and is never answered; the others answer in order", async () => {
    const blocker = gate();
    const handled: Array<string | number | null | undefined> = [];
    const h = start(async (req) => {
      handled.push(req.id);
      if (req.id === 1) await blocker.promise;
      return ok(req);
    });

    h.send(call(1));
    h.send(call(2));
    h.send(call(3));
    await waitUntil(() => handled.includes(1), "request 1 to start");
    expect(handled).toEqual([1]); // 2 and 3 are queued behind it

    h.cancel(2);
    await h.cancelHonoured(2);
    blocker.open();

    await waitUntil(() => h.responses.length >= 2, "the two surviving answers");
    await quiet();
    expect(h.responses.map((r) => r.id)).toEqual([1, 3]);
    expect(handled).toEqual([1, 3]); // the handler never saw 2
  }, TEST_TIMEOUT_MS);

  it("is skipped even when its cancel arrives in the same chunk as the request itself", async () => {
    // One write, three lines: the request and its cancel are read in the same
    // tick, before the request's turn comes round (a handler never starts
    // inside the read loop), so the first request in the queue can be skipped.
    const handled: Array<string | number | null | undefined> = [];
    const h = start(async (req) => {
      handled.push(req.id);
      return ok(req);
    });

    h.sendRaw(
      JSON.stringify(call(1)) + "\n"
        + JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } }) + "\n"
        + JSON.stringify(call(2)) + "\n",
    );

    await waitUntil(() => h.responses.length >= 1, "request 2's answer");
    await quiet();
    expect(handled).toEqual([2]);
    expect(h.responses.map((r) => r.id)).toEqual([2]);
  }, TEST_TIMEOUT_MS);

  it("frees its id at once: a later request may reuse the cancelled id and runs normally", async () => {
    const blocker = gate();
    const handled: Array<string | number | null | undefined> = [];
    const h = start(async (req) => {
      handled.push(req.id);
      if (req.id === 1) await blocker.promise;
      return { jsonrpc: "2.0", id: req.id ?? null, result: { n: handled.length } };
    });

    h.send(call(1));
    h.send(call(2)); // cancelled below
    await waitUntil(() => handled.includes(1), "request 1 to start");
    h.cancel(2);
    await h.cancelHonoured(2);
    h.send(call(2)); // same id, a NEW request
    blocker.open();

    await waitUntil(() => h.responses.length >= 2, "request 1 and the reused 2");
    await quiet();
    expect(h.responses.map((r) => r.id)).toEqual([1, 2]);
    expect(handled).toEqual([1, 2]); // the cancelled one never ran; the reused one did, once
  }, TEST_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// An in-flight request, cancelled while it runs
// ---------------------------------------------------------------------------

describe("notifications/cancelled — a request in flight", () => {
  it("has its signal aborted, gets no response, and the next queued request still runs and answers", async () => {
    const blocker = gate();
    let signalOf1: AbortSignal | undefined;
    const h = start(async (req) => {
      if (req.id === 1) {
        signalOf1 = currentRequestSignal();
        await blocker.promise;
      }
      return ok(req); // request 1 returns a normal answer even though it was cancelled
    });

    h.send(call(1));
    h.send(call(2));
    await waitUntil(() => signalOf1 !== undefined, "request 1 to start");
    expect(signalOf1!.aborted).toBe(false);

    h.cancel(1, "the user pressed escape");
    await waitUntil(() => signalOf1!.aborted, "request 1's signal to abort");
    expect(signalOf1!.reason).toBeInstanceOf(RequestCancelledError);
    expect((signalOf1!.reason as Error).message).toContain("the user pressed escape");

    blocker.open();
    await waitUntil(() => h.responses.length >= 1, "request 2's answer");
    await quiet();
    expect(h.responses.map((r) => r.id)).toEqual([2]); // nothing for 1, then 2, in order
  }, TEST_TIMEOUT_MS);

  it("is cancelled while its handler is still running — not after the handler has returned", async () => {
    const blocker = gate();
    let signal: AbortSignal | undefined;
    let handlerReturned = false;
    const h = start(async (req) => {
      signal = currentRequestSignal();
      await blocker.promise;
      handlerReturned = true;
      return ok(req);
    });

    h.send(call(1));
    await waitUntil(() => signal !== undefined, "the handler to start");
    h.cancel(1);

    // The handler is parked on the gate and has not returned, yet the signal
    // is already aborted: the cancel was not queued behind the call it names.
    await waitUntil(() => signal!.aborted, "the signal to abort while the handler is parked");
    expect(handlerReturned).toBe(false);
    expect(h.responses).toEqual([]);

    blocker.open();
    await waitUntil(() => handlerReturned, "the handler to return");
    await quiet();
    expect(h.responses).toEqual([]); // and its late answer is dropped
  }, TEST_TIMEOUT_MS);

  it("gets no response whatever the handler does after the cancel — returns, throws, or answers null", async () => {
    const outcomes: Array<{ id: number; finish: () => Promise<RpcResponse | null> }> = [
      { id: 1, finish: async () => ({ jsonrpc: "2.0", id: 1, result: { late: true } }) },
      { id: 2, finish: async () => { throw new Error("handler failed after the cancel"); } },
      { id: 3, finish: async () => null },
    ];
    const gates = new Map<number, Gate>(outcomes.map((o) => [o.id, gate()]));
    const started = new Set<number>();
    const h = start(async (req) => {
      const id = Number(req.id);
      started.add(id);
      await gates.get(id)?.promise;
      const outcome = outcomes.find((o) => o.id === id);
      return outcome === undefined ? ok(req) : outcome.finish();
    });

    for (const o of outcomes) h.send(call(o.id));
    for (const o of outcomes) {
      await waitUntil(() => started.has(o.id), `request ${o.id} to start`);
      h.cancel(o.id);
      await h.cancelHonoured(o.id);
      gates.get(o.id)!.open();
    }
    h.send(call(99));

    await waitUntil(() => h.responses.length >= 1, "the closing request's answer");
    await quiet();
    // In particular no -32603 for request 2: a thrown handler is not an error
    // the client is waiting to hear about once it has cancelled.
    expect(h.responses.map((r) => r.id)).toEqual([99]);
  }, TEST_TIMEOUT_MS);

  it("binds each request to its own signal: cancelling one never aborts another's", async () => {
    const gates = new Map<number, Gate>([[1, gate()], [2, gate()]]);
    const signals = new Map<number, AbortSignal | undefined>();
    const h = start(async (req) => {
      const id = Number(req.id);
      signals.set(id, currentRequestSignal());
      await gates.get(id)?.promise;
      return ok(req);
    });

    h.send(call(1));
    h.send(call(2));
    await waitUntil(() => signals.has(1), "request 1 to start");
    h.cancel(2); // 2 is still queued; 1 is the running one
    await h.cancelHonoured(2);
    expect(signals.get(1)!.aborted).toBe(false);

    gates.get(1)!.open();
    await waitUntil(() => h.responses.length >= 1, "request 1's answer");
    await quiet();
    expect(h.responses.map((r) => r.id)).toEqual([1]);
    expect(signals.has(2)).toBe(false); // never ran
    expect(signals.get(1)!.aborted).toBe(false);
  }, TEST_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// Cancels the transport must ignore
// ---------------------------------------------------------------------------

/**
 * Runs request 1 (method `firstMethod`, parked on a gate) and a queued
 * sentinel request, sends the cancel lines under test, then cancels the
 * sentinel — whose log line proves every earlier line was consumed — and
 * finally lets request 1 finish.
 */
async function ignoredCancels(
  firstMethod: string,
  send: (h: Harness) => void,
): Promise<{ responses: RpcResponse[]; honoured: number; signalOf1: AbortSignal | undefined }> {
  const blocker = gate();
  let started = false;
  let signalOf1: AbortSignal | undefined;
  const h = start(async (req) => {
    if (req.id === 1) {
      started = true;
      signalOf1 = currentRequestSignal();
      await blocker.promise;
    }
    return ok(req);
  });
  h.send(call(1, firstMethod));
  h.send(call("sentinel"));
  await waitUntil(() => started, "request 1 to start");
  send(h);
  h.cancel("sentinel");
  await h.cancelHonoured("sentinel");
  blocker.open();
  await waitUntil(() => h.responses.length >= 1, "request 1's answer");
  await quiet();
  return { responses: h.responses, honoured: h.cancelsHonoured(), signalOf1 };
}

describe("notifications/cancelled — what the transport ignores", () => {
  it("never cancels initialize: the cancel is ignored and initialize still answers", async () => {
    const result = await ignoredCancels("initialize", (h) => h.cancel(1, "changed my mind"));
    // Request 1 is `initialize`: not cancellable, so it is answered...
    expect(result.responses.map((r) => r.id)).toEqual([1]);
    // ...its handler was never given an abort to observe...
    expect(result.signalOf1?.aborted ?? false).toBe(false);
    // ...and the only cancel the transport honoured was the sentinel's.
    expect(result.honoured).toBe(1);
  }, TEST_TIMEOUT_MS);

  it("ignores a cancel for an id it does not know, and every malformed cancel", async () => {
    const result = await ignoredCancels("tools/list", (h) => {
      h.cancel(999); // unknown id
      h.cancel("never-seen"); // unknown string id
      h.cancel("1"); // the STRING "1" is not the number 1: ids match strictly
      h.cancel(1.5); // unknown number
      h.cancel(null);
      h.cancel(true);
      h.cancel({ nested: 1 });
      h.cancel([1]);
      h.cancel(undefined); // params without a requestId
      h.sendRaw(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled" }) + "\n"); // no params
      h.sendRaw(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: null }) + "\n");
      h.sendRaw(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: "1" }) + "\n");
      h.sendRaw(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: 1 }) + "\n");
      h.sendRaw(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: [] }) + "\n");
      h.sendRaw(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { reason: "no id" } }) + "\n");
    });
    expect(result.responses.map((r) => r.id)).toEqual([1]); // request 1 was untouched
    expect(result.signalOf1!.aborted).toBe(false);
    expect(result.honoured).toBe(1); // only the sentinel's
  }, TEST_TIMEOUT_MS);

  it("treats a cancel that arrives after the response was written as a no-op, and the id stays usable", async () => {
    const handled: Array<string | number | null | undefined> = [];
    const h = start(async (req) => {
      handled.push(req.id);
      return ok(req);
    });

    h.send(call(1));
    await waitUntil(() => h.responses.length >= 1, "request 1's answer");
    h.cancel(1, "too late"); // already answered
    h.send(call(2));
    h.send(call(1)); // the same id again, after its response — a fresh request
    await waitUntil(() => h.responses.length >= 3, "answers 2 and the second 1");
    await quiet();

    expect(h.responses.map((r) => r.id)).toEqual([1, 2, 1]);
    expect(handled).toEqual([1, 2, 1]);
    expect(h.cancelsHonoured()).toBe(0); // nothing was live to cancel
  }, TEST_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// The cancel notification itself, and unchanged behaviour around it
// ---------------------------------------------------------------------------

describe("notifications/cancelled — the notification itself", () => {
  it("is neither queued, nor handed to the handler, nor answered", async () => {
    const blocker = gate();
    const methods: string[] = [];
    const h = start(async (req) => {
      methods.push(req.method);
      if (req.id === 1) await blocker.promise;
      return ok(req);
    });

    h.send(call(1));
    await waitUntil(() => methods.length === 1, "request 1 to start");
    h.cancel(1);
    await h.cancelHonoured(1);
    blocker.open();
    h.send(call(2));
    await waitUntil(() => h.responses.length >= 1, "request 2's answer");
    await quiet();

    expect(methods).toEqual(["tools/list", "tools/list"]); // no `notifications/cancelled`
    expect(h.raw).toHaveLength(1); // one line out: request 2's answer; nothing for the cancel, nothing for 1
  }, TEST_TIMEOUT_MS);

  it("leaves requests that were never cancelled exactly as they were — answers, order and bytes", async () => {
    const h = start(async (req) => ({ jsonrpc: "2.0", id: req.id ?? null, result: { echoed: req.method, id: req.id } }));

    h.send(call(1));
    h.send(call("two", "tools/call"));
    h.send(call(3, "ping"));
    await waitUntil(() => h.responses.length >= 3, "three answers");

    expect(h.raw).toEqual([
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { echoed: "tools/list", id: 1 } }),
      JSON.stringify({ jsonrpc: "2.0", id: "two", result: { echoed: "tools/call", id: "two" } }),
      JSON.stringify({ jsonrpc: "2.0", id: 3, result: { echoed: "ping", id: 3 } }),
    ]);
  }, TEST_TIMEOUT_MS);
});
