/**
 * pptxTables.spec.ts — PPTX table extraction + shape-kind disclosure.
 *
 * Live defect (run 2026-07-25-docs-1, cell T14-policyarc-deck-drift-audit
 * rep1 arm A): system-overview.pptx Slide 5 carries a 15-row reference table
 * inside a:tbl, but the served slide text was ~130 chars (heading + caption)
 * with truncated:false and warnings:[] — a silent drop with zero disclosure.
 * The solver recovered by unzipping the deck and re.findall-ing the slide XML
 * (7 wasted Bash calls). These tests pin the fix at the extractor layer:
 *
 *   1. a:tbl/a:tr/a:tc cell text lands in the slide body (row-per-line,
 *      " | " cell separator, empty cells keep their column position);
 *   2. p:grpSp and mc:AlternateContent (single-branch) content is extracted;
 *   3. any shape kind that stays unextracted (charts, SmartArt, OLE,
 *      unknown children) is DISCLOSED via warnings, never silently omitted.
 *
 * The end-to-end mode=artifact call shape is pinned by replayCorpus.spec.ts
 * (ptb group); this file exercises office/pptx.ts directly.
 */

import { describe, expect, it } from "vitest";

import { extractPptx, pptxSlides } from "../office/pptx.js";

// JSZip write API (types-shim only covers loadAsync) — same cast pattern as
// extractOfficeText.spec.ts's buildMinimalDocx / readCodeArtifactDispatch's
// buildTestPptx.
type JSZipFull = {
  file(name: string, data: string): void;
  generateAsync(opts: { type: "nodebuffer" }): Promise<Buffer>;
};

const SLIDE_NS =
  `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"` +
  ` xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"` +
  ` xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`;

/** Wrap spTree children into a full slide XML document. */
function slideXml(spTreeChildren: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<p:sld ${SLIDE_NS}><p:cSld><p:spTree>${spTreeChildren}</p:spTree></p:cSld></p:sld>`
  );
}

function titleSp(text: string): string {
  return (
    `<p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>` +
    `<p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`
  );
}

function bodySp(text: string): string {
  return `<p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`;
}

function tc(paragraphs: string[]): string {
  const paras = paragraphs.length === 0
    ? "<a:p/>"
    : paragraphs.map((t) => `<a:p><a:r><a:t>${t}</a:t></a:r></a:p>`).join("");
  return `<a:tc><a:txBody>${paras}</a:txBody></a:tc>`;
}

/** rows: one string[] of cell texts per row ("" -> empty cell). */
function tableFrame(rows: string[][]): string {
  const trs = rows
    .map((cells) => `<a:tr>${cells.map((c) => tc(c === "" ? [] : [c])).join("")}</a:tr>`)
    .join("");
  return (
    `<p:graphicFrame><a:graphic>` +
    `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">` +
    `<a:tbl>${trs}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`
  );
}

function chartFrame(): string {
  return (
    `<p:graphicFrame><a:graphic>` +
    `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">` +
    `<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId9"/>` +
    `</a:graphicData></a:graphic></p:graphicFrame>`
  );
}

/** Minimal-but-realistic deck container around the given slide bodies —
 * same container files as readCodeArtifactDispatch.spec.ts's buildTestPptx
 * (pptx2json parses every .xml/.rels entry and keys by zip path). */
