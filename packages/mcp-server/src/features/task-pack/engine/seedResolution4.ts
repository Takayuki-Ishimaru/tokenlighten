// seedResolution — extracted implementation; imports point to the owning modules.
import type { SeededCoverageSurface } from "../concernRecovery.js";
import type { TaskPackSurface } from "../model.js";
import { FileReadCache } from "./packBasics2.js";
import { LISTED_ITEM_DERIVED_WHY } from "../listedScopeItems.js";
import { LISTED_ITEM_SCAN_MAX_FILES } from "./seedResolution2.js";
import { LISTED_ITEM_WHY_MAX_CHARS } from "./seedResolution2.js";
import { LISTED_ITEM_WINDOW_MAX_LINES } from "./seedResolution2.js";
import { MAX_SURFACES_DISTINCT } from "./packBasics2.js";
import { candidateToSurface } from "./surfaceMaterialization.js";
import { captureAuxiliaryEnumCandidate } from "../auxiliaryEnumContextIntegration.js";
import { classifySurface } from "../../../util/impact.js";
import { clauseCoverageTokenSet } from "../concernRecovery.js";
import { collectNeighbourWords } from "../concernRecovery.js";
import { containsJapanese } from "../../retrieval/jaQueryBridge.js";
import { distinctMatchedTokenCount } from "../concernRecovery.js";
import { enclosingDeclaration } from "../listedScopeItems.js";
import { enumNamesDeclaredWith } from "../listedScopeItems.js";
import { extractEnumValueTokens } from "./createAndWiringEndpoints2.js";
import { hasServedCode } from "./wiringEvidence2.js";
import { isClauseCoveredBySeededSurfaces } from "../concernRecovery.js";
import { isEnumLikeQuery } from "../../../util/queryShape.js";
import { isTestConcernPath } from "./literalAndConcernSeeds.js";
import { jaBridgeExpansionTokens } from "../../retrieval/queryRecoveryTerms.js";
import { listedScopeItems } from "../listedScopeItems.js";
import { readCached } from "./packBasics2.js";
import { surfaceBodyCoversRange } from "./seedResolution.js";
import { tokenizeQuery as tokenizeQueryForDiversification } from "../../retrieval/tokenize.js";
import { vocabularyStemNeighbours } from "../../retrieval/queryRecoveryTerms.js";
import { walkCodeFiles } from "../../../tools/walkRepo.js";
import { wholeEnumAccessor } from "../listedScopeItems.js";

/**
 * Listed scope items (2026-10-19, v016 decision 6t-4 T09 rep 1; the case is in
 * listedScopeItems.ts). Every place the request lists must map to a served
 * surface, judged by the seeded packs' own clause-coverage test
 * (`isClauseCoveredBySeededSurfaces`, JA bridge words included). For an item
 * nothing covers, a value-addition request looks for the one window that
 * discharges it: a line inside a declaration the item names that enumerates
 * the extended enum as a whole, so the new value reaches it without an edit
 * (T09: `IssueCreateSchema`'s `priority: z.enum(Object.values(IssuePriority)
 * ...)`). That window is appended as a review-only row (`LISTED_ITEM_DERIVED_WHY`,
 * which `writeAuthorityVeto` keeps out of the edit frontier). Returns the rows
 * it added, the items left uncovered, and the words of those items no served
 * surface carries.
 */
export async function accountForListedScopeItems(
  query: string,
  surfaces: TaskPackSurface[],
  workspace: string,
  scopeDir: string,
  cache: FileReadCache,
): Promise<{ added: TaskPackSurface[]; uncovered: string[]; unmatchedTokens: string[] }> {
  const added: TaskPackSurface[] = [];
  const uncovered: string[] = [];
  const unmatchedTokens: string[] = [];
  const items = listedScopeItems(query);
  if (items.length === 0) return { added, uncovered, unmatchedTokens };
  const values = new Set(extractEnumValueTokens(query));
  const enumNames = isEnumLikeQuery(query)
    ? [...new Set(surfaces.flatMap((surface) =>
        surface.role === "contract" && surface.code !== undefined ? enumNamesDeclaredWith(surface.code, values) : []))]
    : [];
  for (const item of items) {
    const tokens = listedItemTokens(item, workspace);
    const covered = isClauseCoveredBySeededSurfaces(tokens, seededCoverageView(surfaces), tokenizeQueryForDiversification);
    const row = enumNames.length > 0 && new Set(surfaces.map(surface => surface.path)).size < MAX_SURFACES_DISTINCT
      ? await enumDerivedItemSurface(item, tokens, enumNames, surfaces, workspace, scopeDir, query, cache, covered)
      : undefined;
    if (row !== undefined) {
      surfaces.push(row);
      added.push(row);
      continue;
    }
    if (covered) continue;
    uncovered.push(item);
    for (const word of unservedItemWords(item, tokens, surfaces)) {
      if (!unmatchedTokens.includes(word)) unmatchedTokens.push(word);
    }
  }
  return { added, uncovered, unmatchedTokens: unmatchedTokens.slice(0, 4) };
}

/** A listed item's coverage tokens, built the way the seeded clause recovery builds a clause's. */
export function listedItemTokens(item: string, workspace: string): Set<string> {
  const isJapanese = containsJapanese(item);
  const base = clauseCoverageTokenSet(item, tokenizeQueryForDiversification, isJapanese ? jaBridgeExpansionTokens(item, workspace) : []);
  const stemExtras = isJapanese ? [] : collectNeighbourWords(base, (token) => vocabularyStemNeighbours(token, workspace));
  return stemExtras.length > 0 ? new Set([...base, ...stemExtras]) : base;
}

