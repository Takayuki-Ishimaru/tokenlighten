// receiptProgress — extracted implementation; imports point to the owning modules.
import type { ServedPackRecord } from "./packState2.js";
import type { ServedWindowScope } from "./packState2.js";
import type { TaskExecutionContract } from "@tokenlighten/types";
import type { TaskPackArgs } from "../model.js";
import type { TaskPackResult } from "../model.js";
import { COMPLETE_STOP_REASON } from "./packState4.js";
import { COMPLETE_STOP_REASON_ANSWER } from "./packState4.js";
import { DOC_SLIVER_ROUTE_MARKER } from "../docSliver.js";
import { RECEIPT_UNREPAIRABLE_STALE_ACTIONS } from "./receiptProgress2.js";
import { advanceExecutedLocateNextCall } from "./receiptProgress2.js";
import { consumedReceiptSearchCall } from "./receiptProgress2.js";
import { currentSessionLane } from "../../../util/laneKey.js";
import { dirExistsCached } from "../../../util/packServeLog.js";
import { hasExecutedNextBoundOrUnbound } from "../../../util/packServeLog.js";
import { isTraceEnabled } from "../../../util/trace.js";
import { normalizeContractLane } from "../../../util/packServeLog.js";
import { normalizePathEntry } from "./packBasics2.js";
import { normalizedRequestPath } from "./guideAndArtifactSurfaces.js";
import { repairSuppressedNextCall } from "./receiptProgress2.js";
import { shouldTraceReceiptRepairOnce } from "./identifierAbsence2.js";
import { trace } from "../../../util/trace.js";

/**
 * iter-2 W2: enrich a complete/focused (single-call OR cumulative) pack's route
 * with the explicit stop signal. Returns a route with action edit_from_handles
 * (or answer_from_handles for the answer profile), max_additional_tl_calls:0,
 * and a reason that leads with the stop language. Idempotent (never appends the
 * phrase twice). Non-complete coverage is returned unchanged.
 */
export function applyCompleteStopRoute(
  route: TaskPackResult["route"] | undefined,
  coverage: TaskPackResult["coverage"],
  isAnswer: boolean,
  partialPrimary = false,
): TaskPackResult["route"] | undefined {
  if (coverage !== "complete" && coverage !== "focused") return route;
  // A5 (2026-08-01 signal5-2 T03): an ANSWER pack whose primary surface is
  // disclosed-partial must not claim "working set complete / stop" with a zero
  // call budget — the queried behavior may sit in remaining_ranges (T03: 82% of
  // the class, including every lifecycle method the query named), and three
  // solver runs resolved that contradiction three different ways (zoom /
  // hedged answer / no answer at all). Grant ONE sanctioned same-handle zoom
  // and say so explicitly.
  const stop = isAnswer
    ? (partialPrimary
        ? "answer from resident handles; primary surface is partial — if the queried behavior lies in its remaining lines, ONE same-handle slice zoom is sanctioned first"
        : COMPLETE_STOP_REASON_ANSWER)
    : COMPLETE_STOP_REASON;
  const budget = isAnswer && partialPrimary ? 1 : 0;
  const action = isAnswer ? "answer_from_handles" : "edit_from_handles";
  if (route === undefined) {
    return { action, reason: stop, max_additional_tl_calls: budget };
  }
  // ONLY enrich an already-terminal handle route. A complete pack whose content
  // is insufficient (route inspect_handles) or whose primary is ambiguous (route
  // confirm_candidates) genuinely needs the follow-up — never rewrite that into
  // an edit-now stop.
  if (route.action !== "edit_from_handles" && route.action !== "answer_from_handles") {
    return route;
  }
  // L1 (2026-08-08 doc-authority serve honesty): a doc-sliver pack has already
  // REPLACED this clause with an honest one and raised the budget. Re-appending
  // "working set complete — stop discovery" on a re-serve receipt would restore
  // the exact false certificate the lever exists to remove.
  if (route.reason.includes(DOC_SLIVER_ROUTE_MARKER)) return route;
  if (route.reason.includes(stop)) {
    return { ...route, max_additional_tl_calls: budget };
  }
  // Preserve the specific already-computed reason (e.g. cumulative-coverage
  // provenance, the batch-edit nudge) by APPENDING the stop signal, so existing
  // reason-substring expectations still hold.
  return {
    ...route,
    reason: `${route.reason}; ${stop}`,
    max_additional_tl_calls: budget,
  };
}

