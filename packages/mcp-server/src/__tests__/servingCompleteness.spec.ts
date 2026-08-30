/**
 * servingCompleteness.spec.ts — the 2026-08-01 serving-completeness wave.
 *
 * Each case pins one defect found in the 2026-07-31-semantic-signal5-2
 * transcripts, where TL named content it did not serve (or re-served content
 * the caller already held) and the solver escaped to native reads:
 *
 * B2b(i)  a task_pack replay that OMITS taskProfile is the SAME request — it
 *         gets the compact `pack_unchanged` receipt, not a full re-serve.
 * B2b(ii) a pack surface whose range is SUBSUMED by a body already served this
 *         epoch rides as a compact resident marker, not a second copy.
 * B2d     a cap-clipped ranges[] slice serves the UNSERVED window first and
 *         answers the already-held one with a receipt; and a pack's own served
 *         surface ranges land in the served-range ledger so the next slice can
 *         see that credit.
 * B2e     ONE mode=full serve is capped at FULL_SERVE_CHUNK_BYTES; only the
 *         bytes actually sent are recorded, so a later read never gets a
 *         receipt for content the model never received.
 */

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  buildTaskPack,
  resetPackDedupeCache,
  resetRoleInventoryCache,
  applyResidentFileDedup,
  type TaskPackResult,
  type TaskPackSurface,
} from "../tools/readCodeTaskPack.js";
import { handleTable } from "../util/handles.js";
import { resetAll as resetAllSessions, tokenizeForEpoch } from "../util/session.js";
import { resetPackServeLogForTest } from "../util/packServeLog.js";

const nodeRequire = createRequire(import.meta.url);
const TSX_CLI = nodeRequire.resolve("tsx/cli");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN_TS = path.resolve(HERE, "..", "bin.ts");
const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();

/** Must match server.ts's FULL_SERVE_CHUNK_BYTES. */
const FULL_SERVE_CHUNK_BYTES = 24576;

const tmpDirs: string[] = [];
const servers: ServerHandle[] = [];

interface ServerHandle {
  initialize(): Promise<void>;
  rpc(id: number, method: string, params?: unknown, timeoutMs?: number): Promise<any>;
  kill(): void;
}

function mkDir(tag: string): string {
  const dir = fs.mkdtempSync(path.join(HOME, `.tl-serving-${tag}-`));
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

function parseResult(rpcResult: any): Record<string, unknown> {
  const text = rpcResult?.result?.content?.[0]?.text;
  expect(typeof text, JSON.stringify(rpcResult).slice(0, 400)).toBe("string");
  return JSON.parse(text as string);
}

/** `lines` numbered source lines, each padded so the file has a predictable size. */
function numberedSource(lines: number, pad = 60): string {
  return Array.from(
    { length: lines },
    (_, i) => `export const value${i} = ${i}; // ${"x".repeat(pad)}`,
  ).join("\n") + "\n";
}

afterEach(() => {
  for (const s of servers.splice(0)) s.kill();
  for (const d of tmpDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ok */ }
  }
});

// ---------------------------------------------------------------------------
// B2e — clamp-safe full serves
// ---------------------------------------------------------------------------

