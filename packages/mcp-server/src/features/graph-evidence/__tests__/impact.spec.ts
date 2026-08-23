// ---------------------------------------------------------------------------
// impact.spec.ts — V11-01 acceptance: impact analysis.
//
// Plan §V11-01 受入基準 covered here:
//   * direct edge precision 100%       — against a ground truth known BY
//                                        CONSTRUCTION, not by re-asserting the
//                                        classifier's own definition.
//   * structural precision ≥95%        — same ground truth; decoys that merely
//                                        co-occur must never reach structural.
//   * heuristic-only closure 0 件      — a heuristic-only overlay cannot close.
//   * graph explosion fixture          — caps hold, truncation reported,
//                                        coverage degrades to partial.
//   * stale edge 0 件                  — inside a real expansion.
//   * TESTED_BY / CONFIGURES /
//     GENERATED_FROM                   — structural-or-heuristic per rule,
//                                        never direct.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";

import { createPathHeuristicsProvider } from "../adapters.js";
import type { ExpansionBounds } from "../bounds.js";
import { analyzeImpact, nodesInTier, supportsClosure, type ImpactResult } from "../impact.js";
import { canSupportClosure, nodeId, validateEdge, type GraphEdge } from "../model.js";
import { providerIdentities, type ProviderSet } from "../providers.js";
import { isFreshEdge, makeGenerationView, type GenerationView } from "../stale.js";
import {
  fixtureImportProvider,
  fixtureReferenceProvider,
  fixtureSha,
  fixtureSymbolProvider,
  shaMapFor,
  PATH_ID,
} from "./support.js";

// ---------------------------------------------------------------------------
// A workspace whose relations are known by construction
// ---------------------------------------------------------------------------
//
//   src/registry.ts              declares `Registry`
//   src/consumerA|B.ts           import it AND reference `Registry`
//   src/plugin.ts                imports it, references it, `Plugin extends Registry`
//   src/__tests__/registry.spec  imports it AND references `Registry`  (real test)
//   src/lonely.ts                DECOY: nothing imports or references it
//   src/__tests__/lonely.spec.ts DECOY: mirrors `lonely` by NAME only — no import
//   src/schema.proto / .pb.ts    generated pair, naming evidence only
//   tsconfig.json                root config — proximity evidence only

const FILES = [
  "tsconfig.json",
  "src/registry.ts",
  "src/consumerA.ts",
  "src/consumerB.ts",
  "src/plugin.ts",
  "src/lonely.ts",
  "src/schema.proto",
  "src/schema.pb.ts",
  "src/__tests__/registry.spec.ts",
  "src/__tests__/lonely.spec.ts",
];

/**
 * Ground truth: every relation that ACTUALLY holds in the fixture above,
 * written out by hand from the fixture's construction. A `direct` or
 * `structural` edge outside this set is a precision failure.
 */
const TRUE_RELATIONS: ReadonlySet<string> = new Set([
  "REFERENCES|file:src/consumerA.ts|symbol:src/registry.ts#Registry",
  "REFERENCES|file:src/consumerB.ts|symbol:src/registry.ts#Registry",
  "REFERENCES|file:src/plugin.ts|symbol:src/registry.ts#Registry",
  "REFERENCES|file:src/__tests__/registry.spec.ts|symbol:src/registry.ts#Registry",
  "EXTENDS|symbol:src/plugin.ts#Plugin|symbol:src/registry.ts#Registry",
  "IMPORTED_BY|file:src/registry.ts|file:src/consumerA.ts",
  "IMPORTED_BY|file:src/registry.ts|file:src/consumerB.ts",
  "IMPORTED_BY|file:src/registry.ts|file:src/plugin.ts",
  "IMPORTED_BY|file:src/registry.ts|file:src/__tests__/registry.spec.ts",
  "IMPORTS|file:src/consumerA.ts|file:src/registry.ts",
  "IMPORTS|file:src/consumerB.ts|file:src/registry.ts",
  "IMPORTS|file:src/plugin.ts|file:src/registry.ts",
  "IMPORTS|file:src/__tests__/registry.spec.ts|file:src/registry.ts",
  "TESTED_BY|file:src/registry.ts|file:src/__tests__/registry.spec.ts",
]);

