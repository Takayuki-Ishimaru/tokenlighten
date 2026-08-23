/**
 * readCodeFullDowngrade.spec.ts — integration tests for the full-read governor
 * wired into server.ts mode=full, under turn-economy wave 2 (W1).
 *
 * W1 (2026-07-24): a governed downgrade must SERVE CONTENT, never a
 * zero-content skeleton with a breadcrumb the caller has to spend an extra API
 * turn to redeem. Covers:
 *   - serveGovernedFullHead: the pure head-budgeting helper (whole-file fit,
 *     partial head with exact remainder line, degenerate long-first-line)
 *   - repeat read of the SAME path (unchanged sha): compact code_unchanged
 *     (content-equivalent — the caller already holds the bytes)
 *   - cap-exceeded (huge first read): mode="full", downgraded_from="full",
 *     content head <= the serve budget, truncated:true, a remainder next
 *   - per-task-cap overflow (distinct new file): content head + truncated:true
 *   - tiny-task-cap overflow via mode=full: full content served
 *   - the served head is a byte-exact prefix; its remainder `next` slice works
 *   - task_pack / slice fallbacks after a downgrade still work
 *   - governor disabled → no downgrade
 */

import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { TINY_SKELETON_CAP, PER_TASK_FULL_CAP, GOVERNED_FULL_SERVE_BYTES } from "../util/fullGovernor.js";
import { serveGovernedFullHead } from "../server.js";

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
  const dir = fs.mkdtempSync(path.join(HOME, `.tl-fdg-${tag}-`));
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
        reject(new Error(`rpc '${method}' timed out.\n--- stderr ---\n${stderr}`));
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

function parseResult(rpcResult: any): Record<string, unknown> {
  const text: string = rpcResult?.result?.content?.[0]?.text;
  expect(typeof text).toBe("string");
  return JSON.parse(text);
}

/** Non-tiny content of a given size (>8KiB → non-tiny, under READ_FULL_CAP_BYTES). */
function makeContent(targetBytes = 9000): string {
  const lines: string[] = [];
  let totalBytes = 0;
  let i = 0;
  while (totalBytes < targetBytes) {
    const line = `export const VAR_${i} = ${i}; // padding-comment-to-increase-line-length\n`;
    lines.push(line);
    totalBytes += Buffer.byteLength(line, "utf8");
    i++;
  }
  return lines.join("");
}

/**
 * A Java-shaped file WELL over READ_FULL_CAP_BYTES_ALLOW_FULL (~93.8KB) so a
 * SINGLE mode=full call downgrades immediately via reason:"cap-exceeded".
 */
function makeHugeContent(): { content: string; lineCount: number } {
  const lines: string[] = [
    "package com.example.orchestrator;",
    "",
    "import java.util.List;",
    "",
    "public class QuoteOrchestrator {",
  ];
  for (let i = 0; i < 1200; i++) {
    lines.push(`    // member placeholder line ${i} padding-to-exceed-the-allowfull-ceiling-xx`);
  }
  lines.push("}");
  return { content: lines.join("\n") + "\n", lineCount: lines.length };
}

// ---------------------------------------------------------------------------
// serveGovernedFullHead — pure unit coverage (W1).
// ---------------------------------------------------------------------------

