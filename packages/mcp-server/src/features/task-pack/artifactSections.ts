import type {
  ArtifactTaskPackSection,
  ArtifactTaskPackSurface,
  TaskPackResultSurface,
  TaskPackSurface,
} from "./model.js";

type SheetSection = Extract<ArtifactTaskPackSection, { sheet: string }>;

/**
 * Which of a section's rows a cut to `rowCount` keeps, and the honest range of
 * those. A plain section keeps its head. A query window keeps its anchor row, which
 * backward growth can leave at the far end of the window, so the rows a cut keeps
 * are never rows the query did not point at.
 */
function cutRows(section: SheetSection, rowCount: number, columnCount: number): { start: number; range: string } {
  const window = section.query_window;
  const firstRow = window === undefined ? undefined : Number(section.range.split("-")[0]);
  if (window === undefined || firstRow === undefined || !Number.isInteger(firstRow)) {
    return { start: 0, range: actualSheetRange(section.range, rowCount, columnCount) };
  }
  const start = Math.max(0, Math.min(window.anchor_row - firstRow, section.rows.length - rowCount));
  return { start, range: actualSheetRange(`${firstRow + start}-${firstRow + start}`, rowCount, columnCount) };
}

/**
 * A query window as a cut may keep it: a cut that narrowed a column or clipped a cell
 * has not delivered the rows it kept, so they must not be credited as delivered.
 */
function cutQueryWindow(section: SheetSection, rows: readonly unknown[][], columnCount: number, start: number): SheetSection["query_window"] {
  const window = section.query_window;
  if (window?.line_offset === undefined) return window;
  const intact = columnCount === section.columns.length
    && rows.every((row, rowIdx) => row.every((value, colIdx) => value === section.rows[start + rowIdx]?.[colIdx]));
  if (intact) return window;
  const { line_offset: _dropped, ...rest } = window;
  return rest;
}

/** The first logical row of a plain csv section, which always keeps the table's head. */
function plainCsvFirstRow(section: SheetSection): number | undefined {
  if (section.query_window !== undefined) return undefined;
  const logical = /^(\d+)-\d+$/.exec(section.range);
  return logical === null ? undefined : Number(logical[1]);
}

/** What a cut of a plain csv section must keep saying about the table it came from. */
function plainCsvTotalRows(section: SheetSection): { total_rows?: number } {
  return plainCsvFirstRow(section) === undefined ? {} : { total_rows: section.total_rows ?? section.rows.length };
}

/** A cut that narrowed a column or clipped a cell has not delivered the rows it kept. */
function keptRowsIntact(before: SheetSection, after: SheetSection): boolean {
  return after.columns.length === before.columns.length
    && after.rows.every((row, rowIdx) => row.every((value, colIdx) => value === before.rows[rowIdx]?.[colIdx]));
}

/**
 * The `range=` that reaches what `after`, a cut of the plain csv section `before`,
 * left out, through the table's last row; undefined for any other section or when
 * nothing is left. It starts after the kept rows, unless a kept row lost cells: then
 * it repeats the head, since it may repeat a row but never skips one. So does
 * `priorRange`, the range an earlier cut already sent the caller to.
 */
export function plainCsvRemainder(before: SheetSection, after: SheetSection, priorRange?: string): string | undefined {
  const first = plainCsvFirstRow(before);
  if (first === undefined) return undefined;
  const last = first + (before.total_rows ?? before.rows.length) - 1;
  const kept = keptRowsIntact(before, after) ? first + after.rows.length : first;
  const prior = priorRange === undefined ? undefined : Number(priorRange.split("-")[0]);
  const start = prior !== undefined && Number.isInteger(prior) ? Math.min(prior, kept) : kept;
  return start <= last ? `${start}-${last}` : undefined;
}

