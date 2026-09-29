/**
 * evaluation0927.negatedInstructionItems.spec.ts — a negated instruction is a
 * constraint on a future edit, never a request item (eval-0927 review-r4
 * P1-10's related P2, callersNegatedSameSentence): "…, and please do not modify
 * anything?" made `modify` a topic item, searched for and certified
 * `explicit-gap:request-item-absent:modify`. requestItems.ts now drops such a
 * segment with the same test requestFacets.ts applies to facet clauses.
 */
import { describe, expect, it } from "vitest";

import { extractRequestItems } from "../features/task-pack/requestItems.js";

function itemTexts(query: string): string[] {
  return extractRequestItems(query).map((item) => item.text);
}

function itemTerms(query: string): string[] {
  return extractRequestItems(query).flatMap((item) => item.terms.map((term) => term.toLowerCase()));
}

describe("negated instructions are not request items", () => {
  it("EN: `please do not modify anything` is no item and `modify` is never a term", () => {
    const query = "Who calls fetchWithRetry, and please do not modify anything?";
    expect(itemTerms(query)).not.toContain("modify");
    expect(itemTexts(query).some((text) => /modify/i.test(text))).toBe(false);
  });

  it("EN: a `; also do not touch …` constraint is dropped, the question stays", () => {
    const texts = itemTexts("Explain the cache TTL; also do not touch the eviction code.");
    expect(texts.some((text) => /touch|eviction/i.test(text))).toBe(false);
    expect(texts.some((text) => /cache TTL/.test(text))).toBe(true);
  });

  it("JA: 「…は変更しないでください」 is dropped, the explanation request stays", () => {
    const texts = itemTexts("返金の処理を説明し、ファイルは変更しないでください");
    expect(texts.some((text) => text.includes("変更しない"))).toBe(false);
    expect(texts.some((text) => text.includes("返金"))).toBe(true);
  });

  it("control: two real questions stay two items", () => {
    expect(itemTexts("Explain how refunds are processed and how inventory is replenished.")).toHaveLength(2);
  });
});
