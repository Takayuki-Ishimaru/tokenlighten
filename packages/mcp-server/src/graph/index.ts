/**
 * graph/index.ts — optional static graph index consumer for v0.7.
 *
 * Reads a tl-graph.json or minimal SCIP binpb from .tokenlighten/index/.
 * When no index exists, returns undefined (fallback to tree-sitter/ripgrep).
 * When TL_GRAPH_INDEX=off, always returns undefined without reading anything.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { graphIndexMode } from "../util/flags.js";
import { trace } from "../util/trace.js";
import { parseTlGraph } from "./tlGraphReader.js";
import { parseScip } from "./scipReader.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GraphLocation {
  path: string;
  line: number;
  column: number;
}

export interface GraphIndex {
  definition(symbol: string): GraphLocation | undefined;
  references(symbol: string): GraphLocation[];
  importsOf(filePath: string): string[];
  exportsOf(filePath: string): string[];
  /**
   * V11-09/V11-05: the index's own content-addressed root/generation
   * identity, when the backing format carries one. tl-graph.json stamps a
   * `rootHash` (skeleton-engine/graphBuilder.ts) that changes exactly when
   * the manifest it was built from changes; `parseTlGraph` surfaces it here
   * so a consumer never has to re-open and re-parse the file's head bytes
   * itself (the previous approach — see graph-evidence/adapters.ts's now-
   * deleted `readTlGraphGeneration` probe — duplicated this read outside
   * the reader that already owns the schema).
   *
   * Returns `undefined` when the backing format has no such identity (SCIP
   * today — `parseScip`'s GraphIndex always returns undefined here) or when
   * a tl-graph.json was read without one (an old/hand-built fixture). A
   * consumer MUST treat `undefined` as "cannot prove freshness" and fail
   * closed, never as "assume fresh".
   */
  rootHash(): string | undefined;
}

// ---------------------------------------------------------------------------
// Workspace-scoped one-time trace guard
// ---------------------------------------------------------------------------

const _missingLogged = new Set<string>();

// ---------------------------------------------------------------------------
// Parsed-graph memo
// ---------------------------------------------------------------------------
//
// Locate probes the graph on every call; a repo-scale tl-graph.json or
// scip.binpb must not be re-read and re-parsed each time. Entries are keyed
// by graph path and revalidated by size+mtime. `index: undefined` memoizes
// an over-cap (or non-regular-file) skip so a stat is the only recurring
// cost. Above GRAPH_INDEX_MAX_BYTES the graph is skipped in auto mode — a
// synchronous parse that large makes every locate slower than having no
// graph at all; TL_GRAPH_INDEX=on overrides the size cap only — a directory
// is never a valid target regardless of override.
export const GRAPH_INDEX_MAX_BYTES = 64 * 1024 * 1024;
const GRAPH_MEMO_MAX_ENTRIES = 4;
const _graphMemo = new Map<string, { sizeBytes: number; mtimeMs: number; index: GraphIndex | undefined }>();
const _oversizeLogged = new Set<string>();

