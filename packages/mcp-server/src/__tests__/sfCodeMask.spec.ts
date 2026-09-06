// ---------------------------------------------------------------------------
// sfCodeMask.spec.ts — SF-5 residuals (round 11) for
// `features/task-pack/sfCodeMask.ts`'s `maskCommentsAndStrings`.
//
// This masker sits directly ahead of `qualifiedAnchorSiteKind`
// (readCodeTaskPack.ts) on the DEFAULT, unflagged D5 wire path: a false
// definition seeds a pack with a file that cannot answer the caller's
// question, and an over-eager mask can hide a REAL definition just as badly
// (the opposite failure mode, and just as dishonest). Three residuals from
// round 11:
//
//   1. Nested block comments (Rust/Swift/Scala): `/* /* */ still comment */`
//      used to unmask at the FIRST `*/`, leaving the tail as real code.
//   2. A regex literal containing its own `//` (e.g. `/[//]/`) used to be
//      misread as a line comment starting at the embedded `//`, silently
//      masking (hiding) whatever real code followed on the same line.
//   3. Rust raw strings (`r#"..."#`) were not recognized as strings at all.
//
// This file tests the masker directly and exhaustively; the previously
// existing cases (unterminated comment/string, empty input) already live in
// sfConcerns.spec.ts and are NOT duplicated here — this file is additive,
// scoped to the round-11 fixes plus enough surrounding coverage to prove
// they do not regress any adjacent shape.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { maskCommentsAndStrings } from "../features/task-pack/sfCodeMask.js";

/** The masker's own invariant: same length, same newline positions, always. */
function assertLengthAndNewlinesPreserved(source: string, masked: string): void {
  expect(masked.length).toBe(source.length);
  const sourceNewlines = [...source].map((ch, i) => (ch === "\n" ? i : -1)).filter((i) => i >= 0);
  const maskedNewlines = [...masked].map((ch, i) => (ch === "\n" ? i : -1)).filter((i) => i >= 0);
  expect(maskedNewlines).toEqual(sourceNewlines);
}

