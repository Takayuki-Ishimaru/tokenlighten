// ---------------------------------------------------------------------------
// protocol v1 — THE EMISSION PIPELINE (P3a S1).
//
// NORMATIVE SOURCE: TL-PROTOCOL-V1-PHASE3A-PLAN-DRAFT.md §3 (module layout),
// §4.1 (the measurement point), §4.3 (the measure-driven ladder), §0.3 (the
// calibration invariant); DESIGN-v0.10-protocol-v1-contract-freeze.md §4.2.1,
// §4.3, §4.4, A.6.2, A.8.
//
// -------------------------------- WHERE THIS SITS ---------------------------
//
// `envelope.ts`'s `finalizeProtocolResponse` is the one funnel every response
// from the three advertised tools leaves through. That function decides the
// response's `Kind` and PROJECTS the emitter's body into its A.5.x member. This
// module is its TAIL: everything from "the payload is final" to "these are the
// bytes on the wire".
//
// WHY THE TAIL, AND NOT `toolOk`. Plan §3.2 proposed narrowing
// `toolOk(data: unknown)` to `toolOk(result: ProtocolResult)` so that the
// pipeline became non-bypassable by construction. That is REFUTED at this HEAD:
// `server.ts`'s ~251 call sites pass PRE-projection ad-hoc bodies
// (`Record<string, unknown>` and object literals), and typing happens later, at
// the funnel. The funnel exists precisely so the call sites need no port — see
// `envelope.ts`'s "WHY A FUNNEL AND NOT 287 CALL SITES". So the measurement
// point goes where the bytes actually are: here. `toolOk` /
// `toolStructuredError` / `toolError` remain PRE-FUNNEL CONTENT CARRIERS and
// keep their signatures; `protocol/result.ts` says so at each of them.
//
// R1's residual closes here too. `supplyRefusalGuidance` (the "grower" that can
// ADD bytes to a refusal, `result.ts` -> `util/attachSupply.ts`) runs strictly
// earlier, inside `toolStructuredError`, so its output is measured naturally by
// this tail. And the funnel's three EARLY RETURNS — non-string content,
// non-object JSON, unparseable JSON — route through `emitOpaqueText` rather
// than around the pipeline, so no response leaves the funnel unmeasured.
//
// ------------------------- WHAT S1 SHIPS, AND WHAT IT DOES NOT --------------
//
// SHIPS: the measurement point (`budget/measure.ts`), the budget table
// (`budget/wireBudget.ts`), the required-set validator (`budget/validate.ts`,
// S2), the ladder runner (`budget/ladder.ts`, S3), the thirteen per-kind
// shedders (`budget/shedders/`, S3), the `ShedRecord[]` -> `Limit{cause:"wire"}`
// derivation (`budget/wireLimit.ts`, S3), and §4.3's fail-closed tail.
//   S5  the §2.1.1 act-floor check and demote-to-`discover` (landed in
//       `budget/ladder.ts`, with the demoted call canonicalized before emit)
//
// DOES NOT SHIP (by stage assignment, not oversight):
//   S6  the G8 grep fence over the measurement point, and the sweep
//
// §0.3 MAKES THE WHOLE PIPELINE A REFACTOR AT DEFAULT BUDGETS: byte-invisible
// on the wire. The budget table is calibrated so that no legitimate response is
// over budget, so the ladder runs zero steps, `mergeWireLimit` returns "do not
// touch", and the serialized string this module measures is the SAME string it
// returns. All fifteen §6.1(b) pins, the replay corpus and the conformance
// snapshot must therefore be byte-identical after every stage. Any wire delta
// at default budgets is a bug in this pipeline, not a new feature of it.
// ---------------------------------------------------------------------------

import type { Kind, ToolCall, ToolName } from "@tokenlighten/types";
import { createHash } from "node:crypto";

import { runLadder } from "./budget/ladder.js";
import { measureResponseBytes } from "./budget/measure.js";
import { budgetFor, estimateBytesFromTokens, floorBytes, type WireBudget } from "./budget/wireBudget.js";
import { shedderFor } from "./budget/shedders/index.js";
import type { ShedPayload } from "./budget/shedders/registry.js";
import { describeVerdict, validateProtocolBody, type ProtocolViolation } from "./budget/validate.js";
import { isKnownProtocolKind } from "./budget/requiredSets.js";
import {
  canonicalizeEmittedToolCalls,
  isErrorForKind,
  servedWindowsOf,
  type FinalizableResult,
  type ProtocolCallContext,
} from "./envelope.js";
import { buildRefusal } from "./refusal.js";
import { recordFullServeCompleteness, settleServedCallBookings } from "../state/session.js";
import {
  applyReadRequestContinuation,
  demoteActAfterShed,
  fitStagedReadToBudget,
  shrinkLargestBatchEntryByOneLine,
  shrinkLargestEvidenceByOneLine,
  stagedReadFloorBytes,
} from "./readRequestContinuation.js";
import {
  applySearchRequestContinuation,
  rewindSearchRequestDelivered,
  shrinkSearchPageToFit,
} from "./searchRequestContinuation.js";
import { recordServedBytes } from "../util/packServeLog.js";
import { decisionInvariantStrictEnabled } from "../util/flags.js";
import { applyResponseCodec } from "./codec/pipeline.js";
import { ledgerCertificateBindingValid } from "./ledgerCertificateBinding.js";
import { trace, isTraceEnabled } from "../util/trace.js";

/**
 * The funnel tail: take a FINAL, already-projected payload to bytes.
 *
 * Order of operations, and why each step is where it is:
 *
 *  1. LADDER (`budget/ladder.ts`), which serializes and measures at the one
 *     sanctioned measurement point, one rung at a time, stopping at the first
 *     cut that fits — and returns the exact string it measured, so nothing is
 *     re-stringified downstream. This shape is the C-wave incident
 *     (`d7150ec3`, 2026-08-09) made mechanical: that ladder ran to its last
 *     rung, removed 3,158 B to close a 1,465 B overage, deleted the authority
 *     doc's surface entirely, and still left 1.7 KB of budget unused.
 *  2. FAIL CLOSED (see `failClosed`) if the ladder could not get under budget.
 *     Three outcomes, one per class of member, and no fourth.
 *  3. SETTLE THE SERVED-RANGE LEDGER against the POST-shed payload. [R5-10]
 *     put the ledger at the funnel because it grounds a claim about what
 *     reached the CONSUMER; a rung that drops an `Evidence.body` retracts that
 *     claim, so settling before the ladder would book bytes the caller never
 *     got. Byte-identical to the pre-P3a order whenever nothing sheds — which,
 *     at the calibrated budgets, is always.
 *  4. RECORD the emission on the call context (see `noteEmission`) and publish
 *     the shed history, then JUDGE the payload that actually ships against its
 *     §4.3 required set (see `enforceRequiredSet`). Recording first is
 *     deliberate: a strict-mode violation throws, and the byte record should
 *     already be on the context when it does.
 *  5. ASSEMBLE. `isError` is stamped iff A.8 rule E-3's three kinds — read off
 *     the kind that actually SHIPS, which a fail-closed conversion changes.
 *
 * KEY ORDER IS NOT INVENTED HERE. The caller hands over `{v, kind, …projection}`
 * already assembled, and every rung rebuilds objects in iteration order, so a
 * response that sheds nothing is serialized exactly as it arrived — by
 * identity, not by reconstruction. Reordering, re-spreading or normalising the
 * payload at this layer would be a byte change against the §6.1(b) pins even
 * when it changes no information.
 */
/**
 * Bytes reserved for the R2 read-request cursor a staged read's tail installs.
 *
 * MEASURED, not guessed: the cursor call is
 * `{"tool":"tl_read_file","arguments":{"cwd":<path>,"cursor":<200 chars>}}` and it
 * REPLACES a `{"targets":[{"handle":"h…","range":"a-b"}],"content":"auto"}`
 * next of about 70 B, so the swap costs ~200-240 B net (the `remaining` array
 * collapsing from one entry per shed pass to a single window gives some back).
 * 256 covers it with headroom, and headroom is the right side to err on: an
 * under-reserve ships an over-budget response, an over-reserve ships one line
 * fewer.
 */
export const READ_CURSOR_NEXT_RESERVE_BYTES = 256;

/**
 * How far over its INHERITED budget a resumed page may be and still be trimmed
 * to fit it (see the pre-settle fit in `emitFinalizedPayload`): the measured
 * per-row estimation error of a multi-window page tops out near 11%; anything
 * past 25% is structural overhead the fit must not "correct" line by line.
 */
const RESUME_TRIM_SLACK = 1.25;

/**
 * The byte budget a staged request carries: its `bytes`, its `tokens` converted
 * through the funnel's own ratio (`estimateBytesFromTokens`), the tighter of the
 * two when both are set — the same rule `declaredMaxBytesRaw` applies to a
 * budget declared on the call itself. `undefined` when the request declared none.
 */
function requestBudgetBytes(budget: { bytes?: number; tokens?: number } | undefined): number | undefined {
  if (budget === undefined) return undefined;
  const bytes = typeof budget.bytes === "number" && Number.isFinite(budget.bytes) && budget.bytes > 0
    ? Math.floor(budget.bytes)
    : undefined;
  const tokenBytes = estimateBytesFromTokens(budget.tokens);
  return bytes !== undefined && tokenBytes !== undefined ? Math.min(bytes, tokenBytes) : (bytes ?? tokenBytes);
}

