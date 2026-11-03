// roleAndConcernScope — extracted implementation; imports point to the owning modules.
import * as path from "path";
import type { AnchorIO } from "../anchorFirst.js";
import type { AnchorResolution } from "../anchorFirst.js";
import type { ConcernGroup } from "./roleAndConcernScope2.js";
import type { ImpactCandidate } from "@tokenlighten/types";
import type { TaskPackArgs } from "../model.js";
import type { TaskPackResult } from "../model.js";
import type { TaskPackSurface } from "../model.js";
import { CONCERN_NOISE_WORDS } from "./roleAndConcernScope2.js";
import { CONCERN_STOP_WORDS } from "./roleAndConcernScope2.js";
import { FileReadCache } from "./packBasics2.js";
import { WEAK_CONCERN_TOKENS } from "./roleAndConcernScope2.js";
import { classifySurface } from "../../../util/impact.js";
import { concreteIdentifierTokens } from "./createAndWiringEndpoints2.js";
import { definedCallableNames } from "./wiringEvidence3.js";
import { hasServedCode } from "./wiringEvidence2.js";
import { isConcernAnchorable } from "./roleAndConcernScope2.js";
import { isDeclarationShapedMatchText } from "./callableResolution4.js";
import { literalFirstDestinationNorms } from "./literalAndConcernSeeds.js";
import { maskReadLeadSpan } from "../requestItems.js";
import { normIdent } from "./createAndWiringEndpoints2.js";
import { orderedUniqueTokens } from "./roleAndConcernScope2.js";
import { packageMemberPairs } from "../../../util/memberReferences.js";
import { parsePackLineRange } from "./packState2.js";
import { readCached } from "./packBasics2.js";
import { rememberAnchorResolution } from "../anchorFirst.js";
import { requestAnchorsOf } from "../anchorFirst.js";
import { resolveAnchorDefinitions } from "../anchorFirst.js";
import { resolveAnchorLiterals } from "../anchorFirst.js";
import { servedSurfaceText } from "./changeAndReadinessEvidence2.js";
import { significantQueryTokens } from "./roleAndConcernScope2.js";
import { splitConcernClauses } from "./roleAndConcernScope2.js";
import { stripPathSpans } from "../../../util/queryShape.js";
import { subjectLiteralsIfEnabled } from "../anchorFlag.js";
import { tokenizeQuery } from "../../../util/queryShape.js";

export function concernAnchorTokens(text: string, limit = 6): string[] {
  // W9: strip generic path spans ONCE, up front — concreteIdentifierTokens
  // and significantQueryTokens already strip internally (for their OTHER
  // direct callers), so this is belt-and-suspenders for them, but it is the
  // ONLY scrub the inline compactCodeTerms extraction below gets.
  const cleaned = stripPathSpans("", text);
  const compounds = [...cleaned.matchAll(/[A-Za-z0-9]+(?:[-.][A-Za-z0-9]+)+/g)]
    .map((match) => match[0]!.toLowerCase())
    // Natural-language distributives such as "per-priority" are prose, not
    // identifier atoms: retain the meaningful component (priority) so a
    // propagation facet can still bind repository symbols such as byPriority.
    .filter((token) => !token.startsWith("per-"));
  const compoundParts = new Set(compounds.flatMap((token) => token.split(/[-.]/)));
  const concrete = concreteIdentifierTokens(cleaned).filter((token) => !compoundParts.has(token.toLowerCase()));
  const simple = significantQueryTokens(cleaned).filter((token) => !CONCERN_NOISE_WORDS.has(token) && !compoundParts.has(token.toLowerCase()));
  const compactCodeTerms = tokenizeQuery(cleaned, {
    minLen: 3,
    stopWords: CONCERN_STOP_WORDS,
    mode: "simple",
  }).filter((token) => /^[a-z0-9]{3}$/i.test(token) && !CONCERN_NOISE_WORDS.has(token));
  // Query-derived only. Repository vocabulary grounding happens after the
  // walk/symbol evidence is available; production code carries no benchmark-
  // or domain-specific translation table here.
  const destinationNorms = literalFirstDestinationNorms(text);
  return orderedUniqueTokens([...compounds, ...concrete, ...simple, ...compactCodeTerms])
    .filter(isConcernAnchorable)
    .filter((token) => !destinationNorms.has(normIdent(token)))
    .slice(0, limit);
}

