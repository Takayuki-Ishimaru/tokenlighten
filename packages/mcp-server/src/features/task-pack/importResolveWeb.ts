/**
 * importResolveWeb.ts — TS/JS import edges for importResolution.ts's
 * dispatcher (consumed by the default-OFF V15-NBR neighbour index and V15-FUI
 * usage inventory). Contract: see importResolution.ts.
 *
 * Coverage (v0.15.0 — projects nested below the workspace root):
 * - Statements found in CODE only: `import … from`, `export … from`,
 *   `export * from`, side-effect `import 'x'`, dynamic `import('x')` and
 *   `require('x')`. Comments, strings, template literals and regex literals
 *   are masked first (sfCodeMask.ts), so a commented-out import or an
 *   import-shaped string never becomes an edge. (JSX children are text, not
 *   masked: an `import … from '…'` sentence typed inside JSX text is scanned.)
 * - Relative specifiers, with TypeScript's ESM compiled-extension rule
 *   (`./a.js` → `./a.ts`), `index` files, declaration files, extensionless
 *   `.json`, a trailing-slash directory, and a directory's own package.json entry.
 * - tsconfig/jsconfig `baseUrl` + `paths`: the NEAREST config walking up from
 *   the importing file, a relative `extends` chain (≤ 3 levels, JSONC,
 *   `${configDir}`), and a solution-style `references` list (the referenced
 *   config that covers the file: `files`/`include`/`exclude` under tsconfig's
 *   rules — no `include` means everything, a bare directory name means
 *   everything below it — matched by importGraphShared's linear-time
 *   `globMatchesPath`, at most 256 entries per list, so a crafted pattern can
 *   only lose edges, never stall a pack). A cached view depends on every file it read
 *   AND on every base/reference that was missing, so creating one later takes
 *   effect at once. Not covered: `extends` naming a package, `rootDirs`,
 *   bundler aliases (webpack/vite/babel), Yarn PnP.
 * - Workspace packages: a name → directory map of every package.json below
 *   the workspace root (never node_modules; a name declared twice is
 *   ambiguous and never resolved), resolved through `source`, `exports`
 *   (subpath patterns, nested conditions; a lookup scans only the map's `*`
 *   keys, at most 512, so tens of thousands of explicit subpaths stay cheap),
 *   `module`, `main`, `types`; a built
 *   entry is mapped back to its source (`dist/` → `src/`, `.d.ts`/`.js` →
 *   `.ts`). Plus package.json `imports` (`#alias`).
 * - Generated output points at its source: a NON-relative specifier (a
 *   `paths` alias, a package, `#imports`) that lands on a declaration or
 *   compiled file inside a project's `dist`/`build`/`out` (a directory beside a
 *   package.json/tsconfig.json) resolves to the TypeScript twin
 *   (`dist/x.d.ts` → `src/x.ts`) when one exists, and stays that file
 *   otherwise. A relative specifier is never redirected — the author named
 *   that file — and a real source file in a `build/` folder (scripts) is never
 *   mistaken for output.
 * - Module paths are canonical: a `paths` substitution such as `@/../lib/x`
 *   is normalized before it is probed, so an edge never carries `.`/`..`
 *   segments and the importer itself is never emitted.
 * - One-hop barrel re-exports: a named/default import that lands on a file
 *   which re-exports that name (`export { a } from`, `export { a as b } from`,
 *   `export * from` when the target exports it, or import-then-export) also
 *   yields an edge to the module that exports it (names re-exported from one
 *   module share one edge). The barrel's own specifiers resolve in the
 *   barrel's config context.
 *
 * Guarantees: an edge exists only for a file that exists inside the
 * workspace (also after symlink resolution), node_modules is never read,
 * listed or returned, every walk/read is bounded, every parsed manifest is
 * cached per absolute path and validated by mtime+size, and the entry point
 * never throws.
 */
import * as fs from "fs";
import * as path from "path";
import { type ResolvedImport, globMatchesPath, posixDirname, posixJoin, uniqueNames, withinWorkspace } from "./importGraphShared.js";
import { declarationsIn } from "./declarationScan.js";
import { maskCommentsAndStrings } from "./sfCodeMask.js";

export const WEB_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];

const DECLARATION_EXTENSIONS = [".d.ts", ".d.mts", ".d.cts"];

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** Characters of the served body that are scanned. */
const MAX_SCAN_CHARS = 256 * 1024;
/** Specifier occurrences examined per file / per barrel. */
const MAX_SPECIFIERS = 120;
const MAX_BARREL_SPECIFIERS = 400;
/** Characters of a barrel / re-export target that are scanned. */
const MAX_BARREL_SCAN_CHARS = 256 * 1024;
const MAX_SPECIFIER_CHARS = 300;
/** Edges returned per file (the dispatcher dedupes and caps at 40). */
const MAX_RAW_EDGES = 60;
/** Barrel lookups per file, and `export *` target reads per file. */
const MAX_HOP_LOOKUPS = 8;
const MAX_STAR_READS = 16;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_SOURCE_READ_BYTES = 1024 * 1024;
const MAX_EXTENDS_DEPTH = 3;
const MAX_CHAIN_CONFIGS = 6;
const MAX_REFERENCES = 4;
const MAX_MANIFESTS = 500;
const MAX_WALK_DEPTH = 6;
const MAX_WALK_DIRECTORIES = 3000;
const MAX_DIRECTORY_ENTRIES = 5000;
/** The package map re-stats its manifests at most this often … */
const PACKAGE_MAP_RECHECK_MS = 1500;
/** … and is rebuilt from scratch (a new package.json may have appeared) at least this often. */
const PACKAGE_MAP_REWALK_MS = 60_000;
const REAL_PATH_TTL_MS = 10_000;

// ---------------------------------------------------------------------------
// Filesystem primitives (every path goes through withinWorkspace)
// ---------------------------------------------------------------------------

interface Stamp {
  readonly mtimeMs: number;
  readonly size: number;
}

/** node_modules is never read, listed or returned; `.git` never either. */
const FORBIDDEN_SEGMENT_RE = /(?:^|\/)(?:node_modules|\.git)(?:\/|$)/;

function escapesWorkspace(rel: string): boolean {
  return rel === ".." || rel.startsWith("../") || rel.startsWith("/") || /^[A-Za-z]:/.test(rel);
}

function join2(dir: string, name: string): string {
  return dir === "" ? name : `${dir}/${name}`;
}

function statRegularFile(workspace: string, rel: string): { abs: string; stamp: Stamp } | undefined {
  if (FORBIDDEN_SEGMENT_RE.test(rel)) return undefined;
  const abs = withinWorkspace(workspace, rel);
  if (abs === undefined) return undefined;
  try {
    const st = fs.statSync(abs, { throwIfNoEntry: false });
    if (st === undefined || !st.isFile()) return undefined;
    return { abs, stamp: { mtimeMs: st.mtimeMs, size: st.size } };
  } catch {
    return undefined;
  }
}

function sameStamp(abs: string, stamp: Stamp): boolean {
  try {
    const st = fs.statSync(abs, { throwIfNoEntry: false });
    return st !== undefined && st.mtimeMs === stamp.mtimeMs && st.size === stamp.size;
  } catch {
    return false;
  }
}

const realRoots = new Map<string, string>();

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

const realPathVerdicts = new Map<string, { ok: boolean; at: number }>();

/**
 * True when `abs` (a lexically-inside path) still lies inside the workspace
 * after symlinks are resolved — a link that leaves the workspace must never
 * yield an edge or have its content read.
 */
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

/** Bounded cache whose entries are valid only while the file's mtime and size are unchanged. */
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
// JSONC manifests (tsconfig/jsconfig allow comments and trailing commas)
// ---------------------------------------------------------------------------

