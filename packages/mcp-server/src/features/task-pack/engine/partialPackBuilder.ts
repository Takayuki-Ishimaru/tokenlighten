// partialPackBuilder — extracted implementation; imports point to the owning modules.
import * as fs from "fs";
import * as path from "path";
import type { LocateCandidateDetail } from "@tokenlighten/types";
import type { TaskPackArgs } from "../model.js";
import type { TaskPackResult } from "../model.js";
import type { TaskPackSurface } from "../model.js";
import { CREATE_TARGET_EXT_RE } from "./createAndWiringEndpoints2.js";
import { FileReadCache } from "./packBasics2.js";
import { MAX_SURFACES_DISTINCT } from "./packBasics2.js";
import { SYMPTOM_WORDS } from "./anchorFocus4.js";
import { buildRoute } from "./coverageAndContinuation4.js";
import { capitalizationNamesSubject } from "../requestItems.js";
import { centeredSliceForCap } from "./packBasics2.js";
import { classifySurface } from "../../../util/impact.js";
import { concreteIdentifierTokens } from "./createAndWiringEndpoints2.js";
import { discoverVerificationHints } from "./surfaceMaterialization.js";
import { escapeRegExp } from "../../search/find/findText.js";
import { explicitCodeIdentifiers } from "./anchorFocus2.js";
import { extractClassMethodPairs } from "../../locator/locateTaskContext.js";
import { extractIdentifiers } from "../../locator/locateTaskContext.js";
import { getCurrentDiff } from "../../../tools/getCurrentDiff.js";
import { handleTable } from "../../../util/handles.js";
import { isMarkdownPath } from "../../../util/markdownSections.js";
import { namedCallableDefinitions } from "./queryIntent4.js";
import { normIdent } from "./createAndWiringEndpoints2.js";
import { readCached } from "./packBasics2.js";
import { requestAsksForChange } from "./coverageAndContinuation3.js";
import { servedTextOrUndefined } from "../../../util/textDecode.js";
import { statReadTargetSync } from "../../../util/safePath.js";
import { tokenizeForEpoch } from "../../../state/session.js";
import { unqualifiedSymbolTail } from "./anchorFocus3.js";

/** True when the query reads like a bug-fix task rather than a feature addition. */
export function isSymptomShapedQuery(query: string): boolean {
  return SYMPTOM_WORDS.test(query);
}

export function requestsWorkingTreeInvestigation(query: string): boolean {
  return /\b(?:working[- ]tree|(?:uncommitted|unstaged|staged)\s+(?:changes?|diffs?|edits?|files?)|git\s+diff|my\s+(?:recent\s+)?changes|changes\s+I\s+(?:just\s+)?made)\b/iu.test(query)
    || /(?:未コミット|ステージ済み|ステージング)(?:の)?(?:変更|差分|編集|ファイル)|作業ツリー|自分の変更|直前の変更/u.test(query);
}

export function isTaskPackGeneratedDrift(relPath: string, workspace: string): boolean {
  if (/(?:^|\/)(?:dist|build|__pycache__|node_modules|\.tokenlighten)(?:\/|$)/u.test(relPath)) return true;
  if (!/^(?:\.mcp\.json|\.codex\/config\.toml|\.vscode\/(?:mcp|settings)\.json|AGENTS\.md|CLAUDE\.md|\.github\/copilot-instructions\.md)$/u.test(relPath)) return false;
  const content = readCached(workspace, relPath);
  return content !== undefined && /tokenlighten|tl-mcp|tokenlighten:mcp-instructions/iu.test(content);
}

/**
 * Resolve the git repo root for `workspace` and the POSIX-relative prefix
 * from that root down to `workspace` (e.g. workspace
 * ".../repo/apps/webapp" under repo root
 * ".../repo" -> prefix "apps/webapp/"). Returns "" when
 * `workspace` IS the git root (no prefix to strip) or when the root
 * cannot be determined.
 *
 * `git diff` always emits paths relative to the REPO ROOT, never the `-C`
 * cwd, even when the diff itself is scoped with a pathspec — so this
 * prefix must be stripped before treating a diff path as workspace-
 * relative (the shape every other surface/handle/sliceCode call expects).
 */
