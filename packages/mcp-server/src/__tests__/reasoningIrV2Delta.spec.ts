/**
 * reasoningIrV2Delta.spec.ts — V11-04 acceptance: `reasoning_delta`.
 *
 * Plan §7 V11-04 acceptance rows covered here:
 *   - "snapshot＋deltaからstateを100%再構築できる" (property-style, seeded);
 *   - "base hash mismatchのfull snapshot fallback 100%";
 *   - "delta applyをidempotentにする";
 *   - "invalid obligation closure 0件" (through the delta ops, not just the gate);
 *   - "lane競合／out-of-order delta fixture 100% pass".
 * Plus the §4.4 hash boundary: a delivery/codec/receipt change must not move
 * `task_state_hash`.
 */

import { describe, it, expect } from "vitest";
import type { ReasoningDeltaOp, TaskReasoningIRv2 } from "@tokenlighten/types";
import {
  APPLIED_DELTA_IDS_MAX,
  applyReasoningDelta,
  buildReasoningDelta,
  computeTaskStateHash,
  replayReasoningDeltas,
  TASK_STATE_HASH_COMPONENTS,
} from "../task-state/reasoningDelta.js";
import { canClose } from "../task-state/obligationDag.js";
import { createWeakTombstone } from "../task-state/tombstone.js";
import { evidence, mulberry32, node, state, use } from "./helpers/irV2Fixtures.js";

function built(base: TaskReasoningIRv2, ops: ReasoningDeltaOp[]) {
  const result = buildReasoningDelta(base, ops);
  if (!result.ok) throw new Error(`delta build refused: ${result.reason} ${result.detail}`);
  return result;
}

// ---------------------------------------------------------------------------
// §4.4 hash boundary
// ---------------------------------------------------------------------------

describe("V11-04 task_state_hash boundary (§4.4)", () => {
  it("names exactly the four §4.4 components", () => {
    expect([...TASK_STATE_HASH_COMPONENTS]).toEqual([
      "evidenceCatalog",
      "evidenceUses",
      "obligations",
      "decision",
    ]);
  });

  it("a DELIVERY/codec/receipt change leaves the hash unchanged", () => {
    const base = state({
      evidenceCatalog: [evidence("e1", "src/a.ts")],
      evidenceUses: [use("e1", "a")],
      obligations: [node("a", { evidenceRefs: ["e1"] })],
    });
    // Everything below is delivery-domain material (EvidenceDelivery, the
    // context/semantic/wire hashes, a receipt id) parked on the state object,
    // plus the state fields that ride OUTSIDE the identity. None may move the
    // hash — the projection copies four named components and nothing else.
    const withDelivery = {
      ...base,
      goal: "a completely different goal",
      allowedNext: [{ tool: "read_file", reason: "whatever" }],
      invalidationKeys: [{ type: "qref", value: "q-changed" }],
      appliedDeltaIds: ["deadbeef"],
      tombstones: [],
      evidenceDelivery: [{ responseId: "r1", evidenceId: "e1", disposition: "micro_restate" }],
      receiptId: "receipt-1",
      contextHandle: "ctx-1",
      context_state_hash: "ctx-hash",
      semantic_payload_hash: "sem-hash",
      wire_hash: "wire-hash",
      codec: "toon-4.1",
    } as unknown as TaskReasoningIRv2;
    expect(computeTaskStateHash(withDelivery)).toBe(base.stateHash);
  });

  it("…but a change INSIDE any of the four does move it (the check is not vacuous)", () => {
    const base = state({
      evidenceCatalog: [evidence("e1", "src/a.ts")],
      evidenceUses: [use("e1", "a")],
      obligations: [node("a", { evidenceRefs: ["e1"] })],
    });
    expect(computeTaskStateHash({ ...base, evidenceCatalog: [evidence("e1", "src/b.ts")] })).not.toBe(base.stateHash);
    expect(computeTaskStateHash({ ...base, evidenceUses: [] })).not.toBe(base.stateHash);
    expect(computeTaskStateHash({ ...base, obligations: [node("a", { evidenceRefs: [] })] })).not.toBe(base.stateHash);
    expect(computeTaskStateHash({ ...base, decision: { state: "done", evidenceRefs: [] } })).not.toBe(base.stateHash);
  });

  it("is stable across key order and across two identical constructions", () => {
    const a = state({ evidenceCatalog: [evidence("e1", "src/a.ts")], obligations: [node("a")] });
    const b = state({ obligations: [node("a")], evidenceCatalog: [evidence("e1", "src/a.ts")] });
    expect(a.stateHash).toBe(b.stateHash);
  });
});

// ---------------------------------------------------------------------------
// Build / apply
// ---------------------------------------------------------------------------

