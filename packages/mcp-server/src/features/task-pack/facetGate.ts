// facetGate.ts — FIX-G (eval-0927 P0, 2026-09-27): the answer-sufficiency
// GATE for request facets. Pure and fs-free (every input is plain data or an
// injected callback), mirroring requestFacets.ts / evidenceClosure.ts.
//
// PROBLEM (eval-0927.md §3-§4, brief-fix-g.md). FIX-C1's closure hook
// (readCodeTaskPack.ts, beside the caller-expansion hook) SERVES the evidence a
// faceted question needs — the module constants a focal callable reads, its
// call sites, its callees — but nothing CHECKED it: certificate obligations
// were only `surface-content`, `identifier:<X>` (any mention of X),
// `behavior-body` and topic request items, so a pack whose closure windows
// were trimmed, capped or never computed still certified `act.answer`
// ("the callers of fetchWithRetry" was "proved" by the definition's own name).
//
// WHAT THIS MODULE DOES. For each `FacetRequirement` of the query it decides,
// from (a) the closure PLAN the hook recorded for that query and (b) the line
// spans actually served in this epoch, one of four FACTS:
//   covered       every required window is served;
//   empty         verified empty (0 call sites in the scanned scope; a focal
//                 that reads no module constant and holds no literal) — the
//                 served focal IS the evidence, the empty fact is disclosed
//                 (a question that only asks what that focal RETURNS is
//                 covered instead when its served body returns an expression:
//                 the body is the answer, 2026-10-10);
//   open          required windows are known but not (fully) served — the
//                 exact unserved sub-spans are returned as read targets;
//   undetermined  no plan / no focal / budget ran out / a constant the focal
//                 reads has no declaration in the scanned workspace / more
//                 call sites than the bound — disclosed, never silent.
// The STATUS is NOT decided here: readCodeTaskPack.ts maps these facts onto
// THE ONE concern-status policy (`decideConcernStatus`), so there is still
// exactly one status vocabulary (covered / absent-in-scope /
// could-not-determine / open) for every request-item path.
//
// THE PLAN MEMO. The closure's focal resolution needs the pack's own selected
// candidates and an async parse, and only the FIRST answer pack of a query
// runs the hook (a qref replay / a targets follow-up re-serves a decided pack).
// The contract builder that must judge every hop is synchronous and sees only
// (result, query, workspace). So the hook records its plan here, keyed by the
// resolved query text, and every later hop of the same query in this process
// judges against the SAME plan (a tier-3 concept focal is pinned, never
// re-guessed from a different selection). Bounded FIFO, and every entry
// carries the sha of each file it names so an edited file invalidates the plan
// instead of mis-addressing stale lines. A lost/evicted/stale plan degrades to
// an honest `undetermined` disclosure — never to a silent pass.
//
// GENERALITY (brief-common rule 5): nothing here knows a file name, query or
// identifier. Windows, sites and spans are language-independent line
// arithmetic; the per-language work (declarations, imports, call shapes) is
// evidenceClosure.ts's and callerExpansion.ts's.

import { asksForCallableResult, type FacetRequirement, type RequestFacet } from "./requestFacets.js";
import { hasHashComments } from "./callerExpansion.js";
import { declarationRealExtent } from "./evidenceClosure.js";
import { languageForPath } from "../../util/languages.js";

// ---------------------------------------------------------------------------
// Plan types (recorded by the hook, read by the gate)
// ---------------------------------------------------------------------------

export interface FacetLineSpan {
  readonly start: number;
  readonly end: number;
}

/** What a required window stands for. */
export type FacetWindowKind = "focal" | "constant" | "callee" | "caller";

export interface FacetPlanWindow {
  readonly kind: FacetWindowKind;
  readonly path: string;
  readonly start: number;
  readonly end: number;
  /** Constant / callee / caller-enclosing symbol name (for reasons and TL_TRACE only). */
  readonly name: string;
  /** FIX-FAB item 6 (eval-0927 review #10, bigConstants): true for a `constant` window whose recorded `[start,end]` is a CAP, not the declaration's real close (evidenceClosure.ts's `ConstantWindow.truncated`, propagated through `NamedWindow`). The gate never treats this window as fully covering the value merely because `[start,end]` itself is served — see `evaluateFacetRequirement`'s continuation handling below. Absent/false for every other window. */
  readonly truncated?: boolean;
}

export interface FacetCallSite {
  readonly path: string;
  readonly line: number;
}

/** MENTION GUARD (R5-A1): one word-bounded mention line of a callers/flow facet's member that the recording scan could not classify — see `FacetPlanEntry.unclassifiedMentions`. */
export interface FacetMentionLine {
  readonly path: string;
  readonly line: number;
}

/** MENTION GUARD (R5-A1): bound on how many `unclassifiedMentions` one facet entry ever records — past it the facet is undetermined outright (too many to disclose or page through in one pass), never partially served. */
export const MAX_UNCLASSIFIED_MENTION_LINES = 24;

