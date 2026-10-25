import {measureResponseBytes} from "../../protocol/budget/measure.js";

interface Span {readonly start: number; readonly end: number}

/**
 * Include cheap intervening original lines when that saves an addressed row.
 *
 * `canBridge(start, end)`, when given, is asked before the lines between two rows
 * are carried along and must say that they may be: the structure map of a type
 * whose members are declared outside it (a Go struct's methods, with other types
 * between them: structureMapMembers.ts `ownLinesBridge`) never serves the code
 * of something that is not the type, however cheap it is to address. Absent,
 * every gap that costs less than a row is carried, as it always was.
 */
export function coalesceAnswerRows(
  source: readonly string[], input: readonly Span[], owed: readonly Span[],
  addressBytes: number, maxSourceBytes = 12 * 1024,
  canBridge?: (start: number, end: number) => boolean,
): {rows: Span[]; owed: Span[]} {
  const rows: Span[] = [];
  for (const row of [...input].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const previous = rows.at(-1), end = Math.max(previous?.end ?? 0, row.end);
    const valid = previous !== undefined && previous.start >= 1 && row.start >= 1 && end <= source.length;
    const gap = previous === undefined || row.start <= previous.end + 1 ? ""
      : "\n" + source.slice(previous.end, row.start - 1).join("\n") + "\n";
    const cost = measureResponseBytes(JSON.stringify(gap)) - 2;
    const unionBytes = valid ? Buffer.byteLength(source.slice(previous.start - 1, end).join("\n"), "utf8") : Infinity;
    const bridgeable = gap === "" || canBridge === undefined || canBridge(previous!.end + 1, row.start - 1);
    if (valid && cost <= addressBytes && unionBytes <= maxSourceBytes && bridgeable) rows[rows.length - 1] = {start: previous.start, end};
    else rows.push({...row});
  }
  const remaining = owed.flatMap(span => {
    const gaps: Span[] = []; let cursor = span.start;
    for (const row of rows) {
      if (row.end < cursor || row.start > span.end) continue;
      if (row.start > cursor) gaps.push({start: cursor, end: row.start - 1});
      cursor = Math.max(cursor, row.end + 1);
    }
    if (cursor <= span.end) gaps.push({start: cursor, end: span.end});
    return gaps;
  });
  return {rows, owed: remaining};
}
