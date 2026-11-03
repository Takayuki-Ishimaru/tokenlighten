// focalFlow — extracted implementation; imports point to the owning modules.
import * as path from "path";
import type { AnswerStructureMap } from "./answerPackBuilder2.js";
import type { CollectedSymbol } from "../../../symbols/collectSymbols.js";
import type { EditContextSpan } from "./focalFlow.js";
import type { FacetCallSite } from "../facetGate.js";
import type { FacetMentionLine } from "../facetGate.js";
import type { FacetRequirement } from "../requestFacets.js";
import type { ImpactCandidate } from "@tokenlighten/types";
import type { MentionCommentLineState } from "./callerExpansion2.js";
import type { NamedWindow } from "./callableResolution2.js";
import type { ResolvedFacetFocal } from "./callableResolution2.js";
import type { StructureMapMember } from "../structureMap.js";
import type { TaskPackSurface } from "../model.js";
import { ASCII_WORD_MEMBER_RE } from "./callerExpansion3.js";
import { CALLER_EXPANSION_CALLABLE_KINDS } from "./callerExpansion2.js";
import { DEFAULT_RESPONSE_BYTE_FLOOR } from "../../../tools/readCodeModes.js";
import { EDIT_CONTEXT_WHOLE_FILE_BYTES } from "./focalFlow.js";
import { EDIT_CONTEXT_WHY } from "./focalFlow.js";
import { FileReadCache } from "./packBasics2.js";
import { HIGH_CONFIDENCE_THRESHOLD } from "./packBasics2.js";
import { MAX_CALLEES_PER_REQUIREMENT } from "../evidenceClosure.js";
import { MAX_EDIT_CONTEXT_BYTES } from "./focalFlow.js";
import { MAX_EDIT_CONTEXT_WINDOWS } from "./focalFlow.js";
import { MAX_FLOW_CALLEE_DEPTH } from "./focalFlow.js";
import { MAX_NESTED_CALLEE_NAMES_SCANNED } from "./focalFlow.js";
import { MAX_REQUIRED_CALLEE_WINDOWS } from "../evidenceClosure.js";
import { MAX_SCANNED_CALLEE_NAMES } from "../evidenceClosure.js";
import { MAX_SURFACES_DISTINCT } from "./packBasics2.js";
import { MAX_UNCLASSIFIED_MENTION_LINES } from "../facetGate.js";
import { blockCommentLineStates } from "../callerExpansion.js";
import { bodyDeclaresLocal } from "./constantResolution3.js";
import { boundedCallerWindow } from "../callerExpansion.js";
import { cachedFileLines } from "./constantResolution2.js";
import { callSiteOccurrenceIsDeclaration } from "./callerExpansion2.js";
import { calleeTargetsIn } from "../evidenceClosure.js";
import { candidateToSurface } from "./surfaceMaterialization.js";
import { constantClosureForFocal } from "./constantClosure.js";
import { countLines } from "../../../util/countLines.js";
import { declarationIsCallable } from "../evidenceClosure.js";
import { declarationSpans } from "./focalFlow.js";
import { editContextEnabled } from "../../../util/flags.js";
import { editContextWhy } from "./focalFlow.js";
import { escapeRegExp } from "../../search/find/findText.js";
import { explicitCodeIdentifiers } from "./anchorFocus2.js";
import { findCallOccurrences } from "../callerExpansion.js";
import { goCalledMethodWindows } from "./focalFlow.js";
import { goPackageTypeWindows } from "./focalFlow.js";
import { goQualifiedDeclarationWindows } from "./focalFlow.js";
import { goTestInvokesFocal } from "../../../util/goVerification.js";
import { hasHashComments } from "../callerExpansion.js";
import { hasServedCode } from "./wiringEvidence2.js";
import { hasUnboundBareCallee } from "../evidenceClosure.js";
import { importSpecifiersNaming } from "../evidenceClosure.js";
import { isCallerMentionOnlyFile } from "./callerExpansion3.js";
import { languageForPath } from "../../../util/languages.js";
import { lineSpanBytes } from "./focalFlow.js";
import { maskNonCode } from "../callerExpansion.js";
import { measureResponseBytes } from "../../../protocol/budget/measure.js";
import { memberOnlyInCommentText } from "./callerExpansion2.js";
import { mentionExplainedByImportExport } from "./callerExpansion2.js";
import { mentionLineLooksLikeDeclaration } from "./callerExpansion2.js";
import { mergeEditContextSpans } from "./focalFlow.js";
import { normIdent } from "./createAndWiringEndpoints2.js";
import { normalizeCallerIdent } from "../callerExpansion.js";
import { packByteCeilingStorage } from "./packBasics.js";
import { parseSurfaceSpan } from "./packState2.js";
import { readCached } from "./packBasics2.js";
import { resolveCalleeFile } from "./callableResolution3.js";
import { resolveModuleNamespaceFile } from "./constantClosure2.js";
import { samePackageGoTest } from "../../../util/goVerification.js";
import { symbolIsCallable } from "./focalFlow.js";
import { unqualifiedSymbolTail } from "./anchorFocus3.js";
import { walkCodeFiles } from "../../../tools/walkRepo.js";

