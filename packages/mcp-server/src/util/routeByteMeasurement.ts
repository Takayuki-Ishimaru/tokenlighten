/**
 * R-4 direct wire-byte measurements for the E-3 route evidence table.
 *
 * This helper intentionally measures the serialized text at the same boundary
 * as protocol/budget/measure.ts. It is report instrumentation, not a budget
 * or decision input: callers provide the frozen baseline text and the text
 * actually served, and the result records both without rounding.
 */
export type ServedRoute =
  | "fresh"
  | "receipt"
  | "replay"
  | "verification-kit"
  | "budget-shed"
  | "post-ready-trim"
  | "dedup";

export interface RouteByteMeasurement {
  readonly route: ServedRoute;
  readonly beforeBytes: number;
  readonly afterBytes: number;
  readonly deltaBytes: number;
  readonly ratio: number;
}

/** Direct UTF-8 byte count used by R-4; never a character-count proxy. */
export function directUtf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** Measure one route's frozen before/after serialized wire texts. */
export function measureRouteBytes(
  route: ServedRoute,
  before: string,
  after: string,
): RouteByteMeasurement {
  const beforeBytes = directUtf8Bytes(before);
  const afterBytes = directUtf8Bytes(after);
  return {
    route,
    beforeBytes,
    afterBytes,
    deltaBytes: afterBytes - beforeBytes,
    ratio: beforeBytes === 0 ? 0 : afterBytes / beforeBytes,
  };
}

/** Preserve route order so the report table is stable across test runs. */
export function measureRouteTable(
  entries: ReadonlyArray<{ route: ServedRoute; before: string; after: string }>,
): RouteByteMeasurement[] {
  return entries.map(({ route, before, after }) => measureRouteBytes(route, before, after));
}