export function concernGroupsForQuery(query: string): ConcernGroup[] {
  const clauses = splitConcernClauses(query);
  const groups = clauses
    // R-B3 (2026-09-21, orchestrator ruling 6): a clause's generalised read
    // lead ("Walk me through", "Trace", "I want to understand") is not a
    // concern anchor — anchors become `unmatchedConcernTokens` and from there
    // Rule 5's bare `find` (confirmed live: `find "walk"` when the first pack
    // served nothing). Masked by `headIsWhAfterReadLead`'s own rule; the
    // group's `query` stays the clause as written.
    .map((clause) => ({ query: clause, tokens: concernAnchorTokens(maskReadLeadSpan(clause)) }))
    .filter((group) => group.tokens.length > 0);
  return groups.length >= 2 ? groups : [];
}

export function propagationFacetGroups(query: string): ConcernGroup[] {
  const listed = concernGroupsForQuery(query);
  const supplemental = query
    .replace(/\r/g, "\n")
    .split(/[。；;\n]+/)
    .map((clause) => clause.replace(/^\s*(?:[-*]|\d+[.)]|[①②③④⑤⑥⑦⑧⑨⑩])\s*/, "").trim())
    .filter((clause) => clause.length >= 8)
    .filter((clause) =>
      /\b(?:backend|frontend|shared|validation|validate|validator|schema|stats?|statistics|aggregate|aggregation|counts?|summary)\b/i.test(clause)
      || /バックエンド|フロントエンド|共有|バリデーション|検証|統計|集計|件数/.test(clause)
    )
    .map((clause) => ({ query: clause, tokens: concernAnchorTokens(clause) }))
    .filter((group) => group.tokens.length > 0);
  const seen = new Set<string>();
  return [...listed, ...supplemental].filter((group) => {
    const key = group.tokens.join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 6);
}

/**
 * True when `token` appears case-insensitively as a substring of ONE
 * surface's `path` or `symbol` — deliberately NOT the embedded `code`
 * (matching code would be far too loose: nearly every token in an English
 * bug-fix query appears somewhere in nearly any plausible code file, which
 * would defeat the purpose of this check entirely). Factored out of
 * concernTokenMatchesSurfaces (2026-07-11c) so a single-surface caller
 * (surfaceGroundedInQuery, below) reuses the EXACT same match rule instead
 * of a second, potentially-diverging notion of "matches".
 */
export function concernTokenMatchesSurface(token: string, s: TaskPackSurface): boolean {
  if (concernTokenMatchesSurfaceIdentity(token, s)) return true;
  // R0 (2026-08-21, W4-A): this function is documented "case-insensitively"
  // (see its doc comment above) — lowercase ONCE, here, so every caller gets
  // that contract regardless of whether IT remembered to lowercase first.
  // Before this fix, `body.includes(token)` compared an already-lowercased
  // `body` against a possibly-mixed-case `token` (e.g. a case-preserved
  // camelCase identifier, now that orderedUniqueTokens no longer scrubs
  // case out of concernAnchorTokens' output) and silently never matched.
  const lowerToken = token.toLowerCase();
  const normalizedToken = normIdent(token);
  // p11c (2026-09-13): read via `servedSurfaceText`, not `s.code`/
  // `s.code_unchanged` concatenated raw. Once TL142-03's taskBinding-aware
  // `applyPackDedupe` legitimately demotes a REQUIRED surface to
  // `code_unchanged` on a proven-same-task repeat (previously impossible —
  // the pre-TL142-03 guard protected every required surface from demotion
  // unconditionally), `s.code_unchanged` is a short pointer string like
  // "<handle> — see prior pack", never the original body. Matching a query
  // concern token against that pointer text made a token this task had
  // ALREADY served (just compacted) look "unmatched", so
  // `unmatchedConcernTokens`/Rule 5 (alternativeProgressAxis) proposed a
  // redundant `tl_search_files find <token>` re-ask for content already in the
  // pack's own evidence — observed live: p11c's forced-fresh-build bare qref
  // re-pack needed 3 repacks instead of <=2, the extra round finding nothing
  // new (the search's own response even disclosed `served_this_session:
  // true`) and leaving coverage no better (an additional, still-unresolved
  // "api" role). `servedSurfaceText` already recovers the real pre-demotion
  // body from `dedupedSurfaceBody` for exactly this situation (see its own
  // doc comment) and is what server-side readiness/proof checks use
  // elsewhere; `concernTokenMatchesSurface` was the one reader still doing
  // its own raw concatenation.
  const body = servedSurfaceText(s).toLowerCase();
  if (body.includes(lowerToken) || normIdent(body).includes(normalizedToken)) return true;
  return qualifiedMemberDeclaredBy(lowerToken, s);
}

