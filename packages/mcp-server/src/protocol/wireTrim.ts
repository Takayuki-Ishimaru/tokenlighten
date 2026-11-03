// ---------------------------------------------------------------------------
// protocol v1 — REPLY METADATA TRIM (2026-11-03, external billing analysis of
// Claude Code sessions: 22.5 % of `tl_read_file` reply bytes were not source;
// flag TL_EFF_REPLY_TRIM, default ON).
//
// WHAT THIS IS. One pass over the FINAL payload of a `read.task_pack` or
// `read.receipt` reply, run right after `compactReplyEnvelope`
// (wireCompaction.ts) in protocol/emit.ts, that leaves off or shortens the
// members NOTHING downstream of the wire reads back. Every rule names the
// readers it was checked against (2026-11-03); a member any dispatch, guide or
// recovery echoes stays: `task.id` (the authenticated handle a `next` carries
// as `task.handle`), handles, ranges, `decision.kind`/`next`, the refusal
// fields, `edit_rules`, `qref` (the guide: "re-pack with the returned qref"),
// `certificate.id` and `certificate.obligations` (`task.challenge` names
// `certificate_id` and `obligation_id`, server.ts LEGACY_CHALLENGE_SCHEMA),
// `certificate.gaps` and `evidence[].remaining`/`elided`/`symbol` (the full
// guide reads each by name), `coverage_reason`, `frontier_index`, `advisory`.
//
//   1. `task.replay`, when the top-level `qref` carries the same value. The
//      two are one fact (`projectTaskRef` copies `result.qref` into both;
//      readFamily.ts's KEPT_ON_TASK_PACK note). Every server-side reader of
//      `task.replay` runs BEFORE this pass on the untrimmed payload:
//      `ledgerCertificateBindingValid` (emit.ts, before the ladder),
//      `repackCall` (budget/actFloor.ts, which falls back to `qref` anyway),
//      the receipt's `prior` text (readFamily.ts `receiptOf`), the cursor
//      plan (readCallContinuation.ts, `replied.replay === undefined ||`),
//      and envelope.ts's binding. Nothing reads it off a client's call: the
//      request property is `qref`, which is why `qref` is the copy kept.
//   2. `profile_binding`: `confidence` (a number no guide or bench reads; the
//      ladder already sheds the whole member first), `requested` when it is
//      `"auto"` (the caller sent no profile, so there is nothing to read back;
//      an explicit request stays beside what it was overridden to), and a
//      `reason` that only explains an inference the caller cannot act on
//      (`INFERENCE_EXPLANATION_REASONS`; the advice that tells the caller to
//      DECLARE `task.profile:"answer"` is not on the list and stays, as does
//      any reason this list does not know). `selected` stays: it carries the
//      finer `wiring`/`change_propagation` the top-level `profile` folds to
//      `generic`, and bench/workflows/lib/general_capability_microbench.mjs
//      reads it; `source` stays: it is the readback the guide's "omit if
//      unknown and observe profile_binding" exists for.
//   3. `decision.certificate.workspace`: no follow-up validates the marker's
//      fingerprint or counts. `task.challenge` names the certificate id, the
//      edit fence compares the server's own `contract.workspace_state`, and no
//      dispatch argument carries a fingerprint back. The marker keeps its
//      identity, scope and completeness — `fingerprint` in the write path's
//      own `sha256:` + 12 hex spelling (editFamily.ts `workspaceMarkerFor`, so
//      every marker reader already accepts the length), `scope`, and
//      `inventory_complete`, which the act floor reads on the SHIPPED payload
//      (decisionWire.ts `exhaustiveAbsenceCertified`, budget/actFloor.ts:
//      an `act.answer` with empty evidence stands only on a complete
//      inventory; wireActFloor.spec.ts applies it to the wire text) — and
//      drops `evidence_files` and `inventory_files`, the two counts nothing
//      reads.
//
// WHAT THIS DELIBERATELY LEAVES ALONE. `evidence[].why`: it is the carrier of
// the three source-order reviews (decisionWire.ts `projectEvidence`, the Go
// returned-local, Java loop-guard and enum-style origins) that are
// model-facing, and the replay corpus's relevance expectations
// (`anchorFocusWhy`, the relation-why patterns, the `evidenceShapes` labels)
// read it as the routing witness on the wire; the small single-source answer
// already drops it where it is provably noise (readFamily.ts
// `projectTaskPack`). `evidence[].remaining`: the guide teaches it ("zoom the
// same handle: request its remaining ranges") and it is never derivable — a
// row with a body cannot imply the file's length, and E-8 (types
// `Evidence`) requires it on a body-less row. `server_build` rides the first
// pack of a session only. `evidence[].path` once per file is the default-OFF
// TL_EFF_EVIDENCE_PATH_GROUPS family's, awaiting a model cohort.
//
// WHY HERE. Like `compactReplyEnvelope`, this runs on the finished payload:
// the pack builder, the shedders, the act floor, the ledger settlement and
// the size previews (which run this same funnel, so they price what ships)
// read the full envelope; only the bytes that ship change. Copy-on-write: the
// argument is never mutated and is returned by identity when nothing applies
// or the flag is off. A trace line (`wire_trim`) names what left, so the
// provenance stays in the trace.
// ---------------------------------------------------------------------------

import type { Kind } from "@tokenlighten/types";

import { effReplyTrimEnabled } from "../util/flags.js";
import { isTraceEnabled, trace } from "../util/trace.js";

