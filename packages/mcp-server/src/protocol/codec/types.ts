// ---------------------------------------------------------------------------
// protocol v1 -- V10-11 Adaptive Wire Encoding, the ResponseCodec contract.
//
// NORMATIVE SOURCE: DESIGN-v0.10-expansion-plan-v1.3.md V10-11 "Adaptive
// Wire Encoding v1" (lines 2229-2295 on the `develop` branch, commit
// cede7892 -- this worktree forked before that commit landed, so the
// design text was read from that commit's blob, not from this tree).
// Groundwork only for v0.10.0-rc.1: the abstraction, shadow measurement,
// and an opt-in (env-gated) compact path. Default behaviour (no env set)
// is BYTE-IDENTICAL to protocol v1's existing JSON wire -- see
// `pipeline.ts`.
//
// WHAT A CODEC IS. `envelope.ts`'s `finalizeProtocolResponse` and
// `emit.ts`'s `emitFinalizedPayload` decide protocol v1's CANONICAL
// payload -- the `kind`, the required set, every field's semantics. That
// layer is untouched by this directory. A `ResponseCodec` only chooses how
// the FINAL, already-decided canonical payload is spelled onto
// `TextContent.text`: `json` (today's wire, unconditionally available), or
// a candidate compact form that MUST satisfy `decode(encode(x))`
// canonically-equals `x` before it is ever trusted (`policy.ts` proves this
// on every call before choosing a candidate -- encode/decode correctness is
// never assumed).
// ---------------------------------------------------------------------------

import type { Kind } from "@tokenlighten/types";

/** A JSON-shaped payload: exactly what `emit.ts` holds as `current`/`payload`. */
export type CodecPayload = Record<string, unknown>;

/**
 * One wire representation of protocol v1's canonical payload.
 *
 * `canEncode` is a MECHANICAL capability check only ("can this codec
 * losslessly represent this payload at all") -- it is never a desirability
 * judgement. The "is it worth it" decision (row counts, byte gain
 * thresholds) lives entirely in `policy.ts`, which is the only module
 * allowed to choose a codec for the live wire. This split means a codec
 * never has to know about env flags, thresholds, or the allowlist, and a
 * new codec can be added, fuzzed, and proven correct in complete isolation
 * from the selection policy.
 */
export interface ResponseCodec {
  /** Stable identifier. Never reused for an incompatible wire format. */
  readonly id: string;
  /** Format version, independent of `id` (`toon-4.1`'s `id` already carries
   *  its pinned spec version; other codecs version here instead). */
  readonly version: string;
  /** True iff `encode` can losslessly represent this exact payload. Never
   *  throws; an internal error is a `false`, not an exception. */
  canEncode(kind: Kind, payload: CodecPayload): boolean;
  /** Render `payload` to wire text. MAY throw -- callers always wrap this in
   *  a decode-verified try/catch (`policy.ts`) and fall back to `json`. */
  encode(payload: CodecPayload): string;
  /** Invert `encode`. MAY throw on malformed text. Used for this codec's own
   *  round-trip self-proof (property tests, live selection, shadow mode) --
   *  never to parse arbitrary third-party input. */
  decode(text: string): CodecPayload;
}

/**
 * Raised by a codec's `encode`/internal walk when it reaches a shape outside
 * its documented, implemented subset. Every codec's `canEncode` performs the
 * identical shape check BEFORE `encode` is ever called on the live path, so
 * this is a defensive invariant (fuzz / direct-call coverage), never a
 * normal control-flow outcome in the funnel.
 */
export class UnsupportedShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedShapeError";
  }
}

export function isPrimitive(
  value: unknown,
): value is string | number | boolean | null {
  return (
    value === null
    || typeof value === "string"
    || typeof value === "number"
    || typeof value === "boolean"
  );
}

export function isPlainObject(value: unknown): value is CodecPayload {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** An array every element of which is a plain object, none of them `{}` (the
 *  shape `tl-table-1` and `toon-4.1`'s tabular form both key off). */
export function isNonEmptyObjectArray(value: unknown): value is CodecPayload[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every((el) => isPlainObject(el) && Object.keys(el).length > 0);
}

/**
 * Order-independent (object keys), order-dependent (arrays) structural
 * equality over JSON-shaped values. This -- not byte identity -- is the
 * "canonical equality" every codec's round-trip proof is held to: a client
 * consuming the decoded value cares about the value, not the key order a
 * particular encoder happened to walk fields in.
 */
export function canonicalEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") {
    return a === b || (Number.isNaN(a) && Number.isNaN(b));
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!canonicalEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ak = Object.keys(a).sort();
    const bk = Object.keys(b).sort();
    if (ak.length !== bk.length) return false;
    for (let i = 0; i < ak.length; i++) {
      if (ak[i] !== bk[i]) return false;
    }
    for (const k of ak) {
      if (!canonicalEqual(a[k], b[k])) return false;
    }
    return true;
  }
  return false;
}
