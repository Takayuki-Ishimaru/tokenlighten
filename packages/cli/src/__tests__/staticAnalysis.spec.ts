/**
 * staticAnalysis.spec.ts — regressions for MCP handshake reply handling
 * (mcpHandshake.ts) and stopMcp PID-file preservation (process.ts).
 *
 * Covers: JSON-RPC error replies resolve ok:false at the right stage; noise /
 * null / primitive / no-result / unexpected-id / out-of-order replies can
 * neither crash nor report success; stdin async errors and early child exit
 * resolve promptly; stopMcp keeps PID metadata for a surviving process and for
 * a replacement instance written while it waits.
 *
 * Output policy: plain data — no meta envelope.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import { runMcpHandshake } from "../mcpHandshake.js";
import { writePidFile, stopMcp, type PidFileData } from "../process.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmpDir(): string {
  const dir = join(tmpdir(), `tl-static-${randomBytes(6).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

/** Spawn a node child running `body` (a tiny fake MCP server) for a handshake. */
async function handshakeWith(body: string, timeoutMs = 4000) {
  const dir = tmpDir();
  const script = join(dir, "fake-server.mjs");
  writeFileSync(script, body);
  try {
    const started = Date.now();
    const result = await runMcpHandshake({
      command: process.execPath,
      args: [script],
      timeoutMs,
    });
    return { result, elapsedMs: Date.now() - started };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const KEEP_ALIVE = "setTimeout(() => {}, 5000);\n";
const OUT = 'const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");\n';
const INIT_OK = `${OUT}out({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05", serverInfo: { name: "srv", version: "1" } } });\n`;

describe("runMcpHandshake — JSON-RPC error replies", () => {
  it("resolves ok:false at stage 'initialize' when initialize replies an error", async () => {
    const { result, elapsedMs } = await handshakeWith(
      `${OUT}out({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "initialize failed" } });`
      + `${OUT.replace("const out", "const out2")}`
      + `out2({ jsonrpc: "2.0", id: 2, error: { code: -32603, message: "tools/list failed" } });\n`
      + KEEP_ALIVE,
    );
    expect(result.ok).toBe(false);
    expect(result.stage).toBe("initialize");
    expect(result.error).toContain("initialize failed");
    expect(elapsedMs).toBeLessThan(3000);
  });

  it("resolves ok:false at stage 'tools/list' when only tools/list replies an error", async () => {
    const { result, elapsedMs } = await handshakeWith(
      INIT_OK
      + `process.stdin.resume();\n`
      + `process.stdin.on("data", () => out({ jsonrpc: "2.0", id: 2, error: { code: -32603, message: "tools/list failed" } }));\n`
      + KEEP_ALIVE,
    );
    expect(result.ok).toBe(false);
    expect(result.stage).toBe("tools/list");
    expect(result.error).toContain("tools/list failed");
    expect(elapsedMs).toBeLessThan(3000);
  });
});

describe("runMcpHandshake — malformed and out-of-order replies", () => {
  it("ignores noise, null, primitives, no-result and foreign ids, then succeeds", async () => {
    const { result } = await handshakeWith(
      OUT
      + `process.stdin.resume();\n`
      + `let printed = false;\n`
      + `process.stdin.on("data", () => {\n`
      + `  if (printed) return; printed = true;\n`
      + `    process.stdout.write("not json at all\\n");\n`
      + `    out(null); out(42); out("plain string"); out([]);\n`
      + `    out({ jsonrpc: "2.0", id: 1 });\n`
      + `    out({ id: 1, result: { protocolVersion: "noise" } });\n`
      + `    out({ jsonrpc: "2.0", id: 99, result: { tools: [] } });\n`
      + `    out({ jsonrpc: "2.0", id: 1, result: {} });\n`
      + `    out({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05" } });\n`
      + `    out({ jsonrpc: "2.0", id: 2, result: { tools: [null] } });\n`
      + `    out({ jsonrpc: "2.0", id: 2, result: { tools: [{name: "valid"}] } });\n`
      + `});\n`
      + KEEP_ALIVE,
    );
    expect(result.ok).toBe(true);
    expect(result.stage).toBe("complete");
    expect(result.tools).toEqual(["valid"]);
  });

  it("does not report success for a tools/list result that arrives before initialize", async () => {
    const { result, elapsedMs } = await handshakeWith(
      `${OUT}out({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "a" }] } }); process.exit(0);\n`
    );
    expect(result.ok).toBe(false);
    expect(result.stage).toMatch(/initialize/);
    expect(elapsedMs).toBeLessThan(3000);
  });

  it("ignores replies after an error has already settled the handshake", async () => {
    const { result } = await handshakeWith(
      `${OUT}out({jsonrpc: "2.0", id: 1, error: {message: "failed"}});\n`
      + `out({jsonrpc: "2.0", id: 1, result: {protocolVersion: "2024-11-05", serverInfo: {name: "late"}}});\n`
      + `out({jsonrpc: "2.0", id: 2, result: {tools: [{name: "late"}]}});\n`
      + KEEP_ALIVE,
    );
    expect(result.ok).toBe(false);
    expect(result.serverInfo).toBeUndefined();
    expect(result.tools).toBeUndefined();
  });

  it("rejects output with matching ids that is not JSON-RPC", async () => {
    const { result } = await handshakeWith(
      `${OUT}out({id: 1, result: {protocolVersion: "noise"}});\n`
      + `out({id: 2, result: {tools: []}}); process.exit(0);\n`,
    );
    expect(result.ok).toBe(false);
  });

  it("treats an empty tools array as a valid success", async () => {
    const { result } = await handshakeWith(
      INIT_OK
      + `process.stdin.resume();\n`
      + `process.stdin.on("data", () => out({ jsonrpc: "2.0", id: 2, result: { tools: [] } }));\n`
      + KEEP_ALIVE,
    );
    expect(result.ok).toBe(true);
    expect(result.stage).toBe("complete");
    expect(result.tools).toEqual([]);
    expect(result.serverInfo?.name).toBe("srv");
  });
});

describe("runMcpHandshake — early exit, stdin errors, timeout", () => {
  it("resolves a failure promptly when the child exits without replying", async () => {
    const { result, elapsedMs } = await handshakeWith("process.exit(3);\n");
    expect(result.ok).toBe(false);
    expect(result.stage).toMatch(/initialize/);
    expect(elapsedMs).toBeLessThan(3000);
  });

  it("resolves a failure promptly when the child dies before tools/list is written", async () => {
    const { result, elapsedMs } = await handshakeWith(`${INIT_OK}process.exit(0);\n`);
    expect(result.ok).toBe(false);
    expect(result.stage).toMatch(/tools\/list/);
    expect(elapsedMs).toBeLessThan(3000);
  });

  it("keeps the timeout bound for a silent child", async () => {
    const { result, elapsedMs } = await handshakeWith("setTimeout(() => {}, 30000);\n", 1200);
    expect(result.ok).toBe(false);
    expect(result.stage).toBe("timeout-during-initialize");
    expect(elapsedMs).toBeGreaterThanOrEqual(1100);
    expect(elapsedMs).toBeLessThan(4000);
  });

  it("resolves a failure for a spawn that cannot start", async () => {
    const result = await runMcpHandshake({
      command: join(tmpdir(), `tl-no-such-bin-${randomBytes(4).toString("hex")}`),
      args: [],
      timeoutMs: 4000,
    });
    expect(result.ok).toBe(false);
    expect(result.stage).toBe("process-error");
  });
});

// These signal mocks cover POSIX; Windows uses taskkill instead.
describe.skipIf(process.platform === "win32")("stopMcp — PID file preservation", () => {
  const base: PidFileData = {
    pid: 99991,
    started_at_unix: 1700000000,
    command: "node bin.js",
    instance_id: "a".repeat(32),
    identity_token: "bin.js",
  };

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function killMock(plan: { aliveChecksBeforeDeath: number; survivesKill?: boolean }) {
    let aliveChecks = 0;
    let killed = false;
    return vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      if (signal === 0) {
        aliveChecks++;
        const dead = plan.survivesKill ? false : aliveChecks > plan.aliveChecksBeforeDeath && killed;
        if (dead) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
        return true;
      }
      if (signal === "SIGKILL") killed = true;
      return true;
    });
  }

  it("keeps the PID file when the process survives SIGKILL", async () => {
    const dir = tmpDir();
    const pidPath = join(dir, "mcp.pid");
    writePidFile(pidPath, base);
    killMock({ aliveChecksBeforeDeath: Number.MAX_SAFE_INTEGER, survivesKill: true });

    await expect(Promise.all([
      stopMcp(pidPath, base.pid, { verifyIdentity: () => true }),
      vi.runAllTimersAsync(),
    ])).rejects.toThrow(/still alive after SIGKILL/);
    expect(existsSync(pidPath)).toBe(true);
    expect(readFileSync(pidPath, "utf-8")).toBe(JSON.stringify(base));
    rmSync(dir, { recursive: true, force: true });
  });

  it("removes the PID file once the original process is gone", async () => {
    const dir = tmpDir();
    const pidPath = join(dir, "mcp.pid");
    writePidFile(pidPath, base);
    killMock({ aliveChecksBeforeDeath: 2 });

    await Promise.all([stopMcp(pidPath, base.pid, { verifyIdentity: () => true }), vi.runAllTimersAsync()]);
    expect(existsSync(pidPath)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("preserves a replacement instance written while waiting for the old process to die", async () => {
    const dir = tmpDir();
    const pidPath = join(dir, "mcp.pid");
    writePidFile(pidPath, base);
    const replacement: PidFileData = { ...base, started_at_unix: 1700000001, instance_id: "b".repeat(32) };
    let checks = 0;
    vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      if (signal === 0) {
        checks++;
        if (checks > 2) {
          if (checks === 3) writePidFile(pidPath, replacement);
          throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
        }
        return true;
      }
      return true;
    });

    await Promise.all([stopMcp(pidPath, base.pid, { verifyIdentity: () => true }), vi.runAllTimersAsync()]);
    expect(existsSync(pidPath)).toBe(true);
    expect(JSON.parse(readFileSync(pidPath, "utf-8"))).toEqual(replacement);
    rmSync(dir, { recursive: true, force: true });
  });

  it("preserves a same-PID replacement (changed instance_id / started_at / token)", async () => {
    const dir = tmpDir();
    const pidPath = join(dir, "mcp.pid");
    writePidFile(pidPath, base);
    const replacement: PidFileData = { ...base, identity_token: "other-bin.js" };
    let killed = false;
    let checks = 0;
    let wrote = false;
    vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      if (signal === 0) {
        checks++;
        if (killed) {
          if (!wrote) { wrote = true; writePidFile(pidPath, replacement); }
          throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
        }
        return true;
      }
      if (signal === "SIGKILL") killed = true;
      return true;
    });

    await Promise.all([stopMcp(pidPath, base.pid, { verifyIdentity: () => true }), vi.runAllTimersAsync()]);
    expect(existsSync(pidPath)).toBe(true);
    expect(JSON.parse(readFileSync(pidPath, "utf-8"))).toEqual(replacement);
    rmSync(dir, { recursive: true, force: true });
  });
});
