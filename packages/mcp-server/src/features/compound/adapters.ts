// ---------------------------------------------------------------------------
// compound/adapters.ts — V11-05: the one file that binds the pure
// `compoundRetrieval.ts` engine to the real repository.
//
// Mirrors graph-evidence's OWN split (engine files stay unaware of the
// repository; `adapters.ts` is the sole file allowed to reach outside its
// module) one level up: `compoundRetrieval.ts` never touches a filesystem or
// the locator's candidate pool; everything in THIS file does.
//
// WHAT LIVES HERE
// ----------------
//  * `buildCompoundProviders` — turns an already-loaded `GraphIndex` (the
//    locator's `resolveNestedGraphIndex` result — never re-resolved here) plus
//    a file inventory into graph-evidence's `ProviderSet` + `GenerationView`,
//    via a LAZY, memoized, on-demand content-sha reader (`LazySourceShaMap`):
//    a bounded ~48-node hop only ever needs digests for the handful of files
//    it actually touches, so nothing here hashes the whole workspace eagerly.
//  * `extractCompoundSeed` — the seed extraction the plan asks for ("symbol /
//    definition / error location / doc section"), but resolved from the
//    LOCATOR's own already-disambiguated `primary` rather than re-parsing the
//    query: `primary` IS the locator's answer to "which explicit symbol /
//    definition / location does this query name", arrived at through Layers
//    1-5 and the success gate, so re-deriving it here would be a second,
//    weaker, redundant classifier.
//  * `detectSemanticBranchPaths` — the ONE decline condition
//    `compoundRetrieval.ts` cannot see for itself: whether the locator's own
//    (pre-ranking) candidate pool contains more than one DISTINCT FILE
//    claiming the seed's symbol name. `primary` already picked a winner by
//    SCORE; compound retrieval demands proof of uniqueness before it will
//    treat that pick as a safe deterministic hop origin, because a wrong
//    disambiguation here would be amplified, not merely repeated.
//  * `compoundNodeToCandidate` — maps one discovered `CompoundNode` onto the
//    EXISTING `ImpactCandidate` shape (deviation E-2: no new wire field).
//    `informational`-tier nodes are refused here too, as a second fence next
//    to the tier filtering `index.ts` already does before calling this.
//
// Nested-root paths: every graph-evidence-facing path in this file is
// INDEX-relative (relative to `rootPrefix`, exactly like `graph/index.ts`'s
// own `importsOf`/`references` results) — `stripPrefix`/`addPrefix` convert
// to/from the WORKSPACE-relative paths a `Candidate`/`ImpactCandidate` uses,
// mirroring locateTaskContext.ts's own `reprefixGraphPath` convention so a
// nested `.tokenlighten/index/` (DESIGN-v0.8 §A6) behaves identically here.
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import * as path from "node:path";

import type { ImpactCandidate, ImpactSurface } from "@tokenlighten/types";

import {
  contentSha,
  createPathHeuristicsProvider,
  createTlGraphProviders,
  type GenerationView,
  type ImpactSeed,
  type ProviderSet,
} from "../graph-evidence/index.js";
import type { GraphIndex } from "../../graph/index.js";
import { classifySurface } from "../../util/impact.js";
import type { CompoundNode } from "./compoundRetrieval.js";

// ---------------------------------------------------------------------------
// Nested-root path helpers (mirrors locateTaskContext.ts's reprefixGraphPath)
// ---------------------------------------------------------------------------

/** Workspace-relative -> index-relative. Paths outside `rootPrefix` pass through unchanged. */
export function stripPrefix(relPath: string, rootPrefix: string): string {
  if (rootPrefix === "") return relPath;
  const prefix = `${rootPrefix}/`;
  return relPath === rootPrefix ? "" : relPath.startsWith(prefix) ? relPath.slice(prefix.length) : relPath;
}

/** Index-relative -> workspace-relative. Exactly graph-evidence's own reprefixGraphPath rule. */
export function addPrefix(indexRelPath: string, rootPrefix: string): string {
  return rootPrefix ? `${rootPrefix}/${indexRelPath}` : indexRelPath;
}

/** The workspace-relative `files` list, filtered and stripped to `rootPrefix`'s namespace. */
function toIndexRelativeFiles(files: readonly string[], rootPrefix: string): string[] {
  if (rootPrefix === "") return [...files];
  const prefix = `${rootPrefix}/`;
  return files.filter((f) => f.startsWith(prefix)).map((f) => f.slice(prefix.length));
}

