/**
 * graphRetriever.spec.ts — Wave C (F-A5): the graph axis's own ranked-list
 * construction — determinism, lookup-key strategy (raw spans / decomposed
 * + Title-cased tokens / explicit symbol), role scoring (definition >
 * reference), match-count bonus, and bounds. Pure-function tests against a
 * hand-built GraphIndex (no filesystem, no locateTaskContext) — the
 * fusion-level wiring (quality gate participation, floor non-membership,
 * candidate pool insertion) is covered separately in
 * profileFusion.spec.ts's own Wave C additions.
 */

import { describe, it, expect } from "vitest";
import { buildGraphRankedList, MAX_REFERENCE_FILES_PER_TOKEN, MAX_TOTAL_GRAPH_HITS } from "../graphRetriever.js";
import type { GraphIndex, GraphLocation } from "../../../graph/index.js";

/** A minimal, deterministic, in-memory GraphIndex — same shape tlGraphReader.ts's parseTlGraph produces, built directly rather than via JSON so these tests need no filesystem. */
function fakeGraphIndex(opts: {
  definitions?: Record<string, GraphLocation>;
  references?: Record<string, GraphLocation[]>;
}): GraphIndex {
  const definitions = opts.definitions ?? {};
  const references = opts.references ?? {};
  return {
    definition: (symbol: string) => definitions[symbol],
    references: (symbol: string) => references[symbol] ?? [],
    importsOf: () => [],
    exportsOf: () => [],
    rootHash: () => undefined,
  };
}

