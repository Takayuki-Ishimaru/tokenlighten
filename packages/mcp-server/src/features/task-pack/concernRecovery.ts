// concernRecovery.ts — TL_CONCERN_RECOVERY (Agent B, Phase 2, 2026-09-19).
// (S) supported first-pack policy, default ON since 2026-09-19 (USER ruling);
// explicit `TL_CONCERN_RECOVERY=0` is the rollback path.
//
// PROBLEM (firstPackPrecisionEval baseline, Phase 1): a multi-concern query
// names several sibling members of ONE user-written list (e.g. an enumerated
// status set, or several receipt-tag names). The existing recovery path
// (readCodeTaskPack.ts's recoverExplicitIdentifierAnswerCandidates) treats
// each literal independently and requires it to have EXACTLY ONE
// definition-shaped occurrence anywhere in the workspace before it injects
// anything — a literal that is a common word, or that is used pervasively as
// a quoted string value (never with a declaration keyword or a bare `=`/`:`
// immediately after it), fails that guard and contributes ZERO evidence,
// even though it was named explicitly by the user.
//
// REFINED MECHANISM (orchestrator adjudication, 2026-09-19): picking one
// arbitrary occurrence of an ambiguous literal is a guess. The file where
// SEVERAL members of the SAME user-written list occur TOGETHER is evidence a
// single ambiguous literal's lone occurrence never was. This module answers
// "which candidate files does a sibling group of literals point at, and
// with what evidence window" — nothing else. It never decides whether the
// result is injected into a pack, never reads flags, never reads env.
//
// PURE / INJECTED I/O ONLY: every function here takes plain data plus two
// injected functions (a fixed-string scanner, an enclosing-symbol reader) —
// no filesystem access, no session/task state, no caching. This is what
// makes the module unit-testable with hand-built fixtures in
// concernRecovery.spec.ts without spinning up a workspace or the task-pack
// pipeline. The caller (readCodeTaskPack.ts's small hook, gated by
// concernRecoveryEnabled()) is responsible for turning a real workspace scan
// / tree-sitter parse into these two functions.
//
// GENERALITY: nothing below is keyed to any fixture, task id, or file name.
// Every threshold (MIN_DISTINCT_MEMBERS_*, SIBLING_GROUP_GAP_CHARS,
// CLUSTER_GAP_LINES, MAX_WINDOW_LINES, MAX_RECOVERY_ITEMS) is a structural
// property of "how far apart can two members of one written list be" / "how
// close together do matches need to be to count as one cluster" — the same
// judgment call recoverExplicitIdentifierAnswerCandidates already makes with
// its own literal constants (e.g. IDENTIFIER_DEFINITION_KEYWORD_RE's fixed
// keyword list). None of it reads a project name, a query string literal, or
// a corpus path.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One literal named by the query, verbatim (dotted/hyphenated forms are kept exactly as written — they are scanned as fixed strings, never re-tokenized). */
export interface ConcernRecoveryItem {
  readonly text: string;
  /** True when the item independently looks code-shaped (identifier casing, punctuation, or was backticked) — see the module doc on why plain dictionary words are treated differently. */
  readonly codeShaped: boolean;
  /** Character offset of this item's first occurrence in the (cleaned) query text — used only to group siblings by proximity, never serialized. */
  readonly start: number;
}

/** A raw occurrence of one scanned literal, as the caller's scanner reports it. */
export interface ConcernScanHit {
  readonly path: string;
  readonly line: number;
  /** A declaration keyword precedes the match, or the match is bound with a bare `=`/`:` right after — the SAME shape test recoverExplicitIdentifierAnswerCandidates already applies to its own single-identifier scans. */
  readonly definitionShaped: boolean;
  readonly isTestPath: boolean;
  readonly isDocPath: boolean;
}

/** Finds every occurrence of one fixed string in the workspace. Case-sensitive, same contract as the existing scanLiteral-backed recovery path. */
export type ConcernFixedStringScanner = (needle: string) => readonly ConcernScanHit[];

export interface ConcernSymbolWindow {
  readonly startLine: number;
  readonly endLine: number;
  readonly symbol?: string;
}

/** Resolves the smallest enclosing symbol around a line in a file, or undefined when the file can't be read/parsed or has no enclosing symbol (matches recoverExplicitIdentifierAnswerCandidates's own parsedSymbols-based lookup, which is inherently async — tree-sitter parsing). */
export type ConcernEnclosingSymbolReader = (
  path: string,
  centerLine: number,
) => Promise<ConcernSymbolWindow | undefined>;

export interface ConcernGroup {
  readonly id: string;
  readonly items: readonly ConcernRecoveryItem[];
}

interface AttributedHit extends ConcernScanHit {
  readonly member: string;
}

export interface ConcernFileScore {
  readonly path: string;
  readonly hits: readonly AttributedHit[];
  readonly distinctMembers: ReadonlySet<string>;
}

export interface ConcernCandidate {
  readonly groupId: string;
  readonly path: string;
  readonly matchedMembers: readonly string[];
  readonly distinctMemberCount: number;
  readonly range: string;
  readonly symbol?: string;
  /** First line of `range`, for candidates that need a single representative line (e.g. ImpactCandidate.line). */
  readonly line: number;
}

// ---------------------------------------------------------------------------
// Tunables (see module doc: structural, not corpus-specific)
// ---------------------------------------------------------------------------

/** Cap on how many literals one query's recovery run considers at all. */
export const MAX_RECOVERY_ITEMS = 12;
/** Max character gap between the end of one item and the start of the next for them to be treated as siblings from the same written list — a separator (", ", "、", " and ", "や", a bullet) is always short; unrelated intervening clause prose is not. */
const SIBLING_GROUP_GAP_CHARS = 24;
/** A group needs at least this many members to be considered at all. */
const MIN_GROUP_SIZE = 2;
/** All-plain-word groups (no code-shaped member at all) additionally need this many members before they're allowed to seed anything — a single common word must never pick a file. */
const MIN_GROUP_SIZE_ALL_PLAIN = 3;
/** Distinct members one file must contain to be selected, for a group with >=1 code-shaped member. */
const MIN_DISTINCT_MEMBERS = 2;
/** Distinct members one file must contain to be selected, for an all-plain-word group. */
const MIN_DISTINCT_MEMBERS_ALL_PLAIN = 3;
/** Hit-line gap beyond which two occurrences are treated as different clusters. */
const CLUSTER_GAP_LINES = 60;
/** Fallback margin around the densest cluster's hull when no small enough enclosing symbol exists. */
const FALLBACK_MARGIN_LINES = 12;
/** Hard cap on any returned window. */
const MAX_WINDOW_LINES = 80;

// ---------------------------------------------------------------------------
// Item preparation
// ---------------------------------------------------------------------------

/**
 * Dedupes items by lowercased text (keeping the earliest position and OR-ing
 * codeShaped across sources — the same literal can legitimately arrive from
 * more than one extractor, e.g. a backticked plain word), sorts by position,
 * and caps at MAX_RECOVERY_ITEMS. Exported so the hook and the spec share
 * exactly one preparation path.
 */
export function prepareConcernRecoveryItems(items: readonly ConcernRecoveryItem[]): ConcernRecoveryItem[] {
  const byKey = new Map<string, ConcernRecoveryItem>();
  for (const item of items) {
    if (item.text.trim().length === 0) continue;
    const key = item.text.toLowerCase();
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, item);
    } else {
      byKey.set(key, {
        text: existing.text,
        start: Math.min(existing.start, item.start),
        codeShaped: existing.codeShaped || item.codeShaped,
      });
    }
  }
  return [...byKey.values()].sort((a, b) => a.start - b.start).slice(0, MAX_RECOVERY_ITEMS);
}

