// CSV / TSV extractor — pure, dependency-free structured serving for
// @tokenlighten/mcp-server.
//
// WHY THIS EXISTS: csv/tsv used to ride the generic text pipeline (server.ts's
// S1/C1 doc-content slice), so a large data CSV got blind byte-boundary
// truncation — the exact "roster tax" the xlsx artifact path was built to
// avoid. This module gives csv/tsv the SAME "first call serves bounded
// structured data honestly" treatment xlsx gets: sniff the dialect, parse
// RFC4180-correctly, and return a bounded {columns, rows, range, total_rows,
// …} table with an honest note telling the caller how to fetch more.
//
// Deliberately hand-rolled (NO new dependency, per AGENTS.md) and fully
// synchronous — unlike xlsx (exceljs) there is no binary container to load, so
// csvTable is cheap enough to call on the first read.
//
// The RESPONSE CONTRACT mirrors office/xlsx.ts's xlsxTable as closely as makes
// sense: `columns` is the header roster once; `rows` are POSITIONAL TUPLES
// aligned with `columns` (DESIGN-v0.8 C10.3 — rows[i][j] is columns[j] in row
// i), never per-row {header: value} objects. csv has no worksheet, so `sheet`
// is dropped and `total_rows`/`total_columns`/`dialect` are added.

// ---------------------------------------------------------------------------
// Bounds — MIRRORED from office/xlsx.ts (that module does not EXPORT these, so
// they are re-declared here with identical values; keep the two in sync).
//   MAX_COLS            ← xlsx.ts `MAX_COLS`            (per-call column cap)
//   DEFAULT_MAX_ROWS    ← xlsx.ts xlsxTable `maxRows` default
//   DEFAULT_MAX_CELLS   ← xlsx.ts xlsxTable `maxCells` default
//   MAX_ROWS_CEILING    ← xlsx.ts xlsxTable `MAX_ROWS_CEILING`
//   MAX_CELLS_CEILING   ← xlsx.ts xlsxTable `MAX_CELLS_CEILING`
//   SNIFF_SAMPLE_RECORDS is csv-local (no xlsx analogue): the ~20-record
//   window the delimiter/​header heuristics inspect.
// ---------------------------------------------------------------------------
const MAX_COLS = 50; // xlsx.ts MAX_COLS
const DEFAULT_MAX_ROWS = 200; // xlsx.ts xlsxTable maxRows default
const DEFAULT_MAX_CELLS = 10_000; // xlsx.ts xlsxTable maxCells default
const SNIFF_SAMPLE_RECORDS = 20;

// CWE-400/409 caller-value hard clamp (TL-V0.9-RELEASE-STRATEGY-2026-08-12.md
// §6.6-2 item 3, shipped 2026-08-13): csvTable's maxRows/maxCells used to
// pass straight through from the caller (`opts.maxRows ?? DEFAULT_MAX_ROWS`)
// with no ceiling — server.ts forwards `args["maxRows"]`/`args["maxCells"]`
// (a raw caller JSON number, gated only by `typeof === "number"`) with no
// schema validation, same shape as xlsx.ts's xlsxTable. Mirrors that fix
// here: ceilings and the sanitize policy (zero passes through — genuinely
// safe, and server.ts's serveBoundedCsvArtifact's final fallback rung
// intentionally sends `maxRows: 0` for a "columns/totals only" response;
// only non-finite/negative garbage falls back to the default) are identical
// to xlsx.ts's clampTableCount — see that file's fuller rationale comment.
// Exported (same reason as xlsx.ts's clampTableCount) so
// callerValueClamps.spec.ts can pin the exact ceiling numbers directly.
export function clampTableCount(value: number | undefined, fallback: number, ceiling: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return fallback;
  return value > ceiling ? ceiling : value;
}

const MAX_ROWS_CEILING = 10_000; // xlsx.ts xlsxTable MAX_ROWS_CEILING
const MAX_CELLS_CEILING = 1_000_000; // xlsx.ts xlsxTable MAX_CELLS_CEILING (== MAX_PREVIEW_CELLS)

