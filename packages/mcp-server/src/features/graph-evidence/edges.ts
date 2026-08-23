// ---------------------------------------------------------------------------
// graph-evidence/edges.ts — V11-01 edge derivation.
//
// Turns provider answers into stamped, classified `GraphEdge`s for ONE node.
// `impact.ts` calls this once per expanded node; keeping derivation separate
// from traversal is what makes "which rule produced this class?" answerable
// without reading the traversal.
//
// TWO RULES THIS FILE NEVER BENDS
// -------------------------------
//  1. It never claims a semantic relation a provider did not assert. The
//     repository's tl-graph index cannot distinguish a call from any other
//     mention, so CALLS/CALLED_BY are derived ONLY from a provider that
//     implements the optional `callersOf`/`calleesOf`. Reference data is
//     never re-badged as call data.
//  2. Path/naming proposals start as `heuristic` and are promoted to
//     `structural` only by a NAMED structural corroboration from another
//     provider — a real import edge, or an exact symbol correspondence. A
//     basename mirror is recorded as evidence and is not, by itself, enough:
//     that is the "no structural for mere co-occurrence" rule.
//
// PURE apart from the injected providers and the injected clock inside the
// `BoundTracker` it is handed.
// ---------------------------------------------------------------------------

import {
  classifyEdge,
  fileNode,
  isSemanticProof,
  symbolNode,
  GRAPH_EDGE_TYPES,
  type Corroboration,
  type GraphEdge,
  type GraphEdgeType,
  type GraphNode,
} from "./model.js";
import {
  PATH_EDGE_TYPES,
  type DeclaredSymbolAt,
  type EvidenceProvider,
  type PathEdgeType,
  type PathRelation,
  type ProviderSet,
} from "./providers.js";
import type { BoundTracker } from "./bounds.js";

/** How many of a file's exports are probed for an exact-symbol correspondence. */
export const DEFAULT_MAX_CORROBORATION_PROBES = 16;

export interface EdgeDerivationOptions {
  readonly providers: ProviderSet;
  /** Restrict derivation. Defaults to all ten types. */
  readonly edgeTypes?: readonly GraphEdgeType[];
  /** Charged for fan-out; also polled so a slow provider set cannot run long. */
  readonly tracker: BoundTracker;
  readonly maxCorroborationProbes?: number;
}

interface EdgeDraft {
  readonly type: GraphEdgeType;
  readonly from: GraphNode;
  readonly to: GraphNode;
  readonly provider: EvidenceProvider;
  readonly semantic: boolean;
  readonly corroboration: readonly Corroboration[];
  readonly rule: string;
  /** The file whose bytes prove the relation (model.ts's orientation table). */
  readonly sourceShaPath: string;
  readonly corroboratedBy?: readonly string[];
}

/**
 * Derives the edges INCIDENT to a node — in either orientation. Traversal is
 * incidence-based, so a reversed type (REFERENCES points from the referencing
 * site to the declaration) needs no special casing downstream.
 */
export class EdgeDeriver {
  private readonly providers: ProviderSet;
  private readonly allowed: ReadonlySet<GraphEdgeType>;
  private readonly tracker: BoundTracker;
  private readonly maxProbes: number;
  private readonly correspondenceMemo = new Map<string, boolean>();

  constructor(options: EdgeDerivationOptions) {
    this.providers = options.providers;
    this.allowed = new Set(options.edgeTypes ?? GRAPH_EDGE_TYPES);
    this.tracker = options.tracker;
    this.maxProbes = options.maxCorroborationProbes ?? DEFAULT_MAX_CORROBORATION_PROBES;
  }

  edgesFor(node: GraphNode): readonly GraphEdge[] {
    const drafts: EdgeDraft[] = [];
    if (node.kind === "symbol" && node.symbol !== undefined && node.symbol !== "") {
      this.symbolDrafts(node, node.symbol, drafts);
    }
    if (node.kind === "file") {
      this.fileDrafts(node, drafts);
    }

    const edges: GraphEdge[] = [];
    for (const draft of drafts) {
      if (!this.allowed.has(draft.type)) continue;
      edges.push(this.build(draft));
    }
    return edges;
  }

  // -------------------------------------------------------------------------
  // Symbol-level derivation
  // -------------------------------------------------------------------------

