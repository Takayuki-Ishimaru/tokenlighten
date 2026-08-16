/**
 * readCodeCsvDispatch.spec.ts — server-level (spawned MCP server) coverage for
 * first-class CSV/TSV structured serving through the real server.ts dispatch.
 *
 * csvTable.spec.ts covers office/csv.ts at the unit level. This file exercises
 * the SAME feature through tools/call, pinning the dispatch contract:
 *   - mode=artifact on .csv/.tsv → the bounded table view (no-selector head,
 *     range, columns), a reusable handle, and a C10.1 short sha, held to the
 *     same ≤ mustFetchReadBudget(READ_SYMBOL_CAP_BYTES) wire budget as xlsx.
 *   - size-gated plain reads: a LARGE csv (> TINY_BYTES) serves the table view
 *     on the first auto read (serve data, not a redirect); a SMALL csv keeps
 *     today's text behavior; mode=full keeps its existing text semantics.
 */

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
  const dir = fs.mkdtempSync(path.join(HOME, `.tl-csv-dispatch-${tag}-`));
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

// TINY_BYTES (util/fullGovernor.ts) = 8 * 1024. A csv above it takes the table
// route on a plain read; below it keeps today's text behavior.
const TINY_BYTES = 8 * 1024;

/** A csv whose byte length is controllable via the data-row count. */
function buildCsv(dataRows: number): string {
  const lines = ["code,base_rate,min,note"];
  for (let i = 0; i < dataRows; i++) {
    lines.push(`A${String(i).padStart(4, "0")},${100 + i},${10 + i},row number ${i} descriptive note`);
  }
  return lines.join("\n") + "\n";
}

describe("read_file mode=artifact (csv) — server dispatch", () => {
  it("no-selector call serves the bounded table head with columns, rows, total_rows, handle, short sha", async () => {
    const ws = mkDir("artifact-head");
    const csv = buildCsv(300);
    expect(Buffer.byteLength(csv, "utf8")).toBeGreaterThan(TINY_BYTES);
    writeFile(ws, "rates.csv", csv);

    const srv = startServer({ cwd: ws, args: [ws] });
    servers.push(srv);
    await srv.initialize();

    const res = await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "artifact", path: "rates.csv" },
    });
    const data = parseToolResult(res);
    const text = res.result.content[0].text as string;

    expect(data["kind"]).toBe("read.artifact");
    const content = data["content"] as Record<string, unknown>;
    expect(content["form"]).toBe("csv");
    expect(content["columns"]).toEqual(["code", "base_rate", "min", "note"]);
    const rows = content["rows"] as unknown[][];
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(200); // default row cap
    expect((rows[0] as unknown[]).length).toBe(4); // positional tuples
    expect(content["total_rows"]).toBe(300); // honest total, even when capped
    expect(content["total_columns"]).toBe(4);
    // Rule T: response-level truncation is `limit` and appears in no other
    // form — absence of `limit` IS completeness (§4.4); the flat `truncated`
    // boolean is deleted.
    expect(data["limit"]).toBeDefined();
    expect(String(content["note"])).toContain("range="); // honest continuation
    expect(content["dialect"]).toEqual({ delimiter: ",", header: true });

    expect(typeof data["handle"]).toBe("string");
    expect(String(data["handle"])).toMatch(/^h[0-9a-z]+$/);
    expect(String(data["sha"])).toMatch(/^sha256:[0-9a-f]{12,64}$/);
    expect(String(data["sha"]).length).toBeLessThanOrEqual("sha256:".length + 12);

    // Same wire budget xlsx's no-`sheet` inline path is held to.
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(24576);
  }, 30000);

  it("range=... selects a data-row span in row-number form", async () => {
    const ws = mkDir("artifact-range");
    writeFile(ws, "rates.csv", buildCsv(300));

    const srv = startServer({ cwd: ws, args: [ws] });
    servers.push(srv);
    await srv.initialize();

    const res = await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "artifact", path: "rates.csv", range: "2-6" },
    });
    const data = parseToolResult(res);

    expect(data["kind"]).toBe("read.artifact");
    const content = data["content"] as Record<string, unknown>;
    expect(content["form"]).toBe("csv");
    expect(content["range"]).toBe("2-6");
    const rows = content["rows"] as unknown[][];
    expect(rows.length).toBe(5); // rows 2..6 inclusive
    expect((rows[0] as unknown[])[0]).toBe("A0000"); // first data row
  }, 30000);

  it("columns=[...] selects a subset by header name", async () => {
    const ws = mkDir("artifact-columns");
    writeFile(ws, "rates.csv", buildCsv(50));

    const srv = startServer({ cwd: ws, args: [ws] });
    servers.push(srv);
    await srv.initialize();

    const res = await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "artifact", path: "rates.csv", columns: ["code", "min"] },
    });
    const data = parseToolResult(res);

    expect(data["kind"]).toBe("read.artifact");
    const content = data["content"] as Record<string, unknown>;
    expect(content["columns"]).toEqual(["code", "min"]);
    const rows = content["rows"] as unknown[][];
    expect((rows[0] as unknown[]).length).toBe(2);
  }, 30000);

  it("tsv is served with the tab delimiter (extension is authoritative)", async () => {
    const ws = mkDir("artifact-tsv");
    writeFile(ws, "rates.tsv", "code\tbase_rate\tmin\nA001\t123\t50\nA002\t200\t100\n");

    const srv = startServer({ cwd: ws, args: [ws] });
    servers.push(srv);
    await srv.initialize();

    const res = await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "artifact", path: "rates.tsv" },
    });
    const data = parseToolResult(res);

    expect(data["kind"]).toBe("read.artifact");
    const content = data["content"] as Record<string, unknown>;
    expect(content["form"]).toBe("csv");
    expect(content["dialect"]).toEqual({ delimiter: "\t", header: true });
    expect(content["columns"]).toEqual(["code", "base_rate", "min"]);
  }, 30000);
});

