/**
 * locateTaskContext — deterministic, layered file/symbol locator.
 *
 * Implements DESIGN-v0.4-one-shot-read-write.md §"Read: explore action=locate"
 * (lines 99–324).
 *
 * Algorithm layers (cheapest signal first):
 *   1. Exact symbol lookup (skeleton-engine source index).
 *   2. Symbol search over query tokens.
 *   3. Exact text search for quoted strings / distinctive identifiers.
 *   4. Reference search for identifier-like tokens in query.
 *   5. Path-token matching against indexed file paths.
 *   (git-touch boost: TODO — searchSymbols.ts now has a private getRecentFiles
 *   helper it uses for its own ranking; wire it in here once it (or an
 *   equivalent) is exported from skeleton-engine or searchSymbols.)
 *
 * Exclusions: nothing repo-specific is hardcoded here. The shared walk
 * (walkRepo.ts) applies createIgnoreMatcherSync's default rules plus the
 * workspace's optional `.tokenlightenignore` patterns; this repo's own
 * conventions (proto/, docs/, reports/) are declared in that file at the
 * repo root. reports/ holds the repo's own self-analysis output (bench
 * reports, etc.) and must never be surfaced as task context — see CLAUDE.md
 * "Keep verifier scripts and fixture baselines out of agent-visible task
 * context."
 *
 * Byte caps enforced:
 *   - Success: <= 2048 B serialized JSON.
 *   - Abstain: <= 512 B serialized JSON.
 */

import * as fs from "fs";
import * as path from "path";
import type { LocateInput, LocateOutput, ImpactCandidate, ImpactSurface, LocateCandidateDetail } from "@tokenlighten/types";
import { findText, scanLiteral, type TextMatch } from "../search/find/findText.js";
import { decodeTextBuffer } from "../../util/textDecode.js";
import { findReferences } from "../../tools/findReferences.js";
import { searchSymbols } from "../../tools/searchSymbols.js";
import { isProtocolSymbolSearchToken } from "../../tools/queryEvidence.js";
import { isSourceOnlyExcludedPath, walkCodeFiles, TEXT_SCAN_MAX_FILE_SIZE_BYTES, type FoundFile, type WalkOptions } from "../../tools/walkRepo.js";
import { languageForPath, languageForPathWithContent } from "../../util/languages.js";
import { classifySurface, deriveTokenVariants, coverage, surfaceInventory } from "../../util/impact.js";
import { handleTable, type HandleKind } from "../../util/handles.js";
import {
  graphIndexMode,
  bm25fCandidateEnabled,
  rrfFusionEnabled,
  rrfProfilesEnabled,
  graphEvidenceEnabled,
  compoundRetrievalEnabled,
} from "../../util/flags.js";
import { fileNamesInPathSpans, isEnumLikeQuery, stripPathSpans } from "../../util/queryShape.js";
import { extractCjkTokens } from "../../util/cjkSpans.js";
import { tokenizeForEpoch } from "../../state/session.js";
import { isNativeExtPath, widenNativeRange } from "../../util/nativeSymbolRange.js";
import { dominantRoot } from "../../util/dominantRoot.js";
import { buildRootResolver, inferClusterRoot, commonAncestorDir, type RootResolver } from "../../util/projectRoot.js";
import { SENTINEL_START, SENTINEL_END } from "@tokenlighten/agents-md";
import { classifyCommentLines, matchesAreCommentOnly } from "../../util/lineClassify.js";
import { loadGraphIndex } from "../../graph/index.js";
import { collectSymbols, type CollectedSymbol } from "../../symbols/collectSymbols.js";
import { isMarkdownPath, parseMarkdownHeadings } from "../../util/markdownSections.js";
import { trace } from "../../util/trace.js";
import { applyHybridRetrieval } from "../retrieval/index.js";
import { applyCompoundRetrieval } from "../compound/index.js";

// ---------------------------------------------------------------------------
// Constants (exported for budget tests)
// ---------------------------------------------------------------------------

export const LOCATE_SUCCESS_CAP = 2048;
export const LOCATE_ABSTAIN_CAP = 512;

/** Lines to include around a text match (centered window). */
const TEXT_WINDOW_LINES = 20;

// MAX_NATIVE_SYMBOL_LINES (DESIGN-v0.8 §A5 deliverable 2: cap on a C/C++
// candidate's range once widened to its enclosing symbol) now lives in
// util/nativeSymbolRange.ts, shared with readCodeTaskPack.ts's equivalent
// cap — a handle minted directly off a locate() hit (not routed through
// task_pack) still gets a useful range instead of the fixed ±10-line text
// window, without letting one huge enclosing class swallow the
// LOCATE_SUCCESS_CAP budget.

// ---------------------------------------------------------------------------
// Per-call file-walk memoization (efficiency fix: one walk per unique
// (lang, subPath, extraExts) option-set per locateTaskContext() call, instead
// of re-walking the whole tree from scratch every time a helper needs a file
// list). A single locate() call previously performed 2-4 INDEPENDENT
// walkCodeFiles walks (the eager inferQueryContext short-token-path walk, its
// own full-workspace walk, the Layer-5 getCodeFiles walk, and the
// C/C++-closure getWorkspaceFiles walk) even though several of them request
// the identical option-set. WalkCache is created once per locate() call and
// threaded through every helper that needs a file list; each unique
// option-set is walked at most once and the FoundFile[] is reused by every
// consumer that asks for the same set.
// ---------------------------------------------------------------------------

/** Canonical cache key for a WalkOptions — order-independent, stable. */
function walkCacheKey(opts: WalkOptions): string {
  return JSON.stringify({
    lang: opts.lang ?? null,
    subPath: opts.subPath ?? null,
    extraExts: opts.extraExts ? [...opts.extraExts].sort() : null,
    includeArtifacts: opts.includeArtifacts ?? false,
    fullRecall: opts.fullRecall ?? false,
    // T3 (2026-08-27, v0.12 wave D2, DEFECT A): distinct from the default
    // (undefined -> MAX_FILE_SIZE_BYTES) walk so a caller that explicitly
    // asks for the wider TEXT_SCAN_MAX_FILE_SIZE_BYTES cap (see
    // wideExactTextMatches below) never silently reuses -- or gets reused
    // by -- a narrower-capped walk cached under the same lang/subPath.
    sizeCapBytes: opts.sizeCapBytes ?? null,
  });
}

/**
 * Per-call memoized walkCodeFiles: one real filesystem walk per DISTINCT
 * option-set, however many times a helper asks for it. Instantiate exactly
 * once at the top of locateTaskContext() and pass down to every helper that
 * previously called walkCodeFiles directly.
 */
class WalkCache {
  private readonly cache = new Map<string, FoundFile[]>();

  constructor(private readonly workspace: string) {}

  get(opts: WalkOptions = {}): FoundFile[] {
    const key = walkCacheKey(opts);
    let files = this.cache.get(key);
    if (files === undefined) {
      files = walkCodeFiles(this.workspace, opts);
      this.cache.set(key, files);
    }
    return files;
  }
}

// Defensive cap on the SUPPLEMENTARY large-file scan below -- see its own
// doc comment. Independent of findText.ts's own MAX_MATCHES (100): this is
// strictly additive recall over files findText() could never have scanned,
// so a much smaller cap is enough to protect against a pathological match
// count in one huge file without meaningfully limiting genuine recall.
const WIDE_TEXT_MATCH_CAP = 20;

/**
 * T3 (2026-08-27, v0.12 wave D2, DEFECT A -- field-eval report): findText()
 * always walks with the DEFAULT walkCodeFiles size cap (1 MB,
 * MAX_FILE_SIZE_BYTES) because it has no way to ask for a larger one and
 * does its own internal walk whenever it is not handed a pre-walked `files`
 * list. The exposed `search_files action=find` tool never hits this limit
 * because ITS implementation (buildFindResponse) pre-walks with the wider
 * TEXT_SCAN_MAX_FILE_SIZE_BYTES (8 MB) cap and hands scanLiteral() that
 * walked list directly -- bypassing findText()'s narrower internal walk
 * entirely. Layer 3 had no equivalent path, so a real source file between
 * 1 MB and 8 MB (a ~12,000-line file crosses 1 MB easily) was invisible to
 * it even though the exposed find tool sees it instantly: the exact
 * external-eval symptom (search_files found a unique identifier at line
 * 8766; task_pack never located it, served head-of-file, then steered to
 * huge zoom ranges).
 *
 * This is deliberately ADDITIVE, not a replacement for the existing
 * findText() call at each site: it only scans files strictly BETWEEN the
 * two caps (the wide walk minus the narrow/default walk), so every file
 * findText() already sees is completely unaffected -- zero change to
 * today's ranking or scoring for anything already within the 1 MB cap.
 */
function wideExactTextMatches(
  query: string,
  workspace: string,
  opts: { lang?: WalkOptions["lang"]; path?: string },
  walkCache: WalkCache,
): TextMatch[] {
  const walkOpts = {
    ...(opts.lang ? { lang: opts.lang } : {}),
    ...(opts.path ? { subPath: opts.path } : {}),
  };
  const wide = walkCache.get({ ...walkOpts, sizeCapBytes: TEXT_SCAN_MAX_FILE_SIZE_BYTES });
  const narrow = walkCache.get(walkOpts);
  const narrowPaths = new Set(narrow.map((f) => f.relPath));
  const largeOnly = wide.filter((f) => !narrowPaths.has(f.relPath));
  if (largeOnly.length === 0) return [];
  // Mirrors findText()'s own default caseInsensitive heuristic
  // (!input.regex && isSingleToken(query)) for the single-token queries
  // every Layer 3 call site here actually passes.
  return scanLiteral(query, workspace, {
    caseInsensitive: !/\s/u.test(query),
    files: largeOnly,
  }).slice(0, WIDE_TEXT_MATCH_CAP);
}

export interface ArtifactDiscoveryInput {
  query?: string;
  path?: string;
  /** Directory/file seeds surface every artifact; augmented packs filter by filename. */
  includeAll?: boolean;
}

const ARTIFACT_QUERY_STOP_TOKENS = new Set([
  "artifact", "artifacts", "code", "doc", "docs", "document", "edit", "file", "files",
  "fixture", "fixtures", "pack", "package", "packages", "read", "source", "src", "task",
  "test", "tests",
]);

/**
 * Small, deterministic English inflection expansion for artifact filenames.
 * Office inputs are commonly named with a noun (for example `rate-table`)
 * while the request uses the corresponding activity (`rating`). Requiring
 * exact filename tokens in that case drops the real input before ranking.
 * Every variant must still occur in the artifact's own basename.
 */
export function artifactQueryTokenVariants(token: string): string[] {
  const lower = token.toLowerCase();
  const variants = new Set<string>([lower]);
  if (lower.length > 5 && lower.endsWith("ing")) {
    const stem = lower.slice(0, -3);
    variants.add(stem);
    // rating -> rate, writing -> write, calculating -> calculate
    if (/(?:at|it|iz|ur|us)$/.test(stem)) variants.add(`${stem}e`);
  }
  if (lower.length > 4 && lower.endsWith("ies")) variants.add(`${lower.slice(0, -3)}y`);
  if (lower.length > 4 && lower.endsWith("s") && !lower.endsWith("ss")) {
    variants.add(lower.slice(0, -1));
  }
  return [...variants];
}

/**
 * Discovery-only artifact inventory for task packs. Artifact entries never enter
 * locator candidate ranking, symbol parsing, role classification, or apiGraph.
 */
export function discoverArtifactFiles(
  workspace: string,
  input: ArtifactDiscoveryInput = {},
): FoundFile[] {
  const artifacts = walkCodeFiles(workspace, {
    ...(input.path ? { subPath: input.path } : {}),
    includeArtifacts: true,
  }).filter((file) => file.kind === "artifact");
  if (input.includeAll === true) return artifacts;

  const tokens = [...new Set(
    (input.query?.toLowerCase().match(/[a-z0-9]+/g) ?? [])
      .filter((token) => token.length >= 3 && !ARTIFACT_QUERY_STOP_TOKENS.has(token))
      .flatMap(artifactQueryTokenVariants),
  )];
  if (tokens.length === 0) return [];
  return artifacts.filter((file) => {
    // Match the artifact's own name, not infrastructure directories such as
    // `packages/` or `fixtures/`. A query mentioning "task pack" previously
    // admitted every PDF below packages/ because "pack" matched the directory.
    const candidate = path.posix.basename(file.relPath).toLowerCase();
    const candidateTokens = new Set(candidate.match(/[a-z0-9]+/g) ?? []);
    return tokens.some((token) => candidateTokens.has(token));
  });
}

// ---------------------------------------------------------------------------
// Project-root scoping (DESIGN-v0.8 §A2) — GENERAL model.
//
// The former model was BENCH-SPECIFIC: it detected roots ONLY at the
// `bench/fixtures/<name>/` path boundary and folded everything else into one
// "host" root, and it hard-coded this repo's own convention directories
// (proto/, docs/, reports/) as always-excluded. Both are gone. A directory is
// now a project root when it carries a VCS boundary or a recognized manifest
// (see util/projectRoot.ts), so the locator's cross-project scoping works in
// ANY monorepo / parent-cwd layout — which is the actual environment the
// fixed failure (a subproject task outvoted by stray matches in unrelated code
// when the cwd is a parent dir) occurs in. Repo-specific exclusions now live in
// a `.tokenlightenignore` file honored by the shared walk, not in product code.
// ---------------------------------------------------------------------------

/**
 * Per-workspace memoized RootResolver so `projectRootOf(relPath)` stays
 * signature-compatible for external callers (readCodeTaskPack.ts, impact.ts)
 * that group already-located paths by root and cannot cheaply thread a
 * resolver through every helper. The resolver is built from a full workspace
 * walk; the memo is a tiny LRU (workspaces rarely alternate within a process).
 */
const rootResolverCache = new Map<string, RootResolver>();
const ROOT_RESOLVER_CACHE_MAX = 4;
/** Workspace `projectRootOf(relPath)` resolves against when no workspace is passed. */
let activeRootWorkspace: string | null = null;

function resolverForWorkspace(workspace: string): RootResolver {
  const key = path.resolve(workspace);
  const cached = rootResolverCache.get(key);
  if (cached) return cached;
  const files = walkCodeFiles(workspace).map((f) => f.relPath);
  const resolver = buildRootResolver(workspace, files);
  if (rootResolverCache.size >= ROOT_RESOLVER_CACHE_MAX) {
    const oldest = rootResolverCache.keys().next().value;
    if (oldest !== undefined) rootResolverCache.delete(oldest);
  }
  rootResolverCache.set(key, resolver);
  return resolver;
}

/**
 * Set the workspace that a subsequent bare `projectRootOf` resolves against.
 * Called at the top of `locateTaskContext()` and of `buildTaskPack()` so the
 * pack layer's own `projectRootOf(path)` grouping uses the SAME general root
 * model this call is about, without every pack helper needing an extra
 * resolver parameter.
 *
 * Pass an already-built `resolver` (as locateTaskContext does, from its shared
 * WalkCache) to INSTALL it without a second filesystem walk — critical for the
 * per-call one-walk-per-option-set invariant. Omit it to let the resolver be
 * built lazily on first `projectRootOf` (the pack-layer entry, which has no
 * WalkCache of its own yet).
 */
export function setActiveRootWorkspace(workspace: string, resolver?: RootResolver): void {
  const key = path.resolve(workspace);
  activeRootWorkspace = key;
  if (resolver) {
    if (rootResolverCache.size >= ROOT_RESOLVER_CACHE_MAX && !rootResolverCache.has(key)) {
      const oldest = rootResolverCache.keys().next().value;
      if (oldest !== undefined) rootResolverCache.delete(oldest);
    }
    rootResolverCache.set(key, resolver);
  }
}

/** Drop the memoized resolver for a workspace (test hook — fixtures mutate on disk between cases). */
export function resetRootResolverCache(): void {
  rootResolverCache.clear();
  activeRootWorkspace = null;
}

/**
 * Identify which project root a workspace-relative path belongs to: the
 * nearest enclosing directory carrying a VCS/manifest marker, else "" (the
 * workspace root). Back-compat single-arg form for external callers
 * (readCodeTaskPack.ts / impact.ts) — resolves against the active workspace
 * set by setActiveRootWorkspace; pass `workspace` explicitly to resolve
 * against a specific one. Falls back to "" (workspace root) when no active
 * workspace has been set (e.g. a stray call before any locate/pack), which is
 * the safe, non-scoping answer.
 */
export function projectRootOf(relPath: string, workspace?: string): string {
  const ws = workspace ? path.resolve(workspace) : activeRootWorkspace;
  if (!ws) return "";
  return resolverForWorkspace(ws).rootOf(relPath);
}

/**
 * B1a (2026-08-01 retrieval-scope): the subtree prefixes a ROLE/FAMILY search
 * may look in, derived from an ANCHOR cluster (the direct query hits, or the
 * caller's own named paths).
 *
 * A role/style/test search is not a query match — it looks for "a file that
 * PLAYS this part", so on its own it has no relevance signal at all and will
 * happily take the best-ranked such file anywhere in the workspace. The only
 * thing that made that safe was a scope, and the scope used to be the anchors'
 * single COMMON ANCESTOR directory. In a workspace hosting several independent
 * project trees under one parent (a monorepo of unrelated products, a
 * fixtures/ or examples/ directory, a vendored tree) that ancestor is the
 * shared parent — i.e. permission to search every SIBLING tree, including
 * trees with zero anchors. Live forensics (run 2026-07-31-semantic-signal5-2,
 * T09): a pack anchored in one fixture served a `style` surface from a
 * different fixture's frontend and a `test` surface from a third fixture's
 * firmware, and its own `roots` envelope named both.
 *
 * Contract:
 *   - anchors all in ONE project root → that root ("" = the workspace root
 *     project, which by rootOf-membership excludes nested marker roots);
 *   - anchors spanning roots under a SHARED ancestor → one prefix per
 *     ancestor-CHILD directory that actually contains an anchor, so the
 *     in-family siblings a monorepo's missing contract/api role really does
 *     live in stay reachable while anchor-free siblings do not;
 *   - anchors spanning roots with NO shared ancestor → the same child rule with
 *     the workspace root as the ancestor, i.e. the TOP-LEVEL directories that
 *     hold an anchor (`packages/` + `apps/` for a shared contract consumed by a
 *     web app: `apps/api` stays reachable, `other-product/` does not);
 *   - no anchors at all → null (the caller decides: skip, or stay unconfined
 *     because there was never anything to anchor on).
 *
 * `rootOf` is injectable so a caller holding a live RootResolver (locate) and
 * one relying on the active-workspace memo (the pack layer) share ONE
 * definition of this contract instead of drifting copies.
 */
export function roleSearchScopePrefixes(
  anchorPaths: readonly string[],
  rootOf: (relPath: string) => string = (p) => projectRootOf(p),
): string[] | null {
  const anchors = [...new Set(anchorPaths.filter((p) => p.length > 0))];
  if (anchors.length === 0) return null;
  const roots = new Set(anchors.map((p) => rootOf(p)));
  if (roots.size === 1) return [[...roots][0]!];
  const ancestor = commonAncestorDir(anchors);
  const prefixes = new Set<string>();
  for (const anchor of anchors) {
    const rest = ancestor === "" ? anchor : anchor.slice(ancestor.length + 1);
    const child = rest.split("/")[0] ?? "";
    // A file lying DIRECTLY in the ancestor keeps the ancestor itself (there is
    // no intermediate directory to narrow to).
    prefixes.add(
      rest.includes("/") && child.length > 0
        ? (ancestor === "" ? child : `${ancestor}/${child}`)
        : ancestor,
    );
  }
  return [...prefixes].sort();
}

/**
 * True when `relPath` lies inside ANY prefix returned by
 * roleSearchScopePrefixes. The "" prefix keeps ROOT-MEMBERSHIP semantics
 * (rootOf(p) === ""), not "everything": that is the boundary that keeps a host
 * repo's own files out of a task anchored in a nested project, and vice versa.
 */
export function isWithinRoleSearchScope(
  relPath: string,
  prefixes: readonly string[] | null | undefined,
  rootOf: (path: string) => string = (p) => projectRootOf(p),
): boolean {
  if (prefixes === undefined || prefixes === null) return true;
  return prefixes.some((prefix) =>
    prefix === ""
      ? rootOf(relPath) === ""
      : relPath === prefix || relPath.startsWith(prefix + "/")
  );
}

/**
 * B1a: `why` markers produced by the locator's own STYLE/PRESENTATION-family
 * scans. A candidate carrying one of these was admitted because it plays the
 * style part for a token family, not because the query matched it — so it is
 * scope-confined by the DIRECT hits rather than being an anchor itself.
 */
const STYLE_FAMILY_WHY: ReadonlySet<string> = new Set(["family-stem", "presentation-family"]);

/**
 * `why` tags produced by generic full-text/co-occurrence layers (Layer 3's
 * plain substring search, its variant/reference cousins) — never a targeted
 * symbol- or name-level match. A path reachable ONLY through one of these
 * cannot, on its own, seed `addSiblingValueStructuralCandidates`'s family
 * scan: an incidental substring hit in an unrelated project's same-named
 * file is otherwise indistinguishable from the real contract (R9,
 * 2026-08-21).
 */
export const SIBLING_SEED_WEAK_WHY: ReadonlySet<string> = new Set([
  "exact-text", "exact-text:distinctive", "variant-text", "reference", "family-stem",
]);

/**
 * Common CSS property names that double as ordinary English words (R12,
 * 2026-08-21). A query about "the cursor" or "an overlay's position" matches
 * `cursor:`/`position:` in essentially every stylesheet in the walk — a
 * coincidental vocabulary collision, not real relevance. Deliberately
 * narrow: a QUERY-DISTINCTIVE word that happens to appear in a class name
 * (e.g. "widget" in ".widget-card") is real signal and must keep matching;
 * only the closed set of generic CSS property keywords is gated here.
 */
const CSS_PROPERTY_KEYWORDS: ReadonlySet<string> = new Set([
  "cursor", "color", "background", "display", "position", "overflow", "float",
  "clear", "content", "order", "resize", "appearance", "direction", "opacity",
  "border", "margin", "padding", "width", "height", "font", "transform",
  "transition", "animation", "outline", "filter", "gap", "flex", "grid",
]);

/** Direct (non-family-scan) candidate paths — the anchors a family scan is confined by. */
function familyScanAnchorPaths(candidates: readonly Candidate[]): string[] {
  return candidates
    .filter((c) => !STYLE_FAMILY_WHY.has(c.why) && classifySurface(c.path) !== "style")
    .map((c) => c.path);
}

const PROJECT_SCOPE_STOP_TOKENS = new Set([
  "app", "apps", "backend", "bench", "client", "common", "feature", "fixtures", "frontend",
  "package", "packages", "server", "shared", "source", "src", "test", "tests", "web",
  "add", "change", "fix", "implement", "support",
]);

function inferQueryProjectScopeFromResolver(query: string, resolver: RootResolver): string | undefined {
  const splitIdentifier = (token: string): string[] =>
    token
      .replace(/[_-]+/g, " ")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .split(/\s+/)
      .filter(Boolean);
  const tokens = new Set(
    [...tokenizeForEpoch(query), ...extractIdentifiers(query).flatMap(splitIdentifier)]
      .map((token) => token.toLowerCase())
      .filter((token) =>
        token.length >= 4
        && /^[a-z][a-z0-9_-]+$/.test(token)
        && !PROJECT_SCOPE_STOP_TOKENS.has(token)
      ),
  );
  const candidates: string[] = [];
  for (const token of tokens) {
    const matchingRoots = resolver.markerRoots.filter((root) =>
      root.toLowerCase().split("/").includes(token)
    );
    // A segment shared by every root ("packages", "fixtures", etc.) carries
    // no project-selection information and must not become a hard scope.
    if (matchingRoots.length === 0 || matchingRoots.length === resolver.markerRoots.length) continue;
    const common = commonAncestorDir(matchingRoots.map((root) => `${root}/__scope__`));
    if (common) candidates.push(common);
  }
  if (candidates.length === 0) return undefined;
  const unique = [...new Set(candidates)];
  // Multiple named project roots in one request are a real cross-root task.
  return unique.length === 1 ? unique[0] : undefined;
}

/**
 * Infer a conservative hard scope from an exact project-name path segment.
 * Generic words never bind, and cross-project requests deliberately abstain.
 */
export function inferQueryProjectScope(workspace: string, query: string): string | undefined {
  const files = walkCodeFiles(workspace);
  const resolver = buildRootResolver(workspace, files.map((file) => file.relPath));
  return inferQueryProjectScopeFromResolver(query, resolver);
}

// ---------------------------------------------------------------------------
// Internal candidate shape
// ---------------------------------------------------------------------------

export interface Candidate {
  path: string;      // workspace-relative POSIX path
  line: number;      // 1-based
  endLine?: number;  // 1-based inclusive (for symbol hits)
  /** Optional repeated-hit envelope that supersedes the default 20-line window. */
  range?: string;
  symbol?: string;
  // "bm25f": V10-08 Hybrid Retrieval v1 (features/retrieval/) — a candidate
  // synthesized from an in-memory BM25F index unit (markdown section, config
  // object, test case, file metadata, or a parser-proven symbol unit) that
  // the existing layers above did not already surface. Only ever produced by
  // features/retrieval/index.ts's applyHybridRetrieval, gated by
  // TL_BM25F_CANDIDATE; see util/flags.ts.
  kind: "symbol" | "text" | "reference" | "path-token" | "structural" | "bm25f";
  score: number;
  why: string;
  /**
   * Query identifier tokens this candidate is KNOWN to cover, recorded by the
   * layer that produced it (the text/reference layers know exactly which token
   * they searched for; the filename-match layer knows which basename tokens
   * matched and which extra token its refined symbol carries). Path/symbol
   * names are re-derived on demand, so a layer that leaves this undefined
   * still gets its name-derived coverage — see coveredQueryTokens().
   */
  covers?: readonly string[];
  /**
   * DESIGN-v0.8 §A6 deliverable 1: force-admit this candidate as a REQUIRED
   * surface (ImpactCandidate.required) even when it lands in `related`
   * rather than winning the `primary` slot. Used by
   * addSiblingValueInitializerCandidates — an exhaustive-initializer/
   * aggregation map match is exactly the kind of surface an enum-extension
   * task must not silently drop as "optional related context": both arms of
   * the edit (the new member's zero-init entry) need it. Undefined/false for
   * every other candidate kind (default related-candidate behavior
   * unchanged).
   */
  required?: boolean;
  /**
   * Field-eval fix (2026-08-27): set by applyCommentOnlyPenalty when this
   * candidate's file was judged comment-only noise for the query (every
   * query-token match in that file lands on a comment line) and its score
   * took the full COMMENT_ONLY_PENALTY. selectRelatedCandidates's role-
   * diversity guarantee must never force-include a penalized candidate just
   * because it happens to be the sole representative of its classifySurface
   * role — that resurrects exactly the noise the penalty exists to sink.
   */
  commentOnlyPenalized?: boolean;
}

interface QueryContext {
  /** Path segments mentioned by the query and present in the workspace. */
  scopeHints: Set<string>;
  /**
   * Workspace basename-token frequency: for each lowercase word token that
   * appears in some file's basename (per splitBasenameTokens), the number of
   * DISTINCT files whose basename contains that token. Used by
   * matchBasenameTokens to gate single-token admission by RARITY instead of
   * raw token length — "status" occurring in dozens of basenames is not
   * distinctive regardless of its length, while a 3-4 char token that occurs
   * in only one or two basenames (e.g. "pll", "wave" in a workspace where it
   * names exactly one module) is a strong, corroborating signal.
   *
   * LAZY: computed on first call, not eagerly at inferQueryContext time. The
   * short-token path (see inferQueryContext) has no other reason to walk the
   * tree at all — building this map unconditionally there cost a full
   * workspace walk on every locate() call whose query has no substantial
   * scope-hint-shaped token, even when Layer 5a's single-token basename check
   * (the ONLY consumer) never runs (e.g. a symbol-only query, or a query
   * whose Layer 1-4 signals already resolve unambiguously). Backed by the
   * shared per-call WalkCache when it does run, so it still costs at most one
   * walk — just deferred until actually needed.
   */
  getBasenameFrequency(): Map<string, number>;
}

/** Wrap an already-computed frequency map in the QueryContext lazy-getter shape. */
function eagerBasenameFrequency(freq: Map<string, number>): () => Map<string, number> {
  return () => freq;
}

/** A single-token basename match is treated as distinctive (rare) at or below this file count. */
export const BASENAME_RARITY_THRESHOLD = 2;

/**
 * Result of computeDominantRoot: the dominant root itself (see below) plus a
 * Map from each candidate to its OWN already-computed root — every consumer
 * downstream that needs "what root is this candidate in" (the demotion pass,
 * the scope-hint down-filter's isInRootFilenameMatch, the required-surface
 * in-root accounting) looks it up here instead of recomputing per candidate.
 *
 * `rootByCandidate` holds the EFFECTIVE root (marker root, refined by cluster
 * inference when applicable), so a manifest-less subproject cluster and a
 * marker root are indistinguishable to downstream consumers — they just get a
 * consistent, non-empty root string for in-cluster candidates.
 *
 * `inScopeRoots` (DESIGN-v0.8, two-domain fix) is the set of roots the
 * out-of-root demotion pass must treat as IN-scope — i.e. NOT demote. It
 * ALWAYS contains `root` (when non-null); it additionally contains a SECOND
 * root when this is a genuine two-domain wiring query (strong candidates
 * matching DISTINCT query identifier tokens live in >= 2 different roots — see
 * `dominantRoots` below). Downstream the demotion pass checks membership here
 * instead of strict equality with the single dominant `root`, so a legitimate
 * cross-package task ("feed <producer symbol> into <consumer field>") keeps
 * BOTH its domains' files instead of the majority vote destroying the loser.
 * When there is nothing to scope (`root` is null) this is empty.
 *
 * `multiRoot` is true exactly when `inScopeRoots.size >= 2` — a convenience the
 * pack-layer integration (a later workstream) reads to know the pack should
 * span both domains (coverage/next must not treat the second domain's absence
 * as a partial). It is derived, never set independently of `inScopeRoots`.
 */
interface DominantRootResult {
  root: string | null;
  rootByCandidate: Map<Candidate, string>;
  /**
   * Roots exempt from the out-of-root demotion. Superset of `{root}` (when
   * root !== null); a second root is added only for a genuine two-domain
   * query. Empty when root is null.
   */
  inScopeRoots: Set<string>;
  /** True when >= 2 distinct roots are in scope (a two-domain wiring query). */
  multiRoot: boolean;
}

/**
 * DESIGN-v0.8 two-domain fix: a candidate whose relevance is a STRONG,
 * precise signal (an AST symbol/structural hit, or a MULTI-token filename
 * match) rather than incidental text spray. Only these carry enough weight to
 * pull a SECOND root into scope for a two-domain query — a text/reference hit,
 * or a single-common-token filename match, is exactly the cross-project spray
 * the demotion exists to suppress and must never expand scope on its own.
 *
 * `multiTokenFilenamePaths` is `filenameMatchPaths` minus
 * `singleTokenFilenameMatchPaths` (the >= 2-query-token filename matches),
 * computed once by the caller and passed in.
 */
export function isStrongScopeCandidate(
  c: Candidate,
  multiTokenFilenamePaths: ReadonlySet<string>,
): boolean {
  if (c.kind === "symbol" || c.kind === "structural") return true;
  if (multiTokenFilenamePaths.has(c.path)) return true;
  return false;
}

