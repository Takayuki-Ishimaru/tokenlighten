/**
 * allowPathFallbackApplied.spec.ts — FX-P2 / INV-I-5.
 *
 * `allowPathFallback`'s own schema description is "Fallback to path if
 * handle fails." INV-I's live-fire sweep found the ONE call shape that
 * description actually names — a stale/unknown `handle` alongside a
 * path+search that could otherwise resolve the edit — never fell back at
 * all: `allowPathFallback` true or false both refused `handle-unknown`
 * immediately, disk untouched. The flag had zero observable effect on this
 * call shape.
 *
 * The fix: `allowPathFallback:true` on a stale handle drops the dead handle
 * and routes the call through the EXACT SAME bare-path search/replace
 * dispatch (enforcePreconditions, execution-typestate fence,
 * uniqueness/auto-mint) a caller who never mentioned a handle would hit —
 * so it only ever "applies" when the search still uniquely matches, exactly
 * like any other path edit. `allowPathFallback:false` (and the
 * default/omitted case) keep refusing `handle-unknown` exactly as before.
 *
 * These tests spawn a real `bin.ts <cwd> --allow-write` server.
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
  const dir = fs.mkdtempSync(path.join(HOME, `.tl-pathfallback-${tag}-`));
  tmpDirs.push(dir);
  return dir;
}

function writeFile(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

function readFile(dir: string, rel: string): string {
  return fs.readFileSync(path.join(dir, rel), "utf8");
}

function startServer(opts: { cwd: string; args: string[] }): ServerHandle {
  const child: ChildProcess = spawn(
    process.execPath,
    [TSX_CLI, BIN_TS, ...opts.args],
    { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env } },
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

const STALE_HANDLE = "hSTALE00000"; // well-formed shape, never minted this session

describe("allowPathFallbackApplied — stale handle, allowPathFallback:true", () => {
  it("applies via path fallback exactly once when search uniquely matches; applied[] discloses it", async () => {
    const wsDir = mkDir("true-unique");
    writeFile(wsDir, "src/a.ts", 'export const A = "old";\n');
    const srv = startServer({ cwd: wsDir, args: [wsDir, "--allow-write"] });
    servers.push(srv);
    await srv.initialize();

    const res = await srv.rpc(2, "tools/call", {
      name: "edit_file",
      arguments: {
        handle: STALE_HANDLE,
        path: "src/a.ts",
        search: '"old"',
        replace: '"new"',
        allowPathFallback: true,
      },
    });
    const data = parseToolResult(res);
    expect(data["kind"]).not.toBe("refusal");
    expect(readFile(wsDir, "src/a.ts")).toContain('"new"');

    const applied = data["applied"] as Array<Record<string, unknown>> | undefined;
    expect(Array.isArray(applied)).toBe(true);
    const entry = applied!.find((e) => e["path"] === "src/a.ts");
    expect(entry).toBeDefined();
    expect(entry!["path_fallback"]).toBe(true);
  }, 30000);

  it("allowPathFallback:false still refuses handle-unknown, disk untouched", async () => {
    const wsDir = mkDir("false-regression");
    writeFile(wsDir, "src/a.ts", 'export const A = "old";\n');
    const srv = startServer({ cwd: wsDir, args: [wsDir, "--allow-write"] });
    servers.push(srv);
    await srv.initialize();

    const res = await srv.rpc(2, "tools/call", {
      name: "edit_file",
      arguments: {
        handle: STALE_HANDLE,
        path: "src/a.ts",
        search: '"old"',
        replace: '"new"',
        allowPathFallback: false,
      },
    });
    const data = parseToolResult(res);
    expect(data["kind"]).toBe("refusal");
    expect(data["code"]).toBe("handle-unknown");
    expect(readFile(wsDir, "src/a.ts")).toBe('export const A = "old";\n');
  }, 30000);

  it("allowPathFallback omitted (default) still refuses handle-unknown, disk untouched", async () => {
    const wsDir = mkDir("omitted-regression");
    writeFile(wsDir, "src/a.ts", 'export const A = "old";\n');
    const srv = startServer({ cwd: wsDir, args: [wsDir, "--allow-write"] });
    servers.push(srv);
    await srv.initialize();

    const res = await srv.rpc(2, "tools/call", {
      name: "edit_file",
      arguments: {
        handle: STALE_HANDLE,
        path: "src/a.ts",
        search: '"old"',
        replace: '"new"',
      },
    });
    const data = parseToolResult(res);
    expect(data["kind"]).toBe("refusal");
    expect(data["code"]).toBe("handle-unknown");
    expect(readFile(wsDir, "src/a.ts")).toBe('export const A = "old";\n');
  }, 30000);

  it("a non-unique search never blind-applies via fallback — refuses, disk untouched (never a bypass)", async () => {
    const wsDir = mkDir("true-nonunique");
    writeFile(wsDir, "src/dup.ts", [
      'const a = "dup";',
      'const b = "dup";',
    ].join("\n") + "\n");
    const srv = startServer({ cwd: wsDir, args: [wsDir, "--allow-write"] });
    servers.push(srv);
    await srv.initialize();

    const before = readFile(wsDir, "src/dup.ts");
    const res = await srv.rpc(2, "tools/call", {
      name: "edit_file",
      arguments: {
        handle: STALE_HANDLE,
        path: "src/dup.ts",
        search: '"dup"',
        replace: '"changed"',
        allowPathFallback: true,
      },
    });
    const data = parseToolResult(res);
    expect(data["kind"]).toBe("refusal");
    expect(readFile(wsDir, "src/dup.ts")).toBe(before);
  }, 30000);
});
