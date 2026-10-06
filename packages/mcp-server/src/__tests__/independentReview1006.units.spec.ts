/**
 * independentReview1006.units.spec.ts — the pure pieces behind the
 * 2026-10-06 independent review fixes (independentReview1006.spec.ts drives
 * them end to end over stdio):
 *   - requestFacets.ts `framedCodeNamesIn` / `subjectCallableNamesIn` (P1-3):
 *     "the retry function" names `retry`;
 *   - `maskCallArgumentPunctuation` / `maskExplanationAspectPhrases` and the
 *     result-kind JA descriptors (P2-1): a call's argument comma is never a
 *     clause or item boundary, and "edge cases" / 金額 are never source terms;
 *   - facetGate.ts `combineSubjectFacetFacts` (P1-4): every subject of a
 *     requirement is required;
 *   - facetGate.ts `recordFacetDependencyEntries` / `facetDependencyEntriesFor`
 *     (P1-1/P1-2): what a callable served on an earlier hop reads stays owed
 *     across hops, one record per callable, never reset by a re-plan;
 *   - requestFacets.ts `isStructuralOnlyRequest`: a question that only locates
 *     or relates code (the semantic-frontier bench's sealed branch cases) gets
 *     no dependency constants, every behaviour or value question still does.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  extractFacetRequirements,
  framedCodeNamesIn,
  isFacetDescriptorTerm,
  isStructuralOnlyRequest,
  maskCallArgumentPunctuation,
  maskExplanationAspectPhrases,
  subjectCallableNamesIn,
} from "../features/task-pack/requestFacets.js";
import { extractRequestItems, salientWords } from "../features/task-pack/requestItems.js";
import {
  combineSubjectFacetFacts,
  facetDependencyEntriesFor,
  recordFacetDependencyEntries,
  recordFacetPlan,
  resetFacetPlansForTest,
  type FacetFacts,
  type FacetPlanEntry,
} from "../features/task-pack/facetGate.js";

afterEach(() => resetFacetPlansForTest());

const JA_AMOUNT_QUERY = "src/order.js の calculateTotal(4800, 0) と calculateTotal(5000, 0) の金額を、送料と税率の条件とともに説明してください。";

describe("P1-3 — a plain word the question frames as code names that declaration", () => {
  it.each([
    ["Explain the retry function, including the exact maximum number of attempts.", ["retry"]],
    ["Explain retry in src/retry.js, including the exact maximum number of attempts.", ["retry"]],
    ["What does function retry do?", ["retry"]],
    ["Explain the parse method and its callers.", ["parse"]],
    ["retry 関数の最大試行回数を説明してください。", ["retry"]],
  ])("%s → %j", (query, names) => {
    expect(framedCodeNamesIn(query)).toEqual(names);
  });

  it.each([
    "Explain the async function in src/a.ts.",
    "How does this function handle errors?",
    "Explain the request handler and the error callback.",
    "Which function calls retryDelay?",
    "Explain the logic in src/retry.js.",
  ])("%s names nothing", (query) => {
    expect(framedCodeNamesIn(query)).toEqual([]);
  });

  it("call syntax comes first, frames after it, case-insensitively deduplicated", () => {
    expect(subjectCallableNamesIn("Compare quote() with the retry function and the Retry method.")).toEqual(["quote", "retry"]);
  });

  it.each([
    "Calculate invoiceAmount(1000).",
    "Compute invoiceAmount(1000)",
    "invoiceAmount(1000) を計算してください。",
    "invoiceAmount(1000) はいくら？",
  ])("P1-1: %s asks for a computed value of invoiceAmount (its callees and their constants are then required)", (query) => {
    const requirements = extractFacetRequirements(query);
    expect(requirements.map((requirement) => requirement.facet)).toEqual(["value"]);
    expect(requirements[0]!.subjectCallables).toEqual(["invoiceAmount"]);
  });

  it.each(["Explain how calculateTotal(5000, 0) is computed.", "Calculate the shipping for an order."])("%s is not a computed-value clause", (query) => {
    expect(extractFacetRequirements(query)).toEqual([]);
  });

  it("a value clause inherits the framed name of its lead as the callable it asks about", () => {
    const requirements = extractFacetRequirements("Explain the retry function, including the exact maximum number of attempts.");
    expect(requirements.length).toBeGreaterThan(0);
    for (const requirement of requirements) expect(requirement.subjectCallables).toContain("retry");
  });
});

describe("P2-1 — a call's argument comma is not a boundary, and an aspect is not a source term", () => {
  it("masks argument commas inside call parentheses only, length-preserving", () => {
    const masked = maskCallArgumentPunctuation(JA_AMOUNT_QUERY, ",、");
    expect(masked.length).toBe(JA_AMOUNT_QUERY.length);
    expect(masked).toContain("calculateTotal(4800_ 0)");
    expect(masked).toContain("calculateTotal(5000_ 0)");
    expect(masked).toContain("の金額を、送料");
  });

  it.each([
    ["Explain X (its default, its callers).", "a prose parenthetical (no name before it)"],
    ["Explain f(a, b", "an unclosed group"],
  ])("leaves %s alone — %s", (text) => {
    expect(maskCallArgumentPunctuation(text, ",")).toBe(text);
  });

  it("masks every comma of a nested call", () => {
    expect(maskCallArgumentPunctuation("f(g(a, b), c) and h", ",")).toBe("f(g(a_ b)_ c) and h");
  });

  it("the facet clauses and request items of the reviewer's 金額 query never start inside an argument list", () => {
    for (const requirement of extractFacetRequirements(JA_AMOUNT_QUERY)) expect(requirement.clause).not.toMatch(/^0\)/u);
    const items = extractRequestItems(JA_AMOUNT_QUERY);
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.text).not.toMatch(/^0\)/u);
      expect(item.text).not.toMatch(/\(\d+$/u);
    }
  });

  it("explanation-aspect phrases are masked whole, never their words alone", () => {
    const query = "Explain retryDelay and calculateTotal, including their constants, edge cases, and callers.";
    const masked = maskExplanationAspectPhrases(query);
    expect(masked.length).toBe(query.length);
    expect(masked).not.toMatch(/edge|cases/u);
    expect(maskExplanationAspectPhrases("the corner-case and boundary conditions")).not.toMatch(/corner|case|boundary|conditions/u);
    expect(maskExplanationAspectPhrases("the test cases and the edge router")).toBe("the test cases and the edge router");
    // A path or an identifier keeps its words: they name files, not aspects.
    for (const named of ["Explain src/edge-cases.ts and test/error-cases.spec.ts", "the edge_cases helper"]) {
      expect(maskExplanationAspectPhrases(named)).toBe(named);
    }
    expect(maskExplanationAspectPhrases("Explain the edge cases.")).toBe("Explain the           .");
    const words = salientWords(query).map((word) => word.toLowerCase());
    expect(words).not.toContain("edge");
    expect(words).not.toContain("cases");
  });

  it.each(["金額", "戻り値", "返り値", "計算結果", "結果", "エッジケース", "境界条件", "回数", "条件"])("%s is an answer-kind descriptor", (term) => {
    expect(isFacetDescriptorTerm(term)).toBe(true);
  });

  it.each(["計算", "送料", "SALES_TAX", "calculateTotal"])("%s stays a possible subject", (term) => {
    expect(isFacetDescriptorTerm(term)).toBe(false);
  });
});

const window = (path: string, start: number, end: number) => ({ kind: "caller" as const, path, start, end, name: "f" });
const facts = (kind: FacetFacts["kind"], extra: Partial<FacetFacts> = {}): FacetFacts => ({
  kind,
  term: `callers:${kind}`,
  reason: kind,
  focalResolved: true,
  servedWindows: [],
  openTargets: [],
  ...extra,
});

describe("P1-4 — every subject of a requirement is required", () => {
  it("one subject is returned unchanged", () => {
    const only = facts("covered");
    expect(combineSubjectFacetFacts([only])).toBe(only);
  });

  it("an open subject keeps the requirement open, with every open subject's windows and every served one", () => {
    const combined = combineSubjectFacetFacts([
      facts("covered", { servedWindows: [window("src/retry.js", 12, 12)] }),
      facts("open", { openTargets: [{ path: "src/caller.js", start: 1, end: 6 }] }),
      facts("open", { openTargets: [{ path: "src/caller.js", start: 1, end: 6 }, { path: "src/a.js", start: 3, end: 4 }] }),
    ]);
    expect(combined.kind).toBe("open");
    expect(combined.openTargets).toEqual([{ path: "src/caller.js", start: 1, end: 6 }, { path: "src/a.js", start: 3, end: 4 }]);
    expect(combined.servedWindows).toEqual([window("src/retry.js", 12, 12)]);
  });

  it("undetermined outranks covered; covered outranks a verified-empty sibling; empty only when every subject is", () => {
    expect(combineSubjectFacetFacts([facts("covered"), facts("undetermined", { disclosure: { word: "request-item-undetermined", reason: "x" } })]).kind).toBe("undetermined");
    expect(combineSubjectFacetFacts([facts("empty"), facts("covered")]).kind).toBe("covered");
    expect(combineSubjectFacetFacts([facts("empty"), facts("empty")]).kind).toBe("empty");
  });
});

const dependencyEntry = (subject: string, path: string): FacetPlanEntry => ({
  facet: "value",
  clause: "(values the served code reads)",
  subject,
  dependency: true,
  resolution: "resolved",
  focal: { path, name: subject, start: 1, end: 3 },
  windows: [],
});

describe("P1-1/P1-2 — dependency records outlive a re-plan, one per callable", () => {
  const sha = (shas: Record<string, string>) => (path: string): string | undefined => shas[path];
  const subjects = (entries: readonly FacetPlanEntry[]): Array<string | undefined> => entries.map((entry) => entry.subject);

  it("records a facet-free question's dependencies and survives the clause plan being re-recorded", () => {
    recordFacetDependencyEntries("/ws", "q", [{ entry: dependencyEntry("invoiceAmount", "src/large.js"), fileShas: { "src/large.js": "a" } }]);
    recordFacetPlan("/ws", { query: "q", entries: [], fileShas: {} });
    expect(subjects(facetDependencyEntriesFor("/ws", "q", sha({ "src/large.js": "a" })))).toEqual(["invoiceAmount"]);
  });

  it("a later hop that closes another callable keeps the earlier record; closing the same callable replaces it", () => {
    recordFacetDependencyEntries("/ws", "q", [{ entry: dependencyEntry("priceFor", "src/price.js"), fileShas: {} }]);
    recordFacetDependencyEntries("/ws", "q", [{ entry: dependencyEntry("retry", "src/retry.js"), fileShas: {} }]);
    const replacement = { ...dependencyEntry("priceFor", "src/price.js"), resolution: "budget-exhausted" as const };
    recordFacetDependencyEntries("/ws", "q", [{ entry: replacement, fileShas: {} }]);
    const entries = facetDependencyEntriesFor("/ws", "q", sha({}));
    expect(subjects(entries)).toEqual(["retry", "priceFor"]);
    expect(entries[1]!.resolution).toBe("budget-exhausted");
  });

  it("ignores a record whose files changed since, and keeps the others", () => {
    recordFacetDependencyEntries("/ws", "q", [
      { entry: dependencyEntry("f", "src/a.js"), fileShas: { "src/a.js": "old" } },
      { entry: dependencyEntry("g", "src/b.js"), fileShas: { "src/b.js": "b" } },
    ]);
    expect(subjects(facetDependencyEntriesFor("/ws", "q", sha({ "src/a.js": "new", "src/b.js": "b" })))).toEqual(["g"]);
  });

  it("is per query and per workspace", () => {
    recordFacetDependencyEntries("/ws", "q", [{ entry: dependencyEntry("f", "src/a.js"), fileShas: {} }]);
    expect(facetDependencyEntriesFor("/ws", "other", sha({}))).toEqual([]);
    expect(facetDependencyEntriesFor("/other", "q", sha({}))).toEqual([]);
  });
});

describe("dependency closure scope — a question that only locates or relates code reads no values", () => {
  // The semantic-frontier bench's sealed branch questions, verbatim: their qrels
  // score a constant the named consumer reads as an irrelevant path.
  it.each([
    "Trace INVOICE_V2_FLAG invoiceVersion renderInvoice src/feature_flags.ts relation feature flag branch.",
    "Find InvoiceSchema invoice_schema.gen.ts renderInvoice relation consumed generated schema.",
    "Show relation renderInvoice render_invoice.ts imports connecting invoiceVersion feature_flags.ts INVOICE_TEMPLATE invoice_template.ts InvoiceSchema invoice_schema.gen.ts.",
    "Locate INVOICE_TEMPLATE invoice_template.ts renderInvoice relation invoice template used by the renderer.",
    "Trace ENGAGEMENT_WITNESS continuation relation while retaining the supporting context.",
    "Where is retryDelay defined?",
    "Which functions call retryDelay?",
    "Find the callers of computeTotal.",
    "retryDelay はどこで呼び出されていますか？",
  ])("structural only: %s", (query) => {
    expect(isStructuralOnlyRequest(query)).toBe(true);
  });

  // The review's P1-1..P1-4 / P2-1 questions and paraphrases: each asks what code
  // does or computes, or for a value it uses, so the closure still runs.
  it.each([
    "Calculate invoiceAmount(1000).",
    "What does invoiceAmount(1000) return?",
    "Explain invoiceAmount and the sales tax it uses.",
    "invoiceAmount(1000) を計算してください。",
    "retryDelay の待機時間を attempt=0〜5 について説明してください。上限と最大リトライ回数も示してください。",
    "How many attempts does retry make at most?",
    "Explain priceFor.",
    "Explain retryDelay and calculateTotal, including their constants, edge cases, and callers.",
    "Show me the callers of calculateTotal and the constants it reads.",
    "Trace how retryDelay computes the wait time.",
    "calculateTotal(5000, 0) の計算結果と送料の条件を教えてください。",
    "Where is computeTotal used?  What does it return?",
  ])("about behaviour or values: %s", (query) => {
    expect(isStructuralOnlyRequest(query)).toBe(false);
  });

  it("an identifier that merely contains a behaviour word is not one (word boundaries)", () => {
    expect(isStructuralOnlyRequest("Where is computeTotal used?")).toBe(true);
    expect(isStructuralOnlyRequest("Find the callers of explain_limits.")).toBe(true);
  });
});
