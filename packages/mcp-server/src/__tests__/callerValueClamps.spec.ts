// callerValueClamps.spec.ts — CWE-400/409 caller-value hard clamp regression
// coverage (TL-V0.9-RELEASE-STRATEGY-2026-08-12.md §6.6-2 item 3, deferred
// item, shipped 2026-08-13).
//
// Before this wave, four caller-supplied numeric knobs passed straight
// through with no ceiling (in-parse cumulative caps already existed —
// office/pdf.ts MAX_PAGES/char caps, docx/pptx/xlsx/csv internal defaults —
// but nothing bounded the CALLER's own override of those knobs, because
// there is no schema-validation layer and undeclared/out-of-range args pass
// straight through server.ts's dispatch):
//   - tools/extractOfficeText.ts: maxBytes, maxTokens
//   - tools/readCodePack.ts (path-pack branch only): maxTokens
//   - office/xlsx.ts (xlsxTable): maxRows, maxCells
//   - office/csv.ts (csvTable): maxRows, maxCells
//
// Each knob gets two layers of coverage:
//   1. A direct unit test of the exported pure clamp helper (clampCallerNumber
//      / clampPackMaxTokens / clampTableCount) pinning the exact ceiling
//      numbers — proving the ceiling through the real xlsxTable/csvTable
//      entry point would need an implausibly large in-memory fixture (10,000+
//      rows / an 11 MiB document) for the huge-value case.
//   2. An integration test through the REAL entry point (extractOfficeText /
//      readCodePack / xlsxTable / csvTable) with small/moderate fixtures,
//      covering: (a) an absurd caller value still completes with bounded,
//      sane output, (b) an in-range explicit value is honored exactly
//      (control), (c) omitting the knob matches the pre-clamp default
//      byte-for-byte (control).
//
// Not covered here (already correct before this wave, unchanged by it):
// readCodeQueryPack's own maxTokens clamp (Math.min(...,
// QUERY_PACK_HARD_CAP_TOKENS) at readCodePack.ts:~279) — this wave only
// added the missing clamp to the PATH-pack branch, mirroring that existing
// pattern; office/pdf.ts's pages[] selector, which already bounds via
// MAX_PAGES (office/pdf.ts:74, parsePageSelector).

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  extractOfficeText,
  clampCallerNumber,
  MAX_RESPONSE_BYTES,
} from "../tools/extractOfficeText.js";
import {
  readCodePack,
  clampPackMaxTokens,
  PACK_DEFAULT_MAX_TOKENS,
  QUERY_PACK_HARD_CAP_TOKENS,
} from "../tools/readCodePack.js";
import { xlsxTable, clampTableCount as clampXlsxTableCount, MAX_RANGE_COL_SPAN } from "../office/xlsx.js";
import { csvTable, clampTableCount as clampCsvTableCount } from "../office/csv.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

// Minimal DOCX builder (same shape as extractOfficeText.spec.ts's
// buildMinimalDocx) — parameterized on paragraph count so callers can build
// either a tiny fixture (maxBytes tests) or a padded one with enough real
// text to make maxTokens truncation observable.
type JSZipFull = {
  file(name: string, data: string): void;
  generateAsync(opts: { type: "nodebuffer" }): Promise<Buffer>;
};