/**
 * iter-2 W1: build the compact `pack_unchanged` receipt from a served-pack
 * record proven unchanged against `currentWorkspaceState`. Surfaces are stripped
 * to identity (handle/path/range/role + revalidation sha), NO bodies; the route
 * carries the W2 complete-stop signal; coverage_basis is preserved so a
 * cumulative-complete re-serve still reads trustworthy. Deliberately omits
 * frontier_index / served_earlier / verification (W3: never on a receipt).
 */
/**
 * D1/D3 (2026-08-01 probe sweep): a contract must never point BACKWARD.
 * (1) identity echo — next_call re-issues the very invocation that produced
 *     this pack (observed live: paths=[<dir>] packs whose remedy was the same
 *     query+dirs re-pack). Remedied with a tree inventory call on the first
 *     still-existing caller dir, else suppressed.
 * (2) executed echo — next_call names a locate this session ALREADY ran
 *     (observed live via a qref re-pack). Advanced to a batched read of the
 *     locate's own candidate handles, else suppressed.
 * Suppression stamps retry_same_call:false and says why in the reason.
 */
export function suppressNonProgressingNextCall(
  workspace: string,
  result: TaskPackResult,
  args: TaskPackArgs | undefined,
  effectiveQuery: string,
  servedZoomScope?: ServedWindowScope,
): void {
  const contract = result.execution_contract;
  const nextCall = contract?.next_call;
  if (contract === undefined || nextCall === undefined) return;
  const ncArgs = (nextCall.arguments ?? {}) as Record<string, unknown>;

  // The server records every successful tool action before the next pack can
  // be built.  A result (including absence/empty) is consumed work, so never
  // put the identical action back on the wire.
  const requestedLane = args as (TaskPackArgs & { lane?: unknown }) | undefined;
  // A-F1: the SAME normalization the dispatcher writes under. This read keyed
  // on "default" while the writer keyed on "" for every lane-less call, which
  // is exactly the default single-agent path, so the gate below never fired.
  const lane = normalizeContractLane(requestedLane?.lane);
  const taskBinding = requestedLane?.taskBinding;
  if (hasExecutedNextBoundOrUnbound(workspace, lane, nextCall.tool, ncArgs, taskBinding)) {
    // A-F2: suppression alone was a dead end. Try the deterministic axes first.
    repairSuppressedNextCall(workspace, lane, result, effectiveQuery, nextCall, servedZoomScope, taskBinding);
    return;
  }

  if (nextCall.tool === "tl_read_file" && ncArgs["mode"] === "task_pack" && args !== undefined) {
    const callerPaths = [
      ...(typeof args.path === "string" && args.path.length > 0 ? [args.path] : []),
      ...(args.paths ?? []).map((entry) => normalizePathEntry(entry).path)
        .filter((p): p is string => typeof p === "string" && p.length > 0),
    ].map(normalizedRequestPath).sort();
    const ncPaths = Array.isArray(ncArgs["paths"])
      ? (ncArgs["paths"] as unknown[])
          .map((p) => typeof p === "object" && p !== null ? String((p as { path?: unknown }).path ?? "") : String(p))
          .filter((p) => p.length > 0)
          .map(normalizedRequestPath)
          .sort()
      : [];
    const ncQuery = typeof ncArgs["query"] === "string" ? ncArgs["query"] : "";
    // unexpandedDirNext historically sliced the query to 80 chars — a prefix
    // match therefore counts as "the same query".
    const sameQuery = ncQuery.length > 0 && effectiveQuery.startsWith(ncQuery);
    const samePaths = ncPaths.length > 0 && JSON.stringify(ncPaths) === JSON.stringify(callerPaths);
    if (sameQuery && samePaths) {
      const dir = ncPaths.find((p) => dirExistsCached(workspace, workspace, p));
      // G4 (2026-09-08, qref-binding follow-up): bound-or-unbound, same as
      // this function's own primary check above — a handleless re-pack that
      // recovered THIS task's binding from its qref must not miss a tree
      // this session already ran under that same binding.
      if (dir !== undefined && !hasExecutedNextBoundOrUnbound(workspace, lane, "tl_search_files", { action: "tree", path: dir }, taskBinding)) {
        contract.next_call = { tool: "tl_search_files", arguments: { action: "tree", path: dir } };
      } else {
        // A-F2: the dir arm's own else-branch was a second bare dead end.
        repairSuppressedNextCall(workspace, lane, result, effectiveQuery, nextCall, servedZoomScope, taskBinding);
      }
      return;
    }
  }

  if (advanceExecutedLocateNextCall(workspace, contract) === "suppressed") {
    // A-F2: a locate that returned nothing is consumed work, not a terminus.
    repairSuppressedNextCall(workspace, lane, result, effectiveQuery, nextCall, servedZoomScope, taskBinding);
  }
}

