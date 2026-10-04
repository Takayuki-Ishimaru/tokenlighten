/**
 * importResolveJvm.ts — Java and Kotlin (`.java`, `.kt`, `.kts`) import edges
 * for importResolution.ts's dispatcher (consumed by the default-OFF V15-NBR
 * neighbour index and V15-FUI usage inventory). Contract: see
 * importResolution.ts and importGraphShared.ts.
 *
 * Every rule below is a language or build-tool rule, none is keyed to a
 * project, package or identifier name:
 *
 * 1. SOURCE ROOT. The file's own `package a.b.c` declaration names the
 *    directory suffix the file must sit under (`…/a/b/c`); the source root is
 *    the directory minus that suffix, wherever in the workspace it lies (a
 *    project nested three directories below the workspace root works the same
 *    as one at the root). A file whose directory does not end with its
 *    package falls back to a conventional `src/<set>/(java|kotlin)` root in
 *    its own path. A served slice without the `package` line reads it from
 *    the file's head.
 * 2. WHERE AN IMPORT MAY LIVE, in this order: the file's own root; the other
 *    source roots of its build module (`<module>/src/<set>/(java|kotlin)` for
 *    every source set: main, test, testFixtures, integrationTest, Kotlin
 *    multiplatform `commonMain`/`jvmMain`, Android variants, …); the source
 *    roots of the other modules of the enclosing build(s) — every ancestor that
 *    is a Maven aggregator (`pom.xml` with `<module>` entries, followed
 *    recursively) or a Gradle build (`settings.gradle[.kts]`: `include` lines,
 *    literal `projectDir` remaps, `includeBuild` composite builds, with a
 *    direct-subdirectory fallback when the settings file is dynamic), plus
 *    `buildSrc` for `.kts` scripts; finally — only for a file whose own
 *    project IS the workspace root, or for which no source root could be
 *    derived — the workspace root and `src/main/java` (kept from the previous
 *    resolver; for a nested project they would resolve into an unrelated root
 *    project sharing a package name). A layout with no build tool (`src/` next
 *    to `test/`, Bazel-style `java/` next to `javatests/`) uses the sibling
 *    directories of the file's own root.
 *    VISIBILITY: a main-code importer never resolves into a test source set
 *    (that import could not compile); a test importer sees its own module's
 *    test sets first, then main, and other modules' `testFixtures`.
 * 3. IMPORT FORMS. `import a.b.C;`, Kotlin `import a.b.C as Alias`, static
 *    imports (`import static a.b.C.m;` -> `C`), nested types
 *    (`import a.b.Outer.Inner;` -> `Outer.java`), `import a.b.C.*` (the type)
 *    and package wildcards. A package wildcard yields one edge per PascalCase
 *    identifier the body USES as code (comments, string literals, text blocks
 *    and Kotlin backtick names are masked) that exists as `<pkg>/<Name>.java|.kt`,
 *    never for a name the same package already declares (the JLS gives the same
 *    package priority over an on-demand import) or that two wildcards both
 *    provide (ambiguous). Kotlin declares many classes and top-level functions
 *    per file, so an import (or a used name) that has no file of that name is
 *    looked up among the top-level declarations of the package directory's
 *    `.kt` files (declarationScan.ts; `private` ones are skipped, `internal`
 *    ones stay).
 * 4. SAME-PACKAGE REFERENCES (`kind:"reference"`, no import statement): the
 *    PascalCase identifiers the body uses that a same-package file declares —
 *    same package in ANY visible root, so a test class reaches the main class
 *    it exercises — grouped per target file, first-use line. Kotlin also
 *    resolves lowercase function calls `name(` and `UPPER_SNAKE` constants to
 *    the same package's top-level declarations — but never a call inside a
 *    class body whose header names a supertype (it may be an inherited member,
 *    which Kotlin prefers). Names the body imports explicitly, declares or
 *    binds itself (`fun`/`val`/`var`, parameters, lambda parameters), and
 *    selectors (`x.name`, `x. name`, `x?.name`, a dot ending the previous
 *    line) are excluded; test files are only offered to a test importer.
 * 5. Everything is bounded (statements, distinct used names, modules, source
 *    sets, directory entries, file-system operations per call, bytes read,
 *    line lengths of the Kotlin heuristics); parsed build files are cached per
 *    absolute path, validated by mtime and size; the resolver never throws (a
 *    failure yields no edges). Every read, listing and parse checks the REAL
 *    path first (`realPathInside`): a symlink pointing out of the workspace is
 *    neither read nor listed, and an edge whose real path leaves it is dropped.
 *
 * NOT covered (emit nothing rather than a guess): Gradle `srcDirs`/Maven
 * `<sourceDirectory>` customisations other than what the package declaration
 * reveals, dependency graphs between modules (every module of the build is a
 * candidate, own module first), generated sources, Kotlin files whose
 * directory does not mirror their package (unless they sit beside the importer),
 * lowercase Kotlin top-level properties and extension properties used without
 * an import, names used only inside string templates, Java secondary top-level
 * classes declared in a file of another name, fully qualified names written
 * inline in code.
 */
import * as fs from "fs";
import * as path from "path";
import { declarationsIn } from "./declarationScan.js";
import {
  type ResolvedImport,
  directoryExists,
  listDirectory,
  posixDirname,
  posixJoin,
  realPathInside,
  uniqueNames,
  withinWorkspace,
} from "./importGraphShared.js";

/** Import statements RESOLVED per file (the previous resolver's bound). */
const MAX_STATEMENTS = 40;
/** Import statements PARSED per file (binding names need them all). */
const MAX_PARSED_IMPORTS = 200;
const MAX_REFERENCES = 12;
/** Distinct used type names looked up per file (a real file has far fewer). */
const MAX_USED_NAMES = 400;
const MAX_WILDCARD_EDGES = 8;
const MAX_NAMES_PER_EDGE = 8;
const MAX_MODULES = 64;
const MAX_MODULE_DEPTH = 5;
const MAX_INCLUDED_BUILDS = 8;
const MAX_SOURCE_SETS = 24;
const MAX_ANCESTORS = 24;
const MAX_SIBLING_DIRS = 24;
const MAX_CHILD_SCAN = 200;
/** Entries of one directory listing kept (a package directory of generated classes can be huge). */
const MAX_LISTED_ENTRIES = 4000;
/** File-system operations (stat/readdir/read) one call may spend. */
const MAX_FS_OPS = 3000;
const MAX_MANIFEST_BYTES = 1024 * 1024;
/** Characters of a body/manifest the masker looks at. */
const MAX_MASK_CHARS = 512 * 1024;
const MAX_INDEX_FILES = 80;
const MAX_INDEX_FILE_BYTES = 256 * 1024;
const MANIFEST_CACHE_LIMIT = 256;
const DECLARED_NAMES_CACHE_LIMIT = 4096;

// ---------------------------------------------------------------------------
// Lexical masking: comments and string/char literals -> spaces, every newline
// (and \r) kept, so offsets and line numbers of the masked text equal the
// original's. A lexical approximation with no parser: every ambiguity is
// resolved toward masking LESS.
// ---------------------------------------------------------------------------

type MaskMode = "java" | "kotlin" | "gradle";

