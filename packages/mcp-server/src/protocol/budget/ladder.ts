// ---------------------------------------------------------------------------
// protocol v1 — THE MEASURE-DRIVEN LADDER RUNNER (P3a S3).
//
// NORMATIVE SOURCE: TL-PROTOCOL-V1-PHASE3A-PLAN-DRAFT.md §4.3 (the runner, and
// the C-wave lesson made mechanical), §5 (per-kind ladders), §5.7 (which rungs
// may emit a `limit`), §6 (the act floor, landed in `budget/actFloor.ts`);
// DESIGN-v0.10-protocol-v1-contract-freeze.md §4.2, §4.2.1, A.6.2;
// prep/C-phase3a-errata-dispositions.md E1/E3/E5.
//
// ---------------------------- WHY A LOOP AT ALL -----------------------------
//
// The design's stated pipeline is `typed result -> kind-shedder ->
// kind-validator -> measure -> serialize`. Implemented honestly — measurement
// must be POST-serialization to be true — that is a loop, and the loop's shape
// is where the C-wave incident (`d7150ec3`, 2026-08-09: "removed 3,158 B to
// close a 1,465 B overage, ran to its last rung, and deleted the authority
// doc's surface entirely… while leaving 1.7 KB of budget unused") is prevented.
//
// THREE PROPERTIES, each asserted in `__tests__/wireLadder.spec.ts`:
//
//   NO OVER-SHOOT.  The budget is checked BEFORE every step, so the ladder
//       stops at the first cut that fits. Removing the last `ShedRecord` would
//       have left the payload over budget — the P8 negative.
//   NO UNDER-SHOOT INTO FALSITY.  The S2 validator runs AFTER the shedder and
//       BEFORE the rung is accepted, so a step that would break the member's
//       required set is REFUSED rather than applied. That is the step the
//       C-wave ladder lacked.
//   NO SHEAR WHERE SHEARING LIES.  The three SE-STABLE kinds have zero rungs
//       (ruling 7), so this loop is a no-op on them by construction rather than
//       by a special case.
//   NO FALSIFIED ACT.  §2.1.1's floor (`budget/actFloor.ts`) runs between the
//       shedder and the validator, so a cut that empties the evidence out from
//       under an `act.answer` DEMOTES the decision to `discover` with the
//       concrete restoring calls, rather than shipping an act the response can
//       no longer support. At most once per emission — P13.
//
// ------------------- ONE DEVIATION FROM §4.3's PSEUDOCODE -------------------
//
// §4.3 writes the loop as `for rung in shedder(kind).rungs`, one call per rung.
// This runner calls a rung REPEATEDLY while it keeps yielding and the payload
// is still over budget. That is not a liberty: §5.1's rung 5 is "drop whole
// `Evidence` entries, LOWEST-`role`-PRIORITY FIRST" and §5.5's rung 6 is
// "`files[].snippets` -> `files[].lines` tail -> WHOLE `files[]` ENTRIES" —
// both describe an incremental cut whose stopping point is the budget, and a
// step may not see the budget (it may not measure; see `shedders/registry.ts`).
// One call per rung would therefore have to cut ALL of a class at once, which
// is precisely the over-shoot the C-wave produced. Re-invoking preserves every
// property above — the budget is still checked before each step, the validator
// still gates each candidate, each step is still booked as its own
// `ShedRecord` — and makes the cut minimal at the granularity the step chose.
//
// The cost note in §4.3 ("worst case 6 serializations") becomes "worst case
// `MAX_SHED_STEPS + 1`", bounded below.
//
// ------------------ AND ONE MORE: `attachWireLimit` MOVES IN ----------------
//
// §4.3 attaches the `limit` AFTER the loop (`attachWireLimit(result, records)`)
// and never re-measures. A `limit` is not free — a cause, an `omitted` array
// and a whole `next` call — so a ladder that measured the shed body alone would
// declare a fit the mandatory disclosure then broke, and would hand the caller
// a response that has to be discarded and refused after every rung succeeded.
// Here the merge is folded INTO the measured candidate: each step is judged and
// measured as the object that would actually ship. Two consequences worth
// naming, both of them the point:
//
//   - a step whose disclosure costs more than its cut saves is REFUSED, because
//     it did not make the response smaller;
//   - `ShedRecord.bytes` is the NET recovery of that step, disclosure included,
//     so the records sum exactly to the delta between the response that was and
//     the response that ships.
//
// With no records the merge returns "do not touch" and the payload is passed
// through BY IDENTITY, which is what makes §0.3's byte-invisibility structural
// rather than arithmetic.
// ---------------------------------------------------------------------------

