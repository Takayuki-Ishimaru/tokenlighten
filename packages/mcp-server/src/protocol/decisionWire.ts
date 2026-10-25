// ---------------------------------------------------------------------------
// protocol v1 — the single decision on the wire, and the affordances it is
// derived from (C2-2).
//
// NORMATIVE SOURCE: DESIGN-v0.10 §2.1 (the decision, emitted once), §2.1.1
// (delivery floors on `act`, F4), §2.1.2 (`next` is a set of now-executable
// calls, F5), §3.4 E4 (the ten deleted re-encodings), §3.4.1 (ORCHESTRATOR
// CONDITION ①), §4.4 (gaps / limits / evidence), and §10.3 Appendix A
// (Revision 4) A.2.3, A.2.4, A.2.6, A.2.7, A.3, A.5.1, A.7.2, A.8.
//
// THE ONE SENTENCE THIS MODULE EXISTS FOR (§3.4.1, normative):
//
//     the set of calls a response sanctions is a function of that response's
//     own emitted affordances.
//
// Not of `route.max_additional_tl_calls` (deleted, §3.4 E4 row 1), not of a
// separately-computed budget. `sanctionFromEvidence()` below takes the ARRAY
// THIS RESPONSE EMITS and nothing else, which is why it is a pure function of
// `Evidence[]` with no second parameter: there is no third input.
// ---------------------------------------------------------------------------

import type {
  AwaitInputCode,
  Candidate,
  CapabilityGap,
  CertificateRef,
  CoverageReason,
  CreateTarget,
  Evidence,
  FrontierEntry,
  SurfaceRole,
  TaskDecision,
  TaskRef,
  ToolCall,
  UnresolvedItem,
  WorkspaceMarker,
} from "@tokenlighten/types";
import type { TaskExecutionContract, TaskCapabilityGap } from "@tokenlighten/types";
import type { TaskPackResult } from "../features/task-pack/model.js";
import {enumStyleReviewOrigin} from "../enumStyleReview.js";
import {goReviewOrigin} from "../goReturnedLocalReview.js";
import {javaLoopGuardOrigin} from "../javaLoopGuardReview.js";

import { emittableToolCall } from "./refusal.js";
import { decisionGradeLiteralAbsenceSubject, discoveryBundleAdvisory, discoveryBundleNext, unservedAddressableRepack, semanticFrontierNextAllowed, sanitizeSemanticFrontierNext, isSemanticFrontierDemotionEligible, sfAwaitInputCandidatePathsFor, parseLedgerMissingRow, isSupportingEvidenceWhy } from "../features/task-pack/canonicalDecision.js";
import { effStructureMapEnabled, semanticFrontierGuardEnabled, sfDemoteEnabled } from "../util/flags.js";
import { ELISION_MARKER_RE } from "../util/formatCompress.js";
import { isSemanticFrontierContinuationOptional } from "../features/task-pack/semanticFrontier.js";
import { noteSemanticFrontierDecisionSuppression, noteSemanticFrontierEvidenceSuppression, noteSemanticFrontierWithholding, semanticFrontierEvidenceWitnessId } from "./semanticFrontierTraceContext.js";
import type { SemanticFrontierWithholdingMarks } from "./semanticFrontierTraceContext.js";
import { isSemanticFrontierNamedJoin, wasSemanticFrontierBodyWithheld } from "../features/task-pack/sfWithholdingMarks.js";

/**
 * §3.4.1: "bounded by the same cap 4 the current implementation applies". The
 * cap is a property of the fence, so it is duplicated from
 * `state/session.ts`'s `SANCTIONED_ZOOM_BUDGET_CAP` deliberately — the fence
 * clamps what it is handed, and this module must not be able to hand it more.
 */
export const SANCTIONED_ZOOM_CAP = 4;

// ---------------------------------------------------------------------------
// A.2.7 `Evidence` — the surfaces[] collapse
// ---------------------------------------------------------------------------

/**
 * `ReadCodeTaskPackSurface` -> `Evidence` (A.2.7).
 *
 * Field mapping, one row each:
 *   handle           -> handle          (§3.3 addressing triple)
 *   path             -> path
 *   range            -> range
 *   code             -> body            (the served bytes)
 *   code_unchanged   -> prior           (§2.3's residency claim, per source)
 *   remaining_ranges -> remaining       (§4.4; ONE of CONDITION ①'s two inputs)
 *   role             -> role            ([R4-2], A.9.2 row 22)
 *
 * A.9.2 row 22 is explicit that `role` must SURVIVE the collapse and must never
 * be defaulted to `"unknown"` — `"unknown"` is an emitted value with its own
 * meaning, and a caller that passed `surfaceRoles` learns from the ABSENCE of
 * `role` that the selector did not bind.
 *
 * 2026-10-23 (codex-copilot-proxy wire compaction): this projector is
 * unchanged — it copies the surface's `role` verbatim, `"unknown"` included,
 * because the readers upstream of the wire (the ladder's rung 5, the act floor,
 * `omitCoveredFrontierIndex`) rank and compare rows by it. What a CALL that
 * passed no `surfaceRoles` receives is decided at the end of the funnel:
 * protocol/wireCompaction.ts leaves `"unknown"` off such a reply's rows
 * (TL_EFF_REPLY_COMPACT), and a call that passed `surfaceRoles` keeps it, so
 * the readback above is that caller's, untouched.
 *
 * THE FIELD ADJUDICATION (C2-3, replacing C2-2's declared passthrough).
 *
 * A.5.1 lists `evidence: Evidence[]` and nothing else, and A.2.7 gives
 * `Evidence` exactly seven members. C2-2 carried every OTHER surface field
 * through unadjudicated and said so, because deciding a field's fate is the
 * body-authoring work item's job. This is that decision, and it is stated as
 * three lists rather than one set difference so the deviations are countable:
 *
 * KEPT PER APPENDIX (A.2.7): handle, path, range, body, prior, remaining, role.
 *
 * KEPT AS A DISCLOSED DEVIATION — four fields, each because deleting it would
 * lose a capability with no other carrier in v1 (Revision-5 rows):
 *   `sha`          the hash an edit pins to (`precondition:"expected-hash"`,
 *                  `tl_edit_file`'s `expectedSha`). `Evidence` declares no sha and
 *                  no other v1 field carries one per surface.
 *   `symbol`       the NAMED selector this window came from. `range` cannot
 *                  express "this is `foo`" — the 2026-08-08 ND-1 finding was
 *                  precisely that a named selector denotes lines it cannot name.
 *   `why`          A.8 rule E-7 lists `why` among the prose fields shed first
 *                  under budget pressure, so the appendix EXPECTS it on the
 *                  wire; deleting it here would contradict A.8.
 *   `likely_edits` the per-surface edit targets. `decision.act.edit.frontier`
 *                  names WHICH files are writable; this names WHERE in them,
 *                  and nothing else on the v1 wire does. (2026-10-23: the
 *                  generic pair — an inspect-slice and a handle-scoped-edit
 *                  hint on the row's own handle — ships as its kinds,
 *                  protocol/wireCompaction.ts; this projector still emits the
 *                  hints whole, since the pack builder reads their confidence
 *                  upstream of the wire.)
 *
 * DELETED — every other surface field. Named, with the rule that kills each:
 *   `content_completeness`  Rule T: per-source truncation IS `remaining`. Two
 *                           fields for one fact is the §4.4 dialect problem.
 *   `next_call`             §2.1.2/F5: continuation authority belongs to the
 *                           single decision, not to N per-surface copies.
 *   `served_by`             renamed: it is what `prior` names.
 *   `facts`                 the guide binds evidence relations to `plan.
 *                           evidence_model`, which is the surviving carrier.
 *   `outline`, `headings`, `anchors_served`, `kind`, `required`, `edit_intent`,
 *   `done_check`, `container_path`, `member_path`, `note`, and anything else a
 *   future surface grows: not in A.2.7, no orphaned capability, so they go.
 *
 * The allow-list is CLOSED by construction below — an unlisted field cannot
 * reach the wire by accident, which is the property C2-2's passthrough lacked.
 */
/**
 * The four disclosed deviations, in one place so the deviation set is one grep.
 * Removing a row here is a pure deletion — no other code reads them.
 */
const EVIDENCE_KEPT_BEYOND_APPENDIX = ["sha", "symbol", "why", "likely_edits"] as const;

/**
 * The residency label a COMPACT `pack-unchanged` re-serve stamps on every
 * body-less surface (§2.3, A.4).
 *
 * WHY THE PROJECTOR SUPPLIES IT. The compact re-serve emits addressing-only
 * surfaces — handle/path/range/role/sha and deliberately no body — because on
 * that response every surface is prior-held BY CONSTRUCTION: that is the
 * receipt's entire claim. But the surfaces carry no per-surface residency
 * marker, so `projectEvidence` produced entries with no `body`, no `prior` and
 * no `remaining`: BARE entries, violating E-8, and — the visible consequence —
 * `answerFloorHolds` below then breached, `projectTaskDecision` degraded a
 * ready `act.answer` to `await_input:"no-grounded-call-remains"`, and
 * `readFamily.ts`'s `pack-unchanged` honesty gate (which refuses a receipt
 * whose decision moved to `discover`/`await_input`) refused the very receipt
 * this response was built to be. A three-step self-inflicted loop whose only
 * cause was an unstated fact.
 *
 * The label is the one `receiptOf` already synthesises for the same entries, so
 * stating it here does not introduce a claim — it moves an existing one to the
 * address §2.1.1's floor and A.8's E-8 both read. §2.1.1: `prior` is VERIFIABLE
 * — the named call is the task_pack call this response is the unchanged
 * re-issue of, which the caller made and holds.
 *
 * FX-M4 (P1): "which the caller ... holds" is the word this label's own
 * consumer (`projectEvidence`, below) used to fail to check per row — see its
 * `remaining.length === 0` guard on the fallback branch. This function still
 * returns one candidate label for the whole receipt; per-row eligibility for
 * it is decided at the call site below, from each row's own `remaining`.
 */
export function packUnchangedPriorLabel(result: Record<string, unknown>): string | undefined {
  if (result["receipt"] !== "pack-unchanged" && result["pack_unchanged"] !== true) return undefined;
  const replay = result["qref"];
  return typeof replay === "string" && replay !== ""
    ? `tl_read_file mode=task_pack qref=${replay}`
    : "tl_read_file mode=task_pack (earlier in this session)";
}

/**
 * FIX-ORIG (2026-09-27, eval-0927 §6.1, brief-fix-orig.md C4): a cheap, pure,
 * no-re-read structural guard at the LAST SEAT before projection — the SAFETY
 * NET for C1 ("evidence[].body is verbatim source of its range") and C2 ("a
 * residency pointer never appears inside body"), not the fix. Every known
 * producer of these two defect shapes is fixed at its own source
 * (queryEvidence.ts's `scoreWindow`; readCodeTaskPack.ts's
 * `singleSiteShortCircuitSeed` and `recoverExplicitIdentifierAnswerCandidates`'s
 * enclosing-symbol fallback; `selectCallableClosureEvidence`). This still runs
 * on every row, because a producer no wave has found yet must not reach the
 * wire uncorrected — see `evidenceOriginalityGuard.spec.ts`, which also proves
 * it is a no-op on every FIXED producer's own output (a safety net that never
 * fires in the ordinary path stays cheap and never masks a real regression).
 *
 * (a) POINTER-CONTAMINATED BODY: `code` itself contains one of the exact
 *     residency-pointer phrases the three residency passes (applyPackDedupe /
 *     applyResidentFileDedup / applyLedgerServedSurfaces, readCodeTaskPack.ts)
 *     stamp into `code_unchanged` — confirmed LIVE (eval-0927 wave, one
 *     session running V01 -> a JA two-line query -> V03 against the SAME
 *     workspace): a `readiness-falsification-counterexample` surface's `code`
 *     carried exactly such contamination by the time it reached this module,
 *     though its own producer (readCodeTaskPack.ts's masked-counterexample
 *     push) served it honestly — the exact intermediate mutator was not
 *     pinned down this wave (see the wave report). This guard neutralizes the
 *     symptom regardless of which producer it turns out to be: a
 *     pointer-shaped body is demoted to a `prior` pointer (the exact line the
 *     phrase appears on — never a partial/garbled remainder) and its body is
 *     dropped, never both (C2).
 * (b) OVER-LENGTH BODY: `code`'s own logical line count (trailing-newline-
 *     aware, matching util/countLines.ts's algorithm — this module has no
 *     filesystem access to re-derive it any other way) EXCEEDS the line span
 *     `range` declares. Every confirmed instance overstates at the TAIL (an
 *     extra line appended after masked/blank filler, mirroring the sibling
 *     N+1-range defect's own always-at-the-end shape), so the correction
 *     keeps the body's own first N lines (N = the declared span) and drops
 *     the rest — the retained prefix is exactly the bytes the producer served
 *     for those lines, nothing is fabricated.
 *
 *     A body SHORTER than its declared span is deliberately left UNCORRECTED
 *     — an earlier version of this guard narrowed `range` down to match, and
 *     `semanticFrontierTrace.spec.ts`'s "activates evidence witnesses only
 *     for optional evidence that survives the actual shed ladder" caught it
 *     live: the existing budget-shedding pipeline (protocol/budget/shedders/*)
 *     legitimately ships a body shorter than `range` while separately
 *     updating `remaining_ranges` to disclose exactly what the shed removed,
 *     and this guard's own "fix" corrupted that already-correct disclosure
 *     into a false, narrower `range` that no longer matched it. That spec is
 *     this guard's recall control for the under-length direction — see its
 *     own retainedOn/retainedOff assertions.
 *
 * Deliberately NOT checked here: whether `range` itself exceeds the FILE's
 * real line count. That needs the file, which this module's own header
 * forbids reading (`sanctionFromEvidence` — and by the same discipline,
 * every function in this module — is a pure function of what it is handed);
 * it is fixed at each producer instead (queryEvidence.ts / readCodeTaskPack.ts).
 */
const EVIDENCE_RESIDENCY_POINTER_PHRASES = [
  " — see prior pack",
  " — duplicate of an earlier surface in this pack",
  "already served this session",
] as const;

function evidencePointerLineWithin(text: string): string | undefined {
  for (const phrase of EVIDENCE_RESIDENCY_POINTER_PHRASES) {
    const at = text.indexOf(phrase);
    if (at === -1) continue;
    const lineStart = text.lastIndexOf("\n", at) + 1;
    const lineEndIdx = text.indexOf("\n", at);
    const lineEnd = lineEndIdx === -1 ? text.length : lineEndIdx;
    return text.slice(lineStart, lineEnd);
  }
  return undefined;
}

/** `code.split("\n")`'s logical (trailing-newline-aware) line count — the
 *  same semantics as util/countLines.ts, restated here because this module
 *  has no import boundary into util/ today and the check is one line. */
function evidenceBodyLogicalLineCount(code: string): number {
  if (code.length === 0) return 0;
  const lines = code.split("\n");
  return lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
}

