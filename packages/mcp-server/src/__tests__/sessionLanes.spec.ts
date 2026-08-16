import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TaskExecutionContract } from "@tokenlighten/types";

import {
  getExecutionFence,
  getSession,
  guardExecutionDiscovery,
  otherActiveRoots,
  recordExecutionContract,
  recordReadMode,
  resetAll,
  runWithSessionLane,
  type WorkspaceSession,
} from "../util/session.js";

/**
 * Concurrent-agent session lanes (2026-08-07).
 *
 * A stdio MCP connection carries no per-call client identity, so when an
 * orchestrator multiplexes several agents over ONE server process against the
 * SAME workspace root, every agent used to share one WorkspaceSession: agent
 * A's verifying fence refused agent B's calls by name, B's taskEpoch:"new"
 * silently destroyed A's verify obligation, and served-range receipts claimed
 * "already in your context" for bytes only the OTHER agent held. Isolation is
 * therefore explicit and cooperative: each agent passes its own fixed `lane`
 * value, and lanes share nothing. Omitting `lane` preserves the historical
 * single-session behavior byte-for-byte.
 */

/** Self-contained ready contract, one certificate per (id, handle, path). */
function laneCert(
  certificateId: string,
  handle: string,
  filePath: string,
): TaskExecutionContract {
  return {
    version: 1,
    state: "ready",
    readiness: "edit-ready",
    discovery_complete: true,
    next_action: "edit",
    max_additional_discovery_calls: 0,
    reason: "test proof",
    readiness_certificate: {
      version: 1,
      id: certificateId,
      task_fingerprint: `task-${certificateId}`,
      profile: "change_propagation",
      obligations: [{
        id: "behavior-body",
        kind: "behavior-body",
        status: "proved",
        required: true,
        evidence: [{ handle, path: filePath, range: "1-20", symbol: "fn" }],
        reason: "callable body served",
      }],
      evidence_handles: [handle],
      action_frontier: [handle],
      falsification: { version: 1, checked: ["callable-body"], counterexamples: [], unresolved: [] },
      risk: {
        policy: "selective-reject",
        estimated_false_ready_risk: 0.01,
        max_false_ready_risk: 0.05,
        decision: "accept",
        factors: [],
      },
    },
    typestate: {
      phase: "prepared",
      certificate_id: certificateId,
      allowed_actions: ["edit", "challenge"],
      challenge_required_for: ["read", "search"],
    },
    call_budget: {
      version: 2,
      policy: "expected-decision-change",
      normalized_turn_cost: 0.18,
      expected_decision_change: 0.01,
      expected_value: 0.011,
      decision_threshold: 0.18,
      discovery_allowed: false,
      terminal_action: "edit",
      reason: "low value",
    },
  };
}

afterEach(() => resetAll());

/** callTool's MCP result, loosened: isError is present only on refusal branches. */
interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}

