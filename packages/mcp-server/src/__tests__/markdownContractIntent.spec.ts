import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { markdownContractIntent } from "../features/locator/locateTaskContext.js";

describe("markdown contract intent path spellings", () => {
  it("recognizes quoted, backtick, punctuated, and Japanese-suffixed Markdown paths", () => {
    for (const query of [
      "`docs/CONTRACT.md`を確認",
      "\"docs/CONTRACT.md\",",
      "「docs/CONTRACT.md」。",
      "docs/CONTRACT.mdについて",
    ]) expect(markdownContractIntent(query), query).toBe(true);
  });

  it("keeps a concrete multi-term document section query discoverable without a document noun", () => {
    expect(markdownContractIntent("quorum retry budget operational limits")).toBe(true);
  });

  // FX-M6 (2026-09-03): `markdownContractIntent`'s exploratory-word
  // discrimination is gated behind `semanticFrontierGuardEnabled() ||
  // sfStructuralConcernsEnabled()` (locateTaskContext.ts) — the same
  // either-lever pattern `annotateSemanticFrontierContinuation`
  // (semanticFrontier.ts) uses. TL_SEMANTIC_FRONTIER_GUARD defaulted ON
  // when this function was introduced (b44ab01e) but was later flipped OFF
  // by default (2b406d62), so this test now has to opt back into the gate
  // explicitly to exercise the logic it was written to test, rather than
  // observing the flag-off early return's unconditional `true`.
  // TL_SF_STRUCTURAL_CONCERNS requires TL_SF_STATEFUL
  // (assertSemanticFrontierV2FlagConsistency enforces this at server boot,
  // not per-call, but both are set here to reflect the shipped-valid
  // configuration), so both env vars are set together and restored after.
  describe("with the semantic-frontier discrimination gate open", () => {
    let previousStateful: string | undefined;
    let previousStructural: string | undefined;

    beforeEach(() => {
      previousStateful = process.env["TL_SF_STATEFUL"];
      previousStructural = process.env["TL_SF_STRUCTURAL_CONCERNS"];
      process.env["TL_SF_STATEFUL"] = "1";
      process.env["TL_SF_STRUCTURAL_CONCERNS"] = "1";
    });

    afterEach(() => {
      if (previousStateful === undefined) delete process.env["TL_SF_STATEFUL"];
      else process.env["TL_SF_STATEFUL"] = previousStateful;
      if (previousStructural === undefined) delete process.env["TL_SF_STRUCTURAL_CONCERNS"];
      else process.env["TL_SF_STRUCTURAL_CONCERNS"] = previousStructural;
    });

    it("does not treat a natural-language exploration request as a document lookup", () => {
      expect(markdownContractIntent("inspect candidate ranking threshold continuation")).toBe(false);
    });
  });
});
