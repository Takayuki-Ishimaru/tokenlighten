// routing/classifier.ts — V10-04 route classification (beta.1, advisory only).
//
// DESIGN-v0.10-expansion-plan-v1.3.md V10-04 "Unified Context Orchestrator v1"
// asks for requests to be classified `known_local_fast / orchestrated /
// reuse_or_continuation` so exact-target calls can bypass heavy retrieval
// while the routing decision itself stays observable. V10-06 "Known-Local
// Fast Path v1" is the release-blocking half of that: proving heavy
// providers (candidate retrieval, symbol/text/reference search fan-out —
// today that machinery is `locateTaskContext`, see
// features/locator/locateTaskContext.ts) never fire for a call that already
// names its exact target.
//
// Per DESIGN-v0.10-expansion-plan-reconciliation.md §2.1/§4 beta.1, this is
// EXTRACT/MEASURE over the dispatch server.ts already has, not a new router:
// `dispatchTool` (server.ts) already routes implicitly today —
// mode=slice/handle reads and handle-scoped edits already skip the
// query-driven candidate pipeline (buildTaskPack / locateTaskContext), and
// mode=task_pack / search_files action=locate already run it. This module
// only NAMES that existing split so it can be traced. `classifyRoute` is a
// pure function of (tool, args): it must never be a second source of dispatch
// behavior, and no call may depend on its output in this wave (advisory
// instrumentation only — see server.ts's `callTool`, which records the
// decision via `trace()` and otherwise ignores it).
//
// Conservative by construction (plan's stated bias, V10-06 "受入基準":
// "ambiguous targetは100% orchestratedへfallbackする"): every branch below
// defaults to `orchestrated` unless the request shape is UNAMBIGUOUSLY a
// single exact local target (an explicit `handle`, or an explicit `path`
// paired with a mode that serves it directly) or an explicit continuation/
// replay token. When in doubt, this returns `orchestrated`.
//
// ---------------------------------------------------------------------------
// Rule table (route x reason x dispatch shape this mirrors)
// ---------------------------------------------------------------------------
//
// route                  | reason                  | dispatch shape (server.ts unless noted)
// -----------------------+--------------------------+----------------------------------------
// reuse_or_continuation  | qref-replay              | read_file: non-empty `qref` (resolveTaskPackQueryArg
//                        |                          | resolves it and IGNORES `query` — see
//                        |                          | resolveTaskPackQueryArg, ~server.ts:616-666)
// reuse_or_continuation  | cursor-page              | search_files: non-empty `cursor` (references
//                        |                          | pagination continuation token)
// reuse_or_continuation  | task-handle-replay       | any tool: non-empty `task_handle` (PI-09 —
//                        |                          | `taskHandleRefusal`/`resolveTaskHandle`,
//                        |                          | state/stateHandles.ts; replays a prior
//                        |                          | task_pack's `task.id`, see server.ts's
//                        |                          | `withTaskHandle`)
// reuse_or_continuation  | taskEpoch-continuation   | any tool: `taskEpoch` present and NOT "new"
//                        |                          | (the one value dispatch special-cases —
//                        |                          | `args["taskEpoch"] === "new"` clears the qref
//                        |                          | ledger, ~server.ts:621 — a non-"new" value is
//                        |                          | the caller's own continuation marker, not a
//                        |                          | reset)
// -----------------------+--------------------------+----------------------------------------
// orchestrated           | task-pack-query          | read_file: mode="task_pack"/"pack", OR any
//                        |                          | mode with a non-empty `query` (auto + query
//                        |                          | promotes to task_pack — see the schema's
//                        |                          | "auto ... plus a non-empty paths[] ALSO
//                        |                          | promotes to task_pack" comment, server.ts
//                        |                          | ~:717-721, and the observed `read.task_pack`
//                        |                          | kind on every bare mode-omitted+query call)
// orchestrated           | closure-query            | read_file: mode="closure"
// orchestrated           | surface-projection       | read_file: mode in {map, digest, overview,
//                        |                          | archive, artifact} — multi-file or
//                        |                          | structured/transformed projections, not a
//                        |                          | single raw slice (archive needs member
//                        |                          | resolution via selectorFromArgs; artifact
//                        |                          | needs sheet/slide/page addressing)
// orchestrated           | multi-path-target        | read_file: `paths[]` with 2+ entries (not
//                        |                          | "1 file/1 semantic target", V10-06 eligibility)
// orchestrated           | locate-query             | search_files: action="locate" (calls
//                        |                          | locateTaskContext directly, or buildTaskPack
//                        |                          | when includeClosure=true — server.ts ~:10196)
// orchestrated           | search-query             | search_files: action in {find, symbols,
//                        |                          | references (no cursor), tree, diff} — a
//                        |                          | search is discovery over an unknown location
//                        |                          | by definition, never "known local"
// orchestrated           | structured-artifact-edit | edit_file: `artifact` present (xlsx/docx/
//                        |                          | pptx/pdf/zip structured op)
// orchestrated           | edit-intent              | edit_file: `intent` present (semantic
//                        |                          | intent-based edit, e.g. rename-symbol-
//                        |                          | references — can span files)
// orchestrated           | rename-mode              | edit_file: mode="rename" (cross-file blast
//                        |                          | radius by construction)
// orchestrated           | create-no-provenance     | edit_file: `create===true` (no prior handle,
//                        |                          | so no base SHA — V10-06 eligibility requires
//                        |                          | one)
// orchestrated           | multi-item-edit-batch    | edit_file: `edits[]` with 2+ items
// orchestrated           | unanchored-edit          | edit_file: no qualifying handle-anchored
//                        |                          | single-target shape (path-only edits with no
//                        |                          | handle carry no base-SHA provenance either)
// orchestrated           | ambiguous-fallback       | read_file: unrecognized mode string, or
//                        |                          | mode=symbol with a path but no `symbol`, or
//                        |                          | no handle/path/query at all
// orchestrated           | unknown-tool             | any name outside {read_file, edit_file,
//                        |                          | search_files} (dispatchTool's own default
//                        |                          | case refuses these; classified conservatively
//                        |                          | rather than left undefined)
// -----------------------+--------------------------+----------------------------------------
// known_local_fast       | explicit-handle          | read_file: non-empty `handle`, no query (the
//                        |                          | handle IS the exact locator — server.ts's
//                        |                          | handle-resolution block, ~:4644-4735)
// known_local_fast       | explicit-range-slice     | read_file: mode="slice", or an explicit
//                        |                          | `range`/`ranges[]` with an explicit `path`
// known_local_fast       | explicit-symbol          | read_file: mode="symbol" with an explicit
//                        |                          | `path` AND `symbol`
// known_local_fast       | explicit-small-file      | read_file: mode="small_file" (one-call
//                        |                          | full+handle response for tiny files,
//                        |                          | server.ts ~:6721)
// known_local_fast       | explicit-skeleton        | read_file: mode="skeleton" with an explicit
//                        |                          | `path` (single-file compact symbol view)
// known_local_fast       | explicit-path-default    | read_file: mode="full", or mode="auto" with
//                        |                          | an explicit `path` and no range/symbol/query
// known_local_fast       | explicit-handle-edit     | edit_file: a handle-anchored single edit —
//                        |                          | top-level `handle` + (`search`+`replace` OR
//                        |                          | `range`+`content`), OR `edits[]` with exactly
//                        |                          | ONE handle-anchored item, and none of the
//                        |                          | artifact/intent/rename/create shapes above
//
// Everything not covered above (e.g. a read_file call with neither handle,
// path, nor query) falls through to `ambiguous-fallback` / `orchestrated`.

