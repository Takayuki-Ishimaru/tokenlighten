/**
 * cIncludes.ts — C/C++ `#include` edge resolution and header/source
 * counterparts for importResolution.ts's dispatcher (consumed by the
 * default-OFF V15-NBR neighbour index and V15-FUI usage inventory).
 *
 * CONTRACT: `resolveCIncludesOf(workspace, filePath, lines, maxEdges)`
 * returns edges from `filePath` to EXISTING workspace files, `#include`
 * edges in statement order (`kind:"include"`, `line` = the directive's
 * 1-based line, `names:[]`), then counterparts (`kind:"counterpart"`,
 * `line:0`), deduplicated, at most `maxEdges`, never outside the workspace
 * and never `filePath` itself.
 *
 * DIRECTIVES. `#include`/`#import`/`#include_next` with a literal `"x"` or
 * `<x>` operand, read from the source with comments, string literals (raw
 * strings included) and `#if 0` regions removed; other conditionals are not
 * evaluated. A computed include (`#include MACRO`) names nothing.
 *
 * RESOLUTION. `"x"` resolves against the including file's directory first,
 * then the include roots; `<x>` against the include roots only. A header
 * that is not in the workspace (system, third-party) yields no edge.
 *
 * INCLUDE ROOTS, nearest project first. Walking up from the file to the
 * workspace root, every ancestor that holds a build manifest (CMakeLists.txt,
 * Makefile/GNUmakefile/Makefile.am, meson.build, compile_commands.json also
 * under build/, out/ and cmake-build-*, configure.ac, BUILD/BUILD.bazel,
 * WORKSPACE/MODULE.bazel) is a project root. For each, the directories the
 * build declares come first — `-I`/`-isystem`/`-iquote` of the
 * compile_commands.json entry for this file (the union of all entries when it
 * has none), `include_directories`/`target_include_directories` of the
 * CMakeLists, `-I` of the Makefile, `include_directories` of meson.build,
 * `includes` of a Bazel BUILD, the root of a Bazel workspace itself — then,
 * for the NEAREST project root only, the conventional directories that exist
 * (`include`, `inc`, `src`, the root itself). What an outer project declares
 * reaches its subdirectories (CMake directory properties are inherited), but
 * its guessed `src/` is no include root of a nested library. Variables are
 * expanded only when they resolve unambiguously; an entry that still holds a
 * variable or generator expression is ignored. An absolute path from a build
 * file counts only when it lies inside the workspace. For an include path
 * with a directory component that no root resolves, the conventional
 * directories of the ancestors below the nearest project root, then the
 * include directories declared anywhere in the same CMake project tree, then
 * `<sibling>/[include|inc]/<path>` of the nearest ancestor (each only when
 * exactly one file matches), are tried.
 *
 * COUNTERPARTS pair a header (.h .hh .hpp .hxx .h++ .cuh .inl .ipp .tpp)
 * with a source (.c .cc .cpp .cxx .c++ .cu .m .mm) of the same stem: the same
 * directory; then the mirrored include/src trees (`include/<sub>/x.h` ↔
 * `src/<sub>/x.cpp`, `inc/` ↔ `src/`, `include/<dirname>/x.h` ↔ `src/x.cpp`);
 * then a UNIQUE same-stem file of the same module under the NEAREST project
 * root (at most 2,000 directory entries examined; an ambiguous or unfinished
 * search yields nothing). A module is the nearest directory that owns an
 * include/inc/src/source split, so sibling libraries under an umbrella build
 * file never pair with each other, and the search never enters a
 * subdirectory that starts a project of its own (a CMake or Meson
 * `project()`, an autotools `configure.ac`, a Bazel workspace, a compile
 * database): a vendored dependency is a different project.
 *
 * BOUNDS. At most 32 include roots; manifests read at most 1 MiB and
 * compile_commands.json at most 8 MiB (bigger → skipped); every parse is
 * cached per absolute path and revalidated by mtime+size, every directory
 * listing by mtime/ctime; the directives come from at most 20,000 lines /
 * 1 MiB of the file; at most 4,000 existence probes per file (300 sibling
 * listings); nothing under `node_modules`; a resolved file must keep its
 * realpath inside the workspace's realpath, and so must every manifest read,
 * compile database parsed and directory listed (a symbolic link pointing out
 * of the workspace is never opened or listed, not merely its edge dropped).
 * Any unforeseen failure yields no edges, never an exception.
 */
import * as fs from "fs";
import * as path from "path";
import { analyzeCFamilySource } from "./declarationScan.js";
import { type ResolvedImport, posixDirname, posixJoin, realPathInside, withinWorkspace } from "./importGraphShared.js";

/** Extensions of the C family (C, C++, CUDA, Objective-C/C++ headers and sources). */
export const C_FAMILY_EXTENSIONS = [
  ".c", ".h", ".cc", ".cpp", ".cxx", ".c++", ".hh", ".hpp", ".hxx", ".h++", ".ipp", ".inl", ".tpp", ".cu", ".cuh", ".m", ".mm",
];

const HEADER_EXTENSIONS = [".h", ".hh", ".hpp", ".hxx", ".h++", ".cuh", ".inl", ".ipp", ".tpp"];
const SOURCE_EXTENSIONS = [".c", ".cc", ".cpp", ".cxx", ".c++", ".cu", ".m", ".mm"];
/** Headers an implementation-include file (`.inl`/`.ipp`/`.tpp`) belongs to. */
const PRIMARY_HEADER_EXTENSIONS = [".h", ".hh", ".hpp", ".hxx", ".h++", ".cuh"];
const IMPLEMENTATION_INCLUDES = new Set([".inl", ".ipp", ".tpp"]);