export function emitFinalizedPayload(
  payload: ShedPayload,
  kind: Kind,
  context: ProtocolCallContext,
  opts?: { budgetOverrideBytes?: number },
): FinalizableResult {
  if (!isKnownProtocolKind(kind)) {
    discardStagedServeBookings(context);
    return emitUnknownKindRefusal(kind, context);
  }

  // THE BUDGET ROW, OR A TEST-ONLY OVERRIDE. Production callers pass no `opts`
  // at all; the override exists so a spec can drive the ladder past the point
  // §0.3's calibration makes unreachable (every row is >= 4x the largest cap
  // that can feed it) without editing the table the wire depends on. It is
  // read here and nowhere else, and it changes only WHEN the ladder engages —
  // never what a rung is allowed to cut.
  const declaredMaxBytesArg = typeof context.args?.["maxBytes"] === "number"
    && Number.isFinite(context.args["maxBytes"])
    && context.args["maxBytes"] > 0
    ? Math.floor(context.args["maxBytes"])
    : undefined;
  // FX-R3 (2026-09-03, round-18B finding 3): a caller-declared
  // `budget.tokens`/`maxTokens` used to be inert here — this module read only
  // `maxBytes`, so `budget.tokens` shed/refused nothing on every kind that
  // funnels through `emitFinalizedPayload` (i.e. every response of the three
  // advertised tools except the handles-batch aggregate ceiling, which had
  // its own separate, correctly-scaled conversion in
  // `tools/readCodeModes.ts`'s `resolveCallerByteCeiling`). Converted here
  // with the SAME ratio (`estimateBytesFromTokens`,
  // `protocol/budget/wireBudget.ts`) so a token budget binds the ladder
  // exactly as the equivalent byte budget would — `declaredMaxBytes` is
  // still just "the hard transport budget for this call", now derived from
  // whichever of the two the caller supplied (the tighter one, if both).
  //
  // FX-U3 (2026-09-04): FX-S #2's blanket `context.mode === "pack" ?
  // undefined : …` exclusion is REMOVED. It existed because
  // `tools/readCodePack.ts`'s producer measured a DIFFERENT quantity (raw
  // content chars) against the same nominal `maxTokens` this module converts
  // to bytes, so folding `maxTokens` in here too double-applied the budget
  // and fail-closed an already-honest partial `read.batch` to a bare
  // refusal. The producer now budgets the WIRE envelope itself
  // (`packItemWireBytes`/`PACK_FIXED_ENVELOPE_BYTES`, `readCodePack.ts`), the
  // same quantity this module measures, so the fold applies to `mode=pack`
  // exactly as it does to every other kind. `maxBytes` is unaffected either
  // way — `readCodePack.ts` never reads it.
  const declaredMaxTokensArg = estimateBytesFromTokens(context.args?.["maxTokens"]);
  const declaredMaxBytesRaw = declaredMaxBytesArg !== undefined && declaredMaxTokensArg !== undefined
    ? Math.min(declaredMaxBytesArg, declaredMaxTokensArg)
    : (declaredMaxBytesArg ?? declaredMaxTokensArg);
  // Test overrides remain explicit and cannot affect production.
  const calibratedLimit = budgetFor(kind, formOf(payload, kind));
  // `read.batch`'s own shed ladder (`shedders/readBatch.ts`) floors at ONE
  // entry: a payload that arrives with zero entries because THIS CALL never
  // had any to give (`mode=pack`'s honest "first item exceeds the entire
  // budget" shape, `readCodePack.spec.ts`) is not shed down to empty — it
  // ARRIVES empty — so the ladder never exercises the "declines below the
  // floor" rule and ships as-is. But a caller-declared budget too small even
  // for THAT already-minimal shape (e.g. `maxTokens:1`) would otherwise still
  // fail the tail's `used > limit` check below and get converted to a
  // refusal, discarding the very `omitted[]`/`limit.next` evidence the shape
  // exists to carry — the exact regression FX-S's blanket exclusion was
  // introduced to avoid, just reached through the fold above instead of
  // around it. Clamped ONLY for `mode=pack`, and only up to this kind's own
  // protocol floor (`floorBytes`, `protocol/budget/wireBudget.ts` — the
  // pinned minimum ANY legitimate response of this shape has ever measured):
  // a caller's declared ceiling can still bind pack to anything AT OR ABOVE
  // that floor exactly like every other kind, it just cannot be driven below
  // the one number under which this module would otherwise treat the
  // producer's own honest floor as a violation to fail closed.
  const declaredMaxBytes = context.mode === "pack" && declaredMaxBytesRaw !== undefined
    ? Math.max(declaredMaxBytesRaw, floorBytes(kind, formOf(payload, kind)))
    : declaredMaxBytesRaw;
  const limit = opts?.budgetOverrideBytes
    ?? (declaredMaxBytes !== undefined
      ? Math.min(declaredMaxBytes, calibratedLimit)
      : calibratedLimit);
  const ladderContext = { ...(context.args !== undefined ? { args: context.args } : {}) };
  const stableEditKind = kind === "edit.applied"
    || kind === "edit.rolled_back"
    || kind === "edit.state_unknown";
  // A live caller cap tighter than the calibrated row re-enters the same
  // producer pipeline with that transport cap. SE-STABLE outcomes intentionally
  // bypass this re-entry and retain their state-preserving emergency reserve.
  const initialBudget = opts?.budgetOverrideBytes !== undefined
    ? limit
    : calibratedLimit;
  // DESIGN-v0.15 §5 (R2): ROOM FOR THE CONTINUATION THE TAIL WILL INSTALL.
  //
  // When this call carries a read request, the tail below replaces whatever
  // `next` the producer or the ladder built with the request's own cursor call
  // — `{cursor:<~200 chars>, cwd}` — which is ~240 B wider than the
  // `{targets:[{handle,range}],content:"auto"}` it displaces. The ladder
  // measures the response BEFORE that swap, so without this reserve a response
  // shed to exactly `limit` ships at `limit + 240` (measured: a `maxBytes:1000`
  // full read landed at 1067 B, `fullModeBudget.spec.ts`).
  //
  // RESERVING IS THE ONLY HONEST ORDER. The alternative — re-running the ladder
  // after the rewrite — would shed bodies the served-range ledger has already
  // settled against, so the response would claim delivery of bytes it then cut.
  // Reserving first keeps one settle, one measurement and one truth.
  //
  // Never below the kind's own protocol floor, and zero when no request is
  // staged — which is every call that is not a line-addressed read, so the
  // §0.3 byte invariant is untouched on them by construction. On the staged
  // ones nothing sheds at the calibrated budgets either (every row is >= 4x the
  // largest cap that can feed it), so the reserve only ever bites where a
  // caller's own budget is already binding.
  const continuationReserve = context.readRequest === undefined ? 0 : READ_CURSOR_NEXT_RESERVE_BYTES;
  // NEVER ABOVE THE BUDGET IT IS RESERVING FROM. An earlier version clamped up
  // to `floorBytes(kind, form)` — "the pinned minimum any legitimate response of
  // this shape has ever measured" — which for `read.text` is well above 1 KiB,
  // so a `maxBytes:1000` call ended up handing the ladder a LARGER budget than
  // the caller declared and shedding less than before (measured: 1482 B against
  // a 1000 B cap, `fullModeBudget.spec.ts`). The floor is the ladder's own
  // business; asking it for less than the floor just means it does what it can
  // and the tail below fails closed, which is exactly the pre-existing
  // behaviour for a budget nothing can satisfy.
  const withReserve = (budget: number): number => continuationReserve === 0
    ? budget
    : Math.max(1, budget - continuationReserve);
  let ladder = runLadder({
    payload,
    kind,
    budget: withReserve(initialBudget),
    context: ladderContext,
    validate: (candidate) => validateShedCandidate(candidate, kind),
    canonicalize: (candidate) => canonicalizeBudgetDemotion(candidate),
  });
  if (!stableEditKind
    && opts?.budgetOverrideBytes === undefined
    && declaredMaxBytes !== undefined
    && declaredMaxBytes < calibratedLimit
    && ladder.used > limit) {
    const reentered = runLadder({
      payload: ladder.payload,
      kind,
      budget: withReserve(limit),
      context: ladderContext,
      validate: (candidate) => validateShedCandidate(candidate, kind),
      canonicalize: (candidate) => canonicalizeBudgetDemotion(candidate),
    });
    if (reentered.used < ladder.used) ladder = reentered;
  }

  let current = ladder.payload;
  let text = ladder.text;
  let used = ladder.used;
  let onWire = kind;
  // R2-R1: the exact floor of a staged read the ladder failed closed on (see below).
  let refusalFloorBytes: number | undefined;
  // ... and whether the refused response was a multi-target `read.batch` (its floor is the smallest
  // whole-ENTRY batch, so its recovery stays the cursor — see `applyReadRequestContinuation`).
  let refusalOfBatch = false;

  // STILL OVER BUDGET AFTER THE LADDER — §4.3's tail, three outcomes and no
  // fourth. Unreachable at the calibrated table; reachable through
  // `budgetOverrideBytes`, which is how the sweep exercises it.
  //
  // R-A4 (v0.14.4 candidate, 2026-09-21): `read.batch` prefers its OWN,
  // MORE ACTIONABLE reason over the generic `cap-exceeded` conversion below.
  // `wireLimit.ts`'s `ladder.ts` never trims a target its accumulator
  // already promised out of a continuation just to make room for a newer
  // one (confirmed regression source of the silent line-loss this fix
  // closes) — the union is unconditional and judged by the SAME progress
  // check every other candidate answers to, not by a per-step budget gate
  // (R-A5 retired that gate outright after it produced a WORSE regression —
  // a multi-entry drop sequence stalling after one accepted drop — see
  // `wireLimit.ts`'s own banner) — so a `read.batch` response can still
  // legitimately reach here still over budget: the ladder simply ran out of
  // rungs (or steps stopped making progress) while honest. `used` — the byte
  // size of whatever payload THIS SAME ladder run already validated and
  // accepted as its last honest state — is a byte count PROVEN achievable
  // AGAINST THIS CALL'S OWN ALREADY-CONSTRUCTED PAYLOAD. `cap-exceeded`'s own
  // generic `next` has no such guarantee (measured: it can re-name the SAME
  // over-budget call verbatim, an unproductive loop) — `budget-below-minimum`
  // (the EXISTING task-pack / read-cursor shape: `field`, `detail`,
  // `required_min_bytes`, `retry:"call"`) is the honest, actionable one.
  //
  // R-A5: `used` ALONE is not quite safe as `required_min_bytes` for a
  // RETRY, because a retry is a NEW call, and `server.ts`'s A7 construction
  // loop (`handlesBatchCeiling`, outside this fix's file list) reads that
  // new call's OWN declared budget before this ladder ever runs — a slightly
  // larger declared budget can legally admit a few more bytes of per-handle
  // content at construction than the FIRST call's construction did. MEASURED
  // (`readBatchNextUnionMatrix.spec.ts`'s floor-adjacent matrix, both host
  // configs): that delta is a few bytes, never a whole admitted/dropped
  // entry. `readBatchRequiredMinBytes` pads `used` by a small, fixed margin
  // comfortably above the observed range, so the very FIRST retry at
  // `required_min_bytes` lands on a call this server can serve without
  // shedding, rather than surfacing a second, smaller shortfall. The refusal
  // also carries an executable `next` — the SAME windows `ladder.continuation`
  // already names, with `budget.bytes` raised to that exact floor — so a
  // caller that only ever runs `next` verbatim (never reconstructing "same
  // call, higher budget" by hand) still recovers in one hop.
  if (used > limit) {
    // R2-R1: `used` is the ladder's own floor here (the smallest response it
    // could make); the conversion below overwrites it with the refusal's size.
    const ladderFloorBytes = used;
    const readBatchContinuation = ladder.continuation ?? existingNextOf(payload);
    const converted = kind === "read.batch"
      ? budgetBelowMinimumRefusal(context, readBatchRequiredMinBytes(used), readBatchContinuation, current)
      : failClosed(kind, context, limit, used, readBatchContinuation);
    if (converted !== undefined) {
      current = converted;
      onWire = "refusal";
      refusalOfBatch = kind === "read.batch";
      text = JSON.stringify(current);
      used = measureResponseBytes(text);
      // R2-R1 (FX1 chip 3): a `cap-exceeded` names no floor, so the request tail
      // could only give it a cursor that re-runs the very page that just did not
      // fit at the very budget that just refused it. A retry succeeds only when
      // BOTH gates pass: the ladder (which cannot make the response smaller than
      // `ladderFloorBytes` — a markdown page it cannot cut is 840 B whatever the
      // budget) and the funnel's own fit (the smallest response after the cursor
      // swap, measured from the ladder's last honest, still-over-budget state).
      // The refusal's `next` raises the budget to the larger of the two.
      //
      // ...and to a FIXED POINT of them. The retry is a NEW call: the ladder,
      // given more room, keeps members a tighter budget shed (a markdown page's
      // heading index, measured: 2273 B at the refusal, 2648 B at the retry), so
      // the floor is re-derived at the candidate budget — the ladder re-run over
      // the same producer payload exactly as the retry will run it — until that
      // budget holds what the ladder keeps there. Bounded; never lowers a floor.
      if (context.readRequest !== undefined && (kind === "read.text" || kind === "read.batch")) {
        const measureCandidate = (candidate: ShedPayload): number => measureResponseBytes(JSON.stringify(candidate));
        let floor = Math.max(
          ladderFloorBytes,
          stagedReadFloorBytes({
            payload: ladder.payload,
            staged: context.readRequest,
            claim: { budgetDeclared: declaredMaxBytes !== undefined, shed: ladder.records.length > 0 },
            measure: measureCandidate,
          }) ?? 0,
        );
        if (!stableEditKind && opts?.budgetOverrideBytes === undefined) {
          const ladderAt = (budget: number): ReturnType<typeof runLadder> => {
            let simulated = runLadder({
              payload,
              kind,
              budget: withReserve(calibratedLimit),
              context: ladderContext,
              validate: (candidate) => validateShedCandidate(candidate, kind),
              canonicalize: (candidate) => canonicalizeBudgetDemotion(candidate),
            });
            if (budget < calibratedLimit && simulated.used > budget) {
              const reentered = runLadder({
                payload: simulated.payload,
                kind,
                budget: withReserve(budget),
                context: ladderContext,
                validate: (candidate) => validateShedCandidate(candidate, kind),
                canonicalize: (candidate) => canonicalizeBudgetDemotion(candidate),
              });
              if (reentered.used < simulated.used) simulated = reentered;
            }
            return simulated;
          };
          for (let round = 0; round < 6; round += 1) {
            const retry = ladderAt(floor);
            const needed = Math.max(
              retry.used > floor ? retry.used : 0,
              stagedReadFloorBytes({
                payload: retry.payload,
                staged: context.readRequest,
                claim: { budgetDeclared: true, shed: retry.records.length > 0 },
                measure: measureCandidate,
              }) ?? 0,
            );
            if (needed <= floor) break;
            floor = needed;
          }
        }
        refusalFloorBytes = floor;
      }
    }
  }

  // §4.3 REQUIRED SET, judged on the payload that ships and BEFORE the ledger
  // half books anything: a response replaced by a refusal here must not leave
  // served-window bookings or emission rows behind that the refusal does not
  // carry (the same accounting rule the unknown-kind gate above follows).
  const requiredSetReplacement = enforceRequiredSet(current, onWire, context);
  if (requiredSetReplacement !== undefined) {
    discardStagedServeBookings(context);
    return requiredSetReplacement;
  }
  if ((onWire === "read.task_pack") && !ledgerCertificateBindingValid(current)) {
    const detail = "protocol v1 ledger certificate binding violation; producer emitted an unverifiable act decision";
    if (decisionInvariantStrictEnabled()) throw new Error(detail);
    const tool = advertisedTool(context.tool);
    if (tool === undefined) throw new Error(detail);
    const refusal = buildRefusal(tool, { code: "invalid-input", retry: "none", detail });
    const refusalText = JSON.stringify(refusal);
    discardStagedServeBookings(context);
    noteEmission(context, { limit: 0, used: measureResponseBytes(refusalText) });
    return { content: [{ type: "text", text: refusalText }], isError: true };
  }

  // [R5-10], THE LEDGER HALF. Anything the nine booking sites recorded that
  // this response does not actually carry is retracted, and those lines stay
  // discovery-eligible. Runs for every kind, refusals included: a refusal
  // carries nothing, so a serve path that booked before refusing books nothing.
  //
  // AGAINST THE POST-SHED PAYLOAD, which is why the ladder runs first: a rung
  // that dropped an `Evidence.body` retracts the claim that those bytes reached
  // the consumer, and `servedWindowsOf` sees the retraction automatically
  // because it books a window iff a body string is present at that node.
  //
  // FX-N (ruling (s), 2026-09-03) — AND IT NOW RUNS FOR READS.
  //
  // The guard used to be `context.workspace !== undefined`, and
  // `noteWorkspaceRoot` has exactly one non-test call site: `server.ts`'s
  // `finishEdit`, the EDIT dispatch. So this half — the half `envelope.ts`'s
  // F-A1-6 fix was written to feed ("a refusal projects `{unattributed:false,
  // windows:[]}` so `settleServedRanges` then retracts every pending span for
  // this call") — was dead for every `tl_read_file`/`tl_search_files` response ever
  // emitted. Round-16 finding 1 is what that cost: a byte-free
  // `refusal/cap-exceeded` left its provisional span standing, and the next
  // slice of the same file was answered `read.receipt{code-unchanged,
  // served_by:"full 1-400 (call #2)"}` — naming the refusal as the serve.
  //
  // `readServeWorkspace` is the read-scoped slot that closes it (see its doc
  // comment for why it is a fourth field rather than a second writer of the
  // edit-only `workspace`). A call is either an edit dispatch or a read/search
  // dispatch, never both, so the two never contend; `settleServedCallBookings`
  // additionally settles any OTHER session this call booked into (a handle
  // that adopted its own mint root), and is the single pass that promotes the
  // staged union/residency bookings — one booking write per call, after the
  // wire is final, exactly as ruling (s) requires.
  //
  // FX-O1 (ruling (t), 2026-09-03) — AND IT IS ATTRIBUTED. `serveAttribution`
  // is the path a staging site named for the two production shapes whose
  // payload carries a body with no `path` of its own (`mode=symbol`'s scope
  // view, `mode=auto`'s small-content serve). Without it those responses
  // projected `unattributed: true`, and the settlement's `unattributed` arm
  // failed OPEN — promoting every pending staged path, including residue a
  // call that threw before the funnel left behind. That arm is fail-CLOSED
  // now (`state/session.ts`), which is only honest because the attribution
  // makes `unattributed` unreachable for a shipped body. An empty string means
  // the call staged for two different paths: ambiguous, so no attribution.
  // DESIGN-v0.15 §3.2, LAST SENTENCE — "最終段で証拠が減ったならact.*を降格し、
  // 未配信範囲を回復するnextを残す". §2.1.1's act floor (inside the ladder)
  // already catches the case where a cut makes the evidence set STRUCTURALLY
  // insufficient for the act. This catches the weaker one the design also
  // names: the evidence merely DECREASED. A certificate is a claim about bytes
  // that shipped, and a body the ladder truncated did not ship whole.
  //
  // GATED ON `ladder.records.length > 0`, so at the calibrated budgets — where
  // nothing sheds — this is a no-op returning the payload BY IDENTITY, and the
  // §6.1(b) pins keep their bytes.
  const demoted = demoteActAfterShed({
    before: payload,
    after: current,
    onWire,
    shed: ladder.records.length > 0,
    canonicalize: (candidate) => canonicalizeBudgetDemotion(candidate),
  });
  if (demoted !== current) {
    current = demoted;
    text = JSON.stringify(current);
    used = measureResponseBytes(text);
  }

  // R2-R1 (P0-2, review 2026-09-30): DECIDE THE FINAL PAYLOAD BEFORE ANYTHING
  // IS BOOKED. The ledger half and the request half below settle against
  // `current`; the post-rewrite budget net further down used to run AFTER
  // both, so a line it dropped (or a page it replaced by a refusal) had
  // already been booked as served and `D = Q - (C u S)` never owed it again —
  // the chain skipped those lines for good (reviewer: lines 76-126 of a
  // 500-line whole-file read at 6144 B; FX1 chip 2: a window's last line).
  // A staged read is therefore sized HERE with a dry run of its own
  // continuation (`fitStagedReadToBudget`: the real cursor, the real D), shed
  // exactly as the ladder orders it (prose, then whole lines), and — when even
  // one line does not fit — refused with the EXACT floor before a single span
  // is booked. Only `read.text` / `read.batch` are touched: a receipt or a
  // closure is emitted regardless (see `failClosed`).
  // A RESUMED CURSOR DECLARES NO BUDGET ON ITS OWN CALL: it rides the request
  // (§5.2 "原要求のbudgetは状態で継承する"). `server.ts` restores it onto the
  // dispatcher's private copy of the arguments, which never reaches
  // `context.args` (the INBOUND arguments), so `declaredMaxBytes` is undefined
  // here and the limit is the calibrated ceiling: a page `choosePage` sized
  // from a flat envelope reserve shipped over the very budget the request
  // carries (multi-window pages, +1..11% measured). The request's own budget
  // bounds the pre-settle fit — the fit drops a line BEFORE anything is booked,
  // so `D` re-owes it and the chain stays exact-once.
  //
  // BEST EFFORT, NEVER A NEW REFUSAL AND NEVER A STRUCTURAL CUT: the fit trims
  // ESTIMATION error, not fixed overhead. A resumed page that overshoots its
  // inherited budget by up to `RESUME_TRIM_SLACK` (`choosePage` under-counts a
  // multi-window page's per-row overhead: +1..11% measured over 2-6 windows) is
  // trimmed by a line or two; one that overshoots by more, or that not even ONE
  // line can make fit, ships as `choosePage` chose it, exactly as v0.14.4 did.
  // Its overshoot is then a fixed overhead the ladder cannot shed — a markdown
  // page's heading index (~2 KB for a 40-heading document) — and enforcing the
  // budget there would answer a 1.5 KB request with one-line pages that each
  // re-carry that index (measured: 6 pages became 100+).
  const inheritedBudgetBytes = declaredMaxBytes === undefined && context.readRequest?.mode === "resume"
    ? requestBudgetBytes(context.readRequest.state.budget)
    : undefined;
  const trimToInherited = inheritedBudgetBytes !== undefined && used <= inheritedBudgetBytes * RESUME_TRIM_SLACK;
  if (context.readRequest !== undefined && (onWire === "read.text" || onWire === "read.batch")) {
    const fit = fitStagedReadToBudget({
      payload: current,
      staged: context.readRequest,
      claim: { budgetDeclared: declaredMaxBytes !== undefined || inheritedBudgetBytes !== undefined, shed: ladder.records.length > 0 },
      limit: inheritedBudgetBytes !== undefined && trimToInherited ? Math.min(limit, inheritedBudgetBytes) : limit,
      measure: (candidate) => measureResponseBytes(JSON.stringify(candidate)),
    });
    if (fit.ok) {
      if (fit.payload !== current) {
        const usedBeforeFit = used;
        current = fit.payload;
        text = JSON.stringify(current);
        used = measureResponseBytes(text);
        // A LINE the fit dropped is shedding like any rung's, and the ledger
        // half below must know it: it is recorded in the ladder's OWN shed
        // record (ruling (aa): the settlement's shed signal is derived from
        // that record and nowhere else), so `wasShed` is true and the
        // settlement can never widen a corroborated window back out over the
        // lines that were cut. Prose peeled alone is not a window change.
        if (fit.shrunk) ladder.records.push({ rung: 4, bytes: usedBeforeFit - used });
      }
    } else if (inheritedBudgetBytes === undefined) {
      // (A resumed page whose INHERITED budget not even one line fits is NOT refused: see below.)
      const forTool = advertisedTool(context.tool);
      if (forTool !== undefined) {
        current = canonicalizeEmittedToolCalls({
          ...buildRefusal(forTool, {
            code: "budget-below-minimum",
            field: "budget",
            detail: "raise budget.bytes to at least required_min_bytes and re-issue the same call",
            required_min_bytes: fit.requiredMinBytes,
            retry: "call",
          }),
        }) as ShedPayload;
        refusalOfBatch = onWire === "read.batch";
        onWire = "refusal";
        text = JSON.stringify(current);
        used = measureResponseBytes(text);
      }
    }
  }

  const settlementRoot = context.workspace !== undefined && context.workspace !== ""
    ? context.workspace
    : context.readServeWorkspace;
  const serveAttribution = context.serveAttributionPath !== undefined
    && context.serveAttributionPath !== ""
    ? context.serveAttributionPath
    : undefined;
  // FX-W3 (ruling (aa), 2026-09-04): `wasShed` is the ONE signal that lets
  // `state/session.ts`'s settlement widen a staged claim past the wire's own
  // declared window — and only when THIS response's own ladder run performed
  // ZERO shedding. `ladder.records` (populated above, BEFORE any `failClosed`
  // conversion) is exactly that record; a ladder that genuinely cut nothing
  // but was later replaced by a required-set refusal is moot regardless,
  // since `servedWindowsOf` returns `windows: []` for any `kind: "refusal"`
  // payload and there is then nothing for the settlement to widen. With ANY
  // shedding at all, no widening is ever offered, closing round-21A finding 1
  // (a forged marker-shaped literal plus an ordinary `budget.bytes` shed
  // could otherwise have inflated corroboration past what the wire actually
  // carried, when the widening lived in the wire-text-parsing projector
  // instead of here). See `WorkspaceSession.pendingRenderedExtent`'s doc
  // comment for how the true extent is recorded, in file coordinates, at
  // STAGING time, independent of this signal.
  const wasShed = ladder.records.length > 0;
  settleServedCallBookings(
    servedWindowsOf(current, serveAttribution),
    settlementRoot !== undefined && settlementRoot !== "" ? settlementRoot : undefined,
    wasShed,
  );

  // DESIGN-v0.15 §5 (R2), THE REQUEST HALF — immediately after the ledger half,
  // and for the same reason: D = Q - (C ∪ S) is only computable once the ledger
  // reflects exactly what THIS response carries. `applyReadRequestContinuation`
  // recomputes D, persists it, and collapses every `next` position onto the ONE
  // cursor call that continues the ORIGINAL request (§5.3). With no staged
  // request — every call that is not a line-addressed read — it returns the
  // payload by identity and nothing is re-serialized.
  const continued = applyReadRequestContinuation(current, context.readRequest, {
    budgetDeclared: declaredMaxBytes !== undefined,
    shed: ladder.records.length > 0,
    ...(refusalFloorBytes !== undefined ? { refusalFloorBytes } : {}),
    ...(refusalOfBatch ? { refusalOfBatch: true } : {}),
  });
  if (continued !== current) {
    current = continued;
    text = JSON.stringify(current);
    used = measureResponseBytes(text);
  }
  // R2-R1 (P1-5, `comments:"keep"`): a `content:"full"` request that has just been
  // delivered COMPLETE by its own pages proves the whole file was served under
  // that representation. The ledger alone cannot say so for `keep` (it records no
  // representation), so the full-serve completeness marker that gates the
  // `code-unchanged` receipt was left at "partial" by the head and stayed there:
  // the identical request after the chain re-served a head with no continuation —
  // a partial page presented as complete. Cleared ONLY when nothing was held at
  // open time (every line came from this request's own keep-representation pages).
  if (context.readRequest !== undefined && current["kind"] !== "refusal") {
    const request = context.readRequest;
    for (const target of request.state.targets) {
      const whole = target.requested.length === 1
        && target.requested[0]!.start === 1
        && target.requested[0]!.end === target.total_lines;
      if (
        target.representation.content === "full"
        && target.representation.comments === "keep"
        && whole
        && target.remaining.length === 0
        && (request.state.ledger_baseline?.[target.path] ?? []).length === 0
      ) {
        recordFullServeCompleteness(request.workspaceRoot, target.path, target.sha, true, true);
      }
    }
  }

  // ---------------------------------------------------------------------
  // DESIGN-v0.15 §6.1 (R3), THE SEARCH REQUEST HALF — a SEPARATE, ADDITIVE
  // block after the read-request block above (never inside it): a staged
  // `tl_search_files find` request's `delivered` prefix is settled from this
  // SAME finalized payload, for the same reason R2's settle runs here rather
  // than at dispatch time — the ladder has already run, so this reflects
  // exactly what THIS response carries. `applySearchRequestContinuation`
  // returns the payload by identity for every call that did not stage a
  // search request (every non-`find` search response, and every `find`
  // whose result already fit in one response).
  // finding 11: snapshotted BEFORE the settle below can advance it, so a
  // post-rewrite shrink retry (further down) can correctly rewind this
  // request's monotonic `delivered` prefix if it needs to drop a group this
  // settle is about to count as shipped — see `rewindSearchRequestDelivered`.
  const searchDeliveredBeforeSettle = context.searchRequest?.state.delivered;
  const searchContinued = applySearchRequestContinuation(current, context.searchRequest);
  if (searchContinued !== current) {
    current = searchContinued;
    text = JSON.stringify(current);
    used = measureResponseBytes(text);
  }
  // ---------------------------------------------------------------------

  // finding 11: POST-REWRITE BUDGET SAFETY. `used` was just recomputed twice
  // above, but never re-compared to `limit` — budget safety rested entirely
  // on `READ_CURSOR_NEXT_RESERVE_BYTES`/`PAGE_ENVELOPE_RESERVE_BYTES`/
  // `searchPageEnvelopeReserve` being adequate reserves, which they are
  // MEASURED (not merely guessed) to be at every calibrated budget — the
  // design's own 1024 B/113-line case peaks at 948 B across every page — so
  // this is unreachable today. It is the honest fallback the moment one of
  // them under-estimates: ONE whole-line shrink of the page the rewrite just
  // installed, re-run through the SAME continuation function so D/`next`
  // reflect exactly what survives (never a stale, wider continuation for a
  // narrower body), and — only if that single shrink still is not enough —
  // fail closed naming the floor, exactly like the read cursor's and (finding
  // 9's) search staging's own `budget-below-minimum` refusal. Never ships the
  // truth silently over budget.
  //
  // NEVER when `current` is ALREADY a refusal. `applyReadRequestContinuation`
  // deliberately still installs its cursor on one (a `budget-below-minimum`
  // refusal's own `limit.next` is how a caller retries the SAME request at a
  // raised budget) — genuinely reachable today, unlike the read/search
  // request's OWN reserve. Re-deciding a settled refusal here — e.g. a
  // `cap-exceeded` the LADDER's own fail-closed tail already produced,
  // widened by that cursor install past a razor-thin declared budget — would
  // overwrite one honest, already-terminal refusal with a different one for
  // no reason; `current["kind"]` is the ground truth for this, not `onWire`
  // (a ladder-internal fail-closed rung can produce a refusal-shaped payload
  // without `onWire` itself ever being reassigned).
  if (
    (context.readRequest !== undefined || context.searchRequest !== undefined)
    && used > limit
    && current["kind"] !== "refusal"
  ) {
    // BCF2: a `read.batch` payload has no top-level `evidence[]`, so the
    // evidence-shaped shrink always returns `undefined` for one — try the
    // `entries[]`-shaped sibling next. Exactly one of the two ever applies to
    // a given payload (the two shapes are mutually exclusive kinds), so the
    // order is immaterial; evidence first only because it was here first.
    // SPB (2026-10-10): a search page is filled to its byte budget now, so its
    // net drops as many trailing match groups as the overshoot needs (never
    // the last one) rather than exactly one — see `shrinkSearchPageToFit`.
    // The candidate still carries the cursor installed above; the re-installed
    // one below is the same length, so this measures the page that will ship.
    const shrunk = context.readRequest !== undefined
      ? shrinkLargestEvidenceByOneLine(current) ?? shrinkLargestBatchEntryByOneLine(current)
      : shrinkSearchPageToFit(current, (candidate) => measureResponseBytes(JSON.stringify(candidate)) <= limit);
    if (shrunk !== undefined) {
      let reRewritten: ShedPayload;
      if (context.readRequest !== undefined) {
        reRewritten = applyReadRequestContinuation(shrunk, context.readRequest, {
          budgetDeclared: declaredMaxBytes !== undefined,
          shed: true,
        });
      } else {
        if (context.searchRequest !== undefined && searchDeliveredBeforeSettle !== undefined) {
          rewindSearchRequestDelivered(context.searchRequest, searchDeliveredBeforeSettle);
        }
        reRewritten = applySearchRequestContinuation(shrunk, context.searchRequest);
      }
      const reText = JSON.stringify(reRewritten);
      const reUsed = measureResponseBytes(reText);
      if (reUsed <= limit) {
        current = reRewritten;
        text = reText;
        used = reUsed;
      }
    }
    if (used > limit) {
      const forTool = advertisedTool(context.tool);
      if (forTool !== undefined) {
        current = canonicalizeEmittedToolCalls({
          ...buildRefusal(forTool, {
            code: "budget-below-minimum",
            field: "budget",
            detail: "raise budget.bytes to at least required_min_bytes and re-issue the same call",
            required_min_bytes: used,
            retry: "call",
          }),
        }) as ShedPayload;
        onWire = "refusal";
        text = JSON.stringify(current);
        used = measureResponseBytes(text);
      }
    }
  }

  const shed = ladder.records;
  // V10-11: choose the wire REPRESENTATION of the payload already finalized
  // above -- a no-op unless TOKENLIGHTEN_RESPONSE_FORMAT/TL_WIRE_SHADOW is
  // explicitly set (protocol/codec/pipeline.ts), which is what keeps this a
  // byte-invisible refactor at default budgets, matching this file's own
  // "REFACTOR AT DEFAULT BUDGETS" invariant above. Re-measured through the
  // ONE sanctioned byte counter so `emittedBytes`/`used` describe what is
  // actually on the wire.
  text = applyResponseCodec(text, current, onWire, context, limit);
  used = measureResponseBytes(text);
  noteEmission(context, { limit, used, ...(shed.length > 0 ? { shed } : {}) }, text, kind, shed.length > 0);
  context.shedRecords = shed;

  // I-7 (2026-08-30 forensics attribution wave): the funnel tail is where the
  // FINAL kind/bytes that actually ship are known -- see
  // ProtocolCallContext.postReadyDiscovery's doc comment for the fire
  // condition. `workspace` is edit-only on this context; `codecTraceWorkspace`
  // is the one tl_read_file/tl_search_files dispatch always publishes (D1/F-C2a).
  const postReadyWorkspace = context.workspace ?? context.codecTraceWorkspace;
  if (context.postReadyDiscovery !== undefined && postReadyWorkspace !== undefined && isTraceEnabled()) {
    trace(
      "post_ready_followup",
      {
        tool: context.tool,
        kind_served: onWire,
        bytes: used,
        force_serve: context.postReadyDiscovery.forceServe,
        scope_class: context.postReadyDiscovery.scopeClass,
      },
      postReadyWorkspace,
    );
  }

  const finalized: FinalizableResult = {
    content: [{ type: "text", text }],
  };
  if (isErrorForKind(onWire)) finalized.isError = true;
  return finalized;
}

