// artifactPackBuilder — extracted implementation; imports point to the owning modules.
import * as path from "path";
import type { ArtifactBuildExtraction } from "./literalAndConcernSeeds.js";
import type { ArtifactKind } from "../model.js";
import type { ContinuationCall } from "./packBasics.js";
import type { CsvLookup } from "../../../office/csvLookup.js";
import type { DiscoveredArtifactFile } from "./packBasics2.js";
import type { MintedArtifactSurface } from "./packBasics2.js";
import type { TaskPackArgs } from "../model.js";
import type { ToolCall } from "@tokenlighten/types";
import { CSV_LOOKUP_MAX_BYTES } from "./packBasics2.js";
import { CSV_LOOKUP_MAX_ROWS } from "./packBasics2.js";
import { CSV_LOOKUP_PARTIAL_ROWS } from "./packBasics2.js";
import { CSV_LOOKUP_SECTION_OVERHEAD_BYTES } from "./packBasics2.js";
import { MAX_TASK_PACK_BYTES } from "./packBasics.js";
import { artifactQueryTokenVariants } from "../../locator/locateTaskContext.js";
import { artifactQueryTokens } from "./roleAndConcernScope2.js";
import { artifactQueryWindowEnabled } from "../../../util/flags.js";
import { beginServeCall } from "../../../state/session.js";
import { countLines } from "../../../util/countLines.js";
import { csvLookupAbsent } from "../../../office/csvLookup.js";
import { csvLookupAcrossColumns } from "../../../office/csvLookup.js";
import { csvLookupAsksCount } from "../../../office/csvLookup.js";
import { csvLookupColumnValues } from "../../../office/csvLookup.js";
import { csvLookupEnabled } from "../../../util/flags.js";
import { csvLookupProjected } from "../../../office/csvLookup.js";
import { csvLookupRows } from "../../../office/csvLookup.js";
import { csvLookupTerms } from "../../../office/csvLookup.js";
import { csvLookupWholeCells } from "../../../office/csvLookup.js";
import { csvPageModel } from "../../../office/csv.js";
import { csvQueryWindow } from "../../../office/csvWindow.js";
import { csvTable } from "../../../office/csv.js";
import { csvWindowLineOffset } from "./guideAndArtifactSurfaces2.js";
import { decodeCsvBytes } from "../../../office/csv.js";
import { discoverArtifactFiles } from "../../locator/locateTaskContext.js";
import { docxSections } from "../../../office/docx.js";
import { extractOoxmlVisualInventory } from "../../../office/ooxmlVisuals.js";
import { hasOoxmlVisualInventory } from "../../../office/ooxmlVisuals.js";
import { mustFetchPackCap } from "../../../util/mustFetch.js";
import { pdfPages } from "../../../office/pdf.js";
import { pptxSlides } from "../../../office/pptx.js";
import { preflightZip } from "../../../office/zipPreflight.js";
import { prepareOfficeDocument } from "../../../office/decrypt.js";
import { recordServedRange } from "../../../state/session.js";
import { renderOoxmlVisualInventory } from "../../../office/ooxmlVisuals.js";
import { shaOfBytes } from "../../../util/handles.js";
import { significantQueryTokens } from "./roleAndConcernScope2.js";
import { stripPathSpans } from "../../../util/queryShape.js";
import { xlsxRoster } from "../../../office/xlsx.js";
import { xlsxTable } from "../../../office/xlsx.js";

export function artifactBuildRelevance(file: DiscoveredArtifactFile, args: TaskPackArgs, query: string): number {
  const candidate = file.relPath.toLowerCase();
  const basename = path.posix.basename(candidate);
  const queryLower = query.toLowerCase();
  const queryCompact = queryLower.replace(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff]+/g, "");
  const basenameCompact = basename.replace(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff]+/g, "");
  const rawTokens = queryLower.match(/[a-z0-9]+/g)?.filter((token) => token.length >= 3) ?? [];
  const tokenPositions = new Map<string, number>();
  for (const [index, token] of rawTokens.entries()) {
    for (const variant of artifactQueryTokenVariants(token)) {
      const previous = tokenPositions.get(variant);
      if (previous === undefined || index < previous) tokenPositions.set(variant, index);
    }
  }
  let score = 0;
  for (const [token, index] of tokenPositions) {
    if (candidate.includes(token)) score += 10 + Math.max(0, 8 - index);
  }
  if (basenameCompact.length > 0 && queryCompact.includes(basenameCompact)) score += 100;
  if (args.path) {
    const requested = args.path.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
    if (candidate === requested) score += 200;
    else if (candidate.startsWith(requested.replace(/\/$/, "") + "/")) score += 50;
  }
  return score;
}

