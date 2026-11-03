// callableResolution — extracted implementation; imports point to the owning modules.
import * as path from "path";
import type { CollectedSymbol } from "../../../symbols/collectSymbols.js";
import type { DeclaredCallablesScan } from "./callableResolution2.js";
import type { FacetRequirement } from "../requestFacets.js";
import type { ImpactCandidate } from "@tokenlighten/types";
import type { NamedWindow } from "./callableResolution2.js";
import type { ParsedSymbols } from "./packBasics2.js";
import type { ResolvedFacetFocal } from "./callableResolution2.js";
import type { TaskPackArgs } from "../model.js";
import { CALLER_EXPANSION_CALLABLE_KINDS } from "./callerExpansion2.js";
import { FileReadCache } from "./packBasics2.js";
import { MAX_CALLER_FILES_EXAMINED } from "../callerExpansion.js";
import { MAX_IMPORT_RESOLVED_FILES_PER_FOCAL } from "../evidenceClosure.js";
import { MAX_REEXPORT_FILES_TOTAL } from "./callableResolution4.js";
import { MAX_REEXPORT_HOPS } from "./callableResolution4.js";
import { MAX_SAME_NAME_CANDIDATES } from "./callableResolution2.js";
import { MAX_SURFACES_DISTINCT } from "./packBasics2.js";
import { REQUEST_ANCHOR_DEFINITION_WHY } from "./roleAndConcernScope3.js";
import { VALUE_DECLARATION_KINDS } from "./callableResolution4.js";
import { bodyDeclaresLocal } from "./constantResolution3.js";
import { cachedFileLines } from "./constantResolution2.js";
import { calleePositionsIn } from "../evidenceClosure.js";
import { callerExpansionTypeNameFor } from "./callerExpansion2.js";
import { callerSitesForFocal } from "./focalFlow.js";
import { collectDeclaredCallablesNamedInFile } from "./callableResolution2.js";
import { contentHash } from "../../typed-symbols/index.js";
import { escapeRegExp } from "../../search/find/findText.js";
import { explicitFacetSelectionRange } from "./callableResolution4.js";
import { facetSubjectIdentifiersAbsent } from "./callableResolution4.js";
import { findModuleConstantWindow } from "../evidenceClosure.js";
import { focalParameterNames } from "../evidenceClosure.js";
import { hasHashComments } from "../callerExpansion.js";
import { importSpecifiersNaming } from "../evidenceClosure.js";
import { importedModuleAliasesIn } from "../evidenceClosure.js";
import { isDeclarationShapedMatchText } from "./callableResolution4.js";
import { isTestConcernPath } from "./literalAndConcernSeeds.js";
import { languageForPath } from "../../../util/languages.js";
import { maskNonCode } from "../callerExpansion.js";
import { normIdent } from "./createAndWiringEndpoints2.js";
import { normalizedRequestPath } from "./guideAndArtifactSurfaces.js";
import { qualifiedCalleePositionsIn } from "../evidenceClosure.js";
import { qualifiedSymbolOwner } from "./anchorFocus3.js";
import { queryNamedWorkspaceFiles } from "./queryIntent3.js";
import { readCached } from "./packBasics2.js";
import { resolveGoImports } from "../importResolveGo.js";
import { resolveImportSpecifierFile } from "./callableResolution4.js";
import { resolveModuleNamespaceFile } from "./constantClosure2.js";
import { resolveTypedCallee } from "../../typed-symbols/calleeClosure.js";
import { sameNameSubjectsByCache } from "./sameNameSubjects.js";
import { scanGoPackageSiblings } from "./constantResolution3.js";
import { scanLiteral } from "../../search/find/findText.js";
import { symbolIsCallable } from "./focalFlow.js";
import { symbolIsRealMember } from "./callableResolution2.js";
import { unqualifiedSymbolTail } from "./anchorFocus3.js";
import { walkCodeFiles } from "../../../tools/walkRepo.js";
import { wholeIdentifierOnHitLine } from "./identifierAbsence2.js";
import { widenedCandidateFocus } from "./callableResolution4.js";

/**
 * Every declaration named `identifier` among the pack's OWN already-
 * selected candidates (cheap: no new file beyond what the pack already
 * read), same-name-safe. Tier 1 of Deliverable 3 point 1, extended by WP-F
 * (eval-0929 §7 bullet 3 / §8 row 4, `same_name_distractor` / readLimit chip
 * task_b5ca96e5 / the orchestrator's `condvals_path` addition) to
 * disambiguate rather than silently take whichever `selected` happened to
 * sort first. Despite the name, this resolves ANY value/condition SUBJECT
 * identifier the caller asks about -- a constant (`RETRY_STATUSES`) exactly
 * like a callable (`shouldRetry`); `collectDeclaredCallablesNamedInFile`
 * (via `findAllDeclaredCallablesNamed` below) matches a parsed symbol by
 * name only, never by kind.
 *
 * P0-3 (eval-0927 review-r3 #3, wrapperAliasFew/wrapperAliasMultiline): EXACT
 * (case-sensitive) name identity only. This used to compare via `normIdent`
 * (case/underscore-insensitive) as its ONLY test, so a same-named-modulo-
 * case wrapper function (`fetchJSON`) that happened to sort into `selected`
 * ahead of the REAL declaration (`fetchJson`, a different symbol entirely)
 * won this tier outright and was returned as if it settled the question —
 * `resolveFacetFocal` then certified it had zero callers under the
 * WRAPPER's own name, a false "empty" for a function that in fact has
 * several. A fuzzy match is never offered here at all (unlike the identity-
 * matching tiers below it, which keep a same-named-mention safety net) --
 * there is nothing this tier could safely fall back to: unlike a mere
 * mention (whose enclosing-callable identity was never claimed as proof of
 * anything), a fuzzy hit HERE would be presented as a solid declaration,
 * exactly the failure mode above. A miss simply lets `resolveFacetFocal`'s
 * later, exact-preferring tiers (Tier 2's own workspace-wide scan) look
 * further, or fall through to `undetermined` -- never a wrong declaration.
 *
 * WP-F: a SECOND, DIFFERENT declaring FILE of the exact same name is every
 * bit as exact as the first -- just possibly the wrong question's subject
 * if picked by declaration order (eval-0929's own `same_name_distractor`: a
 * fixture's real `shouldRetry`, imported by the very file the query's OTHER
 * facets resolve to, lost to an unrelated file's always-false same-named
 * stand-in that merely sorted first in `selected` -- 408/425/507 certified
 * `request-item-empty` instead of served; the readLimit/RAW_LIMIT_MS chip
 * and the RETRY_STATUSES/`condvals_path` case are the same shape with an
 * EXPLICIT path in the question that should have settled it outright and
 * did not). `findAllDeclaredCallablesNamed` (the SAME bounded, cheap,
 * `selected`-only, up-to-`MAX_SAME_NAME_CANDIDATES` scan the callers facet
 * already uses -- see `resolveCallerCandidateForName`'s own doc) finds
 * every exact match; when they all sit in ONE file (declaration order
 * within that file is not this tier's concern, unchanged from before) or
 * there is at most one match, this returns EXACTLY what the OLD single-
 * match loop always did (recall control: same decision, same hop count).
 * Two or more DISTINCT files declaring the identical name are settled by
 * evidence, never by position: rule (a), an explicit file path the
 * question itself named -- a `query-named-file` surface `selected` already
 * carries, or the caller's own `args.path` -- naming exactly one
 * candidate's file; else rule (b), an import relation from a file this
 * pack already anchors on (another facet's own already-resolved focal in
 * THIS pack, or an `answer-explicit-symbol-focus`/`answer-explicit-
 * identifier-recovery` surface) that imports `identifier` from exactly one
 * candidate's module (`importAnchoredCandidate`, reusing
 * `importSpecifiersNaming` + `resolveImportSpecifierFile` -- every language
 * those already cover: TS/JS, Python, Java, C#, Go same-package, C/C++; no
 * new per-language rule). Neither anchor settling it returns the first
 * candidate found with `.ambiguousWith` set to every candidate (bounded) --
 * the caller MUST check that field before treating the result as settled
 * (see `ResolvedFacetFocal.ambiguousWith`'s own doc).
 */
