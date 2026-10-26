import { describe, expect, it } from "vitest";
import { planCompoundRequest } from "../features/task-pack/compoundRequests.js";
import { calleeTargetsIn, hasUnboundBareCallee, hasValuePositionOccurrence } from "../features/task-pack/evidenceClosure.js";
import { conceptAliasGroupsIn, explicitIdentifiersIn, extractFacetRequirements, maskJapaneseRequestPredicates, nonPointTermsIn } from "../features/task-pack/requestFacets.js";
describe("watcher and invoice request grounding", () => {
  it("preserves module call identities and distinguishes complex members from bare calls", () => {
    expect(calleeTargetsIn([
      'function invoice() {',
      '  cents(1); tax.calculate(1); shipping.calculate("JP"); tax.calculate(2);',
      '  (message || fallback).split(); split(); objects.shipping.calculate(3);',
      '}',
    ], false, "invoice")).toEqual([
      { name: "cents" }, { name: "calculate", owner: "tax" }, { name: "calculate", owner: "shipping" },
      { name: "split", qualified: true }, { name: "split" }, { name: "calculate", qualified: true },
    ]);
  });
  it.each([
    ['function invoice() { return missingAdjuster(1); }', 'missingAdjuster', true],
    ['function invoice() { return new Promise((resolve, reject) => resolve(1)); }', 'resolve', false],
    ['function invoice() { return new Promise(resolve => resolve(1)); }', 'resolve', false],
    ['function invoice() { return new Promise((resolve: (x: number) => void) => resolve(1)); }', 'resolve', false],
    ['function invoice() { new Promise(resolve => resolve(1)); return resolve(2); }', 'resolve', true],
    ['const actualRetry = function implementationName(): string { return "value"; };', 'implementationName', false],
    ['const actualRetry = function implementationName(): string { return implementationName(); };', 'implementationName', false],
    ['function invoice(callback: () => number) { return callback(); }', 'callback', false],
    ['function invoice() { return Promise.resolve(1); }', 'resolve', false],
  ])("keeps callback binding scope when checking missing callees: %s", (source, name, expected) => {
    expect(hasUnboundBareCallee([source as string], name as string, "source.ts")).toBe(expected);
  });
  it("does not turn namespace members into independent source files", () => {
    const plan = planCompoundRequest("Explain invoice in src/invoice.ts, including how cents, tax.calculate and shipping.calculate contribute to the returned total.");
    expect(plan.compound).toBe(false);
    expect(plan.clauses.flatMap((clause) => clause.paths)).not.toEqual(expect.arrayContaining(["tax.calculate", "shipping.calculate"]));
    expect(planCompoundRequest("Explain src/a.custom and src/b.custom.").clauses.flatMap((clause) => clause.paths)).toEqual(expect.arrayContaining(["src/a.custom", "src/b.custom"]));
    expect(planCompoundRequest("Explain `a.custom` and `b.custom`.").clauses.flatMap((clause) => clause.paths)).toEqual(expect.arrayContaining(["a.custom", "b.custom"]));
  });
  it.each([
    ["return tax.calculate(amount);", false],
    ["return tax?.calculate(amount);", false],
    ["return tax.calculate?.(amount);", false],
    ["return tax.calculate<Amount>(amount);", false],
    ["return tax.rate;", true],
    ["return tax.RATE;", true],
    ["return tax.calculate;", true],
    ["return tax;", true],
    ["return tax.calculate(amount) + tax.rate;", true],
  ])("namespace call mode keeps genuine values: %s", (line, expected) => {
    expect(hasValuePositionOccurrence([line as string], false, "tax", "source.ts", "calls")).toBe(expected);
  });
  it("masks independent read-only wording and a request predicate while preserving quotes", () => {
    const input = "エラー時の扱いも含めてください。変更は不要です。";
    const masked = maskJapaneseRequestPredicates(input);
    expect(masked).toHaveLength(input.length);
    expect(masked).toContain("エラー時の扱い");
    expect(masked).not.toMatch(/含めて|変更|不要/);
    expect(maskJapaneseRequestPredicates("「変更は不要です。」という文字列")).toContain("変更は不要です。");
  });
  it("keeps a failure aspect as a real flow refinement", () => {
    const requirements = extractFacetRequirements("WorkspaceWatcherの処理の流れを説明してください。エラー時の扱いも含めてください。");
    expect(requirements.some((requirement) => requirement.facet === "flow" && requirement.clause.includes("エラー時"))).toBe(true);
    expect(nonPointTermsIn(["error", "エラー時の扱い"], ["エラー時の扱い"])).toContain("エラー時の扱い");
    expect(nonPointTermsIn(["quasar", "quasarの扱い"], ["quasarの扱い"])).not.toContain("quasar");
  });
  it("treats Japanese bridge synonyms as alternatives but keeps explicitly named words independent", () => {
    expect(conceptAliasGroupsIn(["保存イベント"])).toContainEqual(["save", "store"]);
    expect(conceptAliasGroupsIn(["保存とstore関数"])).not.toContainEqual(["save", "store"]);
  });
  it.each([
    ["src/invoice.ts の invoice が返す値を説明してください", "invoice"],
    ["Explain invoice in src/invoice.ts", "invoice"],
    ["Describe retry in lib/retry.py", "retry"],
  ])("binds a bare identifier qualified by a source file: %s", (query, identifier) => {
    expect(explicitIdentifiersIn(query)).toContain(identifier);
  });
  it("distinguishes called functions from calling locations", () => {
    const callees = extractFacetRequirements("src/invoice.ts の invoice について、呼び出している関数の定義を説明してください。");
    expect(callees.some((requirement) => requirement.facet === "flow")).toBe(true);
    expect(callees.some((requirement) => requirement.facet === "callers")).toBe(false);
    const callers = extractFacetRequirements("invoiceAmountを呼び出している箇所を説明してください。");
    expect(callers.some((requirement) => requirement.facet === "callers")).toBe(true);
  });
});
