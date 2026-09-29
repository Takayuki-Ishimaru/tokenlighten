/**
 * evaluation0927.r6cMaskNonCode.spec.ts — R6-C (round-6 wave, 2026-09-28):
 * regression coverage for review-findings-fable-r5.md's P1-3 (dialect string
 * interpolation + JS/TS regex literals), P1-5 (multi-line block-comment /
 * Python-docstring interiors, a string literal nested inside a template
 * field) and P2-8 (`* IDENT(args) = value;` is code, not a doc-comment
 * continuation).
 *
 * Pure unit tests only — no server, no workspace, no filesystem. Every case
 * hand-builds a small snippet (fresh identifiers/paths, never the reviewer's
 * own fixture text) and exercises `maskNonCode` / `computeBlockCommentMask`
 * (callerExpansion.ts) and `constantLikeReferencesIn`
 * (evidenceClosure.ts) — the SAME functions the real caller/constant scans
 * call — through the SAME classifier (`callSiteOccurrenceIsDeclaration`,
 * readCodeTaskPack.ts) the real collectors use.
 */
import { describe, expect, it } from "vitest";

import { computeBlockCommentMask, findCallOccurrences, hasHashComments, maskNonCode } from "../features/task-pack/callerExpansion.js";
import { callSiteOccurrenceIsDeclaration } from "../features/task-pack/readCodeTaskPack.js";
import { constantLikeReferencesIn } from "../features/task-pack/evidenceClosure.js";

/** True when `masked` still carries a real (non-declaration) call-shaped occurrence of `member` on `rawLines[targetLine - 1]`. */
function isCallSite(relPath: string, member: string, rawLines: readonly string[], targetLine: number): boolean {
  const hashComment = hasHashComments(relPath);
  const raw = rawLines[targetLine - 1]!;
  const masked = maskNonCode(raw, hashComment, relPath);
  const occurrences = findCallOccurrences(masked, member);
  return occurrences.some((o) => !callSiteOccurrenceIsDeclaration(o, masked, relPath, rawLines, targetLine, hashComment));
}

/**
 * The SAME "skip a comment-masked line before it ever reaches `maskNonCode`"
 * integration `callSitesForFocalMember` / `plainFunctionCallerSites` /
 * `sameFileFacetCallSites` now apply (R6-C) — `maskNonCode` itself stays
 * deliberately single-line (see its own doc) and has no opinion here; a
 * consumer that skips `computeBlockCommentMask`'s `true` lines is what makes
 * a comment/docstring interior never a call site.
 */
function isCallSiteRespectingCommentMask(relPath: string, member: string, rawLines: readonly string[], targetLine: number): boolean {
  const mask = computeBlockCommentMask(rawLines, relPath);
  if (mask[targetLine - 1]) return false;
  return isCallSite(relPath, member, rawLines, targetLine);
}

// ---------------------------------------------------------------------------
// P1-3: keep the CODE of per-language double-quoted-string interpolation
// fields visible, gated by `relPath`'s extension (never for a language that
// does not have the feature — ts-dq-not-template below).
// ---------------------------------------------------------------------------

describe("R6-C P1-3: dialect string interpolation stays CODE (gated by relPath)", () => {
  it("C# $\"…{expr}…\" keeps a call inside the field a site", () => {
    expect(isCallSite("Billing.cs", "Total", ["var s = $\"amount {Total(order)} due\";"], 1)).toBe(true);
  });
  it("C# $@\"…\" (verbatim interpolated) keeps a call inside the field a site", () => {
    expect(isCallSite("Billing.cs", "Total", ["var s = $@\"amount {Total(order)} due\";"], 1)).toBe(true);
  });
  it("Kotlin \"${expr}\" keeps a call inside the field a site", () => {
    expect(isCallSite("Billing.kt", "total", ["val s = \"amount ${total(order)} due\""], 1)).toBe(true);
  });
  it("Swift \"\\(expr)\" keeps a call inside the field a site", () => {
    expect(isCallSite("Billing.swift", "total", ["let s = \"amount \\(total(order)) due\""], 1)).toBe(true);
  });
  it("Ruby \"#{expr}\" keeps a call inside the field a site", () => {
    expect(isCallSite("billing.rb", "total", ["s = \"amount #{total(order)} due\""], 1)).toBe(true);
  });
  it("control: TS double-quoted \"${…}\" is NOT a template — never a site", () => {
    expect(isCallSite("billing.ts", "total", ["const s = \"amount ${total(order)} due\";"], 1)).toBe(false);
  });
  it("control: Java double-quoted \"${…}\" (Spring-style placeholder) is NOT a template either", () => {
    expect(isCallSite("Billing.java", "total", ["String s = \"amount ${total(order)} due\";"], 1)).toBe(false);
  });

  it("csharpConst-shape: a constant read through a C# $\"…\" field stays a candidate", () => {
    const consts = constantLikeReferencesIn(
      ["var attempt = 0;", "return $\"{Pricing.BASE_RATE}/order/{id}?attempt={attempt}\";"],
      false, "Quote", new Set(), "src/Orders.cs",
    );
    expect(consts).toContain("Pricing");
  });
  it("ktConst-shape: an unqualified constant read through a Kotlin \"${…}\" field stays a candidate", () => {
    const consts = constantLikeReferencesIn(
      ['    val attempt = 0', '    return "${BASE_RATE}/order/$id?attempt=$attempt"'],
      false, "quote", new Set(), "src/main/kotlin/app/Orders.kt",
    );
    expect(consts).toContain("BASE_RATE");
  });
  it("ktConst-shape: Kotlin's braceless \"$name\" shorthand also stays a candidate", () => {
    const consts = constantLikeReferencesIn(['    return "$BASE_RATE/order"'], false, "quote", new Set(), "src/main/kotlin/app/Orders.kt");
    expect(consts).toContain("BASE_RATE");
  });
  it("swiftConst-shape: a constant read through a Swift \"\\(…)\" field stays a candidate", () => {
    const consts = constantLikeReferencesIn(['return "\\(BASE_RATE)/order"'], false, "quote", new Set(), "src/Orders.swift");
    expect(consts).toContain("BASE_RATE");
  });
  it("rubyConst-shape: a constant read through a Ruby \"#{…}\" field stays a candidate", () => {
    const consts = constantLikeReferencesIn(['"#{BASE_RATE}/order"'], false, "quote", new Set(), "src/orders.rb");
    expect(consts).toContain("BASE_RATE");
  });
  it("control: a TS double-quoted \"${…}\" never leaks a fake candidate", () => {
    const consts = constantLikeReferencesIn(['const s = "${BASE_RATE}/order";'], false, "quote", new Set(), "src/orders.ts");
    expect(consts).not.toContain("BASE_RATE");
  });
});

