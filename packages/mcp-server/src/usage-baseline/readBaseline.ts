/**
 * Native-read baseline for the usage recorder (`tl_read_file` only).
 *
 * The usage summary reports "tokens saved" as `baseline - TL response`, so the
 * baseline has to be what a NATIVE agent would have read to get the same
 * material. Until v0.16.3 it was the whole-file size of every requested path,
 * whether the call asked for the whole file, a line range, a symbol or a handle
 * slice. A native agent (an editor Read with offset/limit after a grep) reads
 * only the range, so a ranged TL read was credited with the entire file: a
 * field report showed "about 71.5k tokens saved" on a task where TL had read
 * about twice as many bytes as the no-TL run.
 *
 * What this module measures, per requested path:
 *
 * - whole-file read (no range, no symbol, a handle with no stored window, or a
 *   window that covers every line): the file's byte size, counted once per path
 *   per lane (the caller's `credited` ledger), method `"file-bytes"`;
 * - ranged read (`range`, `ranges[]`, legacy `lines`/`start`+`end`, or the
 *   window a handle was minted with): the bytes of exactly those lines, never
 *   credited a second time as "whole file", method `"range-bytes"`;
 * - symbol read: the bytes of the symbol window the server SERVED. That window
 *   is only known from the response, so the symbol entry is reported as
 *   `pendingSymbols` and settled by `settleSymbolBaselines` once the result
 *   exists; an unsettled symbol contributes nothing (never the whole file);
 * - anything this module cannot size (unparsable range, file too large to
 *   scan, a path outside the workspace) contributes nothing. Under-crediting is
 *   the safe direction for a savings estimate.
 *
 * A call that names no path or resolvable handle (a query-only task_pack, a
 * bare cursor) has no baseline: `bytes` and `method` are null.
 *
 * Pure apart from reading the named files: no server state is imported, so the
 * handle table and the per-lane credited ledger are passed in.
 */

import { readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import type { TokenLightenBaselineMethod } from "@tokenlighten/types";
import { wholeOrOpenEndedRange } from "../util/rangeWords.js";

/** Files above this size are not scanned for a range/symbol baseline. */
export const MAX_SCANNED_BASELINE_FILE_BYTES = 16 * 1024 * 1024;

/** The stored window of a handle, as far as baseline measurement needs it. */
export interface BaselineHandle {
  path?: string;
  range?: string;
  symbol?: string;
}

/** One served file window (1-based inclusive lines), as the response declares it. */
export interface ServedBaselineWindow {
  path: string;
  start: number;
  end: number;
}

/** A symbol-addressed path whose served window is only known from the response. */
export interface PendingSymbolBaseline {
  /** Credited-ledger style key (normalized absolute path, lowercased on win32). */
  key: string;
  absolute: string;
}

export interface ReadBaselineMeasurement {
  /** Bytes a native read of the same files/ranges would return; null = nothing measurable. */
  bytes: number | null;
  /** `"range-bytes"` when any measured path was a ranged/symbol/handle slice; null iff `bytes` is null. */
  method: TokenLightenBaselineMethod | null;
  /** Whole-file keys this call adds to the credited ledger once it succeeds. */
  uncreditedPaths: string[];
  /** Symbol reads awaiting `settleSymbolBaselines` with the served windows. */
  pendingSymbols: PendingSymbolBaseline[];
}

export interface MeasureReadBaselineOptions {
  /** Absolute workspace root the request paths resolve against. */
  workspace: string;
  /** Legacy-dialect `tl_read_file` args, as `callToolTraced` sees them. */
  args: Readonly<Record<string, unknown>>;
  /** Whole-file keys already credited in this lane (a repeat read credits 0). */
  credited?: ReadonlySet<string>;
  /** Looks a handle up in the caller's table; undefined when unknown or foreign. */
  resolveHandle?: (handle: string) => BaselineHandle | undefined;
  /** Per-item range/symbol overrides of an all-handle `handles[]` batch. */
  handleOverrides?: ReadonlyArray<Readonly<Record<string, unknown>> | undefined>;
  /** Test seam for `MAX_SCANNED_BASELINE_FILE_BYTES`. */
  maxScannedFileBytes?: number;
}

export function emptyReadBaseline(): ReadBaselineMeasurement {
  return { bytes: null, method: null, uncreditedPaths: [], pendingSymbols: [] };
}

/** The key the credited ledger uses for a path (matches the pre-0.16.4 key). */
export function baselinePathKey(absolute: string): string {
  return process.platform === "win32"
    ? path.normalize(absolute).toLowerCase()
    : path.normalize(absolute);
}

// ---------------------------------------------------------------------------
// Range specs
// ---------------------------------------------------------------------------

/** `N`, `N-M`, `N,M`, `N:M`, each bound with an optional `L` prefix. */
const RANGE_SPEC = /^[Ll]?\s*(\d+)\s*(?:[-,:]\s*[Ll]?\s*(\d+))?$/;

/**
 * Resolve one `range` spelling to inclusive 1-based `[start, end]` for a file
 * of `totalLines` lines. Accepts every spelling the slice reader accepts or the
 * input normalizer rewrites: `N-M`, `N`, `LN-LM`, `N,M`, `N:M`, `N-`/`N-end`,
 * and the whole-file words (`full`, `all`, `whole`, `entire`, `*`). The end is
 * NOT clamped here (a start past EOF stays a start past EOF); undefined for
 * anything unparsable or reversed.
 */
export function parseBaselineRange(
  raw: unknown,
  totalLines: number,
): [number, number] | undefined {
  if (typeof raw === "number") raw = Number.isFinite(raw) ? String(Math.trunc(raw)) : "";
  if (typeof raw !== "string") return undefined;
  const spec = (wholeOrOpenEndedRange(raw, totalLines) ?? raw).trim();
  const match = RANGE_SPEC.exec(spec);
  if (match === null) return undefined;
  const start = Number(match[1]);
  const end = match[2] === undefined ? start : Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return undefined;
  if (start < 1 || end < start) return undefined;
  return [start, end];
}

/**
 * Byte offsets of each line start in `buffer`, plus an end sentinel, so
 * `starts[end] - starts[start - 1]` is the byte length of lines `start..end`
 * (terminators included). A trailing newline ends its line rather than opening
 * an empty one, matching `countLines`; an empty buffer has zero lines.
 */
function lineStartOffsets(buffer: Buffer): number[] {
  if (buffer.length === 0) return [0];
  const starts = [0];
  let position = 0;
  for (;;) {
    const newline = buffer.indexOf(0x0a, position);
    if (newline === -1 || newline === buffer.length - 1) break;
    starts.push(newline + 1);
    position = newline + 1;
  }
  starts.push(buffer.length);
  return starts;
}

/** Merge inclusive line windows (clamped to `1..totalLines`) and sum their bytes. */
function windowBytes(
  starts: readonly number[],
  windows: ReadonlyArray<readonly [number, number]>,
): { bytes: number; lines: number } {
  const totalLines = starts.length - 1;
  const clipped = windows
    .filter(([start]) => start >= 1 && start <= totalLines)
    .map(([start, end]) => [start, Math.min(end, totalLines)] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  let bytes = 0;
  let lines = 0;
  let current: [number, number] | undefined;
  const flush = (): void => {
    if (current === undefined) return;
    bytes += starts[current[1]]! - starts[current[0] - 1]!;
    lines += current[1] - current[0] + 1;
  };
  for (const window of clipped) {
    if (current !== undefined && window[0] <= current[1] + 1) {
      current[1] = Math.max(current[1], window[1]);
    } else {
      flush();
      current = [window[0], window[1]];
    }
  }
  flush();
  return { bytes, lines };
}

// ---------------------------------------------------------------------------
// Request shapes
// ---------------------------------------------------------------------------

interface BaselineRequest {
  path?: string;
  handle?: string;
  ranges: string[];
  symbol?: string;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * The window a request object addresses: `range`, the legacy `lines` /
 * `start`+`end` spellings, and `ranges[]`, plus `symbol`.
 */
function windowOf(record: Readonly<Record<string, unknown>>): Pick<BaselineRequest, "ranges" | "symbol"> {
  const ranges: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === "number" && Number.isFinite(value)) ranges.push(String(value));
    else {
      const text = nonEmptyString(value);
      if (text !== undefined) ranges.push(text.trim());
    }
  };
  push(record["range"]);
  if (ranges.length === 0) push(record["lines"]);
  if (ranges.length === 0 && record["start"] !== undefined && record["end"] !== undefined) {
    push(`${String(record["start"])}-${String(record["end"])}`);
  }
  if (Array.isArray(record["ranges"])) for (const item of record["ranges"]) push(item);
  const symbol = nonEmptyString(record["symbol"]);
  return { ranges, ...(symbol !== undefined ? { symbol } : {}) };
}

function handleListOf(value: unknown): string[] {
  const items = typeof value === "string"
    ? value.split(",")
    : Array.isArray(value) ? value : [];
  return items
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item !== "");
}