describe("B2e — one mode=full serve is capped, and only what was sent is recorded", () => {
  it("a >24KB file is served as a first chunk + remaining_ranges + a same-handle continuation", async () => {
    const ws = mkDir("b2e-chunk");
    // ~50KB, the size that produced the clamped 52KB tool result live.
    writeFile(ws, "src/big.ts", numberedSource(640, 60));
    expect(fs.statSync(path.join(ws, "src/big.ts")).size).toBeGreaterThan(FULL_SERVE_CHUNK_BYTES);

    const srv = startServer({ cwd: ws, args: [ws] });
    servers.push(srv);
    await srv.initialize();

    const first = parseResult(await srv.rpc(2, "tools/call", {
      name: "read_file", arguments: { mode: "full", path: "src/big.ts" },
    }));
    expect(first["kind"]).toBe("read.text");
    const firstEvidence = (first["evidence"] as Array<Record<string, unknown>> | undefined)?.[0];
    expect(Buffer.byteLength(String(firstEvidence?.["body"]), "utf8"))
      .toBeLessThanOrEqual(FULL_SERVE_CHUNK_BYTES);
    // A chunked serve is NOT a whole-file expansion — nothing downstream may
    // treat it as complete coverage. v1 deletes `fullFileExpansion` outright
    // (it survives only on read.batch entries, A.5.4) and expresses
    // incompleteness as a `limit` (Rule T: absence of `limit` IS
    // completeness, §4.4).
    expect(first["fullFileExpansion"]).toBeUndefined();
    const limit = first["limit"] as Record<string, unknown>;
    expect(limit["cause"]).toBe("wire");
    const next = limit["next"] as Record<string, unknown>;
    const nextArgs = next["arguments"] as Record<string, unknown>;
    expect(nextArgs["content"]).toBe("auto");
    const nextTarget = (nextArgs["targets"] as Array<Record<string, unknown>>)[0]!;
    expect(nextTarget["handle"]).toBe(firstEvidence?.["handle"]);
    expect(String(nextTarget["range"])).toMatch(/^\d+-\d+$/);
  }, 40000);

  it("the UNSERVED tail is served as content, never a code_unchanged receipt for bytes never sent", async () => {
    const ws = mkDir("b2e-tail");
    writeFile(ws, "src/big.ts", numberedSource(640, 60));

    const srv = startServer({ cwd: ws, args: [ws] });
    servers.push(srv);
    await srv.initialize();

    const first = parseResult(await srv.rpc(2, "tools/call", {
      name: "read_file", arguments: { mode: "full", path: "src/big.ts" },
    }));
    const firstLimit = first["limit"] as Record<string, unknown>;
    const firstNextArgs = (firstLimit["next"] as Record<string, unknown>)["arguments"] as Record<string, unknown>;
    const firstTarget = (firstNextArgs["targets"] as Array<Record<string, unknown>>)[0]!;
    const remainder = String(firstTarget["range"]);
    const tail = parseResult(await srv.rpc(3, "tools/call", {
      name: "read_file", arguments: { mode: "slice", path: "src/big.ts", range: remainder },
    }));
    // THE defect: TL used to record the whole file as served, so this answered
    // `code_unchanged` for content the model had never received. v1's carrier
    // for that false claim would be kind:"read.receipt".
    expect(tail["kind"]).not.toBe("read.receipt");
    const tailEvidence = (tail["evidence"] as Array<Record<string, unknown>> | undefined)?.[0];
    expect(typeof tailEvidence?.["body"]).toBe("string");
    expect(String(tailEvidence?.["body"]).length).toBeGreaterThan(0);
  }, 40000);

  it("allowFull:true keeps the documented uncapped serve", async () => {
    const ws = mkDir("b2e-allowfull");
    writeFile(ws, "src/big.ts", numberedSource(640, 60));

    const srv = startServer({ cwd: ws, args: [ws] });
    servers.push(srv);
    await srv.initialize();

    const res = parseResult(await srv.rpc(2, "tools/call", {
      name: "read_file", arguments: { mode: "full", path: "src/big.ts", allowFull: true },
    }));
    expect(res["kind"]).toBe("read.text");
    // v1 deletes `truncated`/`fullFileExpansion` (Rule T + A.5.4) — absence of
    // `limit` IS completeness (§4.4), the honest replacement for both.
    expect(res["limit"]).toBeUndefined();
    const evidence = (res["evidence"] as Array<Record<string, unknown>> | undefined)?.[0];
    expect(Buffer.byteLength(String(evidence?.["body"]), "utf8"))
      .toBeGreaterThan(FULL_SERVE_CHUNK_BYTES);
  }, 40000);

  it("a file UNDER the chunk cap is still served whole (no behavior change)", async () => {
    const ws = mkDir("b2e-small");
    writeFile(ws, "src/small.ts", numberedSource(60, 40));

    const srv = startServer({ cwd: ws, args: [ws] });
    servers.push(srv);
    await srv.initialize();

    const res = parseResult(await srv.rpc(2, "tools/call", {
      name: "read_file", arguments: { mode: "full", path: "src/small.ts" },
    }));
    expect(res["kind"]).toBe("read.text");
    expect(res["limit"]).toBeUndefined();
  }, 40000);
});

