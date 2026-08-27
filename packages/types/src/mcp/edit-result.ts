// ---------------------------------------------------------------------------
// protocol v1 — the edit result family (§2.4), discriminated by SIDE-EFFECT
// STATE rather than by success/failure.
//
// NORMATIVE SOURCE: DESIGN-v0.10 §10.3 Appendix A (Revision 4, approved
// 2026-08-13), the A.5.11–A.5.14 preamble and A.5.11–A.5.14. Implements the
// A.9.1 `edit-result.ts` row.
// ---------------------------------------------------------------------------

import type { ProtocolVersion, WorkspaceMarker } from "./protocol.js";

// ---------------------------------------------------------------------------
// A.5.11–A.5.14 preamble — the §4.2.1(3) minimal core, as a type
// ---------------------------------------------------------------------------

/**
 * §4.2.1(3). The guaranteed-fit floor of every side-effect report.
 * No shedder, validator, budget or serializer may cut any of it, at any
 * budget. If a configured budget cannot fit it the server is MISCONFIGURED,
 * and that is a startup error, not a wire outcome.
 *
 * KIND-STABILITY (§4.2.1(1)), as an invariant on the boundary:
 *
 *   SE-STABLE :=
 *     for K ∈ { "edit.applied", "edit.rolled_back", "edit.state_unknown" },
 *     for every budget B >= the configured minimum:
 *        emit(payload, B).kind === K  AND  emit(payload, B).core is complete.
 *     No B produces a `refusal`, and no B produces a different edit.* kind.
 *
 * `edit.reclassified` is deliberately OUTSIDE SE-STABLE: nothing was written,
 * so §4.2's ordinary fail-closed rule governs it.
 *
 * THE ONE SHED THESE KINDS PERFORM (§4.2.1(4)). Per-edit ranges, `sha`s,
 * `brace_delta`, `enclosing_symbol` and the per-item recovery advisory move
 * server-side and the response carries a RECOVERY HANDLE in their place,
 * fetchable with `read_file` like any other handle. The field is `ledger`. It
 * never touches `core`.
 */
export type SideEffectCore = {
  counts: EditCounts;

  /**
   * Workspace-relative PATHS, not handles (§4.2.1(3)): a handle is a
   * server-side capability token that dies with the process; a path is what a
   * human types into `git diff`. Non-empty on every side-effect report —
   * §4.2.1(5) makes this the load-bearing field, because the recovery handle
   * is session-lived and cannot be re-derived after a restart.
   */
  paths: [string, ...string[]];

  /** Binds the report to the workspace state it describes (A.2.2). */
  workspace: WorkspaceMarker;
};

/** The four counts §4.2.1(3) names: landed, attempted, reverted, unproven. */
export type EditCounts = {
  applied: number;
  attempted: number;
  reverted: number;
  unproven: number;
};

/**
 * Per-file restoration ledger row. Moved from
 * `packages/mcp-server/src/tools/applyEditsMulti.ts:235` per A.9.1 — the
 * emitter keeps its own declaration until the P2 emitter migration re-points
 * it at this one.
 */
export type RollbackFileState = {
  path: string;
  state: "rolled-back" | "restore-failed";
  /** PRE-edit bytes the restore was trying to put back. `restore-failed` only. */
  expected_sha?: string;
  /** What is actually on disk NOW; omitted when the file could not be read. */
  stuck_sha?: string;
  /** Why the restore failed (capped, mirrors the emitter's 160-char preview cap). */
  detail?: string;
};

// ---------------------------------------------------------------------------
// A.5.11 `edit.applied`
// ---------------------------------------------------------------------------