describe("V11-04 delta build + apply", () => {
  const base = state({ taskRef: "t", lane: "" });

  it("carries base/new version+hash and applies cleanly", () => {
    const { delta, state: next } = built(base, [
      { op: "add", target: "evidence", evidence: evidence("e1", "src/a.ts") },
      { op: "add", target: "obligation", obligation: node("a", { evidenceRefs: ["e1"] }) },
    ]);
    expect(delta.baseVersion).toBe(base.stateVersion);
    expect(delta.baseHash).toBe(base.stateHash);
    expect(delta.newVersion).toBe(base.stateVersion + 1);
    expect(delta.newHash).toBe(next.stateHash);

    const applied = applyReasoningDelta(base, delta);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.outcome).toBe("applied");
    expect(applied.state.stateHash).toBe(delta.newHash);
    expect(applied.state.obligations.map((o) => o.id)).toEqual(["a"]);
  });

  it("never mutates the input state", () => {
    const frozen = JSON.stringify(base);
    built(base, [{ op: "add", target: "evidence", evidence: evidence("e1", "src/a.ts") }]);
    expect(JSON.stringify(base)).toBe(frozen);
  });

  it("re-applying the SAME delta is a proved no-op with the same hash", () => {
    const { delta, state: next } = built(base, [{ op: "add", target: "evidence", evidence: evidence("e1", "src/a.ts") }]);
    const again = applyReasoningDelta(next, delta);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.outcome).toBe("already-applied");
    expect(again.state).toBe(next);
    expect(again.state.stateHash).toBe(delta.newHash);
  });

  it("idempotency survives the state moving on (a retried transport never double-applies)", () => {
    const first = built(base, [{ op: "add", target: "evidence", evidence: evidence("e1", "src/a.ts") }]);
    const second = built(first.state, [{ op: "add", target: "evidence", evidence: evidence("e2", "src/b.ts") }]);
    const replayOld = applyReasoningDelta(second.state, first.delta);
    expect(replayOld).toMatchObject({ ok: true, outcome: "already-applied" });
    if (!replayOld.ok) return;
    expect(replayOld.state.evidenceCatalog).toHaveLength(2);
  });

  it("the applied-delta ring stays bounded", () => {
    let s = base;
    for (let i = 0; i < APPLIED_DELTA_IDS_MAX + 8; i += 1) {
      s = built(s, [{ op: "add", target: "evidence", evidence: evidence(`e${i}`, `src/${i}.ts`) }]).state;
    }
    expect(s.appliedDeltaIds).toHaveLength(APPLIED_DELTA_IDS_MAX);
  });
});

// ---------------------------------------------------------------------------
// Refusals — all of them fall back to a full snapshot, none half-lands
// ---------------------------------------------------------------------------

describe("V11-04 delta refusals → full-snapshot fallback, state untouched", () => {
  const base = state({ taskRef: "t", lane: "" });
  const { delta } = built(base, [{ op: "add", target: "evidence", evidence: evidence("e1", "src/a.ts") }]);

  it("base-hash mismatch (a forked state) refuses", () => {
    const forked = state({ taskRef: "t", lane: "", obligations: [node("x")] });
    const result = applyReasoningDelta({ ...forked, stateVersion: base.stateVersion }, delta);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.outcome).toBe("base-hash-mismatch");
    expect(result.fallback).toBe("full-snapshot");
    expect(result.state.obligations.map((o) => o.id)).toEqual(["x"]);
  });

  it("out-of-order (version skew) refuses", () => {
    const moved = { ...base, stateVersion: base.stateVersion + 3 };
    const result = applyReasoningDelta(moved, delta);
    expect(result).toMatchObject({ ok: false, outcome: "out-of-order", fallback: "full-snapshot" });
  });

  it("a delta from ANOTHER LANE refuses (lane isolation, second fence)", () => {
    const otherLane = state({ taskRef: "t", lane: "agent-b" });
    const result = applyReasoningDelta(otherLane, { ...delta, lane: "" });
    expect(result).toMatchObject({ ok: false, outcome: "lane-mismatch", fallback: "full-snapshot" });
    if (result.ok) return;
    expect(result.state.evidenceCatalog).toHaveLength(0);
  });

  it("a delta from another TASK refuses", () => {
    const other = state({ taskRef: "other", lane: "" });
    expect(applyReasoningDelta(other, delta)).toMatchObject({ ok: false, outcome: "task-mismatch" });
  });

  it("a tampered newHash refuses as hash-divergence and lands nothing", () => {
    const tampered = { ...delta, newHash: "0".repeat(64), deltaId: `${delta.deltaId}x` };
    const result = applyReasoningDelta(base, tampered);
    expect(result).toMatchObject({ ok: false, outcome: "hash-divergence", fallback: "full-snapshot" });
    if (result.ok) return;
    expect(result.state.evidenceCatalog).toHaveLength(0);
  });

  it("an op-level refusal (unknown obligation) surfaces as op-refused", () => {
    const bad = built(base, [{ op: "add", target: "evidence", evidence: evidence("e9", "src/z.ts") }]).delta;
    const withBadOps = { ...bad, ops: [{ op: "close", target: "obligation", id: "nope" }] as ReasoningDeltaOp[] };
    expect(applyReasoningDelta(base, withBadOps)).toMatchObject({ ok: false, outcome: "op-refused" });
  });
});