function maskNonCode(text: string, mode: MaskMode, keepStrings: boolean): string {
  const limit = Math.min(text.length, MAX_MASK_CHARS);
  const out: string[] = [];
  let run = 0;
  const blank = (from: number, to: number): void => {
    if (from > run) out.push(text.slice(run, from));
    out.push(text.slice(from, to).replace(/[^\r\n]/g, " "));
    run = to;
  };
  let atLineStart = true;
  let i = 0;
  while (i < limit) {
    const c = text.charCodeAt(i);
    if (c === 10) { atLineStart = true; i++; continue; }
    if (c === 32 || c === 9 || c === 13) { i++; continue; }
    const d = i + 1 < text.length ? text.charCodeAt(i + 1) : -1;
    if (c === 47 && d === 47) { // line comment
      let end = text.indexOf("\n", i);
      if (end < 0 || end > limit) end = limit;
      blank(i, end);
      i = end;
    } else if (c === 47 && d === 42) { // block comment (Kotlin nests)
      let depth = 1;
      let j = i + 2;
      while (j < limit && depth > 0) {
        const cj = text.charCodeAt(j);
        const dj = text.charCodeAt(j + 1);
        if (cj === 42 && dj === 47) { depth--; j += 2; }
        else if (mode === "kotlin" && cj === 47 && dj === 42) { depth++; j += 2; }
        else j++;
      }
      j = Math.min(j, limit);
      blank(i, j);
      i = j;
    } else if (c === 42 && atLineStart && mode !== "gradle" && (d === -1 || d === 32 || d === 9 || d === 47 || d === 10 || d === 13)) {
      // A `* text` / `*/` line whose comment head lies outside a served slice.
      let end = text.indexOf("\n", i);
      if (end < 0 || end > limit) end = limit;
      blank(i, end);
      i = end;
      continue;
    } else if (c === 96 && mode === "kotlin") { // `quoted name` (test names hold prose, not references)
      const end = endOfLineString(text, i, limit, 96);
      if (!keepStrings) blank(i, end);
      i = end;
    } else if (c === 34) { // "
      if (mode !== "gradle" && text.startsWith('"""', i)) { // text block / Kotlin raw string
        let end = text.indexOf('"""', i + 3);
        end = end < 0 ? limit : Math.min(end + 3, limit);
        if (mode === "kotlin") while (end < limit && text.charCodeAt(end) === 34) end++;
        if (!keepStrings) blank(i, end);
        i = end;
      } else {
        const end = endOfLineString(text, i, limit, 34);
        if (!keepStrings) blank(i, end);
        i = end;
      }
    } else if (c === 39) { // '
      if (mode === "gradle") {
        const end = endOfLineString(text, i, limit, 39);
        if (!keepStrings) blank(i, end);
        i = end;
      } else {
        const end = endOfCharLiteral(text, i, limit);
        if (end > i + 1) {
          if (!keepStrings) blank(i, end);
          i = end;
        } else i++;
      }
    } else i++;
    atLineStart = false;
  }
  if (run < limit) out.push(text.slice(run, limit));
  if (text.length > limit) out.push(text.slice(limit).replace(/[^\r\n]/g, " "));
  return out.join("");
}

/** End (exclusive) of a single-line string opening at `start`; an unterminated one ends at its newline. */
function endOfLineString(text: string, start: number, limit: number, quote: number): number {
  let j = start + 1;
  while (j < limit) {
    const cj = text.charCodeAt(j);
    if (cj === 92) { j += 2; continue; }
    if (cj === quote) return j + 1;
    if (cj === 10) return j;
    j++;
  }
  return Math.min(j, limit);
}

/** End (exclusive) of a char literal opening at `start`, or `start` when it is not one. */
function endOfCharLiteral(text: string, start: number, limit: number): number {
  let j = start + 1;
  if (text.charCodeAt(j) === 92) j += 2; else j += 1;
  for (let k = j; k < limit && k - start <= 10; k++) {
    const ck = text.charCodeAt(k);
    if (ck === 39) return k + 1;
    if (ck === 10) return start;
  }
  return start;
}

// ---------------------------------------------------------------------------
// Per-call file-system probe (memoized, operation-budgeted) and stamped caches
// ---------------------------------------------------------------------------

/**
 * `rel` is the workspace root, or exists with its REAL path (every symlink
 * resolved) inside the workspace. Every read, listing and parse below goes
 * through this check first: the lexical `withinWorkspace` cannot see a
 * symlink inside the tree that points out of it.
 */
function realInside(workspace: string, rel: string): boolean {
  return rel === "" || realPathInside(workspace, rel);
}

class Probe {
  private readonly dirs = new Map<string, boolean>();
  private readonly listings = new Map<string, string[]>();
  private readonly entrySets = new Map<string, ReadonlySet<string>>();
  private readonly ktIndexes = new Map<string, ReadonlyMap<string, { file: string; kind: string }>>();
  private ops = 0;

  constructor(readonly workspace: string) {}

  private spend(): boolean {
    this.ops++;
    return this.ops <= MAX_FS_OPS;
  }

  /** A budgeted operation for callers that stat/read on their own. */
  charge(): boolean {
    return this.spend();
  }

  isDir(rel: string): boolean {
    if (rel === "") return true;
    const hit = this.dirs.get(rel);
    if (hit !== undefined) return hit;
    const ok = this.spend() && directoryExists(this.workspace, rel) && realInside(this.workspace, rel);
    this.dirs.set(rel, ok);
    return ok;
  }

  /** Sorted entry names of `rel` ("" = workspace root); [] when unreadable or over budget. */
  list(rel: string): string[] {
    const hit = this.listings.get(rel);
    if (hit !== undefined) return hit;
    const names = this.spend() && this.isDir(rel) ? listDirectory(this.workspace, rel).slice(0, MAX_LISTED_ENTRIES) : [];
    this.listings.set(rel, names);
    return names;
  }

  entries(rel: string): ReadonlySet<string> {
    const hit = this.entrySets.get(rel);
    if (hit !== undefined) return hit;
    const set = new Set(this.list(rel));
    this.entrySets.set(rel, set);
    return set;
  }

  ktIndex(
    rel: string,
    build: () => ReadonlyMap<string, { file: string; kind: string }>,
  ): ReadonlyMap<string, { file: string; kind: string }> {
    const hit = this.ktIndexes.get(rel);
    if (hit !== undefined) return hit;
    const index = build();
    this.ktIndexes.set(rel, index);
    return index;
  }
}

interface StampedValue {
  mtimeMs: number;
  size: number;
  value: unknown;
}

const MANIFEST_CACHE = new Map<string, StampedValue>();

/**
 * Parse of the workspace-relative file `rel`, cached per ABSOLUTE path and
 * validated against the file's mtime and size on every call (one stat).
 * `undefined` when the file does not exist, is over 1 MiB or escapes the workspace.
 */
function cachedParse<T>(workspace: string, rel: string, parse: (text: string) => T): T | undefined {
  const abs = withinWorkspace(workspace, rel);
  if (abs === undefined) return undefined;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    return undefined;
  }
  if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) return undefined;
  const hit = MANIFEST_CACHE.get(abs);
  if (hit !== undefined && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.value as T;
  if (!realInside(workspace, rel)) return undefined; // a symlink out of the workspace is never read
  let text: string;
  try {
    text = fs.readFileSync(abs, "utf8");
  } catch {
    return undefined;
  }
  const value = parse(text);
  if (MANIFEST_CACHE.size >= MANIFEST_CACHE_LIMIT) {
    const oldest = MANIFEST_CACHE.keys().next();
    if (!oldest.done) MANIFEST_CACHE.delete(oldest.value);
  }
  MANIFEST_CACHE.set(abs, { mtimeMs: stat.mtimeMs, size: stat.size, value });
  return value;
}

