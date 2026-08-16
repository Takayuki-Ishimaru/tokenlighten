import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  buildTaskPack,
  isArtifactTaskPackSurface,
  resetPackDedupeCache,
  resetRoleInventoryCache,
  type TaskPackResultSurface,
} from "../tools/readCodeTaskPack.js";
import { resetRootResolverCache } from "../tools/locateTaskContext.js";
import { resetTokenlightenIgnoreCache } from "../tools/walkRepo.js";
import { handleTable } from "../util/handles.js";
import { fitArtifactSectionToBytes } from "../features/task-pack/artifactSections.js";
import { artifactRangeReceipt, recordArtifactServedRange, resetWorkspace } from "../state/session.js";

type Worksheet = { addRow(values: unknown[]): void };
type Workbook = {
  addWorksheet(name: string): Worksheet;
  xlsx: { writeBuffer(): Promise<Buffer> };
};
type JSZipFull = {
  file(name: string, data: string): void;
  generateAsync(opts: { type: "nodebuffer" }): Promise<Buffer>;
};

const workspaces: string[] = [];

function workspace(tag: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tl-artifact-build-${tag}-`));
  workspaces.push(dir);
  return dir;
}

function writeText(root: string, rel: string, text: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, "utf8");
}

function writeBytes(root: string, rel: string, bytes: Buffer): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, bytes);
}

async function workbookBytes(
  sheetName: string,
  rows: number,
  payloadWidth: number,
): Promise<Buffer> {
  const ExcelJSMod = (await import("exceljs")) as unknown as { Workbook: new () => Workbook };
  const workbook = new ExcelJSMod.Workbook();
  const meta = workbook.addWorksheet("Meta");
  meta.addRow(["field", "value"]);
  meta.addRow(["version", "2026.1"]);
  const data = workbook.addWorksheet(sheetName);
  data.addRow(["key", "rate", "payload"]);
  for (let index = 0; index < rows; index++) {
    data.addRow([`item-${index}`, index + 0.25, "x".repeat(payloadWidth)]);
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function methodologyDocxBytes(): Promise<Buffer> {
  const JSZipCtor = (await import("jszip")) as unknown as { default: new () => JSZipFull };
  const zip = new JSZipCtor.default();
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Premium Calculation Methodology</w:t></w:r></w:p>
<w:p><w:r><w:t>1. Look up the base rate by Product, Sex, and AgeBand.</w:t></w:r></w:p>
<w:p><w:r><w:t>2. Apply the occupation adjustment.</w:t></w:r></w:p>
<w:p><w:r><w:t>3. Apply the loading factor.</w:t></w:r></w:p>
<w:p><w:r><w:t>4. Convert the annual result to a monthly premium.</w:t></w:r></w:p>
<w:p><w:r><w:t>5. Round to whole JPY.</w:t></w:r></w:p>
</w:body></w:document>`;
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.file("word/document.xml", document);
  zip.file("word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

function writeTarget(root: string): void {
  writeText(
    root,
    "src/ratingEngine.ts",
    [
      "export function calculateRate(key: string): number {",
      "  void key;",
      "  return 0;",
      "}",
      "",
    ].join("\n"),
  );
}

function resetState(): void {
  handleTable.reset();
  resetPackDedupeCache();
  resetRoleInventoryCache();
  resetRootResolverCache();
  resetTokenlightenIgnoreCache();
}

beforeEach(() => {
  resetState();
});

afterEach(() => {
  resetState();
  for (const dir of workspaces.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("WS3 artifact_build task profile", () => {
  it("inlines the relevant xlsx sheet with one stamp and the code implementation target", async () => {
    const ws = workspace("inline");
    writeTarget(ws);
    writeBytes(ws, "docs/rate-table.xlsx", await workbookBytes("BaseRates", 3, 8));
    writeBytes(ws, "docs/occupation-codes.xlsx", await workbookBytes("RiskCodes", 2, 8));

    const result = await buildTaskPack(
      {
        query: "Implement calculateRate from docs/rate-table.xlsx using the BaseRates sheet.",
      },
      ws,
    );

    expect(result.route?.action).toBe("edit_from_handles");
    expect(result.route?.max_additional_tl_calls).toBe(0);
    expect(result.execution_contract?.call_budget).toMatchObject({
      version: 2,
      policy: "expected-decision-change",
      discovery_allowed: false,
      terminal_action: "edit",
    });
    expect(result.section && "sheet" in result.section ? result.section.sheet : undefined)
      .toBe("BaseRates");
    expect(result.section && "sheet" in result.section ? result.section.rows.length : 0)
      .toBe(3);
    expect(result.inlined).toEqual([
      "artifact-section:docs/rate-table.xlsx#BaseRates",
    ]);

    const surfaces = result.surfaces as TaskPackResultSurface[];
    const artifacts = surfaces.filter(isArtifactTaskPackSurface);
    expect(artifacts.map((surface) => surface.path).sort()).toEqual([
      "docs/occupation-codes.xlsx",
      "docs/rate-table.xlsx",
    ]);
    expect(new Set(artifacts.map((surface) => surface.path)).size).toBe(artifacts.length);
    expect(
      surfaces.some((surface) =>
        !isArtifactTaskPackSurface(surface)
        && surface.path === "src/ratingEngine.ts"
        && surface.code?.includes("calculateRate")
      ),
      JSON.stringify(result),
    ).toBe(true);
  });

  it("keeps the artifact_build prepared contract when the caller supplies exact artifact and code paths", async () => {
    const ws = workspace("seeded-inline");
    writeTarget(ws);
    writeBytes(ws, "docs/rate-table.xlsx", await workbookBytes("BaseRates", 3, 8));
    writeBytes(ws, "docs/occupation-codes.xlsx", await workbookBytes("RiskCodes", 2, 8));

    const result = await buildTaskPack({
      query: "Implement calculateRate from the rate table XLSX and occupation risk XLSX using BaseRates.",
      paths: [
        "docs/rate-table.xlsx",
        "docs/occupation-codes.xlsx",
        "src/ratingEngine.ts",
      ],
    }, ws);

    expect(result.task_profile).toBe("artifact_build");
    expect(result.artifact_requirements).toEqual([
      "docs/rate-table.xlsx",
      "docs/occupation-codes.xlsx",
    ]);
    expect(result.artifact_sections?.map(({ path: relPath }) => relPath)).toEqual([
      "docs/rate-table.xlsx",
      "docs/occupation-codes.xlsx",
    ]);
    expect(result.artifact_sections?.map(({ section }) =>
      "sheet" in section ? section.sheet : undefined
    )).toEqual(["BaseRates", "RiskCodes"]);
    expect(result.inlined).toEqual([
      "artifact-section:docs/rate-table.xlsx#BaseRates",
      "artifact-section:docs/occupation-codes.xlsx#RiskCodes",
    ]);
    expect(result.route).toMatchObject({
      action: "edit_from_handles",
      max_additional_tl_calls: 0,
    });
    expect(result.change_contract).toMatchObject({
      status: "ready",
      discovery_complete: true,
    });
    expect(result.execution_contract).toMatchObject({
      state: "ready",
      discovery_complete: true,
      next_action: "edit",
      typestate: { phase: "prepared" },
    });
  });

  it("treats one directory as scope and bundles one xlsx plus one docx source", async () => {
    const ws = workspace("directory-multi-artifact");
    writeText(ws, "actuary/pkg/pricing/rating_engine.py", "def calculate_premium():\n    pass\n");
    writeBytes(ws, "docs/tables/rate-table-2026.xlsx", await workbookBytes("BaseRates", 20, 8));
    writeBytes(ws, "docs/tables/occupation-risk-codes.xlsx", await workbookBytes("RiskCodes", 4, 8));
    writeBytes(ws, "docs/design/premium-calc-methodology.docx", await methodologyDocxBytes());
    writeBytes(ws, "docs/design/claims-sop.docx", await methodologyDocxBytes());

    const result = await buildTaskPack({
      query: [
        "Implement premium rating_engine.py in the existing actuary pricing package.",
        "Read the Excel rate table under docs/tables and the design DOCX methodology.",
        "Use Product/Sex/AgeBand lookup, occupation adjustment, loading factor, monthly conversion, and JPY rounding.",
      ].join(" "),
      taskProfile: "multi_concern",
      paths: ["packages", "docs", "docs/tables"],
    }, ws);
    const sections = result.artifact_sections ?? [];
    const rateSection = sections.find(({ path: relPath }) => relPath.endsWith("rate-table-2026.xlsx"));
    const methodSection = sections.find(({ path: relPath }) => relPath.endsWith("premium-calc-methodology.docx"));

    expect(result.task_profile).toBe("artifact_build");
    // B2f (2026-08-01 serving-completeness) DELIBERATE FLIP: was 2. The query
    // names THREE input axes — the rate table, the design methodology and the
    // "occupation adjustment" — but the selector took at most one artifact per
    // requested KIND, so the second workbook was listed as a surface with an
    // `extract` hint and left OUT of artifact_requirements. Live
    // (2026-07-31-semantic-signal5-2, T10) every rep then paid one extra
    // mode=artifact call for the occupation sheet the task text spelled out.
    expect(sections).toHaveLength(3);
    const occupationSection = sections.find(({ path: relPath }) => relPath.endsWith("occupation-risk-codes.xlsx"));
    expect(occupationSection, JSON.stringify(sections.map((s) => s.path))).toBeDefined();
    // The small sheet rides INLINE in the first pack, not as a stub.
    expect(occupationSection?.section && "sheet" in occupationSection.section
      ? occupationSection.section.rows.length
      : 0).toBe(4);
    expect(result.artifact_requirements).toEqual(
      expect.arrayContaining(["docs/tables/occupation-risk-codes.xlsx"]),
    );
    expect(rateSection?.section && "sheet" in rateSection.section ? rateSection.section.sheet : undefined)
      .toBe("BaseRates");
    expect(rateSection?.section && "sheet" in rateSection.section ? rateSection.section.rows.length : 0)
      .toBe(20);
    expect(JSON.stringify(methodSection?.section)).toContain("occupation adjustment");
    expect(result.surfaces.some((surface) =>
      !isArtifactTaskPackSurface(surface)
      && surface.path === "actuary/pkg/pricing/rating_engine.py"
      && typeof surface.code === "string"
    ), JSON.stringify(result)).toBe(true);
    expect(result.route).toMatchObject({ action: "edit_from_handles", max_additional_tl_calls: 0 });
    expect(result.execution_contract).toMatchObject({
      readiness: "edit-ready",
      max_additional_discovery_calls: 0,
      typestate: { phase: "prepared" },
    });
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(16_384);
  });

  it("bundles related implementation and verification surfaces with the artifact section", async () => {
    const ws = workspace("companions");
    writeTarget(ws);
    writeText(
      ws,
      "src/ratingEngine.test.ts",
      [
        "import { calculateRate } from './ratingEngine.js';",
        "export function verifiesBaseRates() { return calculateRate('base'); }",
        "",
      ].join("\n"),
    );
    writeBytes(ws, "docs/rate-table.xlsx", await workbookBytes("BaseRates", 3, 8));

    const result = await buildTaskPack({
      query: "Implement calculateRate from docs/rate-table.xlsx using the BaseRates sheet.",
    }, ws);

    const codePaths = (result.surfaces as TaskPackResultSurface[])
      .filter((surface) => !isArtifactTaskPackSurface(surface))
      .map((surface) => surface.path);
    expect(codePaths).toContain("src/ratingEngine.ts");
    expect(codePaths).toContain("src/ratingEngine.test.ts");
    expect(result.section).toBeDefined();
    expect(result.route).toMatchObject({
      action: "edit_from_handles",
      max_additional_tl_calls: 0,
    });
    expect(result.execution_contract).toMatchObject({
      state: "ready",
      max_additional_discovery_calls: 0,
    });
  });

  it("compacts an oversized sheet into the first pack and reserves the second call for edit", async () => {
    const ws = workspace("over-cap");
    writeTarget(ws);
    writeBytes(ws, "docs/rate-table.xlsx", await workbookBytes("BaseRates", 200, 160));

    const result = await buildTaskPack(
      {
        query: "Implement calculateRate from docs/rate-table.xlsx using the BaseRates sheet.",
      },
      ws,
    );

    expect(result.section).toBeDefined();
    expect(result.section?.truncated).toBe(true);
    expect(result.inlined?.some((entry) => entry.startsWith("artifact-section:")) ?? false)
      .toBe(true);
    expect(result.next).toBeUndefined();
    expect(result.route?.action).toBe("edit_from_handles");
    expect(result.route?.max_additional_tl_calls).toBe(0);
    expect(result.execution_contract?.call_budget).toMatchObject({
      version: 2,
      policy: "expected-decision-change",
      discovery_allowed: false,
      terminal_action: "edit",
    });
    const artifacts = (result.surfaces as TaskPackResultSurface[])
      .filter(isArtifactTaskPackSurface);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.extract).toBe(
      "read_file mode=artifact path=docs/rate-table.xlsx",
    );
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(16_384);
  });

  it("falls through to the generic pack when the marker binds but no artifact is discoverable", async () => {
    const ws = workspace("no-artifact");
    writeTarget(ws);

    const result = await buildTaskPack(
      {
        query: "Implement calculateRate from the spreadsheet table.",
      },
      ws,
    );

    expect(result.section).toBeUndefined();
    expect(result.inlined?.some((entry) => entry.startsWith("artifact-section:")) ?? false)
      .toBe(false);
    expect((result.surfaces as TaskPackResultSurface[]).some(isArtifactTaskPackSurface))
      .toBe(false);
    expect(result.surfaces.some((surface) => surface.path === "src/ratingEngine.ts"))
      .toBe(true);
    expect(result.route?.action).toBe("confirm_candidates");
  });

  it("the raised base cap serves the full artifact preview inline, unconditionally (the must-fetch flag was retired as a no-op)", async () => {
    // 2026-07-24 turn-economy: the artifact cap tiers were raised to >=
    // the former must-fetch pack tier (24576), so the TL_MUSTFETCH_EXPAND
    // flag no longer bought any extra preview room — the SAME structural
    // no-op the §4.6a/b read + codeless-inline paths hit, which is why the
    // flag itself was deleted (2026-08-16). What used to require the flag (a
    // 120x120 BaseRates preview served whole rather than truncated) is
    // delivered by the base cap directly, in one call, unconditionally.
    const small = workspace("small-off");
    writeTarget(small);
    writeBytes(small, "docs/rate-table.xlsx", await workbookBytes("BaseRates", 2, 4));
    const smallOff = await buildTaskPack(
      { query: "Implement calculateRate from docs/rate-table.xlsx BaseRates sheet." },
      small,
    );
    expect(smallOff.section).toBeDefined();

    const medium = workspace("flag-delta");
    writeTarget(medium);
    writeBytes(medium, "docs/rate-table.xlsx", await workbookBytes("BaseRates", 120, 120));

    resetState();
    const off = await buildTaskPack(
      { query: "Implement calculateRate from docs/rate-table.xlsx BaseRates sheet." },
      medium,
    );
    expect(off.section).toBeDefined();
    // The full section is served inline under the raised base cap, without the
    // flag — not truncated, and within the transport-safe budget.
    expect(off.section?.truncated).toBe(false);
    expect(off.inlined).toEqual(["artifact-section:docs/rate-table.xlsx#BaseRates"]);
    expect(off.execution_contract?.call_budget?.discovery_allowed).toBe(false);
    const offBytes = Buffer.byteLength(JSON.stringify(off), "utf8");
    expect(offBytes).toBeLessThanOrEqual(24_576);
  });
});

// ---------------------------------------------------------------------------
// CSV/TSV artifact_build: a csv is a first-class artifact source, so a
// csv-driven build gets the SAME machinery an xlsx-driven one does — a
// content-bearing sheet-shaped section, artifact_requirements naming the csv,
// and (via the shared pack exit) the W5 functional-validation obligation on the
// runnable implementation target.
// ---------------------------------------------------------------------------

const RATE_TABLE_CSV = [
  "product,age_band,sex,base_rate",
  "TERM_LIFE_20,30-39,MALE,1234.5",
  "TERM_LIFE_20,30-39,FEMALE,987.6",
  "",
].join("\n");

const FUNCTIONAL_VALIDATION_MARKER = "validate the produced module";

describe("csv artifact_build task profile", () => {
  it("inlines the csv table as a sheet-shaped section with artifact_requirements and the code target", async () => {
    const ws = workspace("csv-inline");
    writeTarget(ws);
    writeText(ws, "docs/rate-table.csv", RATE_TABLE_CSV);

    const result = await buildTaskPack(
      { query: "Implement calculateRate in src/ratingEngine.ts from docs/rate-table.csv." },
      ws,
    );

    expect(result.task_profile).toBe("artifact_build");
    expect(result.artifact_requirements).toEqual(["docs/rate-table.csv"]);

    // Content-bearing section, reusing the xlsx sheet shape (columns + rows).
    const section = result.section;
    expect(section && "sheet" in section ? section.sheet : undefined).toBe("rate-table.csv");
    expect(section && "sheet" in section ? section.columns : []).toEqual([
      "product", "age_band", "sex", "base_rate",
    ]);
    expect(section && "sheet" in section ? section.rows.length : 0).toBe(2);
    expect(result.inlined).toEqual(["artifact-section:docs/rate-table.csv#rate-table.csv"]);

    expect(result.route?.action).toBe("edit_from_handles");
    expect(result.route?.max_additional_tl_calls).toBe(0);

    // The code implementation target is present and content-bearing.
    expect(result.surfaces.some((surface) =>
      !isArtifactTaskPackSurface(surface)
      && surface.path === "src/ratingEngine.ts"
      && surface.code?.includes("calculateRate")
    ), JSON.stringify(result)).toBe(true);

    // W5: the functional-validation obligation is recorded for the runnable
    // (.ts) target — automatically extended to csv by the shared pack exit.
    const verify = result.verify ?? [];
    expect(
      verify.some((line) => line.includes(FUNCTIONAL_VALIDATION_MARKER) && line.includes("src/ratingEngine.ts")),
      JSON.stringify(verify),
    ).toBe(true);
  });

  it("keeps a prepared contract when the caller seeds exact csv + code paths", async () => {
    const ws = workspace("csv-seeded");
    writeTarget(ws);
    writeText(ws, "docs/rate-table.csv", RATE_TABLE_CSV);

    const result = await buildTaskPack({
      query: "Implement calculateRate from the rate table CSV.",
      paths: ["docs/rate-table.csv", "src/ratingEngine.ts"],
    }, ws);

    expect(result.task_profile).toBe("artifact_build");
    expect(result.artifact_requirements).toEqual(["docs/rate-table.csv"]);
    const section = result.section;
    expect(section && "sheet" in section ? section.rows.length : 0).toBe(2);
    expect(result.route).toMatchObject({ action: "edit_from_handles", max_additional_tl_calls: 0 });
    expect(result.execution_contract).toMatchObject({
      state: "ready",
      discovery_complete: true,
      next_action: "edit",
      typestate: { phase: "prepared" },
    });
  });

  it("serves a tsv source with the tab delimiter and no python runtime hint (csv is stdlib)", async () => {
    const ws = workspace("tsv-source");
    writeText(ws, "src/ratingEngine.py", "def calculate_rate(key):\n    return 0\n");
    writeText(
      ws,
      "docs/rate-table.tsv",
      "product\tage_band\tsex\tbase_rate\nTERM_LIFE_20\t30-39\tMALE\t1234.5\n",
    );

    const result = await buildTaskPack(
      { query: "Implement calculate_rate in src/ratingEngine.py from docs/rate-table.tsv." },
      ws,
    );

    expect(result.artifact_requirements).toEqual(["docs/rate-table.tsv"]);
    const section = result.section;
    expect(section && "sheet" in section ? section.columns : []).toEqual([
      "product", "age_band", "sex", "base_rate",
    ]);
    // Python's csv module is stdlib → no site-packages runtime hint attached.
    expect(result.runtime).toBeUndefined();
  });
});

describe("OOXML preflight on the artifact_build extraction path", () => {
  // Third OOXML entry point besides mode=artifact and extract_office_text:
  // extractArtifactBuildSection must not hand un-preflighted container bytes
  // to xlsxRoster/xlsxTable/docxSections/pptxSlides. The clean-workbook test
  // at the top of this file is the non-vacuity control: the same query DOES
  // inline 3 BaseRates rows when the container passes preflight.
  type JSZipLoadable = {
    file(name: string, data: string): void;
    generateAsync(opts: {
      type: "nodebuffer";
      compression?: string;
      compressionOptions?: { level: number };
    }): Promise<Buffer>;
  };

  async function withJunkPart(
    bytes: Buffer,
    partName: string,
    partChars: number,
  ): Promise<Buffer> {
    const JSZipCtor = (await import("jszip")) as unknown as {
      default: { loadAsync(data: Buffer): Promise<JSZipLoadable> };
    };
    const zip = await JSZipCtor.default.loadAsync(bytes);
    zip.file(partName, "B".repeat(partChars));
    return zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 9 },
    });
  }

  it("L2 underfill defers zero-cell fits without claiming A1:A1", () => {
    const section = { sheet: "BaseRates", range: "A1:G200", columns: ["a", "b"], rows: [[1, 2], [3, 4], [5, 6]], truncated: true };
    const fitted = fitArtifactSectionToBytes(section, 80);
    const fittedSheet = fitted.section && "sheet" in fitted.section ? fitted.section : undefined;
    expect(fittedSheet?.range).toBe("");
    expect(fittedSheet?.rows).toEqual([]);
    expect(fittedSheet?.columns).toEqual([]);
    expect(fitted.remaining).toEqual(["rows 1-3"]);

    const oneRow = fitArtifactSectionToBytes(section, 85);
    const oneRowSheet = oneRow.section && "sheet" in oneRow.section ? oneRow.section : undefined;
    // Header row 1 + one data row = A1:A2 (the range includes the header row).
    expect(oneRowSheet?.range).toBe("A1:A2");
    expect(oneRowSheet?.rows).toEqual([[1]]);
    expect(oneRowSheet?.columns).toEqual(["a"]);
    expect(oneRow.remaining).toEqual(["rows 2-3"]);
  });

  it("L2 full-fill preserves the source range and row/column extent", () => {
    const section = { sheet: "BaseRates", range: "A1:B2", columns: ["a", "b"], rows: [[1, 2], [3, 4]], truncated: false };
    const fitted = fitArtifactSectionToBytes(section, 10_000);
    const fittedSheet = fitted.section && "sheet" in fitted.section ? fitted.section : undefined;
    expect(fittedSheet?.range).toBe("A1:B2");
    expect(fittedSheet?.rows).toHaveLength(2);
    expect(fittedSheet?.columns).toHaveLength(2);
    expect(fitted.remaining).toEqual([]);
  });

  it("L3 artifact subset receipt carries provenance and SHA invalidation", () => {
    const ws = workspace("artifact-ledger");
    resetWorkspace(ws);
    recordArtifactServedRange(ws, "docs/rates.xlsx", "BaseRates", "sha-old", "A1:F116", "artifact A1:F116 (call #1)");
    const subset = artifactRangeReceipt(ws, "docs/rates.xlsx", "BaseRates", "sha-old", "A100:F250");
    expect(subset).toBeUndefined();
    const covered = artifactRangeReceipt(ws, "docs/rates.xlsx", "BaseRates", "sha-old", "A100:F110");
    expect(covered).toMatchObject({ sha: "sha-old".slice(0, 12), served_by: "artifact A1:F116 (call #1)" });
    expect(artifactRangeReceipt(ws, "docs/rates.xlsx", "BaseRates", "sha-new", "A100:F110")).toBeUndefined();
  });

  it("degrades instead of inlining a sheet from a workbook carrying an over-cap part", async () => {
    const ws = workspace("preflight");
    writeTarget(ws);
    const clean = await workbookBytes("BaseRates", 3, 8);
    // 20 MB uncompressed junk part: over ZIP_LIMITS.maxPartUncompressedBytes
    // (16 MB) while the workbook itself stays valid and parseable, so without
    // the preflight gate the roster/table extraction would succeed and leak
    // the "item-0" cell content into the pack.
    writeBytes(ws, "docs/rate-table.xlsx", await withJunkPart(clean, "xl/junk.bin", 20_000_000));

    const result = await buildTaskPack(
      { query: "Implement calculateRate from docs/rate-table.xlsx using the BaseRates sheet." },
      ws,
    );

    expect(result.section && "sheet" in result.section).toBeFalsy();
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("item-0");
    expect(serialized).toContain("mode=artifact");
  });
});
