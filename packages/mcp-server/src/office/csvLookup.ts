// ---------------------------------------------------------------------------
// The lookup half of a csv a request names: which of the table's own values the
// request spells, and every row holding one. Rows are compared with what the table
// actually contains rather than with words guessed from the request, so a value in
// any language or spelling works, and no I/O happens here.
// ---------------------------------------------------------------------------

import { csvRowCostBytes, type CsvCell, type CsvWindowModel } from "./csvWindow.js";

const MIN_TERM_CHARS = 2;
const MAX_TERM_CHARS = 64;
/** More distinct values than this means the request's words happen to be cells, not that it looks them up. */
const MAX_TERMS = 8;

export interface CsvLookup {
  /** The table's values the request spells, in the table's spelling. */
  readonly terms: readonly string[];
  /** What the request marks as values that no cell of the whole table contains; `terms` is then empty. */
  readonly absent?: readonly string[];
  /** Data rows of the whole table with a cell containing a term, ignoring case. */
  readonly total: number;
  /** `total` counts the rows with these values in these columns: all that hold any of `terms` when `any_total` is absent, fewer otherwise. */
  readonly all_of?: Readonly<Record<string, readonly string[]>>;
  /** With `all_of`: data rows holding any of `terms`, which were too many to list. */
  readonly any_total?: number;
  /** The request asks how many, so `total` answers it and `rows` need not list them all. */
  readonly counted?: true;
  /** With `counted`: rows where a term is a whole cell, when that differs from `total`. */
  readonly whole_cell_total?: number;
  /** With `absent`: every value of the columns the request names, when there are few. */
  readonly column_values?: Readonly<Record<string, readonly string[]>>;
  /** The columns `rows` holds, when the request names which it wants; absent means all of them. */
  readonly columns?: readonly string[];
  /** Data rows of the whole table that were searched. */
  readonly scanned: number;
  /** Logical row numbers of `rows`, in the same numbering as a section's `range`. */
  readonly row_numbers: readonly number[];
  readonly rows: ReadonlyArray<ReadonlyArray<CsvCell>>;
}

/**
 * Is `value` written in `query` as a value of its own rather than as part of a
 * longer token? Latin text has to end at a word boundary; a value with no latin
 * edge cannot, because Japanese or Chinese text has no spaces between words.
 */
function spelledInQuery(loweredQuery: string, value: string): boolean {
  let at = loweredQuery.indexOf(value);
  while (at >= 0) {
    const before = loweredQuery[at - 1];
    const after = loweredQuery[at + value.length];
    const edge = /[a-z0-9_.-]/;
    const startOk = !edge.test(value[0]!) || before === undefined || !edge.test(before);
    const endOk = !edge.test(value[value.length - 1]!) || after === undefined || !edge.test(after);
    if (startOk && endOk) return true;
    at = loweredQuery.indexOf(value, at + 1);
  }
  return false;
}

/**
 * A bare number names a row only right after its column ("id 4980", "id=4980",
 * "id が 4980"). Anywhere else it is as likely a count, a line number or a date part.
 */
function numberFollowsColumn(loweredQuery: string, value: string, loweredColumns: readonly string[]): boolean {
  const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return loweredColumns.some((column) =>
    new RegExp(`(?<![a-z0-9_])${escaped(column)}[\\s:=＝：はがの]{0,4}${escaped(value)}(?![a-z0-9_.-])`, "u").test(loweredQuery));
}

/**
 * The table's values `request` spells, in first-seen order. `request` should already
 * have paths removed: a file's own name is not a value being looked up. A column's
 * name is not a value either. Empty when there are more than a lookup could use.
 */
