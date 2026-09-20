// WP-S6 (2026-09-20) regression spec.
//
// A documented, advertised read_file shape -- a query-less multi-target
// read whose targets carry `symbol` (targets[].symbol; "partial=>
// targets[].range/.ranges/.symbol") -- was refused "path is required"
// instead of being served, because normalizeCanonicalRequest
// (server.ts) forced the WHOLE call to mode="symbol" the instant the
// FIRST target carried a symbol, and only a single top-level path/symbol
// is ever promoted to the legacy dispatcher for targets.length > 1.
//
// Recorded live (2026-09-20 GitHub Copilot session, new build):
//   read_file {"targets":[
//     {"path":"backend/.../OrderController.java","symbol":"cancel","purpose":"…"},
//     {"path":"backend/.../OrderService.java","symbol":"cancel","purpose":"…"},
//     {"path":"backend/.../OrderStatus.java","purpose":"…"}],
//    "content":"auto","task":{"handle":"<valid task handle>","profile":"answer"},"cwd":"<ws>"}
//   -> {"kind":"refusal","code":"invalid-input","field":"path","detail":"path is required"}
//
// server.ts's "S6" block (dispatchTool, read_file case, just before the
// "Pathless query entry" mode-unspecified task_pack promotion) now
// resolves this shape directly -- one target at a time, exactly as a
// single-target call would resolve it -- instead of either forcing the
// single-path dispatcher (refuse) or sweeping it into the task_pack
// discovery builder (which has no per-entry "symbol not found" signal;
// a range-only batch keeps using that builder unchanged, see the
// "unaffected" describe block below).
//
// A spawned-server spec (not a replayCorpus.spec.ts entry) because this
// shape needs a LIVE task handle from a first pack in the same session --
// the corpus harness replays fixed recorded request/response pairs and
// has no way to mint that handle dynamically.

import { afterAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const nodeRequire = createRequire(import.meta.url);
const TSX_CLI = nodeRequire.resolve("tsx/cli");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN_TS = path.resolve(HERE, "..", "..", "bin.ts");
const SPAWN_TIMEOUT_MS = 90_000;

function mkWorkspace(): string {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tl-rc-multitarget-symbol-")));
  fs.mkdirSync(path.join(ws, "src"), { recursive: true });
  fs.writeFileSync(path.join(ws, "package.json"), '{"name":"rc-multitarget-symbol"}\n');
  fs.writeFileSync(
    path.join(ws, "src/orderController.ts"),
    "export function cancelController(id: number): string {\n"
    + "  return `controller-cancel-${id}`;\n"
    + "}\n"
    + "\n"
    + "export function otherController(): void {\n"
    + "  console.log(\"other-controller\");\n"
    + "}\n",
  );
  fs.writeFileSync(
    path.join(ws, "src/orderService.ts"),
    "export function cancelService(id: number): string {\n"
    + "  return `service-cancel-${id}`;\n"
    + "}\n"
    + "\n"
    + "export function otherService(): void {\n"
    + "  console.log(\"other-service\");\n"
    + "}\n",
  );
  fs.writeFileSync(
    path.join(ws, "src/orderStatus.ts"),
    "export type OrderStatus = \"PLACED\" | \"CANCELLED\" | \"DELIVERED\";\n"
    + "\n"
    + "export const TERMINAL_STATUSES: OrderStatus[] = [\"CANCELLED\", \"DELIVERED\"];\n",
  );
  return ws;
}

interface ServerHandle {
  initialize(): Promise<void>;
  rpc(id: number, method: string, params?: unknown, timeoutMs?: number): Promise<any>;
  kill(): void;
}

const tmpDirs: string[] = [];
const spawnedServers: ServerHandle[] = [];

function startServer(ws: string): ServerHandle {
  const child: ChildProcess = spawn(process.execPath, [TSX_CLI, BIN_TS, ws], {
    cwd: ws,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });
  let stdoutBuf = "";
  let stderr = "";
  const waiters = new Map<number, (msg: any) => void>();
  child.stdout!.on("data", (d: Buffer) => {
    stdoutBuf += d.toString();
    let nl: number;
    while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
      const line = stdoutBuf.slice(0, nl);
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg && msg.id != null && waiters.has(msg.id)) {
        const w = waiters.get(msg.id)!;
        waiters.delete(msg.id);
        w(msg);
      }
    }
  });
  child.stderr!.on("data", (d: Buffer) => { stderr += d.toString(); });

  function rpc(id: number, method: string, params?: unknown, timeoutMs = 60000): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(new Error(`rpc '${method}' timed out after ${timeoutMs}ms.\n--- stderr ---\n${stderr}`));
      }, timeoutMs);
      waiters.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  async function initialize(): Promise<void> {
    await rpc(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "vitest-rc-multitarget-symbol", version: "0" },
    });
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  }

  const handle: ServerHandle = {
    initialize,
    rpc,
    kill: () => { try { child.kill("SIGKILL"); } catch { /* ok */ } },
  };
  spawnedServers.push(handle);
  return handle;
}

