import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  NATIVE_READ_MAX_BYTES,
  NATIVE_READ_MAX_LINES,
  NATIVE_READ_MAX_TOKENS,
} from "@tokenlighten/usage";
import {
  baselinePathKey,
  emptyReadBaseline,
  measureReadBaseline,
  parseBaselineRange,
  settleSymbolBaselines,
  type BaselineHandle,
  type ReadBaselineMeasurement,
} from "../usage-baseline/readBaseline.js";
import { servedWindowsOfResultText } from "../usage-baseline/servedWindows.js";

const LINES = 2000;
const bigLine = (index: number): string =>
  `export const value_${String(index).padStart(4, "0")} = computeSomething(${index}, "padding-text");\n`;
const bigLines = Array.from({ length: LINES }, (_unused, index) => bigLine(index + 1));
const bigContent = bigLines.join("");
const bigBytes = Buffer.byteLength(bigContent);
// `big.ts` (~130 KB) is over the native read limit of 100,000 bytes (25,000
// tokens), so a whole-file read of it is credited one native window, not 130 KB.
const bigWindowBytes = Math.min(bigBytes, NATIVE_READ_MAX_BYTES);
/** Bytes of lines `start..end` (1-based inclusive) of `big.ts`. */
const bytesOfLines = (start: number, end: number): number =>
  Buffer.byteLength(bigLines.slice(start - 1, end).join(""));

/** A 1.59 MB source file, the size of the one in the field report: 20,000 lines of 80 bytes. */
const HUGE_LINES = 20_000;
const hugeLine = (index: number): string =>
  `${`// huge ${String(index).padStart(5, "0")} `.padEnd(79, ".")}\n`;
const hugeContent = Array.from({ length: HUGE_LINES }, (_unused, index) => hugeLine(index + 1)).join("");
const hugeBytes = Buffer.byteLength(hugeContent);
/** 10,000 lines of 10 bytes: 100,000 bytes, so only the 2,000-line limit can cut it. */
const SHORT_LINES = 10_000;
const shortLinesContent = "012345678\n".repeat(SHORT_LINES);
/** `count` lines of 20 bytes each. */
const linesContent = (count: number): string => "0123456789012345678\n".repeat(count);
/** `total` bytes of 100-byte lines (the last line takes the remainder). */
const fixedBytesContent = (total: number): string => {
  const line = `${"x".repeat(99)}\n`;
  const whole = Math.floor(total / line.length);
  const rest = total - whole * line.length;
  return line.repeat(whole) + (rest > 0 ? `${"y".repeat(rest - 1)}\n` : "");
};

let workspace = "";

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), "tl-usage-baseline-"));
  writeFileSync(join(workspace, "big.ts"), bigContent);
  writeFileSync(join(workspace, "small.ts"), "export const small = 1;\n");
  writeFileSync(join(workspace, "empty.ts"), "");
  writeFileSync(join(workspace, "huge.ts"), hugeContent);
  writeFileSync(join(workspace, "short-lines.ts"), shortLinesContent);
  writeFileSync(join(workspace, "lines-2000.ts"), linesContent(NATIVE_READ_MAX_LINES));
  writeFileSync(join(workspace, "lines-2001.ts"), linesContent(NATIVE_READ_MAX_LINES + 1));
  writeFileSync(join(workspace, "exactly-cap.ts"), fixedBytesContent(NATIVE_READ_MAX_BYTES));
  writeFileSync(join(workspace, "over-cap.ts"), fixedBytesContent(NATIVE_READ_MAX_BYTES + 100));
  writeFileSync(join(workspace, "no-eol.ts"), "alpha\nbeta\ngamma");
  writeFileSync(join(workspace, "crlf.ts"), "one\r\ntwo\r\nthree\r\nfour\r\n");
  mkdirSync(join(workspace, "src"));
  writeFileSync(join(workspace, "src", "nested.ts"), "export {};\n");
});

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

const measure = (
  args: Record<string, unknown>,
  extra: Partial<Parameters<typeof measureReadBaseline>[0]> = {},
): ReadBaselineMeasurement => measureReadBaseline({ workspace, args, ...extra });

const credit = (measurement: ReadBaselineMeasurement): Set<string> =>
  new Set(measurement.uncreditedPaths);

