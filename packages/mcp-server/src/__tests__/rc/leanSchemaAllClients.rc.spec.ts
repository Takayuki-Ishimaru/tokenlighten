/**
 * leanSchemaAllClients.rc.spec.ts — V15-LTS (2026-09-29).
 *
 * Spawned-server proof that `leanSchemaForEveryClient`'s diet
 * (leanSchemaAllClients.spec.ts, pure/in-process) is advertising-only.
 *
 * capabilityReachability.spec.ts's own NEGATIVE_CASES matrix proves that
 * exactly THREE of its 14 shapes become schema-VALID once the advertised
 * top-level oneOf/anyOf is shed (`read.no-branch`, a bare `{lane:"x"}`;
 * `edit.neither-edits-nor-artifact`, a bare `{operation_id}`;
 * `search.find-without-queries`, a bare `{action:"find"}`) — the ELEVEN
 * other negative cases stay invalid because `additionalProperties:false`
 * (unaffected by this diet) still catches them. This file is the live
 * proof for those three: `dispatchTool` never reads `leanSchemaEnabled()`
 * at all (verified by a repo-wide grep at the time this file was written —
 * see leanSchemaAllClients.spec.ts's own header comment), so the REAL
 * server must still refuse all three, byte-for-byte identically to the
 * un-leaned baseline, regardless of what `tools/list` now advertises.
 *
 * Modeled on rc/leanVsCodeCalls.rc.spec.ts's harness (spawn/rpc/
 * killServerGroup); that file's own "never narrows what dispatchTool
 * accepts" describe block proves the mirror-image claim for TL_LEAN_CALLS
 * (a leaned-away property is still SERVED). This file proves the opposite
 * direction for TL_LEAN_SCHEMA: a shape the advertised schema no longer
 * REJECTS is still REFUSED for real — "the server enforces every one of
 * these constraints at dispatch regardless of what is advertised"
 * (leanSchemaEnabled's own doc block, util/flags.ts).
 *
 * v0.15.0 (2026-09-30): TL_LEAN_SCHEMA is DEFAULT ON (the 3-real-client gate
 * passed), so the "un-leaned baseline" server below is the explicit rollback
 * (`TL_LEAN_SCHEMA=0`, the full pre-v0.15.0 schema) and the "leaned" server is
 * the shipped default (env unset) -- the claim is unchanged, each side just
 * names what it is. The same two servers also prove, over the REAL wire
 * (`tools/list` through bin.ts and the transport), that the default really is
 * the lean schema and `TL_LEAN_SCHEMA=0` really is the full one.
 */

import { afterAll, afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { killServerGroup } from "../helpers/killServerGroup.js";

const nodeRequire = createRequire(import.meta.url);
const TSX_CLI = nodeRequire.resolve("tsx/cli");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN_TS = path.resolve(HERE, "..", "..", "bin.ts");
const SPAWN_TIMEOUT_MS = 90_000;

function scopeWorkspace(): string {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tl-lean-schema-")));
  fs.writeFileSync(path.join(ws, "package.json"), '{"name":"lean-schema-rc"}\n');
  fs.writeFileSync(path.join(ws, "a.ts"), "export const a = 1;\n");
  return ws;
}

interface ServerHandle {
  initialize(clientName: string): Promise<void>;
  rpc(id: number, method: string, params?: unknown, timeoutMs?: number): Promise<any>;
  kill(): void;
  alive(): boolean;
}

const tmpDirs: string[] = [];
const spawnedServers: ServerHandle[] = [];

// --allow-write (an extra positional CLI arg, same convention as
// v011FlagsOff.rc.spec.ts) so the tl_edit_file case below exercises the REAL
// "neither edits nor artifact" validation rather than the unrelated
// write-tools-disabled gate, which would otherwise fire first and mask it.
function startServer(ws: string, env: Record<string, string>): ServerHandle {
  const child: ChildProcess = spawn(process.execPath, [TSX_CLI, "--liftoff-only", BIN_TS, ws, "--allow-write"], {
    cwd: ws,
    stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32",
    env: { ...process.env, ...env },
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

  async function initialize(clientName: string): Promise<void> {
    await rpc(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: clientName, version: "0" },
    });
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  }

  const handle: ServerHandle = {
    initialize,
    rpc,
    kill: () => { try { killServerGroup(child); } catch { /* ok */ } },
    alive: () => child.exitCode === null && child.signalCode === null,
  };
  spawnedServers.push(handle);
  return handle;
}

function bodyOf(rpcResult: any): Record<string, unknown> {
  const text = rpcResult?.result?.content?.[0]?.text;
  expect(typeof text, `expected text content, got: ${JSON.stringify(rpcResult)}`).toBe("string");
  return JSON.parse(text);
}

afterEach(() => {
  for (const s of spawnedServers.splice(0)) s.kill();
});

afterAll(() => {
  for (const s of spawnedServers.splice(0)) s.kill();
  for (const d of tmpDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ok */ }
  }
});

