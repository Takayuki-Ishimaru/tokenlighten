// Plain data only — no meta envelope, no 'tokenlighten:meta' wrappers.
// Reason: docs/00-postmortem.md §2.2

/**
 * Stateless ranker module for symbol search over a SourceIndexManifestV1.
 */

import type { SymbolKind } from "./chunker.js";
import type { SourceIndexManifestV1 } from "./indexStore.js";
import { MCP_LANG_EXTS } from "@tokenlighten/types";
import type { McpLang } from "@tokenlighten/types";

export type { SymbolKind };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SearchInput {
  query: string;
  lang?: McpLang;
  /**
   * Fix A (2026-07-12c empty-symbol-query forensics): a HARD scope when present —
   * only symbols whose file IS this path, or sits under it (a directory
   * subtree), are eligible; the fixture/generated-path penalty is exempted
   * within it. An empty/omitted query combined with `path` lists that
   * scope's own symbols instead of ranking by name-match (see
   * searchSymbols' hasQuery/hasPathScope gate below).
   */
  path?: string;
  limit?: number;
  includeScores?: boolean;
}

export interface RankedLocation {
  path: string;
  line: number;
  symbol: string;
  kind: SymbolKind;
  signature?: string;
  score?: number;
  reasons?: string[];
}

export interface SearchContext {
  manifest: SourceIndexManifestV1;
  fileScores: Map<string, number>;
  recentFiles: Set<string>;
}

// ---------------------------------------------------------------------------
// Lang extension map
// ---------------------------------------------------------------------------

const LANG_EXTS: Record<McpLang, readonly string[]> = MCP_LANG_EXTS;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extname(filePath: string): string {
  const idx = filePath.lastIndexOf(".");
  if (idx < 0) return "";
  return filePath.slice(idx);
}

/**
 * Structural test-path predicate: a `test|tests|__tests__|spec|__spec__` path
 * SEGMENT, or a `.test.`/`.spec.` filename affix. Deliberately has no bare
 * `\btest` catch-all — that would sweep in `testbed/`, `latest/`, and similar.
 *
 * Exported for the evidence resolver, which needs one shared classifier
 * rather than a fifth divergent copy (impact.ts classifySurface,
 * core2/search.ts TEST_PATH_RE and semanticWiringResolver.ts each carry
 * their own, looser, notion).
 */
export function isTestPath(path: string): boolean {
  return /(?:^|\/)(?:test|tests|__tests__|spec|__spec__)(?:\/|$)|(?:\.test\.|\.spec\.)/.test(path);
}

function isGeneratedOrFixture(path: string): boolean {
  return (
    path.includes("node_modules/") ||
    path.includes("dist/") ||
    path.includes(".tokenlighten/cache/") ||
    path.includes("bench/fixtures/")
  );
}

/**
 * Fix A (2026-07-12c empty-symbol-query forensics): true when `filePath` IS
 * `scopePath`, or sits under it as a directory (a proper `/`-bounded
 * prefix) — the HARD scope test for an explicitly caller-named `path`.
 * Deliberately stricter than the pre-existing soft `pathHintMatch` signal
 * below (plain startsWith/includes), which can false-positive on a partial
 * segment match (e.g. scope "foo/Invoice" must not match
 * "foo/InvoicePrinter.java").
 */
function isUnderPath(filePath: string, scopePath: string): boolean {
  if (filePath === scopePath) return true;
  const withSlash = scopePath.endsWith("/") ? scopePath : `${scopePath}/`;
  return filePath.startsWith(withSlash);
}

/**
 * Split a camelCase or snake_case identifier into tokens.
 */