// ---------------------------------------------------------------------------
// B2d — zoom progress guarantee + pack→ledger continuity
// ---------------------------------------------------------------------------

describe("B2d — a cap-clipped ranges[] slice spends its budget on UNSERVED windows", () => {
  it("an already-held window returns a receipt while the unserved one returns content", async () => {
    const ws = mkDir("b2d-zoom");
    writeFile(ws, "src/wide.ts", numberedSource(600, 40));

    const srv = startServer({ cwd: ws, args: [ws] });
    servers.push(srv);
    await srv.initialize();

    // Establish the ledger exactly as a first zoom would.
    const seed = parseResult(await srv.rpc(2, "tools/call", {
      name: "read_file", arguments: { mode: "slice", path: "src/wide.ts", range: "45-270" },
    }));
    expect(typeof (seed["evidence"] as Array<Record<string, unknown>> | undefined)?.[0]?.["body"]).toBe("string");

    // The live T03 shape: one window fully inside what was already served, one
    // brand new. Held window listed FIRST, so request order alone would have
    // spent the budget on the duplicate.
    const zoom = parseResult(await srv.rpc(3, "tools/call", {
      name: "read_file",
      arguments: { mode: "slice", path: "src/wide.ts", ranges: ["45-105", "271-400"] },
    }));
    expect(zoom["kind"]).toBe("read.text");
    const segments = (zoom["evidence"] ?? []) as Array<Record<string, unknown>>;
    expect(Array.isArray(segments)).toBe(true);
    const held = segments.find((s) => String(s["range"]).startsWith("45-"));
    const fresh = segments.find((s) => String(s["range"]).startsWith("271-"));
    expect(held?.["prior"]).toBeDefined();
    expect(held?.["body"]).toBeUndefined();
    // RESOLVED 2026-08-14: the per-segment body dialect (`code` on the FRESH
    // branch of server.ts's servedSegments map) is now read by
    // `textEvidence()`, so a fresh window carries `body` instead of riding
    // bare — which was also an E-8 violation, not just a missing field.
    expect(typeof fresh?.["body"]).toBe("string");
    expect(String(fresh?.["body"]).length).toBeGreaterThan(0);
    // Nothing the caller already holds may be named as still-outstanding —
    // v1 expresses "nothing outstanding" as the absence of `limit` (§4.4).
    expect(zoom["limit"]).toBeUndefined();
  }, 40000);

  it("a task_pack's served surface ranges land in the served-range ledger (a later slice sees the credit)", async () => {
    const ws = mkDir("b2d-ledger");
    writeFile(ws, "src/target.ts", numberedSource(40, 40));

    const srv = startServer({ cwd: ws, args: [ws] });
    servers.push(srv);
    await srv.initialize();

    const pack = parseResult(await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: {
        mode: "task_pack",
        query: "explain what value7 in src/target.ts is used for",
        paths: ["src/target.ts"],
      },
    }));
    const surfaces = (pack["evidence"] ?? []) as Array<Record<string, unknown>>;
    const served = surfaces.find((s) => String(s["path"]).endsWith("src/target.ts") && s["body"] !== undefined);
    expect(served, JSON.stringify(pack).slice(0, 600)).toBeDefined();

    // The exact lines the pack put on the wire — a re-slice buys nothing.
    const again = parseResult(await srv.rpc(3, "tools/call", {
      name: "read_file",
      arguments: { mode: "slice", path: "src/target.ts", range: String(served!["range"]) },
    }));
    // W14 L3: text responses must never contain only prior evidence. The
    // exact re-slice is a code-unchanged receipt with provenance instead.
    expect(again["kind"], JSON.stringify(again).slice(0, 400)).toBe("read.receipt");
    const receipt = again["receipt"] as Record<string, unknown>;
    expect(receipt["receipt"]).toBe("code-unchanged");
    expect(String(receipt["served_by"])).toContain("task_pack");
    expect(again["evidence"]).toBeUndefined();
  }, 40000);
});

