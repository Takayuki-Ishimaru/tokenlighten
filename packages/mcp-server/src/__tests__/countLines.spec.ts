import { describe, it, expect } from "vitest";
import { countLines } from "../util/countLines.js";

// ---------------------------------------------------------------------------
// countLines.spec.ts — exhaustive coverage for util/countLines.ts.
//
// Bug this guards against (bench transcript forensics, 2026-07-03):
// raw.split(/\r?\n/).length counts a PHANTOM final empty segment for content
// ending in a trailing newline (nearly every file on disk) — a 50-line file
// yielded lineCount=51, minting a task_pack handle range "1-51" that
// edit_code's own bounds check then rejected as out of bounds for a 50-line
// file. countLines() must be trailing-newline aware and must agree EXACTLY
// with the two existing production bounds-check implementations:
// applyEditsMulti.ts's countLogicalLinesEntry() and write/rangeEdit.ts's
// countLogicalLines() (both verified byte-identical to this module before
// this fix — see those files' own local copies, now candidates for reuse).
// ---------------------------------------------------------------------------

describe("countLines", () => {
  it("empty string has 0 lines", () => {
    expect(countLines("")).toBe(0);
  });

  it("single line with no trailing newline has 1 line", () => {
    expect(countLines("a")).toBe(1);
  });

  it("single line WITH trailing newline has 1 line (the common file-on-disk case)", () => {
    expect(countLines("a\n")).toBe(1);
  });

  it("two lines with no trailing newline has 2 lines", () => {
    expect(countLines("a\nb")).toBe(2);
  });

  it("two lines WITH trailing newline has 2 lines (not 3)", () => {
    expect(countLines("a\nb\n")).toBe(2);
  });

  it("a lone newline counts as 0 lines (matches both existing bounds checkers exactly)", () => {
    // This is a DELIBERATE deviation from a naive "one empty terminated line"
    // reading: applyEditsMulti.ts's countLogicalLinesEntry("\n") and
    // write/rangeEdit.ts's countLogicalLines("\n") both return 0 (strip the
    // one trailing newline, leaving "" — an empty trimmed body). countLines
    // must match that exactly, or a "1-1" handle minted for "\n" content
    // would be rejected by the bounds check as out of bounds for a 0-line file
    // — reproducing this exact bug class for a different edge case.
    expect(countLines("\n")).toBe(0);
  });

  it("two consecutive newlines (two terminated blank lines) has 2 lines", () => {
    // "\n\n" strips ONE trailing newline, leaving "\n" — a single (empty)
    // logical line before it, so this is 2 lines total. Matches
    // applyEditsMulti.ts's countLogicalLinesEntry("\n\n") === 2 exactly.
    expect(countLines("\n\n")).toBe(2);
  });

  it("three lines with a trailing newline has 3 lines", () => {
    expect(countLines("a\nb\nc\n")).toBe(3);
  });

  it("N real lines with trailing newline always reports N, never N+1 (regression for the exact reported bug shapes)", () => {
    const fiftyLines = Array.from({ length: 50 }, (_, i) => `line${i + 1}`).join("\n") + "\n";
    expect(countLines(fiftyLines)).toBe(50);

    const oneEightyThreeLines = Array.from({ length: 183 }, (_, i) => `line${i + 1}`).join("\n") + "\n";
    expect(countLines(oneEightyThreeLines)).toBe(183);
  });

  // -------------------------------------------------------------------------
  // CRLF / lone-CR normalization
  // -------------------------------------------------------------------------

  it("CRLF line endings count the same as LF", () => {
    expect(countLines("a\r\nb\r\n")).toBe(2);
    expect(countLines("a\r\nb")).toBe(2);
  });

  it("lone CR line endings (old Mac style) count the same as LF", () => {
    expect(countLines("a\rb\r")).toBe(2);
    expect(countLines("a\rb")).toBe(2);
  });

  it("a lone CRLF counts as 0 lines (mirrors the lone-LF case)", () => {
    expect(countLines("\r\n")).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Agreement with the two existing production bounds-check implementations
  // -------------------------------------------------------------------------

  /** Byte-identical copy of applyEditsMulti.ts's countLogicalLinesEntry, for
   * a same-process cross-check without importing an internal (non-exported)
   * helper across module boundaries. */
  function referenceCountLogicalLines(text: string): number {
    if (text.length === 0) return 0;
    const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const trimmed = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
    if (trimmed.length === 0) return 0;
    return trimmed.split("\n").length;
  }

  const agreementCases = [
    "",
    "a",
    "a\n",
    "a\nb",
    "a\nb\n",
    "\n",
    "\n\n",
    "line1\nline2\nline3",
    "line1\nline2\nline3\n",
    "a\r\nb\r\n",
    "just one line, no newline at all",
  ];

  it.each(agreementCases)("agrees with the applyEditsMulti.ts bounds-check algorithm for %j", (text) => {
    expect(countLines(text)).toBe(referenceCountLogicalLines(text));
  });
});
