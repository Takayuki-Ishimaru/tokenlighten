/**
 * editFileKindFileHandle.spec.ts — FIX A (2026-07-12c forensics).
 *
 * Live failure: `read_file mode=full path=X` mints a handle with kind:"file"
 * and NO range (server.ts's resolveFullReadForPath). A later
 * `edit_file {handle, content}` (no search/replace/range/edits) is meant to
 * be a full-body replacement — the same shape a kind:"range" 1-EOF handle
 * already supports — but the gate that routes to replaceRangeContent used to
 * require handleRange, so the call fell through to the exact-search fallback
 * and failed with the misleading "search string is empty — for new file
 * creation use create:true" (write/textEdit.ts's empty-search error), even
 * though the caller supplied real content and never meant to create a file.
 *
 * Covers:
 *   (a1) kind:"file" handle + content full replace succeeds end-to-end.
 *   (a2) {handle, search, content} still refuses with the pre-existing
 *        search+content conflict message (no regression).
 *   (b1) bare {path, content} (no handle, no create) on an EXISTING file
 *        refuses with the new, actionable message.
 *   (b2) bare {path, content} on a MISSING file keeps the ORIGINAL
 *        create:true hint from searchReplaceEdit's not-found branch,
 *        unchanged.
 *
 * Harness copied from argMatrix.spec.ts's pattern (spawned server over
 * stdio, --allow-write, tmp-workspace-per-test).
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
  const dir = fs.mkdtempSync(path.join(HOME, `.tl-editfilekind-${tag}-`));
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
      clientInfo: { name: "vitest-editfilekind", version: "0" },
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

// =============================================================================
// (a1) kind:"file" handle + content full replace succeeds end-to-end.
// =============================================================================
describe("editFileKindFileHandle — (a1) kind:\"file\" handle + content full replace", () => {
  it("edit_file {handle, content} on a mode=full-minted kind:\"file\" handle replaces the whole body", async () => {
    const { ws, srv } = await newServer("full-replace-basic");
    writeFile(ws, "f.ts", "export const OLD = 1;\nexport const KEEP_GONE = 2;\n");

    const read = await srv.call("read_file", { path: "f.ts", mode: "full" });
    expect(String(read["handle"])).toMatch(/^h[0-9a-z]+$/);

    const newBody = "export const NEW = 42;\n";
    const res = await srv.call("edit_file", { handle: read["handle"], content: newBody });

    expect(res["ok"]).not.toBe(false);
    expect(res["path"]).toBe("f.ts");
    expect(typeof res["lines"]).toBe("string");
    expect(typeof res["delta"]).toBe("string");
    expect(typeof res["handle"]).toBe("string");
    expect(typeof res["sha"]).toBe("string");
    expect(String(res["sha"])).toMatch(/^sha256:[0-9a-f]{12,64}$/);

    expect(readFile(ws, "f.ts")).toBe(newBody);
  }, 30000);

  it("the SAME kind:\"file\" handle can be used again for a second full replace (post-edit sha refresh works)", async () => {
    const { ws, srv } = await newServer("full-replace-twice");
    writeFile(ws, "g.ts", "export const A = 1;\n");

    const read = await srv.call("read_file", { path: "g.ts", mode: "full" });
    const handle = read["handle"];

    const res1 = await srv.call("edit_file", { handle, content: "export const B = 2;\n" });
    expect(res1["ok"]).not.toBe(false);
    expect(readFile(ws, "g.ts")).toBe("export const B = 2;\n");

    // Second edit through the SAME handle id — proves withHandleAugment
    // refreshed the handle's sha (and kept it kind:"file", no range) after
    // the first edit, rather than leaving it pinned to the stale pre-edit sha.
    const res2 = await srv.call("edit_file", { handle, content: "export const C = 3;\n" });
    expect(res2["ok"]).not.toBe(false);
    expect(readFile(ws, "g.ts")).toBe("export const C = 3;\n");
  }, 30000);

  it("a small file's mode=auto handle (also kind:\"file\", no range) supports the same full replace", async () => {
    const { ws, srv } = await newServer("full-replace-auto-handle");
    writeFile(ws, "h.ts", "export const X = 1;\n");

    // mode=auto on a small file mints a kind:"file" handle too (server.ts's
    // small-file auto-mode branch), independent of mode=full's path.
    const read = await srv.call("read_file", { path: "h.ts", mode: "auto" });
    expect(String(read["handle"])).toMatch(/^h[0-9a-z]+$/);

    const res = await srv.call("edit_file", { handle: read["handle"], content: "export const Y = 2;\n" });
    expect(res["ok"]).not.toBe(false);
    expect(readFile(ws, "h.ts")).toBe("export const Y = 2;\n");
  }, 30000);

  it("multi-line content preserving no orphan tail (whole-file range synthesized correctly for a multi-line file)", async () => {
    const { ws, srv } = await newServer("full-replace-multiline");
    const original = [
      "export function alpha() {",
      "  return 1;",
      "}",
      "",
      "export function beta() {",
      "  return 2;",
      "}",
      "",
    ].join("\n");
    writeFile(ws, "m.ts", original);

    const read = await srv.call("read_file", { path: "m.ts", mode: "full" });
    const newBody = "export function gamma() {\n  return 3;\n}\n";
    const res = await srv.call("edit_file", { handle: read["handle"], content: newBody });

    expect(res["ok"]).not.toBe(false);
    // No orphan-tail warning: the whole file was replaced, nothing left over.
    expect(res["warning"]).toBeUndefined();
    expect(readFile(ws, "m.ts")).toBe(newBody);
  }, 30000);
});

// =============================================================================
// (a2) sanity: {handle, search, content} still refuses (no regression on the
// argMatrix P0 guard).
// =============================================================================
describe("editFileKindFileHandle — (a2) sanity: search+content conflict guard still fires on a kind:\"file\" handle", () => {
  it("handle (kind:\"file\") + search + content is rejected before mutation; file stays byte-identical", async () => {
    const { ws, srv } = await newServer("search-content-conflict-file-handle");
    writeFile(ws, "s.ts", "export const S = 1;\n");
    const before = readFile(ws, "s.ts");

    const read = await srv.call("read_file", { path: "s.ts", mode: "full" });
    const res = await srv.call("edit_file", {
      handle: read["handle"],
      search: "S = 1",
      content: "export const S = 999;\n",
    });

    expect(res["kind"]).toBe("refusal");
    expect(String(res["detail"])).toContain("replace");
    expect(readFile(ws, "s.ts")).toBe(before);
  }, 30000);
});

// =============================================================================
// (a3) batch edits[] with a kind:"file" handle entry — the SAME whole-file
// content-replacement shape as (a1)/(a2) above, but wrapped in edits[]. The
// batch assembly loop (server.ts's typedEdits.push, in the edits[] mapping
// section) used to silently drop entry.content for a range-less handle
// entry, falling through to the plain search/replace branch and hitting
// applyEditsMulti's misleading "search string is empty ... use create:true"
// refusal even though the target file exists. Fixed by giving the batch
// mapping loop a matching branch (server.ts) and applyEditsMulti's
// applyEditStep a matching whole-file-content case (applyEditsMulti.ts),
// mirroring FIX A's single-edit semantics but synthesizing the whole-file
// span from currentText AT EXECUTION TIME inside applyEditsMulti, not a
// range pre-computed by server.ts at assembly time.
// =============================================================================
describe("editFileKindFileHandle — (a3) batch edits[] with a kind:\"file\" handle entry", () => {
  it("edits:[{handle (kind:\"file\"), content}, {path, search, replace}] replaces the whole file AND applies the companion edit in one batch", async () => {
    const { ws, srv } = await newServer("batch-full-replace-plus-companion");
    writeFile(ws, "whole.ts", "export const OLD = 1;\nexport const KEEP_GONE = 2;\n");
    writeFile(ws, "companion.ts", 'export const COMPANION = "before";\n');

    const read = await srv.call("read_file", { path: "whole.ts", mode: "full" });
    expect(String(read["handle"])).toMatch(/^h[0-9a-z]+$/);

    const newBody = "export const NEW = 42;\n";
    const res = await srv.call("edit_file", {
      edits: [
        { handle: read["handle"], content: newBody },
        { path: "companion.ts", search: '"before"', replace: '"after"' },
      ],
    });

    expect(res["kind"]).not.toBe("refusal");
    // v1 (A.5.11): `files[]` folds into `applied[]`.
    const files = res["applied"] as Array<Record<string, unknown>>;
    expect(Array.isArray(files)).toBe(true);
    expect(files.length).toBe(2);
    const wholeResult = files.find((f) => f["path"] === "whole.ts");
    const companionResult = files.find((f) => f["path"] === "companion.ts");
    expect(wholeResult).toBeTruthy();
    expect(companionResult).toBeTruthy();
    expect(typeof wholeResult?.["handle"]).toBe("string");
    expect(typeof wholeResult?.["lines"]).toBe("string");
    expect(typeof wholeResult?.["delta"]).toBe("string");

    expect(readFile(ws, "whole.ts")).toBe(newBody);
    expect(readFile(ws, "companion.ts")).toBe('export const COMPANION = "after";\n');
  }, 30000);

  it("the SAME kind:\"file\" handle can be reused for a second batch whole-file replace", async () => {
    const { ws, srv } = await newServer("batch-full-replace-twice");
    writeFile(ws, "g.ts", "export const A = 1;\n");
    const read = await srv.call("read_file", { path: "g.ts", mode: "full" });
    const handle = read["handle"];

    const res1 = await srv.call("edit_file", { edits: [{ handle, content: "export const B = 2;\n" }] });
    expect(res1["ok"]).not.toBe(false);
    expect(readFile(ws, "g.ts")).toBe("export const B = 2;\n");

    const res2 = await srv.call("edit_file", { edits: [{ handle, content: "export const C = 3;\n" }] });
    expect(res2["ok"]).not.toBe(false);
    expect(readFile(ws, "g.ts")).toBe("export const C = 3;\n");
  }, 30000);

  it("merged group on the SAME path: a range edit followed by a kind:\"file\" whole-file content edit uses the file's state AT EXECUTION TIME, not a stale pre-read line count", async () => {
    const { ws, srv } = await newServer("batch-merged-same-path");
    const original = ["line1", "line2", "line3", "line4", "line5"].join("\n") + "\n";
    writeFile(ws, "merge.ts", original);

    // Mint TWO handles for the SAME file: a range handle for lines 1-2 (used
    // to shrink the file first), and a whole-file handle (used for the
    // second, whole-file-content edit in the SAME batch). If the whole-file
    // span were synthesized from a STALE line count captured at server.ts
    // assembly time (5 lines, before edit 1 even runs) instead of
    // currentText at execution time, edit 2 would wrongly refuse
    // ("out of bounds") once edit 1 has already shrunk the file to 4 lines.
    const rangeHandle = await srv.call("read_file", { path: "merge.ts", mode: "slice", range: "1-2" });
    const wholeHandle = await srv.call("read_file", { path: "merge.ts", mode: "full" });

    const res = await srv.call("edit_file", {
      edits: [
        { handle: rangeHandle["handle"], content: "shrunk\n" }, // 5 lines -> 4 lines
        { handle: wholeHandle["handle"], content: "final-whole-file-body\n" },
      ],
    });

    expect(res["ok"]).not.toBe(false);
    expect(readFile(ws, "merge.ts")).toBe("final-whole-file-body\n");
  }, 30000);
});

// =============================================================================
// (a4) guard sanity: batch edits[] kind:"file" handle entry shape guards —
// mirrors (a2) above (search+content conflict) and argMatrix.spec.ts's GROUP
// 1 range-entry wipe guard's spirit (never silently no-op), for the file-
// handle batch entry shape specifically.
// =============================================================================
describe("editFileKindFileHandle — (a4) batch guard sanity for the kind:\"file\" handle entry shape", () => {
  it("edits:[{handle (kind:\"file\"), content, search}] still refuses the search+content conflict; file stays byte-identical", async () => {
    const { ws, srv } = await newServer("batch-search-content-conflict-file-handle");
    writeFile(ws, "s.ts", "export const S = 1;\n");
    const before = readFile(ws, "s.ts");

    const read = await srv.call("read_file", { path: "s.ts", mode: "full" });
    const res = await srv.call("edit_file", {
      edits: [{ handle: read["handle"], search: "S = 1", content: "export const S = 999;\n" }],
    });

    expect(res["kind"]).toBe("refusal");
    expect(readFile(ws, "s.ts")).toBe(before);
  }, 30000);

  it("edits:[{handle (kind:\"file\")}] alone — no content, no search, no replace — refuses loudly instead of silently no-opping; file stays byte-identical", async () => {
    const { ws, srv } = await newServer("batch-file-handle-bare");
    writeFile(ws, "bare.ts", "export const BARE = 1;\n");
    const before = readFile(ws, "bare.ts");

    const read = await srv.call("read_file", { path: "bare.ts", mode: "full" });
    const res = await srv.call("edit_file", { edits: [{ handle: read["handle"] }] });

    expect(res["kind"]).toBe("refusal");
    expect(readFile(ws, "bare.ts")).toBe(before);
  }, 30000);
});

// =============================================================================
// (b) bare path+content (no handle, no create): existing vs missing file.
// =============================================================================
describe("editFileKindFileHandle — (b) bare {path, content} messaging", () => {
  it("(b1) EXISTING file: refuses with a message pointing at handle+content or search/replace (not the old misleading empty-search error)", async () => {
    const { ws, srv } = await newServer("bare-path-existing");
    writeFile(ws, "e.ts", "export const E = 1;\n");
    const before = readFile(ws, "e.ts");

    const res = await srv.call("edit_file", { path: "e.ts", content: "export const E = 999;\n" });

    expect(res["kind"]).toBe("refusal");
    const msg = String(res["detail"]); // A.9.2 row 6: `error` splits into `code` + `detail`.
    expect(msg).toContain("file exists");
    expect(msg).toContain("handle");
    expect(msg).toContain("search/replace");
    expect(msg).toContain("create:true");
    // The old misleading wording must be gone.
    expect(msg).not.toContain("search string is empty");
    // Never touched the file.
    expect(readFile(ws, "e.ts")).toBe(before);
  }, 30000);

  it("(b2) MISSING file: keeps the pre-existing create:true hint from searchReplaceEdit's not-found branch, unchanged", async () => {
    const { ws, srv } = await newServer("bare-path-missing");

    const res = await srv.call("edit_file", { path: "missing.ts", content: "export const M = 1;\n" });

    expect(res["kind"]).toBe("refusal");
    const msg = String(res["detail"]); // A.9.2 row 6: `error` splits into `code` + `detail`.
    expect(msg).toContain("File not found");
    expect(msg).toContain("create:true");
    expect(fs.existsSync(path.join(ws, "missing.ts"))).toBe(false);
  }, 30000);

  it("sanity (no regression): bare {path, content, create:true} on a missing file still creates it normally", async () => {
    const { ws, srv } = await newServer("bare-path-create-true");
    const res = await srv.call("edit_file", {
      path: "new.ts",
      content: "export const N = 1;\n",
      create: true,
      cwd: ws,
    });
    expect(res["kind"]).not.toBe("refusal");
    expect(readFile(ws, "new.ts")).toBe("export const N = 1;\n");
  }, 30000);
});

// =============================================================================
// (c) batch bare {path, content} (no handle, no search): existing vs missing —
// batch mirror of (b) above. The edits[] assembly loop's fallback for
// entries with NO handle used to silently drop entry.content and push
// {path, search:"", replace:""} into typedEdits, so an EXISTING target hit
// applyEditsMulti's misleading "search string is empty ... use create:true"
// refusal even though a real whole-file body was supplied.
// =============================================================================
describe("editFileKindFileHandle — (c) batch bare {path, content} messaging", () => {
  it("(c1) EXISTING file: refuses the WHOLE batch with the same message as (b1), not the old misleading empty-search error", async () => {
    const { ws, srv } = await newServer("batch-bare-path-existing");
    writeFile(ws, "e.ts", "export const E = 1;\n");
    const before = readFile(ws, "e.ts");

    const res = await srv.call("edit_file", { edits: [{ path: "e.ts", content: "export const E = 999;\n" }] });

    expect(res["kind"]).toBe("refusal");
    const msg = String(res["detail"]); // A.9.2 row 6: `error` splits into `code` + `detail`.
    expect(msg).toContain("file exists");
    expect(msg).toContain("handle");
    expect(msg).toContain("search/replace");
    expect(msg).toContain("create:true");
    // The old misleading wording must be gone.
    expect(msg).not.toContain("search string is empty");
    // Never touched the file.
    expect(readFile(ws, "e.ts")).toBe(before);
  }, 30000);

  it("(c2) MISSING file: the new existence-gated refusal must NOT fire for a path that doesn't exist — falls through unchanged to applyEditsMulti's own not-found handling", async () => {
    const { ws, srv } = await newServer("batch-bare-path-missing");

    const res = await srv.call("edit_file", { edits: [{ path: "missing.ts", content: "export const M = 1;\n" }] });

    expect(res["kind"]).toBe("refusal");
    const msg = String(res["detail"]); // A.9.2 row 6: `error` splits into `code` + `detail`.
    // Must NOT claim the file exists — it doesn't.
    expect(msg).not.toContain("file exists");
    expect(msg).toContain("File not found");
    expect(fs.existsSync(path.join(ws, "missing.ts"))).toBe(false);
  }, 30000);

  it("(c3) all-or-nothing: a batch with ONE bad bare-content entry alongside a VALID entry refuses the whole batch before either entry mutates", async () => {
    const { ws, srv } = await newServer("batch-bare-path-mixed");
    writeFile(ws, "e.ts", "export const E = 1;\n");
    writeFile(ws, "other.ts", "export const OTHER = 1;\n");

    const res = await srv.call("edit_file", {
      edits: [
        { path: "other.ts", search: "OTHER = 1", replace: "OTHER = 2" },
        { path: "e.ts", content: "export const E = 999;\n" },
      ],
    });

    expect(res["kind"]).toBe("refusal");
    expect(readFile(ws, "other.ts")).toBe("export const OTHER = 1;\n");
    expect(readFile(ws, "e.ts")).toBe("export const E = 1;\n");
  }, 30000);

  it("sanity (no regression): a bare {path, search, replace} batch entry (has search) is unaffected by the new content-only guard", async () => {
    const { ws, srv } = await newServer("batch-bare-path-searchreplace-unaffected");
    writeFile(ws, "e.ts", "export const E = 1;\n");

    const res = await srv.call("edit_file", { edits: [{ path: "e.ts", search: "E = 1", replace: "E = 2" }] });

    expect(res["kind"]).not.toBe("refusal");
    expect(readFile(ws, "e.ts")).toBe("export const E = 2;\n");
  }, 30000);

  it("sanity (no regression): batch handle+content (kind:\"file\") whole-file replace is unaffected by the new bare-path guard", async () => {
    const { ws, srv } = await newServer("batch-handle-content-unaffected");
    writeFile(ws, "h.ts", "export const H = 1;\n");
    const read = await srv.call("read_file", { path: "h.ts", mode: "full" });

    const res = await srv.call("edit_file", { edits: [{ handle: read["handle"], content: "export const H = 999;\n" }] });

    expect(res["kind"]).not.toBe("refusal");
    expect(readFile(ws, "h.ts")).toBe("export const H = 999;\n");
  }, 30000);
});
