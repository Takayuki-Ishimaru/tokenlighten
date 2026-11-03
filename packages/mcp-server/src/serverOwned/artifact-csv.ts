// artifact-csv — extracted implementation; imports point to the owning modules.
import type { CsvTableResult } from "../office/csv.js";
import type { SmallFileContentMode } from "../tools/readCodeSmallFile.js";
import { SERVED_CONTENT_RECEIPT_NOTE } from "./read-receipts.js";
import { beginServeCall } from "../state/session.js";
import { recordServedRange } from "../state/session.js";
import { servedRangeReceipt } from "../state/session.js";
import { shortSha } from "../util/handles.js";

export function parseSmallFileContent(value: unknown): { ok: true; value: SmallFileContentMode | undefined } | { ok: false } {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === "full" || value === "outline" || value === "defer" || value === "auto") {
    return { ok: true, value };
  }
  return { ok: false };
}

/**
 * DESIGN-v0.8 §C3: `comments` escape for read_code full/slice/symbol/auto.
 * Default (undefined or "elide") collapses multi-line doc/comment blocks via
 * elideDocComments; "keep" serves the content unelided. Any other value is
 * rejected (mirrors parseSmallFileContent's strict-enum shape) rather than
 * silently defaulting, so a typo'd value surfaces instead of silently
 * changing behavior.
 */
export function parseCommentsMode(value: unknown): { ok: true; keep: boolean } | { ok: false } {
  if (value === undefined || value === "elide") return { ok: true, keep: false };
  if (value === "keep") return { ok: true, keep: true };
  return { ok: false };
}

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

// Hard read caps for body-returning paths (Phase 4).
// 2026-07-16a: raised 12288 -> 81920 so a ~70KB single-class file (live
// bench evidence) serves in ONE mode=full call instead of five 8KB slices — an
// extra API turn costs far more (~$0.03, ~100k cache-read tokens) than
// serving tens of KB more content (well under $0.01) ever does.
// READ_SYMBOL_CAP_BYTES now lives in readCodeModes.ts (imported above) — no
// longer duplicated here.
//
// NOTE: this briefly exceeded READ_FULL_CAP_BYTES_ALLOW_FULL before the same
// wave raised that constant below (see its own comment). Independently, this
// value also makes the C5 auto-allow-under-LARGE_BYTES window further down
// structurally unreachable, since LARGE_BYTES=24576 < 81920 — any file that
// still exceeds the new default cap also exceeds LARGE_BYTES.
export const READ_FULL_CAP_BYTES = 81920;

// A6 (reports/bench/2026-07-02a): mode=full allowFull:true previously hit
// READ_FULL_CAP_BYTES before decideFullRead (the only place allowFull is
// honored) ever ran, so allowFull could never help — an agent retrying the
// identical call got an identical refusal. allowFull:true now raises the
// effective byte ceiling to this higher bound; the governor's per-path/
// per-task anti-abuse caps still apply on top of it (allowFull bypasses only
// the per-task cap, per fullGovernor.ts — one full read per unchanged path
// remains enforced). Kept STRICTLY ABOVE READ_FULL_CAP_BYTES so allowFull
// always raises the ceiling — 81920 briefly exceeded the old 65536, which
// inverted the invariant for 64-80KB files (2026-07-16a wave review).
export const READ_FULL_CAP_BYTES_ALLOW_FULL = 131072;

// ---------------------------------------------------------------------------
// CSV / TSV artifact response helpers (shared by mode=artifact's csv branch
// and the size-gated auto/skeleton/symbol csv route). Mirrors the xlsx artifact
// response shape (handle + short sha + columns/rows/range/truncated), plus the
// csv-specific total_rows/total_columns/dialect and honest-truncation `note`.
// ---------------------------------------------------------------------------

/**
 * Project a csvTable success into the mode=artifact kind:"csv" wire shape.
 *
 * `file_range` (round-18A finding 1 / ruling (v)): the PHYSICAL file line span
 * `csvTable` computed for these rows, carried on the wire so
 * `protocol/envelope.ts`'s `servedWindowsOf` csv clause corroborates the SAME
 * coordinates `bookCsvArtifactServe` stages below — never `range`'s logical
 * row numbers, which diverge from file lines whenever the file has a blank
 * line or a quoted multi-line field. Omitted when `csvTable` could not
 * establish a reliable mapping (fail-closed): the response still ships the
 * rows (this is a serve, not a booking decision), it simply cannot be
 * corroborated or re-claimed by a receipt.
 */