describe("read_file plain reads (csv) — size-gated routing", () => {
  it("a LARGE csv (> TINY_BYTES) serves the structured table on the first auto read (not a redirect)", async () => {
    const ws = mkDir("auto-large");
    const csv = buildCsv(300);
    expect(Buffer.byteLength(csv, "utf8")).toBeGreaterThan(TINY_BYTES);
    writeFile(ws, "big.csv", csv);

    const srv = startServer({ cwd: ws, args: [ws] });
    servers.push(srv);
    await srv.initialize();

    // No mode → auto.
    const res = await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { path: "big.csv" },
    });
    const data = parseToolResult(res);

    expect(data["kind"]).toBe("read.artifact");
    const content = data["content"] as Record<string, unknown>;
    expect(content["form"]).toBe("csv");
    expect(Array.isArray(content["rows"])).toBe(true);
    expect(content["total_rows"]).toBe(300);
    // The generic text-evidence shape (kind="read.text") is NOT used for a
    // large csv.
    expect(data["kind"]).not.toBe("read.text");
    expect(typeof data["handle"]).toBe("string");
  }, 30000);

  it("a SMALL csv (<= TINY_BYTES) keeps today's text behavior on an auto read", async () => {
    const ws = mkDir("auto-small");
    const csv = buildCsv(3); // a few dozen bytes, well under TINY_BYTES
    expect(Buffer.byteLength(csv, "utf8")).toBeLessThanOrEqual(TINY_BYTES);
    writeFile(ws, "small.csv", csv);

    const srv = startServer({ cwd: ws, args: [ws] });
    servers.push(srv);
    await srv.initialize();

    const res = await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { path: "small.csv" },
    });
    const data = parseToolResult(res);

    // Falls through to the text pipeline — NOT the new structured table view.
    expect(data["kind"]).toBe("read.text");
    expect(data["kind"]).not.toBe("read.artifact");
    // The raw csv text is served (small-file/text serve carries the content
    // in evidence[0].body, A.5.2).
    const evidence = (data["evidence"] as Array<Record<string, unknown>> | undefined)?.[0];
    expect(String(evidence?.["body"] ?? "")).toContain("code,base_rate,min");
  }, 30000);

  it("mode=full on a csv keeps its existing text semantics (never the table view)", async () => {
    const ws = mkDir("full-text");
    writeFile(ws, "big.csv", buildCsv(300));

    const srv = startServer({ cwd: ws, args: [ws] });
    servers.push(srv);
    await srv.initialize();

    const res = await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "full", path: "big.csv" },
    });
    const data = parseToolResult(res);

    // mode=full routes through the shared governed-full path, not the csv table
    // branch (which only intercepts auto/skeleton/symbol).
    expect(data["kind"]).not.toBe("csv");
  }, 30000);
});