async function buildPaddedDocx(paragraphCount: number): Promise<Uint8Array> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const JSZipCtor = (await import("jszip")) as unknown as { default: new () => JSZipFull };
  const zip: JSZipFull = new JSZipCtor.default();

  const paragraphs = Array.from(
    { length: paragraphCount },
    (_, i) => `<w:p><w:r><w:t>Filler paragraph number ${i} with extra padding words to reach a decent length.</w:t></w:r></w:p>`,
  ).join("\n");
  const contentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${paragraphs}</w:body></w:document>`;

  const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
  const wordRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;
  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;

  zip.file("_rels/.rels", relsXml);
  zip.file("[Content_Types].xml", contentTypesXml);
  zip.file("word/document.xml", contentXml);
  zip.file("word/_rels/document.xml.rels", wordRelsXml);

  const buf = await zip.generateAsync({ type: "nodebuffer" });
  return new Uint8Array(buf);
}

// exceljs fixture builder — same shape as readCodeArtifact.spec.ts's
// createTestXlsx.
async function createTestXlsx(data: unknown[][]): Promise<Uint8Array> {
  const exceljs = await import("exceljs");
  const ExcelJs = (exceljs as { default?: { Workbook: new () => unknown } } & { Workbook?: new () => unknown });
  const WorkbookCtor = (ExcelJs.Workbook ? ExcelJs : ExcelJs.default) as { Workbook: new () => {
    addWorksheet(name: string): { addRow(row: unknown[]): void };
    xlsx: { writeBuffer(): Promise<ArrayBuffer | Buffer> };
  } };
  const wb = new WorkbookCtor.Workbook();
  const ws = wb.addWorksheet("TestSheet");
  for (const row of data) ws.addRow(row);
  const buffer = await wb.xlsx.writeBuffer();
  return new Uint8Array(buffer as ArrayBuffer);
}

function smallXlsxData(rows: number): unknown[][] {
  const data: unknown[][] = [["id", "val"]];
  for (let i = 1; i <= rows; i++) data.push([`R${i}`, i]);
  return data;
}

function csvBytes(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "utf8"));
}

function smallCsv(rows: number): Uint8Array {
  const lines = ["id,v"];
  for (let i = 1; i <= rows; i++) lines.push(`r${i},${i}`);
  return csvBytes(lines.join("\n") + "\n");
}

// readCodePack harness — mirrors symbolRegexHardening.spec.ts's direct
// in-process call pattern (real tmp-dir-backed readFileSafe, no server spawn).
const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }
});

function mkDir(tag: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tl-clamp-${tag}-`));
  tmpDirs.push(dir);
  return dir;
}

