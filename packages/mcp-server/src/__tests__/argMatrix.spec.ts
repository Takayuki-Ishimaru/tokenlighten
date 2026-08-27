/**
 * argMatrix.spec.ts — argument-combination matrix audit (2026-07-12).
 *
 * Motivation: live bench agents produced call shapes where an argument
 * combination the dispatch never anticipated fell through to a
 * default-bearing branch and mutated or served something WRONG with no
 * error (e.g. the search+content shape that used to wipe a file — now
 * guarded by SEARCH_CONTENT_CONFLICT_MSG in server.ts). This file
 * systematically walks the parameter surface of the 3 advertised tools
 * (read_file, edit_file, search_files) for PAIRS/triples of arguments the
 * dispatch does not explicitly route together, and pins the actual observed
 * behavior for each:
 *
 *   - "FIXED" groups: a combo that was empirically confirmed (via a live
 *     spawned-server repro, documented inline) to silently misbehave BEFORE
 *     this change set. Each has a guard added in server.ts (dispatch/
 *     validation) or applyEditsMulti.ts (entry-validation region) — see the
 *     "AUDIT (argument-combination matrix, 2026-07-12)" comments at each
 *     guard site. The test here is the failing-repro-turned-regression-test.
 *   - "already sane / documented" groups: the combo was tested and already
 *     produces either a helpful refusal or an unambiguous, truthful
 *     "more-specific-argument-wins" interpretation. No server change; the
 *     comment on each case records why it is intentional.
 *
 * Uses the spawned server over stdio with --allow-write (harness copied from
 * editCodeHandle.spec.ts's pattern, same tmp-workspace-per-test convention).
 */

import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createHash } from "crypto";
import { unsafeGuardedWorkspaceRootForTests } from "../write/guardedWorkspace.js";
import { nextText } from "./helpers/protocolNext.js";

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
  const dir = fs.mkdtempSync(path.join(HOME, `.tl-argmatrix-${tag}-`));
  tmpDirs.push(dir);
  return dir;
}

function writeFile(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

function readFile(dir: string, rel: string): string {
  return fs.readFileSync(path.join(dir, rel), "utf8");
}

function shaOfText(text: string): string {
  const hex = createHash("sha256").update(text, "utf8").digest("hex");
  return `sha256:${hex}`;
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
      clientInfo: { name: "vitest-argmatrix", version: "0" },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await rpc(++idCounter, "tools/call", { name, arguments: args });
    const text = res?.result?.content?.[0]?.text;
    expect(typeof text).toBe("string");
    const body = JSON.parse(text);
    // v1: a read response's own addressable handle now lives at
    // `evidence[0].handle` (read.text) or `outline.handle` (read.map); mirror
    // it onto a synthetic top-level `handle` so this file's many call sites
    // keep working unchanged. Edit-family responses still carry a genuine
    // top-level `handle` (A.5.11, kept) and pass through untouched.
    if (typeof body["handle"] !== "string") {
      const evidence = Array.isArray(body["evidence"]) ? body["evidence"] : undefined;
      const fromEvidence = evidence?.[0]?.["handle"];
      const outline = body["outline"] && typeof body["outline"] === "object" ? body["outline"] : undefined;
      const fromOutline = outline?.["handle"];
      if (typeof fromEvidence === "string") body["handle"] = fromEvidence;
      else if (typeof fromOutline === "string") body["handle"] = fromOutline;
    }
    return body;
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
  const srv = startServer({ cwd: ws, args: [ws, "--allow-write"] });
  servers.push(srv);
  await srv.initialize();
  return { ws, srv };
}

// ExcelJS write API (minimal shape needed here) — mirrors
// readCodeArtifactDispatch.spec.ts's buildTestXlsx helper.
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
  const buf = await wb.xlsx.writeBuffer();
  return buf;
}

// =============================================================================
// GROUP 1 (FIXED): edits[] range-handle entry with neither `content` nor a
// non-empty `search` — used to silently wipe the handle's range to empty,
// discarding any `replace` text, with ok:true. Confirmed live pre-fix:
//   edits:[{handle:<h for lines 1-3>, replace:"<new body>"}]
//   -> {"ok":true, "files":[{"lines":"1","delta":"+0/-3", ...}]}
//   file's lines 1-3 DELETED, "<new body>" never written anywhere.
// Guard: server.ts edits[] mapping loop (entryContent===undefined &&
// (search===undefined || search==="")); defense-in-depth mirror in
// applyEditsMulti.ts's applyEditStep for direct (non-server.ts) callers.
// =============================================================================
describe("argMatrix — edit_file — FIXED: edits[] range-handle ambiguous shape", () => {
  const ORIG = [
    "export function greetUser(name: string): string {",
    '  return "Hello, " + name;',
    "}",
    "",
    "export function farewellUser(name: string): string {",
    '  return "Goodbye, " + name;',
    "}",
    "",
  ].join("\n");

  async function mintRangeHandle(ws: string, srv: ServerHandle): Promise<string> {
    writeFile(ws, "f.ts", ORIG);
    const slice = await srv.call("read_file", { path: "f.ts", mode: "slice", range: "1-3" });
    expect(typeof slice["handle"]).toBe("string");
    return slice["handle"] as string;
  }

  it("edits:[{handle}] alone (no search, no content, no replace) refuses instead of wiping the range", async () => {
    const { ws, srv } = await newServer("wipe-bare");
    const handle = await mintRangeHandle(ws, srv);
    const before = readFile(ws, "f.ts");

    const res = await srv.call("edit_file", { edits: [{ handle }] });
    expect(res["kind"]).toBe("refusal");
    expect(String(res["detail"])).toContain("content");

    // File-unchanged assertion (sha, per mutating-path-fix convention).
    expect(shaOfText(readFile(ws, "f.ts"))).toBe(shaOfText(before));
  }, 30000);

  it("edits:[{handle, replace:'text'}] (the natural mistake — replace without content) refuses and does NOT discard the text into a wipe", async () => {
    const { ws, srv } = await newServer("wipe-replace-only");
    const handle = await mintRangeHandle(ws, srv);
    const before = readFile(ws, "f.ts");

    const res = await srv.call("edit_file", { edits: [{ handle, replace: "export function greetUser(name: string): string {\n  return `Hi, ${name}!`;\n}" }] });
    expect(res["kind"]).toBe("refusal");
    expect(String(res["detail"])).toMatch(/content|ambiguous/i);

    expect(shaOfText(readFile(ws, "f.ts"))).toBe(shaOfText(before));
    expect(readFile(ws, "f.ts")).toBe(before); // byte-identical, not just same hash function
  }, 30000);

  it("edits:[{handle, search:'', replace:'text'}] (explicit empty search) also refuses, not just the omitted-search form", async () => {
    const { ws, srv } = await newServer("wipe-empty-search");
    const handle = await mintRangeHandle(ws, srv);
    const before = readFile(ws, "f.ts");

    const res = await srv.call("edit_file", { edits: [{ handle, search: "", replace: "WIPED?" }] });
    expect(res["kind"]).toBe("refusal");

    expect(readFile(ws, "f.ts")).toBe(before);
  }, 30000);

  it("sanity (no regression): edits:[{handle, content:'text'}] — the CORRECT shape — still range-replaces normally", async () => {
    const { ws, srv } = await newServer("wipe-sanity-content");
    const handle = await mintRangeHandle(ws, srv);

    const res = await srv.call("edit_file", { edits: [{ handle, content: "export function greetUser(name: string): string {\n  return `Hi, ${name}!`;\n}" }] });
    expect(res["kind"]).not.toBe("refusal");
    expect(readFile(ws, "f.ts")).toContain("Hi, ${name}!");
    expect(readFile(ws, "f.ts")).toContain("farewellUser"); // untouched tail survives
  }, 30000);

  it("sanity (no regression): edits:[{handle, search, replace}] — the CORRECT range-scoped replace-all shape — still works", async () => {
    const { ws, srv } = await newServer("wipe-sanity-searchreplace");
    const handle = await mintRangeHandle(ws, srv);

    const res = await srv.call("edit_file", { edits: [{ handle, search: "Hello", replace: "Howdy" }] });
    expect(res["kind"]).not.toBe("refusal");
    expect(readFile(ws, "f.ts")).toContain("Howdy");
  }, 30000);

  it("applyEditsMulti.ts defense-in-depth: a directly-constructed EditEntry with the ambiguous shape also refuses (not just the server.ts dispatch guard)", async () => {
    const { applyEditsMulti } = await import("../tools/applyEditsMulti.js");
    const ws = mkDir("wipe-direct-call");
    writeFile(ws, "direct.ts", ORIG);
    const result = await applyEditsMulti(
      { edits: [{ path: "direct.ts", search: "", replace: "text", range: "1-3" }] },
      unsafeGuardedWorkspaceRootForTests(ws),
      true,
      "test-session",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/content/i);
    }
    expect(readFile(ws, "direct.ts")).toBe(ORIG);
  }, 30000);
});

