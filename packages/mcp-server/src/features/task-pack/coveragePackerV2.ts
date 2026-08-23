// ---------------------------------------------------------------------------
// coveragePackerV2.ts — V11-03 Coverage Packer v2: Concern / Role / Obligation
// / Completeness.
//
// NORMATIVE SOURCE: DESIGN-v0.10-expansion-plan-v1.3.md "### V11-03. Coverage
// Packer v2" (~line 2543), reconciled by
// DESIGN-v0.11-expansion-plan-reconciliation.md §3 (row "V11-03") and its
// binding constraints (§1: Protocol v1 freeze, D-1..D-8 carried forward).
//
// WHAT THIS MODULE IS
// -------------------
// A SIBLING of `coveragePacker.ts` (v1), not a replacement. v1 is untouched
// and remains the fallback: when this module's own concern-classification
// confidence is low, `packForCoverageV2` returns v1's `packForCoverage`
// result unchanged (byte-identical), never a half-applied v2 selection.
//
// v2 adds, over v1's coverage-per-token greedy selection:
//   - TASK CONCERN decomposition (implementation / public API / validation /
//     aggregation / test / config / build / doc) from deterministic rules
//     over path + role + symbol — no model calls, no I/O.
//   - a BODY-QUOTA vs INVENTORY-QUOTA split: the identity-only inventory
//     listing is sized by its OWN quota, independent of body byte/quota
//     pressure, so a starved body never silently drops inventory names.
//   - per-obligation EVIDENCE PREDICATES: an obligation may narrow which
//     candidate paths count as evidence (`pathClass`), and may declare itself
//     satisfiable by identity alone (`bodyRequired: false`) or by several
//     distinct sites (`minSites > 1`).
//   - DEDUP EXEMPTION rules so platform-variant implementations, overloads,
//     conditional-build twins, and multiple required call sites of the same
//     pattern are never shed as "redundant" duplicates.
//   - a bounded PAIRWISE COMPLEMENTARITY pass that can promote a low-solo-
//     relevance candidate whose combined value with an already-selected one
//     is high (O(n^2) over a capped candidate set).
//   - named SATURATION reasons (which role/obligation stopped taking bytes,
//     and why) and a per-candidate DECISION TRACE (drop/keep stage + reason).
//     Both are pure output fields — trace-only, never wired (see the caller
//     seam's own doc comment for how they may reach `util/trace.ts`).
//
// WHAT THIS MODULE IS NOT
// -----------------------
//  * Not a wire object. Every type below is INTERNAL (reconciliation §1
//    D-1), exactly like v1. Nothing here is serialized as-is; the caller
//    seam projects `body`/`inventory` onto the existing frozen surface shape.
//  * Not the budget ladder (`protocol/budget/ladder.ts` still runs after
//    selection, unchanged).
//  * Not aware of `priorPackStore.ts` or any other task-scoped state: prior-
//    pack obligations/served-identity are folded into `obligations` /
//    `priorServed` by the CALLER before this module ever runs, the same way
//    v1 receives its obligations as plain structural input. Keeping this
//    module state-free keeps it independently testable and preserves the
//    advisory-posture fence below.
//
// ADVISORY-POSTURE FENCE
// -----------------------
// Like v1, this module never imports `task-state/reasoningIr` (or anything
// under `task-state/**`), directly or transitively — the reasoning IR stays
// advisory-only in v0.11 (reconciliation §1, E-7). It DOES import the pure,
// zero-dependency `coveragePacker.js` sibling (the documented fallback
// target) — that is not a reasoningIr path.
//
// DOES NO I/O, reads no clock, has no module-level mutable state. Identical
// input => identical output, byte for byte (pinned by coveragePackerV2.spec).
// ---------------------------------------------------------------------------

import {
  packForCoverage,
  selectContextLevel,
  estimateBodyBytes,
  type ContextLevel,
  type CoverageCandidate,
  type CoverageConcern,
  type CoverageObligation,
  type CoveragePackerInput,
  type CoveragePackerOutput,
  type CoverageDetailProjection,
} from "./coveragePacker.js";

export { estimateBodyBytes };

// ---------------------------------------------------------------------------
// Task concern decomposition
// ---------------------------------------------------------------------------

/**
 * Task concern (V11-03 verbatim): "implementation、public API、validation、
 * aggregation、test、config、build、doc". Orthogonal to the existing surface
 * ROLE vocabulary (`ImpactSurface`: contract/api/domain/data/ui/style/test/
 * config/doc/unknown) — role answers "what KIND of file is this", concern
 * answers "what PURPOSE does it serve in THIS change".
 */
export type ConcernCategory =
  | "implementation"
  | "public_api"
  | "validation"
  | "aggregation"
  | "test"
  | "config"
  | "build"
  | "doc";

export const CONCERN_CATEGORIES: readonly ConcernCategory[] = [
  "implementation", "public_api", "validation", "aggregation", "test", "config", "build", "doc",
];

export interface ConcernClassification {
  readonly category: ConcernCategory;
  /** [0,1]. Below `CONCERN_CONFIDENCE_FLOOR` on the whole pool, the whole pack falls back to v1. */
  readonly confidence: number;
}

