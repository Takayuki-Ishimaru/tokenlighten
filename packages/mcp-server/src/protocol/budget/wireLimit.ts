// ---------------------------------------------------------------------------
// protocol v1 — `ShedRecord[]` -> the wire-visible `Limit` (P3a S3).
//
// NORMATIVE SOURCE: DESIGN-v0.10-protocol-v1-contract-freeze.md A.6.2 (the
// rung -> `OmittedClass` mapping), A.8.1 rules E-4/E-5 ([R5-9], the five
// causes), A.13 ruling 1; prep/C-phase3a-errata-dispositions.md E3 (the
// five-clause merge procedure, ratified upstream as R5 ruling 1) and E5 (which
// rungs may emit a `limit` at all); TL-PROTOCOL-V1-PHASE3A-PLAN-DRAFT.md §5.7.
//
// ------------------------------ THE FILE NAME -------------------------------
//
// Plan §3's module layout calls this `budget/limitFrom.ts`. That name COLLIDES
// with `readFamily.ts`'s existing `limitFrom` — a different function, a
// different signature, a different module — and `prep/C-phase3a-reconciliation.md`
// row 11 flagged the collision before either landed. Renamed to `wireLimit.ts`
// by orchestrator decision; the collision is the only reason.
//
// ---------------------------- WHAT IT DECIDES -------------------------------
//
// A response can acquire a `limit` from TWO independent places: the EMITTER,
// which knows its own caps ran out of content or records (`readFamily.ts`'s
// `limitFrom`, `searchFamily.ts`'s `foldLimit`), and the BOUNDARY, which knows
// the response would not fit the wire budget. A.8.1 E-4 allows exactly one
// `limit` per response, so the two must be merged rather than concatenated, and
// the merge must never turn a true statement into a false one.
//
// THE DECIDING CONSTRAINT is cursor survival: `search.references` pages through
// `limit.next.arguments.cursor`, so a boundary that overwrote the emitter's
// `next` would delete the only mechanism that advances the page — the
// "more pages exist with no call to get them" half-mechanism the design
// deletes. Hence clause 4: where the emitter's cause already carries a `next`,
// the emitter's cause AND `next` both stand, and the boundary discloses its
// additional cut through the `omitted` union alone.
// ---------------------------------------------------------------------------

import type { Limit, OmittedClass, ToolCall } from "@tokenlighten/types";

import type { ShedRecord, ShedRung } from "./wireBudget.js";

// ---------------------------------------------------------------------------
// A.6.2 — the rung -> `OmittedClass` mapping
// ---------------------------------------------------------------------------

/**
 * A.6.2's mapping table, as code.
 *
 * Rung 2 is RESERVED-EMPTY and maps to nothing: no shedder may emit
 * `ShedRecord{rung:2}`, and `ladder.ts` asserts it rather than trusting it.
 * Rung 6 is erratum E1's net-new value — A.6.2's own table carried a `results`
 * row with no rung to book it against, which made every `search.*` shed
 * unrecordable.
 */
export const RUNG_OMITTED_CLASS: Readonly<Record<ShedRung, OmittedClass | undefined>> = {
  1: "metadata",
  2: undefined,
  3: "metadata",
  4: "evidence",
  5: "evidence",
  6: "results",
};

/**
 * The rungs that may produce a `limit` at all (erratum E5).
 *
 * Rungs 1 and 3 withhold decorative prose and rare extensions — content NO
 * CALL RETURNS — so no `next` can be named for them, and A.8.1 E-5 requires a
 * `wire` limit to carry one. A.8.1 E-7 supplies the justification for the
 * silence: prose absence "never means 'this did not happen' — only 'this was
 * not worth the bytes'", and is explicitly "documented, not assertable". Rung 3
 * inherits that reading.
 */
export const LIMIT_BEARING_RUNGS: ReadonlySet<ShedRung> = new Set<ShedRung>([4, 5, 6]);

/** True iff these records include a rung whose cut must be disclosed as a `limit`. */
export function boundaryLimitBearing(records: readonly ShedRecord[]): boolean {
  return records.some((record) => LIMIT_BEARING_RUNGS.has(record.rung));
}

/**
 * `OmittedClass[]` for a set of shed records, in E3's stable order.
 *
 * TWO DECISIONS WORTH STATING, because both are readings of E3 rather than
 * transcriptions of it:
 *
 *  1. EVERY ACCEPTED RECORD CONTRIBUTES, not only the limit-bearing ones. E3
 *     clause 3 says `omitted` comes "from the A.6.2 mapping", and the mapping
 *     is defined for rungs 1 and 3 too (`metadata`). So once a `limit` exists
 *     at all, it discloses everything this response shed — including the prose.
 *     The E5 silence is about whether a `limit` EXISTS, not about lying inside
 *     one that does: a response that shed prose and evidence and disclosed only
 *     the evidence would be a smaller true statement than the one available.
 *  2. ORDER IS `metadata < evidence < results`, fixed by E3 clause 4, not by
 *     insertion. Two responses that shed the same classes in a different rung
 *     order must serialize identically.
 */
export function omittedFromRecords(records: readonly ShedRecord[]): OmittedClass[] {
  const seen = new Set<OmittedClass>();
  for (const record of records) {
    const omitted = RUNG_OMITTED_CLASS[record.rung];
    if (omitted !== undefined) seen.add(omitted);
  }
  return orderOmitted(seen);
}

