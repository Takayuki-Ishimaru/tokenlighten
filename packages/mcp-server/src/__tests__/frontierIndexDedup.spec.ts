import {describe, expect, it} from "vitest";
import {omitCoveredFrontierIndex} from "../protocol/frontierIndexDedup.js";
const index = {path:"src/a.ts", handle:"a", role:"api"};
const source = {...index, range:"1-2", body:"export const a = 1;\n"};
const pack = () => ({v:1, kind:"read.task_pack", decision:{kind:"act.edit",frontier:[{path:index.path,handle:index.handle,writable:true}]}, evidence:[{...source}], frontier_index:[{...index}]});
describe("final-wire covered frontier index", () => {
  it.each(["act.edit", "act.answer"])("omits only repeated metadata at %s", kind => {
    const value = pack(); value.decision.kind = kind;
    const copy = structuredClone(value), result = omitCoveredFrontierIndex(value);
    expect(result.frontier_index).toBeUndefined(); expect(value).toEqual(copy);
    expect(result.evidence).toBe(value.evidence); expect(result.decision).toBe(value.decision);
  });
  it("preserves any unmatched, changed or extended index row", () => {
    for (const delta of [{path:"other.ts"},{handle:"b"},{role:"contract"},{symbol:"A"}]) {
      const value = {...pack(), frontier_index:[{...index,...delta}]};
      expect(omitCoveredFrontierIndex(value)).toBe(value);
    }
  });
  it("preserves index after evidence shedding or partial delivery", () => {
    for (const evidence of [[],[{...source,body:undefined}],[{...source,remaining:["3-4"]}],[{...source,partial:true}],[{...source,truncated:true}]]) {
      const value = {...pack(),evidence}; expect(omitCoveredFrontierIndex(value)).toBe(value);
    }
  });
  it("retains discovery and non-pack metadata and accepts existing prior evidence", () => {
    for (const change of [{kind:"read.receipt"},{decision:{kind:"discover"}}]) {
      const value = {...pack(),...change}; expect(omitCoveredFrontierIndex(value)).toBe(value);
    }
    expect(omitCoveredFrontierIndex({...pack(),evidence:[{...index,range:"1-2",prior:"read-1"}]}).frontier_index).toBeUndefined();
  });
});