export async function gitWorkspacePrefix(workspace: string): Promise<string> {
  const { execFile } = await import("child_process");
  const toplevel = await new Promise<string | null>((resolve) => {
    execFile("git", ["-C", workspace, "rev-parse", "--show-toplevel"], { timeout: 5000 }, (err, stdout) => {
      resolve(err ? null : stdout.trim());
    });
  });
  if (!toplevel) return "";
  const resolvedWorkspace = fs.realpathSync(workspace);
  const resolvedToplevel = fs.realpathSync(toplevel);
  if (resolvedWorkspace === resolvedToplevel) return "";
  const rel = path.relative(resolvedToplevel, resolvedWorkspace).split(path.sep).join("/");
  return rel.length > 0 ? `${rel}/` : "";
}

/**
 * Build a task_pack response from the working tree's git drift: each
 * changed file becomes a surface anchored on the EDIT SITE (the first
 * changed hunk, not the file header), carrying the current on-disk code
 * for that range so the agent can act without an extra slice call.
 *
 * Returns null when there is no usable diff (no git repo, clean tree, or
 * every changed file is excluded/binary) so the caller falls through to
 * the normal locate flow.
 *
 * IMPORTANT: `path: "."` scopes the diff to the workspace directory
 * itself. `workspace` is very often NOT its own git root (e.g. a
 * benchmark fixture nested inside a monorepo, or any subproject inside a
 * larger repo) — `git -C <workspace> diff HEAD` with no pathspec walks up
 * to the enclosing repo's root and returns EVERY change anywhere in that
 * repo, not just this task's fixture/subtree. Scoping to "." keeps drift
 * surfaces confined to the workspace the caller actually asked about; the
 * returned paths still need gitWorkspacePrefix() stripped since git always
 * reports repo-root-relative paths regardless of scoping.
 */