/** First `maxBytes` bytes of a workspace file as text; undefined when unreadable. */
function readHead(workspace: string, rel: string, maxBytes: number): string | undefined {
  const abs = withinWorkspace(workspace, rel);
  if (abs === undefined || !realInside(workspace, rel)) return undefined;
  let fd: number | undefined;
  try {
    // Opening a FIFO or device for reading can block: only a regular file is ever opened.
    if (!fs.statSync(abs).isFile()) return undefined;
    fd = fs.openSync(abs, "r");
    const size = Math.min(fs.fstatSync(fd).size, maxBytes);
    if (size <= 0) return "";
    const buffer = Buffer.allocUnsafe(size);
    const read = fs.readSync(fd, buffer, 0, size, 0);
    return buffer.toString("utf8", 0, read).replace(/^\uFEFF/, "");
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* best effort */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Build files: Maven aggregators and Gradle settings
// ---------------------------------------------------------------------------

interface PomInfo {
  modules: string[];
}

function parsePom(text: string): PomInfo {
  const clean = text.replace(/<!--[\s\S]*?-->/g, "");
  const modules: string[] = [];
  for (const m of clean.matchAll(/<module>\s*([^<]+?)\s*<\/module>/g)) {
    const entry = m[1]!;
    if (entry.includes("${")) continue;
    modules.push(entry);
    if (modules.length >= MAX_MODULES) break;
  }
  return { modules };
}

interface GradleSettings {
  includes: string[];
  remap: Array<[string, string]>;
  /** `includeBuild("path")` composite builds. */
  builds: string[];
}

function gradlePathKey(gradlePath: string): string {
  return gradlePath.split(":").filter((s) => s.length > 0).join(":");
}

function parseGradleSettings(text: string): GradleSettings {
  const clean = maskNonCode(text, "gradle", true);
  const includes: string[] = [];
  for (const m of clean.matchAll(/\binclude\s*\(?\s*((?:(?:"[^"\n]*"|'[^'\n]*')(?:\s*,\s*)?)+)/g)) {
    for (const s of m[1]!.matchAll(/["']([^"'\n]*)["']/g)) {
      const key = gradlePathKey(s[1]!);
      if (key.length > 0) includes.push(key);
      if (includes.length >= MAX_MODULES) break;
    }
  }
  const builds: string[] = [];
  for (const m of clean.matchAll(/\bincludeBuild\s*\(?\s*["']([^"'\n]+)["']/g)) {
    builds.push(m[1]!);
    if (builds.length >= MAX_INCLUDED_BUILDS) break;
  }
  const remap: Array<[string, string]> = [];
  const remapRe = /\bproject\s*\(\s*["']([^"'\n]+)["']\s*\)\s*\.\s*projectDir\s*=\s*(?:new\s+)?[Ff]ile\s*\(\s*(?:(?:rootDir|settingsDir|rootProject\.projectDir)\s*,\s*)?["']([^"'\n]+)["']\s*\)/g;
  for (const m of clean.matchAll(remapRe)) remap.push([gradlePathKey(m[1]!), m[2]!]);
  return { includes, remap, builds };
}

const SKIPPED_CHILD_DIRS = new Set(["node_modules", "build", "target", "out", "dist", "bin", "gradle"]);

/** Module directories of the Maven aggregator at `dir`, followed recursively (bounded). */
function collectMavenModules(probe: Probe, dir: string, depth: number, out: string[], seen: Set<string>): void {
  if (depth > MAX_MODULE_DEPTH || out.length >= MAX_MODULES) return;
  const pom = cachedParse(probe.workspace, posixJoin(dir, "pom.xml"), parsePom);
  if (pom === undefined) return;
  for (const entry of pom.modules) {
    if (out.length >= MAX_MODULES) return;
    const joined = /\.xml$/i.test(entry) ? posixDirname(posixJoin(dir, entry)) : posixJoin(dir, entry);
    if (joined.startsWith("..") || seen.has(joined)) continue;
    if (!probe.isDir(joined)) continue;
    seen.add(joined);
    out.push(joined);
    collectMavenModules(probe, joined, depth + 1, out, seen);
  }
}

/**
 * Module directories of the build rooted at `dir` (a Gradle settings file
 * and/or a Maven aggregator), or undefined when `dir` is not a build root.
 */
function modulesOfBuildAt(probe: Probe, dir: string, followIncludedBuilds = true): string[] | undefined {
  const workspace = probe.workspace;
  if (!probe.charge()) return undefined;
  const gradle =
    cachedParse(workspace, posixJoin(dir, "settings.gradle.kts"), parseGradleSettings) ??
    cachedParse(workspace, posixJoin(dir, "settings.gradle"), parseGradleSettings);
  if (!probe.charge()) return undefined;
  const pom = cachedParse(workspace, posixJoin(dir, "pom.xml"), parsePom);
  const isAggregator = pom !== undefined && pom.modules.length > 0;
  if (gradle === undefined && !isAggregator) return undefined;
  const modules: string[] = [];
  const seen = new Set<string>([dir]);
  if (gradle !== undefined) {
    const remap = new Map(gradle.remap);
    for (const key of gradle.includes) {
      if (modules.length >= MAX_MODULES) break;
      const rel = posixJoin(dir, remap.get(key) ?? key.split(":").join("/"));
      if (rel.startsWith("..") || seen.has(rel) || !probe.isDir(rel)) continue;
      seen.add(rel);
      modules.push(rel);
    }
  }
  if (isAggregator) collectMavenModules(probe, dir, 0, modules, seen);
  if (modules.length === 0 && gradle !== undefined) {
    // A dynamic settings file (loops, `file(...).listFiles()`): the direct
    // subdirectories that hold sources are the modules.
    for (const name of probe.list(dir).slice(0, MAX_CHILD_SCAN)) {
      if (modules.length >= MAX_MODULES) break;
      if (name.startsWith(".") || SKIPPED_CHILD_DIRS.has(name)) continue;
      const child = posixJoin(dir, name);
      if (probe.isDir(posixJoin(child, "src/main/java")) || probe.isDir(posixJoin(child, "src/main/kotlin"))) modules.push(child);
    }
  }
  if (gradle !== undefined && followIncludedBuilds) {
    // Composite builds (`includeBuild("../shared")`, convention plugins): the included build and its own modules.
    for (const build of gradle.builds) {
      const rel = posixJoin(dir, build);
      if (rel.startsWith("..") || seen.has(rel) || !probe.isDir(rel)) continue;
      seen.add(rel);
      modules.push(rel);
      for (const module of modulesOfBuildAt(probe, rel, false) ?? []) {
        if (!seen.has(module) && modules.length < MAX_MODULES) {
          seen.add(module);
          modules.push(module);
        }
      }
    }
  }
  return modules;
}

// ---------------------------------------------------------------------------
// Source roots
// ---------------------------------------------------------------------------

interface Root {
  /** Workspace-relative source root ("" = the workspace root). */
  dir: string;
  /** A test-like source set (test, integrationTest, testFixtures, commonTest, …). */
  test: boolean;
  /** The `src/<set>` name of a conventional root. */
  set?: string;
}

function isTestSetName(name: string): boolean {
  return /test/i.test(name) || /^(?:it|e2e|jmh|integration|functional)$/i.test(name);
}

const TEST_FILE_NAME_RE = /(?:[a-z0-9]|^)(?:Tests?|IT|ITCase|TestCase)$/;

function stemOf(file: string): string {
  return path.posix.basename(file).replace(/\.[^.]+$/, "");
}

/** `<module>/src/<set>/(java|kotlin)` -> its module directory and set; undefined for another layout. */
function conventionalRootParts(root: string): { module: string; set: string } | undefined {
  const segs = root === "" ? [] : root.split("/");
  const n = segs.length;
  if (n >= 3 && (segs[n - 1] === "java" || segs[n - 1] === "kotlin") && segs[n - 3] === "src") {
    return { module: segs.slice(0, n - 3).join("/"), set: segs[n - 2]! };
  }
  return undefined;
}

/** The source root implied by the file's own package declaration: the directory minus the package's path. */
function rootFromPackage(file: string, pkgSegs: readonly string[]): string | undefined {
  const dir = posixDirname(file);
  const dirSegs = dir === "" ? [] : dir.split("/");
  if (dirSegs.length < pkgSegs.length) return undefined;
  const tail = dirSegs.slice(dirSegs.length - pkgSegs.length);
  return tail.every((seg, index) => seg === pkgSegs[index]) ? dirSegs.slice(0, dirSegs.length - pkgSegs.length).join("/") : undefined;
}

/** A conventional `src/<set>/(java|kotlin)` root in the file's own path (for a file whose directory does not spell its package). */
function conventionalRootOf(file: string): string | undefined {
  const dir = posixDirname(file);
  const dirSegs = dir === "" ? [] : dir.split("/");
  for (let j = dirSegs.length - 3; j >= 0; j--) {
    if (dirSegs[j] === "src" && (dirSegs[j + 2] === "java" || dirSegs[j + 2] === "kotlin")) return dirSegs.slice(0, j + 3).join("/");
  }
  return undefined;
}

function isTestImporter(file: string, ownRoot: string | undefined): boolean {
  if (ownRoot !== undefined) {
    const parts = conventionalRootParts(ownRoot);
    if (parts !== undefined) return isTestSetName(parts.set);
    if (ownRoot.split("/").some((seg) => /^(?:test|tests)$/i.test(seg))) return true;
  } else if (posixDirname(file).split("/").some((seg) => /^(?:test|tests)$/i.test(seg))) return true;
  return TEST_FILE_NAME_RE.test(stemOf(file));
}

/** `<module>/src/<set>/(java|kotlin)` roots of a module whose set name `wanted` accepts (an unwanted set costs no stat). */
function moduleSourceRoots(probe: Probe, moduleDir: string, wanted: (set: string) => boolean): Root[] {
  const src = posixJoin(moduleDir, "src");
  const out: Root[] = [];
  for (const set of probe.list(src).slice(0, MAX_SOURCE_SETS)) {
    if (set.startsWith(".") || !wanted(set)) continue;
    for (const lang of ["java", "kotlin"]) {
      const dir = posixJoin(src, set, lang);
      if (probe.isDir(dir)) out.push({ dir, test: isTestSetName(set), set });
    }
  }
  return out;
}

/** Nearest ancestor (the directory itself first) holding a Maven/Gradle build file. */
function nearestBuildDir(probe: Probe, startDir: string): string | undefined {
  let dir = startDir;
  for (let depth = 0; depth < MAX_ANCESTORS; depth++) {
    const names = probe.entries(dir);
    for (const marker of ["pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"]) {
      if (names.has(marker)) return dir;
    }
    if (dir === "") return undefined;
    dir = posixDirname(dir);
  }
  return undefined;
}

interface Ctx {
  probe: Probe;
  file: string;
  kotlin: boolean;
  script: boolean;
  /** The file's own package (empty = default package). */
  pkgSegs: readonly string[];
  ownRoot: string | undefined;
  /** The file's directory ends with its package (the source root followed from the package declaration). */
  dirSpellsPackage: boolean;
  isTest: boolean;
  ownModule: string | undefined;
  ownSet: string | undefined;
  near?: Root[];
  far?: Root[];
  legacy?: Root[];
}

function createContext(probe: Probe, file: string, kotlin: boolean, script: boolean, pkgSegs: readonly string[]): Ctx {
  const fromPackage = script ? undefined : rootFromPackage(file, pkgSegs);
  const ownRoot = script ? undefined : fromPackage ?? conventionalRootOf(file);
  const parts = ownRoot === undefined ? undefined : conventionalRootParts(ownRoot);
  return {
    probe,
    file,
    kotlin,
    script,
    pkgSegs,
    ownRoot,
    dirSpellsPackage: fromPackage !== undefined,
    isTest: isTestImporter(file, ownRoot),
    ownModule: parts?.module,
    ownSet: parts?.set,
  };
}

function rootScore(ctx: Ctx, root: Root): number {
  if (root.dir === ctx.ownRoot) return 0;
  if (ctx.ownSet !== undefined && root.set === ctx.ownSet) return 1;
  if (ctx.isTest) return root.test ? 2 : root.set === "main" ? 3 : 4;
  return root.set === "main" ? 2 : 3;
}

function visibleTo(ctx: Ctx, root: Root, sameModule: boolean): boolean {
  if (root.dir === ctx.ownRoot) return true;
  if (!root.test) return true;
  return ctx.isTest && (sameModule || root.set === "testFixtures");
}

/** Roots of the file's own module (and layout siblings), best first. */
function nearRoots(ctx: Ctx): Root[] {
  if (ctx.near !== undefined) return ctx.near;
  const roots: Root[] = [];
  const seen = new Set<string>();
  const add = (root: Root): void => {
    if (seen.has(root.dir)) return;
    seen.add(root.dir);
    roots.push(root);
  };
  if (ctx.ownRoot !== undefined) add({ dir: ctx.ownRoot, test: ctx.isTest, set: ctx.ownSet });
  const moduleDir = ctx.ownModule ?? (ctx.script ? nearestBuildDir(ctx.probe, posixDirname(ctx.file)) : undefined);
  if (moduleDir !== undefined) {
    const own = moduleSourceRoots(ctx.probe, moduleDir, (set) => ctx.isTest || !isTestSetName(set)).filter((r) => visibleTo(ctx, r, true));
    own.sort((a, b) => rootScore(ctx, a) - rootScore(ctx, b));
    for (const root of own) add(root);
  } else if (ctx.ownRoot !== undefined && ctx.ownRoot !== "") {
    // A layout without a build tool: `src/` next to `test/`, `java/` next to `javatests/`.
    const parent = posixDirname(ctx.ownRoot);
    for (const name of ctx.probe.list(parent).slice(0, MAX_SIBLING_DIRS)) {
      if (name.startsWith(".") || SKIPPED_CHILD_DIRS.has(name)) continue;
      const dir = posixJoin(parent, name);
      if (dir === ctx.ownRoot || !ctx.probe.isDir(dir)) continue;
      const root: Root = { dir, test: isTestSetName(name) };
      if (visibleTo(ctx, root, true)) add(root);
    }
  }
  ctx.near = roots;
  return roots;
}

/** Roots of the other modules of the enclosing build(s); computed on first need. */
function farRoots(ctx: Ctx): Root[] {
  if (ctx.far !== undefined) return ctx.far;
  const roots: Root[] = [];
  const seenModules = new Set<string>();
  if (ctx.ownModule !== undefined) seenModules.add(ctx.ownModule);
  const startDir = ctx.ownModule ?? posixDirname(ctx.file);
  let dir = startDir;
  let moduleCount = 0;
  for (let depth = 0; depth < MAX_ANCESTORS; depth++) {
    const found = modulesOfBuildAt(ctx.probe, dir);
    if (found !== undefined) {
      for (const moduleDir of [dir, ...found]) {
        if (seenModules.has(moduleDir) || moduleCount >= MAX_MODULES) continue;
        seenModules.add(moduleDir);
        moduleCount++;
        const wanted = (set: string): boolean => !isTestSetName(set) || (ctx.isTest && set === "testFixtures");
        for (const root of moduleSourceRoots(ctx.probe, moduleDir, wanted)) if (visibleTo(ctx, root, false)) roots.push(root);
      }
    }
    if (ctx.script) {
      for (const lang of ["kotlin", "java"]) {
        const buildSrc = posixJoin(dir, "buildSrc/src/main", lang);
        if (ctx.probe.isDir(buildSrc)) roots.push({ dir: buildSrc, test: false, set: "main" });
      }
    }
    if (dir === "") break;
    dir = posixDirname(dir);
  }
  ctx.far = roots;
  return roots;
}

/**
 * Directory of the project the importing file belongs to: its build module, the
 * parent of its (plain-layout) source root, or — when no source root could be
 * derived — the nearest ancestor holding a build file. Undefined when nothing
 * is known about it.
 */
function projectDirOf(ctx: Ctx): string | undefined {
  if (ctx.ownModule !== undefined) return ctx.ownModule;
  if (ctx.ownRoot !== undefined) return posixDirname(ctx.ownRoot);
  return nearestBuildDir(ctx.probe, posixDirname(ctx.file));
}

/**
 * The previous resolver's catch-all locations (the workspace root and its
 * `src/main/java`), tried last — and only where they can be right: for a file
 * whose own project IS the workspace root, and as the last guess for a file
 * nothing is known about (no derivable source root and no build file above
 * it). A file of a NESTED project would otherwise resolve its imports
 * (typically supplied by a dependency JAR) into an unrelated project at the
 * workspace root that happens to share a package name.
 */
function legacyRoots(ctx: Ctx): Root[] {
  if (ctx.legacy !== undefined) return ctx.legacy;
  const projectDir = projectDirOf(ctx);
  const roots: Root[] = [];
  if (projectDir === undefined || projectDir === "") {
    roots.push(
      { dir: "", test: false },
      { dir: "src/main/java", test: false, set: "main" },
      { dir: "src/main/kotlin", test: false, set: "main" },
    );
    if (ctx.isTest) {
      roots.push({ dir: "src/test/java", test: true, set: "test" }, { dir: "src/test/kotlin", test: true, set: "test" });
    }
  }
  ctx.legacy = roots;
  return roots;
}

/** Near roots, then far, then legacy — deduplicated, far/legacy computed only when reached. */
function* rootsOf(ctx: Ctx): Generator<Root> {
  const seen = new Set<string>();
  for (const root of nearRoots(ctx)) {
    seen.add(root.dir);
    yield root;
  }
  for (const root of farRoots(ctx)) {
    if (seen.has(root.dir)) continue;
    seen.add(root.dir);
    yield root;
  }
  for (const root of legacyRoots(ctx)) {
    if (seen.has(root.dir)) continue;
    seen.add(root.dir);
    yield root;
  }
}

// ---------------------------------------------------------------------------
// Type lookup: `<root>/<pkg>/<Name>.java|.kt`, then Kotlin's package index
// ---------------------------------------------------------------------------

/**
 * Directory `<root>/<pkg...>` when every step exists, else undefined. Each step
 * is a membership test on the parent's memoized listing — one readdir per
 * directory per call however many imports probe it, and exact-case even on a
 * case-insensitive file system.
 */
function packageDirIn(probe: Probe, rootDir: string, pkgSegs: readonly string[]): string | undefined {
  let dir = rootDir;
  for (const seg of pkgSegs) {
    // The workspace root can hold thousands of entries: one stat beats listing it.
    const present = dir === "" ? probe.isDir(seg) : probe.entries(dir).has(seg);
    if (!present) return undefined;
    dir = posixJoin(dir, seg);
  }
  return dir;
}

interface KotlinName {
  name: string;
  kind: string;
}

interface DeclaredNames {
  mtimeMs: number;
  size: number;
  names: KotlinName[];
}

const DECLARED_NAMES_CACHE = new Map<string, DeclaredNames>();

/**
 * Top-level names a Kotlin file declares that a sibling could import or use:
 * classes, objects, aliases, functions and properties — never members, nested
 * types or enum entries (they carry a `container`), and never a `private`
 * declaration (`internal` ones stay: another file of the module sees them).
 */
function kotlinDeclaredNames(probe: Probe, rel: string): readonly KotlinName[] {
  const abs = withinWorkspace(probe.workspace, rel);
  if (abs === undefined || !probe.charge()) return [];
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    return [];
  }
  if (!stat.isFile()) return [];
  const hit = DECLARED_NAMES_CACHE.get(abs);
  if (hit !== undefined && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.names;
  const body = probe.charge() ? readHead(probe.workspace, rel, MAX_INDEX_FILE_BYTES) : undefined;
  let names: KotlinName[] = [];
  if (body !== undefined) {
    const masked = maskNonCode(body, "kotlin", false).split("\n");
    names = declarationsIn(rel, body)
      .filter((d) => d.container === undefined && d.kind !== "member" && d.kind !== "enum-member")
      .filter((d) => d.exported || !/\b(?:private|protected)\b/.test(masked[d.line - 1] ?? ""))
      .map((d) => ({ name: d.symbol, kind: d.kind ?? "" }));
  }
  if (DECLARED_NAMES_CACHE.size >= DECLARED_NAMES_CACHE_LIMIT) {
    const oldest = DECLARED_NAMES_CACHE.keys().next();
    if (!oldest.done) DECLARED_NAMES_CACHE.delete(oldest.value);
  }
  DECLARED_NAMES_CACHE.set(abs, { mtimeMs: stat.mtimeMs, size: stat.size, names });
  return names;
}

interface KotlinDeclaration {
  file: string;
  kind: string;
}

/** name -> first `.kt` file (alphabetical) of package directory `dir` that declares it at top level. */
function kotlinPackageIndex(probe: Probe, dir: string): ReadonlyMap<string, KotlinDeclaration> {
  return probe.ktIndex(dir, () => {
    const index = new Map<string, KotlinDeclaration>();
    const files = [...probe.entries(dir)].filter((name) => name.endsWith(".kt")).sort().slice(0, MAX_INDEX_FILES);
    for (const name of files) {
      const rel = posixJoin(dir, name);
      for (const symbol of kotlinDeclaredNames(probe, rel)) if (!index.has(symbol.name)) index.set(symbol.name, { file: rel, kind: symbol.kind });
    }
    return index;
  });
}

/**
 * The file that declares `name` in package `pkgSegs`: `<Name>.java|.kt` in any
 * root first, then Kotlin top-level declarations. Scanning Kotlin declaration
 * indexes costs file reads per package directory, so an INFERRED same-package
 * lookup (`indexScope` "near") consults only the file's own module; an
 * explicit import (`"all"`) names a package that exists in few directories.
 */
function findTypeFile(ctx: Ctx, pkgSegs: readonly string[], name: string, byFileName = true, indexScope: "near" | "all" = "all"): string | undefined {
  const probe = ctx.probe;
  if (byFileName) {
    for (const root of rootsOf(ctx)) {
      const dir = packageDirIn(probe, root.dir, pkgSegs);
      if (dir === undefined) continue;
      const names = probe.entries(dir);
      for (const ext of [".java", ".kt"]) {
        if (names.has(`${name}${ext}`)) return posixJoin(dir, `${name}${ext}`);
      }
    }
  }
  for (const root of indexScope === "near" ? nearRoots(ctx) : rootsOf(ctx)) {
    const dir = packageDirIn(probe, root.dir, pkgSegs);
    if (dir === undefined) continue;
    const hit = kotlinPackageIndex(probe, dir).get(name);
    if (hit !== undefined) return hit.file;
  }
  return undefined;
}

/** The `.kt` file declaring the top-level function/property `name` (of one of `kinds`) in the importer's own package. */
function kotlinSamePackageValue(ctx: Ctx, name: string, kinds: ReadonlySet<string>): string | undefined {
  const probe = ctx.probe;
  const accept = (dir: string): string | undefined => {
    const hit = kotlinPackageIndex(probe, dir).get(name);
    return hit !== undefined && kinds.has(hit.kind) ? hit.file : undefined;
  };
  if (ctx.ownRoot !== undefined) {
    for (const root of nearRoots(ctx)) {
      const dir = packageDirIn(probe, root.dir, ctx.pkgSegs);
      const hit = dir === undefined ? undefined : accept(dir);
      if (hit !== undefined) return hit;
    }
    if (ctx.dirSpellsPackage) return undefined;
  }
  return accept(posixDirname(ctx.file));
}

// ---------------------------------------------------------------------------
// Statements and used names
// ---------------------------------------------------------------------------

interface ImportStmt {
  line: number;
  segments: string[];
  isStatic: boolean;
  wildcard: boolean;
  alias?: string;
}

const IMPORT_STMT_RE = /(?:^|;)[ \t]*import[ \t]+(static[ \t]+)?([A-Za-z_$][\w$]*(?:[ \t]*\.[ \t]*(?:[A-Za-z_$][\w$]*|\*))*)(?:[ \t]+as[ \t]+([A-Za-z_$][\w$]*))?/g;
const PACKAGE_RE = /^[ \t]*package[ \t]+([A-Za-z_$][\w$]*(?:[ \t]*\.[ \t]*[A-Za-z_$][\w$]*)*)/;

function parseImportStatements(masked: readonly string[]): ImportStmt[] {
  const out: ImportStmt[] = [];
  for (let i = 0; i < masked.length && out.length < MAX_PARSED_IMPORTS; i++) {
    const line = masked[i]!;
    if (!line.includes("import")) continue;
    for (const m of line.matchAll(IMPORT_STMT_RE)) {
      const parts = m[2]!.split(".").map((s) => s.trim());
      const wildcard = parts[parts.length - 1] === "*";
      if (wildcard) parts.pop();
      if (parts.length === 0 || parts.some((p) => p.length === 0)) continue;
      out.push({ line: i + 1, segments: parts, isStatic: m[1] !== undefined, wildcard, alias: m[3] });
    }
  }
  return out;
}

function packageOfLines(masked: readonly string[]): string[] | undefined {
  for (let i = 0; i < masked.length && i < 400; i++) {
    const m = PACKAGE_RE.exec(masked[i]!);
    if (m?.[1]) return m[1].split(".").map((s) => s.trim());
  }
  return undefined;
}

const TYPE_DECL_RE = /\b(?:class|interface|enum|record|object|typealias)[ \t]+([A-Za-z_$][\w$]*)/g;
const PASCAL_USE_RE = /(?<![\w$])[A-Z][A-Za-z0-9]+(?![\w$])/g;

/** PascalCase identifiers the body uses as code, first-use order, with their first line; import/package lines excluded. */
function collectUsedTypeNames(masked: readonly string[], excluded: ReadonlySet<string>): Array<{ name: string; line: number }> {
  const seen = new Set<string>();
  const out: Array<{ name: string; line: number }> = [];
  for (let i = 0; i < masked.length && out.length < MAX_USED_NAMES; i++) {
    const line = masked[i]!;
    if (/^\s*(?:import|package)\b/.test(line)) continue;
    for (const m of line.matchAll(PASCAL_USE_RE)) {
      const name = m[0];
      if (seen.has(name) || excluded.has(name) || followsMemberDot(masked, i, m.index!)) continue;
      seen.add(name);
      out.push({ name, line: i + 1 });
      if (out.length >= MAX_USED_NAMES) break;
    }
  }
  return out;
}

const KOTLIN_KEYWORDS = new Set([
  "if", "for", "while", "when", "catch", "super", "this", "return", "constructor", "init", "do", "else", "try", "object",
  "class", "interface", "fun", "val", "var", "is", "in", "as", "throw", "typeof", "by", "get", "set", "where",
]);
// A member-access `.` before the name is decided by followsMemberDot (which also sees `x. name` and a dot ending the previous line).
const KOTLIN_CALL_RE = /(?<![\w$@:])([a-z_][A-Za-z0-9_]{2,})(?:<[^<>()\n]{0,40}>)?[ \t]*\(/g;
const KOTLIN_CONSTANT_RE = /(?<![\w$@:])([A-Z][A-Z0-9]*_[A-Z0-9_]*)(?![\w$])/g;

/** Longest line the Kotlin value-use heuristics read (generated tables and minified data are skipped). */
const MAX_HEURISTIC_LINE = 2000;
/** Characters of a class header scanned for its body (`class A<T>(…) : Base<T>() where … {`). */
const MAX_CLASS_HEADER_CHARS = 600;
/** Class-like keywords examined per file; a generated file beyond it is treated as inheriting throughout (calls are then skipped, the safe direction). */
const MAX_CLASS_KEYWORDS = 2000;
const KOTLIN_TYPE_KEYWORD_RE = /(?<![\w$.:@])(?:class|interface|object)(?![\w$])/g;

/** The header of a class-like declaration goes on past the newline at `newline`: a trailing `,`/`:`, or a next line opening with `:`/`,`/`{`/`)`/`where`. */
function headerContinues(text: string, newline: number): boolean {
  let before = newline - 1;
  while (before >= 0 && (text.charCodeAt(before) === 32 || text.charCodeAt(before) === 9 || text.charCodeAt(before) === 13)) before--;
  const prev = before >= 0 ? text[before] : "";
  if (prev === "," || prev === ":" || prev === "&") return true;
  let after = newline + 1;
  while (after < text.length && /\s/.test(text[after]!)) after++;
  const next = text[after];
  return next === ":" || next === "," || next === "{" || next === ")" || text.startsWith("where", after);
}

/**
 * Where the class-like header that starts at `from` (just past a `class`,
 * `interface` or `object` keyword) opens its body, and whether it names a
 * supertype (a `:` outside every bracket). Undefined for a bodiless
 * declaration (`data class P(val x: Int)`, `interface Marker`).
 */
function classBodyOpening(text: string, from: number): { open: number; inheriting: boolean } | undefined {
  let depth = 0;
  let inheriting = false;
  const end = Math.min(text.length, from + MAX_CLASS_HEADER_CHARS);
  for (let i = from; i < end; i++) {
    const c = text.charCodeAt(i);
    if (c === 40 || c === 91 || c === 60) depth++; // ( [ <
    else if (c === 41 || c === 93) depth = Math.max(0, depth - 1); // ) ]
    else if (c === 62) {
      if (text.charCodeAt(i - 1) !== 45) depth = Math.max(0, depth - 1); // > (`->` is not a bracket)
    } else if (depth === 0) {
      if (c === 123) return { open: i, inheriting };
      if (c === 58) inheriting = true;
      else if (c === 59 || c === 61) return undefined; // `;` or `=`: not a class body
      else if (c === 10 && !headerContinues(text, i)) return undefined;
    }
  }
  return undefined;
}

/**
 * Disjoint half-open character ranges of the class-like bodies (`class`,
 * `interface`, `object`, object expressions) whose header names a supertype.
 * A bare `name(` call inside one may resolve to a member INHERITED from that
 * supertype, which Kotlin prefers to a top-level function, so it says nothing
 * about the package's top-level `name`.
 */
function inheritingBodyRanges(text: string): Array<[number, number]> {
  const inheritingOpens = new Set<number>();
  let keywords = 0;
  for (const m of text.matchAll(KOTLIN_TYPE_KEYWORD_RE)) {
    if (++keywords > MAX_CLASS_KEYWORDS) return [[0, text.length]];
    const header = classBodyOpening(text, m.index! + m[0].length);
    if (header?.inheriting) inheritingOpens.add(header.open);
  }
  if (inheritingOpens.size === 0) return [];
  const ranges: Array<[number, number]> = [];
  const stack: Array<{ start: number; inheriting: boolean }> = [];
  for (const m of text.matchAll(/[{}]/g)) {
    if (m[0] === "{") stack.push({ start: m.index!, inheriting: inheritingOpens.has(m.index!) });
    else {
      const top = stack.pop();
      if (top?.inheriting) ranges.push([top.start, m.index! + 1]);
    }
  }
  for (const open of stack) if (open.inheriting) ranges.push([open.start, text.length]); // a served slice may cut the body off
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last !== undefined && range[0] < last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  return merged;
}

function inRanges(ranges: ReadonlyArray<readonly [number, number]>, offset: number): boolean {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [start, end] = ranges[mid]!;
    if (offset < start) hi = mid - 1;
    else if (offset >= end) lo = mid + 1;
    else return true;
  }
  return false;
}

/**
 * Lowercase function calls and UPPER_SNAKE constants a Kotlin body uses that
 * it does not declare or bind itself (`fun`/`val`/`var`, parameters `name:`,
 * lambda parameters), never selectors (`x.name(`, `this.name(`, `x?.name(`) or
 * callable references, and — for calls — never inside a class body that
 * inherits (the call may be an inherited member). First-use order with the line.
 */
function collectKotlinValueUses(masked: readonly string[], imported: ReadonlySet<string>): Array<{ name: string; line: number; constant: boolean }> {
  const own = new Set<string>(imported); // an explicit import shadows a same-package declaration
  for (const line of masked) {
    if (line.length > MAX_HEURISTIC_LINE) continue;
    for (const m of line.matchAll(/\b(?:fun|val|var)\s+(?:<[^>\n]*>\s*)?(?:[\w.<>?]+\.)?([A-Za-z_]\w*)/g)) own.add(m[1]!);
    for (const m of line.matchAll(/\b([A-Za-z_]\w*)[ \t]*:(?!:)/g)) own.add(m[1]!);
    // Lambda parameters: `{ log -> … }`, `{ a, b: Int -> … }`.
    for (let at = line.indexOf("->"); at >= 0; at = line.indexOf("->", at + 2)) {
      const open = line.lastIndexOf("{", at);
      if (open < 0 || at - open > 200) continue;
      const segment = line.slice(open + 1, at);
      if (/[{}=;]/.test(segment)) continue;
      for (const m of segment.matchAll(/[A-Za-z_]\w*/g)) own.add(m[0]);
    }
  }
  const ranges = inheritingBodyRanges(masked.join("\n"));
  const seen = new Set<string>();
  const out: Array<{ name: string; line: number; constant: boolean }> = [];
  let lineStart = 0;
  for (let i = 0; i < masked.length && out.length < MAX_USED_NAMES; lineStart += masked[i]!.length + 1, i++) {
    const line = masked[i]!;
    if (line.length > MAX_HEURISTIC_LINE || /^\s*(?:import|package)\b/.test(line)) continue;
    for (const [re, constant] of [[KOTLIN_CALL_RE, false], [KOTLIN_CONSTANT_RE, true]] as const) {
      for (const m of line.matchAll(re)) {
        const name = m[1]!;
        if (seen.has(name) || own.has(name) || (!constant && KOTLIN_KEYWORDS.has(name))) continue;
        if (followsMemberDot(masked, i, m.index!)) continue; // `x. name(` or a dot at the end of the previous line
        if (!constant && /\bfun\s+(?:<[^>\n]*>\s*)?(?:[\w.<>?]+\.)?$/.test(line.slice(0, m.index!))) continue; // a declaration head
        if (!constant && ranges.length > 0 && inRanges(ranges, lineStart + m.index!)) continue; // possibly an inherited member
        seen.add(name);
        out.push({ name, line: i + 1, constant });
      }
    }
  }
  return out;
}

function typeNamesDeclaredIn(masked: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const line of masked) {
    if (!/\b(?:class|interface|enum|record|object|typealias)\b/.test(line)) continue;
    for (const m of line.matchAll(TYPE_DECL_RE)) out.add(m[1]!);
  }
  return out;
}

/**
 * The identifier at column `col` of line `row` follows a member-access `.`
 * (`x.name`, `x. name`, and — after a line break — `x.` newline `name`), so it
 * names a member, never a top-level or same-package declaration. `..`/`...`
 * (ranges, varargs) are not member access.
 */
function followsMemberDot(lines: readonly string[], row: number, col: number): boolean {
  let line = lines[row]!;
  let c = col - 1;
  for (let hops = 0; hops < 8; hops++) {
    while (c >= 0 && (line.charCodeAt(c) === 32 || line.charCodeAt(c) === 9)) c--;
    if (c >= 0) return line.charCodeAt(c) === 46 && (c === 0 || line.charCodeAt(c - 1) !== 46);
    if (--row < 0) return false;
    line = lines[row]!;
    c = line.length - 1;
  }
  return false;
}

/** A file that exists to test something: never offered to a main-code importer as an INFERRED neighbour. */
function isTestFileName(file: string): boolean {
  return TEST_FILE_NAME_RE.test(stemOf(file));
}

// ---------------------------------------------------------------------------
// Resolution of statements
// ---------------------------------------------------------------------------

const PASCAL_START_RE = /^[A-Z]/;

/**
 * Resolve the type an `import` names: the longest prefix of the dotted name
 * (`a.b.Outer.Inner.m` peels `m`, then `Inner`, …) that is a type declared in
 * a visible source root. A static import starts one segment earlier (its last
 * segment is a member).
 */
function resolveTypeOfImport(ctx: Ctx, stmt: ImportStmt): { file: string; typeIndex: number } | undefined {
  const segs = stmt.segments;
  const n = segs.length;
  const start = stmt.isStatic && !stmt.wildcard ? n - 1 : n;
  for (let k = start; k >= 1; k--) {
    const name = segs[k - 1]!;
    const pascal = PASCAL_START_RE.test(name);
    // Kotlin imports top-level functions and properties by their (lowercase) name.
    const kotlinMember = !pascal && ctx.kotlin && k === n && !stmt.isStatic && !stmt.wildcard;
    if (!pascal && !kotlinMember) break;
    const file = findTypeFile(ctx, segs.slice(0, k - 1), name, pascal);
    if (file !== undefined && file !== ctx.file) return { file, typeIndex: k - 1 };
  }
  return undefined;
}

function importEdge(ctx: Ctx, stmt: ImportStmt): ResolvedImport | undefined {
  const hit = resolveTypeOfImport(ctx, stmt);
  if (hit === undefined) return undefined;
  const names = uniqueNames([...stmt.segments.slice(hit.typeIndex), ...(stmt.alias !== undefined ? [stmt.alias] : [])]);
  return { path: hit.file, line: stmt.line, kind: "import", names };
}

/**
 * The file declaring `name` in the importer's own package: the package
 * directory of every visible root (a test class reaches the main class it
 * exercises) and, when the file's directory does not spell its package, the
 * file's own directory too (its neighbours are the best-known package peers).
 */
function samePackageFile(ctx: Ctx, name: string): string | undefined {
  if (ctx.ownRoot !== undefined) {
    const hit = findTypeFile(ctx, ctx.pkgSegs, name, true, "near");
    if (hit !== undefined || ctx.dirSpellsPackage) return hit;
  }
  const dir = posixDirname(ctx.file);
  const entries = ctx.probe.entries(dir);
  for (const ext of [".java", ".kt"]) if (entries.has(`${name}${ext}`)) return posixJoin(dir, `${name}${ext}`);
  return kotlinPackageIndex(ctx.probe, dir).get(name)?.file;
}

/**
 * The guarantee "never outside the workspace" holds through symlinks too: an
 * edge whose REAL location (a symlinked directory or file pointing out of the
 * tree) lies outside the workspace is dropped. `realPathInside` caches its
 * verdicts, so warm calls pay one map lookup per edge.
 */
function insideWorkspace(workspace: string, edges: ResolvedImport[]): ResolvedImport[] {
  return edges.filter((edge) => realPathInside(workspace, edge.path));
}

function resolveJvmImportsUnchecked(workspace: string, filePath: string, lines: readonly string[]): ResolvedImport[] {
  const file = filePath.replace(/\\/g, "/");
  const ext = path.posix.extname(file).toLowerCase();
  const kotlin = ext === ".kt" || ext === ".kts";
  const script = ext === ".kts";
  const mode: MaskMode = kotlin ? "kotlin" : "java";
  const masked = maskNonCode(lines.join("\n").replace(/^\uFEFF/, ""), mode, false).split("\n");
  const statements = parseImportStatements(masked);

  // Names the body uses as code that no explicit import or own declaration accounts for.
  const bound = new Set<string>();
  for (const stmt of statements) if (!stmt.wildcard) bound.add(stmt.alias ?? stmt.segments[stmt.segments.length - 1]!);
  const excluded = new Set<string>([...bound, ...typeNamesDeclaredIn(masked)]);
  const used = script ? [] : collectUsedTypeNames(masked, excluded);
  // Kotlin siblings also call each other's top-level functions and constants: a file with no import and no type name can still have those.
  const kotlinUses = kotlin && !script ? collectKotlinValueUses(masked, bound) : [];
  if (statements.length === 0 && used.length === 0 && kotlinUses.length === 0) return [];

  const probe = new Probe(workspace);
  let pkg = script ? undefined : packageOfLines(masked);
  if (pkg === undefined && !script) {
    // A served slice may not hold the `package` line: read the file's head.
    const head = readHead(workspace, file, 16 * 1024);
    if (head !== undefined) pkg = packageOfLines(maskNonCode(head, mode, false).split("\n"));
  }
  const ctx = createContext(probe, file, kotlin, script, pkg ?? []);

  const imports: ResolvedImport[] = [];
  const packageWildcards: ImportStmt[] = [];
  for (const stmt of statements.slice(0, MAX_STATEMENTS)) {
    if (!stmt.wildcard) {
      const edge = importEdge(ctx, stmt);
      if (edge !== undefined) imports.push(edge);
      continue;
    }
    // `import a.b.C.*` / `import static a.b.C.*` name a type; `import a.b.*` a package.
    const hit = resolveTypeOfImport(ctx, stmt);
    if (hit !== undefined) imports.push({ path: hit.file, line: stmt.line, kind: "import", names: uniqueNames(stmt.segments.slice(hit.typeIndex)) });
    else if (!stmt.isStatic && !PASCAL_START_RE.test(stmt.segments[stmt.segments.length - 1]!)) packageWildcards.push(stmt);
  }

  // Same-file references group their names (Kotlin keeps many types in one file); wildcard edges group per statement and file.
  const references = new Map<string, ResolvedImport>();
  const wildcardEdges = new Map<string, ResolvedImport>();
  const perWildcard = new Map<ImportStmt, number>();
  for (const use of used) {
    if (references.size >= MAX_REFERENCES && packageWildcards.length === 0) break;
    const samePackage = samePackageFile(ctx, use.name);
    if (samePackage !== undefined) {
      // The same package wins over an on-demand import (JLS 6.4.1); a used name it declares is a reference.
      if (samePackage === file || (!ctx.isTest && isTestFileName(samePackage))) continue;
      const existing = references.get(samePackage);
      if (existing !== undefined) {
        if (existing.names.length < MAX_NAMES_PER_EDGE) existing.names.push(use.name);
      } else if (references.size < MAX_REFERENCES) references.set(samePackage, { path: samePackage, line: use.line, kind: "reference", names: [use.name] });
      continue;
    }
    if (packageWildcards.length === 0) continue;
    const providers: Array<{ stmt: ImportStmt; target: string }> = [];
    for (const stmt of packageWildcards) {
      const target = findTypeFile(ctx, stmt.segments, use.name);
      if (target !== undefined) providers.push({ stmt, target });
    }
    if (providers.length !== 1) continue; // nothing provides it, or two wildcards do (ambiguous)
    const { stmt, target } = providers[0]!;
    if (target === file || (!ctx.isTest && isTestFileName(target))) continue;
    const key = `${stmt.line}:${target}`;
    const existing = wildcardEdges.get(key);
    if (existing !== undefined) {
      if (existing.names.length < MAX_NAMES_PER_EDGE) existing.names.push(use.name);
    } else if ((perWildcard.get(stmt) ?? 0) < MAX_WILDCARD_EDGES) {
      perWildcard.set(stmt, (perWildcard.get(stmt) ?? 0) + 1);
      wildcardEdges.set(key, { path: target, line: stmt.line, kind: "import", names: [use.name] });
    }
  }
  if (kotlinUses.length > 0) {
    const callKinds = new Set(["function"]);
    const constantKinds = new Set(["constant", "variable"]);
    for (const use of kotlinUses) {
      if (references.size >= MAX_REFERENCES) break;
      const target = kotlinSamePackageValue(ctx, use.name, use.constant ? constantKinds : callKinds);
      if (target === undefined || target === file || (!ctx.isTest && isTestFileName(target))) continue;
      const existing = references.get(target);
      if (existing !== undefined) {
        if (existing.names.length < MAX_NAMES_PER_EDGE && !existing.names.includes(use.name)) existing.names.push(use.name);
      } else if (references.size < MAX_REFERENCES) references.set(target, { path: target, line: use.line, kind: "reference", names: [use.name] });
    }
  }
  imports.push(...wildcardEdges.values());
  // Statement order: wildcard-derived edges sit at their wildcard's line.
  const ordered = imports.map((edge, index) => ({ edge, index })).sort((a, b) => a.edge.line - b.edge.line || a.index - b.index).map((e) => e.edge);
  // References in first-use order (the type pass and the Kotlin value pass each scan the body top to bottom).
  const referenceEdges = [...references.values()].sort((a, b) => a.line - b.line);
  return [...ordered, ...referenceEdges];
}

/**
 * Java/Kotlin import, wildcard and same-package edges of `filePath`. Total:
 * the neighbour and inventory hooks run inside every pack while their flags
 * are on, so an unforeseen failure here yields no edges instead of failing
 * the pack.
 */
export function resolveJvmImports(workspace: string, filePath: string, lines: readonly string[]): ResolvedImport[] {
  try {
    return insideWorkspace(workspace, resolveJvmImportsUnchecked(workspace, filePath, lines));
  } catch {
    return [];
  }
}
