// facetClosure — extracted implementation; imports point to the owning modules.
import * as path from "path";
import type { AnswerStructureMap } from "./answerPackBuilder2.js";
import type { CalleeDefinitions } from "./focalFlow2.js";
import type { FacetCallSite } from "../facetGate.js";
import type { FacetClosureOutcome } from "./callableResolution2.js";
import type { FacetClosureTrial } from "./facetClosure2.js";
import type { FacetMentionLine } from "../facetGate.js";
import type { FacetPlan } from "../facetGate.js";
import type { FacetPlanEntry } from "../facetGate.js";
import type { FacetPlanWindow } from "../facetGate.js";
import type { FacetRequirement } from "../requestFacets.js";
import type { ImpactCandidate } from "@tokenlighten/types";
import type { ResolvedFacetFocal } from "./callableResolution2.js";
import type { TaskPackArgs } from "../model.js";
import { CALLER_EXPANSION_CALLABLE_KINDS } from "./callerExpansion2.js";
import { FileReadCache } from "./packBasics2.js";
import { MAX_CLOSURE_BYTES_PER_PACK } from "../evidenceClosure.js";
import { MAX_RECORDED_FACET_CALL_SITES } from "./focalFlow2.js";
import { MAX_REQUIRED_CALL_SITES } from "../facetGate.js";
import { MAX_SURFACES_DISTINCT } from "./packBasics2.js";
import { MAX_SURFACES_WITH_FACET_CLOSURE } from "./packBasics2.js";
import { MAX_UNCLASSIFIED_MENTION_LINES } from "../facetGate.js";
import { additionalFacetSubjectFocals } from "./facetClosure2.js";
import { calleeDefinitionsForFocal } from "./focalFlow2.js";
import { calleeNamesIn } from "../evidenceClosure.js";
import { callerSitesForFocal } from "./focalFlow.js";
import { classifySurface } from "../../../util/impact.js";
import { conceptAliasGroupsIn } from "../requestFacets.js";
import { conceptTermsIn } from "../requestFacets.js";
import { constantClosureForFocal } from "./constantClosure.js";
import { facetDependencyEntriesFor } from "../facetGate.js";
import { facetPlanFor } from "../facetGate.js";
import { flowWindowsForFocal } from "./focalFlow2.js";
import { focalIsCallable } from "./focalFlow2.js";
import { focalRequiredSpan } from "../facetGate.js";
import { hasHashComments } from "../callerExpansion.js";
import { isFacetDescriptorTerm } from "../requestFacets.js";
import { laneScopedKey } from "../../../util/laneKey.js";
import { mapFlowFocal } from "./facetClosure2.js";
import { queryMentionsTests } from "../callerExpansion.js";
import { readCached } from "./packBasics2.js";
import { recordFacetPlan } from "../facetGate.js";
import { resolveFacetFocal } from "./callableResolution3.js";
import { sameFileFacetCallSites } from "./focalFlow2.js";
import { shaOfText } from "../../../util/handles.js";
import { sliceLinesToText } from "../../../util/countLines.js";
import { widenedCandidateFocus } from "./callableResolution4.js";
import { windowForCallSite } from "./focalFlow2.js";

// ---------------------------------------------------------------------------
// FIX-C1 (2026-09-27, eval-0927 P0-1/P0-2): facet-driven bounded evidence
// closure -- requestFacets.ts detects WHAT an answer must show
// (value/condition/callers/flow); evidenceClosure.ts's pure functions find
// same-file/one-import-hop constants and one-hop callee names; this section
// is the ONLY place either module is reached from, turning a real workspace
// read/parse into their plain-data inputs -- exactly the role
// `recoverCallerExpansionCandidates` above plays for callerExpansion.ts. The
// `callers`/`flow` facets reuse callerExpansion.ts's OWN pure functions
// directly (its logic, not its `TL_CALLER_EXPANSION` flag -- brief-fix-c1.md
// Deliverable 3 point 2) via `callSitesForFocalMember` above for a focal with
// a REAL enclosing type, and `plainFunctionCallerSites` below (skipping the
// receiver-strength gate) for a focal that is a plain top-level function: a
// bare call `fetchWithRetry(url)` carries no receiver, and the ONLY textual
// link to `callerExpansionTypeNameFor`'s file-stem fallback ("httpClient")
// is inside the calling file's OWN import string, which `maskNonCode`
// deliberately blanks -- so `fileNamesType` (and therefore
// `receiverStrength`) can never see it. A top-level function name has no
// cross-type ambiguity to guard against the way a class method's does, so
// every call-shaped, non-declaration occurrence outside the focal's own file
// counts.
// ---------------------------------------------------------------------------

/** Test-only observability, mirroring `callerExpansionEntryCount` above. */
export let facetClosureEntryCountForTest = 0;

export function resetFacetClosureEntryCountForTest(): void {
  facetClosureEntryCountForTest = 0;
}

/**
 * FIX-FAB item 10 (eval-0927 review #21, PLAUSIBLE-not-reproduced): the
 * facet plan memo and its undelivered-lines ledger (facetGate.ts) were keyed
 * on the bare workspace root alone -- exactly the (workspace, query)-only
 * keying `util/laneKey.ts`'s own module doc documents as a CONFIRMED,
 * already-fixed defect for OTHER stores (`certifiedWorkingSets`, F-V13-3):
 * two concurrent lanes asking the same query text shared one plan, and a
 * heavy lane could evict a peer lane's in-flight entry out of the shared
 * 32-per-workspace FIFO. `laneScopedKey` is the SAME mechanism this file
 * already uses for `readOnlyServedViewKey`/`lastPackBlocksByWorkspace` --
 * exact backward compatibility (returns the root UNCHANGED outside any
 * bound lane), and it also gives each lane its OWN dedicated 32-entry FIFO
 * instead of every lane competing for one shared one. `readCodeTaskPack.ts`'s
 * own three call sites (the seeded-pack plan check, `recoverFacetClosureCandidates`'s
 * `recordFacetPlan`, and `buildFacetReadiness`'s read side) all key through
 * this ONE function, so the write and read sides can never disagree.
 */