/**
 * FX-N (ruling (s)): the three EARLY RETURNS out of `emitFinalizedPayload`
 * each ship a refusal in place of the payload the producers booked against,
 * so they settle exactly as a refusal does — against an empty window list.
 * FX-O1 (ruling (t)) adds `emitOpaqueText`'s three exits, for the same reason
 * and with the same call: an unparseable response corroborates nothing, and
 * what it leaves staged is residue the NEXT call would otherwise settle.
 * Nothing is retracted that a previous call established (the staged bookings
 * of THIS call were never written); the provisional spans this call booked
 * are dropped, which is what "a refusal books nothing" means concretely.
 */
function discardStagedServeBookings(context: ProtocolCallContext): void {
  const root = context.workspace !== undefined && context.workspace !== ""
    ? context.workspace
    : context.readServeWorkspace;
  settleServedCallBookings(
    { unattributed: false, windows: [] },
    root !== undefined && root !== "" ? root : undefined,
  );
}

/**
 * §4.3's TAIL: what to do when the ladder ran out and the payload still will
 * not fit. Returns the converted payload, or `undefined` for "emit what you
 * have".
 *
 * THREE OUTCOMES, one per class of member:
 *
 *  1. SE-STABLE (`edit.applied`, `edit.rolled_back`, `edit.state_unknown`) —
 *     EMIT REGARDLESS, never convert. A refusal in their place asserts that
 *     nothing happened, about a disk where something did (§4.2.1(1)). The
 *     32 KiB reserve is what makes the floor fit (S4's proof); this branch is
 *     what happens if a future misconfiguration defeats it, and shipping an
 *     over-budget truth beats shipping a well-sized lie. (SIZE only: a
 *     side-effect body that fails its §4.3 REQUIRED SET is replaced by a
 *     state-unknown refusal in `enforceRequiredSet` — malformation leaves no
 *     truth to ship oversized.)
 *  2. `read.receipt` / `read.closure` — EMIT REGARDLESS, and RECORD A
 *     VIOLATION. §5.4 measures both at ~350 B and says a budget below ~400 B
 *     "cannot fit them => STARTUP MISCONFIGURATION". S4's floor check is where
 *     that is caught; if a response reaches here anyway, the honest report is
 *     the response plus a finding on the call context — converting a receipt
 *     the caller is waiting on into a refusal would answer a question about
 *     residency with a question about configuration.
 *  3. EVERYTHING ELSE — a fail-closed `refusal` NAMING THE LIMIT, with
 *     `retry:"call"` and the ladder's own narrower `next` when it built one.
 *     A `refusal` is already the conversion target and is emitted as it stands.
 *
 * THE CODE IS `cap-exceeded`, HARVESTED NOT MINTED. A.7.1 files it under
 * `ReadLimitCode` and its existing emitters are read-side byte caps
 * (`server.ts:2874`, `:3016`) — the wire budget is the same fact one layer out,
 * and A.7.1's membership rule is about what can appear as `Refusal.code`, not
 * about which sub-union a value was first grouped into. Minting a
 * `response-too-large` beside it would add a second spelling of one condition,
 * which is precisely what [R5-9] spent an adjudication removing elsewhere. The
 * cross-tool placement is recorded as an S3 note rather than fixed by a mint.
 */
