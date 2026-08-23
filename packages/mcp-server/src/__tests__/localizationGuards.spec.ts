// localizationGuards.spec.ts — 2026-07-12b2 session-infrastructure guards
// (evidence: bench runs 2026-07-12a/a2/b/b2).
//
// Feature 1: one-shot UNREAD-SIBLING concern note on a session's first
//   successful edit_code — the "never-read decoy" killer. Session
//   read-side guards (concern_note) only cover files the agent PARTIALLY
//   read; a file never opened at all is invisible to them.
// Feature 2: concern-token harvest from search_files find, so Guard 2 /
//   Feature 1 can arm even in a pack-less session (buildTaskPack's own
//   concernAnchorTokens harvest never ran when zero task_packs were called).
// Feature 3: Guard 2 coverage for read_file mode=small_file outline/defer
//   serves — the slice path already had concern_note; the outline/defer
//   serve itself did not.
// Feature 4: idle-TTL (24h) session eviction so a long-lived server doesn't
//   grow util/session.ts's registry forever.
//
// Features 1-3 use the spawn-server RPC harness (mirrors
// readSessionGuards.spec.ts / editCodeHandle.spec.ts) since they exercise
// server.ts's real dispatch end to end. Feature 4 is a direct in-process
// unit test against util/session.ts (mirrors session.spec.ts) since it needs
// the setClockForTest seam, which only affects the CURRENT process's module
// state — unreachable through a spawned child server.

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  getSession,
  otherActiveRoots,
  recordReadMode,
  setClockForTest,
  resetClockForTest,
  resetAll,
} from "../util/session.js";

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
  const dir = fs.mkdtempSync(path.join(HOME, `.tl-locguards-${tag}-`));
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

afterEach(() => {
  for (const s of servers.splice(0)) s.kill();
  for (const d of tmpDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ok */ }
  }
});

function parseToolResult(rpcResult: any): Record<string, unknown> {
  const text = rpcResult?.result?.content?.[0]?.text;
  expect(typeof text).toBe("string");
  return JSON.parse(text);
}

/**
 * Same 183-line shape as readSessionGuards.spec.ts's buildConcernFixture:
 * "integral"/"clamp" bearing lines sit at L145-148, everything else is inert
 * filler. Each filler line is ALSO a `const NAME = N;` declaration, which
 * matters for Feature 3: readCodeSmallFile.ts's deriveOutline picks up
 * declaration lines and caps at 24 entries, so the fixture's own filler
 * legitimately fills the outline before L145 is ever reached.
 */
function buildConcernFixture(): string {
  const lines: string[] = [];
  for (let i = 1; i <= 144; i++) {
    lines.push(`  const filler_${i} = ${i}; // unrelated line`);
  }
  lines.push("  // Integral term");                            // L145
  lines.push("  integral += error * dt;");                     // L146
  lines.push("  // TODO: clamp the integral to avoid windup");  // L147
  lines.push("  output = integral;");                           // L148
  for (let i = 149; i <= 183; i++) {
    lines.push(`  const tail_${i} = ${i}; // unrelated line`);
  }
  return lines.join("\n") + "\n";
}

const GAIN_CONTROLLER_SRC =
  "// Integral term\nintegral += error * dt;\n// TODO: clamp the integral to avoid windup\noutput = integral;\n";

function numberedHunk(lines: number, value: number, prefix = "local_slot"): string {
  return Array.from({ length: lines }, (_, index) => `int ${prefix}_${index + 1} = ${value};`).join("\n");
}

// ---------------------------------------------------------------------------
// Feature 1 — one-shot unread-sibling note on the session's first edit
// ---------------------------------------------------------------------------