export async function findDeclaredCallableAmong(
  selected: readonly ImpactCandidate[],
  identifier: string,
  args: TaskPackArgs,
  priorFocalPaths: ReadonlySet<string>,
  workspace: string,
  cache: FileReadCache,
): Promise<ResolvedFacetFocal | undefined> {
  const scan = await findAllDeclaredCallablesNamed(selected, identifier, workspace, cache);
  const byFile: ResolvedFacetFocal[] = [];
  const seenFiles = new Set<string>();
  for (const candidate of scan.candidates) {
    if (seenFiles.has(candidate.path)) continue;
    seenFiles.add(candidate.path);
    byFile.push(candidate);
  }

  // Evidence gathered BEFORE deciding whether there is anything to
  // disambiguate -- the ordinary `selected`-only scan above may surface only
  // ONE (possibly wrong) declaration with no visible competitor at all, so
  // widening must run even when `byFile.length <= 1`.
  //
  // Rule (a): every file the question itself named explicitly -- a
  // `query-named-file` surface `selected` already carries, the caller's own
  // `args.path`, or a plain path/basename token in the query's own text
  // (`queryNamedWorkspaceFiles`, the SAME extraction the pack's other named-
  // file handling already uses).
  const namedPaths = new Set<string>();
  for (const candidate of selected) {
    if (typeof candidate.why === "string" && candidate.why.includes("query-named-file")) namedPaths.add(candidate.path);
  }
  if (typeof args.query === "string" && args.query.length > 0) {
    for (const rel of queryNamedWorkspaceFiles(args.query, workspace, selected.map((c) => c.path))) namedPaths.add(rel);
  }
  // Rule (b) anchors: another facet's own already-resolved focal in THIS
  // pack, an `answer-explicit-symbol-focus`/`answer-explicit-identifier-
  // recovery` surface, or a file the question named by path (above) -- each
  // may import `identifier` from the file that actually declares it
  // (readLimit/RAW_LIMIT_MS chip: the NAMED file itself declares
  // `identifier` directly, no import hop needed, rule (a) alone finds it;
  // the RETRY_STATUSES/`condvals_path` case: the named/anchored file only
  // IMPORTS `identifier`, so rule (a)'s own probe below finds nothing and
  // this import hop is what actually surfaces `limits.ts` as a candidate at
  // all -- `selected` never held it, and neither did any `query-named-file`
  // surface).
  const anchorPaths = [...new Set([
    ...selected
      .filter((c) => c.why === "answer-explicit-symbol-focus" || c.why === "answer-explicit-identifier-recovery" || c.why === REQUEST_ANCHOR_DEFINITION_WHY)
      .map((c) => c.path),
    ...namedPaths,
    ...priorFocalPaths,
  ])];
  const importResolvedPaths = new Set<string>();
  for (const anchorPath of anchorPaths) {
    const resolved = await importedDeclarationFile(identifier, anchorPath, workspace, cache);
    if (resolved !== undefined) importResolvedPaths.add(resolved);
  }

  // Probe every file either rule points at that this facet's own scan never
  // read at all -- a miss (the file does not in fact declare `identifier`)
  // costs nothing beyond the probe itself, most of it already-cached reads.
  const probePaths = new Set([...namedPaths, ...importResolvedPaths]);
  if (typeof args.path === "string" && args.path.length > 0) probePaths.add(args.path);
  const namedCapped = { hit: false };
  const namedSeenKeys = new Set<string>();
  for (const rel of probePaths) {
    if (seenFiles.has(rel) || byFile.length >= MAX_SAME_NAME_CANDIDATES) continue;
    await collectDeclaredCallablesNamedInFile(rel, identifier, workspace, cache, byFile, seenFiles, namedSeenKeys, namedCapped);
  }

  // Last resort, only when NOTHING above found a second file at all: the
  // SAME bounded, declaration-shaped, whole-workspace scan the callers facet
  // already pays for lazily (`widenDeclaredCallablesNamedByScan`) -- a query
  // with no explicit path and no other facet to anchor against (readLimit/
  // RAW_LIMIT_MS chip's own no-path control) can leave the real declaration
  // unreachable by every probe above: `selected` never held it, it names no
  // path the query mentions, and nothing else in this pack imports it either
  // -- so without this, a same-named decoy that merely ranked higher in the
  // ORDINARY locator would settle the facet by POSITION alone, the exact
  // failure this whole function exists to prevent. Only reached when
  // `byFile.length <= 1`, so an ordinary, genuinely-unique identifier (the
  // overwhelming majority of value/condition queries) costs one `scanLiteral`
  // text search that finds nothing new and changes nothing else.
  if (byFile.length <= 1) {
    const widened = await widenDeclaredCallablesNamedByScan(byFile, identifier, args, workspace, cache, false);
    for (const candidate of widened.candidates) {
      if (seenFiles.has(candidate.path) || byFile.length >= MAX_SAME_NAME_CANDIDATES) continue;
      seenFiles.add(candidate.path);
      byFile.push(candidate);
    }
  }

  if (byFile.length === 0) return undefined;
  if (byFile.length === 1) return byFile[0];

  // Rule (a): an explicit file path the question itself named settles which
  // FILE it means (eval-0929 §5's own "path = focus" finding).
  const isExplicitPath = (p: string): boolean =>
    namedPaths.has(p) || (typeof args.path === "string" && args.path.length > 0 && normalizedRequestPath(p) === normalizedRequestPath(args.path));
  const explicitMatches = byFile.filter((candidate) => isExplicitPath(candidate.path));
  if (explicitMatches.length === 1) return explicitMatches[0];

  // Rule (b): an import relation from a file this pack already anchors on
  // settles it -- an import relation is strictly stronger evidence than
  // mere declaration order. A candidate that also happens to be listed as
  // an anchor for an unrelated reason is NOT disqualified from winning its
  // own disambiguation this way -- the common case is exactly that: the REAL
  // declaration is often independently strong evidence too (P0-class
  // regression caught live, aliasTransitiveDecoy: `policy.ts` is both the
  // import target AND its own `answer-explicit-symbol-focus` anchor, and
  // excluding anchors unconditionally turned a settled case back into a
  // false `ambiguous`). Genuine self-vouching (a file's own import of the
  // very name it also declares, resolving back to itself) is excluded at
  // the source instead -- see `importedDeclarationFile`'s own
  // `resolved.path !== anchorPath` guard.
  const importMatches = byFile.filter((candidate) => importResolvedPaths.has(candidate.path));
  if (importMatches.length === 1) return importMatches[0];

  // Rule (b), same-file extension: `identifier` may sit in the SAME file as
  // another facet's own subject with no import to chase at all (Python
  // twin, pyAbsenceDecoy: `should_retry` is declared directly in `client.py`
  // beside `get_timeout`/`send_request`, not re-exported from a separate
  // module) -- a file THIS PACK has already confidently settled as another
  // requirement's own focal that ALSO happens to declare `identifier`
  // itself is at least as strong a connection as importing it from
  // elsewhere. Restricted to `priorFocalPaths` specifically (never the
  // wider `answer-explicit-symbol-focus`/named-path anchor set): those are
  // heuristic ranking tags a same-named DECOY can earn on its own lexical
  // merits (confirmed live, aliasTransitiveDecoy: both the decoy and the
  // real declaration carried it) -- a prior FOCAL is this pack's own
  // already-certified decision for a DIFFERENT clause, not a guess.
  const priorFocalDeclared = byFile.filter((candidate) => priorFocalPaths.has(candidate.path));
  if (priorFocalDeclared.length === 1) return priorFocalDeclared[0];

  // WP-O (eval-0929 §8): rule (b)'s CALLERS form — the pack's own same-name
  // binding for this name (`bindSameNameSubject`: every caller of it imports
  // it from ONE declaring file, or the named file/target does), consulted
  // only once every rule above left the question open. Evidence, never
  // position: without such a binding this still falls to rule (c).
  const sameNameBound = sameNameSubjectsByCache.get(cache)?.get(identifier)?.bound;
  if (sameNameBound !== undefined) {
    const boundDeclaration = byFile.find((candidate) => candidate.path === sameNameBound.path);
    if (boundDeclaration !== undefined) return boundDeclaration;
  }

  // Rule (c): genuinely ambiguous -- never silently the first match.
  return { ...byFile[0], ambiguousWith: byFile.slice(0, MAX_SAME_NAME_CANDIDATES) };
}

/**
 * Rule (b) helper (WP-F, eval-0929 §7 bullet 3 / §8 row 4): the file
 * `anchorPath` imports `identifier` FROM (its resolved specifier target),
 * or `undefined` when `anchorPath` carries no import of `identifier` that
 * resolves to a real workspace file. Reuses `importSpecifiersNaming` +
 * `resolveImportSpecifierFile` exactly as the constant/callee closure
 * already does elsewhere in this module -- no new per-language rule, every
 * language those already cover (TS/JS, Python, Java, C#, Go same-package,
 * C/C++) is covered here too.
 */
export async function importedDeclarationFile(
  identifier: string,
  anchorPath: string,
  workspace: string,
  cache: FileReadCache,
): Promise<string | undefined> {
  const content = readCached(workspace, anchorPath, cache);
  if (content === undefined) return undefined;
  const lines = content.split(/\r?\n/);
  const specs = importSpecifiersNaming(lines, identifier, hasHashComments(anchorPath), anchorPath)
    .slice(0, MAX_IMPORT_RESOLVED_FILES_PER_FOCAL);
  for (const spec of specs) {
    const resolved = await resolveImportSpecifierFile(anchorPath, spec, workspace, cache);
    // A file cannot vouch for itself: excluded here (never at the decision
    // site above) so a genuine self-loop is ruled out at the source while an
    // otherwise-unrelated candidate that also serves as an anchor is not.
    if (resolved !== undefined && resolved.path !== anchorPath) return resolved.path;
  }
  return undefined;
}