// =============================================================================
// GROUP 2 (FIXED): create:true + edits[] together. `edits` is dispatched
// BEFORE `create` in server.ts, so create used to lose silently — confirmed
// live: the file was never created, and the error ("File not found: X") gave
// no hint that create:true was the reason edits[] was even attempted against
// a nonexistent path. When the edits[] target already existed, create:true
// was silently dropped but harmless (edit just applied) — still an
// "ok:true with an ignored argument" instance. Both are now a single loud
// refusal up front.
// =============================================================================
describe("argMatrix — edit_file — FIXED: create + edits[] conflict", () => {
  it("create:true + edits[] targeting a file that does NOT exist yet: refuses instead of a misleading 'File not found'", async () => {
    const { ws, srv } = await newServer("create-edits-missing");

    const res = await srv.call("edit_file", {
      create: true,
      path: "brandnew.ts",
      content: "export const y = 2;\n",
      edits: [{ path: "brandnew.ts", search: "y = 2", replace: "y = 3" }],
    });
    expect(res["kind"]).toBe("refusal");
    expect(String(res["detail"])).toContain("edits[]");
    expect(fs.existsSync(path.join(ws, "brandnew.ts"))).toBe(false);
  }, 30000);

  it("create:true + edits[] targeting an EXISTING file: refuses instead of silently dropping create and applying only the edit", async () => {
    const { ws, srv } = await newServer("create-edits-existing");
    writeFile(ws, "existing.ts", "export const x = 1;\n");

    const res = await srv.call("edit_file", {
      create: true,
      path: "should-not-be-created.ts",
      content: "ignored content",
      edits: [{ path: "existing.ts", search: "x = 1", replace: "x = 42" }],
    });
    expect(res["kind"]).toBe("refusal");
    expect(fs.existsSync(path.join(ws, "should-not-be-created.ts"))).toBe(false);
    // The whole call refused up front — existing.ts must be untouched too
    // (all-or-nothing, consistent with every other edits[] pre-write guard).
    expect(readFile(ws, "existing.ts")).toBe("export const x = 1;\n");
  }, 30000);

  it("sanity (no regression): create:true WITHOUT edits[] still creates the file", async () => {
    const { ws, srv } = await newServer("create-alone");
    const res = await srv.call("edit_file", { create: true, path: "solo.ts", content: "export const S = 1;\n", cwd: ws });
    expect(res["kind"]).not.toBe("refusal");
    expect(readFile(ws, "solo.ts")).toBe("export const S = 1;\n");
  }, 30000);

  it("sanity (no regression): edits[] WITHOUT create:true still works on existing files", async () => {
    const { ws, srv } = await newServer("edits-alone");
    writeFile(ws, "e.ts", "export const E = 1;\n");
    const res = await srv.call("edit_file", { edits: [{ path: "e.ts", search: "E = 1", replace: "E = 2" }] });
    expect(res["kind"]).not.toBe("refusal");
    expect(readFile(ws, "e.ts")).toBe("export const E = 2;\n");
  }, 30000);
});

// =============================================================================
// GROUP 3 (FIXED): target="all" is consulted in exactly ONE dispatch branch
// (handleId && handleRange && target==="all"). A plain path+search+replace
// call with target="all" but no range handle silently drops target, and —
// when search legitimately matches more than once, the exact case target=all
// exists for — the resulting "ambiguous" error tells the caller to "add more
// context to make it unique", directly contradicting a stated "replace all"
// intent. Confirmed live. A hint naming the real mechanism is now appended;
// the original error/candidates are left intact, and the harmless
// exactly-one-match case (still ok:true) is deliberately left unchanged.
// =============================================================================
describe("argMatrix — edit_file — FIXED: target=\"all\" without a range handle", () => {
  it("target='all', no handle, search matches multiple times: still refuses (unchanged), but now hints at the real fix instead of only contradicting advice", async () => {
    const { ws, srv } = await newServer("target-all-ambiguous");
    writeFile(ws, "dup.ts", "const val = 1;\nconst val2 = 1;\nconst val3 = 1;\n");

    const res = await srv.call("edit_file", { path: "dup.ts", search: "= 1", replace: "= 99", target: "all" });
    expect(res["kind"]).toBe("refusal");
    expect(res["code"]).toBe("ambiguous");
    // Original message is preserved (still names the match count) —
    expect(String(res["detail"])).toContain("locations");
    // — AND the new hint corrects the misleading part, pointing at mode=slice.
    expect(String(res["hint"])).toContain("mode=slice");
    expect(String(res["hint"])).toContain("target=");

    expect(readFile(ws, "dup.ts")).toBe("const val = 1;\nconst val2 = 1;\nconst val3 = 1;\n");
  }, 30000);

  it("sanity (no regression): target='all', no handle, search matches EXACTLY once still succeeds (target=all is moot, not harmful, here)", async () => {
    const { ws, srv } = await newServer("target-all-single");
    writeFile(ws, "one.ts", "const solo = 1;\n");

    const res = await srv.call("edit_file", { path: "one.ts", search: "solo = 1", replace: "solo = 2", target: "all" });
    expect(res["kind"]).not.toBe("refusal");
    expect(res["hint"]).toBeUndefined(); // hint only fires on the ambiguous case
    expect(readFile(ws, "one.ts")).toBe("const solo = 2;\n");
  }, 30000);

  it("sanity (no regression): target='all' WITH a range handle is unaffected — still applies the real scoped replace-all", async () => {
    const { ws, srv } = await newServer("target-all-with-handle");
    const content = [
      "export const OUTSIDE = \"old-outside\";",
      "export const ITEMS = [",
      '  "old-a",',
      '  "old-b",',
      "];",
    ].join("\n") + "\n";
    writeFile(ws, "items.ts", content);

    const slice = await srv.call("read_file", { mode: "slice", path: "items.ts", range: "2-5" });
    const res = await srv.call("edit_file", { handle: slice["handle"], target: "all", search: "old-", replace: "new-" });
    expect(res["kind"]).not.toBe("refusal");
    const updated = readFile(ws, "items.ts");
    expect(updated).toContain("new-a");
    expect(updated).toContain("new-b");
    expect(updated).toContain("old-outside"); // outside the range handle — untouched
  }, 30000);
});

