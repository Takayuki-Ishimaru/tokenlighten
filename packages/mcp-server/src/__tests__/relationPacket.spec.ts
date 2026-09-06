// ---------------------------------------------------------------------------
// relationPacket.spec.ts — W-RELATION-PACKET acceptance tests.
//
// Covers: bounded fan-out with explicit truncation counts (>=60 callers),
// determinism, qualified-anchor class scoping (D5), byte-budget shedding
// order (definition > declaration > callers > callees > implementations),
// the `plan.wiring.evidence_graph` projection's shape parity against the
// EXISTING `TaskEvidenceGraph` wire type, the `relation_packet_one_shot`
// metric primitive, and the "imported only by tests" purity guard for this
// not-yet-wired module.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { symbolNode, type GraphEdge, type GraphEdgeType, type GraphNode } from "../features/graph-evidence/model.js";
import {
  compileRelationPacket,
  projectRelationPacketToEvidenceGraph,
  relationPacketOneShot,
  DEFAULT_RELATION_PACKET_BUDGET,
  type RelationGraphPort,
  type RelationPacket,
} from "../features/graph-evidence/relationPacket.js";
import { mintRelationHandles } from "../features/graph-evidence/relationGraphPort.js";
import type { TaskEvidenceGraph } from "@tokenlighten/types";

function mkEdge(type: GraphEdgeType, from: GraphNode, to: GraphNode): GraphEdge {
  return {
    type,
    from,
    to,
    evidenceClass: "direct",
    provider: "fixture-references",
    providerKind: "reference-index",
    sourceSha: "sha256:fixture",
    sourceShaPath: from.path,
    indexGeneration: "gen-1",
    coverage: "complete",
    rule: "fixture-rule",
    corroboration: ["exact-symbol-match"],
  };
}

// ---------------------------------------------------------------------------
// 1. Bounded fan-out — >=60 callers, explicit truncation counts
// ---------------------------------------------------------------------------

describe("fan-out bounding (W6's named risk)", () => {
  it("admits up to the node budget and reports the rest as truncated, never silently", () => {
    const anchorNode = symbolNode("src/target.ts", "run", "reference-index", { line: 10 });
    const callerNodes: GraphNode[] = Array.from({ length: 60 }, (_, i) =>
      symbolNode(`src/caller${String(i).padStart(3, "0")}.ts`, `caller${i}`, "reference-index", { line: 1 }),
    );
    const edges = callerNodes.map((c) => mkEdge("CALLED_BY", anchorNode, c));
    const port: RelationGraphPort = {
      resolveDefinition: (anchor) => (anchor.symbol === "run" ? { node: anchorNode, range: "10-20" } : undefined),
      edgesFor: () => edges,
    };

    const packet = compileRelationPacket({ anchor: { symbol: "run" }, graph: port });

    expect(packet.resolved).toBe(true);
    expect(packet.definition?.path).toBe("src/target.ts");
    const expectedAdmitted = DEFAULT_RELATION_PACKET_BUDGET.maxNodes - 1; // 1 node spent on the definition
    expect(packet.callers!.length).toBe(expectedAdmitted);
    expect(packet.truncated.callers).toBe(60 - expectedAdmitted);
    expect(packet.callees).toEqual([]);
    expect(packet.bytes).toBeLessThanOrEqual(DEFAULT_RELATION_PACKET_BUDGET.maxBytes);
    // Deterministic: the admitted callers are the lexicographically-first ones.
    expect(packet.callers!.map((c) => c.path)).toEqual(
      callerNodes.slice(0, expectedAdmitted).map((n) => n.path),
    );
  });

  it("bounds the combined edge count independently of the node budget", () => {
    const anchorNode = symbolNode("src/target.ts", "run", "reference-index", { line: 5 });
    const callerNodes = Array.from({ length: 30 }, (_, i) =>
      symbolNode(`src/caller${String(i).padStart(2, "0")}.ts`, `c${i}`, "reference-index", { line: 1 }),
    );
    const calleeNodes = Array.from({ length: 30 }, (_, i) =>
      symbolNode(`src/callee${String(i).padStart(2, "0")}.ts`, `d${i}`, "reference-index", { line: 1 }),
    );
    const edges = [
      ...callerNodes.map((c) => mkEdge("CALLED_BY", anchorNode, c)),
      ...calleeNodes.map((c) => mkEdge("CALLS", anchorNode, c)),
    ];
    const port: RelationGraphPort = { resolveDefinition: () => ({ node: anchorNode }), edgesFor: () => edges };

    const packet = compileRelationPacket({
      anchor: { symbol: "run" },
      graph: port,
      budget: { maxNodes: 1000, maxEdges: 48, maxBytes: 65536 },
    });

    expect(packet.callers!.length).toBe(30);
    expect(packet.truncated.callers).toBe(0);
    expect(packet.callees!.length).toBe(18);
    expect(packet.truncated.callees).toBe(12);
  });
});

