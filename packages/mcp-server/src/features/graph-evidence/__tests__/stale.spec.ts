// ---------------------------------------------------------------------------
// stale.spec.ts — V11-01 acceptance: "stale edge 0 件".
//
// The invariant is about what SURVIVES: `filterStaleEdges().fresh` must never
// contain an edge that cannot re-prove both its generation and its source
// digest — and every exclusion must be counted under a reason that says
// whether the index moved, the file moved, or the check was impossible.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";

import { fileNode, symbolNode, type GraphEdge } from "../model.js";
import {
  EMPTY_STALE_REPORT,
  filterStaleEdges,
  isFreshEdge,
  makeGenerationView,
  mergeStaleReports,
  MAX_STALE_SAMPLES,
  staleReasonFor,
  STALE_REASONS,
  type GenerationView,
} from "../stale.js";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const PROVIDER = "tl-graph:references";
const GENERATION = "tl-graph:root-1";
const SHA_A = "sha256:aaa";
const SHA_B = "sha256:bbb";

function edge(overrides: Partial<GraphEdge> = {}): GraphEdge {
  return {
    type: "REFERENCES",
    from: fileNode("src/consumer.ts", "reference-index"),
    to: symbolNode("src/registry.ts", "Registry", "reference-index"),
    evidenceClass: "direct",
    provider: PROVIDER,
    providerKind: "reference-index",
    sourceSha: SHA_A,
    sourceShaPath: "src/consumer.ts",
    indexGeneration: GENERATION,
    coverage: "complete",
    rule: "reference-index-mention",
    corroboration: ["exact-symbol-match"],
    ...overrides,
  };
}

const CURRENT: GenerationView = makeGenerationView(
  [[PROVIDER, GENERATION]],
  [
    ["src/consumer.ts", SHA_A],
    ["src/registry.ts", SHA_B],
  ],
);

// ---------------------------------------------------------------------------
// 1. The invariant
// ---------------------------------------------------------------------------

describe("stale edge 0", () => {
  it("a fresh edge survives and is counted nowhere", () => {
    const result = filterStaleEdges([edge()], CURRENT);
    expect(result.fresh).toHaveLength(1);
    expect(result.report).toEqual(EMPTY_STALE_REPORT);
  });

  it("whatever the mix, NOTHING stale survives the filter", () => {
    const edges = [
      edge(),
      edge({ indexGeneration: "tl-graph:root-2" }),
      edge({ sourceSha: "sha256:moved" }),
      edge({ provider: "unknown:provider" }),
      edge({ sourceShaPath: "src/vanished.ts" }),
      edge({ indexGeneration: "" }),
      edge({ sourceSha: "" }),
      edge({ sourceShaPath: "" }),
    ];
    const result = filterStaleEdges(edges, CURRENT);

    expect(result.fresh).toHaveLength(1);
    for (const survivor of result.fresh) {
      expect(isFreshEdge(survivor, CURRENT)).toBe(true);
      expect(staleReasonFor(survivor, CURRENT)).toBeUndefined();
    }
    expect(result.report.excluded).toBe(edges.length - 1);
  });
});

// ---------------------------------------------------------------------------
// 2. Reasons are distinguished
// ---------------------------------------------------------------------------

