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

const withheldBodies = new WeakSet<object>();
const namedJoins = new WeakSet<object>();

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