/**
 * `meter.Sum`, which `concernAnchorTokens` keeps whole as the compound
 * `meter.sum`: only a CALLER spells the qualifier, so the member's own
 * declaration covers it when the surface sits under that package or module —
 * its directory or file stem is `owner`, or its Go `package` clause says so
 * (locateTaskContext.ts Layer 1c's `declaredUnderPackageOwner`). Without this
 * the located `func Sum` window left the concern open and the pack asked for
 * a find of "meter" and "sum" (gauge fixture, 2026-10-17).
 */
export function qualifiedMemberDeclaredBy(lowerToken: string, s: TaskPackSurface): boolean {
  const qualified = /^([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)$/.exec(lowerToken);
  if (qualified === null) return false;
  const [, owner, member] = qualified as unknown as [string, string, string];
  const text = servedSurfaceText(s);
  if (!pathUnderPackageOwner(s.path, owner, text)) return false;
  const symbolTail = s.symbol?.split(/::|\.|#/).at(-1);
  return (symbolTail !== undefined && normIdent(symbolTail) === member)
    || definedCallableNames(text).some((name) => normIdent(name) === member);
}

/**
 * `relPath` belongs to the package or module `owner` (lowercase): its
 * directory or file stem is `owner`, or `text` (any served or whole-file
 * text of it) carries the Go clause `package owner`.
 */
export function pathUnderPackageOwner(relPath: string, owner: string, text: string): boolean {
  const segments = relPath.replace(/\\/g, "/").toLowerCase().split("/");
  const stem = segments[segments.length - 1]!.replace(/\.[^.]+$/, "");
  return segments[segments.length - 2] === owner
    || stem === owner
    || new RegExp(`^package\\s+${owner}\\b`, "m").test(text);
}

/**
 * Members the request names ONLY through a package qualifier (`meter.Sum`
 * and never a bare `Sum`), lowercased, each with the owners qualifying it.
 */
export function packageQualifiedOnlyMembers(query: string): Map<string, string[]> {
  const owners = new Map<string, string[]>();
  for (const { owner, member } of packageMemberPairs(query)) {
    owners.set(member, [...(owners.get(member) ?? []), owner]);
  }
  const out = new Map<string, string[]>();
  for (const [member, memberOwners] of owners) {
    const bare = query.match(new RegExp(`(?<![A-Za-z0-9_$])${member}(?![A-Za-z0-9_$])`, "g"))?.length ?? 0;
    const qualified = memberOwners.reduce((count, owner) =>
      count + (query.match(new RegExp(`(?<![A-Za-z0-9_$.])${owner}\\.${member}(?![A-Za-z0-9_$])`, "g"))?.length ?? 0), 0);
    if (bare > 0 && bare === qualified) out.set(member.toLowerCase(), memberOwners.map((owner) => owner.toLowerCase()));
  }
  return out;
}

/**
 * A whole-identifier hit on `identifier` (lowercased) in `relPath`'s
 * lowercased text counts for the request, unless the request qualified that
 * member by package (`packageQualifiedOnlyMembers`): then only a file of that
 * package, or one spelling the qualified name (a caller), is about it.
 */
export function identifierHitMeansRequestedMember(
  identifier: string,
  relPath: string,
  lowerText: string,
  qualifiedOnly: ReadonlyMap<string, readonly string[]>,
): boolean {
  const owners = qualifiedOnly.get(identifier);
  if (owners === undefined) return true;
  return owners.some((owner) => pathUnderPackageOwner(relPath, owner, lowerText) || lowerText.includes(`${owner}.${identifier}`));
}

export function concernTokenMatchesSurfaceIdentity(token: string, s: TaskPackSurface): boolean {
  // R0 (2026-08-21, W4-A): same case-insensitivity fix as
  // concernTokenMatchesSurface, for the same reason — see its comment.
  const lowerToken = token.toLowerCase();
  const normalizedToken = normIdent(token);
  const lowerSymbol = s.symbol?.toLowerCase();
  const normalizedBase = normIdent(path.basename(s.path).replace(/\.[^.]+$/, ""));
  const normalizedSymbol = s.symbol !== undefined ? normIdent(s.symbol) : undefined;
  return s.path.toLowerCase().includes(lowerToken) ||
    (lowerSymbol !== undefined && lowerSymbol.includes(lowerToken)) ||
    normalizedBase.includes(normalizedToken) ||
    (normalizedSymbol !== undefined && normalizedSymbol.includes(normalizedToken));
}

/**
 * True when `token` appears case-insensitively as a substring of ANY
 * surface's `path` or `symbol` — see concernTokenMatchesSurface.
 */
export function concernTokenMatchesSurfaces(token: string, surfaces: TaskPackSurface[]): boolean {
  return surfaces.some((s) => concernTokenMatchesSurface(token, s));
}

export function concernGroupMatchesSurfaces(group: ConcernGroup, surfaces: TaskPackSurface[]): boolean {
  // Same rule as `isConcernAnchorable`, applied to this gate's own reader of
  // `concreteIdentifierTokens` (2026-08-27). This clause is a VETO: "the clause
  // named concrete identifiers and none of them are here, so it is uncovered".
  // A CJK prose token must not be able to cast that veto for the reason the
  // helper's doc gives — it was never an identifier claim. It can still SATISFY
  // the gate if some other, ASCII identifier in the clause matches.
  const identifiers = concreteIdentifierTokens(group.query).filter(isConcernAnchorable);
  if (identifiers.length > 0 &&
      !identifiers.some((t) => concernTokenMatchesSurfaces(t.toLowerCase(), surfaces))) {
    return false;
  }
  const matched = group.tokens.filter((t) => concernTokenMatchesSurfaces(t, surfaces));
  // R0 (2026-08-21, W4-A): case-insensitive compare — see orderedUniqueTokens.
  return matched.some((t) => !WEAK_CONCERN_TOKENS.has(t.toLowerCase())) || matched.length >= 2;
}

/**
 * The pool of concern-anchor tokens used to test whether a SINGLE surface
 * relates to `query` at all (surfaceGroundedInQuery, below). Mirrors
 * unmatchedConcernTokens's own token-pool choice: the union of every concern
 * clause's tokens when the query splits into >=2 clauses (so a LATER
 * clause's tokens — e.g. "failsafe" in a 3-symptom query — are not silently
 * dropped by the flat extractor's own token-count cap), else the single flat
 * concernAnchorTokens list.
 */
export function concernTokenPool(query: string): string[] {
  const groups = concernGroupsForQuery(query);
  if (groups.length >= 2) return orderedUniqueTokens(groups.flatMap((g) => g.tokens));
  return concernAnchorTokens(query, 8);
}

/**
 * Strips a leading `<prefix>/` segment from `relPath` for each `prefix` in
 * `scopePrefixes`, stopping at the first match. A no-op (returns `relPath`
 * unchanged) when nothing matches or no prefixes are supplied.
 */
export function stripConfinementPrefix(relPath: string, scopePrefixes: readonly string[]): string {
  for (const prefix of scopePrefixes) {
    if (prefix.length === 0) continue;
    if (relPath.startsWith(`${prefix}/`)) return relPath.slice(prefix.length + 1);
  }
  return relPath;
}

/**
 * 2026-07-11c: true when `surface` is grounded in `query` — at least one of
 * the query's concern-anchor tokens matches this ONE surface's path/symbol
 * (concernTokenMatchesSurface; deliberately not the embedded `code`, same
 * rationale as that function). Used to tighten buildSeededTaskPack's
 * pure-dir "has an implementation body" check: an implementation-role file
 * that shares NOTHING with the query (run 2026-07-11c's irrelevant
 * platform/generic/startup.c, pulled in only because it happened to be a
 * >3-line non-header "config"-role file under the supplied directory) must
 * not be allowed to legitimize a "complete" pack on its own.
 *
 * `scopePrefixes` (typically the pureDirScope surface set's OWN deepest
 * common ancestor directory — see the call site) are stripped from
 * `surface.path` BEFORE matching. Without this, a pureDirScope pack's own
 * shared directory tree trivially "grounds" every surface under it: the
 * 2026-07-11c evidence query literally opens with the project's own name
 * and top directory word, and every surface returned for that dir-scoped
 * pack shares not just the project segment but a deeper shared prefix
 * too — defeating the whole check for exactly the query shape this exists to
 * catch. The surface's basename/symbol are unaffected (a shared ancestor
 * directory never appears in either), so this only changes the full-path
 * substring test.
 */
export function surfaceGroundedInQuery(
  surface: TaskPackSurface,
  query: string,
  scopePrefixes: readonly string[] = [],
): boolean {
  const scoped = scopePrefixes.length === 0
    ? surface
    : { ...surface, path: stripConfinementPrefix(surface.path, scopePrefixes) };
  return concernTokenPool(query).some((t) => concernTokenMatchesSurfaceIdentity(t, scoped));
}

// ---------------------------------------------------------------------------
// FIX-A (2026-07-09d forensics, MODE-A "concerns-uncovered" false positives):
// only an IDENTIFIER-SHAPED query token — or one that matches an identifier
// the locator already found for this task — may gate coverage to "partial"
// via unmatchedConcernTokens. Forensics on 12 task_pack responses found 7/12
// demoted to partial purely because a salient English NOUN pulled from the
// agent's free-text query ("class", "lifecycle", "telemetry", "sensor",
// "pricing", "premium", "machine", "transition"...) had no surface literally
// named after it — not because anything was actually missing; agents
// correctly learned to ignore the resulting `tl_search_files find "<noun>"`
// suggestions (6/7 follow-ups were skipped). A free-text noun may still help
// FIND a surface — concernGroupsForQuery/augmentConcernGroupSurfaces keep
// using the full (shape-agnostic) token pool for that search — it just may
// no longer BLOCK coverage on its own.
// ---------------------------------------------------------------------------

/**
 * Raw dotted (`a.b.c`), scoped (`a::b`), or path-like (`a/b/c`) identifier
 * references straight out of the ORIGINAL (un-lowercased, unsplit) query
 * text. tokenizeQuery's separators treat `.`/`::`/`/` as token boundaries, so
 * by the time a token reaches significantQueryTokens/concreteIdentifierTokens
 * this shape is already destroyed — this scans the untouched text instead, so
 * a query like "config.pricing.rate is wrong" or "wire up @scope/pkg" still
 * recognizes its dotted/scoped reference as identifier-shaped.
 *
 * W9 (2026-08-22): a GENUINE filesystem path span (an absolute path, or any
 * bare multi-segment run of >=3 segments — see stripPathSpans) is stripped
 * first, so a many-segment path mentioned in prose is not itself scooped up
 * as one giant "path-like identifier reference". A short reference like
 * "@scope/pkg" (one separator) is unaffected — stripPathSpans only removes
 * anchored or >=3-segment spans, exactly the ones this function was never
 * trying to catch.
 */
export function dottedOrScopedIdentifiersIn(text: string): string[] {
  const cleaned = stripPathSpans("", text);
  const re = /[A-Za-z_$][\w$]*(?:(?:\.[A-Za-z_$][\w$]*)+|(?:::[A-Za-z_$][\w$]*)+|(?:\/[A-Za-z_$][\w$.-]*)+)/g;
  return cleaned.match(re) ?? [];
}

/**
 * Lowercased set of tokens from `text` that are IDENTIFIER-SHAPED: CamelCase
 * (an interior case transition), snake_case, an ALL-CAPS run (>=3 chars — the
 * same shape concreteIdentifierTokens already keys on), or a dotted/scoped/
 * path-like reference. `knownIdentifiers` (already-lowercased) is an OPTIONAL
 * extra allowance: a token matching an identifier the locator ALREADY found
 * for this task (e.g. a symbol/basename among the pre-trim candidate pool)
 * counts too, even when the query spelled it as a plain lowercase word — it
 * is provably a real repo identifier, not a guessed noun. Shape is read from
 * the case-preserving extractors (concreteIdentifierTokens, the
 * dotted/scoped scan) since the plain significant-token pipeline
 * (significantQueryTokens) lowercases up front and cannot answer this on its
 * own.
 */
export function identifierShapedConcernSet(text: string, knownIdentifiers?: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const t of concreteIdentifierTokens(text)) out.add(t.toLowerCase());
  for (const t of dottedOrScopedIdentifiersIn(text)) out.add(t.toLowerCase());
  if (knownIdentifiers) for (const t of knownIdentifiers) out.add(t);
  return out;
}

/**
 * Significant query tokens with NO match in any returned surface's path or
 * symbol, FURTHER restricted (FIX-A) to tokens that are identifier-shaped or
 * match a known repo identifier — see identifierShapedConcernSet. Non-empty
 * means the returned surfaces plausibly do not address everything the query
 * asked for — the honest signal to flip the route to locate_missing_surfaces
 * (as opposed to coverage:partial alone, which fires on 22/22 packs merely
 * from the surface budget and would blanket-flip every pack, wasting locate
 * turns on tasks that were already fine handle-first).
 *
 * `knownIdentifiers` is optional and threaded only where a broader identifier
 * pool is cheaply available (the main locate flow's pre-trim candidate set);
 * every other caller omits it, which is still strictly SAFER than the
 * pre-FIX-A behavior (a subset of tokens can now gate, never a superset).
 */
export function unmatchedConcernTokens(
  query: string,
  surfaces: TaskPackSurface[],
  knownIdentifiers?: ReadonlySet<string>,
): string[] {
  // R0 (2026-08-21, W4-A): `shaped` (identifierShapedConcernSet) stores
  // LOWERCASE keys; `group.tokens`/concernAnchorTokens may now carry a
  // case-preserved identifier (orderedUniqueTokens no longer scrubs case).
  // Both `shaped.has(t)` calls below must look up the lowercase form — else
  // a properly-cased, genuinely identifier-shaped token (e.g. the camelCase
  // symbol a query names) fails this filter purely on a case mismatch and
  // silently drops out of the uncovered-concern report instead of either
  // being correctly reported (when truly unmatched) or correctly matched out
  // (via concernTokenMatchesSurfaces, itself now case-insensitive).
  const shaped = identifierShapedConcernSet(query, knownIdentifiers);
  const groups = concernGroupsForQuery(query);
  if (groups.length >= 2) {
    return groups
      .filter((group) => !concernGroupMatchesSurfaces(group, surfaces))
      // FIX-A: the representative token for an unmatched clause must itself
      // be identifier-shaped — a clause whose only unmatched wording is
      // free-text prose (no concrete identifier in it at all) contributes
      // NOTHING here, rather than falling back to reporting its first token
      // (the pre-FIX-A behavior) purely because the clause as a whole did
      // not "match enough".
      .map((group) => group.tokens.find((t) => !concernTokenMatchesSurfaces(t, surfaces) && shaped.has(t.toLowerCase())))
      .filter((t): t is string => t !== undefined)
      .slice(0, 4);
  }
  // R-B3 (ruling 6): the single-clause path masks the lead span too.
  return concernAnchorTokens(maskReadLeadSpan(query), 8)
    .filter((t) => !WEAK_CONCERN_TOKENS.has(t.toLowerCase()) || !surfaces.some((s) => s.role !== "unknown"))
    .filter((t) => !concernTokenMatchesSurfaces(t, surfaces))
    .filter((t) => shaped.has(t.toLowerCase()))
    .slice(0, 4);
}

/**
 * Confidence-descending order for an abstain response's `candidateDetails`
 * (unlike a confident hit's `primary`/`related`, `candidateDetails` carries
 * no ranking guarantee). Tie-break prefers an implementation/source file
 * over a pure header/interface declaration — the same "definition over
 * declaration" preference the pureDirScope hasImplementationBody check
 * already applies elsewhere (header extensions excluded there too). This
 * matters specifically for a SCOPED locate call (2026-07-12d confinement):
 * narrowing the walked pool to `scope` can turn what was a confident
 * unscoped hit into a tied "ambiguous" abstain (fewer files to
 * differentiate a header from its own implementation on text-match alone),
 * and an untouched candidateDetails order can then hand back the
 * declaration instead of the definition the caller actually wants.
 */
export function rankAbstainCandidates<T extends { path: string; confidence: number }>(candidates: readonly T[]): T[] {
  return [...candidates].sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    const aHeader = /\.(h|hpp|hh|hxx)$/i.test(a.path) ? 1 : 0;
    const bHeader = /\.(h|hpp|hh|hxx)$/i.test(b.path) ? 1 : 0;
    return aHeader - bHeader;
  });
}

