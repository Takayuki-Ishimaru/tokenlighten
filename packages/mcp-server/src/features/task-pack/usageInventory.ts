/**
 * usageInventory.ts — V15-FUI (2026-09-29), `TL_USAGE_INVENTORY`, default
 * OFF. The second of two independent v0.15.0 candidate prototypes prepared
 * for a small paid A/B engagement probe (measure-v015/REPORT.md's FUI
 * section; ideation-v015-fable.md candidate 5) — the USER decides adoption
 * from the probe, not this wave.
 *
 * MEASUREMENT THIS ANSWERS. 1.88 `tl_search_files find` calls/cell (52% of the
 * 3.82 finds/cell in the 09-20 Claude Code bench) query an identifier that
 * is ALREADY present in the first pack's served bodies — the model re-finds
 * something it already holds. Upper bound ~5.8% of cell cost if the model
 * trusts the inventory instead of searching (measure-v015/REPORT.md's FUI
 * row); this ships OFF because that trust is model behaviour a replay
 * cannot observe, and Probe-2's own counter-evidence is "solvers sweep even
 * when the evidence is already in the pack".
 *
 * WHAT THIS ADDS. `attachUsageInventory` appends `result.usages` (wired onto
 * `plan.usages` by readFamily.ts's PLAN_MEMBERS): for up to 8 identifiers the
 * served code is about, a LEXICAL match inventory —
 * `{symbol, files:[{path, lines}], total, inventory_complete, scope?}` — built
 * from `features/search/find/findText.ts`'s `scanLiteral`, THE SAME scanner
 * `tl_search_files find` uses (same walk, same ignore rules, same line
 * splitting — but the walk's size ceiling is `walkCodeFiles`'s default 1 MB,
 * not `find`'s 8 MiB: a bounded pack build), driven with an explicit
 * word-boundary regex so a search for `run` never matches inside `runner`.
 * This is deliberately NEVER called "callers" anywhere in this module, its
 * field names, or its wire projection: it is a text-match count, not a
 * call-graph — a symbol used only in a comment or a string literal is
 * indistinguishable here from a real call site, exactly as a literal
 * `tl_search_files find` result would be. `inventory_complete` is honest per
 * symbol: false the moment this response withholds a file or a line the TRUE
 * match set (within `scope`) had, never a blanket claim — a file the walk's
 * size ceiling skipped, a directory it could not list, a file the scan could
 * not read or decode, or a scope of over 6,000 files each make it false
 * (`find`'s own "involuntary" omissions; deliberate ones — ignore rules,
 * symlinks, non-text — define the scan and do not).
 *
 * WHICH SYMBOLS (relevance, not position). Candidates are (a) the declarations
 * of the served CODE slices (`declarationsIn`; a method name only when it is
 * distinctive or the request matches it) and (b) the identifiers the served
 * code slices REFERENCE: CONST_CASE and PascalCase tokens, the member `Y` of a
 * qualified `X.Y` / `X::Y` / `X->Y` (when Y is a constant/type, or a distinctive
 * name on a project type), any identifier the request names, a distinctive
 * name (an underscore or camelCase hump, ≥ 6 characters) that shares a concept
 * term with it, and hyphenated/dotted tokens inside string literals or
 * stylesheets (CSS classes, config keys, event names) that contain a request
 * concept term — minus comments, import statements, language keywords,
 * builtins, very common library names and a generic stoplist
 * (`USAGE_SYMBOL_STOPLIST`; an identifier the request names explicitly is
 * exempt). A plain lower-case word that merely echoes a domain noun of the
 * request (a parameter, a local: `order`, `invoice`) is never a candidate.
 * ONLY CODE SURFACES (`surfaceKindOf`: a language `languageFamilyOf` knows or
 * another source extension) contribute those; a stylesheet contributes its
 * hyphenated names, a template (`.html`, `.vue`, …) only its string-literal keys,
 * and documentation/prose/data (`.md`, `.rst`, `.txt`, `.adoc`, `.json`, …,
 * anything else) only inline backticked spans that look like identifiers — a
 * CHANGELOG's `Fixed`, `Issue`, `Windows` are never symbols. A concept term
 * that names the served file's own PROJECT (a sub-word of its root directory's
 * or manifest's name: `projectNameTermsOf`) is ignored for that file's
 * candidates, and so is a concept term that is a sub-word of more than half of
 * a candidate pool of at least 6 (it tells the candidates apart no better than
 * no term at all: `order` in an order service). They are ranked:
 *   1. identifiers the query names (exact case, then any case) — the MEMBER
 *      of a named `A.b` / `A::b` / `A#b` is the subject; the qualifier `A`,
 *      unless the query also names it alone, only the place to look, so it
 *      joins tier 2 at its top;
 *   2. candidates with a concept-term sub-word match (`conceptTermsIn`: EN
 *      stems, JA glossary stems) — referenced constants, types and enum
 *      members before others;
 *   3. constants, enum members and types the FIRST served surface's slice
 *      references but does not declare (declared elsewhere);
 *   4. declarations of the first served surface, exported first;
 *   5. the rest.
 * Inside a tier the identifiers the served code REFERENCES but no served slice
 * DECLARES come before the served declarations (the model already holds those
 * definitions and searches for the others far more often), the most used in the
 * first served surface's slice first.
 * Candidates are inventoried lazily in that order (≤ 14 scans, fewer in a scope
 * of over 1,500 files); one is dropped when it has no match or when EVERY
 * match lies inside the slices this response already served. Inside a tier a
 * candidate matched on more than 200 lines of its scope ranks below the less
 * ubiquitous ones (a class name used 5,000 times says nothing); scanning goes on
 * past the eighth survivor only while such a candidate could still be displaced.
 *
 * SCOPE. A common name must not match files of unrelated projects, so the scan
 * covers one directory, `inventoryScopeOf`: the nearest project root
 * (`projectRootsOf`, ignoring config-only manifests such as a `tsconfig.json`
 * beside a `package.json`), climbing to an ancestor root only while that
 * ancestor declares the nested one as a member of the same build — npm/yarn
 * `workspaces`, `pnpm-workspace.yaml`, `lerna.json`, `go.work` `use`, Cargo `[workspace]`
 * `members`, uv `[tool.uv.workspace]`, Maven `<modules>`, Gradle
 * `include`, CMake `add_subdirectory`, Meson `subdir`. A listed directory is a
 * member only when it holds THAT ecosystem's own manifest (package.json for
 * npm/pnpm/lerna, go.mod for go.work, Cargo.toml, pyproject.toml for uv, pom.xml,
 * build.gradle(.kts), CMakeLists.txt, meson.build): an npm `workspaces:
 * ["apps/*"]` says nothing about `apps/api/go.mod`. Member globs (`*`, `?`,
 * `**`; braces are literal) are matched by `globMatchesPath` (importGraphShared.ts),
 * linear in the pattern and the path — a hostile manifest cannot stall a pack. An
 * ancestor manifest that does not list the project stops the climb; no project
 * root at all means the whole workspace. The wire's `scope` names the directory
 * scanned and is omitted for a whole-workspace scan; `inventory_complete` is
 * complete WITHIN that scope. Not covered: Bazel/Buck packages, Nx/Rush project
 * graphs, Go modules without `go.work`, Python path dependencies, Makefile-only
 * builds (their nearest directory holding a manifest is used as the scope).
 *
 * ENTRIES (breadth over depth). Every entry is compact: ≤ 4 files, ≤ 3 lines per
 * file; `total` stays the exact number of matching lines and
 * `inventory_complete` is false once anything was cut. The file whose matched
 * line DECLARES the symbol (`declaresSymbol`: `const|let|var|val|type|func|def|
 * class|struct|enum|interface|#define|typedef|using … =` or an assignment to
 * the name; else `declarationsIn` of a few likely files, over the lines the scan
 * already holds) is listed first and that line is never cut; then files with a
 * match the model does not hold, then the files whose matches it holds. ≤ 8
 * symbols and ≤ 1.5 KiB serialized (less when the pack has less room left:
 * `PlanAidOptions.headroom`, the cap being `min(1.5 KiB, headroom − 48)` and
 * nothing attached under 120 bytes): while over, LINES per file are trimmed (down
 * to one), then FILES per symbol (down to one), starting with the LOWEST-ranked
 * entry each time; only when every entry is one file of one line are entries
 * dropped, lowest-ranked first. Rank order is never changed. Aim: 6–8 symbols
 * inside the 1.5 KiB of a typical pack. Only the first 2,000 characters of a
 * query are examined.
 *
 * DECLARATION SCAN. See declarationScan.ts (`declarationsIn`); every regex
 * there is a generic syntax scan, not keyed to any fixture-specific name.
 *
 * OFF (default): `attachUsageInventory` returns on its first line. Nothing
 * else in this module ever runs; a pack is byte-identical to pre-FUI output
 * by construction.
 */
