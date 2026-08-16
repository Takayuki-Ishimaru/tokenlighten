/**
 * Line-delta computation for compact write-tool responses.
 */

function toLf(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function countNewlines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\n") n++;
  }
  return n;
}

export interface LineDelta {
  startLine: number;
  endLine: number;
  added: number;
  removed: number;
}

/**
 * Compute line range and delta for a search/replace edit.
 *
 * @param oldText  Full file content before the edit.
 * @param search   The matched search string.
 * @param replace  The replacement string.
 */
export function computeLineDelta(
  oldText: string,
  search: string,
  replace: string,
): LineDelta {
  const text = toLf(oldText);
  const s = toLf(search);
  const r = toLf(replace);

  const matchIdx = text.indexOf(s);
  const startLine = matchIdx >= 0 ? countNewlines(text.slice(0, matchIdx)) + 1 : 1;

  const removed = countNewlines(s) + 1;
  const added = countNewlines(r) + 1;
  const endLine = startLine + added - 1;

  return { startLine, endLine, added, removed };
}

export function formatDelta(added: number, removed: number): string {
  return `+${added}/-${removed}`;
}

export function formatLines(start: number, end: number): string {
  return start === end ? String(start) : `${start}-${end}`;
}