// ---------------------------------------------------------------------------
// Invalid closure is unreachable through the ops too
// ---------------------------------------------------------------------------

describe("V11-04 invalid obligation closure 0 — through the delta ops", () => {
  const base = state({
    taskRef: "t",
    evidenceCatalog: [evidence("e1", "src/a.ts"), evidence("eh", "src/g.ts", "heuristic")],
    obligations: [node("dep"), node("a", { blockedBy: ["dep"], evidenceRefs: ["e1"] }), node("h", { evidenceRefs: ["eh"] })],
  });

  it("a `close` op on a blocked node is refused", () => {
    expect(buildReasoningDelta(base, [{ op: "close", target: "obligation", id: "a" }]))
      .toMatchObject({ ok: false, reason: "invalid-closure" });
  });

  it("a `close` op on a heuristic-only-grounded node is refused", () => {
    expect(buildReasoningDelta(base, [{ op: "close", target: "obligation", id: "h" }]))
      .toMatchObject({ ok: false, reason: "invalid-closure" });
  });

  it("an `update` setting state:'satisfied' is NOT a back door — same gate", () => {
    expect(buildReasoningDelta(base, [{ op: "update", target: "obligation", id: "a", patch: { state: "satisfied" } }]))
      .toMatchObject({ ok: false, reason: "invalid-closure" });
  });

  it("an `add` op may not smuggle in a pre-satisfied node", () => {
    const next = built(base, [
      { op: "add", target: "obligation", obligation: node("sneaky", { state: "satisfied" }) },
    ]).state;
    expect(next.obligations.find((o) => o.id === "sneaky")!.state).toBe("open");
  });

  it("closing the dependency first makes the dependent closable", () => {
    const s1 = built(base, [{ op: "update", target: "obligation", id: "dep", patch: { evidenceRefs: ["e1"] } }]).state;
    const s2 = built(s1, [{ op: "close", target: "obligation", id: "dep" }]).state;
    const s3 = built(s2, [{ op: "close", target: "obligation", id: "a" }]).state;
    expect(s3.obligations.find((o) => o.id === "a")!.state).toBe("satisfied");
  });

  it("a delta that would introduce a CYCLE is refused", () => {
    const s = state({ taskRef: "t", obligations: [node("a"), node("b", { blockedBy: ["a"] })] });
    expect(buildReasoningDelta(s, [{ op: "update", target: "obligation", id: "a", patch: { blockedBy: ["b"] } }]))
      .toMatchObject({ ok: false, reason: "invalid-edges" });
  });

  it("invalidating evidence DEMOTES an obligation that was closed on it", () => {
    const closed = built(
      state({ taskRef: "t", evidenceCatalog: [evidence("e1", "src/a.ts")], obligations: [node("a", { evidenceRefs: ["e1"] })] }),
      [{ op: "close", target: "obligation", id: "a" }],
    ).state;
    expect(closed.obligations[0]!.state).toBe("satisfied");

    const after = built(closed, [{ op: "invalidate", target: "evidence", id: "e1", reason: "file-sha changed" }]).state;
    expect(after.evidenceCatalog).toHaveLength(0);
    expect(after.obligations[0]!.state).toBe("open");
    expect(after.obligations[0]!.evidenceRefs).toEqual([]);
    expect(canClose("a", after)).toMatchObject({ ok: false, reason: "predicate-unsatisfied" });
  });
});

// ---------------------------------------------------------------------------
// Property-style reconstruction
// ---------------------------------------------------------------------------

