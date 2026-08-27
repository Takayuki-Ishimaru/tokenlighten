/**
 * deltaContextGeometry.spec.ts — B2 / V12-02 (TL_DELTA_CONTEXT).
 *
 * The transformation's whole safety argument lives in two byte identities:
 * lines below the change are identical AT THE SAME INDEX, lines above it are
 * identical at INDEX + DELTA. These tests hold `computeEditHunkGeometry` to
 * exactly that claim by re-deriving both identities from the texts, for every
 * edit shape the write seam can see (replace, insert, delete, multi-hunk,
 * whole-file, CRLF, EOF, empty).
 *
 * `transformServedRangesAcrossServerEdit` is exercised end-to-end through the
 * real dispatcher in `deltaContextDispatch.spec.ts`; here the concern is the
 * geometry it is handed.
 */
import { describe, expect, it } from "vitest";

import { computeEditHunkGeometry } from "../write/deltaContext.js";

function lines(text: string): string[] {
  if (text.length === 0) return [];
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const trimmed = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  return trimmed.length === 0 ? [] : trimmed.split("\n");
}

/**
 * THE INVARIANT THE LEDGER RIDES ON. Every pre-edit line strictly below
 * `preStart` must be the post-edit line at the same 1-based index, and every
 * pre-edit line strictly above `preEnd` must be the post-edit line at
 * index + `delta`. A geometry that fails this would let the transformation
 * hand out a `prior` marker for bytes the caller does not hold.
 */
function assertIdentities(before: string, after: string): void {
  const hunk = computeEditHunkGeometry(before, after);
  expect(hunk, `no geometry for ${JSON.stringify({ before, after })}`).toBeDefined();
  const b = lines(before);
  const a = lines(after);
  expect(hunk!.delta).toBe(a.length - b.length);
  for (let i = 1; i < hunk!.preStart; i += 1) {
    expect(a[i - 1], `prefix identity broken at line ${i}`).toBe(b[i - 1]);
  }
  for (let i = hunk!.preEnd + 1; i <= b.length; i += 1) {
    expect(a[i - 1 + hunk!.delta], `suffix identity broken at line ${i}`).toBe(b[i - 1]);
  }
}

const SIX = "a\nb\nc\nd\ne\nf\n";

describe("B2 computeEditHunkGeometry", () => {
  it("names the replaced line only, with no line delta", () => {
    const hunk = computeEditHunkGeometry(SIX, "a\nb\nC!\nd\ne\nf\n");
    expect(hunk).toEqual({ preStart: 3, preEnd: 3, delta: 0 });
    assertIdentities(SIX, "a\nb\nC!\nd\ne\nf\n");
  });

  it("names a one-line replacement that grows into two lines", () => {
    const after = "a\nb\nc1\nc2\nd\ne\nf\n";
    expect(computeEditHunkGeometry(SIX, after)).toEqual({ preStart: 3, preEnd: 3, delta: 1 });
    assertIdentities(SIX, after);
  });

  it("models a PURE INSERTION as an empty pre-region (preEnd === preStart - 1)", () => {
    const after = "a\nb\nNEW\nc\nd\ne\nf\n";
    const hunk = computeEditHunkGeometry(SIX, after);
    expect(hunk).toEqual({ preStart: 3, preEnd: 2, delta: 1 });
    assertIdentities(SIX, after);
  });

  it("models a deletion with a negative delta", () => {
    const after = "a\nb\nd\ne\nf\n";
    expect(computeEditHunkGeometry(SIX, after)).toEqual({ preStart: 3, preEnd: 3, delta: -1 });
    assertIdentities(SIX, after);
  });

  it("collapses TWO distant hunks into the one enclosing region (never a guessed alignment)", () => {
    const after = "a\nB!\nc\nd\nE!\nf\n";
    // Lines 2 and 5 both changed. A heuristic diff would keep 3-4; the
    // prefix/suffix pair keeps only what it can PROVE, which is 1 and 6.
    expect(computeEditHunkGeometry(SIX, after)).toEqual({ preStart: 2, preEnd: 5, delta: 0 });
    assertIdentities(SIX, after);
  });

  it("declares the whole file changed when the first and last lines both move", () => {
    const after = "A\nb\nc\nd\ne\nF\n";
    expect(computeEditHunkGeometry(SIX, after)).toEqual({ preStart: 1, preEnd: 6, delta: 0 });
  });

  it("handles an append at EOF and a truncation to empty", () => {
    expect(computeEditHunkGeometry(SIX, `${SIX}g\n`)).toEqual({ preStart: 7, preEnd: 6, delta: 1 });
    assertIdentities(SIX, `${SIX}g\n`);
    expect(computeEditHunkGeometry(SIX, "")).toEqual({ preStart: 1, preEnd: 6, delta: -6 });
    expect(computeEditHunkGeometry("", "a\n")).toEqual({ preStart: 1, preEnd: 0, delta: 1 });
  });

  it("returns undefined when nothing observable changed", () => {
    expect(computeEditHunkGeometry(SIX, SIX)).toBeUndefined();
    // Line-ending-only rewrite: the logical lines are identical, so no line
    // moved and the transformation has nothing it is entitled to re-project.
    expect(computeEditHunkGeometry(SIX, "a\r\nb\r\nc\r\nd\r\ne\r\nf\r\n")).toBeUndefined();
    // Trailing-newline-only change — same reasoning.
    expect(computeEditHunkGeometry(SIX, "a\nb\nc\nd\ne\nf")).toBeUndefined();
  });

  it("keeps the identities across CRLF input on both sides", () => {
    const before = "a\r\nb\r\nc\r\nd\r\n";
    const after = "a\r\nb\r\nC!\r\nD!\r\nd\r\n";
    expect(computeEditHunkGeometry(before, after)).toEqual({ preStart: 3, preEnd: 3, delta: 1 });
    assertIdentities(before, after);
  });

  it("keeps the identities for a repeated-line file, where a naive scan could slip", () => {
    const before = "x\nx\nx\nx\nx\n";
    const after = "x\nx\ny\nx\nx\n";
    assertIdentities(before, after);
    const hunk = computeEditHunkGeometry(before, after)!;
    // The prefix stops at the first difference and the suffix at the last, so
    // the region is exactly the changed line even when its neighbours repeat.
    expect(hunk.preStart).toBeLessThanOrEqual(3);
    expect(hunk.preEnd).toBeGreaterThanOrEqual(3);
  });
});