describe("read baseline: a whole-file read is credited the file, up to one native read window", () => {
  it("credits a file that fits one native read its byte size, labelled file-bytes", () => {
    const small = measure({ path: "small.ts", mode: "full" });
    expect(small.bytes).toBe(24);
    expect(small.method).toBe("file-bytes");
    expect(small.uncreditedPaths).toEqual([baselinePathKey(join(workspace, "small.ts"))]);
  });

  it("credits a file over the native read limit one window of it, labelled file-bytes", () => {
    const measurement = measure({ path: "big.ts", mode: "full" });
    expect(measurement.bytes).toBe(bigWindowBytes);
    expect(measurement.method).toBe("file-bytes");
    expect(measurement.uncreditedPaths).toEqual([baselinePathKey(join(workspace, "big.ts"))]);
    expect(measurement.pendingSymbols).toEqual([]);
  });

  it("sums a paths[] batch of bare strings and treats a nested path like any other", () => {
    const measurement = measure({ paths: ["big.ts", "small.ts", "src/nested.ts"] });
    expect(measurement.bytes).toBe(bigWindowBytes + 24 + 11);
    expect(measurement.method).toBe("file-bytes");
    expect(measurement.uncreditedPaths).toHaveLength(3);
  });

  it("counts two spellings of one path once per call", () => {
    const measurement = measure({ paths: ["small.ts", "./small.ts", "src/../small.ts"] });
    expect(measurement.bytes).toBe(24);
    expect(measurement.uncreditedPaths).toHaveLength(1);
  });

  it("treats a range that covers every line as a whole-file read", () => {
    for (const range of [`1-${LINES}`, `1-${LINES + 500}`, "full", "all", "1-", "1-end", `L1-L${LINES}`]) {
      const measurement = measure({ path: "big.ts", range, mode: "slice" });
      expect(measurement.bytes, range).toBe(bigWindowBytes);
      expect(measurement.method, range).toBe("file-bytes");
      expect(measurement.uncreditedPaths, range).toHaveLength(1);
    }
  });
});

describe("read baseline: a ranged read is not credited the whole file", () => {
  it("baselines a small range of a large file at that range's bytes", () => {
    const measurement = measure({ path: "big.ts", range: "101-120", mode: "slice" });
    expect(measurement.bytes).toBe(bytesOfLines(101, 120));
    expect(measurement.bytes!).toBeLessThan(bigBytes / 50);
    expect(measurement.method).toBe("range-bytes");
    // Not credited as a whole-file read, so a later whole read still counts.
    expect(measurement.uncreditedPaths).toEqual([]);
  });

  it("covers every shape that carries a range", () => {
    const want = bytesOfLines(10, 14);
    const shapes: Array<[string, Record<string, unknown>]> = [
      ["top-level range", { path: "big.ts", range: "10-14" }],
      ["canonical single target (projected)", { path: "big.ts", range: "10-14", mode: "slice" }],
      ["paths[] object", { paths: [{ path: "big.ts", range: "10-14" }] }],
      ["L-prefix", { path: "big.ts", range: "L10-L14" }],
      ["comma form", { path: "big.ts", range: "10,14" }],
      ["colon form", { path: "big.ts", range: "10:14" }],
      ["legacy lines", { path: "big.ts", lines: "10-14" }],
      ["legacy start/end", { path: "big.ts", start: 10, end: 14 }],
      ["ranges[] pair", { path: "big.ts", ranges: ["10-12", "11-14"] }],
      ["paths[] ranges[]", { paths: [{ path: "big.ts", ranges: ["10-11", "12-14"] }] }],
    ];
    for (const [label, args] of shapes) {
      const measurement = measure(args);
      expect(measurement.bytes, label).toBe(want);
      expect(measurement.method, label).toBe("range-bytes");
      expect(measurement.uncreditedPaths, label).toEqual([]);
    }
  });

  it("sums disjoint windows and a single-line range, clamps past EOF, and reads open ends", () => {
    expect(measure({ path: "big.ts", ranges: ["1-3", "50-52"] }).bytes)
      .toBe(bytesOfLines(1, 3) + bytesOfLines(50, 52));
    expect(measure({ path: "big.ts", range: "7" }).bytes).toBe(bytesOfLines(7, 7));
    expect(measure({ path: "big.ts", range: `${LINES - 1}-${LINES + 50}` }).bytes)
      .toBe(bytesOfLines(LINES - 1, LINES));
    expect(measure({ path: "big.ts", range: `${LINES - 2}-` }).bytes)
      .toBe(bytesOfLines(LINES - 2, LINES));
  });

  it("measures a window it cannot parse or that starts past EOF as nothing, never the whole file", () => {
    for (const range of ["abc", "9-3", "0-5", `${LINES + 1}-${LINES + 9}`]) {
      const measurement = measure({ path: "big.ts", range });
      expect(measurement.bytes, range).toBe(0);
      expect(measurement.method, range).toBe("range-bytes");
    }
  });

  it("does not deduplicate ranged reads and does not let them hide a later whole-file read", () => {
    const first = measure({ path: "big.ts", range: "1-10" });
    const second = measure({ path: "big.ts", range: "1-10" }, { credited: credit(first) });
    expect(second.bytes).toBe(first.bytes);
    const whole = measure({ path: "big.ts" }, { credited: credit(first) });
    expect(whole.bytes).toBe(bigWindowBytes);
  });

  it("counts line terminators, handles CRLF, a missing final newline and an empty file", () => {
    expect(measure({ path: "crlf.ts", range: "2-3" }).bytes).toBe(Buffer.byteLength("two\r\nthree\r\n"));
    expect(measure({ path: "no-eol.ts", range: "2-3" }).bytes).toBe(Buffer.byteLength("beta\ngamma"));
    expect(measure({ path: "no-eol.ts", range: "3" }).bytes).toBe(5);
    const empty = measure({ path: "empty.ts", range: "1-5" });
    expect(empty.bytes).toBe(0);
    expect(empty.method).toBe("range-bytes");
  });

  it("measures a file too large to scan as nothing for a window, not as the whole file", () => {
    const measurement = measure(
      { path: "big.ts", range: "1-10" },
      { maxScannedFileBytes: 1024 },
    );
    expect(measurement.bytes).toBe(0);
    expect(measurement.method).toBe("range-bytes");
    // A whole-file read of the same file is unaffected by the scan limit.
    expect(measure({ path: "big.ts" }, { maxScannedFileBytes: 1024 }).bytes).toBe(bigWindowBytes);
  });

  it("mixes whole-file and ranged entries in one batch", () => {
    const measurement = measure({
      paths: ["small.ts", { path: "big.ts", range: "1-3" }],
    });
    expect(measurement.bytes).toBe(24 + bytesOfLines(1, 3));
    expect(measurement.method).toBe("range-bytes");
    expect(measurement.uncreditedPaths).toEqual([baselinePathKey(join(workspace, "small.ts"))]);
  });
});