describe("V11-04 snapshot + delta log reconstructs state 100% (seeded property)", () => {
  const SEEDS = [1, 7, 42, 1337, 20260821, 99991, 5, 8675309];

  for (const seed of SEEDS) {
    it(`seed ${seed}: replay from the checkpoint deep-equals the directly-applied state`, () => {
      const rand = mulberry32(seed);
      const checkpoint = state({ taskRef: `t-${seed}`, lane: seed % 2 === 0 ? "" : "agent-a" });
      let live = checkpoint;
      const log = [];
      let evidenceSeq = 0;
      let obligationSeq = 0;
      let tombstoneSeq = 0;

      for (let step = 0; step < 40; step += 1) {
        const ops: ReasoningDeltaOp[] = [];
        const roll = rand();
        if (roll < 0.3) {
          evidenceSeq += 1;
          ops.push({
            op: "add",
            target: "evidence",
            evidence: evidence(`e${evidenceSeq}`, `src/f${evidenceSeq}.ts`, rand() < 0.2 ? "heuristic" : "direct"),
          });
        } else if (roll < 0.55) {
          obligationSeq += 1;
          const deps = live.obligations.length > 0 && rand() < 0.4
            ? [live.obligations[Math.floor(rand() * live.obligations.length)]!.id]
            : [];
          const refs = live.evidenceCatalog.length > 0
            ? [live.evidenceCatalog[Math.floor(rand() * live.evidenceCatalog.length)]!.evidenceId]
            : [];
          ops.push({
            op: "add",
            target: "obligation",
            obligation: node(`o${obligationSeq}`, {
              blockedBy: deps,
              evidenceRefs: refs,
              ...(rand() < 0.15 ? { origin: "heuristic" as const, predicate: { kind: "manual" as const } } : {}),
            }),
          });
          if (refs[0] !== undefined) ops.push({ op: "add", target: "use", use: use(refs[0], `o${obligationSeq}`) });
        } else if (roll < 0.75) {
          const open = live.obligations.filter((o) => o.state !== "satisfied");
          if (open.length === 0) continue;
          const target = open[Math.floor(rand() * open.length)]!;
          if (!canClose(target.id, live).ok) continue;
          ops.push({ op: "close", target: "obligation", id: target.id });
        } else if (roll < 0.85) {
          ops.push({
            op: "update",
            target: "decision",
            decision: { state: rand() < 0.5 ? "prepared" : "pending", evidenceRefs: live.evidenceCatalog.slice(0, 2).map((e) => e.evidenceId) },
          });
        } else if (roll < 0.95) {
          tombstoneSeq += 1;
          const made = createWeakTombstone({
            id: `tomb${tombstoneSeq}`,
            claim: `hypothesis ${tombstoneSeq} looks unpromising`,
            scope: { kind: "query", description: "bounded search", complete: false },
            reviveCondition: "a direct reference appears",
            validityKeys: [{ type: "qref", value: `q-${seed}` }],
          });
          if (!made.ok) continue;
          ops.push({ op: "add", target: "tombstone", tombstone: made.tombstone });
        } else if (live.evidenceCatalog.length > 0) {
          const victim = live.evidenceCatalog[Math.floor(rand() * live.evidenceCatalog.length)]!;
          ops.push({ op: "invalidate", target: "evidence", id: victim.evidenceId, reason: "sha changed" });
        }

        if (ops.length === 0) continue;
        const result = buildReasoningDelta(live, ops);
        if (!result.ok) continue;
        log.push(result.delta);
        live = result.state;
      }

      expect(log.length).toBeGreaterThan(8);
      const replayed = replayReasoningDeltas(checkpoint, log);
      expect(replayed.ok).toBe(true);
      if (!replayed.ok) return;
      // FULL state equality, not just the hash: the hash covers four
      // components, and reconstruction has to reproduce all of them plus the
      // unhashed remainder (tombstones, the delta ring, dagEnabled).
      expect(replayed.state).toEqual(live);
    });
  }

  it("a MISSING delta in the middle of the log aborts the whole replay", () => {
    const checkpoint = state({ taskRef: "gap" });
    const d1 = built(checkpoint, [{ op: "add", target: "evidence", evidence: evidence("e1", "src/a.ts") }]);
    const d2 = built(d1.state, [{ op: "add", target: "evidence", evidence: evidence("e2", "src/b.ts") }]);
    const d3 = built(d2.state, [{ op: "add", target: "evidence", evidence: evidence("e3", "src/c.ts") }]);
    const result = replayReasoningDeltas(checkpoint, [d1.delta, d3.delta]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.index).toBe(1);
    expect(result.outcome).toBe("out-of-order");
  });

  it("a REORDERED log aborts too — order is (baseVersion, baseHash), not arrival", () => {
    const checkpoint = state({ taskRef: "order" });
    const d1 = built(checkpoint, [{ op: "add", target: "evidence", evidence: evidence("e1", "src/a.ts") }]);
    const d2 = built(d1.state, [{ op: "add", target: "evidence", evidence: evidence("e2", "src/b.ts") }]);
    expect(replayReasoningDeltas(checkpoint, [d2.delta, d1.delta])).toMatchObject({ ok: false, index: 0 });
  });
});
