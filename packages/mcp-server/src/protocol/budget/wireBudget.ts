// ---------------------------------------------------------------------------
// protocol v1 — the wire budget: internal types + the calibrated TABLE (P3a S1).
//
// NORMATIVE SOURCE: DESIGN-v0.10-protocol-v1-contract-freeze.md A.6.2
// (`WireBudget` / `ShedRecord` / `ShedRung` — INTERNAL, never serialized);
// TL-PROTOCOL-V1-PHASE3A-PLAN-DRAFT.md §0.3 (the calibration invariant), §4.3
// (the ladder), §5 (rung numbering), §7.2 (the reserve), errata E1 + E2.
//
// WHAT THIS MODULE IS. One table that answers "how many body bytes may a
// response of this (kind, form) carry?", plus the three internal types the
// ladder books its work in. Nothing here reaches the wire: A.6.2 is explicit
// that `WireBudget` and `ShedRecord` are internal, and `emit.ts` never copies
// either into a payload. What DOES reach the wire is a `Limit{cause:"wire"}`,
// derived from `ShedRecord[]` — and that derivation is S3's, not S1's.
//
// -------------------------- THE CALIBRATION DISCIPLINE ---------------------
//
// §0.3 makes S1 a REFACTOR: the emission pipeline must be byte-invisible, i.e.
// all fifteen wire-baseline pins, the 242-case replay corpus and the
// conformance snapshot stay byte-identical after it lands. A budget that ever
// BINDS would shed bytes and break that invariant on the spot. So every value
// below is a GENEROUS BACKSTOP, derived by one rule and one rule only:
//
//     budget(kind, form) = ceil_to_power_of_two(
//         max( 4 x (largest Class-B feature cap feeding this kind/form),
//              4 x (bytes of the wire-baseline pin for this kind/form) ) )
//
// The 4x factor is headroom for everything that rides OUTSIDE the capped
// content — the envelope (`v`/`kind`), `decision`, `plan`, `execution_contract`,
// `related_lookups`, the workspace-disclosure class, and multi-entry
// composition where a member aggregates several capped units. Pin bytes are
// read off the committed `__tests__/fixtures/wire-baselines/*.json`, which are
// PRETTY-printed and therefore already larger than the compact body they
// represent — a conservative operand on purpose.
//
// "Class-B" is the plan §2.2 demolition class: today's response-level byte
// ceilings, which this table REPLACES once S3 ships the real shedders. Every
// row below names its predecessor constants so gate G10's audit column can be
// filled by reading this file, and so the demolition stage can prove it removed
// the right constant rather than a similarly-named one.
//
// NO ROW IS A TUNING KNOB. Lowering one is a wire change and must go through
// the same calibration evidence the pins do.
// ---------------------------------------------------------------------------

import type { EditCounts, Kind, WorkspaceMarker } from "@tokenlighten/types";

import { isSideEffectKind } from "../editFamily.js";
import { measureResponseBytes } from "./measure.js";

// ---------------------------------------------------------------------------
// A.6.2 — the internal types
// ---------------------------------------------------------------------------

/**
 * The ladder's rung numbering (plan §5's table). Fixed, not an ordering hint:
 * a `ShedRecord`'s `rung` is the CLASS of content that was dropped, so rung
 * numbers are stable across kinds even where a kind implements only some of
 * them.
 *
 *   1  decorative prose (`purpose`, `applied_note`, `served_note`, `note`,
 *      `profile_binding.reason`, `why`) -> `OmittedClass "metadata"`
 *   2  RESERVED-EMPTY. No shedder may ever emit `ShedRecord{rung:2}`; the slot
 *      exists so the numbering in §5's table and in A.6.2 stay aligned while
 *      the class it was reserved for is undecided.
 *   3  rare extensions (`plan.evidence_model`, `wiring.evidence_graph`,
 *      `change_contract.obligations[].reason`, verification-kit bodies)
 *      -> `metadata`
 *   4  strip `Evidence.body`, keep addressing -> `evidence`
 *   5  drop whole `Evidence` entries -> `evidence`
 *   6  drop RESULT RECORDS (`search.*` `files[]`/`references[]` entries,
 *      snippets) -> `results`. NET-NEW, erratum E1: A.6.2's own mapping table
 *      carried a `results` row with no rung to book it against, which made
 *      every `search.*` shed unrecordable. Internal type, so adding the value
 *      is free and non-breaking.
 */
export type ShedRung = 1 | 2 | 3 | 4 | 5 | 6;

/**
 * One accepted rung, booked by the ladder. INTERNAL (A.6.2): never serialized,
 * never copied into a payload. S3 maps `ShedRecord[]` onto the wire-visible
 * `Limit{cause:"wire"}` — and only rungs 4/5/6 may produce one (erratum E5:
 * rungs 1 and 3 withhold prose that no continuation call can recover, so
 * emitting a `limit` for them would violate A.8.1 E-5's "a `wire` limit
 * REQUIRES `next`").
 */
export type ShedRecord = {
  /** Which class of content this step dropped. */
  readonly rung: ShedRung;
  /** Body bytes this step removed, measured as `before - after`. */
  readonly bytes: number;
  /**
   * The handles/paths/identifiers the drop was about, when the step can name
   * them. Absence means the drop is not localisable (e.g. rung 1 prose), not
   * that nothing was dropped.
   */
  readonly refs?: readonly string[];
};

/**
 * The budget one emission runs against. INTERNAL (A.6.2): `emit.ts` holds it
 * on the stack for the duration of one call and never copies it to the wire.
 */
export type WireBudget = {
  /** The (kind, form) row from the table below. */
  readonly limit: number;
  /** Measured body bytes, re-measured after every accepted rung. */
  readonly used: number;
  /** Accepted rungs, in ladder order. Absent when nothing was shed. */
  readonly shed?: readonly ShedRecord[];
};

// ---------------------------------------------------------------------------
// Erratum E2 — the SE-STABLE reserve
// ---------------------------------------------------------------------------

