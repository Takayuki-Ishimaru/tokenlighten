// artifact-csv — extracted implementation; imports point to the owning modules.
import type { CsvTableResult } from "../office/csv.js";
import type { LineWindow } from "@tokenlighten/types";
import type { SnapshotFailure } from "../state/snapshotStore.js";
import { CSV_PAGE_MAX_ROWS } from "../state/artifactReadRequest.js";
import { READ_SYMBOL_CAP_BYTES } from "../tools/readCodeModes.js";
import { SPARSE_MAX_RUNS } from "./artifact-csv.js";
import { SPARSE_RUN_RESERVE_BYTES } from "./artifact-csv.js";
import { artifactQueryTokens } from "../features/task-pack/engine/roleAndConcernScope2.js";
import { bookCsvArtifactServe } from "./artifact-csv.js";
import { chooseCsvRowPage } from "../office/csvWindow.js";
import { countLines } from "../util/countLines.js";
import { csvArtifactServeReceipt } from "./artifact-csv.js";
import { csvArtifactShape } from "./artifact-csv.js";
import { csvPageModel } from "../office/csv.js";
import { csvPageReserve } from "../state/artifactReadRequest.js";
import { csvQueryWindow } from "../office/csvWindow.js";
import { csvRowCostBytes } from "../office/csvWindow.js";
import { csvRowSpansAsWindows } from "../state/artifactReadRequest.js";
import { csvRowWindowHeld } from "../state/artifactReadRequest.js";
import { csvTable } from "../office/csv.js";
import { currentSessionLane } from "../util/laneKey.js";
import { declareKind } from "../protocol/envelope.js";
import { decodeCsvBytes } from "../office/csv.js";
import { estimateBytesFromTokens } from "../protocol/budget/wireBudget.js";
import { ledgerCoverage } from "../state/readRequestStore.js";
import { measureResponseBytes } from "../protocol/budget/measure.js";
import { mustFetchReadBudget } from "../util/mustFetch.js";
import { openReadRequest } from "../state/readRequestStore.js";
import { protocolCallContext } from "../protocol/envelope.js";
import { readBytesSafe } from "../util/safePath.js";
import { readSnapshotEnabled } from "../util/flags.js";
import { resolveSnapshot } from "../state/snapshotStore.js";
import { selectSparseRows } from "../office/sparseSelect.js";
import { shaOfBytes } from "../util/handles.js";
import { shortSha } from "../util/handles.js";
import { sparseSelectEnabled } from "../util/flags.js";
import { subtractWindows } from "../state/readRequestStore.js";
import { takeSnapshot } from "../state/snapshotStore.js";
import { toolOk } from "../protocol/result.js";
import { toolStructuredError } from "../protocol/result.js";

/**
 * A3 (TL_ARTIFACT_QUERY_WINDOW): the contiguous rows a query points at, as the
 * first page of a read request over the WHOLE table.
 *
 * `undefined` means "keep the ordinary head", and it is the answer for every case
 * this cannot do honestly: a file with rows it could not scan or address, a query
 * with no usable token, no matching row, a match too common to locate anything, or
 * a budget too small for the matching row. Selectors never reach this: an explicit
 * range, columns or row cap is the caller's own scope and is served as asked.
 *
 * Q does not shrink because the order changed: `limit.next` walks every other row
 * through the store, the `note` says the view is partial, and S is credited only
 * from what the finalized payload carries (`shippedWindowsByPath`), after the
 * ledger booking below has been corroborated by the same payload.
 */