// SECURITY (TL-SECURITY-REVIEW-2026-08-15 finding 1, CWE-400): parse-time
// quotas passed to parseCsv — see its doc comment. Derived as generous
// multiples of the OUTPUT ceilings directly above (not the possibly-tiny
// per-call maxRows/maxCells) so a range= request can still page deep into a
// large legitimate file; they exist to bound the WORST case (a huge or
// adversarial input) to a known multiple of the existing ceiling family,
// not to re-clamp ordinary requests, which the output-side caps above
// already handle.
const PARSE_MAX_RECORDS = MAX_ROWS_CEILING * 50; // 500,000 records
const PARSE_MAX_CUMULATIVE_CELLS = MAX_CELLS_CEILING * 5; // 5,000,000 cells
const PARSE_MAX_FIELDS_PER_RECORD = MAX_COLS * 1_000; // 50,000 fields in one record — guards
                                                        // a delimiter-flood single row without
                                                        // capping legitimately wide (> MAX_COLS)
                                                        // real-world data, which already parses
                                                        // fine today and is only column-truncated
                                                        // for display.
const PARSE_MAX_CHARS = 25 * 1024 * 1024; // 25 MB — matches this server's existing whole-file-scale
                                            // ceiling family (write/artifactEdit.ts MAX_INPUT_BYTES,
                                            // tools/archive.ts ARCHIVE_LIMITS.maxCompressedBytes);
                                            // bounds the char-by-char field rebuild parseCsv does
                                            // (escaped-quote unescaping means a field's text is
                                            // NOT a slice of the original buffer) independent of
                                            // how large the already-decoded input string is.

/** RFC4180 quote character. Fixed — the spec only defines the double quote. */
const QUOTE = '"';

/** Candidate delimiters, in tie-break preference order (comma first). */
const CANDIDATE_DELIMITERS = [",", "\t", ";", "|"] as const;

export interface CsvDialect {
  /** The chosen field delimiter (a single character, e.g. "," or "\t"). */
  delimiter: string;
  /** Always the double quote — RFC4180 defines no other. */
  quote: string;
  /** Whether the first record looks like a header (see detectHeader). */
  headerLikely: boolean;
}

export interface CsvTableResult {
  ok: true;
  /** Header roster (real headers, or synthesized col_1..col_n). */
  columns: string[];
  /**
   * DESIGN-v0.8 C10.3 (mirrored from xlsx.ts): rows are POSITIONAL TUPLES
   * aligned with `columns` — `rows[i][j]` is the value for `columns[j]`.
   * Cells are kept as STRINGS (csv is untyped; coercing "007"/"1e3"/leading
   * zeros to numbers would be lossy). Missing cells in a ragged row are null.
   */
  rows: unknown[][];
  /**
   * Served span in row-number form, e.g. "2-101": logical row numbers where a
   * detected header is row 1 and data begins at row 2 (headerless data begins
   * at row 1). Row numbers count NON-EMPTY records (blank lines are skipped),
   * so `range` composes with the `note`'s range= continuation.
   */
  range: string;
  /**
   * True when the served rows are fewer than the (windowed) available rows,
   * OR (rare, huge/adversarial input only — see `warnings`) a parse-time
   * safety quota stopped short of the whole file, making `total_rows` a
   * lower bound rather than an exact count.
   */
  truncated: boolean;
  /**
   * Total DATA rows in the file (excludes the header). Honest for every
   * file this server can fully parse; on the rare input large enough to
   * trip a parse-time safety quota, this is a lower bound and `warnings`
   * says so explicitly — never silently wrong, but not always exact.
   */
  total_rows: number;
  /** Total columns (header width). */
  total_columns: number;
  dialect: { delimiter: string; header: boolean };
  warnings: string[];
  /** Present only when truncated: exact range= call to fetch the remainder. */
  note?: string;
}

export type CsvTableFailure = { ok: false; error: string; warnings: string[] };

export interface CsvTableOptions {
  /**
   * Data-row span selector in the same row-number form `range` reports back,
   * e.g. "2-101" (header = row 1, data = rows 2..). A single number "5"
   * selects one row. Out-of-file bounds are clamped.
   */
  range?: string;
  /** Subset columns by header name: case-sensitive exact, then case-insensitive. */
  columns?: string[];
  /**
   * File extension hint ("csv"/".csv"/"tsv"/".tsv"). A tsv extension FORCES the
   * tab delimiter (skips sniffing) — the one case where the filename, not the
   * content, is authoritative.
   */
  ext?: string;
  /** Explicit delimiter override (rare; bypasses sniffing). */
  delimiter?: string;
  /** Row cap (default mirrors xlsx's 200). */
  maxRows?: number;
  /** Cell cap (default mirrors xlsx's 10000). */
  maxCells?: number;
}