/**
 * Which DISTINCT query identifier token(s) a strong candidate "is about":
 * lowercased query identifier tokens (length >= 3) that appear in the
 * candidate's symbol name or its file basename. Used by computeDominantRoot's
 * two-domain detection to decide whether two roots' strong candidates resolve
 * to the SAME identifier (the ambiguity case — one symbol name existing in two
 * projects; keep the majority vote) or to DIFFERENT identifiers (a genuine
 * two-domain wiring task; keep both). Basename is included because a
 * multi-token filename match is a strong signal keyed on the file's NAME, not
 * a body symbol.
 */
export function candidateIdentifierTokens(c: Candidate, queryIdentTokens: ReadonlyArray<string>): Set<string> {
  const hay =
    (c.symbol ? c.symbol.toLowerCase() + " " : "") +
    path.basename(c.path).toLowerCase();
  const out = new Set<string>();
  for (const t of queryIdentTokens) {
    if (t.length >= 3 && hay.includes(t)) out.add(t);
  }
  return out;
}

/**
 * Prefer an exact structured identifier carried by a symbol or basename even
 * when separators/casing differ (`task_pack` -> `readCodeTaskPack`). This is a
 * bounded tie-breaker, not a substitute for locator evidence: plain prose
 * tokens receive no boost and the candidate must already be in the pool.
 */
export function structuredIdentifierRankBoost(
  candidate: Candidate,
  queryIdentifiers: ReadonlyArray<string>,
): number {
  const structured = queryIdentifiers.filter((token) =>
    token.length >= 6 && (token.includes("_") || /[a-z][A-Z]/.test(token)),
  );
  if (structured.length === 0) return 0;
  const symbol = candidate.symbol?.toLowerCase().replace(/[^a-z0-9]/g, "") ?? "";
  const basename = path.basename(candidate.path, path.extname(candidate.path))
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  let boost = 0;
  for (const token of structured) {
    const normalized = token.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (normalized.length < 6) continue;
    if (symbol.includes(normalized)) {
      const symbolWeight = token.includes("_")
        ? 0.45 + Math.min(0.3, Math.max(0, normalized.length - 6) * 0.025)
        : 0.5;
      boost += symbolWeight;
    }
    // Do not lend filename affinity to an incidental body-text hit. Symbol
    // and path candidates may combine independent symbol+module evidence;
    // exact-text candidates must stand on the text match's own score.
    if (candidate.kind !== "text" && basename.includes(normalized)) boost += 0.3;
  }
  return Math.min(boost, 1.2);
}

/**
 * Determine the dominant project root for this locate call (DESIGN-v0.8 §A2,
 * GENERAL model), or null when there is nothing to scope (candidates already
 * confined to a single root, or the candidate pool is empty).
 *
 * Layered decision, most-certain signal first:
 *   1. Scope-hint override: if the query explicitly names a root (a scope-hint
 *      token — see inferQueryContext — matching a candidate root's own
 *      directory basename), that root wins outright. The query mentioning the
 *      subproject by name is stronger evidence than aggregate score, and
 *      protects against inference guessing wrong when one root's candidates
 *      happen to carry noisier/higher raw scores.
 *   2. Marker-root majority: aggregate SCORE by each candidate's marker root
 *      (nearest enclosing VCS/manifest dir, via the resolver) and pick the
 *      highest-scoring one, using the shared `dominantRoot` helper. Sum (not
 *      count) rewards a root with a few strong signals over one with many weak
 *      ones — the same intuition the rest of the scorer uses.
 *   3. Cluster refinement (manifest-independent): when marker roots did NOT
 *      resolve a dominant root — every candidate's marker root is the
 *      workspace root "" — infer an effective root from where the top-K score
 *      mass concentrates (inferClusterRoot). This recovers a manifest-less
 *      subproject (e.g. an embedded firmware subtree) so an out-of-cluster
 *      straggler is still demoted. The inferred subtree is written back into
 *      `rootByCandidate` for every candidate it encloses, so the rest of the
 *      pipeline treats it exactly like a marker root.
 *
 * Note: "nothing to scope against" (a single-root candidate pool, no cluster)
 * still returns a populated rootByCandidate map — callers need every
 * candidate's root regardless of whether dominance was computed.
 */
function computeDominantRoot(
  candidates: Candidate[],
  context: QueryContext,
  resolver: RootResolver,
  multiTokenFilenamePaths: ReadonlySet<string>,
  queryIdentTokens: ReadonlyArray<string>,
): DominantRootResult {
  const rootByCandidate = new Map<Candidate, string>();
  for (const c of candidates) {
    rootByCandidate.set(c, resolver.rootOf(c.path));
  }

  if (candidates.length === 0) {
    return { root: null, rootByCandidate, inScopeRoots: new Set(), multiRoot: false };
  }

  // Finalize a result: compute the two-domain in-scope set relative to the
  // chosen dominant root and return. Kept as a closure so all three exit paths
  // (scope-hint / marker-majority / cluster) apply the SAME two-domain logic
  // against WHATEVER rootByCandidate looks like at that point (the cluster path
  // mutates it first). `dominant` is the single winning root; the returned
  // inScopeRoots always contains it and, for a genuine two-domain query, one
  // additional distinct root (see decideTwoDomainRoots).
  const finalize = (dominant: string): DominantRootResult => {
    const inScopeRoots = decideTwoDomainRoots(
      candidates,
      rootByCandidate,
      dominant,
      multiTokenFilenamePaths,
      queryIdentTokens,
    );
    return { root: dominant, rootByCandidate, inScopeRoots, multiRoot: inScopeRoots.size >= 2 };
  };

  const markerRoots = new Set(rootByCandidate.values());

  // Step 1: scope-hint override — a query token naming one candidate root by
  // its own directory basename wins regardless of score (skip the workspace
  // root "", which has no meaningful basename to name).
  for (const root of markerRoots) {
    if (root === "") continue;
    const base = root.slice(root.lastIndexOf("/") + 1).toLowerCase();
    if (context.scopeHints.has(base)) return finalize(root);
  }

  // Step 1b: segment scope-hint override — the query names an ANCESTOR
  // directory of some candidate roots rather than a root's own basename
  // (e.g. query "acme steering …" while the marker roots are
  // …/acme/firmware and …/acme/tools: neither basename is "acme",
  // so Step 1 falls through and Step 2's score majority can hand the win to
  // stray identifier matches in an unrelated sibling project — the 09e
  // cross-project pack pollution).
  //
  // Deliberately derived from queryIdentTokens, NOT context.scopeHints:
  // inferQueryContext WIPES query-derived hints whenever basename matches
  // spread across >= 2 subsystem dirs — the right call for subsystem-level
  // hints (boosts/demotion exemptions), but a PROJECT-family token is
  // orthogonal to how many subsystems inside that family matched: a real
  // multi-file fix query names the family once plus several subsystems,
  // which is exactly when scoping to the family matters most.
  //
  // A hint only counts when it DISCRIMINATES: the roots it matches must be a
  // proper subset of the candidate roots (workspace root "" included in the
  // denominator), so a segment shared by every root (e.g. a monorepo's
  // "packages") never triggers an override. Score-dominance among the
  // matched roots picks the single winner.
  const rootHintTokens = new Set(queryIdentTokens.filter((t) => looksLikeProjectSegment(t)));
  const segmentHinted = [...markerRoots].filter(
    (root) =>
      root !== "" &&
      root.toLowerCase().split("/").some((seg) => rootHintTokens.has(seg)),
  );
  if (segmentHinted.length > 0 && segmentHinted.length < markerRoots.size) {
    const hintedSet = new Set(segmentHinted);
    const pool = candidates.filter((c) => hintedSet.has(rootByCandidate.get(c)!));
    const best = dominantRoot(pool, (c) => rootByCandidate.get(c)!, (c) => c.score);
    if (best !== null) return finalize(best);
  }

  // Step 2: marker-root majority when candidates span >= 2 marker roots. The
  // winner is returned even when it is the workspace root "" — that is a REAL
  // partition (the workspace-root side genuinely carries more score mass than
  // the nested marker roots), and returning "" is exactly what lets the
  // out-of-root demotion sink candidates that live in the LOSING nested roots
  // (the honest root-miss case: a strong identifier whose only match sits in a
  // nested root that did not win the vote) — BUT only when the workspace root
  // is itself a genuine project (resolver.workspaceRootIsProject). When it is
  // not, "" is just the fallback sentinel for an incidental mix of
  // manifest-less files (a scratch/ dir, a fixture/evidence dump, a held-out
  // corpus, ...) that share no real project identity with each other — it
  // must not be able to outvote a real marker root purely by accumulating
  // enough same-token spray (R4). Zeroing its weight (rather than excluding
  // those candidates outright) still lets them win on the RARE case where
  // every OTHER root also nets to <= 0, and leaves them fully eligible as
  // penalized out-of-root candidates either way.
  if (markerRoots.size > 1) {
    const weightOf: (c: Candidate) => number = resolver.workspaceRootIsProject
      ? (c) => c.score
      : (c) => (rootByCandidate.get(c) === "" ? 0 : c.score);
    const best = dominantRoot(candidates, (c) => rootByCandidate.get(c)!, weightOf);
    if (best !== null) return finalize(best);
  }

  // Step 3: cluster refinement — reached only when marker detection found NO
  // partition (every candidate resolved to the same single root, typically ""
  // because no manifests exist). Infer an effective subtree from score mass so
  // a manifest-less subproject is still scoped.
  const cluster = inferClusterRoot(
    candidates.map((c) => ({ path: c.path, score: c.score })),
  );
  if (cluster !== null) {
    // Only refine candidates whose marker root is the workspace root ""; a
    // candidate that already sits in a genuine marker root keeps it (cluster
    // inference must not override a manifest partition).
    let anyInCluster = false;
    for (const c of candidates) {
      if (rootByCandidate.get(c) !== "") continue;
      if (c.path === cluster || c.path.startsWith(cluster + "/")) {
        rootByCandidate.set(c, cluster);
        anyInCluster = true;
      }
    }
    if (anyInCluster) return finalize(cluster);
  }

  return { root: null, rootByCandidate, inScopeRoots: new Set(), multiRoot: false };
}

/**
 * DESIGN-v0.8 two-domain fix. Given the chosen `dominant` root, decide the set
 * of roots the demotion pass must leave IN-scope. Always returns at least
 * `{dominant}`. Adds ONE more root when the query is genuinely two-domain: a
 * SECOND root (!= dominant) whose STRONG candidates match a query identifier
 * token that NO strong candidate in the dominant root matches — i.e. the two
 * roots resolve to DIFFERENT identifiers, not the same one existing twice.
 *
 * Conservative by construction:
 *   - Only strong candidates (isStrongScopeCandidate) vote — text/reference
 *     spray and single-common-token filename matches never expand scope.
 *   - The second root must contribute a DISTINCT identifier token. The classic
 *     ambiguity case (one symbol name defined in two sibling projects — same
 *     token in both roots) contributes NO distinct token, so the majority vote
 *     stands and the loser is still demoted (existing behavior preserved).
 *   - At most one extra root is admitted (the strongest such runner-up by
 *     aggregate strong-candidate score), so a noisy query cannot fan the pack
 *     across every root.
 */
export function decideTwoDomainRoots(
  candidates: Candidate[],
  rootByCandidate: Map<Candidate, string>,
  dominant: string,
  multiTokenFilenamePaths: ReadonlySet<string>,
  queryIdentTokens: ReadonlyArray<string>,
): Set<string> {
  const inScope = new Set<string>([dominant]);
  if (queryIdentTokens.length === 0) return inScope;

  // Identifier tokens the dominant root's OWN strong candidates cover.
  const dominantTokens = new Set<string>();
  // Per non-dominant root: the distinct identifier tokens its strong candidates
  // cover, plus the aggregate strong-candidate score (tie-break for the runner-up).
  const otherTokens = new Map<string, Set<string>>();
  const otherScore = new Map<string, number>();

  for (const c of candidates) {
    if (!isStrongScopeCandidate(c, multiTokenFilenamePaths)) continue;
    const root = rootByCandidate.get(c)!;
    const toks = candidateIdentifierTokens(c, queryIdentTokens);
    if (toks.size === 0) continue;
    if (root === dominant) {
      for (const t of toks) dominantTokens.add(t);
    } else {
      // The workspace-root sentinel "" is the catch-all for un-rooted files,
      // NOT a distinct package/domain — never admit it as a second domain, or
      // exempting it would broadly defeat scoping (every out-of-cluster file
      // would ride in). A genuine second domain is always a named marker/
      // cluster root.
      if (root === "") continue;
      let set = otherTokens.get(root);
      if (!set) { set = new Set(); otherTokens.set(root, set); }
      for (const t of toks) set.add(t);
      otherScore.set(root, (otherScore.get(root) ?? 0) + c.score);
    }
  }

  // A candidate second root must carry a token the dominant root does NOT — a
  // genuinely different domain, not the same identifier in two places.
  let bestRoot: string | null = null;
  let bestScore = -Infinity;
  for (const [root, toks] of otherTokens) {
    const hasDistinct = [...toks].some((t) => !dominantTokens.has(t));
    if (!hasDistinct) continue;
    const score = otherScore.get(root) ?? 0;
    if (score > bestScore) {
      bestScore = score;
      bestRoot = root;
    }
  }
  if (bestRoot !== null) inScope.add(bestRoot);
  return inScope;
}

// ---------------------------------------------------------------------------
// Comment-only-match precision penalty (DESIGN-v0.8 §A4, general fix)
// ---------------------------------------------------------------------------

/**
 * Candidate kinds whose hit is a raw LINE match prone to comment/string
 * false-positives. Deliberately EXCLUDES "path-token"/"structural"/"symbol":
 * a filename-match (path-token) surfaced because the file's NAME matched, not
 * because of any line in its body, so its body being all-comments is
 * irrelevant and must not demote it; a symbol/structural hit is an
 * AST/declaration match, never a raw text false-positive.
 */
const TEXTUAL_KINDS: ReadonlySet<Candidate["kind"]> = new Set(["text", "reference"]);

/**
 * Out-of-dominant-root demotion for TEXT/REFERENCE spray and single-common-
 * token filename matches (DESIGN-v0.8 §A2): sized to drop a 1.25 single-token
 * filename match below the 0.6 weak-candidate floor. A penalty, not an
 * exclusion — root inference can guess wrong on a genuinely ambiguous query.
 */
const OUT_OF_ROOT_PENALTY = 1.0;

/**
 * Out-of-dominant-root demotion for STRONG out-of-root signals — symbol/
 * structural kinds and MULTI-token (>= 2 query token) filename matches
 * (DESIGN-v0.8 monorepo cross-package fix). Smaller than OUT_OF_ROOT_PENALTY,
 * tuned so a 1.25-baseline strong match lands ~0.70: still below any in-root
 * primary (the in-root file keeps the primary slot and identical-basename
 * sibling-project noise cannot outrank it) but above the 0.6 weak floor, so a
 * genuine cross-package contract file used by another package SURVIVES into
 * candidates/related rather than vanishing. DESIGN-v0.8 explicitly warns
 * cross-package tasks must keep working.
 */
const OUT_OF_ROOT_STRONG_PENALTY = 0.55;

/**
 * Penalty subtracted from a candidate whose query-token matches in its file
 * occur ONLY on comment/string lines. Sized to sink an incidental
 * exact-text/reference hit (Layer-3 baseline 1.2 / reference 0.5) well below
 * the weak-candidate floor, so a file that surfaced PURELY because the query
 * word appears in its prose (the canonical case: TokenLighten's OWN source,
 * whose comments mention domain words) cannot win a primary slot or skew the
 * dominant-root vote — while a genuine code-line match (even in the same file)
 * keeps its score.
 */
const COMMENT_ONLY_PENALTY = 1.3;
const COMMENT_LINE_PENALTY = 0.35;

/** Files at or above this size are skipped by the comment-only scan (fail-open — no penalty). */
const COMMENT_SCAN_MAX_FILE_BYTES = 512 * 1024;

/**
 * Demote candidates whose ONLY occurrences of the query's identifier tokens in
 * their own file are on comment/string lines. Runs BEFORE dominant-root
 * computation so a comment-only file cannot inflate a wrong root's score mass
 * (the precise failure this fixes: TL's own locateTaskContext.ts, matched via
 * an enum-ish identifier mentioned only in a comment, out-voting the real
 * subproject).
 *
 * Only raw-line-match candidates (text/reference — see TEXTUAL_KINDS) are
 * considered, and only for files with NO exempting signal: a filename match, a
 * symbol/structural hit, is an AST/name match whose relevance does not depend
 * on its comment lines. Cheap: one read + parse-free line classification per
 * DISTINCT candidate file, bounded by file size.
 */
function applyCommentOnlyPenalty(
  candidates: Candidate[],
  workspace: string,
  queryTokens: string[],
): void {
  if (queryTokens.length === 0) return;
  const tokens = queryTokens.filter((t) => t.length >= 3);
  if (tokens.length === 0) return;
  // Word-boundary matcher for the token set (longest-first is irrelevant here —
  // we only need presence per line).
  const tokenRe = new RegExp(`\\b(?:${tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`);

  // When one file has both comment and executable hits, retain the file but
  // make its executable line the representative candidate. Previously the
  // stable path collapse kept the first doc-comment occurrence, hiding the
  // real edit site even when the exact token occurred repeatedly in code.
  const textualByPath = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    if (!TEXTUAL_KINDS.has(candidate.kind)) continue;
    textualByPath.set(candidate.path, [...(textualByPath.get(candidate.path) ?? []), candidate]);
  }
  for (const [relPath, pathCandidates] of textualByPath) {
    if (pathCandidates.length < 2) continue;
    const abs = path.join(workspace, relPath);
    let raw: string;
    try {
      if (fs.statSync(abs).size > COMMENT_SCAN_MAX_FILE_BYTES) continue;
      const decoded = decodeTextBuffer(fs.readFileSync(abs));
      if (decoded === null) continue;
      raw = decoded;
    } catch {
      continue;
    }
    const commentFlags = classifyCommentLines(raw, languageForPath(relPath) ?? "default");
    const sourceLines = raw.split(/\r?\n/);
    const hasExecutable = pathCandidates.some((candidate) => !commentFlags[candidate.line - 1]);
    if (!hasExecutable) continue;
    for (const candidate of pathCandidates) {
      const sourceLine = sourceLines[candidate.line - 1] ?? "";
      const commentStart = sourceLine.indexOf("//");
      const matchingTokens = tokens.filter((token) => sourceLine.toLowerCase().includes(token.toLowerCase()));
      const inlineCommentOnly = commentStart >= 0
        && matchingTokens.length > 0
        && matchingTokens.every((token) =>
          !sourceLine.slice(0, commentStart).toLowerCase().includes(token.toLowerCase())
        );
      if (commentFlags[candidate.line - 1] || inlineCommentOnly) {
        candidate.score -= COMMENT_LINE_PENALTY;
      }
    }
  }

  // Files that ALSO have a strong non-textual signal (a filename match, a
  // symbol/structural hit) are exempt entirely — that signal is why they
  // belong, independent of what their comment lines say.
  const exemptPaths = new Set<string>();
  for (const c of candidates) {
    if (c.why === "filename-match" || !TEXTUAL_KINDS.has(c.kind)) exemptPaths.add(c.path);
  }

  // Distinct textual-candidate files that have NO exempting signal.
  const textualPaths = new Set<string>();
  for (const c of candidates) {
    if (TEXTUAL_KINDS.has(c.kind) && !exemptPaths.has(c.path)) textualPaths.add(c.path);
  }
  if (textualPaths.size === 0) return;

  const commentOnlyFiles = new Set<string>();
  for (const relPath of textualPaths) {
    const abs = path.join(workspace, relPath);
    let size: number;
    try { size = fs.statSync(abs).size; } catch { continue; }
    if (size > COMMENT_SCAN_MAX_FILE_BYTES) continue;
    let raw: string;
    try {
      const decoded = decodeTextBuffer(fs.readFileSync(abs));
      if (decoded === null) continue;
      raw = decoded;
    } catch { continue; }
    const language = languageForPath(relPath) ?? "default";
    const commentFlags = classifyCommentLines(raw, language);
    const lines = raw.split(/\r?\n/);
    const matchLines: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (tokenRe.test(lines[i]!)) matchLines.push(i + 1);
    }
    if (matchesAreCommentOnly(matchLines, commentFlags)) commentOnlyFiles.add(relPath);
  }
  if (commentOnlyFiles.size === 0) return;

  for (const c of candidates) {
    if (TEXTUAL_KINDS.has(c.kind) && commentOnlyFiles.has(c.path)) {
      c.score -= COMMENT_ONLY_PENALTY;
      c.commentOnlyPenalized = true;
    }
  }
}

// ---------------------------------------------------------------------------
// Honest root-miss suggestion (DESIGN-v0.8 §A5)
// ---------------------------------------------------------------------------

/**
 * True when a token is a "strong" identifier: a multi-char CamelCase,
 * snake_case, or ALLCAPS name (the kind of token that names a specific symbol,
 * so its total absence from every in-root candidate is real evidence the
 * caller is scoped to the wrong subtree).
 */
function isStrongIdentifierToken(token: string): boolean {
  if (token.length < 4) return false;
  if (/[a-z][A-Z]/.test(token)) return true;                 // camelCase / PascalCase hump
  if (/^[A-Z][a-zA-Z0-9]*[A-Z]/.test(token)) return true;    // PascalCase (e.g. LogRotator)
  if (/_/.test(token) && /[a-zA-Z]/.test(token)) return true; // snake_case
  if (/^[A-Z][A-Z0-9_]{3,}$/.test(token)) return true;        // ALLCAPS
  return false;
}

/**
 * When the query has strong identifier tokens and NONE of them match any
 * in-root candidate (i.e. the strongest evidence is entirely out-of-root),
 * return the strongest out-of-root cluster's common directory as a re-scope
 * suggestion; otherwise null. Never suggests when the caller already scoped
 * the call (`input.path` set) — the caller's scope is authoritative.
 */
function computeRootSuggestion(
  query: string,
  candidates: Candidate[],
  rootByCandidate: Map<Candidate, string>,
  dominantRoot: string | null,
  resolver: RootResolver,
  scope: string | undefined,
): string | undefined {
  if (scope !== undefined) return undefined;
  const strong = extractIdentifiers(query).filter(isStrongIdentifierToken);
  if (strong.length === 0) return undefined;

  const inRoot = (c: Candidate): boolean =>
    dominantRoot === null || rootByCandidate.get(c) === dominantRoot;

  // Does ANY strong token match an in-root candidate (by path or symbol)? If
  // so, the pipeline has a real in-root answer — no re-scope needed.
  const strongLower = strong.map((t) => t.toLowerCase());
  const matchesToken = (c: Candidate): boolean => {
    const hay = (c.path + " " + (c.symbol ?? "")).toLowerCase();
    return strongLower.some((t) => hay.includes(t));
  };
  const anyInRootStrong = candidates.some((c) => inRoot(c) && matchesToken(c));
  if (anyInRootStrong) return undefined;

  // Strongest out-of-root cluster: highest-scored out-of-root candidates that
  // DO match a strong token, then their common ancestor directory. Require the
  // suggestion to name a real marker root or a depth>=2 subtree so it is
  // actionable (a bare top-level dir helps nobody).
  const outStrong = candidates
    // Liveness filter: a candidate whose score+1.0 is still <= 0 was pure noise
    // even before any out-of-root demotion. Both demotion sizes are <= 1.0
    // (OUT_OF_ROOT_PENALTY / OUT_OF_ROOT_STRONG_PENALTY), so +1.0 conservatively
    // re-includes any demoted candidate that had a real pre-demotion score; the
    // post-demotion score is still used to RANK (a kind-aware -0.55 strong
    // candidate correctly sorts above a -1.0 weak one for the same base score).
    .filter((c) => !inRoot(c) && matchesToken(c) && c.score + 1.0 > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);
  if (outStrong.length === 0) return undefined;

  // Prefer the marker root the cluster sits in; else its common directory.
  const rootsHit = new Set(outStrong.map((c) => resolver.rootOf(c.path)).filter((r) => r !== ""));
  if (rootsHit.size === 1) return [...rootsHit][0];
  const common = commonAncestorDir(outStrong.map((c) => c.path));
  if (common !== "" && common.split("/").length >= 2) return common;
  return undefined;
}

// ---------------------------------------------------------------------------
// Exclusion helpers
// ---------------------------------------------------------------------------

/**
 * Belt-and-suspenders exclusion on top of the walk's own ignore rules. Every
 * candidate path reaching this point originates from a `.tokenlightenignore`-
 * aware source (walkCodeFiles honors it; the skeleton/graph indexes are built
 * with createIgnoreMatcher, which reads it too), so this now only re-applies
 * the source-only never-source exclusions (bench-runs / .tokenlighten cache /
 * coverage) that are not part of DEFAULT_IGNORE. Repo conventions (docs/,
 * reports/) are NO LONGER hard-coded here — a repo that wants them excluded
 * lists them in `.tokenlightenignore`, which the walk applies uniformly.
 */
function isExcluded(relPath: string, explicitScope?: string): boolean {
  return isSourceOnlyExcludedPath(relPath, explicitScope);
}

/**
 * Apply score penalties for test files, generated, mirrors.
 *
 * The former hard-coded `bench/`-prefix penalty is GONE (it was a
 * bench-specific proxy for "this is not the host repo"; cross-project scoping
 * is now handled generally by the marker-root / cluster demotion pass in the
 * main pipeline, which penalizes ANY out-of-dominant-root candidate — bench or
 * not). Only universal, environment-agnostic demotions remain here.
 *
 * @param opts.skipScopeHint - skip ONLY the scope-hint boost/penalty (item at
 *   the end). A direct basename match already carries the strongest
 *   "right subsystem" signal, so the scope-hint adjustment — which assumes the
 *   candidate came from repo-wide text spray and rewards/penalizes it by which
 *   directory it happens to live in — must not apply to it. Without this, a
 *   query whose only directory-segment token names one subsystem (e.g. "mode")
 *   would add +1.1 to every file in that directory and -0.25 to the genuine
 *   name-matched bug files in a sibling directory (e.g. control/), burying
 *   them. Test/generated demotions are ALWAYS kept.
 */
// 残Stage2 (2026-08-01 probe sweep F1/F2): directory-CLASS test paths decoy
// code-shaped queries — the .spec/.test suffix penalty above never covered
// __tests__/ or tests/. Generic path-shape class, no repository-specific
// names; a query that literally names such a segment is re-boosted by the
// scope-hint bonus, so explicit mention still wins.
// Two sibling penalties were tried here and REVERTED the same day:
// an archival-segment cut (bench/fixtures/evidence/…) broke §A6's
// nested/fixture-root recall guarantee, and a data-extension cut
// (csv/jsonl/log) was UNREACHABLE — every locate walk layer is source-ext
// only, so data files never become candidates at this layer at all. For
// both, the decisive decoy fix is the artifact-append gate at
// readCodeTaskPack's wire choke point, not a rank cut here.
const TEST_DIR_SEGMENT_RE = /^(?:__tests__|tests?|specs?)$/;

function applyPenalties(
  score: number,
  relPath: string,
  scope?: string,
  context?: QueryContext,
  opts?: { skipScopeHint?: boolean },
): number {
  void scope;
  let s = score;
  const baseName = relPath.slice(relPath.lastIndexOf("/") + 1);
  let isTestFile = false;
  for (let i = 0; i + 6 < baseName.length; i++) {
    const marker = baseName.slice(i, i + 6);
    if ((marker === ".spec." || marker === ".test.") && i + 6 < baseName.length) {
      isTestFile = true;
      break;
    }
  }
  if (isTestFile) s -= 0.3;
  if (relPath.includes("/dist/") || relPath.includes("/build/") || relPath.includes("/__pycache__/")) s -= 0.5;
  const lowerSegments = relPath.toLowerCase().split("/");
  if (lowerSegments.some((seg) => TEST_DIR_SEGMENT_RE.test(seg)) && !isTestFile) {
    s -= 0.3;
  }
  if (!opts?.skipScopeHint && context && context.scopeHints.size > 0) {
    const segments = relPath.toLowerCase().split("/");
    if (segments.some((seg) => context.scopeHints.has(seg))) {
      s += 1.1;
    } else if (segments.some((seg) => looksLikeProjectSegment(seg))) {
      s -= 0.25;
    }
  }
  return s;
}

// ---------------------------------------------------------------------------
// Multi-surface heuristic
// ---------------------------------------------------------------------------

/**
 * Multi-surface keyword set (lowercase). An enum/type-variant-shaped edit
 * typically fans out across a contract/definition site, its consumers, and
 * presentation code — these words name that shape. Deliberately does NOT
 * include a bare ALL-CAPS token: many queries mention an all-caps identifier
 * (a constant, a flag name, an acronym like "PID"/"CRC") without the task
 * being an enum/variant addition at all.
 */
const MULTI_SURFACE_KEYWORDS: ReadonlySet<string> = new Set([
  "enum", "priority", "status", "role",
]);

/**
 * Returns true if the query looks like a multi-surface change.
 *
 * camelCase-ROBUST (DESIGN-v0.8 §A6 fix): the old bare-word regex
 * `/\b(enum|priority|status|role)\b/i` missed the extremely common identifier
 * forms — "TicketPriority", "byFlavor", "member_role" — because a word
 * boundary does not fall inside a camelCase hump. Tokenizing the query first
 * (camelCase/snake/kebab split via tokenizeForEpoch, imported from session.ts)
 * and matching the keyword set against the token SET makes the trigger fire on
 * those forms while staying language-agnostic: Japanese task prose with
 * English identifiers ("TicketPriority に ONHOLD を追加") still tokenizes the
 * English identifier and matches. The `.includes`-based substring pass is kept
 * as a belt-and-suspenders fallback (e.g. a keyword embedded with no separator
 * the tokenizer would surface anyway) so this is a strict superset of the old
 * behavior — it can only ADD triggers, never remove one.
 */
function looksLikeMultiSurface(query: string): boolean {
  const tokens = tokenizeForEpoch(query);
  for (const t of tokens) {
    if (MULTI_SURFACE_KEYWORDS.has(t)) return true;
  }
  // Belt-and-suspenders: also catch a keyword appearing as a substring of a
  // token the tokenizer produced (e.g. "priorities" -> token "priorities"
  // contains "priority"? no — but "statuses" contains "status"). Cheap.
  for (const t of tokens) {
    for (const kw of MULTI_SURFACE_KEYWORDS) {
      if (t.includes(kw)) return true;
    }
  }
  return false;
}

/** Required surface set for multi-surface queries rooted at a given primary. */
const MULTI_SURFACE_REQUIRED: ReadonlyArray<ImpactSurface> = ["contract", "api", "ui"];

const LOCATE_SURFACE_PRIORITY: Record<string, number> = {
  contract: 0, api: 1, domain: 2, data: 3, ui: 4, style: 5, config: 6, test: 7, doc: 8, unknown: 9,
};

const SCOPE_HINT_STOP_WORDS = new Set([
  "issue", "status", "priority", "feature", "service", "client", "server",
  "shared", "common", "package", "packages", "apps", "backend", "frontend",
  "api", "web", "test", "tests", "src", "source", "update", "change", "add",
  "fix", "implement", "support", "system",
]);

function looksLikeProjectSegment(segment: string): boolean {
  return /^[a-z][a-z0-9_-]{3,}$/.test(segment) && !SCOPE_HINT_STOP_WORDS.has(segment);
}

/**
 * Immediate parent directory segment of a workspace-relative path (its
 * "subsystem"), e.g. "firmware/src/dsp/wave_shaper.cpp" -> "dsp". Empty
 * string for a top-level file.
 */
