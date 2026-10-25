import { describe, expect, it } from "vitest";
import type { ImpactCandidate } from "@tokenlighten/types";
import {
  coalesceCompoundEvidenceWindows,
  extractCompoundFacetRequirements,
  extractCompoundRequestItems,
  mergeCompoundCandidates,
  planCompoundRequest,
} from "../features/task-pack/compoundRequests.js";
import { extractRequestItems } from "../features/task-pack/requestItems.js";
import { extractFacetRequirements } from "../features/task-pack/requestFacets.js";

const candidate = (path: string, line = 1, confidence = 0.8): ImpactCandidate => ({ path, line, surface: "domain", confidence, why: "definition" });

describe("compound request planning", () => {
  it("locates two callable/file subjects independently and retains citation instructions", () => {
    const query = "Explain alpha() in src/a.ts and beta() in src/b.py. Cite file and line sources.";
    const plan = planCompoundRequest(query);
    expect(plan.originalQuery).toBe(query);
    expect(plan.clauses.map((clause) => clause.subjects)).toEqual([["alpha"], ["beta"]]);
    expect(plan.clauses.map((clause) => clause.paths)).toEqual([["src/a.ts"], ["src/b.py"]]);
    expect(plan.clauses[0]!.query).not.toContain("beta");
    expect(plan.constraints).toEqual(["Cite file and line sources."]);
  });

  it("keeps Japanese facets scoped to their own callable/file", () => {
    const plan = planCompoundRequest("src/a.ts の alpha() の戻り値と、src/b.py の beta() の呼び出し元を説明してください。出典と行番号を示してください。");
    expect(plan.clauses).toHaveLength(2);
    expect(plan.clauses[0]!.facets[0]!.facet).toBe("value");
    expect(plan.clauses[0]!.facets[0]!.subjectCallables).toEqual(["alpha"]);
    expect(plan.clauses[0]!.facets[0]!.subjectTerms).not.toContain("beta");
    expect(plan.clauses[1]!.facets[0]!.facet).toBe("callers");
    expect(plan.clauses[1]!.facets[0]!.subjectCallables).toEqual(["beta"]);
    expect(plan.constraints).toEqual(["出典と行番号を示してください。"]);
  });

  it("resets inheritance at each subject header in a bullet list", () => {
    const plan = planCompoundRequest("For alpha():\n- the returned value\n- callers\nFor beta():\n- retry conditions\n- callers");
    expect(plan.clauses.map((clause) => clause.subjects)).toEqual([["alpha"], ["alpha"], ["beta"], ["beta"]]);
    expect(plan.clauses.map((clause) => clause.facets[0]!.facet)).toEqual(["value", "callers", "condition", "callers"]);
    expect(plan.clauses[2]!.facets[0]!.subjectCallables).toEqual(["beta"]);
    expect(plan.clauses[2]!.query).not.toContain("alpha");
  });

  it("inherits one subject across anaphoric clauses and keeps independent concepts unbound", () => {
    const plan = planCompoundRequest("What does alpha() return and who calls it? How is database migration executed?");
    expect(plan.clauses).toHaveLength(3);
    expect(plan.clauses[1]!.subjects).toEqual(["alpha"]);
    expect(plan.clauses[1]!.inheritedSubjects).toBe(true);
    expect(plan.clauses[2]!.subjects).toEqual([]);
    expect(plan.clauses[2]!.query).not.toContain("alpha");
  });

  it("does not inherit a previous function for a facet naming its own prose subject", () => {
    const plan = planCompoundRequest("What does alpha() return? Explain the callers of the missing service.");
    expect(plan.clauses[1]!.subjects).toEqual([]);
    expect(plan.clauses[1]!.inheritedSubjects).toBe(false);
    expect(plan.clauses[1]!.facets[0]!.subjectCallables).toBeUndefined();
  });

  it("never invents a subject when the request has none", () => {
    const plan = planCompoundRequest("What is the default timeout? Who calls it?");
    expect(plan.clauses.map((clause) => clause.subjects)).toEqual([[], []]);
    expect(plan.clauses.every((clause) => !clause.inheritedSubjects)).toBe(true);
  });

  it.each([
    'Explain the literal "red and blue; still quoted" in src/a.ts and the value of beta().',
    "Explain the literal 「赤と青、黄色」 in src/a.ts and the value of beta().",
    "Explain the literal `red and blue; still quoted` in src/a.ts and the value of beta().",
  ])("protects quoted conjunctions: %s", (query) => {
    const plan = planCompoundRequest(query);
    expect(plan.clauses).toHaveLength(2);
    expect(plan.clauses[0]!.text).toContain("literal");
    expect(plan.clauses[0]!.paths).toEqual(["src/a.ts"]);
    expect(plan.clauses[1]!.subjects).toEqual(["beta"]);
  });

  it("does not split conjunctions inside calls or a relation between subjects", () => {
    expect(planCompoundRequest('What does alpha("red and blue", 3) return and who calls beta()?').clauses).toHaveLength(2);
    expect(planCompoundRequest("Explain how data flows through TransferBuffer and GraphClient.").clauses).toHaveLength(1);
    expect(planCompoundRequest("Compare src/a.ts and src/b.py.").clauses).toHaveLength(1);
  });

  it("splits path conjunctions without splitting file extensions or qualified members", () => {
    expect(planCompoundRequest("Explain src/a.ts and src/b.py.").clauses.map((clause) => clause.paths)).toEqual([["src/a.ts"], ["src/b.py"]]);
    const plan = planCompoundRequest("For OrderService::cancel:\n- callers\n- its conditions");
    expect(plan.clauses[0]!.facets[0]!.qualifiedMembers).toEqual([{ owner: "OrderService", member: "cancel" }]);
  });

  it("retains negated edit constraints instead of turning them into search targets", () => {
    const plan = planCompoundRequest("Explain alpha() and beta(). Do not modify any files.");
    expect(plan.clauses).toHaveLength(2);
    expect(plan.constraints).toEqual(["Do not modify any files."]);
  });

  it("preserves unknown points and reports clause/input bounds explicitly", () => {
    const query = Array.from({ length: 100 }, (_, index) => `Explain fn${index}().`).join("\n");
    const plan = planCompoundRequest(query, undefined, { maxClauses: 2, maxQueryChars: 100 });
    expect(plan.clauses).toHaveLength(2);
    expect(plan.originalQuery).toBe(query);
    expect(plan.outstanding).toEqual(expect.arrayContaining([
      { reason: "query-budget", status: "could-not-determine" },
      { reason: "clause-budget", status: "could-not-determine" },
    ]));
    const items = extractCompoundRequestItems(query, undefined, { maxClauses: 2, maxQueryChars: 100 });
    expect(items.at(-1)).toMatchObject({ text: query, bindable: false });
    expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
  });

  it("keeps semicolon-separated evaluation inputs and output refinements with their callable", () => {
    const query = "Calculate exact estimate() results for these records: A count 2; mode FAST; region north; B count 4; mode SLOW; region west; C count 3; mode FAST; region south. Report netValue, totalValue; explain rounding rules. Include exact evidence.";
    const plan = planCompoundRequest(query, undefined, { maxClauses: 2 });
    expect(plan.compound).toBe(false);
    expect(plan.clauses).toHaveLength(1);
    expect(plan.clauses[0]!.text).toBe(query);
    expect(plan.outstanding).toEqual([]);
    expect(extractCompoundFacetRequirements(query)).toEqual(extractFacetRequirements(query));
    expect(extractCompoundRequestItems(query)).toEqual(extractRequestItems(query));
  });

  it("keeps a coordinated input-label header intact instead of borrowing identifiers after its colon", () => {
    const query = "Inspect src/orders and calculate the exact estimate() result for cases A, B, and C: count 2 FAST; count 4 SLOW; count 3 FAST. Need rounding rules and relevant code line numbers.";
    const plan = planCompoundRequest(query, undefined, { maxClauses: 2 });
    expect(plan.compound).toBe(false);
    expect(plan.clauses[0]!.text).toBe(query);
    expect(plan.outstanding).toEqual([]);
    expect(extractCompoundFacetRequirements(query)).toEqual(extractFacetRequirements(query));
  });

  it("closes an input block before a genuinely independent request and retains both subjects", () => {
    const block = "Calculate estimate() results for records: count 1; count 2; count 3.";
    const query = `${block} What does computeTax() return?`;
    const plan = planCompoundRequest(query, undefined, { maxClauses: 2 });
    expect(plan.compound).toBe(true);
    expect(plan.clauses.map((clause) => clause.text)).toEqual([block, "What does computeTax() return?"]);
    expect(plan.clauses.map((clause) => clause.subjects)).toEqual([["estimate"], ["computeTax"]]);
    expect(plan.outstanding).toEqual([]);
  });

  it("does not consume the clause budget for repeated evidence-format instructions", () => {
    const query = `Explain priceOrder and its contract. ${"Include exact evidence. ".repeat(40)}`;
    const plan = planCompoundRequest(query, undefined, { maxClauses: 8 });
    expect(plan.compound).toBe(false);
    expect(plan.clauses).toHaveLength(1);
    expect(plan.constraints).toHaveLength(40);
    expect(plan.outstanding).toEqual([]);
  });

  it("retains a citation clause that also requests an independent subject", () => {
    const plan = planCompoundRequest("Explain retryDelay(). Give sources of jitter.");
    expect(plan.clauses.map((clause) => clause.text)).toEqual(["Explain retryDelay().", "Give sources of jitter."]);
    expect(plan.constraints).toEqual([]);
  });

  it("bounds an oversized query deterministically", () => {
    const query = "Explain alpha() and beta().\n".repeat(20_000);
    const first = planCompoundRequest(query);
    const second = planCompoundRequest(query);
    expect(first).toEqual(second);
    expect(first.clauses.length).toBeLessThanOrEqual(32);
    expect(first.outstanding.map((entry) => entry.reason)).toEqual(["query-budget", "clause-budget"]);
  });
});