export interface FacetPlanEntry {
  readonly facet: RequestFacet;
  /** `FacetRequirement.clause`, verbatim — the join key with a re-extracted requirement. */
  readonly clause: string;
  /**
   * 2026-10-06 independent review (P1-4): set on the entries a requirement
   * naming SEVERAL subjects adds beside its primary one — the subject (the
   * declaration's name) this entry's focal answers. "Explain retryDelay and
   * calculateTotal, including … callers" plans retryDelay's callers (no
   * `subject`) and calculateTotal's (`subject: "calculateTotal"`) under the
   * same (facet, clause); the gate requires every one of them. Absent on the
   * primary entry and on every single-subject requirement.
   */
  readonly subject?: string;
  /**
   * 2026-10-06 independent review (P1-1/P1-2): true on the `value` entries
   * readCodeTaskPack.ts's `runAnswerDependencyClosure` records for a callable
   * an answer pack serves whole — the constants its body reads, whatever the
   * question's wording asked. Never a query clause's entry: `clause` is a
   * fixed marker no requirement or request item matches, and the gate checks
   * these entries on their own (an unserved window keeps the pack open; a
   * covered or empty one adds nothing to the wire).
   */
  readonly dependency?: boolean;
  readonly resolution: "resolved" | "no-focal" | "budget-exhausted";
  /** `callable:false` = the focal is a type (class / interface / enum / struct …): its served declaration IS the value evidence, and the callable-only "reads no constant, holds no literal" emptiness never applies. Absent = callable. */
  readonly focal?: { readonly path: string; readonly name: string; readonly start: number; readonly end: number; readonly callable?: boolean };
  /** Required closure windows (constants / callees; for callers the served enclosing windows are informational — `callSites` is the requirement). */
  readonly windows: readonly FacetPlanWindow[];
  /** callers / flow: every call site found (ranked, bounded by the recorder), cross-file AND same-file outside the focal's own body. */
  readonly callSites?: readonly FacetCallSite[];
  /** callers / flow: how many call sites the scan found in total (may exceed `callSites.length`). */
  readonly totalCallSites?: number;
  /** callers / flow: false when the call-site scan stopped at its time budget before it finished. */
  readonly callSitesComplete?: boolean;
  /**
   * P1-7 (eval-0927 review-r2 #7's residual, goMethodManyCallers): true when
   * MORE files mentioned the member than the scan's own
   * MAX_FACET_CALLER_FILES_CLASSIFIED (128, word-bounded mentions) ever opened (readCodeTaskPack.ts's `CallerScanResult.filesCapped`) — a
   * DIFFERENT fact from `callSitesComplete`, which reads `true` here too
   * (every file the scan intended to open, given the already-capped
   * candidate list, it did). Absent/false = the scan saw every file that
   * mentioned the member at all.
   */
  readonly callSitesFilesCapped?: boolean;
  /**
   * P2-10 (eval-0927 review-r3 #10, manyCallers60in3): true when the scan
   * found MORE call sites than the recorder's own memo-size cap
   * (readCodeTaskPack.ts's `MAX_RECORDED_FACET_CALL_SITES`) could hold —
   * a DIFFERENT fact from `callSitesFilesCapped` (which is about caller
   * FILES the scan never even opened at all): here every file was opened
   * and every site in it was found, only the RECORDING of the tail was cut.
   * Distinguished on the wire so the two causes are never conflated in a
   * disclosure's wording, and so a raise of one cap is never mistaken for
   * covering the other.
   */
  readonly callSitesRecordedCapped?: boolean;
  /** callers / flow: true when the scan skipped test files (the request did not mention tests) — stated in an empty disclosure. */
  readonly callSitesExcludeTests?: boolean;
  /** flow: true when the focal body makes at least one call (resolved or not) — a flow with no caller and no RESOLVED callee is then undetermined, never "empty". */
  readonly focalMakesCalls?: boolean;
  /** value / condition: constant-shaped names the focal (or a one-hop callee) reads for which no declaration was found in the scanned workspace. */
  readonly unresolvedConstants?: readonly string[];
  /** value / condition (P2-10, round-6 fable finding, externalPackageConst): `unresolvedConstants` entries resolved to a non-relative IMPORT specifier -- name -> the package that named it, so the disclosure can name the package ("imported from package X; its declaration could not be resolved") instead of the generic wording -- never "declared outside the workspace", which a workspace package or a path alias would make false. Absent/entry-missing = that name's origin is unknown (the generic wording still applies to it). */
  readonly unresolvedConstantPackages?: Readonly<Record<string, string>>;
  /** value / condition (P0-2, round-6 fable finding): instance/static property names (`this.p`/`self.p`/`Owner.P`) the focal reads whose value `constantClosureForFocal`'s self-property chase (readCodeTaskPack.ts) could not resolve to any served window -- the owner declaration was not found in the class body at all, or it was found but its own initializer resolved to nothing servable. A value/condition facet is never `covered` by an inline literal while this is non-empty (P3): "the focal reads this.logger too" is not itself grounds for undetermined -- see `selfPropertyReferencesIn`'s own bare-receiver-call guard, which keeps a property used only as a discarded side-effecting call (`this.logger.info(...)`) out of this list in the first place. */
  readonly unresolvedSelfProperties?: readonly string[];
  /** value / condition (V4, round-7 fable finding, valueBehindConfigAccessor): name -> the exact construction/call expression (`new Settings()`) for a resolved binding whose own text carries no literal and is nothing but that one call -- never pushed as a served window (P3: never silently "covered" merely because a construction call was found), disclosed with the expression itself so the caller knows exactly what this pack did not follow. */
  readonly unresolvedConstructedValues?: Readonly<Record<string, string>>;
  /** value / condition (P1-4, round-7 fable finding, item 4): `unresolvedConstants` entries (a qualified `Owner.member` name) for which SEVERAL workspace files declare `Owner` and neither the focal's own file nor its own imports proved which one -- name -> the candidate file paths, so the disclosure can name them instead of the generic "could not be resolved" wording (never silently picks one, P1). Absent/entry-missing = not an ambiguous-owner case (the generic or package wording still applies to it). */
  readonly unresolvedConstantCandidates?: Readonly<Record<string, readonly string[]>>;
  /**
   * value / condition (FIX-ALIAS, eval-0929 §4, root cause 2): name -> a
   * short attribution ("read by CLIENT_DEFAULTS in src/defaults.ts") for a
   * name a SERVED window's own text reads (depth >= 1 — a dependency of that
   * window's OWN value, e.g. an aliased import the window's file could not
   * chase to its real declaration) that this scan could not resolve. Distinct
   * from `unresolvedConstants` (the focal's OWN depth-0 reads — this never
   * duplicates a name already there) so a disclosure never says "read by
   * ${focal.name}" for a name the focal itself never mentions, mislabeling
   * whose read it is. Absent/entry-missing = no such dependency miss.
   */
  readonly unresolvedDependencies?: Readonly<Record<string, string>>;
  /** value / condition: false when the constant scan stopped at its time budget. */
  readonly constantsComplete?: boolean;
  /** flow, non-callable focal only (FIX-FAB2): false when more of the focal's own members matched the clause than MAX_CALLEES_PER_REQUIREMENT allowed to be served — the member list itself was cut, never silently. */
  readonly flowMembersComplete?: boolean;
  /** flow / value / condition, callable focal (Copilot retest 2026-10-02): false when the focal's direct callee list was cut at MAX_SCANNED_CALLEE_NAMES / MAX_REQUIRED_CALLEE_WINDOWS (readCodeTaskPack.ts `calleeDefinitionsForFocal`) -- the facet is then undetermined, never covered by the callees that did fit. Absent = taken whole. */
  readonly calleesComplete?: boolean;
  /** flow, non-callable focal only (FIX-FAB2): clause subject terms (length >= 3, excluding the focal's own name and — 2026-10-10 — the clause's non-point words, requestFacets.ts `nonPointTermsIn`) that matched NO member of the focal at all — a non-empty list means the clause names something no served member accounts for, so the facet is never "covered" (P1/P3). */
  readonly ungroundedFlowTerms?: readonly string[];
  /**
   * MENTION GUARD (R5-A1, the round-5 principle). `callers`/`flow` only:
   * word-bounded mention lines of the focal's member, in the SAME examined
   * files as `callSites`, that the recording scan (readCodeTaskPack.ts)
   * could not classify as a recorded call site, a declaration of the
   * member, an import/export specifier line, or wholly a comment. These are
   * REQUIRED windows exactly like a call site (see `evaluateFacetRequirement`):
   * unserved -> `open` (a `next`); served -> the facet may still be
   * `covered` when real call sites exist too, and is `undetermined` (NEVER
   * `empty`) when none do — a `request-item-empty:callers:*` must become
   * structurally impossible while any such unexplained mention exists,
   * whatever gap remains in the declaration/call-site classifier itself.
   * Absent/empty = no unclassified mention was found (or the facet is not
   * callers/flow).
   */
  readonly unclassifiedMentions?: readonly FacetMentionLine[];
  /** MENTION GUARD: true when MORE than MAX_UNCLASSIFIED_MENTION_LINES such lines were found — the facet is undetermined outright (never partially served, never silently truncated to "24 of many"). */
  readonly unclassifiedMentionsCapped?: boolean;
  /**
   * P0-2 (R7-A, eval-0927 review-r6 finding 2, defaultExportedDeclCaller):
   * `callers` only — true when the focal's own declaration statement is
   * written as its module's default export (readCodeTaskPack.ts's
   * `focalIsSoleDefaultExport`). Every importer of this module binds the
   * value under a name of ITS OWN CHOOSING, invisible to the by-NAME
   * call-site scan, so a ZERO recorded-site result never proves there is no
   * caller — see `evaluateFacetRequirement`'s own hookup (checked only when
   * `total === 0`; a real corroborated site still counts as covered).
   * Absent/false = the focal's declaration is not its module's default
   * export, or the facet is not `callers`.
   */
  readonly focalDefaultExported?: boolean;
  /**
   * value / condition (WP-F, eval-0929 §7 bullet 3 / §8 row 4,
   * `same_name_distractor` / readLimit chip task_b5ca96e5 / the
   * `condvals_path` addition): set instead of `focal` when >= 2 files
   * declared this requirement's own subject identifier and neither an
   * explicit file path the question named nor an import relation from a
   * file the pack already anchors on could tell which one it means
   * (readCodeTaskPack.ts's `findDeclaredCallableAmong` /
   * `ResolvedFacetFocal.ambiguousWith`). `name` is the shared identifier
   * every listed path declares; `paths` are the candidate files themselves
   * (bounded, ≤ MAX_SAME_NAME_CANDIDATES), so the disclosure can name them
   * instead of certifying an arbitrary pick as `covered`/`empty` (a same-
   * named DECOY's own empty body must never stand in for the real
   * declaration's actual values/conditions). Absent/undefined = not an
   * ambiguous-focal case.
   */
  readonly ambiguousFocal?: { readonly name: string; readonly paths: readonly string[] };
}

export interface FacetPlan {
  /** The resolved query text the plan was computed for (the memo key). */
  readonly query: string;
  readonly entries: readonly FacetPlanEntry[];
  /** sha of every file an entry names, at plan time — a mismatch invalidates the whole plan. */
  readonly fileShas: Readonly<Record<string, string>>;
}

// ---------------------------------------------------------------------------
// The plan memo (in-process, bounded FIFO — same discipline as
// taskContractStore.ts / priorPackStore.ts; never persisted, never on the wire)
// ---------------------------------------------------------------------------

/** Distinct queries remembered per workspace root. */
export const MAX_FACET_PLANS_PER_WORKSPACE = 32;
/** Distinct workspace roots remembered. */
export const MAX_FACET_PLAN_WORKSPACES = 16;

const facetPlans = new Map<string, Map<string, FacetPlan>>();

export function recordFacetPlan(workspaceKey: string, plan: FacetPlan): void {
  let byQuery = facetPlans.get(workspaceKey);
  if (byQuery === undefined) {
    if (facetPlans.size >= MAX_FACET_PLAN_WORKSPACES) {
      const oldest = facetPlans.keys().next().value;
      if (oldest !== undefined) facetPlans.delete(oldest);
    }
    byQuery = new Map();
    facetPlans.set(workspaceKey, byQuery);
  }
  byQuery.delete(plan.query); // re-insert = newest
  if (byQuery.size >= MAX_FACET_PLANS_PER_WORKSPACE) {
    const oldest = byQuery.keys().next().value;
    if (oldest !== undefined) byQuery.delete(oldest);
  }
  byQuery.set(plan.query, plan);
  // A freshly computed plan starts a fresh delivery record (a new epoch's
  // first pack re-plans; see `noteUndeliveredFacetLines`).
  clearUndeliveredFacetLines(workspaceKey, plan.query);
}

// ---------------------------------------------------------------------------
// Dependency entries (2026-10-06 independent review, P1-1/P1-2) — the
// constants a callable an answer pack served whole reads
// (readCodeTaskPack.ts `runAnswerDependencyClosure`). Kept apart from the
// query-clause plan on purpose: `recordFacetPlan` re-plans the clauses on
// every pack of a task, but what a callable served on an EARLIER hop reads
// stays owed until it is delivered, whether or not a later hop serves that
// callable again. Measured: a 152-line table read by `priceFor` was paged over
// hops, and the second hop (a ranged read of the table alone) dropped the
// entry and certified with 32 of its lines never served. One record per
// callable (path + name), replaced when that callable is closed again; a
// record whose own files changed since is ignored, never merged.
// ---------------------------------------------------------------------------

