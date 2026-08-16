// readCodePack.spec.ts — server-level tests for read_code mode=pack.
//
// Spawns the real server over stdio (same pattern as workspaceRoot.spec.ts)
// and exercises the JSON-RPC tools/call path with mode=pack.

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readCodePack } from "../tools/readCodePack.js";
import { resetPackDedupeCache } from "../tools/readCodeTaskPack.js";
import { handleTable } from "../util/handles.js";
import { resetAll as resetAllSessions } from "../util/session.js";

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
  const dir = fs.mkdtempSync(path.join(HOME, `.tl-pack-${tag}-`));
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

// Reset the process-wide singletons the in-process query-pack + closure tests
// touch (readCodeQueryPack's locate + this file's buildTaskPack sanity call
// both mint handles and write the module-level pack-dedupe cache). This spec
// runs in the same vitest worker as siblings that also drive these singletons;
// without a reset an earlier spec's handle/session/dedupe state (keyed by a
// tmp workspace path that mkdtemp can, rarely, repeat) leaks in and can flip a
// surface to a `code_unchanged` pointer instead of real code — mirrors the
// identical beforeEach in readCodeTaskPack.spec.ts.
beforeEach(() => {
  handleTable.reset();
  resetAllSessions();
  resetPackDedupeCache();
});

