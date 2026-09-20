// seededGenerousPack.spec.ts — regression coverage for TL_SEEDED_GENEROUS
// (WP-S2, 2026-09-20).
//
// DEFECT UNDER TEST (measured 2026-09-20 on live GitHub Copilot sessions): a
// SEEDED pack — `read_file {query, targets:[{path},…]}`, i.e. the caller named
// the exact files — re-pointed any named file whose RAW size exceeded
// MAX_SURFACE_CODE_BYTES at ONE anchor-focus symbol. On an 18 KB service class
// that shipped the 15-line CONSTRUCTOR (the class and its constructor share the
// file's own type name, so the constructor inherited the type-name match) and
// certified the pack ready, while the SAME query with NO targets served the
// whole class. Naming the files made the pack strictly worse, and the recorded
// sessions then spent 2-4 turns zooming — at measured host pricing one extra
// model turn costs about as much as 9-14 KB of served source, so the zoom is
// the expensive half.
//
// The call shape under test is the exact regression shape: ONE `buildTaskPack`
// with a `query` plus caller-named `paths`, run in-process — this exercises the
// pack builder, not the transport, so no server is spawned.
//
// THE POLICY IS DEFAULT OFF (USER ruling 2026-09-20: the Claude Code paired
// bench must not move against v0.14.0). It is switched on per host by
// `tl workspace setup` through the TL_TURN_ECONOMY umbrella, or per policy by
// an explicit TL_SEEDED_GENEROUS value — so every case below that exercises
// the new serving shape opts in explicitly, and the stock (unset) environment
// is the byte-identical one.
//
// Every fixture is generated into `os.tmpdir()` by this file; no bench fixture,
// corpus, or session path is read. Each test gets its OWN workspace on purpose:
// the pack's cross-call body dedupe is keyed by workspace, so replaying the
// same call under the two flag values inside one process would otherwise get a
// body-withholding receipt for the second run rather than a second pack.

import { afterAll, afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { waitForExit } from "./helpers/rmDirWithRetry.js";

import {
  buildTaskPack,
  selectAnchorFocus,
  type TaskPackSurface,
} from "../features/task-pack/readCodeTaskPack.js";

const FLAG = "TL_SEEDED_GENEROUS";
const UMBRELLA = "TL_TURN_ECONOMY";

/** `count` distinct filler statements, tagged so two methods never share body vocabulary. */
function filler(tag: string, count: number): string {
  return Array.from({ length: count }, (_, i) => `    long ${tag}Step${i} = ${i} * 31L + ${i};`).join("\n");
}

/** A Javadoc block — raw bytes that the embed's own doc-comment elision removes. */
function javadoc(lines: number): string {
  return [
    "  /**",
    ...Array.from({ length: lines }, (_, i) => `   * Narrative line ${i}: this prose is elided before the body is embedded.`),
    "   */",
  ].join("\n");
}

function method(name: string, docLines: number, bodyLines: number): string {
  return `${javadoc(docLines)}\n  public Result ${name}(long id) {\n${filler(name, bodyLines)}\n    return null;\n  }\n`;
}

/** A two-word PascalCase class in a same-named file: the shape whose constructor shares the file's own type name. */
function classFile(className: string, methods: string[]): string {
  return [
    "package com.example.billing;",
    "",
    `public class ${className} {`,
    "  private final Repo repo;",
    "",
    `  public ${className}(Repo repo) {`,
    "    this.repo = repo;",
    "  }",
    "",
    methods.join("\n"),
    "}",
    "",
  ].join("\n");
}

/** RAW over the 12,288 per-surface cap, ELIDED far under it (the embed layer could always have shipped it whole). */
const DOC_HEAVY = classFile("DocHeavyStore", [method("cancel", 90, 6), method("refund", 90, 6)]);
/** ELIDED between the 12,288 generic allowance and the 24,576 answer one. */
const MID_SIZE = classFile("MidSizeLedger", [method("cancel", 4, 170), method("refund", 4, 170), method("charge", 4, 170)]);
/** ELIDED over the answer allowance, with a dozen separable, individually small methods. */
const HUGE = classFile(
  "HugeLedger",
  ["cancel", "refund", "charge", "archive", "reindex", "settle", "dispute", "rebill", "adjust", "verify", "restate", "purge"]
    .map((name) => method(name, 3, 55)),
);
const TINY = "package com.example.billing;\npublic class TinyId {\n  public int id() { return 1; }\n}\n";

const FILES: Readonly<Record<string, string>> = {
  "src/DocHeavyStore.java": DOC_HEAVY,
  "src/MidSizeLedger.java": MID_SIZE,
  "src/HugeLedger.java": HUGE,
  "src/TinyId.java": TINY,
};

const workspaces: string[] = [];

function makeWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tl-seeded-generous-"));
  workspaces.push(root);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  for (const [rel, content] of Object.entries(FILES)) {
    fs.writeFileSync(path.join(root, rel), content, "utf8");
  }
  return root;
}

