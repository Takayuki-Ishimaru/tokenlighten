// ---------------------------------------------------------------------------
// model.spec.ts — V11-01 acceptance: the classifier and THE FENCE.
//
// Plan §V11-01 受入基準 covered here:
//   * direct edge precision            — the two independent direct fences.
//   * structural precision ≥95%        — structural needs a NAMED corroboration;
//                                        co-occurrence never qualifies.
//   * heuristic-only closure 0 件      — `canSupportClosure`/`canCloseObligation`.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";

import {
  canCloseObligation,
  canSupportClosure,
  classifyEdge,
  compareEdges,
  edgeCanSupportRequired,
  edgeId,
  fileNode,
  GRAPH_EDGE_TYPES,
  isGraphEdgeType,
  maxEvidenceClassFor,
  nodeId,
  sectionNode,
  strongerClass,
  symbolNode,
  unaidedEvidenceClassFor,
  validateEdge,
  weakerClass,
  weakerCoverage,
  type Corroboration,
  type EvidenceClass,
  type GraphEdge,
  type GraphNode,
  type ProviderKind,
} from "../model.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function edge(overrides: Partial<GraphEdge> = {}): GraphEdge {
  const from: GraphNode = overrides.from ?? symbolNode("src/a.ts", "A", "parser");
  const to: GraphNode = overrides.to ?? symbolNode("src/b.ts", "B", "parser");
  return {
    type: "REFERENCES",
    from,
    to,
    evidenceClass: "direct",
    provider: "test:provider",
    providerKind: "reference-index",
    sourceSha: "sha256:aa",
    sourceShaPath: from.path,
    indexGeneration: "gen-1",
    coverage: "complete",
    rule: "test-rule",
    corroboration: ["exact-symbol-match"],
    ...overrides,
  };
}

const ALL_KINDS: readonly ProviderKind[] = [
  "reference-index",
  "symbol",
  "import-graph",
  "path-heuristics",
];

// ---------------------------------------------------------------------------
// 1. Edge type vocabulary
// ---------------------------------------------------------------------------