// =============================================================================
// GROUP 4 (FIXED — safety bypass): batch preconditions were formerly
// checked only against the top-level effectivePath, never each edits[] item.
// The dispatcher now resolves the effective precondition per item (item wins,
// otherwise call-level inheritance) and checks every resolved path before any
// mutation. These regressions pin the old bypass shape, item override, inherited
// failure, and all-or-nothing behavior.
// =============================================================================
describe("argMatrix — edit_file — FIXED: per-item precondition enforcement and inheritance", () => {
  it("PARAMOUNT repro: expected-hash on an unrelated top-level handle no longer green-lights an edits[] batch that mutates a DIFFERENT, hash-unchecked file", async () => {
    const { ws, srv } = await newServer("precond-bypass-paramount");
    writeFile(ws, "a.ts", "const a = 1;\n");
    writeFile(ws, "c.ts", "const c = 1;\n");

    const readA = await srv.call("read_file", { path: "a.ts", mode: "full" });
    const readC = await srv.call("read_file", { path: "c.ts", mode: "full" });

    const res = await srv.call("edit_file", {
      handle: readC["handle"], // top-level handle names file C
      precondition: "expected-hash",
      expectedSha: readC["sha"], // the CORRECT, current hash of C
      edits: [{ handle: readA["handle"], search: "a = 1", replace: "a = 999" }], // batch mutates A
    });

    expect(res["kind"]).toBe("refusal");
    expect(res["code"]).toBe("hash-mismatch");
    // The paramount assertion: A was NOT silently mutated via the C-hash loophole.
    expect(readFile(ws, "a.ts")).toBe("const a = 1;\n");
    expect(shaOfText(readFile(ws, "a.ts"))).toBe(shaOfText("const a = 1;\n"));
  }, 30000);

  it("expected-hash + edits[] refuses even with no top-level handle/path at all (was: unconditional, unhelpful hash-mismatch)", async () => {
    const { ws, srv } = await newServer("precond-expected-hash-batch");
    writeFile(ws, "a.ts", "const a = 1;\n");
    writeFile(ws, "b.ts", "const b = 1;\n");

    const res = await srv.call("edit_file", {
      precondition: "expected-hash",
      expectedSha: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      edits: [
        { path: "a.ts", search: "a = 1", replace: "a = 3" },
        { path: "b.ts", search: "b = 1", replace: "b = 3" },
      ],
    });
    expect(res["kind"]).toBe("refusal");
    expect(res["code"]).toBe("hash-mismatch");
    expect(readFile(ws, "a.ts")).toBe("const a = 1;\n");
    expect(readFile(ws, "b.ts")).toBe("const b = 1;\n");
  }, 30000);

  it("scope-handle + edits[] refuses (same top-level-only check would otherwise let an in-scope top-level handle rubber-stamp an out-of-scope batch item)", async () => {
    const { ws, srv } = await newServer("precond-scope-handle-batch");
    writeFile(ws, "src/inside.ts", 'export const A = "old";\n');
    writeFile(ws, "outside.ts", 'export const B = "old";\n');

    // Mint a scope handle confined to src/ via a scoped search_files locate
    // is heavier than needed here — precondition=scope-handle with an
    // UNKNOWN scopeHandle already exercises the same dispatch line (the
    // combo under test is precondition/edits[] routing, not scope-handle's
    // own minting path, which editCodeHandle.spec.ts already covers).
    const res = await srv.call("edit_file", {
      path: "src/inside.ts",
      precondition: "scope-handle",
      scopeHandle: "h9999",
      edits: [{ path: "outside.ts", search: "old", replace: "new" }],
    });
    expect(res["kind"]).toBe("refusal");
    expect(res["code"]).toBe("scope-violation");
    expect(readFile(ws, "outside.ts")).toBe('export const B = "old";\n');
  }, 30000);

  it("per-item unique-match overrides a failing call-level expected-hash", async () => {
    const { ws, srv } = await newServer("precond-item-override");
    writeFile(ws, "a.ts", "const a = 1;\n");

    const res = await srv.call("edit_file", {
      precondition: "expected-hash",
      expectedSha: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      edits: [
        { path: "a.ts", search: "a = 1", replace: "a = 2", precondition: "unique-match" },
      ],
    });
    expect(res["kind"]).not.toBe("refusal");
    expect(readFile(ws, "a.ts")).toBe("const a = 2;\n");
  }, 30000);

  it("an item without precondition inherits the call-level value and keeps the batch atomic", async () => {
    const { ws, srv } = await newServer("precond-item-inherit");
    writeFile(ws, "a.ts", "const a = 1;\n");
    writeFile(ws, "b.ts", "const b = 1;\n");

    const res = await srv.call("edit_file", {
      precondition: "expected-hash",
      expectedSha: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      edits: [
        { path: "a.ts", search: "a = 1", replace: "a = 2", precondition: "unique-match" },
        { path: "b.ts", search: "b = 1", replace: "b = 2" },
      ],
    });
    expect(res["kind"]).toBe("refusal");
    expect(res["code"]).toBe("hash-mismatch");
    expect(readFile(ws, "a.ts")).toBe("const a = 1;\n");
    expect(readFile(ws, "b.ts")).toBe("const b = 1;\n");
  }, 30000);

  it("item-level expectedSha can override top-level expectedSha when batching MULTIPLE files", async () => {
    const { ws, srv } = await newServer("precond-item-expected-sha");
    writeFile(ws, "a.ts", "const a = 1;\n");
    writeFile(ws, "b.ts", "const b = 1;\n");

    const readA = await srv.call("read_file", { path: "a.ts", mode: "full" });
    const readB = await srv.call("read_file", { path: "b.ts", mode: "full" });

    const res = await srv.call("edit_file", {
      precondition: "expected-hash",
      expectedSha: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      edits: [
        {
          path: "a.ts",
          search: "a = 1",
          replace: "a = 2",
          precondition: "expected-hash",
          expectedSha: readA["sha"] as string,
        },
        {
          path: "b.ts",
          search: "b = 1",
          replace: "b = 2",
          precondition: "expected-hash",
          expectedSha: readB["sha"] as string,
        },
      ],
    });

    expect(res["kind"]).not.toBe("refusal");
    expect(readFile(ws, "a.ts")).toBe("const a = 2;\n");
    expect(readFile(ws, "b.ts")).toBe("const b = 2;\n");
  }, 30000);

  it("unique-match + edits[] applies when every batch item has exactly one scoped match", async () => {
    const { ws, srv } = await newServer("precond-unique-match-batch-supported");
    writeFile(ws, "whatever.ts", "const x = 1;\n");
    const res = await srv.call("edit_file", {
      precondition: "unique-match",
      edits: [{ path: "whatever.ts", search: "x = 1", replace: "x = 2" }],
    });
    expect(res["kind"]).not.toBe("refusal");
    expect(readFile(ws, "whatever.ts")).toBe("const x = 2;\n");
  }, 30000);

  it("sanity (no regression): expected-hash on a SINGLE (non-batch) edit still works normally", async () => {
    const { ws, srv } = await newServer("precond-expected-hash-single-ok");
    writeFile(ws, "s.ts", "const s = 1;\n");
    const read = await srv.call("read_file", { path: "s.ts", mode: "full" });

    const res = await srv.call("edit_file", {
      path: "s.ts",
      precondition: "expected-hash",
      expectedSha: read["sha"],
      search: "s = 1",
      replace: "s = 2",
    });
    expect(res["kind"]).not.toBe("refusal");
    expect(readFile(ws, "s.ts")).toBe("const s = 2;\n");
  }, 30000);
});

