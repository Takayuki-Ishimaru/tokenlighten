import { describe, expect, it } from "vitest";

import { extractOoxmlVisualInventory } from "../office/ooxmlVisuals.js";

type JSZipFull = {
  file(name: string, data: string | Uint8Array): void;
  generateAsync(opts: { type: "nodebuffer" }): Promise<Buffer>;
};

async function packageBytes(entries: Record<string, string | Uint8Array>): Promise<Uint8Array> {
  const JSZipCtor = (await import("jszip")) as unknown as { default: new () => JSZipFull };
  const zip = new JSZipCtor.default();
  for (const [name, data] of Object.entries(entries)) zip.file(name, data);
  return new Uint8Array(await zip.generateAsync({ type: "nodebuffer" }));
}

const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const OFFICE_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

function relationships(items: Array<{ id: string; type: string; target: string }>): string {
  return `<Relationships xmlns="${REL_NS}">${items.map((item) =>
    `<Relationship Id="${item.id}" Type="${OFFICE_REL}/${item.type}" Target="${item.target}"/>`
  ).join("")}</Relationships>`;
}

function chartXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${OFFICE_REL}">
<c:chart><c:title><c:tx><c:rich><a:p><a:r><a:t>Quarterly Revenue</a:t></a:r></a:p></c:rich></c:tx></c:title>
<c:plotArea><c:barChart><c:ser>
<c:tx><c:strRef><c:f>Data!$B$1</c:f><c:strCache><c:pt idx="0"><c:v>Revenue</c:v></c:pt></c:strCache></c:strRef></c:tx>
<c:cat><c:strRef><c:f>Data!$A$2:$A$4</c:f><c:strCache><c:pt idx="0"><c:v>Q1</c:v></c:pt><c:pt idx="1"><c:v>Q2</c:v></c:pt><c:pt idx="2"><c:v>Q3</c:v></c:pt></c:strCache></c:strRef></c:cat>
<c:val><c:numRef><c:f>Data!$B$2:$B$4</c:f><c:numCache><c:pt idx="0"><c:v>120</c:v></c:pt><c:pt idx="1"><c:v>145</c:v></c:pt><c:pt idx="2"><c:v>163</c:v></c:pt></c:numCache></c:numRef></c:val>
</c:ser></c:barChart></c:plotArea><c:externalData r:id="rIdWorkbook"/></c:chart></c:chartSpace>`;
}

describe("OOXML chart and media inventory", () => {
  it("extracts PPTX chart series/source data plus image and video metadata", async () => {
    const slide = `<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="${OFFICE_REL}"><p:cSld><p:spTree>
<p:graphicFrame><p:xfrm><a:off x="100" y="200"/><a:ext cx="300" cy="400"/></p:xfrm><a:graphic><a:graphicData><c:chart r:id="rIdChart"/></a:graphicData></a:graphic></p:graphicFrame>
<p:pic><p:nvPicPr><p:cNvPr id="2" name="Sales screenshot" descr="Bar chart preview" title="Revenue preview"/></p:nvPicPr><p:blipFill><a:blip r:embed="rIdImage"/></p:blipFill><p:spPr><a:xfrm><a:off x="500" y="600"/><a:ext cx="700" cy="800"/></a:xfrm></p:spPr></p:pic>
</p:spTree></p:cSld></p:sld>`;
    const bytes = await packageBytes({
      "ppt/slides/slide1.xml": slide,
      "ppt/slides/_rels/slide1.xml.rels": relationships([
        { id: "rIdChart", type: "chart", target: "../charts/chart1.xml" },
        { id: "rIdImage", type: "image", target: "../media/image1.png" },
        { id: "rIdVideo", type: "video", target: "../media/demo.mp4" },
      ]),
      "ppt/charts/chart1.xml": chartXml(),
      "ppt/charts/_rels/chart1.xml.rels": relationships([
        { id: "rIdWorkbook", type: "package", target: "../embeddings/source.xlsx" },
      ]),
      "ppt/embeddings/source.xlsx": "embedded workbook",
      "ppt/media/image1.png": new Uint8Array([1, 2, 3]),
      "ppt/media/demo.mp4": new Uint8Array([4, 5, 6]),
    });

    const result = await extractOoxmlVisualInventory(bytes, "pptx");
    expect(result.truncated).toBe(false);
    expect(result.charts).toHaveLength(1);
    expect(result.charts[0]).toMatchObject({
      type: "bar",
      title: "Quarterly Revenue",
      embeddedWorkbook: "ppt/embeddings/source.xlsx",
    });
    expect(result.charts[0]!.locations[0]).toMatchObject({ location: "Slide 1" });
    expect(result.charts[0]!.series[0]).toMatchObject({
      name: "Revenue",
      categoryFormula: "Data!$A$2:$A$4",
      categories: ["Q1", "Q2", "Q3"],
      valueFormula: "Data!$B$2:$B$4",
      values: [120, 145, 163],
    });

    const image = result.media.find((item) => item.path === "ppt/media/image1.png");
    expect(image).toMatchObject({ kind: "image", format: "png" });
    expect(image!.uses[0]).toMatchObject({
      location: "Slide 1 / object 1",
      name: "Sales screenshot",
      altText: "Bar chart preview",
      title: "Revenue preview",
    });
    expect(image!.uses[0]!.position).toContain("x=500");
    expect(result.media.find((item) => item.path === "ppt/media/demo.mp4")).toMatchObject({
      kind: "video",
      format: "mp4",
      uses: [{ location: "Slide 1" }],
    });
  });

  it("resolves XLSX chart and image anchors to the worksheet name and cells", async () => {
    const workbook = `<workbook xmlns:r="${OFFICE_REL}"><sheets><sheet name="Rates" sheetId="1" r:id="rIdSheet"/></sheets></workbook>`;
    const worksheet = `<worksheet xmlns:r="${OFFICE_REL}"><drawing r:id="rIdDrawing"/></worksheet>`;
    const drawing = `<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="${OFFICE_REL}">