async function buildDeckPptx(spTreesPerSlide: string[]): Promise<Uint8Array> {
  const JSZipCtor = (await import("jszip")) as unknown as { default: new () => JSZipFull };
  const zip: JSZipFull = new JSZipCtor.default();

  const slideOverrides = spTreesPerSlide
    .map((_, i) =>
      `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`)
    .join("");
  const contentTypesXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>` +
    `${slideOverrides}</Types>`;
  const rootRelsXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`;
  const sldIds = spTreesPerSlide
    .map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`)
    .join("");
  const presentationXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation ${SLIDE_NS}><p:sldIdLst>${sldIds}</p:sldIdLst></p:presentation>`;
  const presentationRels = spTreesPerSlide
    .map((_, i) =>
      `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`)
    .join("");
  const presentationRelsXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${presentationRels}</Relationships>`;
  const emptyRelsXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;

  zip.file("_rels/.rels", rootRelsXml);
  zip.file("[Content_Types].xml", contentTypesXml);
  zip.file("ppt/presentation.xml", presentationXml);
  zip.file("ppt/_rels/presentation.xml.rels", presentationRelsXml);
  spTreesPerSlide.forEach((spTree, i) => {
    zip.file(`ppt/slides/slide${i + 1}.xml`, slideXml(spTree));
    zip.file(`ppt/slides/_rels/slide${i + 1}.xml.rels`, emptyRelsXml);
  });

  const buf = await zip.generateAsync({ type: "nodebuffer" });
  return new Uint8Array(buf);
}

// Mirrors the live Slide 5 shape: title placeholder + caption text shape +
// an a:tbl reference table inside a p:graphicFrame.
const RATING_TABLE_SPTREE =
  titleSp("Rating Factors Reference") +
  bodySp("Table maintained by the actuarial team") +
  tableFrame([
    ["CLASS", "DESCRIPTION", "FACTOR"],
    ["PREFERRED_PLUS", "Best class, no nicotine", "0.85"],
    ["SUBSTANDARD", "Nicotine use or hazardous occupation", "1.60"],
  ]);

describe("pptx table extraction (a:tbl inside p:graphicFrame)", () => {
  it("extractPptx serves table rows row-per-line with ' | ' cell separator", async () => {
    const bytes = await buildDeckPptx([RATING_TABLE_SPTREE]);
    const result = await extractPptx(bytes);
    if (!result.ok) throw new Error(`extractPptx failed: ${result.error}`);
    expect(result.text).toContain("CLASS | DESCRIPTION | FACTOR");
    expect(result.text).toContain("SUBSTANDARD | Nicotine use or hazardous occupation | 1.60");
    expect(result.text).toContain("PREFERRED_PLUS | Best class, no nicotine | 0.85");
    // Reading order within the parse's limits: text shapes precede the table.
    expect(result.text.indexOf("Table maintained by the actuarial team"))
      .toBeLessThan(result.text.indexOf("CLASS | DESCRIPTION | FACTOR"));
    // Fully extracted slide -> zero disclosure warnings.
    expect(result.warnings).toEqual([]);
  });

  it("pptxSlides carries table rows in the slide text with truncated:false and no warnings", async () => {
    const bytes = await buildDeckPptx([RATING_TABLE_SPTREE]);
    const result = await pptxSlides(bytes);
    if (!result.ok) throw new Error(`pptxSlides failed: ${result.error}`);
    expect(result.slides.length).toBe(1);
    expect(result.slides[0]!.heading).toBe("Slide 1: Rating Factors Reference");
    expect(result.slides[0]!.text).toContain(
      "SUBSTANDARD | Nicotine use or hazardous occupation | 1.60",
    );
    expect(result.truncated).toBe(false);
    expect(result.warnings).toEqual([]);
  });

  it("a table-only slide serves the rows (not '(no content)')", async () => {
    const bytes = await buildDeckPptx([tableFrame([["k1", "v1"], ["k2", "v2"]])]);
    const result = await extractPptx(bytes);
    if (!result.ok) throw new Error(`extractPptx failed: ${result.error}`);
    expect(result.text).toContain("k1 | v1");
    expect(result.text).toContain("k2 | v2");
    expect(result.text).not.toContain("(no content)");
  });

  it("empty cells keep their column position; all-empty rows are dropped", async () => {
    const bytes = await buildDeckPptx([
      tableFrame([["A", "", "C"], ["", "", ""], ["D", "E", "F"]]),
    ]);
    const result = await extractPptx(bytes);
    if (!result.ok) throw new Error(`extractPptx failed: ${result.error}`);
    expect(result.text).toContain("A |  | C");
    expect(result.text).toContain("D | E | F");
    // The all-empty middle row contributes no line: rows land adjacent.
    expect(result.text).toContain("A |  | C\nD | E | F");
  });

  it("multi-paragraph cells join their paragraphs with a single space", async () => {
    const spTree =
      `<p:graphicFrame><a:graphic>` +
      `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">` +
      `<a:tbl><a:tr>${tc(["line one", "line two"])}${tc(["x"])}</a:tr></a:tbl>` +
      `</a:graphicData></a:graphic></p:graphicFrame>`;
    const bytes = await buildDeckPptx([spTree]);
    const result = await extractPptx(bytes);
    if (!result.ok) throw new Error(`extractPptx failed: ${result.error}`);
    expect(result.text).toContain("line one line two | x");
  });

  it("pptxSlides maxChars cap still truncates table-bearing slides", async () => {
    const manyRows = Array.from({ length: 80 }, (_, i) => [`row_${i}`, `value_${i}`, "1.00"]);
    const bytes = await buildDeckPptx([titleSp("Big Table") + tableFrame(manyRows)]);
    const result = await pptxSlides(bytes, { maxChars: 200 });
    if (!result.ok) throw new Error(`pptxSlides failed: ${result.error}`);
    expect(result.truncated).toBe(true);
  });
});

