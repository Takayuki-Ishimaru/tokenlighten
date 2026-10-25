/** Combine consecutive owed windows only across source lines that are blank. */
export interface BlankGapWindow { readonly path: string; readonly range: string }

export function coalesceBlankGapWindows(
  targets: readonly BlankGapWindow[],
  readContent: (path: string) => string | undefined,
  maxBytes: number,
): BlankGapWindow[] {
  const output: BlankGapWindow[] = [];
  const source = new Map<string, readonly string[] | undefined>();
  const linesFor = (path: string): readonly string[] | undefined => {
    if (!source.has(path)) source.set(path, readContent(path)?.split(/\r?\n/u));
    return source.get(path);
  };
  const boundsOf = (range: string, lines: readonly string[]): [number, number] | undefined => {
    const match = /^(\d+)-(\d+)$/u.exec(range);
    if (!match) return undefined;
    const start = Number(match[1]), end = Number(match[2]);
    return Number.isSafeInteger(start) && Number.isSafeInteger(end)
      && start > 0 && end >= start && end <= lines.length ? [start, end] : undefined;
  };
  for (const target of targets) {
    const prior = output[output.length - 1];
    const lines = prior?.path === target.path ? linesFor(target.path) : undefined;
    const left = prior && lines ? boundsOf(prior.range, lines) : undefined;
    const right = lines ? boundsOf(target.range, lines) : undefined;
    if (prior && lines && left && right && left[1] < right[0]
      && lines.slice(left[1], right[0] - 1).every(line => /^\s*$/u.test(line))
      && Buffer.byteLength(lines.slice(left[0] - 1, right[1]).join("\n"), "utf8") <= maxBytes) {
      output[output.length - 1] = {path: target.path, range: `${left[0]}-${right[1]}`};
    } else {
      output.push({path: target.path, range: target.range});
    }
  }
  return output;
}
