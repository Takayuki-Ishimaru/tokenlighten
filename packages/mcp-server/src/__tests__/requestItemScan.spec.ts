import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
const reads = vi.hoisted(() => new Map<string, number>());
vi.mock("fs", async (original) => {
  const actual = await original<typeof import("fs")>();
  return { ...actual, readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
    if (typeof args[0] === "string") reads.set(args[0], (reads.get(args[0]) ?? 0) + 1);
    return (actual.readFileSync as (...values: typeof args) => ReturnType<typeof actual.readFileSync>)(...args);
  } };
});
import { createScanContentCache, createScanCoverage, scanLiteral } from "../features/search/find/findText.js";
import { scanRequestItemLiteral } from "../features/task-pack/requestItemScan.js";
import { runWithRequestSignal } from "../util/requestCancellation.js";
const dirs: string[] = [];
function fixture(text = "needle\nother\n") {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tl-request-scan-"));
  dirs.push(workspace);
  const absPath = path.join(workspace, "a.ts");
  fs.writeFileSync(absPath, text);
  const files = [{ absPath, relPath: "a.ts" }];
  const contentCache = createScanContentCache();
  contentCache.bytes = 64 * 1024 * 1024; // Reproduce the real checkout's full cache without a 64 MiB fixture.
  return { workspace, absPath, files, contentCache };
}
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); reads.clear(); });
describe("response-local request-item scan memo", () => {
  it("avoids repeated overflow-file opens while reproducing every coverage set", () => {
    const f = fixture();
    const opts = { files: f.files, contentCache: f.contentCache, coverage: createScanCoverage() };
    scanLiteral("needle", f.workspace, opts);
    scanLiteral("needle", f.workspace, opts);
    expect(reads.get(f.absPath)).toBe(2); // The pre-fix repeated-read shape.
    reads.clear();
    const first = scanRequestItemLiteral("needle", f.workspace, opts);
    const coverage = createScanCoverage();
    expect(scanRequestItemLiteral("needle", f.workspace, { ...opts, coverage })).toEqual(first);
    expect(coverage).toEqual(opts.coverage);
    expect(scanRequestItemLiteral("needle", f.workspace, { ...opts, files: [...f.files] })).toEqual(first);
    expect(reads.get(f.absPath)).toBe(1);
    first.length = 0;
    expect(scanRequestItemLiteral("needle", f.workspace, opts)).toHaveLength(1);
  });

  it("separates response caches, options, and inventory identities", () => {
    const f = fixture("NEEDLE\n");
    const opts = { files: f.files, contentCache: f.contentCache, coverage: createScanCoverage() };
    expect(scanRequestItemLiteral("needle", f.workspace, opts)).toEqual([]);
    expect(scanRequestItemLiteral("needle", f.workspace, { ...opts, caseInsensitive: true })).toHaveLength(1);
    expect(scanRequestItemLiteral("NEEDLE", f.workspace, { ...opts, files: [] })).toEqual([]);
    const otherCache = createScanContentCache();
    otherCache.bytes = 64 * 1024 * 1024;
    scanRequestItemLiteral("needle", f.workspace, { ...opts, contentCache: otherCache });
    expect(reads.get(f.absPath)).toBe(3);
  });

  it("invalidates changed bytes even through another inventory array and fails closed on deletion", () => {
    const f = fixture();
    const opts = { files: f.files, contentCache: f.contentCache, coverage: createScanCoverage() };
    expect(scanRequestItemLiteral("needle", f.workspace, opts)).toHaveLength(1);
    fs.writeFileSync(f.absPath, "replacement without the original literal\n");
    expect(scanRequestItemLiteral("needle", f.workspace, { ...opts, files: [...f.files] })).toEqual([]);
    fs.unlinkSync(f.absPath);
    const coverage = createScanCoverage();
    expect(scanRequestItemLiteral("needle", f.workspace, { ...opts, coverage })).toEqual([]);
    expect(coverage.scanned.size).toBe(0);
    expect([...coverage.unscanned]).toEqual(["a.ts"]);
  });

  it("does not bind prewalk-cached stale bytes to a newer file fingerprint", () => {
    const f = fixture();
    f.contentCache.bytes = 0;
    const opts = { files: f.files, contentCache: f.contentCache, coverage: createScanCoverage() };
    expect(scanLiteral("needle", f.workspace, opts)).toHaveLength(1);
    fs.writeFileSync(f.absPath, "changed before the first memo scan\n");
    expect(scanRequestItemLiteral("needle", f.workspace, opts)).toEqual([]);
    expect(scanRequestItemLiteral("needle", f.workspace, opts)).toEqual([]);
  });

  it("honors request cancellation before validating an inventory", () => {
    const f = fixture();
    const controller = new AbortController();
    const reason = new Error("cancelled scan");
    controller.abort(reason);
    expect(() => runWithRequestSignal(controller.signal, () => scanRequestItemLiteral("needle", f.workspace,
      { files: f.files, contentCache: f.contentCache, coverage: createScanCoverage() }))).toThrow(reason);
    expect(reads.get(f.absPath)).toBeUndefined();
  });

  it("does not retain oversized match tables after the memo byte bound", () => {
    const f = fixture(("needle" + ".".repeat(60) + "\n").repeat(40_000));
    const opts = { files: f.files, contentCache: f.contentCache, coverage: createScanCoverage() };
    expect(scanRequestItemLiteral("needle", f.workspace, opts)).toHaveLength(40_000);
    expect(scanRequestItemLiteral("needle", f.workspace, opts)).toHaveLength(40_000);
    expect(reads.get(f.absPath)).toBe(2);
  });
});
