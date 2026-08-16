/**
 * artifactSurfaceSections.spec.ts — A1 content-bearing artifact surfaces (2026-07-30).
 *
 * Live defect (cell T14, two-pptx drift audit): the first task_pack resolved BOTH
 * decks — path, size, handle, and an `extract` call string each — and served ZERO
 * slide text, in a 2.9 KB response with ~21 KB of pack budget unused. It then
 * certified `typestate.phase:"awaiting-input"` / `next_action:"request-user-input"`
 * ("no editable handles returned"), so the solver spent two extra `mode=artifact`
 * round trips reading content the server had already located. Meanwhile the
 * distributed guide's own contract says "artifact packs need content-bearing
 * `artifact_sections` per source" — the promise existed, only artifact_build kept it.
 *
 * Pinned here:
 *   - a CALLER-NAMED artifact (paths[]/path, or its name in the query prose)
 *     carries its extracted text inline, per-source, with an `inlined[]` stamp;
 *   - an artifact surfaced only by query-token relevance stays a cheap stub —
 *     candidate ambiguity must not pre-commit the budget to unchosen candidates;
 *   - over-budget extractions serve a PREFIX plus content_completeness:"partial",
 *     the artifact handle, the unserved section ids, a one-call `next`, and a
 *     truthful note — never a silent cut and never a fallback to the stub;
 *   - the per-artifact (8 KiB) / all-artifacts (16 KiB) / transport (32 KiB)
 *     budgets all hold;
 *   - trimToCap sheds a caller-named artifact body LAST — after advisory
 *     metadata, after unnamed artifact bodies, and after code bodies;
 *   - an answer pack whose whole evidence set is inlined artifact content
 *     certifies answer-ready instead of asking the user.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  buildTaskPack,
  isArtifactTaskPackSurface,
  resetArtifactSectionPrefetch,
  resetPackDedupeCache,
  resetRoleInventoryCache,
  trimToCap,
  type TaskPackResult,
  type TaskPackResultSurface,
  type TaskPackSurface,
} from "../tools/readCodeTaskPack.js";
import { resetRootResolverCache } from "../tools/locateTaskContext.js";
import { resetTokenlightenIgnoreCache } from "../tools/walkRepo.js";
import { handleTable } from "../util/handles.js";

type Worksheet = { addRow(values: unknown[]): void };
type Workbook = {
  addWorksheet(name: string): Worksheet;
  xlsx: { writeBuffer(): Promise<Buffer> };
};
type JSZipFull = {
  file(name: string, data: string): void;
  generateAsync(opts: { type: "nodebuffer" }): Promise<Buffer>;
};

const SLIDE_NS =
  `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"` +
  ` xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"` +
  ` xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`;

const workspaces: string[] = [];

function workspace(tag: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tl-artifact-surface-${tag}-`));
  workspaces.push(dir);
  return dir;
}

function writeBytes(root: string, rel: string, bytes: Buffer): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, bytes);
}

function writeText(root: string, rel: string, text: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, "utf8");
}

/** Minimal-but-real deck container (same shape as pptxTables.spec.ts's builder). */
async function deckBytes(slides: Array<{ title: string; body: string }>): Promise<Buffer> {
  const JSZipCtor = (await import("jszip")) as unknown as { default: new () => JSZipFull };
  const zip: JSZipFull = new JSZipCtor.default();
  const overrides = slides
    .map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`)
    .join("");
  zip.file("[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`
    + `<Default Extension="xml" ContentType="application/xml"/>`
    + `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>`
    + `${overrides}</Types>`);
  zip.file("_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`);
  zip.file("ppt/presentation.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation ${SLIDE_NS}><p:sldIdLst>`
    + slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join("")
    + `</p:sldIdLst></p:presentation>`);
  zip.file("ppt/_rels/presentation.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + slides.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`).join("")
    + `</Relationships>`);
  slides.forEach((slide, i) => {
    zip.file(`ppt/slides/slide${i + 1}.xml`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld ${SLIDE_NS}><p:cSld><p:spTree>`
      + `<p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>`
      + `<p:txBody><a:p><a:r><a:t>${slide.title}</a:t></a:r></a:p></p:txBody></p:sp>`
      + `<p:sp><p:txBody><a:p><a:r><a:t>${slide.body}</a:t></a:r></a:p></p:txBody></p:sp>`
      + `</p:spTree></p:cSld></p:sld>`);
    zip.file(`ppt/slides/_rels/slide${i + 1}.xml.rels`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`);
  });
  return zip.generateAsync({ type: "nodebuffer" });
}