/** `source` with comments and trailing commas removed; string contents are left untouched. */
function jsoncToJson(source: string): string {
  const n = source.length;
  const parts: string[] = [];
  let runStart = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  let i = runStart;
  while (i < n) {
    const ch = source.charCodeAt(i);
    if (ch === 34) {
      i++;
      while (i < n) {
        const c = source.charCodeAt(i);
        if (c === 92) {
          i += 2;
          continue;
        }
        i++;
        if (c === 34 || c === 10) break;
      }
      continue;
    }
    if (ch === 47) {
      const next = source.charCodeAt(i + 1);
      if (next === 47) {
        parts.push(source.slice(runStart, i));
        while (i < n && source.charCodeAt(i) !== 10) i++;
        runStart = i;
        continue;
      }
      if (next === 42) {
        parts.push(source.slice(runStart, i));
        const end = source.indexOf("*/", i + 2);
        i = end === -1 ? n : end + 2;
        runStart = i;
        continue;
      }
    }
    if (ch === 44) {
      let j = i + 1;
      for (;;) {
        const c = source.charCodeAt(j);
        if (c === 32 || c === 9 || c === 10 || c === 13) {
          j++;
        } else if (c === 47 && source.charCodeAt(j + 1) === 47) {
          while (j < n && source.charCodeAt(j) !== 10) j++;
        } else if (c === 47 && source.charCodeAt(j + 1) === 42) {
          const end = source.indexOf("*/", j + 2);
          j = end === -1 ? n : end + 2;
        } else {
          break;
        }
      }
      const c = source.charCodeAt(j);
      if (c === 125 || c === 93) {
        parts.push(source.slice(runStart, i));
        runStart = i + 1;
      }
    }
    i++;
  }
  parts.push(source.slice(runStart));
  return parts.join("");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : undefined;
}

/**
 * `files`/`include`/`exclude` entries kept per config. A longer list is cut: a
 * cut `include` covers less and a cut `exclude` excludes less, so a hostile
 * list of 100,000 entries costs 256 cheap matches, never a stall.
 */
const MAX_COVERAGE_ENTRIES = 256;

function coverageList(value: unknown): string[] | undefined {
  return stringList(value)?.slice(0, MAX_COVERAGE_ENTRIES);
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  const bare = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  try {
    return asRecord(JSON.parse(bare));
  } catch {
    try {
      return asRecord(JSON.parse(jsoncToJson(bare)));
    } catch {
      return undefined;
    }
  }
}

const docCache = new StampedCache<Record<string, unknown> | undefined>(256);

interface LoadedDoc {
  readonly doc: Record<string, unknown> | undefined;
  readonly abs: string;
  readonly stamp: Stamp;
}

/** Parsed JSON/JSONC object at workspace-relative `rel`, cached per absolute path by mtime+size. */
function loadDoc(workspace: string, rel: string): LoadedDoc | undefined {
  const st = statRegularFile(workspace, rel);
  if (st === undefined) return undefined;
  const key = `${workspace}|${st.abs}`;
  const hit = docCache.get(key, st.stamp);
  if (hit !== undefined) return { doc: hit.value, abs: st.abs, stamp: st.stamp };
  let doc: Record<string, unknown> | undefined;
  if (st.stamp.size <= MAX_MANIFEST_BYTES && isInsideRealWorkspace(workspace, st.abs)) {
    try {
      doc = parseJsonObject(fs.readFileSync(st.abs, "utf8"));
    } catch {
      doc = undefined;
    }
  }
  docCache.set(key, st.stamp, doc);
  return { doc, abs: st.abs, stamp: st.stamp };
}

// ---------------------------------------------------------------------------
// Per-call state
// ---------------------------------------------------------------------------

interface WebRun {
  readonly workspace: string;
  readonly fileProbes: Map<string, boolean>;
  readonly configViews: Map<string, TsConfigView | undefined>;
  hopLookups: number;
  starReads: number;
}

function newRun(workspace: string): WebRun {
  return { workspace, fileProbes: new Map(), configViews: new Map(), hopLookups: 0, starReads: 0 };
}

function probeFile(run: WebRun, rel: string): boolean {
  const known = run.fileProbes.get(rel);
  if (known !== undefined) return known;
  const ok = statRegularFile(run.workspace, rel) !== undefined;
  run.fileProbes.set(rel, ok);
  return ok;
}

// ---------------------------------------------------------------------------
// tsconfig / jsconfig
// ---------------------------------------------------------------------------

interface TsPathRule {
  readonly key: string;
  readonly wildcard: boolean;
  readonly prefix: string;
  readonly suffix: string;
  /** Workspace-relative targets, still holding the pattern's single `*`. */
  readonly targets: readonly string[];
}

interface TsCoverage {
  readonly files: readonly string[] | undefined;
  readonly include: readonly string[] | undefined;
  readonly exclude: readonly string[] | undefined;
}

interface TsConfigView {
  readonly configDir: string;
  /** Workspace-relative `baseUrl` directory, when the effective config declares a usable one. */
  readonly baseUrl: string | undefined;
  readonly rules: readonly TsPathRule[];
  /** Workspace-relative config files of a solution-style `references` list. */
  readonly references: readonly string[];
  readonly coverage: TsCoverage;
}

const TSCONFIG_NAMES = ["tsconfig.json", "jsconfig.json"];
const CONFIG_DIR_TOKEN = "${configDir}";

/** `value` (a path inside the config at `dir`) as a workspace-relative path; undefined when unusable. */
function configRelative(dir: string, leafDir: string, value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 400) return undefined;
  let joined: string;
  if (value.startsWith(CONFIG_DIR_TOKEN)) {
    joined = posixJoin(leafDir, value.slice(CONFIG_DIR_TOKEN.length).replace(/^\/+/, ""));
  } else if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    return undefined;
  } else {
    joined = posixJoin(dir, value);
  }
  return escapesWorkspace(joined) ? undefined : joined;
}

interface ChainEntry {
  readonly rel: string;
  readonly doc: Record<string, unknown>;
}

function extendsTargets(dir: string, doc: Record<string, unknown>): string[] {
  const raw = doc["extends"];
  const list = typeof raw === "string" ? [raw] : (stringList(raw) ?? []);
  const out: string[] = [];
  for (const entry of list) {
    // Only relative paths are followed; a bare name is a package in node_modules.
    if (!(entry === "." || entry === ".." || entry.startsWith("./") || entry.startsWith("../"))) continue;
    const joined = posixJoin(dir, entry);
    if (escapesWorkspace(joined)) continue;
    out.push(joined.endsWith(".json") ? joined : `${joined}.json`);
  }
  return out;
}

/**
 * A file a cached config view was built from: its stamp, or `undefined` when
 * the view depends on the file STAYING absent (an `extends` base or a
 * `references` target that did not exist yet).
 */
interface ViewDep {
  readonly abs: string;
  readonly stamp: Stamp | undefined;
}

function viewDepValid(dep: ViewDep): boolean {
  if (dep.stamp !== undefined) return sameStamp(dep.abs, dep.stamp);
  try {
    const st = fs.statSync(dep.abs, { throwIfNoEntry: false });
    return st === undefined || !st.isFile(); // still no regular file there
  } catch {
    return true; // e.g. a parent that is a file: still nothing to load
  }
}

function collectChain(
  workspace: string,
  rel: string,
  depth: number,
  visited: Set<string>,
  chain: ChainEntry[],
  deps: ViewDep[],
): void {
  if (visited.has(rel) || visited.size >= MAX_CHAIN_CONFIGS) return;
  visited.add(rel);
  const loaded = loadDoc(workspace, rel);
  if (loaded === undefined) {
    // creating the missing base/reference later must invalidate the view
    const abs = FORBIDDEN_SEGMENT_RE.test(rel) ? undefined : withinWorkspace(workspace, rel);
    if (abs !== undefined) deps.push({ abs, stamp: undefined });
    return;
  }
  deps.push({ abs: loaded.abs, stamp: loaded.stamp });
  if (loaded.doc === undefined) return;
  if (depth < MAX_EXTENDS_DEPTH) {
    for (const base of extendsTargets(posixDirname(rel), loaded.doc)) collectChain(workspace, base, depth + 1, visited, chain, deps);
  }
  chain.push({ rel, doc: loaded.doc });
}