/**
 * A candidate the locator / ranking contributed (as opposed to one a closure,
 * caller, counterexample or recovery mechanism added, or widened in place, with
 * its own `why`): the only rows `buildAnswerTaskPack` turns into locations once
 * the request's anchors are served.
 */
export const LOCATION_ONLY_MIN_BODY_BYTES = 512;

export function isLocatorOriginWhy(why: string): boolean {
  return LOCATOR_ORIGIN_WHYS.has(why)
    || why.startsWith("answer-query-evidence")
    || why === "answer-semantic-symbol-focus";
}

export const LOCATOR_ORIGIN_WHYS: ReadonlySet<string> = new Set([
  "filename-match", "exact-text", "exact-text:distinctive", "variant-text", "reference", "family-stem",
  "path-token", "doc-contract-match", "presentation-family", "enum-family", "import-edge",
  "graph-reference", "graph-importer", "query-symbol",
]);

/** `why` of the candidate `buildAnswerTaskPack` mints for the declaration of an anchor the request names (anchorFirst.ts). */
export const REQUEST_ANCHOR_DEFINITION_WHY = "request-anchor-definition";

/** `why` of the candidate minted for an exact-text occurrence of a literal the request quotes or brackets. */
export const REQUEST_LITERAL_WHY = "request-literal";