export function discoverArtifactBuildFiles(
  args: TaskPackArgs,
  query: string,
  workspace: string,
): DiscoveredArtifactFile[] {
  const found = new Map<string, DiscoveredArtifactFile>();
  for (const file of discoverArtifactFiles(workspace, { query })) found.set(file.relPath, file);
  if (args.path) {
    for (const file of discoverArtifactFiles(workspace, { path: args.path, includeAll: true })) {
      found.set(file.relPath, file);
    }
  }
  return [...found.values()].sort((a, b) =>
    artifactBuildRelevance(b, args, query) - artifactBuildRelevance(a, args, query)
      || a.relPath.localeCompare(b.relPath)
  );
}

export function relevantSheetName(
  sheets: Array<{ name: string }>,
  query: string,
): string | undefined {
  const queryLower = query.toLowerCase();
  const queryCompact = queryLower.replace(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff]+/g, "");
  let best: { name: string; score: number } | undefined;
  for (const sheet of sheets) {
    const nameLower = sheet.name.toLowerCase();
    const compact = nameLower.replace(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff]+/g, "");
    const terms = nameLower.match(/[a-z0-9\u3040-\u30ff\u3400-\u9fff]+/g) ?? [];
    const metadataPenalty = /^(?:meta|metadata|readme|cover|instructions|index|summary)$/i.test(nameLower)
      && sheets.length > 1 ? 50 : 0;
    const score = (compact.length > 0 && queryCompact.includes(compact) ? 100 : 0)
      + terms.reduce((total, term) => total + (term.length >= 2 && queryLower.includes(term) ? 10 : 0), 0);
    const adjustedScore = score - metadataPenalty;
    if (!best || adjustedScore > best.score) best = { name: sheet.name, score: adjustedScore };
  }
  return best?.name ?? sheets[0]?.name;
}

/** The rows of a named csv holding a value the request spells, or undefined when it spells none or the table was not read whole. */
export function csvSectionLookup(bytes: Uint8Array, ext: string, query: string, capBytes: number): CsvLookup | undefined {
  const model = csvPageModel(bytes, { ext });
  // A cell past the served columns was not searched, so "every row" could not be claimed.
  if (model === undefined || model.cellsDropped) return undefined;
  const request = stripPathSpans("", query);
  const terms = csvLookupTerms(model, request);
  if (terms.length === 0) {
    const absent = csvLookupAbsent(model, request);
    if (absent.length === 0) return undefined;
    const column_values = csvLookupColumnValues(model, request);
    return { terms: [], absent, ...(column_values !== undefined ? { column_values } : {}), total: 0, scanned: model.rows.length, row_numbers: [], rows: [] };
  }
  const roomBytes = Math.min(CSV_LOOKUP_MAX_BYTES, capBytes - CSV_LOOKUP_SECTION_OVERHEAD_BYTES);
  const any = csvLookupRows(model, terms, CSV_LOOKUP_MAX_ROWS, roomBytes);
  if (any.row_numbers.length === any.total) return csvLookupProjected(model, any, request);
  // Too many to list. Values of different columns may narrow them to a list that fits.
  const across = csvLookupAcrossColumns(model, terms, request, CSV_LOOKUP_MAX_ROWS, roomBytes);
  const found = across === undefined ? any : { ...across, any_total: any.total };
  if (found.row_numbers.length === found.total) return csvLookupProjected(model, found, request);
  // Still too many: the count and a few rows are what is worth paying for now.
  const partial: CsvLookup = { ...found, row_numbers: found.row_numbers.slice(0, CSV_LOOKUP_PARTIAL_ROWS), rows: found.rows.slice(0, CSV_LOOKUP_PARTIAL_ROWS) };
  if (!csvLookupAsksCount(request, model.columns) || (terms.length > 1 && across === undefined)) return partial;
  // The count answers it, so no row is worth paying for.
  const counted: CsvLookup = { ...partial, counted: true, row_numbers: [], rows: [] };
  if (across !== undefined) return counted;
  const whole = csvLookupWholeCells(model, terms);
  return { ...counted, ...(whole.total !== found.total ? { whole_cell_total: whole.total } : whole.column !== undefined ? { all_of: { [whole.column]: terms } } : {}) };
}

