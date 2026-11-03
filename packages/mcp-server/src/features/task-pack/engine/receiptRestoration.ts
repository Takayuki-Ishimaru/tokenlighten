// receiptRestoration — extracted implementation; imports point to the owning modules.
import type { ReceiptConsumptionScope } from "./receiptProgress3.js";
import type { ReceiptExecutionAddress } from "../../../state/session.js";
import type { ServedPackRecord } from "./packState2.js";
import type { TaskExecutionContract } from "@tokenlighten/types";
import type { TaskPackArgs } from "../model.js";
import type { TaskPackResult } from "../model.js";
import type { TaskWorkspaceState } from "@tokenlighten/types";
import { LOCATE_ONLY_NO_REPEAT_ACTIONS } from "./receiptProgress2.js";
import { advanceExecutedLocateNextCall } from "./receiptProgress2.js";
import { applyCanonicalTaskDecision } from "../canonicalDecision.js";
import { applyCompleteStopRoute } from "./receiptProgress.js";
import { bindReceiptExecutionAddresses } from "../../../state/session.js";
import { capReasonAtClause } from "./receiptProgress2.js";
import { certificateBindingFor } from "./contractReconciliation.js";
import { computeClosureStateSafe } from "../../../util/closureTracking.js";
import { computeExtraArgsKey } from "./packState2.js";
import { currentSessionLane } from "../../../util/laneKey.js";
import { epochsOverlap } from "./packState2.js";
import { executedSearchResults } from "../../../util/packServeLog.js";
import { getSession } from "../../../state/session.js";
import { hasCertificateBinding } from "../canonicalDecision.js";
import { laneScopedKey } from "../../../util/laneKey.js";
import { lineSpansCover } from "./sourceAndConcernTerms.js";
import { noteInheritedTaskProfile } from "./coverageAndContinuation4.js";
import { parseUnreadableNamedPathRow } from "./servedStateAndEdits3.js";
import { queryServedSurfaces } from "../../../util/packServeLog.js";
import { readOnlyServedEntries } from "./epochEvidence.js";
import { receiptContinuationDisposition } from "./receiptProgress3.js";
import { restatableCreateTarget } from "./receiptProgress3.js";
import { servedLineSpansOf } from "./sourceAndConcernTerms.js";
import { servedPacksByWorkspace } from "./packState2.js";
import { surfaceFileIdentity } from "./packState2.js";
import { surfaceRangeShipped } from "./receiptProgress3.js";
import { surfaceRangeUnserved } from "./receiptProgress3.js";
import { tokenizeForEpoch } from "../../../state/session.js";

/**
 * TL142-01C: did THIS record's own contract certify a terminal action?
 *
 * The same four conjuncts `canonicalDecision.ts`'s (module-private)
 * `hasCertificateForTerminal` reads, restated here rather than exported,
 * because this call site asks about a STORED `ServedPackRecord`'s contract, not
 * about a freshly-built pack's. Kept adjacent to its single caller so the two
 * cannot drift silently: a change to the terminal floor that forgets this
 * predicate makes the receipt MORE conservative (declines, rebuilds), never
 * less — the safe direction.
 */
export function recordCertifiedTerminal(contract: TaskExecutionContract | undefined): boolean {
  return contract !== undefined
    && contract.state === "ready"
    && contract.discovery_complete === true
    && (contract.next_action === "answer" || contract.next_action === "edit")
    && hasCertificateBinding(contract);
}

/**
 * TL142-01C: a record with a STILL-PENDING create whose own contract never
 * certified must not be replayed as "nothing changed" once this task has served
 * evidence the record never saw.
 *
 * THE OBSERVED REGRESSION. The report's create query ("src/new-config.ts を新規
 * 作成してください…") opens with a `discover` pack that already resolves
 * `create_target` but whose contract is `needs-followup`; running that pack's
 * own prescribed `next` (a batched read of the sibling files) reaches
 * `act.edit` + `create_target`. A bare `{qref}` / `task:{handle}` resume — and a
 * plain query resend with no `task` field — all re-enter `tryServeCachedPack`,
 * whose fingerprint is over the TASK's pathless request, so all three match the
 * PRE-advance seed record and replay its `discover` + its already-executed
 * 4-file `next`. `create_target` and `act.edit` both vanish on an unchanged
 * workspace, and the caller is sent back around a loop it already completed.
 *
 * NARROW BY CONSTRUCTION, and each conjunct is load-bearing:
 *  1. the record carries a create target that is STILL absent
 *     (`restatableCreateTarget`) — the only class where replaying "nothing
 *     changed" withholds the single action the request asked for;
 *  2. the record's own contract is NOT certified (`recordCertifiedTerminal`) —
 *     a certified record is replayed normally, with its create target restated
 *     (see the `create_target` member of the receipt), so the receipt economy
 *     for the report's own "first call is already act.edit" shape is untouched;
 *  3. this task's cumulative served-surface ledger now holds a path the record
 *     never captured — proof that the rebuild has strictly more to certify
 *     from than the capture did. Without it, a genuine no-op repeat (nothing
 *     executed in between) would rebuild for nothing.
 *
 * TERMINATES IN ONE REBUILD: the rebuild re-captures this signature's record,
 * and a rebuild that now certifies makes conjunct 2 false for every later
 * repeat. A rebuild that still does not certify leaves conjunct 3 false (it
 * captures the paths it just saw), so the decline cannot repeat either.
 */