afterEach(() => {
  delete process.env[FLAG];
  delete process.env[UMBRELLA];
  for (const root of workspaces.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** The surfaces this pack built from the CALLER's own named path, for `rel`, that actually carry a body. */
function namedSurfaces(result: { surfaces: TaskPackSurface[] }, rel: string): TaskPackSurface[] {
  return result.surfaces.filter((surface) =>
    surface.path === rel
    && surface.code !== undefined
    && surface.why?.includes("caller-supplied") === true
  );
}

function bytesOf(surface: TaskPackSurface): number {
  return Buffer.byteLength(surface.code ?? "", "utf8");
}

/** Line count with `countLines`' semantics: a trailing newline does not open a new line. */
function lineCount(text: string): number {
  const lines = text.split(/\r?\n/);
  return lines.length > 1 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
}

async function pack(
  workspace: string,
  query: string,
  paths: string[],
  taskProfile: "answer" | "generic",
): Promise<{ surfaces: TaskPackSurface[]; limit?: unknown }> {
  return await buildTaskPack({ query, paths, taskProfile } as never, workspace) as never;
}

// ---------------------------------------------------------------------------
// Opt-in wiring: default OFF everywhere, on per host through TL_TURN_ECONOMY.
// ---------------------------------------------------------------------------

describe("the TL_TURN_ECONOMY umbrella", () => {
  const query = "Explain how MidSizeLedger cancels, refunds and charges an order";
  // The same two-file seed the rule 2 cases use: naming >= 2 files is what
  // reaches the additive tier this fixture's ~20 KB body needs.
  const paths = ["src/MidSizeLedger.java", "src/TinyId.java"];

  it("stock environment (neither variable set): the named file keeps today's allowance", async () => {
    const served = namedSurfaces(await pack(makeWorkspace(), query, paths, "answer"), "src/MidSizeLedger.java");
    expect(served).toHaveLength(1);
    expect(bytesOf(served[0]!)).toBeLessThanOrEqual(12288);
    expect(served[0]!.range).not.toBe(`1-${lineCount(MID_SIZE)}`);
  });

  it("TL_TURN_ECONOMY=1 alone turns the policy on", async () => {
    process.env[UMBRELLA] = "1";
    const served = namedSurfaces(await pack(makeWorkspace(), query, paths, "answer"), "src/MidSizeLedger.java");
    expect(served).toHaveLength(1);
    expect(served[0]!.range).toBe(`1-${lineCount(MID_SIZE)}`);
  });

  it("TL_TURN_ECONOMY=1 with an explicit TL_SEEDED_GENEROUS=0 keeps it off — the member override wins", async () => {
    process.env[UMBRELLA] = "1";
    process.env[FLAG] = "0";
    const served = namedSurfaces(await pack(makeWorkspace(), query, paths, "answer"), "src/MidSizeLedger.java");
    expect(served).toHaveLength(1);
    expect(bytesOf(served[0]!)).toBeLessThanOrEqual(12288);
    expect(served[0]!.range).not.toBe(`1-${lineCount(MID_SIZE)}`);
  });
});

describe("TL_SEEDED_GENEROUS fixtures", () => {
  it("span the three size bands the rules switch on", () => {
    expect(Buffer.byteLength(DOC_HEAVY, "utf8")).toBeGreaterThan(12288);
    expect(Buffer.byteLength(MID_SIZE, "utf8")).toBeGreaterThan(12288);
    expect(Buffer.byteLength(HUGE, "utf8")).toBeGreaterThan(24576);
  });
});

// ---------------------------------------------------------------------------
// (a) Rule 1 — the whole-file fit decision runs on the EMBEDDED size.
// ---------------------------------------------------------------------------

describe("rule 1 — elided-size fit for a caller-named file", () => {
  const query = "Explain the DocHeavyStore cancel and refund methods";
  const paths = ["src/DocHeavyStore.java"];

  it("ON: a raw-oversize but elided-fitting named file is served whole, not re-pointed at a symbol", async () => {
    process.env[FLAG] = "1";
    const served = namedSurfaces(await pack(makeWorkspace(), query, paths, "generic"), "src/DocHeavyStore.java");
    expect(served).toHaveLength(1);
    expect(served[0]!.range).toBe(`1-${lineCount(DOC_HEAVY)}`);
    expect(served[0]!.symbol).toBeUndefined();
    expect(served[0]!.code).toContain("public Result cancel(long id)");
    expect(served[0]!.code).toContain("public Result refund(long id)");
    expect(served[0]!.remaining_ranges ?? []).toEqual([]);
  });

  it("OFF: the same call measures RAW bytes and never reaches the whole file (today's behaviour)", async () => {
    process.env[FLAG] = "0";
    const served = namedSurfaces(await pack(makeWorkspace(), query, paths, "generic"), "src/DocHeavyStore.java");
    expect(served).toHaveLength(1);
    // The measured defect in miniature: the window goes to the CONSTRUCTOR,
    // which shares the file's own type name, and neither described method is
    // served at all.
    expect(served[0]!.symbol).toBe("DocHeavyStore");
    expect(served[0]!.why).toMatch(/anchor-focus/);
    expect(served[0]!.code).not.toContain("public Result cancel(long id)");
    expect(served[0]!.code).not.toContain("public Result refund(long id)");
  });
});

// ---------------------------------------------------------------------------
// (b) Rule 2 — the answer allowance, with the generic profile left alone.
// ---------------------------------------------------------------------------

describe("rule 2 — 24 KB answer allowance, generic unchanged", () => {
  const query = "Explain how MidSizeLedger cancels, refunds and charges an order";
  const paths = ["src/MidSizeLedger.java", "src/TinyId.java"];

  it("ON + answer profile: a named file between the two allowances is served WHOLE with no remainder", async () => {
    process.env[FLAG] = "1";
    const served = namedSurfaces(await pack(makeWorkspace(), query, paths, "answer"), "src/MidSizeLedger.java");
    expect(served).toHaveLength(1);
    expect(served[0]!.range).toBe(`1-${lineCount(MID_SIZE)}`);
    expect(served[0]!.remaining_ranges ?? []).toEqual([]);
    expect(bytesOf(served[0]!)).toBeGreaterThan(12288);
    expect(bytesOf(served[0]!)).toBeLessThanOrEqual(24576);
    for (const name of ["cancel", "refund", "charge"]) {
      expect(served[0]!.code).toContain(`public Result ${name}(long id)`);
    }
  });

  it("ON + generic profile: the same file keeps today's 12,288 allowance", async () => {
    process.env[FLAG] = "1";
    const served = namedSurfaces(await pack(makeWorkspace(), query, paths, "generic"), "src/MidSizeLedger.java");
    expect(served).toHaveLength(1);
    expect(bytesOf(served[0]!)).toBeLessThanOrEqual(12288);
    expect(served[0]!.range).not.toBe(`1-${lineCount(MID_SIZE)}`);
  });

  it("OFF: the answer profile gets today's single capped surface", async () => {
    process.env[FLAG] = "0";
    const served = namedSurfaces(await pack(makeWorkspace(), query, paths, "answer"), "src/MidSizeLedger.java");
    expect(served).toHaveLength(1);
    expect(bytesOf(served[0]!)).toBeLessThanOrEqual(12288);
    expect(served[0]!.range).not.toBe(`1-${lineCount(MID_SIZE)}`);
  });

  it("a named file that ALREADY fitted is byte-identical with the flag on and with the stock (unset) environment", async () => {
    process.env[FLAG] = "1";
    const on = namedSurfaces(await pack(makeWorkspace(), query, paths, "answer"), "src/TinyId.java");
    delete process.env[FLAG];
    const off = namedSurfaces(await pack(makeWorkspace(), query, paths, "answer"), "src/TinyId.java");
    expect(on).toHaveLength(1);
    expect(on[0]!.code).toBe(off[0]!.code);
    expect(on[0]!.range).toBe(off[0]!.range);
  });
});

// ---------------------------------------------------------------------------
// (c) Rule 3 — multi-window, with an exact remainder partition.
// ---------------------------------------------------------------------------

describe("rule 3 — multi-window anchor focus with honest remainders", () => {
  const query = "Explain the HugeLedger cancellation, refund and charge handling";
  const paths = ["src/HugeLedger.java"];

  it("ON + answer profile: several distinct, non-overlapping windows within one file's budget", async () => {
    process.env[FLAG] = "1";
    const served = namedSurfaces(await pack(makeWorkspace(), query, paths, "answer"), "src/HugeLedger.java");
    expect(served.length).toBeGreaterThan(1);
    expect(served.length).toBeLessThanOrEqual(4);
    const spans = served.map((surface) => {
      const match = /^(\d+)-(\d+)$/.exec(surface.range)!;
      return { start: Number(match[1]), end: Number(match[2]) };
    });
    for (let i = 1; i < spans.length; i++) expect(spans[i]!.start).toBeGreaterThan(spans[i - 1]!.end);
    expect(new Set(served.map((surface) => surface.symbol)).size).toBe(served.length);
    expect(served.reduce((sum, surface) => sum + bytesOf(surface), 0)).toBeLessThanOrEqual(12288);
    expect(served.map((surface) => surface.symbol)).toContain("cancel");
  });

  it("ON: served windows plus remaining_ranges cover the file exactly once", async () => {
    process.env[FLAG] = "1";
    const served = namedSurfaces(await pack(makeWorkspace(), query, paths, "answer"), "src/HugeLedger.java");
    expect(served.length).toBeGreaterThan(1);
    const spans: Array<[number, number]> = [];
    for (const surface of served) {
      for (const range of [surface.range, ...(surface.remaining_ranges ?? [])]) {
        const match = /^(\d+)-(\d+)$/.exec(range);
        expect(match, `unexpected range shape ${range}`).not.toBeNull();
        spans.push([Number(match![1]), Number(match![2])]);
      }
    }
    spans.sort((a, b) => a[0] - b[0]);
    let cursor = 1;
    for (const [start, end] of spans) {
      expect(start, `gap or overlap at ${start}-${end}`).toBe(cursor);
      cursor = end + 1;
    }
    expect(cursor - 1).toBe(lineCount(HUGE));
  });

  it("OFF: the same call serves exactly one window for the file", async () => {
    process.env[FLAG] = "0";
    const served = namedSurfaces(await pack(makeWorkspace(), query, paths, "answer"), "src/HugeLedger.java");
    expect(served).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// (d) Rule 4 — a constructor must not inherit the enclosing type's name match,
//     and an inflected query word must reach the member that implements it.
// ---------------------------------------------------------------------------

describe("rule 4 — member ranking under the enclosing type's own name", () => {
  it("ON: an inflected query word ('cancellation') reaches the member named `cancel`", async () => {
    process.env[FLAG] = "1";
    const focus = await selectAnchorFocus(HUGE, "src/HugeLedger.java", "HugeLedger cancellation implementation");
    expect(focus).toBeDefined();
    expect(focus!.best.name).toBe("cancel");
  });

  it("OFF: the constructor still wins on the shared type-name match (today's behaviour)", async () => {
    process.env[FLAG] = "0";
    const focus = await selectAnchorFocus(HUGE, "src/HugeLedger.java", "HugeLedger cancellation implementation");
    expect(focus).toBeDefined();
    expect(focus!.best.name).toBe("HugeLedger");
    // The CONSTRUCTOR, not the class: a few lines, not the whole type.
    expect(focus!.best.range).toBe("6-8");
  });

  it("ON: the type spelled as WORDS (\"huge ledger cancellation\") ranks members the same way as the identifier form", async () => {
    // Replayed 2026-09-20 from a recorded call whose directory purpose read
    // "Order service cancellation": no symbol is an explicit identifier there,
    // so the exact form of the rule never fired and the constructor won on the
    // two words that merely located the file.
    process.env[FLAG] = "1";
    const focus = await selectAnchorFocus(HUGE, "src/HugeLedger.java", "huge ledger cancellation");
    expect(focus).toBeDefined();
    expect(focus!.best.name).toBe("cancel");
  });

  it("OFF: the words form keeps today's winner (the constructor)", async () => {
    process.env[FLAG] = "0";
    const focus = await selectAnchorFocus(HUGE, "src/HugeLedger.java", "huge ledger cancellation");
    expect(focus).toBeDefined();
    expect(focus!.best.name).toBe("HugeLedger");
    expect(focus!.best.range).toBe("6-8");
  });

  it("ON: words that do NOT cover the whole type name leave the ordinary ranking alone", async () => {
    process.env[FLAG] = "1";
    const partial = await selectAnchorFocus(HUGE, "src/HugeLedger.java", "ledger settle");
    expect(partial).toBeDefined();
    expect(partial!.best.name).toBe("settle");
  });

  it("ON: the tolerance is whole-word inflection, never a prefix substring test", async () => {
    process.env[FLAG] = "1";
    const inflected = await selectAnchorFocus(HUGE, "src/HugeLedger.java", "HugeLedger charges implementation");
    expect(inflected!.best.name).toBe("charge");
    // "char" is a literal PREFIX of "charge" but not an inflection of it —
    // the exact false-positive class salientWordMatch.ts exists to prevent.
    const prefixOnly = await selectAnchorFocus(HUGE, "src/HugeLedger.java", "HugeLedger char implementation");
    expect(prefixOnly!.best.name).not.toBe("charge");
  });
});

// ---------------------------------------------------------------------------
// (e) The reproduction's own acceptance bar, on generated fixtures.
// ---------------------------------------------------------------------------

describe("a seeded four-file answer pack", () => {
  it("ON: every named file is served, with no response-level truncation", async () => {
    process.env[FLAG] = "1";
    const paths = ["src/TinyId.java", "src/MidSizeLedger.java", "src/DocHeavyStore.java", "src/HugeLedger.java"];
    const result = await pack(
      makeWorkspace(),
      "Explain the cancellation flow: MidSizeLedger cancel, DocHeavyStore refund, HugeLedger cancellation and the TinyId id",
      paths,
      "answer",
    );
    for (const rel of paths) expect(namedSurfaces(result, rel).length, rel).toBeGreaterThan(0);
    expect(result.limit).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The 48 KB tier for four or more caller-named files.
//
// Measured on a recorded Copilot call (query + 8 named files, ~44 KB embedded):
// the 32 KB multi-concern tier forced a second call for the remainders, and a
// second model turn costs about as much as 9-14 KB of served source. With four
// or more named files the generous pack may claim 48 KB instead, so the request
// stays one call — still bounded, still under a client ceiling or a caller
// `budget.bytes` when either is lower.
// ---------------------------------------------------------------------------

describe("a seeded answer pack naming four or more files", () => {
  const EXTRA = {
    "src/AlphaShipping.java": classFile("AlphaShipping", [method("dispatch", 2, 170)]),
    "src/BetaInvoicing.java": classFile("BetaInvoicing", [method("invoice", 2, 170)]),
    "src/GammaReturns.java": classFile("GammaReturns", [method("restock", 2, 170)]),
  };
  const QUERY = "Explain MidSizeLedger cancel and refund, AlphaShipping dispatch, BetaInvoicing invoice and GammaReturns restock";

  function workspaceWithExtras(): string {
    const root = makeWorkspace();
    for (const [rel, content] of Object.entries(EXTRA)) fs.writeFileSync(path.join(root, rel), content, "utf8");
    return root;
  }

  it("fixture: the four bodies total more than the 32 KB tier can carry and less than the 48 KB one", () => {
    const total = Buffer.byteLength(MID_SIZE, "utf8")
      + Object.values(EXTRA).reduce((sum, text) => sum + Buffer.byteLength(text, "utf8"), 0);
    expect(total).toBeGreaterThan(32 * 1024 - 4096);
    expect(total).toBeLessThan(48 * 1024 - 4096);
  });

  it("ON: all four named files are served whole in one pack, with no truncation", async () => {
    process.env[FLAG] = "1";
    const paths = ["src/MidSizeLedger.java", ...Object.keys(EXTRA)];
    const result = await pack(workspaceWithExtras(), QUERY, paths, "answer");
    expect(result.limit).toBeUndefined();
    for (const rel of paths) {
      const surfaces = namedSurfaces(result, rel);
      expect(surfaces.length, rel).toBe(1);
      const source = rel === "src/MidSizeLedger.java" ? MID_SIZE : EXTRA[rel as keyof typeof EXTRA];
      expect(surfaces[0]!.range, rel).toBe(`1-${lineCount(source)}`);
      expect(surfaces[0]!.remaining_ranges ?? [], rel).toEqual([]);
    }
  });

  it("OFF: the same call leaves the mid-size file partial (today's behaviour)", async () => {
    const paths = ["src/MidSizeLedger.java", ...Object.keys(EXTRA)];
    const result = await pack(workspaceWithExtras(), QUERY, paths, "answer");
    const mid = namedSurfaces(result, "src/MidSizeLedger.java");
    const servedWhole = mid.length === 1
      && mid[0]!.range === `1-${lineCount(MID_SIZE)}`
      && (mid[0]!.remaining_ranges ?? []).length === 0;
    expect(servedWhole).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The DEFAULT's own WIRE shape.
//
// The policy is default OFF, so every committed wire pin keeps measuring the
// stock shape. This is the opted-in counterpart — a real spawned server given
// TL_SEEDED_GENEROUS=1, a real `read_file` over stdio, measuring the bytes the
// caller is actually charged for.
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

/** Spawned-stdio harness, trimmed from rangedBatchNextPreservation.spec.ts. */
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
        clientInfo: { name: "vitest-seeded-generous", version: "0" },
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

describe("the default's wire shape (spawned server)", () => {
  it("serves every caller-named file in one bounded response, with the described member in it", async () => {
    const root = makeWorkspace();
    const server = startServer(root, { TL_SEEDED_GENEROUS: "1" });
    spawnedServers.push(server);
    await server.initialize();
    const { body, bytes } = await server.call("read_file", {
      cwd: root,
      query: "Explain the cancellation flow: MidSizeLedger cancel, DocHeavyStore refund, HugeLedger cancellation and the TinyId id",
      targets: [
        { path: "src/TinyId.java" },
        { path: "src/MidSizeLedger.java" },
        { path: "src/DocHeavyStore.java" },
        { path: "src/HugeLedger.java" },
      ],
      task: { epoch: "new", profile: "answer" },
    });

    expect(body["kind"]).toBe("read.task_pack");
    const evidence = (body["evidence"] ?? []) as Array<Record<string, unknown>>;
    const served = new Set(evidence.map((row) => String(row["path"])));
    for (const rel of ["src/TinyId.java", "src/MidSizeLedger.java", "src/DocHeavyStore.java", "src/HugeLedger.java"]) {
      expect(served, `${rel} must be served`).toContain(rel);
    }
    const allBodies = evidence.map((row) => String(row["body"] ?? "")).join("\n");
    expect(allBodies).toContain("public Result cancel(long id)");
    expect(body["limit"]).toBeUndefined();
    // One bounded response, not a pack that has to be paged: within the
    // additive 32 KB tier this flag claims for a >= 2-named-file answer pack,
    // and nothing over it (these fixtures are deliberately fatter than the
    // measured reproduction, whose four real files land near 20 KB).
    expect(bytes).toBeLessThanOrEqual(32 * 1024);
  }, 60000);
});
