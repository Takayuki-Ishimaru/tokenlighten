/**
 * packSameSpanDedupe.spec.ts — one response never ships the same lines of
 * the same file twice (2026-10-29 field report: measurementEngine.ts 337-401
 * appeared twice in one task pack).
 *
 * The duplicates reached the pack under different handles (a locator symbol
 * handle and a `kind:"range"` upsert) or rendered with different comment
 * elision, so `applyPackDedupe`'s handle+range+hash match missed them.
 */

import { describe, it, expect } from "vitest";

import { applyPackDedupe } from "../features/task-pack/readCodeTaskPack.js";
import type { TaskPackResult } from "../features/task-pack/model.js";

const BODY = "export function estimate(x: number): number {\n  // rounded\n  return Math.round(x * 1.5);\n}\n";
const ELIDED = "export function estimate(x: number): number {\n  return Math.round(x * 1.5);\n}\n";

function pack(surfaces: Array<Record<string, unknown>>): TaskPackResult {
  return { surfaces } as unknown as TaskPackResult;
}

let workspaceSerial = 0;
const freshWorkspace = (): string => `/tmp/tl-same-span-${process.pid}-${++workspaceSerial}`;

describe("applyPackDedupe — identical path and range inside one pack", () => {
  it("keeps the first body when a second handle carries the same lines", () => {
    const result = pack([
      { handle: "hsym", path: "src/measurementEngine.ts", range: "337-401", code: BODY, why: "symbol" },
      { handle: "hrange", path: "src/measurementEngine.ts", range: "337-401", code: BODY, why: "range" },
    ]);
    applyPackDedupe(freshWorkspace(), result);
    const [first, second] = result.surfaces as unknown as Array<Record<string, unknown>>;
    expect(first!["code"]).toBe(BODY);
    expect(second!["code"]).toBeUndefined();
    expect(second!["code_unchanged"]).toBe("hrange — duplicate of an earlier surface in this pack");
  });

  it("also drops a differently elided rendering of the same span", () => {
    const result = pack([
      { handle: "ha", path: "src/a.ts", range: "10-13", code: BODY },
      { handle: "hb", path: "src/a.ts", range: "10-13", code: ELIDED },
    ]);
    applyPackDedupe(freshWorkspace(), result);
    const surfaces = result.surfaces as unknown as Array<Record<string, unknown>>;
    expect(surfaces.filter((s) => typeof s["code"] === "string")).toHaveLength(1);
  });

  it("keeps bodies for other ranges and other files", () => {
    const result = pack([
      { handle: "h1", path: "src/a.ts", range: "10-13", code: BODY },
      { handle: "h2", path: "src/a.ts", range: "10-12", code: ELIDED },
      { handle: "h3", path: "src/b.ts", range: "10-13", code: BODY },
    ]);
    applyPackDedupe(freshWorkspace(), result);
    const surfaces = result.surfaces as unknown as Array<Record<string, unknown>>;
    expect(surfaces.map((s) => typeof s["code"])).toEqual(["string", "string", "string"]);
  });

  it("never pointers a surface the caller exempted", () => {
    const result = pack([
      { handle: "h1", path: "src/a.ts", range: "10-13", code: BODY },
      { handle: "h2", path: "src/a.ts", range: "10-13", code: BODY, why: "caller-supplied" },
    ]);
    applyPackDedupe(freshWorkspace(), result, undefined, (surface) => surface.handle === "h2");
    const surfaces = result.surfaces as unknown as Array<Record<string, unknown>>;
    expect(surfaces.map((s) => typeof s["code"])).toEqual(["string", "string"]);
  });
});
