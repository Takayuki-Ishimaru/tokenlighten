// ---------------------------------------------------------------------------
// A3 -- the pure half of the csv query window: which contiguous rows a query
// selects, and how the rows still owed are paged. No server, no store.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
  chooseCsvRowPage,
  csvQueryWindow,
  csvRowCostBytes,
  rowsOverlappingWindows,
  type CsvWindowModel,
} from "../office/csvWindow.js";

/** One physical line per row, data starting at line 2 under a header. */
function model(rows: ReadonlyArray<ReadonlyArray<string | null>>, spans?: Array<[number, number]>): CsvWindowModel {
  return { rows, dataSpans: spans ?? rows.map((_, i): [number, number] => [i + 2, i + 2]) };
}

function filler(n: number, offset = 0): string[][] {
  return Array.from({ length: n }, (_, i) => [`row${i + offset}`, "ordinary", String(i + offset)]);
}

const BIG = 1_000_000;

describe("csvQueryWindow", () => {
  it("anchors on a match at the tail, not the prefix", () => {
    const rows = [...filler(99), ["needle-row", "payment timeout", "7"]];
    expect(csvQueryWindow(model(rows), ["timeout"], csvRowCostBytes(rows[99]!), 200)).toEqual({ startIdx: 99, endIdx: 100, anchorIdx: 99 });
  });

  it("grows forward from the anchor, then backward, in whole rows under the budget", () => {
    const rows = [...filler(10), ["x", "timeout", "1"], ...filler(10, 10)];
    const cost = csvRowCostBytes(rows[0]!);
    const window = csvQueryWindow(model(rows), ["timeout"], cost * 5, 200)!;
    expect(window.startIdx).toBeLessThanOrEqual(10);
    expect(window.endIdx).toBeGreaterThan(10);
    const served = rows.slice(window.startIdx, window.endIdx);
    expect(served.reduce((sum, row) => sum + csvRowCostBytes(row), 0)).toBeLessThanOrEqual(cost * 5);
    // At the end of the table the unused budget goes backward rather than being wasted.
    const tail = [...filler(10), ["x", "timeout", "1"]];
    const tailBudget = csvRowCostBytes(tail[10]!) + csvRowCostBytes(tail[9]!) + csvRowCostBytes(tail[8]!);
    expect(csvQueryWindow(model(tail), ["timeout"], tailBudget, 200)).toEqual({ startIdx: 8, endIdx: 11, anchorIdx: 10 });
  });

  it("prefers the row matching the most DISTINCT tokens, the earliest of equals", () => {
    const rows = [["a", "timeout", ""], ...filler(5), ["b", "timeout retry", ""], ...filler(5), ["c", "retry timeout", ""]];
    expect(csvQueryWindow(model(rows), ["timeout", "retry"], csvRowCostBytes(rows[6]!), 200)!.startIdx).toBe(6);
    const repeated = [["a", "timeout timeout timeout", ""], ...filler(3), ["b", "timeout", "retry"]];
    expect(csvQueryWindow(model(repeated), ["timeout", "retry"], csvRowCostBytes(repeated[4]!), 200)!.startIdx).toBe(4);
  });

  it("matches case-insensitively as a substring, across cells, in any script; never matches null or the numeric form of absence", () => {
    const rows = [...filler(20), ["東京都の売上", "Payment-TIMEOUT", null]];
    expect(csvQueryWindow(model(rows), ["timeout"], BIG, 200)!.endIdx).toBe(21);
    expect(csvQueryWindow(model(rows), ["売上"], csvRowCostBytes(rows[20]!), 200)).toEqual({ startIdx: 20, endIdx: 21, anchorIdx: 20 });
    expect(csvQueryWindow(model([...filler(5), ["a", null, ""]]), ["null"], BIG, 200)).toBeUndefined();
  });

  it("answers undefined (keep the prefix) on no tokens, no match, a tie over most rows, or no room for the anchor row", () => {
    const rows = filler(20);
    expect(csvQueryWindow(model(rows), [], BIG, 200)).toBeUndefined();
    expect(csvQueryWindow(model(rows), ["absent"], BIG, 200)).toBeUndefined();
    expect(csvQueryWindow(model([]), ["x"], BIG, 200)).toBeUndefined();
    // "ordinary" is in every row, so it locates nothing.
    expect(csvQueryWindow(model(rows), ["ordinary"], BIG, 200)).toBeUndefined();
    // Exactly half tie: more than 50% is the bound, so this still selects.
    const half = rows.map((row, i) => (i < 10 ? ["k", "half", String(i)] : row));
    expect(csvQueryWindow(model(half), ["half"], BIG, 200)).toBeDefined();
    const needle = [...filler(9), ["x", "timeout", "1"]];
    expect(csvQueryWindow(model(needle), ["timeout"], csvRowCostBytes(needle[9]!) - 1, 200)).toBeUndefined();
  });

  it("is capped by maxRows and deterministic", () => {
    const rows = [["x", "timeout", "1"], ...filler(50)];
    const first = csvQueryWindow(model(rows), ["timeout"], BIG, 10);
    expect(first).toEqual({ startIdx: 0, endIdx: 10, anchorIdx: 0 });
    expect(csvQueryWindow(model(rows), ["timeout"], BIG, 10)).toEqual(first);
  });
});