// =============================================================================
// GROUP 5 (already sane / documented — edit_file): tested and confirmed to
// already produce a helpful refusal or a truthful, sensible interpretation.
// No server change; pinned so a future regression is caught.
// =============================================================================
describe("argMatrix — edit_file — already sane / documented (no change)", () => {
  it("handle + path pointing at a DIFFERENT file: the handle wins (documented — 'a handle IS the canonical reference'), and the response's own path field tells the truth", async () => {
    const { ws, srv } = await newServer("handle-path-conflict");
    writeFile(ws, "one.ts", "export const ONE = 1;\n");
    writeFile(ws, "two.ts", "export const TWO = 2;\n");
    const h = await srv.call("read_file", { path: "one.ts", mode: "full" });

    const res = await srv.call("edit_file", { handle: h["handle"], path: "two.ts", search: "ONE = 1", replace: "ONE = 100" });
    expect(res["kind"]).not.toBe("refusal");
    expect(res["path"]).toBe("one.ts"); // truthful: reflects what actually got edited
    expect(readFile(ws, "one.ts")).toBe("export const ONE = 100;\n");
    expect(readFile(ws, "two.ts")).toBe("export const TWO = 2;\n"); // untouched
  }, 30000);

  it("handle (existing file) + create:true: refuses 'file_exists' rather than silently overwriting the handle's file", async () => {
    const { ws, srv } = await newServer("handle-create-conflict");
    writeFile(ws, "existing.ts", "export const E = 1;\n");
    const h = await srv.call("read_file", { path: "existing.ts", mode: "full" });

    const res = await srv.call("edit_file", { handle: h["handle"], create: true, content: "export const OVERWRITTEN = true;\n" });
    expect(res["kind"]).toBe("refusal");
    expect(res["code"]).toBe("create-target-exists"); // A.9.2 row 6: the `file_exists` machine token is now `code`; the prose is `detail`.
    expect(readFile(ws, "existing.ts")).toBe("export const E = 1;\n");
  }, 30000);

  it("create:true with BOTH from= and content=: content (the explicit literal) wins over from (an indirect copy source)", async () => {
    const { ws, srv } = await newServer("create-from-content");
    writeFile(ws, "src.ts", "export const SRC = 1;\n");

    const res = await srv.call("edit_file", { create: true, path: "out.ts", from: "src.ts", content: "export const EXPLICIT = 99;\n", cwd: ws });
    expect(res["kind"]).not.toBe("refusal");
    expect(readFile(ws, "out.ts")).toBe("export const EXPLICIT = 99;\n");
  }, 30000);

  it("mode='rename' with extraneous search/replace fields: ignored — rename proceeds using from/to only, no partial/garbled result", async () => {
    const { ws, srv } = await newServer("rename-extra-fields");
    writeFile(ws, "r.ts", "export function oldName() { return 1; }\nexport function caller() { return oldName(); }\n");

    const res = await srv.call("edit_file", { mode: "rename", from: "oldName", to: "newName", path: "r.ts", search: "SHOULD BE IGNORED", replace: "IGNORED TOO" });
    expect(res["kind"]).not.toBe("refusal");
    const updated = readFile(ws, "r.ts");
    expect(updated).toContain("newName");
    expect(updated).not.toContain("SHOULD BE IGNORED");
    expect(updated).not.toContain("oldName");
  }, 30000);

  it("intent + edits[] together is an explicit mutual-exclusion error and writes nothing", async () => {
    const { ws, srv } = await newServer("intent-edits-conflict");
    writeFile(ws, "i.ts", "export function foo() { return 1; }\n");
    const h = await srv.call("read_file", { path: "i.ts", mode: "full" });

    const res = await srv.call("edit_file", {
      handle: h["handle"],
      intent: "definitely-not-a-real-intent",
      edits: [{ path: "i.ts", search: "foo", replace: "bar" }],
    });
    expect(res["kind"]).toBe("refusal");
    expect(res["code"]).toBe("intent-incompatible-with-batch");
    expect(res["files"]).toBeUndefined();
    expect(readFile(ws, "i.ts")).toBe("export function foo() { return 1; }\n");
  }, 30000);

  it("review:true + create:true: produces a coherent review object instead of crashing on the create result's missing lines/delta fields", async () => {
    const { ws, srv } = await newServer("review-create");
    const res = await srv.call("edit_file", { create: true, path: "new.ts", content: "export const N = 1;\n", review: true, cwd: ws });
    expect(res["kind"]).not.toBe("refusal");
    const review = res["review"] as Record<string, unknown>;
    expect(review).toBeTruthy();
    expect(Array.isArray(review["touched"])).toBe(true);
    expect((review["touched"] as unknown[]).length).toBe(1);
  }, 30000);

  it("review:true + edits[] (multi-file batch): review.touched lists every file in the batch", async () => {
    const { ws, srv } = await newServer("review-batch");
    writeFile(ws, "a.ts", "export const A = 1;\n");
    writeFile(ws, "b.ts", "export const B = 1;\n");

    const res = await srv.call("edit_file", {
      review: true,
      edits: [
        { path: "a.ts", search: "A = 1", replace: "A = 2" },
        { path: "b.ts", search: "B = 1", replace: "B = 2" },
      ],
    });
    expect(res["kind"]).not.toBe("refusal");
    const review = res["review"] as Record<string, unknown>;
    const touchedPaths = (review["touched"] as Array<{ path: string }>).map((t) => t.path).sort();
    expect(touchedPaths).toEqual(["a.ts", "b.ts"]);
  }, 30000);

  it("handle carrying its own symbol tag + an explicit WIDER range, no mode: routes to slice honoring the caller's range (2026-07-11a fix), not the handle's narrower symbol span", async () => {
    const { ws, srv } = await newServer("handle-symbol-tag-wider-range");
    writeFile(ws, "w.ts", "export function alpha() {\n  return 1;\n}\n\nexport function beta() {\n  return 2;\n}\n\nexport function gamma() {\n  return 3;\n}\n");

    // FLIPPED BACK 2026-08-14. The interim expectation here was `refusal`,
    // caused by `textEvidence()` reading only a STRING `range` and a `content`
    // field while `mode=symbol` emits `range:{start,end}` and its text under
    // `code` — so the symbol serve projected to `evidence: []`, no handle
    // reached the wire, and the follow-up call had no target to widen. The
    // projector now understands both dialects, so the original 2026-07-11a
    // expectation is restored: the caller's WIDER range wins over the handle's
    // narrower symbol span.
    const symH = await srv.call("read_file", { path: "w.ts", mode: "symbol", symbol: "beta" });
    const symHandle = (symH["evidence"] as Array<Record<string, unknown>>)[0]?.["handle"];
    expect(String(symHandle)).toMatch(/^h[0-9a-z]+$/);
    const widened = await srv.call("read_file", { handle: symHandle, range: "1-9" });
    expect(widened["kind"]).toBe("read.text");
    const widenedEvidence = (widened["evidence"] as Array<Record<string, unknown>>)[0]!;
    expect(widenedEvidence["range"]).toBe("1-9");
    expect(String(widenedEvidence["body"])).toContain("alpha");
    expect(String(widenedEvidence["body"])).toContain("gamma");
  }, 30000);
});

