/**
 * readCodeOverview.ts — compact repo/package map for broad understanding tasks.
 *
 * This is intentionally body-free: it returns package roles, source entrypoints,
 * command/tool surfaces, and handle-backed reading order. The MCP schema cost is
 * paid only by adding one read_code mode value; the larger behavior lives here.
 */

import * as fs from "fs";
import * as path from "path";
import { handleTable } from "../util/handles.js";
import { isSourceOnlyExcludedPath } from "./walkRepo.js";
import { safeResolve, resolveReal, isWithin } from "../util/safePath.js";

export const MAX_OVERVIEW_BYTES = 4096;

interface PackageJson {
  name?: string;
  description?: string;
  workspaces?: string[] | { packages?: string[] };
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  bin?: Record<string, string> | string;
  main?: string;
  types?: string;
  exports?: unknown;
}

export interface OverviewPackage {
  path: string;
  name?: string;
  role: string;
  entrypoints?: string[];
  commands?: string[];
  bins?: string[];
}

export interface OverviewReadTarget {
  path: string;
  handle: string;
  why: string;
  line?: number;
  range?: string;
  target: string;
}

export interface ReadCodeOverviewOutput {
  mode: "overview";
  repo: { name: string; handle: string };
  packages: OverviewPackage[];
  tools?: string[];
  commands?: string[];
  cli_commands?: string[];
  flows?: string[];
  recommended_reading_order: OverviewReadTarget[];
  truncated: boolean;
  /** Retry guidance when the scoped path resolved to no package map. */
  hint?: string;
  /** Concrete next TL call to run when this overview is empty. */
  next?: string;
  /**
   * Set only when the effective scope silently diverged from the requested
   * `path`: the path did not exist, or it had no package.json of its own and
   * climbing landed on an ANCESTOR beyond its nearest enclosing package (i.e.
   * the requested path had no package.json anywhere in its own ancestry, so
   * the workspace root was used as a last-resort fallback). Absent when the
   * scope resolved to the path's own nearest enclosing package — that climb
   * is expected behavior, not a surprise.
   */
  scope_note?: string;
}

interface PackageInfo {
  path: string;
  pkg: PackageJson | null;
  entrypoints: string[];
  commands: string[];
  bins: string[];
  exportsList: string[];
  role: string;
}

function readJson(filePath: string): PackageJson | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as PackageJson;
  } catch {
    return null;
  }
}

function existsFile(workspace: string, rel: string): boolean {
  try {
    return fs.statSync(path.join(workspace, rel)).isFile();
  } catch {
    return false;
  }
}

function relToSourcePath(rel: string): string | null {
  const clean = rel.replace(/\\/g, "/").replace(/^\.\//, "");
  const dist = clean.match(/^dist\/(.+)\.(?:[cm]?js|jsx|d\.ts)$/);
  if (dist?.[1]) return `src/${dist[1]}.ts`;
  const js = clean.match(/^(.+)\.(?:[cm]?js|jsx)$/);
  if (js?.[1]) return `${js[1]}.ts`;
  return null;
}

function workspaceRel(...parts: string[]): string {
  return parts
    .filter((p) => p !== "" && p !== ".")
    .join("/")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\.\//, "");
}

function packageRel(pkgPath: string, rel: string): string {
  return workspaceRel(pkgPath, rel.replace(/\\/g, "/").replace(/^\.\//, ""));
}

function workspacePatterns(pkg: PackageJson | null): string[] {
  const ws = pkg?.workspaces;
  if (Array.isArray(ws)) return ws;
  if (ws && Array.isArray(ws.packages)) return ws.packages;
  return [];
}

function expandWorkspacePattern(workspace: string, pattern: string): string[] {
  const clean = pattern.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!clean.includes("*")) return existsFile(workspace, `${clean}/package.json`) ? [clean] : [];
  const star = clean.indexOf("*");
  const base = clean.slice(0, star).replace(/\/+$/, "");
  const baseAbs = path.join(workspace, base);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(baseAbs, { withFileTypes: true }) as fs.Dirent[];
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => `${base}/${e.name}`)
    .filter((rel) => existsFile(workspace, `${rel}/package.json`))
    .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
}

function packagePaths(workspace: string, rootPkg: PackageJson | null): string[] {
  const patterns = workspacePatterns(rootPkg);
  const expanded = patterns.flatMap((pattern) => expandWorkspacePattern(workspace, pattern));
  if (expanded.length > 0) return expanded;
  return existsFile(workspace, "package.json") ? ["."] : [];
}

/**
 * Discover package.json-bearing directories under a scope root by walking
 * the filesystem directly (no reliance on a root package.json declaring
 * "workspaces"). Used when `path` scopes the overview to a subtree that has
 * no manifest of its own (e.g. a fixture/example directory nested inside a
 * larger monorepo). Bounded depth + directory count to stay cheap.
 *
 * Returns workspace-relative package directories (POSIX, "." excluded
 * unless scopeRel itself is a package).
 */
function discoverPackagesUnder(workspace: string, scopeRel: string, maxDirs = 400): string[] {
  const scopeAbs = path.join(workspace, scopeRel === "." ? "" : scopeRel);
  const out: string[] = [];
  let visited = 0;

  function walk(absDir: string, depth: number): void {
    if (visited >= maxDirs || depth > 4) return;
    visited++;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true }) as fs.Dirent[];
    } catch {
      return;
    }
    entries.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
    const rel = workspaceRel(path.relative(workspace, absDir).replace(/\\/g, "/"));
    if (entries.some((e) => e.isFile() && e.name === "package.json")) {
      out.push(rel === "" ? "." : rel);
    }
    for (const entry of entries) {
      if (visited >= maxDirs) break;
      if (!entry.isDirectory()) continue;
      if (OVERVIEW_SKIP_DIRS.has(entry.name)) continue;
      const childRel = `${rel === "" ? "" : `${rel}/`}${entry.name}/`;
      if (isSourceOnlyExcludedPath(childRel)) continue;
      walk(path.join(absDir, entry.name), depth + 1);
    }
  }

  walk(scopeAbs, 0);
  return out;
}

