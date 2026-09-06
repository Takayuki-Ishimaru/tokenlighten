// taskHandleEllipsisNearMiss.spec.ts — E1 (2026-09-05, measured on paid smoke
// r11 / SF13-estimator-telemetry-continuation-a_tl_sf_cheap3-r0): end-to-end,
// SPAWNED-SERVER regression for the exact incident. The solver held a live
// task handle and, after several calls, sent
//   read_file {targets:[{path:"…/vehicle_state.hpp"}], task:{handle:"tlh_task_v1_AQGWsSsvzBv-...Jp05WU"}}
// — a DISPLAY-ABBREVIATED copy of the live handle (some upstream rendering
// collapsed it to `prefix...suffix`), not the opaque token itself. Before
// this fix the reply was `handle-unknown` with `remaining:"no working set
// survives this call…"`, which is false — the lane's task was still live —
// and the solver's honest recovery (`task.epoch:"new"`) produced the
// byte-identical first pack, tripping the smoke harness's
// `same-next recurrence` gate.
//
// A real, spawned server process is used (not in-process `callTool`)
// because this is specifically a wire-shape regression: the fix must be
// visible over the actual MCP transport, in the same call shape production
// emitted.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

interface ServerHandle {
  initialize(): Promise<void>;
  rpc(id: number, method: string, params?: unknown, timeoutMs?: number): Promise<any>;
  kill(): void;
}

function startServer(opts: { cwd: string; args: string[]; env?: Record<string, string> }): ServerHandle {
  const child: ChildProcess = spawn(
    process.execPath,
    [TSX_CLI, BIN_TS, ...opts.args],
    { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...(opts.env ?? {}) } },
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
  function send(obj: unknown): void { child.stdin!.write(JSON.stringify(obj) + "\n"); }
  function rpc(id: number, method: string, params?: unknown, timeoutMs = 30000): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(new Error(`rpc '${method}' timed out\n--- stderr ---\n${stderr}`));
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
  function kill(): void { try { child.kill("SIGKILL"); } catch { /* ok */ } }
  return { initialize, rpc, kill };
}

function parseToolResult(rpcResult: any): Record<string, unknown> {
  const text = rpcResult?.result?.content?.[0]?.text;
  expect(typeof text, JSON.stringify(rpcResult)).toBe("string");
  return JSON.parse(String(text)) as Record<string, unknown>;
}

function writeFile(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

let cwd: string;
let srv: ServerHandle;
let rpcId = 100;
const nextId = (): number => (rpcId += 1);

async function call(name: string, args: Record<string, unknown>): Promise<any> {
  return srv.rpc(nextId(), "tools/call", { name, arguments: args });
}

/** Splits a live task handle into an r11-shaped `prefix<marker>suffix` abbreviation. */
function abbreviate(live: string, marker: string, prefixLen: number, suffixLen: number): string {
  return `${live.slice(0, prefixLen)}${marker}${live.slice(live.length - suffixLen)}`;
}

beforeAll(async () => {
  cwd = fs.mkdtempSync(path.join(HOME, ".tl-e1-ellipsis-"));
  fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
  writeFile(
    cwd,
    "src/vehicle_state.hpp",
    "#pragma once\nstruct VehicleState { double speed; double heading; };\n",
  );
  srv = startServer({ cwd, args: [cwd] });
  await srv.initialize();
}, 120000);

afterAll(() => {
  srv?.kill();
  if (cwd) { try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* ok */ } }
});

describe("E1 — a display-abbreviated task.handle recovers instead of dead-ending", () => {
  const LANE = "e1-ellipsis-spawn";

  async function mintLiveTaskHandle(query: string): Promise<string> {
    const opened = parseToolResult(
      await call("read_file", { query, cwd, lane: LANE, task: { epoch: "new" } }),
    );
    expect(opened["kind"], JSON.stringify(opened)).not.toBe("refusal");
    const task = opened["task"] as Record<string, unknown> | undefined;
    const live = task?.["id"];
    expect(typeof live, JSON.stringify(opened)).toBe("string");
    return live as string;
  }

  it("the measured r11 shape (24-char prefix + '...' + 5-char suffix) refuses with did_you_mean, not a dead end", async () => {
    const live = await mintLiveTaskHandle("Explain src/vehicle_state.hpp");
    const abbreviated = abbreviate(live, "...", 24, 5);

    const refused = parseToolResult(
      await call("read_file", {
        targets: [{ path: "src/vehicle_state.hpp" }],
        task: { handle: abbreviated },
        cwd,
        lane: LANE,
      }),
    );
    expect(refused["kind"], JSON.stringify(refused)).toBe("refusal");
    expect(refused["code"]).toBe("handle-unknown");
    expect(refused["field"]).toBe("task.handle");
    expect(refused["retry"]).toBe("call");
    expect(refused["did_you_mean"]).toBe(live);
    // The dead-end prose this fix removes for this shape.
    expect(JSON.stringify(refused)).not.toContain("no working set survives");
  });

  it("the unicode ellipsis '…' form resolves the same way", async () => {
    const live = await mintLiveTaskHandle("Explain src/vehicle_state.hpp once more");
    const abbreviated = abbreviate(live, "…", 24, 5);

    const refused = parseToolResult(
      await call("read_file", {
        targets: [{ path: "src/vehicle_state.hpp" }],
        task: { handle: abbreviated },
        cwd,
        lane: LANE,
      }),
    );
    expect(refused["kind"], JSON.stringify(refused)).toBe("refusal");
    expect(refused["code"]).toBe("handle-unknown");
    expect(refused["did_you_mean"]).toBe(live);
    expect(refused["retry"]).toBe("call");
  });

  it("a non-matching abbreviation (wrong suffix) stays a genuine new-task refusal, no did_you_mean", async () => {
    const live = await mintLiveTaskHandle("Explain src/vehicle_state.hpp yet again");
    const notAnAbbreviation = `${live.slice(0, 24)}...ZZZZZ`;

    const refused = parseToolResult(
      await call("read_file", {
        targets: [{ path: "src/vehicle_state.hpp" }],
        task: { handle: notAnAbbreviation },
        cwd,
        lane: LANE,
      }),
    );
    expect(refused["kind"], JSON.stringify(refused)).toBe("refusal");
    expect(refused["code"]).toBe("handle-unknown");
    expect(refused["did_you_mean"]).toBeUndefined();
    expect(refused["retry"]).toBe("new-task");
  });

  it("did_you_mean round-trips: re-issuing the exact same call with it succeeds", async () => {
    const live = await mintLiveTaskHandle("Explain src/vehicle_state.hpp a final time");
    const abbreviated = abbreviate(live, "...", 24, 5);

    const refused = parseToolResult(
      await call("read_file", {
        targets: [{ path: "src/vehicle_state.hpp" }],
        task: { handle: abbreviated },
        cwd,
        lane: LANE,
      }),
    );
    expect(refused["did_you_mean"]).toBe(live);

    const recovered = parseToolResult(
      await call("read_file", {
        targets: [{ path: "src/vehicle_state.hpp" }],
        task: { handle: refused["did_you_mean"] },
        cwd,
        lane: LANE,
      }),
    );
    expect(recovered["kind"], JSON.stringify(recovered)).not.toBe("refusal");
  });
});
