// receiptProgress — extracted implementation; imports point to the owning modules.
import type { ContinuationCall } from "./packBasics.js";
import type { ContinuationLike } from "./packBasics.js";
import type { ServedWindowScope } from "./packState2.js";
import type { TaskExecutionContract } from "@tokenlighten/types";
import type { TaskPackResult } from "../model.js";
import { MAX_BATCH_NEXT_HANDLES } from "./coverageAndContinuation.js";
import { admitReadOnlyNextCall } from "./unresolvedCalls.js";
import { canonicalContinuationCall } from "./packBasics.js";
import { classifyExecutedSearchHit } from "./seedAdmission.js";
import { codeTaskPackSurfaces } from "../artifactSections.js";
import { consultExecutedLocate } from "../../../util/packServeLog.js";
import { consultExecutedSearch } from "../../../util/packServeLog.js";
import { consultExecutedSearchResult } from "../../../util/packServeLog.js";
import { deriveNextFromPlan } from "./packBasics.js";
import { dirExistsCached } from "../../../util/packServeLog.js";
import { discoveryBundleNext } from "../canonicalDecision.js";
import { enforceContinuationBudget } from "../../../util/continuation.js";
import { executedSearchResults } from "../../../util/packServeLog.js";
import { firstUnservedPartialRange } from "./packState2.js";
import { hasExecutedNextBoundOrUnbound } from "../../../util/packServeLog.js";
import { hasServedCode } from "./wiringEvidence2.js";
import { nextFingerprint } from "../../../util/packServeLog.js";
import { packServedSpans } from "./packState2.js";
import { recordedAbsenceIsStale } from "./identifierAbsence2.js";
import { surfaceRangeShipped } from "./receiptProgress3.js";
import { unmatchedConcernTokens } from "./roleAndConcernScope3.js";

/**
 * D3 (2026-08-01, + same-day receipt-staleness fix): when a contract's
 * next_call names a locate this session ALREADY executed, advance it to a
 * batched read of that locate's own candidate handles — or suppress it (with
 * a reason) when the locate returned nothing. Shared by the fresh-build
 * choke point (suppressNonProgressingNextCall) and the receipt paths
 * (compactReceiptFromRecord serves both the subset receipt and the
 * exact-fingerprint replay), because a receipt replays the contract captured
 * BEFORE its next_call ran and would otherwise re-point at it forever.
 */
/** Actions advanceExecutedLocateNextCall's no-repeat check covers. tree keys on `path`; the rest key on `query`. */
export const GENERALIZED_NO_REPEAT_ACTIONS: ReadonlySet<string> = new Set(["locate", "find", "references", "tree"]);

/**
 * P1-b (2026-08-28): the RECEIPT call site (compactReceiptFromRecord) passes
 * this narrower set deliberately — see that call site's own comment for why
 * (no wire channel exists there for a NEW find/references/tree disclosure;
 * `read.task_pack`'s projector never ships `missing[]` and the frozen
 * `await_input` decision member carries no `gaps` key).
 */
export const LOCATE_ONLY_NO_REPEAT_ACTIONS: ReadonlySet<string> = new Set(["locate"]);

/**
 * F-V13-5 (2026-08-30, v0.13.0 external-verification P0-A): the actions whose
 * stale `next_call` a RECEIPT can carry but cannot itself repair.
 *
 * THE OBSERVED LOOP. A caller re-sent the same query seven times and got the
 * byte-identical `tl_search_files action=tree` `next` back every time, after
 * running that tree on turn one. The fresh-build path had the right brake all
 * along — `recordExecutedSearch` -> `suppressNonProgressingNextCall` ->
 * `advanceExecutedLocateNextCall(..., GENERALIZED_NO_REPEAT_ACTIONS)` ->
 * `repairSuppressedNextCall`, which either finds an alternative progress axis
 * or discloses an honest gap. The RECEIPT paths never reach it: an identical
 * (or qref-replayed, or semantically duplicate) request short-circuits on
 * `computePackFingerprint`, which hashes the REQUEST and therefore cannot see
 * that the stored contract's own next has since been consumed.
 * `compactReceiptFromRecord` then advances only `LOCATE_ONLY_NO_REPEAT_ACTIONS`
 * — deliberately, because it has no wire channel for a NEW find/references/tree
 * disclosure (see its own comment). So for exactly these three actions a
 * receipt re-proposed consumed work forever.
 *
 * THE FIX IS NOT A REFUSAL, not a widening of the receipt's own advance, and
 * NOT a decline. `guardExecutionDiscovery` records that refusing a
 * discovery-phase caller measurably drove native-tool desertion, and the
 * receipt's locate-only scope is load-bearing (pinned in
 * advanceExecutedLocateNextCall.spec.ts).
 *
 * DECLINING WAS TRIED FIRST AND IS WRONG, for a reason worth keeping: the
 * receipt is the ONLY read-family member that ships a top-level `missing[]`
 * (`projectTaskPack`'s allowlist has no such member), so falling through to a
 * full build trades a stale next for a LOST disclosure. sequenceCorpus's I5
 * invariant — "a continuation is progress or a disclosed gap, never a bare
 * terminus" — catches exactly that: the fall-through terminated with no next
 * AND no `missing[]`. So the three entry points REPAIR the contract they are
 * about to re-serve (drop the consumed next, say why) and serve the receipt,
 * which keeps both halves honest.
 *
 * The set is derived from the two published ones rather than spelled out, so
 * an action added to the generalized set joins this one automatically.
 */