/**
 * Every addressed read in a legacy-dialect `tl_read_file` call: the top-level
 * `path`/`handle` with its own window, an all-handle `handles[]` batch (windows
 * from `handleOverrides`), and `paths[]` items (bare strings, `{path, range,
 * ranges, symbol}` objects, bare `{handle}` objects).
 */
function requestsOf(
  args: Readonly<Record<string, unknown>>,
  handleOverrides: MeasureReadBaselineOptions["handleOverrides"],
): BaselineRequest[] {
  const requests: BaselineRequest[] = [];
  const topPath = nonEmptyString(args["path"]);
  const topHandle = nonEmptyString(args["handle"]);
  if (topPath !== undefined || topHandle !== undefined) {
    requests.push({
      ...(topPath !== undefined ? { path: topPath } : {}),
      ...(topHandle !== undefined ? { handle: topHandle } : {}),
      ...windowOf(args),
    });
  }
  handleListOf(args["handles"]).forEach((handle, index) => {
    requests.push({ handle, ...windowOf(handleOverrides?.[index] ?? {}) });
  });
  if (Array.isArray(args["paths"])) {
    for (const item of args["paths"]) {
      if (typeof item === "string") {
        if (item !== "") requests.push({ path: item, ranges: [] });
        continue;
      }
      const record = recordOf(item);
      if (record === undefined) continue;
      const itemPath = nonEmptyString(record["path"]);
      const itemHandle = nonEmptyString(record["handle"]);
      if (itemPath === undefined && itemHandle === undefined) continue;
      requests.push({
        ...(itemPath !== undefined ? { path: itemPath } : {}),
        ...(itemHandle !== undefined ? { handle: itemHandle } : {}),
        ...windowOf(record),
      });
    }
  }
  return requests;
}

/**
 * Fold a handle's stored window into its request. A live handle names the path
 * and, unless the caller restated a range/symbol of its own, the window it was
 * minted with (a symbol handle also stores the symbol's body range, which is
 * exactly what a native ranged read would return). A handle with no stored
 * window and no path of its own is not measurable: undefined.
 */