/**
 * The contract a receipt may honestly re-serve: `contract` itself when its
 * `next_call` is still owed, or a COPY with a consumed find/references/tree
 * dropped and the reason stamped.
 *
 * Returns the argument BY IDENTITY when nothing is stale, so every receipt
 * that was correct before is byte-for-byte unchanged and the caller can tell
 * the two cases apart with `===`. The stored record and the live result are
 * never mutated: the repair happens on a clone.
 *
 * TWO LEDGERS, because the fresh-build gate consults two. `hasExecutedNext`
 * fingerprints the WHOLE call and is what `suppressNonProgressingNextCall`
 * tries first; `consultExecutedSearch` (via advanceExecutedLocateNextCall)
 * keys on `${action}::${query-or-path}`. Neither subsumes the other for this
 * class: a bare `{action:"tree"}` carries no path, and `hasExecutedNext`
 * fingerprints the WHOLE call — including the task/budget/scope envelope a
 * real dispatch almost always carries and a synthesized bare candidate never
 * does — so it alone can never recognize a repeat of exactly this shape
 * (I-6, 2026-08-30: measured, and reproduced end-to-end by root's unit
 * probe — `i6-fallback-result.json`'s `repeated_identically:true`). PRE-I-6,
 * a bare tree additionally had NO key in the action+term ledger at all
 * (server.ts's `recordExecutedSearch` call only fired `if (treePath !==
 * undefined)`), so neither ledger covered it. Both now key a pathless tree
 * under the workspace root (`treePath ?? workspace`, matched here by this
 * function's own `searchKey` fallback below) — the SAME fix
 * `noDeadEndCandidateAlreadyExecuted` above applies to the fresh-build
 * guard's own bare-tree candidate. The action+term ledger remains the one
 * that ALSO recognizes a call the agent executed under a different argument
 * SPELLING than the contract proposed (`references scope.symbol=X` for a
 * proposed `references query=X` — the observed loop, and the case the
 * wire's own exact-fingerprint `firstUnconsumed` filter cannot see). Only
 * "suppressed" counts from the first: an "advanced" locate is already
 * repaired in-receipt by `compactReceiptFromRecord`, and a "kept" next has
 * never run. Both arms stay inside RECEIPT_UNREPAIRABLE_STALE_ACTIONS, so a
 * read/zoom next is never touched.
 */
