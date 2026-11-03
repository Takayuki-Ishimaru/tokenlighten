// facetClosure — extracted implementation; imports point to the owning modules.
import type { AnswerStructureMap } from "./answerPackBuilder2.js";
import type { AskedPathUnresolved } from "../askedPathClosure.js";
import type { AskedPathWindow } from "../askedPathClosure.js";
import type { DocMentionLine } from "../askedPathClosure.js";
import type { FacetPlan } from "../facetGate.js";
import type { FacetRequirement } from "../requestFacets.js";
import type { ImpactCandidate } from "@tokenlighten/types";
import type { QuotedLiteralAbsence } from "../askedPathClosure.js";
import type { ResolvedFacetFocal } from "./callableResolution2.js";
import type { TaskPackArgs } from "../model.js";
import { FileReadCache } from "./packBasics2.js";
import { MAX_ASKED_PATH_BYTES_PER_PACK } from "../askedPathClosure.js";
import { MAX_ASKED_PATH_CALLEE_LINES } from "../askedPathClosure.js";
import { MAX_BASE_CLASS_DEPTH } from "../askedPathClosure.js";
import { MAX_BASE_CLASS_FILES } from "../askedPathClosure.js";
import { MAX_LITERAL_ABSENCE_FILES } from "../askedPathClosure.js";
import { MAX_LITERAL_DOC_MENTIONS } from "../askedPathClosure.js";
import { askedPathPlanFor } from "../askedPathClosure.js";
import { cachedFileLines } from "./constantResolution2.js";
import { classHeaderAbove } from "../askedPathClosure.js";
import { classHeaderNamed } from "../askedPathClosure.js";
import { classifySurface } from "../../../util/impact.js";
import { createScanContentCache } from "../../search/find/findText.js";
import { createScanCoverage } from "../../search/find/findText.js";
import { docMentionLinesIn } from "../askedPathClosure.js";
import { explicitCodeIdentifiers } from "./anchorFocus2.js";
import { findDeclaredCallableAmong } from "./callableResolution3.js";
import { freshAbsenceUniverse } from "./identifierAbsence2.js";
import { hasHashComments } from "../callerExpansion.js";
import { importSpecifiersNaming } from "../evidenceClosure.js";
import { isDocLikePath } from "../askedPathClosure.js";
import { languageForPath } from "../../../util/languages.js";
import { normIdent } from "./createAndWiringEndpoints2.js";
import { quotedLiteralTokensIn } from "../askedPathClosure.js";
import { readCached } from "./packBasics2.js";
import { recordAskedPathPlan } from "../askedPathClosure.js";
import { resolveCallerCandidateForName } from "./callableResolution3.js";
import { resolveImportSpecifierFile } from "./callableResolution4.js";
import { scanLiteral } from "../../search/find/findText.js";
import { scopeCompletenessAfterScan } from "./sourceAndConcernTerms3.js";
import { selfMethodCallsOnPath } from "../askedPathClosure.js";
import { shaOfText } from "../../../util/handles.js";
import { sliceLinesToText } from "../../../util/countLines.js";
import { sourceSpellsLiteral } from "../askedPathClosure.js";
import { symbolIsCallable } from "./focalFlow.js";
import { unqualifiedSymbolTail } from "./anchorFocus3.js";
import { withoutTestDeclarations } from "./callableResolution3.js";

/** Most subjects one facet requirement resolves beside its primary focal (P1-4). */
export const MAX_ADDITIONAL_FACET_SUBJECTS = 3;

/**
 * 2026-10-06 independent review (P1-4): every OTHER subject a requirement
 * names that resolves to its own workspace declaration, beside the primary
 * focal `resolveFacetFocal` settled on. "Explain retryDelay and
 * calculateTotal, including their constants, edge cases, and callers." is ONE
 * callers requirement whose two subjects are both functions; the primary
 * resolution stops at the first identifier that settles, so only retryDelay's
 * callers were planned and the gate certified "callers" with calculateTotal's
 * caller (`checkout`) never served. Exact-declaration tiers only: a name the
 * question carries as data (a constant passed as an argument, an env key)
 * never becomes a focal of its own here, and an ambiguous name is skipped —
 * the primary resolution keeps its own disclosure for that shape.
 */
