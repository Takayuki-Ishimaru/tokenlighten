/**
 * importResolvePython.ts — Python import edges for importResolution.ts's
 * dispatcher (consumed by the default-OFF V15-NBR neighbour index and V15-FUI
 * usage inventory). Contract: see importResolution.ts.
 *
 * Coverage (v0.15.0 — projects nested below the workspace root):
 * - Statements found in CODE only: comments, docstrings and strings are
 *   masked first (sfCodeMask.ts), so an import quoted in a docstring or
 *   commented out never becomes an edge. `from a.b import x, y as z`
 *   (single line, parenthesized block, backslash continuation), `import a.b`,
 *   `import a, b.c as d`, `from . import mod`, `from ..pkg import name`, at
 *   any indentation (`try:`, `if TYPE_CHECKING:`, function bodies).
 * - ABSOLUTE imports resolve against import roots, tried in order:
 *   (a) the parent of the topmost package directory holding the file (walk up
 *   while the directory has `__init__.py`); (b) the nearest Python project
 *   root (pyproject.toml/setup.py/setup.cfg/Pipfile) and its `src/`;
 *   (c) the file's own directory — only when that directory is NOT a package
 *   or the file runs as a script (`__name__ == "__main__"`), because Python 3
 *   never resolves a package sibling implicitly: `import logging` next to a
 *   `logging.py` module inside a package stays the standard library — and it
 *   then comes FIRST (sys.path[0]); (d) the workspace root. Those are ALL the
 *   roots: an intermediate directory between the file and the workspace root
 *   is never one (no Python rule puts it on sys.path, and short names such as
 *   `config` or `tasks` there would capture every nested project's imports).
 *   `a.b.c` is `<root>/a/b/c/__init__.py` or `<root>/a/b/c.py`; a module found
 *   under no root (standard library, site-packages) yields nothing. `.pyi`
 *   stubs are a last resort. Not covered: roots set by `sys.path` edits,
 *   PYTHONPATH, a conftest.py/pytest rootdir, `pythonpath`/`package-dir` in
 *   tool configuration other than the `src/` convention.
 * - `from pkg import name`: when `name` is a submodule of `pkg` (a regular or
 *   PEP 420 namespace package directory) the edge goes to that submodule;
 *   otherwise to the module file of `pkg`. One-hop re-export: when that module
 *   re-exports `name` (`from .impl import name`, `… import orig as name`,
 *   `from pkg.impl import name`, or `from .impl import *` where `impl` defines
 *   it, honouring `__all__`) an extra edge goes to the defining module (names
 *   re-exported from one module share one edge).
 *
 * Guarantees: an edge exists only for a file that exists inside the workspace
 * (also after symlink resolution); every scan and read is bounded; parsed
 * modules are cached per absolute path and validated by mtime+size; the entry
 * point never throws.
 */
import * as fs from "fs";
import * as path from "path";
import { type ResolvedImport, posixDirname, posixJoin, uniqueNames, withinWorkspace } from "./importGraphShared.js";
import { maskCommentsAndStrings } from "./sfCodeMask.js";

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

const MAX_SCAN_CHARS = 256 * 1024;
/** `from`/`import` statements examined per file (stdlib and third-party ones count too). */
const MAX_STATEMENTS = 120;
const MAX_REEXPORT_STATEMENTS = 300;
/** A line longer than this is never an import statement (minified or generated code). */
const MAX_STATEMENT_LINE_CHARS = 20_000;
const MAX_RAW_EDGES = 60;
const MAX_REEXPORT_LOOKUPS = 8;
const MAX_STAR_READS = 16;
const MAX_STAR_SPECS_PER_MODULE = 4;
const MAX_READ_BYTES = 1024 * 1024;
const MAX_PACKAGE_DEPTH = 16;
/** Directory levels walked up from a file when looking for its project root (rule b). */
const MAX_PROJECT_ROOT_LEVELS = 16;
const MAX_NAMESPACE_DIRS = 4;
const REAL_PATH_TTL_MS = 10_000;

/** Files whose presence marks the root of a Python project. */
const PYTHON_PROJECT_MARKERS = ["pyproject.toml", "setup.py", "setup.cfg", "Pipfile"];

