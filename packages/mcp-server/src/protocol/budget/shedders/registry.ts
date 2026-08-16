// ---------------------------------------------------------------------------
// protocol v1 — the shed-ladder INTERFACE and its shared step primitives
// (P3a S1 skeleton, filled by S3).
//
// NORMATIVE SOURCE: TL-PROTOCOL-V1-PHASE3A-PLAN-DRAFT.md §3 (module layout),
// §3.1 (the one interface every shedder implements), §4.3 (the ladder runner),
// §5 (per-kind ladders), §4.2.1(1)/§7 (SE-STABLE);
// DESIGN-v0.10-protocol-v1-contract-freeze.md §4.2.1, A.6.2;
// prep/C-phase3a-errata-dispositions.md E1/E3/E5.
//
// WHAT LIVES HERE, AFTER S3. The TYPES the thirteen shedder modules implement,
// plus the small set of PURE PAYLOAD PRIMITIVES every one of them needs (drop
// these keys, trim this array, rewrite this nested block). `./index.ts` holds
// the exhaustive `Record<Kind, Shedder>`; `../ladder.ts` holds the runner.
//
// WHY THE PRIMITIVES ARE HERE AND NOT IN A FOURTEENTH MODULE. Thirteen files
// each re-deriving "clone this object without breaking JSON key order" is
// thirteen chances to get key order wrong, and key order IS the wire (the
// fifteen §6.1(b) pins are byte-exact about it). One implementation, one place
// to audit.
//
// WHAT A STEP MAY NOT DO, stated once so no shedder re-litigates it:
//
//   1. IT MAY NOT MEASURE. There is exactly one response-level byte count in
//      this server (`../measure.ts`), taken by the runner. A step that
//      serialized its own candidate to decide how much to cut would be the
//      second measurement point S6's G8 fence exists to find, and would make
//      the `ShedRecord.bytes` ledger a second opinion rather than the truth.
//      Steps are therefore BUDGET-BLIND: they cut one class of content and the
//      runner decides whether that was enough.
//   2. IT MAY NOT MUTATE ITS INPUT. The runner rejects candidates (the S2
//      validator gate); a mutating step would leave nothing to reject.
//   3. IT MAY NOT MINT `prior` ON `Evidence` (E4 / R5 ruling 2). Receipt
//      convergence is an EMITTER decision, made where residency is known. A
//      rung-4 shed yields a body-less FRESH entry with `remaining` — honest —
//      never a residency claim the boundary cannot verify.
//   4. A RUNG-4/5/6 STEP MAY NOT SHED WITHOUT AN EXECUTABLE `next` (E5). It
//      returns `undefined` — declines — rather than produce a `wire` limit
//      with no continuation.
// ---------------------------------------------------------------------------

import type { Kind, ToolCall } from "@tokenlighten/types";

import type { ShedRung } from "../wireBudget.js";

/**
 * The payload the ladder passes between rungs.
 *
 * DELIBERATELY NOT `ProtocolResult`. Plan §3.1 types `ShedStep` against
 * `ProtocolResult`, and that is the right destination — but at this HEAD the
 * funnel's own payload is the POST-projection object literal
 * `{v, kind, ...projectSuccessBody(...)}`, which is structurally a
 * `ProtocolResult` and nominally a `Record<string, unknown>` (see
 * `../../envelope.ts`'s tail). Typing the ladder against `ProtocolResult` here
 * would force a cast at the one place that must not lie about its input.
 * S2's validator is what re-establishes the typed guarantee; the ladder stays
 * honest about handling an already-projected body.
 */
export type ShedPayload = Record<string, unknown>;

/**
 * What a step knows besides the payload.
 *
 * `args` is the INBOUND request, forwarded from `ProtocolCallContext.args` —
 * the same source the family projectors read for the same reason (§2.1.2,
 * class TC-2): a rendered body spells a `queries:["a","b"]` call as the single
 * string `"a OR b"`, and echoing that back as `query` would prescribe a
 * DIFFERENT search. A shedder that names a narrower search call must echo the
 * request, so it must be able to see it.
 *
 * Deliberately NOT the whole `ProtocolCallContext`: a step has no business
 * reading `emittedBytes` (rule 1 above) or writing anything at all.
 */
export type ShedContext = {
  readonly args?: Readonly<Record<string, unknown>>;
};

