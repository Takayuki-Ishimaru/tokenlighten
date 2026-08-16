/**
 * readFileSheetImpliesArtifact.spec.ts — FIX B (2026-07-12c forensics).
 *
 * Live failure: `read_file {handle, sheet}` (or path+sheet) WITHOUT explicit
 * mode="artifact" silently ignored the sheet param and re-served the
 * workbook roster — the xlsx params (sheet/range/columns/...) were only ever
 * consulted inside `if (mode === "artifact")` (server.ts). A caller that
 * reasonably expected `sheet=` alone to select a sheet's data got the SAME
 * roster back every time: a silent-wrong-data bug (4 wasted calls in one live session).
 *
 * Fix: `sheet=` now implies mode=artifact when mode is omitted/"auto" and
 * the resolved target is an xlsx file; an explicitly DIFFERENT content mode
 * alongside `sheet` refuses loudly instead of silently overriding either way.
 *
 * Covers:
 *   (c1) path+sheet, no mode: routes to artifact, returns table data.
 *   (c2) handle+sheet, no mode: same (handle-resolved path).
 *   (c3) path+sheet, mode="auto" explicit: same (auto === omitted).
 *   (c4) path+sheet, mode="skeleton" (conflicting explicit mode): refuses
 *        loudly with reason=invalid-input and a hint naming mode=artifact.
 *   (c5) sanity: path+sheet, mode="artifact" explicit: unaffected (already
 *        covered end-to-end by readCodeArtifactDispatch.spec.ts; re-checked
 *        briefly here for completeness of the mode-interaction matrix).
 *   (c6) sanity: path only (no sheet), mode omitted, xlsx file: still
 *        returns the roster — sheet-less calls are completely unaffected.
 *
 * Harness + buildTestXlsxBytes copied from argMatrix.spec.ts's pattern
 * (spawned server over stdio, tmp-workspace-per-test).
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
  call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  kill(): void;
}

function mkDir(tag: string): string {
  const dir = fs.mkdtempSync(path.join(HOME, `.tl-sheetimplies-${tag}-`));
  tmpDirs.push(dir);
  return dir;
}

function writeBinaryFile(dir: string, rel: string, bytes: Uint8Array | Buffer): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, bytes);
}

let idCounter = 1;

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
      clientInfo: { name: "vitest-sheetimplies", version: "0" },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await rpc(++idCounter, "tools/call", { name, arguments: args });
    const text = res?.result?.content?.[0]?.text;
    expect(typeof text).toBe("string");
    return JSON.parse(text);
  }

  function kill(): void {
    try { child.kill("SIGKILL"); } catch { /* ok */ }
  }

  return { initialize, rpc, call, kill };
}

afterEach(() => {
  for (const s of servers.splice(0)) s.kill();
  for (const d of tmpDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ok */ }
  }
});

async function newServer(tag: string): Promise<{ ws: string; srv: ServerHandle }> {
  const ws = mkDir(tag);
  const srv = startServer({ cwd: ws, args: [ws] });
  servers.push(srv);
  await srv.initialize();
  return { ws, srv };
}

// ExcelJS write API (minimal shape needed here) — mirrors
// readCodeArtifactDispatch.spec.ts / argMatrix.spec.ts's identical helper.
type WorksheetFull = { addRow(values: unknown[]): void };
type WorkbookFull = {
  addWorksheet(name: string): WorksheetFull;
  xlsx: { writeBuffer(): Promise<Buffer> };
};

async function buildTestXlsxBytes(): Promise<Buffer> {
  const ExcelJSMod = (await import("exceljs")) as unknown as { Workbook: new () => WorkbookFull };
  const wb: WorkbookFull = new ExcelJSMod.Workbook();
  const ws = wb.addWorksheet("Rates");
  ws.addRow(["code", "base_rate"]);
  ws.addRow(["A001", 123.45]);
  ws.addRow(["A002", 200]);
  const buf = await wb.xlsx.writeBuffer();
  return buf;
}

