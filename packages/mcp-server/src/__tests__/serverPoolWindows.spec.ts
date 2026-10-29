import { afterAll, describe, expect, it } from "vitest";
import { spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { closeServerPool, pooledSpawn } from "./helpers/serverPool.js";
import { killServerGroup } from "./helpers/killServerGroup.js";
import { rmDirWithRetry, waitForExit } from "./helpers/rmDirWithRetry.js";
import { TSX_NODE_ARGS } from "./helpers/tsxNode.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN_TS = path.resolve(HERE, "..", "bin.ts");
const WAIT_MS = 90_000;
const roots = new Set<string>();
const handles = new Set<Server>();
const poolPids = new Set<number>();

interface Server {
  readonly child: ChildProcess;
  initialize(clientName?: string): Promise<void>;
  call(id: number, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  closeLease(): Promise<void>;
  kill(): Promise<void>;
}

function workspace(tag: string, marker: string): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `tl-pool-${tag}-`)));
  roots.add(root);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "marker.ts"), `export const ROOT_MARKER = ${JSON.stringify(marker)};\n`);
  return root;
}

async function removeFixture(root: string): Promise<void> {
  await rmDirWithRetry(root);
  roots.delete(root);
  expect(fs.existsSync(root), `fixture workspace must be removable while expected idle: ${root}`).toBe(false);
}

