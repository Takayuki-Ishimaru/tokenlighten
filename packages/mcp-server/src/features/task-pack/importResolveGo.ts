/**
 * importResolveGo.ts — Go import edges for importResolution.ts's dispatcher
 * (consumed by the default-OFF V15-NBR neighbour index and V15-FUI usage
 * inventory). Contract: see importResolution.ts and importGraphShared.ts.
 *
 * Every rule below is a Go-toolchain rule, none is keyed to a project,
 * package or identifier name:
 *
 * 1. IMPORT PATH -> DIRECTORY. The nearest `go.mod` above the file (a module
 *    nested anywhere below the workspace root works) names the module path;
 *    an import path equal to or under it maps to `<moduleDir>/<rest>`. Also
 *    resolvable: every `use` module of an ancestor `go.work` (single-line and
 *    block forms); local-directory `replace` targets of the go.mod/go.work;
 *    and — for the several-modules-in-one-repository layout without
 *    go.work/replace — the sibling modules a shared module-path prefix
 *    implies (module `host/org/repo/svc/a` living in `…/repo/svc/a` anchors
 *    `host/org/repo` at `…/repo`) — confirmed by the go.mod nearest above the
 *    candidate directory, which must map the import path to exactly that
 *    directory (a sibling declaring ANOTHER module path is a different module).
 *    The LONGEST matching module path wins and is authoritative: an import
 *    under a known module never falls back to a guess. A path nothing claims
 *    is an EXTERNAL module whenever a go.mod governs the file and its first
 *    segment has a dot (`github.com/pkg/errors` is never the local
 *    `pkg/errors`); only go.mod-less layouts and dotless GOPATH-style paths use
 *    the trailing-segment match (3, 2, 1 trailing segments; a domain-style
 *    first segment needs at least 2) under the module root, then the workspace
 *    root, and only when the directory's `package` clause agrees with the
 *    path's last segment and is not `main`. Standard-library paths (a first
 *    element without a dot that is a known standard-library root) and external
 *    modules resolve to nothing. A relative import (`./x`, `../x`) resolves
 *    against the importing file's directory; a `replace`/`use`/relative path
 *    that leaves the workspace is dropped.
 * 2. NAMES-AWARE FILE CHOICE. The qualified uses `<qualifier>.<Name>` in the
 *    body (comments, string, raw-string and rune literals masked) select the
 *    files of the package directory that declare `Name` at package level
 *    (func/type/const/var, never methods): one edge per such file, in order of
 *    first use, at most 4 per import, `names` = the qualifier plus the used
 *    names declared there. The qualifier is the explicit alias or, unaliased,
 *    the path's last segment (previous segment for a `vN` suffix) and the
 *    package clause of the directory's files. When nothing resolves this way
 *    ONE representative file is returned: `<dir>/<last segment>.go`, else the
 *    first non-test, non-`doc.go` file. `_test.go` files are eligible only for
 *    a test importer and only in its OWN package directory (`export_test.go`
 *    beside an external test package); another package's test files are never
 *    importable. Blank and dot imports get the representative file.
 * 3. SAME-PACKAGE REFERENCES (`kind:"reference"`). The unqualified
 *    identifiers the body uses that a same-directory `.go` file of the SAME
 *    package clause declares at package level, grouped per file, at most 8
 *    files, `line` = the first use. An identifier is a use when it is not a
 *    selector (`x.Name`, including a chain broken after the dot the way gofmt
 *    does), not a declaration head, label, label reference or
 *    composite-literal key, not an import qualifier, and not bound locally
 *    (`:=`, `var`, parameters, results, receivers, type parameters, struct
 *    fields, interface method specs and their parameters). A sibling that
 *    declares nothing the body uses never appears; test siblings only for a
 *    test importer. Lines over 2,000 characters (generated tables) are not
 *    scanned for uses.
 * 4. Everything is bounded (imports, directory entries, files read, bytes,
 *    file-system operations per call, and every per-line heuristic is a single
 *    pass); parsed go.mod/go.work files and file declarations are cached per
 *    absolute path, validated by mtime and size; the resolver never throws (a
 *    failure yields no edges). Every read, listing and parse checks the REAL
 *    path first (`realPathInside`): a symlink pointing out of the workspace is
 *    neither read nor listed, and an edge whose real path leaves it is dropped.
 *
 * NOT covered (emit nothing rather than a guess): build-constraint and
 * GOOS/GOARCH file selection, `vendor/` trees, GOPATH `src/` trees, module
 * proxies, dot-import name resolution, cgo, `go:embed`, generated files.
 */
import * as fs from "fs";
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

const MAX_STATEMENTS = 40;
const MAX_ANCESTORS = 24;
const MAX_WORK_USES = 32;
const MAX_PACKAGE_FILES = 80;
const MAX_FILES_PER_IMPORT = 4;
const MAX_REFERENCE_FILES = 8;
const MAX_NAMES_PER_EDGE = 8;
const MAX_LISTED_ENTRIES = 400;
/** Lines longer than this (generated tables, minified data) are skipped by the per-line heuristics. */
const MAX_HEURISTIC_LINE = 2000;
/** File-system operations (stat/readdir/read) one call may spend. */
const MAX_FS_OPS = 2000;
const MAX_MANIFEST_BYTES = 1024 * 1024;
/** Bytes of a sibling read for its declarations (the scanner looks at the first 4,000 lines only). */
const MAX_SOURCE_BYTES = 256 * 1024;
const MAX_MASK_CHARS = 512 * 1024;
const MANIFEST_CACHE_LIMIT = 256;
const DECLARED_CACHE_LIMIT = 4096;

const GO_KEYWORDS = new Set([
  "break", "default", "func", "interface", "select", "case", "defer", "go", "map", "struct", "chan", "else", "goto",
  "package", "switch", "const", "fallthrough", "if", "range", "type", "continue", "for", "import", "return", "var",
]);

