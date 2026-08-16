/**
 * editFailureCandidates.spec.ts — tests for candidate handles in edit failures.
 *
 * Tests:
 *   - An edit_code call with a non-matching search string returns a failure
 *     response containing candidates[] (up to 3, each with a handle).
 *   - The failure response stays under 512 bytes.
 *   - If TL_SESSION_CONTROL=0, candidates[] is still emitted (candidates are a
 *     diagnostic aid, not gated by adaptive state).
 *
 * Uses spawned stdio server with --allow-write.
 */

import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const nodeRequire = createRequire(import.meta.url);
const TSX_CLI = nodeRequire.resolve("tsx/cli");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN_TS = path.resolve(HERE, "..", "bin.ts");

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();

const tmpDirs: string[] = [];
const servers: ServerHandle[] = [];

interface ServerHandle {
  initialize(): Promise<void>;
  rpc(id: number, method: string, params?: unknown, timeoutMs?: number): Promise<any>;
  kill(): void;
}

function mkDir(tag: string): string {
  const dir = fs.mkdtempSync(path.join(HOME, `.tl-candidates-${tag}-`));
  tmpDirs.push(dir);
  return dir;
}

function writeFile(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

function startServer(opts: { cwd: string; args: string[]; env?: Record<string, string> }): ServerHandle {
  const child: ChildProcess = spawn(
    process.execPath,
    [TSX_CLI, BIN_TS, ...opts.args],
    {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...opts.env },
    },
  );

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

  function send(obj: unknown): void {
    child.stdin!.write(JSON.stringify(obj) + "\n");
  }

  function rpc(id: number, method: string, params?: unknown, timeoutMs = 25000): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(new Error(`rpc '${method}' timed out after ${timeoutMs}ms.\n--- server stderr ---\n${stderr}`));
      }, timeoutMs);
      waiters.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      send({ jsonrpc: "2.0", id, method, params });
    });
  }

  async function initialize(): Promise<void> {
    await rpc(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "vitest", version: "0" },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  function kill(): void {
    try { child.kill("SIGKILL"); } catch { /* ok */ }
  }

  return { initialize, rpc, kill };
}

afterEach(() => {
  for (const s of servers.splice(0)) s.kill();
  for (const d of tmpDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ok */ }
  }
});

function parseToolResult(rpcResult: any): Record<string, unknown> {
  const text = rpcResult?.result?.content?.[0]?.text;
  expect(typeof text).toBe("string");
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// Candidates emitted on search-not-found
// ---------------------------------------------------------------------------

describe("editFailureCandidates — not-found failure includes candidates", () => {
  it("returns candidates[] when search string is not found in file", async () => {
    const wsDir = mkDir("notfound");

    writeFile(wsDir, "src/service.ts", [
      `export function getUser(id: string): Promise<User> {`,
      `  return db.findUser(id);`,
      `}`,
      ``,
      `export function createUser(data: UserData): Promise<User> {`,
      `  return db.insertUser(data);`,
      `}`,
    ].join("\n") + "\n");

    const srv = startServer({ cwd: wsDir, args: [wsDir, "--allow-write"] });
    servers.push(srv);
    await srv.initialize();

    const result = await srv.rpc(2, "tools/call", {
      name: "edit_file",
      arguments: {
        path: "src/service.ts",
        search: "THIS_STRING_DOES_NOT_EXIST_IN_THE_FILE",
        replace: "replacement",
      },
    });

    const data = parseToolResult(result);
    expect(data["kind"]).toBe("refusal");
    // Should have candidates[] with at least one entry.
    expect(Array.isArray(data["candidates"])).toBe(true);
    const candidates = data["candidates"] as Array<Record<string, unknown>>;
    expect(candidates.length).toBeGreaterThanOrEqual(1);
    // Each candidate must have a handle.
    for (const c of candidates) {
      expect(typeof c["handle"]).toBe("string");
      expect(String(c["handle"])).toMatch(/^h[0-9a-z]+$/);
      expect(typeof c["path"]).toBe("string");
    }
  }, 30000);

  it("candidates count is at most 3", async () => {
    const wsDir = mkDir("cand-cap");

    writeFile(wsDir, "src/big.ts", [
      `export function alpha() {}`,
      `export function beta() {}`,
      `export function gamma() {}`,
      `export function delta() {}`,
      `export function epsilon() {}`,
    ].join("\n") + "\n");

    const srv = startServer({ cwd: wsDir, args: [wsDir, "--allow-write"] });
    servers.push(srv);
    await srv.initialize();

    const result = await srv.rpc(2, "tools/call", {
      name: "edit_file",
      arguments: {
        path: "src/big.ts",
        search: "NONEXISTENT",
        replace: "x",
      },
    });

    const data = parseToolResult(result);
    expect(data["kind"]).toBe("refusal");
    expect(Array.isArray(data["candidates"])).toBe(true);
    const candidates = data["candidates"] as Array<Record<string, unknown>>;
    expect(candidates.length).toBeLessThanOrEqual(3);
  }, 30000);

  it("failure response stays under 512 bytes", async () => {
    const wsDir = mkDir("size-cap");

    writeFile(wsDir, "src/mod.ts", [
      `export function processOrder(order: Order): void {}`,
      `export function cancelOrder(id: string): void {}`,
      `export function updateOrder(id: string, data: Partial<Order>): void {}`,
    ].join("\n") + "\n");

    const srv = startServer({ cwd: wsDir, args: [wsDir, "--allow-write"] });
    servers.push(srv);
    await srv.initialize();

    const result = await srv.rpc(2, "tools/call", {
      name: "edit_file",
      arguments: {
        path: "src/mod.ts",
        search: "MISSING_SEARCH_STRING",
        replace: "replacement",
      },
    });

    const text = result?.result?.content?.[0]?.text as string;
    expect(typeof text).toBe("string");
    const data = JSON.parse(text);
    expect(data["kind"]).toBe("refusal");
    // Response must be under 512 bytes.
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(512);
  }, 30000);
});

// ---------------------------------------------------------------------------
// Candidates emitted when TL_SESSION_CONTROL=0
// ---------------------------------------------------------------------------

describe("editFailureCandidates — candidates emitted regardless of TL_SESSION_CONTROL", () => {
  it("emits candidates even when TL_SESSION_CONTROL=0", async () => {
    const wsDir = mkDir("no-session-control");

    writeFile(wsDir, "src/util.ts", [
      `export function formatDate(d: Date): string {`,
      `  return d.toISOString();`,
      `}`,
    ].join("\n") + "\n");

    const srv = startServer({
      cwd: wsDir,
      args: [wsDir, "--allow-write"],
      env: { TL_SESSION_CONTROL: "0" },
    });
    servers.push(srv);
    await srv.initialize();

    const result = await srv.rpc(2, "tools/call", {
      name: "edit_file",
      arguments: {
        path: "src/util.ts",
        search: "NO_MATCH_HERE",
        replace: "x",
      },
    });

    const data = parseToolResult(result);
    expect(data["kind"]).toBe("refusal");
    // candidates still emitted even with session control disabled.
    expect(Array.isArray(data["candidates"])).toBe(true);
    const candidates = data["candidates"] as Array<Record<string, unknown>>;
    expect(candidates.length).toBeGreaterThanOrEqual(1);
    for (const c of candidates) {
      expect(typeof c["handle"]).toBe("string");
    }
  }, 30000);
});