describe("edge type vocabulary", () => {
  it("is exactly the ten types the plan names, in a fixed order", () => {
    expect([...GRAPH_EDGE_TYPES]).toEqual([
      "CALLS",
      "CALLED_BY",
      "IMPORTS",
      "IMPORTED_BY",
      "REFERENCES",
      "IMPLEMENTS",
      "EXTENDS",
      "TESTED_BY",
      "CONFIGURES",
      "GENERATED_FROM",
    ]);
  });

  it("recognises its own members and nothing else", () => {
    for (const type of GRAPH_EDGE_TYPES) expect(isGraphEdgeType(type)).toBe(true);
    expect(isGraphEdgeType("REFERENCED_BY")).toBe(false);
    expect(isGraphEdgeType("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Node identity (PI-06 posture)
// ---------------------------------------------------------------------------

describe("node identity", () => {
  it("keys a symbol on its declaration, a file on its path, a section on its anchor", () => {
    expect(nodeId(symbolNode("src/a.ts", "A", "parser"))).toBe("symbol:src/a.ts#A");
    expect(nodeId(fileNode("src/a.ts"))).toBe("file:src/a.ts");
    expect(nodeId(sectionNode("docs/x.md", "Intro"))).toBe("section:docs/x.md#Intro");
  });

  it("excludes the proof, so one declaration is one node however it was found", () => {
    expect(nodeId(symbolNode("src/a.ts", "A", "parser"))).toBe(
      nodeId(symbolNode("src/a.ts", "A", "regex-fallback")),
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Direct: two independent fences
// ---------------------------------------------------------------------------

describe("classifyEdge — direct", () => {
  it("admits a semantic assertion between two semantically-proven endpoints", () => {
    expect(
      classifyEdge({
        providerKind: "reference-index",
        from: fileNode("src/consumer.ts", "reference-index"),
        to: symbolNode("src/a.ts", "A", "reference-index"),
        semantic: true,
        corroboration: ["exact-symbol-match"],
      }),
    ).toBe("direct");
  });

  it("FENCE 1: a non-semantic provider kind cannot reach direct, even claiming semantics", () => {
    for (const kind of ["import-graph", "path-heuristics"] as const) {
      expect(
        classifyEdge({
          providerKind: kind,
          from: symbolNode("src/a.ts", "A", "parser"),
          to: symbolNode("src/b.ts", "B", "parser"),
          semantic: true,
          corroboration: ["exact-symbol-match"],
        }),
      ).toBe("structural");
    }
  });

  it("FENCE 2: a regex-fallback or path endpoint cannot be promoted to direct", () => {
    for (const proof of ["regex-fallback", "path"] as const) {
      expect(
        classifyEdge({
          providerKind: "symbol",
          from: symbolNode("src/a.ts", "A", proof),
          to: symbolNode("src/b.ts", "B", "parser"),
          semantic: true,
          corroboration: ["exact-symbol-match"],
        }),
      ).toBe("structural");
    }
  });

  it("each fence alone suffices — neither depends on the other", () => {
    // Semantic provider, unproven endpoint.
    expect(
      classifyEdge({
        providerKind: "reference-index",
        from: fileNode("src/a.ts", "path"),
        to: symbolNode("src/b.ts", "B", "reference-index"),
        semantic: true,
        corroboration: ["import-edge"],
      }),
    ).toBe("structural");
    // Proven endpoints, non-semantic provider, no corroboration at all.
    expect(
      classifyEdge({
        providerKind: "path-heuristics",
        from: symbolNode("src/a.ts", "A", "parser"),
        to: symbolNode("src/b.ts", "B", "parser"),
        semantic: true,
        corroboration: [],
      }),
    ).toBe("heuristic");
  });
});

// ---------------------------------------------------------------------------
// 4. Structural: never co-occurrence
// ---------------------------------------------------------------------------

describe("classifyEdge — structural is never mere co-occurrence", () => {
  const coOccurrenceOnly: readonly Corroboration[][] = [
    [],
    ["basename-mirror"],
    ["path-proximity"],
    ["co-change"],
    ["declaration-proven"],
    ["basename-mirror", "path-proximity", "co-change", "declaration-proven"],
  ];

  it.each(coOccurrenceOnly.map((c) => [c.join(",") || "<none>", c] as const))(
    "corroboration [%s] stays heuristic",
    (_label, corroboration) => {
      expect(
        classifyEdge({
          providerKind: "path-heuristics",
          from: fileNode("src/a.ts", "path"),
          to: fileNode("src/a.spec.ts", "path"),
          semantic: false,
          corroboration,
        }),
      ).toBe("heuristic");
    },
  );

  it.each([["exact-symbol-match"], ["import-edge"]] as const)(
    "corroboration [%s] earns structural",
    (token) => {
      expect(
        classifyEdge({
          providerKind: "path-heuristics",
          from: fileNode("src/a.ts", "path"),
          to: fileNode("src/a.spec.ts", "path"),
          semantic: false,
          corroboration: [token],
        }),
      ).toBe("structural");
    },
  );
});

// ---------------------------------------------------------------------------
// 5. THE FENCE
// ---------------------------------------------------------------------------

describe("the closure fence", () => {
  it("answers false for heuristic and true for the other two", () => {
    expect(canSupportClosure("direct")).toBe(true);
    expect(canSupportClosure("structural")).toBe(true);
    expect(canSupportClosure("heuristic")).toBe(false);
  });

  it("a heuristic-only support set can never close an obligation", () => {
    const heuristicOnly = [
      edge({ evidenceClass: "heuristic", corroboration: ["basename-mirror"] }),
      edge({ evidenceClass: "heuristic", corroboration: ["path-proximity"] }),
    ];
    expect(canCloseObligation(heuristicOnly)).toBe(false);
  });

  it("an empty support set can never close an obligation", () => {
    expect(canCloseObligation([])).toBe(false);
  });

  it("one non-heuristic edge is enough, and extra heuristic ones do not spoil it", () => {
    expect(
      canCloseObligation([
        edge({ evidenceClass: "heuristic", corroboration: ["basename-mirror"] }),
        edge({ evidenceClass: "direct" }),
      ]),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. required eligibility
// ---------------------------------------------------------------------------

describe("edgeCanSupportRequired", () => {
  it("direct always qualifies", () => {
    expect(edgeCanSupportRequired(edge({ evidenceClass: "direct" }))).toBe(true);
  });

  it("structural qualifies ONLY with an exact symbol correspondence", () => {
    expect(
      edgeCanSupportRequired(
        edge({ evidenceClass: "structural", corroboration: ["exact-symbol-match"] }),
      ),
    ).toBe(true);
    expect(
      edgeCanSupportRequired(edge({ evidenceClass: "structural", corroboration: ["import-edge"] })),
    ).toBe(false);
  });

  it("heuristic never qualifies, whatever it carries", () => {
    expect(
      edgeCanSupportRequired(
        edge({ evidenceClass: "heuristic", corroboration: ["exact-symbol-match"] }),
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. Provider caps
// ---------------------------------------------------------------------------

describe("provider class caps", () => {
  it("no provider kind may ever mint direct except the two semantic ones", () => {
    for (const kind of ALL_KINDS) {
      const cap = maxEvidenceClassFor(kind);
      const expected = kind === "reference-index" || kind === "symbol" ? "direct" : "structural";
      expect(cap, kind).toBe(expected);
    }
  });

  it("path heuristics produce heuristic UNAIDED even though corroboration can lift them", () => {
    expect(unaidedEvidenceClassFor("path-heuristics")).toBe("heuristic");
    expect(maxEvidenceClassFor("path-heuristics")).toBe("structural");
    expect(unaidedEvidenceClassFor("import-graph")).toBe("structural");
    expect(unaidedEvidenceClassFor("reference-index")).toBe("direct");
    expect(unaidedEvidenceClassFor("symbol")).toBe("direct");
  });
});

// ---------------------------------------------------------------------------
// 8. validateEdge catches a forged edge
// ---------------------------------------------------------------------------

describe("validateEdge", () => {
  it("passes a well-formed edge", () => {
    expect(validateEdge(edge())).toEqual([]);
  });

  it("rejects a path-heuristics edge forged as direct", () => {
    const forged = edge({
      providerKind: "path-heuristics",
      evidenceClass: "direct",
      from: fileNode("src/a.ts", "path"),
      to: fileNode("src/a.spec.ts", "path"),
    });
    const violations = validateEdge(forged);
    expect(violations.length).toBeGreaterThanOrEqual(2);
    expect(violations.join(" ")).toContain("path-heuristics");
    expect(violations.join(" ")).toContain("semantic proof on both endpoints");
  });

  it("rejects direct on a regex-fallback endpoint", () => {
    const violations = validateEdge(
      edge({ from: symbolNode("src/a.ts", "A", "regex-fallback"), evidenceClass: "direct" }),
    );
    expect(violations.join(" ")).toContain("semantic proof on both endpoints");
  });

  it("rejects structural without a structural corroboration", () => {
    const violations = validateEdge(
      edge({ evidenceClass: "structural", corroboration: ["basename-mirror"] }),
    );
    expect(violations.join(" ")).toContain("co-occurrence");
  });

  it("rejects an unstamped edge", () => {
    expect(validateEdge(edge({ sourceSha: "" })).join(" ")).toContain("unstamped");
    expect(validateEdge(edge({ indexGeneration: "" })).join(" ")).toContain("unstamped");
    expect(validateEdge(edge({ sourceShaPath: "" })).join(" ")).toContain("sourceShaPath");
  });
});

// ---------------------------------------------------------------------------
// 9. Lattices and ordering
// ---------------------------------------------------------------------------

describe("lattices", () => {
  it("a path is only as strong as its weakest edge", () => {
    const classes: readonly EvidenceClass[] = ["direct", "structural", "heuristic"];
    for (const a of classes) {
      for (const b of classes) {
        const weak = weakerClass(a, b);
        expect(weak === a || weak === b).toBe(true);
        expect(strongerClass(a, b) === a || strongerClass(a, b) === b).toBe(true);
      }
    }
    expect(weakerClass("direct", "heuristic")).toBe("heuristic");
    expect(strongerClass("structural", "heuristic")).toBe("structural");
  });

  it("unknown coverage is WEAKER than partial — 'cannot say' is the worse answer", () => {
    expect(weakerCoverage("complete", "partial")).toBe("partial");
    expect(weakerCoverage("partial", "unknown")).toBe("unknown");
    expect(weakerCoverage("complete", "unknown")).toBe("unknown");
  });

  it("orders edges deterministically by type then identity", () => {
    const a = edge({ type: "CALLS" });
    const b = edge({ type: "REFERENCES" });
    expect(compareEdges(a, b)).toBeLessThan(0);
    expect(compareEdges(b, a)).toBeGreaterThan(0);
    expect(compareEdges(a, a)).toBe(0);
    expect(edgeId(a)).toContain("CALLS|symbol:src/a.ts#A|symbol:src/b.ts#B");
  });
});
