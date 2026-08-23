import { describe, it, expect } from "vitest";
import { inferTaskFamily, MIN_CONFIDENCE } from "../taskFamily.js";

describe("inferTaskFamily — known-local", () => {
  it("an explicit scope path is a high-confidence known-local signal", () => {
    const result = inferTaskFamily({ query: "how does retry work", explicitPath: "src/utils/retry.ts" });
    expect(result.profile).toBe("known-local");
    expect(result.confidence).toBeGreaterThanOrEqual(MIN_CONFIDENCE);
    expect(result.signals).toContain("explicit-path-scope");
  });

  it("a query that IS a workspace-relative path (no explicit scope given) is known-local", () => {
    const result = inferTaskFamily({ query: "src/routes/payments.ts" });
    expect(result.profile).toBe("known-local");
    expect(result.signals).toContain("query-is-path-shaped");
  });

  it("a path MENTIONED inside a longer sentence does not trigger the high-confidence whole-query-is-a-path rule", () => {
    const result = inferTaskFamily({ query: "what does src/routes/payments.ts do" });
    expect(result.signals).not.toContain("query-is-path-shaped");
  });
});

describe("inferTaskFamily — failure-diagnosis", () => {
  it("an error-code-shaped token resolves to failure-diagnosis", () => {
    const result = inferTaskFamily({ query: "ERR_ORDER_NOT_FOUND" });
    expect(result.profile).toBe("failure-diagnosis");
    expect(result.signals).toContain("error-code-token");
  });

  it("a letter-prefixed numeric code resolves to failure-diagnosis", () => {
    const result = inferTaskFamily({ query: "what does E1234 mean" });
    expect(result.profile).toBe("failure-diagnosis");
  });

  it("a stack-frame-shaped query resolves to failure-diagnosis", () => {
    const result = inferTaskFamily({ query: "crash at src/routes/payments.ts:42" });
    expect(result.profile).toBe("failure-diagnosis");
    expect(result.signals).toContain("stack-frame-shape");
  });

  it("the word 'traceback' alone resolves to failure-diagnosis", () => {
    const result = inferTaskFamily({ query: "full traceback attached" });
    expect(result.profile).toBe("failure-diagnosis");
  });
});

describe("inferTaskFamily — cross-document", () => {
  it("candidate paths dominated by document extensions resolve to cross-document", () => {
    const result = inferTaskFamily({
      query: "how do refunds work",
      candidatePaths: ["docs/billing/refunds.md", "docs/billing/overview.md", "src/util.ts"],
    });
    expect(result.profile).toBe("cross-document");
    expect(result.signals).toContain("doc-extension-candidates");
  });

  it("a query mentioning a doc-shaped filename resolves to cross-document even with no candidatePaths", () => {
    const result = inferTaskFamily({ query: "see CONTRACT.md for details" });
    expect(result.profile).toBe("cross-document");
    expect(result.signals).toContain("doc-extension-query-token");
  });

  it("candidate paths that are mostly code do NOT trigger cross-document via the candidates rule", () => {
    const result = inferTaskFamily({
      query: "how does this work",
      candidatePaths: ["src/a.ts", "src/b.ts", "src/c.ts", "docs/one.md"],
    });
    expect(result.signals).not.toContain("doc-extension-candidates");
  });
});

describe("inferTaskFamily — change-propagation", () => {
  it("a rename/impact keyword combined with a known symbol is a higher-confidence change-propagation signal", () => {
    const result = inferTaskFamily({ query: "rename reserveStock — which callers need updating", symbol: "reserveStock" });
    expect(result.profile).toBe("change-propagation");
    expect(result.signals).toContain("rename-impact-keyword-with-symbol");
  });

  it("a rename/impact keyword alone (no symbol) still resolves to change-propagation", () => {
    const result = inferTaskFamily({ query: "find every caller of sendOrderConfirmation" });
    expect(result.profile).toBe("change-propagation");
    expect(result.signals).toContain("rename-impact-keyword");
  });
});

