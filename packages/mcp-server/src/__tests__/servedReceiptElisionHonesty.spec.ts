// servedReceiptElisionHonesty.spec.ts
//
// *** RED TESTS — LEFT FAILING ON PURPOSE (2026-08-02 serve-honesty audit). ***
//
// These reproduce a served-range-ledger honesty defect: the ledger records the
// requested/served RANGE, while the wire carries range-minus-elided-comments.
// Every line a `doc elided L<a>-<b>` marker replaced is booked as "served", so
// a later read of exactly those lines answers with a `code_unchanged` receipt
// ("served earlier this session and unchanged") for bytes the caller has never
// received. Only `allowFull:true` / `content:"full"` can get them out.
//
// Recording sites (all three assert the same invariant from a different door):
//   1. server.ts  — mode=slice single range   (rangeLedger = recordServedRange,
//      actualEnd derived from the RAW sliceData.content, display elides)
//   2. server.ts  — mode=slice ranges[] batch (segEnd derived from the RAW
//      segment.code, display elides)
//   3. features/task-pack/readCodeTaskPack.ts — recordPackServedRanges /
//      packServedSpans record `surface.range` whole, while `surface.code`
//      carries the elision marker
//
// Live evidence: 2026-08-02 session over bench_score.py — `read_file
// mode=symbol symbol=score_run` returned `code_unchanged:true` with
// `note:"served earlier this session and unchanged"` when 135 of the symbol's
// 139 lines had never appeared in any response that session.
//
// Harness mirrors servedReceipts.spec.ts (child MCP server over a temp
// workspace => a genuinely fresh session per test).

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
  const dir = fs.mkdtempSync(path.join(HOME, `.tl-seh-${tag}-`));
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

  return {
    async initialize(): Promise<void> {
      await this.rpc(1, "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "vitest", version: "0" },
      });
    },
    rpc(id: number, method: string, params?: unknown, timeoutMs = 60000): Promise<any> {
      const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
      return new Promise((resolve, reject) => {
        const t = setTimeout(
          () => reject(new Error(`rpc timeout ${method}\n${stderr.slice(-2000)}`)),
          timeoutMs,
        );
        waiters.set(id, (m) => { clearTimeout(t); resolve(m); });
        child.stdin!.write(payload);
      });
    },
    kill(): void { child.kill("SIGKILL"); },
  };
}

