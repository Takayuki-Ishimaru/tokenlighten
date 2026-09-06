/**
 * surfaceServedCoverage.ts — the range-aware "does this surface already give
 * the caller everything a whole-file re-pack of its path could add" rules.
 *
 * SOURCE: DESIGN-v0.15-semantic-frontier-plan.md §12 rows 82-84 (R31-FIX,
 * wave B) introduced `canonicalDecision.ts`'s (then-)`bundleTargetAlreadyServed`
 * (E2): a discovery-bundle candidate is dropped once the epoch ledger lists
 * its path OR THIS pack already embeds non-empty `code` for it. That second
 * clause is PATH-LEVEL, not RANGE-level — a surface sliced down to one line
 * of a two-line file (an `answer-explicit-symbol-focus` zoom that missed a
 * sibling identifier on the file's OTHER line) trips it exactly as a truly
 * complete whole-file surface would, so the bundle that would have re-packed
 * the file WHOLE (closing the missing-identifier gap, restoring `act.answer`)
 * never rides. Regression: case pair sf-flag-control/sf-flag-treatment,
 * fixture bench/workflows/fixtures/semantic-frontier/branch-catalog.
 *
 * TWO DIFFERENT QUESTIONS, TWO DIFFERENT PREDICATES:
 *
 *  - `surfaceExceedsRepackBudget` answers "would re-requesting this path
 *    reproduce the SAME anchor window rather than add anything" — the
 *    original E2 motivation (r9 SF13 shape: a large file's anchor-focused
 *    embed with a real disclosed remainder). This is the one case where
 *    re-including the path in a bundle's `paths`/`targets` array is actively
 *    WASTEFUL/a self-loop, so `canonicalDecision.ts`'s `discoveryBundleNext`
 *    uses it to DROP the path from the array entirely.
 *
 *  - `surfaceAlreadyCoversWholeFile` answers the broader "has this pack (or
 *    an earlier one) already given the caller the whole file" — true for the
 *    above PLUS a small, already-complete whole-file embed. Re-including
 *    such a path in a bundle costs nothing (the file is tiny), so it is used
 *    only to gate whether a bundle is WORTH FIRING at all
 *    (`hasUnservedRelatedNode`) and to compute the epoch ledger's
 *    `fullyServed` flag (`packServeLog.ts`'s `ServedSurfaceEntry.fullyServed`,
 *    which a LATER call's `stampEpochServedPaths` filters on) — never to drop
 *    a path from `paths` within the SAME pack, which would shrink a
 *    legitimate single-gap bundle below the 2-path floor and silence it
 *    entirely (the sf-flag-control/treatment regression).
 *
 * WHY NO BYTE-DENSITY ESTIMATE (measured, replayCorpus.spec.ts sf13e1/sf13w1):
 * an earlier version of this module estimated the whole file's bytes from
 * the served slice's OWN bytes-per-line density (servedBytes/servedLines *
 * remainingLines) and compared that estimate to `MAX_SURFACE_CODE_BYTES`.
 * The real sf13 fixture's `qkf.cpp` disproved it: an 11-line, ~380-byte
 * `isHealthy()` header sits next to a 160-line VERBOSE filler block
 * (`remaining_ranges:["12-201"]`) whose own density is roughly 4x the header
 * lines' — the estimate came out well under the cap (~7 KB) for a file that
 * genuinely overflows it, so `qkf.cpp` stayed in `paths` and reproduced the
 * exact self-loop E2 exists to prevent. A served slice's density says nothing
 * reliable about a DIFFERENT, undisclosed part of the same file. The literal,
 * generic fact this module CAN trust instead: `remaining_ranges` is non-empty
 * at all — a REAL disclosed remainder, whatever its size, is exactly the E2
 * shape (an anchor/symbol match in a file that has more elsewhere), and
 * conservatively excluding it from `paths` only ever gives up the (cheap,
 * rare) case of a small file whose symbol match happens to not start at line
 * 1 — the SAME exclusion every one of these surfaces already had before this
 * module existed (`code.length > 0` alone). The sf-flag-control regression's
 * shape is different: an EMPTY `remaining_ranges` (clause (a) below), which
 * this module targets precisely.
 *
 * Ways a surface counts as "nothing more THIS bundle mechanism should
 * request" (checked in this order; (b)/(b') are `surfaceExceedsRepackBudget`,
 * (a) is `surfaceAlreadyCoversWholeFile`'s own remaining branch):
 *  (b) a `content_completeness:"partial"` surface had its OWN embed already
 *      cut short by `readCodeTaskPack.ts`'s `MAX_SURFACE_CODE_BYTES` cap —
 *      direct proof the file exceeds a re-pack's budget, so re-requesting it
 *      would only reproduce the same anchor window. Checked first: it
 *      overrides whatever `remaining_ranges` does or does not disclose.
 *  (b') otherwise ANY non-empty `remaining_ranges` — a COMPLETE symbol embed
 *      in a file that merely has more lines outside it
 *      (`partialityStamp`'s unstamped case) is architecturally
 *      indistinguishable, from surface data alone, between "a few short
 *      lines" and "a large, dense remainder" (see the qkf.cpp measurement
 *      above), so treat any real disclosure as proof a re-pack would only
 *      reproduce this same anchor window.
 *  (a) nothing was disclosed as remaining AND the served range itself starts
 *      at line 1 — the literal "range 1-<total_lines>" test. A narrow,
 *      non-1-start range (e.g. "2-2" of a 2-line file) with an empty
 *      `remaining_ranges` is the exact regression shape (an
 *      `answer-explicit-symbol-focus` slice whose disclosure bookkeeping did
 *      not name the file's other line) and must NOT be trusted as "nothing
 *      left" — that silently blocked the whole-file re-pack that would have
 *      closed the identifier gap.
 */

