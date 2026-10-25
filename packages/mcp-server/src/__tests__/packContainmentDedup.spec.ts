// packContainmentDedup.spec.ts — `applyPackContainmentDedup` (readCodeTaskPack.ts,
// TL_PACK_CONTAINMENT_DEDUP, default ON since 2026-10-19), in-process.
//
// The rule: a pack row whose lines another row of the same file in the pack
// already carries ships once. An appended window is cut from its own
// surface's `code` (it has no row internally); a separate surface gets
// `applyPackDedupe`'s `code_unchanged` pointer, its real body kept for the
// proof passes. "Carries" is proved on the text: the row's text must be its
// file's own lines at its range, unique in the file, and a substring of the
// container's body. The recorded shape it was measured on (T03's first pack,
// OrderOrchestrator.java:144-153/146-151/145-150/147-152 inside the 107-165
// body) is pinned end to end by rc/packContainmentDedup.rc.spec.ts; this file
// pins the rule's edges with synthetic surfaces over a real file, one case
// per guard.
import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  applyPackContainmentDedup,
  servedSurfaceText,
  type TaskPackResult,
  type TaskPackSurface,
} from "../features/task-pack/readCodeTaskPack.js";

const PATH = "src/Orchestrator.java";
const REPEATED = "src/Repeated.java";

/** Source line `n` of the synthetic file: distinct text per line. */
function line(n: number): string {
  return `    statement_${n}(alpha, beta); // line ${n}`;
}

/** Lines `start..end`, joined as a served body. */
function lines(start: number, end: number): string {
  return Array.from({ length: end - start + 1 }, (_, i) => line(start + i)).join("\n");
}

/** Repeated.java: lines 1-5 and 11-15 are the same block. */
const BLOCK = ["    if (ready) {", "        run();", "        log();", "    }", "    done();"];
const REPEATED_SOURCE = [...BLOCK, "a();", "b();", "c();", "d();", "e();", ...BLOCK, ""].join("\n");

const WORKSPACE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tl-contain-unit-")));
fs.mkdirSync(path.join(WORKSPACE, "src"), { recursive: true });
fs.writeFileSync(path.join(WORKSPACE, PATH), `${lines(1, 300)}\n`);
fs.writeFileSync(path.join(WORKSPACE, REPEATED), REPEATED_SOURCE);

afterAll(() => {
  fs.rmSync(WORKSPACE, { recursive: true, force: true });
});

function surface(fields: Partial<TaskPackSurface> & { handle: string; range: string }): TaskPackSurface {
  return { role: "api", path: PATH, ...fields };
}

function pack(surfaces: TaskPackSurface[], extra: Partial<TaskPackResult> = {}): TaskPackResult {
  return { mode: "task_pack", coverage: "partial", surfaces, missing: [], ...extra };
}

/** A head surface over `range` with `windows` appended the way `buildAnswerTaskPack` appends them. */
function withWindows(handle: string, range: string, windows: Array<{ range: string; text?: string }>, fields: Partial<TaskPackSurface> = {}): TaskPackSurface {
  const [start, end] = range.split("-").map(Number) as [number, number];
  let code = fields.code ?? lines(start, end);
  const appended: Array<{ marker: string; range: string }> = [];
  for (const window of windows) {
    const [ws, we] = window.range.split("-").map(Number) as [number, number];
    const marker = `\n\n/* query facet f${appended.length} (${window.range}) */\n`;
    code += marker + (window.text ?? lines(ws, we));
    appended.push({ marker, range: window.range });
  }
  return surface({ handle, range, ...fields, code, appended_windows: appended });
}

function run(result: TaskPackResult, options: Parameters<typeof applyPackContainmentDedup>[2] = {}): void {
  applyPackContainmentDedup(result, WORKSPACE, options);
}

