import type { TaskExecutionContract, TaskReadinessObligation, ToolCall } from "@tokenlighten/types";
import {
  enforceContinuationBudget,
  type ContinuationPlan,
} from "../../util/continuation.js";
import type { TaskPackResult } from "./model.js";
import { codeTaskPackSurfaces } from "./artifactSections.js";
import { semanticFrontierGuardEnabled, sfDemoteEnabled, batchHintsEnabled } from "../../util/flags.js";
import { isSemanticFrontierContinuationOptional } from "./semanticFrontier.js";
import { sfPackContextFor, isAddressGroundingOpenConcern } from "./sfSatisfaction.js";
import { selectCanonicalNext } from "./selectCanonicalNext.js";
import { sfByteResidency, type SfTaskContext } from "../../task-state/sfState.js";
import { epochServedPaths } from "../../util/packServeLog.js";
import {
  surfaceAlreadyCoversWholeFile,
  surfaceExceedsRepackBudget,
  type CoverageProbeSurface,
} from "../../util/surfaceServedCoverage.js";
import { trace } from "../../util/trace.js";
import { markSemanticFrontierWithheldBody } from "./sfWithholdingMarks.js";

type ContinuationCall = ToolCall;
type SemanticSurfaceCarrier = { readonly surfaces?: unknown };

/**
 * Wire projection unit tests legitimately carry a partial producer record.
 * Missing/non-array surfaces mean this guard has no semantic evidence to
 * suppress, so preserve the pre-guard continuation behavior (allowed).
 */
function semanticSurfaces(result: SemanticSurfaceCarrier): TaskPackResult["surfaces"] {
  return Array.isArray(result.surfaces) ? result.surfaces as TaskPackResult["surfaces"] : [];
}

const DISCOVERY_BUNDLE_PATH_CAP = 8;

/**
 * E2 (2026-09-05, measured on paid smoke r9 / SF13): a bundle target this task
 * has ALREADY been served IN AN EARLIER CALL is not an affordance — it is a
 * self-loop.
 *
 * Live: call 1's `decision.next` re-requested, via `qref` + `targets`, exactly
 * the six paths the same pack had just served with bodies; following it
 * returned those same paths as `prior` and minted another `next` over five of
 * them. 71 KB of packs advanced nothing.
 *
 * Scoped to the epoch's served ledger ONLY (`stampEpochServedPaths` — a PRIOR
 * call's history the caller already holds from a separate turn); this is
 * cross-call redundancy with no ambiguity. A bodyless candidate stays
 * eligible — serving its body is exactly what the bundle is for — which is
 * why the `candidate-list` branch below is deliberately NOT filtered.
 *
 * Deliberately NOT used to drop a path THIS SAME pack already embeds a body
 * for — see `surfaceFullyCoversPathInThisPack` and its caller in
 * `discoveryBundleNext`'s graph branch for why that is a different question
 * (whether firing is worthwhile at all, not which paths belong in the bundle
 * once it fires).
 */
function pathServedInEarlierCall(
  servedInEpoch: ReadonlySet<string>,
  candidatePath: string,
): boolean {
  return servedInEpoch.has(candidatePath);
}

/** Finds THIS pack's own surface for `candidatePath`, projected to the shape
 * `util/surfaceServedCoverage.ts`'s predicates read. `undefined` when this
 * pack carries no surface for the path at all. */
function coverageProbeSurfaceFor(
  result: SemanticSurfaceCarrier,
  candidatePath: string,
): CoverageProbeSurface | undefined {
  const record = semanticSurfaces(result).find((surface) => {
    return (surface as { path?: unknown }).path === candidatePath;
  }) as {
    code?: unknown;
    code_unchanged?: unknown;
    range?: unknown;
    content_completeness?: unknown;
    remaining_ranges?: unknown;
  } | undefined;
  if (record === undefined) return undefined;
  return {
    code: typeof record.code === "string" ? record.code : undefined,
    code_unchanged: typeof record.code_unchanged === "string" ? record.code_unchanged : undefined,
    range: typeof record.range === "string" ? record.range : undefined,
    content_completeness: record.content_completeness === "partial" ? "partial" : undefined,
    remaining_ranges: Array.isArray(record.remaining_ranges)
      ? record.remaining_ranges.filter((entry): entry is string => typeof entry === "string")
      : undefined,
  };
}

/**
 * C1 (DESIGN-v0.15 §12 rows 82-84, R31-FIX regression): whether THIS SAME
 * pack's own surface for `candidatePath` already amounts to everything a
 * whole-file re-pack could add — see util/surfaceServedCoverage.ts's header
 * for the exact rule. Used only to decide whether a graph-relation bundle is
 * worth FIRING at all (`discoveryBundleNext`'s `hasUnservedRelatedNode`
 * gate); a path this pack already fully covers still belongs in the bundle's
 * `paths` array once firing is justified — bundling the whole related
 * cluster in one re-pack call is what makes it a BUNDLE, and the caller-named
 * `qref` re-pack was never a per-path grant (`discoveryBundleAdvisory`).
 */
function surfaceFullyCoversPathInThisPack(
  result: SemanticSurfaceCarrier,
  candidatePath: string,
): boolean {
  const probe = coverageProbeSurfaceFor(result, candidatePath);
  return probe !== undefined && surfaceAlreadyCoversWholeFile(probe);
}

/**
 * C1: whether THIS SAME pack's own surface for `candidatePath` PROVES a
 * re-pack would only reproduce the same already-served anchor window — the
 * original E2 self-loop case (a large file's cap-trimmed embed). Unlike
 * `surfaceFullyCoversPathInThisPack`, this DOES drop the path from
 * `discoveryBundleNext`'s `paths` array: re-including it would be wasteful,
 * never merely redundant (see util/surfaceServedCoverage.ts's header).
 */
function surfaceExceedsRepackBudgetInThisPack(
  result: SemanticSurfaceCarrier,
  candidatePath: string,
): boolean {
  const probe = coverageProbeSurfaceFor(result, candidatePath);
  return probe !== undefined && surfaceExceedsRepackBudget(probe);
}

/** Only explicitly classified lexical surfaces are outside canonical continuation. */
export function semanticFrontierNextAllowed(
  result: SemanticSurfaceCarrier,
  guardEnabled = semanticFrontierGuardEnabled(),
): boolean {
  const surfaces = semanticSurfaces(result);
  return !guardEnabled
    || surfaces.length === 0
    || surfaces.some((surface) => !isSemanticFrontierContinuationOptional(surface));
}

function optionalOnlyAddresses(result: SemanticSurfaceCarrier): { paths: Set<string>; handles: Set<string> } {
  const all = semanticSurfaces(result);
  const optional = (field: "path" | "handle") => new Set(all
    .filter((surface) => typeof surface[field] === "string" && isSemanticFrontierContinuationOptional(surface))
    .map((surface) => surface[field] as string)
    .filter((address) => !all.some((surface) => surface[field] === address && !isSemanticFrontierContinuationOptional(surface))));
  return { paths: optional("path"), handles: optional("handle") };
}

/** Strip only targets proven supporting-only; query-only searches remain valid. */
export function sanitizeSemanticFrontierNext(
  result: SemanticSurfaceCarrier,
  call: ToolCall | undefined,
  guardEnabled = semanticFrontierGuardEnabled(),
): ToolCall | undefined {
  if (call === undefined || !guardEnabled) return call;
  const optional = optionalOnlyAddresses(result);
  if (optional.paths.size === 0 && optional.handles.size === 0) return call;
  const args = { ...call.arguments } as Record<string, unknown>;
  const optionalTarget = (value: Record<string, unknown>): boolean => {
    const addresses = [typeof value.path === "string" ? optional.paths.has(value.path) : false, typeof value.handle === "string" ? optional.handles.has(value.handle) : false];
    // A mismatched mixed target is unsafe: either optional-only address makes
    // it a continuation carrier for that optional surface.
    return addresses.some(Boolean);
  };
  if (Array.isArray(args.targets)) args.targets = args.targets.filter((target) => target !== null && typeof target === "object" && !optionalTarget(target as Record<string, unknown>));
  for (const [singular, plural, set] of [["path", "paths", optional.paths], ["handle", "handles", optional.handles]] as const) {
    if (typeof args[singular] === "string" && set.has(args[singular] as string)) delete args[singular];
    if (Array.isArray(args[plural])) args[plural] = args[plural].filter((value): value is string => typeof value === "string" && !set.has(value));
  }
  const hasAddress = typeof args.path === "string" || typeof args.handle === "string"
    || (Array.isArray(args.paths) && args.paths.length > 0) || (Array.isArray(args.handles) && args.handles.length > 0)
    || (Array.isArray(args.targets) && args.targets.length > 0);
  const hadAddress = Object.prototype.hasOwnProperty.call(call.arguments, "path") || Object.prototype.hasOwnProperty.call(call.arguments, "handle")
    || Object.prototype.hasOwnProperty.call(call.arguments, "paths") || Object.prototype.hasOwnProperty.call(call.arguments, "handles") || Object.prototype.hasOwnProperty.call(call.arguments, "targets");
  if (hadAddress && !hasAddress) {
    return undefined;
  }
  return { ...call, arguments: args as ToolCall["arguments"] };
}

// ---------------------------------------------------------------------------
// W-DEMOTE (v0.15 §3.5 / D4) — staged demotion, not removal.
//
// The legacy TL_SEMANTIC_FRONTIER_GUARD path (sanitizeSemanticFrontierNext
// above, decisionWire.ts's suppressRemaining) deletes an optional-only
// address's `remaining` field, or drops it from `next` outright. That is the
// exact backfire the v0.15 plan measured (DESIGN-v0.15-semantic-frontier-plan
// .md §0.1 / v2 SF05 #17->#21): the caller re-discovers the same address by
// hand, via an explicit `targets` re-request, because nothing server-side
// left it reachable.
//
// TL_SF_DEMOTE (mutually exclusive with the guard flag; the check is
// `flags.ts`'s `assertSemanticFrontierV2FlagConsistency`, invoked once from
// `server.ts` startup so an inconsistent flag set refuses to boot rather than
// producing two conflicting projections at runtime) never deletes
// `remaining`. decisionWire.ts's projectEvidence keeps every SF-optional
// candidate's evidence[] row — handle, path, role, full `remaining` — and
// only reorders it after the required/primary rows. This module is the
// SOURCE of the one signal decisionWire.ts cannot derive on its own: which
// individual surface OBJECTS are exempt from that reordering because
// demoting them would violate D4 (served-ledger supremacy) or I-2
// (required/explicit addresses are permanently un-demotable).
//
// WHY A SIDE TABLE, NOT A NEW FIELD. §4.2 fixes wire-field parity at zero new
// fields for demotion; a WeakMap keyed on the surface OBJECT (exactly how
// `isSemanticFrontierContinuationOptional`'s own WeakSet in
// semanticFrontier.ts already works) carries the signal from this module's
// early pass — `applyCanonicalTaskDecision` runs inside readCodeTaskPack.ts's
// task-pack construction, before server.ts ever calls decisionWire.ts's
// projectEvidence on the same `result.surfaces` array — forward to that
// later, narrower-scoped call, without adding anything a codec could
// serialize.
//
// WHY A MAP AND NOT A SET (SF-8). A `WeakSet` records "this surface passed the
// predicate ONCE", and that is not the same claim as "this surface may be
// demoted NOW". Between the marking pass and `projectEvidence`, the same pack
// can gain a body for the surface, gain a `required` use for its address, or
// see the served ledger record the path — every one of which must un-mark it.
// The Map keeps each mark bound to the PACK it was taken on, so the predicate
// is RE-EVALUATED against that pack's live SF context at read time, and the
// answer can go from true back to false. It never goes the other way: a
// surface this pass never marked stays ineligible forever, which is the
// fail-closed default (I-1/D4) a set of EXEMPTIONS would have inverted.
// ---------------------------------------------------------------------------

