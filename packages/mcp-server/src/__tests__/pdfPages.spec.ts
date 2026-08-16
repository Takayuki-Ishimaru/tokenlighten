// Unit-level tests for office/pdf.ts's pdfPages() — the structured
// artifact-mode PDF extractor (mirrors readCodeArtifact.spec.ts's
// xlsxRoster/xlsxTable unit coverage, and docxSections'/pptxSlides' shared
// {selection, query, maxChars} contract). Server-level wire coverage
// (handle/sha, mode=artifact dispatch, mode=full redirect) lives in
// readCodeArtifactDispatch.spec.ts; this file exercises pdfPages() directly
// so selector/query/cap edge cases don't each need a spawned server.

import { describe, it, expect } from "vitest";
import { pdfPages } from "../office/pdf.js";
import {
  ENCRYPTED_TEXT_PDF_PASSWORD,
  readEncryptedTextPdfFixture,
} from "./fixtures/encryptedPdfFixture.js";

// ---------------------------------------------------------------------------
// Fixture helper — hand-authored, byte-accurate xref (no pdf-writing
// library). Same technique used in readCodeArtifactDispatch.spec.ts and
// extractOfficeText.spec.ts; duplicated locally per this repo's existing
// per-file fixture-builder convention (see those files' own copies).
// ---------------------------------------------------------------------------