/** The host side of anchorFirst.ts for this module: file reads and parses through the pack's own cache. */
export function packAnchorIO(workspace: string, cache: FileReadCache | undefined, scopePath?: string, query?: string): AnchorIO {
  return {
    workspace,
    ...(scopePath ? { scopePath } : {}),
    ...(query !== undefined ? { query } : {}),
    read: (relPath) => readCached(workspace, relPath, cache),
    ...(cache !== undefined
      ? { parsedSymbols: async (text: string, lang: string, relPath: string) => cache.parsedSymbols(text, lang, relPath) }
      : {}),
    isDeclarationShaped: (text, identifier) => isDeclarationShapedMatchText(text, identifier),
  };
}

/**
 * The anchors the request names, looked up in the workspace: the declaration
 * of each identifier / dotted member it defines and the exact occurrences of
 * each literal. Remembered per (workspace, query) for the readiness gate.
 */
export async function resolveRequestAnchorsForPack(
  args: TaskPackArgs,
  query: string,
  workspace: string,
  cache: FileReadCache,
): Promise<AnchorResolution> {
  const anchors = requestAnchorsOf(query);
  const subjectLiterals = subjectLiteralsIfEnabled(query);
  if (anchors.identifiers.length === 0 && subjectLiterals.length === 0) {
    return { definitions: [], literalHits: [], definedIds: [] };
  }
  const io = packAnchorIO(workspace, cache, args.path, query);
  const defined = anchors.identifiers.length > 0
    ? await resolveAnchorDefinitions(io, anchors.identifiers)
    : { definitions: [], literalHits: [], definedIds: [] };
  const literalHits = subjectLiterals.length > 0 ? await resolveAnchorLiterals(io, subjectLiterals) : [];
  const resolution: AnchorResolution = { ...defined, literalHits };
  rememberAnchorResolution(workspace, query, resolution);
  return resolution;
}