/**
 * The recovery `next` a payload ALREADY carried before shedding ran, if any.
 *
 * DESIGN-v0.15 §5.3/§3.3 (R2): `failClosed`'s only source of a recovery
 * `next` used to be `ladder.continuation` — a shedder RUNG's own computed
 * continuation. A rung that shrinks a payload WITHOUT recomputing one (the
 * `read.map` skeleton shedder trims `outline.signatures` but builds no
 * continuation of its own) left the eventual refusal with NO `next` at all,
 * discarding a perfectly good, already-executable recovery the PRODUCER had
 * already named on the unshed body. Measured: a per-task-governed `read.map`
 * skeleton downgrade ("per-task whole-file budget spent on other files; zoom
 * this handle by range") too big for a small declared budget refused
 * `cap-exceeded` with no `next` at all — a dead end for a call whose only
 * fault was arriving after this task's OTHER full reads, not anything about
 * the file itself.
 *
 * Checked in the same fixed priority the design's own canonical-next
 * selection uses (`limit.next`, then top-level `next`, then `decision.next`),
 * so this recovers the producer's existing continuation without teaching
 * every shedder rung to duplicate it.
 */
function existingNextOf(payload: ShedPayload): ToolCall | undefined {
  const asCall = (value: unknown): ToolCall | undefined => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    const tool = record["tool"];
    const args = record["arguments"];
    return typeof tool === "string" && args !== null && typeof args === "object" && !Array.isArray(args)
      ? ({ tool, arguments: args } as ToolCall)
      : undefined;
  };
  const limit = payload["limit"];
  const limitNext = limit !== null && typeof limit === "object" && !Array.isArray(limit)
    ? asCall((limit as Record<string, unknown>)["next"])
    : undefined;
  if (limitNext !== undefined) return limitNext;
  const topNext = asCall(payload["next"]);
  if (topNext !== undefined) return topNext;
  const decision = payload["decision"];
  return decision !== null && typeof decision === "object" && !Array.isArray(decision)
    ? asCall((decision as Record<string, unknown>)["next"])
    : undefined;
}