function buildMinimalPdf(pageTexts: string[]): Uint8Array {
  const n = pageTexts.length;
  const pageObjNums = pageTexts.map((_, i) => 3 + 2 * i);
  const contentObjNums = pageTexts.map((_, i) => 4 + 2 * i);
  const fontObjNum = 3 + 2 * n;
  const totalObjs = fontObjNum;

  const objBodies: string[] = new Array(totalObjs + 1).fill("");
  objBodies[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objBodies[2] = `<< /Type /Pages /Kids [${pageObjNums.map((m) => `${m} 0 R`).join(" ")}] /Count ${n} >>`;
  for (let i = 0; i < n; i++) {
    const pageNum = pageObjNums[i]!;
    const contentNum = contentObjNums[i]!;
    // Wide-enough page so unpdf/pdf.js's text-content extraction never clips
    // text that would render past the MediaBox — empirically verified pdf.js
    // DROPS trailing glyphs whose advance position would fall outside the
    // page's visible width (getTextContent mirrors what the text-selection
    // layer could place on the rendered canvas: real pdf.js behavior, not a
    // pdfPages()/pdf.ts bug). These fixtures lay out one long single-line Tj
    // run per page (no wrapping), so the page must be sized to hold it.
    const pageWidth = Math.max(300, pageTexts[i]!.length * 20 + 100);
    objBodies[pageNum] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} 200] ` +
      `/Resources << /Font << /F1 ${fontObjNum} 0 R >> >> /Contents ${contentNum} 0 R >>`;
    const escaped = pageTexts[i]!.replace(/([()\\])/g, "\\$1");
    const stream = `BT /F1 16 Tf 20 150 Td (${escaped}) Tj ET`;
    objBodies[contentNum] = `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`;
  }
  objBodies[fontObjNum] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;

  let out = "%PDF-1.4\n";
  const offsets: number[] = new Array(totalObjs + 1).fill(0);
  for (let i = 1; i <= totalObjs; i++) {
    offsets[i] = Buffer.byteLength(out, "latin1");
    out += `${i} 0 obj\n${objBodies[i]}\nendobj\n`;
  }
  const xrefStart = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${totalObjs + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= totalObjs; i++) {
    out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${totalObjs + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

  return new Uint8Array(Buffer.from(out, "latin1"));
}

function readEncryptedFixture(): Uint8Array {
  return readEncryptedTextPdfFixture();
}

const THREE_PAGES = [
  "First page mentions apples and oranges",
  "Second page mentions bananas only",
  "Third page mentions apples again here",
];

// ---------------------------------------------------------------------------

describe("pdfPages — success paths", () => {
  it("extracts a single page", async () => {
    const bytes = buildMinimalPdf(["Hello TokenLighten PDF Extraction"]);
    const result = await pdfPages(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pages).toEqual([{ page: 1, text: "Hello TokenLighten PDF Extraction" }]);
    expect(result.truncated).toBe(false);
  });

  it("extracts multiple pages with correct 1-based page numbers", async () => {
    const bytes = buildMinimalPdf(THREE_PAGES);
    const result = await pdfPages(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pages.map((p) => p.page)).toEqual([1, 2, 3]);
    expect(result.pages[0]!.text).toContain("apples and oranges");
    expect(result.pages[1]!.text).toContain("bananas only");
    expect(result.pages[2]!.text).toContain("apples again");
  });

  it("normalizes irregular internal whitespace to single spaces", async () => {
    const bytes = buildMinimalPdf(["Hello   Multiple    Internal     Spaces"]);
    const result = await pdfPages(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pages[0]!.text).not.toMatch(/ {2,}/);
    expect(result.pages[0]!.text).toBe("Hello Multiple Internal Spaces");
  });

  it("can be called twice with the SAME Uint8Array reference without throwing", async () => {
    // Regression guard: unpdf/pdf.js's Node path TRANSFERS (detaches) the
    // input buffer — verified empirically that passing the identical
    // reference to getDocumentProxy a second time throws "Cannot transfer
    // object of unsupported type." pdfPages defensively copies internally
    // (`new Uint8Array(bytes)`) specifically so callers — including a test
    // fixture constant reused across `it()` blocks, or any future caller
    // that re-reads the same handle — never hit this.
    const bytes = buildMinimalPdf(["Reused across two calls"]);
    const first = await pdfPages(bytes);
    const second = await pdfPages(bytes);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.pages).toEqual(second.pages);
    }
  });
});

describe("pdfPages — page selector", () => {
  it("pages:['2'] selects a single page by number", async () => {
    const bytes = buildMinimalPdf(THREE_PAGES);
    const result = await pdfPages(bytes, { pages: ["2"] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pages.length).toBe(1);
    expect(result.pages[0]!.page).toBe(2);
  });

  it("pages:['1-2'] selects a contiguous range, inclusive", async () => {
    const bytes = buildMinimalPdf(THREE_PAGES);
    const result = await pdfPages(bytes, { pages: ["1-2"] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pages.map((p) => p.page)).toEqual([1, 2]);
  });

  it("pages:['1','3'] (list) selects non-contiguous pages", async () => {
    const bytes = buildMinimalPdf(THREE_PAGES);
    const result = await pdfPages(bytes, { pages: ["1", "3"] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pages.map((p) => p.page)).toEqual([1, 3]);
  });

  it("a reversed range '3-1' is treated the same as '1-3'", async () => {
    const bytes = buildMinimalPdf(THREE_PAGES);
    const result = await pdfPages(bytes, { pages: ["3-1"] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pages.map((p) => p.page)).toEqual([1, 2, 3]);
  });

  it("an out-of-range selector returns an empty pages[] (not an error)", async () => {
    const bytes = buildMinimalPdf(THREE_PAGES);
    const result = await pdfPages(bytes, { pages: ["99"] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pages).toEqual([]);
  });

  it("rejects a selector range wider than the page-processing budget before expansion", async () => {
    const bytes = buildMinimalPdf(THREE_PAGES);
    const result = await pdfPages(bytes, { pages: ["1-501"] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pages).toEqual([]);
  });
});

describe("pdfPages — query filter", () => {
  it("matches only pages containing the query term (case-insensitive)", async () => {
    const bytes = buildMinimalPdf(THREE_PAGES);
    const result = await pdfPages(bytes, { query: "BANANAS" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pages.length).toBe(1);
    expect(result.pages[0]!.page).toBe(2);
  });

  it("matches multiple pages sharing the same term", async () => {
    const bytes = buildMinimalPdf(THREE_PAGES);
    const result = await pdfPages(bytes, { query: "apples" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pages.map((p) => p.page)).toEqual([1, 3]);
  });

  it("a non-matching query returns an empty pages[]", async () => {
    const bytes = buildMinimalPdf(THREE_PAGES);
    const result = await pdfPages(bytes, { query: "nonexistentterm" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pages).toEqual([]);
  });
});

describe("pdfPages — maxChars bake-into-cap truncation", () => {
  // NOTE: mirrors docxSections'/pptxSlides' exact accumulate-then-cut
  // convention (office/docx.ts, office/pptx.ts), INCLUDING their `remaining
  // > 100` guard — when the leftover budget at the overflow point is <=100
  // chars, no stub entry is emitted at all (not even a heavily-truncated
  // one), so maxChars values below ~100 legitimately produce an empty
  // result with truncated:true. Test data below stays above that floor so
  // the partial-page case actually has something to assert on.
  it("truncates the overflowing page with a '...' suffix and sets truncated:true", async () => {
    const longText = "Lorem ipsum dolor sit amet ".repeat(20).trim(); // 559 chars
    const bytes = buildMinimalPdf([longText]);
    const result = await pdfPages(bytes, { maxChars: 150 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.truncated).toBe(true);
    expect(result.pages.length).toBe(1);
    expect(result.pages[0]!.text.endsWith("...")).toBe(true);
    expect(result.pages[0]!.text.length).toBe(150 + "...".length);
  });

  it("a maxChars below the 100-char floor yields an empty pages[] (matches docxSections/pptxSlides)", async () => {
    const bytes = buildMinimalPdf(["Hello TokenLighten PDF Extraction"]);
    const result = await pdfPages(bytes, { maxChars: 10 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.truncated).toBe(true);
    expect(result.pages).toEqual([]);
  });

  it("stays untruncated when content fits well under maxChars", async () => {
    const bytes = buildMinimalPdf(["short"]);
    const result = await pdfPages(bytes, { maxChars: 16_000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.truncated).toBe(false);
    expect(result.pages[0]!.text).toBe("short");
  });

  it("accumulates across pages before cutting — earlier pages that fit stay whole", async () => {
    const page1 = "A".repeat(50);
    const page2 = "B".repeat(300);
    const page3 = "C".repeat(50);
    const bytes = buildMinimalPdf([page1, page2, page3]);
    const result = await pdfPages(bytes, { maxChars: 200 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.truncated).toBe(true);
    expect(result.pages.length).toBe(2);
    // First page (50 chars) fits whole under the 200-char budget, untouched.
    expect(result.pages[0]!.text).toBe(page1);
    // Second page overflows the remaining 150-char budget and gets cut+"...".
    expect(result.pages[1]!.text.endsWith("...")).toBe(true);
    expect(result.pages[1]!.text.length).toBe(150 + "...".length);
    // Third page never gets appended once truncation kicks in — only 2
    // entries above confirms this, but assert the page number too.
    expect(result.pages.map((p) => p.page)).toEqual([1, 2]);
  });
});

describe("pdfPages — failure paths", () => {
  it("garbage bytes fail with pdf-parse-failed", async () => {
    const result = await pdfPages(new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("pdf-parse-failed");
    expect(result.hint).toBeUndefined();
  });

  it("empty bytes fail with pdf-parse-failed", async () => {
    const result = await pdfPages(new Uint8Array([]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("pdf-parse-failed");
  });

  it("a real encrypted PDF fails with pdf-encrypted and a native-fallback hint", async () => {
    const result = await pdfPages(readEncryptedFixture());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("pdf-encrypted");
    expect(typeof result.hint).toBe("string");
    expect(String(result.hint).length).toBeGreaterThan(0);
  });

  it("extracts a password-protected PDF when the resolved password is correct", async () => {
    const result = await pdfPages(readEncryptedFixture(), { password: ENCRYPTED_TEXT_PDF_PASSWORD });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pages.length).toBeGreaterThan(0);
    expect(result.pages[0]?.text).toContain("Protected TokenLighten PDF text");
  });

  it("distinguishes an incorrect PDF password from a missing password", async () => {
    const result = await pdfPages(readEncryptedFixture(), { password: "definitely-wrong" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("pdf-password-invalid");
    expect(result.error).not.toContain("definitely-wrong");
  });

  it("a page with an empty content stream (no text layer) fails with pdf-no-text-layer and an OCR-out-of-scope hint", async () => {
    const bytes = buildMinimalPdf([""]);
    const result = await pdfPages(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("pdf-no-text-layer");
    expect(String(result.hint)).toContain("OCR");
  });

  it("multiple blank pages also fail with pdf-no-text-layer (checked across ALL pages, not just the first)", async () => {
    const bytes = buildMinimalPdf(["", "", ""]);
    const result = await pdfPages(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("pdf-no-text-layer");
  });
});

describe("pdfPages — MAX_PAGES safety cap", () => {
  it("caps a pathologically large page count and warns, instead of extracting every page", async () => {
    const manyPages = Array.from({ length: 501 }, (_, i) => `p${i + 1}`);
    const bytes = buildMinimalPdf(manyPages);
    const result = await pdfPages(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Only the first 500 pages are considered at all (selection/query/cap
    // all operate on the capped set) — page 501 can never appear.
    expect(result.pages.every((p) => p.page <= 500)).toBe(true);
    expect(result.warnings.some((w) => w.includes("501") && w.includes("500"))).toBe(true);
  }, 20000);
});

// ---------------------------------------------------------------------------
// TL-SECURITY-REVIEW-2026-08-15 finding 2 (CWE-400): readPages used to call
// getTextContent() for EVERY page up to MAX_PAGES regardless of an explicit
// pages= selector, and stored all of it before maxChars/query/pages ever
// got a say. These tests exercise the fix: (1) a page selector now skips
// getTextContent for excluded pages — proven observably via the
// no-text-layer classification, which only ever reflects pages actually
// decoded; (2) per-page and cumulative extraction quotas abort the page
// loop early. The quota tests use pdfPages'/readPages'
// `__quotaOverridesForTest` seam (mirrors this codebase's established
// `{ maxBytes }`-style per-call cap override convention) to trip the real
// abort logic with tiny, cheap fixtures instead of megabytes of real PDF
// content.
// ---------------------------------------------------------------------------
describe("pdfPages — page-selection-only getTextContent (finding 2)", () => {
  it("a pages= selector that excludes the only textful page never decodes it — proven via no-text-layer", async () => {
    // Page 1 is blank; page 2 has real text. Pre-fix, readPages decoded
    // BOTH pages unconditionally before filtering, so hasAnyText (checked
    // over every decoded page) was always true here and pages:["1"] just
    // returned an empty pages[]. Post-fix, only page 1 is ever decoded for
    // this call, so this call correctly cannot see page 2's text at all.
    const bytes = buildMinimalPdf(["", "Only page two has text"]);
    const page1Only = await pdfPages(bytes, { pages: ["1"] });
    expect(page1Only.ok).toBe(false);
    if (page1Only.ok) return;
    expect(page1Only.code).toBe("pdf-no-text-layer");

    // The complementary selection (the textful page) still decodes fine.
    const page2Only = await pdfPages(bytes, { pages: ["2"] });
    expect(page2Only.ok).toBe(true);
    if (!page2Only.ok) return;
    expect(page2Only.pages).toEqual([{ page: 2, text: "Only page two has text" }]);

    // No selector at all: unaffected, whole-document classification (a
    // reachable page has text, so this succeeds) — matches the pre-existing
    // "checked across ALL pages" contract for the no-selector case.
    const unfiltered = await pdfPages(bytes);
    expect(unfiltered.ok).toBe(true);
  });
});

describe("pdfPages — extraction-time quotas (finding 2)", () => {
  it("a cumulative char-budget override stops decoding further pages and warns", async () => {
    const bytes = buildMinimalPdf(["A".repeat(80), "B".repeat(80), "C".repeat(80)]);
    const result = await pdfPages(bytes, {
      __quotaOverridesForTest: { extractionCharBudget: 100 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Page 1 alone (80 chars) fits under the 100-char budget; page 2 pushes
    // the running total to 160, over budget — page 3 is never decoded.
    expect(result.pages.some((p) => p.page === 1)).toBe(true);
    expect(result.pages.some((p) => p.page === 3)).toBe(false);
    expect(result.warnings.some((w) => /Extraction budget exceeded/.test(w))).toBe(true);
  });

  it("a cumulative item-budget override stops decoding further pages and warns", async () => {
    // Each single-Tj-run fixture page contributes very few TextItems (this
    // fixture builder lays out one Tj per page — see its own doc comment);
    // a budget of 2 is deliberately tiny relative to 5 pages so the abort
    // is robust to the exact per-page item count without pinning it.
    const bytes = buildMinimalPdf(["one", "two", "three", "four", "five"]);
    const result = await pdfPages(bytes, {
      __quotaOverridesForTest: { extractionItemBudget: 2 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pages.length).toBeLessThan(5);
    expect(result.warnings.some((w) => /Extraction budget exceeded/.test(w))).toBe(true);
  });

  it("a per-page text-item ceiling override slices a page's items (proven via the resulting no-text-layer classification)", async () => {
    const bytes = buildMinimalPdf(["Hello TokenLighten"]);
    const result = await pdfPages(bytes, {
      __quotaOverridesForTest: { maxTextItemsPerPage: 0 },
    });
    // Slicing every TextItem away from the page's only content yields the
    // same classification an actually-blank page would — proof the slice
    // fired, independent of the overall success/failure outcome that
    // follows from it for this single-page fixture.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("pdf-no-text-layer");
    expect(result.warnings.some((w) => /text items/.test(w))).toBe(true);
  });

  it("ordinary content never comes close to tripping the REAL (non-overridden) quotas", async () => {
    const result = await pdfPages(buildMinimalPdf(THREE_PAGES));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings.some((w) => /Extraction budget exceeded/.test(w))).toBe(false);
    expect(result.pages).toHaveLength(3);
  });
});
