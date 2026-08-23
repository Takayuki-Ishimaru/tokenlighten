// ---------------------------------------------------------------------------
// coveragePacker.ts — V10-09 Adaptive Context Pack / obligation-aware
// coverage-per-token packer v1.
//
// NORMATIVE SOURCE: DESIGN-v0.10-expansion-plan-v1.3.md §V10-09
// ("Adaptive Context Pack + Obligation-aware Coverage-per-Token Packer v1"),
// bounded by DESIGN-v0.10-expansion-plan-reconciliation.md §3 (Protocol v1
// freeze) and D-1 of §5.
//
// WHAT THIS MODULE IS
// -------------------
// A PURE selection function. Given a ranked candidate pool plus the task's
// own state (open obligations, concerns, required roles/locations, the
// served-range ledger, and a byte budget), it chooses which surfaces to serve
// so that the task's distinct roles and open obligations are covered at the
// smallest byte cost — instead of packing candidates relevance-first until the
// budget runs out.
//
// WHAT THIS MODULE IS NOT
// -----------------------
//  * It is NOT a wire object. `ContextLevel`, `CoverageState`, and every type
//    below are INTERNAL domain types (reconciliation §3, D-1). Nothing here is
//    serialized: wire continuation stays `limit.next` / `evidence[].remaining`
//    / `decision.gaps` exactly as frozen, and no new response kind or field is
//    introduced by this file.
//  * It is NOT the budget ladder. `protocol/budget/ladder.ts` keeps its own
//    per-kind required sets and runs AFTER this selection, on the assembled
//    response. This module only decides what enters the response in the first
//    place; it never weakens a downstream required set.
//  * It does NO I/O, reads no clock, and has no module-level mutable state.
//    Identical input ⇒ identical output, byte for byte (pinned by
//    `coveragePacker.spec.ts`).
//
// ADVISORY-POSTURE FENCE
// ----------------------
// This module deliberately does NOT import `task-state/reasoningIr`, directly
// or transitively. The reasoning IR is an advisory projection; a packer that
// consumed it would make an advisory surface load-bearing for what gets
// served. Obligations, concerns, and the served ledger are consumed DIRECTLY,
// as plain structural inputs supplied by the caller. `coveragePacker.spec.ts`
// pins the absence of that import.
//
// HONESTY INVARIANT
// -----------------
// The packer never manufactures a false "complete". `complete` is true only
// when every required role is covered, every open required obligation is met,
// and the direct-reference inventory survived intact. Any residual gap leaves
// `complete: false`, which the caller must render as a partial pack carrying
// an executable `next` (the existing next generators; this module does not
// invent one).
// ---------------------------------------------------------------------------

/**
 * Internal context level (V10-09 "context levelをL0/L1/L2/L3へ統一する").
 *
 *  * `L0` Identity — handles, paths, and symbol names only. No bodies. Chosen
 *    when the client already holds the content (ledger) or the budget cannot
 *    fund a single body.
 *  * `L1` Interface — signatures / declaration windows. Enough to answer or to
 *    wire a call, not enough to rewrite a body.
 *  * `L2` Implementation — the bodies a write actually needs. The default
 *    whenever there is a write frontier or an open obligation.
 *  * `L3` Extended — implementation plus its verification and configuration
 *    neighbourhood, for multi-obligation change tasks with budget to spare.
 *
 * INTERNAL ONLY. No wire field carries this value.
 */
export type ContextLevel = "L0" | "L1" | "L2" | "L3";

/** One candidate competing for a place in the served set. Structural by design: the caller projects its own candidate type onto this shape. */
export interface CoverageCandidate {
  /** Stable identity within one pack. Ties are broken on `rank` then `id`, so this must be unique per candidate. */
  readonly id: string;
  readonly path: string;
  /** Surface role ("contract" | "api" | "domain" | … ). Free-form so the packer never has to be re-released when the role vocabulary grows. */
  readonly role: string;
  /** Original best-first position in the caller's ranked list. Lower is better; used as the primary deterministic tie-break. */
  readonly rank: number;
  /** Relevance in [0,1]. Values outside the range are clamped. */
  readonly confidence: number;
  /** Estimated serialized cost of serving this candidate WITH a body. */
  readonly bytes: number;
  /** A direct reference: the query, an explicit path, or an obligation names this location. Direct candidates are shed-forbidden. */
  readonly direct?: boolean;
  /** The caller explicitly asked for this location. Shed-forbidden. */
  readonly explicit?: boolean;
  /** Strength of the evidence behind this candidate in [0,1]. Defaults to `confidence`. */
  readonly evidenceStrength?: number;
  /** This location is inside the writable edit frontier. */
  readonly editFrontier?: boolean;
  /** Value of this candidate as verification evidence (tests, fixtures) in [0,1]. */
  readonly verificationValue?: number;
  /** The served-range ledger says this window is already in the client's context. */
  readonly priorServed?: boolean;
  /** Obligation ids this candidate is known to serve, in addition to any path/role match. */
  readonly obligationIds?: readonly string[];
  /** Concern tokens this candidate carries (from its path, symbol, or match reason). */
  readonly concernTokens?: readonly string[];
}

