import type {ToolCall} from "@tokenlighten/types";
import type {TaskPackResult} from "./model.js";
import {codeTaskPackSurfaces} from "./artifactSections.js";
import {mergeSpans} from "./structureMap.js";
import {LISTED_ITEM_DERIVED_WHY} from "./listedScopeItems.js";
import {handleTable} from "../../util/handles.js";


export const REQUIRED_ENUM_REVIEW_PURPOSE = "edit-context: retained enum-derived review";
export const isRequiredEnumReview = (why: string | undefined): boolean =>
  why?.startsWith(LISTED_ITEM_DERIVED_WHY) === true || why?.startsWith(REQUIRED_ENUM_REVIEW_PURPOSE) === true;
const BUDGET_DEFERRED_SURFACES = Symbol("tl.budgetDeferredSurfaces");
type DeferredSurface = Readonly<{path: string; handle: string; range: string; action: "edit" | "review"; evidenceRequired?: boolean}>;
export function recordBudgetDeferredSurface(result: TaskPackResult, surface: DeferredSurface): void {
  const target = result as TaskPackResult & {[BUDGET_DEFERRED_SURFACES]?: DeferredSurface[]};
  target[BUDGET_DEFERRED_SURFACES] = [
    ...(target[BUDGET_DEFERRED_SURFACES] ?? []).filter(row => row.handle !== surface.handle), Object.freeze(surface),
  ];
}
function deferredSurfaceOrigin(result: TaskPackResult, path: string, handle?: string): DeferredSurface | undefined {
  return (result as TaskPackResult & {[BUDGET_DEFERRED_SURFACES]?: DeferredSurface[]})[BUDGET_DEFERRED_SURFACES]
    ?.find(row => row.path === path && row.handle === handle);
}

/** Retain the original change scope while its remaining context is delivered. */
export function changeScopeFollowupTarget(result: TaskPackResult): ToolCall | undefined {
  const contract = result.change_contract;
  const missingRows = [...(result.missing ?? []), ...(contract?.missing ?? [])];
  const deferred = (result.frontier_index ?? []).filter(row => typeof row.handle === "string"
    && missingRows.some(missing => missing.startsWith("dropped-by-byte-budget:" + row.path + " (")));
  // The frontier index is attached after some decision builds. The producer
  // also names its already-minted handle in this exact budget disclosure.
  for (const missing of missingRows) {
    const match = /^dropped-by-byte-budget:(.+) \(re-request via tl_read_file targets=\[\{handle:"([^"]+)"\}\]\)$/.exec(missing);
    if (match === null || deferred.some(row => row.path === match[1])) continue;
    const entry = handleTable.get(match[2]!);
    if (entry?.path === match[1] && entry.kind === "file") deferred.push({path: entry.path, role: "unknown", handle: entry.id});
  }
  const surfaces = codeTaskPackSurfaces(result.surfaces ?? []);
  const origins = (result as TaskPackResult & {[BUDGET_DEFERRED_SURFACES]?: DeferredSurface[]})[BUDGET_DEFERRED_SURFACES] ?? [];
  for (const origin of origins) if (!deferred.some(row => row.path === origin.path)) {
    const surface = surfaces.find(row => row.path === origin.path && row.handle === origin.handle);
    const disclosed = missingRows.some(missing => missing.startsWith("dropped-by-byte-budget:" + origin.path + " ("));
    if (disclosed || (origin.evidenceRequired && (surface === undefined || surface.content_completeness === "partial"
      || (surface.code === undefined && surface.code_unchanged === undefined)))) {
      deferred.push({path: origin.path, handle: origin.handle, role: "unknown"});
    }
  }
  if (result.task_profile === "answer" || result.wiring !== undefined || contract === undefined
    || (!contract.obligations.some(row => row.required && row.status === "needs-context") && deferred.length === 0)
    || contract.obligations.length + deferred.length > 24) return undefined;
  const targets: Array<{path?: string; handle?: string; range?: string; ranges?: string[]; purpose?: string}> = [];
  for (const obligation of contract.obligations) {
    const surface = surfaces.find(row => row.handle === obligation.handle && row.path === obligation.path);
    if (surface === undefined || !/^[0-9]+-[0-9]+$/.test(obligation.range)) return undefined;
    const rawRanges = [obligation.range, ...(surface.remaining_ranges ?? [])];
    if (rawRanges.some(range => !/^[0-9]+-[0-9]+$/.test(range))) return undefined;
    const spans = rawRanges.map(range => range.split("-").map(Number));
    if (spans.some(([start, end]) => !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
      || start! < 1 || end! < start!)) return undefined;
    const [scopeStart, scopeEnd] = spans[0]!;
    const remaining = spans.slice(1);
    // A partial surface already discloses exactly which parts are undelivered.
    // Re-requesting its entire range lets a fresh pack spend its budget on the
    // same prefix indefinitely. Only use that disclosure inside this scope;
    // an out-of-window remainder must retain the original address as well.
    const delivery = surface.content_completeness === "partial"
      && typeof surface.code === "string" && surface.code.length > 0
      && remaining.length > 0
      && remaining.every(([start, end]) => start! >= scopeStart! && end! <= scopeEnd!)
      ? remaining : spans;
    // A path address avoids stretching a narrow handle beyond its own window.
    const ranges = mergeSpans(delivery.map(([start, end]) => ({start: start!, end: end!})))
      .map(span => span.start + "-" + span.end);
    targets.push({path: obligation.path, ...(ranges.length === 1 ? {range: ranges[0]!} : {ranges}),
      ...(obligation.action === "review" ? {purpose: deferredSurfaceOrigin(result, obligation.path, obligation.handle)?.evidenceRequired
        ? REQUIRED_ENUM_REVIEW_PURPOSE : "edit-context: retained review"} : {})});
  }
  // Budget-deferred addresses already identified by this pack belong in the
  // same delivery batch; a later handle-only call would forget the held roles.
  const scopedPaths = new Set(targets.map(target => target.path));
  for (const row of deferred) if (!scopedPaths.has(row.path)) {
    const origin = deferredSurfaceOrigin(result, row.path, row.handle);
    targets.push({...(origin && /^[0-9]+-[0-9]+$/.test(origin.range) ? {path: origin.path, range: origin.range} : {handle: row.handle!}),
      ...(origin?.action === "edit" ? {} : {purpose: origin?.evidenceRequired
        ? REQUIRED_ENUM_REVIEW_PURPOSE : "edit-context: retained review"})});
  }
  return targets.length > 0 ? {tool: "tl_read_file", arguments: {targets}} : undefined;
}