describe("concurrent-agent session lanes: state partitioning", () => {
  it("getSession partitions by lane; the empty lane is the default session", () => {
    const ROOT = "/workspace/lanes-partition";
    const base = getSession(ROOT);
    const a = runWithSessionLane("agent-a", () => getSession(ROOT));
    const b = runWithSessionLane("agent-b", () => getSession(ROOT));

    expect(a).not.toBe(base);
    expect(b).not.toBe(base);
    expect(a).not.toBe(b);
    // Stable per lane, and "" is exactly the default session.
    expect(runWithSessionLane("agent-a", () => getSession(ROOT))).toBe(a);
    expect(runWithSessionLane("", () => getSession(ROOT))).toBe(base);

    runWithSessionLane("agent-a", () => recordReadMode(ROOT, "slice"));
    expect(a.readsByMode.get("slice")).toBe(1);
    expect(base.readsByMode.get("slice")).toBeUndefined();
    expect(b.readsByMode.get("slice")).toBeUndefined();
  });

  it("one lane's execution fence never gates another lane (the observed mixing incident)", () => {
    const ROOT = "/workspace/lanes-fence";
    runWithSessionLane("agent-b", () =>
      recordExecutionContract(ROOT, "wire pack builder output", laneCert("cert-b", "h-b", "src/pack_builder.ts")));
    expect(runWithSessionLane("agent-b", () => getExecutionFence(ROOT))?.certificateId).toBe("cert-b");

    // Agent A holds no fence: its discovery is unfenced and unrefused.
    expect(runWithSessionLane("agent-a", () => getExecutionFence(ROOT))).toBeUndefined();
    const decision = runWithSessionLane("agent-a", () =>
      guardExecutionDiscovery(ROOT, "read_file", { mode: "slice", handle: "h-a" }));
    expect(decision.allowed).toBe(true);

    // The lane-less default session is untouched by either agent.
    expect(getExecutionFence(ROOT)).toBeUndefined();
  });

  it("taskEpoch:new resets only its own lane, never another agent's obligations", () => {
    const ROOT = "/workspace/lanes-epoch";
    runWithSessionLane("agent-b", () =>
      recordExecutionContract(ROOT, "task b", laneCert("cert-b2", "h-b2", "src/b2.ts")));

    const reset = runWithSessionLane("agent-a", () =>
      guardExecutionDiscovery(ROOT, "read_file", { taskEpoch: "new", query: "totally different task" }));
    expect(reset).toEqual({ allowed: true, resetForNewTask: true });

    expect(runWithSessionLane("agent-b", () => getExecutionFence(ROOT))?.certificateId).toBe("cert-b2");
  });

  it("one lane's replacement pack cannot displace another lane's certificate", () => {
    const ROOT = "/workspace/lanes-replace";
    runWithSessionLane("agent-b", () =>
      recordExecutionContract(ROOT, "task b", laneCert("cert-b3", "h-b3", "src/b3.ts")));
    runWithSessionLane("agent-a", () =>
      recordExecutionContract(ROOT, "task a", laneCert("cert-a3", "h-a3", "src/a3.ts")));

    expect(runWithSessionLane("agent-b", () => getExecutionFence(ROOT))?.certificateId).toBe("cert-b3");
    expect(runWithSessionLane("agent-a", () => getExecutionFence(ROOT))?.certificateId).toBe("cert-a3");
  });

  it("otherActiveRoots reports plain roots, deduped across lanes, never composite keys", () => {
    const ROOT_X = "/workspace/lanes-roots-x";
    const ROOT_Y = "/workspace/lanes-roots-y";
    runWithSessionLane("agent-a", () => getSession(ROOT_X));
    runWithSessionLane("agent-b", () => getSession(ROOT_X));
    getSession(ROOT_Y);

    expect(otherActiveRoots(ROOT_X)).toEqual([ROOT_Y]);
    // Two lanes of ROOT_X collapse to ONE root entry, and no key leaks a
    // lane marker into what callTool prints as cwd candidates.
    expect(otherActiveRoots(ROOT_Y)).toEqual([ROOT_X]);
  });
});

describe("concurrent-agent session lanes: callTool dispatch", () => {
  it("read_file with lane lands its session state in that lane only", async () => {
    // An arbitrary tmpdir is not an admissible cwd (root containment allows
    // only the pinned workspace / registered worktrees), so this exercises
    // the pinned root itself — exactly the shared-root topology the mixing
    // incident had.
    const resolved = realpathSync(process.cwd());

    const { callTool } = await import("../server.js");
    const result = await callTool("read_file", { path: "package.json", mode: "full", lane: "agent-a" }) as ToolResult;
    expect(result.isError, result.content[0]!.text).not.toBe(true);

    // Mode-agnostic session footprint: which counters a given read mode
    // updates is that mode's business — the lane pin is only that the call
    // left SOME footprint in its own lane and NONE in the default session.
    const footprint = (s: WorkspaceSession): number =>
      s.readsByMode.size + s.servedRangeLedger.size + s.fullExpansionsPerPath.size + s.readPaths.size;
    const laneSession = runWithSessionLane("agent-a", () => getSession(resolved));
    const defaultSession = getSession(resolved);
    expect(footprint(laneSession)).toBeGreaterThan(0);
    expect(footprint(defaultSession)).toBe(0);
  });

  it("edit_file accepts lane as a declared argument (never unknown-arguments)", async () => {
    const ws = mkdtempSync(path.join(tmpdir(), "tl-lanes-"));
    writeFileSync(path.join(ws, "alpha.txt"), "hello lane\n");
    const resolved = realpathSync(ws);

    const { callTool } = await import("../server.js");
    const result = await callTool("edit_file", {
      path: "alpha.txt",
      search: "hello",
      replace: "goodbye",
      cwd: resolved,
      lane: "agent-a",
    }) as ToolResult;
    const body = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
    // Write gating may refuse for its own reasons in this process; the pin is
    // only that a declared partition key is never "unknown".
    expect(body["reason"]).not.toBe("unknown-arguments");
  });

  it("a malformed lane is refused before it can fragment session state", async () => {
    const ws = mkdtempSync(path.join(tmpdir(), "tl-lanes-"));
    writeFileSync(path.join(ws, "alpha.txt"), "hello lane\n");
    const resolved = realpathSync(ws);

    const { callTool } = await import("../server.js");
    for (const badLane of [7, { agent: "a" }, "x".repeat(65)]) {
      const result = await callTool("read_file", { path: "alpha.txt", cwd: resolved, lane: badLane }) as ToolResult;
      expect(result.isError).toBe(true);
      const body = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
      expect(body["code"]).toBe("invalid-lane");
    }
    // A refused partition key must leave no session behind under any lane.
    expect(getSession(resolved).readsByMode.size).toBe(0);
  });
});