describe("inferTaskFamily — cross-package", () => {
  it("candidate paths spanning two or more top-level package directories resolve to cross-package", () => {
    const result = inferTaskFamily({
      query: "how does a withdrawal get recorded",
      candidatePaths: ["pkg/account/account.go", "pkg/ledger/ledger.go"],
    });
    expect(result.profile).toBe("cross-package");
    expect(result.signals).toContain("multi-package-candidates");
  });

  it("candidate paths confined to a single top-level package do not trigger cross-package", () => {
    const result = inferTaskFamily({
      query: "how does withdraw work",
      candidatePaths: ["pkg/account/account.go", "pkg/account/errors.go"],
    });
    expect(result.profile).not.toBe("cross-package");
  });
});

describe("inferTaskFamily — navigation", () => {
  it("a known exact symbol with no stronger signal resolves to navigation", () => {
    const result = inferTaskFamily({ query: "chargeCard", symbol: "chargeCard" });
    expect(result.profile).toBe("navigation");
    expect(result.signals).toContain("exact-symbol-known");
  });
});

describe("inferTaskFamily — read-only", () => {
  it("explanation-phrased queries with no known symbol resolve to read-only", () => {
    const result = inferTaskFamily({ query: "what statuses can an order have" });
    expect(result.profile).toBe("read-only");
    expect(result.signals).toContain("explanation-phrasing");
  });

  it("explanation phrasing is suppressed when a symbol IS known (navigation takes precedence)", () => {
    const result = inferTaskFamily({ query: "what does chargeCard do", symbol: "chargeCard" });
    expect(result.profile).not.toBe("read-only");
  });
});

describe("inferTaskFamily — general fallback and confidence discipline", () => {
  it("a query with no structural signal at all folds to general, confidence 0, empty signals", () => {
    const result = inferTaskFamily({ query: "reserve stock for a new order" });
    expect(result.profile).toBe("general");
    expect(result.confidence).toBe(0);
    expect(result.signals).toEqual([]);
  });

  it("every accepted (non-general) result meets the documented MIN_CONFIDENCE floor", () => {
    const queries = [
      { query: "src/routes/payments.ts" },
      { query: "ERR_ORDER_NOT_FOUND" },
      { query: "see CONTRACT.md for details" },
      { query: "find every caller of X" },
      { query: "chargeCard", symbol: "chargeCard" },
      { query: "what statuses can an order have" },
    ];
    for (const q of queries) {
      const result = inferTaskFamily(q);
      if (result.profile !== "general") {
        expect(result.confidence, JSON.stringify(q)).toBeGreaterThanOrEqual(MIN_CONFIDENCE);
      }
    }
  });

  it("MIN_CONFIDENCE is the documented 0.6 floor", () => {
    expect(MIN_CONFIDENCE).toBe(0.6);
  });
});

describe("inferTaskFamily — misclassification safety (precedence, never a crash)", () => {
  it("when multiple rules fire, the HIGHEST-confidence one wins deterministically — explicit path beats a mere symbol", () => {
    const result = inferTaskFamily({ query: "chargeCard", symbol: "chargeCard", explicitPath: "src/routes/payments.ts" });
    expect(result.profile).toBe("known-local");
  });

  it("never throws on empty or degenerate input", () => {
    expect(() => inferTaskFamily({ query: "" })).not.toThrow();
    expect(() => inferTaskFamily({ query: "   " })).not.toThrow();
    expect(inferTaskFamily({ query: "" }).profile).toBe("general");
  });

  it("is a pure function: the same input always produces the same output", () => {
    const input = { query: "rename chargeCard", symbol: "chargeCard" };
    const a = inferTaskFamily(input);
    const b = inferTaskFamily(input);
    expect(a).toEqual(b);
  });
});

describe("inferTaskFamily — cross-package heuristic does not over-trigger on a flat single directory", () => {
  it("multiple files in the SAME flat directory (no package subdirectory) do not trigger cross-package", () => {
    const result = inferTaskFamily({
      query: "reserve stock for a new order",
      candidatePaths: ["src/exact.ts", "src/util.ts", "src/ref.ts", "src/nonfloor.ts"],
    });
    expect(result.profile).not.toBe("cross-package");
  });

  it("a real nested-subdirectory package boundary (top/package/file) still counts", () => {
    const result = inferTaskFamily({
      query: "how does this flow work",
      candidatePaths: ["packages/foo/src/index.ts", "packages/bar/src/index.ts"],
    });
    expect(result.profile).toBe("cross-package");
  });
});
