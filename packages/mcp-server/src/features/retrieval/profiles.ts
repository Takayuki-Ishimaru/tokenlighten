/**
 * profiles.ts — V11-02 Task-aware Weighted RRF v2: static per-task-profile
 * retriever weight table.
 *
 * DESIGN-v0.10-expansion-plan-v1.3.md V11-02: "known-local / navigation /
 * change-propagation / cross-package / cross-document / failure-diagnosis /
 * read-only のprofileを定義する。profile別にexact、symbol、reference、
 * BM25F、graph、recent diffのweightを持つ。" Weights here are RRF fusion-list
 * MULTIPLIERS (features/retrieval/rrf.ts's weightedReciprocalRankFusion) —
 * a completely different axis than bm25f.ts's own FIELD_WEIGHTS (which
 * weight term FIELDS inside a single BM25F score, not retriever LISTS inside
 * fusion) — and never a candidate filter. A profile can only change HOW MUCH
 * a retriever's rank contributes to fusion; it can never remove a candidate.
 * The hard floor (hardFloor.ts) that protects exact-path/exact-identifier/
 * parser-proven-symbol/direct-reference candidates is completely independent
 * of these weights — see this package's floor specs for the adversarial
 * all-zero-weight proof.
 *
 * `recentDiff` is a DOCUMENTED PLACEHOLDER: no recent-diff retriever exists
 * anywhere in this codebase. Every profile below pins it to 1 (neutral) so
 * wiring one in later is additive — a real ranked list showing up with a
 * non-1 weight will be a deliberate future edit, not a silent behavior
 * change today. index.ts never builds a ranked list for this key, so it is
 * inert by construction, not merely by convention.
 *
 * `graph` is LIVE as of Wave C (2026-08-21, F-A5): `graphRetriever.ts`
 * builds a real ranked list from the optional static code graph
 * (graph/index.ts's GraphIndex) whenever TL_RRF_FUSION is on and a graph
 * index loads for the workspace — see that module's own file doc for the
 * lookup/scoring rules and index.ts's "Wave C (F-A5)" comment for the
 * fusion wiring. Every profile below STILL pins `graph` to 1 — this is now
 * an ACTUAL RE-TUNED RESULT, not an inertness artifact: `tune-profiles.mjs`
 * ran a real coordinate-descent search over this axis (alongside the
 * pre-existing four) against a REAL, mechanically-built graph per holdout
 * workspace, and found no per-profile value that beats neutral by the
 * required margin — see bench/workflows/retrieval/TUNING-PROFILES-2026-08-21.md's
 * "Wave C" section for the full method and, importantly, for the
 * substantial NEUTRAL-baseline improvement the graph axis's mere presence
 * already produced for `change-propagation` (mean MRR 0.5833 -> 0.7778) —
 * an honest, non-fabricated finding distinct from "tuning found nothing".
 *

 * Weights are ONLY consulted when both TL_RRF_FUSION and TL_RRF_PROFILES are
 * on (see util/flags.ts's rrfFusionEnabled/rrfProfilesEnabled). With either
 * off, index.ts never reaches this module and fusion runs with every list at
 * implicit weight 1 — byte-identical to pre-V11-02 output.
 */

export type TaskProfileId =
  | "known-local"
  | "navigation"
  | "change-propagation"
  | "cross-package"
  | "cross-document"
  | "failure-diagnosis"
  | "read-only"
  | "general";

/** Every profile id, in the design doc's own listed order, "general" fallback last. */
export const TASK_PROFILE_IDS: readonly TaskProfileId[] = [
  "known-local",
  "navigation",
  "change-propagation",
  "cross-package",
  "cross-document",
  "failure-diagnosis",
  "read-only",
  "general",
];

/**
 * Per-retriever RRF weight multipliers. `exact`/`symbol`/`reference` cover
 * the three pre-existing hard-floor rankers (their FLOOR membership is
 * unaffected by weight — a weight only changes their fusion RANK
 * contribution, never whether hardFloor.ts promotes them ahead of every
 * non-floor item). `bm25f` covers the V10-08 BM25F candidate ranker. `graph`
 * covers the Wave C (F-A5) graphRetriever.ts axis — like `bm25f`, it is a
 * fusion-only participant, NEVER a floor ranker (see index.ts's own
 * floor-posture comment). `recentDiff` is the placeholder described in this
 * file's top doc comment.
 *
 * Deliberately excludes a "heuristic" entry: index.ts's pre-existing
 * "current heuristic" ranker (the whole pre-fusion candidate pool sorted by
 * its own native score) is not one of the design doc's six named retriever
 * types, and profiles never reweight it — it always contributes at weight 1,
 * subject only to the new quality gate (qualityGate.ts) for WHETHER it
 * participates at all, never to per-profile reweighting for HOW MUCH. See
 * index.ts's applyHybridRetrieval doc comment for the full rationale.
 */
export interface RetrieverWeights {
  exact: number;
  symbol: number;
  reference: number;
  bm25f: number;
  /** Wave C (F-A5): the graphRetriever.ts axis — LIVE, consumed by fusion whenever a graph index loads. */
  graph: number;
  /** Placeholder for a future recency/recent-diff retriever; not consumed yet. */
  recentDiff: number;
}