function guardEvidenceOriginality(
  code: string,
  range: string | undefined,
): { body?: string; prior?: string } {
  const pointer = evidencePointerLineWithin(code);
  if (pointer !== undefined) return { prior: pointer };
  const bounds = typeof range === "string" ? /^(\d+)-(\d+)$/.exec(range) : null;
  if (bounds === null) return { body: code };
  const span = Number(bounds[2]) - Number(bounds[1]) + 1;
  if (!(span > 0)) return { body: code };
  const logical = evidenceBodyLogicalLineCount(code);
  if (logical <= span) {
    // Under-length (or exact) is deliberately left uncorrected: the existing
    // budget-shedding pipeline (protocol/budget/shedders/*) legitimately
    // ships a body SHORTER than its own `range` while separately updating
    // `remaining_ranges` to disclose exactly what that shed removed (see
    // semanticFrontierTrace.spec.ts's "activates evidence witnesses only for
    // optional evidence that survives the actual shed ladder" — the ORIGINAL
    // regression control for this guard: an earlier version of this function
    // also narrowed `range` to match a shed-shortened body, corrupting the
    // shedder's own already-correct `remaining` disclosure into a false
    // `range` that no longer matched it). A body that is under-length for a
    // reason OTHER than a disclosed shed is a real, not-yet-observed defect
    // this guard cannot safely distinguish from a legitimate shed without
    // knowing which pass produced it — recall bar wins; leave it alone.
    return { body: code };
  }
  // Over-length: the producer's real, verbatim content is the PREFIX (see
  // header) — drop the excess tail rather than reject the whole body.
  const lines = code.split("\n");
  return { body: lines.slice(0, span).join("\n") };
}

/**
 * eval-0927 §6.1: an answer surface's `code` can end in windows cut from OTHER
 * lines of the same file (`buildAnswerTaskPack`'s query-focused member and
 * query facet excerpts), each introduced by a marker line and recorded in
 * `appended_windows`. Internally that stays one surface — trimming and the
 * proof passes treat it as one — but on the wire every body must be verbatim
 * source of its own range, so the head keeps the surface's `range` and each
 * appended window ships as its own row on the same handle with the lines it
 * holds; the marker lines never reach the wire. Before this split,
 * `guardEvidenceOriginality` cut the glued body at the head's line span,
 * which dropped the later windows (T03 lost its `shipping` window) while the
 * earlier ones still shipped under the head's range.
 *
 * A marker a trim cut away is simply not found and its window does not ship.
 * A window with no elision marker is contiguous source, so when a trim cut it
 * short the lines it kept name its range.
 */
function splitAppendedWindows(
  code: string,
  recorded: unknown,
  range?: string,
): { head: string; headRange?: string; windows: Array<{ range: string; body: string }> } | undefined {
  if (!Array.isArray(recorded) || recorded.length === 0) return undefined;
  const found: Array<{ at: number; end: number; range: string }> = [];
  let from = 0;
  for (const entry of recorded) {
    if (entry === null || typeof entry !== "object") continue;
    const marker = (entry as Record<string, unknown>)["marker"];
    const range = (entry as Record<string, unknown>)["range"];
    if (typeof marker !== "string" || marker === "" || typeof range !== "string") continue;
    const at = code.indexOf(marker, from);
    if (at === -1) continue;
    found.push({ at, end: at + marker.length, range });
    from = at + marker.length;
  }
  if (found.length === 0) return undefined;
  const windows: Array<{ range: string; body: string }> = [];
  found.forEach((entry, index) => {
    const last = index === found.length - 1;
    let body = code.slice(entry.end, last ? code.length : found[index + 1]!.at);
    if (last) body = body.replace(/\n{2,}$/, "\n");
    const bounds = /^(\d+)-(\d+)$/.exec(entry.range);
    const kept = evidenceBodyLogicalLineCount(body);
    if (bounds === null || kept === 0) return;
    const start = Number(bounds[1]);
    const end = ELISION_MARKER_RE.test(body) ? Number(bounds[2]) : Math.min(Number(bounds[2]), start + kept - 1);
    windows.push({ range: `${start}-${end}`, body });
  });
  const head = code.slice(0, found[0]!.at);
  // v0.16 6t-7 T03 (TL_EFF_STRUCTURE_MAP, util/flags.ts): the head names the
  // lines it holds, as each window does. The surface's `range` spans the
  // windows too (the served ledger books `range` minus `remaining_ranges`), so
  // stamping it on the head row claimed every line between them. A head with
  // an elision marker keeps the declared range, whose exact segments
  // sourceFidelity.ts rebuilds from the rendering. Flag off, every head keeps
  // the declared range, as before.
  const headBounds = range === undefined || !effStructureMapEnabled() ? null : /^(\d+)-(\d+)$/.exec(range);
  const headKept = evidenceBodyLogicalLineCount(head);
  const headRange = headBounds !== null && headKept > 0 && !ELISION_MARKER_RE.test(head)
    ? `${headBounds[1]}-${Math.min(Number(headBounds[2]), Number(headBounds[1]) + headKept - 1)}`
    : undefined;
  return { head, ...(headRange !== undefined ? { headRange } : {}), windows };
}

// ---------------------------------------------------------------------------
// Where the Go returned-local review rides (2026-10-22, codex-copilot-proxy r18
// T07).
//
// The review is a source-order fact about one write target. `projectEvidence`
// appends it to the row's `why`, a provenance field the agent guide never
// mentions; the decision's `frontier` is the field the guide sends an agent to
// for the files it may write. When the reply that ships is an `act.edit` whose
// frontier names the review's file, the fact moves onto that frontier entry
// (`relocateGoReviewsToFrontier`), where the agent chooses its edit, and the row
// keeps the `why` it would have had without the review. Every other reply keeps
// the text in `why`, byte for byte. `projectEvidence`'s own output does not
// change: the row only remembers, off the wire, what the move needs.
// ---------------------------------------------------------------------------
const GO_REVIEW_RELOCATION = Symbol("tl.goReviewRelocation");
type GoReviewRelocation = Readonly<{ path: string; text: string; whyWithoutReview: unknown }>;

function markGoReviewRelocation(row: Evidence, relocation: GoReviewRelocation): void {
  Object.defineProperty(row, GO_REVIEW_RELOCATION, {
    value: Object.freeze(relocation), enumerable: false, configurable: true, writable: true,
  });
}

/** Whether any remaining range is not a plain `N-M` span or overlaps `window` (a `N-M` span): the body then is not all of it. */
function remainingTouchesWindow(remaining: readonly string[], window: string): boolean {
  const own = /^(\d+)-(\d+)$/u.exec(window);
  if (own === null) return remaining.length > 0;
  const [start, end] = [Number(own[1]), Number(own[2])];
  return remaining.some(range => {
    const rest = /^(\d+)-(\d+)$/u.exec(range.trim());
    return rest === null || (Number(rest[1]) <= end && Number(rest[2]) >= start);
  });
}

/**
 * Moves each projected row's Go returned-local review onto the `act.edit`
 * frontier entry of the same path: `entry.review` takes the text and the row's
 * `why` returns to its pre-review value (the key is dropped when the review
 * created it). A second row of that path carrying the same text is restored
 * too, so the fact rides the wire once; a row with another text keeps its
 * `why`. Does nothing unless `decision` is an `act.edit` with a frontier entry
 * for that path, so the call is safe on any decision and on a second pass. Java
 * loop-guard and enum-style reviews stay in `why`.
 *
 * Fail-open (2026-10-22, review of the r18 T07 change): the move never throws
 * and never loses the fact. An entry that cannot take a key is skipped, and a
 * row whose move fails keeps its `why` exactly as projected, with the entry's
 * key undone.
 */
export function relocateGoReviewsToFrontier(decision: TaskDecision | undefined, evidence: readonly Evidence[]): void {
  try {
    if (decision === undefined || decision.kind !== "act.edit" || decision.frontier === undefined) return;
    for (const row of evidence) {
      try {
        moveGoReview(decision.frontier, row);
      } catch {
        // The review stays in this row's `why`, as projected.
      }
    }
  } catch {
    // Likewise: nothing moved is the old behavior.
  }
}

function moveGoReview(frontier: readonly FrontierEntry[], row: Evidence): void {
  const relocation = (row as { [GO_REVIEW_RELOCATION]?: GoReviewRelocation })[GO_REVIEW_RELOCATION];
  if (relocation === undefined) return;
  const entry = frontier.find((candidate) => candidate.path === relocation.path);
  if (entry === undefined) return;
  let placed = false;
  if (entry.review === undefined) {
    if (!Object.isExtensible(entry)) return;
    entry.review = relocation.text;
    placed = true;
  } else if (entry.review !== relocation.text) {
    return;
  }
  const record = row as unknown as Record<string, unknown>;
  try {
    if (relocation.whyWithoutReview === undefined) delete record["why"];
    else record["why"] = relocation.whyWithoutReview;
  } catch (error) {
    if (placed) {
      try { delete entry.review; } catch { /* the entry keeps a fact the row also keeps */ }
    }
    throw error;
  }
  try {
    Object.defineProperty(row, GO_REVIEW_RELOCATION, {
      value: undefined, enumerable: false, configurable: true, writable: true,
    });
  } catch {
    // Already moved; a second pass finds the same text on the entry and restores the same `why`.
  }
}

export function projectEvidence(surfaces: unknown, priorForBodyless?: string): Evidence[] {
  if (!Array.isArray(surfaces)) return [];
  // D5: the two flags are mutually exclusive — `flags.ts`'s
  // `assertSemanticFrontierV2FlagConsistency`, invoked once from `server.ts`
  // startup, throws before the server accepts a call otherwise — so at most
  // one of these is ever true within a running process.
  const guardActive = semanticFrontierGuardEnabled();
  const demoteActive = !guardActive && sfDemoteEnabled();
  // W-DEMOTE (§3.5): demoted rows are collected separately and appended
  // AFTER every other row, so a supporting candidate is reachable but never
  // competes with a required/primary row for front-of-array attention. Flag
  // off (or the legacy guard on instead) leaves `demoted` empty forever, so
  // the returned order is exactly the input order — byte-identical (§4.4).
  const primary: Evidence[] = [];
  const demoted: Evidence[] = [];
  for (const surface of surfaces) {
    if (surface === null || typeof surface !== "object" || Array.isArray(surface)) continue;
    const record = surface as Record<string, unknown>;
    const handle = typeof record["handle"] === "string" ? record["handle"] : "";
    if (handle === "") continue;
    // `required` expresses edit/primary status, not continuation duty. Only
    // the internal semantic-frontier annotation suppresses a remainder.
    const suppressRemaining = guardActive
      && isSemanticFrontierContinuationOptional(surface as TaskPackResult["surfaces"][number])
      && Array.isArray(record["remaining_ranges"])
      && record["remaining_ranges"].some((entry) => typeof entry === "string");
    const remaining = (!suppressRemaining)
      && Array.isArray(record["remaining_ranges"])
      ? record["remaining_ranges"].filter((entry): entry is string => typeof entry === "string")
      : [];
    // W-DEMOTE: demote-not-remove. canonicalDecision.ts's
    // `isSemanticFrontierDemotionEligible` is OPT-IN — it is only true for a
    // surface that canonicalDecision.ts's marking pass affirmatively proved
    // is SF-optional, not one of
    // `snapshot.requiredAddresses` (I-2), and whose bytes the caller does not
    // already hold (D4).
    // THE BODY DOES NOT COME OFF HERE. `typeof record["code"] !== "string"`
    // below is deliberate and stays: this projector never withholds a body it
    // was handed, because every serve-booking producer upstream (server.ts's
    // `recordTaskPackSurfaceReads`, `recordServedEditAdmissibility`, the
    // cumulative served-surface log, `rememberCertifiedWorkingSet`,
    // `recordPackServedRanges`) has already read `surface.code` as the truth
    // about what this response sends. `canonicalDecision.ts`'s
    // `applySemanticFrontierDemotion` is what strips the body and widens
    // `remaining_ranges` to cover it; it runs at readCodeTaskPack.ts's
    // PRE-BOOKING seam, inside `dedupeTrimAndPersist`, AFTER
    // `finalizePackServeState` (the classifier needs the finalized
    // `execution_contract`) and before `bookShippedPackServeState` — the one
    // pass that books, and the one FX-J routed every `TL_SF_DEMOTE` producer
    // through so the ordering claim holds for all of them rather than for
    // some (round-13 finding 1, round-14 finding 1). FX-K made that pass
    // unconditional, so the same claim now holds with every flag off, where
    // `trimToCap` Phase E/F is what sheds the body (round-15 finding 1).
    // The enumeration above is the set the pass owns, NOT every writer:
    // `recordEpochTaskContract`, `reconcileEpochTaskContract` and (under
    // `TL_COVERAGE_PACKER=v2`) `recordPriorPackObligations` also assert
    // served-ness, from post-`trimToCap` but pre-seam positions the contract
    // rebuild forces — see canonicalDecision.ts's W-DEMOTE header and the
    // per-producer allowlist in `sfBookingOrderFence.spec.ts`. By the time an
    // eligible surface reaches this loop it is already bodyless, and this gate
    // simply ranks it into the supporting tail.
    // `remaining.length > 0` here is never suppressed by `guardActive`
    // (mutually exclusive above), so a demoted row's `remaining` is always
    // the FULL, un-suppressed range — the exact repair for the legacy
    // deletion this wave retires.
    const demotable = demoteActive
      && remaining.length > 0
      && typeof record["code"] !== "string"
      && isSemanticFrontierDemotionEligible(surface);
    const carried: Record<string, unknown> = {};
    for (const key of EVIDENCE_KEPT_BEYOND_APPENDIX) {
      const value = record[key];
      if (value === undefined || value === null) continue;
      if (typeof value === "string" && value === "") continue;
      if (Array.isArray(value) && value.length === 0) continue;
      carried[key] = value;
    }
    // C4 (see guardEvidenceOriginality's own header): only when there IS a
    // body to check (a demoted row already carries none, and its own branch
    // below is untouched). `undefined` means "nothing to correct" so every
    // OTHER row's projection stays byte-identical to before this guard existed.
    const appended = !demotable && typeof record["code"] === "string"
      ? splitAppendedWindows(record["code"], record["appended_windows"], typeof record["range"] === "string" ? record["range"] : undefined)
      : undefined;
    const originalityGuard = !demotable && typeof record["code"] === "string"
      ? guardEvidenceOriginality(appended?.head ?? record["code"], typeof record["range"] === "string" ? record["range"] : undefined)
      : undefined;
    // Prose derived from a complete callable survives only with that exact
    // fresh body after the last originality guard.
    const deliveredBody = originalityGuard === undefined ? appended?.head ?? record["code"] : originalityGuard.body;
    // The first origin is the Go review: keep it, and this row's `why` without it, for
    // `relocateGoReviewsToFrontier` (the later origins always stay in `why`).
    let goReview: Pick<GoReviewRelocation, "path" | "text"> | undefined;
    let whyWithoutGoReview: unknown = carried["why"];
    for (const [index, origin] of [goReviewOrigin(surface), javaLoopGuardOrigin(surface), enumStyleReviewOrigin(surface)].entries()) {
      // The Go review is about one function whole in its window, so what remains of the FILE does not matter (a
      // remaining range that touches the window does); the other origins need the surface to have nothing remaining.
      if (origin !== undefined && deliveredBody === origin.body && originalityGuard?.prior === undefined
        && record["path"] === origin.path && record["range"] === origin.range
        && record["content_completeness"] !== "partial"
        && (index === 0 ? !remainingTouchesWindow(remaining, origin.range) : remaining.length === 0)
        && (!Array.isArray(record["appended_windows"]) || record["appended_windows"].length === 0)) {
        carried["why"] = typeof carried["why"] === "string" ? carried["why"] + "; " + origin.text : origin.text;
        if (index === 0) goReview = { path: origin.path, text: origin.text };
        else whyWithoutGoReview = typeof whyWithoutGoReview === "string" ? whyWithoutGoReview + "; " + origin.text : origin.text;
      }
    }
    const projected: Evidence = {
      handle,
      // §3.3's addressing triple, plus [R4-2] / A.9.2 row 22: `role` SURVIVES
      // the collapse, and is never defaulted to "unknown" — absence tells a
      // caller that passed `surfaceRoles` that the selector did not bind.
      ...(typeof record["path"] === "string" ? { path: record["path"] } : {}),
      ...(typeof record["range"] === "string" ? { range: appended?.headRange ?? record["range"] } : {}),
      // A demoted row is bodyless BY DEFINITION (§3.5.1's supporting tier):
      // no `body`, no `prior` — just enough to stay addressable via `handle`
      // + `remaining` in a follow-up call.
      ...(originalityGuard?.body !== undefined ? { body: originalityGuard.body } : {}),
      // FX-M4 (P1, 2026-09-03): the fallback branch used to fire for EVERY
      // code-less, non-`code_unchanged` row on a `pack-unchanged` receipt,
      // regardless of whether THIS row's bytes were ever shipped — a
      // byte-cap-stripped row (readCodeTaskPack.ts's `trimToCap` Phase E)
      // that never carried a body got the same "you already hold this"
      // `prior` claim as a row that genuinely did. `remaining.length === 0`
      // is the fix: `compactReceiptFromRecord`'s `surfaceRangeShipped` check
      // (the ledger, not the record's own self-report) is the ONLY producer
      // that stamps `remaining_ranges` on a compact-receipt row, and it does
      // so exactly for a row the ledger cannot prove was shipped — so a row
      // carrying `remaining` here has an unserved window by construction and
      // must not also claim `prior`. A row with no `remaining` is unaffected
      // (byte-identical to before).
      //
      // C4: `originalityGuard.prior` (the pointer phrase the guard found
      // INSIDE `code`) takes precedence — it is proof this row's `code` was
      // never a genuine fresh body, so C2 forbids emitting it as one; a
      // legitimate `code_unchanged`/`priorForBodyless` prior is unaffected
      // (guard returns `undefined` whenever `code` is clean).
      ...(originalityGuard?.prior !== undefined
        ? { prior: originalityGuard.prior }
        : !demotable && typeof record["code_unchanged"] === "string"
          ? { prior: record["code_unchanged"] }
          : !demotable && priorForBodyless !== undefined && typeof record["code"] !== "string" && remaining.length === 0
            ? { prior: priorForBodyless }
            : {}),
      ...(remaining.length > 0 ? { remaining } : {}),
      ...(typeof record["role"] === "string" ? { role: record["role"] as SurfaceRole } : {}),
      ...carried,
    };
    if (goReview !== undefined) markGoReviewRelocation(projected, { ...goReview, whyWithoutReview: whyWithoutGoReview });
    if (suppressRemaining) noteSemanticFrontierEvidenceSuppression(projected as unknown as Record<string, unknown>);
    // FX-R3d (D10): carry the PRODUCER's own record of who withheld this
    // row's body forward to the funnel exit, keyed by the projected row's own
    // addressing triple so `protocol/envelope.ts` can intersect it with the
    // final wire. Publishing is unconditional on what the row ended up
    // carrying — the envelope decides whether it actually shipped bodyless —
    // and gated on `demoteActive` so the legacy/guard/flag-off arms emit
    // nothing and their counters stay absent (§4.4).
    //
    // FX-OH F2 (2026-09-04) — THESE MARKS HAVE A SECOND CONSUMER NOW.
    // `readFamily.ts`'s `nextTargetsWithheldFrontierRow` reads the same two
    // sets to refuse promoting a withheld SUPPORTING/caller-named row to the
    // response-level `limit.next`. That is why the marks are published for
    // EVERY such row here rather than only for the ones a counter would need:
    // measurement and the `limit` degrade are two readings of one fact, and a
    // second, independently-derived predicate over wire SHAPE is exactly the
    // class of defect D10 retired. Still gated on `demoteActive`, so the
    // flag-off wire keeps both the empty counters and the untouched `limit`.
    if (demoteActive) {
      const projectedRecord = projected as unknown as Record<string, unknown>;
      if (wasSemanticFrontierBodyWithheld(surface)) noteSemanticFrontierWithholding("demoted", projectedRecord);
      if (isSemanticFrontierNamedJoin(surface)) noteSemanticFrontierWithholding("named", projectedRecord);
    }
    (demotable ? demoted : primary).push(projected);
    for (const window of appended?.windows ?? []) {
      const guarded = guardEvidenceOriginality(window.body, window.range);
      primary.push({
        handle,
        ...(typeof record["path"] === "string" ? { path: record["path"] } : {}),
        range: window.range,
        ...(guarded.body !== undefined ? { body: guarded.body } : {}),
        ...(guarded.prior !== undefined ? { prior: guarded.prior } : {}),
      });
    }
  }
  return demoted.length > 0 ? [...primary, ...demoted] : primary;
}

