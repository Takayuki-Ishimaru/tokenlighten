/**
 * callSiteClassificationMatrix.r7c.spec.ts — round 7 (R7-C) extension of the
 * declaration-vs-call regression fence (eval-0927 review-r6 P1-6 class,
 * P2-9, P2-11 class). Same format and `classify` helper as
 * callSiteClassificationMatrix.r5.spec.ts: each row is [id, relPath,
 * identifier, lines, targetLine, expectDeclaration]. These cells are all
 * SINGLE-LINE `maskNonCode` shapes (never touching the file-level
 * `blockCommentLineStates`/`computeBlockCommentMask` scan) — the file-level
 * shapes (nested block comments, Ruby `=begin`/`=end`, the regex-hides-a-
 * later-comment class) are covered in `evaluation0927.r7cLexer.spec.ts`
 * instead, since they need multi-line input processed through the file-level
 * scan first.
 */
import { describe, expect, it } from "vitest";

import { findCallOccurrences, hasHashComments, maskNonCode } from "../features/task-pack/callerExpansion.js";
import { callSiteOccurrenceIsDeclaration } from "../features/task-pack/readCodeTaskPack.js";

type Row = [string, string, string, string[], number, boolean];
const ROWS: Row[] = [
  // ---- C3 (P2-11 class): a block-comment CLOSER line carrying real code.
  ["c-closer-with-trailing-code", "a.c", "run", ["*/ run(2);"], 1, false],
  ["c-closer-with-leading-ws", "a.c", "run", ["   */ run(2);"], 1, false],
  ["c-closer-then-two-statements", "a.c", "run", ["*/ x = 1; run(2);"], 1, false],
  // ---- C3: a same-line /* ... */ comment keeps code after the closer.
  ["c-sameline-comment-then-call", "a.c", "run", ["/* note */ run(2);"], 1, false],
  ["c-sameline-comment-code-before-and-after", "a.c", "run", ["x = 1; /* note */ run(2);"], 1, false],
  // ---- C3: postfix -- / ++ before a slash is division, never a regex opener.
  ["ts-postfix-dec-div-string-call", "a.ts", "run", ["x = a-- / 2; s = \"a/b\"; run(1);"], 1, false],
  ["ts-postfix-inc-div-string-call", "a.ts", "run", ["x = a++ / 2; s = \"a/b\"; run(1);"], 1, false],
  // ---- C2: Ruby %-literals are inert text -- no occurrence survives masking.
  ["rb-percent-q-nested-paren", "a.rb", "run", ["s = %q(run(1) text)"], 1, true],
  ["rb-percent-cap-q-bracket", "a.rb", "run", ["s = %Q[run(1) text]"], 1, true],
  ["rb-percent-bare-paren", "a.rb", "run", ["s = %(run(1) text)"], 1, true],
  ["rb-percent-w-array", "a.rb", "run", ["s = %w(run(1) text)"], 1, true],
  ["rb-percent-i-array", "a.rb", "run", ["s = %i(run(1) text)"], 1, true],
  ["rb-percent-then-real-call", "a.rb", "run", ["x = %q(text); run(1)"], 1, false],
  // ---- C2: a backtick template nested inside a ${…} field is inert text.
  ["ts-nested-template-in-field", "a.ts", "run", ["const s = `a ${`literal run(x) text`} b`;"], 1, true],
  ["ts-nested-template-outer-call-survives", "a.ts", "run", ["const s = `${run(1)} and ${`nested run(2) text`}`;"], 1, false],
];

/** "call" / "declaration" per occurrence of `identifier` on the target line; [] = no occurrence at all. */
function classify(relPath: string, identifier: string, lines: readonly string[], targetLine: number): string[] {
  const hash = hasHashComments(relPath);
  const masked = maskNonCode(lines[targetLine - 1]!, hash, relPath);
  return findCallOccurrences(masked, identifier).map((occurrence) =>
    callSiteOccurrenceIsDeclaration(occurrence, masked, relPath, lines, targetLine, hash) ? "declaration" : "call");
}

describe("classifier matrix, round 7 (R7-C lexer shapes)", () => {
  for (const [id, relPath, identifier, lines, targetLine, expectDeclaration] of ROWS) {
    it(`${id}: ${lines[targetLine - 1]!.trim()}`, () => {
      const verdicts = classify(relPath, identifier, lines, targetLine);
      if (expectDeclaration) {
        // A declaration may also be simply invisible (no call occurrence at all): never a caller either way.
        expect(verdicts.every((verdict) => verdict === "declaration")).toBe(true);
      } else {
        expect(verdicts.length, "the call site is not even an occurrence").toBeGreaterThan(0);
        expect(verdicts.every((verdict) => verdict === "call")).toBe(true);
      }
    });
  }
});
