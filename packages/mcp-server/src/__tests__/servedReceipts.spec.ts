// servedReceipts.spec.ts — W1 served-content receipts (2026-07-30).
//
// When read_file (mode=slice/full/symbol, or handle-addressed) re-requests
// content ALREADY served this session — same file, requested range fully
// subsumed by previously served ranges, file sha unchanged — the server
// answers with a compact receipt (`code_unchanged:true` + a `summary` of what
// is already held) instead of re-serving the bytes. `content:"full"` or
// `allowFull:true` forces a normal serve regardless.
//
// Qualification (state/session.ts's servedRangeReceipt / recordServedRange,
// wired in server.ts's mode=slice/symbol/full branches):
//   - EXACT re-serve (same range, same sha)              -> receipt
//   - a NARROWER range fully subsumed by an earlier serve -> receipt
//   - PARTIAL overlap (adds lines not previously served)  -> normal serve
//   - the file's sha changed since the earlier serve      -> normal serve
//   - content:"full" / allowFull:true                     -> normal serve (forced)
//
// Covers mode=slice (the primary range-addressed vehicle), plus one
// cross-mode case each for mode=symbol (re-requesting a symbol whose file
// range was already served) and mode=full (a full read after cumulative
// slices already covered the whole file — the standalone ledger check that is
// NOT the older full-governor per-path-cap mechanism; see
// readCodeFullDowngrade.spec.ts for that mechanism's own repeat-read tests).

import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
// v1 deletes the receipt's prose `note` outright (A.5.2 preamble: "a note
// restating code_unchanged in prose ... has no v1 representation"), so
// SERVED_CONTENT_RECEIPT_NOTE has no wire-visible successor to pin here.

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
  const dir = fs.mkdtempSync(path.join(HOME, `.tl-sr-${tag}-`));
  tmpDirs.push(dir);
  return dir;
}

function writeFile(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

function startServer(opts: { cwd: string; args: string[]; env?: Record<string, string> }): ServerHandle {
  const child: ChildProcess = spawn(
    process.execPath,
    [TSX_CLI, BIN_TS, ...opts.args],
    { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...(opts.env ?? {}) } },
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
    await rpc(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "vitest", version: "0" } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  function kill(): void { try { child.kill("SIGKILL"); } catch { /* ok */ } }

  return { initialize, rpc, kill };
}

afterEach(() => {
  for (const s of servers.splice(0)) s.kill();
  for (const d of tmpDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ok */ }
  }
});

function parseToolResult(rpcResult: any): Record<string, unknown> {
  const text: string = rpcResult?.result?.content?.[0]?.text;
  expect(typeof text).toBe("string");
  return JSON.parse(text);
}

