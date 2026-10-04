/**
 * evaluation0929.neighbourIndex.spec.ts — V15-NBR (2026-09-29),
 * `TL_NEIGHBOUR_INDEX`, default OFF. See features/task-pack/
 * frontierNeighbours.ts's module doc comment for the mechanism and its
 * rationale (measure-v015/REPORT.md's "Extra finding").
 *
 * Pinned here: per-language resolution (TS/JS, Python, Go, Java), the
 * 8-row cap, dedupe against already-served surfaces, the flag's default-OFF
 * inertness (unit level), and the end-to-end wire shape under a real server
 * (`plan.neighbours` present and shaped when ON, absent when OFF).
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import { startDevServer, type ServerHandle } from "./helpers/qualityFirstScenarios.js";
import { computeFrontierNeighbourIndex, attachFrontierNeighbourIndex } from "../features/task-pack/frontierNeighbours.js";
import { neighbourIndexEnabled } from "../util/flags.js";
import type { TaskPackResult, TaskPackSurface } from "../features/task-pack/model.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();
const tmpDirs: string[] = [];
const servers: ServerHandle[] = [];

afterEach(async () => {
  delete process.env["TL_NEIGHBOUR_INDEX"];
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
  const ws = fs.realpathSync(shortTmpDir(HOME, `.tl-e0929-nbr-${tag}-`));
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

// ---------------------------------------------------------------------------
// Pure computation — one language per case, fresh fixture names/values.
// ---------------------------------------------------------------------------

describe("computeFrontierNeighbourIndex — per-language resolution", () => {
  it("TS/JS: a relative import resolves to a real sibling file", () => {
    const a = "import { widgetTotal } from './priceUtil.js';\nexport function sumWidgets(n: number): number { return widgetTotal(n); }\n";
    const ws = makeWorkspace("ts", {
      "src/orderMath.ts": a,
      "src/priceUtil.ts": "export function widgetTotal(n: number): number { return n * 7; }\n",
    });
    const result = fakeResult([surface("src/orderMath.ts", a)]);
    const rows = computeFrontierNeighbourIndex(result, ws);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.path).toBe("src/priceUtil.ts");
    expect(rows[0]!.why).toBe("imported by src/orderMath.ts:1");
    expect(rows[0]!.handle.length).toBeGreaterThan(0);
  });

  it("Python: 'from .rel import x' and 'import pkg.mod' both resolve", () => {
    const a = "from .discountRules import applyDiscount\nimport catalog.pricing\n\ndef total(x):\n    return applyDiscount(catalog.pricing.base(x))\n";
    const ws = makeWorkspace("py", {
      "shop/checkout.py": a,
      "shop/discountRules.py": "def applyDiscount(x):\n    return x * 0.9\n",
      "catalog/pricing.py": "def base(x):\n    return x + 1\n",
    });
    const result = fakeResult([surface("shop/checkout.py", a)]);
    const rows = computeFrontierNeighbourIndex(result, ws);
    const paths = rows.map((r) => r.path).sort();
    expect(paths).toEqual(["catalog/pricing.py", "shop/discountRules.py"]);
    expect(rows.find((r) => r.path === "shop/discountRules.py")!.why).toBe("imported by shop/checkout.py:1");
  });

  it("Go: a real import path resolves by trailing-segment match; a non-imported same-directory sibling never appears", () => {
    const a = 'package main\n\nimport "shopapp/internal/ledger"\n\nfunc main() {\n\tledger.Post()\n}\n';
    const ws = makeWorkspace("go", {
      "cmd/main.go": a,
      "internal/ledger/ledger.go": "package ledger\n\nfunc Post() {}\n",
      // Same directory as main.go, but NEVER imported — must be excluded
      // ("Go same-package siblings excluded unless imported").
      "cmd/helper.go": "package main\n\nfunc helper() {}\n",
    });
    const result = fakeResult([surface("cmd/main.go", a)]);
    const rows = computeFrontierNeighbourIndex(result, ws);
    expect(rows.map((r) => r.path)).toEqual(["internal/ledger/ledger.go"]);
    expect(rows.some((r) => r.path === "cmd/helper.go")).toBe(false);
  });

  it("Java: a dotted import under src/main/java resolves", () => {
    const a = "package com.example.orders;\n\nimport com.example.orders.util.TaxCalc;\n\npublic class OrderApp {\n  void run() { TaxCalc.apply(1); }\n}\n";
    const ws = makeWorkspace("java", {
      "src/main/java/com/example/orders/OrderApp.java": a,
      "src/main/java/com/example/orders/util/TaxCalc.java": "package com.example.orders.util;\n\npublic class TaxCalc {\n  static int apply(int x) { return x; }\n}\n",
    });
    const result = fakeResult([surface("src/main/java/com/example/orders/OrderApp.java", a)]);
    const rows = computeFrontierNeighbourIndex(result, ws);
    expect(rows.map((r) => r.path)).toEqual(["src/main/java/com/example/orders/util/TaxCalc.java"]);
  });

  it("caps at 8 rows even when more are importable", () => {
    const imports = Array.from({ length: 12 }, (_, i) => `import { v${i} } from './m${i}.js';`).join("\n");
    const files: Record<string, string> = { "src/hub.ts": imports + "\n" };
    for (let i = 0; i < 12; i++) files[`src/m${i}.ts`] = `export const v${i} = ${i};\n`;
    const ws = makeWorkspace("cap", files);
    const result = fakeResult([surface("src/hub.ts", files["src/hub.ts"]!)]);
    const rows = computeFrontierNeighbourIndex(result, ws);
    expect(rows.length).toBeLessThanOrEqual(8);
    expect(rows.length).toBe(8);
  });

  it("never re-offers a path already served in this response", () => {
    const a = "import { helperFn } from './helperMod.js';\nexport const done = helperFn();\n";
    const b = "export function helperFn(): number { return 1; }\n";
    const ws = makeWorkspace("dedupe", { "src/main.ts": a, "src/helperMod.ts": b });
    const result = fakeResult([surface("src/main.ts", a), surface("src/helperMod.ts", b)]);
    const rows = computeFrontierNeighbourIndex(result, ws);
    expect(rows).toHaveLength(0);
  });

  it("serialized rows stay within the ~1 KiB budget", () => {
    const imports = Array.from({ length: 8 }, (_, i) => `import { v${i} } from './deep/nested/path/segment${i}/moduleFile${i}.js';`).join("\n");
    const files: Record<string, string> = { "src/hub.ts": imports + "\n" };
    for (let i = 0; i < 8; i++) files[`src/deep/nested/path/segment${i}/moduleFile${i}.ts`] = `export const v${i} = ${i};\n`;
    const ws = makeWorkspace("bytes", files);
    const result = fakeResult([surface("src/hub.ts", files["src/hub.ts"]!)]);
    const rows = computeFrontierNeighbourIndex(result, ws);
    expect(Buffer.byteLength(JSON.stringify(rows), "utf8")).toBeLessThanOrEqual(1024);
  });
});

describe("attachFrontierNeighbourIndex — flag gate", () => {
  it("OFF (default, no env set): never attaches, regardless of resolvable candidates", () => {
    expect(neighbourIndexEnabled()).toBe(false);
    const a = "import { widgetTotal } from './priceUtil.js';\n";
    const ws = makeWorkspace("gate-off", { "src/orderMath.ts": a, "src/priceUtil.ts": "export function widgetTotal(n){return n;}\n" });
    const result = fakeResult([surface("src/orderMath.ts", a)]);
    attachFrontierNeighbourIndex(result, ws);
    expect(result.neighbours).toBeUndefined();
  });

  it("ON: attaches result.neighbours with the expected row shape", () => {
    process.env["TL_NEIGHBOUR_INDEX"] = "1";
    expect(neighbourIndexEnabled()).toBe(true);
    const a = "import { widgetTotal } from './priceUtil.js';\n";
    const ws = makeWorkspace("gate-on", { "src/orderMath.ts": a, "src/priceUtil.ts": "export function widgetTotal(n){return n;}\n" });
    const result = fakeResult([surface("src/orderMath.ts", a)]);
    attachFrontierNeighbourIndex(result, ws);
    expect(result.neighbours).toEqual([
      { path: "src/priceUtil.ts", handle: expect.any(String), why: "imported by src/orderMath.ts:1" },
    ]);
  });

  it("ON but no surfaces: attaches nothing (no candidate source)", () => {
    process.env["TL_NEIGHBOUR_INDEX"] = "1";
    const ws = makeWorkspace("gate-on-empty", {});
    const result = fakeResult([]);
    attachFrontierNeighbourIndex(result, ws);
    expect(result.neighbours).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// End-to-end wire shape, under the real in-process dev server.
// ---------------------------------------------------------------------------

describe("wire: plan.neighbours over a real tl_read_file call", () => {
  const FILES = {
    "src/orderMath.ts": "import { widgetTotal } from './priceUtil.js';\nexport function sumWidgets(n: number): number { return widgetTotal(n); }\n",
    "src/priceUtil.ts": "export function widgetTotal(n: number): number { return n * 7; }\n",
  } as const;

  it("ON: plan.neighbours is present and named the unserved import", async () => {
    process.env["TL_NEIGHBOUR_INDEX"] = "1";
    const ws = makeWorkspace("wire-on", FILES);
    const server = startDevServer(ws, "default");
    servers.push(server);
    await server.initialize();
    const { body } = await server.callTool("tl_read_file", {
      // v0.15.0 (WP-RK): not an import-RELATION question. That shape makes the pack list both files in its own
      // `frontier_index`, and a path `frontier_index` already names is never repeated in `plan.neighbours`.
      query: "What does src/orderMath.ts do?",
      task: { profile: "answer", epoch: "new" },
      cwd: ws,
    });
    expect(body.kind).toBe("read.task_pack");
    const servedPaths = new Set((body.evidence ?? []).map((e: any) => e.path));
    expect(servedPaths.has("src/orderMath.ts")).toBe(true);
    const neighbours = body.plan?.neighbours;
    expect(Array.isArray(neighbours)).toBe(true);
    const row = (neighbours as any[]).find((r) => r.path === "src/priceUtil.ts");
    expect(row).toBeDefined();
    expect(typeof row.handle).toBe("string");
    expect(row.handle.length).toBeGreaterThan(0);
    expect(row.why).toContain("src/orderMath.ts");
    // Never evidence, never booked, never cited.
    expect(servedPaths.has("src/priceUtil.ts")).toBe(false);
  });

  it("OFF (default): plan.neighbours is absent", async () => {
    const ws = makeWorkspace("wire-off", FILES);
    const server = startDevServer(ws, "default");
    servers.push(server);
    await server.initialize();
    const { body } = await server.callTool("tl_read_file", {
      query: "What does src/orderMath.ts do?",
      task: { profile: "answer", epoch: "new" },
      cwd: ws,
    });
    expect(body.kind).toBe("read.task_pack");
    expect(body.plan?.neighbours).toBeUndefined();
  });
});