export function csvLookupTerms(model: CsvWindowModel & { readonly columns: readonly string[] }, request: string): string[] {
  const loweredQuery = request.toLowerCase();
  const loweredColumns = model.columns.map((column) => column.toLowerCase());
  const columnNames = new Set(loweredColumns);
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const row of model.rows) {
    for (const cell of row) {
      if (cell === null) continue;
      const value = cell.trim();
      if (value.length < MIN_TERM_CHARS || value.length > MAX_TERM_CHARS) continue;
      const lowered = value.toLowerCase();
      if (seen.has(lowered)) continue;
      seen.add(lowered);
      if (columnNames.has(lowered) || !spelledInQuery(loweredQuery, lowered)) continue;
      if (/^[\d.,+-]+$/.test(value) && !numberFollowsColumn(loweredQuery, lowered, loweredColumns)) continue;
      terms.push(value);
    }
  }
  return terms.length > MAX_TERMS ? [] : terms;
}

/** Text the request marks as a value: quoted, or one latin token with a hyphen, an underscore or a digit after a letter. */
const QUOTED_VALUE = /["'`「『“]([^"'`」』”\n]{2,64})["'`」』”]/gu;
const VALUE_SHAPED_TOKEN = /(?<![a-z0-9_.-])(?:[a-z][a-z0-9]*(?:[-_][a-z0-9]+)+|[a-z]+[0-9][a-z0-9]*)(?![a-z0-9_.-])/g;

/**
 * What `request` marks as values when no cell of the table contains any of them. Empty
 * when it marks none, or when one is inside a cell: that is a near miss a search should
 * show, not an absence. A column's name is not a value.
 */
export function csvLookupAbsent(model: CsvWindowModel & { readonly columns: readonly string[] }, request: string): string[] {
  const lowered = stripReadOnlyClause(request).toLowerCase();
  const columnNames = new Set(model.columns.map((column) => column.toLowerCase()));
  const marked = new Set([
    ...[...lowered.matchAll(QUOTED_VALUE)].map((match) => match[1]!.trim()),
    ...(lowered.match(VALUE_SHAPED_TOKEN) ?? []),
  ].filter((value) => value.length >= MIN_TERM_CHARS && !columnNames.has(value)));
  if (marked.size === 0 || marked.size > MAX_TERMS) return [];
  const values = [...marked];
  for (const row of model.rows) {
    for (const cell of row) {
      if (cell === null) continue;
      const value = cell.toLowerCase();
      if (values.some((term) => value.includes(term))) return [];
    }
  }
  return values;
}

/** Collects the rows `hit` accepts: `rows` until `maxRows` or `roomBytes` runs out, `total` counting them all. */
function collectRows(
  model: CsvWindowModel & { readonly firstDataRow: number },
  terms: readonly string[],
  hit: (row: ReadonlyArray<CsvCell>) => boolean,
  maxRows: number,
  roomBytes: number,
): CsvLookup {
  const row_numbers: number[] = [];
  const rows: Array<ReadonlyArray<CsvCell>> = [];
  let total = 0;
  let used = 0;
  let open = true;
  for (let i = 0; i < model.rows.length; i += 1) {
    const row = model.rows[i]!;
    if (!hit(row)) continue;
    total += 1;
    if (!open) continue;
    const cost = csvRowCostBytes(row) + 8;
    if (rows.length >= maxRows || used + cost > roomBytes) {
      open = false;
      continue;
    }
    used += cost;
    rows.push(row);
    row_numbers.push(model.firstDataRow + i);
  }
  return { terms, total, scanned: model.rows.length, row_numbers, rows };
}

/**
 * Every row with a cell containing a term. `rows` carries them in file order until
 * `maxRows` or `roomBytes` runs out, and `total` counts them all either way.
 */
export function csvLookupRows(
  model: CsvWindowModel & { readonly firstDataRow: number },
  terms: readonly string[],
  maxRows: number,
  roomBytes: number,
): CsvLookup {
  const lowered = terms.map((term) => term.toLowerCase());
  return collectRows(model, terms, (row) => row.some((cell) => {
    if (cell === null) return false;
    const value = cell.toLowerCase();
    return lowered.some((term) => value.includes(term));
  }), maxRows, roomBytes);
}

/** "a or b", whose rows hold either value whatever columns those are in. */
function requestAsksEither(request: string, loweredTerms: readonly string[]): boolean {
  const lowered = request.toLowerCase();
  return /または|もしくは|あるいは|\bor\b|\beither\b/.test(lowered)
    || loweredTerms.some((term) => new RegExp(`${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*か(?![らなり])`, "u").test(lowered));
}

/**
 * The rows when `terms` are values of different columns: "svc-3 の gateway-timeout".
 * Values of one column are alternatives, since a cell holds one. Undefined when the
 * request asks for either, when a term is not a whole cell of exactly one column, or
 * when they are all in one column. For a union too long to list, so a caller still
 * reports the union's count in `any_total`.
 */
export function csvLookupAcrossColumns(
  model: CsvWindowModel & { readonly firstDataRow: number; readonly columns: readonly string[] },
  terms: readonly string[],
  request: string,
  maxRows: number,
  roomBytes: number,
): CsvLookup | undefined {
  const lowered = terms.map((term) => term.toLowerCase());
  if (terms.length < 2 || requestAsksEither(request, lowered)) return undefined;
  const columnsOf = new Map(lowered.map((term) => [term, new Set<number>()]));
  for (const row of model.rows) {
    row.forEach((cell, column) => {
      if (cell !== null) columnsOf.get(cell.trim().toLowerCase())?.add(column);
    });
  }
  const valuesByColumn = new Map<number, Set<string>>();
  const all_of: Record<string, string[]> = {};
  for (const [index, term] of lowered.entries()) {
    const columns = columnsOf.get(term)!;
    if (columns.size !== 1) return undefined;
    const column = [...columns][0]!;
    (valuesByColumn.get(column) ?? valuesByColumn.set(column, new Set()).get(column)!).add(term);
    (all_of[model.columns[column] ?? String(column)] ??= []).push(terms[index]!);
  }
  if (valuesByColumn.size < 2) return undefined;
  const wanted = [...valuesByColumn];
  const found = collectRows(model, terms, (row) => wanted.every(([column, values]) => {
    const cell = row[column];
    return cell !== null && cell !== undefined && values.has(cell.trim().toLowerCase());
  }), maxRows, roomBytes);
  return { ...found, all_of };
}

/**
 * Rows where a term is a whole cell, which a count that says "containing" can differ
 * from, and the one column those cells are all in, if they are.
 */
export function csvLookupWholeCells(model: CsvWindowModel & { readonly columns: readonly string[] }, terms: readonly string[]): { total: number; column?: string } {
  const lowered = new Set(terms.map((term) => term.toLowerCase()));
  const columns = new Set<number>();
  let total = 0;
  for (const row of model.rows) {
    let hit = false;
    row.forEach((cell, column) => {
      if (cell === null || !lowered.has(cell.trim().toLowerCase())) return;
      hit = true;
      columns.add(column);
    });
    if (hit) total += 1;
  }
  const column = columns.size === 1 ? model.columns[[...columns][0]!] : undefined;
  return { total, ...(column !== undefined ? { column } : {}) };
}

/**
 * `lookup` with its rows cut to the columns the request asks for: "status が X の行の id"
 * wants the id, and status is already known from the search. Unchanged when the request
 * names no column beyond those it searches, which asks for the rows themselves.
 * A cut column can no longer show where a term matched, and solvers searched again to
 * see it, so `all_of` says so whenever each row holds a term as one column's whole cell.
 */
export function csvLookupProjected(model: CsvWindowModel & { readonly columns: readonly string[] }, found: CsvLookup, request: string): CsvLookup {
  const whole = found.all_of === undefined ? csvLookupWholeCells(model, found.terms) : undefined;
  const lookup: CsvLookup = whole?.column !== undefined && whole.total === found.total ? { ...found, all_of: { [whole.column]: found.terms } } : found;
  const lowered = request.toLowerCase();
  const terms = new Set(lookup.terms.map((term) => term.toLowerCase()));
  const searched = (column: number): boolean => lookup.rows.some((row) => {
    const cell = row[column]?.trim().toLowerCase();
    return cell !== undefined && terms.has(cell);
  });
  const kept = model.columns.flatMap((name, column) =>
    name.length > 0 && spelledInQuery(lowered, name.toLowerCase()) && !searched(column) ? [column] : []);
  if (kept.length === 0 || kept.length === model.columns.length) return lookup;
  return { ...lookup, columns: kept.map((column) => model.columns[column]!), rows: lookup.rows.map((row) => kept.map((column) => row[column] ?? null)) };
}

const MAX_LISTED_COLUMN_VALUES = 12;
const MAX_LISTED_VALUE_CHARS = 32;

/**
 * Every value of the columns `request` names, for those with a few short values: beside
 * an absence, it shows at once that no other spelling of the value is there either.
 */
export function csvLookupColumnValues(model: CsvWindowModel & { readonly columns: readonly string[] }, request: string): Record<string, string[]> | undefined {
  const lowered = request.toLowerCase();
  const out: Record<string, string[]> = {};
  model.columns.forEach((name, column) => {
    if (name.length < MIN_TERM_CHARS || !spelledInQuery(lowered, name.toLowerCase())) return;
    const values = new Set<string>();
    for (const row of model.rows) {
      const cell = row[column]?.trim();
      if (cell === undefined || cell === "") continue;
      values.add(cell);
      if (values.size > MAX_LISTED_COLUMN_VALUES || cell.length > MAX_LISTED_VALUE_CHARS) return;
    }
    out[name] = [...values];
  });
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Does the request ask how many rows, so a count answers it? "何行目" asks where instead,
 * and a column called `count` is a value's name, not this question.
 */
export function csvLookupAsksCount(request: string, columns: readonly string[] = []): boolean {
  let asked = request.toLowerCase();
  for (const column of columns) asked = asked.split(column.toLowerCase()).join(" ");
  return /何件|何行(?!目)|いくつ|件数|行数|\bhow many\b|\bcount\b|\bnumber of\b/u.test(asked);
}

/**
 * Requests a list of rows containing a value does not answer: negation, comparison,
 * ordering, extremes and sums, which need rows the list leaves out, and explanations,
 * which need more than the rows. Such a request still gets the rows; it just does not
 * end there. Erring towards "not a lookup" only costs the search it would have made.
 */
const NOT_A_ROW_LOOKUP = new RegExp([
  "ではない", "じゃない", "でない", "以外", "除く", "除外", "以上", "以下", "未満", "超え", "より", "ごと", "別に",
  "合計", "平均", "集計", "最大", "最小", "最新", "最古", "順に", "並べ", "比較", "傾向", "分析", "なぜ", "原因", "理由", "増え", "減",
  "\\bnot\\b", "\\bexcept\\b", "\\bother than\\b", "\\bwithout\\b", "\\bexclud", "\\bsum\\b", "\\baverage\\b", "\\bavg\\b",
  "\\bmax", "\\bmin", "\\btotal\\b", "\\bgroup by\\b", "\\btop \\d", "\\blatest\\b", "\\boldest\\b", "\\bgreater\\b",
  "\\bless than\\b", "\\bbetween\\b", "\\bsort", "\\bcompare", "\\bwhy\\b", "\\btrend", "\\banaly",
].join("|"), "iu");

/** The request's own "do not change the file", which says nothing about a value. */
function stripReadOnlyClause(request: string): string {
  return request
    .replace(/(?:ファイル|file)?(?:は|を)?(?:変更|編集|修正)(?:は|を)?(?:しない|せず|禁止)[^\s。.]*/giu, "")
    .replace(/\b(?:do not|don't|without) (?:change|changing|modify|modifying|edit|editing)\b[^.]*/giu, "")
    .replace(/\bread[- ]only\b/giu, "");
}

/** Does finding every row with these values answer the request? */
export function csvLookupAnswersRequest(request: string): boolean {
  return !NOT_A_ROW_LOOKUP.test(stripReadOnlyClause(request));
}
