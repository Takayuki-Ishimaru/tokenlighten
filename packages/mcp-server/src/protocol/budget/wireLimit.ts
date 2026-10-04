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

import type { Kind, Limit, OmittedClass, ToolCall } from "@tokenlighten/types";

import { emittableToolCall } from "../refusal.js";
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

// ---------------------------------------------------------------------------
// R-A3 (v0.14.4 candidate, 2026-09-21) — `read.batch` ONLY: union two
// continuations instead of letting one displace the other.
//
// THE DEFECT, CONFIRMED (instrumented `mergeWireLimit` calls, both a direct
// `runLadder` unit call and the real spawned server, default config,
// `readBatchDropRecoveryCompleteness.spec.ts`'s "three handles, a ceiling
// only the first fits under" case). A `read.batch` ladder run that narrows
// TWO ranged entries together via rung 4 (`readBatch.ts`'s
// `truncateRangedEntries` sweeps every eligible entry in one step) and then
// drops ONE of them via rung 6 once both have hit their one-line floor
// produces, across the run, TWO DIFFERENT continuations that each name a
// DIFFERENT window of the SAME response: rung 4's last accepted pass named
// BOTH entries (each entry's own remainder), and rung 6's drop names only the
// ONE it removed (its own FULL original window, `unservedRangeFor`). Neither
// this file's own clause logic nor `ladder.ts`'s "LAST LIMIT-BEARING RUNG
// WINS" bookkeeping combines them — the ladder's own tracked `continuation`
// is a single slot, overwritten by whichever step was accepted most
// recently, so rung 6's drop discards rung 4's own multi-entry continuation
// outright. The entry rung 6 did NOT drop keeps its own remainder reachable
// through `entries[i].next` (A.5.4's "handle" form field, compatibility) —
// but not through `limit.next`, the ONE call the shipped guide teaches a
// caller to run verbatim, and the ONLY one a caller resuming a chain from a
// PRIOR hop's own `limit.next` (rather than the original request) ever
// re-examines `entries[]` for.
//
// THE FIX IS SCOPED TO `read.batch` ALONE, BY `kind`, AT TWO SEATS:
// `ladder.ts`'s own per-step bookkeeping folds every accepted read.batch
// step's continuation into a running UNION (`unionBatchContinuations` below)
// instead of overwriting it, and clause 4 below unions a PRE-EXISTING
// EMITTER `next` (a construction-time drop, server.ts's A7 `handles=[]`
// loop) with that running boundary union rather than letting the emitter's
// own `next` displace it outright. Every OTHER kind is untouched — `kind`
// degrades every branch below to exactly what it did before this fix,
// byte-identical — because this file's own header explains why clause 4 must
// never let a boundary cut displace an emitter's `next` in the GENERAL case
// (`search.references`' paging cursor rides inside it, and overwriting it
// would delete the only mechanism that advances the page); `read.batch` is
// the one member whose `entries[]` can carry SEVERAL independently
// undelivered windows in the SAME response, so it alone needs the two
// unioned rather than one standing in for both.
// ---------------------------------------------------------------------------

/** Structurally a plain, non-array object — the shape a `tl_read_file` `arguments` value and every `targets[]` entry takes. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Every window a `tl_read_file` continuation addresses, as `targets[]`-shaped
 * descriptors — regardless of which shape this tree's own continuation
 * producers use: the canonical `{targets:[...]}` array (`readBatch.ts`'s
 * `truncateRangedEntries`, `readFamily.ts`'s `deriveNext` ranged-omission
 * bundle), the legacy whole-file `{mode:"full", paths:[...]}`
 * (`deriveNext`'s whole-file bucket, `readBatch.ts`'s `shedBatchEntry` for a
 * range-less entry), or a bare `{handle|path, range?}` with no wrapper at all
 * (`shedBatchEntry`'s own single-entry recovery BEFORE `canonicalToolCall`
 * re-wraps it — `protocol/envelope.ts`'s `canonicalReadTargets` "direct"
 * branch always performs that wrap, so every continuation this server
 * actually emits reaches this function already `targets[]`-shaped in
 * practice; the bare form is handled anyway so this function does not depend
 * on that ordering).
 *
 * `undefined` means "not a tl_read_file addressing shape this function
 * recognises" — every caller below treats that as "cannot safely union",
 * never as "addresses nothing".
 */