// ---------------------------------------------------------------------------
// P1-3: a JS/TS regex literal containing a quote character never opens a
// (fake) string that swallows the rest of the line.
// ---------------------------------------------------------------------------

describe("R6-C P1-3: JS/TS regex literals never open a string", () => {
  it("a quote-carrying regex literal does not mask a later constant on the same line", () => {
    const line = 'const stripped = id.replace(/"/g, ""); const rate = BASE_RATE;';
    const consts = constantLikeReferencesIn([line], false, "quote", new Set(), "src/orders.ts");
    expect(consts).toContain("BASE_RATE");
  });
  it("a regex literal after a comparison operator is also recognized", () => {
    const line = 'if (input === /"/g.test(input)) { const rate = BASE_RATE; }';
    const consts = constantLikeReferencesIn([line], false, "quote", new Set(), "src/orders.ts");
    expect(consts).toContain("BASE_RATE");
  });
  it("control: ordinary division stays division, never a false regex opener", () => {
    const masked = maskNonCode("const perUnit = total / count;", false, "src/orders.ts");
    expect(masked).toContain("total");
    expect(masked).toContain("count");
  });
  it("control: a compound division-assignment stays code", () => {
    const masked = maskNonCode("total /= count;", false, "src/orders.ts");
    expect(masked).toContain("total");
    expect(masked).toContain("count");
  });
  it("control: the regex fix is gated to JS/TS — a bare '/' in a non-JS file is untouched", () => {
    const line = 'clean = id.replace(/"/g, ""); rate = BASE_RATE';
    const withoutDialect = maskNonCode(line, false); // no relPath at all: byte-for-byte prior behaviour
    const withPython = maskNonCode(line, false, "orders.py"); // Python has no regex-literal syntax
    expect(withPython).toBe(withoutDialect);
  });
});

// ---------------------------------------------------------------------------
// P1-5: a string literal NESTED inside a `${…}` template field stays masked.
// ---------------------------------------------------------------------------

