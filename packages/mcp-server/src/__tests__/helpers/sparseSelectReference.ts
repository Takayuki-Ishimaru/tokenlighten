// The selection as first written, kept only to compare against: sparseSelect.spec.ts
// checks that the faster one chooses exactly what this one chooses.
// ---------------------------------------------------------------------------
// The pure half of a sparse first look: which non-contiguous rows to show when
// a table is too big to read at once. It picks POSITIONS for a PARTIAL view.
// A row left out says nothing about its importance, and a score here is never
// evidence of absence or of completeness. Positions only: no values changed,
// no I/O, no wall-clock, fully deterministic.
// ---------------------------------------------------------------------------

import { csvRowCostBytes, type CsvWindowModel } from "../../office/csvWindow.js";

const CJK_RE = /[\u3000-\u30ff\u31c0-\u31e3\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f\u3005\u303b\u303c\u30fc\u00b7]/u;
const LETTER_RE = /[\p{L}\p{N}]/u;
const ANOMALY_LEXEMES = new Set([
  "error", "failed", "fail", "failure", "exception", "fatal", "panic",
  "timeout", "denied", "refused", "expired", "not",
]);

const isDigit = (ch: string): boolean => ch >= "0" && ch <= "9";
const isCjk = (ch: string): boolean => CJK_RE.test(ch);

/** True when a sign at i binds to its digit: nothing word-like before, digit after. */
function signBinds(source: string, i: number): boolean {
  const ch = source[i]!;
  if ((ch !== "-" && ch !== "+") || !isDigit(source[i + 1] ?? "")) return false;
  const prev = source[i - 1];
  return prev === undefined || !LETTER_RE.test(prev);
}

/** A date, time or dotted number, kept whole: digits joined by - : . / with an optional time part and zone. */
const JOINED_NUMBER = /\d{1,4}(?:[-:./]\d+)+(?:t\d+(?:[:.]\d+)*)?(?:z(?![a-z0-9])|[+-]\d+(?::\d+)?)?/y;

/** The end of a joined number starting at `start`, or `start` itself when there is none. */
function scanJoinedNumber(source: string, start: number): number {
  JOINED_NUMBER.lastIndex = start;
  return JOINED_NUMBER.test(source) ? JOINED_NUMBER.lastIndex : start;
}

/**
 * Whole-value lexemes: a prefix of a number is a different value. Timestamps
 * and CJK runs stay whole; hyphens between words split; a bound sign survives.
 */
export function lexemes(cell: string): string[] {
  const out: string[] = [];
  const source = cell.toLowerCase();
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (isCjk(ch)) {
      let j = i;
      while (j < source.length && isCjk(source[j]!)) j += 1;
      out.push(source.slice(i, j));
      i = j;
      continue;
    }
    if (isDigit(ch) || signBinds(source, i)) {
      const digitsFrom = source[i] === "-" || source[i] === "+" ? i + 1 : i;
      let j = scanJoinedNumber(source, digitsFrom);
      if (j === digitsFrom) while (isDigit(source[j] ?? "")) j += 1;
      out.push(source[i] === "+" ? source.slice(i + 1, j) : source.slice(i, j));
      i = j;
      continue;
    }
    if (LETTER_RE.test(ch)) {
      let j = i;
      while (j < source.length && LETTER_RE.test(source[j]!) && !isDigit(source[j]!)) j += 1;
      out.push(source.slice(i, j));
      i = j;
      continue;
    }
    i += 1;
  }
  return out;
}

/** Half-open row indices. */
export interface SparseRun {
  readonly startIdx: number;
  readonly endIdx: number;
}

export interface SparseSelection {
  readonly runs: readonly SparseRun[];
  readonly scanned: number;
  readonly shown: number;
}

interface Candidate {
  readonly rowIdx: number;
  readonly score: number;
  readonly lexemeSet: ReadonlySet<string>;
}

/** Relevance of a row: token lexemes present as whole values, CJK tokens may nest. */
function tokenMatchesRow(
  tokenLexemes: readonly string[],
  rowSet: ReadonlySet<string>,
  rowCjkText: string,
): boolean {
  for (const lexeme of tokenLexemes) {
    if (rowSet.has(lexeme)) continue;
    const isCjk = CJK_RE.test(lexeme);
    if (isCjk && rowCjkText.includes(lexeme)) continue;
    return false;
  }
  return true;
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const lexeme of small) if (large.has(lexeme)) shared += 1;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

/**
 * Sparse first look over rows: locate with whole-value lexemes, rank by
 * relevance plus anomaly and rarity, diversify with greedy maximal marginal
 * relevance, then place anchor rows and (only for what still fits) their
 * immediate neighbours. Runs are returned in file order. Selection says only
 * where to look first, never that anything else can be ignored.
 */
