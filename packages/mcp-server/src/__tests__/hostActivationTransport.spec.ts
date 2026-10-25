/**
 * hostActivationTransport.spec.ts — the VS Code window-scoped off switch,
 * against REAL spawned servers (2026-10-02; mcp/hostActivation.ts).
 *
 * THE BUG. With `tokenlighten.enabled: false` and `tokenlighten.session.native`
 * executed, a real Copilot session still called `tl_read_file` and got an
 * answer: a workspace set up with `tl workspace setup` has a managed
 * `.vscode/mcp.json` entry, so VS Code (not the extension) launches the
 * server, and neither the setting nor the command could reach it. The fix is
 * a per-workspace override file the extension writes and the server honors:
 * `<ws>/.tokenlighten/host-activation.json`, live only while its `ownerPid`
 * runs AND its `updatedAt` is fresh (no older than 90 s, none more than 60 s
 * ahead; the extension rewrites it every 30 s), applied only by a server that
 * is the VS Code client by environment.
 *
 * WHAT THIS PINS (each claim against a spawned `bin.ts`, legacy-era wire):
 *   1. no override: three tools listed, a call works;
 *   2. a live override: `tools/list` is empty, `tools/call` is refused as
 *      -32601 naming the reason, one `notifications/tools/list_changed`
 *      arrives when the file appears and another when it goes, and the tools
 *      come back;
 *   3. a stale override (dead owner) is ignored, and so is a LIVE owner's file
 *      that is older than the TTL or dated beyond the skew (3b); one that nobody
 *      refreshes ages out while connected, announced like a removed file (3c);
 *   4. the same live override changes NOTHING for a server that is not the VS
 *      Code client by environment (Claude Code, Codex, or VS Code without the
 *      env pair) — including no capability change and no notification;
 *   5. malformed JSON, a wrong schemaVersion/client and a symlinked file are
 *      ignored (fail-open);
 *   6. `initialize` declares `tools.listChanged` for the VS Code client only;
 *   7. the watch ends with the input (the process exits, no timer leak);
 *   8. the modern (SDK v2) leg, reached with a 2025-era handshake, answers the
 *      same way.
 *
 * Workspaces are direct children of HOME (the suite convention: the server
 * treats OS temp roots specially), removed after each test.
 */

import { afterAll, afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  HOST_ACTIVATION_FUTURE_SKEW_MS,
  HOST_ACTIVATION_POLL_MS,
  HOST_ACTIVATION_TTL_MS,
} from "../mcp/hostActivation.js";
import { killServerGroup } from "./helpers/killServerGroup.js";
import { rmDirWithRetry, waitForExit } from "./helpers/rmDirWithRetry.js";
import { symlinkSupported } from "./helpers/symlinkSupported.js";
import { TSX_NODE_ARGS } from "./helpers/tsxNode.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN_TS = path.resolve(HERE, "..", "bin.ts");
const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();

/** Per-test ceiling: a cold tsx start of a spawned server plus its waits. */
const TEST_TIMEOUT_MS = 150_000;
/** Killing a server group and removing its workspace. */
const HOOK_TIMEOUT_MS = 60_000;
/** The first reply of a freshly spawned server (tsx compile + module load). */
const BOOT_TIMEOUT_MS = 90_000;
/** "Within ~5 s" in the contract: one poll interval plus generous scheduling slack. */
const LIST_CHANGED_TIMEOUT_MS = HOST_ACTIVATION_POLL_MS + 6_000;

/** What `tl workspace setup` (and the extension's provider) puts in a VS Code server's environment. */
const VSCODE_ENV: Record<string, string | undefined> = {
  TOKENLIGHTEN_CLIENT: "vscode",
  TOKENLIGHTEN_CLIENT_ID: "vscode",
};
/** What `tl workspace setup` writes for Claude Code: no CLIENT_ID at all. */
const CLAUDE_CODE_ENV: Record<string, string | undefined> = {
  TOKENLIGHTEN_CLIENT: "claude-code",
  TOKENLIGHTEN_CLIENT_ID: undefined,
};