export async function extractArtifactBuildSection(
  artifact: MintedArtifactSurface,
  query: string,
  /** A3: the bytes a query-relevant csv window may use. Only the surface inliner passes it; artifact_build's own ladder keeps the head. */
  options: { csvQueryWindowBytes?: number; workspace?: string } = {},
): Promise<ArtifactBuildExtraction> {
  const artifactPath = artifact.surface.path;
  const artifactCall = (selection: ToolCall["arguments"] = {}): ContinuationCall => ({
    tool: "tl_read_file",
    arguments: {
      mode: "artifact",
      path: artifactPath,
      ...(artifact.credentialRef !== undefined ? { credentialRef: artifact.credentialRef } : {}),
      ...selection,
    },
  });
  const baseNext = artifactCall();
  const maxChars = mustFetchPackCap(MAX_TASK_PACK_BYTES);
  let artifactBytes: Uint8Array = artifact.bytes;

  if (
    artifact.surface.artifactKind === "xlsx"
    || artifact.surface.artifactKind === "docx"
    || artifact.surface.artifactKind === "pptx"
  ) {
    const prepared = await prepareOfficeDocument(
      artifact.bytes,
      artifact.credentialPassword,
    );
    if (!prepared.ok) return { next: baseNext };
    artifactBytes = prepared.bytes;
    // Mandatory OOXML container preflight (CWE-400/409): this is the third
    // entry point into the office parsers besides mode=artifact and
    // extract_office_text, and it must not hand un-preflighted bytes to any
    // of them. On refusal the pack degrades to the mode=artifact next call,
    // which reports the exceeded limit as a structured error.
    const containerPreflight = await preflightZip(artifactBytes);
    if (!containerPreflight.ok) return { next: baseNext };
  }

  const officeArtifactKind = artifact.surface.artifactKind === "xlsx"
    || artifact.surface.artifactKind === "docx"
    || artifact.surface.artifactKind === "pptx"
    ? artifact.surface.artifactKind
    : undefined;
  const visualInventory = officeArtifactKind
    && /\b(?:chart|graph|image|video|media|visual|caption|series|category|alt[ -]?text)\b|グラフ|チャート|画像|動画|図表|図形|図|代替テキスト|系列|カテゴリ/i.test(query)
    ? await extractOoxmlVisualInventory(artifactBytes, officeArtifactKind, { preflighted: true })
    : undefined;
  const visualFields = visualInventory && hasOoxmlVisualInventory(visualInventory)
    ? { visuals: visualInventory }
    : {};

  if (artifact.surface.artifactKind === "xlsx") {
    const roster = await xlsxRoster(artifactBytes);
    if (!roster.ok) return { next: baseNext };
    const sheet = relevantSheetName(roster.sheets, query);
    if (!sheet) {
      if (!visualInventory || !hasOoxmlVisualInventory(visualInventory)) return { next: baseNext };
      return {
        section: {
          sheet: "Visual inventory",
          range: "",
          columns: [],
          rows: [],
          truncated: visualInventory.truncated,
          ...visualFields,
        },
        sectionId: "Visual inventory",
        next: baseNext,
      };
    }
    const next = artifactCall({ sheet, as: "json" });
    const table = await xlsxTable(artifactBytes, { sheet, as: "json" });
    if (!table.ok) return { next };
    return {
      section: {
        sheet: table.sheet,
        range: table.range,
        columns: table.columns,
        rows: table.rows,
        truncated: table.truncated || visualInventory?.truncated === true,
        ...visualFields,
      },
      sectionId: table.sheet,
      next,
    };
  }

  if (artifact.surface.artifactKind === "docx") {
    let extracted = await docxSections(artifactBytes, { query, maxChars });
    if (
      extracted.ok
      && extracted.sections.reduce((total, section) => total + section.text.trim().length, 0) < 80
    ) {
      extracted = await docxSections(artifactBytes, { maxChars });
    }
    if (!extracted.ok) return { next: baseNext };
    if (extracted.sections.length === 0) {
      const visualText = visualInventory ? renderOoxmlVisualInventory(visualInventory) : "";
      if (!visualText) return { next: baseNext };
      extracted.sections.push({ heading: "Visual inventory", text: visualText });
    }
    const terms = significantQueryTokens(query);
    const ranked = [...extracted.sections].sort((a, b) => {
      const score = (section: { heading: string; text: string }): number => {
        const combined = `${section.heading} ${section.text}`.toLowerCase();
        const matches = terms.reduce(
          (total, term) => total + (combined.includes(term.toLowerCase()) ? 1 : 0),
          0,
        );
        const titleOnlyPenalty = section.text.trim().length < 80 ? 20 : 0;
        const preamblePenalty = section.heading === "(Preamble)" ? 5 : 0;
        return matches * 10 + Math.min(section.text.trim().length, 1_000) / 100
          - titleOnlyPenalty - preamblePenalty;
      };
      return score(b) - score(a);
    });
    const sectionId = ranked[0]!.heading;
    return {
      section: {
        kind: "docx",
        sections: ranked,
        truncated: extracted.truncated || visualInventory?.truncated === true,
        ...visualFields,
      },
      sectionId,
      next: artifactCall({ sections: [sectionId] }),
    };
  }

  if (artifact.surface.artifactKind === "pptx") {
    let extracted = await pptxSlides(artifactBytes, { query, maxChars });
    if (
      extracted.ok
      && extracted.slides.reduce((total, slide) => total + slide.text.trim().length, 0) < 80
    ) {
      // Same fallback the docx branch above already has, and for the same
      // reason: pptxSlides DROPS every slide whose text shares no term with the
      // query, so a caller-named deck written in different vocabulary than the
      // request ("What does the deck say about X?" against slides that never use
      // the request's connective words) extracted to nothing and the pack fell
      // back to a content-free stub. Re-extract unfiltered instead.
      extracted = await pptxSlides(artifactBytes, { maxChars });
    }
    if (!extracted.ok) return { next: baseNext };
    if (extracted.slides.length === 0) {
      const visualText = visualInventory ? renderOoxmlVisualInventory(visualInventory) : "";
      if (!visualText) return { next: baseNext };
      extracted.slides.push({ heading: "Visual inventory", text: visualText });
    }
    const sectionId = extracted.slides[0]!.heading;
    const slide = sectionId.match(/^Slide\s+(\d+)/)?.[1];
    return {
      section: {
        kind: "pptx",
        slides: extracted.slides,
        truncated: extracted.truncated || visualInventory?.truncated === true,
        ...visualFields,
      },
      sectionId,
      next: slide ? artifactCall({ slides: [slide] }) : baseNext,
    };
  }

  if (artifact.surface.artifactKind === "csv") {
    // csv/tsv is a single table — reuse the xlsx sheet-shaped section so it
    // flows through the identical bounded-candidate machinery
    // (artifactSectionCandidates' "sheet" in section table path, meaningful(),
    // fitArtifactSections). `sheet` carries the file basename as the logical
    // table name; `ext` forces the tab delimiter for .tsv inside csvTable.
    const sectionId = path.posix.basename(artifactPath);
    if (options.csvQueryWindowBytes !== undefined && artifactQueryWindowEnabled()) {
      const model = csvPageModel(artifact.bytes, { ext: artifact.file.ext });
      // The section's JSON scaffolding beside its rows; the fit trims any excess.
      const room = options.csvQueryWindowBytes - Buffer.byteLength(JSON.stringify({ sheet: sectionId, columns: model?.columns ?? [] }), "utf8") - 128;
      const window = model === undefined ? undefined : csvQueryWindow(model, artifactQueryTokens(query), room, 200);
      if (model !== undefined && window !== undefined) {
        const windowed = csvTable(artifact.bytes, {
          ext: artifact.file.ext,
          range: `${model.firstDataRow + window.startIdx}-${model.firstDataRow + window.endIdx - 1}`,
          maxRows: window.endIdx - window.startIdx,
        });
        if (windowed.ok && windowed.columns.length > 0) {
          const lineOffset = csvWindowLineOffset(model, window);
          if (lineOffset !== undefined && options.workspace !== undefined) {
            // Staged only: the settle keeps just the rows the finished reply still carries in full.
            const first = model.dataSpans[window.startIdx]![0];
            const last = model.dataSpans[window.endIdx - 1]![1];
            recordServedRange(options.workspace, artifactPath, shaOfBytes(artifact.bytes), first, last, Math.max(countLines(decodeCsvBytes(artifact.bytes)), last), {
              mode: "task_pack",
              range: `${first}-${last}`,
              call: beginServeCall(options.workspace),
            });
          }
          return {
            section: {
              sheet: sectionId,
              range: windowed.range,
              columns: windowed.columns,
              rows: windowed.rows,
              truncated: window.endIdx - window.startIdx < model.rows.length,
              query_window: {
                selected_by: "query",
                total_rows: model.rows.length,
                anchor_row: model.firstDataRow + window.anchorIdx,
                ...(lineOffset !== undefined ? { line_offset: lineOffset } : {}),
              },
            },
            sectionId,
            next: baseNext,
          };
        }
      }
    }
    const table = csvTable(artifact.bytes, { ext: artifact.file.ext });
    if (!table.ok || table.columns.length === 0) return { next: baseNext };
    const lookup = options.csvQueryWindowBytes !== undefined && csvLookupEnabled()
      ? csvSectionLookup(artifact.bytes, artifact.file.ext, query, options.csvQueryWindowBytes)
      : undefined;
    return {
      section: {
        sheet: sectionId,
        range: table.range,
        columns: table.columns,
        rows: table.rows,
        truncated: table.truncated,
        ...(table.truncated ? { total_rows: table.total_rows } : {}),
        ...(lookup !== undefined ? { lookup } : {}),
      },
      sectionId,
      next: baseNext,
    };
  }

  let extracted = await pdfPages(artifact.bytes, {
    query,
    maxChars,
    ...(artifact.credentialPassword !== undefined
      ? { password: artifact.credentialPassword }
      : {}),
  });
  if (
    extracted.ok
    && extracted.pages.reduce((total, page) => total + page.text.trim().length, 0) < 80
  ) {
    // Same query-filter fallback as the docx/pptx branches above.
    extracted = await pdfPages(artifact.bytes, {
      maxChars,
      ...(artifact.credentialPassword !== undefined
        ? { password: artifact.credentialPassword }
        : {}),
    });
  }
  if (!extracted.ok || extracted.pages.length === 0) return { next: baseNext };
  const sectionId = `page-${extracted.pages[0]!.page}`;
  return {
    section: { kind: "pdf", pages: extracted.pages, truncated: extracted.truncated },
    sectionId,
    next: artifactCall({ pages: [String(extracted.pages[0]!.page)] }),
  };
}

