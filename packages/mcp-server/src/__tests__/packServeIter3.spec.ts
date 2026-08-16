/**
 * packServeIter3.spec.ts — iteration-3 "byte floor" improvements.
 *
 * F1  receipt latency: an interleaved artifact-bearing pack no longer wipes the
 *     whole per-workspace receipt window, so the FIRST exact repeat of a code
 *     pack receipts (was: full serve on the first repeat, receipt only from the
 *     second).
 * F2  semantic-duplicate receipt: a re-issue truncated mid-word (same paths,
 *     near-identical tokens) receipts; a distinct-concern pack (different paths)
 *     does NOT.
 * F3  cross-pack resident-file dedup: a NON-required surface whose exact
 *     (path,range) body was already served this epoch and is byte-unchanged is
 *     re-served code-less with a compact resident marker; tiny bodies, changed
 *     files, required surfaces, and different epochs are exempt.
 * F4  envelope weight: packs 2+ (and prepared/complete packs) shed orientation
 *     metadata (tree / full-code outline+why / read-pack likely_edits / overlong
 *     route.reason); the first exploratory pack keeps the full envelope; a
 *     partial surface keeps its outline. Includes a byte-reduction measurement.
 * F5  runtime hint (Office source → Python target) + softened W5 wording.
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  buildTaskPack,
  resetPackDedupeCache,
  resetRoleInventoryCache,
  applyResidentFileDedup,
  applyEnvelopeWeightTrim,
  attachRuntimeHint,
  discoverPythonInterpreters,
  type TaskPackResult,
  type TaskPackSurface,
} from "../tools/readCodeTaskPack.js";
import { handleTable } from "../util/handles.js";
import { resetPackServeLogForTest } from "../util/packServeLog.js";
import { tokenizeForEpoch } from "../util/session.js";

function mkWs(tag: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `tl-iter3-${tag}-`)));
}
function write(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}
async function workbookBytes(sheetName: string): Promise<Buffer> {
  type Worksheet = { addRow(values: unknown[]): void };
  type Workbook = { addWorksheet(name: string): Worksheet; xlsx: { writeBuffer(): Promise<Buffer> } };
  const ExcelJSMod = (await import("exceljs")) as unknown as { Workbook: new () => Workbook };
  const workbook = new ExcelJSMod.Workbook();
  const data = workbook.addWorksheet(sheetName);
  data.addRow(["key", "rate"]);
  for (let i = 0; i < 3; i++) data.addRow([`item-${i}`, i + 0.25]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

const reset = (): void => {
  handleTable.reset();
  resetPackDedupeCache();
  resetRoleInventoryCache();
  resetPackServeLogForTest();
};

// ===========================================================================
// F1: an interleaved artifact pack must not poison unrelated code-pack receipts
// ===========================================================================

describe("buildTaskPack — F1: interleaved artifact pack no longer wipes the receipt window", () => {
  beforeEach(reset);

  it("a code pack, then an artifact pack, then the SAME code pack again -> the repeat receipts", async () => {
    const ws = mkWs("f1");
    write(ws, "src/shared/status.ts", "export const Status = { OPEN: 'open', CLOSED: 'closed' } as const;\n");
    write(ws, "src/ratingEngine.ts",
      "export function calculateRate(key: string): number {\n  void key;\n  return 0;\n}\n");
    fs.mkdirSync(path.join(ws, "docs"), { recursive: true });
    fs.writeFileSync(path.join(ws, "docs/rate-table.xlsx"), await workbookBytes("BaseRates"));

    const codeArgs = { query: "add STALLED to the status enum", paths: [{ path: "src/shared/status.ts" }] };
    const artifactArgs = {
      query: "Implement calculateRate from the rate table XLSX using BaseRates.",
      paths: ["docs/rate-table.xlsx", "src/ratingEngine.ts"],
    };

    const c1 = await buildTaskPack(codeArgs, ws);
    expect(c1.pack_unchanged).toBeUndefined();
    if (c1.surfaces.length === 0) return;

    // The interleaved artifact-bearing pack. Pre-F1 this ran
    // servedPacksByWorkspace.delete(workspace), evicting c1's record.
    const a1 = await buildTaskPack(artifactArgs, ws);
    expect(a1.pack_unchanged).toBeUndefined();

    // The FIRST exact repeat of the code pack must now receipt (pre-F1 it was a
    // full serve, and only the SECOND repeat receipted — the one-call latency).
    const c2 = await buildTaskPack(codeArgs, ws);
    expect(c2.pack_unchanged).toBe(true);
    expect(c2.surfaces.every((s) => s.code === undefined)).toBe(true);
  }, 30000);
});

// ===========================================================================
// F2: semantic-duplicate receipt (truncated re-ask) vs distinct-concern serve
// ===========================================================================

describe("buildTaskPack — F2: semantic-duplicate receipt", () => {
  beforeEach(reset);

  function seedTwoConcerns(ws: string): void {
    write(ws, "src/shared/workflowStatus.ts",
      "export enum WorkflowStatus { OPEN = 'OPEN', ACTIVE = 'ACTIVE', DONE = 'DONE' }\n");
    write(ws, "src/api/paymentRoutes.ts",
      "export function refund(id: string) { return id; }\n");
  }

  it("a re-issue TRUNCATED mid-word (same paths, near-identical tokens) receipts", async () => {
    const ws = mkWs("f2-trunc");
    seedTwoConcerns(ws);
    const full = "add PAUSED state to the workflowStatus enumeration";
    const trunc = "add PAUSED state to the workflowStatus enumerati"; // last token truncated
    // Sanity: the truncation actually changes the epoch tokens (so the exact
    // fingerprint dedup would MISS — this is F2's job, not F1's).
    expect(tokenizeForEpoch(full)).not.toEqual(tokenizeForEpoch(trunc));

    const a = await buildTaskPack({ query: full, paths: [{ path: "src/shared/workflowStatus.ts" }] }, ws);
    expect(a.pack_unchanged).toBeUndefined();
    if (a.surfaces.length === 0) return;

    const b = await buildTaskPack({ query: trunc, paths: [{ path: "src/shared/workflowStatus.ts" }] }, ws);
    expect(b.pack_unchanged).toBe(true);
    expect(b.surfaces.every((s) => s.code === undefined)).toBe(true);
  }, 30000);

  it("a DISTINCT-concern pack (different paths) is NOT a semantic duplicate — full serve", async () => {
    const ws = mkWs("f2-distinct");
    seedTwoConcerns(ws);
    const a = await buildTaskPack(
      { query: "add PAUSED state to the workflowStatus enumeration", paths: [{ path: "src/shared/workflowStatus.ts" }] },
      ws,
    );
    expect(a.pack_unchanged).toBeUndefined();
    if (a.surfaces.length === 0) return;

    // Same epoch words ("add ... state ..."), but a DIFFERENT working set (the
    // payment routes file). Path-subset fails -> not a duplicate -> full serve.
    const b = await buildTaskPack(
      { query: "add a PAUSED state guard to the payment refund routes", paths: [{ path: "src/api/paymentRoutes.ts" }] },
      ws,
    );
    expect(b.pack_unchanged).toBeUndefined();
    expect(b.surfaces.some((s) => s.code !== undefined)).toBe(true);
  }, 30000);

  it("a surfaceRoles retry over the same query is NOT collapsed into the earlier receipt", async () => {
    const ws = mkWs("f2-roles");
    write(ws, "src/shared/status.ts", "export type Status = 'open' | 'closed';\n");
    write(ws, "src/api/routes.ts", "export function ping() { return 'pong'; }\n");
    const first = await buildTaskPack({ query: "update status handling" }, ws);
    expect(first.surfaces.some((s) => s.role === "api")).toBe(false);
    // Adding surfaceRoles changes the working set — must re-serve, not receipt.
    const second = await buildTaskPack({ query: "update status handling", surfaceRoles: ["api"] }, ws);
    expect(second.pack_unchanged).toBeUndefined();
    expect(second.surfaces.some((s) => s.role === "api")).toBe(true);
  }, 30000);
});

// ===========================================================================
// F3: cross-pack resident-file dedup (unit — deterministic over the served log)
// ===========================================================================

describe("applyResidentFileDedup — F3: content-addressed cross-pack body dedup", () => {
  beforeEach(reset);

  const BIG = `// shared enum module, comfortably over the 512B resident floor\n`
    + `export enum Priority {\n`
    + Array.from({ length: 20 }, (_, i) => `  LEVEL_${i} = "LEVEL_${i}",`).join("\n")
    + `\n}\n`;

  async function seedAndGetRange(ws: string, query: string): Promise<string | undefined> {
    write(ws, "src/enums.ts", BIG);
    const a = await buildTaskPack({ query, paths: [{ path: "src/enums.ts" }] }, ws);
    return a.surfaces.find((s) => s.path === "src/enums.ts")?.range;
  }
  function fakeSurface(range: string, bytes: number, required: boolean): TaskPackSurface {
    return {
      role: "contract", handle: "hFAKE", path: "src/enums.ts", range,
      required, code: "y".repeat(bytes),
    };
  }
  function packOf(surf: TaskPackSurface): TaskPackResult {
    return { mode: "task_pack", coverage: "partial", surfaces: [surf], missing: [] };
  }

  it("strips a NON-required resident body >=512B and leaves a compact resident marker", async () => {
    const ws = mkWs("f3-strip");
    const q = "widen the Priority enum with a new level";
    const range = await seedAndGetRange(ws, q);
    if (range === undefined) return;
    const surf = fakeSurface(range, 800, false);
    const pack = packOf(surf);
    applyResidentFileDedup(ws, pack, tokenizeForEpoch(q));
    expect(surf.code).toBeUndefined();
    expect(typeof surf.code_unchanged).toBe("string");
    expect(surf.code_unchanged).toContain("already served this session");
    expect(surf.code_unchanged).toContain("src/enums.ts");
    // Marker names a prior handle + short sha — small, not a re-served body.
    expect(surf.code_unchanged!.length).toBeLessThan(220);
  }, 30000);

  it("leaves a tiny body (<512B) inline (indirection not worth it)", async () => {
    const ws = mkWs("f3-tiny");
    const q = "widen the Priority enum with a new level";
    const range = await seedAndGetRange(ws, q);
    if (range === undefined) return;
    const surf = fakeSurface(range, 100, false);
    const pack = packOf(surf);
    applyResidentFileDedup(ws, pack, tokenizeForEpoch(q));
    expect(surf.code).toBeDefined();
    expect(surf.code_unchanged).toBeUndefined();
  }, 30000);

  it("leaves a REQUIRED surface's body inline (edit target stays fully visible)", async () => {
    const ws = mkWs("f3-required");
    const q = "widen the Priority enum with a new level";
    const range = await seedAndGetRange(ws, q);
    if (range === undefined) return;
    const surf = fakeSurface(range, 800, true);
    const pack = packOf(surf);
    applyResidentFileDedup(ws, pack, tokenizeForEpoch(q));
    expect(surf.code).toBeDefined();
  }, 30000);

  it("re-serves the body in full when the file CHANGED since it was served", async () => {
    const ws = mkWs("f3-changed");
    const q = "widen the Priority enum with a new level";
    const range = await seedAndGetRange(ws, q);
    if (range === undefined) return;
    // Edit the file so its content sha no longer matches the served record.
    write(ws, "src/enums.ts", BIG + "export const EXTRA = 1;\n");
    const surf = fakeSurface(range, 800, false);
    const pack = packOf(surf);
    applyResidentFileDedup(ws, pack, tokenizeForEpoch(q));
    expect(surf.code).toBeDefined();
    expect(surf.code_unchanged).toBeUndefined();
  }, 30000);

  it("does NOT strip across a DIFFERENT task epoch (the body may be out of context)", async () => {
    const ws = mkWs("f3-epoch");
    const q = "widen the Priority enum with a new level";
    const range = await seedAndGetRange(ws, q);
    if (range === undefined) return;
    const surf = fakeSurface(range, 800, false);
    const pack = packOf(surf);
    applyResidentFileDedup(ws, pack, tokenizeForEpoch("completely unrelated payment refund concern"));
    expect(surf.code).toBeDefined();
  }, 30000);
});

// ===========================================================================
// F4: envelope weight — matrix + measured byte reduction
// ===========================================================================

describe("applyEnvelopeWeightTrim — F4: orientation-weight shedding", () => {
  function representative(): TaskPackResult {
    const fullCode: TaskPackSurface = {
      role: "contract", handle: "h1", path: "src/a.ts", range: "1-40",
      why: "anchor-focus: query-matched symbol foo",
      outline: Array.from({ length: 8 }, (_, i) => `L${i * 5 + 1}: heading ${i}`),
      likely_edits: [{ kind: "handle-scoped-edit", handle: "h1", target: "edit_file handle=h1", confidence: 0.6 }],
      code: "export function foo() {\n" + "  // body line\n".repeat(30) + "}\n",
    };
    const partial: TaskPackSurface = {
      role: "api", handle: "h2", path: "src/b.ts", range: "1-200",
      why: "anchor-focus: query-matched symbol bar",
      outline: Array.from({ length: 6 }, (_, i) => `L${i * 7 + 1}: section ${i}`),
      content_completeness: "partial",
      remaining_ranges: ["80-200"],
      code: "export function bar() {\n" + "  // partial body\n".repeat(10) + "}\n",
    };
    return {
      mode: "task_pack",
      coverage: "partial",
      surfaces: [fullCode, partial],
      missing: [],
      tree: Array.from({ length: 30 }, (_, i) => `src/dir${i}/ — 3 files`).join("\n"),
      route: {
        action: "inspect_handles",
        reason: "x".repeat(400),
        max_additional_tl_calls: 1,
      },
    };
  }

  it("first exploratory (partial, not prepared/complete) pack is returned UNTOUCHED", () => {
    const pack = representative();
    const saved = applyEnvelopeWeightTrim(pack, /*isFirstPack*/ true, /*isChangeProfile*/ false);
    expect(saved).toBe(0);
    expect(pack.tree).toBeDefined();
    expect((pack.surfaces[0] as TaskPackSurface).why).toBeDefined();
    expect((pack.surfaces[0] as TaskPackSurface).outline).toBeDefined();
  });

  it("a later pack (2+) sheds tree + full-code outline/why + read-pack likely_edits; partial surface KEEPS outline", () => {
    const pack = representative();
    const before = Buffer.byteLength(JSON.stringify(pack), "utf8");
    const codeBytes = pack.surfaces.reduce((n, s) =>
      n + Buffer.byteLength((s as TaskPackSurface).code ?? "", "utf8"), 0);
    const saved = applyEnvelopeWeightTrim(pack, /*isFirstPack*/ false, /*isChangeProfile*/ false);
    // tree gone.
    expect(pack.tree).toBeUndefined();
    // full-code surface lost why + outline.
    const fullCode = pack.surfaces[0] as TaskPackSurface;
    expect(fullCode.why).toBeUndefined();
    expect(fullCode.outline).toBeUndefined();
    expect(fullCode.likely_edits).toBeUndefined();
    // partial surface KEEPS its outline (drives slice zooming over the unfetched span).
    const partial = pack.surfaces[1] as TaskPackSurface;
    expect(partial.outline).toBeDefined();
    // route.reason capped.
    expect(pack.route!.reason.length).toBeLessThanOrEqual(200);
    // Measured envelope reduction: saved must be >= 25% of the envelope (non-code) bytes.
    const envelopeBytes = before - codeBytes;
    expect(saved / envelopeBytes).toBeGreaterThanOrEqual(0.25);
  });

  it("a prepared/complete pack is trimmed even as pack 2+ (tree gone, likely_edits gone for a read profile)", () => {
    const pack = representative();
    pack.coverage = "complete";
    const saved = applyEnvelopeWeightTrim(pack, /*isFirstPack*/ false, /*isChangeProfile*/ false);
    expect(saved).toBeGreaterThan(0);
    expect(pack.tree).toBeUndefined();
    expect((pack.surfaces[0] as TaskPackSurface).likely_edits).toBeUndefined();
  });

  it("a CHANGE profile keeps likely_edits (there is an edit to guide)", () => {
    const pack = representative();
    applyEnvelopeWeightTrim(pack, /*isFirstPack*/ false, /*isChangeProfile*/ true);
    expect((pack.surfaces[0] as TaskPackSurface).likely_edits).toBeDefined();
  });
});