export function createPendingRecordIsStale(workspace: string, prev: ServedPackRecord): boolean {
  if (restatableCreateTarget(workspace, prev) === undefined) return false;
  if (recordCertifiedTerminal(prev.executionContract)) return false;
  const capturedPaths = new Set(prev.surfaces.map((s) => s.path));
  return queryServedSurfaces(workspace, workspace, { epochTokens: prev.epochTokens })
    .some((entry) => !capturedPaths.has(entry.path));
}

/**
 * TL142-01B: an UNCERTIFIED ANSWER record captured before this task proved a
 * request term absent must not be replayed as "nothing changed".
 *
 * THE OBSERVED DEAD END. `Explain validateToken and quantumTeleportationMode.`
 * serves `validateToken` and prescribes `find quantumTeleportationMode`. The
 * caller runs it; the reply is an exhaustive, literal, un-narrowed absence
 * certificate. The resume exact-fingerprint-matches the PRE-search record, and
 * a receipt can only RESTATE a readiness verdict, never re-derive one — so it
 * restated "needs-followup" over a search that had already been spent, and the
 * producer exit turned that into `await_input:"no-grounded-call-remains"`. The
 * one thing that could close the task (the absence is the answer for that term)
 * had no way in. The rebuild this decline forces DOES re-derive it, via
 * `promoteExecutedSearchAbsences`.
 *
 * DELIBERATELY NARROWER THAN "any newer search result". `receiptContinuation-
 * Disposition`'s own doc comment records an earlier ruling (F-V13-5): a
 * consumed SEARCH continuation is repaired IN-RECEIPT and never declined,
 * because a fall-through recomputes the receipt's top-level `missing[]` from a
 * different premise and an absence-discharged CONCERN token reappears as an
 * `unresolved-ledger:` row the receipt had correctly dropped — sequenceCorpus's
 * I1/I3, which fails on the broader gate (measured). That ruling is about an
 * EDIT-intent pack's concern-token ledger. This gate therefore fires only on
 * the ANSWER side, where a proven absence is not a discharged requirement but
 * part of the answer itself, and only when:
 *  - the record is an answer receipt (`taskProfile`/`route`, the same predicate
 *    `compactReceiptFromRecord` already computes as `isAnswerReceipt`);
 *  - its contract never certified (a certified record is restated as-is —
 *    TL142-01C's `create_target` and the absences below ride along);
 *  - a scope-complete absence was recorded AFTER this record was captured
 *    (`ExecutedSearchResult.sequence` vs `executedSearchSequence`);
 *  - and that term is one of this task's own epoch tokens, so an unrelated
 *    search in the same lane cannot invalidate this record.
 *
 * Self-limiting exactly like the other decline on this path: the rebuild
 * captures the current sequence, so the next identical repeat receipts again.
 */
export function answerRecordPredatesProvenAbsence(
  workspace: string,
  prev: ServedPackRecord,
  taskBinding?: string,
): boolean {
  if (prev.taskProfile !== "answer" && prev.route?.action !== "answer_from_handles") return false;
  if (recordCertifiedTerminal(prev.executionContract)) return false;
  const epochTokens = new Set(prev.epochTokens);
  return executedSearchResults(workspace, prev.lane, taskBinding).some((entry) =>
    entry.absence !== undefined
    && entry.hits.length === 0
    && entry.sequence > prev.executedSearchSequence
    && tokenizeForEpoch(entry.term).some((token) => epochTokens.has(token)));
}

/**
 * FIX-D (TL-06, 2026-09-21, plan §8.1) — A NON-TERMINAL DECLARED-ANSWER
 * RECORD MUST NOT BE REPLAYED ONCE THIS TASK HAS SERVED EVIDENCE THE RECORD
 * NEVER CAPTURED.
 *
 * CONFIRMED regression (repackMonotonicitySpawned.spec.ts "same-task record
 * supersession" cases; live trace against both a hand-written fixture and
 * the four-concern quality-first fixture, `qualityFirst0143.acceptance.
 * spec.ts`'s Q05). A declared `task.profile:"answer"` task's pathless
 * discover seed serves one or more surfaces and proposes the rest of the
 * request's targets as its own `next`; the caller runs that `next` (explicit
 * `targets` + `task.handle`) and this SAME task serves the remaining
 * surfaces. A bare `{qref, cwd}` resume — or a plain query resend with no
 * `task` field, or a `task.handle` continuation that happens to carry no new
 * `targets` — all fingerprint like the ORIGINAL pathless seed
 * (`computePackFingerprint` hashes `paths`, which the seed never had), so
 * `tryServeCachedPack` / `tryServeSemanticDuplicatePack` match the SEED
 * record, several calls back in the bounded window, and (absent this check)
 * `revalidateRecordToReceipt` replayed it verbatim: the seed's own stale
 * `discover`, the identical already-executed `next`, the identical `gaps` —
 * as if the intervening targets-bearing call had never happened. A verbatim
 * follower then loops.
 *
 * MUST CHECK BOTH STORES. A naive reading of `cumulativeEligible` suggests a
 * declared-answer task's later progress lives ONLY in the WP-S11 read-only
 * served view — but `cumulativeEligible` is recomputed PER CALL from THAT
 * call's OWN `profile_binding.source`, not once for the whole task:
 * `inheritDeclaredTaskProfile` (server.ts) only injects `taskProfile:
 * "answer"` onto a continuation when auto-inference would otherwise pick
 * something else, so a continuation whose wording ALSO auto-infers "answer"
 * on its own is left exactly as sent and binds with `source:"inferred"`,
 * NOT "explicit" — measured live: the seed call (explicit) and its own
 * targets-bearing follow-up (inferred) disagreed on `cumulativeEligible`
 * within the SAME task, so the follow-up's surfaces landed in the
 * CUMULATIVE served-surface log while the seed's own surfaces sat in the
 * read-only view. A check that only reads one store therefore still missed
 * same-task progress recorded by a differently-sourced sibling call. Both
 * `queryServedSurfaces` (the cumulative log) and `readOnlyServedEntries`
 * (WP-S11) are consulted for exactly this reason — together they are the
 * complete picture `epochServedEvidence` itself already assembles for an
 * answer-profile reader.
 *
 * SCOPED TO A DECLARED-ANSWER RECORD ONLY (`prev.taskProfile === "answer"`),
 * deliberately narrower than "any record with a newer signal": the reviewed
 * constraint on `answerRecordPredatesProvenAbsence` just above already found
 * that declining a NON-answer record on "any newer signal" reopens a concern
 * its own concern-token ledger had correctly closed (sequenceCorpus.spec.ts
 * I1/I3) — that finding was about a newer SEARCH RESULT, not a served
 * surface, but absent a control case proving the served-surface signal is
 * equally safe for that ledger, staying inside the already-reviewed
 * declared-answer boundary is the honest, minimal fix; a change/generic
 * record's cumulative-log trace is read by the EXISTING, narrower
 * `createPendingRecordIsStale` (its own "pending create" conjunct) and is
 * otherwise left exactly as before this fix. Never mints a new store and
 * never writes request-item state into the cumulative log — it only READS
 * the two stores `epochServedEvidence` already reads.
 *
 * Never fires for a record that already reached a certified terminal
 * decision (`recordCertifiedTerminal`): a complete `act.answer`/`act.edit`
 * has nothing left to discover, so restating it is correct and is exactly
 * the receipt economy this path exists for (TL142-01C's own conjunct, same
 * rule `createPendingRecordIsStale` applies).
 *
 * Self-limiting like its siblings: the rebuild this decline forces captures
 * every path this task now holds, so the very next identical repeat is
 * served from the (now current) receipt again — this cannot loop.
 */
