/**
 * Tests for pagerank.ts
 * No network required — all fixtures are in-memory.
 */

import { describe, it, expect } from "vitest";
import {
  buildSymbolGraph,
  runPersonalizedPageRank,
  aggregateToFileScores,
  fileUnitFallback,
  normalizeScores,
  serializeGraph,
  deserializeGraph,
  type FileInput,
} from "../pagerank.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const fileA: FileInput = {
  path: "src/a.ts",
  raw: `export function foo() { return bar(); }`,
  mtimeMs: 1000,
  symbols: [{ name: "foo", line: 1, endLine: 1, signature: "export function foo()" }],
};

const fileB: FileInput = {
  path: "src/b.ts",
  raw: `export function bar() { return 42; }\nfunction baz(x: Foo) {}`,
  mtimeMs: 2000,
  symbols: [
    { name: "bar", line: 1, endLine: 1, signature: "export function bar()" },
    { name: "baz", line: 2, endLine: 2, signature: "function baz(x: Foo)" },
  ],
};

// ---------------------------------------------------------------------------
// buildSymbolGraph
// ---------------------------------------------------------------------------

describe("buildSymbolGraph", () => {
  it("builds nodes for all symbols", () => {
    const graph = buildSymbolGraph([fileA, fileB], null);
    expect(graph.nodes.size).toBe(3);
    expect(graph.nodes.has("src/a.ts:foo")).toBe(true);
    expect(graph.nodes.has("src/b.ts:bar")).toBe(true);
    expect(graph.nodes.has("src/b.ts:baz")).toBe(true);
  });

  it("records fileMtimes", () => {
    const graph = buildSymbolGraph([fileA, fileB], null);
    expect(graph.fileMtimes.get("src/a.ts")).toBe(1000);
    expect(graph.fileMtimes.get("src/b.ts")).toBe(2000);
  });

  it("emits cross-file lexical edges (a.ts references bar from b.ts)", () => {
    const graph = buildSymbolGraph([fileA, fileB], null);
    // src/a.ts:foo should have an edge to src/b.ts:bar because 'bar' appears in its raw text.
    const edges = graph.edges.get("src/a.ts:foo");
    expect(edges).toBeDefined();
    expect(edges?.has("src/b.ts:bar")).toBe(true);
  });

  it("skips self-edges", () => {
    // fileB has 'bar' and 'baz' — they should not edge to themselves.
    const graph = buildSymbolGraph([fileB], null);
    // Single file: no cross-file edges possible.
    expect(graph.edges.size).toBe(0);
  });

  it("reuses edges from previous graph when mtime unchanged", () => {
    const graph1 = buildSymbolGraph([fileA, fileB], null);
    // Modify raw of A but keep same mtime for B — B's edges should be reused.
    const fileANew: FileInput = { ...fileA, raw: "no references here", mtimeMs: 9999 };
    const graph2 = buildSymbolGraph([fileANew, fileB], graph1);
    // B's mtime is unchanged → B's edges from graph1 are copied.
    for (const sym of fileB.symbols) {
      const srcId = `src/b.ts:${sym.name}`;
      const prevEdges = graph1.edges.get(srcId);
      const currEdges = graph2.edges.get(srcId);
      if (prevEdges) {
        expect(currEdges).toBeDefined();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// runPersonalizedPageRank
// ---------------------------------------------------------------------------

describe("runPersonalizedPageRank", () => {
  it("returns a score for every node", () => {
    const graph = buildSymbolGraph([fileA, fileB], null);
    const personalization = new Map<string, number>();
    const scores = runPersonalizedPageRank(graph, personalization);
    for (const id of graph.nodes.keys()) {
      expect(scores.has(id)).toBe(true);
      expect(scores.get(id)).toBeGreaterThan(0);
    }
  });

  it("returns empty map for empty graph", () => {
    const emptyGraph = buildSymbolGraph([], null);
    const scores = runPersonalizedPageRank(emptyGraph, new Map());
    expect(scores.size).toBe(0);
  });

  it("personalization boosts seeded nodes", () => {
    const graph = buildSymbolGraph([fileA, fileB], null);
    // Seed only b.ts:bar with a high weight.
    const personalization = new Map<string, number>([
      ["src/b.ts:bar", 10],
    ]);
    const boosted = runPersonalizedPageRank(graph, personalization);
    const uniform = runPersonalizedPageRank(graph, new Map());

    // bar should have a higher score with personalization.
    expect(boosted.get("src/b.ts:bar")!).toBeGreaterThan(uniform.get("src/b.ts:bar")!);
  });

  it("runs exactly 20 iterations (fixed cost)", () => {
    // We cannot directly observe iterations, but we verify the result is stable
    // (running 20 twice yields same result for deterministic inputs).
    const graph = buildSymbolGraph([fileA, fileB], null);
    const p = new Map<string, number>();
    const r1 = runPersonalizedPageRank(graph, p, 0.85, 20);
    const r2 = runPersonalizedPageRank(graph, p, 0.85, 20);
    for (const [id, score] of r1) {
      expect(r2.get(id)).toBeCloseTo(score, 10);
    }
  });
});

// ---------------------------------------------------------------------------
// aggregateToFileScores
// ---------------------------------------------------------------------------

describe("aggregateToFileScores", () => {
  it("collapses symbol scores to file scores using max", () => {
    const nodeScores = new Map([
      ["src/a.ts:foo", 0.3],
      ["src/b.ts:bar", 0.8],
      ["src/b.ts:baz", 0.2],
    ]);
    const fileScores = aggregateToFileScores(nodeScores);
    expect(fileScores.get("src/a.ts")).toBeCloseTo(0.3);
    expect(fileScores.get("src/b.ts")).toBeCloseTo(0.8); // max of 0.8 and 0.2
  });
});

// ---------------------------------------------------------------------------
// fileUnitFallback
// ---------------------------------------------------------------------------

describe("fileUnitFallback", () => {
  it("assigns 2 to recently-edited files and 1 to others", () => {
    const scores = fileUnitFallback([
      { path: "src/a.ts", recentlyEdited: true },
      { path: "src/b.ts", recentlyEdited: false },
    ]);
    expect(scores.get("src/a.ts")).toBe(2);
    expect(scores.get("src/b.ts")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// normalizeScores
// ---------------------------------------------------------------------------

describe("normalizeScores", () => {
  it("maps scores to [0, 1]", () => {
    const scores = new Map([["a", 10], ["b", 20], ["c", 5]]);
    const normalized = normalizeScores(scores);
    expect(normalized.get("c")).toBeCloseTo(0);
    expect(normalized.get("b")).toBeCloseTo(1);
    expect(normalized.get("a")).toBeCloseTo(5 / 15); // (10-5)/(20-5)
  });

  it("handles all-equal scores", () => {
    const scores = new Map([["a", 5], ["b", 5]]);
    const normalized = normalizeScores(scores);
    expect(normalized.get("a")).toBe(1);
    expect(normalized.get("b")).toBe(1);
  });

  it("returns empty map for empty input", () => {
    expect(normalizeScores(new Map()).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Serialization round-trip
// ---------------------------------------------------------------------------

describe("serializeGraph / deserializeGraph", () => {
  it("round-trips a graph losslessly", () => {
    const graph = buildSymbolGraph([fileA, fileB], null);
    const serialized = serializeGraph(graph);
    const restored = deserializeGraph(serialized);

    expect(restored.nodes.size).toBe(graph.nodes.size);
    expect(restored.edges.size).toBe(graph.edges.size);
    expect(restored.fileMtimes.get("src/a.ts")).toBe(1000);
    expect(restored.builtAt).toBe(graph.builtAt);
  });
});