export const RECEIPT_UNREPAIRABLE_STALE_ACTIONS: ReadonlySet<string> = new Set(
  [...GENERALIZED_NO_REPEAT_ACTIONS].filter((action) => !LOCATE_ONLY_NO_REPEAT_ACTIONS.has(action)),
);

/**
 * The action+term ledger's verdict for ONE proposed `tl_search_files` call: the
 * recorded candidate handles when EVERY term the call names has already been
 * searched this session, `undefined` when any of them is still owed.
 *
 * F-V13-5 (GATE-A, 2026-09-14) — ONE SEARCH, EVERY SPELLING. The key used to be
 * `args["query"]` alone. A proposed call written in the CANONICAL PLURAL
 * (`queries:["X"]`) therefore keyed on `""` and matched nothing this session
 * had ever recorded, so the brake read the ledger for a search nobody ran and
 * kept re-proposing the consumed one — the exact F-V13-5 loop, re-opened by a
 * producer (`selectCanonicalNext`) that mints the plural form directly.
 * `blockedSearchTerms` is the collapse-to-the-TERM helper TL142-01A already
 * built for `alternativeProgressAxis`'s Rule 1b (`queries[]` + `query` +
 * `scope.symbol`), reused rather than restated — the two must not disagree
 * about which spellings name the same search.
 *
 * EVERY named term must be recorded, not merely one: a two-term call whose
 * second term has never been searched still has real work owed, and suppressing
 * it would withdraw progress rather than prevent a repeat.
 */
export function executedSearchForProposedCall(
  workspace: string,
  action: string,
  args: Record<string, unknown>,
): string[] | undefined {
  const namedTerms = blockedSearchTerms(args);
  // I-6 fix (unchanged): a pathless tree keys on the workspace root, the SAME
  // fallback server.ts's `recordExecutedSearch` call records it under.
  const searchKeys = action === "tree"
    ? [String(args["path"] ?? workspace)]
    : namedTerms.length > 0 ? namedTerms : [String(args["query"] ?? "")];
  const consulted = searchKeys.map((key) => consultExecutedSearch(workspace, action, key));
  if (consulted.some((entry) => entry === undefined)) return undefined;
  return consulted.flatMap((entry) => entry ?? []);
}

/**
 * F-V13-5 (GATE-A, 2026-09-14): does this proposed call name a
 * find/references/tree whose every term this session already ran? The receipt
 * paths' question about a call that is NOT the contract's `next_call` — see
 * `receiptRecordWithoutConsumedSearch`.
 */
export function consumedReceiptSearchCall(
  workspace: string,
  // Structural, not `ContinuationCall`: the two carriers this asks about are
  // typed by DIFFERENT declarations of that name (`types`' own task-pack
  // `ContinuationCall` on `capability_gaps[].next_call`, the protocol
  // `ToolCall` alias on a record's `next`), and only `tool` + `arguments` are
  // read here.
  call: { readonly tool: string; readonly arguments?: unknown },
): boolean {
  if (call.tool !== "tl_search_files") return false;
  const args = (call.arguments ?? {}) as Record<string, unknown>;
  const action = typeof args["action"] === "string" ? args["action"] : "";
  if (!RECEIPT_UNREPAIRABLE_STALE_ACTIONS.has(action)) return false;
  return executedSearchForProposedCall(workspace, action, args) !== undefined;
}

