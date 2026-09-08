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

// field-report fix, 2026-09-08: a discovery-fallback task_pack fed a
// mangled hiragana fragment ("きたときの", out of "エラーが起きたときの
// リトライ処理を説明してください") straight into a `search_files find`
// `queries` item — a token that can never match anything, wasting the
// whole call. Root cause: extractCjkTokens's whole-hiragana-run token
// (correct for cjkSpans.ts's OTHER consumer, BM25F content indexing, where
// IDF suppresses a common term — see cjkSpans.ts's own comment) has no
// query-tokenizer analog: a query-token pipeline can afford to just never
// emit hiragana at all. See extractCjkQueryTokens's own comment in
// util/queryShape.ts for the full rule set this suite pins.
const isHiraganaOnlyToken = (t: string): boolean => /^[぀-ゟ]+$/u.test(t);

describe("tokenizeQuery mode:\"identifier\" — CJK verb/particle stripping (field-report fix, 2026-09-08)", () => {
  it("エラーが起きたときのリトライ処理を説明してください — exactly the three useful tokens, no hiragana fragment", () => {
    const tokens = identifierMode("エラーが起きたときのリトライ処理を説明してください");
    expect(tokens.some(isHiraganaOnlyToken)).toBe(false);
    expect(tokens).not.toContain("きたときの");
    // 起 (single kanji, followed by hiragana not katakana) and 説明 (a
    // 説明する "explain" verb stem — the sentence's own instruction verb,
    // immediately followed by してください) are both correctly dropped,
    // leaving exactly these three. Unordered: identifier mode re-sorts by
    // scoreTokenDistinctiveness (here, pure length, since none of the three
    // gets an ASCII-shaped bonus) — a pre-existing behavior of this mode,
    // unrelated to this fix; see the "simple" mode sibling test below for
    // the first-appearance order extractCjkQueryTokens itself produces.
    expect(tokens).toHaveLength(3);
    expect(tokens).toEqual(expect.arrayContaining(["エラー", "リトライ", "処理"]));
  });

  it("Cache.get の有効期限判定を修正してください — dotted Latin identifier survives, no hiragana fragment, the sentence's own verb stem is dropped", () => {
    const tokens = identifierMode("Cache.get の有効期限判定を修正してください");
    expect(tokens.some(isHiraganaOnlyToken)).toBe(false);
    expect(tokens).toContain("Cache.get");
    // 修正 ("fix") is this sentence's instruction verb (修正してください),
    // dropped the same way 説明 is above — never surfaced as its own term.
    expect(tokens).not.toContain("修正");
    // The kanji-run rule itself is unchanged by this fix (still one greedy
    // Han run, no internal splitting) — assert on the resulting shape
    // either way rather than pinning one arbitrarily.
    const fused = tokens.includes("有効期限判定");
    const split = tokens.includes("有効期限") && tokens.includes("判定");
    expect(fused || split).toBe(true);
  });

  it("a single kanji immediately followed by a katakana run still survives (regression guard on the length-1 Han exception)", () => {
    const tokens = identifierMode("語ヘルパーの実装");
    expect(tokens).toContain("語");
    expect(tokens).toContain("ヘルパー");
    expect(tokens).toContain("実装");
    expect(tokens.some(isHiraganaOnlyToken)).toBe(false);
  });
});

describe("tokenizeQuery mode:\"simple\" — CJK verb/particle stripping (field-report fix, 2026-09-08)", () => {
  it("エラーが起きたときのリトライ処理を説明してください — exactly the three useful tokens, first-appearance order preserved, no hiragana fragment", () => {
    const tokens = simpleMode("エラーが起きたときのリトライ処理を説明してください");
    expect(tokens.some(isHiraganaOnlyToken)).toBe(false);
    expect(tokens).not.toContain("きたときの");
    // Unlike "identifier" mode (no distinctiveness sort here), this mode
    // preserves first-appearance order, matching the fix's own spec.
    expect(tokens).toEqual(["エラー", "リトライ", "処理"]);
  });

  it("Cache.get の有効期限判定を修正してください — dotted Latin identifier survives even though this mode lowercases its own ASCII pass", () => {
    const tokens = simpleMode("Cache.get の有効期限判定を修正してください");
    expect(tokens.some(isHiraganaOnlyToken)).toBe(false);
    expect(tokens).toContain("Cache.get");
    expect(tokens).not.toContain("修正");
  });
});