// ---------------------------------------------------------------------------
// Lazy, memoized content-sha reader
// ---------------------------------------------------------------------------

/**
 * A `ReadonlyMap<string, string>` whose entries are computed ON FIRST
 * `.get()`, from disk, and cached — never eagerly. `analyzeImpact` and its
 * staleness re-proof only ever call `.get(path)` for paths an edge actually
 * touches, so this is the whole reason a ~48-node bounded hop never has to
 * hash a workspace's full file list up front.
 *
 * The SAME instance is threaded into every provider's `sourceShas` AND into
 * the `GenerationView` handed to `analyzeImpact` (`buildCompoundProviders`
 * below) — so an edge's stamped digest and its freshness re-proof are the
 * SAME memoized read, not two independent filesystem reads that could race.
 *
 * Digests are computed with graph-evidence's own `contentSha` (utf8-based,
 * same as every other provider in this tree); a binary file still produces a
 * stable, self-consistent digest for this process's lifetime, which is all
 * this module's usage needs (see this file's header on self-consistency).
 */
class LazySourceShaMap implements ReadonlyMap<string, string> {
  private readonly memo = new Map<string, string>();

  constructor(
    private readonly workspace: string,
    private readonly rootPrefix: string,
  ) {}

  get(indexRelPath: string): string | undefined {
    const cached = this.memo.get(indexRelPath);
    if (cached !== undefined) return cached;
    const sha = LazySourceShaMap.readSha(this.workspace, addPrefix(indexRelPath, this.rootPrefix));
    if (sha !== undefined) this.memo.set(indexRelPath, sha);
    return sha;
  }

  has(indexRelPath: string): boolean {
    return this.get(indexRelPath) !== undefined;
  }

  get size(): number {
    return this.memo.size;
  }

  forEach(callback: (value: string, key: string, map: ReadonlyMap<string, string>) => void, thisArg?: unknown): void {
    this.memo.forEach((value, key) => callback.call(thisArg, value, key, this));
  }

  entries(): IterableIterator<[string, string]> {
    return this.memo.entries();
  }

  keys(): IterableIterator<string> {
    return this.memo.keys();
  }

  values(): IterableIterator<string> {
    return this.memo.values();
  }

  [Symbol.iterator](): IterableIterator<[string, string]> {
    return this.memo[Symbol.iterator]();
  }

  private static readSha(workspace: string, workspaceRelPath: string): string | undefined {
    try {
      const text = fs.readFileSync(path.join(workspace, workspaceRelPath), "utf8");
      return contentSha(text);
    } catch {
      return undefined;
    }
  }
}

// ---------------------------------------------------------------------------
// Provider construction
// ---------------------------------------------------------------------------

export interface CompoundProviderContext {
  readonly workspace: string;
  /** Already loaded by the caller (locateTaskContext's own resolveNestedGraphIndex) — never re-resolved here. */
  readonly graphIndex: GraphIndex;
  readonly rootPrefix: string;
  /** Workspace-relative file inventory (e.g. the locator's memoized WalkCache), for the path-heuristics provider's stem indexes. */
  readonly files: readonly string[];
}

export function buildCompoundProviders(ctx: CompoundProviderContext): {
  readonly providers: ProviderSet;
  readonly generations: GenerationView;
} {
  const indexFiles = toIndexRelativeFiles(ctx.files, ctx.rootPrefix);
  const shaMap = new LazySourceShaMap(ctx.workspace, ctx.rootPrefix);

  const tlGraph = createTlGraphProviders({
    workspace: ctx.workspace,
    files: indexFiles,
    sourceShas: shaMap,
    // Inert for THIS module's traversal: edges.ts never calls
    // edgeTypeSupport(); only coverageMatrix.ts (a separate, un-invoked wave-A
    // telemetry surface) reads it. Left empty rather than guessed.
    languages: [],
    index: ctx.graphIndex,
  });

  const paths = createPathHeuristicsProvider({
    files: indexFiles,
    sourceShas: shaMap,
  });

  const providers: ProviderSet = {
    ...(tlGraph.references ? { references: tlGraph.references } : {}),
    ...(tlGraph.imports ? { imports: tlGraph.imports } : {}),
    paths,
  };

  const generations = new Map<string, string>([[paths.identity.id, paths.identity.indexGeneration]]);
  if (tlGraph.references) generations.set(tlGraph.references.identity.id, tlGraph.references.identity.indexGeneration);
  if (tlGraph.imports) generations.set(tlGraph.imports.identity.id, tlGraph.imports.identity.indexGeneration);

  // NOT graph-evidence's makeGenerationView(): that helper eagerly copies its
  // iterable arguments into fresh plain Maps at construction time, which
  // would drain `shaMap` into an empty snapshot before its first `.get()` —
  // exactly the laziness this class exists to preserve. A GenerationView is
  // a plain two-field interface, so building it as a literal costs nothing.
  return { providers, generations: { generations, sourceShas: shaMap } };
}

