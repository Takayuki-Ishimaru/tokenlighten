// coveragePackerV2.spec.ts — V11-03 Coverage Packer v2 unit contract.
//
// Everything here is pure: no fixtures, no server, no I/O. The integration
// behaviour behind TL_COVERAGE_PACKER_V2 (server-dispatch fixtures, byte
// comparisons against v1, and the change_contract second seam) lives in
// coveragePackerV2Integration.spec.ts.

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  packForCoverageV2,
  classifyConcern,
  poolConcernConfidence,
  inferDedupExemption,
  findDanglingReferences,
  selectCoverageOrderedEntriesV2,
  CONCERN_CATEGORIES,
  CONCERN_CONFIDENCE_FLOOR,
  DEFAULT_INVENTORY_QUOTA,
  type CoverageCandidateV2,
  type CoverageObligationV2,
  type CoveragePackerV2Input,
} from "../features/task-pack/coveragePackerV2.js";
import { packForCoverage } from "../features/task-pack/coveragePacker.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function candidate(over: Partial<CoverageCandidateV2> & { id: string }): CoverageCandidateV2 {
  return {
    path: `src/${over.id}.ts`,
    role: "domain",
    rank: 0,
    confidence: 0.5,
    bytes: 1000,
    ...over,
  };
}

function ids(output: ReturnType<typeof packForCoverageV2>): string[] {
  return output.body.map((s) => s.candidate.id);
}

// ---------------------------------------------------------------------------
// 1. Concern decomposition
// ---------------------------------------------------------------------------

describe("coveragePackerV2 — concern decomposition", () => {
  it("classifies all 8 concern categories from deterministic path/role/symbol signals", () => {
    expect(classifyConcern({ path: "src/foo.test.ts", role: "test" }).category).toBe("test");
    expect(classifyConcern({ path: "docs/readme.md", role: "doc" }).category).toBe("doc");
    expect(classifyConcern({ path: "Dockerfile", role: "unknown" }).category).toBe("build");
    expect(classifyConcern({ path: "tsconfig.json", role: "config" }).category).toBe("config");
    expect(classifyConcern({ path: "src/api/routes.ts", role: "api" }).category).toBe("public_api");
    expect(classifyConcern({ path: "src/index.ts", role: "domain" }).category).toBe("aggregation");
    expect(classifyConcern({ path: "src/validateInput.ts", role: "domain", symbol: "validateInput" }).category)
      .toBe("validation");
    expect(classifyConcern({ path: "src/lib/util.ts", role: "domain" }).category).toBe("implementation");
  });

  it("CONCERN_CATEGORIES lists exactly the 8 spec-named categories", () => {
    expect([...CONCERN_CATEGORIES].sort()).toEqual([
      "aggregation", "build", "config", "doc", "implementation", "public_api", "test", "validation",
    ]);
  });

  it("a single unambiguous signal scores full confidence", () => {
    expect(classifyConcern({ path: "src/foo.test.ts", role: "test" }).confidence).toBe(1);
  });

  it("no signal at all (unknown role, no path pattern) scores a flat low confidence, below the fallback floor", () => {
    const result = classifyConcern({ path: "misc/thing1", role: "unknown" });
    expect(result.category).toBe("implementation");
    expect(result.confidence).toBeLessThan(CONCERN_CONFIDENCE_FLOOR);
  });

  it("is deterministic: identical input, identical output", () => {
    const input = { path: "src/api/gateway.ts", role: "api", symbol: "Gateway" };
    expect(classifyConcern(input)).toEqual(classifyConcern({ ...input }));
  });

  it("poolConcernConfidence is the mean of per-candidate confidence, and vacuous (1) on an empty pool", () => {
    expect(poolConcernConfidence([])).toBe(1);
    const pool = [
      { path: "src/foo.test.ts", role: "test" },
      { path: "misc/thing1", role: "unknown" },
    ];
    const expected = (classifyConcern(pool[0]!).confidence + classifyConcern(pool[1]!).confidence) / 2;
    expect(poolConcernConfidence(pool)).toBeCloseTo(expected, 10);
  });
});

