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
 * - PI-06 beta.2 (DESIGN-v0.10-expansion-plan-reconciliation.md §2 PI-06,
 *   §5 D-5): skeleton-engine's index is built entirely from
 *   `extractSymbolsRegex` (graph.ts), regardless of whether a real
 *   tree-sitter grammar exists for the file's language — so every location
 *   `searchIndexSymbols` returns is, structurally, a regex CANDIDATE.
 *   `applyParserProvenance` below cross-checks each candidate, per unique
 *   file, against `symbols/collectSymbols.ts`'s tree-sitter declaration
 *   walk where a grammar exists: a candidate matching a real declaration is
 *   PROMOTED (kind/line corrected to the parser's own, `source` stays
 *   absent); a candidate with no matching declaration is a confirmed
 *   non-declaration and is DROPPED (declaration purity); a file whose
 *   language has no collector, or whose grammar fails to load at runtime,
 *   keeps its regex-derived candidates as-is, LABELED `source:"fallback"`
 *   (never a hard error — see collectSymbols.ts's `parserAvailable`). The
 *   response-level `symbol_coverage` summarizes the served page's
 *   provenance split, emitted only when at least one served location is a
 *   fallback candidate (the common, fully-covered-language case stays at
 *   zero extra bytes — "absence is meaning", matching `term_results`'s own
 *   present-only-when-informative convention in findText.ts).
 */

import * as fs from "node:fs";
import * as path from "node:path";
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
import {
  collectSymbolsChecked,
  symbolCollectorSupports,
  type CollectedSymbol,
  type CollectedSymbolKind,
} from "../symbols/collectSymbols.js";
import type { TreeSitterPaths } from "../skeleton/types.js";
import { languageForPath, languageForPathWithContent } from "../util/languages.js";

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
  /**
   * PI-06 beta.2 — present ONLY when this location is a regex-extracted
   * candidate that could not be (or was not) VERIFIED against a real
   * tree-sitter declaration: the file's language has no collector at all,
   * the collector's grammar failed to load/parse at runtime, or the
   * collector parsed the file cleanly but found no declaration matching
   * this exact name (`SymbolCoverageReason`'s `"no_declaration_match"` —
   * NOT proof this is a false positive; see `applyParserProvenance`'s doc
   * comment for why a non-match must label rather than drop). Absence means
   * the stronger claim — this `kind`/`line` were verified against
   * `symbols/collectSymbols.ts`'s AST walk, not merely regex-matched.
   */
  source?: "fallback";
}

/** Why a served location is labeled `source:"fallback"` — see `applyParserProvenance`. */
export type SymbolCoverageReason =
  | "unsupported_language"
  | "parser_unavailable"
  | "no_declaration_match"
  | "mixed";

/**
 * PI-06 beta.2 (D-5) — additive, optional, present only when at least one
 * served `locations[]` entry is a fallback candidate (see `SymbolLocation.
 * source`'s doc comment for what that means). Mirrors this codebase's own
 * `scope_report.counts` precedent (exploreTree.ts): explicit, independently
 * verifiable counts rather than bytes saved by leaving one derivable —
 * `parser_proven + fallback` always equals the served `locations.length`.
 */
export interface SymbolCoverage {
  /** Served locations verified against a real tree-sitter declaration. */
  parser_proven: number;
  /** Served locations sourced from regex extraction, unverified. */
  fallback: number;
  /**
   * "unsupported_language": every fallback location's file has no
   * tree-sitter collector for its language at all. "parser_unavailable":
   * every fallback location's file DOES have a collector-eligible
   * language, but the grammar failed to load/parse at runtime (or the file
   * could not be re-read). "no_declaration_match": the collector parsed
   * every fallback location's file cleanly, but found no declaration of
   * that exact name — a genuine non-declaration (a leaked comment/string
   * mention), OR a construct `collectSymbols.ts`'s own node-type coverage
   * does not reach (e.g. a body-less C/C++ header prototype — `declaration`
   * is not in any of its FUNCTION_TYPES/CLASS_TYPES/... sets), which is why
   * this case is LABELED, never silently dropped. "mixed": more than one
   * reason contributed.
   */
  fallback_reason: SymbolCoverageReason;
}