import type { Kind, ToolCall } from "@tokenlighten/types";

import { MAX_DEMOTIONS_PER_EMISSION, actFloorHolds, demoteToDiscover } from "./actFloor.js";
import { measureResponseBytes } from "./measure.js";
import { LIMIT_BEARING_RUNGS, mergeWireLimit } from "./wireLimit.js";
import type { ShedRecord } from "./wireBudget.js";
import { shedderFor } from "./shedders/index.js";
import type { ShedContext, ShedPayload } from "./shedders/registry.js";

/**
 * The accepted-step ceiling for one emission.
 *
 * TERMINATION, NOT TUNING. Every step this repo ships shrinks the payload or
 * declines, and the runner independently refuses a candidate that did not
 * shrink — so the loop terminates on content alone. This bound exists so a
 * future step with a bug that keeps yielding without progress costs a bounded
 * number of serializations instead of hanging the call, and so §4.3's cost
 * claim has a number to be checked against. 64 is far above any reachable
 * ladder: the widest kind (`read.task_pack`) registers 9 rungs, and the
 * incremental ones cut one array entry per step.
 */
export const MAX_SHED_STEPS = 64;

/**
 * The shed history, published on the per-call context.
 *
 * Declared HERE rather than in `envelope.ts`, by ownership — the same rule
 * `budget/validate.ts` follows for `protocolViolations`. `emittedBytes` is the
 * funnel's measurement, `protocolViolations` is the validator's finding, and
 * this is the ladder's account of what it cut to get there; all three ride the
 * one per-call `AsyncLocalStorage` slot, so a reader of "what did this call
 * emit, was it well formed, and what did it cost" has one object to read and
 * two concurrent calls cannot cross-contaminate.
 *
 * NON-WIRE, WITHOUT EXCEPTION. A.6.2 declares `ShedRecord` internal and nothing
 * copies it into a payload — the wire-visible derivative is the `Limit`
 * `wireLimit.ts` builds, and nothing else.
 *
 * PRESENT ON EVERY LADDER-BEARING EMISSION, INCLUDING AN EMPTY ONE. `[]` means
 * "the ladder ran and shed nothing", which at default budgets is every
 * response; ABSENCE means the ladder never ran at all, which only
 * `emitOpaqueText`'s kind-less path produces and which records no budget row
 * either. The distinction is the useful one for a fence spec, so it is the one
 * encoded.
 */
declare module "../envelope.js" {
  interface ProtocolCallContext {
    shedRecords?: ShedRecord[];
  }
}

export type LadderOutcome = {
  /** The payload that should ship, `limit` already merged (E3). */
  readonly payload: ShedPayload;
  /** Its serialization — the exact string the caller must return, never re-stringified. */
  readonly text: string;
  /** Its measured body bytes, at the one sanctioned measurement point. */
  readonly used: number;
  /**
   * Every accepted rung, in ladder order. MUTABLE by declaration so it can be
   * published on the call context without a cast; nothing mutates it after the
   * loop.
   */
  readonly records: ShedRecord[];
  /** The continuation the last limit-bearing rung named, if any. */
  readonly continuation?: ToolCall;
};

/**
 * §4.3's ladder, run once for one emission.
 *
 * PURE with respect to its input: `payload` is never mutated, and a refused
 * candidate is discarded whole.
 *
 * @param validate the S2 required-set gate, already bound to `kind` and to the
 *   form-reading the budget row used. Passed in rather than imported so this
 *   module has exactly one judge and `emit.ts` keeps owning the `formOf`
 *   reading — the alternative duplicates a discriminator, which is the drift
 *   the two-expression rule elsewhere in this tree exists to prevent.
 */