// ---------------------------------------------------------------------------
// Filesystem primitives (every path goes through withinWorkspace)
// ---------------------------------------------------------------------------

interface Stamp {
  readonly mtimeMs: number;
  readonly size: number;
}

const FORBIDDEN_SEGMENT_RE = /(?:^|\/)(?:node_modules|\.git)(?:\/|$)/;

function join2(dir: string, name: string): string {
  return dir === "" ? name : `${dir}/${name}`;
}

function escapesWorkspace(rel: string): boolean {
  return rel === ".." || rel.startsWith("../") || rel.startsWith("/") || /^[A-Za-z]:/.test(rel);
}

function statEntry(workspace: string, rel: string): { abs: string; isFile: boolean; isDirectory: boolean; stamp: Stamp } | undefined {
  if (FORBIDDEN_SEGMENT_RE.test(rel)) return undefined;
  const abs = withinWorkspace(workspace, rel);
  if (abs === undefined) return undefined;
  try {
    const st = fs.statSync(abs, { throwIfNoEntry: false });
    if (st === undefined) return undefined;
    return { abs, isFile: st.isFile(), isDirectory: st.isDirectory(), stamp: { mtimeMs: st.mtimeMs, size: st.size } };
  } catch {
    return undefined;
  }
}

const realRoots = new Map<string, string>();
const realPathVerdicts = new Map<string, { ok: boolean; at: number }>();

function realWorkspaceRoot(workspace: string): string | undefined {
  const known = realRoots.get(workspace);
  if (known !== undefined) return known;
  try {
    const real = fs.realpathSync.native(workspace);
    if (realRoots.size >= 16) realRoots.clear();
    realRoots.set(workspace, real);
    return real;
  } catch {
    return undefined;
  }
}

/** True when `abs` still lies inside the workspace after symlinks are resolved. */
function isInsideRealWorkspace(workspace: string, abs: string): boolean {
  const key = `${workspace}|${abs}`;
  const now = Date.now();
  const known = realPathVerdicts.get(key);
  if (known !== undefined && now - known.at < REAL_PATH_TTL_MS) return known.ok;
  let ok = false;
  const root = realWorkspaceRoot(workspace);
  if (root !== undefined) {
    try {
      const real = fs.realpathSync.native(abs);
      ok = real === root || real.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);
    } catch {
      ok = false;
    }
  }
  if (realPathVerdicts.size >= 2000) realPathVerdicts.clear();
  realPathVerdicts.set(key, { ok, at: now });
  return ok;
}

function realInsideRel(workspace: string, rel: string): boolean {
  const abs = withinWorkspace(workspace, rel);
  return abs !== undefined && isInsideRealWorkspace(workspace, abs);
}

class StampedCache<T> {
  private readonly entries = new Map<string, { readonly stamp: Stamp; readonly value: T }>();

  constructor(private readonly limit: number) {}

  get(key: string, stamp: Stamp): { value: T } | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.stamp.mtimeMs !== stamp.mtimeMs || entry.stamp.size !== stamp.size) return undefined;
    return { value: entry.value };
  }

  set(key: string, stamp: Stamp, value: T): void {
    if (this.entries.size >= this.limit && !this.entries.has(key)) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { stamp, value });
  }

  clear(): void {
    this.entries.clear();
  }
}

// ---------------------------------------------------------------------------
// Per-call state
// ---------------------------------------------------------------------------

interface PyRun {
  readonly workspace: string;
  readonly files: Map<string, boolean>;
  readonly directories: Map<string, boolean>;
  readonly topLevel: Map<string, boolean>;
  readonly roots: Map<string, string[]>;
  lookups: number;
  starReads: number;
}

function newRun(workspace: string): PyRun {
  return { workspace, files: new Map(), directories: new Map(), topLevel: new Map(), roots: new Map(), lookups: 0, starReads: 0 };
}

function isFile(run: PyRun, rel: string): boolean {
  const known = run.files.get(rel);
  if (known !== undefined) return known;
  const ok = statEntry(run.workspace, rel)?.isFile === true;
  run.files.set(rel, ok);
  return ok;
}

