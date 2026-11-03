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
  const offset = Math.max(0, matchIdx);
  let startLine = countNewlines(text.slice(0, offset)) + 1;
  // Count affected complete lines. Fragment newline counts add a phantom
  // line for a trailing LF and miss the two lines joined by deleting an LF.
  const lineStart = offset === 0 ? 0 : text.lastIndexOf("\n", offset - 1) + 1;
  const matchEnd = offset + s.length;
  const nextLf = text.indexOf("\n", matchEnd);
  const prefix = text.slice(lineStart, offset);
  const endsAtBoundary = s.endsWith("\n") && (prefix + r === "" || (prefix + r).endsWith("\n"));
  const lineEnd = endsAtBoundary ? matchEnd : nextLf < 0 ? text.length : nextLf + 1;
  const suffix = text.slice(matchEnd, lineEnd);
  const lines = (value: string): number => value === "" ? 0 : countNewlines(value) + (value.endsWith("\n") ? 0 : 1);
  const removed = s === r ? 0 : lines(prefix + s + suffix);
  const added = s === r ? 0 : lines(prefix + r + suffix);
  const finalLineCount = lines(text.slice(0, offset) + r + text.slice(matchEnd));
  startLine = Math.min(startLine, Math.max(1, finalLineCount));
  const endLine = Math.min(Math.max(1, finalLineCount), Math.max(startLine, startLine + added - 1));

  return { startLine, endLine, added, removed };
}

export function formatDelta(added: number, removed: number): string {
  return `+${added}/-${removed}`;
}

/** Exact line insertions/deletions, with a fixed work bound. Large unrelated
 * rewrites omit this optional display statistic rather than reporting a
 * whole-file replacement as a measured diff. Coordinates use separate logic. */
export function changedLineCounts(before: string, after: string): { added: number; removed: number } | undefined {
  const split = (text: string): string[] => toLf(text).match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const a = split(before);
  const b = split(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let aEnd = a.length;
  let bEnd = b.length;
  while (aEnd > start && bEnd > start && a[aEnd - 1] === b[bEnd - 1]) { aEnd--; bEnd--; }
  const removed = aEnd - start;
  const added = bEnd - start;
  if (removed === 0 || added === 0) return { added, removed };
  if (removed * added > 1_000_000) return undefined;
  const lengths = new Uint32Array(added + 1);
  for (let i = start; i < aEnd; i++) {
    let diagonal = 0;
    for (let j = 1; j <= added; j++) {
      const previous = lengths[j]!;
      lengths[j] = a[i] === b[start + j - 1] ? diagonal + 1 : Math.max(lengths[j]!, lengths[j - 1]!);
      diagonal = previous;
    }
  }
  const common = lengths[added]!;
  return { added: added - common, removed: removed - common };
}

export function formatLines(start: number, end: number): string {
  return start === end ? String(start) : `${start}-${end}`;
}