function resolvedRequest(
  request: BaselineRequest,
  resolveHandle: MeasureReadBaselineOptions["resolveHandle"],
): { path: string; ranges: string[]; symbol?: string } | undefined {
  let { path: requestPath, ranges, symbol } = request;
  if (request.handle !== undefined) {
    const stored = resolveHandle?.(request.handle);
    if (stored !== undefined && stored.path !== undefined && stored.path !== "") {
      requestPath = stored.path;
      if (ranges.length === 0 && symbol === undefined) {
        if (stored.range !== undefined && stored.range !== "") ranges = [stored.range];
        else if (stored.symbol !== undefined && stored.symbol !== "") symbol = stored.symbol;
      }
    } else if (requestPath === undefined) {
      return undefined;
    }
  }
  if (requestPath === undefined || requestPath === "") return undefined;
  // A handle-only request with no window anywhere is a bare continuation, not a
  // measurable read: keep it unmeasured, exactly as before handles were sized.
  if (request.handle !== undefined && request.path === undefined
    && ranges.length === 0 && symbol === undefined) {
    return undefined;
  }
  return { path: requestPath, ranges, ...(symbol !== undefined ? { symbol } : {}) };
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

/** Bytes of `specs` in the file at `absolute`; undefined when it cannot be scanned. */
function scanRangeBaseline(
  absolute: string,
  specs: readonly string[],
): { bytes: number; coversWholeFile: boolean } | undefined {
  let buffer: Buffer;
  try {
    buffer = readFileSync(absolute);
  } catch {
    return undefined;
  }
  const starts = lineStartOffsets(buffer);
  const totalLines = starts.length - 1;
  const windows: Array<[number, number]> = [];
  for (const spec of specs) {
    const parsed = parseBaselineRange(spec, totalLines);
    if (parsed !== undefined) windows.push(parsed);
  }
  const { bytes, lines } = windowBytes(starts, windows);
  return { bytes, coversWholeFile: totalLines > 0 && lines >= totalLines };
}

export function measureReadBaseline(options: MeasureReadBaselineOptions): ReadBaselineMeasurement {
  const { workspace, args } = options;
  const credited = options.credited ?? new Set<string>();
  const maxScanned = options.maxScannedFileBytes ?? MAX_SCANNED_BASELINE_FILE_BYTES;

  let bytes = 0;
  let measured = 0;
  let sliced = false;
  const uncreditedPaths: string[] = [];
  const pendingSymbols: PendingSymbolBaseline[] = [];
  const seenWholeFiles = new Set<string>();

  for (const request of requestsOf(args, options.handleOverrides)) {
    const resolved = resolvedRequest(request, options.resolveHandle);
    if (resolved === undefined) continue;
    const absolute = path.resolve(workspace, resolved.path);
    const relative = path.relative(workspace, absolute);
    if (
      relative === ".."
      || relative.startsWith(`..${path.sep}`)
      || path.isAbsolute(relative)
    ) {
      continue;
    }
    let size: number;
    try {
      const stat = statSync(absolute);
      if (!stat.isFile()) continue;
      size = stat.size;
    } catch {
      // Missing and virtual/archive paths simply have no measurable baseline.
      continue;
    }
    const key = baselinePathKey(absolute);

    if (resolved.symbol !== undefined) {
      // The served window is only known from the response (settleSymbolBaselines).
      measured++;
      sliced = true;
      if (!pendingSymbols.some((pending) => pending.key === key)) {
        pendingSymbols.push({ key, absolute });
      }
      continue;
    }
    if (resolved.ranges.length > 0) {
      // A window the file is too large to scan, or that cannot be read or
      // parsed, is measured as nothing: never fall back to the whole file.
      const scanned = size <= maxScanned
        ? scanRangeBaseline(absolute, resolved.ranges)
        : undefined;
      // Every line requested means a native agent reads the whole file: that is
      // a whole-file read (credited once per path, labelled file-bytes).
      if (scanned?.coversWholeFile !== true) {
        measured++;
        sliced = true;
        bytes += scanned?.bytes ?? 0;
        continue;
      }
    }

    measured++;
    if (credited.has(key) || seenWholeFiles.has(key)) continue;
    seenWholeFiles.add(key);
    bytes += size;
    uncreditedPaths.push(key);
  }

  return {
    bytes: measured > 0 ? bytes : null,
    method: measured > 0 ? (sliced ? "range-bytes" : "file-bytes") : null,
    uncreditedPaths,
    pendingSymbols,
  };
}

/**
 * Settle symbol reads once the response exists: each pending path is credited
 * the bytes of the windows the response served for it (`servedWindowsOf`'s
 * `{path, start, end}`), merged. Windows without a declared line range
 * (end = MAX_SAFE_INTEGER, "the whole file") are ignored for a symbol read: the
 * symbol was supposed to be a window, and a whole-file window here would
 * re-introduce the over-statement. No served window means 0 bytes.
 */
export function settleSymbolBaselines(
  measurement: ReadBaselineMeasurement,
  workspace: string,
  servedWindows: readonly ServedBaselineWindow[],
): ReadBaselineMeasurement {
  if (measurement.pendingSymbols.length === 0) return measurement;
  let extra = 0;
  for (const pending of measurement.pendingSymbols) {
    const windows: Array<[number, number]> = [];
    for (const served of servedWindows) {
      if (
        !Number.isSafeInteger(served.start)
        || !Number.isSafeInteger(served.end)
        || served.start < 1
        || served.end < served.start
        || served.end >= Number.MAX_SAFE_INTEGER
        || baselinePathKey(path.resolve(workspace, served.path)) !== pending.key
      ) {
        continue;
      }
      windows.push([served.start, served.end]);
    }
    if (windows.length === 0) continue;
    try {
      extra += windowBytes(lineStartOffsets(readFileSync(pending.absolute)), windows).bytes;
    } catch {
      // Unreadable now: the symbol contributes nothing.
    }
  }
  return {
    ...measurement,
    bytes: (measurement.bytes ?? 0) + extra,
    pendingSymbols: [],
  };
}
