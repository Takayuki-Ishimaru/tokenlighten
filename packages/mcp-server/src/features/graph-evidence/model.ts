// ---------------------------------------------------------------------------
// graph-evidence/model.ts — V11-01 Graph Evidence Model: typed edges,
// declaration-only node identity, evidence class, and the closure fence.
//
// NORMATIVE SOURCE: DESIGN-v0.10-expansion-plan-v1.3.md §V11-01 ("Graph
// Evidence Model / Impact Analysis v1"), bounded by
// DESIGN-v0.11-expansion-plan-reconciliation.md §1 (protocol v1 freeze), its
// §3 V11-01 row, and deviation E-1 (a DERIVED, bounded, on-demand overlay —
// no daemon, no new persistent store).
//
// WHAT THIS MODULE IS
// -------------------
// The vocabulary the rest of features/graph-evidence/ speaks: the ten edge
// types, node identity, per-edge provenance, and the single classification
// function that decides whether a derived relation is `direct`, `structural`,
// or `heuristic`.
//
// WHAT THIS MODULE IS NOT
// -------------------------
//  * NOT a wire object. Nothing here is serialized. Protocol v1's fifteen
//    kinds are closed; wave A adds no kind, no field, and no tool argument.
//  * NOT a stored graph (E-1). Edges are derived on demand from providers and
//    carry the generation/SHA stamps `stale.ts` needs to discard them.
//  * NOT wired. Wave A ships this tree as a PURE library with zero production
//    importers (the `coveragePacker.ts` precedent). Wave B's compound
//    retrieval (V11-05) and fast-path impact guard (V11-06) are the intended
//    consumers.
//
// THE FENCE
// ---------
// `canSupportClosure()` is the one predicate every future consumer must ask
// before letting graph evidence close an obligation, claim completeness, or
// justify an absence. Heuristic evidence answers `false` — always. And the
// classifier is built so a path/naming provider CANNOT mint a `direct` edge
// even if it claims a semantic relation: `classifyEdge` gates on provider
// kind AND on endpoint proof, independently, so either fence alone suffices.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Edge types
// ---------------------------------------------------------------------------

/**
 * The ten common edge types (plan §V11-01, first 実装内容 bullet). This list is
 * closed: a new relation must be argued for, because every consumer's
 * classification and quota logic is keyed on it.
 */
export type GraphEdgeType =
  | "CALLS"
  | "CALLED_BY"
  | "IMPORTS"
  | "IMPORTED_BY"
  | "REFERENCES"
  | "IMPLEMENTS"
  | "EXTENDS"
  | "TESTED_BY"
  | "CONFIGURES"
  | "GENERATED_FROM";

/** Declaration order — fixed, so any sort keyed on it is stable across runs. */
export const GRAPH_EDGE_TYPES: readonly GraphEdgeType[] = [
  "CALLS",
  "CALLED_BY",
  "IMPORTS",
  "IMPORTED_BY",
  "REFERENCES",
  "IMPLEMENTS",
  "EXTENDS",
  "TESTED_BY",
  "CONFIGURES",
  "GENERATED_FROM",
];

const EDGE_TYPE_ORDER: ReadonlyMap<GraphEdgeType, number> = new Map(
  GRAPH_EDGE_TYPES.map((t, i) => [t, i] as const),
);

export function isGraphEdgeType(value: string): value is GraphEdgeType {
  return EDGE_TYPE_ORDER.has(value as GraphEdgeType);
}

export function edgeTypeOrder(type: GraphEdgeType): number {
  return EDGE_TYPE_ORDER.get(type) ?? GRAPH_EDGE_TYPES.length;
}

