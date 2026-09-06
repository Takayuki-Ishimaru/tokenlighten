/**
 * scopeHandlePrecondition.spec.ts — FX-P2 / INV-I-4.
 *
 * `precondition:"scope-handle"` required `entry.kind === "scope"`
 * (`write/preconditions.ts`), but no production code path ever mints a
 * `kind:"scope"` handle (INV-I's exhaustive grep over every
 * `handleTable.upsert(...)` call site and every literal `"scope"` outside
 * tests/cache) — so the advertised precondition
 * (`CANONICAL_EDIT_ITEM.precondition` enum, server.ts) refused
 * `scope-violation` unconditionally for every real handle a caller could
 * ever pass. The fix gives it real, general semantics: ANY handle kind this
 * session holds authorizes an edit whose target path (and, when the handle
 * is itself range-restricted, target line span) lies within it.
 *
 * These tests spawn a real `bin.ts <cwd> --allow-write` server and mint
 * handles through the ordinary public `read_file`/`edit_file` surface —
 * never anything internal-only — because that is exactly the gap INV-I-4
 * found: no PUBLIC path ever produced a handle the precondition would
 * accept.
 *
 * ====================== round-18A finding 5 (Low) =========================
 *
 * The fix above left one corner: `entry.paths ?? (entry.path ? [entry.path]
 * : [])` gives `paths.length === 0` for ANY path-less handle, and the
 * containment check below it treated that as "unrestricted" — `paths.length
 * === 0 || paths.some(...)` — regardless of `entry.kind`. The comment
 * justified this for a whole-repo `kind:"repo"` mint (legitimately path-less
 * by design, `readCodeOverview.ts`'s `handleTable.upsert({kind:"repo",
 * workspaceRoot, ...})` with no scope), but the CODE tested only the absence
 * of paths, not the kind — so a `kind:"scope"` handle (or any other
 * hand-built/rehydrated path-less entry) satisfied the precondition for
 * EVERY path in the workspace, the exact "unrestricted" outcome
 * `precondition:"scope-handle"` exists to prevent. FIXED: a path-less handle
 * whose `kind !== "repo"` now refuses `scope-violation` ("a scope must name a
 * path") instead of passing through.
 *
 * Two shapes below: a `kind:"repo"` handle is RESOLVABLE — path-less is its
 * genuine, documented meaning (whole workspace), reached through the same
 * public surface as every other case in this file (`read_file
 * {mode:"overview"}`, `readCodeOverview.ts:860`) — and still authorizes an
 * edit anywhere in the workspace after the fix. A `kind:"scope"` handle is
 * UNRESOLVABLE — the file's own header above already establishes that no
 * production surface ever mints one, so (uniquely in this file) that one case
 * mints it directly through the real, shared `handleTable` (`util/handles.ts`)
 * the production dispatcher itself uses, and calls the real
 * `enforcePreconditions` — the same function `edit_file` calls — rather than
 * going through a spawned server, which has no way to produce this shape.
 */

import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { handleTable } from "../util/handles.js";
import { enforcePreconditions } from "../write/preconditions.js";

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
  const dir = fs.mkdtempSync(path.join(HOME, `.tl-scopehandle-${tag}-`));
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
  const body = JSON.parse(text);
  if (typeof body["handle"] !== "string") {
    const evidence = Array.isArray(body["evidence"]) ? body["evidence"] : undefined;
    const fromEvidence = evidence?.[0]?.["handle"];
    if (typeof fromEvidence === "string") body["handle"] = fromEvidence;
  }
  return body;
}