/** First path elements of the Go standard library (an import path without a dot in its first element is reserved for it). */
const STDLIB_ROOTS = new Set([
  "archive", "bufio", "bytes", "cmp", "compress", "container", "context", "crypto", "database", "debug", "embed",
  "encoding", "errors", "expvar", "flag", "fmt", "go", "hash", "html", "image", "index", "io", "iter", "log", "maps",
  "math", "mime", "net", "os", "path", "plugin", "reflect", "regexp", "runtime", "slices", "sort", "strconv",
  "strings", "structs", "sync", "syscall", "testing", "text", "time", "unicode", "unique", "unsafe", "weak",
  "C", "cmd", "internal", "vendor",
]);

// ---------------------------------------------------------------------------
// Lexical masking
// ---------------------------------------------------------------------------

/**
 * Comments, raw strings and rune literals -> spaces (newlines and total
 * length kept); interpreted `"…"` strings are kept when `keepStrings`, so an
 * import path stays readable, and blanked otherwise.
 */
function maskGo(text: string, keepStrings: boolean): string {
  const limit = Math.min(text.length, MAX_MASK_CHARS);
  const out: string[] = [];
  let run = 0;
  const blank = (from: number, to: number): void => {
    if (from > run) out.push(text.slice(run, from));
    out.push(text.slice(from, to).replace(/[^\r\n]/g, " "));
    run = to;
  };
  let i = 0;
  while (i < limit) {
    const c = text.charCodeAt(i);
    const d = i + 1 < text.length ? text.charCodeAt(i + 1) : -1;
    if (c === 47 && d === 47) {
      let end = text.indexOf("\n", i);
      if (end < 0 || end > limit) end = limit;
      blank(i, end);
      i = end;
    } else if (c === 47 && d === 42) {
      let end = text.indexOf("*/", i + 2);
      end = end < 0 ? limit : Math.min(end + 2, limit);
      blank(i, end);
      i = end;
    } else if (c === 96) { // raw string
      let end = text.indexOf("`", i + 1);
      end = end < 0 ? limit : Math.min(end + 1, limit);
      blank(i, end);
      i = end;
    } else if (c === 34) { // interpreted string
      let j = i + 1;
      while (j < limit) {
        const cj = text.charCodeAt(j);
        if (cj === 92) { j += 2; continue; }
        if (cj === 34) { j++; break; }
        if (cj === 10) break;
        j++;
      }
      j = Math.min(j, limit);
      if (!keepStrings) blank(i, j);
      i = j;
    } else if (c === 39) { // rune literal
      let j = i + 1;
      if (text.charCodeAt(j) === 92) j += 2; else j += 1;
      let end = i;
      for (let k = j; k < limit && k - i <= 12; k++) {
        const ck = text.charCodeAt(k);
        if (ck === 39) { end = k + 1; break; }
        if (ck === 10) break;
      }
      if (end > i) { blank(i, end); i = end; } else i++;
    } else i++;
  }
  if (run < limit) out.push(text.slice(run, limit));
  if (text.length > limit) out.push(text.slice(limit).replace(/[^\r\n]/g, " "));
  return out.join("");
}

function lineStartsOf(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return starts;
}

/** 1-based line of `offset` given the line-start table. */
function lineOfOffset(starts: readonly number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}

// ---------------------------------------------------------------------------
// Per-call probe and stamped caches
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
  private readonly packages = new Map<string, PackageFiles>();
  private readonly indexes = new Map<string, ReadonlyMap<string, string>>();
  private readonly declarations = new Map<string, FileDeclarations>();
  private ops = 0;

  constructor(readonly workspace: string) {}

  charge(): boolean {
    this.ops++;
    return this.ops <= MAX_FS_OPS;
  }

  isDir(rel: string): boolean {
    if (rel === "") return true;
    const hit = this.dirs.get(rel);
    if (hit !== undefined) return hit;
    const ok = this.charge() && directoryExists(this.workspace, rel) && realInside(this.workspace, rel);
    this.dirs.set(rel, ok);
    return ok;
  }

  list(rel: string): string[] {
    const hit = this.listings.get(rel);
    if (hit !== undefined) return hit;
    const names = this.isDir(rel) && this.charge() ? listDirectory(this.workspace, rel).slice(0, MAX_LISTED_ENTRIES) : [];
    this.listings.set(rel, names);
    return names;
  }

  /** `.go` files directly inside `dir` (a package's members), split into non-test and test files, sorted. */
  packageFiles(dir: string): PackageFiles {
    const hit = this.packages.get(dir);
    if (hit !== undefined) return hit;
    const source: string[] = [];
    const tests: string[] = [];
    for (const name of this.list(dir)) {
      if (!name.endsWith(".go") || name.startsWith("_") || name.startsWith(".")) continue;
      (name.endsWith("_test.go") ? tests : source).push(posixJoin(dir, name));
    }
    const files = { source, tests };
    this.packages.set(dir, files);
    return files;
  }

  /** Per-call memo of a file's declarations (a sibling is consulted by several passes). */
  declared(rel: string, read: () => FileDeclarations): FileDeclarations {
    const hit = this.declarations.get(rel);
    if (hit !== undefined) return hit;
    const value = read();
    this.declarations.set(rel, value);
    return value;
  }

  index(key: string, build: () => ReadonlyMap<string, string>): ReadonlyMap<string, string> {
    const hit = this.indexes.get(key);
    if (hit !== undefined) return hit;
    const built = build();
    this.indexes.set(key, built);
    return built;
  }
}

interface PackageFiles {
  source: string[];
  tests: string[];
}

interface StampedValue {
  mtimeMs: number;
  size: number;
  value: unknown;
}

const MANIFEST_CACHE = new Map<string, StampedValue>();

/** Parse of workspace-relative `rel`, cached per absolute path and validated by mtime+size (one stat). */
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
// go.mod / go.work
// ---------------------------------------------------------------------------