function buildRules(paths: Record<string, unknown>, baseDir: string, leafDir: string): TsPathRule[] {
  const rules: TsPathRule[] = [];
  for (const [key, value] of Object.entries(paths)) {
    const stars = key.split("*").length - 1;
    if (stars > 1 || key.length === 0) continue;
    const list = typeof value === "string" ? [value] : (stringList(value) ?? []);
    const targets: string[] = [];
    for (const target of list) {
      if (target.split("*").length - 1 > 1) continue;
      const resolved = target.startsWith(CONFIG_DIR_TOKEN)
        ? posixJoin(leafDir, target.slice(CONFIG_DIR_TOKEN.length).replace(/^\/+/, ""))
        : target.startsWith("/") || /^[A-Za-z]:/.test(target)
          ? undefined
          : posixJoin(baseDir, target);
      if (resolved !== undefined && !escapesWorkspace(resolved)) targets.push(resolved);
    }
    const star = key.indexOf("*"); // a rule without a usable target still matches (and blocks baseUrl), as in TypeScript
    rules.push({
      key,
      wildcard: star >= 0,
      prefix: star >= 0 ? key.slice(0, star) : key,
      suffix: star >= 0 ? key.slice(star + 1) : "",
      targets,
    });
  }
  return rules;
}

function mergeChain(chain: readonly ChainEntry[]): TsConfigView {
  const leaf = chain[chain.length - 1]!;
  const leafDir = posixDirname(leaf.rel);
  let baseUrl: string | undefined;
  let baseUrlBad = false;
  let paths: Record<string, unknown> | undefined;
  let pathsBase = leafDir;
  for (const { rel, doc } of chain) {
    const options = asRecord(doc["compilerOptions"]);
    if (options === undefined) continue;
    const dir = posixDirname(rel);
    if ("baseUrl" in options) {
      const resolved = configRelative(dir, leafDir, options["baseUrl"]);
      baseUrl = resolved;
      baseUrlBad = resolved === undefined;
    }
    if ("paths" in options) {
      paths = asRecord(options["paths"]);
      pathsBase = dir;
    }
  }
  const rules = baseUrlBad || paths === undefined ? [] : buildRules(paths, baseUrl ?? pathsBase, leafDir);
  const references: string[] = [];
  const rawReferences = leaf.doc["references"];
  if (Array.isArray(rawReferences)) {
    for (const entry of rawReferences) {
      const target = asRecord(entry)?.["path"];
      if (typeof target !== "string" || references.length >= MAX_REFERENCES) continue;
      const joined = posixJoin(leafDir, target);
      if (escapesWorkspace(joined)) continue;
      references.push(joined.endsWith(".json") ? joined : join2(joined, "tsconfig.json"));
    }
  }
  return {
    configDir: leafDir,
    baseUrl: baseUrlBad ? undefined : baseUrl,
    rules,
    references,
    coverage: { files: coverageList(leaf.doc["files"]), include: coverageList(leaf.doc["include"]), exclude: coverageList(leaf.doc["exclude"]) },
  };
}

const viewCache = new Map<string, { deps: ViewDep[]; view: TsConfigView | undefined }>();

/**
 * The effective view of the config at `rel` (its `extends` chain merged);
 * cached, validated by every file's mtime+size and by the absence of every
 * file that was missing when the view was built.
 */
function loadTsConfigView(workspace: string, rel: string): TsConfigView | undefined {
  const key = `${workspace}|${rel}`;
  const cached = viewCache.get(key);
  if (cached !== undefined && cached.deps.every(viewDepValid)) return cached.view;
  const chain: ChainEntry[] = [];
  const deps: ViewDep[] = [];
  collectChain(workspace, rel, 0, new Set(), chain, deps);
  const view = chain.length === 0 ? undefined : mergeChain(chain);
  if (viewCache.size >= 96 && !viewCache.has(key)) {
    const oldest = viewCache.keys().next().value;
    if (oldest !== undefined) viewCache.delete(oldest);
  }
  viewCache.set(key, { deps, view });
  return view;
}

function nearestTsConfig(run: WebRun, fromDir: string): string | undefined {
  let dir = fromDir;
  for (;;) {
    for (const name of TSCONFIG_NAMES) {
      const rel = join2(dir, name);
      if (probeFile(run, rel)) return rel;
    }
    if (dir === "") return undefined;
    dir = posixDirname(dir);
  }
}

/**
 * Whether one tsconfig `include`/`exclude` entry covers `rel`, a path relative
 * to the config's directory. The entry is a glob under tsconfig's own rules: a
 * last segment with no wildcard and no `.` names a DIRECTORY and means
 * everything below it (`src` is the recursive glob under `src`), and the
 * config directory itself (`.`, `./`) is everything. Matching is
 * `globMatchesPath` — segment-wise, linear time, no regular expression — so a
 * crafted entry (`*?` repeated) can neither stall a pack nor throw; braces and
 * character classes are literal (they can only under-match), and an entry past
 * its bounds (512 characters, 64 segments) never matches.
 */
function coverageEntryMatches(entry: string, rel: string): boolean {
  const trimmed = entry.replace(/\\/g, "/").trim();
  if (trimmed === "" || trimmed.startsWith("/")) return false; // empty, or absolute: nothing relative to match
  const cleaned = trimmed.replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
  if (cleaned === "" || cleaned === ".") return true;
  const last = cleaned.slice(cleaned.lastIndexOf("/") + 1);
  return globMatchesPath(/[*?.]/.test(last) ? cleaned : `${cleaned}/**/*`, rel);
}

function coversFile(view: TsConfigView, filePath: string): boolean {
  const dir = view.configDir;
  let rel: string;
  if (dir === "") rel = filePath;
  else if (filePath.startsWith(`${dir}/`)) rel = filePath.slice(dir.length + 1);
  else return false;
  const { files, include, exclude } = view.coverage;
  if (files?.some((f) => posixJoin(f) === rel)) return true;
  const includes = include ?? (files === undefined ? ["**/*"] : []);
  if (!includes.some((entry) => coverageEntryMatches(entry, rel))) return false;
  const excludes = exclude ?? ["node_modules", "bower_components", "jspm_packages"];
  return !excludes.some((entry) => coverageEntryMatches(entry, rel));
}

/**
 * The view that governs `importer`: the nearest config; when that one is a
 * solution-style config (`references`, no `paths`/`baseUrl` of its own), the
 * first referenced config that declares them and covers the file.
 */
function tsViewFor(run: WebRun, importer: string): TsConfigView | undefined {
  const dir = posixDirname(importer);
  if (run.configViews.has(dir)) return run.configViews.get(dir);
  const configRel = nearestTsConfig(run, dir);
  let view = configRel === undefined ? undefined : loadTsConfigView(run.workspace, configRel);
  if (view !== undefined && view.rules.length === 0 && view.baseUrl === undefined && view.references.length > 0) {
    for (const ref of view.references) {
      const refView = loadTsConfigView(run.workspace, ref);
      if (refView !== undefined && (refView.rules.length > 0 || refView.baseUrl !== undefined) && coversFile(refView, importer)) {
        view = refView;
        break;
      }
    }
  }
  run.configViews.set(dir, view);
  return view;
}

function matchPathRule(rules: readonly TsPathRule[], spec: string): { rule: TsPathRule; captured: string } | undefined {
  let best: { rule: TsPathRule; captured: string } | undefined;
  for (const rule of rules) {
    if (!rule.wildcard) {
      if (rule.key === spec) return { rule, captured: "" };
      continue;
    }
    if (spec.length < rule.prefix.length + rule.suffix.length || !spec.startsWith(rule.prefix) || !spec.endsWith(rule.suffix)) continue;
    if (best === undefined || rule.prefix.length > best.rule.prefix.length) {
      best = { rule, captured: spec.slice(rule.prefix.length, spec.length - rule.suffix.length) };
    }
  }
  return best;
}

/**
 * `paths` (the best-matching pattern's targets, in order), else `baseUrl` —
 * TypeScript's own order. A pattern that matches DECIDES: when none of its
 * targets exists the specifier is unresolved, `baseUrl` is not consulted
 * (verified against `ts.resolveModuleName`; it matters for a `"*"` catch-all).
 */