const TOOL_NAMES = ["tl_edit_file", "tl_read_file", "tl_search_files"];

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  result?: any;
  error?: { code: number; message: string };
}

interface ServerHandle {
  readonly child: ChildProcess;
  stderr(): string;
  rpc(method: string, params?: unknown, timeoutMs?: number): Promise<JsonRpcMessage>;
  /** `initialize` + `notifications/initialized`; resolves to the `initialize` reply. */
  handshake(clientName?: string): Promise<JsonRpcMessage>;
  /** How many `notifications/tools/list_changed` lines the server has written so far. */
  listChangedCount(): number;
  waitForListChanged(count: number, timeoutMs?: number): Promise<void>;
  kill(): Promise<void>;
}

const servers: ServerHandle[] = [];
const roots: string[] = [];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startServer(ws: string, env: Record<string, string | undefined>): ServerHandle {
  const child: ChildProcess = spawn(process.execPath, [...TSX_NODE_ARGS, BIN_TS, ws], {
    cwd: ws,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
    // `undefined` values are dropped by spawn(), which is how a test removes
    // a variable the developer's own shell might export.
    env: { ...process.env, ...env },
  });
  let stdoutBuffer = "";
  let stderr = "";
  let nextId = 1;
  let listChanged = 0;
  const waiters = new Map<number, (message: JsonRpcMessage) => void>();

  child.stdout!.on("data", (chunk: Buffer) => {
    stdoutBuffer += chunk.toString();
    let newline: number;
    while ((newline = stdoutBuffer.indexOf("\n")) >= 0) {
      const line = stdoutBuffer.slice(0, newline);
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(line) as JsonRpcMessage;
      } catch {
        continue;
      }
      if (message.id === undefined && message.method === "notifications/tools/list_changed") {
        // A notification is a whole JSON-RPC line with no id and no params.
        expect(line).toBe('{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}');
        listChanged += 1;
      }
      if (typeof message.id === "number" && waiters.has(message.id)) {
        const waiter = waiters.get(message.id)!;
        waiters.delete(message.id);
        waiter(message);
      }
    }
  });
  child.stderr!.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const rpc = (method: string, params?: unknown, timeoutMs = BOOT_TIMEOUT_MS): Promise<JsonRpcMessage> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(new Error(`rpc '${method}' timed out after ${timeoutMs}ms.\n--- server stderr ---\n${stderr}`));
      }, timeoutMs);
      waiters.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });

  const handle: ServerHandle = {
    child,
    stderr: () => stderr,
    rpc,
    async handshake(clientName = "vitest-host-activation") {
      const reply = await rpc("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: clientName, version: "0" },
      });
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      return reply;
    },
    listChangedCount: () => listChanged,
    async waitForListChanged(count, timeoutMs = LIST_CHANGED_TIMEOUT_MS) {
      const started = Date.now();
      while (listChanged < count) {
        if (Date.now() - started > timeoutMs) {
          throw new Error(
            `expected ${count} notifications/tools/list_changed within ${timeoutMs}ms, saw ${listChanged}.\n--- server stderr ---\n${stderr}`,
          );
        }
        await sleep(50);
      }
    },
    async kill() {
      killServerGroup(child);
      await waitForExit(child);
    },
  };
  servers.push(handle);
  return handle;
}

afterEach(async () => {
  // Servers first: several have a workspace as their cwd.
  for (const server of servers.splice(0)) await server.kill();
  for (const root of roots.splice(0)) await rmDirWithRetry(root);
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  for (const server of servers.splice(0)) await server.kill();
  for (const root of roots.splice(0)) await rmDirWithRetry(root);
}, HOOK_TIMEOUT_MS);

function workspace(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(HOME, ".tl-host-activation-")));
  roots.push(root);
  fs.writeFileSync(
    path.join(root, "sample.ts"),
    ["export const alpha = 1;", "export function beta(): number { return alpha + 1; }", "export const gamma = beta();"].join("\n") + "\n",
  );
  return root;
}