function writeFile(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

async function readFileSafe(ws: string, rel: string): Promise<string | null> {
  try {
    return fs.readFileSync(path.join(ws, rel), "utf8");
  } catch {
    return null;
  }
}

// ===========================================================================
// 1. tools/extractOfficeText.ts — maxBytes, maxTokens
// ===========================================================================

describe("clampCallerNumber (extractOfficeText.ts) — pure clamp math", () => {
  it("passes undefined through as fallback, and finite in-range values through unchanged (including at the ceiling)", () => {
    expect(clampCallerNumber(undefined, 1000, 10000)).toBe(1000);
    expect(clampCallerNumber(500, 1000, 10000)).toBe(500);
    expect(clampCallerNumber(1, 1000, 10000)).toBe(1);
    expect(clampCallerNumber(10000, 1000, 10000)).toBe(10000);
  });

  it("clamps a finite value above the ceiling down to the ceiling", () => {
    expect(clampCallerNumber(1e12, 1000, 10000)).toBe(10000);
    expect(clampCallerNumber(10001, 1000, 10000)).toBe(10000);
  });

  it("sanitizes non-finite (Infinity/-Infinity/NaN) and negative/zero values to the fallback", () => {
    for (const absurd of [Infinity, -Infinity, NaN, -1, 0]) {
      expect(clampCallerNumber(absurd, 1000, 10000)).toBe(1000);
    }
  });
});

describe("extractOfficeText — maxBytes/maxTokens caller-value hard clamp (real entry point)", () => {
  it("(a) maxBytes: values far above the 10 MiB ceiling are clamped, not honored raw — an 11 MiB file is still rejected", async () => {
    // The size guard runs before any real document parsing, so a fake
    // (non-document) buffer whose LENGTH sits between the 10 MiB clamp
    // ceiling and the caller's absurd request is enough to prove the
    // ceiling — ok:false/"too-large" here would be wrong if 1e12/Infinity
    // were honored raw (an 11 MiB file would then pass straight through).
    const bigFakeBytes = new Uint8Array(11 * 1024 * 1024);
    for (const absurd of [1e12, Infinity]) {
      const result = await extractOfficeText(bigFakeBytes, { path: "huge.xlsx", maxBytes: absurd });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.code).toBe("too-large");
    }
  });

  it("(a) maxBytes: non-finite/negative/zero caller values sanitize to the 1 MiB default, not to a value that rejects every file", async () => {
    const bytes = await buildPaddedDocx(5);
    for (const garbage of [NaN, -1, 0]) {
      const result = await extractOfficeText(bytes, { path: "data.docx", maxBytes: garbage });
      expect(result.ok).toBe(true);
    }
  });

  it("(b) maxBytes: an in-range explicit value is honored exactly (control)", async () => {
    const bytes = new Uint8Array(2000);
    const result = await extractOfficeText(bytes, { path: "big.docx", maxBytes: 100 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("too-large");
  });

  it("(c) maxBytes: omitting the knob matches the explicit 1 MiB default byte-for-byte", async () => {
    const bytes = await buildPaddedDocx(5);
    const omitted = await extractOfficeText(bytes, { path: "data.docx" });
    const explicitDefault = await extractOfficeText(bytes, { path: "data.docx", maxBytes: 1 * 1024 * 1024 });
    expect(omitted.ok).toBe(true);
    expect(explicitDefault.ok).toBe(true);
    if (!omitted.ok || !explicitDefault.ok) return;
    expect(omitted.data).toEqual(explicitDefault.data);
  });

  it("(a) maxTokens: absurd values (1e12, Infinity, NaN, -1, 0) complete with bounded, un-truncated output", async () => {
    // ~100 short paragraphs: comfortably under the 4000-token DEFAULT budget
    // (so garbage sanitizing to the default never truncates) and light-years
    // under the 5,000,000-token CEILING (so a huge value clamped to the
    // ceiling never truncates either) — every one of the 5 absurd values
    // should therefore yield the SAME un-truncated, bounded result.
    const bytes = await buildPaddedDocx(100);
    for (const value of [1e12, Infinity, NaN, -1, 0]) {
      const result = await extractOfficeText(bytes, { path: "padded.docx", maxTokens: value });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(Buffer.byteLength(result.data.text, "utf8")).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
      expect(result.data.truncated).toBe(false);
      expect(result.data.text).not.toContain("[truncated at");
    }
  });

  it("(b) maxTokens: a small in-range explicit value is honored exactly (control) — visibly truncates", async () => {
    const bytes = await buildPaddedDocx(100);
    const result = await extractOfficeText(bytes, { path: "padded.docx", maxTokens: 5 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.truncated).toBe(true);
    expect(result.data.text).toContain("[truncated at 5 tokens]");
  });

  it("(c) maxTokens: omitting the knob matches the explicit 4000 default byte-for-byte", async () => {
    const bytes = await buildPaddedDocx(100);
    const omitted = await extractOfficeText(bytes, { path: "padded.docx" });
    const explicitDefault = await extractOfficeText(bytes, { path: "padded.docx", maxTokens: 4000 });
    expect(omitted.ok).toBe(true);
    expect(explicitDefault.ok).toBe(true);
    if (!omitted.ok || !explicitDefault.ok) return;
    expect(omitted.data).toEqual(explicitDefault.data);
  });
});

// ===========================================================================
// 2. tools/readCodePack.ts (path-pack) — maxTokens
// ===========================================================================

describe("clampPackMaxTokens (readCodePack.ts) — pure clamp math", () => {
  it("undefined and non-finite/negative/zero values all collapse to PACK_DEFAULT_MAX_TOKENS (4000)", () => {
    expect(PACK_DEFAULT_MAX_TOKENS).toBe(4000);
    expect(clampPackMaxTokens(undefined)).toBe(PACK_DEFAULT_MAX_TOKENS);
    for (const absurd of [NaN, Infinity, -Infinity, -1, 0]) {
      expect(clampPackMaxTokens(absurd)).toBe(PACK_DEFAULT_MAX_TOKENS);
    }
  });

  it("finite positive values at or under QUERY_PACK_HARD_CAP_TOKENS (2400) pass through unchanged", () => {
    expect(QUERY_PACK_HARD_CAP_TOKENS).toBe(2400);
    expect(clampPackMaxTokens(1000)).toBe(1000);
    expect(clampPackMaxTokens(QUERY_PACK_HARD_CAP_TOKENS)).toBe(QUERY_PACK_HARD_CAP_TOKENS);
  });

  it("finite positive values above QUERY_PACK_HARD_CAP_TOKENS clamp down to it — a 'reasonable' 3000 as well as an absurd 1e12", () => {
    expect(clampPackMaxTokens(1e12)).toBe(QUERY_PACK_HARD_CAP_TOKENS);
    expect(clampPackMaxTokens(3000)).toBe(QUERY_PACK_HARD_CAP_TOKENS);
  });
});

describe("readCodePack (path-pack) — maxTokens caller-value hard clamp (real entry point)", () => {
  it("(a) a huge FINITE maxTokens clamps to the 2400-token ceiling (item omitted); non-finite/negative/zero sanitize to the 4000-token default (item served in full) — same underlying file", async () => {
    const ws = mkDir("absurd");
    // 300 lines x 39 chars + 299 separators = 11,999 chars: strictly between
    // the ceiling's char budget (2400*4=9600) and the default's (4000*4=16000)
    // — the two branches this clamp can take are therefore DISTINGUISHABLE
    // through the real pack-assembly budget check, not just the pure helper.
    const line = "x".repeat(39);
    const content = Array.from({ length: 300 }, () => line).join("\n") + "\n";
    writeFile(ws, "content.ts", content);

    // Only a huge but FINITE value takes the clamp-to-ceiling branch (2400).
    // Infinity/-Infinity are non-finite, same as NaN — see the "garbage"
    // group below; this mirrors clampPackMaxTokens's own branch order
    // (!Number.isFinite is checked before the ceiling clamp).
    for (const huge of [1e12]) {
      const result = await readCodePack(
        { mode: "pack", paths: [{ path: "content.ts", range: "1-300" }], maxTokens: huge },
        ws,
        (rel) => readFileSafe(ws, rel),
      );
      expect(result.items).toEqual([]);
      expect(result.omitted).toEqual([{ path: "content.ts", range: "1-300", reason: "cap-exceeded" }]);
    }

    for (const garbage of [Infinity, -Infinity, NaN, -1, 0]) {
      const result = await readCodePack(
        { mode: "pack", paths: [{ path: "content.ts", range: "1-300" }], maxTokens: garbage },
        ws,
        (rel) => readFileSafe(ws, rel),
      );
      expect(result.omitted).toEqual([]);
      expect(result.items).toHaveLength(1);
      expect(result.items[0]!.content.length).toBe(11999);
      expect(result.items[0]!.truncated).toBe(false);
    }
  });

  it("(b) an in-range explicit maxTokens value is honored exactly (control)", async () => {
    const ws = mkDir("inrange");
    writeFile(ws, "small.ts", "export const x = 1;\nexport const y = 2;\n");
    const result = await readCodePack(
      { mode: "pack", paths: [{ path: "small.ts", range: "1-2" }], maxTokens: 1000 },
      ws,
      (rel) => readFileSafe(ws, rel),
    );
    expect(result.completeness).toBe("complete");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.content).toBe("export const x = 1;\nexport const y = 2;");
  });

  it("(c) omitting maxTokens matches the explicit 4000-token default byte-for-byte", async () => {
    const ws = mkDir("omitted");
    writeFile(ws, "small.ts", "export const x = 1;\nexport const y = 2;\n");
    const omitted = await readCodePack(
      { mode: "pack", paths: [{ path: "small.ts", range: "1-2" }] },
      ws,
      (rel) => readFileSafe(ws, rel),
    );
    const explicitDefault = await readCodePack(
      { mode: "pack", paths: [{ path: "small.ts", range: "1-2" }], maxTokens: PACK_DEFAULT_MAX_TOKENS },
      ws,
      (rel) => readFileSafe(ws, rel),
    );
    expect(omitted).toEqual(explicitDefault);
  });
});

// ===========================================================================
// 3. office/xlsx.ts (xlsxTable) — maxRows, maxCells
// ===========================================================================

describe("clampTableCount (xlsx.ts) — pure clamp math", () => {
  it("passes undefined through as fallback, and zero through as a literal zero (deliberately NOT sanitized — see xlsx.ts's rationale comment)", () => {
    expect(clampXlsxTableCount(undefined, 200, 10000)).toBe(200);
    expect(clampXlsxTableCount(0, 200, 10000)).toBe(0);
  });

  it("passes finite in-range values through unchanged, including at the ceiling", () => {
    expect(clampXlsxTableCount(50, 200, 10000)).toBe(50);
    expect(clampXlsxTableCount(10000, 200, 10000)).toBe(10000);
  });

  it("clamps a finite value above the ceiling down to the ceiling", () => {
    expect(clampXlsxTableCount(1e12, 200, 10000)).toBe(10000);
  });

  it("sanitizes non-finite (Infinity/-Infinity/NaN) and negative values to the fallback", () => {
    for (const absurd of [Infinity, -Infinity, NaN, -1]) {
      expect(clampXlsxTableCount(absurd, 200, 10000)).toBe(200);
    }
  });
});

describe("xlsxTable — maxRows/maxCells caller-value hard clamp (real entry point)", () => {
  it("(a) huge/Infinity maxRows/maxCells complete without hanging or crashing against a real workbook", async () => {
    const bytes = await createTestXlsx(smallXlsxData(5));
    for (const huge of [1e12, Infinity]) {
      const rowsResult = await xlsxTable(bytes, { maxRows: huge });
      expect(rowsResult.ok).toBe(true);
      const cellsResult = await xlsxTable(bytes, { maxCells: huge });
      expect(cellsResult.ok).toBe(true);
    }
  });

  it("(a) NaN/negative maxRows sanitizes to the 200 default instead of degrading to an empty result", async () => {
    const bytes = await createTestXlsx(smallXlsxData(5));
    for (const garbage of [NaN, -1]) {
      const result = await xlsxTable(bytes, { maxRows: garbage });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      // Pre-fix: Math.min(ws.rowCount, NaN) is NaN and Math.min(ws.rowCount,
      // -1) is -1 — both make the row loop's `r <= endRow` condition false
      // from the first iteration, silently returning rows:[] for a workbook
      // that plainly has data. The clamp must restore real content.
      expect(result.rows.length).toBe(5);
    }
  });

  it("(a) explicit maxRows:0/maxCells:0 is honored as a deliberate 'zero rows' request, not sanitized away (symmetry with csv.ts's real zero use case)", async () => {
    const bytes = await createTestXlsx(smallXlsxData(5));
    const result = await xlsxTable(bytes, { maxRows: 0 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toEqual([]);
  });

  it("(b) an in-range explicit maxRows value is honored exactly (control)", async () => {
    const bytes = await createTestXlsx(smallXlsxData(10));
    const result = await xlsxTable(bytes, { maxRows: 5 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows.length).toBeLessThanOrEqual(5);
  });

  it("(c) omitting maxRows/maxCells matches the explicit 200/10000 defaults byte-for-byte", async () => {
    const bytes = await createTestXlsx(smallXlsxData(5));
    const omitted = await xlsxTable(bytes, {});
    const explicitDefault = await xlsxTable(bytes, { maxRows: 200, maxCells: 10_000 });
    expect(omitted).toEqual(explicitDefault);
  });
});

// ===========================================================================
// 4. office/csv.ts (csvTable) — maxRows, maxCells
// ===========================================================================

describe("clampTableCount (csv.ts) — pure clamp math", () => {
  it("passes undefined through as fallback, and zero through as a literal zero", () => {
    expect(clampCsvTableCount(undefined, 200, 10000)).toBe(200);
    expect(clampCsvTableCount(0, 200, 10000)).toBe(0);
  });

  it("passes finite in-range values through unchanged, including at the ceiling", () => {
    expect(clampCsvTableCount(50, 200, 10000)).toBe(50);
    expect(clampCsvTableCount(10000, 200, 10000)).toBe(10000);
  });

  it("clamps a finite value above the ceiling down to the ceiling", () => {
    expect(clampCsvTableCount(1e12, 200, 10000)).toBe(10000);
  });

  it("sanitizes non-finite (Infinity/-Infinity/NaN) and negative values to the fallback", () => {
    for (const absurd of [Infinity, -Infinity, NaN, -1]) {
      expect(clampCsvTableCount(absurd, 200, 10000)).toBe(200);
    }
  });
});

describe("csvTable — maxRows/maxCells caller-value hard clamp (real entry point)", () => {
  it("(a) huge/Infinity maxRows/maxCells complete without hanging or crashing against real data", () => {
    const bytes = smallCsv(5);
    for (const huge of [1e12, Infinity]) {
      const rowsResult = csvTable(bytes, { maxRows: huge });
      expect(rowsResult.ok).toBe(true);
      const cellsResult = csvTable(bytes, { maxCells: huge });
      expect(cellsResult.ok).toBe(true);
    }
  });

  it("(a) NaN/negative maxRows sanitizes to the 200 default instead of degrading to an empty result", () => {
    const bytes = smallCsv(5);
    for (const garbage of [NaN, -1]) {
      const result = csvTable(bytes, { maxRows: garbage });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      // Pre-fix: Math.min(windowSize, NaN) is NaN and Math.min(windowSize, -1)
      // is -1 — both make the row-serving loop's bound resolve to nothing,
      // silently returning rows:[] for data that plainly exists.
      expect(result.rows.length).toBe(5);
    }
  });

  it("(a) explicit maxRows:0 is honored as a deliberate 'zero rows' request — matches server.ts's serveBoundedCsvArtifact fallback rung", () => {
    const bytes = smallCsv(5);
    const result = csvTable(bytes, { maxRows: 0 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toEqual([]);
  });

  it("(b) an in-range explicit maxRows value is honored exactly (control)", () => {
    const bytes = smallCsv(5);
    const t = csvTable(bytes, { maxRows: 2 });
    expect(t.ok).toBe(true);
    if (!t.ok) return;
    expect(t.rows).toHaveLength(2);
    expect(t.truncated).toBe(true);
  });

  it("(c) omitting maxRows/maxCells matches the explicit 200/10000 defaults byte-for-byte", () => {
    const bytes = smallCsv(5);
    const omitted = csvTable(bytes, {});
    const explicitDefault = csvTable(bytes, { maxRows: 200, maxCells: 10_000 });
    expect(omitted).toEqual(explicitDefault);
  });
});

// ---------------------------------------------------------------------------
// 5. office/xlsx.ts (xlsxTable) — range string column span (CWE-400).
//    A caller range like "A1:ZZZZZZZZ1" yields endCol ≈ 2.17e11 via
//    colNumber(); the header loop iterates the full span BEFORE the maxCells
//    check (which only shrinks rows) can intervene. The clamp bounds the
//    SPAN, not the absolute position, so far-right selections stay legal.
// ---------------------------------------------------------------------------

describe("xlsxTable — range column-span hard clamp (real entry point)", () => {
  it("completes fast on an astronomically wide range and truncates the span", async () => {
    const bytes = await createTestXlsx(smallXlsxData(3));
    const started = Date.now();
    const result = await xlsxTable(bytes, { range: "A1:ZZZZZZZZ1" });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.columns.length).toBeLessThanOrEqual(MAX_RANGE_COL_SPAN);
    expect(result.warnings ?? []).toContain(`Columns truncated to ${MAX_RANGE_COL_SPAN}.`);
  });

  it("still honors a far-right range whose span is small (span-based, not absolute)", async () => {
    const bytes = await createTestXlsx(smallXlsxData(3));
    // BA..BZ = columns 53..78, entirely beyond the MAX_COLS=50 default view
    // but a span of only 26 — must not be truncated by the span clamp.
    const result = await xlsxTable(bytes, { range: "BA1:BZ3" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.columns.length).toBe(26);
    expect(result.warnings ?? []).not.toContain(`Columns truncated to ${MAX_RANGE_COL_SPAN}.`);
  });
});