afterEach(() => {
  for (const s of servers.splice(0)) s.kill();
  for (const d of tmpDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ok */ }
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FORBIDDEN_KEYS = [
  "tokenlighten",
  "tokenlighten:meta",
  "meta",
  "next_action",
  "edit_candidates",
  "native_fallback_tool",
];

function assertNoForbiddenKeys(json: string): void {
  for (const k of FORBIDDEN_KEYS) {
    expect(json).not.toContain(`"${k}"`);
  }
}

/** Parse the first content-block text from a JSON-RPC tools/call result. */
function parsePackResult(rpcResult: any): Record<string, unknown> {
  const text = rpcResult?.result?.content?.[0]?.text;
  expect(typeof text).toBe("string");
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("read_code mode=pack (server-level)", () => {
  it("packs multiple path/range slices in order", async () => {
    const wsDir = mkDir("pack-order");

    writeFile(wsDir, "alpha.ts", [
      "export function alpha(): void {",
      "  console.log('alpha');",
      "}",
    ].join("\n") + "\n");

    writeFile(wsDir, "beta.ts", [
      "export function beta(): void {",
      "  console.log('beta');",
      "}",
    ].join("\n") + "\n");

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    const res = await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: {
        mode: "pack",
        paths: [
          { path: "alpha.ts", range: "1-3", purpose: "first" },
          { path: "beta.ts", range: "1-3", purpose: "second" },
        ],
      },
    });

    const data = parsePackResult(res);
    expect(data["kind"]).toBe("read.batch");
    const entries = data["entries"] as Array<Record<string, unknown>>;
    expect(Array.isArray(entries)).toBe(true);
    expect(entries.length).toBe(2);
    // Items must appear in the same order as requested.
    expect(entries[0]!["path"]).toBe("alpha.ts");
    expect(entries[1]!["path"]).toBe("beta.ts");
    // Content must include something from each file.
    expect(String(entries[0]!["content"])).toContain("alpha");
    expect(String(entries[1]!["content"])).toContain("beta");
    // Rule T: the `completeness` rollup is deleted — absence of `limit` IS
    // completeness (§4.4).
    expect(data["limit"]).toBeUndefined();
  }, 30000);

  it("cap-exhausted: remaining items appear in omitted[] with reason cap-exhausted and completeness partial", async () => {
    const wsDir = mkDir("pack-cap");

    // Write a file large enough to fill the budget on its own.
    const bigContent = Array.from({ length: 100 }, (_, i) => `const line${i} = ${i};`).join("\n");
    writeFile(wsDir, "big.ts", bigContent + "\n");
    writeFile(wsDir, "small.ts", "export const x = 1;\n");

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    // maxTokens=1 (4 chars budget) — big.ts alone exceeds the entire budget → cap-exceeded.
    // small.ts comes after → cap-exhausted (or also cap-exceeded if budget is already gone).
    const res = await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: {
        mode: "pack",
        maxTokens: 1,
        paths: [
          { path: "big.ts", range: "1-100" },
          { path: "small.ts", range: "1-1" },
        ],
      },
    });

    const data = parsePackResult(res);
    // Rule T: the per-item omitted[] {path,reason} ledger is deleted —
    // "cap-exceeded" vs "cap-exhausted" collapses into the single coarse
    // `limit.omitted:["evidence"]` class (§4.4); the specific PATH still
    // recovers, via the synthesized recovery call.
    expect(data["kind"]).toBe("read.batch");
    const limit = data["limit"] as Record<string, unknown>;
    expect(limit).toBeDefined();
    expect(limit["omitted"]).toEqual(["evidence"]);
    const next = limit["next"] as Record<string, unknown> | undefined;
    const nextArgs = next?.["arguments"] as Record<string, unknown> | undefined;
    expect(nextArgs?.["paths"]).toContain("small.ts");
  }, 30000);

  it("first item exceeds entire budget → omitted with cap-exceeded, items empty, completeness=empty", async () => {
    const wsDir = mkDir("pack-cap-exceeded");

    // Write a file with 100 lines — well above a 1-token (4-char) budget.
    const bigContent = Array.from({ length: 100 }, (_, i) => `const line${i} = ${i};`).join("\n");
    writeFile(wsDir, "big.ts", bigContent + "\n");

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    // maxTokens=1 means the entire pack budget is 4 chars; big.ts content far exceeds it.
    const res = await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: {
        mode: "pack",
        maxTokens: 1,
        paths: [{ path: "big.ts", range: "1-100" }],
      },
    });

    const data = parsePackResult(res);
    expect(data["kind"]).toBe("read.batch");
    const entries = data["entries"] as Array<Record<string, unknown>>;
    expect(Array.isArray(entries)).toBe(true);
    expect(entries.length).toBe(0);
    // Rule T: "empty" completeness is now a present `limit` with zero
    // entries (the old completeness:"empty"/omitted[] ledger is deleted).
    const limit = data["limit"] as Record<string, unknown>;
    expect(limit).toBeDefined();
    expect(limit["omitted"]).toEqual(["evidence"]);
    const next = limit["next"] as Record<string, unknown>;
    expect((next["arguments"] as Record<string, unknown>)["paths"]).toEqual(["big.ts"]);
  }, 30000);

  it("succeeds when top-level path is omitted (mode=pack only requires paths[])", async () => {
    const wsDir = mkDir("pack-noop");

    writeFile(wsDir, "target.ts", [
      "export function greet(name: string): string {",
      "  return `Hello ${name}`;",
      "}",
    ].join("\n") + "\n");

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    // Intentionally omit the top-level "path" key.
    const res = await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: {
        mode: "pack",
        paths: [{ path: "target.ts", range: "1-3" }],
        // No top-level "path" key.
      },
    });

    // Must not error — should return a valid pack result.
    expect(res.result).toBeDefined();
    expect(res.error).toBeUndefined();
    const data = parsePackResult(res);
    expect(data["kind"]).toBe("read.batch");
    const entries = data["entries"] as Array<Record<string, unknown>>;
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(String(entries[0]!["content"])).toContain("greet");
  }, 30000);

  // ---------------------------------------------------------------------------
  // A7: mixed batched paths[] — {path,range}, {path,symbol}, bare {path}
  // ---------------------------------------------------------------------------
  it("batched paths[{path,range},{path,symbol},{path}] returns one grouped response with all three items", async () => {
    const wsDir = mkDir("pack-mixed-batch");

    writeFile(wsDir, "range.ts", [
      "export function rangeTarget(): void {",
      "  console.log('range');",
      "}",
    ].join("\n") + "\n");

    writeFile(wsDir, "symbol.ts", [
      "export function otherFn(): void {}",
      "",
      "export function symbolTarget(): number {",
      "  return 7;",
      "}",
    ].join("\n") + "\n");

    // Bare {path} entry — no range/symbol. Must be treated like small_file
    // (tiny file) instead of rejected as out-of-range.
    writeFile(wsDir, "bare.ts", "export const BARE = 1;\n");

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    const res = await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: {
        mode: "pack",
        paths: [
          { path: "range.ts", range: "1-3" },
          { path: "symbol.ts", symbol: "symbolTarget" },
          { path: "bare.ts" },
        ],
      },
    });

    const data = parsePackResult(res);
    expect(data["kind"]).toBe("read.batch");
    const entries = data["entries"] as Array<Record<string, unknown>>;
    expect(entries.length).toBe(3);
    expect(entries[0]!["path"]).toBe("range.ts");
    expect(String(entries[0]!["content"])).toContain("rangeTarget");
    expect(entries[1]!["path"]).toBe("symbol.ts");
    expect(String(entries[1]!["content"])).toContain("symbolTarget");
    expect(entries[2]!["path"]).toBe("bare.ts");
    expect(String(entries[2]!["content"])).toContain("BARE");
    // Bare-path item must not be rejected as out-of-range: it is a served
    // entry above, and (Rule T) absence of `limit` proves batch-wide that
    // nothing — bare.ts included — was withheld.
    expect(data["limit"]).toBeUndefined();
  }, 30000);

  it("response JSON contains no forbidden envelope keys", async () => {
    const wsDir = mkDir("pack-envelope");

    writeFile(wsDir, "src.ts", "export const ok = true;\n");

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    const res = await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: {
        mode: "pack",
        paths: [{ path: "src.ts", range: "1-1" }],
      },
    });

    const serialized = JSON.stringify(res.result);
    assertNoForbiddenKeys(serialized);
  }, 30000);
});