export async function additionalFacetSubjectFocals(
  requirement: FacetRequirement,
  primary: ResolvedFacetFocal,
  selected: readonly ImpactCandidate[],
  args: TaskPackArgs,
  workspace: string,
  cache: FileReadCache,
  allowTestPaths: boolean,
  deadline: number,
  priorFocalPaths: ReadonlySet<string>,
): Promise<ResolvedFacetFocal[]> {
  const qualifiedOwners = new Set((requirement.qualifiedMembers ?? []).map((pair) => pair.owner));
  const names = new Set([normIdent(primary.name)]);
  const taken = new Set([`${primary.path}\u0000${primary.name}\u0000${primary.startLine}`]);
  const subjects = [...new Set([...(requirement.subjectCallables ?? []), ...requirement.subjectIdentifiers])];
  const out: ResolvedFacetFocal[] = [];
  for (const identifier of subjects) {
    if (out.length >= MAX_ADDITIONAL_FACET_SUBJECTS || Date.now() >= deadline) break;
    if (qualifiedOwners.has(identifier) || names.has(normIdent(identifier))) continue;
    let found: ResolvedFacetFocal | undefined;
    if (requirement.facet === "value" || requirement.facet === "condition") {
      found = await findDeclaredCallableAmong(selected, identifier, args, priorFocalPaths, workspace, cache);
      if (found !== undefined && !allowTestPaths) found = withoutTestDeclarations(found);
    } else {
      const { settled, allCandidates, capped } = await resolveCallerCandidateForName(identifier, selected, args, workspace, cache, allowTestPaths, deadline);
      found = settled ?? (allCandidates.length > 0 && !capped ? allCandidates[0] : undefined);
    }
    if (found === undefined || found.ambiguousWith !== undefined || normIdent(found.name) !== normIdent(identifier)) continue;
    const key = `${found.path}\u0000${found.name}\u0000${found.startLine}`;
    if (taken.has(key)) continue;
    taken.add(key);
    names.add(normIdent(identifier));
    out.push(found);
  }
  return out;
}

/**
 * The flow of a pack that serves the structure map of a type with members outside
 * its range (Go, Rust, C, C++) is the flow OF that type, whatever the resolver
 * would pick for the word the request uses. A request frames such a type by a plain
 * word — "the big Desk struct" — which names no subject identifier (requestFacets.ts
 * reads casing, and `Desk` has none), so the resolver's concept anchor would be a
 * callable whose name or body mentions the concerns, a constructor that merely wires
 * them (`NewDesk`), whose flow is empty — and the map's windows would be required by
 * no facet. And a C struct's name is the NAME of every function whose signature line
 * mentions `struct X` (the parser's habit), so the resolver would settle on one of
 * them. A flow clause that names no subject, or names the type, is given the mapped
 * type as its focal; one that names its own subject (a method, an identifier) keeps
 * the resolver's, as it does for a Java class. Undefined: resolve as always.
 *
 * The focal's range is the type's EXTENT, as a Java class's is its whole range: a
 * mention of the type's name on a line inside it — a Go receiver, a Rust `impl Trait
 * for T {`, a C++ constructor the parser gave no symbol — is the map's to owe (its
 * rows and its owed bodies), not a use of the type elsewhere whose ±12 lines the gate
 * would require, the code of other types between the members included
 * (`sameFileFacetCallSites` skips the focal's own range). A use in ANOTHER file stays
 * one, and is required like any.
 */
export function mapFlowFocal(requirement: FacetRequirement, map: AnswerStructureMap | undefined): ResolvedFacetFocal | undefined {
  if (map === undefined || requirement.facet !== "flow") return undefined;
  if (!map.type.members.some((member) => member.outOfLine === true)) return undefined;
  const named = requirement.subjectIdentifiers;
  if (named.length > 0 && !named.some((identifier) => normIdent(identifier) === normIdent(map.type.name))) return undefined;
  return {
    path: map.type.path,
    name: map.type.name,
    startLine: map.type.start,
    endLine: map.type.end,
    typeName: map.type.name,
    hasRealType: false,
    kind: "type",
  };
}