/**
 * P0-1 (eval-0927 review-r3 #1, qualifiedTsMethod/qualifiedTsService/
 * qualifiedPyMethod/tsDecoratorSameLine): a clause naming "A.b" asks about
 * the MEMBER `b` declared INSIDE the type `A`, never the type itself and
 * never a same-named member of some OTHER type -- an exact, case-sensitive
 * match on BOTH the member's own name and its enclosing symbol's name (the
 * P0-3 identity rule applied to a qualified pair). Searched among the
 * pack's own already-selected candidates first (`resolveFacetFocal` calls
 * this before anything else): the locator's own "class-method" layer
 * (locateTaskContext.ts Layer 1b, `extractClassMethodPairs` +
 * `refineFilenameMatchSymbol`) already anchors a qualified query on the
 * member's own file/line when it can, so the owning file is ordinarily
 * already selected by the time a facet hook runs.
 */
/**
 * The shared owner/member proof `findDeclaredMemberOfOwner` and its own
 * widening below apply to one file's already-parsed symbols: either the
 * parser attached a real `enclosingSymbol` (TS/JS/Python/Java/C#/Kotlin/
 * C++'s in-class-body methods), or the symbol's OWN NAME carries the
 * qualifier (a C++ out-of-line member DEFINITION, `OrderStatus
 * OrderService::cancel(int id) { ... }`, sits at file scope in its OWN
 * translation unit -- the parser never nests it inside a class body at all
 * (there is no class body in THAT file to nest it under), so
 * `enclosingSymbol` is always absent for it; `qualifiedSymbolOwner` reads
 * the qualifier off the name itself, the same way `unqualifiedSymbolTail`
 * reads its member tail).
 */
export function memberOfOwnerIn(parsed: ParsedSymbols, owner: string, member: string): ParsedSymbols[number] | undefined {
  return parsed.find((s) =>
    CALLER_EXPANSION_CALLABLE_KINDS.has(s.kind)
    && unqualifiedSymbolTail(s.name) === member
    && (
      (s.enclosingSymbol !== undefined && unqualifiedSymbolTail(s.enclosingSymbol.name) === owner)
      || qualifiedSymbolOwner(s.name) === owner
    )
  );
}

export async function findDeclaredMemberOfOwner(
  selected: readonly ImpactCandidate[],
  owner: string,
  member: string,
  workspace: string,
  cache: FileReadCache,
): Promise<ResolvedFacetFocal | undefined> {
  const seenPaths = new Set<string>();
  for (const candidate of selected) {
    if (seenPaths.has(candidate.path)) continue;
    seenPaths.add(candidate.path);
    const content = readCached(workspace, candidate.path, cache);
    if (content === undefined) continue;
    const lang = languageForPath(candidate.path);
    const parsed = (lang ? await cache.parsedSymbols(content, lang, candidate.path) : null) ?? [];
    const symbol = memberOfOwnerIn(parsed, owner, member);
    if (symbol === undefined) continue;
    // Ownership is already proven above (either via `enclosingSymbol` or via
    // the qualified name) -- `owner` itself is the right typeName; falling
    // back to `callerExpansionTypeNameFor`'s file-stem guess (as the
    // `enclosingSymbol`-only tiers below still must, since THEY have no such
    // proof) would misname an out-of-line definition's own translation unit
    // (no type is declared in THAT file at all).
    return {
      path: candidate.path,
      name: unqualifiedSymbolTail(symbol.name),
      startLine: symbol.startLine,
      endLine: symbol.endLine,
      typeName: owner,
      hasRealType: true,
      kind: symbol.kind,
    };
  }
  return undefined;
}

/**
 * P0-2's own widening for a QUALIFIED pair, called only when
 * `findDeclaredMemberOfOwner` found nothing among the pack's OWN selected
 * candidates. `owner.member`'s locator resolution (Layer 1b's own
 * `extractClassMethodPairs`) anchors a qualified query on whichever file
 * carries the member's IN-CLASS declaration when one exists -- but a C++
 * member's in-class declaration is usually a bodyless prototype
 * (`OrderStatus cancel(int id);`, a `field_declaration`), which
 * `collectSymbols.ts`'s tree-sitter extractor never turns into a symbol at
 * all; the file that actually PROVES ownership (the out-of-line definition,
 * `memberOfOwnerIn`'s qualified-name arm) is a different translation unit
 * the locator never had a reason to select. A bounded, declaration-shaped-
 * only literal scan for `member` (the SAME reordering
 * `findEnclosingCallableForLiteral` already applies) finds it; the owner
 * check inside `memberOfOwnerIn` still guards against a same-named member
 * of some unrelated type.
 */
export async function widenDeclaredMemberOfOwnerByScan(
  selected: readonly ImpactCandidate[],
  owner: string,
  member: string,
  args: TaskPackArgs,
  workspace: string,
  cache: FileReadCache,
): Promise<ResolvedFacetFocal | undefined> {
  let scanned: ReturnType<typeof scanLiteral>;
  try {
    scanned = scanLiteral(member, workspace, { caseInsensitive: false, ...(args.path ? { path: args.path } : {}) });
  } catch {
    return undefined;
  }
  const seenPaths = new Set(selected.map((c) => c.path));
  const declarationShaped: typeof scanned = [];
  const mentionOnly: typeof scanned = [];
  for (const match of scanned) {
    if (seenPaths.has(match.path)) continue;
    (isDeclarationShapedMatchText(match.text, member) ? declarationShaped : mentionOnly).push(match);
  }
  const ordered = [...declarationShaped, ...mentionOnly].slice(0, MAX_CALLER_FILES_EXAMINED);
  const parsedPaths = new Set<string>();
  for (const match of ordered) {
    if (parsedPaths.has(match.path)) continue;
    parsedPaths.add(match.path);
    const content = readCached(workspace, match.path, cache);
    if (content === undefined) continue;
    const lang = languageForPath(match.path);
    const parsed = (lang ? await cache.parsedSymbols(content, lang, match.path) : null) ?? [];
    const symbol = memberOfOwnerIn(parsed, owner, member);
    if (symbol === undefined) continue;
    return {
      path: match.path,
      name: unqualifiedSymbolTail(symbol.name),
      startLine: symbol.startLine,
      endLine: symbol.endLine,
      typeName: owner,
      hasRealType: true,
      kind: symbol.kind,
    };
  }
  return undefined;
}

export async function findAllDeclaredCallablesNamed(
  selected: readonly ImpactCandidate[],
  identifier: string,
  workspace: string,
  cache: FileReadCache,
): Promise<DeclaredCallablesScan> {
  const out: ResolvedFacetFocal[] = [];
  const seenPaths = new Set<string>();
  const seenKeys = new Set<string>();
  const capped = { hit: false };
  for (const candidate of selected) {
    if (out.length >= MAX_SAME_NAME_CANDIDATES) { capped.hit = true; break; }
    await collectDeclaredCallablesNamedInFile(candidate.path, identifier, workspace, cache, out, seenPaths, seenKeys, capped);
  }
  return { candidates: out, capped: capped.hit };
}

/**
 * P0-2's own widening, called LAZILY (only once `findAllDeclaredCallablesNamed`'s
 * cheap `selected`-only candidates ALL turned out to have zero call sites):
 * a bounded, DECLARATION-SHAPED-only literal scan of the whole workspace
 * (the SAME per-line test `findEnclosingCallableForLiteral` already
 * applies, `isDeclarationShapedMatchText`) — the real declaration is not
 * always among `selected` at all (kotlinFun: the locator selected only the
 * caller file and a "readiness-falsification-counterexample" read of the
 * WRONG class, never the file that actually declares the real, calling
 * method), so a zero-caller decoy must never be the only candidate ever
 * considered. Excludes every path `already` names (so a candidate the cheap
 * pass already found and ruled empty is never re-parsed) -- UNLESS
 * `reexamineAlreadySeenFiles` (P1-7, sixSameNameOneFile): when the cheap
 * pass was itself capped, a truncated FILE must remain eligible for this
 * widen scan to revisit (`seenKeys`, seeded from `already` regardless,
 * still prevents re-adding the SAME declarations twice) -- otherwise the
 * very file holding the declaration this pass most needs to find is the one
 * PERMANENTLY excluded by `already`'s own bookkeeping, and the cap can never
 * be overcome no matter how many further hops re-ask the same question.
 */