/** One marked surface, bound to the pack whose SF context governs it. */
interface SfDemotionMark {
  readonly result: TaskPackResult;
}

const sfDemotionMarks = new WeakMap<object, SfDemotionMark>();

/**
 * D4's residency reader for one pack. The SF context (`sfSatisfaction.ts`'s
 * `SfPackContext`) carries only `snapshot.ledgerWired` — whether A ledger was
 * wired — never the reader itself, so the task_pack seam publishes the reader
 * here alongside it. Absent means residency is UNKNOWN for every address of
 * this pack, and unknown is never eligible.
 */
const sfDemotionResidency = new WeakMap<object, SfTaskContext>();

/**
 * Publish the SF task context (its `ledger` in particular) for `result`, so
 * demotion eligibility can ask the served ledger about a SPECIFIC ADDRESS
 * rather than settling for the pack-wide `ledgerWired` boolean. Called by the
 * task_pack seam with the very context it drove `openSfTask`/`recordServed`
 * with — never re-derived here, so the two can never disagree.
 */
export function attachSfDemotionResidency(result: object, ctx: SfTaskContext): void {
  if (result === null || typeof result !== "object") return;
  sfDemotionResidency.set(result, ctx);
}

// ---------------------------------------------------------------------------
// FX-Y1 (round-23B review finding 1, HIGH, ruling (cc), 2026-09-04) — the
// AWAIT-INPUT EMISSION INVARIANT.
//
// Independent of the satisfaction fix (`sfSatisfaction.ts`'s
// `relationDisclosureSatisfies`), the review named a second, structural
// requirement: this arbiter must never hand the caller a bare
// `{kind:"await-input"}` with nothing it can act on. `selectCanonicalNext`
// (§10.0 DC2) is free to return `next:null` with `closure.canAct:false` —
// that is its honest answer when its OWN priority-2 pass finds no open
// non-advisory concern to name a call for, which can happen even while
// `snapshot.allNonAdvisoryClosed` is still `false` (see
// `pickTopUnsatisfiedConcern`'s `isConcernOpen` re-check: a concern the
// snapshot still lists open can independently read as already-served by its
// OWN, stricter address check). Emitting `await-input` on THAT shape is
// exactly the dead end the review reproduced: a concern this layer cannot
// even name a call for is not a concern this layer can honestly claim is
// blocking.
//
// The fix is fail-CLOSED toward action, not toward silence: whatever the
// underlying (pre-SF) decision already proved — `act-answer`/`act-edit` — is
// what ships, because SF found no address to demand and no address to name
// as `next` either, so it has nothing left to make a case with. This is I-1's
// posture applied to this one seat: "never worse than the pre-SF decision."
// A trace-safe counter records every time this fires, so the gap this
// invariant papers over stays visible instead of vanishing into a decision
// that looks ordinary on the wire.
// ---------------------------------------------------------------------------

let sfAwaitInputInvariantFallbackCount = 0;

/** Test-only: the number of times the invariant below has fired this process. */
export function sfAwaitInputInvariantFallbackCountForTest(): number {
  return sfAwaitInputInvariantFallbackCount;
}

/** Test-only: reset the counter so one spec's assertions cannot see another's fires. */
export function resetSfAwaitInputInvariantFallbackCountForTest(): void {
  sfAwaitInputInvariantFallbackCount = 0;
}

/**
 * Record that the invariant below fired. Best-effort and fail-open (I-1):
 * tracing must never affect the decision it is observing, so a missing
 * workspace root (no residency context published for this pack) or a
 * throwing trace sink both degrade to "counter incremented, no trace line" —
 * never a thrown error into the decision path.
 */
function traceSfAwaitInputInvariantFallback(result: TaskPackResult, reason: string): void {
  sfAwaitInputInvariantFallbackCount += 1;
  try {
    const workspaceRoot = sfDemotionResidency.get(result)?.workspaceRoot;
    if (typeof workspaceRoot === "string" && workspaceRoot !== "") {
      trace("sf_await_input_invariant_fallback", { reason }, workspaceRoot);
    }
  } catch {
    // Best-effort only — see this function's own doc comment.
  }
}

/**
 * The full eligibility predicate, evaluated against `result`'s CURRENT state.
 *
 * A surface is safe to reorder into the demoted tail only when SF classifies
 * it optional, it is NOT one of `snapshot.requiredAddresses` (I-2), the caller
 * does not ALREADY HOLD its bytes (no `code_unchanged` restatement in THIS
 * response), and the byte-residency ledger answers a PROVEN "never served"
 * for its address (D4: served or unknown is never eligible).
 *
 * FOURTH INERTNESS LAYER (2026-09-03, FX-H). This predicate used to
 * disqualify any surface carrying a `code` body, under the label "D4:
 * residency served-now". That reading is circular: a body this very response
 * has not sent yet is not something the caller "already holds" — it is
 * exactly the byte §3.5.1's `supporting` tier exists to withhold. With that
 * clause in place, TL_SF_DEMOTE could only ever REORDER rows some OTHER
 * subsystem (the budget shedder) had already stripped, so on any pack that
 * fits its budget — every small workspace, and the combined pin's own
 * fixture — the flag changed no byte at all. D4 itself is unharmed: the
 * per-address `sfByteResidency` check below is the authority on "already
 * held", and `code_unchanged` (a restatement of bytes the caller received
 * earlier) still disqualifies outright.
 */
function demotionEligibleNow(result: TaskPackResult, surface: object): boolean {
  if (!sfDemoteEnabled()) return false;
  const ctx = sfPackContextFor(result);
  if (ctx === undefined || ctx.observationOnly || !ctx.snapshot.active) return false;
  // D4: no ledger wired means residency is UNKNOWN for every candidate this
  // call could demote. Fail closed rather than guess (§0.2 D4).
  if (ctx.snapshot.ledgerWired !== true) return false;
  if (!isSemanticFrontierContinuationOptional(surface as TaskPackResult["surfaces"][number])) return false;
  const record = surface as unknown as Record<string, unknown>;
  // D4: the caller already holds these bytes from an earlier call — never
  // demote (and nothing to save: a restatement is already cheap).
  if (typeof record["code_unchanged"] === "string") return false;
  const path = typeof record["path"] === "string" ? record["path"] : undefined;
  if (path === undefined) return false;
  if (ctx.snapshot.requiredAddresses.includes(path)) return false; // I-2.
  // RULING (dd), round-24 finding 1, 2026-09-04 (FX-Y2): an address that
  // grounds an OPEN non-advisory concern — its own, or (for an open relation
  // concern) a definition/declaration sibling's — is treated as required for
  // demotion purposes exactly like I-2, even though it was never caller-named
  // and `requiredAddresses` above therefore never lists it. See
  // `isAddressGroundingOpenConcern`'s own doc comment (sfSatisfaction.ts) for
  // the full mechanism this closes: a sibling concern satisfied by the sync
  // pass, off a body this same pack was about to demote out from under a
  // still-open relation concern's later disclosure-based closure.
  if (isAddressGroundingOpenConcern(path, ctx.concerns, ctx.snapshot.openNonAdvisory)) return false;
  // D4, per ADDRESS: the ledger is the only authority on whether the caller
  // already holds bytes for this path. `known:false` (no reader published) is
  // UNKNOWN, and unknown fails closed exactly like served.
  const taskCtx = sfDemotionResidency.get(result);
  if (taskCtx === undefined) return false;
  const residency = sfByteResidency(taskCtx, { path });
  if (!residency.known || residency.servedPath) return false;
  // D3(b) (FX-R3, 2026-09-04): INTRA-PACK RESIDENCY. The ledger above answers
  // for EARLIER calls only; it cannot see a sibling row minted moments ago in
  // THIS pack. Live (smoke-r3 cell SF05 ... -r0): the recursive read closure
  // minted a second `drv_baro.h` row for `1-23` while the pack already served
  // `1-49` WITH a body, the classifier marked the narrow row optional, and the
  // wire shipped a demoted row for a path a primary row was shipping bytes
  // for — `re_suppression_count:1`, the invariant `decisionWire.ts` claimed
  // was "0 by construction". Bytes another row of this same pack puts on the
  // wire ARE served (ruling (c): only `not served` is demotable), so this
  // surface is not demotable.
  if (packSiblingServesThisWindow(result, surface, path)) return false;
  return true;
}

/** `"<start>-<end>"` → `[start, end]` for the sibling check below. */
function demotionLineSpan(value: unknown): [number, number] | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(\d+)-(\d+)$/.exec(value.trim());
  if (match === null) return undefined;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end < start) return undefined;
  return [start, end];
}

/**
 * D3(b): does ANOTHER row of `result` carry a body covering (or overlapping)
 * `surface`'s own window for the same path?
 *
 * File coordinates per ruling (t): both spans are the surfaces' own served
 * line ranges. A sibling body whose range cannot be parsed counts as covering
 * the whole file — fail-closed toward "already served", which only ever KEEPS
 * a body (it can never un-suppress one, so `re_suppression_count` stays 0).
 */
function packSiblingServesThisWindow(
  result: TaskPackResult,
  surface: object,
  path: string,
): boolean {
  if (!Array.isArray(result.surfaces)) return false;
  const own = demotionLineSpan((surface as unknown as Record<string, unknown>)["range"]);
  for (const sibling of result.surfaces) {
    if (sibling === surface || sibling === null || typeof sibling !== "object") continue;
    const record = sibling as unknown as Record<string, unknown>;
    if (record["path"] !== path) continue;
    const body = typeof record["code"] === "string" && record["code"] !== ""
      ? record["code"]
      : typeof record["code_unchanged"] === "string" ? record["code_unchanged"] : undefined;
    if (body === undefined || body === "") continue;
    const span = demotionLineSpan(record["range"]);
    if (span === undefined || own === undefined) return true;
    if (span[0] <= own[1] && own[0] <= span[1]) return true;
  }
  return false;
}

/**
 * True only when `surface` was marked by this module's own pass AND still
 * satisfies the whole predicate against its pack's live SF state (SF-8).
 */
export function isSemanticFrontierDemotionEligible(surface: object): boolean {
  const mark = sfDemotionMarks.get(surface);
  if (mark === undefined) return false;
  return demotionEligibleNow(mark.result, surface);
}

/**
 * SF-8 ORDERING. `applyCanonicalTaskDecision` runs EARLY inside
 * `dedupeTrimAndPersist`, at a point where this pack's SF context has not been
 * opened yet — so `sfPackContextFor(result)` is `undefined` there, the
 * demotion marking pass marks nothing, and the `next` arbitration sees no
 * snapshot and returns the legacy decision untouched.
 *
 * This is the re-application that closes it: the same canonical exit, run once
 * more now that the context exists. It is called TWICE by design — from
 * readCodeTaskPack.ts's `applySemanticFrontierPreBookingSeam` (so the demoted
 * pack's decision is the one every serve-booking producer downstream sees) and
 * again from `buildTaskPack`, after the continuation bundle has appended its
 * bodyless rows (so the decision describes the pack as it SHIPS). Idempotent
 * by construction: `applyCanonicalTaskDecision` re-derives rather than
 * accumulates.
 *
 * It is gated on `TL_SF_DEMOTE` — with the flag off it is never called at all,
 * and with the flag on but no context it returns before doing anything, so a
 * flag-off pack is byte-identical by construction.
 */
