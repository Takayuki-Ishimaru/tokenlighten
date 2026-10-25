// ---------------------------------------------------------------------------
// protocol v1 — EVIDENCE PATH GROUPS (2026-10-23, codex-copilot-proxy wire
// audit §4.2 rank 1; flag TL_EFF_EVIDENCE_PATH_GROUPS, default OFF).
//
// THE WIRE RULE. Inside one `read.task_pack` reply, a run of consecutive
// `evidence[]` rows on the SAME `path` (two rows or more) is written with its
// address once:
//   - the first row of the run keeps `handle` and `path`;
//   - every later row of the run omits `path`;
//   - a later row also omits `handle` when it equals the handle of the row
//     above (rows of one surface — a structure map's windows, a row split at a
//     comment — share the surface's handle; the owed windows of a continuation
//     page are a surface each, one handle apiece, and keep it).
// A row without `path` is therefore on the file of the row above, and a row
// without `handle` is on the handle of the row above. A reply that was grouped
// carries `evidence_note` (EVIDENCE_PATH_GROUP_NOTE) immediately before
// `evidence`, so the convention is stated where it is needed, to a model that
// has never seen it and to a program that must know whether to resolve rows.
// A single-row file, and a reply with no such run, is written as before and
// carries no note.
//
// WHY AN IN-BAND NOTE. A row without a `path` already exists legitimately: a
// `PriorEvidence` row (the caller already holds the address, protocol.ts §2.3)
// and a `read.text` entry whose source names none. "Absent means inherited"
// would misread those, so the pass refuses to group an array that has any row
// without a string `path` and `handle`, and a resolver inherits only where the
// note says the writer grouped.
//
// WHERE IT RUNS. After the budget ladder, the served-range settlement and the
// request continuations — everything that decides WHICH rows ship, and that
// reads each row's own `path`/`handle`, sees the ungrouped rows — and before
// the codec and the byte measurement, so the bytes the call records are the
// bytes that ship. Readers of a reply's TEXT that match rows by `path`/`handle`
// (the pack-fingerprint binding, the source capsules, the autofollow merge,
// the semantic-frontier trace) call `expandEvidencePathGroups` first.
//
// WHAT IS BUDGETED. With the flag on, the bytes that ship are the bytes that
// are measured: the budget ladder measures this pass's output (`runLadder`'s
// `serialize`), so a caller-declared cap binds the grouped reply; the pack
// builder prices the grouped rows (readCodeTaskPack.ts
// `estimateStructureMapReplyBytes`, `taskPackSizePreview`,
// `auxiliaryEnumAttachmentSizePreview`), so the bytes grouping saves can hold
// more rows; and a grouping that saves less than
// EVIDENCE_PATH_GROUP_MIN_NET_SAVING_BYTES is not written, in the measurement
// as on the wire. A structure map cannot be shed row by row and its estimate is
// not an upper bound of the pack built from it, so its first page is admitted
// with STRUCTURE_MAP_GROUPED_ADMISSION_MARGIN_BYTES of headroom
// (readCodeTaskPack.ts `structureMapForAnswer`); without it a server that issues
// no cursor (the restated `next` is larger) shipped a 1.6 KB head where the page
// is 16 KB. With the flag off none of those differs from before.
// ---------------------------------------------------------------------------

import { effEvidencePathGroupsEnabled } from "../util/flags.js";
import { measureResponseBytes } from "./budget/measure.js";

type Row = Record<string, unknown>;

/**
 * The text of `evidence_note` on a grouped reply, byte-for-byte. A resolver
 * treats a reply as grouped only when its `evidence_note` equals this.
 */
export const EVIDENCE_PATH_GROUP_NOTE = "a row without path or handle repeats the one above";

/**
 * The least a reply must save, net of its `evidence_note`, to be written
 * grouped. A reply whose runs save about what the note costs (T07's first pack:
 * one file of two rows, 55 B saved, 70 B of note; the two-row act.answer of a
 * chain, 6 B net) would teach the reader a convention for nothing, so it ships
 * whole.
 */
export const EVIDENCE_PATH_GROUP_MIN_NET_SAVING_BYTES = 64;

const record = (value: unknown): Row | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : undefined;