export async function widenDeclaredCallablesNamedByScan(
  already: readonly ResolvedFacetFocal[],
  identifier: string,
  args: TaskPackArgs,
  workspace: string,
  cache: FileReadCache,
  reexamineAlreadySeenFiles: boolean,
): Promise<DeclaredCallablesScan> {
  const out: ResolvedFacetFocal[] = [];
  const seenPaths = new Set<string>(reexamineAlreadySeenFiles ? [] : already.map((c) => c.path));
  const seenKeys = new Set<string>(already.map((c) => `${c.path}#${c.startLine}`));
  const capped = { hit: false };
  let scanned: ReturnType<typeof scanLiteral>;
  try {
    scanned = scanLiteral(identifier, workspace, { caseInsensitive: false, ...(args.path ? { path: args.path } : {}) });
  } catch {
    return { candidates: out, capped: false };
  }
  for (const match of scanned) {
    if (out.length >= MAX_SAME_NAME_CANDIDATES) { capped.hit = true; break; }
    if (seenPaths.has(match.path)) continue;
    if (!isDeclarationShapedMatchText(match.text, identifier)) continue;
    await collectDeclaredCallablesNamedInFile(match.path, identifier, workspace, cache, out, seenPaths, seenKeys, capped);
  }
  return { candidates: out, capped: capped.hit };
}

/**
 * `identifier` is NOT a declared symbol anywhere already selected (an
 * env-var key, a property) -- a bounded literal occurrence, then the
 * enclosing callable of the best occurrence. Tier 2, and the same mechanism
 * that closes the "symbol-scope find for an env-var name" dead end
 * (eval-0927 §3, arch-map Q7) for a faceted question specifically.
 *
 * "Best" is a DECLARATION occurrence (the enclosing callable IS `identifier`
 * itself, case/underscore-normalized) when one exists anywhere in the
 * scanned scope, never merely the first workspace-scan-ordered occurrence --
 * FIX-C1 (2026-09-27, live V01 reproduction): `identifier` here is very
 * often ALSO a real declared symbol the caller's own Tier 1 (searching only
 * the pack's ALREADY-selected candidates) missed simply because that file
 * was not yet selected when this tier ran (`fetchWithRetry`'s own
 * `src/httpClient.ts` is not necessarily selected before a facet hook runs
 * on the FIRST pack). `scanLiteral`'s workspace-walk order is not
 * declaration-preferring (a lexically-earlier CALL SITE, e.g.
 * `src/api/orders.ts`, sorted before `src/httpClient.ts`, was picked and
 * treated as if that caller's own enclosing function -- `listOrders` --
 * were what the query asked about). A one-pass scan over every match, kept
 * to the SAME MAX_CALLER_FILES_EXAMINED bound scanLiteral itself is capped
 * to, fixes this without a second workspace scan.
 */
export async function findEnclosingCallableForLiteral(
  identifier: string,
  args: TaskPackArgs,
  workspace: string,
  cache: FileReadCache,
): Promise<{ focal: ResolvedFacetFocal; declaration: boolean } | undefined> {
  let scanned: ReturnType<typeof scanLiteral>;
  try {
    scanned = scanLiteral(identifier, workspace, { caseInsensitive: false, ...(args.path ? { path: args.path } : {}) });
  } catch {
    return undefined;
  }
  // WP-N (eval-0929 §8): a line that holds the name only inside a longer
  // identifier (`MAX_X_V2 - used`) does not READ `MAX_X` — its enclosing
  // callable is no subject for X's value, condition or callers (measured: the
  // reader of `MAX_X_V2` became `MAX_X`'s value focal and its closure certified
  // `MAX_X_V2`'s value). Whole occurrences only, judged on the FULL line
  // (`match.text` is a trimmed window).
  scanned = scanned.filter((match) => wholeIdentifierOnHitLine(workspace, match, identifier, cache) !== undefined);
  const target = normIdent(identifier);
  // FIX-FAB item 2 (eval-0927 review #2, manyCallers/manyCallers20/
  // manyCallers12): `scanLiteral` is unbounded and workspace-walk-ordered
  // (findText.ts's own doc: "no cap, no truncation"), so with 20+ caller
  // files sorting alphabetically ahead of the declaring file (`src/api/*`,
  // `src/handlers/*` before `src/httpClient.ts`), the OLD flat
  // `scanned.slice(0, MAX_CALLER_FILES_EXAMINED)` exhausted its 40-match
  // budget on caller mentions before this loop ever reached the declaration,
  // and the mention fallback (the WRONG focal) won by default. A per-line
  // declaration-shape test (the SAME `IDENTIFIER_DEFINITION_KEYWORD_RE` test
  // the caller-expansion call-site filter already applies to
  // `definitionSegment`, here read off `scanLiteral`'s own trimmed
  // `match.text` instead of a fresh file read) is cheap enough to run over
  // EVERY match, unbounded, so the file-parse cap below still only ever
  // bounds the EXPENSIVE enclosing-callable resolution, never the search for
  // the declaration itself (P2's own "the 40-file cap may only bound the
  // enclosing-callable work"). A false positive here costs nothing — the
  // resolved symbol is still checked against `target` below exactly as
  // before, so a mis-guessed "declaration-shaped" mention simply becomes an
  // ordinary fallback candidate, never a wrong declaration claim.
  const declarationShaped: typeof scanned = [];
  const mentionOnly: typeof scanned = [];
  for (const match of scanned) {
    (isDeclarationShapedMatchText(match.text, identifier) ? declarationShaped : mentionOnly).push(match);
  }
  const ordered = declarationShaped.length === 0
    ? scanned.slice(0, MAX_CALLER_FILES_EXAMINED)
    : [...declarationShaped, ...mentionOnly].slice(0, MAX_CALLER_FILES_EXAMINED);
  let fallback: ResolvedFacetFocal | undefined;
  for (const match of ordered) {
    const content = readCached(workspace, match.path, cache);
    if (content === undefined) continue;
    const lang = languageForPath(match.path);
    const parsed = (lang ? await cache.parsedSymbols(content, lang, match.path) : null) ?? [];
    const enclosing = parsed
      .filter((s) => CALLER_EXPANSION_CALLABLE_KINDS.has(s.kind) && match.line >= s.startLine && match.line <= s.endLine)
      .sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine))[0];
    if (enclosing === undefined) continue;
    const typeName = callerExpansionTypeNameFor(parsed, match.path);
    const resolved: ResolvedFacetFocal = {
      path: match.path,
      name: unqualifiedSymbolTail(enclosing.name),
      startLine: enclosing.startLine,
      endLine: enclosing.endLine,
      typeName: unqualifiedSymbolTail(enclosing.enclosingSymbol?.name ?? typeName),
      hasRealType: symbolIsRealMember(enclosing, match.path),
      kind: enclosing.kind,
    };
    if (resolved.name === identifier) return { focal: resolved, declaration: true }; // EXACT identity -- best possible, stop here
    // P0-3 (eval-0927 review-r3 #3, wrapperAliasFew/wrapperAliasMultiline): a
    // case/underscore-only match on ITS OWN NAME is never used as a
    // resolution (exact identity or nothing -- the same rule
    // `findDeclaredCallableAmong` applies, see its own doc). Skipped rather
    // than let it flow into `fallback` below: a fuzzy-named declaration
    // (e.g. a wrapper `fetchJSON` for a query naming `fetchJson`) would
    // otherwise become `fallback`, and `resolveFacetFocal`'s downstream
    // `namesAnIdentifier` name-based safety net (built for a genuinely
    // DIFFERENT-named mention) is normIdent-based too, so it would trivially
    // accept the very same wrapper right back in -- reproducing the bug
    // through this second channel instead of fixing it.
    if (normIdent(resolved.name) === target) continue;
    if (fallback === undefined) fallback = resolved; // a mere mention/call site of a genuinely different name; keep looking for the real declaration
  }
  return fallback === undefined ? undefined : { focal: fallback, declaration: false };
}

/**
 * The concept-anchoring score for ONE file: its own callable NAME or a
 * bounded peek of its BODY scored against `terms`, preferring `focusedTail`
 * (the surface's OWN already-focused symbol, when it names a callable at
 * all) over the file's first callable. `undefined` when the file is
 * unreadable, has no callable, or anchors none of `terms`.
 *
 * WP-C4 (2026-09-29, eval-0929 §8 item 2): `includeValueKinds` (value/
 * condition facets only -- see this function's two call sites,
 * `bestConceptAnchoredCandidate`'s own two calls into it, threaded from
 * `resolveFacetFocal`) ALSO scores every `VALUE_DECLARATION_KINDS` symbol in
 * the file and keeps the best of {the callable pick, the best value-kind
 * pick}. Root cause this closes: "Explain the retry constant's configured
 * value" names no explicit identifier, so `resolveFacetFocal` falls all the
 * way through to this concept-anchor tier on `subjectTerms` alone
 * (["retry","constant","configur","value"]) -- and the OLD code only ever
 * considered `CALLER_EXPANSION_CALLABLE_KINDS` (function/method), so a file
 * holding ONLY `const RETRY_LIMIT = ...` (no callable at all) returned
 * `undefined` here, unconditionally, however strongly its own constant's
 * NAME carried the concept -- contributing nothing to
 * `bestConceptAnchoredCandidate`'s cross-file comparison, so an unrelated
 * file whose callable merely scored above zero always won by default. The
 * callable pick's own selection rule (`focusedTail`-if-callable, else the
 * file's first callable) is UNCHANGED, and a tie between the two picks keeps
 * the callable (strict `>` below) -- flow/callers concept-anchoring (the
 * other call site, `includeValueKinds` false) is byte-for-byte the prior
 * behavior; only a value/condition clause ever sees the wider comparison.
 */