interface GoModInfo {
  module?: string;
  /** `use` directories of a go.work, as written. */
  uses: string[];
  /** Local-directory `replace` targets: module path -> directory as written. */
  replaces: Array<{ from: string; dir: string }>;
}

function unquoteGoToken(token: string): string {
  return token.replace(/^["'`]/, "").replace(/["'`]$/, "");
}

function stripGoModComment(line: string): string {
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote !== "") { if (ch === quote) quote = ""; continue; }
    if (ch === '"' || ch === "`") { quote = ch; continue; }
    if (ch === "/" && line[i + 1] === "/") return line.slice(0, i);
  }
  return line;
}

function isLocalDirectory(target: string): boolean {
  return target === "." || target === ".." || target.startsWith("./") || target.startsWith("../");
}

function parseGoMod(source: string): GoModInfo {
  const text = source.replace(/^\uFEFF/, "");
  const info: GoModInfo = { uses: [], replaces: [] };
  let block: string | undefined;
  const directive = (name: string, rest: string): void => {
    if (name === "module") {
      const token = rest.trim().split(/\s+/)[0];
      if (token !== undefined && token.length > 0 && info.module === undefined) info.module = unquoteGoToken(token);
    } else if (name === "use") {
      const token = rest.trim().split(/\s+/)[0];
      if (token !== undefined && token.length > 0 && info.uses.length < MAX_WORK_USES) info.uses.push(unquoteGoToken(token));
    } else if (name === "replace") {
      const arrow = rest.indexOf("=>");
      if (arrow < 0) return;
      const from = rest.slice(0, arrow).trim().split(/\s+/)[0];
      const target = rest.slice(arrow + 2).trim().split(/\s+/)[0];
      if (from === undefined || target === undefined || from.length === 0) return;
      const dir = unquoteGoToken(target);
      if (isLocalDirectory(dir)) info.replaces.push({ from: unquoteGoToken(from), dir });
    }
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = stripGoModComment(raw).trim();
    if (line.length === 0) continue;
    if (block !== undefined) {
      if (line === ")") block = undefined;
      else directive(block, line);
      continue;
    }
    const open = /^(\w+)\s*\(\s*$/.exec(line);
    if (open) { block = open[1]!; continue; }
    const single = /^(\w+)\s+(.*)$/.exec(line);
    if (single) directive(single[1]!, single[2]!);
  }
  return info;
}

interface ModuleEntry {
  /** Module path. */
  path: string;
  /** Workspace-relative directory holding the module's root. */
  dir: string;
}

interface ModuleTable {
  entries: ModuleEntry[];
  /** Directory of the nearest go.mod, when there is one. */
  ownDir?: string;
  /** A module-path prefix and the directory it corresponds to (sibling modules of one repository). */
  anchor?: { prefix: string; dir: string };
}

/** Workspace-relative directory of `target` written relative to `baseDir`; undefined when it leaves the workspace. */
function localDir(baseDir: string, target: string): string | undefined {
  const joined = posixJoin(baseDir, target);
  return joined.startsWith("..") ? undefined : joined;
}

function moduleTableFor(probe: Probe, importerDir: string): ModuleTable {
  const workspace = probe.workspace;
  let modDir: string | undefined;
  let mod: GoModInfo | undefined;
  let workDir: string | undefined;
  let work: GoModInfo | undefined;
  let dir = importerDir;
  for (let depth = 0; depth < MAX_ANCESTORS; depth++) {
    if (mod === undefined && probe.charge()) {
      const found = cachedParse(workspace, posixJoin(dir, "go.mod"), parseGoMod);
      if (found !== undefined) { mod = found; modDir = dir; }
    }
    if (work === undefined && probe.charge()) {
      const found = cachedParse(workspace, posixJoin(dir, "go.work"), parseGoMod);
      if (found !== undefined) { work = found; workDir = dir; }
    }
    if (dir === "") break;
    dir = posixDirname(dir);
  }
  const entries: ModuleEntry[] = [];
  const table: ModuleTable = { entries };
  if (mod !== undefined && modDir !== undefined) {
    table.ownDir = modDir;
    if (mod.module !== undefined) {
      entries.push({ path: mod.module, dir: modDir });
      const anchor = anchorOf(mod.module, modDir);
      if (anchor !== undefined) table.anchor = anchor;
    }
    for (const replace of mod.replaces) {
      const target = localDir(modDir, replace.dir);
      if (target !== undefined) entries.push({ path: replace.from, dir: target });
    }
  }
  if (work !== undefined && workDir !== undefined) {
    for (const use of work.uses) {
      const useDir = localDir(workDir, use);
      if (useDir === undefined) continue;
      const useMod = cachedParse(workspace, posixJoin(useDir, "go.mod"), parseGoMod);
      if (useMod?.module !== undefined) entries.push({ path: useMod.module, dir: useDir });
    }
    for (const replace of work.replaces) {
      const target = localDir(workDir, replace.dir);
      if (target !== undefined) entries.push({ path: replace.from, dir: target });
    }
  }
  return table;
}

/**
 * A module `host/org/repo/svc/a` living in `<repo>/svc/a` implies the module
 * path prefix `host/org/repo` corresponds to `<repo>`: the trailing path
 * segments the module path and its directory share are the module's place
 * inside its repository.
 */
function anchorOf(modulePath: string, modDir: string): { prefix: string; dir: string } | undefined {
  const pathSegs = modulePath.split("/");
  const dirSegs = modDir === "" ? [] : modDir.split("/");
  let shared = 0;
  while (shared < pathSegs.length - 1 && shared < dirSegs.length && pathSegs[pathSegs.length - 1 - shared] === dirSegs[dirSegs.length - 1 - shared]) shared++;
  if (shared === 0) return undefined;
  return { prefix: pathSegs.slice(0, pathSegs.length - shared).join("/"), dir: dirSegs.slice(0, dirSegs.length - shared).join("/") };
}

// ---------------------------------------------------------------------------
// Imports of a file
// ---------------------------------------------------------------------------

interface GoImportSpec {
  /** Explicit alias: an identifier, `_` or `.`; undefined for a plain import. */
  alias?: string;
  path: string;
  line: number;
}

const IMPORT_SPEC_RE = /(?:([A-Za-z_][A-Za-z0-9_]*|\.)[ \t]+)?"([^"\n]+)"/g;

