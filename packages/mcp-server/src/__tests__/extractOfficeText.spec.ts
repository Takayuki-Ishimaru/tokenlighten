// Tests for extract_office_text tool.
// No network required. Tests use in-memory byte arrays.

import { describe, it, expect } from "vitest";
import { extractOfficeText } from "../tools/extractOfficeText.js";
import { preflightZip, eocdEntryCountPrescan, ZIP_LIMITS } from "../office/zipPreflight.js";
import { extractDocx } from "../office/docx.js";
import { extractXlsx } from "../office/xlsx.js";

// ---------------------------------------------------------------------------
// Fixture helpers — build minimal DOCX and XLSX in-memory using jszip/exceljs.
// ---------------------------------------------------------------------------

/**
 * Build a minimal valid DOCX buffer (OOXML ZIP) with:
 *   - H1: "Premium Calculation Procedure"
 *   - H2: "Rate Table Overview"
 *   - Body with numbered list items "1. ...", "2. ...", "3. ..."
 */
// JSZip full API (types-shim only covers loadAsync; cast to unknown for write ops).
type JSZipFull = {
  file(name: string, data: string): void;
  generateAsync(opts: { type: "nodebuffer" }): Promise<Buffer>;
};

async function buildMinimalDocx(): Promise<Uint8Array> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const JSZipCtor = (await import("jszip")) as unknown as { default: new () => JSZipFull };
  const zip: JSZipFull = new JSZipCtor.default();

  const contentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Premium Calculation Procedure</w:t></w:r></w:p>
<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Rate Table Overview</w:t></w:r></w:p>
<w:p><w:r><w:t>This document describes the premium calculation steps.</w:t></w:r></w:p>
<w:p><w:r><w:t>1. Retrieve base rate from rate table.</w:t></w:r></w:p>
<w:p><w:r><w:t>2. Apply age multiplier to get adjusted premium.</w:t></w:r></w:p>
<w:p><w:r><w:t>3. Apply risk factor adjustment for underwriting.</w:t></w:r></w:p>
</w:body></w:document>`;

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

async function encryptOffice(
  bytes: Uint8Array,
  password: string,
): Promise<Uint8Array> {
  type OfficeCrypto = {
    encrypt(
      input: Buffer,
      options: { password: string },
    ): Promise<Buffer | Uint8Array> | Buffer | Uint8Array;
  };
  const imported = await import("officecrypto-tool");
  const candidate = imported as unknown as OfficeCrypto & { default?: OfficeCrypto };
  const officeCrypto = candidate.default ?? candidate;
  return new Uint8Array(
    await officeCrypto.encrypt(Buffer.from(bytes), { password }),
  );
}

// ExcelJS full Workbook API (types-shim only covers read ops; cast for write ops).
type WorksheetFull = {
  addRow(values: unknown[]): void;
};
type WorkbookFull = {
  addWorksheet(name: string): WorksheetFull;
  xlsx: { writeBuffer(): Promise<Buffer> };
};

/**
 * Build a minimal valid XLSX buffer using exceljs with:
 *   - Sheet "RateTable": headers Age, Risk, Premium; 3 data rows.
 *   - Sheet "Adjustments": headers Factor, Value; 2 data rows.
 */
async function buildMinimalXlsx(): Promise<Uint8Array> {
  const ExcelJSMod = (await import("exceljs")) as unknown as { Workbook: new () => WorkbookFull };
  const wb: WorkbookFull = new ExcelJSMod.Workbook();

  const ws1 = wb.addWorksheet("RateTable");
  ws1.addRow(["Age", "Risk", "Premium"]);
  ws1.addRow([25, "Low", 1200.0]);
  ws1.addRow([35, "Medium", 1800.5]);
  ws1.addRow([45, "High", 2500.0]);

  const ws2 = wb.addWorksheet("Adjustments");
  ws2.addRow(["Factor", "Value"]);
  ws2.addRow(["Age multiplier", 1.15]);
  ws2.addRow(["Risk multiplier", 1.3]);

  const buf = await wb.xlsx.writeBuffer();
  return new Uint8Array(buf);
}

/**
 * Minimal-but-valid single-page PDF, hand-authored byte-for-byte (no
 * pdf-writing library — same technique as
 * readCodeArtifactDispatch.spec.ts's buildMinimalPdf, kept single-page here
 * since this file's docx/xlsx fixtures above are also single-purpose).
 */
function buildMinimalPdf(text: string): Uint8Array {
  const escaped = text.replace(/([()\\])/g, "\\$1");
  const stream = `BT /F1 16 Tf 20 150 Td (${escaped}) Tj ET`;
  // Wide-enough page so unpdf/pdf.js's text-content extraction never clips
  // text that would render past the MediaBox (verified empirically: pdf.js
  // drops trailing glyphs whose advance position would fall outside the
  // page's visible width — real pdf.js behavior, not an extractOfficeText
  // bug). This fixture lays out one long single-line Tj run (no wrapping),
  // so the page must be sized to hold it.
  const pageWidth = Math.max(300, text.length * 20 + 100);
  const objs = [
    "", // unused — PDF objects are 1-indexed
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`,
  ];

  let out = "%PDF-1.4\n";
  const offsets: number[] = new Array(objs.length).fill(0);
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = Buffer.byteLength(out, "latin1");
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xrefStart = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) {
    out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

  return new Uint8Array(Buffer.from(out, "latin1"));
}