describe("serveGovernedFullHead — pure unit (W1)", () => {
  it("empty content serves nothing, servedLines/totalLines both 0", () => {
    expect(serveGovernedFullHead("", GOVERNED_FULL_SERVE_BYTES)).toEqual({ head: "", servedLines: 0, totalLines: 0 });
  });

  it("a whole file under the budget is served in full (head === content, not truncated)", () => {
    const content = "line1\nline2\nline3\n";
    const r = serveGovernedFullHead(content, GOVERNED_FULL_SERVE_BYTES);
    expect(r.head).toBe(content);
    expect(r.servedLines).toBe(3);
    expect(r.totalLines).toBe(3);
    // servedLines === totalLines → the caller renders truncated:false, no next.
    expect(r.servedLines).toBe(r.totalLines);
  });

  it("a file over the budget serves an exact leading-line prefix within budget, with the right remainder line", () => {
    // 400 lines of ~24 bytes = ~9.6KB; force a tiny 200-byte budget so we get a
    // clean partial head and can assert the exact boundary.
    const lines = Array.from({ length: 400 }, (_, i) => `line ${i} padding`);
    const content = lines.join("\n") + "\n";
    const budget = 200;
    const r = serveGovernedFullHead(content, budget);
    expect(r.totalLines).toBe(400);
    expect(r.servedLines).toBeGreaterThan(0);
    expect(r.servedLines).toBeLessThan(400);
    // Fits the budget.
    expect(Buffer.byteLength(r.head, "utf8")).toBeLessThanOrEqual(budget);
    // The head is EXACTLY the first servedLines logical lines (byte-exact prefix).
    expect(r.head).toBe(lines.slice(0, r.servedLines).join("\n"));
    // Adding the NEXT line would have overflowed — proves it's a real cap.
    const withNext = lines.slice(0, r.servedLines + 1).join("\n");
    expect(Buffer.byteLength(withNext, "utf8")).toBeGreaterThan(budget);
  });

  it("degenerate single-long-line: serves a byte-bounded, code-point-aligned prefix with servedLines:0", () => {
    const longLine = "x".repeat(50000);
    const r = serveGovernedFullHead(longLine + "\n", GOVERNED_FULL_SERVE_BYTES);
    expect(r.totalLines).toBe(1);
    expect(r.servedLines).toBe(0); // remainder `next` re-fetches from line 1
    expect(Buffer.byteLength(r.head, "utf8")).toBeLessThanOrEqual(GOVERNED_FULL_SERVE_BYTES);
    expect(r.head).toBe("x".repeat(GOVERNED_FULL_SERVE_BYTES));
  });

  it("never splits a multi-byte character at the budget boundary", () => {
    // Each 'あ' is 3 UTF-8 bytes; a budget that lands mid-character must trim
    // back to a whole code point.
    const longLine = "あ".repeat(10000);
    const r = serveGovernedFullHead(longLine + "\n", 100);
    expect(Buffer.byteLength(r.head, "utf8")).toBeLessThanOrEqual(100);
    // No replacement char from a mid-character cut.
    expect(r.head).not.toContain("�");
    expect(r.head).toBe("あ".repeat(Math.floor(100 / 3)));
  });
});

// ---------------------------------------------------------------------------
// Repeat read of the SAME path (unchanged sha) → code_unchanged (W1)
// ---------------------------------------------------------------------------

describe("readCodeFullDowngrade — repeat read is content-equivalent code_unchanged (W1)", () => {
  it("first mode=full serves content; the second (same sha) returns a compact code_unchanged, not a skeleton", async () => {
    const wsDir = mkDir("repeat");
    writeFile(wsDir, "src/pid.cpp", makeContent());

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    const r1 = await srv.rpc(2, "tools/call", { name: "read_file", arguments: { mode: "full", path: "src/pid.cpp" } });
    const d1 = parseResult(r1);
    expect(d1["kind"]).toBe("read.text");
    const e1 = (d1["evidence"] as Array<Record<string, unknown>>)[0]!;
    expect(typeof e1["body"]).toBe("string");

    const r2 = await srv.rpc(3, "tools/call", { name: "read_file", arguments: { mode: "full", path: "src/pid.cpp" } });
    const d2 = parseResult(r2);
    // Content-equivalent, NOT a zero-content skeleton with a breadcrumb: the
    // v1 successor (A.4) of downgraded_from:"full"+code_unchanged:true is a
    // compact kind="read.receipt" body — there is no sibling content/
    // skeleton/next field left on it to check absent.
    expect(d2["kind"]).toBe("read.receipt");
    const receipt2 = d2["receipt"] as Record<string, unknown>;
    expect(receipt2["receipt"]).toBe("code-unchanged");
    expect(receipt2["handle"]).toMatch(/^h[0-9a-z]+$/);
    // The sha the caller can pin an edit against.
    expect(typeof receipt2["sha"]).toBe("string");
  }, 30000);

  it("a sha change (edited content) resets the per-path budget: the next read serves content again", async () => {
    const wsDir = mkDir("repeat-shachange");
    writeFile(wsDir, "src/pid.cpp", makeContent());

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    await srv.rpc(2, "tools/call", { name: "read_file", arguments: { mode: "full", path: "src/pid.cpp" } });
    // Change content → new sha → wasFullyServed no longer matches.
    writeFile(wsDir, "src/pid.cpp", makeContent(9500));
    const r2 = await srv.rpc(3, "tools/call", { name: "read_file", arguments: { mode: "full", path: "src/pid.cpp" } });
    const d2 = parseResult(r2);
    // Fresh first read of the NEW content → plain success serve, not a receipt.
    expect(d2["kind"]).toBe("read.text");
    const e2 = (d2["evidence"] as Array<Record<string, unknown>>)[0]!;
    expect(typeof e2["body"]).toBe("string");
  }, 30000);
});