describe("appended windows", () => {
  it("cuts every window its own surface's body already carries (the T03 shape), and the surface keeps all of its text", () => {
    const head = withWindows("hhead", "100-170", [{ range: "144-153" }, { range: "146-151" }, { range: "145-150" }, { range: "147-152" }]);
    run(pack([head]));
    expect(head.code).toBe(lines(100, 170));
    expect(head.appended_windows).toBeUndefined();
    for (const range of ["144-153", "146-151", "145-150", "147-152"]) {
      const [s, e] = range.split("-").map(Number) as [number, number];
      expect(servedSurfaceText(head)).toContain(lines(s, e));
    }
  });

  it("proves coverage on the body, not on a range that claims more than the body holds", () => {
    // T03's class head claims 45-1552 at this point with a body that ends at 270.
    const head = withWindows("hhead", "10-200", [{ range: "20-24" }, { range: "150-154" }], { code: lines(10, 60) });
    run(pack([head]));
    expect(head.appended_windows?.map((window) => window.range)).toEqual(["150-154"]);
    expect(head.code).toBe(`${lines(10, 60)}\n\n/* query facet f1 (150-154) */\n${lines(150, 154)}`);
  });

  it("keeps a window outside the served range, and cuts one inside that kept window", () => {
    const head = withWindows("hhead", "10-30", [{ range: "40-50" }, { range: "42-45" }]);
    run(pack([head]));
    expect(head.appended_windows?.map((window) => window.range)).toEqual(["40-50"]);
    expect(head.code).toBe(`${lines(10, 30)}\n\n/* query facet f0 (40-50) */\n${lines(40, 50)}`);
  });

  it("of two windows with one range, keeps the first", () => {
    const head = withWindows("hhead", "10-30", [{ range: "40-44" }, { range: "40-44" }]);
    run(pack([head]));
    expect(head.appended_windows?.map((window) => window.marker)).toEqual(["\n\n/* query facet f0 (40-44) */\n"]);
  });

  it("keeps a window whose lines the head admits it did not serve (remaining_ranges)", () => {
    const head = withWindows("hhead", "10-60", [{ range: "40-44" }], { remaining_ranges: ["38-46"], content_completeness: "partial" });
    const before = head.code;
    run(pack([head]));
    expect(head.code).toBe(before);
    expect(head.appended_windows?.length).toBe(1);
  });

  it("keeps a window whose text the head does not carry verbatim (an elided comment, a reformatted line)", () => {
    const head = withWindows("hhead", "10-60", [{ range: "40-44" }]);
    // The first occurrence of line 42 is the head's: it renders as an elision
    // marker there, while the window carries the raw line.
    head.code = head.code!.replace(line(42), "    /* doc elided L42-42 */");
    const before = head.code;
    run(pack([head]));
    expect(head.code).toBe(before);
  });

  it("keeps a window whose text is not exactly its range's lines", () => {
    const short = withWindows("hshort", "10-60", [{ range: "40-44", text: lines(40, 43) }]);
    const shifted = withWindows("hshifted", "10-60", [{ range: "40-44", text: lines(41, 45) }]);
    const beforeShort = short.code;
    const beforeShifted = shifted.code;
    run(pack([short]));
    run(pack([shifted]));
    expect(short.code).toBe(beforeShort);
    expect(shifted.code).toBe(beforeShifted);
  });

  it("keeps a window whose text occurs twice in its file, even when the head carries the other copy", () => {
    // The head renders lines 1-5 as an elision marker and carries the second
    // copy (11-15) raw: its body contains the window's text, but not at the
    // window's own lines.
    const source = REPEATED_SOURCE.split("\n");
    const head = surface({
      handle: "hrep",
      path: REPEATED,
      range: "1-15",
      code: ["    /* doc elided L1-5 */", ...source.slice(5, 15)].join("\n"),
    });
    const marker = "\n\n/* query facet f0 (1-5) */\n";
    head.code += marker + BLOCK.join("\n");
    head.appended_windows = [{ marker, range: "1-5" }];
    const before = head.code;
    run(pack([head]));
    expect(head.code).toBe(before);
    // Even a copy the head does carry at its own lines stays: a text its file
    // holds twice is never taken as proof of position.
    const second = surface({ handle: "hrep2", path: REPEATED, range: "6-15", code: source.slice(5, 15).join("\n") });
    second.code += "\n\n/* query facet f0 (11-15) */\n" + BLOCK.join("\n");
    second.appended_windows = [{ marker: "\n\n/* query facet f0 (11-15) */\n", range: "11-15" }];
    run(pack([second]));
    expect(second.appended_windows?.length ?? 0).toBe(1);
  });

  it("leaves an exempt surface's windows alone (a force-served caller window comes back as sent)", () => {
    const head = withWindows("hhead", "100-170", [{ range: "144-153" }]);
    const before = head.code;
    run(pack([head]), { exempt: (candidate) => candidate === head });
    expect(head.code).toBe(before);
    expect(head.appended_windows?.length).toBe(1);
  });

  it("leaves the surface as built when a recorded marker is missing from its code", () => {
    const head = withWindows("hhead", "10-60", [{ range: "40-44" }]);
    head.appended_windows = [{ marker: "\n\n/* query facet gone (40-44) */\n", range: "40-44" }];
    const before = head.code;
    run(pack([head]));
    expect(head.code).toBe(before);
    expect(head.appended_windows?.length).toBe(1);
  });
});

