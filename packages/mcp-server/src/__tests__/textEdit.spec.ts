// textEdit.spec.ts — unit tests for applySingleEdit and its exported
// literal-backslash-escape recovery helpers (hasLiteralBackslashEscape,
// unescapeBackslashSequences).
//
// applySingleEdit is a pure string-in/string-out function — no filesystem
// I/O is needed to exercise it, so these tests call it directly in-memory.
//
// Coverage:
//   1. Baseline: plain search found -> applied, no normalizedEscapes flag.
//   2. Plain search not found, no escapes -> not-found error, no hint.
//   3. Literal \n uniquely matches after unescaping -> applied, normalizedEscapes
//      true, usedSearch/usedReplace are unescaped forms, content correct.
//   4. Replace-side normalization only happens when search side normalized.
//   5. Literal \n unescaped form matches MULTIPLE times -> error + hint, file
//      unchanged (result carries no `text`).
//   6. Literal \n unescaped form matches ZERO times -> not-found error + hint.
//   7. Raw match takes precedence: a file that genuinely contains the raw
//      two-character `\n` sequence matches directly, verbatim, without
//      normalization.
//   8. \t and \r variants.
//   9. hasLiteralBackslashEscape / unescapeBackslashSequences edge cases,
//      including the double-backslash (`\\n`) correctness wart.
//  10. Replace-side unescape gated on a shared escape class with the
//      recovered search (sharesLiteralEscapeClass); cross-class or `\\`-only
//      replaces stay verbatim.

import { describe, it, expect } from "vitest";
import {
  applySingleEdit,
  hasLiteralBackslashEscape,
  sharesLiteralEscapeClass,
  unescapeBackslashSequences,
} from "../write/textEdit.js";

describe("applySingleEdit — baseline", () => {
  it("1. plain search found -> applied, no normalizedEscapes flag", () => {
    const text = "const a = 1;\nconst b = 2;\n";
    const result = applySingleEdit(text, "const a = 1;", "const a = 100;");

    expect(result.ok).toBe(true);
    expect(result.text).toBe("const a = 100;\nconst b = 2;\n");
    expect(result.normalizedEscapes).toBeUndefined();
    expect(result.usedSearch).toBeUndefined();
    expect(result.usedReplace).toBeUndefined();
    expect(result.hint).toBeUndefined();
  });

  it("2. plain search not found, no escape sequences -> not-found error, no hint", () => {
    const text = "const a = 1;\nconst b = 2;\n";
    const result = applySingleEdit(text, "const z = 999;", "const z = 1000;");

    expect(result.ok).toBe(false);
    expect(result.code).toBe("not-found");
    expect(result.error).toBe("search string not found in file");
    expect(result.hint).toBeUndefined();
    expect(result.text).toBeUndefined();
    expect(result.normalizedEscapes).toBeUndefined();
  });
});

describe("applySingleEdit — unique indentation-drift recovery", () => {
  it("recovers a unique full-line block and preserves the file's base indentation", () => {
    const text = [
      "export function value() {",
      "    const current = 1;",
      "    return current;",
      "}",
      "",
    ].join("\n");
    const result = applySingleEdit(
      text,
      "  const current = 1;\n  return current;",
      "  const current = 2;\n  return current + 1;",
    );

    expect(result.ok).toBe(true);
    expect(result.normalizedWhitespace).toBe(true);
    expect(result.text).toContain("    const current = 2;\n    return current + 1;");
  });

  it("refuses when indentation-insensitive recovery is not unique", () => {
    const text = "  return value;\n    return value;\n";
    const result = applySingleEdit(text, "return value;", "return next;");

    expect(result.ok).toBe(false);
    expect(result.code).toBe("ambiguous");
    expect(result.text).toBeUndefined();
  });

  it("does not relax internal whitespace", () => {
    const result = applySingleEdit("const  value = 1;\n", "const value = 1;", "const value = 2;");
    expect(result.ok).toBe(false);
    expect(result.code).toBe("not-found");
  });
});