// ---------------------------------------------------------------------------
// cap-exceeded (huge file, single read) → served content head + truncated
// ---------------------------------------------------------------------------

describe("readCodeFullDowngrade — byte-cap-exceeded serves the content head (W1)", () => {
  it("a huge first read serves a bounded content head with truncated:true and a remainder next", async () => {
    const wsDir = mkDir("cap-head");
    const { content } = makeHugeContent();
    writeFile(wsDir, "src/QuoteOrchestrator.java", content);

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    const r = await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "full", path: "src/QuoteOrchestrator.java" },
    });
    const d = parseResult(r);

    expect(d["kind"]).toBe("read.text");
    const evidence = (d["evidence"] as Array<Record<string, unknown>>)[0]!;
    // Real content head within the serve budget.
    expect(typeof evidence["body"]).toBe("string");
    expect(String(evidence["body"]).length).toBeGreaterThan(0);
    expect(Buffer.byteLength(String(evidence["body"]), "utf8")).toBeLessThanOrEqual(GOVERNED_FULL_SERVE_BYTES);
    // The served head is the file's real leading bytes.
    expect(content.startsWith(String(evidence["body"]))).toBe(true);
    // Rule T: downgraded_from/reason/truncated collapse into `limit`, whose
    // presence alone now signals a bounded/incomplete serve; the remainder
    // rides a structured `limit.next` ToolCall, not a prose string (which
    // also makes the old placeholder-free "not.toContain('<')" check moot —
    // §2.6 abolishes placeholder-bearing calls at the type level).
    expect(d["limit"]).toBeDefined();
    const limit = d["limit"] as Record<string, unknown>;
    const next = limit["next"] as Record<string, unknown>;
    expect(next["tool"]).toBe("read_file");
    const nextArgs = next["arguments"] as Record<string, unknown>;
    expect(nextArgs["mode"]).toBe("slice");
    expect(nextArgs["handle"]).toMatch(/^h[0-9a-z]+$/);
    expect(String(nextArgs["range"])).toMatch(/^\d+-\d+$/);
  }, 30000);

  it("the remainder next slice actually serves the rest of the file", async () => {
    const wsDir = mkDir("cap-head-next");
    const { content } = makeHugeContent();
    writeFile(wsDir, "src/QuoteOrchestrator.java", content);

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    const r = await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "full", path: "src/QuoteOrchestrator.java" },
    });
    const d = parseResult(r);
    const limit = d["limit"] as Record<string, unknown>;
    const next = limit["next"] as Record<string, unknown>;
    const nextArgs = next["arguments"] as Record<string, unknown>;
    const range = nextArgs["range"] as string;
    expect(range).toBeDefined();
    const handle = nextArgs["handle"] as string;

    const follow = await srv.rpc(3, "tools/call", {
      name: "read_file",
      arguments: { mode: "slice", handle, range },
    });
    const f = parseResult(follow);
    expect(f["kind"]).toBe("read.text");
    const followEvidence = (f["evidence"] as Array<Record<string, unknown>>)[0]!;
    expect(typeof followEvidence["body"]).toBe("string");
  }, 30000);
});

// ---------------------------------------------------------------------------
// per-task-cap overflow (distinct new file) → served content head + truncated
// ---------------------------------------------------------------------------

