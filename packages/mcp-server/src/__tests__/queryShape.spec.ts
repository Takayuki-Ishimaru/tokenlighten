// queryShape.spec.ts — field-report fix (2026-08-27): util/queryShape.ts's
// own tokenizeQuery (identifier/simple modes) was an INDEPENDENT, separately
// ASCII-only tokenizer from retrieval/tokenize.ts's own tokenizeQuery (same
// name, unrelated implementation). It feeds readCodeTaskPack.ts's
// significantQueryTokens/concernAnchorTokens route-honesty check and
// findText.ts's own find fallback. Both modes now also extract CJK
// (Han/Hiragana/Katakana) spans via the shared util/cjkSpans.ts helper — see
// tokenizeIdentifierMode/tokenizeSimpleMode's own comments for the design.
//
// This suite only exercises the TOKENIZER itself (tokenizeQuery), never its
// consumers (significantQueryTokens/concernAnchorTokens live in
// readCodeTaskPack.ts, a sibling's file; findText.ts is also a sibling's
// file) — exactly the boundary the coordinator drew.

import { describe, it, expect } from "vitest";
import { tokenizeQuery } from "../util/queryShape.js";

const IDENTIFIER_STOP_WORDS = new Set(["the", "and", "for", "with"]);
const SIMPLE_STOP_WORDS = new Set(["the", "and", "for", "with"]);

function identifierMode(query: string, minLen = 4): string[] {
  return tokenizeQuery(query, { mode: "identifier", minLen, stopWords: IDENTIFIER_STOP_WORDS });
}

function simpleMode(query: string, minLen = 4): string[] {
  return tokenizeQuery(query, { mode: "simple", minLen, stopWords: SIMPLE_STOP_WORDS });
}

describe("tokenizeQuery mode:\"identifier\" — CJK-aware", () => {
  it("a pure Japanese query, previously tokenized to nothing, now yields tokens", () => {
    const tokens = identifierMode("テレメトリの健全性状態を取得している処理はどこですか");
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens).toContain("テレメトリ");
    expect(tokens).toContain("健全性状態");
  });

  it("CJK tokens bypass minLen — a 2-char Han compound survives even at minLen 4", () => {
    const tokens = identifierMode("処理の設定を確認したい", 4);
    expect(tokens).toContain("処理");
  });

  it("a mixed Japanese/English query keeps its ASCII identifier AND its CJK tokens — no longer collapses to identifier-only signal", () => {
    const tokens = identifierMode("reserveStockLevel の在庫更新でテレメトリの健全性状態を確認したい");
    expect(tokens).toContain("reserveStockLevel");
    expect(tokens).toContain("reserve");
    expect(tokens).toContain("テレメトリ");
    expect(tokens).toContain("健全性状態");
  });

  it("filters a Japanese stopword the same way tokenizeText's shared helper does", () => {
    const tokens = identifierMode("確認する");
    expect(tokens).not.toContain("する");
  });

  it("dedupes a repeated CJK token", () => {
    const tokens = identifierMode("状態 状態 状態");
    expect(tokens.filter((t) => t === "状態")).toHaveLength(1);
  });

  it("ASCII-only input is byte-identical to the pre-CJK tokenizer output", () => {
    const tokens = identifierMode("investigate the contentSufficiency regression");
    // Pre-fix behavior for this exact input/options, pinned as a literal:
    // quoted-phrase pass finds nothing; word pass adds "investigate" ("the"
    // is 3 chars, below minLen 4, so it never even reaches the stopWords
    // check), "contentSufficiency" plus its camelCase split
    // "content"/"Sufficiency", and "regression".
    expect(tokens).toEqual(
      expect.arrayContaining(["investigate", "contentSufficiency", "content", "Sufficiency", "regression"]),
    );
    expect(tokens).toHaveLength(5);
    expect(tokens).not.toContain("the");
    // No CJK contamination of an ASCII-only query.
    expect(tokens.some((t) => /[^\x00-\x7f]/u.test(t))).toBe(false);
  });
});

describe("tokenizeQuery mode:\"simple\" — CJK-aware", () => {
  it("a pure Japanese query, previously tokenized to nothing (every CJK char treated as a separator), now yields tokens", () => {
    const tokens = simpleMode("テレメトリの健全性状態を取得している処理はどこですか");
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens).toContain("テレメトリ");
    expect(tokens).toContain("健全性状態");
  });

  it("CJK tokens bypass minLen — a 2-char Han compound survives even at minLen 4", () => {
    const tokens = simpleMode("処理の設定を確認したい", 4);
    expect(tokens).toContain("処理");
  });

  it("filters a Japanese stopword the same way tokenizeText's shared helper does", () => {
    const tokens = simpleMode("確認する");
    expect(tokens).not.toContain("する");
  });

  it("a mixed Japanese/English query keeps its ASCII token AND its CJK tokens", () => {
    const tokens = simpleMode("reserveStockLevel の在庫更新でテレメトリの健全性状態を確認したい");
    expect(tokens).toContain("reservestocklevel");
    expect(tokens).toContain("テレメトリ");
    expect(tokens).toContain("健全性状態");
  });

  it("ASCII-only input is byte-identical to the pre-CJK tokenizer output", () => {
    const tokens = simpleMode("investigate the contentSufficiency regression");
    // Pre-fix: lowercase + split on non-[a-z0-9] -> ["investigate","the",
    // "contentsufficiency","regression"], then minLen/stopWords filter
    // drops "the" -> the rest survive verbatim, deduped, in order.
    expect(tokens).toEqual(["investigate", "contentsufficiency", "regression"]);
  });
});