/** E3 clause 4's stable order, applied to any set of classes. */
function orderOmitted(classes: ReadonlySet<OmittedClass>): OmittedClass[] {
  const order: readonly OmittedClass[] = ["metadata", "evidence", "results"];
  return order.filter((entry) => classes.has(entry));
}

/** The `omitted` an already-emitted `limit` carries, as a set. */
function omittedOf(limit: Record<string, unknown>): Set<OmittedClass> {
  const value = limit["omitted"];
  const found = new Set<OmittedClass>();
  if (!Array.isArray(value)) return found;
  for (const entry of value) {
    if (entry === "metadata" || entry === "evidence" || entry === "results") found.add(entry);
  }
  return found;
}

/** Rebuild a `Limit` in one canonical key order, so two equal limits serialize equally. */
function limitOf(cause: string, omitted: readonly OmittedClass[], next: ToolCall | undefined): Limit {
  return {
    cause,
    ...(omitted.length > 0 ? { omitted: [...omitted] } : {}),
    ...(next !== undefined ? { next } : {}),
  } as Limit;
}

// ---------------------------------------------------------------------------
// E3 — the five-clause merge
// ---------------------------------------------------------------------------

/**
 * What the ladder should do with the payload's `limit` key.
 *
 * `undefined` means DO NOT TOUCH THE PAYLOAD — which is the byte-identity
 * guarantee clause 2 rests on, expressed as the absence of an edit rather than
 * as an edit that happens to reproduce the same bytes.
 */
export type WireLimitDecision = { readonly limit: Limit } | undefined;

/**
 * E3's five-clause procedure, verbatim, in order.
 *
 * The clause numbers below are `prep/C-phase3a-errata-dispositions.md` E3's
 * own; each is implemented at exactly one `return`.
 *
 * @param emitterLimit the `limit` the projector already attached, if any —
 *   passed as the raw payload value rather than as a typed `Limit`, because at
 *   the funnel the payload is a projected object literal and a cast here would
 *   be a claim this function is not entitled to make.
 * @param records every rung the ladder accepted, in ladder order.
 * @param continuation the executable call the last limit-bearing rung named.
 */
export function mergeWireLimit(
  emitterLimit: unknown,
  records: readonly ShedRecord[],
  continuation: ToolCall | undefined,
): WireLimitDecision {
  // CLAUSE 2 — the boundary shed nothing limit-bearing, so the emitter's
  // `limit` passes through BYTE-IDENTICALLY. This is the only path reachable at
  // default budgets (§0.3's calibration invariant) and therefore the one every
  // committed wire-baseline pin exercises. It is also the path a
  // prose-only shed (rungs 1/3, E5) takes: those rungs record, and say nothing.
  if (!boundaryLimitBearing(records)) return undefined;

  const boundary = omittedFromRecords(records);
  const existing = isLimitRecord(emitterLimit) ? emitterLimit : undefined;

  // CLAUSE 3 — the boundary shed at rung 4/5/6 and there is no emitter `limit`.
  if (existing === undefined) {
    // E5's corollary: a step with no constructible `next` declines BEFORE it
    // gets here (`ladder.ts` refuses the outcome). Reaching this branch with no
    // continuation would mean emitting a `wire` limit without one, which A.8.1
    // E-5 forbids — so the honest fallback is to say nothing, exactly as
    // clause 2 does. The response is smaller than it was and discloses no
    // limit, which understates rather than misstates.
    if (continuation === undefined) return undefined;
    return { limit: limitOf("wire", boundary, continuation) };
  }

  const cause = typeof existing["cause"] === "string" ? existing["cause"] : "";
  const union = orderOmitted(new Set([...omittedOf(existing), ...boundary]));
  const emitterNext = existing["next"] as ToolCall | undefined;

  // CLAUSE 4 — both exist and the emitter's cause already carries a `next`.
  // KEEP THE EMITTER'S CAUSE AND ITS `next`: `search.references`' paging cursor
  // rides inside `next.arguments.cursor` and is never displaced. The boundary's
  // additional cut is disclosed through the union alone.
  //
  // `time` joins this arm WHEN IT CARRIES A `next` (its `next` is optional,
  // A.8.1 E-5). E3 does not name `time` because it is unreachable at HEAD
  // (F-8); the rule that decides the other four decides it too — a cause whose
  // continuation exists keeps it.
  if (cause === "wire" || cause === "records" || (cause === "time" && emitterNext !== undefined)) {
    return { limit: limitOf(cause, union, emitterNext) };
  }

  // CLAUSE 5 — both exist and the emitter's cause is a NEXT-LESS arm
  // (`source`, `capped`, or a `next`-less `time`). The merged limit is
  // `{cause:"wire", omitted: union, next: boundary-constructed}`.
  //
  // HONESTY ARGUMENT (E3's own): the client re-fetches the shed window, and the
  // terminal source/capped condition RESURFACES on that recovery call's own
  // `limit`. No information is erased, and no next-less cause ever carries a
  // `next`.
  if (continuation !== undefined) return { limit: limitOf("wire", union, continuation) };

  // The residual of clause 5: the boundary cut something and cannot name a
  // recovery, and the emitter's cause forbids `next`. Promoting to `wire` would
  // produce the one shape E-5 rules out; keeping the next-less arm and widening
  // `omitted` states strictly more than the emitter did and nothing false.
  return { limit: limitOf(cause === "" ? "capped" : cause, union, undefined) };
}

/** A payload value that is shaped like an already-attached `Limit`. */
function isLimitRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