afterEach(() => {
  while (servers.length) servers.pop()!.kill();
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function parseToolResult(rpcResult: any): Record<string, unknown> {
  const text: string = rpcResult?.result?.content?.[0]?.text;
  expect(typeof text).toBe("string");
  return JSON.parse(text);
}

/**
 * 40 lines: code 1-8, a line-start block comment spanning 9-29 (elided by
 * formatCompress.elideCBlockComments into ONE marker line), code 30-40.
 * Every comment line is uniquely greppable, so "did these bytes ship?" is a
 * substring test rather than a line count.
 */
function fileWithBlockComment(): string {
  const lines: string[] = [];
  for (let i = 1; i <= 8; i++) lines.push(`export const CODE_${i} = ${i};`);
  lines.push("/*");
  for (let i = 10; i <= 28; i++) lines.push(` * NEVER-SHIPPED-DOC-LINE-${i}`);
  lines.push(" */");
  for (let i = 30; i <= 40; i++) lines.push(`export const TAIL_${i} = ${i};`);
  return lines.join("\n") + "\n";
}

const ELIDED_PROBE = "NEVER-SHIPPED-DOC-LINE-15"; // file line 15, inside 9-29

describe("RED (2026-08-02 serve-honesty): the ledger books elided comment lines as served", () => {
  it("RED: mode=slice single range — a window whose only content was a 'doc elided' marker is receipted", async () => {
    const wsDir = mkDir("single");
    writeFile(wsDir, "src/wide.ts", fileWithBlockComment());

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    // 1) A wide slice. The block comment is replaced by ONE marker line, so
    //    lines 9-29 never reach the caller.
    const wide = parseToolResult(await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "slice", path: "src/wide.ts", range: "1-40" },
    }));
    const wideEvidence = (wide["evidence"] as Array<Record<string, unknown>> | undefined)?.[0];
    const wideContent = String(wideEvidence?.["body"] ?? "");
    expect(wideContent).toContain("doc elided");
    expect(wideContent).not.toContain(ELIDED_PROBE); // proof: not on the wire

    // 2) Ask for exactly the elided window. It has never been served.
    const zoom = parseToolResult(await srv.rpc(3, "tools/call", {
      name: "read_file",
      // This test audits the served-range ledger, not a prepared certificate.
      // Declare the direct slice as the next task so P0's same-task fence
      // cannot turn the assertion into a prepared receipt before the ledger
      // sees the never-shipped comment window.
      arguments: { mode: "slice", path: "src/wide.ts", range: "12-20", taskEpoch: "new" },
    }));

    // THE INVARIANT: a receipt may only stand for bytes the caller received —
    // v1's carrier for a false receipt would be kind:"read.receipt" (A.4's
    // code-unchanged tag); the fix means this call must NOT collapse to one.
    expect(zoom["kind"]).not.toBe("read.receipt");
    const zoomEvidence = (zoom["evidence"] as Array<Record<string, unknown>> | undefined)?.[0];
    expect(typeof zoomEvidence?.["body"]).toBe("string");
    expect(String(zoomEvidence?.["body"])).toContain(ELIDED_PROBE);
  }, 60000);

  it("RED: mode=slice ranges[] batch — the same hole through the multi-window door", async () => {
    const wsDir = mkDir("batch");
    writeFile(wsDir, "src/wide.ts", fileWithBlockComment());

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    // RESOLVED 2026-08-14: `textEvidence()` reads the per-segment `code`
    // dialect the ranges[] batch handler emits (server.ts's servedSegments
    // map), so a batch segment carries its `body` instead of shipping bare —
    // the latter also violated A.8's E-8 invariant (`!body` => `prior` or
    // `remaining`), which is why this whole test was the manifestation.
    const first = parseToolResult(await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "slice", path: "src/wide.ts", ranges: ["1-40"] },
    }));
    const firstText = JSON.stringify(first);
    expect(firstText).toContain("doc elided");
    expect(firstText).not.toContain(ELIDED_PROBE);

    const second = parseToolResult(await srv.rpc(3, "tools/call", {
      name: "read_file",
      arguments: { mode: "slice", path: "src/wide.ts", ranges: ["12-20", "30-34"] },
    }));
    // Both windows must not read as "already held" — v1's carrier for a
    // whole-batch over-claim would be the response collapsing to a single
    // read.receipt (A.4's code-unchanged tag) with no evidence at all.
    expect(second["kind"], "whole-batch receipt for never-shipped bytes").not.toBe("read.receipt");
    const segments = (second["evidence"] ?? []) as Array<Record<string, unknown>>;
    const elidedWindow = segments.find((s) => String(s["range"]) === "12-20");
    expect(elidedWindow, "the 12-20 window must come back as a segment").toBeDefined();
    expect(elidedWindow!["prior"]).toBeUndefined();
    expect(String(elidedWindow!["body"] ?? "")).toContain(ELIDED_PROBE);
  }, 60000);

  it("RED: task_pack — recordPackServedRanges books a surface's whole range, elisions included", async () => {
    const wsDir = mkDir("pack");
    writeFile(wsDir, "src/wide.ts", fileWithBlockComment());

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    // A pack surface over src/wide.ts. Its `code` carries the elision marker;
    // packServedSpans records `surface.range` in full.
    const pack = parseToolResult(await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: {
        mode: "task_pack",
        query: "what constants does src/wide.ts export",
        paths: ["src/wide.ts"],
      },
    }));
    const packText = JSON.stringify(pack);
    expect(packText).not.toContain(ELIDED_PROBE); // the pack never shipped them

    const zoom = parseToolResult(await srv.rpc(3, "tools/call", {
      name: "read_file",
      // This test audits the served-range ledger, not a prepared certificate.
      // Retain the same session ledger but declare this direct slice a new task
      // so P0's same-task fence cannot pre-empt the ledger assertion.
      arguments: { mode: "slice", path: "src/wide.ts", range: "12-20", taskEpoch: "new" },
    }));
    expect(zoom["kind"]).not.toBe("read.receipt");
    const zoomEvidence = (zoom["evidence"] as Array<Record<string, unknown>> | undefined)?.[0];
    expect(String(zoomEvidence?.["body"] ?? "")).toContain(ELIDED_PROBE);
  }, 60000);
});

