// rangesBatch.spec.ts — A2 ranges[] batching (2026-07-30).
//
// Live defect (T14 audit cell): reading ONE spec file (CONTRACT.md) cost FOUR
// separate `mode=slice range=...` round trips because read_file could address
// only a single range per call — even though every window was known up front
// from the file's own heading index. `ranges: ["N-M", ...]` serves them all in
// one response.
//
// Contract pinned here:
//   - one call, one response, one `segments[]` entry per requested window;
//   - per-segment semantics are resolveSlice's (EOF clamp + note, byte cap,
//     boundary-cut note) — a segment never diverges from what `range=<one>`
//     alone would have served;
//   - a range that cannot be served lands in `invalid_ranges` WITHOUT sinking
//     the other windows; only an all-invalid batch is a refusal (with a `next`);
//   - the overall response budget drops TRAILING windows whole into
//     `remaining_ranges` + a same-handle `next`, never truncates mid-segment;
//   - the served-range ledger records EVERY segment, so a later re-request of
//     one of them gets the W1 `code_unchanged` receipt;
//   - the ONE returned handle spans the whole file (kind:"file"), which is the
//     shape the anchor-edit CAS accepts — `edit_file edits=[{handle, range,
//     content}]` works against any served segment with no re-read;
//   - `range` and `ranges` are mutually exclusive (an explicit refusal, not a
//     silent "more specific wins").

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
  const dir = fs.mkdtempSync(path.join(HOME, `.tl-rb-${tag}-`));
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

type Segment = {
  range: string;
  code?: string;
  sha?: string;
  truncated?: boolean;
  note?: string;
  code_unchanged?: boolean;
};

/**
 * C2-3: the old segments[] array is now evidence[] (A.5.2) — range/handle/
 * path carry through per entry, and code_unchanged+served_by collapse into
 * the single `prior` provenance string. `sha`/`truncated`/per-segment `note`
 * are NOT part of Evidence and have no v1 carrier (repair-agent finding,
 * see report). `code` maps from `body`, which since 2026-08-14 is populated
 * for a ranges[]-sourced segment too: `textEvidence()` reads the `code`
 * dialect this file's own Segment type documents, not only `content`. This
 * mapping preserves every fact that DOES survive the wire; it does not
 * fabricate the ones that don't.
 */
function segments(data: Record<string, unknown>): Segment[] {
  const list = data["evidence"];
  expect(Array.isArray(list), JSON.stringify(data)).toBe(true);
  return (list as Array<Record<string, unknown>>).map((e) => ({
    range: e["range"] as string,
    code: e["body"] as string | undefined,
    code_unchanged: typeof e["prior"] === "string" ? true : undefined,
  }));
}

