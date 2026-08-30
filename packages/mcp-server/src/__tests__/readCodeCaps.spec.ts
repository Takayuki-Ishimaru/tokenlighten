// readCodeCaps.spec.ts — server-level tests for read_code hard read caps (Phase 4).
//
// Spawns the real server over stdio and verifies that:
//   a. mode=full on a small file returns content normally.
//   b. mode=full on a file > 81920 bytes (2026-07-16a, was 12288) is served
//      directly on the first read; a repeat read returns a SERVED skeleton
//      downgrade (A-2), not an error.
//   c. mode=auto on a large code file falls through to skeleton (not full content).
//   d. mode=symbol where the symbol body exceeds 24576 bytes (2026-07-16a,
//      was 8192) returns a SERVED
//      downgrade (downgraded_from:"symbol", FIX C 2026-07-12c) — see
//      readCodeSymbolCapDowngrade.spec.ts for the fuller coverage of this
//      behavior (trimmed-prefix correctness, next-hint follow-through,
//      bake-into-cap). This test is kept as the original cap-detection
//      regression pin, updated to the new served shape.

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
  const dir = fs.mkdtempSync(path.join(HOME, `.tl-caps-${tag}-`));
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

/** Parse the first content-block text from a JSON-RPC tools/call result. */
function parseFirstContentText(rpcResult: any): Record<string, unknown> {
  const text = rpcResult?.result?.content?.[0]?.text;
  expect(typeof text).toBe("string");
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// Cap constants (must match server.ts)
// ---------------------------------------------------------------------------
const READ_FULL_CAP_BYTES = 81920; // 2026-07-16a: raised from 12288
const READ_SYMBOL_CAP_BYTES = 24576; // 2026-07-16a: raised from 8192

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("read_code hard read caps (Phase 4)", () => {
  it("(a) mode=full on a small file returns content normally", async () => {
    const wsDir = mkDir("caps-full-small");
    writeFile(wsDir, "small.ts", "export const x = 1;\n");

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    const res = await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "full", path: "small.ts" },
    });

    // Must not be an error at the JSON-RPC level.
    expect(res.error).toBeUndefined();
    const data = parseFirstContentText(res);
    // isError must not be set.
    expect(res.result?.isError).toBeFalsy();
    // C2-3: mode=full serves kind="read.text" with a FreshEvidence tuple
    // (A.5.2); `content` moved to `evidence[0].body`.
    expect(data["kind"]).toBe("read.text");
    const evidence = (data["evidence"] as Array<Record<string, unknown>>)[0]!;
    expect(typeof evidence["body"]).toBe("string");
    expect(String(evidence["body"])).toContain("x = 1");
  }, 30000);

  it("(b) mode=full on a file between the old 12288-byte cap and the new 81920-byte cap succeeds directly, no auto_allowed needed", async () => {
    // 2026-07-16a: READ_FULL_CAP_BYTES raised 12288 -> 81920, which now
    // exceeds LARGE_BYTES(24576) — the C5 auto-allow-under-ceiling mechanism
    // (see firstReadAutoAllow.spec.ts) is structurally unreachable at this
    // fixture size now: this ~20600-byte file (originally sized to exercise
    // the OLD 12288-24576 C5 window) is simply under the new default cap, so
    // it succeeds on the FIRST read with no auto_allowed signal at all — the
    // SAME protective outcome (one call, no wasted downgrade-then-retry turn)
    // via the raised base cap directly instead of the C5 workaround.
    const wsDir = mkDir("caps-full-large");
    const bigLine = "// " + "x".repeat(100) + "\n";
    const bigContent = bigLine.repeat(200); // ~20600 bytes
    expect(Buffer.byteLength(bigContent, "utf8")).toBeGreaterThan(12288);
    expect(Buffer.byteLength(bigContent, "utf8")).toBeLessThan(READ_FULL_CAP_BYTES);
    writeFile(wsDir, "large.ts", bigContent);

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    const res = await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "full", path: "large.ts" },
    });

    expect(res.result?.isError).toBeFalsy();
    const data = parseFirstContentText(res);
    expect(data["kind"]).toBe("read.text");
    expect(data["auto_allowed"]).toBeUndefined();
    const evidence = (data["evidence"] as Array<Record<string, unknown>>)[0]!;
    expect(typeof evidence["body"]).toBe("string");
    expect(String(evidence["body"]).length).toBeGreaterThan(0);
    expect(typeof evidence["handle"]).toBe("string");
    expect(evidence["handle"]).toMatch(/^h[0-9a-z]+$/);
  }, 30000);

  it("(b-repeat) mode=full on the SAME path (now under the raised cap), second read: content-equivalent code_unchanged via the per-path cap, not a naked error (A6/W1)", async () => {
    // 2026-07-16a: this ~20600-byte fixture is now under READ_FULL_CAP_BYTES
    // (81920), so the FIRST read just succeeds directly (see (b) above) — the
    // SECOND read is still governed, but now by PER_PATH_FULL_CAP (reason
    // "per-path-cap-reached"), not the byte-cap-exceeded branch this fixture
    // no longer reaches at all.
    const wsDir = mkDir("caps-full-large-repeat");
    const bigLine = "// " + "x".repeat(100) + "\n";
    const bigContent = bigLine.repeat(200); // ~20600 bytes
    expect(Buffer.byteLength(bigContent, "utf8")).toBeGreaterThan(12288);
    expect(Buffer.byteLength(bigContent, "utf8")).toBeLessThan(READ_FULL_CAP_BYTES);
    writeFile(wsDir, "large.ts", bigContent);

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    // First read: succeeds directly (see (b) above — no C5 needed anymore).
    const firstRes = await srv.rpc(2, "tools/call", { name: "read_file", arguments: { mode: "full", path: "large.ts" } });
    const firstData = parseFirstContentText(firstRes);
    const firstHandle = (firstData["evidence"] as Array<Record<string, unknown>>)[0]!["handle"] as string;

    const res = await srv.rpc(3, "tools/call", {
      name: "read_file",
      arguments: { mode: "full", path: "large.ts" },
    });

    // A6: not a transport-level error. W1: a repeat read of the SAME sha the
    // caller already fully holds returns a compact code-unchanged receipt —
    // the v1 successor (A.4) of the old
    // downgraded_from:"full"+code_unchanged:true content-equivalent shape —
    // naming the SAME handle the first read minted.
    expect(res.result?.isError).toBeFalsy();
    const data = parseFirstContentText(res);
    expect(data["kind"]).toBe("read.receipt");
    const receipt = data["receipt"] as Record<string, unknown>;
    expect(receipt["receipt"]).toBe("code-unchanged");
    expect(receipt["handle"]).toBe(firstHandle);
    expect(typeof receipt["sha"]).toBe("string");
    // A receipt IS the whole body now (A.5.6: {v, kind, receipt}) — assert
    // the exact key set rather than enumerating every individual field the
    // old content-equivalent shape used to have to prove absent
    // (downgraded_from/code_unchanged/reason/path/bytes/
    // allow_full_would_help/content/skeleton/next/ok/hint/alternatives/
    // preview/preview_range).
    expect(Object.keys(data).sort()).toEqual(["kind", "receipt", "v"]);
  }, 30000);

  it("(b2) mode=full allowFull:true still returns full content for a file under READ_FULL_CAP_BYTES_ALLOW_FULL", async () => {
    const wsDir = mkDir("caps-full-allowfull");
    // Same ~20600-byte file as (b): under BOTH READ_FULL_CAP_BYTES (81920 as
    // of 2026-07-16a — this file no longer NEEDS allowFull to succeed at
    // all, see (b) above) and READ_FULL_CAP_BYTES_ALLOW_FULL (131072).
    // This test's remaining value: allowFull:true is still a harmless
    // no-op success path for a file that would have succeeded anyway.
    const bigLine = "// " + "x".repeat(100) + "\n";
    const bigContent = bigLine.repeat(200);
    expect(Buffer.byteLength(bigContent, "utf8")).toBeLessThan(65536);
    writeFile(wsDir, "large.ts", bigContent);

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    const res = await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "full", path: "large.ts", allowFull: true },
    });

    expect(res.result?.isError).toBeFalsy();
    const data = parseFirstContentText(res);
    expect(data["kind"]).toBe("read.text");
    const evidence = (data["evidence"] as Array<Record<string, unknown>>)[0]!;
    expect(typeof evidence["body"]).toBe("string");
    expect(String(evidence["body"]).length).toBeGreaterThan(0);
  }, 30000);

  it("(b3) mode=full allowFull:true over the raised allowFull ceiling: served content head downgrade, allowFull can't help further", async () => {
    const wsDir = mkDir("caps-full-over-allowfull");
    // Build a file clearly over READ_FULL_CAP_BYTES_ALLOW_FULL (131072 bytes
    // — 2026-07-16a wave review raised it strictly above the 81920 default).
    const bigLine = "// " + "x".repeat(100) + "\n";
    const bigContent = bigLine.repeat(1300); // ~135200 bytes
    expect(Buffer.byteLength(bigContent, "utf8")).toBeGreaterThan(131072);
    writeFile(wsDir, "huge.ts", bigContent);

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    const res = await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "full", path: "huge.ts", allowFull: true },
    });

    expect(res.result?.isError).toBeFalsy();
    const data = parseFirstContentText(res);
    // W1: served content head, not a refusal and not a zero-content skeleton.
    expect(data["kind"]).toBe("read.text");
    const evidence = (data["evidence"] as Array<Record<string, unknown>>)[0]!;
    // Real content head, bounded to the serve budget, with the remainder
    // carried as a structured `limit.next` ToolCall (Rule T) — the old
    // downgraded_from/reason/truncated dialect collapses into `limit`, whose
    // presence alone now signals a bounded/incomplete serve.
    expect(typeof evidence["body"]).toBe("string");
    expect(Buffer.byteLength(String(evidence["body"]), "utf8")).toBeLessThanOrEqual(12288);
    expect(data["limit"]).toBeDefined();
    const limit = data["limit"] as Record<string, unknown>;
    const next = limit["next"] as Record<string, unknown>;
    expect(next["tool"]).toBe("read_file");
    const nextArgs = next["arguments"] as Record<string, unknown>;
    // allowFull was already supplied and still exceeded — it cannot help
    // further, so the recovery call is a plain slice, never an allowFull retry.
    expect((nextArgs["budget"] as Record<string, unknown> | undefined)?.["allowFull"]).toBeUndefined();
    expect(nextArgs["content"]).toBe("auto");
    expect(Array.isArray(nextArgs["targets"])).toBe(true);
    expect(data["skeleton"]).toBeUndefined();
    // Refusal fields gone.
    expect(data["ok"]).toBeUndefined();
    expect(data["hint"]).toBeUndefined();
    expect(data["alternatives"]).toBeUndefined();
    expect(data["preview"]).toBeUndefined();
    expect(evidence["handle"]).toMatch(/^h[0-9a-z]+$/);
  }, 30000);

  it("(c) mode=auto on a large code file falls through to skeleton (not full content)", async () => {
    const wsDir = mkDir("caps-auto-large");
    // File must be > SMALL_FILE_BYTES (8192 chars as of 2026-07-16a, was 3000)
    // so auto falls through to skeleton. ~10.4KB comfortably clears it.
    const bigContent = Array.from({ length: 200 }, (_, i) =>
      `export function fn${i}(): void { console.log(${i}); }`
    ).join("\n") + "\n";
    expect(bigContent.length).toBeGreaterThan(3000);
    writeFile(wsDir, "large.ts", bigContent);

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    const res = await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "auto", path: "large.ts" },
    });

    // Must not be an error.
    expect(res.result?.isError).toBeFalsy();
    const data = parseFirstContentText(res);
    // C2-3: the structural family (skeleton/map/overview/surfaces/digest)
    // serves kind="read.map" with the rendered text at outline.signatures
    // (A.5.3), not a top-level field.
    expect(data["kind"]).toBe("read.map");
    const outline = data["outline"] as Record<string, unknown>;
    expect(outline["form"]).toBe("signatures");
    expect(typeof outline["signatures"]).toBe("string");
    // Must NOT have returned the full raw content.
    expect(data["content"]).toBeUndefined();
  }, 30000);

  it("(d) mode=symbol where symbol body exceeds READ_SYMBOL_CAP_BYTES now serves a downgraded_from:\"symbol\" response within cap, not a bare cap-exceeded refusal (FIX C, 2026-07-12c)", async () => {
    const wsDir = mkDir("caps-symbol-large");
    // Build a function whose body exceeds READ_SYMBOL_CAP_BYTES (24576 as of
    // 2026-07-16a, was 8192) when serialized. The getSymbolWithContext wrapper
    // adds a scope header, so the body alone needs a comfortable margin over
    // the cap. 1200 lines (~34.9KB) clears it.
    const bodyLines = Array.from({ length: 1200 }, (_, i) => `  const v${i} = "${i.toString().padStart(10, "0")}";`);
    const fileContent = [
      "export function bigFn(): void {",
      ...bodyLines,
      "}",
    ].join("\n") + "\n";
    writeFile(wsDir, "big.ts", fileContent);

    // Verify the file's bigFn content would exceed the symbol cap.
    expect(Buffer.byteLength(fileContent, "utf8")).toBeGreaterThan(READ_SYMBOL_CAP_BYTES);

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    const res = await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "symbol", path: "big.ts", symbol: "bigFn" },
    });

    // Served, not refused: no MCP-transport isError, no ok:false.
    expect(res.result?.isError).not.toBe(true);
    const data = parseFirstContentText(res);
    // v1 (A.5.2 + Rule T), re-pointed 2026-08-14 on this file's OWN precedent
    // for the sibling cap cases above: the downgrade is still a SERVE, so the
    // member is `read.text`; `downgraded_from`/`reason`/`truncated`/`bytes`/
    // `maxBytes` collapse into `limit`, whose presence signals the bounded
    // serve; and the remainder rides a structured `limit.next` ToolCall.
    expect(data["kind"]).toBe("read.text");
    const evidence = (data["evidence"] as Array<Record<string, unknown>>)[0]!;
    expect(evidence["path"]).toBe("big.ts");
    // The addressing triple is complete, so the caller can zoom this window.
    expect(String(evidence["range"])).toMatch(/^\d+-\d+$/);
    expect(String(evidence["handle"])).toMatch(/^h[0-9a-z]+$/);
    // A downgrade SERVES a (trimmed) code body — this is the whole point.
    expect(typeof evidence["body"]).toBe("string");
    expect(String(evidence["body"]).length).toBeGreaterThan(0);
    expect(String(evidence["body"])).toContain("bigFn");
    const limit = data["limit"] as Record<string, unknown>;
    expect(limit).toBeDefined();
    const nextArgs = (limit["next"] as Record<string, unknown>)["arguments"] as Record<string, unknown>;
    expect(nextArgs["content"]).toBe("auto");
    expect(Array.isArray(nextArgs["targets"])).toBe(true);
    expect(data["suggest"]).toBeUndefined(); // legacy refusal-only field, gone on the served shape
    // The full served payload itself must stay within the cap (bake-into-cap).
    const rawText = res?.result?.content?.[0]?.text as string;
    expect(Buffer.byteLength(rawText, "utf8")).toBeLessThanOrEqual(READ_SYMBOL_CAP_BYTES);
  }, 30000);
});
