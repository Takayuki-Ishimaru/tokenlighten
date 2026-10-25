/**
 * graphBuilder.ts — generates .tokenlighten/index/tl-graph.json from a
 * SourceIndexManifestV1.
 *
 * Cross-references each file's outgoingSymbolRefs against symbols defined in
 * other files to produce the definition/references/imports/exports graph that
 * locateTaskContext consumes via graphIndex.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { IndexedSymbolV1, SourceIndexManifestV1 } from "./indexStore.js";
import { assertSafeWriteTarget } from "./safeWritePath.js";
import { readRegularFileUtf8 } from "./readGuard.js";
import { writeJsonAtomic, type AtomicJsonWriteHooks } from "./atomicJson.js";

// ---------------------------------------------------------------------------
// Types (mirror tlGraphReader.ts schema)
// ---------------------------------------------------------------------------

interface TlGraphLocation {
  path: string;
  line: number;
  column: number;
}

interface TlGraphSymbol {
  name: string;
  definition: TlGraphLocation;
  references: TlGraphLocation[];
}

interface TlGraphFile {
  path: string;
  imports: string[];
  exports: string[];
}

interface TlGraph {
  version: 1;
  /**
   * V11-09: monotonic generation identity, carried through unchanged from
   * `SourceIndexManifestV1.generation` (0 for a manifest built before this
   * field existed). Two graph writes built from manifests with the SAME
   * rootHash always carry the same generation; a rootHash change always
   * bumps it. This is the "both-ends" and "reader sees generation N gets
   * only generation-N edges" identity the V11-09 design brief asks for:
   * every symbol's definition+references pair and every file's
   * imports/exports are computed from ONE manifest snapshot in this single
   * function call and published in ONE atomic write (see writeGraphIfStale
   * below) — there is no code path that updates one edge direction without
   * the other, so this field mainly exists to make that invariant
   * EXPLICITLY checkable (by a reader, or by a spec) rather than merely
   * implied by the absence of any incremental-patch code path.
   */
  generation: number;
  rootHash: string;
  symbols: TlGraphSymbol[];
  files: TlGraphFile[];
}

// ---------------------------------------------------------------------------
// Graph path
// ---------------------------------------------------------------------------

export const TL_GRAPH_PATH = ".tokenlighten/index/tl-graph.json";

export function getTlGraphPath(root: string): string {
  return join(root, ".tokenlighten", "index", "tl-graph.json");
}

// Above this size the staleness probe reads only the file head for rootHash
// instead of parsing the whole graph JSON per call.
const GRAPH_STALENESS_FULL_PARSE_MAX_BYTES = 8 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

