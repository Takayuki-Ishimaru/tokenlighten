// ---------------------------------------------------------------------------
// graph-evidence/impact.ts — V11-01 Impact Analysis v1.
//
// Given a seed (symbol, file, or document section), produce the bounded set of
// surfaces a change to that seed plausibly touches, each classified
// `required` / `likely` / `informational` (plan §V11-01 実装内容, bullet 4).
//
// THE TIER RULES, IN ONE PLACE
// ----------------------------
// A node's tier is decided by the STRONGEST PATH that reaches it, and a path
// is only as strong as its weakest edge:
//
//   pure `direct` path                                  → required
//   path whose weakest edge is `structural`, and every
//     structural edge on it carries an exact-symbol
//     correspondence                                    → required
//   path whose weakest edge is `structural` otherwise   → likely
//   any path containing a `heuristic` edge              → informational
//
// So `heuristic` evidence can NEVER produce `required` — not directly, and not
// by being laundered through a direct hop further along the chain, because the
// weakest-edge rule caps the whole path. Depth demotes but never promotes:
// beyond `requiredMaxDepth` a `required` node becomes `likely`.
//
// AND IT CAN NEVER CLOSE
// ----------------------
// `ImpactResult.closure` is computed from provider coverage, truncation, and
// staleness — never from the presence of heuristic candidates. The exported
// `canSupportClosure()` (model.ts) is the predicate a wave-B consumer must ask
// before treating any of this as an obligation-closing fact.
//
// BOUNDED BY CONSTRUCTION. `bounds` is a required argument; there is no
// unbounded mode. Truncation is reported with counts per reason and degrades
// coverage to `partial`.
// ---------------------------------------------------------------------------

import { BoundTracker, coverageUnderTruncation, type ExpansionBounds, type TruncationReport } from "./bounds.js";
import { EdgeDeriver } from "./edges.js";
import {
  canSupportClosure,
  compareEdges,
  edgeCanSupportRequired,
  edgeId,
  evidenceClassRank,
  fileNode,
  nodeId,
  sectionNode,
  symbolNode,
  weakerClass,
  weakerCoverage,
  type Coverage,
  type EvidenceClass,
  type GraphEdge,
  type GraphEdgeType,
  type GraphNode,
  type GraphNodeKind,
  type NodeProof,
} from "./model.js";
import {
  aggregateProviderCoverage,
  providerIdentities,
  type ProviderIdentity,
  type ProviderSet,
} from "./providers.js";
import { filterStaleEdges, mergeStaleReports, EMPTY_STALE_REPORT, type GenerationView, type StaleReport } from "./stale.js";

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface ImpactSeed {
  readonly kind: GraphNodeKind;
  readonly path: string;
  readonly symbol?: string;
  readonly symbolKind?: string;
  readonly line?: number;
  readonly section?: string;
  /** Overrides the proof resolved from the providers. */
  readonly proof?: NodeProof;
}

