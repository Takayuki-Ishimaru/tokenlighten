// ---------------------------------------------------------------------------
// protocol v1 -- the codec registry (V10-11).
// ---------------------------------------------------------------------------

import { jsonCodec } from "./jsonCodec.js";
import { tlTable1Codec } from "./tlTable1.js";
import { tlRaw1Codec } from "./tlRaw1.js";
import { toon41Codec } from "./toon.js";
import type { ResponseCodec } from "./types.js";

/**
 * Every implemented non-json candidate `policy.ts` may consider. Order is
 * not significant (the policy sorts by measured bytes) but is kept stable
 * for deterministic shadow-log ordering.
 */
export const NON_JSON_CANDIDATES: readonly ResponseCodec[] = [tlTable1Codec, tlRaw1Codec, toon41Codec];

/** Every codec this server knows how to construct, keyed by `id`, for tests
 *  and diagnostics. */
export const CODECS_BY_ID: ReadonlyMap<string, ResponseCodec> = new Map(
  [jsonCodec, ...NON_JSON_CANDIDATES].map((c) => [c.id, c]),
);