export function advanceExecutedLocateNextCall(
  workspace: string,
  contract: TaskExecutionContract,
  allowedActions: ReadonlySet<string> = GENERALIZED_NO_REPEAT_ACTIONS,
): "advanced" | "suppressed" | "kept" {
  const nextCall = contract.next_call;
  if (nextCall === undefined || nextCall.tool !== "tl_search_files") return "kept";
  const ncArgs = (nextCall.arguments ?? {}) as Record<string, unknown>;
  const action = typeof ncArgs["action"] === "string" ? ncArgs["action"] : "";
  // P1-b (2026-08-28 review-fix wave): was `action !== "locate"` return
  // "kept" — a bare passthrough that let find/references/tree re-propose an
  // already-answered search forever, the same loop-class this locate-only
  // check already closed for locate (P0-2's own defect class). The fresh-
  // build call site (suppressNonProgressingNextCall) uses the default,
  // generalized set; the receipt call site restricts to locate-only.
  if (!allowedActions.has(action)) return "kept";
  // I-6 fix: a pathless tree keys on the workspace root, the SAME fallback
  // server.ts's recordExecutedSearch call now records it under — previously
  // `""` here, which never matched anything server.ts recorded (that call
  // used to skip a pathless tree entirely) and left a bare-tree next_call
  // permanently unrepairable by this function.
  const executed = executedSearchForProposedCall(workspace, action, ncArgs);
  if (executed === undefined) return "kept";
  // Only `locate` mints handles its candidates can be batch-read from
  // (candidateDetails[].handle). find/references/tree responses are
  // path/line-shaped with no handle affordance (findText.ts/findReferences.ts
  // never mint one), so advancing them to a `tl_read_file handles=[...]` next
  // would invent a call shape their own recorded candidates cannot back —
  // every non-locate action here only ever SUPPRESSES a proven repeat.
  if (action === "locate" && executed.length > 0) {
    contract.next_call = {
      tool: "tl_read_file",
      arguments: { handles: executed.slice(0, MAX_BATCH_NEXT_HANDLES) },
    };
    return "advanced";
  }
  delete contract.next_call;
  contract.reason = `${contract.reason}; next_call suppressed: that ${action} already ran this session and returned no usable candidates — widen scope (paths/cwd) or act on held evidence`;
  return "suppressed";
}

/**
 * TL142-01A: every term a blocked `tl_search_files` call is about, in all the
 * spellings a producer or a caller may use for the same question —
 * `queries:[...]` (the canonical form a pack proposes), the singular `query`
 * (what Rule 5 re-derives), and `scope.symbol` (the `references`/symbol form).
 *
 * The whole 01A defect is that these spellings were treated as different
 * searches: the executed `{queries:["validateToken"],scope:{kind:"symbol"}}`
 * and the re-derived `{query:"validateToken"}` fingerprint differently, so the
 * no-repeat ledger saw two unrelated calls. Collapsing them to the TERM here is
 * what lets one recorded result answer for any of them.
 */
export function blockedSearchTerms(blockedArgs: Record<string, unknown>): string[] {
  const terms: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === "string" && value.length > 0 && !terms.includes(value)) terms.push(value);
  };
  const queries = blockedArgs["queries"];
  if (Array.isArray(queries)) for (const entry of queries) push(entry);
  push(blockedArgs["query"]);
  const scope = blockedArgs["scope"];
  if (scope !== null && typeof scope === "object") push((scope as { symbol?: unknown }).symbol);
  return terms;
}

/**
 * A-F2 (2026-08-28): THE DETERMINISTIC ALTERNATIVE-AXIS RULES.
 *
 * `advanceExecutedLocateNextCall` already knew that suppressing a consumed
 * next is only half the job — its "advanced" arm turns an executed locate into
 * a batched read of that locate's own candidates, and
 * `suppressNonProgressingNextCall`'s dir arm turns a same-scope re-pack into a
 * tree of that scope. Both rules were reachable from exactly one call shape
 * each; every OTHER suppression fell straight through to a bare
 * `await_input: no-grounded-call-remains` with no next and no gap. This
 * generalizes the two rules and adds the surface-derived axes, in a fixed
 * order, and drops any candidate whose result this session has already
 * consumed.
 *
 * There is deliberately NO unconditional `tree` arm: the contract builder's
 * own rule is that "every fallback must name evidence that can resolve the
 * current proof gap", and a repo-wide inventory names none. When no rule
 * yields an unexecuted, evidence-naming call, the caller discloses an explicit
 * gap instead of inventing work.
 */