/** 20 numbered lines — big enough to slice narrower/wider windows out of. */
function numberedLines(n = 20): string {
  return Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// mode=slice — exact re-serve and subsumed-range receipts
// ---------------------------------------------------------------------------

describe("servedReceipts — mode=slice exact re-serve", () => {
  it("the exact same range re-requested returns a code_unchanged receipt, not re-served content", async () => {
    const wsDir = mkDir("exact");
    writeFile(wsDir, "src/wide.ts", numberedLines(20));

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    const r1 = await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "slice", path: "src/wide.ts", range: "1-5" },
    });
    const d1 = parseToolResult(r1);
    expect(d1["kind"]).toBe("read.text");
    const d1Evidence = (d1["evidence"] as Array<Record<string, unknown>> | undefined)?.[0];
    expect(typeof d1Evidence?.["body"]).toBe("string");
    expect(String(d1Evidence?.["body"])).toContain("line 1");

    const r2 = await srv.rpc(3, "tools/call", {
      name: "read_file",
      arguments: { mode: "slice", path: "src/wide.ts", range: "1-5" },
    });
    const d2 = parseToolResult(r2);
    expect(d2["kind"]).not.toBe("refusal");
    expect(d2["kind"]).toBe("read.receipt");
    const receipt2 = d2["receipt"] as Record<string, unknown>;
    expect(receipt2["receipt"]).toBe("code-unchanged");
    // Content-equivalent, not a re-served body — and the SAME slice as d1.
    expect(d2["evidence"]).toBeUndefined();
    expect(receipt2["handle"]).toBe(d1Evidence?.["handle"]);
    expect(typeof receipt2["handle"]).toBe("string");
    expect(receipt2["handle"]).toMatch(/^h[0-9a-z]+$/);
    expect(String(receipt2["sha"])).toMatch(/^sha256:/);
    // v1 deletes the receipt's `summary`/`served_range_ledger` disclosure
    // outright (A.5.2 preamble: "has no v1 representation") — a
    // code-unchanged receipt is now a minimal {handle, sha[, served_by]}
    // identity claim and no longer states the file-wide served/unserved
    // picture.
    expect(d2["summary"]).toBeUndefined();
    expect(d2["served_range_ledger"]).toBeUndefined();
  }, 30000);

  it("a narrower range fully subsumed by an earlier WIDER serve also returns a receipt", async () => {
    const wsDir = mkDir("subsumed");
    writeFile(wsDir, "src/wide.ts", numberedLines(20));

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    // Step 1: serve the WHOLE file in one range slice.
    const wideRes = await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "slice", path: "src/wide.ts", range: "1-20" },
    });
    const wideData = parseToolResult(wideRes);
    const wideEvidence = (wideData["evidence"] as Array<Record<string, unknown>> | undefined)?.[0];
    expect(wideEvidence?.["range"]).toBe("1-20");
    expect(typeof wideEvidence?.["body"]).toBe("string");

    // Step 2: request a STRICTLY NARROWER window — never served on its own,
    // but fully contained in the range already served.
    const narrowRes = await srv.rpc(3, "tools/call", {
      name: "read_file",
      arguments: { mode: "slice", path: "src/wide.ts", range: "8-12" },
    });
    const narrowData = parseToolResult(narrowRes);
    expect(narrowData["kind"]).toBe("read.receipt");
    const narrowReceipt = narrowData["receipt"] as Record<string, unknown>;
    expect(narrowReceipt["receipt"]).toBe("code-unchanged");
    expect(typeof narrowReceipt["handle"]).toBe("string");
    expect(narrowReceipt["handle"]).toMatch(/^h[0-9a-z]+$/);
    expect(narrowData["evidence"]).toBeUndefined();
    expect(narrowData["summary"]).toBeUndefined();
  }, 30000);

  it("PARTIAL overlap (not fully subsumed) serves normally — real content, no receipt", async () => {
    const wsDir = mkDir("partial");
    writeFile(wsDir, "src/wide.ts", numberedLines(20));

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "slice", path: "src/wide.ts", range: "1-10" },
    });
    // 6-15 overlaps 1-10 (lines 6-10) but also asks for NEW lines 11-15 —
    // not fully subsumed, so this must serve real content, not a receipt.
    const overlapRes = await srv.rpc(3, "tools/call", {
      name: "read_file",
      arguments: { mode: "slice", path: "src/wide.ts", range: "6-15" },
    });
    const overlapData = parseToolResult(overlapRes);
    expect(overlapData["kind"]).toBe("read.text");
    const overlapEvidence = (overlapData["evidence"] as Array<Record<string, unknown>> | undefined)?.[0];
    expect(overlapEvidence?.["range"]).toBe("6-15");
    expect(typeof overlapEvidence?.["body"]).toBe("string");
    expect(String(overlapEvidence?.["body"])).toContain("line 6");
    expect(String(overlapEvidence?.["body"])).toContain("line 15");
  }, 30000);

  it("a changed file (new sha) serves normally even for the exact same range", async () => {
    const wsDir = mkDir("changed");
    writeFile(wsDir, "src/wide.ts", numberedLines(20));

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "slice", path: "src/wide.ts", range: "1-5" },
    });
    // Edit the file — new sha invalidates the earlier serve for this range.
    writeFile(wsDir, "src/wide.ts", numberedLines(20).replace("line 1\n", "line ONE (edited)\n"));
    const r2 = await srv.rpc(3, "tools/call", {
      name: "read_file",
      arguments: { mode: "slice", path: "src/wide.ts", range: "1-5" },
    });
    const d2 = parseToolResult(r2);
    expect(d2["kind"]).toBe("read.text");
    const d2Evidence = (d2["evidence"] as Array<Record<string, unknown>> | undefined)?.[0];
    expect(typeof d2Evidence?.["body"]).toBe("string");
    expect(String(d2Evidence?.["body"])).toContain("line ONE (edited)");
  }, 30000);

  it('content:"full" forces a normal serve past an otherwise-qualifying receipt', async () => {
    const wsDir = mkDir("force-content");
    writeFile(wsDir, "src/wide.ts", numberedLines(20));

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "slice", path: "src/wide.ts", range: "1-5" },
    });
    const forced = await srv.rpc(3, "tools/call", {
      name: "read_file",
      arguments: { mode: "slice", path: "src/wide.ts", range: "1-5", content: "full" },
    });
    const forcedData = parseToolResult(forced);
    expect(forcedData["kind"]).toBe("read.text");
    const forcedEvidence = (forcedData["evidence"] as Array<Record<string, unknown>> | undefined)?.[0];
    expect(typeof forcedEvidence?.["body"]).toBe("string");
    expect(String(forcedEvidence?.["body"])).toContain("line 1");
  }, 30000);

  it("allowFull:true forces a normal serve past an otherwise-qualifying receipt", async () => {
    const wsDir = mkDir("force-allowfull");
    writeFile(wsDir, "src/wide.ts", numberedLines(20));

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "slice", path: "src/wide.ts", range: "1-5" },
    });
    const forced = await srv.rpc(3, "tools/call", {
      name: "read_file",
      arguments: { mode: "slice", path: "src/wide.ts", range: "1-5", allowFull: true },
    });
    const forcedData = parseToolResult(forced);
    expect(forcedData["kind"]).toBe("read.text");
    const forcedEvidence = (forcedData["evidence"] as Array<Record<string, unknown>> | undefined)?.[0];
    expect(typeof forcedEvidence?.["body"]).toBe("string");
    expect(String(forcedEvidence?.["body"])).toContain("line 1");
  }, 30000);

  it("the receipt carries no escape-hatch prose — v1 deletes the note field outright", async () => {
    const wsDir = mkDir("note-text");
    writeFile(wsDir, "src/wide.ts", numberedLines(20));

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "slice", path: "src/wide.ts", range: "1-5" },
    });
    const r2 = await srv.rpc(3, "tools/call", {
      name: "read_file",
      arguments: { mode: "slice", path: "src/wide.ts", range: "1-5" },
    });
    const d2 = parseToolResult(r2);
    expect(d2["kind"]).toBe("read.receipt");
    const receipt2 = d2["receipt"] as Record<string, unknown>;
    expect(receipt2["receipt"]).toBe("code-unchanged");
    // v1 deletes the receipt's prose `note` outright (A.5.2 preamble: "a note
    // restating code_unchanged in prose ... has no v1 representation") — the
    // content:"full"/allowFull:true escape hatch is proven FUNCTIONALLY by the
    // sibling tests above; this pins that its documentation no longer rides a
    // receipt, so a reintroduced note (or a hand-rolled duplicate string)
    // would be caught here.
    expect(d2["note"]).toBeUndefined();
  }, 30000);
});

