// structureMap — extracted implementation; imports point to the owning modules.
import * as fs from "fs";
import * as path from "path";
import type { AnswerFirstCandidate } from "./answerPackBuilder3.js";
import type { AnswerFirstInput } from "./structureMap2.js";
import type { AnswerStructureMap } from "./answerPackBuilder2.js";
import type { AnswerStructureMapChoice } from "./answerPackBuilder3.js";
import type { ImpactCandidate } from "@tokenlighten/types";
import type { LineWindow } from "./answerPackBuilder2.js";
import type { NamedWindow } from "./callableResolution2.js";
import type { StructureMapFileLayout } from "./answerPackBuilder2.js";
import type { StructureMapMember } from "../structureMap.js";
import type { StructureMapRowNote } from "./structureMap2.js";
import type { StructureMapType } from "../structureMap.js";
import { FileReadCache } from "./packBasics2.js";
import { MAX_SURFACE_CODE_BYTES } from "./packBasics2.js";
import { MAX_TASK_PACK_BYTES_HIGH_CONFIDENCE } from "./packBasics.js";
import { NO_STRUCTURE_MAP } from "./answerPackBuilder3.js";
import { STRUCTURE_MAP_ANSWER_FIRST_MAX_CAP_BYTES } from "./answerPackBuilder3.js";
import { STRUCTURE_MAP_CPP_COUNTERPART_MAX_FILES } from "./answerPackBuilder3.js";
import { STRUCTURE_MAP_CPP_COUNTERPART_MAX_FILE_BYTES } from "./answerPackBuilder3.js";
import { STRUCTURE_MAP_CPP_COUNTERPART_MAX_SCAN_BYTES } from "./answerPackBuilder3.js";
import { STRUCTURE_MAP_ENVELOPE_RESERVE_BYTES } from "./answerPackBuilder3.js";
import { STRUCTURE_MAP_GROUPED_ADMISSION_MARGIN_BYTES } from "./answerPackBuilder3.js";
import { STRUCTURE_MAP_MAX_STATE_TYPES } from "./answerPackBuilder3.js";
import { STRUCTURE_MAP_MIN_MEMBERS } from "../structureMap.js";
import { STRUCTURE_MAP_ROW_ADDRESS_BYTES } from "./answerPackBuilder3.js";
import { STRUCTURE_MAP_STATE_TYPE_MAX_BYTES } from "./answerPackBuilder3.js";
import { STRUCTURE_MAP_UNBATCHED_ADMISSION_MARGIN_BYTES } from "./answerPackBuilder3.js";
import { TASK_PACK_PREVIEW_PREPARED_RESERVE_BYTES } from "../../../protocol/taskPackSizePreview.js";
import { analyzeJavaLoopGuards } from "../../../javaLoopGuardReview.js";
import { answerFirstCover } from "../structureMap.js";
import { answerFirstFacts } from "../answerFirstFacts.js";
import { answerFirstPageProves } from "./structureMap2.js";
import { answerFormFree } from "../structureMap.js";
import { asksForStructureMap } from "../structureMap.js";
import { clampToActiveCeiling } from "./packBasics2.js";
import { coalesceMapRows } from "./structureMap2.js";
import { codeLineWindows } from "./structureMap2.js";
import { composeAnswerFirst } from "../answerFirstFacts.js";
import { cppNamespacePathAt } from "../structureMapMembers.js";
import { cppOutOfLineMembers } from "../structureMapMembers.js";
import { effEvidencePathGroupsEnabled } from "../../../util/flags.js";
import { effMapAnswerFirstEnabled } from "../../../util/flags.js";
import { effStructureMapEnabled } from "../../../util/flags.js";
import { elideDocComments } from "../../../util/formatCompress.js";
import { elideDocCommentsWithWindows } from "../../../util/formatCompress.js";
import { estimateStructureMapReplyBytes } from "./structureMap2.js";
import { explicitCodeIdentifiers } from "./anchorFocus2.js";
import { extractFacetRequirements } from "./packBasics2.js";
import { headerEndOf } from "../structureMap.js";
import { headerTypeNames } from "../structureMap.js";
import { isWalkIgnoredPath } from "../../../tools/walkRepo.js";
import { languageForPath } from "../../../util/languages.js";
import { locateStructureMapStateType } from "./structureMap2.js";
import { measureResponseBytes } from "../../../protocol/budget/measure.js";
import { mergeSpans } from "../structureMap.js";
import { owedMapFilesFitOnePage } from "./structureMap2.js";
import { ownRegionsOf } from "../structureMapMembers.js";
import { packHeldToCeilingWithoutPreview } from "./answerPackBuilder3.js";
import { readCached } from "./packBasics2.js";
import { requiredQueryFacets } from "./changeAndReadinessEvidence2.js";
import { resolveImportsOf } from "../importResolution.js";
import { structureMapCallTerms } from "../structureMap.js";
import { structureMapRows } from "./structureMap2.js";
import { structureMapTypeForPath } from "./structureMap2.js";
import { structureMapTypeOf } from "../structureMap.js";
import { subjectCallableNamesIn } from "../requestFacets.js";
import { unqualifiedSymbolTail } from "./anchorFocus3.js";
import { windowsNotCovered } from "./structureMap2.js";
import { withoutNamedFileArtifacts } from "./structureMap2.js";
import { workspaceBodyPath } from "./packBasics2.js";