/** What a plain csv section cut to `after` says about itself; `why` names the cap. */
export function plainCsvCutNote(before: SheetSection, after: SheetSection, why: string): string {
  const total = after.total_rows ?? before.total_rows ?? before.rows.length;
  const cells = keptRowsIntact(before, after) ? "" : ", with columns or cells cut from them";
  return `inlined ${after.rows.length} of ${total} data rows${cells}${why}; fetch the rest with next`;
}

/**
 * What a pack shows of a csv it cannot carry whole: the first rows, for the table's
 * shape. A longer head rarely holds what a request is after, and it is paid again on
 * every later turn; the entry's `next` still reaches every other row. A table that
 * fits, a query window and any non-csv section pass through.
 */
export function plainCsvSample(section: ArtifactTaskPackSection, capBytes: number, maxRows: number): ArtifactTaskPackSection {
  if (!("sheet" in section) || plainCsvFirstRow(section) === undefined) return section;
  const { lookup, ...table } = section;
  if (section.truncated !== true && jsonBytes(table) <= capBytes) {
    // The rows carry the whole table, so the lookup need only say which they are.
    return lookup === undefined ? section : { ...section, lookup: { ...lookup, rows: [] } };
  }
  if (section.rows.length <= maxRows) return section;
  return {
    ...section,
    ...plainCsvTotalRows(section),
    range: actualSheetRange(section.range, maxRows, section.columns.length),
    rows: section.rows.slice(0, maxRows),
    truncated: true,
  };
}

/** What a sample says about itself. Solvers took a bare "fetch the rest" as the way to look a value up. */
export function plainCsvSampleNote(section: SheetSection): string {
  return `inlined ${section.rows.length} of ${section.total_rows ?? section.rows.length} data rows, a sample of the table's shape;`
    + " a value is quicker to find with tl_search_files, and next reads the rest in order";
}

/** Does the lookup hold what the request needs? Only then does it stand for the search it replaces. */
export function csvLookupComplete(section: ArtifactTaskPackSection): boolean {
  return "sheet" in section && section.lookup !== undefined
    && (section.lookup.counted === true || section.lookup.row_numbers.length === section.lookup.total);
}

/** What a sampled table beside a lookup says about itself. */
export function plainCsvLookupNote(section: SheetSection): string {
  const lookup = section.lookup!;
  const searched = `all ${lookup.scanned} data rows were searched, no further search is needed`;
  if (lookup.absent !== undefined) {
    const listed = lookup.column_values === undefined ? "" : "; column_values lists every value of those columns";
    return `no cell contains ${lookup.absent.join(", ")}; ${searched}${listed}`;
  }
  const held = lookup.all_of !== undefined
    ? `rows where ${Object.entries(lookup.all_of).map(([column, values]) => `${column} is ${values.join(" or ")}`).join(" and ")} (${lookup.any_total === undefined ? "no other row contains it" : `${lookup.any_total} hold any of them`})`
    : `rows containing ${lookup.terms.join(", ")}`;
  if (lookup.counted === true) {
    const whole = lookup.whole_cell_total !== undefined ? `, ${lookup.whole_cell_total} as a whole cell` : "";
    return `lookup.total counts all ${lookup.total} ${held}${whole}; ${searched}`;
  }
  return csvLookupComplete(section)
    ? `lookup.rows holds all ${lookup.total} ${held}; ${searched}`
    : `lookup.rows holds ${lookup.rows.length} of the ${lookup.total} ${held}; all ${lookup.scanned} data rows were searched; tl_search_files or next reaches the others`;
}

