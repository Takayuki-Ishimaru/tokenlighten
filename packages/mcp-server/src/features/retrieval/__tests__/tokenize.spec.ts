/**
 * tokenize.spec.ts — V10-08 Hybrid Retrieval v1: tokenizer decomposition
 * cases (camel/snake/kebab, error codes, string literals, test names).
 */

import { describe, it, expect } from "vitest";
import { decomposeIdentifier, isErrorCodeToken, tokenizeText, tokenizeQuery, normalizeQuery } from "../tokenize.js";

describe("decomposeIdentifier — camel/snake/kebab/acronym decomposition", () => {
  it("splits camelCase", () => {
    expect(decomposeIdentifier("contentSufficiency")).toEqual(["content", "sufficiency"]);
  });

  it("splits snake_case", () => {
    expect(decomposeIdentifier("content_sufficiency")).toEqual(["content", "sufficiency"]);
  });

  it("splits kebab-case", () => {
    expect(decomposeIdentifier("content-sufficiency")).toEqual(["content", "sufficiency"]);
  });

  it("splits PascalCase", () => {
    expect(decomposeIdentifier("ContentSufficiency")).toEqual(["content", "sufficiency"]);
  });

  it("splits consecutive-caps acronyms from a following word", () => {
    expect(decomposeIdentifier("getHTTPStatus")).toEqual(["get", "http", "status"]);
  });

  it("splits a letter/digit boundary", () => {
    expect(decomposeIdentifier("utf8Encoding")).toEqual(["utf", "8", "encoding"]);
  });

  it("leaves a plain lowercase word whole", () => {
    expect(decomposeIdentifier("sufficiency")).toEqual(["sufficiency"]);
  });

  it("leaves a bare acronym with nothing following it whole", () => {
    expect(decomposeIdentifier("TODO")).toEqual(["todo"]);
  });

  it("splits a three-segment snake identifier", () => {
    expect(decomposeIdentifier("read_code_task_pack")).toEqual(["read", "code", "task", "pack"]);
  });
});

describe("isErrorCodeToken — error/status code shape recognition", () => {
  it("recognizes an underscore-segmented all-caps code", () => {
    expect(isErrorCodeToken("ERR_NOT_FOUND")).toBe(true);
  });

  it("recognizes a hyphen-segmented code", () => {
    expect(isErrorCodeToken("TL-1234")).toBe(true);
  });

  it("recognizes a letter-prefixed numeric code", () => {
    expect(isErrorCodeToken("E1234")).toBe(true);
  });

  it("rejects a plain lowercase word", () => {
    expect(isErrorCodeToken("hello")).toBe(false);
  });

  it("rejects a plain camelCase identifier", () => {
    expect(isErrorCodeToken("contentSufficiency")).toBe(false);
  });
});

describe("tokenizeText — free-text tokenization for BM25F fields", () => {
  it("decomposes an identifier found in running text", () => {
    const tokens = tokenizeText("call contentSufficiency to check");
    expect(tokens).toContain("content");
    expect(tokens).toContain("sufficiency");
  });

  it("keeps an error code whole (lowercased) in addition to its decomposed parts", () => {
    const tokens = tokenizeText("raises ERR_NOT_FOUND when missing");
    expect(tokens).toContain("err_not_found");
    expect(tokens).toContain("err");
    expect(tokens).toContain("found");
  });

  it("extracts and decomposes double-quoted string literal contents", () => {
    const tokens = tokenizeText('the field is "qualifiedSymbol" by default');
    expect(tokens).toContain("qualified");
    expect(tokens).toContain("symbol");
  });

  it("extracts and decomposes single-quoted string literal contents", () => {
    const tokens = tokenizeText("status is 'not-found' on miss");
    expect(tokens).toContain("not");
    expect(tokens).toContain("found");
  });

  it("tokenizes a test-case-shaped sentence into its component words", () => {
    const tokens = tokenizeText("should handle empty input gracefully");
    expect(tokens).toEqual(expect.arrayContaining(["should", "handle", "empty", "input", "gracefully"]));
  });

  it("filters common stop words out of decomposed parts by default", () => {
    const tokens = tokenizeText("the quick fix for the bug");
    expect(tokens).not.toContain("the");
    expect(tokens).not.toContain("for");
    expect(tokens).toContain("quick");
    expect(tokens).toContain("fix");
    expect(tokens).toContain("bug");
  });

  it("keeps stop words when keepStopWords is set", () => {
    const tokens = tokenizeText("the quick fix", { keepStopWords: true });
    expect(tokens).toContain("the");
  });
});

describe("tokenizeQuery — deduplicated query token set", () => {
  it("dedupes repeated tokens", () => {
    const tokens = tokenizeQuery("fix fix fix the bug bug");
    expect(tokens.filter((t) => t === "fix")).toHaveLength(1);
    expect(tokens.filter((t) => t === "bug")).toHaveLength(1);
  });

  it("decomposes an identifier inside the query", () => {
    const tokens = tokenizeQuery("investigate contentSufficiency regression");
    expect(tokens).toContain("content");
    expect(tokens).toContain("sufficiency");
  });
});