/** Where a request's named declaration lives (see `withNamedDeclarationLead`). */
export interface NamedDeclaration {
  readonly path: string;
  readonly startLine: number;
}

/** The named declaration's row (see `withNamedDeclarationLead`) leads the pack's evidence: a reorder, after everything else was decided. */
export function moveNamedDeclarationFirst(result: TaskPackResult, declaration: NamedDeclaration | undefined): void {
  if (declaration === undefined) return;
  const surfaces = result.surfaces as TaskPackSurface[] | undefined;
  if (surfaces === undefined) return;
  const at = surfaces.findIndex((surface) => {
    if (surface.path !== declaration.path || !hasServedCode(surface)) return false;
    const bounds = parsePackLineRange(surface.range);
    return bounds !== undefined && bounds[0] <= declaration.startLine && bounds[1] >= declaration.startLine;
  });
  if (at <= 0) return;
  const [lead] = surfaces.splice(at, 1);
  surfaces.unshift(lead!);
}

/** The candidates an anchor resolution mints: declarations first, then literal windows. */
export function requestAnchorCandidates(resolution: AnchorResolution): ImpactCandidate[] {
  const definitions: ImpactCandidate[] = resolution.definitions.map((definition) => ({
    path: definition.path,
    line: definition.startLine,
    range: `${definition.startLine}-${definition.endLine}`,
    symbol: definition.symbol,
    surface: classifySurface(definition.path),
    why: REQUEST_ANCHOR_DEFINITION_WHY,
    confidence: 0.99,
    required: true,
  }));
  const literals: ImpactCandidate[] = resolution.literalHits.map((hit) => ({
    path: hit.path,
    line: hit.line,
    range: `${hit.startLine}-${hit.endLine}`,
    ...(hit.symbol !== undefined ? { symbol: hit.symbol } : {}),
    surface: classifySurface(hit.path),
    why: REQUEST_LITERAL_WHY,
    confidence: 0.95,
    required: true,
  }));
  return [...definitions, ...literals];
}