describe("extractOfficeText — path detection and error paths", () => {
  it("extracts text from a valid .pdf file (in-memory fixture)", async () => {
    const bytes = buildMinimalPdf("Hello TokenLighten PDF Extraction");
    const result = await extractOfficeText(bytes, { path: "report.pdf" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.kind).toBe("pdf");
    expect(result.data.text).toContain("## Page 1");
    expect(result.data.text).toContain("Hello TokenLighten PDF Extraction");
    expect(result.data.truncated).toBe(false);
  });

  it("returns pdf-parse-failed for corrupt .pdf bytes (not the old pdf-not-supported-in-v1 refusal)", async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF magic only — not a real structure
    const result = await extractOfficeText(bytes, { path: "report.pdf" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("pdf-parse-failed");
  });

  it("returns not-a-document for unknown extensions", async () => {
    const bytes = new Uint8Array([0x00, 0x01]);
    const result = await extractOfficeText(bytes, { path: "binary.exe" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("not-a-document");
  });

  it("rejects files that exceed maxBytes", async () => {
    const bytes = new Uint8Array(2000); // 2 KB
    const result = await extractOfficeText(bytes, {
      path: "big.docx",
      maxBytes: 100, // 100 bytes limit
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("too-large");
  });

  it("returns not-a-zip for corrupt .docx bytes", async () => {
    const bytes = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04]);
    const result = await extractOfficeText(bytes, { path: "corrupt.docx" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Zip preflight should catch this first.
    expect(result.code).toBe("not-a-zip");
  });

  it("returns not-a-zip for corrupt .xlsx bytes", async () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0xfd]);
    const result = await extractOfficeText(bytes, { path: "data.xlsx" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("not-a-zip");
  });

  it("returns not-a-zip for corrupt .pptx bytes", async () => {
    const bytes = new Uint8Array([0xca, 0xfe, 0xba, 0xbe]);
    const result = await extractOfficeText(bytes, { path: "slides.pptx" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("not-a-zip");
  });

  it("extracts text from a valid .docx file (in-memory fixture)", async () => {
    const bytes = await buildMinimalDocx();
    const result = await extractOfficeText(bytes, { path: "procedure.docx" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.text.length).toBeGreaterThan(0);
  });

  it("decrypts and extracts a password-protected .docx package", async () => {
    const password = "docx-test-secret";
    const bytes = await encryptOffice(await buildMinimalDocx(), password);
    const result = await extractOfficeText(
      bytes,
      { path: "procedure.docx", credentialRef: "test-docx" },
      password,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.text).toContain("Premium Calculation Procedure");
    expect(JSON.stringify(result)).not.toContain(password);
  });
});

describe("preflightZip", () => {
  it("returns not-a-zip for non-zip bytes", async () => {
    const bytes = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
    const result = await preflightZip(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("not-a-zip");
  });

  it("returns not-a-zip for empty bytes", async () => {
    const result = await preflightZip(new Uint8Array(0));
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TL-SECURITY-REVIEW-2026-08-15 finding 3 (CWE-400): preflightZip used to
// call JSZip.loadAsync (which walks the whole central directory, allocating
// per-entry metadata) BEFORE any entry-count/size check ran. eocdEntryCountPrescan
// is the cheap, bounded (<=64KB+22 bytes) backward scan for the trailing
// End-Of-Central-Directory record that now runs first, in both
// office/zipPreflight.ts (below) and the zip branch of tools/archive.ts's
// openArchive (same shared function, exercised here at the unit level —
// see that file's own ARCHIVE_LIMITS.maxEntries for the second call site).
// A hand-built EOCD-only buffer (no real local file headers/central
// directory at all) is enough to exercise the prescan itself: it reads
// ONLY the trailing 22+comment bytes and never touches anything else.
// ---------------------------------------------------------------------------
function buildEocdOnlyBuffer(
  totalEntries: number,
  opts: { cdSize?: number; cdOffset?: number; comment?: string } = {},
): Uint8Array {
  const commentBytes = Buffer.from(opts.comment ?? "", "utf8");
  const buf = Buffer.alloc(22 + commentBytes.length);
  buf.writeUInt32LE(0x06054b50, 0); // EOCD signature
  buf.writeUInt16LE(0, 4); // disk number
  buf.writeUInt16LE(0, 6); // disk with CD start
  buf.writeUInt16LE(totalEntries & 0xffff, 8); // entries on this disk
  buf.writeUInt16LE(totalEntries & 0xffff, 10); // TOTAL entries — what the prescan reads
  buf.writeUInt32LE(opts.cdSize ?? 0, 12);
  buf.writeUInt32LE(opts.cdOffset ?? 0, 16);
  buf.writeUInt16LE(commentBytes.length, 20);
  commentBytes.copy(buf, 22);
  return new Uint8Array(buf);
}

describe("eocdEntryCountPrescan (finding 3)", () => {
  it("accepts an entry count within the limit", () => {
    const result = eocdEntryCountPrescan(buildEocdOnlyBuffer(5), 10_000);
    expect(result.ok).toBe(true);
  });

  it("rejects an entry count exceeding the limit", () => {
    const result = eocdEntryCountPrescan(buildEocdOnlyBuffer(10_001), 10_000);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toMatch(/10001/);
  });

  it("treats the ZIP64 sentinel entry count (0xFFFF) as over-limit even under a huge ceiling", () => {
    const result = eocdEntryCountPrescan(buildEocdOnlyBuffer(0xffff), 1_000_000);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toMatch(/ZIP64/);
  });

  it("defers to the real parser when no EOCD signature is found in the scan window", () => {
    const result = eocdEntryCountPrescan(new Uint8Array(100).fill(0x41), 10_000);
    expect(result.ok).toBe(true);
  });

  it("defers when a coincidental signature-shaped match fails the comment-length sanity check", () => {
    // The signature bytes appear near the end, but nothing follows them in
    // the shape a real EOCD record would require (comment length reaching
    // exactly EOF) — must not be misread as a real (and lying) EOCD.
    const buf = Buffer.alloc(40);
    buf.writeUInt32LE(0x06054b50, 10); // planted mid-buffer, not a real trailing EOCD
    const result = eocdEntryCountPrescan(new Uint8Array(buf), 10_000);
    expect(result.ok).toBe(true);
  });

  it("preflightZip rejects an over-limit entry count via the prescan BEFORE the real parser ever runs", async () => {
    const bogus = buildEocdOnlyBuffer(ZIP_LIMITS.maxEntries + 1);
    const result = await preflightZip(bogus);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // "too-many-entries" (not "not-a-zip") proves the prescan intercepted
    // this before JSZip.loadAsync ever got a chance to try (and fail to
    // meaningfully parse a buffer with no real central directory).
    expect(result.code).toBe("too-many-entries");
  });

  it("a real, small zip with a well-formed EOCD still parses fully (the prescan never blocks a normal file)", async () => {
    const JSZipModule = (await import("jszip")) as unknown as {
      default: new () => { file(name: string, data: string): void; generateAsync(o: { type: "uint8array" }): Promise<Uint8Array> };
    };
    const zip = new JSZipModule.default();
    zip.file("hello.txt", "hello world");
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const result = await preflightZip(bytes);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Structured output tests — P2.3
// ---------------------------------------------------------------------------

describe("extractDocx — structured output (P2.3)", () => {
  it("includes ## Headings section with H1 and H2 entries", async () => {
    const bytes = await buildMinimalDocx();
    const result = await extractDocx(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Headings section must be present
    expect(result.text).toContain("## Headings");
    expect(result.text).toContain("H1: Premium Calculation Procedure");
    expect(result.text).toContain("H2: Rate Table Overview");
  });

  it("includes ## Steps section with numbered step entries", async () => {
    const bytes = await buildMinimalDocx();
    const result = await extractDocx(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Steps section must be present
    expect(result.text).toContain("## Steps");
    expect(result.text).toContain("Retrieve base rate");
    expect(result.text).toContain("Apply age multiplier");
    expect(result.text).toContain("Apply risk factor");
  });

  it("## Headings appears before ## Steps in output", async () => {
    const bytes = await buildMinimalDocx();
    const result = await extractDocx(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const headingsIdx = result.text.indexOf("## Headings");
    const stepsIdx = result.text.indexOf("## Steps");
    expect(headingsIdx).toBeGreaterThanOrEqual(0);
    expect(stepsIdx).toBeGreaterThan(headingsIdx);
  });

  it("body text also appears after structured sections", async () => {
    const bytes = await buildMinimalDocx();
    const result = await extractDocx(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Body text from the document
    expect(result.text).toContain("Premium Calculation Procedure");
    expect(result.text).toContain("Rate Table Overview");
  });
});

describe("extractXlsx — structured output (P2.3)", () => {
  it("includes ## Sheets roster at the top", async () => {
    const bytes = await buildMinimalXlsx();
    const result = await extractXlsx(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.text).toContain("## Sheets");
    expect(result.text).toContain("- RateTable");
    expect(result.text).toContain("- Adjustments");
  });

  it("sheet roster includes row × col counts", async () => {
    const bytes = await buildMinimalXlsx();
    const result = await extractXlsx(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Roster entry format: "- <name> (<rowCount> × <colCount>)"
    expect(result.text).toMatch(/- RateTable \(\d+ × \d+\)/);
    expect(result.text).toMatch(/- Adjustments \(\d+ × \d+\)/);
  });

  it("includes ### <sheet> heading per sheet", async () => {
    const bytes = await buildMinimalXlsx();
    const result = await extractXlsx(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.text).toContain("### RateTable");
    expect(result.text).toContain("### Adjustments");
  });

  it("includes Headers: row listing column names", async () => {
    const bytes = await buildMinimalXlsx();
    const result = await extractXlsx(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.text).toContain("Headers: Age, Risk, Premium");
    expect(result.text).toContain("Headers: Factor, Value");
  });

  it("includes Sample rows markdown table", async () => {
    const bytes = await buildMinimalXlsx();
    const result = await extractXlsx(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.text).toContain("Sample rows:");
    // Data values from RateTable
    expect(result.text).toContain("25");
    expect(result.text).toContain("Low");
    expect(result.text).toContain("1200");
  });

  it("includes Cell types for header columns", async () => {
    const bytes = await buildMinimalXlsx();
    const result = await extractXlsx(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.text).toContain("Cell types:");
    // Age and Premium are numeric; Risk is string
    expect(result.text).toContain("number");
    expect(result.text).toContain("string");
  });

  it("includes Range: entry for each sheet", async () => {
    const bytes = await buildMinimalXlsx();
    const result = await extractXlsx(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.text).toContain("Range:");
    // Should match something like "Range: A1:C4"
    expect(result.text).toMatch(/Range: A1:[A-Z]+\d+/);
  });

  it("structured:false falls back to old full-table mode", async () => {
    const bytes = await buildMinimalXlsx();
    const result = await extractXlsx(bytes, { structured: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Old mode uses "## Sheet: <name>" headers
    expect(result.text).toContain("## Sheet: RateTable");
    // And does NOT include the roster section
    expect(result.text).not.toContain("## Sheets\n");
  });
});