import * as fs from "fs";
import * as path from "path";
import { scanLiteral, escapeRegExp, createScanContentCache, createScanCoverage, type ScanCoverage } from "../search/find/findText.js";
import { walkCodeFiles, createWalkOmissions, type FoundFile } from "../../tools/walkRepo.js";
import { usageInventoryEnabled } from "../../util/flags.js";
import { declarationsIn, type DeclaredSymbol } from "./declarationScan.js";
import {
  GENERIC_IDENTIFIER_STOPLIST,
  STRONG_PROJECT_MANIFESTS,
  codeLinesOutsideImports,
  listDirectoryChecked,
  parseLineRange,
  planAidCap,
  projectNameTermsOf,
  projectRootsChecked,
  readCapped,
  requestTermsOf,
  servedTextOf,
  stripTrailingComment,
  subWordForms,
  withoutProjectTerms,
  type PlanAidOptions,
  type RequestTerms,
} from "./frontierNeighbours.js";
import { globMatchesPath, posixDirname, posixJoin, realPathInside, withinWorkspace } from "./importGraphShared.js";
import { languageFamilyOf } from "./importResolution.js";
import type { TaskPackResult, TaskPackSurface } from "./model.js";

/** Up to 8 identifiers per pack (was 6: models search what the served code references, and 8 compact entries fit the cap). */
const MAX_SYMBOLS = 8;
/** Per-symbol caps (breadth over depth: one popular symbol must not eat the budget of the rest). */
const MAX_FILES_PER_SYMBOL = 4;
const MAX_LINES_PER_FILE = 3;
/** ~1.5 KiB total, serialized (was 1 KiB: ranked entries carry a `scope`). */
const MAX_USAGES_BYTES = 1536;
/** A candidate matching more lines than this in its scope ranks below the less ubiquitous ones of its tier. */
const UBIQUITOUS_TOTAL = 200;
/** A concept term that is a sub-word of more than half of a candidate pool this large discriminates nothing. */
const UBIQUITY_MIN_POOL = 6;
/** Member globs read per manifest (a hostile manifest cannot make one lookup walk thousands of patterns). */
const MAX_MEMBER_PATTERNS = 1024;
/** Matched lines tested for "this line declares the symbol" per candidate. */
const MAX_DECLARATION_TESTS = 4000;
/** Declaring-file lookup through `declarationsIn`: files tried per finalist, and the matched-file count above which it is skipped. */
const DECLARATION_FALLBACK_FILES = 3;
const DECLARATION_FALLBACK_MAX_FILES = 60;
const DECLARATION_FALLBACK_MAX_LINES = 6000;
/** Candidates inventoried (scanned) per pack, however many survive (the survivors wanted: `MAX_SYMBOLS`). */
const MAX_EVALUATED = 14;
/** Served surfaces whose slices are read. */
const MAX_SURFACES = 8;
/** Candidate symbols kept before ranking. */
const MAX_POOL = 300;
/** Code lines read for references across all served slices. */
const MAX_TOTAL_LINES = 20000;
/** A served slice is read up to this many characters (a real pack slice is far smaller). */
const MAX_SLICE_CHARS = 256 * 1024;
/** Files scanned per scope; a larger scope is scanned from its first files and never claimed complete. */
const MAX_SCAN_FILES = 6000;
/** Manifest files read for scope membership. */
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_LITERAL_CHARS = 60;

export interface UsageEntry {
  symbol: string;
  files: Array<{ path: string; lines: number[] }>;
  total: number;
  inventory_complete: boolean;
  /** Workspace-relative directory the scan covered; absent when the whole workspace was scanned. */
  scope?: string;
}

// ---------------------------------------------------------------------------
// Stoplist — keywords, builtins, very common library names, generic words
// ---------------------------------------------------------------------------

const LANGUAGE_KEYWORDS = [
  // JS/TS
  "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "else", "enum", "export",
  "extends", "false", "finally", "for", "function", "import", "instanceof", "new", "null", "return", "super", "switch",
  "this", "throw", "true", "try", "typeof", "var", "void", "while", "with", "yield", "let", "static", "async", "await",
  "from", "type", "interface", "implements", "package", "private", "protected", "public", "readonly", "abstract",
  "declare", "namespace", "module", "require", "undefined", "unknown", "never", "string", "number", "boolean", "object",
  "symbol", "bigint", "keyof", "infer", "constructor", "prototype", "console", "promise", "array", "date", "regexp",
  "weakmap", "weakset", "buffer", "process", "window", "document", "global", "globalthis", "exports", "length",
  "tostring", "valueof", "hasownproperty", "json", "math", "number", "record", "partial", "pick", "omit", "readonly",
  "required", "exclude", "extract", "nonnullable", "returntype", "parameters", "awaited", "iterable", "iterator",
  // Python
  "and", "assert", "def", "del", "elif", "except", "global", "lambda", "nonlocal", "not", "pass", "raise", "self", "cls",
  "print", "len", "range", "str", "int", "float", "bool", "list", "dict", "tuple", "set", "isinstance", "super", "open",
  "enumerate", "zip", "map", "filter", "sorted", "sum", "min", "max", "abs", "any", "all", "format", "exception",
  "valueerror", "typeerror", "keyerror", "runtimeerror", "notimplementederror", "attributeerror", "indexerror", "oserror",
  "none", "optional", "union", "callable", "typevar", "generic", "abc", "dataclass", "dataclasses", "typing", "pytest",
  "unittest", "logging", "sys", "os", "re", "np", "pd", "plt",
  // Go
  "chan", "defer", "fallthrough", "func", "go", "goto", "range", "select", "struct", "nil", "iota", "int8", "int16",
  "int32", "int64", "uint", "uint8", "uint16", "uint32", "uint64", "float32", "float64", "byte", "rune", "error", "make",
  "append", "cap", "copy", "panic", "recover", "println", "fmt", "err", "ctx", "context", "errors", "strings", "strconv",
  "time", "sync", "http", "testing", "bytes", "bufio", "sort", "math",
  // Java / Kotlin / C#
  "boolean", "byte", "char", "double", "extends", "final", "long", "native", "short", "strictfp", "synchronized",
  "throws", "transient", "volatile", "integer", "character", "stringbuilder", "system", "objects", "arrays",
  "collections", "stream", "collectors", "optional", "arraylist", "hashmap", "hashset", "override", "deprecated",
  "suppresswarnings", "runnable", "thread", "runtimeexception", "logger", "loggerfactory", "fun", "val", "when",
  "companion", "sealed", "internal", "open", "lateinit", "suspend", "unit", "mockito", "junit", "lombok", "slf4j",
  // C / C++
  "auto", "extern", "inline", "register", "restrict", "signed", "sizeof", "typedef", "union", "unsigned", "volatile",
  "nullptr", "template", "typename", "virtual", "explicit", "operator", "using", "std", "vector", "size_t", "ssize_t",
  "uint8_t", "uint16_t", "uint32_t", "uint64_t", "int8_t", "int16_t", "int32_t", "int64_t", "include", "define", "ifdef",
  "ifndef", "endif", "pragma", "printf", "malloc", "free", "memcpy", "memset", "strlen", "strcmp", "assert",
  // exceptions every ecosystem ships
  "illegalstateexception", "illegalargumentexception", "nullpointerexception", "unsupportedoperationexception",
  "numberformatexception", "indexoutofboundsexception", "ioexception", "interruptedexception", "timeoutexception",
  "throwable", "assertionerror", "syntaxerror", "rangeerror", "referenceerror", "stopiteration", "keyboardinterrupt",
  "systemexit", "filenotfounderror", "importerror", "lookuperror", "zerodivisionerror", "arithmeticexception",
  // very common library / framework names
  "react", "usestate", "useeffect", "useref", "usememo", "usecallback", "usecontext", "redux", "express", "lodash",
  "axios", "moment", "jest", "vitest", "describe", "expect", "beforeeach", "aftereach", "component", "props", "jsx",
  "tsx", "vue", "angular", "django", "flask", "numpy", "pandas", "requests", "spring", "gradle", "maven",
];

/**
 * Identifiers that are never worth inventorying on their own (lower case;
 * compared case-insensitively): language keywords, builtins, very common
 * library names, and the generic stoplist (`get`, `set`, `run`, `main`,
 * `init`, `data`, `value`, `self`, `this`, …). An identifier the request names
 * explicitly is exempt.
 */
export const USAGE_SYMBOL_STOPLIST: ReadonlySet<string> = new Set([...GENERIC_IDENTIFIER_STOPLIST, ...LANGUAGE_KEYWORDS]);

function isStoplisted(symbol: string): boolean {
  return USAGE_SYMBOL_STOPLIST.has(symbol.toLowerCase());
}

// ---------------------------------------------------------------------------
// Scope — which directory one symbol's inventory scans
// ---------------------------------------------------------------------------

interface MemberSpec {
  include: string[];
  exclude: string[];
}

function normalizeDirPattern(pattern: string): string {
  const cleaned = pattern.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  return cleaned === "." ? "" : cleaned;
}

function specFrom(include: readonly string[], exclude: readonly string[] = []): MemberSpec | null {
  const inc = include.map(normalizeDirPattern).filter((p) => p.length > 0).slice(0, MAX_MEMBER_PATTERNS);
  if (inc.length === 0) return null;
  return { include: inc, exclude: exclude.map(normalizeDirPattern).filter((p) => p.length > 0).slice(0, MAX_MEMBER_PATTERNS) };
}

/** Split `!negated` patterns (npm/pnpm style) from plain ones. */
function specFromNegatable(patterns: readonly string[]): MemberSpec | null {
  return specFrom(
    patterns.filter((p) => !p.trim().startsWith("!")),
    patterns.filter((p) => p.trim().startsWith("!")).map((p) => p.trim().slice(1)),
  );
}