export async function augmentEditContextSurfaces(
  surfaces: TaskPackSurface[],
  query: string,
  workspace: string,
  requiredRoles: string[],
  cache: FileReadCache,
  includeTests = false,
): Promise<void> {
  // A pack already holding MAX_SURFACES_DISTINCT surfaces takes none; one with
  // room takes every window editContextCandidates returns, which bounds them
  // itself (MAX_EDIT_CONTEXT_WINDOWS / MAX_EDIT_CONTEXT_BYTES) as an answer
  // pack's facet-closure windows are bounded: a declaration the edit needs is
  // not dropped for the surface count the located files left over.
  if (!editContextEnabled()) return;
  if (surfaces.length >= MAX_SURFACES_DISTINCT) return;
  for (const candidate of await editContextCandidates(surfaces, query, workspace, cache, includeTests)) {
    const surface = await candidateToSurface(candidate, workspace, requiredRoles, query, cache);
    if (!hasServedCode(surface) || surfaces.some((existing) => existing.path === surface.path && existing.range === surface.range)) continue;
    surface.required = false;
    surfaces.push(surface);
  }
}

export async function editContextCandidates(
  surfaces: readonly TaskPackSurface[],
  query: string,
  workspace: string,
  cache: FileReadCache,
  includeTests = false,
): Promise<ImpactCandidate[]> {
  const named = new Set(explicitCodeIdentifiers(query).map(normIdent));
  // A prose-cased name ("(Compute)", "Sum") is no explicit identifier, but a
  // callable in the located edit target spelled exactly so in the request is
  // the one it means.
  const spelled = (name: string): boolean => name.length >= 3
    && new RegExp(`(?<![A-Za-z0-9_$])${escapeRegExp(name)}(?![A-Za-z0-9_$])`).test(query);
  const focals: ResolvedFacetFocal[] = [];
  for (const surface of surfaces.filter(hasServedCode).slice(0, 2)) {
    const content = readCached(workspace, surface.path, cache);
    const lang = languageForPath(surface.path);
    if (content === undefined || lang === undefined) continue;
    const lines = content.split(/\r?\n/);
    const span = parseSurfaceSpan(surface.range ?? "") ?? { start: 1, end: lines.length };
    const parsed = (await cache.parsedSymbols(content, lang, surface.path)) ?? [];
    const callables = parsed.filter((symbol) => symbol.startLine >= span.start && symbol.endLine <= span.end
      && symbolIsCallable(symbol, lines, hasHashComments(surface.path)));
    const chosen = callables.filter((symbol) => {
      const name = unqualifiedSymbolTail(symbol.name);
      return surface.symbol !== undefined ? normIdent(surface.symbol) === normIdent(name) : named.has(normIdent(name)) || spelled(name);
    });
    // A served target holding a single callable is that callable's edit.
    for (const symbol of chosen.length > 0 || surface.symbol !== undefined ? chosen : callables.length === 1 ? callables : []) {
      const name = unqualifiedSymbolTail(symbol.name);
      focals.push({ path: surface.path, name, startLine: symbol.startLine, endLine: symbol.endLine, typeName: "", hasRealType: false, kind: symbol.kind });
    }
  }
  const served = surfaces.map((surface) => ({ path: surface.path, span: parseSurfaceSpan(surface.range ?? "") }));
  const covered = (path: string, start: number, end: number): boolean => served.some((entry) =>
    entry.path === path && (entry.span === undefined || (entry.span.start <= start && entry.span.end >= end)));
  // The declarations each dependency file must serve, by file in first-use order.
  const needed = new Map<string, { lines: readonly string[]; bytes: number; spans: EditContextSpan[] }>();
  for (const focal of focals.slice(0, 2)) {
    const callees = await calleeDefinitionsForFocal(focal, workspace, cache);
    const qualified = await goQualifiedDeclarationWindows(focal, workspace, cache);
    const types = await goPackageTypeWindows(focal, workspace, cache);
    const methods = await goCalledMethodWindows(focal, workspace, cache, new Set(callees.windows.map((window) => window.name)), [...qualified, ...types]);
    const constants = await constantClosureForFocal(focal, workspace, cache, Date.now() + 1_500, callees.windows);
    for (const window of [...callees.windows, ...qualified, ...types, ...methods, ...constants.windows]) {
      if (window.binding === true || window.path === focal.path && window.start >= focal.startLine && window.end <= focal.endLine) continue;
      const content = readCached(workspace, window.path, cache);
      if (content === undefined) continue;
      const file = needed.get(window.path) ?? { lines: cachedFileLines(cache, window.path, content), bytes: Buffer.byteLength(content, "utf8"), spans: [] };
      needed.set(window.path, file);
      for (const span of declarationSpans(window.path, file.lines, window)) file.spans.push({ ...span, names: [window.name], focals: [focal.name] });
    }
  }
  const out: ImpactCandidate[] = [];
  let bytes = 0;
  for (const [filePath, file] of needed) {
    const spans = mergeEditContextSpans(file.lines, file.spans);
    const wanted = spans.reduce((sum, span) => sum + lineSpanBytes(file.lines, span.start, span.end), 0);
    // The whole file when that adds at most EDIT_CONTEXT_WHOLE_FILE_BYTES to
    // the declarations wanted from it: the rest is cheaper to send than the
    // re-read a partial view of such a file draws, which costs a turn over
    // the whole context. Never over a file a served surface holds part of.
    const whole = file.bytes <= EDIT_CONTEXT_WHOLE_FILE_BYTES || spans.length > 0
      && file.bytes - wanted <= EDIT_CONTEXT_WHOLE_FILE_BYTES
      && bytes + file.bytes <= MAX_EDIT_CONTEXT_BYTES
      && !served.some((entry) => entry.path === filePath);
    // The last line, not the empty string after a final newline: `1-58` of a
    // 57-line file is no served `1-57`, and would take a window slot.
    const lastLine = file.lines.length - (file.lines.length > 1 && file.lines[file.lines.length - 1] === "" ? 1 : 0);
    const pieces: readonly EditContextSpan[] = whole
      ? [{ start: 1, end: lastLine, names: [...new Set(file.spans.flatMap((span) => span.names))], focals: [...new Set(file.spans.flatMap((span) => span.focals))] }]
      : spans;
    for (const piece of pieces) {
      if (out.length >= MAX_EDIT_CONTEXT_WINDOWS) break;
      const size = lineSpanBytes(file.lines, piece.start, piece.end);
      if (covered(filePath, piece.start, piece.end) || bytes + size > MAX_EDIT_CONTEXT_BYTES) continue;
      bytes += size;
      // `callerRange`: serve exactly this window; candidateToSurface would
      // otherwise widen a symbol-less window in a mid-size file to the whole file.
      // A resolved definition is embedded (HIGH_CONFIDENCE_THRESHOLD), never handle-only.
      out.push({ path: filePath, line: piece.start, range: `${piece.start}-${piece.end}`, callerRange: true, surface: "unknown",
        why: editContextWhy(piece.names, piece.focals), confidence: Math.max(HIGH_CONFIDENCE_THRESHOLD, 0.9), required: false });
    }
  }
  if (includeTests) for (const focal of focals.slice(0, 2)) {
    if (!focal.path.endsWith(".go") || focal.path.endsWith("_test.go")) continue;
    const testPath = focal.path.slice(0, -3) + "_test.go";
    if (surfaces.some(surface => surface.path === testPath)) continue;
    // Auto-discovery must obey the same ignore policy as every other candidate.
    if (!walkCodeFiles(workspace, {subPath: path.posix.dirname(focal.path)}).some(file => file.relPath === testPath)) continue;
    const source = readCached(workspace, focal.path, cache), content = readCached(workspace, testPath, cache);
    if (source === undefined || content === undefined || Buffer.byteLength(content, "utf8") > 6 * 1024
      || !samePackageGoTest(focal.path, source, testPath, content) || !goTestInvokesFocal(content, focal.name)) continue;
    const ownBytes = surfaces.reduce((sum, surface) => sum + Buffer.byteLength(surface.code ?? "", "utf8"), 0);
    const ceiling = packByteCeilingStorage.getStore() ?? DEFAULT_RESPONSE_BYTE_FLOOR;
    if (ownBytes + bytes + measureResponseBytes(JSON.stringify(content))
      + 128 * (surfaces.length + out.length + 1) + 4096 > ceiling) continue;
    const lines = content.split(/\r?\n/), last = lines.length - (lines.at(-1) === "" ? 1 : 0);
    out.push({path: testPath, line: 1, range: "1-" + last, callerRange: true, surface: "test",
      why: EDIT_CONTEXT_WHY + ": test for " + focal.name, confidence: 0.9, required: false});
    break; // One corresponding whole test, separate from the dependency budget.
  }
  return out;
}