/**
 * ORIENTATION CONTRACT. `from`/`to` are read as "from <type> to":
 *
 *   A --CALLS-->         B   A calls B                     (proved by A)
 *   A --CALLED_BY-->     B   A is called by B              (proved by B)
 *   A --IMPORTS-->       B   A imports B                   (proved by A)
 *   A --IMPORTED_BY-->   B   A is imported by B            (proved by B)
 *   A --REFERENCES-->    B   A mentions B's declaration    (proved by A)
 *   A --IMPLEMENTS-->    B   A implements interface B      (proved by A)
 *   A --EXTENDS-->       B   A extends base B              (proved by A)
 *   A --TESTED_BY-->     B   A is exercised by test B      (proved by B)
 *   A --CONFIGURES-->    B   config A configures B         (proved by A)
 *   A --GENERATED_FROM-->B   generated A came from B       (proved by A)
 *
 * "proved by X" names the file whose bytes carry the evidence; that path is
 * recorded on the edge as `sourceShaPath` and its content digest as
 * `sourceSha`, which is what makes the staleness check in `stale.ts`
 * unambiguous for the reversed types.
 *
 * Traversal is INCIDENCE-based (`impact.ts` follows an edge from either
 * endpoint), so no consumer has to special-case a reversed type.
 */
export const INVERSE_EDGE_TYPE: Readonly<Partial<Record<GraphEdgeType, GraphEdgeType>>> = {
  CALLS: "CALLED_BY",
  CALLED_BY: "CALLS",
  IMPORTS: "IMPORTED_BY",
  IMPORTED_BY: "IMPORTS",
};

// ---------------------------------------------------------------------------
// Evidence class
// ---------------------------------------------------------------------------

/**
 * Plan §V11-01: "parser/reference index の semantic edge を direct、import＋
 * exact symbol 等を structural、naming/co-change/path 近接を heuristic とする".
 *
 *  * `direct`     — a semantic assertion by a parser or a reference index.
 *  * `structural` — a proven structural correspondence (a real import edge, an
 *                   exact symbol correspondence). NEVER mere co-occurrence.
 *  * `heuristic`  — naming, path proximity, co-change. Advisory only.
 */
export type EvidenceClass = "direct" | "structural" | "heuristic";

const EVIDENCE_CLASS_RANK: Readonly<Record<EvidenceClass, number>> = {
  direct: 3,
  structural: 2,
  heuristic: 1,
};

export function evidenceClassRank(cls: EvidenceClass): number {
  return EVIDENCE_CLASS_RANK[cls];
}

/** The weaker of two classes — a path is only as strong as its weakest edge. */
export function weakerClass(a: EvidenceClass, b: EvidenceClass): EvidenceClass {
  return EVIDENCE_CLASS_RANK[a] <= EVIDENCE_CLASS_RANK[b] ? a : b;
}

/** The stronger of two classes — a node is as strong as its best path. */
export function strongerClass(a: EvidenceClass, b: EvidenceClass): EvidenceClass {
  return EVIDENCE_CLASS_RANK[a] >= EVIDENCE_CLASS_RANK[b] ? a : b;
}

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

/**
 * Plan §V11-01 副作用を抑える方法: "provider coverage が不明なら complete を禁止
 * する". `unknown` is therefore WEAKER than `partial`: a provider that cannot
 * say what it covered is worse evidence than one that admits it stopped early.
 */
export type Coverage = "complete" | "partial" | "unknown";

const COVERAGE_RANK: Readonly<Record<Coverage, number>> = {
  complete: 3,
  partial: 2,
  unknown: 1,
};

export function weakerCoverage(a: Coverage, b: Coverage): Coverage {
  return COVERAGE_RANK[a] <= COVERAGE_RANK[b] ? a : b;
}

// ---------------------------------------------------------------------------
// Node identity (PI-06 declaration-only posture)
// ---------------------------------------------------------------------------

/**
 * How an endpoint's identity was established. Only `parser` and
 * `reference-index` are SEMANTIC proofs; `regex-fallback` and `path` are
 * explicitly labelled so no consumer can mistake them for parser truth, and
 * `classifyEdge` refuses to mint a `direct` edge that touches one.
 */
export type NodeProof = "parser" | "reference-index" | "regex-fallback" | "path";

export const SEMANTIC_NODE_PROOFS: ReadonlySet<NodeProof> = new Set<NodeProof>([
  "parser",
  "reference-index",
]);