export function recordPredatesAdditionalServedEvidence(workspace: string, prev: ServedPackRecord): boolean {
  if (prev.taskProfile !== "answer") return false;
  if (recordCertifiedTerminal(prev.executionContract)) return false;
  const capturedPaths = new Set(prev.surfaces.map((s) => s.path));
  if (queryServedSurfaces(workspace, workspace, { epochTokens: prev.epochTokens })
    .some((entry) => !capturedPaths.has(entry.path))) return true;
  const readOnlyEntries = readOnlyServedEntries(workspace, prev.epochTokens);
  if (readOnlyEntries.some((entry) => !capturedPaths.has(entry.path))) return true;
  // R-A2 item 1 (2026-09-21): a plain caller-ranged zoom
  // (`recordReadOnlyServedRangedServe`, server.ts) of a path THIS record
  // already knew about is still evidence the record never captured when it
  // reaches lines the record's own surfaces for that path never served — the
  // path-only checks above cannot see it (a zoom never introduces a NEW path,
  // only new lines of a known one). Compares the ledger's CURRENT spans for
  // that path (which the zoom's own `recordServedRange` call already
  // advanced, same session) against the union this record's own surfaces
  // declared at capture time (`servedLineSpansOf`, the same partial-aware
  // union `isWholeAuthoritySurface`'s callers already trust).
  //
  // P1-6 (round-4 evaluation, 2026-09-28), fix 1 of 2: `prev.surfaces` USED TO
  // lack `remaining_ranges` (never stored on `ServedPackRecord`), so a
  // capture-time PARTIAL surface's nominal `range` read as fully covered here
  // — the opposite of the safe direction this comment used to claim. Live
  // repro (classFlowOver64Long): a seed record's own surface disclosed
  // `range:"1-564"` with only lines 1-494 actually shipped
  // (`remaining_ranges:["495-564","565-620"]`); a later call served lines
  // 495-514 for real (on the ledger this loop reads), but `servedLineSpansOf`
  // — seeing no `remaining_ranges` on the STORED surface — treated the WHOLE
  // [1,564] as prior-served, so `lineSpansCover` answered "yes" for the
  // genuinely-new 495-514 span and this function returned `false`. Fixed by
  // threading `remaining_ranges` through `ServedPackRecord.surfaces` (see its
  // own doc comment, and `captureServedPack`/`tryServeSubsetReceipt`'s record
  // builders), so `servedLineSpansOf` sees the record's TRUE prior-served
  // extent here, same as it always has for a freshly-built (never-stored)
  // `TaskPackSurface[]`.
  //
  // P1-6, fix 2 of 2: this loop used to iterate `readOnlyEntries` ONLY,
  // checking the ledger for a path only when THAT path also happened to
  // appear in the WP-S11 read-only store — but the "MUST CHECK BOTH STORES"
  // reasoning above applies just as much to a RANGE-extension of a known
  // path as it does to a wholly NEW path: live repro (replayFlipGrFollow) had
  // the seed's own surface at `src/größe.ts:"1-4"` (`remaining_ranges:
  // ["5-61"]`), and the task's own certified `act.answer` follow-up (an
  // "inferred"-bound continuation) served lines 5-17 of the SAME path — but
  // that continuation's surface landed in the CUMULATIVE log
  // (`queryServedSurfaces`), which carries no per-entry range to compare and
  // whose path-only check above cannot see it (größe.ts is already in
  // `capturedPaths`), while `readOnlyEntries` came back EMPTY for this task —
  // so the ledger check never ran at all. The ledger itself
  // (`getSession(workspace).servedRangeLedger`) is a single, store-agnostic,
  // byte-level record of every range this session has actually shipped for a
  // path, regardless of which attribution store recorded the surface that
  // shipped it — iterating `capturedPaths` directly (every path THIS record
  // claims to know about) checks it uniformly for both stores' shape, instead
  // of only the one `readOnlyEntries` happened to enumerate.
  for (const path of capturedPaths) {
    const priorSpans = servedLineSpansOf(prev.surfaces.filter((s) => s.path === path));
    const ledgerRanges = getSession(workspace).servedRangeLedger.get(path)?.ranges ?? [];
    if (ledgerRanges.some(([start, end]) => !lineSpansCover(priorSpans, { start, end }))) return true;
  }
  return false;
}

