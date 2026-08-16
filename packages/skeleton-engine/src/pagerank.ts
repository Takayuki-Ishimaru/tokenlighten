// Plain data only — no meta envelope, no 'tokenlighten:meta' wrappers.
// Reason: docs/00-postmortem.md §2.2 — meta envelopes were identified as a
// key source of token waste and were removed from all tool responses.

/**
 * PageRank implementation for the CI skeleton generator.
 *
 * Ported cleanly from proto/src/mcp/pagerank.ts.
 * VSCode coupling and MCP runtime dependencies removed.
 * Damping: 0.85, iterations: 20 (fixed, no convergence check — per spec §2.1).
 */

export interface SymbolNode {
  /** `${path}:${symbolName}` */
  id: string;
  path: string;
  name: string;
  /** Estimated body size in tokens (~8 tokens per body line). */
  bodyTokens: number;
  bodyStartLine: number;
  bodyEndLine: number;
}

export interface SymbolGraph {
  nodes: Map<string, SymbolNode>;
  /** source node id → (target node id → weight) */
  edges: Map<string, Map<string, number>>;
  builtAt: number;
  /** file path → mtime (ms) at graph build time */
  fileMtimes: Map<string, number>;
}

export interface FileInput {
  path: string;
  raw: string;
  /** mtime in ms; or 0 if unavailable (CI env where mtime is unstable) */
  mtimeMs: number;
  symbols: Array<{
    name: string;
    line: number;
    endLine: number;
    signature: string;
  }>;
}

export interface PageRankResult {
  scores: Map<string, number>;
  ranker: "pagerank" | "fallback-file-unit";
}

const MAX_EDGES_PER_SOURCE = 50;

/**
 * Personalized PageRank over the symbol graph.
 * 20 iterations, damping 0.85, no convergence check (fixed cost per spec §2.1).
 * Returns unnormalized rank scores.
 */
export function runPersonalizedPageRank(
  graph: SymbolGraph,
  personalization: Map<string, number>,
  damping = 0.85,
  iterations = 20,
): Map<string, number> {
  const nodes = Array.from(graph.nodes.keys());
  const N = nodes.length;
  if (N === 0) return new Map();

  const uniformWeight = 1 / N;
  let r = new Map<string, number>(
    nodes.map((id) => [id, personalization.get(id) ?? uniformWeight]),
  );

  for (let iter = 0; iter < iterations; iter++) {
    const next = new Map<string, number>(
      nodes.map((id) => [id, (1 - damping) * (personalization.get(id) ?? uniformWeight)]),
    );
    for (const [src, outEdges] of graph.edges) {
      const totalWeight = Array.from(outEdges.values()).reduce((a, b) => a + b, 0);
      if (totalWeight === 0) continue;
      const srcScore = r.get(src) ?? 0;
      for (const [tgt, w] of outEdges) {
        next.set(tgt, (next.get(tgt) ?? 0) + damping * srcScore * (w / totalWeight));
      }
    }
    r = next;
  }
  return r;
}

/**
 * Aggregate symbol-level PageRank scores to file-level scores.
 * A file's score is the max of its symbol scores.
 */
export function aggregateToFileScores(nodeScores: Map<string, number>): Map<string, number> {
  const fileScores = new Map<string, number>();
  for (const [id, score] of nodeScores) {
    const path = id.split(":")[0]!;
    const current = fileScores.get(path) ?? 0;
    if (score > current) fileScores.set(path, score);
  }
  return fileScores;
}

/**
 * Degenerate fallback when graph is unavailable or too large (>5000 files).
 * Recently-edited files score 2, others score 1.
 */
export function fileUnitFallback(
  files: Array<{ path: string; recentlyEdited: boolean }>,
): Map<string, number> {
  const scores = new Map<string, number>();
  for (const f of files) {
    scores.set(f.path, f.recentlyEdited ? 2 : 1);
  }
  return scores;
}

/**
 * Build a symbol reference graph using lexical approximation.
 *
 * For each file, scans raw text for whole-word occurrences of other files'
 * symbol names and emits directed edges. Self-edges skipped. Edges per source
 * capped at MAX_EDGES_PER_SOURCE (50). Identical to proto/src/mcp/pagerank.ts.
 */
