/**
 * reasoningIrV2Projection.spec.ts — V11-04 acceptance: the IR v2 projection and
 * the ONE advisory dispatch seam.
 *
 * Covers:
 *   - the projection's purity, caps, DAG derivation and advisory posture;
 *   - stable evidence ids, which are what make cross-pack deltas possible;
 *   - the seam's flag gate: OFF is unreachable and the pack bytes are
 *     identical; ON emits trace-only records and persists IR state;
 *   - the seam never alters a response, even when the IR path throws.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { TaskPackResult } from "../features/task-pack/model.js";
import {
  deriveEditClosureOps,
  deriveProjectionOps,
  emptyIrV2State,
  projectTaskReasoningIrV2,
  IRV2_GOAL_MAX_CHARS,
  IRV2_OBLIGATIONS_MAX,
} from "../task-state/reasoningIrV2.js";
import {
  deriveIrTaskRef,
  recordReasoningIrV2ClosureFromEdit,
  recordReasoningIrV2FromPack,
} from "../task-state/irDispatchSeam.js";
import { irStateKey, loadIrState } from "../task-state/irStore.js";
import { applyReasoningDelta, buildReasoningDelta, computeTaskStateHash } from "../task-state/reasoningDelta.js";
import { resetStateStoresForTests } from "../state/stateStore.js";
import { getTracePath, setTraceEnabledForTest } from "../util/trace.js";
import { callTool } from "../server.js";
import { resetAll } from "../state/session.js";
import { resetPackServeLogForTest } from "../util/packServeLog.js";
import { clearPackDedupeForWorkspace } from "../features/task-pack/readCodeTaskPack.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();
const dirs: string[] = [];

function mkWs(tag: string): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(HOME, `.tl-irv2p-${tag}-`)));
  dirs.push(d);
  return d;
}
function write(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

beforeEach(() => {
  resetAll();
  resetPackServeLogForTest();
  resetStateStoresForTests();
  delete process.env["TL_REASONING_IR_V2"];
});

afterEach(() => {
  delete process.env["TL_REASONING_IR_V2"];
  setTraceEnabledForTest(undefined);
});

afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

function pack(overrides: Partial<TaskPackResult> = {}): TaskPackResult {
  return {
    mode: "task_pack",
    coverage: "focused",
    surfaces: [
      { role: "target", handle: "h1", path: "src/a.ts", range: "1-20", sha: "aaa" },
      { role: "consumer", handle: "h2", path: "src/b.ts", range: "1-30", sha: "bbb" },
      { role: "test", handle: "h3", path: "src/c.test.ts", range: "1-40", sha: "ccc" },
    ],
    missing: [],
    qref: "q-1",
    ...overrides,
  } as TaskPackResult;
}

function contract(obligations: Array<Record<string, unknown>>): TaskPackResult["change_contract"] {
  return {
    version: 1,
    status: "ready",
    discovery_complete: true,
    obligations: obligations as never,
    stages: [],
    missing: [],
    max_additional_tl_calls: 0,
  } as TaskPackResult["change_contract"];
}

function obligation(id: string, handle: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    kind: "implementation",
    action: "edit",
    status: "ready",
    required: true,
    handle,
    path: "src/a.ts",
    range: "1-20",
    role: "target",
    depends_on: [],
    ...overrides,
  };
}

describe("V11-04 projection — purity and shape", () => {
  it("does not mutate the pack result", () => {
    const p = pack();
    const before = JSON.stringify(p);
    projectTaskReasoningIrV2({ result: p, taskId: "t", query: "do it" });
    expect(JSON.stringify(p)).toBe(before);
  });

  it("is deterministic: the same input hashes identically", () => {
    const a = projectTaskReasoningIrV2({ result: pack(), taskId: "t", query: "do it" });
    const b = projectTaskReasoningIrV2({ result: pack(), taskId: "t", query: "do it" });
    expect(a.stateHash).toBe(b.stateHash);
    expect(computeTaskStateHash(a)).toBe(a.stateHash);
  });

  it("mints STABLE, content-derived evidence ids (v1's positional ids cannot survive a re-pack)", () => {
    const first = projectTaskReasoningIrV2({ result: pack(), taskId: "t" });
    // A second pack that serves the SAME surface plus one more.
    const second = projectTaskReasoningIrV2({
      result: pack({
        surfaces: [
          { role: "target", handle: "hX", path: "src/a.ts", range: "1-20", sha: "aaa" },
          { role: "doc", handle: "hY", path: "docs/x.md", range: "1-5", sha: "ddd" },
        ],
      }),
      taskId: "t",
    });
    const firstIds = new Set(first.evidenceCatalog.map((e) => e.evidenceId));
    // The re-served surface keeps its identity even though the HANDLE changed.
    expect(firstIds.has(second.evidenceCatalog[0]!.evidenceId)).toBe(true);
  });

  it("classes a surface with no sha as structural, never direct", () => {
    const p = pack({ surfaces: [{ role: "target", handle: "h1", path: "src/a.ts", range: "1-9" }] });
    const ir = projectTaskReasoningIrV2({ result: p, taskId: "t" });
    expect(ir.evidenceCatalog[0]).toMatchObject({ evidenceClass: "structural" });
    expect(ir.evidenceCatalog[0]!.validityKeys).toEqual([]);
  });

  it("caps the goal", () => {
    const ir = projectTaskReasoningIrV2({ result: pack(), taskId: "t", query: "x".repeat(2000) });
    expect(ir.goal).toHaveLength(IRV2_GOAL_MAX_CHARS);
  });

  it("caps the obligation list", () => {
    const many = Array.from({ length: IRV2_OBLIGATIONS_MAX + 20 }, (_, i) => obligation(`o${i}`, "h1"));
    const ir = projectTaskReasoningIrV2({ result: pack({ change_contract: contract(many) }), taskId: "t" });
    expect(ir.obligations.length).toBeLessThanOrEqual(IRV2_OBLIGATIONS_MAX);
  });
});

describe("V11-04 projection — DAG, origin and the advisory rule", () => {
  it("threads change_contract `depends_on` into dependency edges", () => {
    const ir = projectTaskReasoningIrV2({
      result: pack({
        change_contract: contract([
          obligation("o1", "h1"),
          obligation("o2", "h2", { path: "src/b.ts" }),
          obligation("o3", "h3", { path: "src/c.test.ts", depends_on: ["o1", "o2"] }),
        ]),
      }),
      taskId: "t",
    });
    expect(ir.dagEnabled).toBe(true);
    expect(ir.obligations.find((o) => o.id === "pack:o3")!.blockedBy).toEqual(["pack:o1", "pack:o2"]);
  });

  it("drops an edge to an obligation the pack trimmed (dangling edges block forever)", () => {
    const ir = projectTaskReasoningIrV2({
      result: pack({
        change_contract: contract([
          obligation("o1", "h1"),
          obligation("o2", "h2", { depends_on: ["ghost"] }),
          obligation("o3", "h3"),
        ]),
      }),
      taskId: "t",
    });
    expect(ir.obligations.find((o) => o.id === "pack:o2")!.blockedBy).toEqual([]);
  });

  it("generates NO edges for a local task (<=2 sites and <=2 obligations)", () => {
    const ir = projectTaskReasoningIrV2({
      result: pack({
        surfaces: [{ role: "target", handle: "h1", path: "src/a.ts", range: "1-20", sha: "aaa" }],
        change_contract: contract([obligation("o1", "h1"), obligation("o2", "h1", { depends_on: ["o1"] })]),
      }),
      taskId: "t",
    });
    expect(ir.dagEnabled).toBe(false);
    expect(ir.obligations.every((o) => o.blockedBy.length === 0)).toBe(true);
  });

  it("makes capability gaps HEURISTIC, therefore advisory, therefore never blocking", () => {
    const ir = projectTaskReasoningIrV2({
      result: pack({
        execution_contract: {
          typestate: { phase: "discovering" },
          reason: "the intent is ambiguous",
          capability_gaps: [{ kind: "semantic", reason: "the intent is ambiguous" }],
        } as never,
      }),
      taskId: "t",
    });
    const gap = ir.obligations.find((o) => o.id.startsWith("gap:"));
    expect(gap).toMatchObject({ origin: "heuristic", advisory: true, predicate: { kind: "manual" } });
  });

  it("stays TOTAL on a partially-shaped execution_contract (decision degrades to pending)", () => {
    // `deriveCanonicalTaskDecision` reads `execution_contract.typestate.phase`
    // unguarded. A projection that threw here would be unusable to any future
    // non-seam consumer, so the throw is absorbed.
    const ir = projectTaskReasoningIrV2({
      result: pack({ execution_contract: { capability_gaps: [] } as never }),
      taskId: "t",
    });
    expect(ir.decision.state).toBe("pending");
  });

  it("a `needs-context` obligation lands BLOCKED, not open", () => {
    const ir = projectTaskReasoningIrV2({
      result: pack({ change_contract: contract([obligation("o1", "h1", { status: "needs-context" })]) }),
      taskId: "t",
    });
    expect(ir.obligations[0]!.state).toBe("blocked");
  });

  it("degrades to a flat list rather than failing when the pack hands it a cycle", () => {
    const ir = projectTaskReasoningIrV2({
      result: pack({
        change_contract: contract([
          obligation("o1", "h1", { depends_on: ["o3"] }),
          obligation("o2", "h2", { depends_on: ["o1"] }),
          obligation("o3", "h3", { depends_on: ["o2"] }),
        ]),
      }),
      taskId: "t",
    });
    expect(ir.obligations).toHaveLength(3);
    expect(ir.obligations.every((o) => o.blockedBy.length === 0)).toBe(true);
  });
});

describe("V11-04 projection — cumulative merge and delta derivation", () => {
  it("carries prior evidence and closures forward", () => {
    const first = projectTaskReasoningIrV2({ result: pack(), taskId: "t" });
    const second = projectTaskReasoningIrV2({
      result: pack({ surfaces: [{ role: "doc", handle: "hD", path: "docs/x.md", range: "1-5", sha: "ddd" }] }),
      taskId: "t",
      prior: first,
    });
    // Union, not replacement: a narrower re-pack does not retract evidence.
    expect(second.evidenceCatalog.length).toBe(first.evidenceCatalog.length + 1);
  });

  it("derives ops that carry prior to projected, and applying them lands", () => {
    const first = projectTaskReasoningIrV2({ result: pack(), taskId: "t" });
    const projected = projectTaskReasoningIrV2({
      result: pack({
        surfaces: [{ role: "doc", handle: "hD", path: "docs/x.md", range: "1-5", sha: "ddd" }],
        change_contract: contract([obligation("o1", "hD", { path: "docs/x.md" })]),
      }),
      taskId: "t",
      prior: first,
    });
    const ops = deriveProjectionOps(first, projected);
    expect(ops.length).toBeGreaterThan(0);
    const built = buildReasoningDelta(first, ops);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(applyReasoningDelta(first, built.delta)).toMatchObject({ ok: true, outcome: "applied" });
  });

  it("derives NO ops when the pack establishes nothing new", () => {
    const first = projectTaskReasoningIrV2({ result: pack(), taskId: "t" });
    const same = projectTaskReasoningIrV2({ result: pack(), taskId: "t", prior: first });
    expect(deriveProjectionOps(first, same)).toEqual([]);
  });

  it("emptyIrV2State is self-consistent", () => {
    const empty = emptyIrV2State("t", "lane-a");
    expect(computeTaskStateHash(empty)).toBe(empty.stateHash);
    expect(empty.stateVersion).toBe(0);
  });
});

describe("V11-04 projection — deriveEditClosureOps (A1-pre edit-driven closure)", () => {
  it("closes an open, non-advisory obligation whose grounding evidence path was just edited", () => {
    const projected = projectTaskReasoningIrV2({
      result: pack({ change_contract: contract([obligation("o1", "h1")]) }),
      taskId: "t",
    });
    expect(projected.obligations[0]).toMatchObject({ id: "pack:o1", state: "open" });

    const ops = deriveEditClosureOps(projected, ["src/a.ts"]);
    expect(ops).toEqual([{ op: "close", target: "obligation", id: "pack:o1" }]);
  });

  it("emits NOTHING for an edited path that grounds no obligation", () => {
    const projected = projectTaskReasoningIrV2({
      result: pack({ change_contract: contract([obligation("o1", "h1")]) }),
      taskId: "t",
    });
    expect(deriveEditClosureOps(projected, ["src/unrelated.ts"])).toEqual([]);
  });

  it("never closes a node canClose rejects — a still-open dependency blocks it despite the edit (false-satisfied guard)", () => {
    const projected = projectTaskReasoningIrV2({
      result: pack({
        change_contract: contract([
          obligation("o1", "h1"), // path defaults to src/a.ts — NOT edited below
          obligation("o2", "h2", { path: "src/b.ts", depends_on: ["o1"] }),
        ]),
      }),
      taskId: "t",
    });
    expect(projected.obligations.find((o) => o.id === "pack:o2")).toMatchObject({ state: "open", blockedBy: ["pack:o1"] });

    // o2's own evidence path (src/b.ts) WAS edited, but o1 never was — canClose
    // must still refuse o2, so no op is emitted for it.
    const ops = deriveEditClosureOps(projected, ["src/b.ts"]);
    expect(ops).toEqual([]);
  });

  it("never closes an ADVISORY (heuristic) node, even one that happens to share a grounding path", () => {
    const projected = projectTaskReasoningIrV2({
      result: pack({
        execution_contract: {
          typestate: { phase: "discovering" },
          reason: "the intent is ambiguous",
          capability_gaps: [{ kind: "semantic", reason: "the intent is ambiguous" }],
        } as never,
      }),
      taskId: "t",
    });
    const gap = projected.obligations.find((o) => o.id.startsWith("gap:"))!;
    expect(gap).toMatchObject({ advisory: true, state: "open" });
    // A heuristic gap carries no evidenceRefs, so it can never be a candidate —
    // proving both the advisory filter and the grounding filter reject it.
    expect(deriveEditClosureOps(projected, ["src/a.ts", "src/b.ts", "src/c.test.ts"])).toEqual([]);
  });

  it("closes a dependent obligation in the SAME edit event once its dependency closes first (fixed-point, not one pass)", () => {
    const projected = projectTaskReasoningIrV2({
      result: pack({
        change_contract: contract([
          obligation("o1", "h1"), // src/a.ts
          obligation("o2", "h2", { path: "src/b.ts", depends_on: ["o1"] }),
        ]),
      }),
      taskId: "t",
    });
    // A single batched edits[] call landed BOTH files in one edit_file success.
    const ops = deriveEditClosureOps(projected, ["src/a.ts", "src/b.ts"]);
    expect(new Set(ops.map((op) => (op as { id: string }).id))).toEqual(new Set(["pack:o1", "pack:o2"]));
  });

  it("is pure: does not mutate the state it is handed", () => {
    const projected = projectTaskReasoningIrV2({
      result: pack({ change_contract: contract([obligation("o1", "h1")]) }),
      taskId: "t",
    });
    const before = JSON.stringify(projected);
    deriveEditClosureOps(projected, ["src/a.ts"]);
    expect(JSON.stringify(projected)).toBe(before);
  });

  it("returns no ops with nothing to close: no edited paths, or no obligations at all", () => {
    const withObligation = projectTaskReasoningIrV2({
      result: pack({ change_contract: contract([obligation("o1", "h1")]) }),
      taskId: "t",
    });
    expect(deriveEditClosureOps(withObligation, [])).toEqual([]);

    const noObligations = projectTaskReasoningIrV2({ result: pack(), taskId: "t" });
    expect(deriveEditClosureOps(noObligations, ["src/a.ts"])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The dispatch seam
// ---------------------------------------------------------------------------

function traceEvents(ws: string): string[] {
  const file = getTracePath(ws);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => {
      try {
        return String((JSON.parse(l) as Record<string, unknown>)["event"] ?? "");
      } catch {
        return "";
      }
    });
}

describe("V11-04 deriveIrTaskRef — two tasks never share one record", () => {
  it("prefers an explicit id, then the qref, then a hash of the query", () => {
    expect(deriveIrTaskRef({ taskId: "explicit", qref: "q-1", query: "x" })).toBe("explicit");
    expect(deriveIrTaskRef({ qref: "q-1", query: "x" })).toBe("q-1");
    expect(deriveIrTaskRef({ query: "x" })).toMatch(/^q:[0-9a-f]{16}$/);
  });

  it("does NOT collapse to a constant when the qref is still unset at the seam", () => {
    // Dispatch attaches the replay ref AFTER the seam runs, so at seam time
    // `result.qref` is usually undefined. A constant fallback would file every
    // task in a workspace+lane under ONE record and merge unrelated state.
    const a = deriveIrTaskRef({ query: "rename the rate function" });
    const b = deriveIrTaskRef({ query: "add a currency column" });
    expect(a).not.toBe(b);
    expect(a).not.toBe("task");
  });

  it("is stable across re-packs of the same query — the accumulation key", () => {
    expect(deriveIrTaskRef({ query: "same task" })).toBe(deriveIrTaskRef({ query: "same task" }));
  });

  it("falls back to the constant only when there is nothing at all to key on", () => {
    expect(deriveIrTaskRef({})).toBe("task");
  });
});

describe("V11-04 dispatch seam — flag OFF is unreachable", () => {
  it("the helper is a total no-op with the flag unset: no trace, no state record", () => {
    const ws = mkWs("off");
    setTraceEnabledForTest(true);
    const before = traceEvents(ws).length;

    recordReasoningIrV2FromPack({ result: pack(), workspaceRoot: ws, lane: "", query: "do it" });

    expect(traceEvents(ws).slice(before).filter((e) => e.startsWith("reasoning_ir"))).toEqual([]);
    expect(loadIrState(ws, irStateKey({ workspaceRef: ws, taskRef: "q-1", lane: "" })))
      .toMatchObject({ ok: false, reason: "absent" });
  });

  it("with the flag ON the same call traces and persists (so OFF is proved, not vacuous)", () => {
    const ws = mkWs("on");
    setTraceEnabledForTest(true);
    process.env["TL_REASONING_IR_V2"] = "1";

    recordReasoningIrV2FromPack({ result: pack(), workspaceRoot: ws, lane: "", query: "do it" });

    expect(traceEvents(ws)).toContain("reasoning_ir_v2");
    const loaded = loadIrState(ws, irStateKey({ workspaceRef: ws, taskRef: "q-1", lane: "" }));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.state.evidenceCatalog).toHaveLength(3);
  });

  it("a second call on the same task advances by DELTA, not a fresh state", () => {
    const ws = mkWs("advance");
    process.env["TL_REASONING_IR_V2"] = "1";
    const key = irStateKey({ workspaceRef: ws, taskRef: "q-1", lane: "" });

    recordReasoningIrV2FromPack({ result: pack(), workspaceRoot: ws, lane: "", query: "do it" });
    recordReasoningIrV2FromPack({
      result: pack({ surfaces: [{ role: "doc", handle: "hD", path: "docs/x.md", range: "1-5", sha: "ddd" }] }),
      workspaceRoot: ws,
      lane: "",
      query: "do it",
    });

    const loaded = loadIrState(ws, key);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.deltaCount).toBe(1);
    expect(loaded.state.stateVersion).toBe(2);
    expect(loaded.state.evidenceCatalog).toHaveLength(4);
  });

  it("keeps two lanes of one workspace apart", () => {
    const ws = mkWs("seamlanes");
    process.env["TL_REASONING_IR_V2"] = "1";
    recordReasoningIrV2FromPack({ result: pack(), workspaceRoot: ws, lane: "agent-a", query: "do it" });

    expect(loadIrState(ws, irStateKey({ workspaceRef: ws, taskRef: "q-1", lane: "agent-a" })).ok).toBe(true);
    expect(loadIrState(ws, irStateKey({ workspaceRef: ws, taskRef: "q-1", lane: "agent-b" })))
      .toMatchObject({ ok: false, reason: "absent" });
  });

  it("swallows a malformed pack: it traces reasoning_ir_error and throws nothing", () => {
    const ws = mkWs("boom");
    setTraceEnabledForTest(true);
    process.env["TL_REASONING_IR_V2"] = "1";
    // `surfaces` is not an array — the projection will throw inside the seam.
    const broken = { mode: "task_pack", coverage: "focused", surfaces: 7, missing: [], qref: "q-b" } as unknown as TaskPackResult;

    expect(() => recordReasoningIrV2FromPack({ result: broken, workspaceRoot: ws, lane: "" })).not.toThrow();
    expect(traceEvents(ws)).toContain("reasoning_ir_error");
  });
});

describe("V11-04 dispatch seam — flags-off wire byte identity", () => {
  /**
   * A truly fresh session: in-process caches AND the on-disk state store. The
   * store outlives `resetStateStoresForTests()` (that clears the cache, not the
   * files), and a surviving served-surface ledger would make the second call
   * return a `prior` receipt instead of the bodies — a difference caused by
   * dedupe, not by the flag.
   */
  function freshSession(ws: string): void {
    resetAll();
    resetPackServeLogForTest();
    // The pack-dedupe / certified-working-set caches are module-local to
    // readCodeTaskPack and survive both resets above; without this the second
    // call returns `prior` receipts instead of bodies.
    clearPackDedupeForWorkspace(ws);
    resetStateStoresForTests();
    fs.rmSync(path.join(ws, ".tokenlighten"), { recursive: true, force: true });
  }

  /**
   * `task.id` is an HMAC over (workspace root, STORE EPOCH, fingerprint), and
   * wiping the store above mints a new epoch by design — so it cannot be equal
   * across the two runs for reasons that have nothing to do with this flag.
   * Everything else in the body is compared byte for byte.
   */
  function normalizeTaskHandle(text: string): string {
    return text.replace(/"id":"tlh_task_[A-Za-z0-9_-]+"/, '"id":"<task-handle>"');
  }

  it("a real read_file task_pack response is byte-identical with the flag on and off", async () => {
    const ws = mkWs("bytes");
    write(ws, "src/rate.ts", "export function rate(n: number): number {\n  return n * 2;\n}\n");
    write(ws, "src/use.ts", "import { rate } from './rate.js';\nexport const x = rate(2);\n");

    const args = { mode: "task_pack", query: "how does rate() compute its value", cwd: ws };

    delete process.env["TL_REASONING_IR_V2"];
    freshSession(ws);
    const off = (await callTool("read_file", args)) as { content: Array<{ text: string }> };

    process.env["TL_REASONING_IR_V2"] = "1";
    freshSession(ws);
    const on = (await callTool("read_file", args)) as { content: Array<{ text: string }> };

    // Guard against the normalization hiding an absence.
    expect(off.content[0]!.text).toContain("tlh_task_");
    expect(on.content[0]!.text).toContain("tlh_task_");
    expect(normalizeTaskHandle(on.content[0]!.text)).toBe(normalizeTaskHandle(off.content[0]!.text));

    // …and the flag-on run really did build IR state, so the identity above is
    // a statement about the SEAM, not about a branch that never ran.
    const taskRef = deriveIrTaskRef({ query: args.query });
    expect(loadIrState(ws, irStateKey({ workspaceRef: ws, taskRef, lane: "" })).ok).toBe(true);
  });
});