function isDirectory(run: PyRun, rel: string): boolean {
  if (rel === "") return true;
  const known = run.directories.get(rel);
  if (known !== undefined) return known;
  const ok = statEntry(run.workspace, rel)?.isDirectory === true;
  run.directories.set(rel, ok);
  return ok;
}

// ---------------------------------------------------------------------------
// Statement scan (code only)
// ---------------------------------------------------------------------------

interface PyItem {
  readonly name: string;
  readonly alias: string | undefined;
}

interface PyFromStatement {
  readonly kind: "from";
  readonly line: number;
  /** Module text as written: leading dots for a relative import. */
  readonly module: string;
  readonly items: readonly PyItem[];
  readonly star: boolean;
}

interface PyImportStatement {
  readonly kind: "import";
  readonly line: number;
  readonly modules: ReadonlyArray<{ readonly dotted: string; readonly alias: string | undefined }>;
}

type PyStatement = PyFromStatement | PyImportStatement;

// The module is leading dots then an optional dotted name (never both alternatives at once: no backtracking blow-up).
const PY_FROM_RE = /^[ \t]*from[ \t]+(\.*(?:[A-Za-z_][\w.]*)?)[ \t]+import\b[ \t]*(.*)$/;
const PY_IMPORT_RE = /^[ \t]*import[ \t]+(.+)$/;
const PY_ITEM_RE = /^([A-Za-z_]\w*)(?:\s+as\s+([A-Za-z_]\w*))?$/;
const PY_MODULE_ITEM_RE = /^([A-Za-z_][\w.]*)(?:\s+as\s+([A-Za-z_]\w*))?$/;

/** The text after `import` of a `from` statement: a parenthesized block or backslash continuation is joined. */
function fromTail(lines: readonly string[], index: number, tail: string): string {
  let text = tail;
  if (text.includes("(") && !text.includes(")")) {
    for (let i = index + 1; i < lines.length && i <= index + 60; i++) {
      text += ` ${lines[i]!}`;
      if (lines[i]!.includes(")")) break;
    }
  } else if (/\\\s*$/.test(text)) {
    for (let i = index + 1; i < lines.length && i <= index + 20; i++) {
      text += ` ${lines[i]!}`;
      if (!/\\\s*$/.test(lines[i]!)) break;
    }
  }
  return text;
}

function parseItems(text: string): { items: PyItem[]; star: boolean } {
  const items: PyItem[] = [];
  let star = false;
  for (const part of text.replace(/[()\\]/g, " ").split(",")) {
    const cleaned = part.trim();
    if (cleaned === "") continue;
    if (cleaned === "*") {
      star = true;
      continue;
    }
    const m = PY_ITEM_RE.exec(cleaned);
    if (m !== null) items.push({ name: m[1]!, alias: m[2] });
  }
  return { items, star };
}

/** Import statements of comment/string-masked `lines`, in order (≤ `limit`). */
function parseStatements(lines: readonly string[], limit: number): PyStatement[] {
  const out: PyStatement[] = [];
  for (let i = 0; i < lines.length && out.length < limit; i++) {
    const line = lines[i]!;
    if (line.length > MAX_STATEMENT_LINE_CHARS || !line.includes("import")) continue;
    for (const segment of line.includes(";") ? line.split(";") : [line]) {
      const from = PY_FROM_RE.exec(segment);
      if (from !== null && from[1]) {
        const { items, star } = parseItems(fromTail(lines, i, from[2] ?? ""));
        out.push({ kind: "from", line: i + 1, module: from[1], items, star });
        continue;
      }
      const imp = PY_IMPORT_RE.exec(segment);
      if (imp !== null) {
        const modules: Array<{ dotted: string; alias: string | undefined }> = [];
        for (const part of imp[1]!.split(",")) {
          const m = PY_MODULE_ITEM_RE.exec(part.trim());
          if (m !== null) modules.push({ dotted: m[1]!, alias: m[2] });
        }
        if (modules.length > 0) out.push({ kind: "import", line: i + 1, modules });
      }
    }
  }
  return out;
}

function maskedLines(text: string): string[] {
  return maskCommentsAndStrings(text).split("\n");
}

// ---------------------------------------------------------------------------
// Import roots
// ---------------------------------------------------------------------------

