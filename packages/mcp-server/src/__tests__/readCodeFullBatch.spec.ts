/**
 * readCodeFullBatch.spec.ts — `read_code mode=full paths=[...]` (2+ entries).
 *
 * Bench-observed gap: mode=full only ever accepted a single `path` — a caller
 * that supplied `paths=[a,b]` got "path is required" and re-issued one
 * read_code call per file (an avoidable extra round trip per file beyond the
 * first). This adds batch support: each path is evaluated INDEPENDENTLY
 * through the SAME resolveFullReadForPath helper (server.ts) the single-path
 * branch uses — byte cap, PER_PATH_FULL_CAP/PER_TASK_FULL_CAP, C5 auto-allow —
 * so no cap is weakened by batching.
 *
 * Covers:
 *   - both-served: two small distinct files both come back with content.
 *   - first-served-second-downgraded: PER_TASK_FULL_CAP is pre-exhausted by
 *     (PER_TASK_FULL_CAP-1) prior single-path full reads, then a 2-item batch
 *     is sent — batch item 1 (the PER_TASK_FULL_CAP-th overall) is served,
 *     item 2 (the next) downgrades — proving the governor's PER-TASK budget
 *     is shared across single-path calls and a later batch call, not reset
 *     per call shape.
 *   - single-path (paths omitted, or a 1-entry paths[]) behavior is unchanged.
 *   - object-shaped paths[] items ({path: "..."}) are also accepted, matching
 *     mode=pack/task_pack's existing paths[] item convention.
 *   - a nonexistent path in the batch folds into `omitted`, not a whole-batch
 *     abort — the other (existing) path in the same batch still succeeds.
 *
 * Uses the same spawned-server-over-stdio pattern as readCodeFullDowngrade.spec.ts.
 */

import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { PER_TASK_FULL_CAP } from "../util/fullGovernor.js";

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
  const dir = fs.mkdtempSync(path.join(HOME, `.tl-fullbatch-${tag}-`));
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

/** A small file, well under every full-read byte cap. */
function smallFileContent(tag: string): string {
  return `export const TAG = "${tag}";\nexport function hello() { return "${tag}"; }\n`;
}

/**
 * A NON-TINY file (over TINY_BYTES=8192 or TINY_LINES=250) but still under
 * READ_FULL_CAP_BYTES=12288 — consumes PER_TASK_FULL_CAP budget (tiny files
 * are exempt from it) without triggering a byte-cap downgrade. Mirrors
 * readCodeFullDowngrade.spec.ts's makeLargeContent (targets ~9000 bytes).
 */
function makeNonTinyContent(targetBytes = 9000): string {
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

// ---------------------------------------------------------------------------
// both-served
// ---------------------------------------------------------------------------

describe("read_code mode=full paths=[...] — both served", () => {
  it("two small distinct paths both come back with content, in request order", async () => {
    const ws = mkDir("both-served");
    writeFile(ws, "src/a.ts", smallFileContent("A"));
    writeFile(ws, "src/b.ts", smallFileContent("B"));

    const srv = startServer({ cwd: ws, args: [ws] });
    servers.push(srv);
    await srv.initialize();

    const res = await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "full", paths: ["src/a.ts", "src/b.ts"] },
    });
    const data = parseResult(res);

    expect(data["kind"]).toBe("read.batch");
    // Rule T: absence of `limit` IS completeness — there is no separate
    // omitted[] ledger to check is empty.
    expect(data["limit"]).toBeUndefined();
    const entries = data["entries"] as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(2);

    // Request order preserved.
    expect(entries[0]!["path"]).toBe("src/a.ts");
    expect(entries[1]!["path"]).toBe("src/b.ts");

    // Each item carries the same fields a single-path mode=full response would.
    for (const entry of entries) {
      expect(entry["form"]).toBe("file");
      expect(entry["fullFileExpansion"]).toBe(true);
      expect(typeof entry["content"]).toBe("string");
      expect(typeof entry["handle"]).toBe("string");
      expect(typeof entry["sha"]).toBe("string");
      expect(entry["truncated"]).toBe(false);
    }
    expect(String(entries[0]!["content"])).toContain('"A"');
    expect(String(entries[1]!["content"])).toContain('"B"');
  }, 30000);

  it("accepts the {path:...} object item shape too (mode=pack/task_pack convention)", async () => {
    const ws = mkDir("object-shape");
    writeFile(ws, "src/x.ts", smallFileContent("X"));
    writeFile(ws, "src/y.ts", smallFileContent("Y"));

    const srv = startServer({ cwd: ws, args: [ws] });
    servers.push(srv);
    await srv.initialize();

    const res = await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "full", paths: [{ path: "src/x.ts" }, { path: "src/y.ts" }] },
    });
    const data = parseResult(res);

    expect(data["kind"]).toBe("read.batch");
    const entries = data["entries"] as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(2);
    expect(entries[0]!["path"]).toBe("src/x.ts");
    expect(entries[1]!["path"]).toBe("src/y.ts");
  }, 30000);
});

