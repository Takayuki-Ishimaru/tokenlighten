import { describe, it, expect } from "vitest";
import { computeLineDelta, formatDelta, formatLines } from "../util/lineDelta.js";

describe("computeLineDelta", () => {
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

describe("formatLines", () => {
  it("formats single line", () => {
    expect(formatLines(5, 5)).toBe("5");
  });

  it("formats range", () => {
    expect(formatLines(12, 15)).toBe("12-15");
  });
});