/** One obligation from the task's `change_contract`, consumed directly (never via the advisory reasoning IR). */
export interface CoverageObligation {
  readonly id: string;
  /** False once the obligation is discharged; only open obligations drive selection. */
  readonly open: boolean;
  /** A required obligation must be met for the pack to be `complete`. Defaults to true. */
  readonly required?: boolean;
  /** Roles that can satisfy this obligation. */
  readonly roles?: readonly string[];
  /** REQUIRED LOCATIONS. A candidate whose path appears here is shed-forbidden and exempt from the diversity/redundancy penalty. */
  readonly paths?: readonly string[];
}

/** One concern clause from the query (the `ConcernGroup` shape, projected). */
export interface CoverageConcern {
  readonly id: string;
  readonly tokens: readonly string[];
}

/** Everything the packer needs. Pure input — the caller resolves the ledger and the budget before calling. */
export interface CoveragePackerInput {
  readonly candidates: readonly CoverageCandidate[];
  /** Roles the task requires. Exempt from the diversity/redundancy penalty and swept for at the end. */
  readonly requiredRoles?: readonly string[];
  /** Locations the task requires. Same exemption as `requiredRoles`. */
  readonly requiredPaths?: readonly string[];
  readonly obligations?: readonly CoverageObligation[];
  readonly concerns?: readonly CoverageConcern[];
  /** Byte budget for BODY-bearing surfaces. Filling it is explicitly not a goal. */
  readonly byteBudget: number;
  /** Hard cap on body-bearing surfaces. Defaults to the level's own quota. */
  readonly bodyQuota?: number;
  /** Force a level instead of deriving one (tests, and callers that already decided). */
  readonly level?: ContextLevel;
  /** True when the task will write — pushes the level to L2/L3. */
  readonly hasWriteFrontier?: boolean;
  /** Declared task profile. Only `"answer"` is load-bearing (read-only ⇒ interface level is usually enough). */
  readonly profile?: string;
}

/** One chosen body-bearing surface, with the reason it won its place. */
export interface CoverageSelection {
  readonly candidate: CoverageCandidate;
  /** Utility at the moment of selection. Forced picks carry their computed utility too, so ordering stays inspectable. */
  readonly utility: number;
  /** How this candidate entered the set. */
  readonly reason: "shed-forbidden" | "coverage" | "required-role-sweep";
  readonly newRoles: readonly string[];
  readonly newObligations: readonly string[];
  readonly newConcerns: readonly string[];
}

/** Why the greedy loop stopped. `saturated` is the good one: coverage closed before the budget did. */
export type CoverageStopReason = "saturated" | "budget" | "quota" | "exhausted";

/** The packer's verdict. INTERNAL — projected by the caller onto the frozen wire shapes. */
export interface CoveragePackerOutput {
  readonly level: ContextLevel;
  /** Body-bearing surfaces, in selection order. */
  readonly body: readonly CoverageSelection[];
  /** The COMPLETE direct-reference inventory, never dropped, in deterministic order. A superset of the direct entries in `body`. */
  readonly inventory: readonly CoverageCandidate[];
  readonly stopReason: CoverageStopReason;
  /** Summed `bytes` of `body`. */
  readonly bytes: number;
  readonly coveredRoles: readonly string[];
  readonly missingRequiredRoles: readonly string[];
  readonly unmetObligations: readonly string[];
  readonly uncoveredConcerns: readonly string[];
  /** True only when nothing required is missing. A false value MUST become a partial pack carrying an executable next. */
  readonly complete: boolean;
  /** False when the direct-reference inventory could not be carried whole. */
  readonly inventoryComplete: boolean;
}