// ---------------------------------------------------------------------------
// W-DEMOTE (§6 P-2) — re-suppression / demotion counters.
//
// WHAT THESE COUNT, AND WHY IT IS NOT THE WIRE SHAPE (FX-R3d, D10,
// 2026-09-04). `demoted_count` used to be read off the SHAPE of the projected
// rows: no `body`, no `prior`, a non-empty `remaining` ⇒ "demoted". That
// definition cannot tell a body W-DEMOTE withheld from a body some OTHER
// mechanism never sent, and after D8 (FX-R3c) the difference became routine —
// a caller-named file joins the frontier bodyless whenever it exceeds the
// join's inline bound or the pack's byte cap. On the sealed SF05 replay
// exactly that happened (a 1514-line caller-named document shipping as
// `remaining:["1-1514"]`): the attestation read `demoted_count:1,
// committed:true` while `applySemanticFrontierDemotion` had withheld ZERO
// bodies. Since `committed` is the engagement signal for the deterministic v2
// gate, the smoke floor and the paid A/B, shape-based counting INFLATED
// engagement with non-demotions. That is a measurement-honesty defect, and it
// is fixed here rather than tuned around.
//
// The rule now: only rows the demotion pass ITSELF marked
// (`features/task-pack/sfWithholdingMarks.ts`, set inside
// `applySemanticFrontierDemotion`) can count, and only if the FINAL shipped
// wire still shows them bodyless.
//   - a marked row that ships bodyless  -> counted;
//   - a marked row that ends up with a body or a `prior` (force_serve, a
//     receipt restatement, any later re-serve) -> NOT counted;
//   - an unmarked bodyless row -> NEVER counted, whatever its shape.
//
// `re_suppression_count` (I-2/D4) keeps its role as the INDEPENDENT invariant
// witness, and is now scoped to marked rows too: a row this pass withheld
// whose address the same wire simultaneously proves the caller holds — a body
// or a `prior` for the same path on some other row — is a re-suppression. That
// is the wire-observable signature of the intra-pack residency defect D3(b)
// fixed (live: `drv_baro.h` shipping a bodied `1-49` row beside a demoted
// `1-23` row). It must be 0; it is measured, never assumed.
//
// `withheld_named_count` is the residual the old definition used to hide
// inside `demoted_count`: rows D8's caller-named frontier join minted that
// ship bodyless (past its inline bound or `trimToCap` Phase E) and that
// W-DEMOTE did not touch. It stays visible — an unserved caller-named
// address is worth seeing — without polluting the engagement signal.
//
// EXEMPTNESS IS STILL READ FROM THE WIRE ALONE. `exemptPaths` is supplied by
// the caller (`protocol/envelope.ts`) and derived from the same observed
// evidence array, never from ledger/snapshot state, so this function stays
// what it always was: the independent check, computed without re-deriving
// eligibility. Only its INPUT set changed — a mark, which the producer
// asserts, replaces a shape, which anything could accidentally wear.
// ---------------------------------------------------------------------------

export interface SemanticFrontierDemotionCounters {
  /** Rows `applySemanticFrontierDemotion` withheld and the wire still ships bodyless. */
  readonly demotedCount: number;
  /** Counted demotions whose `path` is in `exemptPaths`. Must be 0 (I-2/D4). */
  readonly reSuppressionCount: number;
  /** Caller-named D8 rows shipped bodyless that W-DEMOTE did not demote. */
  readonly withheldNamedCount: number;
}

/** True when the FINAL wire row carries no bytes and no prior-held claim. */
function shipsBodyless(entry: Evidence): boolean {
  return entry.body === undefined && entry.prior === undefined;
}

export function semanticFrontierDemotionCounters(
  evidence: readonly Evidence[],
  exemptPaths: ReadonlySet<string>,
  marks: SemanticFrontierWithholdingMarks,
): SemanticFrontierDemotionCounters {
  let demotedCount = 0;
  let reSuppressionCount = 0;
  let withheldNamedCount = 0;
  for (const entry of evidence) {
    if (!shipsBodyless(entry)) continue;
    const id = semanticFrontierEvidenceWitnessId(entry as unknown as Record<string, unknown>);
    if (marks.demoted.has(id)) {
      demotedCount += 1;
      if (entry.path !== undefined && exemptPaths.has(entry.path)) reSuppressionCount += 1;
      continue;
    }
    // A caller-named row is only reported here when W-DEMOTE did not demote
    // it; the `continue` above makes the two counts disjoint by construction.
    if (marks.named.has(id) && entry.remaining !== undefined && entry.remaining.length > 0) {
      withheldNamedCount += 1;
    }
  }
  return { demotedCount, reSuppressionCount, withheldNamedCount };
}

// ---------------------------------------------------------------------------
// §3.4.1 ORCHESTRATOR CONDITION ① — the sanctioned-zoom affordance, re-anchored
// ---------------------------------------------------------------------------

export interface SanctionedZoom {
  /** Handles this response left partial — the ONLY handles a zoom may name. */
  handles: string[];
  /** How many zooms are sanctioned: one per advertising entry, capped at 4. */
  budget: number;
}

/**
 * CONDITION ① (§3.4.1), in full.
 *
 * BEFORE (the wiring this replaces): the budget came from
 * `route.max_additional_tl_calls` (`server.ts`) and the handle set from
 * `surfaces[].remaining_ranges`. Both inputs are §3.4 E4 deletions, so keeping
 * either would leave the fence reading a field the wire no longer carries —
 * i.e. it would restore the 2026-08-13 "pack advertises / fence refuses"
 * contradiction under new field names, which is the outcome §3.4.1 names as
 * the failure mode.
 *
 * AFTER: one input. If a v1 pack emits `evidence[i].remaining`, a same-handle
 * window-shaped zoom against `evidence[i].handle` is servable. If it emits
 * nothing, nothing is sanctioned. There is no third input, so this function
 * takes no second argument — the type is the rule.
 *
 * The budget is the COUNT of advertising entries rather than a number the pack
 * carries: an advertisement is a promise, so N advertised handles are N
 * promises and the response owes exactly that many. Capped at 4 (§3.4.1: "the
 * same cap 4 the current implementation applies").
 */
export function sanctionFromEvidence(evidence: readonly Evidence[]): SanctionedZoom | undefined {
  const handles: string[] = [];
  for (const entry of evidence) {
    if (entry.remaining === undefined || entry.remaining.length === 0) continue;
    if (entry.handle === "" || handles.includes(entry.handle)) continue;
    handles.push(entry.handle);
  }
  if (handles.length === 0) return undefined;
  return { handles, budget: Math.min(handles.length, SANCTIONED_ZOOM_CAP) };
}

// ---------------------------------------------------------------------------
// A.2.3 `TaskRef`
// ---------------------------------------------------------------------------

const COVERAGE_REASONS: ReadonlySet<string> = new Set<CoverageReason>([
  "single-site", "candidate-list", "missing-roles", "concerns-uncovered", "diff-truncated",
]);

/**
 * A.2.3: identity and replay token are TWO things because their invalidation
 * rules are opposite. `id` is the certificate's own `task_fingerprint` (stable
 * across re-packs of the same task); `replay` is the session-lived `qref`.
 */
