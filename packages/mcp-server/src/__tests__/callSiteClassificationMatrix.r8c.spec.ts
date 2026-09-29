/**
 * callSiteClassificationMatrix.r8c.spec.ts — round 8 (R8-C) extension of the
 * declaration-vs-call regression fence (eval-0927 review-r7 round-8 findings
 * P2-8: phpHashCommentFalseCaller, ktNestedSingleLineFalseCaller,
 * rustLifetimeFalseString, rubyRegexSlashStarFalseComment). Same format and
 * `classify` helper as callSiteClassificationMatrix.r5.spec.ts/.r7c.spec.ts:
 * each row is [id, relPath, identifier, lines, targetLine, expectDeclaration]
 * -- `expectDeclaration: true` means "never surfaces as a call" (masked away
 * entirely is an acceptable way to satisfy it, same convention as .r7c.spec.ts).
 * These cells are all SINGLE-LINE `maskNonCode` shapes (never touching the
 * file-level `blockCommentLineStates`/`computeBlockCommentMask` scan) -- the
 * file-level shapes (the JS/TS template-interior line, Go raw strings
 * spanning lines, the prefixed-Python-docstring confidence fix, and the
 * Ruby-regex-eats-the-rest-of-the-file case) are covered in
 * `evaluation0927.r8cLexer.spec.ts` instead, matching the r7c/r7cLexer split.
 */
import { describe, expect, it } from "vitest";

import { findCallOccurrences, hasHashComments, maskNonCode } from "../features/task-pack/callerExpansion.js";
import { callSiteOccurrenceIsDeclaration } from "../features/task-pack/readCodeTaskPack.js";

type Row = [string, string, string, string[], number, boolean];
const ROWS: Row[] = [
  // ---- C2 (phpHashCommentFalseCaller): PHP `#` is a line comment; `#[` is a PHP 8 attribute, never a comment.
  ["php-hash-comment-masks-call", "a.php", "run", ["# run($total) is documented"], 1, true],
  ["php-attribute-not-comment", "a.php", "run", ["#[Attribute] run($total);"], 1, false],
  ["php-double-slash-comment-unaffected", "a.php", "run", ["// run($total) documented"], 1, true],
  ["php-block-comment-unaffected", "a.php", "run", ["/* run($total) documented */"], 1, true],
  ["php-hash-comment-then-real-call", "a.php", "run", ["# note", "x = 1; run($total);"], 2, false],

  // ---- C3 (ktNestedSingleLineFalseCaller): nesting languages count `/* */` depth WITHIN one line too.
  ["kt-nested-single-line-hides-inner-exposes-outer", "a.kt", "run", ["/* old /* legacy */ run(1) still comment */ run(2)"], 1, false],
  ["kts-nested-single-line", "a.kts", "run", ["/* old /* legacy */ run(1) still comment */ run(2)"], 1, false],
  ["swift-nested-single-line", "a.swift", "run", ["/* old /* legacy */ run(1) still comment */ run(2)"], 1, false],
  ["rs-nested-single-line", "a.rs", "run", ["/* old /* legacy */ run(1) still comment */ run(2)"], 1, false],
  ["scala-nested-single-line", "a.scala", "run", ["/* old /* legacy */ run(1) still comment */ run(2)"], 1, false],
  ["sc-nested-single-line", "a.sc", "run", ["/* old /* legacy */ run(1) still comment */ run(2)"], 1, false],
  ["dart-nested-single-line", "a.dart", "run", ["/* old /* legacy */ run(1) still comment */ run(2)"], 1, false],
  ["c-non-nesting-control-both-exposed", "a.c", "run", ["/* old /* legacy */ run(1) still comment */ run(2)"], 1, false],
  ["java-non-nesting-control-both-exposed", "a.java", "run", ["/* old /* legacy */ run(1) still comment */ run(2)"], 1, false],

  // ---- C5 (rustLifetimeFalseString): a Rust `'` opens a char literal only when it actually closes as one.
  ["rs-lifetime-generic-param-not-string", "a.rs", "run", ["fn f<'a>(x: &'a str) { run(1); }"], 1, false],
  ["rs-static-lifetime-not-string", "a.rs", "run", ["fn f(x: &'static str) { run(1); }"], 1, false],
  ["rs-loop-label-not-string", "a.rs", "run", ["'outer: loop { run(1); }"], 1, false],
  ["rs-two-lifetimes-call-between-not-swallowed", "a.rs", "run", ["fn f<'a, 'b>(x: &'a run(1), y: &'b str) {}"], 1, false],
  ["rs-char-literal-still-masked", "a.rs", "get", ["let c = 'a'; get(c);"], 1, false],
  ["rs-escaped-quote-char-literal", "a.rs", "run", ["let c = '\\''; run(1);"], 1, false],
  ["rs-unicode-escape-char-literal", "a.rs", "run", ["let e = '\\u{1F600}'; run(1);"], 1, false],
  ["rs-byte-escape-char-literal", "a.rs", "run", ["let b = '\\x41'; run(1);"], 1, false],

  // ---- C6 (rubyRegexSlashStarFalseComment / no-block-comment languages): `/* */` never exists in Python, Ruby, shell.
  ["rb-regex-slash-star-same-line-call", "a.rb", "run", ["re = /\\/*/ ; run(1)"], 1, false],
  ["py-star-args-not-comment-continuation", "a.py", "run", ["*run(x),"], 1, false],
  ["sh-slash-star-path-not-a-comment", "a.sh", "run", ["path=/tmp/*; run(1)"], 1, false],
  ["py-hash-comment-still-masks", "a.py", "run", ["# run(1) documented"], 1, true],
  ["rb-hash-comment-still-masks", "a.rb", "run", ["# run(1) documented"], 1, true],
];

/** "call" / "declaration" per occurrence of `identifier` on the target line; [] = no occurrence at all. */
function classify(relPath: string, identifier: string, lines: readonly string[], targetLine: number): string[] {
  const hash = hasHashComments(relPath);
  const masked = maskNonCode(lines[targetLine - 1]!, hash, relPath);
  return findCallOccurrences(masked, identifier).map((occurrence) =>
    callSiteOccurrenceIsDeclaration(occurrence, masked, relPath, lines, targetLine, hash) ? "declaration" : "call");
}

describe("classifier matrix, round 8 (R8-C lexer shapes)", () => {
  for (const [id, relPath, identifier, lines, targetLine, expectDeclaration] of ROWS) {
    it(`${id}: ${lines[targetLine - 1]!.trim()}`, () => {
      const verdicts = classify(relPath, identifier, lines, targetLine);
      if (expectDeclaration) {
        // Never a call: masked away entirely (invisible) or classified as a declaration -- never a caller either way.
        expect(verdicts.every((verdict) => verdict === "declaration")).toBe(true);
      } else {
        expect(verdicts.length, "the call site is not even an occurrence").toBeGreaterThan(0);
        expect(verdicts.every((verdict) => verdict === "call")).toBe(true);
      }
    });
  }
});