// ---------------------------------------------------------------------------
// Seed extraction
// ---------------------------------------------------------------------------

export interface PrimaryLike {
  readonly path: string;
  readonly symbol?: string;
  readonly line: number;
}

/**
 * The locator's own resolved `primary` IS the plan's "explicit symbol /
 * definition / error location / doc section present in the task query/args"
 * — see this file's header. Symbol-shaped when `primary.symbol` is set (the
 * common case: an exact symbol lookup, a symbol search hit, or a BM25F
 * symbol-unit candidate all set it); file-shaped otherwise, which also
 * degrades correctly for a doc-section primary (locate's Candidate has no
 * section-anchor field yet, so a markdown hit seeds at file granularity).
 */
export function extractCompoundSeed(primary: PrimaryLike, rootPrefix: string): ImpactSeed {
  const indexPath = stripPrefix(primary.path, rootPrefix);
  if (primary.symbol) {
    return { kind: "symbol", path: indexPath, symbol: primary.symbol, line: primary.line };
  }
  return { kind: "file", path: indexPath };
}

// ---------------------------------------------------------------------------
// Semantic-branch detection
// ---------------------------------------------------------------------------

export interface SymbolCandidateLike {
  readonly kind: string;
  readonly path: string;
  readonly symbol?: string;
}

/**
 * Distinct workspace-relative paths (sorted) in `candidates` whose OWN
 * resolved symbol equals `symbol` (case-insensitive) — the plan's "semantic
 * branch: two plausible distinct definition seeds". Length >= 2 means the
 * locator's ranking picked ONE winner by score, but the symbol name itself
 * does not uniquely resolve to one file, so hopping from it is a semantic
 * choice this module refuses to make (plan: "semantic choiceを自動化せず").
 * A single-candidate result (or none) is NOT a branch, however many lines of
 * the SAME file matched.
 */
export function detectSemanticBranchPaths(
  symbol: string,
  candidates: readonly SymbolCandidateLike[],
): readonly string[] {
  const needle = symbol.toLowerCase();
  const paths = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.kind !== "symbol") continue;
    if ((candidate.symbol ?? "").toLowerCase() !== needle) continue;
    paths.add(candidate.path);
  }
  return [...paths].sort();
}

// ---------------------------------------------------------------------------
// Node -> candidate mapping
// ---------------------------------------------------------------------------

export type CompoundCandidateBase = Omit<ImpactCandidate, "handle">;

/**
 * `required`-tier -> `required: true` (pack-eligible served set, exactly like
 * every other force-admitted `related` candidate in locateTaskContext.ts);
 * `likely`-tier -> `required: false` (inventory/candidate entry only, never
 * an auto-served body — plan 実装内容 bullet 5 / this module's header).
 * `informational` is refused here too, defense-in-depth next to the tier
 * filter `index.ts` applies before ever calling this (plan: informational は
 * trace専用、絶対にwireしない).
 *
 * Returns undefined for a node whose path does not classify to a known
 * `ImpactSurface` — the same "unknown surface is not worth a slot" rule
 * `locateTaskContext.ts`'s own graph-reference/graph-importer expansion
 * already applies.
 */
export function compoundNodeToCandidate(
  node: CompoundNode,
  rootPrefix: string,
): CompoundCandidateBase | undefined {
  if (node.tier === "informational") return undefined;
  const wirePath = addPrefix(node.path, rootPrefix);
  const surface: ImpactSurface = classifySurface(wirePath, node.symbol);
  if (surface === "unknown") return undefined;

  const required = node.tier === "required";
  const range = node.line > 1 ? `${Math.max(1, node.line - 5)}-${node.line + 5}` : "1-1";

  return {
    path: wirePath,
    line: node.line,
    range,
    ...(node.symbol ? { symbol: node.symbol } : {}),
    surface,
    why: `compound:${node.tier}`,
    confidence: required ? 0.6 : 0.4,
    required,
  };
}