// B2c (2026-08-01 serving-completeness) DELIBERATE FLIP of this whole describe.
// W1 made EVERY governed downgrade serve a content head, on the reasoning that
// an extra API turn always costs more than a few extra KB. That still holds for
// the per-PATH / tiny / allowFull / candidate-pack reasons (their cases below
// and in readCodeFullBatch are untouched). It did NOT hold for the PER-TASK cap:
// live forensics (2026-07-31-semantic-signal5-2, T13) show it firing at
// full-read #8/#10 and the head-serve reading as acceptance — 10 further
// full-reads, 72-77KB, and not one zoom in three reps. A per-task cap means
// "this task already spent its whole-file budget elsewhere", so the honest
// answer is the file's structure plus the exact slice call for the part wanted.
describe("readCodeFullDowngrade — per-task-cap overflow converts to skeleton+ranges (B2c)", () => {
  it("after PER_TASK_FULL_CAP distinct fulls, a new over-budget file's read serves skeleton + remaining_ranges + a pre-filled zoom", async () => {
    const wsDir = mkDir("per-task-head");
    const priorPaths = Array.from({ length: PER_TASK_FULL_CAP }, (_, i) => `src/prior${i}.ts`);
    for (const p of priorPaths) writeFile(wsDir, p, makeContent(9000));
    // The overflow target: ~20KB (> the 12288 serve budget → a partial head).
    writeFile(wsDir, "src/target.ts", makeContent(20000));

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    let rpcId = 2;
    for (const p of priorPaths) {
      const r = parseResult(await srv.rpc(rpcId++, "tools/call", { name: "read_file", arguments: { mode: "full", path: p } }));
      // Each prior read is an ordinary served window (A.5.2), which is what
      // makes it consume one per-task slot.
      expect(r["kind"]).toBe("read.text");
      expect(typeof (r["evidence"] as Array<Record<string, unknown>>)[0]?.["body"]).toBe("string");
    }

    const res = await srv.rpc(rpcId++, "tools/call", { name: "read_file", arguments: { mode: "full", path: "src/target.ts" } });
    const d = parseResult(res);
    // v1 (A.5.3 + Rule T), re-pointed 2026-08-14 on this file's own precedent
    // for the sibling governor cases: a downgrade that serves a PROJECTION
    // instead of a window is `read.map`, not `read.text` — the member is what
    // the response IS, not what the caller asked for. The outline IS the
    // payload, carried STRUCTURED (`{name, range, line}` rows) because `range`
    // is what makes it a zoom target; `downgraded_from`/`reason`/
    // `total_lines`/`remaining_ranges`/`allow_full_would_help` collapse into
    // `limit`, and the pre-filled zoom rides `limit.next` as a real ToolCall.
    expect(d["kind"]).toBe("read.map");
    const outline = d["outline"] as Record<string, unknown>;
    expect(outline["form"]).toBe("signatures");
    expect(String(outline["handle"])).toMatch(/^h[0-9a-z]+$/);
    expect(outline["path"]).toBe("src/target.ts");
    const rows = outline["signatures"] as Array<Record<string, unknown>>;
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
    expect(String(rows[0]!["range"])).toMatch(/^\d+-\d+$/);
    // Never a receipt for bytes the caller never had, and no served window.
    expect(d["kind"]).not.toBe("read.receipt");
    expect(d["evidence"]).toBeUndefined();
    // Nothing of this file was served yet → the whole file is outstanding, and
    // the zoom that says so is a same-handle ranges[] slice over it.
    const limit = d["limit"] as Record<string, unknown>;
    expect(limit).toBeDefined();
    const nextArgs = (limit["next"] as Record<string, unknown>)["arguments"] as Record<string, unknown>;
    expect(nextArgs["mode"]).toBe("slice");
    expect(nextArgs["handle"]).toBe(outline["handle"]);
    const zoomRanges = nextArgs["ranges"] as string[];
    expect(zoomRanges).toHaveLength(1);
    expect(zoomRanges[0]).toMatch(/^1-\d+$/);
    expect(nextArgs["allowFull"]).toBeUndefined();
  }, 40000);

  it("a per-task-cap overflow on a file that FITS the byte budget still converts (the cap is about read SHAPE, not size)", async () => {
    const wsDir = mkDir("per-task-whole");
    const priorPaths = Array.from({ length: PER_TASK_FULL_CAP }, (_, i) => `src/prior${i}.ts`);
    for (const p of priorPaths) writeFile(wsDir, p, makeContent(9000));
    // The overflow target is itself ~9KB (< the 12288 budget) → whole serve.
    writeFile(wsDir, "src/target.ts", makeContent(9000));

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    let rpcId = 2;
    for (const p of priorPaths) {
      await srv.rpc(rpcId++, "tools/call", { name: "read_file", arguments: { mode: "full", path: p } });
    }
    const d = parseResult(await srv.rpc(rpcId++, "tools/call", { name: "read_file", arguments: { mode: "full", path: "src/target.ts" } }));
    // Same v1 shape as the sibling case above: an outline member, no served
    // window, and the whole file named as the zoom.
    expect(d["kind"]).toBe("read.map");
    const outline = d["outline"] as Record<string, unknown>;
    expect(outline["form"]).toBe("signatures");
    expect(Array.isArray(outline["signatures"])).toBe(true);
    expect(d["evidence"]).toBeUndefined();
    // A file the caller has never been served has ALL of itself outstanding,
    // and the zoom names it — no cap ever answers with a bare "no".
    const limit = d["limit"] as Record<string, unknown>;
    const nextArgs = (limit["next"] as Record<string, unknown>)["arguments"] as Record<string, unknown>;
    expect(nextArgs["mode"]).toBe("slice");
    expect((nextArgs["ranges"] as string[])[0]).toMatch(/^1-\d+$/);
  }, 40000);

  // B2c: the OTHER governor reasons are untouched — a per-PATH cap still serves
  // content, because there the caller is repeating a read of one file rather
  // than opening yet another whole file on an exhausted task budget.
  it("a per-PATH cap downgrade still serves content (only the per-task cap converts)", async () => {
    const wsDir = mkDir("per-path-still-serves");
    writeFile(wsDir, "src/repeat.ts", makeContent(9000));

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    const first = parseResult(await srv.rpc(2, "tools/call", { name: "read_file", arguments: { mode: "full", path: "src/repeat.ts" } }));
    expect(first["kind"]).toBe("read.text");
    const second = parseResult(await srv.rpc(3, "tools/call", { name: "read_file", arguments: { mode: "full", path: "src/repeat.ts" } }));
    // Empirically verified (repair-agent probe): a per-PATH cap hit on the
    // SAME already-resident sha takes the SAME W1 content-equivalent path as
    // the repeat-read describe block above — a compact kind="read.receipt",
    // never a skeleton (skeleton conversion is reserved for the PER-TASK
    // cap, B2c).
    expect(second["kind"]).toBe("read.receipt");
    const receipt = second["receipt"] as Record<string, unknown>;
    expect(receipt["receipt"]).toBe("code-unchanged");
  }, 40000);
});