// ---------------------------------------------------------------------------
// mode=symbol — re-requesting a symbol whose file range was already served
// ---------------------------------------------------------------------------

describe("servedReceipts — mode=symbol re-serve", () => {
  it("re-requesting the same symbol after it was already served returns a receipt", async () => {
    const wsDir = mkDir("symbol");
    writeFile(wsDir, "src/math.ts", [
      "export function add(a: number, b: number): number {",
      "  return a + b;",
      "}",
    ].join("\n") + "\n");

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    const r1 = await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "symbol", path: "src/math.ts", symbol: "add" },
    });
    const d1 = parseToolResult(r1);
    // RESOLVED 2026-08-14: `textEvidence()` now reads BOTH read dialects —
    // `content`/`code` for the served bytes and a string-or-object `range` —
    // so mode=symbol's direct serve (`{...symbolData, code, handle, sha}` over
    // getSymbolWithContext's `{code, range:{start,end}}`) projects to a real
    // A.5.2 evidence tuple instead of an empty one.
    expect(d1["kind"]).toBe("read.text");
    const d1Evidence = (d1["evidence"] as Array<Record<string, unknown>> | undefined)?.[0];
    expect(typeof d1Evidence?.["body"]).toBe("string");
    expect(String(d1Evidence?.["body"])).toContain("return a + b;");

    const r2 = await srv.rpc(3, "tools/call", {
      name: "read_file",
      arguments: { mode: "symbol", path: "src/math.ts", symbol: "add" },
    });
    const d2 = parseToolResult(r2);
    // The RECEIPT side is unaffected — servedContentReceipt already builds the
    // v1-shaped body directly, independent of textEvidence's field lookup.
    expect(d2["kind"]).toBe("read.receipt");
    const receipt2 = d2["receipt"] as Record<string, unknown>;
    expect(receipt2["receipt"]).toBe("code-unchanged");
    expect(d2["evidence"]).toBeUndefined();
    expect(typeof receipt2["handle"]).toBe("string");
    expect(d2["note"]).toBeUndefined();
  }, 30000);

  it('content:"full" forces mode=symbol past a receipt too', async () => {
    const wsDir = mkDir("symbol-force");
    writeFile(wsDir, "src/math.ts", [
      "export function add(a: number, b: number): number {",
      "  return a + b;",
      "}",
    ].join("\n") + "\n");

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "symbol", path: "src/math.ts", symbol: "add" },
    });
    const forced = await srv.rpc(3, "tools/call", {
      name: "read_file",
      arguments: { mode: "symbol", path: "src/math.ts", symbol: "add", content: "full" },
    });
    const forcedData = parseToolResult(forced);
    // Same KNOWN BUG as the direct-serve test above — this path returns the
    // identical raw shape (server.ts's `content:"full"` override only skips
    // the receipt branch, it does not change the success body's field names).
    expect(forcedData["kind"]).toBe("read.text");
    const forcedEvidence = (forcedData["evidence"] as Array<Record<string, unknown>> | undefined)?.[0];
    expect(typeof forcedEvidence?.["body"]).toBe("string");
    expect(String(forcedEvidence?.["body"])).toContain("return a + b;");
  }, 30000);
});