export interface CoverageProbeSurface {
  readonly code?: string;
  readonly code_unchanged?: string;
  readonly range?: string;
  readonly content_completeness?: "partial";
  readonly remaining_ranges?: readonly string[];
}

function parseLineSpan(value: string | undefined): { start: number; end: number } | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(\d+)-(\d+)$/.exec(value);
  if (match === null) return undefined;
  const start = Number(match[1]);
  const end = Number(match[2]);
  return Number.isInteger(start) && Number.isInteger(end) && start >= 1 && end >= start
    ? { start, end }
    : undefined;
}

/**
 * True only when re-requesting this path stands to reproduce the SAME
 * already-served anchor window rather than add anything — clauses (b)/(b')
 * above. `false` is not "not yet served"; it just means THIS predicate finds
 * no proof of a wasteful re-pack (a small, genuinely complete embed still
 * answers `false` here — see `surfaceAlreadyCoversWholeFile` for that case).
 */
export function surfaceExceedsRepackBudget(surface: CoverageProbeSurface): boolean {
  // A same-pack `code_unchanged` restatement duplicates an earlier surface's
  // exact block+range; nothing more to gain by naming this path again.
  if (typeof surface.code_unchanged === "string" && surface.code_unchanged.length > 0) return true;
  if (typeof surface.code !== "string" || surface.code.length === 0) return false;

  // A cap-driven trim of the surface's OWN served window is direct proof the
  // file exceeds a re-pack's budget, regardless of what `remaining_ranges`
  // does or does not disclose.
  if (surface.content_completeness === "partial") return true;

  // A real disclosed remainder, of ANY size: see this module's header for why
  // estimating from the served slice's own byte density is unreliable and
  // was measured to reintroduce the exact self-loop this predicate exists to
  // prevent (replayCorpus.spec.ts sf13e1/sf13w1, fixture `qkf.cpp`).
  return (surface.remaining_ranges?.length ?? 0) > 0;
}

/**
 * True when `surface`'s own served body already amounts to everything a
 * whole-file re-pack of its path could add — either because re-requesting it
 * would be wasteful (`surfaceExceedsRepackBudget`) or because it is already a
 * small, complete whole-file embed (clause (a)). Returns `false` whenever the
 * surface carries no evidence at all — an absent/empty `code` is not this
 * predicate's business; callers gate on that separately.
 */
export function surfaceAlreadyCoversWholeFile(surface: CoverageProbeSurface): boolean {
  if (typeof surface.code_unchanged === "string" && surface.code_unchanged.length > 0) return true;
  if (typeof surface.code !== "string" || surface.code.length === 0) return false;
  if (surfaceExceedsRepackBudget(surface)) return true;

  // `surfaceExceedsRepackBudget` already returned `false`, so any real
  // `remaining_ranges` disclosure was ruled out above — only the empty case
  // reaches here.
  const span = parseLineSpan(surface.range);
  // An unparseable/degenerate range names no safe re-pack target; treat the
  // file as closed rather than invite a repeat of an already-served shape.
  if (span === undefined) return true;

  // Nothing was disclosed as remaining. Trust that as proof of whole-file
  // coverage only when the served range actually STARTS at line 1 — clause
  // (a)'s literal "range 1-<total_lines>" test. A narrow, non-1-start range
  // (e.g. "2-2" of a 2-line file) with an empty `remaining_ranges` is the
  // exact regression shape (an `answer-explicit-symbol-focus` slice whose
  // disclosure bookkeeping did not name the file's other line): default to
  // NOT proven closed rather than trust a disclosure gap silently.
  return span.start === 1;
}