interface GraphNameSummary {
  definitionCount: number;
  definitionPathChars: number;
  referenceCount: number;
  referencePathChars: number;
}
interface GraphBuildIndex {
  defsByName: Map<string, { path: string; symbol: IndexedSymbolV1 }[]>;
  allDefinedNames: Set<string>;
  refsByName: Map<string, TlGraphLocation[]>;
  nameSummaries: Map<string, GraphNameSummary>;
  symbolCount: number;
  fileCount: number;
  exportNameChars: number;
  graphFilePathChars: number;
  metricOverflow: boolean;
}
function addMetric(index: GraphBuildIndex, current: number, amount: number): number {
  if (!Number.isSafeInteger(amount) || amount < 0 || current > Number.MAX_SAFE_INTEGER - amount) {
    index.metricOverflow = true;
    return Number.MAX_SAFE_INTEGER;
  }
  return current + amount;
}
/** Build shared linear indexes without D×R references or imported-path sets. */
function indexGraphManifest(manifest: SourceIndexManifestV1): GraphBuildIndex {
  const defsByName = new Map<string, { path: string; symbol: IndexedSymbolV1 }[]>();
  const allDefinedNames = new Set<string>();
  const refsByName = new Map<string, TlGraphLocation[]>();
  const nameSummaries = new Map<string, GraphNameSummary>();
  const index: GraphBuildIndex = {
    defsByName, allDefinedNames, refsByName, nameSummaries,
    symbolCount: 0, fileCount: 0, exportNameChars: 0, graphFilePathChars: 0, metricOverflow: false,
  };
  for (const [filePath, file] of Object.entries(manifest.files)) {
    for (const sym of file.symbols) {
      allDefinedNames.add(sym.name);
      let defs = defsByName.get(sym.name);
      if (!defs) { defs = []; defsByName.set(sym.name, defs); }
      defs.push({ path: filePath, symbol: sym });
      let summary = nameSummaries.get(sym.name);
      if (!summary) {
        summary = { definitionCount: 0, definitionPathChars: 0, referenceCount: 0, referencePathChars: 0 };
        nameSummaries.set(sym.name, summary);
      }
      summary.definitionCount += 1;
      summary.definitionPathChars = addMetric(index, summary.definitionPathChars, filePath.length);
      index.exportNameChars = addMetric(index, index.exportNameChars, sym.name.length);
    }
  }
  for (const [filePath, file] of Object.entries(manifest.files)) {
    const localSymbolNames = new Set(file.symbols.map((sym) => sym.name));
    let hasExternalImport = false;
    for (const refName of Object.keys(file.outgoingSymbolRefs)) {
      const summary = nameSummaries.get(refName);
      if (!summary || localSymbolNames.has(refName)) continue;
      let refs = refsByName.get(refName);
      if (!refs) { refs = []; refsByName.set(refName, refs); }
      refs.push({ path: filePath, line: 1, column: 0 });
      summary.referenceCount += 1;
      summary.referencePathChars = addMetric(index, summary.referencePathChars, filePath.length);
      hasExternalImport = true;
    }
    if (file.symbols.length > 0 || hasExternalImport) {
      index.fileCount += 1;
      index.graphFilePathChars = addMetric(index, index.graphFilePathChars, filePath.length);
    }
  }
  for (const summary of nameSummaries.values()) {
    if (summary.referenceCount > 0) index.symbolCount += summary.definitionCount;
  }
  return index;
}
interface LowerBound { value: number; overflow: boolean; }
function addLowerBound(bound: LowerBound, amount: number): void {
  if (bound.overflow) return;
  if (!Number.isSafeInteger(amount) || amount < 0 || bound.value > Number.MAX_SAFE_INTEGER - amount) {
    bound.value = Number.MAX_SAFE_INTEGER; bound.overflow = true; return;
  }
  bound.value += amount;
}
function addLowerBoundProduct(bound: LowerBound, left: number, right: number): void {
  if (bound.overflow) return;
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right) || left < 0 || right < 0 ||
      (left !== 0 && right > Math.floor(Number.MAX_SAFE_INTEGER / left))) {
    bound.value = Number.MAX_SAFE_INTEGER; bound.overflow = true; return;
  }
  addLowerBound(bound, left * right);
}
/**
 * Guaranteed byte lower bound: UTF-16 string lengths do not exceed the
 * serialized UTF-8 form, and omitted syntax, escapes, numbers and imports
 * only add bytes. The bound uses source-order indexes, never D×R objects.
 */