/**
 * Directories an absolute import may resolve against for a file in `fileDir`,
 * in order: (a) the parent of the topmost package directory holding the file;
 * (b) the nearest Python project root and its `src/`; (c) the file's own
 * directory; (d) the workspace root. (c) is skipped inside a package — Python
 * never puts a package directory on the search path — unless the file runs as
 * a script (`__name__ == "__main__"`), whose own directory is `sys.path[0]`
 * whatever it holds, and then it comes first. No other ancestor is a root.
 */
function importRootsFor(run: PyRun, fileDir: string, runsAsScript: boolean): string[] {
  const memoKey = runsAsScript ? `${fileDir}|script` : fileDir;
  const known = run.roots.get(memoKey);
  if (known !== undefined) return known;
  const roots: string[] = [];
  const push = (root: string | undefined): void => {
    if (root !== undefined && !roots.includes(root)) roots.push(root);
  };
  const inPackage = isFile(run, join2(fileDir, "__init__.py"));
  if (runsAsScript) push(fileDir);
  if (inPackage) {
    // (a) the parent of the topmost package directory
    let top = fileDir;
    for (let i = 0; i < MAX_PACKAGE_DEPTH; i++) {
      if (top === "") break; // the workspace root is itself a package: its parent is outside
      const parent = posixDirname(top);
      if (isFile(run, join2(parent, "__init__.py"))) {
        top = parent;
        continue;
      }
      push(parent);
      break;
    }
  } else {
    // (c) a script directory: its own directory comes first
    push(fileDir);
  }
  // (b) the nearest Python project root, then its src/
  let dir = fileDir;
  for (let i = 0; i < MAX_PROJECT_ROOT_LEVELS; i++) {
    if (PYTHON_PROJECT_MARKERS.some((marker) => isFile(run, join2(dir, marker)))) {
      push(dir);
      push(join2(dir, "src"));
      break;
    }
    if (dir === "") break;
    dir = posixDirname(dir);
  }
  // (d) the workspace root. No other ancestor is a root: no Python rule puts an intermediate directory on sys.path,
  // and a short name (`config`, `tasks`) in one must not capture the imports of every project below it.
  push("");
  run.roots.set(memoKey, roots);
  return roots;
}

// ---------------------------------------------------------------------------
// Module location
// ---------------------------------------------------------------------------

interface Located {
  /** The module's file (`__init__.py`, `x.py` or a last-resort stub); undefined for a namespace directory. */
  readonly file: string | undefined;
  /** Directories that hold the module's submodules (a package directory, or a namespace package's portions). */
  readonly packageDirs: readonly string[];
}

/** True when `<root>/<first>` could start a module: a directory, `first.py` or `first.pyi`. */
function topLevelPresent(run: PyRun, root: string, first: string): boolean {
  const key = `${root}|${first}`;
  const known = run.topLevel.get(key);
  if (known !== undefined) return known;
  const ok = isDirectory(run, join2(root, first)) || isFile(run, join2(root, `${first}.py`)) || isFile(run, join2(root, `${first}.pyi`));
  run.topLevel.set(key, ok);
  return ok;
}

/**
 * True when every parent component of `parts` under `root` is something a
 * submodule can live in: a regular package, or a namespace directory. A parent
 * that is a plain module (`a.py`, with no `a/__init__.py`) is not a package,
 * even when a directory `a/` sits beside it (CPython picks the module).
 */
function parentsAreImportable(run: PyRun, root: string, parts: readonly string[]): boolean {
  let prefix = root;
  for (let i = 0; i < parts.length - 1; i++) {
    prefix = join2(prefix, parts[i]!);
    if (isFile(run, join2(prefix, "__init__.py"))) continue;
    if (isFile(run, `${prefix}.py`) || isFile(run, `${prefix}.pyi`) || !isDirectory(run, prefix)) return false;
  }
  return true;
}

/**
 * The module `dotted` under the first root that holds it: a regular package
 * (`__init__.py`) or module (`.py`) first, across all roots; then a PEP 420
 * namespace directory; `.pyi` stubs only when nothing else matched. `dotted`
 * "" names the package at `roots[0]` itself (`from . import x`).
 */
