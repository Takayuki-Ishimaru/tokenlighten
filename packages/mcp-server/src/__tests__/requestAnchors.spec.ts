/**
 * requestAnchors.spec.ts — the anchors a request names explicitly
 * (2026-10-29 first-hop field report): dotted members such as `res.redirect`,
 * quoted or bracketed literals such as `[default: (unlimited)]`, and
 * code-shaped identifiers. The first hop searches these before anything else.
 */

import { describe, it, expect } from "vitest";

import { extractRequestAnchors } from "../features/task-pack/requestAnchors.js";

const chainsOf = (query: string): string[] => extractRequestAnchors(query).chains.map((c) => c.raw);

describe("extractRequestAnchors — dotted member chains", () => {
  it("finds a chain between Japanese words", () => {
    const anchors = extractRequestAnchors("express の res.redirect がどう動くか説明して");
    expect(anchors.chains).toEqual([{ raw: "res.redirect", owner: "res", member: "redirect" }]);
    expect(anchors.identifiers).toContain("res.redirect");
    expect(anchors.literals).toEqual([]);
  });

  it("strips sentence punctuation and keeps each chain once, in order", () => {
    expect(chainsOf("How does req.accepts work?")).toEqual(["req.accepts"]);
    expect(chainsOf("Call res.send. Then res.send again, then app.listen!")).toEqual(["res.send", "app.listen"]);
    expect(chainsOf("What is the difference between Context.invoke and Context.forward?"))
      .toEqual(["Context.invoke", "Context.forward"]);
    expect(chainsOf("click の Context.invoke と Context.forward の違い")).toEqual(["Context.invoke", "Context.forward"]);
  });

  it("splits a multi-segment chain at its last dot", () => {
    expect(extractRequestAnchors("Where is Foo.prototype.bar defined?").chains)
      .toEqual([{ raw: "Foo.prototype.bar", owner: "Foo.prototype", member: "bar" }]);
    expect(extractRequestAnchors("How does click.Choice validate values?").chains)
      .toEqual([{ raw: "click.Choice", owner: "click", member: "Choice" }]);
  });

  it("ignores file names, paths, URLs, domains, versions and abbreviations", () => {
    expect(chainsOf("Update lib/response.js and README.md, then src/click/core.py")).toEqual([]);
    expect(chainsOf("Is it in response.js or package.json or setup.cfg?")).toEqual([]);
    expect(chainsOf("see https://example.com/docs/api.html and expressjs.com or www.npmjs.org")).toEqual([]);
    expect(chainsOf("bump version 5.2.1 and v0.16.3")).toEqual([]);
    expect(chainsOf("e.g. this, i.e. that, etc. and so on")).toEqual([]);
    expect(chainsOf("It runs on Node.js, not Vue.js")).toEqual([]);
    expect(chainsOf("C:\\repo\\lib\\response.js")).toEqual([]);
  });

  it("reads a chain inside backticks", () => {
    const anchors = extractRequestAnchors("use `app.listen` instead");
    expect(anchors.chains.map((c) => c.raw)).toEqual(["app.listen"]);
    expect(anchors.literals).toEqual([]);
  });
});

describe("extractRequestAnchors — literals", () => {
  it("keeps double-quoted and Japanese-bracketed spans", () => {
    expect(extractRequestAnchors('Where does the "Redirecting to" message come from?').literals).toEqual(["Redirecting to"]);
    expect(extractRequestAnchors("「設定ファイル」の読み込み処理と『既定値』").literals).toEqual(["設定ファイル", "既定値"]);
  });

  it("keeps a single-quoted span but not an apostrophe", () => {
    expect(extractRequestAnchors("How is show_default rendered in an option's help text?").literals).toEqual([]);
    expect(extractRequestAnchors("It prints 'no such option' and exits; don't change it").literals).toEqual(["no such option"]);
  });

  it("keeps a bracketed code-like span whole, bare or backticked", () => {
    const bare = extractRequestAnchors("Fix the help text [default: (unlimited)] shown for count options");
    expect(bare.literals).toEqual(["[default: (unlimited)]"]);
    const ticked = extractRequestAnchors("options with show_default=True and count show `[default: (unlimited)]`");
    expect(ticked.literals).toEqual(["[default: (unlimited)]"]);
    expect(ticked.identifiers).toContain("show_default");
  });

  it("treats a backticked non-identifier span as a literal", () => {
    expect(extractRequestAnchors("what does `--help` print").literals).toEqual(["--help"]);
  });

  it("ignores prose parentheses, markdown links and plain bracketed words", () => {
    expect(extractRequestAnchors("Explain the flow (see above) in detail").literals).toEqual([]);
    expect(extractRequestAnchors("Read [the docs](http://x.test/a) first").literals).toEqual([]);
    expect(extractRequestAnchors("Fix the [TODO] item").literals).toEqual([]);
    expect(extractRequestAnchors("click で値の解決順（コマンドライン、環境変数、default）はどう決まる？").literals).toEqual([]);
  });
});