/**
 * What a step BOOKS about its own cut — everything except the byte count.
 *
 * `bytes` is absent BY CONSTRUCTION, not by omission: it is `before - after`
 * measured by the runner at the one sanctioned measurement point (rule 1
 * above). The runner completes this into a full `ShedRecord`.
 */
export type ShedNote = {
  /** The §5 rung NUMBER — the CLASS of content dropped, not the array index. */
  readonly rung: ShedRung;
  /**
   * The handles/paths/identifiers the drop was about, when the step can name
   * them. Absence means the drop is not localisable (rung-1 prose), never that
   * nothing was dropped.
   */
  readonly refs?: readonly string[];
};

/** One accepted step's proposal. */
export type ShedOutcome = {
  /** The candidate payload. A fresh object; the input is untouched. */
  readonly next: ShedPayload;
  /** What was cut, minus the bytes (the runner measures those). */
  readonly note: ShedNote;
  /**
   * The executable continuation this step's `wire` limit will name.
   *
   * REQUIRED on rungs 4/5/6 and FORBIDDEN in spirit on rungs 1/3 (E5: those
   * rungs withhold prose and rare extensions that no call returns, so they
   * emit no `limit` and have nothing to name). A rung-4/5/6 step that cannot
   * construct one returns `undefined` from the step instead — the runner
   * treats a limit-bearing outcome with no continuation as a defect, not as a
   * next-less `wire` limit.
   */
  readonly continuation?: ToolCall;
};

/**
 * One rung of one kind's ladder.
 *
 * Returns `undefined` when the rung is a NO-OP for this payload (nothing of
 * that class is present, or nothing honest can be said about cutting it) —
 * which the runner treats as "try the next rung", never as "the ladder is
 * exhausted". A step must be PURE: it returns the next payload rather than
 * mutating its input, so the runner can reject a candidate without having to
 * undo anything.
 *
 * A step may be invoked REPEATEDLY on one emission while it keeps yielding and
 * the payload is still over budget — that is what "drop whole `Evidence`
 * entries, lowest-`role`-priority first" (§5.1) and "`files[].snippets` ->
 * `files[].lines` tail -> whole entries" (§5.5) mean operationally, and it is
 * what keeps the cut MINIMAL (P8) without letting a step see the budget. See
 * `../ladder.ts` for the bound.
 */
export type ShedStep = (payload: ShedPayload, context: ShedContext) => ShedOutcome | undefined;

/** The one interface every shedder implements (plan §3.1). */
export type Shedder = {
  readonly kind: Kind;
  /**
   * Ordered rungs. The `rung` FIELD is the §5 rung NUMBER — the class of
   * content dropped — not the array position, so a kind that implements only
   * rungs 1 and 5 books them as 1 and 5, and a kind that implements rung 3 in
   * four ordered sub-steps books four entries all tagged `3`.
   */
  readonly rungs: ReadonlyArray<{ rung: ShedRung; step: ShedStep }>;
  /**
   * True iff this kind may be converted to a `refusal` when its floor will not
   * fit.
   *
   * FALSE for exactly the three SE-STABLE kinds (§4.2.1(1)): `edit.applied`,
   * `edit.rolled_back`, `edit.state_unknown` report a COMPLETED EFFECT on the
   * caller's files, and a refusal in their place asserts that nothing happened.
   * `edit.reclassified` is deliberately convertible — its own §2.4 row says
   * nothing was written.
   *
   * The funnel already enforces the same rule structurally (`envelope.ts`'s
   * `kind === "refusal" && !isSideEffectKind(kind)` guard). This field is the
   * SECOND expression of it, at the layer that does the converting.
   */
  readonly refusalConvertible: boolean;
};

// ---------------------------------------------------------------------------
// Shared payload primitives — pure, key-order preserving
// ---------------------------------------------------------------------------

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function recordAt(payload: ShedPayload, key: string): Record<string, unknown> | undefined {
  const value = payload[key];
  return isRecord(value) ? value : undefined;
}

export function arrayAt(payload: ShedPayload, key: string): unknown[] | undefined {
  const value = payload[key];
  return Array.isArray(value) ? value : undefined;
}

export function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * A copy of `source` without `keys`, plus the keys that were actually there.
 *
 * KEY ORDER IS PRESERVED for everything that survives, because a rebuilt object
 * literal in iteration order is what `JSON.stringify` walks and what the
 * §6.1(b) pins are exact about. `undefined`-valued keys count as absent: E-1
 * makes absence the spelling of "not carried", so a key that is present with
 * `undefined` was never on the wire and dropping it recovers nothing.
 */