export function csvArtifactShape(
  table: CsvTableResult,
  identity: { path: string; handle: string; sha: string },
  queryWindow?: { note?: string; selectedBy?: "query" | "sparse"; snapshot?: { handle: string; takenAtMs: number }; source?: Record<string, unknown>; rowSpans?: Array<{ range: string; file_range: string; rows: number }>; counts?: { total: number; scanned: number; shown: number } },
): Record<string, unknown> {
  return {
    mode: "artifact",
    kind: "csv",
    path: identity.path,
    handle: identity.handle,
    sha: shortSha(identity.sha), // C10.1: short display prefix; handle minted on the FULL sha.
    range: table.range,
    columns: table.columns,
    rows: table.rows,
    truncated: table.truncated,
    total_rows: table.total_rows,
    total_columns: table.total_columns,
    dialect: table.dialect,
    warnings: table.warnings,
    ...(queryWindow?.note !== undefined ? { note: queryWindow.note } : table.note ? { note: table.note } : {}),
    ...(queryWindow?.selectedBy !== undefined ? { selected_by: queryWindow.selectedBy } : {}),
    ...(queryWindow?.rowSpans !== undefined ? { row_spans: queryWindow.rowSpans } : {}),
    ...(queryWindow?.counts !== undefined ? { counts: queryWindow.counts } : {}),
    ...(queryWindow?.snapshot !== undefined ? { snapshot: { handle: queryWindow.snapshot.handle, taken_at_ms: queryWindow.snapshot.takenAtMs } } : {}),
    ...(queryWindow?.source !== undefined ? { source: queryWindow.source } : {}),
    ...(table.fileLineRange !== undefined ? { file_range: table.fileLineRange } : {}),
  };
}

/**
 * FX-O2 (ruling (s), 2026-09-03, round-17 finding 3 / INV-G row 48): stage the
 * served-range ledger for a CSV/TSV `read.artifact` response, the exact triad
 * every other honest TEXT serve uses (`beginServeCall` + `recordServedRange`).
 *
 * BEFORE this fix, every CSV/TSV artifact route (the explicit `range`/
 * `columns` selector, the no-selector bounded head below, and the size-gated
 * implicit-artifact auto-read further down in this file) shipped real
 * row/column bytes and booked NOTHING (`r17_g.mts`): an identical re-read
 * re-shipped the whole table with no receipt, and `tl_edit_file` on the same
 * file refused `execution-typestate` immediately after the server had just
 * served its content — the T09/T10 direction this ledger exists to prevent.
 *
 * CSV/TSV is TEXT an `tl_edit_file` search/replace CAN target directly, unlike
 * xlsx/docx/pptx/pdf (OOXML/PDF bytes an edit cannot search/replace against
 * at all — those stay on `recordArtifactServedRange`'s separate sheet/range
 * dedup ledger ONLY, and must never gain text edit authority here). This is
 * the dividing line ruling (s) draws between "text artifacts" and "binary
 * containers".
 *
 * round-18A finding 1 / DESIGN-v0.15 ruling (v) (2026-09-03): this books
 * `table.fileLineRange` — the PHYSICAL file line span `csvTable` computed for
 * the shipped rows — NEVER `table.range`'s logical row numbers. The two
 * coincide only in the ordinary case (no blank lines, no quoted multi-line
 * field at or before the served window); a csv with either books LOGICAL row
 * N as FILE line N, which is a different, generally SMALLER-numbered line —
 * over-claiming a `code-unchanged` receipt for file lines that were never on
 * the wire (measured: `scratchpad/r18/a3_csv.mts`, `r18/b_csv_blank.mts`).
 * `totalLines` is the file's own physical line count (`countLines`, the same
 * function `tl_edit_file`'s bounds check uses), clamped up to at least `end` so
 * a parse-time quota (rare, huge/adversarial input) can never mint an
 * out-of-bounds span.
 *
 * Books NOTHING (fail-closed) when no row shipped (`table.rows.length === 0`
 * — the columns-only/`maxRows:0` final fallback) OR when `csvTable` could not
 * establish a reliable row→physical-line mapping (`table.fileLineRange ===
 * undefined` — see `csvTable`'s and `parseCsv`'s doc comments): a booking
 * this function cannot prove correct must not be made at all, per ruling (v).
 *
 * The wire carries the same `fileLineRange` as `file_range`
 * (`csvArtifactShape`) so `protocol/envelope.ts`'s `servedWindowsOf` csv
 * clause corroborates THESE coordinates, not `range`'s — the two producers
 * agree by construction because both read off `csvTable`'s own output.
 */
export function bookCsvArtifactServe(
  workspace: string,
  filePath: string,
  fileSha: string,
  totalLines: number,
  table: CsvTableResult,
): void {
  if (table.rows.length === 0 || table.fileLineRange === undefined) return;
  const parsed = /^(\d+)-(\d+)$/.exec(table.fileLineRange);
  if (parsed === null) return;
  const start = Number(parsed[1]);
  const end = Number(parsed[2]);
  if (!(start >= 1) || !(end >= start)) return;
  const serveCall = beginServeCall(workspace);
  recordServedRange(workspace, filePath, fileSha, start, end, Math.max(totalLines, end), {
    mode: "artifact",
    range: table.fileLineRange,
    call: serveCall,
  });
}