export function projectTaskRef(
  result: Record<string, unknown>,
  contract: TaskExecutionContract | undefined,
  fallbackId: string,
): TaskRef {
  const fingerprint = contract?.readiness_certificate?.task_fingerprint;
  const coverage = result["coverage"];
  const reason = result["coverage_reason"];
  const resolved: TaskRef["coverage"] =
    coverage === "complete" || coverage === "focused" || coverage === "partial"
      ? coverage
      : "partial";
  return {
    id: typeof fingerprint === "string" && fingerprint !== "" ? fingerprint : fallbackId,
    ...(typeof result["qref"] === "string" && result["qref"] !== ""
      ? { replay: result["qref"] }
      : {}),
    coverage: resolved,
    // A.8.2: emitted iff `coverage !== "complete"`.
    ...(resolved !== "complete" && typeof reason === "string" && COVERAGE_REASONS.has(reason)
      ? { coverage_reason: reason as CoverageReason }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// A.2.2 / A.2.4 `WorkspaceMarker` and `CertificateRef`
// ---------------------------------------------------------------------------

/** D12: `TaskWorkspaceState.version` is a TS literal and never reaches the wire. */
function projectWorkspaceMarker(value: unknown): WorkspaceMarker | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const scope = record["scope"];
  if (typeof record["fingerprint"] !== "string") return undefined;
  if (scope !== "served-evidence" && scope !== "evidence-plus-inventory") return undefined;
  return {
    fingerprint: record["fingerprint"],
    scope,
    evidence_files: Number(record["evidence_files"] ?? 0),
    inventory_files: Number(record["inventory_files"] ?? 0),
    inventory_complete: record["inventory_complete"] === true,
  };
}

/**
 * A.2.4: the certificate-binding workspace fingerprint lives on
 * `CertificateRef.workspace` and nowhere else. `obligations` is non-empty BY
 * TYPE because §2.1.1's floor is stated per obligation — a certificate that
 * names none cannot carry a floor, so it cannot authorise an `act`.
 */
function projectCertificate(
  contract: TaskExecutionContract,
  result: Record<string, unknown>,
): CertificateRef | undefined {
  const literalAbsenceSubject = decisionGradeLiteralAbsenceSubject(
    result as unknown as Pick<import("../features/task-pack/model.js").TaskPackResult, "coverage" | "literal_source_absence">,
    contract,
  );
  const boundId = contract.readiness_certificate?.id ?? contract.typestate.certificate_id;
  const id = boundId ?? (literalAbsenceSubject === undefined
    ? undefined
    : `ready-literal-absence:${contract.semantic_closure?.closure_id ?? literalAbsenceSubject}`);
  if (typeof id !== "string" || id === "") return undefined;
  if (contract.readiness_certificate?.id !== undefined
    && contract.typestate.certificate_id !== undefined
    && contract.readiness_certificate.id !== contract.typestate.certificate_id) return undefined;
  const certificateObligations = (contract.readiness_certificate?.obligations ?? [])
    .map((obligation) => obligation.id)
    .filter((value): value is string => typeof value === "string" && value !== "");
  const absenceObligations = literalAbsenceSubject === undefined
    ? []
    : (contract.evidence_model?.claims ?? [])
        .filter((claim) => claim.status === "supported")
        .map((claim) => claim.id)
        .filter((value): value is string => typeof value === "string" && value !== "");
  const obligations = certificateObligations.length > 0 ? certificateObligations : absenceObligations;
  if (obligations.length === 0) return undefined;
  // A.2.4: the marker is the state the certificate was PROVED against, so the
  // contract's own copy is the authority. The pack's top-level `workspace_state`
  // is the same struct at an undeclared address (the census's positional-drift
  // finding) and is the fallback for a compact re-serve that carries it there.
  const workspace = projectWorkspaceMarker(contract.workspace_state)
    ?? projectWorkspaceMarker(result["workspace_state"]);
  if (workspace === undefined) return undefined;
  const missingExplicitGaps = Array.isArray(result["missing"])
    ? result["missing"].filter((entry): entry is string => typeof entry === "string" && entry.startsWith("explicit-gap:"))
    : [];
  // DESIGN-v0.15 R1 §4.2 (2026-09-08, P1-2 residual): a verified-absent
  // request item (`TaskPackResult.request_item_absences`) must stay
  // disclosed even when this pack's own decision certifies (act.answer/
  // act.edit) rather than discover — `buildCapabilityGaps`'s
  // `request-item-absent` gap only ever reaches `decision.gaps`, and D-4
  // keeps `gaps` a discover-only wire member. Synthesized HERE, at
  // projection time, rather than by writing into `result.missing` upstream:
  // `result.missing` is a widely load-bearing internal field
  // (readCodeTaskPack.ts gates fast_path/coverage/several other
  // computations on `result.missing.length === 0`, not all of them
  // `explicit-gap:`-aware), so adding to it demoted the single-site-
  // unique-match fast path for any pack that also happened to name a
  // verified-absent point (measured: a plain "Replace X in flags.ts" edit
  // query lost its fast path once the query's own imperative verb was —
  // correctly, by the SAME literal-scan proof — found absent from workspace
  // content). Reading `request_item_absences` directly here is
  // side-effect-free: it is consumed by no other gate in the file.
  // Review finding 2(c) fix (2026-09-08): the string synthesized below used
  // to claim "scope complete" UNCONDITIONALLY — false whenever the scan that
  // certified this absence excluded any path (the reviewer's own
  // counter-example: `Redis` inside `src/notes.adoc`, outside the
  // un-widened scan's extension set — see `findText.ts`'s
  // `widenFindUniverseForAbsence` and `readCodeTaskPack.ts`'s
  // `RequestItemProof.absentScopeComplete`). `entry.scope_complete` (carried
  // on every `TaskPackResult.request_item_absences` entry) is now the SOLE
  // source of truth for which qualifier applies; the false-claiming branch
  // is gone. Mirrors `tl_search_files`' own `absence.caveat` phrasing ("N paths
  // were excluded from the scan") so both surfaces read the same way.
  const requestItemAbsenceGaps = Array.isArray(result["request_item_absences"])
    ? result["request_item_absences"]
        .map((entry) => entry as Record<string, unknown> | null)
        .filter((entry): entry is Record<string, unknown> =>
          entry !== null && typeof entry["term"] === "string" && entry["term"] !== "")
        .map((entry) => {
          const term = entry["term"] as string;
          // R-D2 (2026-09-21, item B): a could-not-determine verdict is NOT a
          // verified absence — checked FIRST, before the scope_complete/
          // incidental wording below (which does not apply to it: a
          // could-not-determine verdict makes no scope claim at all). See
          // `TaskPackResult.request_item_absences`'s own doc comment.
          if (entry["undetermined"] === true) {
            const reason = typeof entry["undetermined_reason"] === "string" && entry["undetermined_reason"] !== ""
              ? entry["undetermined_reason"]
              : "no confirmed normalisation available";
            return `explicit-gap:request-item-undetermined:${term} (${reason})`;
          }
          // FIX-G (2026-09-27): a request FACET covered by a verified-empty
          // fact (0 call sites in the scanned scope; no module constant or
          // literal behind a value) — neither an absence nor undetermined, so
          // it never takes the scope/incidental wording below. See
          // `TaskPackResult.request_item_absences`'s own doc comment.
          if (entry["empty"] === true) {
            const reason = typeof entry["empty_reason"] === "string" && entry["empty_reason"] !== ""
              ? entry["empty_reason"]
              : "verified empty in the scanned workspace";
            return `explicit-gap:request-item-empty:${term} (${reason})`;
          }
          const scopeComplete = entry["scope_complete"] === true;
          const omittedCount = typeof entry["omitted_count"] === "number" ? entry["omitted_count"] : 0;
          const qualifier = scopeComplete
            ? "; scope complete"
            : `; ${omittedCount} ${omittedCount === 1 ? "path" : "paths"} excluded from the scan`;
          // R-B3 (2026-09-21, ruling 5): a served-but-only-mentioned-in-passing
          // absence (`incidental`) — the term DOES occur — is worded with the
          // policy's own phrase for it, never "no occurrence".
          if (entry["incidental"] === true) {
            return `explicit-gap:request-item-absent:${term} (only an incidental mention in served workspace files${qualifier})`;
          }
          return `explicit-gap:request-item-absent:${term} (no occurrence in scanned workspace files${qualifier})`;
        })
    : [];
  const explicitGaps = [...missingExplicitGaps, ...requestItemAbsenceGaps].slice(0, 8);
  return {
    id,
    obligations: [obligations[0]!, ...obligations.slice(1)],
    ...(explicitGaps.length > 0 ? { gaps: [explicitGaps[0]!, ...explicitGaps.slice(1)] } : {}),
    workspace,
  };
}

// ---------------------------------------------------------------------------
// A.2.6 `FrontierEntry`
// ---------------------------------------------------------------------------

/**
 * The certificate's `action_frontier` is a handle list; A.2.6 requires
 * handle + path + writable, so the paths are joined from the pack's own
 * `frontier_index`/surfaces rather than re-derived. An entry whose path cannot
 * be named is DROPPED, not defaulted: a frontier entry a client cannot address
 * is not a bounded effect area, and §2.1.1 makes an empty frontier degrade the
 * decision rather than ship an unusable one.
 */
function projectFrontier(
  contract: TaskExecutionContract,
  evidence: readonly Evidence[],
  result: Record<string, unknown>,
): FrontierEntry[] {
  const handles = contract.readiness_certificate?.action_frontier ?? [];
  const paths = new Map<string, string>();
  for (const entry of evidence) {
    if (entry.path !== undefined) paths.set(entry.handle, entry.path);
  }
  const index = result["frontier_index"];
  if (Array.isArray(index)) {
    for (const item of index) {
      if (item === null || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      if (typeof record["handle"] === "string" && typeof record["path"] === "string") {
        paths.set(record["handle"], record["path"]);
      }
    }
  }
  const frontier: FrontierEntry[] = [];
  // C24 (chip wave, 2026-09-14): two DIFFERENT handles can both resolve to the
  // SAME path (e.g. one handle from `evidence[]`, another from
  // `frontier_index`, for the same file) — dedupe by path so the wire never
  // lists one file twice under two handles. The FIRST handle in
  // `action_frontier` order that resolves to a given path wins; a later
  // handle for that same path is dropped, not merged, since the caller
  // already has an addressable frontier entry for that file.
  const seenPaths = new Set<string>();
  for (const handle of handles) {
    const path = paths.get(handle);
    if (path === undefined) continue;
    if (seenPaths.has(path)) continue;
    seenPaths.add(path);
    // §2.1.1: an edit frontier is the bounded effect area, so every entry is a
    // write target by construction. `writable` is the type's readback of that,
    // not a filesystem probe.
    frontier.push({ handle, path, writable: true });
  }
  return frontier;
}

/**
 * The pack's proved create target, projected onto the decision ([R5-23],
 * ruling 6, 2026-08-14).
 *
 * WHY THIS FUNCTION IS A VALIDATOR AND NOT A COPY. The field arrives from an
 * untyped `TaskPackResult` record, and `create_target` is now HALF OF A FLOOR:
 * an `act.edit` with no frontier is legal exactly when this is present. A
 * malformed or path-less object promoted verbatim would satisfy the floor while
 * naming no place to write, which is the state the floor exists to forbid — so
 * a target that cannot state its own `path` is DROPPED, on the same rule
 * `projectFrontier` applies one function above ("an entry whose path cannot be
 * named is DROPPED, not defaulted").
 *
 * `directory_evidence` is normalised to a string array rather than required to
 * be non-empty: the producers all prove >=1 sibling before emitting, and a
 * floor that also policed the evidence list would be re-deciding upstream's
 * proof from downstream of it.
 */
function projectCreateTarget(result: Record<string, unknown>): CreateTarget | undefined {
  const value = result["create_target"];
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const path = record["path"];
  if (typeof path !== "string" || path === "") return undefined;
  const evidence = Array.isArray(record["directory_evidence"])
    ? record["directory_evidence"].filter((entry): entry is string => typeof entry === "string" && entry !== "")
    : [];
  return { path, directory_evidence: evidence };
}

// ---------------------------------------------------------------------------
// A.2.7 `CapabilityGap`
// ---------------------------------------------------------------------------

/**
 * `TaskCapabilityGap.kind` -> `CapabilityGap.code`, A.9.2 rows 15 + 24.
 *
 * OB-GAP IS DISCHARGED (C2-7b): both types are now the SAME six values (five,
 * plus DESIGN-v0.15 R1's additive `request-item-absent` — see
 * `CapabilityGap["code"]`'s own doc comment), so this set is a total map, not
 * a narrowing. `invalid-request` and
 * `unsupported-operation` were MINTED into the v1 union — their emitters in
 * `buildCapabilityGaps` (`features/task-pack/readCodeTaskPack.ts`) are live, so
 * dropping them silently would have been information loss, and coercing them
 * into `missing-evidence` would assert "the server looked and it is not there"
 * about a request that was simply invalid: the exact class §4.4 exists to keep
 * apart. `permission-required` and `external-execution-required` were DELETED
 * from the producer type (emitter-zero AND reader-zero).
 *
 * The filter below is retained as a fail-closed floor, not as a narrowing: a
 * future producer value that this file has not been taught still declines to
 * ride the wire under a code that would misdescribe it.
 */
const GAP_CODES: ReadonlySet<string> = new Set<CapabilityGap["code"]>([
  "missing-evidence", "ambiguous-target", "invalid-request",
  "unsupported-operation", "workspace-changed",
  // DESIGN-v0.15 R1 (2026-09-07): an explicit request item this pack closed
  // by verified absence — `features/task-pack/readCodeTaskPack.ts`'s
  // `buildCapabilityGaps`, fed by `TaskPackResult.request_item_absences`.
  "request-item-absent",
  // R2-T2 (2026-09-30, review-0929, orchestrator ruling): a request item the
  // pack could not settle either way — the undetermined entries of the same
  // `request_item_absences` array; a disclosure, never blocking.
  "request-item-undetermined",
]);

/**
 * A.2.7: gaps live on `decision.gaps` and nowhere else.
 *
 * NO CAP. `util/leanExecutionContract.ts`'s `MAX_LEAN_CAPABILITY_GAPS = 2`
 * silently dropped a third gap, and it also dropped any gap that carried no
 * `next_call`. Both rules existed because the pre-v1 gap carried prose
 * (`reason`, capped at 120 chars) and an executable call, so a gap was
 * expensive and had to earn its bytes. v1's `CapabilityGap` is `code` + `refs`
 * — no prose, no call, because §4.4 is explicit that none of the three is
 * fixed by asking for more bytes. The byte argument for the cap is gone, and a
 * silently dropped gap is an undisclosed omission, which A.8 rule E-1 does not
 * permit. So: every gap whose code is representable is emitted.
 */
function projectGaps(contract: TaskExecutionContract): CapabilityGap[] {
  const gaps: CapabilityGap[] = [];
  for (const gap of contract.capability_gaps ?? []) {
    if (!GAP_CODES.has(gap.kind)) continue;
    const refs = [...new Set([
      ...(gap.obligation_ids ?? []).filter((value) => typeof value === "string" && value !== ""),
    ])];
    gaps.push({
      code: gap.kind as CapabilityGap["code"],
      ...(refs.length > 0 ? { refs } : {}),
    });
  }
  return gaps;
}

// ---------------------------------------------------------------------------
// A.3 `TaskDecision`
// ---------------------------------------------------------------------------

/** §2.1.2 (F5): the calls executable NOW. Unexecutable candidates are dropped. */
function discoverNext(
  contract: TaskExecutionContract | undefined,
  result: Record<string, unknown>,
): ToolCall | undefined {
  const fromContract = emittableToolCall(contract?.next_call);
  if (fromContract !== undefined) return fromContract;
  const continuation = result["continuation"];
  if (continuation !== null && typeof continuation === "object") {
    const stages = (continuation as { stages?: unknown }).stages;
    if (Array.isArray(stages)) {
      for (const stage of stages) {
        const calls = (stage as { calls?: unknown } | null)?.calls;
        if (!Array.isArray(calls)) continue;
        for (const call of calls) {
          const emittable = emittableToolCall(call);
          if (emittable !== undefined) return emittable;
        }
      }
    }
  }
  return undefined;
}

/**
 * The smallest executable call that widens a window THIS response already
 * served — §2.1.2's "executable NOW against the state the client holds".
 *
 * Built from `evidence[].remaining`, which is the one field that says, per
 * handle, what of it the client does NOT have. It is therefore the concrete
 * form of the branch-3 prose's own instruction — *"widening a window via its
 * handle first if the target lies outside what was served"* — turned into a
 * call the caller can run instead of a sentence it has to interpret.
 *
 * Returns `undefined` when every served handle is complete at the windows
 * requested: there is then nothing to zoom, and a `discover` naming a call that
 * fetches nothing new would be a round trip charged for no bytes.
 */
/**
 * SHOULD-FIX 59 (AB1, 2026-09-14, review round 11) — `remaining` IS PER-HANDLE,
 * "ALREADY SERVED" IS PER-PATH.
 *
 * `Evidence.remaining` is documented as "unserved windows of THIS handle", and
 * that is exactly what it is — but a pack routinely serves ONE path through TWO
 * surfaces (a narrow symbol window and a wider file window), so a window this
 * response DID serve on one handle is still listed as `remaining` on the other.
 * Zooming into it prescribes a call whose only possible answer is
 * `read.receipt {receipt:"code-unchanged"}` with NO `next` — the dead end
 * measured at `What does MAX_RETRIES do in src/retry.ts? Update the changelog.`
 * (round 11): `next: tl_read_file targets:[{handle:<1-1 surface>, range:"2-2"}]`,
 * answered `served_by:"task_pack 1-2 (call #1)"`.
 *
 * So the candidate window is checked against what THIS RESPONSE actually put in
 * the caller's hands, per path: any entry carrying a `body` (served here) or a
 * `prior` (served earlier in this session, so the caller already holds it).
 * Falls through to the next candidate window, and to `undefined` when every
 * window is already held — which is the honest input to the `await_input` arms
 * below, all of which name what is unresolved.
 */
function servedEvidenceZoom(evidence: readonly Evidence[]): ToolCall | undefined {
  const parseSpan = (value: string | undefined): [number, number] | undefined => {
    const match = /^(\d+)-(\d+)$/.exec(value ?? "");
    if (match === null) return undefined;
    const start = Number(match[1]);
    const end = Number(match[2]);
    return Number.isInteger(start) && Number.isInteger(end) && start >= 1 && end >= start ? [start, end] : undefined;
  };
  const held = new Map<string, Array<[number, number]>>();
  for (const entry of evidence) {
    if (entry.path === undefined) continue;
    if (entry.body === undefined && entry.prior === undefined) continue;
    const span = parseSpan(entry.range);
    if (span === undefined) continue;
    const list = held.get(entry.path) ?? [];
    list.push(span);
    held.set(entry.path, list);
  }
  const alreadyHeld = (path: string | undefined, span: [number, number]): boolean => {
    if (path === undefined) return false;
    return (held.get(path) ?? []).some(([start, end]) => start <= span[0] && end >= span[1]);
  };
  for (const entry of evidence) {
    for (const range of entry.remaining ?? []) {
      if (typeof range !== "string" || range === "") continue;
      const span = parseSpan(range);
      if (span !== undefined && alreadyHeld(entry.path, span)) continue;
      return { tool: "tl_read_file", arguments: { handle: entry.handle, range } };
    }
  }
  return undefined;
}

/**
 * W9 (2026-08-22): the call a capability gap NAMED as its own recovery.
 *
 * Ordered strictly between the contract's own `next_call` and
 * `servedEvidenceZoom`, and that order is the whole point:
 *
 *   - BELOW the contract call, because a contract that can name a call has
 *     already decided what discovery owes; a gap never overrides it. (In
 *     practice the `missing-evidence` gap's call IS the contract's, so
 *     `discoverNext` returns it first and this helper is never consulted.)
 *   - ABOVE `servedEvidenceZoom`, because the zoom widens a window of a file
 *     THIS RESPONSE ALREADY SERVED, and an `ambiguous-target` gap over an
 *     uncovered explicit identifier is precisely the claim that the identifier
 *     is not in any served body. Zooming cannot close that gap; the batched
 *     find the gap names can. Observed live 2026-08-22 (a4 m365-drive-mount):
 *     a multi-file "how does a mount request flow …" pack answered its own gap
 *     with a 519-byte `using` header.
 *
 * Only gaps that carry a call are considered, so every gap shape that has
 * never carried one behaves exactly as before.
 */
function gapNamedNext(contract: TaskExecutionContract | undefined): ToolCall | undefined {
  for (const gap of contract?.capability_gaps ?? []) {
    const call = emittableToolCall(gap.next_call);
    if (call !== undefined) return call;
  }
  return undefined;
}

/**
 * A.2.5: the choices an `await_input` decision is asking the caller between.
 *
 * THE GATE IS THE EMITTED CODE, NOT A RE-DERIVED STRUCTURAL CONDITION
 * (2026-08-20). Until this change the only gate was
 * `coverage_reason === "candidate-list"` — a STRICT SUBSET of the condition
 * under which `readCodeTaskPack.ts` actually declares a candidate choice
 * pending:
 *
 *   candidateChoicePending = !accepted
 *     && (route.action === "confirm_candidates" || coverage_reason === "candidate-list")
 *     && contractSurfaces.length > 1 && contractSurfaces.every(hasServedCode)
 *     && artifactFallback === undefined;                (readCodeTaskPack.ts:14526)
 *
 * The `route.action === "confirm_candidates"` arm had NO counterpart here, so
 * a multi-concern pack that took that arm — `coverage_reason:"concerns-uncovered"`,
 * `route.action:"confirm_candidates"`, every surface content-bearing — emitted
 * `decision:{kind:"await_input",code:"choose-candidate"}` with the candidate
 * set silently dropped. The contract's own `reason` on that same response
 * ENUMERATES the choice ("every candidate body is served inline (handles
 * ha8isxcbz0m,…); pick the surface matching the task"), so the set was never
 * absent — only unprojected. The guide's canon for the kind is "use served
 * `candidates` bodies when safe, else ask", which an empty set turns into a
 * dead end for an autonomous caller.
 *
 * Gating on `awaitCode` rather than re-deriving `route.action` here is
 * deliberate and is the lesson `canonicalDecision.ts` already records about
 * F-A1-1: "a structural approximation drifting from the real projector is how
 * F-A1-1 happened in the first place". `awaitCode` IS the branch's own verdict,
 * so there is one condition, not two that must be kept agreeing. The historical
 * `candidate-list` arm is retained rather than replaced: it is what pins every
 * already-recorded candidate-list body byte-identical, and on those packs the
 * two conditions coincide anyway.
 *
 * Bodies are NOT duplicated onto the rows. `Candidate.handle` is documented as
 * the "join key into this response's `evidence[]`", and the bodies are already
 * there; re-inlining them would double the serve for zero new information.
 */
function projectCandidates(
  result: Record<string, unknown>,
  evidence: readonly Evidence[],
  awaitCode: AwaitInputCode,
): Candidate[] {
  // D9 (FX-R3c, ruling (cc)): the AMBIGUOUS-BASENAME choice. FX-R3b already
  // put the same-basename matches on the concern (`SfStructuralConcern
  // .candidates`) when a caller-typed filename resolved to several files and
  // no co-mentioned family token disambiguated it; §10.0's arbiter now
  // surfaces them, and D8's frontier join makes each one an addressable row of
  // THIS response — so an `await_input` that would otherwise carry neither
  // `next` nor `candidates` can name the choice it is actually asking about.
  // Ordered strictly BELOW the historical gate, so every pack that already
  // produced candidates produces byte-identical ones.
  if (result["coverage_reason"] !== "candidate-list" && awaitCode !== "choose-candidate") {
    const named = sfAwaitInputCandidatePathsFor(result);
    if (named.length === 0) return [];
    const rowFor = new Map<string, Evidence>();
    for (const entry of evidence) {
      if (entry.path !== undefined && !rowFor.has(entry.path)) rowFor.set(entry.path, entry);
    }
    const chosen: Candidate[] = [];
    for (const path of named) {
      const row = rowFor.get(path);
      // Only a row THIS response actually carries can be chosen between: a
      // path with no handle is not an address the caller can act on.
      if (row === undefined) continue;
      chosen.push({
        path,
        handle: row.handle,
        ...(row.role !== undefined ? { kind: row.role } : {}),
      });
    }
    return chosen;
  }
  // v0.15.1 runtime review TL-REVIEW-3 (2026-10-06): a window the pack
  // serves as SUPPORT for its target — a closure constant, a falsification
  // counterexample — is evidence for the answer, never an alternative the
  // question could mean. Listing each served row made 「http.ts の retry 関数
  // について…」 ask the caller to choose between http.ts and the settings.ts
  // constants retry reads. One row per path: two windows of one file are
  // one target.
  const supporting = supportingEvidenceHandles(result);
  const candidates: Candidate[] = [];
  const seenPaths = new Set<string>();
  for (const entry of evidence) {
    if (entry.path === undefined || supporting.has(entry.handle) || seenPaths.has(entry.path)) continue;
    seenPaths.add(entry.path);
    candidates.push({
      path: entry.path,
      handle: entry.handle,
      ...(entry.role !== undefined ? { kind: entry.role } : {}),
    });
  }
  return candidates;
}

/** Handles of `result`'s supporting surfaces — see `isSupportingEvidenceWhy`. */
function supportingEvidenceHandles(result: Record<string, unknown>): Set<string> {
  const handles = new Set<string>();
  const surfaces = result["surfaces"];
  if (!Array.isArray(surfaces)) return handles;
  for (const surface of surfaces) {
    if (surface === null || typeof surface !== "object") continue;
    const record = surface as Record<string, unknown>;
    if (typeof record["handle"] !== "string") continue;
    if (isSupportingEvidenceWhy(typeof record["why"] === "string" ? record["why"] : undefined)) handles.add(record["handle"]);
  }
  return handles;
}

// ---------------------------------------------------------------------------
// A.2.5.1 `UnresolvedItem` — WHAT the `await_input` is waiting on
// ---------------------------------------------------------------------------

/**
 * Same bound as `SANCTIONED_ZOOM_CAP`, for the same reason: a residual list a
 * caller cannot read in one glance is not a question, it is a dump. Four rows
 * is what §3.4.1 already fixed as the per-response affordance budget, and the
 * ORDER below is a precedence, so the four that survive are the four the pack
 * itself ranks highest.
 */
const MAX_UNRESOLVED = 4;

/**
 * Finding 9 (adversarial review 2, 2026-09-08): `MAX_UNRESOLVED` bounds the
 * ROW count, not bytes — a producer's `reason` (the archive producer's own
 * row is already ~180 characters; a future gap/claim producer's prose is
 * unbounded) is not itself length-limited. Same idiom as every other prose
 * cap in this codebase (`slice(0, N - 1) + "…"`); applied once, centrally, in
 * `push()` below so no row from any of the five sources can bypass it.
 */
const UNRESOLVED_REASON_MAX_CHARS = 160;

/**
 * The one `result.missing` prefix this projector still classifies itself: a
 * change-contract diff residual, unrelated to the ledger-projection wire
 * vocabulary that `canonicalDecision.ts`'s `parseLedgerMissingRow` owns
 * exclusively (see `ledgerProjectionArchitecture.spec.ts` -- the vocabulary's
 * literal prefixes are deliberately not spelled out again here, so this file
 * never re-acquires a reference to them).
 */
const CHANGE_CONTRACT_MISSING_PREFIX = "change-contract:";

function recordAt(value: unknown): Record<string, unknown> | undefined {
  return value === null || typeof value !== "object" || Array.isArray(value)
    ? undefined
    : value as Record<string, unknown>;
}

function nonEmptyStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry !== "")
    : [];
}

/**
 * THE ONE LIVE CASE WHERE `await_input` CAN NAME THE CALL THAT UNBLOCKS IT
 * (reviewer note 5, 2026-09-08).
 *
 * `tl_read_file {query:"Create src/answer.ts with …", task:{epoch:"new",
 * profile:"answer"}}` resolves a `create_target` — the path is explicit and its
 * parent directory is proved — and then cannot act on it, because the CALLER
 * declared a read-only profile and DESIGN-v0.15 §3 makes that declaration
 * authoritative in both directions (mutation wording never flips `selected`).
 * Both halves are right; the dead end is that the response said neither.
 *
 * The predicate is deliberately narrow — `source:"explicit"` AND
 * `requested === "answer"` AND a resolved create target — so it names a
 * CONFLICT BETWEEN TWO CALLER-SUPPLIED FACTS (the profile and the query), never
 * a server inference the caller cannot see. An inferred "answer" is not this
 * case: there the fix is the server's classification, not the caller's call.
 */
function declaredProfileCreateConflict(
  result: Record<string, unknown>,
): { path: string } | undefined {
  const binding = recordAt(result["profile_binding"]);
  if (binding === undefined) return undefined;
  if (binding["source"] !== "explicit") return undefined;
  if (binding["requested"] !== "answer" || binding["selected"] !== "answer") return undefined;
  const target = projectCreateTarget(result);
  return target === undefined ? undefined : { path: target.path };
}

/**
 * The conflict's own continuation: THE SAME QUESTION, under the profile it
 * needs. Not a widening and not a re-discovery — `qref` replays this exact
 * pack's query, so the only thing that changes is the one declaration that
 * blocked it, and the caller sees which one.
 *
 * `{qref, task:{profile}}` is a SANCTIONED request shape: it matches exactly
 * the advertised `oneOf` qref branch (`server.ts`: required `qref`, excluding
 * query/targets/cursor — `task` is deliberately NOT excluded there, which is
 * what `{qref, task:{epoch:"new"}}` already relies on), and `task.profile` is
 * an advertised property of `CANONICAL_TASK`. `cwd`/`lane` are attributed by
 * `canonicalizeEmittedToolCalls` at the envelope, exactly as for every other
 * minted call, so they are not spelled here.
 *
 * No qref (a pack the session cannot replay) means no grounded call, and the
 * `unresolved` row travels alone — which is the honest shape, not a degraded
 * one: the row already tells the caller which declaration to change.
 */
function declaredProfileConflictNext(result: Record<string, unknown>): ToolCall | undefined {
  const qref = result["qref"];
  if (typeof qref !== "string" || qref === "") return undefined;
  return { tool: "tl_read_file", arguments: { qref, task: { profile: "generic" } } };
}

/**
 * Finding 8 (adversarial review 2, 2026-09-08): `declaredProfileCreateConflict`
 * reads only `result` — it has no notion of WHICH `await_input` code is being
 * assembled — so it could fire on any of the five, including the three whose
 * own question is something else entirely: `choose-candidate` /
 * `name-intended-target` (pick one of `candidates`) and
 * `resolve-evidence-conflict` (say which surface is authoritative). A `next`
 * riding alongside `candidates` is not UNSOUND (it is still grounded and
 * consumes nothing), but the documented client rule — "run a carried `next`
 * first; else pick a candidate" — would then silently skip the pick-one
 * question the response also asked. This narrows the conflict to the two
 * codes where it is genuinely the terminal's own question: the create-route
 * terminal itself (`no-grounded-call-remains`, the reviewer's baseline
 * repro) and the certified-but-still-open shape the note-6 repro measured
 * (`act-on-served-evidence`). Used by BOTH `projectUnresolved`'s row 0 and
 * `awaitInput`'s own `next` computation, so the two can never disagree about
 * whether a grounded call exists — the doc comment on `awaitInput` promises
 * exactly that.
 */
function profileConflictAppliesTo(code: AwaitInputCode): boolean {
  return code === "no-grounded-call-remains" || code === "act-on-served-evidence";
}

/**
 * Finding 4 (adversarial review 2, 2026-09-08): a `TaskCapabilityGap.reason`
 * is authored as GUIDANCE for what the caller should do next (e.g. "read the
 * contract's needs-context handles once, then batch the edits"), not as a
 * residual statement of what is unresolved. Shipping it verbatim under
 * `gap.kind` in `unresolved[]` falsifies both halves of the field: `kind`
 * ("what class of thing is open") no longer matches prose that describes an
 * action, and `reason` ("non-empty prose naming the specific residual") names
 * an instruction instead. This builds a declarative sentence from the gap's
 * own CLOSED seven-member kind vocabulary (`TaskCapabilityGap["kind"]`) and its
 * `obligation_ids` instead — never from `gap.reason`.
 */
function projectedCapabilityGapReason(gap: TaskCapabilityGap, ambiguousTargetCandidateCount?: number): string {
  const ids = (gap.obligation_ids ?? []).filter((entry): entry is string => typeof entry === "string" && entry !== "");
  const idList = ids.length > 0 ? ids.join(", ") : undefined;
  switch (gap.kind) {
    case "ambiguous-target":
      if (idList !== undefined) {
        return `target ambiguous across ${ids.length} candidate obligation(s): ${idList}`;
      }
      // Finding 20 (adversarial review, 2026-09-27): this fallback used to say
      // "multiple candidates" unconditionally, including when this SAME
      // response names exactly one in `candidates[]` — a caller then read
      // "ambiguous across multiple candidates" beside "1 candidate target(s)
      // match this request" for the identical blocker. `ambiguousTargetCandidateCount`
      // is the caller's own count of THIS response's candidates (row 3 below
      // computes the identical number for its own row), so the two rows can
      // no longer disagree, and a genuinely single-candidate ambiguity is
      // never misreported as "multiple".
      return ambiguousTargetCandidateCount !== undefined && ambiguousTargetCandidateCount > 0
        ? `${ambiguousTargetCandidateCount} candidate target(s) match this request; name the intended one`
        : "the intended target is ambiguous and this response cannot narrow it further";
    case "missing-evidence":
      return idList !== undefined
        ? `required evidence not served: ${idList}`
        : "required evidence for this action is not yet served";
    case "request-item-absent":
      return idList !== undefined
        ? `a requested item could not be located: ${idList}`
        : "a requested item could not be located";
    case "request-item-undetermined":
      return idList !== undefined
        ? `a requested item could not be determined either way: ${idList}`
        : "a requested item could not be determined either way";
    case "workspace-changed":
      return "the workspace changed since this pack was built; the affected surfaces must be re-served";
    case "unsupported-operation":
      return idList !== undefined
        ? `this operation is not supported for: ${idList}`
        : "this operation is not supported for the named target";
    case "invalid-request":
      return "this request could not be validated as issued";
    default: {
      // `TaskCapabilityGap["kind"]` is a closed six-member union — this arm is
      // unreachable under the current type, but stays fail-safe (never the
      // raw `gap.reason`) if the union widens ahead of this switch, matching
      // this file's own `GAP_CODES` fail-closed-floor precedent above.
      const fallbackKind: string = gap.kind;
      return idList !== undefined ? `${fallbackKind}: ${idList}` : `${fallbackKind} obligation is open`;
    }
  }
}

/**
 * A.2.5.1: WHAT this `await_input` could not resolve, drawn only from what THIS
 * RESPONSE already discloses.
 *
 * WHY IT IS A PROJECTION AND NOT A NEW COMPUTATION. Every row below restates a
 * disclosure the pack publishes elsewhere — the contract's evidence model, its
 * capability gaps, `result.missing` / `missing_required_surfaces` /
 * `change_contract.missing` (the same four inputs `readCodeTaskPack.ts`'s
 * `openEpochContractRequirements` reads to decide whether a served terminal may
 * be certified), the candidate set, `checks`, `coverage_reason`. Deriving a
 * residual here that the response does not otherwise state would make the
 * decision an authority on facts nothing else can corroborate, which is the
 * class §2.1 removes. So this function can only ever be WRONG BY OMISSION, and
 * an omission is spelled by omitting the key.
 *
 * PRECEDENCE, most specific first (the cap is applied to the ordered list, so
 * this is what survives a narrow budget):
 *   0. the declared-profile conflict — the only row that also grounds a `next`.
 *   1. the evidence model's own unresolved CLAIMS (id + reason + handle), then
 *      its bare `unresolved[]` strings for a model that carries no claim rows.
 *   2. open readiness obligations: `capability_gaps[]` (with `obligation_ids`),
 *      `missing_required_surfaces[]`, then `result.missing` and, for an
 *      edit-shaped pack, `change_contract.missing[]`. `explicit-gap:` rows are
 *      excluded on `openEpochContractRequirements`'s own reasoning — a verified
 *      absence is a PROOF, not an open requirement.
 *   3. the code's own question, for the codes whose subject is the ambiguity
 *      itself rather than a missing surface.
 *   4. last resort: the pack's uncovered-concern `checks[]`, then its
 *      `coverage_reason`. Both are this response's own words for "not closed".
 *
 * Returns `[]` when it can name nothing; the caller then OMITS the key
 * (FLOOR-AWAIT: an empty array asserts a nameable set and declines to name it).
 */
function projectUnresolved(
  result: Record<string, unknown>,
  contract: TaskExecutionContract,
  awaitCode: AwaitInputCode,
  candidates: readonly Candidate[],
): UnresolvedItem[] {
  const out: UnresolvedItem[] = [];
  const seen = new Set<string>();
  // Finding 4: which `kind` first claimed a given `id` -- a caller correlates
  // obligations BY id, so the same id must never point at two different
  // kinds across this array.
  const idKindOf = new Map<string, string>();
  const push = (item: UnresolvedItem): void => {
    if (out.length >= MAX_UNRESOLVED) return;
    if (item.reason === "") return;
    // Dedupe on the ORIGINAL (untruncated) kind+reason pair, before the
    // finding-9 cap below -- two distinct long reasons that happen to share a
    // truncated prefix must not collapse into one row.
    const key = `${item.kind}\u0000${item.reason}`;
    if (seen.has(key)) return;
    seen.add(key);
    let toPush = item;
    if (item.id !== undefined) {
      const owner = idKindOf.get(item.id);
      if (owner === undefined) {
        idKindOf.set(item.id, item.kind);
      } else if (owner !== item.kind) {
        // A DIFFERENT kind wants to reuse an id already claimed -- strip the
        // id rather than drop the row: the disclosure is still real, only
        // its cross-row identity correlator is not (finding 4).
        const { id: _droppedId, ...rest } = item;
        toPush = rest;
      }
    }
    if (toPush.reason.length > UNRESOLVED_REASON_MAX_CHARS) {
      toPush = { ...toPush, reason: toPush.reason.slice(0, UNRESOLVED_REASON_MAX_CHARS - 1).trimEnd() + "…" };
    }
    out.push(toPush);
  };

  // 0a. FIXALL-A group D (2026-09-14): the request named NOTHING to act on.
  // `await_input` means "`unresolved[]` names the blocker", and for this shape
  // the blocker is not a file that could not be read or a role that was not
  // served — it is that the request itself never stated an object. Sited FIRST,
  // ahead of the profile conflict, because `MAX_UNRESOLVED` is a hard cap and
  // every other row below describes the PACK, which is a true but useless thing
  // to tell a caller whose request was `Increase it to 5.`. See
  // `TaskPackResult.request_names_no_target`.
  if ((result as Record<string, unknown>)["request_names_no_target"] === true) {
    push({
      kind: "ambiguous-target",
      reason: "this request names no file, symbol or identifier to act on — only a verb and a value; name the target so it can be resolved to a surface",
    });
  }

  // 0. The declared-profile conflict (reviewer note 5), narrowed to the two
  // codes where it is genuinely this terminal's own question (finding 8).
  const conflict = profileConflictAppliesTo(awaitCode) ? declaredProfileCreateConflict(result) : undefined;
  if (conflict !== undefined) {
    push({
      kind: "profile-conflict",
      reason: `explicit create of ${conflict.path} needs task.profile generic (declared: answer)`,
      path: conflict.path,
    });
  }

  // 0b. BLOCKER 25 (2026-09-14, review round 4): a file THIS REQUEST NAMED BY
  // PATH that the server resolved but could not read. Sited here, second only
  // to the profile conflict, because `MAX_UNRESOLVED` is a hard cap and this
  // row is the one the caller cannot reconstruct from anything else in the
  // response: without it the named path appears nowhere at all, which is the
  // finding. Read from the pack's own first-class field
  // (`TaskPackResult.unreadable_named_paths`) rather than from the `missing`
  // row the same producer writes, so the row can carry `path` addressing —
  // `parseLedgerMissingRow` returns prose only. The `missing` row remains the
  // epoch-vocabulary spelling `openEpochContractRequirements` reads, and its
  // duplicate is collapsed by `push`'s own kind+reason dedupe below.
  for (const entry of Array.isArray(result["unreadable_named_paths"]) ? result["unreadable_named_paths"] : []) {
    const row = recordAt(entry);
    const namedPath = typeof row?.["path"] === "string" ? row["path"] as string : undefined;
    const reason = typeof row?.["reason"] === "string" ? row["reason"] as string : undefined;
    if (namedPath === undefined || namedPath === "" || reason === undefined) continue;
    // SHOULD-FIX 65 (AC1, 2026-09-14, review round 12): say "this request names
    // X" only when it does. Round 11 measured a query naming ONE file producing
    // THREE rows with this wording, two of them false — the disclosure is now a
    // property of the VERDICT (any candidate path the serve policy will not
    // read), so it reaches paths the request never mentions. `await_input` means
    // "`unresolved[]` names the blocker", and a caller acting on a false row asks
    // the user to re-save files it never mentioned. The producer
    // (`readCodeTaskPack.ts::noteUnreadableNamedPath`) records which it is;
    // absence reads as `"request"`, because a row restored from the pre-round-12
    // `missing[]` spelling could only have come from that case.
    const provenance = row?.["provenance"] === "resolution" ? "resolution" : "request";
    push({
      kind: "unreadable-named-path",
      reason: provenance === "request"
        ? `this request names ${namedPath}, which this response could not serve (${reason})`
        : `a file this task needed (${namedPath}) could not be read/decoded (${reason})`,
      path: namedPath,
    });
  }

  // 1. The evidence model. Its two carriers overlap: `unresolved[]` is a list
  // of CLAIM IDS, so an id whose claim row was just emitted (with that row's
  // reason and handle) must not be restated as a bare, reasonless second row.
  const model = contract.evidence_model;
  const claimedIds = new Set<string>();
  for (const claim of model?.claims ?? []) {
    if (claim.status !== "unresolved") continue;
    claimedIds.add(claim.id);
    const handle = claim.evidence_handles.find((entry) => typeof entry === "string" && entry !== "");
    push({
      kind: claim.kind,
      reason: claim.reason,
      ...(claim.id !== "" ? { id: claim.id } : {}),
      ...(handle !== undefined ? { handle } : {}),
    });
  }
  for (const entry of nonEmptyStrings(model?.unresolved)) {
    if (claimedIds.has(entry)) continue;
    push({ kind: "unresolved-claim", reason: `evidence claim "${entry}" is unresolved`, id: entry });
  }

  // 2. Open readiness obligations.
  //
  // Finding 20: the SAME candidate count row 3 below computes for the
  // "code's own question" row, threaded through so an `ambiguous-target` gap
  // with no `obligation_ids` never asserts a candidate count that disagrees
  // with what this response's own `candidates[]` (or `concern_ambiguities`)
  // says — see `projectedCapabilityGapReason`'s doc comment.
  const ambiguousTargetCandidateCount = candidates.length > 0
    ? candidates.length
    : (Array.isArray(result["concern_ambiguities"]) ? result["concern_ambiguities"].length : 0);
  for (const gap of contract.capability_gaps ?? []) {
    const id = (gap.obligation_ids ?? []).find((entry) => typeof entry === "string" && entry !== "");
    push({
      kind: gap.kind,
      // Finding 4: a projected declarative sentence, never `gap.reason`
      // verbatim -- that prose is guidance, not a residual statement.
      reason: projectedCapabilityGapReason(gap, ambiguousTargetCandidateCount),
      ...(id !== undefined ? { id } : {}),
    });
  }
  const roles = nonEmptyStrings(result["missing_required_surfaces"]);
  for (const role of roles) {
    push({
      kind: "unserved-required-role",
      reason: `required surface role "${role}" is not served by this response`,
    });
  }
  const changeContract = recordAt(result["change_contract"]);
  const missingRows = [
    ...nonEmptyStrings(result["missing"]),
    ...(contract.next_action === "answer" ? [] : nonEmptyStrings(changeContract?.["missing"])),
  ];
  for (const entry of missingRows) {
    const parsed = parseLedgerMissingRow(entry);
    if (parsed !== undefined) {
      // "explicit-gap" rows are a verified absence, not an open requirement
      // (openEpochContractRequirements's own reasoning) — named by the
      // parser, but never pushed as a residual here.
      if (parsed.kind !== "explicit-gap") push(parsed);
      continue;
    }
    if (entry.startsWith(CHANGE_CONTRACT_MISSING_PREFIX)) {
      push({ kind: "change-contract", reason: entry.slice(CHANGE_CONTRACT_MISSING_PREFIX.length) });
      continue;
    }
    // A bare row is the role axis's ordinary spelling (`readFamily.ts` keeps
    // `missing` on a partial pack precisely as the unresolved-obligation
    // disclosure), so it is stated as one rather than as anonymous prose.
    push({
      kind: "unserved-required-role",
      reason: `required surface role "${entry}" is not served by this response`,
    });
  }

  // 3. The code's own question.
  if (awaitCode === "choose-candidate" || awaitCode === "name-intended-target") {
    push({
      kind: "ambiguous-target",
      reason: ambiguousTargetCandidateCount > 0
        ? `${ambiguousTargetCandidateCount} candidate target(s) match this request; name the intended one`
        : "the intended target is ambiguous and this response cannot narrow it further",
    });
  }
  if (awaitCode === "resolve-evidence-conflict") {
    for (const entry of nonEmptyStrings(model?.counterexamples)) {
      push({ kind: "evidence-conflict", reason: entry });
    }
    push({
      kind: "evidence-conflict",
      reason: "served evidence disagrees; say which surface is authoritative",
    });
  }

  // 4. Last resort — the pack's own words for "not closed".
  for (const entry of nonEmptyStrings(result["checks"])) {
    if (!entry.startsWith("concern(s) not covered")) continue;
    push({ kind: "uncovered-concern", reason: entry });
  }
  if (out.length === 0) {
    const coverage = result["coverage"];
    const reason = result["coverage_reason"];
    if (coverage === "partial" || coverage === "focused") {
      // SHOULD-FIX 64 (AC1, 2026-09-14, review round 12): this is the LAST-RESORT
      // arm (`out.length === 0` — the pack could name nothing at all), and round
      // 11 measured it as the terminal for an unambiguous edit request whose
      // whole `unresolved[]` was one row describing the PACK. The pack fact is
      // the honest cause and stays; what is added is the half a caller can act
      // on, because `await_input` means "`unresolved[]` names the blocker" and a
      // row naming only the server's own coverage names no blocker the caller or
      // the user could lift. Nothing here invents a target: it states what the
      // response is missing (a target it could resolve) and what supplying it
      // looks like.
      const pack = typeof reason === "string" && reason !== ""
        ? `pack coverage is "${String(coverage)}" (${reason})`
        : `pack coverage is "${String(coverage)}"`;
      push({
        kind: "incomplete-coverage",
        reason: `${pack}; no served surface closes the remainder — name the file or`
          + ` identifier this request is about, so it can be resolved to a surface`,
      });
    }
  }
  return out;
}

/**
 * The `await_input` member, assembled once so all four emission sites within
 * `projectTaskDecision` agree. (A fifth, documented exception exists outside
 * this projector entirely: `server.ts`'s `overviewRedirectFamilyDecision`
 * builds an inline `{kind:"await_input", code:"no-grounded-call-remains"}`
 * for a producer stub that carries no `TaskExecutionContract` at all — see
 * that function's own doc comment, review-2 finding 7, for why it cannot
 * route through here.)
 *
 * FLOOR-AWAIT is enforced HERE rather than at each call site: `unresolved` is
 * omitted when nothing could be named, and never emitted empty; and the one
 * `next` this kind may carry (D-1 as amended) is minted from the SAME predicate
 * that puts its `profile-conflict` row on `unresolved`, so the two can never
 * disagree about whether a grounded call exists.
 *
 * NO LOOP IS REACHABLE. The conflict predicate requires
 * `profile_binding.requested === "answer"`; the emitted call declares
 * `task.profile:"generic"`, so the re-pack it names cannot satisfy the
 * predicate again.
 */
function awaitInput(
  result: Record<string, unknown>,
  contract: TaskExecutionContract,
  code: AwaitInputCode,
  candidates: readonly Candidate[],
): TaskDecision {
  const unresolved = projectUnresolved(result, contract, code, candidates);
  // Finding 8: gated by the SAME predicate `projectUnresolved`'s own row 0
  // uses, so `next` and the `profile-conflict` row it grounds can never
  // disagree about whether this code is one where the conflict is the
  // terminal's own question.
  const next = profileConflictAppliesTo(code) && declaredProfileCreateConflict(result) !== undefined
    ? declaredProfileConflictNext(result)
    : undefined;
  return {
    kind: "await_input",
    code,
    ...(candidates.length > 0 ? { candidates: [...candidates] } : {}),
    ...(unresolved.length > 0 ? { unresolved } : {}),
    ...(next !== undefined ? { next } : {}),
  };
}

/**
 * §2.1.1's evidence floor for `act.answer`, applied.
 *
 * The floor is "for every obligation the certificate names, usable evidence the
 * client holds: either an `Evidence` entry with a `body`, or an `Evidence`
 * entry whose `prior` names an earlier call in this session". Obligation ids
 * are not join keys onto evidence entries at HEAD, so the check this commit can
 * make honestly is the necessary condition: the response must carry at least
 * one usable entry, and every entry must satisfy A.8's E-8 invariant
 * (`!body` ⟹ `prior` or `remaining`). A per-obligation join is C2-3's, when the
 * read.task_pack body is authored against A.5.1 and the certificate's
 * `evidence_handles` become part of the emitted shape.
 */
export function answerFloorHolds(
  // STRUCTURAL, NOT `readonly Evidence[]`, since C2-2 exported it: the floor
  // reads exactly two fields, and `budget/actFloor.ts` re-asks it of an
  // already-projected body whose entries are untyped records. Widening the
  // parameter to the two fields the predicate actually touches is what lets
  // there be ONE definition of the floor instead of a typed one and a
  // hand-rolled copy — `Evidence[]` still satisfies it, structurally.
  evidence: readonly { readonly body?: string; readonly prior?: string }[],
  certificate?: {
    readonly obligations?: readonly string[];
    readonly workspace?: { readonly inventory_complete?: boolean };
  },
): boolean {
  if (evidence.some((entry) => entry.body !== undefined || entry.prior !== undefined)) return true;
  const obligations = certificate?.obligations;
  return certificate?.workspace?.inventory_complete === true
    && Array.isArray(obligations)
    && obligations.length > 0
    && obligations.some((id) => id.startsWith("literal-source-absent:") && id.length > "literal-source-absent:".length);
}

/**
 * §2.1.1's `act.edit` floor, AS AMENDED BY [R5-23] (ruling 6, 2026-08-14):
 * *"`frontier` non-empty **OR** a create target"*.
 *
 * ONE DEFINITION, THREE CALLERS. `projectTaskDecision` below asks it before it
 * emits; `budget/actFloor.ts` asks it again after every shed rung; and
 * `budget/requiredSets.ts` states the same disjunction as a body predicate so
 * the validator can refuse a breach the projector never produced. They must
 * agree, so there is one function and the other two import it — a second
 * spelling of a floor is how a floor stops being one.
 *
 * WHY A DISJUNCTION IS NOT A WEAKENING. Both arms answer the same question —
 * *where may I write* — for the two kinds of target that exist: `frontier`
 * addresses files that exist (handle + path + writable), `create_target` names
 * the one that does not. An `act.edit` carrying NEITHER still breaches, which
 * is the whole content of the floor.
 */
export function editFloorHolds(
  frontier: readonly FrontierEntry[],
  createTarget: CreateTarget | undefined,
): boolean {
  return frontier.length > 0 || createTarget !== undefined;
}

export interface DecisionProjectionInput {
  result: Record<string, unknown>;
  contract: TaskExecutionContract | undefined;
  /** The canonical runtime verdict; `undefined` when the pack carries no contract. */
  canonicalKind: "discover" | "await-input" | "act-answer" | "act-edit" | "terminal-closed" | undefined;
  evidence: readonly Evidence[];
  /**
   * R1 (2026-08-28): "has this call already been spent on this lane?", bound by
   * the producer exit to `packServeLog`'s `hasExecutedNext` — THE one
   * consumed-fingerprint predicate, not a second one.
   *
   * WHY IT BELONGS HERE. `decision.next` is minted in exactly one place — the
   * chain below — from FOUR independent sources: the discovery bundle (read off
   * `result.qref` + the evidence graph), the contract's own `next_call`, the
   * continuation plan's first call, a gap's named recovery, and the served
   * evidence zoom. The no-repeat gate at the producer exit only ever saw the
   * SECOND of those, because that is the only one it can repair; the others
   * never passed a consumption check at all. Filtering at the mint point is what
   * makes the single predicate govern every carrier without standing up a
   * parallel gate — and it is what lets the exit's repair actually reach the
   * wire, since a bundle next outranks the repaired `next_call`.
   *
   * Omitted (the archive / locate-closure projector, and every test) means
   * "nothing is known to be consumed", which is the pre-R1 behaviour exactly.
   */
  consumed?: (call: ToolCall) => boolean;
}

/** The first candidate this lane has not already spent; see `DecisionProjectionInput.consumed`. */
function firstUnconsumed(
  consumed: ((call: ToolCall) => boolean) | undefined,
  ...candidates: (ToolCall | undefined)[]
): ToolCall | undefined {
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    if (consumed?.(candidate) === true) continue;
    return candidate;
  }
  return undefined;
}