// ---------------------------------------------------------------------------
// *** RED WAVE 2 (2026-08-02, external review) — THE WHOLE-FILE DOORS. ***
//
// The first wave closed the slice/batch/pack/symbol recording sites but left
// two whole-file sites booking a flat 1..totalLines:
//   server.ts mode=full complete serve   (default-on path)
//   server.ts adaptive whole-file expansion, expanded_from:"slice-demand"
//     (TL_ADAPTIVE_WHOLE_FILE, default OFF)
// Both serve `elideDocCommentsForDisplay(content, ...)`, so a comment block is
// a single marker on the wire while every one of its lines is booked as served
// — the same false `code_unchanged` receipt through a wider door.
//
// The third test here is the LOOP GUARD, and it is the real hazard of fixing
// the other two: once a full serve records HONEST spans, a comment-bearing
// file's ledger is permanently `complete:false` with >= 3 clusters, which is
// exactly the adaptive governor's trigger. Without a guard, every subsequent
// slice re-expands the whole file, which again does not cover the elided lines
// — an unbounded re-serve loop. The guard must come from the SEPARATE
// per-task full-serve ledger (recordFullServeCompleteness / wasFullyServed),
// which answers the different question "has a whole-file serve already
// happened for this sha?" and must not be conflated with range coverage.
// ---------------------------------------------------------------------------