/** What a partial query-window section says about itself, wherever it was last cut. */
export function queryWindowSectionNote(section: SheetSection): string {
  return `rows ${section.range} of ${section.query_window?.total_rows ?? section.rows.length} data rows, chosen by query relevance rather than from the top of the file;`
    + " a partial view, so these rows alone show neither that a value is absent nor that the table is complete. next walks the whole table";
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** Keep a sheet section's advertised A1 range honest after row/column fitting. */
function actualSheetRange(range: string, rowCount: number, columnCount: number): string {
  // A csv section's range is logical data rows ("951-1000"), with the header carried
  // in `columns` and so not counted. Its own start is the first data row: the header
  // arithmetic below does not apply.
  const logicalRows = range.match(/^(\d+)-(\d+)$/);
  if (logicalRows !== null) {
    const firstRow = Number(logicalRows[1]);
    return rowCount <= 0 || columnCount <= 0 ? "" : `${firstRow}-${firstRow + rowCount - 1}`;
  }
  const match = range.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i);
  if (match === null) return range;
  const startCol = match[1]!.toUpperCase();
  const startRow = Number(match[2]);
  const endCol = (n: number): string => {
    let out = "";    for (let value = Math.max(1, n); value > 0; value = Math.floor((value - 1) / 26)) {
      out = String.fromCharCode(65 + ((value - 1) % 26)) + out;
    }
    return out;
  };
  // A zero-cell fit is a deferred section, not a one-cell section: A1:A1
  // would claim content that is absent from `rows`/`columns`. The caller keeps
  // `remaining` and emits the executable artifact continuation for this case.
  if (rowCount <= 0 || columnCount <= 0) return "";
  const startColNumber = [...startCol].reduce((total, char) => total * 26 + char.charCodeAt(0) - 64, 0);
  // `startRow` is the HEADER row (xlsxTable's range convention: header at
  // `startRow`, data from `startRow + 1`, `rows` excludes the header), so an
  // embed of `rowCount` data rows spans through `startRow + rowCount` — not
  // `+ rowCount - 1`, which under-claimed the span by the header row.
  return `${startCol}${startRow}:${endCol(startColNumber + columnCount - 1)}${startRow + rowCount}`;
}

function honestSheetSection(section: SheetSection, rowCount = section.rows.length, columnCount = section.columns.length): SheetSection {
  return { ...section, range: cutRows(section, rowCount, columnCount).range };
}

/**
 * Stable per-entry ids of an extraction, in extraction order: docx headings,
 * pptx slide headings, "page-N" for pdf, and the single logical table name for
 * a sheet-shaped (xlsx/csv) section. Used to name the entries a bounded inline
 * did NOT serve (ArtifactTaskPackSectionEntry.remaining_sections).
 */
export function artifactSectionEntryIds(section: ArtifactTaskPackSection): string[] {
  if ("sheet" in section) return [section.sheet];
  if (section.kind === "docx") return section.sections.map((item) => item.heading);
  if (section.kind === "pptx") return section.slides.map((item) => item.heading);
  return section.pages.map((item) => `page-${item.page}`);
}