/** `text` has its comments (and raw strings) blanked but keeps `"…"` strings. */
function parseGoImports(text: string): GoImportSpec[] {
  const firstDeclaration = text.search(/^(?:func|type|var|const)\b/m);
  const header = firstDeclaration < 0 ? text : text.slice(0, firstDeclaration);
  const starts = lineStartsOf(header);
  const specs: GoImportSpec[] = [];
  for (const m of header.matchAll(/^[ \t]*import\b/gm)) {
    let pos = m.index! + m[0].length;
    while (pos < header.length && /\s/.test(header[pos]!)) pos++;
    let region: string;
    let regionStart: number;
    if (header[pos] === "(") {
      const close = header.indexOf(")", pos);
      regionStart = pos + 1;
      region = header.slice(regionStart, close < 0 ? header.length : close);
    } else {
      regionStart = pos;
      const eol = header.indexOf("\n", pos);
      region = header.slice(pos, eol < 0 ? header.length : eol);
    }
    for (const spec of region.matchAll(IMPORT_SPEC_RE)) {
      specs.push({ alias: spec[1], path: spec[2]!, line: lineOfOffset(starts, regionStart + spec.index!) });
      if (specs.length >= MAX_STATEMENTS * 2) return specs;
    }
  }
  return specs;
}

const PACKAGE_CLAUSE_RE = /^[ \t]*package[ \t]+([A-Za-z_][A-Za-z0-9_]*)/m;

function packageClauseOf(text: string): string | undefined {
  return PACKAGE_CLAUSE_RE.exec(text)?.[1];
}

// ---------------------------------------------------------------------------
// Declarations of a file
// ---------------------------------------------------------------------------

interface FileDeclarations {
  pkg?: string;
  /** Package-level names (func/type/const/var — never methods, never `init`). */
  names: ReadonlySet<string>;
}

const DECLARED_CACHE = new Map<string, { mtimeMs: number; size: number; value: FileDeclarations }>();

function declarationsOfFile(probe: Probe, rel: string): FileDeclarations {
  return probe.declared(rel, () => readDeclarations(probe, rel));
}

function readDeclarations(probe: Probe, rel: string): FileDeclarations {
  const empty: FileDeclarations = { names: new Set() };
  const abs = withinWorkspace(probe.workspace, rel);
  if (abs === undefined || !probe.charge()) return empty;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    return empty;
  }
  if (!stat.isFile()) return empty;
  const hit = DECLARED_CACHE.get(abs);
  if (hit !== undefined && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.value;
  const body = probe.charge() ? readHead(probe.workspace, rel, MAX_SOURCE_BYTES) : undefined;
  let value = empty;
  if (body !== undefined) {
    const names = new Set<string>();
    // declarationsIn masks comments and literals itself; a method (`kind:"member"`) belongs to its receiver, not the package.
    for (const decl of declarationsIn(rel, body)) {
      if (decl.kind === "member" || decl.symbol === "_" || decl.symbol === "init") continue;
      names.add(decl.symbol);
    }
    value = { pkg: packageClauseOf(maskGo(body, true)), names };
  }
  if (DECLARED_CACHE.size >= DECLARED_CACHE_LIMIT) {
    const oldest = DECLARED_CACHE.keys().next();
    if (!oldest.done) DECLARED_CACHE.delete(oldest.value);
  }
  DECLARED_CACHE.set(abs, { mtimeMs: stat.mtimeMs, size: stat.size, value });
  return value;
}

/** name -> first file (in the given order) that declares it at package level. */
function declaredIndex(probe: Probe, key: string, files: readonly string[]): ReadonlyMap<string, string> {
  return probe.index(key, () => {
    const index = new Map<string, string>();
    for (const file of files.slice(0, MAX_PACKAGE_FILES)) {
      for (const name of declarationsOfFile(probe, file).names) if (!index.has(name)) index.set(name, file);
    }
    return index;
  });
}

// ---------------------------------------------------------------------------
// Uses in the importing body
// ---------------------------------------------------------------------------

/** qualifier -> names used as `qualifier.Name` (first-use order). */
function qualifiedUses(code: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of code.matchAll(/(?<![\w$.])([A-Za-z_]\w*)[ \t]*\.[ \t]*([A-Za-z_]\w*)/g)) {
    const names = out.get(m[1]!) ?? [];
    if (!names.includes(m[2]!)) names.push(m[2]!);
    out.set(m[1]!, names);
  }
  return out;
}

function matchingBracket(text: string, open: number): number {
  const opener = text[open]!;
  const closer = opener === "(" ? ")" : opener === "[" ? "]" : "}";
  let depth = 0;
  for (let i = open; i < text.length && i < open + 2000; i++) {
    const ch = text[i]!;
    if (ch === opener) depth++;
    else if (ch === closer && --depth === 0) return i;
  }
  return -1;
}

/** Names a parameter/result/receiver list binds: `a, b int`, `ctx context.Context`, `args ...T`. */
function addGroupNames(content: string, out: Set<string>): void {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i]!;
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === "," && depth === 0) { parts.push(content.slice(start, i)); start = i + 1; }
  }
  parts.push(content.slice(start));
  const typed = parts.map((part) => /^\s*([A-Za-z_]\w*)\s+\S/.exec(part.trim())?.[1]);
  if (!typed.some((name) => name !== undefined && !GO_KEYWORDS.has(name))) return;
  parts.forEach((part, index) => {
    const name = typed[index] ?? (/^\s*([A-Za-z_]\w*)\s*$/.exec(part)?.[1]);
    if (name !== undefined && name !== "_" && !GO_KEYWORDS.has(name)) out.add(name);
  });
}