const MAX_SCANNED_LINES = 20000;
const MAX_SCANNED_CHARS = 1024 * 1024;
const MAX_LINE_CHARS = 4096;
const MAX_DIRECTIVES = 400;
const MAX_ROOTS = 32;
const MAX_ANCESTORS = 24;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_COMPILE_COMMANDS_BYTES = 8 * 1024 * 1024;
const MAX_COMPILE_ENTRIES = 30000;
const MAX_UNION_DIRS = 512;
const MAX_STEM_SCAN_ENTRIES = 2000;
const MAX_TREE_CMAKE_FILES = 64;
const MAX_TREE_DIRS = 256;
const MAX_SIBLING_DIRS = 64;
/** Existence probes the sibling-library stage may spend per file (most unresolved includes are system or third-party headers). */
const MAX_SIBLING_PROBES = 300;
const PARSE_CACHE_LIMIT = 96;

const C_MANIFESTS = new Set([
  "CMakeLists.txt", "Makefile", "GNUmakefile", "makefile", "Makefile.am", "meson.build", "compile_commands.json", "configure.ac",
  "configure.in", "BUILD", "BUILD.bazel", "WORKSPACE", "WORKSPACE.bazel", "MODULE.bazel",
]);
const CONVENTIONAL_DIRS = ["include", "inc", "src", ""];
/** A Bazel workspace resolves quoted includes against its root (`-iquote .`), whatever package a source file lives in. */
const BAZEL_WORKSPACE_MARKERS = new Set(["WORKSPACE", "WORKSPACE.bazel", "MODULE.bazel"]);
const HEADER_TREE_NAMES = ["include", "inc"];
const SOURCE_TREE_NAMES = ["src", "source"];
const SKIPPED_TREE_DIRS = new Set(["node_modules", "build", "out", "dist", "target", "CMakeFiles"]);

// ---------------------------------------------------------------------------
// Workspace-safe file access
// ---------------------------------------------------------------------------

function statOf(abs: string): fs.Stats | undefined {
  try {
    return fs.statSync(abs, { throwIfNoEntry: false });
  } catch {
    return undefined;
  }
}

/**
 * True when the existing workspace-relative path `rel` ("" = the workspace itself) resolves, every symbolic link followed,
 * to somewhere inside the workspace. Every read, listing and parse below checks this first, so a symlink that points out of
 * the workspace is never opened, listed or parsed (the shared helper caches its verdicts for a few seconds; a path that
 * does not exist is never asked, so no negative verdict is cached for it).
 */
function insideWorkspace(workspace: string, rel: string): boolean {
  return rel === "" || realPathInside(workspace, rel);
}

/** An existing regular file whose real path stays inside the workspace's real path. */
function fileAt(workspace: string, rel: string): boolean {
  const abs = withinWorkspace(workspace, rel);
  return abs !== undefined && (statOf(abs)?.isFile() ?? false) && insideWorkspace(workspace, rel);
}

/** An existing directory whose real path stays inside the workspace's real path. */
function dirAt(workspace: string, rel: string): boolean {
  if (rel === "") return true;
  const abs = withinWorkspace(workspace, rel);
  return abs !== undefined && (statOf(abs)?.isDirectory() ?? false) && insideWorkspace(workspace, rel);
}

const realWorkspaces = new Map<string, string>();

function realWorkspaceOf(workspace: string): string {
  const hit = realWorkspaces.get(workspace);
  if (hit !== undefined) return hit;
  let real = workspace;
  try {
    real = fs.realpathSync(workspace);
  } catch {
    /* keep the given path */
  }
  if (realWorkspaces.size >= PARSE_CACHE_LIMIT) realWorkspaces.clear();
  realWorkspaces.set(workspace, real);
  return real;
}

/** Workspace-relative POSIX path of `abs` when it lies inside the workspace (or its realpath); undefined otherwise. */
function toWorkspaceRel(workspace: string, abs: string): string | undefined {
  const normalized = path.resolve(abs);
  for (const base of [workspace, realWorkspaceOf(workspace)]) {
    const rel = path.relative(base, normalized);
    if (rel === "") return "";
    if (!rel.startsWith("..") && !path.isAbsolute(rel)) return rel.split(path.sep).join("/");
  }
  return undefined;
}

/** An existing regular file whose realpath stays inside the workspace's realpath (what an edge may point at). */
function acceptedFile(workspace: string, rel: string): boolean {
  return fileAt(workspace, rel);
}

const parseCache = new Map<string, { key: string; value: unknown }>();

/** Parse of the file at `abs` (already stat-ed as `st`), cached per absolute path and revalidated by mtime+size. */
function cachedParse<T>(abs: string, st: fs.Stats, parse: (text: string) => T): T | undefined {
  const key = `${st.mtimeMs}:${st.size}`;
  const hit = parseCache.get(abs);
  if (hit !== undefined && hit.key === key) return hit.value as T;
  let value: T;
  try {
    value = parse(fs.readFileSync(abs, "utf8"));
  } catch {
    return undefined;
  }
  if (parseCache.size >= PARSE_CACHE_LIMIT) {
    const oldest = parseCache.keys().next().value;
    if (oldest !== undefined) parseCache.delete(oldest);
  }
  parseCache.set(abs, { key, value });
  return value;
}

/** Parse of the workspace file `rel` (at most `maxBytes`); a file whose real path leaves the workspace is never opened. */
function parseAt<T>(workspace: string, rel: string, maxBytes: number, parse: (text: string) => T): T | undefined {
  const abs = withinWorkspace(workspace, rel);
  if (abs === undefined) return undefined;
  const st = statOf(abs);
  if (st === undefined || !st.isFile() || st.size > maxBytes) return undefined;
  if (!insideWorkspace(workspace, rel)) return undefined;
  return cachedParse(abs, st, parse);
}

function unique(items: readonly string[]): string[] {
  return [...new Set(items)];
}

/**
 * Variable expansion marks a value that is already a workspace-relative
 * directory (`${CMAKE_CURRENT_SOURCE_DIR}`, `$(srcdir)`) with this prefix; a
 * value without it is relative to the directory of the build file.
 */
const WORKSPACE_MARK = "@@WS@@";

