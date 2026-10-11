// smallTaskServer.ts — a spawned stdio MCP server for the small-task specs
// (smallTaskLightAnswerDifferential.spec.ts, smallTaskStartupWarmup.spec.ts).
//
// Same spawn shape as effFlags.spec.ts: tsx over src/bin.ts, its own process
// group (killServerGroup), every inherited TL_* variable stripped so a flag
// set in the test runner's own environment can never leak into an arm, and an
// isolated HOME so the trace channel (TL_TRACE) and any per-user state of one
// server are invisible to the other.

import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { killServerGroup } from "./killServerGroup.js";

const nodeRequire = createRequire(import.meta.url);
const TSX_CLI = nodeRequire.resolve("tsx/cli");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN_TS = path.resolve(HERE, "..", "..", "bin.ts");

export interface CallResult {
  readonly isError: boolean;
  readonly body: Record<string, unknown>;
  readonly text: string;
  readonly bytes: number;
  readonly ms: number;
}

export interface SmallTaskServer {
  readonly workspace: string;
  readonly home: string;
  readonly stderr: () => string;
  readonly stdoutNoise: () => string[];
  call(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<CallResult>;
  rpc(method: string, params?: unknown, timeoutMs?: number): Promise<Record<string, unknown>>;
  notify(method: string, params?: unknown): void;
  /** `light_answer_pack` trace events written so far (needs TL_TRACE=1 in the env). */
  lightAnswerEvents(): number;
  kill(): void;
}

/** A fresh workspace (realpath) holding `files`. */
export function makeSmallTaskWorkspace(prefix: string, files: Readonly<Record<string, string>>): string {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    fs.writeFileSync(path.join(ws, rel), content);
  }
  return ws;
}

export interface StartOptions {
  /** Extra environment for this server (TL_* names allowed; inherited TL_* are stripped). */
  readonly env?: Readonly<Record<string, string>>;
  /** Send `initialize` + `notifications/initialized` before returning (default true). */
  readonly handshake?: boolean;
}

export async function startSmallTaskServer(ws: string, options: StartOptions = {}): Promise<SmallTaskServer> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tl-small-home-"));
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("TL_")) env[key] = value;
  Object.assign(env, { HOME: home, USERPROFILE: home }, options.env ?? {});
  const child: ChildProcess = spawn(
    process.execPath,
    [TSX_CLI, "--liftoff-only", BIN_TS, ws],
    { cwd: ws, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", env },
  );
  let stdoutBuf = "";
  let stderr = "";
  const noise: string[] = [];
  const waiters = new Map<number, (msg: Record<string, unknown>) => void>();
  child.stdout!.on("data", (d: Buffer) => {
    stdoutBuf += d.toString();
    let nl: number;
    while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
      const line = stdoutBuf.slice(0, nl);
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(line) as Record<string, unknown>; } catch { noise.push(line); continue; }
      const id = msg["id"];
      if (typeof id === "number" && waiters.has(id)) {
        const w = waiters.get(id)!;
        waiters.delete(id);
        w(msg);
      } else if (msg["method"] !== "notifications/tools/list_changed") {
        noise.push(line);
      }
    }
  });
  child.stderr!.on("data", (d: Buffer) => { stderr += d.toString(); });
  let nextId = 1;
  const rpc = (method: string, params?: unknown, timeoutMs = 90000): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      waiters.delete(id);
      reject(new Error(`rpc '${method}' timed out after ${timeoutMs}ms.\n--- server stderr ---\n${stderr}`));
    }, timeoutMs);
    waiters.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  const notify = (method: string, params?: unknown): void => {
    child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) })}\n`);
  };
  if (options.handshake !== false) {
    await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "vitest", version: "0" } });
    notify("notifications/initialized");
  }
  const traceDir = path.join(home, ".tokenlighten", "trace");
  return {
    workspace: ws,
    home,
    stderr: () => stderr,
    stdoutNoise: () => [...noise],
    rpc,
    notify,
    async call(name, args, timeoutMs) {
      const started = performance.now();
      const msg = await rpc("tools/call", { name, arguments: args }, timeoutMs);
      const ms = performance.now() - started;
      const result = (msg["result"] ?? {}) as Record<string, unknown>;
      const content = (result["content"] as Array<Record<string, unknown>> | undefined) ?? [];
      const text = String(content[0]?.["text"] ?? "");
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(text) as Record<string, unknown>; } catch { /* plain-text error */ }
      return { isError: result["isError"] === true, body, text, bytes: Buffer.byteLength(text, "utf8"), ms };
    },
    lightAnswerEvents() {
      if (!fs.existsSync(traceDir)) return 0;
      let count = 0;
      for (const file of fs.readdirSync(traceDir)) {
        if (!file.endsWith(".jsonl")) continue;
        for (const line of fs.readFileSync(path.join(traceDir, file), "utf8").split("\n")) {
          if (line.includes("\"light_answer_pack\"")) count += 1;
        }
      }
      return count;
    },
    kill() {
      try { killServerGroup(child); } catch { /* already gone */ }
      try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
    },
  };
}
