// ---------------------------------------------------------------------------
// protocol v1 — REPLY-ENVELOPE COMPACTION (2026-10-23, codex-copilot-proxy
// wire audit §5.1 "SAFE"; flag TL_EFF_REPLY_COMPACT, default ON).
//
// WHAT THIS IS. One pass over the FINAL payload of a reply — after the budget
// ladder, the served-range settlement and the request continuations have run,
// next to `omitCoveredFrontierIndex` — that leaves off members which repeat
// what the same reply already says. Every rule here is a deletion or a
// replacement by a shorter spelling of the same fact:
//
//   1. `evidence[].role:"unknown"` of a `read.task_pack`, when the call —
//      or the task the call continues — passed no `surfaceRoles`.
//   2. `evidence[].likely_edits`, when it is exactly the generic pair for the
//      row's own handle: it becomes its kinds.
//   3. `profile_binding.reason`, when it only explains an inference.
//   4. `search.tree`'s `scope_report.excluded_by_reason`, when nothing was
//      excluded and the walk was complete.
//
// A fifth rule, an `obligations[]` entry's `path` / `range` / `role` when the
// first evidence row of its `handle` carries the same value, is NOT in this set:
// it makes the model look a row up to learn where an edit item goes (an edit
// item still needs the `path`), a behaviour change on edit tasks that no cohort
// has exercised. It belongs to the family of TL_EFF_EVIDENCE_PATH_GROUPS
// (default OFF), which restates rows' addresses from the row above; see
// `restateObligationsFromEvidence` below. With that flag off an obligation
// ships whole, as it did before this pass existed.
//
// WHY AFTER THE LADDER AND NOT IN THE PROJECTORS. The pack builder, the
// shedders, the act floor, the ledger settlement and the size previews all
// read the full envelope (a row's `role` ranks it for rung 5, the generic
// hint's confidence feeds `hasSufficientEditContent` upstream of the wire, the
// previews price what the builder may still add). Compacting inside a
// projector would change which rows and decisions a call produces; compacting
// the finished payload changes only the bytes that ship. That is also why the
// pass is a copy-on-write function of the payload: it returns the very object
// it was given when nothing applies.
//
// WHAT THIS DELIBERATELY LEAVES ALONE. `server_build` already rides the first
// task pack of a session only (server.ts `attachServerBuildOnce`), so there is
// nothing to cut. `task.coverage_reason` is read by the full guide
// ("coverage_reason=candidate-list => run the decision next") and counted by
// the bench telemetry (`coverage_reasons`), so it stays. `read.map`'s
// `outline.surfaces[].role` is a required member of that kind and is not an
// evidence row. `frontier_index[].role` is compared with the evidence rows'
// role by `omitCoveredFrontierIndex`, which therefore runs BEFORE this pass.
// ---------------------------------------------------------------------------

import type { Kind } from "@tokenlighten/types";

import { effEvidencePathGroupsEnabled, effReplyCompactEnabled } from "../util/flags.js";

type Row = Record<string, unknown>;

const record = (value: unknown): Row | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : undefined;

/**
 * Whether the call named the surface roles it wanted (`scope.surfaceRoles`,
 * which `projectCanonicalRequest` flattens into `args.surfaceRoles`; either
 * spelling counts, an empty list does not — the pack builder reads `[]` as
 * "not passed" too). A caller that passed them reads the ABSENCE of `role` on
 * a row as "the selector did not bind" (protocol.ts, [R4-2]); only a call that
 * did not may have `"unknown"` collapsed to absence.
 */
export function callPassedSurfaceRoles(args: Readonly<Record<string, unknown>> | undefined): boolean {
  const flat = args?.["surfaceRoles"];
  if (Array.isArray(flat) && flat.length > 0) return true;
  const nested = record(args?.["scope"])?.["surfaceRoles"];
  return Array.isArray(nested) && nested.length > 0;
}

/**
 * What the pass reads of the call it compacts the reply of: its arguments, and
 * the fact — published by the task-pack dispatch — that the TASK it belongs to
 * was first requested with `surfaceRoles` (`ProtocolCallContext` satisfies it).
 */
