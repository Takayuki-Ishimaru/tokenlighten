/**
 * readCodeHandle.spec.ts — tests for read_code handle resolution guard.
 *
 * Covers:
 *   - read_code with an unknown handle → returns {ok:false, reason:"handle-unknown"}
 *   - read_code with a handle from a different workspace → returns
 *     {ok:false, reason:"handle-workspace-mismatch"}
 *   - read_code with a valid handle from the same workspace → resolves path/symbol/range
 *
 * Uses the same spawned-server-over-stdio pattern as editCodeHandle.spec.ts.
 */

import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { nextText } from "./helpers/protocolNext.js";

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
  const dir = fs.mkdtempSync(path.join(HOME, `.tl-rc-handle-${tag}-`));
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

function parseToolResult(rpcResult: any): Record<string, unknown> {
  const text = rpcResult?.result?.content?.[0]?.text;
  expect(typeof text).toBe("string");
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// read_code with unknown handle → handle-unknown
// ---------------------------------------------------------------------------

describe("readCodeHandle — unknown handle", () => {
  it("returns {ok:false, reason:'handle-unknown'} when handle id does not exist", async () => {
    const wsDir = mkDir("unknown");
    writeFile(wsDir, "src/f.ts", `export const X = 1;\n`);

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    const res = await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: {
        handle: "h9999",  // non-existent handle
        mode: "slice",
      },
    });

    const data = parseToolResult(res);
    expect(data["kind"]).toBe("refusal");
    expect(data["code"]).toBe("handle-unknown");
  }, 30000);
});

// ---------------------------------------------------------------------------
// read_code with handle from a different workspace → handle-workspace-mismatch
// ---------------------------------------------------------------------------

describe("readCodeHandle — workspace mismatch", () => {
  it("returns {ok:false, reason:'handle-workspace-mismatch'} when handle was minted in a different workspace", async () => {
    const wsDir1 = mkDir("ws-mismatch-1");
    const wsDir2 = mkDir("ws-mismatch-2");

    writeFile(wsDir1, "src/file.ts", `export const A = "hello";\n`);
    writeFile(wsDir2, "src/file.ts", `export const B = "world";\n`);

    // Start one server rooted at wsDir1.
    const srv = startServer({ cwd: wsDir1, args: [wsDir1] });
    servers.push(srv);
    await srv.initialize();

    // Get a digest handle — minted under wsDir1.
    const digestRes = await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "digest", path: "src/file.ts" },
    });
    const digestData = parseToolResult(digestRes);
    // C2-3: mode=digest now serves kind="read.map" with the handle at
    // outline.handle (A.5.3), not top-level.
    expect(digestData["kind"]).toBe("read.map");
    const handle = (digestData["outline"] as Record<string, unknown>)["handle"] as string;
    expect(handle).toMatch(/^h[0-9a-z]+$/);

    // Now call read_code with that handle but cwd=wsDir2. The server will
    // compute workspace=wsDir2 (realpath'd) but the handle's workspaceRoot
    // is wsDir1 — mismatch.
    const res = await srv.rpc(3, "tools/call", {
      name: "read_file",
      arguments: {
        handle,
        mode: "slice",
        cwd: wsDir2,  // different workspace from where the handle was created
      },
    });

    const data = parseToolResult(res);
    expect(data["kind"]).toBe("refusal");
    expect(data["code"]).toBe("handle-workspace-mismatch");
    // C2-4 (already adjudicated in handleWorkspaceAdoption.spec.ts): the
    // closed advisory allowlist (A.5.15) drops the structured
    // `handle`/`handleWorkspace` fields from the refusal wire — the
    // workspace to retry with survives only inside `detail` prose, which
    // `nextText` falls back to when `next` cannot be parsed as an
    // executable ToolCall.
    expect(data["handle"]).toBeUndefined();
    expect(data["handleWorkspace"]).toBeUndefined();
    expect(typeof nextText(data as Record<string, unknown>)).toBe("string");
    expect(nextText(data as Record<string, unknown>)).toContain(wsDir1);
  }, 30000);
});

// ---------------------------------------------------------------------------
// read_code with valid handle from same workspace → resolves path/symbol/range
// ---------------------------------------------------------------------------

describe("readCodeHandle — valid handle from same workspace", () => {
  it("resolves path/symbol from a handle minted in the same workspace", async () => {
    const wsDir = mkDir("valid");
    writeFile(wsDir, "src/greet.ts", [
      "export function hello(name: string): string {",
      '  return "Hello, " + name;',
      "}",
      "",
      "export function bye(name: string): string {",
      '  return "Bye, " + name;',
      "}",
    ].join("\n") + "\n");

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    // Step 1: get a slice handle for hello().
    const sliceRes = await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: {
        mode: "slice",
        path: "src/greet.ts",
        symbol: "hello",
      },
    });
    const sliceData = parseToolResult(sliceRes);
    // C2-3: mode=slice now serves kind="read.text" with a FreshEvidence
    // tuple (A.5.2) — `handle` moved off the top level into `evidence[0].handle`.
    expect(sliceData["kind"]).toBe("read.text");
    const sliceEvidence = (sliceData["evidence"] as Array<Record<string, unknown>>)[0]!;
    const handle = sliceEvidence["handle"] as string;
    expect(handle).toMatch(/^h[0-9a-z]+$/);

    // Step 2: call read_code again via the handle (no explicit path/symbol).
    const res = await srv.rpc(3, "tools/call", {
      name: "read_file",
      arguments: {
        handle,
        mode: "slice",
      },
    });
    const data = parseToolResult(res);
    // Should succeed and return slice content for the same symbol.
    expect(data["kind"]).toBe("read.text");
    // The slice output should contain the hello function body.
    const evidence = (data["evidence"] as Array<Record<string, unknown>>)[0]!;
    const content = String(evidence["body"] ?? "");
    expect(content).toContain("hello");
  }, 30000);
});