/**
 * 2026-11 (external A/B of v0.16.4): where a `self.`/`this.` method a served
 * focal body calls is DEFINED — its own class (same file) first, then up the
 * base-class chain through the file's own import lines (askedPathClosure.ts
 * `classHeaderNamed`/`baseClassNamesIn`; `importSpecifiersNaming` +
 * `resolveImportSpecifierFile`, the same resolution every other closure in
 * this file uses). Bounded by MAX_BASE_CLASS_DEPTH hops and
 * MAX_BASE_CLASS_FILES files; `undefined` means "not found in the workspace
 * within those bounds", which the hook discloses, never fills.
 */
export async function resolveSelfMethodDefinition(
  name: string,
  focalPath: string,
  focalLines: readonly string[],
  ownerName: string | undefined,
  workspace: string,
  cache: FileReadCache,
): Promise<{ path: string; startLine: number; endLine: number; resolution: AskedPathWindow["resolution"] } | undefined> {
  const findIn = async (relPath: string, lines: readonly string[], content: string, className: string | undefined) => {
    const lang = languageForPath(relPath);
    if (lang === undefined) return undefined;
    const parsed = (await cache.parsedSymbols(content, lang, relPath)) ?? [];
    const hashComment = hasHashComments(relPath);
    const named = parsed.filter((symbol) => unqualifiedSymbolTail(symbol.name) === name && symbolIsCallable(symbol, lines, hashComment));
    const inClass = className === undefined
      ? named
      : named.filter((symbol) => symbol.enclosingSymbol?.name !== undefined && unqualifiedSymbolTail(symbol.enclosingSymbol.name) === className);
    const pick = (inClass.length > 0 ? inClass : named)[0];
    return pick === undefined ? undefined : { startLine: pick.startLine, endLine: pick.endLine };
  };
  const focalContent = focalLines.join("\n");
  const own = await findIn(focalPath, focalLines, focalContent, ownerName);
  if (own !== undefined) return { path: focalPath, ...own, resolution: "same-class" };
  if (ownerName === undefined) return undefined;
  const visited = new Set<string>([focalPath]);
  let frontier: Array<{ path: string; lines: readonly string[]; content: string; className: string }> = [
    { path: focalPath, lines: focalLines, content: focalContent, className: ownerName },
  ];
  for (let depth = 0; depth < MAX_BASE_CLASS_DEPTH && frontier.length > 0; depth++) {
    const next: typeof frontier = [];
    for (const owner of frontier) {
      const hashComment = hasHashComments(owner.path);
      const header = classHeaderNamed(owner.lines, owner.className, hashComment, owner.path);
      for (const base of header?.bases ?? []) {
        if (classHeaderNamed(owner.lines, base, hashComment, owner.path) !== undefined) {
          const found = await findIn(owner.path, owner.lines, owner.content, base);
          if (found !== undefined) return { path: owner.path, ...found, resolution: `base:${base}` };
          next.push({ ...owner, className: base });
          continue;
        }
        for (const spec of importSpecifiersNaming(owner.lines, base, hashComment, owner.path)) {
          const file = await resolveImportSpecifierFile(owner.path, spec, workspace, cache);
          if (file === undefined || visited.has(file.path)) continue;
          if (visited.size > MAX_BASE_CLASS_FILES) return undefined;
          visited.add(file.path);
          const lines = cachedFileLines(cache, file.path, file.content);
          const found = await findIn(file.path, lines, file.content, base);
          if (found !== undefined) return { path: file.path, ...found, resolution: `base:${base}` };
          next.push({ path: file.path, lines, content: file.content, className: base });
        }
      }
    }
    frontier = next;
  }
  return undefined;
}

/**
 * 2026-11 (external A/B of v0.16.4 — flask `url_for`/`BuildError`, express
 * `res.redirect('back')`; askedPathClosure.ts's header has both cases): the
 * asked-path additions for one answer pack, for the caller to MERGE, under
 * `recoverFacetClosureCandidates`'s contract (a byte budget, one addition per
 * window, never a guess), and the PLAN the readiness stage judges against
 * (`askedPathPlanFor`): the self-method bodies the asked path needs, the ones
 * it could not resolve, and every quoted literal proved absent from source
 * with the doc lines that mention it.
 */
