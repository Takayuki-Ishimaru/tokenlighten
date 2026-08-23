// ---------------------------------------------------------------------------
// compound/compoundRetrieval.ts — V11-05 Compound Retrieval: the bounded
// read-only hop engine.
//
// NORMATIVE SOURCE: DESIGN-v0.10-expansion-plan-v1.3.md §"V11-05. Compound
// Retrieval / Bounded Hop Closure", bounded by
// DESIGN-v0.11-expansion-plan-reconciliation.md §3 (V11-05 row) and deviation
// E-2 (rides the frozen read.task_pack shape; hop mechanics stay internal).
//
// WHAT THIS FILE IS
// ------------------
// A PURE, provider-injected wrapper around graph-evidence's `analyzeImpact`
// (features/graph-evidence/impact.ts) — realizing the plan's
// "definition→references→consumer→test/config" hop chain as ONE bounded
// expansion from a single seed, then applying V11-05's own, STRICTER rules on
// top of graph-evidence's tier/coverage machinery:
//
//   * a fixed, conservative bound set (this file's own constants — never the
//     caller's choice, so a locator seam cannot accidentally widen the hop);
//   * two decline conditions this engine can prove on its own (no usable
//     provider at all; a non-empty stale report) — see `runCompoundRetrieval`;
//   * tier -> disposition mapping (`required` eligible to WIRE as a candidate,
//     `likely` inventory-only, `informational` trace-only — plan's `実装内容`
//     bullet 5 "各nodeへstatus...を持たせる" plus PI-02's coverage posture).
//
// WHAT THIS FILE IS NOT
// ----------------------
//  * NOT aware of the repository. No filesystem, no tl-graph, no locator
//    candidate pool — `adapters.ts` binds real providers and extracts a seed
//    from the locator's already-resolved `primary`; this file only sees the
//    graph-evidence provider/seed/bounds vocabulary, exactly like
//    graph-evidence's own engine files stay unaware of the repository.
//  * NOT the semantic-branch check. "Two plausible distinct definition seeds"
//    is a LOCATOR-POOL question (does more than one candidate file claim the
//    same symbol name?) that this engine has no visibility into; that decline
//    is decided by `adapters.ts`/`index.ts` BEFORE this function is ever
//    called — see those files' headers.
//  * NOT a write, shell, or network surface — it only reads through the
//    injected `ProviderSet`, matching graph-evidence's own read-only posture
//    and the plan's "write／shell／networkを許可しない" requirement.
// ---------------------------------------------------------------------------

import {
  analyzeImpact,
  providerList,
  type GenerationView,
  type GraphNode,
  type ExpansionBounds,
  type ImpactResult,
  type ImpactSeed,
  type ImpactTier,
  type ProviderSet,
  type TruncationReport,
} from "../graph-evidence/index.js";

// ---------------------------------------------------------------------------
// Bounds — internal constants, never caller-configurable (plan: "max_nodes /
// max_depth / max_fanout / max_bytes / max_duration を必須にする").
// ---------------------------------------------------------------------------

/**
 * Hop distance from the seed. 2 covers the plan's full chain in ONE call —
 * depth 1 is direct references/importers/tests-of-the-seed-file, depth 2
 * reaches "representative consumers" (a caller of a direct reference) and a
 * test/config file one hop further out — without opening a THIRD hop's worth
 * of transitive fan-out, which is where a hub file turns a bounded closure
 * into an unbounded one.
 */
export const COMPOUND_MAX_DEPTH = 2;

/**
 * Edges followed out of any single node. 8 is generous enough for a normal
 * module's reference/import/test fan-out while keeping a hub file (a widely
 * imported utility, a central type) from single-handedly consuming the whole
 * node budget at depth 1 and starving depth 2 of anything to reach.
 */
export const COMPOUND_MAX_FANOUT = 8;

/**
 * Total distinct nodes admitted, seed included. Small enough that a compound
 * response stays a handful of candidate/inventory entries (this engine feeds
 * `related`, which is itself capped well below this by the locator and the
 * LOCATE_SUCCESS_CAP byte budget downstream) while comfortably covering a
 * cross-cutting task's definition + direct references + a few consumers +
 * its test/config surface.
 */
export const COMPOUND_MAX_NODES = 48;

/** Estimated served-cost budget, mirroring graph-evidence's own byte accounting. */
export const COMPOUND_MAX_BYTES = 64 * 1024;

/**
 * Wall-clock ceiling for the whole expansion. Compound retrieval sits inline
 * on the locate() hot path — this is a small fraction of a typical locate()
 * call's own budget, so a slow provider set degrades to a truncated (still
 * `partial`, never silently "complete") result rather than measurably
 * slowing down every locate() call.
 */
export const COMPOUND_MAX_DURATION_MS = 250;

export const COMPOUND_BOUNDS: ExpansionBounds = {
  maxNodes: COMPOUND_MAX_NODES,
  maxDepth: COMPOUND_MAX_DEPTH,
  maxFanout: COMPOUND_MAX_FANOUT,
  maxBytes: COMPOUND_MAX_BYTES,
  maxDurationMs: COMPOUND_MAX_DURATION_MS,
};

// ---------------------------------------------------------------------------
// Decline reasons this engine can prove on its own
// ---------------------------------------------------------------------------

/**
 * `semantic-branch` is listed here for a complete vocabulary (it rides the
 * same trace field as the other two), but this engine never PRODUCES it —
 * only `adapters.ts`/`index.ts` do, before ever calling `runCompoundRetrieval`
 * (see this file's header).
 */