/** Largest `n` in [0, hi] for which `fits(n)` holds; assumes `fits` is monotone. */
function largestFitting(hi: number, fits: (n: number) => boolean): number {
  let low = 0;
  let high = hi;
  let best = 0;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (fits(mid)) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

export interface ArtifactSectionBudgetFit {
  section: ArtifactTaskPackSection;
  /** True when entries, rows, columns, or text were cut to reach the cap. */
  partial: boolean;
  /** Ids of the extraction entries this fit does NOT carry. */
  remaining: string[];
}

/**
 * A1 — fit ONE artifact extraction into `capBytes` by serving a PREFIX of it.
 *
 * Distinct from artifactSectionCandidates(), which offers a fixed ladder of
 * whole-section size variants for the pack-cap search: this one answers "how
 * much of this extraction fits in exactly this many bytes", keeping leading
 * entries INTACT (a caller auditing a deck needs slide 1 whole, not five slides
 * clipped to 750 chars each) and naming what was left out. The first entry
 * always survives — its text is truncated if it alone exceeds the cap — so a
 * caller-named artifact never degrades back to the content-free stub this
 * feature exists to eliminate.
 */
export function fitArtifactSectionToBytes(
  section: ArtifactTaskPackSection,
  capBytes: number,
): ArtifactSectionBudgetFit {
  if (jsonBytes(section) <= capBytes) {
    // Already inside the budget. `truncated` may still be set by the extractor's
    // own char cap, which is partialness the caller must see either way.
    const rest = "sheet" in section ? plainCsvRemainder(section, section) : undefined;
    return { section, partial: section.truncated === true, remaining: rest === undefined ? [] : [`rows ${rest}`] };
  }

  if ("sheet" in section) {
    const build = (rowCount: number, colCount: number): SheetSection => {
      const start = cutRows(section, rowCount, colCount).start;
      const rows = section.rows.slice(start).slice(0, rowCount).map((row) => row.slice(0, colCount));
      const queryWindow = cutQueryWindow(section, rows, colCount, start);
      return {
        sheet: section.sheet,
        range: cutRows(section, rowCount, colCount).range,
        columns: section.columns.slice(0, colCount),
        rows,
        truncated: true,
        ...plainCsvTotalRows(section),
        ...(queryWindow ? { query_window: queryWindow } : {}),
        ...(section.lookup ? { lookup: section.lookup } : {}),
        ...(section.visuals ? { visuals: section.visuals } : {}),
      };
    };
    let colCount = section.columns.length;
    let rowCount = largestFitting(section.rows.length, (n) => jsonBytes(build(n, colCount)) <= capBytes);
    if (rowCount === 0 && section.rows.length > 0) {
      // Not even one full-width row fits — narrow the columns instead of
      // serving a header-only table.
      colCount = largestFitting(section.columns.length, (c) => jsonBytes(build(1, c)) <= capBytes);
      rowCount = colCount > 0 ? 1 : 0;
    }
    const fitted = build(rowCount, colCount);
    if (plainCsvFirstRow(section) !== undefined) {
      const rest = plainCsvRemainder(section, fitted);
      return { section: fitted, partial: true, remaining: rest === undefined ? [] : [`rows ${rest}`] };
    }
    return {
      section: fitted,
      partial: true,
      remaining: rowCount < section.rows.length
        ? [`rows ${rowCount + 1}-${section.rows.length}`]
        : [],
    };
  }

  const ids = artifactSectionEntryIds(section);
  // One shared prefix-fit over the three text-entry shapes: `pick` rebuilds the
  // section from a prefix (optionally clipping the LAST kept entry's text), so
  // the greedy loop below is written once instead of three times.
  const pick = (count: number, clipLast?: number): ArtifactTaskPackSection => {
    if (section.kind === "docx") {
      const kept = section.sections.slice(0, count);
      return {
        kind: "docx",
        sections: kept.map((item, index) =>
          clipLast !== undefined && index === kept.length - 1
            ? { ...item, text: item.text.slice(0, clipLast) }
            : item
        ),
        truncated: true,
        ...(section.visuals ? { visuals: section.visuals } : {}),
      };
    }
    if (section.kind === "pptx") {
      const kept = section.slides.slice(0, count);
      return {
        kind: "pptx",
        slides: kept.map((item, index) =>
          clipLast !== undefined && index === kept.length - 1
            ? { ...item, text: item.text.slice(0, clipLast) }
            : item
        ),
        truncated: true,
        ...(section.visuals ? { visuals: section.visuals } : {}),
      };
    }
    const kept = section.pages.slice(0, count);
    return {
      kind: "pdf",
      pages: kept.map((item, index) =>
        clipLast !== undefined && index === kept.length - 1
          ? { ...item, text: item.text.slice(0, clipLast) }
          : item
      ),
      truncated: true,
      ...(section.visuals ? { visuals: section.visuals } : {}),
    };
  };

  const entryCount = ids.length;
  const served = largestFitting(entryCount, (n) => n === 0 || jsonBytes(pick(n)) <= capBytes);
  if (served > 0) {
    return {
      section: pick(served),
      partial: true,
      remaining: ids.slice(served),
    };
  }
  // The first entry alone exceeds the cap: clip its text rather than serve a
  // content-free section. `capBytes` is always well above the JSON scaffolding,
  // so the clip length search converges on a usable body.
  const firstTextLength = section.kind === "docx"
    ? (section.sections[0]?.text.length ?? 0)
    : section.kind === "pptx"
      ? (section.slides[0]?.text.length ?? 0)
      : (section.pages[0]?.text.length ?? 0);
  const clip = largestFitting(firstTextLength, (n) => jsonBytes(pick(1, n)) <= capBytes);
  return {
    section: pick(1, clip),
    partial: true,
    remaining: ids.slice(1),
  };
}

function compactArtifactCell(value: unknown, maxChars: number): unknown {
  return typeof value === "string" && value.length > maxChars
    ? value.slice(0, maxChars)
    : value;
}

/** Largest-first bounded variants; callers choose the first one that fits the pack cap. */
export function artifactSectionCandidates(
  section: ArtifactTaskPackSection,
): ArtifactTaskPackSection[] {
  const candidates: ArtifactTaskPackSection[] = [section];
  if ("sheet" in section) {
    for (const [maxColumns, maxRows, maxChars] of [
      [24, 12, 160],
      [12, 8, 80],
      [8, 4, 64],
      [4, 2, 32],
    ] as const) {
      if (
        section.columns.length <= maxColumns
        && section.rows.length <= maxRows
        && section.rows.every((row) =>
          row.every((value) => typeof value !== "string" || value.length <= maxChars)
        )
      ) {
        continue;
      }
      const keptRows = Math.min(maxRows, section.rows.length);
      const start = cutRows(section, keptRows, maxColumns).start;
      const rows = section.rows.slice(start).slice(0, maxRows).map((row) =>
        row.slice(0, maxColumns).map((value) => compactArtifactCell(value, maxChars))
      );
      const queryWindow = cutQueryWindow(section, rows, Math.min(maxColumns, section.columns.length), start);
      candidates.push({
        ...honestSheetSection(section, keptRows, Math.min(maxColumns, section.columns.length)),
        ...plainCsvTotalRows(section),
        columns: section.columns.slice(0, maxColumns),
        rows,
        truncated: true,
        ...(queryWindow ? { query_window: queryWindow } : {}),
      });
    }
    return candidates;
  }

  for (const maxChars of [6_000, 3_000, 1_500, 750] as const) {
    if (section.kind === "docx") {
      candidates.push({
        kind: "docx",
        sections: section.sections.slice(0, maxChars >= 3_000 ? 2 : 1).map((item) => ({
          ...item,
          text: item.text.slice(0, maxChars),
        })),
        truncated: true,
        ...(section.visuals ? { visuals: section.visuals } : {}),
      });
    } else if (section.kind === "pptx") {
      candidates.push({
        kind: "pptx",
        slides: section.slides.slice(0, 1).map((item) => ({
          ...item,
          text: item.text.slice(0, maxChars),
        })),
        truncated: true,
        ...(section.visuals ? { visuals: section.visuals } : {}),
      });
    } else {
      candidates.push({
        kind: "pdf",
        pages: section.pages.slice(0, 1).map((item) => ({
          ...item,
          text: item.text.slice(0, maxChars),
        })),
        truncated: true,
        ...(section.visuals ? { visuals: section.visuals } : {}),
      });
    }
  }
  return candidates;
}

export function isArtifactTaskPackSurface(
  surface: TaskPackResultSurface,
): surface is ArtifactTaskPackSurface {
  return "kind" in surface && surface.kind === "artifact";
}

export function codeTaskPackSurfaces(
  surfaces: TaskPackResultSurface[],
): TaskPackSurface[] {
  return surfaces.filter(
    (surface): surface is TaskPackSurface => !isArtifactTaskPackSurface(surface),
  );
}