export interface CompactionCall {
  readonly args?: Readonly<Record<string, unknown>>;
  readonly surfaceRolesPassed?: boolean;
}

/**
 * Whether the request behind this reply passed `surfaceRoles`: the call itself did, or it is a
 * continuation page of a task that did. A cursor page or a qref re-pack carries no scope (the stored
 * call behind a cursor is `{qref, targets}`), so reading its own arguments alone drops `"unknown"`
 * from a page whose first page kept it (wire-compaction review F1, 2026-10-23: T09 page 2).
 */
export function requestPassedSurfaceRoles(call: CompactionCall | undefined): boolean {
  return call?.surfaceRolesPassed === true || callPassedSurfaceRoles(call?.args);
}

/**
 * The confidences the pack builder gives the generic pair: 0.5/0.4 (the
 * backfilled primary surface) and 0.85/0.75 (a locator hit). The pair is a
 * function of the row's handle and these constants alone, so it carries no
 * fact its row does not; a pair at any other confidence is the locator's own
 * score and ships as it is.
 */
const GENERIC_HINT_CONFIDENCES: ReadonlyArray<readonly [number, number]> = [[0.5, 0.4], [0.85, 0.75]];

/** The kinds a generic `likely_edits` pair is replaced by, in order. */
export const GENERIC_LIKELY_EDIT_KINDS: readonly string[] = Object.freeze(["inspect-slice", "handle-scoped-edit"]);

function isHintOn(value: unknown, kind: string, handle: string): Row | undefined {
  const hint = record(value);
  if (hint === undefined || Object.keys(hint).length !== 3) return undefined;
  return hint["kind"] === kind && hint["handle"] === handle && typeof hint["confidence"] === "number" ? hint : undefined;
}

/** The kinds of `row.likely_edits` when it is exactly the generic pair for `row.handle`. */
export function genericLikelyEditKinds(row: Readonly<Row>): string[] | undefined {
  const hints = row["likely_edits"];
  const handle = row["handle"];
  if (!Array.isArray(hints) || hints.length !== 2 || typeof handle !== "string" || handle === "") return undefined;
  const inspect = isHintOn(hints[0], "inspect-slice", handle);
  const edit = isHintOn(hints[1], "handle-scoped-edit", handle);
  if (inspect === undefined || edit === undefined) return undefined;
  return GENERIC_HINT_CONFIDENCES.some(([a, b]) => inspect["confidence"] === a && edit["confidence"] === b)
    ? [...GENERIC_LIKELY_EDIT_KINDS]
    : undefined;
}

function compactEvidenceRow(row: Row, dropUnknownRole: boolean): Row {
  const dropRole = dropUnknownRole && row["role"] === "unknown";
  const kinds = genericLikelyEditKinds(row);
  if (!dropRole && kinds === undefined) return row;
  const out: Row = {};
  for (const [key, value] of Object.entries(row)) {
    if (key === "role" && dropRole) continue;
    out[key] = key === "likely_edits" && kinds !== undefined ? kinds : value;
  }
  return out;
}

function compactEvidence(rows: readonly unknown[], dropUnknownRole: boolean): unknown[] | undefined {
  let changed = false;
  const out = rows.map((entry) => {
    const row = record(entry);
    if (row === undefined) return entry;
    const next = compactEvidenceRow(row, dropUnknownRole);
    if (next !== row) changed = true;
    return next;
  });
  return changed ? out : undefined;
}

/**
 * `profile_binding.reason` texts that only say how an inferred profile was
 * chosen (readCodeTaskPack.ts `bindTaskProfile`). The binding's other members
 * already say what was chosen and from where; these sentences add nothing a
 * caller can act on, and the budget ladder sheds the member first anyway
 * (rung 1). Advice, a text that tells the caller what to send, names
 * `task.profile` and is not on this list: it stays, and so does any reason
 * this list does not know.
 */
