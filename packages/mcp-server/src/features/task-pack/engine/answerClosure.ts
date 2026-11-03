// answerClosure — extracted implementation; imports point to the owning modules.
import type { FacetDependencyRecord } from "../facetGate.js";
import type { FacetPlanWindow } from "../facetGate.js";
import type { LineSpan } from "./sourceAndConcernTerms.js";
import type { ResolvedFacetFocal } from "./callableResolution2.js";
import type { TaskPackResult } from "../model.js";
import type { TaskPackResultSurface } from "../model.js";
import { DEPENDENCY_VALUE_CLAUSE } from "./callerRangeDelivery.js";
import { FACET_CLOSURE_EMERGENCY_BUDGET_MS } from "./facetClosure.js";
import { FileReadCache } from "./packBasics2.js";
import { MAX_CLOSURE_BYTES_PER_PACK } from "../evidenceClosure.js";
import { MAX_DEPENDENCY_FOCALS } from "./callerRangeDelivery.js";
import { callerExpansionTypeNameFor } from "./callerExpansion2.js";
import { centeredSliceForCap } from "./packBasics2.js";
import { classifySurface } from "../../../util/impact.js";
import { codeTaskPackSurfaces } from "../artifactSections.js";
import { configurationEvidenceSpan } from "../evidenceClosure.js";
import { configurationFileQuestion } from "./concernProof2.js";
import { constantClosureForFocal } from "./constantClosure.js";
import { explicitCodeIdentifiers } from "./anchorFocus2.js";
import { facetPlanFor } from "../facetGate.js";
import { facetPlanWorkspaceKey } from "./facetClosure.js";
import { focalRequiredSpan } from "../facetGate.js";
import { handleTable } from "../../../util/handles.js";
import { hasServedCode } from "./wiringEvidence2.js";
import { isStructuralOnlyRequest } from "../requestFacets.js";
import { isTestConcernPath } from "./literalAndConcernSeeds.js";
import { languageForPath } from "../../../util/languages.js";
import { lineSpansCover } from "./sourceAndConcernTerms.js";
import { queryMentionsTests } from "../callerExpansion.js";
import { readCached } from "./packBasics2.js";
import { recordFacetDependencyEntries } from "../facetGate.js";
import { servedLineSpansOf } from "./sourceAndConcernTerms.js";
import { shaOfText } from "../../../util/handles.js";
import { sliceLinesToText } from "../../../util/countLines.js";
import { subjectCallableNamesIn } from "../requestFacets.js";
import { symbolIsRealMember } from "./callableResolution2.js";
import { unqualifiedSymbolTail } from "./anchorFocus3.js";

/**
 * 2026-10-06 independent review (P1-1, P1-2): the values an answer computes
 * with are part of its evidence, whatever the question's wording — unless the
 * question only locates code or relates pieces of it (`isStructuralOnlyRequest`:
 * "Find X … renderInvoice relation consumed …" asks about no value
 * `renderInvoice` reads, and the semantic-frontier bench's sealed qrels score
 * that constant's file irrelevant).
 *
 * "Calculate invoiceAmount(1000)." served `invoiceAmount`'s body and was
 * certified `act.answer` without the imported SALES_TAX it multiplies by: the
 * facet closure chases constants only for a clause that SAYS value / rate /
 * default / limit, and this one said "calculate" ("Explain invoiceAmount and
 * the sales tax it uses" said neither). "retryDelay の待機時間 … 最大リトライ
 * 回数も示してください" served the caller `retry` — added by the falsification
 * pass AFTER the facet closure ran — without the LIMIT it loops to, an alias
 * of MAX_RETRIES = 4.
 *
 * So, once every surface is final: each callable the pack serves WHOLE that
 * the answer is about — a surface's own symbol (the answer focus, a
 * falsification counterexample) or a callable the question names — and that
 * no value/condition requirement already planned, gets the constant closure
 * that requirement would get (`constantClosureForFocal`: the free identifiers
 * of its body classified as parameters, locals, built-ins or module
 * constants, imports and alias chains followed to the declaration). Each
 * window is served here within MAX_CLOSURE_BYTES_PER_PACK and recorded on the
 * facet plan as a `dependency` entry the gate checks like a value facet: an
 * unserved window keeps the pack open with a ranged `next`; a read with no
 * resolvable declaration is disclosed `request-item-undetermined`; a callable
 * that reads no constant adds nothing. One pass reaches the fixed point — a
 * constant window adds no callable, and initializer/alias chains are chased
 * inside the closure itself. Returns how many surfaces it added.
 */