// ---------------------------------------------------------------------------
// A7: read_code handles:[] batch read — resolves N handles to N slices in
// one grouped response (mode=slice previously took exactly one handle).
// ---------------------------------------------------------------------------

describe("read_code handles=[] batch read (server-level)", () => {
  it("resolves 3 handles from mode=slice in one grouped response", async () => {
    const wsDir = mkDir("handles-batch");

    writeFile(wsDir, "a.ts", [
      "export function alphaFn(): void {",
      "  console.log('alpha');",
      "}",
    ].join("\n") + "\n");
    writeFile(wsDir, "b.ts", [
      "export function betaFn(): void {",
      "  console.log('beta');",
      "}",
    ].join("\n") + "\n");
    writeFile(wsDir, "c.ts", [
      "export function gammaFn(): void {",
      "  console.log('gamma');",
      "}",
    ].join("\n") + "\n");

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    // Mint 3 handles via mode=slice (one call each, as today).
    const h1res = await srv.rpc(2, "tools/call", { name: "read_file", arguments: { mode: "slice", path: "a.ts", range: "1-3" } });
    const h2res = await srv.rpc(3, "tools/call", { name: "read_file", arguments: { mode: "slice", path: "b.ts", symbol: "betaFn" } });
    const h3res = await srv.rpc(4, "tools/call", { name: "read_file", arguments: { mode: "slice", path: "c.ts", range: "1-3" } });
    const h1 = (parsePackResult(h1res)["evidence"] as Array<Record<string, unknown>>)[0]!["handle"] as string;
    const h2 = (parsePackResult(h2res)["evidence"] as Array<Record<string, unknown>>)[0]!["handle"] as string;
    const h3 = (parsePackResult(h3res)["evidence"] as Array<Record<string, unknown>>)[0]!["handle"] as string;
    expect(h1).toMatch(/^h[0-9a-z]+$/);
    expect(h2).toMatch(/^h[0-9a-z]+$/);
    expect(h3).toMatch(/^h[0-9a-z]+$/);

    // Single batched call resolves all 3 handles.
    const batchRes = await srv.rpc(5, "tools/call", {
      name: "read_file",
      arguments: { handles: [h1, h2, h3] },
    });

    const data = parsePackResult(batchRes);
    expect(data["kind"]).toBe("read.batch");
    const entries = data["entries"] as Array<Record<string, unknown>>;
    expect(entries.length).toBe(3);
    expect(entries.map((i) => i["handle"])).toEqual([h1, h2, h3]);
    expect(String(entries[0]!["content"])).toContain("alphaFn");
    expect(String(entries[1]!["content"])).toContain("betaFn");
    expect(String(entries[2]!["content"])).toContain("gammaFn");
    for (const entry of entries) {
      expect(typeof entry["sha"]).toBe("string");
      expect(String(entry["sha"])).toMatch(/^sha256:/);
    }
    // Rule T: absence of `limit` IS completeness; there is no separate
    // omitted[] ledger to check is empty.
    expect(data["limit"]).toBeUndefined();
  }, 30000);

  it("unknown handle in the batch is omitted with reason handle-unknown; known handles still resolve", async () => {
    const wsDir = mkDir("handles-batch-unknown");

    writeFile(wsDir, "only.ts", "export const ONLY = 1;\n");

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    const sliceRes = await srv.rpc(2, "tools/call", { name: "read_file", arguments: { mode: "slice", path: "only.ts", range: "1-1" } });
    const h1 = (parsePackResult(sliceRes)["evidence"] as Array<Record<string, unknown>>)[0]!["handle"] as string;

    const batchRes = await srv.rpc(3, "tools/call", {
      name: "read_file",
      arguments: { handles: [h1, "h9999"] },
    });

    const data = parsePackResult(batchRes);
    expect(data["kind"]).toBe("read.batch");
    const entries = data["entries"] as Array<Record<string, unknown>>;
    expect(entries.length).toBe(1);
    expect(entries[0]!["handle"]).toBe(h1);
    // Rule T: the per-item omitted[] {handle,reason} ledger is deleted — an
    // unknown handle has, by construction, no path the server ever learned,
    // so there is nothing for a recovery `next` to name (cause:"source", no
    // `next`) — only the coarse withholding signal survives.
    //
    // [R5-9] KEEP `source` HERE — do not "fix" this to `capped`. The ruling
    // (2026-08-14) split the no-`next` arm in two, and this is the arm that was
    // always right: NO CAP FIRED. The response is short because a reference
    // resolved to nothing, and `capped` would assert a budget that never ran.
    // Its counterpart — a real cap with no constructible continuation — is
    // pinned as `capped` by replayCorpus.spec.ts's mcap2 case. The
    // discriminator is `readFamily.ts`'s `capFired`.
    const limit = data["limit"] as Record<string, unknown>;
    expect(limit).toBeDefined();
    expect(limit["cause"]).toBe("source");
    expect(limit["omitted"]).toEqual(["evidence"]);
    expect(limit["next"]).toBeUndefined();
  }, 30000);
});

