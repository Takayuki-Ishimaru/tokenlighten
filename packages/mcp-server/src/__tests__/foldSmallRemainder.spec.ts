// foldSmallRemainder.spec.ts — regression coverage for TL_FOLD_SMALL_REMAINDER
// (WP-S7, 2026-09-20).
//
// DEFECT UNDER TEST (measured 2026-09-20, live GitHub Copilot session, the
// turn-economy umbrella on): an answer pack served a class from its
// declaration line and listed the file's own head as `remaining` —
// `OrderService.java:27-420 remaining:["1-26"]`, `PaymentService.java:15-123
// remaining:["2-14"]`, `OrderStatus.java:3-36 remaining:["2-2"]` — a package
// line, imports, a blank line. The model then issued a WHOLE extra turn
// (`read_file {targets:[{handle,range:"1-14"}]}`) to fetch the 14 import
// lines nobody needed withheld; one extra turn prices at roughly 9-14 KB of
// served bytes on every host measured, so withholding ~400 bytes cost far
// more than it saved, and the standing `remaining` entry is itself a standing
// invitation to zoom.
//
// THE POLICY IS DEFAULT OFF (USER ruling 2026-09-20: the Claude Code paired
// bench must not move against v0.14.0). It is switched on per host by
// `tl workspace setup` through the TL_TURN_ECONOMY umbrella, or per policy by
// an explicit TL_FOLD_SMALL_REMAINDER value.
//
// Three layers of coverage:
//   (1) end-to-end, via `buildTaskPack` on a real answer-profile query — the
//       exact regression shape, run in-process (no server spawned);
//   (2) direct unit coverage of `applyFoldSmallRemainder` against hand-built
//       TaskPackResult values, for the structural exclusions (multi-window,
//       semantic-frontier withholding, caller-explicit ranges, the pack's own
//       byte budget) that are impractical to force through the ranking
//       heuristics a real query goes through;
//   (3) one spawned-server round trip proving the acceptance bar this feature
//       exists for: a LATER ranged read of the folded head returns the
//       already-served receipt instead of re-serving those bytes.
//
// Every fixture is generated into `os.tmpdir()` by this file; no bench
// fixture, corpus, or session path is read. Each `buildTaskPack` case gets
// its OWN workspace on purpose — see seededGenerousPack.spec.ts's header for
// why (the pack's cross-call body dedupe is keyed by workspace).

import { afterAll, afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { waitForExit } from "./helpers/rmDirWithRetry.js";

import {
  applyFoldSmallRemainder,
  buildTaskPack,
  type TaskPackResult,
  type TaskPackSurface,
} from "../features/task-pack/readCodeTaskPack.js";
import {
  markCallerRangeSurface,
  markSemanticFrontierWithheldBody,
} from "../features/task-pack/sfWithholdingMarks.js";

const FLAG = "TL_FOLD_SMALL_REMAINDER";
const UMBRELLA = "TL_TURN_ECONOMY";

// ---------------------------------------------------------------------------
// Fixtures — a small head (package/import-shaped lines) followed by a class
// body, so an answer-profile symbol-focus query matches the class and leaves
// the head as the file-boundary remainder this feature folds.
// ---------------------------------------------------------------------------

function importLines(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `import { Dep${i} } from "./dep${i}.js";`);
}

function classBody(name: string, bodyLines: number): string[] {
  const lines = [`export class ${name} {`, "  run(): number {"];
  for (let i = 0; i < bodyLines; i++) lines.push(`    console.log(${i});`);
  lines.push("    return 0;", "  }", "}");
  return lines;
}

const REL = "src/OrderService.ts";
const CLASS_NAME = "OrderService";

const workspaces: string[] = [];

/** A fresh workspace with `REL` built from `head` + a fixed `CLASS_NAME` class body. */
function makeWorkspace(head: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tl-fold-remainder-"));
  workspaces.push(root);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  const text = [...head, ...classBody(CLASS_NAME, 30)].join("\n") + "\n";
  fs.writeFileSync(path.join(root, REL), text, "utf8");
  return root;
}

