/**
 * csvTable.spec.ts — unit coverage for office/csv.ts (the pure, dependency-free
 * CSV/TSV parser + structured table extractor). Exercises the RFC4180 parser,
 * dialect sniffing, header detection, range/columns selection, the caps mirrored
 * from office/xlsx.ts, and the honest-truncation note — all without spawning a
 * server (csv.ts has no async deps). Server dispatch + the ≤ budget wire bound
 * are covered end-to-end in readCodeCsvDispatch.spec.ts.
 */

import { describe, it, expect } from "vitest";
import {
  csvTable,
  sniffCsvDialect,
  parseCsv,
  decodeCsvBytes,
  type CsvTableResult,
} from "../office/csv.js";

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
function bytes(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "utf8"));
}
function ok(result: ReturnType<typeof csvTable>): CsvTableResult {
  expect(result.ok).toBe(true);
  return result as CsvTableResult;
}

describe("parseCsv — RFC4180", () => {
  it("parses simple comma rows and drops the trailing-newline phantom record", () => {
    expect(parseCsv("a,b,c\n1,2,3\n", ",")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
    // No trailing newline: still flushes the last record.
    expect(parseCsv("a,b\n1,2", ",")).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("honors quoting: embedded delimiter, embedded newline, and \"\" escapes", () => {
    const text = 'name,note\n"Smith, John","line1\nline2"\n"She said ""hi""",ok\n';
    expect(parseCsv(text, ",")).toEqual([
      ["name", "note"],
      ["Smith, John", "line1\nline2"],
      ['She said "hi"', "ok"],
    ]);
  });

  it("treats CRLF and lone CR as record separators", () => {
    expect(parseCsv("a,b\r\n1,2\r\n", ",")).toEqual([["a", "b"], ["1", "2"]]);
    expect(parseCsv("a,b\r1,2", ",")).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("stops after opts.limit records (sniff sampler)", () => {
    const text = Array.from({ length: 50 }, (_, i) => `${i},x`).join("\n");
    expect(parseCsv(text, ",", '"', { limit: 3 })).toHaveLength(3);
  });
});

describe("decodeCsvBytes", () => {
  it("strips a leading UTF-8 BOM", () => {
    expect(decodeCsvBytes(new Uint8Array(Buffer.concat([BOM, Buffer.from("a,b", "utf8")])))).toBe("a,b");
    expect(decodeCsvBytes(bytes("a,b"))).toBe("a,b");
  });
});

describe("sniffCsvDialect", () => {
  it("picks comma by most-consistent field count", () => {
    const d = sniffCsvDialect("code,base_rate,min\nA001,123.45,50\nA002,200,100\n");
    expect(d.delimiter).toBe(",");
    expect(d.headerLikely).toBe(true);
    expect(d.quote).toBe('"');
  });

  it("sniffs semicolon and pipe", () => {
    expect(sniffCsvDialect("a;b;c\n1;2;3\n4;5;6\n").delimiter).toBe(";");
    expect(sniffCsvDialect("a|b|c\n1|2|3\n").delimiter).toBe("|");
  });

  it("does not count delimiters inside quotes", () => {
    // Commas live only inside the quoted field → the row is really 2 columns;
    // a naive splitter would see semicolon as more consistent.
    const d = sniffCsvDialect('id;label\n1;"a, b, c"\n2;"d, e"\n');
    expect(d.delimiter).toBe(";");
  });

  it("forces tab when the extension is tsv (even if commas are present)", () => {
    const d = sniffCsvDialect("x\ty,z\n1\t2,3\n", { ext: "tsv" });
    expect(d.delimiter).toBe("\t");
  });

  it("flags a numeric first row as headerless", () => {
    expect(sniffCsvDialect("1,2,3\n4,5,6\n").headerLikely).toBe(false);
  });
});

describe("csvTable — structured serving", () => {
  it("returns columns + positional-tuple rows with row-number range and dialect", () => {
    const t = ok(csvTable(bytes("code,base_rate,min\nA001,123.45,50\nA002,200,100\n")));
    expect(t.columns).toEqual(["code", "base_rate", "min"]);
    // C10.3: rows are tuples aligned with columns, cells kept as strings.
    expect(t.rows).toEqual([
      ["A001", "123.45", "50"],
      ["A002", "200", "100"],
    ]);
    expect(t.range).toBe("2-3"); // header=row1, data=rows 2..3
    expect(t.total_rows).toBe(2);
    expect(t.total_columns).toBe(3);
    expect(t.truncated).toBe(false);
    expect(t.dialect).toEqual({ delimiter: ",", header: true });
    expect(t.note).toBeUndefined();
  });

  it("handles BOM + CRLF transparently", () => {
    const raw = new Uint8Array(Buffer.concat([BOM, Buffer.from("a,b\r\n1,2\r\n3,4\r\n", "utf8")]));
    const t = ok(csvTable(raw));
    expect(t.columns).toEqual(["a", "b"]);
    expect(t.rows).toEqual([["1", "2"], ["3", "4"]]);
  });

  it("forces tab for tsv via the ext option", () => {
    const t = ok(csvTable(bytes("x\ty\tz\n1\t2\t3\n"), { ext: ".tsv" }));
    expect(t.dialect.delimiter).toBe("\t");
    expect(t.columns).toEqual(["x", "y", "z"]);
    expect(t.rows).toEqual([["1", "2", "3"]]);
  });

  it("synthesizes col_1..col_n for headerless data (header:false)", () => {
    const t = ok(csvTable(bytes("1,2,3\n4,5,6\n")));
    expect(t.columns).toEqual(["col_1", "col_2", "col_3"]);
    expect(t.dialect.header).toBe(false);
    expect(t.total_rows).toBe(2); // both rows are data
    expect(t.range).toBe("1-2"); // headerless data begins at row 1
    expect(t.rows).toEqual([["1", "2", "3"], ["4", "5", "6"]]);
  });

  it("tolerates ragged rows: short rows pad with null, wide rows clamp to the header", () => {
    const t = ok(csvTable(bytes("a,b,c\n1,2\n4,5,6,7\n")));
    expect(t.total_columns).toBe(3);
    expect(t.rows).toEqual([
      ["1", "2", null],
      ["4", "5", "6"],
    ]);
  });

  it("selects a data-row span by range (row-number form)", () => {
    const csv = "id,v\nr1,1\nr2,2\nr3,3\nr4,4\nr5,5\n";
    const t = ok(csvTable(bytes(csv), { range: "3-4" }));
    expect(t.rows).toEqual([["r2", "2"], ["r3", "3"]]);
    expect(t.range).toBe("3-4");
    expect(t.total_rows).toBe(5);
    expect(t.truncated).toBe(false); // an explicit in-bounds window is not truncated
  });

  it("selects columns by name (case-sensitive exact, then case-insensitive)", () => {
    const csv = "id,Value\nr1,1\nr2,2\n";
    const exact = ok(csvTable(bytes(csv), { columns: ["Value"] }));
    expect(exact.columns).toEqual(["Value"]);
    expect(exact.rows).toEqual([["1"], ["2"]]);
    // case-insensitive fallback
    const ci = ok(csvTable(bytes(csv), { columns: ["value"] }));
    expect(ci.columns).toEqual(["Value"]);
    // no match → serve all columns + a warning
    const none = ok(csvTable(bytes(csv), { columns: ["nope"] }));
    expect(none.columns).toEqual(["id", "Value"]);
    expect(none.warnings.some((w) => /No requested column matched/.test(w))).toBe(true);
  });

  it("caps rows to maxRows and emits an honest range= note for the remainder", () => {
    const rows = Array.from({ length: 5 }, (_, i) => `r${i + 1},${i + 1}`).join("\n");
    const t = ok(csvTable(bytes(`id,v\n${rows}\n`), { maxRows: 2 }));
    expect(t.rows).toHaveLength(2);
    expect(t.range).toBe("2-3");
    expect(t.truncated).toBe(true);
    expect(t.total_rows).toBe(5);
    expect(t.note).toBe("served rows 2-3 of 5 data rows; fetch more with range=4-6");
  });

  it("honors the maxCells cap (rows * columns) — the bounded-serving invariant", () => {
    // 8 columns, 100 data rows, maxCells 40 → at most floor(40/8)=5 rows served.
    const header = Array.from({ length: 8 }, (_, i) => `c${i}`).join(",");
    const dataRows = Array.from({ length: 100 }, (_, r) =>
      Array.from({ length: 8 }, (_, c) => `${r}_${c}`).join(",")).join("\n");
    const t = ok(csvTable(bytes(`${header}\n${dataRows}\n`), { maxCells: 40 }));
    expect(t.rows.length * t.columns.length).toBeLessThanOrEqual(40);
    expect(t.rows).toHaveLength(5);
    expect(t.truncated).toBe(true);
    expect(t.total_rows).toBe(100);
  });

  it("caps columns to 50 (mirrors xlsx MAX_COLS) and reports the true total", () => {
    const header = Array.from({ length: 80 }, (_, i) => `c${i}`).join(",");
    const row = Array.from({ length: 80 }, (_, i) => String(i)).join(",");
    const t = ok(csvTable(bytes(`${header}\n${row}\n`)));
    expect(t.columns).toHaveLength(50);
    expect(t.total_columns).toBe(80);
    expect(t.warnings.some((w) => /Columns truncated to 50/.test(w))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TL-SECURITY-REVIEW-2026-08-15 finding 1 (CWE-400): parseCsv used to
// accumulate every record from the input into an array with no row/cell
// output limit ever consulted during parsing — a huge or adversarial file
// paid the full parse-and-retain cost before csvTable's row/cell caps got
// any say. Mechanism tests below inject small quota values directly (no
// multi-MB fixtures needed — parseCsv's quota is a per-call option); the
// last two tests exercise csvTable's REAL (non-injected) PARSE_MAX_* wiring
// end-to-end with deliberately cheap inputs.
// ---------------------------------------------------------------------------
describe("parseCsv — parse-time quotas (CWE-400, finding 1)", () => {
  it("quota.maxChars aborts parsing before the whole input is consumed", () => {
    const text = Array.from({ length: 50 }, (_, i) => `row${i},value${i}`).join("\n") + "\n";
    const truncatedRef = { truncated: false };
    const records = parseCsv(text, ",", '"', { quota: { maxChars: 50 }, truncatedRef });
    expect(records.length).toBeGreaterThan(0);
    expect(records.length).toBeLessThan(50);
    expect(truncatedRef.truncated).toBe(true);
  });

  it("quota.maxCumulativeCells aborts once the running field count exceeds it", () => {
    // 3 fields/record; budget 15 is exactly 5 records' worth, so the abort
    // fires right after the 6th record's fields push the total to 18.
    const text = Array.from({ length: 50 }, (_, i) => `${i},${i},${i}`).join("\n") + "\n";
    const truncatedRef = { truncated: false };
    const records = parseCsv(text, ",", '"', { quota: { maxCumulativeCells: 15 }, truncatedRef });
    expect(records).toHaveLength(6);
    expect(truncatedRef.truncated).toBe(true);
  });

  it("quota.maxFieldsPerRecord flushes and stops on a single pathologically wide record", () => {
    const text = "a,".repeat(1000) + "end";
    const truncatedRef = { truncated: false };
    const records = parseCsv(text, ",", '"', { quota: { maxFieldsPerRecord: 100 }, truncatedRef });
    expect(records).toHaveLength(1);
    expect(records[0]).toHaveLength(100);
    expect(truncatedRef.truncated).toBe(true);
  });

  it("no quota supplied (the default) parses the whole input exactly as before", () => {
    const text = "a,b\n1,2\n3,4\n";
    const truncatedRef = { truncated: false };
    const records = parseCsv(text, ",", '"', { truncatedRef });
    expect(records).toEqual([["a", "b"], ["1", "2"], ["3", "4"]]);
    expect(truncatedRef.truncated).toBe(false);
  });

  it("the pre-existing opts.limit record-count stop also marks truncatedRef when supplied", () => {
    const text = "1\n2\n3\n4\n5\n";
    const truncatedRef = { truncated: false };
    const records = parseCsv(text, ",", '"', { limit: 2, truncatedRef });
    expect(records).toHaveLength(2);
    expect(truncatedRef.truncated).toBe(true);
  });
});

describe("csvTable — parse-time safety quota wiring (finding 1)", () => {
  it("a single pathologically wide record trips the real PARSE_MAX_FIELDS_PER_RECORD ceiling and is honestly disclosed", () => {
    // 50,000 fields in ONE record — a cheap (~150KB) string to build/parse,
    // but well past the 50 real columns any csvTable caller ever asked for.
    const hugeRecord = "a,".repeat(50_000) + "end";
    const t = ok(csvTable(bytes(hugeRecord)));
    expect(t.truncated).toBe(true);
    expect(t.warnings.some((w) => /larger than this server safely parses/.test(w))).toBe(true);
  });

  it("a normal, moderately large CSV (10,000 rows) is unaffected — parses fully with an exact total_rows", () => {
    const rows = Array.from({ length: 10_000 }, (_, i) => `${i},v${i},${i * 2}`).join("\n");
    const t = ok(csvTable(bytes(`id,label,double\n${rows}\n`), { maxRows: 0 }));
    expect(t.total_rows).toBe(10_000);
    expect(t.warnings.some((w) => /larger than this server safely parses/.test(w))).toBe(false);
  });
});