function overridePath(ws: string): string {
  return path.join(ws, ".tokenlighten", "host-activation.json");
}

/** Writes the override the way the extension does: a temp file in the same directory, then a rename. */
function writeOverride(ws: string, patch: Record<string, unknown> = {}): string {
  const target = overridePath(ws);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const record = {
    schemaVersion: 1,
    client: "vscode",
    state: "disabled",
    ownerPid: process.pid,
    updatedAt: new Date().toISOString(),
    ...patch,
  };
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(record));
  fs.renameSync(temp, target);
  return target;
}

function toolNames(reply: JsonRpcMessage): string[] {
  expect(reply.error, JSON.stringify(reply)).toBeUndefined();
  return (reply.result.tools as Array<{ name: string }>).map((tool) => tool.name).sort();
}

/** A tl_read_file call on the canonical shape; the reply is a `read.*` envelope when TokenLighten serves it. */
async function readSample(server: ServerHandle, ws: string): Promise<JsonRpcMessage> {
  return server.rpc("tools/call", { name: "tl_read_file", arguments: { targets: [{ path: "sample.ts" }], cwd: ws } });
}

function expectServed(reply: JsonRpcMessage): void {
  expect(reply.error, JSON.stringify(reply).slice(0, 600)).toBeUndefined();
  const body = JSON.parse(reply.result.content[0].text) as Record<string, unknown>;
  expect(body["v"]).toBe(1);
  expect(String(body["kind"])).toMatch(/^read\./);
}

const REFUSAL_DISABLED =
  "Tool not found: tl_read_file (TokenLighten is turned off for this VS Code window: disabled by tokenlighten.enabled=false; use the host's native tools)";
const REFUSAL_NATIVE =
  "Tool not found: tl_read_file (TokenLighten is turned off for this VS Code window: native session; use the host's native tools)";

