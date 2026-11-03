// structureMap — extracted implementation; imports point to the owning modules.
import * as fs from "fs";
import * as path from "path";
import type { AnswerStructureMap } from "./answerPackBuilder2.js";
import type { FacetPlanEntry } from "../facetGate.js";
import type { FacetRequirement } from "../requestFacets.js";
import type { LineWindow } from "./answerPackBuilder2.js";
import type { NamedWindow } from "./callableResolution2.js";
import type { StructureMapFileLayout } from "./answerPackBuilder2.js";
import type { StructureMapPlanOptions } from "../structureMap.js";
import type { StructureMapType } from "../structureMap.js";
import type { TaskPackSurface } from "../model.js";
import { BEHAVIOR_QUERY_RE } from "./changeAndReadinessEvidence2.js";
import { FileReadCache } from "./packBasics2.js";
import { STRUCTURE_MAP_CPP_COUNTERPART_MAX_FILES } from "./answerPackBuilder3.js";
import { STRUCTURE_MAP_CPP_COUNTERPART_MAX_FILE_BYTES } from "./answerPackBuilder3.js";
import { STRUCTURE_MAP_CPP_COUNTERPART_MAX_SCAN_BYTES } from "./answerPackBuilder3.js";
import { STRUCTURE_MAP_ENVELOPE_RESERVE_BYTES } from "./answerPackBuilder3.js";
import { STRUCTURE_MAP_FIT_MARGIN_BYTES } from "./answerPackBuilder3.js";
import { STRUCTURE_MAP_MAX_OWED_WINDOWS } from "./answerPackBuilder3.js";
import { STRUCTURE_MAP_MAX_STATE_TYPES } from "./answerPackBuilder3.js";
import { STRUCTURE_MAP_OWED_ROW_ADDRESS_BYTES } from "./answerPackBuilder3.js";
import { STRUCTURE_MAP_OWED_ROW_HANDLE } from "./answerPackBuilder3.js";
import { STRUCTURE_MAP_OWED_ROW_ROLE } from "./answerPackBuilder3.js";
import { STRUCTURE_MAP_ROW_ADDRESS_BYTES } from "./answerPackBuilder3.js";
import { STRUCTURE_MAP_STATE_TYPE_MAX_BYTES } from "./answerPackBuilder3.js";
import { callableBodiesNotShown } from "./changeAndReadinessEvidence.js";
import { candidateToSurface } from "./surfaceMaterialization.js";
import { classifySurface } from "../../../util/impact.js";
import { coalesceAnswerRows } from "../coalesceAnswerRows.js";
import { cppHeaderHasSafeUnqualifiedTypeReference } from "../structureMapMembers.js";
import { cppNamespacePathAt } from "../structureMapMembers.js";
import { effEvidencePathGroupsEnabled } from "../../../util/flags.js";
import { elideDocCommentsWithWindows } from "../../../util/formatCompress.js";
import { escapeRegExp } from "../../search/find/findText.js";
import { estimateAnswerBody } from "../../../protocol/answerBodyPolicy.js";
import { exactIdentifierEvidence } from "./changeAndReadinessEvidence.js";
import { explicitCodeIdentifiers } from "./anchorFocus2.js";
import { hasCallableBody } from "./changeAndReadinessEvidence2.js";
import { languageForPath } from "../../../util/languages.js";
import { maskCommentsAndStrings } from "../sfCodeMask.js";
import { measureResponseBytes } from "../../../protocol/budget/measure.js";
import { mergeSpans } from "../structureMap.js";
import { ownLinesBridge } from "../structureMapMembers.js";
import { planStructureMap } from "../structureMap.js";
import { protocolCallContext } from "../../../protocol/envelope.js";
import { readCached } from "./packBasics2.js";
import { recordAppendedWindow } from "./answerCertificates2.js";
import { requiredQueryFacets } from "./changeAndReadinessEvidence2.js";
import { resolveImportsOf } from "../importResolution.js";
import { surfaceContainsFacet } from "./changeAndReadinessEvidence2.js";
import { unqualifiedSymbolTail } from "./anchorFocus3.js";
import { workspaceBodyPath } from "./packBasics2.js";

/** `coalesceAnswerRows` over a type's rows: the lines between two rows ride along only when they are the type's own (structureMapMembers.ts `ownLinesBridge`), never the code of another type. */
export function coalesceMapRows(
  type: StructureMapType,
  lines: readonly string[],
  rows: readonly LineWindow[],
  owed: readonly LineWindow[],
  addressBytes: number,
): { rows: LineWindow[]; owed: LineWindow[] } {
  return coalesceAnswerRows(lines, rows, owed, addressBytes, undefined, ownLinesBridge(type, lines));
}

