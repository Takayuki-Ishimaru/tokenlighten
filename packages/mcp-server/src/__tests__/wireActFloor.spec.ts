/**
 * wireActFloor.spec.ts — §2.1.1's delivery floor, the demotion that keeps it
 * true, and ruling 6's two wire changes (P3a S5).
 *
 * WHAT THIS FILE IS FOR. §2.1.1 says an `act` decision may only be emitted when
 * the response it rides on carries what that action needs, and that a shed which
 * would breach a floor must produce `discover` with a non-empty `next` rather
 * than an `act` member with a shorn floor. Everything below is one clause of
 * that rule turned into a check, at the two layers the rule lives on: the
 * PROJECTOR (`decisionWire.ts`, which decides what a response may claim) and the
 * LADDER (`budget/actFloor.ts` + `budget/ladder.ts`, which re-decides it after
 * every byte the shedder removes).
 *
 * THE FAILURE THIS FILE EXISTS TO PREVENT is the 2026-08-13 fabrication-push
 * class (`44535d46`): a response asserting the client holds bytes it does not,
 * so that an LLM told to answer from a certificate it cannot read produces
 * something. F4's fix is not "warn"; it is "make the state unrepresentable".
 *
 * P13 (plan §6 constraint 3) lives here: at most ONE demotion per emission.
 *
 * RULING 6 ([R5-23] + [R5-30], adjudicated 2026-08-14) also lands here:
 *   - `create_target` is the second arm of the `act.edit` floor, and a
 *     create-only `act.edit` is emittable for the first time;
 *   - branch 3 (`grantServedTerminal` / `act-on-served-evidence`) is re-sited
 *     onto `act.*` when the floor holds and onto `discover` when it does not.
 */

import { describe, expect, it } from "vitest";

import type { TaskExecutionContract } from "@tokenlighten/types";

import { actFloorHolds, demoteToDiscover, MAX_DEMOTIONS_PER_EMISSION } from "../protocol/budget/actFloor.js";
import { runLadder } from "../protocol/budget/ladder.js";
import { validateProtocolBody } from "../protocol/budget/validate.js";
import { projectTaskDecision } from "../protocol/decisionWire.js";
import { emitFinalizedPayload } from "../protocol/emit.js";
import type { ProtocolCallContext } from "../protocol/envelope.js";

type Body = Record<string, unknown>;

function bytesOf(payload: unknown): number {
  return Buffer.byteLength(JSON.stringify(payload), "utf8");
}

