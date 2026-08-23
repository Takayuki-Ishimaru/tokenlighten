/**
 * reasoningIrV2Dag.spec.ts — V11-04 acceptance: the obligation DAG and its
 * single closure gate.
 *
 * Plan §7 V11-04 acceptance rows covered here:
 *   - "invalid obligation closure 0件"  → every illegitimate closure path is
 *     refused by `canClose`, and a cyclic edge set is refused at construction;
 *   - "1〜2箇所の局所taskではDAGを生成しない" → the local-task passthrough.
 * Plus reconciliation §3's common rule that heuristic evidence never closes an
 * obligation, and E-7's advisory hint interface.
 */

import { describe, it, expect } from "vitest";
import {
  buildObligationDag,
  canClose,
  deriveDagEnabled,
  isLocalTaskShape,
  openObligationHints,
  validateObligationEdges,
  LOCAL_TASK_MAX_OBLIGATIONS,
  LOCAL_TASK_MAX_SITES,
} from "../task-state/obligationDag.js";
import { evidence, node, state } from "./helpers/irV2Fixtures.js";

describe("V11-04 obligation DAG — construction", () => {
  it("refuses a cyclic dependency edge set and names the cycle", () => {
    const result = buildObligationDag({
      nodes: [
        node("a", { blockedBy: ["b"] }),
        node("b", { blockedBy: ["c"] }),
        node("c", { blockedBy: ["a"] }),
      ],
      siteCount: 5,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("cyclic-dependency");
    // The cycle is reported, not merely detected — a caller has to be able to
    // say WHICH edges are impossible.
    expect(result.cycle).toBeDefined();
    expect(new Set(result.cycle)).toEqual(new Set(["a", "b", "c"]));
  });

  it("refuses a self-edge, a dangling edge, and a duplicate id", () => {
    expect(buildObligationDag({ nodes: [node("a", { blockedBy: ["a"] })], siteCount: 9 }))
      .toMatchObject({ ok: false, reason: "self-dependency" });
    expect(buildObligationDag({ nodes: [node("a", { blockedBy: ["ghost"] })], siteCount: 9 }))
      .toMatchObject({ ok: false, reason: "unknown-dependency" });
    expect(buildObligationDag({ nodes: [node("a"), node("a")], siteCount: 9 }))
      .toMatchObject({ ok: false, reason: "duplicate-node" });
  });

  it("accepts a legal DAG and forces `advisory` from `origin`", () => {
    const result = buildObligationDag({
      nodes: [
        node("a"),
        // A caller claiming a heuristic node is non-advisory must not be believed.
        { ...node("b", { origin: "heuristic", blockedBy: ["a"] }), advisory: false },
      ],
      siteCount: 4,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dagEnabled).toBe(true);
    expect(result.nodes[1]!.advisory).toBe(true);
  });
});

describe("V11-04 obligation DAG — the local-task rule (no DAG for 1-2 sites)", () => {
  it("classifies by BOTH dimensions", () => {
    expect(isLocalTaskShape(LOCAL_TASK_MAX_SITES, LOCAL_TASK_MAX_OBLIGATIONS)).toBe(true);
    expect(isLocalTaskShape(LOCAL_TASK_MAX_SITES + 1, LOCAL_TASK_MAX_OBLIGATIONS)).toBe(false);
    expect(isLocalTaskShape(LOCAL_TASK_MAX_SITES, LOCAL_TASK_MAX_OBLIGATIONS + 1)).toBe(false);
  });

  it("DROPS edges for a local task — a flat v1-style list passes through", () => {
    const result = buildObligationDag({
      nodes: [node("a"), node("b", { blockedBy: ["a"] })],
      siteCount: 2,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dagEnabled).toBe(false);
    // Dropped, not ignored: the persisted node carries no edge at all, so the
    // same state cannot later be re-read as a graph.
    expect(result.nodes.map((n) => n.blockedBy)).toEqual([[], []]);
  });

  it("a local task's second node closes with no dependency wait", () => {
    const built = buildObligationDag({ nodes: [node("a"), node("b", { blockedBy: ["a"], evidenceRefs: ["e1"] })], siteCount: 1 });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const s = state({ obligations: built.nodes, evidenceCatalog: [evidence("e1", "src/a.ts")] });
    expect(canClose("b", s)).toEqual({ ok: true });
  });

  it("dagEnabled is DERIVED from hashed content, so a replay reproduces it", () => {
    expect(deriveDagEnabled([node("a"), node("b")])).toBe(false);
    expect(deriveDagEnabled([node("a"), node("b"), node("c")])).toBe(true);
    expect(deriveDagEnabled([node("a"), node("b", { blockedBy: ["a"] })])).toBe(true);
  });
});

describe("V11-04 canClose — the single closure gate (invalid closure 0)", () => {
  const catalog = [evidence("e1", "src/a.ts"), evidence("eh", "src/guess.ts", "heuristic")];

  it("closes a grounded node with no dependencies", () => {
    const s = state({ obligations: [node("a", { evidenceRefs: ["e1"] })], evidenceCatalog: catalog });
    expect(canClose("a", s)).toEqual({ ok: true });
  });

  it("refuses an unknown node and an invalidated node", () => {
    const s = state({ obligations: [node("a", { state: "invalidated", evidenceRefs: ["e1"] })], evidenceCatalog: catalog });
    expect(canClose("ghost", s)).toMatchObject({ ok: false, reason: "unknown-node" });
    expect(canClose("a", s)).toMatchObject({ ok: false, reason: "invalidated" });
  });

  it("refuses a node grounded ONLY in heuristic evidence", () => {
    const s = state({ obligations: [node("a", { evidenceRefs: ["eh"] })], evidenceCatalog: catalog });
    expect(canClose("a", s)).toMatchObject({ ok: false, reason: "predicate-unsatisfied" });
  });

  it("refuses a node whose evidence ref does not resolve in the catalog", () => {
    const s = state({ obligations: [node("a", { evidenceRefs: ["missing"] })], evidenceCatalog: catalog });
    expect(canClose("a", s)).toMatchObject({ ok: false, reason: "predicate-unsatisfied" });
  });

  it("a `manual` predicate is never auto-satisfiable, however much evidence it has", () => {
    const s = state({
      obligations: [node("a", { evidenceRefs: ["e1"], predicate: { kind: "manual" } })],
      evidenceCatalog: catalog,
    });
    expect(canClose("a", s)).toMatchObject({ ok: false, reason: "predicate-unsatisfied" });
  });

  it("min-grounded-evidence counts GROUNDED items only", () => {
    const s = state({
      obligations: [node("a", { evidenceRefs: ["e1", "eh"], predicate: { kind: "min-grounded-evidence", count: 2 } })],
      evidenceCatalog: catalog,
    });
    expect(canClose("a", s)).toMatchObject({ ok: false, reason: "predicate-unsatisfied" });
  });

  it("named-evidence requires every named id, grounded", () => {
    const s = state({
      obligations: [node("a", { evidenceRefs: ["e1"], predicate: { kind: "named-evidence", evidenceIds: ["e1", "e2"] } })],
      evidenceCatalog: catalog,
    });
    expect(canClose("a", s)).toMatchObject({ ok: false, reason: "predicate-unsatisfied" });
  });

  it("blocks on an open non-advisory dependency and names it", () => {
    const s = state({
      obligations: [node("dep"), node("a", { blockedBy: ["dep"], evidenceRefs: ["e1"] })],
      evidenceCatalog: catalog,
    });
    expect(canClose("a", s)).toMatchObject({ ok: false, reason: "dependency-open", blocking: ["dep"] });
  });

  it("an ADVISORY dependency never blocks a non-advisory node", () => {
    const s = state({
      obligations: [
        node("guess", { origin: "heuristic" }),
        node("a", { blockedBy: ["guess"], evidenceRefs: ["e1"] }),
      ],
      evidenceCatalog: catalog,
    });
    expect(canClose("a", s)).toEqual({ ok: true });
  });

  it("an advisory node still respects its OWN advisory dependencies", () => {
    const s = state({
      obligations: [
        node("guess", { origin: "heuristic" }),
        node("b", { origin: "heuristic", blockedBy: ["guess"], evidenceRefs: ["e1"] }),
      ],
      evidenceCatalog: catalog,
    });
    expect(canClose("b", s)).toMatchObject({ ok: false, reason: "dependency-open", blocking: ["guess"] });
  });

  it("a DANGLING dependency blocks — it cannot be proved advisory", () => {
    // Construction refuses this shape; a hand-built or tampered state can still
    // carry it, and the gate must fail closed rather than wave it through.
    const s = state({
      obligations: [node("a", { blockedBy: ["ghost"], evidenceRefs: ["e1"] })],
      evidenceCatalog: catalog,
    });
    expect(canClose("a", s)).toMatchObject({ ok: false, reason: "dependency-open", blocking: ["ghost"] });
  });
});

describe("V11-04 E-7 boundary — openObligationHints", () => {
  it("reports every open node with its reason, weight and uris, non-advisory first", () => {
    const s = state({
      obligations: [
        node("guess", { origin: "heuristic", predicate: { kind: "manual" } }),
        node("dep"),
        node("a", { blockedBy: ["dep"], evidenceRefs: ["e1"] }),
        node("done", { state: "satisfied", evidenceRefs: ["e1"] }),
      ],
      evidenceCatalog: [evidence("e1", "src/a.ts")],
    });
    const hints = openObligationHints(s);
    expect(hints.map((h) => h.obligationId)).toEqual(["dep", "a", "guess"]);
    expect(hints.find((h) => h.obligationId === "a")).toMatchObject({
      reason: "dependency-open",
      blocking: ["dep"],
      uris: ["src/a.ts"],
      weight: 1,
    });
    expect(hints.find((h) => h.obligationId === "guess")).toMatchObject({ advisory: true, weight: 0.25 });
    // A satisfied node is not open work and never appears.
    expect(hints.some((h) => h.obligationId === "done")).toBe(false);
  });

  it("is advisory-only: it names no required surface and constrains no tool", () => {
    const hints = openObligationHints(state({ obligations: [node("a")] }));
    const keys = Object.keys(hints[0]!).sort();
    expect(keys).toEqual([
      "advisory", "blocking", "claim", "groundedEvidenceIds", "obligationId", "reason", "uris", "weight",
    ]);
  });
});

describe("V11-04 validateObligationEdges is the ONE acyclicity definition", () => {
  it("returns undefined for a legal set and a refusal for a cycle", () => {
    expect(validateObligationEdges([node("a"), node("b", { blockedBy: ["a"] })])).toBeUndefined();
    expect(validateObligationEdges([node("a", { blockedBy: ["b"] }), node("b", { blockedBy: ["a"] })]))
      .toMatchObject({ reason: "cyclic-dependency" });
  });
});
