// ---------------------------------------------------------------------------
// protocol v1 -- V11-07 (Adaptive Wire Encoding v2): the TokenCounter
// provider seam.
//
// Every comparison policy.ts's `selectForWire` makes today is BYTE-based
// (`measureResponseBytes`, budget/measure.ts) -- the wire limit is a byte
// budget, and MIN_ABSOLUTE_GAIN_BYTES/MIN_RELATIVE_GAIN are both byte-
// denominated. V11-07 widens WHICH UNIT a candidate is compared in without
// touching that default path at all: `TokenCounter` is a tiny provider
// interface (`id` + `count(text)`); `byteCounter` below is the ONLY counter
// `pipeline.ts` ever supplies in production today, and it is defined so
// that comparing under it is byte-for-byte identical to today's behaviour
// -- see selectV2.ts's header for why that matters for the default-cell
// non-inferiority acceptance row.
//
// A REAL TOKENIZER LIVES NEXT DOOR. This module ships only the interface and
// the byte counter. tokenizerResolver.ts provides the opt-in js-tiktoken
// counter (a runtime dependency of this package since 2026-10-30, lazily loaded
// and only when TL_WIRE_TOKENIZER asks for it); __tests__/wireCodecV2Selection.
// spec.ts's fixed counters prove that a counter whose ordering diverges from
// byte length drives selection.
// ---------------------------------------------------------------------------

import { measureResponseBytes } from "../budget/measure.js";

/** A pluggable "how big is this text" provider -- bytes by default, tokens when a real tokenizer is injected. */
export interface TokenCounter {
  /** Stable identifier; becomes the encoding cache's tokenizer-id key component and the per-cell trace's `tokenizer_id`. */
  readonly id: string;
  /**
   * What one count means, when the counter declares it. `"tokens"` selects the
   * token break-even policy (breakeven.ts), which never reuses a byte-denominated
   * threshold. Undeclared counters (test fixtures) keep the historical
   * "thresholds are in this counter's own units" reading.
   */
  readonly unit?: "bytes" | "tokens";
  /** Deterministic for a given `id` + `text` -- encodingCache.ts's cache-correctness proof depends on this. */
  count(text: string): number;
}

/** The default, always-available counter: today's byte comparison, unchanged. */
export const byteCounter: TokenCounter = {
  id: "bytes",
  unit: "bytes",
  count(text: string): number {
    return measureResponseBytes(text);
  },
};