/** Workspace-relative directory named by an expanded build-file entry; undefined when it lies outside the workspace or is malformed. */
function finishBuildDir(workspace: string, buildDir: string, expanded: string): string | undefined {
  const anchored = expanded.startsWith(WORKSPACE_MARK);
  const text = path.posix.normalize((anchored ? expanded.slice(WORKSPACE_MARK.length) : expanded).replace(/\\/g, "/"));
  if (text.includes(WORKSPACE_MARK)) return undefined;
  if (anchored) return text === "." ? "" : text;
  if (/^(?:\/|[A-Za-z]:\/)/.test(text)) return toWorkspaceRel(workspace, text);
  return posixJoin(buildDir, text === "." ? "" : text);
}

interface DirListing {
  names: ReadonlySet<string>;
  /** Sorted; symbolic links are reported as non-directories so a search never follows them. */
  entries: ReadonlyArray<{ name: string; dir: boolean }>;
}

const MAX_LISTING_ENTRIES = 20000;
const DIR_CACHE_LIMIT = 512;
const dirCache = new Map<string, { key: string; listing: DirListing }>();

/**
 * Listing of workspace-relative `relDir` ("" = the workspace), cached per absolute path and revalidated by the directory's
 * mtime/ctime; "missing" when it is not a directory, "unknown" when it cannot be listed or is too large to cache.
 */
function loadDir(workspace: string, relDir: string): DirListing | "missing" | "unknown" {
  const abs = relDir === "" ? workspace : withinWorkspace(workspace, relDir);
  if (abs === undefined) return "missing";
  const st = statOf(abs);
  if (st === undefined || !st.isDirectory()) return "missing";
  // A directory that leads out of the workspace through a symbolic link is never listed.
  if (!insideWorkspace(workspace, relDir)) return "missing";
  const key = `${st.mtimeMs}:${st.ctimeMs}`;
  const hit = dirCache.get(abs);
  if (hit !== undefined && hit.key === key) return hit.listing;
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return "unknown";
  }
  if (dirents.length > MAX_LISTING_ENTRIES) return "unknown";
  const entries = dirents.map((e) => ({ name: e.name, dir: e.isDirectory() })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const listing: DirListing = { names: new Set(entries.map((e) => e.name)), entries };
  if (dirCache.size >= DIR_CACHE_LIMIT) {
    const oldest = dirCache.keys().next().value;
    if (oldest !== undefined) dirCache.delete(oldest);
  }
  dirCache.set(abs, { key, listing });
  return listing;
}

function readDir(workspace: string, relDir: string): DirListing | undefined {
  const loaded = loadDir(workspace, relDir);
  return typeof loaded === "string" ? undefined : loaded;
}

// ---------------------------------------------------------------------------
// compile_commands.json
// ---------------------------------------------------------------------------

interface CompileDb {
  /** Absolute source file → absolute include directories of its entry. */
  byFile: Map<string, string[]>;
  /** Every include directory of every entry (bounded). */
  union: string[];
}

/** POSIX-shell word splitting (quotes and backslash escapes) of a compile `command`. */
function shellSplit(command: string): string[] {
  const out: string[] = [];
  let cur = "";
  let has = false;
  let quote: string | undefined;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote !== undefined) {
      if (c === quote) quote = undefined;
      else if (c === "\\" && quote === "\"" && i + 1 < command.length) cur += command[++i];
      else cur += c;
    } else if (c === "'" || c === "\"") {
      quote = c;
      has = true;
    } else if (c === "\\" && i + 1 < command.length) {
      cur += command[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (has) { out.push(cur); cur = ""; has = false; }
    } else {
      cur += c;
      has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}

const INCLUDE_FLAGS = ["-isystem", "-iquote", "-idirafter", "-I", "/I", "-external:I", "-imsvc"];

/** Include directories named by compiler `args`, resolved against `directory`. */
function includeDirsOfArgs(args: readonly string[], directory: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    for (const flag of INCLUDE_FLAGS) {
      if (!arg.startsWith(flag)) continue;
      const attached = arg.slice(flag.length);
      const value = attached.length > 0 ? attached : args[i + 1];
      if (attached.length === 0) i++;
      if (value !== undefined && value.length > 0) out.push(path.resolve(directory, value));
      break;
    }
  }
  return out;
}

function parseCompileCommands(text: string): CompileDb {
  const db: CompileDb = { byFile: new Map(), union: [] };
  const json: unknown = JSON.parse(text);
  if (!Array.isArray(json)) return db;
  const union = new Set<string>();
  for (const entry of json.slice(0, MAX_COMPILE_ENTRIES)) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const directory = typeof e["directory"] === "string" ? e["directory"] : "";
    const file = typeof e["file"] === "string" ? e["file"] : "";
    const args = Array.isArray(e["arguments"])
      ? e["arguments"].filter((a): a is string => typeof a === "string")
      : typeof e["command"] === "string"
        ? shellSplit(e["command"])
        : [];
    const dirs = unique(includeDirsOfArgs(args, directory));
    if (file.length > 0) db.byFile.set(path.resolve(directory, file), dirs);
    for (const d of dirs) if (union.size < MAX_UNION_DIRS) union.add(d);
  }
  db.union = [...union];
  return db;
}

/** compile_commands.json files that exist for project root `root`: at the root, in build/, out/ and cmake-build-*. */
function compileDbFiles(workspace: string, root: string, entries: readonly string[]): string[] {
  const out: string[] = [];
  const candidates: string[] = [];
  if (entries.includes("compile_commands.json")) candidates.push(posixJoin(root, "compile_commands.json"));
  for (const name of entries) {
    if (name === "build" || name === "out" || name.startsWith("cmake-build-")) candidates.push(posixJoin(root, name, "compile_commands.json"));
  }
  for (const rel of candidates.slice(0, 8)) if (fileAt(workspace, rel)) out.push(rel);
  return out;
}

/** Number of leading path segments two workspace-relative directories share. */
function sharedSegments(a: string, b: string): number {
  const x = a === "" ? [] : a.split("/");
  const y = b === "" ? [] : b.split("/");
  let n = 0;
  while (n < x.length && n < y.length && x[n] === y[n]) n++;
  return n;
}