/** Dependency records remembered per (workspace, query); the oldest leave first. */
export const MAX_FACET_DEPENDENCY_RECORDS = 32;

export interface FacetDependencyRecord {
  readonly entry: FacetPlanEntry;
  /** sha of the focal's file and of every window's file, when the record was made. */
  readonly fileShas: Readonly<Record<string, string>>;
}

const dependencyRecords = new Map<string, Map<string, FacetDependencyRecord[]>>();

function dependencyKey(entry: FacetPlanEntry): string {
  return `${entry.focal?.path ?? ""}\u0000${entry.focal?.name ?? entry.subject ?? ""}`;
}

/** Records `records` for `query`, each replacing the record of the same callable. */
export function recordFacetDependencyEntries(
  workspaceKey: string,
  query: string,
  records: readonly FacetDependencyRecord[],
): void {
  if (records.length === 0) return;
  let byQuery = dependencyRecords.get(workspaceKey);
  if (byQuery === undefined) {
    if (dependencyRecords.size >= MAX_FACET_PLAN_WORKSPACES) {
      const oldest = dependencyRecords.keys().next().value;
      if (oldest !== undefined) dependencyRecords.delete(oldest);
    }
    byQuery = new Map();
    dependencyRecords.set(workspaceKey, byQuery);
  }
  const replaced = new Set(records.map((record) => dependencyKey(record.entry)));
  const kept = (byQuery.get(query) ?? []).filter((record) => !replaced.has(dependencyKey(record.entry)));
  byQuery.delete(query); // re-insert = newest
  if (byQuery.size >= MAX_FACET_PLANS_PER_WORKSPACE) {
    const oldest = byQuery.keys().next().value;
    if (oldest !== undefined) byQuery.delete(oldest);
  }
  byQuery.set(query, [...kept, ...records].slice(-MAX_FACET_DEPENDENCY_RECORDS));
}

/** The dependency entries recorded for `query` whose files are all unchanged (`currentSha` as in `facetPlanFor`). */
export function facetDependencyEntriesFor(
  workspaceKey: string,
  query: string,
  currentSha: (path: string) => string | undefined,
): FacetPlanEntry[] {
  const records = dependencyRecords.get(workspaceKey)?.get(query) ?? [];
  return records
    .filter((record) => Object.entries(record.fileShas).every(([path, sha]) => currentSha(path) === sha))
    .map((record) => record.entry);
}

/**
 * The plan recorded for `query`, or `undefined` when none was recorded or any
 * file it names changed since (`currentSha` returns the file's sha NOW, or
 * `undefined` when unreadable — both invalidate).
 */
export function facetPlanFor(
  workspaceKey: string,
  query: string,
  currentSha: (path: string) => string | undefined,
): FacetPlan | undefined {
  const plan = facetPlans.get(workspaceKey)?.get(query);
  if (plan === undefined) return undefined;
  for (const [path, sha] of Object.entries(plan.fileShas)) {
    if (currentSha(path) !== sha) return undefined;
  }
  return plan;
}

export function resetFacetPlansForTest(): void {
  facetPlans.clear();
  undeliveredLines.clear();
  dependencyRecords.clear();
}

// ---------------------------------------------------------------------------
// Undelivered windows — the gate's own termination guarantee.
//
// A facet `next` names exact unserved windows. If the follow-up call that
// requested a window returns it with NO body at all (a withheld/receipted
// window, a residency claim the served-range ledger does not confirm), asking
// for it again returns the same nothing: measured, two such target sets
// alternated forever. So a line a caller-supplied surface requested and got no
// byte of is remembered (per workspace + query, reset whenever the plan is
// re-recorded) and never requested again; a facet whose remaining evidence is
// all undelivered becomes could-not-determine (disclosed) instead of open.
// Budget paging — part of the body shipped, the rest in `remaining` — is
// progress and is never recorded here.
// ---------------------------------------------------------------------------

const undeliveredLines = new Map<string, Map<string, Map<string, Set<number>>>>();

export function noteUndeliveredFacetLines(workspaceKey: string, query: string, path: string, spans: readonly FacetLineSpan[]): void {
  if (spans.length === 0) return;
  let byQuery = undeliveredLines.get(workspaceKey);
  if (byQuery === undefined) {
    byQuery = new Map();
    undeliveredLines.set(workspaceKey, byQuery);
  }
  let byPath = byQuery.get(query);
  if (byPath === undefined) {
    if (byQuery.size >= MAX_FACET_PLANS_PER_WORKSPACE) {
      const oldest = byQuery.keys().next().value;
      if (oldest !== undefined) byQuery.delete(oldest);
    }
    byPath = new Map();
    byQuery.set(query, byPath);
  }
  let lines = byPath.get(path);
  if (lines === undefined) {
    lines = new Set();
    byPath.set(path, lines);
  }
  for (const span of spans) for (let line = span.start; line <= span.end; line++) lines.add(line);
}

/** Lines of `path` a facet may no longer request for `query` (merged spans). */
export function undeliveredFacetSpans(workspaceKey: string, query: string, path: string): FacetLineSpan[] {
  const lines = undeliveredLines.get(workspaceKey)?.get(query)?.get(path);
  if (lines === undefined || lines.size === 0) return [];
  return mergeSpans([...lines].map((line) => ({ start: line, end: line })));
}

function clearUndeliveredFacetLines(workspaceKey: string, query: string): void {
  undeliveredLines.get(workspaceKey)?.delete(query);
}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/**
 * A focal callable longer than this is not itself a required window for a
 * VALUE facet (its constants / callees still are) — requiring a 300-line body
 * to answer "the default X" would read far more than the question needs. It is
 * also the bound of the window the closure hook serves on its own
 * (`focalRequiredSpan`).
 *
 * R2-T1 (eval-0929 review P0-3, orchestrator ruling 2026-09-30): the waiver is
 * a VALUE rule only. A CONDITION or FLOW question about a callable is answered
 * from the body itself — its branches, its steps — and no constant stands in
 * for them: measured, "mayRetry の条件と RETRY_CODES の実際の値を説明して" over a
 * 300-line function certified `act.answer` with the constants and the
 * signature line and not one of its 300 branches (budget 8192), and the
 * no-ceiling pack certified "all conditions" over 142 of 304 lines. So for
 * those two facets a long callable focal is required WHOLE
 * (`focalRequiredWindow`): the part the pack could not ship is `open` (the
 * gate's ordinary exact, ranged read of the rest), and a part already asked
 * for and never delivered is disclosed `undetermined` by that range — never
 * covered from constants or a signature alone. A focal of at most this many
 * lines is unchanged, and so is every value / callers facet.
 */
export const MAX_FACET_FOCAL_LINES = 80;
/**
 * Call sites embedded in ONE hop's serving pass (readCodeTaskPack.ts's own
 * per-hop budget for how many sites it adds surfaces for). Used here only to
 * size a disclosure's example list — see `evaluateFacetRequirement`'s own
 * P1-7 comment (eval-0927 review-r2 #7) for why the GATE's own completeness
 * bar is no longer capped at this number: capping it here (the OLD
 * behaviour) meant that once the first `MAX_REQUIRED_CALL_SITES` sites were
 * served, sites past it could never become a read target on ANY later hop
 * either (the same fixed slice, re-taken every hop) — "24 of 32 call sites
 * served; the rest were not read" with no `next` to continue it, however
 * many hops followed. The recorder's own cap (`MAX_RECORDED_FACET_CALL_SITES`,
 * readCodeTaskPack.ts) is the real completeness bound now: everything it
 * kept is required, and pagination across hops falls out of the ordinary
 * `open`/`next` mechanism the SAME way an unserved constant or focal window
 * already does.
 */
export const MAX_REQUIRED_CALL_SITES = 24;
/** Context lines on each side of an unserved call site's read window — callerExpansion.ts's CALLER_WINDOW_MARGIN_LINES. */
export const FACET_CALL_SITE_MARGIN_LINES = 12;
/** Longest clause label a disclosure repeats verbatim. */
const MAX_FACET_LABEL_CHARS = 60;

// ---------------------------------------------------------------------------
// Labels and clause matching
// ---------------------------------------------------------------------------

/** A trailing / leading coordinator a clause splitter left on its piece ("Show the default values and"). */
const EDGE_CONJUNCTION_RE = /^(?:and|or|also|plus)\s+|\s+(?:and|or|also|plus)$/iu;

/** `clause` trimmed of edge punctuation and a dangling coordinator (uncapped). */
function trimClause(clause: string): string {
  let label = clause.trim().replace(/^[\s,、;；:：.。!?！？]+|[\s,、;；:：.。!?！？]+$/gu, "");
  for (let i = 0; i < 2; i++) label = label.replace(EDGE_CONJUNCTION_RE, "").trim();
  return label;
}

/** The clause as a disclosure names it: trimmed of edge punctuation and a dangling coordinator, capped. */
export function facetClauseLabel(clause: string): string {
  const label = trimClause(clause);
  return label.length > MAX_FACET_LABEL_CHARS ? `${label.slice(0, MAX_FACET_LABEL_CHARS - 1)}…` : label;
}