import { fastPathV2Enabled } from "../util/flags.js";
import { evaluateCheapImpactSignals, type ImpactGuardResult } from "../write/impactGuard.js";

// ---------------------------------------------------------------------------
// V11-06 addendum (behind TL_FAST_PATH_V2)
// ---------------------------------------------------------------------------
//
// `RouteDecision` gains an OPTIONAL `guard` field: the Cheap Impact Guard's
// (write/impactGuard.ts) verdict over an edit_file call's ARGS ALONE — path +
// search/replace TEXT, no file read, no graph probe. This function must stay
// pure and synchronous (this file's header), so only the guard's I/O-free
// half (`evaluateCheapImpactSignals`) is ever called from here; the graph-
// evidence half is wired exclusively from the real dispatch seam
// (tools/searchReplaceEdit.ts), which already performs I/O. `guard` is
// PURELY ADDITIVE and PURELY ADVISORY — it never changes `route`/`reason`,
// and server.ts's trace("route_decision", {tool, route: routeDecision.route,
// reason: routeDecision.reason}, …) call names those two fields explicitly,
// so it needs no change to keep ignoring this one.

/** The three route buckets V10-04 asks for. Advisory only — see file doc. */
export type Route = "known_local_fast" | "orchestrated" | "reuse_or_continuation";