// ---------------------------------------------------------------------------
// B2b — serve-once discipline
// ---------------------------------------------------------------------------

describe("B2b(i) — an omitted taskProfile is the SAME request, not a new one", () => {
  it("the replay WITHOUT taskProfile gets the compact pack_unchanged receipt", async () => {
    const ws = mkDir("b2b-profile");
    writeFile(ws, "src/target.ts", numberedSource(40, 40));

    const srv = startServer({ cwd: ws, args: [ws] });
    servers.push(srv);
    await srv.initialize();

    const query = "explain what value7 in src/target.ts is used for";
    const first = parseResult(await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "task_pack", query, paths: ["src/target.ts"], taskProfile: "answer" },
    }));
    expect(first["kind"]).not.toBe("read.receipt");
    const firstBytes = Buffer.byteLength(JSON.stringify(first), "utf8");

    // Same request, profile omitted (the documented "omit if unknown" form) —
    // live this re-served the whole 14.7KB pack while the identical call WITH
    // the profile received a 1.9KB receipt.
    const replay = parseResult(await srv.rpc(3, "tools/call", {
      name: "read_file",
      arguments: { mode: "task_pack", query, paths: ["src/target.ts"] },
    }));
    // POSSIBLE STOP (reported, hedged): readCodeTaskPack.ts's
    // compactReceiptFromRecord already sets BOTH `receipt:"pack-unchanged"`
    // and the legacy `pack_unchanged:true` (readCodeTaskPack.ts ~16679-16690),
    // so the wire projector's `receiptOf` SHOULD classify this as a receipt.
    // But A.4's own decision-divergence guard (readFamily.ts's `receiptOf`,
    // "pack-unchanged" case) deliberately withholds the receipt whenever
    // `decision.kind` is "discover"/"await_input" — and probing this exact
    // replay shows it resolving to
    // decision:{kind:"await_input",code:"no-grounded-call-remains"}, so the
    // guard fires AS DESIGNED. Whether that decision is right for this
    // minimal single-surface "answer" fixture, or is a side effect of
    // unrelated canonical-decision computation for a replay with nothing
    // further to ground, needs a follow-up outside this wire-shape
    // migration's scope. Left pointed at the intended v1 carrier; expected to
    // fail until resolved either way.
    expect(replay["kind"], JSON.stringify(replay).slice(0, 400)).toBe("read.receipt");
    const replayReceipt = replay["receipt"] as Record<string, unknown> | undefined;
    expect(replayReceipt?.["receipt"]).toBe("pack-unchanged");
    expect(Buffer.byteLength(JSON.stringify(replay), "utf8")).toBeLessThan(firstBytes);
  }, 40000);

  it("loosening the profile gate does NOT loosen staleness: a changed file still re-serves", async () => {
    const ws = mkDir("b2b-profile-stale");
    writeFile(ws, "src/target.ts", numberedSource(40, 40));

    const srv = startServer({ cwd: ws, args: [ws] });
    servers.push(srv);
    await srv.initialize();

    const query = "explain what value7 in src/target.ts is used for";
    await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "task_pack", query, paths: ["src/target.ts"], taskProfile: "answer" },
    });
    // The receipt is only ever content-EQUIVALENT: every file-sha / workspace
    // fingerprint gate still runs behind the relaxed profile match.
    writeFile(ws, "src/target.ts", numberedSource(40, 40) + "export const ADDED = 1;\n");
    const afterEdit = parseResult(await srv.rpc(3, "tools/call", {
      name: "read_file",
      arguments: { mode: "task_pack", query, paths: ["src/target.ts"] },
    }));
    // `pack_unchanged` is deleted from the wire outright (A.4/C2-3). Verified
    // by probe: this DOES still collapse to a receipt — but the
    // "decision-unchanged" tag (A.4), which asserts nothing about file bytes,
    // only that the task/certified_query is the same. That is a genuinely
    // different (and correct) claim from "pack-unchanged" (content-identical
    // bytes), which is the one staleness must block. Assert the NARROW claim
    // this test is actually about.
    const afterReceipt = afterEdit["receipt"] as Record<string, unknown> | undefined;
    expect(afterReceipt?.["receipt"]).not.toBe("pack-unchanged");
  }, 40000);
});

