import {describe, expect, it} from "vitest";
import {coalesceAnswerRows} from "../features/task-pack/coalesceAnswerRows.js";
import {planStructureMap, type StructureMapType} from "../features/task-pack/structureMap.js";
describe("lossless answer row packing", () => {
  it("uses serialized UTF-8 gap bytes, keeps exact source and never mutates requirements", () => {
    const lines = Object.freeze(["call();", '"日本語\\t"', "return;"]);
    const rows = Object.freeze([Object.freeze({start: 1, end: 1}), Object.freeze({start: 3, end: 3})]);
    const owed = Object.freeze([Object.freeze({start: 2, end: 2})]);
    const cost = Buffer.byteLength(JSON.stringify("\n" + lines[1] + "\n")) - 2;
    expect(coalesceAnswerRows(lines, rows, owed, cost)).toEqual({rows: [{start: 1, end: 3}], owed: []});
    expect(coalesceAnswerRows(lines, rows, owed, cost - 1)).toEqual({rows, owed});
    expect(owed).toEqual([{start: 2, end: 2}]);
  });
  it("does not expand adjacent or overlapping rows beyond the common source cap", () => {
    const lines = Array.from({length: 14}, () => "x".repeat(1023));
    for (const rows of [[{start: 1, end: 7}, {start: 8, end: 14}], [{start: 1, end: 8}, {start: 7, end: 14}]])
      expect(coalesceAnswerRows(lines, rows, [], 1000).rows).toEqual(rows);
  });
  it("fills a partial first page without removing the unserved body suffix", () => {
    const lines = ["class Flow {", "  void run() {", ...Array.from({length: 80}, () => "    payment.send();"), "  }", "}"];
    const type: StructureMapType = {path: "Flow.java", name: "Flow", start: 1, end: lines.length, signatureStart: 1, signatureEnd: 1,
      members: [{name: "run", start: 2, end: lines.length - 1, signatureStart: 2, signatureEnd: 2, nestedType: false, constructor: false}]};
    const plan = planStructureMap(type, lines, ["payment"], 220, false);
    expect(plan.bytes).toBeLessThanOrEqual(220);
    const body = plan.windows.find(row => row.kind === "call");
    expect(body?.start).toBe(3);
    expect(body!.end).toBeLessThan(82);
    expect(plan.remaining.some(row => row.start === body!.end + 1 && row.end >= 82)).toBe(true);
  });
});