function compileDbDirs(workspace: string, dbFiles: readonly string[], file: string): string[] {
  const out: string[] = [];
  for (const rel of dbFiles) {
    const db = parseAt(workspace, rel, MAX_COMPILE_COMMANDS_BYTES, parseCompileCommands);
    if (db === undefined) continue;
    let dirs: string[] | undefined;
    for (const base of [workspace, realWorkspaceOf(workspace)]) {
      dirs = db.byFile.get(path.join(base, file));
      if (dirs !== undefined) break;
    }
    const rels: string[] = [];
    for (const abs of dirs ?? db.union) {
      const relDir = toWorkspaceRel(workspace, abs);
      if (relDir !== undefined) rels.push(relDir);
    }
    // The union of every entry can be long: directories nearest to the file come first, so they survive the root cap.
    if (dirs === undefined) {
      const here = posixDirname(file);
      rels.sort((p, q) => sharedSegments(q, here) - sharedSegments(p, here));
    }
    out.push(...rels);
  }
  return out;
}

// ---------------------------------------------------------------------------
// CMake
// ---------------------------------------------------------------------------

interface CMakeInfo {
  hasProject: boolean;
  vars: Map<string, string | null>;
  /** Raw entries of every include_directories / target_include_directories call. */
  entries: string[];
  /** `add_subdirectory` names. */
  subdirs: string[];
}

const CMAKE_DIR_KEYWORDS = new Set(["AFTER", "BEFORE", "SYSTEM", "INTERFACE", "PUBLIC", "PRIVATE"]);

function stripCMakeComments(text: string): string {
  const noBracket = text.replace(/#\[(=*)\[[\s\S]*?\]\1\]/g, " ");
  return noBracket
    .split(/\r?\n/)
    .map((line) => {
      let quoted = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i]!;
        if (c === "\\") i++;
        else if (c === "\"") quoted = !quoted;
        else if (c === "#" && !quoted) return line.slice(0, i);
      }
      return line;
    })
    .join("\n");
}

/** Index of the `)` closing a call whose arguments start at `from`; -1 when unterminated. */
function closingParen(src: string, from: number): number {
  let depth = 1;
  const limit = Math.min(src.length, from + 65536);
  for (let i = from; i < limit; i++) {
    const c = src[i]!;
    if (c === "\"") {
      for (i++; i < limit && src[i] !== "\""; i++) if (src[i] === "\\") i++;
    } else if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitCMakeArgs(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let has = false;
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "\\" && i + 1 < s.length) { cur += s[++i]; has = true; }
    else if (c === "\"") { quoted = !quoted; has = true; }
    else if (!quoted && /\s/.test(c)) {
      if (has) { out.push(cur); cur = ""; has = false; }
    } else { cur += c; has = true; }
  }
  if (has) out.push(cur);
  return out;
}

function parseCMake(text: string): CMakeInfo {
  const info: CMakeInfo = { hasProject: false, vars: new Map(), entries: [], subdirs: [] };
  const src = stripCMakeComments(text);
  const call = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  let m: RegExpExecArray | null;
  let calls = 0;
  while ((m = call.exec(src)) !== null && calls < 5000) {
    calls++;
    const name = m[1]!.toLowerCase();
    if (name !== "project" && name !== "set" && name !== "include_directories" && name !== "target_include_directories" && name !== "add_subdirectory") continue;
    const from = m.index + m[0].length;
    const close = closingParen(src, from);
    if (close < 0) break;
    const args = splitCMakeArgs(src.slice(from, close));
    call.lastIndex = close + 1;
    if (name === "project") info.hasProject = true;
    else if (name === "add_subdirectory") { if (args[0] !== undefined) info.subdirs.push(args[0]); }
    else if (name === "set") {
      const key = args[0];
      if (key === undefined) continue;
      const settled = args.length === 2 && !args.includes("CACHE") && !args.includes("PARENT_SCOPE");
      const value = settled ? args[1]! : null;
      const previous = info.vars.get(key);
      info.vars.set(key, previous === undefined || previous === value ? value : null);
    } else {
      const dirs = name === "target_include_directories" ? args.slice(1) : args;
      for (const d of dirs) if (!CMAKE_DIR_KEYWORDS.has(d)) info.entries.push(d);
    }
  }
  return info;
}

function cmakeAt(workspace: string, dir: string): CMakeInfo | undefined {
  return parseAt(workspace, posixJoin(dir, "CMakeLists.txt"), MAX_MANIFEST_BYTES, parseCMake);
}

/** Nearest ancestor-or-self of `dir` whose CMakeLists.txt calls `project(`. */
function cmakeProjectDir(workspace: string, dir: string): string | undefined {
  for (let d = dir, n = 0; n < MAX_ANCESTORS; n++) {
    if (cmakeAt(workspace, d)?.hasProject === true) return d;
    if (d === "") break;
    d = posixDirname(d);
  }
  return undefined;
}

/** Top of the contiguous chain of CMakeLists.txt directories that contains `dir` (CMAKE_SOURCE_DIR). */
function cmakeTopDir(workspace: string, dir: string): string {
  let top = dir;
  while (top !== "" && cmakeAt(workspace, posixDirname(top)) !== undefined) top = posixDirname(top);
  return top;
}

/** Expand one CMake include entry; `undefined` when a variable or generator expression stays unresolved. */
function expandCMakeEntry(workspace: string, entry: string, dir: string, info: CMakeInfo, depth = 0): string | undefined {
  let e = entry;
  for (let i = 0; i < 4 && /\$<BUILD_INTERFACE:/.test(e); i++) e = e.replace(/\$<BUILD_INTERFACE:([^<>]*)>/g, "$1");
  if (e.includes("$<")) return undefined;
  let bad = false;
  const replaced = e.replace(/\$\{([A-Za-z0-9_.+-]+)\}/g, (_whole: string, name: string, offset: number) => {
    if (offset !== 0 || depth > 3) { bad = true; return ""; }
    const here = dir === "" ? "." : dir;
    if (name === "CMAKE_CURRENT_SOURCE_DIR" || name === "CMAKE_CURRENT_LIST_DIR") return WORKSPACE_MARK + here;
    if (name === "PROJECT_SOURCE_DIR") {
      const project = cmakeProjectDir(workspace, dir);
      if (project === undefined) { bad = true; return ""; }
      return WORKSPACE_MARK + (project === "" ? "." : project);
    }
    if (name === "CMAKE_SOURCE_DIR") {
      const top = cmakeTopDir(workspace, dir);
      return WORKSPACE_MARK + (top === "" ? "." : top);
    }
    const value = info.vars.get(name);
    if (value === undefined || value === null) { bad = true; return ""; }
    const inner = expandCMakeEntry(workspace, value, dir, info, depth + 1);
    if (inner === undefined) { bad = true; return ""; }
    return inner;
  });
  return bad || replaced.includes("${") || replaced.includes(";") ? undefined : replaced;
}

