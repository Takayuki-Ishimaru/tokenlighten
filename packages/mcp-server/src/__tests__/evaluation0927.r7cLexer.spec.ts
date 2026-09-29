/**
 * evaluation0927.r7cLexer.spec.ts — R7-C (round-7 wave, 2026-09-28):
 * regression coverage for review-findings-fable-r6.md's P1-6 class
 * (regexClassSlashStarHidesCallers), P2-9 (nested block comments, Ruby
 * `=begin`/`=end`, Ruby `%`-literals, a nested backtick template inside a
 * `${…}` field) and the P2-11 class (a call on a block-comment CLOSER line,
 * `a--`/`a++` postfix before a division).
 *
 * Pure unit tests only — no server, no workspace, no filesystem. Every case
 * hand-builds a small snippet (fresh identifiers/paths, never the reviewer's
 * own fixture text) and exercises `blockCommentLineStates` /
 * `computeBlockCommentMask` / `maskNonCode` (callerExpansion.ts) directly, and
 * through the SAME classifier (`callSiteOccurrenceIsDeclaration`,
 * readCodeTaskPack.ts) the real collectors use, matching the style of
 * `evaluation0927.r6cMaskNonCode.spec.ts`.
 */
import { describe, expect, it } from "vitest";

import {
  blockCommentLineStates,
  computeBlockCommentMask,
  findCallOccurrences,
  hasHashComments,
  maskNonCode,
} from "../features/task-pack/callerExpansion.js";
import { callSiteOccurrenceIsDeclaration } from "../features/task-pack/readCodeTaskPack.js";

/** True when `masked` still carries a real (non-declaration) call-shaped occurrence of `member` on `rawLines[targetLine - 1]`. */
function isCallSite(relPath: string, member: string, rawLines: readonly string[], targetLine: number): boolean {
  const hashComment = hasHashComments(relPath);
  const raw = rawLines[targetLine - 1]!;
  const masked = maskNonCode(raw, hashComment, relPath);
  const occurrences = findCallOccurrences(masked, member);
  return occurrences.some((o) => !callSiteOccurrenceIsDeclaration(o, masked, relPath, rawLines, targetLine, hashComment));
}

/** The SAME "skip a comment-masked line before it ever reaches `maskNonCode`" pattern the real callSitesForFocalMember/plainFunctionCallerSites/sameFileFacetCallSites apply. */
function isCallSiteRespectingCommentMask(relPath: string, member: string, rawLines: readonly string[], targetLine: number): boolean {
  const mask = computeBlockCommentMask(rawLines, relPath);
  if (mask[targetLine - 1]) return false;
  return isCallSite(relPath, member, rawLines, targetLine);
}

// ---------------------------------------------------------------------------
// C0: the blockCommentLineStates contract.
// ---------------------------------------------------------------------------

