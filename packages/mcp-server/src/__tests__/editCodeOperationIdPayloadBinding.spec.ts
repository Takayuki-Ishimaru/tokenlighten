// editCodeOperationIdPayloadBinding.spec.ts — FX-M1/B1 + FX-M1/B2.
//
// `runEditWithOperationId` (server.ts) used to key its idempotent-replay
// dedup table by `operation_id` ALONE (per workspace):
//
//   B1 (payload-blind replay): a SECOND, genuinely different `edits[]`
//   payload sent under a REUSED `operation_id` was silently swallowed — the
//   server replayed the FIRST call's recorded outcome and reported
//   `edit.applied`/`replayed:true` for it, while the second call's own edit
//   never touched disk and the caller had no signal its distinct write
//   request was dropped.
//
//   B2 (cross-lane collision): the dedup key had no `lane` component at all,
//   so two independent lanes (AGENTS.md: "Shared workspace: every agent
//   passes its fixed `lane`") that happened to choose the SAME
//   caller-picked `operation_id` string collided on one dedup row —
//   lane B's edit silently replayed lane A's outcome instead of applying.
//
// The fix binds the recorded outcome to a canonical request-payload digest
// (`stableStringify({edits, artifact, cwd, lane})`) checked on every lookup
// hit, and folds the lane into both the legacy and v2 dedup keys via the
// same `laneScopedKey` mechanism `packServeLog.ts`/`priorPackStore.ts`
// already use (byte-identical to before for the lane-less/default session).
//
// Verified by temporarily reverting the server.ts fix and re-running this
// file: both the "different payload" and "different lane" cases replayed
// the WRONG outcome and reported the FIRST file's `applied` entry while
// silently dropping the second file's write — every "not replayed" /
// "second file changed" assertion below failed before the fix.
//
// Spawned-stdio harness (real disk write proof needed for `--allow-write`),
// mirroring `operationReplayCompatibility.spec.ts`'s own precedent.

import { afterAll, afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type Body = Record<string, unknown>;

const nodeRequire = createRequire(import.meta.url);
const TSX_CLI = nodeRequire.resolve("tsx/cli");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN_TS = path.resolve(HERE, "..", "bin.ts");
const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();

const workspaces: string[] = [];
const spawnedServers: ServerHandle[] = [];

afterEach(() => {
  for (const workspace of workspaces.splice(0)) {
    try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

afterAll(() => {
  for (const s of spawnedServers.splice(0)) s.kill();
});

interface ServerHandle {
  initialize(): Promise<void>;
  call(name: string, args: Body): Promise<Body>;
  kill(): void;
}

function startWriteServer(cwd: string): ServerHandle {
  const child: ChildProcess = spawn(
    process.execPath,
    [TSX_CLI, BIN_TS, cwd, "--allow-write"],
    { cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env } },
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
        reject(new Error(`rpc '${method}' timed out.\n--- stderr ---\n${stderr}`));
      }, timeoutMs);
      waiters.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      send({ jsonrpc: "2.0", id, method, params });
    });
  }

  let nextId = 100;
  async function callFn(name: string, args: Body): Promise<Body> {
    const res = await rpc(nextId++, "tools/call", { name, arguments: args });
    const text: string = res?.result?.content?.[0]?.text;
    expect(typeof text, `no text content: ${JSON.stringify(res)}`).toBe("string");
    return JSON.parse(text) as Body;
  }

  async function initialize(): Promise<void> {
    await rpc(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "vitest-fxm1-opid-binding", version: "0" },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  function kill(): void { try { child.kill("SIGKILL"); } catch { /* ok */ } }

  return { initialize, call: callFn, kill };
}

function mkWorkspace(tag: string): string {
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(HOME, `.tl-opid-binding-${tag}-`)));
  workspaces.push(workspace);
  return workspace;
}