export interface AnswerFirstInput {
  readonly query: string;
  readonly type: StructureMapType;
  readonly path: string;
  readonly lines: readonly string[];
  readonly lang: string;
  readonly terms: readonly string[];
  /** The names the request writes for callables and code identifiers: the members of the type among them are the ones it names (`membersNamed`). */
  readonly namedMembers: readonly string[];
  readonly capBytes: number;
  readonly includeDoc: boolean;
  readonly header: LineWindow;
  readonly stateWindows: readonly NamedWindow[];
  readonly workspace: string;
  readonly cache: FileReadCache;
  readonly guards: readonly { readonly firstLine: number; readonly lastLine: number; readonly text: string }[];
}

/**
 * TL_EFF_MAP_ANSWER_FIRST: whether the pack's CONTRACT will find what it asks of the page `map`
 * serves, before the pack is built. The facet plan is one thing the page must hold
 * (`answerFirstPageHolds`); the readiness obligations are the others, and a page that
 * fails one is shipped as a discover, not as the answer — the reply a request without
 * the flag would never have been given:
 *
 *   `identifier:X`   each code identifier the request names (the first six, as the
 *                    contract takes them) is present in what the page serves, or the
 *                    file is named for it;
 *   `behavior-body`  for a question about behavior (`BEHAVIOR_QUERY_RE`), the page is
 *                    callable evidence that carries every concern the request lists
 *                    (`requiredQueryFacets`) and shows a line of the body of every
 *                    callable the request names that is declared in the file. A
 *                    constructor is named like its class: a page that serves its
 *                    signature and none of its body (the constructors-last plan of
 *                    a type whose constructor is one line) leaves `behavior-body`
 *                    open — `callable evidence shows the declaration of X but no
 *                    line of its body` — which is the finding of the ceiling sweep.
 *
 * The page is rendered as the pack renders it (`renderStructureMapSurface`) into a
 * surface that is never built, booked or sent, and the contract's own functions
 * (`hasCallableBody`, `callableBodiesNotShown`, `exactIdentifierEvidence`) are asked.
 */
export async function answerFirstPageProves(map: AnswerStructureMap, query: string, workspace: string, cache: FileReadCache): Promise<boolean> {
  const page = { role: "domain", handle: "h0000000000", path: map.type.path, range: "", symbol: map.type.name, required: true } as TaskPackSurface;
  if (!renderStructureMapSurface(page, map, workspace, cache)) return false;
  const served: TaskPackSurface[] = [page];
  for (const window of map.stateWindows) {
    const text = readCached(workspace, window.path, cache);
    if (text === undefined) return false;
    served.push({ role: "domain", handle: "h0000000000", path: window.path, range: `${window.start}-${window.end}`, symbol: window.name, code: text.split(/\r?\n/).slice(window.start - 1, window.end).join("\n") } as TaskPackSurface);
  }
  for (const identifier of explicitCodeIdentifiers(query).slice(0, 6)) {
    if (exactIdentifierEvidence(served, identifier).length === 0) return false;
  }
  if (!BEHAVIOR_QUERY_RE.test(query)) return true;
  if (!hasCallableBody(page)) return false;
  if (requiredQueryFacets(query).some((facet) => !surfaceContainsFacet(page, facet))) return false;
  return (callableBodiesNotShown([page], served, query, workspace, "named") ?? []).length === 0;
}

/**
 * The non-blank lines of `spans` as one-line windows, as `structureMapForAnswer`
 * writes its required windows: trailing whitespace can be trimmed from a
 * displayed row, so a blank line is not independent evidence to require.
 */
export function codeLineWindows(lines: readonly string[], spans: readonly LineWindow[]): LineWindow[] {
  const code: LineWindow[] = [];
  for (const span of mergeSpans(spans)) {
    for (let line = span.start; line <= span.end; line++) {
      if ((lines[line - 1] ?? "").trim() !== "") code.push({ start: line, end: line });
    }
  }
  return code;
}

/**
 * TL_EFF_MAP_ANSWER_FIRST: `requirements` as answer-first plans them — the type's OWN
 * file name, written in the request (`OrderOrchestrator (OrderOrchestrator.java) っていう…`,
 * `OrderOrchestrator.java の OrderOrchestrator クラスについて…`, `… class (in
 * OrderOrchestrator.java) …`), is a file name and not two words of the question.
 *
 * Why it matters (the root cause of the file-name finding of the 2026-10-24
 * generality audit): requestFacets.ts reads `Stem.ext` as the qualified member `ext`
 * of an owner `Stem` (`qualifiedMemberPairsIn`; only a path of three segments or more is
 * stripped as a path) and adds `ext` to the clause's concern terms. `resolveFacetFocal`
 * then looks for a member `java` of `OrderOrchestrator`, finds none, and — the P0-1 rule,
 * "a class is never the subject of a facet that names one of its members" — leaves the
 * owner out of every identifier tier. The flow facet's focal falls through to the
 * concept and mention tiers and settles on the callable that carries the class's name,
 * its CONSTRUCTOR (144-162), whose flow is the callees of the constructor, not the
 * structure map. Without the flag that plan is met by the ordinary map's page (one
 * act.answer that serves fewer rows of the type than the same request without the file
 * name); under answer-first the page is the CORE, which does not hold what that plan
 * requires: `missing-evidence` on `request-item:facet-1:flow` and `facet-2:flow`, a
 * discover, and a second reply of 1.8 KB that serves the constructor body (153-162).
 * The default path's behavior for a request that names a file is unchanged here (the
 * flag-unset reply of such a request is what it was); this function only keeps
 * answer-first from inheriting the plan, by planning against the requirements of the
 * same request without the file name: the pair `Stem.ext` is dropped, and so is the term
 * `ext` unless the request uses that word elsewhere.
 */