function rememberGraph(graphPath: string, stat: fs.Stats, index: GraphIndex | undefined): void {
  _graphMemo.delete(graphPath);
  if (_graphMemo.size >= GRAPH_MEMO_MAX_ENTRIES) {
    const oldest = _graphMemo.keys().next().value;
    if (oldest !== undefined) _graphMemo.delete(oldest);
  }
  _graphMemo.set(graphPath, { sizeBytes: stat.size, mtimeMs: stat.mtimeMs, index });
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Load a graph index from the workspace's .tokenlighten/index/ directory.
 * Returns undefined if the index is missing, off, or unsupported format.
 */
export function loadGraphIndex(
  workspace: string,
  _options?: { trace?: boolean },
): GraphIndex | undefined {
  const mode = graphIndexMode();
  if (mode === "off") {
    return undefined;
  }

  const indexDir = path.join(workspace, ".tokenlighten", "index");

  // Priority a: tl-graph.json
  const tlGraphPath = path.join(indexDir, "tl-graph.json");
  if (fs.existsSync(tlGraphPath)) {
    let stat: fs.Stats | undefined;
    try {
      stat = fs.statSync(tlGraphPath);
    } catch {
      stat = undefined;
    }
    if (stat !== undefined) {
      const memo = _graphMemo.get(tlGraphPath);
      if (memo !== undefined && memo.sizeBytes === stat.size && memo.mtimeMs === stat.mtimeMs) {
        return memo.index;
      }
      if (stat.size > GRAPH_INDEX_MAX_BYTES && mode !== "on") {
        if (!_oversizeLogged.has(tlGraphPath)) {
          _oversizeLogged.add(tlGraphPath);
          trace(
            "graph-index-too-large",
            { file: "tl-graph.json", sizeBytes: stat.size, maxBytes: GRAPH_INDEX_MAX_BYTES },
            workspace,
          );
        }
        rememberGraph(tlGraphPath, stat, undefined);
        return undefined;
      }
    }
    try {
      const text = fs.readFileSync(tlGraphPath, "utf8");
      const index = parseTlGraph(text);
      if (stat !== undefined) rememberGraph(tlGraphPath, stat, index);
      return index;
    } catch (err) {
      // On parse error treat as missing — don't crash the server.
      trace("graph-index-parse-error", { file: "tl-graph.json", error: String(err) }, workspace);
      return undefined;
    }
  }

  // Priority b: scip.binpb
  const scipPath = path.join(indexDir, "scip.binpb");
  if (fs.existsSync(scipPath)) {
    let stat: fs.Stats | undefined;
    try {
      stat = fs.statSync(scipPath);
    } catch {
      stat = undefined;
    }
    if (stat !== undefined) {
      const memo = _graphMemo.get(scipPath);
      if (memo !== undefined && memo.sizeBytes === stat.size && memo.mtimeMs === stat.mtimeMs) {
        return memo.index;
      }
      if (!stat.isFile()) {
        if (!_oversizeLogged.has(scipPath)) {
          _oversizeLogged.add(scipPath);
          trace("graph-index-not-a-file", { file: "scip.binpb" }, workspace);
        }
        rememberGraph(scipPath, stat, undefined);
        return undefined;
      }
      if (stat.size > GRAPH_INDEX_MAX_BYTES && mode !== "on") {
        if (!_oversizeLogged.has(scipPath)) {
          _oversizeLogged.add(scipPath);
          trace(
            "graph-index-too-large",
            { file: "scip.binpb", sizeBytes: stat.size, maxBytes: GRAPH_INDEX_MAX_BYTES },
            workspace,
          );
        }
        rememberGraph(scipPath, stat, undefined);
        return undefined;
      }
    }
    try {
      const buf = fs.readFileSync(scipPath);
      const index = parseScip(buf);
      if (stat !== undefined) rememberGraph(scipPath, stat, index);
      return index;
    } catch (err) {
      trace("graph-index-parse-error", { file: "scip.binpb", error: String(err) }, workspace);
      return undefined;
    }
  }

  // Priority c: lsif.json — unsupported, trace and return undefined.
  const lsifPath = path.join(indexDir, "lsif.json");
  if (fs.existsSync(lsifPath)) {
    trace("lsif-unimplemented", { file: "lsif.json" }, workspace);
    return undefined;
  }

  // No index found.
  if (mode === "auto" && !_missingLogged.has(workspace)) {
    _missingLogged.add(workspace);
    trace("graph-index-missing", { workspace }, workspace);
  }
  return undefined;
}

/** Reset the one-time trace guards and the parsed-graph memo (for tests). */
export function resetMissingLoggedForTest(): void {
  _missingLogged.clear();
  _oversizeLogged.clear();
  _graphMemo.clear();
}