/**
 * §4.2.1(3)'s "small, bounded" side-effect core, sized.
 *
 * The three SE-STABLE kinds (`edit.applied`, `edit.rolled_back`,
 * `edit.state_unknown`) are refusal-conversion-FORBIDDEN: whatever the delivery
 * pressure, a completed effect on the caller's files must still be reported as
 * that effect. That guarantee is only real if the minimal core is guaranteed to
 * FIT, and erratum E2 records that the claim was unproven at Rev 4 —
 * `SideEffectCore.paths` is bounded only by `ADMISSIBLE_EDIT_UNION_CAP = 256`
 * in a different subsystem, so nothing in the protocol tree bounded it.
 *
 * 32 KiB is the committed reserve: 256 paths at a 96-byte repo-relative mean
 * plus the counts/marker/brace-delta scaffolding measures well under it, and
 * the SE budgets below all sit at or above it.
 *
 * SE-STABLE, and DELIBERATELY UNASSERTED IN S1. The startup assertion (plan
 * §7.4: a misconfiguration is a startup error, never a wire outcome) and the
 * measurement that backs the number are S4's deliverable. The constant lands
 * here now because S4's assertion and S3's `editSideEffect` shedder must agree
 * on ONE value, and a second copy of it is exactly the drift this stage exists
 * to prevent.
 */
export const WIRE_RESERVE_BYTES = 32 * 1024;

// ---------------------------------------------------------------------------
// P3a S4 (erratum E2; disposition in prep/C-phase3a-errata-dispositions.md) —
// the reserve's own math, proved rather than merely asserted.
//
// SCOPE (R5 ruling 7 / R5-25): §4.2.1(4)'s ledger-compaction recovery handle
// is EXCLUDED from P3a. This section is the floor-fits PROOF only — it mints
// no `ledgerStore.ts`, and `ledger` stays declared-absent on every response
// this server emits. The `ledger`-handle addend below is forward-compatibility
// headroom for that future field, not a measurement of something that exists.
// ---------------------------------------------------------------------------

/**
 * §7.2's unbounded element, bounded by POLICY rather than by any filesystem
 * fact — direct inspection (S4 recon) found ZERO existing path-length
 * validation anywhere in this tree (`safePath.ts` caps file CONTENT bytes,
 * never `path.length`; no MCP `inputSchema` declares a `maxLength` on a
 * path-shaped property; `PATH_MAX` / `MAX_PATH` do not appear as identifiers
 * in `packages/**`). So this constant is MINTED here, not re-pointed at an
 * existing bound — there is nothing to re-point to.
 *
 * The plan's own §7.2 math used 80 B as its "typical" operand (256 x 80 B ~=
 * 20.5 KiB of paths). 96 B is that same idea tightened against a real
 * measurement rather than a guess: `wireReserveSizing.spec.ts` measures every
 * git-tracked non-fixture source path under `packages/**` (this server's own
 * product source — 545 files at S4-authoring time) and finds mean 48.3 B,
 * p99 69 B, p100 (max) **73 B** — comfortably under 96 with room to spare.
 * Two wider corpora, measured for context and NOT what this constant is
 * sized against, both exceed it: `packages/**` INCLUDING the committed
 * `__tests__/fixtures/wire-baselines/*.json` pins reaches 101 B (one fixture
 * file, `read.receipt.prepared_discovery_closed.json`, 5 B over 96); a
 * repo-wide corpus excluding only `bench/**` and build output reaches 193 B,
 * with 63 of 2577 paths (2.4%) over 96. That is the point of the next
 * paragraph, not a contradiction of it.
 *
 * PATHS CAN EXCEED 96 B — the two wider measurements above prove it inside
 * this very repository — and that is BY DESIGN, not a gap this constant is
 * supposed to close. `RESERVE_MIN` below is a SIZING guarantee for the
 * documented envelope (256 paths x <=96 B), never a truncation trigger: the
 * three SE-STABLE kinds are budget-EXEMPT (plan P7 — `used <= B` is waived
 * for `kind ∈ SE_STABLE`; see `shedders/registry.ts`'s
 * `emptySideEffectLadder` / `refusalConvertible: false`), and §4.2.1 forbids
 * cutting `core` at any size regardless of budget. A workspace with longer
 * paths gets a `core` that runs past this constant's sizing target and ships
 * anyway, in full — it never gets a truncated one.
 */
export const MAX_WORKSPACE_RELATIVE_PATH_BYTES = 96;

/**
 * MIRRORED, not imported: `state/session.ts:2168`'s `ADMISSIBLE_EDIT_UNION_CAP`
 * is module-private (no `export`), and `state/session.ts` is outside this
 * stage's file list (P3a/S4 orchestration keeps scope off the session module
 * — no new export added there for this). Re-declared here under the SAME
 * name so a grep for either finds both sites, with this comment as the drift
 * tripwire: if `state/session.ts`'s cap ever changes, this constant must
 * change with it or `RESERVE_MIN` is computed against the wrong ceiling.
 * `wireReserveSizing.spec.ts` reads `state/session.ts`'s source text and
 * asserts the two stay equal, so drift fails a test rather than sitting
 * silent.
 */
export const ADMISSIBLE_EDIT_UNION_CAP = 256;

/**
 * Worst case per `EditCounts` field, independently maxed at the same cap that
 * bounds `paths`. No single SE-STABLE kind ever reaches this in practice:
 * `edit.applied` always has `reverted = unproven = 0` (`countsFor`,
 * `editFamily.ts`), and `edit.rolled_back` / `edit.state_unknown` always have
 * `applied = 0`. That is deliberate over-counting — `RESERVE_MIN` is ONE
 * shared number covering all three kinds, so it must clear the worst FIELD,
 * not the worst KIND.
 */
const WORST_CASE_EDIT_COUNTS: EditCounts = {
  applied: ADMISSIBLE_EDIT_UNION_CAP,
  attempted: ADMISSIBLE_EDIT_UNION_CAP,
  reverted: ADMISSIBLE_EDIT_UNION_CAP,
  unproven: ADMISSIBLE_EDIT_UNION_CAP,
};

/**
 * Worst case `WorkspaceMarker` on the WRITE path. `workspaceMarkerFor`
 * (`editFamily.ts`) hardcodes `scope: "served-evidence"`, `inventory_files: 0`
 * and `inventory_complete: false` on every edit response — the write path
 * consults no inventory, so none of the three ever varies — which leaves only
 * `evidence_files` (an integer, maxed at the same 3-digit cap) and
 * `fingerprint` (always `shortSha(shaOfText(...))`, a fixed 19 characters:
 * `"sha256:"` + 12 hex) free to vary. Both are pinned at their worst case
 * below, so this is not an estimate — it is the one and only shape this field
 * can take at `fileCount = ADMISSIBLE_EDIT_UNION_CAP`.
 */