export async function calleeDefinitionsForFocal(
  focal: ResolvedFacetFocal,
  workspace: string,
  cache: FileReadCache,
  depth = 1,
  visited: Set<string> = new Set(),
  /** How many direct call names are taken at depth 1 (a type flow's steps keep the old MAX_CALLEES_PER_REQUIREMENT bound). */
  directLimit = MAX_SCANNED_CALLEE_NAMES,
): Promise<CalleeDefinitions> {
  const content = readCached(workspace, focal.path, cache);
  if (content === undefined) return { windows: [], complete: true };
  const lines = content.split(/\r?\n/);
  const hashComment = hasHashComments(focal.path);
  const bodyLines = lines.slice(focal.startLine - 1, focal.endLine);
  const targets = calleeTargetsIn(bodyLines, hashComment, focal.name, new Set([focal.name]));
  // A deeper layer keeps its bounded expansion: the first
  // MAX_CALLEES_PER_REQUIREMENT workspace definitions an already-required
  // callee's body calls, among its first MAX_NESTED_CALLEE_NAMES_SCANNED call
  // names. A name that resolves to none (`fmt.Errorf`, `sort.SliceStable`)
  // does not use up that budget (2026-10-17 bench, M1: `posting.Apply`'s
  // `validateNoDuplicates`, the check returning ErrDuplicateLeg, was cut
  // behind `Errorf`), and likewise only resolved callees count toward the
  // MAX_CALLEES_PER_REQUIREMENT that are expanded one layer deeper.
  const callees = targets.slice(0, depth === 1 ? directLimit : MAX_NESTED_CALLEE_NAMES_SCANNED);
  let complete = depth > 1 || targets.length <= callees.length;
  if (!complete) {
    // Names past the scan ceiling cut the list only when one of them could be
    // an in-workspace callee: a same-file callable, or a name the file
    // imports (any name at all in Go, whose package siblings need no import
    // line). Built-ins and member calls on locals (`push`, `map`, `min`) are
    // neither, so a long body full of them is not reported cut.
    const lang = languageForPath(focal.path);
    const sameFile = new Set(((lang ? await cache.parsedSymbols(content, lang, focal.path) : null) ?? [])
      .filter((symbol) => symbolIsCallable(symbol, lines, hashComment))
      .map((symbol) => unqualifiedSymbolTail(symbol.name)));
    complete = path.extname(focal.path) !== ".go" && targets.slice(callees.length).every(({ name, owner }) =>
      !sameFile.has(name) && importSpecifiersNaming(lines, owner ?? name, hashComment, focal.path).length === 0);
  }
  const out: NamedWindow[] = [];
  let required = 0;
  const unresolved: string[] = [];
  for (const target of callees) {
    const calleeName = target.name;
    if (depth > 1 && required >= MAX_CALLEES_PER_REQUIREMENT) break;
    const bindingKey = JSON.stringify([focal.path, focal.startLine, focal.endLine, focal.name, target.owner ?? (target.qualified ? "." : ""), calleeName]);
    if (visited.has(bindingKey)) continue;
    visited.add(bindingKey);
    const resolved = await resolveCalleeFile(calleeName, focal, lines, hashComment, workspace, cache, () => { complete = false; }, target.owner);
    if (resolved?.symbol === undefined) {
      if (target.owner === undefined) {
        const specs = importSpecifiersNaming(lines, calleeName, hashComment, focal.path);
        const unbound = !target.qualified && specs.length === 0
          && !bodyDeclaresLocal(bodyLines, calleeName, hashComment)
          && hasUnboundBareCallee(bodyLines, calleeName, focal.path);
        if (unbound || specs.some((s) => s.relative && !s.wildcard)) unresolved.push(`${calleeName} in ${focal.path}`);
      } else {
        const ns = await resolveModuleNamespaceFile(target.owner, focal.path, lines, workspace, cache);
        if (ns !== undefined && ns !== "workspace-module-unresolved") unresolved.push(`${target.owner}.${calleeName} in ${focal.path}`);
      }
      continue;
    }
    if (depth === 1 && required >= MAX_REQUIRED_CALLEE_WINDOWS) {
      complete = false;
      break;
    }
    required += 1;
    out.push(...(resolved.bindings ?? []));
    out.push({ path: resolved.path, start: resolved.symbol.startLine, end: resolved.symbol.endLine, name: resolved.name ?? calleeName });
    if (depth >= MAX_FLOW_CALLEE_DEPTH || required > MAX_CALLEES_PER_REQUIREMENT) continue;
    const calleeFocal: ResolvedFacetFocal = {
      path: resolved.path,
      name: resolved.name ?? calleeName,
      startLine: resolved.symbol.startLine,
      endLine: resolved.symbol.endLine,
      typeName: focal.typeName,
      hasRealType: focal.hasRealType,
    };
    const nested = await calleeDefinitionsForFocal(calleeFocal, workspace, cache, depth + 1, visited);
    out.push(...nested.windows);
    if (!nested.complete) complete = false;
    unresolved.push(...(nested.unresolved ?? []));
  }
  return { windows: out, complete, ...(unresolved.length > 0 ? { unresolved } : {}) };
}