function subsystemDir(relPath: string): string {
  const segs = relPath.split("/");
  return segs.length >= 2 ? segs[segs.length - 2]!.toLowerCase() : "";
}

/**
 * Build the workspace basename-token frequency table (see QueryContext
 * doc): for every code file, split its basename into word tokens and count,
 * per distinct token, how many distinct files carry it. Also indexes the
 * full compacted basename itself (e.g. "waveshaper" for wave_shaper.hpp)
 * so whole-name matches participate in the same rarity signal as multi-word
 * tokens.
 *
 * Exported for direct unit testing alongside matchBasenameTokens.
 */
export function buildBasenameFrequency(files: FoundFile[]): Map<string, number> {
  const freq = new Map<string, number>();
  for (const f of files) {
    const base = path.basename(f.relPath, path.extname(f.relPath));
    const seen = new Set<string>(splitBasenameTokens(base));
    seen.add(base.replace(/[_\-.]/g, "").toLowerCase());
    for (const tok of seen) {
      freq.set(tok, (freq.get(tok) ?? 0) + 1);
    }
  }
  return freq;
}

function inferQueryContext(walkCache: WalkCache, query: string, scope?: string): QueryContext {
  const scopeHints = new Set<string>();
  if (scope) {
    for (const seg of scope.toLowerCase().split("/")) {
      if (looksLikeProjectSegment(seg)) scopeHints.add(seg);
    }
  }

  const allTokens = extractIdentifiers(query).map((t) => t.toLowerCase());
  const tokens = allTokens.filter((t) => t.length >= 4 && looksLikeProjectSegment(t));
  if (tokens.length === 0) {
    // No substantial scope-hint-shaped tokens, but a short/all-caps token
    // (e.g. "pll", "wave") may still need workspace-frequency data for the
    // basename-admission rarity check (Layer 5a, the single-token path). That
    // check may never run at all (e.g. a symbol-only query, or one whose
    // earlier layers already resolve unambiguously) — defer the walk +
    // frequency build to first use instead of paying for it unconditionally.
    // Memoized (not merely lazy): repeated calls return the SAME map without
    // re-walking or rebuilding, and any walk that does happen is shared via
    // walkCache with every other consumer in this locate() call.
    let cached: Map<string, number> | null = null;
    return {
      scopeHints,
      getBasenameFrequency: () => {
        if (cached === null) {
          cached = buildBasenameFrequency(walkCache.get());
        }
        return cached;
      },
    };
  }

  const tokenSet = new Set(tokens);
  // Track distinct subsystem directories that contain a STRONG basename match
  // for the query. A query that names >= 2 subsystems (e.g. "...wave
  // shaper... pulse counter... clock manager...") makes any single
  // directory-segment scope hint misleading: the scope-hint boost would then
  // reward every file in one named subsystem and penalize the genuine
  // name-matched files in the others. In that case the query-derived hints
  // are dropped (explicit input.path hints are kept). This full pass is O(files);
  // the previous early break only saved a partial scan.
  const matchedSubsystems = new Set<string>();
  const allFiles = walkCache.get();
  const basenameFrequency = buildBasenameFrequency(allFiles);
  for (const f of allFiles) {
    for (const seg of f.relPath.toLowerCase().split("/")) {
      if (tokenSet.has(seg)) scopeHints.add(seg);
    }
    if (matchBasenameTokens(f.relPath, allTokens, basenameFrequency) !== null) {
      matchedSubsystems.add(subsystemDir(f.relPath));
    }
  }

  if (matchedSubsystems.size >= 2) {
    // Multi-subsystem query — do not trust a single directory scope hint.
    // Preserve only the explicit-scope hints (re-derived from `scope`).
    const explicit = new Set<string>();
    if (scope) {
      for (const seg of scope.toLowerCase().split("/")) {
        if (looksLikeProjectSegment(seg)) explicit.add(seg);
      }
    }
    return { scopeHints: explicit, getBasenameFrequency: eagerBasenameFrequency(basenameFrequency) };
  }

  return { scopeHints, getBasenameFrequency: eagerBasenameFrequency(basenameFrequency) };
}

function isScopeOnlyTextQuery(textQuery: string, context: QueryContext): boolean {
  return context.scopeHints.has(textQuery.toLowerCase());
}

function matchesScopeHint(relPath: string, context: QueryContext): boolean {
  if (context.scopeHints.size === 0) return true;
  const segments = relPath.toLowerCase().split("/");
  return segments.some((seg) => context.scopeHints.has(seg));
}

/**
 * Required surface roles for a multi-surface query, rooted at `primarySurface`.
 *
 * DESIGN-v0.8 §A2/§A3 (coverage-honesty fix): when `inventory` is supplied
 * (the roles that structurally exist in this locate's dominant root), any
 * required role NOT present in that inventory is dropped — a firmware root
 * with no ui/style files must never be told its enum/status task is "partial"
 * for lacking a ui surface that cannot exist. `primarySurface` is ALWAYS
 * kept regardless of inventory (it is, by definition, a role this task's own
 * best candidate already occupies). Passing `undefined` inventory preserves
 * the pre-fix behavior (require all of MULTI_SURFACE_REQUIRED unconditionally)
 * for any caller that has no file list to build one from.
 */
function requiredSurfacesForQuery(
  query: string,
  primarySurface: ImpactSurface,
  inventory?: ReadonlySet<ImpactSurface>,
): ImpactSurface[] {
  const required = new Set<ImpactSurface>([...MULTI_SURFACE_REQUIRED, primarySurface]);
  if (/\b(priority|status|enum|role)\b/i.test(query)) {
    required.add("style");
  }
  if (/\b(test|spec|coverage)\b/i.test(query)) {
    required.add("test");
  }
  if (inventory !== undefined) {
    for (const role of [...required]) {
      // primarySurface is exempt: it is the task's own answer, not an
      // inferred cross-surface requirement, so it stays even in the (rare)
      // case its own files somehow did not register in the inventory pass.
      if (role !== primarySurface && !inventory.has(role)) required.delete(role);
    }
  }
  return [...required];
}

/**
 * Generic structural regexes for "enum/variant family" declarations: a
 * language enum keyword, or an exhaustive value-list initializer (a
 * transition/lookup table keyed by the same family). These match on SHAPE
 * (the declaration syntax across languages) and generic English vocabulary
 * shared with the query, never on a specific project's symbol names — so
 * they generalize to any codebase instead of only matching one benchmark
 * fixture's exact identifiers (a project-specific enum name, transition
 * table, or health-check method).
 */
function queryStructuralPatterns(query: string): Array<{ pattern: RegExp; why: string; score: number }> {
  const patterns: Array<{ pattern: RegExp; why: string; score: number }> = [];

  if (/\benum\b|\bpriority\b|\bstatus\b|\brole\b|\blifecycle\b/i.test(query)) {
    // Language enum declarations across TS/JS, Python, Java/Kotlin, C/C++,
    // Rust, Go const-iota blocks — a generic cross-language declaration
    // shape, not a project-specific symbol name.
    patterns.push({
      pattern: /\benum\s+(class\s+)?[A-Za-z_]\w*|\bclass\s+[A-Za-z_]\w*\s*\(\s*Enum\s*\)|@(unique\s+)?enum\.(Enum|IntEnum|StrEnum)\b/,
      why: "enum-family",
      score: 0.75,
    });
  }

  if (/\btransition\b|\blifecycle\b|\bstate\b/i.test(query)) {
    // Exhaustive transition/lookup table: an identifier containing
    // "transition" used as a declaration name, or a validity-check
    // function name — again a generic naming/shape pattern, not a literal
    // project symbol.
    patterns.push({
      pattern: /\b\w*[Tt]ransitions?\w*\s*[:=]|\bis\w*[Vv]alid\w*[Tt]ransition\w*\b|\bcan[A-Z]\w*[Tt]ransition\w*\b/,
      why: "enum-family",
      score: 0.8,
    });
  }

  return patterns;
}

function addCandidateOnce(candidates: Candidate[], candidate: Candidate): void {
  if (candidates.some((c) => c.path === candidate.path && c.line === candidate.line && c.why === candidate.why)) {
    return;
  }
  candidates.push(candidate);
}

/**
 * Large Markdown contract/spec files above this size are excluded from
 * walkCodeFiles by default (not a "code" extension), so they were
 * previously undiscoverable by the locator at all — an agent working
 * against a project with a big CONTRACT.md/SPEC.md had no way to reach it
 * through task_pack and fell back to reading the whole file natively. This
 * threshold marks a markdown file as worth candidate-scanning at all
 * (small docs are cheap to read whole and do not need this pass).
 */
const MARKDOWN_CONTRACT_MIN_BYTES = 4096;

/**
 * Scan markdown files for query-term matches and add them as low-cost
 * "doc" candidates. Generic: matches purely on how many of the query's own
 * extracted identifier tokens occur in the file, with no project-specific
 * filename allowlist (works for CONTRACT.md, SPEC.md, README.md, or any
 * other large doc).
 *
 * Rather than pointing at the FIRST line anywhere that matches a term
 * (which is often the document title — nearly every section of a
 * CONTRACT.md contains the word "contract" somewhere in its own prose),
 * this buckets all matched lines by their GOVERNING heading (the nearest
 * heading at/above each line) and picks the heading whose section has the
 * most distinct term hits — i.e. the section that is actually ABOUT the
 * query, not merely a section that happens to mention one shared word.
 */
/**
 * Locate TL's own managed-instructions sentinel block
 * (`<!-- tokenlighten:mcp-instructions:start -->` … `...:end -->`) by
 * 0-based line index, if present. Reuses the canonical sentinel strings
 * from @tokenlighten/agents-md (the package that owns injecting/rewriting
 * this exact block into AGENTS.md/CLAUDE.md and the per-client stub
 * mirrors) rather than re-deriving them, so a future sentinel-format change
 * cannot silently desync the two packages.
 *
 * Fails open (returns null, i.e. "no block found") on an unterminated start
 * sentinel — a malformed doc is not this scan's problem to diagnose; it
 * should keep scanning the file as plain prose rather than guess a range.
 */
function findManagedBlockLineRange(lines: readonly string[]): { start: number; end: number } | null {
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.includes(SENTINEL_START)) { start = i; break; }
  }
  if (start < 0) return null;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i]!.includes(SENTINEL_END)) return { start, end: i };
  }
  return null;
}

function addMarkdownContractCandidates(
  _workspace: string,
  input: LocateInput,
  candidates: Candidate[],
  scope: string | undefined,
  context: QueryContext,
  walkCache: WalkCache,
): void {
  const terms = extractIdentifiers(input.query)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= 3);
  if (terms.length === 0) return;

  const files = walkCache.get({
    extraExts: [".md", ".markdown"],
    ...(input.path ? { subPath: input.path } : {}),
  }).filter((f) => isMarkdownPath(f.relPath));

  for (const f of files) {
    if (isExcluded(f.relPath, scope)) continue;
    let raw: string;
    try {
      const decoded = decodeTextBuffer(fs.readFileSync(f.absPath));
      if (decoded === null) continue;
      raw = decoded;
    } catch { continue; }
    if (Buffer.byteLength(raw, "utf8") < MARKDOWN_CONTRACT_MIN_BYTES) continue;

    const lines = raw.split(/\r?\n/);
    const lowerLines = lines.map((l) => l.toLowerCase());
    const headings = parseMarkdownHeadings(raw);
    if (headings.length === 0) continue;

    // Issue #4 (2026-08-21): TL's own managed guide block is dense with
    // ordinary code-ish words ("server", "always", "edit", "handle", ...)
    // because it IS a protocol description — so almost any two-word query
    // shares enough vocabulary with it to win this scan's ">= 2 distinct
    // terms" admission rule. That text is never task evidence: it is TL's
    // own operating instructions, already delivered to the host verbatim
    // (AGENTS.md/CLAUDE.md injection at session start, or read directly by
    // an agent that opens one of the per-client stub mirrors). Exclude the
    // sentinel-delimited block's own lines from the term-hit scan entirely
    // — for a stub file whose content IS only the block (.clinerules/,
    // .cursor/rules/, .continue/rules/, .github/copilot-instructions.md)
    // this naturally leaves zero hits and the file mints no candidate at
    // all; for AGENTS.md itself, its own non-block prose (repo table,
    // conventions, …) remains eligible exactly as before.
    const managedBlock = findManagedBlockLineRange(lines);

    // governingHeadingLine[i] = 1-based line number of the nearest heading
    // at/above line i (0 if none yet — e.g. before the first heading).
    const governingHeadingLine: number[] = new Array(lines.length).fill(0);
    let currentHeading = 0;
    let headingIndex = 0;
    for (let i = 0; i < lines.length; i++) {
      while (headingIndex < headings.length && headings[headingIndex]!.line <= i + 1) {
        currentHeading = headings[headingIndex]!.line;
        headingIndex += 1;
      }
      governingHeadingLine[i] = currentHeading;
    }

    // Bucket distinct term hits per governing heading.
    const hitsByHeading = new Map<number, Set<string>>();
    for (let i = 0; i < lines.length; i++) {
      if (managedBlock && i >= managedBlock.start && i <= managedBlock.end) continue;
      const heading = governingHeadingLine[i];
      if (heading === 0) continue; // no enclosing section yet
      const lower = lowerLines[i]!;
      for (const term of terms) {
        if (lower.includes(term)) {
          let set = hitsByHeading.get(heading);
          if (!set) { set = new Set(); hitsByHeading.set(heading, set); }
          set.add(term);
        }
      }
    }
    if (hitsByHeading.size === 0) continue;

    // Pick the heading with the most distinct term hits (ties broken by
    // earliest heading, for determinism).
    let bestHeading = 0;
    let bestCount = 0;
    for (const [heading, hits] of hitsByHeading) {
      if (hits.size > bestCount || (hits.size === bestCount && heading < bestHeading)) {
        bestHeading = heading;
        bestCount = hits.size;
      }
    }

    // Require at least 2 distinct query terms to hit within one section
    // (or a single very distinctive long token) — avoids surfacing every
    // doc that happens to share one common word with the query.
    const bestHits = hitsByHeading.get(bestHeading)!;
    const distinctiveHit = terms.some((t) => t.length >= 8 && bestHits.has(t));
    if (bestCount < 2 && !distinctiveHit) continue;

    addCandidateOnce(candidates, {
      path: f.relPath,
      line: bestHeading,
      kind: "text",
      score: applyPenalties(0.55 + 0.06 * bestCount, f.relPath, scope, context),
      why: "doc-contract-match",
    });
  }
}

/** True when the workspace has at least one style-sheet file (css/scss/less). */
function workspaceHasStyleFiles(walkCache: WalkCache): boolean {
  const files = walkCache.get({ extraExts: [".css", ".scss", ".less"] });
  return files.some((f) => f.ext === ".css" || f.ext === ".scss" || f.ext === ".less");
}

function addStructuralCandidates(
  _workspace: string,
  input: LocateInput,
  candidates: Candidate[],
  scope: string | undefined,
  context: QueryContext,
  walkCache: WalkCache,
): void {
  const patterns = queryStructuralPatterns(input.query);
  if (patterns.length > 0) {
    const files = walkCache.get({
      ...(input.lang ? { lang: input.lang } : {}),
      ...(input.path ? { subPath: input.path } : {}),
    });

    for (const f of files) {
      let raw: string;
      try {
        const decoded = decodeTextBuffer(fs.readFileSync(f.absPath));
        if (decoded === null) continue;
        raw = decoded;
      } catch { continue; }
      const lines = raw.split(/\r?\n/);
      for (const p of patterns) {
        let lineNo = 0;
        for (let i = 0; i < lines.length; i++) {
          if (p.pattern.test(lines[i]!)) {
            lineNo = i + 1;
            break;
          }
        }
        if (lineNo === 0) continue;
        addCandidateOnce(candidates, {
          path: f.relPath,
          line: lineNo,
          kind: "structural",
          score: applyPenalties(p.score, f.relPath, scope, context),
          why: p.why,
        });
      }
    }
  }

  // Presentation/style-family scan: only meaningful when the workspace
  // actually has a style tree (CSS/SCSS/LESS) — never guess CSS variable
  // names for a repo with no stylesheets at all (e.g. embedded firmware).
  // Stems are derived generically from the query's own all-caps/enum-like
  // tokens via deriveTokenVariants, not a hard-coded domain vocabulary.
  if (looksLikeMultiSurface(input.query) && workspaceHasStyleFiles(walkCache)) {
    const enumTokens = (input.query.match(/\b[A-Z][A-Z0-9_]{1,}\b/g) ?? []);
    const stems = new Set<string>();
    for (const tok of enumTokens) {
      for (const v of deriveTokenVariants(tok)) {
        if (v.startsWith("--") || v.startsWith("-")) stems.add(v);
      }
    }
    if (stems.size > 0) {
      // B1a (2026-08-01 retrieval-scope): a presentation-family hit is a ROLE
      // match, not a query match — confine it to the subtrees the direct hits
      // already anchor, so a sibling project's stylesheet can never enter a
      // pack whose query has nothing to do with that project.
      const familyScope = roleSearchScopePrefixes(familyScanAnchorPaths(candidates));
      scanStyleFiles(walkCache.get({ extraExts: STYLE_EXTRA_EXTS }), [...stems], (relPath, lineNo) => {
        if (isExcluded(relPath, scope)) return;
        if (!isWithinRoleSearchScope(relPath, familyScope)) return;
        addCandidateOnce(candidates, {
          path: relPath,
          line: lineNo,
          kind: "structural",
          score: applyPenalties(0.9, relPath, scope, context),
          why: "presentation-family",
        });
      });
    }
  }
}

/**
 * Line window a CODE file's sibling-enumeration site (an initializer / switch /
 * lookup table listing the existing family members) must fit inside for
 * addSiblingValueStructuralCandidates's code scan (DESIGN-v0.8 §A6 sibling-
 * member recall for CODE files). A single enum's members almost always appear
 * within a compact block; ~40 lines comfortably covers a Record<> zero-init
 * map, a switch over every member, or a member array, without letting two
 * unrelated members far apart in a big file coincidentally co-admit.
 */
const SIBLING_ENUM_WINDOW_LINES = 40;

/** Step for the sibling-enumeration sliding window (overlap so a site straddling a block boundary is still fully covered by one window). */
const SIBLING_ENUM_WINDOW_STEP_LINES = 20;

/** Max emitted code sibling-enumeration candidates per locate call (bound the pool). */
const SIBLING_ENUM_MAX_CANDIDATES = 8;

/**
 * Admission-quality bar for force-admitting a sibling-enumeration / exhaustive-
 * initializer site as REQUIRED (F2). A window/site qualifies only when its
 * matched DISTINCT members cover at least this fraction of the family's N
 * members: `max(2, ceil(N/2))`. This separates a genuine exhaustive site (the
 * live enum-task fixture's aggregation map lists 5/5 of the family's members
 * → 5 ≥ 3 → in) from an unrelated decoy that merely reuses two generic
 * member names (a
 * `{ LOW, HIGH, DEFAULT }` backoff map → 2/5 < 3 → out). It is deliberately
 * language-agnostic — a member-count ratio, never an English member-name list.
 *
 * A site with ≥2 distinct matches BELOW the bar is not discarded: it is still
 * admitted as a NON-required related candidate at a reduced score (see
 * PARTIAL_SIBLING_SCORE / WHY_PARTIAL_SIBLING) so genuine partial context is
 * not lost, but it never becomes `required:true` and never spawns a per-site
 * closure obligation (its `why` avoids isPerSiteCheckSurface's markers).
 */
function siblingCoverageBar(familySize: number): number {
  return Math.max(2, Math.ceil(familySize / 2));
}

/**
 * `why` marker for a sibling-enumeration / initializer site that matched ≥2
 * distinct members but fell BELOW siblingCoverageBar (F2). Chosen so its
 * whySummary output contains NONE of isPerSiteCheckSurface's trigger substrings
 * (`sibling`, `initializer`, `aggregation`, `enumerat`, `family`) — a
 * below-bar site must not generate a per-site closure check.
 */
const WHY_PARTIAL_SIBLING = "related-member-hit";

/**
 * Reduced score for a below-bar sibling/initializer candidate. Below the
 * Layer-3 exact-text baseline (1.2) so a genuine keyword/symbol hit always
 * outranks an incidental partial member overlap, but positive so real partial
 * context still surfaces as a related (non-required) candidate.
 */
const PARTIAL_SIBLING_SCORE = 0.7;

/** Files at/above this size are skipped by the sibling-enumeration code scan (fail-open). */
const SIBLING_ENUM_SCAN_MAX_FILE_BYTES = 256 * 1024;

/**
 * Extract ALL-CAPS-like member tokens (e.g. enum/object-literal keys such
 * as LOW, MEDIUM, HIGH, URGENT) from a contract-classified candidate's own
 * source text, then use those SIBLING values — not the query's own
 * vocabulary — to find the same family across BOTH presentation (CSS/BEM) and
 * CODE (initializer/enumeration) sites.
 *
 * This generalizes the "find the sites for this enum family" signal without
 * hard-coding any domain word: when a task adds a brand-new value (e.g.
 * "CRITICAL") to an existing enum, the new value itself never appears anywhere
 * yet, but its siblings (LOW/MEDIUM/HIGH/...) already do — reading them
 * straight from the located enum definition is the generic substitute for
 * guessing a project-specific prefix like "priority".
 *
 * DESIGN-v0.8 §A6 sibling-member recall for CODE files: this function's own
 * former comment admitted "sibling-member expansion only ever scanned style
 * files", so an enum-extension task MISSED the CODE files that enumerate the
 * existing members (the canonical shape: a Record/map/switch initializer
 * listing NONE/LOW/MEDIUM/HIGH/URGENT). It now ALSO scans code files: a code
 * file containing >= 2 DISTINCT existing sibling members within a ~40-line
 * window (an initializer/enumeration site) is admitted as a structural
 * candidate (why="sibling-enumeration", score comparable to the style path's
 * 1.3). The style scan still runs when the workspace has stylesheets; the code
 * scan runs regardless (an aggregation site is a code file, present even in a
 * repo with no CSS at all — e.g. embedded firmware).
 *
 * Gate (DESIGN-v0.8 §A6 structural fallback): this runs when the query looks
 * multi-surface (camelCase-robust looksLikeMultiSurface) OR — even if the
 * keyword gate did not fire — when a contract candidate's file actually yields
 * >= 2 ALL_CAPS siblings (a real enum family exists among the located
 * contracts). The latter keeps the trigger language-agnostic: a query in any
 * natural language whose only enum evidence is the located contract file still
 * fans out to the family's other sites.
 */
function addSiblingValueStructuralCandidates(
  workspace: string,
  input: LocateInput,
  candidates: Candidate[],
  scope: string | undefined,
  context: QueryContext,
  walkCache: WalkCache,
): void {
  // R9 (2026-08-21): a "contract" classification alone is not enough to seed
  // a scan that force-admits OTHER files as REQUIRED — the seed itself must
  // be reachable through a TARGETED match (an actual symbol/name lookup),
  // not merely a generic full-text substring hit. Layer 3's plain
  // `exact-text` search finds an unrelated benchmark fixture's own
  // same-named contract file (e.g. an "errors" module in a project this
  // query never mentions) just as readily as the real one; a `query-symbol`
  // (or stronger) hit for the SAME path means the query actually named one
  // of this file's own declared symbols, which a coincidental substring
  // cannot fake.
  const pathsWithTargetedMatch = new Set(
    candidates
      .filter((c) => !SIBLING_SEED_WEAK_WHY.has(c.why))
      .map((c) => c.path),
  );
  const contractPaths = new Set(
    candidates
      .filter((c) =>
        pathsWithTargetedMatch.has(c.path) && classifySurface(c.path, c.symbol) === "contract"
      )
      .map((c) => c.path),
  );
  if (contractPaths.size === 0) return;

  // Extract the family's existing ALL_CAPS sibling members from the located
  // contract file(s). Reuses extractMemberIdentifiers (the same generic
  // `IDENTIFIER:` / `IDENTIFIER =` key-shape regex) so TS const maps, TS/Java/
  // C++ enum members, and Python Enum bodies all yield members alike.
  const siblingTokens = new Set<string>();
  for (const relPath of contractPaths) {
    let raw: string;
    try {
      const decoded = decodeTextBuffer(fs.readFileSync(path.join(workspace, relPath)));
      if (decoded === null) continue;
      raw = decoded;
    } catch { continue; }
    for (const m of extractMemberIdentifiers(raw)) siblingTokens.add(m);
  }
  // >= 2 ALL_CAPS siblings from a located contract IS the gate (the structural
  // fallback per DESIGN-v0.8 §A6): a real enum family exists to enumerate. This
  // deliberately SUBSUMES the old `looksLikeMultiSurface` keyword gate — having
  // the family members in hand is a stronger, language-agnostic signal than the
  // English keyword, so a query in any natural language (Japanese task prose
  // with English identifiers) whose only enum evidence is the located contract
  // still fans out. Fewer than 2 siblings means no family to enumerate.
  if (siblingTokens.size < 2) return;

  // Family-scan anchor scope (shared by both scans below): confines the
  // presentation and code-file scans to the root(s) the located contract
  // candidate(s) actually live in. Without this, >= 2 generic member names
  // (e.g. a benchmark fixture's own unrelated enum) co-occurring anywhere
  // else in the workspace walk force-admit that file as REQUIRED regardless
  // of project boundary (R9, 2026-08-21).
  const siblingScanScope = roleSearchScopePrefixes(familyScanAnchorPaths(candidates));

  // ---- Presentation/style scan (only when the workspace has stylesheets) ----
  if (workspaceHasStyleFiles(walkCache)) {
    // Stems grouped BY MEMBER (not pooled) so admission requires the file to
    // match >= 2 DISTINCT members of the family. A single generic stem is an
    // easy substring coincidence — "--low" matches an unrelated
    // "--low-contrast-border" custom property — and one member alone is not
    // evidence that a stylesheet carries THIS family's declarations. Two or
    // more distinct members' stems co-occurring is the style-file analogue of
    // the exhaustive-initializer scan's co-occurrence gate (a stylesheet
    // cannot corroborate by importing the enum type). Not routed through the
    // pooled-stem scanStyleFiles helper, which admits on any single hit.
    const memberStems = new Map<string, string[]>();
    for (const tok of siblingTokens) {
      const stems = deriveTokenVariants(tok).filter((v) => v.startsWith("-"));
      if (stems.length > 0) memberStems.set(tok, stems);
    }
    if (memberStems.size >= 2) {
      // B1a (2026-08-01 retrieval-scope): a sibling-member stylesheet hit is a
      // ROLE match ("this file styles that token family"), never a query match,
      // so the DIRECT hits own its scope — otherwise an unrelated sibling
      // project's design-token file, which names the same generic member words,
      // is admitted on equal footing with the anchored one (T09).
      for (const f of walkCache.get({ extraExts: STYLE_EXTRA_EXTS })) {
        if (!STYLE_EXTS.has(f.ext)) continue;
        if (isExcluded(f.relPath, scope)) continue;
        if (!isWithinRoleSearchScope(f.relPath, siblingScanScope)) continue;
        let raw: string;
        try {
          const decoded = decodeTextBuffer(fs.readFileSync(f.absPath));
          if (decoded === null) continue;
          raw = decoded;
        } catch { continue; }
        const lines = raw.split(/\r?\n/);
        let distinctMembers = 0;
        let firstLine = 0;
        for (const stems of memberStems.values()) {
          const idx = lines.findIndex((line) => stems.some((s) => line.includes(s)));
          if (idx === -1) continue;
          distinctMembers++;
          if (firstLine === 0 || idx + 1 < firstLine) firstLine = idx + 1;
        }
        if (distinctMembers < 2) continue;
        addCandidateOnce(candidates, {
          path: f.relPath,
          line: firstLine,
          kind: "structural",
          // Scored above the Layer-3 exact-text baseline (1.2): a sibling-value
          // hit is a precise, structural match (actual enum members appear as
          // CSS/BEM tokens in this file) versus an incidental substring match
          // (e.g. a project/package name appearing in nearly every file's own
          // import statements, which otherwise crowds out the one style file
          // that genuinely needs the closure edit).
          score: applyPenalties(1.3, f.relPath, scope, context),
          why: "presentation-family",
        });
      }
    }
  }

  // ---- CODE-file sibling-enumeration scan (DESIGN-v0.8 §A6, new). -----------
  // A code file that enumerates >= 2 DISTINCT existing siblings within a
  // ~40-line window is an initializer/enumeration site the family's extension
  // needs updated. Word-boundary matched (so "LOW" does not match "BELOW") and
  // bounded by file size, walk membership, and an emitted-candidate cap.
  const memberAlternation = [...siblingTokens]
    .sort((a, b) => b.length - a.length) // longest-first so no member shadows a shorter prefix
    .map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const memberRe = new RegExp(`\\b(${memberAlternation})\\b`, "g");

  const codeFiles = walkCache.get({
    ...(input.lang ? { lang: input.lang } : {}),
    ...(input.path ? { subPath: input.path } : {}),
  });
  let emitted = 0;
  for (const f of codeFiles) {
    if (emitted >= SIBLING_ENUM_MAX_CANDIDATES) break;
    if (isExcluded(f.relPath, scope)) continue;
    if (!isWithinRoleSearchScope(f.relPath, siblingScanScope)) continue;
    // Skip the contract file(s) the members were extracted from — the family
    // definition is not itself the "other site" this scan is for (and it is
    // already a candidate). A DIFFERENT contract file that also lists the
    // members is still fair game.
    if (contractPaths.has(f.relPath)) continue;
    let size: number;
    try { size = fs.statSync(f.absPath).size; } catch { continue; }
    if (size > SIBLING_ENUM_SCAN_MAX_FILE_BYTES) continue;
    let raw: string;
    try {
      const decoded = decodeTextBuffer(fs.readFileSync(f.absPath));
      if (decoded === null) continue;
      raw = decoded;
    } catch { continue; }
    const lines = raw.split(/\r?\n/);

    // Sliding ~40-line window (step 20 → overlapping, so a site straddling a
    // block boundary is fully contained in at least one window). Track the
    // BEST window: the one whose distinct-member count is highest (F2 — the
    // coverage bar needs the max distinct members any single window covers,
    // not merely the first window that reaches 2). Stop early once a window
    // already meets the bar (nothing wider can raise the admission verdict).
    const bar = siblingCoverageBar(siblingTokens.size);
    let matchedLine = 0;
    let bestDistinct = 0;
    outer:
    for (let start = 0; start < lines.length; start += SIBLING_ENUM_WINDOW_STEP_LINES) {
      const end = Math.min(lines.length, start + SIBLING_ENUM_WINDOW_LINES);
      const windowText = lines.slice(start, end).join("\n");
      memberRe.lastIndex = 0;
      const distinct = new Set<string>();
      let m: RegExpExecArray | null;
      while ((m = memberRe.exec(windowText)) !== null) distinct.add(m[1]!);
      if (distinct.size >= 2 && distinct.size > bestDistinct) {
        bestDistinct = distinct.size;
        matchedLine = start + 1;
        if (bestDistinct >= bar) break outer;
      }
    }
    if (matchedLine === 0) continue;

    // F2 admission-quality gate: only a window covering ≥ bar distinct members
    // is force-admitted as REQUIRED with the enumeration `why`. A below-bar hit
    // (≥2 but < bar) is still admitted, but as a NON-required related candidate
    // at a reduced score with a `why` that spawns no per-site closure check.
    const meetsBar = bestDistinct >= bar;
    addCandidateOnce(candidates, {
      path: f.relPath,
      line: matchedLine,
      endLine: Math.min(lines.length, matchedLine + SIBLING_ENUM_WINDOW_LINES),
      kind: "structural",
      // Comparable to the style path's 1.3 (a precise, structural, multi-member
      // co-occurrence match) when the bar is met; a reduced score otherwise.
      score: applyPenalties(meetsBar ? 1.3 : PARTIAL_SIBLING_SCORE, f.relPath, scope, context),
      why: meetsBar ? "sibling-enumeration" : WHY_PARTIAL_SIBLING,
      // Force-admit as required ONLY when the coverage bar is met: an
      // initializer/enumeration site that lists most of the family is exactly
      // the kind of surface both arms of an enum-extension edit need updated.
      ...(meetsBar ? { required: true } : {}),
    });
    emitted++;
  }
}