export interface RankedAnswerEvidenceCandidate {
  candidate: ImpactCandidate;
  score: number;
  exactIdentifier: boolean;
  strongEvidence: boolean;
  /**
   * WP-I (eval-0929 §5/§8, adopted chip from WP-F): true when the query
   * named THIS candidate's own path explicitly (`queryNamedWorkspaceFiles`)
   * AND this candidate already carries `exactIdentifier` — i.e. the named
   * file itself declares the identifier the query asked about, not merely
   * some unrelated file the query happens to also mention. Set once, after
   * every candidate is ranked (see `rankAnswerEvidenceCandidates`'s own
   * final pass), and checked FIRST by the closing sort so a same-name
   * declaration in a file the question did NOT name can never outrank the
   * one it did, no matter how the two compare on ordinary lexical score.
   */
  explicitNamedPath?: boolean;
  /**
   * 2026-10-29 (first-hop field report): this entry is the DECLARATION of an
   * identifier or dotted member the request names (`res.redirect`), minted by
   * `buildAnswerTaskPack` from the workspace itself (anchorFirst.ts), never
   * re-focused by the ranking below. The closing sort puts it ahead of
   * everything, `explicitNamedPath` included.
   */
  anchorDefinition?: boolean;
  /** An exact-text occurrence of a literal the request quotes or brackets (`[default: (unlimited)]`). */
  anchorLiteral?: boolean;
  /** (anchor definitions only) the locator's own candidate for this file would have ranked as the named identifier too. */
  locatorAlsoExact?: boolean;
}