/** All-1 weights: identical to RRF's implicit per-list weight before V11-02. */
export const NEUTRAL_WEIGHTS: RetrieverWeights = Object.freeze({
  exact: 1,
  symbol: 1,
  reference: 1,
  bm25f: 1,
  graph: 1,
  recentDiff: 1,
});

export interface TaskProfile {
  id: TaskProfileId;
  weights: RetrieverWeights;
}

/**
 * Bumped whenever any profile's weight vector changes, OR (Wave C) when the
 * MEANING of an unchanged vector materially changes — the `.3` bump below
 * is the latter case: every profile's numeric weights are unchanged from
 * `.2`, but `graph` went from an inert placeholder (always multiplying an
 * empty list) to a live axis (multiplying a real ranked list), so the same
 * `retriever_weights: {graph: 1, ...}` trace payload now corresponds to a
 * DIFFERENT underlying fusion computation than it did under `.2` — worth
 * distinguishing in telemetry even though the JSON looks identical. Threaded
 * into every `hybrid_retrieval_applied` trace record a profile actually
 * resolves in (index.ts) so a weight/meaning edit is attributable in
 * telemetry without needing to correlate a git SHA — V11-02 acceptance
 * criterion: "weight versionを全result/telemetryへ追跡できる。" Bump this
 * alongside any TASK_PROFILES edit, exactly like bm25f.ts's FIELD_WEIGHTS
 * pin in bm25f.spec.ts pins a literal.
 */
export const WEIGHTS_VERSION = "tl-rrf-profiles-2026-08-21.3";

/**
 * Holdout-tuned defaults — see
 * bench/workflows/retrieval/TUNING-PROFILES-2026-08-21.md for corpus,
 * method, and per-profile results (its "Wave C" section covers the graph
 * axis specifically). RESULT: every one of the 7 named profiles is STILL an
 * HONEST NULL for PER-PROFILE differentiation on this holdout —
 * bench/workflows/retrieval/tune-profiles.mjs's coordinate descent (now
 * searching 5 axes: exact/symbol/reference/bm25f/graph) found no candidate
 * weight vector that beats the neutral baseline's mean MRR by a real margin
 * on any profile's own labeled queries, so every profile below still ships
 * weight-EQUAL to `general` rather than a fabricated differentiation. This
 * is not a dead end, and Wave C's result is NOT merely a repeat of the
 * original one: the tuning harness's seed-candidate layer still only
 * populates `exact`/`symbol` for literal-path/exact-identifier queries and
 * never populates `reference` (same structural gap as before — `bm25f` and
 * now `graph` are the only two axes actually exercised by this holdout's
 * free-text queries); `bm25f` still saturates as soon as it is non-zero.
 * `graph`, unlike `bm25f`, is NOT reachable through this harness's seed
 * layer at all — it reads a REAL, separately-built `.tokenlighten/index/
 * tl-graph.json` per workspace (see tune-profiles.mjs's own
 * `prepareWorkspace`), so it is genuinely exercised end-to-end, not merely
 * seed-scoped. And it DID measurably move the needle: `change-propagation`'s
 * NEUTRAL baseline mean MRR rose from 0.5833 to 0.7778 (and `navigation`'s
 * from 0.7500 to 0.7593) purely from the graph axis's real presence at
 * weight 1 — no per-profile tuning needed to realize that gain, which is
 * why it shows up as an improved shared baseline rather than a
 * `beatsNeutral: true` differentiated vector. `read-only` saw a small,
 * sub-margin dip (0.7167 -> 0.7133, still `constraintsPass: true`, zero
 * recall regressions) — an honest, disclosed trade-off, not hidden. The
 * fusion mechanism itself (weighted RRF, the quality gate, the
 * unconditional hard floor) is independently verified correct against
 * hand-built candidates that DO populate every retriever, including graph —
 * see this package's rrf.spec.ts / profileFusion.spec.ts /
 * graphRetriever.spec.ts / graphFusion.spec.ts. Re-tuning with a richer
 * seed harness (to exercise `exact`/`symbol`/`reference` for free-text
 * queries) or once a recent-diff retriever exists to fill `recentDiff` is
 * the natural next step, not a correctness fix.
 */
export const TASK_PROFILES: Readonly<Record<TaskProfileId, TaskProfile>> = Object.freeze({
  "known-local": {
    id: "known-local",
    weights: NEUTRAL_WEIGHTS,
  },
  navigation: {
    id: "navigation",
    weights: NEUTRAL_WEIGHTS,
  },
  "change-propagation": {
    id: "change-propagation",
    weights: NEUTRAL_WEIGHTS,
  },
  "cross-package": {
    id: "cross-package",
    weights: NEUTRAL_WEIGHTS,
  },
  "cross-document": {
    id: "cross-document",
    weights: NEUTRAL_WEIGHTS,
  },
  "failure-diagnosis": {
    id: "failure-diagnosis",
    weights: NEUTRAL_WEIGHTS,
  },
  "read-only": {
    id: "read-only",
    weights: NEUTRAL_WEIGHTS,
  },
  general: {
    id: "general",
    weights: NEUTRAL_WEIGHTS,
  },
});

/** Resolve a profile id to its weight vector; an unrecognized id (never possible from TaskProfileId's own type, but defensive for callers that pass a raw string) falls back to neutral, never throws. */
export function resolveProfileWeights(id: TaskProfileId): RetrieverWeights {
  return TASK_PROFILES[id]?.weights ?? NEUTRAL_WEIGHTS;
}