// ---------------------------------------------------------------------------
// DESIGN-v0.8 §A6: exhaustive-initializer recall for enum-extension tasks
// ---------------------------------------------------------------------------

/** Tree-sitter symbol kinds that can hold an enum/variant's member list. */
const ENUM_MEMBER_HOLDER_KINDS: ReadonlySet<CollectedSymbol["kind"]> = new Set(["enum", "const"]);

/** Generic object-literal / enum-member key shape (see addSiblingValueStructuralCandidates). */
const MEMBER_KEY_RE = /\b([A-Z][A-Z0-9_]{1,})\s*[:=]/g;

/**
 * Extract ALL-CAPS-like member identifiers from `text` (a whole file or a
 * symbol-range slice of one) — the same generic key-shape regex
 * addSiblingValueStructuralCandidates already uses (`IDENTIFIER:` /
 * `IDENTIFIER =`), factored out so it can run against a NARROWER slice (the
 * enum/const declaration's own line range) instead of always the whole file.
 */
function extractMemberIdentifiers(text: string, cap = 24): Set<string> {
  const members = new Set<string>();
  let m: RegExpExecArray | null;
  MEMBER_KEY_RE.lastIndex = 0;
  while ((m = MEMBER_KEY_RE.exec(text)) !== null) {
    members.add(m[1]!);
    if (members.size >= cap) break;
  }
  return members;
}

/**
 * Resolve the enum/const declaration's own [startLine, endLine] for
 * `relPath` via collectSymbols (tree-sitter; same utility
 * widenNativeCandidateRange/widenNativeSymbolRange already use elsewhere in
 * this codebase) and return the member identifiers found strictly WITHIN
 * that range. Falls back to null (caller then scans the whole file, same as
 * addSiblingValueStructuralCandidates's existing behavior) when the file
 * can't be parsed or no enum/const symbol is found — recall is never worse
 * than before this function existed.
 *
 * Scoped extraction (rather than always the whole file) matters because a
 * large contract file can define several unrelated ALL-CAPS constant
 * families; narrowing to the actual enum/const's own line range keeps the
 * member set precise to the ONE family the query is about.
 *
 * Both `kind: "enum"` (a language `enum` keyword — Java/Kotlin/Rust/C++) and
 * `kind: "const"` are checked: many TypeScript codebases (including this
 * repo's own bench fixtures) express an "enum" as `export const X = {...}
 * as const` plus a derived type alias rather than the `enum` keyword, which
 * collectSymbols classifies as a `const` declaration, not `enum` — a filter
 * that only accepted `kind === "enum"` would silently miss that
 * (extremely common) shape entirely.
 */
async function extractEnumMembersFromSymbolRange(
  workspace: string,
  relPath: string,
): Promise<Set<string> | null> {
  let text: string;
  try {
    const decoded = decodeTextBuffer(fs.readFileSync(path.join(workspace, relPath)));
    if (decoded === null) return null;
    text = decoded;
  } catch {
    return null;
  }

  // .h is dual-listed c/cpp in the MCP contract — sniff text (read above) so
  // a C++-shaped header resolves to "cpp" instead of the static "c" answer,
  // picking the right tree-sitter grammar via collectSymbols below.
  const lang = languageForPathWithContent(relPath, text);
  if (!lang) return null;

  let symbols: Awaited<ReturnType<typeof collectSymbols>>;
  try {
    symbols = await collectSymbols(text, lang, {});
  } catch {
    return null;
  }

  const lines = text.split(/\r?\n/);
  let best: Set<string> | null = null;
  let bestSpan = Infinity;
  for (const s of symbols) {
    if (!ENUM_MEMBER_HOLDER_KINDS.has(s.kind)) continue;
    const span = s.endLine - s.startLine;
    const slice = lines.slice(s.startLine - 1, s.endLine).join("\n");
    const members = extractMemberIdentifiers(slice);
    // A declaration with >= 2 distinct members is a genuine enum/variant
    // family candidate; prefer the SMALLEST such declaration (innermost /
    // most specific — mirrors widenNativeSymbolRange's innermost-symbol
    // preference) so a big file with several const objects picks the one
    // that actually holds the family, not whichever the AST happened to
    // walk to first.
    if (members.size >= 2 && span < bestSpan) {
      best = members;
      bestSpan = span;
    }
  }
  return best;
}

/**
 * Build the ~8-line-window regex windows that co-occurring sibling members
 * (or a `Record<EnumName` annotation) must appear inside. Exported at
 * module scope (not inlined per-call) so the two admission conditions below
 * share one window-slicing pass per file.
 */
const INITIALIZER_WINDOW_LINES = 8;

/**
 * DESIGN-v0.8 §A6 deliverable 3 (A6 fix): step size for the sliding window
 * used by addSiblingValueInitializerCandidates. The original implementation
 * advanced by a full INITIALIZER_WINDOW_LINES (non-overlapping blocks), which
 * MISSES an exhaustive-initializer match whose members straddle a block
 * boundary (e.g. the 2 distinct sibling members needed for admission split
 * across the last line of one 8-line block and the first line of the next —
 * neither block alone contains both). A smaller step than the window makes
 * the windows overlap, so any 8-consecutive-line span is fully covered by at
 * least one window start position.
 */
const INITIALIZER_WINDOW_STEP_LINES = 4;

/**
 * Byte ceiling (DESIGN-v0.8 §A6 fix, efficiency): addSiblingValueInitializerCandidates
 * previously read the FULL content of every code file in the workspace with
 * no size cap at all on every enum-like query — a single huge generated/
 * vendored file (which the walk otherwise passes through as ordinary "code")
 * could dominate the scan's I/O cost for no benefit, since an exhaustive
 * initializer/aggregation map is, by nature, a small, hand-written
 * declaration. Files above this ceiling are skipped outright (never read),
 * same fail-open contract as every other best-effort scan in this file: a
 * skipped huge file simply does not contribute a candidate, it does not
 * error the whole locate() call.
 */
const INITIALIZER_SCAN_MAX_FILE_BYTES = 256 * 1024;

/**
 * DESIGN-v0.8 §A6 deliverable 1: generalizes
 * addSiblingValueStructuralCandidates beyond style files. For an
 * `isEnumLikeQuery` query, once a contract/enum candidate has resolved,
 * extract that enum/const's own MEMBER identifiers (scoped to its symbol
 * range — see extractEnumMembersFromSymbolRange — falling back to a
 * whole-file scan when no symbol range resolves, matching
 * addSiblingValueStructuralCandidates's existing fallback shape) and search
 * every CODE file (not just style files) for an "exhaustive initializer" —
 * an aggregation/zero-init map that enumerates the family — via an ~8-line
 * window containing either:
 *   (a) >= 2 DISTINCT sibling members in object-KEY position
 *       (`\b(MEMBER_A|MEMBER_B|...)\s*:`), or
 *   (b) a `Record<EnumName` type annotation.
 *
 * This is exactly the live enum-task fixture shape: an aggregation service's
 * per-member zero-init map (an object literal listing every member of the
 * family as a key, later cast `as Record<TheEnum, number>`) never appeared in
 * the pack because sibling-member expansion only ever scanned style
 * files — an enum-extension task needs the AGGREGATION site updated too,
 * not just the contract and presentation layers.
 *
 * Matches are admitted as REQUIRED (Candidate.required=true, see its doc)
 * with why="exhaustive-initializer" and score 1.4 — above the Layer-3
 * exact-text baseline (1.2) since this is a precise, structural, multi-
 * member co-occurrence match, but still below an exact-symbol/filename-
 * match hit.
 *
 * The >= 2 distinct-member requirement (both for extracting the family AND
 * for the object-key co-occurrence condition) is deliberate: a single
 * member name appearing once in an unrelated file is coincidental text
 * overlap, not evidence of an exhaustive initializer — see
 * locateTaskContext.spec.ts's "single member alone does NOT admit" test.
 */
async function addSiblingValueInitializerCandidates(
  workspace: string,
  input: LocateInput,
  candidates: Candidate[],
  scope: string | undefined,
  context: QueryContext,
  walkCache: WalkCache,
): Promise<void> {
  if (!isEnumLikeQuery(input.query)) return;

  const contractPaths = [
    ...new Set(
      candidates
        .filter((c) => classifySurface(c.path, c.symbol) === "contract")
        .map((c) => c.path),
    ),
  ];
  if (contractPaths.length === 0) return;

  // Resolve the enum/const's own name (for the Record<EnumName annotation
  // check below) alongside its member set. Falls back to the whole-file
  // regex scan (addSiblingValueStructuralCandidates's existing behavior)
  // when symbol-range extraction finds nothing, so recall never regresses.
  //
  // Efficiency fix (DESIGN-v0.8 §A6): each contract file used to be read up
  // to twice — once (conditionally) for the whole-file member-extraction
  // fallback, and again UNCONDITIONALLY for the enum-name regex, even on the
  // common path where the scoped (symbol-range) extraction already
  // succeeded and the fallback read never happened. Read each contract file
  // ONCE and share the string between both passes; skip the read entirely
  // when the scoped extraction already gave us a member set (no read is
  // needed there at all unless the name-scan below needs the raw text,
  // which it always does — so the single read now always happens, but only
  // once, and only when this file is actually a contract candidate, which
  // is already a short, pre-filtered list).
  let siblingMembers: Set<string> = new Set();
  const enumNames = new Set<string>();
  const nameRe = /\b(?:enum|class)\s+([A-Z]\w*)|(?:export\s+)?(?:const|type)\s+([A-Z]\w*)/g;
  for (const relPath of contractPaths) {
    const scoped = await extractEnumMembersFromSymbolRange(workspace, relPath);
    let raw: string | null = null;
    if (scoped) {
      for (const m of scoped) siblingMembers.add(m);
    } else {
      try {
        const decoded = decodeTextBuffer(fs.readFileSync(path.join(workspace, relPath)));
        if (decoded === null) continue;
        raw = decoded;
      } catch { continue; }
      for (const m of extractMemberIdentifiers(raw)) siblingMembers.add(m);
    }
    // Enum/const/type declaration NAMES near the query's own identifier
    // tokens — used only to build the Record<Name annotation pattern, a
    // secondary corroborating signal alongside member co-occurrence. Reuses
    // `raw` from the fallback read above when it already happened; otherwise
    // this is the ONLY read of this file (the scoped-extraction path above
    // does its own independent read inside extractEnumMembersFromSymbolRange,
    // which cannot be shared here without changing that function's contract).
    if (raw === null) {
      try {
        const decoded = decodeTextBuffer(fs.readFileSync(path.join(workspace, relPath)));
        if (decoded === null) continue;
        raw = decoded;
      } catch { continue; }
    }
    nameRe.lastIndex = 0;
    let nm: RegExpExecArray | null;
    while ((nm = nameRe.exec(raw)) !== null) {
      const name = nm[1] ?? nm[2];
      if (name) enumNames.add(name);
    }
  }
  // Require >= 2 distinct members to treat this as a real enum/variant
  // family — a lone ALL-CAPS token is not enough evidence of a family at
  // all (mirrors the file-scan admission gate below).
  if (siblingMembers.size < 2) return;

  const memberAlternation = [...siblingMembers]
    .sort((a, b) => b.length - a.length) // longest-first so no member shadows a shorter prefix
    .map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const keyPositionRe = new RegExp(`\\b(${memberAlternation})\\s*:`, "g");
  const recordAnnotationRes = [...enumNames].map(
    (name) => new RegExp(`\\bRecord<\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`),
  );

  // Efficiency fix: reuse the shared per-call memoized file list instead of
  // an independent walkCodeFiles call (see WalkCache doc).
  const files = walkCache.get({
    ...(input.lang ? { lang: input.lang } : {}),
    ...(input.path ? { subPath: input.path } : {}),
  });

  for (const f of files) {
    if (isExcluded(f.relPath, scope)) continue;
    // Efficiency fix: cap per-file read size. An exhaustive-initializer /
    // aggregation map is, by construction, a small hand-written declaration
    // — a huge generated/vendored file passing through the walk as ordinary
    // "code" is never a genuine match and is not worth the read+scan cost.
    // Fails open: skip (no candidate contributed), never throw.
    let size: number;
    try { size = fs.statSync(f.absPath).size; } catch { continue; }
    if (size > INITIALIZER_SCAN_MAX_FILE_BYTES) continue;

    let raw: string;
    try {
      const decoded = decodeTextBuffer(fs.readFileSync(f.absPath));
      if (decoded === null) continue;
      raw = decoded;
    } catch { continue; }
    const lines = raw.split(/\r?\n/);

    // DESIGN-v0.8 §A6 fix: SLIDING window (step
    // INITIALIZER_WINDOW_STEP_LINES < INITIALIZER_WINDOW_LINES) instead of
    // non-overlapping blocks, so a match whose 2 sibling members (or
    // Record<Name annotation) straddle what would have been a block
    // boundary is still fully contained in at least one window. Multiple
    // overlapping window starts can each independently satisfy the
    // admission condition for the SAME underlying declaration — dedupe by
    // (file, matchedLine) via addCandidateOnce below (the `outer` break
    // also short-circuits further window scanning once one match for this
    // file is found, since one hit per file is already sufficient to admit
    // it as a candidate, matching the prior single-hit-per-file behavior).
    // F2 admission-quality bar: force-admit as REQUIRED only when a single
    // window covers ≥ bar DISTINCT sibling members in key position (the live
    // fixture's aggregation map lists 5/5 → in; a 2/5 decoy map → out). The
    // `Record<EnumName>` annotation is a corroborating structural signal but
    // carries NO member coverage on its own, so it can position a match line
    // yet cannot by itself satisfy the coverage bar — a below-bar match (annotation
    // and/or ≥2 members) is still admitted, but non-required with no per-site check.
    const bar = siblingCoverageBar(siblingMembers.size);
    let matchedLine = 0;
    let bestDistinct = 0;
    for (let start = 0; start < lines.length; start += INITIALIZER_WINDOW_STEP_LINES) {
      const end = Math.min(lines.length, start + INITIALIZER_WINDOW_LINES);
      const windowText = lines.slice(start, end).join("\n");

      // Condition (a): DISTINCT sibling members in object-KEY position.
      keyPositionRe.lastIndex = 0;
      const distinctInWindow = new Set<string>();
      let km: RegExpExecArray | null;
      while ((km = keyPositionRe.exec(windowText)) !== null) distinctInWindow.add(km[1]!);

      // Condition (b): Record<EnumName annotation — a match position even when
      // no members are in key position in this window (score/required still
      // decided by the best member coverage found across all windows).
      const hasAnnotation = recordAnnotationRes.some((re) => re.test(windowText));

      if (distinctInWindow.size >= 2 && distinctInWindow.size > bestDistinct) {
        bestDistinct = distinctInWindow.size;
        matchedLine = start + 1;
      } else if (matchedLine === 0 && (hasAnnotation || distinctInWindow.size >= 2)) {
        // First positional match (annotation-only, or a lone-window ≥2 that did
        // not raise bestDistinct) — anchors the candidate line for a below-bar
        // admission when no richer window exists.
        matchedLine = start + 1;
      }
      if (bestDistinct >= bar) break; // bar met — nothing wider changes the verdict
    }

    if (matchedLine === 0) continue;
    const meetsBar = bestDistinct >= bar;
    addCandidateOnce(candidates, {
      path: f.relPath,
      line: matchedLine,
      endLine: Math.min(lines.length, matchedLine + INITIALIZER_WINDOW_LINES),
      kind: "structural",
      // Above the Layer-3 exact-text baseline (1.2) per DESIGN-v0.8 §A6 when the
      // coverage bar is met; a reduced, non-required score otherwise (F2).
      score: applyPenalties(meetsBar ? 1.4 : PARTIAL_SIBLING_SCORE, f.relPath, scope, context),
      why: meetsBar ? "exhaustive-initializer" : WHY_PARTIAL_SIBLING,
      // Force-admit as required ONLY when the bar is met (see Candidate.required
      // doc): an exhaustive-initializer/aggregation map that lists most of the
      // family is exactly the kind of surface both edit arms of an enum-extension
      // task need updated; a partial-overlap decoy is not.
      ...(meetsBar ? { required: true } : {}),
    });
  }
}

// ---------------------------------------------------------------------------
// DESIGN-v0.8 §A6 deliverable 2: nested/fixture-root graph-index discovery.
// ---------------------------------------------------------------------------

/**
 * A resolved graph index PLUS the workspace-relative directory prefix it was
 * loaded from (empty string when loaded from `workspace` itself). Every path
 * loadGraphIndex/GraphIndex returns is relative to WHATEVER directory
 * `loadGraphIndex` was called with — for a nested index (fixture-root, not
 * workspace-root) that is NOT the same as workspace-relative, so callers
 * must re-prefix with `rootPrefix` before treating a returned path as a
 * normal workspace-relative Candidate.path.
 */
interface ResolvedGraphIndex {
  index: ReturnType<typeof loadGraphIndex>;
  /** Workspace-relative directory the index was loaded from ("" = workspace root itself). */
  rootPrefix: string;
}

/**
 * Extend the existing loadGraphIndex integration (rather than adding a new
 * consumer — DESIGN-v0.8 §A6) with nested/fixture-root index discovery: walk
 * UP from `workspace/<dominantRoot>` to `workspace` itself, checking each
 * directory level for its OWN `.tokenlighten/index/`, and use the NEAREST
 * one found (closest to the dominant root — i.e. the search starts at the
 * deepest directory and stops at the first hit). Falls back to
 * loadGraphIndex(workspace) (today's behavior, unchanged) when nothing
 * nested is found, so a plain single-root workspace with only a
 * workspace-root index keeps working exactly as before.
 *
 * This is what lets a host-repo task (`workspace` = the TL repo root) whose
 * dominant root is a bench fixture (DESIGN-v0.8 §A2's
 * `bench/fixtures/<name>` root) prefer that fixture's OWN
 * `.tokenlighten/index/` over the workspace-root index — the fixture is a
 * deliberately self-contained project and its own index is the more
 * precise, purpose-built source for its symbols, even when a workspace-root
 * index also happens to exist (and might index the fixture under a
 * different/ambiguous convention — see tlGraphReader.ts's per-symbol-name
 * keying, which is a separate, pre-existing concern this function does not
 * attempt to fix).
 *
 * Reuses loadGraphIndex unchanged (it already accepts an arbitrary
 * directory and resolves `.tokenlighten/index/` beneath it) rather than
 * duplicating its tl-graph.json/scip.binpb-loading logic — "extend the
 * existing integration, not a new consumer" per the design.
 */
function resolveNestedGraphIndex(workspace: string, dominantRoot: string | null): ResolvedGraphIndex {
  if (dominantRoot) {
    // Walk from the dominant root's own directory up to (but not including,
    // to avoid re-checking it twice) the workspace root, nearest first.
    const segments = dominantRoot.split("/").filter((s) => s.length > 0);
    for (let depth = segments.length; depth > 0; depth--) {
      const rootPrefix = segments.slice(0, depth).join("/");
      const candidateDir = path.join(workspace, rootPrefix);
      const nested = loadGraphIndex(candidateDir);
      if (nested) return { index: nested, rootPrefix };
    }
  }
  return { index: loadGraphIndex(workspace), rootPrefix: "" };
}

/** Re-prefix a GraphIndex-returned path with the nested root it was loaded from. */
function reprefixGraphPath(relPath: string, rootPrefix: string): string {
  return rootPrefix ? `${rootPrefix}/${relPath}` : relPath;
}

function compareRelatedCandidates(a: Candidate, b: Candidate): number {
  const sa = classifySurface(a.path, a.symbol);
  const sb = classifySurface(b.path, b.symbol);
  const surfaceDiff = (LOCATE_SURFACE_PRIORITY[sa] ?? 9) - (LOCATE_SURFACE_PRIORITY[sb] ?? 9);
  if (surfaceDiff !== 0) return surfaceDiff;
  const scoreDiff = b.score - a.score;
  if (Math.abs(scoreDiff) > 0.001) return scoreDiff;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line;
}