// ---------------------------------------------------------------------------
// Byte decoding
// ---------------------------------------------------------------------------

/** Decode bytes to text, stripping a leading UTF-8 BOM (EF BB BF). */
export function decodeCsvBytes(bytes: Uint8Array): string {
  let start = 0;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    start = 3;
  }
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset + start, bytes.byteLength - start);
  return buf.toString("utf8");
}

// ---------------------------------------------------------------------------
// RFC4180 parser
// ---------------------------------------------------------------------------

/**
 * Parse-time resource quotas (CWE-400) — see parseCsv's doc comment.
 * All fields are optional; an unset field imposes no bound on that
 * dimension. Independent of `opts.limit`, which stops purely on record
 * COUNT and predates this type (kept as-is — the sniff sampler passes only
 * `limit`, never `quota`).
 */
export interface ParseCsvQuota {
  /** Abort once cumulative characters assembled across all fields exceeds this. */
  maxChars?: number;
  /** Abort (flushing the partial record) once a SINGLE record alone produces this many fields. */
  maxFieldsPerRecord?: number;
  /** Abort once cumulative fields across ALL records parsed so far exceeds this. */
  maxCumulativeCells?: number;
}

/**
 * Parse RFC4180 CSV/TSV text into records of string fields.
 *
 * Handles: double-quote escaping (`""` inside a quoted field → a literal `"`),
 * embedded delimiters and embedded newlines inside quotes, CRLF / LF / lone-CR
 * record separators, a leading UTF-8 BOM, and ragged rows (each record keeps
 * exactly the fields it has — no padding here; the table layer pads/clamps).
 *
 * A field is quoted only when its FIRST character is the quote; a quote later
 * in an unquoted field is a literal character. `opts.limit` stops after that
 * many records (used by the sniff sampler so it never scans a whole huge file).
 *
 * SECURITY (TL-SECURITY-REVIEW-2026-08-15 finding 1, CWE-400): `opts.quota`
 * (see ParseCsvQuota) bounds parse-time RETENTION independent of `limit` —
 * without it, every record from the input was appended to `records`
 * unconditionally, so csvTable's row/cell OUTPUT caps (applied only after
 * this function returned) never stopped a huge or adversarial input from
 * being fully materialized first. `opts.truncatedRef`, when supplied, is
 * set true the instant `limit` or `quota` fires early — this function's
 * return type deliberately stays `string[][]` (unchanged for every
 * existing caller, including the sniff sampler and direct unit tests) and
 * `truncatedRef` is the opt-in side channel csvTable uses to know its
 * `total_rows` became a lower bound rather than an exact count.
 */
export function parseCsv(
  text: string,
  delimiter: string,
  quote: string = QUOTE,
  opts: { limit?: number; quota?: ParseCsvQuota; truncatedRef?: { truncated: boolean } } = {},
): string[][] {
  // A leading BOM may survive if a caller parses text directly rather than via
  // decodeCsvBytes — strip it defensively so field 0 never carries ﻿.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const records: string[][] = [];
  const limit = opts.limit;
  const quota = opts.quota;
  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  let started = false; // did the current record have ANY content yet?
  const n = text.length;
  let i = 0;
  let charsSoFar = 0;
  let cellsSoFar = 0;

  const markTruncated = (): void => {
    if (opts.truncatedRef) opts.truncatedRef.truncated = true;
  };
  const overQuota = (): boolean =>
    quota !== undefined
    && ((quota.maxChars !== undefined && charsSoFar > quota.maxChars)
      || (quota.maxCumulativeCells !== undefined && cellsSoFar > quota.maxCumulativeCells));

  const endRecord = (): void => {
    record.push(field);
    charsSoFar += field.length;
    cellsSoFar += record.length;
    field = "";
    records.push(record);
    record = [];
    started = false;
  };

  while (i < n) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === quote) {
        if (text[i + 1] === quote) {
          field += quote; // escaped quote
          i += 2;
          continue;
        }
        inQuotes = false; // closing quote
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === quote && field === "") {
      inQuotes = true; // opening quote (only at field start)
      started = true;
      i++;
      continue;
    }
    if (ch === delimiter) {
      record.push(field);
      charsSoFar += field.length;
      field = "";
      started = true;
      if (quota?.maxFieldsPerRecord !== undefined && record.length >= quota.maxFieldsPerRecord) {
        // A single record has already proven the input pathological (e.g. a
        // delimiter flood) — flush it as-is (ragged) and stop entirely.
        records.push(record);
        markTruncated();
        return records;
      }
      i++;
      continue;
    }
    if (ch === "\r") {
      if (text[i + 1] === "\n") i++; // CRLF
      endRecord();
      i++;
      if (limit !== undefined && records.length >= limit) { markTruncated(); return records; }
      if (overQuota()) { markTruncated(); return records; }
      continue;
    }
    if (ch === "\n") {
      endRecord();
      i++;
      if (limit !== undefined && records.length >= limit) { markTruncated(); return records; }
      if (overQuota()) { markTruncated(); return records; }
      continue;
    }
    field += ch;
    started = true;
    i++;
  }

  // Flush a trailing record that had no final newline. A file ending in a
  // newline leaves field="" / record=[] / started=false → no phantom record.
  if (field !== "" || record.length > 0 || started || inQuotes) {
    record.push(field);
    records.push(record);
  }
  return records;
}