function matchKey(text: string): string {
  return trimClause(text)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s,、;；:：.。!?！？「」『』()（）"'`]+/gu, "");
}

/**
 * True when a request item (requestItems.ts's split) is the SAME point as a
 * facet clause (requestFacets.ts's split) — i.e. the item's own normalised text
 * is contained in the clause (the item is no broader than the facet). ONE
 * direction only: an item whose text is broader than the clause carries other
 * points too and is never owned by this facet (measured: the items of an
 * enumerated read-lead list all carry the WHOLE enumeration as their text, so
 * a two-way containment let one facet claim every item). Never a match on an
 * empty key.
 */
export function facetClauseMatchesItem(clause: string, itemText: string): boolean {
  const clauseKey = matchKey(clause);
  const itemKey = matchKey(itemText);
  if (clauseKey.length === 0 || itemKey.length === 0) return false;
  return clauseKey.includes(itemKey);
}

// ---------------------------------------------------------------------------
// Span arithmetic
// ---------------------------------------------------------------------------

function mergeSpans(spans: readonly FacetLineSpan[]): FacetLineSpan[] {
  const sorted = [...spans].filter((s) => s.start <= s.end).sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Array<{ start: number; end: number }> = [];
  for (const span of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && span.start <= last.end + 1) {
      if (span.end > last.end) last.end = span.end;
    } else {
      out.push({ start: span.start, end: span.end });
    }
  }
  return out;
}

/** The parts of `window` NOT covered by `served` (merged or not). */
export function unservedSubSpans(window: FacetLineSpan, served: readonly FacetLineSpan[]): FacetLineSpan[] {
  let pieces: FacetLineSpan[] = [{ start: window.start, end: window.end }];
  for (const hole of mergeSpans(served)) {
    const next: FacetLineSpan[] = [];
    for (const piece of pieces) {
      if (hole.end < piece.start || hole.start > piece.end) { next.push(piece); continue; }
      if (hole.start > piece.start) next.push({ start: piece.start, end: hole.start - 1 });
      if (hole.end < piece.end) next.push({ start: hole.end + 1, end: piece.end });
    }
    pieces = next;
  }
  return pieces.filter((p) => p.start <= p.end);
}

/**
 * FIX-FAB item 6: how far a CONTIGUOUS served region reaches, starting
 * right after `afterLine` -- used to grow a truncated constant window's
 * continuation ask by only the UNSERVED remainder (never re-asking for a
 * chunk a prior hop already delivered, which would otherwise loop forever
 * proposing the same already-served "next chunk" each time this function
 * re-evaluates the still-truncated plan window).
 */
function furthestContiguousServedLine(afterLine: number, served: readonly FacetLineSpan[]): number {
  let end = afterLine;
  let advanced = true;
  while (advanced) {
    advanced = false;
    for (const span of served) {
      if (span.start <= end + 1 && span.end > end) { end = span.end; advanced = true; }
    }
  }
  return end;
}

function lineServed(line: number, served: readonly FacetLineSpan[]): boolean {
  return served.some((span) => span.start <= line && line <= span.end);
}

// ---------------------------------------------------------------------------
// Literal probe (value / condition emptiness wording only)
// ---------------------------------------------------------------------------

/** A maximal identifier-shaped run (mirrors evidenceClosure.ts's own `IDENTIFIER_RE`, kept as a local duplicate for the same reason `lineHasLiteral` itself is duplicated -- see its doc comment). Every SUCH run starts with a letter/`_`/`$`, so stripping every match from a line leaves a numeric literal's own leading digit untouched (no mainstream language lets an identifier start with a digit) while removing a digit-suffixed type/const name whole. */
const IDENTIFIER_TOKEN_RE = /[A-Za-z_$][A-Za-z0-9_$]*/g;

/**
 * A numeric or quoted literal on a line once a trailing `//` / `#` comment
 * is dropped — decides only whether an EMPTY value facet is disclosed,
 * never a status.
 *
 * eval-0929 §4/§8 fix: a digit run counts as a literal only when it OPENS
 * the token it sits in (`64`, `0x40`, `1_000`, `1e3`, `64u64`); a digit run
 * inside a digit-suffixed type/const name (`u64`, `i32`, `int8_t`,
 * `Float64`, `uint16` in Rust/C/C++/Go/Julia/Kotlin/…) never opens its
 * token and must not be read as one — see `IDENTIFIER_TOKEN_RE`'s own doc
 * comment and evidenceClosure.ts's `lineHasLiteralText` (kept in sync on
 * purpose) for the full mechanism. The prior one-character
 * lookbehind/lookahead missed this: for a 2+ digit suffix it could
 * retry-match on the run's own trailing digit (preceded by another digit,
 * not a letter) and misread the type name as carrying a literal.
 */