/**
 * Copilot retest review (2026-10-02): a facet focal is callable when the parser
 * files it as a function or method, or as a `const` bound to a function
 * (`export const f = (x) => ...`, a lambda) -- the most common TS/JS shape,
 * which the callee closure used to skip entirely, as a hub and as a callee.
 * An unparsed focal (no kind) counts as callable, as before.
 */
export function focalIsCallable(focal: ResolvedFacetFocal, workspace: string, cache: FileReadCache): boolean {
  if (focal.kind === undefined || CALLER_EXPANSION_CALLABLE_KINDS.has(focal.kind)) return true;
  if (focal.kind !== "const") return false;
  const lines = readCached(workspace, focal.path, cache)?.split(/\r?\n/);
  return lines !== undefined && declarationIsCallable(lines.slice(focal.startLine - 1, focal.endLine), hasHashComments(focal.path));
}

/** `calleeDefinitionsForFocal`'s result. */
export interface CalleeDefinitions {
  readonly windows: NamedWindow[];
  readonly unresolved?: string[];
  /** False when MAX_SCANNED_CALLEE_NAMES / MAX_REQUIRED_CALLEE_WINDOWS cut the focal's direct callee list. */
  readonly complete: boolean;
}

/** flow's callee/step windows for one focal (`flowWindowsForFocal`). */
export interface FlowWindows {
  readonly windows: NamedWindow[];
  readonly unresolvedCallees?: string[];
  readonly membersComplete: boolean;
  readonly ungroundedTerms: string[];
  /** False when a direct callee list (the focal's own, or a step's) was cut -- see `CalleeDefinitions.complete`. */
  readonly calleesComplete: boolean;
}

/**
 * FIX-FAB2 (eval-0927 orchestrator repro, 2026-09-28, afx): flow's own
 * "steps" over a NON-callable focal — a class/interface/enum/type
 * (`focal.kind` defined and outside `CALLER_EXPANSION_CALLABLE_KINDS`).
 * Flattening the WHOLE type body through `calleeNamesIn` (the
 * callable-focal path above) treats every one of the type's OWN member
 * declarations as a candidate "callee" of the type — even with FIX-FAB2's
 * declaration exclusion in `calleeNamesIn` removing the false CALLS, the
 * type's own members are exactly what a flow question about the type is
 * asking to see ("how does OrderFlow sequence payment/inventory/shipping"
 * asks about `place`/`fulfil`, not about some external free function the
 * class body happens to mention once, in whatever order `calleeNamesIn`'s
 * flat first-appearance scan and MAX_CALLEES_PER_REQUIREMENT cap happen to
 * reach first — reproduced live: with 320 filler members between `place`
 * and `fulfil`, the flat scan never even reached `fulfil`'s body).
 *
 * The focal's own DIRECT member callables (by line-range containment AND
 * enclosing-symbol name, so a nested type's own members are never this
 * type's members) whose name or body mentions a content term of the clause
 * (case-insensitive substring — the same rule `conceptGrounded` above
 * already applies, which matches inside a concatenated identifier like
 * `shippingService` for free; the focal's own name is never a term) become
 * the flow steps, in SOURCE ORDER, each then expanded one further hop
 * through the UNCHANGED `calleeDefinitionsForFocal` (so a step's own
 * callees are found exactly as a callable focal's are).
 *
 * P1-8 (eval-0927 review r2 finding 8, classFlowHandle/classFlowLifecycle):
 * `membersComplete` used to go false as soon as more members matched than
 * MAX_CALLEES_PER_REQUIREMENT (3) allowed to be SERVED — but that cap exists
 * to bound the cost of the deeper one-hop callee-expansion below, not the
 * number of members the facet may REQUIRE; a small, ordinary class (here:
 * constructor + place + payment + fulfil, four matches) whose WHOLE body
 * was already on the wire (a small-file whole-serve, or any other surface
 * that happens to cover it) was certified "undetermined" purely because it
 * had a 4th matching member, even though every one of them was already
 * served. Every matched member's OWN span is now a required window (see
 * `out`'s first loop below) — the closure's serving budget only limits how
 * many of them get the DEEPER one-hop callee-expansion (`steps`, unchanged);
 * the gate's ordinary unservedSubSpans/open machinery then judges each
 * member window on whether it is ACTUALLY served, giving an unserved member
 * an executable `next` instead of a flat dead-end (P2). `membersComplete` is
 * now false only past MAX_FLOW_REQUIRED_MEMBER_WINDOWS, a much larger safety
 * ceiling guarding against a pathological type with an unreasonable number
 * of matching members (never silently dropping the rest, same as before —
 * the failure mode this function exists to fix one layer up — just at a
 * bound that does not fire for an ordinary small class).
 *
 * `ungroundedTerms` lists every clause term (subjectTerms, length >= 3,
 * excluding the focal's own name) that matched NO member at all. The gate
 * (facetGate.ts's `evaluateFacetRequirement`) refuses to certify "covered"
 * while either is non-empty (P1/P3 — brief-fab2.md required behaviour 2/3):
 * a class whose relevant members are still unserved, or whose clause names
 * something no served member accounts for, is not yet answered.
 */
