// FX-R3d (D10, 2026-09-04) — WHO ACTUALLY WITHHELD THIS ROW'S BODY.
//
// THE DEFECT THIS MODULE EXISTS FOR. `demoted_count` (and with it the
// attestation's `committed`, the deterministic v2 gate's engagement signal,
// the smoke floor and the paid A/B's treatment-arm claim) used to be computed
// from WIRE SHAPE alone: any evidence row with no `body`, no `prior` and a
// non-empty `remaining` counted as "demoted". Shape cannot distinguish a body
// W-DEMOTE withheld from a body some OTHER mechanism never sent. After D8
// (FX-R3c) that stopped being a theoretical gap: a caller-named file joins the
// frontier bodyless whenever it exceeds the join bound or the pack's byte cap,
// and on the real sealed SF05 replay exactly that happened — a 1514-line
// caller-named document shipped as `remaining:["1-1514"]`, the attestation read
// `demoted_count:1, committed:true`, and `applySemanticFrontierDemotion` had
// withheld ZERO bodies. Engagement was measuring a non-demotion.
//
// THE FIX. Every mechanism that withholds a body MARKS the surface it withheld
// it from, and the counters are computed by intersecting those marks with the
// FINAL shipped wire (protocol/envelope.ts). A marked row that still ships
// bodyless counts; a marked row that ended up with a body does not; an
// unmarked bodyless row never counts. Measurement stops guessing from shape.
//
// WHY A SYMBOL-KEYED OWN PROPERTY (ruling (bb), 2026-09-04). Reference
// identity is not a safe carrier across this codebase's seam→wire copy chain.
// An own, ENUMERABLE, Symbol-keyed property rides `{...surface}` /
// `Object.assign` copies (CopyDataProperties iterates `[[OwnPropertyKeys]]`)
// and is dropped by `JSON.stringify` by spec, so it can never reach the wire
// and needs no stripping step — the same construction `sfSatisfaction.ts`'s
// `SF_CONTEXT_TOKEN_KEY` uses, for the same reason. A `WeakSet` fallback keeps
// the mark readable for the exact object even when it is frozen/non-extensible
// and `defineProperty` therefore throws.
//
// This module is a LEAF on purpose: the demotion pass (canonicalDecision.ts),
// the caller-named frontier join (readCodeTaskPack.ts) and the wire projector
// (protocol/decisionWire.ts) all import it, and none of them may import each
// other for this.

/** Set by `applySemanticFrontierDemotion` on every surface whose body it took. */
export const SF_WITHHELD_BODY_KEY: unique symbol = Symbol("tokenlighten.sfWithheldBody");
/** Set by the D8 caller-named frontier join on every grounded named row it adds. */
export const SF_NAMED_JOIN_KEY: unique symbol = Symbol("tokenlighten.sfNamedJoin");
/**
 * P2 fix (2026-09-19). Same carrier problem, unrelated to SF: `why` is the
 * ordinary way to spot a caller-supplied ranged surface, but trimToCap's own
 * Phase B unconditionally clears `why` from every surface ("drop why from
 * all surfaces") once a pack needs enough trimming to reach Phase E — so a
 * check made AFTER trimToCap returns (canonicalDecision.ts's
 * `unservedCallerRangedTargetsNext`) cannot re-derive it from `why` any more
 * than readCodeTaskPack.ts's own post-trim reconciliation can (see
 * `reconcileCallerRangeRemaining`'s doc comment). Mark it here, before
 * trimToCap ever runs, and read it back downstream instead of guessing from
 * a field a sibling phase is free to erase.
 */