export const ARTIFACT_KIND_MARKERS: ReadonlyArray<{
  kind: ArtifactKind;
  markers: readonly RegExp[];
}> = [
  { kind: "xlsx", markers: [/\bxlsx\b/i, /\bexcel\b/i, /\bspreadsheet\b/i, /\bworkbook\b/i] },
  { kind: "docx", markers: [/\bdocx\b/i, /\bword document\b/i] },
  { kind: "pptx", markers: [/\bpptx\b/i, /\bpowerpoint\b/i, /\bslide deck\b/i] },
  { kind: "pdf", markers: [/\bpdf\b/i] },
  { kind: "csv", markers: [/\bcsv\b/i, /\btsv\b/i, /\bcomma-separated\b/i, /\btab-separated\b/i] },
];

export function requestedArtifactKinds(query: string): ArtifactKind[] {
  return ARTIFACT_KIND_MARKERS
    .map(({ kind, markers }) => ({
      kind,
      index: Math.min(...markers.map((marker) => query.search(marker)).filter((index) => index >= 0)),
    }))
    .filter((entry) => Number.isFinite(entry.index))
    .sort((a, b) => a.index - b.index)
    .map(({ kind }) => kind)
    .slice(0, 2);
}

/**
 * B2f (2026-08-01 serving-completeness): does this artifact's own NAME carry a
 * token the query used — i.e. is it an input axis the request explicitly named?
 *
 * Deliberately narrower than artifactBuildRelevance: only query-token ↔ filename
 * evidence counts (no args.path boost, no kind priors), so the test says exactly
 * "the request named this file's subject", never "this file ranked well".
 */
