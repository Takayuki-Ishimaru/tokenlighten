/**
 * dominantRoot.ts — shared "which project root owns most of these items"
 * helper.
 *
 * Consolidates what were two independent notions of the same idea:
 *   - locateTaskContext.ts's `computeDominantRoot` (score-sum over
 *     Candidate[], plus a scope-hint override layered on top by the
 *     caller).
 *   - readCodeTaskPack.ts's `dominantRootOf` (count-majority over
 *     TaskPackSurface[], returns "" on an empty/no-majority input).
 *
 * Both reduce to: group items by `rootOf(item)`, weight each root (by
 * count, or by a caller-supplied per-item weight), and pick the
 * highest-weighted root — first-encountered wins ties, which is
 * deterministic given a caller that already orders items meaningfully.
 * This module has no other dependency (not even `projectRootOf`, which
 * stays owned by locateTaskContext.ts and is passed in as `rootOf`).
 */

/**
 * Return the root (as computed by `rootOf`) that owns the most weight among
 * `items`, or `null` when `items` is empty. Weight defaults to 1 per item
 * (count-majority); pass `weightOf` for a score-sum variant. Ties break
 * toward whichever root is encountered first in iteration order.
 */
export function dominantRoot<T>(
  items: T[],
  rootOf: (item: T) => string,
  weightOf?: (item: T) => number,
): string | null {
  if (items.length === 0) return null;

  const weightByRoot = new Map<string, number>();
  for (const item of items) {
    const root = rootOf(item);
    const w = weightOf ? weightOf(item) : 1;
    weightByRoot.set(root, (weightByRoot.get(root) ?? 0) + w);
  }

  let best: string | null = null;
  let bestWeight = -Infinity;
  for (const [root, weight] of weightByRoot) {
    if (weight > bestWeight) {
      best = root;
      bestWeight = weight;
    }
  }
  return best;
}