export const CALLER_RANGE_SURFACE_KEY: unique symbol = Symbol("tokenlighten.callerRangeSurface");
/**
 * TL-01 (2026-09-21). The SAME carrier problem as `CALLER_RANGE_SURFACE_KEY`
 * above, one axis wider: `dedupeTrimAndPersist`'s post-contract shed tiers
 * re-derive a surface's PROVENANCE from `why` (`callerNamedSurface` —
 * segment-exact `caller-supplied`/`query-named-file`; `explicitlyProvenanced` —
 * substring `caller-supplied`/`query-named-file`/`header-source-pair`), and
 * those tiers run AFTER `trimToCap`, whose Phase B unconditionally clears `why`
 * from every surface. Measured on the plan-0143 §4 repro: both predicates were
 * ALWAYS false there, so `shedSurface` deleted a caller-named, caller-ranged
 * surface outright instead of taking bytes from its body, and shipped no
 * `dropped-by-byte-budget:` disclosure either — the exact two behaviours WP-P2 B
 * and the GATE-A tier were written to guarantee.
 *
 * Unlike the boolean marks above this carries the `why` STRING, so both
 * predicates keep their own reviewed, deliberately-different matching rules
 * instead of being re-expressed as yet another mark. Record it before
 * `trimToCap` runs; read it back through `surfaceProvenance`, which still
 * prefers a live `why` when Phase B never fired.
 */
export const SURFACE_PROVENANCE_KEY: unique symbol = Symbol("tokenlighten.surfaceProvenance");
/**
 * B1 fix (2026-09-21, adversarial review of the v0.14.3 improvement-plan fix
 * wave). A DIFFERENT question from `CALLER_RANGE_SURFACE_KEY` above, despite
 * the similar name: that mark answers "does `why` look like SOME flavour of
 * caller-named surface" (deliberately broad — every named target, ranged or
 * not — because `settleCallerRangeDelivery`/`reconcileCallerRangeRemaining`/
 * `applyFoldSmallRemainder` need it that broad to keep `remaining_ranges`
 * honest for ANY caller-named surface; `firstPackCompleteness.spec.ts`'s "B"
 * suite pins that). THIS mark answers a narrower, different question:
 * "did THIS call's own `targets[]`/`paths[]` entry carry an EXPLICIT
 * `range`/`ranges`" — `candidate.callerRange === true` in `candidateToSurface`
 * (readCodeTaskPack.ts), the one place that bit is legible (it never survives
 * onto the returned TaskPackSurface as an ordinary field).
 *
 * Consumed ONLY by `unservedCallerRangedTargetsNext` (canonicalDecision.ts) —
 * the completeness-WITHHOLDING gate — so a range-less candidate inside a
 * query-bearing task pack (a bare `{path}` in `targets[]`, whether the caller
 * typed it or a PREVIOUS server `next` re-offered it as a proposed candidate)
 * never withholds a certificate or gets paged by a minted `next`: it is a
 * seed, not a request to read a specific window in full. An explicit-range
 * target — the caller's own window, or a server-minted continuation of one —
 * still marks and still binds the gate exactly as TL-01 (2026-09-19/21)
 * requires. Record it at the same construction-time point
 * `CALLER_RANGE_SURFACE_KEY` documents, for the same reason.
 */
export const EXPLICIT_RANGE_SURFACE_KEY: unique symbol = Symbol("tokenlighten.explicitRangeSurface");

const withheldBodies = new WeakSet<object>();
const namedJoins = new WeakSet<object>();
const callerRangeSurfaces = new WeakSet<object>();
const explicitRangeSurfaces = new WeakSet<object>();
const surfaceProvenances = new WeakMap<object, string>();

function mark(surface: object, key: symbol, set: WeakSet<object>): void {
  if (surface === null || typeof surface !== "object") return;
  set.add(surface);
  try {
    Object.defineProperty(surface, key, {
      value: true,
      enumerable: true, // MUST be enumerable — this is what survives {...surface}.
      configurable: true,
      writable: true,
    });
  } catch {
    // Frozen/non-extensible surface: the WeakSet above still answers for THIS
    // exact object, which is the only carrier a copy could not have needed.
  }
}