export function alternativeProgressAxis(
  workspace: string,
  lane: string,
  result: TaskPackResult,
  query: string,
  blocked: ContinuationCall,
  servedZoomScope?: ServedWindowScope,
  taskBinding?: string,
): ContinuationCall | undefined {
  const blockedArgs = (blocked.arguments ?? {}) as Record<string, unknown>;
  const candidates: ContinuationCall[] = [];

  // Rule 1 — generalizes advanceExecutedLocateNextCall's "advanced" arm: a
  // search whose candidates this session already holds becomes a batched read.
  if (blocked.tool === "tl_search_files") {
    const executed = consultExecutedLocate(workspace, String(blockedArgs["query"] ?? ""));
    if (executed !== undefined && executed.length > 0) {
      candidates.push({ tool: "tl_read_file", arguments: { handles: executed.slice(0, MAX_BATCH_NEXT_HANDLES) } });
    }
  }
  // Rule 2 — generalizes the same-scope re-pack arm: a re-pack of a directory
  // this caller already named becomes an inventory of that exact directory.
  if (blocked.tool === "tl_read_file" && blockedArgs["mode"] === "task_pack") {
    const requested = Array.isArray(blockedArgs["paths"]) ? blockedArgs["paths"] as unknown[] : [];
    for (const entry of requested) {
      const candidate = typeof entry === "object" && entry !== null
        ? String((entry as { path?: unknown }).path ?? "")
        : String(entry);
      if (candidate.length > 0 && dirExistsCached(workspace, workspace, candidate)) {
        candidates.push({ tool: "tl_search_files", arguments: { action: "tree", path: candidate } });
      }
    }
  }
  // Tolerates a loosely-typed producer-exit payload whose surfaces may already
  // have been projected away; the search axes above and below still apply.
  const surfaces = codeTaskPackSurfaces(Array.isArray(result.surfaces) ? result.surfaces : []);
  // Rule 1b (TL142-01A, 2026-09-13) — Rule 1 FOR THE ACTION A PACK ACTUALLY
  // PROPOSES.
  //
  // Rule 1 above reads `consultExecutedLocate`, which is hard-wired to
  // `action:"locate"` (util/packServeLog.ts). But for an open `identifier:*`
  // obligation `nextCallForUnresolved` proposes `find`/`symbols`, never
  // `locate` — so the one rule that could turn "the caller ran your search and
  // it found src/auth.ts" into "read src/auth.ts" was structurally unreachable
  // for every pack that hit this path. The blocked call then fell through to
  // Rule 4 (re-read an already-disclosed partial window of an UNRELATED served
  // file) and Rule 5 (re-derive a bare `{action:"find",query:t}` whose
  // fingerprint differs from the executed `{queries:[t],scope:{kind:"symbol"}}`
  // call, so the ledger filter below could not recognise it as a repeat) —
  // exactly the retry.ts-receipt / redundant-search rotation the report
  // observed.
  //
  // Reads the RESULT ledger, so it is action-agnostic by construction, and
  // proposes `targets` (paths, with the located range when the hit carried a
  // symbol line) rather than `handles`: a find/symbols response mints no
  // handles of its own, so a handle-shaped next would name something its own
  // recorded candidates cannot back — the reason Rule 1's `locate` arm is
  // restricted to locate in the first place.
  if (blocked.tool === "tl_search_files") {
    for (const term of blockedSearchTerms(blockedArgs)) {
      const recorded = consultExecutedSearchResult(workspace, lane, term, taskBinding);
      if (recorded === undefined) continue;
      // R1-B2 (2026-09-13 review round): the SAME code-bearing gate the seed
      // promotion applies, so the two mechanisms this wave built to agree on
      // "what did that search find" cannot disagree about whether a markdown
      // sentence counts. A prose-only hit is not the identifier's surface, and
      // proposing it as the read that discharges the obligation would reach the
      // same false certificate one call later.
      //
      // SHOULD-FIX 28 (2026-09-14, review round 4): `"located"` counts here too,
      // for the same reason it counts as a seed — proposing the read of a
      // located `.swift` declaration is progress the caller can act on, and the
      // read cannot mint a certificate on its own (the obligation gate applies
      // the identical code-bearing test to whatever gets served). Only
      // `"refused"` (prose/markup/doc class, or a KNOWN language whose
      // occurrences are all inside comments) stays out.
      const unservedHits = recorded.hits.filter((hit) =>
        !surfaces.some((surface) => surface.path === hit.path && hasServedCode(surface))
        && classifyExecutedSearchHit(workspace, hit.path, term) !== "refused");
      if (unservedHits.length === 0) continue;
      candidates.push({
        tool: "tl_read_file",
        arguments: {
          targets: unservedHits
            .slice(0, MAX_BATCH_NEXT_HANDLES)
            .map((hit) => ({ path: hit.path, ...(hit.symbol !== undefined ? { symbol: hit.symbol } : {}) })),
        },
      });
    }
  }
  // Rule 3 — a required surface with no served code re-serves its own handle
  // (the contract builder's `gapFallback`, reachable after suppression).
  //
  // P1-8 (2026-09-28, review round 4/5, kotlinFun): `hasServedCode` asks only
  // whether THIS REBUILD's own in-memory `TaskPackSurface` carries inline
  // `.code` — which is FALSE for a candidate-list surface this same response
  // ships as `prior` (already fully resident, so the wire correctly omits the
  // bytes rather than re-sending them). Rule 3 read that omission as "never
  // served" and kept re-offering the SAME candidate's handle every time the
  // discovery bundle it was bundled with got suppressed as already-executed —
  // observed live (kotlinFun): an `ambiguous-target` choose-candidate pack
  // whose OWN evidence already served both candidates in full re-proposed
  // candidate A's handle, then (once THAT read came back as a fresh, un-deduped
  // serve — the plain `content:auto` handle route does not consult the
  // ledger either) candidate B's handle, then dead-ended on a bodyless
  // `code-unchanged` receipt with no `next`. Gate Rule 3 on the SAME
  // session-wide served-range ledger `receiptContinuationDisposition` already
  // trusts over the record's own self-report (`surfaceRangeShipped` — "does
  // the caller already hold these bytes", not "does this rebuild's object
  // happen to embed them"): a surface the ledger proves already shipped is
  // never re-offered, so once every candidate is genuinely resident this axis
  // contributes nothing and `repairSuppressedNextCall` can reach its own
  // honest "exhausted" disclosure instead of looping.
  for (const surface of surfaces) {
    if (
      surface.required !== false
      && !hasServedCode(surface)
      && !surfaceRangeShipped(workspace, surface.path, surface.range)
    ) {
      candidates.push({ tool: "tl_read_file", arguments: { handle: surface.handle } });
    }
  }
  // Rule 4 — a disclosed-partial required surface zooms its first omitted
  // window (the builder's `partialFallback`).
  for (const surface of surfaces) {
    if (surface.required !== false) {
      const range = firstUnservedPartialRange(workspace, surface, servedZoomScope, packServedSpans(result));
      if (range !== undefined) {
        candidates.push({
          tool: "tl_read_file",
          arguments: { handle: surface.handle, range },
        });
      }
    }
  }
  // Rule 5 — a concern token the served bodies still do not match gets its own
  // find. Absence-proved tokens are already excluded by unmatchedConcernTokens,
  // and the ledger filter below catches anything it misses.
  //
  // TL142-01A: a token whose search THIS TASK ALREADY RAN is excluded here,
  // whatever the recorded result was. The ledger filter at the bottom of this
  // function compares FINGERPRINTS, so it could not catch this: the executed
  // call was `{queries:[t],scope:{kind:"symbol"}}` and the call re-derived
  // immediately above is `{query:t}` — semantically the same search, two
  // different fingerprints, so an already-answered search kept winning ahead of
  // Rule 1b's read of what that very search found. `executedSearchResults` is
  // consulted (not just the blocked call's own terms) because Rule 5 mints
  // calls for tokens the blocked call never named — which is also why the
  // blocked call's own recorded terms need no separate set: every one of them
  // is an entry of this same ledger.
  //
  // R1-S10b (2026-09-13 review round): TWO GUARDS, both of which this set
  // originally lacked. The ledger merges the LANE's unbound partition, which
  // every task in the lane that did not pass `task.epoch:"new"` shares, and the
  // set was unconditional — so any token any task had ever searched was excluded
  // from Rule 5 forever, including a token whose search was `scope.path`-narrowed
  // and settled nothing. A suppression is only honest when the search it rests on
  // actually answered the question:
  //  - the term must be named VERBATIM by this query (the same gate
  //    `executedSearchHitSeeds`/`promoteExecutedSearchAbsences` apply, and for
  //    the same reason: another task's search must not silence this one's), and
  //  - the recorded result must be a HIT or a PROVEN (caveat-free, un-narrowed,
  //    literal) absence. A record that settled nothing leaves Rule 5 free to
  //    propose the workspace-wide find, which IS the progress in that case.
  //
  // SHOULD-FIX 27 (2026-09-14, review round 4): A STALE RECORD NEITHER CERTIFIES
  // NOR SUPPRESSES. `promoteExecutedSearchAbsences` already refuses to project
  // an absence `recordedAbsenceIsStale` rejects; this set did not ask, so the
  // one rebuild that WITHDREW the proof also silenced the find that would
  // restore it — the chain reached `await_input:"no-grounded-call-remains"`
  // with no `next`, and re-running the search by hand did certify again. The
  // suppression and the projection now read the same predicate, so they cannot
  // disagree about whether a recorded absence is still worth anything.
  const alreadySearchedTerms = new Set(
    executedSearchResults(workspace, lane, taskBinding)
      .filter((entry) => query.includes(entry.term))
      // Scoped to ABSENCE records: `recordedAbsenceIsStale` answers "does this
      // recorded absence still describe the workspace", which is not a question
      // about a HIT record — and its test (a) would fire on exactly the hit whose
      // file this pack now serves, re-proposing a search that is already answered.
      .filter((entry) =>
        entry.hits.length > 0
        || (entry.absence?.scopeComplete === true && !recordedAbsenceIsStale(workspace, result, entry)))
      .map((entry) => entry.term),
  );
  for (const token of unmatchedConcernTokens(query, surfaces)) {
    if (alreadySearchedTerms.has(token)) continue;
    candidates.push({ tool: "tl_search_files", arguments: { action: "find", query: token } });
  }
  // Rule 6 (R1, 2026-08-28) — THE DISCOVERY BUNDLE IS AN AXIS, NOT A SEPARATE
  // ROUTE.
  //
  // `discoveryBundleNext` is the projector's own highest-ranked continuation,
  // and it satisfies this function's admission rule exactly — its paths are
  // "limited to files already related by served candidates or evidence edges",
  // which is what "name evidence that can resolve the current proof gap" means
  // for a re-pack. It was invisible here only because it is computed on the
  // WIRE side, so a pack whose contract next_call was suppressed declared
  // exhaustion while its own bundle route was still unexecuted — observed on
  // the qc1 replay shape, whose caller-supplied `surfaceRoles` make the
  // missing-roles hint byte-identical to the call being served.
  //
  // ORDERED LAST, deliberately: every shape rules 1–5 already repair keeps the
  // exact call it repaired to, so this rescues only the packs that would
  // otherwise have disclosed exhaustion. The ledger filter below still applies,
  // so a bundle this lane has already run is not proposed again.
  //
  // REACHABLE ONLY FROM THE PRODUCER EXIT, and that is the point: `qref` is
  // stamped in server.ts AFTER `buildTaskPack` returns, so at the in-build
  // choke `discoveryBundleNext` reads an unset `qref` and declines. The exit's
  // own call to this repair runs with the ref bound, which is where the axis
  // becomes real.
  const bundle = discoveryBundleNext(result);
  if (bundle !== undefined) candidates.push(bundle);

  const blockedFingerprint = nextFingerprint(blocked.tool, blockedArgs);
  for (const candidate of candidates) {
    const args = (candidate.arguments ?? {}) as Record<string, unknown>;
    if (nextFingerprint(candidate.tool, args) === blockedFingerprint) continue;
    // The predicate is RESULT CONSUMPTION, not byte novelty: an absent find and
    // an empty tree consumed their call just as much as a served slice did.
    if (hasExecutedNextBoundOrUnbound(workspace, lane, candidate.tool, args, taskBinding)) continue;
    const admitted = admitReadOnlyNextCall(candidate, query);
    if (admitted !== undefined) return admitted;
  }
  return undefined;
}