/**
 * FIX-FC (eval-0927 review finding 16, 2026-09-27) — THE GENERIC/EDIT-PROFILE
 * COUNTERPART OF `recordPredatesAdditionalServedEvidence`, ABOVE.
 *
 * Live repro (`changeEn`-shaped query, no declared profile): call 1 (pathless
 * query) locates ambiguously and captures a `confirm_candidates`/discovery
 * record (`SEED`, fingerprinted over EMPTY `paths`). Call 2 (a bare `{qref}`
 * replay) finds `isCandidateListPackPending` armed, AUTO-BINDS the pending
 * candidate as `args.paths` (readCodeTaskPack.ts's own B1c seam, a few
 * thousand lines above), which changes `computePackFingerprint`'s hash (it
 * hashes `paths`) and reaches a genuinely fresh, correctly certified
 * `act.edit` — captured as ITS OWN record under a DIFFERENT fingerprint, and
 * the successful bind CLEARS the pending-candidate memory (the ambiguity is
 * resolved, by the same B1c seam's own "else" arm). Call 3 — the SAME bare
 * `{qref}` replay AGAIN — now finds no pending candidate to bind (call 2
 * consumed it), so it resolves right back to the ORIGINAL, pathless args,
 * hashes to SEED's fingerprint again, and `tryServeCachedPack` restates
 * SEED's stale, pre-resolution `confirm_candidates` verdict verbatim — as if
 * call 2's certification had never happened. `act.edit` -> `discover`.
 *
 * `recordPredatesAdditionalServedEvidence` cannot be widened to catch this:
 * its `prev.taskProfile !== "answer"` early return is a REVIEWED constraint
 * (its own doc comment names the regression widening it once caused,
 * sequenceCorpus.spec.ts I1/I3) and this is a generic/edit task. This is a
 * NARROWER, DIFFERENT, ADDITIVE question — not "does more CONCERN evidence
 * exist", but "did THIS SAME TASK, since `prev` was captured, reach a
 * CERTIFIED TERMINAL decision (`recordCertifiedTerminal`: `act.answer` OR
 * `act.edit`) that `prev` itself never reached" — the exact question
 * `tryServeSupersedingCertifiedRecord` already asks for the answer-profile
 * case (its own `candidate.taskProfile !== "answer"` filter excludes every
 * other profile from BOTH ends of that check; see the companion fix at that
 * function's own call site).
 *
 * Scoped to `prev.taskProfile !== "answer"` explicitly at both call sites
 * (never invoked for an answer-profile `prev`), so the already-reviewed
 * answer-profile path is untouched byte-for-byte by this addition.
 */
export function recordSupersededByLaterCertifiedTerminal(
  workspace: string,
  prev: ServedPackRecord,
  lane: string,
): boolean {
  if (recordCertifiedTerminal(prev.executionContract)) return false;
  const records = servedPacksByWorkspace.get(laneScopedKey(workspace));
  if (records === undefined) return false;
  // `prev` may be a `receiptRecordWithoutConsumedSearch` COPY, not the exact
  // object stored in `records` — re-locate it by the same signature
  // `tryServeCachedPack`/`tryServeSupersedingCertifiedRecord` already match
  // on, mirroring the latter's own `seedPos` search.
  const prevPos = records.findIndex(
    (r) => r.fingerprint === prev.fingerprint
      && r.extraArgsKey === prev.extraArgsKey
      && r.requestProfileKey === prev.requestProfileKey
      && r.lane === prev.lane,
  );
  if (prevPos < 0) return false;
  for (let i = records.length - 1; i > prevPos; i--) {
    const candidate = records[i]!;
    if (candidate.lane !== lane) continue;
    if (!epochsOverlap(candidate.epochTokens, prev.epochTokens)) continue;
    if (recordCertifiedTerminal(candidate.executionContract)) return true;
  }
  return false;
}

