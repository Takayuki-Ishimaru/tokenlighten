// Plain data only — no meta envelope, no 'tokenlighten:meta' wrappers.
// Reason: docs/00-postmortem.md §2.2

/**
 * buildSkeleton application service.
 *
 * buildSkeleton(root, config) → RepoSkeleton
 *
 * Full spec: docs/components/03-ci-skeleton.md
 */

import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { RepoSkeleton, RankedFile, ApiEndpoint, ModuleNode, TLConfig } from "@tokenlighten/types";

import { createIgnoreMatcher } from "../ignore.js";
import { enumerateFiles, buildFileInputs, languageForPath } from "../graph.js";
import { extractApiHandlers } from "../apiGraph.js";
import { loadOrBuildSourceIndex } from "../indexStore.js";
import { hashIgnorePatterns } from "../merkle.js";
import {
  buildSymbolGraph,
  runPersonalizedPageRank,
  aggregateToFileScores,
  fileUnitFallback,
  normalizeScores,
} from "../pagerank.js";
import { renderSkeleton, renderFileSignatures } from "../render.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface BuildSkeletonOptions {
  /**
   * Workspace root path. Defaults to process.cwd().
   */
  root?: string;
  /**
   * Configuration overrides.
   */
  config?: TLConfig;
  /**
   * Explicit git commit SHA (e.g. from CI env). When omitted, resolved via git.
   */
  commit?: string;
  /**
   * How many recently-edited files to use for personalization (default: 50).
   */
  recencyDepth?: number;
  /**
   * Skip graph-cache read/write (default: false).
   */
  noCache?: boolean;
  /**
   * Number of top-ranked files to include (default: 40).
   */
  topN?: number;
  /**
   * Extra ignore patterns beyond defaults.
   */
  extraIgnorePatterns?: string[];
}

export interface BuildSkeletonResult {
  skeleton: RepoSkeleton;
  /** Markdown output, already size-capped at 64KB. */
  markdown: string;
  /** Warnings encountered during build. */
  warnings: string[];
}

/**
 * Build a RepoSkeleton from a repository root.
 *
 * Orchestrates: file enumeration → symbol extraction → graph build →
 * PageRank → endpoint extraction → section assembly → size-cap render.
 *
 * Falls back to fileUnitFallback when file count > 5000 (cold-start guard).
 */