function resolveViaTsConfig(run: WebRun, view: TsConfigView, spec: string): string | undefined {
  const match = matchPathRule(view.rules, spec);
  if (match !== undefined) {
    for (const target of match.rule.targets) {
      const base = match.rule.wildcard ? target.replace("*", () => match.captured) : target;
      const hit = resolveModuleBase(run, base, true);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  if (view.baseUrl !== undefined) return resolveModuleBase(run, posixJoin(view.baseUrl, spec), true);
  return undefined;
}

// ---------------------------------------------------------------------------
// Module files: extension / index / compiled-extension / directory rules
// ---------------------------------------------------------------------------

/**
 * A TypeScript NodeNext/Bundler-resolution ESM specifier names its OWN
 * COMPILED OUTPUT extension (`import { X } from "./config.js"`) even when
 * the source on disk is `.ts`/`.tsx` — TypeScript's own resolution rule, not
 * a project convention (mirrors readCodeTaskPack.ts's independently-arrived-
 * at `ESM_COMPILED_EXTENSION_SOURCE_MAP`/`esmCompiledExtensionSourceCandidates`
 * for the identical reason: appending FURTHER extensions to a base that
 * already ends in one of these only ever produces `config.js.ts`).
 */
const ESM_SOURCE_FOR_COMPILED_EXT: ReadonlyArray<readonly [string, readonly string[]]> = [
  [".mjs", [".mts"]],
  [".cjs", [".cts"]],
  [".jsx", [".tsx"]],
  [".js", [".ts", ".tsx"]],
];

/**
 * The file that module path `base` (workspace-relative, no leading `./`)
 * names: the compiled-extension source, the file itself, `base` + an
 * extension, then (as a directory) its package.json entry and `index` files.
 * `allowManifest` is false while resolving a package.json entry itself.
 */
function resolveModuleBase(run: WebRun, spelled: string, allowManifest: boolean): string | undefined {
  const directoryOnly = spelled.endsWith("/"); // `./components/` names a directory, never a file
  // Canonical form: a `paths` substitution can bring `.`/`..` segments (`@/../lib/x` → `src/../lib/x`), and an
  // edge must carry the one canonical path so that dedupe and the never-the-importer rule can see it.
  const joined = posixJoin(spelled).replace(/\/+$/, "");
  const base = joined === "." ? "" : joined; // `./` at the workspace root is the root itself
  if (escapesWorkspace(base)) return undefined;
  if (base !== "" && !directoryOnly) {
    for (const [compiledExt, sourceExts] of ESM_SOURCE_FOR_COMPILED_EXT) {
      if (!base.endsWith(compiledExt)) continue;
      const stem = base.slice(0, -compiledExt.length);
      for (const ext of sourceExts) if (probeFile(run, `${stem}${ext}`)) return `${stem}${ext}`;
    }
    if (probeFile(run, base)) return base;
    // an explicit `.ts` names `.tsx` (and the reverse) when only that one exists — TypeScript's own rule
    if (base.endsWith(".ts") && !base.endsWith(".d.ts") && probeFile(run, `${base}x`)) return `${base}x`;
    if (base.endsWith(".tsx") && probeFile(run, base.slice(0, -1))) return base.slice(0, -1);
    for (const ext of WEB_EXTENSIONS) if (probeFile(run, `${base}${ext}`)) return `${base}${ext}`;
    for (const ext of DECLARATION_EXTENSIONS) if (probeFile(run, `${base}${ext}`)) return `${base}${ext}`;
    if (probeFile(run, `${base}.json`)) return `${base}.json`;
  }
  if (allowManifest) {
    const viaManifest = resolveDirectoryEntry(run, base);
    if (viaManifest !== undefined) return viaManifest;
  }
  for (const ext of WEB_EXTENSIONS) {
    const cand = join2(base, `index${ext}`);
    if (probeFile(run, cand)) return cand;
  }
  for (const ext of DECLARATION_EXTENSIONS) {
    const cand = join2(base, `index${ext}`);
    if (probeFile(run, cand)) return cand;
  }
  return undefined;
}

/** A directory that is itself a package: the entry its package.json names. */
function resolveDirectoryEntry(run: WebRun, dir: string): string | undefined {
  if (/\.[A-Za-z0-9]{1,5}$/.test(dir.slice(dir.lastIndexOf("/") + 1))) return undefined; // looks like a file, not a directory
  const manifestRel = join2(dir, "package.json");
  if (!probeFile(run, manifestRel)) return undefined;
  const doc = loadDoc(run.workspace, manifestRel)?.doc;
  if (doc === undefined) return undefined;
  return firstSourceElseGenerated(run, entryTargets(doc), (target) => resolveEntry(run, dir, target));
}

// ---------------------------------------------------------------------------
// package.json: entries, exports/imports maps, build output → source
// ---------------------------------------------------------------------------

const EXPORT_CONDITIONS = new Set(["source", "types", "import", "module", "default", "require", "node", "browser", "development", "production"]);

/** Target strings of an `exports`/`imports` value in preference order (string, array, nested conditions). */
function collectTargets(value: unknown, depth = 0): string[] {
  if (typeof value === "string") return [value];
  if (depth >= 5 || value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((v) => collectTargets(v, depth + 1)).slice(0, 16);
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((k) => EXPORT_CONDITIONS.has(k));
  const ordered = [...keys.filter((k) => k === "source"), ...keys.filter((k) => k !== "source")];
  return ordered.flatMap((k) => collectTargets(record[k], depth + 1)).slice(0, 16);
}

const subpathMapCache = new WeakMap<object, boolean>();

/** True for an `exports`/`imports` object keyed by subpaths (`.`, `./x`, `#x`) rather than by conditions; decided once per parsed object. */
function isSubpathMap(value: unknown): value is Record<string, unknown> {
  const record = asRecord(value);
  if (record === undefined) return false;
  let known = subpathMapCache.get(record);
  if (known === undefined) {
    known = Object.keys(record).some((key) => key.startsWith("."));
    subpathMapCache.set(record, known);
  }
  return known;
}

/**
 * The `*` pattern keys of an `exports`/`imports` map, computed once per parsed
 * map (the manifest object is cached) and capped: a lookup then costs the
 * pattern count, not the key count, so a manifest listing tens of thousands of
 * explicit subpaths cannot make every import of it expensive.
 */
const MAX_PATTERN_KEYS = 512;
const patternKeyCache = new WeakMap<object, readonly string[]>();

function patternKeysOf(map: Record<string, unknown>): readonly string[] {
  let keys = patternKeyCache.get(map);
  if (keys === undefined) {
    keys = Object.keys(map).filter((key) => key.includes("*")).slice(0, MAX_PATTERN_KEYS);
    patternKeyCache.set(map, keys);
  }
  return keys;
}

/** Targets of the `exports`/`imports` map key matching `subpath` (exact key, else the longest `*` pattern). */
function matchSubpathMap(map: Record<string, unknown>, subpath: string): string[] {
  if (!subpath.includes("*") && Object.prototype.hasOwnProperty.call(map, subpath)) return collectTargets(map[subpath]);
  let bestKey: string | undefined;
  let bestCaptured = "";
  let bestPrefix = -1;
  for (const key of patternKeysOf(map)) {
    const star = key.indexOf("*");
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (subpath.length < prefix.length + suffix.length || !subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue;
    if (prefix.length > bestPrefix) {
      bestKey = key;
      bestPrefix = prefix.length;
      bestCaptured = subpath.slice(prefix.length, subpath.length - suffix.length);
    }
  }
  if (bestKey === undefined) return [];
  return collectTargets(map[bestKey]).map((target) => target.split("*").join(bestCaptured));
}

/** Entry candidates of a package.json, best first: `source`, `exports["."]`, `module`, `main`, `types`/`typings`. */
function entryTargets(manifest: Record<string, unknown>): string[] {
  const out: string[] = [];
  const add = (v: unknown): void => {
    if (typeof v === "string" && v.length > 0 && !out.includes(v)) out.push(v);
  };
  add(manifest["source"]);
  const exportsField = manifest["exports"];
  const forDot = isSubpathMap(exportsField) ? collectTargets((exportsField as Record<string, unknown>)["."]) : collectTargets(exportsField);
  for (const target of forDot) add(target);
  for (const field of ["module", "main", "types", "typings"]) add(manifest[field]);
  return out;
}

/** Directory names a built entry commonly lives under; the source sits in `src/`. */
const BUILD_DIRS = new Set(["dist", "lib", "build", "out", "esm", "cjs", "es", "umd", "types", "typings", "_esm", "_cjs", "_types"]);
/** Directory names that conventionally hold a project's build output (see outputDirectoryOf). */
const OUTPUT_ONLY_DIRS = new Set(["dist", "build", "out"]);

/** Compiled/declaration extension → [TS source extensions, same-language source extensions]. */
const COMPILED_ENTRY_EXTENSIONS: ReadonlyArray<readonly [string, readonly string[], readonly string[]]> = [
  [".d.mts", [".mts", ".ts"], []],
  [".d.cts", [".cts", ".ts"], []],
  [".d.ts", [".ts", ".tsx"], []],
  [".mjs", [".mts", ".ts", ".tsx"], [".mjs"]],
  [".cjs", [".cts", ".ts", ".tsx"], [".cjs"]],
  [".jsx", [".tsx"], [".jsx"]],
  [".js", [".ts", ".tsx"], [".js", ".jsx"]],
];

/**
 * Source-side candidates for a package-relative entry, best first: a built
 * entry (`dist/x.js`, `lib/x.d.ts`) maps to `src/x.ts` (then the package
 * root); a compiled/declaration extension maps to its source extension next
 * to it. The entry itself is NOT included.
 */
function entrySourceCandidates(rel: string): string[] {
  const segments = rel.split("/");
  let start = 0;
  while (start < segments.length - 1 && start < 3 && BUILD_DIRS.has(segments[start]!)) start++;
  const inBuildDir = start > 0;
  const rest = segments.slice(start).join("/");
  const compiled = COMPILED_ENTRY_EXTENSIONS.find(([ext]) => rest.endsWith(ext));
  const stem = compiled === undefined ? rest : rest.slice(0, -compiled[0].length);
  const tsSources = compiled?.[1] ?? [];
  const sameLanguage = compiled?.[2] ?? [];
  const out: string[] = [];
  if (inBuildDir) {
    if (compiled === undefined) out.push(`src/${stem}`);
    for (const ext of [...tsSources, ...sameLanguage]) out.push(`src/${stem}${ext}`);
    for (const ext of tsSources) out.push(`${stem}${ext}`);
  } else {
    for (const ext of tsSources) out.push(`${stem}${ext}`);
  }
  return out;
}

/** Resolve one manifest entry/target string (relative to package directory `dir`) to a source file. */
function resolveEntry(run: WebRun, dir: string, target: string): string | undefined {
  const rel = posixJoin(target.replace(/^\.\//, "")).replace(/\/+$/, "");
  if (rel === "" || escapesWorkspace(rel)) return undefined;
  for (const candidate of entrySourceCandidates(rel)) {
    const hit = resolveModuleBase(run, posixJoin(dir, candidate), false);
    if (hit !== undefined) return hit;
  }
  return resolveModuleBase(run, posixJoin(dir, rel), false); // no source twin: the entry itself, if it exists
}

// ---------------------------------------------------------------------------
// Workspace packages (name → directory), never below node_modules
// ---------------------------------------------------------------------------

interface WorkspacePackage {
  readonly dir: string;
  readonly manifest: Record<string, unknown>;
}

interface PackageMap {
  /** null = the name is declared by several manifests (ambiguous: never resolved). */
  readonly byName: Map<string, WorkspacePackage | null>;
  readonly stamps: Array<{ abs: string; stamp: Stamp }>;
  readonly walkedAt: number;
  checkedAt: number;
}

const SKIPPED_WALK_DIRS = new Set([
  "node_modules", "bower_components", "jspm_packages", "dist", "build", "out", "coverage", "vendor", ".next", "target",
  "__pycache__", "venv",
]);

/** Up to MAX_DIRECTORY_ENTRIES entries of `abs`, sorted by name; read lazily so a huge directory costs only what is kept. */
function listEntries(abs: string): fs.Dirent[] {
  const entries: fs.Dirent[] = [];
  let dir: fs.Dir | undefined;
  try {
    dir = fs.opendirSync(abs);
    for (let entry = dir.readSync(); entry !== null && entries.length < MAX_DIRECTORY_ENTRIES; entry = dir.readSync()) entries.push(entry);
  } catch {
    /* unreadable: whatever was read so far is kept */
  } finally {
    try {
      dir?.closeSync();
    } catch {
      /* already closed */
    }
  }
  return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function walkPackages(workspace: string, now: number): PackageMap {
  const byName = new Map<string, WorkspacePackage | null>();
  const stamps: Array<{ abs: string; stamp: Stamp }> = [];
  const queue: Array<{ rel: string; depth: number }> = [{ rel: "", depth: 0 }];
  let head = 0;
  let directories = 0;
  let manifests = 0;
  while (head < queue.length && directories < MAX_WALK_DIRECTORIES && manifests < MAX_MANIFESTS) {
    const { rel, depth } = queue[head++]!;
    const abs = rel === "" ? workspace : withinWorkspace(workspace, rel);
    if (abs === undefined) continue;
    directories++;
    const entries = listEntries(abs);
    for (const entry of entries) {
      if (entry.isFile() && entry.name === "package.json") {
        const manifestRel = join2(rel, "package.json");
        const loaded = loadDoc(workspace, manifestRel);
        if (loaded === undefined) continue;
        manifests++;
        stamps.push({ abs: loaded.abs, stamp: loaded.stamp });
        const name = loaded.doc?.["name"];
        if (loaded.doc !== undefined && typeof name === "string" && name.length > 0 && name.length <= 214) {
          byName.set(name, byName.has(name) ? null : { dir: rel, manifest: loaded.doc });
        }
      } else if (
        entry.isDirectory() &&
        depth < MAX_WALK_DEPTH &&
        !entry.name.startsWith(".") &&
        !SKIPPED_WALK_DIRS.has(entry.name)
      ) {
        queue.push({ rel: join2(rel, entry.name), depth: depth + 1 });
      }
    }
  }
  return { byName, stamps, walkedAt: now, checkedAt: now };
}

const packageMaps = new Map<string, PackageMap>();

function packageMapFor(workspace: string): PackageMap {
  const now = Date.now();
  const existing = packageMaps.get(workspace);
  if (existing !== undefined) {
    if (now - existing.checkedAt < PACKAGE_MAP_RECHECK_MS) return existing;
    if (now - existing.walkedAt < PACKAGE_MAP_REWALK_MS && existing.stamps.every(({ abs, stamp }) => sameStamp(abs, stamp))) {
      existing.checkedAt = now;
      return existing;
    }
  }
  const built = walkPackages(workspace, now);
  if (packageMaps.size >= 8 && !packageMaps.has(workspace)) {
    const oldest = packageMaps.keys().next().value;
    if (oldest !== undefined) packageMaps.delete(oldest);
  }
  packageMaps.set(workspace, built);
  return built;
}

const PACKAGE_NAME_RE = /^(?:@[\w.-]+\/)?[\w.-]+$/;

function splitPackageSpecifier(spec: string): { name: string; sub: string } | undefined {
  const parts = spec.split("/");
  let name: string;
  let subParts: string[];
  if (spec.startsWith("@")) {
    if (parts.length < 2) return undefined;
    name = `${parts[0]}/${parts[1]}`;
    subParts = parts.slice(2);
  } else {
    name = parts[0]!;
    subParts = parts.slice(1);
  }
  if (!PACKAGE_NAME_RE.test(name)) return undefined;
  if (subParts.some((s) => s === "" || s === "." || s === "..")) return undefined;
  return { name, sub: subParts.join("/") };
}

/**
 * The first hit of `resolveOne` over `items` that is NOT a generated artifact
 * (a real source, or a plain file); a generated artifact without a source twin
 * (a built `main`, a `.d.ts`) is only the last resort, so that it never shadows
 * a later entry that names real source.
 */
function firstSourceElseGenerated<T>(run: WebRun, items: readonly T[], resolveOne: (item: T) => string | undefined): string | undefined {
  let generated: string | undefined;
  for (const item of items) {
    const hit = resolveOne(item);
    if (hit === undefined) continue;
    if (!isGeneratedOutputFile(run, hit)) return hit;
    generated ??= hit;
  }
  return generated;
}

function packageEntry(run: WebRun, pkg: WorkspacePackage): string | undefined {
  const hit = firstSourceElseGenerated(run, entryTargets(pkg.manifest), (target) => resolveEntry(run, pkg.dir, target));
  return hit ?? resolveModuleBase(run, join2(pkg.dir, "index"), false);
}

function packageSubpath(run: WebRun, pkg: WorkspacePackage, sub: string): string | undefined {
  const exportsField = pkg.manifest["exports"];
  if (isSubpathMap(exportsField)) {
    const viaExports = firstSourceElseGenerated(run, matchSubpathMap(exportsField, `./${sub}`), (target) => resolveEntry(run, pkg.dir, target));
    if (viaExports !== undefined) return viaExports;
  }
  const candidates = entrySourceCandidates(sub);
  candidates.push(sub, `src/${sub}`);
  return firstSourceElseGenerated(run, candidates, (candidate) => resolveModuleBase(run, posixJoin(pkg.dir, candidate), true));
}

function resolveWorkspacePackage(run: WebRun, spec: string): string | undefined {
  const split = splitPackageSpecifier(spec);
  if (split === undefined) return undefined;
  const pkg = packageMapFor(run.workspace).byName.get(split.name);
  if (pkg === undefined || pkg === null) return undefined;
  return split.sub === "" ? packageEntry(run, pkg) : packageSubpath(run, pkg, split.sub);
}

/** `#alias` — the nearest package.json's `imports` map (Node subpath imports, also honoured by TypeScript). */
function resolvePackageImport(run: WebRun, importer: string, spec: string): string | undefined {
  let dir = posixDirname(importer);
  for (;;) {
    const manifestRel = join2(dir, "package.json");
    if (probeFile(run, manifestRel)) {
      const imports = asRecord(loadDoc(run.workspace, manifestRel)?.doc?.["imports"]);
      if (imports === undefined) return undefined;
      for (const target of matchSubpathMap(imports, spec)) {
        if (!(target.startsWith("./") || target.startsWith("../"))) continue; // an external package
        const hit = resolveEntry(run, dir, target);
        if (hit !== undefined) return hit;
      }
      return undefined;
    }
    if (dir === "") return undefined;
    dir = posixDirname(dir);
  }
}

// ---------------------------------------------------------------------------
// Specifier resolution
// ---------------------------------------------------------------------------

/**
 * A project's build output directory: `dist`/`build`/`out` directly inside a
 * directory that holds a package.json or tsconfig.json. It MAY hold generated
 * code (declaration files, compiled JS) — or ordinary checked-in source (build
 * scripts), which is why nothing is decided by the directory name alone.
 */
function outputDirectoryOf(run: WebRun, rel: string): { root: string; rest: string } | undefined {
  const segments = rel.split("/");
  for (let i = 0; i < segments.length - 1; i++) {
    if (!OUTPUT_ONLY_DIRS.has(segments[i]!)) continue;
    const root = segments.slice(0, i).join("/");
    if (probeFile(run, join2(root, "package.json")) || probeFile(run, join2(root, "tsconfig.json"))) {
      return { root, rest: segments.slice(i + 1).join("/") };
    }
  }
  return undefined;
}

/** What a compiler emits: declaration files and compiled JavaScript (`.d.ts`, `.d.mts`, `.d.cts`, `.js`, `.mjs`, `.cjs`, `.jsx`). */
const GENERATED_ARTIFACT_RE = /\.(?:d\.[cm]?ts|[cm]?jsx?)$/;
/** A TypeScript source, never a declaration file: the only twin that shows an artifact was generated. */
const TS_SOURCE_RE = /(?<!\.d)\.[cm]?tsx?$/;

/** True for a declaration/compiled file inside a project's output directory. */
function isGeneratedOutputFile(run: WebRun, rel: string): boolean {
  const output = outputDirectoryOf(run, rel);
  return output !== undefined && GENERATED_ARTIFACT_RE.test(output.rest);
}

/**
 * The source file a generated artifact in a project's output directory was
 * built from (`packages/x/dist/index.d.ts` → `packages/x/src/index.ts`), or
 * undefined: not in an output directory, not a generated artifact (a `.ts`
 * file there is source), or no TypeScript twin exists.
 */
function sourceTwinOf(run: WebRun, rel: string): string | undefined {
  const output = outputDirectoryOf(run, rel);
  if (output === undefined || !GENERATED_ARTIFACT_RE.test(output.rest)) return undefined;
  for (const candidate of entrySourceCandidates(`dist/${output.rest}`)) {
    if (!TS_SOURCE_RE.test(candidate)) continue;
    const twin = resolveModuleBase(run, posixJoin(output.root, candidate), false);
    if (twin !== undefined && twin !== rel) return twin;
  }
  return undefined;
}

/**
 * A relative specifier names its file: the author wrote that path, so it is
 * never redirected. Everything else (a `paths` alias, a package, `#imports`)
 * that lands on a generated artifact with a real source twin resolves to the
 * twin; a resolved file without a twin is kept as it is.
 */
function resolveSpecifier(run: WebRun, importer: string, rawSpec: string): string | undefined {
  const hit = resolveSpecifierUnfiltered(run, importer, rawSpec);
  if (hit === undefined || /^\.{1,2}(?:\/|$)/.test(rawSpec)) return hit;
  return sourceTwinOf(run, hit) ?? hit;
}

function resolveSpecifierUnfiltered(run: WebRun, importer: string, rawSpec: string): string | undefined {
  let spec = rawSpec;
  const query = spec.indexOf("?");
  if (query > 0) spec = spec.slice(0, query); // Vite/webpack resource queries (`./icon.svg?react`)
  if (spec === "" || spec.length > MAX_SPECIFIER_CHARS || spec.includes("!") || spec.includes(":") || spec.includes("\\") || spec.startsWith("/")) {
    return undefined;
  }
  if (spec === "." || spec === ".." || spec.startsWith("./") || spec.startsWith("../")) {
    return resolveModuleBase(run, posixJoin(posixDirname(importer), spec), true);
  }
  if (spec.startsWith("#")) {
    // Node subpath imports first; a `paths` key may still claim a `#` name (TypeScript checks both)
    const imported = resolvePackageImport(run, importer, spec);
    if (imported !== undefined) return imported;
  }
  const view = tsViewFor(run, importer);
  if (view !== undefined) {
    const hit = resolveViaTsConfig(run, view, spec);
    if (hit !== undefined) return hit;
  }
  return resolveWorkspacePackage(run, spec);
}

// ---------------------------------------------------------------------------
// Statement scan (code only)
// ---------------------------------------------------------------------------

type BindingKind = "default" | "namespace" | "named";

interface Binding {
  /** Name the target module exports (`default` for a default import, `*` for a namespace). */
  readonly imported: string;
  /** Name bound in the importing file (for a re-export: the exported name). */
  readonly local: string;
  readonly kind: BindingKind;
}

interface WebOccurrence {
  readonly spec: string;
  /** 1-based line of the specifier literal. */
  readonly line: number;
  readonly form: "import" | "export" | "dynamic" | "require" | "bare";
  /** `export * from '…'` (no name). */
  readonly star: boolean;
  readonly bindings: readonly Binding[];
}

const IDENT_RE = /^[A-Za-z_$][\w$]*$/;

function isSpaceCode(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13;
}

function isIdentChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\w$]/.test(ch);
}

function lineStartsOf(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return starts;
}

function lineOfOffset(starts: readonly number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** `pos` advanced past whitespace and comments (a comment is blank in `masked` and starts with `/`). */
function skipTrivia(text: string, masked: string, start: number): number {
  let pos = start;
  while (pos < text.length) {
    const code = text.charCodeAt(pos);
    if (isSpaceCode(code)) {
      pos++;
    } else if (code === 47 && masked[pos] === " " && text.charCodeAt(pos + 1) === 47) {
      const end = text.indexOf("\n", pos);
      pos = end === -1 ? text.length : end;
    } else if (code === 47 && masked[pos] === " " && text.charCodeAt(pos + 1) === 42) {
      const end = text.indexOf("*/", pos + 2);
      pos = end === -1 ? text.length : end + 2;
    } else {
      break;
    }
  }
  return pos;
}

/** The string literal opening at `pos` of `text` — only when `masked` blanked it (a real literal in code). */
function literalAt(text: string, masked: string, pos: number): string | undefined {
  const quote = text[pos];
  if (quote !== "'" && quote !== '"' && quote !== "`") return undefined;
  if (masked[pos] !== " ") return undefined;
  let end = pos + 1;
  while (end < text.length && end - pos <= MAX_SPECIFIER_CHARS) {
    const c = text[end]!;
    if (c === "\\") {
      end += 2;
      continue;
    }
    if (c === quote) break;
    if (c === "\n") return undefined;
    end++;
  }
  if (text[end] !== quote) return undefined;
  const value = text.slice(pos + 1, end);
  if (value.length === 0 || (quote === "`" && value.includes("${"))) return undefined;
  return value;
}

/** How far back from a `from` the statement's `import`/`export` keyword is looked for. */
const STATEMENT_WINDOW_CHARS = 2500;

/** The `import`/`export` keyword that opens the statement containing the `from` at `at`, and the clause between. */
function statementBefore(masked: string, at: number): { kind: "import" | "export"; clause: string } | undefined {
  const floor = Math.max(0, at - STATEMENT_WINDOW_CHARS);
  const window = masked.slice(floor, at);
  let searchFrom = window.length;
  for (let attempt = 0; attempt < 6 && searchFrom > 0; attempt++) {
    const imp = window.lastIndexOf("import", searchFrom - 1);
    const exp = window.lastIndexOf("export", searchFrom - 1);
    const start = Math.max(imp, exp);
    if (start < 0) return undefined;
    if (!isIdentChar(start === 0 ? masked[floor - 1] : window[start - 1]) && !isIdentChar(window[start + 6])) {
      const clause = window.slice(start + 6);
      if (clause.includes(";")) return undefined;
      return { kind: start === imp ? "import" : "export", clause };
    }
    searchFrom = start;
  }
  return undefined;
}

function splitAs(item: string): { imported: string; local: string } | undefined {
  const parts = item.split(/\s+as\s+/).map((s) => s.trim());
  const imported = parts[0]!;
  const local = parts[1] ?? imported;
  return IDENT_RE.test(imported) && IDENT_RE.test(local) ? { imported, local } : undefined;
}

/** `import a, { b as c } from` / `export { d } from` / `export * as ns from` — the text between the keyword and `from`. */
function parseModuleClause(rawClause: string, isExport: boolean): { bindings: Binding[]; star: boolean } {
  const bindings: Binding[] = [];
  let clause = rawClause.trim();
  clause = isExport ? clause.replace(/^type\s+(?=[{*])/, "") : clause.replace(/^(?:type|typeof)\s+(?=\S)/, "");
  const brace = /\{([^}]*)\}/.exec(clause);
  if (brace !== null) {
    for (const item of brace[1]!.split(",")) {
      const cleaned = item.replace(/^\s*type\s+(?=\S)/, "").trim();
      if (cleaned === "") continue;
      const pair = splitAs(cleaned);
      if (pair !== undefined) bindings.push({ imported: pair.imported, local: pair.local, kind: "named" });
    }
  }
  const before = brace === null ? clause : clause.slice(0, brace.index);
  let star = false;
  const namespace = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(before);
  if (namespace !== null) bindings.push({ imported: "*", local: namespace[1]!, kind: "namespace" });
  else if (isExport && /\*/.test(before)) star = true;
  if (!isExport) {
    const rest = before.replace(/\*\s+as\s+[A-Za-z_$][\w$]*/, "");
    const def = /^\s*([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(rest);
    if (def !== null) bindings.push({ imported: "default", local: def[1]!, kind: "default" });
  }
  return { bindings, star };
}

/** Bindings of `const x = require(…)` / `const { a, b: c } = await import(…)` / `import x = require(…)`. */
function bindingsFromLhs(masked: string, at: number): Binding[] {
  const prefix = masked.slice(Math.max(0, at - 240), at);
  const m = /(?:\b(?:const|let|var)\s+|\bimport\s+(?:type\s+)?)([A-Za-z_$][\w$]*|\{[^{}=;]*\})\s*=\s*(?:\(\s*)?(?:await\s+)?(?:\(\s*)?$/.exec(prefix);
  if (m === null) return [];
  const target = m[1]!;
  if (!target.startsWith("{")) return [{ imported: "*", local: target, kind: "namespace" }];
  const bindings: Binding[] = [];
  for (const item of target.slice(1, -1).split(",")) {
    const parts = item.split(":").map((s) => s.trim());
    const imported = parts[0]!;
    const local = parts[1] ?? imported;
    if (IDENT_RE.test(imported) && IDENT_RE.test(local)) bindings.push({ imported, local, kind: "named" });
  }
  return bindings;
}

function scanWeb(text: string, limit: number): { masked: string; occurrences: WebOccurrence[] } {
  // sfCodeMask treats `#` as a comment opener; in TS/JS it is a private-name/shebang character.
  const masked = maskCommentsAndStrings(text.includes("#") ? text.replace(/#/g, "_") : text);
  const starts = lineStartsOf(text);
  const occurrences: WebOccurrence[] = [];
  const keyword = /\b(from|import|require)\b/g;
  let examined = 0;
  for (let m = keyword.exec(masked); m !== null && occurrences.length < limit && examined < limit * 20; m = keyword.exec(masked)) {
    examined++;
    const kw = m[1]!;
    const at = m.index;
    if (at > 0 && /[.$]/.test(masked[at - 1]!)) continue; // `loader.import(…)`, `Array.from(…)`
    let pos = skipTrivia(text, masked, at + kw.length);
    let call = false;
    if (text[pos] === "(") {
      if (kw === "from") continue;
      call = true;
      pos = skipTrivia(text, masked, pos + 1);
    } else if (kw === "require") {
      continue;
    }
    const spec = literalAt(text, masked, pos);
    if (spec === undefined) continue;
    const line = lineOfOffset(starts, pos);
    if (kw === "from") {
      const statement = statementBefore(masked, at);
      if (statement === undefined) continue;
      const clause = parseModuleClause(statement.clause, statement.kind === "export");
      occurrences.push({ spec, line, form: statement.kind, star: clause.star, bindings: clause.bindings });
    } else if (call) {
      occurrences.push({ spec, line, form: kw === "import" ? "dynamic" : "require", star: false, bindings: bindingsFromLhs(masked, at) });
    } else {
      occurrences.push({ spec, line, form: "bare", star: false, bindings: [] });
    }
  }
  return { masked, occurrences };
}

/** Names a statement binds: named imports (imported and local side), then namespace/default locals. */
function bindingNames(bindings: readonly Binding[]): string[] {
  const named = bindings.filter((b) => b.kind === "named").flatMap((b) => [b.imported, b.local]);
  const others = bindings.filter((b) => b.kind !== "named").map((b) => b.local);
  return uniqueNames([...named, ...others]);
}

// ---------------------------------------------------------------------------
// One-hop barrel re-exports
// ---------------------------------------------------------------------------

interface Reexports {
  /** Exported name → module it comes from and its name there (`default`, `*` for a namespace). */
  readonly named: ReadonlyMap<string, { readonly spec: string; readonly orig: string }>;
  /** `export * from '…'` specifiers. */
  readonly stars: readonly string[];
}

const reexportCache = new StampedCache<Reexports | undefined>(256);
const exportNamesCache = new StampedCache<ReadonlySet<string>>(256);

const LOCAL_EXPORT_LIST_RE = /\bexport\s+(?:type\s+)?\{([^}]{0,4000})\}(?!\s*from\b)/g;
const EXPORT_DECLARATION_RE =
  /\bexport\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:const\s+enum|enum|function\s*\*?|class|interface|type|namespace|const|let|var)\s+([A-Za-z_$][\w$]*)/g;

function isWebSourcePath(p: string): boolean {
  return WEB_EXTENSIONS.some((ext) => p.endsWith(ext));
}

function readSource(run: WebRun, rel: string): { abs: string; stamp: Stamp; text: string } | undefined {
  const st = statRegularFile(run.workspace, rel);
  if (st === undefined || st.stamp.size > MAX_SOURCE_READ_BYTES || !isInsideRealWorkspace(run.workspace, st.abs)) return undefined;
  try {
    return { abs: st.abs, stamp: st.stamp, text: fs.readFileSync(st.abs, "utf8") };
  } catch {
    return undefined;
  }
}

function parseReexports(fullText: string): Reexports {
  const text = fullText.length > MAX_BARREL_SCAN_CHARS ? fullText.slice(0, MAX_BARREL_SCAN_CHARS) : fullText;
  const { masked, occurrences } = scanWeb(text, MAX_BARREL_SPECIFIERS);
  const named = new Map<string, { spec: string; orig: string }>();
  const stars: string[] = [];
  const imports = new Map<string, { spec: string; imported: string }>();
  for (const occ of occurrences) {
    if (occ.form === "import") {
      for (const b of occ.bindings) imports.set(b.local, { spec: occ.spec, imported: b.imported });
    } else if (occ.form === "export") {
      if (occ.star) stars.push(occ.spec);
      for (const b of occ.bindings) named.set(b.local, { spec: occ.spec, orig: b.imported });
    }
  }
  // `import { a } from './a'; export { a };` — the two-step re-export.
  for (const m of masked.matchAll(LOCAL_EXPORT_LIST_RE)) {
    for (const item of m[1]!.split(",")) {
      const pair = splitAs(item.replace(/^\s*type\s+(?=\S)/, "").trim());
      if (pair === undefined) continue;
      const source = imports.get(pair.imported);
      if (source !== undefined && !named.has(pair.local)) named.set(pair.local, { spec: source.spec, orig: source.imported });
    }
  }
  return { named, stars };
}

function reexportsOf(run: WebRun, rel: string): Reexports | undefined {
  const st = statRegularFile(run.workspace, rel);
  if (st === undefined) return undefined;
  const key = `${run.workspace}|${st.abs}`;
  const hit = reexportCache.get(key, st.stamp);
  if (hit !== undefined) return hit.value;
  const source = readSource(run, rel);
  const value = source === undefined ? undefined : parseReexports(source.text);
  reexportCache.set(key, st.stamp, value);
  return value;
}

/** Names `rel` exports directly: exported declarations, export lists, default, namespace re-exports. */
function exportedNamesOf(run: WebRun, rel: string): ReadonlySet<string> {
  const st = statRegularFile(run.workspace, rel);
  if (st === undefined) return new Set();
  const key = `${run.workspace}|${st.abs}`;
  const hit = exportNamesCache.get(key, st.stamp);
  if (hit !== undefined) return hit.value;
  const names = new Set<string>();
  const source = readSource(run, rel);
  if (source !== undefined) {
    const text = source.text.length > MAX_BARREL_SCAN_CHARS ? source.text.slice(0, MAX_BARREL_SCAN_CHARS) : source.text;
    for (const decl of declarationsIn(rel, text)) {
      if (decl.exported && decl.container === undefined) names.add(decl.symbol);
    }
    const masked = maskCommentsAndStrings(text.includes("#") ? text.replace(/#/g, "_") : text);
    for (const m of masked.matchAll(EXPORT_DECLARATION_RE)) names.add(m[1]!);
    for (const m of masked.matchAll(/\bexport\s+(?:type\s+)?\{([^}]{0,4000})\}/g)) {
      for (const item of m[1]!.split(",")) {
        const pair = splitAs(item.replace(/^\s*type\s+(?=\S)/, "").trim());
        if (pair !== undefined) names.add(pair.local);
      }
    }
    for (const m of masked.matchAll(/\bexport\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\b/g)) names.add(m[1]!);
    if (/\bexport\s+default\b/.test(masked)) names.add("default");
  }
  exportNamesCache.set(key, st.stamp, names);
  return names;
}

/** The module that `barrel` re-exports `importedName` from (one hop), or undefined. */
function lookupReexport(run: WebRun, barrel: string, importedName: string): { path: string; orig: string } | undefined {
  const info = reexportsOf(run, barrel);
  if (info === undefined) return undefined;
  const direct = info.named.get(importedName);
  if (direct !== undefined) {
    const target = resolveSpecifier(run, barrel, direct.spec);
    return target !== undefined && target !== barrel ? { path: target, orig: direct.orig } : undefined;
  }
  if (importedName === "default") return undefined; // `export *` never re-exports the default
  for (const spec of info.stars) {
    if (run.starReads >= MAX_STAR_READS) break;
    const target = resolveSpecifier(run, barrel, spec);
    if (target === undefined || target === barrel || !isWebSourcePath(target)) continue;
    run.starReads++;
    if (exportedNamesOf(run, target).has(importedName)) return { path: target, orig: importedName };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function resolveWebImports(workspace: string, filePath: string, lines: readonly string[]): ResolvedImport[] {
  const out: ResolvedImport[] = [];
  try {
    // forward slashes, no `.` segments or leading `./`: the importer is compared with canonical edge paths
    collectWebImports(workspace, posixJoin(filePath.replace(/\\/g, "/")), lines, out);
  } catch {
    // The hooks that call this run inside pack construction: a defect here must cost the edges, never the pack.
  }
  return out;
}

function collectWebImports(workspace: string, importer: string, lines: readonly string[], out: ResolvedImport[]): void {
  let text = lines.join("\n");
  if (text.length > MAX_SCAN_CHARS) text = text.slice(0, MAX_SCAN_CHARS);
  if (!/\b(?:import|require|from)\b/.test(text)) return;
  const { occurrences } = scanWeb(text, MAX_SPECIFIERS);
  if (occurrences.length === 0) return;
  const run = newRun(workspace);
  for (const occ of occurrences) {
    if (out.length >= MAX_RAW_EDGES) break;
    const target = resolveSpecifier(run, importer, occ.spec);
    if (target === undefined || target === importer || !realInsideRel(workspace, target)) continue;
    out.push({ path: target, line: occ.line, kind: "import", names: bindingNames(occ.bindings) });
    if (occ.form === "export" || occ.form === "bare" || !isWebSourcePath(target)) continue;
    const info = reexportsOf(run, target);
    if (info === undefined || (info.named.size === 0 && info.stars.length === 0)) continue; // not a barrel: nothing to look up
    const hopEdges = new Map<string, ResolvedImport>();
    for (const binding of occ.bindings) {
      if (binding.kind === "namespace") continue;
      const candidate = info.named.has(binding.imported) || (binding.imported !== "default" && info.stars.length > 0);
      if (!candidate) continue;
      if (run.hopLookups >= MAX_HOP_LOOKUPS || out.length >= MAX_RAW_EDGES) break;
      run.hopLookups++;
      const hop = lookupReexport(run, target, binding.imported);
      if (hop === undefined || hop.path === importer || !realInsideRel(workspace, hop.path)) continue;
      const names = uniqueNames([binding.imported, binding.local, hop.orig]).filter((n) => n !== "default");
      const sameTarget = hopEdges.get(hop.path);
      if (sameTarget !== undefined) {
        // several names of one statement re-exported from the same module: one edge carrying all of them
        sameTarget.names.splice(0, sameTarget.names.length, ...uniqueNames([...sameTarget.names, ...names]));
        continue;
      }
      const edge: ResolvedImport = { path: hop.path, line: occ.line, kind: "import", names };
      hopEdges.set(hop.path, edge);
      out.push(edge);
    }
  }
}

/** Drops every cache (manifests, config views, package maps, barrel scans, symlink verdicts). For tests. */
export function resetWebImportCaches(): void {
  docCache.clear();
  viewCache.clear();
  packageMaps.clear();
  reexportCache.clear();
  exportNamesCache.clear();
  realRoots.clear();
  realPathVerdicts.clear();
}