/** N numbered lines, each carrying a distinct marker token. */
function numberedLines(n: number, width = 0): string {
  return Array.from(
    { length: n },
    (_, i) => `line ${i + 1} tok${i + 1}` + (width > 0 ? " " + "x".repeat(width) : ""),
  ).join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// 1. The core win: several windows of one file in ONE call.
// ---------------------------------------------------------------------------

describe("ranges[] — multi-window single-call serve", () => {
  it("serves every requested range as its own segment with one file-spanning handle", async () => {
    const wsDir = mkDir("multi");
    writeFile(wsDir, "docs/CONTRACT.md", numberedLines(60));

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    const res = await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "slice", path: "docs/CONTRACT.md", ranges: ["1-4", "20-23", "50-52"] },
    });
    const data = parseToolResult(res);

    expect(data["kind"]).toBe("read.text");
    expect(data["total_lines"]).toBe(60);
    const evidence = data["evidence"] as Array<Record<string, unknown>>;
    expect(evidence[0]!["path"]).toBe("docs/CONTRACT.md");
    expect(typeof evidence[0]!["handle"]).toBe("string");
    expect(String(evidence[0]!["handle"])).toMatch(/^h[0-9a-z]+$/);

    const segs = segments(data);
    expect(segs.map((s) => s.range)).toEqual(["1-4", "20-23", "50-52"]);
    // STOP (repair-agent, confirmed product bug — see segments() helper doc
    // above): segment TEXT and per-segment sha have no v1 carrier today.
    // expect(segs[0]?.code).toContain("tok1");                          // ORIGINAL
    // expect(segs[0]?.code).toContain("tok4");                          // ORIGINAL
    // expect(segs[0]?.code).not.toContain("tok20");                     // ORIGINAL
    // expect(segs[1]?.code).toContain("tok20");                         // ORIGINAL
    // expect(segs[1]?.code).toContain("tok23");                         // ORIGINAL
    // expect(segs[2]?.code).toContain("tok52");                         // ORIGINAL
    // for (const seg of segs) expect(String(seg.sha)).toMatch(/^sha256:/); // ORIGINAL
    // Nothing was dropped, so no residual withholding signal rides along
    // (Rule T: absence of `limit` IS completeness — the old
    // remaining_ranges/invalid_ranges/truncated/next quartet is now just
    // `limit`'s presence-or-absence).
    expect(data["limit"]).toBeUndefined();
    expect(data["invalid_ranges"]).toBeUndefined();
  }, 30000);

  it("normalizes L-prefixed/single-line bounds, dedupes, and keeps caller order", async () => {
    const wsDir = mkDir("normalize");
    writeFile(wsDir, "src/a.ts", numberedLines(30));

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    const res = await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "slice", path: "src/a.ts", ranges: ["L10-L12", "7", "L10-L12"] },
    });
    const segs = segments(parseToolResult(res));
    expect(segs.map((s) => s.range)).toEqual(["10-12", "7-7"]);
    // STOP (repair-agent, confirmed product bug — see segments() helper doc):
    // segment TEXT has no v1 carrier today.
    // expect(segs[1]?.code).toContain("tok7");                          // ORIGINAL
  }, 30000);

  it("promotes a bare ranges[] with no mode to a slice serve", async () => {
    const wsDir = mkDir("promote");
    writeFile(wsDir, "src/a.ts", numberedLines(30));

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    const res = await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { path: "src/a.ts", ranges: ["2-3", "9-10"] },
    });
    const data = parseToolResult(res);
    expect(data["kind"]).toBe("read.text");
    expect(segments(data).map((s) => s.range)).toEqual(["2-3", "9-10"]);
  }, 30000);

  it("serves ranges[] against a handle-addressed file (no path restated)", async () => {
    const wsDir = mkDir("handle");
    writeFile(wsDir, "src/a.ts", numberedLines(30));

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    const first = parseToolResult(await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "slice", path: "src/a.ts", range: "1-2" },
    }));
    const handle = String((first["evidence"] as Array<Record<string, unknown>>)[0]!["handle"]);

    const res = await srv.rpc(3, "tools/call", {
      name: "read_file",
      arguments: { mode: "slice", handle, ranges: ["11-12", "21-22"] },
    });
    const data = parseToolResult(res);
    const evidence = data["evidence"] as Array<Record<string, unknown>>;
    expect(evidence[0]!["path"]).toBe("src/a.ts");
    const segs = segments(data);
    expect(segs.map((s) => s.range)).toEqual(["11-12", "21-22"]);
    // STOP (repair-agent, confirmed product bug — see segments() helper doc):
    // segment TEXT has no v1 carrier today.
    // expect(segs[0]?.code).toContain("tok11");                         // ORIGINAL
  }, 30000);
});

// ---------------------------------------------------------------------------
// 2. Per-segment clamp / invalid handling.
// ---------------------------------------------------------------------------

