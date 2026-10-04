/**
 * checkEvidenceOriginality.spec.ts — unit-level coverage for the V07
 * originality checker (external v0.14.3 evaluation, 2026-09-27 §6.2, finding
 * #17), isolated from the full `evaluation0927.acceptance.spec.ts` scenario
 * (which needs a real dev server per chain). No server: this checker reads
 * only a plain object shaped like a `ChainResult` plus real files on disk.
 *
 * Finding #17: the checker required a served `body` to cover the WHOLE
 * `range`, so a body that legitimately SHEDS an in-range sub-window — and
 * discloses that honestly via the wire's `remaining` field (`Evidence.remaining`,
 * `protocol.ts`: "Unserved windows of THIS handle") — was flagged as
 * fabricated. The fix compares the body against range MINUS any in-range
 * `remaining` windows (the multi-span convention), elision markers still
 * excepted exactly as before.
 */
import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { checkEvidenceOriginality } from "./helpers/evaluation0927Scenarios.js";
import type { ChainResult, Hop } from "./helpers/qualityFirstScenarios.js";

const workspaceDirs = new Set<string>();

afterEach(() => {
  for (const dir of workspaceDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  workspaceDirs.clear();
});

function mkWorkspace(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), ".tl-v07-")));
  workspaceDirs.add(dir);
  return dir;
}

/** 20 numbered lines: "line 1" .. "line 20", real content on disk. */
const NUMBERED_LINES = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);

function writeNumberedFile(ws: string): string {
  const rel = "src/numbered.ts";
  const abs = path.join(ws, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, NUMBERED_LINES.join("\n") + "\n");
  return rel;
}

/** One hop carrying exactly one evidence item. */
function chainOf(evidence: Array<Record<string, unknown>>): ChainResult {
  const hop: Hop = { hopIndex: 0, call: { tool: "tl_read_file", arguments: {} }, response: { evidence }, textBytes: 0, nextSource: "none" };
  return { hops: [hop], final: hop.response, capped: false };
}

describe("checkEvidenceOriginality — multi-span (range minus remaining) convention", () => {
  it("no violation: a body that sheds an in-range window it discloses via remaining", () => {
    const ws = mkWorkspace();
    const rel = writeNumberedFile(ws);
    // range 1-10, but lines 4-6 are withheld and disclosed as `remaining` — the
    // body therefore carries lines 1-3 and 7-10 only.
    const body = [...NUMBERED_LINES.slice(0, 3), ...NUMBERED_LINES.slice(6, 10)].join("\n");
    const chain = chainOf([{ path: rel, range: "1-10", remaining: ["4-6"], body, why: "test" }]);

    expect(checkEvidenceOriginality(chain, ws, "t")).toEqual([]);
  });

  it("no violation: several disjoint remaining windows subtracted at once", () => {
    const ws = mkWorkspace();
    const rel = writeNumberedFile(ws);
    // range 1-15 minus remaining ["2-3", "10-12"] -> served lines 1,4-9,13-15.
    const served = [1, 4, 5, 6, 7, 8, 9, 13, 14, 15];
    const body = served.map((n) => NUMBERED_LINES[n - 1]).join("\n");
    const chain = chainOf([{ path: rel, range: "1-15", remaining: ["2-3", "10-12"], body }]);

    expect(checkEvidenceOriginality(chain, ws, "t")).toEqual([]);
  });

  it("still flags a body that is shorter than range with NO remaining disclosed (regression control: the check must not go toothless)", () => {
    const ws = mkWorkspace();
    const rel = writeNumberedFile(ws);
    const body = NUMBERED_LINES.slice(0, 5).join("\n"); // only 5 of 10 claimed lines, nothing disclosed
    const chain = chainOf([{ path: rel, range: "1-10", body }]);

    const violations = checkEvidenceOriginality(chain, ws, "t");
    expect(violations).toHaveLength(1);
    expect(violations[0]!.reason).toContain("not verbatim source");
  });

  it("still flags a body with genuinely wrong content inside a disclosed remaining window's complement", () => {
    const ws = mkWorkspace();
    const rel = writeNumberedFile(ws);
    // range 1-10 minus remaining 4-6 should serve lines 1-3,7-10 verbatim; this body instead
    // fabricates line 2's content while still claiming the same shape.
    const served = [...NUMBERED_LINES.slice(0, 3), ...NUMBERED_LINES.slice(6, 10)];
    served[1] = "FABRICATED";
    const chain = chainOf([{ path: rel, range: "1-10", remaining: ["4-6"], body: served.join("\n") }]);

    const violations = checkEvidenceOriginality(chain, ws, "t");
    expect(violations).toHaveLength(1);
    expect(violations[0]!.firstDifferingLine).toBe(2);
  });

  it("a remaining window outside range, or malformed, is ignored rather than crashing or over-crediting", () => {
    const ws = mkWorkspace();
    const rel = writeNumberedFile(ws);
    // remaining names a window OUTSIDE 1-5 and a malformed entry; neither should excuse anything
    // inside 1-5, so the full 1-5 body is still required verbatim.
    const body = NUMBERED_LINES.slice(0, 5).join("\n");
    const chain = chainOf([{ path: rel, range: "1-5", remaining: ["50-60", "not-a-range"], body }]);

    expect(checkEvidenceOriginality(chain, ws, "t")).toEqual([]);
  });

  it("remaining that covers the WHOLE range means an empty body is honest, not a violation", () => {
    const ws = mkWorkspace();
    const rel = writeNumberedFile(ws);
    const chain = chainOf([{ path: rel, range: "1-5", remaining: ["1-5"], body: "" }]);

    expect(checkEvidenceOriginality(chain, ws, "t")).toEqual([]);
  });

  it("composes with elision markers: an elided sub-window inside the served (range minus remaining) portion", () => {
    const ws = mkWorkspace();
    const rel = writeNumberedFile(ws);
    // range 1-10 minus remaining 8-10 -> served portion is lines 1-7; within that,
    // lines 3-5 are collapsed by an inline elision marker instead of being withheld.
    // Marker format is single-"L" (`L<start>-<end>`) — server.ts's own generator
    // regex (`/^(?:\/\* doc elided L\d+-\d+ \*\/|...)$/`), not `L<start>-L<end>`.
    const body = [
      NUMBERED_LINES[0], NUMBERED_LINES[1],
      "/* doc elided L3-5 */",
      NUMBERED_LINES[5], NUMBERED_LINES[6],
    ].join("\n");
    const chain = chainOf([{ path: rel, range: "1-10", remaining: ["8-10"], body }]);

    expect(checkEvidenceOriginality(chain, ws, "t")).toEqual([]);
  });
});
