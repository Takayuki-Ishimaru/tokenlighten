// PPTX extractor — pptx2json wrapper for @tokenlighten/mcp-server.
//
// Ported from proto/src/document/extractors/pptx.ts — VSCode imports stripped.
// Output is PLAIN markdown text: no meta envelope, no 'tokenlighten:meta' wrappers.
// Reason: docs/00-postmortem.md §2.2 — meta envelope dominated cache_write cost.
//
// pptx2json.buffer2json(buffer) — no temp file needed.
// For each slide: extract title + body text, render as markdown section.

export type PptxExtractResult =
  | { ok: true; text: string; warnings: string[] }
  | { ok: false; error: string; warnings: string[] };

// ---------------------------------------------------------------------------
// Text extraction helpers (ported from proto)
// ---------------------------------------------------------------------------

function extractShapeText(spTree: Record<string, unknown>, titleOnly: boolean): string {
  const shapes: unknown[] = (spTree["p:sp"] as unknown[] | undefined) ?? [];
  const texts: string[] = [];

  for (const shape of shapes) {
    if (!shape || typeof shape !== "object") continue;
    const s = shape as Record<string, unknown>;

    if (titleOnly) {
      const nvSpPr = (s["p:nvSpPr"] as unknown[] | undefined)?.[0] as
        | Record<string, unknown>
        | undefined;
      const nvPr = (nvSpPr?.["p:nvPr"] as unknown[] | undefined)?.[0] as
        | Record<string, unknown>
        | undefined;
      const ph = (nvPr?.["p:ph"] as unknown[] | undefined)?.[0] as
        | Record<string, unknown>
        | undefined;
      const phType = (ph?.["$"] as Record<string, string> | undefined)?.["type"];
      if (phType !== "title" && phType !== "ctrTitle") continue;
    }

    const txBody = (s["p:txBody"] as unknown[] | undefined)?.[0];
    if (!txBody) continue;
    const paras: unknown[] = (txBody as Record<string, unknown>)["a:p"] as unknown[] ?? [];
    for (const para of paras) {
      if (!para || typeof para !== "object") continue;
      const p = para as Record<string, unknown>;
      const runs: unknown[] = (p["a:r"] as unknown[] | undefined) ?? [];
      for (const run of runs) {
        if (!run || typeof run !== "object") continue;
        const r = run as Record<string, unknown>;
        const tArr = r["a:t"] as unknown[] | undefined;
        if (tArr && tArr.length > 0) texts.push(String(tArr[0]));
      }
      const flds: unknown[] = (p["a:fld"] as unknown[] | undefined) ?? [];
      for (const fld of flds) {
        if (!fld || typeof fld !== "object") continue;
        const f = fld as Record<string, unknown>;
        const tArr = f["a:t"] as unknown[] | undefined;
        if (tArr && tArr.length > 0) texts.push(String(tArr[0]));
      }
    }
  }

  return texts.join(" ").trim();
}

// Slide body traversal — text shapes, tables, grouped shapes.
//
// pptx2json parses slide XML via xml2js with DEFAULT options (no
// preserveChildrenOrder), so a container's children arrive grouped BY
// ELEMENT NAME and document order ACROSS shape kinds is unrecoverable here.
// Within one kind, order is preserved. Rendering order per container is
// therefore: text shapes (p:sp), then tables (p:graphicFrame), then grouped
// shapes (p:grpSp), then mc:AlternateContent branches — the closest
// approximation of reading order the parse allows.
//
// Anything that CAN carry slide text but is not extracted must surface a
// warning — a silently short slide reads as "the deck really says that
// little" and gets paid back via distrust re-probing (unzip + hand-parsing
// the slide XML).

interface SlideContent {
  lines: string[];
  warnings: string[];
}

/** xml2js run value -> string ("<a:t>x</a:t>" parses to "x"; with
 * attributes present it parses to { _: "x", $: {...} } instead). */
function textValue(v: unknown): string {
  if (v && typeof v === "object") {
    const inner = (v as Record<string, unknown>)["_"];
    return inner === undefined ? "" : String(inner);
  }
  return v === undefined ? "" : String(v);
}

/** a:p -> concatenated a:r run text (body semantics: a:fld fields are
 * collected only by the title path above, matching the historical body
 * extraction). */