const INFORMATIONAL_PROFILE_REASONS: readonly RegExp[] = [
  /^no high-confidence task-shape marker$/,
  /^query matched [A-Za-z][\w-]*$/,
  /^request-shaped operation evidence refines [\w-]+ to [\w-]+$/,
  /^caller supplied validated [\w-]+ task shape$/,
];

function compactProfileBinding(binding: unknown): Row | undefined {
  const value = record(binding);
  const reason = value?.["reason"];
  if (value === undefined || typeof reason !== "string" || !INFORMATIONAL_PROFILE_REASONS.some((pattern) => pattern.test(reason))) {
    return undefined;
  }
  const { reason: _reason, ...rest } = value;
  return rest;
}

/**
 * An obligation names the evidence it is about by `handle`, and repeats that
 * row's `path`, `range` and `role` beside it. When the first evidence row of
 * the handle carries the same value, the obligation leaves it off: an
 * obligation without `path`/`range`/`role` has the value of the first evidence
 * row of its `handle`. `range` is the surface's whole scope window, which is
 * the row's own range for about three obligations in four; where it is wider
 * than the row (rows split at comments, windows still owed) it stays. Ids,
 * stages, `depends_on`, `action`, `status`, `required`, `reason` and
 * `confidence` are untouched, and an obligation whose handle no emitted row
 * carries keeps every member.
 *
 * This is the TL_EFF_EVIDENCE_PATH_GROUPS family's rule (see the module
 * header): `restateObligationsFromEvidence` is its only caller.
 */
function compactObligations(plan: unknown, evidence: unknown): Row | undefined {
  const planRecord = record(plan);
  const contract = record(planRecord?.["change_contract"]);
  const obligations = contract?.["obligations"];
  if (planRecord === undefined || contract === undefined || !Array.isArray(obligations) || !Array.isArray(evidence)) return undefined;
  const firstRowOf = new Map<string, Row>();
  for (const entry of evidence) {
    const row = record(entry);
    const handle = row?.["handle"];
    if (row !== undefined && typeof handle === "string" && handle !== "" && !firstRowOf.has(handle)) firstRowOf.set(handle, row);
  }
  let changed = false;
  const next = obligations.map((entry) => {
    const obligation = record(entry);
    const handle = obligation?.["handle"];
    const row = typeof handle === "string" ? firstRowOf.get(handle) : undefined;
    if (obligation === undefined || row === undefined) return entry;
    const repeated = (["path", "range", "role"] as const).filter((key) =>
      typeof obligation[key] === "string" && obligation[key] === row[key]);
    if (repeated.length === 0) return entry;
    changed = true;
    const out: Row = {};
    for (const [key, value] of Object.entries(obligation)) {
      if (!(repeated as readonly string[]).includes(key)) out[key] = value;
    }
    return out;
  });
  return changed ? { ...planRecord, change_contract: { ...contract, obligations: next } } : undefined;
}

/**
 * The reader's side of the obligation rule: `obligations` with the `path`,
 * `range` and `role` an obligation left off restored from the first row of
 * `evidence` (whole rows, so a grouped reply is resolved first,
 * evidencePathGroups.ts `resolveEvidenceRows`) that carries the obligation's
 * `handle`, in the place the producer writes them (after `handle`). An
 * obligation that carries a member keeps it, and one whose handle no row
 * carries is returned as it is.
 */
export function resolveObligations(obligations: readonly unknown[], evidence: readonly unknown[]): unknown[] {
  const firstRowOf = new Map<string, Row>();
  for (const entry of evidence) {
    const row = record(entry);
    const handle = row?.["handle"];
    if (row !== undefined && typeof handle === "string" && handle !== "" && !firstRowOf.has(handle)) firstRowOf.set(handle, row);
  }
  return obligations.map((entry) => {
    const obligation = record(entry);
    const handle = obligation?.["handle"];
    const row = typeof handle === "string" ? firstRowOf.get(handle) : undefined;
    if (obligation === undefined || row === undefined) return entry;
    const missing = (["path", "range", "role"] as const).filter((key) => obligation[key] === undefined && row[key] !== undefined);
    if (missing.length === 0) return entry;
    const out: Row = {};
    for (const [key, value] of Object.entries(obligation)) {
      if (key === "path" || key === "range" || key === "role") continue;
      out[key] = value;
      if (key === "handle") {
        for (const member of ["path", "range", "role"] as const) {
          const own = obligation[member] ?? row[member];
          if (own !== undefined) out[member] = own;
        }
      }
    }
    return out;
  });
}