describe("compound parser adapters", () => {
  it("keeps base parser outputs unchanged for single requests and disabled composition", () => {
    for (const query of ["Explain alpha().", "Who calls alpha()?", "Explain how data flows through TransferBuffer and GraphClient.", "What does alpha() return and who calls it?", "Explain MAX_RETRIES in src/retry.ts; then set it to 5."]) {
      expect(extractCompoundRequestItems(query)).toEqual(extractRequestItems(query));
      expect(extractCompoundFacetRequirements(query)).toEqual(extractFacetRequirements(query));
    }
    const query = "What does alpha() return and who calls beta()?";
    expect(extractCompoundRequestItems(query, undefined, { enabled: false })).toEqual(extractRequestItems(query));
    expect(extractCompoundFacetRequirements(query, { enabled: false })).toEqual(extractFacetRequirements(query));
  });

  it.each([
    "src/new-config.ts を新規作成してください。内容は export const ENABLED = true; としてください。",
    "Trace how tl_read_file mode=task_pack builds execution_contract readiness and structured next_call; identify the implementation path and exact regression tests",
    "How is the display language decided? Explain how the status bar and the update checker reflect the decided language, how getDisplayLanguage decides it, and the config key in package.json.",
    'Explain MAX_RETRIES in src/retry.ts, and update "notes.txt".',
  ])("keeps content specifications and shared-concern source refinements in their original context: %s", (query) => {
    expect(planCompoundRequest(query).compound).toBe(false);
    expect(extractCompoundRequestItems(query)).toEqual(extractRequestItems(query));
    expect(extractCompoundFacetRequirements(query)).toEqual(extractFacetRequirements(query));
  });

  it("still composes independently requested edits in two files", () => {
    const query = "Change FIRST in src/a.ts to 5. Change SECOND in src/b.ts to 7.";
    const plan = planCompoundRequest(query);
    expect(plan.compound).toBe(true);
    expect(plan.clauses.map((clause) => clause.paths)).toEqual([["src/a.ts"], ["src/b.ts"]]);
  });

  it("combines clause-local facets without sibling subject pollution and gives items unique IDs", () => {
    const query = "What does alpha() return and who calls beta()?";
    const facets = extractCompoundFacetRequirements(query);
    expect(facets.map((facet) => facet.subjectCallables)).toEqual([["alpha"], ["beta"]]);
    expect(facets[0]!.subjectTerms).not.toContain("beta");
    expect(extractCompoundRequestItems(query).map((item) => item.id)).toEqual(["ri-1", "ri-2"]);
  });

  it("retains original clauses and inherited subject ownership for gap reporting", () => {
    const query = "For alpha():\n- callers\n- the returned value\nFor beta():\n- callers";
    const items = extractCompoundRequestItems(query);
    expect(items.map((item) => item.text)).toEqual(["callers", "the returned value", "callers"]);
    expect(items.map((item) => item.facetSubject)).toEqual([["alpha"], ["alpha"], ["beta"]]);
    expect(extractCompoundFacetRequirements(query).map((facet) => facet.clause)).toEqual(["callers", "the returned value", "callers"]);
  });
});

