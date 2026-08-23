// priorPackStore.spec.ts — V11-03 task-scoped prior-pack obligation memory.
//
// Pure in-process state, no I/O. Mirrors packServeLog.spec.ts's conventions
// (epoch-token-overlap gating, FIFO bound, resetForTest isolation) since
// priorPackStore.ts is deliberately styled after packServeLog.ts.

import { describe, it, expect, beforeEach } from "vitest";
import {
  recordPriorPackObligations,
  queryPriorPackObligations,
  clearPriorPackObligations,
  resetPriorPackStoreForTest,
  type PriorObligationRecord,
} from "../features/task-pack/priorPackStore.js";

const WS = "/tmp/prior-pack-store-fixture";

function obligation(over: Partial<PriorObligationRecord> & { id: string }): PriorObligationRecord {
  return {
    path: `src/${over.id}.ts`,
    role: "domain",
    kind: "implementation",
    action: "edit",
    required: true,
    open: true,
    ...over,
  };
}

beforeEach(() => {
  resetPriorPackStoreForTest();
});

describe("priorPackStore — record/query round trip", () => {
  it("returns [] before anything is recorded", () => {
    expect(queryPriorPackObligations(WS, ["tok"])).toEqual([]);
  });

  it("round-trips a recorded obligation under an overlapping epoch", () => {
    recordPriorPackObligations(WS, ["fix", "checksum"], [obligation({ id: "o1" })]);
    const out = queryPriorPackObligations(WS, ["checksum"]);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("o1");
  });

  it("preserves the recorded shape verbatim", () => {
    const rec = obligation({ id: "o1", path: "src/x.ts", role: "api", kind: "integration", action: "review", required: false, open: true });
    recordPriorPackObligations(WS, ["tok"], [rec]);
    expect(queryPriorPackObligations(WS, ["tok"])).toEqual([rec]);
  });

  it("is idempotent per obligation id: a later record replaces the earlier one, order preserved", () => {
    recordPriorPackObligations(WS, ["tok"], [obligation({ id: "o1", path: "src/first.ts" })]);
    recordPriorPackObligations(WS, ["tok"], [obligation({ id: "o1", path: "src/second.ts" })]);
    const out = queryPriorPackObligations(WS, ["tok"]);
    expect(out).toHaveLength(1);
    expect(out[0]!.path).toBe("src/second.ts");
  });

  it("accumulates obligations across several calls in the SAME task epoch", () => {
    recordPriorPackObligations(WS, ["fix", "checksum"], [obligation({ id: "o1" })]);
    recordPriorPackObligations(WS, ["checksum", "parser"], [obligation({ id: "o2" })]);
    const out = queryPriorPackObligations(WS, ["parser"]);
    expect(out.map((o) => o.id).sort()).toEqual(["o1", "o2"]);
  });

  it("preserves insertion order (oldest first)", () => {
    recordPriorPackObligations(WS, ["tok"], [obligation({ id: "o1" }), obligation({ id: "o2" })]);
    recordPriorPackObligations(WS, ["tok"], [obligation({ id: "o3" })]);
    expect(queryPriorPackObligations(WS, ["tok"]).map((o) => o.id)).toEqual(["o1", "o2", "o3"]);
  });
});

describe("priorPackStore — task-epoch isolation", () => {
  it("a non-overlapping epoch sees nothing from the prior task", () => {
    recordPriorPackObligations(WS, ["fix", "checksum"], [obligation({ id: "o1" })]);
    expect(queryPriorPackObligations(WS, ["totally", "unrelated"])).toEqual([]);
  });

  it("recording under a non-overlapping epoch resets the log (new task, clean slate)", () => {
    recordPriorPackObligations(WS, ["fix", "checksum"], [obligation({ id: "o1" })]);
    recordPriorPackObligations(WS, ["totally", "unrelated"], [obligation({ id: "o2" })]);
    const out = queryPriorPackObligations(WS, ["unrelated"]);
    expect(out.map((o) => o.id)).toEqual(["o2"]);
  });

  it("empty epoch tokens on both sides never trigger the overlap gate (query returns whatever is stored)", () => {
    recordPriorPackObligations(WS, [], [obligation({ id: "o1" })]);
    expect(queryPriorPackObligations(WS, []).map((o) => o.id)).toEqual(["o1"]);
  });
});

describe("priorPackStore — clear and per-workspace isolation", () => {
  it("clearPriorPackObligations drops everything for that workspace", () => {
    recordPriorPackObligations(WS, ["tok"], [obligation({ id: "o1" })]);
    clearPriorPackObligations(WS);
    expect(queryPriorPackObligations(WS, ["tok"])).toEqual([]);
  });

  it("clearing an never-recorded workspace is a harmless no-op", () => {
    expect(() => clearPriorPackObligations("/tmp/never-touched")).not.toThrow();
  });

  it("two workspaces never see each other's obligations", () => {
    recordPriorPackObligations(WS, ["tok"], [obligation({ id: "o1" })]);
    expect(queryPriorPackObligations("/tmp/other-workspace", ["tok"])).toEqual([]);
  });
});

describe("priorPackStore — bounded FIFO eviction", () => {
  it("evicts the OLDEST entries once the tracked count exceeds the bound", () => {
    const many: PriorObligationRecord[] = Array.from({ length: 300 }, (_, i) => obligation({ id: `o${i}` }));
    recordPriorPackObligations(WS, ["tok"], many);
    const out = queryPriorPackObligations(WS, ["tok"]);
    expect(out.length).toBeLessThan(300);
    expect(out.some((o) => o.id === "o0")).toBe(false); // the oldest was evicted
    expect(out.some((o) => o.id === "o299")).toBe(true); // the newest survives
  });
});

describe("priorPackStore — resetPriorPackStoreForTest", () => {
  it("clears ALL workspaces", () => {
    recordPriorPackObligations(WS, ["tok"], [obligation({ id: "o1" })]);
    recordPriorPackObligations("/tmp/other-workspace", ["tok"], [obligation({ id: "o2" })]);
    resetPriorPackStoreForTest();
    expect(queryPriorPackObligations(WS, ["tok"])).toEqual([]);
    expect(queryPriorPackObligations("/tmp/other-workspace", ["tok"])).toEqual([]);
  });
});