export function seededCoverageView(surfaces: readonly TaskPackSurface[]): SeededCoverageSurface[] {
  return surfaces.map((surface) => ({
    path: surface.path,
    symbol: surface.symbol,
    bodyText: surface.code,
    isDocSurface: surface.role === "doc",
  }));
}

/**
 * The latin words of a listed item that no served surface's path, symbol or
 * body carries: the item's own words before its bridge words, longest first.
 */
export function unservedItemWords(item: string, tokens: ReadonlySet<string>, surfaces: readonly TaskPackSurface[]): string[] {
  const served = new Set(surfaces.flatMap((surface) =>
    tokenizeQueryForDiversification(`${surface.path.replace(/[\\/]/gu, " ")} ${surface.symbol ?? ""} ${surface.code ?? ""}`)
      .map((token) => token.toLowerCase())));
  const written = new Set(tokenizeQueryForDiversification(item).map((token) => token.toLowerCase()));
  const words = [...tokens].filter((token) => /^[a-z][a-z0-9_]{2,}$/u.test(token) && !served.has(token));
  const longestFirst = (a: string, b: string): number => b.length - a.length;
  return [
    ...words.filter((word) => written.has(word)).sort(longestFirst),
    ...words.filter((word) => !written.has(word)).sort(longestFirst),
  ];
}

/**
 * The one window that discharges a listed item, or undefined: the best line in
 * the pack's root that enumerates an extended enum as a whole
 * (`wholeEnumAccessor`), whose path or enclosing declaration the item's own
 * words name (the >=2-token / long-token test `isClauseCoveredBySeededSurfaces`
 * applies to a path and symbol), outside every served window and every test or
 * doc file. A name the declaration carries outranks a word of its path.
 */
export async function enumDerivedItemSurface(
  item: string,
  tokens: ReadonlySet<string>,
  enumNames: readonly string[],
  surfaces: readonly TaskPackSurface[],
  workspace: string,
  scopeDir: string,
  query: string,
  cache: FileReadCache,
  covered = false,
): Promise<TaskPackSurface | undefined> {
  let best: { path: string; line: number; accessor: string; declaration: { name: string; line: number } | undefined; score: number } | undefined;
  const files = walkCodeFiles(workspace, scopeDir !== "" ? { subPath: scopeDir } : {});
  for (const file of files.slice(0, LISTED_ITEM_SCAN_MAX_FILES)) {
    const role = classifySurface(file.relPath);
    if (role === "test" || role === "doc" || isTestConcernPath(file.relPath)) continue;
    const content = readCached(workspace, file.relPath, cache);
    if (content === undefined || !enumNames.some((name) => content.includes(name))) continue;
    // Reuse the bounded existing scan before item/declaration scoring discards
    // unrelated-to-this-clause consumers. AST binding/use analysis remains the
    // later source-context admission gate; a lexical hit grants no authority.
    captureAuxiliaryEnumCandidate(cache, workspace, query, file.relPath, enumNames);
    const lines = content.split(/\r?\n/u);
    for (let index = 0; index < lines.length; index++) {
      const accessor = enumNames.map((name) => wholeEnumAccessor(lines[index]!, name)).find((text) => text !== undefined);
      if (accessor === undefined || lineServedBy(surfaces, file.relPath, index + 1)) continue;
      const declaration = enclosingDeclaration(lines, index);
      // Replacing loose existing coverage needs a declaration-specific proof;
      // shared directory words alone must not consume the bounded file slot.
      if (covered && (declaration === undefined || distinctMatchedTokenCount(tokens,
        {path: "", symbol: declaration.name}, tokenizeQueryForDiversification) < 2)) continue;
      const site = { path: file.relPath, ...(declaration !== undefined ? { symbol: declaration.name } : {}) };
      if (!isClauseCoveredBySeededSurfaces(tokens, [site], tokenizeQueryForDiversification)) continue;
      const score = 2 * (declaration !== undefined
        ? distinctMatchedTokenCount(tokens, { path: "", symbol: declaration.name }, tokenizeQueryForDiversification)
        : 0)
        + distinctMatchedTokenCount(tokens, { path: file.relPath.replace(/[\\/]/gu, " ") }, tokenizeQueryForDiversification);
      if (best === undefined || score > best.score) best = { path: file.relPath, line: index + 1, accessor, declaration, score };
    }
  }
  if (best === undefined) return undefined;
  const start = best.declaration !== undefined && best.line - best.declaration.line < LISTED_ITEM_WINDOW_MAX_LINES
    ? best.declaration.line
    : best.line;
  const surface = await candidateToSurface({
    path: best.path,
    line: best.line,
    range: `${start}-${best.line}`,
    callerRange: true,
    ...(best.declaration !== undefined ? { symbol: best.declaration.name } : {}),
    surface: classifySurface(best.path, best.declaration?.name),
    why: `${LISTED_ITEM_DERIVED_WHY}: ${best.accessor} takes the new value, no edit needed (listed item: ${item.slice(0, LISTED_ITEM_WHY_MAX_CHARS)})`,
    confidence: 1,
  }, workspace, [], query, cache);
  // Review-only: the role-based edit guidance candidateToSurface derives from
  // an enum-like query ("add the value to ...") would say the opposite.
  delete surface.edit_intent;
  delete surface.done_check;
  surface.required = false;
  return hasServedCode(surface) ? surface : undefined;
}

export function lineServedBy(surfaces: readonly TaskPackSurface[], relPath: string, line: number): boolean {
  return surfaces.some((surface) =>
    surface.path === relPath && surfaceBodyCoversRange(surface, `${line}-${line}`));
}