describe("parseBaselineRange", () => {
  it("accepts the spellings the slice reader accepts and rejects the rest", () => {
    expect(parseBaselineRange("5", 100)).toEqual([5, 5]);
    expect(parseBaselineRange(" l5 - L9 ", 100)).toEqual([5, 9]);
    expect(parseBaselineRange("5,9", 100)).toEqual([5, 9]);
    expect(parseBaselineRange("5:9", 100)).toEqual([5, 9]);
    expect(parseBaselineRange("5-", 100)).toEqual([5, 100]);
    expect(parseBaselineRange("5-eof", 100)).toEqual([5, 100]);
    expect(parseBaselineRange("whole", 100)).toEqual([1, 100]);
    expect(parseBaselineRange(7, 100)).toEqual([7, 7]);
    expect(parseBaselineRange("9-5", 100)).toBeUndefined();
    expect(parseBaselineRange("0-5", 100)).toBeUndefined();
    expect(parseBaselineRange("Sheet1!A1:B2", 100)).toBeUndefined();
    expect(parseBaselineRange("1,2,3", 100)).toBeUndefined();
    expect(parseBaselineRange(undefined, 100)).toBeUndefined();
  });
});

describe("read baseline: a symbol read is credited the served symbol window", () => {
  it("is pending until the response's served window is known, and never the whole file before then", () => {
    const pending = measure({ path: "big.ts", symbol: "computeSomething", mode: "symbol" });
    expect(pending.bytes).toBe(0);
    expect(pending.method).toBe("range-bytes");
    expect(pending.pendingSymbols).toHaveLength(1);
    expect(pending.uncreditedPaths).toEqual([]);

    const settled = settleSymbolBaselines(pending, workspace, [
      { path: "big.ts", start: 101, end: 140 },
    ]);
    expect(settled.bytes).toBe(bytesOfLines(101, 140));
    expect(settled.method).toBe("range-bytes");
    expect(settled.pendingSymbols).toEqual([]);
    expect(settled.bytes!).toBeLessThan(bigBytes / 20);
  });

  it("settles to nothing when the response served no window for the path", () => {
    const pending = measure({ path: "big.ts", symbol: "computeSomething" });
    for (const windows of [
      [],
      [{ path: "small.ts", start: 1, end: 1 }],
      // An undeclared "whole file" window (end = MAX_SAFE_INTEGER) is not a symbol window.
      [{ path: "big.ts", start: 1, end: Number.MAX_SAFE_INTEGER }],
      [{ path: "big.ts", start: 9, end: 3 }],
    ]) {
      const settled = settleSymbolBaselines(pending, workspace, windows);
      expect(settled.bytes).toBe(0);
      expect(settled.method).toBe("range-bytes");
    }
  });

  it("merges several served windows and matches the path however the response spells it", () => {
    const pending = measure({
      paths: [{ path: "./big.ts", symbol: "a" }, { path: "big.ts", symbol: "b" }],
    });
    expect(pending.pendingSymbols).toHaveLength(1);
    const settled = settleSymbolBaselines(pending, workspace, [
      { path: "big.ts", start: 10, end: 20 },
      { path: join(workspace, "big.ts"), start: 18, end: 30 },
    ]);
    expect(settled.bytes).toBe(bytesOfLines(10, 30));
  });

  it("adds the settled window to the rest of a mixed batch", () => {
    const pending = measure({
      paths: ["small.ts", { path: "big.ts", symbol: "computeSomething" }],
    });
    const settled = settleSymbolBaselines(pending, workspace, [{ path: "big.ts", start: 5, end: 8 }]);
    expect(settled.bytes).toBe(24 + bytesOfLines(5, 8));
    expect(settled.uncreditedPaths).toEqual([baselinePathKey(join(workspace, "small.ts"))]);
  });

  it("is a no-op for a call with nothing pending", () => {
    const measurement = measure({ path: "big.ts" });
    expect(settleSymbolBaselines(measurement, workspace, [{ path: "big.ts", start: 1, end: 2 }]))
      .toBe(measurement);
  });
});

