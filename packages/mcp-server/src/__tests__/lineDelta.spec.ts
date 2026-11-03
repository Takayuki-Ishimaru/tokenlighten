import { describe, it, expect } from "vitest";
import { changedLineCounts, computeLineDelta, formatDelta, formatLines } from "../util/lineDelta.js";

describe("computeLineDelta", () => {
  it("anchors an EOF deletion inside the resulting nonempty file", () => {
    expect(computeLineDelta("a\nb", "b", "")).toMatchObject({ startLine: 1, endLine: 1 });
  });
  it.each([
    ["a\nb\nc\n", "b\n", "B\n", 1, 1],
    ["a\nb\nc\n", "b\n", "", 0, 1],
    ["a\nb\n", "\n", "", 1, 2],
    ["a\r\nb\r\n", "b\r\n", "B\r\n", 1, 1],
    ["a\nb\n", "b", "b", 0, 0],
    ["a\nb", "b", "", 0, 1],
  ])("counts complete affected lines without phantom EOF lines", (text, search, replace, added, removed) => {
    const result = computeLineDelta(text, search, replace);
    expect(result.added).toBe(added);
    expect(result.removed).toBe(removed);
    expect(result.endLine).toBeGreaterThanOrEqual(result.startLine);
  });
  it("single-line to single-line replacement", () => {
    const old = "line1\nline2\nline3\n";
    const d = computeLineDelta(old, "line2", "LINE2");
    expect(d.startLine).toBe(2);
    expect(d.endLine).toBe(2);
    expect(d.added).toBe(1);
    expect(d.removed).toBe(1);
  });

  it("single-line to multi-line expansion", () => {
    const old = "a\nb\nc\n";
    const d = computeLineDelta(old, "b", "b1\nb2\nb3");
    expect(d.startLine).toBe(2);
    expect(d.endLine).toBe(4);
    expect(d.added).toBe(3);
    expect(d.removed).toBe(1);
  });

  it("multi-line to single-line collapse", () => {
    const old = "a\nb\nc\nd\n";
    const d = computeLineDelta(old, "b\nc\nd", "merged");
    expect(d.startLine).toBe(2);
    expect(d.endLine).toBe(2);
    expect(d.added).toBe(1);
    expect(d.removed).toBe(3);
  });

  it("replacement at start of file (line 1)", () => {
    const old = "first\nsecond\n";
    const d = computeLineDelta(old, "first", "FIRST");
    expect(d.startLine).toBe(1);
    expect(d.endLine).toBe(1);
  });

  it("replacement at end of file", () => {
    const old = "a\nb\nc";
    const d = computeLineDelta(old, "c", "C");
    expect(d.startLine).toBe(3);
    expect(d.endLine).toBe(3);
  });
});

describe("formatDelta", () => {
  it("formats added/removed counts", () => {
    expect(formatDelta(3, 1)).toBe("+3/-1");
    expect(formatDelta(1, 1)).toBe("+1/-1");
    expect(formatDelta(5, 0)).toBe("+5/-0");
  });
});

describe("actual changed line counts", () => {
  it("does not count unchanged context between multiple edits", () => {
    expect(changedLineCounts("a\nb\nc\nd\ne\n", "A\nb\nc\nd\nE\n")).toEqual({ added: 2, removed: 2 });
  });
  it("handles blank lines, repeated lines, EOF and CRLF", () => {
    expect(changedLineCounts("a\r\na\r\n\r\n", "a\n\n")).toEqual({ added: 0, removed: 1 });
    expect(changedLineCounts("", "a\n")).toEqual({ added: 1, removed: 0 });
    expect(changedLineCounts("a\n", "")).toEqual({ added: 0, removed: 1 });
    expect(changedLineCounts("a", "a\n")).toEqual({ added: 1, removed: 1 });
  });
  it("omits the statistic for a rewrite exceeding the fixed work budget", () => {
    expect(changedLineCounts("a\n".repeat(1100), "b\n".repeat(1100))).toBeUndefined();
  });
});

describe("formatLines", () => {
  it("formats single line", () => {
    expect(formatLines(5, 5)).toBe("5");
  });

  it("formats range", () => {
    expect(formatLines(12, 15)).toBe("12-15");
  });
});
