import { describe, expect, it } from "vitest";
import { expandOneHop } from "../features/task-pack/openUniverseExpansion.js";
import { hasOpenUniverseIntent } from "../features/task-pack/readCodeTaskPack.js";

describe("open-universe one-hop expansion", () => {
  it("preserves capped targets as explicit remaining work", () => {
    expect(expandOneHop("ts", ["a", "b", "c"], 2)).toEqual({
      targets: [{ target: "a", origin: "evidence-expansion" }, { target: "b", origin: "evidence-expansion" }],
      remaining: ["c"],
      explicitGap: "one-hop expansion capped; 1 target(s) remain open",
    });
  });
  it("makes unsupported language limits explicit rather than silently skipping", () => {
    expect(expandOneHop("python", ["f"], 2).explicitGap).toContain("unsupported");
  });
  it("recognizes direct English and Japanese open-universe quantifiers", () => {
    expect(hasOpenUniverseIntent("show every direct callee of calculateInvoiceTotal")).toBe(true);
    expect(hasOpenUniverseIntent("Add REFUNDED everywhere InvoiceStatus is used.")).toBe(true);
    expect(hasOpenUniverseIntent("calculateInvoiceTotal の全参照を確認")).toBe(true);
    expect(hasOpenUniverseIntent("show the implementation of calculateInvoiceTotal")).toBe(false);
    expect(hasOpenUniverseIntent("Explain priceOrder and its contract.")).toBe(false);
    expect(hasOpenUniverseIntent("Fix all three listed defects and find each root cause.")).toBe(false);
    expect(hasOpenUniverseIntent("3 症状すべてを修正する")).toBe(false);
  });

  // P1-e(ii) (2026-08-28 review-fix wave): the field-eval original phrasing
  // and the review's own "呼び出し元をすべて" both false-negatived against the
  // pre-wave OPEN_UNIVERSE_INTENT_JA list (a closed set of compound literals
  // that did not include the 「NOUN+を+すべて/全て」 or 「すべての/全ての+NOUN」
  // general forms). Both are asserted directly here — not only through the
  // sequenceCorpus I2 fixture, where the JA arm runs on the SAME server/
  // workspace right after the EN arm and so could pass via epoch carryover
  // from the EN pack's already-established open-universe obligation rather
  // than through this classifier recognizing the JA phrase on its own.
  it("recognizes the FE-original and reviewer JA quantifier-noun phrasings directly", () => {
    // FE-v0120 §7 P0-1 original query verbatim.
    expect(hasOpenUniverseIntent(
      "calculateInvoiceTotal が直接呼び出す関数の定義をすべて特定してください。",
    )).toBe(true);
    expect(hasOpenUniverseIntent("呼び出し元をすべて確認する")).toBe(true);
    expect(hasOpenUniverseIntent("全ての参照を一覚にして")).toBe(true);
    // The bounded-count negative stays false under the extended vocabulary too
    // (すべて here has no を separating it from the counted noun — すべてを marks
    // すべて itself as 修正する's object, not a quantifier over 症状).
    expect(hasOpenUniverseIntent("3 件すべてを修正する")).toBe(false);
    // REGRESSION GUARD: the PREFIX form (すべての/全ての + noun) needs the SAME
    // bounded-count exclusion, not only the suffix form above. First landing
    // of the bare "すべての"/"全ての" markers broke this exact live replayCorpus
    // fixture (mc2_stale_answer_mutation_prepared / dsh1_first_pack_sliver_doc
    // / dsh3_qref_context_repack_keeps_certificate, all sharing this query):
    // a bounded 3-concern aeroctl multi-fix task whose own completion-criteria
    // sentence reads "3 症状すべての根本原因を特定して全部修正を当てる" — すべての
    // there quantifies over the 3 NAMED symptoms, not an open-ended repo
    // search, and minting an open-universe obligation for it wrongly demoted
    // an otherwise-ready multi_concern pack from prepared back to discovery.
    expect(hasOpenUniverseIntent(
      "aeroctl のフライトテスト QA から 3 つの症状が同じビルドで報告されてる。完了基準: 3 症状すべての根本原因を特定して全部修正を当てる。",
    )).toBe(false);
  });
  it("serves every candidate or returns an explicit gap for the remainder", () => {
    const candidates = ["parseTax", "applyDiscount", "roundTotal", "writeAudit"];
    expect(expandOneHop("ts", candidates, 4)).toEqual({
      targets: candidates.map((target) => ({ target, origin: "evidence-expansion" })),
      remaining: [],
    });
    expect(expandOneHop("ts", candidates, 3)).toMatchObject({
      targets: candidates.slice(0, 3).map((target) => ({ target, origin: "evidence-expansion" })),
      remaining: ["writeAudit"],
      explicitGap: "one-hop expansion capped; 1 target(s) remain open",
    });
  });
});