function estimateIndexedGraphMinBytes(manifest: SourceIndexManifestV1, index: GraphBuildIndex): LowerBound {
  const bound: LowerBound = { value: 0, overflow: index.metricOverflow };
  addLowerBound(bound, manifest.rootHash.length);
  addLowerBound(bound, index.exportNameChars);
  addLowerBound(bound, index.graphFilePathChars);
  for (const [name, summary] of index.nameSummaries) {
    if (summary.referenceCount === 0) continue;
    addLowerBoundProduct(bound, summary.definitionCount, name.length);
    addLowerBound(bound, summary.definitionPathChars);
    addLowerBoundProduct(bound, summary.definitionCount, summary.referencePathChars);
  }
  return bound;
}
function exceedsCap(bound: LowerBound, maxBytes: number): boolean {
  if (Number.isNaN(maxBytes)) return false;
  if (bound.overflow) return maxBytes <= Number.MAX_SAFE_INTEGER;
  return bound.value > maxBytes;
}
function assembleTlGraph(manifest: SourceIndexManifestV1, index: GraphBuildIndex): TlGraph {
  const symbols: TlGraphSymbol[] = [];
  for (const [name, defs] of index.defsByName) {
    const refs = index.refsByName.get(name);
    if (!refs || refs.length === 0) continue;
    for (const def of defs) {
      symbols.push({
        name,
        definition: { path: def.path, line: def.symbol.lineStart, column: 0 },
        references: refs.filter((ref) => ref.path !== def.path),
      });
    }
  }
  symbols.sort((a, b) => a.name.localeCompare(b.name) || a.definition.path.localeCompare(b.definition.path));
  const graphFiles: TlGraphFile[] = [];
  for (const [filePath, file] of Object.entries(manifest.files)) {
    const localSymbolNames = new Set(file.symbols.map((sym) => sym.name));
    const exportNames = file.symbols.map((sym) => sym.name);
    const importedPaths = new Set<string>();
    for (const refName of Object.keys(file.outgoingSymbolRefs)) {
      if (!index.allDefinedNames.has(refName) || localSymbolNames.has(refName)) continue;
      const defs = index.defsByName.get(refName);
      if (!defs) continue;
      for (const def of defs) if (def.path !== filePath) importedPaths.add(def.path);
    }
    if (exportNames.length === 0 && importedPaths.size === 0) continue;
    graphFiles.push({ path: filePath, imports: [...importedPaths].sort(), exports: exportNames.sort() });
  }
  graphFiles.sort((a, b) => a.path.localeCompare(b.path));
  return { version: 1, generation: manifest.generation ?? 0, rootHash: manifest.rootHash, symbols, files: graphFiles };
}
/** Deterministic complete graph builder retained for direct callers. */
export function buildTlGraphFromManifest(manifest: SourceIndexManifestV1): TlGraph {
  return assembleTlGraph(manifest, indexGraphManifest(manifest));
}

// ---------------------------------------------------------------------------
// Write (with staleness check)
// ---------------------------------------------------------------------------

export interface WriteGraphIfStaleOptions {
  /**
   * V11-09: bypass the rootHash-match shortcut and rebuild unconditionally.
   * Set by loadOrBuildSourceIndex when publishJournal.ts reports a possibly
   * incomplete prior publish (a crash between the manifest write and this
   * graph write) — in that situation the on-disk graph's rootHash cannot be
   * trusted to prove freshness, because we cannot prove IT wasn't the thing
   * left half-published. Defaults to false (the normal, cheap path).
   */
  forceRebuild?: boolean;
  /** Test-only — see atomicJson.ts's AtomicJsonWriteHooks.beforeRename. */
  beforeRename?: AtomicJsonWriteHooks["beforeRename"];
  /**
   * Perf (2026-09-27, large-workspace task_pack cost, item D): "auto"
   * (default when omitted) and "off" apply `graphIndexMaxBytes` as a
   * publish gate — skip the stringify+write for a graph that large,
   * because the READER (mcp-server/src/graph/index.ts's own
   * GRAPH_INDEX_MAX_BYTES check) never reads a graph above that same cap
   * back in either of those modes anyway, so publishing it changes nothing
   * any caller can observe. "on" bypasses the gate — exactly mirroring the
   * reader's own "on" bypass — so a graph the caller explicitly opted into
   * publishing at any size still is, unchanged from before this option
   * existed. skeleton-engine reads no environment itself: the caller
   * (mcp-server) resolves its own TL_GRAPH_INDEX env into this value.
   */
  graphIndexMode?: "auto" | "on" | "off";
  /**
   * The reader's own size cap (mcp-server/src/graph/index.ts's
   * GRAPH_INDEX_MAX_BYTES), threaded in rather than duplicated as an
   * independent literal so the write-side gate and the read-side cap can
   * never silently drift apart. Defaults to 64 MiB (today's mcp-server
   * value) when the caller does not pass one.
   */
  graphIndexMaxBytes?: number;
}

/** Default for `WriteGraphIfStaleOptions.graphIndexMaxBytes` — mirrors mcp-server/src/graph/index.ts's GRAPH_INDEX_MAX_BYTES at the time of this writing; a caller SHOULD pass the real value explicitly. */
export const DEFAULT_GRAPH_INDEX_MAX_BYTES = 64 * 1024 * 1024;