function totalLines(root: string, rel: string): number {
  const text = fs.readFileSync(path.join(root, rel), "utf8");
  const lines = text.split("\n");
  return lines.length > 1 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
}

afterEach(() => {
  delete process.env[FLAG];
  delete process.env[UMBRELLA];
  for (const root of workspaces.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function pack(
  workspace: string,
  query: string,
  extra?: Record<string, unknown>,
): Promise<{ surfaces: TaskPackSurface[] }> {
  return await buildTaskPack({ query, taskProfile: "answer", ...extra } as never, workspace) as never;
}

function orderServiceSurface(result: { surfaces: TaskPackSurface[] }): TaskPackSurface | undefined {
  return result.surfaces.find((surface) => surface.path === REL && surface.code !== undefined);
}

// ---------------------------------------------------------------------------
// (1) End-to-end: a real answer-profile symbol-focus query, run through
//     buildTaskPack — the exact regression shape.
// ---------------------------------------------------------------------------

describe("end-to-end: answer-profile symbol focus over buildTaskPack", () => {
  const QUERY = `Explain what ${CLASS_NAME} does`;

  it("flag unset: today's behaviour — the small head stays a remaining span", async () => {
    const root = makeWorkspace(importLines(10));
    const surface = orderServiceSurface(await pack(root, QUERY));
    expect(surface).toBeDefined();
    expect(surface!.range).not.toBe(`1-${totalLines(root, REL)}`);
    expect(surface!.remaining_ranges).toEqual(["1-10"]);
    expect(surface!.symbol).toBe(CLASS_NAME);
  });

  it("TL_FOLD_SMALL_REMAINDER=1: a small head remainder (<=40 lines, <=2048B) folds into the whole file", async () => {
    process.env[FLAG] = "1";
    const root = makeWorkspace(importLines(10));
    const surface = orderServiceSurface(await pack(root, QUERY));
    expect(surface).toBeDefined();
    expect(surface!.range).toBe(`1-${totalLines(root, REL)}`);
    expect(surface!.remaining_ranges).toBeUndefined();
    expect(surface!.content_completeness).toBeUndefined();
    expect(surface!.code).toContain("import { Dep0 }");
    expect(surface!.code).toContain(`export class ${CLASS_NAME}`);
  });

  it("TL_TURN_ECONOMY=1 alone turns the policy on", async () => {
    process.env[UMBRELLA] = "1";
    const root = makeWorkspace(importLines(10));
    const surface = orderServiceSurface(await pack(root, QUERY));
    expect(surface!.range).toBe(`1-${totalLines(root, REL)}`);
    expect(surface!.remaining_ranges).toBeUndefined();
  });

  it("TL_TURN_ECONOMY=1 with an explicit TL_FOLD_SMALL_REMAINDER=0 keeps it off — the member override wins", async () => {
    process.env[UMBRELLA] = "1";
    process.env[FLAG] = "0";
    const root = makeWorkspace(importLines(10));
    const surface = orderServiceSurface(await pack(root, QUERY));
    expect(surface!.range).not.toBe(`1-${totalLines(root, REL)}`);
    expect(surface!.remaining_ranges).toEqual(["1-10"]);
  });

  it("a 41-line head remainder is NOT folded (one line over the cap), even though it is well under 2,048 bytes", async () => {
    process.env[FLAG] = "1";
    const root = makeWorkspace(importLines(41));
    const surface = orderServiceSurface(await pack(root, QUERY));
    expect(surface).toBeDefined();
    expect(surface!.range).not.toBe(`1-${totalLines(root, REL)}`);
    expect(surface!.remaining_ranges).toEqual(["1-41"]);
  });

  it("a head remainder over 2,048 elided bytes is NOT folded, even with very few lines", async () => {
    process.env[FLAG] = "1";
    // Two lines, but the first alone is well over the 2,048B cap.
    const bigComment = `// ${"x".repeat(2200)}`;
    const root = makeWorkspace([bigComment, "import { A } from \"./a.js\";"]);
    const surface = orderServiceSurface(await pack(root, QUERY));
    expect(surface).toBeDefined();
    expect(surface!.range).not.toBe(`1-${totalLines(root, REL)}`);
    expect(surface!.remaining_ranges).toEqual(["1-2"]);
  });

  it("a caller-explicit range is never widened, even when it leaves a small head unaddressed", async () => {
    process.env[FLAG] = "1";
    const root = makeWorkspace(importLines(10));
    const requestedRange = `11-${totalLines(root, REL) - 1}`;
    const result = await pack(root, QUERY, { paths: [{ path: REL, range: requestedRange }] });
    const surface = orderServiceSurface(result);
    expect(surface).toBeDefined();
    expect(surface!.range).toBe(requestedRange);
  });
});

// ---------------------------------------------------------------------------
// (2) Direct unit coverage of applyFoldSmallRemainder — structural exclusions
//     that are impractical to force through the real ranking heuristics.
// ---------------------------------------------------------------------------

function mkSurface(
  handle: string,
  relPath: string,
  range: string,
  code: string,
  remainingRanges?: string[],
): TaskPackSurface {
  return {
    role: "domain",
    handle,
    path: relPath,
    range,
    code,
    ...(remainingRanges !== undefined ? { remaining_ranges: remainingRanges } : {}),
  };
}

function mkResult(surfaces: TaskPackSurface[]): TaskPackResult {
  return { mode: "task_pack", coverage: "complete", surfaces, missing: [] };
}

/** A tiny real file: a 1-line head + a 3-line body, foldable by every rule. */
function writeTinyFile(root: string, rel: string): void {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(
    path.join(root, rel),
    ["import { A } from \"./a.js\";", "export class Foo {", "  run() { return 1; }", "}"].join("\n") + "\n",
    "utf8",
  );
}

function unitWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tl-fold-remainder-unit-"));
  workspaces.push(root);
  return root;
}

describe("applyFoldSmallRemainder — direct unit coverage", () => {
  it("folds a small remainder in place: widens the range, drops remaining_ranges, mints a fresh handle", () => {
    process.env[FLAG] = "1";
    const root = unitWorkspace();
    writeTinyFile(root, "src/Foo.ts");
    const surface = mkSurface("hOLD", "src/Foo.ts", "2-4", "PLACEHOLDER", ["1-1"]);
    const result = mkResult([surface]);

    applyFoldSmallRemainder(root, result, undefined);

    expect(surface.range).toBe("1-4");
    expect(surface.remaining_ranges).toBeUndefined();
    expect(surface.handle).not.toBe("hOLD");
    expect(surface.code).toContain("import { A }");
    expect(surface.code).toContain("export class Foo");
  });

  it("is a no-op with the flag off", () => {
    delete process.env[FLAG];
    delete process.env[UMBRELLA];
    const root = unitWorkspace();
    writeTinyFile(root, "src/Foo.ts");
    const surface = mkSurface("hOLD", "src/Foo.ts", "2-4", "PLACEHOLDER", ["1-1"]);
    const result = mkResult([surface]);
    const before = JSON.stringify(result);

    applyFoldSmallRemainder(root, result, undefined);

    expect(JSON.stringify(result)).toBe(before);
  });

  it("does not fold when a second surface also names the same path (multi-window file)", () => {
    process.env[FLAG] = "1";
    const root = unitWorkspace();
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "src/Multi.ts"),
      ["import { A } from \"./a.js\";", "export class Foo {", "  run() { return 1; }", "}",
        "export class Bar {", "  go() { return 2; }", "}"].join("\n") + "\n",
      "utf8",
    );
    const first = mkSurface("hM1", "src/Multi.ts", "2-4", "FOO", ["1-1"]);
    const second = mkSurface("hM2", "src/Multi.ts", "5-7", "BAR");
    const result = mkResult([first, second]);

    applyFoldSmallRemainder(root, result, undefined);

    expect(first.range).toBe("2-4");
    expect(first.remaining_ranges).toEqual(["1-1"]);
    expect(first.handle).toBe("hM1");
  });

  it("does not fold a surface the semantic frontier already withheld a body from", () => {
    process.env[FLAG] = "1";
    const root = unitWorkspace();
    writeTinyFile(root, "src/Foo.ts");
    const surface = mkSurface("hW1", "src/Foo.ts", "2-4", "PLACEHOLDER", ["1-1"]);
    markSemanticFrontierWithheldBody(surface);
    const result = mkResult([surface]);

    applyFoldSmallRemainder(root, result, undefined);

    expect(surface.range).toBe("2-4");
    expect(surface.remaining_ranges).toEqual(["1-1"]);
    expect(surface.handle).toBe("hW1");
  });

  it("does not fold a surface marked as a caller-explicit range", () => {
    process.env[FLAG] = "1";
    const root = unitWorkspace();
    writeTinyFile(root, "src/Foo.ts");
    const surface = mkSurface("hC1", "src/Foo.ts", "2-4", "PLACEHOLDER", ["1-1"]);
    markCallerRangeSurface(surface);
    const result = mkResult([surface]);

    applyFoldSmallRemainder(root, result, undefined);

    expect(surface.range).toBe("2-4");
    expect(surface.remaining_ranges).toEqual(["1-1"]);
    expect(surface.handle).toBe("hC1");
  });

  it("does not fold a Markdown surface — Markdown keeps its own unconditional whole-file promotion", () => {
    process.env[FLAG] = "1";
    const root = unitWorkspace();
    fs.mkdirSync(path.join(root, "docs"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "docs/spec.md"),
      ["# intro", "", "## Section", "body text here"].join("\n") + "\n",
      "utf8",
    );
    const surface = mkSurface("hD1", "docs/spec.md", "3-4", "## Section\nbody text here", ["1-2"]);
    const result = mkResult([surface]);

    applyFoldSmallRemainder(root, result, undefined);

    expect(surface.range).toBe("3-4");
    expect(surface.remaining_ranges).toEqual(["1-2"]);
    expect(surface.handle).toBe("hD1");
  });

  it("a remainder of 41 lines is not folded, even though its own elided bytes are well under 2,048", () => {
    process.env[FLAG] = "1";
    const root = unitWorkspace();
    const head = importLines(41);
    const body = classBody("Foo", 3);
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src/Big.ts"), [...head, ...body].join("\n") + "\n", "utf8");
    const surface = mkSurface("hL1", "src/Big.ts", `${head.length + 1}-${head.length + body.length}`, "PLACEHOLDER", [`1-${head.length}`]);
    const result = mkResult([surface]);

    applyFoldSmallRemainder(root, result, undefined);

    expect(surface.remaining_ranges).toEqual([`1-${head.length}`]);
  });

  it("leaves the surface exactly as it was when the widened pack would exceed its own byte budget", () => {
    process.env[FLAG] = "1";
    const root = unitWorkspace();
    writeTinyFile(root, "src/Foo.ts");
    const surface = mkSurface("hB1", "src/Foo.ts", "2-4", "PLACEHOLDER", ["1-1"]);
    const result = mkResult([surface]);
    // Comfortably over every rawCapForResult tier, so the widened pack cannot
    // possibly fit — the fold must be undone, not shipped over cap.
    (result as unknown as { verify: string[] }).verify = ["z".repeat(60 * 1024)];

    applyFoldSmallRemainder(root, result, undefined);

    expect(surface.range).toBe("2-4");
    expect(surface.remaining_ranges).toEqual(["1-1"]);
    expect(surface.code).toBe("PLACEHOLDER");
    expect(surface.handle).toBe("hB1");
  });
});

