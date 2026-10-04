/**
 * importResolution.ts — import/include edge resolution shared by the V15-NBR
 * neighbour index (frontierNeighbours.ts) and the V15-FUI usage inventory
 * (usageInventory.ts). Both consumers are default OFF (`TL_NEIGHBOUR_INDEX`,
 * `TL_USAGE_INVENTORY`); nothing here runs unless one of them is enabled.
 *
 * CONTRACT (consumers rely on exactly this):
 * - `resolveImportsOf(workspace, filePath, body, maxEdges)` returns the edges
 *   from `filePath` to EXISTING workspace files: statement-spelled edges
 *   (`import`/`include`) in the order their statements appear in `body`, then
 *   edges no statement spells (`reference`, `counterpart`), deduplicated by
 *   target path (first edge wins), at most `maxEdges`. Never a path outside
 *   the workspace, never `filePath` itself, never a guess: an import that
 *   does not resolve to a real file is dropped.
 * - `projectRootsOf(workspace, filePath)` (importGraphShared.ts) lists the
 *   workspace-relative directories between `filePath` and the workspace root
 *   that hold a project/build manifest, NEAREST FIRST.
 * - `languageFamilyOf(filePath)` names the language family a file belongs to
 *   (undefined for a file no resolver handles).
 *
 * One resolver module per family (importResolveWeb/Python/Go/Jvm.ts,
 * cIncludes.ts); each is a generic syntax scan (no fixture-specific literal)
 * that skips comment lines, so a commented-out import is never suggested.
 */
import * as path from "path";
import { resolveCIncludesOf, C_FAMILY_EXTENSIONS } from "./cIncludes.js";
import { type ResolvedImport, realPathInside } from "./importGraphShared.js";
import { resolveGoImports } from "./importResolveGo.js";
import { resolveJvmImports } from "./importResolveJvm.js";
import { resolvePythonImports } from "./importResolvePython.js";
import { resolveWebImports, WEB_EXTENSIONS } from "./importResolveWeb.js";

export type { ResolvedImport } from "./importGraphShared.js";
export { projectRootsOf } from "./importGraphShared.js";

/** Bounds a pathological file's edge list; well above any real file's import count. */
export const MAX_IMPORT_EDGES_PER_FILE = 40;

export type LanguageFamily = "web" | "python" | "go" | "jvm" | "c";

export function languageFamilyOf(filePath: string): LanguageFamily | undefined {
  const ext = path.posix.extname(filePath.replace(/\\/g, "/")).toLowerCase();
  if (WEB_EXTENSIONS.includes(ext)) return "web";
  if (ext === ".py") return "python";
  if (ext === ".go") return "go";
  if (ext === ".java" || ext === ".kt" || ext === ".kts") return "jvm";
  if (C_FAMILY_EXTENSIONS.includes(ext)) return "c";
  return undefined;
}

const SPELLED_KINDS = new Set<ResolvedImport["kind"]>(["import", "include"]);

export function resolveImportsOf(
  workspace: string,
  filePath: string,
  body: string,
  maxEdges: number = MAX_IMPORT_EDGES_PER_FILE,
): ResolvedImport[] {
  if (maxEdges <= 0 || body.length === 0) return [];
  const family = languageFamilyOf(filePath);
  if (family === undefined) return [];
  const lines = body.split(/\r?\n/);
  let edges: ResolvedImport[];
  try {
    switch (family) {
      case "web": edges = resolveWebImports(workspace, filePath, lines); break;
      case "python": edges = resolvePythonImports(workspace, filePath, lines); break;
      case "go": edges = resolveGoImports(workspace, filePath, lines); break;
      case "jvm": edges = resolveJvmImports(workspace, filePath, lines); break;
      case "c": edges = resolveCIncludesOf(workspace, filePath, lines, maxEdges); break;
    }
  } catch {
    // A resolver failure never fails the pack: the prototypes are advisory.
    return [];
  }
  // Statement-spelled edges first (stable), then the unspelled ones (stable).
  const ordered = [...edges.filter((e) => SPELLED_KINDS.has(e.kind)), ...edges.filter((e) => !SPELLED_KINDS.has(e.kind))];
  const self = path.posix.normalize(filePath.replace(/\\/g, "/")).replace(/^\.\//, "");
  const seen = new Set<string>([self]);
  const out: ResolvedImport[] = [];
  for (const edge of ordered) {
    if (out.length >= maxEdges) break;
    if (seen.has(edge.path)) continue;
    seen.add(edge.path);
    // Uniform safety net over every family: an edge whose real path leaves
    // the workspace (a symlink inside pointing out) is never emitted.
    if (!realPathInside(workspace, edge.path)) continue;
    out.push(edge);
  }
  return out;
}
