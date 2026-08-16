// XLSX extractor — exceljs wrapper for @tokenlighten/mcp-server.
//
// NOTE: The task spec says "exceljs (NOT SheetJS)" for v0.1. The proto/ used
// SheetJS (xlsx package); this implementation uses exceljs instead per spec.
// Output is PLAIN markdown text: no meta envelope, no 'tokenlighten:meta' wrappers.
// Reason: docs/00-postmortem.md §2.2 — meta envelope dominated cache_write cost.
//
// Per sheet: structured mode (default) returns sheet roster, headers, sample rows,
// cell types, and range. Old full-table rendering available via structured:false.
// Includes dimension guard: sheets claiming more than MAX_PREVIEW_CELLS are skipped.

export type XlsxExtractResult =
  | { ok: true; text: string; warnings: string[] }
  | { ok: false; error: string; warnings: string[] };

const MAX_ROWS = 200;
const MAX_COLS = 50;
const MAX_PREVIEW_CELLS = 1_000_000;
const MAX_SAMPLE_ROWS = 5;
// Widest column span a caller range may select. Span-based (not absolute) so
// far-right selections like "BA1:BZ9" stay legal; without this, a range such
// as "A1:ZZZZZZZZ1" drives the header loop through ~2e11 columns before the
// maxCells check (which only ever shrinks rows) can intervene (CWE-400).
export const MAX_RANGE_COL_SPAN = 1_000;

// ---------------------------------------------------------------------------
// CWE-400/409 caller-value hard clamp (TL-V0.9-RELEASE-STRATEGY-2026-08-12.md
// §6.6-2 item 3, shipped 2026-08-13): xlsxTable's maxRows/maxCells used to
// pass straight through from the caller (`opts.maxRows ?? 200`) with no
// ceiling — server.ts forwards `args["maxRows"]`/`args["maxCells"]` (a raw
// caller JSON number, gated only by `typeof === "number"`, so e.g. 1e12 or a
// literal large enough to parse to Infinity passes straight through) with no
// schema validation. `maxCols` is NOT a caller-settable option on this
// function (no such field exists on its opts type) — only MAX_COLS, an
// internal constant, bounds columns — so there is no third knob to clamp.
//
// Ceilings are picked relative to this file's OWN existing internal
// constants: MAX_ROWS_CEILING gives 50x headroom over the 200-row default
// (no known caller, internal or external, ever asks for more than a few
// hundred); MAX_CELLS_CEILING reuses MAX_PREVIEW_CELLS verbatim — the same
// "too many cells to preview" threshold extractXlsx's own dimension guard
// already enforces elsewhere in this file.
//
// Zero is deliberately NOT sanitized to a default here — it is independently
// safe (produces the smallest possible response, never a resource-exhaustion
// vector: neither maxRows nor maxCells is ever used as a divisor below) and
// office/csv.ts's sibling caller (server.ts's serveBoundedCsvArtifact) sends
// its own maxRows:0 on purpose as a final "columns/totals only, no rows"
// fallback rung — csvTable's matching clamp preserves that. Kept symmetric
// here even though no xlsx call site currently sends 0. Only non-finite/
// negative values (genuine garbage, no coherent meaning) fall back to the
// default.
//
// Exported so callerValueClamps.spec.ts can pin the exact ceiling numbers
// directly — proving the 10,000-row/1,000,000-cell ceilings through
// xlsxTable's real worksheet-row path would need an implausibly large
// in-memory workbook fixture.
export function clampTableCount(value: number | undefined, fallback: number, ceiling: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return fallback;
  return value > ceiling ? ceiling : value;
}

const MAX_ROWS_CEILING = 10_000;
const MAX_CELLS_CEILING = MAX_PREVIEW_CELLS;

// Lazy-loaded exceljs to keep cold-start fast.
type ExcelJsCellValue =
  | null
  | undefined
  | string
  | number
  | boolean
  | Date
  | { formula: string; result?: unknown }
  | { text: string };

