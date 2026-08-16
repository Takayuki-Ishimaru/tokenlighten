/**
 * search_symbols tool implementation for @tokenlighten/mcp-server v0.4.
 *
 * Thin wrapper around @tokenlighten/skeleton-engine's searchIndexSymbols.
 * All symbol extraction, ranking, and filtering logic lives in skeleton-engine.
 *
 * Design notes:
 * - Body intentionally not returned; use read_code mode=symbol for that.
 * - signature is omitted by default to keep response tokens low.
 * - score/reasons are omitted unless includeScores=true.
 * - Default limit 20, hard cap 50.
 * - P1.2: full JSON response capped at MAX_RESPONSE_BYTES (2048).
 * - role is omitted unless cheaply derivable; annotates at most the top 5
 *   (post-dedup) locations, counted against MAX_RESPONSE_BYTES — shares
 *   derivation with explore action=find via findText.ts's
 *   deriveFileRole/applyRoles. See findText.ts's "Role annotations" section
 *   doc comment for the full rationale.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  loadOrBuildSourceIndex,
  searchIndexSymbols,
} from "@tokenlighten/skeleton-engine";
import type { SearchContext } from "@tokenlighten/skeleton-engine";
import type { McpLang } from "@tokenlighten/types";
import { isSourceOnlyExcludedPath } from "./walkRepo.js";
import { applyRoles, deriveFileRole } from "../features/search/find/findText.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Constants — exported so budget tests (P3.3) can import them.
// ---------------------------------------------------------------------------

/** Hard byte cap for the full JSON response (locations array + truncated/total). */
export const MAX_RESPONSE_BYTES = 2048;

/** Minimum number of locations to keep even when trimming for cap. */
const MIN_LOCATIONS = 3;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SearchSymbolsInput {
  query: string;
  lang?: McpLang;
  path?: string;
  limit?: number;
  includeScores?: boolean;
}

export type SymbolKind = "function" | "class" | "method" | "const" | "type";

export interface SymbolLocation {
  path: string;
  line: number;
  symbol: string;
  kind: SymbolKind;
  score?: number;
  reasons?: string[];
  /**
   * One-line "primary symbol + purpose" for this file (see findText.ts's
   * "Role annotations" section for full rationale). Shares derivation with
   * explore action=find via findText.ts's deriveFileRole/applyRoles — same
   * top-5-files cap, same cheap bounded-read derivation, same
   * roles-drop-before-hits-drop cap policy (here against MAX_RESPONSE_BYTES
   * = 2048, this tool's own cap).
   */
  role?: string;
}

export interface SearchSymbolsResult {
  locations: SymbolLocation[];
  truncated: boolean;
  total: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a fileScores map from manifest symbol counts (Phase C proxy for PageRank).
 * Normalizes to [0, 1] where the file with the most symbols scores 1.0.
 */
function buildFileScoresFromManifest(
  files: import("@tokenlighten/skeleton-engine").SourceIndexManifestV1["files"],
): Map<string, number> {
  const counts = new Map<string, number>();
  let max = 0;
  for (const [path, entry] of Object.entries(files)) {
    const count = entry.symbols.length;
    counts.set(path, count);
    if (count > max) max = count;
  }
  if (max === 0) return counts; // all zeros
  const normalized = new Map<string, number>();
  for (const [path, count] of counts) {
    normalized.set(path, count / max);
  }
  return normalized;
}

/**
 * Collect recently-touched files via git log.
 * Returns empty set on any error (non-git repos, permission issues, etc.).
 */
// One git spawn per symbol search adds up — a single locate issues several
// searches back-to-back. Recency only changes on commit, so a short-lived
// per-workspace memo is safe; callers treat the returned set as read-only.
const RECENT_FILES_TTL_MS = 5_000;
const recentFilesMemo = new Map<string, { at: number; files: Set<string> }>();

async function getRecentFiles(workspace: string): Promise<Set<string>> {
  const memo = recentFilesMemo.get(workspace);
  const now = Date.now();
  if (memo !== undefined && now - memo.at < RECENT_FILES_TTL_MS) return memo.files;
  let files: Set<string>;
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", workspace, "log", "--max-count=50", "--name-only", "--pretty=format:"],
      { timeout: 5000 },
    );
    const paths = stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    files = new Set(paths);
  } catch {
    files = new Set();
  }
  if (recentFilesMemo.size >= 8 && !recentFilesMemo.has(workspace)) {
    const oldest = recentFilesMemo.keys().next().value;
    if (oldest !== undefined) recentFilesMemo.delete(oldest);
  }
  recentFilesMemo.set(workspace, { at: now, files });
  return files;
}