function paragraphRunText(p: Record<string, unknown>): string {
  const runs: unknown[] = (p["a:r"] as unknown[] | undefined) ?? [];
  const texts: string[] = [];
  for (const run of runs) {
    if (!run || typeof run !== "object") continue;
    const tArr = (run as Record<string, unknown>)["a:t"] as unknown[] | undefined;
    if (tArr && tArr.length > 0) texts.push(textValue(tArr[0]));
  }
  return texts.join("");
}

/** txBody element (p:txBody / a:txBody) -> one trimmed line per non-empty a:p. */
function txBodyLines(txBody: unknown): string[] {
  if (!txBody || typeof txBody !== "object") return [];
  const paras: unknown[] = ((txBody as Record<string, unknown>)["a:p"] as unknown[] | undefined) ?? [];
  const lines: string[] = [];
  for (const para of paras) {
    if (!para || typeof para !== "object") continue;
    const line = paragraphRunText(para as Record<string, unknown>).trim();
    if (line) lines.push(line);
  }
  return lines;
}

/** a:tbl -> one line per a:tr with a:tc cell texts joined by " | " (a cell's
 * paragraphs are joined with a single space). All-empty rows are dropped;
 * empty cells stay in place so later columns keep their position. */
function tableLines(tbl: Record<string, unknown>): string[] {
  const rows: unknown[] = (tbl["a:tr"] as unknown[] | undefined) ?? [];
  const lines: string[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const cells: unknown[] = ((row as Record<string, unknown>)["a:tc"] as unknown[] | undefined) ?? [];
    const cellTexts: string[] = [];
    for (const cell of cells) {
      if (!cell || typeof cell !== "object") {
        cellTexts.push("");
        continue;
      }
      const txBody = ((cell as Record<string, unknown>)["a:txBody"] as unknown[] | undefined)?.[0];
      cellTexts.push(txBodyLines(txBody).join(" ").trim());
    }
    if (cellTexts.every((t) => t === "")) continue;
    lines.push(cellTexts.join(" | "));
  }
  return lines;
}

/** Disclosure label for an a:graphicData payload we do not extract. */
function graphicDataLabel(uri: string): string {
  if (uri.includes("/chart")) return "chart content not extracted";
  if (uri.includes("/diagram")) return "SmartArt diagram content not extracted";
  if (uri.toLowerCase().includes("ole")) return "embedded OLE object content not extracted";
  return `graphic content not extracted (${uri || "no graphicData uri"})`;
}

// Container children that are handled below or that carry no extractable
// slide text per ECMA-376 (p:pic and p:cxnSp have no txBody child;
// p:nvGrpSpPr / p:grpSpPr / p:extLst are structure and extension metadata).
// Any OTHER child kind is disclosed as unextracted, never silently dropped.
const HANDLED_CONTAINER_KEYS = new Set([
  "$",
  "p:sp",
  "p:graphicFrame",
  "p:grpSp",
  "p:pic",
  "p:cxnSp",
  "p:nvGrpSpPr",
  "p:grpSpPr",
  "p:extLst",
  "mc:AlternateContent",
]);

const MAX_SHAPE_DEPTH = 8;

