// editCodeReview.spec.ts — server-level tests for edit_code review:true opt-in.
//
// Spawns the real server with --allow-write and exercises the JSON-RPC
// tools/call path. The server must be started with --allow-write for write
// tools to be callable.

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
  const dir = fs.mkdtempSync(path.join(HOME, `.tl-review-${tag}-`));
  tmpDirs.push(dir);
  return dir;
}

function writeFile(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FORBIDDEN_KEYS = [
  "tokenlighten",
  "tokenlighten:meta",
  "meta",
  "next_action",
  "edit_candidates",
  "native_fallback_tool",
];

function assertNoForbiddenKeys(json: string): void {
  for (const k of FORBIDDEN_KEYS) {
    expect(json).not.toContain(`"${k}"`);
  }
}

/** Valid ImpactSurface values per ImpactSurface union. */
const VALID_SURFACES = new Set([
  "contract", "api", "data", "ui", "style", "test", "config", "unknown",
]);

/** Parse the first content-block text from a JSON-RPC tools/call result. */
function parseEditResult(rpcResult: any): Record<string, unknown> {
  const text = rpcResult?.result?.content?.[0]?.text;
  expect(typeof text).toBe("string");
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("edit_code review:true opt-in (server-level)", () => {
  it("default edit_code (no review) returns compact shape without review key", async () => {
    const wsDir = mkDir("no-review");
    writeFile(wsDir, "src/util.ts", "export const VERSION = 'OLD';\n");

    const srv = startServer({ cwd: wsDir, args: [wsDir, "--allow-write"] });
    servers.push(srv);
    await srv.initialize();

    const res = await srv.rpc(2, "tools/call", {
      name: "edit_file",
      arguments: {
        path: "src/util.ts",
        search: "OLD",
        replace: "NEW",
      },
    });

    const data = parseEditResult(res);
    // ok:true edit result must have {ok, path, lines, delta} — no review key.
    expect(data["kind"]).not.toBe("refusal");
    expect(typeof data["path"]).toBe("string");
    expect(data).not.toHaveProperty("review");
  }, 30000);

  it("edit_code review:true returns compact shape PLUS review object", async () => {
    const wsDir = mkDir("with-review");
    // Use a unique ALL_CAPS token so the review heuristic fires.
    // The search string must appear exactly once in the file.
    writeFile(wsDir, "src/service/statsService.ts", "export const PRIORITY_LEVEL = 'urgent';\n");

    const srv = startServer({ cwd: wsDir, args: [wsDir, "--allow-write"] });
    servers.push(srv);
    await srv.initialize();

    const res = await srv.rpc(2, "tools/call", {
      name: "edit_file",
      arguments: {
        path: "src/service/statsService.ts",
        search: "PRIORITY_LEVEL",
        replace: "PRIORITY_CRITICAL",
        review: true,
      },
    });

    const data = parseEditResult(res);
    expect(data["kind"]).not.toBe("refusal");
    // review key must be present.
    expect(data).toHaveProperty("review");
    const review = data["review"] as Record<string, unknown>;
    // review must have the four required keys.
    expect(review).toHaveProperty("touched");
    expect(review).toHaveProperty("possibleMissingSurfaces");
    expect(review).toHaveProperty("confidence");
    expect(review).toHaveProperty("compactDiff");
    // touched must be an array.
    expect(Array.isArray(review["touched"])).toBe(true);
    // confidence must be a number in [0, 1].
    expect(typeof review["confidence"]).toBe("number");
    expect(review["confidence"] as number).toBeGreaterThanOrEqual(0);
    expect(review["confidence"] as number).toBeLessThanOrEqual(1);
  }, 30000);

  it("response JSON contains no forbidden envelope keys", async () => {
    const wsDir = mkDir("env-clean");
    writeFile(wsDir, "target.ts", "export const X = 1;\n");

    const srv = startServer({ cwd: wsDir, args: [wsDir, "--allow-write"] });
    servers.push(srv);
    await srv.initialize();

    const res = await srv.rpc(2, "tools/call", {
      name: "edit_file",
      arguments: {
        path: "target.ts",
        search: "X = 1",
        replace: "X = 2",
        review: true,
      },
    });

    const serialized = JSON.stringify(res.result);
    assertNoForbiddenKeys(serialized);
  }, 30000);

  it("review.touched entries have a surface field that is one of the 8 ImpactSurface values", async () => {
    const wsDir = mkDir("surface-check");
    // Place in a /service/ dir so classifySurface → "api"
    writeFile(wsDir, "src/service/orderService.ts", "export function getOrder() { return null; }\n");

    const srv = startServer({ cwd: wsDir, args: [wsDir, "--allow-write"] });
    servers.push(srv);
    await srv.initialize();

    const res = await srv.rpc(2, "tools/call", {
      name: "edit_file",
      arguments: {
        path: "src/service/orderService.ts",
        search: "return null",
        replace: "return {}",
        review: true,
      },
    });

    const data = parseEditResult(res);
    expect(data["kind"]).not.toBe("refusal");
    const review = data["review"] as Record<string, unknown>;
    const touched = review["touched"] as Array<Record<string, unknown>>;
    expect(touched.length).toBeGreaterThan(0);
    for (const t of touched) {
      expect(typeof t["path"]).toBe("string");
      expect(VALID_SURFACES.has(String(t["surface"]))).toBe(true);
    }
    // /service/ path should classify as "api".
    const editedEntry = touched.find((t) => String(t["path"]).includes("orderService"));
    expect(editedEntry).toBeDefined();
    expect(editedEntry!["surface"]).toBe("api");
  }, 30000);
});