// =============================================================================
// GROUP 6 (already sane / documented — read_file): read-only, so the worst
// outcome is a wrong/incomplete ANSWER rather than data loss. Each combo
// below was tested and already resolves to a truthful, self-documenting
// response or a pre-existing explicit refusal.
// =============================================================================
describe("argMatrix — read_file — already sane / documented (no change)", () => {
  it("reuses a long task_pack query through a workspace-bound qref and rejects a stale ref", async () => {
    const { ws, srv } = await newServer("read-task-pack-qref");
    writeFile(ws, "src/order.ts", "export function priceOrder() {\n  return 42;\n}\n");
    const query = `Explain priceOrder and its contract. ${"Include exact evidence. ".repeat(40)}`;

    const first = await srv.call("read_file", {
      mode: "task_pack",
      query,
      taskProfile: "answer",
      paths: ["src/order.ts"],
    });
    const qref = String(first["qref"]);
    expect(qref).toMatch(/^q-[a-f0-9]{16}$/);

    await srv.call("read_file", {
      mode: "full",
      path: "src/order.ts",
      query: "Unrelated hint for a non-task-pack read.",
    });

    const repeated = await srv.call("read_file", {
      mode: "task_pack",
      qref,
      taskProfile: "answer",
      paths: ["src/order.ts"],
    });
    expect(repeated["kind"]).toBe("read.receipt");
    // P0 (2026-08-12): qref is compact query transport, not an authority to
    // re-open a prepared task. Its replay has no challenge/new task epoch, so
    // it must return the zero-content prepared receipt rather than re-serving
    // the pack (or silently treating qref as a new task).
    // v1 (A.4): the flat receipt fields collapse into ONE nested receipt
    // object; `decision_unchanged`/`new_content`/`retry_same_call` no longer
    // exist.
    //
    // MIGRATED 2026-08-21 (wave D / F-C1), decision-unchanged -> pack-unchanged.
    // This assertion used to record the SIDE EFFECT of a defect, not a designed
    // behavior: `canServeCachedTaskPackReceipt` ran on RAW pre-resolution args,
    // so `args.query` was undefined for every wire qref replay, the exact-
    // reissue fingerprint could never match, and the dispatcher fence fell back
    // to the leaner decision-identity notice. With the preflight resolving the
    // qref, this replay is recognized for what it is — a byte-identical
    // re-issue of a pack whose every surface file is still unchanged — so it
    // gets the RICHER exact-reissue form, which restates every held surface
    // with the call that served it instead of only re-affirming the decision.
    // Both forms say "nothing changed"; this one also says WHAT the caller
    // holds. Still zero content re-served: `body`-less entries, no code.
    const repeatedReceipt = repeated["receipt"] as Record<string, unknown> | undefined;
    expect(repeatedReceipt?.["receipt"]).toBe("pack-unchanged");
    const repeatedHeld = repeatedReceipt?.["evidence"] as Array<Record<string, unknown>> | undefined;
    expect(repeatedHeld?.length ?? 0).toBeGreaterThan(0);
    for (const entry of repeatedHeld ?? []) {
      expect(entry["prior"]).toBeDefined();
      expect(entry["body"]).toBeUndefined();
    }
    expect(repeated["code_unchanged"]).toBeUndefined();
    expect(repeated["query_mismatch"]).toBeUndefined();
    const fullQueryArgsBytes = Buffer.byteLength(
      JSON.stringify({ mode: "task_pack", query }),
      "utf8",
    );
    const qrefArgsBytes = Buffer.byteLength(
      JSON.stringify({ mode: "task_pack", qref }),
      "utf8",
    );
    expect(qrefArgsBytes).toBeLessThan(fullQueryArgsBytes - 500);
    if (process.env["TL_REPORT_EFFECTS"] === "1") {
      const savedPercent = ((fullQueryArgsBytes - qrefArgsBytes) / fullQueryArgsBytes) * 100;
      console.info(
        `[effect:qref] args_bytes=${fullQueryArgsBytes}->${qrefArgsBytes} saved=${fullQueryArgsBytes - qrefArgsBytes} (${savedPercent.toFixed(1)}%)`,
      );
    }

    const replacement = await srv.call("read_file", {
      mode: "task_pack",
      query: "Explain a different task.",
      taskProfile: "answer",
      paths: ["src/order.ts"],
      taskEpoch: "new",
    });
    expect(replacement["qref"]).not.toBe(qref);

    // taskEpoch:new clears the previous task's qrefs. Repeat it here so this
    // assertion exercises qref expiry rather than the replacement task's own
    // prepared fence.
    const stale = await srv.call("read_file", { mode: "task_pack", qref, taskEpoch: "new" });
    expect(String(stale["detail"])).toContain("unknown-or-stale-qref");
  }, 30000);

  // W3 (2026-07-30, dist build-id echo): a response self-identifies which
  // server build produced it, so a stale MCP child (still serving pre-fix
  // dist/ bytes after a rebuild) is detectable from the outside — but only
  // on the FIRST task_pack response of a session, never on every response
  // (byte economy; see claimServerBuildAnnouncement / attachServerBuildOnce).
  it("carries server_build on the FIRST task_pack response of a session and omits it on the second", async () => {
    const { ws, srv } = await newServer("read-task-pack-server-build");
    writeFile(ws, "src/greet.ts", "export function greet() {\n  return 'hi';\n}\n");

    const first = await srv.call("read_file", {
      mode: "task_pack",
      query: "Explain greet and its contract.",
      taskProfile: "answer",
      paths: ["src/greet.ts"],
    });
    expect(first["ok"]).not.toBe(false);
    expect(typeof first["server_build"]).toBe("string");
    expect(String(first["server_build"]).length).toBeGreaterThan(0);

    const second = await srv.call("read_file", {
      mode: "task_pack",
      query: "A completely different question about the same file.",
      taskProfile: "answer",
      paths: ["src/greet.ts"],
    });
    expect(second["ok"]).not.toBe(false);
    expect(second["server_build"]).toBeUndefined();
  }, 30000);

  it("handle + path pointing at a DIFFERENT file: the handle wins, and the response's path/content reflect the handle's file, not the caller's stray path", async () => {
    const { ws, srv } = await newServer("read-handle-path-conflict");
    writeFile(ws, "one.ts", "export function alpha() {\n  return 1;\n}\n");
    writeFile(ws, "two.ts", "export function beta() {\n  return 2;\n}\n");

    const h1 = await srv.call("read_file", { path: "one.ts", mode: "full" });
    const res = await srv.call("read_file", { handle: h1["handle"], path: "two.ts", mode: "auto" });
    const conflictEvidence = res["evidence"] as Array<Record<string, unknown>> | undefined;
    expect(conflictEvidence?.[0]?.["path"]).toBe("one.ts");
    expect(String(conflictEvidence?.[0]?.["body"])).toContain("alpha");
    expect(String(conflictEvidence?.[0]?.["body"])).not.toContain("beta");
  }, 30000);

  it("handles:[] batch + a single top-level handle together: the batch wins outright; the singular handle's target is not silently substituted in", async () => {
    const { ws, srv } = await newServer("read-handles-batch-plus-single");
    writeFile(ws, "one.ts", "export function alpha() {\n  return 1;\n}\n");
    writeFile(ws, "two.ts", "export function beta() {\n  return 2;\n}\n");

    // NOTE: handles[] resolves each id through resolveSlice (see A7's doc
    // comment in server.ts: "resolves N handles to N SLICES"), which requires
    // a symbol or range — mode=slice mints that; mode=full mints a plain
    // kind:"file" handle with neither, which legitimately (if a little
    // opaquely — reason:"not-found" for a file that plainly exists) cannot
    // be resolved through this batch path. That is a separate, low-severity,
    // read-only observation orthogonal to THIS combo (handle + handles[]
    // together); use range handles for both so the combo under test —
    // whether the top-level singular `handle` leaks into the batch — is
    // isolated from it.
    const h1 = await srv.call("read_file", { path: "one.ts", mode: "slice", range: "1-3" });
    const h2 = await srv.call("read_file", { path: "two.ts", mode: "slice", range: "1-3" });
    const res = await srv.call("read_file", { handle: h1["handle"], handles: [h2["handle"]] });
    // v1: "handles" is a READ_BATCH_MODES member -> kind read.batch;
    // `items[]` folds into `entries[]` (A.5.4).
    expect(res["kind"]).toBe("read.batch");
    const items = res["entries"] as Array<{ handle: string }>;
    expect(items.map((i) => i.handle)).toEqual([h2["handle"]]);
  }, 30000);

  it("mode=full + paths[] + a singular path (all three given): paths[] wins outright, the singular path is not also served", async () => {
    const { ws, srv } = await newServer("read-full-paths-plus-path");
    writeFile(ws, "one.ts", "export function alpha() {\n  return 1;\n}\n");
    writeFile(ws, "two.ts", "export function beta() {\n  return 2;\n}\n");

    const res = await srv.call("read_file", { path: "one.ts", mode: "full", paths: ["two.ts"] });
    // v1: a paths[]-triggered batch body classifies as read.batch regardless
    // of the REQUESTED `mode` string; `items[]` folds into `entries[]` (A.5.4).
    expect(res["kind"]).toBe("read.batch");
    const items = res["entries"] as Array<{ path: string }>;
    expect(items.map((i) => i.path)).toEqual(["two.ts"]);
  }, 30000);

  it("mode=slice with symbol AND range both given directly (no handle): symbol wins (resolveSlice's documented priority), and the response's range field reports the SYMBOL's true span, not the caller's numeric range", async () => {
    const { ws, srv } = await newServer("read-slice-symbol-and-range");
    writeFile(ws, "one.ts", "export function alpha() {\n  return 1;\n}\n");

    const res = await srv.call("read_file", { path: "one.ts", mode: "slice", symbol: "alpha", range: "1-1" });
    const symbolPriorityEvidence = res["evidence"] as Array<Record<string, unknown>> | undefined;
    expect(symbolPriorityEvidence?.[0]?.["range"]).not.toBe("1-1"); // truthful: not the caller's (wrong) numeric guess
    expect(String(symbolPriorityEvidence?.[0]?.["body"])).toContain("alpha");
  }, 30000);

  it("mode=pack with BOTH paths[] and query: pre-existing explicit mutual-exclusion error, unaffected", async () => {
    const { ws, srv } = await newServer("read-pack-paths-and-query");
    writeFile(ws, "one.ts", "export function alpha() { return 1; }\n");

    const res = await srv.call("read_file", { mode: "pack", paths: ["one.ts"], query: "alpha", includeClosure: false });
    expect(res["kind"]).toBe("refusal");
    expect(String(res["detail"])).toContain("mutually exclusive");
  }, 30000);

  it("comments='bogus' (not in the elide|keep enum): pre-existing explicit refusal, unaffected", async () => {
    const { ws, srv } = await newServer("read-comments-bogus");
    writeFile(ws, "one.ts", "export const A = 1;\n");
    const res = await srv.call("read_file", { path: "one.ts", mode: "full", comments: "bogus" });
    expect(res["kind"]).toBe("refusal");
    expect(String(res["detail"])).toContain("comments");
  }, 30000);

  it("mode=artifact kind='docx' on a file that is actually a valid .xlsx (kind/extension mismatch, both are OOXML zips): clean, non-misleading parser refusal, not a garbage 'success'", async () => {
    const { ws, srv } = await newServer("read-artifact-kind-mismatch");
    const xlsxBytes = await buildTestXlsxBytes();
    fs.writeFileSync(path.join(ws, "real.xlsx"), xlsxBytes);

    const res = await srv.call("read_file", { path: "real.xlsx", mode: "artifact", kind: "docx" });
    expect(res["kind"]).toBe("refusal");
    // Confirmed live: exceljs' docx section reader correctly detects this
    // isn't a docx body rather than silently returning empty/garbage sections.
    expect(String(res["detail"]).toLowerCase()).toMatch(/docx|body/);
  }, 30000);
});