// ---------------------------------------------------------------------------
// first-served-second-downgraded — drives PER_TASK_FULL_CAP to its cap
// ---------------------------------------------------------------------------

describe("read_code mode=full paths=[...] — governor cap is shared across single calls and a later batch", () => {
  it(`${PER_TASK_FULL_CAP - 1} prior single-path full reads + a 2-item batch: batch item 1 (${PER_TASK_FULL_CAP}th overall) served, batch item 2 (${PER_TASK_FULL_CAP + 1}th overall) downgraded`, async () => {
    const ws = mkDir("cap-shared");
    // PER_TASK_FULL_CAP-1 prior single-path reads (imported constant, so this
    // stays correct across a future cap change — 2026-07-16a raised it 3->6).
    const priorPaths = Array.from({ length: PER_TASK_FULL_CAP - 1 }, (_, i) => `src/prior${i}.ts`);
    for (const p of priorPaths) writeFile(ws, p, makeNonTinyContent());
    writeFile(ws, "src/three.ts", makeNonTinyContent());
    writeFile(ws, "src/four.ts", makeNonTinyContent());

    const srv = startServer({ cwd: ws, args: [ws] });
    servers.push(srv);
    await srv.initialize();

    // Pre-exhaust PER_TASK_FULL_CAP-1 of PER_TASK_FULL_CAP's slots via
    // ordinary single-path calls.
    let rpcId = 2;
    for (const p of priorPaths) {
      const r = await srv.rpc(rpcId++, "tools/call", { name: "read_file", arguments: { mode: "full", path: p } });
      expect(parseResult(r)["kind"]).toBe("read.text");
    }

    // Now a 2-item batch on two NEW distinct paths: batch item 1 (the
    // PER_TASK_FULL_CAP-th full-read overall) has budget left and is served;
    // batch item 2 (the next, over PER_TASK_FULL_CAP) is served-downgraded
    // instead.
    const res = await srv.rpc(rpcId++, "tools/call", {
      name: "read_file",
      arguments: { mode: "full", paths: ["src/three.ts", "src/four.ts"] },
    });
    const data = parseResult(res);

    expect(data["kind"]).toBe("read.batch");
    // Rule T: both items PRESENT (one served, one served-downgraded) —
    // nothing OMITTED from the batch, so `limit` is absent (a degraded FORM
    // is not a Rule T withholding).
    expect(data["limit"]).toBeUndefined();
    const entries = data["entries"] as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(2);

    // Item 1 (the PER_TASK_FULL_CAP-th full-read overall): served with content.
    expect(entries[0]!["path"]).toBe("src/three.ts");
    expect(entries[0]!["form"]).toBe("file");
    expect(entries[0]!["fullFileExpansion"]).toBe(true);
    expect(typeof entries[0]!["content"]).toBe("string");

    // Item 2 (the (PER_TASK_FULL_CAP+1)th full-read overall): served-downgraded.
    //
    // B2c (2026-08-01 serving-completeness) DELIBERATE FLIP: this used to assert
    // mode:"full" + a served content head. Live forensics
    // (2026-07-31-semantic-signal5-2, T13) showed the head-serve read as
    // ACCEPTANCE — the per-task cap fired at full-read #8/#10, the solver was
    // handed 12KB of head each time and never once zoomed. The PER-TASK cap
    // (only that one) now converts to skeleton + remaining_ranges + a pre-filled
    // same-handle zoom. Every other governor reason still serves content, and a
    // paths[] item still gets exactly what a single-path call would.
    //
    // C2-3: the batch entry's own DOWNGRADE_FIELDS keep-list preserves
    // downgraded_from/reason/skeleton/next by their OLD names directly on
    // the entry (unlike read.text, a batch downgrade is NOT collapsed into
    // `limit`) — only the old `mode:"skeleton"` label is gone, replaced by
    // the Rule K discriminator `form:"file-downgraded"`.
    expect(entries[1]!["path"]).toBe("src/four.ts");
    expect(entries[1]!["form"]).toBe("file-downgraded");
    expect(entries[1]!["downgraded_from"]).toBe("full");
    expect(entries[1]!["reason"]).toBe("per-task-cap-reached");
    expect(Array.isArray(entries[1]!["skeleton"])).toBe(true);
    expect(entries[1]!["content"]).toBeUndefined();
    expect(String(entries[1]!["next"])).toContain("mode=slice");
    expect(String(entries[1]!["next"])).toContain("ranges=");
  }, 30000);
});