/**
 * `reason` is a short machine token (kebab-case), not prose — it is meant to
 * be aggregated in telemetry, not read as a sentence. See the rule table
 * above for the fixed vocabulary this function actually emits.
 */
export interface RouteDecision {
  readonly route: Route;
  readonly reason: string;
  /**
   * V11-06, behind TL_FAST_PATH_V2 — see the addendum above. Present only for
   * an edit_file call carrying an explicit `path` (a handle-anchored edit
   * resolves its path only at dispatch time, which this pure classifier
   * never sees, so it is left undefined rather than guessed) and only when
   * the flag is on. Advisory / trace-only.
   */
  readonly guard?: ImpactGuardResult;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function hasEntries(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length > 0;
}

/**
 * Continuation/replay signals are checked before anything else, for every
 * tool: a caller presenting one of these is explicitly asking to resume or
 * page through prior work, which outranks whatever the rest of the call
 * shape looks like (e.g. `qref` makes dispatch IGNORE `query` entirely — see
 * resolveTaskPackQueryArg). TASK_STATE_PROPS (server.ts ~:498-546) advertises
 * `task_handle`/`taskEpoch` identically on all three tools, so this check is
 * tool-agnostic by design; `qref` and `cursor` are only ever meaningful on
 * read_file/search_files respectively, so checking them unconditionally on
 * the other tools is harmless (they will simply never be set there by a
 * well-formed caller).
 */
function continuationDecision(args: Record<string, unknown>): RouteDecision | null {
  if (isNonEmptyString(args["qref"])) {
    return { route: "reuse_or_continuation", reason: "qref-replay" };
  }
  if (isNonEmptyString(args["cursor"])) {
    return { route: "reuse_or_continuation", reason: "cursor-page" };
  }
  if (isNonEmptyString(args["task_handle"])) {
    return { route: "reuse_or_continuation", reason: "task-handle-replay" };
  }
  const taskEpoch = args["taskEpoch"];
  if (isNonEmptyString(taskEpoch) && taskEpoch !== "new") {
    return { route: "reuse_or_continuation", reason: "taskEpoch-continuation" };
  }
  return null;
}

/** Modes that resolve to a single raw slice/view of one already-named target. */
const KNOWN_LOCAL_READ_MODES = new Set<string>(["auto", "slice", "symbol", "full", "small_file", "skeleton"]);

/** Modes that are inherently multi-surface, transformed, or query-driven. */
const HEAVY_READ_MODES = new Set<string>(["task_pack", "pack", "closure", "map", "digest", "overview", "archive", "artifact"]);

function heavyReadModeReason(mode: string): string {
  if (mode === "task_pack" || mode === "pack") return "task-pack-query";
  if (mode === "closure") return "closure-query";
  return "surface-projection"; // map | digest | overview | archive | artifact
}

/** Extracts a single explicit path out of a `paths[]` array of length 1 (string or {path,...} entry). */
function soleExplicitPath(paths: unknown): string | undefined {
  if (!Array.isArray(paths) || paths.length !== 1) return undefined;
  const [entry] = paths;
  if (typeof entry === "string") return entry.length > 0 ? entry : undefined;
  if (entry !== null && typeof entry === "object") {
    const path = (entry as Record<string, unknown>)["path"];
    if (isNonEmptyString(path)) return path;
  }
  return undefined;
}

function classifyReadFile(args: Record<string, unknown>): RouteDecision {
  const mode = isNonEmptyString(args["mode"]) ? args["mode"] : "auto";

  // Explicit heavy/multi-surface modes win outright, before anything else —
  // an agent that asked for task_pack/pack/closure/map/digest/overview/
  // archive/artifact gets that pipeline regardless of what else it passed.
  if (HEAVY_READ_MODES.has(mode)) {
    return { route: "orchestrated", reason: heavyReadModeReason(mode) };
  }

  // A `query` is the plan's own discriminant ("task queryはQuery
  // Normalization、candidate retrieval、fusion...へ流す") — present under any
  // OTHER mode, it still means the caller wants the heavy pipeline (mode=auto
  // + query is the documented, observed task_pack promotion).
  if (isNonEmptyString(args["query"])) {
    return { route: "orchestrated", reason: "task-pack-query" };
  }

  // 2+ explicit paths is a multi-target read: not "1 file/1 semantic target"
  // (V10-06 eligibility), even though every target is named exactly.
  const paths = args["paths"];
  if (hasEntries(paths) && (paths as unknown[]).length > 1) {
    return { route: "orchestrated", reason: "multi-path-target" };
  }

  // A handle IS the exact locator (path/range/symbol resolved at mint time) —
  // wins over everything below regardless of which of the light modes it
  // rides on.
  if (isNonEmptyString(args["handle"])) {
    return { route: "known_local_fast", reason: "explicit-handle" };
  }

  if (!KNOWN_LOCAL_READ_MODES.has(mode)) {
    // An unrecognized mode string reaches dispatch's own invalid-input
    // refusal; classify conservatively rather than guess its shape.
    return { route: "orchestrated", reason: "ambiguous-fallback" };
  }

  const path = isNonEmptyString(args["path"]) ? args["path"] : soleExplicitPath(paths);
  if (!isNonEmptyString(path)) {
    // No handle, no path, no query: nothing exact to anchor a fast path to.
    return { route: "orchestrated", reason: "ambiguous-fallback" };
  }

  if (mode === "symbol" && !isNonEmptyString(args["symbol"])) {
    // mode=symbol with a path but no symbol name is a listing over an
    // unbounded surface, not a single named declaration (PI-06: only a
    // parser-proven, EXPLICITLY named declaration is a trustworthy symbol
    // target — a bare path is not one).
    return { route: "orchestrated", reason: "ambiguous-fallback" };
  }

  const explicitRange = isNonEmptyString(args["range"]) || hasEntries(args["ranges"]);
  if (mode === "slice" || explicitRange) {
    return { route: "known_local_fast", reason: "explicit-range-slice" };
  }
  if (mode === "symbol") {
    return { route: "known_local_fast", reason: "explicit-symbol" };
  }
  if (mode === "small_file") {
    return { route: "known_local_fast", reason: "explicit-small-file" };
  }
  if (mode === "skeleton") {
    return { route: "known_local_fast", reason: "explicit-skeleton" };
  }
  // mode === "full", or "auto" with no range/symbol — the single named
  // file's own default view.
  return { route: "known_local_fast", reason: "explicit-path-default" };
}

/** True for a single edit_file item that anchors on a handle with a complete search/replace or range/content pair. */
function isSingleTargetEditShape(item: Record<string, unknown>): boolean {
  if (!isNonEmptyString(item["handle"])) return false;
  const hasSearchReplace = isNonEmptyString(item["search"]) && typeof item["replace"] === "string";
  const hasRangeContent = isNonEmptyString(item["range"]) && typeof item["content"] === "string";
  return hasSearchReplace || hasRangeContent;
}

function classifyEditFileRoute(args: Record<string, unknown>): RouteDecision {
  // Structured/semantic/cross-file edit shapes are excluded outright — each
  // one can touch more than the one span a handle pins, so none of them are
  // "1 semantic target, low blast radius" (V10-06 eligibility).
  if (args["artifact"] !== undefined && args["artifact"] !== null) {
    return { route: "orchestrated", reason: "structured-artifact-edit" };
  }
  if (isNonEmptyString(args["intent"])) {
    return { route: "orchestrated", reason: "edit-intent" };
  }
  if (args["mode"] === "rename") {
    return { route: "orchestrated", reason: "rename-mode" };
  }
  if (args["create"] === true) {
    // A new file has no prior handle and therefore no base SHA — V10-06
    // eligibility explicitly requires one ("base SHA" in its criteria list).
    return { route: "orchestrated", reason: "create-no-provenance" };
  }

  const edits = args["edits"];
  if (Array.isArray(edits)) {
    if (
      edits.length === 1
      && edits[0] !== null
      && typeof edits[0] === "object"
      && isSingleTargetEditShape(edits[0] as Record<string, unknown>)
    ) {
      return { route: "known_local_fast", reason: "explicit-handle-edit" };
    }
    return { route: "orchestrated", reason: edits.length > 1 ? "multi-item-edit-batch" : "unanchored-edit" };
  }

  if (isSingleTargetEditShape(args)) {
    return { route: "known_local_fast", reason: "explicit-handle-edit" };
  }

  // No qualifying handle (a bare `path` + search/replace carries no base-SHA
  // provenance — it never went through a TL read first).
  return { route: "orchestrated", reason: "unanchored-edit" };
}

/**
 * V11-06 (behind TL_FAST_PATH_V2): the Cheap Impact Guard's I/O-free half,
 * evaluated over whatever an edit_file call's ARGS ALONE can prove. Returns
 * undefined (no guard field at all — not a manufactured "local" verdict) when
 * the flag is off or the call carries no explicit `path` to evaluate against.
 */
function cheapGuardForEditFile(args: Record<string, unknown>): ImpactGuardResult | undefined {
  if (!fastPathV2Enabled()) return undefined;
  const path = args["path"];
  if (!isNonEmptyString(path)) return undefined;
  const search = args["search"];
  const replace = args["replace"];
  return evaluateCheapImpactSignals({
    path,
    searchText: typeof search === "string" ? search : undefined,
    replaceText: typeof replace === "string" ? replace : undefined,
  });
}

function classifyEditFile(args: Record<string, unknown>): RouteDecision {
  const decision = classifyEditFileRoute(args);
  const guard = cheapGuardForEditFile(args);
  return guard === undefined ? decision : { ...decision, guard };
}

function classifySearchFiles(args: Record<string, unknown>): RouteDecision {
  // search_files is a discovery tool by construction: every action answers
  // "where is X", which is the opposite of "I already know exactly where
  // this is". None of its actions are known_local_fast; `locate` gets its
  // own reason since the plan names it explicitly.
  return args["action"] === "locate"
    ? { route: "orchestrated", reason: "locate-query" }
    : { route: "orchestrated", reason: "search-query" };
}

/**
 * Pure classification of a dispatch-bound call into V10-04's three route
 * buckets. Never call this to GATE behavior in this wave (advisory only —
 * see the file doc comment); it exists to make an already-implicit routing
 * decision observable.
 */
export function classifyRoute(tool: string, args: Record<string, unknown>): RouteDecision {
  const continuation = continuationDecision(args);
  if (continuation !== null) return continuation;

  switch (tool) {
    case "read_file":
      return classifyReadFile(args);
    case "edit_file":
      return classifyEditFile(args);
    case "search_files":
      return classifySearchFiles(args);
    default:
      return { route: "orchestrated", reason: "unknown-tool" };
  }
}