/**
 * v0.15.1 runtime review (2026-10-06): the stem an English clause word shares
 * with the member that does it — "authorization" / `authorize()`, "settlement"
 * / `settle()`, "processing" / `process()`. A flow clause names the steps as
 * nouns or gerunds while the class names them as verbs, so the literal match
 * alone disclosed "authorization … matches no member of PaymentPipeline" over
 * a served class whose `authorize()` is the very step. Only common
 * derivational/inflectional endings are stripped, and never below four
 * letters, so the stem still names the word.
 */
export const DERIVATIONAL_SUFFIXES_EN = ["izations", "isations", "ization", "isation", "ations", "ation", "ments", "ment", "ings", "ing", "ers", "er", "ed", "es", "ize", "ise", "s", "e"];

export function derivationalStemEn(word: string): string {
  if (!/^[a-z]+$/u.test(word)) return word;
  for (const suffix of DERIVATIONAL_SUFFIXES_EN) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 4) return word.slice(0, -suffix.length);
  }
  return word;
}

/** A structure map's out-of-line member as the parsed callable the flow facet reads members as (its range is the member's own, doc comment included, so the map's window for it is found by that range). */
export function mapMemberSymbol(member: StructureMapMember): CollectedSymbol {
  return {
    name: member.name,
    kind: "method",
    startLine: member.start,
    endLine: member.end,
    startIndex: 0,
    endIndex: 0,
    signatureStartIndex: 0,
    signatureEndIndex: 0,
    signatureStartLine: member.signatureStart,
    signatureEndLine: member.signatureEnd,
  };
}

/** P1-8: safety ceiling on how many matched members become required flow windows at all — MAX_CALLEES_PER_REQUIREMENT (3) still bounds the costlier one-hop callee-expansion (`steps`), a separate, smaller concern. */
export const MAX_FLOW_REQUIRED_MEMBER_WINDOWS = 64;