export function serveCsvQueryWindow(
  bytes: Uint8Array,
  ext: string,
  identity: { path: string; handle: string; sha: string },
  booking: { workspace: string; totalLines: number; forceServe: boolean },
  query: string,
  args: Record<string, unknown>,
  responseCeiling: number | undefined,
): { shape: Record<string, unknown> } | { noDataRows: true } | { floorBytes: number } | undefined {
  const context = protocolCallContext();
  if (context === undefined) return undefined;
  const model = csvPageModel(bytes, { ext });
  if (model === undefined) return undefined;
  if (model.rows.length === 0) return { noDataRows: true };
  const declaredBytes = typeof args["maxBytes"] === "number" ? args["maxBytes"] : undefined;
  const declaredTokens = typeof args["maxTokens"] === "number" ? args["maxTokens"] : undefined;
  const budget = Math.min(
    mustFetchReadBudget(READ_SYMBOL_CAP_BYTES),
    declaredBytes ?? Number.POSITIVE_INFINITY,
    estimateBytesFromTokens(declaredTokens) ?? Number.POSITIVE_INFINITY,
    responseCeiling ?? Number.POSITIVE_INFINITY,
  );
  const cwd = typeof args["cwd"] === "string" ? args["cwd"] : undefined;
  const measuredCwd = cwd ?? context.continuationWorkspace ?? booking.workspace;
  // Only the opening page carries the note and `selected_by`, so they are its own
  // reserve; widest row numbers, because the window is not chosen yet.
  const room = budget
    - csvPageReserve(identity.path, model.columns, measuredCwd)
    - measureResponseBytes(`,"selected_by":"query","note":${JSON.stringify(csvQueryWindowNote(`${model.rows.length}-${model.rows.length}`, model.rows.length))}`)
    - (readSnapshotEnabled() ? SNAPSHOT_RESERVE_BYTES : 0);
  const tokens = artifactQueryTokens(query);
  const anchored = csvQueryWindow(model, tokens, room, CSV_PAGE_MAX_ROWS);
  if (anchored === undefined) {
    // The query does locate a row, and a budget the caller declared is what keeps it
    // out: name the budget that serves it. The ordinary head could only be refused
    // here, with no floor to retry at, and would not contain that row anyway.
    if (declaredBytes === undefined && declaredTokens === undefined) return undefined;
    const located = csvQueryWindow(model, tokens, Number.POSITIVE_INFINITY, 1);
    return located === undefined ? undefined : { floorBytes: budget - room + csvRowCostBytes(model.rows[located.anchorIdx]!) };
  }
  let window: { readonly startIdx: number; readonly endIdx: number } = anchored;
  const requested = csvRowSpansAsWindows(model);
  // A repeat of the same query must move forward: when the row it points at is already
  // held in this lane, the page is the first rows still owed instead. A forced serve
  // asked for the bytes again, and gets them.
  const held = booking.forceServe ? [] : ledgerCoverage(booking.workspace, identity.path, identity.sha);
  let located = true;
  if (csvRowWindowHeld(model, { startIdx: anchored.anchorIdx, endIdx: anchored.anchorIdx + 1 }, held)) {
    // Next to the match first, since that is where the question points, then anywhere.
    const owed = subtractWindows(requested, held);
    const ahead = subtractWindows(owed, [{ start: 1, end: model.dataSpans[anchored.anchorIdx]![0] }]);
    const page = chooseCsvRowPage(model, ahead.length > 0 ? ahead : owed, room, CSV_PAGE_MAX_ROWS);
    if (!page.ok) return undefined;
    window = page.window;
    located = false;
  }
  const first = model.firstDataRow + window.startIdx;
  const last = model.firstDataRow + window.endIdx - 1;
  const table = csvTable(bytes, { ext, range: `${first}-${last}`, maxRows: window.endIdx - window.startIdx });
  if (!table.ok || table.fileLineRange === undefined) return undefined;
  const snapshotFormat = ext === "tsv" ? "tsv" : "csv";
  const snapshot = readSnapshotEnabled()
    ? takeSnapshot({ workspaceRoot: booking.workspace, lane: currentSessionLane(), path: identity.path, sourceSha: identity.sha, format: snapshotFormat, bytes })
    : undefined;

  const lane = currentSessionLane();
  const taskHandle = typeof args["task_handle"] === "string" ? args["task_handle"] : undefined;
  const staged = openReadRequest({
    workspaceRoot: booking.workspace,
    ...(lane !== "" ? { lane } : {}),
    ...(taskHandle !== undefined ? { taskHandle } : {}),
    // What a stale cursor's restart re-issues: this same request, not a task pack.
    originalInput: { targets: [{ path: identity.path }], select: { kind: ext }, query },
    ...(declaredBytes !== undefined || declaredTokens !== undefined
      ? { budget: { ...(declaredBytes !== undefined ? { bytes: declaredBytes } : {}), ...(declaredTokens !== undefined ? { tokens: declaredTokens } : {}) } }
      : {}),
    forceServeOrigin: booking.forceServe,
    echo: {
      ...(cwd !== undefined ? { cwd } : {}),
      ...(lane !== "" ? { lane } : {}),
      ...(taskHandle !== undefined ? { taskHandle } : {}),
    },
    targets: [{
      path: identity.path,
      sha: identity.sha,
      totalLines: Math.max(booking.totalLines, model.dataSpans[model.dataSpans.length - 1]?.[1] ?? 0),
      representation: { content: "full", comments: "keep" },
      requested,
      artifact: { kind: ext === "tsv" ? "tsv" : "csv" },
      ...(snapshot !== undefined ? { snapshot: { handle: snapshot.handle } } : {}),
    }],
  });
  if (staged === undefined) return undefined;
  context.readRequest = staged;
  // Not gated on `located`: a task pack's window may already hold one match, and this view is what reaches the others.
  const sparse = sparseSelectEnabled() && snapshot !== undefined
    ? csvSparseView(bytes, ext, model, tokens, room, booking, identity, snapshot, held)
    : undefined;
  if (sparse !== undefined) return { shape: sparse };
  bookCsvArtifactServe(booking.workspace, identity.path, identity.sha, booking.totalLines, table);
  const servedAll = window.endIdx - window.startIdx === model.rows.length;
  const note = servedAll
    ? `served all ${model.rows.length} data rows`
    : located
      ? csvQueryWindowNote(table.range, model.rows.length)
      : `served rows ${table.range} of ${model.rows.length} data rows: the row the query points at was already served in this lane, so these are the next rows owed. A partial view, so these rows alone show neither that a value is absent nor that the table is complete. limit.next returns the other rows`;
  return {
    shape: csvArtifactShape({ ...table, truncated: !servedAll }, identity, {
      note,
      ...(located ? { selectedBy: "query" as const } : {}),
      ...(snapshot !== undefined ? { snapshot, source: { status: "current" } } : {}),
    }),
  };
}