// ---------------------------------------------------------------------------
// mode=full — cumulative slice coverage of the WHOLE file also qualifies.
// This is the standalone ledger check, distinct from the older full-governor
// per-path-cap repeat-read mechanism (readCodeFullDowngrade.spec.ts) — it
// fires precisely because a tracked mode=full expansion never happened here.
// ---------------------------------------------------------------------------

describe("servedReceipts — mode=full re-serve via cumulative slice coverage", () => {
  it("mode=full after slices already covered the whole file returns a receipt, not a governor downgrade", async () => {
    const wsDir = mkDir("full-cumulative");
    writeFile(wsDir, "src/small.ts", numberedLines(10));

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    // One slice covering the ENTIRE file — no mode=full expansion tracked yet.
    const sliceRes = await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "slice", path: "src/small.ts", range: "1-10" },
    });
    const sliceData = parseToolResult(sliceRes);
    const sliceEvidence = (sliceData["evidence"] as Array<Record<string, unknown>> | undefined)?.[0];
    expect(sliceEvidence?.["range"]).toBe("1-10");

    const fullRes = await srv.rpc(3, "tools/call", {
      name: "read_file",
      arguments: { mode: "full", path: "src/small.ts" },
    });
    const fullData = parseToolResult(fullRes);
    expect(fullData["kind"]).toBe("read.receipt");
    const fullReceipt = fullData["receipt"] as Record<string, unknown>;
    expect(fullReceipt["receipt"]).toBe("code-unchanged");
    expect(fullData["evidence"]).toBeUndefined();
    // Not the OLDER governor-downgrade shape — receipts (A.4) never carry
    // downgrade explanation fields to begin with (`downgraded_from`/`reason`
    // survive only on read.batch entries, A.5.4).
    expect(fullData["downgraded_from"]).toBeUndefined();
    expect(fullData["reason"]).toBeUndefined();
    // v1 deletes `summary`/prose `note` outright (A.5.2 preamble).
    expect(fullData["summary"]).toBeUndefined();
    expect(fullData["note"]).toBeUndefined();
  }, 30000);

  it("allowFull:true forces mode=full past the cumulative-coverage receipt", async () => {
    const wsDir = mkDir("full-cumulative-force");
    writeFile(wsDir, "src/small.ts", numberedLines(10));

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "slice", path: "src/small.ts", range: "1-10" },
    });
    const forced = await srv.rpc(3, "tools/call", {
      name: "read_file",
      arguments: { mode: "full", path: "src/small.ts", allowFull: true },
    });
    const forcedData = parseToolResult(forced);
    expect(forcedData["kind"]).toBe("read.text");
    const forcedEvidence = (forcedData["evidence"] as Array<Record<string, unknown>> | undefined)?.[0];
    expect(typeof forcedEvidence?.["body"]).toBe("string");
    expect(String(forcedEvidence?.["body"])).toContain("line 1");
  }, 30000);
});
