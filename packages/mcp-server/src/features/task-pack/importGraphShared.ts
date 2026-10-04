/**
 * importGraphShared.ts — shared types and workspace-boundary-safe file access
 * for the import/include edge resolvers behind the V15-NBR neighbour index
 * (frontierNeighbours.ts) and the V15-FUI usage inventory (usageInventory.ts).
 * Both consumers are default OFF (`TL_NEIGHBOUR_INDEX`, `TL_USAGE_INVENTORY`);
 * nothing here runs unless one of them is enabled.
 *
 * Kept as its own leaf module so importResolution.ts (the per-language
 * dispatcher) and cIncludes.ts (the C/C++ family) can share these helpers
 * without importing each other in a cycle.
 */
import * as fs from "fs";
import * as path from "path";

/** One resolved edge from an importing file to an existing workspace file. */
export interface ResolvedImport {
  /** Workspace-relative POSIX path of an existing workspace file. */
  path: string;
  /**
   * 1-based line of the import/include statement in the importing body; 0
   * for an edge that no statement in the body spells (a header/source
   * counterpart).
   */
  line: number;
  /**
   * How the edge was found: `import` = an import statement names the target
   * (module/package/type); `include` = a C/C++ `#include`; `counterpart` = a
   * header/source pair no statement spells; `reference` = the body uses an
   * identifier the target declares, with no import needed (same Java/Kotlin
   * package, same Go package directory).
   */
  kind: "import" | "include" | "counterpart" | "reference";
  /**
   * Names the statement binds or imports, when its syntax lists them — both
   * the local binding and, for an aliased import, the imported name (TS/JS
   * named/default/namespace imports, Python `from … import` names or the
   * bound module name, the Java simple type name, the Go package qualifier).
   * `[]` when the syntax names nothing (side-effect imports, `#include`).
   */
  names: string[];
}

/** Absolute path of `relPath` when it stays inside `workspace`; undefined otherwise. */
export function withinWorkspace(workspace: string, relPath: string): string | undefined {
  if (relPath.length === 0 || path.posix.isAbsolute(relPath) || /^[A-Za-z]:[\\/]/.test(relPath)) return undefined;
  const resolved = path.resolve(workspace, relPath);
  const rel = path.relative(workspace, resolved);
  if (rel !== "" && (rel.startsWith("..") || path.isAbsolute(rel))) return undefined;
  return resolved;
}

/** Default read cap for `readWorkspaceFile` (import heads and declarations live well inside it). */
export const MAX_WORKSPACE_FILE_BYTES = 1024 * 1024;

/**
 * UTF-8 text of a regular workspace file no larger than `maxBytes`;
 * undefined for anything else (missing, a directory, a FIFO or device, a
 * larger file, a path escaping the workspace lexically or through a
 * symlink). Never blocks on a special file: the type is checked first.
 */
export function readWorkspaceFile(workspace: string, relPath: string, maxBytes: number = MAX_WORKSPACE_FILE_BYTES): string | undefined {
  const abs = withinWorkspace(workspace, relPath);
  if (abs === undefined) return undefined;
  try {
    const st = fs.statSync(abs, { throwIfNoEntry: false });
    if (st === undefined || !st.isFile() || st.size > maxBytes) return undefined;
    if (!realPathInside(workspace, relPath)) return undefined;
    return fs.readFileSync(abs, "utf8");
  } catch {
    return undefined;
  }
}

const REAL_PATH_TTL_MS = 10_000;
const REAL_PATH_CACHE_LIMIT = 4096;
const realWorkspaceRoots = new Map<string, string>();
const realPathVerdicts = new Map<string, { inside: boolean; at: number }>();

function realWorkspaceRoot(workspace: string): string | undefined {
  const known = realWorkspaceRoots.get(workspace);
  if (known !== undefined) return known;
  try {
    const real = fs.realpathSync.native(workspace);
    if (realWorkspaceRoots.size >= 64) realWorkspaceRoots.clear();
    realWorkspaceRoots.set(workspace, real);
    return real;
  } catch {
    return undefined;
  }
}

/**
 * True when workspace-relative `relPath` exists and its REAL path (every
 * symlink resolved) still lies inside the workspace's real path. The lexical
 * `withinWorkspace` check cannot see a symlink inside the workspace that
 * points out of it; every edge the resolvers emit passes this check too
 * (importResolution.ts). Verdicts are cached for a few seconds.
 */
