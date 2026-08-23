// ---------------------------------------------------------------------------
// compound/index.ts — V11-05 Compound Retrieval: barrel + the ONE seam-facing
// entry point (`applyCompoundRetrieval`) locateTaskContext.ts calls.
//
// Orchestrates, in order:
//   1. no graph index at all -> decline "provider-incomplete" (cheapest exit,
//      never builds a provider or touches the filesystem again).
//   2. semantic-branch pre-check on a symbol seed (adapters.ts's
//      detectSemanticBranchPaths, over the LOCATOR's own candidate pool) ->
//      decline "semantic-branch" before ever calling the engine.
//   3. build real providers + a freshness oracle (adapters.ts) and run the
//      bounded hop engine (compoundRetrieval.ts) -> it may itself decline
//      "provider-incomplete" (empty provider set) or "stale-evidence".
//   4. on an applied result: drop `informational`-tier nodes (never wired —
//      plan 実装内容 bullet 5), apply the caller's hard scope + dedup against
//      already-served path:line pairs, cap by tier, map to the EXISTING
//      `ImpactCandidate` shape (adapters.ts — no new wire field).
//
// Every path returns a `related` array (possibly empty) plus a `trace`
// payload for `compound_retrieval_applied` — the caller (locateTaskContext's
// seam) traces UNCONDITIONALLY once both flags gate it in, applied or
// declined, and merges `related` additively (never touching `primary` or any
// pre-existing `related` entry — see the seam's own comment).
// ---------------------------------------------------------------------------

import type { GraphIndex } from "../../graph/index.js";
import {
  addPrefix,
  buildCompoundProviders,
  compoundNodeToCandidate,
  detectSemanticBranchPaths,
  extractCompoundSeed,
  type CompoundCandidateBase,
  type PrimaryLike,
  type SymbolCandidateLike,
} from "./adapters.js";
import {
  runCompoundRetrieval,
  type CompoundDeclineReason,
  type CompoundNode,
} from "./compoundRetrieval.js";

export * from "./compoundRetrieval.js";
export * from "./adapters.js";

// ---------------------------------------------------------------------------
// Wire-injection caps (plan 副作用を抑える方法: "inventoryとbodyを分離する" /
// "hard budgetとearly stopを設ける") — independent of, and much smaller than,
// the engine's own COMPOUND_MAX_NODES: this is how many of the DISCOVERED
// nodes actually become `related` entries, per tier. `impact.ts` already
// orders `nodes` required-first then by depth, so a slice keeps the
// strongest, shallowest surfaces in each tier. The LOCATE_SUCCESS_CAP byte
// trim downstream (locateTaskContext.ts) is the final, always-on backstop —
// these caps exist so a wide fan-out doesn't reach that backstop every time.
// ---------------------------------------------------------------------------

export const COMPOUND_MAX_REQUIRED_CANDIDATES = 8;
export const COMPOUND_MAX_LIKELY_CANDIDATES = 8;

// ---------------------------------------------------------------------------
// Seam input / output
// ---------------------------------------------------------------------------

export interface ApplyCompoundRetrievalInput {
  readonly workspace: string;
  /** Already resolved by the caller (locateTaskContext's resolveNestedGraphIndex) — never re-resolved here. */
  readonly graphIndex: GraphIndex | undefined;
  readonly rootPrefix: string;
  /** Workspace-relative file inventory (the locator's memoized WalkCache). */
  readonly files: readonly string[];
  readonly primary: PrimaryLike;
  /** The locator's own (pre-ranking) candidate pool — semantic-branch detection only, never re-ranked. */
  readonly candidates: readonly SymbolCandidateLike[];
  /** The caller's explicit hard scope, when set — same rule as every other related-candidate expansion in locateTaskContext.ts. */
  readonly scope?: string;
  /** `path:line` keys already present in `primary`/`related` — compound never re-adds one of these. */
  readonly seenPathLine: ReadonlySet<string>;
}