export function withoutNamedFileArtifacts(requirements: readonly FacetRequirement[], query: string, typePath: string): FacetRequirement[] {
  const base = path.posix.basename(typePath.replace(/\\/g, "/"));
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return [...requirements];
  const stem = base.slice(0, dot);
  const extension = base.slice(dot + 1);
  const nameRe = new RegExp(`(?<![A-Za-z0-9_$])${escapeRegExp(base)}(?![A-Za-z0-9_$])`, "gu");
  if (!nameRe.test(query)) return [...requirements];
  const rest = query.replace(nameRe, " ");
  const extensionStaysAWord = new RegExp(`(?<![A-Za-z0-9_$])${escapeRegExp(extension)}(?![A-Za-z0-9_$])`, "iu").test(rest);
  return requirements.map((requirement) => {
    const pairs = requirement.qualifiedMembers ?? [];
    const kept = pairs.filter((pair) => !(pair.owner === stem && pair.member === extension));
    const terms = extensionStaysAWord ? requirement.subjectTerms : requirement.subjectTerms.filter((term) => term.toLowerCase() !== extension.toLowerCase());
    if (kept.length === pairs.length && terms.length === requirement.subjectTerms.length) return requirement;
    return { ...requirement, qualifiedMembers: kept, subjectTerms: terms };
  });
}

/** What `answerFirstPageHolds` found. */
export interface AnswerFirstVerdict {
  readonly holds: boolean;
  /** `path:start-end` of each window the planned facets require (or would serve) that the answer-first page does not hold; or the reason there is no plan to judge. */
  readonly outside: readonly string[];
}

/** The facet plans recorded under an answer-first decision (true: adopted, the plan of the core; false: the ordinary map's): a replay that finds the plan still valid decides as the first call did. */
export const answerFirstPlanDecisions = new WeakMap<object, boolean>();

/**
 * TL_EFF_MAP_ANSWER_FIRST: whether the FIRST PAGE of the answer-first map `map` — the
 * rows of the type's file and the enum declarations beside them — holds everything the
 * facet plan (`entries`: what the hook recorded, or would record, for the request planned
 * against `map`) requires, and everything the hook would serve (`wouldServe`). When it
 * does, the page can be the answer; when a flow facet requires a window anywhere else (a
 * call site of the type in a top-level function of the same file or in another file, the
 * callees of a member the core does not hold, a constant another facet reads, the focal
 * of a second subject) the reply that holds the core alone would be a discover, and the
 * chain after it would run under the core's requirements instead of the ordinary map's:
 * a silent relaxation. Then the request is served the ordinary map, as it is without the
 * flag. The page must also be the plan of a flow over the type (an entry whose focal is
 * the mapped type); without one, the map was planned for a question this plan does not ask.
 *
 * A window is held when it lies inside one row (`map.rows`, the lines the page serves) of
 * the type's file, or inside a state window (the enum declaration served beside the
 * map). Exported for mapAnswerFirst.spec.ts.
 */