/** Line indices (0-based) inside a `type X interface { … }` body: their `Name(params)` heads are method specs, not calls. */
function interfaceBodyLines(lines: readonly string[]): Set<number> {
  const inside = new Set<number>();
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length > MAX_HEURISTIC_LINE) continue;
    if (depth > 0) inside.add(i);
    const opens = (line.match(/\{/g) ?? []).length;
    const closes = (line.match(/\}/g) ?? []).length;
    if (depth > 0) depth = Math.max(0, depth + opens - closes);
    else if (/\binterface[ \t]*\{/.test(line) && opens > closes) depth = opens - closes;
  }
  return inside;
}

const isIdentStart = (c: number): boolean => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
const isIdentPart = (c: number): boolean => isIdentStart(c) || (c >= 48 && c <= 57);
const isBlank = (c: number): boolean => c === 32 || c === 9;

/** The identifiers of the comma-separated list ending just before `end` (blanks allowed): `a, b` in `a, b := f()`. One backward pass. */
function identifiersBefore(line: string, end: number): string[] {
  const names: string[] = [];
  let i = end - 1;
  for (;;) {
    while (i >= 0 && isBlank(line.charCodeAt(i))) i--;
    let j = i;
    while (j >= 0 && isIdentPart(line.charCodeAt(j))) j--;
    if (j === i || !isIdentStart(line.charCodeAt(j + 1))) break;
    names.push(line.slice(j + 1, i + 1));
    i = j;
    while (i >= 0 && isBlank(line.charCodeAt(i))) i--;
    if (i < 0 || line.charCodeAt(i) !== 44) break;
    i--;
  }
  return names;
}

/** The identifiers of the comma-separated list starting at `start` and the offset just past its last one. One forward pass. */
function identifiersAfter(line: string, start: number): { names: string[]; end: number } {
  const names: string[] = [];
  let i = start;
  let end = start;
  while (i < line.length && isIdentStart(line.charCodeAt(i))) {
    let j = i + 1;
    while (j < line.length && isIdentPart(line.charCodeAt(j))) j++;
    names.push(line.slice(i, j));
    end = j;
    let k = j;
    while (k < line.length && isBlank(line.charCodeAt(k))) k++;
    if (line.charCodeAt(k) !== 44) break;
    k++;
    while (k < line.length && isBlank(line.charCodeAt(k))) k++;
    i = k;
  }
  return { names, end };
}

/** `func` keywords of one line whose signatures are read (a generated line of closures must not multiply the work). */
const MAX_FUNCS_PER_LINE = 16;

/**
 * Identifiers the body binds itself: `:=`, `var`, parameters/results/receivers,
 * fields, interface method parameters. Every scan is a single pass over the
 * line (no nested repetition), so a 2,000-character list of identifiers costs
 * its length, not its square.
 */