/** Post-build lower bound retained for remaining import-heavy cases. */
function estimateGraphMinBytes(graph: TlGraph): number {
  let total = graph.rootHash.length;
  for (const symbol of graph.symbols) {
    total += symbol.name.length + symbol.definition.path.length;
    for (const ref of symbol.references) total += ref.path.length;
  }
  for (const file of graph.files) {
    total += file.path.length;
    for (const imported of file.imports) total += imported.length;
    for (const exported of file.exports) total += exported.length;
  }
  return total;
}

export async function writeGraphIfStale(
  root: string,
  manifest: SourceIndexManifestV1,
  opts?: WriteGraphIfStaleOptions,
): Promise<{ written: boolean; symbolCount: number; fileCount: number }> {
  const graphPath = getTlGraphPath(root);

  // Check existing graph's rootHash to skip rebuild when unchanged — unless
  // the caller has proven that shortcut unsafe for this call (forceRebuild),
  // in which case we skip straight to an unconditional rebuild below.
  if (!opts?.forceRebuild) {
    try {
      assertSafeWriteTarget(root, graphPath);
      const stat = await fs.stat(graphPath);
      if (stat.isFile() && stat.size > GRAPH_STALENESS_FULL_PARSE_MAX_BYTES) {
        // A repo-scale graph is too expensive to JSON.parse on every staleness
        // probe. This writer emits rootHash before the large symbol/file arrays
        // (object-literal key order), so the head bytes decide freshness; the
        // exact counts are only available via a full parse and are reported as
        // 0 on this path.
        const fh = await fs.open(graphPath, "r");
        let head: string;
        try {
          const buf = Buffer.alloc(4096);
          const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
          head = buf.subarray(0, bytesRead).toString("utf8");
        } finally {
          await fh.close();
        }
        const match = /"rootHash"\s*:\s*"([^"]+)"/.exec(head);
        if (match !== null && match[1] === manifest.rootHash) {
          return { written: false, symbolCount: 0, fileCount: 0 };
        }
      } else {
        const existing = await readRegularFileUtf8(graphPath);
        const parsed = JSON.parse(existing);
        if (parsed && parsed.rootHash === manifest.rootHash) {
          return {
            written: false,
            symbolCount: Array.isArray(parsed.symbols) ? parsed.symbols.length : 0,
            fileCount: Array.isArray(parsed.files) ? parsed.files.length : 0,
          };
        }
      }
    } catch {
      // Missing or corrupt — rebuild.
    }
  }

  // Build linear indexes once. Admission uses their counts and string
  // lengths, then returns before D×R reference arrays or import sets exist.
  const graphIndex = indexGraphManifest(manifest);
  if ((opts?.graphIndexMode ?? "auto") !== "on") {
    const maxBytes = opts?.graphIndexMaxBytes ?? DEFAULT_GRAPH_INDEX_MAX_BYTES;
    if (exceedsCap(estimateIndexedGraphMinBytes(manifest, graphIndex), maxBytes)) {
      return { written: false, symbolCount: graphIndex.symbolCount, fileCount: graphIndex.fileCount };
    }
  }
  const graph = assembleTlGraph(manifest, graphIndex);
  if ((opts?.graphIndexMode ?? "auto") !== "on") {
    const maxBytes = opts?.graphIndexMaxBytes ?? DEFAULT_GRAPH_INDEX_MAX_BYTES;
    if (estimateGraphMinBytes(graph) > maxBytes) {
      return { written: false, symbolCount: graph.symbols.length, fileCount: graph.files.length };
    }
  }

  // Compact JSON — same reasoning as the manifest: readers only JSON.parse,
  // and pretty-printing a repo-scale graph roughly doubles serialize time and
  // disk bytes. writeJsonAtomic (atomicJson.ts) owns the safety checks and
  // the write-tmp-then-rename sequence — see V11-09's doc comment there for
  // why this is the one seam every skeleton-engine on-disk artifact
  // publishes through, and what `beforeRename` is for.
  await writeJsonAtomic(
    root,
    graphPath,
    JSON.stringify(graph),
    (dir) => join(dir, `tl-graph.json.${process.pid}.${Date.now()}.tmp`),
    { beforeRename: opts?.beforeRename },
  );

  return { written: true, symbolCount: graph.symbols.length, fileCount: graph.files.length };
}
