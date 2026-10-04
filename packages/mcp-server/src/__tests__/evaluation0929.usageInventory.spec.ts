/**
 * evaluation0929.usageInventory.spec.ts — V15-FUI (2026-09-29),
 * `TL_USAGE_INVENTORY`, default OFF. See features/task-pack/
 * usageInventory.ts's module doc comment for the mechanism and its
 * rationale (measure-v015/REPORT.md's FUI section).
 *
 * Pinned here: the inventory matches `scanLiteral` (the same scanner
 * `tl_search_files find` uses) EXACTLY for a given symbol, declared-symbol
 * selection (exported/top-level first, deduped, capped at 8), per-symbol
 * caps with honest `inventory_complete`, the flag's default-OFF inertness,
 * and the end-to-end wire shape under a real server.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import { startDevServer, type ServerHandle } from "./helpers/qualityFirstScenarios.js";
import { computeUsageInventory } from "../features/task-pack/usageInventory.js";
import { scanLiteral, escapeRegExp } from "../features/search/find/findText.js";
import { usageInventoryEnabled } from "../util/flags.js";
import type { TaskPackResult, TaskPackSurface } from "../features/task-pack/model.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();
const tmpDirs: string[] = [];
const servers: ServerHandle[] = [];

afterEach(async () => {
  delete process.env["TL_USAGE_INVENTORY"];
  for (const server of servers.splice(0)) await server.kill();
});
afterAll(async () => {
  for (const dir of tmpDirs.splice(0)) {
    try {
      await rmDirWithRetry(dir);
    } catch {
      /* best-effort cleanup */
    }
  }
});