describe("V11-04 dispatch seam — recordReasoningIrV2ClosureFromEdit (A1-pre)", () => {
  it("task_pack opens an obligation (no candidate) → edit closes it → the NEXT task_pack evaluation emits the shadow candidate", () => {
    const ws = mkWs("editclosure");
    setTraceEnabledForTest(true);
    process.env["TL_REASONING_IR_V2"] = "1";
    const key = irStateKey({ workspaceRef: ws, taskRef: "q-1", lane: "" });
    const openPack = (): TaskPackResult =>
      pack({ coverage: "complete", change_contract: contract([obligation("o1", "h1")]) });

    // 1) task_pack: a real, non-advisory obligation on src/a.ts, still open.
    recordReasoningIrV2FromPack({ result: openPack(), workspaceRoot: ws, lane: "", query: "do it" });
    expect(traceEvents(ws).filter((e) => e === "shadow_stop_candidate")).toEqual([]);
    const loadedAfterPack = loadIrState(ws, key);
    expect(loadedAfterPack.ok).toBe(true);
    if (!loadedAfterPack.ok) return;
    expect(loadedAfterPack.state.obligations[0]).toMatchObject({ id: "pack:o1", state: "open" });

    // 2) edit_file: the certificate's own path (src/a.ts) lands.
    recordReasoningIrV2ClosureFromEdit({ workspaceRoot: ws, lane: "", taskId: "q-1", editedPaths: ["src/a.ts"] });
    expect(traceEvents(ws)).toContain("reasoning_ir_v2_edit_closure");
    const loadedAfterEdit = loadIrState(ws, key);
    expect(loadedAfterEdit.ok).toBe(true);
    if (!loadedAfterEdit.ok) return;
    expect(loadedAfterEdit.state.obligations[0]).toMatchObject({ id: "pack:o1", state: "satisfied" });
    // An edit call never runs evaluateShadowStop itself — no candidate yet.
    expect(traceEvents(ws).filter((e) => e === "shadow_stop_candidate")).toEqual([]);

    // 3) the NEXT task_pack call for the SAME task: mergeWithPrior only ever
    // ADDS, so the persisted "satisfied" o1 survives the fresh (open) re-
    // projection unchanged, and THIS call's own evaluateShadowStop sees a
    // fully-closed state against its fresh, complete coverage.
    recordReasoningIrV2FromPack({ result: openPack(), workspaceRoot: ws, lane: "", query: "do it" });
    expect(traceEvents(ws)).toContain("shadow_stop_candidate");
  });

  it("a taskId with no prior IR state is a no-op — it never conjures a task into existence", () => {
    const ws = mkWs("editclosure-noprior");
    setTraceEnabledForTest(true);
    process.env["TL_REASONING_IR_V2"] = "1";
    recordReasoningIrV2ClosureFromEdit({ workspaceRoot: ws, lane: "", taskId: "q-ghost", editedPaths: ["src/a.ts"] });
    expect(traceEvents(ws).filter((e) => e.startsWith("reasoning_ir"))).toEqual([]);
    expect(loadIrState(ws, irStateKey({ workspaceRef: ws, taskRef: "q-ghost", lane: "" })))
      .toMatchObject({ ok: false, reason: "absent" });
  });

  it("is unreachable with the flag off", () => {
    const ws = mkWs("editclosure-off");
    setTraceEnabledForTest(true);
    delete process.env["TL_REASONING_IR_V2"];
    recordReasoningIrV2FromPack({ result: pack(), workspaceRoot: ws, lane: "", query: "do it" });
    recordReasoningIrV2ClosureFromEdit({ workspaceRoot: ws, lane: "", taskId: "q-1", editedPaths: ["src/a.ts"] });
    expect(traceEvents(ws).filter((e) => e.startsWith("reasoning_ir"))).toEqual([]);
  });
});