describe("Feature 1 — unread-sibling note on the session's first edit_code", () => {
  it("small single-file decoy edit suppresses the lexical unread_note false-positive", async () => {
    const wsDir = mkDir("f1-basic");
    writeFile(wsDir, "src/math/pid.cpp", "int decoy_value = 1;\n");
    writeFile(wsDir, "src/control/gain_controller.cpp", GAIN_CONTROLLER_SRC);

    const srv = startServer({ cwd: wsDir, args: [wsDir, "--allow-write"] });
    servers.push(srv);
    await srv.initialize();

    // Harvest concern tokens (task_pack query — same mechanism Guard 2 uses).
    await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "task_pack", query: "integral clamp", path: "src/math/pid.cpp" },
    });

    // Read + edit ONLY the decoy — mirrors the never-read-decoy shape: the
    // real bug file is never opened at all.
    await srv.rpc(3, "tools/call", {
      name: "read_file",
      arguments: { mode: "full", path: "src/math/pid.cpp" },
    });
    const editRes = await srv.rpc(4, "tools/call", {
      name: "edit_file",
      arguments: { path: "src/math/pid.cpp", search: "decoy_value = 1", replace: "decoy_value = 2" },
    });
    const data = parseToolResult(editRes);
    expect(editRes.result.isError).toBeFalsy();
    expect(data["kind"]).not.toBe("refusal");
    // Rule C: this one-line, single-file hunk has no identifier in the
    // otherwise token-matching sibling, so the old false-positive is silent.
    expect(data["unread_note"]).toBeUndefined();
  }, 30000);

  it.each([
    { lines: 39, expectsNote: false },
    { lines: 40, expectsNote: false },
    { lines: 41, expectsNote: true },
  ])("single-file hunk boundary: $lines lines -> unread_note=$expectsNote", async ({ lines, expectsNote }) => {
    const wsDir = mkDir(`f1-boundary-${lines}`);
    const before = numberedHunk(lines, 1);
    const after = numberedHunk(lines, 2);
    writeFile(wsDir, "src/math/pid.cpp", before);
    writeFile(wsDir, "src/control/gain_controller.cpp", GAIN_CONTROLLER_SRC);

    const srv = startServer({ cwd: wsDir, args: [wsDir, "--allow-write"] });
    servers.push(srv);
    await srv.initialize();
    await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "task_pack", query: "integral clamp", path: "src/math/pid.cpp" },
    });
    const editRes = await srv.rpc(3, "tools/call", {
      name: "edit_file",
      arguments: { path: "src/math/pid.cpp", search: before, replace: after },
    });
    const data = parseToolResult(editRes);
    expect(data["kind"]).not.toBe("refusal");
    if (expectsNote) expect(typeof data["unread_note"]).toBe("string");
    else expect(data["unread_note"]).toBeUndefined();
  }, 30000);

  it("TL_UNREAD_NOTE_MAX_HUNK_LINES overrides the default boundary", async () => {
    const wsDir = mkDir("f1-threshold-override");
    const before = numberedHunk(40, 1);
    const after = numberedHunk(40, 2);
    writeFile(wsDir, "src/math/pid.cpp", before);
    writeFile(wsDir, "src/control/gain_controller.cpp", GAIN_CONTROLLER_SRC);
    const srv = startServer({
      cwd: wsDir,
      args: [wsDir, "--allow-write"],
      env: { TL_UNREAD_NOTE_MAX_HUNK_LINES: "39" },
    });
    servers.push(srv);
    await srv.initialize();
    await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "task_pack", query: "integral clamp", path: "src/math/pid.cpp" },
    });
    const data = parseToolResult(await srv.rpc(3, "tools/call", {
      name: "edit_file",
      arguments: { path: "src/math/pid.cpp", search: before, replace: after },
    }));
    expect(typeof data["unread_note"]).toBe("string");
  }, 30000);

  it("rule B preserves a small-diff note when a hunk identifier hits the flagged sibling", async () => {
    const wsDir = mkDir("f1-rule-b");
    writeFile(wsDir, "src/math/pid.cpp", "int GAIN_CONTROLLER_MAGIC = 1;\n");
    writeFile(wsDir, "src/control/gain_controller.cpp", `// GAIN_CONTROLLER_MAGIC\n${GAIN_CONTROLLER_SRC}`);
    const srv = startServer({ cwd: wsDir, args: [wsDir, "--allow-write"] });
    servers.push(srv);
    await srv.initialize();
    await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "task_pack", query: "integral clamp", path: "src/math/pid.cpp" },
    });
    const data = parseToolResult(await srv.rpc(3, "tools/call", {
      name: "edit_file",
      arguments: {
        path: "src/math/pid.cpp",
        search: "GAIN_CONTROLLER_MAGIC = 1",
        replace: "GAIN_CONTROLLER_MAGIC = 2",
      },
    }));
    expect(typeof data["unread_note"]).toBe("string");
    expect(String(data["unread_note"])).toContain("gain_controller.cpp");
  }, 30000);

  it("a large edits[] multi-file first edit keeps the genuine T13-style note", async () => {
    const wsDir = mkDir("f1-multifile");
    const beforeA = numberedHunk(21, 1, "multi_a");
    const afterA = numberedHunk(21, 2, "multi_a");
    const beforeB = numberedHunk(21, 1, "multi_b");
    const afterB = numberedHunk(21, 2, "multi_b");
    writeFile(wsDir, "src/math/a.cpp", beforeA);
    writeFile(wsDir, "src/math/b.cpp", beforeB);
    writeFile(wsDir, "src/control/gain_controller.cpp", GAIN_CONTROLLER_SRC);
    const srv = startServer({ cwd: wsDir, args: [wsDir, "--allow-write"] });
    servers.push(srv);
    await srv.initialize();
    await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "task_pack", query: "integral clamp", path: "src/math/a.cpp" },
    });
    const data = parseToolResult(await srv.rpc(3, "tools/call", {
      name: "edit_file",
      arguments: { edits: [
        { path: "src/math/a.cpp", search: beforeA, replace: afterA },
        { path: "src/math/b.cpp", search: beforeB, replace: afterB },
      ] },
    }));
    expect(typeof data["unread_note"]).toBe("string");
    expect(String(data["unread_note"])).toContain("gain_controller.cpp");
  }, 30000);

  it("TL_UNREAD_NOTE_SPECIFICITY=off preserves the legacy one-shot behavior", async () => {
    const wsDir = mkDir("f1-once");
    writeFile(wsDir, "src/math/pid.cpp", "int decoy_value = 1;\n");
    writeFile(wsDir, "src/control/gain_controller.cpp", GAIN_CONTROLLER_SRC);

    const srv = startServer({
      cwd: wsDir,
      args: [wsDir, "--allow-write"],
      env: { TL_UNREAD_NOTE_SPECIFICITY: "off" },
    });
    servers.push(srv);
    await srv.initialize();

    await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "task_pack", query: "integral clamp", path: "src/math/pid.cpp" },
    });

    const first = await srv.rpc(3, "tools/call", {
      name: "edit_file",
      arguments: { path: "src/math/pid.cpp", search: "decoy_value = 1", replace: "decoy_value = 2" },
    });
    const firstData = parseToolResult(first);
    expect(firstData["kind"]).not.toBe("refusal");
    expect(typeof firstData["unread_note"]).toBe("string");

    // A DIFFERENT edit, same session — would otherwise still qualify (the
    // real sibling is still unread), but the note has already fired once.
    const second = await srv.rpc(4, "tools/call", {
      name: "edit_file",
      arguments: { path: "src/math/pid.cpp", search: "decoy_value = 2", replace: "decoy_value = 3" },
    });
    const secondData = parseToolResult(second);
    expect(secondData["kind"]).not.toBe("refusal");
    expect(secondData["unread_note"]).toBeUndefined();
  }, 30000);

  it("no concern tokens harvested this session -> no unread_note on the first edit", async () => {
    const wsDir = mkDir("f1-noconcern");
    writeFile(wsDir, "src/math/pid.cpp", "int decoy_value = 1;\n");
    writeFile(wsDir, "src/control/gain_controller.cpp", GAIN_CONTROLLER_SRC);

    const srv = startServer({ cwd: wsDir, args: [wsDir, "--allow-write"] });
    servers.push(srv);
    await srv.initialize();

    // No task_pack/locate/find call at all this session — concernTokens stays empty.
    const editRes = await srv.rpc(2, "tools/call", {
      name: "edit_file",
      arguments: { path: "src/math/pid.cpp", search: "decoy_value = 1", replace: "decoy_value = 2" },
    });
    const data = parseToolResult(editRes);
    expect(data["kind"]).not.toBe("refusal");
    expect(data["unread_note"]).toBeUndefined();
  }, 30000);

  it("the real sibling was already read this session -> no unread_note", async () => {
    const wsDir = mkDir("f1-alreadyread");
    writeFile(wsDir, "src/math/pid.cpp", "int decoy_value = 1;\n");
    writeFile(wsDir, "src/control/gain_controller.cpp", GAIN_CONTROLLER_SRC);

    const srv = startServer({ cwd: wsDir, args: [wsDir, "--allow-write"] });
    servers.push(srv);
    await srv.initialize();

    await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "task_pack", query: "integral clamp", path: "src/math/pid.cpp" },
    });

    // Read BOTH files this time — the agent actually opened the real one.
    await srv.rpc(3, "tools/call", {
      name: "read_file",
      arguments: { mode: "full", path: "src/control/gain_controller.cpp" },
    });

    const editRes = await srv.rpc(4, "tools/call", {
      name: "edit_file",
      arguments: { path: "src/math/pid.cpp", search: "decoy_value = 1", replace: "decoy_value = 2" },
    });
    const data = parseToolResult(editRes);
    expect(data["kind"]).not.toBe("refusal");
    expect(data["unread_note"]).toBeUndefined();
  }, 30000);

  it("a workspace-wide rename (changed_files, no top-level path) as the first edit also carries unread_note", async () => {
    const wsDir = mkDir("f1-rename");
    writeFile(wsDir, "src/math/pid.cpp", "int decoyValue = 1;\nint useDecoyValue() { return decoyValue; }\n");
    writeFile(wsDir, "src/control/gain_controller.cpp", GAIN_CONTROLLER_SRC);

    const srv = startServer({ cwd: wsDir, args: [wsDir, "--allow-write"] });
    servers.push(srv);
    await srv.initialize();

    await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "task_pack", query: "integral clamp", path: "src/math/pid.cpp" },
    });

    // No `path` — a workspace-wide rename, whose result carries
    // `changed_files` rather than a top-level `path`/`files`.
    const renameRes = await srv.rpc(3, "tools/call", {
      name: "edit_file",
      arguments: { mode: "rename", from: "decoyValue", to: "decoyValue2", lang: "cpp" },
    });
    const data = parseToolResult(renameRes);
    expect(renameRes.result.isError).toBeFalsy();
    expect(data["kind"]).not.toBe("refusal");
    expect(Array.isArray(data["changed_files"])).toBe(true);
    const note = data["unread_note"];
    expect(typeof note).toBe("string");
    expect(note as string).toContain("gain_controller.cpp");
  }, 30000);
});