describe("pptx grouped and alternate-content shapes", () => {
  it("extracts text from shapes nested inside p:grpSp", async () => {
    const spTree =
      bodySp("Top-level intro") +
      `<p:grpSp><p:nvGrpSpPr/><p:grpSpPr/>${bodySp("Grouped footnote text")}` +
      `${tableFrame([["g1", "g2"]])}</p:grpSp>`;
    const bytes = await buildDeckPptx([spTree]);
    const result = await extractPptx(bytes);
    if (!result.ok) throw new Error(`extractPptx failed: ${result.error}`);
    expect(result.text).toContain("Grouped footnote text");
    expect(result.text).toContain("g1 | g2");
    expect(result.warnings).toEqual([]);
  });

  it("walks exactly one mc:AlternateContent branch (mc:Fallback preferred)", async () => {
    const spTree =
      `<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">` +
      `<mc:Choice Requires="p14">${bodySp("ChoiceOnly modern text")}</mc:Choice>` +
      `<mc:Fallback>${bodySp("Fallback compat text")}</mc:Fallback>` +
      `</mc:AlternateContent>`;
    const bytes = await buildDeckPptx([spTree]);
    const result = await extractPptx(bytes);
    if (!result.ok) throw new Error(`extractPptx failed: ${result.error}`);
    expect(result.text).toContain("Fallback compat text");
    // Choice and Fallback render the SAME logical shape — never both.
    expect(result.text).not.toContain("ChoiceOnly modern text");
  });
});

describe("pptx shape-kind disclosure (never silently omit)", () => {
  it("charts surface a warning naming the slide", async () => {
    const bytes = await buildDeckPptx([titleSp("Metrics") + bodySp("See chart") + chartFrame()]);
    const result = await pptxSlides(bytes);
    if (!result.ok) throw new Error(`pptxSlides failed: ${result.error}`);
    expect(result.warnings).toEqual(["chart content not extracted (slide 1)"]);
    expect(result.slides[0]!.text).toContain("See chart");
  });

  it("the same disclosure across slides collapses to one warning listing them", async () => {
    const bytes = await buildDeckPptx([chartFrame(), bodySp("plain"), chartFrame()]);
    const result = await extractPptx(bytes);
    if (!result.ok) throw new Error(`extractPptx failed: ${result.error}`);
    expect(result.warnings).toEqual(["chart content not extracted (slides 1, 3)"]);
  });

  it("repeating an unhandled kind within one slide yields a single disclosure", async () => {
    const bytes = await buildDeckPptx([chartFrame() + chartFrame() + chartFrame()]);
    const result = await extractPptx(bytes);
    if (!result.ok) throw new Error(`extractPptx failed: ${result.error}`);
    expect(result.warnings).toEqual(["chart content not extracted (slide 1)"]);
  });

  it("unknown spTree children are disclosed by element name", async () => {
    const spTree = bodySp("has ink") + `<p:contentPart r:id="rId7"/>`;
    const bytes = await buildDeckPptx([spTree]);
    const result = await extractPptx(bytes);
    if (!result.ok) throw new Error(`extractPptx failed: ${result.error}`);
    expect(result.warnings).toEqual(["unextracted shape kind 'p:contentPart' (slide 1)"]);
  });

  it("SmartArt diagrams are disclosed", async () => {
    const spTree =
      `<p:graphicFrame><a:graphic>` +
      `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/diagram">` +
      `<dgm:relIds xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram"/>` +
      `</a:graphicData></a:graphic></p:graphicFrame>`;
    const bytes = await buildDeckPptx([spTree]);
    const result = await extractPptx(bytes);
    if (!result.ok) throw new Error(`extractPptx failed: ${result.error}`);
    expect(result.warnings).toEqual(["SmartArt diagram content not extracted (slide 1)"]);
  });

  it("pictures stay silent — p:pic carries no txBody, so nothing is dropped", async () => {
    const spTree =
      bodySp("caption") +
      `<p:pic><p:nvPicPr/><p:blipFill/><p:spPr/></p:pic>`;
    const bytes = await buildDeckPptx([spTree]);
    const result = await extractPptx(bytes);
    if (!result.ok) throw new Error(`extractPptx failed: ${result.error}`);
    expect(result.warnings).toEqual([]);
  });
});
