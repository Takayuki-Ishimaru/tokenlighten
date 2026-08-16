/**
 * projectRoot.ts — general, environment-agnostic project-root detection.
 *
 * Replaces locateTaskContext.ts's former BENCH-SPECIFIC root model (which
 * keyed roots ONLY on the `bench/fixtures/<name>/` path boundary and folded
 * every other path into one "host" root). The generalization: a directory is
 * a project root when it carries a VCS boundary (a `.git` entry) or a
 * recognized build/package manifest (package.json, go.mod, Cargo.toml, …).
 * Each file's root is the NEAREST enclosing such directory, or the workspace
 * root ("") when none encloses it.
 *
 * This makes the locator's cross-project scoping work for ANY monorepo /
 * parent-cwd layout — not just this repo's bench fixtures — which is the whole
 * point: the failure it fixes (a task about a subproject getting outvoted by
 * stray identifier matches in unrelated code when the caller's cwd is a parent
 * directory) is a general-environment problem, and the fix must not hard-code
 * one repo's directory names.
 *
 * A `RootResolver` is BUILT ONCE per locate() call from the shared walked file
 * list (so no extra filesystem traversal) plus a bounded per-candidate-dir
 * marker probe, then threaded through every consumer that needs "which root
 * does this path belong to". The pure `rootOf(relPath)` closure it exposes is
 * shape-compatible with the old `projectRootOf` signature, so the existing
 * `dominantRoot(paths, rootOf)` / `surfaceInventory(paths, rootOf, …)` call
 * sites keep working by swapping the root-id function, exactly as the design
 * requires.
 */

import * as fs from "fs";
import * as path from "path";

/**
 * Curated root-marker filenames. A directory containing ANY of these (or a
 * `.git` entry — handled separately, since `.git` is ignore-filtered out of
 * the code walk) is treated as a project root.
 *
 * Deliberately a small, high-precision set of ECOSYSTEM manifests — the files
 * that, by convention, sit at the root of a self-contained buildable project
 * across the languages this tool targets. Lockfiles and editor/config dotfiles
 * are intentionally excluded: they co-occur with a manifest at a real root but
 * also litter subdirectories, so keying on them would over-split.
 *
 * `Makefile`/`CMakeLists.txt` are included because a C/C++ firmware/library
 * subproject frequently has no other manifest; they are the closest thing to a
 * "package boundary" that ecosystem has. (A manifest-LESS embedded subtree is
 * still recoverable via query-cluster inference — see inferClusterRoot — so
 * this list not being exhaustive is not a correctness gap.)
 */
export const ROOT_MARKER_FILES: ReadonlyArray<string> = [
  "package.json",
  "go.mod",
  "Cargo.toml",
  "pyproject.toml",
  "setup.py",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "CMakeLists.txt",
  "composer.json",
  "Gemfile",
  "Makefile",
];

/** A `*.sln` (any basename) marks a .NET solution root; checked by suffix. */
const SOLUTION_SUFFIX = ".sln";

/** VCS boundary entry (dir OR file — git worktrees/submodules use a `.git` file). */
const VCS_MARKER = ".git";

export interface RootResolver {
  /**
   * The project root (workspace-relative POSIX dir, or "" for the workspace
   * root itself) that OWNS `relPath` — the nearest enclosing root-marker
   * directory, else "".
   */
  rootOf(relPath: string): string;
  /**
   * Every detected non-workspace root (workspace-relative POSIX dir), longest
   * first. Excludes "" (the workspace root sentinel). Exposed for the
   * cluster-inference refinement, which only augments roots when the whole
   * pool resolves to "".
   */
  readonly markerRoots: ReadonlyArray<string>;
}

/**
 * Normalize a candidate directory to a workspace-relative POSIX prefix with no
 * leading/trailing slash. "" and "." collapse to "" (the workspace root).
 */
function normDir(relDir: string): string {
  let p = relDir.replace(/\\/g, "/");
  while (p.startsWith("./")) p = p.slice(2);
  p = p.replace(/^\/+/, "").replace(/\/+$/, "");
  return p === "." ? "" : p;
}