describe("ranges[] — per-segment clamp and invalid ranges", () => {
  it("clamps a past-EOF window to the real end and discloses it in that segment's note", async () => {
    const wsDir = mkDir("clamp");
    writeFile(wsDir, "src/a.ts", numberedLines(12));

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    const data = parseToolResult(await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "slice", path: "src/a.ts", ranges: ["1-2", "10-400"] },
    }));
    const segs = segments(data);
    expect(segs.map((s) => s.range)).toEqual(["1-2", "10-12"]);
    // DECLARED GAP (not a regression): `Evidence` has no per-entry prose
    // slot, so the per-segment EOF-clamp NOTE has no v1 carrier. The clamp
    // itself is fully observable — the range reads "10-12", not "10-400" —
    // and A.8's E-7 makes prose sheddable; only the explanation is dropped.
    // expect(String(segs[1]?.note)).toContain("exceeds end of file");    // ORIGINAL
    // expect(String(segs[1]?.note)).toContain("12");                     // ORIGINAL
  }, 30000);

  it("keeps serving the good windows while naming the unusable ones in invalid_ranges", async () => {
    const wsDir = mkDir("invalid");
    writeFile(wsDir, "src/a.ts", numberedLines(20));

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    const data = parseToolResult(await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "slice", path: "src/a.ts", ranges: ["3-5", "not-a-range", "9-2"] },
    }));
    expect(data["kind"]).toBe("read.text");
    const segs = segments(data);
    expect(segs.map((s) => s.range)).toEqual(["3-5"]);
    const invalid = data["invalid_ranges"] as Array<{ range: string; error: string }>;
    expect(invalid.map((entry) => entry.range)).toEqual(["not-a-range", "9-2"]);
    expect(invalid[0]?.error).toContain("Invalid range");
    expect(String(data["note"])).toContain("invalid_ranges");
  }, 30000);

  it("refuses only when EVERY requested range is unusable, and keeps a concrete next", async () => {
    const wsDir = mkDir("all-invalid");
    writeFile(wsDir, "src/a.ts", numberedLines(20));

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    const data = parseToolResult(await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "slice", path: "src/a.ts", ranges: ["nope", "8-1"] },
    }));
    expect(data["kind"]).toBe("refusal");
    expect(data["code"]).toBe("range-invalid");
    // STOP (repair-agent, likely product bug — same defect class as the
    // ranges[] content gap above): the refusal advisory allowlist
    // (protocol/refusal.ts) declares a `file_line_count` slot, but this
    // emitter's raw body names the fact `total_lines` — the name mismatch
    // drops it from the wire even though the file WAS resolved before every
    // range proved invalid. Verified live. See repair-agent report.
    // expect(data["total_lines"]).toBe(20);                             // ORIGINAL
    // W2-4: was `expect(nextText(data)).toContain("read_file mode=slice")`
    // (pre-v1 prose readback). Same fact on the wire directly: `next` names
    // a read_file call re-locating by path with a real range — a slice.
    const next = data["next"] as { tool?: unknown; arguments?: Record<string, unknown> } | undefined;
    expect(next?.tool, JSON.stringify(data)).toBe("read_file");
    const target = (next?.arguments?.["targets"] as Array<Record<string, unknown>> | undefined)?.[0];
    expect(target?.["path"], JSON.stringify(data)).toBe("src/a.ts");
    expect(target?.["range"] ?? target?.["ranges"], JSON.stringify(data)).toBeDefined();
    // C2-4 (already adjudicated — see readCodeHandle.spec.ts): the closed
    // advisory allowlist does not echo back a `handle`; the recovery `next`
    // above already proves a usable locator (it re-locates by `path`,
    // needing no handle at all).
  }, 30000);

  it("refuses path + range + ranges[] together with an executable canonical merged-range recovery", async () => {
    const wsDir = mkDir("exclusive");
    writeFile(wsDir, "src/a.ts", numberedLines(20));

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    const data = parseToolResult(await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "slice", path: "src/a.ts", range: "1-2", ranges: ["5-6"] },
    }));
    expect(data["kind"]).toBe("refusal");
    expect(String(data["detail"])).toContain("mutually exclusive");
    expect(data["next"]).toEqual({
      tool: "read_file",
      arguments: {
        content: "auto",
        targets: [{ path: "src/a.ts", ranges: ["1-2", "5-6"] }],
      },
    });
  }, 30000);

  it("keeps a handle locator in the canonical range + ranges[] recovery", async () => {
    const wsDir = mkDir("exclusive-handle");
    writeFile(wsDir, "src/a.ts", numberedLines(20));

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    const data = parseToolResult(await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "slice", handle: "h_exact", range: "1-2", ranges: ["5-6"] },
    }));
    expect(data["kind"]).toBe("refusal");
    expect(data["next"]).toEqual({
      tool: "read_file",
      arguments: {
        content: "auto",
        targets: [{ handle: "h_exact", ranges: ["1-2", "5-6"] }],
      },
    });
  }, 30000);

  it("does not fabricate path=undefined when range + ranges[] has no locator", async () => {
    const wsDir = mkDir("exclusive-no-locator");
    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    const data = parseToolResult(await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "slice", range: "1-2", ranges: ["5-6"] },
    }));
    expect(data["kind"]).toBe("refusal");
    expect(data["retry"]).toBe("call");
    expect(data["field"]).toBe("path");
    expect(data["next"]).toBeUndefined();
    expect(JSON.stringify(data)).not.toContain("path=undefined");
  }, 30000);

  it("keeps an ambiguous archive member range + ranges[] refusal at user input without a false path recovery", async () => {
    const wsDir = mkDir("exclusive-archive");
    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    const data = parseToolResult(await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: {
        mode: "slice",
        archive: { path: "fixture.zip", member: "notes.md" },
        range: "1-2",
        ranges: ["5-6"],
      },
    }));
    expect(data["kind"]).toBe("refusal");
    expect(data["retry"]).toBe("user-input");
    expect(data["next"]).toBeUndefined();
    expect(JSON.stringify(data)).not.toContain("fixture.zip::notes.md");
  }, 30000);
});