/** Relations that exist only as naming or proximity coincidences. */
const DECOY_RELATIONS: readonly string[] = [
  "TESTED_BY|file:src/lonely.ts|file:src/__tests__/lonely.spec.ts",
  "GENERATED_FROM|file:src/schema.pb.ts|file:src/schema.proto",
  "CONFIGURES|file:tsconfig.json|file:src/registry.ts",
  "CONFIGURES|file:tsconfig.json|file:src/lonely.ts",
];

function relationKey(edge: GraphEdge): string {
  return `${edge.type}|${nodeId(edge.from)}|${nodeId(edge.to)}`;
}

function buildProviders(): ProviderSet {
  return {
    references: fixtureReferenceProvider({
      definitions: {
        Registry: { path: "src/registry.ts", line: 3 },
        Plugin: { path: "src/plugin.ts", line: 5 },
        Lonely: { path: "src/lonely.ts", line: 1 },
      },
      references: {
        Registry: [
          "src/consumerA.ts",
          "src/consumerB.ts",
          "src/plugin.ts",
          "src/__tests__/registry.spec.ts",
        ],
        Plugin: [],
        Lonely: [],
      },
    }),
    imports: fixtureImportProvider({
      files: FILES,
      imports: {
        "src/consumerA.ts": ["src/registry.ts"],
        "src/consumerB.ts": ["src/registry.ts"],
        "src/plugin.ts": ["src/registry.ts"],
        "src/__tests__/registry.spec.ts": ["src/registry.ts"],
      },
      exports: {
        "src/registry.ts": ["Registry"],
        "src/plugin.ts": ["Plugin"],
        "src/lonely.ts": ["Lonely"],
      },
    }),
    symbols: fixtureSymbolProvider({
      declarations: [
        {
          path: "src/registry.ts",
          name: "Registry",
          kind: "class",
          line: 3,
          proof: "parser",
          heritageProof: "parser",
        },
        {
          path: "src/plugin.ts",
          name: "Plugin",
          kind: "class",
          line: 5,
          proof: "parser",
          heritageProof: "parser",
          extendsNames: ["Registry"],
        },
        { path: "src/lonely.ts", name: "Lonely", kind: "class", line: 1, proof: "parser" },
      ],
    }),
    paths: createPathHeuristicsProvider({
      files: FILES,
      sourceShas: shaMapFor(FILES),
      languages: ["typescript"],
      id: PATH_ID,
    }),
  };
}

function viewFor(providers: ProviderSet, files: readonly string[] = FILES): GenerationView {
  return makeGenerationView(
    providerIdentities(providers).map(
      (identity) => [identity.id, identity.indexGeneration] as const,
    ),
    files.map((target) => [target, fixtureSha(target)] as const),
  );
}

const ROOMY: ExpansionBounds = {
  maxNodes: 60,
  maxDepth: 3,
  maxFanout: 25,
  maxBytes: 200_000,
  maxDurationMs: 5_000,
};

function runRegistryImpact(bounds: ExpansionBounds = ROOMY): ImpactResult {
  const providers = buildProviders();
  return analyzeImpact({
    seeds: [{ kind: "symbol", path: "src/registry.ts", symbol: "Registry" }],
    providers,
    bounds,
    generations: viewFor(providers),
  });
}

// ---------------------------------------------------------------------------
// 1. Precision
// ---------------------------------------------------------------------------

