// ---------------------------------------------------------------------------
// graph-evidence/providers.ts — V11-01 provider INTERFACES.
//
// The engine (`edges.ts` / `impact.ts`) consumes only what is declared here.
// `adapters.ts` binds these to the real repository surfaces; a spec binds them
// to fixtures. That separation is the whole reason wave A can ship this tree
// with ZERO production importers and still be tested against real parser and
// real tl-graph data.
//
// THREE PROPERTIES EVERY PROVIDER MUST HOLD
// -----------------------------------------
//  1. SYNCHRONOUS. Expansion is a bounded, deterministic walk; an async hop
//     would put a provider's latency inside the traversal and make the
//     duration bound unenforceable. Anything expensive (parsing a tree, reading
//     an index) happens in the provider's async FACTORY, before expansion.
//  2. SELF-DESCRIBING. `identity` states the provider's id, kind, current
//     generation, and what it claims to cover. A provider that does not know
//     its own coverage says `unknown`, which forbids `complete` downstream —
//     it does not guess (plan §V11-01 副作用を抑える方法).
//  3. HONEST ABOUT SUPPORT. `edgeTypeSupport(language)` returns only the edge
//     types the provider can actually produce for that language. An empty list
//     means unsupported, and `coverageMatrix.ts` reports it as such rather
//     than letting a silent gap read as coverage.
//
// OPTIONAL METHODS ARE A FEATURE. `callersOf`/`calleesOf` are optional because
// the repository's tl-graph index cannot distinguish a call from any other
// reference. An adapter that cannot prove a call omits the method; the
// coverage matrix then shows CALLS/CALLED_BY as unsupported for that provider
// instead of the engine inventing call edges out of reference data.
// ---------------------------------------------------------------------------

import {
  canSupportClosure,
  unaidedEvidenceClassFor,
  type Coverage,
  type GraphEdgeType,
  type GraphNode,
  type NodeProof,
  type ProviderKind,
} from "./model.js";

// ---------------------------------------------------------------------------
// Identity and coverage
// ---------------------------------------------------------------------------

export interface ProviderCoverage {
  readonly status: Coverage;
  /** Languages this provider claims to have processed. */
  readonly languages: readonly string[];
  /** Why the status is not `complete`, when it is not. */
  readonly reason?: string;
}

export interface ProviderIdentity {
  /** Stable id, recorded on every edge this provider produces. */
  readonly id: string;
  readonly kind: ProviderKind;
  /**
   * The producing index's current generation. Empty string means "cannot say",
   * which makes every edge this provider stamps fail the staleness check —
   * deliberately, and fail-closed.
   */
  readonly indexGeneration: string;
  readonly coverage: ProviderCoverage;
}

/** The base every provider satisfies. */
export interface EvidenceProvider {
  readonly identity: ProviderIdentity;
  /**
   * Edge types this provider can produce for `language`. Empty ⇒ unsupported.
   * Consumed by `coverageMatrix.ts`; must not vary within one snapshot.
   */
  edgeTypeSupport(language: string): readonly GraphEdgeType[];
  /** Current content digest of `path`, when this provider knows it. */
  sourceShaOf?(path: string): string | undefined;
}

// ---------------------------------------------------------------------------
// Import graph
// ---------------------------------------------------------------------------

/**
 * File-level import structure (tl-graph's `files[].imports/exports`, or SCIP).
 * Structural, never semantic — see `SEMANTIC_PROVIDER_KINDS` in model.ts.
 */
export interface ImportGraphProvider extends EvidenceProvider {
  importsOf(path: string): readonly string[];
  importedBy(path: string): readonly string[];
  exportsOf(path: string): readonly string[];
}

// ---------------------------------------------------------------------------
// Reference index
// ---------------------------------------------------------------------------

/**
 * A site that mentions a symbol. `node` is a FILE node when the index only
 * knows the referencing file (tl-graph's case) and a SYMBOL node when it knows
 * the enclosing declaration — the difference is carried, never smoothed over.
 */
export interface SymbolReference {
  readonly node: GraphNode;
}

export interface ReferenceProvider extends EvidenceProvider {
  /** The symbol's declaration, when the index has one. */
  definitionOf(symbol: string): GraphNode | undefined;
  referencesTo(symbol: string): readonly SymbolReference[];
  /** Sites that CALL `symbol`. Omit when calls are not distinguishable. */
  callersOf?(symbol: string): readonly SymbolReference[];
  /** Symbols `symbol` calls. Omit when calls are not distinguishable. */
  calleesOf?(symbol: string): readonly SymbolReference[];
}

// ---------------------------------------------------------------------------
// Symbols (PI-06 declaration-only)
// ---------------------------------------------------------------------------

/**
 * One DECLARATION. `proof` distinguishes a parser-proven declaration from a
 * regex-fallback one; a regex-fallback declaration is a legitimate node, it is
 * simply labelled, and `classifyEdge` will not mint a `direct` edge onto it.
 */