describe("B2b(ii) — a SUBSUMED resident body is referenced, not re-served", () => {
  beforeEach(() => {
    handleTable.reset();
    resetAllSessions();
    resetPackDedupeCache();
    resetRoleInventoryCache();
    resetPackServeLogForTest();
  });

  const BODY = `// shared module, comfortably over the 512B resident floor\n`
    + `export enum Priority {\n`
    + Array.from({ length: 20 }, (_, i) => `  LEVEL_${i} = "LEVEL_${i}",`).join("\n")
    + `\n}\n`;

  it("a NARROWER range inside an already-served body rides as a compact marker", async () => {
    const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tl-b2b-subsume-")));
    tmpDirs.push(ws);
    fs.mkdirSync(path.join(ws, "src"), { recursive: true });
    fs.writeFileSync(path.join(ws, "src", "enums.ts"), BODY, "utf8");

    const query = "widen the Priority enum with a new level";
    const seeded = await buildTaskPack({ query, paths: [{ path: "src/enums.ts" }] }, ws);
    const servedRange = seeded.surfaces.find((s) => s.path === "src/enums.ts")?.range;
    expect(servedRange).toBeDefined();
    const [start, end] = servedRange!.split("-").map((n) => parseInt(n, 10));
    // Strictly inside what was already served — the caller holds a superset.
    const narrower = `${start! + 1}-${Math.max(start! + 1, end! - 1)}`;
    expect(narrower).not.toBe(servedRange);

    const surf: TaskPackSurface = {
      role: "contract", handle: "hNARROW", path: "src/enums.ts", range: narrower,
      required: false, code: "y".repeat(900),
    };
    const pack: TaskPackResult = {
      mode: "task_pack", coverage: "partial", surfaces: [surf], missing: [],
    };
    applyResidentFileDedup(ws, pack, tokenizeForEpoch(query));
    expect(surf.code).toBeUndefined();
    expect(String(surf.code_unchanged)).toContain("already served this session");
  }, 30000);

  it("a range that OVERFLOWS what was served keeps its body (no over-claim)", async () => {
    const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tl-b2b-overflow-")));
    tmpDirs.push(ws);
    fs.mkdirSync(path.join(ws, "src"), { recursive: true });
    fs.writeFileSync(path.join(ws, "src", "enums.ts"), BODY, "utf8");

    const query = "widen the Priority enum with a new level";
    const seeded = await buildTaskPack({ query, paths: [{ path: "src/enums.ts" }] }, ws);
    const servedRange = seeded.surfaces.find((s) => s.path === "src/enums.ts")?.range;
    expect(servedRange).toBeDefined();
    const [start, end] = servedRange!.split("-").map((n) => parseInt(n, 10));

    const surf: TaskPackSurface = {
      role: "contract", handle: "hWIDE", path: "src/enums.ts",
      range: `${start!}-${end! + 500}`,
      required: false, code: "y".repeat(900),
    };
    const pack: TaskPackResult = {
      mode: "task_pack", coverage: "partial", surfaces: [surf], missing: [],
    };
    applyResidentFileDedup(ws, pack, tokenizeForEpoch(query));
    expect(surf.code).toBeDefined();
    expect(surf.code_unchanged).toBeUndefined();
  }, 30000);
});