function extractReadFileTargets(call: ToolCall): Array<Record<string, unknown>> | undefined {
  if (call.tool !== "tl_read_file" || !isPlainRecord(call.arguments)) return undefined;
  const args = call.arguments;
  const rawTargets = args["targets"];
  if (Array.isArray(rawTargets)) {
    // A manual loop, not `.filter(isPlainRecord)`: `Array<JsonValue>.filter`'s
    // narrowing overload requires the predicate's `S` to extend `JsonValue`,
    // and `Record<string, unknown>` does not (its values are `unknown`, wider
    // than `JsonValue`) — so `.filter` would fall back to its non-narrowing
    // overload and still return `JsonValue[]`.
    const targets: Record<string, unknown>[] = [];
    for (const entry of rawTargets) {
      if (!isPlainRecord(entry)) return undefined;
      targets.push(entry);
    }
    return targets;
  }
  const rawPaths = args["paths"];
  if (args["mode"] === "full" && Array.isArray(rawPaths)) {
    return rawPaths.every((p): p is string => typeof p === "string") ? rawPaths.map((path) => ({ path })) : undefined;
  }
  const path = typeof args["path"] === "string" && args["path"] !== "" ? args["path"] : undefined;
  const handle = typeof args["handle"] === "string" && args["handle"] !== "" ? args["handle"] : undefined;
  if (path === undefined && handle === undefined) return undefined;
  const bare: Record<string, unknown> = {};
  if (path !== undefined) bare["path"] = path;
  if (handle !== undefined) bare["handle"] = handle;
  if (typeof args["range"] === "string") bare["range"] = args["range"];
  if (Array.isArray(args["ranges"])) bare["ranges"] = args["ranges"];
  if (typeof args["symbol"] === "string") bare["symbol"] = args["symbol"];
  return [bare];
}

/** `targets[]` de-duplication key: by `handle` first (the more specific address this tree mints), else `path`. */
function targetDescriptorKey(target: Record<string, unknown>): string {
  if (typeof target["handle"] === "string") return `h:${target["handle"]}`;
  if (typeof target["path"] === "string") return `p:${target["path"]}`;
  return `?:${JSON.stringify(target)}`;
}

/**
 * `previous`'s own descriptors first (chronologically earlier), then
 * `incoming`'s — and on a shared key (the SAME entry named by both),
 * `incoming` OVERWRITES `previous`'s value: `incoming` was computed against
 * the more recent payload state, so it is the one that still describes what
 * the response actually ships (`previous` may be several rung-4 passes
 * stale).
 */
function mergeTargetDescriptors(
  previous: readonly Record<string, unknown>[],
  incoming: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  const order: string[] = [];
  const byKey = new Map<string, Record<string, unknown>>();
  for (const target of previous) {
    const key = targetDescriptorKey(target);
    if (!byKey.has(key)) order.push(key);
    byKey.set(key, target);
  }
  for (const target of incoming) {
    const key = targetDescriptorKey(target);
    if (!byKey.has(key)) order.push(key);
    byKey.set(key, target);
  }
  return order.map((key) => byKey.get(key)!);
}

/** `true` iff this continuation demanded the range-content-full contract (TL-05's own marker echo, `readBatch.ts`). */
function requestsContentFull(call: ToolCall): boolean {
  return isPlainRecord(call.arguments) && call.arguments["content"] === "full";
}

/**
 * Union two `read.batch` continuations into ONE that names every window
 * either one named — see this section's own banner for the defect this
 * closes and why it is safe to scope to `read.batch` alone.
 *
 * `previous` is whichever continuation was already on record (an earlier
 * accepted ladder step, or a pre-existing emitter `limit.next` from a
 * construction-time drop); `incoming` is the new one. Extraction failure on
 * EITHER side — a shape this function does not recognise — falls back to
 * `incoming` alone: today's "last one wins" behaviour for exactly the inputs
 * this function cannot safely reason about, never a silent no-op. A
 * `previous` whose every target is already named by `incoming` (byte-for-byte,
 * not merely by key) returns `incoming` UNCHANGED rather than a
 * reconstructed-but-equal object, so a ladder run that never actually needed
 * a union stays byte-identical to before this fix.
 */