// ---------------------------------------------------------------------------
// 1b. Anchor byte bounding (F1, round 11) — the anchor itself is the one
//     packet field every other test above leaves untouched by shedding; a
//     pathologically long anchor string used to make `bytes <= maxBytes`
//     false with nothing left to shed. The real, documented invariant is
//     `bytes <= maxBytes || over_budget === true`.
// ---------------------------------------------------------------------------

describe("anchor byte bounding (F1: an unsheddable anchor must not blow the byte budget)", () => {
  it("bounds a pathologically long anchor symbol so bytes <= maxBytes holds even with a real definition", () => {
    const hugeSymbol = "x".repeat(50_000);
    const anchorNode = symbolNode("src/target.ts", hugeSymbol, "reference-index", { line: 1 });
    const port: RelationGraphPort = {
      resolveDefinition: () => ({ node: anchorNode, range: "1-1" }),
      edgesFor: () => [],
    };

    const packet = compileRelationPacket({ anchor: { symbol: hugeSymbol }, graph: port });

    expect(packet.bytes).toBeLessThanOrEqual(DEFAULT_RELATION_PACKET_BUDGET.maxBytes);
    expect(packet.over_budget).toBeFalsy();
    expect(packet.resolved).toBe(true);
    expect(packet.definition).toBeDefined();
    // Bounded (disclosed), never the raw 50,000-char string.
    expect(packet.anchor.symbol!.length).toBeLessThan(hugeSymbol.length);
    expect(packet.anchor.symbol).toMatch(/chars elided, sha256:/);
  });

  it("bounds a pathologically long qualified anchor (class and member) the same way", () => {
    const hugeClass = "C".repeat(1_000);
    const hugeMember = "m".repeat(1_000);
    const anchorNode = symbolNode("src/target.cpp", `${hugeClass}::${hugeMember}`, "parser", { line: 1 });
    const port: RelationGraphPort = {
      resolveDefinition: () => ({ node: anchorNode, range: "1-1" }),
      edgesFor: () => [],
    };

    const packet = compileRelationPacket({
      anchor: { qualified: { class: hugeClass, member: hugeMember } },
      graph: port,
    });

    expect(packet.bytes).toBeLessThanOrEqual(DEFAULT_RELATION_PACKET_BUDGET.maxBytes);
    expect(packet.over_budget).toBeFalsy();
    expect(packet.anchor.qualified!.class.length).toBeLessThan(hugeClass.length);
    expect(packet.anchor.qualified!.member.length).toBeLessThan(hugeMember.length);
  });

  it("never bounds a short, ordinary anchor — the bounding is a no-op below the threshold", () => {
    const anchorNode = symbolNode("src/target.ts", "run", "reference-index", { line: 1 });
    const port: RelationGraphPort = { resolveDefinition: () => ({ node: anchorNode }), edgesFor: () => [] };
    const packet = compileRelationPacket({ anchor: { symbol: "run" }, graph: port });
    expect(packet.anchor).toEqual({ symbol: "run" });
  });

  it("reports over_budget:true (never silently exceeds) when even the bounded anchor cannot fit an extreme budget", () => {
    const hugeSymbol = "y".repeat(50_000);
    const anchorNode = symbolNode("src/target.ts", hugeSymbol, "reference-index", { line: 1 });
    const port: RelationGraphPort = {
      resolveDefinition: () => ({ node: anchorNode, range: "1-1" }),
      edgesFor: () => [],
    };

    const packet = compileRelationPacket({
      anchor: { symbol: hugeSymbol },
      graph: port,
      budget: { maxNodes: 24, maxEdges: 48, maxBytes: 8 },
    });

    expect(packet.resolved).toBe(false);
    expect(packet.over_budget).toBe(true);
    expect(packet.bytes <= 8 || packet.over_budget === true).toBe(true);
  });

  it("documents bytes <= maxBytes || over_budget as the real invariant across a range of budgets", () => {
    const hugeSymbol = "z".repeat(10_000);
    const anchorNode = symbolNode("src/target.ts", hugeSymbol, "reference-index", { line: 1 });
    const port: RelationGraphPort = {
      resolveDefinition: () => ({ node: anchorNode, range: "1-1" }),
      edgesFor: () => [],
    };
    for (const maxBytes of [4096, 512, 128, 32, 8, 1]) {
      const packet = compileRelationPacket({ anchor: { symbol: hugeSymbol }, graph: port, budget: { maxBytes } });
      expect(packet.bytes <= maxBytes || packet.over_budget === true).toBe(true);
      // The forced-false invariant: `over_budget` never coexists with a
      // claimed-true `resolved`.
      if (packet.over_budget === true) expect(packet.resolved).toBe(false);
    }
  });

  // FX-R2 (round 18B finding 4, MEDIUM): §0.3(d)'s "over-budget な packet は
  // `over_budget` を開示する" — `projectRelationPacketToEvidenceGraph` used to
  // return `{version,nodes,relations,...unavailable}` with no `over_budget`
  // key at all, so an over-budget packet (`nodes`/`relations` typically both
  // empty by this point — everything shedable is already gone) projected to
  // a graph byte-identical to "resolved nothing usable". Reproduces
  // round-18B's `p7_overbudget.mts` (`budget:{maxBytes:10}`) at the compiler
  // level, one seam below the full `compileSfRelationPackets` reproduction
  // in `sfRelationSeam.spec.ts`.
  it("over_budget survives the plan.wiring.evidence_graph projection, distinguishing 'too large' from 'resolved nothing'", () => {
    const anchorNode = symbolNode("src/gateway.ts", "authorize", "reference-index", { line: 2 });
    const port: RelationGraphPort = {
      resolveDefinition: () => ({ node: anchorNode }),
      edgesFor: () => [],
    };
    const packet = compileRelationPacket({ anchor: { symbol: "authorize" }, graph: port, budget: { maxBytes: 10 } });
    expect(packet.over_budget).toBe(true);
    expect(packet.resolved).toBe(false);

    const projected = projectRelationPacketToEvidenceGraph(packet);
    expect(projected.over_budget).toBe(true);
    const asWire: TaskEvidenceGraph = projected;
    expect(asWire.over_budget).toBe(true);

    // A packet that never was over budget must never fabricate the key
    // (absent, never `false`).
    const fine = compileRelationPacket({ anchor: { symbol: "authorize" }, graph: port });
    expect(fine.over_budget).toBeUndefined();
    const fineProjected = projectRelationPacketToEvidenceGraph(fine);
    expect(fineProjected.over_budget).toBeUndefined();
    expect(Object.hasOwn(fineProjected, "over_budget")).toBe(false);
  });

  it("never touches the anchor passed to graph.resolveDefinition/resolveDeclaration — only the packet's own copy", () => {
    const hugeSymbol = "w".repeat(50_000);
    let receivedSymbolLength = -1;
    const port: RelationGraphPort = {
      resolveDefinition: (anchor) => {
        receivedSymbolLength = anchor.symbol!.length;
        return undefined;
      },
      edgesFor: () => [],
    };
    compileRelationPacket({ anchor: { symbol: hugeSymbol }, graph: port });
    expect(receivedSymbolLength).toBe(50_000);
  });
});