const WORST_CASE_WORKSPACE_MARKER: WorkspaceMarker = {
  fingerprint: `sha256:${"0".repeat(12)}`,
  scope: "served-evidence",
  evidence_files: ADMISSIBLE_EDIT_UNION_CAP,
  inventory_files: 0,
  inventory_complete: false,
};

/**
 * Worst case `sizeof(envelope: v, kind, isError, ledger-handle)` (§7.2's own
 * grouping). `kind` at its longest SE-STABLE spelling (`"edit.state_unknown"`,
 * 18 characters — the spread across all fifteen `Kind` values is only 11 B,
 * `wireReserveSizing.spec.ts` measures it). `isError` is a transport-level
 * sibling of `content` on the RPC result (`emit.ts`'s `emitFinalizedPayload`
 * sets it AFTER `text` — and therefore `used` — is already computed), so it
 * never actually rides inside the bytes this reserve bounds; kept anyway
 * because §7.2's formula names it explicitly, at zero practical cost given
 * the headroom below. `ledger` is the not-yet-built §4.2.1(4) handle (ruling
 * 7 / R5-25 excludes it from P3a) — a same-shaped placeholder using this
 * codebase's real handle format (`util/handles.ts`: `"h"` + `BASE36_ID_LENGTH
 * = 10` base36 characters), so the day that field lands this reserve is
 * already sized for it.
 */
const WORST_CASE_ENVELOPE_SHELL: { v: 1; kind: Kind; isError: true; ledger: string } = {
  v: 1,
  kind: "edit.state_unknown",
  isError: true,
  ledger: `h${"0".repeat(10)}`,
};

/**
 * `Buffer.byteLength` over the SAME compact `JSON.stringify` this module's
 * own `measure.ts` uses — never a hand count, so a shape change here
 * recomputes rather than silently drifting.
 */
function measuredBytes(value: unknown): number {
  return measureResponseBytes(JSON.stringify(value));
}

/**
 * Worst case `paths`: `ADMISSIBLE_EDIT_UNION_CAP` entries, each exactly
 * `MAX_WORKSPACE_RELATIVE_PATH_BYTES`. Content is irrelevant to a byte count,
 * so every entry reuses one fixed string — JSON array overhead is identical
 * whether entries are unique or repeated.
 *
 * WHY THIS IS MEASURED AS A REAL ARRAY, NOT `CAP x MAX_BYTES`: an earlier
 * revision of this constant computed the paths component as a bare product
 * (`256 x 96 = 24576`) and summed it with the other components measured
 * separately. `wireReserveSizing.spec.ts`'s own measurement of a real
 * `edit.applied` core at 256 adversarial-length paths caught the gap: bare
 * core came back at 25566 B, ~725-800 B ABOVE that arithmetic. The product
 * counts raw path CONTENT bytes only — it omits the two quote characters
 * bracketing every string, the 255 commas between 256 elements, and the `[`
 * `]` brackets, i.e. the array's own JSON structure. `RESERVE_MIN` below
 * fixes this by measuring `WORST_CASE_CORE` (paths + counts + workspace
 * TOGETHER, as the one object `buildCore` actually returns) in a single
 * `JSON.stringify`, the same way `wireReserveSizing.spec.ts` measures a real
 * one — no hand-summed component can omit a structural byte again.
 */
const WORST_CASE_PATH = "p".repeat(MAX_WORKSPACE_RELATIVE_PATH_BYTES);
const WORST_CASE_PATHS: readonly string[] = Array.from({ length: ADMISSIBLE_EDIT_UNION_CAP }, () => WORST_CASE_PATH);

/** The worst-case `SideEffectCore` shape itself — `edit-result.ts`'s `{counts, paths, workspace}`, at every field's independently-maxed worst case, measured as ONE object so no structural byte (braces/commas/quotes) can be omitted by hand-summing. */
const WORST_CASE_CORE: { counts: EditCounts; paths: readonly string[]; workspace: WorkspaceMarker } = {
  counts: WORST_CASE_EDIT_COUNTS,
  paths: WORST_CASE_PATHS,
  workspace: WORST_CASE_WORKSPACE_MARKER,
};

/**
 * §7.2's formula, MEASURED rather than hand-summed (see `WORST_CASE_PATHS`'s
 * doc comment above for why a hand-summed version undercounts):
 *
 *     RESERVE_MIN = sizeof(WORST_CASE_CORE: counts + paths + workspace TOGETHER)
 *                 + sizeof(WORST_CASE_ENVELOPE_SHELL: v + kind + isError + ledger)
 *
 * At this file's constants: `measuredBytes(WORST_CASE_CORE)` = **25570 B**
 * (of which raw path CONTENT alone, `ADMISSIBLE_EDIT_UNION_CAP x
 * MAX_WORKSPACE_RELATIVE_PATH_BYTES`, is 24576 B — the remaining ~994 B is
 * the `paths` array's own JSON structure plus `counts` + `workspace`) +
 * `measuredBytes(WORST_CASE_ENVELOPE_SHELL)` = 73 B = **25643 B**, against a
 * configured `WIRE_RESERVE_BYTES` of 32768 B — 7125 B (21.7%) of headroom.
 *
 * `wireReserveSizing.spec.ts` measures REAL 1/8/64/256-path payloads (both
 * path-length classes, all three SE-STABLE kinds) through the real family
 * projector + funnel serialization and commits the resulting table as a doc
 * comment below — the empirical confirmation this arithmetic predicts
 * correctly, not merely a paper bound. (Measured `edit.applied` bare core at
 * n=256/adversarial: 25566 B — slightly BELOW this worst case, exactly as
 * expected: `edit.applied`'s real `counts` never has all four fields at 256
 * simultaneously, see `WORST_CASE_EDIT_COUNTS`'s own doc comment.)
 *
 * SCOPE, STATED PLAINLY: this bounds `core` (+ a same-shaped envelope shell)
 * ALONE. The OTHER required content on these three kinds — `applied[]` /
 * `attempted[]` / `affected[]` (one entry per affected file, carrying its own
 * `path` again plus `range`/`handle`/`delta` or
 * `state`/`expected_sha`/`stuck_sha`/`detail`) and `edit.state_unknown`'s
 * REQUIRED `recovery` — is NOT reserve-bounded and, measured, comfortably
 * EXCEEDS `WIRE_RESERVE_BYTES` at `n=256`: `wireReserveSizing.spec.ts`'s own
 * table shows full-minimal-body bytes reaching ~59-64 KB at 256 adversarial-
 * length paths, roughly double the 32 KiB reserve. That is not a defect S4
 * needs to close: `edit.rolled_back` / `edit.state_unknown`'s budget rows sit
 * at EXACTLY `WIRE_RESERVE_BYTES` with zero headroom for exactly this reason
 * (see the floor table below), the plan's own P7 exempts the three SE-STABLE
 * kinds from the `used <= B` ceiling, and §4.2.1 forbids cutting `core` at any
 * size regardless. The guarantee this reserve exists to prove is narrower and
 * more honest than "the whole response always fits": it is "the one field
 * that can never be shed or converted always fits", and the measurement
 * above proves exactly that claim — no more, no less.
 */