// ---------------------------------------------------------------------------
// Regression: bench transcript forensics (2026-07-03) found that after
// edit_code rejected an out-of-bounds handle, the agent re-sliced the SAME
// handle with `mode=slice range=140-183` and got back the handle's full
// "1-184" content again instead of the requested narrower sub-range — a
// caller-supplied `range=` was silently discarded whenever the handle
// carried its own stored range (server.ts: `if (hEntry.range) resolvedRange
// = hEntry.range;` ran unconditionally, AFTER resolvedRange had already
// been set from the caller's args.range). Root cause: AGENTS.md's own
// routing rule 4 ("Slice too narrow? Re-slice the SAME handle wider — don't
// open the file natively") depends on a caller-supplied range winning over
// a whole-file/range-kind handle's own stored range; a handle's path/symbol
// SHOULD win (it identifies which file/symbol the handle points at), but
// its range should not override an explicit re-slice request.
// ---------------------------------------------------------------------------

describe("readCodeHandle — re-slice a range-kind handle with a caller-supplied narrower range", () => {
  it("mode=slice handle=<id> range=<narrower> returns the NARROWER range's content, not the handle's own full stored range", async () => {
    const wsDir = mkDir("reslice-narrower");
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    writeFile(wsDir, "src/wide.ts", lines.join("\n") + "\n");

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    // Step 1: mint a WHOLE-FILE range-kind handle (mirrors task_pack's
    // tinyFileWholeRange output — a handle whose OWN stored range is the
    // full file, not a narrow window).
    const wideRes = await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "slice", path: "src/wide.ts", range: "1-20" },
    });
    const wideData = parseToolResult(wideRes);
    expect(wideData["kind"]).toBe("read.text");
    const wideEvidence = (wideData["evidence"] as Array<Record<string, unknown>>)[0]!;
    expect(wideEvidence["range"]).toBe("1-20");
    const handle = wideEvidence["handle"] as string;
    expect(handle).toMatch(/^h[0-9a-z]+$/);

    // Step 2: re-slice the SAME handle with an explicit NARROWER range —
    // exactly the "slice too narrow, re-slice the same handle" pattern
    // (here narrower, but the same code path — the handle's stored range
    // must not silently win over an explicit caller range either way).
    // W1 served-content receipts: 5-8 is fully subsumed by the 1-20 already
    // served in step 1 (same file, same sha), so this would otherwise
    // qualify for a code_unchanged receipt with no `content` to inspect —
    // content:"full" forces the normal serve this range-resolution check needs.
    const narrowRes = await srv.rpc(3, "tools/call", {
      name: "read_file",
      arguments: { mode: "slice", handle, range: "5-8", content: "full" },
    });
    const narrowData = parseToolResult(narrowRes);
    expect(narrowData["kind"]).toBe("read.text");
    const narrowEvidence = (narrowData["evidence"] as Array<Record<string, unknown>>)[0]!;
    // BUG (pre-fix): this used to come back "1-20" (the handle's own stored
    // range), silently ignoring the caller's "5-8" — a no-op re-slice.
    expect(narrowEvidence["range"]).toBe("5-8");
    const narrowContent = String(narrowEvidence["body"] ?? "");
    expect(narrowContent).toContain("line 5");
    expect(narrowContent).toContain("line 8");
    expect(narrowContent).not.toContain("line 1\n");
    expect(narrowContent).not.toContain("line 20");
  }, 30000);

  it("mode=slice handle=<id> with NO explicit range still falls back to the handle's own stored range (unchanged behavior)", async () => {
    const wsDir = mkDir("reslice-fallback");
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    writeFile(wsDir, "src/wide2.ts", lines.join("\n") + "\n");

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    const wideRes = await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "slice", path: "src/wide2.ts", range: "3-6" },
    });
    const wideData = parseToolResult(wideRes);
    const handle = (wideData["evidence"] as Array<Record<string, unknown>>)[0]!["handle"] as string;

    // Re-invoke via the handle with NO range argument at all — must still
    // fall back to the handle's own stored "3-6" (the pre-existing,
    // intentional "handle overrides top-level fields when caller passes
    // nothing" behavior, which this fix must not break).
    // W1 served-content receipts: "3-6" was just served in step 1 (same
    // file, same sha, same resolved range), so this re-slice would otherwise
    // qualify for a code_unchanged receipt (kind="read.receipt", no `range`
    // to inspect) — content:"full" forces the normal serve this
    // range-resolution check needs.
    const res = await srv.rpc(3, "tools/call", {
      name: "read_file",
      arguments: { mode: "slice", handle, content: "full" },
    });
    const data = parseToolResult(res);
    expect(data["kind"]).toBe("read.text");
    expect((data["evidence"] as Array<Record<string, unknown>>)[0]!["range"]).toBe("3-6");
  }, 30000);
});
