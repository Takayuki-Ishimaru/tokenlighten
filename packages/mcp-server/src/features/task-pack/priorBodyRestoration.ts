/** Re-hide only exact same-task prior bodies restored by an internal proof pass. */
type Row = Record<string, unknown>;
const shape = (row: Row): string => JSON.stringify([
  row.path, row.handle, row.range, row.remaining_ranges, row.appended_windows, row.content_completeness,
]);
export function createPriorBodyRestoration() {
  let prior = new WeakMap<object, {body: string; pointer: string; shape: string}>();
  return {
    reset(): void {prior = new WeakMap();},
    capture(surface: object, pointer: string): void {
      const row = surface as Row;
      if (typeof row.code === "string") prior.set(surface, {body: row.code, pointer, shape: shape(row)});
    },
    strip(surfaces: readonly object[], forceServe = false): void {
      if (forceServe) return;
      for (const surface of surfaces) {
        const row = surface as Row, origin = prior.get(surface);
        if (origin && row.code === origin.body && row.code_unchanged === origin.pointer
          && shape(row) === origin.shape) row.code = undefined;
      }
    },
  };
}