describe("RED wave 2 (2026-08-02 serve-honesty): whole-file serves book their elided lines", () => {
  it("RED: mode=full — a whole-file serve books the comment block it never sent", async () => {
    const wsDir = mkDir("full");
    writeFile(wsDir, "src/wide.ts", fileWithBlockComment());

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    const full = parseToolResult(await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "full", path: "src/wide.ts" },
    }));
    // v1 deletes `fullFileExpansion` (it survives only on read.batch entries,
    // A.5.4). The honest proof this was a genuine whole-file serve is that
    // BOTH ends of the file rode in the one evidence entry — `range` itself
    // tracks the DISPLAYED line count post-elision, not the file's own length
    // (textEvidence's own comment: "names the lines the caller HOLDS, not the
    // lines the file has"), so it cannot be compared against total_lines here.
    const fullEvidence = (full["evidence"] as Array<Record<string, unknown>> | undefined)?.[0];
    expect(fullEvidence?.["body"], JSON.stringify(full).slice(0, 400)).toContain("CODE_1");
    expect(fullEvidence?.["body"]).toContain("TAIL_40");
    expect(String(fullEvidence?.["body"] ?? "")).toContain("doc elided");
    expect(String(fullEvidence?.["body"] ?? "")).not.toContain(ELIDED_PROBE); // proof: not on the wire

    const zoom = parseToolResult(await srv.rpc(3, "tools/call", {
      name: "read_file",
      arguments: { mode: "slice", path: "src/wide.ts", range: "12-20" },
    }));
    expect(zoom["kind"], "receipt for bytes the full serve elided").not.toBe("read.receipt");
    const zoomEvidence = (zoom["evidence"] as Array<Record<string, unknown>> | undefined)?.[0];
    expect(String(zoomEvidence?.["body"] ?? "")).toContain(ELIDED_PROBE);
  }, 60000);

  it("RED: adaptive whole-file expansion — the same hole through the slice-demand door", async () => {
    const wsDir = mkDir("adaptive");
    writeFile(wsDir, "src/wide.ts", fileWithBlockComment());

    const srv = startServer({
      cwd: wsDir, args: [wsDir], env: { TL_ADAPTIVE_WHOLE_FILE: "1" },
    });
    servers.push(srv);
    await srv.initialize();

    // Three non-contiguous demands: the third crosses clusters >= 3 and the
    // governor answers with one bounded whole-file serve instead.
    await srv.rpc(2, "tools/call", {
      name: "read_file", arguments: { mode: "slice", path: "src/wide.ts", range: "1-2" },
    });
    await srv.rpc(3, "tools/call", {
      name: "read_file", arguments: { mode: "slice", path: "src/wide.ts", range: "4-5" },
    });
    const expanded = parseToolResult(await srv.rpc(4, "tools/call", {
      name: "read_file", arguments: { mode: "slice", path: "src/wide.ts", range: "31-32" },
    }));
    // v1 deletes `expanded_from` (same Rule-T coarsening as `fullFileExpansion`)
    // — the honest proof this escalated to a genuine whole-file serve is both
    // ends of the file riding in the one evidence entry.
    const expandedEvidence = (expanded["evidence"] as Array<Record<string, unknown>> | undefined)?.[0];
    expect(expandedEvidence?.["body"], JSON.stringify(expanded).slice(0, 400)).toContain("CODE_1");
    expect(expandedEvidence?.["body"]).toContain("TAIL_40");
    expect(String(expandedEvidence?.["body"] ?? "")).not.toContain(ELIDED_PROBE);

    const zoom = parseToolResult(await srv.rpc(5, "tools/call", {
      name: "read_file",
      arguments: { mode: "slice", path: "src/wide.ts", range: "12-20" },
    }));
    expect(zoom["kind"], "receipt for bytes the expansion elided").not.toBe("read.receipt");
    const zoomEvidence = (zoom["evidence"] as Array<Record<string, unknown>> | undefined)?.[0];
    expect(String(zoomEvidence?.["body"] ?? "")).toContain(ELIDED_PROBE);
  }, 60000);

  it("LOOP GUARD: a zoom into elided lines after a whole-file serve must not re-expand the file", async () => {
    const wsDir = mkDir("loop");
    writeFile(wsDir, "src/wide.ts", fileWithBlockComment());

    // The governor ON is the hazardous configuration: honest full-serve spans
    // leave the ledger at clusters>=3 + complete:false forever on a
    // comment-bearing file, which is precisely this governor's trigger.
    const srv = startServer({
      cwd: wsDir, args: [wsDir], env: { TL_ADAPTIVE_WHOLE_FILE: "1" },
    });
    servers.push(srv);
    await srv.initialize();

    const full = parseToolResult(await srv.rpc(2, "tools/call", {
      name: "read_file", arguments: { mode: "full", path: "src/wide.ts" },
    }));
    const fullEvidence = (full["evidence"] as Array<Record<string, unknown>> | undefined)?.[0];
    expect(fullEvidence?.["body"]).toContain("CODE_1");
    expect(fullEvidence?.["body"]).toContain("TAIL_40");

    const zoom = parseToolResult(await srv.rpc(3, "tools/call", {
      name: "read_file", arguments: { mode: "slice", path: "src/wide.ts", range: "12-20" },
    }));
    // It must be a SLICE of the requested window carrying the real bytes...
    // v1 deletes `expanded_from`/`fullFileExpansion` (Rule T coarsening) — the
    // `range` itself IS the loop-guard proof now: a re-expansion of the whole
    // file would show up here as the post-elision display range ("1-20", see
    // the full-serve test above) instead of the targeted "12-20".
    const zoomEvidence = (zoom["evidence"] as Array<Record<string, unknown>> | undefined)?.[0];
    expect(zoomEvidence?.["range"], JSON.stringify(zoom).slice(0, 400)).toBe("12-20");
    expect(String(zoomEvidence?.["body"] ?? "")).toContain(ELIDED_PROBE);

    // And a THIRD call still makes progress rather than looping.
    const again = parseToolResult(await srv.rpc(4, "tools/call", {
      name: "read_file", arguments: { mode: "slice", path: "src/wide.ts", range: "21-25" },
    }));
    const againEvidence = (again["evidence"] as Array<Record<string, unknown>> | undefined)?.[0];
    expect(againEvidence?.["range"]).toBe("21-25");
    expect(String(againEvidence?.["body"] ?? "")).toContain("NEVER-SHIPPED-DOC-LINE-21");
  }, 60000);

  it("GUARD (anti-over-correction): after a full serve, a NON-elided window is still receipted, and names its source", async () => {
    const wsDir = mkDir("full-honest");
    writeFile(wsDir, "src/wide.ts", fileWithBlockComment());

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    const full = parseToolResult(await srv.rpc(2, "tools/call", {
      name: "read_file", arguments: { mode: "full", path: "src/wide.ts" },
    }));
    const fullEvidence = (full["evidence"] as Array<Record<string, unknown>> | undefined)?.[0];
    expect(fullEvidence?.["body"]).toContain("CODE_1");
    expect(fullEvidence?.["body"]).toContain("TAIL_40");

    // Lines 30-34 are real code the full serve genuinely put on the wire.
    const held = parseToolResult(await srv.rpc(3, "tools/call", {
      name: "read_file", arguments: { mode: "slice", path: "src/wide.ts", range: "30-34" },
    }));
    expect(held["kind"], JSON.stringify(held).slice(0, 400)).toBe("read.receipt");
    const heldReceipt = held["receipt"] as Record<string, unknown>;
    expect(heldReceipt["receipt"]).toBe("code-unchanged");
    expect(held["evidence"]).toBeUndefined();
    expect(String(heldReceipt["served_by"] ?? "")).toContain("full 1-40 (call #");
  }, 60000);
});