export async function buildDiffTaskPack(query: string, workspace: string): Promise<TaskPackResult | null> {
  const diff = await getCurrentDiff({ path: "." }, workspace);
  if (diff.error || diff.files.length === 0) return null;

  const prefix = await gitWorkspacePrefix(workspace);

  const requiredRoles: string[] = [];
  const surfaces: TaskPackSurface[] = [];

  for (const file of diff.files) {
    if (surfaces.length >= MAX_SURFACES_DISTINCT) break;
    if (file.status === "deleted") continue; // nothing left on disk to slice
    if (prefix && !file.path.startsWith(prefix)) continue; // defensive: outside workspace despite scoping
    const relPath = prefix ? file.path.slice(prefix.length) : file.path;
    if (isTaskPackGeneratedDrift(relPath, workspace)) continue;

    // Anchor the range on the first changed hunk (the actual edit site),
    // not the file header — widen a few lines of context around it.
    const firstHunk = file.hunks[0];
    const anchorLine = firstHunk ? firstHunk.newStart : 1;
    const anchorLen = firstHunk ? Math.max(firstHunk.newLines, 1) : 20;
    const startLine = Math.max(1, anchorLine - 3);
    const endLine = anchorLine + anchorLen + 3;
    const range = `${startLine}-${endLine}`;

    const entry = handleTable.upsert({
      kind: "range",
      path: relPath,
      range,
      workspaceRoot: workspace,
    });

    const role = classifySurface(relPath) as string;
    // DESIGN-v0.9 §4.1/§4.5: an oversize drift region gets a hunk-anchor-centered
    // trimmed body + remaining_ranges instead of the code-less cliff.
    const embed = centeredSliceForCap(workspace, relPath, range, undefined, anchorLine);
    const hunkCount = file.hunks.length;
    const why = hunkCount > 1
      ? `working-tree drift vs git baseline (${hunkCount} changed regions)`
      : "working-tree drift vs git baseline";

    surfaces.push({
      role,
      handle: entry.id,
      path: relPath,
      range,
      required: true,
      why,
      edit_intent: "resolve the reported symptom in this changed region; compare against the git baseline for intended behavior",
      done_check: "the reported symptom no longer reproduces and the change matches the intended baseline behavior",
      ...(embed ? { code: embed.code } : {}),
      ...(embed && embed.remaining_ranges.length > 0
        ? { content_completeness: "partial" as const, remaining_ranges: embed.remaining_ranges }
        : {}),
    });
    if (!requiredRoles.includes(role)) requiredRoles.push(role);
  }

  if (surfaces.length === 0) return null;

  const primaryHandle = surfaces[0]!.handle;
  // DESIGN-v0.8 coverage-honesty: a complete diff pack IS the whole located
  // answer (every changed file on disk), so it reads "complete"; a truncated
  // diff genuinely omits changed files — partial / "diff-truncated".
  const coverage: "complete" | "partial" = diff.truncated ? "partial" : "complete";
  const coverageReason: TaskPackResult["coverage_reason"] | undefined =
    diff.truncated ? "diff-truncated" : undefined;
  // P2 fix: route through the A4-hardened buildRoute instead of a hardcoded
  // confident `edit_from_handles / 0`. A truncated diff means the pack does
  // NOT cover every changed file — coverage is partial and `missing` carries
  // "additional-changed-files", so buildRoute's partial branch emits an honest
  // reason that names the truncation (max_additional_tl_calls stays 0 only
  // when nothing is missing). An empty query is passed deliberately: the diff
  // surfaces ARE the located answer, so the concern-token flip must not fire
  // on the caller's symptom wording (which rarely text-matches the changed
  // file paths — the whole reason this flow exists).
  const missing = diff.truncated ? ["additional-changed-files"] : [];
  const route = buildRoute(surfaces, [], coverage, missing, "", coverageReason);
  return {
    mode: "task_pack",
    coverage,
    ...(coverageReason ? { coverage_reason: coverageReason } : {}),
    surfaces,
    missing,
    required_surfaces: requiredRoles,
    route,
    // DESIGN-v0.8 §C1 item 4: capped at 1 entry (MAX_COMPLETION_CHECKS);
    // both prior checks folded into one line rather than dropping either.
    checks: [
      "confirm each drift surface's change matches the reported symptom, then re-run `tl_search_files action=diff` to confirm no new regression",
    ],
    verify: discoverVerificationHints(workspace, query, surfaces),
    next: { tool: "tl_read_file", arguments: { mode: "slice", handle: primaryHandle } },
  };
}

export function shouldRedirectToOverview(args: TaskPackArgs, query: string): boolean {
  if (args.path || args.symbol || (args.surfaceRoles && args.surfaceRoles.length > 0)) {
    return false;
  }
  const raw = query.trim();
  if (raw.length === 0) return false;
  const lower = raw.toLowerCase();

  // Do not steal clear edit tasks just because they mention "overview mode".
  if (/^\s*(implement|add|fix|change|update|rename|remove|delete)\b/.test(lower)) {
    return false;
  }

  if (/どんなシステム|全体像|概要|アーキテクチャ|構成を.*教えて|実装を.*見て.*教えて/.test(raw)) {
    return !queryNamesSpecificSubject(raw);
  }

  const overviewPhrase =
    /\b(architecture|implementation|system|repo|repository|codebase)\s+(overview|map|summary)\b/.test(lower) ||
    /\b(overview|map|summary)\s+(of|for)\s+(the\s+)?(architecture|system|repo|repository|codebase)\b/.test(lower);
  // Bare acronyms such as MCP/CLI still describe a repository overview;
  // paths, quoted terms and named members keep their specific subject.
  if (overviewPhrase) return !queryNamesSpecificSubject(raw, false);

  // P1-2 (hands-on report, 2026-09): this gate used to fire on ANY
  // co-occurrence of an explain-class verb and a broad noun, with no check
  // for whether the query also names a concrete subject — "Explain Cache.get
  // expiry, its tests, and the Redis cache invalidation implementation..."
  // and "Describe the Cache class architecture." both got swallowed into the
  // overview stub purely because "implementation"/"architecture" appeared
  // somewhere in the sentence. queryNamesSpecificSubject reuses this file's/
  // the locator's own identifier extraction rather than a bespoke tokenizer.
  if (/\b(what\s+(kind|type)\s+of\s+system|explain|understand|summarize|describe)\b/.test(lower) &&
      /\b(system|repo|repository|codebase|architecture|implementation)\b/.test(lower) &&
      !queryNamesSpecificSubject(raw)) {
    return true;
  }

  return false;
}

