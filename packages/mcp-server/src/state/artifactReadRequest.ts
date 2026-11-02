// ---------------------------------------------------------------------------
// artifactReadRequest.ts -- A3: csv rows as read-request coordinates.
//
// `readRequestStore.ts` owns Q, D, cursors, CAS page fixing, lane/task binding,
// TTL and restart durability, and none of that is restated here. This adapter
// converts in one direction only: a table's data rows have exact physical line
// spans (`csvTable`'s `file_range`), so Q is the union of those spans, which are
// true FILE coordinates rather than rows dressed up as lines. A header or a blank
// line is in no row's span, so it can never be owed, and a row is served whole or
// not at all.
//
// A file whose rows cannot all be mapped never gets here: `csvPageModel` answers
// `undefined` and the caller keeps the ordinary bounded read.
// ---------------------------------------------------------------------------

import type { LineWindow, ReadRequestState } from "@tokenlighten/types";

import { chooseCsvRowPage, type CsvRowWindow, type CsvWindowModel } from "../office/csvWindow.js";
import { measureResponseBytes } from "../protocol/budget/measure.js";
import { normalizeWindows, pageEnvelopeReserve, subtractWindows, type PageChoice } from "./readRequestStore.js";

/** `csvTable`'s default row cap, so a page never asks for more than an ordinary read would serve. */
export const CSV_PAGE_MAX_ROWS = 200;

/**
 * What the csv shape costs beside its rows, on top of the read.text page envelope
 * this was measured against: `range`, `file_range`, `total_rows`, `total_columns`,
 * `dialect`, `note`, and the `content`/`form` nesting. 256 is the bound on the
 * largest of those seen across the fixtures of artifactQueryWindow.spec.ts.
 */
const CSV_SHAPE_RESERVE_BYTES = 256;

export function csvPageReserve(path: string, columns: readonly string[], cwd?: string): number {
  return pageEnvelopeReserve(path, cwd) + CSV_SHAPE_RESERVE_BYTES + measureResponseBytes(JSON.stringify(columns));
}

/** Q: every data row's physical span, merged where rows touch. */
export function csvRowSpansAsWindows(model: CsvWindowModel): LineWindow[] {
  return normalizeWindows(model.dataSpans.map(([start, end]) => ({ start, end })));
}

/** The physical window a run of rows occupies, blank lines between them included: it is what the ledger books for that run. */
export function csvRowWindowAsLines(model: CsvWindowModel, window: CsvRowWindow): LineWindow {
  return { start: model.dataSpans[window.startIdx]![0], end: model.dataSpans[window.endIdx - 1]![1] };
}

/** True iff every row of `window` is already held, i.e. serving it would deliver nothing new. */
export function csvRowWindowHeld(model: CsvWindowModel, window: CsvRowWindow, held: readonly LineWindow[]): boolean {
  for (let index = window.startIdx; index < window.endIdx; index += 1) {
    const [start, end] = model.dataSpans[index]!;
    if (subtractWindows([{ start, end }], held).length > 0) return false;
  }
  return true;
}

/** `choosePage`'s union for a csv target, so the cursor path's refusal, CAS and reuse logic applies unchanged. */
export function chooseCsvPage(
  state: ReadRequestState,
  modelOf: (path: string) => CsvWindowModel | undefined,
  budgetBytes: number,
  columnsOf: (path: string) => readonly string[],
  cwd?: string,
  /** What this page adds beside the csv shape, such as a moved source's disclosure. */
  extraReserveBytes = 0,
): PageChoice {
  const target = state.targets.find((entry) => entry.remaining.length > 0);
  if (target === undefined) return { ok: false, reason: "complete" };
  const model = modelOf(target.path);
  if (model === undefined) return { ok: false, reason: "complete" };
  const reserve = csvPageReserve(target.path, columnsOf(target.path), cwd) + extraReserveBytes;
  const page = chooseCsvRowPage(model, target.remaining, budgetBytes - reserve, CSV_PAGE_MAX_ROWS);
  if (!page.ok) {
    return page.reason === "complete"
      ? { ok: false, reason: "complete" }
      : { ok: false, reason: "budget-below-minimum", requiredMinBytes: reserve + page.requiredRoomBytes };
  }
  return { ok: true, path: target.path, windows: [csvRowWindowAsLines(model, page.window)] };
}
