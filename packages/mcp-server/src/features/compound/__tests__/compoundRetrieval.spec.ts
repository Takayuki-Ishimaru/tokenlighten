// ---------------------------------------------------------------------------
// compoundRetrieval.spec.ts — V11-05: the pure engine, driven by injected
// graph-evidence fixture providers (reused from
// features/graph-evidence/__tests__/support.ts — not a spec file, see its own
// header). No filesystem, no tl-graph, no locator pool: exactly the surfaces
// `runCompoundRetrieval` actually sees.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";

import {
  fixtureImportProvider,
  fixtureReferenceProvider,
  fixtureView,
  REF_ID,
  type ImportFixture,
  type ReferenceFixture,
} from "../../graph-evidence/__tests__/support.js";
import type { ProviderSet } from "../../graph-evidence/index.js";
import {
  COMPOUND_BOUNDS,
  COMPOUND_MAX_BYTES,
  COMPOUND_MAX_DEPTH,
  COMPOUND_MAX_DURATION_MS,
  COMPOUND_MAX_FANOUT,
  COMPOUND_MAX_NODES,
  runCompoundRetrieval,
  type CompoundAppliedResult,
} from "../compoundRetrieval.js";

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

describe("COMPOUND_BOUNDS — the fixed, conservative defaults", () => {
  it("matches the documented internal constants exactly", () => {
    expect(COMPOUND_BOUNDS).toEqual({
      maxNodes: 48,
      maxDepth: 2,
      maxFanout: 8,
      maxBytes: 64 * 1024,
      maxDurationMs: 250,
    });
    expect(COMPOUND_MAX_DEPTH).toBe(2);
    expect(COMPOUND_MAX_FANOUT).toBe(8);
    expect(COMPOUND_MAX_NODES).toBe(48);
    expect(COMPOUND_MAX_BYTES).toBe(64 * 1024);
    expect(COMPOUND_MAX_DURATION_MS).toBe(250);
  });
});

// ---------------------------------------------------------------------------
// Decline: provider-incomplete
// ---------------------------------------------------------------------------

