// responseSizeRegression.spec.ts — v0.7 response-size ceiling regression tests.
//
// These ceilings are LOAD-BEARING for the v0.7 product target. A PR that causes
// any of the following caps to be exceeded must be rejected.
//
//   read_code mode=map (small file):            <= 1024 bytes   MAP_CAP_BYTES
//   read_file mode=map paths=[...] (files[]):   <= 65536 bytes  MULTI_FILE_MAP_CAP_BYTES
//   read_file mode=skeleton (unknown ext):      <= 8192 bytes   getFileSkeleton MAX_RESPONSE_BYTES
//   read_code mode=digest (small file):         <= 2048 bytes   DIGEST_CAP_BYTES
//   read_code mode=slice (small symbol):        <= 24576 bytes  READ_SYMBOL_CAP_BYTES (2026-07-16a: was 8192)
//   read_code mode=task_pack (~3 surfaces):     <= 4096 bytes   MAX_TASK_PACK_BYTES
//   edit_code successful search_replace:        <= 512 bytes    v0.7 acceptance criterion
//
// Coverage cross-reference (do not duplicate covered caps):
//   map 1024:       readCodeModes.spec.ts  "serialized response is within 1024 bytes"
//   digest 2048:    readCodeModes.spec.ts  "digest response stays within 2048 bytes"
//   task_pack 4096: readCodeTaskPack.spec.ts "byte cap is respected"
//   edit 512:       writeResponseSize.spec.ts (200-byte cap — stricter than 512, already covers it)
//
// Only the mode=slice successful-response ceiling is not yet asserted elsewhere.
// All other describe blocks are intentionally absent to avoid duplication.

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

// v0.7 cap constants — update only when the design explicitly raises the budget.
const READ_SYMBOL_CAP_BYTES = 24576; // 2026-07-16a: raised from 8192
// small_file ceiling: TINY_BYTES content + 512-byte JSON envelope.
const SMALL_FILE_CAP_BYTES = 8 * 1024 + 512; // 8704

const tmpDirs: string[] = [];
const servers: ServerHandle[] = [];

interface ServerHandle {
  initialize(): Promise<void>;
  rpc(id: number, method: string, params?: unknown, timeoutMs?: number): Promise<any>;
  kill(): void;
}

function mkDir(tag: string): string {
  const dir = fs.mkdtempSync(path.join(HOME, `.tl-rsr-${tag}-`));
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
        reject(new Error(`rpc '${method}' timed out after ${timeoutMs}ms.\n--- stderr ---\n${stderr}`));
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

// ---------------------------------------------------------------------------
// mode=small_file — response ceiling: TINY_BYTES content + 512-byte envelope
//
// A near-limit small_file response (content ~8 KiB) must serialize within
// SMALL_FILE_CAP_BYTES including JSON envelope, handle, sha, edit_hints.
// ---------------------------------------------------------------------------

describe("responseSizeRegression — read_code mode=small_file ceiling", () => {
  it("near-limit small_file response stays <= TINY_BYTES + 512 bytes", async () => {
    const wsDir = mkDir("sf-cap");
    // Content just below the TINY_BYTES threshold.
    const content = "a".repeat(8 * 1024 - 10);
    writeFile(wsDir, "src/near.ts", content);

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    const res = await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "small_file", path: "src/near.ts" },
    });

    expect(res.result?.isError).toBeFalsy();
    const text: string = res?.result?.content?.[0]?.text;
    expect(typeof text).toBe("string");

    const data = JSON.parse(text);
    // Rule K deletes the `mode` echo; kind discriminates in v1.
    expect(data["kind"]).toBe("read.text");

    const bytes = Buffer.byteLength(text, "utf8");
    expect(
      bytes,
      `mode=small_file response must stay <= ${SMALL_FILE_CAP_BYTES} bytes (got ${bytes})`,
    ).toBeLessThanOrEqual(SMALL_FILE_CAP_BYTES);
  }, 30000);
});

// ---------------------------------------------------------------------------
// mode=slice — successful small-symbol response stays within READ_SYMBOL_CAP_BYTES
//
// Existing tests in readCodeModes.spec.ts verify the error path (cap-exceeded) and
// structural fields, but never assert a byte ceiling on a successful slice response.
// ---------------------------------------------------------------------------

