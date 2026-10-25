import { describe, expect, it } from "vitest";
import { bridgeJaQuery, buildJaBridgeVocabulary, unresolvedKatakanaRuns } from "../jaQueryBridge.js";

const tokens = (query: string, words: string[]) =>
  bridgeJaQuery(query, buildJaBridgeVocabulary(words)).expansions.flatMap((entry) => entry.tokens);

describe("reserved-language loanwords", () => {
  it("does not turn the class keyword into a workspace homophone", () => {
    expect(tokens("クラス", ["queries"])).toEqual([]);
    expect(tokens("クラス", ["class", "queries"])).toEqual([]);
    expect(tokens("クラス", ["classify", "classes", "queries"])).toEqual([]);
  });

  it("does not re-admit reserved stems through the whole-query glossary", () => {
    expect(tokens("クラスとモジュール", ["classify", "classes", "modules"])).toEqual([]);
    expect(tokens("クラスの状態", ["classify", "state"])).toEqual(["state"]);
  });

  it("retains observed compounds without reviving a keyword homophone", () => {
    expect(tokens("クラスルーム", ["classroom", "room", "queries"])).toEqual(["classroom"]);
    expect(tokens("ルームクラス", ["roomclass", "room", "queries"])).toEqual(["roomclass"]);
    expect(tokens("クラスキャッシュ", ["classcache", "cache", "queries"])).toEqual(["classcache", "cache"]);
    expect(tokens("クラスメール", ["classemail", "mail", "email"])).toEqual(["classemail", "mail", "email"]);
    expect(tokens("クラスキャッシュ", ["queriescache", "cache", "queries"])).toEqual(["cache"]);
  });

  it("retains explicit semantic glossary prefixes outside keyword loanwords", () => {
    expect(tokens("返品", ["returns"])).toEqual(["return"]);
    expect(tokens("非公開", ["privateFields"])).toEqual(["private"]);
    expect(tokens("既定", ["defaults"])).toEqual(["default"]);
    expect(tokens("クラスと返品", ["classify", "returns"])).toEqual(["return"]);
  });

  it("does not send recognized ignored keywords to the unresolved fallback", () => {
    const vocab = buildJaBridgeVocabulary(["queries", "classify"]);
    expect(unresolvedKatakanaRuns("クラス", vocab)).toEqual([]);
    expect(unresolvedKatakanaRuns("クラスモジュール", vocab)).toEqual([]);
    expect(unresolvedKatakanaRuns("クラスキャッシュ", vocab)).toEqual(["クラスキャッシュ"]);
  });

  it("keeps a useful compound neighbour without inventing a class homophone", () => {
    expect(tokens("クラスキャッシュ", ["queries", "cache"])).toEqual(["cache"]);
  });

  it("retains real query and non-keyword loanword recovery", () => {
    expect(tokens("クエリ", ["query"])).toContain("query");
    expect(tokens("クーポン", ["coupon"])).toContain("coupon");
    expect(tokens("キャンセル", ["cancel"])).toContain("cancel");
  });

  it("keeps useful words in prose and preserves explicit identifiers", () => {
    expect(tokens("InventoryEngine クラスのキャンセル処理", ["queries", "cancel"])).toEqual(["cancel"]);
    expect(tokens("queries の動作", ["queries"])).toEqual([]);
  });
});
