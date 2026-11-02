// ---------------------------------------------------------------------------
// The pure half of the query-relevant csv window: which contiguous rows a
// query anchors on and how the rows still owed are paged. Positions only —
// no values are changed and no I/O happens here. A row is priced by
// csvRowCostBytes: its JSON form plus the comma that separates it.
// ---------------------------------------------------------------------------

import { Buffer } from "node:buffer";

export type CsvCell = string | null;

export interface CsvWindowModel {
  readonly rows: ReadonlyArray<ReadonlyArray<CsvCell>>;
  /** dataSpans[i] = 1-based inclusive physical line span of rows[i]. */
  readonly dataSpans: ReadonlyArray<readonly [number, number]>;
}

/** 1-based inclusive physical file lines. */
interface LineWindow {
  start: number;
  end: number;
}

/** Half-open row-index window: rows[startIdx .. endIdx). */
export interface CsvRowWindow {
  readonly startIdx: number;
  readonly endIdx: number;
}

/** A query window also names the row it was anchored on, which can be anywhere in it. */
export interface CsvAnchoredWindow extends CsvRowWindow {
  readonly anchorIdx: number;
}

export type CsvRowPage =
  | { ok: true; window: CsvRowWindow }
  | { ok: false; reason: "budget-below-minimum"; requiredRoomBytes: number }
  | { ok: false; reason: "complete" };

/** UTF-8 length of the row's JSON form plus its separating comma. */
export function csvRowCostBytes(row: ReadonlyArray<CsvCell>): number {
  return Buffer.byteLength(JSON.stringify(row), "utf8") + 1;
}

/** Distinct tokens occurring as a case-insensitive substring; null cells never match. */
function distinctTokenHits(row: ReadonlyArray<CsvCell>, loweredTokens: readonly string[]): number {
  const lowered = row.map((cell) => (cell === null ? null : cell.toLowerCase()));
  let hits = 0;
  for (const token of loweredTokens) {
    for (const cell of lowered) {
      if (cell !== null && cell.includes(token)) {
        hits += 1;
        break;
      }
    }
  }
  return hits;
}

/**
 * Locate the most distinct-token-matching row (the first if tied), then grow
 * a contiguous window around it in whole rows under roomBytes and maxRows.
 * Undefined when the tokens locate nothing or the anchor alone cannot fit.
 */
export function csvQueryWindow(
  model: CsvWindowModel,
  tokens: readonly string[],
  roomBytes: number,
  maxRows: number,
): CsvAnchoredWindow | undefined {
  const { rows } = model;
  if (tokens.length === 0 || rows.length === 0) return undefined;

  const loweredTokens = tokens.map((token) => token.toLowerCase());
  let bestScore = 0;
  let bestCount = 0;
  let anchorIdx = -1;
  for (let i = 0; i < rows.length; i += 1) {
    const score = distinctTokenHits(rows[i]!, loweredTokens);
    if (score > bestScore) {
      bestScore = score;
      bestCount = 1;
      anchorIdx = i;
    } else if (score === bestScore && bestScore > 0) {
      bestCount += 1;
    }
  }
  // A score every row shares locates nothing; so does a tie over most rows.
  if (bestScore === 0 || bestCount * 2 > rows.length) return undefined;

  const anchorCost = csvRowCostBytes(rows[anchorIdx]!);
  if (anchorCost > roomBytes) return undefined;

  let startIdx = anchorIdx;
  let endIdx = anchorIdx + 1;
  let used = anchorCost;
  while (endIdx < rows.length && endIdx - startIdx < maxRows) {
    const cost = csvRowCostBytes(rows[endIdx]!);
    if (used + cost > roomBytes) break;
    used += cost;
    endIdx += 1;
  }
  // Only at the end of the table is the unused budget worth spending backward.
  if (endIdx === rows.length) {
    while (startIdx > 0 && endIdx - startIdx < maxRows) {
      const cost = csvRowCostBytes(rows[startIdx - 1]!);
      if (used + cost > roomBytes) break;
      used += cost;
      startIdx -= 1;
    }
  }
  return { startIdx, endIdx, anchorIdx };
}

/** Sorted, with overlapping and adjacent windows merged into maximal runs. */
function normalizeLineWindows(windows: readonly LineWindow[]): LineWindow[] {
  const sorted = windows.slice().sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: LineWindow[] = [];
  for (const window of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && window.start <= last.end + 1) {
      if (window.end > last.end) last.end = window.end;
    } else {
      merged.push({ start: window.start, end: window.end });
    }
  }
  return merged;
}

/**
 * A row is owed when ANY of its lines is: another read can hold part of a
 * multi-line row, and the rest of that row is still owed. Rows ship whole, so
 * requiring the whole span here would leave such a line in D with no row to carry it.
 */
function windowOwesRow(window: LineWindow, span: readonly [number, number]): boolean {
  return span[0] <= window.end && span[1] >= window.start;
}

/**
 * The first maximal run of consecutive owed rows. Adjacency is by row index, so a
 * blank-line gap between two owed rows never breaks the run.
 */
export function rowsOverlappingWindows(model: CsvWindowModel, windows: readonly LineWindow[]): CsvRowWindow | undefined {
  const normalized = normalizeLineWindows(windows);
  let startIdx = -1;
  let endIdx = -1;
  let previousOwed = false;
  for (let i = 0; i < model.dataSpans.length; i += 1) {
    const span = model.dataSpans[i]!;
    const owed = normalized.some((window) => windowOwesRow(window, span));
    if (owed) {
      if (startIdx < 0) {
        startIdx = i;
        endIdx = i + 1;
      } else if (previousOwed) {
        endIdx = i + 1;
      } else {
        break;
      }
    } else if (startIdx >= 0) {
      break;
    }
    previousOwed = owed;
  }
  return startIdx < 0 ? undefined : { startIdx, endIdx };
}

/**
 * The next page: whole rows from the start of the first owed run, priced at
 * csvRowCostBytes, under roomBytes and maxRows, never past the run.
 */
export function chooseCsvRowPage(
  model: CsvWindowModel,
  remaining: readonly LineWindow[],
  roomBytes: number,
  maxRows: number,
): CsvRowPage {
  const run = rowsOverlappingWindows(model, remaining);
  if (run === undefined) return { ok: false, reason: "complete" };

  const firstCost = csvRowCostBytes(model.rows[run.startIdx]!);
  if (firstCost > roomBytes) return { ok: false, reason: "budget-below-minimum", requiredRoomBytes: firstCost };

  let used = firstCost;
  let endIdx = run.startIdx + 1;
  while (endIdx < run.endIdx && endIdx - run.startIdx < maxRows) {
    const cost = csvRowCostBytes(model.rows[endIdx]!);
    if (used + cost > roomBytes) break;
    used += cost;
    endIdx += 1;
  }
  return { ok: true, window: { startIdx: run.startIdx, endIdx } };
}