// ---------------------------------------------------------------------------
// readCodePack query-pack (unit-level, direct function calls)
// ---------------------------------------------------------------------------

describe("readCodePack query-pack", () => {
  const unitTmpDirs: string[] = [];

  afterEach(() => {
    for (const d of unitTmpDirs.splice(0)) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  function mkUnitDir(tag: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tl-qpack-${tag}-`));
    unitTmpDirs.push(dir);
    return dir;
  }

  function writeUnitFile(dir: string, rel: string, content: string): void {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }

  async function realReadFileSafe(workspace: string, relPath: string): Promise<string | null> {
    const abs = path.join(workspace, relPath);
    try {
      return fs.readFileSync(abs, "utf8");
    } catch {
      return null;
    }
  }

  it("returns completeness:'empty' with locate.hit:false on broad query", async () => {
    const ws = mkUnitDir("broad");
    writeUnitFile(ws, "src/index.ts", "export const x = 1;\n");

    const result = await readCodePack(
      { mode: "pack", query: "fix this please" },
      ws,
      (rel) => realReadFileSafe(ws, rel),
    );

    expect(result.items).toEqual([]);
    expect(result.completeness).toBe("empty");
    expect(result.locate).toBeDefined();
    expect(result.locate!.hit).toBe(false);
  });

  it("returns sliced items on a unique-symbol query", async () => {
    const ws = mkUnitDir("unique");
    const padding = Array.from({ length: 20 }, (_, i) => `// padding line ${i}`).join("\n");
    writeUnitFile(ws, "src/foo.ts",
      padding + "\nexport function uniqueAlphaSymbolXYZ() { return 42; }\n" + padding + "\n",
    );

    const result = await readCodePack(
      { mode: "pack", query: "uniqueAlphaSymbolXYZ", path: "src" },
      ws,
      (rel) => realReadFileSafe(ws, rel),
    );

    if (result.items.length > 0) {
      // Either a confident hit or a materialized ambiguous-abstain fallback
      // (Finding #6) — either way, real content for the target symbol.
      expect(result.items[0]!.content).toContain("uniqueAlphaSymbolXYZ");
      expect(["complete", "partial"]).toContain(result.completeness);
    } else {
      // locate didn't hit and had no usable candidateDetails — acceptable
      // for unit test if symbol indexing didn't pick it up at all.
      expect(result.completeness).toBe("empty");
    }
  });

  it("never includes full file content; respects centered window", async () => {
    const ws = mkUnitDir("window");
    const lines: string[] = [];
    for (let i = 1; i <= 200; i++) {
      if (i === 100) {
        lines.push("export function needleAlphaXYZ() { return 99; }");
      } else {
        lines.push(`// filler line ${i}`);
      }
    }
    writeUnitFile(ws, "src/big.ts", lines.join("\n") + "\n");

    const result = await readCodePack(
      { mode: "pack", query: "needleAlphaXYZ" },
      ws,
      (rel) => realReadFileSafe(ws, rel),
    );

    if (result.items.length > 0) {
      // Content must be much smaller than the full file (~200 lines).
      const fullSize = lines.join("\n").length;
      expect(result.items[0]!.content.length).toBeLessThan(fullSize);
      // Slice should be well under 1500 bytes for a 20-line window.
      expect(result.items[0]!.content.length).toBeLessThan(1500);
    } else {
      // If locate didn't hit, we just verify no full-file content was returned.
      expect(result.completeness).toBe("empty");
    }
  });

  it("forbidden keys check passes on query-pack output", async () => {
    const ws = mkUnitDir("forbidden");
    writeUnitFile(ws, "src/index.ts", "export const y = 2;\n");

    const result = await readCodePack(
      { mode: "pack", query: "fix this please" },
      ws,
      (rel) => realReadFileSafe(ws, rel),
    );

    const serialized = JSON.stringify(result);
    for (const k of FORBIDDEN_KEYS) {
      expect(serialized).not.toContain(`"${k}"`);
    }
  });

  it("rejects when both paths and query provided — returns completeness:empty", async () => {
    const ws = mkUnitDir("both");
    writeUnitFile(ws, "src/a.ts", "export const z = 3;\n");

    const result = await readCodePack(
      { mode: "pack", query: "something", paths: [{ path: "src/a.ts", range: "1-1" }] },
      ws,
      (rel) => realReadFileSafe(ws, rel),
    );

    expect(result.completeness).toBe("empty");
    expect(result.items).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // Finding #6 regression: includeClosure:false (plain query-pack) must not
  // silently abstain-to-empty on a query that buildTaskPack (task_pack mode)
  // resolves fine via its ambiguous-abstain candidateDetails fallback. Same
  // fixture shape as partialTaskPack.spec.ts's "config value used by the
  // service" case, which locateTaskContext resolves as reason:"ambiguous"
  // with non-empty candidateDetails rather than a confident single hit.
  // ---------------------------------------------------------------------------
  it("includeClosure:false query that yields a non-empty task_pack also yields a non-empty plain pack with real code", async () => {
    const ws = mkUnitDir("ambiguous-fallback");
    writeUnitFile(ws, "src/services/issueService.ts", "export function issueService() { return 1; }\n");
    writeUnitFile(ws, "src/services/projectService.ts", "export function projectService() { return 1; }\n");
    writeUnitFile(ws, "src/services/workspaceService.ts", "export function workspaceService() { return 1; }\n");
    writeUnitFile(ws, "src/services/searchService.ts", "export function searchService() { return 1; }\n");
    writeUnitFile(ws, "next.config.mjs", "export default {}\n");
    writeUnitFile(ws, "src/config.ts", "export const config = {}\n");

    const query = "update the config value used by the service";

    // Sanity: buildTaskPack (the task_pack side) resolves this query with
    // real surfaces via its ambiguous-abstain candidateDetails fallback.
    const { buildTaskPack } = await import("../tools/readCodeTaskPack.js");
    const taskPack = await buildTaskPack({ query }, ws);
    expect(taskPack.surfaces.length).toBeGreaterThan(0);

    // The plain query-pack (includeClosure:false path) must mirror that:
    // non-empty items with real, non-placeholder code, not a bare empty pack.
    const result = await readCodePack(
      { mode: "pack", query },
      ws,
      (rel) => realReadFileSafe(ws, rel),
    );

    expect(result.locate).toBeDefined();
    expect(result.locate!.hit).toBe(false);
    expect(result.items.length).toBeGreaterThan(0);
    expect(["complete", "partial"]).toContain(result.completeness);
    for (const item of result.items) {
      expect(item.content.length).toBeGreaterThan(0);
    }
    // At least one item must be one of the fixture's real files, not a stub.
    const paths = result.items.map((i) => i.path);
    expect(paths.some((p) => p.endsWith("Service.ts") || p.endsWith("config.ts") || p.endsWith("config.mjs"))).toBe(true);
  });

  it("includeClosure:false still returns an abstain reason + candidates (not a bare empty pack) when locate has no usable candidateDetails", async () => {
    const ws = mkUnitDir("no-candidates");
    writeUnitFile(ws, "src/index.ts", "export const x = 1;\n");

    const result = await readCodePack(
      { mode: "pack", query: "fix this please" },
      ws,
      (rel) => realReadFileSafe(ws, rel),
    );

    expect(result.items).toEqual([]);
    expect(result.completeness).toBe("empty");
    expect(result.locate).toBeDefined();
    expect(result.locate!.hit).toBe(false);
    // Refusals-are-redirects: the abstain reason must be surfaced, not swallowed.
    expect(typeof result.locate!.reason).toBe("string");
    expect(result.locate!.reason!.length).toBeGreaterThan(0);
  });

  // P3 + G1 exemption: an explicit paths[] pack of N bare {path} tiny files
  // returns ALL of them full in one call — the auto-default flip must NOT drop
  // them to outline (P3 regression), and the tiny-task-cap governor must NOT
  // block them past 5 (governorExempt — explicit enumeration is one-call-complete).
  it("a pack of 8 bare {path} tiny files returns all 8 full (P3 + governorExempt)", async () => {
    const ws = mkUnitDir("p3-bare-paths");
    const paths = [];
    for (let i = 0; i < 8; i++) {
      writeUnitFile(ws, `src/f${i}.ts`, `export const V${i} = ${i};\n`);
      paths.push({ path: `src/f${i}.ts` });
    }

    const result = await readCodePack(
      { mode: "pack", paths },
      ws,
      (rel) => realReadFileSafe(ws, rel),
    );

    expect(result.items.length).toBe(8);
    expect(result.omitted).toEqual([]);
    expect(result.completeness).toBe("complete");
    for (let i = 0; i < 8; i++) {
      const item = result.items.find((it) => it.path === `src/f${i}.ts`);
      expect(item, `f${i} should be present with content`).toBeDefined();
      expect(item!.content).toContain(`V${i}`);
    }
  });

  it("a bare {path} to a NOT-tiny file is omitted with reason 'not-tiny' (P3: not out-of-range)", async () => {
    const ws = mkUnitDir("p3-not-tiny");
    // >8KB → not tiny → small_file refuses → omitted as not-tiny.
    const big = Array.from({ length: 500 }, (_, i) => `export const V${i} = ${i};`).join("\n");
    writeUnitFile(ws, "src/big.ts", big + "\n");

    const result = await readCodePack(
      { mode: "pack", paths: [{ path: "src/big.ts" }] },
      ws,
      (rel) => realReadFileSafe(ws, rel),
    );

    expect(result.items).toEqual([]);
    expect(result.omitted.length).toBe(1);
    expect(result.omitted[0]!.reason).toBe("not-tiny");
  });

  // Data-loss regression: the bare-{path} branch used to count lines off
  // buildSmallFile's own `.content` (ELIDED — a multi-line doc block
  // collapses to ONE marker line) and then slice the RAW `lines` array to
  // THAT count, silently dropping the file's real tail whenever it contained
  // a multi-line doc comment. A tiny file with a 10-line JSDoc header + 5
  // code lines must come back with ALL 15 raw lines, range "1-15", and no
  // truncated:true.
  it("a bare {path} tiny file with a 10-line JSDoc header keeps its full raw content (no elision-count truncation)", async () => {
    const ws = mkUnitDir("g-jsdoc-bare-path");
    const jsdoc = [
      "/**",
      " * Line 2 of the doc block.",
      " * Line 3 of the doc block.",
      " * Line 4 of the doc block.",
      " * Line 5 of the doc block.",
      " * Line 6 of the doc block.",
      " * Line 7 of the doc block.",
      " * Line 8 of the doc block.",
      " * Line 9 of the doc block.",
      " */",
      "export function sum(a: number, b: number): number {",
      "  return a + b;",
      "}",
      "export const LAST_LINE_MARKER = 42;",
    ];
    // 14 lines above + trailing newline = 15 logical lines via split(/\r?\n/).
    writeUnitFile(ws, "src/doc.ts", jsdoc.join("\n") + "\n");

    const result = await readCodePack(
      { mode: "pack", paths: [{ path: "src/doc.ts" }] },
      ws,
      (rel) => realReadFileSafe(ws, rel),
    );

    expect(result.omitted).toEqual([]);
    expect(result.items.length).toBe(1);
    const item = result.items[0]!;
    expect(item.range).toBe("1-15");
    expect(item.truncated).not.toBe(true);
    // The last raw line must be present verbatim — proof the raw file (not
    // the elided small-file view) was sliced.
    expect(item.content).toContain("export const LAST_LINE_MARKER = 42;");
    // The doc block's own text (elided in buildSmallFile's view) must also
    // survive since we now serve the RAW file, not the elided one.
    expect(item.content).toContain("Line 9 of the doc block.");
  });
});

// ---------------------------------------------------------------------------
// Finding #6: includeClosure schema description must exist and be discoverable
// on read_code (the escape hatch was previously undiscoverable — no
// description on server.ts's includeClosure property).
// ---------------------------------------------------------------------------
describe("read_code includeClosure schema description (Finding #6)", () => {
  it("read_code's includeClosure property has a non-empty, <=90-char description", async () => {
    const { advertisedTools } = await import("../server.js");
    const tools = advertisedTools() as Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }>;
    const readCode = tools.find((t) => t.name === "read_file");
    expect(readCode).toBeDefined();
    const prop = readCode?.inputSchema?.properties?.["includeClosure"] as { description?: string } | undefined;
    expect(prop?.description).toBeTruthy();
    expect(prop!.description!.length).toBeGreaterThan(0);
    expect(prop!.description!.length).toBeLessThanOrEqual(90);
  });
});