/** All ancestor directories (workspace-relative POSIX) of a file path, including "". */
function ancestorDirs(relPath: string): string[] {
  const norm = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const segs = norm.split("/").slice(0, -1); // drop the filename
  const out: string[] = [""];
  let acc = "";
  for (const seg of segs) {
    acc = acc === "" ? seg : `${acc}/${seg}`;
    out.push(acc);
  }
  return out;
}

/** True when `dir` (absolute) contains any root marker or a VCS boundary. */
function dirHasRootMarker(absDir: string): boolean {
  if (fs.existsSync(path.join(absDir, VCS_MARKER))) return true;
  for (const marker of ROOT_MARKER_FILES) {
    if (fs.existsSync(path.join(absDir, marker))) return true;
  }
  // *.sln — cheap directory scan only reached when no fixed marker matched.
  try {
    for (const name of fs.readdirSync(absDir)) {
      if (name.toLowerCase().endsWith(SOLUTION_SUFFIX)) return true;
    }
  } catch {
    // unreadable dir — treat as no marker.
  }
  return false;
}

const SOURCE_DIR_NAMES = new Set(["src", "source", "sources", "lib"]);
const PUBLIC_INTERFACE_DIR_NAMES = new Set(["include", "inc", "headers"]);
const TEST_DIR_NAMES = new Set(["test", "tests", "spec", "specs"]);

/**
 * Marker-less project boundary inference for native/embedded/vendor drops.
 *
 * Many real C/C++ and firmware repos have no package manifest at the logical
 * project root, but do have a stable shape such as `src/` + `include/` or
 * `src/` + `tests/`. Treat that directory as a boundary without naming any
 * benchmark fixture paths.
 */
function dirHasMarkerlessProjectShape(absDir: string): boolean {
  let names: string[];
  try {
    names = fs.readdirSync(absDir).map((name) => name.toLowerCase());
  } catch {
    return false;
  }
  const hasSource = names.some((name) => SOURCE_DIR_NAMES.has(name));
  const hasInterface = names.some((name) => PUBLIC_INTERFACE_DIR_NAMES.has(name));
  const hasTests = names.some((name) => TEST_DIR_NAMES.has(name));
  return hasSource && (hasInterface || hasTests);
}

/** True when `dir` carries an explicit marker or an inferred project shape. */
function dirIsProjectRoot(absDir: string): boolean {
  return dirHasRootMarker(absDir) || dirHasMarkerlessProjectShape(absDir);
}

/**
 * Build a RootResolver from the walked file list. Detects a root-marker
 * directory for every distinct ancestor directory that actually contains code
 * (bounded by the walk's own size — no extra tree traversal), probing the
 * filesystem at most once per distinct directory.
 *
 * `workspace` is the absolute workspace root; `relPaths` are the walked
 * workspace-relative code-file paths. The workspace root itself is probed too,
 * so a single-project repo whose root carries a manifest still yields a
 * consistent (empty-string) root for every file, and a genuinely multi-root
 * layout splits at each nested manifest.
 */
export function buildRootResolver(workspace: string, relPaths: ReadonlyArray<string>): RootResolver {
  const workspaceAbs = path.resolve(workspace);

  // Distinct candidate directories (every ancestor of every code file, plus
  // the workspace root ""). Memoize the marker probe per directory.
  const isMarkerDir = new Map<string, boolean>();
  const probe = (relDir: string): boolean => {
    const cached = isMarkerDir.get(relDir);
    if (cached !== undefined) return cached;
    const absDir = relDir === "" ? workspaceAbs : path.join(workspaceAbs, relDir);
    const has = dirIsProjectRoot(absDir);
    isMarkerDir.set(relDir, has);
    return has;
  };

  const candidateDirs = new Set<string>();
  for (const rel of relPaths) {
    for (const dir of ancestorDirs(rel)) candidateDirs.add(dir);
  }
  // Probe each candidate dir once; collect the non-workspace marker roots.
  const markerRootSet = new Set<string>();
  for (const dir of candidateDirs) {
    if (dir === "") continue; // "" is the fallback sentinel, never a "nested" root
    if (probe(dir)) markerRootSet.add(dir);
  }
  // Longest-first so `rootOf` picks the NEAREST enclosing marker root.
  const markerRoots = [...markerRootSet].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));

  // Per-path resolution memo (a file's root is looked up repeatedly across
  // the scoring pipeline).
  const rootMemo = new Map<string, string>();
  const rootOf = (relPath: string): string => {
    const norm = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
    const cached = rootMemo.get(norm);
    if (cached !== undefined) return cached;
    let owner = "";
    for (const root of markerRoots) {
      if (norm === root || norm.startsWith(root + "/")) {
        owner = root;
        break;
      }
    }
    rootMemo.set(norm, owner);
    return owner;
  };

  return { rootOf, markerRoots };
}