/**
 * A literal source cohort is one indivisible discovery obligation: every
 * exact witness must be served before an edit can be prepared.  Its contract
 * continuation therefore outranks an advisory qref bundle.  The bundle is a
 * useful generic re-pack axis, but it cannot stand in for the omitted exact
 * witness and previously re-opened the same generic pack indefinitely.
 */
function literalCohortContinuation(
  result: Record<string, unknown>,
  contract: TaskExecutionContract | undefined,
): ToolCall | undefined {
  const missing = result["missing"];
  return Array.isArray(missing) && missing.includes("source-cohort-remaining")
    ? discoverNext(contract, result)
    : undefined;
}

/** A continuation before/after the guard, retained only while choosing wire next. */
interface SemanticFrontierNextCandidate {
  readonly raw: ToolCall | undefined;
  readonly guarded: ToolCall | undefined;
  readonly suppressionReason: string;
}

/** Keep a server-authored discovery read inside the task that still owes it. */
export function withDiscoveryReplay(
  result: Record<string, unknown>,
  call: ToolCall | undefined,
): ToolCall | undefined {
  const qref = result["qref"];
  if (typeof qref !== "string" || qref.length === 0 || call?.tool !== "tl_read_file") return call;
  const args = call.arguments;
  if (args["query"] !== undefined || args["qref"] !== undefined || args["cursor"] !== undefined
    || args["mode"] !== undefined || args["taskEpoch"] !== undefined) return call;
  const task = args["task"];
  if (task !== undefined && (task === null || typeof task !== "object" || Array.isArray(task))) return call;
  const control = task as Record<string, ToolCall["arguments"][string]> | undefined;
  if (control?.["epoch"] !== undefined || control?.["pull"] !== undefined
    || control?.["force_serve"] !== undefined) return call;
  const address = (value: unknown): boolean => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const row = value as Record<string, unknown>;
    return typeof row["path"] === "string" && row["path"].length > 0
      || typeof row["handle"] === "string" && row["handle"].length > 0;
  };
  if (!address(args) && !(Array.isArray(args["targets"]) && args["targets"].length > 0
    && args["targets"].every(address))) return call;
  const binding = result["profile_binding"];
  const requested = binding !== null && typeof binding === "object" && !Array.isArray(binding)
    ? (binding as Record<string, unknown>)["requested"] : undefined;
  // A refined generic binding still belongs to the caller's original generic
  // task. Re-inference on the same replay must not mint a different identity.
  const profile = typeof requested === "string" && requested !== "auto" ? requested : result["profile"];
  const taskControl = typeof profile === "string" && profile.length > 0 && control?.["profile"] === undefined
    ? {...control, profile} : control;
  return {...call, arguments: {...args, qref, ...(taskControl !== undefined ? {task: taskControl} : {})}};
}