export function unionBatchContinuations(
  previous: ToolCall | undefined,
  incoming: ToolCall | undefined,
): ToolCall | undefined {
  if (previous === undefined) return incoming;
  if (incoming === undefined) return previous;
  const previousTargets = extractReadFileTargets(previous);
  const incomingTargets = extractReadFileTargets(incoming);
  if (previousTargets === undefined || incomingTargets === undefined) return incoming;
  const merged = mergeTargetDescriptors(previousTargets, incomingTargets);
  if (merged.length === incomingTargets.length && merged.every((t, i) => t === incomingTargets[i])) return incoming;
  const contentFull = requestsContentFull(previous) || requestsContentFull(incoming);
  // R-A5 (v0.14.4 candidate, 2026-09-21): explicit `content:"auto"` when
  // neither side demanded "full" — matching what `canonicalReadArguments`
  // (`envelope.ts`) already stamps on EVERY individual continuation this
  // union's two inputs are built from (`shedBatchEntry`/`truncateRangedEntries`
  // mint theirs via `emittableToolCall`, which canonicalizes and defaults an
  // addressed `targets`-bearing call to "auto"). Omitting the field here
  // — the ORIGINAL, byte-identical-only-by-coincidence behaviour — produced
  // a UNIONED continuation that was the only shape in this whole pipeline
  // missing it, purely because this object is a raw literal built AFTER
  // canonicalization rather than a fresh canonicalized call. Functionally
  // harmless (a caller reading no `content` field gets the same "auto"
  // default server-side), but wire-INCONSISTENT with every other
  // `read.batch` continuation this server ever mints, and confirmed to
  // break `rangeFullBatchContinuation.spec.ts`'s own "auto, not merely
  // absent" pin once a union (rather than a single dropped entry) started
  // reaching that pin's own call site.
  const raw = {
    tool: "tl_read_file",
    arguments: { targets: merged, content: contentFull ? "full" : "auto" },
  } as ToolCall;
  // WP-L item 2 (eval-0929 §9, 2026-09-29): canonicalize the merged call
  // through the SAME boundary every OTHER continuation in this pipeline
  // already passes through — `emittableToolCall` -> `canonicalToolCall` ->
  // `attributedContinuationArguments` -> `inheritCallerResponseBudget`
  // (protocol/envelope.ts). The raw literal above carries ONLY `targets`/
  // `content`: no `budget`, `cwd`, `lane` or task continuity, because it is
  // hand-built from two ALREADY-canonicalized inputs (`previous`/`incoming`,
  // both minted via `emittableToolCall` by `shedBatchEntry`/
  // `truncateRangedEntries`) instead of being re-canonicalized itself — the
  // one seam in this whole subsystem that skipped it. Measured live: a
  // handle-addressed two-target ranged batch (`targets:[{handle,range},
  // {handle,range}]`) under a small declared `budget.bytes` unions a
  // construction-time drop with a rung's own cut, and the caller who then
  // ran THIS continuation verbatim (AGENTS.md) got a response re-opened to
  // the calibrated server ceiling instead of the budget it had just declared
  // (a 900 B caller budget followed by a ~19.7 KB next hop — about 22x over,
  // and the dropped target's OWN window was otherwise undisclosed anywhere
  // else on the wire: no `entries[]` item, no top-level omission). Falls
  // back to the raw literal only if canonicalization itself rejects the
  // merged call — defense in depth, never a silent drop of the whole
  // continuation.
  return emittableToolCall(raw) ?? raw;
}

