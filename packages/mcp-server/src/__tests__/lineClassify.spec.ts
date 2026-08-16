/**
 * lineClassify.spec.ts — unit tests for the parse-free comment/line
 * classification backing the locator's comment-only-match precision penalty.
 */

import { describe, it, expect } from "vitest";
import { classifyCommentLines, matchesAreCommentOnly } from "../util/lineClassify.js";

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
