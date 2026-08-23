/**
 * reasoningIrV2Store.spec.ts — V11-04 acceptance: snapshot checkpoints, the
 * delta log, lane isolation, and fail-closed recovery.
 *
 * Plan §7 V11-04: "snapshot checkpoint、idempotent delta apply、lane isolationを
 * 実装する" and "lane競合／out-of-order delta fixture 100% pass".
 *
 * These specs exercise the REAL `WorkspaceStateStore` (journal + atomic rename)
 * against temporary workspaces, because the whole point of the module is that
 * it rides the existing store additively rather than inventing persistence.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { ReasoningDelta, TaskReasoningIRv2 } from "@tokenlighten/types";
import { resetStateStoresForTests, stateStoreFor } from "../state/stateStore.js";
import {
  checkpointIrState,
  clearIrState,
  decodeIrState,
  IR_DELTA_LOG_MAX,
  IR_KEY_PREFIX,
  irRecordVersion,
  irStateKey,
  loadIrState,
  recordIrDelta,
} from "../task-state/irStore.js";
import { buildReasoningDelta } from "../task-state/reasoningDelta.js";
import { evidence, node, state } from "./helpers/irV2Fixtures.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();
const dirs: string[] = [];

function mkWs(tag: string): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(HOME, `.tl-irv2-${tag}-`)));
  dirs.push(d);
  return d;
}

beforeEach(() => {
  resetStateStoresForTests();
});

afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

function advance(base: TaskReasoningIRv2, id: string): { delta: ReasoningDelta; state: TaskReasoningIRv2 } {
  const result = buildReasoningDelta(base, [
    { op: "add", target: "evidence", evidence: evidence(id, `src/${id}.ts`) },
  ]);
  if (!result.ok) throw new Error(`fixture delta refused: ${result.reason}`);
  return result;
}

describe("V11-04 irStore — key namespace", () => {
  it("is additive: the `ir2:` prefix cannot collide with a base64url handle key", () => {
    const key = irStateKey({ workspaceRef: "/ws", taskRef: "t", lane: "" });
    expect(key.startsWith(IR_KEY_PREFIX)).toBe(true);
    // Explicit-handle keys are base64url of a 9-byte ref: 12 chars, no ":".
    expect(key).toMatch(/^ir2:[0-9a-f]{32}$/);
  });

  it("separates lanes and tasks", () => {
    const a = irStateKey({ workspaceRef: "/ws", taskRef: "t", lane: "" });
    const b = irStateKey({ workspaceRef: "/ws", taskRef: "t", lane: "agent-b" });
    const c = irStateKey({ workspaceRef: "/ws", taskRef: "other", lane: "" });
    const d = irStateKey({ workspaceRef: "/other-ws", taskRef: "t", lane: "" });
    expect(new Set([a, b, c, d]).size).toBe(4);
  });
});

describe("V11-04 irStore — checkpoint + delta log round trip", () => {
  it("reconstructs the exact state from a checkpoint alone", () => {
    const ws = mkWs("chk");
    const key = irStateKey({ workspaceRef: ws, taskRef: "t", lane: "" });
    const s = state({ taskRef: "t", evidenceCatalog: [evidence("e1", "src/a.ts")], obligations: [node("a")] });

    expect(checkpointIrState(ws, key, s, 0)).toMatchObject({ ok: true, deltaCount: 0 });
    const loaded = loadIrState(ws, key);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.state).toEqual(s);
    expect(loaded.deltaCount).toBe(0);
  });

  it("reconstructs the exact state from a checkpoint PLUS its delta log", () => {
    const ws = mkWs("log");
    const key = irStateKey({ workspaceRef: ws, taskRef: "t", lane: "" });
    const checkpoint = state({ taskRef: "t" });
    checkpointIrState(ws, key, checkpoint, 0);

    let live = checkpoint;
    for (const id of ["e1", "e2", "e3"]) {
      const step = advance(live, id);
      const write = recordIrDelta(ws, key, step.delta, step.state, irRecordVersion(ws, key));
      expect(write.ok).toBe(true);
      live = step.state;
    }

    const loaded = loadIrState(ws, key);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.deltaCount).toBe(3);
    expect(loaded.state).toEqual(live);
  });

  it("survives a fresh process view of the store (re-open from disk)", () => {
    const ws = mkWs("reopen");
    const key = irStateKey({ workspaceRef: ws, taskRef: "t", lane: "" });
    const checkpoint = state({ taskRef: "t" });
    checkpointIrState(ws, key, checkpoint, 0);
    const step = advance(checkpoint, "e1");
    recordIrDelta(ws, key, step.delta, step.state, irRecordVersion(ws, key));

    resetStateStoresForTests();
    const loaded = loadIrState(ws, key);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.state).toEqual(step.state);
  });

  it("auto-checkpoints once the delta log is full, and stays reconstructible", () => {
    const ws = mkWs("full");
    const key = irStateKey({ workspaceRef: ws, taskRef: "t", lane: "" });
    let live = state({ taskRef: "t" });
    checkpointIrState(ws, key, live, 0);

    for (let i = 0; i <= IR_DELTA_LOG_MAX + 1; i += 1) {
      const step = advance(live, `e${i}`);
      recordIrDelta(ws, key, step.delta, step.state, irRecordVersion(ws, key));
      live = step.state;
    }

    const loaded = loadIrState(ws, key);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    // The log was truncated by the forced checkpoint, and the state is intact.
    expect(loaded.deltaCount).toBeLessThanOrEqual(IR_DELTA_LOG_MAX);
    expect(loaded.state).toEqual(live);
  });

  it("clearIrState removes the record", () => {
    const ws = mkWs("clear");
    const key = irStateKey({ workspaceRef: ws, taskRef: "t", lane: "" });
    checkpointIrState(ws, key, state({ taskRef: "t" }), 0);
    clearIrState(ws, key);
    expect(loadIrState(ws, key)).toMatchObject({ ok: false, reason: "absent" });
  });
});

describe("V11-04 irStore — lane isolation", () => {
  it("two lanes of one workspace never see each other's state", () => {
    const ws = mkWs("lanes");
    const keyA = irStateKey({ workspaceRef: ws, taskRef: "t", lane: "agent-a" });
    const keyB = irStateKey({ workspaceRef: ws, taskRef: "t", lane: "agent-b" });

    const a = state({ taskRef: "t", lane: "agent-a", evidenceCatalog: [evidence("ea", "src/a.ts")] });
    const b = state({ taskRef: "t", lane: "agent-b", evidenceCatalog: [evidence("eb", "src/b.ts")] });
    checkpointIrState(ws, keyA, a, 0);
    checkpointIrState(ws, keyB, b, 0);

    const loadedA = loadIrState(ws, keyA);
    const loadedB = loadIrState(ws, keyB);
    expect(loadedA.ok && loadedA.state.evidenceCatalog.map((e) => e.evidenceId)).toEqual(["ea"]);
    expect(loadedB.ok && loadedB.state.evidenceCatalog.map((e) => e.evidenceId)).toEqual(["eb"]);
  });

  it("a CROSS-LANE delta is refused during replay, so the load fails closed", () => {
    const ws = mkWs("cross");
    const keyA = irStateKey({ workspaceRef: ws, taskRef: "t", lane: "agent-a" });
    const a = state({ taskRef: "t", lane: "agent-a" });
    checkpointIrState(ws, keyA, a, 0);

    // A delta minted for lane B, delivered into lane A's log (the mixing lanes
    // exist to prevent). Replay must refuse rather than merge.
    const foreign = advance(state({ taskRef: "t", lane: "agent-b" }), "eb");
    recordIrDelta(ws, keyA, foreign.delta, foreign.state, irRecordVersion(ws, keyA));

    const loaded = loadIrState(ws, keyA);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.reason).toBe("corrupt");
    expect(loaded.detail).toContain("lane-mismatch");
  });

  it("an OUT-OF-ORDER delta in the log fails the whole load closed", () => {
    const ws = mkWs("ooo");
    const key = irStateKey({ workspaceRef: ws, taskRef: "t", lane: "" });
    const checkpoint = state({ taskRef: "t" });
    checkpointIrState(ws, key, checkpoint, 0);

    const d1 = advance(checkpoint, "e1");
    const d2 = advance(d1.state, "e2");
    // Skip d1: the log now starts at a base the snapshot never reaches.
    recordIrDelta(ws, key, d2.delta, d2.state, irRecordVersion(ws, key));

    const loaded = loadIrState(ws, key);
    expect(loaded).toMatchObject({ ok: false, reason: "corrupt" });
    if (loaded.ok) return;
    expect(loaded.detail).toContain("out-of-order");
  });
});

describe("V11-04 irStore — recovery is fail-closed to fresh, never partial", () => {
  function poison(ws: string, key: string, data: Record<string, unknown>): void {
    const store = stateStoreFor(ws)!;
    store.put({ key, purpose: "task", data, ttlMs: 60_000 });
  }

  it("a non-decoding record loads as corrupt, not as an empty success", () => {
    const ws = mkWs("garbage");
    const key = irStateKey({ workspaceRef: ws, taskRef: "t", lane: "" });
    poison(ws, key, { v: 1, snapshot: { irVersion: 2, taskRef: 5 }, deltas: [] });
    expect(loadIrState(ws, key)).toMatchObject({ ok: false, reason: "corrupt" });
  });

  it("a snapshot whose hash does not match its content loads as corrupt", () => {
    const ws = mkWs("tamper");
    const key = irStateKey({ workspaceRef: ws, taskRef: "t", lane: "" });
    const s = state({ taskRef: "t", obligations: [node("a")] });
    poison(ws, key, { v: 1, snapshot: { ...s, stateHash: "0".repeat(64) }, deltas: [] });
    const loaded = loadIrState(ws, key);
    expect(loaded).toMatchObject({ ok: false, reason: "corrupt" });
    if (loaded.ok) return;
    expect(loaded.detail).toContain("hash");
  });

  it("a record whose `advisory` disagrees with `origin` is refused (tamper-evident)", () => {
    const ws = mkWs("advisory");
    const key = irStateKey({ workspaceRef: ws, taskRef: "t", lane: "" });
    const s = state({ taskRef: "t", obligations: [node("g", { origin: "heuristic" })] });
    const tampered = {
      ...s,
      obligations: [{ ...s.obligations[0]!, advisory: false }],
    };
    poison(ws, key, { v: 1, snapshot: tampered, deltas: [] });
    expect(loadIrState(ws, key)).toMatchObject({ ok: false, reason: "corrupt" });
  });

  it("a strong tombstone with no absence proof cannot be reconstituted from disk", () => {
    const ws = mkWs("strongtomb");
    const key = irStateKey({ workspaceRef: ws, taskRef: "t", lane: "" });
    const s = state({
      taskRef: "t",
      tombstones: [{
        id: "t1",
        claim: "nothing here",
        scope: { kind: "repository", description: "all", complete: true },
        evidenceRefs: [],
        strength: "strong",
        reviveCondition: "anything appears",
        validityKeys: [{ type: "index-generation", value: "gen-1" }],
      }],
    });
    poison(ws, key, { v: 1, snapshot: s, deltas: [] });
    expect(loadIrState(ws, key)).toMatchObject({ ok: false, reason: "corrupt" });
  });

  it("a corrupt record SELF-HEALS on the next checkpoint (CAS overwrite)", () => {
    const ws = mkWs("heal");
    const key = irStateKey({ workspaceRef: ws, taskRef: "t", lane: "" });
    poison(ws, key, { v: 99, junk: true });
    expect(loadIrState(ws, key)).toMatchObject({ ok: false, reason: "corrupt" });

    const fresh = state({ taskRef: "t", obligations: [node("a")] });
    expect(checkpointIrState(ws, key, fresh, irRecordVersion(ws, key))).toMatchObject({ ok: true });
    const loaded = loadIrState(ws, key);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.state).toEqual(fresh);
  });

  it("a stale CAS version is reported as a conflict and writes nothing", () => {
    const ws = mkWs("cas");
    const key = irStateKey({ workspaceRef: ws, taskRef: "t", lane: "" });
    const first = state({ taskRef: "t", obligations: [node("a")] });
    checkpointIrState(ws, key, first, 0);

    const conflicting = state({ taskRef: "t", obligations: [node("b")] });
    expect(checkpointIrState(ws, key, conflicting, 0)).toMatchObject({ ok: false, reason: "state-conflict" });

    const loaded = loadIrState(ws, key);
    expect(loaded.ok && loaded.state.obligations.map((o) => o.id)).toEqual(["a"]);
  });

  it("reports store-unavailable when the store is disabled", () => {
    const ws = mkWs("off");
    const key = irStateKey({ workspaceRef: ws, taskRef: "t", lane: "" });
    const saved = process.env["TOKENLIGHTEN_STATE_STORE"];
    process.env["TOKENLIGHTEN_STATE_STORE"] = "off";
    try {
      resetStateStoresForTests();
      expect(loadIrState(ws, key)).toMatchObject({ ok: false, reason: "store-unavailable" });
      expect(checkpointIrState(ws, key, state({ taskRef: "t" }), 0)).toMatchObject({ ok: false, reason: "store-unavailable" });
    } finally {
      if (saved === undefined) delete process.env["TOKENLIGHTEN_STATE_STORE"];
      else process.env["TOKENLIGHTEN_STATE_STORE"] = saved;
      resetStateStoresForTests();
    }
  });
});

describe("V11-04 decodeIrState", () => {
  it("round-trips a well-formed state through JSON", () => {
    const s = state({
      taskRef: "t",
      lane: "agent-a",
      evidenceCatalog: [evidence("e1", "src/a.ts")],
      obligations: [node("a", { evidenceRefs: ["e1"] })],
    });
    expect(decodeIrState(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });

  it("refuses anything that is not an irVersion 2 object", () => {
    for (const bad of [undefined, null, 5, "x", [], {}, { irVersion: 1 }]) {
      expect(decodeIrState(bad)).toBeUndefined();
    }
  });
});
