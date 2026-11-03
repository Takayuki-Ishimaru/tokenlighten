// autofollow — extracted implementation; imports point to the owning modules.
import type { ToolCallResult } from "../protocol/result.js";
import { AUTOFOLLOW_CHAIN_REPLY_CAP_BYTES } from "./autofollow3.js";
import { AUTOFOLLOW_MAX_FOLLOW_UPS } from "./autofollow3.js";
import { EFF_FIND_PHRASE_BUDGET_BYTES } from "./verification2.js";
import { autofollowContinuationBytes } from "./autofollow3.js";
import { autofollowContinuationSkipReason } from "./autofollow3.js";
import { callToolOnce } from "./call-trace.js";
import { expandEvidencePathGroups } from "../protocol/evidencePathGroups.js";
import { extendAutofollowChain } from "./autofollow3.js";
import { groupEvidencePaths } from "../protocol/evidencePathGroups.js";

/**
 * The identifier-like tokens inside `find` queries, in order, deduplicated,
 * from the most distinctive tier present: camelCase, snake_case, dotted /
 * `::`-qualified or digit-bearing names and file names first; hyphenated
 * names only when there are none; ALLCAPS words of three or more letters
 * (`EKF`, `URGENT`, which also match prose everywhere) only when neither
 * tier has one. Plain words (`mixer`, `Issue`, `file`) are never searched.
 */
export function identifierTokensOf(queries: readonly string[]): string[] {
  const tiers: string[][] = [[], [], []];
  for (const query of queries) {
    for (const raw of query.split(/[\s,;()\[\]{}"'`<>]+/)) {
      const token = raw.replace(/^[^A-Za-z0-9_]+|[^A-Za-z0-9_]+$/g, "");
      if (token.length < 3 || !/[A-Za-z_]/.test(token)) continue;
      const tier = /[a-z][A-Z]/.test(token)
        || token.includes("_")
        || /[A-Za-z][0-9]|[0-9][A-Za-z]/.test(token)
        || /[A-Za-z0-9](\.|::)[A-Za-z0-9]/.test(token)
        ? 0
        : /[A-Za-z0-9]-+[A-Za-z0-9]/.test(token)
          ? 1
          : /^[A-Z][A-Z0-9]{2,}$/.test(token) ? 2 : -1;
      if (tier >= 0 && !tiers[tier]!.includes(token)) tiers[tier]!.push(token);
    }
  }
  return tiers.find((tier) => tier.length > 0) ?? [];
}

/**
 * EFF (TL_EFF_FIND_PHRASE, default ON since 2026-10-18). A `find` whose queries all matched
 * nothing, at least one of them a phrase, runs once more here on the
 * identifier tokens inside its queries (at most five, none of them a query
 * that already matched nothing on its own) as a complete tl_search_files call
 * under an 8 KiB byte budget unless the caller set one (a cut result pages
 * through `limit.next` as usual); a result with matches replaces the empty
 * one, with a `normalized` note.
 */
export async function findPhraseTokens(
  empty: ToolCallResult,
  args: Record<string, unknown>,
  requestMeta?: Record<string, unknown>,
): Promise<ToolCallResult | undefined> {
  if (empty.isError === true || empty.content.length !== 1) return undefined;
  const body = parseWireObject(empty.content[0]!.text);
  const matches = body?.["matches"] as Record<string, unknown> | undefined;
  if (body?.["kind"] !== "search.matches" || matches?.["form"] !== "find" || matches["total_files"] !== 0) return undefined;
  let queries = args["queries"];
  if (typeof queries === "string") {
    try { queries = JSON.parse(queries); } catch { return undefined; }
  }
  if (!Array.isArray(queries) || !queries.every((q) => typeof q === "string")) return undefined;
  const asked = queries as string[];
  if (!asked.some((q) => /\s/.test(q.trim()))) return undefined;
  const tokens = identifierTokensOf(asked).filter((t) => !asked.includes(t)).slice(0, 5);
  if (tokens.length === 0) return undefined;
  const budget = args["budget"] !== undefined ? {} : { budget: { bytes: EFF_FIND_PHRASE_BUDGET_BYTES } };
  const retried = await callToolOnce("tl_search_files", { ...args, ...budget, queries: tokens }, requestMeta);
  if (retried.isError === true || retried.content.length !== 1) return undefined;
  const found = parseWireObject(retried.content[0]!.text);
  const foundMatches = found?.["matches"] as Record<string, unknown> | undefined;
  if (found?.["kind"] !== "search.matches" || typeof foundMatches?.["total_files"] !== "number" || foundMatches["total_files"] === 0) {
    return undefined;
  }
  const normalized = `find queries matched nothing as written (find is literal); searched their identifier tokens: ${tokens.join(", ")}`;
  return { ...retried, content: [{ type: "text", text: JSON.stringify({ ...found, normalized }) }] };
}

export function parseWireObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `parseWireObject` for a reply whose evidence rows are matched by path and
 * handle (the autofollow merge): TL_EFF_EVIDENCE_PATH_GROUPS may have grouped
 * them, so they come back whole (protocol/evidencePathGroups.ts).
 */
export function parseWireObjectWithRows(text: string): Record<string, unknown> | undefined {
  const body = parseWireObject(text);
  return body === undefined ? undefined : expandEvidencePathGroups(body);
}

/**
 * The follow-ups after the first. While `reply` is a discover whose one
 * `next` is a deterministic continuation of the same task
 * (`autofollowContinuationSkipReason`) and the estimate of the reply with that
 * read (`autofollowContinuationBytes`) stays within
 * AUTOFOLLOW_CHAIN_REPLY_CAP_BYTES, the read runs as one more complete call
 * and merges in (`extendAutofollowChain`), AUTOFOLLOW_MAX_FOLLOW_UPS
 * follow-ups at most. Whatever a read that ran served goes out: a refusal
 * booked nothing, a follow-up that served nothing ends the chain, and a plain
 * read rides as rows and ends it (the reply's own `next` stands).
 */
export async function autofollowContinuations(
  carrier: ToolCallResult,
  reply: Record<string, unknown>,
  requestArgs: Record<string, unknown>,
  requestMeta: Record<string, unknown> | undefined,
  defaultByteCeiling: number | undefined,
): Promise<ToolCallResult> {
  for (let followUps = 1; followUps < AUTOFOLLOW_MAX_FOLLOW_UPS; followUps += 1) {
    if (autofollowContinuationSkipReason(reply, requestArgs, defaultByteCeiling) !== undefined) break;
    const step = ((reply["decision"] as Record<string, unknown>)["next"] as Record<string, unknown>)["arguments"] as Record<string, unknown>;
    const estimate = await autofollowContinuationBytes(reply, step);
    if (estimate === undefined || estimate > AUTOFOLLOW_CHAIN_REPLY_CAP_BYTES) break;
    const result = await callToolOnce("tl_read_file", step, requestMeta);
    // A refusal's payload carries no bytes, so its funnel exit booked none.
    if (result.isError === true) break;
    const body = result.content.length === 1 ? parseWireObjectWithRows(result.content[0]!.text) : undefined;
    // Not one JSON object: both go out as they are, never one dropped.
    if (body === undefined) return { ...carrier, content: [{ type: "text", text: JSON.stringify(groupEvidencePaths(reply)) }, ...result.content] };
    const extended = extendAutofollowChain(reply, body, followUps + 1);
    if (extended === undefined) break;
    reply = extended;
    if (body["kind"] !== "read.task_pack") break;
    carrier = result;
  }
  return { ...carrier, content: [{ type: "text", text: JSON.stringify(groupEvidencePaths(reply)) }] };
}
