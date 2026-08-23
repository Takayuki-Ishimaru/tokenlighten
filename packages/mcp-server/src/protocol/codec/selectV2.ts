// ---------------------------------------------------------------------------
// protocol v1 -- V11-07 (Adaptive Wire Encoding v2): the two-stage
// codec x host-budget selection algorithm.
//
// V10-11's `selectForWire` (policy.ts) is single-stage: it looks at
// `candidates[0]` (smallest BYTES) ONLY, and falls back to json the moment
// that one candidate fails any gate -- including a host-budget overshoot.
//
// `selectForWireV2` is two-stage:
//   STAGE 1 -- measure every candidate that clears the byte hard floor
//     (below) in the ACTIVE counter's units, then order them by MEASURED
//     GAIN descending. This is deliberately NOT the same as
//     `evaluateCandidates`'s byte-ascending sort: under a real tokenizer,
//     gain order and byte order can diverge (a byte-larger candidate can
//     still be the better TOKEN gain, and vice versa) -- re-sorting by
//     measured gain is what makes stage 2 meaningful at all. Under the
//     default `byteCounter` the two orderings coincide exactly (gain is
//     monotonic with byte size when gain IS byte size), so this never
//     changes the default cell's outcome, only widens what a real
//     tokenizer could influence.
//   STAGE 2 -- walk the gain-ordered list; a candidate that overshoots the
//     host budget or fails its breakeven cell is skipped in favour of the
//     NEXT-best-gain candidate, rather than falling straight to json. This
//     is the actual point of two-stage selection: a great-gain candidate
//     that does not fit THIS response's host cap does not waste every
//     other candidate's smaller-but-still-real, budget-fitting gain.
//
// Two independent safety layers apply to EVERY candidate, unconditionally,
// regardless of what a breakeven cell says:
//   1. the byte hard floor -- a candidate must be smaller than json IN RAW
//      BYTES (never mind tokens) or it is never even measured. The same
//      "never bigger than the json it replaces" invariant policy.ts's
//      selectForWire enforces, kept independent of whichever TokenCounter
//      is active.
//   2. the host budget -- a candidate whose BYTES exceed the wire `limit`
//      is skipped (not immediately fatal, per stage 2 above) rather than
//      selected outright; the limit is a transport byte cap, so it is
//      never reinterpreted in counter units.
// On top of those, a THIRD, counter-based gate applies: the candidate's
// measured gain (in the ACTIVE counter's units, cache-backed via
// encodingCache.ts) must clear its breakeven cell's thresholds
// (breakeven.ts) -- global defaults for any cell the table does not name.
//
// Every candidate reaching this module already passed policy.ts's
// `evaluateCandidates` round-trip oracle (`decode(encode(x))` canonically-
// equals `x`) -- "malformed" is therefore not a runtime branch this file
// has, only a per-cell trace field pipeline.ts asserts `false` by
// construction (see that module's V11-07 section).
// ---------------------------------------------------------------------------

import type { Kind } from "@tokenlighten/types";
import type { CodecCandidate } from "./policy.js";
import { classifyShape, countUniformArrayRows, type ShapeClass } from "./shape.js";
import { resolveBreakevenThresholds } from "./breakeven.js";
import { isCodecAllowedForClient, type ClientProfile } from "./clientProfile.js";
import type { TokenCounter } from "./tokenCounter.js";
import { hashSemanticPayload, type EncodingCache } from "./encodingCache.js";
import type { CodecPayload } from "./types.js";
import { tlRaw1Codec } from "./tlRaw1.js";

/** `read.text` is the ONLY v2 widening target -- deviation E-3. Everything else outside the default allowlist stays fully json under v2 too. */
const V2_WIDENED_KIND: Kind = "read.text";
const V2_WIDENED_CODEC_ID = `${tlRaw1Codec.id}/${tlRaw1Codec.version}`;

/**
 * True when `kind` may be considered for v2 selection PURELY BECAUSE OF the
 * E-3 widening -- callers additionally OR this with policy.ts's
 * `isEligibleKind(kind)` for the base 5-kind allowlist, which this function
 * does not repeat. `read.task_pack` and every other HARD_JSON_FIXED_KINDS
 * member is never `V2_WIDENED_KIND`, so this function can never reach it.
 */
export function isEligibleKindV2(kind: Kind, profile: ClientProfile): boolean {
  if (kind !== V2_WIDENED_KIND) return false;
  return isCodecAllowedForClient(profile, V2_WIDENED_CODEC_ID);
}

/**
 * Restricts `candidates` to the ones v2 may actually pick for `kind`. For
 * the widened kind that is tl-raw-1 ONLY, gated a second time by the client
 * profile (defence in depth against a future NON_JSON_CANDIDATES addition
 * silently widening scope past what E-3 authorizes). For every other kind
 * this is a no-op passthrough -- the base allowlist's own candidate set is
 * already correct as evaluateCandidates produced it.
 */
export function restrictCandidatesForWidenedKind(
  kind: Kind,
  candidates: readonly CodecCandidate[],
  profile: ClientProfile,
): readonly CodecCandidate[] {
  if (kind !== V2_WIDENED_KIND) return candidates;
  return candidates.filter(
    (c) => `${c.codec.id}/${c.codec.version}` === V2_WIDENED_CODEC_ID && isCodecAllowedForClient(profile, V2_WIDENED_CODEC_ID),
  );
}