function sameToolCall(left: ToolCall | undefined, right: ToolCall | undefined): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function firstProgressingIndex(
  candidates: readonly SemanticFrontierNextCandidate[],
  consumed: ((call: ToolCall) => boolean) | undefined,
  key: "raw" | "guarded",
): number | undefined {
  const index = candidates.findIndex((candidate) => {
    const call = candidate[key];
    return call !== undefined && consumed?.(call) !== true;
  });
  return index < 0 ? undefined : index;
}

/**
 * Project the ranked discovery candidates once, and attribute suppression only
 * when it changes the final wire decision.  Helper calls stay pure: a loser,
 * an already consumed candidate, or an advisory probe must never fabricate a
 * commit merely because it noticed an optional carrier.
 */
function projectSemanticFrontierNext(
  result: Record<string, unknown>,
  contract: TaskExecutionContract,
  consumed: ((call: ToolCall) => boolean) | undefined,
): ToolCall | undefined {
  const taskResult = result as unknown as TaskPackResult;
  /**
   * FIXALL-A group D (2026-09-14) — NOTHING TO SEARCH FOR IS NOT A REASON TO
   * SEARCH. The wire ranks its own discovery candidates here rather than taking
   * `deriveCanonicalTaskDecisionRaw`'s, so the same suppression has to be stated
   * at both seats (that function carries the full argument; this is its wire
   * half). `request_names_no_target` says the ENTIRE request was a verb, an
   * optional pronoun and an optional bare value — `Increase it to 5.`,
   * 「それを 5 に削除してください。」 — so every candidate below can only propose a
   * repository-wide find for the verb the caller used to ask for the change.
   * With no `next`, the decision falls through to `await_input`, whose
   * `unresolved[]` names what the caller can supply.
   */
  if (taskResult.request_names_no_target === true) return undefined;
  const guardEnabled = semanticFrontierGuardEnabled();
  const allowed = semanticFrontierNextAllowed({
    surfaces: Array.isArray(result["surfaces"]) ? result["surfaces"] as TaskPackResult["surfaces"] : [],
  }, guardEnabled);
  const replay = (call: ToolCall | undefined): ToolCall | undefined => withDiscoveryReplay(result, call);
  const guarded = (raw: ToolCall | undefined): ToolCall | undefined =>
    replay(!guardEnabled ? raw : allowed ? sanitizeSemanticFrontierNext(taskResult, raw, true) : undefined);
  // The literal cohort read is the exact witness slice itself (see
  // `literalCohortContinuation`): a qref would turn it back into a re-pack of
  // the same generic pack, the loop it exists to break. It is never replayed.
  const rawLiteral = sanitizeSemanticFrontierNext(taskResult, literalCohortContinuation(result, contract), false);
  const rawBundle = replay(discoveryBundleNext(taskResult, false));
  const rawContract = replay(sanitizeSemanticFrontierNext(taskResult, discoverNext(contract, result), false));
  const rawGap = replay(sanitizeSemanticFrontierNext(taskResult, gapNamedNext(contract), false));
  const rawUnserved = replay(sanitizeSemanticFrontierNext(taskResult, unservedAddressableRepack(taskResult), false));
  // D8 (FX-R3c, DC2) NOTE: §10.0 names `selectCanonicalNext` the single arbiter
  // of `decision.next`, but `rawBundle` still outranks `rawContract` here, so
  // on a CANDIDATE-LIST pack the wire keeps offering the discovery bundle even
  // when the arbiter named a caller-named address the bundle omits. FX-R3c
  // deliberately did NOT reorder this list: the ordering is wire-visible for
  // every SF-flagged pack, the sealed SF05 shape is already repaired without it
  // (`rawContract` beats `rawGap` and `servedEvidenceZoom`, which is what that
  // replay fell through to), and a ranking change with no failing case behind
  // it is a lever, not a fix. Left as an open item with the evidence attached.
  const candidates: SemanticFrontierNextCandidate[] = [
    {
      raw: rawLiteral,
      guarded: !guardEnabled ? rawLiteral : allowed ? sanitizeSemanticFrontierNext(taskResult, rawLiteral, true) : undefined,
      suppressionReason: "continuation-target",
    },
    {
      raw: rawBundle,
      guarded: replay(!guardEnabled ? rawBundle : allowed ? discoveryBundleNext(taskResult, true) : undefined),
      suppressionReason: "discovery-bundle",
    },
    { raw: rawContract, guarded: guarded(rawContract), suppressionReason: "continuation-target" },
    { raw: rawGap, guarded: guarded(rawGap), suppressionReason: "continuation-target" },
    // FIXALL-A (2026-09-14), LAST: the rows this pack addressed and did not
    // serve. Ranked below every producer above so it can only replace the
    // ABSENCE of a call — see `unservedAddressableRepack`, which carries the
    // loop-freedom argument round 12's residual R2 was waiting on.
    { raw: rawUnserved, guarded: guarded(rawUnserved), suppressionReason: "continuation-target" },
  ];
  const rawWinner = firstProgressingIndex(candidates, consumed, "raw");
  const guardedWinner = firstProgressingIndex(candidates, consumed, "guarded");
  const noteFinalDecisionEffect = (reason: string): void => {
    noteSemanticFrontierDecisionSuppression(
      reason,
      guardedWinner === undefined ? undefined : candidates[guardedWinner]!.guarded,
    );
  };
  if (guardEnabled && guardedWinner !== undefined) {
    const winner = candidates[guardedWinner]!;
    // (a) The call we actually put on the wire was changed by the guard.
    if (!sameToolCall(winner.raw, winner.guarded)) {
      noteFinalDecisionEffect(winner.suppressionReason);
    }
    // (b) A higher-ranked usable call was removed or turned into one this lane
    // already consumed, so the winner (rather than a mere loser) changed.
    if (rawWinner !== guardedWinner) {
      for (let index = 0; index < guardedWinner; index += 1) {
        const candidate = candidates[index]!;
        if (candidate.raw !== undefined
          && consumed?.(candidate.raw) !== true
          && (candidate.guarded === undefined || consumed?.(candidate.guarded) === true)) {
          noteFinalDecisionEffect(candidate.suppressionReason);
        }
      }
    }
  } else if (guardEnabled && rawWinner !== undefined) {
    // The guard changed a progress-capable winner into await-input.
    noteFinalDecisionEffect(candidates[rawWinner]!.suppressionReason);
  }
  return guardedWinner === undefined ? undefined : candidates[guardedWinner]!.guarded;
}