// ---------------------------------------------------------------------------
// single-path behavior unchanged
// ---------------------------------------------------------------------------

describe("read_code mode=full — single-path behavior is unchanged by the paths[] batch addition", () => {
  it("a plain single path (no paths[]) still returns the ORIGINAL single-object shape, not a batch envelope", async () => {
    const ws = mkDir("single-unchanged");
    writeFile(ws, "src/solo.ts", smallFileContent("SOLO"));

    const srv = startServer({ cwd: ws, args: [ws] });
    servers.push(srv);
    await srv.initialize();

    const res = await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "full", path: "src/solo.ts" },
    });
    const data = parseResult(res);

    expect(data["kind"]).toBe("read.text");
    const evidence = (data["evidence"] as Array<Record<string, unknown>>)[0]!;
    expect(evidence["path"]).toBe("src/solo.ts");
    expect(typeof evidence["body"]).toBe("string");
    // Not the batch envelope shape.
    expect(data["entries"]).toBeUndefined();
    expect(data["limit"]).toBeUndefined();
  }, 30000);
});

// ---------------------------------------------------------------------------
// 1-entry paths[] is served by the batch branch (2026-07-09e: >=2 threshold
// lowered to >=1 — a 1-entry paths[] used to fall through to the singular
// branch below, which only ever reads top-level `path`, never paths[0], and
// hard-errored "path is required". Observed twice in the 2026-07-09e bench
// run, each a wasted round trip.)
// ---------------------------------------------------------------------------

describe("read_code mode=full paths=[...] — a 1-entry batch is served, not rejected", () => {
  it("a 1-entry paths[] is served by the batch branch (>=1, not >=2)", async () => {
    const ws = mkDir("single-entry-paths");
    writeFile(ws, "src/solo2.ts", smallFileContent("SOLO2"));

    const srv = startServer({ cwd: ws, args: [ws] });
    servers.push(srv);
    await srv.initialize();

    const res = await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "full", paths: ["src/solo2.ts"] },
    });
    const data = parseResult(res);

    expect(data["kind"]).toBe("read.batch");
    expect(data["limit"]).toBeUndefined();
    const entries = data["entries"] as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(1);
    expect(entries[0]!["path"]).toBe("src/solo2.ts");
    expect(entries[0]!["fullFileExpansion"]).toBe(true);
    expect(String(entries[0]!["content"])).toContain('"SOLO2"');
  }, 30000);
});

// ---------------------------------------------------------------------------
// nonexistent path in the batch folds into omitted, does not abort the batch
// ---------------------------------------------------------------------------