describe("runCompoundRetrieval — provider-incomplete decline", () => {
  it("declines when the provider set is completely empty", () => {
    const result = runCompoundRetrieval({
      seed: { kind: "file", path: "src/foo.ts" },
      providers: {},
      generations: fixtureView([]),
    });
    expect(result.applied).toBe(false);
    if (result.applied) throw new Error("unreachable");
    expect(result.reason).toBe("provider-incomplete");
  });

  it("does NOT decline provider-incomplete merely because coverage is 'unknown' — a real (even single) provider is enough to attempt the hop", () => {
    // fixtureReferenceProvider defaults to complete coverage; override to the
    // ROUTINE tl-graph posture (unknown) and confirm this alone is not the
    // provider-incomplete trigger — see this file's header on the
    // "provider-incomplete" vs "coverage partial/unknown" distinction.
    const fixture: ReferenceFixture = {
      definitions: { Foo: { path: "src/foo.ts", line: 1 } },
      references: { Foo: [] },
      coverage: { status: "unknown", languages: [], reason: "test: unchecked" },
    };
    const providers: ProviderSet = { references: fixtureReferenceProvider(fixture) };
    const result = runCompoundRetrieval({
      seed: { kind: "symbol", path: "src/foo.ts", symbol: "Foo" },
      providers,
      generations: fixtureView(["src/foo.ts"]),
    });
    expect(result.applied).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Decline: stale-evidence
// ---------------------------------------------------------------------------

describe("runCompoundRetrieval — stale-evidence decline", () => {
  const fixture: ReferenceFixture = {
    definitions: { Foo: { path: "src/foo.ts", line: 1 } },
    references: { Foo: ["src/bar.ts"] },
  };

  it("declines when the freshness oracle's generation disagrees with the stamped edge", () => {
    const providers: ProviderSet = { references: fixtureReferenceProvider(fixture) };
    const staleView = fixtureView(["src/foo.ts", "src/bar.ts"], {
      generations: { [REF_ID]: "a-different-generation" },
    });
    const result = runCompoundRetrieval({
      seed: { kind: "symbol", path: "src/foo.ts", symbol: "Foo" },
      providers,
      generations: staleView,
    });
    expect(result.applied).toBe(false);
    if (result.applied) throw new Error("unreachable");
    expect(result.reason).toBe("stale-evidence");
    expect(result.detail).toMatch(/edge\(s\) failed/);
  });

  it("declines when the freshness oracle's source sha disagrees (content moved)", () => {
    const providers: ProviderSet = { references: fixtureReferenceProvider(fixture) };
    const staleView = fixtureView(["src/foo.ts", "src/bar.ts"], {
      shas: { "src/bar.ts": "sha256:changed" },
    });
    const result = runCompoundRetrieval({
      seed: { kind: "symbol", path: "src/foo.ts", symbol: "Foo" },
      providers,
      generations: staleView,
    });
    expect(result.applied).toBe(false);
    if (result.applied) throw new Error("unreachable");
    expect(result.reason).toBe("stale-evidence");
  });

  it("a CLEAN freshness oracle over the same fixture applies normally (control)", () => {
    const providers: ProviderSet = { references: fixtureReferenceProvider(fixture) };
    const result = runCompoundRetrieval({
      seed: { kind: "symbol", path: "src/foo.ts", symbol: "Foo" },
      providers,
      generations: fixtureView(["src/foo.ts", "src/bar.ts"]),
    });
    expect(result.applied).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Applied: seed exclusion, tier mapping, partial propagation
// ---------------------------------------------------------------------------

describe("runCompoundRetrieval — applied result shape", () => {
  const fixture: ReferenceFixture = {
    definitions: { Widget: { path: "src/widget.ts", line: 1 } },
    references: { Widget: ["src/panel.ts", "src/dialog.ts"] },
  };

  function apply(): CompoundAppliedResult {
    const providers: ProviderSet = { references: fixtureReferenceProvider(fixture) };
    const result = runCompoundRetrieval({
      seed: { kind: "symbol", path: "src/widget.ts", symbol: "Widget" },
      providers,
      generations: fixtureView(["src/widget.ts", "src/panel.ts", "src/dialog.ts"]),
    });
    if (!result.applied) throw new Error(`expected applied, got declined: ${result.reason}`);
    return result;
  }

  it("never includes the seed (or its file companion) among the discovered nodes", () => {
    const result = apply();
    expect(result.nodes.some((n) => n.path === "src/widget.ts" && n.symbol === "Widget")).toBe(false);
  });

  it("discovers both direct references at required tier, depth 1", () => {
    const result = apply();
    const byPath = new Map(result.nodes.map((n) => [n.path, n]));
    expect(byPath.get("src/panel.ts")).toMatchObject({ tier: "required", depth: 1 });
    expect(byPath.get("src/dialog.ts")).toMatchObject({ tier: "required", depth: 1 });
  });

  it("counts spans ALL visited nodes (seeds included); nodes excludes the seed(s) exactly", () => {
    const result = apply();
    const sum = result.counts.required + result.counts.likely + result.counts.informational;
    // impact.ts's counts are computed over every visited node, seeds included
    // (a seed is always tier "required" — depth 0 short-circuits tierFor); this
    // engine's own `nodes` deliberately excludes the seed(s), so the two must
    // differ by EXACTLY `seeds.length`, not merely bound one another loosely.
    expect(sum).toBe(result.nodes.length + result.seeds.length);
  });

  it("partial is false and partialReasons is empty for a complete, untruncated, fresh fixture", () => {
    const result = apply();
    expect(result.partial).toBe(false);
    expect(result.partialReasons).toEqual([]);
  });

  it("partial becomes true (PI-02) the moment coverage is anything but complete — never silently dropped", () => {
    const partialFixture: ReferenceFixture = {
      ...fixture,
      coverage: { status: "partial", languages: ["typescript"], reason: "test: partial coverage" },
    };
    const providers: ProviderSet = { references: fixtureReferenceProvider(partialFixture) };
    const result = runCompoundRetrieval({
      seed: { kind: "symbol", path: "src/widget.ts", symbol: "Widget" },
      providers,
      generations: fixtureView(["src/widget.ts", "src/panel.ts", "src/dialog.ts"]),
    });
    if (!result.applied) throw new Error(`expected applied, got declined: ${result.reason}`);
    expect(result.partial).toBe(true);
    expect(result.partialReasons.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Bounds never exceeded — explosion fixture
// ---------------------------------------------------------------------------

describe("runCompoundRetrieval — explosion fixture never exceeds bounds", () => {
  it("a hub symbol with far more references than COMPOUND_MAX_FANOUT truncates, never silently expands past it", () => {
    const hubRefs = Array.from({ length: COMPOUND_MAX_FANOUT * 4 }, (_, i) => `src/consumer${i}.ts`);
    const fixture: ReferenceFixture = {
      definitions: { Hub: { path: "src/hub.ts", line: 1 } },
      references: { Hub: hubRefs },
    };
    const providers: ProviderSet = { references: fixtureReferenceProvider(fixture) };
    const result = runCompoundRetrieval({
      seed: { kind: "symbol", path: "src/hub.ts", symbol: "Hub" },
      providers,
      generations: fixtureView(["src/hub.ts", ...hubRefs]),
    });
    if (!result.applied) throw new Error(`expected applied, got declined: ${result.reason}`);

    expect(result.truncation.truncated).toBe(true);
    expect(result.truncation.counts["max-fanout"]).toBeGreaterThan(0);
    expect(result.partial).toBe(true);
    // The fanout cap alone bounds the ADMITTED node count to COMPOUND_MAX_FANOUT.
    expect(result.nodes.length).toBeLessThanOrEqual(COMPOUND_MAX_FANOUT);
  });

  it("a WIDE two-hop import tree (each node's OWN fanout under the cap) exceeds COMPOUND_MAX_NODES in total and truncates via max-nodes specifically", () => {
    // 8 depth-1 importers of the seed, each with its OWN 8 depth-2 importers —
    // 1 + 8 + 64 = 73 potential admissions, every SINGLE node's fanout exactly
    // at COMPOUND_MAX_FANOUT (8, so limitFanout's `items.length <= maxFanout`
    // never trips) — isolating the max-nodes cap from the max-fanout cap that
    // the previous test already covers.
    const mids = Array.from({ length: COMPOUND_MAX_FANOUT }, (_, i) => `src/mid${i}.ts`);
    const imports: Record<string, readonly string[]> = {};
    for (const mid of mids) imports[mid] = ["src/core.ts"];
    const leaves: string[] = [];
    for (let i = 0; i < mids.length; i++) {
      for (let j = 0; j < COMPOUND_MAX_FANOUT; j++) {
        const leaf = `src/leaf${i}_${j}.ts`;
        leaves.push(leaf);
        imports[leaf] = [mids[i]!];
      }
    }
    const allFiles = ["src/core.ts", ...mids, ...leaves];
    const importFixture: ImportFixture = { imports, files: allFiles };
    const providers: ProviderSet = { imports: fixtureImportProvider(importFixture) };
    const result = runCompoundRetrieval({
      seed: { kind: "file", path: "src/core.ts" },
      providers,
      generations: fixtureView(allFiles),
    });
    if (!result.applied) throw new Error(`expected applied, got declined: ${result.reason}`);

    expect(result.truncation.truncated).toBe(true);
    expect(result.truncation.counts["max-nodes"]).toBeGreaterThan(0);
    // Total ADMITTED nodes (seed included) can never exceed COMPOUND_MAX_NODES —
    // the BoundTracker's own admitNode() invariant (bounds.ts), re-checked here
    // at this module's own bound values rather than trusting graph-evidence's
    // spec alone. One seed is always admitted, so discovered nodes <= budget-1.
    expect(result.nodes.length).toBeLessThanOrEqual(COMPOUND_MAX_NODES - 1);
    expect(result.partial).toBe(true);
  });
});
