import {describe, expect, it} from "vitest";
import {coalesceBlankGapWindows} from "../features/task-pack/blankWindowBundles.js";

describe("coalesceBlankGapWindows", () => {
  const target = (range: string, path = "a.ts") => ({path, range});
  it("bundles adjacent and whitespace-separated windows and includes the blank source lines", () => {
    const source = "first\n\n \t\nsecond\nthird";
    expect(coalesceBlankGapWindows([target("1-1"), target("4-4"), target("5-5")], () => source, 64))
      .toEqual([target("1-5")]);
  });
  it("never bridges an unrequested nonblank statement or comment", () => {
    for (const gap of ["hidden();", "// comment", "/* */", "\u200b"]) {
      expect(coalesceBlankGapWindows([target("1-1"), target("3-3")], () => "first\n" + gap + "\nlast", 64))
        .toEqual([target("1-1"), target("3-3")]);
    }
  });
  it("keeps priority order, file boundaries, overlaps, and duplicate windows", () => {
    const input = [target("4-4"), target("1-1"), target("1-1"), target("1-2"), target("3-3", "b.ts")];
    expect(coalesceBlankGapWindows(input, () => "a\nb\nc\nd", 64)).toEqual(input);
  });
  it("charges all blank gap bytes and exact UTF-8 bytes against the surface ceiling", () => {
    const input = [target("1-1"), target("3-3")];
    const source = "漢\n  \n字";
    expect(Buffer.byteLength(source)).toBe(10);
    expect(coalesceBlankGapWindows(input, () => source, 9)).toEqual(input);
    expect(coalesceBlankGapWindows(input, () => source, 10)).toEqual([target("1-3")]);
  });
  it("does not exceed the ceiling after a prior merge", () => {
    expect(coalesceBlankGapWindows([target("1-1"), target("3-3"), target("5-5")],
      () => "ab\n\ncd\n\nef", 7)).toEqual([target("1-3"), target("5-5")]);
  });
  it.each(["0-1", "3-2", "1-99", "x", "1", "1-2x", "9007199254740992-9007199254740993"])(
    "does not merge an invalid or unbound window %s", range => {
      const input = [target("1-1"), target(range)];
      expect(coalesceBlankGapWindows(input, () => "a\n\nb", 64)).toEqual(input);
    });
  it("preserves windows when source is unavailable", () => {
    const input = [target("1-1"), target("3-3")];
    expect(coalesceBlankGapWindows(input, () => undefined, 64)).toEqual(input);
  });
  it("does not mutate caller data and reads a file only once", () => {
    const input = Object.freeze([Object.freeze(target("1-1")), Object.freeze(target("3-3")), Object.freeze(target("5-5"))]);
    let reads = 0;
    expect(coalesceBlankGapWindows(input, () => {reads++; return "a\r\n\r\nb\r\n\r\nc";}, 64)).toEqual([target("1-5")]);
    expect(reads).toBe(1);
    expect(input.map(row => row.range)).toEqual(["1-1", "3-3", "5-5"]);
  });
});