function selectRelatedCandidates(raw: Candidate[], max: number): Candidate[] {
  const sorted = [...raw].sort(compareRelatedCandidates);
  const selected: Candidate[] = [];
  const selectedPaths = new Set<string>();
  const selectedSurfaces = new Set<ImpactSurface>();

  function add(c: Candidate): void {
    if (selected.length >= max) return;
    if (selectedPaths.has(c.path)) return;
    selected.push(c);
    selectedPaths.add(c.path);
    selectedSurfaces.add(classifySurface(c.path, c.symbol));
  }

  // Field-eval fix (2026-08-27): the role-diversity pass below force-adds
  // the top-ranked candidate for every DISTINCT role even when its score is
  // otherwise too low to earn a slot -- that IS the point of the guarantee
  // -- and the general fill pass after it has no score floor of its own
  // either (it just drains `sorted` in score order until `max` fills up).
  // Neither pass may draw from a candidate applyCommentOnlyPenalty already
  // sank as comment-only noise: excluding it from `sorted` up front (rather
  // than only from the first, role-diversity pass) means a role represented
  // ONLY by penalized candidates goes unfilled exactly as if that role had
  // no candidates at all, AND the general fill cannot quietly readmit the
  // same noise through the back door just because the pool is small.
  const eligible = sorted.filter((c) => c.commentOnlyPenalized !== true);
  for (const c of eligible) {
    const surface = classifySurface(c.path, c.symbol);
    if (!selectedSurfaces.has(surface)) add(c);
  }
  for (const c of eligible) {
    if (selected.length >= max) break;
    add(c);
  }

  return selected;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function locateTaskContext(workspace: string, input: LocateInput): Promise<LocateOutput> {
  // V10-06 (beta.1): heavy-provider invocation signal, observability only —
  // no-ops unless TL_TRACE=1 (see util/trace.ts's isTraceEnabled). This is
  // the layered candidate-retrieval entry V10-04/V10-06 call the "heavy
  // provider" (symbol/text/reference search fan-out, structural candidates,
  // dominant-root scoring below) — a known-local fast-path call must never
  // reach this function at all.
  trace("heavy_provider_invoked", { provider: "locateTaskContext", query_chars: input.query.length }, workspace);
  // maxTokens kept for backward-compat but is a no-op in Phase 3 (location-only).
  void input.maxTokens;
  const limit = Math.min(input.limit ?? 3, 10);
  // Hard scope: an explicit caller path wins. Otherwise an exact project-name
  // segment in the query may safely bind the search to that project while
  // generic/cross-project queries remain unscoped.
  const requestedScope = input.path;
  // Efficiency fix: ONE memoized file-walk cache per locate() call, shared by
  // every helper below that needs a workspace file list (see WalkCache doc).
  const walkCache = new WalkCache(workspace);
  // General project-root model (DESIGN-v0.8 §A2): build the marker-root
  // resolver ONCE from a shared WalkCache file list (no extra traversal), and
  // install it as the active workspace's resolver so any downstream bare
  // projectRootOf() reuses this exact resolver instead of re-walking. When the
  // caller passed an explicit `path` scope, use the SCOPED walk (the option-set
  // the rest of the pipeline already uses) rather than forcing a whole-tree
  // bare walk — cross-root demotion is moot under an explicit scope anyway
  // (every candidate is confined to that one subtree).
  const rootFiles = walkCache.get(requestedScope ? { subPath: requestedScope } : {});
  const rootResolver = buildRootResolver(workspace, rootFiles.map((f) => f.relPath));
  const scope = requestedScope ?? inferQueryProjectScopeFromResolver(input.query, rootResolver);
  setActiveRootWorkspace(workspace, rootResolver);
  const queryContext = inferQueryContext(walkCache, input.query, scope);

  const _ids = extractIdentifiers(input.query);
  const _texts = extractTextSearchQueries(input.query);
  if (_ids.length === 0 && _texts.length === 0 && !input.symbol) {
    return abstain("broad-query", []);
  }

  const candidates: Candidate[] = [];

  // -------------------------------------------------------------------------
  // Layer 1: Exact symbol lookup (when symbol is provided)
  // -------------------------------------------------------------------------
  if (input.symbol) {
    const symResult = await searchSymbols(
      {
        query: input.symbol,
        ...(input.lang ? { lang: input.lang } : {}),
        ...(scope ? { path: scope } : {}),
        limit: 10,
      },
      workspace,
    );

    for (const loc of symResult.locations) {
      if (isExcluded(loc.path, scope)) continue;
      // Exact symbol name match scores highest.
      const nameMatch = loc.symbol.toLowerCase() === input.symbol.toLowerCase();
      const baseScore = nameMatch ? 2.0 : 0.8;
      candidates.push({
        path: loc.path,
        line: loc.line,
        symbol: loc.symbol,
        kind: "symbol",
        score: applyPenalties(baseScore, loc.path, scope, queryContext),
        why: nameMatch ? "exact-symbol" : "fuzzy-symbol",
      });
    }
  }

  // -------------------------------------------------------------------------
  // Layer 1b (R5): dotted Class.method / Class#method resolution
  // -------------------------------------------------------------------------
  // A query naming "CommentService.create" means ONE concept: look INSIDE
  // CommentService for its create method — not two unrelated tokens. Plain
  // tokenization loses that structure (extractIdentifiers splits on "." into
  // "CommentService" and "create"), and the bare method name routinely
  // collides with TASK_MANAGEMENT_WORDS' generic-verb penalty meant for
  // queries like "create a new field" (create/update/delete/... are ALSO
  // common method names), burying the actual method Layer 2 would otherwise
  // never surface. Resolve the class first (a name search on "CommentService"
  // is not penalized — it is not a generic word), then anchor on the method
  // inside that specific file via the same machinery Layer 2's filename-match
  // refinement uses.
  for (const { className, methodName } of extractClassMethodPairs(input.query)) {
    const classResult = await searchSymbols(
      {
        query: className,
        ...(input.lang ? { lang: input.lang } : {}),
        ...(scope ? { path: scope } : {}),
        limit: 10,
      },
      workspace,
    );
    const exactNameMatches = classResult.locations.filter(
      (loc) => loc.symbol.toLowerCase() === className.toLowerCase(),
    );
    const classLoc = exactNameMatches.find((loc) => loc.kind === "class") ?? exactNameMatches[0];
    if (!classLoc || isExcluded(classLoc.path, scope)) continue;
    if (candidates.some((c) => c.path === classLoc.path && c.why === "class-method")) continue;
    // Anchor on the method inside the class's own file. Not searchSymbols:
    // its index only covers top-level declarations — a method nested
    // inside a class (e.g. CommentService.create) never appears in it at
    // all, scoped to the file or not (verified empirically). refineFilename
    // MatchSymbol parses the file directly via tree-sitter and DOES see
    // nested methods; its tie-break now also prefers an exact name match
    // ("create") over a same-covering compound name ("CommentCreateInput")
    // — see that function's isExactMatch tier.
    const refined = await refineFilenameMatchSymbol(workspace, classLoc.path, [methodName]);
    if (refined) {
      candidates.push({
        path: classLoc.path,
        line: refined.line,
        symbol: refined.symbol,
        kind: "symbol",
        score: applyPenalties(1.6, classLoc.path, scope, queryContext),
        why: "class-method",
      });
    } else {
      // The method wasn't found inside the class's own file; still anchor
      // on the class declaration rather than dropping a strong, exact
      // class-name match entirely.
      candidates.push({
        path: classLoc.path,
        line: classLoc.line,
        symbol: classLoc.symbol,
        kind: "symbol",
        score: applyPenalties(1.3, classLoc.path, scope, queryContext),
        why: "class-method",
      });
    }
  }

  // -------------------------------------------------------------------------
  // Layer 2: Symbol search over query tokens (if no symbol provided or
  //           layer 1 found nothing distinctive)
  // -------------------------------------------------------------------------
  if (!input.symbol || candidates.length === 0) {
    // Extract identifier-like tokens from the query.
    const tokens = extractIdentifiers(input.query)
      .filter((token) => !isProtocolSymbolSearchToken(token));
    // R2: fetch a wider raw pool per token (20, not 5) and rank it locally
    // before truncating back down to what actually becomes a candidate. A
    // single common token (e.g. "codec") can match many symbols; deciding
    // survivors purely by searchIndexSymbols' own internal order routinely
    // buried the symbol that actually answers the query (applyResponseCodec)
    // beneath same-token noise (codecId, CODEC_REGISTRY, ...) that never
    // even reached this file's candidate pool at limit:5.
    const SYMBOL_SEARCH_FETCH_LIMIT = 20;
    const SYMBOL_SEARCH_KEEP_PER_TOKEN = 5;
    for (const token of tokens.slice(0, 3)) {
      // Symbol indexes expose language identifiers, so a query field such as
      // `content_sufficiency` should look for `contentSufficiency`. The exact
      // snake spelling is still covered by the text/reference layers below;
      // using one canonical symbol query keeps internal search count flat.
      const symbolQuery = token.replace(/_([a-z0-9])/g, (_match, char: string) => char.toUpperCase());
      const symResult = await searchSymbols(
        {
          query: symbolQuery,
          ...(input.lang ? { lang: input.lang } : {}),
          ...(scope ? { path: scope } : {}),
          limit: SYMBOL_SEARCH_FETCH_LIMIT,
        },
        workspace,
      );
      // Rank this token's raw hits by kind-tier before truncating — see
      // rankSymbolHitQuality's doc comment for the rationale (and why an
      // other-token-coverage component was tried and then cut).
      const ranked = symResult.locations
        .map((loc, order) => ({ loc, order, quality: rankSymbolHitQuality(loc) }))
        .sort((a, b) => b.quality - a.quality || a.order - b.order)
        .slice(0, SYMBOL_SEARCH_KEEP_PER_TOKEN);
      // R0: an exact-and-workspace-unique symbol-match score boost was
      // TRIED here (raising this hit above the flat 0.6 when the query
      // names this symbol precisely and it is the only one in the
      // workspace by that name) and CUT. Even narrowed to unique+exact
      // matches it regressed the sibling-member-recall corpus: boosting
      // TicketPriority's own declaration to a high-confidence REQUIRED
      // primary suppressed the sibling-enumeration mechanism that also
      // needs to surface statsService.ts alongside it. The R0 bug this was
      // meant to fix (buildInitializeInstructions/server.ts losing to
      // serverInstructions.ts) is already resolved by the basename
      // containment ratio-guard above matchBasenameTokens's qt.includes(nt)
      // branch — server.ts now surfaces via Layer 3 (exact-text) instead;
      // a Layer 2 precision improvement was a nice-to-have, not required,
      // and not worth this corpus risk. See the wave report for detail.
      for (const { loc } of ranked) {
        if (isExcluded(loc.path, scope)) continue;
        if (candidates.some((c) => c.path === loc.path && c.line === loc.line)) continue;
        candidates.push({
          path: loc.path,
          line: loc.line,
          symbol: loc.symbol,
          kind: "symbol",
          score: applyPenalties(0.6, loc.path, scope, queryContext),
          why: "query-symbol",
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Layer 3: Exact text search for quoted strings / distinctive identifiers
  // -------------------------------------------------------------------------
  const _distinctiveToken = extractDistinctiveToken(input.query);
  const textQueries = extractTextSearchQueries(input.query);
  for (const tq of textQueries.slice(0, 2)) {
    if (isScopeOnlyTextQuery(tq, queryContext)) continue;
    const isDistinctive = _distinctiveToken !== null && tq === _distinctiveToken;
    const findResult = findText(
      {
        query: tq,
        ...(input.lang ? { lang: input.lang } : {}),
        ...(scope ? { path: scope } : {}),
      },
      workspace,
    );
    // T3 DEFECT A: supplement with whatever findText()'s own 1 MB-capped
    // internal walk could never have seen (see wideExactTextMatches).
    const wideMatches = wideExactTextMatches(
      tq, workspace, { ...(input.lang ? { lang: input.lang } : {}), ...(scope ? { path: scope } : {}) }, walkCache,
    );
    for (const m of [...findResult.matches, ...wideMatches]) {
      if (isExcluded(m.path, scope)) continue;
      if (candidates.some((c) => c.path === m.path && c.line === m.line)) continue;
      candidates.push({
        path: m.path,
        line: m.line,
        kind: "text",
        score: applyPenalties(1.2, m.path, scope, queryContext),
        why: isDistinctive ? "exact-text:distinctive" : "exact-text",
        // This hit covers exactly ONE query token: the one searched for.
        // Recorded so the coverage-dominance gate below can tell a file that
        // merely contains one generic query word from one that is about
        // several of them (see coveredQueryTokens).
        ...(isAsciiQueryToken(tq) ? { covers: [tq.toLowerCase()] } : {}),
      });
    }
  }

  // -------------------------------------------------------------------------
  // Layer 4: Reference search for identifier-like tokens
  // -------------------------------------------------------------------------
  const refTokens = extractIdentifiers(input.query).slice(0, 2);
  for (const token of refTokens) {
    if (token.length < 4) continue; // skip trivially short tokens
    const refResult = await findReferences(
      {
        symbol: token,
        ...(input.lang ? { lang: input.lang } : {}),
        ...(scope ? { path: scope } : {}),
      },
      workspace,
    );
    for (const ref of refResult.references.slice(0, 5)) {
      if (isExcluded(ref.path, scope)) continue;
      if (candidates.some((c) => c.path === ref.path && c.line === ref.line)) continue;
      candidates.push({
        path: ref.path,
        line: ref.line,
        kind: "reference",
        score: applyPenalties(0.5, ref.path, scope, queryContext),
        why: "reference",
        ...(isAsciiQueryToken(token) ? { covers: [token.toLowerCase()] } : {}),
      });
    }
  }

  // -------------------------------------------------------------------------
  // Layer 3/4 extension: variant token search for impact surface discovery
  // -------------------------------------------------------------------------
  const variantTokens = buildVariantTokens(input.query, input.symbol);
  // A "family stem" is a generic CSS-custom-property / BEM-modifier wrapper
  // shape ("--value" / "-value") derived from an all-caps query token by
  // deriveTokenVariants — not a hard-coded project vocabulary prefix. This
  // is what lets the locator find sibling style declarations for the same
  // enum/status/priority family across any repo's own naming convention.
  const isFamilyStemToken = (v: string): boolean => v.startsWith("--") || (v.startsWith("-") && !v.startsWith("--"));
  for (const vt of variantTokens.slice(0, 12)) {
    const findResult = findText(
      {
        query: vt,
        ...(input.lang ? { lang: input.lang } : {}),
        ...(scope ? { path: scope } : {}),
      },
      workspace,
    );
    // T3 DEFECT A: same 1 MB walk blind spot as Layer 3 above (see
    // wideExactTextMatches's doc comment).
    const wideVariantMatches = wideExactTextMatches(
      vt, workspace, { ...(input.lang ? { lang: input.lang } : {}), ...(scope ? { path: scope } : {}) }, walkCache,
    );
    const isFamilyStem = isFamilyStemToken(vt);
    for (const m of [...findResult.matches, ...wideVariantMatches]) {
      if (isExcluded(m.path, scope)) continue;
      // R12 (2026-08-21): a bare word that is ALSO a generic CSS property
      // name (e.g. "cursor") matches nearly every stylesheet in the walk
      // regardless of topic — unlike a query-distinctive word that merely
      // happens to appear in a class name (e.g. "widget" in ".widget-card"),
      // which IS real relevance signal and must keep working. Only the
      // former needs gating: a style file may not enter through this
      // generic variant scan on a bare CSS-property-keyword match; it can
      // still enter via any OTHER token, via family-stem shape, or via the
      // dedicated, properly root-scoped style scan below.
      if (!isFamilyStem && CSS_PROPERTY_KEYWORDS.has(vt.toLowerCase()) && STYLE_EXTS.has(path.extname(m.path))) continue;
      if (candidates.some((c) => c.path === m.path && c.line === m.line)) continue;
      candidates.push({
        path: m.path,
        line: m.line,
        kind: "text",
        score: applyPenalties(isFamilyStem ? 0.55 : 0.7, m.path, scope, queryContext),
        why: isFamilyStem ? "family-stem" : "variant-text",
      });
    }
  }

  // -------------------------------------------------------------------------
  // Layer 3/4 extension: direct style-file scan for family stems (CSS not in walkCodeFiles).
  // -------------------------------------------------------------------------
  const stemPatterns = variantTokens.filter(isFamilyStemToken);
  if (stemPatterns.length > 0) {
    // B1a (2026-08-01 retrieval-scope): same role-search confinement as the
    // presentation-family scan in addStructuralCandidates — a family STEM hit
    // proves "this file styles that token family", never "this file is what the
    // query is about", so the direct hits own the scope.
    const stemScope = roleSearchScopePrefixes(familyScanAnchorPaths(candidates));
    scanStyleFiles(walkCache.get({ extraExts: STYLE_EXTRA_EXTS }), stemPatterns, (relPath, lineNo) => {
      if (isExcluded(relPath, scope)) return;
      if (!isWithinRoleSearchScope(relPath, stemScope)) return;
      if (candidates.some((c) => c.path === relPath && c.line === lineNo)) return;
      candidates.push({
        path: relPath,
        line: lineNo,
        kind: "text",
        score: applyPenalties(0.55, relPath, scope, queryContext),
        why: "family-stem",
      });
    });
  }

  addStructuralCandidates(workspace, input, candidates, scope, queryContext, walkCache);
  addSiblingValueStructuralCandidates(workspace, input, candidates, scope, queryContext, walkCache);
  await addSiblingValueInitializerCandidates(workspace, input, candidates, scope, queryContext, walkCache);
  addMarkdownContractCandidates(workspace, input, candidates, scope, queryContext, walkCache);

  // -------------------------------------------------------------------------
  // Layer 5 walk (shared): the filename-match passes below both scan the
  // same lang/subPath-scoped file list. Backed by the per-call WalkCache, so
  // this option-set is walked at most once total across this ENTIRE locate()
  // call (not just across the two Layer-5 passes) — any earlier layer that
  // requested the identical (lang, subPath) option-set already populated it.
  // -------------------------------------------------------------------------
  const pathTokens = extractIdentifiers(input.query).map((t) => t.toLowerCase());
  // Issue #2 (a): per filename-matched path, the symbol that answers the rest
  // of the query. Consumed at the per-path collapse below, which is where a
  // file's served LINE is decided.
  const refinedByPath = new Map<string, NonNullable<Awaited<ReturnType<typeof refineFilenameMatchSymbol>>>>();
  const getCodeFiles = (): FoundFile[] =>
    walkCache.get({
      ...(input.lang ? { lang: input.lang } : {}),
      ...(scope ? { subPath: scope } : {}),
    });

  // -------------------------------------------------------------------------
  // Layer 5a: high-signal basename matching (runs ALWAYS, not only when the
  // pool is empty). A file whose NAME matches the query is a strong relevance
  // signal that must not be suppressed just because some other file contains
  // a common query word as text (e.g. "mode" in every *_mode.hpp). The
  // admission rule (matchBasenameTokens) keeps low-value single-common-word
  // filename matches out of the pool.
  //
  // Two passes so single-token matches can be ranked against the multi-token
  // ones: PASS 1 collects every admitted (file, matched-tokens) and the set of
  // tokens CLAIMED by some >=2-token match. PASS 2 scores. A single-token
  // match whose only token is already claimed by a stronger, more specific
  // multi-token match is redundant (e.g. "shaper" is claimed by
  // wave_shaper, so pulse_shaper / ring_shaper — matching
  // only "shaper" — are demoted below the exact-text baseline), which lets
  // a single-token match on an UNCLAIMED, name-distinctive token
  // (e.g. "codec", "mutex") rank competitively instead of tying with generic
  // shared-suffix noise.
  // -------------------------------------------------------------------------
  const filenameMatchPaths = new Set<string>();
  // Paths admitted by a SINGLE query token (matched.size === 1) — i.e. via
  // the frequency-based distinctiveness path, not a >=2-token match. Tracked
  // separately so the post-Layer-5a root-scoping pass (DESIGN-v0.8 §A2) can
  // require matched.size >= 2 for out-of-dominant-root basename matches when
  // candidates span multiple roots: a single distinctive-looking token match
  // in a file that turns out to live outside the dominant root is weaker
  // evidence than the same match in-root, and must not ride into the pool on
  // rarity alone once cross-project ambiguity is detected.
  const singleTokenFilenameMatchPaths = new Set<string>();
  // Paths whose filename match spans >= 2 DISTINCT basename tokens (genuinely
  // multiple name concepts — see distinctBasenameTokensMatched). This is the
  // "strong filename signal" set consumed by the kind-aware out-of-root
  // demotion (DESIGN-v0.8 cross-package fix); it is DELIBERATELY narrower than
  // "filenameMatchPaths minus singleTokenFilenameMatchPaths", which would also
  // include a match where two query tokens collapse onto one name token
  // (fourier_notes ⇐ fourierFilterStep+fourierGain) — that is a single-name-
  // concept match and must keep the full out-of-root penalty.
  const multiNameTokenFilenameMatchPaths = new Set<string>();
  if (pathTokens.length > 0) {
    const nameMatches: Array<{ relPath: string; matched: Set<string> }> = [];
    const claimedByMulti = new Set<string>();
    for (const f of getCodeFiles()) {
      if (isExcluded(f.relPath, scope)) continue;
      // Pass the getter itself (not its call result) — matchBasenameTokens
      // only invokes it when the single-token rarity check actually needs it,
      // so a query whose files mostly exit at `matched === null` or admit via
      // the >= 2-token path never forces QueryContext's lazy workspace walk.
      const matched = matchBasenameTokens(f.relPath, pathTokens, () => queryContext.getBasenameFrequency());
      if (matched === null) continue;
      nameMatches.push({ relPath: f.relPath, matched });
      if (matched.size >= 2) {
        for (const t of matched) claimedByMulti.add(t);
      }
      if (distinctBasenameTokensMatched(f.relPath, pathTokens) >= 2) {
        multiNameTokenFilenameMatchPaths.add(f.relPath);
      }
    }

    // R8: when >= 2 files share the SAME basename (a re-export barrel in
    // one directory, the real implementation in another — e.g.
    // tools/readCodeTaskPack.ts's `export * from
    // "../features/task-pack/readCodeTaskPack.js"` beside the 21k-line
    // features/task-pack/readCodeTaskPack.ts it re-exports), they get
    // IDENTICAL matched sets and IDENTICAL baseScore below, so whichever the
    // workspace walk happened to visit first silently won — routinely the
    // tiny shim, not the file with the actual declarations a task needs.
    // Only check content (isPureReexportBarrel) for genuine same-basename
    // ties, keeping cost bounded — the vast majority of filename matches
    // have no basename collision at all and never reach this loop body.
    const barrelPaths = new Set<string>();
    if (nameMatches.length > 1) {
      const byBasename = new Map<string, string[]>();
      for (const { relPath } of nameMatches) {
        const base = path.basename(relPath);
        const arr = byBasename.get(base);
        if (arr) arr.push(relPath); else byBasename.set(base, [relPath]);
      }
      for (const paths of byBasename.values()) {
        if (paths.length < 2) continue;
        for (const p of paths) {
          if (isPureReexportBarrel(workspace, p)) barrelPaths.add(p);
        }
      }
    }

    // Issue #2 (a): a basename match says which FILE is about a query token,
    // never WHERE in it to look — the pool's line for such a file is whatever
    // an earlier layer happened to surface, which for a name-driven symbol
    // hit is just the file's first symbol. Ask the file itself which symbol
    // covers the query tokens the NAME did not, so the served slice is the
    // one that answers. Bounded: only when a query token is left outstanding,
    // only the strongest FILENAME_SYMBOL_REFINE_LIMIT files, and only files
    // small enough to parse cheaply.
    const asciiPathTokens = pathTokens.filter(isAsciiQueryToken);
    if (asciiPathTokens.length >= 2) {
      const refineOrder = [...nameMatches]
        .sort((a, b) => b.matched.size - a.matched.size)
        .slice(0, FILENAME_SYMBOL_REFINE_LIMIT);
      for (const { relPath, matched } of refineOrder) {
        const remaining = asciiPathTokens.filter((t) => !matched.has(t));
        const refined = await refineFilenameMatchSymbol(workspace, relPath, remaining);
        if (refined !== null) refinedByPath.set(relPath, refined);
      }
    }

    for (const { relPath, matched } of nameMatches) {
      // A single-token match on a token already claimed by a >=2-token match
      // is redundant noise — score it BELOW the exact-text baseline (0.6) so
      // it neither buries the genuine multi-token bug files nor out-ranks a
      // distinctive single-token match. It still enters the pool (recall
      // preserved) but as a weak related candidate.
      const soleClaimed =
        matched.size === 1 && claimedByMulti.has([...matched][0]!);
      const baseScore = soleClaimed ? 0.6 : basenameMatchScore(matched.size);
      // R8: a pure re-export barrel sharing its basename with a real
      // implementation (see barrelPaths above) is demoted below it — a
      // basename match on its own says nothing about WHICH of several
      // same-named files the query means, and a re-export shim is
      // essentially never the file a task needs to look inside.
      const barrelAdjustedScore = barrelPaths.has(relPath) ? baseScore - 0.5 : baseScore;
      // Score on the basename match's own merits: skip the scope-hint
      // boost/penalty (see applyPenalties) so a name-matched bug file under
      // control/ is not out-ranked by unrelated text hits under mode/ merely
      // because the query happened to contain the directory word "mode".
      const nameScore = applyPenalties(barrelAdjustedScore, relPath, scope, queryContext, { skipScopeHint: true });
      filenameMatchPaths.add(relPath);
      if (matched.size === 1) singleTokenFilenameMatchPaths.add(relPath);

      // If an earlier layer already surfaced this file (e.g. a query-symbol
      // or reference hit at a low score), BOOST it to the competitive
      // filename-match score and re-tag it — the fact that its NAME matches
      // the query is a stronger signal than the incidental low-score hit, and
      // (crucially) the re-tag lets it survive the scope-hint down-filter
      // below. Otherwise add it fresh as a line-1 name match.
      const existing = candidates.filter((c) => c.path === relPath);
      if (existing.length > 0) {
        for (const c of existing) {
          if (nameScore > c.score) {
            c.score = nameScore;
            c.why = "filename-match";
          }
          // The basename layer KNOWS which query tokens it matched; recording
          // them keeps the coverage bookkeeping from having to re-derive (and
          // disagree with) that judgement.
          c.covers = [...new Set([...(c.covers ?? []), ...matched])];
        }
      } else {
        const refined = refinedByPath.get(relPath);
        addCandidateOnce(candidates, refined === undefined
          ? {
              path: relPath,
              line: 1,
              kind: "path-token",
              score: nameScore,
              why: "filename-match",
              covers: [...matched],
            }
          : {
              // Nothing else surfaced this file, so the refinement is also the
              // only line worth naming — better than the bare line 1 a pure
              // name match used to fall back to.
              path: relPath,
              line: refined.line,
              endLine: refined.endLine,
              symbol: refined.symbol,
              kind: "symbol",
              score: nameScore,
              why: "filename-match",
              covers: [...new Set([...matched, ...refined.covered])],
            });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Layer 5b: loose path-token matching (last-resort recall, if STILL no
  // candidates). Preserved verbatim as the existing fallback: when even the
  // high-signal pass admitted nothing, fall back to any basename that
  // contains any query token as a substring. This is a superset of Layer 5a
  // by design and only fires when the pool is otherwise empty.
  // -------------------------------------------------------------------------
  if (candidates.length === 0) {
    if (pathTokens.length > 0) {
      for (const f of getCodeFiles()) {
        if (isExcluded(f.relPath, scope)) continue;
        const nameLower = path.basename(f.relPath, path.extname(f.relPath)).toLowerCase();
        const matches = pathTokens.filter((t) => nameLower.includes(t));
        if (matches.length > 0) {
          candidates.push({
            path: f.relPath,
            line: 1,
            kind: "path-token",
            score: applyPenalties(0.3 * matches.length, f.relPath, scope, queryContext),
            why: "path-token",
          });
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Comment-only-match precision penalty (DESIGN-v0.8 §A4, general fix): sink
  // any candidate whose query-token matches in its own file are ENTIRELY on
  // comment/string lines. Runs BEFORE root scoping so such a file (e.g. TL's
  // own source matched via an identifier appearing only in a comment) cannot
  // skew the
  // dominant-root vote toward a wrong root.
  // -------------------------------------------------------------------------
  applyCommentOnlyPenalty(candidates, workspace, extractIdentifiers(input.query));

  // -------------------------------------------------------------------------
  // Project-root scoping (DESIGN-v0.8 §A2, GENERAL model): after all of Layer
  // 1–5b has contributed candidates and scores, determine which single
  // project root (nearest enclosing VCS/manifest dir, or an inferred
  // manifest-less cluster — see computeDominantRoot) the task is actually
  // about, and demote candidates in a DIFFERENT root. This keeps a subproject
  // task from surfacing sibling-subproject or unrelated parent-repo noise when
  // the caller's cwd is a parent directory — WITHOUT hard-excluding anything,
  // since root inference can guess wrong on an ambiguous query.
  // -------------------------------------------------------------------------
  // computeDominantRoot computes each candidate's own EFFECTIVE root exactly
  // ONCE (rootByCandidate) and every downstream consumer below reuses it.
  //
  // Two inputs feed the kind-aware demotion and two-domain detection below:
  //   - multiTokenFilenamePaths: STRONG filename matches — those spanning >= 2
  //     DISTINCT basename tokens (genuinely multiple name concepts, e.g.
  //     wave_shaper ⇐ "wave"+"shaper"; NOT two query tokens collapsing
  //     onto one name token, e.g. fourier_notes). Populated in Layer 5a as
  //     multiNameTokenFilenameMatchPaths, which is stable across the demotion
  //     loop (that loop only mutates filenameMatchPaths, never this set).
  //   - queryIdentTokens: the query's identifier tokens (lowercased), used to
  //     attribute each strong candidate to the identifier it is "about" so a
  //     genuine two-domain wiring query keeps both domains.
  const multiTokenFilenamePaths = multiNameTokenFilenameMatchPaths;
  const queryIdentTokens = extractIdentifiers(input.query).map((t) => t.toLowerCase());
  const { root: dominantRoot, rootByCandidate, inScopeRoots, multiRoot } = computeDominantRoot(
    candidates, queryContext, rootResolver, multiTokenFilenamePaths, queryIdentTokens,
  );

  // Effective root of an ARBITRARY path (used for `related`/inventory paths
  // that are not in rootByCandidate): the marker root when non-empty, else the
  // cluster-inferred dominant root when the path sits under it. This makes a
  // manifest-less cluster and a marker root indistinguishable to the
  // required-surface accounting below (both yield a consistent, comparable
  // root string), so in-cluster relateds correctly count as in-root.
  const effectiveRootOf = (relPath: string): string => {
    const marker = rootResolver.rootOf(relPath);
    if (marker !== "") return marker;
    if (dominantRoot !== null && dominantRoot !== "" &&
        (relPath === dominantRoot || relPath.startsWith(dominantRoot + "/"))) {
      return dominantRoot;
    }
    return "";
  };
  if (dominantRoot !== null) {
    for (const c of candidates) {
      const root = rootByCandidate.get(c)!;
      // In-scope roots are exempt: always the dominant root, plus a genuine
      // second domain's root for a two-domain wiring query (see
      // decideTwoDomainRoots). Membership — not strict equality — is what lets
      // a legitimate cross-package task keep BOTH domains instead of the
      // majority vote sinking the loser.
      if (inScopeRoots.has(root)) continue;
      // Out-of-root exemptions: a candidate the caller explicitly scoped in
      // (`input.path` covers it) or a scope-hint covers is NOT penalized — the
      // demotion exists to suppress cross-project spray, not to fight an
      // explicit caller signal. (When `scope` is set every candidate is
      // already confined to it, so this mainly matters for scope-hint cover.)
      const scopeCovered =
        (scope !== undefined && (c.path === scope || c.path.startsWith(scope + "/"))) ||
        (queryContext.scopeHints.size > 0 && matchesScopeHint(c.path, queryContext));
      if (scopeCovered) continue;
      // Kind-aware out-of-root demotion (DESIGN-v0.8 monorepo cross-package
      // fix). The uniform -1.0 correctly sinks TEXT/REFERENCE spray across
      // sibling projects, but it also destroyed STRONG out-of-root signals —
      // and real monorepo tasks legitimately span packages (a shared contracts
      // package's symbol consumed by an app package). So:
      //   - text/reference kinds AND single-common-token filename matches keep
      //     the full -1.0 (spray suppression unchanged); a 1.25 single-token
      //     filename match lands below the 0.6 weak floor as before.
      //   - symbol/structural kinds and MULTI-token (>= 2 query token) filename
      //     matches take a SMALLER -0.55, tuned so a 1.25-baseline strong match
      //     lands ~0.70: below any in-root primary (so the in-root file still
      //     wins ranking and identical-basename noise in a sibling project
      //     can't take the primary slot) but ABOVE the 0.6 weak floor, so the
      //     genuine cross-package contract file SURVIVES into candidates/
      //     related instead of vanishing. Still a penalty, not an exclusion —
      //     root inference can guess wrong on a truly ambiguous query.
      const strong = isStrongScopeCandidate(c, multiTokenFilenamePaths);
      c.score -= strong ? OUT_OF_ROOT_STRONG_PENALTY : OUT_OF_ROOT_PENALTY;
      // Basename-admission symmetry, out-of-root clause: a single-token
      // filename match (admitted only via frequency-based distinctiveness,
      // not a genuine >=2-token match) is too weak a signal to trust outside
      // the dominant root — strip its filename-match status entirely so it
      // neither keeps the down-filter exemption below nor the
      // required-surface accounting. (A MULTI-token filename match is a strong
      // signal and keeps its status; it took only the -0.55 above.)
      if (singleTokenFilenameMatchPaths.has(c.path)) {
        filenameMatchPaths.delete(c.path);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Honest root-miss (DESIGN-v0.8 §A5): when the query carries strong
  // identifier tokens (CamelCase / snake_case / ALLCAPS, multi-char) and NONE
  // of them match any candidate that survived in-root, the best answer the
  // pipeline has is out-of-root — which means the caller is very likely
  // scoped to the wrong subtree (the exact component-from-repo-root live
  // failure). Rather than serve that junk silently, capture the strongest
  // out-of-root cluster's common directory as a re-scope SUGGESTION, surfaced
  // on the result so the pack layer can tell the agent to re-scope (cwd or
  // paths) instead of editing noise.
  // -------------------------------------------------------------------------
  const rootSuggestion = computeRootSuggestion(
    input.query, candidates, rootByCandidate, dominantRoot, rootResolver, scope,
  );

  // -------------------------------------------------------------------------
  // Soft scope-hint down-filter: when the query names a subsystem that maps
  // to a directory segment, prefer candidates in that subsystem. This exists
  // to suppress text hits that sprayed across the repo AWAY from the named
  // subsystem — but a high-signal basename match (why="filename-match") is
  // itself the strongest "this is the right file" signal, not spray, so it is
  // exempt. Otherwise a multi-concept query like "...wave shaper... pulse
  // counter... clock manager..." (whose only directory-segment token is
  // "clock") would drop the wave_shaper/pulse_counter name-matches purely
  // because they live under dsp/ rather than clock/.
  //
  // The exemption itself is restricted to IN-ROOT filename matches (DESIGN-
  // v0.8 §A2): an out-of-root basename match already took a -1.0 penalty
  // above and must not also bypass the scope-hint filter on top of that.
  // -------------------------------------------------------------------------
  const isInRootFilenameMatch = (c: Candidate): boolean =>
    filenameMatchPaths.has(c.path) && (dominantRoot === null || rootByCandidate.get(c) === dominantRoot);
  const scopeHintCandidates = queryContext.scopeHints.size > 0
    ? candidates.filter((c) => isInRootFilenameMatch(c) || matchesScopeHint(c.path, queryContext))
    : candidates;
  const candidatePool = scopeHintCandidates.length > 0 ? scopeHintCandidates : candidates;

  // -------------------------------------------------------------------------
  // Hard-scope filter: when input.path is set, discard candidates outside it
  // -------------------------------------------------------------------------

  const filteredCandidates = scope
    ? candidatePool.filter((c) => c.path === scope || c.path.startsWith(scope + "/"))
    : candidatePool;

  // -------------------------------------------------------------------------
  // Rank and deduplicate
  // -------------------------------------------------------------------------
  const rankingIdentifiers = extractIdentifiers(input.query)
    .filter((token) => !isProtocolSymbolSearchToken(token));
  const distinctivePathCounts = new Map<string, number>();
  for (const candidate of filteredCandidates) {
    if (candidate.why !== "exact-text:distinctive") continue;
    distinctivePathCounts.set(candidate.path, (distinctivePathCounts.get(candidate.path) ?? 0) + 1);
  }
  for (const candidate of filteredCandidates) {
    candidate.score += structuredIdentifierRankBoost(candidate, rankingIdentifiers);
    if (candidate.why === "exact-text:distinctive") {
      const count = distinctivePathCounts.get(candidate.path) ?? 1;
      candidate.score += Math.min(0.6, Math.max(0, count - 1) * 0.08);
    }
  }
  for (const [candidatePath, count] of distinctivePathCounts) {
    if (count < 2) continue;
    const samePath = filteredCandidates.filter((candidate) =>
      candidate.path === candidatePath && candidate.why === "exact-text:distinctive"
    );
    const bestScore = Math.max(...samePath.map((candidate) => candidate.score));
    const strong = samePath
      .filter((candidate) => candidate.score >= bestScore - 0.01)
      .sort((a, b) => a.line - b.line);
    let cluster: Candidate[] = [];
    for (let index = 0; index < strong.length; index++) {
      const candidateCluster = strong.slice(index).filter((candidate) =>
        candidate.line - strong[index]!.line <= 40
      );
      if (candidateCluster.length > cluster.length) cluster = candidateCluster;
    }
    if (cluster.length < 2) continue;
    const start = Math.max(1, cluster[0]!.line - 4);
    const end = cluster.at(-1)!.line + 4;
    const range = `${start}-${end}`;
    for (const candidate of cluster) candidate.range = range;
  }
  // V10-08 (beta.2, flag-gated): BM25F candidate generation + RRF fusion.
  // Both OFF is byte-identical to the original single line below — the "on"
  // branch is the ENTIRE new behavior surface, isolated to
  // features/retrieval/ (see its own file docs for the ranker/floor design).
  if (bm25fCandidateEnabled() || rrfFusionEnabled()) {
    await applyHybridRetrieval(
      {
        workspace,
        query: input.query,
        ...(input.symbol ? { symbol: input.symbol } : {}),
        codeFiles: getCodeFiles(),
        walkCache,
        // V11-02 (flag: TL_RRF_PROFILES): thread the caller's explicit scope
        // as profile-inference context ONLY under the flag. index.ts's own
        // profilesOn gate (TL_RRF_PROFILES && TL_RRF_FUSION) is the real
        // safety backstop; this just avoids building an unused object on the
        // hot path when the flag is off.
        ...(rrfProfilesEnabled() ? { profileContext: { ...(requestedScope ? { explicitPath: requestedScope } : {}) } } : {}),
      },
      filteredCandidates,
    );
  } else {
    filteredCandidates.sort((a, b) => b.score - a.score);
  }

  // Collapse to the single highest-scored line per PATH before taking the top
  // N. `topN` feeds the ambiguous-path candidate list / candidateDetails and
  // the success gate's top/second margin; one file that happens to contain a
  // common query word on many lines (e.g. every "*_mode.hpp" containing the
  // text "mode") would otherwise consume the whole limit with near-identical
  // line hits and crowd out genuinely different, name-matched files. Dedup is
  // stable (input is already score-sorted), so the retained line per path is
  // its best-scored one. Note: `related` is built from the FULL
  // filteredCandidates via selectRelatedCandidates below, so this dedup does
  // not reduce related-surface recall.
  const seenTopPath = new Set<string>();
  const dedupedByPath = filteredCandidates.filter((c) => {
    if (seenTopPath.has(c.path)) return false;
    seenTopPath.add(c.path);
    return true;
  });
  // Issue #2 (a): the collapse above decides which LINE of a file is served,
  // and for a name-matched file that line is whatever a name-driven layer
  // happened to emit first — routinely the file's first declaration, which is
  // not what the query asked about. Re-anchor such a representative on the
  // symbol that covers the rest of the query. Rank is untouched (the file
  // keeps the score the pool gave it); only the anchor moves, and only for a
  // representative that was itself chosen by NAME — a text or reference hit
  // earned its line from content and keeps it.
  for (const c of dedupedByPath) {
    const refined = refinedByPath.get(c.path);
    if (refined === undefined || c.line === refined.line) continue;
    if (c.kind !== "symbol" && c.kind !== "path-token") continue;
    c.kind = "symbol";
    c.symbol = refined.symbol;
    c.line = refined.line;
    c.endLine = refined.endLine;
    c.covers = [...new Set([...(c.covers ?? []), ...refined.covered])];
    delete c.range;
  }
  // Collapse each C/C++ module's header+source (both filename matches) into a
  // single ranking slot BEFORE taking the top N, preferring the source
  // (.cpp/.c). A two-file module otherwise consumes two of the (small) top-N
  // slots with its header AND source at the same score, crowding a distinct
  // one-file module out of the pack that downstream builds from this list.
  const collapsedTop = collapseCppModulePairs(dedupedByPath, filenameMatchPaths);
  const topN = collapsedTop.slice(0, limit);

  if (topN.length === 0) {
    return abstain("not-found", [], undefined, rootSuggestion, { workspace, query: input.query });
  }

  // -------------------------------------------------------------------------
  // Success gate (spec lines 277–286)
  // -------------------------------------------------------------------------
  const top = topN[0]!;
  const second = topN[1];

  const uniqueExactSymbol =
    input.symbol &&
    top.kind === "symbol" &&
    top.symbol?.toLowerCase() === input.symbol.toLowerCase() &&
    filteredCandidates.filter(
      (c) => c.kind === "symbol" && c.symbol?.toLowerCase() === input.symbol!.toLowerCase()
    ).length === 1;

  const uniqueExactText =
    top.kind === "text" &&
    filteredCandidates.filter((c) => c.kind === "text" && c.why === "exact-text").length === 1;

  const largeMargin =
    second === undefined ||
    top.score - second.score >= 0.8;

  // Distinctive-token gate: if the longest all-caps identifier (>=6 chars) in the
  // query has exactly ONE exact-text hit, that hit is the unambiguous primary.
  let distinctivePrimary: Candidate | null = null;
  if (_distinctiveToken !== null) {
    const dtHits = filteredCandidates.filter((c) => c.why === "exact-text:distinctive");
    if (dtHits.length === 1) {
      distinctivePrimary = dtHits[0]!;
    }
  }

  // Coverage dominance (issue #2): on a query carrying several identifier
  // concepts, a top candidate that covers STRICTLY MORE of them than every
  // other survivor is not "ambiguous" — the runner-ups are about less of the
  // question, however close their scores happen to land. Without this the
  // >= 0.8 margin gate turns "the one file named for concept A whose exported
  // symbol is concept B" into a candidate-list against its own siblings, each
  // of which only carries B.
  const asciiQueryTokensForGate = queryIdentTokens.filter(isAsciiQueryToken);
  let coverageDominant = false;
  if (asciiQueryTokensForGate.length >= 2 && topN.length > 1) {
    const covers = topN.map((c) => coveredQueryTokens(c, asciiQueryTokensForGate).size);
    coverageDominant = covers[0]! >= 2 && covers.slice(1).every((n) => n < covers[0]!);
  }

  const shouldHit = uniqueExactSymbol || uniqueExactText || (largeMargin && top.score >= 0.8) ||
    distinctivePrimary !== null || (coverageDominant && top.score >= 0.8);

  if (!shouldHit) {
    // -----------------------------------------------------------------------
    // DESIGN-v0.8 §A4 abstain upgrade: a single-token query whose top
    // candidates are same-fixture-root filename matches is NOT genuine
    // ambiguity — it is a multi-file recall case (e.g. query "codec" hitting
    // both codec.hpp and codec.cpp, or several bug-site files that all
    // happen to share a name-matched token) that a bare hit:false abstain
    // would otherwise misrepresent as "nothing confident found". Returning
    // hit:true with multi-primary candidates lets a task_pack re-locate fold
    // them straight into surfaces instead of receiving a second TL
    // "failure" — which is exactly what legitimizes an escape under the
    // two-strikes rule (DESIGN-v0.8 §A4: in the live multi-file C++ fix-pack
    // case, two of the bug-site files arrived as candidateDetails and still
    // escaped — see bench archive 2026-07-12b forensics).
    //
    // Gated tightly so this cannot turn genuine ambiguity into false
    // confidence: (1) single-token query only — a multi-word query has
    // enough signal that the normal success gate should decide, not this
    // upgrade; (2) only "filename-match" candidates count (the strongest
    // per-candidate signal already in the pipeline, not incidental text
    // hits); (3) every qualifying candidate must resolve to the SAME
    // project root via projectRootOf (DESIGN-v0.8 §A2's root-scoping
    // machinery) — candidates spanning multiple roots are genuine
    // cross-project ambiguity and must keep abstaining; (4) requires >=2
    // such candidates (a single filename match is "multi-primary" in name
    // only and would already have cleared the largeMargin gate above if it
    // were truly unambiguous).
    // -----------------------------------------------------------------------
    // Count REAL extracted identifier/CJK tokens, not whitespace-separated
    // words: Japanese queries routinely carry zero ASCII whitespace, so a
    // whitespace split always collapsed them to "1 word" regardless of how
    // many distinct identifiers/JA segments they actually named (R1).
    const isSingleTokenQuery = extractIdentifiers(input.query).length === 1;
    if (isSingleTokenQuery) {
      const filenameMatchCands = topN.filter((c) => c.why === "filename-match");
      const filenameMatchRoots = new Set(filenameMatchCands.map((c) => rootResolver.rootOf(c.path)));
      if (filenameMatchCands.length >= 2 && filenameMatchRoots.size === 1) {
        const upgraded = await buildMultiPrimaryHit(workspace, filenameMatchCands, topN);
        if (upgraded) return upgraded;
      }
    }

    // Ambiguous — return up to 3 candidates plus richer details. topN is
    // already C/C++ module-collapsed (source preferred) above.
    const cands = topN.slice(0, 3).map((c) => ({ path: c.path, line: c.line }));
    const ambiguousDetails = buildCandidateDetails(topN, workspace, 6);
    return abstain("ambiguous", cands, ambiguousDetails, rootSuggestion);
  }

  // Use distinctive primary if it overrides the score-ranked top.
  const primary = distinctivePrimary ?? top;

  // -------------------------------------------------------------------------
  // Compute range bounds for primary (no file read needed for snippet content)
  // -------------------------------------------------------------------------
  const { startLine, endLine } = await rangeForCandidate(workspace, primary);

  // -------------------------------------------------------------------------
  // Impact aggregation pass
  // -------------------------------------------------------------------------

  // Pre-attach a "repo" handle for the active workspace root so read_code can
  // canonicalize against it.
  handleTable.upsert({
    kind: "repo",
    workspaceRoot: workspace,
  });

  // Build primary ImpactCandidate from primary.
  const primarySurface = classifySurface(primary.path, primary.symbol);
  const primaryConfidence = Math.min(1, Math.max(0, primary.score / 2.0));
  const primaryCandidateBase: ImpactCandidate = {
    path: primary.path,
    line: primary.line,
    range: `${startLine}-${endLine}`,
    ...(primary.symbol ? { symbol: primary.symbol } : {}),
    surface: primarySurface,
    why: primary.why,
    confidence: primaryConfidence,
    required: true,
  };
  const primaryCandidate = attachHandle(workspace, primaryCandidateBase);

  // Build related candidates: recognized (non-unknown), deduped by (path, line).
  // Multi-surface changes often need more than one file within the same broad
  // role (for example service + repository + admin aggregation), so keep same-
  // surface closure candidates when the query looks cross-cutting.
  const seenPathLine = new Set<string>([`${primary.path}:${primary.line}`]);
  const allowSameSurfaceRelated = looksLikeMultiSurface(input.query);
  // Issue #2 (b): the definition the primary delegates to is part of the
  // answer even though nothing in the query names it. Admitted BEFORE the
  // filter below and exempt from its same-surface rule — a callee in the same
  // architectural layer as its caller is the normal case, not a duplicate.
  const importEdge = await importEdgeCandidates(workspace, primary, queryIdentTokens, getCodeFiles());
  const relatedRaw = [...filteredCandidates, ...importEdge]
    .filter((c) => {
      const key = `${c.path}:${c.line}`;
      if (seenPathLine.has(key)) return false;
      const surf = classifySurface(c.path, c.symbol);
      if (surf === "unknown") return false;
      if (surf === primarySurface && !allowSameSurfaceRelated && c.why !== "import-edge") return false;
      seenPathLine.add(key);
      return true;
    });

  const related: ImpactCandidate[] = selectRelatedCandidates(relatedRaw, 6).map((c) => {
    const base: ImpactCandidate = {
      path: c.path,
      line: c.line,
      range: c.range ?? ((c.endLine !== undefined)
        ? `${c.line}-${c.endLine}`
        : `${Math.max(1, c.line - 10)}-${c.line + 10}`),
      ...(c.symbol ? { symbol: c.symbol } : {}),
      surface: classifySurface(c.path, c.symbol),
      why: c.why,
      confidence: Math.min(1, Math.max(0, c.score / 2.0)),
      // DESIGN-v0.8 §A6 deliverable 1: a related candidate stays optional by
      // default (false), except when the layer that produced it explicitly
      // force-admitted it (see Candidate.required doc) — e.g. an
      // exhaustive-initializer/aggregation-map match, which both edit arms
      // of an enum-extension task need, not just the primary contract site.
      required: c.required === true,
    };
    return attachHandle(workspace, base);
  });

  // -------------------------------------------------------------------------
  // Graph index integration (additive): expand related candidates using the
  // optional static graph index. Falls back gracefully if no index exists.
  //
  // DESIGN-v0.8 §A6 deliverable 2: resolveNestedGraphIndex prefers a
  // fixture-root/nested `.tokenlighten/index/` over the workspace-root one
  // when the dominant root (§A2) points at one, and for isEnumLikeQuery
  // queries the primary symbol's FULL reference list is used instead of the
  // old `.slice(0, 3)` cap — a 19-reference enum family in the live
  // enum-task fixture previously dropped its 3rd+ reference (the
  // aggregation-service consumer) unconditionally. Non-enum queries keep the
  // 3-reference cap (unbounded expansion is not warranted there). This
  // graph path stays an OPTIONAL accelerator only: deliverable 1's findText
  // scan (addSiblingValueInitializerCandidates, tree-sitter-fallback-safe,
  // no index required) is the default that already ran above, unconditional
  // on this graph integration existing at all.
  // -------------------------------------------------------------------------
  if (graphIndexMode() !== "off") {
    // DESIGN-v0.8 §A6 deliverable 2: computeDominantRoot only returns
    // non-null when the CANDIDATE POOL spans multiple roots (its own
    // documented contract — "nothing to scope against" otherwise). When the
    // caller passed an explicit `path=` scope, every layer already confined
    // its own search to that scope, so the pool is single-root by
    // construction and dominantRoot is null EVEN THOUGH the task is
    // unambiguously about that scope's root — an explicit scope is at least
    // as strong a root signal as an inferred dominant root, so it is used
    // as the fallback root for nested-index discovery.
    //
    // P5 fix: a PATHLESS query whose candidate pool happens to be entirely
    // within ONE root (e.g. every candidate lands inside a single
    // all-in-one bench fixture) hits neither branch above: dominantRoot is
    // null (single-root pool — nothing to scope against, by
    // computeDominantRoot's own contract) AND scope is undefined (no
    // explicit path). Nested/fixture-local graph-index discovery then
    // silently fell through to the WORKSPACE-root index and never found the
    // fixture's own `.tokenlighten/index/`, even though the winning
    // candidate (`primary`, the top-scored pick) unambiguously identifies
    // which root the task is about. Falling back to
    // projectRootOf(primary.path) covers exactly this case without
    // affecting the two cases above (both take priority when applicable).
    const graphRoot = dominantRoot ?? (scope ? rootResolver.rootOf(scope) : rootResolver.rootOf(primary.path));
    const { index: graphIndex, rootPrefix } = resolveNestedGraphIndex(workspace, graphRoot);
    if (graphIndex) {
      const graphSeenPathLine = new Set<string>([
        `${primary.path}:${primary.line}`,
        ...related.map((r) => `${r.path}:${r.line}`),
      ]);

      // Expand references of the primary symbol: full list for an
      // enum-like query (the family's every consumer/aggregation site
      // matters), capped at 3 otherwise (unbounded expansion is not
      // warranted for a plain bug-fix/rename query).
      if (primary.symbol) {
        const allRefs = graphIndex.references(primary.symbol);
        const refs = isEnumLikeQuery(input.query) ? allRefs : allRefs.slice(0, 3);
        for (const rawRef of refs) {
          const refPath = reprefixGraphPath(rawRef.path, rootPrefix);
          const key = `${refPath}:${rawRef.line}`;
          if (graphSeenPathLine.has(key)) continue;
          if (isExcluded(refPath, scope)) continue;
          if (scope && !refPath.startsWith(scope + "/") && refPath !== scope) continue;
          graphSeenPathLine.add(key);
          const surf = classifySurface(refPath, undefined);
          if (surf === "unknown") continue;
          const base: ImpactCandidate = {
            path: refPath,
            line: rawRef.line,
            range: `${Math.max(1, rawRef.line - 5)}-${rawRef.line + 5}`,
            surface: surf,
            why: "graph-reference",
            confidence: 0.5,
            required: false,
          };
          related.push(attachHandle(workspace, base));
        }
      }

      // Expand 1-2 importers of the primary file. importsOf() expects a
      // path relative to the index's OWN root (which may be nested, not
      // workspace) — strip rootPrefix from primary.path before the lookup,
      // then re-prefix the results back to workspace-relative, same as refs.
      const primaryPathForIndex = rootPrefix && primary.path.startsWith(rootPrefix + "/")
        ? primary.path.slice(rootPrefix.length + 1)
        : primary.path;
      const importers = graphIndex.importsOf(primaryPathForIndex).slice(0, 2);
      for (const rawImporterPath of importers) {
        const importerPath = reprefixGraphPath(rawImporterPath, rootPrefix);
        const key = `${importerPath}:1`;
        if (graphSeenPathLine.has(key)) continue;
        if (isExcluded(importerPath, scope)) continue;
        if (scope && !importerPath.startsWith(scope + "/") && importerPath !== scope) continue;
        graphSeenPathLine.add(key);
        const surf = classifySurface(importerPath, undefined);
        if (surf === "unknown") continue;
        const base: ImpactCandidate = {
          path: importerPath,
          line: 1,
          range: "1-1",
          surface: surf,
          why: "graph-importer",
          confidence: 0.4,
          required: false,
        };
        related.push(attachHandle(workspace, base));
      }

      // -----------------------------------------------------------------------
      // V11-05 (TL_COMPOUND_RETRIEVAL, composes with TL_GRAPH_EVIDENCE): a
      // bounded read-only hop closure over graph evidence — definition ->
      // references -> representative consumers -> tests/config, realized in
      // ONE analyzeImpact call (features/compound/). Purely ADDITIVE to
      // `related`, appended LAST: `primary` and every candidate already in
      // `related` are never touched, reordered, or evicted by this block, and
      // the LOCATE_SUCCESS_CAP byte trim below (which pops `related` from the
      // END when oversized) always sacrifices these entries first — so an
      // exact-path/required floor candidate can never be displaced by a
      // compound addition. Reuses the graphIndex/rootPrefix this block already
      // resolved rather than a second lookup. See features/compound/index.ts's
      // applyCompoundRetrieval for the seed/decline/tier-mapping rules.
      // -----------------------------------------------------------------------
      if (compoundRetrievalEnabled() && graphEvidenceEnabled()) {
        const compound = applyCompoundRetrieval({
          workspace,
          graphIndex,
          rootPrefix,
          files: walkCache.get().map((f) => f.relPath),
          primary,
          candidates: filteredCandidates,
          ...(scope ? { scope } : {}),
          seenPathLine: graphSeenPathLine,
        });
        for (const candidate of compound.related) related.push(attachHandle(workspace, candidate));
        trace("compound_retrieval_applied", compound.trace, workspace);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Layer 6: C/C++ header/source closure
  // -------------------------------------------------------------------------
  for (const candidate of related) {
    seenPathLine.add(`${candidate.path}:${candidate.line}`);
  }
  // Full-workspace file list for the closure's #include lookups: backed by
  // the SAME per-call WalkCache every other `{}` (unscoped) consumer in this
  // locate() call uses (e.g. inferQueryContext's basename-frequency walk),
  // so this is not a separate walk at all when one of those already ran —
  // and, symmetrically, still lazy (never walked) for a non-C/C++ result,
  // since WalkCache.get() only walks on first access to a given option-set.
  const getWorkspaceFiles = (): FoundFile[] => walkCache.get();
  // R0 (2026-08-21, W4-A pack-augmentation-pollution forensics): a
  // header/source-pair or #include closure seed must itself be TRUSTWORTHY
  // evidence for THIS task, not merely any file that happens to already sit
  // in `related`. Before this fix, the loop below expanded EVERY entry in
  // `related` unconditionally — including a `variant-text` hit (Layer 3/4's
  // generic full-text scan) in a project root that has nothing to do with
  // the primary's own root, already penalized to (near) zero by the
  // out-of-root demotion pass above but never EXCLUDED by it. That
  // near-zero-confidence seed still spawned a full, UNPENALIZED
  // header/source + #include closure (addCppRelated's confidence is a flat
  // 0.5/0.65, independent of the seed's own score), which then out-competed
  // the query's own NAMED file for the surface budget downstream.
  //
  // Two independent conditions gate a seed, matching the two ways the
  // pollution above was shown to enter: (1) `why` must NOT be one of
  // SIBLING_SEED_WEAK_WHY — the same "not a targeted match" test R9 already
  // applies to the sibling-value structural scan, reused here rather than
  // re-invented; a plain text/variant/reference hit proves only "this token
  // appears somewhere in this file", never "this file is the right one to
  // expand". (2) the seed's path must be within the PRIMARY's own project
  // root (roleSearchScopePrefixes/isWithinRoleSearchScope — the same
  // dominant-root discipline the out-of-root demotion pass above already
  // computes, applied here as a hard admission gate rather than a soft
  // score penalty). `primary.path` itself is exempt from both checks: it is
  // the locator's own resolved answer, the strongest evidence there is.
  const closureRootPrefixes = roleSearchScopePrefixes([primary.path]);
  const isTrustworthyClosureSeed = (c: ImpactCandidate): boolean =>
    !SIBLING_SEED_WEAK_WHY.has(c.why) && isWithinRoleSearchScope(c.path, closureRootPrefixes);
  expandCppModuleClosure(workspace, primary.path, related, seenPathLine, getWorkspaceFiles);
  for (const candidate of [...related]) {
    if (related.length >= 12) break;
    if (!isTrustworthyClosureSeed(candidate)) continue;
    expandCppModuleClosure(workspace, candidate.path, related, seenPathLine, getWorkspaceFiles);
  }

  // Decide completeness and check for multi-surface abstain.
  const allSurfaces: ImpactSurface[] = [primarySurface, ...related.map((r) => r.surface)];
  const surfaceSet = new Set<ImpactSurface>(allSurfaces);
  const multiSurfaceTriggers = new Set<ImpactSurface>(["contract", "api", "ui", "style"]);

  // Required-surface accounting is restricted to IN-SCOPE-ROOT candidates
  // (DESIGN-v0.8 §A2): an out-of-root related candidate (one that survived
  // the out-of-root penalty above only because the in-root pool was sparse)
  // must not count as satisfying a required surface — a wrong-project "api"
  // file does not mean this task's api surface is covered. "In-scope" is the
  // in-scope-root SET, not just the single dominant root: for a genuine
  // two-domain wiring query (multiRoot) a related file in the SECOND in-scope
  // root is legitimately part of THIS task and counts toward coverage — the
  // design's explicit requirement that coverage/next must not treat the second
  // domain as missing. primarySurface is kept unconditionally: `primary`
  // already had any out-of-root penalty folded into its score before it won
  // the top slot, so its surface reflects the pipeline's best overall answer
  // even in the rare self-refutation case where that answer sits outside the
  // aggregate-score dominant root (penalty, not exclusion).
  const inRootSurfaceSet = dominantRoot === null
    ? surfaceSet
    : new Set<ImpactSurface>([
        primarySurface,
        ...related.filter((r) => inScopeRoots.has(effectiveRootOf(r.path))).map((r) => r.surface),
      ]);
  // `multiRoot` is surfaced here as the in-file signal that both domains'
  // surfaces count; the pack-layer integration (later workstream) reads the
  // same two-domain fact via the exported decideTwoDomainRoots seam.
  void multiRoot;

  let completeness: "complete" | "partial" | "unknown";
  let overallConfidence = primaryConfidence;
  // DESIGN-v0.8 coverage-honesty: which required role (if any) the multi-
  // surface branch found missing, surfaced on the hit so a downstream pack
  // can name it ("missing-roles") and drive a surfaceRoles=[...] re-locate.
  let missingSurfaces: ImpactSurface[] | undefined;

  if (multiSurfaceTriggers.has(primarySurface) && looksLikeMultiSurface(input.query)) {
    // DESIGN-v0.8 §A2/§A3: build this dominant root's surface inventory ONCE
    // and drop any required role the root's own files cannot supply — the
    // root-cause fix for "partial" on a firmware root that structurally has
    // no ui/style surface. The style-file extensions (.css/.scss/.less) are
    // added to the walk option-set because the default code-file walk
    // excludes them (mirrors workspaceHasStyleFiles' extraExts trick), so a
    // real stylesheet is not invisible to the inventory. Backed by the shared
    // per-call WalkCache: this exact option-set is walked at most once total.
    const inventory = surfaceInventory(
      walkCache.get({ extraExts: [".css", ".scss", ".less"] }).map((f) => f.relPath),
      effectiveRootOf,
      dominantRoot,
      (p) => classifySurface(p),
    );
    // Expand required surfaces to {contract, api, ui} plus primary, minus any
    // role absent from this root's inventory (primary is always kept).
    const required = requiredSurfacesForQuery(input.query, primarySurface, inventory);
    const { missing } = coverage(inRootSurfaceSet, required);

    if (missing.length >= 2) {
      // Too many missing surfaces — abstain with multi-surface.
      const candidatePaths = [
        { path: primary.path, line: primary.line },
        ...related.slice(0, 2).map((r) => ({ path: r.path, line: r.line })),
      ];
      const multiDetails = buildCandidateDetails(filteredCandidates.slice(0, 6), workspace, 6);
      return abstain("multi-surface", candidatePaths, multiDetails, rootSuggestion);
    } else if (missing.length === 1) {
      completeness = "partial";
      overallConfidence = 0.5;

      // Conservative "missing-surface" abstain branch:
      // Only emit when the query explicitly mentions a style token AND the
      // missing surface is "style" AND no style candidate was found.
      const missingOne = missing[0] as ImpactSurface;
      // Surface the single missing role on the hit (populated regardless of
      // the style-abstain branch below) so a downstream pack can report
      // "missing-roles" for exactly this role.
      missingSurfaces = [missingOne];
      if (
        missingOne === "style" &&
        hasStyleMarker(input.query) &&
        !inRootSurfaceSet.has("style")
      ) {
        // Abstain with missing-surface reason.
        const missingDetails = buildCandidateDetails(filteredCandidates.slice(0, 6), workspace, 6);
        return {
          hit: false,
          reason: "missing-surface",
          missing: [missingOne],
          candidates: topN.slice(0, 3).map((c) => ({
            path: c.path,
            line: c.line,
            handle: handleTable.upsert({
              kind: "range",
              path: c.path,
              range: `${c.line}-${c.line}`,
              workspaceRoot: workspace,
            }).id,
          })),
          candidateDetails: missingDetails,
        };
      }
    } else {
      completeness = "complete";
      overallConfidence = Math.max(0.7, primaryConfidence);
    }
  } else {
    // Single-surface case.
    if (related.length === 0) {
      completeness = "unknown";
    } else {
      completeness = "complete";
    }
  }

  // Build the sorted coverage list (surfaces present in this result).
  const coverageSurfaces: ImpactSurface[] = [...new Set(allSurfaces)].sort() as ImpactSurface[];

  // -------------------------------------------------------------------------
  // Build success response and enforce LOCATE_SUCCESS_CAP B JSON cap.
  // -------------------------------------------------------------------------
  let hit: LocateOutput = {
    hit: true,
    primary: [primaryCandidate],
    related,
    confidence: overallConfidence,
    completeness,
    coverage: coverageSurfaces,
    ...(missingSurfaces !== undefined ? { missingSurfaces } : {}),
    // Normally undefined on a confident hit (an in-root answer exists);
    // present only in the self-refutation case where the winning primary is
    // itself out-of-root, so the pack layer can still advise a re-scope.
    ...(rootSuggestion !== undefined ? { rootSuggestion } : {}),
  };

  const hitBytes = Buffer.byteLength(JSON.stringify(hit), "utf8");
  if (hitBytes <= LOCATE_SUCCESS_CAP) {
    return hit;
  }

  // Trim: first remove related entries from end until it fits.
  let trimmedRelated = [...related];
  while (trimmedRelated.length > 0) {
    trimmedRelated.pop();
    const candidate: LocateOutput = { ...(hit as Extract<LocateOutput, { hit: true }>), related: trimmedRelated };
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") <= LOCATE_SUCCESS_CAP) {
      return candidate;
    }
  }

  // related is now empty; trim primary down to length 1 (already is 1).
  const baseHit = { ...(hit as Extract<LocateOutput, { hit: true }>), related: [] };
  if (Buffer.byteLength(JSON.stringify(baseHit), "utf8") <= LOCATE_SUCCESS_CAP) {
    return baseHit;
  }

  // Still over cap after all trimming — abstain with not-found.
  return abstain("not-found", topN.slice(0, 3).map((c) => ({ path: c.path, line: c.line })), undefined, rootSuggestion);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CPP_EXTS = new Set([".c", ".cc", ".cpp", ".cxx", ".h", ".hpp", ".hh", ".hxx"]);
const CPP_HEADER_EXTS = new Set([".h", ".hpp", ".hh", ".hxx"]);
const CPP_SOURCE_EXTS = [".cpp", ".cc", ".cxx", ".c"];
const CPP_PAIR_HEADER_EXTS = [".h", ".hpp", ".hh", ".hxx"];

// isCppPath was a redundant wrapper around this same CPP_EXTS set — callers
// now use the shared isNativeExtPath (util/nativeSymbolRange.ts), which
// checks an identical extension set (readCodeTaskPack.ts's NATIVE_EXTS).
// CPP_EXTS itself stays local: cppPairCandidates below still needs the raw
// set for header/source pairing, out of scope for that consolidation.

function fileExists(workspace: string, relPath: string): boolean {
  try {
    fs.statSync(path.join(workspace, relPath));
    return true;
  } catch {
    return false;
  }
}

function cppPairCandidates(relPath: string): string[] {
  const ext = path.extname(relPath).toLowerCase();
  if (!CPP_EXTS.has(ext)) return [];

  const base = relPath.slice(0, relPath.length - ext.length);
  const isHeader = CPP_HEADER_EXTS.has(ext);
  const pairExts = isHeader ? CPP_SOURCE_EXTS : CPP_PAIR_HEADER_EXTS;
  const bases = new Set<string>([base]);

  if (base.includes("/include/")) {
    bases.add(base.replace("/include/", "/src/"));
  }
  if (base.includes("/src/")) {
    bases.add(base.replace("/src/", "/include/"));
  }

  const out: string[] = [];
  for (const b of bases) {
    for (const e of pairExts) {
      out.push(`${b}${e}`);
    }
  }
  return out;
}

function addCppRelated(
  workspace: string,
  relPath: string,
  related: ImpactCandidate[],
  seenPathLine: Set<string>,
  why: string,
  confidence: number,
): boolean {
  if (isExcluded(relPath) || !fileExists(workspace, relPath)) return false;
  const key = `${relPath}:1`;
  if (seenPathLine.has(key)) return false;
  seenPathLine.add(key);
  const surf = classifySurface(relPath, undefined);
  const ext = path.extname(relPath).toLowerCase();
  const fallbackSurface: ImpactSurface = CPP_HEADER_EXTS.has(ext) ? "contract" : "domain";
  const candidate = attachHandle(workspace, {
    path: relPath,
    line: 1,
    range: "1-30",
    surface: surf === "unknown" ? fallbackSurface : surf,
    why,
    confidence,
    required: false,
  });
  if (why === "header-source-pair" || why === "include-target") {
    related.unshift(candidate);
  } else {
    related.push(candidate);
  }
  return true;
}

function findIncludeTarget(
  workspace: string,
  includingPath: string,
  includeTarget: string,
  getWorkspaceFiles: () => FoundFile[],
): string | null {
  const direct = path.posix.normalize(path.posix.join(path.posix.dirname(includingPath), includeTarget));
  if (fileExists(workspace, direct)) return direct;

  for (const f of getWorkspaceFiles()) {
    if (f.relPath === includeTarget || f.relPath.endsWith(`/${includeTarget}`)) {
      return f.relPath;
    }
  }
  return null;
}

function expandCppModuleClosure(
  workspace: string,
  relPath: string,
  related: ImpactCandidate[],
  seenPathLine: Set<string>,
  getWorkspaceFiles: () => FoundFile[],
): void {
  if (!isNativeExtPath(relPath)) return;

  for (const pairPath of cppPairCandidates(relPath)) {
    if (addCppRelated(workspace, pairPath, related, seenPathLine, "header-source-pair", 0.65)) {
      break;
    }
  }

  let raw: string;
  try {
    const decoded = decodeTextBuffer(fs.readFileSync(path.join(workspace, relPath)));
    if (decoded === null) return;
    raw = decoded;
  } catch {
    return;
  }

  const includeRe = /^\s*#\s*include\s*[<"]([^>"]+)[>"]/gm;
  let incMatch: RegExpExecArray | null;
  let includeCount = 0;
  while ((incMatch = includeRe.exec(raw)) !== null && includeCount < 3) {
    const target = findIncludeTarget(workspace, relPath, incMatch[1]!, getWorkspaceFiles);
    if (!target) continue;
    if (addCppRelated(workspace, target, related, seenPathLine, "include-target", 0.5)) {
      includeCount++;
    }
  }
}

// widenNativeCandidateRange (DESIGN-v0.8 §A5 deliverable 2: for a C/C++
// text-kind candidate, widen the default ±10-line centered window to the
// ENCLOSING symbol) now lives in util/nativeSymbolRange.ts as
// `widenNativeRange`, shared with readCodeTaskPack.ts's equivalent widener
// (the two had been independent, drift-prone copies of the same
// collectSymbols-based heuristic — see that module's doc comment for the
// full rationale, including the fallback-window behavior for a file-scope
// declaration collectSymbols does not track as a symbol).

/**
 * Compute the 1-based inclusive [startLine, endLine] a Candidate's range
 * should cover: symbol end via brace/indent matching for a symbol-kind
 * candidate (no file read needed beyond that), or a centered text window
 * otherwise — widened to the enclosing symbol for a C/C++ text-kind
 * candidate (DESIGN-v0.8 §A5 deliverable 2). Extracted from the single-
 * `primary` inline computation so the §A4 multi-primary abstain-upgrade
 * path (buildMultiPrimaryHit) can reuse the exact same range logic per
 * candidate instead of drifting from it.
 */
async function rangeForCandidate(workspace: string, candidate: Candidate): Promise<{ startLine: number; endLine: number }> {
  const explicitRange = candidate.range?.match(/^(\d+)-(\d+)$/);
  if (explicitRange) {
    return { startLine: Number(explicitRange[1]), endLine: Number(explicitRange[2]) };
  }
  if (candidate.kind === "symbol" && candidate.symbol) {
    const absPath = path.join(workspace, candidate.path);
    let fileLines: string[] = [];
    try {
      const decoded = decodeTextBuffer(fs.readFileSync(absPath));
      // Undecodable is the same fallback as any other read failure here.
      if (decoded !== null) fileLines = decoded.split(/\r?\n/);
    } catch {
      // Fall back to centered window bounds.
    }
    const lang = languageForPath(candidate.path) ?? "unknown";
    const startLine = candidate.line;
    const endLine = fileLines.length > 0
      ? findSymbolEnd(fileLines, candidate.line, lang)
      : Math.min(candidate.line + TEXT_WINDOW_LINES, candidate.line + 20);
    return { startLine, endLine };
  }
  const half = Math.floor(TEXT_WINDOW_LINES / 2);
  const startLine = Math.max(1, candidate.line - half);
  const endLine = candidate.line + (TEXT_WINDOW_LINES - half);
  if (isNativeExtPath(candidate.path)) {
    return widenNativeRange(workspace, candidate.path, startLine, endLine);
  }
  return { startLine, endLine };
}

/**
 * DESIGN-v0.8 §A4 abstain upgrade: build a hit:true response with
 * MULTIPLE primary candidates (one ImpactCandidate per qualifying
 * same-fixture-root filename match), so a task_pack re-locate can fold them
 * straight into pack surfaces instead of receiving a bare abstain. Any
 * remaining topN candidates not already promoted to primary are kept as
 * `related`, same shape as the normal single-primary hit response.
 *
 * Returns null (caller falls back to the normal ambiguous abstain) only if
 * `filenameMatchCands` somehow ends up empty after handle-minting — not
 * expected given the caller's own >=2 gate, but keeps this function total
 * rather than asserting.
 */
async function buildMultiPrimaryHit(
  workspace: string,
  filenameMatchCands: Candidate[],
  topN: Candidate[],
): Promise<LocateOutput | null> {
  handleTable.upsert({ kind: "repo", workspaceRoot: workspace });

  const primary: ImpactCandidate[] = [];
  const promotedPathLine = new Set<string>();
  for (const c of filenameMatchCands) {
    const { startLine, endLine } = await rangeForCandidate(workspace, c);
    const surface = classifySurface(c.path, c.symbol);
    const confidence = Math.min(1, Math.max(0, c.score / 2.0));
    const base: ImpactCandidate = {
      path: c.path,
      line: c.line,
      range: `${startLine}-${endLine}`,
      ...(c.symbol ? { symbol: c.symbol } : {}),
      surface,
      why: c.why,
      confidence,
      required: true,
    };
    primary.push(attachHandle(workspace, base));
    promotedPathLine.add(`${c.path}:${c.line}`);
  }
  if (primary.length === 0) return null;

  const related: ImpactCandidate[] = [];
  for (const c of topN) {
    if (promotedPathLine.has(`${c.path}:${c.line}`)) continue;
    const surf = classifySurface(c.path, c.symbol);
    if (surf === "unknown") continue;
    const base: ImpactCandidate = {
      path: c.path,
      line: c.line,
      range: c.endLine !== undefined ? `${c.line}-${c.endLine}` : `${Math.max(1, c.line - 10)}-${c.line + 10}`,
      ...(c.symbol ? { symbol: c.symbol } : {}),
      surface: surf,
      why: c.why,
      confidence: Math.min(1, Math.max(0, c.score / 2.0)),
      required: false,
    };
    related.push(attachHandle(workspace, base));
  }

  const coverageSurfaces: ImpactSurface[] = [...new Set(primary.map((c) => c.surface))].sort() as ImpactSurface[];
  const overallConfidence = Math.max(...primary.map((c) => c.confidence));

  const hit: LocateOutput = {
    hit: true,
    primary,
    related,
    confidence: overallConfidence,
    // "partial", not "complete": this is a same-name multi-file recall
    // upgrade, not the pipeline's normal high-confidence single-answer
    // path — the caller (e.g. task_pack) should still treat it as
    // needing confirmation, just no longer as a bare failure.
    completeness: "partial",
    coverage: coverageSurfaces,
  };

  const hitBytes = Buffer.byteLength(JSON.stringify(hit), "utf8");
  if (hitBytes <= LOCATE_SUCCESS_CAP) return hit;

  // Trim related first, then primary (from the end), same order/strategy as
  // the normal hit-cap trim below — multi-primary candidates are the whole
  // point of this upgrade, so they are trimmed only as a last resort and
  // never below 1.
  let trimmedRelated = [...related];
  while (trimmedRelated.length > 0) {
    trimmedRelated.pop();
    const candidate: LocateOutput = { ...hit, related: trimmedRelated };
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") <= LOCATE_SUCCESS_CAP) return candidate;
  }
  let trimmedPrimary = [...primary];
  while (trimmedPrimary.length > 1) {
    trimmedPrimary.pop();
    const candidate: LocateOutput = { ...hit, primary: trimmedPrimary, related: [] };
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") <= LOCATE_SUCCESS_CAP) return candidate;
  }
  return null;
}

function buildCandidateDetails(
  candidates: Candidate[],
  workspace: string,
  limit: number,
): LocateCandidateDetail[] {
  const details: LocateCandidateDetail[] = [];
  for (const c of candidates.slice(0, limit)) {
    const surface = classifySurface(c.path, c.symbol);
    const range = c.range ?? (c.endLine
      ? `${c.line}-${c.endLine}`
      : `${Math.max(1, c.line - 10)}-${c.line + 10}`);
    const confidence = Math.min(1, Math.max(0, c.score / 2.0));
    const entry = handleTable.upsert({
      kind: c.symbol ? "symbol" : "range",
      path: c.path,
      range,
      ...(c.symbol ? { symbol: c.symbol } : {}),
      workspaceRoot: workspace,
    });
    details.push({
      path: c.path,
      line: c.line,
      ...(c.endLine !== undefined ? { endLine: c.endLine } : {}),
      ...(c.symbol ? { symbol: c.symbol } : {}),
      surface,
      range,
      why: c.why,
      confidence,
      handle: entry.id,
    });
  }
  return details;
}

// 2026-08-01 (not-found dead end): a candidate-less not-found answered
// `{hit:false,reason:"not-found"}` and nothing else — the caller could see
// neither WHICH root was searched nor a next move, so it escaped to native
// grep. Root confinement is itself intended, so this note names only the
// caller's own re-scope levers and never a path outside the searched root.
const NOT_FOUND_SCOPE_NOTE =
  "Searched this root only; if the target lives in another monorepo package, re-run with the repository root as cwd or scope with path=.";

function abstain(
  reason: "ambiguous" | "not-found" | "snippet-too-large" | "ignored-path" | "broad-query" | "multi-surface" | "missing-surface",
  candidates: Array<{ path: string; line: number }>,
  candidateDetails?: LocateCandidateDetail[],
  rootSuggestion?: string,
  searched?: { workspace: string; query: string },
): LocateOutput {
  const recoveryHandles = [...new Set((candidateDetails ?? []).map((detail) => detail.handle))].slice(0, 3);
  // Only the candidate-less not-found is a dead end; an abstain that already
  // carries candidates/handles keeps its existing recovery `next` untouched.
  const deadEnd = reason === "not-found" && candidates.length === 0 ? searched : undefined;
  const probeToken = deadEnd ? strongestIdentifierToken(deadEnd.query) : null;
  const out: LocateOutput = {
    hit: false,
    reason,
    ...(candidates.length > 0 ? { candidates: candidates.slice(0, 3) } : {}),
    ...(candidateDetails && candidateDetails.length > 0 ? { candidateDetails } : {}),
    ...(deadEnd ? { scope: deadEnd.workspace, note: NOT_FOUND_SCOPE_NOTE } : {}),
    ...(recoveryHandles.length > 0
      ? { next: `read_file handles=${JSON.stringify(recoveryHandles)}` }
      : probeToken !== null
        ? { next: `search_files action=find query=${probeToken}` }
        : {}),
    ...(rootSuggestion !== undefined ? { rootSuggestion } : {}),
  };
  return out;
}

/**
 * Longest ASCII identifier token (>= 3 chars) in a free-text query — the one
 * token worth handing to `search_files action=find`. Non-ASCII spans are
 * skipped on purpose: `find` takes an identifier, not a sentence fragment, so
 * a Japanese request still yields its embedded ASCII symbol name.
 */
function strongestIdentifierToken(query: string): string | null {
  let best: string | null = null;
  for (const token of extractIdentifiers(query)) {
    if (token.length < 3 || /[^\x00-\x7f]/u.test(token)) continue;
    if (best === null || token.length > best.length) best = token;
  }
  return best;
}

/**
 * Attach a handle to an ImpactCandidate via the singleton handle table.
 * The handle kind is "symbol" when the candidate has a symbol, "range" otherwise.
 */
function attachHandle(workspaceRoot: string, c: ImpactCandidate): ImpactCandidate {
  const kind: HandleKind = c.symbol ? "symbol" : "range";
  const entry = handleTable.upsert({
    kind,
    path: c.path,
    range: c.range,
    symbol: c.symbol,
    workspaceRoot,
    // sha omitted; will be filled by read_code when content is materialized.
  });
  return { ...c, handle: entry.id };
}

/**
 * Returns true when the query string contains a style-token marker,
 * i.e. explicit CSS variable names or BEM class token patterns.
 * Used to gate the conservative "missing-surface" abstain.
 */
function hasStyleMarker(query: string): boolean {
  return /--[a-zA-Z][-a-zA-Z0-9]*|class="[^"]*--/.test(query);
}

const STYLE_EXTS = new Set([".css", ".scss", ".less"]);
const STYLE_EXTRA_EXTS = [".css", ".scss", ".less"];

/**
 * Scan style files for lines matching any stem pattern. Takes the caller's
 * WalkCache-backed file list so the shared DEFAULT_IGNORE rules apply and no
 * duplicate walk is issued — a previous hand-rolled readdir recursion here
 * skipped only a tiny hardcoded set, so ignored trees (.claude/ worktree
 * copies, proto/, and the bench-planted bench/fixtures/_buggy/ mirrors,
 * which are tracked and therefore present in bench worktrees) leaked style
 * candidates into packs and made the scan walk entire stale repo copies.
 */
function scanStyleFiles(files: ReadonlyArray<FoundFile>, stems: string[], cb: (relPath: string, line: number) => void): void {
  for (const f of files) {
    if (!STYLE_EXTS.has(f.ext)) continue;
    let raw: string;
    try {
      const decoded = decodeTextBuffer(fs.readFileSync(f.absPath));
      if (decoded === null) continue;
      raw = decoded;
    } catch { continue; }
    const lines = raw.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (stems.some((s) => line.includes(s))) {
        cb(f.relPath, i + 1);
        break; // one hit per file is enough
      }
    }
  }
}

/** Return the longest all-caps identifier (>=6 chars) in the query, or null. */
function extractDistinctiveToken(query: string): string | null {
  const matches = query.match(/\b[A-Z][A-Z0-9_]{5,}\b/g) ?? [];
  if (matches.length === 0) return null;
  return matches.reduce((a, b) => (b.length > a.length ? b : a));
}

/**
 * Split a file basename into its constituent lowercase word tokens, breaking
 * snake_case, kebab-case, and camelCase/PascalCase boundaries. Used by the
 * filename-match layer so a name like "wave_shaper" or "logRotator"
 * contributes its individual parts ("wave"/"shaper", "log"/"rotator")
 * for matching against query tokens — a file whose NAME describes the query
 * is a strong relevance signal even when some unrelated file merely contains
 * a common query word as text.
 */
function splitBasenameTokens(basename: string): string[] {
  return basename
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[_\-\s.]+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length > 0);
}

/**
 * Whether a query token matches a file's COMPACTED basename (separators
 * removed) WITHOUT crossing one of that name's own word boundaries.
 *
 * The compacted form exists for two real cases: a short token living inside
 * one name word ("repo" in `qkf-report`, "enum" in `enums` — below the
 * per-token containment floor the caller applies) and a query token that
 * spells a multi-word name with its separators dropped ("logrotator" for
 * `log_rotator`). A bare `fullName.includes(qt)` covers both, but it ALSO
 * admits a span that exists only because compaction removed a boundary:
 * `readCodeCaps.spec.ts` compacts to "readcodecapsspec", which contains
 * "codec" across the `code`|`caps` seam — so it name-matched, and outranked
 * real hits on, every codec query. Issue #2 (c).
 *
 * So: admit a span that lies entirely INSIDE one name token, or one that is
 * an exact join of CONSECUTIVE whole tokens. Never a partial span across a
 * seam.
 */
function matchesCompactedBasename(fullName: string, nameTokens: readonly string[], qt: string): boolean {
  if (fullName === qt) return true;
  for (const nameToken of nameTokens) {
    if (nameToken.includes(qt)) return true;
  }
  for (let i = 0; i < nameTokens.length; i++) {
    let joined = "";
    for (let j = i; j < nameTokens.length; j++) {
      joined += nameTokens[j]!;
      if (joined.length > qt.length) break;
      if (joined === qt) return true;
    }
  }
  return false;
}

/**
 * Decide whether a file's basename is a high-signal match for the query and,
 * if so, how strongly. Returns the set of DISTINCT query tokens matched by
 * the basename (or null when the match is too weak to admit).
 *
 * Admission rule (precise, to avoid flooding the pool with single-common-word
 * matches such as every "*_mode.hpp" for the word "mode"):
 *   (a) the basename matches >= 2 distinct substantial query tokens, OR
 *   (b) it matches a single DISTINCTIVE token.
 *
 * Distinctiveness (DESIGN-v0.8 §A2 "basename admission symmetry") is judged
 * by WORKSPACE BASENAME FREQUENCY, not raw token length: a matched token is
 * distinctive when it names <= BASENAME_RARITY_THRESHOLD files in this
 * workspace, regardless of how many characters it has. This is what lets a
 * short, corroborated token admit a compound basename below the old 5-char
 * floor — "wave" (4 chars) legitimately naming one rare module
 * (wave_shaper.hpp) is distinctive there, while "wave" spread across five
 * sibling "*_wave.hpp" files is not (the workspace frequency IS the second,
 * corroborating weak signal: rarity substitutes for length). It also lets a
 * 3-letter acronym like "pll" admit when "pll.cpp"/"pll.hpp" are the only
 * basenames carrying that token, and lets "enum" admit "enums.ts" via the
 * whole-name-contains match when "enums" is workspace-rare — the same
 * mechanism that made "status" (6 chars, but spread across dozens of
 * basenames) correctly non-distinctive is what makes "enums" (5 chars, one
 * file) distinctive; length alone predicted neither correctly.
 *
 * When no frequency table is supplied (frequency === undefined), the
 * function falls back to the historical raw-length->=5 rule — this keeps
 * every call site that has not been threaded through a QueryContext (there
 * are none in production, but this keeps the helper safe to unit-test in
 * isolation) working exactly as before.
 *
 * `frequency` accepts either a pre-built Map (unit-test call sites, and the
 * eager inferQueryContext path which has already built the table by the time
 * it calls this) OR a lazy `() => Map` getter (the QueryContext.
 * getBasenameFrequency call site). The getter is invoked ONLY when actually
 * needed for the single-token rarity check below — i.e. only after
 * `matched.size === 0` has already returned null and `matched.size >= 2` has
 * not already short-circuited admission. Most files exit at
 * `matched.size === 0` first, so passing a getter (instead of forcing the
 * caller to eagerly call it as an argument expression) is what keeps the
 * underlying workspace walk from firing before it is known to be needed.
 *
 * IMPORTANT: the frequency lookup is keyed by the BASENAME-side token a hit
 * actually matched (nt, or the whole compacted basename for a whole-name
 * hit) — NOT the raw query token. These differ exactly in the singular/
 * plural case this rule exists to serve: query token "enum" hits basename
 * token "enums" via the whole-name-contains path, and buildBasenameFrequency
 * indexes "enums" (what appears in the workspace), never "enum" (what the
 * query said). Looking up frequency.get(queryToken) would silently always
 * miss for every plural-basename admission.
 *
 * A query token counts as substantial when it is >= 3 chars and not a stop
 * word. A basename token matches a query token when they are equal, or when
 * one contains the other as a substring of length >= 4 (so "shaper"
 * matches the query token "shaper", and a query token "codec" matches the
 * whole-name file "codec").
 *
 * Exported for direct unit testing (DESIGN-v0.8 §A2 basename-admission
 * symmetry regression tests) — full-pipeline integration tests cannot
 * reliably isolate this admission rule alone, since a realistic file whose
 * NAME matches a query token almost always also contains that token as
 * literal text in its own body (imports, namespace/class names, comments),
 * which lets an unrelated layer (variant-text / reference search)
 * independently surface the same file regardless of whether this admission
 * rule fires.
 */
/**
 * R8: true when `relPath` is a pure re-export barrel — its only non-blank,
 * non-comment lines are `export * from "..."` / `export { ... } from "..."`
 * — with no declaration of its own. Used to demote a basename-match tie
 * between a shim (e.g. tools/readCodeTaskPack.ts) and the real
 * implementation it re-exports (features/task-pack/readCodeTaskPack.ts).
 * Cheap by construction: a real barrel is always tiny, so the size guard
 * below skips reading almost every candidate outright.
 */
function isPureReexportBarrel(workspace: string, relPath: string): boolean {
  try {
    const abs = path.join(workspace, relPath);
    if (fs.statSync(abs).size > 2048) return false;
    const text = decodeTextBuffer(fs.readFileSync(abs));
    if (text === null) return false;
    const codeLines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("//") && !l.startsWith("*") && !l.startsWith("/*"));
    if (codeLines.length === 0) return false;
    return codeLines.every((l) => /^export\s+(\*|\{[^}]*\})\s+from\s+["'][^"']+["'];?$/.test(l));
  } catch {
    return false;
  }
}

export function matchBasenameTokens(
  relPath: string,
  queryTokens: string[],
  frequency?: Map<string, number> | (() => Map<string, number>),
  resolvedSymbolFiles?: ReadonlyMap<string, ReadonlySet<string>>,
): Set<string> | null {
  const base = path.basename(relPath, path.extname(relPath));
  const nameTokens = splitBasenameTokens(base);
  if (nameTokens.length === 0) return null;
  const fullName = base.replace(/[_\-.]/g, "").toLowerCase();

  const matched = new Set<string>();
  // Frequency must be looked up by the BASENAME-side token the hit actually
  // matched against (nt, or fullName for a whole-name hit) — NOT the raw
  // query token. These differ precisely in the case this rule exists to
  // handle: the singular/plural enum-family match (query "enum" hitting
  // basename token "enums") means buildBasenameFrequency indexed "enums",
  // and frequency.get("enum") would always miss. Track the matched
  // basename-side key per query token so the distinctiveness check below
  // looks up the identifier that actually exists in the frequency table.
  const freqKeyForToken = new Map<string, string>();
  // R0 (attempted, then REVERTED — Issue #4, 2026-08-21): the query
  // "buildInitializeInstructions" (a bare identifier, or embedded in a
  // larger EN/JA sentence) falsely filename-matched serverInstructions.ts
  // and serverBuild.spec.ts, because this loop's qt.includes(nt) direction
  // admits a long query token merely CONTAINING a shorter basename word
  // ("instructions", "build"), with no bound on how much of qt's own
  // length/word-composition that fragment accounts for. Two length/ratio
  // fixes were tried and both reverted:
  //   - a per-nt length ratio (nt must cover >= half of qt): broke the
  //     PRE-EXISTING "two-domain wiring" test, where query token
  //     "computeEstimatorHealthScore" legitimately matches BOTH "estimator"
  //     AND "health" (two DIFFERENT nameTokens, each individually under
  //     half of qt's length, but together most of it) — a per-token bar
  //     rejects each in isolation.
  //   - a CUMULATIVE coverage ratio (sum matched-nt lengths >= half of qt):
  //     fixed that, but the SAME "two-domain wiring" test also needs a
  //     SINGLE-word match ("telemetry" alone, matching query token
  //     "publishTelemetryHealthField") to admit — and by raw length,
  //     "telemetry"/qt = 9/28 ≈ 32% coverage while the BAD
  //     "instructions"/qt = 12/28 ≈ 43% — the bug case has HIGHER
  //     fractional coverage than the legitimate case. No length- or
  //     word-count-based ratio on the (qt, nt) pair alone can separate them.
  //
  // A THIRD attempt (`resolvedSymbolFiles`, threading through "Layer 2
  // already has an exact, workspace-unique symbol match for qt in a
  // DIFFERENT file") fixed the bug correctly in isolation, but wiring it
  // into the LIVE Layer 5a call regressed the "two-domain wiring" test via
  // an indirect path this file's own history had not mapped: that test's
  // success gate (locateTaskContext's `coverageDominant`/`largeMargin`)
  // depends on the exact matched-token COUNT this function returns, and the
  // fragment credit the fix removes was — accidentally — load-bearing score
  // mass for an UNRELATED tie-break, not evidence the admission rule itself
  // needed. Reverted from the LIVE Layer 5a caller (which passes no 4th
  // argument, so `resolvedSymbolFiles` is always undefined there and this
  // function's behavior for every existing caller is UNCHANGED byte-for-
  // byte) and re-applied instead as a POST-HOC surface filter in
  // readCodeTaskPack.ts (buildTaskChangeContract's caller), which can see
  // the FINAL surface list without perturbing the locator's internal
  // scoring. That filter is the only caller that passes a defined
  // `resolvedSymbolFiles` (activating `strict` below).
  const strict = resolvedSymbolFiles !== undefined;
  // Per-token match provenance for the `strict`-only generic-noun veto
  // below: true when qt's ONLY admission came from a >= 5-char substring
  // CONTAINMENT (either direction) rather than an exact nameToken match or
  // an exact whole-compacted-name match. A generic word (see GENERIC_NOUNS)
  // is trustworthy evidence when it names a file exactly (query "status"
  // for a real status.ts) but not when it merely happens to be a substring
  // of an unrelated longer word (query "issue" inside a file whose name is
  // "cumulativeReissueReceipt" — "reissue", not "issue", is that file's
  // actual subject).
  const isFragmentMatch = new Map<string, boolean>();
  for (const qt of queryTokens) {
    // CJK (field-report fix, 2026-08-27): the ASCII-tuned length-3 floor
    // below exists to drop noisy short ASCII words; a 2-character Japanese
    // compound (処理/設定/状態/認証…) is frequently a complete, meaningful
    // technical term, so it gets its own (still deliberately conservative)
    // floor of 2 instead. ASCII tokens are entirely unaffected — isCjk is
    // false for every one of them, so this reduces to the ORIGINAL `< 3`
    // check byte-for-byte.
    const isCjk = /[^\x00-\x7f]/u.test(qt);
    if (qt.length < (isCjk ? 2 : 3) || STOP_WORDS.has(qt)) continue;
    let hit = false;
    let freqKey = qt;
    let fragment = false;
    for (const nt of nameTokens) {
      if (nt === qt) { hit = true; freqKey = nt; fragment = false; break; }
      // Substring containment either direction, but only for reasonably long
      // overlaps: BOTH tokens must be >= 5 chars. The old guard checked only the
      // QUERY token length, so a long, distinctive-looking query word could be
      // satisfied by containing a short, common name token (and vice versa) —
      // e.g. "steering"⊃"ring"→ring_buffer, "applied"⊃"app"→app_main,
      // "index"/"handling"⊃"in"→inMemoryStore. Since the effective overlap is
      // only as long as the SHORTER token, a shared span shorter than 5 chars is
      // too weak to be high-signal (and worse, would inherit the distinctiveness
      // of the longer token in the admission rule below). Exact equality (above)
      // and whole-name matching (below) still match shorter tokens.
      //
      // 2026-08-21 (W4-B, defect 2 / R11 pool entry): a fix restricting the
      // `qt.includes(nt)` direction for compound (underscore/hyphen-joined)
      // query tokens was ATTEMPTED and REVERTED here. It correctly stopped
      // "search_files" (containing "search") from admitting
      // searchReferences.ts on two distinct tokens
      // ({"search_files","references"}) and demoting findReferences.ts's own
      // exact "references" match — see the probe in the W4-B wave report —
      // but it also blocks EVERY other underscore-joined query token from
      // this containment path, including enum-member literals like
      // "URGENT_PLUS" that legitimately need it: reverting restored
      // replayCorpus.spec.ts's "turn-economy wave 3" tew3_2/tew3_3 cases
      // (query: "add URGENT_PLUS to the Priority enum") to green. A correct
      // fix needs to distinguish a compound MCP-tool-name token from a
      // compound enum-member token specifically, not compound-ness alone;
      // left as a residual per W3-A's prior basename-scoring findings (3
      // earlier attempts at this same function also broke corpus cases).
      if (qt.length >= 5 && nt.length >= 5 && (nt.includes(qt) || qt.includes(nt))) {
        hit = true; freqKey = nt; fragment = true; break;
      }
    }
    // Also allow a query token to match the whole compacted basename
    // (e.g. query "codec" -> file "codec", "logrotator" -> "log_rotator",
    // or the enum/plural family case "enum" -> "enums") — but only where the
    // match respects the compacted name's OWN word boundaries; see
    // matchesCompactedBasename for why a bare `includes` is not enough.
    if (!hit && qt.length >= 4 && matchesCompactedBasename(fullName, nameTokens, qt)) {
      hit = true; freqKey = fullName; fragment = fullName !== qt;
    }
    if (hit) {
      matched.add(qt);
      freqKeyForToken.set(qt, freqKey);
      isFragmentMatch.set(qt, fragment);
    }
  }

  if (matched.size === 0) return null;
  // strict mode's fragment-of-a-resolved-elsewhere-identifier veto: only
  // reachable here (not inline in the loop above) because it must know the
  // FULL matched set — a qt that fragment-matched nt is still corroborating
  // evidence when some OTHER qt in this same matched set independently
  // resolves the file (e.g. a second, in-file-unique identifier), so this
  // only strips a fragment hit when it is qt's ONLY admitted evidence AND
  // qt itself already resolved to a different file entirely.
  if (strict && resolvedSymbolFiles) {
    for (const qt of [...matched]) {
      if (!isFragmentMatch.get(qt)) continue;
      const resolvedTo = resolvedSymbolFiles.get(qt);
      if (resolvedTo !== undefined && !resolvedTo.has(relPath)) {
        matched.delete(qt);
        freqKeyForToken.delete(qt);
        isFragmentMatch.delete(qt);
      }
    }
    if (matched.size === 0) return null;
  }
  // >= 2 distinct matched tokens already admits outright — do not resolve a
  // lazy `frequency` getter (i.e. do not trigger its workspace walk) when the
  // rarity check is not even going to be consulted.
  if (matched.size >= 2) return matched;

  const freqMap = typeof frequency === "function" ? frequency() : frequency;
  const hasDistinctive = freqMap
    ? [...matched].some((t) => {
        if (STOP_WORDS.has(t)) return false;
        if (strict && isFragmentMatch.get(t) && GENERIC_NOUNS.has(t)) return false;
        const key = freqKeyForToken.get(t) ?? t;
        return (freqMap.get(key) ?? Infinity) <= BASENAME_RARITY_THRESHOLD;
      })
    : [...matched].some((t) =>
        t.length >= 5 && !STOP_WORDS.has(t) && !(strict && isFragmentMatch.get(t) && GENERIC_NOUNS.has(t)),
      );
  if (hasDistinctive) return matched;
  return null;
}

/**
 * Count of DISTINCT BASENAME tokens (splitBasenameTokens) that at least one
 * query token matched, using the SAME containment rule as matchBasenameTokens
 * (equality, or a >= 5-char substring overlap either direction, or a
 * whole-compacted-name match). matchBasenameTokens returns the set of matched
 * QUERY tokens, which counts two DIFFERENT query tokens hitting the SAME name
 * token as "2" — but for the kind-aware out-of-root demotion (DESIGN-v0.8
 * cross-package fix) a genuinely STRONG filename signal must span >= 2 distinct
 * NAME concepts (e.g. wave_shaper ⇐ "wave"+"shaper"), not two query
 * tokens sharing one stem (e.g. fourier_notes where both "fourierFilterStep" and
 * "fourierGain" collapse onto the single name token "fourier" — a
 * single-name-concept match that must stay demoted with the full penalty).
 * This is why the strong-match set is keyed on DISTINCT-basename-token count
 * here, not on matchBasenameTokens' query-token-count.
 */
function distinctBasenameTokensMatched(relPath: string, queryTokens: string[]): number {
  const base = path.basename(relPath, path.extname(relPath));
  const nameTokens = splitBasenameTokens(base);
  if (nameTokens.length === 0) return 0;
  const fullName = base.replace(/[_\-.]/g, "").toLowerCase();
  const hitNameTokens = new Set<string>();
  for (const qtRaw of queryTokens) {
    const qt = qtRaw.toLowerCase();
    if (qt.length < 3 || STOP_WORDS.has(qt)) continue;
    for (const nt of nameTokens) {
      if (nt === qt || (qt.length >= 5 && nt.length >= 5 && (nt.includes(qt) || qt.includes(nt)))) {
        hitNameTokens.add(nt);
      }
    }
    // Whole-compacted-name hit counts as covering the full name (one concept).
    if (qt.length >= 4 && (fullName === qt || fullName.includes(qt))) hitNameTokens.add(fullName);
  }
  return hitNameTokens.size;
}

/**
 * Score for a filename/basename match, scaling with the number of distinct
 * query tokens the name matched. Tuned so ANY admitted filename match ranks at
 * or above the Layer-3 exact-text baseline (1.2): a file whose NAME matches
 * the query (e.g. "codec" for the query token "codec", or "wave_shaper"
 * for "wave"+"shaper") is more relevant than a file that merely contains a
 * common query word as text (e.g. an unrelated file containing "buffer", or
 * a sibling header containing "shaper" only in an #include line). A single
 * DISTINCTIVE-token match sits just above the baseline; multi-token matches
 * climb further with each additional matched term. All stay below the
 * exact-symbol score (2.0) so a true symbol declaration still wins.
 */
function basenameMatchScore(matchedCount: number): number {
  switch (matchedCount) {
    case 0: return 0;
    case 1: return 1.25;
    case 2: return 1.5;
    default: return 1.7; // 3+
  }
}

/**
 * Does a query token match a NAME token? Equality, or a >= 5-char containment
 * either way — deliberately the SAME rule matchBasenameTokens admits a
 * basename on, so "this file's name is about token X" and "this candidate
 * covers token X" can never disagree ("classified" matching the basename
 * token "class" but then counting as zero coverage is exactly the kind of
 * split that demoted a correct answer out of the pack).
 */
function queryTokenMatchesName(queryToken: string, nameToken: string): boolean {
  if (queryToken === nameToken) return true;
  return queryToken.length >= 5 && nameToken.length >= 5 &&
    (nameToken.includes(queryToken) || queryToken.includes(nameToken));
}

/** The subset of `queryTokens` that some token of `nameTokens` matches. */
function queryTokensCoveredByNames(queryTokens: readonly string[], nameTokens: Iterable<string>): string[] {
  const names = [...nameTokens];
  return queryTokens.filter((qt) => names.some((nt) => queryTokenMatchesName(qt, nt)));
}

/** An ASCII identifier token usable for coverage bookkeeping (CJK spans are not). */
function isAsciiQueryToken(token: string): boolean {
  return token.length >= 3 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(token);
}

/**
 * The query identifier tokens a candidate demonstrably covers: whatever the
 * producing layer recorded (`Candidate.covers`) plus everything derivable from
 * its own NAMES — the file's basename tokens and, when it has one, its symbol
 * name's tokens. Pure and cheap: no file read, no parse.
 */
function coveredQueryTokens(candidate: Candidate, asciiQueryTokens: readonly string[]): Set<string> {
  const covered = new Set<string>();
  for (const t of candidate.covers ?? []) covered.add(t);
  const nameTokens = new Set<string>([
    ...splitBasenameTokens(path.basename(candidate.path, path.extname(candidate.path))),
    ...(candidate.symbol ? splitBasenameTokens(candidate.symbol) : []),
  ]);
  for (const t of queryTokensCoveredByNames(asciiQueryTokens, nameTokens)) covered.add(t);
  return covered;
}

/**
 * Lowercase word tokens of every ASCII identifier in a slice of source text
 * (camelCase/snake_case decomposed, same splitter the basename rule uses), so
 * "which query concepts does this code talk about" is one set-membership test.
 */
function identifierTokensIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) {
    for (const t of splitBasenameTokens(raw)) out.add(t);
  }
  // CJK (field-report fix, 2026-08-27): the ASCII-only regex above never
  // matches a Han/Hiragana/Katakana character, so Japanese comments/strings
  // inside a symbol's body contributed NOTHING to this coverage check —
  // refineFilenameMatchSymbol (this function's only caller) could never
  // credit a declaration whose BODY discusses the query's Japanese concept,
  // only one whose body happens to reuse an ASCII identifier verbatim.
  // extractCjkTokens's runs/bigrams/Han-unigrams are already whole,
  // meaningful units (see util/cjkSpans.ts) added directly — routing them
  // through splitBasenameTokens (an ASCII camelCase/snake_case splitter)
  // would be a no-op at best.
  for (const t of extractCjkTokens(text)) out.add(t);
  return out;
}

/** How many import-edge neighbours a primary may pull into `related`. */
const IMPORT_EDGE_MAX = 2;
/** Score for an import-edge neighbour: high enough to be kept, never to compete for `primary`. */
const IMPORT_EDGE_SCORE = 0.9;
/** ES/TS import statement: named bindings and/or a default binding, plus the module specifier. */
const IMPORT_STATEMENT_RE =
  /import\s+(?:type\s+)?(?:\{([^}]*)\}|([A-Za-z_$][\w$]*)\s*(?:,\s*\{([^}]*)\})?)\s*from\s*["']([^"']+)["']/g;
/** Languages whose module graph IMPORT_STATEMENT_RE understands. */
const IMPORT_EDGE_LANGS: ReadonlySet<string> = new Set(["typescript", "tsx", "javascript", "jsx"]);

/** Resolve a RELATIVE ES module specifier to a workspace-relative file that actually exists. */
function resolveRelativeModule(fromRelPath: string, spec: string, files: ReadonlySet<string>): string | undefined {
  if (!spec.startsWith(".")) return undefined;
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(fromRelPath), spec));
  const stripped = joined.replace(/\.(js|mjs|cjs)$/, "");
  for (const candidate of [
    joined, `${stripped}.ts`, `${stripped}.tsx`, `${stripped}.mts`, `${stripped}.js`, `${stripped}.mjs`,
    `${stripped}/index.ts`, `${stripped}/index.tsx`, `${stripped}/index.js`,
  ]) {
    if (files.has(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Issue #2 (b): pull the definition the primary DELEGATES TO into the frontier.
 *
 * "Which codec does the pipeline choose" is answered by two files: the one
 * that runs the choice (`applyResponseCodec`) and the one that makes it
 * (`selectForWire`). Nothing in the query names the second — no token matches
 * `selectForWire` or `policy` — so every name/text/symbol layer above rates it
 * an also-ran, and the same-surface `related` filter then drops it because it
 * shares the primary's surface. The edge that DOES name it is structural: the
 * primary's own file imports it, and the primary's own body calls it.
 *
 * So: of the workspace-local bindings the primary symbol's body actually
 * references, admit the definitions of at most IMPORT_EDGE_MAX, preferring
 * (1) a binding the body CALLS over one it only names in a type position,
 * (2) a binding whose name carries a query token, (3) a target path that
 * does, (4) the module the primary leans on most, (5) the one it reaches
 * first. Within a target the substantive definition wins — the longest called
 * one, i.e. the implementation rather than the predicate beside it.
 */
async function importEdgeCandidates(
  workspace: string,
  primary: Candidate,
  queryTokens: readonly string[],
  workspaceFiles: readonly FoundFile[],
): Promise<Candidate[]> {
  if (!primary.symbol) return [];
  let text: string;
  try {
    const abs = path.join(workspace, primary.path);
    if (fs.statSync(abs).size > FILENAME_SYMBOL_REFINE_MAX_BYTES) return [];
    const decoded = decodeTextBuffer(fs.readFileSync(abs));
    if (decoded === null) return [];
    text = decoded;
  } catch {
    return [];
  }
  const lang = languageForPathWithContent(primary.path, text);
  if (lang === undefined || !IMPORT_EDGE_LANGS.has(lang)) return [];

  const lines = text.split(/\r?\n/);
  const bodyEnd = findSymbolEnd(lines, primary.line, lang);
  const bodyText = lines.slice(primary.line - 1, bodyEnd).join("\n");
  if (bodyText === "") return [];

  const fileSet = new Set(workspaceFiles.map((f) => f.relPath));
  // binding name -> { target, order } for every workspace-local import.
  const bindings = new Map<string, { target: string; order: number }>();
  let order = 0;
  IMPORT_STATEMENT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IMPORT_STATEMENT_RE.exec(text)) !== null) {
    const target = resolveRelativeModule(primary.path, m[4]!, fileSet);
    if (target === undefined || target === primary.path) continue;
    const names = [
      ...(m[1] ?? "").split(","),
      ...(m[2] !== undefined ? [m[2]] : []),
      ...(m[3] ?? "").split(","),
    ];
    for (const raw of names) {
      // `A as B` binds B; `type A` is still a binding for reference purposes.
      const name = raw.replace(/\btype\b/g, " ").split(/\bas\b/).pop()?.trim() ?? "";
      if (!/^[A-Za-z_$][\w$]*$/.test(name)) continue;
      if (!bindings.has(name)) bindings.set(name, { target, order: order++ });
    }
  }
  if (bindings.size === 0) return [];

  // Which bindings does the primary's OWN body reference?
  const byTarget = new Map<string, { names: string[]; firstOrder: number }>();
  for (const [name, { target, order: ord }] of bindings) {
    if (!new RegExp(`\\b${name}\\b`).test(bodyText)) continue;
    const entry = byTarget.get(target);
    if (entry === undefined) byTarget.set(target, { names: [name], firstOrder: ord });
    else { entry.names.push(name); entry.firstOrder = Math.min(entry.firstOrder, ord); }
  }
  if (byTarget.size === 0) return [];

  const picked: Array<{
    candidate: Candidate; nameCover: number; pathCover: number; count: number; order: number; delegated: boolean;
  }> = [];
  for (const [target, { names, firstOrder }] of byTarget) {
    let targetText: string;
    try {
      const abs = path.join(workspace, target);
      if (fs.statSync(abs).size > FILENAME_SYMBOL_REFINE_MAX_BYTES) continue;
      const decoded = decodeTextBuffer(fs.readFileSync(abs));
      if (decoded === null) continue;
      targetText = decoded;
    } catch {
      continue;
    }
    const targetLang = languageForPathWithContent(target, targetText);
    if (targetLang === undefined) continue;
    let symbols: CollectedSymbol[];
    try {
      symbols = await collectSymbols(targetText, targetLang, {});
    } catch {
      continue;
    }
    // A binding the body CALLS is something the primary delegates to; one it
    // only names in a type position is a shape it passes through. Prefer the
    // former, and within either group the longest definition — the
    // implementation rather than the predicate or alias beside it.
    const called = new Set(names.filter((n) => new RegExp(`\\b${n}\\s*[(<]`).test(bodyText)));
    const wanted = new Set(names);
    let best: CollectedSymbol | undefined;
    let bestCalled = false;
    for (const sym of symbols) {
      if (sym.enclosingSymbol !== undefined) continue;
      if (!wanted.has(sym.name)) continue;
      const isCalled = called.has(sym.name);
      if (best === undefined || (isCalled && !bestCalled)) { best = sym; bestCalled = isCalled; continue; }
      if (isCalled === bestCalled && sym.endLine - sym.startLine > best.endLine - best.startLine) {
        best = sym;
        bestCalled = isCalled;
      }
    }
    if (best === undefined) continue;
    const nameTokens = splitBasenameTokens(best.name);
    const pathTokensOfTarget = target.toLowerCase().split(/[/.]/);
    picked.push({
      candidate: {
        path: target,
        line: best.signatureStartLine,
        endLine: best.endLine,
        symbol: best.name,
        kind: "symbol",
        score: IMPORT_EDGE_SCORE,
        why: "import-edge",
        required: true,
      },
      nameCover: queryTokensCoveredByNames(queryTokens, nameTokens).length,
      pathCover: queryTokensCoveredByNames(queryTokens, pathTokensOfTarget).length,
      count: called.size,
      order: firstOrder,
      delegated: bestCalled,
    });
  }

  picked.sort((a, b) =>
    Number(b.delegated) - Number(a.delegated) ||
    b.nameCover - a.nameCover ||
    b.pathCover - a.pathCover ||
    b.count - a.count ||
    a.order - b.order);
  return picked.slice(0, IMPORT_EDGE_MAX).map((entry) => entry.candidate);
}

/** Cap on how many filename-matched files get a symbol-level refinement parse per locate() call. */
const FILENAME_SYMBOL_REFINE_LIMIT = 10;
/** Files larger than this are not parsed for filename-match symbol refinement. */
const FILENAME_SYMBOL_REFINE_MAX_BYTES = 512 * 1024;

/**
 * Issue #2 (a): inside a filename-matched file, pick the symbol that answers
 * the REST of the query.
 *
 * A basename match says "this FILE is about token X"; it says nothing about
 * WHERE in the file to look. The pool's line for such a file is whatever an
 * earlier layer happened to surface — for a symbol index that matched on the
 * file's name, that is simply the file's FIRST symbol, which is routinely the
 * wrong slice (pipeline.ts served `emitShadowTrace` for "which codec does the
 * pipeline choose" while the answer, `applyResponseCodec`, sat further down
 * and never entered the pool at all, because the per-token symbol search's
 * own result cap had already truncated it away).
 *
 * So: parse the file and choose the symbol whose own NAME tokens cover the
 * most query tokens the basename did NOT already cover, preferring a
 * top-level symbol (no enclosing symbol) over a nested one — a local
 * `const codecId` inside an unrelated function is not the answer to "which
 * codec", the exported function whose name carries "Codec" is. Ties fall back
 * to the existing rule, document order.
 *
 * Returns null when nothing in the file covers an outstanding token, in which
 * case Layer 5a keeps its previous behaviour exactly.
 */
async function refineFilenameMatchSymbol(
  workspace: string,
  relPath: string,
  remainingTokens: readonly string[],
): Promise<{ symbol: string; line: number; endLine: number; covered: string[] } | null> {
  let text: string;
  try {
    const abs = path.join(workspace, relPath);
    if (fs.statSync(abs).size > FILENAME_SYMBOL_REFINE_MAX_BYTES) return null;
    const decoded = decodeTextBuffer(fs.readFileSync(abs));
    if (decoded === null) return null;
    text = decoded;
  } catch {
    return null;
  }
  const lang = languageForPathWithContent(relPath, text);
  if (!lang) return null;
  let symbols: CollectedSymbol[];
  try {
    symbols = await collectSymbols(text, lang, {});
  } catch {
    return null;
  }
  const lines = text.split(/\r?\n/);

  // R6: the basename covering EVERY query token leaves nothing outstanding
  // to refine against (matchBasenameTokens already admitted the file on the
  // name alone) — the file's FIRST declaration used to win by default
  // (coveragePackerV2.ts's CoveragePackerV2Input interface, not its actual
  // entry point packForCoverageV2). Fall back to a substantive-declaration
  // preference keyed on the FILE'S OWN basename instead of an outstanding
  // query token — see bestSubstantiveDeclaration.
  if (remainingTokens.length === 0) {
    return bestSubstantiveDeclaration(relPath, symbols, lines);
  }

  // Prose is not evidence: a doc comment above a declaration routinely names
  // the neighbouring symbol ("forces the next `applyResponseCodec` call"),
  // which would hand every declaration in the file the same body coverage.
  const commentLine = classifyCommentLines(text, lang);
  let best: {
    symbol: CollectedSymbol; covered: string[]; body: number; topLevel: boolean; isExactMatch: boolean;
  } | null = null;
  for (const sym of symbols) {
    const covered = queryTokensCoveredByNames(remainingTokens, splitBasenameTokens(sym.name));
    if (covered.length === 0) continue;
    // Secondary signal: how much of the outstanding query the symbol's OWN
    // BODY talks about. Two declarations can carry the same token in their
    // name (`applyResponseCodec` and `ApplyResponseCodecV2Overrides`); the
    // one whose body is also about that concept is the implementation, not
    // the incidental options bag beside it.
    // Body = strictly what follows the signature. The declaration line
    // repeats the symbol's own name, so including it would credit EVERY
    // declaration carrying the token with body evidence for it.
    const bodyTokens = identifierTokensIn(
      lines.slice(sym.signatureEndLine, sym.endLine)
        .filter((_line, i) => commentLine[sym.signatureEndLine + i] !== true)
        .join("\n"),
    );
    const body = queryTokensCoveredByNames(remainingTokens, bodyTokens).length;
    const topLevel = sym.enclosingSymbol === undefined;
    // R5: an EXACT name match ("create" for outstanding token "create") is
    // a strictly stronger signal than a compound name that merely CONTAINS
    // the token as one of several words ("CommentCreateInput" also covers
    // "create" via splitBasenameTokens, but names a different thing). Only
    // breaks ties within the SAME covered count below — a compound name
    // genuinely covering MORE outstanding tokens still wins on that alone.
    const isExactMatch = remainingTokens.some((t) => t.toLowerCase() === sym.name.toLowerCase());
    const cand = { symbol: sym, covered, body, topLevel, isExactMatch };
    if (best === null) { best = cand; continue; }
    if (covered.length !== best.covered.length) {
      if (covered.length > best.covered.length) best = cand;
      continue;
    }
    if (isExactMatch !== best.isExactMatch) {
      if (isExactMatch) best = cand;
      continue;
    }
    // A local `const codecId` buried in an unrelated function is not the
    // answer to "which codec"; the exported declaration is.
    if (topLevel !== best.topLevel) {
      if (topLevel) best = cand;
      continue;
    }
    if (body !== best.body) {
      if (body > best.body) best = cand;
      continue;
    }
    // Tie -> existing rule: document order.
    if (sym.signatureStartLine < best.symbol.signatureStartLine) best = cand;
  }
  if (best === null) return null;
  return {
    symbol: best.symbol.name,
    line: best.symbol.signatureStartLine,
    endLine: best.symbol.endLine,
    covered: best.covered,
  };
}

/**
 * R6: pick a file's own most substantive declaration when there is no
 * outstanding query token left to refine against — matchBasenameTokens
 * already admitted the file on its NAME alone (every query token was a
 * basename word), so there is nothing left to check symbol-name coverage
 * against. A top-level exported function/class/method beats a local, a
 * const, a type alias, or an interface — those far more often describe the
 * file's DATA SHAPE (CoveragePackerV2Input) than what a "what does X do"
 * query is actually about (packForCoverageV2). Ties broken by how many of
 * the FILE'S OWN basename words the declaration's name covers, then by
 * document order (the pre-existing fallback this replaces).
 */
function bestSubstantiveDeclaration(
  relPath: string,
  symbols: readonly CollectedSymbol[],
  lines: readonly string[],
): { symbol: string; line: number; endLine: number; covered: string[] } | null {
  const base = path.basename(relPath, path.extname(relPath));
  const basenameWords = splitBasenameTokens(base);
  let best: { symbol: CollectedSymbol; tier: number; nameCover: number } | null = null;
  for (const sym of symbols) {
    // A local buried inside an unrelated function is not what the FILE is
    // about — restrict to top-level declarations, same bias the coverage-
    // based path above applies via its own topLevel tie-break.
    if (sym.enclosingSymbol !== undefined) continue;
    const isSubstantiveKind = sym.kind === "function" || sym.kind === "method" || sym.kind === "class";
    const declLine = lines[sym.signatureStartLine - 1] ?? "";
    const isExported = /^\s*export\b/.test(declLine);
    const tier = (isSubstantiveKind ? 2 : 0) + (isExported ? 1 : 0);
    const nameCover = queryTokensCoveredByNames(basenameWords, splitBasenameTokens(sym.name)).length;
    const cand = { symbol: sym, tier, nameCover };
    if (best === null) { best = cand; continue; }
    if (tier !== best.tier) { if (tier > best.tier) best = cand; continue; }
    if (nameCover !== best.nameCover) { if (nameCover > best.nameCover) best = cand; continue; }
    if (sym.signatureStartLine < best.symbol.signatureStartLine) best = cand;
  }
  if (best === null) return null;
  return {
    symbol: best.symbol.name,
    line: best.symbol.signatureStartLine,
    endLine: best.symbol.endLine,
    covered: [],
  };
}

/**
 * Collapse header+source pairs of the SAME C/C++ module (identical basename,
 * one header ext + one source ext) among FILENAME-MATCH candidates into a
 * single representative, preferring the source file (.cpp/.c). Only
 * filename-match candidates are collapsed; every other candidate passes
 * through untouched and in place. Order is otherwise preserved. This keeps one
 * two-file module from occupying two slots of a downstream bounded per-role
 * pack budget, so distinct modules are not crowded out of a multi-concept pack.
 */
function collapseCppModulePairs(candidates: Candidate[], _filenameMatchPaths: Set<string>): Candidate[] {
  // Group filename-match C/C++ candidates by module key (dir + basename).
  const moduleKey = (relPath: string): string => {
    const dir = path.posix.dirname(relPath)
      // treat include/ and src/ siblings as the same module directory
      .replace(/(^|\/)(include|src)(\/|$)/, "$1$3")
      .replace(/\/$/, "");
    return `${dir}::${path.basename(relPath, path.extname(relPath)).toLowerCase()}`;
  };
  const isCpp = (relPath: string): boolean => CPP_EXTS.has(path.extname(relPath).toLowerCase());
  const isSource = (relPath: string): boolean => CPP_SOURCE_EXTS.includes(path.extname(relPath).toLowerCase());

  // Choose the winner path per module: source preferred, else the first seen.
  const winnerByModule = new Map<string, string>();
  for (const c of candidates) {
    if (c.why !== "filename-match" || !isCpp(c.path)) continue;
    const key = moduleKey(c.path);
    const current = winnerByModule.get(key);
    if (current === undefined) { winnerByModule.set(key, c.path); continue; }
    if (isSource(c.path) && !isSource(current)) winnerByModule.set(key, c.path);
  }

  const emitted = new Set<string>();
  const out: Candidate[] = [];
  for (const c of candidates) {
    if (c.why === "filename-match" && isCpp(c.path)) {
      const key = moduleKey(c.path);
      const winner = winnerByModule.get(key)!;
      if (emitted.has(key)) continue; // this module already contributed
      emitted.add(key);
      if (c.path === winner) {
        out.push(c);
      } else {
        // Substitute the winner (source) candidate in this position.
        const winnerCand = candidates.find((x) => x.path === winner) ?? c;
        out.push(winnerCand);
      }
      continue;
    }
    out.push(c);
  }
  return out;
}

/** Collect variant tokens from query identifiers and explicit symbol. Cap at 24. */
function buildVariantTokens(query: string, symbol?: string): string[] {
  const ids = extractIdentifiers(query);
  if (symbol) ids.unshift(symbol);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of ids) {
    for (const v of deriveTokenVariants(id)) {
      if (!seen.has(v) && result.length < 24) {
        seen.add(v);
        result.push(v);
      }
    }
  }
  return result;
}

/**
 * R2: rank a Layer-2 per-token symbol-search hit by substantive declaration
 * kind, tiered, so a common token (e.g. "codec") does not let same-token
 * noise (consts, aliases, decoys) crowd out the declaration that actually
 * answers the query before the per-token cap truncates. Higher is better.
 *
 * function/method carry the actual DECISION/behavior most "where is X
 * handled" queries ask about; classes/interfaces are usually just a data
 * shape sharing the token (e.g. a *Candidate/*Payload type beside the
 * function that consumes it) — real, but a weaker signal within the same
 * "substantive" tier. const/type get none — far more often an incidental
 * field, alias, or local sharing the one common token.
 *
 * NOT scored: coverage of the query's OTHER tokens by the symbol's own
 * name. An earlier version of this function added a point per other-token
 * substring match, but that rewards purely INCIDENTAL vocabulary overlap
 * as readily as genuine relevance — DESIGN-v0.8 §A5's regression corpus
 * (readCodeTaskPack.spec.ts) caught a real case: query "fix muxer output:
 * yaw sign is reversed..." let a `clampMuxerOutput` distractor (which only
 * clamps a value's magnitude) outrank the real target `applyMuxer` (which
 * actually applies the sign-bearing MOTOR_SIGN table) purely because
 * "Output" appears in the distractor's name. Kind-tier alone already
 * carries R2's live-probe and synthetic-decoy evidence; token coverage did
 * not, so it was cut rather than tuned around this one counterexample.
 *
 * A standalone, exported function so this ranking is directly
 * unit-testable — its end-to-end effect is easy to mask when an unrelated
 * layer (e.g. variant-text search) also matches the same literal token
 * across the same files.
 */
export function rankSymbolHitQuality(loc: { readonly symbol: string; readonly kind: string }): number {
  if (loc.kind === "function" || loc.kind === "method") return 1.0;
  if (loc.kind === "class") return 0.4;
  return 0;
}

const TASK_MANAGEMENT_WORDS = new Set([
  "implement", "fix", "ensure", "update", "add", "remove", "change",
  "create", "delete", "modify", "refactor", "improve", "support",
  // Common domain-context nouns that typically describe a task subject, not a symbol:
  "priority", "role", "permission", "feature", "behavior", "option",
]);

function scoreQueryToken(token: string, query: string): number {
  let score = 1.0;
  // High value: all-caps enum-like tokens
  if (/^[A-Z][A-Z0-9_]{2,}$/.test(token)) score += 2.0;
  // High value: snake_case or camelCase identifiers with multiple parts
  if (/[_]/.test(token) || /[a-z][A-Z]/.test(token)) score += 1.0;
  // High value: file/path-like tokens
  if (/[./]/.test(token)) score += 1.5;
  // High value: near action verbs
  const actionVerbs = ["add", "rename", "support", "handle", "round", "serialize", "parse"];
  if (actionVerbs.some((v) => query.toLowerCase().includes(v))) score += 0.3;
  // Lower value: task-management words
  if (TASK_MANAGEMENT_WORDS.has(token.toLowerCase())) score -= 1.5;
  // Lower value: very generic nouns
  if (GENERIC_NOUNS.has(token.toLowerCase())) score -= 0.5;
  return score;
}

/**
 * R5: extract Class.method / Class#method pairs from a free-text query. A
 * dotted/hashed identifier pair whose first part looks like a class name
 * (starts uppercase — the near-universal convention across every language
 * this locator supports) names ONE concept, not two unrelated tokens: "look
 * INSIDE X for Y". Plain identifier extraction loses this structure
 * entirely — "CommentService.create" tokenizes to "CommentService" and
 * "create" with no link between them, and a bare "create" collides with
 * TASK_MANAGEMENT_WORDS' generic-verb penalty (meant for "create a new
 * field"-style queries) even though here it names an actual method.
 * Capped at 2 pairs — this is a targeted anchor, not a general scan.
 */
export function extractClassMethodPairs(query: string): Array<{ className: string; methodName: string }> {
  const out: Array<{ className: string; methodName: string }> = [];
  const re = /\b([A-Z][A-Za-z0-9_]*)[.#]([a-zA-Z_][A-Za-z0-9_]*)\b/g;
  let m: RegExpExecArray | null;
  while (out.length < 2 && (m = re.exec(query)) !== null) {
    out.push({ className: m[1]!, methodName: m[2]! });
  }
  return out;
}

/**
 * Extract identifier-like tokens from a free-text query.
 *
 * W9 (2026-08-22): `query` is scrubbed of generic path spans FIRST
 * (stripPathSpans("", query) — see util/queryShape.ts) — a path SEGMENT
 * ("takayuki", "packages") out of an absolute path mentioned in prose is not
 * a repo identifier just because it matches this function's word-shape
 * regex. Left unscrubbed, this fed both this module's own Layer-3 exact-text
 * search AND `strongestIdentifierToken`'s not-found `search_files
 * action=find` `next` (abstain()), which could hand back a `find` for a bare
 * path segment. A bare file stem with no directory prefix (`policy.ts`) is
 * unaffected — stripPathSpans only removes spans with a directory separator.
 *
 * The trailing FILENAME of a directory-qualified, extension-terminated
 * mention ("docs/rate-table.xlsx") is re-added separately via
 * `fileNamesInPathSpans` (its own basename only — "rate-table.xlsx", not
 * "docs"). Confirmed live (replayCorpus L2): stripping the whole span left
 * the locator with no token to recognize a query-named artifact BY, so
 * `result.surfaces` never carried it — even though the independent artifact-
 * prefetch path (readCodeTaskPack.ts) had already extracted its content —
 * and the extraction was silently dropped for lack of a matching surface.
 */
export function extractIdentifiers(query: string): string[] {
  const cleaned = [stripPathSpans("", query), ...fileNamesInPathSpans(query)].join(" ");
  // Also extract quoted strings literally.
  const tokens: string[] = [];
  // Grab camelCase, PascalCase, snake_case identifiers.
  const matches = cleaned.match(/\b[a-zA-Z_][a-zA-Z0-9_]{2,}\b/g) ?? [];
  for (const m of matches) {
    // De-dupe and skip common English words.
    if (!STOP_WORDS.has(m.toLowerCase()) && !tokens.includes(m)) {
      tokens.push(m);
    }
  }
  // CJK spans are already script-split and stop-word filtered by the shared
  // deterministic tokenizer. They are exact repo-evidence probes, not translations.
  for (const token of tokenizeForEpoch(cleaned)) {
    if (/[^\x00-\x7f]/u.test(token) && !tokens.includes(token)) tokens.push(token);
  }
  // Score and sort: high-value tokens first
  tokens.sort((a, b) => scoreQueryToken(b, cleaned) - scoreQueryToken(a, cleaned));
  return tokens;
}

/**
 * R3 (2026-08-21, re-applied by W5-B falsification-scope-and-text-floor):
 * generic 4-7 char programming nouns/verbs a SHORT-floor text search must
 * not chase on their own — too common across an arbitrary repo to
 * discriminate anything ("type", "list", "read", "call"...). Deliberately
 * separate from the broader STOP_WORDS below (English-prose filtering for
 * identifier EXTRACTION generally): this set exists only to gate the
 * lowered length floor immediately below, and several of its entries
 * (e.g. "class", "const", "this") are legitimate mid-length identifiers in
 * OTHER contexts.
 */
const SHORT_TEXT_SEARCH_STOP_WORDS: ReadonlySet<string> = new Set([
  "code", "file", "files", "test", "tests", "data", "type", "types", "name", "value",
  "index", "main", "util", "utils", "user", "users", "item", "items", "list", "node",
  "path", "text", "line", "lines", "read", "write", "call", "calls", "func", "function",
  "class", "return", "const", "case", "like", "this", "that", "when", "what", "which",
  "where", "there", "their", "into", "from", "with", "only", "also", "some", "more",
  "most", "have", "been", "does", "done", "just", "need", "make", "made", "true", "false",
  "null", "size", "time", "date", "info", "base", "core", "args", "opts", "self", "init",
  "load", "save", "open", "close", "start", "stop", "run", "set", "get", "add", "new",
  "old", "key", "keys", "map", "ref", "refs", "id", "ids",
]);

/**
 * R3 (2026-08-21, re-applied by W5-B): first attempted earlier in this
 * release-prep effort and reverted after two corpus regressions traced into
 * readCodeTaskPack.ts's directory-seeded role-fill (buildSeededTaskPack's
 * caller-supplied-dir augmentation) rather than into anything in this
 * file's own candidate scoring — see readCodeTaskPack.ts's confined
 * role-fill fix (W5-B, near dirCandidates/concernGroupMatchesSurfaces) for
 * the actual regression fix, applied THERE instead of re-narrowing this
 * floor. The bug this re-fixes: a short (4-7 char) discriminating ASCII
 * identifier like "cursor" or "codec" never ran a Layer 3 text search at
 * all (the flat 8-char floor), even inside a multi-identifier query where
 * the surrounding tokens already prove it is not noise. Gated to
 * MULTI-identifier queries only (>=2 extracted identifier tokens) so a
 * single bare short word does not widen a query on its own, and excludes
 * SHORT_TEXT_SEARCH_STOP_WORDS (generic short programming nouns/verbs).
 */
function extractTextSearchQueries(query: string): string[] {
  const results: string[] = [];
  // Quoted strings.
  const quoted = query.match(/"([^"]+)"|'([^']+)'/g);
  if (quoted) {
    for (const q of quoted) results.push(q.slice(1, -1));
  }
  // Long ASCII identifiers and exact CJK script spans are suitable for
  // bounded literal search. The latter prevents Japanese requests from
  // collapsing to the broad-query refusal before repo evidence is consulted.
  const allIdentifiers = extractIdentifiers(query);
  const shortFloorEligible = allIdentifiers.length >= 2;
  const ids = allIdentifiers.filter((t) =>
    t.length >= 8
    || /[^\x00-\x7f]/u.test(t)
    || (shortFloorEligible && t.length >= 4 && !SHORT_TEXT_SEARCH_STOP_WORDS.has(t.toLowerCase()))
  );
  for (const id of ids) if (!results.includes(id)) results.push(id);
  return results;
}

/**
 * Find the end line of a symbol starting at startLine using brace/indent matching.
 * Simplified version — mirrors logic in getSymbolWithContext.ts.
 */
function findSymbolEnd(lines: string[], startLine: number, lang: string): number {
  const isPython = lang === "python";
  const isRuby = lang === "ruby";

  if (isPython) {
    const defLine = lines[startLine - 1] ?? "";
    const defIndent = (defLine.match(/^(\s*)/) ?? ["", ""])[1]!.length;
    for (let i = startLine; i < lines.length; i++) {
      const l = lines[i]!;
      if (l.trim() === "") continue;
      const curIndent = (l.match(/^(\s*)/) ?? ["", ""])[1]!.length;
      if (curIndent <= defIndent) return i;
    }
    return lines.length;
  }

  if (isRuby) {
    let depth = 1;
    for (let i = startLine; i < lines.length; i++) {
      const l = lines[i]!.trim();
      if (/^(def|class|module|do|begin|if|unless|case|while|until|for)\b/.test(l)) depth++;
      if (l === "end" || l.startsWith("end ") || l.startsWith("end#")) depth--;
      if (depth === 0) return i + 1;
    }
    return lines.length;
  }

  // Brace-based.
  let depth = 0;
  let started = false;
  for (let i = startLine - 1; i < lines.length; i++) {
    const l = lines[i]!;
    for (let c = 0; c < l.length; c++) {
      const ch = l[c]!;
      if (ch === "{") { depth++; started = true; }
      if (ch === "}") {
        depth--;
        if (started && depth === 0) return i + 1;
      }
    }
  }
  return Math.min(startLine + TEXT_WINDOW_LINES, lines.length);
}

/**
 * Very generic nouns that scoreQueryToken already down-weights below (they
 * routinely describe a task's SUBJECT, not a project-specific name — see
 * that function). matchBasenameTokens' single-token distinctiveness check
 * reuses the SAME list for the SAME reason: a query token like "issue"
 * coincidentally matching a basename WORD that merely contains it as a
 * substring (e.g. "reissue" in cumulativeReissueReceipt.spec.ts) is not
 * meaningful evidence just because that basename's own word happens to be
 * workspace-rare — the rarity of "reissue" says nothing about whether
 * "issue" (a generic word, likely quoted literal content in the query
 * rather than a description of what to find) is actually what the query is
 * about. Not STOP_WORDS: these still count for the >= 2-distinct-token
 * admission path and for exact/whole-name matches, both stronger signals
 * than a single generic-word substring hit.
 */
const GENERIC_NOUNS = new Set(["status", "issue", "health", "state", "value", "data", "info", "name", "code"]);

/** Common English stop words to skip in identifier extraction. */
const STOP_WORDS = new Set([
  "the", "and", "for", "not", "but", "with", "this", "that", "have", "from",
  "are", "was", "were", "has", "had", "does", "did", "can", "could", "will",
  "would", "should", "may", "might", "shall", "when", "where", "which", "what",
  "how", "who", "why", "its", "our", "their", "your", "out", "into",
  "then", "than", "also", "any", "all", "some", "each", "both", "being",
  "function", "class", "method", "type", "interface", "const", "export",
  "import", "return", "async", "await", "true", "false", "null", "undefined",
  "error", "string", "number", "boolean", "object", "array", "void",
  // Repository instruction-guide basenames are prose/navigation context, not
  // code symbols. Let explicit paths handle them; otherwise ALL_CAPS scoring
  // would consume the bounded symbol-search slots ahead of real identifiers.
  "agents", "claude",
]);
