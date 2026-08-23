// ---------------------------------------------------------------------------
// protocol v1 -- V11-07 (Adaptive Wire Encoding v2): the break-even table.
//
// policy.ts's MIN_RELATIVE_GAIN / MIN_ABSOLUTE_GAIN_BYTES / MIN_ROWS are ONE
// global gate applied to every (kind, payload) pair alike. This module lets
// ONE SPECIFIC (client profile x tokenizer x kind x shape class) cell
// override those three numbers -- e.g. a client/tokenizer pair where a raw
// text block's token savings run well ahead of its byte savings (no JSON
// string-escaping overhead to pay for backslashes/quotes in a code or prose
// body) can afford a lower relative-gain floor than the byte-denominated
// global default assumes; an unfamiliar combination gets no override at
// all and behaves exactly like today's global gate.
//
// PROVENANCE, NOT TUNING. Every entry below is a REASONED default, not a
// bench-fit constant -- this workstream ships no calibration run (paired
// decision benches are user-adjudicated spend; DESIGN-v0.11 reconciliation
// E-4/E-6). Each entry's comment states the engineering reasoning behind
// its numbers; real tuning is holdout-corpus work for a later cycle, the
// same posture V11-02's retrieval weights take.
//
// UNKNOWN CELL => GLOBAL DEFAULTS, always. `resolveBreakevenThresholds`
// never throws and never returns anything looser than policy.ts's own
// globals by omission -- a Map miss is `GLOBAL_DEFAULT_THRESHOLDS`, not a
// zeroed-out or undefined threshold set.
// ---------------------------------------------------------------------------

import type { Kind } from "@tokenlighten/types";
import { MIN_ABSOLUTE_GAIN_BYTES, MIN_RELATIVE_GAIN, MIN_ROWS } from "./policy.js";
import type { ShapeClass } from "./shape.js";

/** Bumped whenever the table's cell SHAPE (key fields) or its interpretation changes -- not on every data tweak, the same convention `ResponseCodec.version` uses for wire-shape identity. */
export const BREAKEVEN_VERSION = "1";

/** Same three knobs as policy.ts's globals, but interpreted in the ACTIVE TokenCounter's units -- bytes under the default `byteCounter`, tokens under an injected real tokenizer (tokenCounter.ts). */
export interface BreakevenThresholds {
  readonly minRelativeGain: number;
  readonly minAbsoluteGainUnits: number;
  readonly minRows: number;
}

export interface BreakevenCellKey {
  readonly clientProfileId: string;
  readonly tokenizerId: string;
  readonly kind: Kind;
  readonly shapeClass: ShapeClass;
}

/** What every cell the table does not name falls back to -- numerically identical to policy.ts's v1 globals, so an unlisted cell behaves exactly like v1 selection would. */
export const GLOBAL_DEFAULT_THRESHOLDS: BreakevenThresholds = {
  minRelativeGain: MIN_RELATIVE_GAIN,
  minAbsoluteGainUnits: MIN_ABSOLUTE_GAIN_BYTES,
  minRows: MIN_ROWS,
};

// A plain space-joined composite string. None of the four component values
// can ever legitimately contain a space (Kind is a closed string-literal
// union of dotted identifiers, the profile/tokenizer ids are short internal
// identifiers, and shapeClass is a closed union too), so this is a safe,
// simple, and easily-logged cache/table key -- no delimiter-collision
// concern the way an arbitrary user-supplied string would raise.
function cellKeyString(key: BreakevenCellKey): string {
  return `${key.clientProfileId} ${key.tokenizerId} ${key.kind} ${key.shapeClass}`;
}

const TABLE: ReadonlyMap<string, BreakevenThresholds> = new Map([
  [
    // tl-reference-client / byte counter / read.text / string-heavy: the
    // ONLY cell E-3's staged widening actually needs to clear today --
    // tl-raw-1 is only ever a v2 candidate for read.text's dominant-
    // string-field shape (selectV2.ts's V2_WIDENED_KIND). Its relative-gain
    // floor is relaxed from the 10% global default to 5%: tl-raw-1 removes
    // JSON's string-escaping overhead entirely (no backslash-doubling of
    // quotes/backslashes in the body), so for a body long enough to be
    // classified "string-heavy" (>=200 chars, shape.ts's
    // STRING_HEAVY_MIN_LENGTH) the byte-denominated global floor already
    // understates the true benefit. The row-count floor is meaningless for
    // a single-body raw block (there are no "rows"), so it is dropped to 0
    // rather than inheriting a tabular-codec assumption that would reject
    // every read.text candidate outright.
    cellKeyString({
      clientProfileId: "tl-reference-client",
      tokenizerId: "bytes",
      kind: "read.text",
      shapeClass: "string-heavy",
    }),
    { minRelativeGain: 0.05, minAbsoluteGainUnits: 32, minRows: 0 },
  ],
  [
    // tl-reference-client / byte counter / search.matches / large numeric
    // rows: a large table of mostly-numeric cells (line numbers, byte
    // offsets) already compresses well under JSON's own repeated-
    // punctuation overhead once row count is high, so the extra machinery
    // (a non-default codec, a client-specific decode path) is only worth
    // paying for when the win is clearly ahead of noise for this shape --
    // the relative-gain floor is RAISED from the 10% default to 15% rather
    // than lowered.
    cellKeyString({
      clientProfileId: "tl-reference-client",
      tokenizerId: "bytes",
      kind: "search.matches",
      shapeClass: "rows-large-numeric",
    }),
    { minRelativeGain: 0.15, minAbsoluteGainUnits: MIN_ABSOLUTE_GAIN_BYTES, minRows: MIN_ROWS },
  ],
]);

/** Resolves the effective thresholds for one cell -- an unlisted cell (unknown client profile, unknown tokenizer, or a combination the table simply does not name) always answers `GLOBAL_DEFAULT_THRESHOLDS`. */
export function resolveBreakevenThresholds(key: BreakevenCellKey): BreakevenThresholds {
  return TABLE.get(cellKeyString(key)) ?? GLOBAL_DEFAULT_THRESHOLDS;
}