export async function bestConceptAnchoredInFile(
  filePath: string,
  focusedTail: string | undefined,
  terms: readonly string[],
  workspace: string,
  cache: FileReadCache,
  includeValueKinds: boolean,
  focusedSpan?: { startLine: number; endLine: number },
): Promise<{ focal: ResolvedFacetFocal; score: number } | undefined> {
  const content = readCached(workspace, filePath, cache);
  if (content === undefined) return undefined;
  const lang = languageForPath(filePath);
  const parsed = (lang ? await cache.parsedSymbols(content, lang, filePath) : null) ?? [];
  const bodyLower = content.slice(0, 4096).toLowerCase();
  const scoreOf = (symbol: (typeof parsed)[number]): number => {
    const lowerName = symbol.name.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (term.length < 3) continue;
      if (lowerName.includes(term)) score += 3;
      if (bodyLower.includes(term)) score += 1;
    }
    return score;
  };

  const focused = focusedTail === undefined ? undefined : parsed.find((s) =>
    unqualifiedSymbolTail(s.name) === focusedTail
    && (focusedSpan === undefined || s.startLine === focusedSpan.startLine && s.endLine === focusedSpan.endLine));
  const callable = (focused !== undefined && CALLER_EXPANSION_CALLABLE_KINDS.has(focused.kind))
    ? focused
    : focusedSpan === undefined ? parsed.find((s) => CALLER_EXPANSION_CALLABLE_KINDS.has(s.kind)) : undefined;
  let best: { symbol: (typeof parsed)[number]; score: number } | undefined;
  if (callable !== undefined) {
    const score = scoreOf(callable);
    if (score > 0) best = { symbol: callable, score };
  }
  if (includeValueKinds) {
    for (const symbol of parsed) {
      if (!VALUE_DECLARATION_KINDS.has(symbol.kind)) continue;
      const score = scoreOf(symbol);
      if (score > 0 && (best === undefined || score > best.score)) best = { symbol, score };
    }
  }
  if (best === undefined) return undefined;
  const typeName = callerExpansionTypeNameFor(parsed, filePath);
  return {
    score: best.score,
    focal: {
      path: filePath,
      name: unqualifiedSymbolTail(best.symbol.name),
      startLine: best.symbol.startLine,
      endLine: best.symbol.endLine,
      typeName: unqualifiedSymbolTail(best.symbol.enclosingSymbol?.name ?? typeName),
      hasRealType: symbolIsRealMember(best.symbol, filePath),
      kind: best.symbol.kind,
    },
  };
}

export async function selectedRangeCallable(
  candidate: ImpactCandidate,
  span: { start: number; end: number },
  workspace: string,
  cache: FileReadCache,
): Promise<CollectedSymbol | undefined> {
  const content = readCached(workspace, candidate.path, cache);
  const lang = languageForPath(candidate.path);
  if (content === undefined || !lang) return undefined;
  const symbols = (await cache.parsedSymbols(content, lang, candidate.path)) ?? [];
  const callable = symbols.filter((s) => CALLER_EXPANSION_CALLABLE_KINDS.has(s.kind));
  // A selection may include a neighbouring constant; the one complete
  // callable within it is unambiguous. Multiple callables are not a choice.
  const contained = callable.filter((s) => span.start <= s.startLine && s.endLine <= span.end);
  if (contained.length === 1) return contained[0]!;
  if (contained.length > 1) return undefined;
  // A body-only window can select its unique smallest enclosing callable.
  const enclosing = callable.filter((s) => s.startLine <= span.start && span.end <= s.endLine)
    .sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine));
  if (enclosing.length === 0) return undefined;
  if (enclosing.length > 1 && enclosing[0]!.endLine - enclosing[0]!.startLine === enclosing[1]!.endLine - enclosing[1]!.startLine) return undefined;
  return enclosing[0]!;
}

export async function bestConceptAnchoredCandidate(
  selected: readonly ImpactCandidate[],
  terms: readonly string[],
  workspace: string,
  cache: FileReadCache,
  /** WP-C4 (eval-0929 §8 item 2) — threaded straight through to
   *  `bestConceptAnchoredInFile`'s own parameter of the same name; see its
   *  doc comment. `resolveFacetFocal` passes `true` only for its value
   *  branch (a condition clause's focal is the deciding callable; the
   *  constants it reads are chased by its closure). */
  includeValueKinds: boolean,
): Promise<ResolvedFacetFocal | undefined> {
  let best: { focal: ResolvedFacetFocal; score: number } | undefined;
  for (const candidate of selected.slice(0, MAX_SURFACES_DISTINCT)) {
    const selection = explicitFacetSelectionRange.get(candidate);
    const focused = candidate.symbol ?? widenedCandidateFocus.get(candidate);
    const rangeFocus = selection === undefined ? undefined : await selectedRangeCallable(candidate, selection, workspace, cache);
    const focusSymbol = focused ?? rangeFocus?.name;
    // An ambiguous explicit range cannot justify a zero-caller claim about
    // an arbitrary first function. Value lookups may still find a constant.
    if (selection !== undefined && focusSymbol === undefined && !includeValueKinds) continue;
    const focusedTail = focusSymbol === undefined ? undefined : unqualifiedSymbolTail(focusSymbol);
    const found = await bestConceptAnchoredInFile(candidate.path, focusedTail, terms, workspace, cache, includeValueKinds,
      rangeFocus !== undefined && focusSymbol === rangeFocus.name ? rangeFocus : undefined);
    if (found !== undefined && (best === undefined || found.score > best.score)) best = found;
  }
  if (best !== undefined || selected.length > 0) return best?.focal;
  const usableTerms = terms.filter((term) => term.length >= 3);
  if (usableTerms.length === 0) return undefined;
  // FIX (eval-0927 review-r2 #3's kanji-fallback slice, "do not scan the
  // first 40 walked files"): the OLD `walkCodeFiles(workspace,
  // {}).slice(0, MAX_CALLER_FILES_EXAMINED)` bounded this fallback by
  // FILE-WALK ORDER — on a workspace whose first 40 walked files happen not
  // to be the one that anchors the query's bridged concept terms, that file
  // was never even read, however far into the walk it sat. `scanLiteral`
  // (unbounded — "no cap, no truncation", its own doc) finds every file that
  // actually CONTAINS a term first; only that (typically far smaller) set is
  // then read/parsed for real scoring, bounded to MAX_CALLER_FILES_EXAMINED
  // of THOSE — bound by MATCHES, never by walk order. `walked` is walked
  // once and reused across every term's scan (findText.ts's own documented
  // `files` reuse mechanism, so this costs one directory walk, not one per
  // term).
  const walked = walkCodeFiles(workspace, {});
  const candidatePaths = new Set<string>();
  for (const term of usableTerms) {
    let matches: ReturnType<typeof scanLiteral>;
    try {
      matches = scanLiteral(term, workspace, { caseInsensitive: true, files: walked });
    } catch {
      continue;
    }
    for (const match of matches) candidatePaths.add(match.path);
  }
  for (const relPath of [...candidatePaths].sort().slice(0, MAX_CALLER_FILES_EXAMINED)) {
    const found = await bestConceptAnchoredInFile(relPath, undefined, usableTerms, workspace, cache, includeValueKinds);
    if (found !== undefined && (best === undefined || found.score > best.score)) best = found;
  }
  return best?.focal;
}

/**
 * P0-2 (eval-0927 review-r3 #2, tsTwoClassesSameMethod/kotlinFun): the full
 * identity-then-disambiguation pipeline for ONE identifier-or-weak-
 * candidate NAME, shared by `resolveFacetFocal`'s ordinary (code-shaped)
 * identifier tier and its P1-8 weak-candidate tier below — an all-
 * lowercase, no-underscore, unhumped word like "flush" is not code-shaped
 * either (`explicitIdentifiersIn`'s own rule: no `_`, no camelCase/
 * PascalCase hump, not ALL-CAPS), so it too only ever reaches
 * `resolveFacetFocal` as a WEAK candidate — and the SAME "several same-named
 * declarations, don't settle for whichever sorts first" ambiguity applies
 * there just as much as to a proper explicit identifier; disambiguation
 * cannot be tier-specific (confirmed live: the P0-2 fixture's own "flush"
 * query never reached the explicit-identifier tier at all).
 *
 * Declared in SEVERAL classes/files -- among the pack's own selected
 * candidates, or (kotlinFun: `selected` held only the caller file and an
 * unrelated "readiness-falsification" read, never either class) only
 * reachable via a workspace-wide scan. Either way, `findDeclaredCallableAmong`'s
 * single-match Tier 1 and `findEnclosingCallableForLiteral`'s own "first
 * exact match in scan order" would both return whichever sorts first
 * regardless of whether it has any real callers. Asks each candidate
 * (bounded, MAX_SAME_NAME_CANDIDATES) the SAME question the outcomes
 * producer will ask the chosen focal later (`callerSitesForFocal`, unedited
 * — called per candidate rather than changed) and prefers the first with a
 * real site.
 *
 * Returns `{ settled }` when a declaration with a real call site was found
 * (or is the sole exact declaration and the caller accepts it without a
 * call-site check — see call sites' own comments); `{ allCandidates }`
 * alone (`settled` undefined) when at least one exact declaration exists
 * but every one found is genuinely empty (a legitimate, honest "empty" —
 * P0-2's own policy); neither populated when no declaration of `name`
 * exists anywhere this pack can see at all.
 *
 * P1-7 (eval-0927 review-r4 #7, sixSameNameOneFile): `capped` is true when
 * MAX_SAME_NAME_CANDIDATES was hit anywhere in EITHER pass -- the caller
 * must then never read `allCandidates` as "every declaration of `name`,
 * all genuinely empty": a declaration this pass never reached might be the
 * one with real callers. The widen pass re-examines a truncated file
 * (`reexamineAlreadySeenFiles`) so the REALISTIC case (a cap hit only
 * because too many same-named declarations sat in ONE file) still settles
 * here; `capped` is the honest fallback for the rarer case where even that
 * is not enough.
 */