async function workbookBytes(sheetName: string, rows: number): Promise<Buffer> {
  const ExcelJSMod = (await import("exceljs")) as unknown as { Workbook: new () => Workbook };
  const workbook = new ExcelJSMod.Workbook();
  const data = workbook.addWorksheet(sheetName);
  data.addRow(["gateway", "owner", "sla"]);
  for (let index = 0; index < rows; index++) {
    data.addRow([`gateway-${index}`, "platform", 99.9]);
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function resetState(): void {
  handleTable.reset();
  resetArtifactSectionPrefetch();
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

function artifactSurfaces(result: TaskPackResult) {
  return (result.surfaces as TaskPackResultSurface[]).filter(isArtifactTaskPackSurface);
}

function slideTextOf(result: TaskPackResult, relPath: string): string {
  const entry = result.artifact_sections?.find((item) => item.path === relPath);
  return JSON.stringify(entry?.section ?? {});
}

const AUDIT_QUERY = "Audit docs/system-overview.pptx and docs/roadmap.pptx for gateway drift between the architecture deck and the roadmap deck. No code changes.";

async function twoDeckWorkspace(tag: string): Promise<string> {
  const ws = workspace(tag);
  writeBytes(ws, "docs/system-overview.pptx", await deckBytes([
    { title: "Architecture Overview", body: "The gateway fronts the pricing service and the audit ledger." },
    { title: "Deployment Topology", body: "Two regions, active-active, gateway in both." },
  ]));
  writeBytes(ws, "docs/roadmap.pptx", await deckBytes([
    { title: "Roadmap 2026", body: "Q1 gateway rewrite, Q2 ledger migration." },
    { title: "Risks", body: "The gateway rewrite risks double-posting in the ledger." },
  ]));
  writeText(ws, "README.md", "# workspace\n");
  return ws;
}

// ---------------------------------------------------------------------------
// The T14 case itself.
// ---------------------------------------------------------------------------

describe("A1 — caller-named artifact surfaces carry content", () => {
  it("inlines BOTH named decks' slide text instead of serving size+handle stubs", async () => {
    const ws = await twoDeckWorkspace("two-deck");

    const result = await buildTaskPack({
      query: AUDIT_QUERY,
      paths: ["docs/system-overview.pptx", "docs/roadmap.pptx"],
      taskProfile: "answer",
    }, ws);

    // Both decks are still resolved as surfaces (the stub affordance is kept)...
    expect(artifactSurfaces(result).map((surface) => surface.path).sort())
      .toEqual(["docs/roadmap.pptx", "docs/system-overview.pptx"]);
    // ...and now each one also carries its extracted text, per source.
    expect(result.artifact_sections?.map((entry) => entry.path).sort())
      .toEqual(["docs/roadmap.pptx", "docs/system-overview.pptx"]);
    expect(slideTextOf(result, "docs/system-overview.pptx")).toContain("gateway fronts the pricing service");
    expect(slideTextOf(result, "docs/roadmap.pptx")).toContain("Q1 gateway rewrite");
    // One verifiable stamp per inlined source (attachSupply §11.4 drops any that
    // does not name content present in the same response, so their survival at
    // the wire exit is what makes this an honest claim).
    expect(result.inlined?.filter((stamp) => stamp.startsWith("artifact-section:")).length).toBe(2);

    // The whole extraction fitted, so no partial bookkeeping rides along.
    for (const entry of result.artifact_sections ?? []) {
      expect(entry.content_completeness).toBeUndefined();
      expect(entry.remaining_sections).toBeUndefined();
    }
  }, 30_000);

  it("certifies the artifact-only answer pack ready instead of asking the user", async () => {
    const ws = await twoDeckWorkspace("certify");

    const result = await buildTaskPack({
      query: AUDIT_QUERY,
      paths: ["docs/system-overview.pptx", "docs/roadmap.pptx"],
      taskProfile: "answer",
    }, ws);

    // Pre-A1 this pack was phase "awaiting-input" / next_action
    // "request-user-input" with reason "no editable handles returned".
    expect(result.route).toMatchObject({
      action: "answer_from_handles",
      max_additional_tl_calls: 0,
    });
    expect(result.execution_contract).toMatchObject({
      state: "ready",
      discovery_complete: true,
      next_action: "answer",
      typestate: { phase: "prepared" },
    });
    expect(result.execution_contract?.semantic_closure?.state).toBe("closed");
    expect(result.next).toBeUndefined();
  }, 30_000);

  it("inlines an artifact named only in the query prose (no paths[])", async () => {
    const ws = workspace("query-named");
    writeBytes(ws, "docs/rate-table.xlsx", await workbookBytes("BaseRates", 3));
    writeText(ws, "README.md", "# workspace\n");

    const result = await buildTaskPack({
      query: "What gateway owners are listed in the rate-table.xlsx spreadsheet? No code changes.",
      taskProfile: "answer",
    }, ws);

    expect(result.artifact_sections?.map((entry) => entry.path)).toEqual(["docs/rate-table.xlsx"]);
    const section = result.artifact_sections?.[0]?.section;
    expect(section && "sheet" in section ? section.sheet : undefined).toBe("BaseRates");
    expect(section && "sheet" in section ? section.rows.length : 0).toBe(3);
  }, 30_000);

  it("leaves an artifact NOBODY named as a cheap stub (unchosen candidates stay unpriced)", async () => {
    const ws = workspace("unnamed");
    writeBytes(ws, "docs/alpha-report.pptx", await deckBytes([
      { title: "Alpha", body: "The gateway alpha report body." },
    ]));
    writeBytes(ws, "docs/beta-report.pptx", await deckBytes([
      { title: "Beta", body: "The gateway beta report body." },
    ]));
    writeText(ws, "README.md", "# workspace\n");

    // The query names a KIND ("slide deck") — enough to discover both decks —
    // but neither file by name, so neither is a chosen candidate.
    const result = await buildTaskPack({
      query: "Which slide deck covers the gateway report? No code changes.",
      taskProfile: "answer",
    }, ws);

    expect(artifactSurfaces(result).length).toBeGreaterThan(0);
    for (const surface of artifactSurfaces(result)) {
      expect(surface.extract).toBe(`read_file mode=artifact path=${surface.path}`);
    }
    expect(result.artifact_sections).toBeUndefined();
    expect(result.inlined?.some((stamp) => stamp.startsWith("artifact-section:")) ?? false).toBe(false);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Budgets.
// ---------------------------------------------------------------------------

describe("A1 — inline budgets stay honest", () => {
  it("serves a PREFIX plus handle/remaining_sections/next/note for an over-budget deck", async () => {
    const ws = workspace("over-budget");
    // 6 slides x ~2.5 KB of body each: well past the 8 KiB per-artifact cap, so
    // leading slides must be served WHOLE and the tail named, not clipped silently.
    writeBytes(ws, "docs/system-overview.pptx", await deckBytes(
      Array.from({ length: 6 }, (_, i) => ({
        title: `Section ${i + 1}`,
        body: `gateway detail ${i + 1}: ` + "payload ".repeat(320),
      })),
    ));
    writeText(ws, "README.md", "# workspace\n");

    const result = await buildTaskPack({
      query: "Audit docs/system-overview.pptx for gateway drift across the architecture deck. No code changes.",
      paths: ["docs/system-overview.pptx"],
      taskProfile: "answer",
    }, ws);

    const entry = result.artifact_sections?.[0];
    expect(entry?.path).toBe("docs/system-overview.pptx");
    expect(entry?.content_completeness).toBe("partial");
    // Per-artifact inline cap respected...
    const sectionBytes = Buffer.byteLength(JSON.stringify(entry?.section), "utf8");
    expect(sectionBytes).toBeLessThanOrEqual(8192);
    // ...with real, whole leading content (not a stub, not a clipped fragment).
    const served = entry?.section;
    expect(served && "kind" in served && served.kind === "pptx" ? served.slides.length : 0)
      .toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(served)).toContain("gateway detail 1");
    // The unserved tail is named, addressed through the artifact's own handle,
    // and fetchable in ONE call.
    expect((entry?.remaining_sections ?? []).length).toBeGreaterThan(0);
    expect(entry?.handle).toBe(artifactSurfaces(result)[0]?.handle);
    expect(entry?.next).toContain(`read_file mode=artifact handle=${entry?.handle}`);
    expect(entry?.next).toContain("slides=");
    expect(String(entry?.note)).toContain("per-artifact inline cap");
  }, 30_000);

  it("holds the all-artifacts total and the transport ceiling with several named decks", async () => {
    const ws = workspace("total-budget");
    for (const name of ["alpha", "beta", "gamma", "delta"]) {
      writeBytes(ws, `docs/${name}-deck.pptx`, await deckBytes(
        Array.from({ length: 4 }, (_, i) => ({
          title: `${name} ${i + 1}`,
          body: `gateway ${name} detail ${i + 1}: ` + "payload ".repeat(300),
        })),
      ));
    }
    writeText(ws, "README.md", "# workspace\n");

    const result = await buildTaskPack({
      query: "Compare the gateway sections across alpha-deck.pptx, beta-deck.pptx, gamma-deck.pptx and delta-deck.pptx. No code changes.",
      paths: ["docs/alpha-deck.pptx", "docs/beta-deck.pptx", "docs/gamma-deck.pptx", "docs/delta-deck.pptx"],
      taskProfile: "answer",
    }, ws);

    const entries = result.artifact_sections ?? [];
    expect(entries.length).toBeGreaterThanOrEqual(2);
    const totalSectionBytes = entries.reduce(
      (total, entry) => total + Buffer.byteLength(JSON.stringify(entry), "utf8"),
      0,
    );
    expect(totalSectionBytes).toBeLessThanOrEqual(16_384);
    // Transport-safe pack ceiling (MAX_TASK_PACK_BYTES_ARTIFACT_BUNDLE).
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(32_768);
    // Every inlined entry still names a surface of THIS pack, so every stamp is verifiable.
    const surfacePaths = new Set(artifactSurfaces(result).map((surface) => surface.path));
    for (const entry of entries) expect(surfacePaths.has(entry.path)).toBe(true);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// trimToCap shed order.
// ---------------------------------------------------------------------------

function mkSurface(role: string, handle: string, pathStr: string, code?: string): TaskPackSurface {
  return { role, handle, path: pathStr, range: "1-50", ...(code !== undefined ? { code } : {}) };
}

function slideSection(heading: string, chars: number) {
  return {
    kind: "pptx" as const,
    slides: [{ heading, text: heading.slice(0, 1).repeat(chars) }],
    truncated: false,
  };
}

/**
 * A pack over the code-bearing cap (28672) by ~1.7 KB — small enough that
 * degrading ONE unnamed artifact body closes the gap on its own.
 */
function packOverByOneArtifactBody(): TaskPackResult {
  return {
    mode: "task_pack",
    coverage: "complete",
    surfaces: [
      mkSurface("api", "h1", "src/a.ts", "x".repeat(6000)),
      mkSurface("impl", "h2", "src/b.ts", "y".repeat(6000)),
    ],
    missing: [],
    artifact_sections: [
      { path: "docs/Named.pptx", section: slideSection("Named", 6000) },
      { path: "docs/Unnamed.pptx", section: slideSection("Unnamed", 12000) },
    ],
    inlined: [
      "artifact-section:docs/Named.pptx#Named",
      "artifact-section:docs/Unnamed.pptx#Unnamed",
    ],
  };
}

describe("A1 — trimToCap sheds a caller-named artifact body LAST", () => {
  it("degrades the UNNAMED artifact body before any code body is touched", () => {
    const trimmed = trimToCap(
      packOverByOneArtifactBody(),
      undefined,
      new Set(["docs/named.pptx"]),
    );

    // Every code body is intact — the unnamed artifact body paid instead.
    expect(trimmed.surfaces.every((surface) => surface.code !== undefined)).toBe(true);
    expect(trimmed.surfaces.every((surface) => surface.content_completeness === undefined)).toBe(true);
    const unnamed = (trimmed.artifact_sections ?? []).find((entry) => entry.path === "docs/Unnamed.pptx");
    if (unnamed === undefined) {
      expect(trimmed.artifact_sections_trimmed).toEqual(["docs/Unnamed.pptx"]);
    } else {
      expect(unnamed.content_completeness).toBe("partial");
      expect(Buffer.byteLength(JSON.stringify(unnamed.section), "utf8")).toBeLessThan(12000);
    }
    // The caller-named body is untouched and still content-bearing.
    const named = (trimmed.artifact_sections ?? []).find((entry) => entry.path === "docs/Named.pptx");
    expect(named?.content_completeness).toBeUndefined();
    expect(JSON.stringify(named?.section)).toContain("N".repeat(6000));
  });

  it("keeps a caller-named artifact body while EVERY code body is stripped", () => {
    // Over cap by more than one artifact body: the unnamed body goes first, then
    // code bodies — the named artifact body still outlives them all.
    const result: TaskPackResult = {
      ...packOverByOneArtifactBody(),
      surfaces: [
        mkSurface("api", "h1", "src/a.ts", "x".repeat(12000)),
        mkSurface("impl", "h2", "src/b.ts", "y".repeat(12000)),
      ],
    };
    const trimmed = trimToCap(result, undefined, new Set(["docs/named.pptx"]));

    const named = (trimmed.artifact_sections ?? []).find((entry) => entry.path === "docs/Named.pptx");
    expect(named, JSON.stringify(trimmed.artifact_sections_trimmed)).toBeDefined();
    expect(JSON.stringify(named?.section)).toContain("N".repeat(1000));
    expect(trimmed.surfaces.some((surface) => surface.code === undefined)).toBe(true);
    // Stamps never outlive the bodies they name.
    for (const stamp of trimmed.inlined ?? []) {
      const stamped = /^artifact-section:(.+)#/.exec(stamp)?.[1];
      if (stamped !== undefined) {
        expect((trimmed.artifact_sections ?? []).some((entry) => entry.path === stamped)).toBe(true);
      }
    }
  });

  it("treats an unknown naming set as 'all named' — no artifact body is shed early", () => {
    // An empty/absent protected set means "not computed here" (the artifact_build
    // flow bundles its own sections), NOT "none of them were named".
    const trimmed = trimToCap(packOverByOneArtifactBody(), undefined, new Set<string>());
    expect((trimmed.artifact_sections ?? []).length).toBe(2);
    // Code bodies are the ones that pay in that case.
    expect(trimmed.surfaces.some((surface) => surface.content_completeness === "partial")).toBe(true);
  });

  it("degrades a caller-named artifact body as the LAST resort, and says so", () => {
    // One surface (so the whole-surface drop phase cannot help) with a path long
    // enough that even the code-less envelope exceeds the cap: the trim ladder
    // has to reach the named-artifact phase.
    const result: TaskPackResult = {
      mode: "task_pack",
      coverage: "complete",
      surfaces: [mkSurface("api", "h1", "src/" + "d".repeat(26000) + ".ts", "c".repeat(2000))],
      missing: [],
      artifact_sections: [{ path: "docs/Named.pptx", section: slideSection("Named", 6000) }],
      inlined: ["artifact-section:docs/Named.pptx#Named"],
    };
    const trimmed = trimToCap(result, undefined, new Set(["docs/named.pptx"]));

    expect(trimmed.surfaces[0]?.code).toBeUndefined();
    const named = (trimmed.artifact_sections ?? []).find((entry) => entry.path === "docs/Named.pptx");
    if (named === undefined) {
      // Shed entirely — stated, never silent, and the stub surface still carries
      // the artifact's own `extract` affordance.
      expect(trimmed.artifact_sections_trimmed).toContain("docs/Named.pptx");
      expect(trimmed.inlined).toBeUndefined();
    } else {
      expect(named.content_completeness).toBe("partial");
      expect(String(named.note)).toContain("pack byte budget");
      expect(Buffer.byteLength(JSON.stringify(named.section), "utf8")).toBeLessThan(6000);
    }
  });
});