export const RESERVE_MIN = measuredBytes(WORST_CASE_CORE) + measuredBytes(WORST_CASE_ENVELOPE_SHELL);

/**
 * E2 DELIVERABLE (ii) — THE MEASURED TABLE, committed next to the constant it
 * validates. `wireReserveSizing.spec.ts` regenerates every number below on
 * every run (its own `console.log` prints the same table) — this comment is
 * the point-in-time record, not a second source of truth; if the two drift,
 * the spec is the one that is still true. Byte counts are DETERMINISTIC
 * serialization output, not timing — machine-independent by construction.
 * "bare" = `JSON.stringify(core)` alone; "full" = the whole minimal response
 * text (envelope + `core` + the kind's other required field: `applied[]` /
 * `attempted[]` / `affected[]` + `recovery`). "typical" = 49 B/path (this
 * repo's own measured `packages/**` mean, see `MAX_WORKSPACE_RELATIVE_PATH_
 * BYTES`'s doc comment); "adversarial" = 96 B/path, this constant's own
 * value.
 *
 * ```
 * kind                n   path-length  bare-core   full-body
 * edit.applied        1   adversarial      315 B       514 B
 * edit.applied         8   adversarial     1008 B      2257 B
 * edit.applied        64   adversarial     6555 B     16258 B
 * edit.applied       256   adversarial    25566 B     64417 B
 * edit.applied         1   typical          268 B       420 B
 * edit.applied         8   typical          632 B      1505 B
 * edit.applied        64   typical         3547 B     10242 B
 * edit.applied       256   typical        13534 B     40353 B
 * edit.rolled_back      1   adversarial      315 B       662 B
 * edit.rolled_back      8   adversarial     1008 B      2265 B
 * edit.rolled_back     64   adversarial     6555 B     15092 B
 * edit.rolled_back    256   adversarial    25566 B     59063 B
 * edit.rolled_back      1   typical          268 B       521 B
 * edit.rolled_back      8   typical          632 B      1466 B
 * edit.rolled_back     64   typical         3547 B      9029 B
 * edit.rolled_back    256   typical        13534 B     34952 B
 * edit.state_unknown    1   adversarial      315 B       818 B
 * edit.state_unknown    8   adversarial     1008 B      2442 B
 * edit.state_unknown   64   adversarial     6555 B     15437 B
 * edit.state_unknown  256   adversarial    25566 B     59984 B
 * edit.state_unknown    1   typical          268 B       677 B
 * edit.state_unknown    8   typical          632 B      1643 B
 * edit.state_unknown   64   typical         3547 B      9374 B
 * edit.state_unknown  256   typical        13534 B     35873 B
 * ```
 *
 * Reads: `bare-core` at `n=256`/adversarial (25566 B, all three kinds —
 * identical because `EditCounts`'/`WorkspaceMarker`'s serialized WIDTH does
 * not depend on which field holds which digit-count, only on the digit
 * counts themselves, which match across kinds at a given `n`) sits
 * comfortably under both `RESERVE_MIN` (25643 B) and `WIRE_RESERVE_BYTES`
 * (32768 B) — the claim this reserve makes. `full-body` at the same cell
 * (59-64 KB) does NOT — see `RESERVE_MIN`'s own doc comment above, "SCOPE,
 * STATED PLAINLY", for why that is expected rather than a gap.
 */

// STATIC ASSERTION (§7.4's `assert reserve >= RESERVE_MIN`), evaluated once at
// module load — before ANY server logic runs, and before the G9 startup check
// at the end of this file re-asserts the same inequality as part of its own
// parameterized, unit-testable validator. Not redundant: this one guards
// every caller of this module (`emit.ts` included), not only the `server.ts`
// `run()` path G9 wires into.
if (WIRE_RESERVE_BYTES < RESERVE_MIN) {
  throw new Error(
    `[tl-mcp] startup misconfiguration: WIRE_RESERVE_BYTES (${WIRE_RESERVE_BYTES} B) is below ` +
      `RESERVE_MIN (${RESERVE_MIN} B) -- the §4.2.1(3) guaranteed-fit proof for the three ` +
      `SE-STABLE edit kinds does not hold at this reserve.`,
  );
}

// ---------------------------------------------------------------------------
// The table — per (kind), then per (kind, form)
// ---------------------------------------------------------------------------

/**
 * The per-kind row. EXHAUSTIVE over `Kind` by type: a sixteenth member fails to
 * compile here rather than silently inheriting some default ceiling.
 *
 * For the three kinds that discriminate internally (`read.map`,
 * `read.receipt`, `search.matches`) this row is the FALLBACK — the family
 * maximum, used when the form cannot be read off the payload. Erring toward the
 * family maximum is the fail-open direction, and fail-open is correct here
 * precisely because §0.3 requires the budget never to bind.
 */