function compactTaskPack(payload: Row, call: CompactionCall | undefined): Row {
  let current = payload;
  const evidence = payload["evidence"];
  if (Array.isArray(evidence)) {
    const rows = compactEvidence(evidence, !requestPassedSurfaceRoles(call));
    if (rows !== undefined) current = { ...current, evidence: rows };
  }
  const binding = compactProfileBinding(payload["profile_binding"]);
  if (binding !== undefined) current = { ...current, profile_binding: binding };
  return current;
}

/**
 * TL_EFF_EVIDENCE_PATH_GROUPS (default OFF), the "restated from the evidence
 * rows" family with the grouped rows (evidencePathGroups.ts): a `read.task_pack`
 * whose `plan.change_contract.obligations[]` entries leave off the `path`,
 * `range` and `role` the first evidence row of their `handle` carries. Moved
 * out of the default-ON pass (`compactReplyEnvelope`) by the wire-compaction
 * review (2026-10-23): an obligation without a `path` makes the model look the
 * row up by `handle` to learn where an edit item goes, and no cohort has
 * exercised that. With the flag off the payload is returned as it is — an
 * obligation ships whole.
 *
 * Runs on the payload BEFORE `compactReplyEnvelope` drops a row's
 * `role:"unknown"` and before the rows are grouped: the obligations are
 * compared with the whole rows as they stand (equal values are equal, an
 * absent role never equals a present one). A reader restores them with
 * `resolveObligations` over whole rows. Independent of TL_EFF_REPLY_COMPACT.
 */
export function restateObligationsFromEvidence(payload: Row, kind: Kind): Row {
  if (!effEvidencePathGroupsEnabled() || kind !== "read.task_pack") return payload;
  const plan = compactObligations(payload["plan"], payload["evidence"]);
  return plan === undefined ? payload : { ...payload, plan };
}

/**
 * A complete walk that excluded nothing and hit no error has an all-zero
 * `excluded_by_reason`, eight keys that say again what `counts.excluded: 0`
 * says. The report stays (its `completeness` and `counts` are what the guide
 * reads); only the reason table goes.
 */
function compactScopeReport(report: Row): Row | undefined {
  const counts = record(report["counts"]);
  const reasons = record(report["excluded_by_reason"]);
  if (counts === undefined || reasons === undefined
    || report["completeness"] !== "complete" || counts["excluded"] !== 0 || counts["errors"] !== 0
    || !Object.values(reasons).every((count) => count === 0)) return undefined;
  const { excluded_by_reason: _reasons, ...rest } = report;
  return rest;
}

function compactTreeScopeReport(payload: Row): Row {
  const report = record(payload["scope_report"]);
  const compact = report === undefined ? undefined : compactScopeReport(report);
  return compact === undefined ? payload : { ...payload, scope_report: compact };
}

/**
 * The compaction pass: `payload` is the final payload of a reply of `kind`,
 * `call` the call it answers (`ProtocolCallContext`: its inbound arguments, and
 * whether the task it continues passed `surfaceRoles`). Returns `payload` itself
 * when nothing applies or TL_EFF_REPLY_COMPACT is off, else a copy; the argument
 * is never mutated.
 */
export function compactReplyEnvelope(
  payload: Row,
  kind: Kind,
  call: CompactionCall | undefined,
): Row {
  if (!effReplyCompactEnabled()) return payload;
  switch (kind) {
    case "read.task_pack": return compactTaskPack(payload, call);
    case "search.tree": return compactTreeScopeReport(payload);
    default: return payload;
  }
}