// =============================================================================
// GROUP 7 (already sane / documented — search_files): read-only, no data-loss
// surface. Each combo below was tested and confirmed already-guarded or a
// documented, truthful fallback chain.
// =============================================================================
describe("argMatrix — search_files — already sane / documented (no change)", () => {
  it("queries[] + query together: pre-existing explicit mutual-exclusion error", async () => {
    const { srv } = await newServer("search-queries-and-query");
    const res = await srv.call("search_files", { action: "find", query: "alpha", queries: ["alpha", "beta"] });
    expect(res["kind"]).toBe("refusal");
    expect(String(res["detail"])).toContain("not both");
  }, 30000);

  it("queries[] on a non-find action (e.g. action=symbols): pre-existing explicit error, names the offending action", async () => {
    const { srv } = await newServer("search-queries-non-find");
    const res = await srv.call("search_files", { action: "symbols", query: "alpha", queries: ["alpha"] });
    expect(res["kind"]).toBe("refusal");
    expect(String(res["detail"])).toContain("action=find");
  }, 30000);

  it("action=references with BOTH symbol and query: symbol wins (documented fallback chain args.symbol ?? args.query)", async () => {
    const { ws, srv } = await newServer("search-references-symbol-and-query");
    writeFile(ws, "one.ts", "export function alphaFn() { return 1; }\nalphaFn();\n");
    writeFile(ws, "two.ts", "// betaFn is mentioned only here, never called\n");

    const res = await srv.call("search_files", { action: "references", symbol: "alphaFn", query: "betaFn" });
    expect(res["ok"]).not.toBe(false); // findReferences ran using symbol, not query
    // Sanity: the response is scoped to alphaFn, not betaFn (best-effort —
    // exact shape is findReferences.ts's own concern, not this audit's).
    expect(JSON.stringify(res)).toContain("alphaFn");
  }, 30000);
});