describe("readFileSheetImpliesArtifact — sheet= implies mode=artifact", () => {
  it("(c1) path+sheet, mode omitted: routes to artifact and returns table data, not the roster", async () => {
    const { ws, srv } = await newServer("path-sheet-no-mode");
    writeBinaryFile(ws, "rates.xlsx", await buildTestXlsxBytes());

    const res = await srv.call("read_file", { path: "rates.xlsx", sheet: "Rates" });

    // C2-3: the top-level xlsx|docx|pptx|... kind vocabulary relocates to
    // content.form (Rule K) — "xlsx.table" vs "xlsx.roster" IS the routing
    // fact this test exists to pin, so assert it directly instead of the
    // old weaker "not roster" negative check.
    expect(res["kind"]).toBe("read.artifact");
    const content = res["content"] as Record<string, unknown>;
    expect(content["form"]).toBe("xlsx.table");
    expect(content["sheets"]).toBeUndefined(); // roster-only field must be absent
    const columns = content["columns"] as string[];
    expect(columns).toEqual(["code", "base_rate"]);
    const rows = content["rows"] as unknown[];
    expect(rows.length).toBe(2);
  }, 30000);

  it("(c2) handle+sheet, mode omitted: same routing via a handle resolved from a prior read", async () => {
    const { ws, srv } = await newServer("handle-sheet-no-mode");
    writeBinaryFile(ws, "rates.xlsx", await buildTestXlsxBytes());

    // Mint a plain file handle first (roster view — no sheet yet).
    const roster = await srv.call("read_file", { path: "rates.xlsx" });
    expect(roster["kind"]).toBe("read.artifact");
    expect((roster["content"] as Record<string, unknown>)["form"]).toBe("xlsx.roster");
    const handle = roster["handle"];
    expect(typeof handle).toBe("string");

    const res = await srv.call("read_file", { handle, sheet: "Rates" });

    expect(res["kind"]).toBe("read.artifact");
    const content = res["content"] as Record<string, unknown>;
    expect(content["form"]).toBe("xlsx.table");
    const columns = content["columns"] as string[];
    expect(columns).toEqual(["code", "base_rate"]);
    const rows = content["rows"] as unknown[];
    expect(rows.length).toBe(2);
  }, 30000);

  it("(c3) path+sheet, mode='auto' explicit: identical to mode omitted", async () => {
    const { ws, srv } = await newServer("path-sheet-explicit-auto");
    writeBinaryFile(ws, "rates.xlsx", await buildTestXlsxBytes());

    const res = await srv.call("read_file", { path: "rates.xlsx", sheet: "Rates", mode: "auto" });

    expect(res["kind"]).toBe("read.artifact");
    const content = res["content"] as Record<string, unknown>;
    expect(content["form"]).toBe("xlsx.table");
    const columns = content["columns"] as string[];
    expect(columns).toEqual(["code", "base_rate"]);
  }, 30000);

  it("(c4) path+sheet, mode='skeleton' (explicit conflicting mode): refuses loudly instead of silently ignoring sheet OR silently overriding mode", async () => {
    const { ws, srv } = await newServer("path-sheet-conflicting-mode");
    writeBinaryFile(ws, "rates.xlsx", await buildTestXlsxBytes());

    const res = await srv.call("read_file", { path: "rates.xlsx", sheet: "Rates", mode: "skeleton" });

    expect(res["kind"]).toBe("refusal");
    expect(res["code"]).toBe("invalid-input");
    expect(String(res["hint"])).toContain("mode=artifact");
    expect(String(res["detail"])).toContain("sheet");
  }, 30000);

  it("(c4b) path+sheet, mode='full' (another explicit conflicting mode): also refuses loudly", async () => {
    const { ws, srv } = await newServer("path-sheet-conflicting-mode-full");
    writeBinaryFile(ws, "rates.xlsx", await buildTestXlsxBytes());

    const res = await srv.call("read_file", { path: "rates.xlsx", sheet: "Rates", mode: "full" });

    expect(res["kind"]).toBe("refusal");
    expect(res["code"]).toBe("invalid-input");
    expect(String(res["hint"])).toBe("sheet= requires mode=artifact (or omit mode)");
  }, 30000);

  it("(c5) sanity (no regression): path+sheet, mode='artifact' explicit still works normally", async () => {
    const { ws, srv } = await newServer("path-sheet-explicit-artifact");
    writeBinaryFile(ws, "rates.xlsx", await buildTestXlsxBytes());

    const res = await srv.call("read_file", { path: "rates.xlsx", sheet: "Rates", mode: "artifact" });

    expect(res["kind"]).toBe("read.artifact");
    const content = res["content"] as Record<string, unknown>;
    expect(content["form"]).toBe("xlsx.table");
    const columns = content["columns"] as string[];
    expect(columns).toEqual(["code", "base_rate"]);
  }, 30000);

  it("(c6) sanity (no regression): sheet-less path, mode omitted, xlsx file still returns the roster", async () => {
    const { ws, srv } = await newServer("path-no-sheet-roster");
    writeBinaryFile(ws, "rates.xlsx", await buildTestXlsxBytes());

    const res = await srv.call("read_file", { path: "rates.xlsx" });

    expect(res["kind"]).toBe("read.artifact");
    const content = res["content"] as Record<string, unknown>;
    expect(content["form"]).toBe("xlsx.roster");
    expect(Array.isArray(content["sheets"])).toBe(true);
  }, 30000);

  it("(c7) sanity (no regression): sheet on a non-xlsx file with mode omitted does not force artifact routing (falls through unchanged)", async () => {
    const { ws, srv } = await newServer("path-sheet-non-xlsx");
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, "plain.ts"), "export const A = 1;\n", "utf8");

    const res = await srv.call("read_file", { path: "plain.ts", sheet: "Rates" });

    // Not an artifact response, and not the invalid-input refusal either —
    // sheet is simply not meaningful for a non-office file at mode=auto, so
    // this must behave exactly as a sheet-less mode=auto read would.
    expect(res["mode"]).not.toBe("artifact");
    expect(res["reason"]).not.toBe("invalid-input");
  }, 30000);
});