const TEST_PATH_RE = /(^|[/\\])(tests?|__tests__|spec)([/\\]|$)/i;
const TEST_FILE_RE = /(\.(spec|test)\.[jt]sx?$)|(^|[/\\])(test_[^/\\]+\.py|[^/\\]+_test\.py)$|([^/\\]+(Test|Tests)\.(java|kt))$/i;
const DOC_PATH_RE = /(^|[/\\])(docs?|documentation)([/\\]|$)/i;
const DOC_FILE_RE = /\.(md|markdown|mdx|rst|adoc)$/i;
const BUILD_FILE_RE = /(^|[/\\])(Makefile|Dockerfile|Jenkinsfile|Rakefile|CMakeLists\.txt|pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?)$/i;
const BUILD_CONFIG_RE = /\.(github[/\\]workflows[/\\].+\.ya?ml|circleci[/\\]config\.ya?ml)$/i;
const BUILD_TOOL_RE = /(^|[/\\])(webpack|vite|rollup|esbuild|babel|tsup)\.config\.[cm]?[jt]s$/i;
const CONFIG_FILE_RE = /(^|[/\\])(\.env(\.[a-z]+)?|[^/\\]+\.config\.(json|ya?ml|js|cjs|mjs|ts)|tsconfig(\.[a-z]+)?\.json|\.eslintrc(\.[a-z]*)?|\.prettierrc(\.[a-z]*)?|appsettings(\.[a-z]+)?\.json|settings\.[a-z]+)$/i;
const CONFIG_EXT_RE = /\.(ini|toml|ya?ml)$/i;
const PUBLIC_API_PATH_RE = /(^|[/\\])(api|public|interfaces?)([/\\]|$)/i;
const AGGREGATION_FILE_RE = /(^|[/\\])index\.[jt]sx?$/i;
const AGGREGATION_NAME_RE = /aggregat|orchestrat|composer|facade|registry/i;
const VALIDATION_NAME_RE = /valid|assert|guard|sanitiz/i;

interface ConcernSignalInput {
  readonly path: string;
  readonly role: string;
  readonly symbol?: string;
}

function addSignal(scores: Partial<Record<ConcernCategory, number>>, cat: ConcernCategory, amount: number): void {
  scores[cat] = (scores[cat] ?? 0) + amount;
}