/**
 * P1-2 (hands-on report, 2026-09): true when `query` already names a
 * specific subject rather than being a genuinely subject-less "explain the
 * system" style request. Any of:
 *   - a dotted Class.method/Class#method reference ("Cache.get") —
 *     extractClassMethodPairs (locateTaskContext.ts), the same helper the
 *     locator itself uses to anchor a query on one concept;
 *   - a camelCase/PascalCase-interior, snake_case, or ALL_CAPS identifier —
 *     concreteIdentifierTokens, this file's own "is this token code-shaped"
 *     filter (below);
 *   - an explicit extensioned path — CREATE_TARGET_EXT_RE (below), reused
 *     via `.match()` per its own lastIndex convention, never `.test()`;
 *   - a quoted term (straight/smart/Japanese brackets);
 *   - a capitalized word that is not the query's own sentence-initial word —
 *     a plain-language stand-in for a named class/type/entity mention (e.g.
 *     "the Cache class"), reusing extractIdentifiers's own word extraction +
 *     stop-word filtering rather than a fresh word list, with the gate's own
 *     trigger vocabulary excluded so a capitalized rendition of "System"/
 *     "Architecture" etc. cannot cancel itself out.
 * shouldRedirectToOverview's explain/describe gate must not steal a query
 * that is actually about one concrete symbol just because it also happens to
 * mention a broad noun like "implementation"/"architecture".
 */
export function queryNamesSpecificSubject(query: string, allowBareAcronyms = true): boolean {
  const trimmed = query.trim();
  if (trimmed.length === 0) return false;
  if (extractClassMethodPairs(trimmed).length > 0) return true;
  if (concreteIdentifierTokens(trimmed).some((token) => allowBareAcronyms || !/^[A-Z][A-Z0-9]{2,}$/.test(token))) return true;
  if (trimmed.match(CREATE_TARGET_EXT_RE) !== null) return true;
  if (/["'“”‘’「」『』][^"'“”‘’「」『』]{2,}["'“”‘’「」『』]/.test(trimmed)) return true;

  const sentenceStarts = new Set<number>([0]);
  for (const m of trimmed.matchAll(/[.!?]\s+/g)) {
    sentenceStarts.add((m.index ?? 0) + m[0].length);
  }
  const candidateTokens = new Set(extractIdentifiers(trimmed).map((t) => t.toLowerCase()));
  const wordRe = /\b[A-Za-z][A-Za-z0-9_]*\b/g;
  let wm: RegExpExecArray | null;
  while ((wm = wordRe.exec(trimmed)) !== null) {
    const word = wm[0];
    if (word.length < 3 || !/^[A-Z]/.test(word)) continue;
    if (!allowBareAcronyms && /^[A-Z][A-Z0-9]{2,}$/.test(word)) continue;
    if (sentenceStarts.has(wm.index)) continue;
    const lower = word.toLowerCase();
    if (!candidateTokens.has(lower)) continue;
    if (OVERVIEW_GATE_VOCABULARY.has(lower)) continue;
    return true;
  }
  return false;
}

/** shouldRedirectToOverview's own trigger vocabulary — excluded from
 * queryNamesSpecificSubject's capitalized-word fallback so a capitalized
 * rendition of the gate's own words ("Explain the System architecture")
 * cannot be mistaken for a named subject and cancel the redirect it names. */
export const OVERVIEW_GATE_VOCABULARY: ReadonlySet<string> = new Set([
  "system", "repo", "repository", "codebase", "architecture", "implementation",
  "overview", "map", "summary", "explain", "understand", "summarize", "describe",
  "kind", "type",
]);

/**
 * Cheap pathless-doc fast path. A strong root Markdown filename/title match is
 * better evidence than a repository-wide token scan and avoids the slow,
 * misleading test-name match seen for design/version questions.
 */