// ---------------------------------------------------------------------------
// (3) The acceptance bar: a LATER ranged read of the folded head returns the
//     already-served receipt (spawned server — a real read_file round trip).
// ---------------------------------------------------------------------------

const nodeRequire = createRequire(import.meta.url);
const TSX_CLI = nodeRequire.resolve("tsx/cli");
const BIN_TS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin.ts");

interface ServerHandle {
  initialize(): Promise<void>;
  call(name: string, args: Record<string, unknown>): Promise<{ body: Record<string, unknown>; bytes: number }>;
  kill(): Promise<void>;
}

const spawnedServers: ServerHandle[] = [];

/** Spawned-stdio harness, trimmed from seededGenerousPack.spec.ts / rangedBatchNextPreservation.spec.ts. */
function startServer(cwd: string, env: Record<string, string>): ServerHandle {
  const child: ChildProcess = spawn(process.execPath, [TSX_CLI, BIN_TS, cwd], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  let stdoutBuf = "";
  let stderr = "";
  const waiters = new Map<number, (msg: Record<string, unknown>) => void>();
  child.stdout!.on("data", (d: Buffer) => {
    stdoutBuf += d.toString();
    let nl: number;
    while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
      const line = stdoutBuf.slice(0, nl);
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const id = msg["id"];
      if (typeof id === "number" && waiters.has(id)) {
        const waiter = waiters.get(id)!;
        waiters.delete(id);
        waiter(msg);
      }
    }
  });
  child.stderr!.on("data", (d: Buffer) => { stderr += d.toString(); });

  let nextId = 1;
  function rpc(method: string, params?: unknown, timeoutMs = 30000): Promise<Record<string, unknown>> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(new Error(`rpc '${method}' timed out\n--- stderr ---\n${stderr}`));
      }, timeoutMs);
      waiters.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  return {
    async initialize() {
      await rpc("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "vitest-fold-small-remainder", version: "0" },
      });
      child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    },
    async call(name, args) {
      const res = await rpc("tools/call", { name, arguments: args }) as
        { result?: { content?: Array<{ text?: string }> } };
      const text = res.result?.content?.[0]?.text;
      expect(typeof text, `tool ${name} returned no text: ${JSON.stringify(res).slice(0, 400)}`).toBe("string");
      return { body: JSON.parse(text!) as Record<string, unknown>, bytes: Buffer.byteLength(text!, "utf8") };
    },
    async kill() {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      await waitForExit(child);
    },
  };
}