/** What a snapshot's handle and the source status add to a response, at their widest. */
export const SNAPSHOT_RESERVE_BYTES = 600;

/**
 * B2b: the first response as several runs of rows. `undefined` keeps the contiguous
 * window: one run has nothing to gain from the extra labels, and a view whose rows
 * are all already held would not move the request forward.
 *
 * Each run is read through `csvTable`, so its rows and positions are exactly what an
 * ordinary read of that range returns. Q is unchanged and D still pages through the
 * cursor, in file order, while `snapshot.handle` reaches any hidden run directly.
 */
export function csvSparseView(
  bytes: Uint8Array,
  ext: string,
  model: NonNullable<ReturnType<typeof csvPageModel>>,
  tokens: readonly string[],
  room: number,
  booking: { workspace: string; totalLines: number; forceServe: boolean },
  identity: { path: string; handle: string; sha: string },
  snapshot: { handle: string; takenAtMs: number },
  held: readonly LineWindow[],
): Record<string, unknown> | undefined {
  const selection = selectSparseRows(model, tokens, room - SPARSE_MAX_RUNS * SPARSE_RUN_RESERVE_BYTES - 48, SPARSE_MAX_RUNS);
  if (selection === undefined || selection.runs.length < 2) return undefined;
  if (selection.runs.every((run) => csvRowWindowHeld(model, run, held))) return undefined;
  const tables: CsvTableResult[] = [];
  for (const run of selection.runs) {
    const table = csvTable(bytes, { ext, range: `${model.firstDataRow + run.startIdx}-${model.firstDataRow + run.endIdx - 1}`, maxRows: run.endIdx - run.startIdx });
    if (!table.ok || table.fileLineRange === undefined) return undefined;
    tables.push(table);
  }
  for (const table of tables) bookCsvArtifactServe(booking.workspace, identity.path, identity.sha, booking.totalLines, table);
  const combined: CsvTableResult = {
    ...tables[0]!,
    range: tables.map((table) => table.range).join(","),
    rows: tables.flatMap((table) => table.rows),
    truncated: true,
    warnings: [],
  };
  delete combined.fileLineRange;
  delete combined.note;
  return csvArtifactShape(combined, identity, {
    note: `a partial view: ${selection.shown} of ${model.rows.length} data rows in ${tables.length} separate runs, chosen by query relevance, unusual values and variety. Rows left out are not less important, and these rows show neither that a value is absent nor that the table is complete. row_spans maps rows to positions. limit.next returns the other rows; before editing, read the exact range`,
    selectedBy: "sparse",
    rowSpans: tables.map((table) => ({ range: table.range, file_range: table.fileLineRange!, rows: table.rows.length })),
    counts: { total: model.rows.length, scanned: selection.scanned, shown: selection.shown },
    snapshot,
    source: { status: "current" },
  });
}