export function rootMarkdownTitleMatch(workspace: string, query: string): string | undefined {
  if (/^\s*(implement|add|fix|change|update|rename|remove|delete)\b/i.test(query)) return undefined;
  const queryTokens = new Set(tokenizeForEpoch(query).filter((token) => token.length > 1));
  if (queryTokens.size < 3) return undefined;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(workspace, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const ranked = entries
    .filter((entry) => entry.isFile() && isMarkdownPath(entry.name))
    .map((entry) => {
      let title = "";
      try {
        const abs = path.join(workspace, entry.name);
        statReadTargetSync(abs, workspace);
        // P3 (2026-08-27): decode via the shared BOM/NUL-aware policy, never a
        // raw utf8 read — an undecodable file is skipped like any other probe
        // failure, never served as garbled title text.
        // AA1 (2026-09-14, round 10): the title line DOES reach the wire, so it
        // goes through the ONE serve-side verdict like every other served text
        // (the old `decodeTextBuffer` would have handed back a mojibake heading
        // for an invalid-UTF-8 markdown file).
        // served-bytes: readServedText
        const decoded = servedTextOrUndefined(abs);
        if (decoded === undefined) return undefined;
        title = decoded.split(/\r?\n/, 1)[0] ?? "";
      } catch {
        return undefined;
      }
      const targetTokens = new Set(tokenizeForEpoch(`${entry.name} ${title}`));
      const matches = [...queryTokens].filter((token) => targetTokens.has(token)).length;
      return { path: entry.name, matches, ratio: matches / queryTokens.size };
    })
    .filter((entry): entry is { path: string; matches: number; ratio: number } => entry !== undefined)
    .filter((entry) => entry.matches >= 3 && entry.ratio >= 0.5)
    .sort((a, b) => b.matches - a.matches || b.ratio - a.ratio || a.path.localeCompare(b.path));
  if (ranked.length === 0) return undefined;
  if (ranked.length > 1 && ranked[0]!.matches === ranked[1]!.matches && ranked[0]!.ratio === ranked[1]!.ratio) {
    return undefined;
  }
  return ranked[0]!.path;
}

// ---------------------------------------------------------------------------
// Build partial pack from abstain candidateDetails (surface-grouped).
// ---------------------------------------------------------------------------

export const SURFACE_ROLE_PRIORITY: Record<string, number> = {
  contract: 0,
  api: 1,
  domain: 2,
  data: 3,
  ui: 4,
  style: 5,
  config: 6,
  test: 7,
  doc: 8,
  unknown: 9,
};

// ---------------------------------------------------------------------------
// C2 helpers: multi-surface detection + bounded per-role candidate cap.
//
// A single-target task keeps exactly one candidate per role. A multi-surface
// task (several distinct concerns joined in one query) may keep a few
// high-confidence same-role candidates so a multi-file fix does not collapse
// to a single surface. Everything stays bounded (MAX_SURFACES_DISTINCT + byte
// cap) and deterministic.
// ---------------------------------------------------------------------------

/** Per-role candidate cap for a multi-surface partial pack. */
export const PER_ROLE_CAP_DEFAULT = 2;

export const PER_ROLE_CAP_TOP = 3;

/**
 * Heuristic: does the query describe more than one distinct change? Split on
 * clause separators (commas, "and"/"plus"/"then", semicolons) and count
 * substantial clauses. Deliberately domain-agnostic — it keys off sentence
 * shape, not project vocabulary. Requires several words overall so a short
 * two-word query ("rename foo") is never treated as multi-surface.
 */
export function isMultiSurfaceQuery(query: string): boolean {
  const trimmed = query.trim();
  if (trimmed.split(/\s+/).length < 6) return false;
  const clauses = trimmed
    .split(/\s*(?:,|;|\band\b|\bplus\b|\bthen\b|\bas well as\b)\s*/i)
    .map((c) => c.trim())
    .filter((c) => c.split(/\s+/).length >= 2);
  return clauses.length >= 2;
}

/** Max candidates to keep for `role`; the highest-priority role gets one more. */
export function perRoleCap(role: string, topRole: string | undefined): number {
  return role === topRole ? PER_ROLE_CAP_TOP : PER_ROLE_CAP_DEFAULT;
}

/**
 * A candidate detail carrying its ORIGINAL position in the locator's ranked
 * output. The locator already ranks candidates best-first; that ordering
 * encodes signal (name matches, symbol hits, scope proximity) that must not be
 * thrown away when the pack breaks confidence ties. Path-alphabetical is only a
 * last-resort determinism fallback for candidates that also share a rank.
 */
export type RankedDetail = LocateCandidateDetail & { __rank: number };

/**
 * Deterministic ranking within a role:
 *   1. confidence desc (primary signal),
 *   2. locator rank asc (preserve the locator's own best-first ordering on
 *      equal confidence — dropping this discarded the locator's ranking and
 *      let alphabetically-earlier-but-less-relevant files win the slot),
 *   3. path asc (final determinism fallback only for identical rank+confidence).
 */
export function compareDetails(a: RankedDetail, b: RankedDetail): number {
  const confidenceDiff = b.confidence - a.confidence;
  if (Math.abs(confidenceDiff) > 0.001) return confidenceDiff;
  if (a.__rank !== b.__rank) return a.__rank - b.__rank;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

export function uniqueExplicitIdentityCandidate<
  T extends { path: string; symbol?: string; confidence?: number },
>(candidates: T[], query: string): { candidate: T; exactSymbol: boolean } | undefined {
  const explicitIdentities = new Set(explicitCodeIdentifiers(query).map(normIdent));
  if (explicitIdentities.size === 0) return undefined;
  const matches = candidates
    .map((candidate, index) => {
      const symbol = normIdent(candidate.symbol ?? "");
      const basename = normIdent(path.basename(candidate.path, path.extname(candidate.path)));
      const exactSymbol = symbol.length > 0 && explicitIdentities.has(symbol);
      const exactBasename = basename.length > 0 && explicitIdentities.has(basename);
      return { candidate, index, exactSymbol, matches: exactSymbol || exactBasename };
    })
    .filter((entry) => entry.matches);
  const matchedPaths = [...new Set(matches.map((entry) => entry.candidate.path))];
  if (matchedPaths.length !== 1) return undefined;
  const best = matches
    .filter((entry) => entry.candidate.path === matchedPaths[0])
    .sort((a, b) =>
      Number(b.exactSymbol) - Number(a.exactSymbol)
      || (b.candidate.confidence ?? 0) - (a.candidate.confidence ?? 0)
      || a.index - b.index
    )[0]!;
  return { candidate: best.candidate, exactSymbol: best.exactSymbol };
}

/**
 * The candidates that ARE the requested identity — an explicit identifier as
 * their symbol or basename (`uniqueExplicitIdentityCandidate`'s test), or a
 * prose-cased name the request spells mid-clause as their symbol ("Fix Sum
 * so …", requestItems.ts's `capitalizationNamesSubject`) — when they span two
 * or more files, best first. Those files are the choice itself.
 */
export function sameIdentityCandidates(candidates: readonly RankedDetail[], query: string): RankedDetail[] {
  const explicit = new Set(explicitCodeIdentifiers(query).map(normIdent));
  const spelled = (symbol: string): boolean => symbol.length >= 3
    && new RegExp(`(?<![A-Za-z0-9_$])${escapeRegExp(symbol)}(?![A-Za-z0-9_$])`).test(query)
    && capitalizationNamesSubject(symbol, query);
  const matches = candidates.filter((candidate) => {
    const symbol = unqualifiedSymbolTail(candidate.symbol ?? "");
    const basename = normIdent(path.basename(candidate.path, path.extname(candidate.path)));
    return (symbol.length > 0 && (explicit.has(normIdent(symbol)) || spelled(symbol)))
      || (basename.length > 0 && explicit.has(basename));
  });
  return new Set(matches.map((candidate) => candidate.path)).size >= 2 ? [...matches].sort(compareDetails) : [];
}

/** See `buildPartialPack`'s identity step: the spelled-name counterpart of `uniqueExplicitIdentityCandidate`. */
export async function uniqueSpelledDefinitionCandidate(
  candidates: readonly RankedDetail[],
  query: string,
  workspace: string,
  cache: FileReadCache,
): Promise<{ candidate: RankedDetail; exactSymbol: boolean } | undefined> {
  const spelled = candidates.filter((candidate) => {
    const symbol = unqualifiedSymbolTail(candidate.symbol ?? "");
    return symbol.length >= 3
      && new RegExp(`(?<![A-Za-z0-9_$])${escapeRegExp(symbol)}(?![A-Za-z0-9_$])`).test(query)
      && capitalizationNamesSubject(symbol, query);
  });
  if (new Set(spelled.map((candidate) => candidate.path)).size !== 1 || !requestAsksForChange(query)) return undefined;
  const candidate = [...spelled].sort(compareDetails)[0]!;
  const definitions = await namedCallableDefinitions(query, workspace, candidate.path, cache);
  if (definitions === undefined || !definitions.complete || definitions.paths.length !== 1) return undefined;
  if (normIdent(definitions.identifier) !== normIdent(unqualifiedSymbolTail(candidate.symbol ?? ""))) return undefined;
  return { candidate, exactSymbol: true };
}

// ---------------------------------------------------------------------------
// Candidate selection: preserve role diversity, then keep same-role closure
// slots that usually represent distinct work surfaces (admin aggregation,
// repository/search, transport/sender, etc.).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Item 9: for enum/value-addition tasks, prefer the DEFINITION site (and
// its exhaustive initializers) over sites that merely DERIVE from the
// definition and need no edit when a new value is added.
// ---------------------------------------------------------------------------

/**
 * Generic "this line is a pure derivation, not a definition" shape check.
 * Matches constructs that automatically reflect a new enum/const-object
 * value without any code change: Object.values(...)/Object.keys(...) over
 * the enum, `keyof typeof X`, a type inferred FROM a schema
 * (`z.infer<typeof X>` and equivalents), or a bare re-export/import of the
 * symbol. These are language-shape patterns (mostly TS/JS, since that is
 * where "derive a schema/type from a const object" is idiomatic), not any
 * project's specific symbol names.
 */
export function looksLikeDerivedFromDefinition(line: string): boolean {
  return /Object\.(values|keys|entries)\s*\(|keyof\s+typeof\b|\.infer<|z\.nativeEnum\(|^\s*export\s+type\s+\w+\s*=\s*\(typeof\b|^\s*export\s*\{[^}]*\}\s*from\b|^\s*import\s+.*\bfrom\b/.test(line);
}

/**
 * Generic "this line/block DEFINES the enum/value family" shape check:
 * an actual enum keyword, or an object/array literal assignment that is
 * about to enumerate members (the exhaustive-initializer shape). Matches
 * across TS/JS const-object enums, native `enum`, Python Enum classes, and
 * Java/Kotlin/C++ enum declarations — again purely by syntax shape.
 */
export function looksLikeDefinitionSite(line: string): boolean {
  return /^\s*export\s+(const|enum)\s+\w+\s*(:|=|\{)|^\s*enum\s+(class\s+)?\w+\s*\{|^\s*class\s+\w+\s*\(\s*Enum\s*\)\s*:/.test(line);
}

/**
 * Read the candidate's own line (1-based) from disk and classify it as a
 * definition site, a derived site, or neither. Returns 0 (neutral), +1
 * (definition — boost), or -1 (pure derivation — demote). Best-effort: any
 * I/O failure or out-of-range line returns neutral rather than throwing.
 */
export function definitionVsDerivedAdjustment(workspace: string, relPath: string, line: number, cache?: FileReadCache): number {
  const raw = readCached(workspace, relPath, cache);
  if (raw === undefined) return 0;
  const lines = raw.split(/\r?\n/);
  const idx = line - 1;
  if (idx < 0 || idx >= lines.length) return 0;
  const target = lines[idx]!;
  if (looksLikeDefinitionSite(target)) return 1;
  if (looksLikeDerivedFromDefinition(target)) return -1;
  return 0;
}