describe("extractRequestAnchors — identifiers", () => {
  it("keeps snake_case, CONST_CASE, camelCase, $-names and backticked names", () => {
    expect(extractRequestAnchors("How is show_default rendered?").identifiers).toEqual(["show_default"]);
    expect(extractRequestAnchors("Explain the MODEL_PRICES table").identifiers).toEqual(["MODEL_PRICES"]);
    expect(extractRequestAnchors("Where is getHelpExtra called?").identifiers).toEqual(["getHelpExtra"]);
    expect(extractRequestAnchors("What does $scope hold?").identifiers).toEqual(["$scope"]);
    expect(extractRequestAnchors("What does `prompt` return?").identifiers).toEqual(["prompt"]);
  });

  it("does not treat ordinary words, capitalised sentence starts or Japanese as identifiers", () => {
    expect(extractRequestAnchors("How does the parser handle errors?").identifiers).toEqual([]);
    expect(extractRequestAnchors("Explain the Context object").identifiers).toEqual([]);
    expect(extractRequestAnchors("値の解決順はどう決まる？").identifiers).toEqual([]);
  });

  it("lists identifiers and chains once each, in order of first appearance", () => {
    const anchors = extractRequestAnchors("does res.cookie use sign_cookie and res.cookie again?");
    expect(anchors.identifiers).toEqual(["res.cookie", "sign_cookie"]);
  });

  it("keeps a name that ends a sentence and orders chains among names by position", () => {
    expect(extractRequestAnchors("The help text is rendered by show_default.").identifiers).toEqual(["show_default"]);
    expect(extractRequestAnchors("Does sign_cookie run before res.cookie?").identifiers).toEqual(["sign_cookie", "res.cookie"]);
  });

  it("orders a chain where it appears as a chain, not where a longer chain or a literal contains its text", () => {
    expect(extractRequestAnchors("total = b.Debit.Sub(b.Credit) or b.Credit.Sub(b.Debit)").identifiers)
      .toEqual(["b.Debit.Sub", "b.Credit", "b.Credit.Sub", "b.Debit"]);
    expect(extractRequestAnchors("returned 'act.answer' although profile_binding.selected; why act.answer?").identifiers)
      .toEqual(["profile_binding.selected", "act.answer"]);
  });

  it("does not treat a bare underscore as an identifier, but keeps a leading-underscore name", () => {
    expect(extractRequestAnchors("rename _ to x").identifiers).toEqual([]);
    expect(extractRequestAnchors("what does _private_helper do").identifiers).toEqual(["_private_helper"]);
  });

  it("returns empty anchors for an empty or whitespace query", () => {
    expect(extractRequestAnchors("")).toEqual({ chains: [], literals: [], identifiers: [] });
    expect(extractRequestAnchors("   \n ")).toEqual({ chains: [], literals: [], identifiers: [] });
  });

  // Each shape cost time quadratic in its length before 2026-10-30 (up to 3.5 s for a 40 KB
  // dot-less word, a pasted blob in a request); now each takes a few milliseconds.
  it.each([
    ["mixed", "a.b ".repeat(5000) + "x".repeat(20000) + " [" + "y".repeat(5000)],
    ["one dot-less word", "x".repeat(40000)],
    ["letters and digits", "a1".repeat(20000)],
    ["many backticked literals", Array.from({ length: 5000 }, (_, i) => "`lit " + i + "` ").join("")],
    ["many distinct chains", Array.from({ length: 5000 }, (_, i) => "o" + i + ".m ").join("")],
    ["literals between chains", Array.from({ length: 3000 }, (_, i) => "\"q" + i + "\" o" + i + ".m ").join("")],
  ])("stays fast on a long input (%s)", (_shape, query) => {
    const started = Date.now();
    extractRequestAnchors(query);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("finds every chain and literal of a long input", () => {
    const anchors = extractRequestAnchors(Array.from({ length: 3000 }, (_, i) => "\"q" + i + "\" o" + i + ".m ").join(""));
    expect(anchors.literals).toHaveLength(3000);
    expect(anchors.chains).toHaveLength(3000);
    expect(anchors.chains[2999]).toEqual({ raw: "o2999.m", owner: "o2999", member: "m" });
    expect(anchors.identifiers.slice(0, 2)).toEqual(["o0.m", "o1.m"]);
  });
});