describe("R6-C P1-5: a nested string literal inside a template field stays masked", () => {
  it("a call-shaped phrase inside a nested double-quoted string is never a call site", () => {
    const line = 'return `${flag ? "chargeAccount(total) skipped" : ""} due ${total}`;';
    const masked = maskNonCode(line, false);
    expect(findCallOccurrences(masked, "chargeAccount")).toHaveLength(0);
    // the real ternary CONDITION identifier outside the nested string stays visible
    expect(masked).toContain("flag");
  });
  it("a constant-shaped name inside a nested string is never extracted as a candidate", () => {
    const line = 'const u = `${cond ? "MAX_ATTEMPTS" : ""}`;';
    const consts = constantLikeReferencesIn([line], false, "quote");
    expect(consts).not.toContain("MAX_ATTEMPTS");
  });
  it("an empty nested string (open+close back to back) does not desync field tracking", () => {
    const line = 'return `${cond ? "" : ""} total ${total()}`;';
    const masked = maskNonCode(line, false);
    // the call inside the SECOND field must still read as a real call site —
    // proof the empty nested string above correctly closed `fieldQuote`
    // rather than leaving the scanner stuck thinking it is still inside one
    expect(findCallOccurrences(masked, "total")).not.toHaveLength(0);
  });
  it("control: an ordinary (non-nested) template call site is unaffected", () => {
    const masked = maskNonCode("const s = `total ${chargeAccount(n)} due`;", false);
    expect(findCallOccurrences(masked, "chargeAccount")).not.toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// P2-8: `* IDENT(args) = value;` is code, never a doc-comment continuation.
// ---------------------------------------------------------------------------

describe("R6-C P2-8: a `* IDENT(args) = value;` line is code", () => {
  it("a space-separated dereference-assignment is a call site", () => {
    expect(isCallSite("orders.c", "total", ["  * total(order) = 3;"], 1)).toBe(true);
  });
  it("control: the existing no-space dereference-assignment is unaffected", () => {
    expect(isCallSite("orders.c", "total", ["  *total(order) = 3;"], 1)).toBe(true);
  });
  it("control: ordinary JSDoc-style prose after `* ` is still a comment", () => {
    const masked = maskNonCode("  * returns the running total", false);
    expect(masked.trim()).toBe("");
  });
  it("control: a `* ` line naming a call but with NO assignment stays a comment (narrow shape only)", () => {
    const masked = maskNonCode("  * calls total(order) once per request", false);
    expect(masked.trim()).toBe("");
  });
});

// ---------------------------------------------------------------------------
// P1-5: computeBlockCommentMask — the file-level companion to maskNonCode.
// ---------------------------------------------------------------------------

describe("R6-C P1-5: computeBlockCommentMask (multi-line block comments)", () => {
  it("marks every line of a C-style block comment, including opener and closer", () => {
    const lines = ["/*", "  Usage: chargeAccount(total) settles immediately.", "*/", "", "function next() {}"];
    const mask = computeBlockCommentMask(lines, "orders.ts");
    expect(mask).toEqual([true, true, true, false, false]);
  });
  it("an interior block-comment line is never a call site through the real caller-scan path", () => {
    const lines = ["/*", "  Usage: chargeAccount(total) settles immediately.", "*/", "", "function next() {}"];
    expect(isCallSiteRespectingCommentMask("orders.ts", "chargeAccount", lines, 2)).toBe(false);
  });
  it("does not open on a quoted '/*' inside real code", () => {
    const lines = ['const pattern = "/* not a comment */"; const rate = BASE_RATE;', "function next() {}"];
    const mask = computeBlockCommentMask(lines, "orders.ts");
    expect(mask).toEqual([false, false]);
  });
  it("closes correctly when trailing code shares the closer line (opener/closer stay false, interior stays true)", () => {
    const lines = ["x = 1; /* starts", "  chargeAccount(total) mid-comment", "*/ y = 2;"];
    const mask = computeBlockCommentMask(lines, "orders.ts");
    expect(mask).toEqual([false, true, false]);
  });
});

describe("R6-C P1-5: computeBlockCommentMask (Python triple-quoted docstrings)", () => {
  it("marks the interior of a module-level docstring, never its def/return neighbours", () => {
    const lines = [
      '"""Order helpers.', "", "Example:", "    >>> charge_account(100)", "    'ok'", '"""', "",
      "def summarize(total):", "    return total",
    ];
    const mask = computeBlockCommentMask(lines, "orders.py");
    expect(mask[0]).toBe(true); // opener line, nothing but the marker
    expect(mask[3]).toBe(true); // the interior ">>> charge_account(100)" line
    expect(mask[5]).toBe(true); // closer line, nothing but the marker
    expect(mask[7]).toBe(false); // "def summarize(total):"
    expect(mask[8]).toBe(false); // "return total"
  });
  it("marks the interior of a FUNCTION docstring the same way", () => {
    const lines = [
      "def summarize(total):", '    """Summarize a total.', "", "    Unlike charge_account(total), this never mutates state.", '    """', "    return total",
    ];
    const mask = computeBlockCommentMask(lines, "orders.py");
    expect(mask[3]).toBe(true);
    expect(mask[0]).toBe(false);
    expect(mask[5]).toBe(false);
  });
  it("a docstring interior line is never a call site through the real caller-scan path", () => {
    const lines = [
      '"""Order helpers.', "", "Example:", "    >>> charge_account(100)", "    'ok'", '"""', "",
      "def summarize(total):", "    return total",
    ];
    expect(isCallSiteRespectingCommentMask("orders.py", "charge_account", lines, 4)).toBe(false);
  });
  it("gated to Python: a triple-quote-like run in a non-Python file never opens multi-line state", () => {
    const lines = ['const s = """ not python """;', "function next() {}"];
    const mask = computeBlockCommentMask(lines, "orders.ts");
    expect(mask).toEqual([false, false]);
  });
  it("control: a single-line docstring (open+close on the same line) never enters multi-line state", () => {
    const lines = ['def f():', '    """Calls charge_account(1) internally."""', "    return 1", "def g():", "    return 2"];
    const mask = computeBlockCommentMask(lines, "orders.py");
    expect(mask).toEqual([false, false, false, false, false]);
  });
});