describe("read baseline: repeated whole-file reads are credited once", () => {
  it("credits a path the first time only, then records 0 (not null) for the repeat", () => {
    const first = measure({ path: "big.ts", mode: "full" });
    expect(first.bytes).toBe(bigWindowBytes);
    const repeated = measure({ path: "big.ts", mode: "full" }, { credited: credit(first) });
    expect(repeated.bytes).toBe(0);
    expect(repeated.method).toBe("file-bytes");
    expect(repeated.uncreditedPaths).toEqual([]);
    // Another path in the same call is still credited.
    const withNew = measure({ paths: ["big.ts", "small.ts"] }, { credited: credit(first) });
    expect(withNew.bytes).toBe(24);
  });
});

describe("read baseline: no file is credited more than one native read window", () => {
  const tokensOf = (bytes: number | null): number => Math.ceil((bytes ?? 0) / 4);

  it("states the native limits: 2,000 lines and 25,000 tokens (100,000 bytes)", () => {
    expect(NATIVE_READ_MAX_LINES).toBe(2_000);
    expect(NATIVE_READ_MAX_TOKENS).toBe(25_000);
    expect(NATIVE_READ_MAX_BYTES).toBe(100_000);
  });

  it("credits a 1.59 MB file's whole-file read at most 25,000 tokens, not the ~397,000 of its size", () => {
    expect(hugeBytes).toBeGreaterThan(1_590_000);
    const measurement = measure({ path: "huge.ts", mode: "full" });
    expect(measurement.bytes).toBe(NATIVE_READ_MAX_BYTES);
    expect(tokensOf(measurement.bytes)).toBe(NATIVE_READ_MAX_TOKENS);
    expect(tokensOf(measurement.bytes)).toBeLessThan(tokensOf(hugeBytes) / 10);
    expect(measurement.method).toBe("file-bytes");
    // Still credited once per path: the repeat records 0, not another window.
    const repeated = measure({ path: "huge.ts" }, { credited: credit(measurement) });
    expect(repeated.bytes).toBe(0);
  });

  it("does not let the scan limit bring the whole file back, and reads only the first window", () => {
    expect(measure({ path: "huge.ts" }, { maxScannedFileBytes: 1024 }).bytes)
      .toBe(NATIVE_READ_MAX_BYTES);
  });

  it("cuts a file of many short lines after 2,000 lines even when it is under the byte limit", () => {
    expect(Buffer.byteLength(shortLinesContent)).toBe(NATIVE_READ_MAX_BYTES);
    expect(measure({ path: "short-lines.ts" }).bytes).toBe(NATIVE_READ_MAX_LINES * 10);
  });

  it("is unchanged exactly at the limits and capped one line or one byte-run past them", () => {
    expect(measure({ path: "lines-2000.ts" }).bytes).toBe(NATIVE_READ_MAX_LINES * 20);
    // 2,001 lines: the 2,001st is not part of a native read.
    expect(measure({ path: "lines-2001.ts" }).bytes).toBe(NATIVE_READ_MAX_LINES * 20);
    expect(measure({ path: "exactly-cap.ts" }).bytes).toBe(NATIVE_READ_MAX_BYTES);
    expect(measure({ path: "over-cap.ts" }).bytes).toBe(NATIVE_READ_MAX_BYTES);
    expect(measure({ path: "empty.ts" }).bytes).toBe(0);
    expect(measure({ path: "no-eol.ts" }).bytes).toBe(Buffer.byteLength("alpha\nbeta\ngamma"));
  });

  it("applies the bound to each file of a batch, not to the batch", () => {
    const measurement = measure({ paths: ["huge.ts", "big.ts", "small.ts"] });
    expect(measurement.bytes).toBe(2 * NATIVE_READ_MAX_BYTES + 24);
    expect(measurement.uncreditedPaths).toHaveLength(3);
  });

  it("bounds a ranged read by the same window (2,000 lines, 100,000 bytes)", () => {
    // 5,000 lines of 80 bytes would be 400,000 bytes: the byte limit cuts them.
    const huge = measure({ path: "huge.ts", range: "1-5000" });
    expect(huge.bytes).toBe(NATIVE_READ_MAX_BYTES);
    expect(huge.method).toBe("range-bytes");
    expect(huge.uncreditedPaths).toEqual([]);
    // 9,000 short lines: the line limit cuts them.
    expect(measure({ path: "short-lines.ts", range: "1-9000" }).bytes).toBe(NATIVE_READ_MAX_LINES * 10);
    // Lines accumulate across the windows of one file: 1,500 + 500 of the next.
    expect(measure({ path: "short-lines.ts", ranges: ["1-1500", "3000-5000"] }).bytes)
      .toBe(NATIVE_READ_MAX_LINES * 10);
    // A window inside the limits is untouched.
    expect(measure({ path: "huge.ts", range: "100-199" }).bytes).toBe(100 * 80);
  });

  it("bounds a symbol's served window too", () => {
    const pending = measure({ path: "huge.ts", symbol: "anything" });
    const settled = settleSymbolBaselines(pending, workspace, [
      { path: "huge.ts", start: 1, end: 15_000 },
    ]);
    expect(settled.bytes).toBe(NATIVE_READ_MAX_BYTES);
    const small = settleSymbolBaselines(pending, workspace, [{ path: "huge.ts", start: 10, end: 19 }]);
    expect(small.bytes).toBe(10 * 80);
  });

  it("treats a handle window spanning a huge file as one bounded whole-file read", () => {
    const resolveHandle = (): BaselineHandle => ({ path: "huge.ts", range: `1-${HUGE_LINES}` });
    const measurement = measure({ handle: "hHuge" }, { resolveHandle });
    expect(measurement.bytes).toBe(NATIVE_READ_MAX_BYTES);
    expect(measurement.method).toBe("file-bytes");
  });
});

