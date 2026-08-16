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
import type { SourceIndexManifestV1 } from "./indexStore.js";
import { assertSafeWriteTarget, ensureSafeWriteParent } from "./safeWritePath.js";
import { readRegularFileUtf8 } from "./readGuard.js";

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

export function buildTlGraphFromManifest(manifest: SourceIndexManifestV1): TlGraph {
  const files = manifest.files;

  // 1) Build symbol definition index: symbolName → [{path, line}]
  //    Multiple files can define the same name; keep all.
  const defsByName = new Map<string, { path: string; line: number }[]>();
  const allDefinedNames = new Set<string>();

  for (const [filePath, file] of Object.entries(files)) {
    for (const sym of file.symbols) {
      allDefinedNames.add(sym.name);
      let defs = defsByName.get(sym.name);
      if (!defs) {
        defs = [];
        defsByName.set(sym.name, defs);
      }
      defs.push({ path: filePath, line: sym.lineStart });
    }
  }

  // 2) Build references: for each defined symbol, find files that reference it.
  //    A file "references" symbol X if X appears in outgoingSymbolRefs AND
  //    X is not defined in that same file.
  const refsByName = new Map<string, TlGraphLocation[]>();

  for (const [filePath, file] of Object.entries(files)) {
    const localSymbolNames = new Set(file.symbols.map((s) => s.name));
    for (const refName of Object.keys(file.outgoingSymbolRefs)) {
      if (!allDefinedNames.has(refName)) continue;
      if (localSymbolNames.has(refName)) continue;
      let refs = refsByName.get(refName);
      if (!refs) {
        refs = [];
        refsByName.set(refName, refs);
      }
      refs.push({ path: filePath, line: 1, column: 0 });
    }
  }

  // 3) Assemble symbols array (only symbols that have at least one reference).
  const symbols: TlGraphSymbol[] = [];
  for (const [name, defs] of defsByName) {
    const refs = refsByName.get(name);
    if (!refs || refs.length === 0) continue;
    for (const def of defs) {
      symbols.push({
        name,
        definition: { path: def.path, line: def.line, column: 0 },
        references: refs.filter((r) => r.path !== def.path),
      });
    }
  }
  symbols.sort((a, b) => a.name.localeCompare(b.name) || a.definition.path.localeCompare(b.definition.path));

  // 4) Build file-level imports/exports.
  const graphFiles: TlGraphFile[] = [];
  for (const [filePath, file] of Object.entries(files)) {
    const localSymbolNames = new Set(file.symbols.map((s) => s.name));
    const exportNames = file.symbols.map((s) => s.name);

    // imports: set of files that define any symbol referenced by this file.
    const importedPaths = new Set<string>();
    for (const refName of Object.keys(file.outgoingSymbolRefs)) {
      if (!allDefinedNames.has(refName)) continue;
      if (localSymbolNames.has(refName)) continue;
      const defs = defsByName.get(refName);
      if (!defs) continue;
      for (const def of defs) {
        if (def.path !== filePath) importedPaths.add(def.path);
      }
    }

    if (exportNames.length === 0 && importedPaths.size === 0) continue;

    graphFiles.push({
      path: filePath,
      imports: [...importedPaths].sort(),
      exports: exportNames.sort(),
    });
  }
  graphFiles.sort((a, b) => a.path.localeCompare(b.path));

  return {
    version: 1,
    rootHash: manifest.rootHash,
    symbols,
    files: graphFiles,
  };
}

// ---------------------------------------------------------------------------
// Write (with staleness check)
// ---------------------------------------------------------------------------

export async function writeGraphIfStale(
  root: string,
  manifest: SourceIndexManifestV1,
): Promise<{ written: boolean; symbolCount: number; fileCount: number }> {
  const graphPath = getTlGraphPath(root);

  // Check existing graph's rootHash to skip rebuild when unchanged.
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

  const graph = buildTlGraphFromManifest(manifest);

  ensureSafeWriteParent(root, graphPath, true);
  assertSafeWriteTarget(root, graphPath);
  const tmpPath = graphPath + `.${process.pid}.${Date.now()}.tmp`;
  // Compact JSON — same reasoning as the manifest: readers only JSON.parse,
  // and pretty-printing a repo-scale graph roughly doubles serialize time and
  // disk bytes.
  await fs.writeFile(tmpPath, JSON.stringify(graph), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  ensureSafeWriteParent(root, graphPath, false);
  assertSafeWriteTarget(root, graphPath);
  await fs.rename(tmpPath, graphPath);

  return { written: true, symbolCount: graph.symbols.length, fileCount: graph.files.length };
}