/**
 * A-F2: turn ONE suppressed next into either progress or an honest disclosure —
 * never into a bare dead end, and never into a smaller request.
 *
 * Shared by this module's choke point and server.ts's producer exit, which had
 * independently grown the same "delete next_call, set request-user-input"
 * rewrite. The exit copy additionally FILTERED the suppressed call's query out
 * of `missing[]`, which shrank the disclosed requirement set at the exact
 * moment the pack lost its ability to act on it; §A-6(2) makes disclosure of an
 * undischarged obligation permanent, so that filter is gone.
 */
export function repairSuppressedNextCall(
  workspace: string,
  lane: string,
  result: TaskPackResult,
  query: string,
  blocked: ContinuationLike,
  servedZoomScope?: ServedWindowScope,
  taskBinding?: string,
): "advanced" | "disclosed" {
  const contract = result.execution_contract;
  const alternative = alternativeProgressAxis(
    workspace, lane, result, query, canonicalContinuationCall(blocked)!, servedZoomScope, taskBinding,
  );
  (result as unknown as Record<string, unknown>)["retry_same_call"] = false;
  if (alternative !== undefined) {
    if (contract !== undefined) {
      contract.next_call = alternative;
      contract.next_action = "followup";
      delete contract.await_input_code;
      contract.max_additional_discovery_calls = Math.max(contract.max_additional_discovery_calls ?? 0, 1);
      contract.reason = `${contract.reason}; identical successful next replaced by the next unexecuted evidence axis`;
    }
    const plan = enforceContinuationBudget({
      version: 1,
      stages: [{ execution: "sequential", calls: [alternative] }],
    });
    if (plan) {
      result.continuation = plan;
      const next = deriveNextFromPlan(plan);
      if (next !== undefined) result.next = next;
    }
    return "advanced";
  }
  // Exhausted. Disclose the gap; keep every open obligation visible.
  const blockedTarget = typeof (blocked.arguments ?? {})["query"] === "string"
    ? String((blocked.arguments ?? {})["query"])
    : blocked.tool;
  if (contract !== undefined) {
    delete contract.next_call;
    contract.next_action = "request-user-input";
    contract.await_input_code = "no-grounded-call-remains";
    contract.max_additional_discovery_calls = 0;
    contract.reason = `${contract.reason}; identical successful next suppressed and every deterministic evidence axis is already consumed — the remaining gap is disclosed, not withdrawn`;
    const uncovered = (contract.evidence_model?.unresolved ?? []).slice(0, 8);
    contract.capability_gaps = [
      ...(contract.capability_gaps ?? []).filter((gap) => gap.kind !== "missing-evidence"),
      {
        kind: "missing-evidence" as const,
        recoverable: false,
        reason: `every deterministic evidence axis for ${blockedTarget} has already been executed this task`,
        ...(uncovered.length > 0 ? { obligation_ids: uncovered } : {}),
      },
    ].slice(0, 3);
  }
  delete result.next;
  delete result.continuation;
  // The producer exit calls this with a loosely-typed payload whose `missing`
  // may legitimately be absent (its previous inline copy guarded the same way).
  result.missing = [...new Set([
    ...(Array.isArray(result.missing) ? result.missing : []),
    `explicit-gap:${blockedTarget} (every deterministic evidence axis for it has already been executed)`,
  ])];
  // `missing[]` ships only on a partial pack (readFamily.ts A.8.2), and the
  // frozen `await_input` member carries no `gaps` key — so without this the
  // disclosure exists in-process and nowhere the caller can see it. A pack that
  // has run out of ways to discharge an obligation is not complete.
  if (result.coverage !== "partial") {
    result.coverage = "partial";
    result.coverage_reason ??= "concerns-uncovered";
  }
  return "disclosed";
}

/** Cap `reason` at `cap` chars on a clause boundary ("; " / " — "), never mid-word. */
export function capReasonAtClause(reason: string, cap: number): string {
  if (reason.length <= cap) return reason;
  const cut = reason.slice(0, cap);
  const boundary = Math.max(cut.lastIndexOf("; "), cut.lastIndexOf(" — "));
  if (boundary > 0) return cut.slice(0, boundary);
  const wordSafe = cut.replace(/\s+\S*$/, "");
  return wordSafe.length > 0 ? wordSafe : cut;
}
