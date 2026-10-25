import {describe, expect, it} from "vitest";
import {makeSourceBodyCapsule, sourceCapsuleCovers} from "../features/task-pack/sourceBodyCapsule.js";

describe("final-wire source body capsules", () => {
  const source = "one\ntwo\nthree\nfour\n";
  const sha = "sha256:fixture";

  it("accepts a verified partial prefix and proves a later subset", () => {
    const prior = makeSourceBodyCapsule({path: "a.ts", handle: "prior", range: "1-4",
      body: "one\ntwo\n", source, sha, remainingRanges: ["3-4"]})!;
    const current = makeSourceBodyCapsule({path: "a.ts", handle: "next", range: "1-2",
      body: "one\ntwo\n", source, sha})!;
    expect(prior).toMatchObject({startLine: 1, endLine: 2});
    expect(sourceCapsuleCovers(prior, current)).toBe(true);
    const wireWithoutTrailingNewline = makeSourceBodyCapsule({path: "a.ts", handle: "next-no-lf", range: "1-2",
      body: "one\ntwo", source, sha})!;
    expect(wireWithoutTrailingNewline.endLine).toBe(2);
    expect(sourceCapsuleCovers(prior, wireWithoutTrailingNewline)).toBe(true);
    expect(Object.isFrozen(prior)).toBe(true);
  });

  it("rejects body text that is transformed, outside its range, or overlaps a disclosed gap", () => {
    expect(makeSourceBodyCapsule({path: "a.ts", handle: "h", range: "1-4",
      body: "one\n…\n", source, sha})).toBeUndefined();
    expect(makeSourceBodyCapsule({path: "a.ts", handle: "h", range: "2-4",
      body: "one\n", source, sha})).toBeUndefined();
    expect(makeSourceBodyCapsule({path: "a.ts", handle: "h", range: "1-4",
      body: "one\ntwo\n", source, sha, remainingRanges: ["2-4"]})).toBeUndefined();
    expect(makeSourceBodyCapsule({path: "a.ts", handle: "h", range: "1-4",
      body: "one\ntwo\n", source, sha, hasAppendedWindows: true})).toBeUndefined();
  });

  it("requires identical path and whole-file SHA for coverage", () => {
    const prior = makeSourceBodyCapsule({path: "a.ts", handle: "prior", range: "1-2",
      body: "one\ntwo\n", source, sha})!;
    const changed = makeSourceBodyCapsule({path: "a.ts", handle: "next", range: "1-1",
      body: "one\n", source, sha: "sha256:changed"})!;
    const otherPath = {...changed, path: "b.ts"};
    expect(sourceCapsuleCovers(prior, changed)).toBe(false);
    expect(sourceCapsuleCovers(prior, otherPath)).toBe(false);
  });

  it("handles Unicode and CRLF at exact line boundaries, but rejects mid-line cuts", () => {
    const crlf = "😀 first\r\n値第二行\r\nthird\r\n";
    const prior = makeSourceBodyCapsule({path: "u.ts", handle: "prior", range: "1-3",
      body: "😀 first\r\n値第二行\r\n", source: crlf, sha})!;
    const noTerminator = makeSourceBodyCapsule({path: "u.ts", handle: "current", range: "2-2",
      body: "値第二行", source: crlf, sha})!;
    expect(prior.endLine).toBe(2);
    expect(noTerminator.endLine).toBe(2);
    expect(sourceCapsuleCovers(prior, noTerminator)).toBe(true);
    expect(makeSourceBodyCapsule({path: "u.ts", handle: "bad", range: "1-3",
      body: "😀 fir", source: crlf, sha})).toBeUndefined();
  });

  it("enforces the UTF-8 capsule byte limit at the exact 18 KiB boundary", () => {
    const exact = "é".repeat(9 * 1024);
    expect(Buffer.byteLength(exact, "utf8")).toBe(18 * 1024);
    expect(makeSourceBodyCapsule({path: "large.ts", handle: "h", range: "1-1",
      body: exact, source: exact, sha})).toBeDefined();
    const tooLarge = `${exact}x`;
    expect(makeSourceBodyCapsule({path: "large.ts", handle: "h", range: "1-1",
      body: tooLarge, source: tooLarge, sha})).toBeUndefined();
  });
});
