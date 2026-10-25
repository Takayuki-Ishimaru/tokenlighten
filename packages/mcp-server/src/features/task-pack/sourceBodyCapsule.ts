/** A bounded proof that a final-wire body was an exact contiguous source slice. */
export interface SourceBodyCapsule {
  readonly path: string;
  readonly sha: string;
  readonly handle: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly body: string;
}

const MAX_CAPSULE_BODY_BYTES = 18 * 1024;

function lineStartOffsets(source: string): number[] {
  const offsets = [0];
  for (let i = 0; i < source.length; i += 1) {
    if (source.charCodeAt(i) === 13) {
      if (source.charCodeAt(i + 1) === 10) i += 1;
      offsets.push(i + 1);
    } else if (source.charCodeAt(i) === 10) {
      offsets.push(i + 1);
    }
  }
  return offsets;
}

function parseRange(range: string): {start: number; end: number} | undefined {
  const match = range.match(/^(\d+)-(\d+)$/);
  if (!match) return undefined;
  const start = Number(match[1]), end = Number(match[2]);
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start > 0 && end >= start
    ? {start, end} : undefined;
}

function overlaps(a: {start: number; end: number}, b: {start: number; end: number}): boolean {
  return a.start <= b.end && b.start <= a.end;
}

/**
 * Accept only a body's exact source prefix beginning at the declared range.
 * Partial rows are safe when their emitted bytes are verifiably that prefix;
 * gaps, elisions, appended windows, and transformed text fail closed.
 */
export function makeSourceBodyCapsule(input: {
  path: string;
  handle: string;
  range: string;
  body: string;
  source: string;
  sha: string;
  remainingRanges?: readonly string[];
  hasAppendedWindows?: boolean;
}): SourceBodyCapsule | undefined {
  if (!input.path || !input.handle || !input.sha || !input.body
    || Buffer.byteLength(input.body, "utf8") > MAX_CAPSULE_BODY_BYTES
    || input.hasAppendedWindows === true) return undefined;
  const span = parseRange(input.range);
  if (!span) return undefined;
  const starts = lineStartOffsets(input.source);
  const bodyStart = starts[span.start - 1];
  if (bodyStart === undefined || input.source.slice(bodyStart, bodyStart + input.body.length) !== input.body) return undefined;
  const bodyEnd = bodyStart + input.body.length;
  let endLine: number;
  const boundary = starts.indexOf(bodyEnd);
  if (boundary >= 0) {
    endLine = boundary;
  } else if (input.source[bodyEnd] === "\n" || input.source[bodyEnd] === "\r") {
    // Some wire projections omit the line terminator from the last body line.
    // Accept only the exact source position immediately before its separator.
    endLine = input.source.slice(0, bodyEnd).split(/\r\n|\r|\n/).length;
  } else if (bodyEnd === input.source.length && !input.source.endsWith("\n")) {
    endLine = input.source.split(/\r\n|\r|\n/).length;
  } else {
    return undefined;
  }
  if (endLine < span.start || endLine > span.end) return undefined;
  const delivered = {start: span.start, end: endLine};
  for (const value of input.remainingRanges ?? []) {
    const gap = parseRange(value);
    if (!gap || overlaps(delivered, gap)) return undefined;
  }
  return Object.freeze({path: input.path, sha: input.sha, handle: input.handle,
    startLine: delivered.start, endLine: delivered.end, body: input.body});
}

export function sourceCapsuleCovers(prior: SourceBodyCapsule, current: SourceBodyCapsule): boolean {
  return prior.path === current.path && prior.sha === current.sha
    && prior.startLine <= current.startLine && prior.endLine >= current.endLine
    && prior.body.includes(current.body);
}