/**
 * R-A5 (v0.14.4 candidate, 2026-09-21): the small, fixed safety margin that
 * makes `required_min_bytes` survive being fed straight back in as the
 * RETRY's own declared `budget.bytes` (see the call site's own doc comment
 * for the mechanism — `server.ts`'s A7 construction loop reads that same
 * declared value before this ladder ever runs, so a byte-for-byte-exact
 * floor is not quite stable across two different calls). MEASURED
 * (`readBatchNextUnionMatrix.spec.ts`'s floor-adjacent matrix: entry counts
 * 2/9/12/16, both host configs, budgets swept across the measured floor):
 * the observed delta between what `used` predicts and what a fresh
 * construction at that exact budget actually needs is at most a few bytes,
 * in either direction. 64 is comfortably above that observed range without
 * materially loosening the floor (this kind's own responses run from
 * several hundred bytes to several KB, so 64 B is noise against either) —
 * chosen as a round number with headroom, not tuned to the last byte of any
 * one case.
 */
const READ_BATCH_FLOOR_MARGIN_BYTES = 64;

/**
 * GATE-C1 (2026-09-22), FX-U3 extreme-tiny-budget finding. Mirrors
 * `readCodeTaskPack.ts`'s `REQUIRED_MIN_TASK_PACK_BYTES` (not imported: this
 * protocol-layer module sits below `features/task-pack/`, so the dependency
 * would run the wrong way). No automated drift check exists between the two
 * constants today — a future change to either should grep for the other.
 *
 * A `read.batch` continuation's `next` (`targets:[...]` + `budget`, no
 * `query`) is a paths-list request that `server.ts` promotes straight into a
 * task-pack build on resubmission, and `admitTaskPackBudget` there refuses
 * ANYTHING below this floor before construction even runs. At an ordinary
 * shortfall `used + READ_BATCH_FLOOR_MARGIN_BYTES` already clears it and this
 * floor is a no-op. MEASURED live (`packWireBudgetFxU3.spec.ts` /
 * `readCodePack.spec.ts`'s FX-U3 case, `maxTokens` 50/100 — `used` a few
 * hundred bytes): without this floor, retrying at the refusal's own
 * `required_min_bytes` hit that DIFFERENT gate's much larger floor and
 * refused again, this time with no `next` at all — a dead end one hop after
 * the "first retry always works" promise `READ_BATCH_FLOOR_MARGIN_BYTES` (R-A5,
 * ruling 2) makes. Flooring `required_min_bytes` here — never `used` itself,
 * which stays the honest measured size for every OTHER purpose this function
 * feeds — is the minimal fix: it can only raise what the refusal advertises,
 * never lower it.
 *
 * Must equal `REQUIRED_MIN_TASK_PACK_BYTES` in `readCodeTaskPack.ts` (not
 * imported: that would invert the module dependency); `budgetFloorSync.spec.ts`
 * fails if the two drift apart.
 */
