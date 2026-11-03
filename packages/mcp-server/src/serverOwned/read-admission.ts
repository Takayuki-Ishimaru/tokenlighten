// read-admission — extracted implementation; imports point to the owning modules.
import { CLAUDE_CODE_MIN_REPLY_BYTES } from "../protocol/codec/clientProfile.js";
import { admitTaskPackBudget } from "../features/task-pack/engine/packBasics.js";
import { firstPackMaxBytes } from "../util/flags.js";
import { isCodexCliClient } from "../protocol/clientAdvertisement.js";
import { resolveClientProfile } from "../protocol/codec/clientProfile.js";
import { resolvedClientId } from "../runtime/config.js";
import { toolStructuredError } from "../protocol/result.js";

export function taskPackAdmission(
  args: Record<string, unknown>,
  defaultResponseByteCeiling: number | undefined,
): ReturnType<typeof toolStructuredError> | undefined {
  const refusal = admitTaskPackBudget({
    maxBytes: typeof args["maxBytes"] === "number" ? args["maxBytes"] : defaultResponseByteCeiling,
    maxTokens: typeof args["maxTokens"] === "number" ? args["maxTokens"] : undefined,
  });
  return refusal === undefined ? undefined : toolStructuredError(refusal);
}

/**
 * The byte ceiling of this call's task pack: the client's response ceiling,
 * or, for a task's FIRST pack on a token-billed client (Claude Code, Codex),
 * the smaller TL_FIRST_PACK_MAX_BYTES (util/flags.ts `firstPackMaxBytes`,
 * off by default: measured, a smaller first pack only split sessions).
 * First means no task binding, no qref replay, no caller-named paths and no
 * `force_serve`: the pack the server assembles from the query alone. Never
 * below the 6,144 B task-pack admission floor; explicit `maxBytes`/
 * `maxTokens` still win (readCodeModes.ts `resolveCallerByteCeiling`).
 */
export function taskPackByteCeiling(
  defaultCeiling: number | undefined,
  first: { taskBinding: unknown; fromRef: boolean; hasPathList: boolean; forceServe: boolean; query: string },
): number | undefined {
  const limit = firstPackMaxBytes();
  if (limit === 0) return defaultCeiling;
  if (first.taskBinding !== undefined || first.fromRef || first.hasPathList || first.forceServe || first.query.length === 0) return defaultCeiling;
  const clientId = resolvedClientId();
  if (resolveClientProfile(clientId).id !== "claude-code" && !isCodexCliClient(clientId)) return defaultCeiling;
  const firstCeiling = Math.max(CLAUDE_CODE_MIN_REPLY_BYTES, limit);
  return defaultCeiling === undefined ? firstCeiling : Math.min(defaultCeiling, firstCeiling);
}

/** TL-06 staleness pre-check: a fingerprint cap matching
 *  `recordPackServedRanges`'s own `MAX_FINGERPRINT_FILE_BYTES`
 *  (readCodeTaskPack.ts) — a file this large is skipped (fail-open: proceed
 *  normally), not refused, matching that function's own fail-open shape. */
export const STALE_RANGE_PROBE_MAX_BYTES = 256 * 1024;

/** `"start-end"` -> `[start,end]`, or `undefined` if unparseable. */
export function parseServedSpan(range: string): [number, number] | undefined {
  const m = /^(\d+)-(\d+)$/.exec(range);
  if (m === null) return undefined;
  return [Number(m[1]), Number(m[2])];
}

/** The minimal single span covering every `"start-end"` string in `ranges`. */
export function mergeRangeSpans(ranges: readonly string[]): string | undefined {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const r of ranges) {
    const parsed = parseServedSpan(r);
    if (parsed === undefined) continue;
    lo = Math.min(lo, parsed[0]);
    hi = Math.max(hi, parsed[1]);
  }
  return Number.isFinite(lo) && Number.isFinite(hi) ? `${lo}-${hi}` : undefined;
}

/**
 * GATE-A: true iff every line of `range` ("start-end") already lies within
 * the union of `priorRanges`. GATE-A2: no longer called directly on the
 * caller's whole `entry.range` by `admitCallerRangedContinuation` (that
 * conflated "not yet delivered" with "is a continuation" — see that
 * function's own doc comment) — now a generic span-coverage utility,
 * reused by `reachesUndeliveredMintedWindow` below to test whether a
 * MINTED window's overlap with the request is already fully delivered. An
 * unparsable `range` is conservatively treated as NOT covered (never
 * silently waived into the lenient branch on a shape this cannot parse).
 */
export function isRangeFullyCoveredBy(range: string, priorRanges: readonly string[]): boolean {
  const target = parseServedSpan(range);
  if (target === undefined) return false;
  const spans = priorRanges
    .map(parseServedSpan)
    .filter((span): span is [number, number] => span !== undefined)
    .sort((a, b) => a[0] - b[0]);
  let covered = target[0];
  for (const [start, end] of spans) {
    if (start > covered) break; // a gap opens before `covered` is reached: cannot bridge it
    if (end >= covered) covered = end + 1;
    if (covered > target[1]) return true;
  }
  return false;
}