function marked(surface: object, key: symbol, set: WeakSet<object>): boolean {
  if (surface === null || typeof surface !== "object") return false;
  if ((surface as Record<symbol, unknown>)[key] === true) return true;
  return set.has(surface);
}

/** Record that W-DEMOTE took this surface's body (§3.5.1's supporting tier). */
export function markSemanticFrontierWithheldBody(surface: object): void {
  mark(surface, SF_WITHHELD_BODY_KEY, withheldBodies);
}

/** True iff `applySemanticFrontierDemotion` withheld THIS surface's body. */
export function wasSemanticFrontierBodyWithheld(surface: object): boolean {
  return marked(surface, SF_WITHHELD_BODY_KEY, withheldBodies);
}

/**
 * Record that D8's caller-named frontier join added this row. Such a row is
 * grounded and caller-named by construction; whether it SHIPS a body is
 * decided later (the join's own inline bound, then `trimToCap` Phase E), which
 * is exactly why the count over these marks is reported separately from
 * `demoted_count` instead of being folded into it.
 */
export function markSemanticFrontierNamedJoin(surface: object): void {
  mark(surface, SF_NAMED_JOIN_KEY, namedJoins);
}

/** True iff D8's caller-named frontier join minted this surface. */
export function isSemanticFrontierNamedJoin(surface: object): boolean {
  return marked(surface, SF_NAMED_JOIN_KEY, namedJoins);
}

/** Record that `surface` was built directly from the caller's own named, ranged `targets[]`/`paths[]` request (captured before trimToCap can clear `why`). */
export function markCallerRangeSurface(surface: object): void {
  mark(surface, CALLER_RANGE_SURFACE_KEY, callerRangeSurfaces);
}

/** True iff `markCallerRangeSurface` marked this surface. */
export function isCallerRangeSurface(surface: object): boolean {
  return marked(surface, CALLER_RANGE_SURFACE_KEY, callerRangeSurfaces);
}

/** Record that `surface` was built from a `targets[]`/`paths[]` entry carrying an EXPLICIT `range`/`ranges` (`candidate.callerRange === true`) — see `EXPLICIT_RANGE_SURFACE_KEY`. */
export function markExplicitRangeSurface(surface: object): void {
  mark(surface, EXPLICIT_RANGE_SURFACE_KEY, explicitRangeSurfaces);
}

/** True iff `markExplicitRangeSurface` marked this surface (an EXPLICIT caller/continuation range — never a bare, range-less named target). */
export function isExplicitRangeSurface(surface: object): boolean {
  return marked(surface, EXPLICIT_RANGE_SURFACE_KEY, explicitRangeSurfaces);
}

/** Record this surface's `why` as it stood BEFORE `trimToCap` could clear it — see `SURFACE_PROVENANCE_KEY`. */
export function markSurfaceProvenance(surface: object, why: string): void {
  if (surface === null || typeof surface !== "object" || why === "") return;
  surfaceProvenances.set(surface, why);
  try {
    Object.defineProperty(surface, SURFACE_PROVENANCE_KEY, {
      value: why,
      enumerable: true, // MUST be enumerable — this is what survives {...surface}.
      configurable: true,
      writable: true,
    });
  } catch {
    // Frozen/non-extensible surface: the WeakMap above still answers for THIS
    // exact object, which is the only carrier a copy could not have needed.
  }
}

/**
 * This surface's provenance `why`: the live field when it is still there, else
 * the value `markSurfaceProvenance` recorded before `trimToCap` Phase B wiped
 * it. `undefined` when the surface never had one — never a guess.
 */
export function surfaceProvenance(surface: { why?: string | undefined }): string | undefined {
  if (surface.why !== undefined) return surface.why;
  if (surface === null || typeof surface !== "object") return undefined;
  const carried = (surface as Record<symbol, unknown>)[SURFACE_PROVENANCE_KEY];
  if (typeof carried === "string") return carried;
  return surfaceProvenances.get(surface);
}