/**
 * §2.1's one-to-one projection of `CanonicalTaskDecisionKind` onto the wire
 * union, WITH §2.1.1's coupling rule applied.
 *
 * The degradations below are the coupling rule, not defensive coding: a
 * decision is a claim about what the client should do next, so it may only be
 * emitted when the response carries what that action needs. An `act.answer`
 * emitted over shed evidence instructs the client to answer from bytes it does
 * not have — the 2026-08-13 fabrication-push class. `discover` with an
 * executable `next` is a TRUE statement of the same situation.
 */
export function projectTaskDecision(input: DecisionProjectionInput): TaskDecision | undefined {
  const { result, contract, canonicalKind, evidence, consumed } = input;
  if (canonicalKind === undefined || contract === undefined) return undefined;

  // W9: `gapNamedNext` is the LAST of the three, so it can only supply a call
  // when neither the bundle re-pack nor the contract has one — i.e. exactly the
  // shapes that used to fall through to `servedEvidenceZoom` (or, on the
  // `discover` arm, to `await_input:"no-grounded-call-remains"`).
  //
  // R1: the ORDER is unchanged; what is new is that a candidate this lane has
  // already spent is skipped rather than emitted, so the precedence now reads
  // "the highest-ranked call that can still make progress".
  let nextComputed = false;
  let next: ToolCall | undefined;
  const nextForDecision = (): ToolCall | undefined => {
    if (!nextComputed) {
      next = projectSemanticFrontierNext(result, contract, consumed);
      nextComputed = true;
    }
    return next;
  };
  // R1: the same rule for the restoring fallback the degrade arms use — a zoom
  // of a window this lane already re-read is a round trip charged for no bytes,
  // which is the condition `servedEvidenceZoom`'s own contract already forbids.
  const restoringZoom = (): ToolCall | undefined => firstUnconsumed(consumed, withDiscoveryReplay(result, servedEvidenceZoom(evidence)));

  if (canonicalKind === "terminal-closed") return { kind: "done" };

  if (canonicalKind === "act-answer" || canonicalKind === "act-edit") {
    const certificate = projectCertificate(contract, result);
    if (certificate !== undefined) {
      if (canonicalKind === "act-answer") {
        if (answerFloorHolds(evidence, certificate)) return { kind: "act.answer", certificate };
      } else {
        const frontier = projectFrontier(contract, evidence, result);
        // [R5-23] / ruling 6: the create target is the SECOND arm of the floor,
        // so it is read before the guard, not after it. Before this, a pack
        // that had resolved a new-file target produced an empty frontier, fell
        // through to `discover`, and shipped beside an `tl_edit_file create:true`
        // instruction the decision itself could not express.
        const createTarget = projectCreateTarget(result);
        if (editFloorHolds(frontier, createTarget)) {
          return {
            kind: "act.edit",
            certificate,
            // KEY ORDER IS THE WIRE. `frontier` keeps its position ahead of the
            // new key so every already-pinned `act.edit` body is byte-identical
            // (§0.3); a create-only decision simply omits it, which E-1 makes
            // the spelling of "no existing file is a write target here".
            ...(frontier.length > 0
              ? { frontier: [frontier[0]!, ...frontier.slice(1)] as [FrontierEntry, ...FrontierEntry[]] }
              : {}),
            ...(createTarget !== undefined ? { create_target: createTarget } : {}),
          };
        }
      }
    }
    // Floor breached -> degrade (§2.1.1). Never falsify the act.
    //
    // 2026-08-21 smoke-gate dead-end forensics: this used to check ONLY
    // `next` (the contract's own discovery call, always absent on a
    // "prepared" phase contract by construction -- prepared means "no more
    // discovery needed") before giving up. A "prepared/ready" contract whose
    // certificate fails to project for any reason (observed: workspace_state
    // dropped by a byte-cap trim pass) had NO other fallback, so a fully
    // proved, evidence-bearing pack degraded straight to the bald
    // `{await_input, no candidates, no next}` dead end -- the exact shape the
    // "act-on-served-evidence" branch just below already guards against with
    // `next ?? servedEvidenceZoom(evidence)`. Apply the identical, already
    // load-bearing fallback here so a certificate-floor breach is never worse
    // than "re-read a window you already have" when one is available.
    const restoring = nextForDecision() ?? restoringZoom();
    if (restoring !== undefined) {
      const gaps = projectGaps(contract);
      const advisory = discoveryBundleAdvisory(result as never);
      return { kind: "discover", next: restoring, ...(advisory !== undefined ? { advisory } : {}), ...(gaps.length > 0 ? { gaps } : {}) };
    }
    // A.2.5.1: name the residual. The candidate set stays EMPTY here — this is
    // a floor breach on an `act`, not a pick-one — so this is byte-identical to
    // the pre-2026-09-08 shape except for the `unresolved`/`next` it can now
    // carry.
    return awaitInput(result, contract, "no-grounded-call-remains", []);
  }

  if (canonicalKind === "discover") {
    const next = nextForDecision();
    if (next !== undefined) {
      const gaps = projectGaps(contract);
      const advisory = discoveryBundleAdvisory(result as never);
      return { kind: "discover", next, ...(advisory !== undefined ? { advisory } : {}), ...(gaps.length > 0 ? { gaps } : {}) };
    }
    // §2.1: `discover` without a `next` is unrepresentable. The honest shape
    // for "I cannot name a call" is `await_input`, and A.7.2 branch 4 is
    // exactly that condition — plus, since 2026-09-08, WHAT it could not
    // ground (A.2.5.1).
    return awaitInput(result, contract, "no-grounded-call-remains", []);
  }

  // await-input. A.7.2 / A.9.2 row 21: the code is emitted by the branch that
  // made the decision (`contract.await_input_code`), never inferred from prose.
  const awaitCode = contract.await_input_code ?? "no-grounded-call-remains";

  // -------------------------------------------------------------------------
  // [R5-30] / ruling 6 — BRANCH 3 IS RE-SITED, GATED ON THE FLOOR.
  //
  // `act-on-served-evidence` is `grantServedTerminal`'s token
  // (`readCodeTaskPack.ts`'s awaiting-user-input block). That branch's own
  // prose GRANTS the terminal action — "the selected windows of every required
  // surface are served — act on the served evidence" — and its `next_action`
  // agrees; only the SITING said "the server cannot proceed without a human
  // choice". A value spelled *act*-on-served-evidence riding the one kind whose
  // meaning is "I cannot proceed" is the decision↔delivery falsification class
  // F4 removes everywhere else, so the siting is what moves.
  //
  // THE ORDER IS THE RULING'S, and each step is a floor, not a preference:
  //
  //  1. a REAL certificate plus a satisfied §2.1.1 floor -> `act.*`. D-2 makes
  //     the certificate non-negotiable: `act.answer`/`act.edit` are certified
  //     claims, and one is NEVER MINTED HERE. `grantServedTerminal` requires
  //     `readiness === "needs-followup"`, i.e. `!accepted`, and the certificate
  //     is minted only when `accepted` — so at HEAD this arm does not fire, and
  //     that is a fact about the branch rather than a gap in this code. It is
  //     implemented because the floor, not the branch's history, is what
  //     decides: a contract that DOES arrive here certified (a re-serve
  //     carrying `typestate.certificate_id`, say) must get the act it earned.
  //  2. otherwise a concrete restoring call -> `discover`. This is the honest
  //     statement of the uncertified case, and it is the branch's own prose
  //     made executable.
  //  3. otherwise the branch really is awaiting input, and keeps its own token.
  //     Not a residue of the old contradiction: with no certificate AND no call
  //     to name, the grant the prose offered was never real, so `await_input`
  //     is the true siting and A.7.2's per-branch token is the true code.
  // -------------------------------------------------------------------------
  if (awaitCode === "act-on-served-evidence") {
    const certificate = projectCertificate(contract, result);
    if (certificate !== undefined) {
      if (contract.next_action === "answer") {
        if (answerFloorHolds(evidence, certificate)) return { kind: "act.answer", certificate };
      } else {
        const frontier = projectFrontier(contract, evidence, result);
        const createTarget = projectCreateTarget(result);
        if (editFloorHolds(frontier, createTarget)) {
          return {
            kind: "act.edit",
            certificate,
            ...(frontier.length > 0
              ? { frontier: [frontier[0]!, ...frontier.slice(1)] as [FrontierEntry, ...FrontierEntry[]] }
              : {}),
            ...(createTarget !== undefined ? { create_target: createTarget } : {}),
          };
        }
      }
    }
    const restoring = nextForDecision() ?? restoringZoom();
    if (restoring !== undefined) {
      const gaps = projectGaps(contract);
      const advisory = discoveryBundleAdvisory(result as never);
      return { kind: "discover", next: restoring, ...(advisory !== undefined ? { advisory } : {}), ...(gaps.length > 0 ? { gaps } : {}) };
    }
  }

  // -------------------------------------------------------------------------
  // R1 (2026-08-28) — `no-grounded-call-remains` IS A CLAIM ABOUT THIS
  // RESPONSE, AND THE RESPONSE IS THE AUTHORITY ON IT.
  //
  // The same rule branch 3 and the `choose-candidate` fence below already
  // apply, stated for the one code that asserts the absence of a call: if the
  // response CAN still name a grounded, unexecuted call, then "no grounded call
  // remains" is false, and §2.1's honest shape for that situation is `discover`.
  //
  // WHY IT NOW MATTERS. `repairSuppressedNextCall` flips a contract to this code
  // when every axis it can see is spent — but it runs at the IN-BUILD choke,
  // where `qref` is not yet stamped, so `discoveryBundleNext` is invisible to
  // it. The qc1 replay shape is exactly that pack: its caller-supplied
  // `surfaceRoles` make the missing-roles hint byte-identical to the call being
  // served, the choke rightly suppresses it, and the bundle route — unexecuted,
  // and the route this pack shipped before — became computable only here.
  //
  // THE DISCIPLINE IS PRESERVED, NOT RELAXED. `next` has already passed the
  // consumed-fingerprint filter, so a suppressed call cannot return through
  // this door; and `discover` is the arm that EMITS `gaps`, so the repair's
  // disclosure travels with it instead of being dropped by the gap-less
  // `await_input` member.
  // -------------------------------------------------------------------------
  const noGroundedNext = awaitCode === "no-grounded-call-remains" ? nextForDecision() : undefined;
  if (noGroundedNext !== undefined) {
    const gaps = projectGaps(contract);
    const advisory = discoveryBundleAdvisory(result as never);
    return {
      kind: "discover",
      next: noGroundedNext,
      ...(advisory !== undefined ? { advisory } : {}),
      ...(gaps.length > 0 ? { gaps } : {}),
    };
  }

  const candidates = projectCandidates(result, evidence, awaitCode);

  // -------------------------------------------------------------------------
  // CHOOSE-CANDIDATE ⇔ A NON-EMPTY SERVED CANDIDATE SET (2026-08-20).
  //
  // `AwaitInputCode`'s own schema says `candidates` is "emitted iff the choice
  // is between enumerable alternatives", and `choose-candidate` is the one
  // member that IS a pick-one by definition — its absence is reserved for
  // questions that are not ("e.g. a policy question"). So the pairing is not a
  // nicety: a `choose-candidate` with nothing to choose between asserts an
  // enumerable choice and then declines to enumerate it, which is the same
  // decision↔delivery falsification class ruling 6 removed from branch 3.
  //
  // `projectCandidates` above closes the ONLY organic producer of that shape
  // (the projector's gate was narrower than the contract's). This block is the
  // residual fence, for a contract that reaches here already marked
  // `choose-candidate` with no surface carrying a `path` to name — a pack whose
  // evidence is entirely pathless. The order mirrors branch 3's re-siting, and
  // each step is a floor rather than a preference:
  //
  //   1. a concrete restoring call -> `discover`. `next` is the contract's own
  //      call when it has one; `servedEvidenceZoom` is the same widening call
  //      branch 3 falls back to, built from an already-served handle, so it is
  //      grounded in this response rather than invented.
  //   2. otherwise the pack really is out of grounded calls, which is exactly
  //      what A.7.2 branch 4's token says. It is the honest code precisely
  //      BECAUSE the choice this branch claimed cannot be put on the wire.
  //
  // RE-SITING IS DOCUMENTED, NOT SILENT — same standing as ruling 6: the
  // contract keeps marking WHICH BRANCH decided (`await_input_code`), and the
  // projector remains the authority on whether that branch's claim survives
  // contact with what the response can actually deliver. Unlike ruling 6, the
  // wire and the contract still AGREE on the code in every organic case; this
  // moves only the shapes where agreeing would mean both lying.
  //
  // A dead end — {await_input ∧ no candidates ∧ no next} for a pack that
  // claimed a choice — is unreachable from here in either direction.
  // -------------------------------------------------------------------------
  // v0.15.1 runtime review TL-REVIEW-3: ONE candidate is not a choice either.
  // The reviewer's four-file fixture answered 「http.ts の retry 関数について…」
  // with `choose-candidate` and "1 candidate target(s) match this request;
  // name the intended one" — the caller could only re-name the file it had
  // already named. With a grounded call left, the honest shape is the
  // `discover` that fetches what the certificate still lacks; without one,
  // the single served candidate stays the answer to the question it asks.
  const singleCandidateRestoring = awaitCode === "choose-candidate" && candidates.length === 1
    ? nextForDecision() ?? restoringZoom()
    : undefined;
  if (singleCandidateRestoring !== undefined) {
    const gaps = projectGaps(contract);
    const advisory = discoveryBundleAdvisory(result as never);
    return {
      kind: "discover",
      next: singleCandidateRestoring,
      ...(advisory !== undefined ? { advisory } : {}),
      ...(gaps.length > 0 ? { gaps } : {}),
    };
  }
  if (awaitCode === "choose-candidate" && candidates.length === 0) {
    const restoring = nextForDecision() ?? restoringZoom();
    if (restoring !== undefined) {
      const gaps = projectGaps(contract);
      const advisory = discoveryBundleAdvisory(result as never);
      return {
        kind: "discover",
        next: restoring,
        ...(advisory !== undefined ? { advisory } : {}),
        ...(gaps.length > 0 ? { gaps } : {}),
      };
    }
    return awaitInput(result, contract, "no-grounded-call-remains", []);
  }

  return awaitInput(result, contract, awaitCode, candidates);
}

