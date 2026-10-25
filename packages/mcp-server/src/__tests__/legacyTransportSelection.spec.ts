// legacyTransportSelection.spec.ts — the legacy era starts the hand-rolled
// stdio transport DIRECTLY; there is no SDK leg to try first.
//
// HISTORY. runTransport() used to try an @modelcontextprotocol/sdk v1 `Server`
// leg first (legacyStdio.ts's `tryRunWithSdk`) and fall back to the hand-rolled
// JSON-RPC transport only if that threw. The SDK leg registered its handlers
// with plain objects where the SDK wants Zod request schemas, so it threw
// "Schema is missing a method literal" on every build, the catch reported the
// SDK as unavailable, and the "fallback" was in fact the production wire (70+
// fixtures pin its bytes). The leg is deleted; these tests pin the replacement:
//
//   A. in-process, with the transport modules mocked: runTransport("legacy")
//      starts the hand-rolled transport exactly once, never loads the SDK's
//      server modules, and never touches the modern leg; runTransport("modern")
//      is untouched, including its fail-open to the legacy transport. A source
//      scan keeps it that way: no production file imports the SDK v1 package;
//   B. against the real thing (a spawned `bin.ts` on the default era): the
//      stderr banner names the hand-rolled transport and never the SDK, the
//      handshake answers on the legacy wire, and a cancel notification for an
//      unknown request neither answers nor stalls the stream.

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { killServerGroup } from "./helpers/killServerGroup.js";

// ---------------------------------------------------------------------------
// A. runTransport, in process
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  runLegacyStdio: vi.fn(),
  tryRunWithModernSdk: vi.fn<() => Promise<boolean>>(),
  sdkServerLoaded: vi.fn(),
  sdkStdioLoaded: vi.fn(),
}));

vi.mock("../mcp/transport/legacyStdio.js", () => ({ runLegacyStdio: mocks.runLegacyStdio }));
vi.mock("../mcp/transport/modernStdio.js", () => ({ tryRunWithModernSdk: mocks.tryRunWithModernSdk }));
// If anything on the legacy path still tried the SDK, one of these factories would run.
vi.mock("@modelcontextprotocol/sdk/server/index.js", () => {
  mocks.sdkServerLoaded();
  return {};
});
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => {
  mocks.sdkStdioLoaded();
  return {};
});

import { runTransport } from "../mcp/transport/index.js";
import { TSX_NODE_ARGS } from "./helpers/tsxNode.js";

let stderrLines: string[];

beforeEach(() => {
  stderrLines = [];
  mocks.runLegacyStdio.mockReset();
  mocks.tryRunWithModernSdk.mockReset();
  mocks.sdkServerLoaded.mockReset();
  mocks.sdkStdioLoaded.mockReset();
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    stderrLines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runTransport — which transport each era starts", () => {
  it("legacy: starts the hand-rolled transport once, directly — no SDK module is loaded, the modern leg is not consulted", async () => {
    await expect(runTransport("legacy")).resolves.toBe("legacy");

    expect(mocks.runLegacyStdio).toHaveBeenCalledTimes(1);
    expect(mocks.runLegacyStdio).toHaveBeenCalledWith(); // production starts it with zero arguments
    expect(mocks.sdkServerLoaded).not.toHaveBeenCalled();
    expect(mocks.sdkStdioLoaded).not.toHaveBeenCalled();
    expect(mocks.tryRunWithModernSdk).not.toHaveBeenCalled();
    expect(stderrLines).toEqual([]); // starting the legacy era adds no fallback chatter of its own
  });

  it("modern: serves the modern leg and leaves the legacy transport alone", async () => {
    mocks.tryRunWithModernSdk.mockResolvedValue(true);

    await expect(runTransport("modern")).resolves.toBe("modern");

    expect(mocks.tryRunWithModernSdk).toHaveBeenCalledTimes(1);
    expect(mocks.runLegacyStdio).not.toHaveBeenCalled();
    expect(mocks.sdkServerLoaded).not.toHaveBeenCalled();
  });

  it("modern but unavailable: fails open to the hand-rolled transport, saying so on stderr", async () => {
    mocks.tryRunWithModernSdk.mockResolvedValue(false);

    await expect(runTransport("modern")).resolves.toBe("legacy");

    expect(mocks.tryRunWithModernSdk).toHaveBeenCalledTimes(1);
    expect(mocks.runLegacyStdio).toHaveBeenCalledTimes(1);
    expect(mocks.sdkServerLoaded).not.toHaveBeenCalled();
    expect(stderrLines.join("")).toContain("TOKENLIGHTEN_PROTOCOL_ERA=modern requested but unavailable; falling back to legacy transport");
  });
});