export function facetPlanWorkspaceKey(workspace: string): string {
  return laneScopedKey(path.resolve(workspace));
}

/** A source-bound plan for independently addressable read-only tail requests.
 * This grants no completion: each member still runs the ordinary pack gates.
 * In particular, losing/replacing the original facet plan disables batching.
 */
export function readonlyAnswerBatchPlan(workspace: string, query: string) {
  const key = facetPlanWorkspaceKey(workspace);
  const shaOf = (relPath: string): string | undefined => {
    const text = readCached(workspace, relPath);
    return text === undefined ? undefined : shaOfText(text);
  };
  const plan = facetPlanFor(key, query, shaOf);
  if (!plan || !plan.entries.some(entry => entry.facet === "flow" && entry.focal?.callable === false
    && entry.windows.length > 1)) return undefined;
  const snapshot = () => {
    const current = facetPlanFor(key, query, shaOf);
    return current === undefined ? undefined : JSON.stringify([
      current, facetDependencyEntriesFor(key, query, shaOf),
    ]);
  };
  const binding = snapshot();
  if (binding === undefined || Buffer.byteLength(binding) > 96 * 1024) return undefined;
  const entries = [...plan.entries, ...facetDependencyEntriesFor(key, query, shaOf)];
  const windows = entries.flatMap(entry => entry.windows).map(win => ({path:win.path,range:`${win.start}-${win.end}`}));
  if (windows.length === 0 || windows.length > 256 || entries.some(entry => entry.windows.some(win => win.truncated))) return undefined;
  return {windows, validate: () => snapshot() === binding};
}

/**
 * FIX-FAB item 11 (orchestrator report, 2026-09-27): the facet-closure
 * completeness decision (`planSitesComplete`, `constantClosureForFocal`'s
 * `complete`) must be a function of deterministic WORK budgets (files/call
 * sites/bytes examined via MAX_CALLER_FILES_EXAMINED, MAX_PLANNED_CONSTANT_WINDOWS,
 * MAX_CONSTANT_INITIALIZER_DEPTH, MAX_REEXPORT_HOPS, MAX_CALLEES_PER_REQUIREMENT
 * etc.), never of elapsed time -- confirmed root cause of replayCorpus
 * `sfflag1` flaking under load: `concernRecovery.ts`'s `CUMULATIVE_LOCATE_BUDGET_MS`
 * (1000 ms) was designed for a DIFFERENT, genuinely variable-cost operation
 * (a workspace-wide locate call) and was too tight a race for the closure
 * work this module added on top (barrel/re-export hops, a Go same-package
 * directory walk, depth-2 flow/initializer recursion) once the SAME box
 * carries concurrent load -- the certificate flipped `act.answer` ->
 * `discover` purely from machine speed, never from the evidence.
 *
 * This is deliberately generous and used ONLY as a last-resort circuit
 * breaker across every requirement + sub-scan combined: every individual
 * sub-scan's own WORK is already deterministically capped (a handful of
 * cached file reads and bounded recursion), so on any normal run --
 * including under the concurrent load several agents sharing one box
 * produce -- this is never reached and the decision is 100% a function of
 * the evidence found, not of how fast the box happened to be. If it is EVER
 * reached (a genuinely pathological case: a directory walk over an unusually
 * large workspace, a hung parse), every consumer already degrades to
 * `complete:false` / `constantsComplete:false`, which the gate discloses as
 * `request-item-undetermined` (P1) -- never a silent pass, never `empty`.
 */
export const FACET_CLOSURE_EMERGENCY_BUDGET_MS = 20_000;

/**
 * The facet-closure additions for one answer pack, for the caller to MERGE
 * (never to inject into the ranking) -- mirrors
 * `recoverCallerExpansionCandidates`'s own contract exactly, one requirement
 * at a time, with a shared byte budget (MAX_CLOSURE_BYTES_PER_PACK) and
 * per-path/range dedupe across requirements (two requirements naming the
 * same window add it once). Never guesses: a requirement with no resolvable
 * focal, or a focal with genuinely no compatible window, records that
 * outcome (`reason`/`emptyVerified`) rather than fabricating a window.
 */