// ===========================================================================
// F5: runtime hint (Office source -> Python target) + softened W5 wording
// ===========================================================================

describe("attachRuntimeHint — F5a: python runtime hint", () => {
  function artifactPyPack(): TaskPackResult {
    return {
      mode: "task_pack",
      coverage: "focused",
      surfaces: [
        { role: "api", handle: "h1", path: "src/rate_engine.py", required: true, range: "1-10",
          code: "def calculate_rate(key):\n    return 0\n" } as TaskPackSurface,
      ],
      missing: [],
      artifact_requirements: ["docs/rate-table.xlsx"],
      create_target: { path: "src/rate_engine.py", directory_evidence: ["src/"] },
    };
  }

  it("attaches a compact python runtime hint for an Office source -> .py target", () => {
    const pack = artifactPyPack();
    attachRuntimeHint(pack);
    if (discoverPythonInterpreters().length === 0) {
      // No interpreter on this machine — the hint is skipped silently.
      expect(pack.runtime).toBeUndefined();
      return;
    }
    expect(pack.runtime).toBeDefined();
    expect(pack.runtime!.kind).toBe("python");
    expect(pack.runtime!.module).toBe("openpyxl");
    expect(Array.isArray(pack.runtime!.interpreters)).toBe(true);
    expect(pack.runtime!.interpreters.length).toBeGreaterThan(0);
    for (const it of pack.runtime!.interpreters) {
      expect(typeof it.path).toBe("string");
      expect(typeof it.has_module).toBe("boolean");
    }
    // Honest hint wording + the ~500B cap.
    expect(pack.runtime!.note.toLowerCase()).toContain("hint only");
    expect(Buffer.byteLength(JSON.stringify({ runtime: pack.runtime }), "utf8")).toBeLessThanOrEqual(500);
  });

  it("is ABSENT on a non-Python target (a .ts edit target)", () => {
    const pack = artifactPyPack();
    (pack.surfaces[0] as TaskPackSurface).path = "src/rateEngine.ts";
    pack.create_target = { path: "src/rateEngine.ts", directory_evidence: ["src/"] };
    attachRuntimeHint(pack);
    expect(pack.runtime).toBeUndefined();
  });

  it("is ABSENT when the sources are not Office files", () => {
    const pack = artifactPyPack();
    pack.artifact_requirements = ["docs/notes.txt"];
    attachRuntimeHint(pack);
    expect(pack.runtime).toBeUndefined();
  });
});

describe("buildTaskPack — F5b: softened functional-validation wording", () => {
  beforeEach(reset);

  it("names the cheapest sufficient proof (smoke run OR diff review), not a validation campaign", async () => {
    const ws = mkWs("f5b");
    write(ws, "src/ratingEngine.ts",
      "export function calculateRate(key: string): number {\n  void key;\n  return 0;\n}\n");
    fs.mkdirSync(path.join(ws, "docs"), { recursive: true });
    fs.writeFileSync(path.join(ws, "docs/rate-table.xlsx"), await workbookBytes("BaseRates"));

    const res = await buildTaskPack({
      query: "Implement calculateRate from the rate table XLSX using BaseRates.",
      paths: ["docs/rate-table.xlsx", "src/ratingEngine.ts"],
    }, ws);

    const line = (res.verify ?? []).find((v) => v.startsWith("validate the produced module the cheap way"));
    expect(line).toBeDefined();
    expect(line!).toContain("smoke run");
    expect(line!).toContain("diff review");
    expect(line!).toContain("no extended validation campaign");
  }, 30000);
});