describe("responseSizeRegression — read_code mode=slice successful response ceiling", () => {
  it("symbol slice of a small function stays within READ_SYMBOL_CAP_BYTES", async () => {
    const wsDir = mkDir("slice-sym");
    writeFile(wsDir, "src/util.ts", [
      "export function computeTotal(a: number, b: number): number {",
      "  const sum = a + b;",
      "  return sum;",
      "}",
      "",
      "export function computeProduct(a: number, b: number): number {",
      "  return a * b;",
      "}",
    ].join("\n") + "\n");

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    const res = await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "slice", path: "src/util.ts", symbol: "computeTotal" },
    });

    expect(res.result?.isError).toBeFalsy();
    const text: string = res?.result?.content?.[0]?.text;
    expect(typeof text).toBe("string");

    const data = JSON.parse(text);
    // Rule K deletes the `mode` echo; D6 deletes body `ok`.
    expect(data["kind"]).toBe("read.text");
    expect(data["kind"]).not.toBe("refusal");

    const bytes = Buffer.byteLength(text, "utf8");
    expect(
      bytes,
      `mode=slice successful response must stay <= ${READ_SYMBOL_CAP_BYTES} bytes (got ${bytes})`,
    ).toBeLessThanOrEqual(READ_SYMBOL_CAP_BYTES);
  }, 30000);

  it("range slice of a small window stays within READ_SYMBOL_CAP_BYTES", async () => {
    const wsDir = mkDir("slice-rng");
    const lines = Array.from({ length: 30 }, (_, i) => `export const v${i} = ${i};`);
    writeFile(wsDir, "src/consts.ts", lines.join("\n") + "\n");

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    const res = await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "slice", path: "src/consts.ts", range: "1-10" },
    });

    expect(res.result?.isError).toBeFalsy();
    const text: string = res?.result?.content?.[0]?.text;
    expect(typeof text).toBe("string");

    const data = JSON.parse(text);
    expect(data["kind"]).toBe("read.text");

    const bytes = Buffer.byteLength(text, "utf8");
    expect(
      bytes,
      `mode=slice range response must stay <= ${READ_SYMBOL_CAP_BYTES} bytes (got ${bytes})`,
    ).toBeLessThanOrEqual(READ_SYMBOL_CAP_BYTES);
  }, 30000);
});

// ---------------------------------------------------------------------------
// mode=map paths=[...] — multi-file signature map total budget (64 KiB).
//
// 2026-07-16 skc2 microbench Q1: paths[] was ignored by mode=map entirely, so
// no multi-file map (and no 64KB cap) was reachable from the MCP surface.
// The serve must trim at FILE-BLOCK boundaries (request order, tail first)
// and flag the trim explicitly — 5b252d24's skeleton-engine semantics.
// ---------------------------------------------------------------------------

const MULTI_FILE_MAP_CAP_BYTES = 65536;

describe("responseSizeRegression — read_file mode=map paths=[...] multi-file budget", () => {
  it(">64KB of per-file signature blocks trims at file boundaries to <= 65536 served bytes with the explicit trim indicator", async () => {
    const wsDir = mkDir("map-cap");
    const paths: string[] = [];
    for (let f = 0; f < 16; f++) {
      const tag = String(f).padStart(2, "0");
      const lines: string[] = [];
      for (let i = 0; i < 150; i++) {
        const name = `mapBudgetFillerFunction_${tag}_${String(i).padStart(3, "0")}_${"x".repeat(40)}`;
        lines.push(`export function ${name}(alpha: number, beta: number): number {`);
        lines.push(`  const gamma = alpha + beta + ${i};`);
        lines.push(`  return gamma * ${f + 2};`);
        lines.push(`}`);
        lines.push(``);
      }
      const rel = `bulk/gen_${tag}.ts`;
      writeFile(wsDir, rel, lines.join("\n") + "\n");
      paths.push(rel);
    }

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    const res = await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "map", paths },
    }, 60000);

    expect(res.result?.isError).toBeFalsy();
    const text: string = res?.result?.content?.[0]?.text;
    expect(typeof text).toBe("string");
    const data = JSON.parse(text);
    expect(data["kind"]).toBe("read.map");

    // File-boundary trim: some but not all blocks served, in request order.
    // Rule K: the structural outline (A.5.3) nests files[] under `outline`.
    const outline = data["outline"] as Record<string, unknown>;
    const files = outline["files"] as Array<Record<string, unknown>>;
    expect(Array.isArray(files)).toBe(true);
    expect(files.length).toBeGreaterThan(0);
    expect(files.length).toBeLessThan(16);
    expect(files.map((f) => f["path"])).toEqual(paths.slice(0, files.length));
    for (const f of files) {
      expect(String(f["handle"])).toMatch(/^h[0-9a-z]+$/);
      expect(String(f["signatures"]).length).toBeGreaterThan(0);
    }

    // The serialized files[] section IS the served map content — within budget.
    const servedBytes = Buffer.byteLength(JSON.stringify(files), "utf8");
    expect(
      servedBytes,
      `mode=map files[] must stay <= ${MULTI_FILE_MAP_CAP_BYTES} bytes (got ${servedBytes})`,
    ).toBeLessThanOrEqual(MULTI_FILE_MAP_CAP_BYTES);

    // Explicit trim indicator: v1 collapses the top-level `truncated` flag,
    // the `map_cap_bytes` number, and the per-block `omitted[] {reason}`
    // ledger into one `Limit` (Rule T, A.5.2/A.5.3 preamble: "has no v1
    // representation") — the trim note (kept verbatim under `outline.note`)
    // and the coarse "evidence" omitted-class are what survive; the specific
    // byte-cap number and the per-block reason ledger have no v1 carrier.
    expect(String(outline["note"])).toContain("tokenlighten:skeleton-truncated");
    const limit = data["limit"] as Record<string, unknown>;
    expect(limit["omitted"]).toContain("evidence");
    // Self-consistent with the served count above — the strongest claim still
    // checkable now that the per-block reason ledger is gone.
    expect(16 - files.length).toBeGreaterThan(0);
  }, 120000);
});