// ---------------------------------------------------------------------------
// Main implementation
// ---------------------------------------------------------------------------

/**
 * Search for symbols by name across the workspace.
 *
 * @param input      - Tool input (query + optional filters).
 * @param workspace  - Absolute workspace root.
 */
export async function searchSymbols(
  input: SearchSymbolsInput,
  workspace: string,
): Promise<SearchSymbolsResult> {
  // 1) Load or build the source index.
  const { manifest } = await loadOrBuildSourceIndex(workspace, {
    ignoreHash: "",
  });

  // 2) Build fileScores from manifest symbol counts (Phase C proxy).
  const fileScores = buildFileScoresFromManifest(manifest.files);

  // 3) Collect recent files.
  const recentFiles = await getRecentFiles(workspace);

  // 4) Build search context and call ranker.
  const ctx: SearchContext = { manifest, fileScores, recentFiles };
  const limit = Math.min(input.limit ?? 20, 50);

  const ranked = searchIndexSymbols(ctx, {
    query: input.query,
    lang: input.lang,
    path: input.path,
    limit,
    includeScores: input.includeScores,
  });

  // 5) Map to SymbolLocation (strip signature by default, keep score/reasons
  //    only if includeScores=true).
  const sourceLocations = ranked.locations.filter((r) => !isSourceOnlyExcludedPath(r.path, input.path));
  const locations: SymbolLocation[] = sourceLocations.map((r) => {
    const loc: SymbolLocation = {
      path: r.path,
      line: r.line,
      symbol: r.symbol,
      kind: r.kind as SymbolKind,
    };
    if (input.includeScores === true) {
      loc.score = r.score;
      loc.reasons = r.reasons;
    }
    return loc;
  });

  // 6) Enforce byte cap: drop lowest-scoring results until JSON fits.
  //    Keep at least MIN_LOCATIONS locations.
  let finalTruncated = ranked.truncated;
  let finalLocations = locations;

  // Check if the result serializes within cap.
  function serialize(locs: SymbolLocation[]): string {
    return JSON.stringify({ locations: locs, truncated: finalTruncated, total: ranked.total });
  }

  if (Buffer.byteLength(serialize(finalLocations), "utf8") > MAX_RESPONSE_BYTES) {
    // Drop from the end (lowest-scored) until we fit.
    while (
      finalLocations.length > MIN_LOCATIONS &&
      Buffer.byteLength(serialize(finalLocations), "utf8") > MAX_RESPONSE_BYTES
    ) {
      finalLocations = finalLocations.slice(0, -1);
      finalTruncated = true;
    }
    finalTruncated = true;
  }

  // 7) Role annotations — shares findText.ts's cap-aware annotator: at most
  //    the top 5 (already highest-scored, since finalLocations is score-
  //    sorted) locations get a `role`, counted against MAX_RESPONSE_BYTES;
  //    roles are shed before any location would be.
  const roledLocations = applyRoles(
    finalLocations,
    (p) => deriveFileRole(workspace, p),
    (locs) => ({ locations: locs, truncated: finalTruncated, total: ranked.total }),
    MAX_RESPONSE_BYTES,
  );

  return {
    locations: roledLocations,
    truncated: finalTruncated,
    total: ranked.total,
  };
}