/**
 * F-V13-5 (GATE-A, 2026-09-14) — THE THIRD DOOR, opened by SHOULD-FIX 36 of
 * this same wave.
 *
 * `decisionWire.ts::gapNamedNext` mints `decision.next` from the FIRST
 * `capability_gaps[].next_call` whenever the contract itself names no call —
 * which is precisely the state the next_call repair below leaves a suppressed
 * receipt in. Until this wave that door could not open on a receipt at all:
 * `compactReceiptFromRecord` never restated `capability_gaps`, so every receipt
 * carried `undefined` there. SHOULD-FIX 36 (round 5) restates them — rightly,
 * a receipt that drops its own disclosure is worse — and the consumed
 * `tl_search_files references …` rode back out through the gap's copy of it,
 * re-serving the exact call F-V13-5 ratified as un-replayable (measured:
 * `{action:"references",query:"alphaTotal"}` handed back after the caller ran
 * it as `scope.symbol`).
 *
 * ONLY THE CALL IS DROPPED, never the gap. The disclosure is what SHOULD-FIX 36
 * exists to preserve and what sequenceCorpus's I5 invariant requires; what a
 * receipt may not do is point at work already done. Identity-preserving when
 * nothing is stale, so an unaffected receipt is byte-for-byte unchanged.
 */
export function receiptContractWithoutConsumedGapCall(
  workspace: string,
  contract: TaskExecutionContract | undefined,
): TaskExecutionContract | undefined {
  const gaps = contract?.capability_gaps;
  if (contract === undefined || gaps === undefined || gaps.length === 0) return contract;
  let changed = false;
  const scrubbed = gaps.map((gap) => {
    if (gap.next_call === undefined || !consumedReceiptSearchCall(workspace, gap.next_call)) return gap;
    changed = true;
    const { next_call: _consumed, ...rest } = gap;
    return rest;
  });
  return changed ? { ...contract, capability_gaps: scrubbed } : contract;
}

export function receiptContractWithoutConsumedSearch(
  workspace: string,
  contract: TaskExecutionContract | undefined,
  /**
   * I-7 (2026-08-30 forensics attribution wave): the lane the STORED record
   * this contract came from was served into, defaulting to the current lane
   * for the one call site (`tryServeSubsetReceipt`'s synthetic, never-stored
   * record) that has no separate record to compare against — see
   * ServedPackRecord.lane's own F-V13-3 doc comment; `same_lane` below is a
   * regression canary for that exact cross-lane leakage class, not a
   * functional input to the repair decision itself.
   */
  recordLane: string = currentSessionLane(),
  /**
   * G4 (2026-09-08, qref-binding follow-up): the SAME canonical task binding
   * `suppressNonProgressingNextCall`'s own primary check already consults
   * (`server.ts`'s `canonicalTaskBindingOf(args) ?? taskPackQuery.taskBinding`,
   * threaded here by each of the three receipt call sites from the CURRENT
   * request's own `TaskPackArgs.taskBinding`) — never re-derived from
   * `recordLane`/the stored record, which name the PRIOR pack, not this
   * request. Optional so every existing 2-arg call this function predates
   * stays byte-identical.
   */
  taskBinding?: string,
): TaskExecutionContract | undefined {
  // GATE-A (2026-09-14): the gap-carried copy of a consumed search is scrubbed
  // FIRST and unconditionally — it is a separate carrier, reachable whether or
  // not this contract's own `next_call` is stale (and reachable precisely
  // BECAUSE the repair below may have already removed that one). Every
  // identity-preserving return below hands back `scrubbed`, which IS `contract`
  // by identity when no gap was stale — so `receiptRecordWithoutConsumedSearch`'s
  // `===` comparison still tells the two cases apart correctly.
  const scrubbed = receiptContractWithoutConsumedGapCall(workspace, contract);
  const nextCall = scrubbed?.next_call;
  if (scrubbed === undefined || nextCall === undefined) return scrubbed;
  if (nextCall.tool !== "tl_search_files") return scrubbed;
  const ncArgs = (nextCall.arguments ?? {}) as Record<string, unknown>;
  const action = typeof ncArgs["action"] === "string" ? ncArgs["action"] : "";
  if (!RECEIPT_UNREPAIRABLE_STALE_ACTIONS.has(action)) return scrubbed;
  // THE WIRE ALREADY OWNS HALF OF THIS, AND MUST KEEP IT. `projectTaskDecision`
  // filters a consumed candidate out of its own precedence chain
  // (`firstUnconsumed`), so a receipt whose next this lane executed VERBATIM
  // still progresses — the chain simply falls through to the discovery bundle
  // or a gap-named call. Repairing that case here would replace a progressing
  // continuation with a bare terminus, because a contract with no `next_call`
  // canonicalizes to `await_input` and the wire's other candidates are then
  // never consulted (sequenceCorpus's I5 invariant catches exactly this).
  //
  // What the wire CANNOT see is a call executed under a different argument
  // spelling than the contract proposed, because its filter is a whole-call
  // fingerprint: `references scope.symbol=X` does not fingerprint-match a
  // proposed `references query=X`, so the identical next came back every time.
  // That — and only that — is what this repairs.
  //
  // G4: bound-or-unbound, same reasoning as the fresh-build gate's own
  // primary check — a handleless re-pack that recovered this task's binding
  // from its qref must not miss an execution this session recorded under
  // that binding.
  if (hasExecutedNextBoundOrUnbound(workspace, currentSessionLane(), nextCall.tool, ncArgs, taskBinding)) return scrubbed;
  const repaired: TaskExecutionContract = { ...scrubbed, next_call: structuredClone(nextCall) };
  const outcome = advanceExecutedLocateNextCall(workspace, repaired, RECEIPT_UNREPAIRABLE_STALE_ACTIONS);
  if (outcome === "kept") return scrubbed;
  // I-7: the contract was ACTUALLY repaired — the one place shared by all
  // three receipt call sites (tryServeSubsetReceipt's own no-record call,
  // tryServeCachedPack, tryServeSemanticDuplicatePack via
  // receiptRecordWithoutConsumedSearch) where a stale next_call this
  // request's own fingerprint-match check could not see gets fixed before
  // the receipt goes out. See this function's own long doc comment above for
  // why a decline was tried first and is wrong. `outcome` here is always
  // "suppressed" today (RECEIPT_UNREPAIRABLE_STALE_ACTIONS excludes
  // "locate", the only action advanceExecutedLocateNextCall's "advanced" arm
  // handles), kept as the callee's own three-value type rather than
  // hand-narrowed so this stays correct if that ever changes.
  if (isTraceEnabled() && shouldTraceReceiptRepairOnce()) {
    trace(
      "receipt_next_repair",
      {
        action,
        outcome,
        has_path: typeof ncArgs["path"] === "string" && (ncArgs["path"] as string).length > 0,
        same_lane: recordLane === currentSessionLane(),
      },
      workspace,
    );
  }
  return repaired;
}