export async function recoverAskedPathCandidates(
  query: string,
  workspace: string,
  cache: FileReadCache,
  selected: readonly ImpactCandidate[],
): Promise<ImpactCandidate[]> {
  const additions: ImpactCandidate[] = [];
  const windows: AskedPathWindow[] = [];
  const unresolved: AskedPathUnresolved[] = [];
  const literalAbsences: QuotedLiteralAbsence[] = [];
  const fileShas: Record<string, string> = {};
  let bytesUsed = 0;
  const noteSha = (relPath: string): void => {
    if (fileShas[relPath] !== undefined) return;
    const content = readCached(workspace, relPath, cache);
    if (content !== undefined) fileShas[relPath] = shaOfText(content);
  };
  const covered = (relPath: string, start: number, end: number): boolean => selected.some((candidate) => {
    if (candidate.path !== relPath) return false;
    const bounds = candidate.range?.match(/^(\d+)-(\d+)$/);
    return bounds !== null && bounds !== undefined && Number(bounds[1]) <= start && end <= Number(bounds[2]);
  });
  const tryAdd = (relPath: string, start: number, end: number, why: string): boolean => {
    const range = `${start}-${end}`;
    if (additions.some((addition) => addition.path === relPath && addition.range === range)) return true;
    const content = readCached(workspace, relPath, cache);
    if (content === undefined) return false;
    const bytes = Buffer.byteLength(sliceLinesToText(content, start, end), "utf8");
    if (bytesUsed + bytes > MAX_ASKED_PATH_BYTES_PER_PACK) return false;
    bytesUsed += bytes;
    additions.push({ path: relPath, line: start, range, surface: classifySurface(relPath), why, confidence: 0.85, callerRange: true });
    return true;
  };

  // (a) the self/this-method the asked path calls.
  const terms = explicitCodeIdentifiers(query).filter((term) => term.length >= 3);
  if (terms.length > 0) {
    for (const candidate of selected.slice(0, 4)) {
      const content = readCached(workspace, candidate.path, cache);
      const lang = languageForPath(candidate.path);
      if (content === undefined || lang === undefined) continue;
      const lines = cachedFileLines(cache, candidate.path, content);
      const hashComment = hasHashComments(candidate.path);
      const parsed = (await cache.parsedSymbols(content, lang, candidate.path)) ?? [];
      const bounds = candidate.range?.match(/^(\d+)-(\d+)$/);
      const anchorLine = bounds ? Number(bounds[1]) : candidate.line;
      const focal = (candidate.symbol !== undefined
        ? parsed.find((symbol) => unqualifiedSymbolTail(symbol.name) === unqualifiedSymbolTail(candidate.symbol!) && symbolIsCallable(symbol, lines, hashComment))
        : undefined)
        ?? parsed.filter((symbol) => symbolIsCallable(symbol, lines, hashComment) && symbol.startLine <= anchorLine && anchorLine <= symbol.endLine)
          .sort((a, b) => b.startLine - a.startLine)[0];
      if (focal === undefined) continue;
      const focalName = unqualifiedSymbolTail(focal.name);
      const calls = selfMethodCallsOnPath(
        lines.slice(focal.startLine - 1, focal.endLine), hashComment,
        terms.filter((term) => normIdent(term) !== normIdent(focalName)), focal.startLine, focalName, candidate.path,
      );
      if (calls.length === 0) continue;
      noteSha(candidate.path);
      const ownerName = focal.enclosingSymbol?.name !== undefined
        ? unqualifiedSymbolTail(focal.enclosingSymbol.name)
        : classHeaderAbove(lines, focal.startLine, hashComment, candidate.path)?.name;
      for (const call of calls) {
        if (windows.some((window) => window.name === call.name)) continue;
        const found = await resolveSelfMethodDefinition(call.name, candidate.path, lines, ownerName, workspace, cache);
        if (found === undefined) {
          unresolved.push({
            name: call.name, focal: focalName, term: call.term,
            reason: `${call.receiver}.${call.name} is called on the ${call.term} path of ${focalName} (${candidate.path}:${call.line}) but its definition was not found in this workspace (a base class outside it, or past the resolution bounds)`,
          });
          continue;
        }
        const end = Math.min(found.endLine, found.startLine + MAX_ASKED_PATH_CALLEE_LINES - 1);
        noteSha(found.path);
        windows.push({ path: found.path, start: found.startLine, end, name: call.name, focal: focalName, term: call.term, resolution: found.resolution });
        if (covered(found.path, found.startLine, end)) continue;
        const where = found.resolution === "same-class" ? "" : `; defined in base class ${found.resolution.slice("base:".length)}`;
        tryAdd(found.path, found.startLine, end, `closure:asked-path callee ${call.name} (of ${focalName}, on the ${call.term} path${where})`);
      }
    }
  }

  // (b) a quoted literal the source no longer spells.
  const literals = quotedLiteralTokensIn(query);
  if (literals.length > 0) {
    const universe = freshAbsenceUniverse(workspace);
    if (universe !== undefined && universe.files.length <= MAX_LITERAL_ABSENCE_FILES) {
      const contentCache = createScanContentCache();
      for (const literal of literals) {
        const coverage = createScanCoverage();
        const hits = scanLiteral(literal, workspace, { caseInsensitive: false, files: universe.files, contentCache, coverage });
        let spelled = false;
        const mentions: DocMentionLine[] = [];
        const seenPaths = new Set<string>();
        for (const hit of hits) {
          if (seenPaths.has(hit.path)) continue;
          seenPaths.add(hit.path);
          const content = readCached(workspace, hit.path, cache);
          if (content === undefined) { spelled = true; break; } // unreadable: never a proven absence
          const lines = cachedFileLines(cache, hit.path, content);
          if (isDocLikePath(hit.path)) {
            mentions.push(...docMentionLinesIn(hit.path, lines, literal));
            continue;
          }
          if (sourceSpellsLiteral(lines, literal, hasHashComments(hit.path), hit.path)) { spelled = true; break; }
        }
        if (spelled) continue;
        const { scopeComplete, omittedCount } = scopeCompletenessAfterScan(universe, coverage);
        const picked = mentions
          .sort((a, b) => Number(b.changelog) - Number(a.changelog))
          .slice(0, MAX_LITERAL_DOC_MENTIONS);
        literalAbsences.push({ term: literal, scopeComplete, omittedCount, scannedFiles: universe.files.length, docMentions: picked });
        for (const mention of picked) {
          noteSha(mention.path);
          if (covered(mention.path, mention.line, mention.line)) continue;
          tryAdd(mention.path, mention.line, mention.line, `${mention.changelog ? "changelog" : "doc"} mention of quoted literal '${literal}' (absent from every source file${scopeComplete ? "" : "; scope incomplete"})`);
        }
      }
    }
  }

  if (windows.length > 0 || unresolved.length > 0 || literalAbsences.length > 0) {
    recordAskedPathPlan(workspace, { query, windows, unresolved, literalAbsences, fileShas });
  }
  return additions;
}