export const READ_BATCH_TASK_PACK_PROMOTION_FLOOR_BYTES = 6144;

/** `used`, padded by `READ_BATCH_FLOOR_MARGIN_BYTES`, floored at `READ_BATCH_TASK_PACK_PROMOTION_FLOOR_BYTES` — see both constants' own doc comments. */
function readBatchRequiredMinBytes(used: number): number {
  return Math.max(used + READ_BATCH_FLOOR_MARGIN_BYTES, READ_BATCH_TASK_PACK_PROMOTION_FLOOR_BYTES);
}

/**
 * R-A5: the `next` a `read.batch` `budget-below-minimum` refusal carries,
 * when `continuation` (the ladder's own accumulated union of every
 * undelivered window — see `wireLimit.ts`'s no-trim rule) is tl_read_file-
 * shaped — the SAME windows, with `budget.bytes` raised to the exact floor
 * this refusal names, so a caller that runs `next` verbatim (AGENTS.md:
 * "never as a template") need not reconstruct "same call, higher budget"
 * itself. `undefined` when `continuation` is absent or not a plain
 * `tl_read_file` call (defensive; every `read.batch` continuation this tree
 * mints is `tl_read_file`-shaped by construction) — the refusal then carries no
 * `next` at all, exactly like the task-pack / read-cursor `budget-below-
 * minimum` refusals, which rely on `retry:"call"` alone.
 *
 * Finding 13 (adversarial review, 2026-09-27): `continuation` is the
 * pre-conversion shedder DRAFT's own "what I still have not included"
 * union — a target that draft HAD already included (even a single small
 * row can already exceed a tiny declared budget) is, from that draft's own
 * point of view, no longer pending, so it is absent from `continuation`.
 * But THIS refusal discards the draft wholesale — a `budget-below-minimum`
 * response ships no `entries[]` at all — so every window the draft had
 * quietly included is, on THIS wire response, exactly as undelivered as
 * the ones `continuation` does name. Live repro: two targets, a 300-byte
 * budget; the draft's first entry alone cleared 300 bytes, so its `next`
 * named only the second target, and the refusal that replaced the whole
 * draft silently dropped the first. The `next` therefore names the UNION of
 * the draft's own entries (`path`/`handle` + the `range` each would have
 * shipped) and `continuation`'s targets, merged per file. It is never
 * rebuilt from `ProtocolCallContext.args`: by the time a read.batch reaches
 * the ladder those are the dispatcher's legacy-translated arguments
 * (`handles:[…]`), which have already lost each target's `range` — a retry
 * built from them re-reads only each handle's own minted window (measured:
 * `readBatchNextUnionMatrix.spec.ts`, every line past the first lost).
 */
function budgetBelowMinimumNext(
  continuation: ToolCall | undefined,
  requiredMinBytes: number,
  draft: ShedPayload,
  context: ProtocolCallContext,
): ToolCall | undefined {
  const continuationArgs = continuation !== undefined && continuation.tool === "tl_read_file"
    && continuation.arguments !== null && typeof continuation.arguments === "object"
    && !Array.isArray(continuation.arguments)
    ? continuation.arguments as Record<string, unknown>
    : undefined;
  const targets = unionRefusalTargets(draft, continuationArgs);
  if (targets.length === 0) {
    if (continuationArgs === undefined) return undefined;
    return { tool: "tl_read_file", arguments: { ...continuationArgs, budget: { bytes: requiredMinBytes } } } as ToolCall;
  }
  const base: Record<string, unknown> = continuationArgs ?? pickDefined(context.args, ["cwd", "lane", "content"]);
  return {
    tool: "tl_read_file",
    arguments: { ...base, targets, budget: { bytes: requiredMinBytes } },
  } as ToolCall;
}

function pickDefined(source: Readonly<Record<string, unknown>> | undefined, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (source?.[key] !== undefined) out[key] = source[key];
  return out;
}

/**
 * `budgetBelowMinimumNext`'s target list: the draft's entries (the windows it
 * would have shipped) and the continuation's targets (the windows it had not
 * included), grouped per file (`handle`, else `path`) in first-appearance
 * order. A file named without a `range` anywhere is requested whole; otherwise
 * its ranges are merged where they overlap or touch, one target per span.
 */