/** One emission through the real funnel tail, at a chosen budget. */
function emit(payload: Body, budgetOverrideBytes: number): { body: Body; bytes: number } {
  const context: ProtocolCallContext = { tool: "read_file" };
  const result = emitFinalizedPayload(payload, "read.task_pack", context, { budgetOverrideBytes });
  const text = result.content[0]?.text ?? "";
  return { body: JSON.parse(text) as Body, bytes: Buffer.byteLength(text, "utf8") };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WORKSPACE = {
  fingerprint: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  scope: "evidence-plus-inventory",
  evidence_files: 2,
  inventory_files: 2,
  inventory_complete: true,
};

/**
 * A certified `act.answer` pack whose whole floor is its four served bodies.
 * Every entry carries `handle` + `range`, which is what rung 4 requires before
 * it will strip a body (E5: no addressing, no continuation, no shed) and what
 * the demotion then reads back to name the restoring calls.
 */
function answerPack(bodyLength = 400): Body {
  return {
    v: 1,
    kind: "read.task_pack",
    task: { id: "task-actfloor", coverage: "complete", replay: "q-actfloor" },
    profile: "answer",
    evidence: [
      { handle: "hcontract", path: "src/contract.ts", range: "1-40", role: "contract", body: "C".repeat(bodyLength) },
      { handle: "hapi", path: "src/api.ts", range: "1-40", role: "api", body: "A".repeat(bodyLength) },
      { handle: "hdoc", path: "docs/guide.md", range: "1-40", role: "doc", body: "D".repeat(bodyLength) },
      { handle: "htest", path: "src/thing.test.ts", range: "1-40", role: "test", body: "T".repeat(bodyLength) },
    ],
    decision: {
      kind: "act.answer",
      certificate: { id: "ready-actfloor", obligations: ["surface-content"], workspace: WORKSPACE },
    },
    qref: "q-actfloor",
  };
}

/** The `act.edit` counterpart, floor satisfied by a create target and NO frontier. */
function createOnlyEditPack(): Body {
  return {
    v: 1,
    kind: "read.task_pack",
    task: { id: "task-create", coverage: "focused", replay: "q-create" },
    profile: "generic",
    evidence: [
      { handle: "hsibling", path: "src/sibling.py", range: "1-20", role: "domain", body: "S".repeat(200) },
    ],
    decision: {
      kind: "act.edit",
      certificate: { id: "ready-create", obligations: ["surface-content"], workspace: WORKSPACE },
      create_target: { path: "src/new_module.py", directory_evidence: ["src/sibling.py"] },
    },
  };
}

/** A minimal branch-3 contract: `grantServedTerminal`'s token, no certificate. */
function branchThreeContract(over: Partial<TaskExecutionContract> = {}): TaskExecutionContract {
  return {
    version: 1,
    state: "needs-followup",
    readiness: "needs-followup",
    discovery_complete: false,
    next_action: "answer",
    max_additional_discovery_calls: 0,
    reason: "the selected windows of every required surface are served — act on the served evidence",
    await_input_code: "act-on-served-evidence",
    typestate: { phase: "awaiting-input", allowed_actions: ["answer", "request-user-input"], challenge_required_for: [] },
    ...over,
  } as unknown as TaskExecutionContract;
}

// ---------------------------------------------------------------------------
// 1. The floor predicate itself
// ---------------------------------------------------------------------------

describe("§2.1.1 act floor — the predicate", () => {
  it("holds on a decision with no floor: `discover`, `await_input`, `done`, and a payload with no decision at all", () => {
    // A member that makes no claim about what to do next has nothing a shed can
    // falsify. This is why at most ONE demotion per emission is structural.
    for (const decision of [
      { kind: "discover", next: { tool: "read_file", arguments: { handle: "h", range: "1-2" } } },
      { kind: "await_input", code: "no-grounded-call-remains" },
      { kind: "done" },
    ]) {
      expect(actFloorHolds({ v: 1, kind: "read.task_pack", decision }, "read.task_pack")).toBe(true);
    }
    expect(actFloorHolds({ v: 1, kind: "read.text", evidence: [] }, "read.text")).toBe(true);
  });

  it("FLOOR-ANSWER: a body OR a session `prior` satisfies it; addressing alone does not", () => {
    const withDecision = (evidence: unknown[]): Body => ({
      v: 1, kind: "read.task_pack", evidence,
      decision: { kind: "act.answer", certificate: { id: "c", obligations: ["o"], workspace: WORKSPACE } },
    });
    expect(actFloorHolds(withDecision([{ handle: "h", body: "served bytes" }]), "read.task_pack")).toBe(true);
    expect(actFloorHolds(withDecision([{ handle: "h", prior: "read_file mode=task_pack qref=q1" }]), "read.task_pack")).toBe(true);
    // The exact state rung 4 produces: addressed, body-less, `remaining`
    // populated. Honest, and NOT answerable from.
    expect(actFloorHolds(withDecision([{ handle: "h", path: "p", range: "1-9", remaining: ["1-9"] }]), "read.task_pack")).toBe(false);
    expect(actFloorHolds(withDecision([]), "read.task_pack")).toBe(false);
  });

  it("FLOOR-EDIT as amended by [R5-23]: frontier non-empty OR a create target — and NEITHER is still a breach", () => {
    const withDecision = (extra: Body): Body => ({
      v: 1, kind: "read.task_pack", evidence: [],
      decision: { kind: "act.edit", certificate: { id: "c", obligations: ["o"], workspace: WORKSPACE }, ...extra },
    });
    expect(actFloorHolds(withDecision({ frontier: [{ handle: "h", path: "p", writable: true }] }), "read.task_pack")).toBe(true);
    expect(actFloorHolds(withDecision({ create_target: { path: "src/new.py", directory_evidence: ["src/old.py"] } }), "read.task_pack")).toBe(true);
    expect(actFloorHolds(withDecision({
      frontier: [{ handle: "h", path: "p", writable: true }],
      create_target: { path: "src/new.py", directory_evidence: ["src/old.py"] },
    }), "read.task_pack")).toBe(true);
    // The pre-ruling-6 state that used to be unemittable, and the one the
    // amendment must NOT have made legal: an edit that names no place to write.
    expect(actFloorHolds(withDecision({ frontier: [] }), "read.task_pack")).toBe(false);
    expect(actFloorHolds(withDecision({}), "read.task_pack")).toBe(false);
  });

  it("the required-set validator states the SAME edit floor, so a breach is refused twice", () => {
    const body: Body = {
      v: 1, kind: "read.task_pack",
      task: { id: "t", coverage: "focused" }, profile: "generic", evidence: [],
      decision: { kind: "act.edit", certificate: { id: "c", obligations: ["o"], workspace: WORKSPACE }, frontier: [] },
    };
    const verdict = validateProtocolBody(body, "read.task_pack");
    expect(verdict.ok).toBe(false);
    expect((verdict as { violated: readonly string[] }).violated).toContain("read.task_pack/act-edit-floor");
    // ...and the create target alone clears both fences.
    const created = { ...body, decision: { ...(body["decision"] as Body), frontier: undefined, create_target: { path: "n.py", directory_evidence: ["o.py"] } } };
    expect(validateProtocolBody(created, "read.task_pack").ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. The demotion
// ---------------------------------------------------------------------------

describe("§2.1.1 DEGRADE — demoteToDiscover", () => {
  it("names one executable, mutually independent read_file per SHED handle — never a template", () => {
    const original = answerPack();
    const candidate: Body = {
      ...original,
      evidence: (original["evidence"] as Body[]).map((entry) => {
        const { body: _dropped, ...rest } = entry as { body?: string };
        return { ...rest, remaining: [String((entry as Body)["range"])] };
      }),
    };
    const demoted = demoteToDiscover(candidate, original);
    expect(demoted).toBeDefined();
    const decision = demoted!["decision"] as Body;
    expect(decision["kind"]).toBe("discover");

    const next = decision["next"] as Array<{ tool: string; arguments: Record<string, unknown> }>;
    expect(Array.isArray(next)).toBe(true);
    expect(next).toHaveLength(4);
    // Executable NOW: every argument is a concrete value read off the response.
    expect(next.every((call) => call.tool === "read_file")).toBe(true);
    expect(next.map((call) => call.arguments["handle"])).toEqual(["hcontract", "hapi", "hdoc", "htest"]);
    expect(next.every((call) => call.arguments["range"] === "1-40")).toBe(true);
    // §2.6 abolished `next_call_is_template`: no placeholder may survive.
    expect(JSON.stringify(next)).not.toContain("<");
    // §2.1.2 NEXT-INDEPENDENCE: distinct handles, so no member's validity
    // depends on another member's result.
    expect(new Set(next.map((call) => call.arguments["handle"])).size).toBe(next.length);
  });

  it("drops exactly what `discover` cannot represent, and MOVES the create target back to the root", () => {
    const original = createOnlyEditPack();
    // An `act.edit` whose floor broke: no frontier, and the create target is the
    // only carrier of "where may I write" on the whole response (the dual-carry
    // rule suppressed the root copy).
    expect(original["create_target"]).toBeUndefined();
    const demoted = demoteToDiscover(original, original);
    expect(demoted).toBeDefined();
    const decision = demoted!["decision"] as Body;
    expect(decision["kind"]).toBe("discover");
    // D-1…D-3: none of these is representable outside `act`.
    expect(decision).not.toHaveProperty("certificate");
    expect(decision).not.toHaveProperty("frontier");
    expect(decision).not.toHaveProperty("create_target");
    expect(decision).not.toHaveProperty("apply");
    // ...but the FACT survives, at the address every non-`act.edit` decision
    // carries it. Deleting it would lose the one wire statement of where the
    // new file goes, on the very response that exists to explain the recovery.
    expect(demoted!["create_target"]).toEqual({ path: "src/new_module.py", directory_evidence: ["src/sibling.py"] });
    // `act.edit` demotes to the RE-PACK that would produce a fitting frontier
    // (plan §6 constraint 4), not to a per-handle zoom.
    expect(decision["next"]).toEqual({ tool: "read_file", arguments: { mode: "task_pack", qref: "q-create" } });
  });

  it("DECLINES when no restoring call can be named — `discover` with no `next` is unrepresentable", () => {
    // No replay token, and no evidence that ever carried a body: nothing to
    // fetch, nothing to re-pack. The honest outcome is "no demotion exists",
    // which the ladder turns into "ship the last payload that was true".
    const stranded: Body = {
      v: 1, kind: "read.task_pack",
      task: { id: "t", coverage: "focused" }, profile: "answer", evidence: [],
      decision: { kind: "act.answer", certificate: { id: "c", obligations: ["o"], workspace: WORKSPACE } },
    };
    expect(demoteToDiscover(stranded, stranded)).toBeUndefined();
  });

  it("a demotion can make the response BIGGER — plan §6 constraint 2, measured", () => {
    // Long addressing, short bodies: the `next` array the demotion owes costs
    // more than the `certificate` it replaces. This is the case the ladder must
    // accept anyway, because F4 ranks a true large response above a false small
    // one.
    const original: Body = {
      v: 1, kind: "read.task_pack",
      task: { id: "t", coverage: "complete" }, profile: "answer",
      evidence: [
        { handle: "handle-with-a-deliberately-long-identifier-1", path: "src/a.ts", range: "1200-1400", body: "x" },
        { handle: "handle-with-a-deliberately-long-identifier-2", path: "src/b.ts", range: "2200-2400", body: "y" },
        { handle: "handle-with-a-deliberately-long-identifier-3", path: "src/c.ts", range: "3200-3400", body: "z" },
      ],
      decision: { kind: "act.answer", certificate: { id: "c", obligations: ["o"], workspace: WORKSPACE } },
    };
    const candidate: Body = {
      ...original,
      evidence: (original["evidence"] as Body[]).map(({ body: _b, ...rest }) => ({ ...rest, remaining: [String(rest["range"])] })),
    };
    const demoted = demoteToDiscover(candidate, original);
    expect(demoted).toBeDefined();
    expect(bytesOf(demoted)).toBeGreaterThan(bytesOf(candidate));
  });
});

// ---------------------------------------------------------------------------
// 3. The ladder integration — P13
// ---------------------------------------------------------------------------

describe("the ladder demotes rather than shipping a shorn act (P13)", () => {
  it("an act.answer whose bodies are all shed ships as `discover` with a non-empty executable next", () => {
    const { body } = emit(answerPack(), 900);
    const decision = body["decision"] as Body;
    expect(decision["kind"]).toBe("discover");
    expect(decision).not.toHaveProperty("certificate");
    const next = decision["next"];
    const calls = Array.isArray(next) ? next : [next];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls as Array<{ tool: string; arguments: Record<string, unknown> }>) {
      expect(call.tool).toBe("read_file");
      expect(typeof call.arguments["handle"] === "string" || typeof call.arguments["qref"] === "string").toBe(true);
    }
    // The floor holds on what actually shipped — vacuously, because the kind no
    // longer claims anything a floor governs. That IS the property.
    expect(actFloorHolds(body, "read.task_pack")).toBe(true);
  });

  it("at most ONE demotion per emission, and the ladder CONTINUES from the current rung afterwards", () => {
    expect(MAX_DEMOTIONS_PER_EMISSION).toBe(1);
    // A budget far under any reachable floor: rung 4 strips all four bodies
    // (the last one breaks FLOOR-ANSWER and demotes), then the ladder keeps
    // going — rung 5 drops whole entries. A second demotion would throw.
    const context: ProtocolCallContext = { tool: "read_file" };
    const outcome = runLadder({
      payload: answerPack(),
      kind: "read.task_pack",
      budget: 200,
      context,
      validate: (candidate) => validateProtocolBody(candidate, "read.task_pack").ok,
    });
    expect((outcome.payload["decision"] as Body)["kind"]).toBe("discover");
    const rungs = outcome.records.map((record) => record.rung);
    expect(rungs.filter((rung) => rung === 4).length).toBe(4);
    // Proof that the ladder did not stop at the demotion: a LATER rung ran.
    expect(rungs).toContain(5);
    expect(rungs.indexOf(5)).toBeGreaterThan(rungs.lastIndexOf(4));
  });

  it("no emission at any budget ships an `act` whose floor is broken", () => {
    // The sweep is the general statement of the two cases above: whatever the
    // ladder does at whatever budget, the shipped body satisfies its own floor.
    for (let budget = 120; budget <= 2400; budget += 60) {
      const { body } = emit(answerPack(), budget);
      expect(actFloorHolds(body, "read.task_pack"), `budget ${budget}: ${JSON.stringify(body).slice(0, 300)}`).toBe(true);
      const kind = (body["decision"] as Body | undefined)?.["kind"];
      if (kind === "act.answer") {
        // Not demoted => the evidence floor really is intact.
        expect((body["evidence"] as Body[]).some((entry) => typeof entry["body"] === "string")).toBe(true);
      }
    }
  });

  it("a create-only act.edit survives the ladder: `create_target` is unsheddable, so its floor cannot break by shedding", () => {
    const { body } = emit(createOnlyEditPack(), 300);
    const decision = body["decision"] as Body;
    // Either it still ships as the certified create (floor intact), or the
    // ladder ran out and converted — never an `act.edit` with nothing to write.
    expect(actFloorHolds(body, "read.task_pack")).toBe(true);
    if (decision?.["kind"] === "act.edit") {
      expect(decision["create_target"]).toEqual({ path: "src/new_module.py", directory_evidence: ["src/sibling.py"] });
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Ruling 6 at the projector — create promotion and branch-3 re-siting
// ---------------------------------------------------------------------------

describe("[R5-23] create_target rides `decision.act.edit`", () => {
  const certifiedEditContract = (): TaskExecutionContract => ({
    version: 1,
    state: "ready",
    readiness: "edit-ready",
    discovery_complete: true,
    next_action: "edit",
    max_additional_discovery_calls: 0,
    reason: "proof-carrying edit frontier passed falsification and risk gates",
    workspace_state: WORKSPACE,
    readiness_certificate: { id: "ready-create", obligations: [{ id: "surface-content" }], action_frontier: [] },
    typestate: { phase: "prepared", certificate_id: "ready-create", allowed_actions: ["edit"], challenge_required_for: [] },
  } as unknown as TaskExecutionContract);

  it("a create-only pack emits act.edit with NO frontier — the state that was structurally unemittable before ruling 6", () => {
    const decision = projectTaskDecision({
      result: { create_target: { path: "tools/audit_probe.py", directory_evidence: ["tools/existing.py"] } },
      contract: certifiedEditContract(),
      canonicalKind: "act-edit",
      evidence: [{ handle: "h1", path: "tools/existing.py", range: "1-10", body: "print(1)" }],
    });
    expect(decision?.kind).toBe("act.edit");
    expect(decision).not.toHaveProperty("frontier");
    expect((decision as { create_target?: unknown }).create_target).toEqual({
      path: "tools/audit_probe.py",
      directory_evidence: ["tools/existing.py"],
    });
  });

  it("a malformed create target is DROPPED, not promoted — half a floor is not a floor", () => {
    // `projectFrontier`'s rule applied to the second arm: a target that cannot
    // state its own path would satisfy the floor while naming nowhere to write.
    const decision = projectTaskDecision({
      result: { create_target: { directory_evidence: ["tools/existing.py"] } },
      contract: certifiedEditContract(),
      canonicalKind: "act-edit",
      evidence: [{ handle: "h1", path: "tools/existing.py", range: "1-10", body: "print(1)" }],
    });
    // No frontier, no usable create target => the floor breaks and the decision
    // degrades rather than claiming an edit it cannot address.
    expect(decision?.kind).not.toBe("act.edit");
  });
});

describe("[R5-30] branch 3 (`act-on-served-evidence`) is re-sited, gated on the floor", () => {
  const servedEvidence = [{ handle: "hserved", path: "src/orderflow.ts", range: "1-80", body: "everything the task needs" }];

  it("WITH a real certificate and a satisfied floor: `act.answer`, and no certificate id is minted", () => {
    const decision = projectTaskDecision({
      result: {},
      contract: branchThreeContract({
        workspace_state: WORKSPACE,
        readiness_certificate: { id: "cert-branch3", obligations: [{ id: "surface-content" }] },
      } as unknown as Partial<TaskExecutionContract>),
      canonicalKind: "await-input",
      evidence: servedEvidence,
    });
    expect(decision?.kind).toBe("act.answer");
    expect((decision as { certificate: { id: string } }).certificate.id).toBe("cert-branch3");
  });

  it("WITHOUT a certificate but WITH a concrete zoom: `discover` carrying that call — never `act.*`, never a minted id", () => {
    // D-2 is not negotiable: `act.*` is a certified claim, and this branch's
    // contract registers no execution fence, so there is no id to name.
    const decision = projectTaskDecision({
      result: {},
      contract: branchThreeContract(),
      canonicalKind: "await-input",
      evidence: [{ handle: "hpartial", path: "src/orderflow.ts", range: "1-80", body: "the served half", remaining: ["81-160"] }],
    });
    expect(decision?.kind).toBe("discover");
    expect((decision as { next: unknown }).next).toEqual({
      tool: "read_file",
      arguments: { handle: "hpartial", range: "81-160" },
    });
  });

  it("WITHOUT a certificate and with nothing left to fetch: the branch really IS awaiting input, and keeps its own token", () => {
    // The residual arm, and the honest one: with no certificate AND no call to
    // name, the grant the branch's prose offered was never real. This is the
    // shape both live corpus occurrences of branch 3 land on.
    const decision = projectTaskDecision({
      result: {},
      contract: branchThreeContract(),
      canonicalKind: "await-input",
      evidence: servedEvidence,
    });
    expect(decision?.kind).toBe("await_input");
    expect((decision as { code: string }).code).toBe("act-on-served-evidence");
  });

  it("the OTHER three await-input branches are untouched — the re-site is scoped to branch 3 by its own token", () => {
    for (const code of ["choose-candidate", "name-intended-target", "no-grounded-call-remains"] as const) {
      const decision = projectTaskDecision({
        result: {},
        contract: branchThreeContract({ await_input_code: code } as unknown as Partial<TaskExecutionContract>),
        canonicalKind: "await-input",
        evidence: [{ handle: "hpartial", path: "p", range: "1-80", body: "b", remaining: ["81-160"] }],
      });
      expect(decision?.kind).toBe("await_input");
      expect((decision as { code: string }).code).toBe(code);
    }
  });
});