export function withoutKeys(
  source: Record<string, unknown>,
  keys: readonly string[],
): { next: Record<string, unknown>; dropped: string[] } | undefined {
  const remove = new Set(keys);
  const dropped: string[] = [];
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (remove.has(key) && value !== undefined) {
      dropped.push(key);
      continue;
    }
    next[key] = value;
  }
  return dropped.length === 0 ? undefined : { next, dropped };
}

/**
 * `source` with `key` replaced by `value`, IN PLACE in the key order.
 *
 * A plain spread already does this for an existing key; the helper exists so
 * every shedder spells it the same way and so a new key lands at the end
 * deliberately rather than by accident.
 */
export function withKey(
  source: Record<string, unknown>,
  key: string,
  value: unknown,
): Record<string, unknown> {
  return { ...source, [key]: value };
}

/**
 * Rewrite one nested block of the payload, or `undefined` when the rewrite was
 * a no-op.
 *
 * The dominant shape in the read/search families is a member whose whole
 * content sits under one tagged key (`outline`, `matches`, `receipt`,
 * `content`), so most steps are "rewrite that block, keep the envelope".
 */
export function inBlock(
  payload: ShedPayload,
  key: string,
  rewrite: (block: Record<string, unknown>) => Record<string, unknown> | undefined,
): ShedPayload | undefined {
  const block = recordAt(payload, key);
  if (block === undefined) return undefined;
  const next = rewrite(block);
  return next === undefined ? undefined : withKey(payload, key, next);
}

/**
 * Drop `keys` from a top-level payload, booking a rung-1/3 note.
 *
 * The rung is a PARAMETER because the same mechanical cut is prose on one kind
 * and a rare extension on another — `detail` is rung 1 on a refusal and
 * `hop1` is rung 3 on `search.references`, and the class is what the A.6.2
 * mapping reads, not the shape of the deletion.
 */
export function dropTopLevel(
  payload: ShedPayload,
  keys: readonly string[],
  rung: ShedRung,
): ShedOutcome | undefined {
  const stripped = withoutKeys(payload, keys);
  if (stripped === undefined) return undefined;
  return { next: stripped.next, note: { rung, refs: stripped.dropped } };
}

/**
 * Drop the FIRST key of `ordered` that this payload actually carries.
 *
 * THE ORDER IS THE POLICY. A step that dropped a whole class at once would cut
 * more than the overage needs (the C-wave over-shoot); a step that drops one
 * key per invocation, re-invoked by the runner while the payload is still over
 * budget, cuts exactly as far down the list as the bytes require. So `ordered`
 * is read cheapest-loss-first, and each shedder documents its own ordering
 * argument beside the list rather than here.
 */
export function peelOrdered(
  payload: ShedPayload,
  ordered: readonly string[],
  rung: ShedRung,
): ShedOutcome | undefined {
  for (const key of ordered) {
    const outcome = dropTopLevel(payload, [key], rung);
    if (outcome !== undefined) return outcome;
  }
  return undefined;
}

/** As `dropTopLevel`, one level down, inside a tagged block. */
export function dropInBlock(
  payload: ShedPayload,
  block: string,
  keys: readonly string[],
  rung: ShedRung,
): ShedOutcome | undefined {
  const held = recordAt(payload, block);
  if (held === undefined) return undefined;
  const stripped = withoutKeys(held, keys);
  if (stripped === undefined) return undefined;
  return {
    next: withKey(payload, block, stripped.next),
    note: { rung, refs: stripped.dropped.map((key) => `${block}.${key}`) },
  };
}

/**
 * Drop the LAST entry of `array`, refusing to go below `floor`.
 *
 * Trailing rather than arbitrary: every list this server emits is ordered by
 * the producer's own relevance or file order, so the tail is the least
 * load-bearing end, and a caller that re-issues a narrower call gets the tail
 * back in the same order. Returns `undefined` at the floor — the step then
 * declines and the ladder moves on, which is how a per-form floor (§5.3) is
 * enforced without a second table.
 */
export function dropTrailingEntry(
  entries: readonly unknown[],
  floor: number,
): { next: unknown[]; dropped: unknown } | undefined {
  if (entries.length <= floor) return undefined;
  const next = entries.slice(0, entries.length - 1);
  return { next, dropped: entries[entries.length - 1] };
}