function splitIdentifierTokens(name: string): string[] {
  return name
    .split(/(?<=[a-z])(?=[A-Z])|[_\-]/)
    .map((t) => t.toLowerCase())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Search for symbols in the manifest matching the input query.
 * Returns ranked results, truncation info, and total match count.
 */
export function searchSymbols(
  ctx: SearchContext,
  input: SearchInput,
): { locations: RankedLocation[]; truncated: boolean; total: number } {
  const { manifest, fileScores, recentFiles } = ctx;
  const queryLower = input.query.toLowerCase();
  const limit = Math.min(input.limit ?? 10, 50);

  // Fix A (2026-07-12c): hasQuery/hasPathScope gate the empty-query
  // repo-wide fan-out bug (see isUnderPath's doc comment and the gate/dedup
  // changes below) — an empty query alone must never match every symbol;
  // it only lists within an explicitly caller-named path scope.
  const hasQuery = queryLower.trim().length > 0;
  const hasPathScope = typeof input.path === "string" && input.path.trim().length > 0;

  // Tokenize the query by whitespace (and underscores) for multi-token signals.
  const queryTokens = queryLower.split(/[\s_]+/).filter(Boolean);

  // Compute max pagerank score for normalization.
  let maxPageRank = 0;
  for (const score of fileScores.values()) {
    if (score > maxPageRank) maxPageRank = score;
  }

  // Lang filter: determine allowed extensions.
  const allowedExts: readonly string[] | null = input.lang ? (LANG_EXTS[input.lang] ?? null) : null;

  interface ScoredLocation extends RankedLocation {
    _score: number;
    _reasons: string[];
  }

  const results: ScoredLocation[] = [];

  for (const [filePath, fileEntry] of Object.entries(manifest.files)) {
    // Lang filter.
    if (allowedExts !== null) {
      const ext = extname(filePath);
      if (!allowedExts.includes(ext)) continue;
    }

    // Fix A: an explicitly caller-named `path` is a HARD scope — files
    // outside it are never eligible, regardless of query. See isUnderPath.
    if (hasPathScope && !isUnderPath(filePath, input.path!)) continue;

    const filePageRank =
      maxPageRank > 0 ? (fileScores.get(filePath) ?? 0) / maxPageRank : 0;
    const isRecent = recentFiles.has(filePath) ? 1 : 0;
    // Fix A: the fixture/generated-path penalty must not fire inside an
    // explicitly caller-named scope — the caller asked for THIS path, so a
    // bench/fixtures/ location within it is not a false-positive to demote.
    const isGenerated = (!hasPathScope && isGeneratedOrFixture(filePath)) ? 1 : 0;
    const isTest = isTestPath(filePath) ? 1 : 0;

    for (const sym of fileEntry.symbols) {
      const symbolLower = sym.name.toLowerCase();

      // Name-based signals.
      const exactSymbolMatch = symbolLower === queryLower ? 1 : 0;
      const camelTokens = splitIdentifierTokens(sym.name);
      const camelCaseOrTokenMatch = camelTokens.some((t) => t === queryLower) ? 1 : 0;
      const lexicalSubstringMatch = symbolLower.includes(queryLower) ? 1 : 0;

      // Multi-token query signals.
      // queryTokenSymbolMatch: fraction of query tokens that match any camelCase token of symbol.
      let queryTokenSymbolMatch = 0;
      if (queryTokens.length > 0) {
        const camelTokenSet = new Set(camelTokens);
        let matched = 0;
        for (const qt of queryTokens) {
          if (camelTokenSet.has(qt)) matched++;
        }
        queryTokenSymbolMatch = matched / queryTokens.length;
        // Avoid double-counting: if single-token query and camelCaseOrTokenMatch already fired,
        // zero out this signal.
        if (queryTokens.length === 1 && camelCaseOrTokenMatch === 1) {
          queryTokenSymbolMatch = 0;
        }
      }

      // queryTokenPathMatch: fraction of query tokens that appear in path segments.
      // Path segments are derived by splitting filePath by '/', '.', and '_', lowercase.
      // The basename (last segment before extension) is additionally decomposed by
      // camelCase splitting so that 'OrderService.java' yields tokens ['order','service'].
      let queryTokenPathMatch = 0;
      if (queryTokens.length > 0) {
        // Split all path components by '/', '.', '_'.
        const rawSegments = filePath
          .split("/")
          .flatMap((seg) => seg.split(/[._]/))
          .map((s) => s.toLowerCase())
          .filter(Boolean);
        // Also apply camelCase splitting to the basename (second-to-last segment
        // before the extension, i.e. the filename stem). This lets 'OrderService'
        // yield 'order' and 'service' as path tokens.
        const parts = filePath.split("/");
        const lastPart = parts[parts.length - 1] ?? "";
        const stem = lastPart.includes(".") ? lastPart.slice(0, lastPart.lastIndexOf(".")) : lastPart;
        const stemTokens = splitIdentifierTokens(stem);
        const pathSegments = [...rawSegments, ...stemTokens];
        const pathSegSet = new Set(pathSegments);
        let matched = 0;
        for (const qt of queryTokens) {
          if (pathSegSet.has(qt)) matched++;
        }
        queryTokenPathMatch = matched / queryTokens.length;
      }

      // apiRouteMatch: stub — returns 0 until endpoint-to-symbol mapping is stable.
      // TODO: wire up when manifest.files[].outgoingSymbolRefs or apiGraph.ts exposes
      // a handler index. See apiGraph.ts for future integration point.
      const apiRouteMatch = 0;

      // Gate: include symbols with at least one name/path/token match
      // signal. Fix A: with no query at all, that would vacuously pass
      // (lexicalSubstringMatch: symbolLower.includes("") is always true) —
      // gated on hasQuery so an empty query only ever lists within an
      // explicit hard path scope (already filtered above), never fans out
      // repo-wide.
      const passesGate = hasQuery
        ? (exactSymbolMatch ||
          camelCaseOrTokenMatch ||
          lexicalSubstringMatch ||
          queryTokenSymbolMatch > 0 ||
          queryTokenPathMatch > 0)
        : hasPathScope;
      if (!passesGate) continue;

      // Path hint signal.
      const pathHintMatch =
        input.path !== undefined &&
        (filePath.startsWith(input.path) || filePath.includes(input.path))
          ? 1
          : 0;

      // Compute score.
      const score =
        4.0 * exactSymbolMatch +
        2.0 * camelCaseOrTokenMatch +
        2.0 * queryTokenSymbolMatch +
        1.5 * lexicalSubstringMatch +
        1.5 * queryTokenPathMatch +
        0.5 * filePageRank +
        1.0 * apiRouteMatch +
        1.0 * isRecent +
        1.0 * pathHintMatch -
        1.0 * isTest -
        2.0 * isGenerated;

      // Collect reasons.
      const reasons: string[] = [];
      if (exactSymbolMatch) reasons.push("exactSymbolMatch");
      if (camelCaseOrTokenMatch) reasons.push("camelCaseOrTokenMatch");
      if (lexicalSubstringMatch) reasons.push("lexicalSubstringMatch");
      if (queryTokenSymbolMatch > 0) reasons.push("queryTokenSymbolMatch");
      if (queryTokenPathMatch > 0) reasons.push("queryTokenPathMatch");
      if (apiRouteMatch > 0) reasons.push("apiRouteMatch");
      if (filePageRank > 0) reasons.push("pageRankFileScore");
      if (isRecent) reasons.push("recentGitTouch");
      if (pathHintMatch) reasons.push("pathHintMatch");

      results.push({
        path: filePath,
        line: sym.lineStart,
        symbol: sym.name,
        kind: sym.kind,
        signature: sym.signature,
        _score: score,
        _reasons: reasons,
        score: undefined,
        reasons: undefined,
      });
    }
  }

  // Sort: score descending, then path bytes ascending, then line ascending.
  results.sort((a, b) => {
    const scoreDiff = b._score - a._score;
    if (scoreDiff !== 0) return scoreDiff;
    const pathCmp = Buffer.compare(Buffer.from(a.path), Buffer.from(b.path));
    if (pathCmp !== 0) return pathCmp;
    return a.line - b.line;
  });

  // Deduplicate: keep only the best-scoring symbol per file so that more distinct
  // files appear within the top-k results. Without this, a file with many matching
  // symbols can occupy all k slots. Fix A: skipped entirely within an explicit
  // hard path scope — there the caller wants that path's OWN symbol
  // inventory (a listing, or every in-scope match), not one representative
  // symbol per file (a single-file scope would otherwise collapse to just 1
  // result no matter how many symbols that file has).
  const seenFiles = new Set<string>();
  const deduped: ScoredLocation[] = [];
  for (const r of results) {
    if (hasPathScope || !seenFiles.has(r.path)) {
      seenFiles.add(r.path);
      deduped.push(r);
    }
  }

  // total reflects the number of distinct files matched (after dedup), which
  // is the most useful count for callers deciding whether to broaden their query.
  const total = deduped.length;
  const truncated = total > limit;
  const sliced = deduped.slice(0, limit);

  // Build output, conditionally including score and reasons.
  const locations: RankedLocation[] = sliced.map((r) => {
    const loc: RankedLocation = {
      path: r.path,
      line: r.line,
      symbol: r.symbol,
      kind: r.kind,
      signature: r.signature,
    };
    if (input.includeScores === true) {
      loc.score = r._score;
      loc.reasons = r._reasons;
    }
    return loc;
  });

  return { locations, truncated, total };
}