describe("compound candidate and evidence merging", () => {
  it("round-robin merges independent candidates and keeps duplicate clause ownership", () => {
    const plan = planCompoundRequest("Explain alpha() and beta().");
    const result = mergeCompoundCandidates(plan, [
      { clauseId: "cr-1", complete: true, candidates: [candidate("a.ts"), candidate("shared.ts"), { ...candidate("required.ts"), required: true }] },
      { clauseId: "cr-2", complete: true, candidates: [candidate("b.ts"), { ...candidate("shared.ts", 1, 0.9), required: true }] },
    ], { maxCandidates: 3 });
    expect(result.candidates.map((row) => row.path)).toEqual(["a.ts", "b.ts", "shared.ts"]);
    expect(result.owners[2]!.clauseIds).toEqual(["cr-1", "cr-2"]);
    expect(result.candidates[2]).toMatchObject({ confidence: 0.9, required: true });
    expect(result.outstanding).toEqual([{ clauseId: "cr-1", reason: "candidate-budget", status: "open" }]);
  });

  it("does not turn omitted optional ranked noise into an unfulfilled request", () => {
    const plan = planCompoundRequest("Explain alpha() and beta().");
    const result = mergeCompoundCandidates(plan, [
      { clauseId: "cr-1", complete: true, candidates: [candidate("a.ts"), candidate("noise.ts")] },
      { clauseId: "cr-2", complete: true, candidates: [candidate("b.ts")] },
    ], { maxCandidates: 2 });
    expect(result.candidates.map((row) => row.path)).toEqual(["a.ts", "b.ts"]);
    expect(result.outstanding).toEqual([]);
  });

  it("still names a clause for which the candidate budget retained no candidate", () => {
    const plan = planCompoundRequest("Explain alpha() and beta().");
    const result = mergeCompoundCandidates(plan, [
      { clauseId: "cr-1", complete: true, candidates: [candidate("a.ts")] },
      { clauseId: "cr-2", complete: true, candidates: [candidate("b.ts")] },
    ], { maxCandidates: 1 });
    expect(result.outstanding).toContainEqual({ clauseId: "cr-2", reason: "candidate-budget", status: "open" });
  });

  it("does not claim an absent or incomplete clause complete", () => {
    const plan = planCompoundRequest("Explain alpha() and beta() and gamma().");
    const result = mergeCompoundCandidates(plan, [
      { clauseId: "cr-1", complete: true, candidates: [candidate("a.ts")] },
      { clauseId: "cr-2", complete: true, candidates: [] },
    ]);
    expect(result.outstanding).toEqual([
      { clauseId: "cr-2", reason: "not-located", status: "could-not-determine" },
      { clauseId: "cr-3", reason: "discovery-incomplete", status: "could-not-determine" },
    ]);
  });

  it("preserves zoom windows, symbols and different file snapshots", () => {
    const plan = planCompoundRequest("Explain alpha() and beta().");
    const rows = [
      { ...candidate("same.ts"), range: "1-5", symbol: "alpha" },
      { ...candidate("same.ts"), range: "1-5", symbol: "beta" },
      { ...candidate("same.ts"), range: "1-5", symbol: "alpha", callerRange: true },
      { ...candidate("same.ts"), range: "1-5", symbol: "alpha", sha: "new" },
    ];
    const result = mergeCompoundCandidates(plan, [{ clauseId: "cr-1", complete: true, candidates: rows }]);
    expect(result.candidates).toHaveLength(4);
    expect(rows[0]).not.toHaveProperty("required");
  });

  it("coalesces overlapping/adjacent evidence windows while retaining all requirement owners", () => {
    const result = coalesceCompoundEvidenceWindows([
      { path: "a.ts", start: 5, end: 12, clauseIds: ["cr-2"] },
      { path: "a.ts", start: 1, end: 8, clauseIds: ["cr-1"] },
      { path: "a.ts", start: 13, end: 15, clauseIds: ["cr-1"] },
      { path: "a.ts", start: 30, end: 40, clauseIds: ["cr-3"] },
      { path: "a.ts", start: 1, end: 8, clauseIds: ["cr-4"], sha: "other" },
      { path: "b.py", start: 1, end: 3, clauseIds: ["cr-2"] },
      { path: "a.ts", start: 0, end: 5, clauseIds: ["invalid"] },
    ]);
    expect(result).toEqual([
      { path: "a.ts", start: 1, end: 15, clauseIds: ["cr-1", "cr-2"] },
      { path: "a.ts", start: 30, end: 40, clauseIds: ["cr-3"] },
      { path: "a.ts", start: 1, end: 8, clauseIds: ["cr-4"], sha: "other" },
      { path: "b.py", start: 1, end: 3, clauseIds: ["cr-2"] },
    ]);
  });
});
