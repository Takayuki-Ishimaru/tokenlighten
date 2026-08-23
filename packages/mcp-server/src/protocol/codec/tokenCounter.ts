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
// WHY NO REAL TOKENIZER SHIPS HERE. `js-tiktoken` (root devDependency,
// consumed today only by bench/workflows/lib/token_measurement.mjs) is
// present in this repo, but it is adjudicated devDependency-only and never
// reachable from a runtime `import` (see
// __tests__/helpers/wireSweepRandom.ts's header, and this workstream's own
// final report for the full precedent trail: TL-PROTOCOL-V1-PHASE3A-
// CLAUDE.md F-12, TL-P3A-MERGE-VERIFICATION-PACK-2026-08-14.md WB.14-16).
// `packages/mcp-server/package.json` does not declare it even as a
// devDependency today, and adding that declaration is a shared-manifest
// decision outside this workstream's owned `protocol/codec/` scope -- so
// this module ships ONLY the interface and the byte counter; a real
// tokenizer (or, today, a deterministic fake standing in for one) is
// injected by the CALLER. See __tests__/wireCodecV2Selection.spec.ts's
// `fakeTokenCounter` for the test-side proof that a counter whose ordering
// diverges from byte length actually drives selection.
// ---------------------------------------------------------------------------

import { measureResponseBytes } from "../budget/measure.js";

/** A pluggable "how big is this text" provider -- bytes by default, tokens when a real tokenizer is injected. */
export interface TokenCounter {
  /** Stable identifier; becomes the encoding cache's tokenizer-id key component and the per-cell trace's `tokenizer_id`. */
  readonly id: string;
  /** Deterministic for a given `id` + `text` -- encodingCache.ts's cache-correctness proof depends on this. */
  count(text: string): number;
}

/** The default, always-available counter: today's byte comparison, unchanged. */
export const byteCounter: TokenCounter = {
  id: "bytes",
  count(text: string): number {
    return measureResponseBytes(text);
  },
};