export interface ImpactOptions {
  readonly seeds: readonly ImpactSeed[];
  readonly providers: ProviderSet;
  /** Mandatory. See bounds.ts — there is no unbounded default. */
  readonly bounds: ExpansionBounds;
  /** The freshness oracle. Absent keys fail closed (stale.ts). */
  readonly generations: GenerationView;
  /** Restrict derivation to these edge types. Defaults to all ten. */
  readonly edgeTypes?: readonly GraphEdgeType[];
  /** Beyond this hop distance `required` demotes to `likely`. Defaults to maxDepth. */
  readonly requiredMaxDepth?: number;
  /** Injected clock for the duration bound. */
  readonly now?: () => number;
  /** Estimated served cost of a node, charged against `maxBytes`. */
  readonly byteCostOf?: (node: GraphNode) => number;
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

export type ImpactTier = "required" | "likely" | "informational";

export const IMPACT_TIERS: readonly ImpactTier[] = ["required", "likely", "informational"];

const TIER_ORDER: Readonly<Record<ImpactTier, number>> = {
  required: 0,
  likely: 1,
  informational: 2,
};

export interface ImpactNodeResult {
  readonly node: GraphNode;
  readonly tier: ImpactTier;
  /** Hop distance along the strongest path that reached it. */
  readonly depth: number;
  /** Weakest edge class on that path. */
  readonly evidenceClass: EvidenceClass;
  /** Every distinct endpoint proof observed for this identity — never merged away. */
  readonly proofs: readonly NodeProof[];
  /** Bounded sample of the edges that reached it, strongest first. */
  readonly via: readonly GraphEdge[];
  readonly reason: string;
}

export interface ClosureVerdict {
  /** May this result close an obligation / assert completeness? */
  readonly canClose: boolean;
  readonly reasons: readonly string[];
}

export interface ImpactResult {
  readonly seeds: readonly GraphNode[];
  readonly nodes: readonly ImpactNodeResult[];
  /** Every fresh edge admitted, deterministically ordered. Contains no stale edge. */
  readonly edges: readonly GraphEdge[];
  readonly counts: Readonly<Record<ImpactTier, number>>;
  readonly coverage: Coverage;
  readonly coverageReasons: readonly string[];
  readonly truncation: TruncationReport;
  readonly stale: StaleReport;
  readonly providers: readonly ProviderIdentity[];
  readonly closure: ClosureVerdict;
}

/** Per-node cap on the recorded `via` sample. */
export const MAX_VIA_EDGES = 8;

function defaultByteCost(node: GraphNode): number {
  return nodeId(node).length + 64;
}

// ---------------------------------------------------------------------------
// Path strength lattice
// ---------------------------------------------------------------------------

interface PathStrength {
  readonly cls: EvidenceClass;
  readonly requiredEligible: boolean;
}

const SEED_STRENGTH: PathStrength = { cls: "direct", requiredEligible: true };

function strengthRank(strength: PathStrength): number {
  return evidenceClassRank(strength.cls) * 2 + (strength.requiredEligible ? 1 : 0);
}

function composeStrength(strength: PathStrength, edge: GraphEdge): PathStrength {
  return {
    cls: weakerClass(strength.cls, edge.evidenceClass),
    requiredEligible: strength.requiredEligible && edgeCanSupportRequired(edge),
  };
}

function tierFor(strength: PathStrength, depth: number, requiredMaxDepth: number): ImpactTier {
  if (depth === 0) return "required";
  if (strength.cls === "heuristic") return "informational";
  if (strength.requiredEligible && depth <= requiredMaxDepth) return "required";
  return "likely";
}

function reasonFor(strength: PathStrength, depth: number, tier: ImpactTier): string {
  if (depth === 0) return "seed";
  if (tier === "informational") return "heuristic-path";
  if (tier === "required") return strength.cls === "direct" ? "direct-path" : "structural-path-corroborated";
  return strength.cls === "structural" ? "structural-path-uncorroborated" : "beyond-required-depth";
}

// ---------------------------------------------------------------------------
// Traversal state
// ---------------------------------------------------------------------------

interface VisitState {
  node: GraphNode;
  strength: PathStrength;
  depth: number;
  readonly proofs: Set<NodeProof>;
  readonly via: GraphEdge[];
}

interface QueueItem {
  readonly node: GraphNode;
  readonly depth: number;
  readonly strength: PathStrength;
}

/**
 * Safety net only. The strength lattice is monotone and has six levels, so a
 * node can be re-enqueued at most six times; this bound cannot be reached by
 * a well-formed provider set and exists so a malformed one cannot spin.
 */
const RELAXATIONS_PER_NODE = 8;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function analyzeImpact(options: ImpactOptions): ImpactResult {
  const tracker = new BoundTracker({ bounds: options.bounds, ...(options.now ? { now: options.now } : {}) });
  const byteCostOf = options.byteCostOf ?? defaultByteCost;
  const requiredMaxDepth = options.requiredMaxDepth ?? options.bounds.maxDepth;
  const deriver = new EdgeDeriver({
    providers: options.providers,
    tracker,
    ...(options.edgeTypes ? { edgeTypes: options.edgeTypes } : {}),
  });

  const seedNodes = options.seeds.flatMap((seed) => resolveSeed(seed, options.providers));
  const visited = new Map<string, VisitState>();
  const admittedEdges = new Map<string, GraphEdge>();
  const derivedCache = new Map<string, readonly GraphEdge[]>();
  let stale: StaleReport = EMPTY_STALE_REPORT;
  const queue: QueueItem[] = [];

  for (const node of seedNodes) {
    const id = nodeId(node);
    if (visited.has(id)) continue;
    if (!tracker.admitNode(byteCostOf(node), id)) continue;
    visited.set(id, { node, strength: SEED_STRENGTH, depth: 0, proofs: new Set([node.proof]), via: [] });
    queue.push({ node, depth: 0, strength: SEED_STRENGTH });
  }

  const dequeueBudget = options.bounds.maxNodes * RELAXATIONS_PER_NODE + seedNodes.length;
  let dequeues = 0;

  while (queue.length > 0) {
    if (dequeues >= dequeueBudget) break;
    if (tracker.expired()) break;
    const item = queue.shift();
    if (item === undefined) break;
    dequeues += 1;

    const fromId = nodeId(item.node);
    const nextDepth = item.depth + 1;
    if (!tracker.admitDepth(nextDepth, fromId)) continue;

    let edges = derivedCache.get(fromId);
    if (edges === undefined) {
      const derived = deriver.edgesFor(item.node);
      // Staleness is enforced BEFORE the frontier sees an edge, so a stale
      // relation cannot even influence which nodes are expanded.
      const filtered = filterStaleEdges(derived, options.generations);
      stale = mergeStaleReports(stale, filtered.report);
      edges = tracker.limitFanout([...filtered.fresh].sort(compareEdges), fromId);
      derivedCache.set(fromId, edges);
    }

    for (const edge of edges) {
      const neighbor = otherEndpoint(edge, fromId);
      if (neighbor === undefined) continue;
      const neighborId = nodeId(neighbor);
      const strength = composeStrength(item.strength, edge);
      const existing = visited.get(neighborId);

      if (existing === undefined) {
        if (!tracker.admitNode(byteCostOf(neighbor), neighborId)) continue;
        admittedEdges.set(edgeKey(edge), edge);
        visited.set(neighborId, {
          node: neighbor,
          strength,
          depth: nextDepth,
          proofs: new Set([neighbor.proof]),
          via: [edge],
        });
        queue.push({ node: neighbor, depth: nextDepth, strength });
        continue;
      }

      admittedEdges.set(edgeKey(edge), edge);
      existing.proofs.add(neighbor.proof);
      recordVia(existing.via, edge);
      if (strengthRank(strength) > strengthRank(existing.strength)) {
        existing.strength = strength;
        existing.depth = nextDepth;
        queue.push({ node: neighbor, depth: nextDepth, strength });
      } else if (nextDepth < existing.depth && strengthRank(strength) === strengthRank(existing.strength)) {
        existing.depth = nextDepth;
      }
    }
  }

  return assemble({
    seedNodes,
    visited,
    edges: [...admittedEdges.values()].sort(compareEdges),
    truncation: tracker.report(),
    stale,
    providers: options.providers,
    requiredMaxDepth,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Identity for de-duplication. Deliberately `edgeId` — WITHOUT the rule name —
 * so the same relation derived from both of its endpoints (a path provider
 * proposes a test link from the subject and from the test) collapses to one
 * edge instead of two near-identical ones.
 */
function edgeKey(edge: GraphEdge): string {
  return edgeId(edge);
}

function otherEndpoint(edge: GraphEdge, fromId: string): GraphNode | undefined {
  const a = nodeId(edge.from);
  const b = nodeId(edge.to);
  if (a === fromId && b === fromId) return undefined;
  if (a === fromId) return edge.to;
  if (b === fromId) return edge.from;
  // Neither endpoint is the expanded node: the provider returned an edge it was
  // not asked about. Ignore it rather than teleporting the traversal.
  return undefined;
}

function recordVia(via: GraphEdge[], edge: GraphEdge): void {
  if (via.some((existing) => edgeKey(existing) === edgeKey(edge))) return;
  via.push(edge);
  via.sort((a, b) => {
    const byClass = evidenceClassRank(b.evidenceClass) - evidenceClassRank(a.evidenceClass);
    if (byClass !== 0) return byClass;
    return compareEdges(a, b);
  });
  if (via.length > MAX_VIA_EDGES) via.length = MAX_VIA_EDGES;
}

/**
 * A symbol seed also seeds its CONTAINING FILE, at depth 0. Without it the
 * file-level surfaces the plan asks for — tests, config, generated output —
 * would be unreachable from a symbol seed, because those edges are derived at
 * file granularity. It is a companion seed, not a hop, so it costs no depth.
 */
function resolveSeed(seed: ImpactSeed, providers: ProviderSet): readonly GraphNode[] {
  if (seed.kind === "section") {
    return [sectionNode(seed.path, seed.section ?? "", seed.proof ?? "path")];
  }
  if (seed.kind === "file") {
    return [fileNode(seed.path, seed.proof ?? "path")];
  }

  const symbol = seed.symbol ?? "";
  const declaration = providers.symbols
    ?.declarationsIn(seed.path)
    .find((candidate) => candidate.name === symbol);
  const definition = providers.references?.definitionOf(symbol);
  const proof: NodeProof =
    seed.proof ?? declaration?.proof ?? (definition !== undefined ? definition.proof : "path");

  const node = symbolNode(seed.path, symbol, proof, {
    ...(seed.symbolKind ?? declaration?.kind ? { symbolKind: seed.symbolKind ?? declaration?.kind } : {}),
    ...(seed.line ?? declaration?.line ? { line: seed.line ?? declaration?.line } : {}),
  });
  // The companion is a FILE node with a path proof: a file's identity is a
  // path fact, and claiming a parser proof for it would be a claim about the
  // file that no provider made.
  return [node, fileNode(seed.path, "path")];
}

interface AssembleInput {
  readonly seedNodes: readonly GraphNode[];
  readonly visited: ReadonlyMap<string, VisitState>;
  readonly edges: readonly GraphEdge[];
  readonly truncation: TruncationReport;
  readonly stale: StaleReport;
  readonly providers: ProviderSet;
  readonly requiredMaxDepth: number;
}

function assemble(input: AssembleInput): ImpactResult {
  const nodes: ImpactNodeResult[] = [];
  const counts: Record<ImpactTier, number> = { required: 0, likely: 0, informational: 0 };

  for (const state of input.visited.values()) {
    const tier = tierFor(state.strength, state.depth, input.requiredMaxDepth);
    counts[tier] += 1;
    nodes.push({
      node: state.node,
      tier,
      depth: state.depth,
      evidenceClass: state.strength.cls,
      proofs: [...state.proofs].sort(),
      via: [...state.via],
      reason: reasonFor(state.strength, state.depth, tier),
    });
  }

  nodes.sort((a, b) => {
    const byTier = TIER_ORDER[a.tier] - TIER_ORDER[b.tier];
    if (byTier !== 0) return byTier;
    const byDepth = a.depth - b.depth;
    if (byDepth !== 0) return byDepth;
    return nodeId(a.node).localeCompare(nodeId(b.node));
  });

  const coverageReasons: string[] = [];
  const providerCoverage = aggregateProviderCoverage(input.providers);
  if (providerCoverage !== "complete") {
    coverageReasons.push(`provider-coverage:${providerCoverage}`);
  }
  let coverage = coverageUnderTruncation(providerCoverage, input.truncation);
  if (input.truncation.truncated) coverageReasons.push("truncated");
  if (input.stale.excluded > 0) {
    coverage = weakerCoverage(coverage, "partial");
    coverageReasons.push(`stale-edges-excluded:${input.stale.excluded}`);
  }

  return {
    seeds: input.seedNodes,
    nodes,
    edges: input.edges,
    counts,
    coverage,
    coverageReasons,
    truncation: input.truncation,
    stale: input.stale,
    providers: providerIdentities(input.providers),
    closure: closureVerdict(coverage, input.truncation, input.stale),
  };
}

/**
 * Closure rests on provider coverage, an untruncated expansion, and a clean
 * staleness check — never on the presence of candidates. Heuristic evidence
 * contributes nothing here, which is the plan's "heuristic edge 単独では
 * obligation closure、complete、Stop 候補を成立させない" invariant stated as code.
 */
function closureVerdict(
  coverage: Coverage,
  truncation: TruncationReport,
  stale: StaleReport,
): ClosureVerdict {
  const reasons: string[] = [];
  if (coverage !== "complete") reasons.push(`coverage:${coverage}`);
  if (truncation.truncated) reasons.push("truncated");
  if (stale.excluded > 0) reasons.push("stale-edges-excluded");
  return { canClose: reasons.length === 0, reasons };
}

/**
 * The set-level fence for a SINGLE claim, re-exported at impact level so a
 * consumer holding only the supporting edges of one obligation does not have
 * to reach into model.ts to ask the question correctly.
 */
export function supportsClosure(support: readonly GraphEdge[]): boolean {
  return support.some((edge) => canSupportClosure(edge.evidenceClass));
}

/** Nodes in one tier, in result order. */
export function nodesInTier(result: ImpactResult, tier: ImpactTier): readonly ImpactNodeResult[] {
  return result.nodes.filter((node) => node.tier === tier);
}