<xdr:twoCellAnchor><xdr:from><xdr:col>1</xdr:col><xdr:row>2</xdr:row></xdr:from><xdr:to><xdr:col>6</xdr:col><xdr:row>12</xdr:row></xdr:to><xdr:graphicFrame><a:graphic><a:graphicData><c:chart r:id="rIdChart"/></a:graphicData></a:graphic></xdr:graphicFrame></xdr:twoCellAnchor>
<xdr:twoCellAnchor><xdr:from><xdr:col>7</xdr:col><xdr:row>1</xdr:row></xdr:from><xdr:to><xdr:col>9</xdr:col><xdr:row>8</xdr:row></xdr:to><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="3" name="Logo" descr="Company logo"/></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="rIdImage"/></xdr:blipFill></xdr:pic></xdr:twoCellAnchor>
</xdr:wsDr>`;
    const bytes = await packageBytes({
      "xl/workbook.xml": workbook,
      "xl/_rels/workbook.xml.rels": relationships([
        { id: "rIdSheet", type: "worksheet", target: "worksheets/sheet1.xml" },
      ]),
      "xl/worksheets/sheet1.xml": worksheet,
      "xl/worksheets/_rels/sheet1.xml.rels": relationships([
        { id: "rIdDrawing", type: "drawing", target: "../drawings/drawing1.xml" },
      ]),
      "xl/drawings/drawing1.xml": drawing,
      "xl/drawings/_rels/drawing1.xml.rels": relationships([
        { id: "rIdChart", type: "chart", target: "../charts/chart1.xml" },
        { id: "rIdImage", type: "image", target: "../media/image1.png" },
      ]),
      "xl/charts/chart1.xml": chartXml(),
      "xl/media/image1.png": new Uint8Array([1]),
    });

    const result = await extractOoxmlVisualInventory(bytes, "xlsx");
    expect(result.charts[0]!.locations[0]).toEqual({
      location: "Sheet \"Rates\"",
      position: "cells B3:G13",
    });
    expect(result.media[0]).toMatchObject({ kind: "image", format: "png" });
    expect(result.media[0]!.uses[0]).toMatchObject({
      location: "Sheet \"Rates\" / object 2",
      position: "cells H2:J9",
      name: "Logo",
      altText: "Company logo",
    });
  });

  it("extracts DOCX chart data and associates image metadata with a Caption paragraph", async () => {
    const document = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="${OFFICE_REL}"><w:body>
<w:p><w:r><w:drawing><wp:inline><wp:extent cx="900" cy="600"/><wp:docPr id="4" name="Forecast" descr="Forecast illustration" title="Forecast title"/><a:graphic><a:graphicData><a:blip r:embed="rIdImage"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>
<w:p><w:pPr><w:pStyle w:val="Caption"/></w:pPr><w:r><w:t>Figure 1 — Revenue forecast</w:t></w:r></w:p>
<w:p><w:r><w:drawing><wp:inline><wp:extent cx="1200" cy="800"/><a:graphic><a:graphicData><c:chart r:id="rIdChart"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>
</w:body></w:document>`;
    const bytes = await packageBytes({
      "word/document.xml": document,
      "word/_rels/document.xml.rels": relationships([
        { id: "rIdImage", type: "image", target: "media/image1.jpeg" },
        { id: "rIdChart", type: "chart", target: "charts/chart1.xml" },
      ]),
      "word/charts/chart1.xml": chartXml(),
      "word/media/image1.jpeg": new Uint8Array([1, 2]),
    });

    const result = await extractOoxmlVisualInventory(bytes, "docx");
    expect(result.charts[0]).toMatchObject({ type: "bar", title: "Quarterly Revenue" });
    expect(result.charts[0]!.series[0]!.values).toEqual([120, 145, 163]);
    expect(result.media[0]).toMatchObject({ kind: "image", format: "jpeg" });
    expect(result.media[0]!.uses[0]).toMatchObject({
      location: "Document / object 1",
      position: "width=900, height=600 EMU",
      name: "Forecast",
      altText: "Forecast illustration",
      title: "Forecast title",
      caption: "Figure 1 — Revenue forecast",
    });
  });

  it("hard-bounds pathological media metadata without returning binary payloads", async () => {
    const hugeAltText = "very-long-alt-text-".repeat(2_000);
    const slide = `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${OFFICE_REL}"><p:cSld><p:spTree><p:pic><p:nvPicPr><p:cNvPr id="9" name="Huge metadata" descr="${hugeAltText}"/></p:nvPicPr><p:blipFill><a:blip r:embed="rIdImage"/></p:blipFill></p:pic></p:spTree></p:cSld></p:sld>`;
    const bytes = await packageBytes({
      "ppt/slides/slide1.xml": slide,
      "ppt/slides/_rels/slide1.xml.rels": relationships([
        { id: "rIdImage", type: "image", target: "../media/image1.png" },
      ]),
      "ppt/media/image1.png": new Uint8Array([1, 2, 3]),
    });

    const result = await extractOoxmlVisualInventory(bytes, "pptx");
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(8_192);
    expect(result.media[0]!.uses[0]!.altText!.endsWith("…")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("data:image");
  });
});