type ExcelJsWorkbook = {
  xlsx: { load(buffer: Buffer): Promise<void> };
  worksheets: Array<{
    name: string;
    state: string;
    rowCount: number;
    columnCount: number;
    getRow(r: number): {
      values: Array<ExcelJsCellValue>;
      // "Number of non-empty cells" per exceljs's own Row.actualCellCount
      // doc comment — used by xlsxRoster to size sheets for the
      // pickLargestSheetByCells inline pick (roster-tax fix, see below).
      actualCellCount: number;
    };
  }>;
};

type ExcelJsModule = {
  Workbook: new () => ExcelJsWorkbook;
};

let excelCache: ExcelJsModule | undefined;

async function getExcelJs(): Promise<ExcelJsModule> {
  if (excelCache) return excelCache;
  const mod = await import("exceljs");
  // exceljs is a CommonJS module — under ESM dynamic import its constructors
  // live on the .default property, not the namespace object itself.
  const resolved = (mod as { default?: ExcelJsModule } & ExcelJsModule);
  excelCache = (resolved.Workbook ? resolved : resolved.default) as ExcelJsModule;
  return excelCache;
}

// ---------------------------------------------------------------------------
// Type inference helpers
// ---------------------------------------------------------------------------

/**
 * Infer cell type from an exceljs raw value.
 * Returns: "null" | "number" | "boolean" | "date" | "string" | "formula(<type>)"
 */
function inferCellType(v: ExcelJsCellValue): string {
  if (v === null || v === undefined) return "null";
  if (v instanceof Date) return "date";
  if (typeof v === "number") return "number";
  if (typeof v === "boolean") return "boolean";
  // exceljs formula cell: { formula: string, result?: unknown }
  if (typeof v === "object" && "formula" in (v as object)) {
    const fv = v as { formula: string; result?: unknown };
    const rt = inferCellType(fv.result as ExcelJsCellValue);
    return `formula(${rt})`;
  }
  // exceljs rich-text cell: { text: string }
  if (typeof v === "object" && "text" in (v as object)) return "string";
  return "string";
}

/**
 * Render a cell value as a plain string for table display.
 */
function cellToString(v: ExcelJsCellValue): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object" && "formula" in (v as object)) {
    const fv = v as { formula: string; result?: unknown };
    return fv.result !== undefined ? String(fv.result) : "";
  }
  if (typeof v === "object" && "text" in (v as object)) {
    return String((v as { text: unknown }).text ?? "");
  }
  return String(v);
}

/**
 * Convert a 1-based column index to an Excel column letter (A, B, …, Z, AA, …).
 */
