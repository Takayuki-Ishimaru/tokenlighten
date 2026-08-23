/**
 * retrieval/hardFloor.ts — V10-08 Hybrid Retrieval v1: the fusion safety net.
 *
 * DESIGN-v0.10-expansion-plan-v1.3.md V10-08: "explicit path、exact
 * identifier、parser-proven declaration、direct referenceをhard floorに
 * する" — items in these four categories may never be displaced below a
 * non-floor item, or dropped, by RRF fusion. This module is the ONE place
 * that invariant is enforced, independent of how the floor set / fused-score
 * map were built, so it can be pinned by a synthetic, adversarial unit test
 * (__tests__/hardFloor.spec.ts) without standing up a real workspace.
 */

/**
 * Reorder `items` so every floor item (per `keyOf`) precedes every non-floor
 * item; each of the two groups is internally ordered by fused score
 * descending (ties break on the item's original index, for determinism).
 * Nothing is dropped: the output is a permutation of the input, length for
 * length — an item absent from `fusedScore` sorts as score 0 within its
 * group rather than being excluded.
 *
 * Floor-first is a STRICTLY STRONGER guarantee than "no floor item is
 * demoted below a non-floor item it outranked before fusion": no floor item
 * is EVER below ANY non-floor item, so the narrower property holds as a
 * corollary regardless of the two groups' pre-fusion relative order.
 */
export function applyHardFloor<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  fusedScore: ReadonlyMap<string, number>,
  floorKeys: ReadonlySet<string>,
): T[] {
  const floor: Array<{ item: T; index: number }> = [];
  const rest: Array<{ item: T; index: number }> = [];
  items.forEach((item, index) => {
    (floorKeys.has(keyOf(item)) ? floor : rest).push({ item, index });
  });

  const byFusedDesc = (a: { item: T; index: number }, b: { item: T; index: number }): number => {
    const delta = (fusedScore.get(keyOf(b.item)) ?? 0) - (fusedScore.get(keyOf(a.item)) ?? 0);
    return delta !== 0 ? delta : a.index - b.index;
  };
  floor.sort(byFusedDesc);
  rest.sort(byFusedDesc);

  return [...floor.map((e) => e.item), ...rest.map((e) => e.item)];
}