describe("applySingleEdit — literal-backslash-escape recovery (unique match)", () => {
  it("3. literal \\n uniquely matches after unescaping -> applied with normalizedEscapes + usedSearch/usedReplace", () => {
    // File genuinely contains a real newline between "foo" and "bar" — the
    // caller double-escaped and sent the literal two-character `\n` instead.
    const text = "prefix\nfoo\nbar\nsuffix\n";
    const rawSearch = "foo\\nbar"; // literal: f o o \ n b a r (8 chars, no real newline)
    const rawReplace = "FOO\\nBAR";

    const result = applySingleEdit(text, rawSearch, rawReplace);

    expect(result.ok).toBe(true);
    expect(result.normalizedEscapes).toBe(true);
    expect(result.usedSearch).toBe("foo\nbar");
    expect(result.usedReplace).toBe("FOO\nBAR");
    expect(result.text).toBe("prefix\nFOO\nBAR\nsuffix\n");
  });

  it("4. replace-side normalization applies ONLY because the search side needed it", () => {
    // Confirms the mechanism: replace also contains a literal \n and gets
    // unescaped too, but only ever reached via the search-side recovery path.
    const text = "line1\nline2\n";
    const result = applySingleEdit(text, "line1\\nline2", "REPLACED\\nTWO-LINES");

    expect(result.ok).toBe(true);
    expect(result.normalizedEscapes).toBe(true);
    expect(result.usedReplace).toBe("REPLACED\nTWO-LINES");
    expect(result.text).toBe("REPLACED\nTWO-LINES\n");
  });

  it("replace side is left untouched (no escapes) when search side normalizes", () => {
    // Sanity check that unescaping only ever touches the side(s) that
    // contain escapes — replace has none here and passes through as-is.
    const text = "alpha\nbeta\n";
    const result = applySingleEdit(text, "alpha\\nbeta", "GAMMA");

    expect(result.ok).toBe(true);
    expect(result.normalizedEscapes).toBe(true);
    expect(result.usedSearch).toBe("alpha\nbeta");
    expect(result.usedReplace).toBe("GAMMA");
    expect(result.text).toBe("GAMMA\n");
  });
});

describe("applySingleEdit — literal-backslash-escape recovery (unclean recovery)", () => {
  it("5. unescaped form matches MULTIPLE times -> ambiguous-flavored not-found error with hint, file unchanged", () => {
    // "foo\nbar" (real newline) appears twice after unescaping.
    const text = "foo\nbar\nfoo\nbar\n";
    const rawSearch = "foo\\nbar";

    const result = applySingleEdit(text, rawSearch, "REPLACED");

    expect(result.ok).toBe(false);
    // Implementation deliberately reports this as the ordinary not-found
    // code (not "ambiguous") even though the underlying cause is a
    // multiple-match unescaped variant — see textEdit.ts lines 163-171.
    expect(result.code).toBe("not-found");
    expect(result.error).toBe("search string not found in file");
    expect(result.hint).toBe(
      "search contained a literal backslash escape sequence (\\n/\\t/\\r); if you intended an actual newline/tab, check for double-escaping"
    );
    expect(result.text).toBeUndefined();
    expect(result.normalizedEscapes).toBeUndefined();
  });

  it("6. unescaped form matches ZERO times -> not-found error with hint", () => {
    const text = "completely unrelated content\nwith no matching text at all\n";
    const rawSearch = "foo\\nbar"; // unescapes to "foo\nbar", which isn't in the file either

    const result = applySingleEdit(text, rawSearch, "REPLACED");

    expect(result.ok).toBe(false);
    expect(result.code).toBe("not-found");
    expect(result.error).toBe("search string not found in file");
    expect(result.hint).toBe(
      "search contained a literal backslash escape sequence (\\n/\\t/\\r); if you intended an actual newline/tab, check for double-escaping"
    );
    expect(result.text).toBeUndefined();
  });
});

describe("applySingleEdit — raw match takes precedence over unescaping", () => {
  it("7. a file genuinely containing the raw two-char `\\n` sequence matches directly, verbatim, without normalization", () => {
    // Source-code-like content where `\n` is literal text inside a string
    // literal (e.g. a JS/TS string that itself embeds an escape sequence
    // as source text), not an actual newline byte.
    const text = 'const msg = "line1\\nline2";\nconsole.log(msg);\n';
    const rawSearch = 'const msg = "line1\\nline2";';
    const rawReplace = 'const msg = "line1\\nline2-updated";';

    const result = applySingleEdit(text, rawSearch, rawReplace);

    expect(result.ok).toBe(true);
    // Raw match found immediately (count >= 1 on the very first check) —
    // the escape-recovery branch must never even run, so none of its
    // fields are present.
    expect(result.normalizedEscapes).toBeUndefined();
    expect(result.usedSearch).toBeUndefined();
    expect(result.usedReplace).toBeUndefined();
    expect(result.text).toBe(
      'const msg = "line1\\nline2-updated";\nconsole.log(msg);\n'
    );
    // Verify the literal backslash-n survived verbatim (was NOT turned into
    // a real newline byte).
    expect(result.text).toContain("line1\\nline2-updated");
    expect(result.text).not.toContain("line1\nline2-updated");
  });
});