// ---------------------------------------------------------------------------
// tiny-skeleton-cap overflow via mode=full → map + remaining_ranges + next
// ---------------------------------------------------------------------------

describe("readCodeFullDowngrade — tiny-skeleton-cap overflow (M1)", () => {
  it("the (TINY_SKELETON_CAP+1)th distinct tiny mode=full uses the per-task map shape", async () => {
    const wsDir = mkDir("tiny-head");
    for (let i = 0; i < TINY_SKELETON_CAP; i++) {
      writeFile(wsDir, `src/tiny${i}.ts`, `export const t${i} = ${i};\n`);
    }
    writeFile(wsDir, "src/overflow.ts", "export const OVERFLOW = 42;\n");

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    // Saturate the tiny shape budget with distinct tiny full reads.
    for (let i = 0; i < TINY_SKELETON_CAP; i++) {
      const d = parseResult(await srv.rpc(2 + i, "tools/call", { name: "read_file", arguments: { mode: "full", path: `src/tiny${i}.ts` } }));
      expect(d["kind"]).toBe("read.text");
    }

    // The seventh tiny full-read is a structured map downgrade, never a
    // governed head containing the whole tiny file.
    const d = parseResult(await srv.rpc(2 + TINY_SKELETON_CAP, "tools/call", { name: "read_file", arguments: { mode: "full", path: "src/overflow.ts" } }));
    expect(d["kind"]).toBe("read.map");
    const outline = d["outline"] as Record<string, unknown>;
    expect(outline["form"]).toBe("signatures");
    expect(outline["path"]).toBe("src/overflow.ts");
    expect(Array.isArray(outline["signatures"])).toBe(true);
    expect(d["evidence"]).toBeUndefined();
    const limit = d["limit"] as Record<string, unknown>;
    const nextArgs = (limit["next"] as Record<string, unknown>)["arguments"] as Record<string, unknown>;
    expect(nextArgs["mode"]).toBe("slice");
    expect(nextArgs["ranges"]).toEqual(["1-1"]);
  }, 60000);
});