export function reapplySemanticFrontierDecision(result: TaskPackResult): void {
  if (!sfDemoteEnabled()) return;
  if (sfPackContextFor(result) === undefined) return;
  applyCanonicalTaskDecision(result);
}

// ---------------------------------------------------------------------------
// W-DEMOTE APPLICATION (§3.5.1's `supporting` tier) — the body actually comes
// off HERE, on the surface, not later on the wire.
//
// WHY NOT IN `projectEvidence`. Several producers read `surface.code` as the
// truth about what this response sent: `recordServedEditAdmissibility` (the
// edit gate's admissible union), the cumulative `recordServedSurfaces` log
// (which `priorEpochActionFrontier` lifts into the NEXT same-epoch
// certificate's `action_frontier`), `rememberCertifiedWorkingSet`,
// `captureServedPack`'s `recordPackServedRanges` (the byte-residency ledger
// `sfByteResidency`/`hasServedPath` answers D4 from, and the one a later
// `code-unchanged` receipt is issued against), and server.ts's
// `recordTaskPackSurfaceReads`. Those five are the ones the single booking
// pass owns; THE LIST IS NOT THE WHOLE STORY (round-15 finding 4). Three more
// writers in `readCodeTaskPack.ts` assert served-ness from a position the seam
// cannot reach, all of them over the POST-`trimToCap` `trimmed` pack:
// `recordEpochTaskContract` (a `servedRoles` proof of type "served"),
// `reconcileEpochTaskContract` (coverage disclosure, which re-reads the body
// from disk rather than asserting wire delivery), and, under
// `TL_COVERAGE_PACKER=v2`, `recordPriorPackObligations` (whose paths reach the
// next certificate's `action_frontier` as explicit action paths). They must
// precede the seam because the contract and the wire are rebuilt from their
// output; a seam-demoted surface can never be a role's sole evidence, because
// demotion requires it NOT to be `semanticPrimary` — its handle is in neither
// `action_frontier` nor `evidence_handles`. `sfBookingOrderFence.spec.ts`
// enumerates every one of them with its justification, and fails on any call
// site it has not been told about. Stripping a body only at wire-projection time
// would leave every one of them asserting the caller holds bytes that never
// left the process — the exact serve-honesty class of defect this codebase has
// paid for twice (F1, 2026-08-02). Removing `code` from the surface itself
// keeps all of them honest for free, and leaves `projectEvidence`'s own
// conservative "never demote a row that still carries a body" gate untouched.
//
// WHERE THIS RUNS (FX-I-A/FX-J, 2026-09-03). "Before all of them" is a claim
// about ORDER, and it has been wrong twice. FX-H ran this pass from
// `buildTaskPack` AFTER `buildTaskPackCore` returned, while the producers run
// inside `dedupeTrimAndPersist`, inside that core (round-13 finding 1). FX-I-A
// moved it into `dedupeTrimAndPersist` at
// `applySemanticFrontierPreBookingSeam` and split the admissible union into a
// nominate/book pair — but left `recordServedSurfaces` upstream and unfiltered,
// so the demoted handle still reached the next pack's frontier (round-14
// finding 1). FX-J closes it structurally: the seam still runs where FX-I-A
// put it — AFTER `finalizePackServeState`, which the classifier needs for the
// finalized `execution_contract` — and every `TL_SF_DEMOTE` booking now
// happens in ONE pass at `dedupeTrimAndPersist`'s exit
// (`bookShippedPackServeState`), off one `shippedSurfaces` projection over the
// pack that ships. FX-K (round-15 finding 1) made that pass UNCONDITIONAL:
// FX-J had left the flag-off path booking pre-trim, and one production
// `budget:{bytes}` read plus one `edit_file` proved that grants write
// authority over a file the response sent no bytes for. There is now exactly
// one booking position in both flag states.
// `sfBookingOrderFence.spec.ts` holds the ordering by parsing
// the source, so the next mis-ordering fails a test instead of a review.
// ---------------------------------------------------------------------------

/** `"<start>-<end>"` → `[start, end]`; `undefined` for anything else. */
function parseLineSpan(value: unknown): [number, number] | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(\d+)-(\d+)$/.exec(value.trim());
  if (match === null) return undefined;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end < start) return undefined;
  return [start, end];
}

/**
 * The union of `spans`, merged over touching/overlapping neighbours, as
 * `"<start>-<end>"` strings. A demoted row's `remaining` must cover the window
 * whose body this pass just withheld PLUS whatever was already undelivered —
 * otherwise the row is bare and unreachable (A.8 E-8), which is the legacy
 * deletion behaviour W-DEMOTE exists to retire.
 */
function mergeLineSpans(spans: readonly [number, number][]): string[] {
  const sorted = [...spans].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: [number, number][] = [];
  for (const [start, end] of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && start <= last[1] + 1) {
      if (end > last[1]) last[1] = end;
      continue;
    }
    out.push([start, end]);
  }
  return out.map(([start, end]) => `${start}-${end}`);
}

/**
 * Withhold the body of every demotion-eligible surface of `result`, leaving it
 * addressable: `handle` + `path` + `role` + a `remaining` window that covers
 * what was withheld (DESIGN-v0.15-semantic-frontier-plan.md §3.5.1's
 * `supporting` tier — "`body` なし、`prior` なし").
 *
 * FLOOR. Never withholds the LAST FRESH body in the pack: §2.1.1's answer floor
 * (`answerFloorHolds`) refuses a response whose every evidence row is bodyless,
 * and degrading a ready `act.answer` into `await_input` would cost the very
 * turn this lever is buying. In practice the classifier already guarantees a
 * survivor (`semanticPrimary` treats index 0 as primary), so this is a
 * belt-and-braces invariant, not the common path.
 *
 * FX-I-A (2026-09-03), round-13 finding 5: the survivor count is over FRESH
 * bodies (`code`) ONLY. It used to include `code_unchanged` restatements,
 * which the loop can never demote — so on a pack with one fresh body and N
 * restatements the count read `N+1 > 1` and the one body this response would
 * actually have SENT was demotable, producing a response that serves no new
 * bytes. `answerFloorHolds` accepts `prior`, so nothing degraded; the floor
 * simply did not implement the invariant its own doc states. It does now.
 *
 * Returns the number of surfaces whose body was withheld.
 */
export function applySemanticFrontierDemotion(result: TaskPackResult): number {
  if (!sfDemoteEnabled()) return 0;
  if (sfPackContextFor(result) === undefined) return 0;
  if (!Array.isArray(result.surfaces)) return 0;
  const bodied = result.surfaces.filter(
    (surface) => surface !== null && typeof surface === "object"
      && typeof (surface as unknown as Record<string, unknown>)["code"] === "string",
  );
  let survivors = bodied.length;
  let demoted = 0;
  for (const surface of result.surfaces) {
    if (surface === null || typeof surface !== "object") continue;
    const record = surface as unknown as Record<string, unknown>;
    if (typeof record["code"] !== "string") continue;
    if (survivors <= 1) break; // answer floor: keep at least one body.
    if (!isSemanticFrontierDemotionEligible(surface)) continue;
    const spans: [number, number][] = [];
    const own = parseLineSpan(record["range"]);
    if (own !== undefined) spans.push(own);
    if (Array.isArray(record["remaining_ranges"])) {
      for (const entry of record["remaining_ranges"]) {
        const span = parseLineSpan(entry);
        if (span !== undefined) spans.push(span);
      }
    }
    // No addressable window at all ⇒ withholding the body would produce a bare
    // row. Fail closed and keep serving it (I-1: SF never degrades a pack).
    if (spans.length === 0) continue;
    delete record["code"];
    // FX-R3d (D10): the ONE authoritative record that THIS pass — not the
    // byte cap, not D8's join bound, not the shedder — is why this row ships
    // bodyless. `protocol/envelope.ts` intersects these marks with the final
    // wire to compute `demoted_count`, so engagement can no longer be claimed
    // by a row nothing here ever touched.
    markSemanticFrontierWithheldBody(surface);
    // `anchors_served` claims this surface's decision-critical lines are
    // INSIDE the served window (readiness risk stops charging the
    // partial-content factor on the strength of it). Nothing is served here
    // any more, so the claim goes with the body.
    delete record["anchors_served"];
    record["content_completeness"] = "partial";
    record["remaining_ranges"] = mergeLineSpans(spans);
    survivors -= 1;
    demoted += 1;
  }
  // The decision was derived against a pack that still carried these bodies.
  // `applyCanonicalTaskDecision` re-derives rather than accumulates, so one
  // more pass restates it over what this response actually sends.
  if (demoted > 0) applyCanonicalTaskDecision(result);
  return demoted;
}

/** Mark every eligible surface of `result` ahead of decisionWire.ts's read. */
function markSemanticFrontierDemotionEligibility(result: TaskPackResult): void {
  if (!sfDemoteEnabled()) return;
  if (!Array.isArray(result.surfaces)) return;
  for (const surface of result.surfaces) {
    if (surface === null || typeof surface !== "object") continue;
    if (!demotionEligibleNow(result, surface)) continue;
    sfDemotionMarks.set(surface, { result });
  }
}

// ---------------------------------------------------------------------------
// W-NEXT-ARBITER (v0.15 §10.0, DC2) — this module owns `decision.next`.
//
// Three sibling designs want a say in `next`'s contents; §10.0 hands the
// arbitration seat to `selectCanonicalNext` (a pure, sibling-agnostic
// function) and requires every existing derivation to route through it
// rather than special-case each concern. Priority 1 (explicit targets) is
// intentionally passed as `[]` here: by the time `deriveCanonicalTaskDecision`
// has produced a decision, an unresolved caller-named target has already
// been surfaced through an EARLIER branch of that function (the required
// zoom / stale-obligation / epoch-contract demotions above) — passing the
// live `snapshot.requiredAddresses` ledger here instead would make
// `selectCanonicalNext`'s own `explicit-target-pending` closure fire on
// every task that has EVER named an address, which is not what "pending"
// means in §10.0's priority-1 sense.
// ---------------------------------------------------------------------------

/**
 * The `cwd` / `task.handle` / `qref` the replaced call already carried (SF-2).
 * Nothing is invented: a field absent from BOTH the legacy call and the pack
 * stays absent, so an arbitrated call is never more scoped than its input.
 */
function legacyCallIdentity(
  result: TaskPackResult,
  legacy: ToolCall | undefined,
): { cwd?: string; taskHandle?: string; qref?: string } {
  const args = (legacy?.arguments ?? {}) as unknown as Record<string, unknown>;
  const task = args["task"];
  const handle = task !== null && typeof task === "object"
    ? (task as Record<string, unknown>)["handle"]
    : undefined;
  const legacyQref = args["qref"];
  const qref = typeof legacyQref === "string" && legacyQref !== ""
    ? legacyQref
    : typeof result.qref === "string" && result.qref !== "" ? result.qref : undefined;
  return {
    ...(typeof args["cwd"] === "string" && args["cwd"] !== "" ? { cwd: args["cwd"] as string } : {}),
    ...(typeof handle === "string" && handle !== "" ? { taskHandle: handle } : {}),
    ...(qref === undefined ? {} : { qref }),
  };
}