export function compactReceiptFromRecord(
  workspace: string,
  prev: ServedPackRecord,
  currentWorkspaceState: TaskWorkspaceState,
  consumption: ReceiptConsumptionScope = { lane: currentSessionLane() },
): TaskPackResult {
  const computed = computeClosureStateSafe(workspace);
  const storedIds = new Set(prev.checkIds);
  const openDescs = (computed?.open ?? [])
    .filter((c) => storedIds.has(c.id))
    .slice(0, 3)
    .map((c) => (c.desc.length > 140 ? c.desc.slice(0, 140) : c.desc));
  const compactExecutionContract: TaskExecutionContract | undefined = prev.executionContract
    ? {
        version: prev.executionContract.version,
        state: prev.executionContract.state,
        readiness: prev.executionContract.readiness,
        discovery_complete: prev.executionContract.discovery_complete,
        next_action: prev.executionContract.next_action,
        max_additional_discovery_calls: prev.executionContract.max_additional_discovery_calls,
        // SHOULD-FIX 36 (2026-09-14, review round 5): without this, EVERY
        // compact receipt's `capability_gaps` was silently `undefined` —
        // `decisionWire.ts::projectGaps`/`projectUnresolved` (steps 2+) both
        // read `contract.capability_gaps` directly, so a `discover`-shaped
        // re-pack lost `decision.gaps` ENTIRELY (not just the
        // unreadable-named-path disclosure this finding names — the SAME
        // pack's unrelated "surface-content"/identifier gaps vanished too,
        // exactly as review-findings-5.md's own root-cause note observed).
        // Safe to restate verbatim: `compactReceiptFromRecord` only ever runs
        // once `revalidateRecordToReceipt`'s own staleness gates (unchanged
        // file SHAs, unchanged inventory-complete workspace fingerprint) have
        // already proven nothing this contract was built over has moved.
        capability_gaps: prev.executionContract.capability_gaps,
        // Clause-boundary cap (same discipline as applyEnvelopeWeightTrim):
        // the hard slice shipped fragments like "… are served — act on the",
        // an instruction cut mid-directive.
        reason: capReasonAtClause(prev.executionContract.reason, 120),
        typestate: prev.executionContract.typestate,
        // protocol v1 §2.1.1 (C2-3): THE CERTIFICATE BINDING TRAVELS WITH THE
        // RE-SERVE, in its retention-trimmed form (ids, obligation statuses and
        // the action frontier — no evidence bodies, no falsification detail).
        //
        // `hasCertificateBinding` documents two legal forms, the full proof and
        // a bare `typestate.certificate_id`, and states that "both forms project
        // the SAME lean `certificate` field on the wire". That stopped being
        // true when the wire became A.3's `decision`: §2.1.1 lets an `act` ship
        // only over a `CertificateRef` (id + NON-EMPTY obligations + workspace
        // marker) and, for `act.edit`, a non-empty `FrontierEntry[]`. The
        // id-only form carries neither, so `projectTaskDecision` degraded a
        // prepared, edit-ready re-serve to `await_input:
        // "no-grounded-call-remains"` — telling an agent that already holds the
        // complete pack to go ask the user. The receipt ALSO stopped
        // classifying as A.4 `pack-unchanged`, whose honesty gate rejects a
        // body whose decision moved to `discover`/`await_input`; the decision
        // had not moved, the proof of it had merely been trimmed away.
        //
        // This costs no wire bytes. Both members that can carry this body —
        // `read.receipt` (A.5.6) and `read.task_pack` (A.5.1) — drop
        // `execution_contract` outright in `protocol/readFamily.ts`, so the
        // "paying the full certificate's bytes again on a sub-1KB receipt"
        // concern that shaped this projection is now satisfied downstream.
        //
        // P2 CORRECTION: it costs no WIRE bytes, but it cost 782 of the
        // record's own — `contractForEvidenceRetention` is the general
        // retention trim, and it still carries the falsification report, the
        // risk model and a per-obligation `evidence: []` + `reason:"proved"`
        // pair that restates `status`. None of that is read on this path, and
        // it pushed the compact revalidation receipt from ~1.9KB to 2259B
        // against its documented <2KB budget. `certificateBindingFor` emits the
        // BINDING the fence and the wire decision actually consume; the proof
        // stays on the pack that computed it.
        ...(prev.executionContract.readiness_certificate
          ? {
              readiness_certificate:
                certificateBindingFor(prev.executionContract.readiness_certificate),
            }
          : {}),
        ...(prev.executionContract.next_call ? { next_call: prev.executionContract.next_call } : {}),
      }
    : undefined;
  const shaByPath = new Map(prev.fileShas.map(({ path: p, sha }) => [p, sha]));
  // D3 receipt staleness (2026-08-01): the captured contract predates the
  // execution of its own next_call — re-validate against the session's
  // executed-locate ledger so a receipt can never re-point at a call that
  // already ran (observed live: a qref re-pack replaying the locate it had
  // just triggered, once the decoy-gate made the subset receipt eligible).
  //
  // P1-b (2026-08-28 review-fix wave): DELIBERATELY kept locate-only here
  // (the historical scope), not generalized to find/references/tree. Reason,
  // discovered empirically while extending it: `read.task_pack`'s wire
  // projector (readFamily.ts's `KEPT_ON_TASK_PACK`/`projectTaskPack`) never
  // ships a top-level `missing[]` field, and the frozen `await_input`
  // decision member carries no `gaps` key either (I5's own comment) — so a
  // NEW disclosure this compact path might synthesize for a find/references/
  // tree suppression has no wire channel to travel through without a
  // protocol-frozen field addition, out of this wave's scope. The fresh-build
  // path (`suppressNonProgressingNextCall` -> `repairSuppressedNextCall`)
  // does not have this gap — it runs before the response is wire-projected
  // and its own `missing[]` write is a genuine, already-tested mechanism —
  // so the generalization is scoped to that path only. See the design-delta
  // note in the A-REPORT for the fuller trace.
  const receiptAdvance = compactExecutionContract !== undefined
    ? advanceExecutedLocateNextCall(workspace, compactExecutionContract, LOCATE_ONLY_NO_REPEAT_ACTIONS)
    : "kept";
  // -------------------------------------------------------------------------
  // P1-1 (2026-09-08, v0.14.1 hands-on report): A CONSUMED CONTINUATION IS
  // NEVER RE-PRESENTED — THE GENERIC RULE, NOT A FOURTH ACTION ALLOWLIST.
  //
  // THE OBSERVED LOOP (third occurrence of this bug class; see
  // RECEIPT_UNREPAIRABLE_STALE_ACTIONS above for the second). A `discover`
  // pack prescribed a plain `tl_read_file` of one still-codeless surface; the
  // caller ran it verbatim; the qref re-pack exact-fingerprint-matched the
  // stored record and handed back the byte-identical next, forever. Both
  // existing brakes miss it by construction: `advanceExecutedLocateNextCall`
  // covers `tl_search_files` actions only (and, at this call site, only
  // `locate`), and `receiptContractWithoutConsumedSearch` returns early for
  // any `nextCall.tool !== "tl_search_files"`.
  //
  // The repair is the ledger question itself — `hasExecutedNext` fingerprints
  // the WHOLE call (tool + semantic args) and is tool-agnostic, so it closes
  // the gap for `tl_read_file` and for any future non-search continuation in one
  // check instead of a fourth `*_NO_REPEAT_ACTIONS` entry. Its normalization
  // already drops the volatile envelope the wire adds to a prescribed call
  // (`cwd`, `lane`, `task.handle` — `semanticNextArguments`/`semanticTask`),
  // so the record's internal `{handle}` shape and the caller's executed
  // `{targets:[{handle}], content:"auto", task:{handle}, cwd, lane}` land on
  // the same fingerprint.
  //
  // ONE LEDGER IS NOT ENOUGH, which is why `receiptContinuationDisposition`
  // asks two witnesses. `hasExecutedNext` partitions on the CANONICAL task
  // binding the dispatcher resolved for the executed call, and a handleless
  // `tl_read_file {qref}` re-pack cannot always recover that binding (a first
  // pack opened with `task.epoch:"new"` registers its contract before a handle
  // exists, so `uniqueTaskScopeForExactQuery` has nothing to match). The
  // second witness is this response's own proof: a read whose every addressed
  // window `surfaceRangeShipped` already covers fetches nothing new — the same
  // predicate that decides whether a surface may claim `prior` here.
  //
  // PROGRESS FIRST, STEP ASIDE SECOND — the A-F2 rule applied here. A consumed
  // continuation is re-pointed at the first required window the served-range
  // ledger canNOT prove shipped (an honest, bounded, never-executed call).
  // When no such window remains, the receipt does NOT drop the call and park:
  // `revalidateRecordToReceipt` declines outright, so the full build re-derives
  // readiness and discloses its own gaps. Dropping in place was tried and is
  // wrong — it produces a next-less terminus carrying only whatever `missing[]`
  // the record happened to capture, which sequenceCorpus's I5 forbids.
  // -------------------------------------------------------------------------
  const receiptShipped = new Map<string, boolean>();
  const shippedKey = (path: string, range: string): string => `${path}\u0000${range}`;
  for (const surface of prev.surfaces) {
    const key = shippedKey(surface.path, surface.range);
    if (!receiptShipped.has(key)) receiptShipped.set(key, surfaceRangeShipped(workspace, surface.path, surface.range));
  }
  const receiptDisposition = receiptContinuationDisposition(
    workspace,
    prev,
    consumption,
    compactExecutionContract?.next_call ?? prev.next,
  );
  // P1-1: the ONLY in-receipt arm is PROGRESS. `"spent"` never reaches here —
  // `revalidateRecordToReceipt` declines the receipt for it (see
  // `receiptContinuationDisposition`), so a consumed continuation is either
  // re-pointed at a still-unserved window or the whole receipt steps aside.
  // Dropping the call in place is deliberately not an option: it would leave a
  // next-less terminus carrying only whatever `missing[]` the record captured.
  if (receiptDisposition.state === "advance" && receiptDisposition.progress !== undefined) {
    if (compactExecutionContract !== undefined) {
      compactExecutionContract.next_call = receiptDisposition.progress;
    }
  }
  // iter-2 W1/W2: the receipt's route re-affirms "working set complete — stop"
  // when the cached pack was complete/focused, so re-serves keep telling the
  // model to edit, not re-discover. A partial pack keeps its own route.
  const isAnswerReceipt = prev.taskProfile === "answer"
    || prev.route?.action === "answer_from_handles";
  const receiptRoute = applyCompleteStopRoute(prev.route, prev.coverage, isAnswerReceipt);
  const restatedCreateTarget = restatableCreateTarget(workspace, prev);
  // SHOULD-FIX 36 (2026-09-14, review round 5): the SAME re-derivation
  // `discloseUnreadableNamedPaths`'s own "restored" branch does over
  // `result.missing` on a FRESH pack (the layer that function's own doc
  // comment says re-populates `result.unreadable_named_paths` when this
  // call's per-request ALS is empty) — done HERE too, because
  // `compactReceiptFromRecord` never calls `discloseUnreadableNamedPaths` at
  // all (it is not part of `dedupeTrimAndPersist`'s pipeline). Without this,
  // `decisionWire.ts::projectUnresolved`'s own path-preserving "step 0b" never
  // fires on ANY of the three receipt doors, and the disclosure that DOES
  // survive (via the generic `missingRows`/`parseLedgerMissingRow` fallback
  // further down that same projector) drops `path` and restates a different,
  // prose-only reason string — the exact "not the same row" finding 36 names.
  // `prev.missing` (not `receipt.missing`, not yet assembled at this point)
  // is the identical source array — see the `missing: [...prev.missing]`
  // field below.
  const restoredUnreadableNamedPaths = prev.missing
    .map(parseUnreadableNamedPathRow)
    .filter((entry): entry is NonNullable<ReturnType<typeof parseUnreadableNamedPathRow>> => entry !== undefined);
  const receipt: TaskPackResult = {
    mode: "task_pack",
    coverage: prev.coverage,
    ...(prev.coverageReason ? { coverage_reason: prev.coverageReason } : {}),
    ...(prev.coverageBasis ? { coverage_basis: prev.coverageBasis } : {}),
    // A.4 (C2-3): the `receipt` TAG is v1's discriminator. `pack_unchanged`
    // survives as the in-process signal `attachSupply`, the canonical-decision
    // fence and this module's own compaction guards read; `readFamily.ts`
    // deletes it from the wire.
    receipt: "pack-unchanged",
    pack_unchanged: true,
    workspace_state: currentWorkspaceState,
    // P1: `prior` on the wire is a claim "the caller already holds these
    // bytes" — verifiable ONLY against the ledger the caller's earlier serves
    // actually booked (surfaceRangeShipped), never against this record's own
    // `content_completeness` self-report. A row the ledger cannot prove
    // shipped carries `content_completeness:"partial"` + `remaining_ranges`
    // instead (the model.ts convention pairing) so `projectEvidence`
    // (protocol/decisionWire.ts) withholds `prior` and emits `remaining` —
    // the same honest shape a fresh (non-receipt) partial pack would emit.
    surfaces: prev.surfaces.map((s) => {
      const sha = shaByPath.get(s.path);
      const shipped = receiptShipped.get(shippedKey(s.path, s.range)) === true;
      return {
        handle: s.handle,
        path: s.path,
        range: s.range,
        role: s.role,
        ...(sha !== undefined ? { sha } : {}),
        ...(shipped ? {} : {
          content_completeness: "partial" as const,
          // An answer-first map names what it left owed: the receipt does too, as the windows the ledger cannot prove
          // (the page's own `remaining`, less what a zoom read since), not the map's whole extent.
          remaining_ranges: prev.answerFirst === true ? surfaceRangeUnserved(workspace, s.path, s.range) ?? [s.range] : [s.range],
        }),
      };
    }),
    missing: [...prev.missing],
    ...(receiptRoute ? { route: receiptRoute } : {}),
    ...(prev.taskProfile ? { task_profile: prev.taskProfile } : {}),
    // Finding 14 (adversarial review, 2026-09-27): a receipt restates the
    // captured record's fields (coverage, route, task_profile, …) as "the
    // same answer as before" — `profile_binding` had no row here at all, so
    // EVERY receipt (the stored-record door via `revalidateRecordToReceipt`
    // and the ad-hoc subset-receipt door via `tryServeSubsetReceipt`, both of
    // which set `ServedPackRecord.profileBinding` from the pack that was
    // actually served) dropped the field outright — the exact wire gap the
    // guide's "omit if unknown and observe `profile_binding`" instruction
    // cannot survive. `readFamily.ts`'s `profileBindingIsExplicitEcho` would
    // otherwise misread `prev.profileBinding` verbatim as a FRESH explicit
    // declaration this call just made (SEND-ONCE/NO-ECHO) and strip it again
    // — so it is run through `noteInheritedTaskProfile` exactly as a fresh
    // build's inherited binding would be: a receipt is, by construction,
    // never this call's own declaration, so the marker always applies here
    // (a receipt that also happens to redeclare the identical profile is at
    // worst a harmless restatement, never a false one — every other field
    // in `binding` stays the accurate requested/selected/source/confidence
    // this task was actually packed under).
    ...(prev.profileBinding
      ? { profile_binding: noteInheritedTaskProfile(prev.profileBinding, { taskProfileInherited: true }) }
      : {}),
    ...(compactExecutionContract ? { execution_contract: compactExecutionContract } : {}),
    ...(receiptAdvance === "suppressed" ? { retry_same_call: false } : {}),
    ...(prev.contentSufficiency ? { content_sufficiency: prev.contentSufficiency } : {}),
    ...(openDescs.length > 0 ? { checks_open: openDescs } : {}),
    // P1-1: the record's own top-level `next` is the SAME consumed continuation
    // whenever the stored contract had none of its own, so it rides the same
    // rule — a spent call is not re-published through the other door either.
    ...(prev.next
      && prev.executionContract?.next_call === undefined
      && receiptDisposition.state === "fresh"
      ? { next: prev.next }
      : {}),
    // TL142-01C: restate the create route this record certified. Without it
    // `applyCanonicalTaskDecision` below has no `create_target` to read and
    // every same-epoch repeat of an act.edit+create pack degraded to
    // discover/await_input over an unchanged workspace. Gated on the target
    // still being absent — see `restatableCreateTarget`.
    ...(restatedCreateTarget !== undefined ? { create_target: restatedCreateTarget } : {}),
    // TL142-01B: restate the verified-absent disclosure, so a re-served
    // certificate keeps the `gaps` it was minted with. Safe on this path by
    // construction: every gate above has already proven the whole
    // inventory-complete workspace byte-identical to the one the absence was
    // proved against.
    ...(prev.requestItemAbsences !== undefined && prev.requestItemAbsences.length > 0
      ? { request_item_absences: prev.requestItemAbsences.map((absence) => ({ ...absence })) }
      : {}),
    // SHOULD-FIX 36: restate the first-class field the two wire projectors
    // (`buildCapabilityGaps`-driven `decision.gaps`, and `projectUnresolved`'s
    // own path-preserving "step 0b") both key their disclosure off — see
    // `restoredUnreadableNamedPaths`'s own doc comment above for why this
    // cannot instead happen inside `discloseUnreadableNamedPaths`.
    ...(restoredUnreadableNamedPaths.length > 0
      ? { unreadable_named_paths: restoredUnreadableNamedPaths }
      : {}),
  };
  // P0a §6.1: a receipt is an alternate WIRE shape, not alternate decision
  // semantics. The compact projection can contradict itself in exactly one
  // reachable way — `advanceExecutedLocateNextCall` suppressing the captured
  // next_call leaves a discovery-phase contract with nothing executable while
  // the carried-forward route still claims a terminal action. Fail closed onto
  // the canonical decision (insufficient evidence with no bounded call =>
  // ask, never "answer anyway"). A coherent receipt passes through untouched,
  // so the pinned prepared/discovery receipt bytes are unchanged.
  applyCanonicalTaskDecision(receipt);
  // Bind address metadata only after all receipt freshness/prior checks. The
  // compact proof intentionally omits obligation evidence; the runtime fence
  // must still resolve its EXISTING write handles to the same address. A
  // bodyless/auxiliary row or a changed/unknown capability cannot supply it.
  const receiptAddresses: ReceiptExecutionAddress[] = [];
  const identities = new Map<string, ReturnType<typeof surfaceFileIdentity>>();
  const writeHandles = new Set(receipt.execution_contract?.readiness_certificate?.action_frontier ?? []);
  for (const surface of prev.surfaces) {
    if (!writeHandles.has(surface.handle) || surface.handleIdentity === undefined
      || receiptShipped.get(shippedKey(surface.path, surface.range)) !== true) continue;
    if (!identities.has(surface.path)) identities.set(surface.path, surfaceFileIdentity(workspace, surface.path));
    const identity = identities.get(surface.path);
    if (identity === undefined || identity.sha !== shaByPath.get(surface.path)) continue;
    receiptAddresses.push({
      handle: surface.handle, path: surface.path, range: surface.range,
      fileSha: identity.sha, totalLines: identity.totalLines,
      handleIdentity: surface.handleIdentity,
    });
  }
  bindReceiptExecutionAddresses(workspace, receipt.execution_contract, receiptAddresses);
  return receipt;
}

