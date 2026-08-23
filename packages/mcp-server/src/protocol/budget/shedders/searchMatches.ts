// ---------------------------------------------------------------------------
// protocol v1 — the `search.matches` shed ladder (P3a S3).
//
// NORMATIVE SOURCE: TL-PROTOCOL-V1-PHASE3A-PLAN-DRAFT.md §5.5, §5.7;
// DESIGN-v0.10-protocol-v1-contract-freeze.md A.5.8 (four forms), A.6.2,
// A.8.1 E-7, A.13 ruling 1 ([R5-9]); erratum E1 (rung 6).
//
// LADDER: 1 (`note`, `hint`) -> 3 (`term_results`) -> 6 in three sub-steps, IN
// THIS ORDER: `files[].snippets` -> `files[].lines` tail (keep the head) ->
// whole `files[]` entries.
//
// ------------------------ THE INVENTORY NEVER LIES --------------------------
//
// `total_files` / `total_matches` / `total` are computed over the FULL result
// set and are NEVER reduced by a shed. That is what `findText.ts`'s
// `MAX_INVENTORY_RESPONSE_BYTES` branch already implements
// (`__tests__/responseCap.spec.ts`: "snippets may truncate; the inventory never
// lies"), promoted from feature convention to required-set invariant by §5.5.
// No step below writes any of the three; they appear in no list here, and that
// absence is the mechanism.
//
// -------------------------- TWO FORMS DECLINE -------------------------------
//
// `diff` HAS a record array (`files[]`) and no constructible continuation. The
// cap drops WHOLE FILES off the end of `allFiles` and the response never names
// the ones it dropped, so a `{action:"diff", path:X}` recovery would have to
// INVENT X; `path` is the only narrowing argument there is, and naming one of
// the caller's own paths for it is the §2.1 `await_input` case, not a `next`.
// `projectDiff` reaches the same conclusion for the emitter side and takes the
// `capped` arm; E5 makes the boundary's answer the same one — decline. Any
// `limit` a `diff` response carries therefore stays `capped`, which is clause 5
// of the E3 merge behaving correctly rather than a gap.
//
// `locate` carries `LocateOutput`, an already-declared union with its own
// internal completeness signal (`hit`), no `foldLimit` call at any emitter
// site, and no §5.5/§5.6 sub-order in any plan document (recon open question
// §12.7). Zero rungs beyond prose, which it does not have either.
// ---------------------------------------------------------------------------

import { findScopedNext, symbolsNext } from "../../searchFamily.js";
import {
  arrayAt,
  dropInBlock,
  dropTrailingEntry,
  isRecord,
  recordAt,
  str,
  withKey,
  withoutKeys,
  type ShedContext,
  type ShedOutcome,
  type ShedPayload,
  type Shedder,
} from "./registry.js";

/**
 * PI-06 beta.2 — `symbol_coverage` (when present) summarizes the SERVED
 * page's parser-proven/fallback split. Unlike `total` (never touched by any
 * rung — "the inventory never lies"), this field's whole point is to
 * describe the page currently on the wire, so a rung-6 drop here must keep
 * it honest rather than stale: decrement whichever bucket the dropped entry
 * belonged to, and drop the field entirely once `fallback` reaches zero
 * (matching `computeSymbolCoverage`'s own absence-means-fully-proven gate in
 * searchSymbols.ts — never emit a `{fallback:0}` shape).
 */
function withDecrementedSymbolCoverage(
  matches: Record<string, unknown>,
  droppedEntry: unknown,
): Record<string, unknown> {
  const coverage = matches["symbol_coverage"];
  if (!isRecord(coverage)) return matches;
  const droppedWasFallback = isRecord(droppedEntry) && droppedEntry["source"] === "fallback";
  if (droppedWasFallback) {
    const fallback = typeof coverage["fallback"] === "number" ? coverage["fallback"] : 0;
    const nextFallback = fallback - 1;
    if (nextFallback <= 0) {
      const stripped = withoutKeys(matches, ["symbol_coverage"]);
      return stripped === undefined ? matches : stripped.next;
    }
    return withKey(matches, "symbol_coverage", { ...coverage, fallback: nextFallback });
  }
  const parserProven = typeof coverage["parser_proven"] === "number" ? coverage["parser_proven"] : 0;
  return withKey(matches, "symbol_coverage", { ...coverage, parser_proven: Math.max(0, parserProven - 1) });
}

