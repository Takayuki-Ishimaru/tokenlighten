import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { callTool } from "../server.js";
import { projectLeanExecutionContract } from "../util/leanExecutionContract.js";
import type { TaskExecutionContract } from "@tokenlighten/types";

const roots: string[] = [];
const savedLeanFlag = process.env["TL_LEAN_CONTRACT"];

function workspace(tag: string): string {
  const root = fs.mkdtempSync(path.join(os.homedir(), `.tl-lean-${tag}-`));
  roots.push(root);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"lean-fixture"}\n');
  fs.writeFileSync(
    path.join(root, "src", "order.ts"),
    "export class QuoteOrchestrator {\n  transition(state: string) { return state.trim(); }\n}\n",
  );
  return root;
}

/**
 * A representative RICH prepared contract — the projection's INPUT shape.
 *
 * D10 (2026-08-14): this is the only place the rich shape still exists for
 * comparison, because it no longer reaches the wire under any flag value.
 */
function preparedContract(): TaskExecutionContract {
  return {
    version: 1,
    state: "ready",
    readiness: "answer-ready",
    discovery_complete: true,
    next_action: "answer",
    max_additional_discovery_calls: 0,
    reason: "required surfaces are served",
    readiness_certificate: {
      id: "cert-prepared-0001",
      task_fingerprint: "fp-quote-orchestrator-transition",
      workspace_state_fingerprint: "ws-0001",
      profile: "answer",
      evidence_handles: ["h1", "h2"],
      obligations: [
        {
          id: "surface-content",
          kind: "surface",
          status: "proved",
          required: true,
          evidence: ["h1"],
          reason: "served in this pack",
        },
      ],
      action_frontier: ["h1"],
      falsification: { version: 1, checked: ["required-surface-content"], counterexamples: [], unresolved: [] },
      risk: { policy: "selective-reject", estimated_false_ready_risk: 0.01, max_false_ready_risk: 0.05, decision: "accept", factors: [] },
    },
    falsification: { version: 1, checked: ["required-surface-content"], counterexamples: [], unresolved: [] },
    readiness_risk: { policy: "selective-reject", estimated_false_ready_risk: 0.01, max_false_ready_risk: 0.05, decision: "accept", factors: [] },
    typestate: { phase: "prepared", allowed_actions: ["answer", "challenge"], certificate_id: "cert-prepared-0001", challenge_required_for: [] },
    call_budget: { version: 2, policy: "expected-decision-change", normalized_turn_cost: 0.18, expected_decision_change: 0.02, expected_value: 0.0036, decision_threshold: 0.18, discovery_allowed: false, terminal_action: "answer", reason: "closed" },
    semantic_closure: { version: 1, state: "closed", closure_id: "closed-0001", obligations_total: 1, obligations_proved: 1, unresolved: [] },
  } as unknown as TaskExecutionContract;
}

function body(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  if (savedLeanFlag === undefined) delete process.env["TL_LEAN_CONTRACT"];
  else process.env["TL_LEAN_CONTRACT"] = savedLeanFlag;
});