// ---------------------------------------------------------------------------
// 2. Low-confidence -> v1 fallback, byte-identical
// ---------------------------------------------------------------------------

describe("coveragePackerV2 — low-confidence fallback to v1", () => {
  const ambiguousPool: CoverageCandidateV2[] = [
    candidate({ id: "a", role: "unknown", path: "misc/thing1", rank: 0, confidence: 0.7 }),
    candidate({ id: "b", role: "unknown", path: "misc/thing2", rank: 1, confidence: 0.6 }),
    candidate({ id: "c", role: "unknown", path: "misc/thing3", rank: 2, confidence: 0.5 }),
  ];

  it("falls back when pool concern-classification confidence is below the floor", () => {
    expect(poolConcernConfidence(ambiguousPool)).toBeLessThan(CONCERN_CONFIDENCE_FLOOR);
    const out = packForCoverageV2({ candidates: ambiguousPool, byteBudget: 100_000 });
    expect(out.fallbackToV1).toBe(true);
    expect(out.fallbackReason).toBeDefined();
  });

  it("the fallback output is STRUCTURALLY IDENTICAL to calling v1 directly (byte-identical once serialized)", () => {
    const input: CoveragePackerV2Input = { candidates: ambiguousPool, byteBudget: 100_000, requiredRoles: ["unknown"] };
    const v2out = packForCoverageV2(input);
    const v1out = packForCoverage(input);
    expect(JSON.stringify(v2out.body)).toBe(JSON.stringify(v1out.body));
    expect(JSON.stringify(v2out.inventory)).toBe(JSON.stringify(v1out.inventory));
    expect(v2out.bytes).toBe(v1out.bytes);
    expect(v2out.stopReason).toBe(v1out.stopReason);
    expect(v2out.complete).toBe(v1out.complete);
    expect(v2out.coveredRoles).toEqual(v1out.coveredRoles);
  });

  it("forceV1Fallback forces the same fallback regardless of confidence", () => {
    const confidentPool = [candidate({ id: "a", role: "test", path: "src/a.test.ts" })];
    expect(poolConcernConfidence(confidentPool)).toBe(1);
    const out = packForCoverageV2({ candidates: confidentPool, byteBudget: 100_000, forceV1Fallback: true });
    expect(out.fallbackToV1).toBe(true);
    expect(out.fallbackReason).toBe("forced-v1-fallback");
  });

  it("a confident pool does NOT fall back", () => {
    const confidentPool = [
      candidate({ id: "a", role: "test", path: "src/a.test.ts" }),
      candidate({ id: "b", role: "config", path: "src/b.config.json" }),
    ];
    const out = packForCoverageV2({ candidates: confidentPool, byteBudget: 100_000 });
    expect(out.fallbackToV1).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Dedup exemption
// ---------------------------------------------------------------------------

describe("coveragePackerV2 — dedup exemption", () => {
  it("inferDedupExemption recognizes a platform-variant sibling pair", () => {
    const pool = [
      { id: "a", path: "src/net.windows.ts" },
      { id: "b", path: "src/net.darwin.ts" },
    ];
    expect(inferDedupExemption(pool[0]!, pool)).toBe("platform-variant");
    expect(inferDedupExemption(pool[1]!, pool)).toBe("platform-variant");
  });

  it("inferDedupExemption recognizes a conditional-build sibling pair", () => {
    const pool = [
      { id: "a", path: "src/codec.debug.ts" },
      { id: "b", path: "src/codec.release.ts" },
    ];
    expect(inferDedupExemption(pool[0]!, pool)).toBe("conditional-build");
  });

  it("inferDedupExemption recognizes an overload pair (same symbol, different path)", () => {
    const pool = [
      { id: "a", path: "src/a.ts", symbol: "compute" },
      { id: "b", path: "src/b.ts", symbol: "compute" },
    ];
    expect(inferDedupExemption(pool[0]!, pool)).toBe("overload");
  });

  it("a lone platform-suffixed file with NO sibling is not exempt (nothing to dedup against)", () => {
    const pool = [{ id: "a", path: "src/net.windows.ts" }];
    expect(inferDedupExemption(pool[0]!, pool)).toBeUndefined();
  });

  it("platform-variant siblings both survive when each independently completes a distinct query concern", () => {
    // Once `win` covers role "domain", `mac` (same role) offers no further
    // ROLE gain — but it still closes its OWN concern, which keeps the
    // greedy loop from saturating after just one pick, and dedup exemption
    // means it is not shed as a "redundant duplicate" while doing so.
    const win = candidate({ id: "win", role: "domain", path: "src/net.windows.ts", rank: 0, confidence: 0.6, bytes: 400, concernTokens: ["windows"] });
    const mac = candidate({ id: "mac", role: "domain", path: "src/net.darwin.ts", rank: 1, confidence: 0.58, bytes: 400, concernTokens: ["darwin"] });
    const concerns = [{ id: "c-win", tokens: ["windows"] }, { id: "c-mac", tokens: ["darwin"] }];
    const out = packForCoverageV2({ candidates: [win, mac], concerns, byteBudget: 100_000, bodyQuota: 6 });
    expect(ids(out).sort()).toEqual(["mac", "win"]);
    expect(out.uncoveredConcerns).toEqual([]);
  });

  it("a platform-variant duplicate is NOT charged the 'role already covered' redundancy penalty a non-exempt duplicate pays (control, measured on the recorded utility)", () => {
    const runWithMacAt = (macPath: string) => {
      const win = candidate({ id: "win", role: "domain", path: "src/net.windows.ts", rank: 0, confidence: 0.6, bytes: 400, concernTokens: ["windows"] });
      const mac = candidate({ id: "mac", role: "domain", path: macPath, rank: 1, confidence: 0.58, bytes: 400, concernTokens: ["darwin"] });
      const concerns = [{ id: "c-win", tokens: ["windows"] }, { id: "c-mac", tokens: ["darwin"] }];
      return packForCoverageV2({ candidates: [win, mac], concerns, byteBudget: 100_000, bodyQuota: 6 });
    };
    const exempt = runWithMacAt("src/net.darwin.ts"); // platform-variant of win
    const notExempt = runWithMacAt("src/other/mac.ts"); // unrelated path, otherwise identical
    const exemptMac = exempt.body.find((s) => s.candidate.id === "mac");
    const notExemptMac = notExempt.body.find((s) => s.candidate.id === "mac");
    expect(exemptMac).toBeDefined();
    expect(notExemptMac).toBeDefined();
    // Both still get selected (their OWN concern justifies it either way),
    // but the exempt one is not additionally docked the redundancy penalty
    // for sharing `win`'s already-covered role.
    expect(exemptMac!.utility).toBeGreaterThan(notExemptMac!.utility);
  });

  it("an obligation with minSites > 1 keeps granting call-site-pattern exemption until it is satisfied — required same-pattern sites survive together", () => {
    const site1 = candidate({ id: "site1", role: "domain", path: "src/callsites/a.ts", rank: 0, confidence: 0.6, bytes: 400, obligationIds: ["multi"] });
    const site2 = candidate({ id: "site2", role: "domain", path: "src/callsites/b.ts", rank: 1, confidence: 0.55, bytes: 400, obligationIds: ["multi"] });
    const site3 = candidate({ id: "site3", role: "domain", path: "src/callsites/c.ts", rank: 2, confidence: 0.5, bytes: 400, obligationIds: ["multi"] });
    const obligations: CoverageObligationV2[] = [{ id: "multi", open: true, required: true, minSites: 2 }];
    const out = packForCoverageV2({
      candidates: [site1, site2, site3],
      obligations,
      byteBudget: 100_000,
      bodyQuota: 6,
    });
    const selectedSitePaths = ids(out).filter((id) => id.startsWith("site"));
    expect(selectedSitePaths.length).toBeGreaterThanOrEqual(2);
    expect(out.unmetObligations).toEqual([]);
  });

  it("an explicit dedupExemption on the candidate wins over inference", () => {
    const lone = candidate({ id: "lone", role: "domain", path: "src/lone.ts", dedupExemption: "overload" });
    const out = packForCoverageV2({ candidates: [lone], byteBudget: 100_000 });
    expect(out.fallbackToV1).toBe(false);
    expect(ids(out)).toContain("lone");
  });
});

// ---------------------------------------------------------------------------
// 4. Body quota vs inventory quota split
// ---------------------------------------------------------------------------

describe("coveragePackerV2 — inventory quota independence", () => {
  it("body starvation (byteBudget 0) never drops the inventory listing", () => {
    const direct1 = candidate({ id: "d1", role: "domain", path: "src/direct1.ts", direct: true, bytes: 5000 });
    const direct2 = candidate({ id: "d2", role: "api", path: "src/direct2.ts", explicit: true, bytes: 5000 });
    const out = packForCoverageV2({ candidates: [direct1, direct2], byteBudget: 0, bodyQuota: 0 });
    // Shed-forbidden entries still bypass byteBudget/quota by construction
    // (same invariant as v1), so `body` is non-empty even at byteBudget 0 —
    // the INVENTORY guarantee this test pins is a STRONGER, independent one:
    // inventory lists them regardless of what body selection did or did not do.
    expect(out.inventory.map((c) => c.id).sort()).toEqual(["d1", "d2"]);
    expect(out.inventoryComplete).toBe(true);
  });

  it("the inventory LISTING is capped by its own quota, independent of bodyQuota — body-selection (shed-forbidden) still serves every direct candidate regardless", () => {
    const direct = Array.from({ length: 5 }, (_, i) =>
      candidate({ id: `dir${i}`, role: "domain", path: `src/dir${i}.ts`, direct: true, rank: i, bytes: 100 }));
    const out = packForCoverageV2({ candidates: direct, byteBudget: 100_000, bodyQuota: 100, inventoryQuota: 2 });
    expect(out.inventory).toHaveLength(2);
    expect(out.body).toHaveLength(5);
  });

  it("DEFAULT_INVENTORY_QUOTA is generous enough that ordinary pools are unaffected", () => {
    expect(DEFAULT_INVENTORY_QUOTA).toBeGreaterThanOrEqual(32);
  });

  it("a bodyRequired:false obligation is discharged by inventory alone, with zero body spend", () => {
    const named = candidate({ id: "named", role: "config", path: "src/config/app.json", direct: true, bytes: 9000 });
    const obligations: CoverageObligationV2[] = [
      { id: "identity-only", open: true, required: true, paths: ["src/config/app.json"], bodyRequired: false },
    ];
    const out = packForCoverageV2({ candidates: [named], obligations, byteBudget: 0, bodyQuota: 0 });
    expect(out.unmetObligations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5. Per-obligation evidence predicates
// ---------------------------------------------------------------------------

describe("coveragePackerV2 — per-obligation evidence predicates", () => {
  it("pathClass narrows obligation satisfaction beyond role/paths/id membership", () => {
    const wrongPath = candidate({ id: "wrong", role: "domain", path: "src/other/impl.ts", rank: 0, confidence: 0.9, bytes: 500 });
    const rightPath = candidate({ id: "right", role: "domain", path: "src/target/impl.ts", rank: 1, confidence: 0.5, bytes: 500 });
    const obligations: CoverageObligationV2[] = [
      { id: "narrow", open: true, required: true, roles: ["domain"], pathClass: /^src\/target\// },
    ];
    const out = packForCoverageV2({ candidates: [wrongPath, rightPath], obligations, byteBudget: 100_000, bodyQuota: 6 });
    expect(out.unmetObligations).toEqual([]);
    const rightSelection = out.body.find((s) => s.candidate.id === "right");
    expect(rightSelection?.newObligations).toContain("narrow");
    const wrongSelection = out.body.find((s) => s.candidate.id === "wrong");
    expect(wrongSelection?.newObligations ?? []).not.toContain("narrow");
  });

  it("a pathClass that matches nothing in the pool leaves the obligation genuinely unmet (never fabricated satisfied)", () => {
    const c = candidate({ id: "c", role: "domain", path: "src/elsewhere.ts" });
    const obligations: CoverageObligationV2[] = [
      { id: "unreachable", open: true, required: true, roles: ["domain"], pathClass: /^src\/nowhere\// },
    ];
    const out = packForCoverageV2({ candidates: [c], obligations, byteBudget: 100_000 });
    expect(out.unmetObligations).toEqual(["unreachable"]);
    expect(out.complete).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. Pairwise complementarity
// ---------------------------------------------------------------------------

describe("coveragePackerV2 — pairwise complementarity promotion", () => {
  it("promotes a low-solo-relevance candidate that shares topical vocabulary with an already-selected one, ahead of a higher-relevance but UNRELATED filler", () => {
    // `anchor` wins the ONE greedy slot outright (highest solo utility).
    // `filler` has higher solo relevance than `partner`, but no relationship
    // to `anchor`; `partner` shares `anchor`'s "billing" concern token and
    // still offers real residual role gain (its own role is not yet
    // covered) — the combination the complementarity pass exists to surface.
    const anchor = candidate({ id: "anchor", role: "contract", path: "src/anchor.ts", rank: 0, confidence: 0.95, bytes: 300, concernTokens: ["billing"] });
    const partner = candidate({ id: "partner", role: "domain", path: "src/partner.ts", rank: 5, confidence: 0.1, bytes: 300, concernTokens: ["billing"] });
    const filler = candidate({ id: "filler", role: "domain", path: "src/filler.ts", rank: 1, confidence: 0.4, bytes: 300 });
    const out = packForCoverageV2({
      candidates: [anchor, partner, filler],
      byteBudget: 100_000,
      bodyQuota: 1, // the greedy loop alone can only afford ONE pick (anchor)
    });
    expect(ids(out)).toEqual(["anchor", "partner"]);
    const promoted = out.body.find((s) => s.candidate.id === "partner");
    expect(promoted?.reason).toBe("complementarity");
    expect(out.complementarityPromotions.some((p) => p.a === "anchor" && p.b === "partner")).toBe(true);
  });

  it("complementarityCandidateCap bounds the pairwise scan (no promotion when the partner sits outside the cap)", () => {
    const anchor = candidate({ id: "anchor", role: "contract", path: "src/anchor.ts", rank: 0, confidence: 0.95, bytes: 300, obligationIds: ["o1"] });
    const farPartner = candidate({
      id: "farPartner", role: "domain", path: "src/far.ts", rank: 50, confidence: 0.05, bytes: 300, concernTokens: ["only"],
    });
    const obligations: CoverageObligationV2[] = [{ id: "o1", open: true, required: false }];
    const concerns = [{ id: "only-concern", tokens: ["only"] }];
    const out = packForCoverageV2({
      candidates: [anchor, farPartner],
      obligations,
      concerns,
      byteBudget: 100_000,
      bodyQuota: 1,
      complementarityCandidateCap: 0,
    });
    expect(ids(out)).not.toContain("farPartner");
  });
});

// ---------------------------------------------------------------------------
// 7. Saturation with named reasons
// ---------------------------------------------------------------------------

describe("coveragePackerV2 — role/obligation saturation", () => {
  it("stops spending once every required role/obligation is covered, with budget still on the table", () => {
    const a = candidate({ id: "a", role: "contract", path: "src/a.ts", rank: 0, confidence: 0.9, bytes: 500 });
    const b = candidate({ id: "b", role: "api", path: "src/b.ts", rank: 1, confidence: 0.8, bytes: 500 });
    // Same role as `a` (already covered once `a` is picked) and no
    // obligation/concern of its own — genuinely nothing left to gain from it.
    const filler = candidate({ id: "filler", role: "contract", path: "src/filler.ts", rank: 2, confidence: 0.3, bytes: 500 });
    const out = packForCoverageV2({
      candidates: [a, b, filler],
      requiredRoles: ["contract", "api"],
      byteBudget: 1_000_000,
      bodyQuota: 6,
    });
    expect(out.stopReason).toBe("saturated");
    expect(out.bytes).toBeLessThan(1_000_000);
    expect(ids(out).sort()).toEqual(["a", "b"]);
  });

  it("records WHY a role stopped taking bytes (saturation reasons)", () => {
    const a = candidate({ id: "a", role: "contract", path: "src/a.ts", rank: 0, confidence: 0.9, bytes: 500 });
    const out = packForCoverageV2({
      candidates: [a],
      requiredRoles: ["contract"],
      byteBudget: 1_000_000,
      bodyQuota: 6,
    });
    expect(out.saturationReasons["role:contract"]).toContain("a");
  });
});

// ---------------------------------------------------------------------------
// 8. Decision trace
// ---------------------------------------------------------------------------

describe("coveragePackerV2 — decision trace", () => {
  it("records one trace entry per candidate touched, with a stage and outcome", () => {
    const a = candidate({ id: "a", role: "contract", path: "src/a.ts", rank: 0, confidence: 0.9, bytes: 500 });
    const out = packForCoverageV2({ candidates: [a], byteBudget: 100_000, bodyQuota: 6 });
    expect(out.decisionTrace.length).toBeGreaterThan(0);
    for (const entry of out.decisionTrace) {
      expect(["shed-forbidden", "greedy", "complementarity", "required-role-sweep", "inventory", "fallback"])
        .toContain(entry.stage);
      expect(["kept", "dropped"]).toContain(entry.outcome);
      expect(entry.reason.length).toBeGreaterThan(0);
    }
  });

  it("a budget-exceeded drop is traced with outcome 'dropped'", () => {
    const a = candidate({ id: "a", role: "contract", path: "src/a.ts", rank: 0, confidence: 0.9, bytes: 50_000 });
    const out = packForCoverageV2({ candidates: [a], byteBudget: 10, bodyQuota: 6 });
    const dropped = out.decisionTrace.find((e) => e.candidateId === "a" && e.outcome === "dropped");
    expect(dropped).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 9. No dangling references (EvidenceIdentity/Use/Delivery framing)
// ---------------------------------------------------------------------------

describe("coveragePackerV2 — no dangling references in outputs", () => {
  it("every id the output mentions (body/inventory/trace/promotions/unmet lists) resolves to a real input entry", () => {
    const anchor = candidate({ id: "anchor", role: "contract", path: "src/anchor.ts", rank: 0, confidence: 0.95, bytes: 300, obligationIds: ["o1"] });
    const partner = candidate({ id: "partner", role: "domain", path: "src/partner.ts", rank: 5, confidence: 0.1, bytes: 300, concernTokens: ["c2token"] });
    const unmetTarget = candidate({ id: "unmet", role: "ui", path: "src/unmet.ts", rank: 2, confidence: 0.05, bytes: 500 });
    const input: CoveragePackerV2Input = {
      candidates: [anchor, partner, unmetTarget],
      obligations: [{ id: "o1", open: true, required: false }, { id: "o2", open: true, required: true, roles: ["nonexistent-role"] }],
      concerns: [{ id: "c2", tokens: ["c2token"] }],
      requiredRoles: ["contract", "api"],
      byteBudget: 100_000,
      bodyQuota: 1,
    };
    const out = packForCoverageV2(input);
    expect(findDanglingReferences(out, input)).toEqual([]);
  });

  it("the low-confidence fallback output also carries no dangling references", () => {
    const input: CoveragePackerV2Input = {
      candidates: [
        candidate({ id: "a", role: "unknown", path: "misc/thing1" }),
        candidate({ id: "b", role: "unknown", path: "misc/thing2" }),
      ],
      byteBudget: 100_000,
    };
    const out = packForCoverageV2(input);
    expect(out.fallbackToV1).toBe(true);
    expect(findDanglingReferences(out, input)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 10. Determinism
// ---------------------------------------------------------------------------

describe("coveragePackerV2 — determinism", () => {
  it("identical input produces byte-identical output", () => {
    const input: CoveragePackerV2Input = {
      candidates: [
        candidate({ id: "a", role: "contract", path: "src/a.ts", rank: 0, confidence: 0.9, bytes: 500, symbol: "A" }),
        candidate({ id: "b", role: "api", path: "src/b.ts", rank: 1, confidence: 0.8, bytes: 500, symbol: "B" }),
        candidate({ id: "c", role: "domain", path: "src/c.ts", rank: 2, confidence: 0.5, bytes: 500 }),
      ],
      requiredRoles: ["contract", "api"],
      byteBudget: 100_000,
      bodyQuota: 6,
    };
    const first = JSON.stringify(packForCoverageV2(input));
    const second = JSON.stringify(packForCoverageV2({ ...input, candidates: [...input.candidates] }));
    expect(first).toBe(second);
  });
});

// ---------------------------------------------------------------------------
// 11. Never manufactures a false complete (PI-02 adjacency)
// ---------------------------------------------------------------------------

describe("coveragePackerV2 — never manufactures a false complete", () => {
  it("complete is false while a required role has no candidate at all", () => {
    const a = candidate({ id: "a", role: "contract", path: "src/a.ts" });
    const out = packForCoverageV2({ candidates: [a], requiredRoles: ["contract", "ui"], byteBudget: 100_000 });
    expect(out.complete).toBe(false);
    expect(out.missingRequiredRoles).toEqual(["ui"]);
  });

  it("complete is true only when roles, obligations, concerns, and inventory are ALL satisfied", () => {
    const a = candidate({ id: "a", role: "contract", path: "src/a.ts", direct: true, bytes: 300, obligationIds: ["o1"], concernTokens: ["k1"] });
    const out = packForCoverageV2({
      candidates: [a],
      requiredRoles: ["contract"],
      obligations: [{ id: "o1", open: true, required: true }],
      concerns: [{ id: "c1", tokens: ["k1"] }],
      byteBudget: 100_000,
    });
    expect(out.complete).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 12. Bridge (selectCoverageOrderedEntriesV2)
// ---------------------------------------------------------------------------

describe("coveragePackerV2 — selectCoverageOrderedEntriesV2", () => {
  interface Detail { path: string; role: string; confidence: number; bytes: number; symbol?: string }

  it("projects pool details onto candidates and returns [role, detail] pairs in serve order", () => {
    const pool: Detail[] = [
      { path: "src/a.ts", role: "contract", confidence: 0.9, bytes: 300, symbol: "A" },
      { path: "src/b.ts", role: "api", confidence: 0.8, bytes: 300 },
    ];
    const { entries, output } = selectCoverageOrderedEntriesV2(pool, {
      path: (d) => d.path,
      role: (d) => d.role,
      confidence: (d) => d.confidence,
      bytes: (d) => d.bytes,
      symbol: (d) => d.symbol,
    }, { requiredRoles: ["contract", "api"], byteBudget: 100_000 });
    expect(entries.map(([role]) => role).sort()).toEqual(["api", "contract"]);
    expect(output.fallbackToV1).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 13. Advisory-posture-adjacent fence (structural)
//
// v2 is a SIBLING module, not v1 itself — it does import v1 (the documented
// fallback target), which is expected. What it must NEVER do is import the
// advisory reasoning IR, directly or transitively (reconciliation §1, E-7).
// ---------------------------------------------------------------------------

describe("coveragePackerV2 — advisory posture (no reasoning-IR path)", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "features", "task-pack", "coveragePackerV2.ts"),
    "utf8",
  );
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

  it("does not reference the advisory reasoning IR, or anything under task-state/, in code", () => {
    expect(code.includes("reasoningIr")).toBe(false);
    expect(code.includes("projectTaskReasoningIR")).toBe(false);
    expect(code.includes("task-state")).toBe(false);
  });

  it("imports only its documented v1 sibling — no other production module", () => {
    const imports = [...new Set([...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]))];
    expect(imports).toEqual(["./coveragePacker.js"]);
  });
});
