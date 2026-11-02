// ---------------------------------------------------------------------------
// B6 -- selection through a host's counts, and the socket client. Fake hosts only:
// this proves the adapter's contract and not any real host's counts.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { applyHostCountedCodec, hostCounterActive, resetHostCounterForTest } from "../protocol/codec/hostSelect.js";
import { connectHostCounter } from "../protocol/codec/hostCounterSocket.js";
import { applyResponseCodec, resetV2CacheForTest } from "../protocol/codec/pipeline.js";
import { evaluateCandidates } from "../protocol/codec/policy.js";
import type { HostCounterBridge } from "../protocol/codec/hostTokenCounter.js";
import type { ProtocolCallContext } from "../protocol/envelope.js";

const KEYS = ["TL_WIRE_HOST_COUNTER", "TL_WIRE_HOST_COUNTER_TOKEN", "TL_WIRE_TOKEN_SELECT", "TOKENLIGHTEN_RESPONSE_FORMAT", "TL_WIRE_BREAKEVEN", "TL_WIRE_TOKENIZER"] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const key of KEYS) { saved[key] = process.env[key]; delete process.env[key]; }
  resetV2CacheForTest();
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetHostCounterForTest();
});

beforeEach(() => {
  resetHostCounterForTest();
});

const rows = Array.from({ length: 30 }, (_, i) => ({ path: `src/module${i}/file${i}.ts`, line: i + 1, symbol: `handler${i}` }));
const PAYLOAD = { v: 1, kind: "search.matches", matches: { form: "symbols", locations: rows, total: 30 } };
const JSON_TEXT = JSON.stringify(PAYLOAD);

function fake(count: (text: string) => number, id = "vscode/model-a"): () => HostCounterBridge {
  return () => ({ id, method: "unknown", countTokens: async (text) => count(text) });
}

describe("applyHostCountedCodec", () => {
  it("chooses the spelling with the fewest host tokens, at no more bytes", async () => {
    const out = await applyHostCountedCodec(JSON_TEXT, undefined, undefined, { getBridge: fake((text) => text.length) });
    const smallest = evaluateCandidates("search.matches", PAYLOAD).filter((c) => c.bytes < Buffer.byteLength(JSON_TEXT))[0]!;
    expect(out.length).toBeLessThanOrEqual(smallest.text.length);
    expect(out).not.toBe(JSON_TEXT);
  });

  it("honours a host whose counts reverse the byte order", async () => {
    // Fewer bytes costs more here: no candidate beats json, so json stays.
    const out = await applyHostCountedCodec(JSON_TEXT, undefined, undefined, { getBridge: fake((text) => 200_000 - text.length) });
    expect(out).toBe(JSON_TEXT);
  });

  it.each([
    ["a bridge that rejects", () => ({ id: "x", method: "unknown" as const, countTokens: async () => { throw new Error("offline"); } })],
    ["no bridge", () => undefined],
    ["a getter that throws", () => { throw new Error("gone"); }],
    ["an invalid count", () => ({ id: "x", method: "unknown" as const, countTokens: async () => Number.NaN })],
  ])("%s keeps the selection the server makes without a host", async (_name, getBridge) => {
    const out = await applyHostCountedCodec(JSON_TEXT, undefined, undefined, { getBridge });
    const inBytes = await applyHostCountedCodec(JSON_TEXT, undefined, undefined, { getBridge: fake((text) => Buffer.byteLength(text)) });
    expect(out).toBe(inBytes);
    expect(out).not.toBe(JSON_TEXT);
  });

  it("a stuck host costs one timeout, then is not asked again for a while", async () => {
    const countTokens = vi.fn(() => new Promise<number>(() => {}));
    const getBridge = (): HostCounterBridge => ({ id: "x", method: "unknown", countTokens });
    const started = Date.now();
    const first = await applyHostCountedCodec(JSON_TEXT, undefined, undefined, { getBridge, timeoutMs: 30 });
    expect(first).not.toBe(JSON_TEXT);
    expect(Date.now() - started).toBeLessThan(2_000);
    const asked = countTokens.mock.calls.length;
    const second = await applyHostCountedCodec(JSON_TEXT, undefined, undefined, { getBridge, timeoutMs: 30 });
    expect(second).toBe(first);
    expect(countTokens.mock.calls.length).toBe(asked);
  });

  it("leaves hard-JSON kinds, non-JSON text and the raw profile gate alone", async () => {
    const pack = JSON.stringify({ v: 1, kind: "read.task_pack", items: rows });
    expect(await applyHostCountedCodec(pack, undefined, undefined, { getBridge: fake((t) => t.length) })).toBe(pack);
    expect(await applyHostCountedCodec("TL1T already encoded", undefined, undefined, { getBridge: fake((t) => t.length) })).toBe("TL1T already encoded");
    const body = Array.from({ length: 40 }, (_, i) => `const x${i} = "v\\p\\${i}"; // "quoted"`).join("\n");
    const text = JSON.stringify({ v: 1, kind: "read.text", text: body, path: "a.ts" });
    expect(await applyHostCountedCodec(text, undefined, undefined, { getBridge: fake((t) => t.length) })).toBe(text);
  });

  it("is off unless every part of its gate is set, and the funnel defers only then", () => {
    expect(hostCounterActive()).toBe(false);
    process.env["TL_WIRE_HOST_COUNTER"] = "/tmp/x";
    expect(hostCounterActive()).toBe(false);
    process.env["TL_WIRE_TOKEN_SELECT"] = "1";
    process.env["TOKENLIGHTEN_RESPONSE_FORMAT"] = "auto";
    process.env["TL_WIRE_BREAKEVEN"] = "1";
    expect(hostCounterActive()).toBe(true);

    const context: ProtocolCallContext = { tool: "tl_search_files" };
    expect(applyResponseCodec(JSON_TEXT, PAYLOAD, "search.matches", context, 999_999)).toBe(JSON_TEXT);
    delete process.env["TL_WIRE_HOST_COUNTER"];
    expect(applyResponseCodec(JSON_TEXT, PAYLOAD, "search.matches", context, 999_999)).not.toBe(JSON_TEXT);
  });
});