describe("scopeHandlePrecondition — any handle kind, path containment", () => {
  it("a plain kind:file handle (from create:true) now authorizes an edit to the SAME path", async () => {
    const wsDir = mkDir("file-kind-inside");
    const srv = startServer({ cwd: wsDir, args: [wsDir, "--allow-write"] });
    servers.push(srv);
    await srv.initialize();

    const createRes = await srv.rpc(2, "tools/call", {
      name: "edit_file",
      arguments: { path: "src/a.ts", create: true, content: 'export const A = "old";\n' },
    });
    const createData = parseToolResult(createRes);
    expect(createData["kind"]).not.toBe("refusal");
    const scopeHandle = createData["handle"] as string;
    expect(typeof scopeHandle).toBe("string");

    const editRes = await srv.rpc(3, "tools/call", {
      name: "edit_file",
      arguments: {
        path: "src/a.ts",
        search: '"old"',
        replace: '"new"',
        precondition: "scope-handle",
        scopeHandle,
      },
    });
    const editData = parseToolResult(editRes);
    expect(editData["kind"]).not.toBe("refusal");
    expect(readFile(wsDir, "src/a.ts")).toContain('"new"');
  }, 30000);

  it("the same kind:file handle refuses out-of-scope (not scope-violation) for a DIFFERENT path", async () => {
    const wsDir = mkDir("file-kind-outside");
    const srv = startServer({ cwd: wsDir, args: [wsDir, "--allow-write"] });
    servers.push(srv);
    await srv.initialize();

    const createRes = await srv.rpc(2, "tools/call", {
      name: "edit_file",
      arguments: { path: "src/a.ts", create: true, content: 'export const A = "old";\n' },
    });
    const scopeHandle = parseToolResult(createRes)["handle"] as string;

    writeFile(wsDir, "src/b.ts", 'export const B = "old";\n');
    const editRes = await srv.rpc(3, "tools/call", {
      name: "edit_file",
      arguments: {
        path: "src/b.ts",
        search: '"old"',
        replace: '"new"',
        precondition: "scope-handle",
        scopeHandle,
      },
    });
    const editData = parseToolResult(editRes);
    expect(editData["kind"]).toBe("refusal");
    expect(editData["code"]).toBe("out-of-scope");
    expect(readFile(wsDir, "src/b.ts")).toBe('export const B = "old";\n');
  }, 30000);

  it("an unknown scopeHandle still refuses scope-violation (unchanged regression)", async () => {
    const wsDir = mkDir("unknown-regression");
    writeFile(wsDir, "src/a.ts", 'export const A = "old";\n');
    const srv = startServer({ cwd: wsDir, args: [wsDir, "--allow-write"] });
    servers.push(srv);
    await srv.initialize();

    const editRes = await srv.rpc(2, "tools/call", {
      name: "edit_file",
      arguments: {
        path: "src/a.ts",
        search: '"old"',
        replace: '"new"',
        precondition: "scope-handle",
        scopeHandle: "h9999",
      },
    });
    const editData = parseToolResult(editRes);
    expect(editData["kind"]).toBe("refusal");
    expect(editData["code"]).toBe("scope-violation");
    expect(readFile(wsDir, "src/a.ts")).toBe('export const A = "old";\n');
  }, 30000);
});

describe("scopeHandlePrecondition — range containment on a range-restricted handle", () => {
  it("edit inside the handle's own symbol range succeeds; edit outside it refuses out-of-scope", async () => {
    const wsDir = mkDir("range-containment");
    const origContent = [
      "export function greetUser(name: string): string {",
      '  return "Hello, " + name;',
      "}",
      "",
      "export function farewellUser(name: string): string {",
      '  return "Goodbye, " + name;',
      "}",
    ].join("\n") + "\n";
    writeFile(wsDir, "src/greeting.ts", origContent);

    const srv = startServer({ cwd: wsDir, args: [wsDir, "--allow-write"] });
    servers.push(srv);
    await srv.initialize();

    const sliceRes = await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "slice", path: "src/greeting.ts", symbol: "greetUser" },
    });
    const sliceData = parseToolResult(sliceRes);
    expect(sliceData["kind"]).toBe("read.text");
    const scopeHandle = sliceData["handle"] as string;
    expect(typeof scopeHandle).toBe("string");

    // Inside the greetUser range: succeeds.
    const insideRes = await srv.rpc(3, "tools/call", {
      name: "edit_file",
      arguments: {
        path: "src/greeting.ts",
        search: '"Hello, " + name',
        replace: '"Hi, " + name',
        precondition: "scope-handle",
        scopeHandle,
      },
    });
    const insideData = parseToolResult(insideRes);
    expect(insideData["kind"]).not.toBe("refusal");
    expect(readFile(wsDir, "src/greeting.ts")).toContain('"Hi, " + name');

    // Outside the greetUser range (inside farewellUser): refuses, disk
    // unchanged for that text.
    const outsideRes = await srv.rpc(4, "tools/call", {
      name: "edit_file",
      arguments: {
        path: "src/greeting.ts",
        search: '"Goodbye, " + name',
        replace: '"Bye, " + name',
        precondition: "scope-handle",
        scopeHandle,
      },
    });
    const outsideData = parseToolResult(outsideRes);
    expect(outsideData["kind"]).toBe("refusal");
    expect(outsideData["code"]).toBe("out-of-scope");
    expect(readFile(wsDir, "src/greeting.ts")).toContain('"Goodbye, " + name');
  }, 30000);
});