/** The asked-path plan recorded for this workspace+query, still valid (no named file changed). */
export function currentAskedPathPlan(workspace: string | undefined, query: string) {
  if (workspace === undefined) return undefined;
  return askedPathPlanFor(workspace, query, (relPath) => {
    const content = readCached(workspace, relPath);
    return content === undefined ? undefined : shaOfText(content);
  });
}

/**
 * TL_EFF_MAP_ANSWER_FIRST: the dry run of the facet hook that decides whether an
 * answer-first page is adopted (`recoverFacetClosureCandidates`' `trial`). It is the real
 * hook run on COPIES of the selection (a requirement widens a candidate in place, and
 * the next requirement is planned against the widened one — the copies keep that
 * sequence, and the closure budget, exactly as the real run has them): it computes what
 * the real hook computes — the focal of each requirement, its windows and call sites,
 * the windows it serves — but changes none of the pack's candidates, does not count as a
 * run of the hook and records no plan, so the ordinary request that follows it (when the
 * page is not adopted) runs on the state a request without the flag would have.
 */
export interface FacetClosureTrial {
  readonly served: Array<{ path: string; start: number; end: number }>;
  plan?: FacetPlan;
}

/**
 * Verified-absent identifiers ride OUTSIDE the wire envelope: the readiness
 * obligation builder consults this map to upgrade its uncovered reason to
 * decision-grade absence. WeakMap keyed by the result object so trim/dedupe
 * passes that mutate-in-place keep the association and clones simply lose it
 * (graceful: the reason falls back to the generic wording).
 */
export const verifiedAbsentIdentifiersByResult = new WeakMap<object, readonly string[]>();