/** Workspace-relative include directories declared by the CMakeLists.txt in `dir`. */
function cmakeDirs(workspace: string, dir: string): string[] {
  const info = cmakeAt(workspace, dir);
  if (info === undefined) return [];
  const out: string[] = [];
  for (const raw of info.entries.slice(0, 256)) {
    const expanded = expandCMakeEntry(workspace, raw, dir, info);
    if (expanded === undefined || expanded === "") continue;
    const rel = finishBuildDir(workspace, dir, expanded);
    if (rel !== undefined) out.push(rel);
  }
  return out;
}

/** Include directories declared anywhere in the CMake project tree rooted at `top` (bounded breadth-first walk over add_subdirectory). */
function cmakeTreeDirs(workspace: string, top: string): string[] {
  const dirs: string[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: top, depth: 0 }];
  const seen = new Set<string>();
  while (queue.length > 0 && seen.size < MAX_TREE_CMAKE_FILES && dirs.length < MAX_TREE_DIRS) {
    const { dir, depth } = queue.shift()!;
    if (seen.has(dir)) continue;
    seen.add(dir);
    const info = cmakeAt(workspace, dir);
    if (info === undefined) continue;
    for (const d of cmakeDirs(workspace, dir)) if (!dirs.includes(d) && dirs.length < MAX_TREE_DIRS) dirs.push(d);
    if (depth >= 6) continue;
    for (const name of info.subdirs.slice(0, 64)) {
      if (name.includes("${") || name.includes("$<")) continue;
      const sub = posixJoin(dir, name);
      if (sub !== "" && fileAt(workspace, posixJoin(sub, "CMakeLists.txt"))) queue.push({ dir: sub, depth: depth + 1 });
    }
  }
  return dirs;
}

// ---------------------------------------------------------------------------
// Makefile / Makefile.am
// ---------------------------------------------------------------------------

interface MakeInfo {
  vars: Map<string, string | null>;
  /** Directory operands of `-I`/`-isystem`/`-iquote` exactly as written. */
  dirs: string[];
}