function bodyOf(rpcResult: any): Record<string, unknown> {
  const text = rpcResult?.result?.content?.[0]?.text;
  expect(typeof text, `expected text content, got: ${JSON.stringify(rpcResult)}`).toBe("string");
  return JSON.parse(text);
}

let nextCallId = 100;
async function callTool(server: ServerHandle, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return bodyOf(await server.rpc(nextCallId++, "tools/call", { name, arguments: args }));
}

afterAll(() => {
  for (const s of spawnedServers.splice(0)) s.kill();
  for (const d of tmpDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ok */ }
  }
});

describe("WP-S6: query-less multi-target read with per-entry symbol windows", () => {
  it(
    "recorded shape (2x {path,symbol} + 1 bare {path}), no task: one read.batch, in request order",
    async () => {
      const ws = mkWorkspace();
      tmpDirs.push(ws);
      const server = startServer(ws);
      await server.initialize();

      const body = await callTool(server, "read_file", {
        targets: [
          { path: "src/orderController.ts", symbol: "cancelController", purpose: "check controller cancel" },
          { path: "src/orderService.ts", symbol: "cancelService", purpose: "check service cancel" },
          { path: "src/orderStatus.ts", purpose: "check status enum" },
        ],
        content: "auto",
        cwd: ws,
      });

      expect(body["kind"], JSON.stringify(body).slice(0, 800)).toBe("read.batch");
      const entries = body["entries"] as Array<Record<string, unknown>>;
      expect(entries.length, JSON.stringify(body).slice(0, 800)).toBe(3);
      expect(entries[0]!["path"]).toContain("orderController.ts");
      expect(String(entries[0]!["content"])).toContain("function cancelController");
      expect(String(entries[0]!["content"])).not.toContain("otherController");
      expect(entries[1]!["path"]).toContain("orderService.ts");
      expect(String(entries[1]!["content"])).toContain("function cancelService");
      expect(String(entries[1]!["content"])).not.toContain("otherService");
      // The bare third target carries no symbol/range: served whole,
      // exactly the "third file" the recorded live session expected.
      expect(entries[2]!["path"]).toContain("orderStatus.ts");
      expect(String(entries[2]!["content"])).toContain("TERMINAL_STATUSES");
      expect(String(entries[2]!["content"])).toContain("OrderStatus");
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "recorded shape, WITH a valid task.handle from a first pack (profile answer): still one read.batch, never a refusal",
    async () => {
      const ws = mkWorkspace();
      tmpDirs.push(ws);
      const server = startServer(ws);
      await server.initialize();

      // A first pack, mirroring the live session's already-prepared context.
      const seed = await callTool(server, "read_file", {
        targets: [{ path: "src/orderController.ts" }, { path: "src/orderService.ts" }],
        content: "auto",
        cwd: ws,
      });
      expect(seed["kind"], JSON.stringify(seed).slice(0, 500)).toBe("read.task_pack");
      const taskId = (seed["task"] as Record<string, unknown> | undefined)?.["id"];
      expect(typeof taskId, JSON.stringify(seed).slice(0, 500)).toBe("string");

      const body = await callTool(server, "read_file", {
        targets: [
          { path: "src/orderController.ts", symbol: "cancelController", purpose: "check controller cancel" },
          { path: "src/orderService.ts", symbol: "cancelService", purpose: "check service cancel" },
          { path: "src/orderStatus.ts", purpose: "check status enum" },
        ],
        content: "auto",
        task: { handle: taskId, profile: "answer" },
        cwd: ws,
      });

      expect(body["kind"], JSON.stringify(body).slice(0, 800)).not.toBe("refusal");
      expect(body["kind"], JSON.stringify(body).slice(0, 800)).toBe("read.batch");
      const entries = body["entries"] as Array<Record<string, unknown>>;
      expect(entries.length, JSON.stringify(body).slice(0, 800)).toBe(3);
      expect(String(entries[0]!["content"])).toContain("function cancelController");
      expect(String(entries[1]!["content"])).toContain("function cancelService");
      expect(String(entries[2]!["content"])).toContain("TERMINAL_STATUSES");
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "{path,range} x2, no symbol anywhere: unaffected -- still resolved through today's task_pack promotion with the exact requested windows",
    async () => {
      const ws = mkWorkspace();
      tmpDirs.push(ws);
      const server = startServer(ws);
      await server.initialize();

      const body = await callTool(server, "read_file", {
        targets: [
          { path: "src/orderController.ts", range: "1-3" },
          { path: "src/orderService.ts", range: "1-3" },
        ],
        content: "auto",
        cwd: ws,
      });

      expect(body["kind"], JSON.stringify(body).slice(0, 800)).toBe("read.task_pack");
      const evidence = body["evidence"] as Array<Record<string, unknown>>;
      const controllerEv = evidence.find((e) => String(e["path"]).includes("orderController.ts"));
      const serviceEv = evidence.find((e) => String(e["path"]).includes("orderService.ts"));
      expect(controllerEv?.["range"], JSON.stringify(body).slice(0, 800)).toBe("1-3");
      expect(serviceEv?.["range"], JSON.stringify(body).slice(0, 800)).toBe("1-3");
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "mixed handle+path targets, each with its own symbol/range override: one read.batch",
    async () => {
      const ws = mkWorkspace();
      tmpDirs.push(ws);
      const server = startServer(ws);
      await server.initialize();

      const minted = await callTool(server, "read_file", { path: "src/orderController.ts", content: "auto", cwd: ws });
      const handle = (minted["evidence"] as Array<Record<string, unknown>>)[0]!["handle"] as string;

      const body = await callTool(server, "read_file", {
        targets: [
          { handle, symbol: "cancelController" },
          { path: "src/orderService.ts", range: "1-3" },
        ],
        content: "auto",
        cwd: ws,
      });

      expect(body["kind"], JSON.stringify(body).slice(0, 800)).toBe("read.batch");
      const entries = body["entries"] as Array<Record<string, unknown>>;
      expect(entries.length, JSON.stringify(body).slice(0, 800)).toBe(2);
      // Handle identity is preserved for a handle-addressed target -- the
      // same convention the A7 handles=[] batch already established.
      expect(entries[0]!["handle"]).toBe(handle);
      expect(String(entries[0]!["content"])).toContain("function cancelController");
      expect(entries[1]!["path"]).toContain("orderService.ts");
      expect(entries[1]!["range"]).toBe("1-3");
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "an unknown symbol in one target does not refuse the whole call: the other target is still served",
    async () => {
      const ws = mkWorkspace();
      tmpDirs.push(ws);
      const server = startServer(ws);
      await server.initialize();

      const body = await callTool(server, "read_file", {
        targets: [
          { path: "src/orderController.ts", symbol: "doesNotExist" },
          { path: "src/orderService.ts", symbol: "cancelService" },
        ],
        content: "auto",
        cwd: ws,
      });

      expect(body["kind"], JSON.stringify(body).slice(0, 800)).not.toBe("refusal");
      expect(body["kind"], JSON.stringify(body).slice(0, 800)).toBe("read.batch");
      const entries = body["entries"] as Array<Record<string, unknown>>;
      // The bad-symbol target is withheld, not fabricated; the good one
      // still ships.
      expect(entries.length, JSON.stringify(body).slice(0, 800)).toBe(1);
      expect(String(entries[0]!["content"])).toContain("function cancelService");
      expect(entries.some((e) => String(e["path"]).includes("orderController.ts"))).toBe(false);
    },
    SPAWN_TIMEOUT_MS,
  );

  describe("byte-identity controls: shapes that already work must stay unchanged", () => {
    it("single {path,symbol} target (not a batch at all): unaffected", async () => {
      const ws = mkWorkspace();
      tmpDirs.push(ws);
      const server = startServer(ws);
      await server.initialize();

      const body = await callTool(server, "read_file", {
        targets: [{ path: "src/orderController.ts", symbol: "cancelController" }],
        content: "auto",
        cwd: ws,
      });
      expect(body["kind"], JSON.stringify(body).slice(0, 800)).toBe("read.text");
      const evidence = body["evidence"] as Array<Record<string, unknown>>;
      expect(String(evidence[0]!["body"])).toContain("function cancelController");
    }, SPAWN_TIMEOUT_MS);

    it("all-handle multi-target with per-target overrides (A7 handles=[] batch): unaffected", async () => {
      const ws = mkWorkspace();
      tmpDirs.push(ws);
      const server = startServer(ws);
      await server.initialize();

      const mintedA = await callTool(server, "read_file", { path: "src/orderController.ts", content: "auto", cwd: ws });
      const mintedB = await callTool(server, "read_file", { path: "src/orderService.ts", content: "auto", cwd: ws });
      const handleA = (mintedA["evidence"] as Array<Record<string, unknown>>)[0]!["handle"] as string;
      const handleB = (mintedB["evidence"] as Array<Record<string, unknown>>)[0]!["handle"] as string;

      const body = await callTool(server, "read_file", {
        targets: [
          { handle: handleA, range: "1-3" },
          { handle: handleB, symbol: "cancelService" },
        ],
        content: "auto",
        cwd: ws,
      });
      expect(body["kind"], JSON.stringify(body).slice(0, 800)).toBe("read.batch");
      const entries = body["entries"] as Array<Record<string, unknown>>;
      expect(entries.length, JSON.stringify(body).slice(0, 800)).toBe(2);
      expect(entries[0]!["handle"]).toBe(handleA);
      expect(entries[1]!["handle"]).toBe(handleB);
    }, SPAWN_TIMEOUT_MS);

    it("plain multi-path (all bare, no symbol/range anywhere): unaffected, still a task_pack", async () => {
      const ws = mkWorkspace();
      tmpDirs.push(ws);
      const server = startServer(ws);
      await server.initialize();

      const body = await callTool(server, "read_file", {
        targets: [{ path: "src/orderController.ts" }, { path: "src/orderService.ts" }],
        content: "auto",
        cwd: ws,
      });
      expect(body["kind"], JSON.stringify(body).slice(0, 800)).toBe("read.task_pack");
      expect(body["decision"]).toBeDefined();
    }, SPAWN_TIMEOUT_MS);
  });
});