describe("exclusion reasons", () => {
  it("a moved index is a generation mismatch", () => {
    expect(staleReasonFor(edge({ indexGeneration: "tl-graph:root-2" }), CURRENT)).toBe(
      "generation-mismatch",
    );
  });

  it("a moved file is a source-sha mismatch", () => {
    expect(staleReasonFor(edge({ sourceSha: "sha256:moved" }), CURRENT)).toBe(
      "source-sha-mismatch",
    );
  });

  it("FAIL-CLOSED: a provider the view cannot place is excluded, not trusted", () => {
    expect(staleReasonFor(edge({ provider: "unknown:provider" }), CURRENT)).toBe(
      "generation-unknown",
    );
  });

  it("FAIL-CLOSED: a path the view cannot digest is excluded, not trusted", () => {
    expect(staleReasonFor(edge({ sourceShaPath: "src/vanished.ts" }), CURRENT)).toBe(
      "source-sha-unknown",
    );
  });

  it("an unstamped edge is reported as unstamped, not as a mismatch", () => {
    for (const missing of [{ indexGeneration: "" }, { sourceSha: "" }, { sourceShaPath: "" }]) {
      expect(staleReasonFor(edge(missing), CURRENT)).toBe("edge-unstamped");
    }
  });

  it("counts every reason it used, and zeroes the ones it did not", () => {
    const result = filterStaleEdges(
      [
        edge({ indexGeneration: "tl-graph:root-2" }),
        edge({ indexGeneration: "tl-graph:root-3" }),
        edge({ sourceSha: "sha256:moved" }),
      ],
      CURRENT,
    );
    expect(result.report.counts["generation-mismatch"]).toBe(2);
    expect(result.report.counts["source-sha-mismatch"]).toBe(1);
    expect(result.report.counts["generation-unknown"]).toBe(0);
    expect(result.report.counts["source-sha-unknown"]).toBe(0);
    expect(result.report.counts["edge-unstamped"]).toBe(0);
    expect(STALE_REASONS.length).toBe(Object.keys(result.report.counts).length);
  });

  it("samples carry what was expected against what was found", () => {
    const result = filterStaleEdges([edge({ indexGeneration: "tl-graph:root-2" })], CURRENT);
    expect(result.report.samples[0]).toMatchObject({
      reason: "generation-mismatch",
      expected: GENERATION,
      found: "tl-graph:root-2",
    });
  });
});

// ---------------------------------------------------------------------------
// 3. The sample list is bounded
// ---------------------------------------------------------------------------

describe("sample bounds", () => {
  it("caps samples and says it did, while counts stay exact", () => {
    const edges = Array.from({ length: MAX_STALE_SAMPLES + 5 }, (_unused, i) =>
      edge({ indexGeneration: `tl-graph:root-${i + 2}` }),
    );
    const result = filterStaleEdges(edges, CURRENT);
    expect(result.report.samples).toHaveLength(MAX_STALE_SAMPLES);
    expect(result.report.samplesTruncated).toBe(true);
    expect(result.report.excluded).toBe(MAX_STALE_SAMPLES + 5);
  });

  it("honours an explicit smaller sample cap", () => {
    const result = filterStaleEdges(
      [edge({ sourceSha: "x" }), edge({ sourceSha: "y" })],
      CURRENT,
      { maxSamples: 1 },
    );
    expect(result.report.samples).toHaveLength(1);
    expect(result.report.samplesTruncated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Merging across expansion steps
// ---------------------------------------------------------------------------

describe("mergeStaleReports", () => {
  it("sums counts and totals across steps", () => {
    const a = filterStaleEdges([edge({ indexGeneration: "x" })], CURRENT).report;
    const b = filterStaleEdges([edge({ sourceSha: "y" }), edge({ sourceSha: "z" })], CURRENT).report;
    const merged = mergeStaleReports(a, b);
    expect(merged.excluded).toBe(3);
    expect(merged.counts["generation-mismatch"]).toBe(1);
    expect(merged.counts["source-sha-mismatch"]).toBe(2);
    expect(merged.samples).toHaveLength(3);
  });

  it("merging with the empty report is the identity", () => {
    const one = filterStaleEdges([edge({ sourceSha: "y" })], CURRENT).report;
    expect(mergeStaleReports(EMPTY_STALE_REPORT, one)).toEqual(one);
  });

  it("keeps the merged sample list bounded", () => {
    const many = filterStaleEdges(
      Array.from({ length: MAX_STALE_SAMPLES }, (_unused, i) => edge({ sourceSha: `s-${i}` })),
      CURRENT,
    ).report;
    const merged = mergeStaleReports(many, many);
    expect(merged.samples).toHaveLength(MAX_STALE_SAMPLES);
    expect(merged.samplesTruncated).toBe(true);
    expect(merged.excluded).toBe(MAX_STALE_SAMPLES * 2);
  });
});