export function buildSymbolGraph(
  files: FileInput[],
  previousGraph: SymbolGraph | null,
): SymbolGraph {
  const nodes = new Map<string, SymbolNode>();
  const edges = new Map<string, Map<string, number>>();
  const fileMtimes = new Map<string, number>();

  // 1) Build node table + inverted symbol name index.
  const nameToNodeIds = new Map<string, string[]>();

  for (const file of files) {
    fileMtimes.set(file.path, file.mtimeMs);
    for (const sym of file.symbols) {
      const nodeId = `${file.path}:${sym.name}`;
      const bodyTokens = Math.max(1, Math.round((sym.endLine - sym.line + 1) * 8));
      nodes.set(nodeId, {
        id: nodeId,
        path: file.path,
        name: sym.name,
        bodyTokens,
        bodyStartLine: sym.line,
        bodyEndLine: sym.endLine,
      });
      if (!nameToNodeIds.has(sym.name)) nameToNodeIds.set(sym.name, []);
      nameToNodeIds.get(sym.name)!.push(nodeId);
    }
  }

  // 2) Build edges via lexical scan.
  for (const srcFile of files) {
    // mtime-based incremental reuse (skipped in CI when mtimeMs=0 for all files).
    if (previousGraph !== null && srcFile.mtimeMs > 0) {
      const prevMtime = previousGraph.fileMtimes.get(srcFile.path);
      if (prevMtime !== undefined && prevMtime === srcFile.mtimeMs) {
        for (const sym of srcFile.symbols) {
          const srcId = `${srcFile.path}:${sym.name}`;
          const prevEdges = previousGraph.edges.get(srcId);
          if (prevEdges !== undefined) edges.set(srcId, new Map(prevEdges));
        }
        continue;
      }
    }

    for (const srcSym of srcFile.symbols) {
      const srcId = `${srcFile.path}:${srcSym.name}`;
      const outEdges = new Map<string, number>();

      for (const [name, targetIds] of nameToNodeIds) {
        if (targetIds.every((id) => id.startsWith(srcFile.path + ":"))) continue;
        if (name === srcSym.name) continue;

        let re: RegExp;
        try {
          re = new RegExp(`\\b${escapeRegExp(name)}\\b`);
        } catch {
          continue;
        }
        if (!re.test(srcFile.raw)) continue;

        for (const tgtId of targetIds) {
          if (tgtId.startsWith(srcFile.path + ":")) continue;
          outEdges.set(tgtId, (outEdges.get(tgtId) ?? 0) + 1);
          if (outEdges.size >= MAX_EDGES_PER_SOURCE) break;
        }
        if (outEdges.size >= MAX_EDGES_PER_SOURCE) break;
      }

      if (outEdges.size > 0) edges.set(srcId, outEdges);
    }
  }

  return { nodes, edges, builtAt: Date.now(), fileMtimes };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Min-max normalize scores to [0, 1].
 * Used for display only — ordering is unchanged.
 */
export function normalizeScores(scores: Map<string, number>): Map<string, number> {
  const values = Array.from(scores.values());
  if (values.length === 0) return scores;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;
  if (range === 0) return new Map(Array.from(scores.keys()).map((k) => [k, 1]));
  return new Map(Array.from(scores.entries()).map(([k, v]) => [k, (v - min) / range]));
}

/**
 * Serializable form for JSON persistence (CI checksum-based cache).
 * Note: CI env where all mtimes === 0 will skip incremental reuse.
 */
export interface SerializedGraph {
  version: 1;
  builtAt: number;
  fileMtimes: Record<string, number>;
  nodes: Array<[string, SymbolNode]>;
  edges: Array<[string, Array<[string, number]>]>;
}

export function serializeGraph(g: SymbolGraph): SerializedGraph {
  return {
    version: 1,
    builtAt: g.builtAt,
    fileMtimes: Object.fromEntries(g.fileMtimes),
    nodes: Array.from(g.nodes.entries()),
    edges: Array.from(g.edges.entries()).map(([src, out]) => [src, Array.from(out.entries())]),
  };
}

export function deserializeGraph(s: SerializedGraph): SymbolGraph {
  return {
    builtAt: s.builtAt,
    fileMtimes: new Map(Object.entries(s.fileMtimes)),
    nodes: new Map(s.nodes),
    edges: new Map(s.edges.map(([src, out]) => [src, new Map(out)])),
  };
}