afterAll(async () => {
  for (const server of spawnedServers.splice(0)) await server.kill();
});

describe("spawned server: the folded head is already served for a later ranged read", () => {
  it("a task-pack query folds the head, and a follow-up read_file over that head returns a code-unchanged receipt", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tl-fold-remainder-server-"));
    workspaces.push(root);
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    const head = importLines(10);
    const text = [...head, ...classBody(CLASS_NAME, 20)].join("\n") + "\n";
    fs.writeFileSync(path.join(root, REL), text, "utf8");
    const fileTotalLines = totalLines(root, REL);

    const server = startServer(root, { TL_FOLD_SMALL_REMAINDER: "1" });
    spawnedServers.push(server);
    await server.initialize();

    const first = await server.call("read_file", {
      cwd: root,
      query: `Explain what ${CLASS_NAME} does`,
      task: { epoch: "new", profile: "answer" },
    });
    expect(first.body["kind"]).toBe("read.task_pack");
    const evidence = (first.body["evidence"] ?? []) as Array<Record<string, unknown>>;
    const row = evidence.find((entry) => entry["path"] === REL);
    expect(row, "OrderService.ts must be served whole").toBeDefined();
    expect(row!["range"]).toBe(`1-${fileTotalLines}`);
    expect(row!["remaining"]).toBeUndefined();
    const handle = row!["handle"] as string;
    expect(typeof handle).toBe("string");

    const second = await server.call("read_file", {
      cwd: root,
      targets: [{ handle, range: "1-10" }],
    });
    expect(second.body["kind"]).toBe("read.receipt");
    const receipt = second.body["receipt"] as Record<string, unknown>;
    expect(receipt["receipt"]).toBe("code-unchanged");
    expect(typeof receipt["handle"]).toBe("string");
    // "task_pack 1-<n> (call #1)": the ledger's own record of what put these
    // exact bytes on the wire -- the task-pack call this test just made.
    expect(String(receipt["served_by"])).toContain("task_pack");
  }, 60000);
});
