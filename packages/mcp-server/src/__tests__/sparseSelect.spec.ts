// ---------------------------------------------------------------------------
// B2b -- the pure half of a sparse view: which non-contiguous rows a first look
// shows. It only ever picks positions. Nothing here claims the rest is unimportant.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { lexemes, selectSparseRows } from "../office/sparseSelect.js";
import { csvRowCostBytes, type CsvWindowModel } from "../office/csvWindow.js";
import { lexemes as referenceLexemes, selectSparseRows as referenceSelect } from "./helpers/sparseSelectReference.js";

function model(rows: ReadonlyArray<ReadonlyArray<string | null>>): CsvWindowModel {
  return { rows, dataSpans: rows.map((_, i): [number, number] => [i + 2, i + 2]) };
}

function filler(n: number, offset = 0): string[][] {
  return Array.from({ length: n }, (_, i) => ["info", `service started normally`, String(100 + ((i + offset) % 3))]);
}

const BIG = 1_000_000;
const shownRows = (selection: { runs: ReadonlyArray<{ startIdx: number; endIdx: number }> }): number[] =>
  selection.runs.flatMap((run) => Array.from({ length: run.endIdx - run.startIdx }, (_, i) => run.startIdx + i));

describe("lexemes", () => {
  it("keeps whole values, so a prefix of a number is a different value", () => {
    expect(lexemes("port: 80")).toEqual(["port", "80"]);
    expect(lexemes("port: 8080")).toEqual(["port", "8080"]);
  });

  it("binds a sign to its number", () => {
    expect(lexemes("delta -5")).toContain("-5");
    expect(lexemes("delta 5")).toContain("5");
    expect(lexemes("delta +5")).toContain("5");
    expect(lexemes("a-b")).toEqual(["a", "b"]);
  });

  it("keeps negation words and timestamps as they are, and lowercases words", () => {
    expect(lexemes("Not Found")).toEqual(["not", "found"]);
    expect(lexemes("2026-10-30T10:00:00Z ok")).toContain("2026-10-30t10:00:00z");
    expect(lexemes("2026-10-30T10:00:01Z ok")).toContain("2026-10-30t10:00:01z");
  });

  it("handles Japanese without splitting on spaces alone, and empties", () => {
    expect(lexemes("接続タイムアウト")).toContain("接続タイムアウト");
    expect(lexemes("")).toEqual([]);
    expect(lexemes("   ")).toEqual([]);
  });
});