describe("C0: blockCommentLineStates contract", () => {
  it("computeBlockCommentMask is exactly .masked", () => {
    const lines = ["/*", "  interior", "*/", "function f() {}"];
    const states = blockCommentLineStates(lines, "orders.ts");
    expect(computeBlockCommentMask(lines, "orders.ts")).toEqual(states.masked);
  });
  it("confident is true for every line of a span opened at the start of its own line", () => {
    const lines = ["/*", "  interior", "*/"];
    const states = blockCommentLineStates(lines, "orders.ts");
    expect(states.masked).toEqual([true, true, true]);
    expect(states.confident).toEqual([true, true, true]);
  });
  it("confident is false throughout a span whose opener had real code before it", () => {
    const lines = ["x = 1; /* starts", "  interior", "*/"];
    const states = blockCommentLineStates(lines, "orders.ts");
    expect(states.masked).toEqual([false, true, true]);
    expect(states.confident).toEqual([false, false, false]);
  });
  it("confident is false wherever masked is false (unmasked code)", () => {
    const lines = ["const x = 1;"];
    const states = blockCommentLineStates(lines, "orders.ts");
    expect(states.masked).toEqual([false]);
    expect(states.confident).toEqual([false]);
  });
  it("codeFrom names the column right after a closer that carries trailing code", () => {
    const lines = ["/* start", "*/ run(2);"];
    const states = blockCommentLineStates(lines, "orders.c");
    expect(states.codeFrom[0]).toBeUndefined();
    expect(states.codeFrom[1]).toBe(2);
    expect(lines[1]!.slice(states.codeFrom[1]!)).toBe(" run(2);");
  });
  it("codeFrom is undefined for a closer with nothing (or only whitespace) after it", () => {
    const lines = ["/* start", "*/  "];
    const states = blockCommentLineStates(lines, "orders.c");
    expect(states.codeFrom).toEqual([undefined, undefined]);
    expect(states.masked[1]).toBe(true);
  });
  it("codeFrom also fires for a Ruby =end line with trailing text", () => {
    const lines = ["=begin", "doc", "=end extra"];
    const states = blockCommentLineStates(lines, "orders.rb");
    expect(states.codeFrom[2]).toBe("=end".length);
  });
});

// ---------------------------------------------------------------------------
// C1 (P1-6, regexClassSlashStarHidesCallers): the file-level scan must not
// open a block comment inside a JS/TS regex literal.
// ---------------------------------------------------------------------------