// =============================================================================
// GROUP 8 (FIXED -- D6, 2026-08-07 T13 rep0 forensics): task_pack query+qref
// mutual-exclusion refusal's `next` recovery hint used to unconditionally say
// "drop qref, restate query" -- even when the caller ALSO passed paths[] and so
// already held a certified (qref, paths) working set cheaper to keep than to
// discard. Confirmed live: the unconditional hint made one rep of a 3-rep run
// discard its certified pack on every retry (39 turns / 1.54MB) while sibling
// reps that happened to drop query instead stayed prepared throughout.
// Fix: resolveTaskPackQueryArg (server.ts) branches the hint on whether
// paths[] is present.
// =============================================================================
describe("argMatrix -- read_file -- FIXED: task_pack query+qref mutual-exclusion recovery hint", () => {
  it("(a) query+qref+paths: hint drops query, keeps qref+paths, embeds the real values (not the old drop-qref hint)", async () => {
    const { ws, srv } = await newServer("read-task-pack-query-qref-paths");
    writeFile(ws, "src/order.ts", "export function priceOrder() {\n  return 42;\n}\n");

    const res = await srv.call("read_file", {
      mode: "task_pack",
      query: "Explain priceOrder and its contract.",
      qref: "q-0123456789abcdef",
      paths: ["src/order.ts"],
    });
    expect(res["kind"]).toBe("refusal");
    expect(String(res["detail"])).toContain("query and qref are mutually exclusive for task_pack"); // §2.6: an unexecutable prose `next` folds into `detail`, so the token is contained rather than exact.
    expect(nextText(res as Record<string, unknown>)).toContain(
      'read_file mode=task_pack qref=q-0123456789abcdef paths=["src/order.ts"] (drop query — keeps the certified working set)',
    );
  }, 30000);

  it("(b) query+qref, no paths: keeps the original drop-qref-restate-query hint unchanged", async () => {
    const { srv } = await newServer("read-task-pack-query-qref-no-paths");

    const res = await srv.call("read_file", {
      mode: "task_pack",
      query: "Explain something.",
      qref: "q-0123456789abcdef",
    });
    expect(res["kind"]).toBe("refusal");
    expect(String(res["detail"])).toContain("query and qref are mutually exclusive for task_pack"); // §2.6: an unexecutable prose `next` folds into `detail`, so the token is contained rather than exact.
    expect(nextText(res as Record<string, unknown>)).toContain('read_file mode=task_pack query="<restate the request verbatim>" (drop qref)');
  }, 30000);

  it("(c) qref+paths, no query: stays closed under the prepared certificate", async () => {
    const { ws, srv } = await newServer("read-task-pack-qref-paths-no-query");
    writeFile(ws, "src/order.ts", "export function priceOrder() {\n  return 42;\n}\n");

    const seed = await srv.call("read_file", {
      mode: "task_pack",
      query: "Explain priceOrder and its contract.",
      taskProfile: "answer",
      paths: ["src/order.ts"],
    });
    const qref = String(seed["qref"]);
    expect(qref).toMatch(/^q-[a-f0-9]{16}$/);

    const res = await srv.call("read_file", {
      mode: "task_pack",
      qref,
      paths: ["src/order.ts"],
    });
    expect(res["kind"]).toBe("read.receipt");
    // v1 (A.4): see the (a) case above — the flat fields collapse into ONE
    // nested receipt object.
    //
    // MIGRATED 2026-08-21 (wave D / F-C1), decision-unchanged -> pack-unchanged,
    // for the same reason as GROUP 6's qref case: `qref + the SAME paths[]` is
    // an exact re-issue of the seed pack, and with the preflight resolving the
    // qref the server can finally see that. "Stays closed" is still exactly
    // what this pins — no new discovery, no re-served bodies — it is now said
    // in the form that also names what the caller is holding.
    const closedReceipt = res["receipt"] as Record<string, unknown> | undefined;
    expect(closedReceipt?.["receipt"]).toBe("pack-unchanged");
    const closedHeld = closedReceipt?.["evidence"] as Array<Record<string, unknown>> | undefined;
    expect(closedHeld?.length ?? 0).toBeGreaterThan(0);
    for (const entry of closedHeld ?? []) {
      expect(entry["body"], "a closed re-issue must not re-serve bodies").toBeUndefined();
    }
    expect(res["code_unchanged"]).toBeUndefined();
  }, 30000);
});

// =============================================================================
// GROUP 8 (FIXED, field-eval wave 2026-08-27): three field defects found in a
// pre-release manual pass, each confirmed live before the fix and pinned here
// after it. See server.ts's inline "field-eval T1/T2/T3" comments at the
// fixed sites for the full incident narrative.
// =============================================================================

describe("argMatrix — field-eval T1: mode=slice + paths[] guides instead of a bare dead-end", () => {
  it("paths=[one path]: refusal names the single path as an executable next, preserving range", async () => {
    const { ws, srv } = await newServer("t1-slice-paths-one");
    writeFile(ws, "src/one.ts", "export const ONE = 1;\nexport const TWO = 2;\n");
    const res = await srv.call("read_file", { mode: "slice", paths: ["src/one.ts"], range: "1-1" });
    expect(res["kind"]).toBe("refusal");
    expect(res["code"]).toBe("invalid-input");
    // `next` is a structured ToolCall ({tool, arguments}), like every other
    // refusal `next` in this protocol (§2.6) — parsed from the prose call the
    // fix emits, not shipped as raw prose itself.
    const next = res["next"] as { tool?: string; arguments?: Record<string, unknown> } | undefined;
    expect(next?.tool).toBe("read_file");
    expect(next?.arguments?.["mode"]).toBe("slice");
    expect(next?.arguments?.["path"]).toBe("src/one.ts");
    // The caller's own range must survive into the corrected call, not be
    // silently dropped along with the path/paths[] confusion.
    expect(next?.arguments?.["range"]).toBe("1-1");
  }, 30000);

  it("paths=[two paths]: refusal offers the mode=task_pack discovery form, not a re-slice of one file", async () => {
    const { ws, srv } = await newServer("t1-slice-paths-two");
    writeFile(ws, "src/a.ts", "export const A = 1;\n");
    writeFile(ws, "src/b.ts", "export const B = 1;\n");
    const res = await srv.call("read_file", { mode: "slice", paths: ["src/a.ts", "src/b.ts"] });
    expect(res["kind"]).toBe("refusal");
    expect(res["code"]).toBe("invalid-input");
    // This exact shape is actually caught by `normalizeWireArgs` EARLIER than
    // the T1 fix site (server.ts's own dead-code note explains why) — both
    // producers agree on mode=task_pack, so the caller sees one consistent
    // recovery regardless of which one fired.
    const next = res["next"] as { tool?: string; arguments?: Record<string, unknown> } | undefined;
    expect(next?.tool).toBe("read_file");
    expect(next?.arguments?.["mode"]).toBe("task_pack");
    expect(next?.arguments?.["paths"]).toEqual(["src/a.ts", "src/b.ts"]);
  }, 30000);

  it("a genuinely pathless slice (no path, no paths[], no handle) keeps the original bare refusal", async () => {
    const { srv } = await newServer("t1-slice-truly-pathless");
    const res = await srv.call("read_file", { mode: "slice" });
    expect(res["kind"]).toBe("refusal");
    expect(res["code"]).toBe("invalid-input");
    expect(String(res["detail"])).toContain("path (or handle) is required for mode=slice");
  }, 30000);
});

describe("argMatrix — field-eval T2: search_files queries[] > 5 names the remaining tokens structurally", () => {
  it("queries=6: next carries the first 5, remaining_queries carries the 6th verbatim", async () => {
    const { srv } = await newServer("t2-queries-six");
    const res = await srv.call("search_files", {
      action: "find",
      queries: ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"],
    });
    expect(res["kind"]).toBe("refusal");
    expect(res["code"]).toBe("invalid-input");
    const next = res["next"] as { tool?: string; arguments?: Record<string, unknown> } | undefined;
    expect(next?.tool).toBe("search_files");
    expect(next?.arguments?.["queries"]).toEqual(["alpha", "beta", "gamma", "delta", "epsilon"]);
    expect(res["remaining_queries"]).toEqual(["zeta"]);
  }, 30000);

  it("queries=7: remaining_queries carries both tail tokens, in order, without hand-slicing", async () => {
    const { srv } = await newServer("t2-queries-seven");
    const res = await srv.call("search_files", {
      action: "find",
      queries: ["a1", "a2", "a3", "a4", "a5", "a6", "a7"],
    });
    expect(res["kind"]).toBe("refusal");
    expect(res["remaining_queries"]).toEqual(["a6", "a7"]);
  }, 30000);
});