describe("applySingleEdit — \\t and \\r variants", () => {
  it("8a. literal \\t uniquely matches after unescaping -> applied with normalizedEscapes", () => {
    const text = "col1\tcol2\tcol3\n";
    const result = applySingleEdit(text, "col1\\tcol2", "COL1\\tCOL2");

    expect(result.ok).toBe(true);
    expect(result.normalizedEscapes).toBe(true);
    expect(result.usedSearch).toBe("col1\tcol2");
    expect(result.usedReplace).toBe("COL1\tCOL2");
    expect(result.text).toBe("COL1\tCOL2\tcol3\n");
  });

  it("8b. literal \\r uniquely matches after unescaping -> applied with normalizedEscapes", () => {
    // A lone CR (not part of CRLF) embedded mid-line. detectLineEnding will
    // classify this file as "\r"-terminated since there is no "\n" at all,
    // so the restored output uses \r for its (single) line ending.
    const text = "part1\rpart2\r";
    const result = applySingleEdit(text, "part1\\rpart2", "PART1\\rPART2");

    expect(result.ok).toBe(true);
    expect(result.normalizedEscapes).toBe(true);
    expect(result.usedSearch).toBe("part1\rpart2");
    expect(result.usedReplace).toBe("PART1\rPART2");
    // toLfNfc maps \r -> \n for matching, then the original line ending
    // (\r, since the file had no \n) is restored across the WHOLE result,
    // including inside the replacement.
    expect(result.text).toBe("PART1\rPART2\r");
  });

  it("8c. plain \\t search not found, unescaped variant not found either -> not-found + hint", () => {
    const text = "no tabs or matching text here\n";
    const result = applySingleEdit(text, "missing\\tvalue", "x");

    expect(result.ok).toBe(false);
    expect(result.code).toBe("not-found");
    expect(result.hint).toContain("literal backslash escape sequence");
  });
});

describe("applySingleEdit — replace-side unescape requires a shared escape class", () => {
  it("10a. replace escapes of a DIFFERENT class than the recovered search stay verbatim", () => {
    // Search recovers via \n; replace's only escape is a literal \t, which
    // may be intentional output text (e.g. source code building a TSV) —
    // it must be written byte-for-byte, not turned into a real tab.
    const text = "alpha\nbeta\n";
    const result = applySingleEdit(text, "alpha\\nbeta", "X\\tY");

    expect(result.ok).toBe(true);
    expect(result.normalizedEscapes).toBe(true);
    expect(result.usedReplace).toBe("X\\tY");
    expect(result.text).toBe("X\\tY\n");
    expect(result.text).not.toContain("\t");
  });

  it("10b. replace containing only an escaped backslash (no live letters) stays verbatim", () => {
    const text = "alpha\nbeta\n";
    const result = applySingleEdit(text, "alpha\\nbeta", "p\\\\q");

    expect(result.ok).toBe(true);
    expect(result.normalizedEscapes).toBe(true);
    expect(result.usedReplace).toBe("p\\\\q");
    expect(result.text).toBe("p\\\\q\n");
  });

  it("10c. a replace sharing ONE class with the search is unescaped wholesale (its other letters too)", () => {
    const text = "alpha\nbeta\n";
    const result = applySingleEdit(text, "alpha\\nbeta", "A\\nB\\tC");

    expect(result.ok).toBe(true);
    expect(result.usedReplace).toBe("A\nB\tC");
    expect(result.text).toBe("A\nB\tC\n");
  });

  it("10d. sharesLiteralEscapeClass direct unit tests, including the shielded-backslash scan", () => {
    expect(sharesLiteralEscapeClass("a\\nb", "c\\nd")).toBe(true);
    expect(sharesLiteralEscapeClass("a\\nb\\tc", "x\\ty")).toBe(true);
    expect(sharesLiteralEscapeClass("a\\nb", "c\\td")).toBe(false);
    expect(sharesLiteralEscapeClass("a\\nb", "plain")).toBe(false);
    expect(sharesLiteralEscapeClass("a\\nb", "p\\\\q")).toBe(false);
    expect(sharesLiteralEscapeClass("plain", "c\\nd")).toBe(false);
    // An escaped backslash shields the letter after it: `\`+`\`+`n` in the
    // replace is NOT a live \n escape, so it does not count as shared.
    expect(sharesLiteralEscapeClass("a\\nb", "x\\\\ny")).toBe(false);
  });
});