type Row = Record<string, unknown>;

const record = (value: unknown): Row | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : undefined;

/** The kinds whose payload carries a task ref, a profile binding or a certificate. */
const TRIMMED_KINDS: ReadonlySet<Kind> = new Set<Kind>(["read.task_pack", "read.receipt"]);

/** A full workspace fingerprint (`contract.workspace_state`): `sha256:` + 64 hex. */
const FULL_FINGERPRINT_RE = /^sha256:[0-9a-f]{64}$/;
/** The write path's marker spelling: `sha256:` + 12 hex (editFamily.ts `shortSha`). */
export const SHORT_FINGERPRINT_HEX = 12;

/**
 * `profile_binding.reason` texts that only explain how an inferred profile was
 * chosen when nothing was requested (readCodeTaskPack.ts `bindTaskProfile`).
 * The guide already tells the caller that `task.profile` overrides an
 * inference, so the sentence adds nothing a caller can act on. The guardrail's
 * advice ("declare task.profile:\"answer\" for a read-only pack") names a
 * declaration to send and is not on this list: it stays, and so does any
 * reason this list does not know.
 */
export const INFERENCE_EXPLANATION_REASONS: readonly RegExp[] = [
  /^answer-shaped read-only query; task\.profile overrides$/,
];

/** What the pass takes from the call context: the workspace root the trace line is filed under. */
export interface TrimCall {
  readonly workspace?: string;
  readonly codecTraceWorkspace?: string;
  readonly readServeWorkspace?: string;
}

function trimTask(payload: Row, trimmed: string[]): Row | undefined {
  const task = record(payload["task"]);
  const replay = task?.["replay"];
  if (task === undefined || typeof replay !== "string" || payload["qref"] !== replay) return undefined;
  const { replay: _replay, ...rest } = task;
  trimmed.push("task.replay");
  return rest;
}

/** The binding without `confidence`, an `"auto"` request and an inference-explaining reason; `undefined` when nothing applies. */
export function trimProfileBinding(binding: unknown, trimmed: string[] = []): Row | undefined {
  const value = record(binding);
  if (value === undefined) return undefined;
  const out: Row = {};
  let changed = false;
  for (const [key, member] of Object.entries(value)) {
    if (key === "confidence"
      || (key === "requested" && member === "auto")
      || (key === "reason" && typeof member === "string" && INFERENCE_EXPLANATION_REASONS.some((pattern) => pattern.test(member)))) {
      changed = true;
      trimmed.push(`profile_binding.${key}`);
      continue;
    }
    out[key] = member;
  }
  return changed ? out : undefined;
}

/** The marker as `{fingerprint (short), scope, inventory_complete}`; `undefined` when it already is. */
export function trimWorkspaceMarker(marker: unknown, trimmed: string[] = []): Row | undefined {
  const value = record(marker);
  const fingerprint = value?.["fingerprint"];
  if (value === undefined || typeof fingerprint !== "string" || typeof value["scope"] !== "string") return undefined;
  const out: Row = {
    fingerprint: FULL_FINGERPRINT_RE.test(fingerprint) ? fingerprint.slice(0, "sha256:".length + SHORT_FINGERPRINT_HEX) : fingerprint,
    scope: value["scope"],
    // Read by the act floor on the shipped payload (`exhaustiveAbsenceCertified`): never left off.
    ...(typeof value["inventory_complete"] === "boolean" ? { inventory_complete: value["inventory_complete"] } : {}),
  };
  const dropped = Object.keys(value).filter((key) => !(key in out));
  if (dropped.length === 0 && out["fingerprint"] === fingerprint) return undefined;
  if (out["fingerprint"] !== fingerprint) trimmed.push("decision.certificate.workspace.fingerprint");
  for (const key of dropped) trimmed.push(`decision.certificate.workspace.${key}`);
  return out;
}

function trimDecision(payload: Row, trimmed: string[]): Row | undefined {
  const decision = record(payload["decision"]);
  const certificate = record(decision?.["certificate"]);
  if (decision === undefined || certificate === undefined) return undefined;
  const workspace = trimWorkspaceMarker(certificate["workspace"], trimmed);
  return workspace === undefined ? undefined : { ...decision, certificate: { ...certificate, workspace } };
}

/**
 * The trim pass: `payload` is the final payload of a reply of `kind`, `call`
 * the call context the trace line is filed under. Returns `payload` itself
 * when nothing applies or TL_EFF_REPLY_TRIM is off, else a copy; the argument
 * is never mutated.
 */
export function trimReplyMetadata(payload: Row, kind: Kind, call?: TrimCall): Row {
  if (!effReplyTrimEnabled() || !TRIMMED_KINDS.has(kind)) return payload;
  const trimmed: string[] = [];
  let current = payload;
  const task = trimTask(payload, trimmed);
  if (task !== undefined) current = { ...current, task };
  const binding = trimProfileBinding(payload["profile_binding"], trimmed);
  if (binding !== undefined) current = { ...current, profile_binding: binding };
  const decision = trimDecision(payload, trimmed);
  if (decision !== undefined) current = { ...current, decision };
  if (current === payload) return payload;
  const root = call?.workspace ?? call?.codecTraceWorkspace ?? call?.readServeWorkspace;
  if (root !== undefined && root !== "" && isTraceEnabled()) trace("wire_trim", { kind, trimmed }, root);
  return current;
}