export async function structureMapForAnswer(
  query: string,
  candidate: ImpactCandidate | undefined,
  workspace: string,
  cache: FileReadCache,
): Promise<AnswerStructureMapChoice> {
  if (!effStructureMapEnabled() || candidate?.symbol === undefined || !asksForStructureMap(query)) return NO_STRUCTURE_MAP;
  const flows = extractFacetRequirements(query).filter((requirement) => requirement.facet === "flow");
  if (flows.length === 0) return NO_STRUCTURE_MAP;
  const lang = languageForPath(candidate.path);
  const content = readCached(workspace, candidate.path, cache);
  if (!lang || content === undefined) return NO_STRUCTURE_MAP;
  const parsed = await cache.parsedSymbols(content, lang, candidate.path);
  if (!parsed) return NO_STRUCTURE_MAP;
  const bounds = /^(\d+)-(\d+)$/.exec(candidate.range ?? "");
  const lines = content.split(/\r?\n/);
  // Go, Rust, C and C++ types also have the members they declare OUTSIDE their
  // own range (structureMapMembers.ts) — the same file's; a C++ class whose
  // definitions are in the counterpart .cpp, and the Go methods of the package's
  // other files, are the multi-path map of the design's Stage 2 (the latter are
  // disclosed in the reply's advisory: `attachStructureMapElsewhereNote`).
  let type = structureMapTypeOf(
    parsed,
    candidate.path,
    candidate.symbol,
    bounds ? Number(bounds[1]) : candidate.line,
    bounds ? Number(bounds[2]) : candidate.line,
    lines,
    lang,
    lang === "cpp" ? 0 : undefined,
  );
  if (type === undefined) return NO_STRUCTURE_MAP;
  const headerType = type;
  let cppTypeNamespacePath: readonly string[] | undefined;
  let otherMemberFiles: Array<{ path: string; count: number }> = [];
  if (lang === "cpp") {
    const typeSymbol = parsed.find((symbol) =>
      symbol.kind === "class"
      && unqualifiedSymbolTail(symbol.name) === headerType.name
      && symbol.signatureStartLine === headerType.signatureStart);
    const namespacePath = typeSymbol === undefined
      ? undefined
      : Number.isSafeInteger(typeSymbol.signatureStartIndex)
        ? cppNamespacePathAt(lines, typeSymbol.signatureStartLine, typeSymbol.signatureStartIndex)
        : undefined;
    cppTypeNamespacePath = namespacePath;
    if (namespacePath !== undefined) {
      const includeEdges = resolveImportsOf(workspace, headerType.path, content);
      const edgePaths = includeEdges
        .filter((edge) => edge.kind === "counterpart" && edge.path.toLowerCase().endsWith(".cpp"))
        .map((edge) => edge.path);
      const sourceDirs = new Set<string>();
      const pathParts = headerType.path.split("/");
      for (let index = pathParts.length - 2; index >= 0; index -= 1) {
        if (pathParts[index] !== "include" && pathParts[index] !== "inc") continue;
        const sourceName = pathParts[index] === "include" ? "src" : "source";
        sourceDirs.add([...pathParts.slice(0, index), sourceName, ...pathParts.slice(index + 1, -1)].join("/"));
        break;
      }
      sourceDirs.add(headerType.path.slice(0, Math.max(0, headerType.path.lastIndexOf("/"))));
      const boundedSiblingPaths: string[] = [];
      let scanIncomplete = false;
      const orderedSourceDirs = [...sourceDirs].sort();
      for (const [directoryIndex, directory] of orderedSourceDirs.entries()) {
        const absolute = workspaceBodyPath(workspace, directory);
        if (absolute === undefined) continue;
        try {
          const entries = fs.readdirSync(absolute, { withFileTypes: true })
            .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.toLowerCase().endsWith(".cpp"))
            .map((entry) => path.posix.join(directory, entry.name).replace(/^\.\//u, ""))
            .sort();
          const available = Math.max(0, STRUCTURE_MAP_CPP_COUNTERPART_MAX_FILES - boundedSiblingPaths.length);
          if (entries.length > available) scanIncomplete = true;
          boundedSiblingPaths.push(...entries.slice(0, available));
        } catch { scanIncomplete = true; }
        if (boundedSiblingPaths.length >= STRUCTURE_MAP_CPP_COUNTERPART_MAX_FILES) {
          if (directoryIndex + 1 < orderedSourceDirs.length) scanIncomplete = true;
          break;
        }
      }
      const sourcePaths = [...new Set([...edgePaths, ...boundedSiblingPaths])].sort((left, right) =>
        (edgePaths.includes(left) ? 0 : 1) - (edgePaths.includes(right) ? 0 : 1) || left.localeCompare(right));
      let selected: { path: string; members: StructureMapMember[] } | undefined;
      if (sourcePaths.length > STRUCTURE_MAP_CPP_COUNTERPART_MAX_FILES) scanIncomplete = true;
      let inspectedFiles = 0;
      let inspectedBytes = 0;
      for (const sourcePath of sourcePaths.slice(0, STRUCTURE_MAP_CPP_COUNTERPART_MAX_FILES)) {
        if (sourcePath === headerType.path) continue;
        if (isWalkIgnoredPath(workspace, sourcePath, { respectGitignore: true })) {
          scanIncomplete = true;
          continue;
        }
        const sourceAbsolute = workspaceBodyPath(workspace, sourcePath);
        if (sourceAbsolute === undefined) {
          scanIncomplete = true;
          continue;
        }
        let sourceSize: number;
        try {
          const stat = fs.statSync(sourceAbsolute);
          if (!stat.isFile()) { scanIncomplete = true; continue; }
          sourceSize = stat.size;
        } catch { scanIncomplete = true; continue; }
        if (sourceSize > STRUCTURE_MAP_CPP_COUNTERPART_MAX_FILE_BYTES
          || inspectedBytes + sourceSize > STRUCTURE_MAP_CPP_COUNTERPART_MAX_SCAN_BYTES
          || inspectedFiles >= STRUCTURE_MAP_CPP_COUNTERPART_MAX_FILES) {
          scanIncomplete = true;
          continue;
        }
        inspectedFiles += 1;
        inspectedBytes += sourceSize;
        const sourceText = readCached(workspace, sourcePath, cache);
        if (sourceText === undefined || Buffer.byteLength(sourceText, "utf8") > STRUCTURE_MAP_CPP_COUNTERPART_MAX_FILE_BYTES) {
          scanIncomplete = true;
          continue;
        }
        const relatesToHeader = resolveImportsOf(workspace, sourcePath, sourceText).some((edge) => edge.path === headerType.path);
        if (!relatesToHeader) continue;
        const sourceLines = sourceText.split(/\r?\n/u);
        const sourceSymbols = await cache.parsedSymbols(sourceText, "cpp", sourcePath);
        if (sourceSymbols === null) { scanIncomplete = true; continue; }
        const members = cppOutOfLineMembers(headerType.name, { symbols: sourceSymbols, lines: sourceLines }, {
          path: sourcePath,
          namespacePath,
          requireNamespaceMatch: true,
        });
        if (members.length === 0) continue;
        if (selected === undefined) selected = { path: sourcePath, members };
        else otherMemberFiles.push({ path: sourcePath, count: members.length });
      }
      if (scanIncomplete) {
        // An incomplete bounded scan cannot certify that the selected source
        // contains every requested out-of-line member. Keep Stage 1 behavior.
        selected = undefined;
        otherMemberFiles = [];
      }
      if (selected !== undefined) {
        const memberStart = Math.min(...selected.members.map((member) => member.start));
        const memberEnd = Math.max(...selected.members.map((member) => member.end));
        type = {
          ...type,
          members: [...type.members, ...selected.members],
          memberFiles: [{ path: selected.path, start: memberStart, end: memberEnd }],
        };
      }
    }
    if (type.members.length < STRUCTURE_MAP_MIN_MEMBERS) return NO_STRUCTURE_MAP;
  }
  const mapPaths = [type.path, ...(type.memberFiles ?? []).map((file) => file.path)];
  let ownBytes = 0;
  for (const mapPath of mapPaths) {
    const mapType = structureMapTypeForPath(type, mapPath);
    const mapText = mapPath === type.path ? content : readCached(workspace, mapPath, cache);
    if (mapText === undefined) return NO_STRUCTURE_MAP;
    ownBytes += structureMapOwnBytes(mapType, mapText.split(/\r?\n/u), lang);
  }
  if (ownBytes <= MAX_SURFACE_CODE_BYTES) return NO_STRUCTURE_MAP;
  const terms = new Set(structureMapCallTerms(requiredQueryFacets(query), type.name, [], true));
  for (const flow of flows) {
    for (const term of structureMapCallTerms(flow.subjectTerms, type.name, flow.nonPointTerms ?? [])) terms.add(term);
  }
  const capBytes = clampToActiveCeiling(MAX_TASK_PACK_BYTES_HIGH_CONFIDENCE);
  // Under a compact host ceiling, spend the first page on executable
  // structure and state evidence. Explicit documentation requests retain it.
  const includeDoc = capBytes > 20 * 1024 || /\b(?:javadoc|documentation|doc\s*comment|comments?|docstrings?)\b|ドキュメント|説明文|コメント/iu.test(query);
  // What the map REQUIRES of a member the first page does not hold is one of
  // two things (structureMap.ts `StructureMapBodies`): its ROWS — the lines that
  // call a requested concern, the statements that write state, save and audit,
  // the failure handling of external calls, the control lines around them
  // (memberRows.ts) — or, when those rows would not fit ONE continuation page
  // (`owedRowsFitOnePage`), the member's WHOLE body, as every map required
  // before rows existed. What a reply CARRIES (the page selected below) is
  // filled with whole bodies in both, so a member the first page holds is
  // served whole. A Java loop guard's review note needs its loop, guard and
  // call lines served in one window, so those lines are required whole.
  const guards = candidate.path.endsWith(".java") ? (await analyzeJavaLoopGuards(candidate.path, content)) ?? [] : [];
  const anchors = guards.map(guard => ({ start: guard.firstLine, end: guard.lastLine }));
  // …and each such note rides as the `why` of the row that serves its lines (javaLoopGuardReview): bytes the continuation carries.
  const notes: StructureMapRowNote[] = guards.map(guard => ({ start: guard.firstLine, end: guard.lastLine, text: guard.text }));
  const mapFilePaths = [type.path, ...(type.memberFiles ?? []).map((file) => file.path)];
  const mapFiles = mapFilePaths.map((mapPath) => {
    const fileType = structureMapTypeForPath(type, mapPath);
    const text = mapPath === type.path ? content : readCached(workspace, mapPath, cache);
    return { path: mapPath, type: fileType, lines: text?.split(/\r?\n/u) ?? [] };
  });
  if (mapFiles.some((file) => file.lines.length === 0)) return NO_STRUCTURE_MAP;
  const header = { start: type.signatureStart, end: headerEndOf(type) };
  const requiredOf = (
    file: typeof mapFiles[number],
    rows: readonly LineWindow[],
  ): LineWindow[] => {
    const { type: fileType, lines: sourceLines, path: mapPath } = file;
    const isHeader = mapPath === type.path;
    const headerCode: LineWindow[] = [];
    if (isHeader) {
      const elisions = elideDocCommentsWithWindows(sourceLines.slice(header.start - 1, header.end).join("\n"), lang, header.start).elided;
      for (let line = header.start; line <= header.end; line++) {
        if ((sourceLines[line - 1] ?? "").trim() === "" || elisions.some(([start, end]) => start <= line && line <= end)) continue;
        headerCode.push({ start: line, end: line });
      }
    }
    const spans = mergeSpans([
      ...rows,
      ...headerCode,
      ...(fileType.containerHeaders ?? []),
      ...fileType.members.map((member) => ({ start: member.signatureStart, end: member.signatureEnd })),
    ]);
    const code = spans.flatMap((span) => {
      const out: LineWindow[] = [];
      for (let line = span.start; line <= span.end; line++) {
        if ((sourceLines[line - 1] ?? "").trim() !== "") out.push({ start: line, end: line });
      }
      return out;
    });
    const merged = mergeSpans(code);
    return mapPath === type.path ? merged : merged.map((span) => ({ ...span, path: mapPath }));
  };
  const pathWindows = (mapPath: string, windows: readonly LineWindow[]): LineWindow[] =>
    mapPath === type.path ? [...windows] : windows.map((span) => ({ ...span, path: mapPath }));
  const rowsLayouts = mapFiles.map((file) => ({
    file,
    rowsLayout: structureMapRows(file.type, file.lines, [...terms], lang, Number.MAX_SAFE_INTEGER, includeDoc, { bodies: "rows", anchors: file.path === type.path ? anchors : [] }),
  }));
  const rowsWindows = rowsLayouts.flatMap(({ file, rowsLayout }) => requiredOf(file, rowsLayout.rows));
  const wholeWindows = (): LineWindow[] => rowsLayouts.flatMap(({ file }) =>
    requiredOf(file, structureMapRows(file.type, file.lines, [...terms], lang, Number.MAX_SAFE_INTEGER, includeDoc).rows));
  const stateWindows: NamedWindow[] = [];
  const edges = resolveImportsOf(workspace, type.path, content);
  for (const name of headerTypeNames(lines, header, type.name)) {
    if (stateWindows.length >= STRUCTURE_MAP_MAX_STATE_TYPES) break;
    const found = await locateStructureMapStateType(name, lang, edges, workspace, cache, cppTypeNamespacePath, lines, header);
    if (found === undefined || stateWindows.some(window => window.path === found.edge.path)) continue;
    const declarationText = found.text.split(/\r?\n/).slice(found.declaration.startLine - 1, found.declaration.endLine).join("\n");
    if (Buffer.byteLength(declarationText, "utf8") > STRUCTURE_MAP_STATE_TYPE_MAX_BYTES) continue;
    stateWindows.push({ path: found.edge.path, start: found.declaration.startLine, end: found.declaration.endLine, name });
  }
  // Preserve the ordinary full map when it fits. Under a host ceiling, plan
  // a smaller page of atomic map windows instead of abandoning the map and
  // expanding whole member bodies. Required flow windows are still computed
  // from the full type by flowStepWindowsForNonCallableFocal.
  // A smaller source allowance can admit different later windows, so this
  // finite descending search deliberately makes no monotonicity assumption.
  //
  // A builder without an exact wire preview keeps a measured envelope margin
  // and admits only a page holding the full header and every signature. This
  // depends on the builder's sizing behavior, not on a particular client's cap.
  // Once a map has been served, its entire same-query continuation chain is
  // batched; a ceiling too small for the skeleton keeps the whole-member route.
  const heldWithoutPreview = packHeldToCeilingWithoutPreview();
  const skeletons = heldWithoutPreview
    ? mapFiles.map((file) => ({ file, windows: structureMapSkeleton(file.type, file.lines, lang) }))
    : [];
  let ordinary: AnswerStructureMap | undefined;
  for (let sourceBytes = 16_384; sourceBytes >= 2_048; sourceBytes -= 1_024) {
    const fileLayouts = mapFiles.map((file) => {
      const original = structureMapRows(file.type, file.lines, [...terms], lang, sourceBytes, includeDoc);
      const compact = coalesceMapRows(file.type, file.lines, original.rows, original.owed,
        measureResponseBytes(JSON.stringify(file.path)) + STRUCTURE_MAP_ROW_ADDRESS_BYTES);
      const pathify = (spans: readonly LineWindow[]): LineWindow[] => pathWindows(file.path, spans);
      return {
        path: file.path,
        type: file.type,
        rows: pathify(compact.rows),
        owed: pathify(compact.owed),
        requiredWindows: requiredOf(file, compact.rows),
        ...(original.header === undefined ? {} : { header: pathify([original.header])[0] }),
      } satisfies StructureMapFileLayout;
    });
    if (fileLayouts.some((layout) => layout.rows.length === 0)) continue;
    const replyBytes = fileLayouts.reduce((total, layout, index) => {
      const file = mapFiles[index]!;
      return total + estimateStructureMapReplyBytes(
        layout.path,
        file.lines,
        layout.rows,
        layout.owed,
        undefined,
        undefined,
        heldWithoutPreview ? false : effEvidencePathGroupsEnabled(),
        index === 0,
      );
    }, 0) + (heldWithoutPreview
      ? STRUCTURE_MAP_UNBATCHED_ADMISSION_MARGIN_BYTES
      : effEvidencePathGroupsEnabled() ? STRUCTURE_MAP_GROUPED_ADMISSION_MARGIN_BYTES : 0);
    const skeletonFits = skeletons.every(({ file, windows }) => {
      const layout = fileLayouts.find((candidate) => candidate.path === file.path);
      return layout !== undefined && windowsNotCovered(windows, layout.rows).length === 0;
    });
    if (replyBytes <= capBytes && skeletonFits) {
      ordinary = {
        type, terms: [...terms],
        rows: fileLayouts.flatMap((layout) => layout.rows),
        owed: fileLayouts.flatMap((layout) => layout.owed),
        fileLayouts,
        ...(otherMemberFiles.length === 0 ? {} : { otherMemberFiles }),
        stateWindows,
        header,
        requiredWindows: owedMapFilesFitOnePage(mapFiles, rowsLayouts, fileLayouts, capBytes, notes) ? rowsWindows : wholeWindows(),
        replyBytes,
        capBytes,
      };
      break;
    }
  }
  // TL_EFF_MAP_ANSWER_FIRST (default OFF): under a compact host ceiling the map
  // may be the CORE evidence alone, answered at once — but only where the map
  // above would not answer on its first page (a map whose required windows the
  // page holds is `act.answer` today, with more of the type than the core, and
  // is left as it is). Whatever the core cannot be admitted for is the map above.
  // The core is only a CANDIDATE here: the facet requirements of the request
  // decide, in `buildAnswerTaskPack`, whether it is adopted (`answerFirstPageHolds`).
  let answerFirst: AnswerFirstCandidate | undefined;
  if (effMapAnswerFirstEnabled() && type.memberFiles === undefined && capBytes < STRUCTURE_MAP_ANSWER_FIRST_MAX_CAP_BYTES
    && (ordinary === undefined || windowsNotCovered(ordinary.requiredWindows, ordinary.rows).length > 0)) {
    try {
      // The request as answer-first reads it: the type's own file name, spelled in the
      // request, is a file name (not `Owner.member`), and the words that describe the
      // answer's form are no concern (`answerFormFree`). The ordinary map keeps its terms.
      const requirements = withoutNamedFileArtifacts(extractFacetRequirements(query), query, type.path);
      const answerTerms = new Set(structureMapCallTerms(requiredQueryFacets(query), type.name, [], true));
      for (const flow of requirements.filter((requirement) => requirement.facet === "flow")) {
        for (const term of structureMapCallTerms(answerFormFree(flow.subjectTerms), type.name, flow.nonPointTerms ?? [])) answerTerms.add(term);
      }
      const namedMembers = [...explicitCodeIdentifiers(query), ...subjectCallableNamesIn(query), ...requirements.flatMap((requirement) => requirement.subjectCallables ?? [])];
      const map = await answerFirstStructureMap({ query, type, path: candidate.path, lines, lang, terms: [...answerTerms], namedMembers, capBytes, includeDoc, header, stateWindows, workspace, cache, guards });
      if (map !== undefined) answerFirst = { map, requirements };
    } catch {
      // A candidate that cannot be built is no candidate: the request is served as it is without the flag.
    }
  }
  return { ordinary, answerFirst };
}

/**
 * The comment-elided bytes of the lines a type OWNS (`ownRegionsOf`): its whole
 * range when its members are inside it — the figure `structureMapForAnswer` has
 * always judged by — and, for a type with out-of-line members, its declaration
 * and its members only, the code of other types between them not counted.
 */
export function structureMapOwnBytes(type: StructureMapType, lines: readonly string[], lang: string): number {
  const regions = ownRegionsOf(type);
  let bytes = 0;
  for (const [index, region] of regions.entries()) {
    const body = lines.slice(region.start - 1, region.end).join("\n");
    bytes += Buffer.byteLength(elideDocComments(body, lang, region.start), "utf8") + (index > 0 ? 1 : 0);
  }
  return bytes;
}

/**
 * TL_EFF_MAP_ANSWER_FIRST: the structure map as the CORE evidence alone — the
 * header, every member's signature, the state enums and the whole bodies of
 * the members that cover the named concerns (structureMap.ts `coverMembers`) —
 * or undefined when it does not apply to this pack (then the map is planned as
 * it is without the flag).
 *
 * It applies only when the core, as the page ships it, fits the pack's cap with
 * the same headroom a grouped first page keeps
 * (STRUCTURE_MAP_GROUPED_ADMISSION_MARGIN_BYTES) and the room left holds at least
 * the first tier of facts about the bodies it leaves owed. The constructors'
 * bodies are the last thing the page spends bytes on: a plan that keeps them is
 * preferred, and one that gives them up (`constructorsLast`) is taken only when
 * the room it makes lets more of the facts ride. The facts are assembled
 * (answerFirstFacts.ts) here and fitted to the room the finished pack has left
 * when they are attached (`attachAnswerFirstAdvisory`).
 *
 * WHAT A CONCERN CALL IS (the cover, the members the facts list, the call index —
 * one rule for all, structureMap.ts `ConcernCallRule`): a call on one of the type's
 * collaborator fields (`collaboratorFields`: injected, built in the constructor,
 * conventionally declared) when that yields a cover — T03's rule, which names no
 * record accessor on a parameter — and otherwise a call whose receiver chain or callee
 * names a concern, except a data accessor on a parameter or a local of the member
 * (`namedConcernRule`). The members the request NAMES that call a concern are in the
 * cover (`coverMembers` `required`); when the cover cannot hold them all, the core is
 * not an answer to this request and the result is undefined.
 */
export async function answerFirstStructureMap(input: AnswerFirstInput): Promise<AnswerStructureMap | undefined> {
  const { query, type, path: relPath, lines, lang, terms, capBytes, includeDoc, header, stateWindows, workspace, cache, guards } = input;
  const chosen = answerFirstCover(type, lines, terms, input.namedMembers);
  if (chosen === undefined) return undefined;
  const { rule, cover } = chosen;
  // The enum types ride beside the map (`structureMapStateTypeSurfaces`) and are part of the core.
  let stateBytes = 0;
  for (const window of stateWindows) {
    const text = readCached(workspace, window.path, cache);
    if (text === undefined) return undefined;
    stateBytes += estimateStructureMapReplyBytes(window.path, text.split(/\r?\n/), [window], []) - STRUCTURE_MAP_ENVELOPE_RESERVE_BYTES;
  }
  const addressBytes = measureResponseBytes(JSON.stringify(relPath)) + STRUCTURE_MAP_ROW_ADDRESS_BYTES;
  let best: { readonly map: AnswerStructureMap; readonly tiers: number } | undefined;
  for (const constructorsLast of [false, true]) {
    // Giving the constructors up changes nothing for a type with none in its header.
    if (constructorsLast && !type.members.some((member) => member.constructor && member.start <= header.end)) continue;
    const original = structureMapRows(type, lines, terms, lang, Number.MAX_SAFE_INTEGER, includeDoc, { cover, constructorsLast });
    const compact = coalesceMapRows(type, lines, original.rows, original.owed, addressBytes);
    const layout = { ...original, ...compact };
    if (layout.rows.length === 0) continue;
    const replyBytes = estimateStructureMapReplyBytes(relPath, lines, layout.rows, layout.owed);
    if (replyBytes + stateBytes + STRUCTURE_MAP_GROUPED_ADMISSION_MARGIN_BYTES > capBytes) continue;
    const facts = answerFirstFacts({ type, lines, terms, cover, served: layout.rows, guards, lang, rule });
    // The room the facts will have once the pack is built: what the finished pack's size preview (the plan and the
    // reserve it keeps for a decision it already counts) leaves under the ceiling. `attachAnswerFirstAdvisory` then
    // measures the pack with the advisory on it and takes off the end of the facts what does not fit.
    const composed = composeAnswerFirst(facts, capBytes - replyBytes - stateBytes - TASK_PACK_PREVIEW_PREPARED_RESERVE_BYTES);
    // Owed bodies are named, or this is no answer to give first.
    if (facts.notServed.length > 0 && composed.text === "") continue;
    const map: AnswerStructureMap = {
      type, terms: [...terms], ...layout, stateWindows, header,
      requiredWindows: codeLineWindows(lines, layout.rows), replyBytes, capBytes,
      answerFirst: { cover, constructorsLast, facts, estimateBytes: replyBytes + stateBytes },
    };
    // The page has to PROVE what the pack's contract asks of it (`answerFirstPageProves`): a plan that does not is not an answer.
    if (!(await answerFirstPageProves(map, query, workspace, cache))) continue;
    if (best === undefined || composed.tiers > best.tiers) best = { map, tiers: composed.tiers };
  }
  return best?.map;
}

/**
 * The skeleton of `type`: what a page must hold to be its map and not the first
 * slice of its source — the code lines of its header (the declaration, fields,
 * constants and tables, the constructors that wire its collaborators) and of
 * every member's signature, as the planner takes them first and in full on a
 * page with room to spare (`planStructureMap`: no concern term, so no member
 * body, no doc comment, the header as far as STRUCTURE_MAP_HEADER_MAX_BYTES
 * allows, comment blocks the default policy elides left out). A page whose rows
 * hold all of these lines is a map whatever else it carries or leaves owed; a
 * page that holds fewer shows part of a table of contents and owes the rest.
 */
export function structureMapSkeleton(type: StructureMapType, lines: readonly string[], lang: string): LineWindow[] {
  return codeLineWindows(lines, structureMapRows(type, lines, [], lang, Number.MAX_SAFE_INTEGER, false).rows);
}