/**
 * One landed edit. Caps at the P1b HEAD: APPLIED_ENTRY_CAP_BYTES = 2048,
 * APPLIED_TOTAL_CAP_BYTES = 8192 (server.ts:4077).
 *
 * THIS IS THE PER-FILE CARRIER, AND IT IS TOTAL OVER `core.paths`
 * (user-adjudicated 2026-08-14, ruling 4). A.5.11 folds today's
 * `files: EditFileResult[]` into `core.paths`, which leaves that array's OTHER
 * three fields — `handle`, `lines`, `delta` — with no declared address at all.
 * They land here, as OPTIONAL fields, because the alternative measured worse:
 *
 *   **`handle` absence induces follow-up round-trips = high-value field,
 *   LAST-stage shed** (P3a note, verbatim). DESIGN-v0.8 B3.1 added the per-file
 *   handle precisely because a multi-file batch left every touched file
 *   handle-less until a separate read round trip minted one.
 *
 * `code` is therefore OPTIONAL rather than required: the post-edit read-back
 * that produces it is best-effort by construction (it skips a file whose range
 * will not parse, whose bytes will not read, or that would overflow
 * APPLIED_TOTAL_CAP_BYTES), while `path`/`lines`/`delta`/`handle` are computed
 * before the write and are always available. An entry WITHOUT `code` is a file
 * this operation wrote and could not read back; it is not an empty read-back,
 * and E-1 forbids spelling that absence `""`.
 */
export type AppliedEntry = {
  path: string;
  /** Post-edit line span, `"N-M"`. The read-back window when one was served,
   *  otherwise the edited span the emitter computed before the write. */
  range: string;
  /** SHA-256 of the compact post-edit slice represented by range. */
  slice_sha?: string;
  /** First line of the post-edit slice (B1, v0.12: capped from 3 -> 1 —
   *  `slice_sha`/`range`/`enclosing_symbol` already anchor the post-edit
   *  state, so `head` is a compact anchor, not a preview). Full code is
   *  exception-only. */
  head?: string[];
  /** Full post-edit disk bytes, retained only for explicit/safety-triggered echo. */
  code?: string;
  brace_delta?: number;
  /** The emitter ships `{symbol, range}`; A.5.11 declares `string`. Both are
   *  carried — see the DIVERGENCE note in `protocol/editFamily.ts`. */
  enclosing_symbol?: string | { symbol: string; range: string };
  /** DESIGN-v0.8 B3.1 per-file handle (kind:"file", POST-edit sha). */
  handle?: string;
  /** Pre-read-back edited span, `"N-M"` (`EditFileResult.lines`). */
  lines?: string;
  /** `"+N/-M"` (`EditFileResult.delta`). */
  delta?: string;
};

/**
 * A.5.12, RESOLVED AS A RECEIPT ON `edit.applied` (user-adjudicated
 * 2026-08-14, ruling 2).
 *
 * Every reclassification this server emits today is attached to an ALREADY
 * SUCCESSFUL WRITE: `guardExecutionEdit` mints it only on its `allowed:true`
 * arm, and `server.ts`'s edit funnel attaches it only when the edit itself
 * succeeded. Porting it to a standalone `edit.reclassified` — whose own §2.4
 * row says "nothing was written" — would therefore DISCARD the side-effect
 * proof, which is the one thing §4.2.1 exists to make impossible.
 *
 * `certificate_id` is REQUIRED, matching the same adjudication's rule for
 * `Refusal.certificate_id`: it is the only non-constant field, it is the
 * correlation key back to the fence that re-typed the call, and a receipt that
 * names no certificate cannot be checked against one.
 *
 * A.5.12's pre-publish union-declaration obligation is DISCHARGED by `trigger`:
 * the emitted set is closed at two values (`state/session.ts`'s
 * `ExecutionReclassification`), and it is declared here rather than left a
 * `string` to be narrowed after publication (§1.4).
 */
export type EditReclassification = {
  trigger: "create" | "grounded-edit";
  certificate_id: string;
};

/**
 * Emitted iff the server ALTERED the caller's payload; absent means the payload
 * was applied as written.
 * §2.4: this is a RECEIPT on `edit.applied`, NOT a sixth outcome — the
 * side-effect state is identical to a plain apply, and a caller branching
 * "applied vs applied-normalized" would be branching on server bookkeeping.
 * All three fields are path lists, verbatim from applyEditsMulti.ts:296-312.
 */
