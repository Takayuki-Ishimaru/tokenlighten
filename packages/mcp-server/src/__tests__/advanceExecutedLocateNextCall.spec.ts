// advanceExecutedLocateNextCall.spec.ts — P1-b (2026-08-28 review-fix wave)
// fixtures for the no-repeat generalization in readCodeTaskPack.ts.
//
// Pre-wave, `advanceExecutedLocateNextCall` bailed with `if (ncArgs["action"]
// !== "locate") return "kept";` — a bare passthrough that let find/references/
// tree re-propose an already-answered search forever, while locate alone got
// the no-repeat protection. This pins the generalized behavior directly
// against the function (exported for this purpose, matching the existing
// precedent of exporting `repairSuppressedNextCall` for the same reason),
// and pins the DELIBERATE narrowing back to locate-only at the receipt call
// site (see compactReceiptFromRecord's own comment for why: `read.task_pack`'s
// wire projector never ships a top-level `missing[]`, so a new disclosure
// synthesized there has no wire channel).

import { beforeEach, describe, expect, it } from "vitest";
import type { TaskExecutionContract } from "@tokenlighten/types";
import {
  advanceExecutedLocateNextCall,
  GENERALIZED_NO_REPEAT_ACTIONS,
  LOCATE_ONLY_NO_REPEAT_ACTIONS,
} from "../features/task-pack/readCodeTaskPack.js";
import { recordExecutedSearch, resetPackServeLogForTest } from "../util/packServeLog.js";

function contractFor(action: string, extra: Record<string, unknown>): TaskExecutionContract {
  return {
    version: 1,
    state: "discovery",
    discovery_complete: false,
    next_action: "followup",
    max_additional_discovery_calls: 1,
    reason: "test contract",
    workspace_state: { fingerprint: "x", inventory_complete: true },
    typestate: { phase: "discovery", allowed_actions: [], challenge_required_for: [] },
    next_call: { tool: "search_files", arguments: { action, ...extra } },
  } as unknown as TaskExecutionContract;
}

const WORKSPACE = "/tmp/tl-advance-locate-test";

describe("advanceExecutedLocateNextCall generalization (P1-b)", () => {
  beforeEach(resetPackServeLogForTest);

  it("suppresses a repeated find/references/tree next under the default (generalized) action set", () => {
    for (const [action, extra] of [
      ["find", { query: "REFUNDED" }],
      ["references", { query: "REFUNDED" }],
      ["tree", { path: "src" }],
    ] as const) {
      recordExecutedSearch(WORKSPACE, action, action === "tree" ? "src" : "REFUNDED", []);
      const contract = contractFor(action, extra);
      const outcome = advanceExecutedLocateNextCall(WORKSPACE, contract);
      expect(outcome, action).toBe("suppressed");
      expect(contract.next_call, action).toBeUndefined();
      expect(contract.reason, action).toContain("already ran this session");
    }
  });

  it("keeps a find/references/tree next unaffected when restricted to LOCATE_ONLY_NO_REPEAT_ACTIONS (the receipt call site's scope)", () => {
    for (const [action, extra] of [
      ["find", { query: "REFUNDED" }],
      ["references", { query: "REFUNDED" }],
      ["tree", { path: "src" }],
    ] as const) {
      recordExecutedSearch(WORKSPACE, action, action === "tree" ? "src" : "REFUNDED", []);
      const contract = contractFor(action, extra);
      const outcome = advanceExecutedLocateNextCall(WORKSPACE, contract, LOCATE_ONLY_NO_REPEAT_ACTIONS);
      expect(outcome, action).toBe("kept");
      expect(contract.next_call, action).toBeDefined();
    }
  });

  it("still advances a repeated locate to a batched read under either action set (unchanged pre-wave behavior)", () => {
    for (const allowed of [GENERALIZED_NO_REPEAT_ACTIONS, LOCATE_ONLY_NO_REPEAT_ACTIONS]) {
      recordExecutedSearch(WORKSPACE, "locate", "computeTotal", ["h1", "h2"]);
      const contract = contractFor("locate", { query: "computeTotal" });
      const outcome = advanceExecutedLocateNextCall(WORKSPACE, contract, allowed);
      expect(outcome).toBe("advanced");
      expect(contract.next_call).toEqual({ tool: "read_file", arguments: { handles: ["h1", "h2"] } });
    }
  });

  it("still suppresses a repeated locate with zero candidates under either action set (unchanged pre-wave behavior)", () => {
    for (const allowed of [GENERALIZED_NO_REPEAT_ACTIONS, LOCATE_ONLY_NO_REPEAT_ACTIONS]) {
      recordExecutedSearch(WORKSPACE, "locate", "missingSymbol", []);
      const contract = contractFor("locate", { query: "missingSymbol" });
      const outcome = advanceExecutedLocateNextCall(WORKSPACE, contract, allowed);
      expect(outcome).toBe("suppressed");
      expect(contract.next_call).toBeUndefined();
    }
  });

  it("keeps (does not suppress) a find/references/tree next that has never run this session", () => {
    for (const [action, extra] of [
      ["find", { query: "NEVER_RAN" }],
      ["references", { query: "NEVER_RAN" }],
      ["tree", { path: "never/ran" }],
    ] as const) {
      const contract = contractFor(action, extra);
      const outcome = advanceExecutedLocateNextCall(WORKSPACE, contract);
      expect(outcome, action).toBe("kept");
      expect(contract.next_call, action).toBeDefined();
    }
  });

  it("never advances find/references/tree to a batched-handle read even when candidates were recorded (no handle affordance to back it)", () => {
    for (const [action, extra] of [
      ["find", { query: "REFUNDED" }],
      ["references", { query: "REFUNDED" }],
    ] as const) {
      // A find/references caller could in principle pass a non-empty candidate
      // list to recordExecutedSearch; the function must still SUPPRESS, never
      // fabricate a `read_file handles=[...]` next these actions cannot back.
      recordExecutedSearch(WORKSPACE, action, "REFUNDED", ["would-be-handle"]);
      const contract = contractFor(action, extra);
      const outcome = advanceExecutedLocateNextCall(WORKSPACE, contract);
      expect(outcome, action).toBe("suppressed");
      expect(contract.next_call, action).toBeUndefined();
    }
  });
});
