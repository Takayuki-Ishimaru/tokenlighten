/**
 * lineClassify.spec.ts — unit tests for the parse-free comment/line
 * classification backing the locator's comment-only-match precision penalty.
 */

import { describe, it, expect } from "vitest";
import {
  classifyCommentLines,
  commentSyntaxIsKnown,
  commentSyntaxLanguageForPath,
  matchesAreCommentOnly,
} from "../util/lineClassify.js";
import { languageForPath } from "../util/languages.js";

describe("classifyCommentLines", () => {
  it("flags line-comment lines and leaves code lines unflagged (C-style)", () => {
    const text = [
      "const x = 1;",       // 1: code
      "// a comment",       // 2: comment
      "  // indented comment", // 3: comment
      "foo();",             // 4: code
    ].join("\n");
    const flags = classifyCommentLines(text, "typescript");
    expect(flags).toEqual([false, true, true, false]);
  });

  it("tracks a multi-line block comment across lines", () => {
    const text = [
      "code();",            // 1: code
      "/* start of block",  // 2: comment (opener)
      " * middle banner",   // 3: comment (inside block)
      " still inside",      // 4: comment (inside block)
      "*/",                 // 5: comment (closer)
      "afterBlock();",      // 6: code
    ].join("\n");
    const flags = classifyCommentLines(text, "typescript");
    expect(flags).toEqual([false, true, true, true, true, false]);
  });

  it("handles a single-line block comment without leaking state to later lines", () => {
    const text = [
      "/* one-liner */",    // 1: comment, closes same line
      "realCode();",        // 2: code (must NOT be treated as in-block)
    ].join("\n");
    const flags = classifyCommentLines(text, "typescript");
    expect(flags).toEqual([true, false]);
  });

  it("uses # for python/ruby-style line comments", () => {
    const text = [
      "x = 1",              // 1: code
      "# a python comment", // 2: comment
    ].join("\n");
    expect(classifyCommentLines(text, "python")).toEqual([false, true]);
  });

  it("a comment that opens AFTER code on the same line does not flag that line", () => {
    const text = [
      "foo(); // trailing note",  // 1: first non-ws is code -> not flagged
    ].join("\n");
    expect(classifyCommentLines(text, "typescript")).toEqual([false]);
  });

  it("a BLOCK comment that opens after code still tracks inBlock for its continuation lines", () => {
    // Regression: the block-comment opener check only recognized `/*` as the
    // first non-whitespace on a line, so a block comment opened mid-line
    // (real code before `/*`, e.g. `bar(); /* start of a`) never set
    // `inBlock` — its continuation lines (which carry NO code at all, fully
    // inside the comment) fell through to "not a comment", contradicting the
    // module doc's "a block comment opens/continues on it" bullet. The
    // OPENING line itself must still read as code (documented, unchanged);
    // only the fully-inside continuation lines were the gap.
    const text = [
      "bar(); /* start of a",       // 1: code (opener line, not flagged)
      "priorityChip lives here",   // 2: comment — fully inside the block
      "end */",                     // 3: comment — closer
      "afterBlock();",              // 4: code
    ].join("\n");
    const flags = classifyCommentLines(text, "typescript");
    expect(flags).toEqual([false, true, true, false]);
  });

  it("a mid-line /* mentioned inside a // line comment does not falsely open a block", () => {
    // The mid-line-opener detection must not fire on a `/*`-looking
    // substring that only appears inside an ALREADY-recognized line comment
    // (prose describing comment syntax) — only a genuine, unclosed `/*`
    // outside any recognized comment prefix opens a block.
    const text = [
      "// see /* example syntax note",  // 1: line comment (prefix-recognized)
      "realCode();",                    // 2: code — must NOT be swallowed
    ].join("\n");
    expect(classifyCommentLines(text, "typescript")).toEqual([true, false]);
  });

  it("unknown language: no line-comment prefixes, nothing flagged", () => {
    const text = ["anything here", "// not a comment in an unknown lang"].join("\n");
    expect(classifyCommentLines(text, "default")).toEqual([false, false]);
  });
});

describe("matchesAreCommentOnly", () => {
  const flags = [false, true, true, false, true]; // lines 2,3,5 are comments
  it("true when every match line is a comment line", () => {
    expect(matchesAreCommentOnly([2, 3], flags)).toBe(true);
    expect(matchesAreCommentOnly([2, 5], flags)).toBe(true);
  });
  it("false when any match line is a code line", () => {
    expect(matchesAreCommentOnly([2, 4], flags)).toBe(false);
    expect(matchesAreCommentOnly([1], flags)).toBe(false);
  });
  it("false for an empty match list (no evidence)", () => {
    expect(matchesAreCommentOnly([], flags)).toBe(false);
  });
  it("out-of-range lines are treated as non-comment (defensive)", () => {
    expect(matchesAreCommentOnly([999], flags)).toBe(false);
  });
});

/**
 * SHOULD-FIX 28 (2026-09-14, review round 4) — the module's OWN extension map.
 *
 * Review round 3 NOTE 30 measured that 14 of the `LINE_COMMENT_PREFIXES` rows
 * were unreachable: every honesty consumer resolved its language through
 * `util/languages.ts`'s grammar map, which does not map `.swift`, `.sql`, `.ini`
 * and friends — so those rows could neither be produced nor tested through a
 * caller, and a located Swift declaration read as "unknown language".
 * `commentSyntaxLanguageForPath` is the supplement; these cases pin exactly what
 * it does and does not claim to know.
 */
describe("commentSyntaxLanguageForPath (SHOULD-FIX 28)", () => {
  it.each([
    ["src/feature.swift", "swift"],
    ["src/Feature.scala", "scala"],
    ["src/schema.sql", "sql"],
    ["src/mod.lua", "lua"],
    ["src/Mod.hs", "haskell"],
    ["src/pkg.adb", "ada"],
    ["src/settings.ini", "ini"],
    ["src/boot.asm", "asm"],
    ["src/core.lisp", "lisp"],
    ["src/mod.clj", "clojure"],
    ["src/mod.scm", "scheme"],
    ["src/init.el", "elisp"],
    ["src/conf.json5", "json5"],
    ["src/theme.scss", "scss"],
    ["src/theme.less", "less"],
    ["src/feed.xml", "xml"],
    ["src/icon.svg", "svg"],
    ["src/App.vue", "vue"],
  ])("resolves %s to %s, and the comment table knows it", (relPath, expected) => {
    const resolved = commentSyntaxLanguageForPath(relPath, languageForPath(relPath));
    expect(resolved).toBe(expected);
    expect(commentSyntaxIsKnown(resolved)).toBe(true);
  });

  it.each([
    ["bin/tool"],
    ["Makefile"],
    ["Dockerfile"],
    ["src/plugin.zzz"],
    ["src/app.dart"],
    ["src/deploy.tf"],
    ["src/query.graphql"],
  ])("leaves %s unknown — an unclassified file is served, never certified", (relPath) => {
    const resolved = commentSyntaxLanguageForPath(relPath, languageForPath(relPath));
    expect(resolved).toBeUndefined();
    expect(commentSyntaxIsKnown(resolved)).toBe(false);
  });

  it("never overrides the caller's own resolver (the `.h` C++ content sniff keeps its authority)", () => {
    expect(commentSyntaxLanguageForPath("src/ekf.h", "cpp")).toBe("cpp");
    expect(commentSyntaxLanguageForPath("src/feature.swift", "typescript")).toBe("typescript");
  });

  it("a dotfile has no extension to read (leading dot is not a separator)", () => {
    expect(commentSyntaxLanguageForPath(".swift", undefined)).toBeUndefined();
  });
});