/** A record is "blank" (a stray empty line) when it is a single empty field. */
function isBlankRecord(record: string[]): boolean {
  return record.length === 0 || (record.length === 1 && (record[0] ?? "").trim() === "");
}

// ---------------------------------------------------------------------------
// Dialect sniffing + header detection
// ---------------------------------------------------------------------------

function isNumericCell(value: string): boolean {
  const s = value.trim();
  if (s === "") return false;
  return Number.isFinite(Number(s));
}

/** Mode (most frequent value) of a list of field counts, ties → larger count. */
function modalFieldCount(counts: number[]): { modal: number; agreement: number } {
  const freq = new Map<number, number>();
  for (const c of counts) freq.set(c, (freq.get(c) ?? 0) + 1);
  let modal = 0;
  let agreement = 0;
  for (const [count, times] of freq) {
    if (times > agreement || (times === agreement && count > modal)) {
      modal = count;
      agreement = times;
    }
  }
  return { modal, agreement };
}

/**
 * Header heuristic: the first record is a header when its cells are all
 * non-empty, MOSTLY non-numeric, and unique. Otherwise the file is treated as
 * headerless (columns synthesized as col_1..col_n, header:false).
 */
function detectHeader(firstRecord: string[] | undefined): boolean {
  if (firstRecord === undefined || firstRecord.length === 0) return false;
  const cells = firstRecord.map((c) => c.trim());
  if (cells.some((c) => c === "")) return false; // all cells must be non-empty
  const numeric = cells.filter(isNumericCell).length;
  if (numeric * 2 >= cells.length) return false; // must be MOSTLY non-numeric
  if (new Set(cells).size !== cells.length) return false; // headers are unique
  return true;
}

/**
 * Sniff the delimiter (most-consistent field count across the first ~20
 * non-empty records, RFC4180-aware so delimiters inside quotes don't count)
 * and whether the first record looks like a header. A tsv `ext` forces tab.
 */
export function sniffCsvDialect(text: string, opts: { ext?: string } = {}): CsvDialect {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const forceTab = opts.ext !== undefined && /tsv/i.test(opts.ext);
  let delimiter = ",";

  if (forceTab) {
    delimiter = "\t";
  } else {
    let best: { delimiter: string; agreement: number; modal: number } | undefined;
    for (const candidate of CANDIDATE_DELIMITERS) {
      const sample = parseCsv(text, candidate, QUOTE, { limit: SNIFF_SAMPLE_RECORDS })
        .filter((r) => !isBlankRecord(r));
      if (sample.length === 0) continue;
      const { modal, agreement } = modalFieldCount(sample.map((r) => r.length));
      if (modal < 2) continue; // a real delimiter yields >= 2 fields
      // Prefer higher agreement, then higher modal field count, then the
      // earlier (more conventional) candidate — CANDIDATE_DELIMITERS order.
      if (
        best === undefined
        || agreement > best.agreement
        || (agreement === best.agreement && modal > best.modal)
      ) {
        best = { delimiter: candidate, agreement, modal };
      }
    }
    if (best !== undefined) delimiter = best.delimiter;
    // else: no candidate split into >= 2 columns → single-column data, comma.
  }

  const firstNonBlank = parseCsv(text, delimiter, QUOTE, { limit: SNIFF_SAMPLE_RECORDS })
    .find((r) => !isBlankRecord(r));
  return { delimiter, quote: QUOTE, headerLikely: detectHeader(firstNonBlank) };
}

