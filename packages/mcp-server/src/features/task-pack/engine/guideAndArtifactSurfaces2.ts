// guideAndArtifactSurfaces — extracted implementation; imports point to the owning modules.


/**
 * What to add to a window's logical row number to get its file line, when that holds
 * for every row of the window, so any cut of it can still name its lines. A blank line
 * or a multi-line field inside the window has no such number.
 */
export function csvWindowLineOffset(
  model: { readonly dataSpans: ReadonlyArray<readonly [number, number]>; readonly firstDataRow: number },
  window: { readonly startIdx: number; readonly endIdx: number },
): number | undefined {
  const offset = model.dataSpans[window.startIdx]![0] - (model.firstDataRow + window.startIdx);
  for (let index = window.startIdx; index < window.endIdx; index += 1) {
    const [start, end] = model.dataSpans[index]!;
    if (start !== end || start !== model.firstDataRow + index + offset) return undefined;
  }
  return offset;
}

export interface GenericTaskPackFallback {
  attempted: boolean;
  paths: string[];
  probe?: string;
}