// ---------------------------------------------------------------------------
// Utility weights
//
// Signs follow V10-09 verbatim:
//   relevance + newly-covered-obligations + surface-role diversity
//   + evidence strength + edit-frontier membership + verification value
//   - redundancy - bytes
//
// Obligation coverage outweighs raw relevance on purpose: that inversion IS
// the feature. Every term is normalized to [0,1] before weighting, so the
// weights below are directly comparable.
// ---------------------------------------------------------------------------

const W_RELEVANCE = 1;
const W_OBLIGATION = 2;
const W_ROLE_DIVERSITY = 1.5;
const W_EVIDENCE = 0.5;
const W_EDIT_FRONTIER = 1.25;
const W_VERIFICATION = 0.5;
const W_REDUNDANCY = 1.5;
const W_BYTES = 1;

/** Utilities closer than this are a tie, and fall through to the deterministic (rank, id) order. Mirrors the confidence epsilon the locator's own comparator uses. */
const UTILITY_EPSILON = 1e-6;

/** Body-surface quota per level. L0 serves identity only, so it funds no body at all. */
const LEVEL_BODY_QUOTA: Record<ContextLevel, number> = {
  L0: 0,
  L1: 3,
  L2: 4,
  L3: 6,
};

/** Below this many bytes no body fits worth serving, so the level collapses to identity. */
const IDENTITY_BUDGET_FLOOR = 512;
/** Above this the extended level may fund verification/config neighbours. */
const EXTENDED_BUDGET_FLOOR = 8192;
/** An L3 pack is only worth its extra bytes when the task really is multi-obligation. */
const EXTENDED_OBLIGATION_FLOOR = 2;

// ---------------------------------------------------------------------------
// Internal coverage state (D-1: internal domain type, never a wire object)
// ---------------------------------------------------------------------------

export interface CoverageState {
  readonly coveredRoles: Set<string>;
  readonly coveredObligations: Set<string>;
  readonly coveredConcerns: Set<string>;
  readonly selectedPaths: Set<string>;
  bytesUsed: number;
}