export function answerFirstPageHolds(
  map: { readonly type: { readonly path: string; readonly name: string }; readonly rows: readonly LineWindow[]; readonly stateWindows: readonly NamedWindow[] },
  entries: readonly FacetPlanEntry[],
  wouldServe: readonly { readonly path: string; readonly start: number; readonly end: number }[] = [],
  /** The source lines of a file: a focal is required without the blank and comment-only lines at its ends (facetGate.ts `focalRequiredSpan`). */
  fileLines: (windowPath: string) => readonly string[] | undefined = () => undefined,
): AnswerFirstVerdict {
  const held = (windowPath: string, start: number, end: number): boolean =>
    (windowPath === map.type.path && windowsNotCovered([{ start, end }], map.rows).length === 0)
    || map.stateWindows.some((window) => window.path === windowPath && window.start <= start && end <= window.end);
  const outside: string[] = [];
  const note = (windowPath: string, start: number, end: number): void => {
    if (!held(windowPath, start, end)) outside.push(`${windowPath}:${start}-${end}`);
  };
  let flowOverType = false;
  for (const entry of entries) {
    const focal = entry.focal;
    const ofType = focal !== undefined && focal.path === map.type.path && focal.name === map.type.name;
    if (ofType && entry.facet === "flow") flowOverType = true;
    // The focal of any other subject is required (whole, when short enough) by the gate, unless the facet asks for its callers: it has to be on the page too.
    if (focal !== undefined && !ofType && entry.resolution === "resolved" && entry.facet !== "callers") {
      const source = fileLines(focal.path);
      let first = focal.start;
      let last = focal.end;
      const noise = (line: number): boolean => /^(?:$|\/\/|#|\/\*|\*|""")/u.test((source?.[line - 1] ?? "x").trim());
      while (source !== undefined && first < last && noise(first)) first += 1;
      while (source !== undefined && last > first && noise(last)) last -= 1;
      note(focal.path, first, last);
    }
    for (const window of entry.windows) note(window.path, window.start, window.end);
    for (const site of entry.callSites ?? []) note(site.path, site.line, site.line);
    for (const mention of entry.unclassifiedMentions ?? []) note(mention.path, mention.line, mention.line);
  }
  for (const window of wouldServe) note(window.path, window.start, window.end);
  if (!flowOverType) outside.push("(no flow facet planned over the mapped type)");
  return { holds: outside.length === 0, outside };
}

/**
 * The rows that serve `type`'s structure map (structureMap.ts
 * `planStructureMap`), each the verbatim source of its own range so the
 * answer-line gutter numbers it and sourceFidelity.ts leaves it whole: the
 * type's own doc comment is one row as written, and every other window is
 * split at the comment blocks the default comment policy elides, which stay
 * owed beside the planner's remainder.
 */
export function structureMapTypeForPath(type: StructureMapType, relPath: string): StructureMapType {
  const members = type.members.filter((member) => (member.path ?? type.path) === relPath);
  if (relPath === type.path) return { ...type, members };
  const extent = type.memberFiles?.find((file) => file.path === relPath);
  if (extent === undefined) return { ...type, path: relPath, members: [] };
  const { containerHeaders: _containerHeaders, ...withoutContainerHeaders } = type;
  return {
    ...withoutContainerHeaders,
    path: relPath,
    start: extent.start,
    end: extent.end,
    signatureStart: extent.start,
    signatureEnd: extent.start - 1,
    declarationEnd: extent.start - 1,
    docStart: extent.start,
    members,
  };
}

export function structureMapRows(
  type: StructureMapType,
  lines: readonly string[],
  terms: readonly string[],
  lang: string,
  maxSourceBytes?: number,
  includeDoc = true,
  options?: StructureMapPlanOptions,
): { rows: LineWindow[]; owed: LineWindow[]; header?: LineWindow } {
  const plan = planStructureMap(type, lines, terms, maxSourceBytes, includeDoc, options);
  const docRows: LineWindow[] = [];
  const codeRows: LineWindow[] = [];
  const owed: LineWindow[] = [...plan.remaining];
  for (const window of plan.windows) {
    if (window.kind === "doc") {
      docRows.push({ start: window.start, end: window.end });
      continue;
    }
    let cursor = window.start;
    const text = lines.slice(window.start - 1, window.end).join("\n");
    for (const [blockStart, blockEnd] of elideDocCommentsWithWindows(text, lang, window.start).elided) {
      if (blockStart > cursor) codeRows.push({ start: cursor, end: blockStart - 1 });
      owed.push({ start: blockStart, end: blockEnd });
      cursor = blockEnd + 1;
    }
    if (cursor <= window.end) codeRows.push({ start: cursor, end: window.end });
  }
  const header = plan.windows.find((window) => window.kind === "header");
  // Nearby control labels and calls cost less as one source row than as many
  // addressed rows. Preserve the intervening original lines too; remove them
  // from the owed set so the wire and served ledger describe the same bytes.
  let compactRows: LineWindow[] = [];
  // Rows (a member the first page does not hold, owed as the lines that call a
  // concern and decide whether it runs) are many small windows, each of which
  // is addressed on the wire by its path, handle and range: lines between two
  // of them ride along when their serialized bytes cost less than that address.
  if (options?.bodies === "rows") {
    compactRows = coalesceMapRows(type, lines, mergeSpans(codeRows), [],
      measureResponseBytes(JSON.stringify(type.path)) + STRUCTURE_MAP_OWED_ROW_ADDRESS_BYTES).rows;
  } else for (const row of mergeSpans(codeRows)) {
    const previous = compactRows[compactRows.length - 1];
    const sameMember = previous && type.members.some(member =>
      member.signatureStart <= previous.start && row.end <= member.end);
    const sameHeader = previous && header && header.start <= previous.start && row.end <= header.end;
    if (previous && row.start - previous.end <= 3 && row.end - previous.start < 64 && (sameMember || sameHeader)) {
      compactRows[compactRows.length - 1] = { start: previous.start, end: row.end };
    } else compactRows.push(row);
  }
  const rows = [...docRows, ...compactRows].sort((left, right) => left.start - right.start);
  const unserved = owed.flatMap(span => {
    const gaps: LineWindow[] = [];
    let cursor = span.start;
    for (const row of rows) {
      if (row.end < cursor || row.start > span.end) continue;
      if (row.start > cursor) gaps.push({ start: cursor, end: row.start - 1 });
      cursor = Math.max(cursor, row.end + 1);
    }
    if (cursor <= span.end) gaps.push({ start: cursor, end: span.end });
    return gaps;
  });
  return {
    rows,
    owed: unserved.sort((left, right) => left.start - right.start),
    ...(header === undefined ? {} : { header: { start: header.start, end: header.end } }),
  };
}

/**
 * An upper bound on the reply bytes a structure map needs: every row's
 * JSON-escaped body as the answer-line gutter numbers it, its path and
 * addressing, the owed list, and STRUCTURE_MAP_ENVELOPE_RESERVE_BYTES for the
 * rest of the envelope.
 *
 * Under TL_EFF_EVIDENCE_PATH_GROUPS (2026-10-23) it prices the rows as they
 * ship: the rows are consecutive rows of one file, so only the first pays its
 * path, and a later row also leaves off its handle when the rows are the
 * windows of one surface (the numeric `rowAddressBytes` form: a structure map
 * and its appended windows share one handle). The owed rows of a continuation
 * (`"owed-row"`) are a surface each and keep their handles. With the flag off
 * every row pays both, as before. The estimate is not an upper bound of the pack
 * built from it (T03: the pack outweighed its estimate by up to 320 B), which
 * the first page's admission covers with STRUCTURE_MAP_GROUPED_ADMISSION_MARGIN_BYTES
 * (`structureMapForAnswer`).
 */
export function estimateStructureMapReplyBytes(
  relPath: string,
  lines: readonly string[],
  rows: readonly LineWindow[],
  owed: readonly LineWindow[],
  /**
   * What a row costs beside its path and body: a number of bytes, or "owed-row" to read it off the row as a
   * continuation serializes it (`{"handle":"h…","path":"","range":"a-b","body":"","role":"…"},`, with this
   * row's own range and the longest role), so that a wide range or a long role cannot be undercounted.
   */
  rowAddressBytes: number | "owed-row" = STRUCTURE_MAP_ROW_ADDRESS_BYTES,
  /** Review notes that ride as the `why` of a row holding the lines they name (a Java loop guard's); each is counted on every row that holds its lines. */
  notes: readonly StructureMapRowNote[] = [],
  /** Whether the rows are priced as they ship grouped (TL_EFF_EVIDENCE_PATH_GROUPS). False prices the internal result a builder without the size preview measures, which is never grouped. */
  grouped: boolean = effEvidencePathGroupsEnabled(),
  /** A multi-file map has one response envelope total, not one reserve per source path. */
  includeEnvelopeReserve = true,
): number {
  // One Class-C pre-shed admission measurement (wireBudgetG8Fence.spec.ts):
  // it decides whether the map is built at all, before any response exists.
  const wireJsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");
  const pathBytes = wireJsonBytes(relPath);
  // `"path":` and its comma, and `"handle":"h…",`, as a row that leaves them off no longer pays.
  const pathKeyBytes = wireJsonBytes({ path: "" }) - 4 + 1;
  const handlePairBytes = wireJsonBytes({ handle: STRUCTURE_MAP_OWED_ROW_HANDLE }) - 2 + 1;
  // The quotes of the skeleton's empty path and body are counted with the real ones; the comma goes between rows.
  const addressOf = (row: LineWindow, later: boolean): number => {
    if (rowAddressBytes !== "owed-row") return rowAddressBytes - (later ? pathKeyBytes + handlePairBytes : 0);
    const skeleton = { handle: STRUCTURE_MAP_OWED_ROW_HANDLE, ...(later ? {} : { path: "" }), range: `${row.start}-${row.end}`, body: "", role: STRUCTURE_MAP_OWED_ROW_ROLE };
    return wireJsonBytes(skeleton) - (later ? 2 : 4) + 1;
  };
  const noted = (row: LineWindow): number => notes.reduce((sum, note) =>
    note.start >= row.start && note.end <= row.end ? sum + wireJsonBytes(note.text) + ",\"why\":".length : sum, 0);
  let bytes = (includeEnvelopeReserve ? STRUCTURE_MAP_ENVELOPE_RESERVE_BYTES : 0)
    + wireJsonBytes(owed.map((window) => `${window.start}-${window.end}`));
  rows.forEach((row, index) => {
    const later = grouped && index > 0;
    const numbered = estimateAnswerBody(lines.slice(row.start - 1, row.end), row.start, protocolCallContext()?.clientId);
    bytes += wireJsonBytes(numbered) + (later ? 0 : pathBytes) + addressOf(row, later) + noted(row);
  });
  return bytes;
}

/** A review note and the lines it is about: it rides as `why` on a row that holds all of them. */
export interface StructureMapRowNote {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** The parts of `windows` that no span of `covering` (sorted by start) holds. */
export function windowsNotCovered(windows: readonly LineWindow[], covering: readonly LineWindow[]): LineWindow[] {
  const out: LineWindow[] = [];
  for (const window of windows) {
    let cursor = window.start;
    for (const span of covering) {
      if (span.end < cursor || span.start > window.end) continue;
      if (span.start > cursor) out.push({ start: cursor, end: span.start - 1 });
      cursor = Math.max(cursor, span.end + 1);
    }
    if (cursor <= window.end) out.push({ start: cursor, end: window.end });
  }
  return out;
}

/**
 * Whether `owed`, the rows of the members the first page does not hold, are
 * ONE continuation page: at most STRUCTURE_MAP_MAX_OWED_WINDOWS windows (the
 * most a read call's `next` compacts to a cursor, readCallContinuation.ts), and
 * a reply — each window as its own addressed surface, beside the envelope of the
 * act.answer that closes the chain — that stays under `capBytes`, the cap the
 * first page was admitted under, with STRUCTURE_MAP_FIT_MARGIN_BYTES to spare
 * (the same estimate, with each owed row's address read off its serialization
 * and the `why` of a loop guard's review note counted on the row that holds
 * the guard). When they are
 * more, the members are owed whole, exactly as before rows existed: the
 * planner's own whole bodies, no options. Exported for owedRowsFit.spec.ts.
 */
export function owedRowsFitOnePage(
  relPath: string,
  lines: readonly string[],
  owed: readonly { readonly start: number; readonly end: number }[],
  capBytes: number,
  /** The review notes (a Java loop guard's, ~200 B each) that ride as `why` on the owed rows holding the lines they name. */
  notes: readonly StructureMapRowNote[] = [],
): boolean {
  if (owed.length === 0) return true;
  if (owed.length > STRUCTURE_MAP_MAX_OWED_WINDOWS) return false;
  return estimateStructureMapReplyBytes(relPath, lines, owed, [], "owed-row", notes) + STRUCTURE_MAP_FIT_MARGIN_BYTES <= capBytes;
}

/** Whether every uncovered row of a multi-file map can ride one continuation reply. */
export function owedMapFilesFitOnePage(
  files: readonly { readonly path: string; readonly lines: readonly string[] }[],
  planned: readonly { readonly rowsLayout: { readonly rows: readonly LineWindow[] } }[],
  layouts: readonly StructureMapFileLayout[],
  capBytes: number,
  notes: readonly StructureMapRowNote[],
): boolean {
  const owed = files.map((file, index) => {
    const layout = layouts.find((candidate) => candidate.path === file.path);
    return layout === undefined ? [] : windowsNotCovered(planned[index]?.rowsLayout.rows ?? [], layout.rows);
  });
  const windowCount = owed.reduce((count, windows) => count + windows.length, 0);
  if (windowCount > STRUCTURE_MAP_MAX_OWED_WINDOWS) return false;
  if (windowCount === 0) return true;
  let bytes = STRUCTURE_MAP_ENVELOPE_RESERVE_BYTES + STRUCTURE_MAP_FIT_MARGIN_BYTES;
  for (const [index, file] of files.entries()) {
    const windows = owed[index] ?? [];
    if (windows.length === 0) continue;
    bytes += estimateStructureMapReplyBytes(
      file.path,
      file.lines,
      windows,
      [],
      "owed-row",
      index === 0 ? notes : [],
    ) - STRUCTURE_MAP_ENVELOPE_RESERVE_BYTES;
    if (bytes > capBytes) return false;
  }
  return bytes <= capBytes;
}

/**
 * Re-renders `surface`, the primary answer surface, as `map`'s structure map:
 * its first row is the head, every later row ships as its own row on the same
 * handle (`appended_windows`), `range` spans the type from the head, and
 * `remaining_ranges` lists every line of it no row serves — so the served
 * ledger (`packServedSpans`), the facet gate and the wire all read exactly
 * the map's lines. False when `surface` is not the mapped type's.
 */
export function renderStructureMapSurface(
  surface: TaskPackSurface,
  map: AnswerStructureMap,
  workspace: string,
  cache: FileReadCache,
): boolean {
  const layout = map.fileLayouts?.find((file) => file.path === surface.path)
    ?? (surface.path === map.type.path ? { type: map.type, rows: map.rows, owed: map.owed } : undefined);
  if (layout === undefined) return false;
  const content = readCached(workspace, surface.path, cache);
  const head = layout.rows[0];
  if (content === undefined || head === undefined) return false;
  const lines = content.split(/\r?\n/);
  const text = (span: LineWindow): string => lines.slice(span.start - 1, span.end).join("\n");
  delete surface.appended_windows;
  let code = text(head);
  for (const row of layout.rows.slice(1)) {
    const range = `${row.start}-${row.end}`;
    const marker = `\n\n/* structure map (${range}) */\n`;
    code += marker + text(row);
    recordAppendedWindow(surface, marker, range);
  }
  surface.code = code;
  surface.range = `${head.start}-${layout.type.end}`;
  // The map is the answer's primary evidence, and the code-bearing tier it was
  // admitted under (`structureMapForAnswer`) is the one a required surface
  // gives the pack (`rawCapForResult`).
  surface.required = true;
  const remaining = layout.owed
    .filter((span) => span.end >= head.start)
    .map((span) => `${Math.max(span.start, head.start)}-${span.end}`);
  if (remaining.length > 0) {
    surface.remaining_ranges = remaining;
    surface.content_completeness = "partial";
  } else {
    delete surface.remaining_ranges;
    delete surface.content_completeness;
  }
  delete surface.outline;
  return true;
}

/** Resolve a named imported enum; C++ include inference is separately namespace-proven and bounded. */
export async function locateStructureMapStateType(
  name: string,
  sourceLanguage: string,
  edges: ReturnType<typeof resolveImportsOf>,
  workspace: string,
  cache: FileReadCache,
  expectedCppNamespace?: readonly string[],
  headerLines?: readonly string[],
  header?: LineWindow,
) {
  const named = edges.find((edge) => edge.names.includes(name));
  if (sourceLanguage !== "cpp") {
    // Keep the existing named-import path unchanged for Java, TypeScript,
    // Python and C#: no C++ discovery limits or lexical fallback apply there.
    if (named === undefined) return undefined;
    const language = languageForPath(named.path);
    const text = readCached(workspace, named.path, cache);
    if (!language || text === undefined) return undefined;
    const declaration = (await cache.parsedSymbols(text, language, named.path))
      ?.find((symbol) => symbol.kind === "enum" && unqualifiedSymbolTail(symbol.name) === name);
    return declaration === undefined ? undefined : { edge: named, declaration, text };
  }

  if (expectedCppNamespace === undefined || expectedCppNamespace.includes("")
    || headerLines === undefined || header === undefined
    || !cppHeaderHasSafeUnqualifiedTypeReference(headerLines, header.start, header.end, name)) return undefined;
  const candidates = edges.filter((edge) => edge.kind === "include" && /\.(?:h|hh|hpp|hxx)$/iu.test(edge.path));
  if (candidates.length > STRUCTURE_MAP_CPP_COUNTERPART_MAX_FILES) return undefined;
  let inspectedBytes = 0;
  const matches: Array<{ edge: (typeof candidates)[number]; declaration: { kind: string; startLine: number; endLine: number; signatureStartIndex?: number }; text: string }> = [];
  for (const edge of candidates) {
    const absolute = workspaceBodyPath(workspace, edge.path);
    if (absolute === undefined) return undefined;
    let size: number;
    try {
      const stat = fs.statSync(absolute);
      if (!stat.isFile()) return undefined;
      size = stat.size;
    } catch { return undefined; }
    if (size > STRUCTURE_MAP_CPP_COUNTERPART_MAX_FILE_BYTES
      || inspectedBytes + size > STRUCTURE_MAP_CPP_COUNTERPART_MAX_SCAN_BYTES) return undefined;
    inspectedBytes += size;
    const language = languageForPath(edge.path);
    const text = readCached(workspace, edge.path, cache);
    if (language === undefined || text === undefined
      || Buffer.byteLength(text, "utf8") > STRUCTURE_MAP_CPP_COUNTERPART_MAX_FILE_BYTES) return undefined;
    const symbols = await cache.parsedSymbols(text, language, edge.path);
    if (symbols === null) return undefined;
    const parsed = symbols.find((symbol) => symbol.kind === "enum" && unqualifiedSymbolTail(symbol.name) === name);
    const declaration = parsed !== undefined && Number.isSafeInteger(parsed.signatureStartIndex)
      ? { kind: "enum", startLine: parsed.startLine, endLine: parsed.endLine, signatureStartIndex: parsed.signatureStartIndex }
      : language === "cpp" ? cppEnumLineRange(text, name) : undefined;
    if (declaration === undefined || declaration.signatureStartIndex === undefined) continue;
    const declarationNamespace = cppNamespacePathAt(
      text.split(/\r?\n/u), declaration.startLine, declaration.signatureStartIndex,
    );
    if (declarationNamespace !== undefined
      && declarationNamespace.length === expectedCppNamespace.length
      && declarationNamespace.every((part, index) => part === expectedCppNamespace[index])) {
      matches.push({ edge, declaration, text });
    }
  }
  return matches.length === 1 ? matches[0] : undefined;
}

/** C++ enum declarations are not emitted by the current symbol collector. */
export function cppEnumLineRange(text: string, name: string): { readonly kind: "enum"; readonly startLine: number; readonly endLine: number; readonly signatureStartIndex: number } | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const masked = maskCommentsAndStrings(text);
  const matcher = new RegExp(`\\benum\\s+(?:(?:class|struct)\\s+)?${escaped}\\s*(?::\\s*[^{};]+)?\\s*\\{`, "gu");
  const matches = [...masked.matchAll(matcher)];
  if (matches.length !== 1) return undefined;
  const match = matches[0]!;
  const open = match.index + match[0].lastIndexOf("{");
  let depth = 0;
  let close = -1;
  for (let index = open; index < masked.length; index += 1) {
    if (masked[index] === "{") depth += 1;
    else if (masked[index] === "}" && --depth === 0) { close = index; break; }
  }
  if (close < 0) return undefined;
  const startLine = text.slice(0, match.index).split("\n").length;
  const endLine = text.slice(0, close).split("\n").length;
  return { kind: "enum", startLine, endLine, signatureStartIndex: match.index };
}

export async function structureMapMemberSurfaces(
  map: AnswerStructureMap,
  query: string,
  workspace: string,
  cache: FileReadCache,
): Promise<TaskPackSurface[]> {
  const out: TaskPackSurface[] = [];
  for (const file of map.fileLayouts ?? []) {
    if (file.path === map.type.path) continue;
    const surface = await candidateToSurface({
      path: file.path,
      line: file.type.start,
      range: `${file.type.start}-${file.type.end}`,
      symbol: map.type.name,
      surface: classifySurface(file.path),
      why: "answer-structure-map-members",
      confidence: 0.9,
    }, workspace, [], query, cache, { answerProfile: true });
    if (renderStructureMapSurface(surface, map, workspace, cache)) out.push(surface);
  }
  return out;
}

/**
 * The workspace enum declarations `map`'s header is typed in — the state a
 * transition table maps (`Map<OrderStatus, Set<OrderStatus>>`) — as surfaces
 * to serve beside the map: most-named first, found through the type file's
 * own imports and same-package references (importResolution.ts, never a
 * workspace-wide name search), each whole and at most
 * STRUCTURE_MAP_STATE_TYPE_MAX_BYTES, at most STRUCTURE_MAP_MAX_STATE_TYPES,
 * only while the reply stays under the cap the map was admitted under, and
 * none for a file `existing` already serves.
 */
export async function structureMapStateTypeSurfaces(
  map: AnswerStructureMap,
  query: string,
  workspace: string,
  cache: FileReadCache,
  existing: readonly TaskPackSurface[],
): Promise<TaskPackSurface[]> {
  const content = readCached(workspace, map.type.path, cache);
  if (content === undefined || map.header === undefined) return [];
  const edges = resolveImportsOf(workspace, map.type.path, content);
  let allowance = map.capBytes - map.replyBytes;
  const out: TaskPackSurface[] = [];
  for (const declarationWindow of map.stateWindows) {
    if (out.length >= STRUCTURE_MAP_MAX_STATE_TYPES) break;
    const edge = edges.find((candidate) => candidate.path === declarationWindow.path);
    if (edge === undefined || out.some((surface) => surface.path === edge.path)) continue;
    const alreadyServed = existing.find(surface => surface.path === edge.path);
    if (alreadyServed !== undefined) {
      alreadyServed.why = "answer-structure-map-state-type";
      continue;
    }
    const text = readCached(workspace, edge.path, cache);
    if (text === undefined) continue;
    const declaration = { startLine: declarationWindow.start, endLine: declarationWindow.end };
    const declarationLines = text.split(/\r?\n/);
    const declarationText = declarationLines.slice(declaration.startLine - 1, declaration.endLine).join("\n");
    if (Buffer.byteLength(declarationText, "utf8") > STRUCTURE_MAP_STATE_TYPE_MAX_BYTES) continue;
    const cost = estimateStructureMapReplyBytes(edge.path, declarationLines, [{ start: declaration.startLine, end: declaration.endLine }], [])
      - STRUCTURE_MAP_ENVELOPE_RESERVE_BYTES;
    if (cost > allowance) continue;
    const surface = await candidateToSurface({
      path: edge.path,
      line: declaration.startLine,
      range: `${declaration.startLine}-${declaration.endLine}`,
      symbol: declarationWindow.name,
      surface: classifySurface(edge.path),
      why: "answer-structure-map-state-type",
      confidence: 0.9,
    }, workspace, [], query, cache, { answerProfile: true });
    if (typeof surface.code !== "string" || surface.code.length === 0) continue;
    surface.required = false;
    allowance -= cost;
    out.push(surface);
  }
  return out;
}