/** A minimal extension-side peer: the wire protocol, with no VS Code in it. */
async function fakeHost(answer: (line: Record<string, unknown>, write: (message: Record<string, unknown>) => void) => void): Promise<{ path: string; close(): void; lines: Array<Record<string, unknown>> }> {
  const socketPath = process.platform === "win32"
    ? `\\\\.\\pipe\\tl-host-counter-test-${process.pid}-${Math.random().toString(36).slice(2)}`
    : path.join(os.tmpdir(), `tl-host-counter-${process.pid}-${Math.random().toString(36).slice(2)}.sock`);
  const lines: Array<Record<string, unknown>> = [];
  const sockets: net.Socket[] = [];
  const server = net.createServer((socket) => {
    sockets.push(socket);
    socket.setEncoding("utf8");
    let buffered = "";
    socket.on("error", () => {});
    socket.on("data", (chunk: string) => {
      buffered += chunk;
      for (let end = buffered.indexOf("\n"); end >= 0; end = buffered.indexOf("\n")) {
        const line = JSON.parse(buffered.slice(0, end)) as Record<string, unknown>;
        buffered = buffered.slice(end + 1);
        lines.push(line);
        answer(line, (message) => socket.write(`${JSON.stringify(message)}\n`));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return { path: socketPath, lines, close() { for (const socket of sockets) socket.destroy(); server.close(); } };
}

async function until<T>(read: () => T | undefined): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out");
}

describe("connectHostCounter", () => {
  it("authenticates, learns the model, and counts over the socket", async () => {
    const host = await fakeHost((line, write) => {
      if (line["op"] === "hello") write({ model: "copilot-gpt-x", method: "host-estimate" });
      if (line["op"] === "count") write({ id: line["id"], count: String(line["text"]).length, model: "copilot-gpt-x", method: "host-estimate" });
    });
    const link = connectHostCounter(host.path, "secret");
    try {
      const bridge = await until(() => link.bridge());
      expect(bridge.id).toBe("vscode/copilot-gpt-x");
      expect(bridge.method).toBe("host-estimate");
      expect(await bridge.countTokens("hello", new AbortController().signal)).toBe(5);
      expect(host.lines[0]).toEqual({ op: "hello", token: "secret" });
    } finally {
      link.close();
      host.close();
    }
  });

  it("a model named on any message becomes the next identity, so older counts can be discarded", async () => {
    const host = await fakeHost((line, write) => {
      if (line["op"] === "hello") write({ model: "a" });
      if (line["op"] === "count") write({ id: line["id"], count: 1, model: "b" });
    });
    const link = connectHostCounter(host.path, "t");
    try {
      const first = await until(() => link.bridge());
      expect(first.id).toBe("vscode/a");
      await first.countTokens("x", new AbortController().signal);
      expect(link.bridge()?.id).toBe("vscode/b");
    } finally {
      link.close();
      host.close();
    }
  });

  it("a refusal rejects, and a disconnect rejects what is waiting and backs off", async () => {
    let clock = 1_000;
    const host = await fakeHost((line, write) => {
      if (line["op"] === "hello") write({ model: "a" });
      if (line["op"] === "count" && line["text"] === "refuse") write({ id: line["id"], error: "no" });
    });
    const link = connectHostCounter(host.path, "t", () => clock);
    try {
      const bridge = await until(() => link.bridge());
      await expect(bridge.countTokens("refuse", new AbortController().signal)).rejects.toThrow(/refused/);
      const waiting = bridge.countTokens("never answered", new AbortController().signal);
      host.close();
      await expect(waiting).rejects.toThrow(/disconnected/);
      expect(link.bridge()).toBeUndefined();
      clock += 1_000;
      expect(link.bridge()).toBeUndefined();
    } finally {
      link.close();
    }
  });

  it("no such socket is simply no bridge", async () => {
    const link = connectHostCounter(path.join(os.tmpdir(), "tl-no-such-socket-at-all"), "t");
    expect(link.bridge()).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(link.bridge()).toBeUndefined();
    link.close();
  });
});