function collectContainerContent(
  container: Record<string, unknown>,
  out: SlideContent,
  depth: number,
): void {
  if (depth > MAX_SHAPE_DEPTH) {
    out.warnings.push(
      `shape nesting deeper than ${MAX_SHAPE_DEPTH} levels; deeper content not extracted`,
    );
    return;
  }

  const shapes: unknown[] = (container["p:sp"] as unknown[] | undefined) ?? [];
  for (const shape of shapes) {
    if (!shape || typeof shape !== "object") continue;
    const txBody = ((shape as Record<string, unknown>)["p:txBody"] as unknown[] | undefined)?.[0];
    if (!txBody) continue;
    out.lines.push(...txBodyLines(txBody));
  }

  const frames: unknown[] = (container["p:graphicFrame"] as unknown[] | undefined) ?? [];
  for (const frame of frames) {
    if (!frame || typeof frame !== "object") continue;
    const graphic = ((frame as Record<string, unknown>)["a:graphic"] as unknown[] | undefined)?.[0];
    const graphicData = graphic && typeof graphic === "object"
      ? ((graphic as Record<string, unknown>)["a:graphicData"] as unknown[] | undefined)?.[0]
      : undefined;
    if (!graphicData || typeof graphicData !== "object") {
      out.warnings.push("graphic frame carries no graphicData; content not extracted");
      continue;
    }
    const gd = graphicData as Record<string, unknown>;
    const tbl = (gd["a:tbl"] as unknown[] | undefined)?.[0];
    if (tbl && typeof tbl === "object") {
      out.lines.push(...tableLines(tbl as Record<string, unknown>));
      continue;
    }
    const uri = String((gd["$"] as Record<string, string> | undefined)?.["uri"] ?? "");
    out.warnings.push(graphicDataLabel(uri));
  }

  const groups: unknown[] = (container["p:grpSp"] as unknown[] | undefined) ?? [];
  for (const group of groups) {
    if (!group || typeof group !== "object") continue;
    collectContainerContent(group as Record<string, unknown>, out, depth + 1);
  }

  // mc:AlternateContent wraps ONE logical shape as alternative renderings —
  // walk a single branch (mc:Fallback is the compatibility markup; fall back
  // to mc:Choice when absent) so the same content is never extracted twice.
  const alternates: unknown[] = (container["mc:AlternateContent"] as unknown[] | undefined) ?? [];
  for (const alt of alternates) {
    if (!alt || typeof alt !== "object") continue;
    const a = alt as Record<string, unknown>;
    const branch =
      (a["mc:Fallback"] as unknown[] | undefined)?.[0] ??
      (a["mc:Choice"] as unknown[] | undefined)?.[0];
    if (branch && typeof branch === "object") {
      collectContainerContent(branch as Record<string, unknown>, out, depth + 1);
    } else {
      out.warnings.push("unextracted shape kind 'mc:AlternateContent'");
    }
  }

  for (const key of Object.keys(container)) {
    if (!HANDLED_CONTAINER_KEYS.has(key)) {
      out.warnings.push(`unextracted shape kind '${key}'`);
    }
  }
}

// ---------------------------------------------------------------------------
// Slide traversal
// ---------------------------------------------------------------------------

interface SlideData {
  title: string;
  body: string;
  warnings: string[];
}

function extractSlide(slideJson: unknown): SlideData {
  if (!slideJson || typeof slideJson !== "object") return { title: "", body: "", warnings: [] };
  const sld = slideJson as Record<string, unknown>;
  const pSld = sld["p:sld"] as Record<string, unknown> | undefined;
  if (!pSld) return { title: "", body: "", warnings: [] };
  const cSld = (pSld["p:cSld"] as unknown[] | undefined)?.[0] as
    | Record<string, unknown>
    | undefined;
  if (!cSld) return { title: "", body: "", warnings: [] };
  const spTree = (cSld["p:spTree"] as unknown[] | undefined)?.[0] as
    | Record<string, unknown>
    | undefined;
  if (!spTree) return { title: "", body: "", warnings: [] };

  const title = extractShapeText(spTree, true);
  const content: SlideContent = { lines: [], warnings: [] };
  collectContainerContent(spTree, content, 0);
  // A slide re-using the same unhandled kind N times still gets ONE
  // disclosure entry.
  return { title, body: content.lines.join("\n").trim(), warnings: [...new Set(content.warnings)] };
}

// ---------------------------------------------------------------------------
// Public extractor
// ---------------------------------------------------------------------------

type Pptx2JsonModule = new () => {
  buffer2json(buf: Buffer): Promise<Record<string, unknown>>;
};

let pptxCache: Pptx2JsonModule | undefined;

async function getPptx2Json(): Promise<Pptx2JsonModule> {
  if (pptxCache) return pptxCache;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  pptxCache = (await import("pptx2json")).default as unknown as Pptx2JsonModule;
  return pptxCache;
}

type ParsedPptx =
  | { ok: true; slides: SlideData[]; warnings: string[] }
  | { ok: false; error: string; warnings: string[] };

/**
 * Shared pptx2json parse + slide collection, used by both extractPptx (flat
 * markdown, v1 tool) and pptxSlides (structured, artifact mode) so there is
 * exactly one buffer2json pass to maintain instead of two that could drift.
 */