interface EnclosingPackageResult {
  /** Workspace-relative package directory (POSIX), or null if none exists. */
  pkgPath: string | null;
  /**
   * True when `pkgPath` was found by actually walking up scopeRel's own
   * ancestor chain (a genuine "nearest enclosing package" hit). False when
   * scopeRel had no package.json anywhere in its own ancestry and the
   * workspace root was returned only as a last-resort fallback — i.e. the
   * resolved scope is an ANCESTOR beyond the nearest enclosing package.
   */
  isOwnAncestor: boolean;
}

/**
 * Climb UPWARD from scopeRel to the nearest enclosing directory that has a
 * `package.json`, bounded at the workspace root. Used when a `path` points
 * INSIDE a package but below its manifest root (e.g. `.../apps/api/src`):
 * downward discovery finds no package.json below the deep path, so we resolve
 * the overview to the containing package instead of returning an empty map.
 */
function findEnclosingPackage(workspace: string, scopeRel: string): EnclosingPackageResult {
  let current = workspaceRel(scopeRel);
  if (current === "" || current === ".") {
    return { pkgPath: existsFile(workspace, "package.json") ? "." : null, isOwnAncestor: true };
  }
  // Walk parent directories: scopeRel, its parent, ... up to workspace root.
  while (current && current !== "." && current !== "/") {
    if (existsFile(workspace, workspaceRel(current, "package.json"))) {
      return { pkgPath: current, isOwnAncestor: true };
    }
    const parent = path.posix.dirname(current);
    if (parent === current) break;
    current = parent === "." ? "" : parent;
  }
  // No package.json anywhere in scopeRel's own ancestry: workspace root is
  // used only as a last-resort fallback, not a genuine ancestor hit.
  return { pkgPath: existsFile(workspace, "package.json") ? "." : null, isOwnAncestor: false };
}

function binTargets(pkg: PackageJson | null): string[] {
  const bin = pkg?.bin;
  if (!bin) return [];
  if (typeof bin === "string") return [bin];
  return Object.values(bin);
}

function binNames(pkg: PackageJson | null): string[] {
  const bin = pkg?.bin;
  if (!bin) return [];
  if (typeof bin === "string") return [path.basename(bin)];
  return Object.keys(bin).sort();
}

function collectExportTargets(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
    return out;
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      if (out.length >= 16) break;
      collectExportTargets(v, out);
    }
  }
  return out;
}