function unionRefusalTargets(
  draft: ShedPayload,
  continuationArgs: Record<string, unknown> | undefined,
): Record<string, unknown>[] {
  type Group = { identity: Record<string, unknown>; whole: boolean; spans: Array<[number, number]> };
  const groups = new Map<string, Group>();
  const note = (source: unknown): void => {
    if (source === null || typeof source !== "object" || Array.isArray(source)) return;
    const record = source as Record<string, unknown>;
    const handle = typeof record["handle"] === "string" ? record["handle"] : undefined;
    const path = typeof record["path"] === "string" ? record["path"] : undefined;
    if (handle === undefined && path === undefined) return;
    const key = handle !== undefined ? `h:${handle}` : `p:${path}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = { identity: {}, whole: false, spans: [] };
      groups.set(key, group);
    }
    if (path !== undefined && group.identity["path"] === undefined) group.identity["path"] = path;
    if (handle !== undefined) group.identity["handle"] = handle;
    const range = typeof record["range"] === "string" ? /^(\d+)(?:-(\d+))?$/.exec(record["range"]) : null;
    if (range === null) {
      group.whole = true;
      return;
    }
    const start = Number(range[1]);
    group.spans.push([start, range[2] !== undefined ? Number(range[2]) : start]);
  };
  const entries = draft["entries"];
  if (Array.isArray(entries)) for (const entry of entries) note(entry);
  const continued = continuationArgs?.["targets"];
  if (Array.isArray(continued)) for (const target of continued) note(target);
  const out: Record<string, unknown>[] = [];
  for (const group of groups.values()) {
    if (group.whole || group.spans.length === 0) {
      out.push({ ...group.identity });
      continue;
    }
    const spans = [...group.spans].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const merged: Array<[number, number]> = [];
    for (const [start, end] of spans) {
      const last = merged[merged.length - 1];
      if (last !== undefined && start <= last[1] + 1) last[1] = Math.max(last[1], end);
      else merged.push([start, end]);
    }
    for (const [start, end] of merged) out.push({ ...group.identity, range: `${start}-${end}` });
  }
  return out;
}

function budgetBelowMinimumRefusal(
  context: ProtocolCallContext,
  requiredMinBytes: number,
  continuation: ToolCall | undefined,
  draft: ShedPayload,
): ShedPayload | undefined {
  const forTool = advertisedTool(context.tool);
  if (forTool === undefined) return undefined;
  // Finding 13: only for a tl_read_file shortfall — `read.batch` (the only kind
  // that reaches this function) is exclusively a `tl_read_file` response kind,
  // but the guard stays explicit rather than assumed.
  const next = context.tool === "tl_read_file"
    ? budgetBelowMinimumNext(continuation, requiredMinBytes, draft, context)
    : undefined;
  return canonicalizeEmittedToolCalls({
    ...buildRefusal(forTool, {
      code: "budget-below-minimum",
      field: "budget",
      detail: "raise budget.bytes to at least required_min_bytes and re-issue the same call",
      required_min_bytes: requiredMinBytes,
      retry: "call",
      ...(next !== undefined ? { next } : {}),
    }),
  }) as ShedPayload;
}

function failClosed(
  kind: Kind,
  context: ProtocolCallContext,
  limit: number,
  used: number,
  next: ToolCall | undefined,
): ShedPayload | undefined {
  if (!shedderFor(kind).refusalConvertible || kind === "refusal") return undefined;

  if (kind === "read.receipt" || kind === "read.closure") {
    recordProtocolViolation(context, {
      kind,
      missing: [],
      violated: [`wire/floor-exceeds-budget:${used}>${limit}`],
    });
    return undefined;
  }

  const forTool = advertisedTool(context.tool);
  // No advertised tool means no `for`, and `for` is in A.5.15's required set —
  // so there is no honest refusal to convert INTO. Emit the over-budget
  // response rather than a malformed replacement for it.
  if (forTool === undefined) return undefined;

  // W2-3: `next` is `ladder.continuation`, and a refusal built here is a new
  // payload after the producer envelope pass has completed. Re-run the SAME
  // `canonicalizeEmittedToolCalls` used by the normal path so this second mint
  // point cannot reintroduce a stale continuation shape.
  return canonicalizeEmittedToolCalls({
    ...buildRefusal(forTool, {
      code: "cap-exceeded",
      retry: "call",
      detail:
        `the ${kind} response measured ${used} B against a ${limit} B wire budget and could not be `
        + "reduced further without breaking its required set; re-issue a narrower call",
      ...(next !== undefined ? { next } : {}),
    }),
  }) as ShedPayload;
}

/**
 * Canonicalize calls minted by an act-floor demotion, then remove only the
 * optional `content:"auto"` default. Addressed recovery reads already default
 * to auto at dispatch, so carrying that hint on every duplicated recovery
 * call needlessly pushes a valid discover response over a tight wire cap.
 */
function canonicalizeBudgetDemotion(candidate: ShedPayload): ShedPayload {
  const canonical = canonicalizeEmittedToolCalls(candidate);
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (value === null || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    const copied: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(record)) copied[key] = visit(child);
    if (
      typeof copied["tool"] === "string"
      && copied["arguments"] !== null
      && typeof copied["arguments"] === "object"
      && !Array.isArray(copied["arguments"])
    ) {
      const args = { ...(copied["arguments"] as Record<string, unknown>) };
      if (args["content"] === "auto") delete args["content"];
      copied["arguments"] = args;
    }
    return copied;
  };
  return visit(canonical) as ShedPayload;
}

/** `context.tool` narrowed to A.1's three advertised names, or `undefined`. */
function advertisedTool(tool: string): ToolName | undefined {
  return tool === "tl_read_file" || tool === "tl_edit_file" || tool === "tl_search_files" ? tool : undefined;
}

function isSideEffectKind(kind: Kind): boolean {
  return kind === "edit.applied" || kind === "edit.rolled_back" || kind === "edit.state_unknown";
}

type ProtocolInvariantContext = ProtocolCallContext & { protocolViolationCount?: number };

function recordProtocolViolation(context: ProtocolCallContext, violation: ProtocolViolation): void {
  context.protocolViolations = [...(context.protocolViolations ?? []), violation];
  const counted = context as ProtocolInvariantContext;
  counted.protocolViolationCount = (counted.protocolViolationCount ?? 0) + 1;
}

function emitUnknownKindRefusal(kind: unknown, context: ProtocolCallContext): FinalizableResult {
  const detail = `protocol v1 unknown runtime kind ${String(kind)}; re-issue the call`;
  const tool = advertisedTool(context.tool);
  if (tool === undefined) throw new Error(detail);
  const refusal = buildRefusal(tool, { code: "unknown-kind", retry: "none", detail });
  const text = JSON.stringify(refusal);
  const counted = context as ProtocolInvariantContext;
  counted.protocolViolationCount = (counted.protocolViolationCount ?? 0) + 1;
  noteEmission(context, { limit: 0, used: measureResponseBytes(text) });
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * Wave-11 B4's production edge for the three side-effect kinds: the required
 * set failed on the payload that ships, so the truthful report is neither the
 * malformed body (it cannot testify to the write outcome) nor a transport
 * exception (it strips recovery) — it is a refusal that SAYS THE WRITE MAY
 * HAVE LANDED and routes the caller to verification. `recordProtocolViolation`
 * has already booked the audit row before this runs; emission accounting
 * mirrors `emitUnknownKindRefusal` above.
 */
function emitSideEffectViolationRefusal(
  kind: Kind,
  violation: ProtocolViolation,
  context: ProtocolCallContext,
): FinalizableResult {
  const detail =
    `protocol v1 required-set violation (fail-closed side-effect) on ${kind} — ` +
    `${describeVerdict(violation)}. The write may have reached disk: treat workspace state as ` +
    `unverified and re-read the edited paths (or run a diff) before continuing.`;
  const tool = advertisedTool(context.tool);
  if (tool === undefined) throw new Error(detail);
  const refusal = buildRefusal(tool, { code: "invalid-input", retry: "none", detail });
  const text = JSON.stringify(refusal);
  noteEmission(context, { limit: 0, used: measureResponseBytes(text) });
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * A required-set violation on a NON-side-effect kind (every read/search/
 * task-pack response) is a producer bug in THIS process, not a caller
 * mistake and not evidence of a write anyone needs to verify — there is no
 * disk state to warn about. Before this fix (MX-B group 1, 2026-09-14) the
 * two outcomes diverged by accident of configuration rather than by design:
 * under `TL_DECISION_INVARIANT_STRICT` (this package's own test env, and the
 * literal contract production enforces without the throw) `enforceRequiredSet`
 * threw an unhandled `Error`, surfacing to the caller as an opaque JSON-RPC
 * -32603 internal error; without the flag the malformed payload shipped
 * silently (`evidence:[]` and all). Neither is the fail-closed conversion
 * `emitSideEffectViolationRefusal` above already models for the side-effect
 * kinds — this is that same conversion for everything else, so BOTH modes
 * now produce the SAME structured, well-formed refusal.
 *
 * `retry:"none"`: the violation is about what THIS process computed for the
 * response, not about anything the caller supplied — there is no field to
 * fix, and re-issuing the identical call is expected to reproduce the same
 * bug (the same reasoning `emitUnknownKindRefusal`/`emitSideEffectViolation
 * Refusal` already apply). `describeVerdict` names the violated set (and any
 * missing keys) in `detail`, so the violation is legible without a second,
 * wire-level vocabulary for it.
 */
function emitRequiredSetViolationRefusal(
  kind: Kind,
  violation: ProtocolViolation,
  context: ProtocolCallContext,
): FinalizableResult {
  const detail =
    `protocol v1 required-set violation on ${kind} — ${describeVerdict(violation)}. `
    + "This is a server-side response-construction defect, not a problem with the call as "
    + "issued; re-issuing the identical call is expected to reproduce it.";
  const tool = advertisedTool(context.tool);
  if (tool === undefined) throw new Error(detail);
  const refusal = buildRefusal(tool, { code: "invalid-input", retry: "none", detail });
  const refusalText = JSON.stringify(refusal);
  noteEmission(context, { limit: 0, used: measureResponseBytes(refusalText) });
  return { content: [{ type: "text", text: refusalText }], isError: true };
}

/**
 * The MEASURE-ONLY path, for the funnel's three early returns: a response whose
 * `content[0].text` is not a string, is not a JSON object, or does not parse.
 *
 * Returns `result` ITSELF — the same object, the same string — so the bytes are
 * identical by identity rather than by reconstruction. There is no `kind` on
 * this path, therefore no budget row and no ladder.
 *
 * FX-O1 (ruling (t), 2026-09-03) — BUT THERE IS SOMETHING TO SETTLE, and the
 * sentence that used to end the paragraph above ("and nothing to settle") was
 * how this exit escaped [R5-10]. A serve path stages its bookings on the
 * session while it assembles the body; these three exits then ship a response
 * whose text this server could not even parse as an object, so it carries no
 * evidence to corroborate ANYTHING. Left unsettled, that staging survived as
 * RESIDUE which the next call in the same lane settled against its OWN
 * corroboration — the laundering channel round-17 finding 2 demonstrated but
 * could not find a production entrance for. This is one: reachable, and closed
 * the same way a refusal is, by settling against an empty window list.
 *
 * WHY MEASURE AT ALL. R1's residual is the class "some responses leave the
 * funnel without passing the measurement point". A pipeline that measures only
 * the paths it also shapes leaves that class open, and every later stage that
 * reasons about "what this server emitted" would be reasoning about a subset it
 * cannot name. Routing the early returns through here closes it: after S1,
 * every funnel exit that carries a text body has been measured, and the
 * measurement is recorded on the call context rather than discarded.
 */
export function emitOpaqueText(
  result: FinalizableResult,
  context: ProtocolCallContext,
): FinalizableResult {
  discardStagedServeBookings(context);
  const text = result.content[0]?.text;
  if (typeof text === "string") {
    const used = measureResponseBytes(text);
    noteEmission(context, { limit: 0, used });
  }
  return result;
}

/**
 * Record one emission on the per-call context.
 *
 * The context is an `AsyncLocalStorage` slot bound once per call, so this is
 * per-call state and not process-global: two concurrent calls on one server
 * cannot cross-contaminate, the same property `envelope.ts`'s kind declaration
 * and `state/session.ts`'s lane binding already rely on.
 *
 * S1 records the byte count and nothing else acts on it. S4's reserve
 * assertion and S6's fence attach HERE, which is the point of writing it down
 * now: one sink, one field, one place for a later stage to hook — rather than
 * three call sites each rediscovering how to measure.
 *
 * `limit: 0` on the opaque path is not a budget of zero; it is "this path has
 * no budget row", which is what `budgetFor` would have needed a `kind` to
 * answer.
 */
function carriesVerificationKit(text: string, kind: Kind | undefined): boolean {
  if (kind !== "edit.applied") return false;
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    return body.verification !== undefined;
  } catch {
    return false;
  }
}

function noteEmission(
  context: ProtocolCallContext,
  budget: WireBudget,
  text?: string,
  kind?: Kind,
  trimmed = false,
): void {
  context.emittedBytes = budget.used;
  if (text === undefined) return;
  const args = context.args;
  const epoch = typeof args?.["taskEpoch"] === "string" ? args["taskEpoch"] : undefined;
  const lane = typeof args?.["lane"] === "string" ? args["lane"] : undefined;
  const workspace = context.workspace;
  if (workspace === undefined || workspace === "") return;
  // B-F5 (2026-08-28): named "budget-shed", not "trim" — `trimmed` here is
  // exactly `shed.length > 0` from THIS call's own budget ladder (see the
  // one caller below), i.e. "the ladder cut at least one record to fit the
  // budget". Post-ready trim and prior-pack dedup set explicit provenance
  // before this funnel, while unannotated calls retain the historical
  // kind/body inference below.
  // Producer routes may know why a body was reduced or withheld before the
  // final envelope exists. Prefer that explicit provenance; retain the
  // historical kind/body inference for every unannotated call.
  const source = context.servedBytesSource
    ?? (kind === "read.receipt"
      ? "receipt"
      : trimmed
        ? "budget-shed"
        : carriesVerificationKit(text, kind)
          ? "verification-kit"
          : args?.["qref"] !== undefined
            ? "replay"
            : "fresh");
  const ledgerResult = recordServedBytes({
    workspaceRoot: workspace,
    epoch,
    lane,
    bytes: budget.used,
    digest: createHash("sha256").update(text, "utf8").digest("hex"),
    source,
    forceServe: args?.["force_serve"] === true,
  });
  context.servedBytesNovel = ledgerResult.novel;
}

/**
 * The `form` a payload discriminates on, for the three kinds whose budget row
 * is keyed by (kind, form). Read off the LIVE projection, at the address Rule K
 * assigned it — `outline.form`, `matches.form`, and A.4's `receipt` tag.
 *
 * `undefined` for every other kind, and for a payload whose discriminator is
 * missing or not a string: `budgetFor` then falls back to the family maximum,
 * which is the fail-OPEN direction and the correct one under §0.3.
 */
function formOf(payload: ShedPayload, kind: Kind): string | undefined {
  switch (kind) {
    case "read.map":
      return stringField(payload["outline"], "form");
    case "search.matches":
      return stringField(payload["matches"], "form");
    case "read.receipt":
      // A.4's tag is the field named `receipt` INSIDE the `receipt` block:
      // `{"kind":"read.receipt","receipt":{"receipt":"pack-unchanged",…}}`.
      return stringField(payload["receipt"], "receipt");
    default:
      return undefined;
  }
}

/** `record[field]` when `record` is a plain object and the field is a string. */
function stringField(record: unknown, field: string): string | undefined {
  if (record === null || typeof record !== "object" || Array.isArray(record)) return undefined;
  const value = (record as Record<string, unknown>)[field];
  return typeof value === "string" ? value : undefined;
}

/**
 * THE LADDER'S ACCEPTANCE GATE (plan §4.2), S1's stub now real.
 *
 * A rung proposes; this disposes. The candidate is judged against the SAME
 * required set the finished response is judged against, so a rung cannot buy
 * bytes by cutting something §4.3 requires — the C-wave failure mode, where a
 * ladder with no judge deleted the authority document's surface to close a
 * 1,465 B overage.
 *
 * The form is re-read off the CANDIDATE rather than reused from the pre-ladder
 * payload: no rung changes a discriminator today, and a rung that did would be
 * emitting a different member than the one the budget row was drawn for.
 *
 * A refused candidate is not a violation of anything — it never shipped — so it
 * is not recorded on the call context. Only `enforceRequiredSet` records.
 */
function validateShedCandidate(candidate: ShedPayload, kind: Kind): boolean {
  return validateProtocolBody(candidate, kind, formOf(candidate, kind)).ok;
}

/**
 * JUDGE THE PAYLOAD THAT SHIPS, and act on the verdict by environment.
 *
 * PRODUCTION RECORDS. A violation is written to the call context beside
 * `emittedBytes` and the response is emitted UNCHANGED. §0.3 makes P3a
 * byte-invisible; a validator that rewrote, truncated or converted a response
 * on its way out would be the exact class §4.2.1 forbids — a delivery mechanism
 * deciding what a result says — and it would do so on the strength of a table,
 * against a caller who is waiting for an answer. The honest terminations for a
 * response that cannot satisfy its member (§4.2's fail-closed refusal, §4.2.1's
 * SE-STABLE floor) are decisions for the PRODUCER, upstream of the funnel.
 *
 * TESTS THROW. `TL_DECISION_INVARIANT_STRICT=1` is set by both vitest configs
 * (`vitest.config.ts:27`, `packages/mcp-server/vitest.config.ts:40`) and by
 * nothing else, so every test run is a hard gate on this table while production
 * stays fail-open. That combination is what makes the 242-case replay corpus
 * and the fifteen §6.1(b) pins the validator's proving ground: they exercise
 * real bodies through this exact line, and a table that is wrong about any of
 * them fails a test rather than silently mislabelling the wire.
 *
 * The precedent is the house one — `editFamily.ts`'s projector wraps its work
 * in a try/catch and falls back rather than failing a response that already
 * happened. Non-side-effect kinds keep that fail-open posture with a test-only
 * hard edge. SIDE-EFFECT KINDS (wave-11 B4) carry a production edge as well: a
 * side-effect body that fails its required set cannot testify to what the
 * write did, so it is REPLACED by a structured refusal whose detail says the
 * workspace state is unverified (`emitSideEffectViolationRefusal`). It is a
 * refusal rather than a thrown error because a transport exception would strip
 * the caller of every protocol recovery affordance (`code`/`retry`/`detail`)
 * at the exact moment disk state is in doubt; and it is not budget conversion —
 * `failClosed`'s SE-STABLE rule ("ship the over-budget truth") still governs
 * SIZE, this edge governs MALFORMATION.
 */
function enforceRequiredSet(
  payload: ShedPayload,
  kind: Kind,
  context: ProtocolCallContext,
): FinalizableResult | undefined {
  const result = validateProtocolBody(payload, kind, formOf(payload, kind));
  if (result.ok) return undefined;

  const violation: ProtocolViolation = {
    kind: result.kind,
    ...(result.form === undefined ? {} : { form: result.form }),
    missing: result.missing,
    violated: result.violated,
  };
  recordProtocolViolation(context, violation);

  // MX-B group 1 (2026-09-14): every mode converts to a graceful refusal now
  // — never an opaque internal error (strict mode's old throw) and never a
  // silently-malformed payload (non-strict mode's old pass-through). See
  // `emitRequiredSetViolationRefusal`'s own doc comment.
  if (isSideEffectKind(kind)) return emitSideEffectViolationRefusal(kind, violation, context);
  return emitRequiredSetViolationRefusal(kind, violation, context);
}