export function selectSparseRows(
  model: CsvWindowModel,
  tokens: readonly string[],
  roomBytes: number,
  maxRuns: number,
): SparseSelection | undefined {
  const { rows } = model;
  if (tokens.length === 0 || rows.length === 0) return undefined;

  // Whole-row lexeme sets and document frequencies, one pass over the cells.
  const rowSets: ReadonlySet<string>[] = new Array(rows.length);
  const rowCjk: string[] = new Array(rows.length);
  const docFreq = new Map<string, number>();
  for (let i = 0; i < rows.length; i += 1) {
    const set = new Set<string>();
    let cjkText = "";
    for (const cell of rows[i]!) {
      if (cell === null) continue;
      for (const lexeme of lexemes(cell)) {
        if (!set.has(lexeme)) set.add(lexeme);
        if (CJK_RE.test(lexeme)) cjkText = cjkText === "" ? lexeme : `${cjkText} ${lexeme}`;
      }
    }
    rowSets[i] = set;
    rowCjk[i] = cjkText;
    for (const lexeme of set) docFreq.set(lexeme, (docFreq.get(lexeme) ?? 0) + 1);
  }

  const tokenLexemesAll = tokens.map((token) => lexemes(token));
  const matched: { rowIdx: number; relevance: number }[] = [];
  let bestRelevance = 0;
  for (let i = 0; i < rows.length; i += 1) {
    let relevance = 0;
    for (const tokenLexemes of tokenLexemesAll) {
      if (tokenLexemes.length > 0 && tokenMatchesRow(tokenLexemes, rowSets[i]!, rowCjk[i]!)) {
        relevance += 1;
      }
    }
    if (relevance > 0) {
      matched.push({ rowIdx: i, relevance });
      if (relevance > bestRelevance) bestRelevance = relevance;
    }
  }
  // Nothing located, or a best relevance most rows share, locates nothing.
  if (matched.length === 0) return undefined;
  if (matched.filter(({ relevance }) => relevance === bestRelevance).length * 2 > rows.length) return undefined;

  // Score: relevance, an anomaly nudge, and how rare the row's values are.
  const candidates: Candidate[] = matched.map(({ rowIdx, relevance }) => {
    const lexemeSet = rowSets[rowIdx]!;
    let score = relevance * 10;
    let anomaly = false;
    let rarity = 0;
    for (const lexeme of lexemeSet) {
      if (!anomaly && ANOMALY_LEXEMES.has(lexeme)) {
        anomaly = true;
        score += 3;
      }
      rarity += 1 / (docFreq.get(lexeme) ?? 1);
    }
    return { rowIdx, score: score + Math.min(rarity, 2), lexemeSet };
  });
  candidates.sort((a, b) => b.score - a.score || a.rowIdx - b.rowIdx);
  candidates.length = Math.min(candidates.length, 256);

  // Greedy maximal-marginal-relevance: penalize copying an anchor already picked.
  const picked: Candidate[] = [];
  const taken = new Set<number>();
  while (picked.length < maxRuns) {
    let best: Candidate | undefined;
    let bestValue = -Infinity;
    for (const candidate of candidates) {
      if (taken.has(candidate.rowIdx)) continue;
      let worst = 0;
      for (const anchor of picked) {
        const similarity = jaccard(candidate.lexemeSet, anchor.lexemeSet);
        if (similarity > worst) worst = similarity;
      }
      const value = candidate.score - 8 * worst;
      if (value > bestValue || (value === bestValue && best !== undefined && candidate.rowIdx < best.rowIdx)) {
        best = candidate;
        bestValue = value;
      }
    }
    if (best === undefined) break;
    picked.push(best);
    taken.add(best.rowIdx);
  }
  if (picked.length === 0) return undefined;

  // Spend the room: anchors first, then one row of context on each side.
  const costs = rows.map(csvRowCostBytes);
  let used = 0;
  const shown = new Set<number>();
  const takeRow = (rowIdx: number): boolean => {
    if (shown.has(rowIdx)) return false;
    if (used + costs[rowIdx]! > roomBytes) return false;
    used += costs[rowIdx]!;
    shown.add(rowIdx);
    return true;
  };
  const anchorsTaken: number[] = [];
  for (const anchor of picked) {
    if (takeRow(anchor.rowIdx)) anchorsTaken.push(anchor.rowIdx);
  }
  if (anchorsTaken.length === 0) return undefined;
  for (const rowIdx of anchorsTaken) {
    if (rowIdx > 0) takeRow(rowIdx - 1);
    if (rowIdx + 1 < rows.length) takeRow(rowIdx + 1);
  }

  const runs: { startIdx: number; endIdx: number }[] = [];
  for (const rowIdx of [...shown].sort((a, b) => a - b)) {
    const last = runs[runs.length - 1];
    if (last !== undefined && rowIdx === last.endIdx) last.endIdx = rowIdx + 1;
    else runs.push({ startIdx: rowIdx, endIdx: rowIdx + 1 });
  }
  return { runs, scanned: rows.length, shown: shown.size };
}
