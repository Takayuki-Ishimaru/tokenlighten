// autofollow — extracted implementation; imports point to the owning modules.
import { decodeEscapedLineBreaks } from "../util/queryEscapes.js";
import { focusTaskQuery } from "../util/queryFocus.js";

/**
 * Plan members that describe the pack rather than carry served content (the
 * neighbour and usage indexes are never booked as served; `verification` and
 * `evidence_model` are hints), so the follow-up pack's value may replace the
 * discover pack's without losing a served byte.
 */
export const AUTOFOLLOW_INDEX_PLAN_MEMBERS: ReadonlySet<string> = new Set(["neighbours", "usages", "verification", "evidence_model"]);

/**
 * The `plan` of an auto-followed reply: both packs' members, the follow-up's
 * winning; `null` when a content-bearing member both carry differs (the
 * discover pack's would be lost).
 */
export function mergeAutofollowPlans(first: unknown, second: unknown): Record<string, unknown> | undefined | null {
  const asPlan = (value: unknown): Record<string, unknown> | undefined =>
    (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);
  const a = asPlan(first);
  const b = asPlan(second);
  if (a === undefined) return b;
  if (b === undefined) return a;
  for (const [key, value] of Object.entries(a)) {
    if (AUTOFOLLOW_INDEX_PLAN_MEMBERS.has(key)) continue;
    if (key in b && JSON.stringify(b[key]) !== JSON.stringify(value)) return null;
  }
  return { ...a, ...b };
}

/**
 * A tl_read_file query as the pack builder reads it: a query whose line
 * breaks came as literal `\n` escapes (a JSON string escaped twice) is read
 * with them as line breaks (util/queryEscapes.ts, decision window 6t-8), and
 * then without the task's process sections ("## Fix protocol", "## After-task
 * report"), which only say how to work and report (util/queryFocus.ts, window
 * 6t-7). callToolOnce hands the pack builder this projection and a pack's
 * `next` restates it, so TL_EFF_AUTOFOLLOW compares a next with the caller's
 * query projected here too (`autofollowSkipReason`): compared with the query
 * as sent, the discover of a request sent with its After-task report went
 * unfollowed (replay corpus v016fq1).
 */
export function packBuilderQuery(query: string): string {
  return focusTaskQuery(decodeEscapedLineBreaks(query)).query;
}
