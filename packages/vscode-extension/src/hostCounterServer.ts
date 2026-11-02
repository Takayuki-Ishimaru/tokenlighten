// B6: the extension's half of the host token counter socket, free of the `vscode`
// module so its contract can be tested without a host. The MCP server has no VS Code
// API, so it asks here (packages/mcp-server/src/protocol/codec/hostCounterSocket.ts).
//
// A connection must present the token before anything else, and every message
// names the model the count came from, so a model switch reaches the server's next
// identity check. `method` stays "unknown": VS Code's API does not say whether a
// provider's count is exact or estimated.

import * as net from "node:net";

const MAX_LINE_CHARS = 1024 * 1024;

export interface HostCounterSource {
  /** The model currently answering, or undefined when none is available. */
  modelId(): string | undefined;
  count(text: string): Promise<number>;
}

export function createHostCounterServer(token: string, source: HostCounterSource): net.Server {
  return net.createServer((socket) => {
    socket.setEncoding("utf8");
    socket.on("error", () => socket.destroy());
    let authenticated = false;
    let buffered = "";
    const send = (message: Record<string, unknown>): void => {
      if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
    };
    const handle = (line: string): void => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        socket.destroy();
        return;
      }
      if (!authenticated) {
        if (message["op"] !== "hello" || message["token"] !== token) {
          socket.destroy();
          return;
        }
        authenticated = true;
        const model = source.modelId();
        if (model !== undefined) send({ model, method: "unknown" });
        return;
      }
      if (message["op"] !== "count" || typeof message["id"] !== "number" || typeof message["text"] !== "string") return;
      const id = message["id"];
      const model = source.modelId();
      if (model === undefined) {
        send({ id, error: "no-model" });
        return;
      }
      source.count(message["text"]).then(
        (count) => send({ id, count, model: source.modelId() ?? model, method: "unknown" }),
        () => send({ id, error: "count-failed" }),
      );
    };
    socket.on("data", (chunk: string) => {
      buffered += chunk;
      if (buffered.length > MAX_LINE_CHARS) {
        socket.destroy();
        return;
      }
      for (let end = buffered.indexOf("\n"); end >= 0; end = buffered.indexOf("\n")) {
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 1);
        handle(line);
      }
    });
  });
}