/** The record a receipt may honestly re-serve; identity-preserving when nothing is stale. */
export function receiptRecordWithoutConsumedSearch(
  workspace: string,
  record: ServedPackRecord,
  // G4 (2026-09-08, qref-binding follow-up): the CURRENT request's own
  // canonical task binding — see receiptContractWithoutConsumedSearch's own
  // parameter doc comment.
  taskBinding?: string,
): ServedPackRecord {
  const repaired = receiptContractWithoutConsumedSearch(workspace, record.executionContract, record.lane, taskBinding);
  // F-V13-5 (GATE-A, 2026-09-14): THE OTHER DOOR. `compactReceiptFromRecord`
  // republishes the record's OWN top-level `next` exactly when the contract
  // carries no `next_call` — which is what the repair above has just made true
  // for a suppressed search. Repairing only the contract therefore moved the
  // consumed call one field sideways and the receipt handed it straight back
  // (measured: `references alphaTotal` re-served after the caller had run it
  // under `scope.symbol`, F-V13-5's own reproduction). The fresh-build path has
  // always dropped BOTH — `repairSuppressedNextCall`'s suppression arm deletes
  // `result.next` alongside the contract's call — so this is that same rule
  // reaching the receipt doors, not a new one.
  const staleTopLevelNext = repaired?.next_call === undefined
    && record.next !== undefined
    && consumedReceiptSearchCall(workspace, record.next);
  if (repaired === record.executionContract && !staleTopLevelNext) return record;
  return {
    ...record,
    executionContract: repaired,
    ...(staleTopLevelNext ? { next: undefined } : {}),
  };
}