function targetVariants(raw: string): string[] {
  const clean = raw.replace(/\\/g, "/").replace(/^\.\//, "");
  if (/\.json$/i.test(clean)) return [];
  const variants = new Set<string>();
  const source = relToSourcePath(clean);
  if (source) variants.add(source);
  if (!path.posix.extname(clean)) {
    variants.add(`${clean}.ts`);
    variants.add(`${clean}.js`);
    variants.add(`${clean}/index.ts`);
    variants.add(`${clean}/index.js`);
  }
  variants.add(clean);
  return [...variants];
}

function sourceEntrypoints(workspace: string, pkgPath: string, pkg: PackageJson | null): string[] {
  const candidates = new Set<string>();
  const fallbackCandidates = new Set<string>();
  for (const raw of [pkg?.main, pkg?.types, ...binTargets(pkg), ...collectExportTargets(pkg?.exports)]) {
    if (!raw) continue;
    const existing = targetVariants(raw)
      .map((variant) => packageRel(pkgPath, variant))
      .filter((rel) => existsFile(workspace, rel));
    const source = existing.find((rel) => !rel.includes("/dist/") && !rel.startsWith("dist/"));
    if (source) {
      candidates.add(source);
    } else if (existing[0]) {
      fallbackCandidates.add(existing[0]);
    }
  }

  const stems = [
    "index",
    "main",
    "app",
    "server",
    "cli",
    "bin",
    "worker",
    "extension",
    "commands",
    "routes",
    "router",
  ];
  const exts = [".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs", ".cjs"];
  for (const stem of stems) {
    for (const ext of exts) {
      candidates.add(packageRel(pkgPath, `src/${stem}${ext}`));
    }
  }

  return [...candidates, ...fallbackCandidates]
    .filter((rel) => existsFile(workspace, rel))
    .slice(0, 4);
}

function readText(workspace: string, rel: string): string | null {
  let raw = "";
  try {
    raw = fs.readFileSync(path.join(workspace, rel), "utf8");
  } catch {
    return null;
  }
  return raw;
}

function lineInfo(workspace: string, rel: string): Pick<OverviewReadTarget, "line" | "range"> {
  const raw = readText(workspace, rel);
  if (raw === null) return {};
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const withoutTrailing = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  const lines = withoutTrailing.length > 0 ? withoutTrailing.split("\n") : [""];
  const firstUsefulIdx = lines.findIndex((line) => {
    const t = line.trim();
    return t.length > 0 && !t.startsWith("//") && !t.startsWith("/*") && !t.startsWith("*") && !t.startsWith("#");
  });
  return {
    line: (firstUsefulIdx >= 0 ? firstUsefulIdx : 0) + 1,
    range: `1-${Math.max(1, lines.length)}`,
  };
}

function parseCommandCases(raw: string): string[] {
  const out = new Set<string>();
  for (const m of raw.matchAll(/case\s+"([^"-][^"]*)"/g)) {
    const cmd = m[1];
    if (cmd && !cmd.startsWith("-")) out.add(cmd);
  }
  for (const m of raw.matchAll(/(?:command|name)\s*:\s*["']([A-Za-z0-9:_-]{2,})["']/g)) {
    const cmd = m[1];
    if (cmd && !cmd.includes("/") && !cmd.startsWith("-")) out.add(cmd);
  }
  for (const m of raw.matchAll(/\.command\(["']([A-Za-z0-9:_-]{2,})["']/g)) {
    const cmd = m[1];
    if (cmd && !cmd.startsWith("-")) out.add(cmd);
  }
  return [...out].slice(0, 16);
}

function packageLooksCli(pkg: PackageInfo): boolean {
  const text = `${pkg.path} ${pkg.pkg?.name ?? ""} ${pkg.pkg?.description ?? ""}`.toLowerCase();
  if (/\b(cli|command-line|command line|console)\b/.test(text)) return true;
  return pkg.bins.length > 0 && !packageLooksMcp(pkg);
}

function inferCliCommands(workspace: string, packages: PackageInfo[]): string[] {
  const out = new Set<string>();
  const cliPackages = packages.filter(packageLooksCli);
  for (const pkg of cliPackages) {
    for (const bin of pkg.bins) out.add(bin);
    for (const rel of pkg.entrypoints) {
      const raw = readText(workspace, rel);
      if (!raw) continue;
      for (const cmd of parseCommandCases(raw)) out.add(cmd);
      if (out.size >= 16) break;
    }
    if (out.size >= 16) break;
  }
  return [...out].slice(0, 16);
}

function packageLooksMcp(pkg: PackageInfo): boolean {
  const text = `${pkg.path} ${pkg.pkg?.name ?? ""} ${pkg.pkg?.description ?? ""}`.toLowerCase();
  return /\bmcp\b|model\s+context\s+protocol|modelcontextprotocol|inputschema|tools\/list/.test(text);
}

function candidateSourceFiles(workspace: string, pkg: PackageInfo): string[] {
  const out = new Set(pkg.entrypoints);
  for (const rel of ["src/server", "src/index", "src/main", "src/tools", "src/tool"]) {
    for (const ext of [".ts", ".tsx", ".mts", ".js", ".mjs"]) {
      const full = packageRel(pkg.path, `${rel}${ext}`);
      if (existsFile(workspace, full)) out.add(full);
    }
  }
  return [...out].slice(0, 8);
}

function parseTopLevelToolEntries(raw: string): string[] {
  const found = new Set<string>();
  const entryRe = /(?:^|\n)\s*\{\s*(?:\n\s*)?name\s*:\s*["']([A-Za-z0-9:_-]{2,})["']([\s\S]*?)(?=(?:\n\s*\{\s*(?:\n\s*)?name\s*:)|(?:\n\s*\];))/g;
  for (const m of raw.matchAll(entryRe)) {
    const name = m[1];
    const body = m[2] ?? "";
    const header = body.split(/definition\s*:/)[0] ?? body;
    if (/\bdeprecated\s*:\s*true\b/.test(header)) continue;
    if (name && !name.startsWith("-")) found.add(name);
    if (found.size >= 16) break;
  }
  return [...found];
}

function inferMcpTools(workspace: string, packages: PackageInfo[]): string[] {
  const found = new Set<string>();
  for (const pkg of packages) {
    for (const rel of candidateSourceFiles(workspace, pkg)) {
      const raw = readText(workspace, rel);
      if (!raw) continue;
      if (!/(inputSchema|tools\/list|McpServer|ModelContextProtocol|ToolEntry|tools\s*=)/i.test(raw)) continue;
      for (const name of parseTopLevelToolEntries(raw)) {
        found.add(name);
        if (found.size >= 16) break;
      }
      if (found.size > 0) break;
      for (const m of raw.matchAll(/\bname\s*:\s*["']([A-Za-z0-9:_-]{2,})["']/g)) {
        const name = m[1];
        const beforeName = raw.slice(Math.max(0, m.index - 80), m.index);
        if (/definition\s*:\s*\{\s*$/.test(beforeName)) continue;
        const afterName = raw.slice(m.index, Math.min(raw.length, m.index + 220));
        const firstObjectEnd = afterName.indexOf("}");
        const localObject = firstObjectEnd >= 0 ? afterName.slice(0, firstObjectEnd) : afterName;
        if (/\bdeprecated\s*:\s*true\b/.test(localObject)) continue;
        if (name && !name.startsWith("-")) found.add(name);
        if (found.size >= 16) break;
      }
      if (found.size >= 16) break;
    }
    if (found.size >= 16) break;
  }
  return [...found];
}

function mintFileTarget(workspace: string, rel: string, why: string): OverviewReadTarget {
  const h = handleTable.upsert({ kind: "file", path: rel, workspaceRoot: workspace });
  return {
    path: rel,
    handle: h.id,
    why,
    ...lineInfo(workspace, rel),
    target: `read_file mode=digest handle=${h.id}`,
  };
}

function scoreEntrypoint(rel: string, pkg: PackageInfo): number {
  const base = path.posix.basename(rel).toLowerCase();
  const text = `${pkg.path} ${pkg.pkg?.name ?? ""} ${pkg.pkg?.description ?? ""}`.toLowerCase();
  let score = 0;
  if (base.startsWith("index.")) score += 6;
  if (base.startsWith("main.") || base.startsWith("app.")) score += 5;
  if (base.startsWith("server.") || base.startsWith("worker.")) score += 4;
  if (base.startsWith("cli.") || base.startsWith("bin.")) score += 4;
  if (base.startsWith("extension.")) score += 3;
  if (pkg.bins.length > 0 && /(?:cli|bin|index)\./.test(base)) score += 3;
  if (/\b(server|api|mcp|worker)\b/.test(text) && /(?:server|index|main|worker)\./.test(base)) score += 2;
  if (pkg.commands.includes("start") || pkg.commands.includes("dev")) score += 1;
  return score;
}

type OverviewSection = "architecture" | "bench" | "cli" | "entrypoints" | "mcp" | "tools" | "write-safety";

function normalizeOverviewSections(sections: string[] | undefined): Set<OverviewSection> {
  const out = new Set<OverviewSection>();
  for (const raw of sections ?? []) {
    const s = raw.toLowerCase().trim().replace(/[_\s]+/g, "-");
    if (s === "arch" || s === "architecture" || s === "system") out.add("architecture");
    else if (s === "bench" || s === "benchmark" || s === "benchmarks") out.add("bench");
    else if (s === "cli" || s === "command" || s === "commands") out.add("cli");
    else if (s === "entry" || s === "entrypoint" || s === "entrypoints") out.add("entrypoints");
    else if (s === "mcp" || s === "server") out.add("mcp");
    else if (s === "tool" || s === "tools") out.add("tools");
    else if (s === "write" || s === "writes" || s === "write-safety" || s === "safety" || s === "edit-safety") out.add("write-safety");
  }
  return out;
}

const OVERVIEW_SOURCE_EXT = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|py|go|rs|java|kt|kts|c|h|cc|cpp|cxx|hpp|hh|rb|cs|php)$/;
const OVERVIEW_SKIP_DIRS = new Set([
  ".git",
  ".claude",
  ".cache",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "proto",
  "docs",
  "vendor",
  "third_party",
]);

interface SectionCandidate {
  rel: string;
  why: string;
  score: number;
}

function collectSourceFiles(workspace: string, rootRel: string, cap = 120): string[] {
  const rootAbs = path.join(workspace, rootRel === "." ? "" : rootRel);
  const out: string[] = [];

  function walk(absDir: string): void {
    if (out.length >= cap) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true }) as fs.Dirent[];
    } catch {
      return;
    }
    entries.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
    for (const entry of entries) {
      if (out.length >= cap) break;
      const abs = path.join(absDir, entry.name);
      const rel = path.relative(workspace, abs).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        if (OVERVIEW_SKIP_DIRS.has(entry.name)) continue;
        if (isSourceOnlyExcludedPath(`${rel}/`)) continue;
        walk(abs);
      } else if (entry.isFile()) {
        if (!OVERVIEW_SOURCE_EXT.test(entry.name)) continue;
        if (isSourceOnlyExcludedPath(rel)) continue;
        out.push(rel);
      }
    }
  }

  walk(rootAbs);
  return out;
}

function sectionScore(section: OverviewSection, rel: string, pkg?: PackageInfo): number {
  const lower = rel.toLowerCase();
  const pkgText = `${pkg?.path ?? ""} ${pkg?.pkg?.name ?? ""} ${pkg?.pkg?.description ?? ""} ${pkg?.role ?? ""}`.toLowerCase();
  if (section === "bench") {
    if (lower === "bench/workflows/scenarios.workflow.js") return 100;
    if (lower.includes("/commands/bench.") || lower.endsWith("/bench.ts")) return 80;
    if (lower.includes("tokenlighten_bench/bench_")) return 70;
    if (lower.includes("bench") || lower.includes("workflow") || lower.includes("score") || lower.includes("aggregate")) return 45;
  }
  if (section === "write-safety") {
    if (lower.includes("/src/write/")) return 90;
    if (/(safe|secret|precondition|atomic|checkpoint|workspace|pathless|rangeedit|textedit)/.test(lower)) return 75;
    if (/(edit|rename|createfile|searchreplace|applyedits)/.test(lower)) return 60;
    if (lower.endsWith("/src/server.ts") && pkgText.includes("mcp")) return 45;
  }
  if (section === "mcp" || section === "tools") {
    if (pkg && packageLooksMcp(pkg)) return lower.includes("/server.") ? 90 : lower.includes("/tools/") ? 70 : 55;
    if (lower.includes("mcp") || lower.includes("/tools/")) return 45;
  }
  if (section === "cli") {
    if (pkg && packageLooksCli(pkg)) return lower.includes("/commands/") ? 80 : lower.includes("/cli.") || lower.includes("/index.") ? 70 : 45;
    if (lower.includes("/commands/") || lower.includes("/cli.")) return 40;
  }
  if (section === "entrypoints" || section === "architecture") {
    if (pkg?.entrypoints.includes(rel)) return 70;
    if (/(\/src\/(?:index|main|server|app|worker|extension|cli)\.)/.test(lower)) return 55;
  }
  return 0;
}

function sectionCandidates(workspace: string, packages: PackageInfo[], sections: Set<OverviewSection>): SectionCandidate[] {
  if (sections.size === 0) return [];
  const out: SectionCandidate[] = [];
  const add = (rel: string, section: OverviewSection, score: number, why: string) => {
    if (score <= 0 || !existsFile(workspace, rel)) return;
    out.push({ rel, score, why: `${section}: ${why}` });
  };

  if (sections.has("bench")) {
    add("bench/workflows/scenarios.workflow.js", "bench", 100, "workflow runner");
    add("bench/workflows/record_run.mjs", "bench", 75, "billing capture");
    add("bench/workflows/lib/tokenlighten_bench/bench_aggregate.py", "bench", 70, "aggregation");
    add("bench/workflows/lib/tokenlighten_bench/bench_score.py", "bench", 65, "scoring");
  }

  for (const pkg of packages) {
    const roots = [packageRel(pkg.path, "src")];
    for (const root of roots) {
      const files = collectSourceFiles(workspace, root, 80);
      for (const rel of files) {
        for (const section of sections) {
          const score = sectionScore(section, rel, pkg);
          if (score > 0) add(rel, section, score, "focused source surface");
        }
      }
    }
  }

  return out.sort((a, b) => {
    const diff = b.score - a.score;
    if (diff !== 0) return diff;
    return Buffer.compare(Buffer.from(a.rel), Buffer.from(b.rel));
  });
}

function preferredReadingOrder(workspace: string, packages: PackageInfo[], sections?: string[]): OverviewReadTarget[] {
  const out: OverviewReadTarget[] = [];
  const seen = new Set<string>();
  const sectionSet = normalizeOverviewSections(sections);

  for (const candidate of sectionCandidates(workspace, packages, sectionSet)) {
    if (out.length >= 10) break;
    if (seen.has(candidate.rel)) continue;
    out.push(mintFileTarget(workspace, candidate.rel, candidate.why));
    seen.add(candidate.rel);
  }

  const ranked = packages.flatMap((pkg) =>
    pkg.entrypoints.map((rel) => ({
      pkg,
      rel,
      score: scoreEntrypoint(rel, pkg),
    }))
  ).sort((a, b) => {
    const diff = b.score - a.score;
    if (diff !== 0) return diff;
    return Buffer.compare(Buffer.from(a.rel), Buffer.from(b.rel));
  });
  const sourceRanked = ranked.filter((item) => !item.rel.includes("/dist/") && !item.rel.startsWith("dist/") && !item.rel.endsWith(".d.ts"));
  const preferredRanked = sourceRanked.length > 0 ? sourceRanked : ranked;

  for (const item of preferredRanked) {
    if (out.length >= 10) break;
    if (seen.has(item.rel)) continue;
    out.push(mintFileTarget(workspace, item.rel, `${item.pkg.role} entrypoint`));
    seen.add(item.rel);
  }

  for (const pkg of packages) {
    if (out.length >= 10) break;
    const files = candidateSourceFiles(workspace, pkg);
    const sourceFiles = files.filter((rel) => !rel.includes("/dist/") && !rel.startsWith("dist/") && !rel.endsWith(".d.ts"));
    for (const rel of (sourceFiles.length > 0 ? sourceFiles : files)) {
      if (seen.has(rel)) continue;
      out.push(mintFileTarget(workspace, rel, `${pkg.role} source surface`));
      seen.add(rel);
      break;
    }
  }
  return out.slice(0, 10);
}

function dependencyNames(pkg: PackageJson | null): string[] {
  return [
    ...Object.keys(pkg?.dependencies ?? {}),
    ...Object.keys(pkg?.devDependencies ?? {}),
    ...Object.keys(pkg?.peerDependencies ?? {}),
  ];
}

function inferFlows(packages: PackageInfo[]): string[] {
  const flows: string[] = [];
  const byName = new Map(packages.flatMap((pkg) => pkg.pkg?.name ? [[pkg.pkg.name, pkg] as const] : []));

  for (const pkg of packages) {
    const label = pkg.pkg?.name ?? pkg.path;
    if (pkg.bins.length > 0 && pkg.entrypoints[0]) {
      flows.push(`CLI: ${pkg.bins.join(",")} -> ${pkg.entrypoints[0]}`);
    }
    if (packageLooksMcp(pkg) && pkg.entrypoints[0]) {
      flows.push(`MCP: ${label} -> ${pkg.entrypoints[0]}`);
    }
    const runtimeScript = pkg.commands.find((cmd) => cmd === "start" || cmd === "dev" || cmd === "serve");
    if (runtimeScript && pkg.entrypoints[0]) {
      flows.push(`Runtime: ${label} ${runtimeScript} -> ${pkg.entrypoints[0]}`);
    }
    for (const dep of dependencyNames(pkg.pkg)) {
      if (!byName.has(dep)) continue;
      flows.push(`Workspace dependency: ${label} -> ${dep}`);
      break;
    }
    if (flows.length >= 6) break;
  }
  return flows.slice(0, 6);
}

function schemaExports(pkg: PackageJson | null): string[] {
  const ex = pkg?.exports;
  if (!ex) return [];
  if (typeof ex === "string") return [ex];
  if (typeof ex === "object") return Object.keys(ex as Record<string, unknown>).sort().slice(0, 4);
  return [];
}

function inferRole(info: Omit<PackageInfo, "role">): string {
  const text = `${info.path} ${info.pkg?.name ?? ""} ${info.pkg?.description ?? ""}`.toLowerCase();
  const hasRuntime = info.commands.some((cmd) => ["start", "dev", "serve"].includes(cmd));
  const hasBin = info.bins.length > 0;
  const entryText = info.entrypoints.join(" ").toLowerCase();

  if (/\bmcp\b|model\s+context\s+protocol|modelcontextprotocol/.test(text)) return "MCP server package";
  if (/\b(vscode|editor extension|extension)\b/.test(text) || entryText.includes("extension.")) return "editor extension package";
  if (hasBin || /\b(cli|command-line|command line)\b/.test(text) || /(?:cli|bin)\./.test(entryText)) return "CLI package";
  if (/\b(server|api|http|backend)\b/.test(text) || /server\./.test(entryText)) return "server package";
  if (/\b(worker|edge)\b/.test(text) || /worker\./.test(entryText)) return "worker package";
  if (/\b(types|contracts?|schema|shared)\b/.test(text) && !hasRuntime && !hasBin) return "shared contracts package";
  if (hasRuntime) return "application package";
  return info.pkg?.description?.slice(0, 80) || "package";
}

function buildPackageInfo(workspace: string, pkgPath: string): PackageInfo {
  const pkg = readJson(path.join(workspace, pkgPath, "package.json"));
  const commands = Object.keys(pkg?.scripts ?? {}).sort().slice(0, 8);
  const exportsList = schemaExports(pkg);
  const entrypoints = sourceEntrypoints(workspace, pkgPath, pkg);
  const bins = binNames(pkg);
  const base = { path: pkgPath, pkg, entrypoints, commands, bins, exportsList };
  return { ...base, role: inferRole(base) };
}

function trimToCap(result: ReadCodeOverviewOutput, capBytes: number): ReadCodeOverviewOutput {
  let out: ReadCodeOverviewOutput = result;
  const fits = () => Buffer.byteLength(JSON.stringify(out), "utf8") <= capBytes;
  if (fits()) return out;

  out = { ...out, truncated: true, packages: out.packages.slice(0, 8), recommended_reading_order: out.recommended_reading_order.slice(0, 8) };
  if (fits()) return out;

  out = { ...out, cli_commands: out.cli_commands?.slice(0, 10), commands: out.commands?.slice(0, 8), flows: out.flows?.slice(0, 4) };
  if (fits()) return out;

  out = {
    ...out,
    packages: out.packages.map((p) => ({
      path: p.path,
      ...(p.name ? { name: p.name } : {}),
      role: p.role,
      ...(p.entrypoints?.[0] ? { entrypoints: [p.entrypoints[0]] } : {}),
    })),
  };
  if (fits()) return out;

  return {
    mode: "overview",
    repo: out.repo,
    packages: out.packages.map((p) => ({ path: p.path, ...(p.name ? { name: p.name } : {}), role: p.role })).slice(0, 6),
    recommended_reading_order: out.recommended_reading_order.slice(0, 6),
    truncated: true,
  };
}

/**
 * Resolve opts.path (already safety-checked by the caller against workspace
 * escape) to a scope descriptor: the workspace-relative directory to scope
 * package discovery + reading-order candidates to, or undefined when the
 * path is absent, is the workspace root itself, or does not exist as a
 * directory (overview scoping is a directory concept; unscoped falls back
 * to full-workspace behavior rather than erroring).
 */
function resolveOverviewScope(workspace: string, rawPath: string | undefined): string | undefined {
  if (!rawPath) return undefined;
  const clean = workspaceRel(rawPath);
  if (clean === "" || clean === ".") return undefined;
  // Safe realpath check (traversal + symlink escape) before touching the fs,
  // matching the convention used by readFileSafe/readBytesSafe.
  const abs = safeResolve(clean, workspace);
  if (!abs) return undefined;
  const real = resolveReal(abs);
  if (!isWithin(real, resolveReal(workspace))) return undefined;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(real);
  } catch {
    return undefined;
  }
  const dirRel = stat.isDirectory() ? clean : path.posix.dirname(clean);
  return dirRel === "" || dirRel === "." ? undefined : dirRel;
}

export function buildOverview(
  workspace: string,
  opts: { maxTokens?: number; sections?: string[]; path?: string } = {},
): ReadCodeOverviewOutput {
  const requestedScope = resolveOverviewScope(workspace, opts.path);
  let scopeNote: string | undefined;
  if (opts.path && requestedScope === undefined) {
    // resolveOverviewScope returns undefined both for "no path given" and for
    // a path that does not exist / escapes the workspace / is the workspace
    // root itself. opts.path being truthy here means the caller DID ask for
    // a scope and it silently collapsed to the full workspace.
    scopeNote = `requested path "${opts.path}" not found or not scopeable; showing workspace overview instead`;
  }

  // Package discovery: prefer the scope's own package.json "workspaces"
  // declaration (mirrors unscoped behavior). When the scope has no manifest
  // of its own (common for fixture/example subtrees nested in a larger
  // monorepo), fall back to a direct filesystem walk for package.json files.
  let scopeRel = requestedScope;
  let pkgPaths: string[];
  if (requestedScope) {
    const scopeRoot = path.join(workspace, requestedScope);
    const declared = packagePaths(scopeRoot, readJson(path.join(scopeRoot, "package.json"))).map((p) =>
      workspaceRel(requestedScope, p),
    );
    pkgPaths = declared.length > 0 ? declared : discoverPackagesUnder(workspace, requestedScope);
    // Deep-path fallback: the scope points INSIDE a package but below its
    // manifest root (e.g. `.../apps/api/src`), so nothing was found below AND
    // the scope has no package.json of its own. Climb UPWARD to the nearest
    // enclosing package and scope the overview to THAT package.
    if (pkgPaths.length === 0 && !existsFile(workspace, workspaceRel(requestedScope, "package.json"))) {
      const enclosing = findEnclosingPackage(workspace, requestedScope);
      if (enclosing.pkgPath) {
        scopeRel = enclosing.pkgPath === "." ? undefined : enclosing.pkgPath;
        pkgPaths = scopeRel === undefined ? packagePaths(workspace, readJson(path.join(workspace, "package.json"))) : [enclosing.pkgPath];
        // The climb landed on the workspace root only as a last-resort
        // fallback (no package.json anywhere in the requested path's own
        // ancestry) — an ancestor beyond the nearest enclosing package, not
        // the expected "climb to my own package" case. Flag it.
        if (!enclosing.isOwnAncestor) {
          scopeNote = `requested path "${opts.path}" had no package.json in its own ancestry; showing workspace overview instead`;
        }
      }
    }
  } else {
    pkgPaths = packagePaths(workspace, readJson(path.join(workspace, "package.json")));
  }

  const scopeRoot = scopeRel ? path.join(workspace, scopeRel) : workspace;
  const rootPkg = readJson(path.join(scopeRoot, "package.json"));
  const repoHandle = handleTable.upsert({ kind: "repo", workspaceRoot: workspace, ...(scopeRel ? { path: scopeRel } : {}) });

  // No package map at all (deep path with no enclosing package.json up to the
  // workspace root). Return an explicit retry signal instead of a
  // structurally-valid but useless empty object.
  if (pkgPaths.length === 0) {
    return {
      mode: "overview",
      repo: { name: rootPkg?.name ?? path.basename(scopeRoot), handle: repoHandle.id },
      packages: [],
      recommended_reading_order: [],
      truncated: false,
      hint: "no package.json found at or above this path; retry read_file mode=overview with a shallower path (a package or repo root)",
      next: "read_file mode=overview",
    };
  }

  const infos = pkgPaths.map((pkgPath) => buildPackageInfo(workspace, pkgPath));

  const packages: OverviewPackage[] = infos.map((info) => {
    return {
      path: info.path,
      ...(info.pkg?.name ? { name: info.pkg.name } : {}),
      role: info.exportsList.length > 0 ? `${info.role}; exports ${info.exportsList.join(",")}` : info.role,
      ...(info.entrypoints.length > 0 ? { entrypoints: info.entrypoints } : {}),
      ...(info.commands.length > 0 ? { commands: info.commands } : {}),
      ...(info.bins.length > 0 ? { bins: info.bins } : {}),
    };
  });

  const commands = Object.keys(rootPkg?.scripts ?? {}).sort().slice(0, 10);
  // Bench-specific reading-order injections (Part of sectionCandidates) only
  // make sense for the TokenLighten repo itself, not for an arbitrary scoped
  // subtree (a fixture has no bench/workflows/ of its own).
  const sections = scopeRel ? (opts.sections ?? []).filter((s) => s.toLowerCase() !== "bench") : opts.sections;
  const result: ReadCodeOverviewOutput = {
    mode: "overview",
    repo: { name: rootPkg?.name ?? path.basename(scopeRoot), handle: repoHandle.id },
    packages,
    tools: inferMcpTools(workspace, infos),
    commands,
    cli_commands: inferCliCommands(workspace, infos),
    flows: inferFlows(infos),
    recommended_reading_order: preferredReadingOrder(workspace, infos, sections),
    truncated: false,
    ...(scopeNote ? { scope_note: scopeNote } : {}),
  };

  const requestedCap = opts.maxTokens ? Math.max(1024, Math.min(MAX_OVERVIEW_BYTES, Math.floor(opts.maxTokens * 4))) : MAX_OVERVIEW_BYTES;
  return trimToCap(result, requestedCap);
}