describe("C1: a JS/TS regex character class never opens a fake block comment", () => {
  it("a /* sequence inside a [...] class does not hide a later real call", () => {
    const lines = ["const LEAD = /^[/*\\s]+/;", "run(1);"];
    const mask = computeBlockCommentMask(lines, "orders.ts");
    expect(mask).toEqual([false, false]);
    expect(isCallSiteRespectingCommentMask("orders.ts", "run", lines, 2)).toBe(true);
  });
  it("control: a */ -order class (no real /* pair) is unaffected either way", () => {
    const lines = ["const RE = /[*/]+/;", "run(1);"];
    const mask = computeBlockCommentMask(lines, "orders.ts");
    expect(mask).toEqual([false, false]);
  });
  it("gated to JS/TS: a non-JS extension keeps the UNIVERSAL (regex-unaware) */ scan -- this fix is additive, not a behaviour change for languages with no regex-literal syntax to protect", () => {
    const lines = ["LEAD = /^[/*\\s]+/", "run(1)"];
    const withoutDialect = computeBlockCommentMask(lines, "orders.unknownext");
    expect(withoutDialect).toEqual([false, true]); // the "/*" inside the bracket text still opens, exactly as it always has for a non-JS file
  });
  it("control: a genuine multi-line /* comment (no regex involved) still opens normally", () => {
    const lines = ["x = 1; /* starts", "run(1) mid-comment", "*/"];
    const mask = computeBlockCommentMask(lines, "orders.ts");
    expect(mask).toEqual([false, true, true]);
  });
  it("a real comment containing an unescaped slash (a URL) still closes on its own */ ", () => {
    const lines = ['/* see http://example.com for details */ run(2);'];
    expect(isCallSiteRespectingCommentMask("orders.ts", "run", lines, 1)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// C1: an unclosed multi-line template literal never lets its own inert text
// masquerade as a real comment/docstring opener on a LATER line.
// ---------------------------------------------------------------------------

describe("C1: a multi-line template literal's inert text is never a comment opener", () => {
  it("a comment-lookalike inside an unclosed template's text does not hide a later real call", () => {
    const lines = [
      "const s = `line one",
      "/* this looks like a comment opener but it is just template text",
      "run(1) should still be visible below",
      "*/",
      "real code here`;",
      "run(2);",
    ];
    const mask = computeBlockCommentMask(lines, "orders.ts");
    // R8-C (eval-0927 review-r7 round 8, C1, tsTemplateInteriorFalseCaller):
    // this expectation MOVED. Round 7's C1 fix was scoped to keeping a
    // comment-lookalike INSIDE an unclosed template from arming a REAL
    // cross-line block-comment span that would swallow content past the
    // template's own close (line 6, "run(2);", below, is exactly that --
    // unaffected by this change). It never meant "run(1)" here -- ordinary
    // TEMPLATE TEXT, not executable code -- should be classified as a real
    // call site; round 8 found that it was (tsTemplateInteriorFalseCaller: a
    // call-shaped phrase inside multi-line template prose read as "1 of 1
    // call sites"). `blockCommentLineStates` now reports a strictly-interior
    // template line as `masked` (excluded from call-site classification) but
    // NON-confident (kept for the mention guard, never silently dropped) --
    // see `evaluation0927.r8cLexer.spec.ts`'s own C1 section for the full
    // matrix. `mask[2]` (computeBlockCommentMask is exactly `.masked`) is
    // therefore now `true`, and the line no longer reads as a call site.
    expect(mask[2]).toBe(true); // "run(1) should still be visible below" -- prose, now correctly excluded from call-site classification
    expect(isCallSiteRespectingCommentMask("orders.ts", "run", lines, 3)).toBe(false);
    expect(isCallSiteRespectingCommentMask("orders.ts", "run", lines, 6)).toBe(true);
  });
  it("gated to JS/TS: an unclosed backtick in a non-JS file never arms cross-line tracking", () => {
    const lines = ["s = `line one", "/* looks like a comment */"];
    // Ruby has no backtick-string syntax at all here; the SAME comment-lookalike text is
    // still correctly read as an ordinary (same-line-closing) comment, never suppressed.
    const mask = computeBlockCommentMask(lines, "orders.rb");
    expect(mask).toEqual([false, false]);
  });
});

// ---------------------------------------------------------------------------
// C2 (P2-9): nested block comments for languages that nest them.
// ---------------------------------------------------------------------------

describe("C2: nested block comments (Kotlin/Swift/Rust/Scala/Dart)", () => {
  it("Kotlin: an inner */ does not close the outer comment", () => {
    const lines = ["/* outer", " /* inner */", "run(1) still comment", "*/"];
    const mask = computeBlockCommentMask(lines, "orders.kt");
    expect(mask).toEqual([true, true, true, true]);
    expect(isCallSiteRespectingCommentMask("orders.kt", "run", lines, 3)).toBe(false);
  });
  it("Swift: same nesting behaviour", () => {
    const lines = ["/* outer", " /* inner */", "run(1) still comment", "*/"];
    expect(computeBlockCommentMask(lines, "orders.swift")).toEqual([true, true, true, true]);
  });
  it("Rust: same nesting behaviour", () => {
    const lines = ["/* outer", " /* inner */", "run(1) still comment", "*/"];
    expect(computeBlockCommentMask(lines, "orders.rs")).toEqual([true, true, true, true]);
  });
  it("Dart: same nesting behaviour", () => {
    const lines = ["/* outer", " /* inner */", "run(1) still comment", "*/"];
    expect(computeBlockCommentMask(lines, "orders.dart")).toEqual([true, true, true, true]);
  });
  it("control: a NON-nesting language (C) still closes at the FIRST */", () => {
    const lines = ["/* outer", " /* inner */", "run(1) real code now", "*/"];
    const mask = computeBlockCommentMask(lines, "orders.c");
    expect(mask).toEqual([true, true, false, false]);
    expect(isCallSiteRespectingCommentMask("orders.c", "run", lines, 3)).toBe(true);
  });
  it("control: Java (also non-nesting) matches C", () => {
    const lines = ["/* outer", " /* inner */", "run(1) real code now", "*/"];
    expect(computeBlockCommentMask(lines, "orders.java")).toEqual([true, true, false, false]);
  });
});

// ---------------------------------------------------------------------------
// C2 (P2-9): Ruby =begin/=end embedded documentation.
// ---------------------------------------------------------------------------

describe("C2: Ruby =begin/=end", () => {
  it("marks the interior between =begin and =end", () => {
    const lines = ["=begin", "run(1) is documented here", "=end"];
    const mask = computeBlockCommentMask(lines, "orders.rb");
    expect(mask).toEqual([true, true, true]);
    expect(isCallSiteRespectingCommentMask("orders.rb", "run", lines, 2)).toBe(false);
  });
  it("gated to Ruby: '=begin' at column 0 in a non-Ruby file never opens it", () => {
    const lines = ["=begin", "run(1)", "=end"];
    expect(computeBlockCommentMask(lines, "orders.ts")).toEqual([false, false, false]);
  });
  it("control: =begin with leading whitespace is NOT recognized (Ruby requires column 0)", () => {
    const lines = ["  =begin", "run(1)", "=end"];
    const mask = computeBlockCommentMask(lines, "orders.rb");
    expect(mask[0]).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// C2 (P2-9): Ruby %-literals in maskNonCode.
// ---------------------------------------------------------------------------

describe("C2: Ruby %-literals never open real calls inside them", () => {
  it("%q(...) with a NESTED paren pair (run(1)) is entirely literal text", () => {
    expect(isCallSite("orders.rb", "run", ["s = %q(run(1) text)"], 1)).toBe(false);
    const masked = maskNonCode("s = %q(run(1) text)", false, "orders.rb");
    expect(masked).not.toContain("run");
  });
  it("%Q[...] (bracket delimiter) is also literal", () => {
    expect(isCallSite("orders.rb", "run", ["s = %Q[run(1) text]"], 1)).toBe(false);
  });
  it("bare %(...) behaves like %Q", () => {
    expect(isCallSite("orders.rb", "run", ["s = %(run(1) text)"], 1)).toBe(false);
  });
  it("%w(...) word-array literal is also inert", () => {
    expect(isCallSite("orders.rb", "run", ["s = %w(run(1) text)"], 1)).toBe(false);
  });
  it("%i(...) symbol-array literal is also inert", () => {
    expect(isCallSite("orders.rb", "run", ["s = %i(run(1) text)"], 1)).toBe(false);
  });
  it("control: code AFTER a closed %q(...) literal is still a real call", () => {
    expect(isCallSite("orders.rb", "run", ["x = %q(text); run(1)"], 1)).toBe(true);
  });
  it("gated to Ruby: '%q(' in a non-Ruby file is left completely alone", () => {
    const masked = maskNonCode("s = %q(run(1) text)", false, "orders.ts");
    expect(masked).toContain("run(1)");
  });
  it("control: modulo immediately before a parenthesized operand is NOT a percent-literal", () => {
    const masked = maskNonCode("total = amount %(2)", false, "orders.rb");
    expect(masked).toContain("amount %(2)");
  });
  it("control: modulo before a call-shaped parenthesized operand keeps the call visible", () => {
    expect(isCallSite("orders.rb", "run", ["total = amount % (run(2))"], 1)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// C2 (P2-9): a nested backtick template inside a ${…} field in maskNonCode.
// ---------------------------------------------------------------------------

describe("C2: a backtick template nested inside a ${…} field", () => {
  it("a call-shaped phrase inside the nested template's own literal text is never a call site", () => {
    expect(isCallSite("orders.ts", "run", ["const s = `a ${`literal run(x) text`} b`;"], 1)).toBe(false);
  });
  it("control: an ordinary (non-nested) template call site is unaffected", () => {
    expect(isCallSite("orders.ts", "run", ["const s = `total ${run(n)} due`;"], 1)).toBe(true);
  });
  it("control: the outer field's OWN call, alongside a nested template, still resolves", () => {
    const masked = maskNonCode("const s = `${run(1)} and ${`nested run(2) text`}`;", false, "orders.ts");
    expect(findCallOccurrences(masked, "run")).toHaveLength(1); // only the outer run(1)
  });
});

// ---------------------------------------------------------------------------
// C3 (P2-11 class): maskNonCode blanks only COMMENT text.
// ---------------------------------------------------------------------------

describe("C3: maskNonCode blanks only comment text, never trailing/leading code", () => {
  it("a line starting with */ is blanked through the closer, code after it stays visible", () => {
    expect(isCallSite("orders.c", "run", ["*/ run(2);"], 1)).toBe(true);
    const masked = maskNonCode("*/ run(2);", false, "orders.c");
    expect(masked.slice(0, 2)).toBe("  ");
    expect(masked).toContain("run(2);");
  });
  it("*/ with leading whitespace before it is blanked through the closer too", () => {
    const masked = maskNonCode("  */ run(2);", false, "orders.c");
    expect(masked.slice(0, 4).trim()).toBe("");
    expect(masked).toContain("run(2);");
  });
  it("a */-only line (nothing after) stays entirely blank", () => {
    const masked = maskNonCode("*/", false, "orders.c");
    expect(masked.trim()).toBe("");
    expect(masked).toHaveLength(2);
  });
  it("a same-line /* note */ comment keeps the code AFTER the closer", () => {
    expect(isCallSite("orders.c", "run", ["/* note */ run(2);"], 1)).toBe(true);
  });
  it("a MID-line /* note */ comment blanks only its own span, not to end of line", () => {
    const masked = maskNonCode("let x = 5; /* note */ run(2);", false, "orders.c");
    expect(masked).toContain("let x = 5;");
    expect(masked).toContain("run(2);");
    expect(masked).not.toContain("note");
  });
  it("an UNCLOSED /* on this line still blanks straight to end of line (unchanged)", () => {
    const masked = maskNonCode("x = 1; /* starts here with no closer", false, "orders.c");
    expect(masked.trim()).toBe("x = 1;");
  });
  it("control: the doc-comment CONTINUATION rule (bare *, * text) is unchanged", () => {
    expect(maskNonCode("  * returns the running total", false).trim()).toBe("");
    expect(maskNonCode("**", false).trim()).toBe("");
  });
  it("control: the dereference-assignment carve-out (* run(x) = 3;) is unchanged", () => {
    expect(isCallSite("orders.c", "run", ["  * run(x) = 3;"], 1)).toBe(true);
  });
  it("control: an ordinary // line comment still runs to end of line", () => {
    expect(maskNonCode("// calls run(1)", false).trim()).toBe("");
  });
});

// ---------------------------------------------------------------------------
// C3 (P1-6, ts-decrement-then-division-then-string): postfix -- / ++ before a
// slash is division, never a regex opener.
// ---------------------------------------------------------------------------

describe("C3: postfix -- / ++ before a slash is a division, never a regex opener", () => {
  it("a-- / 2 does not corrupt masking of a later real string/call", () => {
    const masked = maskNonCode('x = a-- / 2; s = "a/b"; run(1);', false, "orders.ts");
    expect(findCallOccurrences(masked, "run")).not.toHaveLength(0);
    expect(masked).toContain("x = a-- / 2");
  });
  it("a++ / 2 behaves the same way", () => {
    const masked = maskNonCode('x = a++ / 2; s = "a/b"; run(1);', false, "orders.ts");
    expect(findCallOccurrences(masked, "run")).not.toHaveLength(0);
  });
  it("control: ordinary division (no postfix) is unaffected", () => {
    const masked = maskNonCode('x = a / 2; s = "a/b"; run(1);', false, "orders.ts");
    expect(findCallOccurrences(masked, "run")).not.toHaveLength(0);
  });
  it("control: a genuine regex literal right after -- is still impossible in practice, and a real regex context (after ';') still opens", () => {
    const masked = maskNonCode('a--; const re = /"/g; run(1);', false, "orders.ts");
    expect(findCallOccurrences(masked, "run")).not.toHaveLength(0);
    expect(masked).not.toContain('"');
  });
});