describe("maskCommentsAndStrings — baseline shapes (guards against regressing while fixing SF-5)", () => {
  it("masks a single-line block comment", () => {
    const source = "int x = /* five */ 5;";
    const masked = maskCommentsAndStrings(source);
    assertLengthAndNewlinesPreserved(source, masked);
    expect(masked).not.toContain("five");
    expect(masked).toContain("int x =");
    expect(masked).toContain("5;");
  });

  it("masks a `//` line comment but not code before it", () => {
    const source = "run(); // calls isHealthy() but does not\n";
    const masked = maskCommentsAndStrings(source);
    assertLengthAndNewlinesPreserved(source, masked);
    expect(masked).toContain("run();");
    expect(masked).not.toContain("isHealthy");
  });

  it("keeps a #include directive but masks an ordinary # comment", () => {
    const source = '#include "estimator/ekf.hpp"\n# a shell-style comment mentioning EKF::isHealthy()\n';
    const masked = maskCommentsAndStrings(source);
    assertLengthAndNewlinesPreserved(source, masked);
    // `#include` is exempt from `#`-comment masking (it is not a comment at
    // all) — the STRING that follows it is still masked, same as any other
    // string literal; only the directive keyword itself must survive.
    expect(masked.split("\n")[0]).toMatch(/^#include\s+$/);
    expect(masked.split("\n")[1]).not.toContain("isHealthy");
  });

  it("masks a SQL/Lua-style -- comment but never a C-family decrement", () => {
    const source = "i--; -- EKF::isHealthy() const { return true; }\n";
    const masked = maskCommentsAndStrings(source);
    assertLengthAndNewlinesPreserved(source, masked);
    expect(masked).toContain("i--;");
    expect(masked).not.toContain("isHealthy");
  });

  it("masks a triple-quoted docstring across multiple lines", () => {
    const source = 'x = """\nEKF::isHealthy() const { return true; }\n"""\n';
    const masked = maskCommentsAndStrings(source);
    assertLengthAndNewlinesPreserved(source, masked);
    expect(masked).not.toContain("isHealthy");
  });

  it("masks a template literal across multiple lines", () => {
    const source = "const s = `\nEKF::isHealthy() const { return true; }\n`;\n";
    const masked = maskCommentsAndStrings(source);
    assertLengthAndNewlinesPreserved(source, masked);
    expect(masked).not.toContain("isHealthy");
    expect(masked).toContain("const s =");
  });

  it("masks a single-line string literal but leaves an unterminated one alone", () => {
    const quoted = 'bool ok = "EKF::isHealthy() const { return true; }";\n';
    const maskedQuoted = maskCommentsAndStrings(quoted);
    assertLengthAndNewlinesPreserved(quoted, maskedQuoted);
    expect(maskedQuoted).not.toContain("isHealthy");

    const unterminated = 'const note = "don\'t lose the rest of the file\nEKF::isHealthy() const { return true; }\n';
    const maskedUnterminated = maskCommentsAndStrings(unterminated);
    assertLengthAndNewlinesPreserved(unterminated, maskedUnterminated);
    // The unterminated quote is left alone — masking must NOT swallow the
    // real definition on the following line.
    expect(maskedUnterminated).toContain("isHealthy");
  });
});

describe("maskCommentsAndStrings — SF-5 residual 1: nested block comments", () => {
  const NESTED = "/* outer /* inner */ still comment */\nbool EKF::isHealthy() const { return true; }\n";

  it("default (no language hint): stops at the FIRST */, matching non-nesting languages — unchanged, still the default wire behavior", () => {
    const masked = maskCommentsAndStrings(NESTED);
    assertLengthAndNewlinesPreserved(NESTED, masked);
    // " still comment */" on line 1 is left as real (unmasked) text, exactly
    // as it always was — this is correct for C/C++/JS/TS, where /* */ does
    // not nest, so the first */ genuinely does end the comment.
    expect(masked.split("\n")[0]).toContain("still comment");
  });

  it("language:'rust' tracks nesting depth: the WHOLE nested comment is masked, and the real definition on line 2 is untouched", () => {
    const masked = maskCommentsAndStrings(NESTED, { language: "rust" });
    assertLengthAndNewlinesPreserved(NESTED, masked);
    expect(masked.split("\n")[0]).not.toContain("still comment");
    expect(masked).toContain("bool EKF::isHealthy() const { return true; }");
  });

  it("language:'swift' and language:'scala' get the same nesting-aware treatment", () => {
    for (const language of ["swift", "scala", "SWIFT", "Scala"]) {
      const masked = maskCommentsAndStrings(NESTED, { language });
      expect(masked.split("\n")[0]).not.toContain("still comment");
    }
  });

  it("an unrecognized language hint falls back to the legacy, non-nesting behavior", () => {
    const masked = maskCommentsAndStrings(NESTED, { language: "python" });
    expect(masked.split("\n")[0]).toContain("still comment");
  });

  it("a doubly-nested comment is fully masked under a nesting language", () => {
    const doubly = "/* a /* b /* c */ b */ a */\nreal();\n";
    const masked = maskCommentsAndStrings(doubly, { language: "rust" });
    assertLengthAndNewlinesPreserved(doubly, masked);
    expect(masked.split("\n")[0].trim()).toBe("");
    expect(masked).toContain("real();");
  });
});

describe("maskCommentsAndStrings — SF-5 residual 2: regex literals never fabricate a line comment", () => {
  it("a character-class regex containing // does not swallow the rest of the line (the exact reported shape)", () => {
    const source = 'const re = /[//]/; bool EKF::isHealthy() const { return true; }\n';
    const masked = maskCommentsAndStrings(source);
    assertLengthAndNewlinesPreserved(source, masked);
    expect(masked).toContain("bool EKF::isHealthy() const { return true; }");
  });

  it("recognizes a regex literal after common punctuator contexts (=, (, comma, colon, [, !, ?, {, }, ;, &&, ||, return, line start)", () => {
    const cases = [
      "const re = /a\\/b/;",
      "test(/a\\/b/);",
      "fn(a, /a\\/b/);",
      "const o = { key: /a\\/b/ };",
      "const arr = [/a\\/b/];",
      "if (!/a\\/b/.test(x)) {}",
      "const truthy = cond && /a\\/b/.test(x);",
      "const truthy2 = cond || /a\\/b/.test(x);",
      "const t = cond ? /a\\/b/ : /c\\/d/;",
      "function f() { return /a\\/b/; }",
      "/a\\/b/.test(x);",
    ];
    for (const source of cases) {
      const masked = maskCommentsAndStrings(source);
      assertLengthAndNewlinesPreserved(source, masked);
      // The regex literal's own internal `/` must never be misread as
      // starting a line comment that erases the rest of the source — a
      // fabricated comment would blank everything from the SECOND `/`
      // onward, so the source's own closing punctuation would vanish.
      expect(masked.trimEnd().endsWith(source.trimEnd().slice(-1))).toBe(true);
    }
  });

  it("still masks a genuine line comment that merely follows a regex-friendly context", () => {
    const source = "const x = 1; // isHealthy() is not actually called here\n";
    const masked = maskCommentsAndStrings(source);
    assertLengthAndNewlinesPreserved(source, masked);
    expect(masked).toContain("const x = 1;");
    expect(masked).not.toContain("isHealthy");
  });

  it("does not misread ordinary division as a regex literal", () => {
    const source = "const ratio = total / count;\n";
    const masked = maskCommentsAndStrings(source);
    expect(masked).toBe(source);
  });

  it("does not misread division immediately after a variable named similarly to 'return'", () => {
    const source = "const notreturn = a / b;\n";
    const masked = maskCommentsAndStrings(source);
    expect(masked).toBe(source);
  });

  it("leaves an unterminated / alone rather than guessing", () => {
    const source = "const half = a / b; // real division, not a regex\n";
    const masked = maskCommentsAndStrings(source);
    expect(masked).toContain("const half = a / b;");
    expect(masked).not.toContain("real division");
  });
});

describe("maskCommentsAndStrings — SF-5 residual 3: Rust raw strings", () => {
  it("masks a zero-hash raw string r\"...\"", () => {
    const source = 'let s = r"EKF::isHealthy() const { return true; }";\n';
    const masked = maskCommentsAndStrings(source);
    assertLengthAndNewlinesPreserved(source, masked);
    expect(masked).not.toContain("isHealthy");
    expect(masked).toContain("let s =");
  });

  it("masks a single-hash raw string r#\"...\"# whose content contains an unescaped quote", () => {
    const source = 'let s = r#"say "EKF::isHealthy()" now"#;\nbool EKF::isHealthy() const { return true; }\n';
    const masked = maskCommentsAndStrings(source);
    assertLengthAndNewlinesPreserved(source, masked);
    expect(masked.split("\n")[0]).not.toContain("isHealthy");
    // The REAL definition on line 2 is untouched.
    expect(masked).toContain("bool EKF::isHealthy() const { return true; }");
  });

  it("matches the closer's hash count exactly — r##\"...\"## is not closed by a single-hash \"#", () => {
    const source = 'let s = r##"contains "# a single hash-quote" then closes"##;\n';
    const masked = maskCommentsAndStrings(source);
    assertLengthAndNewlinesPreserved(source, masked);
    expect(masked).not.toContain("contains");
    expect(masked).not.toContain("closes");
  });

  it("does not mis-fire on an ordinary identifier ending in r followed by an unrelated token", () => {
    const source = 'const r = 5;\nconst counter = 5;\n';
    const masked = maskCommentsAndStrings(source);
    expect(masked).toBe(source);
  });
});

describe("maskCommentsAndStrings — options default is additive-only (backward compatible)", () => {
  it("options defaults to {} and every existing call site (no second argument) is unaffected", () => {
    const source = "/* /* nested */ tail */\nreal();\n";
    expect(maskCommentsAndStrings(source)).toBe(maskCommentsAndStrings(source, {}));
  });
});