/** A state in which nothing is covered yet — the state the first pick is scored against. */
export function emptyCoverageState(): CoverageState {
  return {
    coveredRoles: new Set<string>(),
    coveredObligations: new Set<string>(),
    coveredConcerns: new Set<string>(),
    selectedPaths: new Set<string>(),
    bytesUsed: 0,
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function normalizedRole(role: string): string {
  return role.trim().toLowerCase();
}

function normalizedToken(token: string): string {
  return token.trim().toLowerCase();
}

/** Deterministic order for anything the packer reports as a set. */
function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

// ---------------------------------------------------------------------------
// Level selection
// ---------------------------------------------------------------------------

/**
 * Choose the internal context level from query/profile shape, write frontier,
 * confidence, budget, the served ledger, and the open obligations — the six
 * inputs V10-09 names. Deterministic ladder, evaluated top-down.
 *
 * INTERNAL: the returned value never reaches the wire.
 */
export function selectContextLevel(input: CoveragePackerInput): ContextLevel {
  if (input.level !== undefined) return input.level;

  const candidates = input.candidates;
  const openObligations = (input.obligations ?? []).filter((o) => o.open);
  const requiredRoles = (input.requiredRoles ?? []).map(normalizedRole);

  // Ledger first: when every candidate window is already in the client's
  // context, more bodies would only re-serve what it holds.
  const allPriorServed = candidates.length > 0 && candidates.every((c) => c.priorServed === true);
  if (allPriorServed) return "L0";

  // A budget that cannot fund one body cannot fund an implementation level.
  if (input.byteBudget < IDENTITY_BUDGET_FLOOR) return "L0";

  const writeFrontier = input.hasWriteFrontier === true
    || candidates.some((c) => c.editFrontier === true);

  // A declared read-only task with confident evidence and nothing to write is
  // answered at the interface level; implementation bodies are dead weight.
  const topConfidence = candidates.reduce((best, c) => Math.max(best, clamp01(c.confidence)), 0);
  if (!writeFrontier && input.profile === "answer" && topConfidence >= 0.6 && openObligations.length === 0) {
    return "L1";
  }

  // Nothing to write and nothing owed: interface level unless the evidence is
  // weak enough that the caller needs implementation to judge it.
  if (!writeFrontier && openObligations.length === 0 && requiredRoles.length <= 1 && topConfidence >= 0.6) {
    return "L1";
  }

  if (
    writeFrontier
    && openObligations.length >= EXTENDED_OBLIGATION_FLOOR
    && input.byteBudget >= EXTENDED_BUDGET_FLOOR
  ) {
    return "L3";
  }

  return "L2";
}

// ---------------------------------------------------------------------------
// Coverage predicates
// ---------------------------------------------------------------------------

function obligationCoveredBy(obligation: CoverageObligation, candidate: CoverageCandidate): boolean {
  if (candidate.obligationIds?.includes(obligation.id)) return true;
  if (obligation.paths?.includes(candidate.path)) return true;
  const role = normalizedRole(candidate.role);
  if (obligation.roles?.some((r) => normalizedRole(r) === role)) return true;
  return false;
}

function concernCoveredBy(concern: CoverageConcern, candidate: CoverageCandidate): boolean {
  const carried = new Set((candidate.concernTokens ?? []).map(normalizedToken));
  if (carried.size === 0) return false;
  return concern.tokens.some((token) => carried.has(normalizedToken(token)));
}

/**
 * A REQUIRED LOCATION names a path outright: the caller asked for it, or an
 * open obligation pins it. Required locations (and required roles) are exempt
 * from the diversity/redundancy penalty, so a required-location sweep can pull
 * several same-role files without the packer fighting itself — V10-09's
 * "required location sweepではdedup/diversityを弱める".
 */
function isRequiredLocation(candidate: CoverageCandidate, input: CoveragePackerInput): boolean {
  if (input.requiredPaths?.includes(candidate.path)) return true;
  return (input.obligations ?? []).some(
    (o) => o.open && (o.required ?? true) && (o.paths?.includes(candidate.path) ?? false),
  );
}

/**
 * SHED-FORBIDDEN at pack level: direct references, explicitly requested
 * locations, and the explicit locations of open obligations. These enter the
 * served set before the greedy loop runs and are never dropped by it. The
 * downstream budget ladder keeps its own, separate required sets; this
 * predicate does not weaken them.
 */
function isShedForbidden(candidate: CoverageCandidate, input: CoveragePackerInput): boolean {
  return candidate.direct === true
    || candidate.explicit === true
    || isRequiredLocation(candidate, input);
}

/** Required roles and required locations pay no diversity/redundancy penalty. */
function isPenaltyExempt(candidate: CoverageCandidate, input: CoveragePackerInput): boolean {
  const role = normalizedRole(candidate.role);
  if ((input.requiredRoles ?? []).some((r) => normalizedRole(r) === role)) return true;
  return isRequiredLocation(candidate, input);
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/** What `candidate` would newly cover against the current state. */
function marginalCoverage(
  candidate: CoverageCandidate,
  input: CoveragePackerInput,
  state: CoverageState,
): { roles: string[]; obligations: string[]; concerns: string[] } {
  const role = normalizedRole(candidate.role);
  const roles = role.length > 0 && !state.coveredRoles.has(role) ? [role] : [];
  const obligations = (input.obligations ?? [])
    .filter((o) => o.open && !state.coveredObligations.has(o.id) && obligationCoveredBy(o, candidate))
    .map((o) => o.id);
  const concerns = (input.concerns ?? [])
    .filter((c) => !state.coveredConcerns.has(c.id) && concernCoveredBy(c, candidate))
    .map((c) => c.id);
  return { roles, obligations, concerns };
}

/**
 * V10-09 utility, verbatim in its sign structure:
 *
 *   relevance + newly-covered obligations + surface-role diversity
 *   + evidence strength + edit-frontier membership + verification value
 *   - redundancy - bytes
 *
 * Exported so `coveragePacker.spec.ts` can pin the ORDERING the weights
 * produce, rather than re-deriving it from the greedy loop's output.
 */
export function candidateUtility(
  candidate: CoverageCandidate,
  input: CoveragePackerInput,
  state: CoverageState,
): number {
  const gain = marginalCoverage(candidate, input, state);

  const openObligations = (input.obligations ?? []).filter((o) => o.open);
  const obligationTerm = openObligations.length === 0
    ? 0
    : gain.obligations.length / openObligations.length;

  const concernTerm = (input.concerns ?? []).length === 0
    ? 0
    : gain.concerns.length / (input.concerns ?? []).length;

  const roleTerm = gain.roles.length > 0 ? 1 : 0;

  const relevance = clamp01(candidate.confidence);
  const evidence = clamp01(candidate.evidenceStrength ?? candidate.confidence);
  const frontier = candidate.editFrontier === true ? 1 : 0;
  const verification = clamp01(candidate.verificationValue ?? 0);

  // Redundancy: the same path twice, a role already covered, or content the
  // ledger says the client already holds. Required roles/locations are exempt
  // (V10-09: "required role／required locationはdiversity penaltyの対象外").
  let redundancy = 0;
  if (!isPenaltyExempt(candidate, input)) {
    if (state.selectedPaths.has(candidate.path)) redundancy += 1;
    if (roleTerm === 0) redundancy += 0.5;
    if (candidate.priorServed === true) redundancy += 0.5;
  } else if (state.selectedPaths.has(candidate.path)) {
    // Even an exempt candidate is worthless twice over: one surface per path.
    redundancy += 1;
  }

  const byteTerm = input.byteBudget > 0
    ? Math.min(1, Math.max(0, candidate.bytes) / input.byteBudget)
    : 0;

  return W_RELEVANCE * relevance
    + W_OBLIGATION * (obligationTerm + concernTerm)
    + W_ROLE_DIVERSITY * roleTerm
    + W_EVIDENCE * evidence
    + W_EDIT_FRONTIER * frontier
    + W_VERIFICATION * verification
    - W_REDUNDANCY * redundancy
    - W_BYTES * byteTerm;
}

/** Deterministic best-first comparison: utility desc (outside the epsilon), then original rank asc, then id asc. */
function compareByUtility(
  a: { utility: number; candidate: CoverageCandidate },
  b: { utility: number; candidate: CoverageCandidate },
): number {
  const diff = b.utility - a.utility;
  if (Math.abs(diff) > UTILITY_EPSILON) return diff;
  if (a.candidate.rank !== b.candidate.rank) return a.candidate.rank - b.candidate.rank;
  return a.candidate.id < b.candidate.id ? -1 : a.candidate.id > b.candidate.id ? 1 : 0;
}

// ---------------------------------------------------------------------------
// The packer
// ---------------------------------------------------------------------------

function applySelection(state: CoverageState, selection: CoverageSelection): void {
  for (const role of selection.newRoles) state.coveredRoles.add(role);
  for (const id of selection.newObligations) state.coveredObligations.add(id);
  for (const id of selection.newConcerns) state.coveredConcerns.add(id);
  state.selectedPaths.add(selection.candidate.path);
  state.bytesUsed += Math.max(0, selection.candidate.bytes);
}

function makeSelection(
  candidate: CoverageCandidate,
  input: CoveragePackerInput,
  state: CoverageState,
  reason: CoverageSelection["reason"],
): CoverageSelection {
  const gain = marginalCoverage(candidate, input, state);
  return {
    candidate,
    utility: candidateUtility(candidate, input, state),
    reason,
    newRoles: gain.roles,
    newObligations: gain.obligations,
    newConcerns: gain.concerns,
  };
}

/** True once nothing required is outstanding AND no remaining candidate would cover anything new. */
function isSaturated(
  remaining: readonly CoverageCandidate[],
  input: CoveragePackerInput,
  state: CoverageState,
): boolean {
  const requiredRoles = sortedUnique((input.requiredRoles ?? []).map(normalizedRole));
  if (requiredRoles.some((role) => !state.coveredRoles.has(role))) return false;
  const openRequired = (input.obligations ?? []).filter((o) => o.open && (o.required ?? true));
  if (openRequired.some((o) => !state.coveredObligations.has(o.id))) return false;
  return remaining.every((candidate) => {
    const gain = marginalCoverage(candidate, input, state);
    return gain.roles.length === 0 && gain.obligations.length === 0 && gain.concerns.length === 0;
  });
}

/**
 * Select the served surfaces for one pack.
 *
 * Order of operations, each step deterministic:
 *
 *  1. INVENTORY. Every direct reference is carried whole, ordered
 *     (rank, id). The inventory is never subject to the body quota — it is
 *     identity, not content.
 *  2. SHED-FORBIDDEN. Direct / explicit / open-obligation locations enter the
 *     body set first and are never dropped by the loop below.
 *  3. GREEDY COVERAGE. Best marginal utility wins, recomputed after every
 *     pick, until coverage saturates, the quota fills, or the next pick would
 *     break the byte budget. Saturation is checked BEFORE the budget: filling
 *     the budget is not a goal.
 *  4. REQUIRED-ROLE SWEEP. Any still-missing required role pulls its best
 *     candidate in, exempt from the quota and from the diversity penalty.
 *  5. HONESTY. `complete` is computed from what actually got covered.
 */
export function packForCoverage(input: CoveragePackerInput): CoveragePackerOutput {
  const level = selectContextLevel(input);
  const bodyQuota = Math.max(0, input.bodyQuota ?? LEVEL_BODY_QUOTA[level]);
  const byteBudget = Math.max(0, input.byteBudget);

  // 1. Direct-reference inventory — complete, deterministic, never dropped.
  const inventory = [...input.candidates]
    .filter((c) => c.direct === true || c.explicit === true || isRequiredLocation(c, input))
    .sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const state = emptyCoverageState();

  const body: CoverageSelection[] = [];
  const taken = new Set<string>();

  const remainingOf = (): CoverageCandidate[] =>
    input.candidates.filter((c) => !taken.has(c.id) && !state.selectedPaths.has(c.path));

  // 2. Shed-forbidden surfaces. These bypass the quota and the budget by
  //    construction: the pack level may not drop them, so pretending they fit
  //    is more honest than silently shedding a location the task named.
  const forbidden = input.candidates
    .filter((c) => isShedForbidden(c, input))
    .map((candidate) => ({ candidate, utility: candidateUtility(candidate, input, state) }))
    .sort(compareByUtility);
  for (const { candidate } of forbidden) {
    if (taken.has(candidate.id) || state.selectedPaths.has(candidate.path)) continue;
    const selection = makeSelection(candidate, input, state, "shed-forbidden");
    body.push(selection);
    applySelection(state, selection);
    taken.add(candidate.id);
  }

  // 3. Greedy coverage-per-token fill.
  let stopReason: CoverageStopReason = "exhausted";
  for (;;) {
    const remaining = remainingOf();
    if (remaining.length === 0) {
      stopReason = "exhausted";
      break;
    }
    // Saturation is checked first: coverage closing before the budget does is
    // the outcome this packer exists to produce.
    if (isSaturated(remaining, input, state)) {
      stopReason = "saturated";
      break;
    }
    if (body.length >= bodyQuota) {
      stopReason = "quota";
      break;
    }
    const best = remaining
      .map((candidate) => ({ candidate, utility: candidateUtility(candidate, input, state) }))
      .sort(compareByUtility)[0];
    if (best === undefined) {
      stopReason = "exhausted";
      break;
    }
    if (state.bytesUsed + Math.max(0, best.candidate.bytes) > byteBudget) {
      stopReason = "budget";
      break;
    }
    const selection = makeSelection(best.candidate, input, state, "coverage");
    body.push(selection);
    applySelection(state, selection);
    taken.add(best.candidate.id);
  }

  // 4. Required-role sweep. Diversity and redundancy are deliberately weakened
  //    here: a required role that no selected surface carries is a coverage
  //    hole, and a hole costs more than a duplicate.
  for (const role of sortedUnique((input.requiredRoles ?? []).map(normalizedRole))) {
    if (state.coveredRoles.has(role)) continue;
    const best = input.candidates
      .filter((c) => !taken.has(c.id) && !state.selectedPaths.has(c.path) && normalizedRole(c.role) === role)
      .map((candidate) => ({ candidate, utility: candidateUtility(candidate, input, state) }))
      .sort(compareByUtility)[0];
    if (best === undefined) continue;
    const selection = makeSelection(best.candidate, input, state, "required-role-sweep");
    body.push(selection);
    applySelection(state, selection);
    taken.add(best.candidate.id);
  }

  // 5. Honesty. Anything still missing keeps the pack partial.
  const missingRequiredRoles = sortedUnique((input.requiredRoles ?? []).map(normalizedRole))
    .filter((role) => !state.coveredRoles.has(role));
  const unmetObligations = (input.obligations ?? [])
    .filter((o) => o.open && (o.required ?? true) && !state.coveredObligations.has(o.id))
    .map((o) => o.id)
    .sort();
  const uncoveredConcerns = (input.concerns ?? [])
    .filter((c) => !state.coveredConcerns.has(c.id))
    .map((c) => c.id)
    .sort();
  const inventoryComplete = inventory.every((c) => taken.has(c.id) || state.selectedPaths.has(c.path));

  return {
    level,
    body,
    inventory,
    stopReason,
    bytes: state.bytesUsed,
    coveredRoles: sortedUnique(state.coveredRoles),
    missingRequiredRoles,
    unmetObligations,
    uncoveredConcerns,
    complete: missingRequiredRoles.length === 0
      && unmetObligations.length === 0
      && uncoveredConcerns.length === 0
      && inventoryComplete,
    inventoryComplete,
  };
}

// ---------------------------------------------------------------------------
// Caller bridge
//
// Kept here, generic over the caller's own candidate type, so the single
// integration seam in readCodeTaskPack.ts stays a handful of lines instead of
// growing a second copy of the projection inside a 20k-line file.
// ---------------------------------------------------------------------------

/**
 * Byte cost of serving `range` out of `content`, capped at `cap`.
 *
 * Pure, and deliberately pessimistic about what it cannot see: an unreadable
 * source (`content === undefined`) is charged the full cap rather than nothing,
 * so a file the packer cannot measure never wins a slot by looking free.
 */
export function estimateBodyBytes(
  range: string | undefined,
  content: string | undefined,
  cap: number,
): number {
  if (content === undefined) return cap;
  const match = /^(\d+)-(\d+)$/.exec((range ?? "").trim());
  if (match === null) return Math.min(cap, Buffer.byteLength(content, "utf8"));
  const lines = content.split("\n");
  const start = Math.max(1, Number(match[1]));
  const end = Math.max(start, Math.min(lines.length, Number(match[2])));
  const slice = lines.slice(start - 1, end).join("\n");
  return Math.min(cap, Buffer.byteLength(slice, "utf8"));
}

/** How the caller's candidate type maps onto the packer's structural inputs. Every accessor is pure; the caller owns any I/O (file reads, ledger lookups) behind them. */
export interface CoverageDetailProjection<T> {
  readonly path: (detail: T) => string;
  readonly role: (detail: T) => string;
  readonly confidence: (detail: T) => number;
  /** Estimated serialized body cost. */
  readonly bytes: (detail: T) => number;
  /** Original best-first position. Defaults to the pool index. */
  readonly rank?: (detail: T) => number;
  /** The query, an explicit argument, or an obligation names this location outright. */
  readonly direct?: (detail: T) => boolean;
  /** The served-range ledger says this window is already in the client's context. */
  readonly priorServed?: (detail: T) => boolean;
  /** Concern tokens this candidate carries. */
  readonly concernTokens?: (detail: T) => readonly string[];
  readonly editFrontier?: (detail: T) => boolean;
  readonly verificationValue?: (detail: T) => number;
}

/**
 * Run the packer over the caller's ranked pool and hand back the served set as
 * `[role, detail]` pairs, in serve order — the same shape the relevance-first
 * loop it replaces produced.
 *
 * The returned list is the BODY selection only. Shed-forbidden entries lead it,
 * so a downstream surface cap trims representatives before it ever reaches a
 * direct reference. `output` carries the coverage verdict the caller needs for
 * its own honesty accounting.
 */
export function selectCoverageOrderedEntries<T>(
  pool: readonly T[],
  project: CoverageDetailProjection<T>,
  context: Omit<CoveragePackerInput, "candidates">,
): { entries: Array<[string, T]>; output: CoveragePackerOutput } {
  const byId = new Map<string, T>();
  const candidates: CoverageCandidate[] = pool.map((detail, index) => {
    const id = `${index}#${project.path(detail)}`;
    byId.set(id, detail);
    return {
      id,
      path: project.path(detail),
      role: project.role(detail),
      rank: project.rank?.(detail) ?? index,
      confidence: project.confidence(detail),
      bytes: project.bytes(detail),
      ...(project.direct?.(detail) === true ? { direct: true } : {}),
      ...(project.priorServed?.(detail) === true ? { priorServed: true } : {}),
      ...(project.editFrontier?.(detail) === true ? { editFrontier: true } : {}),
      ...(project.verificationValue !== undefined
        ? { verificationValue: project.verificationValue(detail) }
        : {}),
      ...(project.concernTokens !== undefined
        ? { concernTokens: project.concernTokens(detail) }
        : {}),
    };
  });

  const output = packForCoverage({ ...context, candidates });
  const entries: Array<[string, T]> = [];
  for (const selection of output.body) {
    const detail = byId.get(selection.candidate.id);
    if (detail === undefined) continue;
    entries.push([selection.candidate.role, detail]);
  }
  return { entries, output };
}