describe("argMatrix — field-eval T3: mode=handles labels a bare file-handle's synthesized whole-file range", () => {
  it("a bare file-kind handle (minted by mode=full) forwards its server-computed synthesized_range onto the wire", async () => {
    const { ws, srv } = await newServer("t3-handles-bare-file");
    writeFile(ws, "src/whole.ts", "export const WHOLE = 1;\nexport const SECOND = 2;\n");
    const full = await srv.call("read_file", { mode: "full", path: "src/whole.ts" });
    const bareHandle = String(full["handle"]);
    expect(bareHandle).toMatch(/^h/);

    const res = await srv.call("read_file", { mode: "handles", handles: [bareHandle] });
    expect(res["kind"]).toBe("read.batch");
    // readFamily.ts's projectBatch renames the internal `items[]` to the v1
    // wire field `entries[]` (Rule K) — assert the WIRE shape, not the
    // dispatch-internal one.
    const entries = res["entries"] as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(1);
    expect(entries[0]!["range"]).toBe("1-2");
    // Fixed 2026-08-27 (field-eval T3, cross-file boundary): batchEntry()'s
    // `handle !== undefined && range !== undefined` branch now keeps
    // "synthesized_range" (plus "note"/"concern_note", the same pre-existing
    // class of gap) alongside "content"/"sha".
    expect(entries[0]!["synthesized_range"]).toBe(true);
  }, 30000);

  it("a real ranged handle (minted by mode=slice range=...) carries NO synthesized_range marker", async () => {
    const { ws, srv } = await newServer("t3-handles-real-range");
    writeFile(ws, "src/ranged.ts", "line one\nline two\nline three\n");
    const sliced = await srv.call("read_file", { mode: "slice", path: "src/ranged.ts", range: "1-2" });
    const rangedHandle = String(sliced["handle"]);

    const res = await srv.call("read_file", { mode: "handles", handles: [rangedHandle] });
    const entries = res["entries"] as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(1);
    expect(entries[0]!["range"]).toBe("1-2");
    expect(entries[0]!["synthesized_range"]).toBeUndefined();
  }, 30000);
});

describe("argMatrix — field-eval integration T2: a truncated handles-batch entry is never a dead end", () => {
  /**
   * The residue the T3 keep-list fix left behind, closed 2026-08-27.
   *
   * `server.ts`'s handles-batch loop attaches `remaining_ranges` and `next` to
   * the SAME item shape T3 fixed — fed by `readCodeModes.ts`'s ordinary
   * range-slice byte-cap branch (READ_SYMBOL_CAP_BYTES = 24 KiB), which sets
   * both WITHOUT `downgraded_from`. `readFamily.ts`'s `batchEntry()` routed a
   * `downgraded_from` item to the `file-downgraded` form, whose
   * DOWNGRADE_FIELDS already kept both — so ONLY the non-downgraded truncation
   * lost them, which is why the gap survived T3. A wire entry with
   * `truncated:true` and no `next` contradicts the protocol's standing promise
   * that a recoverable truncation always carries an executable continuation.
   *
   * Fixture sizing is load-bearing: the file must exceed the 24 KiB SLICE cap
   * (so the batch serve truncates) while staying under the 80 KiB
   * READ_FULL_CAP_BYTES (so `mode=full` serves it whole and mints the bare
   * file-kind handle whose synthesized range is the WHOLE file).
   */
  const BIG_LINE = "export const PADDING_CONSTANT_FOR_BYTE_CAP_COVERAGE = 1234567890;";

  it("forwards remaining_ranges + an executable next onto the wire entry", async () => {
    const { ws, srv } = await newServer("t2-handles-truncated");
    const lines: string[] = [];
    for (let i = 0; i < 600; i += 1) lines.push(`${BIG_LINE} // line ${i}`);
    const body = `${lines.join("\n")}\n`;
    expect(Buffer.byteLength(body, "utf8")).toBeGreaterThan(24576);
    expect(Buffer.byteLength(body, "utf8")).toBeLessThan(81920);
    writeFile(ws, "src/wide.ts", body);

    const full = await srv.call("read_file", { mode: "full", path: "src/wide.ts" });
    const bareHandle = String(full["handle"]);
    expect(bareHandle).toMatch(/^h/);

    const res = await srv.call("read_file", { mode: "handles", handles: [bareHandle] });
    expect(res["kind"]).toBe("read.batch");
    const entries = res["entries"] as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    // Pre-condition: this IS the non-downgraded truncation branch.
    expect(entry["truncated"]).toBe(true);
    expect(entry["downgraded_from"]).toBeUndefined();
    // The fix: both continuation fields survive the projection.
    expect(Array.isArray(entry["remaining_ranges"])).toBe(true);
    expect((entry["remaining_ranges"] as string[])[0]).toMatch(/^\d+-\d+$/);
    expect(typeof entry["next"]).toBe("string");
    // Executable, not prose. The handle it names is the RESUME handle the
    // truncation minted, not necessarily the one this call passed in — the
    // 2026-08-01 truncated-mint consistency rule narrows a truncated serve's
    // recorded range/sha to the bytes actually served, so the continuation
    // rides a handle whose range/sha agree with each other.
    const remaining = (entry["remaining_ranges"] as string[])[0]!;
    const parsed = /^read_file mode=slice handle=(h\S+) range=(\S+)$/.exec(String(entry["next"]));
    expect(parsed, `next must be an executable slice call, got: ${String(entry["next"])}`).not.toBeNull();
    expect(parsed![2]).toBe(remaining);

    // Running it VERBATIM actually advances — the whole point of the promise.
    const resumed = await srv.call("read_file", {
      mode: "slice",
      handle: parsed![1]!,
      range: parsed![2]!,
    });
    expect(resumed["kind"]).toBe("read.text");
    // §3.3: served bytes ride `evidence[].body`, not a top-level `content`.
    const resumedBody = (resumed["evidence"] as Array<Record<string, unknown>>)
      .map((row) => String(row["body"] ?? ""))
      .join("");
    expect(resumedBody).not.toBe("");
    expect(resumedBody).toContain("PADDING_CONSTANT_FOR_BYTE_CAP_COVERAGE");
  }, 30000);

  it("an UNtruncated batch entry pays nothing for the two added keys (E-1)", async () => {
    const { ws, srv } = await newServer("t2-handles-small");
    writeFile(ws, "src/small.ts", "export const SMALL = 1;\n");
    const full = await srv.call("read_file", { mode: "full", path: "src/small.ts" });
    const res = await srv.call("read_file", { mode: "handles", handles: [String(full["handle"])] });
    const entry = (res["entries"] as Array<Record<string, unknown>>)[0]!;
    expect(entry["truncated"]).toBe(false);
    expect(entry["remaining_ranges"]).toBeUndefined();
    expect(entry["next"]).toBeUndefined();
  }, 30000);
});