function writeFile(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

describe("FX-M1/B1: operation_id replay is bound to the request payload", () => {
  it("a SAME operation_id + SAME edit payload still replays (existing behavior preserved)", async () => {
    const workspace = mkWorkspace("b1-same-payload");
    writeFile(workspace, "src/a.ts", "export const A = 1;\n");

    const srv = startWriteServer(workspace);
    spawnedServers.push(srv);
    await srv.initialize();

    const edits = [{ path: "src/a.ts", search: "A = 1", replace: "A = 999" }];
    const first = await srv.call("edit_file", { cwd: workspace, operation_id: "SAME-PAYLOAD", edits });
    expect(first["kind"], JSON.stringify(first)).toBe("edit.applied");
    expect(fs.readFileSync(path.join(workspace, "src/a.ts"), "utf8")).toBe("export const A = 999;\n");

    const second = await srv.call("edit_file", { cwd: workspace, operation_id: "SAME-PAYLOAD", edits });
    expect(second["kind"], JSON.stringify(second)).toBe("edit.applied");
    expect(second["replayed"]).toBe(true);
    // No double apply — file is untouched by a second real write.
    expect(fs.readFileSync(path.join(workspace, "src/a.ts"), "utf8")).toBe("export const A = 999;\n");
  }, 45000);

  it("a REUSED operation_id with a DIFFERENT edit payload refuses instead of replaying the first outcome", async () => {
    const workspace = mkWorkspace("b1-diff-payload");
    writeFile(workspace, "src/a.ts", "export const A = 1;\n");
    writeFile(workspace, "src/b.ts", "export const B = 1;\n");

    const srv = startWriteServer(workspace);
    spawnedServers.push(srv);
    await srv.initialize();

    const first = await srv.call("edit_file", {
      cwd: workspace, operation_id: "SHARED-KEY",
      edits: [{ path: "src/a.ts", search: "A = 1", replace: "A = 999" }],
    });
    expect(first["kind"], JSON.stringify(first)).toBe("edit.applied");
    expect(fs.readFileSync(path.join(workspace, "src/a.ts"), "utf8")).toBe("export const A = 999;\n");

    // A completely different file and content, same reused key.
    const second = await srv.call("edit_file", {
      cwd: workspace, operation_id: "SHARED-KEY",
      edits: [{ path: "src/b.ts", search: "B = 1", replace: "B = 777" }],
    });

    // Must NOT silently replay call 1's outcome as if it applied call 2.
    expect(second["kind"], JSON.stringify(second)).not.toBe("edit.applied");
    expect(second["replayed"]).not.toBe(true);
    // A named, recoverable refusal — the existing operation_id refusal shape.
    expect(second["field"]).toBe("operation_id");
    expect(second["retry"], JSON.stringify(second)).toBe("call");

    // Nothing from call 2 landed; call 1's file is untouched by this refusal.
    expect(fs.readFileSync(path.join(workspace, "src/b.ts"), "utf8")).toBe("export const B = 1;\n");
    expect(fs.readFileSync(path.join(workspace, "src/a.ts"), "utf8")).toBe("export const A = 999;\n");

    // The original operation is still intact and independently replayable
    // by re-issuing the EXACT original call.
    const replayOriginal = await srv.call("edit_file", {
      cwd: workspace, operation_id: "SHARED-KEY",
      edits: [{ path: "src/a.ts", search: "A = 1", replace: "A = 999" }],
    });
    expect(replayOriginal["kind"], JSON.stringify(replayOriginal)).toBe("edit.applied");
    expect(replayOriginal["replayed"]).toBe(true);
  }, 45000);
});

describe("FX-M1/B2: operation_id dedup is lane-scoped", () => {
  it("two lanes reusing the SAME operation_id with DIFFERENT edits both apply independently", async () => {
    const workspace = mkWorkspace("b2-lane-independent");
    writeFile(workspace, "src/a.ts", "export const A = 1;\n");
    writeFile(workspace, "src/b.ts", "export const B = 1;\n");

    const srv = startWriteServer(workspace);
    spawnedServers.push(srv);
    await srv.initialize();

    const laneA = await srv.call("edit_file", {
      cwd: workspace, lane: "agent-1", operation_id: "SHARED-OPID",
      edits: [{ path: "src/a.ts", search: "A = 1", replace: "A = 999" }],
    });
    expect(laneA["kind"], JSON.stringify(laneA)).toBe("edit.applied");
    expect(laneA["replayed"]).not.toBe(true);

    const laneB = await srv.call("edit_file", {
      cwd: workspace, lane: "agent-2", operation_id: "SHARED-OPID",
      edits: [{ path: "src/b.ts", search: "B = 1", replace: "B = 777" }],
    });
    // Lane B's call must apply its OWN edit — not silently replay lane A's.
    expect(laneB["kind"], JSON.stringify(laneB)).toBe("edit.applied");
    expect(laneB["replayed"]).not.toBe(true);

    expect(fs.readFileSync(path.join(workspace, "src/a.ts"), "utf8")).toBe("export const A = 999;\n");
    expect(fs.readFileSync(path.join(workspace, "src/b.ts"), "utf8")).toBe("export const B = 777;\n");
  }, 45000);

  it("each lane still independently replays its OWN operation_id + payload", async () => {
    const workspace = mkWorkspace("b2-lane-own-replay");
    writeFile(workspace, "src/a.ts", "export const A = 1;\n");
    writeFile(workspace, "src/b.ts", "export const B = 1;\n");

    const srv = startWriteServer(workspace);
    spawnedServers.push(srv);
    await srv.initialize();

    const editsA = [{ path: "src/a.ts", search: "A = 1", replace: "A = 42" }];
    const editsB = [{ path: "src/b.ts", search: "B = 1", replace: "B = 42" }];

    await srv.call("edit_file", { cwd: workspace, lane: "agent-1", operation_id: "OP", edits: editsA });
    await srv.call("edit_file", { cwd: workspace, lane: "agent-2", operation_id: "OP", edits: editsB });

    const replayA = await srv.call("edit_file", { cwd: workspace, lane: "agent-1", operation_id: "OP", edits: editsA });
    expect(replayA["kind"], JSON.stringify(replayA)).toBe("edit.applied");
    expect(replayA["replayed"]).toBe(true);

    const replayB = await srv.call("edit_file", { cwd: workspace, lane: "agent-2", operation_id: "OP", edits: editsB });
    expect(replayB["kind"], JSON.stringify(replayB)).toBe("edit.applied");
    expect(replayB["replayed"]).toBe(true);

    // Exactly one apply each — no cross-lane double-apply or corruption.
    expect(fs.readFileSync(path.join(workspace, "src/a.ts"), "utf8")).toBe("export const A = 42;\n");
    expect(fs.readFileSync(path.join(workspace, "src/b.ts"), "utf8")).toBe("export const B = 42;\n");
  }, 45000);
});