/**
 * If this call is an exact re-issue of a recently served pack for `workspace`
 * (matching fingerprint AND extra-args AND every captured surface file still
 * hashing identically), return a COMPACT idempotent response; otherwise
 * undefined (caller does the full recompute). Target: well under 1KB.
 *
 * iter-2 W1: searches the bounded multi-slot window (most-recent first), not
 * just the single latest slot, so a verbatim re-call that was NOT the
 * immediately-preceding call (an intervening pack sat between them) still hits.
 */
/**
 * P2-12 (2026-09-28, review round 4/5, qrefAfterCertified) — WHAT PROFILE DID
 * THE CALL THAT OPENED THIS TASK DECLARE, if this exact call omitted one?
 *
 * `force_serve:true` skips `tryServeCachedPack` outright (the doc comment at
 * its call site: "every proof this dedup rests on... is proof about a
 * context that no longer exists" — correct for BODY bytes), so a force-served
 * rebuild used to bind its `profile_binding` from `args.taskProfile` alone —
 * `undefined` on a bare `{qref, task:{force_serve:true}}}` continuation — and
 * report `requested:"auto", source:"inferred"` even for a task this session
 * explicitly opened with `task.profile:"answer"`. `server.ts`'s
 * `inheritDeclaredTaskProfile` cannot repair this the way it repairs an
 * ordinary continuation: the only signal it has (the task's identity
 * fingerprint equals what an explicit "answer" declaration would hash to) is
 * genuinely ambiguous with "never declared anything, and auto-inference
 * happened to land on answer too" — confirmed live (this function's own
 * regression spec): injecting unconditionally under force_serve made an
 * UNDECLARED task also report `source:"explicit"`, fabricating a declaration.
 *
 * The one place that ambiguity is NOT present is the stored pack record
 * itself: `requestProfileKey` (`computeRequestProfileKey`, above) remembers,
 * per capture, whether the ORIGINAL call that produced it declared a profile
 * or left it `"auto"` — a fact about a past call, not a cache-hit, so reading
 * it stays honest under force_serve (this function returns a PROFILE STRING
 * only, never a served pack, never evidence, never a receipt). Matched on
 * the SAME `fingerprint`/`extraArgsKey`/`lane` triple `tryServeCachedPack`
 * uses, minus the profile-compatibility gate — that gate is what we are
 * trying to establish, not a precondition for asking. `undefined` (no
 * matching record, or the matching record was itself `"auto"`) leaves the
 * caller exactly as before: plain auto-inference, same as an ordinary
 * undeclared task.
 */
export function declaredProfileFromRecordUnderForceServe(
  workspace: string,
  args: TaskPackArgs,
  fingerprint: string,
): string | undefined {
  if (args.taskProfile !== undefined) return undefined;
  const records = servedPacksByWorkspace.get(laneScopedKey(workspace));
  if (records === undefined || records.length === 0) return undefined;
  const extraArgsKey = computeExtraArgsKey(args);
  const lane = currentSessionLane();
  const prev = [...records].reverse().find(
    (r) => r.fingerprint === fingerprint && r.extraArgsKey === extraArgsKey && r.lane === lane,
  );
  return prev === undefined || prev.requestProfileKey === "auto" ? undefined : prev.requestProfileKey;
}
