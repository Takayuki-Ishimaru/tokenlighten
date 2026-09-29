/**
 * evaluation0927.r8cLexer.spec.ts — R8-C (round-8 wave, 2026-09-28):
 * regression coverage for review-findings-fable-r7.md's P2-8 lexer findings
 * (tsTemplateInteriorFalseCaller, phpHashCommentFalseCaller,
 * ktNestedSingleLineFalseCaller, goRawStringFalseEmpty, rustLifetimeFalseString,
 * rubyRegexSlashStarFalseComment, pyPrefixedTripleQuoteConfident) that need
 * the FILE-LEVEL `blockCommentLineStates` scan (multi-line state, or the
 * `masked`/`confident`/`codeFrom` contract itself) rather than a single
 * `maskNonCode` line -- the single-line shapes are covered instead in
 * `callSiteClassificationMatrix.r8c.spec.ts`, matching the r7c/r7cLexer split.
 *
 * Pure unit tests only -- no server, no workspace, no filesystem. Every case
 * hand-builds a small snippet (fresh identifiers/paths, never the reviewer's
 * own fixture text) and exercises `blockCommentLineStates` /
 * `computeBlockCommentMask` / `maskNonCode` (callerExpansion.ts) directly, and
 * through the SAME classifier (`callSiteOccurrenceIsDeclaration`,
 * readCodeTaskPack.ts) the real collectors use, matching the style of
 * `evaluation0927.r7cLexer.spec.ts`.
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
// C1 (tsTemplateInteriorFalseCaller): a line strictly inside a multi-line
// JS/TS template literal is masked NON-confident.
// ---------------------------------------------------------------------------

describe("C1: a multi-line JS/TS template literal's interior is masked non-confident", () => {
  it("a call-shaped phrase in the template's own prose is never a call site", () => {
    const lines = ["const s = `", "  run(1) renders the total", "`;"];
    const st = blockCommentLineStates(lines, "orders.ts");
    expect(st.masked[1]).toBe(true);
    expect(st.confident[1]).toBe(false); // kept for the mention guard, never dropped outright
    expect(isCallSiteRespectingCommentMask("orders.ts", "run", lines, 2)).toBe(false);
  });
  it("real code inside a ${…} field on an interior line is not classified as a call site either (safe direction: at worst a mention, never a false caller)", () => {
    const lines = ["const s = `total", "  is ${run(1)} bytes", "`;"];
    const st = blockCommentLineStates(lines, "orders.ts");
    expect(st.masked[1]).toBe(true);
    expect(st.confident[1]).toBe(false);
  });
  it("control: a closer line carrying real code after the backtick is unaffected (not masked at all -- normal scanning resumes there)", () => {
    const lines = ["const s = `line one", "run(1) prose", "still text`;", "run(2);"];
    const st = blockCommentLineStates(lines, "orders.ts");
    expect(st.masked[1]).toBe(true);
    expect(st.masked[2]).toBe(false); // the closer line itself -- normal scanning resumes right after the backtick
    expect(isCallSiteRespectingCommentMask("orders.ts", "run", lines, 4)).toBe(true);
  });
  it("control: an ordinary same-line-closing template is unaffected", () => {
    const lines = ["const s = `total`;", "run(1);"];
    expect(computeBlockCommentMask(lines, "orders.ts")).toEqual([false, false]);
  });
  it("gated to JS/TS: an unclosed backtick in a non-JS, non-Go file never arms cross-line tracking (unchanged prior behaviour)", () => {
    const lines = ["s = `line one", "run(1) prose"];
    expect(computeBlockCommentMask(lines, "orders.rb")).toEqual([false, false]);
  });
});

// ---------------------------------------------------------------------------
// C2 (phpHashCommentFalseCaller): PHP `#` is a line comment; `#[` is a PHP 8
// attribute, never a comment.
// ---------------------------------------------------------------------------

describe("C2: PHP # is a line comment, but #[ is an attribute opener", () => {
  it("a # comment masks a call-shaped mention inside it", () => {
    expect(isCallSite("a.php", "run", ["# run($total) is documented"], 1)).toBe(false);
  });
  it("#[Attribute] is never mistaken for a comment -- the call after it is still classified", () => {
    expect(isCallSite("a.php", "run", ["#[Route(\"/x\")] run($total);"], 1)).toBe(true);
  });
  it("a real call following a #[...] attribute on the SAME line survives masking", () => {
    const masked = maskNonCode("#[Attribute] run($total);", true, "a.php");
    expect(masked).toContain("run($total)");
  });
  it("// and /* */ still work exactly as before in PHP", () => {
    expect(isCallSite("a.php", "run", ["// run($total) documented"], 1)).toBe(false);
    expect(isCallSite("a.php", "run", ["/* run($total) documented */"], 1)).toBe(false);
  });
  it("control: a bare # comment in Python (no attribute exception) is unaffected", () => {
    expect(isCallSite("a.py", "run", ["# run(1) documented"], 1)).toBe(false);
  });
  it("control: hasHashComments now reports PHP as a hash-comment language", () => {
    expect(hasHashComments("a.php")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// C3 (ktNestedSingleLineFalseCaller): nesting languages count /* */ depth
// within one line too, including the FILE-LEVEL scan.
// ---------------------------------------------------------------------------

describe("C3: nested block comments count depth within one line (file-level scan)", () => {
  it("a same-line self-contained nested comment does not arm cross-line masking (it fully closes on its own line)", () => {
    const lines = ["/* old /* legacy */ run(1) still comment */ run(2);", "run(3);"];
    const mask = computeBlockCommentMask(lines, "a.kt");
    expect(mask).toEqual([false, false]); // closes within line 1 -- never "open" going into line 2
    expect(isCallSiteRespectingCommentMask("a.kt", "run", lines, 2)).toBe(true);
  });
  it("a line that itself opens TWO nested, still-unclosed comments demands TWO closers on later lines before code is exposed again", () => {
    const lines = ["/* outer /* inner", "still inner */", "run(1) still outer comment", "still outer */", "run(2)"];
    const mask = computeBlockCommentMask(lines, "a.kt");
    expect(mask).toEqual([true, true, true, true, false]);
    expect(isCallSiteRespectingCommentMask("a.kt", "run", lines, 3)).toBe(false);
    expect(isCallSiteRespectingCommentMask("a.kt", "run", lines, 5)).toBe(true);
  });
  it("control: the SAME multi-open shape in a non-nesting language (C) closes at the very FIRST closer", () => {
    const lines = ["/* outer /* inner", "still inner */", "run(1) real code now", "still outer */", "run(2)"];
    const mask = computeBlockCommentMask(lines, "a.c");
    expect(mask).toEqual([true, true, false, false, false]);
    expect(isCallSiteRespectingCommentMask("a.c", "run", lines, 3)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// C4 (goRawStringFalseEmpty): a Go raw string (backtick, may span lines) is a
// string in both scans; a `/*` inside one never opens a comment.
// ---------------------------------------------------------------------------

describe("C4: a multi-line Go raw string never lets its own text open a comment", () => {
  it("a /* -shaped sequence inside an unclosed Go raw string does not mask the rest of the file", () => {
    const lines = ["s := `text", "/* not a comment, just raw string content", "still string`", "run(1)"];
    const st = blockCommentLineStates(lines, "a.go");
    expect(st.masked).toEqual([false, true, false, false]); // line 2 (interior) masked, non-confident; run(1) survives
    expect(st.confident[1]).toBe(false);
    expect(isCallSiteRespectingCommentMask("a.go", "run", lines, 4)).toBe(true);
  });
  it("interior lines are masked NON-confident (kept for the mention guard, never dropped outright)", () => {
    const lines = ["s := `line one", "run(1) is just raw text here", "line three`"];
    const st = blockCommentLineStates(lines, "a.go");
    expect(st.masked[1]).toBe(true);
    expect(st.confident[1]).toBe(false);
  });
  it("control: a same-line-closing Go raw string is unaffected", () => {
    const lines = ["s := `hello`", "run(1)"];
    expect(computeBlockCommentMask(lines, "a.go")).toEqual([false, false]);
    expect(isCallSiteRespectingCommentMask("a.go", "run", lines, 2)).toBe(true);
  });
  it("control: gated to Go -- an unrelated language with an unclosed backtick-lookalike is unaffected by this specific tracking (no cross-line arming beyond its own existing rules)", () => {
    const lines = ["s = `line one", "run(1)"];
    expect(computeBlockCommentMask(lines, "a.py")).toEqual([false, false]);
  });
});

// ---------------------------------------------------------------------------
// C5 (rustLifetimeFalseString): a Rust ' opens a char literal only when it
// closes as one.
// ---------------------------------------------------------------------------

describe("C5: Rust lifetimes/labels are never read as strings", () => {
  it("a generic lifetime parameter does not swallow a real call later on the line", () => {
    expect(isCallSite("a.rs", "run", ["fn f<'a>(x: &'a str) { run(1); }"], 1)).toBe(true);
  });
  it("'static and a loop label are also left alone", () => {
    expect(isCallSite("a.rs", "run", ["fn f(x: &'static str) { run(1); }"], 1)).toBe(true);
    expect(isCallSite("a.rs", "run", ["'outer: loop { run(1); }"], 1)).toBe(true);
  });
  it("two lifetimes on one line never swallow a real call BETWEEN them", () => {
    expect(isCallSite("a.rs", "run", ["fn f<'a, 'b>(x: &'a run(1), y: &'b str) {}"], 1)).toBe(true);
  });
  it("a real char literal is still masked ('a', escapes, unicode escapes)", () => {
    const masked = maskNonCode("let c = 'a'; get(c);", false, "a.rs");
    expect(masked).not.toContain("'a'");
    expect(isCallSite("a.rs", "get", ["let c = 'a'; get(c);"], 1)).toBe(true);
  });
  it("an escaped-quote char literal ('\\'') is still masked and does not hide the call after it", () => {
    expect(isCallSite("a.rs", "run", ["let c = '\\''; run(1);"], 1)).toBe(true);
  });
  it("a unicode escape char literal is still masked", () => {
    expect(isCallSite("a.rs", "run", ["let e = '\\u{1F600}'; run(1);"], 1)).toBe(true);
  });
  it("control: gated to Rust -- a single-quoted string in a language that has them is unaffected", () => {
    const masked = maskNonCode("x = 'run(1)'", false, "a.py");
    expect(masked).not.toContain("run(1)");
  });
});

// ---------------------------------------------------------------------------
// C6 (rubyRegexSlashStarFalseComment): /* */ block comments exist only in
// languages that have them -- never in Python, Ruby, shell-like files.
// ---------------------------------------------------------------------------

describe("C6: /* */ never opens in a language that has no such syntax", () => {
  it("a Ruby regex literal containing /* does not mask the rest of the FILE", () => {
    const lines = ["re = /\\/*/", "run(1)"];
    const mask = computeBlockCommentMask(lines, "a.rb");
    expect(mask).toEqual([false, false]);
    expect(isCallSiteRespectingCommentMask("a.rb", "run", lines, 2)).toBe(true);
  });
  it("control: the SAME text in a language that DOES have /* */, and has no JS/TS-style regex-literal awareness (Java), still opens a comment as before -- this fix is additive, not a behaviour change for languages with real block comments (a JS/TS file is unaffected for a DIFFERENT, pre-existing reason: round 7's own regexClassSlashStarHidesCallers fix already recognizes the whole /.../ as a regex literal first)", () => {
    const lines = ["re = /\\/*/", "run(1)"];
    const mask = computeBlockCommentMask(lines, "a.java");
    expect(mask).toEqual([false, true]); // unchanged prior (pre-existing, accepted) behaviour: the "/*" still opens
  });
  it("a Python path/glob containing /* does not mask the rest of the file", () => {
    const lines = ["path = \"/tmp/*\"", "run(1)"];
    // the quoted case was always safe (string masking already protects it); the
    // unquoted case is the one C6 exists for:
    const lines2 = ["path=/tmp/*", "run(1)"];
    expect(computeBlockCommentMask(lines2, "a.py")).toEqual([false, false]);
    expect(computeBlockCommentMask(lines, "a.py")).toEqual([false, false]);
  });
  it("a shell path containing /* does not mask the rest of the file", () => {
    const lines = ["path=/tmp/*", "run(1)"];
    expect(computeBlockCommentMask(lines, "a.sh")).toEqual([false, false]);
    expect(isCallSiteRespectingCommentMask("a.sh", "run", lines, 2)).toBe(true);
  });
  it("a Python multi-line-call continuation starting with * is not mistaken for a doc-comment continuation", () => {
    const masked = maskNonCode("*run(x),", false, "a.py");
    expect(masked).toContain("run(x)");
  });
  it("control: Python's own # comment and triple-quote docstring rules are unchanged", () => {
    expect(isCallSite("a.py", "run", ["# run(1) documented"], 1)).toBe(false);
    const lines = ["\"\"\"", "run(1) documented", "\"\"\"", "run(2)"];
    const st = blockCommentLineStates(lines, "a.py");
    expect(st.masked).toEqual([true, true, true, false]);
  });
  it("control: Ruby's own # comment and =begin/=end rules are unchanged", () => {
    expect(isCallSite("a.rb", "run", ["# run(1) documented"], 1)).toBe(false);
    const lines = ["=begin", "run(1) documented", "=end"];
    expect(computeBlockCommentMask(lines, "a.rb")).toEqual([true, true, true]);
  });
});

// ---------------------------------------------------------------------------
// C7 (pyPrefixedTripleQuoteConfident): a prefixed Python triple-quoted
// opener at line start is CONFIDENT like an unprefixed one.
// ---------------------------------------------------------------------------

describe("C7: a prefixed Python triple-quote opener is confident", () => {
  it("r''' at line start is confident, exactly like an unprefixed one", () => {
    const lines = ["def f():", "    r'''", "    run(1)", "    '''", "    return 1"];
    const st = blockCommentLineStates(lines, "a.py");
    expect(st.masked[2]).toBe(true);
    expect(st.confident[2]).toBe(true);
    expect(isCallSiteRespectingCommentMask("a.py", "run", lines, 3)).toBe(false);
  });
  // PIN MOVED (R9-A, round-9 wave, 2026-09-29, eval-0927 review-r8 P1-5,
  // pyFstringTripleLineStartCaller): an `f`/`F` prefix (alone, `rf`, `fr`, or
  // any case combination) is no longer in this "confident" list -- an
  // f-string's `{…}` replacement fields are live code (a real call can sit
  // inside one, `f"""{run(1)}"""`), so round 9 makes its interior a
  // disclosed MENTION instead of a silently dropped docstring. A bare
  // `r`/`b`/`u` prefix (no `f`) is UNCHANGED -- still exactly as confident as
  // an unprefixed opener.
  it("every non-f prefix is confident (r, b, u, rb, and case variants)", () => {
    for (const prefix of ["r", "R", "b", "B", "u", "U", "rb", "Rb", "rB", "RB", "br", "Br", "bR", "BR"]) {
      const lines = [`${prefix}'''`, "interior", "'''"];
      const st = blockCommentLineStates(lines, "a.py");
      expect(st.confident, `prefix ${prefix}`).toEqual([true, true, true]);
    }
  });
  it("every f-string prefix (f, F, rf, fr, any case) is NOT confident -- its interior is a mention, never a dropped docstring", () => {
    for (const prefix of ["f", "F", "rf", "fr", "RF", "FR", "Rf", "fR"]) {
      const lines = [`${prefix}'''`, "interior", "'''"];
      const st = blockCommentLineStates(lines, "a.py");
      // The opener line itself is left UNMASKED when `docConfident` is false
      // (the same pre-existing precedent an unrecognized/non-whitespace
      // prefix already followed -- see the "real code before the prefix"
      // control below); the interior and closer lines are still `masked`
      // (this scan still knows it is inside SOME triple-quoted span), just
      // never `confident`.
      expect(st.masked, `prefix ${prefix}`).toEqual([false, true, true]);
      expect(st.confident, `prefix ${prefix}`).toEqual([false, false, false]);
    }
  });
  it("leading whitespace before the prefix is still confident", () => {
    const lines = ["    b\"\"\"", "interior", "\"\"\""];
    const st = blockCommentLineStates(lines, "a.py");
    expect(st.confident).toEqual([true, true, true]);
  });
  it("control: an unprefixed opener stays confident (unchanged)", () => {
    const lines = ["'''", "interior", "'''"];
    expect(blockCommentLineStates(lines, "a.py").confident).toEqual([true, true, true]);
  });
  it("control: real code before the prefix (not just whitespace) is still NOT confident", () => {
    const lines = ["x = r'''", "interior", "'''"];
    const st = blockCommentLineStates(lines, "a.py");
    expect(st.masked[0]).toBe(false); // real code shares the opener line
    expect(st.confident).toEqual([false, false, false]);
  });
  it("control: gated to Python -- .pyi is also covered (same extension set)", () => {
    const lines = ["r'''", "interior", "'''"];
    expect(blockCommentLineStates(lines, "a.pyi").confident).toEqual([true, true, true]);
  });
});