function makeWorkspace(tag: string, files: Readonly<Record<string, string>>): string {
  const ws = fs.realpathSync(shortTmpDir(HOME, `.tl-e0929-fui-${tag}-`));
  tmpDirs.push(ws);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(ws, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
  return ws;
}

function surface(p: string, code: string, over: Partial<TaskPackSurface> = {}): TaskPackSurface {
  const lines = code.split(/\r?\n/).length;
  return { role: "domain", handle: `h-${p}`, path: p, range: `1-${lines}`, code, ...over };
}

function fakeResult(surfaces: TaskPackSurface[]): TaskPackResult {
  return { mode: "task_pack", coverage: "partial", surfaces, missing: [] };
}

// `\b`, not a lookaround — scanLiteral's isSafeRegexQuery admission gate
// rejects lookarounds (see usageInventory.ts's wordBoundedPattern doc).
function wordBounded(symbol: string): string {
  return `\\b${escapeRegExp(symbol)}\\b`;
}

// ---------------------------------------------------------------------------
// Match fidelity: the inventory's own scan must equal a direct scanLiteral
// call with the same word-bounded pattern, for the same symbol.
// ---------------------------------------------------------------------------

describe("computeUsageInventory — matches the same scanner tl_search_files find uses", () => {
  it("an exported TS function's inventory equals a direct scanLiteral call", () => {
    const decl = "export function computeShippingFee(weight: number): number {\n  return weight * 2;\n}\n";
    const caller1 = "import { computeShippingFee } from './fees.js';\nconst a = computeShippingFee(3);\n";
    const caller2 = "import { computeShippingFee } from './fees.js';\nfunction quote() {\n  return computeShippingFee(9);\n}\n";
    const ws = makeWorkspace("fidelity", {
      "src/fees.ts": decl,
      "src/orderA.ts": caller1,
      "src/orderB.ts": caller2,
    });
    const result = fakeResult([surface("src/fees.ts", decl)]);
    const rows = computeUsageInventory(result, ws);
    const entry = rows.find((r) => r.symbol === "computeShippingFee");
    expect(entry).toBeDefined();

    const direct = scanLiteral(wordBounded("computeShippingFee"), ws, { regex: true, respectGitignore: true });
    const byFile = new Map<string, number[]>();
    for (const m of direct) byFile.set(m.path, [...(byFile.get(m.path) ?? []), m.line]);

    expect(entry!.total).toBe(direct.length);
    for (const f of entry!.files) {
      expect(byFile.get(f.path)).toEqual(f.lines);
    }
    expect(entry!.inventory_complete).toBe(true);
  });

  it("word-bounded: a symbol name never matches as a substring of a longer identifier", () => {
    // v0.15.0 (WP-RK): was `run`/`runAll` — `run` is on the generic stoplist now (never inventoried on its own).
    const decl = "export function settle(): void {}\n";
    const decoy = "export function settleAll(): void { settle(); }\n"; // 'settle(' inside 'settleAll' must not count as 'settle'
    const ws = makeWorkspace("wordbound", { "src/lib.ts": decl, "src/all.ts": decoy });
    const result = fakeResult([surface("src/lib.ts", decl)]);
    const rows = computeUsageInventory(result, ws);
    const entry = rows.find((r) => r.symbol === "settle")!;
    const allLines = entry.files.find((f) => f.path === "src/all.ts")?.lines ?? [];
    // 'settle()' appears once on line 1 of all.ts (the call), 'settleAll' must not add a second hit.
    expect(allLines).toEqual([1]);
  });
});

describe("computeUsageInventory — declared-symbol selection", () => {
  it("exported/top-level first, deduped, capped at 8", () => {
    // v0.15.0 final round (WP-RK, F4): the cap is 8 symbols (was 6), so the fixture gained two more exported names —
    // ten declared symbols, of which the cap must drop the last exported one and the non-exported helper.
    const decl = [
      "function helperOne() { return 1; }", // top-level, not exported
      "export function pubOne() { return helperOne(); }",
      "export function pubTwo() { return 2; }",
      "export function pubThree() { return 3; }",
      "export function pubFour() { return 4; }",
      "export function pubFive() { return 5; }",
      "export function pubSix() { return 6; }",
      "export function pubSeven() { return 7; }",
      "export function pubEight() { return 8; }",
      "export function pubNine() { return 9; }", // 9th exported symbol — must be dropped by the cap
    ].join("\n") + "\n";
    // v0.15.0 (WP-RK): a symbol whose every match lies inside the served slice adds nothing and is dropped, so
    // this fixture gained a consumer file that references all the names outside the slice — otherwise the
    // assertions below held vacuously (an empty inventory).
    const consumer = "helperOne(); pubOne(); pubTwo(); pubThree(); pubFour(); pubFive(); pubSix(); pubSeven(); pubEight(); pubNine();\n";
    const ws = makeWorkspace("select", { "src/many.ts": decl, "src/use.ts": consumer });
    const result = fakeResult([surface("src/many.ts", decl)]);
    const rows = computeUsageInventory(result, ws);
    expect(rows.length).toBeLessThanOrEqual(8);
    const symbols = rows.map((r) => r.symbol);
    // Every returned symbol resolves to >=1 match (its own declaration line),
    // so all 8 kept slots are exported names — 'helperOne' should not have
    // displaced any of the nine exported ones ahead of the cap.
    expect(symbols).not.toContain("helperOne");
    expect(symbols).not.toContain("pubNine");
    expect(symbols).toEqual(["pubOne", "pubTwo", "pubThree", "pubFour", "pubFive", "pubSix", "pubSeven", "pubEight"]);
  });

  it("no declared symbol resolvable: attaches nothing", () => {
    const decl = "export const x = 1;\n"; // 'const' is not one of the declaration shapes this scanner matches
    const ws = makeWorkspace("none", { "src/only.ts": decl });
    const result = fakeResult([surface("src/only.ts", decl)]);
    const rows = computeUsageInventory(result, ws);
    expect(rows).toEqual([]);
  });
});

describe("computeUsageInventory — per-symbol caps and honest inventory_complete", () => {
  it("truncates lines per file at 3 and marks inventory_complete:false", () => {
    // v0.15.0 refinement R1 — old: "at 8" (the cap is 3 lines per file, 4 files per symbol now)
    const decl = "export function tick(): void {}\n";
    const manyLines = Array.from({ length: 10 }, () => "tick();").join("\n") + "\n";
    const ws = makeWorkspace("linecap", { "src/tick.ts": decl, "src/many.ts": manyLines });
    const result = fakeResult([surface("src/tick.ts", decl)]);
    const rows = computeUsageInventory(result, ws);
    const entry = rows.find((r) => r.symbol === "tick")!;
    const manyFile = entry.files.find((f) => f.path === "src/many.ts")!;
    expect(manyFile.lines.length).toBeLessThanOrEqual(3);
    expect(entry.total).toBe(11); // true count still honestly reported: the declaration plus the 10 calls
    expect(entry.inventory_complete).toBe(false);
  });
});

describe("attachUsageInventory (via computeUsageInventory) — flag gate", () => {
  it("OFF (default): usageInventoryEnabled() reads false", () => {
    expect(usageInventoryEnabled()).toBe(false);
  });
  it("ON: usageInventoryEnabled() reads true", () => {
    process.env["TL_USAGE_INVENTORY"] = "1";
    expect(usageInventoryEnabled()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// End-to-end wire shape, under the real in-process dev server.
// ---------------------------------------------------------------------------

describe("wire: plan.usages over a real tl_read_file call", () => {
  // v0.15.0 (WP-RK): the pack serves the declaration and ONE caller; a symbol whose every match is inside the
  // served slices adds nothing and is dropped, so more callers than the pack serves are needed for an inventory.
  const FILES = {
    "src/fees.ts": "export function computeShippingFee(weight: number): number {\n  return weight * 2;\n}\n",
    "src/orderA.ts": "import { computeShippingFee } from './fees.js';\nconst a = computeShippingFee(3);\n",
    "src/orderB.ts": "import { computeShippingFee } from './fees.js';\nconst b = computeShippingFee(4);\n",
    "src/orderC.ts": "import { computeShippingFee } from './fees.js';\nconst c = computeShippingFee(5);\n",
    "src/orderD.ts": "import { computeShippingFee } from './fees.js';\nconst d = computeShippingFee(6);\n",
  } as const;

  it("ON: plan.usages is present, lexical, and never labelled 'callers'", async () => {
    process.env["TL_USAGE_INVENTORY"] = "1";
    const ws = makeWorkspace("wire-on", FILES);
    const server = startDevServer(ws, "default");
    servers.push(server);
    await server.initialize();
    const { body } = await server.callTool("tl_read_file", {
      query: "In src/fees.ts, what does computeShippingFee do?",
      task: { profile: "answer", epoch: "new" },
      cwd: ws,
    });
    expect(body.kind).toBe("read.task_pack");
    const usages = body.plan?.usages;
    expect(Array.isArray(usages)).toBe(true);
    const entry = (usages as any[]).find((u) => u.symbol === "computeShippingFee");
    expect(entry).toBeDefined();
    expect(typeof entry.total).toBe("number");
    expect(typeof entry.inventory_complete).toBe("boolean");
    expect(JSON.stringify(body)).not.toContain("callers");
  });

  it("OFF (default): plan.usages is absent", async () => {
    const ws = makeWorkspace("wire-off", FILES);
    const server = startDevServer(ws, "default");
    servers.push(server);
    await server.initialize();
    const { body } = await server.callTool("tl_read_file", {
      query: "In src/fees.ts, what does computeShippingFee do?",
      task: { profile: "answer", epoch: "new" },
      cwd: ws,
    });
    expect(body.kind).toBe("read.task_pack");
    expect(body.plan?.usages).toBeUndefined();
  });
});
