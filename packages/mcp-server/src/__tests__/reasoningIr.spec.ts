// reasoningIr.spec.ts — Task Reasoning IR v1 (v0.10.0 beta.1, V10-05).
//
// The IR is an ADVISORY pure projection over completed buildTaskPack
// results; nothing in dispatch imports it (structural test below). These
// tests build REAL packs on temp fixture workspaces (the artifactBuild.spec
// idiom) and pin: grounded-satisfied, stateHash determinism + the volatile
// task-handle exclusion, SHA-keyed invalidation, purity (no input mutation),
// and the hard caps.

import { describe, it, expect, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { buildTaskPack } from "../tools/readCodeTaskPack.js";
import {
  projectTaskReasoningIR,
  IR_OBLIGATIONS_MAX,
  IR_GOAL_MAX_CHARS,
  IR_ALLOWED_NEXT_MAX,
} from "../task-state/reasoningIr.js";
import type { TaskPackResult } from "../features/task-pack/model.js";

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

function mkWs(tag: string): string {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), `tl-ir-${tag}-`));
  tmpDirs.push(ws);
  return ws;
}

function writeFileIn(ws: string, rel: string, content: string): void {
  const p = path.join(ws, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf8");
}

/** The evidenceShadow.spec two-concern fixture shape — yields act.edit. */
function writeEditFixture(ws: string): void {
  writeFileIn(ws, "src/mixer.ts", "export function mixQuadX(yaw: number) {\n  const FR = +yaw;\n  return FR;\n}\n");
  writeFileIn(ws, "src/limiter.ts", "export function clampIntegral(v: number) {\n  return v;\n}\n");
  writeFileIn(ws, "test/mixer.test.ts", "import { mixQuadX } from '../src/mixer';\n\nit('mixes', () => {\n  expect(mixQuadX(1)).toBe(-1);\n});\n");
}

const EDIT_QUERY = "Fix mixQuadX yaw sign in src/mixer.ts and bound clampIntegral in src/limiter.ts";

describe("reasoning IR — grounded projection over real packs", () => {
  it("act.edit pack: obligations come from the change contract, uses link surfaces, decision is prepared", async () => {
    const ws = mkWs("edit");
    writeEditFixture(ws);
    const result = await buildTaskPack({ query: EDIT_QUERY }, ws);

    const ir = projectTaskReasoningIR({ result, taskId: "tlh_task_v1_FAKE.AAA", query: EDIT_QUERY });

    expect(ir.evidenceCatalog.length).toBeGreaterThan(0);
    // Every evidence use points at a cataloged identity.
    const ids = new Set(ir.evidenceCatalog.map((e) => e.evidenceId));
    for (const use of ir.evidenceUses) expect(ids.has(use.evidenceId)).toBe(true);
    // Every obligation ref is grounded in the catalog.
    for (const o of ir.obligations) for (const r of o.evidenceRefs) expect(ids.has(r)).toBe(true);
    // The hard rule: satisfied REQUIRES at least one grounded ref.
    for (const o of ir.obligations.filter((x) => x.state === "satisfied")) {
      expect(o.evidenceRefs.length).toBeGreaterThan(0);
    }
    if (result.change_contract !== undefined && result.change_contract.obligations.length > 0) {
      expect(ir.obligations.length).toBeGreaterThan(0);
    }
    const canonicalKindIsAct = result.change_contract?.status === "ready";
    if (canonicalKindIsAct) expect(ir.decision.state).toBe("prepared");
    expect(ir.goal).toBe(EDIT_QUERY);
  });

  it("discovery pack: capability gaps project as open obligations, decision pending, nothing satisfied without grounding", async () => {
    const ws = mkWs("disc");
    // Ambiguous multi-candidate shape: several same-named plausible targets.
    for (let i = 0; i < 4; i += 1) {
      writeFileIn(ws, `src/mod${i}/handler.ts`, `export function handleThing${i}() { return ${i}; }\n`);
    }
    const result = await buildTaskPack({ query: "update the handler wiring" }, ws);

    const ir = projectTaskReasoningIR({ result, query: "update the handler wiring" });
    expect(ir.decision.state).toBe("pending");
    for (const o of ir.obligations.filter((x) => x.state === "satisfied")) {
      expect(o.evidenceRefs.length).toBeGreaterThan(0);
    }
    // A pending decision never claims prepared evidence.
    expect(ir.decision.evidenceRefs).toEqual([]);
    expect(ir.allowedNext.length).toBeLessThanOrEqual(IR_ALLOWED_NEXT_MAX);
  });

  it("stateHash is deterministic across two projections AND across two builds, and excludes the volatile task handle", async () => {
    // Two SEPARATE workspaces with identical bytes: a same-session rebuild in
    // ONE workspace legitimately returns a different (receipt/carry-forward)
    // shape — that is dedup honesty, not IR state — so cross-build
    // determinism is asserted where the task state is genuinely identical.
    const ws1 = mkWs("det1");
    const ws2 = mkWs("det2");
    writeEditFixture(ws1);
    writeEditFixture(ws2);
    const r1 = await buildTaskPack({ query: EDIT_QUERY }, ws1);
    const r2 = await buildTaskPack({ query: EDIT_QUERY }, ws2);

    const a = projectTaskReasoningIR({ result: r1, taskId: "tlh_task_v1_ONE.X", query: EDIT_QUERY });
    const b = projectTaskReasoningIR({ result: r1, taskId: "tlh_task_v1_ONE.X", query: EDIT_QUERY });
    const c = projectTaskReasoningIR({ result: r2, taskId: "tlh_task_v1_TWO.Y", query: EDIT_QUERY });

    expect(a.stateHash).toBe(b.stateHash);
    // Different mint (taskId) — same task state: hash must match; the ref
    // itself may differ (identity vs hash boundary, §4.4).
    expect(a.stateHash).toBe(c.stateHash);
    expect(a.taskRef).not.toBe(c.taskRef);
  });

  it("a changed surface sha changes the invalidation keys and the stateHash (sha-keyed invalidation)", () => {
    // Direct mechanism test: not every serve path stamps surface shas (the
    // edit fixture's pack carries none — a documented v1 limitation: without
    // content hashes the IR cannot see a byte-level edit). Where shas ARE
    // stamped, the invalidation keys and the hash must track them.
    const base = {
      mode: "task_pack",
      coverage: "complete",
      surfaces: [
        { role: "definition", handle: "hAAAA0001", path: "src/a.ts", range: "1-4", sha: "sha256:aaaa" },
      ],
      missing: [],
      qref: "q-invtest",
    } as unknown as TaskPackResult;
    const flipped = JSON.parse(JSON.stringify(base)) as TaskPackResult;
    (flipped.surfaces[0] as { sha?: string }).sha = "sha256:bbbb";

    const irBefore = projectTaskReasoningIR({ result: base, query: "inv" });
    const irAfter = projectTaskReasoningIR({ result: flipped, query: "inv" });

    const keys = (ir: typeof irBefore): string[] =>
      ir.invalidationKeys.filter((k) => k.type === "file-sha").map((k) => k.value);
    expect(keys(irBefore)).toEqual(["src/a.ts@sha256:aaaa"]);
    expect(keys(irAfter)).toEqual(["src/a.ts@sha256:bbbb"]);
    expect(irAfter.stateHash).not.toBe(irBefore.stateHash);
    expect(irBefore.evidenceCatalog[0]!.evidenceClass).toBe("direct");
  });

  it("projection is pure: the input result object is not mutated", async () => {
    const ws = mkWs("pure");
    writeEditFixture(ws);
    const result = await buildTaskPack({ query: EDIT_QUERY }, ws);
    const snapshot = JSON.stringify(result);
    projectTaskReasoningIR({ result, taskId: "tlh_task_v1_Z.Z", query: EDIT_QUERY });
    expect(JSON.stringify(result)).toBe(snapshot);
  });

  it("caps hold on an adversarial synthetic pack (obligations, goal, allowedNext)", () => {
    const surfaces = Array.from({ length: 40 }, (_, i) => ({
      role: "definition",
      handle: `h${i}`,
      path: `src/f${i}.ts`,
      range: "1-3",
    }));
    const synthetic = {
      mode: "task_pack",
      coverage: "partial",
      coverage_reason: "candidate-list",
      surfaces,
      missing: [],
      qref: "q-synthetic",
      next: "narrow the candidates",
      change_contract: {
        version: 1,
        status: "needs-followup",
        discovery_complete: false,
        obligations: surfaces.map((s, i) => ({
          id: `o${i}`,
          kind: "implementation",
          action: "edit",
          status: "needs-context",
          required: i < 5,
          handle: s.handle,
          path: s.path,
          range: s.range,
          role: "definition",
          depends_on: [],
        })),
        stages: [],
        missing: [],
        max_additional_tl_calls: 2,
      },
    } as unknown as TaskPackResult;

    const ir = projectTaskReasoningIR({ result: synthetic, query: "x".repeat(2000) });
    expect(ir.obligations.length).toBeLessThanOrEqual(IR_OBLIGATIONS_MAX);
    expect(ir.goal.length).toBeLessThanOrEqual(IR_GOAL_MAX_CHARS);
    expect(ir.allowedNext.length).toBeLessThanOrEqual(IR_ALLOWED_NEXT_MAX);
    // Blocked (needs-context) work survives the cap ahead of satisfied rows.
    expect(ir.obligations.every((o) => o.state === "blocked")).toBe(true);
  });
});

describe("reasoning IR — advisory posture", () => {
  it("dispatch does not import the v1 projection (structural)", () => {
    const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.ts"), "utf8");
    // v0.11 V11-04 note: this used to test `includes("reasoningIr")`, a coarse
    // proxy for "the v1 module is unwired". V11-04 adds a SIBLING v2 tree under
    // task-state/ whose flag reader is named `reasoningIrV2Enabled`, so the
    // substring now over-matches. The assertions below test what the proxy was
    // standing in for, and test it more precisely: v1's MODULE is not imported
    // and v1's projection FUNCTION is not named anywhere in dispatch. v1 stays
    // exactly as unwired as it was.
    expect(serverSrc.includes("task-state/reasoningIr.js")).toBe(false);
    expect(serverSrc.includes("projectTaskReasoningIR")).toBe(false);
  });
});