/**
 * D8 (FX-R3c, 2026-09-04) — WHY THE ARBITRATED CALL NEEDED A CARRIER.
 *
 * `applyCanonicalTaskDecision` returns EARLY when the pack is already
 * internally coherent (`if (!needsRepair) return decision;`), which is the
 * common case for a `discover` pack. Everything §10.0's arbiter decided was
 * therefore computed and thrown away: `contract.next_call` kept whatever the
 * legacy derivation had put there (usually nothing), and
 * `decisionWire.discoverNext` fell through to `servedEvidenceZoom` — the
 * codeless-row gap fallback the sealed SF05 replay shipped, pointing at a
 * firmware file's unserved prefix instead of the file the caller named.
 *
 * A change to `needsRepair` itself would re-run the whole discovery
 * projection on every coherent SF pack. This carries the ONE field that
 * actually differs instead: the arbiter records the call it selected, and the
 * exit assigns exactly that, only on the `discover` arm, only under
 * `TL_SF_DEMOTE` (the flag that gates arbitration at all), so a flag-off pack
 * is byte-identical by construction.
 */
const sfArbitratedNextCall = new WeakMap<object, ToolCall>();

/**
 * The call §10.0's arbiter selected for `result`, if any. Exported so a spec
 * can prove the exit ASSIGNED it (`contract.next_call`) rather than computing
 * and discarding it, which is what the coherence gate below used to do.
 */
export function sfArbitratedNextCallFor(result: object): ToolCall | undefined {
  if (result === null || typeof result !== "object") return undefined;
  return sfArbitratedNextCall.get(result);
}

/**
 * D9 (ruling (cc)): the same-basename choices the arbiter surfaced for this
 * pack, published for `decisionWire.ts`'s `await_input` projection. Empty (or
 * absent) means this pack carries no ambiguous basename.
 */
const sfAwaitInputCandidatePaths = new WeakMap<object, readonly string[]>();

/** The ambiguous-basename choices `result`'s concerns carry (D9). */
export function sfAwaitInputCandidatePathsFor(result: object): readonly string[] {
  if (result === null || typeof result !== "object") return [];
  return sfAwaitInputCandidatePaths.get(result) ?? [];
}

function applySemanticFrontierNextArbitration(
  result: TaskPackResult,
  decision: CanonicalTaskDecision | undefined,
): CanonicalTaskDecision | undefined {
  if (decision === undefined || !sfDemoteEnabled()) return decision;
  if (decision.kind !== "discover" && decision.kind !== "act-answer" && decision.kind !== "act-edit") {
    return decision;
  }
  const ctx = sfPackContextFor(result);
  if (ctx === undefined || ctx.observationOnly || !ctx.snapshot.active) return decision;
  // SF-2: an arbitrated `next` REPLACES the legacy one, so it must carry the
  // legacy call's identity — `cwd` (a worktree caller gets `cwd-required-*`
  // without it), `task.handle` (without it the caller starts a new task), and
  // `qref` (without it a bounded re-pack becomes a fresh unscoped one). Read
  // off the call being replaced, with `result.qref` as the fallback for a
  // legacy call that carried none.
  const identity = legacyCallIdentity(result, decision.next_call);
  const arbitration = selectCanonicalNext({
    explicitTargets: [],
    concerns: ctx.concerns,
    snapshot: ctx.snapshot,
    continuation: undefined,
    // SF-6: batch FOLDING is the turn-economy read-batching lever
    // (`TL_BATCH_HINTS`), not the edit-frontier batching one — folding several
    // concerns' addresses into one `read_file` is a read-side transform and
    // has nothing to do with `TL_BATCH_EDIT_FRONTIER`'s prepared-phase
    // multi-target edit fence.
    batchFold: { enabled: batchHintsEnabled(), maxTargets: DISCOVERY_BUNDLE_PATH_CAP },
    currentNext: decision.next_call ?? null,
    // F9 (ruling (a)): the named-frontier join's per-path direct-read window
    // map (`readCodeTaskPack.ts`'s `applySemanticFrontierNamedFrontier`), so
    // a path-anchored concern's `next` can be a direct, bounded `content:
    // "full"` read instead of the whole-file/`qref` shape that forced
    // `server.ts`'s `normalizeCanonicalRequest` into an extra, empty
    // task_pack re-pack hop on the sealed SF05 replay.
    pathDirectReadWindows: ctx.namedFrontierDirectWindows,
    ...identity,
  });
  // D9 (ruling (cc)): publish the ambiguous-basename choice for the
  // `await_input` projection, on every arm — the decision that ends up
  // carrying it is `decisionWire.ts`'s to make, not this function's.
  const candidatePaths = arbitration.candidates
    .map((address) => address.path)
    .filter((path): path is string => typeof path === "string" && path !== "");
  if (candidatePaths.length > 0) sfAwaitInputCandidatePaths.set(result, candidatePaths);
  if (decision.kind === "act-answer" || decision.kind === "act-edit") {
    // P-4 (§6): an open non-advisory concern this arbiter can see must not
    // stand behind a stale certificate. This only ever DOWNGRADES `act.*` —
    // a true `canAct` never promotes a lesser decision on its own (§10.0).
    if (arbitration.closure.canAct) return decision;
    if (arbitration.next !== null) {
      return { kind: "discover", next_call: arbitration.next, reason: arbitration.closure.reason };
    }
    // FX-Y1 (round-23B finding 1, HIGH, ruling (cc)): the arbiter can name
    // NEITHER a call to close the open concern NOR a `next` to discover it
    // with. That is the bare `{await-input, no next}` dead end the review
    // reported — see this function's own header comment above. A concern
    // this layer cannot even name a call for cannot be the thing standing
    // between the caller and the decision this pack already proved, so fail
    // closed toward that decision rather than manufacture a dead end.
    traceSfAwaitInputInvariantFallback(result, arbitration.closure.reason);
    return decision;
  }
  // decision.kind === "discover": the top unsatisfied concern this module's
  // own concern graph ranked may name a different address than the legacy
  // derivation did; §10.0 gives this call the arbitration seat over it.
  if (arbitration.next === null || arbitration.next === undefined) return decision;
  // D8: record it, so the exit can assign it even when the pack is otherwise
  // coherent and `applyCanonicalTaskDecision` returns before its projectors.
  sfArbitratedNextCall.set(result, arbitration.next);
  return { ...decision, next_call: arbitration.next };
}

type CompletionObligation = Omit<TaskReadinessObligation, "required"> & { required: boolean };

export interface CompletionProjection {
  blocking: TaskReadinessObligation[];
  openBlocking: TaskReadinessObligation[];
  complete: boolean;
  coverage: TaskPackResult["coverage"];
}

/** Project coverage and blocking completion from one obligation snapshot. */
export function projectCompletion(
  result: Pick<TaskPackResult, "coverage">,
  obligations: readonly CompletionObligation[],
  options: { promoteWhenComplete?: boolean } = {},
): CompletionProjection {
  const blocking = obligations.filter(
    (obligation): obligation is TaskReadinessObligation => obligation.required !== false,
  );
  const openBlocking = blocking.filter((obligation) => obligation.status !== "proved");
  // The obligation snapshot can invalidate structural coverage, but an empty
  // or fully proved snapshot cannot manufacture scope proof the locator never
  // established. Preserve focused/partial here; only an open blocker demotes
  // an otherwise-complete result.
  const coverage = openBlocking.length > 0
    ? "partial"
    : options.promoteWhenComplete === true ? "complete" : result.coverage;
  return {
    blocking,
    openBlocking,
    complete: openBlocking.length === 0,
    coverage,
  };
}

/** Returns a bounded re-pack using only paths already related by this pack. */
export function discoveryBundleNext(
  result: TaskPackResult,
  guardEnabled = semanticFrontierGuardEnabled(),
): ToolCall | undefined {
  if (!semanticFrontierNextAllowed(result, guardEnabled) || result.coverage === "complete" || typeof result.qref !== "string" || result.qref === "") return undefined;
  const surfaces = semanticSurfaces(result);
  const paths: string[] = [];
  const add = (value: unknown): void => {
    if (typeof value === "string" && value !== "" && !paths.includes(value) && paths.length < DISCOVERY_BUNDLE_PATH_CAP) paths.push(value);
  };
  if (result.coverage_reason === "candidate-list") {
    for (const surface of surfaces) {
      if (guardEnabled && isSemanticFrontierContinuationOptional(surface)) continue;
      add((surface as { path?: unknown }).path);
    }
  } else {
    const graph = result.wiring?.evidence_graph;
    if (graph === undefined || graph.relations.length === 0) return undefined;
    // A mixed graph may contain lexical-only nodes. An address is optional only
    // when every surface for it carries the explicit internal annotation.
    const optionalPaths = !guardEnabled ? new Set<string>() : new Set(surfaces
      .filter((surface) => isSemanticFrontierContinuationOptional(surface))
      .map((surface) => surface.path as string)
      .filter((path) => !surfaces.some((surface) => {
        return surface.path === path && !isSemanticFrontierContinuationOptional(surface);
      })));
    const relatedIds = new Set(graph.relations.flatMap((relation) => [relation.from, relation.to]));
    // E2: never re-request what an EARLIER call in this epoch already served
    // (`pathServedInEarlierCall`), or what THIS SAME pack already proved a
    // re-pack would only reproduce (`surfaceExceedsRepackBudgetInThisPack` —
    // the original r9 SF13 self-loop this rule exists for). A path this same
    // pack fully covers WITHOUT that proof (C1: a small, already-complete
    // whole-file embed) still belongs in the bundle once firing is
    // justified — dropping it would shrink a legitimate single-gap bundle
    // below the 2-path floor and silence it entirely (the sf-flag-control/
    // treatment regression); `hasUnservedRelatedNode` gates firing instead.
    const servedInEpoch = epochServedPaths(result);
    let hasUnservedRelatedNode = false;
    for (const node of graph.nodes) {
      if (!relatedIds.has(node.id)) continue;
      if (optionalPaths.has(node.path)) continue;
      if (pathServedInEarlierCall(servedInEpoch, node.path)) continue;
      if (surfaceExceedsRepackBudgetInThisPack(result, node.path)) continue;
      if (!surfaceFullyCoversPathInThisPack(result, node.path)) hasUnservedRelatedNode = true;
      add(node.path);
    }
    // Nothing in the related cluster is worth another round trip: every node
    // this response could name already amounts to a whole-file serve.
    if (!hasUnservedRelatedNode) return undefined;
  }
  return paths.length < 2 ? undefined : { tool: "read_file", arguments: { mode: "task_pack", qref: result.qref, paths } };
}

export function discoveryBundleAdvisory(result: TaskPackResult): string | undefined {
  return discoveryBundleNext(result) === undefined ? undefined : "advisory: bundled paths are limited to files already related by served candidates or evidence edges";
}

/**
 * The single control-plane verdict projected onto task-pack wire fields.
 *
 * `route` is intentionally not an input to a terminal promotion: routes are
 * guidance and can be stale after trimming, qref replay, or receipt shaping.
 * A terminal decision therefore requires the contract's certificate instead.
 */
export type CanonicalTaskDecisionKind =
  | "discover"
  | "await-input"
  | "act-answer"
  | "act-edit"
  | "terminal-closed";

export interface CanonicalTaskDecision {
  kind: CanonicalTaskDecisionKind;
  next_call?: ContinuationCall;
  reason: string;
}

function isReadOnlyCall(value: unknown): value is ContinuationCall {
  if (value === null || typeof value !== "object") return false;
  const call = value as Partial<ContinuationCall>;
  return (call.tool === "read_file" || call.tool === "search_files")
    && call.arguments !== null
    && typeof call.arguments === "object";
}