/** Groups items into sibling runs by proximity (see SIBLING_GROUP_GAP_CHARS), dropping any run smaller than MIN_GROUP_SIZE. Singleton literals are NOT this module's concern — they keep the existing unique-definition-owner path unchanged. */
export function groupSiblingItems(items: readonly ConcernRecoveryItem[]): ConcernGroup[] {
  const sorted = [...items].sort((a, b) => a.start - b.start);
  const runs: ConcernRecoveryItem[][] = [];
  for (const item of sorted) {
    const run = runs[runs.length - 1];
    const last = run?.[run.length - 1];
    if (run && last && item.start - (last.start + last.text.length) <= SIBLING_GROUP_GAP_CHARS) {
      run.push(item);
    } else {
      runs.push([item]);
    }
  }
  return runs
    .filter((run) => run.length >= MIN_GROUP_SIZE)
    .map((run, index) => ({ id: `concern-group-${index}`, items: run }));
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Scores every file the group's members occur in, then selects the winning
 * file(s) by distinct-member co-occurrence (rule: require >=2 distinct
 * members, or >=3 for an all-plain-word group; a plain word never seeds a
 * NEW file on its own — it only adds corroborating weight inside a file a
 * code-shaped/punctuated sibling already pointed at). Returns [] when the
 * group doesn't qualify at all.
 */
export function scoreAndSelectFilesForGroup(
  group: ConcernGroup,
  scan: ConcernFixedStringScanner,
): ConcernFileScore[] {
  const hasCodeShaped = group.items.some((item) => item.codeShaped);
  if (!hasCodeShaped && group.items.length < MIN_GROUP_SIZE_ALL_PLAIN) return [];

  const seedItems = hasCodeShaped ? group.items.filter((item) => item.codeShaped) : group.items;
  const hitsByMember = new Map<string, readonly ConcernScanHit[]>();
  const seedPaths = new Set<string>();
  for (const item of group.items) {
    const hits = scan(item.text);
    hitsByMember.set(item.text, hits);
  }
  for (const item of seedItems) {
    for (const hit of hitsByMember.get(item.text) ?? []) seedPaths.add(hit.path);
  }
  if (seedPaths.size === 0) return [];

  const byPath = new Map<string, { path: string; hits: AttributedHit[]; distinctMembers: Set<string> }>();
  for (const item of group.items) {
    for (const hit of hitsByMember.get(item.text) ?? []) {
      if (!seedPaths.has(hit.path)) continue; // a plain word never seeds a file NOT already seeded above
      let entry = byPath.get(hit.path);
      if (!entry) {
        entry = { path: hit.path, hits: [], distinctMembers: new Set() };
        byPath.set(hit.path, entry);
      }
      entry.hits.push({ ...hit, member: item.text });
      entry.distinctMembers.add(item.text.toLowerCase());
    }
  }

  const minDistinct = hasCodeShaped ? MIN_DISTINCT_MEMBERS : MIN_DISTINCT_MEMBERS_ALL_PLAIN;
  const qualifying = [...byPath.values()].filter((entry) => entry.distinctMembers.size >= minDistinct);
  if (qualifying.length === 0) return [];

  const rankKey = (entry: (typeof qualifying)[number]): readonly number[] => {
    const definitionHits = entry.hits.filter((h) => h.definitionShaped).length;
    const isTest = entry.hits[0]!.isTestPath ? 1 : 0;
    const isDoc = entry.hits[0]!.isDocPath ? 1 : 0;
    return [-entry.distinctMembers.size, -definitionHits, isTest, isDoc, entry.path.length];
  };
  const sorted = [...qualifying].sort((a, b) => {
    const ka = rankKey(a);
    const kb = rankKey(b);
    for (let index = 0; index < ka.length; index += 1) {
      if (ka[index] !== kb[index]) return ka[index]! - kb[index]!;
    }
    return a.path.localeCompare(b.path);
  });

  const top = sorted[0]!;
  const second = sorted[1];
  const topIsImplementation = !top.hits[0]!.isTestPath && !top.hits[0]!.isDocPath;
  const tied = second !== undefined && rankKey(second).every((value, index) => value === rankKey(top)[index]);
  const secondIsImplementation = second !== undefined && !second.hits[0]!.isTestPath && !second.hits[0]!.isDocPath;

  const winners = tied && topIsImplementation && secondIsImplementation ? [top, second!] : [top];
  return winners.map((entry) => ({
    path: entry.path,
    hits: entry.hits,
    distinctMembers: entry.distinctMembers,
  }));
}

// ---------------------------------------------------------------------------
// Windowing
// ---------------------------------------------------------------------------

function densestCluster(hits: readonly AttributedHit[]): AttributedHit[] {
  const sorted = [...hits].sort((a, b) => a.line - b.line);
  const clusters: AttributedHit[][] = [];
  for (const hit of sorted) {
    const cluster = clusters[clusters.length - 1];
    const last = cluster?.[cluster.length - 1];
    if (cluster && last && hit.line - last.line <= CLUSTER_GAP_LINES) cluster.push(hit);
    else clusters.push([hit]);
  }
  clusters.sort((a, b) => {
    const distinctA = new Set(a.map((h) => h.member.toLowerCase())).size;
    const distinctB = new Set(b.map((h) => h.member.toLowerCase())).size;
    if (distinctA !== distinctB) return distinctB - distinctA;
    if (a.length !== b.length) return b.length - a.length;
    return a[0]!.line - b[0]!.line;
  });
  return clusters[0] ?? [];
}

/** Hull of the densest hit cluster, widened to the smallest enclosing symbol when that is <= MAX_WINDOW_LINES, else +/- FALLBACK_MARGIN_LINES around the hull, hard-capped at MAX_WINDOW_LINES. Never returns a one-line window. */
export async function computeConcernWindow(
  hits: readonly AttributedHit[],
  path: string,
  enclosingSymbol: ConcernEnclosingSymbolReader,
): Promise<ConcernSymbolWindow> {
  const cluster = densestCluster(hits);
  const lines = cluster.map((h) => h.line);
  const hullStart = Math.min(...lines);
  const hullEnd = Math.max(...lines);
  const centerLine = Math.round((hullStart + hullEnd) / 2);

  const symbolWindow = await enclosingSymbol(path, centerLine);
  if (symbolWindow && symbolWindow.endLine - symbolWindow.startLine + 1 <= MAX_WINDOW_LINES) {
    return symbolWindow;
  }

  let start = Math.max(1, hullStart - FALLBACK_MARGIN_LINES);
  let end = hullEnd + FALLBACK_MARGIN_LINES;
  if (end - start + 1 > MAX_WINDOW_LINES) end = start + MAX_WINDOW_LINES - 1;
  if (end - start + 1 < 2) end = start + 1; // never a one-line body
  return { startLine: start, endLine: end };
}

// ---------------------------------------------------------------------------
// Top-level orchestration
// ---------------------------------------------------------------------------

/**
 * The full pipeline: prepare -> group -> score/select per group -> window
 * per selected file. Returns one candidate per (group, selected file) pair —
 * ordinarily one candidate per group, two only when rule 3's tie condition
 * fires. Groups smaller than MIN_GROUP_SIZE, or that don't qualify under
 * scoreAndSelectFilesForGroup, contribute nothing (never a guess).
 */
export async function recoverConcernGroupCandidates(
  items: readonly ConcernRecoveryItem[],
  scan: ConcernFixedStringScanner,
  enclosingSymbol: ConcernEnclosingSymbolReader,
): Promise<ConcernCandidate[]> {
  const prepared = prepareConcernRecoveryItems(items);
  const groups = groupSiblingItems(prepared);
  const candidates: ConcernCandidate[] = [];
  for (const group of groups) {
    const selected = scoreAndSelectFilesForGroup(group, scan);
    for (const entry of selected) {
      const window = await computeConcernWindow(entry.hits, entry.path, enclosingSymbol);
      candidates.push({
        groupId: group.id,
        path: entry.path,
        matchedMembers: [...entry.distinctMembers],
        distinctMemberCount: entry.distinctMembers.size,
        range: `${window.startLine}-${window.endLine}`,
        ...(window.symbol ? { symbol: window.symbol } : {}),
        line: window.startLine,
      });
    }
  }
  return candidates;
}

/** Number of sibling groups a set of items would form — a cheap early-exit guard so the hook never builds a scanner/enclosing-symbol closure when there is nothing to recover. */
export function countSiblingGroups(items: readonly ConcernRecoveryItem[]): number {
  return groupSiblingItems(prepareConcernRecoveryItems(items)).length;
}

// ---------------------------------------------------------------------------
// Prose multi-concern DIVERSIFICATION (Phase 3, orchestrator adjudication
// 2026-09-19). A SEPARATE mechanism from the sibling-group recovery above:
// it never adds a candidate the locator did not already produce, it only
// REORDERS an existing candidate list so that each of the query's clauses
// (including a plain prose clause with no literal at all — extractRequestItems
// output, not just enumerated-item facets) gets its own best-matching
// candidate surfaced early, instead of the locator's original relevance
// order silently starving every clause but the first. No file reads, no
// tokenizer of its own: `tokenize` is injected by the caller (the hook binds
// it to features/retrieval/tokenize.ts's own tokenizeQuery, reused, not
// duplicated) and applied to path segments / symbol names the candidate
// already carries — never to freshly-read file content.
// ---------------------------------------------------------------------------

export interface DiversifyCandidate {
  readonly path: string;
  readonly symbol?: string;
}

/** A clause counts as matching a candidate when >=2 of its own tokens land in that candidate's token set, or one token of at least this length does — the same "one strong signal or two corroborating ones" shape scoreAndSelectFilesForGroup already uses above. */
const DIVERSIFY_MIN_DISTINCT_TOKENS = 2;
const DIVERSIFY_MIN_LONG_TOKEN_CHARS = 6;

function candidateTokenSet<T extends DiversifyCandidate>(
  candidate: T,
  tokenize: (text: string) => readonly string[],
): Set<string> {
  const pathWords = tokenize(candidate.path.replace(/[\\/]/gu, " "));
  const symbolWords = candidate.symbol ? tokenize(candidate.symbol) : [];
  return new Set([...pathWords, ...symbolWords].map((token) => token.toLowerCase()));
}

function clauseMatchesCandidate(clauseTokens: ReadonlySet<string>, candidateTokens: ReadonlySet<string>): boolean {
  let distinctMatches = 0;
  for (const token of clauseTokens) {
    if (!candidateTokens.has(token)) continue;
    distinctMatches += 1;
    if (token.length >= DIVERSIFY_MIN_LONG_TOKEN_CHARS) return true;
    if (distinctMatches >= DIVERSIFY_MIN_DISTINCT_TOKENS) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Per-CLAUSE locate recovery (Phase 4, Agent D, 2026-09-19). A THIRD
// mechanism, additive to the two above and always run strictly AFTER both
// in the caller: a clause that carries no literal at all (a plain prose
// question, e.g. "..., and where is user authentication performed?") never
// seeds the sibling-literal recovery above (nothing to scan for) and
// reordering (diversifyByConcern) cannot manufacture a candidate the
// locator's ONE fused search over the whole query never produced in the
// first place -- the clause's real answer files are simply not anywhere in
// the candidate list. This module still never calls the locator itself
// (PURE / INJECTED I/O ONLY, see the module doc at the top of this file):
// the caller re-locates on the clause's own text and hands the raw result
// to `pickClauseLocateCandidate`; everything here is plain-data decision
// logic, testable with hand-built fixtures, same as every export above.
// ---------------------------------------------------------------------------

/** Cap on how many of a query's UNCOVERED clauses one call will re-locate for. */
export const MAX_CLAUSE_LOCATES = 3;

/**
 * A clause is covered when some candidate already inside the caller's
 * current selection window matches it -- using EXACTLY diversifyByConcern's
 * own clause-match scoring (`candidateTokenSet` + `clauseMatchesCandidate`
 * above), never a second scorer or tokenizer.
 */
/** Same predicate as isClauseCoveredByCandidates, but over an ALREADY-built token set -- the primitive a caller extending a clause's tokens (stem neighbours, ja-bridge expansions) needs, since isClauseCoveredByCandidates always re-tokenizes clauseText alone. */
export function isClauseCoveredByTokens<T extends DiversifyCandidate>(
  clauseTokens: ReadonlySet<string>,
  windowCandidates: readonly T[],
  tokenize: (text: string) => readonly string[],
): boolean {
  if (windowCandidates.length === 0) return false;
  return windowCandidates.some((candidate) =>
    clauseMatchesCandidate(clauseTokens, candidateTokenSet(candidate, tokenize)),
  );
}

/**
 * The tokens of clause `index` that no OTHER clause of the same request
 * uses -- what that clause is about, as opposed to what the whole request is
 * about. "the order cancel API endpoint, OrderService cancel logic, ...":
 * every clause says "cancel", so a served `OrderService.cancelOrder` matched
 * the endpoint clause on the shared topic word alone, the clause was judged
 * covered, and the controller was never looked for (live GitHub Copilot
 * sessions, 2026-09-19). Coverage is judged on the distinctive tokens when
 * the clause has any; a clause with none (or a request of one clause) keeps
 * its full token set, exactly as before.
 */
export function distinctiveClauseTokens(
  clauseTokenSets: readonly ReadonlySet<string>[],
  index: number,
): ReadonlySet<string> {
  const own = clauseTokenSets[index] ?? new Set<string>();
  if (clauseTokenSets.length < 2) return own;
  const distinctive = new Set<string>();
  for (const token of own) {
    if (!clauseTokenSets.some((other, otherIndex) => otherIndex !== index && other.has(token))) distinctive.add(token);
  }
  return distinctive.size > 0 ? distinctive : own;
}

/**
 * A clause that names a served file by its stem ("OrderService の cancel
 * 処理", with `.../OrderService.java` in the window) is covered by that file
 * whatever its other words are -- the identifier IS the clause's anchor.
 * Without this, judging such a clause on its distinctive tokens alone would
 * find only the prose around the name and spend a locate on a clause whose
 * answer is already in the pack.
 */
export function clauseNamesWindowFile<T extends DiversifyCandidate>(
  clauseText: string,
  windowCandidates: readonly T[],
): boolean {
  if (windowCandidates.length === 0) return false;
  const words = new Set((clauseText.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []).map((word) => word.toLowerCase()));
  if (words.size === 0) return false;
  return windowCandidates.some((candidate) => {
    const base = candidate.path.slice(candidate.path.lastIndexOf("/") + 1);
    const dot = base.lastIndexOf(".");
    return words.has((dot > 0 ? base.slice(0, dot) : base).toLowerCase());
  });
}

export function isClauseCoveredByCandidates<T extends DiversifyCandidate>(
  clauseText: string,
  windowCandidates: readonly T[],
  tokenize: (text: string) => readonly string[],
): boolean {
  const clauseTokens = new Set(tokenize(clauseText).map((token) => token.toLowerCase()));
  return isClauseCoveredByTokens(clauseTokens, windowCandidates, tokenize);
}

export interface SeededCoverageSurface extends DiversifyCandidate {
  /** The surface's own served body text, when the caller was actually shown it -- a skeleton/handle-only surface has none. See isClauseCoveredBySeededSurfaces's own doc comment. */
  readonly bodyText?: string;
}

/**
 * A SEEDED pack (buildSeededTaskPack) has already READ every caller-named
 * file, unlike the locate-only DiversifyCandidate isClauseCoveredByTokens
 * works with above -- so a clause whose terms appear nowhere in a surface's
 * path or symbol can still be genuinely answered by text that surface
 * already embeds. `bodyText` undefined degrades to the exact same
 * path+symbol-only test as isClauseCoveredByTokens -- strictly more
 * information available, never less.
 *
 * Deliberately NOT clauseMatchesCandidate's flat token-set rule applied to
 * path+symbol+text as one bag (measured false-positive: a JA seeded query
 * asking about coupon validation was marked "covered" by a seeded FILE
 * whose only relation was one incidental field/import mentioning "coupon"
 * in passing, at length >=6, silently skipping recovery of the real
 * definition file). Path/symbol is a deliberate naming choice, so a single
 * long (>=6-char) match there is trustworthy; served body text is far
 * noisier (a file mentions many things it does not substantively answer),
 * so a match sourced ONLY from body text must clear the stronger
 * two-distinct-token bar, never the single-token one -- the same asymmetry
 * queryRecoveryTerms.ts's expansionsSupportCandidate already applies (its
 * own single-strong-token rule is scoped to path+symbol only).
 */
export function isClauseCoveredBySeededSurfaces<T extends SeededCoverageSurface>(
  clauseTokens: ReadonlySet<string>,
  surfaces: readonly T[],
  tokenize: (text: string) => readonly string[],
): boolean {
  if (surfaces.length === 0) return false;
  return surfaces.some((surface) => {
    const pathSymbolTokens = candidateTokenSet(surface, tokenize);
    if (clauseMatchesCandidate(clauseTokens, pathSymbolTokens)) return true;
    if (surface.bodyText === undefined) return false;
    const combinedTokens = new Set(pathSymbolTokens);
    for (const token of tokenize(surface.bodyText)) combinedTokens.add(token.toLowerCase());
    let distinctMatches = 0;
    for (const token of clauseTokens) {
      if (!combinedTokens.has(token)) continue;
      distinctMatches += 1;
      if (distinctMatches >= DIVERSIFY_MIN_DISTINCT_TOKENS) return true;
    }
    return false;
  });
}

/**
 * Picks ONE candidate out of a per-clause locate call: a hit's own primary
 * (the locator's single best answer to the clause's own text), or --
 * abstaining -- the first candidate the caller's OWN rankAbstainCandidates
 * ordering produces that is both an implementation candidate and already
 * carries a resolved `.symbol` (a symbol-less abstain candidate is the same
 * "background range" shape the caller's selection loop already treats as
 * noise elsewhere, never worth injecting here either). `rankAbstain` /
 * `isImplementation` / `hasSymbol` are the caller's own
 * readCodeTaskPack.ts predicates, injected rather than re-implemented.
 */
export function pickClauseLocateCandidate<C extends { path: string; confidence: number }>(
  result: { hit: boolean; primary?: readonly C[]; candidateDetails?: readonly C[] },
  rankAbstain: (candidates: readonly C[]) => readonly C[],
  isImplementation: (candidate: C) => boolean,
  hasSymbol: (candidate: C) => boolean,
  /** Phase 2 (Agent D) retry policy: on a RETRY ONLY, also accept a symbol-less implementation candidate that passes this stricter check (e.g. >=2 distinct neighbour-extended token matches) -- the caller's own self-coverage re-check afterward is what still protects precision. Omit for the strict first-attempt policy (a resolved `.symbol` is required). */
  allowSymbolLessIfStronglyCovered?: (candidate: C) => boolean,
): C | undefined {
  if (result.hit) return result.primary?.[0];
  const ranked = rankAbstain(result.candidateDetails ?? []);
  const strict = ranked.find((candidate) => isImplementation(candidate) && hasSymbol(candidate));
  if (strict !== undefined || allowSymbolLessIfStronglyCovered === undefined) return strict;
  return ranked.find((candidate) => isImplementation(candidate) && allowSymbolLessIfStronglyCovered(candidate));
}

export interface ConcernMergeOutcome<T> {
  readonly candidates: T[];
  readonly selectionLimit: number;
  /** How much of the caller's OWN displacementBudgetRemaining this call actually spent -- subtract it before the caller's next call so a shared budget is spent across mechanisms, not reset per mechanism. */
  readonly displacedUsed: number;
  /** Paths this call actually PROMOTED or ADDED (rules b/c below) -- never a path it DROPPED (rule a). The caller folds this into its own concernRecoveredPaths (the selection loop's drop-rule exemption): a dropped addition earns its file no exemption it did not already have. */
  readonly appliedPaths: ReadonlySet<string>;
}

/**
 * The window-aware merge BOTH concern-recovery mechanisms use to fold
 * additive candidates into an already-decided candidates/selectionLimit
 * pair. Extracted (Phase 4) from the literal/enumerated mechanism's own
 * inline version so a displacement budget can be SHARED across it and the
 * per-clause mechanism below: the caller passes whatever budget remains
 * (starting at 2, the original hard cap) and decrements it by this call's
 * own `displacedUsed` before the next one, so across both mechanisms
 * combined at most the STARTING budget's worth of window slots are ever
 * displaced -- and a locator primary (index < primaryCount) never is.
 *
 * FX-CR1 (orchestrator adjudication, 2026-09-19; found by the first full
 * suite run under TL_CONCERN_RECOVERY's new default). The pre-fix version
 * decided "same file or new file" by checking each addition against only the
 * CURRENT WINDOW's paths, then always kept the addition's OWN object,
 * appending it past the window on a same-file match. Two bugs followed: (1)
 * a path already present in `candidates` but BEYOND the window (not yet
 * selected) read as "new", so its concern addition became a SECOND,
 * freshly-built object for a file the locator already carries -- two rows,
 * two ranges, one path (duplicate evidence: taskProfileBinding.spec.ts's
 * OrderOrchestrator answer, semanticSignalRegression.spec.ts T03's
 * OrderService). Worse, with a withheld-body policy downstream
 * (TL_SF_DEMOTE's `packSiblingServesThisWindow` check in canonicalDecision.ts),
 * that second row let a supporting surface's demotion-eligibility check see
 * its OWN content mirrored by a "sibling" row and refuse to withhold either
 * (sfShippedBookings.spec.ts). (2) `selectionLimit` rose by the caller's own
 * pre-counted "distinct contributing groups", even when a group's whole
 * contribution turned out to be a same-file duplicate that changed nothing
 * -- a single-answer mode (limit 1) silently became limit 2 and served the
 * same file twice.
 *
 * The fix processes each addition, IN ORDER, against the then-current window
 * and full candidate list:
 *   (a) its path is already inside the window (the first `selectionLimit`
 *       entries) -> DROP the addition outright. The window's own entry for
 *       that file -- its range, its `why`, any downstream policy mark such as
 *       an SF demotion eligibility -- stands untouched. Never appended
 *       anywhere, never counted toward the limit raise.
 *   (b) else its path exists in `candidates` BEYOND the window -> PROMOTE
 *       that EXISTING entry (the same object -- its own range/why/marks, NOT
 *       the addition's freshly-computed one) into the window: free room
 *       first, else one of the window's last slots under the shared
 *       displacement budget (never a locator primary). No second entry for
 *       that path is ever created.
 *   (c) else -> add the new entry, placed the same way as (b).
 * A path repeated across several `additions` in one call resolves once, on
 * its first occurrence -- exactly like a real one-at-a-time walk would
 * settle it before any later addition for the same path is even considered.
 *
 * `selectionLimit` rises ONLY by the count of entries actually promoted or
 * added under (b)/(c) -- never for a dropped (a) addition -- capped at
 * `maxSurfacesDistinct`. `appliedPaths` reports exactly those paths, for the
 * caller's `concernRecoveredPaths` bookkeeping.
 */
export function mergeConcernAdditions<T extends { path: string }>(
  candidates: readonly T[],
  selectionLimit: number,
  additions: readonly T[],
  primaryCount: number,
  displacementBudgetRemaining: number,
  maxSurfacesDistinct: number,
): ConcernMergeOutcome<T> {
  if (additions.length === 0) {
    return { candidates: [...candidates], selectionLimit, displacedUsed: 0, appliedPaths: new Set() };
  }

  const windowSize = Math.min(candidates.length, selectionLimit);
  const windowPaths = new Set(candidates.slice(0, windowSize).map((c) => c.path));
  const beyondWindow = candidates.slice(windowSize);

  const handled = new Set<string>(); // every path this call has already resolved (dropped, promoted, or added)
  const promotedPaths = new Set<string>();
  const promoted: T[] = [];
  const added: T[] = [];

  for (const addition of additions) {
    if (handled.has(addition.path)) continue; // a later addition for a path this SAME call already settled
    if (windowPaths.has(addition.path)) {
      handled.add(addition.path);
      continue; // rule (a): drop -- the window's own entry for this file stands
    }
    const existing = beyondWindow.find((c) => c.path === addition.path && !promotedPaths.has(c.path));
    if (existing !== undefined) {
      promoted.push(existing);
      promotedPaths.add(addition.path);
      handled.add(addition.path);
      continue; // rule (b): promote the EXISTING entry, never the addition's own
    }
    added.push(addition); // rule (c): a genuinely new path
    handled.add(addition.path);
  }

  const pool = [...promoted, ...added];
  if (pool.length === 0) {
    return { candidates: [...candidates], selectionLimit, displacedUsed: 0, appliedPaths: new Set() };
  }

  const limit = Math.min(maxSurfacesDistinct, selectionLimit + pool.length);
  // Remove promoted entries from their old (beyond-window) position; the
  // window prefix [0, windowSize) is never touched by this filter, so the
  // freeRoom/displaceable/keep math below -- computed against the ORIGINAL
  // windowSize -- stays valid against the filtered array.
  const withoutPromoted = candidates.filter((c, index) => !(index >= windowSize && promotedPaths.has(c.path)));
  const freeRoom = limit - windowSize;
  const displaceable = Math.max(0, windowSize - Math.max(1, primaryCount));
  const displaced = Math.min(displacementBudgetRemaining, displaceable, Math.max(0, pool.length - freeRoom));
  const keep = windowSize - displaced;
  const merged = [...withoutPromoted.slice(0, keep), ...pool, ...withoutPromoted.slice(keep)];

  return {
    candidates: merged,
    selectionLimit: limit,
    displacedUsed: displaced,
    appliedPaths: new Set(pool.map((c) => c.path)),
  };
}

// Test-only instrumentation (mirrors readCodeTaskPack.ts's own
// concernRecoveryEntryCount pattern, scoped to just this mechanism so an
// eval can assert the per-clause locate is never entered for a
// single-clause query): never read or gated on by production logic.
let clauseLocateAttemptCountForTest = 0;
export function clauseLocateAttemptCount(): number {
  return clauseLocateAttemptCountForTest;
}
export function resetClauseLocateAttemptCountForTest(): void {
  clauseLocateAttemptCountForTest = 0;
}
/** Called by the caller's hook immediately before each actual per-clause locate call. */
export function recordClauseLocateAttempt(): void {
  clauseLocateAttemptCountForTest += 1;
}

// Separate test-only counter for buildSeededTaskPack's OWN clause-recovery
// hook (Agent J, 2026-09-19). Not folded into concernRecoveryEntryCount
// above: that counter's own doc comment (readCodeTaskPack.ts) states its
// increment is unique to buildAnswerTaskPack entering concernRecoveryEnabled()
// -- reusing it here would make that claim false. This mechanism calls
// neither diversifyByConcern nor recoverConcernCandidates, so that claim
// still holds unchanged.
let seededClauseRecoveryEntryCountForTest = 0;
export function seededClauseRecoveryEntryCount(): number {
  return seededClauseRecoveryEntryCountForTest;
}
export function resetSeededClauseRecoveryEntryCountForTest(): void {
  seededClauseRecoveryEntryCountForTest = 0;
}
/** Called by buildSeededTaskPack's hook once it commits to running the seeded per-clause recovery pass (>=2 hygienic clauses, flag on, answer profile) -- before computing coverage, so it reflects "entered the mechanism", not "found something to recover". */
export function recordSeededClauseRecoveryEntry(): void {
  seededClauseRecoveryEntryCountForTest += 1;
}

/**
 * Reorders `candidates` so each qualifying clause's best (= earliest-ranked
 * qualifying) candidate is taken in clause order first, then every remaining
 * candidate follows in its ORIGINAL order. Returns a new array; never
 * mutates, never adds, never drops an entry. A no-op (returns `[...candidates]`
 * unchanged) when fewer than 2 candidates or fewer than 2 clauses exist, or
 * when fewer than 2 clauses actually have a qualifying candidate — picking
 * one clause's favourite is not diversification, it is a coin flip.
 *
 * FX-CR3 (orchestrator adjudication, 2026-09-19; sfShippedBookings.spec.ts
 * investigation). `pinnedPrefixCount` (default 0, so every existing caller
 * and unit test is byte-identical) keeps the leading `pinnedPrefixCount`
 * candidates AT THE FRONT, in their original relative order, immune from
 * ever being pulled later by a clause that happens to be processed first in
 * `clauseTexts` -- `extractRequestItems` does not promise its own output is
 * in QUERY-TEXT order (measured: a query naming subject A first, then
 * relation-to-B second, extracted B-relation-clause BEFORE the A-subject
 * clause), so clause-order-first processing could otherwise swap the
 * locator's own top-ranked candidate out of slot 0 even though nothing was
 * added or dropped. That swap is invisible to THIS module (no candidate
 * count changed, no body changed) but not to a caller keying off array
 * position -- readCodeTaskPack.ts's own downstream SF-demote integration
 * treats slot 0 as the answer's primary/non-demotable surface, so
 * reordering it out from under that assumption let a demotion-eligible
 * "supporting" row become the new slot-0 primary and the true primary
 * become the demotable one, withholding the wrong file's body. A pinned
 * candidate still COUNTS toward a clause's match (so that clause is not
 * artificially starved into pulling a redundant duplicate forward) --
 * `taken` marks it up front, exactly as if it had been the natural winner
 * of its own clause.
 */
export function diversifyByConcern<T extends DiversifyCandidate>(
  candidates: readonly T[],
  clauseTexts: readonly string[],
  tokenize: (text: string) => readonly string[],
  pinnedPrefixCount = 0,
): T[] {
  if (candidates.length < 2 || clauseTexts.length < 2) return [...candidates];

  const candidateTokens = candidates.map((candidate) => candidateTokenSet(candidate, tokenize));
  const clauseTokenSets = clauseTexts.map((text) => new Set(tokenize(text).map((token) => token.toLowerCase())));

  const bestForClause: Array<number | undefined> = clauseTokenSets.map((clauseTokens) => {
    for (let index = 0; index < candidateTokens.length; index += 1) {
      if (clauseMatchesCandidate(clauseTokens, candidateTokens[index]!)) return index;
    }
    return undefined;
  });

  const qualifyingClauseCount = bestForClause.filter((index) => index !== undefined).length;
  if (qualifyingClauseCount < 2) return [...candidates];

  const pinned = Math.max(0, Math.min(pinnedPrefixCount, candidates.length));
  const taken = new Set<number>();
  for (let index = 0; index < pinned; index += 1) taken.add(index);
  const reordered: T[] = candidates.slice(0, pinned);
  for (const index of bestForClause) {
    if (index === undefined || taken.has(index)) continue;
    taken.add(index);
    reordered.push(candidates[index]!);
  }
  for (let index = 0; index < candidates.length; index += 1) {
    if (!taken.has(index)) reordered.push(candidates[index]!);
  }
  return reordered;
}

// ---------------------------------------------------------------------------
// Clause-list hygiene + neighbour-extended retry ("Phase 2 for Agent D",
// orchestrator adjudication 2026-09-19). Fixes the budget-burn diagnosed in
// the prior report: extractRequestItems can (a) emit several BYTE-IDENTICAL
// copies of the same relation clause when its actor is an enumerated noun
// list (O1: "low, normal, urgent, critical" -> 4 identical clause items),
// and (b) fragment one enumerated/backtick-literal list into one topic item
// PER MEMBER (E4: `invalid_input`/`not_found`/`unauthorized`/`rate_limited`
// -> 4 separate items) -- both shapes silently exhausted MAX_CLAUSE_LOCATES
// on redundant or already-literal-recovered clauses before the mechanism
// ever reached the genuinely uncovered prose clause that motivated it. This
// section is pure query-SHAPE hygiene: it never reads a fixture name, task
// id, or corpus path, only the structure of the items extractRequestItems
// already produced.
// ---------------------------------------------------------------------------

export interface ClauseHygieneItem {
  readonly id: string;
  readonly text: string;
}

function normalizeClauseText(text: string): string {
  return text.trim().replace(/\s+/gu, " ").toLowerCase();
}

// FX-CR2 (orchestrator adjudication, 2026-09-19; mc2 investigation). A query
// can open with a copy-pasted category/priority TAG (e.g. "[実業務 オンコール
// 対応]") or introduce an enumerated list below it with a bare HEADER line
// (e.g. "報告された症状:") -- pure framing, never the caller's own question.
// Neither names anything to search for, and both are grammatically prose (no
// code-shaped literal), so without this filter the prose-first ordering
// below would put them AHEAD of the query's real clauses, burning
// MAX_CLAUSE_LOCATES on a locate call that cannot help before a single
// substantive clause ever gets one.

/** Matching (open, close) bracket pairs a whole-text tag can be wrapped in -- ASCII and the two common CJK full-width styles. */
const WRAPPING_TAG_BRACKETS: ReadonlyArray<readonly [string, string]> = [
  ["[", "]"],
  ["［", "］"], // ［ ］
  ["【", "】"], // 【 】
];

/** True when `text`, trimmed, is ENTIRELY one bracket-wrapped span with nothing outside it -- a tag/label, not a clause of its own (e.g. "[実業務 オンコール対応]"). A span that merely STARTS with a tag ahead of real content (e.g. "[Bug] the login form...") is not this -- the closing bracket must be the very last character. */
function isWholeTextBracketTag(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 2) return false;
  return WRAPPING_TAG_BRACKETS.some(([open, close]) => {
    if (!trimmed.startsWith(open) || !trimmed.endsWith(close)) return false;
    return trimmed.indexOf(close) === trimmed.length - close.length;
  });
}

/** True when `text`, trimmed, ends in a colon and asks no question -- a label introducing a list below it (e.g. "報告された症状:"), never a clause with content of its own. Never drops a real question that happens to end in ":" (rare), since a "?"/"？" anywhere in the text disqualifies it. */
function isColonHeaderLine(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  if (/[?？]/u.test(trimmed)) return false;
  return /[:：]$/u.test(trimmed);
}

/** A clause item that is pure query FRAMING (a whole-text bracket tag or a colon-terminated header line) rather than the caller's own question -- see the block doc above. */
function isFramingNotAClause(text: string): boolean {
  return isWholeTextBracketTag(text) || isColonHeaderLine(text);
}

const BACKTICK_LITERAL_SPAN_RE = /`[^`\n]+`/gu;
// The last alternative is a bare ALL-CAPS word of three or more characters
// (PAID, CANCELLED, HTTP2): an enumerated constant written without an
// underscore is still a literal, not a clause. Seeded-pack eval, 2026-09-19:
// "... PAID, CANCELLED, REFUNDED ..." arrived as three prose clauses ahead of
// the request's two real ones and spent all of MAX_CLAUSE_LOCATES. Two
// capitals alone ("ID", "OK", "UI") stay prose -- too short to be a name.
const CODE_SHAPED_BARE_TOKEN_RE =
  /\b(?:[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+|[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|[A-Z][A-Z0-9]{2,})\b/gu;

/**
 * Upper-case words a request uses as ordinary technical vocabulary ("the
 * cancel API endpoint", "returns JSON"), not as the name of a symbol. Live
 * GitHub Copilot sessions, 2026-09-19: "API" became an explicit-identifier
 * obligation, the served class did not contain the word, and the pack spent
 * its one follow-up on `find ["API"]` -- a turn that could not help, taken in
 * two of three sessions. A backtick-quoted `API` is still a literal: quoting
 * is the caller saying "this exact token".
 */
export const PROSE_ACRONYMS: ReadonlySet<string> = new Set([
  "api", "apis", "url", "urls", "uri", "http", "https", "json", "xml", "yaml", "toml", "html", "css",
  "sql", "cli", "gui", "sdk", "csv", "pdf", "tcp", "udp", "dns", "ssl", "tls", "ssh", "ftp", "smtp",
  "rest", "grpc", "crud", "jwt", "utf", "ascii", "ide", "mvc", "orm", "dto", "dao", "jvm", "jdk",
  "npm", "llm", "cpu", "gpu", "ram", "ttl", "faq", "todo", "fixme", "readme", "wip", "poc", "mvp",
]);

/** A bare ALL-CAPS word that is prose vocabulary rather than a name -- see PROSE_ACRONYMS. */
export function isProseAcronym(token: string): boolean {
  return /^[A-Z][A-Z0-9]{2,}$/.test(token) && PROSE_ACRONYMS.has(token.toLowerCase());
}

/** True when `text` names a code-shaped identifier (camelCase/snake_case/CONST_CASE, or a bare ALL-CAPS word that is not prose vocabulary) or a backtick-quoted span -- the same literal shapes the sibling/literal recovery mechanism (buildConcernRecoveryItems) already scans the workspace for. */
function containsCodeShapedLiteral(text: string): boolean {
  BACKTICK_LITERAL_SPAN_RE.lastIndex = 0;
  if (BACKTICK_LITERAL_SPAN_RE.test(text)) return true;
  for (const match of text.matchAll(CODE_SHAPED_BARE_TOKEN_RE)) {
    if (!isProseAcronym(match[0])) return true;
  }
  return false;
}

const LITERAL_SPAN_MARKER = "￼";

/** `text` with every detected literal span collapsed to one marker character (for grouping items that share a sentence stem and differ only by WHICH literal they name), plus how many whole words are left once every literal span is simply removed (for detecting an item that names nothing BUT a literal). U+FFFC (OBJECT REPLACEMENT CHARACTER) is used as the marker since it is printable and vanishingly unlikely to occur in a real query. */
function literalSpansStripped(text: string): { stemPlaceholder: string; leftoverWordCount: number } {
  const withMarker = text
    .replace(BACKTICK_LITERAL_SPAN_RE, LITERAL_SPAN_MARKER)
    .replace(CODE_SHAPED_BARE_TOKEN_RE, (token) => (isProseAcronym(token) ? token : LITERAL_SPAN_MARKER));
  const stemPlaceholder = normalizeClauseText(withMarker.split(LITERAL_SPAN_MARKER).join("%LIT%"));
  const leftover = withMarker.split(LITERAL_SPAN_MARKER).join(" ").trim().replace(/\s+/gu, " ");
  const leftoverWordCount = leftover.length === 0 ? 0 : leftover.split(" ").length;
  return { stemPlaceholder, leftoverWordCount };
}

/** An item counts as "just a literal" when removing every detected literal span from it leaves at most this many whole words -- catches both a bare `` `token` `` item and a near-bare one like `` `rate_limited` mean ``. */
const LITERAL_ONLY_MAX_LEFTOVER_WORDS = 1;

/**
 * Builds the per-clause work list a locate-recovery pass should actually
 * spend its budget on: (a) exact-text duplicates (trim/collapse-whitespace/
 * lowercase) collapse to their first occurrence; (b) every item that is
 * JUST one enumerated/backtick literal (at most one leftover word) collapses
 * to a single representative (the first one seen) -- they are already the
 * literal/sibling mechanism's own job; among the REMAINING items, ones that
 * share the same literal-placeholder sentence stem (differ only by WHICH
 * literal they name) also collapse to their first occurrence; (c) items
 * with no code-shaped literal at all (pure prose -- the shape a bare
 * literal scan can never seed) move to the FRONT, in their own relative
 * query order, ahead of every item that does name a literal. Pure query
 * FRAMING -- a whole-text bracket tag or a colon-terminated header line
 * introducing a list (FX-CR2; see isFramingNotAClause above) -- is dropped
 * outright, before dedup, and never enters the work list at all: it is
 * prose-shaped but names nothing, so left in it would otherwise win the
 * front-of-list seat (c) reserves for the query's real clauses. The caller
 * applies MAX_CLAUSE_LOCATES to this list's OUTPUT, not its input.
 */
export function hygienicClauseWorkList<T extends ClauseHygieneItem>(items: readonly T[]): T[] {
  const seenText = new Set<string>();
  const deduped: T[] = [];
  for (const item of items) {
    if (isFramingNotAClause(item.text)) continue;
    const key = normalizeClauseText(item.text);
    if (seenText.has(key)) continue;
    seenText.add(key);
    deduped.push(item);
  }

  let literalOnlyKept = false;
  const seenStem = new Set<string>();
  const survivors: T[] = [];
  for (const item of deduped) {
    if (!containsCodeShapedLiteral(item.text)) {
      survivors.push(item);
      continue;
    }
    const { stemPlaceholder, leftoverWordCount } = literalSpansStripped(item.text);
    if (leftoverWordCount <= LITERAL_ONLY_MAX_LEFTOVER_WORDS) {
      if (literalOnlyKept) continue;
      literalOnlyKept = true;
      survivors.push(item);
      continue;
    }
    if (seenStem.has(stemPlaceholder)) continue;
    seenStem.add(stemPlaceholder);
    survivors.push(item);
  }

  const prose = survivors.filter((item) => !containsCodeShapedLiteral(item.text));
  const rest = survivors.filter((item) => containsCodeShapedLiteral(item.text));
  return [...prose, ...rest];
}

// ---------------------------------------------------------------------------
// Named definitions (2026-09-19, live GitHub Copilot sessions)
// ---------------------------------------------------------------------------
//
// "... OrderService の cancel 処理、PaymentService の refund メソッド、OrderStatus
// enum 定義" names three types. The answer pack treated the first one as THE
// exact answer (its file stem is a named identifier, so the selection
// collapsed to one surface) and counted the other two as covered because the
// served class merely MENTIONS them. The caller then fetched both files
// itself, one model turn each. A type the request names, whose name is the
// stem of exactly one implementation file, is a stated requirement in the
// same sense a query-named path is: serve its file in the first pack.

/** One file per named identifier, at most this many per pack. */
export const MAX_NAMED_DEFINITION_FILES = 3;

export interface NamedDefinitionOptions {
  /** Workspace-relative directory the request is confined to, when it is. */
  readonly scopePath?: string;
  readonly isTestPath: (filePath: string) => boolean;
  /** Paths the pack's selection already serves -- an identifier whose file is among them needs nothing. */
  readonly servedPaths: ReadonlySet<string>;
}

export interface NamedDefinitionFile {
  readonly identifier: string;
  readonly path: string;
}

function fileStem(filePath: string): string {
  const base = filePath.slice(filePath.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * For each identifier the request names (query order, case-insensitively
 * deduplicated), the ONE non-test file under `scopePath` whose stem is that
 * identifier: an exact-case stem wins, a case-insensitive one is accepted only
 * when no exact-case file exists, and two or more equally good files resolve
 * nothing -- ambiguity is never settled by walk order. Identifiers whose file
 * the selection already serves are skipped without spending a slot.
 */
export function namedDefinitionFiles(
  identifiers: readonly string[],
  files: readonly string[],
  options: NamedDefinitionOptions,
): NamedDefinitionFile[] {
  const scope = options.scopePath === undefined ? "" : options.scopePath.replace(/^\.\//, "").replace(/\/+$/, "");
  const inScope = (filePath: string): boolean => scope === "" || filePath === scope || filePath.startsWith(`${scope}/`);
  const byStem = new Map<string, string[]>();
  for (const filePath of files) {
    if (!inScope(filePath) || options.isTestPath(filePath)) continue;
    const key = fileStem(filePath).toLowerCase();
    const bucket = byStem.get(key);
    if (bucket === undefined) byStem.set(key, [filePath]);
    else bucket.push(filePath);
  }
  const out: NamedDefinitionFile[] = [];
  const seen = new Set<string>();
  for (const identifier of identifiers) {
    const key = identifier.toLowerCase();
    if (identifier.length < 3 || seen.has(key)) continue;
    seen.add(key);
    const bucket = byStem.get(key) ?? [];
    const exactCase = bucket.filter((filePath) => fileStem(filePath) === identifier);
    const chosen = exactCase.length === 1
      ? exactCase[0]
      : exactCase.length === 0 && bucket.length === 1
        ? bucket[0]
        : undefined;
    if (chosen === undefined || options.servedPaths.has(chosen)) continue;
    out.push({ identifier, path: chosen });
    if (out.length >= MAX_NAMED_DEFINITION_FILES) break;
  }
  return out;
}

/** How many request words after a named identifier are read as "its member" -- "PaymentService の refund メソッド", "OrderService cancel logic". */
const NAMED_MEMBER_LOOKAHEAD_WORDS = 3;

/**
 * The member of `identifier` the request is asking about: the first of the
 * few ASCII words FOLLOWING the identifier in the request (stopping at the
 * next named identifier) that is the name of a symbol defined in its file.
 * `undefined` means "the type itself". Position-bound on purpose -- a word
 * elsewhere in the request belongs to some other point of it.
 */
export function namedMemberAfterIdentifier(
  query: string,
  identifier: string,
  otherIdentifiers: readonly string[],
  memberNames: ReadonlySet<string>,
): string | undefined {
  const at = query.indexOf(identifier);
  if (at < 0) return undefined;
  const others = new Set(otherIdentifiers.map((name) => name.toLowerCase()));
  const following = query.slice(at + identifier.length).match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [];
  for (const word of following.slice(0, NAMED_MEMBER_LOOKAHEAD_WORDS)) {
    const key = word.toLowerCase();
    if (others.has(key)) return undefined;
    if (memberNames.has(key)) return key;
  }
  return undefined;
}

/** A clause's own tokens plus any caller-supplied neighbour/expansion words (vocabularyStemNeighbours / jaBridgeExpansionTokens), all lowercased -- the ONE token-set builder every coverage/self-coverage check below shares. */
export function clauseCoverageTokenSet(
  clauseText: string,
  tokenize: (text: string) => readonly string[],
  extraWords: readonly string[] = [],
): Set<string> {
  return new Set([...tokenize(clauseText), ...extraWords].map((token) => token.toLowerCase()));
}

/** Count of a clause's (possibly neighbour-extended) tokens literally present in one candidate's own path/symbol tokens -- built on the SAME candidateTokenSet every other check in this module uses; never a second scorer. */
export function distinctMatchedTokenCount<T extends DiversifyCandidate>(
  clauseTokens: ReadonlySet<string>,
  candidate: T,
  tokenize: (text: string) => readonly string[],
): number {
  const candidateTokens = candidateTokenSet(candidate, tokenize);
  let count = 0;
  for (const token of clauseTokens) if (candidateTokens.has(token)) count += 1;
  return count;
}

/** Minimum distinct token matches a RETRY's symbol-less pick must clear ("the self-coverage guard is what protects precision there"). */
export const MIN_RETRY_DISTINCT_MATCHES = 2;
/** Total added neighbour/expansion words one clause's retry may use, across all of its own tokens combined. */
export const MAX_CLAUSE_NEIGHBOUR_WORDS = 4;
/** Hard cap on real locate calls (first attempts + retries) one pack's per-clause recovery may issue. */
export const MAX_TOTAL_CLAUSE_LOCATE_CALLS = 5;
/** A first attempt slower than this skips its own retry (cost guard for a large/slow workspace, e.g. a self-referential locate over a large codebase). */
export const CLAUSE_LOCATE_SLOW_MS = 800;
/** Cumulative wall-clock across the WHOLE per-clause pass (first attempts + retries combined): once crossed, no further NEW clause is started (a clause already in flight always finishes). Corpus-adaptive rather than a fixed call count -- a fast corpus still gets all MAX_CLAUSE_LOCATES clauses; a slow one (a large/self-referential codebase, where a single locate call can itself take over a second) tapers off before the mechanism's own cost dominates the pack. */
export const CUMULATIVE_LOCATE_BUDGET_MS = 1000;

function clauseMentionsAny(
  clauseText: string,
  tokenize: (text: string) => readonly string[],
  words: readonly string[],
): boolean {
  const tokens = new Set(tokenize(clauseText).map((token) => token.toLowerCase()));
  return words.some((word) => tokens.has(word));
}

export function collectNeighbourWords(
  baseTokens: ReadonlySet<string>,
  stemNeighbours: (token: string) => readonly string[],
): string[] {
  const out: string[] = [];
  for (const token of baseTokens) {
    if (out.length >= MAX_CLAUSE_NEIGHBOUR_WORDS) break;
    for (const neighbour of stemNeighbours(token)) {
      if (out.length >= MAX_CLAUSE_NEIGHBOUR_WORDS) break;
      const lower = neighbour.toLowerCase();
      if (!out.includes(lower)) out.push(lower);
    }
  }
  return out;
}

/**
 * Phase 2 (Agent D) fix: picks the first RANKED candidate that BOTH
 * qualifies under the symbol policy (resolved `.symbol`, or -- when
 * `allowSymbolLessIfStronglyCovered` is given -- a symbol-less candidate
 * that predicate accepts) AND passes `isCovered` itself. Folding the
 * coverage check INTO the search (rather than picking once by symbol
 * policy alone and only checking coverage afterward, as
 * pickClauseLocateCandidate does) matters because a locator's TOP-ranked
 * abstain candidate is ranked by lexical confidence, not relevance -- a
 * wrong-directory candidate can carry a resolved `.symbol` and outrank the
 * real answer (measured: "authentication" pulled in a `UserProfile`
 * symbol from src/user/ at confidence 0.625, ranked ABOVE the real
 * `authenticateUser` in src/auth/ at confidence 0.025). Stopping at the
 * first symbol-bearing candidate regardless of relevance would silently
 * accept the wrong file; this keeps searching past it instead.
 */
export function pickCoveredClauseLocateCandidate<C extends { path: string; confidence: number }>(
  result: { hit: boolean; primary?: readonly C[]; candidateDetails?: readonly C[] },
  rankAbstain: (candidates: readonly C[]) => readonly C[],
  isImplementation: (candidate: C) => boolean,
  hasSymbol: (candidate: C) => boolean,
  isCovered: (candidate: C) => boolean,
  allowSymbolLessIfStronglyCovered?: (candidate: C) => boolean,
): C | undefined {
  if (result.hit) {
    const primary = result.primary?.[0];
    return primary !== undefined && isCovered(primary) ? primary : undefined;
  }
  for (const candidate of rankAbstain(result.candidateDetails ?? [])) {
    if (!isImplementation(candidate)) continue;
    if (hasSymbol(candidate)) {
      if (isCovered(candidate)) return candidate;
      continue;
    }
    if (allowSymbolLessIfStronglyCovered?.(candidate)) return candidate;
  }
  return undefined;
}

export interface ClauseRecoveryLocateResult<C> {
  readonly hit: boolean;
  readonly primary?: readonly C[];
  readonly candidateDetails?: readonly C[];
}

/** Every real-world function the pure orchestration below needs, injected -- see the module doc's PURE / INJECTED I/O ONLY policy. `now` is injected too so the slow-first-attempt cost guard is deterministically testable. */
/** First-attempt locate cap (matches the Phase 4 mechanism's own proven-safe value). */
export const FIRST_ATTEMPT_LOCATE_LIMIT = 3;
/** Retry locate cap: a retry's whole point is a WIDER net (neighbour-expanded query), so it needs more candidate slots than the first attempt to surface a rescue that a narrower cap would crowd out with closer-but-wrong lexical matches; retries are also rarer (only on first-attempt failure), so the marginal cost is bounded. */
export const RETRY_LOCATE_LIMIT = 5;

export interface ClauseLocateRecoveryDeps<C extends { path: string; confidence: number }> {
  readonly tokenize: (text: string) => readonly string[];
  readonly locate: (queryText: string, limit: number) => Promise<ClauseRecoveryLocateResult<C>>;
  readonly rankAbstain: (candidates: readonly C[]) => readonly C[];
  readonly isImplementation: (candidate: C) => boolean;
  readonly hasSymbol: (candidate: C) => boolean;
  readonly isTestPath: (candidate: C) => boolean;
  readonly isDocPath: (candidate: C) => boolean;
  readonly containsJapanese: (text: string) => boolean;
  readonly stemNeighbours: (token: string) => readonly string[];
  readonly jaExpansionTokens: (clauseText: string) => readonly string[];
  readonly jaRecoveryQuery: (clauseText: string) => string | undefined;
  readonly now: () => number;
  readonly onLocateAttempt?: () => void;
}

export interface ClauseLocateRecoveryPick<C> {
  readonly clauseId: string;
  readonly candidate: C;
}

export interface ClauseLocateRecoveryOutcome<C> {
  readonly picks: ClauseLocateRecoveryPick<C>[];
  readonly locateCallsUsed: number;
  readonly uncoveredCount: number;
}

/**
 * The window a clause's coverage is judged against. A plain array is ONE
 * window shared by every clause -- what every caller passed before, and what a
 * request whose clauses all have the same scope still passes.
 *
 * A FUNCTION lets a caller narrow the window PER CLAUSE. The case it exists
 * for: a purpose the caller wrote ON a directory means "look IN HERE for
 * this", so a file somewhere else cannot discharge it, while the clauses taken
 * from the request's own query are scope-free and keep the whole window. The
 * selector is read once per clause during the uncovered filter and never
 * again, so it may close over state the caller builds alongside the clauses.
 */
export type ClauseCoverageWindow =
  | readonly DiversifyCandidate[]
  | ((clause: ClauseHygieneItem) => readonly DiversifyCandidate[]);

/**
 * Orchestrates the whole per-clause recovery pass over an ALREADY
 * hygiene-processed clause list (hygienicClauseWorkList): filters to the
 * clauses the current selection window does not already cover (extended
 * with jaBridgeExpansionTokens for a Japanese clause, so the window check
 * itself benefits from the bridge, not only the retry), takes at most
 * MAX_CLAUSE_LOCATES of them, and for each: locates on the clause's own
 * text (strict pick policy -- resolved `.symbol` required on abstain); if
 * that yields no self-covered pick and the first attempt was not already
 * slow, retries ONCE with a language-appropriate augmented query (English:
 * clause text + up to MAX_CLAUSE_NEIGHBOUR_WORDS vocabularyStemNeighbours;
 * Japanese: jaBridgeRecoveryQuery) under a relaxed pick policy that also
 * accepts a symbol-less candidate meeting MIN_RETRY_DISTINCT_MATCHES
 * against the neighbour-extended tokens. Never issues more than
 * MAX_TOTAL_CLAUSE_LOCATE_CALLS real locate calls in total.
 */
export async function runClauseLocateRecovery<C extends { path: string; confidence: number; symbol?: string }>(
  hygienicClauses: readonly ClauseHygieneItem[],
  coverageWindow: ClauseCoverageWindow,
  deps: ClauseLocateRecoveryDeps<C>,
): Promise<ClauseLocateRecoveryOutcome<C>> {
  const clauseTokenSets = hygienicClauses.map((clause) => {
    const jaExtras = deps.containsJapanese(clause.text) ? deps.jaExpansionTokens(clause.text) : [];
    return clauseCoverageTokenSet(clause.text, deps.tokenize, jaExtras);
  });
  // One shared window (an array) behaves exactly as it always has: the
  // selector below returns the same array for every clause.
  const windowForClause: (clause: ClauseHygieneItem) => readonly DiversifyCandidate[] =
    typeof coverageWindow === "function" ? coverageWindow : () => coverageWindow;
  const uncovered = hygienicClauses.filter((clause, index) => {
    const window = windowForClause(clause);
    return !clauseNamesWindowFile(clause.text, window)
      && !isClauseCoveredByTokens(
        distinctiveClauseTokens(clauseTokenSets, index),
        window,
        deps.tokenize,
      );
  });

  const picks: ClauseLocateRecoveryPick<C>[] = [];
  let locateCallsUsed = 0;
  let cumulativeElapsedMs = 0;

  for (const clause of uncovered.slice(0, MAX_CLAUSE_LOCATES)) {
    if (locateCallsUsed >= MAX_TOTAL_CLAUSE_LOCATE_CALLS) break;
    if (cumulativeElapsedMs >= CUMULATIVE_LOCATE_BUDGET_MS) break;

    const isJapanese = deps.containsJapanese(clause.text);
    const baseTokens = clauseCoverageTokenSet(clause.text, deps.tokenize);
    const neighbourWords = isJapanese
      ? deps.jaExpansionTokens(clause.text).map((w) => w.toLowerCase())
      : collectNeighbourWords(baseTokens, deps.stemNeighbours);
    const extendedTokens = new Set([...baseTokens, ...neighbourWords]);

    deps.onLocateAttempt?.();
    locateCallsUsed += 1;
    const startedAt = deps.now();
    // eslint-disable-next-line no-await-in-loop -- at most MAX_TOTAL_CLAUSE_LOCATE_CALLS (5) sequential locates; each clause's own retry depends on whether its first attempt already found a pick.
    const first = await deps.locate(clause.text, FIRST_ATTEMPT_LOCATE_LIMIT);
    const firstAttemptMs = deps.now() - startedAt;
    cumulativeElapsedMs += firstAttemptMs;
    let picked = pickCoveredClauseLocateCandidate(
      first,
      deps.rankAbstain,
      deps.isImplementation,
      deps.hasSymbol,
      (candidate) => isClauseCoveredByTokens(baseTokens, [candidate], deps.tokenize),
    );

    const canRetry = picked === undefined
      && locateCallsUsed < MAX_TOTAL_CLAUSE_LOCATE_CALLS
      && firstAttemptMs <= CLAUSE_LOCATE_SLOW_MS
      && cumulativeElapsedMs < CUMULATIVE_LOCATE_BUDGET_MS
      && (isJapanese ? deps.jaRecoveryQuery(clause.text) !== undefined : neighbourWords.length > 0);
    if (canRetry) {
      const retryQuery = isJapanese ? deps.jaRecoveryQuery(clause.text)! : [clause.text, ...neighbourWords].join(" ");
      deps.onLocateAttempt?.();
      locateCallsUsed += 1;
      const retryStartedAt = deps.now();
      // eslint-disable-next-line no-await-in-loop -- this IS the retry of the SAME clause; it must run after the first attempt's own result is known.
      const retried = await deps.locate(retryQuery, RETRY_LOCATE_LIMIT);
      cumulativeElapsedMs += deps.now() - retryStartedAt;
      picked = pickCoveredClauseLocateCandidate(
        retried,
        deps.rankAbstain,
        deps.isImplementation,
        deps.hasSymbol,
        (candidate) => isClauseCoveredByTokens(extendedTokens, [candidate], deps.tokenize),
        (candidate) => distinctMatchedTokenCount(extendedTokens, candidate, deps.tokenize) >= MIN_RETRY_DISTINCT_MATCHES,
      );
    }

    if (picked === undefined) continue;
    if (deps.isTestPath(picked) && !clauseMentionsAny(clause.text, deps.tokenize, ["test", "tests", "spec", "specs"])) continue;
    if (deps.isDocPath(picked) && !clauseMentionsAny(clause.text, deps.tokenize, ["doc", "docs", "documentation"])) continue;

    picks.push({ clauseId: clause.id, candidate: picked });
  }

  return { picks, locateCallsUsed, uncoveredCount: uncovered.length };
}