function parseMakefile(text: string): MakeInfo {
  const info: MakeInfo = { vars: new Map(), dirs: [] };
  const lines = text.replace(/\\\r?\n/g, " ").split(/\r?\n/);
  const flag = /(?:^|\s)(?:-I|-isystem|-iquote)\s*("[^"]*"|'[^']*'|[^\s"']+)/g;
  for (const raw of lines.slice(0, 20000)) {
    const line = raw.replace(/(^|[^\\])#.*$/, "$1");
    const assign = /^\s*(?:export\s+|override\s+)?([A-Za-z_][\w.]*)\s*(\+=|[:?]{0,2}=)\s*(.*)$/.exec(line);
    if (assign) {
      const name = assign[1]!;
      const value = assign[3]!.trim();
      const previous = info.vars.get(name);
      if (assign[2] === "+=") info.vars.set(name, previous === undefined ? value : previous === null ? null : `${previous} ${value}`);
      else info.vars.set(name, previous === undefined || previous === value ? value : null);
    }
    flag.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = flag.exec(line)) !== null && info.dirs.length < 256) info.dirs.push(m[1]!.replace(/^["']|["']$/g, ""));
  }
  return info;
}

function expandMake(text: string, vars: ReadonlyMap<string, string | null>, builtin: (name: string) => string | undefined, depth = 0): string | undefined {
  let bad = false;
  const out = text.replace(/\$[({]([A-Za-z_][\w.]*)[)}]|@([A-Za-z_]\w*)@/g, (_whole: string, n1: string | undefined, n2: string | undefined, offset: number) => {
    const name = (n1 ?? n2)!;
    const own = builtin(name);
    if (own !== undefined) {
      if (offset !== 0) bad = true;
      return own;
    }
    const value = vars.get(name);
    if (value === undefined || value === null || depth >= 3) { bad = true; return ""; }
    const inner = expandMake(value, vars, builtin, depth + 1);
    if (inner === undefined || (offset !== 0 && inner.includes(WORKSPACE_MARK))) { bad = true; return ""; }
    return inner;
  });
  return bad || out.includes("$") ? undefined : out;
}

/** Workspace-relative include directories of the Makefile/Makefile.am named `name` in `dir`. */
function makefileDirs(workspace: string, dir: string, name: string): string[] {
  const info = parseAt(workspace, posixJoin(dir, name), MAX_MANIFEST_BYTES, parseMakefile);
  if (info === undefined) return [];
  const autotoolsTop = (): string | undefined => {
    for (let d = dir, n = 0; n < MAX_ANCESTORS; n++) {
      if (fileAt(workspace, posixJoin(d, "configure.ac")) || fileAt(workspace, posixJoin(d, "configure.in"))) return d;
      if (d === "") break;
      d = posixDirname(d);
    }
    return undefined;
  };
  const builtin = (variable: string): string | undefined => {
    if (variable === "CURDIR" || variable === "srcdir" || variable === "abs_srcdir") return WORKSPACE_MARK + (dir === "" ? "." : dir);
    if (variable === "top_srcdir" || variable === "abs_top_srcdir") {
      const top = autotoolsTop();
      return top === undefined ? undefined : WORKSPACE_MARK + (top === "" ? "." : top);
    }
    return undefined;
  };
  const out: string[] = [];
  for (const raw of info.dirs) {
    const expanded = expandMake(raw, info.vars, builtin);
    if (expanded === undefined || expanded.trim() === "" || /\s/.test(expanded.trim())) continue;
    const rel = finishBuildDir(workspace, dir, expanded.trim());
    if (rel !== undefined) out.push(rel);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Meson / Bazel
// ---------------------------------------------------------------------------

function quotedStrings(text: string): string[] {
  const out: string[] = [];
  const re = /'([^'\n]*)'|"([^"\n]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null && out.length < 64) out.push(m[1] ?? m[2] ?? "");
  return out;
}

function parseMeson(text: string): string[] {
  const out: string[] = [];
  const re = /\binclude_directories\s*\(([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null && out.length < 128) out.push(...quotedStrings(m[1]!));
  return out;
}

/** Whether a meson.build calls `project()` (the top file of a Meson project, as opposed to a `subdir()` file). */
function mesonStartsProject(text: string): boolean {
  return /^\s*project\s*\(/m.test(text);
}

function parseBazel(text: string): string[] {
  const out: string[] = [];
  const re = /\bincludes\s*=\s*\[([^\]]*)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null && out.length < 128) out.push(...quotedStrings(m[1]!));
  return out;
}

// ---------------------------------------------------------------------------
// Include roots
// ---------------------------------------------------------------------------

interface RootSet {
  /** Include directories, workspace-relative, in resolution order (project roots nearest first). */
  roots: string[];
  /** Ancestors of the file that are project roots, nearest first. */
  projectRoots: string[];
  /** Every ancestor directory of the file, nearest first (the file's directory first). */
  ancestors: string[];
}

function collectRoots(workspace: string, file: string): RootSet {
  const ancestors: string[] = [];
  for (let dir = posixDirname(file), n = 0; n < MAX_ANCESTORS; n++) {
    ancestors.push(dir);
    if (dir === "") break;
    dir = posixDirname(dir);
  }
  const roots: string[] = [];
  const seen = new Set<string>();
  const add = (dir: string): void => {
    if (roots.length < MAX_ROOTS && !seen.has(dir) && dirAt(workspace, dir)) {
      seen.add(dir);
      roots.push(dir);
    }
  };
  const projectRoots: string[] = [];
  for (const dir of ancestors) {
    const entries = readDir(workspace, dir)?.entries.map((e) => e.name) ?? [];
    const dbFiles = compileDbFiles(workspace, dir, entries);
    if (dbFiles.length === 0 && !entries.some((name) => C_MANIFESTS.has(name))) continue;
    projectRoots.push(dir);
    // What the build declares comes first (an outer project's declarations reach its subdirectories: CMake directory
    // properties are inherited); the conventional directories are a guess, made for the nearest project only.
    for (const d of compileDbDirs(workspace, dbFiles, file)) add(d);
    if (entries.includes("CMakeLists.txt")) for (const d of cmakeDirs(workspace, dir)) add(d);
    for (const name of ["Makefile", "GNUmakefile", "makefile", "Makefile.am"]) {
      if (entries.includes(name)) for (const d of makefileDirs(workspace, dir, name)) add(d);
    }
    if (entries.includes("meson.build")) {
      for (const e of parseAt(workspace, posixJoin(dir, "meson.build"), MAX_MANIFEST_BYTES, parseMeson) ?? []) add(posixJoin(dir, e));
    }
    for (const name of ["BUILD", "BUILD.bazel"]) {
      if (entries.includes(name)) for (const e of parseAt(workspace, posixJoin(dir, name), MAX_MANIFEST_BYTES, parseBazel) ?? []) add(posixJoin(dir, e));
    }
    if (entries.some((name) => BAZEL_WORKSPACE_MARKERS.has(name))) add(dir);
    // `src/` of an OUTER project is not visible to a nested one (a nested library's `#include "config.h"` must not land on
    // the umbrella application's `src/config.h`): only the nearest project root contributes its conventional directories.
    if (projectRoots.length === 1) for (const c of CONVENTIONAL_DIRS) add(c === "" ? dir : posixJoin(dir, c));
  }
  return { roots, projectRoots, ancestors };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** Existence probes one file's resolution may spend (a pathological file with hundreds of includes stays bounded). */
const MAX_PROBES = 4000;

interface ResolveContext {
  workspace: string;
  file: string;
  dir: string;
  rootSet: RootSet | undefined;
  treeDirs: string[] | undefined;
  probes: number;
  siblingProbes: number;
  /** Directory listings loaded during this resolution: `undefined` = unknown, `null` = not a directory. */
  listings: Map<string, ReadonlySet<string> | null | undefined>;
}

/** Whether directory `dir` holds an entry called `name`; `undefined` when the directory cannot be listed. */
function entryIn(ctx: ResolveContext, dir: string, name: string): boolean | undefined {
  let names = ctx.listings.get(dir);
  if (names === undefined && !ctx.listings.has(dir)) {
    const loaded = loadDir(ctx.workspace, dir);
    names = loaded === "missing" ? null : loaded === "unknown" ? undefined : loaded.names;
    ctx.listings.set(dir, names);
  }
  return names === null ? false : names?.has(name);
}

function rootsOf(ctx: ResolveContext): RootSet {
  ctx.rootSet ??= collectRoots(ctx.workspace, ctx.file);
  return ctx.rootSet;
}

/** Workspace-relative path of the file `target` names for an include of `file`, or undefined. */
function resolveInclude(ctx: ResolveContext, target: string, angled: boolean): string | undefined {
  const spelled = target.replace(/\\/g, "/");
  if (/^(?:\/|[A-Za-z]:\/)/.test(spelled)) {
    const rel = toWorkspaceRel(ctx.workspace, spelled);
    return rel !== undefined && rel !== "" && acceptedFile(ctx.workspace, rel) ? rel : undefined;
  }
  const first = spelled.split("/")[0]!;
  const prunable = first !== "" && first !== "." && first !== "..";
  const tryDir = (dir: string): string | undefined => {
    // A directory listing (cached across calls, loaded once per resolution) rules out most candidates without a system call.
    if (prunable && entryIn(ctx, dir, first) === false) return undefined;
    if (ctx.probes >= MAX_PROBES) return undefined;
    ctx.probes++;
    const rel = posixJoin(dir, spelled);
    return rel !== "" && fileAt(ctx.workspace, rel) ? rel : undefined;
  };
  const candidates: string[] = [];
  if (!angled) candidates.push(ctx.dir);
  const { roots, projectRoots, ancestors } = rootsOf(ctx);
  candidates.push(...roots);
  for (const dir of candidates) {
    const rel = tryDir(dir);
    if (rel !== undefined && acceptedFile(ctx.workspace, rel)) return rel;
  }
  if (!spelled.includes("/")) return undefined;
  // A qualified include no root resolves: conventional directories of the ancestors below the nearest project root (that root
  // has contributed its own already; nothing above it belongs to this file's project).
  for (const ancestor of ancestors) {
    if (ancestor === projectRoots[0]) break;
    for (const c of CONVENTIONAL_DIRS) {
      if (c === "" && angled && ancestor === ctx.dir) continue; // `<x>` never resolves against the including directory
      const rel = tryDir(c === "" ? ancestor : posixJoin(ancestor, c));
      if (rel !== undefined && acceptedFile(ctx.workspace, rel)) return rel;
    }
  }
  // The include directories declared anywhere in the same CMake project tree; ambiguity yields nothing.
  if (ctx.treeDirs === undefined) {
    const cmakeRoot = ancestors.find((a) => fileAt(ctx.workspace, posixJoin(a, "CMakeLists.txt")));
    ctx.treeDirs = cmakeRoot === undefined ? [] : cmakeTreeDirs(ctx.workspace, cmakeTopDir(ctx.workspace, cmakeRoot));
  }
  const hits = unique(ctx.treeDirs.map(tryDir).filter((rel): rel is string => rel !== undefined));
  if (hits.length === 1) return acceptedFile(ctx.workspace, hits[0]!) ? hits[0] : undefined;
  if (hits.length > 1) return undefined;
  // Sibling libraries without any declared include directory (`libs/net/include/net/socket.h` for `<net/socket.h>` from
  // `libs/render/src/r.cpp`): the nearest ancestor with exactly one matching `<child>/include/<path>` (or `inc`).
  for (const ancestor of ancestors) {
    const found = new Set<string>();
    const children = (readDir(ctx.workspace, ancestor)?.entries ?? []).filter((e) => e.dir && !e.name.startsWith(".") && !SKIPPED_TREE_DIRS.has(e.name) && !e.name.startsWith("cmake-build-")).slice(0, MAX_SIBLING_DIRS);
    for (const child of children) {
      for (const sub of HEADER_TREE_NAMES) {
        const dir = posixJoin(ancestor, child.name, sub);
        // Only directory listings not yet loaded for this file cost anything (and count against the budget).
        if (!ctx.listings.has(dir)) {
          if (ctx.siblingProbes >= MAX_SIBLING_PROBES) return undefined;
          ctx.siblingProbes++;
        }
        const rel = tryDir(dir);
        if (rel !== undefined) found.add(rel);
      }
    }
    if (found.size === 1) {
      const only = [...found][0]!;
      return acceptedFile(ctx.workspace, only) ? only : undefined;
    }
    if (found.size > 1) return undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Counterparts
// ---------------------------------------------------------------------------

function existingWithStem(workspace: string, dir: string, stem: string, extensions: readonly string[]): string[] {
  const names = readDir(workspace, dir)?.names;
  if (names === undefined) return [];
  const out: string[] = [];
  for (const ext of extensions) {
    if (!names.has(stem + ext)) continue;
    const rel = posixJoin(dir, stem + ext);
    if (fileAt(workspace, rel)) out.push(rel);
  }
  return out;
}

/** Directory names that mark a library's own include/source split (a library without a build file keeps one too). */
const LAYOUT_DIR_NAMES = new Set<string>([...HEADER_TREE_NAMES, ...SOURCE_TREE_NAMES]);

/**
 * The module a directory belongs to for counterpart pairing: the nearest ancestor-or-self of `dir` (never above `root`) that
 * owns an include/inc/src/source split, else `root` itself. Sibling libraries that each keep such a split are different modules.
 */
function moduleOf(workspace: string, root: string, dir: string): string {
  for (let d = dir, n = 0; n < MAX_ANCESTORS && d !== root; n++) {
    if (readDir(workspace, d)?.entries.some((e) => e.dir && LAYOUT_DIR_NAMES.has(e.name)) === true) return d;
    if (d === "") break;
    d = posixDirname(d);
  }
  return root;
}

/**
 * Whether directory `dir` (listed as `entries`) starts a project of its own — a CMake or Meson `project()`, an autotools
 * `configure.ac`, a Bazel workspace, a compile database — rather than being one more directory of its parent's build (a plain
 * CMakeLists.txt, a Makefile or a Bazel package `BUILD` file each exist in nearly every directory of a project).
 */
function startsProject(workspace: string, dir: string, entries: ReadonlyArray<{ name: string; dir: boolean }>): boolean {
  const has = (name: string): boolean => entries.some((e) => !e.dir && e.name === name);
  if (has("configure.ac") || has("configure.in") || has("compile_commands.json")) return true;
  if (entries.some((e) => !e.dir && BAZEL_WORKSPACE_MARKERS.has(e.name))) return true;
  if (has("CMakeLists.txt") && cmakeAt(workspace, dir)?.hasProject === true) return true;
  return has("meson.build") && parseAt(workspace, posixJoin(dir, "meson.build"), MAX_MANIFEST_BYTES, mesonStartsProject) === true;
}

/**
 * Files named `stem` + one of `extensions` under `root`; undefined when the search was cut off (uniqueness cannot be claimed).
 * A subdirectory that starts a project of its own (a vendored dependency) is a different project: the search never enters it.
 */
function stemMatchesUnder(workspace: string, root: string, stem: string, extensions: readonly string[]): string[] | undefined {
  const found: string[] = [];
  const queue: string[] = [root];
  let examined = 0;
  while (queue.length > 0) {
    const dir = queue.shift()!;
    const entries = readDir(workspace, dir)?.entries ?? [];
    examined += entries.length;
    if (examined > MAX_STEM_SCAN_ENTRIES) return undefined;
    if (dir !== root && startsProject(workspace, dir, entries)) continue;
    for (const { name, dir: isDir } of entries) {
      if (isDir) {
        if (!name.startsWith(".") && !SKIPPED_TREE_DIRS.has(name) && !name.startsWith("cmake-build-")) queue.push(posixJoin(dir, name));
        continue;
      }
      const ext = path.posix.extname(name);
      if (ext.length > 0 && name.slice(0, -ext.length) === stem && extensions.includes(ext.toLowerCase())) found.push(posixJoin(dir, name));
    }
  }
  return found;
}

function counterpartsOf(workspace: string, file: string, ctx: ResolveContext): string[] {
  const ext = path.posix.extname(file).toLowerCase();
  const isHeader = HEADER_EXTENSIONS.includes(ext);
  if (!isHeader && !SOURCE_EXTENSIONS.includes(ext)) return [];
  const stem = path.posix.basename(file, path.posix.extname(file));
  const dir = posixDirname(file);
  const wanted = isHeader ? (IMPLEMENTATION_INCLUDES.has(ext) ? [...PRIMARY_HEADER_EXTENSIONS, ...SOURCE_EXTENSIONS] : SOURCE_EXTENSIONS) : HEADER_EXTENSIONS;
  const same = existingWithStem(workspace, dir, stem, wanted).filter((rel) => rel !== file);
  if (same.length > 0) return same;
  // Mirrored trees: the nearest include/inc component (for a header) or src/source component (for a source) names the base.
  const components = dir === "" ? [] : dir.split("/");
  const ownNames = isHeader ? HEADER_TREE_NAMES : SOURCE_TREE_NAMES;
  const otherNames = isHeader ? SOURCE_TREE_NAMES : HEADER_TREE_NAMES;
  for (let idx = components.length - 1; idx >= 0; idx--) {
    if (!ownNames.includes(components[idx]!)) continue;
    const base = components.slice(0, idx).join("/");
    const sub = components.slice(idx + 1);
    for (const other of otherNames) {
      const otherRoot = posixJoin(base, other);
      if (!dirAt(workspace, otherRoot)) continue;
      const candidates = [posixJoin(otherRoot, ...sub)];
      if (isHeader && sub.length > 0) candidates.push(posixJoin(otherRoot, ...sub.slice(1)));
      for (const candidate of candidates) {
        const hits = existingWithStem(workspace, candidate, stem, wanted);
        if (hits.length > 0) return hits;
      }
      if (!isHeader) {
        // include/<dirname>/x.h for src/x.cpp: one namespace directory under the include root, unique or nothing.
        const namespaced = (readDir(workspace, otherRoot)?.entries ?? [])
          .filter((e) => e.dir)
          .slice(0, 32)
          .flatMap((e) => existingWithStem(workspace, posixJoin(otherRoot, e.name, ...sub), stem, wanted));
        if (namespaced.length > 0) return namespaced.length === 1 ? namespaced : [];
      }
    }
    break;
  }
  // A unique same-stem file of the same module within the NEAREST project root (never into a vendored project, never into a
  // sibling library of an umbrella build: `libs/a/src/util.c` does not pair with `libs/b/include/util.h`).
  const projectRoot = rootsOf(ctx).projectRoots[0];
  if (projectRoot === undefined) return [];
  const found = stemMatchesUnder(workspace, projectRoot, stem, wanted);
  if (found === undefined) return [];
  const ownModule = moduleOf(workspace, projectRoot, dir);
  const sameModule = found.filter((rel) => rel !== file && moduleOf(workspace, projectRoot, posixDirname(rel)) === ownModule);
  return sameModule.length === 1 ? sameModule : [];
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** The leading part of `lines` a scan covers: at most 20,000 lines and 1 MiB, each line cut at 4,096 characters. */
function boundedLines(lines: readonly string[]): readonly string[] {
  let total = 0;
  let count = 0;
  let cut = false;
  for (; count < lines.length && count < MAX_SCANNED_LINES && total < MAX_SCANNED_CHARS; count++) {
    const len = lines[count]!.length;
    total += Math.min(len, MAX_LINE_CHARS) + 1;
    if (len > MAX_LINE_CHARS) cut = true;
  }
  if (count === lines.length && !cut) return lines;
  return lines.slice(0, count).map((l) => (l.length > MAX_LINE_CHARS ? l.slice(0, MAX_LINE_CHARS) : l));
}

export function resolveCIncludesOf(
  workspace: string,
  filePath: string,
  lines: readonly string[],
  maxEdges: number,
): ResolvedImport[] {
  // Runs inside pack hooks: an unforeseen input or file-system state must cost recall, never the response.
  try {
    return resolveEdges(workspace, filePath, lines, maxEdges);
  } catch {
    return [];
  }
}

function resolveEdges(workspace: string, filePath: string, lines: readonly string[], maxEdges: number): ResolvedImport[] {
  if (maxEdges <= 0) return [];
  const file = filePath.replace(/\\/g, "/");
  const ctx: ResolveContext = { workspace, file, dir: posixDirname(file), rootSet: undefined, treeDirs: undefined, probes: 0, siblingProbes: 0, listings: new Map() };
  const view = analyzeCFamilySource(boundedLines(lines));
  const out: ResolvedImport[] = [];
  const seen = new Set<string>([file]);
  for (const inc of view.includes.slice(0, MAX_DIRECTIVES)) {
    if (out.length >= maxEdges) return out;
    const resolved = resolveInclude(ctx, inc.target, inc.angled);
    if (resolved === undefined || seen.has(resolved)) continue;
    seen.add(resolved);
    out.push({ path: resolved, line: inc.line, kind: "include", names: [] });
  }
  for (const rel of counterpartsOf(workspace, file, ctx)) {
    if (out.length >= maxEdges) break;
    if (seen.has(rel) || !acceptedFile(workspace, rel)) continue;
    seen.add(rel);
    out.push({ path: rel, line: 0, kind: "counterpart", names: [] });
  }
  return out;
}