export function isSemanticProof(proof: NodeProof): boolean {
  return SEMANTIC_NODE_PROOFS.has(proof);
}

export type GraphNodeKind = "symbol" | "file" | "section";

/**
 * A graph node. PI-06 posture: a `symbol` node names a DECLARATION, never a
 * usage site — `line` is the declaration line, `symbolKind` the declaration
 * kind. A usage site is a `file` node (or a `section` node for documents),
 * which is why a reference index that only knows the referencing FILE cannot
 * silently pretend to know the referencing symbol.
 */
export interface GraphNode {
  readonly kind: GraphNodeKind;
  /** Workspace-relative path, POSIX separators. */
  readonly path: string;
  /** Declaration name (symbol nodes). */
  readonly symbol?: string;
  /** Declaration kind (symbol nodes) — "function" | "class" | ... */
  readonly symbolKind?: string;
  /** 1-based declaration line (symbol nodes). */
  readonly line?: number;
  /** Section anchor (section nodes). */
  readonly section?: string;
  /** How this identity was established. Never inferred, always carried. */
  readonly proof: NodeProof;
}

export function fileNode(path: string, proof: NodeProof = "path"): GraphNode {
  return { kind: "file", path, proof };
}

export function symbolNode(
  path: string,
  symbol: string,
  proof: NodeProof,
  extra?: { symbolKind?: string; line?: number },
): GraphNode {
  const node: GraphNode = {
    kind: "symbol",
    path,
    symbol,
    proof,
    ...(extra?.symbolKind !== undefined ? { symbolKind: extra.symbolKind } : {}),
    ...(extra?.line !== undefined ? { line: extra.line } : {}),
  };
  return node;
}

export function sectionNode(path: string, section: string, proof: NodeProof = "path"): GraphNode {
  return { kind: "section", path, section, proof };
}

/**
 * Stable identity. Deliberately EXCLUDES `proof`: the same declaration reached
 * through a parser and through a regex fallback is one node, not two. The
 * proof stays on the edge endpoints (each edge keeps its own node objects), so
 * merging identities can never promote a regex-derived endpoint to `direct` —
 * `impact.ts` records every distinct proof it observed for a node instead.
 */
export function nodeId(node: GraphNode): string {
  switch (node.kind) {
    case "symbol":
      return `symbol:${node.path}#${node.symbol ?? ""}`;
    case "section":
      return `section:${node.path}#${node.section ?? ""}`;
    case "file":
      return `file:${node.path}`;
  }
}

// ---------------------------------------------------------------------------
// Providers (kind lives here: it is part of the evidence model, and keeping it
// here is what lets providers.ts depend on model.ts and not the reverse)
// ---------------------------------------------------------------------------

export type ProviderKind = "import-graph" | "reference-index" | "symbol" | "path-heuristics";

/**
 * The provider kinds allowed to assert a SEMANTIC relation. An import graph
 * knows that A imports B, not what that means; a path heuristic knows even
 * less. Neither can produce `direct`, whatever it claims.
 */
export const SEMANTIC_PROVIDER_KINDS: ReadonlySet<ProviderKind> = new Set<ProviderKind>([
  "reference-index",
  "symbol",
]);

/**
 * The strongest class a provider of this kind may ever produce — the CAP that
 * `validateEdge` checks. A path/naming provider tops out at `structural`
 * because another provider's corroboration can lift one of its proposals; it
 * can never reach `direct`, which needs a semantic assertion.
 */
export function maxEvidenceClassFor(kind: ProviderKind): EvidenceClass {
  switch (kind) {
    case "reference-index":
    case "symbol":
      return "direct";
    case "import-graph":
    case "path-heuristics":
      return "structural";
  }
}

/**
 * The class a provider of this kind produces UNAIDED — with no corroboration
 * from any other provider. This, not the cap, is what a coverage report must
 * use: a workspace covered only by path heuristics is a workspace where
 * nothing can close, even though a corroborated path edge could reach
 * `structural` when an import graph happens to agree.
 */