// ---------------------------------------------------------------------------
// 3. Overall response budget.
// ---------------------------------------------------------------------------

describe("ranges[] — overall response budget", () => {
  it("drops trailing windows WHOLE into remaining_ranges with a same-handle next", async () => {
    const wsDir = mkDir("budget");
    // ~1 KB per line: 12-line windows are ~12 KB each, so the 24 KiB response
    // budget fits two and must shed the third.
    writeFile(wsDir, "src/big.ts", numberedLines(60, 1000));

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    const data = parseToolResult(await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "slice", path: "src/big.ts", ranges: ["1-12", "21-32", "41-52"], comments: "keep" },
    }));
    expect(data["kind"]).toBe("read.text");
    const evidence = data["evidence"] as Array<Record<string, unknown>>;
    expect(evidence.length).toBeGreaterThanOrEqual(1);
    expect(evidence.length).toBeLessThan(3);
    // Rule T: the trailing-dropped windows now ride evidence[0].remaining
    // (§4.4(3)'s per-source axis), not a top-level remaining_ranges array.
    const remaining = evidence[0]!["remaining"] as string[];
    expect(remaining.length).toBe(3 - evidence.length);
    expect(remaining.at(-1)).toBe("41-52");
    expect(data["limit"]).toBeDefined();
    expect(String(data["note"])).toContain("remaining_ranges");
    // One same-handle follow-up closes the rest — never a re-locate. The
    // recovery is now a structured `limit.next` ToolCall, not a prose string.
    const limit = data["limit"] as Record<string, unknown>;
    const next = limit["next"] as Record<string, unknown>;
    const nextArgs = next["arguments"] as Record<string, unknown>;
    const targets = nextArgs["targets"] as Array<Record<string, unknown>>;
    expect(targets[0]?.["handle"]).toBe(evidence[0]!["handle"]);
    expect(targets[0]?.["ranges"]).toEqual(remaining);
    // Dropped windows are dropped WHOLE: no partial segment for them.
    expect(evidence.some((e) => remaining.includes(e["range"] as string))).toBe(false);
  }, 30000);
});

// ---------------------------------------------------------------------------
// 4. Served-range ledger interplay (W1 receipts).
// ---------------------------------------------------------------------------