export async function resolveCallerCandidateForName(
  name: string,
  selected: readonly ImpactCandidate[],
  args: TaskPackArgs,
  workspace: string,
  cache: FileReadCache,
  allowTestPaths: boolean,
  deadline: number,
): Promise<{ settled?: ResolvedFacetFocal; allCandidates: readonly ResolvedFacetFocal[]; capped: boolean }> {
  const withCallSite = async (pool: readonly ResolvedFacetFocal[]): Promise<ResolvedFacetFocal | undefined> => {
    for (const candidate of pool) {
      if (Date.now() >= deadline) break;
      const scan = await callerSitesForFocal(candidate, args, workspace, cache, allowTestPaths, deadline);
      if (scan.sites.length > 0) return candidate;
    }
    return undefined;
  };
  const cheap = await findAllDeclaredCallablesNamed(selected, name, workspace, cache);
  let settled: ResolvedFacetFocal | undefined = cheap.candidates.length > 0 ? await withCallSite(cheap.candidates) : undefined;
  let allCandidates: readonly ResolvedFacetFocal[] = cheap.candidates;
  let capped = cheap.capped;
  if (settled === undefined) {
    // Either no cheap (selected-derived) candidate at all, or every one of
    // them genuinely has zero call sites -- widen to a bounded,
    // declaration-shaped, whole-workspace scan before conceding. Paid only
    // here, once the cheap pass alone could not settle it.
    const widened = await widenDeclaredCallablesNamedByScan(cheap.candidates, name, args, workspace, cache, cheap.capped);
    if (widened.candidates.length > 0) {
      settled = await withCallSite(widened.candidates);
      allCandidates = [...cheap.candidates, ...widened.candidates];
    }
    capped = capped || widened.capped;
  }
  return { settled, allCandidates, capped };
}

/**
 * Copilot retest r2 review (2026-10-02, P1): the call-shaped tier of
 * `resolveFacetFocal` without the declarations in test files. A
 * co-located stub (`const quote = vi.fn(...)` in `quote.spec.ts`) made
 * `quote` "declared in 2 files", so the value focal stayed ambiguous and its
 * closure was never computed, where the older tiers served all nine files.
 * Keeps the non-test candidates, still ambiguous when several remain; gives
 * the name up (the older tiers then run) when only a test file declares it.
 */
export function withoutTestDeclarations(found: ResolvedFacetFocal): ResolvedFacetFocal | undefined {
  const candidates = found.ambiguousWith ?? [found];
  const nonTest = candidates.filter((candidate) => !isTestConcernPath(candidate.path));
  if (nonTest.length === candidates.length) return found;
  if (nonTest.length === 0) return undefined;
  if (nonTest.length === 1) {
    const { ambiguousWith: _ambiguousWith, ...single } = nonTest[0]!;
    return single;
  }
  return { ...nonTest[0]!, ambiguousWith: nonTest };
}

