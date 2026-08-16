/**
 * mustFetch.ts — formerly DESIGN-v0.9 §4.8's must-fetch budget expansion.
 *
 * `TL_MUSTFETCH_EXPAND` used to gate ONE cap change: content the server
 * internally executed under §4.6 (a slice continuation, an inlined codeless
 * surface body, an inlined artifact sheet) could expand its response budget
 * from a base cap to a slightly larger "must-fetch" tier (task_pack
 * 16384->24576, slice/artifact-roster reads 8192->16384).
 *
 * Retired 2026-08-16: the 2026-07-16a/2026-07-24 cap raises pushed every real
 * base cap (READ_SYMBOL_CAP_BYTES, MAX_TASK_PACK_BYTES, ... = 24576) at or
 * above both former tiers, so `Math.max(baseCap, tier)` had degenerated to
 * `baseCap` unconditionally at every call site — the flag bought nothing in
 * either state (readCodeSupplyWs1b.spec.ts documented this before the
 * mechanism was deleted). `mustFetchPackCap` and `mustFetchReadBudget` are
 * kept as identity pass-throughs so their existing call sites in server.ts /
 * readCodeTaskPack.ts need no changes; new code should just use a base cap
 * directly instead of calling through here.
 */

/** Identity pass-through — see the module doc above. */
export function mustFetchPackCap(baseCap: number): number {
  return baseCap;
}

/** Identity pass-through — see the module doc above. */
export function mustFetchReadBudget(baseCap: number): number {
  return baseCap;
}
