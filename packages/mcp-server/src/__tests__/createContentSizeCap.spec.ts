/**
 * createContentSizeCap.spec.ts — FX-P2 / INV-I-3.
 *
 * AGENTS.md states plainly, for `create:true`: "new files/scratch/tests=>an
 * `edits[]` item with `create:true`+`content`... >32 KiB=fail". INV-I's
 * live-fire sweep found no enforcement anywhere on the wire: a 2 MiB
 * `create:true` payload wrote to disk cleanly, in both the top-level
 * single-edit shape and the `edits[]` batch-create-item shape.
 *
 * These tests spawn a real `bin.ts <cwd> --allow-write` server (production
 * shape, not an internal unit call) and assert BOTH that an oversized
 * `create:true` now refuses before any write, AND that disk is verified
 * untouched afterward — the pre-write-validation contract this file's sibling
 * `applyEditsMulti.spec.ts`/INV-I's own "batch all-or-nothing" finding rely
 * on elsewhere in this codebase.
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
  const dir = fs.mkdtempSync(path.join(HOME, `.tl-createcap-${tag}-`));
  tmpDirs.push(dir);
  return dir;
}

function fileExists(dir: string, rel: string): boolean {
  return fs.existsSync(path.join(dir, rel));
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

const CAP_BYTES = 32 * 1024;

describe("createContentSizeCap — single-edit create:true", () => {
  it("refuses a create:true whose content is over the 32 KiB cap, disk untouched", async () => {
    const wsDir = mkDir("single-over");
    const srv = startServer({ cwd: wsDir, args: [wsDir, "--allow-write"] });
    servers.push(srv);
    await srv.initialize();

    const oversized = "x".repeat(CAP_BYTES + 1024);
    const res = await srv.rpc(2, "tools/call", {
      name: "edit_file",
      arguments: { path: "src/big.ts", create: true, content: oversized },
    });
    const data = parseToolResult(res);
    expect(data["kind"]).toBe("refusal");
    expect(data["code"]).toBe("file-too-large");
    expect(data["field"]).toBe("content");
    expect(fileExists(wsDir, "src/big.ts")).toBe(false);
  }, 30000);

  it("still creates a file whose content is exactly at the 32 KiB cap", async () => {
    const wsDir = mkDir("single-exact");
    const srv = startServer({ cwd: wsDir, args: [wsDir, "--allow-write"] });
    servers.push(srv);
    await srv.initialize();

    const exact = "x".repeat(CAP_BYTES);
    const res = await srv.rpc(2, "tools/call", {
      name: "edit_file",
      arguments: { path: "src/exact.ts", create: true, content: exact },
    });
    const data = parseToolResult(res);
    expect(data["kind"]).not.toBe("refusal");
    expect(fileExists(wsDir, "src/exact.ts")).toBe(true);
    expect(fs.statSync(path.join(wsDir, "src/exact.ts")).size).toBe(CAP_BYTES);
  }, 30000);
});

describe("createContentSizeCap — edits[] batch create item", () => {
  it("refuses the WHOLE batch when one create item is over the cap; disk untouched for every item", async () => {
    const wsDir = mkDir("batch-over");
    const srv = startServer({ cwd: wsDir, args: [wsDir, "--allow-write"] });
    servers.push(srv);
    await srv.initialize();

    const oversized = "y".repeat(CAP_BYTES + 1);
    const res = await srv.rpc(2, "tools/call", {
      name: "edit_file",
      arguments: {
        edits: [
          { path: "src/ok.ts", create: true, content: "export const OK = 1;\n" },
          { path: "src/huge.ts", create: true, content: oversized },
        ],
      },
    });
    const data = parseToolResult(res);
    expect(data["kind"]).toBe("refusal");
    expect(data["code"]).toBe("file-too-large");
    expect(data["field"]).toBe("edits[1].content");
    expect((data["failed_item"] as Record<string, unknown>)?.["index"]).toBe(1);
    // Neither item in the batch was written — Phase 1 validation runs before
    // any write, and this repro's whole point is that the earlier, valid
    // item must not land either.
    expect(fileExists(wsDir, "src/ok.ts")).toBe(false);
    expect(fileExists(wsDir, "src/huge.ts")).toBe(false);
  }, 30000);
});