const BUDGET_BY_KIND: Readonly<Record<Kind, number>> = {
  /**
   * 256 KiB. Predecessors: `MAX_TASK_PACK_BYTES_CONSTRUCT_PROOF = 49152`
   * (`features/task-pack/readCodeTaskPack.ts:249`) + `CONSTRUCT_COMPLETE_EXTRA_BUDGET
   * = 10240` (`:274`), which compose on a construct-receiver pack -> 59392.
   * 4 x 59392 = 237568 -> 262144. Pin `read.task_pack.prepared` is 2008 B
   * (4x = 8032), so the cap operand binds. The task pack is the only member
   * that carries `plan` + `decision` + `evidence[]` + a verification kit at
   * once, which is why it holds the largest non-`read.text` row.
   */
  "read.task_pack": 262144,
  /**
   * 512 KiB. Predecessors: `READ_FULL_CAP_BYTES = 81920` and
   * `READ_FULL_CAP_BYTES_ALLOW_FULL = 131072` (`server.ts:1614`, `:1625`) —
   * the `mode=full` ceilings, the largest single-serve caps in the server.
   * 4 x 131072 = 524288. Pin `read.text.slice` is 1617 B. The other feeders
   * (`READ_SYMBOL_CAP_BYTES` / `SLICE_RANGES_TOTAL_CAP_BYTES = 24576`,
   * `readCodeModes.ts:49`, `:62`) are an order of magnitude below the binding
   * operand.
   */
  "read.text": 524288,
  /** Family fallback = the `files` form's row. See `BUDGET_BY_FORM`. */
  "read.map": 262144,
  /**
   * 128 KiB. Predecessor: the 24576-byte read caps that feed batch entries
   * (`MAX_TASK_PACK_BYTES`, features/task-pack/readCodeTaskPack.ts;
   * `READ_SYMBOL_CAP_BYTES`, tools/readCodeModes.ts — the historical
   * must-fetch tier constants in util/mustFetch.ts were removed 2026-08-16 as
   * no-ops once these base caps absorbed them). 4 x 24576 = 98304 -> 131072. Pin `read.batch` is 723 B. The
   * round-up past the bare 4x is deliberate: this member AGGREGATES n entries,
   * each independently bounded by the read caps, so the composition — not any
   * single cap — is what the backstop has to clear.
   */
  "read.batch": 131072,
  /**
   * 64 KiB. Predecessor: `extractOfficeText.MAX_RESPONSE_BYTES = 12288`
   * (`tools/extractOfficeText.ts:77`) -> 4 x 12288 = 49152 -> 65536. Pin
   * `read.artifact` is 10746 B (4x = 42984), the largest pin-derived operand in
   * the table after `search.matches.find` — both operands land in the same
   * bracket, which is the cross-check this row wanted.
   * (`DEFAULT_MAX_BYTES = 1 MiB` at `:69` is an INPUT read guard — plan §2.4
   * Class D — not a response ceiling, and is deliberately not an operand.)
   */
  "read.artifact": 65536,
  /** Family fallback = the `pack-unchanged` form's row. See `BUDGET_BY_FORM`. */
  "read.receipt": 16384,
  /**
   * 64 KiB. Predecessor: `KIT_INLINE_TOTAL_CAP_BYTES = 16384`
   * (`util/verificationPack.ts:242`; per-file `KIT_INLINE_FILE_CAP_BYTES = 4096`
   * at `:241`) — a closure response carries the verification kit, which is its
   * only unbounded-looking element. 4 x 16384 = 65536. Pin `read.closure` is
   * 358 B. (`closureTracking.MAX_FILE_BYTES = 128 KiB` is a Class-D scan guard,
   * not a response ceiling.)
   */
  "read.closure": 65536,
  /** Family fallback = the `find` form's row. See `BUDGET_BY_FORM`. */
  "search.matches": 131072,
  /**
   * 16 KiB. Predecessor: `findReferences.MAX_RESPONSE_BYTES = 2048`
   * (`tools/findReferences.ts:117`) -> 4 x 2048 = 8192. Pin
   * `search.references.paged` is 3622 B -> 4 x 3622 = 14488 -> 16384. This is
   * the one row where the PIN operand binds and the cap operand does not: the
   * C-3 paged contract carries `files[]` + the cursor continuation outside the
   * capped snippet list, which is exactly the "rides outside the cap" headroom
   * the 4x exists for.
   */
  "search.references": 16384,
  /**
   * 8 KiB. Predecessor: `TREE_CAP_BYTES = 2048` (`tools/exploreTree.ts:35`)
   * -> 4 x 2048 = 8192. Pin `search.tree` is 314 B.
   */
  "search.tree": 8192,
  /**
   * 64 KiB, and >= `WIRE_RESERVE_BYTES`. Predecessors:
   * `APPLIED_TOTAL_CAP_BYTES = 8192` / `APPLIED_ENTRY_CAP_BYTES = 2048`
   * (`server.ts:4101`, `:4100`) -> 4 x 8192 = 32768; and
   * `KIT_INLINE_TOTAL_CAP_BYTES = 16384` (`util/verificationPack.ts:242`),
   * because the verification kit rides an applied edit -> 4 x 16384 = 65536,
   * which binds. Pin `edit.applied.create` is 726 B. SE-STABLE: this row must
   * stay >= `WIRE_RESERVE_BYTES` or §4.2.1's guaranteed fit is unprovable
   * (S4 asserts it at startup).
   */
  "edit.applied": 65536,
  /**
   * 32 KiB. Predecessor: `APPLIED_TOTAL_CAP_BYTES = 8192` (`server.ts:4101`)
   * -> 4 x 8192 = 32768. Not SE-STABLE — §2.4's own row says nothing was
   * written — so no reserve floor applies; the answer->edit fence it carries is
   * a small structured record.
   */
  "edit.reclassified": 32768,
  /**
   * 32 KiB, and >= `WIRE_RESERVE_BYTES`. Predecessors:
   * `APPLIED_TOTAL_CAP_BYTES = 8192` (`server.ts:4101`) -> 32768, with
   * `FORENSICS_CAP_BYTES = 1200` and `ANCHOR_REFRESH_CAP_BYTES = 2048`
   * (`write/editForensics.ts:16`, `:28`) as the rollback-specific feeders
   * (4 x 2048 = 8192, below the binding operand). SE-STABLE.
   */
  "edit.rolled_back": 32768,
  /**
   * 32 KiB, and >= `WIRE_RESERVE_BYTES`. Same derivation as
   * `edit.rolled_back`: the recovery block this member carries is bounded by
   * the same forensics constants. SE-STABLE — and the kind where conversion
   * would lie hardest, since "disk unproven" is precisely the claim a refusal
   * would erase.
   */
  "edit.state_unknown": 32768,
  /**
   * 16 KiB. Predecessors: `REFUSAL_MAX_BYTES = 1024`
   * (`validation/requestShape.ts:160`, the schema-name-list ceiling),
   * `CONTINUATION_HARD_CAP_BYTES = 1200` (`util/continuation.ts:59`),
   * `ANCHOR_REFRESH_CAP_BYTES = 2048` and `FORENSICS_CAP_BYTES = 1200`
   * (`write/editForensics.ts`). 4 x 2048 = 8192 -> doubled to 16384 for the
   * A.5.15 advisory composition: a candidate-bearing edit refusal carries
   * several independently-capped excerpts plus `next`, and a refusal that
   * cannot be delivered is the one failure this pipeline has no fallback for.
   * Pin `refusal.edit_create_target_exists` is 605 B.
   */
  "refusal": 16384,
};