function colLetter(n: number): string {
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// ---------------------------------------------------------------------------
// Structured output renderer
// ---------------------------------------------------------------------------

function renderStructured(
  name: string,
  rows: ExcelJsCellValue[][],
  effectiveCols: number,
  actualRowCount: number,
  actualColCount: number,
): string {
  const parts: string[] = [];

  // Section heading
  parts.push(`### ${name}`);

  // Header row
  const headerRow = rows[0] ?? [];
  const headerCells = Array.from({ length: effectiveCols }, (_, i) =>
    cellToString(headerRow[i] ?? null),
  );
  parts.push(`Headers: ${headerCells.join(", ")}`);

  // Sample rows (rows 2–6, i.e. index 1–5)
  const sampleRows = rows.slice(1, 1 + MAX_SAMPLE_ROWS);
  if (sampleRows.length > 0) {
    // Build a small markdown table
    const sep = headerCells.map(() => "---");
    const mdHeader = `| ${headerCells.join(" | ")} |`;
    const mdSep = `| ${sep.join(" | ")} |`;
    const mdBody = sampleRows.map((r) => {
      const cells = Array.from({ length: effectiveCols }, (_, i) =>
        cellToString(r[i] ?? null),
      );
      return `| ${cells.join(" | ")} |`;
    });
    parts.push(`Sample rows:\n${[mdHeader, mdSep, ...mdBody].join("\n")}`);
  }

  // Cell types inferred from first sample row (row 2, index 1)
  const firstDataRow = rows[1] ?? [];
  const typeEntries: string[] = [];
  for (let i = 0; i < effectiveCols; i++) {
    const colName = headerCells[i] || colLetter(i + 1);
    const t = inferCellType(firstDataRow[i] ?? null);
    typeEntries.push(`${colName}: ${t}`);
  }
  if (typeEntries.length > 0) {
    parts.push(`Cell types: ${typeEntries.join(", ")}`);
  }

  // Range
  const lastCol = colLetter(Math.min(actualColCount, MAX_COLS));
  if (actualRowCount <= MAX_ROWS) {
    parts.push(`Range: A1:${lastCol}${actualRowCount}`);
  } else {
    parts.push(`Range: A1:${lastCol}${MAX_ROWS} (truncated from ${actualRowCount})`);
  }

  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Public extractor
// ---------------------------------------------------------------------------

export interface XlsxExtractOptions {
  /** Use structured output (default: true). Set false for full markdown table mode. */
  structured?: boolean;
}

/**
 * Extract text from a .xlsx file.
 * Default mode is structured output (sheet roster + headers + sample rows + cell types + range).
 * Pass structured:false for the old full-table rendering.
 * Lazy-loads exceljs on first call.
 */
export async function extractXlsx(
  bytes: Uint8Array,
  options: XlsxExtractOptions = {},
): Promise<XlsxExtractResult> {
  const { structured = true } = options;

  const ExcelJs = await getExcelJs();
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const wb = new ExcelJs.Workbook();
  try {
    await wb.xlsx.load(buf);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg.slice(0, 200), warnings: [] };
  }

  const warnings: string[] = [];
  const sections: string[] = [];
  const rosterEntries: string[] = [];

  // Collect per-sheet data first (need for roster)
  type SheetData = {
    name: string;
    rows: ExcelJsCellValue[][];
    effectiveCols: number;
    actualRowCount: number;
    actualColCount: number;
  };
  const sheetDataList: SheetData[] = [];

  for (const ws of wb.worksheets) {
    // Skip hidden sheets.
    if (ws.state === "hidden" || ws.state === "veryHidden") {
      warnings.push(`Hidden sheet skipped: ${ws.name}`);
      continue;
    }

    // Dimension guard: protect against sheets claiming enormous ranges.
    const claimedCells = ws.rowCount * ws.columnCount;
    if (claimedCells > MAX_PREVIEW_CELLS) {
      warnings.push(
        `Sheet "${ws.name}" claims ${claimedCells} cells (>${MAX_PREVIEW_CELLS}); skipped.`,
      );
      continue;
    }

    const rows: ExcelJsCellValue[][] = [];
    const effectiveRows = Math.min(ws.rowCount, MAX_ROWS);
    let effectiveCols = Math.min(ws.columnCount, MAX_COLS);

    for (let r = 1; r <= effectiveRows; r++) {
      const row = ws.getRow(r);
      // exceljs row.values is 1-indexed; index 0 is undefined.
      const vals = Array.from(row.values as ExcelJsCellValue[]).slice(1, effectiveCols + 1);
      // Update effective cols based on actual data.
      if (vals.length > effectiveCols) effectiveCols = Math.min(vals.length, MAX_COLS);
      rows.push(vals);
    }

    if (rows.length === 0) continue;

    if (ws.rowCount > MAX_ROWS || ws.columnCount > MAX_COLS) {
      warnings.push(
        `Sheet "${ws.name}" truncated to ${MAX_ROWS} rows × ${MAX_COLS} cols.`,
      );
    }

    sheetDataList.push({
      name: ws.name,
      rows,
      effectiveCols,
      actualRowCount: ws.rowCount,
      actualColCount: ws.columnCount,
    });
  }

  if (structured) {
    // Sheet roster
    for (const sd of sheetDataList) {
      rosterEntries.push(`- ${sd.name} (${sd.actualRowCount} × ${sd.actualColCount})`);
    }
    if (rosterEntries.length > 0) {
      sections.push(`## Sheets\n\n${rosterEntries.join("\n")}`);
    }

    // Per-sheet structured sections
    for (const sd of sheetDataList) {
      sections.push(
        renderStructured(sd.name, sd.rows, sd.effectiveCols, sd.actualRowCount, sd.actualColCount),
      );
    }
  } else {
    // Old full-table rendering
    for (const sd of sheetDataList) {
      const header = sd.rows[0]?.map((v) => cellToString(v)) ?? [];
      const sep = header.map(() => "---");
      const mdRows = [
        `| ${header.join(" | ")} |`,
        `| ${sep.join(" | ")} |`,
        ...sd.rows.slice(1).map((r) => `| ${r.map((v) => cellToString(v)).join(" | ")} |`),
      ];
      sections.push(`## Sheet: ${sd.name}\n\n${mdRows.join("\n")}`);
    }
  }

  return { ok: true, text: sections.join("\n\n"), warnings };
}

// ---------------------------------------------------------------------------
// Artifact-mode XLSX reads (v0.7)
// ---------------------------------------------------------------------------

export interface XlsxRosterEntry {
  name: string;
  dimensions: string;
  hidden: boolean;
  rowCount: number;
  colCount: number;
  /**
   * Count of non-empty cells in this sheet (sum of each row's exceljs
   * `actualCellCount`) — a general, content-based size measure used by
   * pickLargestSheetByCells to decide which sheet is worth inlining on a
   * no-`sheet` mode=artifact roster call (see server.ts's xlsx artifact
   * branch). Deliberately NOT `rowCount * colCount`: those are CLAIMED
   * dimensions (can include formatting/leftover ranges far beyond the real
   * data — see the MAX_PREVIEW_CELLS guard below), so a sparse-but-wide
   * sheet must not out-rank the sheet actually holding the data.
   * Bounded by the same MAX_PREVIEW_CELLS guard extractXlsx uses: a sheet
   * CLAIMING more cells than that guard reports 0 here rather than paying
   * for a full row scan — such a sheet is already excluded from real data
   * reads elsewhere in this file, so it must not be picked as "largest" either.
   */
  cellCount: number;
}

export interface XlsxRosterResult {
  ok: true;
  sheets: XlsxRosterEntry[];
  warnings: string[];
}

export async function xlsxRoster(bytes: Uint8Array): Promise<XlsxRosterResult | { ok: false; error: string; warnings: string[] }> {
  const ExcelJs = await getExcelJs();
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const wb = new ExcelJs.Workbook();
  try {
    await wb.xlsx.load(buf);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg.slice(0, 200), warnings: [] };
  }

  const sheets: XlsxRosterEntry[] = [];
  const warnings: string[] = [];

  for (const ws of wb.worksheets) {
    const hidden = ws.state === "hidden" || ws.state === "veryHidden";
    if (hidden) warnings.push(`Sheet "${ws.name}" is hidden.`);
    const lastCol = colLetter(Math.min(ws.columnCount, MAX_COLS));

    // Non-empty cell count (see XlsxRosterEntry.cellCount doc comment).
    // Guarded by the SAME claimed-cells cap used elsewhere in this file —
    // exceljs already parsed every row into memory during wb.xlsx.load()
    // above, so summing each row's actualCellCount here is a cheap
    // in-memory pass (no re-parse), except for a sheet claiming an
    // enormous range, which is skipped just like extractXlsx's guard.
    const claimedCells = ws.rowCount * ws.columnCount;
    let cellCount = 0;
    if (claimedCells > 0 && claimedCells <= MAX_PREVIEW_CELLS) {
      for (let r = 1; r <= ws.rowCount; r++) {
        cellCount += ws.getRow(r).actualCellCount;
      }
    }

    sheets.push({
      name: ws.name,
      dimensions: `A1:${lastCol}${ws.rowCount}`,
      hidden,
      rowCount: ws.rowCount,
      colCount: ws.columnCount,
      cellCount,
    });
  }

  return { ok: true, sheets, warnings };
}