export async function runAnswerDependencyClosure(
  result: TaskPackResult,
  query: string,
  workspace: string,
  cache: FileReadCache | undefined,
): Promise<number> {
  const fileCache = cache ?? new FileReadCache();
  const workspaceKey = facetPlanWorkspaceKey(workspace);
  const shaOf = (relPath: string): string | undefined => {
    const content = readCached(workspace, relPath, fileCache);
    return content === undefined ? undefined : shaOfText(content);
  };
  const plan = facetPlanFor(workspaceKey, query, shaOf);
  // Binding statements are exact supplemental windows. Widening a focal
  // with its import header clears its symbol and can make a whole-file
  // expansion hide a still-needed falsification/dependency focal (retry's
  // MAX_RETRIES beside retryDelay). Append after that pass, before proving
  // the final evidence, and let the gate require anything the budget omits.
  let bindingAdded = 0;
  let bindingBytes = 0;
  const bindingKeys = new Set<string>();
  for (const entry of plan?.entries ?? []) {
    for (const win of entry.windows) {
      if (win.binding !== true) continue;
      const range = `${win.start}-${win.end}`;
      const key = `${win.path}\0${range}`;
      if (bindingKeys.has(key)) continue;
      bindingKeys.add(key);
      const served = servedLineSpansOf(codeTaskPackSurfaces(result.surfaces).filter(surface => surface.path === win.path && hasServedCode(surface)));
      if (lineSpansCover(served, win)) continue;
      const content = readCached(workspace, win.path, fileCache);
      if (content === undefined) continue;
      const code = sliceLinesToText(content, win.start, win.end);
      const bytes = Buffer.byteLength(code, "utf8");
      if (bindingBytes + bytes > MAX_CLOSURE_BYTES_PER_PACK) continue;
      bindingBytes += bytes;
      const handle = handleTable.upsert({ kind: "range", path: win.path, range, workspaceRoot: workspace, sha: shaOfText(code) });
      (result.surfaces as TaskPackResultSurface[]).push({ role: classifySurface(win.path), handle: handle.id,
        path: win.path, range, required: true, why: `closure:${entry.facet} binding ${win.name}`, code });
      bindingAdded++;
    }
  }
  if (isStructuralOnlyRequest(query)) return bindingAdded;
  const planned = new Set((plan?.entries ?? [])
    .filter((entry) => entry.dependency !== true && (entry.facet === "value" || entry.facet === "condition") && entry.focal !== undefined)
    .map((entry) => `${entry.focal!.path}\u0000${entry.focal!.name}`));
  const named = new Set([...explicitCodeIdentifiers(query), ...subjectCallableNamesIn(query)].map((name) => name.toLowerCase()));
  // A test's own fixture constants are no part of an answer about the code
  // unless the question is about tests (the facet closure's own rule).
  const allowTestPaths = queryMentionsTests(query);
  const servedSurfaces = codeTaskPackSurfaces(result.surfaces)
    .filter((surface) => (surface.code?.length ?? 0) > 0 && (allowTestPaths || !isTestConcernPath(surface.path)));
  const servedOf = (relPath: string): LineSpan[] => servedLineSpansOf(
    codeTaskPackSurfaces(result.surfaces).filter((surface) => surface.path === relPath && (surface.code?.length ?? 0) > 0),
  );

  const configurationPaths = new Set<string>();
  if (configurationFileQuestion(query)) {
    for (const surface of servedSurfaces) {
      const content = readCached(workspace, surface.path, fileCache);
      if (content !== undefined && configurationEvidenceSpan(content.split(/\r?\n/), surface.path, [...named]) !== undefined) {
        configurationPaths.add(surface.path);
      }
    }
  }
  const focals: ResolvedFacetFocal[] = [];
  const seen = new Set<string>();
  for (const surface of servedSurfaces) {
    const content = readCached(workspace, surface.path, fileCache);
    const lang = languageForPath(surface.path);
    if (content === undefined || !lang) continue;
    const lines = content.split(/\r?\n/);
    const served = servedOf(surface.path);
    const parsed = (await fileCache.parsedSymbols(content, lang, surface.path)) ?? [];
    const typeName = callerExpansionTypeNameFor(parsed, surface.path);
    for (const symbol of parsed) {
      // v0.15.1 runtime review TL-REVIEW-1 (2026-10-06): a CLASS the answer is
      // about, served whole, is one focal too — its methods' module reads
      // are the class's values. "Explain the save debounce duration and
      // watched languages of WorkspaceWatcher in src/watcher.ts." served the
      // class body (23-83) and was certified `act.answer` with no gap, while
      // DEBOUNCE_MS = 5000 and WATCHED_LANGUAGES (lines 15-20, read by
      // `scheduleRun`/`isTracked`) were never served: no method is named
      // `WorkspaceWatcher`, and the class itself was not a callable. One focal
      // over the whole class span (not one per method) keeps a large class
      // inside MAX_DEPENDENCY_FOCALS, and the closure's own rules still decide
      // what a read is: parameters, locals, `this.x` and built-ins are never
      // constants.
      if (symbol.kind !== "function" && symbol.kind !== "method" && symbol.kind !== "class") continue;
      const name = unqualifiedSymbolTail(symbol.name);
      if (name !== surface.symbol && !named.has(name.toLowerCase())) continue;
      // A UI/context function mentioning a setting is not another runtime
      // value question when the connected configuration reader is available.
      if (configurationPaths.size > 0 && !configurationPaths.has(surface.path) && !named.has(name.toLowerCase())) continue;
      const body = focalRequiredSpan(symbol.startLine, symbol.endLine, lines) ?? { start: symbol.startLine, end: symbol.endLine };
      if (!lineSpansCover(served, body)) continue;
      const key = `${surface.path}\u0000${name}`;
      if (planned.has(key) || seen.has(key)) continue;
      seen.add(key);
      focals.push({
        path: surface.path,
        name,
        startLine: symbol.startLine,
        endLine: symbol.endLine,
        typeName: symbol.kind === "class" ? name : unqualifiedSymbolTail(symbol.enclosingSymbol?.name ?? typeName),
        hasRealType: symbol.kind === "class" ? true : symbolIsRealMember(symbol, surface.path),
        kind: symbol.kind,
      });
    }
  }

  const deadline = Date.now() + FACET_CLOSURE_EMERGENCY_BUDGET_MS;
  const records: FacetDependencyRecord[] = [];
  const shasOf = (paths: readonly string[]): Record<string, string> => {
    const shas: Record<string, string> = {};
    for (const relPath of paths) {
      const sha = shaOf(relPath);
      if (sha !== undefined) shas[relPath] = sha;
    }
    return shas;
  };
  let bytesUsed = bindingBytes;
  let added = bindingAdded;
  for (const [index, focal] of focals.entries()) {
    const focalEntry = { path: focal.path, name: focal.name, start: focal.startLine, end: focal.endLine };
    // Past the per-pack cap or the emergency deadline a callable is never
    // silently left out: it is recorded as not resolved, and the gate
    // discloses it (the facet closure's own rule for a budget stop).
    if (index >= MAX_DEPENDENCY_FOCALS || Date.now() >= deadline) {
      records.push({
        entry: { facet: "value", clause: DEPENDENCY_VALUE_CLAUSE, subject: focal.name, dependency: true, resolution: "budget-exhausted", focal: focalEntry, windows: [] },
        fileShas: shasOf([focal.path]),
      });
      continue;
    }
    // The callable's OWN reads only — its module constants and, for a method,
    // the constants its `this.x` reads are assigned from — never a callee's
    // (an empty callee list skips that walk): a callee's constants mean
    // nothing without the callee's body, which a value facet requires too,
    // and were attributed as "LIMIT (read by checkout)" to a `checkout` that
    // never mentions LIMIT.
    const closure = await constantClosureForFocal(focal, workspace, fileCache, deadline, []);
    const ownWindows = closure.windows;
    const windows: FacetPlanWindow[] = [];
    for (const win of ownWindows) {
      windows.push({ kind: "constant", path: win.path, start: win.start, end: win.end, name: win.name, ...(win.truncated ? { truncated: true } : {}) });
      if (lineSpansCover(servedOf(win.path), { start: win.start, end: win.end })) continue;
      const range = `${win.start}-${win.end}`;
      const slice = centeredSliceForCap(workspace, win.path, range, fileCache, win.start);
      // A window that does not fit whole is left to the gate's ranged `next`.
      if (slice === undefined || slice.remaining_ranges.length > 0) continue;
      const bytes = Buffer.byteLength(slice.code, "utf8");
      if (bytesUsed + bytes > MAX_CLOSURE_BYTES_PER_PACK) continue;
      bytesUsed += bytes;
      const handle = handleTable.upsert({ kind: "range", path: win.path, range, workspaceRoot: workspace, sha: shaOfText(slice.code) });
      (result.surfaces as TaskPackResultSurface[]).push({
        role: classifySurface(win.path),
        handle: handle.id,
        path: win.path,
        range,
        required: true,
        why: `closure:value ${win.name} (read by ${focal.name})`,
        code: slice.code,
      });
      added += 1;
    }
    records.push({
      entry: {
        facet: "value",
        clause: DEPENDENCY_VALUE_CLAUSE,
        subject: focal.name,
        dependency: true,
        resolution: "resolved",
        focal: focalEntry,
        windows,
        ...(closure.unresolved.length > 0 ? { unresolvedConstants: closure.unresolved } : {}),
        ...(Object.keys(closure.unresolvedPackages).length > 0 ? { unresolvedConstantPackages: closure.unresolvedPackages } : {}),
        ...(Object.keys(closure.unresolvedConstantCandidates).length > 0 ? { unresolvedConstantCandidates: closure.unresolvedConstantCandidates } : {}),
        ...(Object.keys(closure.unresolvedDependencies).length > 0 ? { unresolvedDependencies: closure.unresolvedDependencies } : {}),
        ...(closure.complete ? {} : { constantsComplete: false }),
      },
      fileShas: shasOf([focal.path, ...ownWindows.map((win) => win.path)]),
    });
  }
  // One record per callable closed HERE; a callable an earlier hop of this
  // task closed keeps its record (facetGate.ts `recordFacetDependencyEntries`).
  recordFacetDependencyEntries(workspaceKey, query, records);
  return added;
}