function firstReadOnlyContinuation(result: TaskPackResult): ContinuationCall | undefined {
  const call = result.continuation?.stages[0]?.calls[0];
  return isReadOnlyCall(call) ? call : undefined;
}

/** Prefer a served document's disclosed next range over a lexical re-search. */
function servedZoomSuppressed(result: TaskPackResult, handle: string, range: string): boolean {
  const entries = (result as TaskPackResult & { served_zoom_suppressed?: unknown }).served_zoom_suppressed;
  return Array.isArray(entries) && entries.includes(JSON.stringify([handle, range]));
}

function servedDocumentZoom(result: TaskPackResult): ContinuationCall | undefined {
  const candidates = result.surfaces
    .map((surface) => ({
      surface,
      range: (surface as { remaining_ranges?: unknown }).remaining_ranges,
    }))
    .filter((item): item is { surface: TaskPackResult["surfaces"][number]; range: unknown[] } =>
      Array.isArray(item.range)
      && (!semanticFrontierGuardEnabled() || !isSemanticFrontierContinuationOptional(item.surface))
      && typeof (item.surface as { handle?: unknown }).handle === "string"
      && item.range.some((value) =>
        typeof value === "string"
        && !servedZoomSuppressed(
          result,
          String((item.surface as { handle?: unknown }).handle),
          value,
        ))
    )
    .sort((a, b) => {
      const aDoc = /\.(?:md|markdown|mdx)$/iu.test((a.surface as { path?: string }).path ?? "") ? 0 : 1;
      const bDoc = /\.(?:md|markdown|mdx)$/iu.test((b.surface as { path?: string }).path ?? "") ? 0 : 1;
      return aDoc - bDoc;
    });
  const selected = candidates[0];
  if (selected === undefined) return undefined;
  const handle = (selected.surface as { handle: string }).handle;
  const range = selected.range.find((value): value is string =>
    typeof value === "string" && !servedZoomSuppressed(result, handle, value),
  );
  if (range === undefined) return undefined;
  return { tool: "read_file", arguments: { handle, range } };
}
/**
 * P0a §6.1: a prepared decision is bound to a certificate either by carrying
 * the full proof or by naming its id in the typestate. The compact
 * `pack_unchanged` receipt is the second form — it re-serves a decision whose
 * certificate was already issued and whose working set is proved unchanged by
 * `workspace_state`, and paying the full certificate's bytes again on a
 * sub-1KB receipt would defeat the receipt. Both forms project the SAME lean
 * `certificate` field on the wire (see projectLeanExecutionContract).
 */
export function hasCertificateBinding(contract: TaskExecutionContract): boolean {
  return contract.readiness_certificate !== undefined
    || contract.typestate.certificate_id !== undefined;
}

function certificateIdOf(contract: TaskExecutionContract): string | undefined {
  return contract.readiness_certificate?.id ?? contract.typestate.certificate_id;
}

function hasCertificateForTerminal(contract: TaskExecutionContract): boolean {
  return contract.state === "ready"
    && contract.discovery_complete
    && hasCertificateBinding(contract)
    && (contract.next_action === "answer" || contract.next_action === "edit");
}