/**
 * The three kinds whose payload discriminates INTERNALLY, keyed by the form
 * value the live projector emits. Deriving the form space from the projectors
 * rather than from A.5.x is deliberate — A.5.3 declares five `read.map` forms
 * and the projector emits SIX (`markdown`, `readFamily.ts:905`, minted by Rule
 * K when `mode=overview` lands on a markdown path). A budget table that
 * inherited the appendix's five would have no row for the sixth.
 *
 * A form absent from a row's map falls back to that kind's `BUDGET_BY_KIND`
 * entry, which is the family maximum — fail-open, per §0.3.
 */
const BUDGET_BY_FORM: Readonly<Partial<Record<Kind, Readonly<Record<string, number>>>>> = {
  // `outline.form`, `protocol/readFamily.ts` `structuralOutline()`.
  "read.map": {
    /**
     * 4 KiB. Predecessor: `MAP_CAP_BYTES = 1024` (`tools/readCodeModes.ts:39`,
     * "Maximum serialized JSON bytes for mode=map response") -> 4 x 1024.
     * The surface rows are addressing only (`role`/`handle`/`path`).
     */
    surfaces: 4096,
    /**
     * 256 KiB. Predecessor: `MULTI_FILE_MAP_CAP_BYTES = 65536`
     * (`server.ts:273`) -> 4 x 65536 = 262144. The multi-file map is the
     * largest read.map form by two orders of magnitude, and it is why the
     * kind-level fallback is this value.
     */
    files: 262144,
    /**
     * 8 KiB. Predecessor: `DIGEST_CAP_BYTES = 2048`
     * (`tools/readCodeModes.ts:42`) -> 4 x 2048. A digest is a sha plus
     * addressing.
     */
    digest: 8192,
    /**
     * 16 KiB. Predecessor: `DOC_HEADINGS_CAP_BYTES = DOC_CONTENT_CAP_BYTES =
     * 4096` (`server.ts:285`, `:261`) -> 4 x 4096. THE UNDECLARED SIXTH FORM
     * (`readFamily.ts:905`): A.5.3 does not list it, Rule K minted it, and it
     * gets a row here for exactly that reason.
     */
    markdown: 16384,
    /**
     * 16 KiB. Predecessor: `MAX_OVERVIEW_BYTES = 4096`
     * (`tools/readCodeOverview.ts:15`) -> 4 x 4096.
     */
    overview: 16384,
    /**
     * 32 KiB. Predecessor: `getFileSkeleton.MAX_RESPONSE_BYTES = 8192`
     * (`tools/getFileSkeleton.ts:74`) -> 4 x 8192. Pin `read.map` is 808 B and
     * is a `signatures` payload, so both operands are live here and the cap
     * binds.
     */
    signatures: 32768,
  },
  // `receipt.receipt`, the A.4 tag; `protocol/readFamily.ts` `receiptOf()`.
  // A receipt withholds content by construction, so no Class-B response cap
  // feeds these rows — the pin bytes are the only real operand, and the values
  // are floors chosen an order of magnitude above them.
  "read.receipt": {
    /**
     * 16 KiB. Pin `read.receipt.pack_unchanged` is 565 B (4x = 2260). Raised
     * to 16384 because this is the one form that scales with input: it
     * addresses EVERY surface it withholds (handle + path + range + role +
     * `prior`), so a wide pack's receipt grows with the pack.
     */
    "pack-unchanged": 16384,
    /**
     * 8 KiB. Pin `read.receipt.code_unchanged` is 235 B (4x = 940). Bounded
     * shape: one handle, one sha, one `served_by`.
     */
    "code-unchanged": 8192,
    /**
     * 8 KiB. Pin `read.receipt.prepared_discovery_closed` is 354 B
     * (4x = 1416). Bounded shape: `certificate` + `certified_query`.
     */
    "decision-unchanged": 8192,
    /**
     * 8 KiB. Predecessor: `KIT_NOTE_MAX_BYTES = 240`
     * (`util/verificationPack.ts:1174`). Bounded shape: `kit_ref` + `next`.
     */
    "kit-unchanged": 8192,
    /**
     * 8 KiB. Bounded shape: `{done, total}` plus the closure `next`. No
     * Class-B predecessor — this form has no content to cap.
     */
    "closure-complete": 8192,
  },
  // `matches.form`, `protocol/searchFamily.ts`.
  "search.matches": {
    /**
     * 128 KiB. Predecessors: `findText.MAX_RESPONSE_BYTES = 4096` and
     * `MAX_INVENTORY_RESPONSE_BYTES = 24 * 1024` (`features/search/find/findText.ts:149`,
     * `:164`) -> 4 x 24576 = 98304 -> 131072. Pin `search.matches.find` is
     * 6263 B (4x = 25052) — the largest search pin, and consistent with the
     * cap operand. This is the family maximum and therefore the kind-level
     * fallback.
     */
    find: 131072,
    /**
     * 8 KiB. Predecessor: `searchSymbols.MAX_RESPONSE_BYTES = 2048`
     * (`tools/searchSymbols.ts:38`) -> 4 x 2048.
     */
    symbols: 8192,
    /**
     * 8 KiB. Predecessors: `LOCATE_SUCCESS_CAP = 2048` and
     * `LOCATE_ABSTAIN_CAP = 512` (`features/locator/locateTaskContext.ts:56`,
     * `:57`) -> 4 x 2048. The abstain cap is the smaller arm of the same
     * member and never binds above the success cap.
     */
    locate: 8192,
    /**
     * 8 KiB. Predecessor: `getCurrentDiff.RESPONSE_CAP_BYTES = 2048`
     * (`tools/getCurrentDiff.ts:21`) -> 4 x 2048.
     */
    diff: 8192,
  },
};