/** B1: why a snapshot handle cannot be served, in the shape every read refusal takes. Never a fallback to the current file. */
export function snapshotUnavailable(reason: SnapshotFailure): ReturnType<typeof toolStructuredError> {
  return toolStructuredError({
    ok: false,
    code: "snapshot-unavailable",
    field: "handle",
    error: "this snapshot cannot be served",
    detail: `${reason}; the bytes it held are not available here, and the current file was not read in its place. Re-read the file for its current content`,
    retry: "none",
  });
}

/**
 * B1: a range of the revision a snapshot holds, through the same `csvTable` as any
 * read. It books the served-range ledger only when the file on disk still has that
 * revision: rows of a moved file are not the current text, so they must not ground an
 * edit or answer a later read of the file.
 */
export async function serveSnapshotExpansion(
  token: string,
  workspace: string,
  args: Record<string, unknown>,
): Promise<ReturnType<typeof toolOk> | ReturnType<typeof toolStructuredError>> {
  const resolved = resolveSnapshot(token, workspace, currentSessionLane());
  if (!resolved.ok) return snapshotUnavailable(resolved.reason);
  const { data, bytes } = resolved;
  // A handle names its own path. Silently preferring one of two would answer a question nobody asked.
  if (typeof args["path"] === "string" && args["path"] !== data.path) return snapshotUnavailable("invalid");
  const range = typeof args["range"] === "string" ? args["range"] : undefined;
  const maxRows = typeof args["maxRows"] === "number" ? args["maxRows"] : undefined;
  const table = csvTable(bytes, { ext: data.format, ...(range !== undefined ? { range } : {}), ...(maxRows !== undefined ? { maxRows } : {}) });
  if (!table.ok) return snapshotUnavailable("corrupt");
  // served-bytes: not-served (hashed only, to say whether the source moved; the rows come from the snapshot)
  const currentBytes = await readBytesSafe(data.path, workspace);
  const currentSha = currentBytes === null ? undefined : shaOfBytes(currentBytes);
  const moved = currentSha !== data.source_sha;
  if (!moved) bookCsvArtifactServe(workspace, data.path, data.source_sha, countLines(decodeCsvBytes(bytes)), table);
  declareKind("read.artifact");
  return toolOk(csvArtifactShape(table, { path: data.path, handle: token, sha: data.source_sha }, {
    snapshot: { handle: token, takenAtMs: data.taken_at_ms },
    source: currentSha === undefined ? { status: "missing" } : moved ? { status: "moved", current_sha: shortSha(currentSha) } : { status: "current" },
  }));
}

export function csvQueryWindowNote(range: string, totalRows: number): string {
  return `served rows ${range} of ${totalRows} data rows, chosen by query relevance rather than from the top of the file; a partial view, so these rows alone show neither that a value is absent nor that the table is complete. limit.next returns the other rows`;
}

