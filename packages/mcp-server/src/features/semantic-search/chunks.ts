import type {SemanticSource} from "./index.js";

export interface TextWindow {
  source: SemanticSource; startLine: number; endLine: number;
  startOffset: number; endOffset: number; text: string;
}
export interface ScoredWindow extends TextWindow { score: number }
interface SourceLine { start: number; end: number; next: number; line: number }
export interface DeclarationSpan { startLine: number; endLine: number }
const CHARS = 1200, LINES = 32, MERGE_LINES = 96, MERGE_BYTES = 16 * 1024;
function sourceLines(source: SemanticSource): SourceLine[] {
  const out: SourceLine[] = [], text = source.text;
  let from = 0, line = source.startLine ?? 1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "\n" && text[i] !== "\r") continue;
    const end = i;
    if (text[i] === "\r" && text[i + 1] === "\n") i++;
    out.push({start: from, end, next: i + 1, line: line++}); from = i + 1;
  }
  if (from < text.length) out.push({start: from, end: text.length, next: text.length, line});
  return out;
}
function windowOf(source: SemanticSource, startOffset: number, endOffset: number, startLine: number, endLine: number): TextWindow {
  return {source, startOffset, endOffset, startLine, endLine, text: source.text.slice(startOffset, endOffset)};
}
/** Every source character belongs to one bounded embedding input; never cut a surrogate pair. */
export function* chunkSource(source: SemanticSource): Generator<TextWindow> {
  const lines = sourceLines(source);
  for (let i = 0; i < lines.length;) {
    const first = lines[i]!;
    if (first.next - first.start > CHARS) {
      for (let at = first.start; at < first.end;) {
        let end = Math.min(first.end, at + CHARS - 2);
        if (end < first.end && /[\uD800-\uDBFF]/.test(source.text[end - 1]!) && /[\uDC00-\uDFFF]/.test(source.text[end]!)) end--;
        if (end === first.end) end = first.next;
        yield windowOf(source, at, end, first.line, first.line);
        at = end;
      }
      i++; continue;
    }
    let j = i + 1;
    while (j < lines.length && j - i < LINES && lines[j]!.next - first.start <= CHARS) j++;
    const last = lines[j - 1]!;
    yield windowOf(source, first.start, last.next, first.line, last.line);
    i = j;
  }
}
const compare = (a: ScoredWindow, b: ScoredWindow): number => b.score - a.score
  || a.source.path.localeCompare(b.source.path) || a.startOffset - b.startOffset || a.endOffset - b.endOffset;
function bounded(window: TextWindow): boolean {
  return window.endLine - window.startLine + 1 <= MERGE_LINES && Buffer.byteLength(window.text) <= MERGE_BYTES;
}
/** Expand only a containing declaration: an expansion must never discard part of its seed. */
function expand(window: ScoredWindow, spans: readonly DeclarationSpan[]): ScoredWindow {
  const span = spans.filter(s => s.startLine <= window.startLine && s.endLine >= window.endLine)
    .sort((a, b) => a.endLine - a.startLine - (b.endLine - b.startLine))[0];
  if (!span) return window;
  const lines = sourceLines(window.source), first = lines.find(l => l.line === span.startLine), last = lines.find(l => l.line === span.endLine);
  if (!first || !last) return window;
  const expanded = windowOf(window.source, first.start, last.next, span.startLine, span.endLine);
  return bounded(expanded) ? {...expanded, score: window.score} : window;
}
/** Rank seeds before merging. Joining every scored partition would reconstruct whole files. */
export function selectWindows(all: readonly ScoredWindow[], limit: number,
  declarations: ReadonlyMap<SemanticSource, readonly DeclarationSpan[]> = new Map()): ScoredWindow[] {
  if (limit <= 0) return [];
  const seeds = [...all].sort(compare).slice(0, Math.min(64, limit * 2)).map(w => expand(w, declarations.get(w.source) ?? []));
  const groups = new Map<SemanticSource, ScoredWindow[]>();
  for (const seed of seeds) { const group = groups.get(seed.source) ?? []; group.push(seed); groups.set(seed.source, group); }
  const merged: ScoredWindow[] = [];
  for (const [source, group] of groups) {
    group.sort((a, b) => a.startOffset - b.startOffset || a.endOffset - b.endOffset);
    const joined: ScoredWindow[] = [];
    for (const item of group) {
      const prior = joined.at(-1);
      if (prior && item.startOffset <= prior.endOffset) {
        const union = windowOf(source, prior.startOffset, Math.max(prior.endOffset, item.endOffset), prior.startLine, Math.max(prior.endLine, item.endLine));
        if (bounded(union)) { joined[joined.length - 1] = {...union, score: Math.max(prior.score, item.score)}; continue; }
      }
      joined.push(item);
    }
    merged.push(...joined);
  }
  return merged.sort(compare).slice(0, limit);
}