describe("the dead SDK v1 leg stays deleted", () => {
  it("no production source file imports @modelcontextprotocol/sdk (the modern leg uses the v2 server package)", () => {
    const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const importsSdk = /["']@modelcontextprotocol\/sdk(?:\/|["'])/;
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "__tests__") walk(abs);
        } else if (entry.name.endsWith(".ts")) {
          const code = fs.readFileSync(abs, "utf8")
            .split("\n")
            .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
            .join("\n");
          if (importsSdk.test(code)) offenders.push(path.relative(srcRoot, abs).split(path.sep).join("/"));
        }
      }
    };
    walk(srcRoot);
    expect(offenders).toEqual([]);
    expect(fs.existsSync(path.join(srcRoot, "mcp", "transport", "fallbackStdio.ts"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// B. The real server on the default era, spawned
// ---------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN_TS = path.resolve(HERE, "..", "bin.ts");
const SPAWN_TIMEOUT_MS = 90_000;

const tmpDirs: string[] = [];
const killers: Array<() => void> = [];

afterAll(() => {
  for (const kill of killers.splice(0)) kill();
  for (const dir of tmpDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
  }
});

interface Spawned {
  stderr(): string;
  /** Every stdout line, parsed. */
  messages: Array<Record<string, any>>;
  send(obj: unknown): void;
  rpc(id: number, method: string, params?: unknown): Promise<Record<string, any>>;
}

function spawnServer(workspace: string): Spawned {
  const child: ChildProcess = spawn(process.execPath, [...TSX_NODE_ARGS, BIN_TS, workspace], {
    cwd: workspace,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
    // The default era: nothing in the environment may select the modern one.
    env: { ...process.env, TOKENLIGHTEN_PROTOCOL_ERA: "" },
  });
  killers.push(() => { try { killServerGroup(child); } catch { /* ok */ } });

  let stderr = "";
  let stdoutBuf = "";
  const messages: Array<Record<string, any>> = [];
  const waiters = new Map<number, (msg: Record<string, any>) => void>();
  child.stdout!.on("data", (chunk: Buffer) => {
    stdoutBuf += chunk.toString();
    let nl: number;
    while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
      const line = stdoutBuf.slice(0, nl);
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg: Record<string, any>;
      try { msg = JSON.parse(line) as Record<string, any>; } catch { continue; }
      messages.push(msg);
      if (msg["id"] != null && waiters.has(msg["id"])) {
        const waiter = waiters.get(msg["id"])!;
        waiters.delete(msg["id"]);
        waiter(msg);
      }
    }
  });
  child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

  const send = (obj: unknown): void => { child.stdin!.write(JSON.stringify(obj) + "\n"); };
  const rpc = (id: number, method: string, params?: unknown): Promise<Record<string, any>> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(new Error(`rpc '${method}' timed out.\n--- server stderr ---\n${stderr}`));
      }, 60_000);
      waiters.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      send({ jsonrpc: "2.0", id, method, params });
    });
  return { stderr: () => stderr, messages, send, rpc };
}

describe("the real server on the default (legacy) era", () => {
  it("runs the hand-rolled transport (never an SDK one), answers on the legacy wire, and shrugs off an unknown cancel", async () => {
    const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tl-legacy-select-")));
    tmpDirs.push(ws);
    fs.writeFileSync(path.join(ws, "sample.ts"), "export const alpha = 1;\n", "utf8");
    const server = spawnServer(ws);

    const init = await server.rpc(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "vitest-legacy-selection", version: "0" },
    });
    expect(init["result"]?.["protocolVersion"]).toBe("2024-11-05");
    expect(init["result"]?.["serverInfo"]?.["name"]).toBe("@tokenlighten/mcp-server");
    expect(typeof init["result"]?.["instructions"]).toBe("string");

    // A cancel for a request that is not running: no answer (a notification has
    // none, and an unknown id is ignored) and the stream carries on.
    server.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    server.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 4242, reason: "nothing to cancel" } });
    const listed = await server.rpc(2, "tools/list");
    expect(listed["result"]?.["tools"]?.map((t: { name: string }) => t.name)).toEqual(["tl_read_file", "tl_edit_file", "tl_search_files"]);

    const stderr = server.stderr();
    expect(stderr).toContain("[tl-mcp] stdio transport (JSON-RPC 2.0)");
    expect(stderr).not.toContain("MCP SDK");
    expect(server.messages.map((m) => m["id"])).toEqual([1, 2]); // nothing for the notifications, nothing stray
  }, SPAWN_TIMEOUT_MS);
});