export async function flowStepWindowsForNonCallableFocal(
  focal: ResolvedFacetFocal,
  requirement: FacetRequirement,
  workspace: string,
  cache: FileReadCache,
  /** v0.16 6t-7 T03: the answer pack's structure map, when it maps this very type (`structureMapForAnswer`). */
  structureMap?: AnswerStructureMap,
): Promise<FlowWindows> {
  const content = readCached(workspace, focal.path, cache);
  if (content === undefined) return { windows: [], membersComplete: true, ungroundedTerms: [], calleesComplete: true };
  const lang = languageForPath(focal.path);
  const parsed = (lang ? await cache.parsedSymbols(content, lang, focal.path) : null) ?? [];
  const ownName = normalizeCallerIdent(focal.name);
  // The members a MAPPED type declares outside its range (a Go struct's methods, the
  // fns of a Rust type's impl blocks, the C++ `T::m` definitions of its file) are
  // its members here too: found in the focal's range alone, a Go type has none, every
  // clause term goes ungrounded and the flow is "undetermined" over a served map.
  // For a type whose members are inside it the map adds none (Java, TypeScript, …).
  const mappedOutside = structureMap !== undefined
    && structureMap.type.path === focal.path
    && structureMap.type.name === unqualifiedSymbolTail(focal.name)
    ? structureMap.type.members.filter((member) => member.outOfLine === true && !member.nestedType)
      .map((member) => ({ symbol: mapMemberSymbol(member), path: member.path ?? focal.path }))
    : [];
  const members = [
    ...parsed.filter((s) =>
      CALLER_EXPANSION_CALLABLE_KINDS.has(s.kind)
      && s.startLine >= focal.startLine && s.endLine <= focal.endLine
      && normalizeCallerIdent(unqualifiedSymbolTail(s.enclosingSymbol?.name ?? "")) === ownName)
      .map((symbol) => ({ symbol, path: focal.path })),
    ...mappedOutside,
  ].sort((a, b) => a.path.localeCompare(b.path) || a.symbol.startLine - b.symbol.startLine);
  const lines = content.split(/\r?\n/);
  // 2026-10-10 (false flow gaps): a word naming no point of the flow — the
  // file's path, a flow descriptor, a declaration kind (requestFacets.ts
  // `nonPointTermsIn`) — is no term a member must carry; a clause left with
  // no point word asks for the type's whole flow, so every member is a step.
  const nonPoint = new Set((requirement.nonPointTerms ?? []).map((t) => t.toLowerCase()));
  const terms = [...new Set(
    requirement.subjectTerms.map((t) => t.toLowerCase()).filter((t) => t.length >= 3 && t !== ownName && !nonPoint.has(t)),
  )];
  const ungroundedTerms = new Set(terms);
  const matched: typeof members = terms.length === 0 ? [...members] : [];
  const linesByPath = new Map<string, string[]>([[focal.path, lines]]);
  for (const { path: memberPath } of members) {
    if (linesByPath.has(memberPath)) continue;
    const text = readCached(workspace, memberPath, cache);
    if (text !== undefined) linesByPath.set(memberPath, text.split(/\r?\n/u));
  }
  for (const { symbol: member, path: memberPath } of members) {
    if (terms.length === 0) break;
    const nameLower = unqualifiedSymbolTail(member.name).toLowerCase();
    const memberLines = linesByPath.get(memberPath);
    if (memberLines === undefined) continue;
    const bodyLower = memberLines.slice(member.startLine - 1, member.endLine).join("\n").toLowerCase();
    let hit = false;
    for (const term of terms) {
      const stem = derivationalStemEn(term);
      if (nameLower.includes(term) || bodyLower.includes(term) || (stem !== term && (nameLower.includes(stem) || bodyLower.includes(stem)))) {
        ungroundedTerms.delete(term);
        hit = true;
      }
    }
    if (hit) matched.push({ symbol: member, path: memberPath });
  }
  // A Japanese concept may bridge to several English spellings; those
  // spellings are alternatives, rather than separate requested members.
  for (const aliases of requirement.subjectTermAliases ?? []) {
    if (aliases.some((term) => terms.includes(term) && !ungroundedTerms.has(term))) {
      for (const term of aliases) ungroundedTerms.delete(term);
    }
  }
  const membersComplete = matched.length <= MAX_FLOW_REQUIRED_MEMBER_WINDOWS;
  const required = matched.slice(0, MAX_FLOW_REQUIRED_MEMBER_WINDOWS);
  // v0.16 6t-7 T03: a short, map-shaped answer about this type is served its
  // STRUCTURE MAP (structureMap.ts) — every member's signature and the ROWS of
  // the members that call the clause's concerns (the statements that call them,
  // the returns and throws, the control lines around them), never the member
  // bodies — so the flow requires exactly those windows of each matched member,
  // and no one-hop callee expansion: the map serves no callee body to expand
  // into. (The reply the map rides in is filled with whole bodies where they
  // fit; what is REQUIRED is the rows alone, 2026-10-23.) The member matching
  // above (and so `ungroundedTerms`) is unchanged.
  if (
    structureMap !== undefined
    && structureMap.type.path === focal.path
    && structureMap.type.name === unqualifiedSymbolTail(focal.name)
  ) {
    // A small page must not certify a state table, declaration or call it
    // omitted. These obligations describe the full map, not just this page.
    const mapWindows: NamedWindow[] = [
      ...structureMap.requiredWindows.map(span => ({ path: span.path ?? focal.path, start: span.start, end: span.end, name: structureMap.type.name })),
      ...structureMap.stateWindows,
    ];
    for (const { symbol: member, path: memberPath } of required) {
      const name = unqualifiedSymbolTail(member.name);
      const mapped = structureMap.type.members.find((candidate) =>
        candidate.name === name && candidate.start === member.startLine && candidate.end === member.endLine
        && (candidate.path ?? focal.path) === memberPath);
      // The full map already requires every mapped member's declaration and
      // all requested concern calls after the normal comment policy. Do not
      // reintroduce raw elided comments as obligations from a second planner.
      if (mapped === undefined) mapWindows.push({ path: memberPath, start: member.startLine, end: member.endLine, name });
    }
    return { windows: mapWindows, membersComplete, ungroundedTerms: [...ungroundedTerms], calleesComplete: true };
  }
  const steps = required.slice(0, MAX_CALLEES_PER_REQUIREMENT);
  const out: NamedWindow[] = [];
  // Every matched member (up to the safety ceiling) is a required window on
  // its own -- cheap (no expansion), and lets the gate recognize a member
  // already served by some OTHER surface (e.g. the whole class on the wire)
  // without limiting how many of them can be accepted as covered.
  for (const { symbol: member, path: memberPath } of required) {
    out.push({ path: memberPath, start: member.startLine, end: member.endLine, name: unqualifiedSymbolTail(member.name) });
  }
  const visited = new Set<string>([focal.name]);
  const calleesComplete = true;
  for (const { symbol: member, path: memberPath } of steps) {
    const stepName = unqualifiedSymbolTail(member.name);
    if (visited.has(stepName)) continue;
    visited.add(stepName);
    const stepFocal: ResolvedFacetFocal = {
      path: memberPath,
      name: stepName,
      startLine: member.startLine,
      endLine: member.endLine,
      typeName: focal.typeName,
      hasRealType: focal.hasRealType,
      kind: member.kind,
    };
    // Copilot retest review (2026-10-02): a step keeps the old bound (its
    // first MAX_CALLEES_PER_REQUIREMENT callees, plus their own layer). The
    // matched members are this flow's required windows; their callees are the
    // costlier expansion, and requiring every one of them for every member
    // would turn one type-flow question into many round trips.
    const stepCallees = await calleeDefinitionsForFocal(stepFocal, workspace, cache, 1, new Set(visited), MAX_CALLEES_PER_REQUIREMENT);
    out.push(...stepCallees.windows);
  }
  return { windows: out, membersComplete, ungroundedTerms: [...ungroundedTerms], calleesComplete };
}