describe("edge precision on a ground-truth fixture", () => {
  it("direct edge precision is 100%", () => {
    const direct = runRegistryImpact().edges.filter((e) => e.evidenceClass === "direct");
    expect(direct.length).toBeGreaterThan(0);
    const wrong = direct.map(relationKey).filter((key) => !TRUE_RELATIONS.has(key));
    expect(wrong, "direct edges with no ground-truth relation behind them").toEqual([]);
  });

  it("structural edge precision is 100% (target: >= 95%)", () => {
    const structural = runRegistryImpact().edges.filter((e) => e.evidenceClass === "structural");
    expect(structural.length).toBeGreaterThan(0);
    const wrong = structural.map(relationKey).filter((key) => !TRUE_RELATIONS.has(key));
    expect(wrong, "structural edges with no ground-truth relation behind them").toEqual([]);
    expect((structural.length - wrong.length) / structural.length).toBeGreaterThanOrEqual(0.95);
  });

  it("a naming or proximity coincidence NEVER reaches direct or structural", () => {
    const byKey = new Map(runRegistryImpact().edges.map((e) => [relationKey(e), e] as const));
    for (const decoy of DECOY_RELATIONS) {
      const edge = byKey.get(decoy);
      expect(edge, `decoy relation ${decoy} was not derived at all`).toBeDefined();
      expect(edge?.evidenceClass, decoy).toBe("heuristic");
    }
  });

  it("every emitted edge satisfies the model's own invariants", () => {
    for (const edge of runRegistryImpact().edges) {
      expect(validateEdge(edge), relationKey(edge)).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. TESTED_BY / CONFIGURES / GENERATED_FROM
// ---------------------------------------------------------------------------

describe("path-derived edge types", () => {
  it("all three are derived, and none of them is ever direct", () => {
    const edges = runRegistryImpact().edges;
    for (const type of ["TESTED_BY", "CONFIGURES", "GENERATED_FROM"] as const) {
      const derived = edges.filter((e) => e.type === type);
      expect(derived.length, `${type} was never derived`).toBeGreaterThan(0);
      for (const edge of derived) {
        expect(edge.evidenceClass, `${type} must not be direct`).not.toBe("direct");
        expect(edge.providerKind).toBe("path-heuristics");
      }
    }
  });

  it("TESTED_BY is STRUCTURAL when the test actually imports its subject", () => {
    const edge = runRegistryImpact().edges.find(
      (candidate) =>
        relationKey(candidate) === "TESTED_BY|file:src/registry.ts|file:src/__tests__/registry.spec.ts",
    );
    expect(edge?.evidenceClass).toBe("structural");
    expect(edge?.corroboration).toContain("import-edge");
    expect(edge?.corroboratedBy).toBeDefined();
  });

  it("TESTED_BY stays HEURISTIC when only the names line up", () => {
    const edge = runRegistryImpact().edges.find(
      (candidate) =>
        relationKey(candidate) === "TESTED_BY|file:src/lonely.ts|file:src/__tests__/lonely.spec.ts",
    );
    expect(edge?.evidenceClass).toBe("heuristic");
    expect(edge?.corroboration).toEqual(["basename-mirror"]);
  });

  it("a structural TESTED_BY still cannot make its test REQUIRED on its own", () => {
    // It carries `import-edge`, not `exact-symbol-match` — see
    // REQUIRED_CORROBORATIONS. The spec file here is `required` anyway, but via
    // the DIRECT reference edge, which is the point: the tier names the
    // strongest path, and a corroborated naming guess is not it.
    const spec = "file:src/__tests__/registry.spec.ts";
    const result = runRegistryImpact();
    const node = result.nodes.find((candidate) => nodeId(candidate.node) === spec);
    expect(node?.tier).toBe("required");
    expect(node?.evidenceClass).toBe("direct");
  });
});

// ---------------------------------------------------------------------------
// 3. Tiering
// ---------------------------------------------------------------------------

describe("required / likely / informational", () => {
  it("puts every direct consumer in required", () => {
    const required = new Set(nodesInTier(runRegistryImpact(), "required").map((n) => nodeId(n.node)));
    expect(required).toContain("symbol:src/registry.ts#Registry");
    expect(required).toContain("file:src/consumerA.ts");
    expect(required).toContain("file:src/consumerB.ts");
    expect(required).toContain("file:src/plugin.ts");
    expect(required).toContain("symbol:src/plugin.ts#Plugin");
  });

  it("NO required node rests on heuristic evidence", () => {
    for (const node of nodesInTier(runRegistryImpact(), "required")) {
      expect(node.evidenceClass, nodeId(node.node)).not.toBe("heuristic");
      expect(canSupportClosure(node.evidenceClass)).toBe(true);
    }
  });

  it("a heuristic path lands in informational, however deep the chain continues", () => {
    const result = runRegistryImpact();
    const informational = new Set(
      nodesInTier(result, "informational").map((node) => nodeId(node.node)),
    );
    // Proximity-only: the root config, and everything reached only through it.
    expect(informational).toContain("file:tsconfig.json");
    expect(informational).toContain("file:src/lonely.ts");
    // The weakest-edge rule caps the whole path — a decoy cannot be laundered
    // into `required` by a later strong hop.
    for (const node of nodesInTier(result, "informational")) {
      expect(node.evidenceClass, nodeId(node.node)).toBe("heuristic");
    }
  });

  it("counts add up to the node set", () => {
    const result = runRegistryImpact();
    const total = result.counts.required + result.counts.likely + result.counts.informational;
    expect(total).toBe(result.nodes.length);
  });

  it("orders nodes required → likely → informational, then by depth", () => {
    const result = runRegistryImpact();
    const rank = { required: 0, likely: 1, informational: 2 } as const;
    for (let i = 1; i < result.nodes.length; i++) {
      const previous = result.nodes[i - 1];
      const current = result.nodes[i];
      if (previous === undefined || current === undefined) continue;
      expect(rank[previous.tier]).toBeLessThanOrEqual(rank[current.tier]);
    }
  });

  it("is deterministic — the same inputs give the same result", () => {
    expect(JSON.stringify(runRegistryImpact())).toBe(JSON.stringify(runRegistryImpact()));
  });
});

// ---------------------------------------------------------------------------
// 4. Structural without corroboration is `likely`, never `required`
// ---------------------------------------------------------------------------

describe("structural corroboration decides required vs likely", () => {
  function importOnlyProviders(): ProviderSet {
    return {
      // No reference provider: nothing can prove an exact symbol
      // correspondence, so the import edge stays uncorroborated.
      imports: fixtureImportProvider({
        files: ["src/a.ts", "src/b.ts"],
        imports: { "src/a.ts": ["src/b.ts"] },
      }),
    };
  }

  it("an uncorroborated import puts its target in likely", () => {
    const providers = importOnlyProviders();
    const result = analyzeImpact({
      seeds: [{ kind: "file", path: "src/a.ts" }],
      providers,
      bounds: ROOMY,
      generations: viewFor(providers, ["src/a.ts", "src/b.ts"]),
    });
    const edge = result.edges.find((candidate) => candidate.type === "IMPORTS");
    expect(edge?.evidenceClass).toBe("structural");
    expect(edge?.corroboration).toEqual(["import-edge"]);
    expect(result.nodes.find((n) => nodeId(n.node) === "file:src/b.ts")?.tier).toBe("likely");
  });

  it("the same import becomes required once an exact symbol correspondence exists", () => {
    const providers: ProviderSet = {
      imports: fixtureImportProvider({
        files: ["src/a.ts", "src/b.ts"],
        imports: { "src/a.ts": ["src/b.ts"] },
        exports: { "src/b.ts": ["B"] },
      }),
      references: fixtureReferenceProvider({
        definitions: { B: { path: "src/b.ts", line: 1 } },
        references: { B: ["src/a.ts"] },
      }),
    };
    const result = analyzeImpact({
      seeds: [{ kind: "file", path: "src/a.ts" }],
      providers,
      bounds: ROOMY,
      generations: viewFor(providers, ["src/a.ts", "src/b.ts"]),
    });
    const edge = result.edges.find((candidate) => candidate.type === "IMPORTS");
    expect(edge?.corroboration).toContain("exact-symbol-match");
    expect(result.nodes.find((n) => nodeId(n.node) === "file:src/b.ts")?.tier).toBe("required");
  });

  it("depth demotes required to likely past requiredMaxDepth, and never the reverse", () => {
    const providers = buildProviders();
    const shallow = analyzeImpact({
      seeds: [{ kind: "symbol", path: "src/registry.ts", symbol: "Registry" }],
      providers,
      bounds: ROOMY,
      generations: viewFor(providers),
      requiredMaxDepth: 0,
    });
    for (const node of shallow.nodes) {
      if (node.depth > 0) expect(node.tier, nodeId(node.node)).not.toBe("required");
    }
    expect(shallow.counts.likely).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Graph explosion
// ---------------------------------------------------------------------------

describe("graph explosion fixture", () => {
  const FAN_IN = 400;

  function explosion(): { providers: ProviderSet; files: readonly string[] } {
    const consumers = Array.from(
      { length: FAN_IN },
      (_unused, i) => `src/consumer-${String(i).padStart(4, "0")}.ts`,
    );
    const files = ["src/hub.ts", ...consumers];
    const imports: Record<string, readonly string[]> = {};
    for (const consumer of consumers) imports[consumer] = ["src/hub.ts"];
    return {
      files,
      providers: {
        references: fixtureReferenceProvider({
          definitions: { Hub: { path: "src/hub.ts", line: 1 } },
          references: { Hub: consumers },
        }),
        imports: fixtureImportProvider({
          files,
          imports,
          exports: { "src/hub.ts": ["Hub"] },
        }),
      },
    };
  }

  const TIGHT: ExpansionBounds = {
    maxNodes: 25,
    maxDepth: 3,
    maxFanout: 10,
    maxBytes: 200_000,
    maxDurationMs: 5_000,
  };

  function runExplosion(bounds: ExpansionBounds = TIGHT): ImpactResult {
    const { providers, files } = explosion();
    return analyzeImpact({
      seeds: [{ kind: "symbol", path: "src/hub.ts", symbol: "Hub" }],
      providers,
      bounds,
      generations: viewFor(providers, files),
    });
  }

  it("never overruns maxNodes on a 400-consumer hub", () => {
    const result = runExplosion();
    expect(result.nodes.length).toBeLessThanOrEqual(TIGHT.maxNodes);
    expect(result.nodes.length).toBeGreaterThan(1);
  });

  it("never follows more than maxFanout edges out of the hub", () => {
    const result = runExplosion();
    const outOfHub = result.edges.filter((edge) => edge.type === "REFERENCES");
    expect(outOfHub.length).toBeLessThanOrEqual(TIGHT.maxFanout);
    expect(result.truncation.counts["max-fanout"]).toBeGreaterThanOrEqual(1);
  });

  it("reports WHAT was truncated and WHY, with counts per reason", () => {
    const report = runExplosion().truncation;
    expect(report.truncated).toBe(true);
    const reasons = report.details.map((detail) => detail.reason);
    expect(reasons).toContain("max-fanout");
    const fanout = report.details.find((detail) => detail.reason === "max-fanout");
    expect(fanout?.dropped).toBe(FAN_IN - TIGHT.maxFanout);
    expect(fanout?.limit).toBe(TIGHT.maxFanout);
    expect(fanout?.at).toBe("symbol:src/hub.ts#Hub");
  });

  it("degrades coverage to partial and refuses closure under truncation", () => {
    const result = runExplosion();
    expect(result.coverage).toBe("partial");
    expect(result.coverageReasons).toContain("truncated");
    expect(result.closure.canClose).toBe(false);
    expect(result.closure.reasons).toContain("truncated");
  });

  it("respects the byte budget", () => {
    const result = runExplosion({ ...TIGHT, maxBytes: 300 });
    expect(result.truncation.counts["max-bytes"]).toBeGreaterThanOrEqual(1);
    expect(result.coverage).toBe("partial");
  });

  it("respects the depth budget", () => {
    const result = runExplosion({ ...TIGHT, maxDepth: 1 });
    expect(Math.max(...result.nodes.map((node) => node.depth))).toBeLessThanOrEqual(1);
    expect(result.truncation.counts["max-depth"]).toBeGreaterThanOrEqual(1);
  });

  it("respects the duration budget, on an injected clock", () => {
    const { providers, files } = explosion();
    let tick = 0;
    const result = analyzeImpact({
      seeds: [{ kind: "symbol", path: "src/hub.ts", symbol: "Hub" }],
      providers,
      bounds: { ...TIGHT, maxDurationMs: 5 },
      generations: viewFor(providers, files),
      now: () => {
        const now = tick;
        tick += 3;
        return now;
      },
    });
    expect(result.truncation.counts["max-duration"]).toBe(1);
    expect(result.coverage).toBe("partial");
    expect(result.closure.canClose).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. Staleness inside a real expansion
// ---------------------------------------------------------------------------

describe("stale edge 0 inside an expansion", () => {
  it("excludes and counts every edge from a provider that moved generation", () => {
    const providers = buildProviders();
    const referenceId = providers.references?.identity.id ?? "";
    const stalled = makeGenerationView(
      providerIdentities(providers).map(
        (identity) =>
          [
            identity.id,
            identity.id === referenceId ? "moved-generation" : identity.indexGeneration,
          ] as const,
      ),
      FILES.map((target) => [target, fixtureSha(target)] as const),
    );

    const result = analyzeImpact({
      seeds: [{ kind: "symbol", path: "src/registry.ts", symbol: "Registry" }],
      providers,
      bounds: ROOMY,
      generations: stalled,
    });

    expect(result.stale.excluded).toBeGreaterThan(0);
    expect(result.stale.counts["generation-mismatch"]).toBe(result.stale.excluded);
    expect(result.edges.filter((edge) => edge.provider === referenceId)).toEqual([]);
    expect(result.coverage).toBe("partial");
    expect(result.coverageReasons.join(" ")).toContain("stale-edges-excluded");
    expect(result.closure.canClose).toBe(false);
  });

  it("excludes every edge whose proving file changed", () => {
    const providers = buildProviders();
    const moved = makeGenerationView(
      providerIdentities(providers).map(
        (identity) => [identity.id, identity.indexGeneration] as const,
      ),
      FILES.map(
        (target) =>
          [target, target === "src/consumerA.ts" ? "sha256:moved" : fixtureSha(target)] as const,
      ),
    );
    const result = analyzeImpact({
      seeds: [{ kind: "symbol", path: "src/registry.ts", symbol: "Registry" }],
      providers,
      bounds: ROOMY,
      generations: moved,
    });
    expect(result.stale.counts["source-sha-mismatch"]).toBeGreaterThan(0);
    expect(
      result.edges.filter((edge) => edge.sourceShaPath === "src/consumerA.ts"),
    ).toEqual([]);
  });

  it("the surviving edge set is fresh by construction, in every scenario", () => {
    const providers = buildProviders();
    const views: readonly GenerationView[] = [
      viewFor(providers),
      makeGenerationView([], []),
      makeGenerationView(
        providerIdentities(providers).map((identity) => [identity.id, "wrong"] as const),
        FILES.map((target) => [target, fixtureSha(target)] as const),
      ),
    ];
    for (const view of views) {
      const result = analyzeImpact({
        seeds: [{ kind: "symbol", path: "src/registry.ts", symbol: "Registry" }],
        providers,
        bounds: ROOMY,
        generations: view,
      });
      for (const edge of result.edges) expect(isFreshEdge(edge, view)).toBe(true);
    }
  });

  it("an unprovable view leaves the seeds and nothing else", () => {
    const providers = buildProviders();
    const result = analyzeImpact({
      seeds: [{ kind: "symbol", path: "src/registry.ts", symbol: "Registry" }],
      providers,
      bounds: ROOMY,
      generations: makeGenerationView([], []),
    });
    expect(result.edges).toEqual([]);
    expect(result.nodes.map((node) => nodeId(node.node)).sort()).toEqual([
      "file:src/registry.ts",
      "symbol:src/registry.ts#Registry",
    ]);
    expect(result.closure.canClose).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. Closure
// ---------------------------------------------------------------------------

describe("closure", () => {
  it("a complete, untruncated, fresh expansion may close", () => {
    const result = runRegistryImpact();
    expect(result.truncation.truncated).toBe(false);
    expect(result.stale.excluded).toBe(0);
    expect(result.coverage).toBe("complete");
    expect(result.closure).toEqual({ canClose: true, reasons: [] });
  });

  it("an advisory-only overlay can NEVER close — 0 heuristic-only closures", () => {
    const providers: ProviderSet = {
      paths: createPathHeuristicsProvider({
        files: FILES,
        sourceShas: shaMapFor(FILES),
        languages: ["typescript"],
        id: PATH_ID,
      }),
    };
    const result = analyzeImpact({
      seeds: [{ kind: "file", path: "src/lonely.ts" }],
      providers,
      bounds: ROOMY,
      generations: viewFor(providers),
    });

    expect(result.edges.length).toBeGreaterThan(0);
    for (const edge of result.edges) expect(edge.evidenceClass).toBe("heuristic");
    expect(result.coverage).toBe("unknown");
    expect(result.closure.canClose).toBe(false);
    expect(result.counts.required).toBe(1); // the seed itself, nothing else
    expect(supportsClosure(result.edges)).toBe(false);
  });

  it("a heuristic support set cannot close even inside an otherwise strong result", () => {
    const result = runRegistryImpact();
    const heuristicOnly = result.edges.filter((edge) => edge.evidenceClass === "heuristic");
    expect(heuristicOnly.length).toBeGreaterThan(0);
    expect(supportsClosure(heuristicOnly)).toBe(false);
    expect(supportsClosure(result.edges)).toBe(true);
  });
});