function quotedStrings(text: string): string[] {
  return [...text.matchAll(/["'`]([^"'`]+)["'`]/g)].map((m) => m[1]!);
}

function parsePackageJson(text: string): MemberSpec | null {
  const json = JSON.parse(text) as { workspaces?: unknown };
  const ws = json.workspaces;
  const list = Array.isArray(ws)
    ? ws
    : ws !== null && typeof ws === "object" && Array.isArray((ws as { packages?: unknown }).packages)
      ? (ws as { packages: unknown[] }).packages
      : undefined;
  return list === undefined ? null : specFromNegatable(list.filter((x): x is string => typeof x === "string"));
}

function parsePnpmWorkspace(text: string): MemberSpec | null {
  const patterns: string[] = [];
  let inPackages = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const key = /^packages\s*:\s*(.*)$/.exec(line);
    if (key) {
      inPackages = true;
      patterns.push(...quotedStrings(key[1] ?? "")); // inline `packages: ["a", "b"]`
      continue;
    }
    if (/^\S/.test(line)) {
      inPackages = false;
      continue;
    }
    if (!inPackages) continue;
    const item = /^\s*-\s*(.+?)\s*(?:#.*)?$/.exec(line);
    if (item) patterns.push(item[1]!.replace(/^["']|["']$/g, ""));
  }
  return specFromNegatable(patterns);
}

function parseGoWork(text: string): MemberSpec | null {
  const clean = text.replace(/\/\/.*$/gm, "");
  const dirs: string[] = [];
  for (const block of clean.matchAll(/^\s*use\s*\(([^)]*)\)/gm)) {
    for (const line of block[1]!.split(/\r?\n/)) {
      const dir = line.trim().replace(/^["'`]|["'`]$/g, "");
      if (dir.length > 0) dirs.push(dir);
    }
  }
  for (const single of clean.matchAll(/^\s*use\s+(?!\()(\S+)/gm)) dirs.push(single[1]!.replace(/^["'`]|["'`]$/g, ""));
  return specFrom(dirs);
}

function tomlArray(body: string, key: string): string[] | undefined {
  const m = new RegExp(`\\b${key}\\s*=\\s*\\[([^\\]]*)\\]`).exec(body);
  return m ? quotedStrings(m[1]!) : undefined;
}

function tomlWorkspace(text: string, header: RegExp): MemberSpec | null {
  const m = header.exec(text);
  if (!m) return null;
  const rest = text.slice(m.index + m[0].length);
  const next = rest.search(/^\s*\[/m);
  const body = (next === -1 ? rest : rest.slice(0, next)).replace(/#.*$/gm, "");
  const members = tomlArray(body, "members");
  return members === undefined ? null : specFrom(members, tomlArray(body, "exclude") ?? []);
}

function parseLerna(text: string): MemberSpec | null {
  const json = JSON.parse(text) as { packages?: unknown };
  return Array.isArray(json.packages) ? specFromNegatable(json.packages.filter((x): x is string => typeof x === "string")) : null;
}

const parseCargoWorkspace = (text: string): MemberSpec | null => tomlWorkspace(text, /^\s*\[workspace\]\s*$/m);
const parseUvWorkspace = (text: string): MemberSpec | null => tomlWorkspace(text, /^\s*\[tool\.uv\.workspace\]\s*$/m);

function parsePom(text: string): MemberSpec | null {
  const clean = text.replace(/<!--[\s\S]*?-->/g, "");
  const dirs: string[] = [];
  for (const block of clean.matchAll(/<modules>([\s\S]*?)<\/modules>/g)) {
    for (const m of block[1]!.matchAll(/<module>\s*([^<]+?)\s*<\/module>/g)) {
      const value = m[1]!.replace(/\\/g, "/");
      dirs.push(/\.xml$/i.test(value) ? path.posix.dirname(value) : value);
    }
  }
  return specFrom(dirs);
}

function parseGradleSettings(text: string): MemberSpec | null {
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const dirs: string[] = [];
  for (const m of clean.matchAll(/\binclude\s*\(?\s*((?:["'][^"'\n]+["']\s*,?\s*)+)\)?/g)) {
    for (const name of quotedStrings(m[1]!)) dirs.push(name.replace(/^:/, "").replace(/:/g, "/"));
  }
  return specFrom(dirs);
}

function parseCMake(text: string): MemberSpec | null {
  const clean = text.replace(/#.*$/gm, "");
  const dirs: string[] = [];
  for (const m of clean.matchAll(/\badd_subdirectory\s*\(\s*(?:"([^"]+)"|([^\s)"]+))/gi)) {
    const dir = m[1] ?? m[2];
    if (dir !== undefined && !dir.includes("$")) dirs.push(dir);
  }
  return specFrom(dirs);
}

function parseMeson(text: string): MemberSpec | null {
  const clean = text.replace(/#.*$/gm, "");
  const dirs: string[] = [];
  for (const m of clean.matchAll(/\bsubdir\s*\(\s*['"]([^'"]+)['"]/g)) dirs.push(m[1]!);
  return specFrom(dirs);
}

/**
 * Manifest → parser → the manifests a member directory of that ecosystem holds. Each source names members of a build
 * relative to the manifest's own directory; a directory it lists counts as a member only when it holds one of the
 * ecosystem's OWN manifests (an npm `workspaces: ["apps/*"]` says nothing about `apps/api/go.mod`).
 */
const MEMBER_SOURCES: ReadonlyArray<readonly [string, (text: string) => MemberSpec | null, readonly string[]]> = [
  ["package.json", parsePackageJson, ["package.json"]],
  ["pnpm-workspace.yaml", parsePnpmWorkspace, ["package.json"]],
  ["lerna.json", parseLerna, ["package.json"]],
  ["go.work", parseGoWork, ["go.mod"]],
  ["Cargo.toml", parseCargoWorkspace, ["Cargo.toml"]],
  ["pyproject.toml", parseUvWorkspace, ["pyproject.toml"]],
  ["pom.xml", parsePom, ["pom.xml"]],
  ["settings.gradle", parseGradleSettings, ["build.gradle", "build.gradle.kts"]],
  ["settings.gradle.kts", parseGradleSettings, ["build.gradle", "build.gradle.kts"]],
  ["CMakeLists.txt", parseCMake, ["CMakeLists.txt"]],
  ["meson.build", parseMeson, ["meson.build"]],
];

const manifestCache = new Map<string, { mtimeMs: number; size: number; spec: MemberSpec | null }>();

/** Members a manifest declares, cached per absolute path and validated by mtime + size. */
function readMemberSpec(workspace: string, dir: string, name: string, parse: (text: string) => MemberSpec | null): MemberSpec | null {
  const rel = posixJoin(dir, name);
  const abs = withinWorkspace(workspace, rel);
  // A manifest that is a symlink out of the workspace is never stat'ed or read: it declares nothing.
  if (abs === undefined || !realPathInside(workspace, rel)) return null;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) return null;
  const hit = manifestCache.get(abs);
  if (hit !== undefined && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.spec;
  let spec: MemberSpec | null = null;
  const file = readCapped(workspace, posixJoin(dir, name), MAX_MANIFEST_BYTES);
  if (file !== undefined) {
    try {
      spec = parse(file.text);
    } catch {
      spec = null;
    }
  }
  if (manifestCache.size > 512) manifestCache.clear();
  manifestCache.set(abs, { mtimeMs: stat.mtimeMs, size: stat.size, spec });
  return spec;
}

/** A regular file `name` directly inside `dir` ("" = the workspace root); a symlink pointing out of the workspace is never stat'ed. */
function holdsFile(workspace: string, dir: string, name: string): boolean {
  const rel = posixJoin(dir, name);
  const abs = withinWorkspace(workspace, rel);
  if (abs === undefined || !realPathInside(workspace, rel)) return false;
  try {
    return fs.statSync(abs).isFile();
  } catch {
    return false;
  }
}

/**
 * Does `spec` list the directory `rel` — or an ancestor directory of it — as a member, without excluding it, and does
 * that member directory hold its ecosystem's own manifest (`holdsManifest`, given the member directory relative to the
 * manifest that lists it)? Globs go through `globMatchesPath`: linear, so no manifest can stall the lookup.
 */
function specCovers(spec: MemberSpec, rel: string, holdsManifest: (memberRel: string) => boolean): boolean {
  const segments = rel.split("/");
  const prefixes = segments.map((_, i) => segments.slice(0, i + 1).join("/"));
  const listed = (patterns: readonly string[], target: string): boolean => patterns.some((pattern) => globMatchesPath(pattern, target));
  const members = prefixes.filter((prefix) => listed(spec.include, prefix));
  if (members.length === 0) return false;
  if (prefixes.some((prefix) => listed(spec.exclude, prefix))) return false;
  return members.some(holdsManifest);
}

/** Does the build manifest in `ancestorDir` declare `memberDir` (a descendant) as a member of the same build? */
function declaresMember(workspace: string, ancestorDir: string, memberDir: string): boolean {
  const rel = ancestorDir === "" ? memberDir : memberDir.slice(ancestorDir.length + 1);
  if (rel === "" || rel.startsWith("..")) return false;
  const listing = new Set(listDirectoryChecked(workspace, ancestorDir));
  for (const [name, parse, memberManifests] of MEMBER_SOURCES) {
    if (!listing.has(name)) continue;
    const spec = readMemberSpec(workspace, ancestorDir, name, parse);
    if (spec === null) continue;
    const holdsManifest = (memberRel: string): boolean =>
      memberManifests.some((manifest) => holdsFile(workspace, posixJoin(ancestorDir, memberRel), manifest));
    if (specCovers(spec, rel, holdsManifest)) return true;
  }
  return false;
}

/**
 * The directory (workspace-relative POSIX; "" = the whole workspace) that
 * one served surface's symbols are inventoried over — see the module doc's
 * SCOPE section. Deterministic; reads only directory listings of the
 * surface's ancestors and the small build manifests among them (cached by
 * mtime + size).
 */
export function inventoryScopeOf(workspace: string, surfacePath: string): string {
  const roots = projectRootsChecked(workspace, surfacePath);
  if (roots.length === 0) return "";
  const strong = roots.filter((dir) => listDirectoryChecked(workspace, dir).some((name) => STRONG_PROJECT_MANIFESTS.has(name)));
  const chain = strong.length > 0 ? strong : roots;
  let scope = chain[0]!;
  for (const ancestor of chain.slice(1)) {
    if (!declaresMember(workspace, ancestor, scope)) break;
    scope = ancestor;
  }
  return scope;
}

// ---------------------------------------------------------------------------
// Surfaces — only code contributes identifiers
// ---------------------------------------------------------------------------

/**
 * How a served surface may contribute candidates: `code` (declarations, references, string keys),
 * `style` (hyphenated class / custom-property names), `markup` (string-literal keys only: a template's
 * text is prose), `prose` (documentation, changelogs, data, anything else: inline backticked code spans only).
 */
export type SurfaceKind = "code" | "style" | "markup" | "prose";

const STYLE_EXTENSIONS = [".css", ".scss", ".sass", ".less", ".styl"];
const MARKUP_EXTENSIONS: ReadonlySet<string> = new Set([
  ".html", ".htm", ".xhtml", ".vue", ".svelte", ".astro", ".erb", ".ejs", ".hbs", ".njk", ".jinja", ".j2",
]);
/** Source languages `languageFamilyOf` has no resolver for (the families it knows count as code too). */
const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".rs", ".rb", ".php", ".cs", ".swift", ".scala", ".sc", ".groovy", ".lua", ".dart", ".r", ".jl", ".ex", ".exs", ".erl",
  ".hs", ".ml", ".mli", ".clj", ".cljs", ".pl", ".pm", ".sh", ".bash", ".zsh", ".ps1", ".sql", ".zig", ".nim", ".vb", ".fs",
  ".fsx", ".elm", ".cr",
]);

export function surfaceKindOf(filePath: string): SurfaceKind {
  const ext = path.posix.extname(filePath.replace(/\\/g, "/")).toLowerCase();
  if (STYLE_EXTENSIONS.includes(ext)) return "style";
  if (MARKUP_EXTENSIONS.has(ext)) return "markup";
  if (languageFamilyOf(filePath) !== undefined || SOURCE_EXTENSIONS.has(ext)) return "code";
  return "prose";
}

const INLINE_CODE_SPAN_RE = /(?<!`)(`{1,2})(?!`)([^`\n]{1,120}?)\1(?!`)/g;
const IDENTIFIER_SPAN_RE = /^[A-Za-z_$][\w$]*(?:(?:\.|::|#|->)[A-Za-z_$][\w$]*)*(?:\(\))?$/;
const MAX_PROSE_LINES = 6000;

/**
 * The inline backticked spans of a prose surface that look like identifiers (`Foo`, `Foo.bar()`, `a::b`), fenced
 * code blocks excluded — the only thing a documentation surface contributes.
 */
export function proseCodeSpans(text: string): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const line of text.split(/\r?\n/, MAX_PROSE_LINES)) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    for (const m of line.matchAll(INLINE_CODE_SPAN_RE)) {
      const content = m[2]!.trim();
      if (IDENTIFIER_SPAN_RE.test(content)) out.push(content.replace(/\(\)$/, ""));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

export type UsageKind = "function" | "type" | "constant" | "variable" | "member" | "enum-member" | "macro" | "literal" | "identifier";

/** One identifier the served code is about, before ranking. */
export interface UsageCandidate {
  symbol: string;
  /** Position in `result.surfaces` of the first served surface that declares or references it. */
  surfaceIndex: number;
  /** Path of that surface: its project decides the inventory's scope. */
  path: string;
  kind: UsageKind;
  /** Some served slice declares it. */
  declared: boolean;
  /** Position of the surface whose slice declares it; -1 when none does. */
  declSurface: number;
  exported: boolean;
  /** Occurrences in the first served surface's slice (0 when it only appears elsewhere). */
  refs0: number;
  /** Found inside a string literal / style file (a CSS class, config key or event name). */
  literal: boolean;
  /** Qualifier of an `X.Y` / `X::Y` reference. */
  qualifier?: string;
  /** Enclosing type of a declared member (`declarationsIn`'s `container`): an enum's members, a Go method's receiver. */
  container?: string;
  /** First-appearance order over all served slices. */
  order: number;
}

/** One served slice the candidates are read from. */
export interface UsageSlice {
  index: number;
  path: string;
  text: string;
}

export interface RankedUsage extends UsageCandidate {
  /** 1 query-named, 2 concept match (or the qualifier of a named `A.b`), 3 referenced elsewhere, 4 declared by the first surface, 5 the rest. */
  category: 1 | 2 | 3 | 4 | 5;
  score: number;
}

/** Project-name terms per served file (`projectNameTermsOf`): a request concept term equal to one names the project itself and is ignored. */
export interface UsageProjectOptions {
  projectTermsOf?: (surfacePath: string) => ReadonlySet<string> | undefined;
}

const CONST_LIKE: ReadonlySet<UsageKind> = new Set<UsageKind>(["constant", "enum-member", "type", "macro"]);
const CONST_CASE_RE = /^[A-Z][A-Z0-9_]*$/;
const PASCAL_RE = /^[A-Z][A-Za-z0-9]*$/;
const IDENT_TOKEN_RE = /[A-Za-z_$][\w$]*/g;
const QUALIFIED_RE = /([A-Za-z_$][\w$]*)\s*(?:\?\.|\.|::|->)\s*([A-Za-z_$][\w$]*)/g;
const STRING_LITERAL_RE = /(["'])((?:\\.|(?!\1).){0,200})\1/g;
const LITERAL_TOKEN_RE = /-{0,2}[A-Za-z_][\w]*(?:[-.:][A-Za-z0-9_]+)+/g;
const STYLE_TOKEN_RE = /-{0,2}[A-Za-z_][\w]*(?:-[A-Za-z0-9_]+)+/g;
const FILE_LIKE_LITERAL_RE = /\.(?:js|jsx|ts|tsx|json|css|scss|less|html|md|py|go|java|kt|c|h|cc|cpp|yml|yaml|toml|xml|txt|csv|png|jpg|svg|gif|lock)$/i;
const QUALIFIER_SKIP = new Set(["this", "self", "cls", "super"]);

function isConstCase(token: string): boolean {
  return CONST_CASE_RE.test(token) && (token.includes("_") || token.length >= 4) && /[A-Z]{2}/.test(token);
}

function isPascal(token: string): boolean {
  return token.length >= 4 && PASCAL_RE.test(token) && /[a-z]/.test(token);
}

function isDistinctive(token: string): boolean {
  return token.length >= 6 && (token.includes("_") || /[a-z][A-Z]/.test(token));
}

function inferKind(symbol: string): UsageKind {
  if (isConstCase(symbol)) return "constant";
  if (isPascal(symbol)) return "type";
  return "identifier";
}

/** A token matches the request when it is an explicit identifier or shares a concept-term sub-word with it. */
function matchesRequest(token: string, terms: RequestTerms): boolean {
  if (!terms.present) return false;
  if (terms.identifiers.includes(token)) return true;
  const fold = token.toLowerCase();
  if (terms.identifiers.some((id) => id.toLowerCase() === fold)) return true;
  if (terms.concepts.length === 0) return false;
  const forms = subWordForms(token);
  return terms.concepts.some((term) => forms.has(term));
}

/** `matchesRequest` remembered per distinct token (a slice repeats the same few hundred tokens thousands of times). */
function memoizedMatcher(terms: RequestTerms): (token: string) => boolean {
  const memo = new Map<string, boolean>();
  return (token) => {
    let hit = memo.get(token);
    if (hit === undefined) {
      hit = matchesRequest(token, terms);
      memo.set(token, hit);
    }
    return hit;
  };
}

function containerIsAboutRequest(container: string, terms: RequestTerms): boolean {
  if (isNamedByRequest(container, terms)) return true;
  if (terms.concepts.length === 0) return false;
  const forms = subWordForms(container);
  let hits = 0;
  for (const term of terms.concepts) if (forms.has(term) && ++hits >= 2) return true;
  return false;
}

function isNamedByRequest(token: string, terms: RequestTerms): boolean {
  if (terms.identifiers.length === 0) return false;
  const fold = token.toLowerCase();
  return terms.identifiers.some((id) => id === token || id.toLowerCase() === fold);
}

/**
 * Candidate identifiers of the served slices: declarations first, then
 * references — from CODE surfaces only (see `surfaceKindOf`). Pure over its
 * inputs (no file access); bounded to `MAX_POOL` distinct symbols. Returned in
 * first-appearance order.
 */
export function collectUsageCandidates(
  slices: readonly UsageSlice[],
  terms: RequestTerms,
  opts: UsageProjectOptions = {},
): UsageCandidate[] {
  const pool = new Map<string, UsageCandidate>();
  const matchers = new Map<ReadonlySet<string> | undefined, (token: string) => boolean>();
  /** The request matcher for one served file: its concept terms minus the words that name its own project. */
  const matcherFor = (slicePath: string): ((token: string) => boolean) => {
    const projectTerms = opts.projectTermsOf?.(slicePath);
    let matcher = matchers.get(projectTerms);
    if (matcher === undefined) {
      matcher = memoizedMatcher(withoutProjectTerms(terms, projectTerms));
      matchers.set(projectTerms, matcher);
    }
    return matcher;
  };
  let order = 0;
  let linesLeft = MAX_TOTAL_LINES;

  const upsert = (next: Omit<UsageCandidate, "order">): void => {
    const current = pool.get(next.symbol);
    if (current === undefined) {
      if (pool.size >= MAX_POOL) return;
      pool.set(next.symbol, { ...next, order: order++ });
      return;
    }
    if (next.surfaceIndex < current.surfaceIndex) {
      current.surfaceIndex = next.surfaceIndex;
      current.path = next.path;
    }
    if (next.declared) {
      if (!current.declared || next.declSurface < current.declSurface) current.declSurface = next.declSurface;
      current.declared = true;
      current.exported = current.exported || next.exported;
      if (current.kind === "identifier" || next.kind !== "identifier") current.kind = next.kind;
    }
    current.refs0 += next.refs0;
    current.literal = current.literal && next.literal;
    if (current.qualifier === undefined && next.qualifier !== undefined) current.qualifier = next.qualifier;
    if (current.container === undefined && next.container !== undefined) current.container = next.container;
  };

  // (a) Declarations of the served CODE slices.
  const declaredNames = new Set<string>();
  const declarations: Array<{ slice: UsageSlice; decl: DeclaredSymbol }> = [];
  for (const slice of slices) {
    if (surfaceKindOf(slice.path) !== "code") continue;
    for (const decl of declarationsIn(slice.path, slice.text)) {
      if (decl.symbol.length < 2) continue;
      declaredNames.add(decl.symbol);
      declarations.push({ slice, decl });
    }
  }
  for (const { slice, decl } of declarations) {
    const matches = matcherFor(slice.path);
    if (isStoplisted(decl.symbol) && !isNamedByRequest(decl.symbol, terms)) continue;
    // A method name is shared by every type that has one: worth an inventory only when the name is distinctive or the request matches it.
    if (decl.kind === "member" && !isDistinctive(decl.symbol) && !matches(decl.symbol)) continue;
    upsert({
      symbol: decl.symbol,
      surfaceIndex: slice.index,
      path: slice.path,
      kind: decl.kind ?? inferKind(decl.symbol),
      declared: true,
      declSurface: slice.index,
      exported: decl.exported,
      refs0: 0,
      literal: false,
      ...(decl.container !== undefined ? { container: decl.container } : {}),
    });
  }

  // (b) Identifiers the slices reference.
  const reference = (slice: UsageSlice, symbol: string, kind: UsageKind, literal: boolean, qualifier?: string): void => {
    upsert({
      symbol,
      surfaceIndex: slice.index,
      path: slice.path,
      kind,
      declared: false,
      declSurface: -1,
      exported: false,
      refs0: slice.index === 0 ? 1 : 0,
      literal,
      ...(qualifier !== undefined ? { qualifier } : {}),
    });
  };

  /** A hyphenated / dotted token from a string literal or a stylesheet, only when the request explains it. */
  const admitLiteral = (slice: UsageSlice, token: string, matches: (token: string) => boolean): void => {
    const cleaned = token.replace(/^-+/, "");
    if (cleaned.length < 5 || token.length > MAX_LITERAL_CHARS || FILE_LIKE_LITERAL_RE.test(token)) return;
    if (/^(?:https?|www)\b/i.test(cleaned)) return;
    if (!matches(cleaned)) return;
    // `\b` needs a word character at each end: `--color-x` is searched as `color-x`, which also finds it inside `--color-x`.
    reference(slice, cleaned, "literal", true);
  };

  /** Qualified members: record the member Y, remember the qualifier X. */
  const admitQualified = (slice: UsageSlice, qualifier: string, member: string, matches: (token: string) => boolean): void => {
    if (member.length < 3) return;
    const named = isNamedByRequest(member, terms);
    if (!named && isStoplisted(member)) return;
    // `console.x`, `Math.x`, `self.x`: a library/builtin qualifier says nothing — except that `this.x` / `self.x` may name what the request asks about.
    if (!named && isStoplisted(qualifier) && !(QUALIFIER_SKIP.has(qualifier) && isDistinctive(member) && matches(member))) return;
    const admit = named
      || (isDistinctive(member) && matches(member))
      || isConstCase(member)
      || isPascal(member)
      || (isDistinctive(member) && isPascal(qualifier));
    if (!admit) return;
    const kind: UsageKind = isConstCase(member) || (isPascal(member) && isPascal(qualifier))
      ? (isPascal(qualifier) ? "enum-member" : "constant")
      : inferKind(member);
    reference(slice, member, kind, false, qualifier);
  };

  /** A plain identifier token. */
  const admitPlain = (slice: UsageSlice, token: string, matches: (token: string) => boolean): void => {
    if (token.length < 3) return;
    const named = isNamedByRequest(token, terms);
    if (!named && isStoplisted(token)) return;
    // A single lower-case word that merely echoes a domain noun of the request (`order`, `invoice`, a parameter, a local) is not a symbol worth an inventory.
    const admit = named || isConstCase(token) || isPascal(token) || (isDistinctive(token) && matches(token));
    if (!admit) return;
    // A token the slices declare is already in the pool as a declaration; count the reference for its frequency.
    reference(slice, token, declaredNames.has(token) ? (pool.get(token)?.kind ?? inferKind(token)) : inferKind(token), false);
  };

  for (const slice of slices) {
    const kind = surfaceKindOf(slice.path);
    const matches = matcherFor(slice.path);
    if (kind === "prose") {
      // Documentation, changelogs and data name no code of their own: only what the author put in backticks.
      for (const span of proseCodeSpans(slice.text)) {
        const parts = span.split(/\.|::|#|->/);
        if (parts.length >= 2) admitQualified(slice, parts[parts.length - 2]!, parts[parts.length - 1]!, matches);
        else admitPlain(slice, span, matches);
      }
      continue;
    }
    const family = languageFamilyOf(slice.path);
    for (const rawLine of codeLinesOutsideImports(slice.text, family)) {
      if (linesLeft-- <= 0) break;
      const literals: Array<{ inner: string; offset: number }> = [];
      // Length-preserving blanking, so an index in `stringless` is an index in `rawLine`.
      const stringless = rawLine.replace(STRING_LITERAL_RE, (m: string, _q: string, inner: string, offset: number) => {
        literals.push({ inner, offset });
        return " ".repeat(m.length);
      });
      const line = kind === "style" ? stringless : stripTrailingComment(stringless, family); // a trailing comment names nothing that is used
      const codeEnd = line.length;

      const literalSources = kind === "style" ? [rawLine] : literals.filter((l) => l.offset < codeEnd).map((l) => l.inner);
      for (const source of literalSources) {
        for (const token of source.match(kind === "style" ? STYLE_TOKEN_RE : LITERAL_TOKEN_RE) ?? []) admitLiteral(slice, token, matches);
      }
      if (kind !== "code") continue; // a stylesheet or a template has no identifiers, qualified members or declarations to inventory

      for (const m of line.matchAll(QUALIFIED_RE)) admitQualified(slice, m[1]!, m[2]!, matches);
      for (const token of line.match(IDENT_TOKEN_RE) ?? []) admitPlain(slice, token, matches);
    }
  }
  return [...pool.values()];
}

/**
 * Concept terms that are a sub-word of more than half of a candidate pool of at least `UBIQUITY_MIN_POOL`: they tell
 * the candidates apart no better than no term at all (`order` in an order service) — the same guard the neighbour
 * ranking applies to its candidate files.
 */
function ubiquitousTermsOf(candidates: readonly UsageCandidate[], terms: RequestTerms): ReadonlySet<string> {
  const ubiquitous = new Set<string>();
  if (terms.concepts.length === 0 || candidates.length < UBIQUITY_MIN_POOL) return ubiquitous;
  const matched = new Map<string, number>();
  for (const candidate of candidates) {
    const forms = subWordForms(candidate.symbol);
    for (const term of terms.concepts) if (forms.has(term)) matched.set(term, (matched.get(term) ?? 0) + 1);
  }
  for (const [term, count] of matched) if (count * 2 > candidates.length) ubiquitous.add(term);
  return ubiquitous;
}

/**
 * Rank candidates: (1) named by the query — but the OWNER of a named
 * `A.b` / `A::b` / `A#b` (never named alone) is the place to look, not the
 * subject: it joins tier 2 at its top, the member `b` is tier 1 — (2) matching
 * a concept term (project-name terms and terms found in over half of a pool of
 * ≥ 6 candidates excluded), referenced constants/types/enum members first,
 * (3) constants/enum members/types the first surface references
 * but no slice declares, (4) declarations of the first surface (exported
 * first), (5) the rest. Inside a tier the owner comes first, then the
 * identifiers the served code references but no served slice declares — most
 * used in the first served surface's slice first — then the served
 * declarations. Pure and deterministic; ties break on score, surface
 * position, first appearance, then name.
 */
export function rankUsageCandidates(
  candidates: readonly UsageCandidate[],
  terms: RequestTerms,
  opts: UsageProjectOptions = {},
): RankedUsage[] {
  const ubiquitous = ubiquitousTermsOf(candidates, terms);
  const discriminating: RequestTerms = ubiquitous.size === 0 ? terms : { ...terms, concepts: terms.concepts.filter((term) => !ubiquitous.has(term)) };
  const termsByProject = new Map<ReadonlySet<string> | undefined, RequestTerms>();
  const termsFor = (c: UsageCandidate): RequestTerms => {
    const projectTerms = opts.projectTermsOf?.(c.path);
    let effective = termsByProject.get(projectTerms);
    if (effective === undefined) {
      effective = withoutProjectTerms(discriminating, projectTerms);
      termsByProject.set(projectTerms, effective);
    }
    return effective;
  };
  const ownerExact = new Set(terms.qualifiers);
  const ownerFold = new Set(terms.qualifiers.map((q) => q.toLowerCase()));
  const ranked: RankedUsage[] = candidates.map((c) => {
    const fold = c.symbol.toLowerCase();
    if (ownerExact.has(c.symbol)) return { ...c, category: 2, score: 95 };
    if (ownerFold.has(fold)) return { ...c, category: 2, score: 92 };
    if (terms.identifiers.includes(c.symbol)) return { ...c, category: 1, score: 100 };
    if (terms.identifiers.some((id) => id.toLowerCase() === fold)) return { ...c, category: 1, score: 90 };
    const effective = termsFor(c);
    if (effective.concepts.length > 0) {
      const forms = subWordForms(c.symbol);
      let matched = 0;
      for (const term of effective.concepts) if (forms.has(term)) matched++;
      if (matched > 0) {
        const bonus = !c.declared && CONST_LIKE.has(c.kind) ? 15 : CONST_LIKE.has(c.kind) || c.literal ? 8 : 0;
        return { ...c, category: 2, score: 60 + Math.min(3, matched) * 5 + bonus };
      }
    }
    // Members of a type the request is about (an enum's constants): what the reader searches for next. "About" = the query
    // names the type, or the type's name holds at least two of the request's concept terms.
    if (c.container !== undefined && CONST_LIKE.has(c.kind) && containerIsAboutRequest(c.container, effective)) {
      return { ...c, category: 2, score: 55 };
    }
    if (!c.declared && c.refs0 > 0 && CONST_LIKE.has(c.kind)) {
      return { ...c, category: 3, score: 40 + (c.kind === "type" ? 3 : 6) + Math.min(4, c.refs0) };
    }
    if (c.declSurface === 0) {
      return { ...c, category: 4, score: 20 + (c.exported ? 5 : 0) + (c.kind === "member" || c.kind === "variable" || c.kind === "identifier" ? 0 : 3) };
    }
    return { ...c, category: 5, score: 10 };
  });
  // Inside a tier: the owner of a named `A.b` (the place to look), then what the served code references but no served
  // slice declares, then the served declarations (their definitions are already in the pack).
  const groupOf = (c: UsageCandidate): 0 | 1 | 2 =>
    ownerExact.has(c.symbol) || ownerFold.has(c.symbol.toLowerCase()) ? 0 : c.declared ? 2 : 1;
  return ranked.sort((a, b) => {
    if (a.category !== b.category) return a.category - b.category;
    const groupA = groupOf(a);
    const groupB = groupOf(b);
    if (groupA !== groupB) return groupA - groupB;
    // Referenced-not-declared: the most used in the first served surface's slice first — except that among the
    // identifiers the query names, the exact spelling still precedes a case-folded one (score 100 vs 90).
    if (groupA === 1 && a.category !== 1 && a.refs0 !== b.refs0) return b.refs0 - a.refs0;
    return b.score - a.score
      || (groupA === 1 ? b.refs0 - a.refs0 : 0)
      || a.surfaceIndex - b.surfaceIndex
      || a.order - b.order
      || (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0);
  });
}

// ---------------------------------------------------------------------------
// Served spans — what the model already holds
// ---------------------------------------------------------------------------

type Span = [number, number];

function subtractSpan(spans: Span[], cut: Span): Span[] {
  const out: Span[] = [];
  for (const [start, end] of spans) {
    if (cut[1] < start || cut[0] > end) {
      out.push([start, end]);
      continue;
    }
    if (cut[0] > start) out.push([start, cut[0] - 1]);
    if (cut[1] < end) out.push([cut[1] + 1, end]);
  }
  return out;
}

/**
 * Per file, the 1-based line spans this response's surfaces served: each
 * surface's `range` minus its unserved `remaining_ranges`, plus the windows
 * appended from other lines. A surface with no body (neither `code` nor
 * `code_unchanged`) served nothing.
 */
export function servedLineSpans(surfaces: readonly TaskPackSurface[]): Map<string, Span[]> {
  const byPath = new Map<string, Span[]>();
  for (const surface of surfaces) {
    if (surface.code === undefined && surface.code_unchanged === undefined) continue;
    const range = parseLineRange(surface.range);
    if (range === undefined) continue;
    let spans: Span[] = [range];
    for (const remaining of surface.remaining_ranges ?? []) {
      const cut = parseLineRange(remaining);
      if (cut !== undefined) spans = subtractSpan(spans, cut);
    }
    for (const window of surface.appended_windows ?? []) {
      const extra = parseLineRange(window.range);
      if (extra !== undefined) spans.push(extra);
    }
    byPath.set(surface.path, [...(byPath.get(surface.path) ?? []), ...spans]);
  }
  return byPath;
}

function isServedLine(served: ReadonlyMap<string, Span[]>, filePath: string, line: number): boolean {
  const spans = served.get(filePath);
  return spans !== undefined && spans.some(([start, end]) => line >= start && line <= end);
}

// ---------------------------------------------------------------------------
// Declaring lines — which matched line DEFINES the symbol
// ---------------------------------------------------------------------------

const declarationRegexCache = new Map<string, RegExp[]>();

function declarationRegexes(symbol: string, style: boolean): RegExp[] {
  const key = `${style ? "s" : "c"}|${symbol}`;
  const cached = declarationRegexCache.get(key);
  if (cached !== undefined) return cached;
  const n = escapeRegExp(symbol);
  const keywords = "let|var|val|type|typealias|func|fun|fn|function\\*?|def|class|interface|trait|protocol|record|object|namespace|module|macro_rules!|define";
  const regexes = style
    ? [
        // `--name: …` (a custom property) and a selector line ending in `{` or `,` that names `.name` / `#name`
        new RegExp(`(?<![\\w-])--${n}\\s*:`),
        new RegExp(`^[^"'=;{}()]*[.#]${n}(?![\\w-])[^"'=;}()]*(?:\\{|,|$)`),
      ]
    : [
        // `class NAME`, `def NAME`, `type NAME`, `func NAME`, `#define NAME`, `interface NAME`, … (`using namespace NAME;` uses, not declares)
        new RegExp(`(?<!\\busing\\s+)(?<![\\w$.])(?:${keywords})\\s+${n}(?![\\w$])`),
        // `struct NAME {`, `enum NAME;`, `union NAME : Base` — but not `struct NAME *p = …` (a C variable of that type)
        new RegExp(`(?<![\\w$.])(?:struct|union|enum)\\s+${n}(?![\\w$])(?=\\s*(?:[{;:<(]|$|final\\b|extends\\b|implements\\b))`),
        // `const NAME`, `static final int NAME = …`, `const char *NAME[]`: a modifier, an optional type, then a declarator
        new RegExp(`(?<![\\w$.])(?:const|final|static|readonly|extern)\\s+(?:[\\w$.<>\\[\\]?*&]+\\s+)?[*&]*${n}(?![\\w$])(?=\\s*(?:[=;,(\\[:]|$))`),
        // Go method: `func (s *Store) NAME`
        new RegExp(`(?<![\\w$.])func\\s*\\([^)]*\\)\\s*${n}(?![\\w$])`),
        // `using NAME = …`
        new RegExp(`(?<![\\w$.])using\\s+${n}\\s*=`),
        // `typedef … NAME;`
        new RegExp(`(?<![\\w$.])typedef\\b[^;]*[\\s*&(]${n}\\s*(?:\\)|;|\\[)`),
        // `[modifiers/type] NAME[: type] = value`: constants, enum members, module and class variables. The text before NAME may hold
        // `::` (C++ scope) but no single `:` (a `let y: NAME = …` annotation names a type, not the variable); a window's leading `…` is fine.
        // In `var y Foo = x` / `let y Foo = x` the declared name is the one right after the keyword, not the type that follows it.
        new RegExp(`^(?!\\s*(?:var|let|val)\\s+(?!mut\\b)[\\w$]+\\s+[\\w$*&<>\\[\\]]+)(?:[^=(){};:]|::)*?(?<![\\w$.])${n}\\s*(?::[^=]*)?=(?![=>])`),
      ];
  if (declarationRegexCache.size >= 512) declarationRegexCache.clear();
  declarationRegexCache.set(key, regexes);
  return regexes;
}

/**
 * Does the (trimmed) source line `lineText` DECLARE `symbol` — `const|let|var|val|type|func|def|class|struct|enum|
 * interface|#define|typedef|using … =` before the name, or an assignment to it (a constant, an enum member, a module
 * variable)? A generic syntax rule, not keyed to any project; `style` selects the stylesheet forms (`--name:`, `.name {`).
 */
export function declaresSymbol(lineText: string, symbol: string, style = false): boolean {
  if (lineText.length === 0 || symbol.length === 0) return false;
  return declarationRegexes(symbol, style).some((re) => re.test(lineText));
}

// ---------------------------------------------------------------------------
// Match inventory — the same scanner `tl_search_files find` uses.
// ---------------------------------------------------------------------------

/**
 * `\b` (a zero-width ASSERTION, not a lookaround construct) — `scanLiteral`'s
 * `isSafeRegexQuery` admission gate explicitly rejects lookarounds
 * (`(?<!…)`/`(?!…)`) as a backtracking-safety measure, which a first version
 * of this function used and which silently zeroed every match (`scanLiteral`
 * returns `[]` rather than throwing on a rejected pattern — caught by this
 * module's own "matches find output exactly" test). `\b` is defined over
 * `\w` (`[A-Za-z0-9_]`), so it under-bounds an identifier whose first/last
 * character is `$` — a rare shape this module accepts rather than reaching
 * for a lookaround the shared scanner will not run.
 */
function wordBoundedPattern(symbol: string): string {
  return `\\b${escapeRegExp(symbol)}\\b`;
}

interface ScopeFiles {
  files: FoundFile[];
  /**
   * False when the scope could not be covered whole: it held more files than `MAX_SCAN_FILES`, the walk's size ceiling
   * skipped a file (`omissions.oversize`), or a directory could not be listed (`omissions.unreadable_dirs`) — the
   * omissions `find` itself refuses an absence certificate over. Ignore rules, symlinks and non-text files define the
   * scan and are not counted.
   */
  complete: boolean;
  /** Files the scans of this scope could not read or decode (every scan of one scope visits the same files). */
  coverage: ScanCoverage;
  /** Absolute path per relative path, built on first need. */
  abs?: Map<string, string>;
}

/** The scanner's own walk (`.css` included, gitignore respected), restricted to `scope`, bounded. */
function walkScope(workspace: string, scope: string): ScopeFiles {
  const omissions = createWalkOmissions();
  const files = walkCodeFiles(workspace, {
    ...(scope !== "" ? { subPath: scope } : {}),
    extraExts: [".css"],
    respectGitignore: true,
    omissions,
  });
  const coverage = createScanCoverage();
  if (files.length > MAX_SCAN_FILES) return { files: files.slice(0, MAX_SCAN_FILES), complete: false, coverage };
  return { files, complete: omissions.oversize === 0 && omissions.unreadable_dirs === 0, coverage };
}

interface InventoryContext {
  workspace: string;
  served: ReadonlyMap<string, Span[]>;
  contentCache: ReturnType<typeof createScanContentCache>;
  scopes: Map<string, ScopeFiles>;
  scopeByDir: Map<string, string>;
  /** `declarationsIn` results per file, for the declaring-file lookup. */
  declarations: Map<string, DeclaredSymbol[]>;
}

/** Candidates scanned per pack: fewer as the scanned scope grows, so the work stays bounded on a large project. */
function evaluationBudget(ctx: InventoryContext): number {
  let largest = 0;
  for (const scoped of ctx.scopes.values()) largest = Math.max(largest, scoped.files.length);
  if (largest > 3000) return MAX_SYMBOLS;
  if (largest > 1500) return MAX_SYMBOLS + 2;
  return MAX_EVALUATED;
}

function scopeOfSurface(ctx: InventoryContext, surfacePath: string): string {
  const dir = posixDirname(surfacePath);
  let scope = ctx.scopeByDir.get(dir);
  if (scope === undefined) {
    scope = inventoryScopeOf(ctx.workspace, surfacePath);
    ctx.scopeByDir.set(dir, scope);
  }
  return scope;
}

/** One matched file of a symbol's inventory. */
interface DraftFile {
  path: string;
  /** Every matched line, ascending. */
  lines: number[];
  /** The first matched line that declares the symbol, when one does. */
  declLine?: number;
}

/** A symbol's complete match inventory before any cap: what `renderDraft` cuts down to fit. */
interface UsageDraft {
  rank: number;
  category: 1 | 2 | 3 | 4 | 5;
  symbol: string;
  scope: string;
  total: number;
  scanComplete: boolean;
  literal: boolean;
  /** Declaring files first, then files with a match the model does not hold, then the files whose matches it holds. */
  files: DraftFile[];
  /** Set by `orderDrafts`. */
  ubiquitous?: boolean;
}

function isStylePath(filePath: string): boolean {
  return STYLE_EXTENSIONS.some((ext) => filePath.toLowerCase().endsWith(ext));
}

/** The inventory of one candidate; undefined when it has no match or adds nothing the model does not hold. */
function inventoryFor(candidate: RankedUsage, rank: number, ctx: InventoryContext): UsageDraft | undefined {
  const scope = scopeOfSurface(ctx, candidate.path);
  let scoped = ctx.scopes.get(scope);
  if (scoped === undefined) {
    scoped = walkScope(ctx.workspace, scope);
    ctx.scopes.set(scope, scoped);
  }
  const matches = scanLiteral(wordBoundedPattern(candidate.symbol), ctx.workspace, {
    regex: true,
    respectGitignore: true,
    files: scoped.files,
    contentCache: ctx.contentCache,
    coverage: scoped.coverage,
  });
  if (matches.length === 0) return undefined;
  if (matches.every((m) => isServedLine(ctx.served, m.path, m.line))) return undefined; // adds nothing

  const byFile = new Map<string, number[]>();
  const declLines = new Map<string, number>();
  let tested = 0;
  for (const m of matches) {
    const lines = byFile.get(m.path);
    if (lines) lines.push(m.line);
    else byFile.set(m.path, [m.line]);
    if (tested < MAX_DECLARATION_TESTS && !declLines.has(m.path)) {
      tested++;
      if (declaresSymbol(m.text ?? "", candidate.symbol, isStylePath(m.path))) declLines.set(m.path, m.line);
    }
  }
  // The definition site first, then files with a match the model does not hold, then files whose matches it already holds.
  const declFresh: DraftFile[] = [];
  const declHeld: DraftFile[] = [];
  const otherFresh: DraftFile[] = [];
  const otherHeld: DraftFile[] = [];
  for (const [filePath, lines] of byFile) {
    const fresh = lines.some((line) => !isServedLine(ctx.served, filePath, line));
    const declLine = declLines.get(filePath);
    const file: DraftFile = { path: filePath, lines, ...(declLine !== undefined ? { declLine } : {}) };
    (declLine !== undefined ? (fresh ? declFresh : declHeld) : (fresh ? otherFresh : otherHeld)).push(file);
  }
  return {
    rank,
    category: candidate.category,
    symbol: candidate.symbol,
    scope,
    total: matches.length,
    // A file of the scope this scan could not read or decode may hold a match nobody saw: not a complete inventory.
    scanComplete: scoped.complete && scoped.coverage.unscanned.size === 0 && scoped.coverage.undecodable.size === 0,
    literal: candidate.literal,
    files: [...declFresh, ...declHeld, ...otherFresh, ...otherHeld],
  };
}

/** How likely a file is to hold the DEFINITION of `symbol`: an interface/header file, then one named after it. */
function definitionLikelihood(filePath: string, symbol: string): number {
  const lower = filePath.toLowerCase();
  if (/\.(?:h|hh|hpp|hxx|pyi)$|\.d\.ts$/.test(lower)) return 3;
  const stem = (lower.split("/").pop() ?? lower).replace(/\.[^.]*$/, "").replace(/[^a-z0-9]/g, "");
  const fold = symbol.toLowerCase().replace(/[^a-z0-9]/g, "");
  return stem.length >= 3 && fold.length >= 3 && (stem.includes(fold) || fold.includes(stem)) ? 2 : 1;
}

/** Lines of a scanned file: the scanner's own cache first, a bounded read otherwise. */
function linesOfScanned(ctx: InventoryContext, scoped: ScopeFiles, relPath: string): string[] | undefined {
  if (scoped.abs === undefined) scoped.abs = new Map(scoped.files.map((f) => [f.relPath, f.absPath]));
  const abs = scoped.abs.get(relPath);
  const cached = abs === undefined ? undefined : ctx.contentCache.lines.get(abs);
  if (Array.isArray(cached)) return cached;
  const read = readCapped(ctx.workspace, relPath, 256 * 1024);
  return read === undefined ? undefined : read.text.split(/\r?\n/);
}

/**
 * A finalist whose declaring line no keyword/assignment rule could see (a C/C++/Java function, an enum
 * constant, …): ask `declarationsIn` of a few likely files, over the lines the scan already holds. Bounded:
 * skipped for a widely matched symbol, at most `DECLARATION_FALLBACK_FILES` files, each ≤ 6,000 lines.
 */
function refineDeclaringFiles(draft: UsageDraft, ctx: InventoryContext): void {
  if (draft.files.length === 0 || draft.files.length > DECLARATION_FALLBACK_MAX_FILES) return;
  if (draft.files.some((f) => f.declLine !== undefined)) return;
  const scoped = ctx.scopes.get(draft.scope);
  if (scoped === undefined) return;
  const likely = draft.files
    .map((file, index) => ({ file, index, likelihood: definitionLikelihood(file.path, draft.symbol) }))
    .sort((a, b) => b.likelihood - a.likelihood || a.index - b.index)
    .slice(0, DECLARATION_FALLBACK_FILES);
  let found = false;
  for (const { file } of likely) {
    let declared = ctx.declarations.get(file.path);
    if (declared === undefined) {
      const lines = linesOfScanned(ctx, scoped, file.path);
      declared = lines === undefined || lines.length > DECLARATION_FALLBACK_MAX_LINES ? [] : declarationsIn(file.path, lines.join("\n"));
      ctx.declarations.set(file.path, declared);
    }
    const hit = declared.find((d) => d.symbol === draft.symbol && file.lines.includes(d.line));
    if (hit !== undefined) {
      file.declLine = hit.line;
      found = true;
    }
  }
  if (found) {
    // Stable: declaring files first, everything else keeps its order.
    draft.files = [...draft.files.filter((f) => f.declLine !== undefined), ...draft.files.filter((f) => f.declLine === undefined)];
  }
}

/**
 * The tiers' final order: by category, and inside a category the candidates a
 * project-wide grep would drown in — more than `UBIQUITOUS_TOTAL` matching
 * lines in their scope — after the rest; each class keeps the candidates' rank
 * order. (Only that absolute threshold: a candidate is not demoted for merely
 * being used many times more than a rarer sibling of its tier.)
 */
function orderDrafts(drafts: readonly UsageDraft[]): UsageDraft[] {
  const byCategory = new Map<number, UsageDraft[]>();
  for (const draft of drafts) {
    const group = byCategory.get(draft.category) ?? [];
    group.push(draft);
    byCategory.set(draft.category, group);
  }
  const out: UsageDraft[] = [];
  for (const category of [...byCategory.keys()].sort((a, b) => a - b)) {
    const group = byCategory.get(category)!.sort((a, b) => a.rank - b.rank);
    for (const draft of group) draft.ubiquitous = draft.total > UBIQUITOUS_TOTAL;
    out.push(...group.filter((d) => d.ubiquitous !== true), ...group.filter((d) => d.ubiquitous === true));
  }
  return out;
}

/** Up to `cap` matched lines of a file, the declaring line always among them. */
function pickLines(file: DraftFile, cap: number): number[] {
  if (file.lines.length <= cap) return file.lines;
  if (file.declLine === undefined) return file.lines.slice(0, cap);
  const rest = file.lines.filter((line) => line !== file.declLine).slice(0, Math.max(0, cap - 1));
  return [...rest, file.declLine].sort((a, b) => a - b);
}

/** A draft cut to `filesCap` files of `linesCap` lines; `total` stays exact and `inventory_complete` says whether anything was cut. */
function renderDraft(draft: UsageDraft, filesCap: number, linesCap: number): UsageEntry {
  const kept = draft.files.slice(0, filesCap);
  let complete = draft.scanComplete && kept.length === draft.files.length;
  const files = kept.map((file) => {
    const lines = pickLines(file, linesCap);
    if (lines.length < file.lines.length) complete = false;
    return { path: file.path, lines };
  });
  return {
    symbol: draft.symbol,
    files,
    total: draft.total,
    inventory_complete: complete,
    ...(draft.scope !== "" ? { scope: draft.scope } : {}),
  };
}

function serializedBytes(entries: readonly UsageEntry[]): number {
  return Buffer.byteLength(JSON.stringify(entries), "utf8");
}

/**
 * Fit the ranked drafts into `maxBytes` without losing a symbol: every entry
 * starts at `MAX_FILES_PER_SYMBOL` × `MAX_LINES_PER_FILE`; while over, trim
 * LINES per file (down to one), then FILES per symbol (down to one), starting
 * with the LOWEST-ranked entry each time; only when every entry is at one file
 * of one line are entries dropped, lowest-ranked first. Rank order is never
 * changed and a declaring file/line is never cut before another one.
 */
function capDrafts(drafts: readonly UsageDraft[], maxBytes: number): UsageEntry[] {
  const caps = drafts.map(() => ({ files: MAX_FILES_PER_SYMBOL, lines: MAX_LINES_PER_FILE }));
  const rendered = drafts.map((draft, i) => renderDraft(draft, caps[i]!.files, caps[i]!.lines));
  let bytes = serializedBytes(rendered);
  const retrim = (i: number): void => {
    rendered[i] = renderDraft(drafts[i]!, caps[i]!.files, caps[i]!.lines);
    bytes = serializedBytes(rendered);
  };
  for (let i = drafts.length - 1; i >= 0 && bytes > maxBytes; i--) {
    while (caps[i]!.lines > 1 && bytes > maxBytes) {
      caps[i]!.lines--;
      retrim(i);
    }
  }
  for (let i = drafts.length - 1; i >= 0 && bytes > maxBytes; i--) {
    while (caps[i]!.files > 1 && bytes > maxBytes) {
      caps[i]!.files--;
      retrim(i);
    }
  }
  let kept = rendered.length;
  while (kept > 0 && serializedBytes(rendered.slice(0, kept)) > maxBytes) kept--;
  return rendered.slice(0, kept);
}

// ---------------------------------------------------------------------------
// Computation
// ---------------------------------------------------------------------------

/**
 * Pure computation (no flag check — callers gate; unit tests call this directly). `opts.maxBytes` is the serialized cap
 * of the entries (default `MAX_USAGES_BYTES`); the hook lowers it when the pack has less room left.
 */
export function computeUsageInventory(result: TaskPackResult, workspace: string, query?: string, opts: { maxBytes?: number } = {}): UsageEntry[] {
  const terms = requestTermsOf(query, workspace);
  const slices: UsageSlice[] = [];
  for (const surface of result.surfaces.slice(0, MAX_SURFACES)) {
    let fileText: string | undefined;
    if (surface.code === undefined && surface.code_unchanged !== undefined) fileText = readCapped(workspace, surface.path, 1024 * 1024)?.text;
    const text = servedTextOf(surface, fileText);
    // "first served surface" = the first one whose body was served
    if (text !== undefined && text.length > 0) {
      slices.push({ index: slices.length, path: surface.path, text: text.length > MAX_SLICE_CHARS ? text.slice(0, MAX_SLICE_CHARS) : text });
    }
  }
  if (slices.length === 0) return [];

  const ctx: InventoryContext = {
    workspace,
    served: servedLineSpans(result.surfaces),
    contentCache: createScanContentCache(),
    scopes: new Map(),
    scopeByDir: new Map(),
    declarations: new Map(),
  };
  // The words that name a served file's own project, per directory (a request term equal to one is no signal there).
  const projectTermsByDir = new Map<string, ReadonlySet<string>>();
  const projectTermsOf = (surfacePath: string): ReadonlySet<string> | undefined => {
    if (terms.concepts.length === 0) return undefined;
    const dir = posixDirname(surfacePath);
    let names = projectTermsByDir.get(dir);
    if (names === undefined) {
      names = projectNameTermsOf(workspace, surfacePath, scopeOfSurface(ctx, surfacePath));
      projectTermsByDir.set(dir, names);
    }
    return names;
  };
  const projectOpts: UsageProjectOptions = { projectTermsOf };

  const ranked = rankUsageCandidates(collectUsageCandidates(slices, terms, projectOpts), terms, projectOpts);
  const drafts: UsageDraft[] = [];
  let evaluated = 0;
  for (const candidate of ranked) {
    if (evaluated >= evaluationBudget(ctx)) break;
    if (drafts.length >= MAX_SYMBOLS) {
      // Enough survivors: only a later candidate of the SAME tier as the last one can still displace a ubiquitous one.
      const ordered = orderDrafts(drafts);
      const last = ordered[MAX_SYMBOLS - 1]!;
      const displaceable = ordered.slice(0, MAX_SYMBOLS).some((d) => d.ubiquitous === true && d.category === last.category);
      if (candidate.category > last.category || !displaceable) break;
    }
    const draft = inventoryFor(candidate, evaluated, ctx);
    evaluated++;
    if (draft !== undefined) drafts.push(draft);
  }
  const finalists = orderDrafts(drafts).slice(0, MAX_SYMBOLS);
  for (const draft of finalists) refineDeclaringFiles(draft, ctx);
  return capDrafts(finalists, opts.maxBytes ?? MAX_USAGES_BYTES);
}

/**
 * The hook: call once, at the END of `buildAnswerTaskPack`/
 * `buildSeededTaskPack`, alongside `attachFrontierNeighbourIndex`. Only ever
 * ADDS `result.usages`; never touches `result.surfaces` or any certificate/
 * obligation. Best-effort: a failure while inventorying leaves the pack
 * exactly as it was.
 *
 * `opts.headroom` (see `PlanAidOptions`, frontierNeighbours.ts) lets the caller
 * bound the member by what is left of the pack's own wire budget: the entries
 * are capped at `min(1.5 KiB, headroom() − 48)` — lines, then files, then the
 * lowest-ranked entries go first — and nothing is attached when that is under
 * 120 bytes. Evaluated after the flag check, so a flag-OFF pack never calls it.
 */
export function attachUsageInventory(result: TaskPackResult, workspace: string, query?: string, opts?: PlanAidOptions): void {
  if (!usageInventoryEnabled()) return;
  if (result.ok === false) return;
  if (result.surfaces.length === 0) return;
  const maxBytes = planAidCap(MAX_USAGES_BYTES, opts);
  if (maxBytes === undefined) return;
  let rows: UsageEntry[];
  try {
    rows = computeUsageInventory(result, workspace, query, { maxBytes });
  } catch {
    return;
  }
  if (rows.length > 0) result.usages = rows;
}