/**
 * FX-P1 (DESIGN-v0.15 ruling (u), 2026-09-03) — THE READER HALF OF THE CSV
 * LEDGER.
 *
 * Round-17 finding 3 measured two symptoms of one gap: an `tl_edit_file` refused
 * right after the server served a csv's rows, AND "an identical re-read
 * re-ships the whole table with no receipt". FX-O2 staged the booking and
 * FX-P1's `servedWindowsOf` clause makes it settle, which fixes the first.
 * This fixes the second: when the served-range ledger already proves the exact
 * rows this response would ship, say so instead of re-shipping them.
 *
 * Modelled on the xlsx artifact receipt a few hundred lines below (`mode`/
 * `kind`/`receipt`/`code_unchanged`/`summary`/`note`), not on
 * `servedContentReceipt`, so the two artifact routes answer a repeat in the
 * same wire vocabulary. `served_by` names the call that put the rows on the
 * wire, exactly as every other receipt does.
 *
 * Returns `undefined` — i.e. serve the rows — whenever the ledger cannot prove
 * this exact window, when nothing shipped (`rows.length === 0`, the
 * columns-only fallback), when `csvTable` could not establish a reliable
 * row→physical-line mapping (`table.fileLineRange === undefined` —
 * round-18A finding 1 / ruling (v): fail-closed, never fall back to `range`'s
 * logical numbers), or when the caller asked for a forced serve
 * (`allowFull` / `force_serve` — DESIGN-v0.15 §6.3 (R6): canonical
 * `content:"full"` alone no longer forces one), which is the documented
 * recovery for a compacted context and must never be answered with a receipt.
 */
export function csvArtifactServeReceipt(
  workspace: string,
  identity: { path: string; handle: string; sha: string },
  totalLines: number,
  table: CsvTableResult,
  forceServe: boolean,
): Record<string, unknown> | undefined {
  if (forceServe || table.rows.length === 0 || table.fileLineRange === undefined) return undefined;
  const parsed = /^(\d+)-(\d+)$/.exec(table.fileLineRange);
  if (parsed === null) return undefined;
  const start = Number(parsed[1]);
  const end = Number(parsed[2]);
  if (!(start >= 1) || !(end >= start)) return undefined;
  const ledger = servedRangeReceipt(workspace, identity.path, identity.sha, start, end, Math.max(totalLines, end));
  if (ledger === undefined) return undefined;
  // THE IDENTICAL WINDOW, NOT MERELY A COVERED ONE — and this narrowing was
  // measured. `servedRangeReceipt` answers "are these lines subsumed by what
  // this session served", which is true of any SUB-window of an earlier serve:
  // the replay corpus's `csa1`/`csa2` pair (a full 120-row artifact, then an
  // explicit `range:"2-3"` of the same file) would flip from `read.artifact` to
  // `read.receipt`, moving a pinned wire baseline for a call the caller asked
  // to be narrowed. A receipt for the row window this response would itself
  // ship is the honest, byte-identical-preserving rule: the table this call
  // built is exactly a window the ledger already records as one cluster.
  // (round-18A finding 1) compared in PHYSICAL file-line coordinates —
  // `table.fileLineRange`, the same value the ledger itself was fed above —
  // never `table.range`'s logical numbers.
  if (!ledger.served.includes(table.fileLineRange)) return undefined;
  return {
    mode: "artifact",
    kind: "csv",
    path: identity.path,
    handle: identity.handle,
    sha: shortSha(identity.sha),
    range: table.range,
    file_range: table.fileLineRange,
    receipt: "code-unchanged",
    code_unchanged: true,
    ...(ledger.served_by !== undefined ? { served_by: ledger.served_by } : {}),
    summary: { served: ledger.served, ...(ledger.unserved.length > 0 ? { unserved: ledger.unserved } : {}), complete: ledger.complete },
    note: SERVED_CONTENT_RECEIPT_NOTE,
  };
}

/**
 * Test-only seam for {@link bookCsvArtifactServe}. The real call sites run
 * inside a full `read.artifact` response whose settlement (per ruling (s))
 * depends on `protocol/envelope.ts`'s `servedWindowsOf` recognizing a csv
 * artifact's `rows`/`columns` shape — a recognition clause that file does not
 * carry yet (see `bookCsvArtifactServe`'s doc comment and the fix report).
 * This export lets a spec exercise the STAGING half in isolation, before that
 * settlement gap closes, by calling it directly and reading the ledger back
 * (via `servedRangeReceipt`/`recordServedRange`'s own return value) BEFORE any
 * `settleServedCallBookings` call would retract an uncorroborated span.
 */
export function bookCsvArtifactServeForTest(
  workspace: string,
  filePath: string,
  fileSha: string,
  totalLines: number,
  table: CsvTableResult,
): void {
  bookCsvArtifactServe(workspace, filePath, fileSha, totalLines, table);
}

/** What each run of a sparse view adds to a response, at its widest. */
export const SPARSE_RUN_RESERVE_BYTES = 72;

export const SPARSE_MAX_RUNS = 8;