// ---------------------------------------------------------------------------
// Range parsing
// ---------------------------------------------------------------------------

/**
 * Parse a row-number range ("2-101" or "5") into a [startIdx, endIdxExclusive)
 * pair of 0-based DATA-row indices, given the logical row number of data row 0
 * (`firstDataRow`) and the total data-row count. Returns undefined for a
 * malformed range (caller falls back to the default window).
 */
function parseRowRange(
  range: string,
  firstDataRow: number,
  totalRows: number,
): [number, number] | undefined {
  const m = range.trim().match(/^(\d+)(?:-(\d+))?$/);
  if (!m) return undefined;
  const a = parseInt(m[1]!, 10);
  const b = m[2] !== undefined ? parseInt(m[2], 10) : a;
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  let sIdx = lo - firstDataRow;
  let eIdx = hi - firstDataRow + 1;
  sIdx = Math.max(0, Math.min(sIdx, totalRows));
  eIdx = Math.max(sIdx, Math.min(eIdx, totalRows));
  return [sIdx, eIdx];
}

// ---------------------------------------------------------------------------
// Public table extractor
// ---------------------------------------------------------------------------

/**
 * Extract a bounded, structured table view of CSV/TSV bytes — the csv analogue
 * of xlsxTable. Sniffs the dialect, parses RFC4180, and returns `columns` +
 * positional-tuple `rows` for a bounded window, with `total_rows` and (when
 * truncated) an honest `note` naming the exact range= call to fetch more.
 */