// ---------------------------------------------------------------------------
// Feature 2 — concern-token harvest from search_files find
// ---------------------------------------------------------------------------

describe("Feature 2 — search_files find harvests concern-anchor tokens", () => {
  it("single query find, then a partial slice elsewhere -> concern_note now fires", async () => {
    const wsDir = mkDir("f2-query");
    writeFile(wsDir, "src/gain_controller.ts", buildConcernFixture());

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    // NO task_pack/locate call this session — only a find. Previously this
    // meant recordConcernTokens never ran and Guard 2 stayed structurally
    // dormant for the rest of the session (12b2 forensics).
    const findRes = await srv.rpc(2, "tools/call", {
      name: "search_files",
      arguments: { action: "find", query: "integral clamp" },
    });
    expect(findRes.result.isError).toBeFalsy();

    const res = await srv.rpc(3, "tools/call", {
      name: "read_file",
      arguments: { mode: "slice", path: "src/gain_controller.ts", range: "1-70" },
    });
    const data = parseToolResult(res);
    expect(res.result.isError).toBeFalsy();
    const note = data["concern_note"];
    expect(typeof note).toBe("string");
    expect(note as string).toMatch(/145-148/);
  }, 30000);

  it("queries[] entries are recorded directly -> concern_note fires", async () => {
    const wsDir = mkDir("f2-queries");
    writeFile(wsDir, "src/gain_controller.ts", buildConcernFixture());

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    const findRes = await srv.rpc(2, "tools/call", {
      name: "search_files",
      arguments: { action: "find", queries: ["integral", "clamp"] },
    });
    expect(findRes.result.isError).toBeFalsy();

    const res = await srv.rpc(3, "tools/call", {
      name: "read_file",
      arguments: { mode: "slice", path: "src/gain_controller.ts", range: "1-70" },
    });
    const data = parseToolResult(res);
    expect(res.result.isError).toBeFalsy();
    const note = data["concern_note"];
    expect(typeof note).toBe("string");
    expect(note as string).toMatch(/integral|clamp/);
  }, 30000);
});