/**
 * R-A5 (v0.14.4 candidate, SAME DAY, 2026-09-21) — RETIRES `unionBatchContin
 * uationsFitting` ENTIRELY: no per-step budget-fit gate, no trim, no refusal
 * seat in this file at all any more. Two prior rules stood here; both are
 * superseded, kept below only as the record of why the final rule is what
 * it is — and of a THIRD, deeper defect this fix's own generated coverage
 * (`rangedBatchNextPreservation.spec.ts`'s F5 test, a 30-file drop sequence)
 * surfaced in the rule that came right before this one.
 *
 *  R-A3 (this same day): a single all-or-nothing union was not enough once a
 *    hop had to drop MORE than one entry to fit — the naive fallback to
 *    `stepped.continuation` ALONE the instant one union attempt failed
 *    overwrote the accumulator outright, permanently losing every entry a
 *    PRIOR drop had already named. FIX: progressively drop the OLDEST
 *    accumulated targets until a trimmed union fits, stopping the instant a
 *    trim would remove one of `incoming`'s own targets.
 *  R-A4 (this same day): live trace (the matrix's own `short|default|9|1011`
 *    cell) confirmed that SAME trim silently drops a target whenever a
 *    CONSTRUCTION-TIME emitter `next` already exists (`server.ts`'s A7
 *    handles=[] ceiling) — `mergeWireLimit`'s clause 4 unions the emitter's
 *    `next` with the (now-trimmed) boundary `continuation` verbatim, so a
 *    target this function excised was excised from the WHOLE response, with
 *    nothing else ever re-asking for it. FIX: no trim AT ALL once an emitter
 *    `next` exists — refuse the STEP instead (return `undefined`, gated on
 *    `fits(budget)`). The trim was KEPT, and pinned, for the other shape (no
 *    emitter `next`), on the argument that an excised target there is always
 *    one rung 4 merely NARROWED and left present in `entries[]`, so it keeps
 *    its own independent `entries[i].next` regardless of whether the
 *    wire-level union also names it.
 *  R-A5, FIRST PASS (this same day, SUPERSEDED WITHIN THE HOUR): applied
 *    R-A4's "refuse the step instead of trimming" rule to BOTH shapes
 *    uniformly (see the ruling paragraph below for why the no-emitter-`next`
 *    shape needed the same treatment). CONFIRMED REGRESSION, live: the F5
 *    test above sheds 30 whole "file"-form entries one at a time (no ranges,
 *    so rung 4 never touches them — only rung 6 ever fires, repeatedly). The
 *    FIRST drop has no `previous` yet, so it is accepted unconditionally; the
 *    SECOND drop's own full union (2 dropped paths + the 28 STILL-WHOLE
 *    remaining files' full content) is nowhere near the 128 KiB calibrated
 *    budget, so `fits(budget)` failed and the step REFUSED — even though
 *    dropping this SECOND file is obviously honest progress (removes ~90 KB
 *    of served content for ~60 B of disclosure) and 8 MORE drops were all
 *    that stood between this response and actually fitting. The refuse-on-
 *    first-miss rule conflated "this ONE candidate does not yet fit the
 *    caller's budget" with "no further honest progress is possible" — false
 *    whenever a rung can still yield MORE cuts (rung 6 can be invoked once
 *    per remaining entry). Measured: a response that should have shed 10 of
 *    30 entries and shipped normally instead refused outright, naming a
 *    `required_min_bytes` of 367616 (2.8x the calibrated budget) — a caller
 *    that raised its budget to match would just get the SAME one-file-short
 *    response back, since NOTHING about the construction changes; the true
 *    fix needed several MORE drops, not a bigger budget.
 *
 * R-A5's ACTUAL RULING (plan §4: "the ONE returned `next` must lead to every
 * requested line"; plan §7.2: "a budget below the accepted minimum is never a
 * silent success"): the CALLER's declared budget is `emit.ts`'s question to
 * answer, not this ladder's. `runLadder`'s OWN job (see this file's own
 * banner further up and `ladder.ts`'s "WHY A LOOP AT ALL") is to shed
 * whatever it honestly can, one step at a time, judged ONLY by whether a
 * step is PROGRESS against the PREVIOUS accepted state (`ladder.ts`'s own
 * `candidateUsed < used` check) — never by whether the result, after just
 * ONE more step, already satisfies some external number. A per-step
 * `fits(budget)` gate answers a question this layer has no business asking,
 * and answering it wrong (by refusing) is what stalled the F5 case one drop
 * in. The union itself must still never be trimmed — that is the one
 * invariant every prior rule here was reaching for — so the fix is simply to
 * ALWAYS take the full, honest union and let it compete on progress alone,
 * exactly like every other candidate this ladder ever judges. If a hop
 * genuinely cannot shed enough to fit (rungs exhausted, `used` still over
 * `limit`), `emit.ts`'s existing tail is where that becomes the honest
 * `budget-below-minimum` refusal — unchanged by this file, and already
 * proven (via `readBatchNextUnionMatrix.spec.ts`'s own matrix) to fire
 * exactly there and nowhere else.
 * `unionBatchContinuationsFitting` is therefore RETIRED outright:
 * `ladder.ts` calls `unionBatchContinuations` (above) directly, with no
 * wrapper and no `fits` callback to thread through. `readBatchDropRecovery
 * Completeness.spec.ts`'s two "sliver" cases, which pinned the OLD trim for
 * the no-emitter-`next` shape, move to the fuller union instead (rule-8
 * report, this fix's own summary) — their PURPOSE (never ship a bare sliver
 * as if it were the whole recovery) is unchanged; only the mechanism is.
 */

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
 * @param kind the response's member — R-A3: read only to scope the
 *   `read.batch` union above; every other value keeps every clause exactly as
 *   E3 specifies, byte-identical to before this fix.
 */