// ---------------------------------------------------------------------------
// mode=skeleton on an unrecognized extension — the verbatim-dump hole.
//
// 2026-07-16 skc2 microbench Q3/Q4: an extension absent from EXT_TO_LANGUAGE
// returned the ENTIRE file as signatures (ratio 1.0, uncapped). It must now
// obey getFileSkeleton's own 8192 budget; the auto route on the same file
// keeps its separate DOC_CONTENT_CAP_BYTES (4096) serve.
// ---------------------------------------------------------------------------

describe("responseSizeRegression — read_file mode=skeleton unrecognized-extension ceiling", () => {
  it("32KB .txt skeleton is capped at 8192 signature bytes; auto stays on its 4096 doc cap", async () => {
    const wsDir = mkDir("skel-txt");
    const prose = Array.from({ length: 480 }, (_, i) =>
      `field note ${String(i).padStart(3, "0")}: sensor drift observation and calibration ledger entry line.`,
    );
    writeFile(wsDir, "notes/field-notes.txt", prose.join("\n") + "\n");

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    const res = await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "skeleton", path: "notes/field-notes.txt" },
    });

    expect(res.result?.isError).toBeFalsy();
    const data = JSON.parse(res?.result?.content?.[0]?.text);
    expect(data["kind"]).toBe("read.map");
    const outline = data["outline"] as Record<string, unknown>;
    expect(outline["language"]).toBe("unknown");
    // v1 deletes the top-level `truncated`/`byte_budget` pair (Rule T, A.5.2
    // preamble) — a truncated read.map carries a `limit` instead, and the
    // specific budget number has no carrier; the measured byte count below is
    // the strictly stronger, direct proof the old self-reported number stood
    // in for.
    expect(data["limit"]).toBeDefined();
    const sigBytes = Buffer.byteLength(String(outline["signatures"]), "utf8");
    expect(
      sigBytes,
      `unknown-extension skeleton must stay <= 8192 signature bytes (got ${sigBytes})`,
    ).toBeLessThanOrEqual(8192);
    expect(String(outline["signatures"])).toContain("[truncated: unrecognized extension");

    // Sibling route: mode=auto on the same file serves the doc-content slice
    // under its own 4096 cap (unchanged behavior, pinned here so the two
    // routes cannot silently swap).
    const res2 = await srv.rpc(3, "tools/call", {
      name: "read_file",
      arguments: { path: "notes/field-notes.txt" },
    });
    expect(res2.result?.isError).toBeFalsy();
    const data2 = JSON.parse(res2?.result?.content?.[0]?.text);
    expect(data2["kind"]).toBe("read.text");
    expect(data2["limit"]).toBeDefined();
    const evidence2 = data2["evidence"] as Array<Record<string, unknown>>;
    expect(Buffer.byteLength(String(evidence2[0]?.["body"]), "utf8")).toBeLessThanOrEqual(4096);
  }, 60000);
});