describe("normalizeQuery — V11-02 identifier / path / error-code decomposition", () => {
  it("allTokens is exactly tokenizeQuery's own output, for a variety of queries", () => {
    const queries = [
      "investigate contentSufficiency regression",
      "ERR_NOT_FOUND when missing",
      "src/routes/payments.ts",
      "how do I rotate an api key",
      "",
    ];
    for (const q of queries) {
      expect(normalizeQuery(q).allTokens).toEqual(tokenizeQuery(q));
    }
  });

  it("extracts a multi-segment path span as a whole pathToken, not sub-split", () => {
    const norm = normalizeQuery("look at src/routes/payments.ts for the answer");
    expect(norm.pathTokens).toContain("src/routes/payments.ts");
  });

  it("extracts a bare filename.ext span as a pathToken", () => {
    const norm = normalizeQuery("see CONTRACT.md for details");
    expect(norm.pathTokens).toContain("CONTRACT.md");
  });

  it("extracts an error-code span, lowercased, matching tokenizeText's own isErrorCodeToken handling", () => {
    const norm = normalizeQuery("raises ERR_NOT_FOUND when missing");
    expect(norm.errorCodeTokens).toContain("err_not_found");
  });

  it("does not classify a plain camelCase identifier as an error code", () => {
    const norm = normalizeQuery("investigate contentSufficiency regression");
    expect(norm.errorCodeTokens).toEqual([]);
  });

  it("identifierTokens excludes sub-tokens already claimed by a path span", () => {
    const norm = normalizeQuery("look at src/routes/payments.ts for the answer");
    expect(norm.identifierTokens).not.toContain("payments");
    expect(norm.identifierTokens).toContain("answer");
  });

  it("identifierTokens excludes an error-code token itself but keeps unrelated words", () => {
    const norm = normalizeQuery("raises ERR_NOT_FOUND when missing");
    expect(norm.identifierTokens).not.toContain("err_not_found");
    expect(norm.identifierTokens).toContain("missing");
  });

  it("a plain natural-language query with no path or error-code shape has empty pathTokens/errorCodeTokens", () => {
    const norm = normalizeQuery("how do I rotate an api key");
    expect(norm.pathTokens).toEqual([]);
    expect(norm.errorCodeTokens).toEqual([]);
  });

  it("an empty query normalizes to all-empty buckets without throwing", () => {
    const norm = normalizeQuery("");
    expect(norm).toEqual({
      identifierTokens: [],
      pathTokens: [],
      errorCodeTokens: [],
      allTokens: [],
      identifierSpans: [],
    });
  });

  it("pathTokens are deduplicated", () => {
    const norm = normalizeQuery("compare src/a.ts against src/a.ts again");
    expect(norm.pathTokens.filter((t) => t === "src/a.ts")).toHaveLength(1);
  });
});

describe("normalizeQuery — identifierSpans (wave C, F-A5 graph retriever lookup keys)", () => {
  it("extracts a camelCase identifier as one whole, case-preserved span", () => {
    const norm = normalizeQuery("rename reserveStock — which callers need updating");
    expect(norm.identifierSpans).toContain("reserveStock");
  });

  it("does not decompose the span the way identifierTokens does", () => {
    const norm = normalizeQuery("find every caller of sendOrderConfirmation before changing its signature");
    expect(norm.identifierSpans).toContain("sendOrderConfirmation");
    expect(norm.identifierSpans).not.toContain("send");
    expect(norm.identifierSpans).not.toContain("confirmation");
  });

  it("stops at a trailing apostrophe (possessive), keeping only the identifier", () => {
    const norm = normalizeQuery("if withRetry's signature changes, which functions calling it need updating");
    expect(norm.identifierSpans).toContain("withRetry");
    expect(norm.identifierSpans).not.toContain("withRetry's");
  });

  it("preserves case exactly — 'Foo' and 'foo' are distinct spans", () => {
    const norm = normalizeQuery("Foo calls foo internally");
    expect(norm.identifierSpans).toContain("Foo");
    expect(norm.identifierSpans).toContain("foo");
  });

  it("deduplicates a repeated span", () => {
    const norm = normalizeQuery("withdraw calls withdraw again in a retry loop");
    expect(norm.identifierSpans.filter((s) => s === "withdraw")).toHaveLength(1);
  });

  it("filters out single-character spans", () => {
    const norm = normalizeQuery("a b reserveStock");
    expect(norm.identifierSpans).not.toContain("a");
    expect(norm.identifierSpans).not.toContain("b");
    expect(norm.identifierSpans).toContain("reserveStock");
  });

  it("an empty query yields an empty identifierSpans array", () => {
    expect(normalizeQuery("").identifierSpans).toEqual([]);
  });

  it("a plain natural-language query with no identifier-shaped word still yields its plain words as spans (they are shape-only, not existence-checked)", () => {
    const norm = normalizeQuery("how do I rotate an api key");
    expect(norm.identifierSpans).toEqual(expect.arrayContaining(["how", "do", "rotate", "an", "api", "key"]));
  });
});