/**
 * FIX-FAB2: dispatches flow's own callee/step windows on whether `focal` is
 * itself callable (FIX-FAB's unchanged `calleeDefinitionsForFocal` above,
 * direct callees of the callable body) or a type
 * (`flowStepWindowsForNonCallableFocal`, the type's own matching members).
 * `membersComplete`/`ungroundedTerms` are only ever non-trivial for the type
 * path — a callable focal's flow requirement is judged exactly as before
 * this wave (required behaviour 4).
 */
export async function flowWindowsForFocal(
  focal: ResolvedFacetFocal,
  requirement: FacetRequirement,
  workspace: string,
  cache: FileReadCache,
  /** The pack's shared (memoized) callee resolution; a direct call by default. */
  calleesOf: (focal: ResolvedFacetFocal) => Promise<CalleeDefinitions> = (f) => calleeDefinitionsForFocal(f, workspace, cache),
  /** v0.16 6t-7 T03: see `flowStepWindowsForNonCallableFocal`. */
  structureMap?: AnswerStructureMap,
): Promise<FlowWindows> {
  if (!focalIsCallable(focal, workspace, cache)) {
    return flowStepWindowsForNonCallableFocal(focal, requirement, workspace, cache, structureMap);
  }
  const callees = await calleesOf(focal);
  return { windows: callees.windows, membersComplete: true, ungroundedTerms: [], calleesComplete: callees.complete,
    ...(callees.unresolved !== undefined ? { unresolvedCallees: callees.unresolved } : {}) };
}

/** The enclosing-symbol (or bounded-margin) window of one ranked call site — same rule `recoverCallerExpansionCandidates` applies to its own sites above. */
export async function windowForCallSite(
  site: { readonly path: string; readonly line: number },
  workspace: string,
  cache: FileReadCache,
): Promise<{ start: number; end: number; symbolName?: string }> {
  const content = readCached(workspace, site.path, cache);
  if (content === undefined) return { start: site.line, end: site.line };
  const lang = languageForPath(site.path);
  const parsed = (lang ? await cache.parsedSymbols(content, lang, site.path) : null) ?? [];
  const enclosing = parsed
    .filter((s) => CALLER_EXPANSION_CALLABLE_KINDS.has(s.kind) && site.line >= s.startLine && site.line <= s.endLine)
    .sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine))[0];
  const totalLines = countLines(content);
  // P1-9 (eval-0927 review-r2 #9's "1-47 for a 7-line file" producer): the
  // enclosing symbol's OWN parsed `endLine` was returned verbatim, with no
  // floor/ceiling against THIS file's real extent — a parser miscount (measured
  // alongside non-ASCII content elsewhere in the same file) could hand back an
  // end line past EOF, and the caller (a facet `next`/`remaining` target) has
  // no way to tell a real large symbol apart from a bogus one without this
  // clamp. `boundedCallerWindow`'s own fallback path already clamps this way
  // (`Math.min(Math.max(totalLines, 1), ...)`); this makes the enclosing-symbol
  // path the same guarantee, never a silent out-of-bounds `next`.
  if (enclosing !== undefined) {
    return {
      start: Math.max(1, Math.min(enclosing.startLine, totalLines)),
      end: Math.max(1, Math.min(enclosing.endLine, totalLines)),
      symbolName: enclosing.name,
    };
  }
  const bounded = boundedCallerWindow(site.line, totalLines);
  return { start: bounded.start, end: bounded.end };
}

/**
 * FIX-G (2026-09-27): call sites of `focal` inside its OWN file, outside its
 * own body. Both cross-file scanners above deliberately skip the focal's file
 * ("never its own caller" — right for caller EXPANSION, whose point is the
 * entry point elsewhere), but a callers question is answered only by EVERY
 * caller: a sibling function in the same module that calls the focal is one.
 * Same masking and declaration exclusions as `plainFunctionCallerSites`.
 * 2026-10-06 (independent review follow-up): served by the hook like a
 * cross-file site — they used to be plan-only, required by the gate yet never
 * served, so every same-module callers question ("… and callers" of
 * `retryDelay`, called by `retry` beside it) paid one more hop for a ranged
 * `next` the first pack could have carried.
 *
 * MENTION GUARD (R5-A1): also returns same-file `mentions`/`mentionsCapped`
 * — a raw mention the classifier's own masking pre-filter above hides (e.g.
 * inside a template/f-string interpolation) is otherwise invisible to this
 * scan entirely, so it is found independently, over the RAW lines, exactly
 * like the cross-file scanners' own guard (`unclassifiedMentionLines`).
 */