function start(root: string, pool: boolean, rootArg = root): Server {
  const child = pooledSpawn(process.execPath, [...TSX_NODE_ARGS, BIN_TS, rootArg], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
    env: { ...process.env },
  }, { pool });
  if (pool && child.pid !== undefined) poolPids.add(child.pid);
  let stdout = "";
  let stderr = "";
  const waiters = new Map<number, { resolve(value: Record<string, unknown>): void; reject(error: Error): void; timer: NodeJS.Timeout }>();

  child.stdout!.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
    let nl: number;
    while ((nl = stdout.indexOf("\n")) >= 0) {
      const line = stdout.slice(0, nl).trim();
      stdout = stdout.slice(nl + 1);
      if (!line) continue;
      let message: Record<string, unknown>;
      try { message = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      const id = message["id"];
      if ((typeof id === "number" || typeof id === "string") && waiters.has(Number(id))) {
        const waiter = waiters.get(Number(id))!;
        waiters.delete(Number(id));
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    }
  });
  child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });

  function rpc(id: number, method: string, params?: unknown): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(new Error(`RPC ${method} timed out. stderr:\n${stderr}`));
      }, WAIT_MS);
      waiters.set(id, { resolve, reject, timer });
      child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })}\n`);
    });
  }

  const server: Server = {
    child,
    async initialize(clientName = "pool-regression") {
      await rpc(1, "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: clientName, version: "1" },
      });
      child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    },
    async call(id, name, args) {
      const response = await rpc(id, "tools/call", { name, arguments: args });
      const result = response["result"] as { content?: Array<{ text?: string }> } | undefined;
      const text = result?.content?.[0]?.text;
      if (typeof text !== "string") throw new Error(`expected tool text response; stderr:\n${stderr}`);
      return JSON.parse(text) as Record<string, unknown>;
    },
    async closeLease() {
      child.stdin!.end();
      await waitLeaseClose(child);
      handles.delete(server);
    },
    async kill() {
      killServerGroup(child);
      await waitForExit(child);
      handles.delete(server);
    },
  };
  handles.add(server);
  return server;
}

function waitLeaseClose(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server lease did not emit close after stdin EOF")), WAIT_MS);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code !== 0 || signal !== null) reject(new Error(`server lease closed as code=${code} signal=${signal}`));
      else resolve();
    });
  });
}

function toolBody(result: Record<string, unknown>): Record<string, unknown> {
  return result;
}

async function readMarker(server: Server, root: string, id: number): Promise<Record<string, unknown>> {
  return toolBody(await server.call(id, "tl_read_file", {
    query: "Read the root marker value.",
    targets: [{ path: "src/marker.ts" }],
    task: { epoch: "new" },
    cwd: root,
  }));
}

async function pidIsAlive(pid: number): Promise<boolean> {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitPidExit(pid: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (!(await pidIsAlive(pid))) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`pooled process ${pid} remained alive after closeServerPool()`);
}

async function closeAndWaitForPool(): Promise<void> {
  closeServerPool();
  for (const pid of poolPids) await waitPidExit(pid);
  poolPids.clear();
}

afterAll(async () => {
  for (const server of handles) await server.kill();
  await closeAndWaitForPool();
  for (const root of roots) {
    await rmDirWithRetry(root);
    expect(fs.existsSync(root), `fixture workspace cleanup failed: ${root}`).toBe(false);
  }
  roots.clear();
});

describe("server pool process reuse and session boundaries", () => {
  it("does not pool a standalone child that inherited the Vitest environment", () => {
    const root = workspace("inherited-vitest", "CHILD");
    const fakeBin = path.join(root, "src", "bin.ts");
    fs.writeFileSync(fakeBin, 'process.stdin.resume(); process.stdin.on("end", () => process.exit(0));\n');
    const program = `
      import { pooledSpawn, isPooledChild } from ${JSON.stringify(new URL("./helpers/serverPool.ts", import.meta.url).href)};
      const child = pooledSpawn(process.execPath, ${JSON.stringify([...TSX_NODE_ARGS, fakeBin, root])}, {
        cwd: ${JSON.stringify(root)}, stdio: "pipe", env: { ...process.env }
      });
      process.stdout.write(String(isPooledChild(child)) + "\\n");
      const closed = new Promise(resolve => child.once("close", resolve));
      child.stdin.end();
      await closed;
    `;
    const result = spawnSync(process.execPath, [...TSX_NODE_ARGS, "--input-type=module", "--eval", program], {
      cwd: root, encoding: "utf8", timeout: 15000, windowsHide: true,
      env: { ...process.env, VITEST: "true", TL_TEST_SERVER_POOL: undefined,
        HOME: root, USERPROFILE: root, NODE_OPTIONS: undefined,
        TOKENLIGHTEN_ENGINES_FILE: undefined, TOKENLIGHTEN_HTTP_PORT: undefined,
        TOKENLIGHTEN_PROTOCOL_ERA: "legacy" },
    });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("false");
  }, 20000);

  it("reuses one PID across distinct roots, clears prior handles, and serves only the new root", async () => {
    const rootA = workspace("isolation-a", "ALPHA");
    const rootB = workspace("isolation-b", "BRAVO");
    const first = start(rootA, true, ".");
    await first.initialize("first-client");
    const firstBody = await readMarker(first, rootA, 2);
    const firstTask = firstBody["task"] as { id?: string } | undefined;
    expect(firstTask?.id).toBeTruthy();
    const firstPid = first.child.pid;
    await first.closeLease();
    if (firstPid !== undefined) expect(await pidIsAlive(firstPid)).toBe(true);
    await removeFixture(rootA);

    const second = start(rootB, true, ".");
    await second.initialize("second-client");
    expect(second.child.pid).toBe(firstPid);
    const secondBody = await second.call(2, "tl_read_file", {
      query: "Continue the prior task by reading the root marker.",
      targets: [{ path: "src/marker.ts" }],
      task: { handle: firstTask!.id },
      cwd: rootB,
    });
    expect(secondBody["code"]).toBe("handle-workspace-mismatch");
    const freshTaskBody = await readMarker(second, rootB, 3);
    expect(JSON.stringify(freshTaskBody)).toContain("BRAVO");
    expect(JSON.stringify(freshTaskBody)).not.toContain("ALPHA");
    await second.closeLease();
  }, 120_000);

  it("does not pool a second launch for the same root or a supported filesystem alias", async () => {
    const root = workspace("same-root", "SAME");
    const first = start(root, true);
    await first.initialize();
    await readMarker(first, root, 2);
    const firstPid = first.child.pid;
    await first.closeLease();

    const restarted = start(root, true);
    await restarted.initialize("after-restart");
    expect(restarted.child.pid).not.toBe(firstPid);
    await readMarker(restarted, root, 2);
    await restarted.closeLease();
    closeServerPool();

    const alias = path.join(os.tmpdir(), `tl-pool-alias-${process.pid}-${Date.now()}`);
    try {
      fs.symlinkSync(root, alias, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform === "win32" && (code === "EPERM" || code === "EACCES" || code === "ENOTSUP")) return;
      throw error;
    }
    try {
      const realLaunch = start(root, true);
      await realLaunch.initialize("real-root");
      const realPid = realLaunch.child.pid;
      await realLaunch.closeLease();
      const aliasLaunch = start(alias, true);
      await aliasLaunch.initialize("symlink-alias");
      expect(aliasLaunch.child.pid).not.toBe(realPid);
      await aliasLaunch.closeLease();
    } finally {
      await rmDirWithRetry(alias);
      expect(fs.existsSync(alias), `filesystem alias cleanup failed: ${alias}`).toBe(false);
    }
  }, 120_000);

  it("stdin EOF emits the usual lease exit and close while keeping the pooled PID reusable", async () => {
    const rootA = workspace("eof-a", "EOF_A");
    const rootB = workspace("eof-b", "EOF_B");
    const first = start(rootA, true);
    await first.initialize();
    await readMarker(first, rootA, 2);
    const firstPid = first.child.pid;
    const events: string[] = [];
    first.child.on("exit", (code, signal) => events.push(`exit:${code}:${signal}`));
    first.child.on("close", (code, signal) => events.push(`close:${code}:${signal}`));
    await first.closeLease();
    expect(events).toEqual(["exit:0:null", "close:0:null"]);

    const second = start(rootB, true);
    expect(second.child.pid).toBe(firstPid);
    await second.initialize();
    expect(JSON.stringify(await readMarker(second, rootB, 2))).toContain("EOF_B");
    await second.closeLease();
  });

  it("closeServerPool exits idle real PIDs; reports paired fresh-root read timings without thresholds", async () => {
    async function measure(pool: boolean, label: string): Promise<{ elapsedMs: number; uniquePids: number }> {
      await closeAndWaitForPool();
      const pids = new Set<number>();
      const started = Date.now();
      for (let i = 0; i < 3; i++) {
        const root = workspace(`timing-${label}-${i}`, `${label}_${i}`);
        const server = start(root, pool);
        if (server.child.pid !== undefined) pids.add(server.child.pid);
        await server.initialize(`${label}-${i}`);
        const body = await readMarker(server, root, 2);
        expect(JSON.stringify(body)).toContain(`${label}_${i}`);
        await server.closeLease();
      }
      return { elapsedMs: Date.now() - started, uniquePids: pids.size };
    }

    const fresh = await measure(false, "fresh");
    const pooled = await measure(true, "pooled");
    expect(fresh.uniquePids).toBe(3);
    expect(pooled.uniquePids).toBe(1);
    process.stdout.write(`[serverPoolWindows] fresh=${JSON.stringify(fresh)} pooled=${JSON.stringify(pooled)}\n`);

    const probeRoot = workspace("close-pool", "CLOSE");
    const probe = start(probeRoot, true);
    await probe.initialize();
    await readMarker(probe, probeRoot, 2);
    const pid = probe.child.pid;
    await probe.closeLease();
    await closeAndWaitForPool();
    if (pid !== undefined) expect(await pidIsAlive(pid)).toBe(false);
  }, 120_000);
});