// F-B3 (2026-08-27, v0.12 wave B3, DESIGN-v0.12-plan.md §2 柱B row B3).
//
// readCodeTaskPack.ts's `dedupeTrimAndPersist` ("V11-03 SECOND SEAM") can
// append an `unserved-obligation:<path> (...)` entry to `result.missing`
// AFTER `execution_contract` was already built and certified — the seam's
// own doc comment records this as deliberate: re-running
// `buildTaskExecutionContract`/its `capability_gaps` computation sits in
// "the receipt/certificate territory this workstream does not touch", and a
// fully re-certified in-pack reconciliation was judged to need pipeline
// restructuring (recorded as finding F-B3 instead of attempted inline).
//
// Matches ONLY the exact marker the seam writes (obligations threaded from
// priorPackStore.ts's `PriorObligationRecord`s via `queryPriorPackObligations`)
// — a narrow, same-call staleness detector, not a general "does this pack
// have any missing entry" check.
const UNSERVED_PRIOR_PACK_OBLIGATION_RE = /^unserved-obligation:(.+?) \(/;

function unservedPriorPackObligationZoom(result: TaskPackResult): ContinuationCall | undefined {
  if (!Array.isArray(result.missing)) return undefined;
  for (const entry of result.missing) {
    if (typeof entry !== "string") continue;
    const match = UNSERVED_PRIOR_PACK_OBLIGATION_RE.exec(entry);
    const obligationPath = match?.[1];
    if (obligationPath !== undefined && obligationPath.length > 0) {
      return { tool: "read_file", arguments: { path: obligationPath } };
    }
  }
  return undefined;
}

function hasUnservedPriorPackObligation(result: TaskPackResult): boolean {
  return unservedPriorPackObligationZoom(result) !== undefined;
}

// P0 defect 2/3 (2026-08-27) — F-B3's family, widened from SAME-CALL to
// SAME-EPOCH-AGAINST-PERSISTED-CONTRACT.
//
// F-B3's own comment named its limit: "a narrow, same-call staleness detector,
// not a general 'does this pack have any missing entry' check", with the
// general fix "judged to need pipeline restructuring". readCodeTaskPack.ts's
// `reconcileEpochTaskContract` supplies the missing half — a task contract
// (required roles + concern tokens + source query) persisted at the first pack
// of an epoch in `taskContractStore.ts` — and discloses what a NARROWED
// continuation left unserved against it. This is the matching demotion: a
// certificate may not stand while the epoch's own standing requirements are
// open, exactly as it may not stand over a stale prior-pack obligation.
//
// Matches ONLY the two exact markers that reconciliation writes; every other
// `missing[]` entry (role names, byte-budget notes, unreadable caller paths)
// is untouched, so this stays as narrow as the detector it extends.
const UNSERVED_EPOCH_ROLE_RE = /^unserved-required-role:([^ ]+) \(.*query="(.*)" surfaceRoles=\["([^"]+)"\]\)$/;
const UNCOVERED_EPOCH_CONCERN_RE = /^uncovered-concern:([^ ]+) \(/;

function unservedEpochContractZoom(result: TaskPackResult): ContinuationCall | undefined {
  if (!Array.isArray(result.missing)) return undefined;
  for (const entry of result.missing) {
    if (typeof entry !== "string") continue;
    const role = UNSERVED_EPOCH_ROLE_RE.exec(entry);
    if (role !== null) {
      // The epoch's SOURCE query, restored from the marker — never this
      // narrowed call's own text, which is what let the universe shrink.
      return {
        tool: "read_file",
        arguments: { mode: "task_pack", query: role[2]!, surfaceRoles: [role[3]!] },
      };
    }
    const concern = UNCOVERED_EPOCH_CONCERN_RE.exec(entry);
    if (concern !== null) {
      return { tool: "search_files", arguments: { action: "find", query: concern[1]! } };
    }
  }
  return undefined;
}

function hasUnservedEpochContract(result: TaskPackResult): boolean {
  return unservedEpochContractZoom(result) !== undefined;
}

/**
 * DESIGN-v0.15 R1 (2026-09-07) / wave1-contract.md §3.4 — "the act→discover
 * demotion arbitration" seat this module owns for request items.
 *
 * `readCodeTaskPack.ts`'s `buildRequestItemReadiness` already folds each
 * explicit request item into the SAME obligation array `projectCompletion`
 * reads, so an uncovered point already keeps `discovery_complete` false —
 * `hasCertificateForTerminal` below never fires an `act.*` over it. This zoom
 * supplies the other half: a concrete, batched `next` for what is still
 * missing, computed with real workspace/candidate-path knowledge this
 * (fs-free) module does not have. Reads a plain, internal, non-wire field —
 * never a string marker parsed out of `missing[]` — because the batched call
 * already carries a `targets[]` array a regex could not safely round-trip.
 */
function unservedRequestItemZoom(result: TaskPackResult): ContinuationCall | undefined {
  return (result as TaskPackResult & { request_item_gap?: { next_call?: ContinuationCall } }).request_item_gap?.next_call;
}

function hasUnservedRequestItems(result: TaskPackResult): boolean {
  return unservedRequestItemZoom(result) !== undefined;
}

/**
 * A ready answer may name extra code affordances, but only an explicit
 * answer-route Markdown remainder is mandatory answer evidence. Keep this
 * narrower than servedDocumentZoom(): generic partial-code affordances remain
 * compatible with their established prepared contracts.
 */
function requiredAnswerDocumentZoom(result: TaskPackResult): ContinuationCall | undefined {
  if (
    result.route?.action !== "answer_from_handles"
    || (result.route.max_additional_tl_calls ?? 0) <= 0
  ) return undefined;
  const surface = result.surfaces.find((candidate) => {
    const value = candidate as { path?: unknown; handle?: unknown; remaining_ranges?: unknown };
    return typeof value.path === "string"
      && (!semanticFrontierGuardEnabled() || !isSemanticFrontierContinuationOptional(candidate))
      && /\.(?:md|markdown|mdx)$/iu.test(value.path)
      && typeof value.handle === "string"
      && Array.isArray(value.remaining_ranges)
      && typeof value.handle === "string"
      && value.remaining_ranges.some((range) =>
        typeof range === "string" && !servedZoomSuppressed(result, value.handle as string, range))
  }) as { handle: string; remaining_ranges: string[] } | undefined;
  if (surface === undefined) return undefined;
  const range = surface.remaining_ranges.find(
    (candidate) => !servedZoomSuppressed(result, surface.handle, candidate),
  );
  if (range === undefined) return undefined;
  return {
    tool: "read_file",
    arguments: { handle: surface.handle, range },
  };
}

/**
 * §3.4.1 / D1 (2026-08-07): the ONE sanctioned served-zoom affordance shape —
 * an answer route that has granted EXACTLY one zoom call over a required
 * surface THIS SAME response left partial. AGENTS.md states the intended
 * joint shape directly: "prepared+partial primary grants
 * `route.max_additional_tl_calls=1` — spend it on the served zoom", so this
 * IS an affordance, not missing evidence, and `prepared`/`act.answer` must
 * survive it. Shared by every site that could otherwise disagree about
 * whether this shape holds: readCodeTaskPack.ts's reconcileContentSufficiency
 * (must not downgrade the route just because the profile is answer) and its
 * buildTaskExecutionContract (must let the shape reach an accepted,
 * certificate-bearing contract), and this module's own
 * deriveCanonicalTaskDecision below (must not re-force `discover` on the
 * shape the certified gate just accepted).
 */
export function hasServedZoomAffordance(result: TaskPackResult): boolean {
  if (result.route?.action !== "answer_from_handles") return false;
  if ((result.route.max_additional_tl_calls ?? 0) !== 1) return false;
  return codeTaskPackSurfaces(result.surfaces).some((surface) =>
    surface.required !== false
    && (surface.content_completeness === "partial" || (surface.remaining_ranges?.length ?? 0) > 0));
}

/**
 * W9 (2026-08-22): is this pack's task read-only?
 *
 * Both spellings, for the same reason `projectTaskRef` reads both: a DECLARED
 * `taskProfile:"answer"` lands on `task_profile`, while §14's inference lands
 * on `profile_binding.selected`. Either way the value is the profile the pack
 * was actually BUILT with — the obligations, the route relabel and the
 * terminal action all derive from it — so it is the same authority the rest of
 * the pipeline uses, not a second guess at the caller's intent.
 */
function isReadOnlyAnswerPack(result: TaskPackResult): boolean {
  return result.task_profile === "answer" || result.profile_binding?.selected === "answer";
}

/** Exhaustive literal absence is decision-grade without inventing an evidence surface. */
export function decisionGradeLiteralAbsenceSubject(
  result: Pick<TaskPackResult, "coverage" | "literal_source_absence">,
  contract: TaskExecutionContract,
): string | undefined {
  const absence = result.literal_source_absence;
  const workspace = contract.workspace_state;
  const evidenceModel = contract.evidence_model;
  if (result.coverage !== "complete" || absence === undefined || workspace === undefined || evidenceModel === undefined) return undefined;
  const subject = absence.subject.trim();
  if (subject === ""
    || absence.role_source.trim() === ""
    || absence.scope.trim() === ""
    || !Number.isInteger(absence.scanned_paths)
    || absence.scanned_paths < 0
    || !Number.isInteger(absence.universe_paths)
    || absence.universe_paths < 0
    || !Number.isInteger(absence.excluded_paths)
    || absence.excluded_paths < 0
    || !Number.isInteger(absence.destination_occurrences)
    || absence.destination_occurrences < 0
    || !/^sha256:[a-f0-9]{64}$/.test(absence.universe_fingerprint)) return undefined;
  if (absence.universe_complete !== true
    || absence.scanned_paths !== absence.universe_paths
    || workspace.inventory_complete !== true
    || absence.universe_paths !== workspace.inventory_files) return undefined;
  const obligation = `literal-source-absent:${subject}`;
  if (!evidenceModel.claims.some((claim) => claim.id === obligation && claim.status === "supported")) return undefined;
  if (evidenceModel.unresolved.length > 0 || (contract.falsification?.unresolved.length ?? 0) > 0) return undefined;
  return subject;
}

/**
 * Derive one decision from contract evidence. In particular, an
 * `answer_from_handles` route can never promote a pack by itself.
 */
/**
 * The pre-W-DEMOTE derivation, unchanged. `deriveCanonicalTaskDecision`
 * below wraps it with the §10.0 `next` arbitration seat; every early-return
 * branch and its reasoning here stays exactly as written.
 */
function deriveCanonicalTaskDecisionRaw(result: TaskPackResult): CanonicalTaskDecision | undefined {
  const contract = result.execution_contract;
  if (contract === undefined) return undefined;

  if (contract.typestate.phase === "done" && contract.semantic_closure?.state === "closed") {
    return { kind: "terminal-closed", reason: "semantic closure receipt is closed" };
  }

  // Canonical decision construction is a producer-side, guard-neutral
  // statement of the available work.  Semantic-frontier suppression belongs
  // to the final wire projector, where it can compare the selected raw and
  // guarded calls and register a structured witness against the actual wire.
  // Applying it here can turn a viable raw bundle into await-input before that
  // attribution point, yielding neither an executable primary continuation
  // nor an honest suppression attestation.
  const canonicalNextAllowed = semanticFrontierNextAllowed(result, false);

  // A stale ready certificate must not hide the one remaining document range
  // that the answer route explicitly says is needed. This is intentionally
  // before certificate promotion, and intentionally Markdown-only.
  const requiredZoom = canonicalNextAllowed ? requiredAnswerDocumentZoom(result) : undefined;
  if (requiredZoom !== undefined) {
    return {
      kind: "discover",
      next_call: requiredZoom,
      reason: "answer evidence is partial; zoom the served document before answering",
    };
  }

  // F-B3: the same staleness `unservedPriorPackObligationZoom`'s doc comment
  // explains — a same-call reconciliation disclosure must demote THIS
  // response's own certificate, not just the next pack's. Scoped to
  // `phase === "prepared"` (a certificate exists to demote) and checked
  // BEFORE the certificate gate below, the same position
  // `requiredAnswerDocumentZoom` uses for the same reason: a stale ready
  // certificate must not hide evidence this same response already disclosed
  // as unserved.
  const staleObligationZoom = canonicalNextAllowed && contract.typestate.phase === "prepared"
    ? unservedPriorPackObligationZoom(result)
    : undefined;
  if (staleObligationZoom !== undefined) {
    return {
      kind: "discover",
      next_call: staleObligationZoom,
      reason: "an earlier pack in this task recorded an edit obligation this response's own reconciliation just found unserved; re-fetch it before treating this certificate as authoritative",
    };
  }

  // P0 defect 2/3: same position, same reason, one axis out — a certificate
  // certifies against THIS call's query, and this response has just disclosed
  // that the TASK still requires something no served evidence covers.
  //
  // Gated on a certificate BINDING rather than on `phase === "prepared"`
  // (F-B3's gate) because the terminal gate below is `hasCertificateForTerminal`,
  // which reads `state`/`discovery_complete`/binding and never reads the phase.
  // Gated on SOMETHING, though, and deliberately: a pack with no certificate is
  // already non-terminal, and hijacking its own evidence-grounded next_call for
  // a requirement this workspace may be unable to satisfy would trade a false
  // certification for a dead-end loop. Demoting only a certificate-bearing pack
  // costs exactly one turn in the worst case — the re-pack it names is either
  // satisfied or comes back uncertified, and an uncertified pack is not
  // demoted again.
  const epochContractZoom = canonicalNextAllowed && hasCertificateBinding(contract)
    ? unservedEpochContractZoom(result)
    : undefined;
  if (epochContractZoom !== undefined) {
    return {
      kind: "discover",
      next_call: epochContractZoom,
      reason: "an earlier pack in this task established a requirement no served evidence covers; close it against the task's own query before certifying this narrowed pack",
    };
  }

  // DESIGN-v0.15 R1 (wave1-contract.md §3.4): before the certificate → act
  // step, an explicit request item this pack's own query named — but served
  // plus prior-epoch evidence does not yet prove — always wins over an
  // otherwise-ready certificate. `discovery_complete` already reflects this
  // (buildRequestItemReadiness's obligations joined the same array
  // `projectCompletion` used), so `hasCertificateForTerminal` below would
  // already refuse; this supplies the concrete batched `next` instead of
  // falling through to the generic bundle/await-input fallback at the
  // bottom of this chain.
  const requestItemZoom = canonicalNextAllowed ? unservedRequestItemZoom(result) : undefined;
  if (requestItemZoom !== undefined) {
    return {
      kind: "discover",
      next_call: requestItemZoom,
      reason: "one or more explicit points of this request have no served evidence yet",
    };
  }

  if (decisionGradeLiteralAbsenceSubject(result, contract) !== undefined) {
    return {
      kind: "act-answer",
      reason: "the inventory-complete workspace proves the directed literal source is absent",
    };
  }

  if (hasCertificateForTerminal(contract)) {
    return {
      kind: contract.next_action === "answer" ? "act-answer" : "act-edit",
      reason: "readiness certificate authorizes the terminal action",
    };
  }

  // -------------------------------------------------------------------------
  // W9 (2026-08-22) — A READ-ONLY CANDIDATE LIST IS NOT A DEAD END.
  //
  // `choose-candidate` exists for EDIT SAFETY. With several plausible targets
  // and no dominant one, choosing FOR the caller risks editing the wrong file,
  // so readCodeTaskPack.ts deliberately suppresses every bounded fallback and
  // lands `awaiting-input` (the 2026-07-19a thrash fix; readinessSemantics.ts
  // pins it for the generic profile). That risk does not exist on a READ-ONLY
  // task: "which of these is it" is answered by reading all of them, and
  // `discoveryBundleNext` is exactly that call — one bounded re-pack over the
  // candidates THIS pack already served and ranked.
  //
  // Measured on the a4 m365-drive-mount repro (2026-08-22): the awaiting-input
  // arm made the caller invent the same re-pack by hand, without the `qref`,
  // with the paths copied out of the candidate list — a turn the server could
  // have named and did not.
  //
  // NARROW BY CONSTRUCTION. All four must hold, and each is load-bearing:
  //   1. `await_input_code === "choose-candidate"` — the CONTRACT's own marker
  //      of which branch decided (A.7.2 row 21), never re-derived from route or
  //      prose. `no-grounded-call-remains`, `name-intended-target` (tied
  //      concerns, which repository evidence provably cannot break) and
  //      `act-on-served-evidence` are all untouched.
  //   2. the pack's selected profile is `answer`. Edit/generic keep the fence
  //      exactly as it is — this is the edit-safety half, and it does not move.
  //   3. `discoveryBundleNext` can name a bundle at all: a live `qref` and >= 2
  //      candidate paths. It NEVER invents a path (the advisory it ships says
  //      so), so this cannot widen the frontier beyond what was served.
  //   4. phase is really awaiting-input, i.e. nothing above already promoted
  //      the pack to a certified terminal action.
  //
  // Deliberately AFTER the certificate gate and the required-document zoom, so
  // a pack that has earned `act.*` still gets it, and a partial answer document
  // is still zoomed first.
  // -------------------------------------------------------------------------
  if (
    contract.typestate.phase === "awaiting-input"
    && contract.await_input_code === "choose-candidate"
    && isReadOnlyAnswerPack(result)
  ) {
    const bundle = canonicalNextAllowed ? discoveryBundleNext(result, false) : undefined;
    if (bundle !== undefined) {
      return {
        kind: "discover",
        next_call: bundle,
        reason: "read-only candidate list: re-pack every served candidate in one bounded call instead of asking which to read",
      };
    }
  }

  // An awaiting-input decision is authoritative over any stale continuation
  // that a receipt or post-trim branch left behind.
  if (
    contract.typestate.phase === "awaiting-input"
    || contract.semantic_closure?.state === "awaiting-input"
  ) {
    return { kind: "await-input", reason: contract.reason };
  }

  const routeClaimsAnswer = result.route?.action === "answer_from_handles";
  const zoom = canonicalNextAllowed ? servedDocumentZoom(result) : undefined;
  // The certified gate above is where the sanctioned served-zoom affordance
  // (hasServedZoomAffordance) is meant to land `act-answer` — with a real
  // certificate. Reaching here means it did not (no certificate, or the
  // affordance genuinely does not hold), so only force `discover` when the
  // affordance is NOT what is blocking it; otherwise fall through to the
  // shape below, which can still name the same zoom call without mislabeling
  // a starved OTHER surface as "the document is partial".
  if (routeClaimsAnswer && zoom !== undefined && !hasServedZoomAffordance(result)) {
    return {
      kind: "discover",
      next_call: zoom,
      reason: "answer evidence is partial; zoom the served document before answering",
    };
  }

  const next = canonicalNextAllowed ? discoveryBundleNext(result, false)
    ?? sanitizeSemanticFrontierNext(result, isReadOnlyCall(contract.next_call)
      ? contract.next_call
      : firstReadOnlyContinuation(result), false)
    : undefined;
  if (next !== undefined) {
    return { kind: "discover", next_call: next, reason: contract.reason };
  }

  // Missing proof without a bounded evidence call must never fall through to
  // answer/edit. Asking for a decision is the conservative, fail-closed exit.
  return { kind: "await-input", reason: contract.reason };
}

/**
 * The canonical decision, with the §10.0 `next` arbitration seat applied.
 * `sfDemoteEnabled()` off (the default) makes this byte-identical to
 * `deriveCanonicalTaskDecisionRaw` — `applySemanticFrontierNextArbitration`'s
 * first statement is that exact flag check.
 */
export function deriveCanonicalTaskDecision(result: TaskPackResult): CanonicalTaskDecision | undefined {
  return applySemanticFrontierNextArbitration(result, deriveCanonicalTaskDecisionRaw(result));
}

function planFor(call: ContinuationCall): ContinuationPlan | undefined {
  return enforceContinuationBudget({
    version: 1,
    stages: [{ execution: "sequential", calls: [call] }],
  });
}

function clearDiscoveryProjection(result: TaskPackResult, contract: TaskExecutionContract): void {
  delete contract.next_call;
  contract.max_additional_discovery_calls = 0;
  if (contract.call_budget !== undefined) {
    contract.call_budget = {
      ...contract.call_budget,
      discovery_allowed: false,
      candidate_call: undefined,
    };
  }
  delete result.continuation;
  if (result.next?.tool === "read_file" || result.next?.tool === "search_files") {
    delete result.next;
  }
}

function applyDiscoverDecision(
  result: TaskPackResult,
  contract: TaskExecutionContract,
  decision: CanonicalTaskDecision,
): void {
  const call = decision.next_call;
  if (call === undefined) return;
  const plan = planFor(call);
  if (plan === undefined) return;
  result.continuation = plan;
  result.next = call;
  contract.state = "needs-followup";
  contract.readiness = "needs-followup";
  contract.discovery_complete = false;
  contract.next_action = "followup";
  contract.max_additional_discovery_calls = 1;
  delete contract.readiness_certificate;
  // W9: `await_input_code` marks WHICH awaiting-input branch decided, so it is
  // meaningless once the decision is `discover` — and actively misleading,
  // since `projectTaskDecision` reads it on the await arm. A contract that has
  // just been re-projected onto discovery must not keep claiming a pending
  // human choice.
  delete contract.await_input_code;
  contract.typestate = {
    phase: "discovery",
    allowed_actions: ["read", "search"],
    challenge_required_for: [],
  };
  contract.next_call = call;
  if (contract.call_budget !== undefined) {
    contract.call_budget = {
      ...contract.call_budget,
      discovery_allowed: true,
      candidate_call: call,
    };
  }
  if (contract.semantic_closure !== undefined) {
    contract.semantic_closure = {
      ...contract.semantic_closure,
      state: "open",
    };
  }
  result.route = {
    action: call.tool === "read_file" ? "inspect_handles" : "locate_missing_surfaces",
    reason: decision.reason,
    max_additional_tl_calls: 1,
  };
}

function applyAwaitInputDecision(result: TaskPackResult, contract: TaskExecutionContract, decision: CanonicalTaskDecision): void {
  clearDiscoveryProjection(result, contract);
  contract.state = "needs-followup";
  contract.discovery_complete = false;
  contract.next_action = contract.next_action === "answer" || contract.next_action === "edit"
    ? contract.next_action
    : "request-user-input";
  const retainedActions = contract.typestate.allowed_actions.filter(
    (action) => action === "answer" || action === "edit",
  );
  // A contract that still NAMES a terminal next_action but forbids it in
  // allowed_actions is itself a §6.1 contradiction — and it is the exact
  // shape the 2026-07-25 T13 forensics called a dead end ("request user
  // input" with no way to act on evidence the caller already holds). Keep
  // the named terminal action reachable.
  const terminalNextAction = contract.next_action === "answer" || contract.next_action === "edit"
    ? [contract.next_action]
    : [];
  contract.typestate = {
    phase: "awaiting-input",
    allowed_actions: [...new Set<TaskExecutionContract["typestate"]["allowed_actions"][number]>([
      ...retainedActions,
      ...terminalNextAction,
      "request-user-input",
    ])],
    challenge_required_for: [],
  };
  if (contract.semantic_closure !== undefined) {
    contract.semantic_closure = {
      ...contract.semantic_closure,
      state: "awaiting-input",
    };
  }
  result.route = {
    action: "confirm_candidates",
    reason: decision.reason,
    max_additional_tl_calls: 0,
  };
}

function applyTerminalDecision(
  result: TaskPackResult,
  contract: TaskExecutionContract,
  decision: CanonicalTaskDecision,
): void {
  const terminalAction = decision.kind === "act-answer" ? "answer" : "edit";
  clearDiscoveryProjection(result, contract);
  contract.state = "ready";
  contract.readiness = terminalAction === "answer" ? "answer-ready" : "edit-ready";
  contract.discovery_complete = true;
  contract.next_action = terminalAction;
  const retainedActions = contract.typestate.allowed_actions.filter(
    (action) => action === "answer" || action === "edit" || action === "challenge",
  );
  const certificateId = certificateIdOf(contract);
  contract.typestate = {
    phase: "prepared",
    ...(certificateId !== undefined ? { certificate_id: certificateId } : {}),
    allowed_actions: [...new Set<TaskExecutionContract["typestate"]["allowed_actions"][number]>([
      ...retainedActions,
      terminalAction,
      "challenge",
    ])],
    challenge_required_for: ["read", "search"],
  };
  if (contract.semantic_closure !== undefined) {
    contract.semantic_closure = {
      ...contract.semantic_closure,
      state: "closed",
      unresolved: [],
    };
  }
  result.route = {
    action: terminalAction === "answer" ? "answer_from_handles" : "edit_from_handles",
    reason: result.route?.reason ?? decision.reason,
    max_additional_tl_calls: 0,
  };
}

/**
 * A closed semantic receipt is terminal: it cannot simultaneously owe a
 * follow-up, and its route must name the one action the closed proof
 * authorizes rather than whatever the pre-closure branch happened to leave
 * behind (the §6.1 contradiction this fence exists to remove).
 */
function applyTerminalClosedDecision(
  result: TaskPackResult,
  contract: TaskExecutionContract,
  decision: CanonicalTaskDecision,
): void {
  clearDiscoveryProjection(result, contract);
  const terminalAction = contract.next_action === "edit" ? "edit" : "answer";
  contract.state = "ready";
  contract.readiness = terminalAction === "answer" ? "answer-ready" : "edit-ready";
  contract.discovery_complete = true;
  contract.next_action = terminalAction;
  const certificateId = certificateIdOf(contract);
  contract.typestate = {
    phase: "done",
    ...(certificateId !== undefined ? { certificate_id: certificateId } : {}),
    allowed_actions: [terminalAction],
    challenge_required_for: [],
  };
  if (contract.semantic_closure !== undefined) {
    contract.semantic_closure = { ...contract.semantic_closure, state: "closed", unresolved: [] };
  }
  result.route = {
    action: terminalAction === "answer" ? "answer_from_handles" : "edit_from_handles",
    reason: result.route?.reason ?? decision.reason,
    max_additional_tl_calls: 0,
  };
}

/**
 * PI-02 / F-A1-1 repair: a LIVE `discover` decision that still carries
 * capability gaps, WHILE A REQUIRED ROLE IS STILL MISSING (`result.missing`
 * non-empty — DESIGN-v0.8 §A4's coverage determinant), is itself proof
 * `coverage:"complete"` was wrong — the gaps ARE the outstanding work the
 * "complete" claim says does not exist (see the matching rule in
 * `canonicalTaskDecisionInvariantViolations`, which this repair exactly
 * mirrors, including the blocking/optional discriminator and why it is
 * `missing`, not the gap's own kind). Demote coverage to the truthful lesser
 * value. Never delete the gaps/next that justify the demotion — they are the
 * caller's only route to actually closing the pack — and never upgrade the
 * decision to make the contradiction disappear.
 *
 * A gap that exists only because a readiness-certificate proof obligation is
 * unsatisfied (every required role already found; plan item 5's
 * "optional_followups") is explicitly OUT of scope here — demoting THAT
 * shape would itself be a false "a required role was never found" claim.
 */
function repairCompleteCoverageWithGaps(
  result: TaskPackResult,
  contract: TaskExecutionContract,
  decision: CanonicalTaskDecision,
): void {
  if (
    result.coverage === "complete"
    && (contract.capability_gaps?.length ?? 0) > 0
    && decision.kind === "discover"
  ) {
    // "partial" is the truthful lesser value (DESIGN-v0.8 coverage-honesty:
    // "focused" claims a single confident site with no fan-out, which an
    // open capability gap contradicts just as much as "complete" does).
    // `coverage_reason`'s five-value vocabulary does not map cleanly onto a
    // capability-gap kind, so none is fabricated here; an already-truthful
    // value the shape happens to carry (rare — a "complete" pack does not
    // normally carry one) is left untouched rather than cleared.
    result.coverage = "partial";
  }
  // F-B3: same coverage-honesty repair, keyed off the stale prior-pack
  // obligation `deriveCanonicalTaskDecision` demoted to `discover` above,
  // instead of `capability_gaps` — V11-03's seam never touches
  // capability_gaps, only `result.missing` and priorPackStore's own state
  // (see the seam's doc comment in dedupeTrimAndPersist).
  if (
    result.coverage === "complete"
    && decision.kind === "discover"
    && hasUnservedPriorPackObligation(result)
  ) {
    result.coverage = "partial";
  }
  // P0 defect 2/3: the same repair for the epoch-contract disclosure.
  // `reconcileEpochTaskContract` already lowers coverage where it runs; this
  // keeps the invariant true for any OTHER path that reaches the exit carrying
  // the marker (a receipt/fallback envelope rebuilt after that reconciliation).
  if (
    result.coverage === "complete"
    && decision.kind === "discover"
    && hasUnservedEpochContract(result)
  ) {
    result.coverage = "partial";
  }
  // DESIGN-v0.15 R1: same coverage-honesty repair for an uncovered request
  // item. `buildRequestItemReadiness` already demotes `coverage` via the
  // normal obligation path in the common case (its obligations join the same
  // array `projectCompletion` reads before this pack's own coverage is set);
  // this only guards a rebuilt/repaired envelope that reaches this exit with
  // a stale "complete" alongside the still-pending gap.
  if (
    result.coverage === "complete"
    && decision.kind === "discover"
    && hasUnservedRequestItems(result)
  ) {
    result.coverage = "partial";
  }
}

/** Apply the canonical decision at the shared task-pack exit. */
export function applyCanonicalTaskDecision(result: TaskPackResult): CanonicalTaskDecision | undefined {
  // W-DEMOTE: mark demotion-eligible surfaces BEFORE this task-pack response
  // reaches server.ts's decisionWire.ts projectEvidence call, which reads
  // these marks off the same surface objects but cannot derive them itself
  // (it never receives the whole `result`, only `result.surfaces`).
  markSemanticFrontierDemotionEligibility(result);
  const decision = deriveCanonicalTaskDecision(result);
  const contract = result.execution_contract;
  if (decision === undefined || contract === undefined) return decision;

  // D8 (FX-R3c): the arbitrated call is assigned BEFORE the coherence gate
  // below, because a coherent pack is exactly the case where that gate
  // discards it. Only the one field moves — no discovery re-projection, no
  // typestate change — and only for a `discover` decision under the same flag
  // that gated arbitration in the first place.
  const arbitrated = sfArbitratedNextCall.get(result);
  if (arbitrated !== undefined && decision.kind === "discover" && decision.next_call === arbitrated) {
    contract.next_call = arbitrated;
    result.next = arbitrated;
  }

  // Most established exits are already internally coherent. Restrict mutation
  // to an actual control-plane contradiction so compact legacy receipts retain
  // their wire compatibility; the shared exit still gives every new/repaired
  // shape the same decision projection.
  //
  // P0a §6.1 (2026-08-13): the repair trigger is now EXACTLY the runtime
  // invariant oracle (plus the one soft demotion the oracle deliberately does
  // not encode). Deriving it from the oracle is what makes the dispatcher
  // fence total: every shape the oracle can flag is a shape this function
  // repairs, so `enforceCanonicalTaskDecisionAtExit` converges instead of
  // reporting an unrepairable violation.
  //
  // W9 (2026-08-22) adds the third term, on the same footing as the second: a
  // repair trigger the ORACLE deliberately does not encode. An awaiting-input
  // contract carrying no call is not a protocol violation — it is a coherent
  // shape, which is exactly why the oracle stays silent about it. What is
  // incoherent is shipping it AFTER the derivation above has decided the pack
  // should discover: the contract would keep phase `awaiting-input` while the
  // wire said `discover`, re-creating the §6.1 "two incompatible orders in one
  // response" class this fence exists to remove. The condition is the
  // disagreement itself, so it is self-gating: no disagreement, no repair.
  const needsRepair =
    canonicalTaskDecisionInvariantViolations(result).length > 0
    || (contract.typestate.phase === "prepared" && requiredAnswerDocumentZoom(result) !== undefined)
    || (contract.typestate.phase === "awaiting-input" && decision.kind === "discover");
  if (!needsRepair) return decision;

  // F-A1-1: a coverage-honesty repair, orthogonal to the decision-shape
  // repairs below (it touches `result.coverage` only) and self-gated on the
  // exact contradiction it addresses, so it is a no-op for every OTHER
  // needsRepair trigger.
  repairCompleteCoverageWithGaps(result, contract, decision);

  if (decision.kind === "discover") applyDiscoverDecision(result, contract, decision);
  else if (decision.kind === "await-input") applyAwaitInputDecision(result, contract, decision);
  else if (decision.kind === "act-answer" || decision.kind === "act-edit") {
    applyTerminalDecision(result, contract, decision);
  } else {
    applyTerminalClosedDecision(result, contract, decision);
  }
  return decision;
}

/** Outcome of one shared-exit invariant enforcement. */
export interface CanonicalDecisionFenceReport {
  /** Violations observed BEFORE the repair; empty means the exit was already coherent. */
  violations: string[];
  /** Violations that survived the repair — always empty unless the normalizer cannot converge. */
  residual: string[];
  repaired: boolean;
}

/**
 * P0a §6.1 single fence. Run this on EVERY task-pack-shaped response exit
 * (initial pack, qref re-pack, `pack_unchanged`/semantic-duplicate receipt,
 * byte-budget fallback, and the dispatcher's post-processing rewrites) right
 * before the wire projection. It is idempotent: a coherent response is
 * returned untouched, so the in-build applications stay valid and receipts
 * keep their pinned bytes.
 */
export function enforceCanonicalTaskDecisionAtExit(result: TaskPackResult): CanonicalDecisionFenceReport {
  // The dispatcher hands this an untyped response record, so prove the shape
  // before the decision derivation walks `surfaces`. A response with no
  // contract has no decision to project, and a non-pack shape is not ours.
  if (result?.execution_contract === undefined || !Array.isArray(result.surfaces)) {
    return { violations: [], residual: [], repaired: false };
  }
  const violations = canonicalTaskDecisionInvariantViolations(result);
  applyCanonicalTaskDecision(result);
  const residual = canonicalTaskDecisionInvariantViolations(result);
  return { violations, residual, repaired: violations.length > 0 };
}

/** Compact property-test oracle for every task-pack exit projection. */
export function canonicalTaskDecisionInvariantViolations(result: TaskPackResult): string[] {
  const contract = result.execution_contract;
  if (contract === undefined) return [];
  const violations: string[] = [];
  const phase = contract.typestate.phase;
  const hasCertificate = hasCertificateBinding(contract);
  const hasReadOnlyContinuation = result.continuation?.stages.some((stage) =>
    stage.calls.some((call) => isReadOnlyCall(call)),
  ) === true;

  if (result.route?.action === "answer_from_handles") {
    // The route is a PROJECTION of the contract's own decision, so it may say
    // "answer from the handles you hold" exactly when the contract names
    // `answer` as its next action AND authorizes that action. Three phases can
    // satisfy that: `prepared` (with its certificate binding), `done` (a
    // closed semantic receipt already proved the answer), and `awaiting-input`
    // in the served-terminal grant, where the contract's own reason is "act on
    // the served evidence" and allowed_actions carries `answer` alongside
    // request-user-input.
    //
    // `discovery` NEVER can: its instruction to the agent is "run the single
    // next_call", so an answer route beside it is the §6.1 contradiction this
    // oracle exists to make impossible (observed on the dispatcher's
    // post-challenge revocation rewrite, which downgraded the contract to
    // discovery and left the route claiming a certified answer).
    const answerAuthorized = contract.next_action === "answer"
      && contract.typestate.allowed_actions.includes("answer");
    if (
      phase === "discovery"
      || !answerAuthorized
      || (phase === "prepared" && !hasCertificate)
    ) {
      violations.push("answer-route-requires-prepared-answer-certificate");
    }
  }
  // THE W3 CREATE-ROUTE EXEMPTION IS GONE ([R5-23] / ruling 6, 2026-08-14).
  // It used to add `&& result.create_target === undefined` here, so that a pack
  // which had RESOLVED a new-file target could sit in `discovery` while its
  // route said `edit_from_handles` — the contradiction the ruling names in so
  // many words: "today's server emits `discover` while separately handing the
  // caller a create instruction the decision that names it cannot express".
  // With `create_target` promoted onto `decision.act.edit` the decision CAN
  // express it, so a create pack that is genuinely ready no longer needs to
  // hide in `discovery`, and one that is NOT ready must not claim the edit
  // route. Either way the carve-out has nothing left to tolerate.
  if (
    result.route?.action === "edit_from_handles"
    && phase === "discovery"
  ) {
    // Same contradiction, edit side: "edit from the handles you hold" beside a
    // contract whose own instruction is "run the single next_call" leaves the
    // agent two incompatible orders in one response. The guide binds on phase,
    // so the route is the field that must move.
    violations.push("edit-route-forbids-discovery-phase");
  }
  if (phase === "prepared") {
    if (contract.state !== "ready" || !hasCertificate || contract.next_call !== undefined || hasReadOnlyContinuation) {
      violations.push("prepared-forbids-discovery-projection");
    }
    if (contract.typestate.allowed_actions.some((action) => action === "read" || action === "search")) {
      violations.push("prepared-forbids-read-search");
    }
  }
  if (phase === "discovery") {
    if (contract.state === "ready" || contract.next_call === undefined || !isReadOnlyCall(contract.next_call)) {
      violations.push("discovery-requires-one-readonly-next-call");
    }
    if (result.route?.action === "answer_from_handles") violations.push("discovery-forbids-answer-route");
  }
  if (phase === "awaiting-input") {
    if (contract.next_call !== undefined || hasReadOnlyContinuation) {
      violations.push("awaiting-input-forbids-automatic-discovery");
    }
  }
  if (contract.semantic_closure?.state === "closed" && phase !== "prepared" && phase !== "done") {
    violations.push("closed-semantic-closure-requires-terminal-phase");
  }
  if (phase === "done" && (contract.next_call !== undefined || hasReadOnlyContinuation)) {
    violations.push("done-forbids-continuation");
  }
  // PI-02 / F-A1-1 (2026-08-20, narrowed 2026-08-20 after a same-day
  // over-fire report): `coverage:"complete"` is model.ts's promise that
  // "every REQUIRED ROLE is covered AND every query concern is addressed —
  // trust it, edit directly" (DESIGN-v0.8 §A4: "coverage derives from
  // required roles only, not the surface budget"). `result.missing` is that
  // exact ledger — the required-role names nothing was ever found for
  // (readCodeTaskPack.ts's coverage computation clears an entry the moment a
  // surface fills the role). A LIVE `discover` decision that still carries
  // capability gaps is the opposite claim inside the SAME response ONLY when
  // `missing` is non-empty too: `discover` always names a concrete
  // `next_call` (D-1), `gaps` rides the wire only beside `discover` (D-4), so
  // "complete" beside "discover"+gaps+a real required-role omission asserts
  // both "nothing more is needed" and "a required role was never found" at
  // once — the plan's own item 3 ("required omissionがあるのにcompleteとなる
  // response 0件", DESIGN-v0.10-expansion-plan-v1.3.md L1151).
  //
  // Deliberately NOT flagged (plan L1122, item 5 — "coverage=complete と
  // optional_followupsの併存は許す"): a `capability_gaps` entry whose OWN
  // existence has nothing to do with role identification — e.g. a
  // readiness-certificate proof obligation ("surface-content": more of an
  // ALREADY-IDENTIFIED surface's body could still be embedded) — while every
  // required role already has a surface (`missing:[]`). v0.10 ships no
  // separate `blocking_gaps`/`optional_followups` wire field (reconciliation
  // §5 D-1 keeps the one `gaps` field for both), so `result.missing` is
  // today's only truthful, domain-grounded way to tell the two apart; the gap
  // KIND alone cannot (`readCodeTaskPack.spec.ts`'s "nothing required
  // missing... not partial-by-budget" and "...blocks edit_from_handles when
  // the edit body is partial" both carry `kind:"missing-evidence"`, the SAME
  // kind PI-02's own blocking fixture uses, with `missing:[]`). Also
  // deliberately NOT flagged: a `discover` decision with NO gaps (e.g.
  // `requiredAnswerDocumentZoom`'s Markdown zoom), and `coverage:"complete"`
  // beside a capability-gap-free contract in any other phase.
  //
  // `deriveCanonicalTaskDecision` — not a second, hand-rolled approximation
  // of it — remains the source of truth for "would this contract actually
  // project a discover decision" (a structural approximation drifting from
  // the real projector is how F-A1-1 happened in the first place).
  if (
    result.coverage === "complete"
    && (contract.capability_gaps?.length ?? 0) > 0
    && phase === "discovery"
  ) {
    violations.push("complete-coverage-forbids-discover-gaps");
  }
  // F-B3 (2026-08-27): the mirror of the check just above, for the OTHER
  // route to the same contradiction — a `prepared` certificate (not yet
  // re-derived) beside a same-call reconciliation that just disclosed an
  // unserved prior-pack edit obligation. `deriveCanonicalTaskDecision`
  // already demotes this shape to `discover` (see
  // `unservedPriorPackObligationZoom`'s call site above); this is the
  // matching oracle entry so `needsRepair` actually observes the
  // contradiction and `applyCanonicalTaskDecision` applies the demotion,
  // instead of silently deriving a corrected `decision` that nothing acts on
  // (`needsRepair` gates every mutation below on a violation existing here).
  if (
    phase === "prepared"
    && hasUnservedPriorPackObligation(result)
  ) {
    violations.push("prepared-certificate-forbids-unserved-obligation");
  }
  // P0 defect 2/3: the same oracle entry for the epoch-contract disclosure, so
  // `needsRepair` observes the contradiction and `applyCanonicalTaskDecision`
  // actually applies the demotion rather than deriving a corrected decision
  // nothing acts on. Keyed on the certificate binding the demotion itself is
  // keyed on, not on the phase, so the two cannot disagree about which shapes
  // are demotable.
  if (
    hasCertificateBinding(contract)
    && hasUnservedEpochContract(result)
  ) {
    violations.push("certificate-forbids-unserved-epoch-contract");
  }
  // DESIGN-v0.15 R1: a certificate must not stand while an explicit request
  // item this same pack extracted is still uncovered — the mirror of the
  // epoch-contract oracle entry above, for the per-pack (not cross-pack)
  // gap `buildRequestItemReadiness` records.
  if (
    hasCertificateBinding(contract)
    && hasUnservedRequestItems(result)
  ) {
    violations.push("certificate-forbids-unserved-request-item");
  }
  return violations;
}
