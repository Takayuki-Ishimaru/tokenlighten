// coveragePacker.spec.ts — V10-09 obligation-aware coverage-per-token packer.
//
// Unit contract for `features/task-pack/coveragePacker.ts`. Everything here is
// pure: no fixtures, no server, no I/O. The integration behaviour behind
// TL_COVERAGE_PACKER lives in `coveragePackerIntegration.spec.ts`.

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  packForCoverage,
  candidateUtility,
  emptyCoverageState,
  selectContextLevel,
  selectCoverageOrderedEntries,
  estimateBodyBytes,
  type CoverageCandidate,
  type CoveragePackerInput,
} from "../features/task-pack/coveragePacker.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function candidate(over: Partial<CoverageCandidate> & { id: string }): CoverageCandidate {
  return {
    path: `src/${over.id}.ts`,
    role: "domain",
    rank: 0,
    confidence: 0.5,
    bytes: 1000,
    ...over,
  };
}

/** A four-role pool with a duplicate `domain` candidate, which is the shape the per-role cap over-serves. */
function multiRolePool(): CoverageCandidate[] {
  return [
    candidate({ id: "a", role: "contract", rank: 0, confidence: 0.9, bytes: 1000 }),
    candidate({ id: "b", role: "api", rank: 1, confidence: 0.85, bytes: 1000 }),
    candidate({ id: "c", role: "domain", rank: 2, confidence: 0.8, bytes: 1000 }),
    candidate({ id: "d", role: "domain", rank: 3, confidence: 0.79, bytes: 1000 }),
    candidate({ id: "e", role: "test", rank: 4, confidence: 0.6, bytes: 1000 }),
  ];
}

function ids(output: ReturnType<typeof packForCoverage>): string[] {
  return output.body.map((s) => s.candidate.id);
}

// ---------------------------------------------------------------------------
// 1. Utility ordering
// ---------------------------------------------------------------------------

describe("coveragePacker — utility ordering", () => {
  const base: Omit<CoveragePackerInput, "candidates"> = { byteBudget: 100_000 };

  it("an obligation-covering candidate outranks a merely more relevant one", () => {
    const covers = candidate({ id: "covers", role: "config", confidence: 0.4, path: "src/pinned.ts" });
    const relevant = candidate({ id: "relevant", role: "config", confidence: 1 });
    const input: CoveragePackerInput = {
      ...base,
      candidates: [covers, relevant],
      obligations: [{ id: "o1", open: true, paths: ["src/pinned.ts"] }],
    };
    const state = emptyCoverageState();
    expect(candidateUtility(covers, input, state))
      .toBeGreaterThan(candidateUtility(relevant, input, state));
  });

  it("a new role outranks an equally relevant already-covered role", () => {
    const input: CoveragePackerInput = { ...base, candidates: multiRolePool() };
    const state = emptyCoverageState();
    state.coveredRoles.add("domain");
    const fresh = candidate({ id: "fresh", role: "api", confidence: 0.8 });
    const dup = candidate({ id: "dup", role: "domain", confidence: 0.8 });
    expect(candidateUtility(fresh, input, state)).toBeGreaterThan(candidateUtility(dup, input, state));
  });

  it("bytes are a cost: the cheaper of two identical candidates wins", () => {
    const cheap = candidate({ id: "cheap", bytes: 500 });
    const dear = candidate({ id: "dear", bytes: 50_000, path: "src/dear.ts" });
    const input: CoveragePackerInput = { ...base, byteBudget: 100_000, candidates: [cheap, dear] };
    const state = emptyCoverageState();
    expect(candidateUtility(cheap, input, state)).toBeGreaterThan(candidateUtility(dear, input, state));
  });

  it("edit-frontier membership and verification value both add, never subtract", () => {
    const plain = candidate({ id: "plain" });
    const frontier = candidate({ id: "frontier", path: "src/frontier.ts", editFrontier: true });
    const verifying = candidate({ id: "verifying", path: "src/verifying.ts", verificationValue: 1 });
    const input: CoveragePackerInput = { ...base, candidates: [plain, frontier, verifying] };
    const state = emptyCoverageState();
    const plainUtility = candidateUtility(plain, input, state);
    expect(candidateUtility(frontier, input, state)).toBeGreaterThan(plainUtility);
    expect(candidateUtility(verifying, input, state)).toBeGreaterThan(plainUtility);
  });

  it("content the ledger says is already held is penalised", () => {
    const held = candidate({ id: "held", priorServed: true });
    const unheld = candidate({ id: "unheld", path: "src/unheld.ts" });
    const input: CoveragePackerInput = { ...base, candidates: [held, unheld] };
    const state = emptyCoverageState();
    state.coveredRoles.add("domain");
    expect(candidateUtility(held, input, state)).toBeLessThan(candidateUtility(unheld, input, state));
  });

  it("the greedy loop follows that ordering: highest marginal utility first", () => {
    const output = packForCoverage({
      ...base,
      candidates: multiRolePool(),
      bodyQuota: 6,
    });
    // contract (highest confidence, new role) leads; the duplicate `domain`
    // candidate `d` never enters, because by then its role adds nothing.
    expect(ids(output)[0]).toBe("a");
    expect(ids(output)).not.toContain("d");
  });
});

