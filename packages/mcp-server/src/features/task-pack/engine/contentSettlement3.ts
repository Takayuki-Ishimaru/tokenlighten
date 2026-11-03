// contentSettlement — extracted implementation; imports point to the owning modules.
import * as path from "path";
import type { TaskPackSurface } from "../model.js";
import { readCached } from "./packBasics2.js";
import { statKindCached } from "../../../util/packServeLog.js";
import { stripModuleExtension } from "./wiringEvidence3.js";

/** Relative import/require specifier in an already-served JS/TS body (no parse). */
export const REL_IMPORT_SPEC_RE = /(?:\bfrom\b|\bimport\b|\brequire\s*\()\s*['"](\.[^'"]+)['"]/g;

/**
 * IMPROVEMENT A part 3: depth-1 import neighbours of the served surfaces,
 * resolved WITHOUT any new tree-sitter parse — a bounded regex scan of each
 * surface's ALREADY-available body for RELATIVE import specifiers, each resolved
 * against the surface's own directory with a cheap statKindCached extension
 * probe. Bare/package specifiers are ignored; anything that does not resolve to
 * an existing workspace file is skipped silently. Returns workspace-relative
 * paths not already in `seen`.
 */
export function directImportNeighbors(
  workspace: string,
  surfaces: TaskPackSurface[],
  seen: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  const emitted = new Set<string>();
  const exts = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];
  for (const s of surfaces) {
    if (out.length >= 40) break;
    if (!/\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/i.test(s.path)) continue;
    const body = s.code ?? readCached(workspace, s.path);
    if (body === undefined) continue;
    const dir = path.posix.dirname(s.path);
    let count = 0;
    for (const m of body.matchAll(REL_IMPORT_SPEC_RE)) {
      if (count >= 12 || out.length >= 40) break;
      const spec = m[1];
      if (spec === undefined) continue;
      count++;
      const base = path.posix.normalize(path.posix.join(dir, spec));
      if (base.startsWith("..")) continue; // escaped the workspace root — ignore
      // TypeScript projects commonly write runtime `.js` specifiers while
      // keeping the source as `.ts`.  Probe from the module stem as well as
      // the literal specifier; otherwise a real `./provider.js` ->
      // `provider.ts` import is invisible to every bounded neighbour user.
      const moduleBase = stripModuleExtension(base);
      const candidates = [
        base,
        moduleBase,
        ...exts.map((e) => `${moduleBase}${e}`),
        ...exts.map((e) => `${moduleBase}/index${e}`),
      ];
      for (const cand of candidates) {
        if (seen.has(cand) || emitted.has(cand)) continue;
        if (statKindCached(workspace, workspace, cand) === "file") {
          emitted.add(cand);
          out.push(cand);
          break;
        }
      }
    }
  }
  return out;
}