function locateModule(run: PyRun, roots: readonly string[], dotted: string): Located | undefined {
  if (dotted === "") {
    const base = roots[0]!;
    const init = join2(base, "__init__.py");
    return { file: isFile(run, init) ? init : undefined, packageDirs: [base] };
  }
  const parts = dotted.split(".");
  const rel = parts.join("/");
  const candidates = roots.filter((root) => topLevelPresent(run, root, parts[0]!));
  if (candidates.length === 0) return undefined;
  for (const root of candidates) {
    const base = posixJoin(root, rel);
    if (escapesWorkspace(base)) continue;
    const init = join2(base, "__init__.py");
    if (isFile(run, init) && parentsAreImportable(run, root, parts)) return { file: init, packageDirs: [base] };
    if (isFile(run, `${base}.py`) && parentsAreImportable(run, root, parts)) return { file: `${base}.py`, packageDirs: [] };
  }
  const namespaceDirs: string[] = [];
  for (const root of candidates) {
    const base = posixJoin(root, rel);
    if (escapesWorkspace(base) || namespaceDirs.length >= MAX_NAMESPACE_DIRS) continue;
    // a module file of the same name shadows a namespace directory
    if (isDirectory(run, base) && !isFile(run, `${base}.py`) && parentsAreImportable(run, root, parts)) namespaceDirs.push(base);
  }
  if (namespaceDirs.length > 0) return { file: undefined, packageDirs: namespaceDirs };
  for (const root of candidates) {
    const base = posixJoin(root, rel);
    if (escapesWorkspace(base) || !parentsAreImportable(run, root, parts)) continue;
    const init = join2(base, "__init__.pyi");
    if (isFile(run, init)) return { file: init, packageDirs: [] };
    if (isFile(run, `${base}.pyi`)) return { file: `${base}.pyi`, packageDirs: [] };
  }
  return undefined;
}

/** `name` as a submodule of one of `packageDirs` (`name/__init__.py` or `name.py`). */
function findSubmodule(run: PyRun, packageDirs: readonly string[], name: string): string | undefined {
  for (const dir of packageDirs) {
    const init = join2(dir, `${name}/__init__.py`);
    if (isFile(run, init)) return init;
    const module = join2(dir, `${name}.py`);
    if (isFile(run, module)) return module;
  }
  return undefined;
}

/** Roots and dotted module of a `from` module text: `.x.y` relative to the file's package, `a.b` absolute. */
function rootsAndModule(run: PyRun, importer: string, moduleText: string, runsAsScript = false): { roots: string[]; dotted: string } | undefined {
  const dots = /^(\.*)(.*)$/.exec(moduleText)!;
  const level = dots[1]!.length;
  const fileDir = posixDirname(importer);
  if (level === 0) return { roots: importRootsFor(run, fileDir, runsAsScript), dotted: moduleText };
  let base = fileDir;
  for (let i = 1; i < level; i++) {
    if (base === "") return undefined; // climbs above the workspace root
    base = posixDirname(base);
  }
  return { roots: [base], dotted: dots[2]! };
}

// ---------------------------------------------------------------------------
// One-hop re-exports
// ---------------------------------------------------------------------------

interface PyReexports {
  /** Exported name → the `from` module text and the name there. */
  readonly named: ReadonlyMap<string, { readonly module: string; readonly orig: string }>;
  /** `from x import *` module texts. */
  readonly stars: readonly string[];
}

interface PySurface {
  /** Top-level `def`/`class`/assignment names. */
  readonly names: ReadonlySet<string>;
  /** Names listed in `__all__`, when the module defines one. */
  readonly all: ReadonlySet<string> | undefined;
}

const reexportCache = new StampedCache<PyReexports | undefined>(256);
const surfaceCache = new StampedCache<PySurface | undefined>(256);

function readModule(run: PyRun, rel: string): { text: string } | undefined {
  const st = statEntry(run.workspace, rel);
  if (st === undefined || !st.isFile || st.stamp.size > MAX_READ_BYTES || !isInsideRealWorkspace(run.workspace, st.abs)) return undefined;
  try {
    return { text: fs.readFileSync(st.abs, "utf8") };
  } catch {
    return undefined;
  }
}