/**
 * Pick the sheet with the most non-empty cells — the general, content-based
 * heuristic mode=artifact's no-`sheet` roster call uses to decide which
 * sheet's data is worth inlining for free (DESIGN note: bench task T10 found
 * a no-`sheet` artifact call cost >=2 round trips per workbook — a roster,
 * then a follow-up `sheet=` call — even though the largest sheet's data was
 * already sitting in the SAME parsed workbook; see server.ts's xlsx artifact
 * branch for the caller).
 *
 * Pure and dependency-free (plain data in, a name or undefined out) so it is
 * unit-testable without ever loading a real workbook. Deliberately carries
 * NO sheet-name logic of any kind — filename/task-specific heuristics (e.g.
 * penalizing sheets named "meta"/"readme") belong to a DIFFERENT, unrelated
 * feature (readCodeTaskPack.ts's query-relevance ranking), not here. Ties
 * keep the FIRST entry (stable — caller-supplied order, typically roster/
 * sheet order); an empty list returns undefined.
 */
export function pickLargestSheetByCells(
  sheets: readonly { name: string; cellCount: number }[],
): string | undefined {
  let best: { name: string; cellCount: number } | undefined;
  for (const s of sheets) {
    if (best === undefined || s.cellCount > best.cellCount) best = s;
  }
  return best?.name;
}