export type NormalizationReceipt = {
  merged_paths?: string[];
  normalized_escapes?: string[];
  normalized_whitespace?: string[];
};

/**
 * `isError` UNSET (§2.5).
 * `recovery` is NOT REPRESENTABLE here (§2.4's normative invariant).
 *
 * Today's `files: EditFileResult[]` folds into `core.paths`: it is the same
 * content, relocated to the floor §4.2.1(3) requires it to occupy. Per-file
 * detail beyond the path is `applied[]`, which is sheddable into `ledger`; the
 * paths are not.
 */
export type EditApplied = {
  v: ProtocolVersion;
  kind: "edit.applied";
  core: SideEffectCore;
  applied: AppliedEntry[];
  /**
   * OPERATION REPLAY MARKER (2026-08-27 field-eval T4, additive/optional —
   * protocol v1's frozen kind set is unaffected, this is a field, not a new
   * member). `true` iff this exact response is a BYTE-IDENTICAL replay of an
   * earlier `operation_id` apply (`state/stateStore.ts`'s operation ledger;
   * see `editFamily.ts`'s `markReplayed`) rather than a fresh dispatch.
   * Absent on every fresh apply — never emitted as `false`.
   */
  replayed?: boolean;
  normalization?: NormalizationReceipt;
  /** A.5.12 as a receipt (ruling 2). Emitted iff the execution fence re-typed
   *  this call from `answer` to `edit` before it wrote. */
  reclassification?: EditReclassification;
  /** Emitted iff a checkpoint was taken. `checkpoint: string | null` at HEAD;
   *  v1 OMITS the field rather than emitting `null`, per §1.3's absence
   *  convention (A.8 rule E-1; A.9.2 row 14). */
  checkpoint?: string;
  /** Prose; shed first under budget pressure (A.8 rule E-7). */
  applied_note?: string;
  /**
   * Recovery handle for the §4.2.1(4) compaction. Emitted iff the full ledger
   * was compacted server-side under budget pressure; absence means the detail
   * is inline — NEVER that there is no detail.
   *
   * SESSION-LIVED, AND STATED RATHER THAN ASSUMED (§4.2.1(5)). A server
   * restart, a crash or a lane eviction loses its backing state, and unlike an
   * ordinary read handle it CANNOT BE RE-DERIVED: the edits already happened,
   * and re-reading the files shows the post-edit state, not the ledger of how
   * it got there. That is why `core` — paths + counts + the workspace marker —
   * must be sufficient for manual recovery on its own, and why `ledger` is an
   * ergonomic improvement over that floor and never a substitute for it.
   *
   * NOT EMITTED AT HEAD, AND THE DEBT IS DECLARED (C2-5, 2026-08-14). The
   * shed this field is the counterpart of does not exist: `AppliedEntry` is
   * capped in bytes (APPLIED_ENTRY/TOTAL_CAP_BYTES) but the cut is a DROP, not
   * a compaction — nothing is moved server-side, so there is nothing a handle
   * could address. `HandleKind` (`util/handles.ts`) has no `ledger` member and
   * no mint or consume path. Minting one here would be a capability token
   * pointing at state that was never retained, which is strictly worse than
   * its absence. Building the compaction is P3a's; until then this field is
   * PERMANENTLY ABSENT, and a client may read its absence as "the detail is
   * inline or was dropped", never as "fetch it here".
   */
  ledger?: string;
};

// ---------------------------------------------------------------------------
// A.5.12 `edit.reclassified`
// ---------------------------------------------------------------------------