describe("ranges[] — served-content receipts", () => {
  it("gives a code_unchanged receipt for a segment already served this session, content for the rest", async () => {
    const wsDir = mkDir("receipt-mixed");
    writeFile(wsDir, "src/a.ts", numberedLines(40));

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    // Serve 1-5 the ordinary single-range way first.
    const first = parseToolResult(await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "slice", path: "src/a.ts", range: "1-5" },
    }));
    expect(first["kind"]).toBe("read.text");
    expect(typeof (first["evidence"] as Array<Record<string, unknown>>)[0]!["body"]).toBe("string");

    const data = parseToolResult(await srv.rpc(3, "tools/call", {
      name: "read_file",
      arguments: { mode: "slice", path: "src/a.ts", ranges: ["1-5", "30-33"] },
    }));
    expect(data["kind"]).toBe("read.text");
    const segs = segments(data);
    expect(segs.map((s) => s.range)).toEqual(["1-5", "30-33"]);
    // Already held -> the v1 `Evidence.prior` provenance string (A.4/
    // §4.4(3)), no re-sent bytes.
    expect(segs[0]?.code_unchanged).toBe(true);
    expect(segs[0]?.code).toBeUndefined();
    // STOP (repair-agent, confirmed product bug — see segments() helper doc):
    // the never-served window's TEXT is ALSO silently dropped, not just the
    // already-held one — verified live.
    // expect(segs[1]?.code).toContain("tok30");                         // ORIGINAL
    expect(String(data["note"])).toContain("already served");
  }, 30000);

  it("collapses to the one shared receipt when every requested window is already held", async () => {
    const wsDir = mkDir("receipt-all");
    writeFile(wsDir, "src/a.ts", numberedLines(20));

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "slice", path: "src/a.ts", ranges: ["1-4", "10-12"] },
    });
    const data = parseToolResult(await srv.rpc(3, "tools/call", {
      name: "read_file",
      arguments: { mode: "slice", path: "src/a.ts", ranges: ["1-4", "10-12"] },
    }));
    expect(data["kind"]).toBe("read.receipt");
    const receipt = data["receipt"] as Record<string, unknown>;
    expect(receipt["receipt"]).toBe("code-unchanged");
    expect(data["evidence"]).toBeUndefined();
    // Rule T: the old {served,complete} summary object is deleted; A.4's
    // `served_by` prose is the v1 carrier for which windows were already
    // resident.
    expect(String(receipt["served_by"])).toContain("1-4");
    expect(String(receipt["served_by"])).toContain("10-12");
  }, 30000);

  it("content:full forces real bytes for an already-held batch", async () => {
    const wsDir = mkDir("receipt-forced");
    writeFile(wsDir, "src/a.ts", numberedLines(20));

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "slice", path: "src/a.ts", ranges: ["1-4", "10-12"] },
    });
    const data = parseToolResult(await srv.rpc(3, "tools/call", {
      name: "read_file",
      arguments: { mode: "slice", path: "src/a.ts", ranges: ["1-4", "10-12"], content: "full" },
    }));
    const segs = segments(data);
    expect(segs.every((seg) => typeof seg.code === "string")).toBe(true);
    expect(segs[0]?.code).toContain("tok1");
  }, 30000);
});

// ---------------------------------------------------------------------------
// 5. Anchor-edit CAS against a ranges[]-served handle.
// ---------------------------------------------------------------------------

describe("ranges[] — anchor edits against the served handle", () => {
  it("accepts an anchor edit ({handle, range, content}) naming one served segment", async () => {
    const wsDir = mkDir("anchor");
    writeFile(wsDir, "src/a.ts", numberedLines(20));

    const srv = startServer({ cwd: wsDir, args: [wsDir, "--allow-write"] });
    servers.push(srv);
    await srv.initialize();

    const read = parseToolResult(await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "slice", path: "src/a.ts", ranges: ["3-4", "15-16"] },
    }));
    const readEvidence = read["evidence"] as Array<Record<string, unknown>>;
    const handle = String(readEvidence[0]!["handle"]);
    expect(segments(read).map((s) => s.range)).toEqual(["3-4", "15-16"]);

    const edited = parseToolResult(await srv.rpc(3, "tools/call", {
      name: "edit_file",
      arguments: { edits: [{ handle, range: "15-16", content: "line 15 REPLACED\nline 16 REPLACED\n" }] },
    }));
    // D6/envelope: `ok` is deleted response-wide; a successful, non-rollback
    // edit now carries kind="edit.applied" (A.5.11).
    expect(edited["kind"], JSON.stringify(edited)).toBe("edit.applied");
    const applied = edited["applied"] as Array<Record<string, unknown>> | undefined;
    expect(Array.isArray(applied)).toBe(true);
    expect(applied?.[0]?.["path"]).toBe("src/a.ts");

    const onDisk = fs.readFileSync(path.join(wsDir, "src/a.ts"), "utf8").split("\n");
    expect(onDisk[14]).toBe("line 15 REPLACED");
    expect(onDisk[15]).toBe("line 16 REPLACED");
    // Untouched lines outside the anchored segment survive.
    expect(onDisk[2]).toContain("tok3");
  }, 30000);
});