  private symbolDrafts(node: GraphNode, symbol: string, out: EdgeDraft[]): void {
    const references = this.providers.references;
    if (references !== undefined) {
      for (const ref of references.referencesTo(symbol)) {
        out.push({
          type: "REFERENCES",
          from: ref.node,
          to: node,
          provider: references,
          semantic: true,
          corroboration: ["exact-symbol-match"],
          rule: "reference-index-mention",
          sourceShaPath: ref.node.path,
        });
      }
      if (references.callersOf !== undefined) {
        for (const caller of references.callersOf(symbol)) {
          out.push({
            type: "CALLED_BY",
            from: node,
            to: caller.node,
            provider: references,
            semantic: true,
            corroboration: ["exact-symbol-match"],
            rule: "reference-index-caller",
            sourceShaPath: caller.node.path,
          });
        }
      }
      if (references.calleesOf !== undefined) {
        for (const callee of references.calleesOf(symbol)) {
          out.push({
            type: "CALLS",
            from: node,
            to: callee.node,
            provider: references,
            semantic: true,
            corroboration: ["exact-symbol-match"],
            rule: "reference-index-callee",
            sourceShaPath: node.path,
          });
        }
      }
    }

    const symbols = this.providers.symbols;
    if (symbols === undefined) return;

    for (const declaration of symbols.declarationsIn(node.path)) {
      if (declaration.name !== symbol) continue;
      this.supertypeDrafts(node, declaration, declaration.extendsNames, "EXTENDS", out);
      this.supertypeDrafts(node, declaration, declaration.implementsNames, "IMPLEMENTS", out);
    }

    for (const sub of symbols.subtypesOf(symbol)) {
      const subNode = symbolNode(sub.path, sub.name, sub.proof, {
        symbolKind: sub.kind,
        line: sub.line,
      });
      const semantic = heritageIsSemantic(sub);
      if (sub.extendsNames?.includes(symbol) === true) {
        out.push({
          type: "EXTENDS",
          from: subNode,
          to: node,
          provider: symbols,
          semantic,
          corroboration: ["exact-symbol-match", "declaration-proven"],
          rule: "declaration-extends",
          sourceShaPath: sub.path,
        });
      }
      if (sub.implementsNames?.includes(symbol) === true) {
        out.push({
          type: "IMPLEMENTS",
          from: subNode,
          to: node,
          provider: symbols,
          semantic,
          corroboration: ["exact-symbol-match", "declaration-proven"],
          rule: "declaration-implements",
          sourceShaPath: sub.path,
        });
      }
    }
  }