export interface XlsxTableResult {
  ok: true;
  sheet: string;
  range: string;
  columns: string[];
  /**
   * DESIGN-v0.8 C10.3: rows are POSITIONAL TUPLES aligned with `columns` —
   * `rows[i][j]` is the value for `columns[j]` in row i. Previously each row
   * was an object keyed by column name, which repeated every column name in
   * every row (~2.9x bloat) despite `columns` already carrying that roster
   * once. A consumer reconstructs a keyed row with
   * `Object.fromEntries(columns.map((c, j) => [c, row[j]]))` if it needs one.
   */
  rows: unknown[][];
  truncated: boolean;
  warnings: string[];
}

export async function xlsxTable(
  bytes: Uint8Array,
  opts: {
    sheet?: string;
    range?: string;
    rowRange?: [number, number];
    columns?: string[];
    maxRows?: number;
    maxCells?: number;
    as?: "json" | "markdown";
  } = {},
): Promise<XlsxTableResult | { ok: false; error: string; warnings: string[] }> {
  const maxRows = clampTableCount(opts.maxRows, 200, MAX_ROWS_CEILING);
  const maxCells = clampTableCount(opts.maxCells, 10_000, MAX_CELLS_CEILING);

  const ExcelJs = await getExcelJs();
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const wb = new ExcelJs.Workbook();
  try {
    await wb.xlsx.load(buf);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg.slice(0, 200), warnings: [] };
  }

  const warnings: string[] = [];

  // Find the target sheet
  let ws = wb.worksheets[0];
  if (opts.sheet) {
    const found = wb.worksheets.find((w) => w.name === opts.sheet);
    if (!found) {
      return { ok: false, error: `Sheet "${opts.sheet}" not found. Available: ${wb.worksheets.map((w) => w.name).join(", ")}`, warnings: [] };
    }
    ws = found;
  }

  if (!ws) {
    return { ok: false, error: "Workbook has no sheets.", warnings: [] };
  }

  // Skip hidden sheets unless explicitly requested
  if ((ws.state === "hidden" || ws.state === "veryHidden") && !opts.sheet) {
    warnings.push(`Sheet "${ws.name}" is hidden; skipped. Request by name to read it.`);
    return { ok: false, error: `Default sheet "${ws.name}" is hidden. Specify sheet name explicitly.`, warnings };
  }

  // Determine row/col bounds
  let startRow = 1;
  let endRow = Math.min(ws.rowCount, maxRows);
  let startCol = 1;
  let endCol = Math.min(ws.columnCount, MAX_COLS);

  // Parse range if provided (e.g., "A1:D120")
  if (opts.range) {
    const rangeMatch = opts.range.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i);
    if (rangeMatch) {
      startCol = colNumber(rangeMatch[1]!);
      startRow = parseInt(rangeMatch[2]!, 10);
      endCol = colNumber(rangeMatch[3]!);
      endRow = parseInt(rangeMatch[4]!, 10);
    }
  }

  if (opts.rowRange) {
    startRow = opts.rowRange[0];
    endRow = opts.rowRange[1];
  }

  // Fully out-of-bounds row requests return no cells; overlapping rows clamp at EOF.
  // Keep the existing span-based far-right column contract unchanged.
  if (ws.rowCount === 0 || ws.columnCount === 0 || startRow > ws.rowCount) {
    return { ok: true, sheet: ws.name, range: `${colLetter(Math.max(1, startCol))}${Math.max(1, startRow)}:${colLetter(Math.max(1, endCol))}${Math.max(1, endRow)}`, columns: [], rows: [], truncated: true, warnings };
  }
  if (startRow >= 1 && startRow <= ws.rowCount && endRow > ws.rowCount) {
    endRow = ws.rowCount;
  }

  if (endCol - startCol + 1 > MAX_RANGE_COL_SPAN) {
    warnings.push(`Columns truncated to ${MAX_RANGE_COL_SPAN}.`);
    endCol = startCol + MAX_RANGE_COL_SPAN - 1;
  }

  // Apply maxRows cap
  if (endRow - startRow + 1 > maxRows) {
    warnings.push(`Rows truncated to ${maxRows}.`);
    endRow = startRow + maxRows - 1;
  }

  const effectiveCols = endCol - startCol + 1;
  const effectiveRows = endRow - startRow + 1;
  if (effectiveCols * effectiveRows > maxCells) {
    warnings.push(`Cell count (${effectiveCols * effectiveRows}) exceeds maxCells (${maxCells}); truncating rows.`);
    endRow = startRow + Math.floor(maxCells / effectiveCols) - 1;
  }

  // Read header row (row startRow)
  const headerRowVals = ws.getRow(startRow).values as ExcelJsCellValue[];
  const headers: string[] = [];
  for (let c = startCol; c <= endCol; c++) {
    const val = headerRowVals[c] ?? null;
    headers.push(cellToString(val) || colLetter(c));
  }

  // Filter columns if requested
  let colIndices: number[] = [];
  if (opts.columns && opts.columns.length > 0) {
    for (const colName of opts.columns) {
      const idx = headers.indexOf(colName);
      if (idx >= 0) colIndices.push(idx);
    }
    if (colIndices.length === 0) colIndices = headers.map((_, i) => i);
  } else {
    colIndices = headers.map((_, i) => i);
  }

  const selectedHeaders = colIndices.map((i) => headers[i]!);

  // Read data rows. C10.3: rows are positional tuples aligned with
  // selectedHeaders/columns — row[j] corresponds to columns[j], not a
  // per-row {header: value} object.
  const rows: unknown[][] = [];
  for (let r = startRow + 1; r <= endRow; r++) {
    const rowVals = ws.getRow(r).values as ExcelJsCellValue[];
    const row: unknown[] = [];
    let hasValue = false;
    for (const ci of colIndices) {
      const colIdx = startCol + ci;
      const val = rowVals[colIdx] ?? null;
      const parsed = parseCellValue(val);
      row.push(parsed);
      if (parsed !== null && parsed !== "") hasValue = true;
    }
    if (hasValue) rows.push(row);
  }

  const truncated = endRow < ws.rowCount && !opts.range && !opts.rowRange;

  const rangeStr = `${colLetter(startCol)}${startRow}:${colLetter(endCol)}${endRow}`;

  return {
    ok: true,
    sheet: ws.name,
    range: rangeStr,
    columns: selectedHeaders,
    rows,
    truncated,
    warnings,
  };
}

/**
 * Parse a cell value to a JSON-friendly type (string | number | boolean | null).
 */
function parseCellValue(v: ExcelJsCellValue): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v;
  if (typeof v === "object" && "formula" in (v as object)) {
    const fv = v as { formula: string; result?: unknown };
    return fv.result !== undefined ? parseCellValue(fv.result as ExcelJsCellValue) : null;
  }
  if (typeof v === "object" && "text" in (v as object)) {
    return String((v as { text: unknown }).text ?? "");
  }
  return String(v);
}

/**
 * Convert column letter(s) to 1-based column number.
 */
function colNumber(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) {
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n;
}
