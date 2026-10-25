import {describe, expect, it} from "vitest";
import {goReturnedLocalFacts, goReturnedLocalReview, bindGoReviewOrigin, type GoReturnedLocalSource} from "../goReturnedLocalReview.js";
import {projectEvidence} from "../protocol/decisionWire.js";

const T07_COMPUTE = [
  "package balance",
  "",
  "import (",
  "\t\"fmt\"",
  "\t\"time\"",
  "",
  "\t\"github.com/ledgerd/ledger/pkg/account\"",
  "\t\"github.com/ledgerd/ledger/pkg/money\"",
  "\t\"github.com/ledgerd/ledger/pkg/posting\"",
  ")",
  "",
  "// Compute walks the slice of postings and produces a Balance for acct as of",
  "// the given time. Only postings that belong to acct.ID are expected in ps;",
  "// the caller is responsible for filtering. Postings with zero amounts are",
  "// accepted (they contribute nothing to the totals).",
  "//",
  "// An empty ps slice returns a zero Balance (all fields zero-valued for the",
  "// account's currency). Currency mismatch across postings (or between a",
  "// posting and the account currency) returns ErrCurrencyMismatch.",
  "func Compute(acct account.Account, ps []posting.Posting, asOf time.Time) (Balance, error) {",
  "\t// posting.Side(DebitSide) is the universal sign convention used for Apply",
  "\t// regardless of the account's NormalSide — Apply itself flips internally.",
  "\tnormalSide := posting.Side(account.DebitNormal)",
  "",
  "\tb := Balance{",
  "\t\tAccountID: acct.ID,",
  "\t\tCurrency:  acct.Currency,",
  "\t\tDebit:     money.Zero(acct.Currency),",
  "\t\tCredit:    money.Zero(acct.Currency),",
  "\t\tNet:       money.Zero(acct.Currency),",
  "\t\tAsOf:      asOf,",
  "\t}",
  "",
  "\tfor i, p := range ps {",
  "\t\tif err := b.Apply(p, normalSide); err != nil {",
  "\t\t\treturn Balance{}, fmt.Errorf(\"compute balance for account %s, posting %d: %w\", acct.ID, i, err)",
  "\t\t}",
  "\t}",
  "",
  "\tvar err error",
  "\tb.Net, err = b.Debit.Sub(b.Credit)",
  "\tif err != nil {",
  "\t\treturn Balance{}, fmt.Errorf(\"compute net for account %s: %w\", acct.ID, err)",
  "\t}",
  "",
  "\treturn b, nil",
  "}"
].join("\n");
const BODY = [
  "func Build() (Result, error) {", "  out := Result{}",
  "  if err := out.Apply(); err != nil { return Result{}, err }", "  var err error",
  "  out.Score, err = left.Minus(right)", "  if err != nil { return Result{}, err }",
  "  return out, nil", "}",
].join("\n");
function input(body = BODY, overrides: Partial<GoReturnedLocalSource> = {}): GoReturnedLocalSource {
  return {path: "pkg/sample/build.go", startLine: 101,
    endLine: 100 + body.replace(/\r\n/g, "\n").replace(/\n$/u, "").split("\n").length,
    body, fresh: true, complete: true, ...overrides};
}
describe("Go returned-local source review", () => {
  it("cites a receiver call, later write and final returned local without changing source", async () => {
    const source = Object.freeze(input()), before = {...source};
    const result = await goReturnedLocalReview(source);
    // 2026-10-22 (codex-copilot-proxy r18 T07): a write that cannot read what the call set is stated as the dataflow fact.
    expect(result).toBe("pkg/sample/build.go: return out L107 returns the out.Score assigned at L105 (out.Score, err = left.Minus(right)), not one set by out.Apply() L103.");
    expect(result).not.toContain("out.Apply() sets");
    expect(Buffer.byteLength(result!, "utf8")).toBeLessThanOrEqual(200);
    expect(source).toEqual(before);
  });
  it("states the actual T07 direct assignment and error return as a source-order fact", async () => {
    const result = await goReturnedLocalReview(input(T07_COMPUTE, {path: "pkg/balance/compute.go", startLine: 1, endLine: 47}));
    expect(result).toBe("pkg/balance/compute.go: return b L46 returns the b.Net assigned at L41 (b.Net, err = b.Debit.Sub(b.Credit)), not one set by b.Apply(p, normalSide) L35.");
    // The pinned byte count is that of the fact, which stays within the 200-byte frame the instruction used.
    expect(Buffer.byteLength(result!, "utf8")).toBe(151);
    expect(result).not.toMatch(/bug|must fix|incorrect|defect|review|before the first edit/i);
  });
  it("keeps the instruction wording when the final write reads the field the call set or asks the local for it", async () => {
    for (const [write, expected] of [
      ["out.Score, err = adjust(out.Score)", "pkg/sample/build.go: out.Apply() L103 precedes the final direct assignment to out.Score L105; return out L107 follows it. Review both sites before the first edit."],
      ["out.Score, err = out.Recompute()", "pkg/sample/build.go: out.Apply() L103 precedes the final direct assignment to out.Score L105; return out L107 follows it. Review both sites before the first edit."],
    ] as const) {
      const body = BODY.replace("out.Score, err = left.Minus(right)", write);
      const result = await goReturnedLocalReview(input(body));
      expect(result, write).toBe(expected);
      expect(Buffer.byteLength(result!, "utf8")).toBeLessThanOrEqual(200);
      const facts = await goReturnedLocalFacts(input(body));
      expect(facts, write).toMatchObject({form: "strong", discardSafe: false, text: expected});
    }
  });
  it("reads other fields of the local, or a call on another value, as discard-safe", async () => {
    for (const write of ["out.Score, err = out.Base.Sub(out.Adj)", "out.Score, err = helper(out.Base, left)", "out.Score, err = left.Minus(right)"]) {
      const facts = await goReturnedLocalFacts(input(BODY.replace("out.Score, err = left.Minus(right)", write)));
      expect(facts, write).toMatchObject({form: "strong", discardSafe: true});
      expect(facts!.text, write).toBe("pkg/sample/build.go: return out L107 returns the out.Score assigned at L105 (" + write + "), not one set by out.Apply() L103.");
    }
  });
  // Go orders no variable read against a call inside one return statement, and gc runs the call first: with
  // `return out, out.Finalize()` the value returned may not be the one assigned, whatever Finalize touches
  // (go run: Finalize sets Score to 99 after the assignment of 7, and 99 comes back).
  it.each([
    "out.Finalize()", "out.Score.Validate()", "(out.Score).Validate()", "out.Items[0].Close()",
    "out.Score.Minor.Check()", "wrap(out.Score.Validate())",
  ])("does not say what the return reads when the return itself calls through the local: return out, %s", async call => {
    const body = BODY.replace("  return out, nil", "  return out, " + call);
    const result = await goReturnedLocalReview(input(body));
    expect(result).toBe("pkg/sample/build.go: out.Apply() L103; later assignment out.Score, err = left.Minus(right) L105; return out L107. Check both sites against task intent; batch fixes.");
    expect(result).not.toContain("returns the out.Score assigned");
    expect(await goReturnedLocalFacts(input(body))).toMatchObject({form: "concrete", discardSafe: false});
  });
  it.each(["helper(out.Score)", "finish()", "wrap(out.Score.Minor)"])(
    "keeps the fact when the return's call does not mention the local (it passes a copy): return out, %s", async call => {
      const body = BODY.replace("  return out, nil", "  return out, " + call);
      expect(await goReturnedLocalReview(input(body))).toBe("pkg/sample/build.go: return out L107 returns the out.Score assigned at L105 (out.Score, err = left.Minus(right)), not one set by out.Apply() L103.");
      expect(await goReturnedLocalFacts(input(body))).toMatchObject({form: "strong", discardSafe: true});
    });
  it("exposes the facts behind the review and agrees with it", async () => {
    const t07 = input(T07_COMPUTE, {path: "pkg/balance/compute.go", startLine: 1, endLine: 47});
    const facts = await goReturnedLocalFacts(t07);
    expect(facts).toEqual({
      text: await goReturnedLocalReview(t07), form: "strong", discardSafe: true, local: "b", field: "b.Net",
      callText: "b.Apply(p, normalSide)", callLine: 35, writeText: "b.Net, err = b.Debit.Sub(b.Credit)", writeLine: 41,
      writeEndLine: 41, returnLine: 46, functionName: "Compute", functionStartLine: 20, functionEndLine: 47,
    });
    // A compound write is no strong candidate, so never discard-safe; a multi-line statement is one (the write
    // replaces what the call set) but the single-line wording cannot quote it, so the form stays the fallback.
    expect(await goReturnedLocalFacts(input(BODY.replace("out.Score, err = left.Minus(right)", "out.Score += delta"))))
      .toMatchObject({form: "concrete", discardSafe: false});
    expect(await goReturnedLocalFacts(input(BODY.replace("out.Score, err = left.Minus(right)", "out.Score, err = left.Minus(\n    right)"))))
      .toMatchObject({form: "advisory", discardSafe: true});
    // A method names its receiver type.
    const method = BODY.replace("func Build()", "func (r *Runner) Build()");
    expect((await goReturnedLocalFacts(input(method)))?.functionName).toBe("(*Runner).Build");
  });
  it.each([
    BODY.replace("  if err != nil { return Result{}, err }\n  return out, nil", "  if retry { out.Score = fallback }\n  return out, nil"),
    BODY.replace("out.Score, err = left.Minus(right)", "out.Score += delta"),
    BODY.replace("  if err != nil { return Result{}, err }", "  if err != nil { out.Score++ }"),
    BODY.replace("  if err != nil { return Result{}, err }", "  if err != nil { out.Apply() }"),
  ])("falls back to the existing aid when a later control path may mutate the local", async body => {
    const result = await goReturnedLocalReview(input(body));
    expect(result).toContain("later");
    expect(result).not.toContain("precedes the final direct assignment");
  });
  it("keeps compound field writes distinct from simple assignments", async () => {
    const body = BODY.replace("out.Score, err = left.Minus(right)", "out.Score += delta");
    const result = await goReturnedLocalReview(input(body));
    expect(result).toContain("out.Apply() L103; later compound write out.Score += delta L105");
    expect(result).not.toContain("later assignment");
  });
  it("accepts whole-file context with correct offsets", async () => {
    expect(await goReturnedLocalReview(input("package sample\n\n" + BODY)))
      .toContain("return out L109 returns the out.Score assigned at L107 (out.Score, err = left.Minus(right)), not one set by out.Apply() L105.");
  });
  it("keeps CRLF and Unicode positions correct", async () => {
    const body = BODY.replace("out := Result{}", 'out := Result{}\n  _ = "日本語😀"').replace(/\n/g, "\r\n");
    expect(await goReturnedLocalReview(input(body))).toContain("return out L108 returns the out.Score assigned at L106 (out.Score, err = left.Minus(right)), not one set by out.Apply() L104.");
  });
  it("keeps the bounded fallback for a multiline assignment", async () => {
    const result = await goReturnedLocalReview(input(BODY.replace("out.Score, err = left.Minus(right)", "out.Score, err = left.Minus(\n    right)")));
    expect(result).toMatch(/out receiver call L103; later assignment to out.Score L105; return L\d+\. Check both sites against task intent; batch fixes\./);
    expect(Buffer.byteLength(result!, "utf8")).toBeLessThanOrEqual(200);
  });
  it("keeps long right-hand expressions out of the bounded aid", async () => {
    const body = BODY.replace("out.Score, err = left.Minus(right)", "out.Score, err = left.Minus(" + "argument".repeat(40) + ")");
    const result = await goReturnedLocalReview(input(body));
    // The fact without the statement while the statement does not fit in 200 bytes.
    expect(result).toBe("pkg/sample/build.go: return out L107 returns the out.Score assigned at L105, not one set by out.Apply() L103.");
    expect(result).not.toContain("argument".repeat(40));
    expect(Buffer.byteLength(result!, "utf8")).toBeLessThanOrEqual(200);
    expect(await goReturnedLocalFacts(input(body))).toMatchObject({form: "strong", discardSafe: true});
    // Not even that fits (a long path and call): the instruction wording, then the bounded fallbacks, as before.
    const crowded = await goReturnedLocalReview(input(body, {path: "pkg/" + "sample/".repeat(18) + "build.go"}));
    expect(crowded === undefined || Buffer.byteLength(crowded, "utf8") <= 200).toBe(true);
    expect(crowded ?? "").not.toContain("returns the out.Score assigned");
  });
  it.each([
    "  alias := out; _ = alias", "  if true { out := Result{}; _ = out }",
    "  _ = func() { _ = out }", "  alias := &out.Score; _ = alias",
    "  alias := out.Apply; _ = alias", "  consume(out)", "  defer out.Flush()", "  go out.Flush()",
  ])("abstains on ambiguity: %s", async extra => {
    expect(await goReturnedLocalReview(input(BODY.replace("  out := Result{}", "  out := Result{}\n" + extra)))).toBeUndefined();
  });
  it.each([
    BODY.replace("out.Apply()", "other.Apply()"), BODY.replace("out.Score, err =", "other.Score, err ="),
    BODY.replace("return out, nil", "return other, nil"), BODY.replace("out.Apply()", "out.Apply("), BODY.slice(0, -1),
  ])("requires complete syntax and the complete chain", async body => {
    expect(await goReturnedLocalReview(input(body))).toBeUndefined();
  });
  it("ignores imitation in comments and strings", async () => {
    const body = BODY.replace("out.Apply()", "other.Apply()").replace("  var err error",
      '  // out.Apply(); out.Score = 1; return out\n  _ = "out.Apply(); out.Score = 1; return out"\n  var err error');
    expect(await goReturnedLocalReview(input(body))).toBeUndefined();
  });
  it.each([
    {fresh: false}, {complete: false}, {truncated: true}, {endLine: 107}, {startLine: 0},
    {path: "pkg/sample/build_test.go"}, {path: "長".repeat(100) + ".go"},
  ])("fails closed on freshness, completeness and output limits: %j", async patch => {
    expect(await goReturnedLocalReview(input(BODY, patch))).toBeUndefined();
  });
  // 2026-10-24: the 12 KiB bound is the FUNCTION's. A window may be larger (a prefix of a large file that ends with the
  // function, a function between others); only a text past the parse bound, or a function past 12 KiB, is not read.
  it("bounds the function it analyses by 12 KiB, and what it parses by 256 KiB", async () => {
    const padding = "// " + "x".repeat(12 * 1024) + "\n";
    // 12 KiB of comment before the function: the function is the same one, one line further down.
    expect(await goReturnedLocalReview(input(padding + BODY)))
      .toBe("pkg/sample/build.go: return out L108 returns the out.Score assigned at L106 (out.Score, err = left.Minus(right)), not one set by out.Apply() L104.");
    // 12 KiB of comment inside it: a function above the bound is not analysed.
    expect(await goReturnedLocalReview(input(BODY.replace("  var err error", "  // " + "x".repeat(12 * 1024) + "\n  var err error")))).toBeUndefined();
    // Just under it the function still is.
    const nearly = BODY.replace("  var err error", "  // " + "x".repeat(12 * 1024 - BODY.length - 64) + "\n  var err error");
    expect(Buffer.byteLength(nearly, "utf8")).toBeLessThan(12 * 1024);
    expect(await goReturnedLocalReview(input(nearly))).toContain("returns the out.Score assigned at L106");
    // Past the parse bound nothing is read, whatever the function.
    expect(await goReturnedLocalReview(input("// " + "x".repeat(256 * 1024) + "\n" + BODY))).toBeUndefined();
  });
  // A surface served as a window of a larger file (generality audit §3.9.1): the body is the exact source of its window.
  it("reviews the function whatever else its window holds: alone, after other declarations, between other functions", async () => {
    const helper = (name: string): string => `func ${name}(n int) int {\n  m := n + 1\n  return m\n}\n\n`;
    const expected = (return_: number, write: number, call: number): string =>
      `pkg/sample/build.go: return out L${return_} returns the out.Score assigned at L${write} (out.Score, err = left.Minus(right)), not one set by out.Apply() L${call}.`;
    // The function alone (a window 190-206 of a 519-line file, say).
    expect(await goReturnedLocalReview(input(BODY, {startLine: 190, endLine: 197}))).toBe(expected(196, 194, 192));
    // After other declarations: the head of the file through the function.
    const head = "package sample\n\nimport \"fmt\"\n\ntype Result struct{ Score int }\n\n" + helper("one") + helper("two");
    const prefix = head + BODY;
    expect(await goReturnedLocalReview(input(prefix, {startLine: 1, endLine: prefix.replace(/\n$/u, "").split("\n").length })))
      .toBe(expected(head.split("\n").length + 6, head.split("\n").length + 4, head.split("\n").length + 2));
    // Between other functions.
    const between = helper("before") + BODY + "\n\n" + helper("after").trimEnd();
    expect(await goReturnedLocalReview(input(between, {startLine: 40, endLine: 39 + between.replace(/\n$/u, "").split("\n").length })))
      .toBe(expected(40 + 5 + 6, 40 + 5 + 4, 40 + 5 + 2));
  });
  it("does not review a window that cuts a function, whichever end it cuts", async () => {
    const lines = BODY.split("\n");
    // Starting inside the function, ending before its closing brace, or ending inside the next function.
    expect(await goReturnedLocalReview(input(lines.slice(2).join("\n"), {startLine: 103, endLine: 108}))).toBeUndefined();
    expect(await goReturnedLocalReview(input(lines.slice(0, -1).join("\n"), {startLine: 101, endLine: 107}))).toBeUndefined();
    expect(await goReturnedLocalReview(input(BODY + "\n\nfunc Next() {\n  x := 1", {startLine: 101, endLine: 112}))).toBeUndefined();
  });
  it("abstains when several functions qualify", async () => {
    expect(await goReturnedLocalReview(input(BODY + "\n\n" + BODY.replace("Build()", "BuildOther()")))).toBeUndefined();
  });
  it("projects the advisory only beside its exact fresh source and range", () => {
    const review = {path: "pkg/sample/build.go", body: BODY, range: "101-108", text: "Review returned fields."};
    const source = {handle: "hreview", path: "pkg/sample/build.go", range: review.range, code: BODY,
      why: "caller-supplied"};
    const originalSize = JSON.stringify(source).length;
    bindGoReviewOrigin(source, review);
    expect(JSON.stringify(source).length).toBe(originalSize);
    expect(projectEvidence([source])[0]).toMatchObject({why: "caller-supplied; Review returned fields."});
    for (const patch of [
      {code: BODY.slice(0, -1)}, {code: undefined, code_unchanged: "held"},
      {range: "102-109"}, {path: "other.go"}, {content_completeness: "partial", remaining_ranges: ["108-108"]},
      {appended_windows: [{marker: "// extra", range: "200-201"}]},
    ]) expect(projectEvidence([{...source, ...patch}])[0]).toMatchObject({why: "caller-supplied"});
    // The rest of the FILE may remain (generality audit §3.9.1): a function served as a window carries the review.
    // A remaining range that touches the window itself, or that is no plain span, does not.
    for (const remaining of [["1-100", "109-519"], ["1-100"], ["109-109"]]) {
      expect(projectEvidence([{...source, remaining_ranges: remaining}])[0], remaining.join()).toMatchObject({remaining, why: "caller-supplied; Review returned fields."});
    }
    for (const remaining of [["108-108"], ["90-101"], ["101-108"], ["1-519"], ["the rest"], ["1-100", "104-104"]]) {
      expect(projectEvidence([{...source, remaining_ranges: remaining}])[0], remaining.join()).toMatchObject({why: "caller-supplied"});
    }
    const resident = {...source, code: "// already served this session\n" + BODY};
    bindGoReviewOrigin(resident, {...review, body: resident.code});
    expect(projectEvidence([resident])[0]).toMatchObject({why: "caller-supplied"});
    expect(JSON.stringify(projectEvidence([source]))).not.toContain("source_order_review");
  });
});