export function unaidedEvidenceClassFor(kind: ProviderKind): EvidenceClass {
  switch (kind) {
    case "reference-index":
    case "symbol":
      return "direct";
    case "import-graph":
      return "structural";
    case "path-heuristics":
      return "heuristic";
  }
}

// ---------------------------------------------------------------------------
// Corroboration
// ---------------------------------------------------------------------------

/**
 * Named, checkable reasons an edge is more than co-occurrence.
 *
 * Only `exact-symbol-match` and `import-edge` are STRUCTURAL corroborations.
 * `basename-mirror`, `path-proximity`, and `declaration-proven` are recorded
 * for telemetry and review but never, on their own, lift an edge out of
 * `heuristic` — which is precisely the "classifier must not emit structural
 * for mere co-occurrence" rule.
 */
export type Corroboration =
  | "exact-symbol-match"
  | "import-edge"
  | "declaration-proven"
  | "basename-mirror"
  | "path-proximity"
  | "co-change";

export const STRUCTURAL_CORROBORATIONS: ReadonlySet<Corroboration> = new Set<Corroboration>([
  "exact-symbol-match",
  "import-edge",
]);

/**
 * The corroboration a STRUCTURAL edge needs before it may put a node in the
 * `required` tier (plan: direct inventory と likely candidates を分離する).
 */
export const REQUIRED_CORROBORATIONS: ReadonlySet<Corroboration> = new Set<Corroboration>([
  "exact-symbol-match",
]);

export function hasStructuralCorroboration(corroboration: readonly Corroboration[]): boolean {
  return corroboration.some((c) => STRUCTURAL_CORROBORATIONS.has(c));
}

// ---------------------------------------------------------------------------
// Edge
// ---------------------------------------------------------------------------

/**
 * One derived, stamped, classified relation.
 *
 * Provenance is carried per EDGE, not per query, because the whole point of
 * E-1's derived overlay is that an edge outlives neither its provider's
 * generation nor its source file's content: `stale.ts` re-proves both before
 * any result is assembled.
 */
export interface GraphEdge {
  readonly type: GraphEdgeType;
  readonly from: GraphNode;
  readonly to: GraphNode;
  readonly evidenceClass: EvidenceClass;
  /** Stable id of the provider that produced this edge. */
  readonly provider: string;
  readonly providerKind: ProviderKind;
  /** Content digest of `sourceShaPath` when the edge was derived. */
  readonly sourceSha: string;
  /** The file whose bytes prove this relation (see INVERSE_EDGE_TYPE's table). */
  readonly sourceShaPath: string;
  /** The producing index's generation when the edge was derived. */
  readonly indexGeneration: string;
  /** What the PROVIDER claims about its own completeness for this relation. */
  readonly coverage: Coverage;
  /** Name of the derivation rule, for review and telemetry. */
  readonly rule: string;
  readonly corroboration: readonly Corroboration[];
  /** Provider ids that supplied the corroboration, when not `provider`. */
  readonly corroboratedBy?: readonly string[];
}

export function edgeId(edge: GraphEdge): string {
  return `${edge.type}|${nodeId(edge.from)}|${nodeId(edge.to)}|${edge.provider}`;
}