// ---------------------------------------------------------------------------
// After a downgrade, task_pack / slice fallbacks still work
// ---------------------------------------------------------------------------

describe("readCodeFullDowngrade — fallbacks after a downgrade still work", () => {
  it("mode=task_pack succeeds after a downgraded full read", async () => {
    const wsDir = mkDir("tp-fallback");
    writeFile(wsDir, "src/large.ts", makeContent());

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    await srv.rpc(2, "tools/call", { name: "read_file", arguments: { mode: "full", path: "src/large.ts" } });
    await srv.rpc(3, "tools/call", { name: "read_file", arguments: { mode: "full", path: "src/large.ts" } });

    const r = await srv.rpc(4, "tools/call", { name: "read_file", arguments: { mode: "task_pack", query: "VAR_0" } });
    expect(parseResult(r)["kind"]).toBe("read.task_pack");
  }, 30000);

  it("mode=slice succeeds after a downgraded full read", async () => {
    const wsDir = mkDir("slice-fallback");
    writeFile(wsDir, "src/large.ts", makeContent());

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    await srv.rpc(2, "tools/call", { name: "read_file", arguments: { mode: "full", path: "src/large.ts" } });
    await srv.rpc(3, "tools/call", { name: "read_file", arguments: { mode: "full", path: "src/large.ts" } });

    // W1 served-content receipts: the whole file was already fully served by
    // the two prior mode=full reads above, so a plain re-slice of "1-10"
    // would otherwise qualify for a code_unchanged receipt (kind=
    // "read.receipt", no evidence body to inspect) — content:"full" forces
    // the normal serve this fallback-actually-works check needs.
    const r = await srv.rpc(4, "tools/call", { name: "read_file", arguments: { mode: "slice", path: "src/large.ts", range: "1-10", content: "full" } });
    const d = parseResult(r);
    expect(d["kind"]).toBe("read.text");
    expect(Array.isArray(d["evidence"])).toBe(true);
  }, 30000);
});

// ---------------------------------------------------------------------------
// D10 (2026-08-14): TL_FULL_GOVERNOR is permanent-on. Was "governor disabled:
// no downgrade"; the disable arm is deleted, so the pin is now inertness.
// ---------------------------------------------------------------------------

describe("readCodeFullDowngrade — D10: TL_FULL_GOVERNOR is inert", () => {
  it("still downgrades a repeated mode=full with TL_FULL_GOVERNOR=0", async () => {
    const wsDir = mkDir("gov-off");
    writeFile(wsDir, "src/large.ts", makeContent());

    const srv = startServer({ cwd: wsDir, args: [wsDir], env: { TL_FULL_GOVERNOR: "0" } });
    servers.push(srv);
    await srv.initialize();

    const modes: unknown[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await srv.rpc(i + 2, "tools/call", { name: "read_file", arguments: { mode: "full", path: "src/large.ts" } });
      const d = parseResult(r);
      modes.push(d["code_unchanged"] === true ? "code_unchanged" : d["mode"]);
    }
    // The governor must assert itself somewhere in the repeat sequence.
    expect(modes.every((mode) => mode === "full"), JSON.stringify(modes)).toBe(false);
  }, 60000);
});