export async function recoverFacetClosureCandidates(
  args: TaskPackArgs,
  query: string,
  workspace: string,
  cache: FileReadCache,
  selected: readonly ImpactCandidate[],
  requirements: readonly FacetRequirement[],
  /** FIX-G: record the gate's plan only — serve nothing, widen nothing (the seeded flow, whose caller-named surfaces must stand exactly as selected). */
  planOnly = false,
  /** v0.16 6t-7 T03: the answer pack's structure map (`structureMapForAnswer`); a flow over the type it maps requires the map's windows. */
  structureMap?: AnswerStructureMap,
  /** TL_EFF_MAP_ANSWER_FIRST: a DRY RUN — the caller passes COPIES of the selection and the run is the real run's, window by window, but nothing is counted or recorded; the windows it served and the plan it would record are collected here (`answerFirstPageHolds`). */
  trial?: FacetClosureTrial,
): Promise<{ additions: ImpactCandidate[]; outcomes: FacetClosureOutcome[]; widenedPaths: ReadonlySet<string> }> {
  if (trial === undefined) facetClosureEntryCountForTest += 1;
  // FIX-FAB item 9 (eval-0927 review #12, jaKanjiOnly): a zero-length
  // `selected` used to be an unconditional dead end. When the query's own
  // requirements ALSO carry no usable concept term, that is still correct —
  // there is nothing for `bestConceptAnchoredCandidate`'s workspace-wide
  // fallback to rank against either, so bailing here is unchanged from
  // before. But a kanji-only JA query bridged through jaGlossary.ts DOES
  // carry concept terms (待ち時間/既定/再試行/呼び出し元/条件, once resolved to
  // their EN stems) with NO lexical overlap in an English-named codebase, so
  // the ordinary locator selects nothing at all — and bailing here left
  // `resolveFacetFocal`'s own concept-anchored tier (which needs `selected`
  // to rank against) unreached, so the pack could only end in `await_input`
  // with no candidates and no `next`.
  const hasUsableConceptTerm = requirements.some((r) => r.subjectTerms.some((t) => t.length >= 3));
  if (selected.length === 0 && !hasUsableConceptTerm) return { additions: [], outcomes: [], widenedPaths: new Set() };
  // FIX-FAB item 11: an EMERGENCY stop only (see FACET_CLOSURE_EMERGENCY_BUDGET_MS's
  // own doc comment), not the routine budget every sub-scan's completeness is
  // judged against -- those are work-bounded now (CallerScanResult.complete,
  // constantClosureForFocal's own count/depth caps).
  const deadline = Date.now() + FACET_CLOSURE_EMERGENCY_BUDGET_MS;
  const allowTestPaths = queryMentionsTests(query);
  const additions: ImpactCandidate[] = [];
  const outcomes: FacetClosureOutcome[] = [];
  const widenedPaths = new Set<string>();
  const takenWindowKeys = new Set<string>();
  let bytesUsed = 0;
  // Copilot retest review (2026-10-02): one callee resolution per focal per
  // pack, shared by its value, condition and flow requirements (each used to
  // resolve the same up-to-64 names again).
  const calleeMemo = new Map<string, Promise<CalleeDefinitions>>();
  const calleesOf = (focal: ResolvedFacetFocal): Promise<CalleeDefinitions> => {
    const key = `${focal.path}\u0000${focal.name}\u0000${focal.startLine}-${focal.endLine}`;
    let pending = calleeMemo.get(key);
    if (pending === undefined) {
      pending = calleeDefinitionsForFocal(focal, workspace, cache);
      calleeMemo.set(key, pending);
    }
    return pending;
  };

  const subjectLabel = (requirement: FacetRequirement): string =>
    requirement.subjectIdentifiers[0] ?? requirement.subjectTerms.slice(0, 3).join(",") ?? requirement.clause;

  /**
   * FIX-C1 (2026-09-27, live V01 reproduction): `mergeConcernAdditions`'s
   * rule (a) ("the window's own entry for this file stands") DROPS an
   * addition whose path is already in the pack's own selected window --
   * exactly RETRYABLE_STATUSES's own case, since `shouldRetry` (range 3-5)
   * is typically already selected by the ordinary locator/identifier
   * mechanisms for a "the shouldRetry conditions" clause, and the closure's
   * own window (RETRYABLE_STATUSES, line 1) would be silently discarded in
   * favour of the unchanged 3-5 entry -- reproducing the EXACT eval-0927 bug
   * this whole mechanism exists to fix, just one layer further down. Any
   * such collision is caught HERE (against `selected`, the SAME window
   * `mergeConcernAdditions` itself would check) and resolved by WIDENING
   * that existing candidate's `.range` in place instead of proposing a
   * same-path addition that would only be dropped: `selected`'s elements
   * are the SAME object references `candidates` holds
   * (`Array.prototype.slice` copies the array, never its elements), so
   * mutating one here reaches the live, still-being-assembled pack. A
   * widened entry's `.symbol` is cleared -- the same rule
   * `recoverCallerExpansionCandidates`'s own whole-file serve above
   * applies, and for the same reason: `candidateToSurface` re-points a
   * symbol-pinned candidate at that symbol's own (now stale, too narrow)
   * range, which would silently undo the widening.
   *
   * Residual limitation (not hit by V01/V03/§4/V05 nor by
   * evidenceClosure.spec.ts's per-language unit cases, so left as a
   * documented gap rather than fixed under time pressure): a collision with
   * a path selected BEYOND `selected`'s own window (candidates.length >
   * selectionLimit) is not detected here and would still be proposed as a
   * same-path addition; `mergeConcernAdditions`'s rule (b) then PROMOTES
   * that far entry's OWN narrower range unchanged, the same silent-drop
   * shape one layer further out.
   */
  /** Whether a selected candidate already carries the focal's required lines (its own symbol, or a range spanning them). */
  const selectedCoversFocal = (path: string, name: string, start: number, end: number): boolean => selected.some((candidate) => {
    if (candidate.path !== path) return false;
    if (candidate.symbol !== undefined) return candidate.symbol === name;
    const bounds = candidate.range?.match(/^(\d+)-(\d+)$/);
    const candidateStart = bounds ? Number(bounds[1]) : candidate.line;
    const candidateEnd = bounds ? Number(bounds[2]) : candidate.line;
    return candidateStart <= start && end <= candidateEnd;
  });

  const tryAddWindow = (path: string, start: number, end: number, why: string): boolean => {
    const range = `${start}-${end}`;
    const key = `${path}\0${range}`;
    if (takenWindowKeys.has(key)) return true; // already covered, not a failure
    const existing = selected.find((c) => c.path === path);
    if (existing !== undefined) {
      const bounds = existing.range?.match(/^(\d+)-(\d+)$/);
      const existingStart = bounds ? Number(bounds[1]) : existing.line;
      const existingEnd = bounds ? Number(bounds[2]) : existing.line;
      const widenedStart = Math.min(existingStart, start);
      const widenedEnd = Math.max(existingEnd, end);
      const widenedKey = `${path}\0${widenedStart}-${widenedEnd}`;
      if (takenWindowKeys.has(widenedKey)) return true;
      if (bytesUsed >= MAX_CLOSURE_BYTES_PER_PACK) return false;
      const content = readCached(workspace, path, cache);
      if (content === undefined) return false;
      const widenedBytes = Buffer.byteLength(sliceLinesToText(content, widenedStart, widenedEnd), "utf8");
      const existingBytes = Buffer.byteLength(sliceLinesToText(content, existingStart, existingEnd), "utf8");
      // Only the MARGINAL bytes count against the closure budget -- the
      // existing entry's own bytes were already going to be served
      // regardless of this hook.
      const marginalBytes = Math.max(0, widenedBytes - existingBytes);
      if (bytesUsed + marginalBytes > MAX_CLOSURE_BYTES_PER_PACK) return false;
      bytesUsed += marginalBytes;
      existing.range = `${widenedStart}-${widenedEnd}`;
      existing.line = widenedStart;
      if (existing.symbol !== undefined) widenedCandidateFocus.set(existing, existing.symbol);
      delete existing.symbol;
      takenWindowKeys.add(widenedKey);
      widenedPaths.add(path);
      return true;
    }
    if (bytesUsed >= MAX_CLOSURE_BYTES_PER_PACK) return false;
    const content = readCached(workspace, path, cache);
    if (content === undefined) return false;
    // P2-12 (round-4 review, V01 flagship; refined by the orchestrator): ONE
    // addition per path. `mergeConcernAdditions` keeps only the first
    // addition for a path, so a second window in a file this closure already
    // added — the focal and the constant it reads (`loadOptions` 13-15 and
    // `DEFAULT_OPTIONS` 7-11 of one 15-line config.ts), or two constants of
    // one module — widens that addition to their union, charged at the
    // marginal bytes, instead of being dropped and costing a second hop.
    // (Round 4 first promoted the whole small file whenever it fit the
    // remaining budget: that shipped a 4 KB config module for one line, and a
    // file promoted first could leave no room for another file's required
    // window.)
    const sibling = additions.find((addition) => addition.path === path);
    if (sibling !== undefined) {
      const bounds = /^(\d+)-(\d+)$/.exec(sibling.range ?? "");
      const siblingStart = bounds ? Number(bounds[1]) : sibling.line;
      const siblingEnd = bounds ? Number(bounds[2]) : sibling.line;
      const unionStart = Math.min(siblingStart, start);
      const unionEnd = Math.max(siblingEnd, end);
      const marginalBytes = Buffer.byteLength(sliceLinesToText(content, unionStart, unionEnd), "utf8")
        - Buffer.byteLength(sliceLinesToText(content, siblingStart, siblingEnd), "utf8");
      if (bytesUsed + marginalBytes > MAX_CLOSURE_BYTES_PER_PACK) return false;
      bytesUsed += marginalBytes;
      sibling.range = `${unionStart}-${unionEnd}`;
      sibling.line = unionStart;
      takenWindowKeys.add(key);
      return true;
    }
    const bytes = Buffer.byteLength(sliceLinesToText(content, start, end), "utf8");
    if (bytesUsed + bytes > MAX_CLOSURE_BYTES_PER_PACK) return false;
    bytesUsed += bytes;
    takenWindowKeys.add(key);
    // P2-11(a) (eval-0927 review r2 finding 11, fanInConsts): this window's
    // bytes were budgeted against MAX_CLOSURE_BYTES_PER_PACK using EXACTLY
    // the bytes actually served (above) -- `callerRange: true` is the
    // existing "hard window, never widen" contract candidateToSurface
    // already honours for a caller-pinned exact line (literal-first source
    // witnesses, callerRange windows) -- reusing it here stops a LATER,
    // unaccounted small-file promotion (`tinyFileWholeRange`) from silently
    // re-widening a window this closure already budgeted exactly past what
    // MAX_CLOSURE_BYTES_PER_PACK ever charged for it.
    additions.push({
      path, line: start, range, surface: classifySurface(path), why,
      confidence: 0.85, callerRange: true,
    });
    return true;
  };

  // FIX-G (2026-09-27): the PLAN the completion gate judges every hop of this
  // query against (facetGate.ts's memo) — recorded beside, never instead of,
  // FIX-C1's own serving below. `servingOpen` keeps FIX-C1's surface-count
  // guard for SERVING only: a requirement reached after that guard closes is
  // still planned (its windows become an honest ranged `next`), where it used
  // to be recorded as "budget-exhausted" with nothing known about it. Only the
  // wall-clock deadline genuinely stops planning.
  const planEntries: FacetPlanEntry[] = [];
  const planPaths = new Set<string>();
  // WP-F (eval-0929 §7 bullet 3 / §8 row 4): the NARROW anchor set rule (b)
  // needs -- only the FOCAL path each PRIOR requirement actually settled on,
  // never every constant/callee/caller-site/mention path its closure also
  // served (`planPaths` above, added to below at every one of those sites
  // too). Conflating the two is a live regression, not a hypothetical: the
  // `RETRY_STATUSES`/`condvals_path` case served `src/limits.ts` as
  // `canRetry`'s OWN constant window (a plain closure dependency, not a
  // focal), and if that path were then trusted as a rule (b) ANCHOR for the
  // very next requirement asking about `RETRY_STATUSES` itself, the
  // "an anchor cannot vouch for itself" exclusion in `findDeclaredCallableAmong`
  // would disqualify `limits.ts` from winning ITS OWN disambiguation --
  // exactly backwards.
  const priorFocalPaths = new Set<string>();
  // 2026-10-06 independent review (P1-4): a work queue rather than a plain
  // loop over `requirements` — a requirement naming several subjects
  // ("Explain retryDelay and calculateTotal, including … callers") queues
  // one item per OTHER subject that resolves to its own declaration
  // (`additionalFacetSubjectFocals`) right behind it, each closed and planned
  // exactly like the primary focal, under its own `subject`.
  const work: Array<{ requirement: FacetRequirement; focal?: ResolvedFacetFocal }> = requirements.map((requirement) => ({ requirement }));
  for (let workIndex = 0; workIndex < work.length; workIndex += 1) {
    const { requirement, focal: queuedFocal } = work[workIndex]!;
    const subjectKey = queuedFocal === undefined ? {} : { subject: queuedFocal.name };
    if (Date.now() >= deadline) {
      outcomes.push({ facet: requirement.facet, clause: requirement.clause, subject: queuedFocal?.name ?? subjectLabel(requirement), focal: [], windows: [], reason: "budget-exhausted" });
      planEntries.push({ facet: requirement.facet, clause: requirement.clause, ...subjectKey, resolution: "budget-exhausted", windows: [] });
      continue;
    }
    // Copilot retest (2026-10-02): the same ceiling the answer pack's merge of
    // these additions honours (MAX_SURFACES_WITH_FACET_CLOSURE);
    // MAX_CLOSURE_BYTES_PER_PACK is the real bound on what this hook serves.
    const servingOpen = !planOnly && additions.length < MAX_SURFACES_WITH_FACET_CLOSURE;
    const serve = (path: string, start: number, end: number, why: string): boolean => {
      const served = servingOpen && tryAddWindow(path, start, end, why);
      if (trial !== undefined && served) trial.served.push({ path, start, end });
      return served;
    };
    const focal = queuedFocal ?? mapFlowFocal(requirement, structureMap) ?? await resolveFacetFocal(requirement, selected, args, workspace, cache, allowTestPaths, deadline, priorFocalPaths);
    if (focal === undefined) {
      outcomes.push({ facet: requirement.facet, clause: requirement.clause, subject: subjectLabel(requirement), focal: [], windows: [], reason: "no-focal" });
      planEntries.push({ facet: requirement.facet, clause: requirement.clause, resolution: "no-focal", windows: [] });
      continue;
    }
    if (queuedFocal === undefined && focal.ambiguousWith === undefined) {
      const others = await additionalFacetSubjectFocals(requirement, focal, selected, args, workspace, cache, allowTestPaths, deadline, priorFocalPaths);
      work.splice(workIndex + 1, 0, ...others.map((other) => ({ requirement, focal: other })));
    }
    // WP-F (eval-0929 §7 bullet 3 / §8 row 4): >= 2 same-named declarations
    // were visible and neither rule (a) nor rule (b) told `resolveFacetFocal`
    // which one the question means (see `ResolvedFacetFocal.ambiguousWith`'s
    // own doc) -- never chase constants/serve THIS candidate's body as if it
    // settled the question. Serve every candidate's own focal window instead
    // (bounded, same as the ordinary single-focal serve just below) and let
    // the gate disclose the ambiguity by name (facetGate.ts). Not added to
    // `planPaths`: an unresolved ambiguity is not a confident anchor for a
    // LATER requirement's own rule (b).
    if (focal.ambiguousWith !== undefined) {
      const ambiguousPaths: string[] = [];
      for (const candidate of focal.ambiguousWith) {
        ambiguousPaths.push(candidate.path);
        if (selected.length > 0) {
          const span = focalRequiredSpan(candidate.startLine, candidate.endLine, readCached(workspace, candidate.path, cache)?.split(/\r?\n/));
          if (span !== undefined && !selectedCoversFocal(candidate.path, candidate.name, span.start, span.end)) {
            serve(candidate.path, span.start, span.end, `closure:${requirement.facet} ${candidate.name} (ambiguous same-name declaration)`);
          }
        }
      }
      outcomes.push({ facet: requirement.facet, clause: requirement.clause, subject: subjectLabel(requirement), focal: ambiguousPaths, windows: [], reason: "ambiguous-same-name" });
      planEntries.push({
        facet: requirement.facet, clause: requirement.clause, resolution: "resolved", windows: [],
        ambiguousFocal: { name: focal.name, paths: ambiguousPaths },
      });
      continue;
    }
    const windows: Array<{ path: string; range: string; served: boolean }> = [];
    let totalCallSites: number | undefined;
    const planWindows: FacetPlanWindow[] = [];
    // P2-12 (orchestrator, round 4): every facet but `callers` requires the
    // focal's own lines (facetGate.ts `focalRequiredSpan`). When the pack
    // selected other lines but not these — the locator anchored on something
    // else, V01's config constant — serve them here, first, so a constant of
    // the same file then widens this one window and the answer needs no
    // second hop. A pack that selected NOTHING keeps the facet gate's own
    // query-bearing `next` for them: a closure window would become the pack's
    // only surface and turn it into a candidate confirmation (a plain slice
    // read with no decision after it).
    if (requirement.facet !== "callers" && selected.length > 0) {
      const focalSpan = focalRequiredSpan(focal.startLine, focal.endLine, readCached(workspace, focal.path, cache)?.split(/\r?\n/));
      if (focalSpan !== undefined && !selectedCoversFocal(focal.path, focal.name, focalSpan.start, focalSpan.end)) {
        serve(focal.path, focalSpan.start, focalSpan.end, `closure:${requirement.facet} ${focal.name}`);
      }
    }
    let planSites: FacetCallSite[] | undefined;
    let planTotalSites: number | undefined;
    let planSitesComplete: boolean | undefined;
    let planSitesFilesCapped: boolean | undefined;
    let planSitesRecordedCapped: boolean | undefined;
    let planUnresolved: string[] | undefined;
    let planUnresolvedPackages: Record<string, string> | undefined;
    let planUnresolvedSelfProperties: string[] | undefined;
    /** V4 (round-7 fable finding, valueBehindConfigAccessor): see `ConstantClosure.unresolvedConstructedValues`'s own doc. */
    let planUnresolvedConstructedValues: Record<string, string> | undefined;
    /** P1-4 (round-7 fable finding, item 4): see `ConstantClosure.unresolvedConstantCandidates`'s own doc. */
    let planUnresolvedConstantCandidates: Record<string, readonly string[]> | undefined;
    /** FIX-ALIAS (eval-0929 §4): see `ConstantClosure.unresolvedDependencies`'s own doc. */
    let planUnresolvedDependencies: Record<string, string> | undefined;
    let planConstantsComplete: boolean | undefined;
    let planUnclassifiedMentions: FacetMentionLine[] | undefined;
    let planUnclassifiedMentionsCapped: boolean | undefined;
    /** P0-2 (R7-A, eval-0927 review-r6 finding 2): see `focalIsSoleDefaultExport`'s own doc. */
    let planFocalDefaultExported: boolean | undefined;
    /** Copilot retest (2026-10-02): see `CalleeDefinitions.complete`. */
    let planCalleesComplete: boolean | undefined;
    let planUnresolvedCallees: string[] | undefined;
    planPaths.add(focal.path);
    priorFocalPaths.add(focal.path);

    if (requirement.facet === "value" || requirement.facet === "condition") {
      const ownTerms = conceptTermsIn(requirement.clause).filter((term) => term.length >= 3 && !isFacetDescriptorTerm(term));
      const alternatives = conceptAliasGroupsIn([requirement.clause]);
      const grouped = new Set(alternatives.flat());
      const points = [...alternatives.filter((group) => group.some((term) => ownTerms.includes(term))),
        ...ownTerms.filter((term) => !grouped.has(term)).map((term) => [term])];
      const focalLines = readCached(workspace, focal.path, cache)?.split(/\r?\n/).slice(focal.startLine - 1, focal.endLine) ?? [];
      const asksNamedTypeCallee = points.length > 0 && calleeNamesIn(focalLines, hasHashComments(focal.path), focal.name, new Set([focal.name]))
        .some((name) => points.every((group) => group.some((term) => name.toLowerCase().includes(term))));
      const callees = focalIsCallable(focal, workspace, cache) || asksNamedTypeCallee ? await calleesOf(focal) : undefined;
      const closure = await constantClosureForFocal(focal, workspace, cache, deadline, callees?.windows);
      // Copilot retest (2026-10-02): every constant the closure found is
      // served and required -- the focal's own and the ones its callees
      // read -- and so are the callees' own bodies just below: what a
      // callable returns or decides is computed by them, so once a callee's
      // body is evidence its constants are part of the answer, not
      // speculative context. The old rule (serve the first
      // MAX_CONSTANTS_PER_REQUIREMENT, require callee constants only within
      // that bound, never a callee body) certified `quote()` from two of its
      // six callees. MAX_PLANNED_CONSTANT_WINDOWS and the callee ceilings
      // still bound the walk.
      for (const win of closure.windows) {
        const served = win.binding !== true && serve(win.path, win.start, win.end, `closure:${requirement.facet} ${win.name} (read by ${focal.name})`);
        windows.push({ path: win.path, range: `${win.start}-${win.end}`, served });
        planWindows.push({
          kind: "constant", path: win.path, start: win.start, end: win.end, name: win.name,
          ...(win.binding === true ? { binding: true } : {}),
          ...(win.truncated ? { truncated: true } : {}),
        });
        planPaths.add(win.path);
      }
      for (const callee of callees?.windows ?? []) {
        const served = callee.binding !== true && serve(callee.path, callee.start, callee.end, `closure:${requirement.facet} callee ${callee.name} (of ${focal.name})`);
        windows.push({ path: callee.path, range: `${callee.start}-${callee.end}`, served });
        planWindows.push({ kind: "callee", path: callee.path, start: callee.start, end: callee.end, name: callee.name,
          ...(callee.binding === true ? { binding: true } : {}) });
        planPaths.add(callee.path);
      }
      if (callees !== undefined && !callees.complete) planCalleesComplete = false;
      planUnresolvedCallees = callees?.unresolved;
      planUnresolved = closure.unresolved;
      if (Object.keys(closure.unresolvedPackages).length > 0) planUnresolvedPackages = closure.unresolvedPackages;
      if (closure.unresolvedProperties.length > 0) planUnresolvedSelfProperties = closure.unresolvedProperties;
      if (Object.keys(closure.unresolvedConstructedValues).length > 0) planUnresolvedConstructedValues = closure.unresolvedConstructedValues;
      if (Object.keys(closure.unresolvedConstantCandidates).length > 0) planUnresolvedConstantCandidates = closure.unresolvedConstantCandidates;
      if (Object.keys(closure.unresolvedDependencies).length > 0) planUnresolvedDependencies = closure.unresolvedDependencies;
      planConstantsComplete = closure.complete;
    }

    if (requirement.facet === "callers" || requirement.facet === "flow") {
      // FIX-FAB item 11: `complete` is a WORK-based fact from the scan itself
      // (every deterministically-bounded path examined), never a second,
      // racy read of the clock after the fact — see `CallerScanResult`'s doc.
      const {
        sites, complete: sitesComplete, filesCapped: sitesFilesCapped,
        unclassifiedMentions: crossFileMentions, unclassifiedMentionsCapped: crossFileMentionsCapped,
        focalDefaultExported,
      } = await callerSitesForFocal(focal, args, workspace, cache, allowTestPaths, deadline);
      planSitesComplete = sitesComplete;
      planSitesFilesCapped = sitesFilesCapped;
      if (focalDefaultExported === true) planFocalDefaultExported = true;
      totalCallSites = sites.length;
      // eval-0927 review (pi01HostCap B-F3): serve up to the call sites the
      // completion gate will require (MAX_REQUIRED_CALL_SITES), within this
      // closure's byte budget and the pack's surface cap. MAX_CALLER_SURFACES
      // (2) is the caller-EXPANSION feature's own bound; used here it left
      // every question about a function with 3+ callers one hop short of the
      // evidence the gate then demanded. The `why` names how many were served.
      //
      // P2-15 (eval-0927 review-r4 #15, sameNameTwoDeclsBothCalled): when the
      // served sites mix strength 2 (a bare/exact-receiver site, unambiguously
      // this declaration) with strength 1 (a weak-receiver or namespace-
      // qualified site that could just as easily belong to a DIFFERENT
      // same-named declaration elsewhere), the disclosure must not present
      // the count as one clean, unambiguous total.
      const mixedAttribution = sites.some((s) => s.strength === 1) && sites.some((s) => s.strength === 2);
      const siteWhy = `closure:callers ${focal.name}`;
      const firstAddition = additions.length;
      let servedSites = 0;
      const { sites: sameFile, mentions: sameFileMentions, mentionsCapped: sameFileMentionsCapped } = sameFileFacetCallSites(focal, workspace, cache);
      const servable: Array<{ readonly path: string; readonly line: number }> = [...sites, ...sameFile];
      for (const site of servable.slice(0, MAX_REQUIRED_CALL_SITES)) {
        if (additions.length >= MAX_SURFACES_DISTINCT) break;
        const window = await windowForCallSite(site, workspace, cache);
        const served = serve(site.path, window.start, window.end, siteWhy);
        if (served) servedSites += 1;
        windows.push({ path: site.path, range: `${window.start}-${window.end}`, served });
        planWindows.push({ kind: "caller", path: site.path, start: window.start, end: window.end, name: window.symbolName ?? focal.name });
      }
      // P0-2 (R7-A, eval-0927 review-r6 finding 2): "sites found -> the usual
      // rules, and the `why` says default importers under other names were
      // not followed" -- a served site is real evidence either way, but a
      // default-exported focal's TRUE fan-in may still include importers
      // this by-name scan cannot see at all.
      const defaultExportNote = focalDefaultExported === true
        ? "; a default import bound under a different local name would not be found here"
        : "";
      for (const addition of additions.slice(firstAddition)) {
        if (addition.why === siteWhy) {
          addition.why = mixedAttribution
            ? `${siteWhy} (${servedSites} of ${servable.length} call sites; attribution mixed with a same-named declaration elsewhere)${defaultExportNote}`
            : `${siteWhy} (${servedSites} of ${servable.length} call sites)${defaultExportNote}`;
        }
      }
      const allSites: FacetCallSite[] = [...sites.map((site) => ({ path: site.path, line: site.line })), ...sameFile];
      planTotalSites = allSites.length;
      // MENTION GUARD (R5-A1): merge cross-file and same-file unclassified
      // mentions, deduped by path+line, capped at the SAME
      // MAX_UNCLASSIFIED_MENTION_LINES total the gate discloses against.
      const mentionKeys = new Set<string>();
      const mergedMentions: FacetMentionLine[] = [];
      let mentionsCapped = crossFileMentionsCapped === true || sameFileMentionsCapped;
      for (const mentionLine of [...(crossFileMentions ?? []), ...sameFileMentions]) {
        const key = `${mentionLine.path}#${mentionLine.line}`;
        if (mentionKeys.has(key)) continue;
        mentionKeys.add(key);
        if (mergedMentions.length >= MAX_UNCLASSIFIED_MENTION_LINES) { mentionsCapped = true; break; }
        mergedMentions.push(mentionLine);
      }
      if (mergedMentions.length > 0) {
        planUnclassifiedMentions = mergedMentions;
        for (const mentionLine of mergedMentions) planPaths.add(mentionLine.path);
      }
      if (mentionsCapped) planUnclassifiedMentionsCapped = true;
      // P2-10 (eval-0927 review-r3 #10, manyCallers60in3): distinct from
      // `planSitesFilesCapped` (the scan never OPENED some caller files at
      // all) -- this is the recorder's OWN memo-size cap discarding sites the
      // scan already found and read. True only past MAX_RECORDED_FACET_CALL_SITES
      // (512), so an ordinary many-caller fixture records its full fan-in and
      // the gate's existing per-hop pagination (facetGate.ts) carries it all
      // the way to `covered`; the disclosure below is now the rare, honest
      // last resort for a fan-in even that generous cap cannot hold in one
      // in-process memo.
      planSitesRecordedCapped = allSites.length > MAX_RECORDED_FACET_CALL_SITES;
      planSites = allSites.slice(0, MAX_RECORDED_FACET_CALL_SITES);
      for (const site of planSites) planPaths.add(site.path);
    }
    let planFocalMakesCalls: boolean | undefined;
    let planFlowMembersComplete: boolean | undefined;
    let planUngroundedFlowTerms: string[] | undefined;
    if (requirement.facet === "flow") {
      const flow = await flowWindowsForFocal(focal, requirement, workspace, cache, calleesOf, structureMap);
      for (const callee of flow.windows) {
        const served = callee.binding !== true && serve(callee.path, callee.start, callee.end, `closure:flow callee ${callee.name} (of ${focal.name})`);
        windows.push({ path: callee.path, range: `${callee.start}-${callee.end}`, served });
        planWindows.push({ kind: "callee", path: callee.path, start: callee.start, end: callee.end, name: callee.name,
          ...(callee.binding === true ? { binding: true } : {}) });
        planPaths.add(callee.path);
      }
      planFlowMembersComplete = flow.membersComplete;
      if (!flow.calleesComplete) planCalleesComplete = false;
      planUnresolvedCallees = flow.unresolvedCallees;
      if (flow.ungroundedTerms.length > 0) planUngroundedFlowTerms = flow.ungroundedTerms;
      // FIX-G: whether the focal calls ANYTHING (resolved or not) — decides
      // "no flow evidence resolved" (undetermined) vs a genuinely empty flow.
      const focalContent = readCached(workspace, focal.path, cache);
      planFocalMakesCalls = focalContent !== undefined
        && calleeNamesIn(focalContent.split(/\r?\n/).slice(focal.startLine - 1, focal.endLine), hasHashComments(focal.path), focal.name, new Set([focal.name])).length > 0;
    }

    outcomes.push({
      facet: requirement.facet,
      clause: requirement.clause,
      subject: focal.name,
      focal: [`${focal.path}#${focal.name}`],
      windows,
      ...(totalCallSites !== undefined ? { totalCallSites } : {}),
      ...(windows.length === 0 ? { emptyVerified: true } : {}),
    });
    planEntries.push({
      facet: requirement.facet,
      clause: requirement.clause,
      ...subjectKey,
      resolution: "resolved",
      focal: {
        path: focal.path,
        name: focal.name,
        start: focal.startLine,
        end: focal.endLine,
        ...(focal.kind !== undefined && !CALLER_EXPANSION_CALLABLE_KINDS.has(focal.kind) ? { callable: false } : {}),
      },
      windows: planWindows,
      ...(planSites !== undefined ? { callSites: planSites } : {}),
      ...(planTotalSites !== undefined ? { totalCallSites: planTotalSites } : {}),
      ...(planSitesComplete !== undefined ? { callSitesComplete: planSitesComplete } : {}),
      ...(planSitesFilesCapped === true ? { callSitesFilesCapped: true } : {}),
      ...(planSitesRecordedCapped === true ? { callSitesRecordedCapped: true } : {}),
      ...(planUnresolved !== undefined && planUnresolved.length > 0 ? { unresolvedConstants: planUnresolved } : {}),
      ...(planUnresolvedPackages !== undefined ? { unresolvedConstantPackages: planUnresolvedPackages } : {}),
      ...(planUnresolvedSelfProperties !== undefined ? { unresolvedSelfProperties: planUnresolvedSelfProperties } : {}),
      ...(planUnresolvedConstructedValues !== undefined ? { unresolvedConstructedValues: planUnresolvedConstructedValues } : {}),
      ...(planUnresolvedConstantCandidates !== undefined ? { unresolvedConstantCandidates: planUnresolvedConstantCandidates } : {}),
      ...(planUnresolvedDependencies !== undefined ? { unresolvedDependencies: planUnresolvedDependencies } : {}),
      ...(planConstantsComplete !== undefined ? { constantsComplete: planConstantsComplete } : {}),
      ...(allowTestPaths ? {} : { callSitesExcludeTests: true }),
      ...(planFocalMakesCalls !== undefined ? { focalMakesCalls: planFocalMakesCalls } : {}),
      ...(planFlowMembersComplete !== undefined ? { flowMembersComplete: planFlowMembersComplete } : {}),
      ...(planCalleesComplete === false ? { calleesComplete: false } : {}),
      ...(planUnresolvedCallees !== undefined ? { unresolvedCallees: planUnresolvedCallees } : {}),
      ...(planUngroundedFlowTerms !== undefined ? { ungroundedFlowTerms: planUngroundedFlowTerms } : {}),
      ...(planUnclassifiedMentions !== undefined ? { unclassifiedMentions: planUnclassifiedMentions } : {}),
      ...(planUnclassifiedMentionsCapped === true ? { unclassifiedMentionsCapped: true } : {}),
      ...(planFocalDefaultExported === true ? { focalDefaultExported: true } : {}),
    });
  }
  const fileShas: Record<string, string> = {};
  for (const planPath of planPaths) {
    const content = readCached(workspace, planPath, cache);
    if (content !== undefined) fileShas[planPath] = shaOfText(content);
  }
  const plan: FacetPlan = { query, entries: planEntries, fileShas };
  if (trial !== undefined) {
    trial.plan = plan;
    return { additions, outcomes, widenedPaths };
  }
  recordFacetPlan(facetPlanWorkspaceKey(workspace), plan);
  return { additions, outcomes, widenedPaths };
}