/**
 * The budget for one response, by `kind` and — for the three internally
 * discriminated kinds — by the `form` its payload carries.
 *
 * An unknown or absent `form` returns the kind's family maximum. That is the
 * fail-OPEN direction and it is the correct one at S1: §0.3 requires that no
 * legitimate response ever exceeds its row, so a row that is too generous
 * costs nothing while a row that is too tight would shed bytes off a pin.
 */
export function budgetFor(kind: Kind, form?: string): number {
  const byForm = form === undefined ? undefined : BUDGET_BY_FORM[kind]?.[form];
  return byForm ?? BUDGET_BY_KIND[kind];
}

// ---------------------------------------------------------------------------
// P3a S4 — the floor table, and gate G9's startup misconfiguration check.
//
// NORMATIVE SOURCE: TL-PROTOCOL-V1-PHASE3A-PLAN-DRAFT.md §7.4 (the assertion,
// `assert budget[k] >= floorBytes(k) + ENVELOPE_BYTES for every k ∈ Kind`);
// the acceptance-gates table's G9 row.
//
// `floorBytes(kind, form)` is the MINIMUM viable required-set bytes for that
// shape — "how small could a REAL response of this shape legitimately be",
// the companion question to `budgetFor`'s "how large may it get". Two
// sourcing rules:
//
//   - PIN-DERIVED, where a committed `__tests__/fixtures/wire-baselines/*.json`
//     pin exists for the shape: that pin's `bytes_raw` (the literal wire bytes
//     the corpus case emitted — never `bytes_normalized`, which substitutes
//     placeholder text for cross-run comparison and is not a real response
//     anyone received). Where a kind has more than one pinned sample (only
//     `read.task_pack`, at S4-authoring time), the LEANEST of them.
//   - RESERVE-GOVERNED, for the three SE-STABLE kinds: the floor is
//     `WIRE_RESERVE_BYTES` BY CONSTRUCTION, never a pin. `edit.applied.create`
//     (922 B at S4-authoring time) IS pinned, but it is a one-path lucky
//     sample; the guarantee this stage exists to prove is that the budget
//     holds the RESERVE (the worst case `RESERVE_MIN` bounds), not that it
//     holds whatever the smallest recorded sample happened to be. §4.2.1(1)'s
//     refusal-conversion-FORBIDDEN property is why: an under-budgeted
//     SE-STABLE kind cannot fall back to shedding OR converting, so its floor
//     has to be the true worst case, not a sample.
//
// Every row is STILL floor-checked by `validateStartupBudgets` below,
// SE-STABLE included — "reserve-governed" changes where the number comes
// from, not whether the check runs.
// ---------------------------------------------------------------------------

/**
 * No committed wire-baseline pin exists for this shape. A conservative
 * placeholder well under every pinned sample in the whole 15-entry census
 * (the smallest, `read.receipt.code_unchanged`, is 235 B) — enough to catch a genuinely wrong
 * budget (zero, or a stray truncation) without this stage reverse-engineering
 * the read/search families' per-form minimal-body construction, which is
 * outside S4's file list (`readFamily.ts` / `searchFamily.ts` belong to C2-3
 * / C2-4, not this stage). Should any of these forms earn a real pin later,
 * this constant should shrink to reference it, the same way every other row
 * here does.
 */
const UNPINNED_FORM_FLOOR_BYTES = 128;

/**
 * `{v, kind, action}` at its shortest legal `action` (`"create"`, 6
 * characters — `"grounded-edit"` is 13). Not SE-STABLE (`isSideEffectKind`
 * excludes it; `editFamily.ts`'s own comment: "§2.4's own row says nothing
 * was written"), so no reserve floor applies — and no committed pin exists
 * either, so this is measured directly rather than pin-derived, same as the
 * RESERVE_MIN addends above.
 */
const MINIMAL_EDIT_RECLASSIFIED_BODY: { v: 1; kind: Kind; action: string } = {
  v: 1,
  kind: "edit.reclassified",
  action: "create",
};

const FLOOR_BY_FORM: Readonly<Partial<Record<Kind, Readonly<Record<string, number>>>>> = {
  "read.map": {
    surfaces: UNPINNED_FORM_FLOOR_BYTES,
    files: UNPINNED_FORM_FLOOR_BYTES,
    digest: UNPINNED_FORM_FLOOR_BYTES,
    markdown: UNPINNED_FORM_FLOOR_BYTES,
    overview: UNPINNED_FORM_FLOOR_BYTES,
    /** Pin `read.map` (`outline.form: "signatures"`), `bytes_raw` = 808 B (index.json, current HEAD). */
    signatures: 808,
  },
  "read.receipt": {
    /** Pin `read.receipt.pack_unchanged`, `bytes_raw` = 565 B. */
    "pack-unchanged": 565,
    /** Pin `read.receipt.code_unchanged`, `bytes_raw` = 235 B — the smallest pinned `read.receipt` form. */
    "code-unchanged": 235,
    /** Pin `read.receipt.prepared_discovery_closed` — the `decision-unchanged` form's actual shape name — `bytes_raw` = 354 B. */
    "decision-unchanged": 354,
    "kit-unchanged": UNPINNED_FORM_FLOOR_BYTES,
    "closure-complete": UNPINNED_FORM_FLOOR_BYTES,
  },
  "search.matches": {
    /** Pin `search.matches.find`, `bytes_raw` = 6263 B. */
    find: 6263,
    symbols: UNPINNED_FORM_FLOOR_BYTES,
    locate: UNPINNED_FORM_FLOOR_BYTES,
    diff: UNPINNED_FORM_FLOOR_BYTES,
  },
};