export function realPathInside(workspace: string, relPath: string): boolean {
  if (relPath === "") return realWorkspaceRoot(workspace) !== undefined; // the workspace root itself
  const abs = withinWorkspace(workspace, relPath);
  if (abs === undefined) return false;
  const key = `${workspace}\n${abs}`;
  const now = Date.now();
  const known = realPathVerdicts.get(key);
  if (known !== undefined && now - known.at < REAL_PATH_TTL_MS) return known.inside;
  let inside = false;
  const root = realWorkspaceRoot(workspace);
  if (root !== undefined) {
    try {
      const real = fs.realpathSync.native(abs);
      inside = real === root || real.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);
    } catch {
      inside = false;
    }
  }
  if (realPathVerdicts.size >= REAL_PATH_CACHE_LIMIT) realPathVerdicts.clear();
  realPathVerdicts.set(key, { inside, at: now });
  return inside;
}

/** A regular file inside the workspace, lexically and by real path (a symlink pointing out does not count). */
export function fileExists(workspace: string, relPath: string): boolean {
  const abs = withinWorkspace(workspace, relPath);
  if (abs === undefined) return false;
  try {
    const st = fs.statSync(abs, { throwIfNoEntry: false });
    return st !== undefined && st.isFile() && realPathInside(workspace, relPath);
  } catch {
    return false;
  }
}

/** A directory inside the workspace, lexically and by real path ("" = the workspace root). */
export function directoryExists(workspace: string, relDir: string): boolean {
  if (relDir === "") return true;
  const abs = withinWorkspace(workspace, relDir);
  if (abs === undefined) return false;
  try {
    const st = fs.statSync(abs, { throwIfNoEntry: false });
    return st !== undefined && st.isDirectory() && realPathInside(workspace, relDir);
  } catch {
    return false;
  }
}

/**
 * Entry names directly inside workspace-relative directory `relDir` ("" = the
 * workspace root), sorted; [] when unreadable or when the directory's real
 * path leaves the workspace (a symlinked directory pointing out is never
 * listed).
 */
export function listDirectory(workspace: string, relDir: string): string[] {
  const abs = relDir === "" ? workspace : withinWorkspace(workspace, relDir);
  if (abs === undefined) return [];
  if (relDir !== "" && !realPathInside(workspace, relDir)) return [];
  try {
    return fs.readdirSync(abs).sort();
  } catch {
    return [];
  }
}

/** POSIX dirname of a workspace-relative path, "" for a top-level file. */
export function posixDirname(relPath: string): string {
  const dir = path.posix.dirname(relPath.replace(/\\/g, "/"));
  return dir === "." ? "" : dir;
}

/** Join workspace-relative POSIX segments, normalizing; "" stays the workspace root. */
export function posixJoin(...parts: string[]): string {
  const joined = path.posix.normalize(path.posix.join(...parts.filter((p) => p.length > 0)));
  return joined === "." ? "" : joined;
}

const IDENT_RE = /^[A-Za-z_$][\w$]*$/;

/** Identifier-shaped names, first occurrence order, deduplicated. */
export function uniqueNames(names: Iterable<string>): string[] {
  const out: string[] = [];
  for (const name of names) if (IDENT_RE.test(name) && !out.includes(name)) out.push(name);
  return out;
}

export function isLineComment(line: string, hash: boolean): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*") || (hash && trimmed.startsWith("#"));
}

// ---------------------------------------------------------------------------
// Project roots
// ---------------------------------------------------------------------------

/** Ancestors `projectRootsOf` climbs at most (far deeper than any real source tree). */
const MAX_PROJECT_ROOT_DEPTH = 64;

/** File names whose presence marks a directory as a project/build root. */
const PROJECT_MANIFESTS = new Set([
  "package.json", "tsconfig.json", "jsconfig.json", "deno.json",
  "pyproject.toml", "setup.py", "setup.cfg", "Pipfile",
  "go.mod", "go.work",
  "pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts",
  "Cargo.toml",
  "CMakeLists.txt", "meson.build", "compile_commands.json", "Makefile", "GNUmakefile", "makefile", "configure.ac",
  // Bazel workspace roots only: a `BUILD` file sits in every Bazel package
  // directory, so treating it as a project root would split one build into
  // hundreds of "projects".
  "WORKSPACE", "WORKSPACE.bazel", "MODULE.bazel",
]);