/**
 * Query-cluster subtree inference (manifest-independent fallback). Some real
 * subprojects carry no manifest at all (e.g. an embedded C++ firmware tree).
 * When the pool's score mass concentrates under one directory subtree, treat
 * that subtree as the effective task root even without a marker.
 *
 * Returns the nearest common ancestor directory of the cluster (depth >= 2
 * from the workspace root) when >= `massThreshold` of the total score mass
 * among the top-`topK` items falls under it; otherwise null. Depth >= 2 avoids
 * nominating a shallow, near-workspace-root directory (e.g. "src") that would
 * scope nothing useful.
 *
 * This is a REFINEMENT layered on top of marker roots: the caller applies it
 * only when marker-based detection did not already produce a dominant root
 * (i.e. the dominant root would otherwise be the workspace root itself), so a
 * genuine multi-manifest layout is never overridden by an incidental cluster.
 */
export function inferClusterRoot(
  items: ReadonlyArray<{ path: string; score: number }>,
  opts: { topK?: number; massThreshold?: number; minDepth?: number } = {},
): string | null {
  const topK = opts.topK ?? 8;
  const massThreshold = opts.massThreshold ?? 0.6;
  const minDepth = opts.minDepth ?? 2;

  if (items.length === 0) return null;
  // Rank by score desc, take the top-K as the cluster-defining set. Only
  // positive-score items contribute mass (a demoted/negative candidate must
  // not drag the cluster or its denominator).
  const ranked = [...items]
    .filter((i) => i.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
  if (ranked.length === 0) return null;

  const totalMass = ranked.reduce((s, i) => s + i.score, 0);
  if (totalMass <= 0) return null;

  // Try each candidate common-ancestor directory: for every prefix depth of
  // the highest-scored item, compute the mass of ranked items under it and the
  // nearest common ancestor of exactly those items. Prefer the DEEPEST subtree
  // that still captures >= massThreshold (most specific).
  const top = ranked[0]!;
  const topDirs = ancestorDirs(top.path).filter((d) => d.split("/").length >= minDepth);
  let best: string | null = null;
  let bestDepth = -1;
  for (const dir of topDirs) {
    const under = ranked.filter((i) => i.path === dir || i.path.startsWith(dir + "/"));
    const mass = under.reduce((s, i) => s + i.score, 0);
    if (mass / totalMass < massThreshold) continue;
    // Nearest common ancestor of the captured cluster (may be deeper than dir).
    const nca = commonAncestorDir(under.map((i) => i.path));
    const ncaDepth = nca === "" ? 0 : nca.split("/").length;
    if (ncaDepth < minDepth) continue;
    if (ncaDepth > bestDepth) {
      best = nca;
      bestDepth = ncaDepth;
    }
  }
  return best;
}

/**
 * Workspace-relative POSIX directory that contains every path in `relPaths`
 * (their nearest common ancestor DIRECTORY). Returns "" when they share no
 * directory below the workspace root. A single path yields its own parent
 * directory.
 */
export function commonAncestorDir(relPaths: ReadonlyArray<string>): string {
  if (relPaths.length === 0) return "";
  const split = relPaths.map((p) => normDir(path.posix.dirname(p.replace(/\\/g, "/"))));
  let prefix = split[0]!.split("/").filter((s) => s.length > 0);
  for (const dir of split.slice(1)) {
    const segs = dir.split("/").filter((s) => s.length > 0);
    let i = 0;
    while (i < prefix.length && i < segs.length && prefix[i] === segs[i]) i++;
    prefix = prefix.slice(0, i);
    if (prefix.length === 0) break;
  }
  return prefix.join("/");
}