/**
 * No-selector bounded csv head: serve the full bounded table when it fits the
 * SAME inline budget the xlsx no-`sheet` artifact path uses
 * (mustFetchReadBudget(READ_SYMBOL_CAP_BYTES)); else a head preview (20 rows);
 * else a columns-only head with the honest total_rows + range= note. Returns
 * undefined only if csvTable itself fails (caller decides the fallback).
 *
 * `booking`, when given, stages the served-range ledger for whichever branch
 * actually returns (see `bookCsvArtifactServe`'s doc comment) — omitted by a
 * caller that does not want this csv/tsv route to ground edit authority (none
 * today; every call site passes it, per ruling (s)'s "text artifacts get the
 * same triad every read.text path gets").
 */
export function serveBoundedCsvArtifact(
  bytes: Uint8Array,
  ext: string,
  identity: { path: string; handle: string; sha: string },
  booking?: { workspace: string; totalLines: number; forceServe?: boolean },
): Record<string, unknown> | undefined {
  const budget = mustFetchReadBudget(READ_SYMBOL_CAP_BYTES);
  const full = csvTable(bytes, { ext });
  if (!full.ok) return undefined;
  const fullOut = csvArtifactShape(full, identity);
  if (Buffer.byteLength(JSON.stringify(fullOut), "utf8") <= budget) {
    // FX-P1 (ruling (u)): the receipt is checked on the rung that would
    // actually ship, so a repeat of THIS response's exact window is answered
    // with the receipt and a different (wider or narrower) window still serves.
    if (booking !== undefined) {
      const receipt = csvArtifactServeReceipt(booking.workspace, identity, booking.totalLines, full, booking.forceServe === true);
      if (receipt !== undefined) return receipt;
      bookCsvArtifactServe(booking.workspace, identity.path, identity.sha, booking.totalLines, full);
    }
    return fullOut;
  }
  // Attempt 2: bounded head preview — never loosens the budget check above.
  const head = csvTable(bytes, { ext, maxRows: 20, maxCells: 2000 });
  if (head.ok) {
    const headOut = csvArtifactShape(head, identity);
    if (Buffer.byteLength(JSON.stringify(headOut), "utf8") <= budget) {
      if (booking !== undefined) {
        const receipt = csvArtifactServeReceipt(booking.workspace, identity, booking.totalLines, head, booking.forceServe === true);
        if (receipt !== undefined) return receipt;
        bookCsvArtifactServe(booking.workspace, identity.path, identity.sha, booking.totalLines, head);
      }
      return headOut;
    }
  }
  // Final fallback: columns + totals + honest note, no rows (always small) —
  // no booking: nothing here for an edit to be grounded on.
  const minimal = csvTable(bytes, { ext, maxRows: 0 });
  return minimal.ok ? csvArtifactShape(minimal, identity) : undefined;
}

/**
 * One-shot edits[] batching hint text (see recordSingleEditCompletion in
 * util/session.ts) — echoes the "Batch independent edits" guardrail bullet in
 * packages/agents-md/templates/AGENTS.md.tmpl so the server-side nudge and
 * the onboarded prompt guidance stay consistent.
 *
 * 2026-07-24 (bench task T09 forensics): the ORIGINAL 4th-call fire point
 * was too late — both observed sessions had already made 5 sequential
 * single-file tl_edit_file calls apiece, ignoring the hint entirely (it landed
 * only after most of the batchable work was already done one-shot). The
 * fire point is now the 2nd single-edit call (BATCH_HINT_THRESHOLD in
 * util/session.ts) and the wording is more actionable: it names the
 * multi-FILE + per-item-precondition shape of edits[] explicitly, not just
 * "batch independent edits".
 */
export const BATCH_HINT_TEXT =
  "2nd single-edit call this session — edits[] batches MULTIPLE FILES in one call, each with its own precondition; batch remaining known edit sites into ONE edits[] call now.";