// ---------------------------------------------------------------------------
// Feature 3 — Guard 2 coverage for mode=small_file outline/defer serves
// ---------------------------------------------------------------------------

describe("Feature 3 — concern_note on a small_file outline serve that hides a hit", () => {
  it("outline serve of a 183-line file, tokens at L145+ never surface in the outline -> concern_note", async () => {
    const wsDir = mkDir("f3-outline-miss");
    writeFile(wsDir, "src/gain_controller.ts", buildConcernFixture());

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "task_pack", query: "integral clamp", path: "src/gain_controller.ts" },
    });

    const res = await srv.rpc(3, "tools/call", {
      name: "read_file",
      arguments: { mode: "small_file", path: "src/gain_controller.ts", content: "outline" },
    });
    const data = parseToolResult(res);
    expect(res.result.isError).toBeFalsy();
    // C2-3 renamed `contentMode` -> `content_mode` (readCodeSmallFile.ts's own
    // comment: "renamed from `contentMode` — it was the read family's
    // [naming convention]"); KEPT_ON_TEXT carries the new snake_case name.
    expect(data["content_mode"]).toBe("outline");
    const note = data["concern_note"];
    expect(typeof note).toBe("string");
    expect(note as string).toMatch(/integral|clamp/);
  }, 30000);

  it("the concern token is visible in the outline text itself -> no concern_note", async () => {
    const wsDir = mkDir("f3-outline-visible");
    const lines: string[] = ["function clampValue(x) {", "  return x;", "}"];
    for (let i = 2; i <= 20; i++) lines.push(`const filler_${i} = ${i};`);
    writeFile(wsDir, "src/clamp_util.ts", lines.join("\n") + "\n");

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "task_pack", query: "integral clamp", path: "src/clamp_util.ts" },
    });

    const res = await srv.rpc(3, "tools/call", {
      name: "read_file",
      arguments: { mode: "small_file", path: "src/clamp_util.ts", content: "outline" },
    });
    const data = parseToolResult(res);
    expect(res.result.isError).toBeFalsy();
    expect(data["content_mode"]).toBe("outline");
    // "clampValue" surfaces in the outline entry itself ("1: function
    // clampValue") — the hit is visible there, so no note is warranted.
    expect(data["concern_note"]).toBeUndefined();
  }, 30000);

  it("slice-then-outline of the same file -> only one concern_note total", async () => {
    const wsDir = mkDir("f3-shared-dedupe");
    writeFile(wsDir, "src/gain_controller.ts", buildConcernFixture());

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "task_pack", query: "integral clamp", path: "src/gain_controller.ts" },
    });

    const sliceRes = await srv.rpc(3, "tools/call", {
      name: "read_file",
      arguments: { mode: "slice", path: "src/gain_controller.ts", range: "1-70" },
    });
    const sliceData = parseToolResult(sliceRes);
    // RESOLVED (2026-08-14, product fix): this slice legitimately collapses to
    // kind:"read.receipt" (code-unchanged) — the prior task_pack call's
    // evidence already covered the WHOLE 183-line file, so range 1-70 is fully
    // subsumed and the caller holds those bytes. The receipt is the right
    // member. What was wrong is that `KEPT_ON_RECEIPT` dropped `concern_note`,
    // which — unlike the deliberate `summary`/prose-`note` drops (those restate
    // the same residency fact) — discloses an UNRELATED one: a session-query
    // hit OUTSIDE the vouched window, produced by a guard that fires once per
    // (session, path). `concern_note` now rides receipts, so the note survives
    // the collapse exactly as the emitter intended ("a receipt replaces the
    // BYTES, never the guidance").
    expect(sliceData["kind"]).toBe("read.receipt");
    expect(typeof sliceData["concern_note"]).toBe("string");

    // The outline path shares the once-per-(session,file) dedupe with the
    // slice path — no second note for the same file.
    const outlineRes = await srv.rpc(4, "tools/call", {
      name: "read_file",
      arguments: { mode: "small_file", path: "src/gain_controller.ts", content: "outline" },
    });
    const outlineData = parseToolResult(outlineRes);
    expect(outlineRes.result.isError).toBeFalsy();
    expect(outlineData["concern_note"]).toBeUndefined();
  }, 30000);
});