async function parsePptx(bytes: Uint8Array): Promise<ParsedPptx> {
  const Pptx2Json = await getPptx2Json();
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let json: Record<string, unknown>;
  try {
    const p = new Pptx2Json();
    json = await p.buffer2json(buf);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg.slice(0, 200), warnings: [] };
  }

  const warnings: string[] = [];

  // Collect slide keys (ppt/slides/slideN.xml) in numeric order.
  const slideKeys = Object.keys(json)
    .filter((k) => k.startsWith("ppt/slides/slide") && k.endsWith(".xml"))
    .sort((a, b) => {
      const na = parseInt(a.replace(/\D/g, ""), 10);
      const nb = parseInt(b.replace(/\D/g, ""), 10);
      return na - nb;
    });

  if (slideKeys.length === 0) {
    warnings.push("No slides found in PPTX.");
  }

  const slides = slideKeys.map((key) => extractSlide(json[key]));

  // Fold per-slide disclosure warnings into the top-level list: identical
  // messages collapse to one entry naming the slides they came from.
  const slidesByMessage = new Map<string, number[]>();
  slides.forEach((slide, idx) => {
    for (const msg of slide.warnings) {
      const nums = slidesByMessage.get(msg) ?? [];
      nums.push(idx + 1);
      slidesByMessage.set(msg, nums);
    }
  });
  for (const [msg, nums] of slidesByMessage) {
    warnings.push(`${msg} (${nums.length === 1 ? "slide" : "slides"} ${nums.join(", ")})`);
  }

  return { ok: true, slides, warnings };
}

/**
 * Extract text from a .pptx file as markdown outline.
 * Lazy-loads pptx2json on first call.
 */
export async function extractPptx(bytes: Uint8Array): Promise<PptxExtractResult> {
  const parsed = await parsePptx(bytes);
  if (!parsed.ok) return parsed;

  const sections: string[] = parsed.slides.map((slideData, idx) => {
    const slideNum = idx + 1;
    const heading = slideData.title
      ? `## Slide ${slideNum}: ${slideData.title}`
      : `## Slide ${slideNum}`;
    const content = slideData.body || "(no content)";
    return `${heading}\n\n${content}`;
  });

  return { ok: true, text: sections.join("\n\n"), warnings: parsed.warnings };
}

// ---------------------------------------------------------------------------
// Artifact-mode PPTX slide extraction (v0.8) — structured per-slide sections,
// mirroring docxSections' {heading, text} shape and maxChars/truncated
// convention (office/docx.ts) so mode=artifact's docx/xlsx/pptx branches
// share one response contract. Reuses the SAME parsePptx() slide parsing as
// extractPptx above — no separate pptx2json pass.
// ---------------------------------------------------------------------------

export interface PptxSlideSection {
  heading: string;
  text: string;
}

export interface PptxSlidesResult {
  ok: true;
  slides: PptxSlideSection[];
  truncated: boolean;
  warnings: string[];
}

export async function pptxSlides(
  bytes: Uint8Array,
  opts: {
    slides?: string[];
    query?: string;
    maxChars?: number;
  } = {},
): Promise<PptxSlidesResult | { ok: false; error: string; warnings: string[] }> {
  const maxChars = opts.maxChars ?? 16_000;

  const parsed = await parsePptx(bytes);
  if (!parsed.ok) return parsed;

  const allSlides: PptxSlideSection[] = parsed.slides.map((slideData, idx) => {
    const slideNum = idx + 1;
    const heading = slideData.title ? `Slide ${slideNum}: ${slideData.title}` : `Slide ${slideNum}`;
    return { heading, text: slideData.body || "" };
  });

  // Filter by slide number (1-based, matched as a string — mirrors
  // docxSections' `sections` name filter, but against position: slides don't
  // have a stable name the way docx headings do).
  let filtered = allSlides;
  if (opts.slides && opts.slides.length > 0) {
    const wanted = new Set(opts.slides.map((s) => s.trim()));
    filtered = allSlides.filter((_, idx) => wanted.has(String(idx + 1)));
  }

  if (opts.query) {
    const queryLower = opts.query.toLowerCase();
    const queryTerms = queryLower.split(/\s+/).filter((t) => t.length > 2);
    filtered = filtered.filter((s) => {
      const combined = (s.heading + " " + s.text).toLowerCase();
      return queryTerms.some((term) => combined.includes(term));
    });
  }

  // Apply maxChars truncation — same accumulate-then-cut pattern as
  // docxSections, including the "..." suffix on the section that gets cut.
  let totalChars = 0;
  let truncated = false;
  const result: PptxSlideSection[] = [];
  for (const slide of filtered) {
    if (totalChars + slide.text.length > maxChars) {
      const remaining = maxChars - totalChars;
      if (remaining > 100) {
        result.push({ heading: slide.heading, text: slide.text.slice(0, remaining) + "..." });
      }
      truncated = true;
      break;
    }
    result.push(slide);
    totalChars += slide.text.length;
  }

  return { ok: true, slides: result, truncated, warnings: parsed.warnings };
}