export async function resolveFacetFocal(
  requirement: FacetRequirement,
  selected: readonly ImpactCandidate[],
  args: TaskPackArgs,
  workspace: string,
  cache: FileReadCache,
  allowTestPaths: boolean,
  deadline: number,
  /** WP-F (eval-0929 §7 bullet 3 / §8 row 4): every OTHER requirement's own already-resolved focal path in THIS SAME pack, in requirement order -- rule (b)'s order-dependent anchor set (see `findDeclaredCallableAmong`'s own doc). Empty for the first requirement of a pack; harmless when unused (flow/callers never read it). */
  priorFocalPaths: ReadonlySet<string> = new Set(),
): Promise<ResolvedFacetFocal | undefined> {
  // P0-1 (eval-0927 review-r3 #1, qualifiedTsMethod/qualifiedTsService/
  // qualifiedPyMethod/tsDecoratorSameLine): a clause naming "A.b" asks about
  // the member `b` declared inside `A` -- try that exact, owner-scoped
  // resolution before anything else.
  const qualifiedMembers = requirement.qualifiedMembers ?? [];
  for (const { owner, member } of qualifiedMembers) {
    const found = await findDeclaredMemberOfOwner(selected, owner, member, workspace, cache);
    if (found) return found;
    // P0-2 (eval-0927 review-r4 #2, cppQualifiedDef/cppQualifiedDotSpelling):
    // the pack's own selection may hold only the member's bodyless in-class
    // declaration (or nothing at all) -- see `widenDeclaredMemberOfOwnerByScan`'s
    // own doc for why the file that actually proves ownership is often a
    // different translation unit the locator never selected.
    const widened = await widenDeclaredMemberOfOwnerByScan(selected, owner, member, args, workspace, cache);
    if (widened) return widened;
  }
  // A class is never the subject of a facet that names one of its members
  // (P0-1's own second half): the bare owner name is excluded from every
  // identifier tier below, so a query like "Who calls HttpClient.fetchJson?"
  // can still resolve to `fetchJson` itself (via the ordinary tiers) even
  // when the owner-scoped lookup just above found nothing, but never
  // silently settles for the class instead.
  const qualifiedOwners = new Set(qualifiedMembers.map((pair) => pair.owner));
  if (requirement.facet === "value" || requirement.facet === "condition") {
    // Copilot retest r2 (2026-10-02): a callable the clause writes in call
    // syntax (`quote()`) is its subject ahead of any identifier it inherited
    // or carries as input data -- "calculate exact quote() results for these
    // carts: ... coupon SAVE500" otherwise resolved through `SAVE500` to the
    // function holding that string literal (see requestFacets.ts's
    // `callShapedNamesIn`). Declaration tier only: a call-shaped name with no
    // declaration in the workspace (a built-in such as `Math.floor()`) falls
    // through to the tiers below unchanged, never to the literal tier. A
    // question that does not mention tests never takes a test file's
    // same-named declaration for its subject (`withoutTestDeclarations`).
    for (const name of requirement.subjectCallables ?? []) {
      if (qualifiedOwners.has(name)) continue;
      const found = await findDeclaredCallableAmong(selected, name, args, priorFocalPaths, workspace, cache);
      const focal = found === undefined || allowTestPaths ? found : withoutTestDeclarations(found);
      if (focal) return focal;
    }
    for (const identifier of requirement.subjectIdentifiers) {
      if (qualifiedOwners.has(identifier)) continue;
      const found = await findDeclaredCallableAmong(selected, identifier, args, priorFocalPaths, workspace, cache);
      if (found) return found;
    }
    // The callable that merely READS an undeclared key (`process.env.X ??
    // 30000`) is exactly where its value or condition is applied.
    for (const identifier of requirement.subjectIdentifiers) {
      if (qualifiedOwners.has(identifier)) continue;
      const found = await findEnclosingCallableForLiteral(identifier, args, workspace, cache);
      if (found) return found.focal;
    }
    // WP-N (eval-0929 §8): when EVERY identifier the clause names is absent as
    // a whole identifier, the clause has no subject in this workspace. The
    // concept tier below would otherwise resolve a focal through the
    // identifier's own WORDS — `MAX_QUOTA_UNITS` → "quota" → `checkQuota` —
    // and certify that unrelated body as the value (measured, both builds).
    // No focal → the gate discloses `request-item-undetermined`, never
    // covered. A name that occurs whole anywhere (a doc mention, a config key)
    // keeps this tier exactly as before.
    if (requirement.subjectTerms.length > 0 && facetSubjectIdentifiersAbsent(requirement, qualifiedOwners, workspace, cache)) {
      return undefined;
    }
    if (requirement.subjectTerms.length > 0) {
      // WP-C4 (eval-0929 §8 item 2): a VALUE clause naming a concept prefers
      // a module constant whose name carries it, exactly as strongly as it
      // prefers a callable. A CONDITION clause keeps the callable-only anchor
      // (integration ruling): its subject is the deciding callable, whose
      // closure already chases the constants it reads -- a same-named
      // constant as the focal displaced the decider and widened its surface
      // away from its own symbol ("what conditions make a task pack ready"
      // bound MAX_TASK_PACK_BYTES instead of buildTaskExecutionContract).
      return bestConceptAnchoredCandidate(selected, requirement.subjectTerms, workspace, cache, requirement.facet === "value");
    }
    return undefined;
  }
  // flow / callers: a declaration anywhere is the subject, but a callable
  // that only mentions an undeclared name (`record.execution_contract?.state`
  // in some consumer) is not — the pack's own concept-anchored selection
  // comes before it (eval-0927 review: "trace how tl_read_file task_pack builds
  // execution_contract …" made a bench script's reader the flow focal and
  // demanded its body instead of the builder the pack already served).
  let mention: ResolvedFacetFocal | undefined;
  for (const identifier of requirement.subjectIdentifiers) {
    if (qualifiedOwners.has(identifier)) continue;
    // P0-2 (eval-0927 review-r3 #2, tsTwoClassesSameMethod/kotlinFun): see
    // `resolveCallerCandidateForName`'s own doc for the full disambiguation
    // -- only when EVERY same-named declaration genuinely has zero call
    // sites (or none exists at all) does this identifier fall through to
    // the ordinary mention/undetermined path below.
    const { settled, allCandidates, capped } = await resolveCallerCandidateForName(identifier, selected, args, workspace, cache, allowTestPaths, deadline);
    if (settled !== undefined) return settled;
    if (allCandidates.length > 0 && !capped) return allCandidates[0]; // a real declaration exists; every candidate found is legitimately empty
    // P1-7 (eval-0927 review-r4 #7, sixSameNameOneFile): a cap that is STILL
    // hit after widening must never settle for a first-match mention fallback
    // either -- that would just move the same false-empty risk onto whatever
    // sorts first in scan order (the exact P0-2 failure mode this whole
    // function exists to prevent), only now under an identity this pass
    // cannot even verify names `identifier` at all. Try the next named
    // identifier, if any; if none settles, `resolveFacetFocal` returns
    // `undefined` below and the gate discloses `undetermined` honestly.
    if (capped) continue;
    // No declaration of `identifier` exists anywhere this pack can see --
    // the ordinary mention fallback (an unrelated call site's enclosing
    // function, e.g. for an undeclared env-var-style name).
    const found = await findEnclosingCallableForLiteral(identifier, args, workspace, cache);
    mention ??= found?.focal;
  }
  // P0-2 (eval-0927 review-r2 #2, methodManyCallers): every named identifier
  // failed to resolve to its OWN declaration above -- only a MENTION (the
  // enclosing callable of some unrelated call site/reference) is available,
  // and ITS name can differ from the identifier the clause actually asked
  // about entirely (`fetchJson`'s method-shorthand declaration lost the
  // 40-file-cap race to 45 ordinary call sites, and the enclosing function of
  // one of THOSE -- "getA0" -- came back here instead). The same applies to a
  // concept anchor chased only because the identifier search came up empty:
  // it is scored against BODY/NAME term overlap, never against the named
  // identifier. Presenting either as if it answered the named identifier --
  // worse, certifying "0 call sites" under that wrong name -- is exactly what
  // policy item 2 forbids; a candidate whose name matches NONE of the named
  // identifiers is discarded here so the caller falls through to the
  // ordinary "no-focal" -> undetermined path (facetGate.ts) instead.
  const namesAnIdentifier = (focal: ResolvedFacetFocal | undefined): boolean =>
    focal !== undefined && requirement.subjectIdentifiers.some((identifier) => normIdent(focal.name) === normIdent(identifier));
  // P1-8 (eval-0927 review-r3 #8, unicodeCallersTs/cjkCallersEn): tried
  // BEFORE the concept-anchor tier just below, not after -- a WEAK candidate
  // (a bare word sitting in the clause's own identifier slot that
  // `explicitIdentifiersIn` never extracted because it is not code-shaped:
  // lowercase Latin-with-diacritics, a bare CJK word, OR an ordinary all-
  // lowercase no-underscore/no-hump ASCII word like "flush" -- the SAME
  // codeShaped rule rejects all three) is folded into `subjectTerms` too
  // (P1-8's "never dropped from concept terms" rule, see requestFacets.ts),
  // so with `subjectIdentifiers` empty the concept-anchor tier's own
  // permissive accept-anything-when-no-identifier-was-named condition below
  // would otherwise return WHATEVER file happens to score against the weak
  // candidate's bare text (a mention, not the declaration) before this
  // exact tier ever ran. Uses the SAME `resolveCallerCandidateForName`
  // P0-2 disambiguation as the ordinary identifier tier above -- a weak
  // candidate can be declared in several classes/files too (confirmed live:
  // "flush", not code-shaped, only ever reaches resolution through this
  // tier, so without disambiguation here it reproduced the exact P0-2 bug
  // this function exists to fix). An EXACT declaration match is strictly
  // better evidence than a fuzzy name/body score, so it is tried first; a
  // miss here (no declaration of THIS weak candidate anywhere) falls
  // through to the next weak candidate, then to the SAME concept-anchor
  // guess as before, so nothing is lost when no exact declaration exists
  // anywhere.
  if (requirement.subjectIdentifiers.length === 0) {
    for (const candidateWord of requirement.subjectWeakCandidates ?? []) {
      const { settled, allCandidates, capped } = await resolveCallerCandidateForName(candidateWord, selected, args, workspace, cache, allowTestPaths, deadline);
      if (settled !== undefined) return settled;
      if (allCandidates.length > 0 && !capped) return allCandidates[0]; // a real declaration exists; every candidate found is legitimately empty
      // P1-7: capped -- try the next weak candidate rather than settling for
      // an unverified "empty" (see the identifier loop's own comment above).
    }
  }
  if (requirement.subjectTerms.length > 0) {
    // WP-C4 (eval-0929 §8 item 2): `includeValueKinds:false` here — a
    // flow/callers clause's concept anchor stays callable-only, unchanged
    // from before; only the value/condition branch above widens.
    const concept = await bestConceptAnchoredCandidate(selected, requirement.subjectTerms, workspace, cache, false);
    if (concept !== undefined && (requirement.subjectIdentifiers.length === 0 || namesAnIdentifier(concept))) return concept;
  }
  return requirement.subjectIdentifiers.length === 0 || namesAnIdentifier(mention) ? mention : undefined;
}

/**
 * `calleeName`'s declaring file + symbol, following import aliases and
 * re-exports within MAX_REEXPORT_HOPS / MAX_REEXPORT_FILES_TOTAL. Each
 * module carries its own lookup name and the source binding windows.
 * Go is out of `importSpecifiersNaming`'s scope by
 * design (a package import never names an individual binding) -- for a Go
 * focal with no resolving import, sibling `.go` files in the SAME
 * directory are tried instead (real Go same-package visibility).
 *
 * R2-T3 (eval-0929 final review, P0-4's cap ruling): both candidate sources
 * used to be cut at MAX_IMPORT_RESOLVED_FILES_PER_FOCAL (2) files -- the
 * import list at its first two specifiers, the Go package at its first two
 * siblings IN DIRECTORY ORDER -- so a callee declared in the third file was
 * never a callee at all and the closure never read the constants behind it.
 * A Go package is now searched whole (`scanGoPackageSiblings`, bounded by
 * bytes; only files that actually DECLARE `func calleeName` are parsed), and
 * the import list is bounded by the re-export search's own file budget
 * (MAX_REEXPORT_FILES_TOTAL) with only files that mention the name parsed.
 * `onBounded` fires when a Go package could not be read in full and the
 * callee was not found in what was read.
 *
 * Chip 1 (2026-09-27, INT-A): tries `focal`'s OWN file FIRST, same rule
 * `constantClosureForFocal` already applies for the value/condition facets
 * (`findModuleConstantWindow` on `lines` before any import hop) -- a
 * same-module helper or a sibling method of the same class needs no import
 * line to reach, so the callee-resolution mirror of that same-file check was
 * simply missing, and every such callee (the common "focal calls a private
 * helper two lines below it" shape, TS/JS/Python/Go/Java/C#/C/C++ alike)
 * never became a flow callee at all. Still exactly one hop: this is a file
 * the hook already read for `focal` itself, not a new file the closure
 * budget must account for.
 */
/** True when `receiver` is the focal's OWN parameter or local, not the import it shares a name with. */
export function focalShadowsReceiver(bodyLines: readonly string[], receiver: string, hashComment: boolean, focal: ResolvedFacetFocal): boolean {
  return bodyDeclaresLocal(bodyLines, receiver, hashComment)
    || focalParameterNames(bodyLines, hashComment, focal.name, focal.path).has(receiver);
}