export interface DeclaredSymbol {
  readonly name: string;
  readonly kind: string;
  /** 1-based declaration line. */
  readonly line: number;
  readonly proof: NodeProof;
  /** Base types named by this declaration, verbatim. */
  readonly extendsNames?: readonly string[];
  /** Interfaces named by this declaration, verbatim. */
  readonly implementsNames?: readonly string[];
  /**
   * How the extends/implements NAMES were obtained, when that differs from how
   * the declaration itself was proven. A parser that yields declaration ranges
   * but not heritage nodes forces the names to be read out of the signature
   * text; that is `regex-fallback` heritage on a `parser` declaration, and it
   * caps the resulting EXTENDS/IMPLEMENTS edges at `structural`. Defaults to
   * `proof`.
   */
  readonly heritageProof?: NodeProof;
}

export interface DeclaredSymbolAt extends DeclaredSymbol {
  readonly path: string;
}

export interface SymbolProvider extends EvidenceProvider {
  /** Files this provider has declarations for. */
  files(): readonly string[];
  declarationsIn(path: string): readonly DeclaredSymbolAt[];
  /** Every declaration of `name`, across files. */
  declarationsOf(name: string): readonly DeclaredSymbolAt[];
  /** Declarations whose extends/implements list names `name`. */
  subtypesOf(name: string): readonly DeclaredSymbolAt[];
  languageOf(path: string): string | undefined;
  sourceShaOf(path: string): string | undefined;
}

// ---------------------------------------------------------------------------
// Path heuristics
// ---------------------------------------------------------------------------

export type PathRole = "source" | "test" | "config" | "build" | "doc" | "generated";

export const PATH_ROLES: readonly PathRole[] = [
  "source",
  "test",
  "config",
  "build",
  "doc",
  "generated",
];

/** The edge types a path/naming provider is allowed to propose. */
export type PathEdgeType = Extract<GraphEdgeType, "TESTED_BY" | "CONFIGURES" | "GENERATED_FROM">;

export const PATH_EDGE_TYPES: readonly PathEdgeType[] = ["TESTED_BY", "CONFIGURES", "GENERATED_FROM"];

/**
 * A naming/proximity relation proposal. `direction` is relative to the QUERIED
 * path, so the engine can orient the edge per `INVERSE_EDGE_TYPE`'s table
 * without the provider having to know the orientation contract:
 *
 *   TESTED_BY       outgoing ⇒ queried --TESTED_BY--> related (related is the test)
 *   CONFIGURES      incoming ⇒ related --CONFIGURES--> queried (related is the config)
 *   GENERATED_FROM  outgoing ⇒ queried --GENERATED_FROM--> related (queried is generated)
 *                   incoming ⇒ related --GENERATED_FROM--> queried (related is generated)
 */
export interface PathRelation {
  readonly path: string;
  readonly direction: "outgoing" | "incoming";
  /** Rule name, e.g. "test-stem-mirror" — recorded on the edge. */
  readonly rule: string;
  /** The file stems correspond exactly (naming evidence, NOT structural). */
  readonly exactStemMatch: boolean;
}

export interface PathHeuristicsProvider extends EvidenceProvider {
  roleOf(path: string): PathRole;
  relatedTo(path: string, type: PathEdgeType): readonly PathRelation[];
}

// ---------------------------------------------------------------------------
// The set the engine consumes
// ---------------------------------------------------------------------------

/**
 * Every member is optional: the overlay degrades honestly. With no reference
 * provider there are no `direct` edges and coverage cannot be `complete`; with
 * only a path provider every edge is `heuristic` and nothing can close.
 */
export interface ProviderSet {
  readonly imports?: ImportGraphProvider;
  readonly references?: ReferenceProvider;
  readonly symbols?: SymbolProvider;
  readonly paths?: PathHeuristicsProvider;
}

/** The set's members, in fixed order, skipping absent ones. */
export function providerList(set: ProviderSet): readonly EvidenceProvider[] {
  const out: EvidenceProvider[] = [];
  if (set.references) out.push(set.references);
  if (set.symbols) out.push(set.symbols);
  if (set.imports) out.push(set.imports);
  if (set.paths) out.push(set.paths);
  return out;
}

export function providerIdentities(set: ProviderSet): readonly ProviderIdentity[] {
  return providerList(set).map((p) => p.identity);
}

/**
 * The weakest coverage claimed by the providers whose evidence CAN close —
 * and `unknown` when there are none, because an overlay that can only guess has
 * proved nothing.
 *
 * Advisory providers (path heuristics) are deliberately excluded. Their
 * coverage is `partial` by nature — a naming rule cannot know what it missed —
 * and letting that drag the aggregate down would mean a workspace with a
 * complete reference index could never close an obligation merely because a
 * naming heuristic was also consulted. Their edges still cannot close anything:
 * that is enforced per-edge by `canSupportClosure`, which is the right place
 * for it.
 */
export function aggregateProviderCoverage(set: ProviderSet): Coverage {
  const closing = providerList(set).filter((provider) =>
    canSupportClosure(unaidedEvidenceClassFor(provider.identity.kind)),
  );
  if (closing.length === 0) return "unknown";
  let worst: Coverage = "complete";
  for (const provider of closing) {
    const status = provider.identity.coverage.status;
    if (status === "unknown") return "unknown";
    if (status === "partial") worst = "partial";
  }
  return worst;
}