describe("hasLiteralBackslashEscape / unescapeBackslashSequences — direct unit tests", () => {
  it("detects \\n, \\t, \\r individually", () => {
    expect(hasLiteralBackslashEscape("foo\\nbar")).toBe(true);
    expect(hasLiteralBackslashEscape("foo\\tbar")).toBe(true);
    expect(hasLiteralBackslashEscape("foo\\rbar")).toBe(true);
  });

  it("returns false for text with no backslash-escape sequences", () => {
    expect(hasLiteralBackslashEscape("plain text, nothing special")).toBe(false);
    expect(hasLiteralBackslashEscape("")).toBe(false);
  });

  it("does NOT flag other escape letters (e.g. \\s, \\d, \\w) — only n/t/r", () => {
    expect(hasLiteralBackslashEscape("foo\\sbar")).toBe(false);
    expect(hasLiteralBackslashEscape("foo\\dbar")).toBe(false);
    expect(hasLiteralBackslashEscape("regex \\w+ pattern")).toBe(false);
  });

  it("unescapeBackslashSequences converts \\n/\\t/\\r to real control characters", () => {
    expect(unescapeBackslashSequences("a\\nb")).toBe("a\nb");
    expect(unescapeBackslashSequences("a\\tb")).toBe("a\tb");
    expect(unescapeBackslashSequences("a\\rb")).toBe("a\rb");
  });

  it("unescapeBackslashSequences leaves already-real control characters untouched", () => {
    expect(unescapeBackslashSequences("a\nb")).toBe("a\nb");
  });

  it("unescapeBackslashSequences handles multiple sequences in one string", () => {
    expect(unescapeBackslashSequences("a\\nb\\tc\\rd")).toBe("a\nb\tc\rd");
  });

  // --- Item 9: backslash-aware escape semantics --------------------------
  //
  // The helpers invert ONE level of string-escaping, left to right: an
  // escaped backslash (`\\`) collapses to a single backslash and shields the
  // character after it, so the 3-char sequence `\` `\` `n` decodes to the
  // 2-char literal text `\`+`n` — NOT a newline. Detection fires only when a
  // \n/\t/\r escape survives at an actual escape position (an odd backslash
  // run), so an escaped-backslash-then-n never triggers recovery by itself.
  it("9. escaped backslash shields the following n: `\\`+`\\`+`n` neither triggers detection nor decodes to a newline", () => {
    const doubleEscaped = "\\\\n"; // literal 3 chars: \  \  n
    expect(doubleEscaped.length).toBe(3);

    // The backslash before "n" is itself escaped — no live \n escape here.
    expect(hasLiteralBackslashEscape(doubleEscaped)).toBe(false);
    // But an escape that FOLLOWS a collapsed pair is live: \ \ \ n.
    expect(hasLiteralBackslashEscape("\\\\\\n")).toBe(true);

    // Decoding collapses the pair and keeps the n literal: 2 chars, no newline.
    const decoded = unescapeBackslashSequences(doubleEscaped);
    expect(decoded).toBe("\\n"); // backslash + letter n
    expect(decoded).not.toBe("\\\n"); // NOT backslash + real newline

    // Pair collapse + live escape together: \ \ \ n -> \ + newline.
    expect(unescapeBackslashSequences("\\\\\\n")).toBe("\\\n");
    // A lone escaped backslash collapses; unknown escapes stay verbatim.
    expect(unescapeBackslashSequences("a\\\\b")).toBe("a\\b");
    expect(unescapeBackslashSequences("a\\db")).toBe("a\\db");
  });

  it("9b. end-to-end: escaped-backslash search does not trigger recovery; mixed pair+escape decodes correctly", () => {
    // Non-trigger: raw search `head`+`\`+`\`+`n`+`tail` misses and contains
    // no LIVE \n escape — plain not-found, no escape hint, no normalization.
    const text = "head\\\ntail\n"; // head, backslash, real-newline, tail, newline
    const rawSearch = "head\\\\ntail"; // h e a d \ \ n t a i l
    const miss = applySingleEdit(text, rawSearch, "REPLACED");
    expect(miss.ok).toBe(false);
    expect(miss.code).toBe("not-found");
    expect(miss.error).not.toMatch(/backslash/);
    expect(miss.normalizedEscapes).toBeUndefined();

    // Mixed: `cfg` + `\`+`\` (escaped backslash) + `\n` (live escape) + `42`
    // decodes to cfg + \ + newline + 42, which matches the file uniquely.
    const text2 = "cfg\\\n42\n"; // c f g \ <newline> 4 2 <newline>
    const rawSearch2 = "cfg\\\\\\n42"; // c f g \ \ \ n 4 2
    expect(hasLiteralBackslashEscape(rawSearch2)).toBe(true);
    const hit = applySingleEdit(text2, rawSearch2, "CFG");
    expect(hit.ok).toBe(true);
    expect(hit.normalizedEscapes).toBe(true);
    expect(hit.usedSearch).toBe("cfg\\\n42");
    expect(hit.text).toBe("CFG\n");
  });
});

describe("applySingleEdit — other existing behaviors (context, not part of escape recovery)", () => {
  it("empty search string returns empty-search error", () => {
    const result = applySingleEdit("some content\n", "", "replacement");
    expect(result.ok).toBe(false);
    expect(result.code).toBe("empty-search");
  });

  it("plain ambiguous match (no escapes involved) returns ambiguous code, not not-found", () => {
    const text = "dup\ndup\n";
    const result = applySingleEdit(text, "dup", "single");
    expect(result.ok).toBe(false);
    expect(result.code).toBe("ambiguous");
    expect(result.hint).toBeUndefined();
  });
});