export interface ApplyCompoundRetrievalResult {
  readonly related: readonly CompoundCandidateBase[];
  readonly trace: Record<string, unknown>;
}

export function applyCompoundRetrieval(input: ApplyCompoundRetrievalInput): ApplyCompoundRetrievalResult {
  const seed = extractCompoundSeed(input.primary, input.rootPrefix);
  const seedTraceEntry = {
    kind: seed.kind,
    path: addPrefix(seed.path, input.rootPrefix),
    ...(seed.symbol ? { symbol: seed.symbol } : {}),
  };

  if (input.graphIndex === undefined) {
    return declined("provider-incomplete", "no graph index is available for this workspace/root", seedTraceEntry);
  }

  if (input.primary.symbol) {
    const branchPaths = detectSemanticBranchPaths(input.primary.symbol, input.candidates);
    if (branchPaths.length >= 2) {
      return declined(
        "semantic-branch",
        `${branchPaths.length} distinct files declare "${input.primary.symbol}": ${branchPaths.join(", ")}`,
        seedTraceEntry,
      );
    }
  }

  const { providers, generations } = buildCompoundProviders({
    workspace: input.workspace,
    graphIndex: input.graphIndex,
    rootPrefix: input.rootPrefix,
    files: input.files,
  });

  const result = runCompoundRetrieval({ seed, providers, generations });

  if (!result.applied) {
    return declined(result.reason, result.detail, seedTraceEntry);
  }

  const related = selectCandidates(result.nodes, input.rootPrefix, input.scope, input.seenPathLine);
  const depths = new Set(result.nodes.map((node) => node.depth));

  return {
    related,
    trace: {
      seeds: [seedTraceEntry],
      status: "applied",
      nodes_expanded: result.nodes.length,
      nodes_wired: related.length,
      tiers: result.counts,
      partial: result.partial,
      partial_reasons: result.partialReasons,
      truncation_reasons: truncationReasonsOf(result.truncation),
      estimated_hops_collapsed: depths.size,
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function declined(
  reason: CompoundDeclineReason,
  detail: string,
  seedTraceEntry: Record<string, unknown>,
): ApplyCompoundRetrievalResult {
  return {
    related: [],
    trace: {
      seeds: [seedTraceEntry],
      status: "declined",
      decline_reason: reason,
      detail,
      nodes_expanded: 0,
      nodes_wired: 0,
      tiers: { required: 0, likely: 0, informational: 0 },
      partial: true,
      partial_reasons: [reason],
      truncation_reasons: [],
      estimated_hops_collapsed: 0,
    },
  };
}

function truncationReasonsOf(truncation: { readonly counts: Readonly<Record<string, number>> }): string[] {
  return Object.entries(truncation.counts)
    .filter(([, count]) => count > 0)
    .map(([reason]) => reason);
}

/** Never-wire fence for `informational`, caller scope, dedup, and the per-tier cap — in that order. */
function selectCandidates(
  nodes: readonly CompoundNode[],
  rootPrefix: string,
  scope: string | undefined,
  seenPathLine: ReadonlySet<string>,
): CompoundCandidateBase[] {
  const out: CompoundCandidateBase[] = [];
  const seen = new Set(seenPathLine);
  let requiredCount = 0;
  let likelyCount = 0;

  for (const node of nodes) {
    if (node.tier === "informational") continue;
    const candidate = compoundNodeToCandidate(node, rootPrefix);
    if (candidate === undefined) continue;
    if (scope && candidate.path !== scope && !candidate.path.startsWith(`${scope}/`)) continue;
    const key = `${candidate.path}:${candidate.line}`;
    if (seen.has(key)) continue;

    if (node.tier === "required") {
      if (requiredCount >= COMPOUND_MAX_REQUIRED_CANDIDATES) continue;
      requiredCount += 1;
    } else {
      if (likelyCount >= COMPOUND_MAX_LIKELY_CANDIDATES) continue;
      likelyCount += 1;
    }

    seen.add(key);
    out.push(candidate);
  }
  return out;
}