/** Deterministic total order for edges. */
export function compareEdges(a: GraphEdge, b: GraphEdge): number {
  const byType = edgeTypeOrder(a.type) - edgeTypeOrder(b.type);
  if (byType !== 0) return byType;
  return edgeId(a).localeCompare(edgeId(b));
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export interface EdgeClassificationInput {
  readonly providerKind: ProviderKind;
  readonly from: GraphNode;
  readonly to: GraphNode;
  /** The provider asserts a semantic (parsed / indexed) relation, not a guess. */
  readonly semantic: boolean;
  readonly corroboration: readonly Corroboration[];
}

/**
 * THE classifier. Two independent fences guard `direct`:
 *
 *   1. the provider kind must be able to assert semantics at all
 *      (`SEMANTIC_PROVIDER_KINDS`), and
 *   2. BOTH endpoints must carry a semantic proof (`SEMANTIC_NODE_PROOFS`) —
 *      so a regex-fallback declaration can never be silently promoted.
 *
 * `structural` then requires a NAMED structural corroboration; anything else,
 * including a bare basename mirror or shared directory, is `heuristic`.
 */
export function classifyEdge(input: EdgeClassificationInput): EvidenceClass {
  const endpointsSemantic = isSemanticProof(input.from.proof) && isSemanticProof(input.to.proof);
  if (input.semantic && SEMANTIC_PROVIDER_KINDS.has(input.providerKind) && endpointsSemantic) {
    return "direct";
  }
  if (hasStructuralCorroboration(input.corroboration)) return "structural";
  return "heuristic";
}

// ---------------------------------------------------------------------------
// The closure fence
// ---------------------------------------------------------------------------

/**
 * THE FENCE (plan §V11-01: "heuristic edge 単独では obligation closure、complete、
 * Stop 候補を成立させない").
 *
 * Ask this before letting graph evidence close an obligation, assert
 * completeness, justify an absence, or propose a Stop. It is exported as a
 * named predicate rather than left as an inline `!== "heuristic"` precisely so
 * a wave-B consumer cannot get it wrong by omission — and so this file's spec
 * can pin the answer for all three classes.
 */
export function canSupportClosure(evidenceClass: EvidenceClass): boolean {
  return evidenceClass !== "heuristic";
}

/**
 * Set-level form of the fence: a claim is closable only when at least one
 * NON-heuristic edge supports it. A heuristic-only support set — and the empty
 * set — can never close.
 */
export function canCloseObligation(support: readonly GraphEdge[]): boolean {
  return support.some((edge) => canSupportClosure(edge.evidenceClass));
}

/**
 * May this edge, on its own, put a node in the `required` tier?
 *
 *  * `direct`     — yes.
 *  * `structural` — only with a REQUIRED_CORROBORATIONS token (exact symbol
 *                   correspondence); otherwise the node is `likely`.
 *  * `heuristic`  — never.
 */
export function edgeCanSupportRequired(edge: GraphEdge): boolean {
  switch (edge.evidenceClass) {
    case "direct":
      return true;
    case "structural":
      return edge.corroboration.some((c) => REQUIRED_CORROBORATIONS.has(c));
    case "heuristic":
      return false;
  }
}

/**
 * Structural self-check for a constructed edge. Returns the list of violated
 * invariants — empty means the edge is well formed. Used by the specs (and
 * available to a wave-B consumer that wants a cheap assert at a seam) so a
 * hand-built or provider-supplied edge cannot smuggle in a class its provider
 * or its endpoints are not entitled to.
 */
export function validateEdge(edge: GraphEdge): readonly string[] {
  const violations: string[] = [];
  const cap = maxEvidenceClassFor(edge.providerKind);
  if (evidenceClassRank(edge.evidenceClass) > evidenceClassRank(cap)) {
    violations.push(
      `provider kind "${edge.providerKind}" may not produce "${edge.evidenceClass}" (cap: "${cap}")`,
    );
  }
  if (edge.evidenceClass === "direct") {
    if (!isSemanticProof(edge.from.proof) || !isSemanticProof(edge.to.proof)) {
      violations.push(
        `"direct" requires semantic proof on both endpoints (from: "${edge.from.proof}", to: "${edge.to.proof}")`,
      );
    }
  }
  if (edge.evidenceClass === "structural" && !hasStructuralCorroboration(edge.corroboration)) {
    violations.push('"structural" requires a structural corroboration, not co-occurrence');
  }
  if (edge.sourceSha === "" || edge.indexGeneration === "") {
    violations.push("edge is unstamped (sourceSha and indexGeneration are mandatory)");
  }
  if (edge.sourceShaPath === "") {
    violations.push("edge has no sourceShaPath (the file whose bytes prove it)");
  }
  return violations;
}