function scoreConcernSignals(input: ConcernSignalInput): Partial<Record<ConcernCategory, number>> {
  const scores: Partial<Record<ConcernCategory, number>> = {};
  const role = input.role;
  const p = input.path;

  // Role-derived signals — weaker than a direct path/filename match.
  if (role === "test") addSignal(scores, "test", 1);
  if (role === "config") addSignal(scores, "config", 1);
  if (role === "doc") addSignal(scores, "doc", 1);
  if (role === "contract" || role === "api") addSignal(scores, "public_api", 1);
  if (role === "domain" || role === "data") addSignal(scores, "implementation", 0.6);

  // Path/filename-derived signals — the strongest, most direct evidence.
  if (TEST_PATH_RE.test(p) || TEST_FILE_RE.test(p)) addSignal(scores, "test", 1.2);
  if (DOC_PATH_RE.test(p) || DOC_FILE_RE.test(p)) addSignal(scores, "doc", 1.2);
  if (BUILD_FILE_RE.test(p) || BUILD_CONFIG_RE.test(p) || BUILD_TOOL_RE.test(p)) {
    addSignal(scores, "build", 1.2);
  } else if (CONFIG_FILE_RE.test(p) || CONFIG_EXT_RE.test(p)) {
    addSignal(scores, "config", 1.2);
  }
  if (PUBLIC_API_PATH_RE.test(p)) addSignal(scores, "public_api", 1.0);
  if (AGGREGATION_FILE_RE.test(p) || AGGREGATION_NAME_RE.test(p)) addSignal(scores, "aggregation", 1.0);
  if (VALIDATION_NAME_RE.test(p)) addSignal(scores, "validation", 1.0);

  // Symbol-derived signals.
  if (input.symbol !== undefined && input.symbol.length > 0) {
    if (VALIDATION_NAME_RE.test(input.symbol)) addSignal(scores, "validation", 0.8);
    if (AGGREGATION_NAME_RE.test(input.symbol)) addSignal(scores, "aggregation", 0.8);
  }

  return scores;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Deterministic concern classifier (V11-03: "concern classifierはdeterministic
 * rulesを基本にする"). No model calls, no I/O — a pure function of path, role,
 * and (optionally) symbol name.
 *
 * `confidence` is the top category's share of the total signal mass, blended
 * with its margin over the runner-up: a single unambiguous signal scores 1.0,
 * two competing signals of similar weight score around 0.5, and NO signal at
 * all (a genuinely unclassifiable candidate — unknown role, no path/filename
 * pattern) scores a flat 0.3, comfortably below `CONCERN_CONFIDENCE_FLOOR`.
 */
export function classifyConcern(input: ConcernSignalInput): ConcernClassification {
  const scores = scoreConcernSignals(input);
  const entries = (Object.entries(scores) as Array<[ConcernCategory, number]>)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (entries.length === 0) return { category: "implementation", confidence: 0.3 };
  const [topCat, topScore] = entries[0]!;
  const runnerUpScore = entries[1]?.[1] ?? 0;
  const total = entries.reduce((sum, [, v]) => sum + v, 0);
  const share = total > 0 ? topScore / total : 0;
  const margin = topScore > 0 ? (topScore - runnerUpScore) / topScore : 0;
  return { category: topCat, confidence: clamp01(share * 0.5 + margin * 0.5) };
}

/** Floor below which the WHOLE pack falls back to v1 (V11-03: "confidence低下時はv0.10 packerへfallback"). */
export const CONCERN_CONFIDENCE_FLOOR = 0.5;

/** Mean per-candidate classification confidence. An empty pool is vacuously confident (nothing to misclassify). */
export function poolConcernConfidence(candidates: readonly ConcernSignalInput[]): number {
  if (candidates.length === 0) return 1;
  const sum = candidates.reduce((acc, c) => acc + classifyConcern(c).confidence, 0);
  return sum / candidates.length;
}

// ---------------------------------------------------------------------------
// Dedup exemption
// ---------------------------------------------------------------------------

/**
 * V11-03: "platform別implementation、overload、conditional build、multiple
 * call sitesをdedupで落とさないexception ruleを持つ". `call-site-pattern` is
 * obligation-driven (see `CoverageObligationV2.minSites`) rather than
 * path-inferred, so it is not a member of `inferDedupExemption`'s result.
 */
export type DedupExemptionReason = "platform-variant" | "overload" | "conditional-build" | "call-site-pattern";

const PLATFORM_VARIANT_RE = /[._-](win32|windows|darwin|macos|osx|posix|linux|android|ios|wasm|unix)(?=[._-]|$)/i;
const CONDITIONAL_BUILD_RE = /[._-](debug|release|fallback|arm64|arm|x86|x64|simd)(?=[._-]|$)/i;

function stripVariantToken(p: string, re: RegExp): string {
  return p.replace(re, "");
}

interface DedupInferenceCandidate {
  readonly id: string;
  readonly path: string;
  readonly symbol?: string;
}

/**
 * Structural (path/symbol-shape) dedup exemption inference. Purely a
 * convenience layer — a caller/projection MAY set `CoverageCandidateV2.
 * dedupExemption` explicitly instead, which always wins over inference.
 */
export function inferDedupExemption(
  candidate: DedupInferenceCandidate,
  pool: readonly DedupInferenceCandidate[],
): DedupExemptionReason | undefined {
  const p = candidate.path;
  if (PLATFORM_VARIANT_RE.test(p)) {
    const base = stripVariantToken(p, PLATFORM_VARIANT_RE);
    if (pool.some((c) => c.id !== candidate.id && stripVariantToken(c.path, PLATFORM_VARIANT_RE) === base)) {
      return "platform-variant";
    }
  }
  if (CONDITIONAL_BUILD_RE.test(p)) {
    const base = stripVariantToken(p, CONDITIONAL_BUILD_RE);
    if (pool.some((c) => c.id !== candidate.id && stripVariantToken(c.path, CONDITIONAL_BUILD_RE) === base)) {
      return "conditional-build";
    }
  }
  if (candidate.symbol !== undefined && candidate.symbol.length > 0) {
    if (pool.some((c) => c.id !== candidate.id && c.path !== p && c.symbol === candidate.symbol)) {
      return "overload";
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// v2 candidate / obligation shapes (additive over v1's)
// ---------------------------------------------------------------------------

export interface CoverageCandidateV2 extends CoverageCandidate {
  /** Symbol/identifier name, when known — feeds concern classification and overload inference. */
  readonly symbol?: string;
  /** Caller-declared dedup exemption. Wins over `inferDedupExemption`. */
  readonly dedupExemption?: DedupExemptionReason;
}

export interface CoverageObligationV2 extends CoverageObligation {
  /** Evidence predicate: the candidate's path must match this, beyond role/paths/id membership. Narrows, never widens, v1's membership test. */
  readonly pathClass?: RegExp;
  /** How many DISTINCT candidates must satisfy this obligation before it stops granting coverage-gain / dedup exemption to further same-pattern sites. Defaults to 1. */
  readonly minSites?: number;
  /** False: an inventory (identity-only) entry alone discharges this obligation — no body required. Defaults to true. */
  readonly bodyRequired?: boolean;
}

export interface CoveragePackerV2Input extends Omit<CoveragePackerInput, "candidates" | "obligations"> {
  readonly candidates: readonly CoverageCandidateV2[];
  readonly obligations?: readonly CoverageObligationV2[];
  /** Identity-only inventory listing quota, independent of `bodyQuota`/`byteBudget`. Default `DEFAULT_INVENTORY_QUOTA`. */
  readonly inventoryQuota?: number;
  /** O(n^2) pairwise-complementarity candidate cap. Default `DEFAULT_COMPLEMENTARITY_CANDIDATE_CAP`. */
  readonly complementarityCandidateCap?: number;
  /** Test/caller escape hatch: force the v1 fallback regardless of measured confidence. */
  readonly forceV1Fallback?: boolean;
}

/** Selection reason, widened over v1's with the complementarity promotion stage. */
export type CoverageSelectionReasonV2 = "shed-forbidden" | "coverage" | "complementarity" | "required-role-sweep";

export interface CoverageSelectionV2 {
  readonly candidate: CoverageCandidateV2;
  readonly utility: number;
  readonly reason: CoverageSelectionReasonV2;
  readonly newRoles: readonly string[];
  readonly newObligations: readonly string[];
  readonly newConcerns: readonly string[];
}

export type DecisionStage = "shed-forbidden" | "greedy" | "complementarity" | "required-role-sweep" | "inventory" | "fallback";

export interface DecisionTraceEntry {
  readonly candidateId: string;
  readonly stage: DecisionStage;
  readonly outcome: "kept" | "dropped";
  readonly reason: string;
}

export interface ComplementarityPromotion {
  readonly a: string;
  readonly b: string;
  readonly score: number;
}

export interface CoveragePackerV2Output extends Omit<CoveragePackerOutput, "body"> {
  readonly body: readonly CoverageSelectionV2[];
  /** Per-concern-category: at least one body OR inventory entry classifies into it. */
  readonly concernCoverage: Readonly<Record<ConcernCategory, boolean>>;
  /** Per-candidate keep/drop trace, in evaluation order. Pure output — trace-only, never wired (see module header). */
  readonly decisionTrace: readonly DecisionTraceEntry[];
  /** `"role:<name>"` / `"obligation:<id>"` -> why spending stopped there. */
  readonly saturationReasons: Readonly<Record<string, string>>;
  /** True when this output IS v1's `packForCoverage` result, unchanged, because concern-classification confidence was too low to trust v2 selection. */
  readonly fallbackToV1: boolean;
  readonly fallbackReason?: string;
  readonly complementarityPromotions: readonly ComplementarityPromotion[];
}

// ---------------------------------------------------------------------------
// Internal state (mirrors coveragePacker.ts's CoverageState, plus v2 bookkeeping)
// ---------------------------------------------------------------------------

interface CoverageStateV2 {
  readonly coveredRoles: Set<string>;
  readonly coveredObligations: Set<string>;
  readonly coveredConcerns: Set<string>;
  readonly selectedPaths: Set<string>;
  /** obligation id -> count of DISTINCT selected candidates that satisfy it (for `minSites`). */
  readonly obligationSiteCounts: Map<string, number>;
  /** concern category -> count of selected (body) candidates classified into it. */
  readonly concernCounts: Map<ConcernCategory, number>;
  bytesUsed: number;
}

function emptyStateV2(): CoverageStateV2 {
  return {
    coveredRoles: new Set(),
    coveredObligations: new Set(),
    coveredConcerns: new Set(),
    selectedPaths: new Set(),
    obligationSiteCounts: new Map(),
    concernCounts: new Map(),
    bytesUsed: 0,
  };
}

function normalizedRole(role: string): string {
  return role.trim().toLowerCase();
}

function normalizedToken(token: string): string {
  return token.trim().toLowerCase();
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

// ---------------------------------------------------------------------------
// Weights (same magnitudes as v1, plus a new concern-diversity term)
// ---------------------------------------------------------------------------

const W_RELEVANCE = 1;
const W_OBLIGATION = 2;
const W_ROLE_DIVERSITY = 1.5;
const W_CONCERN_DIVERSITY = 0.75;
const W_EVIDENCE = 0.5;
const W_EDIT_FRONTIER = 1.25;
const W_VERIFICATION = 0.5;
const W_REDUNDANCY = 1.5;
const W_BYTES = 1;

const UTILITY_EPSILON = 1e-6;

const LEVEL_BODY_QUOTA: Record<ContextLevel, number> = { L0: 0, L1: 3, L2: 4, L3: 6 };

export const DEFAULT_INVENTORY_QUOTA = 64;
export const DEFAULT_COMPLEMENTARITY_CANDIDATE_CAP = 12;
const COMPLEMENTARITY_PROMOTION_CAP = 2;
const COMPLEMENTARITY_THRESHOLD = 0;

// ---------------------------------------------------------------------------
// Coverage / obligation predicates
// ---------------------------------------------------------------------------

function obligationCoveredByV2(obligation: CoverageObligationV2, candidate: CoverageCandidateV2): boolean {
  if (obligation.pathClass !== undefined && !obligation.pathClass.test(candidate.path)) return false;
  if (candidate.obligationIds?.includes(obligation.id)) return true;
  if (obligation.paths?.includes(candidate.path)) return true;
  const role = normalizedRole(candidate.role);
  if (obligation.roles?.some((r) => normalizedRole(r) === role)) return true;
  return false;
}

function concernCoveredBy(concern: CoverageConcern, candidate: CoverageCandidateV2): boolean {
  const carried = new Set((candidate.concernTokens ?? []).map(normalizedToken));
  if (carried.size === 0) return false;
  return concern.tokens.some((token) => carried.has(normalizedToken(token)));
}

function isRequiredLocationV2(candidate: CoverageCandidateV2, input: CoveragePackerV2Input): boolean {
  if (input.requiredPaths?.includes(candidate.path)) return true;
  return (input.obligations ?? []).some(
    (o) => o.open && (o.required ?? true) && (o.paths?.includes(candidate.path) ?? false),
  );
}

function isShedForbiddenV2(candidate: CoverageCandidateV2, input: CoveragePackerV2Input): boolean {
  return candidate.direct === true || candidate.explicit === true || isRequiredLocationV2(candidate, input);
}

function isPenaltyExemptV2(candidate: CoverageCandidateV2, input: CoveragePackerV2Input): boolean {
  const role = normalizedRole(candidate.role);
  if ((input.requiredRoles ?? []).some((r) => normalizedRole(r) === role)) return true;
  return isRequiredLocationV2(candidate, input);
}

/** Obligation ids `candidate` would grant fresh coverage-gain for — open, path-class-matching, and not yet at `minSites`. Distinct from `state.coveredObligations` (a boolean ledger unaffected by `minSites`). */
function obligationGainIds(
  candidate: CoverageCandidateV2,
  input: CoveragePackerV2Input,
  state: CoverageStateV2,
): string[] {
  return (input.obligations ?? [])
    .filter((o) => {
      if (!o.open) return false;
      const minSites = Math.max(1, o.minSites ?? 1);
      const already = state.obligationSiteCounts.get(o.id) ?? 0;
      if (already >= minSites) return false;
      return obligationCoveredByV2(o, candidate);
    })
    .map((o) => o.id);
}

function marginalCoverageV2(
  candidate: CoverageCandidateV2,
  input: CoveragePackerV2Input,
  state: CoverageStateV2,
): { roles: string[]; obligations: string[]; concerns: string[] } {
  const role = normalizedRole(candidate.role);
  const roles = role.length > 0 && !state.coveredRoles.has(role) ? [role] : [];
  const obligations = obligationGainIds(candidate, input, state);
  const concerns = (input.concerns ?? [])
    .filter((c) => !state.coveredConcerns.has(c.id) && concernCoveredBy(c, candidate))
    .map((c) => c.id);
  return { roles, obligations, concerns };
}

/** True while `candidate` still owes a `minSites` obligation an ADDITIONAL distinct site. Dynamic — unlike the other three dedup-exemption reasons, this one turns off once `minSites` is reached. */
function callSitePatternExempt(
  candidate: CoverageCandidateV2,
  input: CoveragePackerV2Input,
  state: CoverageStateV2,
): boolean {
  return (input.obligations ?? []).some((o) => {
    const minSites = Math.max(1, o.minSites ?? 1);
    if (minSites <= 1) return false;
    if (!obligationCoveredByV2(o, candidate)) return false;
    return (state.obligationSiteCounts.get(o.id) ?? 0) < minSites;
  });
}

interface DedupVerdict {
  readonly exempt: boolean;
  readonly reason?: DedupExemptionReason;
}

function dedupExemptionNow(
  candidate: CoverageCandidateV2,
  input: CoveragePackerV2Input,
  state: CoverageStateV2,
): DedupVerdict {
  if (candidate.dedupExemption !== undefined && candidate.dedupExemption !== "call-site-pattern") {
    return { exempt: true, reason: candidate.dedupExemption };
  }
  const inferred = inferDedupExemption(candidate, input.candidates);
  if (inferred !== undefined) return { exempt: true, reason: inferred };
  if (callSitePatternExempt(candidate, input, state)) return { exempt: true, reason: "call-site-pattern" };
  return { exempt: false };
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function candidateUtilityV2(
  candidate: CoverageCandidateV2,
  input: CoveragePackerV2Input,
  state: CoverageStateV2,
): number {
  const gain = marginalCoverageV2(candidate, input, state);

  const openObligations = (input.obligations ?? []).filter((o) => o.open);
  const obligationTerm = openObligations.length === 0 ? 0 : gain.obligations.length / openObligations.length;
  const concernTerm = (input.concerns ?? []).length === 0 ? 0 : gain.concerns.length / (input.concerns ?? []).length;
  const roleTerm = gain.roles.length > 0 ? 1 : 0;

  const relevance = clamp01(candidate.confidence);
  const evidence = clamp01(candidate.evidenceStrength ?? candidate.confidence);
  const frontier = candidate.editFrontier === true ? 1 : 0;
  const verification = clamp01(candidate.verificationValue ?? 0);

  const concernCat = classifyConcern(candidate).category;
  const concernNovelty = (state.concernCounts.get(concernCat) ?? 0) === 0 ? 1 : 0;

  const exempt = isPenaltyExemptV2(candidate, input) || dedupExemptionNow(candidate, input, state).exempt;
  let redundancy = 0;
  if (!exempt) {
    if (state.selectedPaths.has(candidate.path)) redundancy += 1;
    if (roleTerm === 0) redundancy += 0.5;
    if (candidate.priorServed === true) redundancy += 0.5;
  } else if (state.selectedPaths.has(candidate.path)) {
    redundancy += 1; // one surface per path, even when dedup-exempt
  }

  const byteTerm = input.byteBudget > 0 ? Math.min(1, Math.max(0, candidate.bytes) / input.byteBudget) : 0;

  return W_RELEVANCE * relevance
    + W_OBLIGATION * (obligationTerm + concernTerm)
    + W_ROLE_DIVERSITY * roleTerm
    + W_CONCERN_DIVERSITY * concernNovelty
    + W_EVIDENCE * evidence
    + W_EDIT_FRONTIER * frontier
    + W_VERIFICATION * verification
    - W_REDUNDANCY * redundancy
    - W_BYTES * byteTerm;
}

function compareByUtility(
  a: { utility: number; candidate: CoverageCandidateV2 },
  b: { utility: number; candidate: CoverageCandidateV2 },
): number {
  const diff = b.utility - a.utility;
  if (Math.abs(diff) > UTILITY_EPSILON) return diff;
  if (a.candidate.rank !== b.candidate.rank) return a.candidate.rank - b.candidate.rank;
  return a.candidate.id < b.candidate.id ? -1 : a.candidate.id > b.candidate.id ? 1 : 0;
}

function applySelectionV2(state: CoverageStateV2, selection: CoverageSelectionV2): void {
  for (const role of selection.newRoles) state.coveredRoles.add(role);
  for (const id of selection.newObligations) state.coveredObligations.add(id);
  for (const id of selection.newConcerns) state.coveredConcerns.add(id);
  state.selectedPaths.add(selection.candidate.path);
  state.bytesUsed += Math.max(0, selection.candidate.bytes);
  const cat = classifyConcern(selection.candidate).category;
  state.concernCounts.set(cat, (state.concernCounts.get(cat) ?? 0) + 1);
}

function bumpObligationSiteCounts(
  candidate: CoverageCandidateV2,
  input: CoveragePackerV2Input,
  state: CoverageStateV2,
): void {
  for (const o of input.obligations ?? []) {
    if (obligationCoveredByV2(o, candidate)) {
      state.obligationSiteCounts.set(o.id, (state.obligationSiteCounts.get(o.id) ?? 0) + 1);
    }
  }
}

function makeSelectionV2(
  candidate: CoverageCandidateV2,
  input: CoveragePackerV2Input,
  state: CoverageStateV2,
  reason: CoverageSelectionReasonV2,
): CoverageSelectionV2 {
  const gain = marginalCoverageV2(candidate, input, state);
  return {
    candidate,
    utility: candidateUtilityV2(candidate, input, state),
    reason,
    newRoles: gain.roles,
    newObligations: gain.obligations,
    newConcerns: gain.concerns,
  };
}

function commitSelection(
  body: CoverageSelectionV2[],
  taken: Set<string>,
  state: CoverageStateV2,
  input: CoveragePackerV2Input,
  selection: CoverageSelectionV2,
): void {
  body.push(selection);
  applySelectionV2(state, selection);
  bumpObligationSiteCounts(selection.candidate, input, state);
  taken.add(selection.candidate.id);
}

function isSaturatedV2(
  remaining: readonly CoverageCandidateV2[],
  input: CoveragePackerV2Input,
  state: CoverageStateV2,
): { saturated: boolean; openReasons: string[] } {
  const openReasons: string[] = [];
  const requiredRoles = sortedUnique((input.requiredRoles ?? []).map(normalizedRole));
  for (const role of requiredRoles) {
    if (!state.coveredRoles.has(role)) openReasons.push(`role:${role}`);
  }
  const openRequired = (input.obligations ?? []).filter((o) => o.open && (o.required ?? true));
  for (const o of openRequired) {
    const minSites = Math.max(1, o.minSites ?? 1);
    if ((state.obligationSiteCounts.get(o.id) ?? 0) < minSites) openReasons.push(`obligation:${o.id}`);
  }
  if (openReasons.length > 0) return { saturated: false, openReasons };
  const anyGain = remaining.some((c) => {
    const gain = marginalCoverageV2(c, input, state);
    return gain.roles.length > 0 || gain.obligations.length > 0 || gain.concerns.length > 0;
  });
  return { saturated: !anyGain, openReasons: [] };
}

// ---------------------------------------------------------------------------
// Inventory (independent of body quota/budget — see module header)
// ---------------------------------------------------------------------------

function computeInventoryV2(input: CoveragePackerV2Input): CoverageCandidateV2[] {
  const quota = Math.max(0, input.inventoryQuota ?? DEFAULT_INVENTORY_QUOTA);
  return [...input.candidates]
    .filter((c) => c.direct === true || c.explicit === true || isRequiredLocationV2(c, input))
    .sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, quota);
}

// ---------------------------------------------------------------------------
// Pairwise complementarity
//
// V11-03 names the signal as "role/concern coverage gainの合算 − 個別合算"
// (pair coverage-gain minus the sum of individual gains). Taken LITERALLY
// over role/obligation/concern SET coverage, that quantity can never be
// positive: set union is subadditive (|A∪B| <= |A|+|B| always), so a
// same-baseline "pair minus solo" computation is <= 0 for every candidate
// pair and could never promote anything. The workable reading — and the one
// that matches the failure mode this feature targets ("単独関連度が低くても
// 組合せ価値が高いEvidenceを拾う", pick up low-solo-relevance evidence whose
// COMBINATION value is high) — scores a not-yet-selected candidate `b`
// against an ALREADY-SELECTED `a` on two signals, GATED (not merely additive)
// on the first:
//
//   1. `b`'s own remaining marginal role/obligation/concern gain against the
//      CURRENT state (which already reflects `a` and every other selection
//      so far) — the value the plain greedy loop could no longer afford once
//      its own quota/budget stopped it early. This is the PREREQUISITE: a
//      candidate that adds nothing new is a redundant duplicate, not a
//      complementary partner, and topical relatedness must never launder
//      that distinction away (a same-concern-group sibling of an
//      already-selected surface shares its vocabulary by construction, and
//      re-promoting it is exactly the "redundant duplicate" shape the
//      packer exists to shed — measured live on the multi-concern fixture:
//      an ungated additive score reintroduced the sibling v1 correctly
//      sheds, costing +7KB on that fixture with zero coverage gain).
//   2. topical relatedness — shared `concernTokens` vocabulary with `a` (the
//      same token-overlap signal `concernCoveredBy` uses elsewhere in this
//      module, just measured pairwise instead of against a query concern
//      group) — added ONLY on top of a non-zero (1), as a tie-breaking
//      boost: among several candidates that each still offer real residual
//      gain, the one topically related to what is already selected wins the
//      bounded promotion slot.
//
// A `b` with zero remaining gain scores zero and is never promoted,
// regardless of vocabulary overlap with `a`.
// ---------------------------------------------------------------------------

function sharedConcernTokenCount(a: CoverageCandidateV2, b: CoverageCandidateV2): number {
  const aTokens = new Set((a.concernTokens ?? []).map(normalizedToken));
  if (aTokens.size === 0) return 0;
  let shared = 0;
  for (const token of new Set((b.concernTokens ?? []).map(normalizedToken))) {
    if (aTokens.has(token)) shared += 1;
  }
  return shared;
}

function complementarityScoreV2(
  a: CoverageCandidateV2,
  b: CoverageCandidateV2,
  input: CoveragePackerV2Input,
  state: CoverageStateV2,
): number {
  const gain = marginalCoverageV2(b, input, state);
  const remainingGain = gain.roles.length + gain.obligations.length + gain.concerns.length;
  if (remainingGain <= 0) return 0;
  return remainingGain + sharedConcernTokenCount(a, b);
}

// ---------------------------------------------------------------------------
// Concern coverage summary
// ---------------------------------------------------------------------------

function summarizeConcernCoverage(
  body: readonly CoverageSelectionV2[],
  inventory: readonly CoverageCandidateV2[],
): Record<ConcernCategory, boolean> {
  const covered = new Set<ConcernCategory>();
  for (const s of body) covered.add(classifyConcern(s.candidate).category);
  for (const c of inventory) covered.add(classifyConcern(c).category);
  const out = {} as Record<ConcernCategory, boolean>;
  for (const cat of CONCERN_CATEGORIES) out[cat] = covered.has(cat);
  return out;
}

// ---------------------------------------------------------------------------
// The v1 fallback wrapper
// ---------------------------------------------------------------------------

function asV1Fallback(input: CoveragePackerV2Input, reason: string): CoveragePackerV2Output {
  const v1out = packForCoverage(input);
  return {
    ...v1out,
    body: v1out.body as unknown as readonly CoverageSelectionV2[],
    concernCoverage: (() => {
      const out = {} as Record<ConcernCategory, boolean>;
      for (const cat of CONCERN_CATEGORIES) out[cat] = false;
      return out;
    })(),
    decisionTrace: [{ candidateId: "*", stage: "fallback", outcome: "kept", reason }],
    saturationReasons: {},
    fallbackToV1: true,
    fallbackReason: reason,
    complementarityPromotions: [],
  };
}

// ---------------------------------------------------------------------------
// The v2 packer
// ---------------------------------------------------------------------------

/**
 * V11-03 coverage-per-token selection. Same five-phase shape as v1
 * (inventory / shed-forbidden / greedy / required-role sweep / honesty),
 * plus a bounded complementarity-promotion phase between greedy and sweep,
 * and v2's concern/dedup/evidence-predicate refinements throughout.
 *
 * Falls back to v1's `packForCoverage`, UNCHANGED, whenever
 * `forceV1Fallback` is set or the pool's mean concern-classification
 * confidence is below `CONCERN_CONFIDENCE_FLOOR` — the spec-pinned "confidence
 *低下時はv0.10 packerへfallback" behaviour.
 */
export function packForCoverageV2(input: CoveragePackerV2Input): CoveragePackerV2Output {
  if (input.forceV1Fallback === true) return asV1Fallback(input, "forced-v1-fallback");
  const confidence = poolConcernConfidence(input.candidates);
  if (confidence < CONCERN_CONFIDENCE_FLOOR) {
    return asV1Fallback(
      input,
      `low concern-classification confidence (${confidence.toFixed(2)} < ${CONCERN_CONFIDENCE_FLOOR})`,
    );
  }

  const level = selectContextLevel(input);
  const bodyQuota = Math.max(0, input.bodyQuota ?? LEVEL_BODY_QUOTA[level]);
  const byteBudget = Math.max(0, input.byteBudget);

  // 1. Inventory — independent of body quota/budget (module header).
  const inventory = computeInventoryV2(input);

  const state = emptyStateV2();
  // Identity-satisfiable obligations (`bodyRequired: false`) are discharged
  // the moment inventory names their evidence, before the body loop spends a
  // single byte.
  for (const o of input.obligations ?? []) {
    if (o.open && o.bodyRequired === false && inventory.some((c) => obligationCoveredByV2(o, c))) {
      state.coveredObligations.add(o.id);
    }
  }

  const body: CoverageSelectionV2[] = [];
  const taken = new Set<string>();
  const trace: DecisionTraceEntry[] = [];
  const saturationReasons: Record<string, string> = {};

  const remainingOf = (): CoverageCandidateV2[] =>
    input.candidates.filter((c) => !taken.has(c.id) && !state.selectedPaths.has(c.path));

  // 2. Shed-forbidden.
  const forbidden = input.candidates
    .filter((c) => isShedForbiddenV2(c, input))
    .map((candidate) => ({ candidate, utility: candidateUtilityV2(candidate, input, state) }))
    .sort(compareByUtility);
  for (const { candidate } of forbidden) {
    if (taken.has(candidate.id) || state.selectedPaths.has(candidate.path)) continue;
    const selection = makeSelectionV2(candidate, input, state, "shed-forbidden");
    commitSelection(body, taken, state, input, selection);
    trace.push({ candidateId: candidate.id, stage: "shed-forbidden", outcome: "kept", reason: "direct/explicit/required-location" });
  }

  // 3. Greedy coverage-per-token fill.
  let stopReason: CoveragePackerOutput["stopReason"] = "exhausted";
  for (;;) {
    const remaining = remainingOf();
    if (remaining.length === 0) { stopReason = "exhausted"; break; }
    const sat = isSaturatedV2(remaining, input, state);
    if (sat.saturated) { stopReason = "saturated"; break; }
    if (body.length >= bodyQuota) { stopReason = "quota"; break; }
    const scored = remaining
      .map((candidate) => ({ candidate, utility: candidateUtilityV2(candidate, input, state) }))
      .sort(compareByUtility);
    const best = scored[0];
    if (best === undefined) { stopReason = "exhausted"; break; }
    if (state.bytesUsed + Math.max(0, best.candidate.bytes) > byteBudget) {
      stopReason = "budget";
      trace.push({ candidateId: best.candidate.id, stage: "greedy", outcome: "dropped", reason: "byte-budget-exceeded" });
      break;
    }
    const selection = makeSelectionV2(best.candidate, input, state, "coverage");
    for (const r of selection.newRoles) saturationReasons[`role:${r}`] = `covered-by:${best.candidate.id}`;
    for (const o of selection.newObligations) saturationReasons[`obligation:${o}`] = `covered-by:${best.candidate.id}`;
    commitSelection(body, taken, state, input, selection);
    trace.push({
      candidateId: best.candidate.id,
      stage: "greedy",
      outcome: "kept",
      reason: selection.newRoles.length > 0
        ? `new role: ${selection.newRoles.join(",")}`
        : selection.newObligations.length > 0
          ? `new obligation: ${selection.newObligations.join(",")}`
          : selection.newConcerns.length > 0
            ? `new concern: ${selection.newConcerns.join(",")}`
            : "relevance/evidence",
    });
  }
  for (const role of [...state.coveredRoles]) {
    saturationReasons[`role:${role}`] = saturationReasons[`role:${role}`] ?? "already-satisfied";
  }

  // 3b. Bounded pairwise complementarity promotion.
  const promotions: ComplementarityPromotion[] = [];
  if (body.length > 0) {
    const cap = Math.max(0, input.complementarityCandidateCap ?? DEFAULT_COMPLEMENTARITY_CANDIDATE_CAP);
    const candidatePool = remainingOf()
      .sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, cap);
    let promotionsLeft = COMPLEMENTARITY_PROMOTION_CAP;
    for (const selected of [...body]) {
      if (promotionsLeft <= 0) break;
      let bestPromo: { candidate: CoverageCandidateV2; score: number } | undefined;
      for (const candidate of candidatePool) {
        if (taken.has(candidate.id) || state.selectedPaths.has(candidate.path)) continue;
        const score = complementarityScoreV2(selected.candidate, candidate, input, state);
        if (score <= COMPLEMENTARITY_THRESHOLD) continue;
        if (
          bestPromo === undefined
          || score > bestPromo.score
          || (score === bestPromo.score && candidate.id < bestPromo.candidate.id)
        ) {
          bestPromo = { candidate, score };
        }
      }
      if (bestPromo === undefined) continue;
      if (state.bytesUsed + Math.max(0, bestPromo.candidate.bytes) > byteBudget) {
        trace.push({ candidateId: bestPromo.candidate.id, stage: "complementarity", outcome: "dropped", reason: "byte-budget-exceeded" });
        continue;
      }
      const selection = makeSelectionV2(bestPromo.candidate, input, state, "complementarity");
      commitSelection(body, taken, state, input, selection);
      trace.push({
        candidateId: bestPromo.candidate.id,
        stage: "complementarity",
        outcome: "kept",
        reason: `pairs with ${selected.candidate.id} (score ${bestPromo.score.toFixed(2)})`,
      });
      promotions.push({ a: selected.candidate.id, b: bestPromo.candidate.id, score: bestPromo.score });
      promotionsLeft -= 1;
    }
  }

  // 4. Required-role sweep.
  for (const role of sortedUnique((input.requiredRoles ?? []).map(normalizedRole))) {
    if (state.coveredRoles.has(role)) continue;
    const best = input.candidates
      .filter((c) => !taken.has(c.id) && !state.selectedPaths.has(c.path) && normalizedRole(c.role) === role)
      .map((candidate) => ({ candidate, utility: candidateUtilityV2(candidate, input, state) }))
      .sort(compareByUtility)[0];
    if (best === undefined) continue;
    const selection = makeSelectionV2(best.candidate, input, state, "required-role-sweep");
    commitSelection(body, taken, state, input, selection);
    trace.push({ candidateId: best.candidate.id, stage: "required-role-sweep", outcome: "kept", reason: `closes missing required role: ${role}` });
  }

  // 5. Honesty.
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

  for (const entry of inventory) {
    trace.push({
      candidateId: entry.id,
      stage: "inventory",
      outcome: "kept",
      reason: "identity-only inventory entry (independent of body quota)",
    });
  }

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
    concernCoverage: summarizeConcernCoverage(body, inventory),
    decisionTrace: trace,
    saturationReasons,
    fallbackToV1: false,
    complementarityPromotions: promotions,
  };
}

// ---------------------------------------------------------------------------
// Consistency check (EvidenceIdentity/Use/Delivery framing — no dangling refs)
//
// "Identity" = every id this output MENTIONS must resolve to a real pool
// candidate or a real declared obligation/concern id ("Use"); "Delivery" =
// body/inventory entries are drawn only from the input pool. Internal-only —
// exercised directly by coveragePackerV2.spec.ts, never wired.
// ---------------------------------------------------------------------------

export function findDanglingReferences(
  output: CoveragePackerV2Output,
  input: CoveragePackerV2Input,
): string[] {
  const violations: string[] = [];
  const candidateIds = new Set(input.candidates.map((c) => c.id));
  const obligationIds = new Set((input.obligations ?? []).map((o) => o.id));
  const concernIds = new Set((input.concerns ?? []).map((c) => c.id));

  for (const s of output.body) {
    if (!candidateIds.has(s.candidate.id)) violations.push(`body candidate ${s.candidate.id} not in input pool`);
    for (const id of s.newObligations) if (!obligationIds.has(id)) violations.push(`body ${s.candidate.id} newObligations references unknown obligation ${id}`);
    for (const id of s.newConcerns) if (!concernIds.has(id)) violations.push(`body ${s.candidate.id} newConcerns references unknown concern ${id}`);
  }
  for (const c of output.inventory) {
    if (!candidateIds.has(c.id)) violations.push(`inventory candidate ${c.id} not in input pool`);
  }
  for (const entry of output.decisionTrace) {
    if (entry.candidateId !== "*" && !candidateIds.has(entry.candidateId)) {
      violations.push(`decisionTrace entry references unknown candidate ${entry.candidateId}`);
    }
  }
  for (const promo of output.complementarityPromotions) {
    if (!candidateIds.has(promo.a)) violations.push(`complementarityPromotions references unknown candidate ${promo.a}`);
    if (!candidateIds.has(promo.b)) violations.push(`complementarityPromotions references unknown candidate ${promo.b}`);
  }
  for (const id of output.unmetObligations) if (!obligationIds.has(id)) violations.push(`unmetObligations references unknown obligation ${id}`);
  for (const id of output.uncoveredConcerns) if (!concernIds.has(id)) violations.push(`uncoveredConcerns references unknown concern ${id}`);
  return violations;
}

// ---------------------------------------------------------------------------
// Caller bridge (mirrors coveragePacker.ts's selectCoverageOrderedEntries)
// ---------------------------------------------------------------------------

export interface CoverageDetailProjectionV2<T> extends CoverageDetailProjection<T> {
  readonly symbol?: (detail: T) => string | undefined;
  readonly dedupExemption?: (detail: T) => DedupExemptionReason | undefined;
}

export function selectCoverageOrderedEntriesV2<T>(
  pool: readonly T[],
  project: CoverageDetailProjectionV2<T>,
  context: Omit<CoveragePackerV2Input, "candidates">,
): { entries: Array<[string, T]>; output: CoveragePackerV2Output } {
  const byId = new Map<string, T>();
  const candidates: CoverageCandidateV2[] = pool.map((detail, index) => {
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
      ...(project.verificationValue !== undefined ? { verificationValue: project.verificationValue(detail) } : {}),
      ...(project.concernTokens !== undefined ? { concernTokens: project.concernTokens(detail) } : {}),
      ...(project.symbol?.(detail) !== undefined ? { symbol: project.symbol(detail) } : {}),
      ...(project.dedupExemption?.(detail) !== undefined ? { dedupExemption: project.dedupExemption(detail) } : {}),
    };
  });

  const output = packForCoverageV2({ ...context, candidates });
  const entries: Array<[string, T]> = [];
  for (const selection of output.body) {
    const detail = byId.get(selection.candidate.id);
    if (detail === undefined) continue;
    entries.push([selection.candidate.role, detail]);
  }
  return { entries, output };
}