// ---------------------------------------------------------------------------
// 2. Saturation early-stop
// ---------------------------------------------------------------------------

describe("coveragePacker — saturation early-stop", () => {
  it("stops once coverage closes, with budget still on the table", () => {
    const output = packForCoverage({
      candidates: multiRolePool(),
      byteBudget: 1_000_000,
      bodyQuota: 6,
    });
    expect(output.stopReason).toBe("saturated");
    expect(output.bytes).toBeLessThan(1_000_000);
    // Four distinct roles, four surfaces: the duplicate is shed.
    expect(output.body).toHaveLength(4);
    expect(output.coveredRoles).toEqual(["api", "contract", "domain", "test"]);
  });

  it("filling the budget is not a goal: a huge budget does not enlarge the pack", () => {
    const small = packForCoverage({ candidates: multiRolePool(), byteBudget: 10_000, bodyQuota: 6 });
    const huge = packForCoverage({ candidates: multiRolePool(), byteBudget: 10_000_000, bodyQuota: 6 });
    expect(ids(huge)).toEqual(ids(small));
  });

  it("does not stop early while a required role is still missing", () => {
    const output = packForCoverage({
      candidates: multiRolePool(),
      requiredRoles: ["test"],
      byteBudget: 1_000_000,
      bodyQuota: 6,
    });
    expect(output.coveredRoles).toContain("test");
    expect(output.missingRequiredRoles).toEqual([]);
  });

  it("stops on the byte budget when coverage has not closed", () => {
    const output = packForCoverage({
      candidates: multiRolePool(),
      byteBudget: 2_500,
      bodyQuota: 6,
    });
    expect(output.stopReason).toBe("budget");
    expect(output.body.length).toBeLessThan(4);
  });

  it("stops on the body quota when the quota bites before coverage closes", () => {
    const output = packForCoverage({
      candidates: multiRolePool(),
      byteBudget: 1_000_000,
      bodyQuota: 2,
    });
    expect(output.stopReason).toBe("quota");
    expect(output.body).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 3. Inventory vs. body split
// ---------------------------------------------------------------------------

describe("coveragePacker — direct inventory vs. body quota", () => {
  it("the inventory is the complete direct-reference set, and the body is the representative subset", () => {
    const pool: CoverageCandidate[] = [
      candidate({ id: "direct1", role: "domain", rank: 0, direct: true, path: "src/direct1.ts" }),
      candidate({ id: "direct2", role: "domain", rank: 1, direct: true, path: "src/direct2.ts" }),
      candidate({ id: "extra1", role: "domain", rank: 2, path: "src/extra1.ts" }),
      candidate({ id: "extra2", role: "domain", rank: 3, path: "src/extra2.ts" }),
    ];
    const output = packForCoverage({ candidates: pool, byteBudget: 100_000, bodyQuota: 1 });
    expect(output.inventory.map((c) => c.id)).toEqual(["direct1", "direct2"]);
    // Both direct references are served even though the body quota is 1: they
    // are shed-forbidden, and the quota only bounds representative picks.
    expect(ids(output)).toEqual(["direct1", "direct2"]);
    expect(output.inventoryComplete).toBe(true);
  });

  it("the inventory survives a budget that cannot fund it", () => {
    const pool: CoverageCandidate[] = [
      candidate({ id: "direct1", direct: true, bytes: 40_000, path: "src/direct1.ts" }),
      candidate({ id: "direct2", direct: true, bytes: 40_000, path: "src/direct2.ts", rank: 1 }),
    ];
    const output = packForCoverage({ candidates: pool, byteBudget: 1_000 });
    expect(output.inventory).toHaveLength(2);
    expect(ids(output)).toEqual(["direct1", "direct2"]);
    expect(output.inventoryComplete).toBe(true);
    expect(output.bytes).toBeGreaterThan(1_000);
  });

  it("an open obligation's explicit location joins the inventory even without a direct flag", () => {
    const pool = [
      candidate({ id: "pinned", path: "src/pinned.ts", rank: 1 }),
      candidate({ id: "other", path: "src/other.ts", rank: 0 }),
    ];
    const output = packForCoverage({
      candidates: pool,
      obligations: [{ id: "o1", open: true, paths: ["src/pinned.ts"] }],
      byteBudget: 100_000,
    });
    expect(output.inventory.map((c) => c.id)).toEqual(["pinned"]);
  });

  it("a discharged obligation pins nothing", () => {
    const pool = [candidate({ id: "pinned", path: "src/pinned.ts" })];
    const output = packForCoverage({
      candidates: pool,
      obligations: [{ id: "o1", open: false, paths: ["src/pinned.ts"] }],
      byteBudget: 100_000,
    });
    expect(output.inventory).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. Required-role diversity exemption
// ---------------------------------------------------------------------------

describe("coveragePacker — required roles and locations are exempt from the diversity penalty", () => {
  it("a second candidate in a REQUIRED role pays no redundancy penalty", () => {
    const dup = candidate({ id: "dup", role: "domain", path: "src/dup.ts" });
    const state = emptyCoverageState();
    state.coveredRoles.add("domain");

    const exempt = candidateUtility(dup, {
      candidates: [dup],
      requiredRoles: ["domain"],
      byteBudget: 100_000,
    }, state);
    const penalised = candidateUtility(dup, {
      candidates: [dup],
      byteBudget: 100_000,
    }, state);
    expect(exempt).toBeGreaterThan(penalised);
  });

  it("a required location is exempt the same way", () => {
    const pinned = candidate({ id: "pinned", role: "domain", path: "src/pinned.ts" });
    const state = emptyCoverageState();
    state.coveredRoles.add("domain");
    const exempt = candidateUtility(pinned, {
      candidates: [pinned],
      requiredPaths: ["src/pinned.ts"],
      byteBudget: 100_000,
    }, state);
    const penalised = candidateUtility(pinned, { candidates: [pinned], byteBudget: 100_000 }, state);
    expect(exempt).toBeGreaterThan(penalised);
  });

  it("a required role that the greedy loop missed is swept in past the body quota", () => {
    const pool: CoverageCandidate[] = [
      candidate({ id: "a", role: "contract", rank: 0, confidence: 0.95 }),
      candidate({ id: "b", role: "api", rank: 1, confidence: 0.9, path: "src/b.ts" }),
      candidate({ id: "z", role: "style", rank: 9, confidence: 0.1, path: "src/z.ts" }),
    ];
    const output = packForCoverage({
      candidates: pool,
      requiredRoles: ["style"],
      byteBudget: 100_000,
      bodyQuota: 1,
    });
    expect(output.stopReason).toBe("quota");
    expect(ids(output)).toContain("z");
    expect(output.missingRequiredRoles).toEqual([]);
  });

  it("one surface per path survives the exemption", () => {
    const pool: CoverageCandidate[] = [
      candidate({ id: "one", role: "domain", path: "src/same.ts", rank: 0 }),
      candidate({ id: "two", role: "domain", path: "src/same.ts", rank: 1 }),
    ];
    const output = packForCoverage({
      candidates: pool,
      requiredRoles: ["domain"],
      byteBudget: 100_000,
    });
    expect(ids(output)).toEqual(["one"]);
  });
});

// ---------------------------------------------------------------------------
// 5. Shed-forbidden preservation
// ---------------------------------------------------------------------------

describe("coveragePacker — shed-forbidden surfaces are never dropped", () => {
  const forbidden: CoverageCandidate[] = [
    candidate({ id: "direct", direct: true, path: "src/direct.ts", rank: 5, confidence: 0.05, bytes: 30_000 }),
    candidate({ id: "explicit", explicit: true, path: "src/explicit.ts", rank: 6, confidence: 0.05, bytes: 30_000 }),
    candidate({ id: "obliged", path: "src/obliged.ts", rank: 7, confidence: 0.05, bytes: 30_000 }),
  ];

  it("survives a quota of zero, a starved budget, and a hostile utility", () => {
    const output = packForCoverage({
      candidates: [...forbidden, candidate({ id: "cheap", confidence: 1, bytes: 10, path: "src/cheap.ts" })],
      obligations: [{ id: "o1", open: true, paths: ["src/obliged.ts"] }],
      byteBudget: 1,
      bodyQuota: 0,
    });
    expect(ids(output)).toEqual(expect.arrayContaining(["direct", "explicit", "obliged"]));
    expect(ids(output)).not.toContain("cheap");
  });

  it("leads the served order, so a downstream surface cap trims representatives first", () => {
    const output = packForCoverage({
      candidates: [
        candidate({ id: "cheap", role: "api", confidence: 1, bytes: 10, rank: 0, path: "src/cheap.ts" }),
        ...forbidden,
      ],
      obligations: [{ id: "o1", open: true, paths: ["src/obliged.ts"] }],
      byteBudget: 1_000_000,
      bodyQuota: 6,
    });
    // All three lead, ahead of the cheap high-relevance representative. Their
    // order among themselves is utility-driven, so the obligation-covering one
    // comes first — assert the SET, not an incidental permutation.
    expect([...ids(output).slice(0, 3)].sort()).toEqual(["direct", "explicit", "obliged"]);
    expect(output.body.slice(0, 3).every((s) => s.reason === "shed-forbidden")).toBe(true);
    expect(ids(output)[3]).toBe("cheap");
  });
});

// ---------------------------------------------------------------------------
// 6. Honesty — no false complete
// ---------------------------------------------------------------------------

describe("coveragePacker — never manufactures a false complete", () => {
  it("an unreachable required role keeps the verdict partial", () => {
    const output = packForCoverage({
      candidates: multiRolePool(),
      requiredRoles: ["ui"],
      byteBudget: 1_000_000,
    });
    expect(output.missingRequiredRoles).toEqual(["ui"]);
    expect(output.complete).toBe(false);
  });

  it("an unmet open obligation keeps the verdict partial", () => {
    const output = packForCoverage({
      candidates: multiRolePool(),
      obligations: [{ id: "o-missing", open: true, required: true, paths: ["src/nowhere.ts"] }],
      byteBudget: 1_000_000,
    });
    expect(output.unmetObligations).toEqual(["o-missing"]);
    expect(output.complete).toBe(false);
  });

  it("an uncovered concern keeps the verdict partial", () => {
    const output = packForCoverage({
      candidates: multiRolePool(),
      concerns: [{ id: "c1", tokens: ["nowhere"] }],
      byteBudget: 1_000_000,
    });
    expect(output.uncoveredConcerns).toEqual(["c1"]);
    expect(output.complete).toBe(false);
  });

  it("complete only when every required role, obligation, and concern is met", () => {
    const output = packForCoverage({
      candidates: [
        candidate({ id: "a", role: "contract", rank: 0, concernTokens: ["alpha"] }),
        candidate({ id: "b", role: "test", rank: 1, path: "src/pinned.ts", concernTokens: ["beta"] }),
      ],
      requiredRoles: ["contract", "test"],
      obligations: [{ id: "o1", open: true, paths: ["src/pinned.ts"] }],
      concerns: [{ id: "c1", tokens: ["alpha"] }, { id: "c2", tokens: ["BETA"] }],
      byteBudget: 1_000_000,
    });
    expect(output.complete).toBe(true);
    expect(output.missingRequiredRoles).toEqual([]);
    expect(output.unmetObligations).toEqual([]);
    expect(output.uncoveredConcerns).toEqual([]);
  });

  it("an optional (required:false) obligation cannot fail the pack", () => {
    const output = packForCoverage({
      candidates: multiRolePool(),
      obligations: [{ id: "o-optional", open: true, required: false, paths: ["src/nowhere.ts"] }],
      byteBudget: 1_000_000,
    });
    expect(output.unmetObligations).toEqual([]);
    expect(output.complete).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. Determinism
// ---------------------------------------------------------------------------

describe("coveragePacker — determinism", () => {
  const input: CoveragePackerInput = {
    candidates: multiRolePool(),
    requiredRoles: ["contract", "domain"],
    obligations: [{ id: "o1", open: true, roles: ["api"] }],
    concerns: [{ id: "c1", tokens: ["alpha"] }],
    byteBudget: 50_000,
  };

  it("identical input produces byte-identical output, repeatedly", () => {
    const runs = Array.from({ length: 5 }, () => JSON.stringify(packForCoverage(input)));
    expect(new Set(runs).size).toBe(1);
  });

  it("exact utility ties fall through to (rank, id), not to input order", () => {
    const tied: CoverageCandidate[] = [
      candidate({ id: "zzz", role: "domain", rank: 1, confidence: 0.5, bytes: 100, path: "src/zzz.ts" }),
      candidate({ id: "aaa", role: "domain", rank: 1, confidence: 0.5, bytes: 100, path: "src/aaa.ts" }),
    ];
    const forward = packForCoverage({ candidates: tied, byteBudget: 10_000 });
    const reversed = packForCoverage({ candidates: [...tied].reverse(), byteBudget: 10_000 });
    expect(ids(forward)).toEqual(["aaa"]);
    expect(ids(reversed)).toEqual(["aaa"]);
  });

  it("reported sets are sorted, not insertion-ordered", () => {
    const output = packForCoverage({
      candidates: [
        candidate({ id: "t", role: "test", rank: 0 }),
        candidate({ id: "c", role: "contract", rank: 1, path: "src/c.ts" }),
      ],
      byteBudget: 100_000,
    });
    expect(output.coveredRoles).toEqual(["contract", "test"]);
  });
});

// ---------------------------------------------------------------------------
// 8. Context level (internal — never a wire field)
// ---------------------------------------------------------------------------

describe("coveragePacker — internal context level", () => {
  it("L0 when the ledger already holds every candidate", () => {
    const pool = multiRolePool().map((c) => ({ ...c, priorServed: true }));
    expect(selectContextLevel({ candidates: pool, byteBudget: 100_000 })).toBe("L0");
  });

  it("L0 when the budget cannot fund a single body", () => {
    expect(selectContextLevel({ candidates: multiRolePool(), byteBudget: 64 })).toBe("L0");
  });

  it("L1 for a confident read-only answer with nothing owed", () => {
    expect(selectContextLevel({
      candidates: multiRolePool(),
      byteBudget: 100_000,
      profile: "answer",
    })).toBe("L1");
  });

  it("L2 once there is a write frontier", () => {
    expect(selectContextLevel({
      candidates: multiRolePool(),
      byteBudget: 100_000,
      hasWriteFrontier: true,
    })).toBe("L2");
  });

  it("L3 for a multi-obligation change with budget to spare", () => {
    expect(selectContextLevel({
      candidates: multiRolePool(),
      byteBudget: 100_000,
      hasWriteFrontier: true,
      obligations: [{ id: "o1", open: true }, { id: "o2", open: true }],
    })).toBe("L3");
  });

  it("an explicit level overrides the ladder", () => {
    expect(selectContextLevel({ candidates: [], byteBudget: 1, level: "L3" })).toBe("L3");
  });

  it("L0 funds no body at all unless something is shed-forbidden", () => {
    const pool = multiRolePool().map((c) => ({ ...c, priorServed: true }));
    const output = packForCoverage({ candidates: pool, byteBudget: 100_000 });
    expect(output.level).toBe("L0");
    expect(output.body).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 9. Byte estimator
// ---------------------------------------------------------------------------

describe("coveragePacker — estimateBodyBytes", () => {
  const content = ["one", "two", "three", "four", "five"].join("\n");

  it("measures exactly the requested line window", () => {
    expect(estimateBodyBytes("2-3", content, 10_000)).toBe(Buffer.byteLength("two\nthree", "utf8"));
  });

  it("clamps an over-long window to the file", () => {
    expect(estimateBodyBytes("1-999", content, 10_000)).toBe(Buffer.byteLength(content, "utf8"));
  });

  it("honours the cap", () => {
    expect(estimateBodyBytes("1-999", content, 4)).toBe(4);
  });

  it("charges an unreadable source the full cap rather than nothing", () => {
    expect(estimateBodyBytes("1-2", undefined, 777)).toBe(777);
  });

  it("falls back to the whole file when the range is unparseable", () => {
    expect(estimateBodyBytes("not-a-range", content, 10_000)).toBe(Buffer.byteLength(content, "utf8"));
  });
});

// ---------------------------------------------------------------------------
// 10. Caller bridge
// ---------------------------------------------------------------------------

describe("coveragePacker — selectCoverageOrderedEntries", () => {
  interface Detail { readonly file: string; readonly surface: string; readonly score: number; readonly size: number }

  const pool: Detail[] = [
    { file: "src/contract.ts", surface: "contract", score: 0.9, size: 800 },
    { file: "src/api.ts", surface: "api", score: 0.85, size: 800 },
    { file: "src/domain-a.ts", surface: "domain", score: 0.8, size: 800 },
    { file: "src/domain-b.ts", surface: "domain", score: 0.79, size: 800 },
  ];

  const projection = {
    path: (d: Detail) => d.file,
    role: (d: Detail) => d.surface,
    confidence: (d: Detail) => d.score,
    bytes: (d: Detail) => d.size,
  };

  it("returns [role, detail] pairs in serve order and drops the redundant same-role file", () => {
    const { entries, output } = selectCoverageOrderedEntries(pool, projection, { byteBudget: 100_000 });
    expect(entries.map(([role, d]) => `${role}:${d.file}`)).toEqual([
      "contract:src/contract.ts",
      "api:src/api.ts",
      "domain:src/domain-a.ts",
    ]);
    expect(output.stopReason).toBe("saturated");
  });

  it("preserves the caller's own rank when one is projected", () => {
    const reversedRank = { ...projection, rank: (d: Detail) => pool.length - pool.indexOf(d) };
    const { entries } = selectCoverageOrderedEntries(pool, reversedRank, { byteBudget: 100_000 });
    expect(entries).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// 11. Advisory-posture fence (structural)
// ---------------------------------------------------------------------------

describe("coveragePacker — advisory posture", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "features", "task-pack", "coveragePacker.ts"),
    "utf8",
  );
  /** Comments may NAME the fence (the module header does); only real code counts as a reference. */
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

  it("does not reference the advisory reasoning IR in code", () => {
    expect(code.includes("reasoningIr")).toBe(false);
    expect(code.includes("projectTaskReasoningIR")).toBe(false);
    expect(code.includes("task-state")).toBe(false);
  });

  it("has no imports at all, so no transitive path to the IR can exist", () => {
    const imports = source.match(/^\s*import\s.+$/gm) ?? [];
    expect(imports).toEqual([]);
  });
});