export type FallbackReasonV2 =
  | "none"
  | "no-candidates"
  | "byte-floor"
  | "host-budget-overshoot"
  | "negative-gain"
  | "breakeven-not-cleared";

export interface SelectionResultV2 {
  readonly text: string;
  /** "json" when nothing else was chosen -- same convention as policy.ts's SelectionResult. */
  readonly codecId: string;
  readonly fallbackReason: FallbackReasonV2;
  readonly tokenizerId: string;
  readonly clientProfileId: string;
  readonly shapeClass: ShapeClass;
  readonly cacheHit: boolean;
}

export interface SelectForWireV2Params {
  readonly kind: Kind;
  readonly payload: CodecPayload;
  readonly jsonText: string;
  readonly jsonBytes: number;
  /** Already round-trip-proven and kind-restricted (restrictCandidatesForWidenedKind) by the caller. Order does not matter -- this function re-orders by measured gain itself. */
  readonly candidates: readonly CodecCandidate[];
  readonly limit: number;
  readonly clientProfile: ClientProfile;
  readonly counter: TokenCounter;
  readonly cache: EncodingCache;
}

interface Measured {
  readonly candidate: CodecCandidate;
  readonly units: number;
  readonly cacheHit: boolean;
}

/**
 * The two-stage selection algorithm -- see the module header. Callers
 * (pipeline.ts) own the mode dispatch (`TOKENLIGHTEN_RESPONSE_FORMAT=auto`
 * + `TL_WIRE_BREAKEVEN`) and the eligibility gate (`isEligibleKindV2` /
 * policy.ts's `isEligibleKind`); this function assumes both already hold.
 */
export function selectForWireV2(params: SelectForWireV2Params): SelectionResultV2 {
  const { kind, payload, jsonText, jsonBytes, candidates, limit, clientProfile, counter, cache } = params;
  const shapeClass = classifyShape(payload, kind);
  const base = { tokenizerId: counter.id, clientProfileId: clientProfile.id, shapeClass };

  if (candidates.length === 0) {
    return { text: jsonText, codecId: "json", fallbackReason: "no-candidates", cacheHit: false, ...base };
  }

  const jsonUnits = counter.count(jsonText);
  const payloadHash = safeHash(payload);

  // Stage 1: measure every byte-floor-clearing candidate, then order by
  // measured gain descending (ascending units, since jsonUnits is fixed).
  const measured: Measured[] = [];
  for (const candidate of candidates) {
    if (candidate.bytes >= jsonBytes) continue; // byte hard floor -- never measured, never a candidate at all
    const cacheKey = payloadHash === undefined
      ? undefined
      : { payloadHash, codecId: candidate.codec.id, codecVersion: candidate.codec.version, tokenizerId: counter.id };
    const cached = cacheKey === undefined ? undefined : cache.get(cacheKey);
    if (cached !== undefined && cached.text === candidate.text) {
      measured.push({ candidate, units: cached.units, cacheHit: true });
      continue;
    }
    const units = counter.count(candidate.text);
    if (cacheKey !== undefined) cache.set(cacheKey, { text: candidate.text, bytes: candidate.bytes, units });
    measured.push({ candidate, units, cacheHit: false });
  }
  if (measured.length === 0) {
    return { text: jsonText, codecId: "json", fallbackReason: "byte-floor", cacheHit: false, ...base };
  }
  measured.sort((a, b) => a.units - b.units);

  // Stage 2: walk in gain order; a gate failure tries the NEXT-best-gain
  // candidate instead of falling straight to json.
  const rows = countUniformArrayRows(payload);
  const thresholds = resolveBreakevenThresholds({
    clientProfileId: clientProfile.id,
    tokenizerId: counter.id,
    kind,
    shapeClass,
  });
  let lastReason: FallbackReasonV2 = "negative-gain";

  for (const m of measured) {
    const absoluteGain = jsonUnits - m.units;
    if (absoluteGain <= 0) { lastReason = "negative-gain"; continue; }
    if (m.candidate.bytes > limit) { lastReason = "host-budget-overshoot"; continue; }
    const relativeGain = jsonUnits > 0 ? absoluteGain / jsonUnits : 0;
    const clears = rows >= thresholds.minRows
      && absoluteGain >= thresholds.minAbsoluteGainUnits
      && relativeGain >= thresholds.minRelativeGain;
    if (!clears) { lastReason = "breakeven-not-cleared"; continue; }

    return {
      text: m.candidate.text,
      codecId: `${m.candidate.codec.id}/${m.candidate.codec.version}`,
      fallbackReason: "none",
      cacheHit: m.cacheHit,
      ...base,
    };
  }

  return { text: jsonText, codecId: "json", fallbackReason: lastReason, cacheHit: false, ...base };
}

function safeHash(payload: CodecPayload): string | undefined {
  try {
    return hashSemanticPayload(payload);
  } catch {
    return undefined; // "any doubt => miss" (encodingCache.ts) -- honoured here by simply never caching.
  }
}