/**
 * Workspace-relative directories between `filePath` and the workspace root
 * that hold a project/build manifest, NEAREST FIRST ("" = the workspace root
 * itself, only when the root holds a manifest).
 */
export function projectRootsOf(workspace: string, filePath: string): string[] {
  const raw = filePath.replace(/\\/g, "/");
  const rel = raw.length === 0 ? "" : path.posix.normalize(raw);
  // Only a workspace-relative path has ancestors inside the workspace: an
  // absolute, drive-lettered or escaping path would otherwise climb to "/"
  // (whose dirname is itself) and never reach "".
  if (rel.length === 0 || rel === "." || path.posix.isAbsolute(rel) || /^[A-Za-z]:/.test(rel) || rel === ".." || rel.startsWith("../")) return [];
  const out: string[] = [];
  let dir = posixDirname(rel);
  for (let depth = 0; depth < MAX_PROJECT_ROOT_DEPTH; depth++) {
    if (listDirectory(workspace, dir).some((name) => PROJECT_MANIFESTS.has(name))) out.push(dir);
    if (dir === "") break;
    const parent = posixDirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Glob matching (workspace membership globs, tsconfig include/exclude)
// ---------------------------------------------------------------------------

const MAX_GLOB_PATTERN_CHARS = 512;
const MAX_GLOB_SEGMENTS = 64;
const MAX_GLOB_SEGMENT_CHARS = 255;

/**
 * One path segment against one glob segment (`*` = any run, `?` = one
 * character, everything else literal), in O(p·s) time with no regular
 * expression — the classic two-pointer wildcard match with a single
 * backtrack point, so no input can make it explode.
 */
function segmentMatches(pattern: string, segment: string): boolean {
  let p = 0;
  let s = 0;
  let starP = -1;
  let starS = 0;
  while (s < segment.length) {
    const pc = pattern[p];
    if (pc === "?" || (pc !== undefined && pc !== "*" && pc === segment[s])) {
      p++;
      s++;
    } else if (pc === "*") {
      starP = p++;
      starS = s;
    } else if (starP >= 0) {
      p = starP + 1;
      s = ++starS;
    } else {
      return false;
    }
  }
  while (pattern[p] === "*") p++;
  return p === pattern.length;
}

/**
 * True when workspace-relative POSIX `relPath` matches `pattern`, a
 * forward-slash glob with `*`/`?` inside a segment and `**` for zero or more
 * whole segments (the subset npm/pnpm/yarn workspace globs and tsconfig
 * `include`/`exclude` share; braces and character classes are taken
 * literally, which can only under-match). A leading `./` and trailing `/`
 * are ignored. Linear-time by construction: segment matching is a two-pointer
 * wildcard match and `**` is a bounded dynamic program over segments, so a
 * crafted pattern cannot stall the caller. Patterns or paths past the bounds
 * (512 characters, 64 segments, 255 characters per segment) never match.
 */
export function globMatchesPath(pattern: string, relPath: string): boolean {
  if (pattern.length === 0 || pattern.length > MAX_GLOB_PATTERN_CHARS) return false;
  const clean = (text: string): string[] =>
    text.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "").split("/").filter((seg) => seg.length > 0 && seg !== ".");
  const pat = clean(pattern);
  const parts = clean(relPath);
  if (pat.length === 0 || pat.length > MAX_GLOB_SEGMENTS || parts.length > MAX_GLOB_SEGMENTS) return false;
  if (pat.some((seg) => seg.length > MAX_GLOB_SEGMENT_CHARS) || parts.some((seg) => seg.length > MAX_GLOB_SEGMENT_CHARS)) return false;
  // reach[j] = the first i pattern segments can match the first j path segments.
  let reach: boolean[] = new Array(parts.length + 1).fill(false);
  reach[0] = true;
  for (const seg of pat) {
    const next: boolean[] = new Array(parts.length + 1).fill(false);
    if (seg === "**") {
      let any = false;
      for (let j = 0; j <= parts.length; j++) {
        any = any || reach[j]!;
        next[j] = any;
      }
    } else {
      for (let j = 1; j <= parts.length; j++) {
        if (reach[j - 1] && segmentMatches(seg, parts[j - 1]!)) next[j] = true;
      }
    }
    reach = next;
  }
  return reach[parts.length] === true;
}