describe("read baseline: calls with nothing to compare against have no baseline", () => {
  it("returns null for a query-only task_pack and for other pathless calls", () => {
    for (const args of [
      { query: "where is the click handler?", mode: "task_pack" },
      { qref: "q-0123456789abcdef" },
      { cursor: "c1" },
      { content: "outline" },
      {},
    ]) {
      const measurement = measure(args);
      expect(measurement.bytes, JSON.stringify(args)).toBeNull();
      expect(measurement.method, JSON.stringify(args)).toBeNull();
      expect(measurement.uncreditedPaths).toEqual([]);
    }
    expect(emptyReadBaseline()).toEqual({ bytes: null, method: null, uncreditedPaths: [], pendingSymbols: [] });
  });

  it("returns null for missing files, directories and paths outside the workspace", () => {
    for (const args of [
      { path: "does-not-exist.ts" },
      { path: "src" },
      { path: "../outside.ts" },
      { paths: [{ path: "does-not-exist.ts", range: "1-5" }] },
    ]) {
      expect(measure(args).bytes, JSON.stringify(args)).toBeNull();
    }
  });
});

describe("read baseline: handle slices", () => {
  const handles: Record<string, BaselineHandle> = {
    hRange: { path: "big.ts", range: "5-9" },
    hSymbolWithRange: { path: "big.ts", range: "300-340", symbol: "computeSomething" },
    hSymbolOnly: { path: "big.ts", symbol: "computeSomething" },
    hBare: { path: "big.ts" },
    hWholeRange: { path: "big.ts", range: `1-${LINES}` },
  };
  const resolveHandle = (handle: string): BaselineHandle | undefined => handles[handle];

  it("baselines a handle slice at the window the handle was minted with", () => {
    const measurement = measure({ handle: "hRange" }, { resolveHandle });
    expect(measurement.bytes).toBe(bytesOfLines(5, 9));
    expect(measurement.method).toBe("range-bytes");
    expect(measurement.uncreditedPaths).toEqual([]);
  });

  it("lets the handle's path win over a conflicting path, and an explicit range win over the stored one", () => {
    expect(measure({ handle: "hRange", path: "small.ts" }, { resolveHandle }).bytes)
      .toBe(bytesOfLines(5, 9));
    expect(measure({ handle: "hRange", range: "1-2" }, { resolveHandle }).bytes)
      .toBe(bytesOfLines(1, 2));
  });

  it("uses a symbol handle's stored body range directly", () => {
    const measurement = measure({ handle: "hSymbolWithRange" }, { resolveHandle });
    expect(measurement.bytes).toBe(bytesOfLines(300, 340));
    expect(measurement.pendingSymbols).toEqual([]);
  });

  it("leaves a symbol-only handle pending", () => {
    const measurement = measure({ handle: "hSymbolOnly" }, { resolveHandle });
    expect(measurement.pendingSymbols).toHaveLength(1);
    expect(measurement.method).toBe("range-bytes");
  });

  it("measures an all-handle batch with per-item overrides", () => {
    const measurement = measure(
      { handles: ["hRange", "hRange"] },
      { resolveHandle, handleOverrides: [undefined, { range: "20-22" }] },
    );
    expect(measurement.bytes).toBe(bytesOfLines(5, 9) + bytesOfLines(20, 22));
  });

  it("keeps a bare or unknown handle with no path unmeasured, and a bare handle beside a path whole-file", () => {
    expect(measure({ handle: "hBare" }, { resolveHandle }).bytes).toBeNull();
    expect(measure({ handle: "hMissing" }, { resolveHandle }).bytes).toBeNull();
    expect(measure({ handle: "hMissing" }).bytes).toBeNull();
    expect(measure({ path: "big.ts", handle: "hBare" }, { resolveHandle }).bytes).toBe(bigWindowBytes);
    // A stale handle beside a path self-heals to that path's own window.
    expect(measure({ path: "big.ts", handle: "hMissing", range: "1-4" }, { resolveHandle }).bytes)
      .toBe(bytesOfLines(1, 4));
  });

  it("treats a handle window that spans the whole file as a whole-file read", () => {
    const measurement = measure({ handle: "hWholeRange" }, { resolveHandle });
    expect(measurement.bytes).toBe(bigWindowBytes);
    expect(measurement.method).toBe("file-bytes");
    const repeated = measure({ handle: "hWholeRange" }, { resolveHandle, credited: credit(measurement) });
    expect(repeated.bytes).toBe(0);
  });

  it("measures {handle} targets inside paths[]", () => {
    const measurement = measure(
      { paths: [{ handle: "hRange" }, { handle: "hBare" }] },
      { resolveHandle },
    );
    expect(measurement.bytes).toBe(bytesOfLines(5, 9));
  });
});

describe("servedWindowsOfResultText", () => {
  it("reads the declared file window of a symbol-style response", () => {
    const text = JSON.stringify({
      kind: "read.symbol",
      path: "big.ts",
      symbol: "computeSomething",
      range: "101-140",
      handle: "h1",
      content: "// tokenlighten:scope path=big.ts symbol=computeSomething\nexport const a = 1;\n",
    });
    expect(servedWindowsOfResultText(text)).toEqual([{ path: "big.ts", start: 101, end: 140 }]);
  });

  it("returns no windows for non-JSON text, a refusal, or a non-string", () => {
    expect(servedWindowsOfResultText("not json")).toEqual([]);
    expect(servedWindowsOfResultText(JSON.stringify({ kind: "refusal", code: "not-found" }))).toEqual([]);
    expect(servedWindowsOfResultText(undefined)).toEqual([]);
    expect(servedWindowsOfResultText(JSON.stringify([1, 2]))).toEqual([]);
  });
});