// The exact three capabilityReachability.spec.ts NEGATIVE_CASES that flip
// from schema-invalid to schema-valid once TL_LEAN_SCHEMA sheds top-level
// oneOf/anyOf — reproduced verbatim (ids and args) rather than imported, so
// this file's intent reads standalone; capabilityReachability.spec.ts's own
// negative-matrix test is the source of truth for WHICH ids these are.
const FLIPPED_NEGATIVE_SHAPES: ReadonlyArray<{ id: string; tool: string; args: Record<string, unknown> }> = [
  { id: "read.no-branch", tool: "tl_read_file", args: { lane: "x" } },
  { id: "edit.neither-edits-nor-artifact", tool: "tl_edit_file", args: { operation_id: "op-1" } },
  { id: "search.find-without-queries", tool: "tl_search_files", args: { action: "find" } },
];

describe("V15-LTS — leanSchemaForEveryClient never widens what dispatchTool actually accepts", () => {
  it("the three shapes the advertised schema stops rejecting once oneOf/anyOf is shed are still refused, byte-for-byte identically to the un-leaned baseline", async () => {
    const wsBaseline = scopeWorkspace();
    const wsLeaned = scopeWorkspace();
    tmpDirs.push(wsBaseline, wsLeaned);
    // Non-vscode client on both sides (this diet is not client-scoped, unlike
    // TL_LEAN_CALLS) — "claude-code" for the leaned side makes the point that
    // this is not a vscode-only proof. v0.15.0: the un-leaned baseline is the
    // explicit rollback; the leaned side is the shipped default (env unset).
    const baseline = startServer(wsBaseline, { TL_LEGACY_INPUT: "refuse", TL_LEAN_SCHEMA: "0" });
    const leaned = startServer(wsLeaned, { TL_LEGACY_INPUT: "refuse" });
    await baseline.initialize("claude-code");
    await leaned.initialize("claude-code");

    // The real wire agrees with the in-process schema: the default server
    // advertises the lean schema, `TL_LEAN_SCHEMA=0` the full pre-v0.15.0 one.
    type Listed = Array<{ name: string; inputSchema: Record<string, unknown> }>;
    const hasDependentRequired = (node: unknown): boolean => {
      if (node === null || typeof node !== "object") return false;
      if (Array.isArray(node)) return node.some(hasDependentRequired);
      const record = node as Record<string, unknown>;
      return "dependentRequired" in record || Object.values(record).some(hasDependentRequired);
    };
    const listedBaseline = (await baseline.rpc(2, "tools/list")).result.tools as Listed;
    const listedLeaned = (await leaned.rpc(2, "tools/list")).result.tools as Listed;
    for (const tool of listedBaseline) {
      expect(tool.inputSchema["oneOf"] !== undefined || tool.inputSchema["anyOf"] !== undefined, `baseline ${tool.name}`).toBe(true);
      expect(hasDependentRequired(tool.inputSchema), `baseline ${tool.name} dependentRequired`).toBe(true);
    }
    for (const tool of listedLeaned) {
      expect(tool.inputSchema["oneOf"], `default ${tool.name}.oneOf`).toBeUndefined();
      expect(tool.inputSchema["anyOf"], `default ${tool.name}.anyOf`).toBeUndefined();
      expect(hasDependentRequired(tool.inputSchema), `default ${tool.name} dependentRequired`).toBe(false);
    }
    expect(listedLeaned.map((t) => t.name).sort()).toEqual(listedBaseline.map((t) => t.name).sort());

    let rpcId = 3;
    for (const shape of FLIPPED_NEGATIVE_SHAPES) {
      const id = rpcId++;
      const baselineBody = bodyOf(await baseline.rpc(id, "tools/call", { name: shape.tool, arguments: shape.args }));
      const leanedBody = bodyOf(await leaned.rpc(id, "tools/call", { name: shape.tool, arguments: shape.args }));
      expect(baselineBody["kind"], `${shape.id} baseline`).toBe("refusal");
      expect(leanedBody, shape.id).toEqual(baselineBody);
    }
    expect(baseline.alive()).toBe(true);
    expect(leaned.alive()).toBe(true);
  }, SPAWN_TIMEOUT_MS);
});