export async function resolveCalleeFile(
  calleeName: string,
  focal: ResolvedFacetFocal,
  focalFileLines: readonly string[],
  hashComment: boolean,
  workspace: string,
  cache: FileReadCache,
  onBounded?: () => void,
  /** The receiver of a member call (`tax` in `tax.calculate(x)`); undefined for a bare call. */
  receiver?: string,
): Promise<{ path: string; content: string; name?: string; bindings?: NamedWindow[]; symbol?: { startLine: number; endLine: number } } | undefined> {
  const declaration = async (file: { path: string; content: string }, name: string, bindings: NamedWindow[]) => {
    if (!new RegExp(`(?<![\\w$])${escapeRegExp(name)}(?![\\w$])`).test(file.content)) return undefined;
    const lang = languageForPath(file.path);
    const lines = cachedFileLines(cache, file.path, file.content);
    const parsed = (lang ? await cache.parsedSymbols(file.content, lang, file.path) : null) ?? [];
    const symbol = parsed.find((s) => unqualifiedSymbolTail(s.name) === name
      && symbolIsCallable(s, lines, hasHashComments(file.path)));
    return symbol === undefined ? undefined : { ...file, name, bindings,
      symbol: { startLine: symbol.startLine, endLine: symbol.endLine } };
  };
  const focalContent = readCached(workspace, focal.path, cache);
  // A member call on a module alias keeps its receiver identity: the callee is
  // THAT module's export, never a bare same-named function another receiver
  // (or the focal's own file) owns. A receiver the focal shadows as a parameter
  // or local is never bound to the import of the same name.
  const shadowedReceiver = receiver !== undefined && importedModuleAliasesIn(focalFileLines, hashComment).has(receiver)
    && focalShadowsReceiver(focalFileLines.slice(focal.startLine - 1, focal.endLine), receiver, hashComment, focal);
  const namespaceFile = receiver === undefined || focalContent === undefined
    || !importedModuleAliasesIn(focalFileLines, hashComment).has(receiver) || shadowedReceiver
    ? undefined : await resolveModuleNamespaceFile(receiver, focal.path, focalFileLines, workspace, cache);
  if (focalContent !== undefined) {
    const typedPositions = receiver === undefined ? undefined : calleePositionsIn(
      focalContent.split(/\r?\n/), focal.startLine, focal.endLine, calleeName, hashComment)
      .filter((position) => new RegExp(`(?:^|[^\\w$.])${escapeRegExp(receiver)}\\s*(?:\\?\\.|\\.)\\s*$`, "u")
        .test(maskNonCode(focalContent.split(/\r?\n/)[position.line] ?? "", hashComment).slice(0, position.character)));
    const typed = await resolveTypedCallee({ workspace, source: focalContent, focal, calleeName, hashComment, cacheToken: cache,
      ...(typedPositions !== undefined ? { positions: typedPositions } : {}) });
    if (typed.kind === "resolved") {
      const target = readCached(workspace, typed.path, cache);
      if (target === undefined || contentHash(target) !== typed.contentHash) { onBounded?.(); return undefined; }
      let symbol = typed.symbol;
      {
        // A semantic definition can name a binding or signature. Require an
        // executable callable in the same hash-verified file for every backend;
        // LSP name-only ranges grow to its body without widening the caller.
        const lang = languageForPath(typed.path);
        const targetLines = cachedFileLines(cache, typed.path, target);
        const parsed = (lang ? await cache.parsedSymbols(target, lang, typed.path) : null) ?? [];
        const matches = parsed.filter(candidate => unqualifiedSymbolTail(candidate.name) === typed.name
          && symbolIsCallable(candidate, targetLines, hasHashComments(typed.path))
          // The parser's signature ends at the body when one exists. A method
          // kind alone also covers abstract/extern declarations without a body.
          && (candidate.kind === "const" || candidate.signatureEndIndex < candidate.endIndex)
          && candidate.startLine <= typed.symbol.startLine && candidate.endLine >= typed.symbol.endLine);
        if (matches.length !== 1) { onBounded?.(); return undefined; }
        symbol = { startLine: matches[0]!.startLine, endLine: matches[0]!.endLine };
      }
      return { path: typed.path, content: target, name: typed.name, bindings: [], symbol };
    }
    if (typed.kind === "unresolved") { onBounded?.(); return undefined; }
    if (typed.kind === "external") return undefined;
    if (shadowedReceiver || namespaceFile === "workspace-module-unresolved") { onBounded?.(); return undefined; }
    // An explicit own receiver alias is not an unqualified same-name callable.
    // Without semantic implementation resolution, disclose the unfinished hop.
    for (const position of qualifiedCalleePositionsIn(focalFileLines, focal.startLine, focal.endLine, calleeName, hashComment)) {
      const before = maskNonCode(focalFileLines[position.line]!, hashComment).slice(0, position.character);
      const receiver = /([A-Za-z_$][\w$]*)\s*(?:\?\.|\.)\s*$/.exec(before)?.[1];
      if (receiver === undefined) continue;
      const window = findModuleConstantWindow(focalFileLines, receiver, hashComment);
      if (window === undefined) continue;
      const initializer = focalFileLines.slice(window.start - 1, window.end).map(line => maskNonCode(line, hashComment)).join("\n");
      const alias = new RegExp("(?:^|[,{])\\s*" + escapeRegExp(calleeName) + "\\s*:\\s*[A-Za-z_$][\\w$]*\\s*(?=[,}])");
      if (alias.test(initializer)) { onBounded?.(); return undefined; }
    }
    if (namespaceFile !== undefined) {
      const found = await declaration(namespaceFile, calleeName, []);
      if (found !== undefined) return found;
      // The module is proven and simply does not export the member: a bare
      // same-named function elsewhere is NOT this call's implementation.
      if (path.extname(namespaceFile.path) === path.extname(focal.path)) return undefined;
    }
    const own = await declaration({ path: focal.path, content: focalContent }, calleeName, []);
    if (own !== undefined) return own;
  }
  // Each module carries its own lookup name. A barrel can rename again, so
  // neither the local alias nor a visited file alone identifies a binding.
  let frontier = [{ path: focal.path, lines: focalFileLines, name: calleeName, bindings: [] as NamedWindow[], aliased: false }];
  const visited = new Set([`${focal.path}\0${calleeName}`]);
  let filesVisited = 0;
  for (let hop = 0; hop < MAX_REEXPORT_HOPS && frontier.length > 0; hop++) {
    const next: typeof frontier = [];
    for (const owner of frontier) {
      for (const spec of importSpecifiersNaming(owner.lines, owner.name, owner.path === focal.path ? hashComment : hasHashComments(owner.path), owner.path, true)) {
        const file = await resolveImportSpecifierFile(owner.path, spec, workspace, cache);
        if (file === undefined) continue;
        const name = spec.exportedName ?? owner.name;
        const key = `${file.path}\0${name}`;
        if (visited.has(key)) continue;
        if (filesVisited >= MAX_REEXPORT_FILES_TOTAL) { onBounded?.(); continue; }
        visited.add(key);
        filesVisited++;
        const bindings = spec.binding === undefined ? owner.bindings : [...owner.bindings,
          { path: owner.path, start: spec.binding.start, end: spec.binding.end, name: owner.name, binding: true }];
        const aliased = owner.aliased || spec.exportedName !== undefined;
        const found = await declaration(file, name, bindings);
        if (found !== undefined) return { ...found, bindings: aliased || hop > 0 ? bindings : [] };
        next.push({ path: file.path, lines: cachedFileLines(cache, file.path, file.content), name, bindings, aliased });
      }
    }
    frontier = next;
  }
  if (frontier.length > 0) onBounded?.();
  if (path.extname(focal.path) === ".go") {
    // `posting.Apply(...)` names another package's function. Resolve it
    // through this file's import of that package (go.mod module path ->
    // directory, importResolveGo.ts) before the same-package scan below,
    // which never looked outside the focal's directory and could return an
    // unrelated local `Apply` (2026-10-16 bench: Service.Post's callees).
    const body = focalFileLines.slice(focal.startLine - 1, focal.endLine).map((line) => maskNonCode(line, hashComment)).join("\n");
    for (const edge of resolveGoImports(workspace, focal.path, focalFileLines)) {
      const [qualifier, ...declared] = edge.names;
      if (edge.kind !== "import" || qualifier === undefined || !declared.includes(calleeName)) continue;
      if (!new RegExp(`(?<![\\w$.])${escapeRegExp(qualifier)}\\s*\\.\\s*${escapeRegExp(calleeName)}\\s*\\(`).test(body)) continue;
      const content = readCached(workspace, edge.path, cache);
      if (content === undefined) continue;
      const found = await declaration({ path: edge.path, content }, calleeName, []);
      if (found !== undefined) return found;
    }
    const files: Array<{ path: string; content: string }> = [];
    const declarationRe = new RegExp(`(?:^|\\n)func\\s+(?:\\([^)]*\\)\\s*)?${escapeRegExp(calleeName)}\\s*[(\\[]`);
    const bounded = scanGoPackageSiblings(focal.path, workspace, cache, (relPath, content) => {
      files.push({ path: relPath, content });
      return undefined;
    }, { mightMatch: (content) => declarationRe.test(content) }).bounded;
    for (const file of files) {
      const found = await declaration(file, calleeName, []);
      if (found !== undefined) return found;
    }
    if (bounded) onBounded?.();
  }
  return undefined;
}