/**
 * Prose inside `matches`, cheapest-loss-first.
 *
 *   `note`, `hint`          §5.5's own two, and E-7 canonical.
 *   `partial_served_note`,
 *   `served_note`           LAST, in that order. Both state RESIDENCY — which
 *                           of the matched files the caller was already served
 *                           this session — which is the fact the 2026-08-09
 *                           range-honesty work added and the escalation ladder
 *                           reads. Prose by shape, load-bearing by use, so they
 *                           go only after the two that are purely decorative.
 *
 * `absence`, `all_served`, `partially_served`, `inventory`, `inventory_complete`,
 * `matched_terms`, `matched_variant`, `did_you_mean`, `did_you_mean_basis` are
 * NOT prose: they are structured recovery and completeness data. The guide
 * binds two of them by name ("0-match+`absence`=that token verifiably absent",
 * "`did_you_mean`=near-miss"), and `inventory` is what the emitter's own
 * continuation is built from.
 */
const MATCHES_PROSE: readonly string[] = ["note", "hint", "partial_served_note", "served_note"];

function shedMatchesProse(payload: ShedPayload): ShedOutcome | undefined {
  for (const key of MATCHES_PROSE) {
    const outcome = dropInBlock(payload, "matches", [key], 1);
    if (outcome !== undefined) return outcome;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Rung 3 — `term_results` (PI-04's per-term absence evidence; PI-08 register)
// ---------------------------------------------------------------------------

/**
 * `term_results` (searchFamily.ts's `FIND_FIELDS`) is additive, optional,
 * per-ORIGINAL-query-term absence evidence — "advisory evidence, not control
 * (never required-set)" in that file's own words. It survives rung 1's prose
 * peel: a hint is a suggestion, `term_results` is a certificate a caller can
 * act on without re-running anything, so it is not swept by
 * `shedMatchesProse`. But it is not the match content `find` exists to
 * deliver either, so it sheds BEFORE `files[]` starts losing snippets, lines
 * or whole entries at rung 6 — one whole-block drop, not the incremental
 * per-file cuts rung 6 makes.
 *
 * Rung 3's `RUNG_OMITTED_CLASS` is `"metadata"` — the same class rung 1
 * carries — and E5 exempts both from a `limit`/continuation: a caller that
 * still wants the per-term detail already holds the `queries[]` that produced
 * it and can re-issue the same `find` to regenerate it, so dropping it here
 * discloses nothing false and owes no recovery call.
 */
function shedTermResults(payload: ShedPayload): ShedOutcome | undefined {
  return dropInBlock(payload, "matches", ["term_results"], 3);
}

// ---------------------------------------------------------------------------
// Rung 6, sub-step 1 — `files[].snippets`
// ---------------------------------------------------------------------------

/**
 * Drop the `snippets` of the LAST file entry that still carries them.
 *
 * TAIL FIRST, because `find` orders `files[]` by the producer's own relevance
 * and the head is what the caller reads. One file per invocation, so the cut
 * goes exactly as far up the list as the overage requires.
 *
 * The continuation is the SAME query scoped to that one file, which returns its
 * snippets and nothing else — narrower than the call that produced this
 * response, and an exact recovery of what this step withheld.
 */
function shedFindSnippets(payload: ShedPayload, context: ShedContext): ShedOutcome | undefined {
  return cutInLastFile(payload, context, "snippets", (entry) => {
    const stripped = withoutKeys(entry, ["snippets"]);
    return stripped === undefined ? undefined : stripped.next;
  });
}

/**
 * Trim the TAIL of `files[].lines`, keeping the head.
 *
 * `lines` is the matched-line ledger — the addresses, not the bytes — so it is
 * cut after `snippets` and never below one entry: a file group that names no
 * line has stopped being a match report.
 */
function shedFindLines(payload: ShedPayload, context: ShedContext): ShedOutcome | undefined {
  return cutInLastFile(payload, context, "lines", (entry) => {
    const lines = arrayAt(entry, "lines");
    if (lines === undefined) return undefined;
    const trimmed = dropTrailingEntry(lines, 1);
    return trimmed === undefined ? undefined : withKey(entry, "lines", trimmed.next);
  });
}

/**
 * Shared driver for the two in-file sub-steps: find the last `files[]` entry
 * the rewrite applies to, apply it, and name the same query scoped to that
 * file.
 */
function cutInLastFile(
  payload: ShedPayload,
  context: ShedContext,
  marker: string,
  rewrite: (entry: Record<string, unknown>) => Record<string, unknown> | undefined,
): ShedOutcome | undefined {
  const matches = recordAt(payload, "matches");
  if (matches === undefined || str(matches["form"]) !== "find") return undefined;
  const files = arrayAt(matches, "files");
  if (files === undefined) return undefined;

  for (let i = files.length - 1; i >= 0; i -= 1) {
    const entry = files[i];
    if (!isRecord(entry) || entry[marker] === undefined) continue;
    const rewritten = rewrite(entry);
    if (rewritten === undefined) continue;
    const path = str(entry["path"]);
    if (path === undefined) return undefined;
    const continuation = findScopedNext(path, matches, { ...(context.args ?? {}) });
    if (continuation === undefined) return undefined;

    const nextFiles = [...files];
    nextFiles[i] = rewritten;
    return {
      next: withKey(payload, "matches", withKey(matches, "files", nextFiles)),
      note: { rung: 6, refs: [path] },
      continuation,
    };
  }
  return undefined;
}

/**
 * Drop one trailing `files[]` entry.
 *
 * FLOOR ONE ENTRY. A zero-hit `find` is a valid COMPLETE result carrying
 * `absence`, and the guide teaches it as such ("0-match+`absence`=that token
 * verifiably absent, no re-grep"). A response that shed its way down to zero
 * files would wear that shape while meaning the opposite; `total_files` still
 * tells the truth, but the cheapest reading of the response would not. Keeping
 * one entry keeps the two shapes distinguishable at a glance.
 */
function shedFindFile(payload: ShedPayload, context: ShedContext): ShedOutcome | undefined {
  const matches = recordAt(payload, "matches");
  if (matches === undefined || str(matches["form"]) !== "find") return undefined;
  const files = arrayAt(matches, "files");
  if (files === undefined) return undefined;
  const trimmed = dropTrailingEntry(files, 1);
  if (trimmed === undefined) return undefined;

  const path = isRecord(trimmed.dropped) ? str(trimmed.dropped["path"]) : undefined;
  if (path === undefined) return undefined;
  const continuation = findScopedNext(path, matches, { ...(context.args ?? {}) });
  if (continuation === undefined) return undefined;

  return {
    next: withKey(payload, "matches", withKey(matches, "files", trimmed.next)),
    note: { rung: 6, refs: [path] },
    continuation,
  };
}

// ---------------------------------------------------------------------------
// Rung 6 — the `symbols` form
// ---------------------------------------------------------------------------

/**
 * Drop one trailing `locations[]` entry on the `symbols` form.
 *
 * §5.5's sub-order is written for `find` and `symbols` has no snippets or lines
 * concept, so its rung 6 is the whole-record drop alone. The continuation is
 * the emitter's own `symbolsNext` — `{action:"symbols", limit: total, …}` —
 * which is exactly right here: `total` keeps reporting the TRUE pre-cut count
 * (the inventory never lies), so re-issuing with an explicit `limit` equal to
 * it is both executable and complete. It declines on its own when the request
 * named neither `query` nor `path`, and this step declines with it.
 *
 * FLOOR ONE, for the same reason as `find`: `locations: []` with a non-zero
 * `total` is a shape a caller reads as "nothing here".
 */
function shedSymbolLocation(payload: ShedPayload, context: ShedContext): ShedOutcome | undefined {
  const matches = recordAt(payload, "matches");
  if (matches === undefined || str(matches["form"]) !== "symbols") return undefined;
  const locations = arrayAt(matches, "locations");
  if (locations === undefined) return undefined;
  const trimmed = dropTrailingEntry(locations, 1);
  if (trimmed === undefined) return undefined;

  const withoutDropped = withKey(matches, "locations", trimmed.next);
  const nextMatches = withDecrementedSymbolCoverage(withoutDropped, trimmed.dropped);
  const continuation = symbolsNext(nextMatches, { ...(context.args ?? {}) });
  if (continuation === undefined) return undefined;

  return {
    next: withKey(payload, "matches", nextMatches),
    note: { rung: 6 },
    continuation,
  };
}

export const SEARCH_MATCHES_SHEDDER: Shedder = {
  kind: "search.matches",
  rungs: [
    { rung: 1, step: shedMatchesProse },
    { rung: 3, step: shedTermResults },
    { rung: 6, step: shedFindSnippets },
    { rung: 6, step: shedFindLines },
    { rung: 6, step: shedFindFile },
    { rung: 6, step: shedSymbolLocation },
  ],
  refusalConvertible: true,
};