describe("v0.10 lean execution contract", () => {
  it("projects discovery and awaiting-input decisions without audit arithmetic", () => {
    const discovery = {
      version: 1,
      state: "needs-followup",
      readiness: "needs-followup",
      discovery_complete: false,
      next_action: "followup",
      max_additional_discovery_calls: 1,
      reason: "surface content missing",
      falsification: { version: 1, checked: ["required-surface-content"], counterexamples: [], unresolved: ["surface-content"] },
      readiness_risk: { policy: "selective-reject", estimated_false_ready_risk: 1, max_false_ready_risk: 0.05, decision: "reject", factors: ["uncovered-required-obligation"] },
      typestate: { phase: "discovery", allowed_actions: ["read", "search"], challenge_required_for: [] },
      call_budget: { version: 2, policy: "expected-decision-change", normalized_turn_cost: 0.18, expected_decision_change: 0.72, expected_value: 0.972, decision_threshold: 0.18, discovery_allowed: true, terminal_action: "edit", reason: "valuable" },
      next_call: { tool: "read_file", arguments: { handle: "h4" } },
    } as TaskExecutionContract;

    expect(projectLeanExecutionContract(discovery)).toEqual({
      phase: "discovery",
      unresolved: ["surface-content"],
      allowed: ["read", "search"],
      next_call: { tool: "read_file", arguments: { handle: "h4" } },
    });

    const invalidWriteContinuation = {
      ...discovery,
      next_call: { tool: "edit_file", arguments: { handle: "h5" } },
    } as TaskExecutionContract;
    expect(() => projectLeanExecutionContract(invalidWriteContinuation)).toThrow(
      "discovery execution contract has a non-read-only next_call: edit_file",
    );

    const awaiting = {
      ...discovery,
      next_action: "request-user-input",
      max_additional_discovery_calls: 0,
      reason: "two candidates remain",
      typestate: { phase: "awaiting-input", allowed_actions: ["request-user-input"], challenge_required_for: [] },
      next_call: undefined,
    } as TaskExecutionContract;
    expect(projectLeanExecutionContract(awaiting)).toEqual({
      phase: "awaiting-input",
      reason: "two candidates remain",
      unresolved: ["surface-content"],
      allowed: ["request-user-input"],
    });
  });

  it("projects a done-phase contract instead of throwing (P0a latent-crash regression)", () => {
    // canonicalDecision's terminal-closed branch is the ONLY producer of
    // phase "done"; such a contract is captured by captureServedPack and can
    // be restored on a later cache/qref hit, which lands right here. The
    // pre-P0a projection threw `unsupported task-pack execution phase: done`,
    // surfacing as an uncaught RPC internal error on a cache hit.
    const done = {
      version: 1,
      state: "ready",
      readiness: "answer-ready",
      discovery_complete: true,
      next_action: "answer",
      max_additional_discovery_calls: 0,
      reason: "semantic closure receipt is closed",
      typestate: { phase: "done", allowed_actions: ["answer"], challenge_required_for: [] },
      semantic_closure: {
        version: 1,
        state: "closed",
        closure_id: "closed-restored",
        obligations_total: 1,
        obligations_proved: 1,
        unresolved: [],
      },
    } as unknown as TaskExecutionContract;

    expect(() => projectLeanExecutionContract(done)).not.toThrow();
    expect(projectLeanExecutionContract(done)).toEqual({
      phase: "done",
      unresolved: [],
      allowed: ["answer"],
      semantic_closure: { state: "closed" },
    });
  });

  it("emits ONLY the small prepared wire projection — the rich proof never ships", async () => {
    // D10 (2026-08-14): TL_LEAN_CONTRACT is permanent-on and its reader is
    // deleted, so the rich contract can no longer be obtained from the wire at
    // all. Setting the old rollback value must not bring it back; the
    // lean-vs-rich BYTE ratio is asserted against the in-process projection
    // input instead, which is where both shapes still coexist.
    process.env["TL_LEAN_CONTRACT"] = "0";
    const lean = body(await callTool("read_file", {
      mode: "task_pack",
      query: "Explain QuoteOrchestrator transition behavior",
      symbol: "QuoteOrchestrator",
      taskProfile: "answer",
      cwd: workspace("lean"),
    }));
    expect(lean["ok"], JSON.stringify(lean)).not.toBe(false);
    // C2-3 / A.5.1 + §2.2: the wire projection is no longer an
    // `execution_contract` AT ALL — the contract dissolved into `decision` +
    // `plan`, and `read.task_pack` has no such member. The property this test
    // exists for is unchanged and gets stronger: the rich proof never ships,
    // and now neither does its lean re-encoding.
    expect(lean, JSON.stringify(lean)).not.toHaveProperty("execution_contract");
    for (const dropped of ["state", "readiness", "falsification", "readiness_risk", "call_budget", "typestate"]) {
      expect(lean, `${dropped} shipped with TL_LEAN_CONTRACT=0`).not.toHaveProperty(dropped);
    }
    // The decision the contract used to project is on the wire once, and it
    // carries the certificate identity and its obligations (A.2.4).
    const decision = lean["decision"] as Record<string, unknown>;
    expect(["act.answer", "act.edit", "done"], JSON.stringify(lean)).toContain(decision["kind"]);
    const certificate = decision["certificate"] as Record<string, unknown>;
    expect(typeof certificate["id"]).toBe("string");
    expect(certificate["obligations"]).toEqual(expect.arrayContaining(["surface-content"]));

    // The byte argument survives the move: the single decision is still a
    // small fraction of the rich proof it replaced.
    const richBytes = Buffer.byteLength(JSON.stringify(preparedContract()), "utf8");
    const leanBytes = Buffer.byteLength(JSON.stringify(decision), "utf8");
    expect(leanBytes / richBytes).toBeLessThanOrEqual(0.55);
  });
});