describe("selectSparseRows", () => {
  it("shows a match that is far from another match, without the rows between", () => {
    const rows = [...filler(40), ["error", "payment timeout upstream", "500"], ...filler(40, 41), ["error", "payment timeout retry", "503"], ...filler(40, 82)];
    const selection = selectSparseRows(model(rows), ["timeout"], BIG, 8)!;
    const shown = shownRows(selection);
    expect(shown).toContain(40);
    expect(shown).toContain(81);
    expect(shown.length).toBeLessThan(rows.length / 4);
    expect(selection.runs.length).toBeGreaterThanOrEqual(2);
  });

  it("matches whole values: asking for port 80 does not surface port 8080", () => {
    const rows = [...filler(30), ["cfg", "port: 8080", "x"], ...filler(30, 31), ["cfg", "port: 80", "x"], ...filler(30, 62)];
    const selection = selectSparseRows(model(rows), ["80"], 200, 1)!;
    expect(shownRows(selection)).toContain(61);
    expect(shownRows(selection)).not.toContain(30);
  });

  it("separates sign, negation and timestamp variants when each is asked for", () => {
    const signs = [...filler(30), ["m", "delta", "-5"], ...filler(30, 31), ["m", "delta", "5"], ...filler(30, 62)];
    const askNegative = selectSparseRows(model(signs), ["-5"], 200, 1)!;
    expect(shownRows(askNegative)).toContain(30);
    expect(shownRows(askNegative)).not.toContain(61);

    const times = [...filler(30), ["2026-10-30T10:00:00Z", "job", "a"], ...filler(30, 31), ["2026-10-30T10:00:01Z", "job", "a"], ...filler(30, 62)];
    const askTime = selectSparseRows(model(times), ["2026-10-30T10:00:01Z"], 200, 1)!;
    expect(shownRows(askTime)).toContain(61);
    expect(shownRows(askTime)).not.toContain(30);
  });

  it("two near-identical matches do not crowd out a different one: diversity spreads the runs", () => {
    const same = ["error", "disk full on volume a", "1"];
    const rows = [...filler(20), same, ...filler(20, 21), same, ...filler(20, 42), same, ...filler(20, 63), ["error", "certificate expired for host", "2"], ...filler(20, 84)];
    const selection = selectSparseRows(model(rows), ["error"], BIG, 2)!;
    const shown = shownRows(selection);
    expect(shown).toContain(84);
    expect(selection.runs).toHaveLength(2);
  });

  it("prefers rows that stand out among equal matches: errors and rare values", () => {
    const rows = [
      ...filler(60),
      ...Array.from({ length: 10 }, (_, i) => ["job", "finished", String(i % 2)]),
      ["job", "failed with exception", "1"],
      ...Array.from({ length: 10 }, (_, i) => ["job", "finished", String(i % 2)]),
      ...filler(60, 61),
    ];
    const selection = selectSparseRows(model(rows), ["job"], 200, 1)!;
    expect(shownRows(selection)).toContain(70);
  });

  it("includes an adjacent row for context when there is room, and never overlaps runs", () => {
    const rows = [...filler(10), ["e", "timeout", "1"], ...filler(10, 11), ["e", "timeout", "2"], ...filler(10, 22)];
    const selection = selectSparseRows(model(rows), ["timeout"], BIG, 8)!;
    const shown = shownRows(selection);
    expect(shown).toContain(9);
    expect(shown).toContain(11);
    expect(new Set(shown).size).toBe(shown.length);
    for (let i = 1; i < selection.runs.length; i += 1) {
      expect(selection.runs[i]!.startIdx).toBeGreaterThan(selection.runs[i - 1]!.endIdx);
    }
  });

  it("stays inside the byte room, whole rows only, in file order", () => {
    const rows = [...filler(50), ["e", "timeout one", "1"], ...filler(50, 51), ["e", "timeout two", "2"], ...filler(50, 102)];
    const room = csvRowCostBytes(rows[50]!) + csvRowCostBytes(rows[101]!) + 5;
    const selection = selectSparseRows(model(rows), ["timeout"], room, 8)!;
    const shown = shownRows(selection);
    expect(shown.reduce((sum, index) => sum + csvRowCostBytes(rows[index]!), 0)).toBeLessThanOrEqual(room);
    expect(shown).toEqual([...shown].sort((a, b) => a - b));
  });

  it("answers undefined when it locates nothing or cannot hold one row", () => {
    expect(selectSparseRows(model(filler(50)), ["zzzabsent"], BIG, 8)).toBeUndefined();
    expect(selectSparseRows(model(filler(50)), [], BIG, 8)).toBeUndefined();
    expect(selectSparseRows(model([]), ["x"], BIG, 8)).toBeUndefined();
    const rows = [...filler(20), ["e", "timeout", "1"]];
    expect(selectSparseRows(model(rows), ["timeout"], csvRowCostBytes(rows[20]!) - 1, 8)).toBeUndefined();
    // Matching most rows locates nothing.
    expect(selectSparseRows(model(filler(50)), ["started"], BIG, 8)).toBeUndefined();
  });

  it("is deterministic, and ignores nulls", () => {
    const rows = [...filler(40), ["e", null, "timeout"], ...filler(40, 41), [null, "timeout", null], ...filler(40, 82)];
    const first = selectSparseRows(model(rows), ["timeout"], BIG, 4);
    expect(selectSparseRows(model(rows), ["timeout"], BIG, 4)).toEqual(first);
    expect(first).toBeDefined();
    expect(selectSparseRows(model(rows), ["null"], BIG, 4)).toBeUndefined();
  });

  it("reports what it considered and what it shows", () => {
    const rows = [...filler(100), ["e", "timeout", "1"]];
    const selection = selectSparseRows(model(rows), ["timeout"], BIG, 8)!;
    expect(selection.scanned).toBe(101);
    expect(selection.shown).toBe(shownRows(selection).length);
  });

  it("chooses exactly what the unoptimized selection chooses", () => {
    let seed = 20261031;
    const next = (n: number): number => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed % n;
    };
    const words = ["error", "timeout", "not", "found", "8080", "80", "-5", "+5", "2026-10-30t10:00:00z", "接続", "タイムアウト", "abc日本", "é", "x·y", "Ünï", "port", "ok", "a-b"];
    const cell = (): string | null => {
      if (next(12) === 0) return null;
      return Array.from({ length: next(4) }, () => words[next(words.length)]!).join(next(3) === 0 ? "," : " ");
    };
    for (let round = 0; round < 400; round += 1) {
      const rows = Array.from({ length: 1 + next(80) }, () => Array.from({ length: 1 + next(4) }, cell));
      const tokens = Array.from({ length: 1 + next(3) }, () => words[next(words.length)]!);
      const room = [40, 120, 400, 4000, 1_000_000][next(5)]!;
      const maxRuns = 1 + next(8);
      expect(selectSparseRows(model(rows), tokens, room, maxRuns), JSON.stringify({ round, tokens, room, maxRuns })).toEqual(referenceSelect(model(rows), tokens, room, maxRuns));
    }
  });

  it("declines a query that matches too many rows to answer with a few runs", () => {
    const rows = Array.from({ length: 20_000 }, (_, i) => ["info", String(i), i % 10 === 0 ? "timeout" : "ok"]);
    expect(selectSparseRows(model(rows), ["timeout"], BIG, 8)).toBeUndefined();
    const fewer = rows.map((row, i) => (i % 25 === 0 ? row : [row[0]!, row[1]!, "ok"]));
    expect(selectSparseRows(model(fewer), ["timeout"], BIG, 8)).toBeDefined();
  });

  it("splits values exactly as the unoptimized lexer does", () => {
    for (const text of ["Hello-World +5 -5 a-5", "2026-10-30T10:00:00Z", "接続タイムアウトabc", "abc日本 x·y", "Éa1b", "1.2.3/4", "--5", "e-5", "", "   ", "😀a", "ｱｲｳ"]) {
      expect(lexemes(text), text).toEqual(referenceLexemes(text));
    }
  });

  it("bounds its own work on a large table", () => {
    const rows = Array.from({ length: 100_000 }, (_, i) => ["info", `event number ${i}`, String(i % 97)]);
    rows[77_777] = ["error", "timeout reached", "0"];
    const started = performance.now();
    const selection = selectSparseRows(model(rows), ["timeout"], 8_000, 8)!;
    expect(shownRows(selection)).toContain(77_777);
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});