describe("scopeHandlePrecondition — round-18A finding 5: a path-less handle is not automatically unrestricted", () => {
  it("RESOLVABLE: a path-less kind:repo handle (whole-workspace mint) still authorizes an edit anywhere in the workspace", async () => {
    const wsDir = mkDir("repo-kind-resolvable");
    writeFile(wsDir, "package.json", JSON.stringify({ name: "fx-scope5", version: "1.0.0" }));
    writeFile(wsDir, "src/a.ts", 'export const A = "old";\n');
    const srv = startServer({ cwd: wsDir, args: [wsDir, "--allow-write"] });
    servers.push(srv);
    await srv.initialize();

    // `mode:"overview"` (`readCodeOverview.ts:860`) is the only PUBLIC surface
    // that mints a `kind:"repo"` handle with no `path` at all — a whole-
    // workspace scope by its own documented design, not a data anomaly.
    const overviewRes = await srv.rpc(2, "tools/call", { name: "read_file", arguments: { mode: "overview" } });
    const overviewData = parseToolResult(overviewRes);
    expect(overviewData["kind"]).toBe("read.map");
    const scopeHandle = (overviewData["outline"] as { repo?: { handle?: string } } | undefined)?.repo?.handle;
    expect(typeof scopeHandle, "precondition: the overview must mint a path-less repo handle").toBe("string");

    const editRes = await srv.rpc(3, "tools/call", {
      name: "edit_file",
      arguments: { path: "src/a.ts", search: '"old"', replace: '"new"', precondition: "scope-handle", scopeHandle },
    });
    const editData = parseToolResult(editRes);
    expect(
      editData["kind"],
      "a path-less kind:repo handle's documented meaning IS the whole workspace — it must keep working",
    ).not.toBe("refusal");
    expect(readFile(wsDir, "src/a.ts")).toContain('"new"');
  }, 30000);

  it("UNRESOLVABLE: a path-less handle of any OTHER kind refuses scope-violation instead of authorizing every path", async () => {
    // No production surface mints this shape (this file's own header, and
    // INV-I-4's exhaustive grep) — so unlike every other case in this file,
    // this one mints the handle directly through the real, shared
    // `handleTable` the production dispatcher itself uses, and calls the
    // real `enforcePreconditions` (the same function `edit_file` calls)
    // rather than going through a spawned server.
    const workspace = fs.realpathSync(fs.mkdtempSync(path.join(HOME, ".tl-scopehandle-unresolvable-")));
    tmpDirs.push(workspace);
    writeFile(workspace, "src/a.ts", 'export const A = "old";\n');

    const entry = handleTable.create({ kind: "scope", workspaceRoot: workspace });
    expect(entry.path, "precondition: this entry must be genuinely path-less").toBeUndefined();
    expect(entry.paths, "precondition: and carry no paths array either").toBeUndefined();

    const result = await enforcePreconditions(
      { precondition: "scope-handle", scopeHandle: entry.id },
      "src/a.ts",
      workspace,
      async (rel, root) => {
        try {
          return fs.readFileSync(path.join(root ?? workspace, rel), "utf8");
        } catch {
          return null;
        }
      },
    );
    expect(
      result.ok,
      "before the fix, a path-less non-repo handle satisfied 'every path is in scope' — the exact "
      + "unrestricted outcome this precondition exists to prevent",
    ).toBe(false);
    if (result.ok) return;
    expect(result.failure["reason"]).toBe("scope-violation");
  });
});