export async function buildSkeleton(
  root = process.cwd(),
  opts: BuildSkeletonOptions = {},
): Promise<BuildSkeletonResult> {
  const absRoot = resolve(root);
  const warnings: string[] = [];

  const topN = opts.topN ?? opts.config?.skeleton?.maxRanked ?? 40;
  const maxBytes = opts.config?.skeleton?.sizeCapBytes ?? 65536;
  const recencyDepth = opts.recencyDepth ?? 50;

  // 1) Commit SHA.
  const commit = opts.commit ?? (await resolveCommit(absRoot));

  // 2) File enumeration.
  //    Text-bearing files (.md/.txt/... — EnumeratedFile.textOnly) are
  //    excluded here so the repo skeleton (PageRank/topRanked/moduleMap/
  //    apiEndpoints) is byte-identical whether or not docs are present —
  //    see graph.ts's TEXT_EXTS doc comment. They are still indexed (with
  //    chunks, no symbols) via indexStore.ts's own enumerateFiles call
  //    below, which is intentionally unfiltered.
  const matcher = await createIgnoreMatcher(absRoot, opts.extraIgnorePatterns);
  const files = (await enumerateFiles(absRoot, matcher)).filter((f) => !f.textOnly);

  if (files.length === 0) {
    const skeleton = emptySkeleton(commit, "no-files-found");
    return { skeleton, markdown: renderSkeleton(skeleton), warnings };
  }

  // 2b) Build/load source index (side-effect: populates .tokenlighten/cache/).
  //     Propagate any index warnings but do not fail the build on index errors.
  if (!opts.noCache && files.length > 0) {
    try {
      const ignoreHash = hashIgnorePatterns([...(opts.extraIgnorePatterns ?? [])]);
      const indexResult = await loadOrBuildSourceIndex(absRoot, {
        noCache: false,
        commit,
        ignoreHash,
      });
      for (const w of indexResult.warnings) warnings.push(w);
    } catch (e) {
      warnings.push(`skeleton: source index build failed: ${String(e)}`);
    }
  }

  // 3) Recently-edited files for personalization (git log).
  const recentSet = await gitRecentFiles(absRoot, recencyDepth);

  // 4) Cold-start guard: > 5000 files → skip PageRank.
  const COLD_START_THRESHOLD = 5000;
  let fileScores: Map<string, number>;

  if (files.length > COLD_START_THRESHOLD) {
    warnings.push(`skeleton: file count (${files.length}) exceeds ${COLD_START_THRESHOLD}; using file-unit fallback (PageRank skipped)`);
    fileScores = fileUnitFallback(
      files.map((f) => ({ path: f.path, recentlyEdited: recentSet.has(f.path) })),
    );
  } else {
    // 5a) Build symbol inputs.
    const { inputs, parseFailures } = await buildFileInputs(files);

    for (const [lang, count] of parseFailures) {
      if (count > 0) {
        warnings.push(`skeleton: ${count} file(s) failed regex extraction for lang=${lang}`);
      }
    }

    // 5b) Build symbol graph.
    const graph = buildSymbolGraph(inputs, null);

    if (graph.edges.size === 0) {
      warnings.push("skeleton: no inter-file edges; rank will degenerate to uniform");
    }

    // 5c) Personalization: recently-edited nodes get weight 2, others 1.
    const personalization = new Map<string, number>(
      Array.from(graph.nodes.keys()).map((id) => {
        const path = id.split(":")[0]!;
        return [id, recentSet.has(path) ? 2 : 1];
      }),
    );

    // 5d) PageRank (20 iters, damping 0.85).
    const nodeScores = runPersonalizedPageRank(graph, personalization);

    // 5e) Aggregate symbol scores → file scores.
    fileScores = aggregateToFileScores(nodeScores);

    // Files with no symbols (parse failed etc.) default to 1.
    for (const f of files) {
      if (!fileScores.has(f.path)) fileScores.set(f.path, 1);
    }
  }

  // 6) Normalize scores + select top-N files.
  // Tiebreak by path bytes (Buffer.compare) for byte-determinism across runs.
  const normalizedScores = normalizeScores(fileScores);
  const sorted = files
    .map((f) => ({ path: f.path, score: normalizedScores.get(f.path) ?? 0 }))
    .sort((a, b) => {
      const scoreDiff = b.score - a.score;
      if (scoreDiff !== 0) return scoreDiff;
      return Buffer.compare(Buffer.from(a.path), Buffer.from(b.path));
    });

  const topFiles = sorted.slice(0, topN);
  const excludedFiles = sorted.slice(topN);

  // 7) Degenerate check: top-N dominated by test files.
  const testDominant = topFiles.filter((f) => isTestPath(f.path));
  if (testDominant.length > topFiles.length * 0.5 && topFiles.length > 0) {
    warnings.push("skeleton: top-ranked dominated by test files; check ignore patterns");
  }

  // 8) Extract signatures for top-ranked files.
  const { inputs: allInputs } = await buildFileInputs(
    files.filter((f) => topFiles.some((t) => t.path === f.path)),
  );
  const sigMap = new Map<string, string>(
    allInputs.map((inp) => [inp.path, renderFileSignatures(inp.path, inp.symbols.map((s) => ({ name: s.name, signature: s.signature, line: s.line })))]),
  );

  // 9) API endpoint extraction.
  const apiEndpoints: ApiEndpoint[] = [];
  for (const inp of allInputs) {
    const lang = languageForPath(inp.path);
    const handlers = extractApiHandlers(inp.raw, lang, inp.path);
    for (const h of handlers) {
      apiEndpoints.push({
        method: h.method,
        path: h.path,
        handlerFile: inp.path,
        handlerSymbol: h.handler,
      });
    }
  }

  // 10) Build module map from all files.
  const moduleMap = buildModuleMap(files.map((f) => f.path));

  // 11) Assemble RankedFile[].
  const topRanked: RankedFile[] = topFiles.map((f) => ({
    path: f.path,
    rank: f.score,
    reasons: recentSet.has(f.path) ? ["recently edited"] : [],
  }));

  // 12) Excluded patterns.
  const excluded = excludedFiles.length > 0 ? [`** (${excludedFiles.length} files below rank threshold)`] : [];

  // 13) Build RepoSkeleton.
  const skeleton: RepoSkeleton = {
    version: 1,
    commit,
    topRanked,
    apiEndpoints,
    moduleMap,
    excluded,
  };

  // 14) Render markdown with size cap.
  const markdown = renderSkeleton(skeleton, { maxTotalBytes: maxBytes, fileSignatures: sigMap });

  return { skeleton, markdown, warnings };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function resolveCommit(root: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"], { timeout: 5000 });
    return stdout.trim().slice(0, 40);
  } catch {
    return "unknown";
  }
}

/**
 * Get the set of recently-edited file paths from git log.
 * Falls back to empty set on error (e.g. shallow clone, non-git repo).
 */
async function gitRecentFiles(root: string, n: number): Promise<Set<string>> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", root, "log", `--max-count=${n}`, "--name-only", "--pretty=format:"],
      { timeout: 10000 },
    );
    const paths = stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    return new Set(paths);
  } catch {
    return new Set();
  }
}

function emptySkeleton(commit: string, reason: string): RepoSkeleton {
  return {
    version: 1,
    commit,
    topRanked: [],
    apiEndpoints: [],
    moduleMap: [],
    excluded: [`(skeleton empty: ${reason})`],
  };
}

function isTestPath(p: string): boolean {
  return /(?:^|\/)(?:test|tests|__tests__|spec|__spec__|\.test\.|\.spec\.)/.test(p);
}

/**
 * Build a flat list of ModuleNodes from a set of POSIX paths.
 * Each directory becomes a node with its immediate children listed.
 */
function buildModuleMap(paths: string[]): ModuleNode[] {
  const dirChildren = new Map<string, Set<string>>();

  for (const p of paths) {
    const parts = p.split("/");
    for (let i = 0; i < parts.length; i++) {
      const dirPath = parts.slice(0, i).join("/");
      const child = parts.slice(0, i + 1).join("/");
      if (!dirChildren.has(dirPath)) dirChildren.set(dirPath, new Set());
      dirChildren.get(dirPath)!.add(child);
    }
    // Leaf file has no children.
    if (!dirChildren.has(p)) dirChildren.set(p, new Set());
  }

  const nodes: ModuleNode[] = [];
  for (const [path, children] of dirChildren) {
    if (path === "") continue; // skip virtual root
    nodes.push({ path, children: Array.from(children) });
  }
  // Use Buffer.compare for locale-insensitive, byte-deterministic sort.
  return nodes.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
}