function reexportsOf(run: PyRun, rel: string): PyReexports | undefined {
  const st = statEntry(run.workspace, rel);
  if (st === undefined || !st.isFile) return undefined;
  const key = `${run.workspace}|${st.abs}`;
  const hit = reexportCache.get(key, st.stamp);
  if (hit !== undefined) return hit.value;
  const source = readModule(run, rel);
  let value: PyReexports | undefined;
  if (source !== undefined) {
    const named = new Map<string, { module: string; orig: string }>();
    const stars: string[] = [];
    const text = source.text.length > MAX_SCAN_CHARS ? source.text.slice(0, MAX_SCAN_CHARS) : source.text;
    for (const st2 of parseStatements(maskedLines(text), MAX_REEXPORT_STATEMENTS)) {
      if (st2.kind !== "from") continue;
      if (st2.star && stars.length < MAX_STAR_SPECS_PER_MODULE) stars.push(st2.module);
      for (const item of st2.items) named.set(item.alias ?? item.name, { module: st2.module, orig: item.name });
    }
    value = { named, stars };
  }
  reexportCache.set(key, st.stamp, value);
  return value;
}

function surfaceOf(run: PyRun, rel: string): PySurface | undefined {
  const st = statEntry(run.workspace, rel);
  if (st === undefined || !st.isFile) return undefined;
  const key = `${run.workspace}|${st.abs}`;
  const hit = surfaceCache.get(key, st.stamp);
  if (hit !== undefined) return hit.value;
  const source = readModule(run, rel);
  let value: PySurface | undefined;
  if (source !== undefined) {
    const text = source.text.length > MAX_SCAN_CHARS ? source.text.slice(0, MAX_SCAN_CHARS) : source.text;
    const masked = maskCommentsAndStrings(text);
    const names = new Set<string>();
    for (const m of masked.matchAll(/^(?:async[ \t]+)?def[ \t]+([A-Za-z_]\w*)|^class[ \t]+([A-Za-z_]\w*)|^([A-Za-z_]\w*)[ \t]*(?::[^=\n]+)?=(?!=)/gm)) {
      names.add(m[1] ?? m[2] ?? m[3]!);
    }
    let all: Set<string> | undefined;
    for (const m of masked.matchAll(/^__all__[ \t]*\+?=[ \t]*[[(]/gm)) {
      const open = m.index + m[0].length;
      const close = masked.slice(open).search(/[\])]/);
      // the strings are blanked in `masked`; the names are read from the original text at the same offsets
      const list = text.slice(open, close === -1 ? open : open + close);
      all ??= new Set<string>();
      for (const q of list.matchAll(/['"]([A-Za-z_]\w*)['"]/g)) all.add(q[1]!);
    }
    value = { names, all };
  }
  surfaceCache.set(key, st.stamp, value);
  return value;
}

/** The file `from <module> import <name>` names when read from `importer`: a submodule, else the module file. */
function resolveFromItem(run: PyRun, importer: string, moduleText: string, name: string): string | undefined {
  const where = rootsAndModule(run, importer, moduleText);
  if (where === undefined) return undefined;
  const located = locateModule(run, where.roots, where.dotted);
  if (located === undefined) return undefined;
  return findSubmodule(run, located.packageDirs, name) ?? located.file;
}

/** The module `moduleFile` gets `name` from (one hop), or undefined. */
function lookupReexport(run: PyRun, moduleFile: string, name: string): { path: string; orig: string } | undefined {
  const info = reexportsOf(run, moduleFile);
  if (info === undefined) return undefined;
  const direct = info.named.get(name);
  if (direct !== undefined) {
    const target = resolveFromItem(run, moduleFile, direct.module, direct.orig);
    return target !== undefined && target !== moduleFile ? { path: target, orig: direct.orig } : undefined;
  }
  if (name.startsWith("_")) return undefined; // `import *` never re-exports a private name
  for (const moduleText of info.stars) {
    if (run.starReads >= MAX_STAR_READS) break;
    const where = rootsAndModule(run, moduleFile, moduleText);
    if (where === undefined) continue;
    const located = locateModule(run, where.roots, where.dotted);
    if (located?.file === undefined || located.file === moduleFile || !located.file.endsWith(".py")) continue;
    run.starReads++;
    const surface = surfaceOf(run, located.file);
    if (surface !== undefined && surface.names.has(name) && (surface.all === undefined || surface.all.has(name))) {
      return { path: located.file, orig: name };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const SCRIPT_GUARD_RE = /\b__name__\s*==\s*['"]__main__['"]/;

export function resolvePythonImports(workspace: string, filePath: string, lines: readonly string[]): ResolvedImport[] {
  const out: ResolvedImport[] = [];
  try {
    // forward slashes, no `.` segments or leading `./`: the importer is compared with canonical edge paths
    collectPythonImports(workspace, posixJoin(filePath.replace(/\\/g, "/")), lines, out);
  } catch {
    // The hooks that call this run inside pack construction: a defect here must cost the edges, never the pack.
  }
  return out;
}

function collectPythonImports(workspace: string, importer: string, lines: readonly string[], out: ResolvedImport[]): void {
  let text = lines.join("\n");
  if (text.length > MAX_SCAN_CHARS) text = text.slice(0, MAX_SCAN_CHARS);
  if (!text.includes("import")) return;
  const statements = parseStatements(maskedLines(text), MAX_STATEMENTS);
  if (statements.length === 0) return;
  const run = newRun(workspace);
  const runsAsScript = SCRIPT_GUARD_RE.test(text);
  const emit = (target: string | undefined, line: number, names: string[]): boolean => {
    if (target === undefined || target === importer || out.length >= MAX_RAW_EDGES || !realInsideRel(workspace, target)) return false;
    out.push({ path: target, line, kind: "import", names });
    return true;
  };
  for (const statement of statements) {
    if (out.length >= MAX_RAW_EDGES) break;
    if (statement.kind === "import") {
      for (const { dotted, alias } of statement.modules) {
        if (dotted === "__future__") continue;
        const located = locateModule(run, importRootsFor(run, posixDirname(importer), runsAsScript), dotted);
        emit(located?.file, statement.line, uniqueNames([alias ?? dotted.split(".")[0]!, dotted.split(".").pop()!]));
      }
      continue;
    }
    if (statement.module === "__future__") continue;
    const where = rootsAndModule(run, importer, statement.module, runsAsScript);
    if (where === undefined) continue;
    const located = locateModule(run, where.roots, where.dotted);
    if (located === undefined) continue;
    const plain: PyItem[] = [];
    for (const item of statement.items) {
      const submodule = findSubmodule(run, located.packageDirs, item.name);
      if (submodule !== undefined) emit(submodule, statement.line, uniqueNames([item.name, item.alias ?? item.name]));
      else plain.push(item);
    }
    if (located.file === undefined) continue;
    if (plain.length === 0 && statement.items.length > 0) continue; // every name is a submodule: the package file adds nothing
    const emitted = emit(located.file, statement.line, uniqueNames(plain.flatMap((item) => [item.name, item.alias ?? item.name])));
    if (!emitted || !located.file.endsWith(".py")) continue; // a module's own names need no hop
    const info = reexportsOf(run, located.file);
    if (info === undefined || (info.named.size === 0 && info.stars.length === 0)) continue; // re-exports nothing
    const hopEdges = new Map<string, ResolvedImport>();
    for (const item of plain) {
      const candidate = info.named.has(item.name) || (!item.name.startsWith("_") && info.stars.length > 0);
      if (!candidate) continue;
      if (run.lookups >= MAX_REEXPORT_LOOKUPS || out.length >= MAX_RAW_EDGES) break;
      run.lookups++;
      const hop = lookupReexport(run, located.file, item.name);
      if (hop === undefined) continue;
      const names = uniqueNames([item.name, item.alias ?? item.name, hop.orig]);
      const sameTarget = hopEdges.get(hop.path);
      if (sameTarget !== undefined) {
        // several names of one statement re-exported from the same module: one edge carrying all of them
        sameTarget.names.splice(0, sameTarget.names.length, ...uniqueNames([...sameTarget.names, ...names]));
      } else if (emit(hop.path, statement.line, names)) {
        hopEdges.set(hop.path, out[out.length - 1]!);
      }
    }
  }
}

/** Drops every cache (re-export scans, module surfaces, symlink verdicts). For tests. */
export function resetPythonImportCaches(): void {
  reexportCache.clear();
  surfaceCache.clear();
  realRoots.clear();
  realPathVerdicts.clear();
}
