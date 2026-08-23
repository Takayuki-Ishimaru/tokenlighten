// targetFingerprint.spec.ts — V11-06 Known-Local Fast Path v2: Target
// Fingerprint. Pure module — no filesystem, no mocks.

import { describe, it, expect } from "vitest";
import {
  computeTargetFingerprint,
  verifyTargetFingerprint,
  countAnchorOccurrences,
  FINGERPRINT_WINDOW_CHARS,
} from "../write/targetFingerprint.js";

const FILE = [
  "line one",
  "line two: const TARGET = 1;",
  "line three",
  "line four",
  "line five",
].join("\n");

const ANCHOR = "const TARGET = 1;";

function anchorSpan(text: string, anchor: string): { start: number; end: number } {
  const start = text.indexOf(anchor);
  return { start, end: start + anchor.length };
}

describe("countAnchorOccurrences", () => {
  it("counts zero, one, and multiple non-overlapping occurrences", () => {
    expect(countAnchorOccurrences("abc", "x")).toBe(0);
    expect(countAnchorOccurrences("abcabc", "abc")).toBe(2);
    expect(countAnchorOccurrences("aaaa", "aa")).toBe(2); // non-overlapping
  });

  it("an empty needle counts as zero — never Infinity", () => {
    expect(countAnchorOccurrences("abc", "")).toBe(0);
  });
});

describe("computeTargetFingerprint", () => {
  it("produces the plan-named shape: path + SHA + surrounding hash + expected count", () => {
    const span = anchorSpan(FILE, ANCHOR);
    const fp = computeTargetFingerprint({
      path: "src/foo.ts",
      fileText: FILE,
      spanStart: span.start,
      spanEnd: span.end,
      expectedCount: 1,
    });
    expect(fp.path).toBe("src/foo.ts");
    expect(fp.contentSha).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(fp.surroundingHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(fp.expectedCount).toBe(1);
    expect(fp.symbolKind).toBeUndefined();
    expect(fp.normalizedSignature).toBeUndefined();
  });

  it("carries symbolKind/normalizedSignature when supplied", () => {
    const span = anchorSpan(FILE, ANCHOR);
    const fp = computeTargetFingerprint({
      path: "src/foo.ts",
      fileText: FILE,
      spanStart: span.start,
      spanEnd: span.end,
      expectedCount: 1,
      symbolKind: "const",
      normalizedSignature: "const TARGET = 1;",
    });
    expect(fp.symbolKind).toBe("const");
    expect(fp.normalizedSignature).toBe("const TARGET = 1;");
  });

  it("clamps out-of-range spans instead of throwing", () => {
    expect(() =>
      computeTargetFingerprint({
        path: "src/foo.ts",
        fileText: FILE,
        spanStart: -50,
        spanEnd: FILE.length + 500,
        expectedCount: 1,
      }),
    ).not.toThrow();
  });
});

describe("verifyTargetFingerprint", () => {
  function baseFingerprint(text: string = FILE) {
    const span = anchorSpan(text, ANCHOR);
    return computeTargetFingerprint({
      path: "src/foo.ts",
      fileText: text,
      spanStart: span.start,
      spanEnd: span.end,
      expectedCount: 1,
    });
  }

  it("byte-identical text ⇒ ok:true, no reasons — the common case costs one sha256 and nothing else", () => {
    const fp = baseFingerprint();
    const result = verifyTargetFingerprint(fp, { currentFileText: FILE, anchorText: ANCHOR });
    expect(result).toEqual({
      ok: true,
      reasons: [],
      currentContentSha: fp.contentSha,
      currentCount: 1,
    });
  });

  it("ANY drift ⇒ refuse: content changing anywhere in the file fails content-sha-mismatch, count untouched", () => {
    const fp = baseFingerprint();
    const mutated = FILE.replace("line five", "line five — mutated");
    const result = verifyTargetFingerprint(fp, { currentFileText: mutated, anchorText: ANCHOR });
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("content-sha-mismatch");
    // The anchor itself still occurs exactly once — untouched by a mutation
    // elsewhere in the file.
    expect(result.reasons).not.toContain("expected-count-mismatch");
  });

  it("the anchor text disappearing ⇒ expected-count-mismatch (0 found)", () => {
    const fp = baseFingerprint();
    const mutated = FILE.replace(ANCHOR, "const TARGET = 2;");
    const result = verifyTargetFingerprint(fp, { currentFileText: mutated, anchorText: ANCHOR });
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("expected-count-mismatch");
    expect(result.currentCount).toBe(0);
  });

  it("the anchor text appearing a second time elsewhere ⇒ expected-count-mismatch (2 found)", () => {
    const fp = baseFingerprint();
    const mutated = `${FILE}\n${ANCHOR}`;
    const result = verifyTargetFingerprint(fp, { currentFileText: mutated, anchorText: ANCHOR });
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("expected-count-mismatch");
    expect(result.currentCount).toBe(2);
  });

  it("content immediately surrounding the anchor changing (count still 1) ⇒ surrounding-hash-mismatch too", () => {
    const fp = baseFingerprint();
    const mutated = FILE.replace("line two:", "line TWO, RENAMED:");
    // Sanity: the anchor itself is still present exactly once.
    expect(countAnchorOccurrences(mutated, ANCHOR)).toBe(1);
    const result = verifyTargetFingerprint(fp, { currentFileText: mutated, anchorText: ANCHOR });
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("content-sha-mismatch");
    expect(result.reasons).toContain("surrounding-hash-mismatch");
    expect(result.reasons).not.toContain("expected-count-mismatch");
  });

  it("a change far outside the fingerprint window (beyond FINGERPRINT_WINDOW_CHARS) does not itself trip surrounding-hash-mismatch", () => {
    const padding = "x".repeat(FINGERPRINT_WINDOW_CHARS * 3);
    const text = `${padding}\n${FILE}`;
    const fp = baseFingerprint(text);
    const mutated = `${padding.replace("xxx", "yyy")}\n${FILE}`;
    const result = verifyTargetFingerprint(fp, { currentFileText: mutated, anchorText: ANCHOR });
    // Whole-file sha still differs (that padding IS part of the file), but
    // the WINDOW around the anchor itself is untouched.
    expect(result.reasons).toContain("content-sha-mismatch");
    expect(result.reasons).not.toContain("surrounding-hash-mismatch");
  });
});
