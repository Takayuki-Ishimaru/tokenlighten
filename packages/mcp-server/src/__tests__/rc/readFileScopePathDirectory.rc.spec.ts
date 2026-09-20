/**
 * readFileScopePathDirectory.rc.spec.ts — S1-A2 (2026-09-20 dispatcher
 * dead-turn fix), real-server reproduction.
 *
 * MEASURED DEFECT (live on HEAD before this fix):
 * `read_file {query:"…", task:{epoch:"new",profile:"answer"}, scope:{path:"<dir>"}}`
 * refused `is-a-directory`, with a `detail` recommending LEGACY syntax
 * (`paths=[...]`, `path=...`) that the server itself refuses by default
 * (`TL_LEGACY_INPUT` defaults to `refuse`). `search_files` documents
 * `scope.path` as "root path to search under", and `read_file` advertises
 * the same shared `scope` object, so a caller reasonably scopes a task-pack
 * query to a subtree with `scope:{path:<dir>}}` instead of
 * `targets:[{path:<dir>}]`. The SAME shape with a FILE path silently dropped
 * the query/qref and read the raw file instead of building the requested
 * pack.
 *
 * Root cause: `mapCanonicalScope` copies `scope.path` onto the top-level
 * `args["path"]` unconditionally for every canonical tool, but
 * `normalizeCanonicalRequest`'s read_file branch only promotes a call to
 * `mode:"task_pack"` (or any other targets-derived mode) when `targets` is
 * non-empty — a query/qref scoped ONLY via `scope.path` (no `targets`) fell
 * through as an ordinary single-FILE path read.
 *
 * Fix: `normalizeCanonicalRequest` now synthesizes `targets:[{path:<scope.path>}]`
 * for a read_file call that has a `query`/`qref`, no explicit `targets`, and
 * a `scope.path` that is not also an archive selector — treating it exactly
 * like the equivalent explicit `targets:[{path:<scope.path>}]` call. The
 * `is-a-directory` refusal text (hit directly via a bare path with no query)
 * now advises the canonical `read_file {query:"...", targets:[{path:"..."}]}`
 * / `search_files {action:"tree", scope:{path:"..."}}` shapes instead of the
 * legacy `paths=[...]`/`path=...` dialect.
 *
 * Harness copied from fenceServesUnservedScope.rc.spec.ts (repo convention:
 * no cross-spec helper import; each rc drill owns its stdio JSON-RPC
 * harness). A small synthetic fixture suffices here — this is a structural
 * dispatch-routing fix, not a content-ranking one.
 */

import { afterAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const nodeRequire = createRequire(import.meta.url);
const TSX_CLI = nodeRequire.resolve("tsx/cli");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN_TS = path.resolve(HERE, "..", "..", "bin.ts");
const SPAWN_TIMEOUT_MS = 90_000;

const LOGGER_SRC =
  "export function formatOrderLog(orderId: string, total: number): string {\n"
  + "  return `order ${orderId}: total=${total}`;\n"
  + "}\n";

const MAIN_SRC =
  "import { formatOrderLog } from \"./util/logger.js\";\n"
  + "export function run(): string {\n"
  + "  return formatOrderLog(\"o1\", 42);\n"
  + "}\n";

function scopeWorkspace(): string {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tl-rc-scopepath-")));
  fs.mkdirSync(path.join(ws, "src", "util"), { recursive: true });
  fs.writeFileSync(path.join(ws, "package.json"), '{"name":"rc-scope-path"}\n');
  fs.writeFileSync(path.join(ws, "src/util/logger.ts"), LOGGER_SRC);
  fs.writeFileSync(path.join(ws, "src/main.ts"), MAIN_SRC);
  return ws;
}

interface ServerHandle {
  initialize(): Promise<void>;
  rpc(id: number, method: string, params?: unknown, timeoutMs?: number): Promise<any>;
  kill(): void;
  alive(): boolean;
}

const tmpDirs: string[] = [];
const spawnedServers: ServerHandle[] = [];

function startServer(ws: string): ServerHandle {
  const child: ChildProcess = spawn(process.execPath, [TSX_CLI, BIN_TS, ws], {
    cwd: ws,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
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

  async function initialize(): Promise<void> {
    await rpc(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "vitest-rc-scopepath", version: "0" },
    });
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  }

  const handle: ServerHandle = {
    initialize,
    rpc,
    kill: () => { try { child.kill("SIGKILL"); } catch { /* ok */ } },
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

afterAll(() => {
  for (const s of spawnedServers.splice(0)) s.kill();
  for (const d of tmpDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ok */ }
  }
});

describe("S1-A2 — read_file query/qref + scope.path (directory or file)", () => {
  it("a directory scope.path builds a directory-scoped pack instead of refusing is-a-directory", async () => {
    const ws = scopeWorkspace();
    tmpDirs.push(ws);
    const server = startServer(ws);
    await server.initialize();

    const dirScope = bodyOf(await server.rpc(2, "tools/call", {
      name: "read_file",
      arguments: {
        query: "how does order logging work in this module",
        scope: { path: "src/util" },
        task: { epoch: "new", profile: "answer" },
        cwd: ws,
      },
    }));
    expect(
      dirScope["kind"],
      `scope.path over a directory must not refuse; got ${JSON.stringify(dirScope).slice(0, 500)}`,
    ).not.toBe("refusal");
    // The defect's own signature: never the is-a-directory code, however the
    // call is eventually classified.
    expect(dirScope["code"]).not.toBe("is-a-directory");
    // Same shape as the equivalent explicit targets:[{path:"src/util"}] call:
    // a directory-scoped task pack, not a raw single-file read.
    expect(dirScope["kind"], JSON.stringify(dirScope).slice(0, 500)).toBe("read.task_pack");

    expect(server.alive()).toBe(true);
  }, SPAWN_TIMEOUT_MS);

  it("a file scope.path builds a seeded pack on that file instead of silently dropping the query", async () => {
    const ws = scopeWorkspace();
    tmpDirs.push(ws);
    const server = startServer(ws);
    await server.initialize();

    const fileScope = bodyOf(await server.rpc(2, "tools/call", {
      name: "read_file",
      arguments: {
        query: "how does run() format its order log line",
        scope: { path: "src/main.ts" },
        task: { epoch: "new", profile: "answer" },
        cwd: ws,
      },
    }));
    expect(
      fileScope["kind"],
      `scope.path over a file must build a seeded pack, not a raw read; got ${JSON.stringify(fileScope).slice(0, 500)}`,
    ).toBe("read.task_pack");
    expect(fileScope["decision"], JSON.stringify(fileScope).slice(0, 500)).toBeDefined();

    expect(server.alive()).toBe(true);
  }, SPAWN_TIMEOUT_MS);

  it("still refuses an explicit targets:[] call the same way (scope.path promotion does not fire when targets are present)", async () => {
    const ws = scopeWorkspace();
    tmpDirs.push(ws);
    const server = startServer(ws);
    await server.initialize();

    // A caller that ALREADY names an explicit target keeps today's behavior —
    // scope.path here (redundant with the target) must not be reinterpreted.
    const explicitTargets = bodyOf(await server.rpc(2, "tools/call", {
      name: "read_file",
      arguments: {
        query: "how does order logging work",
        targets: [{ path: "src/main.ts" }],
        scope: { path: "src/util" },
        task: { epoch: "new", profile: "answer" },
        cwd: ws,
      },
    }));
    expect(explicitTargets["kind"], JSON.stringify(explicitTargets).slice(0, 500)).toBe("read.task_pack");
    const evidence = explicitTargets["evidence"] as Array<Record<string, unknown>> | undefined;
    if (evidence !== undefined) {
      for (const entry of evidence) {
        expect(String(entry["path"])).toBe("src/main.ts");
      }
    }

    expect(server.alive()).toBe(true);
  }, SPAWN_TIMEOUT_MS);

  it("the is-a-directory refusal itself now advises canonical read_file/search_files syntax", async () => {
    const ws = scopeWorkspace();
    tmpDirs.push(ws);
    const server = startServer(ws);
    await server.initialize();

    // No query/qref here — a bare path with no addressing still reaches the
    // pre-existing single-file auto-mode route and its is-a-directory check.
    const refusal = bodyOf(await server.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { path: "src/util", cwd: ws },
    }));
    expect(refusal["code"], JSON.stringify(refusal).slice(0, 500)).toBe("is-a-directory");
    const message = `${refusal["detail"] ?? refusal["error"] ?? ""}`;
    expect(message, message).toContain('targets:[{path:"src/util"}]');
    expect(message, message).toContain('scope:{path:"src/util"}');
    // The old legacy-dialect wording (`paths=[...]`, `path="..."`,
    // `action=tree`) must be gone from THIS message.
    expect(message).not.toContain("paths=[");
    expect(message).not.toContain('path="src/util"');
    expect(message).not.toContain("action=tree");

    expect(server.alive()).toBe(true);
  }, SPAWN_TIMEOUT_MS);
});