  private supertypeDrafts(
    node: GraphNode,
    owner: DeclaredSymbolAt,
    names: readonly string[] | undefined,
    type: Extract<GraphEdgeType, "EXTENDS" | "IMPLEMENTS">,
    out: EdgeDraft[],
  ): void {
    const symbols = this.providers.symbols;
    if (symbols === undefined || names === undefined) return;
    const semantic = heritageIsSemantic(owner);
    for (const name of names) {
      // A base type with no resolvable declaration produces NO edge: a node we
      // cannot locate is not evidence, and inventing a placeholder would make
      // the impact set look larger than the evidence supports.
      for (const declaration of symbols.declarationsOf(name)) {
        out.push({
          type,
          from: node,
          to: symbolNode(declaration.path, declaration.name, declaration.proof, {
            symbolKind: declaration.kind,
            line: declaration.line,
          }),
          provider: symbols,
          semantic,
          corroboration: ["exact-symbol-match", "declaration-proven"],
          rule: type === "EXTENDS" ? "declaration-extends" : "declaration-implements",
          sourceShaPath: node.path,
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // File-level derivation
  // -------------------------------------------------------------------------

  private fileDrafts(node: GraphNode, out: EdgeDraft[]): void {
    const imports = this.providers.imports;
    if (imports !== undefined) {
      for (const target of imports.importsOf(node.path)) {
        out.push({
          type: "IMPORTS",
          from: node,
          to: fileNode(target, "path"),
          provider: imports,
          semantic: false,
          corroboration: this.importCorroboration(node.path, target),
          rule: "import-graph-imports",
          sourceShaPath: node.path,
        });
      }
      for (const consumer of imports.importedBy(node.path)) {
        out.push({
          type: "IMPORTED_BY",
          from: node,
          to: fileNode(consumer, "path"),
          provider: imports,
          semantic: false,
          corroboration: this.importCorroboration(consumer, node.path),
          rule: "import-graph-imported-by",
          sourceShaPath: consumer,
        });
      }
    }

    const paths = this.providers.paths;
    if (paths === undefined) return;
    for (const type of PATH_EDGE_TYPES) {
      if (!this.allowed.has(type)) continue;
      for (const relation of paths.relatedTo(node.path, type)) {
        out.push(this.pathDraft(node, relation, type, paths));
      }
    }
  }

  private pathDraft(
    node: GraphNode,
    relation: PathRelation,
    type: PathEdgeType,
    paths: EvidenceProvider,
  ): EdgeDraft {
    const other = fileNode(relation.path, "path");
    const outgoing = relation.direction === "outgoing";
    const from = outgoing ? node : other;
    const to = outgoing ? other : node;

    // Naming/proximity evidence is recorded but is NOT structural on its own.
    const base: Corroboration[] = [relation.exactStemMatch ? "basename-mirror" : "path-proximity"];

    // Promotion: a real import edge between the two files turns a naming guess
    // into a structural fact. The corroborating provider is named on the edge.
    const promoted = this.promoteByImport(from.path, to.path, type);
    const corroboration: Corroboration[] = promoted === undefined ? base : [...base, "import-edge"];

    return {
      type,
      from,
      to,
      provider: paths,
      semantic: false,
      corroboration,
      rule: relation.rule,
      // The bytes that carry the naming evidence belong to the counterpart that
      // NAMES the other: the test file, the config file, the generated file.
      sourceShaPath: type === "TESTED_BY" ? to.path : from.path,
      ...(promoted !== undefined ? { corroboratedBy: [promoted] } : {}),
    };
  }

  /**
   * Returns the corroborating provider id when a proven import edge links the
   * two files, in whichever direction the relation implies.
   */
  private promoteByImport(from: string, to: string, type: PathEdgeType): string | undefined {
    const imports = this.providers.imports;
    if (imports === undefined) return undefined;
    // TESTED_BY: subject --TESTED_BY--> test, and the TEST imports the subject.
    // CONFIGURES / GENERATED_FROM: an import in either direction between the
    // two files is equally good corroboration for the naming proposal.
    const pairs: readonly (readonly [string, string])[] =
      type === "TESTED_BY" ? [[to, from]] : [[from, to], [to, from]];
    for (const pair of pairs) {
      if (imports.importsOf(pair[0]).includes(pair[1])) return imports.identity.id;
    }
    return undefined;
  }

  /**
   * `import-edge` always (the provider proved the import); plus
   * `exact-symbol-match` when the importing file demonstrably mentions a symbol
   * the imported file declares. Probes are capped and memoized so a hub file's
   * export list cannot turn one edge into a linear scan.
   */
  private importCorroboration(importer: string, imported: string): readonly Corroboration[] {
    if (this.hasExactSymbolCorrespondence(importer, imported)) {
      return ["import-edge", "exact-symbol-match"];
    }
    return ["import-edge"];
  }

  private hasExactSymbolCorrespondence(importer: string, imported: string): boolean {
    const key = importer + " " + imported;
    const memo = this.correspondenceMemo.get(key);
    if (memo !== undefined) return memo;
    const result = this.probeCorrespondence(importer, imported);
    this.correspondenceMemo.set(key, result);
    return result;
  }

  private probeCorrespondence(importer: string, imported: string): boolean {
    const references = this.providers.references;
    if (references === undefined) return false;

    const names = this.exportedNames(imported);
    let probes = 0;
    for (const name of names) {
      if (probes >= this.maxProbes) break;
      if (this.tracker.expired()) break;
      probes += 1;
      for (const ref of references.referencesTo(name)) {
        if (ref.node.path === importer) return true;
      }
    }
    return false;
  }

  private exportedNames(path: string): readonly string[] {
    const exported = this.providers.imports?.exportsOf(path) ?? [];
    if (exported.length > 0) return exported;
    const symbols = this.providers.symbols;
    if (symbols === undefined) return [];
    return symbols.declarationsIn(path).map((d) => d.name);
  }

  // -------------------------------------------------------------------------
  // Stamping
  // -------------------------------------------------------------------------

  private build(draft: EdgeDraft): GraphEdge {
    const identity = draft.provider.identity;
    const evidenceClass = classifyEdge({
      providerKind: identity.kind,
      from: draft.from,
      to: draft.to,
      semantic: draft.semantic,
      corroboration: draft.corroboration,
    });
    return {
      type: draft.type,
      from: draft.from,
      to: draft.to,
      evidenceClass,
      provider: identity.id,
      providerKind: identity.kind,
      sourceSha: this.shaFor(draft.sourceShaPath, draft.provider),
      sourceShaPath: draft.sourceShaPath,
      indexGeneration: identity.indexGeneration,
      coverage: identity.coverage.status,
      rule: draft.rule,
      corroboration: draft.corroboration,
      ...(draft.corroboratedBy !== undefined ? { corroboratedBy: draft.corroboratedBy } : {}),
    };
  }

  /**
   * The producing provider first, then any other provider that knows the file.
   * An unresolvable digest stays "" — `stale.ts` then discards the edge as
   * unstamped rather than letting an unprovable relation through.
   */
  private shaFor(path: string, provider: EvidenceProvider): string {
    const own = provider.sourceShaOf?.(path);
    if (own !== undefined && own !== "") return own;
    const fallbacks = [this.providers.symbols, this.providers.imports, this.providers.paths];
    for (const candidate of fallbacks) {
      const sha = candidate?.sourceShaOf?.(path);
      if (sha !== undefined && sha !== "") return sha;
    }
    return "";
  }
}

/**
 * A heritage relation is semantic only when the NAMES were obtained as
 * strongly as the declaration itself. A parser-proven class whose base clause
 * was read out of signature text yields `heritageProof: "regex-fallback"`, and
 * the resulting EXTENDS/IMPLEMENTS edge settles at `structural` — it keeps its
 * exact-symbol corroboration, it just does not claim to be parsed.
 */
function heritageIsSemantic(declaration: DeclaredSymbolAt): boolean {
  return isSemanticProof(declaration.heritageProof ?? declaration.proof);
}

/** One-shot convenience wrapper; prefer `EdgeDeriver` when expanding a graph. */
export function deriveEdgesFor(
  node: GraphNode,
  options: EdgeDerivationOptions,
): readonly GraphEdge[] {
  return new EdgeDeriver(options).edgesFor(node);
}