const FLOOR_BY_KIND: Readonly<Record<Kind, number>> = {
  /** Leanest of two pins: `read.task_pack.discovery` = 1571 B, `.prepared` = 2008 B. */
  "read.task_pack": 1571,
  /** Pin `read.text.slice`, `bytes_raw` = 1617 B. */
  "read.text": 1617,
  /** Family fallback = the `files` form's floor. See `FLOOR_BY_FORM`. */
  "read.map": 128,
  /** Pin `read.batch`, `bytes_raw` = 723 B. */
  "read.batch": 723,
  /** Pin `read.artifact`, `bytes_raw` = 4634 B. */
  "read.artifact": 4634,
  /** Family fallback = the `pack-unchanged` form's floor. See `FLOOR_BY_FORM`. */
  "read.receipt": 565,
  /** Pin `read.closure`, `bytes_raw` = 358 B. */
  "read.closure": 358,
  /** Family fallback = the `find` form's floor. See `FLOOR_BY_FORM`. */
  "search.matches": 6263,
  /** Pin `search.references.paged`, `bytes_raw` = 1978 B. */
  "search.references": 1978,
  /** Pin `search.tree`, `bytes_raw` = 314 B. */
  "search.tree": 314,
  /** SE-STABLE: reserve-governed (P7 exemption); row = `WIRE_RESERVE_BYTES` by construction. See the section banner above. */
  "edit.applied": WIRE_RESERVE_BYTES,
  /** Not SE-STABLE; no committed pin. Hand-measured minimal shape (see `MINIMAL_EDIT_RECLASSIFIED_BODY` above). */
  "edit.reclassified": measuredBytes(MINIMAL_EDIT_RECLASSIFIED_BODY),
  /** SE-STABLE: reserve-governed (P7 exemption); row = `WIRE_RESERVE_BYTES` by construction. */
  "edit.rolled_back": WIRE_RESERVE_BYTES,
  /** SE-STABLE: reserve-governed (P7 exemption); row = `WIRE_RESERVE_BYTES` by construction. */
  "edit.state_unknown": WIRE_RESERVE_BYTES,
  /** Pin `refusal.edit_create_target_exists`, `bytes_raw` = 458 B. */
  "refusal": 458,
};

/**
 * The floor for one response, by `kind` and — for the three internally
 * discriminated kinds — by `form`. Mirrors `budgetFor`'s own fail-open
 * resolution shape exactly: an unknown or absent `form` returns the kind's
 * family floor.
 */
export function floorBytes(kind: Kind, form?: string): number {
  const byForm = form === undefined ? undefined : FLOOR_BY_FORM[kind]?.[form];
  return byForm ?? FLOOR_BY_KIND[kind];
}

/**
 * A conservative, GENERIC per-row margin for the G9 check below — covers the
 * `kind` string's own length variance (24-35 B across all fifteen values, an
 * 11 B spread; `wireReserveSizing.spec.ts` measures it) plus minor
 * formatting / disclosure-key variance a single pinned sample would not
 * surface. NOT applied to the three SE-STABLE rows (see `budgetRows` below)
 * — their floor is already the headroomed `WIRE_RESERVE_BYTES`, and stacking
 * a second margin on top would demand MORE than the reserve itself promises
 * to hold, which is not a real requirement, only double-provisioning.
 */
const PROTOCOL_ENVELOPE_HEADROOM_BYTES = 64;

const ALL_KINDS: readonly Kind[] = [
  "read.task_pack", "read.text", "read.map", "read.batch", "read.artifact",
  "read.receipt", "read.closure", "search.matches", "search.references",
  "search.tree", "edit.applied", "edit.reclassified", "edit.rolled_back",
  "edit.state_unknown", "refusal",
];

/** One row per `kind`, plus one per (`kind`, `form`) pair `FLOOR_BY_FORM` names — the exact set gate G9 must clear. */
export interface BudgetRow {
  readonly kind: Kind;
  readonly form?: string;
  readonly budget: number;
  readonly floor: number;
  readonly headroom: number;
}

/** Bound to the REAL production tables. `server.ts`'s `run()` calls `assertStartupBudgetsAreSane`, which calls this. */
export function budgetRows(): readonly BudgetRow[] {
  const rows: BudgetRow[] = [];
  for (const kind of ALL_KINDS) {
    const headroom = isSideEffectKind(kind) ? 0 : PROTOCOL_ENVELOPE_HEADROOM_BYTES;
    rows.push({ kind, budget: budgetFor(kind), floor: floorBytes(kind), headroom });
    const forms = FLOOR_BY_FORM[kind];
    if (forms !== undefined) {
      for (const form of Object.keys(forms)) {
        rows.push({ kind, form, budget: budgetFor(kind, form), floor: floorBytes(kind, form), headroom });
      }
    }
  }
  return rows;
}

/**
 * Gate G9, the pure half: "a budget below any kind's floor, or a reserve
 * below `RESERVE_MIN`, exits before serving." PARAMETERIZED so a test can
 * inject a deliberately-bad row or reserve value without touching the real
 * `BUDGET_BY_KIND` / `FLOOR_BY_KIND` / `WIRE_RESERVE_BYTES` — see
 * `wireReserveSizing.spec.ts`'s G9 suite. Throws, naming the offending
 * kind/form, its floor, and the configured value that failed to clear it.
 */
export function validateStartupBudgets(
  rows: readonly BudgetRow[],
  reserve: number,
  reserveMin: number,
): void {
  if (reserve < reserveMin) {
    throw new Error(
      `[tl-mcp] startup misconfiguration: WIRE_RESERVE_BYTES (${reserve} B) is below RESERVE_MIN ` +
        `(${reserveMin} B) -- the §4.2.1(3) guaranteed-fit reserve for the SE-STABLE edit kinds ` +
        `does not hold.`,
    );
  }
  for (const row of rows) {
    const required = row.floor + row.headroom;
    if (row.budget < required) {
      const label = row.form !== undefined ? `${row.kind} (form "${row.form}")` : row.kind;
      throw new Error(
        `[tl-mcp] startup misconfiguration: budget for ${label} is ${row.budget} B, below its floor ` +
          `(${row.floor} B) + envelope headroom (${row.headroom} B) = ${required} B required.`,
      );
    }
  }
}

/**
 * The zero-argument production check: real budget table, real floor table,
 * real reserve. `server.ts`'s `run()` calls this once, strictly before
 * `tryRunWithSdk()` / `runStdioFallback()` starts accepting requests — a
 * throw here propagates to `bin.ts`'s existing fatal catch (`[tl-mcp] fatal:
 * <message>`, exit 1), with zero bytes ever written to stdout, since no
 * transport was created.
 */
export function assertStartupBudgetsAreSane(): void {
  validateStartupBudgets(budgetRows(), WIRE_RESERVE_BYTES, RESERVE_MIN);
}