// ---------------------------------------------------------------------------
// 2. Determinism
// ---------------------------------------------------------------------------

describe("determinism", () => {
  it("produces byte-identical output across repeated compilations of the same input", () => {
    function buildPort(): RelationGraphPort {
      const anchorNode = symbolNode("src/target.ts", "run", "reference-index", { line: 1 });
      const callers = Array.from({ length: 5 }, (_, i) =>
        symbolNode(`src/c${i}.ts`, `caller${i}`, "reference-index", { line: 2 }),
      );
      const edges = callers.map((c) => mkEdge("CALLED_BY", anchorNode, c));
      return { resolveDefinition: () => ({ node: anchorNode }), edgesFor: () => edges };
    }
    const a = compileRelationPacket({ anchor: { symbol: "run" }, graph: buildPort() });
    const b = compileRelationPacket({ anchor: { symbol: "run" }, graph: buildPort() });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

// ---------------------------------------------------------------------------
// 3. Qualified-anchor class scoping (D5)
// ---------------------------------------------------------------------------

describe("qualified anchor class scoping", () => {
  it("never binds Class::method to a different class's same-named member", () => {
    const classANode = symbolNode("src/a.ts", "run", "reference-index", { line: 3 });
    const classBNode = symbolNode("src/b.ts", "run", "reference-index", { line: 9 });
    const port: RelationGraphPort = {
      resolveDefinition: (anchor) => {
        if (anchor.qualified?.class === "A" && anchor.qualified.member === "run") return { node: classANode };
        if (anchor.qualified?.class === "B" && anchor.qualified.member === "run") return { node: classBNode };
        return undefined;
      },
      edgesFor: () => [],
    };

    const packetA = compileRelationPacket({ anchor: { qualified: { class: "A", member: "run" } }, graph: port });
    const packetB = compileRelationPacket({ anchor: { qualified: { class: "B", member: "run" } }, graph: port });

    expect(packetA.definition?.path).toBe("src/a.ts");
    expect(packetB.definition?.path).toBe("src/b.ts");
    expect(packetA.definition?.path).not.toBe(packetB.definition?.path);
  });

  it("forwards the anchor verbatim to the port — it never resolves by bare symbol on its own", () => {
    let received: unknown;
    const port: RelationGraphPort = {
      resolveDefinition: (anchor) => {
        received = anchor;
        return undefined;
      },
      edgesFor: () => [],
    };
    compileRelationPacket({ anchor: { qualified: { class: "Widget", member: "render" } }, graph: port });
    expect(received).toEqual({ qualified: { class: "Widget", member: "render" } });
  });
});

// ---------------------------------------------------------------------------
// 4. Byte-budget shedding order
// ---------------------------------------------------------------------------

describe("byte budget shedding order", () => {
  function buildShedFixture(): RelationGraphPort {
    const anchorNode = symbolNode("src/target.ts", "run", "reference-index", { line: 2 });
    const callerNode = symbolNode("src/caller.ts", "callerFn", "reference-index", { line: 1 });
    const calleeNode = symbolNode("src/callee.ts", "calleeFn", "reference-index", { line: 1 });
    const implNode = symbolNode("src/impl.ts", "ImplClass", "reference-index", { line: 1 });
    const edges = [
      mkEdge("CALLED_BY", anchorNode, callerNode),
      mkEdge("CALLS", anchorNode, calleeNode),
      mkEdge("IMPLEMENTS", implNode, anchorNode),
    ];
    return { resolveDefinition: () => ({ node: anchorNode, range: "2-2" }), edgesFor: () => edges };
  }

  it("sheds implementations, then callees, then callers, before ever touching the definition", () => {
    const full = compileRelationPacket({
      anchor: { symbol: "run" },
      graph: buildShedFixture(),
      budget: { maxBytes: 1_000_000 },
    });
    expect(full.callers!.length).toBe(1);
    expect(full.callees!.length).toBe(1);
    expect(full.implementations?.length).toBe(1);
    expect(full.definition).toBeDefined();

    const firstTruncatedAt: Record<"implementations" | "callees" | "callers", number | undefined> = {
      implementations: undefined,
      callees: undefined,
      callers: undefined,
    };
    for (let maxBytes = full.bytes; maxBytes >= 20; maxBytes -= 1) {
      const p = compileRelationPacket({
        anchor: { symbol: "run" },
        graph: buildShedFixture(),
        budget: { maxBytes },
      });
      if (firstTruncatedAt.implementations === undefined && p.truncated.implementations > 0) {
        firstTruncatedAt.implementations = maxBytes;
      }
      if (firstTruncatedAt.callees === undefined && (p.truncated.callees ?? 0) > 0) {
        firstTruncatedAt.callees = maxBytes;
      }
      if (firstTruncatedAt.callers === undefined && (p.truncated.callers ?? 0) > 0) {
        firstTruncatedAt.callers = maxBytes;
      }
    }

    expect(firstTruncatedAt.implementations).toBeDefined();
    expect(firstTruncatedAt.callees).toBeDefined();
    expect(firstTruncatedAt.callers).toBeDefined();
    // Lower priority sheds FIRST as the budget shrinks, i.e. at a LARGER
    // remaining byte budget than the next-higher-priority category.
    expect(firstTruncatedAt.implementations!).toBeGreaterThan(firstTruncatedAt.callees!);
    expect(firstTruncatedAt.callees!).toBeGreaterThan(firstTruncatedAt.callers!);

    const atThreshold = compileRelationPacket({
      anchor: { symbol: "run" },
      graph: buildShedFixture(),
      budget: { maxBytes: firstTruncatedAt.implementations! },
    });
    expect(atThreshold.truncated.implementations).toBeGreaterThan(0);
    expect(atThreshold.truncated.callees).toBe(0);
    expect(atThreshold.truncated.callers).toBe(0);
    expect(atThreshold.bytes).toBeLessThanOrEqual(firstTruncatedAt.implementations!);
  });
});

// ---------------------------------------------------------------------------
// 5. Test-path deprioritization
// ---------------------------------------------------------------------------

describe("includeTests", () => {
  it("deprioritizes test paths globally unless includeTests is set", () => {
    function buildPort(): RelationGraphPort {
      const anchorNode = symbolNode("src/target.ts", "run", "reference-index", { line: 1 });
      // Alphabetically FIRST but test-only; alphabetically LAST but production.
      const testCallerNode = symbolNode("src/__tests__/a.spec.ts", "testCaller", "reference-index", { line: 1 });
      const nonTestCallerNode = symbolNode("src/z_module.ts", "prodCaller", "reference-index", { line: 1 });
      const edges = [
        mkEdge("CALLED_BY", anchorNode, testCallerNode),
        mkEdge("CALLED_BY", anchorNode, nonTestCallerNode),
      ];
      return { resolveDefinition: () => ({ node: anchorNode }), edgesFor: () => edges };
    }

    const withoutTests = compileRelationPacket({
      anchor: { symbol: "run" },
      graph: buildPort(),
      budget: { maxNodes: 2, maxEdges: 48, maxBytes: 1_000_000 },
    });
    expect(withoutTests.callers!.map((c) => c.path)).toEqual(["src/z_module.ts"]);
    expect(withoutTests.truncated.callers).toBe(1);

    const withTests = compileRelationPacket({
      anchor: { symbol: "run" },
      graph: buildPort(),
      budget: { maxNodes: 2, maxEdges: 48, maxBytes: 1_000_000 },
      includeTests: true,
    });
    expect(withTests.callers!.map((c) => c.path)).toEqual(["src/__tests__/a.spec.ts"]);
  });
});

// ---------------------------------------------------------------------------
// 6. Unresolved anchor — honest empty packet
// ---------------------------------------------------------------------------

describe("unresolved anchor", () => {
  it("reports resolved:false and an empty, honestly-zeroed packet", () => {
    const port: RelationGraphPort = { resolveDefinition: () => undefined, edgesFor: () => [] };
    const packet = compileRelationPacket({ anchor: { symbol: "missing" }, graph: port });
    expect(packet.resolved).toBe(false);
    expect(packet.definition).toBeUndefined();
    expect(packet.declaration).toBeUndefined();
    expect(packet.callers).toEqual([]);
    expect(packet.callees).toEqual([]);
    expect(packet.implementations).toBeUndefined();
    expect(packet.referencedBy).toBeUndefined();
    expect(packet.truncated).toEqual({
      definition: 0,
      declaration: 0,
      callers: 0,
      callees: 0,
      implementations: 0,
      referencedBy: 0,
    });
  });

  it("throws on a caller-error anchor with no symbol/qualified/path", () => {
    const port: RelationGraphPort = { resolveDefinition: () => undefined, edgesFor: () => [] };
    expect(() => compileRelationPacket({ anchor: {}, graph: port })).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// 7. relation_packet_one_shot metric primitive
// ---------------------------------------------------------------------------

describe("relationPacketOneShot", () => {
  const basePacket: RelationPacket = {
    anchor: { symbol: "run" },
    definition: { path: "src/target.ts", range: "1-1" },
    callers: [{ path: "src/caller.ts", symbol: "c", kind: "called-by" }],
    callees: [],
    truncated: { definition: 0, declaration: 0, callers: 0, callees: 0, implementations: 0, referencedBy: 0 },
    bytes: 100,
    resolved: true,
  };

  it("is one-shot and applicable when every expected surface is covered and nothing was truncated", () => {
    const result = relationPacketOneShot(basePacket, ["src/target.ts", "src/caller.ts"]);
    expect(result).toEqual({
      applicable: true,
      oneShot: true,
      missingPaths: [],
      coveredPaths: ["src/caller.ts", "src/target.ts"],
    });
  });

  it("is not one-shot when an expected path is missing", () => {
    const result = relationPacketOneShot(basePacket, ["src/target.ts", "src/other.ts"]);
    expect(result.oneShot).toBe(false);
    expect(result.missingPaths).toEqual(["src/other.ts"]);
  });

  it("is inapplicable to the gate when anything was truncated (§7.1 scopes the gate to fan-out <= 24)", () => {
    const truncatedPacket: RelationPacket = {
      ...basePacket,
      truncated: { ...basePacket.truncated, callers: 1 },
    };
    expect(relationPacketOneShot(truncatedPacket, ["src/target.ts"]).applicable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 8. Projection shape parity with the EXISTING plan.wiring.evidence_graph
//    wire type (`TaskEvidenceGraph`, @tokenlighten/types). FX-G-B
//    (2026-09-03): ONE new field since this comment was written —
//    `unavailable`, optional and additive on both `RelationEvidenceGraph`
//    and `TaskEvidenceGraph` — so the runtime key-set assertions below only
//    hold for a packet that never sets it; the dedicated describe block
//    further down covers the field itself.
// ---------------------------------------------------------------------------

describe("projectRelationPacketToEvidenceGraph", () => {
  it("matches the existing TaskEvidenceGraph wire shape exactly", () => {
    const packet: RelationPacket = {
      anchor: { qualified: { class: "Widget", member: "render" } },
      definition: { path: "src/widget.ts", range: "10-20", handle: "h_def" },
      declaration: { path: "src/widget.d.ts", range: "3-3" },
      callers: [{ path: "src/caller.ts", range: "5-5", symbol: "callSite", kind: "called-by", handle: "h_caller" }],
      callees: [{ path: "src/callee.ts", symbol: "helper", kind: "calls" }],
      implementations: [{ path: "src/impl.ts", symbol: "WidgetImpl", kind: "implements" }],
      truncated: { definition: 0, declaration: 0, callers: 0, callees: 0, implementations: 0, referencedBy: 0 },
      bytes: 500,
      resolved: true,
    };
    const projected = projectRelationPacketToEvidenceGraph(packet);

    // Type-level parity: this only compiles if RelationEvidenceGraph is
    // exactly TaskEvidenceGraph-shaped (checked by `npx tsc --noEmit`).
    const asWire: TaskEvidenceGraph = projected;
    expect(asWire.version).toBe(1);

    // Runtime key-set parity — catches drift even under relaxed configs.
    expect(Object.keys(projected).sort()).toEqual(["nodes", "relations", "version"]);
    expect(projected.nodes.length).toBeGreaterThan(0);
    expect(projected.relations.length).toBeGreaterThan(0);
    for (const node of projected.nodes) {
      const expectedKeys = ["handle", "id", "kind", "path", "range", "roles"];
      if (node.symbol !== undefined) expectedKeys.push("symbol");
      expect(Object.keys(node).sort()).toEqual(expectedKeys.sort());
      expect(typeof node.handle).toBe("string");
      expect(typeof node.range).toBe("string");
      expect(["file", "symbol"]).toContain(node.kind);
    }
    for (const relation of projected.relations) {
      expect(Object.keys(relation).sort()).toEqual(
        ["confidence", "from", "id", "kind", "provenance", "to"].sort(),
      );
      expect(["defines", "references", "imports", "direct_calls"]).toContain(relation.kind);
      expect(["lexical", "index"]).toContain(relation.provenance);
    }
  });

  it("returns an empty graph for an unresolved packet without throwing", () => {
    const packet: RelationPacket = {
      anchor: { symbol: "missing" },
      callers: [],
      callees: [],
      truncated: { definition: 0, declaration: 0, callers: 0, callees: 0, implementations: 0, referencedBy: 0 },
      bytes: 0,
      resolved: false,
    };
    const projected = projectRelationPacketToEvidenceGraph(packet);
    expect(projected).toEqual({ version: 1, nodes: [], relations: [] });
  });
});

// ---------------------------------------------------------------------------
// 8b. FX-G-B (round 12, MEDIUM finding 4): a port with no callee source
// (`unavailableRelations: ["callees"]`) must never read as "computed, found
// none" — `callees` and `truncated.callees` are OMITTED entirely, and
// `unavailable` names what was never attempted, all the way through
// `mintRelationHandles` and the `plan.wiring.evidence_graph` projection.
// ---------------------------------------------------------------------------

describe("callees unavailable (FX-G-B) — omitted, never a fabricated empty array", () => {
  function portWithoutCallees(): RelationGraphPort {
    const anchorNode = symbolNode("src/target.ts", "run", "reference-index", { line: 5 });
    const callerNode = symbolNode("src/caller.ts", "caller", "reference-index", { line: 1 });
    return {
      resolveDefinition: (anchor) => (anchor.symbol === "run" ? { node: anchorNode, range: "5-5" } : undefined),
      // Even a port that (incorrectly, or via a stale cache) hands back a
      // CALLS edge must never surface it once it has disclosed callees as
      // unavailable — the disclosure is authoritative over any one edge.
      edgesFor: () => [mkEdge("CALLED_BY", anchorNode, callerNode), mkEdge("CALLS", anchorNode, callerNode)],
      unavailableRelations: ["callees"],
    };
  }

  it("omits callees and truncated.callees, and lists it in unavailable", () => {
    const packet = compileRelationPacket({ anchor: { symbol: "run" }, graph: portWithoutCallees() });
    expect(packet.resolved).toBe(true);
    expect(packet.callers!.length).toBe(1); // callers still real — only callees is unavailable
    expect(packet.callees).toBeUndefined();
    expect(packet.truncated.callees).toBeUndefined();
    expect(Object.hasOwn(packet.truncated, "callees")).toBe(false);
    expect(packet.unavailable).toEqual(["callees"]);
  });

  it("stays omitted (with unavailable set) even for an unresolved anchor", () => {
    const port: RelationGraphPort = {
      resolveDefinition: () => undefined,
      edgesFor: () => [],
      unavailableRelations: ["callees"],
    };
    const packet = compileRelationPacket({ anchor: { symbol: "missing" }, graph: port });
    expect(packet.resolved).toBe(false);
    expect(packet.callees).toBeUndefined();
    expect(packet.unavailable).toEqual(["callees"]);
  });

  it("mintRelationHandles carries the omission and unavailable forward unchanged", async () => {
    const compiled = compileRelationPacket({ anchor: { symbol: "run" }, graph: portWithoutCallees() });
    const { packet: minted, dropped } = mintRelationHandles(compiled, "/does-not-matter");
    expect(dropped.some((d) => d.category === "callees")).toBe(false);
    expect(minted.callees).toBeUndefined();
    expect(Object.hasOwn(minted.truncated, "callees")).toBe(false);
    expect(minted.unavailable).toEqual(["callees"]);
  });

  it("projects unavailable straight onto plan.wiring.evidence_graph, and callers alone still populate it", () => {
    const compiled = compileRelationPacket({ anchor: { symbol: "run" }, graph: portWithoutCallees() });
    const projected = projectRelationPacketToEvidenceGraph(compiled);
    expect(projected.unavailable).toEqual(["callees"]);
    expect(projected.relations.length).toBeGreaterThan(0); // the real caller edge still made it through
    const asWire: TaskEvidenceGraph = projected;
    expect(asWire.unavailable).toEqual(["callees"]);
  });

  it("a port that never disables anything keeps the pre-FX-G-B shape (callees present, unavailable absent)", () => {
    const port: RelationGraphPort = {
      resolveDefinition: (anchor) => (anchor.symbol === "run" ? { node: symbolNode("src/target.ts", "run", "reference-index", { line: 5 }) } : undefined),
      edgesFor: () => [],
    };
    const packet = compileRelationPacket({ anchor: { symbol: "run" }, graph: port });
    expect(packet.callees).toEqual([]);
    expect(packet.truncated.callees).toBe(0);
    expect(packet.unavailable).toBeUndefined();
    expect(Object.hasOwn(packet, "unavailable")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 8c. FX-U2 (round 19B finding 1, HIGH, 2026-09-04): `RelationGraphPort
// .unavailableRelationsForAnchor` — a per-ANCHOR refinement of
// `unavailableRelations`, unioned with it rather than replacing it. Exercised
// here purely at the compiler level, against a synthetic port, independent
// of `relationGraphPort.ts`'s own real-index attribution mechanism (covered
// end to end in `relationPacketPort.spec.ts`'s own FX-U2 section).
// ---------------------------------------------------------------------------

describe("unavailableRelationsForAnchor (FX-U2) — per-anchor refinement, unioned with the port-wide list", () => {
  function ambiguousForOneAnchorPort(): RelationGraphPort {
    const ambiguousNode = symbolNode("src/ambiguous.ts", "Widget::isHealthy", "parser", { line: 1 });
    const clearNode = symbolNode("src/clear.ts", "Widget::update", "parser", { line: 1 });
    const callerNode = symbolNode("src/caller.ts", "caller", "reference-index", { line: 1 });
    return {
      resolveDefinition: (anchor) => {
        if (anchor.qualified?.member === "isHealthy") return { node: ambiguousNode };
        if (anchor.qualified?.member === "update") return { node: clearNode };
        return undefined;
      },
      edgesFor: (node) =>
        node === ambiguousNode || node === clearNode ? [mkEdge("CALLED_BY", node, callerNode)] : [],
      // Only "update" is ever named — a port with a real caller source at
      // all reports no port-wide gap here.
      unavailableRelationsForAnchor: (anchor) => (anchor.qualified?.member === "isHealthy" ? ["callers"] : []),
    };
  }

  it("names 'callers' only for the anchor the hook actually flags — never for a sibling anchor on the same port", () => {
    const port = ambiguousForOneAnchorPort();

    const ambiguous = compileRelationPacket({ anchor: { qualified: { class: "Widget", member: "isHealthy" } }, graph: port });
    expect(ambiguous.resolved).toBe(true);
    expect(ambiguous.callers).toBeUndefined();
    expect(Object.hasOwn(ambiguous, "callers")).toBe(false);
    expect(ambiguous.truncated.callers).toBeUndefined();
    expect(ambiguous.unavailable).toEqual(["callers"]);

    const clear = compileRelationPacket({ anchor: { qualified: { class: "Widget", member: "update" } }, graph: port });
    expect(clear.resolved).toBe(true);
    expect(clear.callers!.length).toBe(1);
    expect(Object.hasOwn(clear, "unavailable")).toBe(false);
  });

  it("unions with the port-wide unavailableRelations list rather than replacing it", () => {
    const anchorNode = symbolNode("src/target.ts", "Widget::isHealthy", "parser", { line: 1 });
    const port: RelationGraphPort = {
      resolveDefinition: () => ({ node: anchorNode }),
      edgesFor: () => [],
      // Port-wide: callees never has a source at all (the FX-G-B shape).
      unavailableRelations: ["callees"],
      // Per-anchor: THIS anchor's callers also cannot be attributed.
      unavailableRelationsForAnchor: () => ["callers"],
    };
    const packet = compileRelationPacket({ anchor: { qualified: { class: "Widget", member: "isHealthy" } }, graph: port });
    expect(packet.callers).toBeUndefined();
    expect(packet.callees).toBeUndefined();
    // Order matches the pre-existing convention: callees, then callers.
    expect(packet.unavailable).toEqual(["callees", "callers"]);
  });

  it("omitting the hook entirely (the shape every port had before FX-U2) changes nothing", () => {
    const anchorNode = symbolNode("src/target.ts", "run", "reference-index", { line: 1 });
    const callerNode = symbolNode("src/caller.ts", "caller", "reference-index", { line: 1 });
    const port: RelationGraphPort = {
      resolveDefinition: () => ({ node: anchorNode }),
      edgesFor: () => [mkEdge("CALLED_BY", anchorNode, callerNode)],
    };
    const packet = compileRelationPacket({ anchor: { symbol: "run" }, graph: port });
    expect(packet.callers!.length).toBe(1);
    expect(Object.hasOwn(packet, "unavailable")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 9. Purity guard — not wired into any response this wave
// ---------------------------------------------------------------------------

describe("relationPacket is not wired into any response this wave", () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const SRC_DIR = path.resolve(HERE, "..");
  const MODULE_FILE = path.join(SRC_DIR, "features", "graph-evidence", "relationPacket.ts");

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute, out);
      else if (entry.isFile() && absolute.endsWith(".ts")) out.push(absolute);
    }
    return out;
  }

  function importSpecifiers(code: string): string[] {
    const found: string[] = [];
    const patterns = [
      /\bfrom\s*["']([^"']+)["']/g,
      /\bimport\s*\(\s*["']([^"']+)["']/g,
      /\brequire\s*\(\s*["']([^"']+)["']/g,
    ];
    for (const pattern of patterns) {
      for (const match of code.matchAll(pattern)) {
        if (match[1] !== undefined) found.push(match[1]);
      }
    }
    return found;
  }

  function isTestFile(absolute: string): boolean {
    return absolute.split(path.sep).includes("__tests__") || /\.(spec|test)\.tsx?$/.test(absolute);
  }

  it("finds the module it is asserting about", () => {
    expect(fs.existsSync(MODULE_FILE)).toBe(true);
  });

  // W-RELATION-SEAM (2026-09-02): features/task-pack/sfRelationSeam.ts is now
  // the ONE sanctioned production importer (the task_pack seam that compiles
  // relation packets for grounded relation concerns). Anyone else importing
  // this module is still an offense — the seam is the sole wiring site.
  const SANCTIONED_PRODUCTION_IMPORTER = "features/task-pack/sfRelationSeam.ts";

  it("no production file other than the sanctioned seam imports features/graph-evidence/relationPacket", () => {
    const offenders: string[] = [];
    for (const absolute of walk(SRC_DIR)) {
      if (absolute === MODULE_FILE) continue;
      if (isTestFile(absolute)) continue;
      const specifiers = importSpecifiers(fs.readFileSync(absolute, "utf8"));
      if (specifiers.some((s) => s.includes("graph-evidence/relationPacket"))) {
        offenders.push(path.relative(SRC_DIR, absolute));
      }
    }
    expect(
      offenders,
      "relationPacket must be imported only by tests, plus its one sanctioned " +
        `production seam (${SANCTIONED_PRODUCTION_IMPORTER})`,
    ).toEqual([SANCTIONED_PRODUCTION_IMPORTER]);
  });
});