// ---------------------------------------------------------------------------
// Feature 4 — idle-TTL session eviction (in-process, direct session.ts import)
// ---------------------------------------------------------------------------

describe("Feature 4 — idle-TTL session eviction", () => {
  beforeEach(() => {
    resetAll();
  });

  afterEach(() => {
    resetClockForTest();
    resetAll();
  });

  it("registry at or below the eviction threshold never evicts, however stale", () => {
    const base = 1_000_000;
    setClockForTest(() => base);
    for (let i = 1; i <= 8; i++) getSession(`/ws/small-${i}`);

    setClockForTest(() => base + 25 * 60 * 60 * 1000); // +25h, past the 24h TTL
    const others = otherActiveRoots("/ws/small-1");
    // All 8 minus itself — none evicted, since the registry never exceeded
    // the eviction threshold (8).
    expect(others.length).toBe(7);
  });

  it("above-threshold registry evicts idle (>24h) sessions, shrinking otherActiveRoots", () => {
    const base = 1_000_000;
    setClockForTest(() => base);
    for (let i = 1; i <= 9; i++) getSession(`/ws/big-${i}`);

    setClockForTest(() => base + 25 * 60 * 60 * 1000); // +25h
    const others = otherActiveRoots("/ws/big-1");
    // big-1 is the protected (actively-queried) root; the other 8 are idle
    // past the TTL with the registry over threshold -> all evicted.
    expect(others).toEqual([]);
  });

  it("above-threshold but NOT past the TTL yet -> nothing evicted", () => {
    const base = 1_000_000;
    setClockForTest(() => base);
    for (let i = 1; i <= 9; i++) getSession(`/ws/fresh-${i}`);

    setClockForTest(() => base + 60 * 60 * 1000); // +1h only
    const others = otherActiveRoots("/ws/fresh-1");
    expect(others.length).toBe(8);
  });

  it("the actively-fetched root survives eviction with its state intact", () => {
    const base = 1_000_000;
    setClockForTest(() => base);
    const active = getSession("/ws/active-root");
    recordReadMode("/ws/active-root", "full");
    for (let i = 1; i <= 8; i++) getSession(`/ws/filler-${i}`);

    setClockForTest(() => base + 25 * 60 * 60 * 1000); // +25h
    // Fetching the active root itself protects it from its OWN sweep call —
    // it is never evicted just because it happens to be idle too.
    const stillActive = getSession("/ws/active-root");
    expect(stillActive).toBe(active); // same object — state was not reset
    expect(stillActive.readsByMode.get("full")).toBe(1);

    // The filler roots are now gone.
    const others = otherActiveRoots("/ws/active-root");
    expect(others.length).toBe(0);
  });
});