describe("host activation — the VS Code client, spawned", () => {
  it("(1) with no override: three tools are listed, a tl_read_file call is served, and initialize declares tools.listChanged", async () => {
    const ws = workspace();
    const server = startServer(ws, VSCODE_ENV);

    const init = await server.handshake();
    expect(init.result.capabilities).toEqual({ tools: { listChanged: true } });
    expect(toolNames(await server.rpc("tools/list"))).toEqual(TOOL_NAMES);
    expectServed(await readSample(server, ws));
    expect(server.listChangedCount()).toBe(0);
  }, TEST_TIMEOUT_MS);

  it("(2) a live override empties tools/list and refuses tools/call, announces both transitions, and ends when the file goes", async () => {
    const ws = workspace();
    const server = startServer(ws, VSCODE_ENV);
    await server.handshake();
    expect(toolNames(await server.rpc("tools/list"))).toEqual(TOOL_NAMES);
    expect(server.listChangedCount()).toBe(0);

    // The file appears while the connection is open: the poll announces it.
    const file = writeOverride(ws, { state: "disabled", ownerPid: process.pid });
    await server.waitForListChanged(1);
    const listed = await server.rpc("tools/list");
    expect(listed.error).toBeUndefined();
    expect(listed.result).toEqual({ tools: [] });

    const refused = await readSample(server, ws);
    expect(refused.result).toBeUndefined();
    expect(refused.error).toEqual({ code: -32601, message: REFUSAL_DISABLED });
    // The gate comes before the advertised-or-refused check: an unknown name gets the reason too.
    const unknown = await server.rpc("tools/call", { name: "no_such_tool", arguments: {} });
    expect(unknown.error?.code).toBe(-32601);
    expect(unknown.error?.message).toBe(
      "Tool not found: no_such_tool (TokenLighten is turned off for this VS Code window: disabled by tokenlighten.enabled=false; use the host's native tools)",
    );

    // A different live state changes the reason, not the list: no second notification.
    writeOverride(ws, { state: "native", ownerPid: process.pid });
    expect((await readSample(server, ws)).error).toEqual({ code: -32601, message: REFUSAL_NATIVE });
    expect(server.listChangedCount()).toBe(1);

    // The file goes: the tools come back and the host is told again.
    fs.rmSync(file);
    await server.waitForListChanged(2);
    expect(toolNames(await server.rpc("tools/list"))).toEqual(TOOL_NAMES);
    expectServed(await readSample(server, ws));
    expect(server.stderr()).toContain("host activation: TokenLighten turned off for this VS Code window");
    expect(server.stderr()).toContain("host activation: override ended; TokenLighten tools restored");
  }, TEST_TIMEOUT_MS);

  it("(2b) an override already present at start is honored from the first tools/list, with no notification", async () => {
    const ws = workspace();
    writeOverride(ws, { state: "native", ownerPid: process.pid });
    const server = startServer(ws, VSCODE_ENV);
    await server.handshake();

    expect((await server.rpc("tools/list")).result).toEqual({ tools: [] });
    expect((await readSample(server, ws)).error?.message).toBe(REFUSAL_NATIVE);
    // The baseline of the watch is the state the client has already seen.
    await sleep(HOST_ACTIVATION_POLL_MS + 750);
    expect(server.listChangedCount()).toBe(0);
  }, TEST_TIMEOUT_MS);

  it("(3) a stale override (its owner has exited) is ignored: tools are listed and served", async () => {
    // A pid that belonged to a process this test started and waited for.
    const gone = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    await new Promise<void>((resolve) => gone.once("exit", () => resolve()));
    const deadPid = gone.pid!;
    expect(() => process.kill(deadPid, 0)).toThrow();

    const ws = workspace();
    writeOverride(ws, { state: "disabled", ownerPid: deadPid });
    const server = startServer(ws, VSCODE_ENV);
    await server.handshake();

    expect(toolNames(await server.rpc("tools/list"))).toEqual(TOOL_NAMES);
    expectServed(await readSample(server, ws));
  }, TEST_TIMEOUT_MS);

  it("(3b) a live pid is not enough: an override older than the TTL, or dated beyond the skew, is ignored", async () => {
    const ws = workspace();
    const server = startServer(ws, VSCODE_ENV);
    await server.handshake();
    const now = Date.now();

    // Every owner below is ALIVE (this test process, or pid 1); only the stamp is wrong.
    const ignoredCases: Array<[string, Record<string, unknown>]> = [
      ["older than the TTL", { ownerPid: process.pid, updatedAt: new Date(now - HOST_ACTIVATION_TTL_MS - 5_000).toISOString() }],
      ["pid 1 with a 2020 stamp (the review's probe)", { ownerPid: 1, updatedAt: "2020-01-01T00:00:00.000Z" }],
      ["the parent process's pid, aged out", { ownerPid: process.ppid, updatedAt: new Date(now - 24 * 60 * 60 * 1000).toISOString() }],
      ["dated beyond the skew into the future", { ownerPid: process.pid, updatedAt: new Date(now + HOST_ACTIVATION_FUTURE_SKEW_MS + 15_000).toISOString() }],
    ];
    for (const [label, patch] of ignoredCases) {
      writeOverride(ws, patch);
      expect(toolNames(await server.rpc("tools/list")), label).toEqual(TOOL_NAMES);
      expectServed(await readSample(server, ws));
    }

    // Positive controls on the same server: just inside each bound the file is honoured.
    writeOverride(ws, { updatedAt: new Date(now - HOST_ACTIVATION_TTL_MS + 20_000).toISOString() });
    expect((await server.rpc("tools/list")).result).toEqual({ tools: [] });
    writeOverride(ws, { updatedAt: new Date(now + HOST_ACTIVATION_FUTURE_SKEW_MS - 20_000).toISOString() });
    expect((await server.rpc("tools/list")).result).toEqual({ tools: [] });
  }, TEST_TIMEOUT_MS);

  it("(3c) a live override that nobody refreshes ages out while connected, and the host is told like for a removed file", async () => {
    const ws = workspace();
    const server = startServer(ws, VSCODE_ENV);
    await server.handshake();
    expect(toolNames(await server.rpc("tools/list"))).toEqual(TOOL_NAMES);

    // Stamped so that it has this long left to live: live for the first polls, aged out well before the test gives up.
    const remainingMs = 10_000;
    writeOverride(ws, { updatedAt: new Date(Date.now() - (HOST_ACTIVATION_TTL_MS - remainingMs)).toISOString() });
    await server.waitForListChanged(1);
    expect((await server.rpc("tools/list")).result).toEqual({ tools: [] });
    expect((await readSample(server, ws)).error?.code).toBe(-32601);

    // No heartbeat arrives: the TTL runs out, with the file still there and its owner (this process) still alive.
    await server.waitForListChanged(2, remainingMs + LIST_CHANGED_TIMEOUT_MS);
    expect(fs.existsSync(overridePath(ws))).toBe(true);
    expect(toolNames(await server.rpc("tools/list"))).toEqual(TOOL_NAMES);
    expectServed(await readSample(server, ws));
    expect(server.stderr()).toContain(
      `host activation: override ended; TokenLighten tools restored (not refreshed within ${HOST_ACTIVATION_TTL_MS / 1000} s)`,
    );
  }, TEST_TIMEOUT_MS);

  it("(5) malformed JSON, an unsupported schemaVersion/client/state and a symlinked file are ignored; a valid file is the positive control", async () => {
    const ws = workspace();
    const server = startServer(ws, VSCODE_ENV);
    await server.handshake();
    const file = overridePath(ws);
    fs.mkdirSync(path.dirname(file), { recursive: true });

    const ignoredCases: Array<[string, () => void]> = [
      ["malformed JSON", () => fs.writeFileSync(file, "{ \"schemaVersion\": 1, ")],
      ["not an object", () => fs.writeFileSync(file, "[1,2,3]")],
      ["wrong schemaVersion", () => writeOverride(ws, { schemaVersion: 2 })],
      ["wrong client", () => writeOverride(ws, { client: "codex" })],
      ["unknown state", () => writeOverride(ws, { state: "off" })],
      ["non-positive ownerPid", () => writeOverride(ws, { ownerPid: 0 })],
    ];
    if (symlinkSupported()) {
      ignoredCases.push([
        "a symlink to an otherwise valid live override",
        () => {
          const real = path.join(ws, "real-override.json");
          fs.writeFileSync(real, JSON.stringify({
            schemaVersion: 1, client: "vscode", state: "disabled", ownerPid: process.pid, updatedAt: new Date().toISOString(),
          }));
          fs.rmSync(file, { force: true });
          fs.symlinkSync(real, file);
        },
      ]);
    }
    for (const [label, arrange] of ignoredCases) {
      arrange();
      expect(toolNames(await server.rpc("tools/list")), label).toEqual(TOOL_NAMES);
      expectServed(await readSample(server, ws));
    }

    // Positive control: the very same server honors a valid file, so the cases above were not vacuous.
    fs.rmSync(file, { force: true });
    writeOverride(ws, { state: "disabled", ownerPid: process.pid });
    expect((await server.rpc("tools/list")).result).toEqual({ tools: [] });
  }, TEST_TIMEOUT_MS);

  it("(7) the watch ends with the input: closing stdin lets a VS Code server exit", async () => {
    const ws = workspace();
    const server = startServer(ws, VSCODE_ENV);
    await server.handshake();
    expect(toolNames(await server.rpc("tools/list"))).toEqual(TOOL_NAMES);

    server.child.stdin!.end();
    await new Promise<void>((resolve, reject) => {
      if (server.child.exitCode !== null || server.child.signalCode !== null) return resolve();
      const timer = setTimeout(
        () => reject(new Error(`the server kept running 30s after stdin ended.\n--- server stderr ---\n${server.stderr()}`)),
        30_000,
      );
      server.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }, TEST_TIMEOUT_MS);
});

describe("host activation — a server that is not the VS Code client by environment is never affected", () => {
  const cases: Array<[string, Record<string, string | undefined>, string]> = [
    ["Claude Code (TOKENLIGHTEN_CLIENT=claude-code, no CLIENT_ID)", CLAUDE_CODE_ENV, "claude-code"],
    ["VS Code's own client name but no VS Code environment pair", { TOKENLIGHTEN_CLIENT: undefined, TOKENLIGHTEN_CLIENT_ID: undefined }, "Visual Studio Code"],
  ];

  it.each(cases)("(4,6) %s: live override ignored, initialize unchanged, no notification", async (_label, env, clientName) => {
    const ws = workspace();
    // The very override that turns a VS Code server off, owned by a live process (this one).
    const file = writeOverride(ws, { state: "disabled", ownerPid: process.pid });
    const server = startServer(ws, env);

    const init = await server.handshake(clientName);
    // Byte-identical to every release before the override existed.
    expect(JSON.stringify(init.result.capabilities)).toBe('{"tools":{}}');
    expect(toolNames(await server.rpc("tools/list"))).toEqual(TOOL_NAMES);
    expectServed(await readSample(server, ws));

    // Not even a poll runs: nothing is announced when the file changes.
    fs.rmSync(file);
    writeOverride(ws, { state: "native", ownerPid: process.pid });
    await sleep(HOST_ACTIVATION_POLL_MS + 750);
    expect(server.listChangedCount()).toBe(0);
    expect(toolNames(await server.rpc("tools/list"))).toEqual(TOOL_NAMES);
    expect(server.stderr()).not.toContain("host activation");
  }, TEST_TIMEOUT_MS);

  it("(6) an older VS Code entry that carries only TOKENLIGHTEN_CLIENT=vscode is still the VS Code client", async () => {
    const ws = workspace();
    writeOverride(ws, { state: "disabled", ownerPid: process.pid });
    const server = startServer(ws, { TOKENLIGHTEN_CLIENT: "vscode", TOKENLIGHTEN_CLIENT_ID: undefined });

    const init = await server.handshake();
    expect(init.result.capabilities).toEqual({ tools: { listChanged: true } });
    expect((await server.rpc("tools/list")).result).toEqual({ tools: [] });
  }, TEST_TIMEOUT_MS);
});

describe("host activation — the modern (SDK v2) leg", () => {
  it("(8) answers like the legacy leg: empty list, -32601 refusal naming the reason, list_changed on both transitions", async () => {
    const ws = workspace();
    const server = startServer(ws, { ...VSCODE_ENV, TOKENLIGHTEN_PROTOCOL_ERA: "modern" });

    // A 2025-era handshake is served by the modern leg's compat adapter.
    const init = await server.handshake();
    expect(init.result.capabilities.tools).toEqual({ listChanged: true });
    expect(toolNames(await server.rpc("tools/list"))).toEqual(TOOL_NAMES);

    const file = writeOverride(ws, { state: "native", ownerPid: process.pid });
    await server.waitForListChanged(1);
    expect((await server.rpc("tools/list")).result.tools).toEqual([]);
    const refused = await readSample(server, ws);
    expect(refused.result).toBeUndefined();
    expect(refused.error?.code).toBe(-32601);
    expect(refused.error?.message).toBe(REFUSAL_NATIVE);

    fs.rmSync(file);
    await server.waitForListChanged(2);
    expect(toolNames(await server.rpc("tools/list"))).toEqual(TOOL_NAMES);
    expectServed(await readSample(server, ws));
  }, TEST_TIMEOUT_MS);

  it("(8b) a non-VS Code server on the modern leg keeps `tools: {}` and ignores the override", async () => {
    const ws = workspace();
    writeOverride(ws, { state: "disabled", ownerPid: process.pid });
    const server = startServer(ws, { ...CLAUDE_CODE_ENV, TOKENLIGHTEN_PROTOCOL_ERA: "modern" });

    const init = await server.handshake();
    expect(init.result.capabilities.tools).toEqual({});
    expect(toolNames(await server.rpc("tools/list"))).toEqual(TOOL_NAMES);
    expectServed(await readSample(server, ws));
  }, TEST_TIMEOUT_MS);
});
