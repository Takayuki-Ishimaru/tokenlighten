/** One-hop open-universe expansion; callers project unresolved entries as gaps. */
export interface ExpansionTarget { target: string; origin: "evidence-expansion"; }
export interface ExpansionResult {
  targets: readonly ExpansionTarget[];
  remaining: readonly string[];
  explicitGap?: string;
}

/**
 * Keeps every unserved candidate visible.  Callers feed targets into the
 * obligation ledger and turn remaining/unsupported into explicit-gap proof.
 */
export function expandOneHop(
  language: string,
  candidates: readonly (string | undefined)[],
  cap: number,
): ExpansionResult {
  if (!/^(?:ts|tsx|js|jsx|typescript|javascript)$/i.test(language)) {
    return { targets: [], remaining: [], explicitGap: `one-hop extraction unsupported for ${language}` };
  }
  const unique = [...new Set(candidates.filter((value): value is string => typeof value === "string" && value.length > 0))];
  const safeCap = Math.max(0, cap);
  const targets = unique.slice(0, safeCap).map((target) => ({ target, origin: "evidence-expansion" as const }));
  const remaining = unique.slice(safeCap);
  return remaining.length > 0
    ? { targets, remaining, explicitGap: `one-hop expansion capped; ${remaining.length} target(s) remain open` }
    : { targets, remaining };
}