/**
 * Emit-time conformance oracle for the projected decision, in the shape
 * `canonicalTaskDecisionInvariantViolations` established: a pure function from
 * the artifact to a list of named violations, empty when the artifact is
 * honest.
 *
 * WHY IT EXISTS SEPARATELY FROM THAT ONE. `canonicalTaskDecisionInvariantViolations`
 * reads a `TaskPackResult` — the PRE-projection object. The candidate set is
 * not a field of that object at all; it is derived here, from the projected
 * `evidence[]`, at the moment the decision is built. A rule about it is
 * therefore unstateable at the canonical layer and belongs to this one.
 *
 * TWO RULES, and each is one the TYPES CANNOT express. This is not a home for
 * restating the type system: `TaskDecision` already makes `next` required on
 * `discover` and `certificate` required on both `act.*` members, so a rule for
 * those would be unreachable.
 *
 *  1. `choose-candidate`'s pairing with `candidates` — `candidates` is optional
 *     on `await_input` because four of the five codes legitimately omit it, so
 *     the one code that IS a pick-one by definition cannot require it in the
 *     type.
 *  2. FLOOR-AWAIT's emptiness half (added 2026-09-08 with `unresolved`):
 *     ABSENT means "the server could not name the residual" and stays honest;
 *     an EMPTY ARRAY asserts a nameable set and then declines to name it. A
 *     non-empty tuple type would express this, but `UnresolvedItem[]` is the
 *     declared wire shape (a caller reading the schema sees a plain array), so
 *     the rule lives here — the same trade `candidates` already makes.
 */
export function taskDecisionWireViolations(decision: TaskDecision | undefined): string[] {
  if (decision === undefined || decision.kind !== "await_input") return [];
  const violations: string[] = [];
  if (decision.code === "choose-candidate" && (decision.candidates?.length ?? 0) === 0) {
    violations.push("choose-candidate-requires-served-candidates");
  }
  if (decision.unresolved !== undefined && decision.unresolved.length === 0) {
    violations.push("unresolved-present-but-empty");
  }
  return violations;
}