describe("rowsOverlappingWindows", () => {
  it("names the first maximal run of whole rows lying inside the windows", () => {
    const m = model(filler(10)); // lines 2..11
    expect(rowsOverlappingWindows(m, [{ start: 2, end: 11 }])).toEqual({ startIdx: 0, endIdx: 10 });
    expect(rowsOverlappingWindows(m, [{ start: 5, end: 7 }])).toEqual({ startIdx: 3, endIdx: 6 });
    expect(rowsOverlappingWindows(m, [{ start: 2, end: 3 }, { start: 8, end: 9 }])).toEqual({ startIdx: 0, endIdx: 2 });
  });

  it("owes a whole multi-line row when any of its lines is owed, and is not stopped by a blank-line gap between adjacent rows", () => {
    // Row 1 spans lines 3-5; line 6 is blank; row 2 is line 7.
    const m = model(filler(3), [[2, 2], [3, 5], [7, 7]]);
    expect(rowsOverlappingWindows(m, [{ start: 4, end: 7 }])).toEqual({ startIdx: 1, endIdx: 3 });
    expect(rowsOverlappingWindows(m, [{ start: 3, end: 5 }, { start: 7, end: 7 }])).toEqual({ startIdx: 1, endIdx: 3 });
    expect(rowsOverlappingWindows(m, [{ start: 5, end: 5 }])).toEqual({ startIdx: 1, endIdx: 2 });
  });

  it("answers undefined when no whole row is owed", () => {
    const m = model(filler(3), [[2, 2], [3, 5], [7, 7]]);
    expect(rowsOverlappingWindows(m, [])).toBeUndefined();
    expect(rowsOverlappingWindows(m, [{ start: 6, end: 6 }])).toBeUndefined();
    expect(rowsOverlappingWindows(m, [{ start: 100, end: 200 }])).toBeUndefined();
  });
});

describe("chooseCsvRowPage", () => {
  const rows = filler(10);
  const cost = csvRowCostBytes(rows[0]!);

  it("fills the room from the first owed row, in whole rows", () => {
    const m = model(rows);
    expect(chooseCsvRowPage(m, [{ start: 2, end: 11 }], cost * 3, 200)).toEqual({ ok: true, window: { startIdx: 0, endIdx: 3 } });
    expect(chooseCsvRowPage(m, [{ start: 6, end: 11 }], cost * 3, 200)).toEqual({ ok: true, window: { startIdx: 4, endIdx: 7 } });
  });

  it("stops at a hole in D: never ships a row already delivered", () => {
    const m = model(rows);
    expect(chooseCsvRowPage(m, [{ start: 2, end: 3 }, { start: 8, end: 11 }], BIG, 200)).toEqual({ ok: true, window: { startIdx: 0, endIdx: 2 } });
  });

  it("is capped by maxRows", () => {
    expect(chooseCsvRowPage(model(rows), [{ start: 2, end: 11 }], BIG, 4)).toEqual({ ok: true, window: { startIdx: 0, endIdx: 4 } });
  });

  it("names the floor when the first owed row does not fit, and reports completion when nothing whole is owed", () => {
    expect(chooseCsvRowPage(model(rows), [{ start: 2, end: 11 }], cost - 1, 200)).toEqual({ ok: false, reason: "budget-below-minimum", requiredRoomBytes: cost });
    expect(chooseCsvRowPage(model(rows), [], BIG, 200)).toEqual({ ok: false, reason: "complete" });
    expect(chooseCsvRowPage(model(rows), [{ start: 500, end: 600 }], BIG, 200)).toEqual({ ok: false, reason: "complete" });
  });

  it("always advances: walking D with a shrinking budget delivers every row exactly once", () => {
    const m = model(filler(25));
    let remaining = [{ start: 2, end: 26 }];
    const seen: number[] = [];
    const budgets = [cost * 4, cost * 2, cost, cost * 7];
    for (let call = 0; remaining.length > 0 && call < 40; call += 1) {
      const page = chooseCsvRowPage(m, remaining, budgets[call % budgets.length]! + 8, 200);
      if (!page.ok) throw new Error(page.reason);
      for (let i = page.window.startIdx; i < page.window.endIdx; i += 1) seen.push(i);
      const servedEnd = page.window.endIdx + 1; // last served file line
      remaining = servedEnd >= 26 ? [] : [{ start: servedEnd + 1, end: 26 }];
    }
    expect(seen).toEqual(Array.from({ length: 25 }, (_, i) => i));
  });
});