export function artifactNamedByQuery(file: DiscoveredArtifactFile, query: string): boolean {
  // Match the file's OWN name, extension stripped. Neither the containing
  // directory ("docs/") nor the extension ("xlsx") identifies an input axis —
  // both are shared by every sibling artifact, so including them would make any
  // query that says "xlsx" pull in every workbook in the tree.
  const lower = file.relPath.toLowerCase();
  const stem = path.posix.basename(lower).replace(/\.[^.]+$/, "");
  if (stem.length === 0) return false;
  const stemCompact = stem.replace(/[^a-z0-9぀-ヿ㐀-鿿]+/g, "");
  const queryLower = query.toLowerCase();
  const queryCompact = queryLower.replace(/[^a-z0-9぀-ヿ㐀-鿿]+/g, "");
  if (stemCompact.length > 0 && queryCompact.includes(stemCompact)) return true;
  // A token that also names one of this file's own FOLDERS is describing where
  // the file lives, not which axis it is ("the design DOCX" points at docs/
  // design/, and must not promote docs/design/system-design.docx over the
  // methodology doc already selected for that kind).
  const directorySegments = new Set(path.posix.dirname(lower).split("/").filter(Boolean));
  const rawTokens = queryLower.match(/[a-z0-9]+/g)?.filter((token) => token.length >= 3) ?? [];
  for (const token of rawTokens) {
    if (directorySegments.has(token)) continue;
    for (const variant of artifactQueryTokenVariants(token)) {
      if (variant.length >= 3 && !directorySegments.has(variant) && stem.includes(variant)) return true;
    }
  }
  return false;
}