export type CompoundDeclineReason = "semantic-branch" | "stale-evidence" | "provider-incomplete";

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface CompoundRetrievalInput {
  /** The single seed to hop from — already disambiguated by the caller. */
  readonly seed: ImpactSeed;
  readonly providers: ProviderSet;
  /** The freshness oracle graph-evidence's staleness check needs. */
  readonly generations: GenerationView;
  /** Injected clock, threaded straight to graph-evidence's BoundTracker. */
  readonly now?: () => number;
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

/**
 * One discovered (non-seed) surface, flattened to exactly what a consumer
 * needs to mint a candidate or a trace entry — `adapters.ts` maps `required`/
 * `likely` nodes onto `ImpactCandidate`s and folds ALL THREE tiers into the
 * trace summary, never wiring an `informational` one (plan 実装内容 bullet 2 /
 * this file's header).
 */
export interface CompoundNode {
  readonly tier: ImpactTier;
  readonly path: string;
  /** 1-based declaration/reference line when the node is symbol-shaped; 1 for a file-level node. */
  readonly line: number;
  readonly symbol?: string;
  readonly depth: number;
  readonly reason: string;
}

export interface CompoundAppliedResult {
  readonly applied: true;
  readonly seeds: readonly GraphNode[];
  readonly nodes: readonly CompoundNode[];
  readonly counts: Readonly<Record<ImpactTier, number>>;
  /**
   * PI-02: mirrors graph-evidence's OWN `coverage !== "complete"` — truncated,
   * provider coverage `partial`/`unknown`, or stale exclusions all land here.
   * A caller must never let `partial: false` (or anything else in this
   * result) upgrade a completeness/absence claim beyond what graph-evidence
   * itself proved; `partial: true` must propagate, never get silently dropped.
   */
  readonly partial: boolean;
  readonly partialReasons: readonly string[];
  readonly truncation: TruncationReport;
}

export interface CompoundDeclinedResult {
  readonly applied: false;
  readonly reason: CompoundDeclineReason;
  readonly detail: string;
}

export type CompoundRetrievalResult = CompoundAppliedResult | CompoundDeclinedResult;

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/**
 * Run ONE bounded hop expansion from `input.seed` and classify the result.
 *
 * Decline conditions this function enforces directly (plan 実装内容 bullet 4:
 * "semantic branch、unexpected observation、provider incompleteで停止し
 * hostへ返す"):
 *
 *   * `provider-incomplete` — the provider set is EMPTY (no reference, import,
 *     or path-heuristics provider at all — e.g. no graph index exists). This
 *     is deliberately narrower than "coverage isn't complete": a tl-graph-
 *     backed provider set honestly claims `unknown` coverage by default (its
 *     rootHash is never cross-checked against the live manifest — see
 *     graph-evidence/adapters.ts), and that is the ROUTINE case, not a
 *     reason to contribute nothing — it is reported as `partial` instead. A
 *     provider set with nothing in it at all cannot derive a single edge, so
 *     there is nothing honest to offer.
 *   * `stale-evidence` — `analyzeImpact` excluded at least one edge as stale
 *     (`result.stale.excluded > 0`). An "unexpected observation" in the
 *     plan's words: the caller's own freshness oracle disagrees with
 *     something the providers proposed, which this engine treats as reason
 *     enough to hand back nothing rather than build required-tier candidates
 *     on a foundation it just caught lying once.
 *
 * `semantic-branch` never originates here — see this file's header.
 */
export function runCompoundRetrieval(input: CompoundRetrievalInput): CompoundRetrievalResult {
  if (providerList(input.providers).length === 0) {
    return {
      applied: false,
      reason: "provider-incomplete",
      detail: "no reference/import/symbol/path-heuristics provider is available",
    };
  }

  const result = analyzeImpact({
    seeds: [input.seed],
    providers: input.providers,
    bounds: COMPOUND_BOUNDS,
    generations: input.generations,
    ...(input.now ? { now: input.now } : {}),
  });

  if (result.stale.excluded > 0) {
    return {
      applied: false,
      reason: "stale-evidence",
      detail: `${result.stale.excluded} edge(s) failed the freshness re-proof`,
    };
  }

  return assembleApplied(result);
}

// ---------------------------------------------------------------------------
// Result assembly
// ---------------------------------------------------------------------------

function assembleApplied(result: ImpactResult): CompoundAppliedResult {
  const nodes: CompoundNode[] = [];
  for (const entry of result.nodes) {
    // The seed itself (and its file-node companion — impact.ts's
    // resolveSeed) is not a DISCOVERED surface; the caller already has it
    // (it is exactly the locator's own `primary`). Every seed is admitted at
    // depth 0 and nothing reached by traversal can be relaxed back to 0
    // (impact.ts's queue only ever enqueues `item.depth + 1 >= 1`), so this
    // check alone is exhaustive.
    if (entry.depth === 0) continue;
    nodes.push({
      tier: entry.tier,
      path: entry.node.path,
      line: entry.node.kind === "symbol" ? (entry.node.line ?? 1) : 1,
      ...(entry.node.kind === "symbol" && entry.node.symbol ? { symbol: entry.node.symbol } : {}),
      depth: entry.depth,
      reason: entry.reason,
    });
  }

  return {
    applied: true,
    seeds: result.seeds,
    nodes,
    counts: result.counts,
    partial: result.coverage !== "complete",
    partialReasons: result.coverageReasons,
    truncation: result.truncation,
  };
}