export function csvTable(
  bytes: Uint8Array,
  opts: CsvTableOptions = {},
): CsvTableResult | CsvTableFailure {
  const warnings: string[] = [];
  const maxRows = clampTableCount(opts.maxRows, DEFAULT_MAX_ROWS, MAX_ROWS_CEILING);
  const maxCells = clampTableCount(opts.maxCells, DEFAULT_MAX_CELLS, MAX_CELLS_CEILING);

  const text = decodeCsvBytes(bytes);

  const dialect = opts.delimiter !== undefined
    ? { delimiter: opts.delimiter, quote: QUOTE, headerLikely: detectHeader(undefined) }
    : sniffCsvDialect(text, opts.ext !== undefined ? { ext: opts.ext } : {});
  const delimiter = opts.delimiter ?? dialect.delimiter;

  // Parse every record, then drop stray blank lines. Row numbering below is
  // over these RETAINED records so it composes with the range= note.
  // parseTruncated tracks whether PARSE_MAX_* fired early (finding 1) — see
  // the truncation-warning block near the end of this function.
  const parseTruncated = { truncated: false };
  const allRecords = parseCsv(text, delimiter, QUOTE, {
    limit: PARSE_MAX_RECORDS,
    quota: {
      maxChars: PARSE_MAX_CHARS,
      maxFieldsPerRecord: PARSE_MAX_FIELDS_PER_RECORD,
      maxCumulativeCells: PARSE_MAX_CUMULATIVE_CELLS,
    },
    truncatedRef: parseTruncated,
  }).filter((r) => !isBlankRecord(r));

  // Header detection must run against the actual delimiter's parse (the sniff
  // sample used the same delimiter, so this agrees with dialect.headerLikely).
  const hasHeader = opts.delimiter !== undefined
    ? detectHeader(allRecords[0])
    : dialect.headerLikely;

  const headerRecord = hasHeader ? (allRecords[0] ?? []) : undefined;
  const dataRecords = hasHeader ? allRecords.slice(1) : allRecords;
  const firstDataRow = hasHeader ? 2 : 1; // logical row number of data row 0

  // Column roster. Ragged data rows can be wider than the header; the header
  // (or synthesized col_1..col_n over the widest record) defines the columns.
  const widestRecord = allRecords.reduce((m, r) => Math.max(m, r.length), 0);
  let allColumns: string[];
  if (headerRecord !== undefined) {
    allColumns = headerRecord.map((c, i) => (c.trim() === "" ? `col_${i + 1}` : c));
  } else {
    allColumns = Array.from({ length: widestRecord }, (_, i) => `col_${i + 1}`);
  }
  const totalColumns = allColumns.length;
  const totalRows = dataRecords.length;

  // Column subset selection: case-sensitive exact, then case-insensitive.
  let colIndices: number[];
  if (opts.columns && opts.columns.length > 0) {
    const lowerColumns = allColumns.map((c) => c.toLowerCase());
    const picked: number[] = [];
    for (const requested of opts.columns) {
      let idx = allColumns.indexOf(requested);
      if (idx < 0) idx = lowerColumns.indexOf(requested.toLowerCase());
      if (idx >= 0 && !picked.includes(idx)) picked.push(idx);
    }
    if (picked.length === 0) {
      warnings.push(`No requested column matched; serving all columns.`);
      colIndices = allColumns.map((_, i) => i).slice(0, MAX_COLS);
    } else {
      colIndices = picked;
    }
  } else {
    colIndices = allColumns.map((_, i) => i).slice(0, MAX_COLS);
  }
  if (totalColumns > MAX_COLS && (!opts.columns || opts.columns.length === 0)) {
    warnings.push(`Columns truncated to ${MAX_COLS} (of ${totalColumns}).`);
  }
  const selectedColumns = colIndices.map((i) => allColumns[i]!);

  // Row window: the requested range, or all data rows by default.
  let sIdx = 0;
  let eIdx = totalRows;
  const explicitRange = opts.range !== undefined;
  if (explicitRange) {
    const parsed = parseRowRange(opts.range!, firstDataRow, totalRows);
    if (parsed) {
      [sIdx, eIdx] = parsed;
    } else {
      warnings.push(`Ignored malformed range "${opts.range}".`);
    }
  }
  const windowSize = eIdx - sIdx;

  // Apply the row cap, then the cell cap (mirrors xlsxTable's two-stage cap).
  let servedCount = Math.min(windowSize, maxRows);
  if (servedCount < windowSize) {
    warnings.push(`Rows truncated to ${maxRows}.`);
  }
  const effectiveCols = Math.max(1, selectedColumns.length);
  if (effectiveCols * servedCount > maxCells) {
    const capped = Math.floor(maxCells / effectiveCols);
    warnings.push(`Cell count exceeds maxCells (${maxCells}); truncating rows to ${capped}.`);
    servedCount = Math.max(0, capped);
  }

  const rows: unknown[][] = [];
  for (let r = sIdx; r < sIdx + servedCount; r++) {
    const record = dataRecords[r]!;
    rows.push(colIndices.map((ci) => (ci < record.length ? record[ci]! : null)));
  }

  const servedStart = firstDataRow + sIdx;
  const servedEnd = firstDataRow + sIdx + servedCount - 1;
  const range = servedCount > 0 ? `${servedStart}-${servedEnd}` : `${firstDataRow}-${firstDataRow - 1}`;

  // finding 1: a PARSE_MAX_* quota firing mid-parse means totalRows (and
  // therefore this whole response) reflects only a PREFIX of the actual
  // file — say so explicitly rather than silently reporting a total that
  // looks exact. Never a SILENT lie: the served rows/columns above are
  // still exactly what they claim to be, only the file-wide totals are a
  // lower bound.
  if (parseTruncated.truncated) {
    warnings.push(
      `CSV is larger than this server safely parses in one call; total_rows/total_columns `
      + `reflect only the parsed prefix, not the whole file.`,
    );
  }

  const truncated = servedCount < windowSize || parseTruncated.truncated;

  const result: CsvTableResult = {
    ok: true,
    columns: selectedColumns,
    rows,
    range,
    truncated,
    total_rows: totalRows,
    total_columns: totalColumns,
    dialect: { delimiter, header: hasHeader },
    warnings,
  };

  // Honest truncation guidance: the exact range= call for the next rows.
  const lastServedLogical = servedCount > 0 ? servedEnd : firstDataRow - 1;
  const lastDataLogical = firstDataRow + totalRows - 1;
  if (truncated && lastServedLogical < lastDataLogical) {
    result.note = `served rows ${range} of ${totalRows} data rows; `
      + `fetch more with range=${lastServedLogical + 1}-${lastDataLogical}`;
  }

  return result;
}
