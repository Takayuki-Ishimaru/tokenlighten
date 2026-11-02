// ---------------------------------------------------------------------------
// protocol v1 -- B6: the client half of the host counter bridge.
//
// An MCP server has no access to VS Code's API, so the extension owns the host's
// `countTokens` and this process reaches it over a local socket the extension named
// in TL_WIRE_HOST_COUNTER (JSON lines, authenticated by TL_WIRE_HOST_COUNTER_TOKEN).
// The socket carries reply text to the host's counting API for that model. What that
// API does with it is the host's: this is opt-in for that reason, and what comes back
// is recorded as `unknown` certainty unless the host says otherwise.
//
// Any socket problem makes the bridge absent: the caller falls back, and the next
// call may try again after a pause, so a dead extension costs one connect attempt
// per interval rather than one per reply.
// ---------------------------------------------------------------------------

import * as net from "node:net";

import type { HostCounterBridge } from "./hostTokenCounter.js";

const CONNECT_RETRY_MS = 30_000;
const MAX_LINE_CHARS = 1024 * 1024;

export interface HostCounterConnection {
  bridge(): HostCounterBridge | undefined;
  close(): void;
}

interface Pending {
  resolve(count: number): void;
  reject(error: Error): void;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function methodOf(value: unknown): HostCounterBridge["method"] {
  return value === "host-exact" || value === "host-estimate" ? value : "unknown";
}

/** One connection attempt at a time; `bridge()` is undefined until the host has identified its model. */
export function connectHostCounter(socketPath: string, token: string, now: () => number = Date.now): HostCounterConnection {
  let socket: net.Socket | undefined;
  let identity: { id: string; method: HostCounterBridge["method"] } | undefined;
  let nextAttemptAt = 0;
  let nextId = 1;
  let buffered = "";
  const pending = new Map<number, Pending>();

  const drop = (): void => {
    socket?.destroy();
    socket = undefined;
    identity = undefined;
    buffered = "";
    nextAttemptAt = now() + CONNECT_RETRY_MS;
    for (const waiting of pending.values()) waiting.reject(new Error("host counter disconnected"));
    pending.clear();
  };

  const onLine = (line: string): void => {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      drop();
      return;
    }
    // Every message may carry the model: a switch must reach the next `bridge()`
    // call, which is what lets precountForHost discard counts from the old one.
    const model = str(message["model"]);
    if (model !== undefined) identity = { id: `vscode/${model}`, method: methodOf(message["method"]) };
    const id = message["id"];
    if (typeof id !== "number") return;
    const waiting = pending.get(id);
    if (waiting === undefined) return;
    pending.delete(id);
    if (typeof message["count"] === "number") waiting.resolve(message["count"]);
    else waiting.reject(new Error("host counter refused"));
  };

  const open = (): void => {
    if (socket !== undefined || now() < nextAttemptAt) return;
    const created = net.createConnection(socketPath);
    socket = created;
    created.setEncoding("utf8");
    // The server must not keep this process alive for a diagnostic-grade helper.
    created.unref();
    created.on("connect", () => created.write(`${JSON.stringify({ op: "hello", token })}\n`));
    created.on("data", (chunk: string) => {
      buffered += chunk;
      if (buffered.length > MAX_LINE_CHARS) {
        drop();
        return;
      }
      for (let end = buffered.indexOf("\n"); end >= 0; end = buffered.indexOf("\n")) {
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 1);
        onLine(line);
      }
    });
    created.on("error", drop);
    created.on("close", drop);
  };

  return {
    bridge(): HostCounterBridge | undefined {
      open();
      if (identity === undefined || socket === undefined) return undefined;
      const { id, method } = identity;
      return {
        id,
        method,
        countTokens(text: string, signal: AbortSignal): Promise<number> {
          return new Promise<number>((resolve, reject) => {
            if (socket === undefined) {
              reject(new Error("host counter disconnected"));
              return;
            }
            const requestId = nextId;
            nextId += 1;
            pending.set(requestId, { resolve, reject });
            signal.addEventListener("abort", () => {
              // The host may still be counting; the answer finds no waiter and is ignored.
              if (pending.delete(requestId)) reject(new Error("aborted"));
            }, { once: true });
            socket.write(`${JSON.stringify({ op: "count", id: requestId, text })}\n`);
          });
        },
      };
    },
    close: drop,
  };
}