export function sameFileFacetCallSites(
  focal: ResolvedFacetFocal,
  workspace: string,
  cache: FileReadCache,
): { sites: FacetCallSite[]; mentions: FacetMentionLine[]; mentionsCapped: boolean } {
  const content = readCached(workspace, focal.path, cache);
  if (content === undefined) return { sites: [], mentions: [], mentionsCapped: false };
  const hashComment = hasHashComments(focal.path);
  const lines = content.split(/\r?\n/);
  // A4 (eval-0927 review-r6 P1-6/P2-11 class): the file-level multi-line
  // scan, consulted by BOTH passes below -- see `callSitesForFocalMember`'s
  // own `commentState` doc for the confident/non-confident/codeFrom split
  // this replaces the old boolean-only `computeBlockCommentMask` filter
  // with (a CONFIDENT line is dropped from both; a merely MASKED,
  // non-confident line stays visible to the mention pass; a closer line
  // with `codeFrom` is classified from that column).
  const commentState = blockCommentLineStates(lines, focal.path);
  const out: FacetCallSite[] = [];
  const recordedLines = new Set<number>();
  for (let index = 0; index < lines.length; index++) {
    const lineNo = index + 1;
    if (lineNo >= focal.startLine && lineNo <= focal.endLine) continue;
    if (commentState.confident[index]) continue;
    const codeFrom = commentState.codeFrom[index];
    if (commentState.masked[index] && codeFrom === undefined) continue; // non-confident: never a call site, still a possible mention below
    const rawLine = lines[index]!;
    const scanLine = codeFrom !== undefined ? " ".repeat(codeFrom) + rawLine.slice(codeFrom) : rawLine;
    const masked = maskNonCode(scanLine, hashComment, focal.path);
    if (!masked.includes(focal.name)) continue;
    for (const occurrence of findCallOccurrences(masked, focal.name)) {
      if (callSiteOccurrenceIsDeclaration(occurrence, masked, focal.path, lines, lineNo, hashComment)) {
        // R6-A (eval-0927 review-r5 P2-6, cppUserTypeMemberFalseCaller): this
        // occurrence IS the declaration `callSiteOccurrenceIsDeclaration`
        // itself found (its own C++ out-of-line-member scope-qualified case
        // included) -- the line is explained; it must never ALSO be re-tried
        // by the weaker, independent `mentionLineLooksLikeDeclaration` below,
        // which lacks that same special case and would otherwise re-flag an
        // already-classified declaration line as an unclassified mention.
        recordedLines.add(lineNo);
        continue;
      }
      out.push({ path: focal.path, line: lineNo });
      recordedLines.add(lineNo);
      break;
    }
  }
  const mentionRe = ASCII_WORD_MEMBER_RE.test(focal.name) ? new RegExp(`\\b${escapeRegExp(focal.name)}\\b`) : undefined;
  // A3 (eval-0927 review-r6 P1-5): see `unclassifiedMentionLines`'s own doc
  // on `isCallerMentionOnlyFile` -- symmetry only (a focal is never actually
  // resolved inside one of these embedded-code extensions today), kept so
  // this scan stays correct automatically if focal resolution ever learns to
  // find a declaration inside one.
  const mentionOnly = isCallerMentionOnlyFile(focal.path);
  const mentions: FacetMentionLine[] = [];
  let mentionsCapped = false;
  for (let index = 0; index < lines.length; index++) {
    const lineNo = index + 1;
    if (lineNo >= focal.startLine && lineNo <= focal.endLine) continue;
    if (recordedLines.has(lineNo)) continue;
    // A4: a CONFIDENT masked line is dropped outright here too (never a
    // mention); a merely masked, non-confident line stays -- its true
    // classification is left to `memberOnlyInCommentText`'s own state-aware
    // judgment below, never a blind drop.
    if (commentState.confident[index]) continue;
    const text = lines[index]!;
    if (mentionRe === undefined ? !text.includes(focal.name) : !mentionRe.test(text)) continue;
    if (!mentionOnly) {
      const lineState: MentionCommentLineState = {
        masked: commentState.masked[index] === true,
        confident: commentState.confident[index] === true,
        codeFrom: commentState.codeFrom[index] ?? undefined,
      };
      if (memberOnlyInCommentText(text, focal.name, hashComment, lineState)) continue;
      if (mentionExplainedByImportExport(lines, lineNo, focal.name, focal.path)) continue;
      if (mentionLineLooksLikeDeclaration(text, focal.name)) continue;
    }
    if (mentions.length >= MAX_UNCLASSIFIED_MENTION_LINES) { mentionsCapped = true; break; }
    mentions.push({ path: focal.path, line: lineNo });
  }
  return { sites: out, mentions, mentionsCapped };
}

/**
 * FIX-G: call sites a plan records per callers/flow requirement --
 * `totalCallSites` keeps the true count from the scan itself (which may
 * still exceed this). P1-7 (eval-0927 review-r2 #7): the GATE now requires
 * every ONE of these recorded sites (facetGate.ts's own doc), so this is the
 * real completeness bound, not merely a memo-size cap -- raised from 32 to
 * 48 (2026-09-28), then to 512 (R4-A2, eval-0927 review-r3 #10,
 * manyCallers60in3): 48 silently assumed at most ~40 distinct caller FILES
 * with one site each (`MAX_CALLER_FILES_EXAMINED`'s own mental model), but a
 * single file can hold many compatible call sites (three files, 20 sites
 * each = 60) -- the closure hook that records this plan runs ONLY ONCE, on
 * the first pack of a query (see its own call sites' doc), so a cap this
 * small permanently discarded the tail of a realistic fan-in with no later
 * hop ever able to recompute a wider slice. 512 plain `{path,line}` pairs
 * cost a few KB of PROCESS memory (never the wire -- this plan is an
 * in-process memo, `facetGate.ts`'s own header) and comfortably covers any
 * realistic fan-in within the SAME `MAX_CALLER_FILES_EXAMINED`-bounded
 * scan; `callSitesRecordedCapped` (facetGate.ts) is the honest disclosure
 * for the now-rare case where even this is not enough, kept distinct from
 * `callSitesFilesCapped` (a scan that never even OPENED some caller files at
 * all, the one bound this cap was never meant to paper over) so the two
 * causes are never confused on the wire.
 */
export const MAX_RECORDED_FACET_CALL_SITES = 512;