describe("read_code mode=full paths=[...] — a nonexistent path omits, does not abort the batch", () => {
  it("one existing + one nonexistent path: the existing one is served, the nonexistent one is omitted", async () => {
    const ws = mkDir("partial-notfound");
    writeFile(ws, "src/real.ts", smallFileContent("REAL"));

    const srv = startServer({ cwd: ws, args: [ws] });
    servers.push(srv);
    await srv.initialize();

    const res = await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "full", paths: ["src/real.ts", "src/does-not-exist.ts"] },
    });
    const data = parseResult(res);

    expect(data["kind"]).toBe("read.batch");
    const entries = data["entries"] as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(1);
    expect(entries[0]!["path"]).toBe("src/real.ts");
    expect(typeof entries[0]!["content"]).toBe("string");

    // Rule T: the per-item omitted[] {path,reason} ledger is deleted; the
    // specific reason string collapses to the coarse `limit.omitted` class,
    // and the missing PATH survives via the synthesized recovery call
    // instead of a dedicated ledger entry.
    const limit = data["limit"] as Record<string, unknown>;
    expect(limit).toBeDefined();
    expect(limit["omitted"]).toEqual(["evidence"]);
    const next = limit["next"] as Record<string, unknown>;
    expect((next["arguments"] as Record<string, unknown>)["paths"]).toContain("src/does-not-exist.ts");
  }, 30000);

  it("all-nonexistent paths: completeness is 'empty', items is []", async () => {
    const ws = mkDir("all-notfound");
    fs.mkdirSync(path.join(ws, "src"), { recursive: true });

    const srv = startServer({ cwd: ws, args: [ws] });
    servers.push(srv);
    await srv.initialize();

    const res = await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "full", paths: ["src/nope1.ts", "src/nope2.ts"] },
    });
    const data = parseResult(res);

    expect(data["kind"]).toBe("read.batch");
    expect(data["entries"]).toEqual([]);
    const limit = data["limit"] as Record<string, unknown>;
    expect(limit).toBeDefined();
    expect(limit["omitted"]).toEqual(["evidence"]);
    const next = limit["next"] as Record<string, unknown>;
    expect((next["arguments"] as Record<string, unknown>)["paths"]).toEqual(["src/nope1.ts", "src/nope2.ts"]);
  }, 30000);
});

// ---------------------------------------------------------------------------
// a directory entry in the batch: resolveFullReadForPath can't distinguish
// "missing" from "is a directory" (readFileSafe's fs.readFile throws EISDIR,
// caught the same as ENOENT) and reports the generic not-found wording either
// way — the batch branch re-stats to swap in an actionable reason instead.
// ---------------------------------------------------------------------------

describe("read_code mode=full paths=[...] — a directory entry omits with a helpful reason", () => {
  it("one existing file + one directory: the file is served, the directory omits with a directory-specific reason (not the generic not-found wording)", async () => {
    const ws = mkDir("partial-directory");
    writeFile(ws, "src/real2.ts", smallFileContent("REAL2"));
    fs.mkdirSync(path.join(ws, "src", "adir"), { recursive: true });

    const srv = startServer({ cwd: ws, args: [ws] });
    servers.push(srv);
    await srv.initialize();

    const res = await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "full", paths: ["src/real2.ts", "src/adir"] },
    });
    const data = parseResult(res);

    expect(data["kind"]).toBe("read.batch");
    const entries = data["entries"] as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(1);
    expect(entries[0]!["path"]).toBe("src/real2.ts");

    // Rule T: the per-item omitted[] {path,reason} ledger — including this
    // test's whole point, the directory-specific vs generic-not-found reason
    // TEXT — is deleted; only the coarse `limit.omitted` class and the
    // missing PATH (via the recovery call) remain wire-visible.
    const limit = data["limit"] as Record<string, unknown>;
    expect(limit).toBeDefined();
    expect(limit["omitted"]).toEqual(["evidence"]);
    const next = limit["next"] as Record<string, unknown>;
    expect((next["arguments"] as Record<string, unknown>)["paths"]).toContain("src/adir");
  }, 30000);
});