describe("buildGraphRankedList — determinism", () => {
  it("is a pure function of its inputs — two calls with identical arguments produce byte-identical JSON", () => {
    const graphIndex = fakeGraphIndex({
      definitions: { reserveStock: { path: "src/services/inventory.ts", line: 5, column: 0 } },
      references: { reserveStock: [{ path: "src/routes/orders.ts", line: 1, column: 0 }] },
    });
    const a = buildGraphRankedList(graphIndex, "rename reserveStock — which callers need updating", undefined);
    const b = buildGraphRankedList(graphIndex, "rename reserveStock — which callers need updating", undefined);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("returns [] for a query with no identifier-shaped span at all", () => {
    const graphIndex = fakeGraphIndex({
      definitions: { reserveStock: { path: "src/services/inventory.ts", line: 5, column: 0 } },
    });
    // No letters at all in the query — lookupKeys() has nothing to try.
    expect(buildGraphRankedList(graphIndex, "", undefined)).toEqual([]);
  });

  it("returns [] when the graph has no matching symbol for anything in the query — an honest miss, not an error", () => {
    const graphIndex = fakeGraphIndex({
      definitions: { reserveStock: { path: "src/services/inventory.ts", line: 5, column: 0 } },
    });
    expect(buildGraphRankedList(graphIndex, "rotate the database encryption keys", undefined)).toEqual([]);
  });
});

describe("buildGraphRankedList — lookup key strategy", () => {
  it("finds a definition via a raw, case-preserved identifierSpan (a multi-word camelCase identifier named verbatim in the query)", () => {
    const graphIndex = fakeGraphIndex({
      definitions: { sendOrderConfirmation: { path: "src/services/notification.ts", line: 4, column: 0 } },
    });
    const hits = buildGraphRankedList(
      graphIndex,
      "find every caller of sendOrderConfirmation before changing its signature",
      undefined,
    );
    expect(hits.some((h) => h.path === "src/services/notification.ts" && h.symbol === "sendOrderConfirmation")).toBe(true);
  });

  it("never finds a multi-word identifier via its decomposed sub-words alone (documented scope boundary)", () => {
    const graphIndex = fakeGraphIndex({
      definitions: { sendOrderConfirmation: { path: "src/services/notification.ts", line: 4, column: 0 } },
    });
    // "send order confirmation" as three separate words never reconstructs
    // the joined identifier — this is the honestly-documented limitation,
    // not a bug (identifierSpans is what covers the joined-span case above).
    const hits = buildGraphRankedList(graphIndex, "send an order confirmation email", undefined);
    expect(hits).toEqual([]);
  });

  it("finds a single-word, PascalCase-exported symbol from a plain lowercase query word via the Title-cased token variant", () => {
    const graphIndex = fakeGraphIndex({
      definitions: { Withdraw: { path: "pkg/account/account.go", line: 8, column: 0 } },
    });
    const hits = buildGraphRankedList(graphIndex, "withdraw money from an account", undefined);
    expect(hits.some((h) => h.symbol === "Withdraw" && h.path === "pkg/account/account.go")).toBe(true);
  });

  it("finds a single-word, already-lowercase symbol via the plain decomposed token (no case change needed)", () => {
    const graphIndex = fakeGraphIndex({
      definitions: { reserve: { path: "src/services/inventory.ts", line: 2, column: 0 } },
    });
    const hits = buildGraphRankedList(graphIndex, "please reserve this now", undefined);
    expect(hits.some((h) => h.symbol === "reserve")).toBe(true);
  });

  it("uses the explicit `symbol` argument as a lookup key even when it does not appear in the query text", () => {
    const graphIndex = fakeGraphIndex({
      definitions: { chargeCard: { path: "src/routes/payments.ts", line: 3, column: 0 } },
    });
    const hits = buildGraphRankedList(graphIndex, "unrelated free text", "chargeCard");
    expect(hits.some((h) => h.symbol === "chargeCard")).toBe(true);
  });

  it("preserves case exactly for an identifierSpan — a query naming 'Foo' resolves the PascalCase declaration, not a same-named lowercase one", () => {
    // Both "Foo" and "foo" are real, DISTINCT declarations in this graph.
    // The query names "Foo" (capitalized). If case were lost anywhere in
    // the lookup pipeline, only "foo" (the Title-cased-token fallback's
    // OWN target for an all-lowercase word) would ever be reachable — the
    // fact that BOTH are found (not just "foo") proves the raw span's
    // exact original case reached the graph lookup untouched.
    const graphIndex = fakeGraphIndex({
      definitions: {
        Foo: { path: "src/upper.ts", line: 1, column: 0 },
        foo: { path: "src/lower.ts", line: 1, column: 0 },
      },
    });
    const hits = buildGraphRankedList(graphIndex, "Foo does something", undefined);
    expect(hits.some((h) => h.path === "src/upper.ts" && h.symbol === "Foo")).toBe(true);
  });
});

describe("buildGraphRankedList — role scoring: definition beats reference", () => {
  it("a definition hit for one token outranks a reference hit for a different token", () => {
    const graphIndex = fakeGraphIndex({
      definitions: { reserveStock: { path: "src/services/inventory.ts", line: 5, column: 0 } },
      references: { createOrder: [{ path: "src/other.ts", line: 1, column: 0 }] },
    });
    const hits = buildGraphRankedList(graphIndex, "reserveStock and createOrder", undefined);
    const def = hits.find((h) => h.why === "graph:definition")!;
    const ref = hits.find((h) => h.why === "graph:reference")!;
    expect(def).toBeDefined();
    expect(ref).toBeDefined();
    expect(def.score).toBeGreaterThan(ref.score);
    expect(hits[0]).toBe(def); // sorted descending by score
  });

  it("when the SAME key is reachable as both a definition (for one token) and a reference (for another), it is recorded as a definition — role: definition > reference", () => {
    const sameLoc: GraphLocation = { path: "src/shared.ts", line: 9, column: 0 };
    const graphIndex = fakeGraphIndex({
      definitions: { alpha: sameLoc },
      references: { beta: [sameLoc] },
    });
    const hits = buildGraphRankedList(graphIndex, "alpha and beta both mention this", undefined);
    const hit = hits.find((h) => h.path === "src/shared.ts" && h.line === 9)!;
    expect(hit).toBeDefined();
    expect(hit.why).toBe("graph:definition");
    expect(hit.symbol).toBe("alpha");
  });

  it("a reference hit never carries a fabricated .symbol — only a definition hit does", () => {
    const graphIndex = fakeGraphIndex({
      references: { reserveStock: [{ path: "src/routes/orders.ts", line: 1, column: 0 }] },
    });
    const hits = buildGraphRankedList(graphIndex, "reserveStock", undefined);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.why).toBe("graph:reference");
    expect(hits[0]!.symbol).toBeUndefined();
  });
});

describe("buildGraphRankedList — match-count bonus", () => {
  it("a key reached by two different tokens (a reference AND the corroborating definition of the same underlying declaration) is not simply equal to a single-match reference", () => {
    const graphIndex = fakeGraphIndex({
      references: {
        alpha: [{ path: "src/multi.ts", line: 1, column: 0 }],
        beta: [{ path: "src/multi.ts", line: 1, column: 0 }],
      },
    });
    const multiMatch = buildGraphRankedList(graphIndex, "alpha and beta both here", undefined);
    const singleGraph = fakeGraphIndex({ references: { alpha: [{ path: "src/multi.ts", line: 1, column: 0 }] } });
    const singleMatch = buildGraphRankedList(singleGraph, "alpha only here", undefined);
    expect(multiMatch).toHaveLength(1);
    expect(singleMatch).toHaveLength(1);
    expect(multiMatch[0]!.score).toBeGreaterThan(singleMatch[0]!.score);
  });
});

describe("buildGraphRankedList — bounds", () => {
  it("caps the distinct files contributed by ONE token's references at MAX_REFERENCE_FILES_PER_TOKEN", () => {
    const manyFiles: GraphLocation[] = Array.from({ length: MAX_REFERENCE_FILES_PER_TOKEN + 10 }, (_, i) => ({
      path: `src/file${i}.ts`,
      line: 1,
      column: 0,
    }));
    const graphIndex = fakeGraphIndex({ references: { hotSymbol: manyFiles } });
    const hits = buildGraphRankedList(graphIndex, "hotSymbol", undefined);
    expect(hits.length).toBeLessThanOrEqual(MAX_REFERENCE_FILES_PER_TOKEN);
  });

  it("caps the total returned hit count at MAX_TOTAL_GRAPH_HITS", () => {
    const definitions: Record<string, GraphLocation> = {};
    const queryWords: string[] = [];
    for (let i = 0; i < MAX_TOTAL_GRAPH_HITS + 15; i++) {
      const name = `symbolNumber${i}`;
      definitions[name] = { path: `src/s${i}.ts`, line: 1, column: 0 };
      queryWords.push(name);
    }
    const graphIndex = fakeGraphIndex({ definitions });
    const hits = buildGraphRankedList(graphIndex, queryWords.join(" "), undefined);
    expect(hits.length).toBeLessThanOrEqual(MAX_TOTAL_GRAPH_HITS);
  });
});

describe("buildGraphRankedList — every returned key is well-formed", () => {
  it("every hit's key is exactly `${path}:${line}`, matching index.ts's own candidateKey shape", () => {
    const graphIndex = fakeGraphIndex({
      definitions: { reserveStock: { path: "src/services/inventory.ts", line: 5, column: 0 } },
    });
    const hits = buildGraphRankedList(graphIndex, "reserveStock", undefined);
    expect(hits[0]!.key).toBe("src/services/inventory.ts:5");
  });
});