export function runLadder(input: {
  payload: ShedPayload;
  kind: Kind;
  budget: number;
  context: ShedContext;
  validate: (candidate: ShedPayload) => boolean;
}): LadderOutcome {
  const { payload, kind, budget, context, validate } = input;

  const records: ShedRecord[] = [];
  let continuation: ToolCall | undefined;

  // `shed` is what the rungs cut; `published` is that PLUS the E3-merged
  // `limit` — the object that would actually go on the wire if the ladder
  // stopped here, and therefore the only one worth measuring.
  //
  // MEASURING THE PUBLISHED FORM IS THE POINT. A `limit` costs bytes (a cause,
  // an `omitted` array and a whole `next` call), and a ladder that measured the
  // shed payload alone would declare a fit that the mandatory disclosure then
  // broke — and would hand `emit.ts` a response that has to be thrown away and
  // refused after all the shedding succeeded. Measuring `published` makes the
  // disclosure part of what the ladder is shedding TO FIT, which is the honest
  // accounting: the caller is charged for the recovery call it is being given.
  let shed = payload;
  let published = publish(shed, records, continuation);
  let text = JSON.stringify(published);
  let used = measureResponseBytes(text);
  let steps = 0;
  // Plan §6 constraint 3, counted rather than assumed. See the throw below.
  let demotions = 0;

  ladder: for (const rung of shedderFor(kind).rungs) {
    for (;;) {
      // STOP AT THE FIRST FIT — checked before each step, so a payload that
      // already fits runs no step at all and a payload that has just come under
      // budget stops immediately. This is the no-over-shoot property.
      if (used <= budget) break ladder;
      if (steps >= MAX_SHED_STEPS) break ladder;

      const stepped = rung.step(shed, context);
      // A no-op step ("nothing of that class is left", or "nothing honest can
      // be said about cutting it") means TRY THE NEXT RUNG, never "the ladder
      // is exhausted".
      if (stepped === undefined) break;

      // RUNG 2 IS RESERVED-EMPTY (A.6.2 / plan §5). Asserted rather than
      // trusted: the slot exists only to keep §5's numbering aligned with
      // A.6.2's, and a record booked against it would give the A.6.2 mapping a
      // rung with no `OmittedClass` to report.
      if (stepped.note.rung === 2) {
        throw new Error(`shed ladder for ${kind} emitted a reserved rung-2 record`);
      }

      // E5's corollary, enforced at the runner rather than trusted per step: a
      // rung-4/5/6 cut that names no executable continuation is REFUSED, so a
      // `wire` limit without `next` (A.8.1 E-5) is unconstructible here.
      if (LIMIT_BEARING_RUNGS.has(stepped.note.rung) && stepped.continuation === undefined) break;

      // The candidate as it would SHIP: shed plus the limit this step's record
      // makes the response owe (E3/E5). Everything below judges this object,
      // not the bare cut.
      const candidateRecords = [...records, { rung: stepped.note.rung, bytes: 0 }];
      const candidateContinuation = stepped.continuation ?? continuation;
      let candidateShed = stepped.next;
      let candidate = publish(candidateShed, candidateRecords, candidateContinuation);

      // §2.1.1's ACT FLOOR (S5, `budget/actFloor.ts`). The plan puts the check
      // HERE — after the candidate exists, before it is accepted — so a shed
      // that drops an `act` decision below its delivery floor is DEMOTED to
      // `discover` rather than shipped as a floor-violating act.
      //
      // THE DEMOTION IS TAKEN AGAINST THE SHED BODY, not the published one, so
      // the E3 `limit` is re-merged afterwards over the rewritten decision and
      // the response that gets measured is again the one that would ship.
      let demotedThisStep = false;
      if (!actFloorHolds(candidate, kind)) {
        // Plan §6 constraint 3 (P13). Structurally unreachable — after a
        // demotion the decision is `discover` and no floor applies to it — so
        // reaching this is a defect in the floor predicate or in a shedder that
        // re-introduced an `act` decision, and a wrong response is worse than a
        // failed call.
        if (demotions >= MAX_DEMOTIONS_PER_EMISSION) {
          throw new Error(
            `shed ladder for ${kind} attempted demotion ${demotions + 1} in one emission`,
          );
        }
        const demoted = demoteToDiscover(candidateShed, payload);
        // No honest demotion exists (no restoring call can be named). Refusing
        // the rung and shipping the last true payload is the only remaining
        // option: `discover` without a `next` is unrepresentable, and the act
        // may not ship shorn.
        if (demoted === undefined) break ladder;
        candidateShed = demoted;
        candidate = publish(candidateShed, candidateRecords, candidateContinuation);
        demotions += 1;
        demotedThisStep = true;
      }

      // THE VALIDATOR RUNS AFTER THE SHEDDER AND BEFORE ACCEPTANCE (§4.2). A
      // candidate that breaks the required set stops the LADDER, not just this
      // rung: a later rung cuts more, and cutting more cannot repair a set the
      // current cut already broke.
      if (!validate(candidate)) break ladder;

      const candidateText = JSON.stringify(candidate);
      const candidateUsed = measureResponseBytes(candidateText);
      // A step that recovered nothing is not progress, whatever it claims —
      // and on the FIRST limit-bearing rung "nothing" includes the case where
      // the disclosure costs more than the cut saved. Refusing it here is what
      // makes `ShedRecord.bytes` a MEASUREMENT rather than an assertion, and
      // what makes the loop terminate on content.
      //
      // EXCEPT AFTER A DEMOTION (plan §6 constraint 2). A `discover.next` array
      // of N `ToolCall`s can cost more than the `act` discriminator it replaced,
      // so a demoted candidate may legitimately be BIGGER. It is still accepted:
      // the alternative is shipping a decision the response cannot support, and
      // F4 ranks a true large response above a false small one. The ladder then
      // re-measures (below) and continues from the current rung — it does not
      // re-demote, and constraint 3 above is what makes that a fact.
      if (!demotedThisStep && candidateUsed >= used) break;

      records.push({
        rung: stepped.note.rung,
        // NET, DEMOTION INCLUDED — and therefore possibly <= 0 on the one step
        // that demoted. `ShedRecord.bytes` is defined as "the delta between the
        // response that was and the response that ships", and a demotion is
        // part of what shipped; booking the gross cut instead would make the
        // records stop summing to the real delta, which is the one property the
        // ledger has.
        bytes: used - candidateUsed,
        ...(stepped.note.refs !== undefined && stepped.note.refs.length > 0
          ? { refs: [...stepped.note.refs] }
          : {}),
      });
      if (stepped.continuation !== undefined) {
        // LAST LIMIT-BEARING RUNG WINS. Each step computes its continuation
        // against the payload it just produced, so the most recent one is the
        // only one guaranteed to describe the response that actually ships.
        continuation = stepped.continuation;
      }
      shed = candidateShed;
      published = candidate;
      text = candidateText;
      used = candidateUsed;
      steps += 1;
    }
  }

  return {
    payload: published,
    text,
    used,
    records,
    ...(continuation !== undefined ? { continuation } : {}),
  };
}

/**
 * The payload as it would ship: the shed body with E3's merged `limit`.
 *
 * `mergeWireLimit` returning `undefined` means DO NOT TOUCH — which is how
 * clause 2's byte-identity guarantee is expressed: not as an edit that
 * reproduces the same bytes, but as the absence of an edit. With no records at
 * all it is always `undefined`, so a response that sheds nothing is returned by
 * IDENTITY and the §0.3 invariant is structural rather than arithmetic.
 */
function publish(
  shed: ShedPayload,
  records: readonly ShedRecord[],
  continuation: ToolCall | undefined,
): ShedPayload {
  const decision = mergeWireLimit(shed["limit"], records, continuation);
  return decision === undefined ? shed : { ...shed, limit: decision.limit };
}