export interface SearchSymbolsResult {
  locations: SymbolLocation[];
  truncated: boolean;
  total: number;
  /** PI-06 beta.2 — see `SymbolCoverage`'s doc comment for the emission gate. */
  symbol_coverage?: SymbolCoverage;
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
// PI-06 beta.2 — parser provenance (declaration purity + symbol_coverage)
// ---------------------------------------------------------------------------

/**
 * Maps collectSymbols.ts's richer kind vocabulary onto the wire's
 * `SymbolKind` — the SAME fold the regex path's own kind derivation
 * (skeleton-engine indexStore.ts's `symbolKindFromSignature`: class/
 * interface/struct/enum/trait -> "class", const/let/var -> "const") already
 * applies, so promotion never changes the advertised kind vocabulary or
 * requires a wire/schema change.
 */
function mapCollectedKind(kind: CollectedSymbolKind): SymbolKind {
  switch (kind) {
    case "function":
      return "function";
    case "method":
      return "method";
    case "class":
    case "interface":
    case "enum":
      return "class";
    case "type":
      return "type";
    case "const":
    case "let":
    case "var":
      return "const";
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

/**
 * Internal-only extension of `SymbolLocation` carrying WHY a fallback-labeled
 * candidate wasn't verified, through byte-cap trimming and role annotation
 * (both of which build their output via `{...item, ...}` spreads, so this
 * extra enumerable property survives unmodified) so `computeSymbolCoverage`
 * can read it back at the very end regardless of how many items were
 * trimmed. NEVER part of the wire shape: `stripCoverageReason` removes it
 * before a `SearchSymbolsResult` is returned; `SymbolCoverage.fallback_reason`
 * is its only public face.
 */
interface SymbolLocationInternal extends SymbolLocation {
  __coverageReason?: SymbolCoverageReason;
}

function stripCoverageReason(loc: SymbolLocationInternal): SymbolLocation {
  const { __coverageReason, ...rest } = loc;
  return rest;
}

/**
 * Cross-check each of `locations`' regex candidates — one file read+parse
 * per UNIQUE path, never proportional to workspace size — against a real
 * tree-sitter declaration walk where the file's language has a collector
 * (`symbolCollectorSupports`). Two outcomes per candidate:
 *
 *  - a declaration of the SAME NAME exists in the parsed file (nearest by
 *    line when several share a name, e.g. overloads — each real declaration
 *    claims at most one candidate): PROMOTED — `kind`/`line` corrected to
 *    the parser's own, `source` left absent.
 *  - everything else — the file's language has no collector, its grammar
 *    failed to load, the file could not be re-read (deleted/permission
 *    error since the index was built), OR the collector parsed the file
 *    cleanly but found no declaration of that name — is LABELED
 *    `source:"fallback"`, never dropped.
 *
 * WHY A NON-MATCH LABELS RATHER THAN DROPS (the load-bearing decision this
 * function makes): "the collector found no declaration of this name" is NOT
 * proof the regex candidate is a non-declaration. Verified directly against
 * a real fixture (buildTaskPack's 2026-07-10a pure-dir honesty suite,
 * proj/firmware/include/control/widget.hpp): a body-less C/C++ header
 * prototype (`float widgetClamp(float saturation);`) parses to tree-sitter's
 * generic `declaration` node type, which is in NONE of collectSymbols.ts's
 * FUNCTION_TYPES/CLASS_TYPES/METHOD_TYPES/... sets — so a completely
 * legitimate declaration parses to ZERO collected symbols, indistinguishable
 * from a genuine non-match, for every language whose collector has this same
 * class of gap. An earlier revision of this function DROPPED a non-match as
 * a "confirmed false positive" and silently deleted that exact real
 * declaration from `search_files action=symbols` results — caught by
 * `readCodeTaskPack.spec.ts`'s "stays complete when at least one
 * implementation-body surface is embedded" (the header's dropped
 * `widgetClamp` was the anchor `locateTaskContext.ts` used to discover the
 * matching `.cpp` implementation; losing it lost the whole file). Labeling
 * — never removing — keeps every real result reachable while still making
 * the honesty claim symbol_coverage exists for: an unverified candidate is
 * flagged, not silently promoted to "parser-proven".
 *
 * Response-assembly-scoped by construction: operates on the ALREADY-RANKED,
 * already-`limit`-capped candidate page `searchIndexSymbols` returned, and
 * never touches the persisted skeleton-engine index. `total` is therefore
 * never adjusted here — matching this family's own "the inventory never
 * lies" rule (searchMatches.ts): nothing below ever ran, in the sense that
 * every regex candidate the index handed back is still served.
 */
async function applyParserProvenance(
  workspace: string,
  locations: readonly SymbolLocation[],
  treeSitterPaths: TreeSitterPaths,
): Promise<SymbolLocationInternal[]> {
  if (locations.length === 0) return [];

  const indicesByPath = new Map<string, number[]>();
  locations.forEach((loc, i) => {
    const existing = indicesByPath.get(loc.path);
    if (existing) existing.push(i);
    else indicesByPath.set(loc.path, [i]);
  });

  const out: SymbolLocationInternal[] = [...locations];

  const markFallback = (indices: readonly number[], reason: SymbolCoverageReason): void => {
    for (const i of indices) out[i] = { ...locations[i]!, source: "fallback", __coverageReason: reason };
  };

  for (const [relPath, indices] of indicesByPath) {
    const extLang = languageForPath(relPath);
    if (extLang === undefined || !symbolCollectorSupports(extLang)) {
      markFallback(indices, "unsupported_language");
      continue;
    }

    let text: string;
    try {
      text = fs.readFileSync(path.join(workspace, relPath), "utf8");
    } catch {
      markFallback(indices, "parser_unavailable");
      continue;
    }

    const language = languageForPathWithContent(relPath, text) ?? extLang;
    let attempt: { symbols: CollectedSymbol[]; parserAvailable: boolean };
    try {
      attempt = await collectSymbolsChecked(text, language, treeSitterPaths);
    } catch {
      attempt = { symbols: [], parserAvailable: false };
    }

    if (!attempt.parserAvailable) {
      markFallback(indices, "parser_unavailable");
      continue;
    }

    // Real parse succeeded — every candidate for this file is now checked
    // against actual declarations. Group by name; each real declaration
    // claims at most one candidate (nearest by line), so overloaded/
    // repeated names disambiguate rather than all matching the first entry.
    const byName = new Map<string, number[]>();
    attempt.symbols.forEach((sym, si) => {
      const existing = byName.get(sym.name);
      if (existing) existing.push(si);
      else byName.set(sym.name, [si]);
    });

    for (const i of indices) {
      const loc = locations[i]!;
      const candidates = byName.get(loc.symbol);
      if (candidates === undefined || candidates.length === 0) {
        out[i] = { ...loc, source: "fallback", __coverageReason: "no_declaration_match" };
        continue;
      }
      let bestPos = 0;
      let bestDist = Number.POSITIVE_INFINITY;
      for (let p = 0; p < candidates.length; p++) {
        const sym = attempt.symbols[candidates[p]!]!;
        const dist = Math.abs(sym.signatureStartLine - loc.line);
        if (dist < bestDist) {
          bestDist = dist;
          bestPos = p;
        }
      }
      const claimed = attempt.symbols[candidates[bestPos]!]!;
      candidates.splice(bestPos, 1);
      out[i] = { ...loc, line: claimed.signatureStartLine, kind: mapCollectedKind(claimed.kind) };
    }
  }

  return out;
}

/**
 * Final `symbol_coverage` for whatever `finalLocations` actually ships —
 * computed AFTER byte-cap trimming and role annotation so the counts always
 * match the served page, never a pre-trim intermediate (reading
 * `__coverageReason` back off each survivor, since both trims spread-copy
 * items rather than replacing them — see `SymbolLocationInternal`'s doc
 * comment). Absent when every served location is parser-proven (see
 * `SymbolCoverage`'s doc comment for why absence — not a `{fallback:0}`
 * shape — carries that meaning).
 */
function computeSymbolCoverage(finalLocations: readonly SymbolLocationInternal[]): SymbolCoverage | undefined {
  let fallback = 0;
  const reasons = new Set<SymbolCoverageReason>();
  for (const loc of finalLocations) {
    if (loc.source !== "fallback") continue;
    fallback++;
    if (loc.__coverageReason !== undefined) reasons.add(loc.__coverageReason);
  }
  if (fallback === 0) return undefined;
  const fallback_reason: SymbolCoverageReason = reasons.size > 1 ? "mixed" : [...reasons][0]! ?? "parser_unavailable";
  return {
    parser_proven: finalLocations.length - fallback,
    fallback,
    fallback_reason,
  };
}

// ---------------------------------------------------------------------------
// Main implementation
// ---------------------------------------------------------------------------

/**
 * Search for symbols by name across the workspace.
 *
 * @param input      - Tool input (query + optional filters).
 * @param workspace  - Absolute workspace root.
 * @param treeSitterPaths - Optional grammar/runtime WASM location override
 *   for the PI-06 beta.2 parser-provenance pass (`applyParserProvenance`).
 *   Never threaded from server.ts today (production always uses
 *   collectSymbols.ts's own default resolution, like every other
 *   collectSymbols call site) — present so tests can force a deterministic
 *   grammar-load failure (an unresolvable `grammarDir`) without corrupting
 *   the real installed WASM files, proving the labeled-fallback path stays
 *   honest and never hard-errors.
 */
export async function searchSymbols(
  input: SearchSymbolsInput,
  workspace: string,
  treeSitterPaths: TreeSitterPaths = {},
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

  // 5b) PI-06 beta.2 — declaration purity: promote regex candidates that
  //     match a real tree-sitter declaration; label the rest
  //     `source:"fallback"` (never dropped — see `applyParserProvenance`'s
  //     doc comment). `total` is untouched — every regex candidate the
  //     index handed back is still served, exactly as before this pass.
  const provenanceLocations = await applyParserProvenance(workspace, locations, treeSitterPaths);

  // 6) Enforce byte cap: drop lowest-scoring results until JSON fits.
  //    Keep at least MIN_LOCATIONS locations.
  let finalTruncated = ranked.truncated;
  let finalLocations = provenanceLocations;

  // Check if the result serializes within cap.
  function serialize(locs: SymbolLocationInternal[]): string {
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

  // 8) symbol_coverage — computed from the FINAL served page (post byte-cap/
  //    role trimming), so the counts always match what actually shipped —
  //    THEN strip the internal-only `__coverageReason` before it can reach
  //    the wire (SymbolLocationInternal -> SymbolLocation).
  const symbolCoverage = computeSymbolCoverage(roledLocations);

  return {
    locations: roledLocations.map(stripCoverageReason),
    truncated: finalTruncated,
    total: ranked.total,
    ...(symbolCoverage !== undefined ? { symbol_coverage: symbolCoverage } : {}),
  };
}