function lineHasLiteral(line: string): boolean {
  const code = line.replace(/\s(?:\/\/|#).*$/u, "").replace(/^\s*(?:\/\/|#|\*|\/\*).*$/u, "");
  return /\d/u.test(code.replace(IDENTIFIER_TOKEN_RE, "")) || /["'`]/u.test(code);
}

/**
 * 2026-10-10 re-run — true when a line of a callable's body returns an
 * expression once its trailing `//` / `#` comment (or a comment-only line) is
 * dropped: `return <expression>` (every mainstream language with the keyword;
 * a bare `return;` returns nothing) or an arrow function's expression body
 * (`=> a + b`, outside any parenthesis or bracket, so the arrow of a
 * parameter's function TYPE never counts — also C#'s `=> a + b;` members and
 * PHP's `fn($a) => …`). A body that returns its tail expression without the
 * keyword (Rust, Ruby, a Kotlin expression body) is read by
 * `declarationReturnsTailExpression` instead.
 */
function lineReturnsExpression(line: string): boolean {
  const code = line.replace(/\s(?:\/\/|#).*$/u, "").replace(/^\s*(?:\/\/|#|\*|\/\*).*$/u, "");
  if (/\breturn\b[ \t]*[^\s;]/u.test(code)) return true;
  let depth = 0;
  for (let i = 0; i + 1 < code.length; i += 1) {
    const ch = code[i]!;
    if (ch === "(" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
    else if (ch === "=" && code[i + 1] === ">" && depth === 0) {
      const rest = code.slice(i + 2).trimStart();
      if (rest.length > 0 && rest[0] !== "{") return true;
    }
  }
  return false;
}

/**
 * 2026-10-10 (tail-expression returns) — `text` with every comment blanked
 * (spaces, newlines kept): `#` line comments when `hashComments`, otherwise
 * `//` line comments and (nested) `/* … *\/` blocks. String literals need no
 * masking here: the only caller reads a declaration that holds no literal at
 * all (`lineHasLiteral`), and the readers below give up on any quote left.
 */
function blankComments(text: string, hashComments: boolean): string {
  let out = "";
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (depth > 0) {
      if (ch === "*" && next === "/") { depth -= 1; out += "  "; i += 1; }
      else if (ch === "/" && next === "*") { depth += 1; out += "  "; i += 1; }
      else out += ch === "\n" ? "\n" : " ";
      continue;
    }
    if (!hashComments && ch === "/" && next === "*") { depth = 1; out += "  "; i += 1; continue; }
    if (hashComments ? ch === "#" : ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") { out += " "; i += 1; }
      if (i < text.length) out += "\n";
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Rust: the function declares a value return type (`-> T`, never `()` or `!`)
 * and its body has a TAIL — whatever follows the body's last top-level `;` is
 * not empty (`a + b`, `match x { … }`, `Ok(v)`). `a + b;` leaves no tail: the
 * body returns unit, whatever its signature says. A declaration without a body
 * (a trait method's `;`) has none either.
 */
function rustReturnsTailExpression(code: string): boolean {
  const fn = /\bfn\b/u.exec(code);
  if (fn === null) return false;
  let paren = 0;
  let angle = 0;
  let arrow = -1;
  let bodyOpen = -1;
  for (let i = fn.index + 2; i < code.length && bodyOpen < 0; i += 1) {
    const ch = code[i]!;
    if (ch === "-" && code[i + 1] === ">") {
      if (paren === 0 && angle === 0 && arrow < 0) arrow = i + 2;
      i += 1;
    } else if (ch === "(" || ch === "[") paren += 1;
    else if (ch === ")" || ch === "]") paren = Math.max(0, paren - 1);
    else if (ch === "<") angle += 1;
    else if (ch === ">") angle = Math.max(0, angle - 1);
    else if (paren === 0 && angle === 0 && ch === ";") return false;
    else if (paren === 0 && angle === 0 && ch === "{") bodyOpen = i;
  }
  if (arrow < 0 || bodyOpen < 0) return false;
  const returnType = code.slice(arrow, bodyOpen).replace(/\bwhere\b[\s\S]*$/u, "").trim();
  if (returnType === "" || returnType === "!" || /^\(\s*\)$/u.test(returnType)) return false;
  let depth = 0;
  let tailStart = bodyOpen + 1;
  for (let i = bodyOpen + 1; i < code.length; i += 1) {
    const ch = code[i]!;
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") {
      if (depth === 0) return code.slice(tailStart, i).trim().length > 0;
      depth -= 1;
    } else if (ch === ";" && depth === 0) tailStart = i + 1;
  }
  return false;
}

const RUBY_DEF_LEAD = String.raw`^\s*(?:(?:private|protected|public|module_function)\s+)?def\s+`;
const RUBY_DEF_RE = new RegExp(RUBY_DEF_LEAD, "u");
/** An endless method, `def add(a, b) = a + b` (never a setter's `def name=(v)`). */
const RUBY_ENDLESS_DEF_RE = new RegExp(`${RUBY_DEF_LEAD}(?:self\\.)?[A-Za-z_]\\w*[?!]?(?:\\s*\\([^)]*\\)\\s*|\\s+)=(?![=~>])\\s*\\S`, "u");
/** The signature of a block-bodied method: the name, then its parameters — parenthesized, or the rest of the line. */
const RUBY_SIGNATURE_RE = new RegExp(`${RUBY_DEF_LEAD}(?:self\\.)?[^\\s(;]+(?:\\s*\\([^)]*\\))?[^\\n;]*`, "u");
/** A last statement that hands back no value of its own: a block closer (an inner `end`, `}`), a bare jump, or a clause keyword. */
const RUBY_VALUELESS_TAIL_RE = /^(?:end|\}|\]|\))(?![\w?!])|^(?:return|break|next|redo|retry)$|^(?:else|elsif|when|in|rescue|ensure|then|do|begin)\b/u;

/**
 * Ruby: a `def` returns the value of its last statement — the tail before its
 * closing `end` — unless that statement is a block closer, a bare jump or a
 * clause keyword (an inner `if … end` as the last statement stays unread:
 * which branch's value comes back is not this line's to say). An endless
 * `def f(a) = expression` returns its expression.
 */
function rubyReturnsImplicitValue(code: string): boolean {
  const text = code.replace(/^\s*\n/u, "").trimEnd();
  if (!RUBY_DEF_RE.test(text)) return false;
  if (RUBY_ENDLESS_DEF_RE.test(text.split("\n")[0]!)) return true;
  if (!/(?:^|[\s;])end$/u.test(text)) return false;
  const signature = RUBY_SIGNATURE_RE.exec(text);
  if (signature === null) return false;
  const body = text.slice(signature[0].length, text.length - "end".length);
  const statements = body.split(/[\n;]/u).map((statement) => statement.trim()).filter((statement) => statement.length > 0);
  const tail = statements[statements.length - 1];
  return tail !== undefined && !RUBY_VALUELESS_TAIL_RE.test(tail);
}

/**
 * Kotlin: an expression body, `fun add(a: Int, b: Int) = a + b` (with or
 * without a declared type): an `=` after the parameter list, before any block
 * body, outside brackets. A block body returns only through `return`, which
 * `lineReturnsExpression` reads.
 */
function kotlinHasExpressionBody(code: string): boolean {
  const fun = /\bfun\b/u.exec(code);
  if (fun === null) return false;
  let i = fun.index + 3;
  let angle = 0;
  for (; i < code.length; i += 1) {
    const ch = code[i]!;
    if (ch === "<") angle += 1;
    else if (ch === ">") angle = Math.max(0, angle - 1);
    else if (ch === "(" && angle === 0) break;
    else if (ch === "{" || ch === "=" || ch === ";") return false;
  }
  let depth = 0;
  for (; i < code.length; i += 1) {
    if (code[i] === "(") depth += 1;
    else if (code[i] === ")" && (depth -= 1) === 0) break;
  }
  depth = 0;
  for (i += 1; i < code.length; i += 1) {
    const ch = code[i]!;
    const next = code[i + 1];
    if (ch === "-" && next === ">") i += 1;
    else if (ch === "(" || ch === "[" || ch === "<") depth += 1;
    else if (ch === ")" || ch === "]" || ch === ">") depth = Math.max(0, depth - 1);
    else if (depth === 0 && ch === "{") return false;
    else if (depth === 0 && ch === "=" && next !== "=" && !"=!<>".includes(code[i - 1] ?? "")) return code.slice(i + 1).trim().length > 0;
  }
  return false;
}

/**
 * 2026-10-10 (tail-expression returns) — true when `declaration` (a
 * callable's whole noise-trimmed declaration, holding no literal) returns a
 * value WITHOUT a `return` keyword, in a language whose function hands back an
 * expression of its own: a Rust tail expression, a Ruby method's last
 * statement, a Kotlin expression body (see each reader above). Every other
 * language returns a value only through `return` or an expression-bodied
 * arrow, which `lineReturnsExpression` reads — a TS/JS, Python, Go, Java, C,
 * C++, C# or PHP body without one returns nothing and keeps its disclosure.
 * A quote left in the code (a Rust lifetime, a literal) gives up: false.
 */
function declarationReturnsTailExpression(declaration: readonly string[], path: string): boolean {
  const language = languageForPath(path);
  if (language !== "rust" && language !== "ruby" && language !== "kotlin") return false;
  const code = blankComments(declaration.join("\n"), language === "ruby");
  if (/["'`]/u.test(code)) return false;
  if (language === "rust") return rustReturnsTailExpression(code);
  if (language === "ruby") return rubyReturnsImplicitValue(code);
  return kotlinHasExpressionBody(code);
}

/**
 * 2026-10-10 re-run — the focal window of a callable whose WHOLE
 * (noise-trimmed) declaration is served in this epoch and whose body returns
 * an expression (`lineReturnsExpression`, or a tail expression:
 * `declarationReturnsTailExpression`), or `undefined`. For a question that
 * asks what the callable returns (requestFacets.ts `asksForCallableResult`),
 * that served body is the answer itself.
 */
function servedReturningBody(
  focal: NonNullable<FacetPlanEntry["focal"]>,
  lines: readonly string[],
  ctx: FacetEvaluationContext,
): FacetPlanWindow | undefined {
  const span = trimmedFocalSpan(focal.start, focal.end, lines);
  if (span === undefined) return undefined;
  if (unservedSubSpans(span, ctx.servedSpans(focal.path)).length > 0) return undefined;
  const declaration = lines.slice(span.start - 1, span.end);
  if (!declaration.some(lineReturnsExpression) && !declarationReturnsTailExpression(declaration, focal.path)) return undefined;
  return { kind: "focal", path: focal.path, start: span.start, end: span.end, name: focal.name };
}

// ---------------------------------------------------------------------------
// The evaluator
// ---------------------------------------------------------------------------

export interface FacetEvaluationContext {
  /** Merged line spans of `path` served in this epoch (this pack + carried same-sha ledger). */
  servedSpans(path: string): readonly FacetLineSpan[];
  /** `path`'s current lines, or `undefined` when unreadable. */
  fileLines(path: string): readonly string[] | undefined;
  /** Lines of `path` already requested in this session and returned with no body (never requested again — see `noteUndeliveredFacetLines`). Absent = none. */
  undeliveredSpans?(path: string): readonly FacetLineSpan[];
}

export type FacetFactKind = "covered" | "empty" | "open" | "undetermined";

export interface FacetFacts {
  readonly kind: FacetFactKind;
  /** The disclosure / trace term: `<facet>:<subject>`. */
  readonly term: string;
  readonly reason: string;
  /** True when the plan resolved a focal for this requirement (the structural grounding G4 counts). */
  readonly focalResolved: boolean;
  /** Required windows that are fully served (the certificate's evidence for this facet). */
  readonly servedWindows: readonly FacetPlanWindow[];
  /** Exact unserved sub-spans to read, per path, merged, in requirement order. Empty unless `kind === "open"`. */
  readonly openTargets: ReadonlyArray<{ readonly path: string; readonly start: number; readonly end: number }>;
  /** Present for `empty` and `undetermined`: what the certificate must disclose. */
  readonly disclosure?: { readonly word: "request-item-empty" | "request-item-undetermined"; readonly reason: string };
}

/**
 * The focal lines `facet` requires: the whole (noise-trimmed) declaration of a
 * focal of at most MAX_FACET_FOCAL_LINES lines for every facet but `callers`
 * (the caller skips this for `callers`), and — R2-T1, see
 * MAX_FACET_FOCAL_LINES — the whole declaration of a LONGER callable focal for
 * a `condition` / `flow` facet. A long TYPE focal (`callable:false`) keeps the
 * waiver: its flow is judged by the member windows the recorder required.
 */
function focalRequiredWindow(entry: FacetPlanEntry, ctx: FacetEvaluationContext, facet: RequestFacet): FacetPlanWindow | undefined {
  const focal = entry.focal;
  if (focal === undefined) return undefined;
  const lines = ctx.fileLines(focal.path);
  const span = focalRequiredSpan(focal.start, focal.end, lines)
    ?? ((facet === "condition" || facet === "flow") && focal.callable !== false
      ? trimmedFocalSpan(focal.start, focal.end, lines)
      : undefined);
  return span === undefined ? undefined : { kind: "focal", path: focal.path, start: span.start, end: span.end, name: focal.name };
}

/**
 * The lines of a focal declared at `[start, end]` that every facet but
 * `callers` requires when the focal is at most MAX_FACET_FOCAL_LINES long, or
 * `undefined` (a longer focal — see `focalRequiredWindow` for the condition /
 * flow facets that still require it). Exported for the closure hook
 * (readCodeTaskPack.ts), which serves this window itself when the pack did not
 * select it — which is why it stays bounded: a long condition / flow focal is
 * REQUIRED (`focalRequiredWindow`) but reaches the client through the pack's
 * own budgeted serving and the gate's ranged `next`, never as one unbounded
 * closure window.
 */
export function focalRequiredSpan(
  start: number,
  end: number,
  lines: readonly string[] | undefined,
): { readonly start: number; readonly end: number } | undefined {
  const span = trimmedFocalSpan(start, end, lines);
  if (span === undefined || span.end - span.start + 1 > MAX_FACET_FOCAL_LINES) return undefined;
  return span;
}

/** `[start, end]` with leading/trailing blank and comment-only lines trimmed, whatever its length; `undefined` when nothing is left or the file is unreadable. */
function trimmedFocalSpan(
  start: number,
  end: number,
  lines: readonly string[] | undefined,
): { readonly start: number; readonly end: number } | undefined {
  if (lines === undefined) return undefined;
  // Trim leading/trailing blank and comment-only lines: a parser that folds a
  // doc comment into the symbol's range must not make an unread comment block
  // look like missing evidence.
  const isNoise = (n: number): boolean => {
    const text = (lines[n - 1] ?? "").trim();
    return text === "" || /^(?:\/\/|#|\/\*|\*|""")/u.test(text);
  };
  let first = Math.max(1, start);
  let last = Math.min(lines.length, end);
  while (first < last && isNoise(first)) first += 1;
  while (last > first && isNoise(last)) last -= 1;
  if (last < first) return undefined;
  return { start: first, end: last };
}

/**
 * A focal resolved for a CONCEPT-only requirement (no identifier named — the
 * closure hook's tier 3 picks the selected callable whose name or FILE HEAD
 * anchors a subject term) is a guess. It grounds the requirement only when
 * the callable ITSELF carries one of the clause's concept terms, in its name
 * or its own body. Measured (replay d12b): a file whose header comment
 * explained a flag made its first unrelated function the "focal", and the gate
 * then demanded that function's body — evidence the question never asked for.
 */
/** A run of two or more Han/Kana/Hangul characters is already a whole word (計算, 在庫); a Latin term needs three letters. */
const CJK_WORD_RE = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}ー]{2,}$/u;

function conceptGrounded(terms: readonly string[], focal: NonNullable<FacetPlanEntry["focal"]>, ctx: FacetEvaluationContext): boolean {
  const usable = terms.filter((term) => term.length >= 3 || CJK_WORD_RE.test(term)).map((term) => term.toLowerCase());
  if (usable.length === 0) return false;
  const name = focal.name.toLowerCase();
  const body = (ctx.fileLines(focal.path) ?? []).slice(Math.max(0, focal.start - 1), focal.end).join("\n").toLowerCase();
  return usable.some((term) => name.includes(term) || body.includes(term));
}

/**
 * 2026-10-06 independent review (P1-4): one requirement's facts across every
 * subject it planned — its primary entry plus each `FacetPlanEntry.subject`
 * entry, evaluated one by one. Open when any subject is open (their unserved
 * windows together, so one `next` reads them all); otherwise undetermined
 * when any is; otherwise covered when any is (a verified-empty sibling keeps
 * its own disclosure); empty only when every subject is. One subject is
 * returned unchanged.
 */
export function combineSubjectFacetFacts(all: readonly FacetFacts[]): FacetFacts {
  if (all.length <= 1) return all[0]!;
  const servedWindows = all.flatMap((facts) => facts.servedWindows);
  const open = all.filter((facts) => facts.kind === "open");
  if (open.length > 0) {
    const seen = new Set<string>();
    const openTargets = open.flatMap((facts) => facts.openTargets).filter((target) => {
      const key = `${target.path}\u0000${target.start}-${target.end}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return { ...open[0]!, servedWindows, openTargets, reason: open.map((facts) => facts.reason).join("; ") };
  }
  const undetermined = all.find((facts) => facts.kind === "undetermined");
  if (undetermined !== undefined) return { ...undetermined, servedWindows };
  const covered = all.find((facts) => facts.kind === "covered");
  return { ...(covered ?? all[0]!), servedWindows, reason: all.map((facts) => facts.reason).join("; ") };
}

/**
 * The facts for one requirement. `entry` is the recorded plan entry for the
 * same (facet, clause), or `undefined` when no plan exists for this query.
 */
export function evaluateFacetRequirement(
  requirement: FacetRequirement,
  entry: FacetPlanEntry | undefined,
  ctx: FacetEvaluationContext,
): FacetFacts {
  const label = facetClauseLabel(requirement.clause);
  const unresolvedTerm = `${requirement.facet}:${label}`;
  const undetermined = (reason: string, focalResolved = false, servedWindows: FacetPlanWindow[] = []): FacetFacts => ({
    kind: "undetermined",
    term: focalResolved && entry?.focal !== undefined ? `${requirement.facet}:${entry.focal.name}` : unresolvedTerm,
    reason,
    focalResolved,
    servedWindows,
    openTargets: [],
    disclosure: { word: "request-item-undetermined", reason },
  });
  if (entry === undefined) {
    return undetermined("the evidence closure for this clause was not computed for this request in this session");
  }
  // WP-F (eval-0929 §7 bullet 3 / §8 row 4): checked BEFORE `no-focal` and
  // BEFORE `focal` is read for anything else -- an ambiguous entry's own
  // `focal` (if present at all) is a placeholder, never a decided subject,
  // so it must never reach `conceptGrounded`/the required-windows loop below
  // and be certified `covered`/`empty` on an arbitrary same-named pick.
  if (entry.ambiguousFocal !== undefined && entry.ambiguousFocal.paths.length > 0) {
    const { name, paths } = entry.ambiguousFocal;
    return undetermined(
      `${name} is declared in ${paths.length} files (${paths.join(", ")}) and this pack could not tell which one the question means`,
    );
  }
  if (entry.resolution === "no-focal") {
    return undetermined("no callable or declaration in the workspace could be resolved as this clause's subject");
  }
  if (entry.resolution === "budget-exhausted" || entry.focal === undefined) {
    return undetermined("the bounded evidence-closure budget ran out before this clause was resolved");
  }
  const focal = entry.focal;
  if (requirement.subjectIdentifiers.length === 0 && !conceptGrounded(requirement.subjectTerms, focal, ctx)) {
    return undetermined("no selected callable carries this clause's concept in its own name or body");
  }
  const term = `${requirement.facet}:${focal.name}`;

  // -- required windows -----------------------------------------------------
  const required: FacetPlanWindow[] = [];
  if (requirement.facet !== "callers") {
    const focalWindow = focalRequiredWindow(entry, ctx, requirement.facet);
    if (focalWindow !== undefined) required.push(focalWindow);
  }
  for (const window of entry.windows) {
    if (window.kind === "caller") continue; // the SITE is the requirement, see below
    if (requirement.facet === "callers" && window.kind !== "constant") continue;
    if ((requirement.facet === "value" || requirement.facet === "condition") && window.kind === "callee") {
      required.push(window);
      continue;
    }
    if (requirement.facet === "flow" && window.kind === "constant") continue;
    required.push(window);
  }
  const servedWindows: FacetPlanWindow[] = [];
  const open: Array<{ path: string; start: number; end: number }> = [];
  for (const window of required) {
    const pieces = unservedSubSpans(window, ctx.servedSpans(window.path));
    if (pieces.length > 0) {
      for (const piece of pieces) open.push({ path: window.path, ...piece });
      continue;
    }
    // FIX-FAB item 6 (eval-0927 review #10, bigConstants): `[start,end]`
    // itself being served proves nothing when the window is TRUNCATED --
    // `findModuleConstantWindow` capped it before reaching the declaration's
    // real close, so the value is not yet covered. Ask for the next bounded
    // chunk PAST whatever has already been served contiguously beyond `end`
    // (never re-asking for a chunk a PRIOR hop already delivered), until
    // either the DECLARATION'S REAL CLOSE is reached or nothing further can
    // be read (the open-target/undelivered-lines machinery below degrades
    // this to `undetermined`, never a silent "covered").
    //
    // P1-6 (eval-0927 review r2 finding 6, bigConstantsLongTail): the ceiling
    // used to be the FILE's own end -- correct only when the declaration
    // happens to run to EOF, and a wasteful, unbounded walk through however
    // much unrelated content follows a big declaration otherwise (measured:
    // an 82-line table followed by 1000 padding lines cost 34 hops / 88 KB
    // reading all the way to line 1082). `declarationRealExtent` re-measures
    // the SAME bracket-depth scan `findModuleConstantWindow` ran, bounded by
    // a much larger but still sane ceiling (MAX_CONSTANT_REAL_EXTENT_LINES)
    // instead of the 40-line serving cap, so the continuation stops where the
    // declaration itself closes. Falls back to the file's own end only when
    // the file cannot be read here (defensive; `ctx.fileLines` already
    // failed, so there is nothing to re-measure against anyway).
    if (window.truncated === true) {
      const lines = ctx.fileLines(window.path);
      const realEnd = lines === undefined
        ? undefined
        : declarationRealExtent(lines, window.start, hasHashComments(window.path)).end;
      const totalLines = realEnd ?? lines?.length ?? window.end;
      const servedSoFar = furthestContiguousServedLine(window.end, ctx.servedSpans(window.path));
      if (servedSoFar < totalLines) {
        const continuationEnd = Math.min(totalLines, servedSoFar + MAX_FACET_FOCAL_LINES);
        open.push({ path: window.path, start: servedSoFar + 1, end: continuationEnd });
        continue;
      }
    }
    servedWindows.push(window);
  }

  const wantsSites = requirement.facet === "callers" || requirement.facet === "flow";
  // P1-7 (eval-0927 review-r2 #7, manyCallers/goMethodManyCallers): every
  // RECORDED site is required, not just the first MAX_REQUIRED_CALL_SITES —
  // see MAX_REQUIRED_CALL_SITES's own doc for why a fixed slice here made a
  // known, already-enumerated site unreachable on every later hop too, not
  // only the current one.
  const sites = wantsSites ? (entry.callSites ?? []) : [];
  for (const site of sites) {
    const served = ctx.servedSpans(site.path);
    if (lineServed(site.line, served)) {
      servedWindows.push({ kind: "caller", path: site.path, start: site.line, end: site.line, name: focal.name });
      continue;
    }
    const lineCount = ctx.fileLines(site.path)?.length ?? site.line;
    const window = {
      start: Math.max(1, site.line - FACET_CALL_SITE_MARGIN_LINES),
      end: Math.max(site.line, Math.min(lineCount, site.line + FACET_CALL_SITE_MARGIN_LINES)),
    };
    for (const piece of unservedSubSpans(window, served)) open.push({ path: site.path, ...piece });
  }

  // MENTION GUARD (R5-A1, the round-5 principle). More than the bound was
  // found: undetermined OUTRIGHT, before anything else about this facet is
  // even considered — bounding a disclosure to MAX_UNCLASSIFIED_MENTION_LINES
  // windows is reasonable; pretending there were only that many when there
  // were more is not.
  if (wantsSites && entry.unclassifiedMentionsCapped === true) {
    return undetermined(
      `more than ${MAX_UNCLASSIFIED_MENTION_LINES} mentions of ${focal.name} in forms this scan could not classify were found; too many to disclose in one pass`,
      true,
      servedWindows,
    );
  }
  // A raw, unclassified mention is a REQUIRED window exactly like a call
  // site: unserved -> open (below); served -> it never becomes evidence of
  // a call on its own (pushed to neither `servedWindows` nor `open` once
  // served — merely no longer blocking), but its EXISTENCE bars an `empty`
  // verdict for `callers` below, whatever the declaration/call-site
  // classifier itself missed.
  const mentions = wantsSites ? (entry.unclassifiedMentions ?? []) : [];
  for (const mentionLine of mentions) {
    const served = ctx.servedSpans(mentionLine.path);
    if (lineServed(mentionLine.line, served)) continue;
    const lineCount = ctx.fileLines(mentionLine.path)?.length ?? mentionLine.line;
    const window = {
      start: Math.max(1, mentionLine.line - FACET_CALL_SITE_MARGIN_LINES),
      end: Math.max(mentionLine.line, Math.min(lineCount, mentionLine.line + FACET_CALL_SITE_MARGIN_LINES)),
    };
    for (const piece of unservedSubSpans(window, served)) open.push({ path: mentionLine.path, ...piece });
  }

  // Copilot retest (2026-10-02, moved ahead of `open` by its review): a cut
  // callee list is disclosed at once -- the callees that fit are never proof
  // that the ones past the cut agree with them, and fetching every window
  // that fits over several round trips only to disclose the cut afterwards
  // costs those round trips for nothing (see `calleesComplete`).
  if (requirement.facet !== "callers" && entry.calleesComplete === false) {
    return undetermined(`${focal.name} calls more in-workspace functions than this pack can require in one pass`, true, servedWindows);
  }

  if (open.length > 0) {
    // Merge per path, keeping first-appearance path order (requirement order).
    const order: string[] = [];
    const byPath = new Map<string, FacetLineSpan[]>();
    for (const target of open) {
      if (!byPath.has(target.path)) { byPath.set(target.path, []); order.push(target.path); }
      byPath.get(target.path)!.push(target);
    }
    const merged = order.flatMap((p) => mergeSpans(byPath.get(p)!).map((span) => ({ path: p, start: span.start, end: span.end })));
    // Never request again what an earlier call of this session requested and
    // got no byte of (termination — see `noteUndeliveredFacetLines`).
    const openTargets = merged.flatMap((target) =>
      unservedSubSpans(target, ctx.undeliveredSpans?.(target.path) ?? []).map((span) => ({ path: target.path, start: span.start, end: span.end })));
    if (openTargets.length === 0) {
      return undetermined(
        `evidence ${focal.name} needs was requested in this session but not delivered: ${merged.slice(0, 4).map((t) => `${t.path}:${t.start}-${t.end}`).join(", ")}`,
        true,
        servedWindows,
      );
    }
    return {
      kind: "open",
      term,
      reason: `evidence the ${requirement.facet} question about ${focal.name} needs is not served yet: ${openTargets.slice(0, 4).map((t) => `${t.path}:${t.start}-${t.end}`).join(", ")}`,
      focalResolved: true,
      servedWindows,
      openTargets,
    };
  }

  // -- everything required is served: covered, empty, or bounded -------------
  const unresolved = (entry.unresolvedConstants ?? []).slice(0, 4);
  if ((requirement.facet === "value" || requirement.facet === "condition") && unresolved.length > 0) {
    // P2-10 (round-6 fable finding, externalPackageConst): when every
    // unresolved name in THIS disclosure traces to a package import, name
    // the package -- a name the file plainly imports was never
    // undiscoverable, only unresolved by this scan (it never reads
    // node_modules, workspace package names or path aliases). A mixed batch
    // (some named, some not) keeps the generic wording rather than mislabel
    // the ones whose origin this scan never learned.
    const packages = entry.unresolvedConstantPackages ?? {};
    const allFromPackages = unresolved.every((name) => packages[name] !== undefined);
    // P1-4 (round-7 fable finding, item 4): when every unresolved name in
    // THIS disclosure is an AMBIGUOUS qualified owner (several files declare
    // it, neither the focal's own file nor its own imports proved which),
    // name the candidate files instead of the generic wording -- never
    // silently picks one (P1).
    const candidates = entry.unresolvedConstantCandidates ?? {};
    const allAmbiguous = !allFromPackages && unresolved.every((name) => candidates[name] !== undefined);
    // Never "declared outside the workspace": a workspace package
    // (`@acme/config` in a monorepo) or a path alias (`@/config`) is a
    // non-relative specifier this scan does not resolve either.
    const reason = allFromPackages
      ? `${unresolved.join(", ")} ${unresolved.length === 1 ? "is" : "are"} imported from package ${[...new Set(unresolved.map((name) => packages[name]))].join(", ")}; ${unresolved.length === 1 ? "its declaration" : "their declarations"} could not be resolved`
      : allAmbiguous
      ? `${unresolved.join(", ")} ${unresolved.length === 1 ? "is" : "are"} declared in more than one file (${[...new Set(unresolved.flatMap((name) => candidates[name] ?? []))].slice(0, 4).join(", ")}) and this pack could not tell which one ${focal.name} reads`
      // Policy P1: never assert absence — the constant search is not exhaustive
      // (a same-package declaration in a language whose packages this scan does
      // not walk, `Config.kt`'s `const val API_BASE`, read no import at all).
      : `${unresolved.join(", ")} ${unresolved.length === 1 ? "is" : "are"} read by ${focal.name} but ${unresolved.length === 1 ? "its declaration" : "their declarations"} could not be resolved`;
    return undetermined(reason, true, servedWindows);
  }
  // P0-2 (round-6 fable finding): an instance/static property this focal
  // reads whose owner value could not be resolved within the class body --
  // never covered by an inline literal alone (P3). Distinct wording from the
  // module-constant case above: the property is not necessarily undeclared
  // anywhere, only unresolved BY THIS SCAN (inherited, setter-assigned, a
  // no-default parameter, or an initializer this scan does not chase).
  const unresolvedSelfProps = (entry.unresolvedSelfProperties ?? []).slice(0, 4);
  if ((requirement.facet === "value" || requirement.facet === "condition") && unresolvedSelfProps.length > 0) {
    const qualifier = hasHashComments(focal.path) ? "self" : "this";
    return undetermined(
      `${focal.name} reads ${unresolvedSelfProps.map((p) => `${qualifier}.${p}`).join(", ")}, whose value this pack could not resolve within the class body`,
      true,
      servedWindows,
    );
  }
  // V4 (round-7 fable finding, valueBehindConfigAccessor): a resolved
  // binding whose own text is NOTHING BUT a construction/call and carries no
  // literal anywhere answers nothing this facet needs -- never `covered`
  // merely because a declaration was found (P3).
  const constructedEntries = Object.entries(entry.unresolvedConstructedValues ?? {}).slice(0, 4);
  if ((requirement.facet === "value" || requirement.facet === "condition") && constructedEntries.length > 0) {
    const reason = constructedEntries
      .map(([name, expr]) => `${name} is built by ${expr}, whose value this pack did not follow`)
      .join("; ");
    return undetermined(reason, true, servedWindows);
  }
  // FIX-ALIAS (eval-0929 §4, root cause 2): a dependency of a SERVED window's
  // own value (not the focal's direct read -- see `unresolvedDependencies`'s
  // own doc) that this pack could not resolve either -- never `covered`
  // merely because the window ABOVE it in the chain was found (P3): the
  // window's own text is a reference, and the value behind that reference
  // never reached the client.
  const dependencyEntries = Object.entries(entry.unresolvedDependencies ?? {}).slice(0, 4);
  if ((requirement.facet === "value" || requirement.facet === "condition") && dependencyEntries.length > 0) {
    const reason = dependencyEntries.map(([name, readBy]) => `${name} (${readBy}) could not be resolved`).join("; ");
    return undetermined(reason, true, servedWindows);
  }
  if ((requirement.facet === "value" || requirement.facet === "condition") && entry.constantsComplete === false) {
    return undetermined(`the constant scan for ${focal.name} stopped at its time budget`, true, servedWindows);
  }
  if (wantsSites) {
    const total = entry.totalCallSites ?? sites.length;
    if (entry.callSitesComplete === false) {
      return undetermined(`the call-site scan for ${focal.name} stopped at its time budget after ${total} call site(s)`, true, servedWindows);
    }
    // P1-7 (eval-0927 review-r2 #7's residual, goMethodManyCallers): more
    // files mentioned the member than the scan ever opened -- a fact
    // `callSitesComplete` (deliberately about the ALREADY-capped candidate
    // list, see its own doc) never carries. Checked even when every
    // RECORDED site is served (`total === sites.length` below): serving
    // everything the scan happened to open never proves the files it never
    // opened held no caller.
    if (entry.callSitesFilesCapped === true) {
      return undetermined(
        `more files mentioned ${focal.name} than the call-site scan could open in one pass; ${sites.length} call site(s) across the scanned files are served`,
        true,
        servedWindows,
      );
    }
    // P2-10 (eval-0927 review-r3 #10, manyCallers60in3): `entry.callSites` is
    // now recorded generously (readCodeTaskPack.ts's own doc on
    // MAX_RECORDED_FACET_CALL_SITES = 512), so for any realistic fan-in
    // `total === sites.length` here and this branch is never reached at all
    // -- the ordinary per-hop pagination above (every RECORDED site is a
    // required window) already carried the whole fan-in to `covered`. Kept
    // as a fail-safe for the genuinely rare case where even that cap is not
    // enough: `total > sites.length` can ONLY still be true here (files-cap
    // is already excluded above) because the recorder's own cap was hit, and
    // this must never silently read as "covered" merely because every site
    // it DID keep happens to be served.
    if (total > sites.length) {
      return undetermined(
        entry.callSitesRecordedCapped === true
          ? `more call sites of ${focal.name} were found than this pack's recorder can hold in one pass; ${sites.length} of ${total} call site(s) are served`
          : `${sites.length} of ${total} call sites of ${focal.name} are served; the rest were not read`,
        true,
        servedWindows,
      );
    }
    const calleeWindows = entry.windows.filter((w) => w.kind === "callee").length;
    // FIX-FAB2 (eval-0927 orchestrator repro, afx): a flow over a TYPE focal
    // (`callable:false`) is never "covered" merely because SOME matching
    // member resolved — every clause term must ground in a served member
    // (P1/P3: a served `place` never proves a `fulfil`-shaped clause term
    // like "shipping" was answered). Both are recorded on the plan by
    // `flowStepWindowsForNonCallableFocal` (readCodeTaskPack.ts) only for a
    // non-callable focal's flow entry, so a callable focal's own flow
    // requirement (FIX-FAB's unchanged behaviour, required behaviour 4)
    // never reaches this branch — `flowMembersComplete`/`ungroundedFlowTerms`
    // are absent there. This runs before, and takes precedence over, the
    // generic checks below (reached only once every required window —
    // including EVERY matched member's own window, P1-8: the closure no
    // longer caps how many matched members are required, only how many get
    // the deeper one-hop callee-expansion — is confirmed served, since an
    // unserved required window already returned `open` above).
    //
    // P1-8 (eval-0927 review r2 finding 8, classFlowHandle/classFlowLifecycle):
    // `flowMembersComplete` is now false only past the large
    // MAX_FLOW_REQUIRED_MEMBER_WINDOWS safety ceiling readCodeTaskPack.ts
    // enforces (an ordinary class's few matching members no longer trip
    // this merely for exceeding the SMALLER MAX_CALLEES_PER_REQUIREMENT
    // expansion bound — those members are simply required windows above,
    // served or not, judged by the ordinary open/servedWindows machinery).
    if (requirement.facet === "flow" && focal.callable === false) {
      if (entry.flowMembersComplete === false) {
        return undetermined(
          `more members of ${focal.name} matched this clause than this facet will require in one pass`,
          true,
          servedWindows,
        );
      }
      const ungrounded = (entry.ungroundedFlowTerms ?? []).slice(0, 4);
      if (ungrounded.length > 0) {
        return undetermined(
          `${ungrounded.join(", ")} ${ungrounded.length === 1 ? "is" : "are"} named by this clause but ${ungrounded.length === 1 ? "matches" : "match"} no member of ${focal.name} this pack could serve`,
          true,
          servedWindows,
        );
      }
    }
    // A flow whose focal DOES call things, none of which resolved to a
    // workspace declaration, and that nobody calls, has no flow evidence at
    // all — that is "could not determine", never a verified-empty flow.
    if (requirement.facet === "flow" && total === 0 && calleeWindows === 0 && entry.focalMakesCalls === true) {
      return undetermined(`no caller and no in-workspace callee of ${focal.name} could be resolved`, true, servedWindows);
    }
    if (total === 0 && (requirement.facet === "callers" || calleeWindows === 0)) {
      // MENTION GUARD (R5-A1, the round-5 principle): a `callers` facet with
      // zero RECORDED call sites is never `empty` while an unclassified
      // mention of the member exists in the scanned scope (already proven
      // served by this point — an unserved one already returned `open`
      // above) — some form the declaration/call-site classifier could not
      // recognize might be a real call this pass simply failed to attribute.
      if (requirement.facet === "callers" && mentions.length > 0) {
        return undetermined(
          `${mentions.length} line(s) mention ${focal.name} in forms this scan could not classify`,
          true,
          servedWindows,
        );
      }
      // P0-2 (R7-A, eval-0927 review-r6 finding 2, defaultExportedDeclCaller):
      // a focal declared as its own module's default export is reached by
      // importers under THEIR OWN chosen binding name — a by-name scan
      // finding zero sites proves nothing about whether such an importer
      // exists, so this can never be the verified-empty "0 call sites" fact.
      if (requirement.facet === "callers" && entry.focalDefaultExported === true) {
        return undetermined(
          `${focal.name} is its module's default export; importers call it by their own binding name, which this scan cannot follow`,
          true,
          servedWindows,
        );
      }
      const scope = `0 call sites in the scanned workspace${entry.callSitesExcludeTests === true ? "; test files excluded" : ""}`;
      return {
        kind: "empty",
        term,
        reason: `${scope} for ${focal.name}`,
        focalResolved: true,
        servedWindows,
        openTargets: [],
        disclosure: { word: "request-item-empty", reason: scope },
      };
    }
  }
  if ((requirement.facet === "value" || requirement.facet === "condition") && focal.callable !== false) {
    const constantWindows = entry.windows.filter((w) => w.kind === "constant" || w.kind === "callee").length;
    if (constantWindows === 0) {
      const lines = ctx.fileLines(focal.path) ?? [];
      const body = lines.slice(Math.max(0, focal.start - 1), focal.end);
      if (!body.some(lineHasLiteral)) {
        // 2026-10-10 re-run: a question that asks what the callable RETURNS
        // ("What does the add function return?", 「add 関数は何を返しますか？」)
        // is answered by the served body itself — `return a + b` — so a body
        // with no constant and no literal is no gap to disclose there; the
        // disclosure stays for a question that names a value of its own
        // ("What is the timeout value used by X?"), and for a body that
        // returns no expression or is not on the wire.
        const resultWindow = requirement.facet === "value" && asksForCallableResult(requirement.clause)
          ? servedReturningBody(focal, lines, ctx)
          : undefined;
        if (resultWindow !== undefined) {
          return {
            kind: "covered",
            term,
            reason: `${focal.name} reads no module constant and holds no literal: the served body's return expression is the answer`,
            focalResolved: true,
            servedWindows: servedWindows.some((window) => window.kind === "focal") ? servedWindows : [...servedWindows, resultWindow],
            openTargets: [],
          };
        }
        return {
          kind: "empty",
          term,
          reason: `${focal.name} reads no module constant and holds no literal`,
          focalResolved: true,
          servedWindows,
          openTargets: [],
          disclosure: {
            word: "request-item-empty",
            reason: `${focal.name} reads no module constant and holds no literal; the value is supplied at runtime or by its callees`,
          },
        };
      }
    }
  }
  return {
    kind: "covered",
    term,
    reason: `the ${requirement.facet} evidence for ${focal.name} is served (${servedWindows.length} window${servedWindows.length === 1 ? "" : "s"})`,
    focalResolved: true,
    servedWindows,
    openTargets: [],
  };
}