/**
 * RESERVED; NOT EMITTED AT HEAD (user-adjudicated 2026-08-14, ruling 2).
 *
 * Current reclassifications ride `EditApplied.reclassification`
 * (receipt-on-applied) because every one of them is attached to a write that
 * ALREADY LANDED — see `EditReclassification`. This kind stays in the closed
 * fifteen-member vocabulary as the member for a GENUINELY-NO-WRITE
 * reclassification, and that is its only legitimate emitter: a response that
 * reports no side effect at all, which is what its §2.4 row ("nothing was
 * written; the call was re-typed") and its exclusion from SE-STABLE both
 * describe. Emitting it for a completed write would assert a falsehood about
 * the caller's disk.
 *
 * `isError` UNSET (§2.5). Nothing was written (§2.4), so no `core`.
 *
 * `action` stays `string`: no value set is declared at HEAD for a no-write
 * reclassification, because none is emitted, and §10.1(b)'s rule — a type with
 * nothing worth declaring is evidence the field should be a `string` — applies
 * to an empty emit set a fortiori. A.5.12's pre-publish union obligation is
 * discharged on the receipt (`EditReclassification.trigger`), which is where
 * the closed set actually lives.
 */
export type EditReclassified = {
  v: ProtocolVersion;
  kind: "edit.reclassified";
  action: string;
};

// ---------------------------------------------------------------------------
// A.5.13 `edit.rolled_back`
// ---------------------------------------------------------------------------

/**
 * `isError: true` (§2.5).
 *
 * Today's `code: "rollback-failed"` is NOT a `RefusalCode` in v1: §2.4 makes
 * the rollback outcome a KIND, so the code that used to carry it is deleted
 * rather than absorbed (A.9.2 row 13).
 */
export type EditRolledBack = {
  v: ProtocolVersion;
  kind: "edit.rolled_back";
  core: SideEffectCore;
  /** Per-file restoration ledger. */
  attempted: RollbackFileState[];
  /** A prose repair-step string (§10.1(b)'s string rule). OPTIONAL here and
   *  REQUIRED on `edit.state_unknown` — §2.4's normative invariant. Emitted iff
   *  the server can name repair steps; absence means the rollback was clean. */
  recovery?: string;
  /**
   * WHICH file's PRIMARY write failed — [R5-25], adjudicated 2026-08-14
   * (ruling 7, A.5.13), PROMOTED from disclosed carry (`editFamily.ts`'s
   * `KEPT_ON_LEDGER`) to a declared optional field. The wire already emits it,
   * so this declaration is documentation with no byte or behaviour delta.
   *
   * Deliberately the one path ABSENT from `attempted[]` and from `core.paths`:
   * an atomic write leaves the failed file at its pre-edit bytes, and the
   * rollback ledger only ever records files it actually touched. `recovery`
   * cannot substitute — it is prose built from the STRANDED rows, never the
   * failed one.
   */
  path?: string;
  /**
   * WHY the write failed — the emitter's own cause prose (e.g. "Cannot write
   * file: EACCES …"). [R5-25], same promotion as `path`. A.5.13 previously
   * declared `recovery` (repair STEPS) with no field for the cause at all.
   * Prose, so A.8 rule E-7 sheds it first under budget pressure.
   */
  detail?: string;
  /** §4.2.1(4) recovery handle; see `EditApplied.ledger`. */
  ledger?: string;
};

// ---------------------------------------------------------------------------
// A.5.14 `edit.state_unknown`
// ---------------------------------------------------------------------------

/**
 * `isError: true` (§2.5).
 *
 * Today this state is signalled by `workspace_state: "workspace-state-unknown"`
 * emitted ONLY alongside `code: "rollback-failed"`, a convention a comment
 * enforces (applyEditsMulti.ts:342-348). In v1 the KIND carries it and the
 * sentinel string is deleted: two flags for three states become two members
 * (A.9.2 row 13).
 */
export type EditStateUnknown = {
  v: ProtocolVersion;
  kind: "edit.state_unknown";
  core: SideEffectCore;
  affected: RollbackFileState[];
  /** REQUIRED here — never absent (§2.4's normative invariant). */
  recovery: string;
  /** WHICH file's PRIMARY write failed. [R5-25] / A.5.14 — the same field and
   *  the same meaning as `EditRolledBack.path`; see there. */
  path?: string;
  /** WHY it failed, as the emitter's cause prose. [R5-25] / A.5.14 — the same
   *  field and the same meaning as `EditRolledBack.detail`; see there. */
  detail?: string;
  /** §4.2.1(4) recovery handle; see `EditApplied.ledger`. */
  ledger?: string;
};