describe("separate surfaces", () => {
  it("gives a surface another surface of the same file carries the code_unchanged pointer, keeping its body for the proof passes", () => {
    const outer = surface({ handle: "houter", range: "100-170", code: lines(100, 170) });
    const inner = surface({ handle: "hinner", range: "144-153", code: lines(144, 153) });
    run(pack([outer, inner]));
    expect(inner.code).toBeUndefined();
    expect(inner.code_unchanged).toBe("hinner — lines 144-153 are inside houter (100-170) in this pack");
    expect(servedSurfaceText(inner)).toBe(lines(144, 153));
    expect(outer.code).toBe(lines(100, 170));
  });

  it("points at the widest container, whichever order the pack lists them in", () => {
    const inner = surface({ handle: "hinner", range: "144-153", code: lines(144, 153) });
    const middle = surface({ handle: "hmiddle", range: "140-160", code: lines(140, 160) });
    const outer = surface({ handle: "houter", range: "100-170", code: lines(100, 170) });
    run(pack([inner, middle, outer]));
    expect(outer.code).toBe(lines(100, 170));
    expect(middle.code_unchanged).toContain("inside houter (100-170)");
    expect(inner.code_unchanged).toContain("inside houter (100-170)");
  });

  it("of two surfaces with one range and one body, keeps the first", () => {
    const first = surface({ handle: "hfirst", range: "140-160", code: lines(140, 160) });
    const second = surface({ handle: "hsecond", range: "140-160", code: lines(140, 160) });
    run(pack([first, second]));
    expect(first.code).toBe(lines(140, 160));
    expect(second.code_unchanged).toContain("inside hfirst (140-160)");
  });

  it("never touches another file, a container with a hole there, a body the container does not carry, or a body that is not its range's lines", () => {
    const outer = surface({ handle: "houter", range: "100-170", code: lines(100, 170) });
    const otherFile = surface({ handle: "hother", path: "src/Other.java", range: "144-153", code: lines(144, 153) });
    const holed = surface({ handle: "hholed", range: "200-260", code: lines(200, 239), remaining_ranges: ["240-260"], content_completeness: "partial" });
    const inHole = surface({ handle: "hinhole", range: "245-250", code: lines(245, 250) });
    const differs = surface({ handle: "hdiffers", range: "120-125", code: `${lines(120, 124)}\n    changed();` });
    const misplaced = surface({ handle: "hmisplaced", range: "130-134", code: lines(131, 135) });
    run(pack([outer, otherFile, holed, inHole, differs, misplaced]));
    for (const kept of [otherFile, inHole, differs, misplaced]) expect(kept.code_unchanged, kept.handle).toBeUndefined();
  });

  it("never demotes a protected, exempt, required, edit-bearing, frontier, caller-named, explicit-identifier or partial surface", () => {
    const outer = surface({ handle: "houter", range: "100-170", code: lines(100, 170) });
    const inner = (handle: string, fields: Partial<TaskPackSurface> = {}): TaskPackSurface =>
      surface({ handle, range: "144-153", code: lines(144, 153), ...fields });
    const protectedOne = inner("hprotected");
    const exemptOne = inner("hexempt");
    const required = inner("hrequired", { required: true });
    const editBearing = inner("hedit", { edit_intent: "change the call" });
    const frontier = inner("hfrontier");
    const callerNamed = inner("hcaller", { why: "caller-supplied" });
    const queryNamed = inner("hnamed", { why: "query-named-file" });
    const explicit = inner("hexplicit", { why: "answer-explicit-symbol-focus" });
    const anchor = inner("hanchor", { why: "explicit-identifier-anchor" });
    const partial = inner("hpartial", { content_completeness: "partial", remaining_ranges: ["153-153"] });
    const result = pack([outer, protectedOne, exemptOne, required, editBearing, frontier, callerNamed, queryNamed, explicit, anchor, partial], {
      execution_contract: { readiness_certificate: { action_frontier: ["hfrontier"] } } as unknown as TaskPackResult["execution_contract"],
    });
    run(result, { protectedSurfaces: new Set([protectedOne]), exempt: (candidate) => candidate === exemptOne });
    for (const kept of [protectedOne, exemptOne, required, editBearing, frontier, callerNamed, queryNamed, explicit, anchor, partial]) {
      expect(kept.code_unchanged, kept.handle).toBeUndefined();
      expect(kept.code, kept.handle).toBe(lines(144, 153));
    }
  });

  it("keeps a body shorter than the pointer that would replace it", () => {
    const outer = surface({ handle: "houter", range: "100-170", code: lines(100, 170) });
    const tiny = surface({ handle: "htiny", range: "150-150", code: line(150) });
    run(pack([outer, tiny]));
    expect(tiny.code).toBe(line(150));
  });

  it("does nothing to a pack_unchanged receipt", () => {
    const outer = surface({ handle: "houter", range: "100-170", code: lines(100, 170) });
    const inner = surface({ handle: "hinner", range: "144-153", code: lines(144, 153) });
    run(pack([outer, inner], { pack_unchanged: true }));
    expect(inner.code).toBe(lines(144, 153));
  });
});