export function mergeWireLimit(
  emitterLimit: unknown,
  records: readonly ShedRecord[],
  continuation: ToolCall | undefined,
  kind?: Kind,
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
    // R-A3: for `read.batch` alone, the emitter's own `next` (a
    // construction-time drop) and the boundary's own running `continuation`
    // can each name a DIFFERENT undelivered window of the SAME response —
    // union them instead of letting the emitter's displace the boundary's.
    // The `emitterNext !== undefined` guard mirrors this arm's own condition
    // for "wire"/"records" (E-5 requires one; unreachable today for
    // read.batch's own emitters, kept so a malformed `next`-less "wire"
    // still degrades to exactly `emitterNext` — `undefined` — never to the
    // boundary's continuation alone).
    // R-A4/R-A5: this union is UNCONDITIONAL — no `fits`/budget check here,
    // and (R-A5) `unionBatchContinuations` above is now ALSO unconditional
    // everywhere else in this file (`unionBatchContinuationsFitting`, the
    // per-step budget-gated wrapper this comment used to point to, is
    // RETIRED — see this file's own banner for the confirmed 30-entry stall
    // a gated version produced). That is safe rather than an oversight:
    // PROOF, not assertion. `mergeWireLimit` never runs in isolation — every
    // one of its callers is `publish()` (this file's own `ladder.ts`), and
    // every `publish()` call is immediately `JSON.stringify`'d and measured
    // by its caller (`runLadder`'s initial measurement and its per-step
    // candidate measurement). So a `mergedNext` that is too large to fit
    // `budget` can reach the wire in exactly two ways, and both are covered:
    // (1) as a per-step CANDIDATE, where the ladder's own `candidateUsed >=
    // used` progress check and the outer `used <= budget` loop condition
    // govern acceptance — an over-budget candidate is never the last word
    // unless it is also the most progress achievable, in which case the
    // ladder keeps trying further rungs (repeated rung-6 invocations, one
    // more dropped entry per call, exactly what the retired per-step gate
    // used to cut short); (2) as the FINAL published response, where
    // `emit.ts`'s `if (used > limit)` tail fails closed — for `read.batch`,
    // into a `budget-below-minimum` refusal naming a measured, margin-padded
    // `required_min_bytes` — rather than certify an over-budget body as
    // complete. No path ships `mergedNext` unmeasured, so leaving the union
    // itself unconditional costs nothing — narrowing it here would only
    // duplicate a budget it has no access to (this function is not given
    // `budget`) and cannot judge on its own.
    const mergedNext = kind === "read.batch" && emitterNext !== undefined
      ? unionBatchContinuations(emitterNext, continuation)
      : emitterNext;
    return { limit: limitOf(cause, union, mergedNext) };
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
