// B6: the socket contract, with a fake model source. No VS Code host is involved, so
// this says nothing about any real provider's counts.

import { afterEach, describe, expect, it } from "vitest";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { createHostCounterServer, type HostCounterSource } from "../hostCounterServer.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function start(source: HostCounterSource): Promise<{ send(line: unknown): void; lines: Array<Record<string, unknown>>; closed: () => boolean; next(): Promise<Record<string, unknown>> }> {
  const socketPath = process.platform === "win32"
    ? `\\\\.\\pipe\\tl-host-server-test-${process.pid}-${Math.random().toString(36).slice(2)}`
    : path.join(os.tmpdir(), `tl-host-server-${process.pid}-${Math.random().toString(36).slice(2)}.sock`);
  const server = createHostCounterServer("secret", source);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const client = net.createConnection(socketPath);
  client.setEncoding("utf8");
  await new Promise<void>((resolve) => client.once("connect", resolve));
  const lines: Array<Record<string, unknown>> = [];
  let closed = false;
  const waiting: Array<(line: Record<string, unknown>) => void> = [];
  let buffered = "";
  client.on("close", () => { closed = true; });
  client.on("error", () => {});
  client.on("data", (chunk: string) => {
    buffered += chunk;
    for (let end = buffered.indexOf("\n"); end >= 0; end = buffered.indexOf("\n")) {
      const line = JSON.parse(buffered.slice(0, end)) as Record<string, unknown>;
      buffered = buffered.slice(end + 1);
      lines.push(line);
      waiting.shift()?.(line);
    }
  });
  cleanups.push(() => { client.destroy(); server.close(); });
  return {
    send: (line) => client.write(`${JSON.stringify(line)}\n`),
    lines,
    closed: () => closed,
    next: () => new Promise((resolve) => waiting.push(resolve)),
  };
}

async function eventually(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !check(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(check()).toBe(true);
}

describe("createHostCounterServer", () => {
  it("names the model after authenticating, then counts", async () => {
    const peer = await start({ modelId: () => "gpt-x", count: async (text) => text.length });
    const hello = peer.next();
    peer.send({ op: "hello", token: "secret" });
    expect(await hello).toEqual({ model: "gpt-x", method: "unknown" });
    const answer = peer.next();
    peer.send({ op: "count", id: 7, text: "hello" });
    expect(await answer).toEqual({ id: 7, count: 5, model: "gpt-x", method: "unknown" });
  });

  it.each([
    ["a wrong token", { op: "hello", token: "nope" }],
    ["a request before authenticating", { op: "count", id: 1, text: "x" }],
  ])("closes on %s, and counts nothing", async (_name, first) => {
    let counted = 0;
    const peer = await start({ modelId: () => "m", count: async () => { counted += 1; return 1; } });
    peer.send(first);
    await eventually(peer.closed);
    expect(counted).toBe(0);
    expect(peer.lines).toEqual([]);
  });

  it("reports the model each count came from, so a switch is visible", async () => {
    let id = "a";
    const peer = await start({ modelId: () => id, count: async () => { id = "b"; return 1; } });
    const hello = peer.next();
    peer.send({ op: "hello", token: "secret" });
    await hello;
    const answer = peer.next();
    peer.send({ op: "count", id: 1, text: "x" });
    expect((await answer)["model"]).toBe("b");
  });

  it("refuses when no model is available or the count fails, and stays connected", async () => {
    let model: string | undefined;
    const peer = await start({ modelId: () => model, count: async () => { throw new Error("provider"); } });
    peer.send({ op: "hello", token: "secret" });
    const none = peer.next();
    peer.send({ op: "count", id: 1, text: "x" });
    expect(await none).toEqual({ id: 1, error: "no-model" });
    model = "a";
    const failed = peer.next();
    peer.send({ op: "count", id: 2, text: "x" });
    expect(await failed).toEqual({ id: 2, error: "count-failed" });
    expect(peer.closed()).toBe(false);
  });
});