function localBindings(lines: readonly string[], interfaceLines: ReadonlySet<number>): Set<string> {
  const out = new Set<string>();
  const add = (names: readonly string[]): void => {
    for (const name of names) if (name !== "_" && !GO_KEYWORDS.has(name)) out.add(name);
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (line.length > MAX_HEURISTIC_LINE) continue;
    // Short variable declarations: the identifier list before each `:=`.
    for (let at = line.indexOf(":="); at >= 0; at = line.indexOf(":=", at + 2)) add(identifiersBefore(line, at));
    // `var a, b` / `const a, b`.
    if (line.includes("var") || line.includes("const")) {
      for (const m of line.matchAll(/\b(?:var|const)[ \t]+/g)) add(identifiersAfter(line, m.index! + m[0].length).names);
    }
    // `name Type` lines: struct fields, block var/const entries, wrapped parameter lists.
    let lead = 0;
    while (lead < line.length && isBlank(line.charCodeAt(lead))) lead++;
    const head = identifiersAfter(line, lead);
    if (head.names.length > 0 && !GO_KEYWORDS.has(head.names[0]!) && isBlank(line.charCodeAt(head.end))) {
      let k = head.end;
      while (k < line.length && isBlank(line.charCodeAt(k))) k++;
      const c = line.charCodeAt(k);
      if (c === 42 || c === 91 || isIdentStart(c)) add(head.names);
    }
    // Parameters, results and receivers of every func (a signature never spans more than its brackets).
    if (line.includes("func")) {
      let funcs = 0;
      for (const m of line.matchAll(/\bfunc\b/g)) {
        if (++funcs > MAX_FUNCS_PER_LINE) break;
        collectFuncNames(lines, index, m.index! + 4, out);
      }
    }
    // Parameter names of an interface method spec.
    if (interfaceLines.has(index)) {
      const open = line.indexOf("(");
      if (open >= 0 && /^[ \t]*[A-Za-z_]\w*[ \t]*\(/.test(line)) {
        const close = matchingBracket(line, open);
        if (close > open) addGroupNames(line.slice(open + 1, close), out);
      }
    }
  }
  return out;
}

/** Binds the parameter/result/receiver names of the `func` whose keyword ends at `from` on line `index` (signatures are read within the line). */
function collectFuncNames(lines: readonly string[], index: number, from: number, out: Set<string>): void {
  const line = lines[index]!;
  let i = from;
  for (let step = 0; step < 6 && i < line.length; step++) {
    while (i < line.length && (line[i] === " " || line[i] === "\t")) i++;
    const ch = line[i];
    if (ch === "(") {
      const end = matchingBracket(line, i);
      if (end < 0) return;
      addGroupNames(line.slice(i + 1, end), out);
      i = end + 1;
    } else if (ch === "[") {
      // Type parameters (`[In, Out any]`) bind names; a result type such as `[]T` binds none.
      const end = matchingBracket(line, i);
      if (end < 0) return;
      addGroupNames(line.slice(i + 1, end), out);
      i = end + 1;
    } else if (ch !== undefined && /[A-Za-z_]/.test(ch)) {
      while (i < line.length && /\w/.test(line[i]!)) i++;
    } else return;
  }
}

/** For every offset of `line`, the nearest bracket opened before it and still open (0 = none): one pass, computed on first need. */
function openerTable(line: string): Uint8Array {
  const table = new Uint8Array(line.length + 1);
  const stack: number[] = [];
  for (let i = 0; i < line.length; i++) {
    table[i] = stack.length > 0 ? stack[stack.length - 1]! : 0;
    const c = line.charCodeAt(i);
    if (c === 40 || c === 91 || c === 123) stack.push(c);
    else if ((c === 41 || c === 93 || c === 125) && stack.length > 0) stack.pop();
  }
  return table;
}

/** The word before `at` (blanks skipped) is `goto`, `break` or `continue`: the identifier at `at` is a label reference. Bounded look-back. */
function followsLabelKeyword(line: string, at: number): boolean {
  let end = at - 1;
  while (end >= 0 && isBlank(line.charCodeAt(end))) end--;
  if (end < 0) return false;
  let start = end;
  while (start >= 0 && isIdentPart(line.charCodeAt(start)) && end - start < 9) start--;
  if (start >= 0 && isIdentPart(line.charCodeAt(start))) return false; // a longer identifier
  const word = line.slice(start + 1, end + 1);
  return word === "goto" || word === "break" || word === "continue";
}

/** Unqualified identifiers the body uses as package-level references, first-use order with their first line. */
function unqualifiedUses(code: string, importNames: ReadonlySet<string>): Array<{ name: string; line: number }> {
  const lines = code.split("\n");
  const interfaceLines = interfaceBodyLines(lines);
  const bindings = localBindings(lines, interfaceLines);
  const out: Array<{ name: string; line: number }> = [];
  const seen = new Set<string>();
  let inImportBlock = false;
  // gofmt breaks a method chain AFTER the dot (`db.` newline `Where(…).` newline `Find(…)`): an identifier that opens a
  // line is a selector when the previous code line ended with a member-access `.`.
  let previousEndsWithDot = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    const continuesSelector = previousEndsWithDot;
    if (trimmed.length > 0) previousEndsWithDot = trimmed.endsWith(".") && !trimmed.endsWith("..");
    if (inImportBlock) {
      if (trimmed.startsWith(")")) inImportBlock = false;
      continue;
    }
    if (/^import\b/.test(trimmed)) {
      if (/^import\s*\(/.test(trimmed) && !trimmed.includes(")")) inImportBlock = true;
      continue;
    }
    if (/^package\b/.test(trimmed)) continue;
    if (line.length > MAX_HEURISTIC_LINE) {
      previousEndsWithDot = false;
      continue;
    }
    let firstToken = 0;
    while (firstToken < line.length && isBlank(line.charCodeAt(firstToken))) firstToken++;
    const isCase = /^\s*case\b/.test(line);
    const head = /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/.exec(line);
    const headAt = head === null ? -1 : head.index + head[0].length - head[1]!.length;
    const methodSpec = interfaceLines.has(i) ? /^[ \t]*([A-Za-z_]\w*)[ \t]*\(/.exec(line) : null;
    const methodAt = methodSpec === null ? -1 : methodSpec.index + methodSpec[0].length - methodSpec[0].trimStart().length;
    let openers: Uint8Array | undefined;
    for (const m of line.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
      const name = m[0];
      const at = m.index!;
      if (seen.has(name) || GO_KEYWORDS.has(name) || bindings.has(name) || importNames.has(name) || at === headAt || at === methodAt) continue;
      if (continuesSelector && at === firstToken) continue; // the previous line ended with a member-access dot
      if (at > 0 && /[0-9]/.test(line[at - 1]!)) continue; // inside a numeric literal (0x1F, 1e9)
      let before = at - 1;
      while (before >= 0 && (line[before] === " " || line[before] === "\t")) before--;
      if (before >= 0 && line[before] === "." && !(before >= 2 && line[before - 1] === "." && line[before - 2] === ".")) continue; // selector
      if (followsLabelKeyword(line, at)) continue; // a label reference
      let after = at + name.length;
      while (after < line.length && isBlank(line.charCodeAt(after))) after++;
      if (!isCase && line[after] === ":" && line[after + 1] !== "=") {
        openers ??= openerTable(line);
        if (openers[at] !== 91) continue; // label or composite-literal key (inside `[` it is a slice bound)
      }
      seen.add(name);
      out.push({ name, line: i + 1 });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Import path -> package directory
// ---------------------------------------------------------------------------

interface GoCtx {
  probe: Probe;
  file: string;
  importerDir: string;
  isTest: boolean;
  /** The importer's package clause (`foo` or `foo_test`), when known. */
  pkg: string | undefined;
  modules: ModuleTable;
}

function isStdlibPath(importPath: string): boolean {
  const first = importPath.split("/")[0]!;
  return !first.includes(".") && STDLIB_ROOTS.has(first);
}

function normalizedName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Last path segment, or the one before a `vN` major-version suffix. */
function packageSegmentOf(importPath: string): string {
  const segs = importPath.split("/").filter((s) => s.length > 0);
  const last = segs[segs.length - 1] ?? "";
  return /^v\d+$/.test(last) && segs.length > 1 ? segs[segs.length - 2]! : last;
}

/** A directory that holds at least one importable (non-test) `.go` file and is not the importer's own package. */
function usablePackageDir(ctx: GoCtx, dir: string | undefined): dir is string {
  if (dir === undefined || dir.startsWith("..")) return false;
  const files = ctx.probe.packageFiles(dir);
  if (files.source.length === 0 && !(offersTestFiles(ctx, dir) && files.tests.length > 0)) return false;
  if (dir === ctx.importerDir && !(ctx.isTest && (ctx.pkg ?? "").endsWith("_test"))) return false;
  return true;
}

/**
 * `_test.go` files are compiled only into their own directory's test binary
 * (`export_test.go` exposes internals to the external test package beside
 * it): a test importer may be offered them for its OWN package directory and
 * never for another package it imports.
 */
function offersTestFiles(ctx: GoCtx, dir: string): boolean {
  return ctx.isTest && dir === ctx.importerDir;
}

/** A guessed directory is accepted only when its package clause fits the import path and is importable. */
function fallbackDirFits(ctx: GoCtx, dir: string, importPath: string): boolean {
  const first = ctx.probe.packageFiles(dir).source[0];
  if (first === undefined) return false;
  const pkg = declarationsOfFile(ctx.probe, first).pkg;
  if (pkg === undefined || pkg === "main") return false;
  const wanted = normalizedName(packageSegmentOf(importPath));
  const actual = normalizedName(pkg);
  return wanted.length > 0 && actual.length > 0 && (wanted === actual || wanted.endsWith(actual) || wanted.startsWith(actual));
}

/**
 * The shared-prefix anchor only guesses which directory an import means; the
 * go.mod nearest above that directory settles it: it must declare a module
 * path that is (a prefix of) the import path AND map it to exactly `dir`.
 * A sibling directory that declares ANOTHER module path is a different module.
 */
function anchoredModuleAgrees(ctx: GoCtx, dir: string, importPath: string): boolean {
  let at = dir;
  for (let depth = 0; depth < MAX_ANCESTORS; depth++) {
    const mod = ctx.probe.charge() ? cachedParse(ctx.probe.workspace, posixJoin(at, "go.mod"), parseGoMod) : undefined;
    if (mod !== undefined) {
      const declared = mod.module;
      if (declared === undefined || !(importPath === declared || importPath.startsWith(`${declared}/`))) return false;
      return localDir(at, importPath.slice(declared.length + 1)) === dir;
    }
    if (at === "") return false;
    at = posixDirname(at);
  }
  return false;
}

function resolveImportDir(ctx: GoCtx, importPath: string): string | undefined {
  if (importPath.length === 0 || importPath.includes("\\")) return undefined;
  if (importPath === "." || importPath === ".." || importPath.startsWith("./") || importPath.startsWith("../")) {
    const dir = localDir(ctx.importerDir, importPath);
    return usablePackageDir(ctx, dir) ? dir : undefined;
  }
  let best: ModuleEntry | undefined;
  for (const entry of ctx.modules.entries) {
    if ((importPath === entry.path || importPath.startsWith(`${entry.path}/`)) && (best === undefined || entry.path.length > best.path.length)) best = entry;
  }
  if (best !== undefined) {
    const dir = localDir(best.dir, importPath.slice(best.path.length + 1));
    return usablePackageDir(ctx, dir) ? dir : undefined;
  }
  if (isStdlibPath(importPath)) return undefined;
  const anchor = ctx.modules.anchor;
  if (anchor !== undefined && importPath.startsWith(`${anchor.prefix}/`)) {
    const dir = localDir(anchor.dir, importPath.slice(anchor.prefix.length + 1));
    if (usablePackageDir(ctx, dir) && anchoredModuleAgrees(ctx, dir, importPath)) return dir;
  }
  const segs = importPath.split("/").filter((s) => s.length > 0);
  if (segs.length === 0) return undefined;
  // A go.mod governs this file, so every module it can use is known: a domain-style path that no module, `replace`,
  // `use` or anchor claimed is an EXTERNAL module (`github.com/pkg/errors`), never the local `pkg/errors` directory
  // whose trailing segments happen to match. The tail match below is for go.mod-less and GOPATH-style (dotless) layouts.
  if (ctx.modules.ownDir !== undefined && segs[0]!.includes(".")) return undefined;
  const bases = ctx.modules.ownDir !== undefined && ctx.modules.ownDir !== "" ? [ctx.modules.ownDir, ""] : [""];
  const minTake = segs[0]!.includes(".") ? 2 : 1;
  for (let take = Math.min(3, segs.length); take >= minTake; take--) {
    const tail = segs.slice(segs.length - take).join("/");
    for (const base of bases) {
      const dir = localDir(base, tail);
      if (dir !== undefined && usablePackageDir(ctx, dir) && fallbackDirFits(ctx, dir, importPath)) return dir;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------

function isValidIdentifier(name: string): boolean {
  return /^[A-Za-z_]\w*$/.test(name);
}

/** The single file that stands for a package when the body's uses pick none. */
function representativeFile(files: PackageFiles, importPath: string): string | undefined {
  const named = files.source.find((f) => f.endsWith(`/${packageSegmentOf(importPath)}.go`) || f === `${packageSegmentOf(importPath)}.go`);
  if (named !== undefined) return named;
  return files.source.find((f) => !f.endsWith("/doc.go") && f !== "doc.go");
}

function importEdges(ctx: GoCtx, spec: GoImportSpec, uses: () => Map<string, string[]>): ResolvedImport[] {
  const dir = resolveImportDir(ctx, spec.path);
  if (dir === undefined) return [];
  const files = ctx.probe.packageFiles(dir);
  const candidates = (offersTestFiles(ctx, dir) ? [...files.source, ...files.tests] : files.source).filter((f) => f !== ctx.file);
  const qualifiers: string[] = [];
  if (spec.alias === undefined) {
    const segment = packageSegmentOf(spec.path);
    if (isValidIdentifier(segment)) qualifiers.push(segment);
  } else if (spec.alias !== "_" && spec.alias !== ".") qualifiers.push(spec.alias);
  const qualified = spec.alias === "_" || spec.alias === "." ? new Map<string, string[]>() : uses();
  if (spec.alias === undefined && candidates.length > 0 && !qualifiers.some((q) => qualified.has(q))) {
    // The unaliased qualifier is the package clause, which need not equal the last path segment.
    const pkg = declarationsOfFile(ctx.probe, candidates[0]!).pkg;
    if (pkg !== undefined && !qualifiers.includes(pkg)) qualifiers.push(pkg);
  }
  const used: string[] = [];
  let qualifier: string | undefined;
  for (const q of qualifiers) {
    const names = qualified.get(q);
    if (names === undefined) continue;
    qualifier ??= q;
    for (const name of names) if (!used.includes(name)) used.push(name);
  }
  const edges: ResolvedImport[] = [];
  if (used.length > 0 && candidates.length > 0) {
    const index = declaredIndex(ctx.probe, `pkg:${dir}:${offersTestFiles(ctx, dir) ? "t" : "s"}:${ctx.file}`, candidates);
    const byFile = new Map<string, string[]>();
    for (const name of used) {
      const owner = index.get(name);
      if (owner === undefined) continue;
      const names = byFile.get(owner) ?? [];
      names.push(name);
      byFile.set(owner, names);
    }
    for (const [file, names] of byFile) {
      if (edges.length >= MAX_FILES_PER_IMPORT) break;
      edges.push({ path: file, line: spec.line, kind: "import", names: uniqueNames([...(qualifier !== undefined ? [qualifier] : []), ...names]).slice(0, MAX_NAMES_PER_EDGE) });
    }
  }
  if (edges.length === 0) {
    const representative = representativeFile(files, spec.path);
    if (representative !== undefined && representative !== ctx.file) {
      edges.push({ path: representative, line: spec.line, kind: "import", names: uniqueNames(qualifiers.slice(0, 1)) });
    }
  }
  return edges;
}

/** Same-directory files of the same package that declare identifiers the body uses unqualified. */
function referenceEdges(ctx: GoCtx, code: string, importNames: ReadonlySet<string>): ResolvedImport[] {
  const files = ctx.probe.packageFiles(ctx.importerDir);
  const siblings = (ctx.isTest ? [...files.source, ...files.tests] : files.source).filter((f) => f !== ctx.file);
  if (siblings.length === 0) return [];
  const samePackage = siblings.filter((f) => {
    if (ctx.pkg === undefined) return true;
    const pkg = declarationsOfFile(ctx.probe, f).pkg;
    return pkg === undefined || pkg === ctx.pkg;
  });
  if (samePackage.length === 0) return [];
  const index = declaredIndex(ctx.probe, `ref:${ctx.importerDir}:${ctx.isTest ? "t" : "s"}:${ctx.pkg ?? ""}:${ctx.file}`, samePackage);
  if (index.size === 0) return [];
  const byFile = new Map<string, { names: string[]; line: number }>();
  for (const use of unqualifiedUses(code, importNames)) {
    const owner = index.get(use.name);
    if (owner === undefined) continue;
    const entry = byFile.get(owner);
    if (entry === undefined) {
      if (byFile.size < MAX_REFERENCE_FILES) byFile.set(owner, { names: [use.name], line: use.line });
    } else if (entry.names.length < MAX_NAMES_PER_EDGE) entry.names.push(use.name);
  }
  return [...byFile].map(([file, entry]) => ({ path: file, line: entry.line, kind: "reference" as const, names: uniqueNames(entry.names) }));
}

/** Names the file's imports bind (aliases and the unaliased last segment): package qualifiers, never package-level uses. */
function importNamesOf(specs: readonly GoImportSpec[]): Set<string> {
  const names = new Set<string>();
  for (const spec of specs) {
    if (spec.alias !== undefined) names.add(spec.alias);
    else names.add(packageSegmentOf(spec.path));
  }
  return names;
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

function resolveGoImportsUnchecked(workspace: string, filePath: string, lines: readonly string[]): ResolvedImport[] {
  const file = filePath.replace(/\\/g, "/");
  const text = lines.join("\n").replace(/^\uFEFF/, "");
  if (text.trim().length === 0) return [];
  const commentFree = maskGo(text, true);
  const specs = parseGoImports(commentFree).slice(0, MAX_STATEMENTS);
  const probe = new Probe(workspace);
  const importerDir = posixDirname(file);
  const isTest = file.endsWith("_test.go");

  let pkg = packageClauseOf(commentFree);
  if (pkg === undefined) {
    // A served slice may not hold the `package` line: read the file's head.
    const head = readHead(workspace, file, 8 * 1024);
    if (head !== undefined) pkg = packageClauseOf(maskGo(head, true));
  }
  const ctx: GoCtx = { probe, file, importerDir, isTest, pkg, modules: { entries: [] } };
  let codeOnly: string | undefined;
  const code = (): string => (codeOnly ??= maskGo(text, false));
  let qualified: Map<string, string[]> | undefined;
  const uses = (): Map<string, string[]> => (qualified ??= qualifiedUses(code()));

  const edges: ResolvedImport[] = [];
  // A module named like a standard-library root claims its paths before the stdlib rule applies, so the table is always read.
  if (specs.length > 0) ctx.modules = moduleTableFor(probe, importerDir);
  for (const spec of specs) edges.push(...importEdges(ctx, spec, uses));
  edges.push(...referenceEdges(ctx, code(), importNamesOf(specs)));
  return edges;
}

/**
 * Go import and same-package edges of `filePath`. Total: the neighbour and
 * inventory hooks run inside every pack while their flags are on, so an
 * unforeseen failure here yields no edges instead of failing the pack.
 */
export function resolveGoImports(workspace: string, filePath: string, lines: readonly string[]): ResolvedImport[] {
  try {
    return insideWorkspace(workspace, resolveGoImportsUnchecked(workspace, filePath, lines));
  } catch {
    return [];
  }
}
