/**
 * seededPathsAdditiveClosure.spec.ts — IMPROVEMENT F: volunteered paths[] must
 * never SHRINK the closure.
 *
 * Rule under test: when a task QUERY is present, caller-supplied FILE paths[]
 * are ADDITIVE SEEDS and the relatedness-gated concern-group closure expands
 * under the same budgets as the query-only flow — never confined to the seeds'
 * own common-ancestor subtree (the 2026-07-12d confinement that let volunteering
 * MORE paths shrink the discovered closure). A pure path-fetch (no query) keeps
 * today's confined/focused behavior.
 *
 * The role-hint required-role fill deliberately KEEPS its confinement (it can
 * pull in textually-unrelated siblings); only the query-matched concern-group
 * closure is unshrunk — see readCodeTaskPack.spec.ts's 2026-07-12d tests, which
 * still pass.
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { buildTaskPack } from "../tools/readCodeTaskPack.js";
import { handleTable } from "../util/handles.js";
import { resetPackServeLogForTest } from "../util/packServeLog.js";

function mkWs(tag: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `tl-additive-${tag}-`)));
}
function write(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

/** Padding so the concern files are substantial enough for the locator. */
function pad(n: number): string {
  const lines = ["void fillerFn() {"];
  for (let i = 0; i < n; i++) lines.push(`  fillerCall(${i});`);
  lines.push("}");
  return lines.join("\n") + "\n";
}

/**
 * Single-root fixture with four DISTINCT concerns. The seed (alpha) lives under
 * proj/moduleX/; the bravo concern lives under proj/moduleY/ — OUTSIDE the
 * seed's common-ancestor directory (proj/moduleX). The remaining concerns share
 * the seed's own subtree.
 */
function fixture(ws: string): void {
  write(ws, "proj/CMakeLists.txt", "project(demo)\n");
  write(ws, "proj/moduleX/alpha_widget.cpp", "// alpha_widget.cpp\nvoid alphaWidget() {}\n" + pad(20));
  write(ws, "proj/moduleY/bravo_gadget.cpp", "// bravo_gadget.cpp\nvoid bravoGadget() {}\n" + pad(20));
  write(ws, "proj/moduleX/charlie_sensor.cpp", "// charlie_sensor.cpp\nvoid charlieSensor() {}\n" + pad(20));
  write(ws, "proj/moduleX/delta_valve.cpp", "// delta_valve.cpp\nvoid deltaValve() {}\n" + pad(20));
}

const QUERY =
  "alpha widget behavior specification, bravo gadget behavior specification, " +
  "charlie sensor behavior specification, delta valve behavior specification";

describe("buildTaskPack — IMPROVEMENT F: volunteered paths[] are additive, never shrinking", () => {
  beforeEach(() => {
    handleTable.reset();
    resetPackServeLogForTest();
  });

  it("WITH a query, concern-group closure expands OUTSIDE the seed's ancestor", async () => {
    const ws = mkWs("with-query");
    fixture(ws);
    const res = await buildTaskPack(
      { query: QUERY, paths: [{ path: "proj/moduleX/alpha_widget.cpp" }] },
      ws,
    );
    const paths = res.surfaces.map((s) => s.path);
    // The seed itself is present...
    expect(paths).toContain("proj/moduleX/alpha_widget.cpp");
    // ...and the second concern's surface from the SIBLING subtree (moduleY) is
    // pulled into the closure even though it lies outside the seed's ancestor.
    expect(paths.some((p) => p.startsWith("proj/moduleY/"))).toBe(true);
  }, 30000);

  it("a PURE path-fetch (no query) stays confined/focused — no cross-subtree expansion", async () => {
    const ws = mkWs("no-query");
    fixture(ws);
    const res = await buildTaskPack(
      { paths: [{ path: "proj/moduleX/alpha_widget.cpp" }] },
      ws,
    );
    const paths = res.surfaces.map((s) => s.path);
    expect(paths).toContain("proj/moduleX/alpha_widget.cpp");
    // No query => no concern-group closure; the sibling subtree is NOT pulled in.
    expect(paths.some((p) => p.startsWith("proj/moduleY/"))).toBe(false);
  }, 30000);
});