/** Every row is an object with a non-empty string `path` and `handle`: the only arrays the writer groups. */
function addressedRows(evidence: readonly unknown[]): Row[] | undefined {
  const rows: Row[] = [];
  for (const entry of evidence) {
    const row = record(entry);
    if (row === undefined || typeof row["path"] !== "string" || row["path"] === ""
      || typeof row["handle"] !== "string" || row["handle"] === "") return undefined;
    rows.push(row);
  }
  return rows;
}

/** The row without the members the run already states. */
function withoutAddress(row: Row, keepHandle: boolean): Row {
  const out: Row = {};
  for (const [key, value] of Object.entries(row)) {
    if (key === "path") continue;
    if (key === "handle" && !keepHandle) continue;
    out[key] = value;
  }
  return out;
}

/** `payload` with `evidence_note` placed immediately before `evidence` and `evidence` replaced. */
function withGroupedEvidence(payload: Row, evidence: unknown[]): Row {
  const out: Row = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === "evidence_note") continue;
    if (key === "evidence") {
      out["evidence_note"] = EVIDENCE_PATH_GROUP_NOTE;
      out[key] = evidence;
    } else out[key] = value;
  }
  return out;
}

/**
 * Writes the runs of `payload.evidence` once (the module header has the rule).
 * `payload` itself is returned when the flag is off, the payload is not a
 * `read.task_pack`, the rows are not all addressed, no run of two exists, or
 * the runs save fewer than EVIDENCE_PATH_GROUP_MIN_NET_SAVING_BYTES once the
 * `evidence_note` is paid for; otherwise a copy. The argument is never
 * mutated.
 */
export function groupEvidencePaths(payload: Row): Row {
  if (!effEvidencePathGroupsEnabled() || payload["kind"] !== "read.task_pack" || !Array.isArray(payload["evidence"])) return payload;
  const rows = addressedRows(payload["evidence"]);
  if (rows === undefined || rows.length < 2) return payload;
  let grouped = false;
  const out = rows.map((row, index) => {
    const above = rows[index - 1];
    if (above === undefined || above["path"] !== row["path"]) return row;
    grouped = true;
    return withoutAddress(row, row["handle"] !== above["handle"]);
  });
  if (!grouped) return payload;
  // Runs that save less than EVIDENCE_PATH_GROUP_MIN_NET_SAVING_BYTES once the
  // note is paid for: that reply ships as it was.
  const candidate = withGroupedEvidence(payload, out);
  return measureResponseBytes(JSON.stringify(payload)) - measureResponseBytes(JSON.stringify(candidate))
    >= EVIDENCE_PATH_GROUP_MIN_NET_SAVING_BYTES
    ? candidate
    : payload;
}

/** Whether `payload` states that its evidence rows were grouped. */
export function evidenceIsGrouped(payload: Readonly<Row>): boolean {
  return payload["evidence_note"] === EVIDENCE_PATH_GROUP_NOTE && Array.isArray(payload["evidence"]);
}

/**
 * The rows of a grouped `evidence` with the `path` and `handle` of the row
 * above restored on every row that left them off, `handle` first and `path`
 * second as the projector writes them. A row that carries both is returned as
 * it is; an entry that is not an object is passed through.
 */
export function resolveEvidenceRows(evidence: readonly unknown[]): unknown[] {
  let path: string | undefined;
  let handle: string | undefined;
  return evidence.map((entry) => {
    const row = record(entry);
    if (row === undefined) return entry;
    const ownPath = typeof row["path"] === "string" ? row["path"] : undefined;
    const ownHandle = typeof row["handle"] === "string" ? row["handle"] : undefined;
    if (ownPath !== undefined) path = ownPath;
    if (ownHandle !== undefined) handle = ownHandle;
    if (ownPath !== undefined && ownHandle !== undefined) return row;
    const { path: _path, handle: _handle, ...rest } = row;
    return { ...(handle !== undefined ? { handle } : {}), ...(path !== undefined ? { path } : {}), ...rest };
  });
}

/**
 * `payload` with its grouped evidence resolved into whole rows and the note
 * removed — the ungrouped reply a reader of the reply's text matches rows in.
 * A payload that does not state it was grouped is returned as it is.
 */
export function expandEvidencePathGroups(payload: Row): Row {
  if (!evidenceIsGrouped(payload)) return payload;
  const out: Row = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === "evidence_note") continue;
    out[key] = key === "evidence" ? resolveEvidenceRows(value as unknown[]) : value;
  }
  return out;
}
