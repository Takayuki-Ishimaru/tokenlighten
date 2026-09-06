// ---------------------------------------------------------------------------
// coverageReceipt.ts — W-LEDGER (DESIGN-v0.15-sf-turn-economy.md §2)
//
// WHAT THIS MODULE IS. `protocol/readFamily.ts`'s `receiptOf` decides
// `code-unchanged` from `handle` + `sha`: ONE serving call's identity. A
// handle is "path + range (or symbol)" fixed by one call, so L1-40 and L30-70
// are two handles even though the caller demonstrably already holds L30-40.
// `state/session.ts`'s `servedRangeLedger` is the OTHER axis — per PATH,
// content-hash-bound, cumulative per-serve `spans` — and DC3 ratified it as
// the single source of truth for byte residency. Nothing bridged the two, so
// §2.1's forensics measured 2-8 duplicate reads answered by 0-3 receipts.
//
// This module is that bridge, and NOTHING ELSE: a PURE decision function over
// the ledger's existing public accessors. It reads no files, mutates no
// session state, and emits no wire bytes. Its caller (a read emit site) turns
// the verdict into either a `read.receipt` (`full`) or a narrowed `read.text`
// (`partial`), using the `remaining` vocabulary those emitters already have.
//
// WHY A SEPARATE MODULE AND NOT A `state/session.ts` ADDITION. Everything
// here is DERIVED from three already-audited exports (`servedRangeReceipt`,
// `servedRangeCoverage`, `servedPathProvenance`). Deriving in a leaf keeps the
// ledger's own honesty surface — the thing `servedReceiptElisionHonesty.spec.ts`
// pins — exactly as wide as it is today: this module cannot manufacture
// coverage the ledger does not already report, because it never touches
// `spans` and never writes.
//
// THE HONESTY CONTRACT (A.4, and the 2026-08-02 serve-honesty wave). Every
// line named in `covered_by` must have been on some earlier response's WIRE,
// in THIS lane and THIS workspace. The five structural guarantees:
//
//   1. sha. `servedRangeCoverage`/`servedRangeReceipt` return `undefined`
//      unless `state.fileSha` equals the sha the caller computed from the
//      bytes on disk RIGHT NOW (session.ts:5549-5553, 4526-4527). The caller
//      re-hashes on demand; a mismatch is `none`, never a narrowed serve.
//   2. edits. An `edit.applied` leaves the entry pinned to the PRE-edit sha,
//      so (1) already fails for every post-edit read. With TL_DELTA_CONTEXT on,
//      `transformServedRangesAcrossServerEdit` (session.ts:4835) re-projects
//      the spans and re-pins `fileSha` to the post-edit sha; this module then
//      reads the re-projected spans, which is precisely what §2.3 asks for.
//   3. lane. The ledger lives in `getSession(workspace)`, keyed by
//      (root, lane) via `laneScopedKey`. A caller that declares a `lane` has
//      it checked against the bound one — a mismatch is `none`, so a helper
//      invoked outside its `runWithSessionLane` scope cannot borrow a peer
//      lane's residency (the F-V13-3 failure mode, one store one slot).
//   4. workspace. The root IS the session key; two worktrees are two ledgers.
//   5. `force_serve`. A caller that has lost its context is never receipted.
//
// FLAG. `TL_RECEIPT_COVERAGE`, default OFF (util/flags.ts:885). Off, every
// call returns `{kind:"none", reason:"flag-off"}` before touching the session,
// and `readFamily.ts` drops `covered_by` in the projector — two independent
// gates, so the default wire is byte-identical by construction rather than by
// audit.
// ---------------------------------------------------------------------------

import {
  hasServedRangeLedgerEntry,
  servedPathProvenance,
  servedRangeCoverage,
  servedRangeReceipt,
} from "../state/session.js";
import { currentSessionLane } from "../util/laneKey.js";
import { receiptCoverageEnabled } from "../util/flags.js";

/**
 * One already-held run of file lines, and the earlier call that put it on the
 * wire. `range` is the protocol's own 1-BASED INCLUSIVE `"<start>-<end>"`
 * spelling — the same dialect `Evidence.range`, `Evidence.remaining` and the
 * ledger receipt's `served[]` already use — rather than §2.2's sketched
 * `{start, end}`, so a consumer parses one range grammar and not two.
 *
 * `served_by` is PROVENANCE ONLY (A.4's rule for the scalar `served_by` it
 * pluralises): absence means the ledger cannot name the call, never that the
 * bytes are unproven. The bytes are proven by the entry existing at all.
 */
export interface CoveredSpan {
  /** 1-based inclusive, `"<start>-<end>"`. */
  range: string;
  /** e.g. `slice 1-40 (call #2)`; absent when provenance is unrecoverable. */
  served_by?: string;
}

/** Why a request is NOT eligible for a coverage receipt. Diagnostic; never wire. */
export type CoverageMissReason =
  | "flag-off"
  | "force-serve"
  | "lane-mismatch"
  | "no-ledger-entry"
  | "sha-mismatch"
  | "empty-file"
  | "unresolved-symbol"
  | "no-overlap";

export type CoverageVerdict =
  /**
   * Every requested line is already held at this sha. The caller answers with
   * `read.receipt` / `code-unchanged` and serves NO bytes.
   */
  | {
      kind: "full";
      /** Short sha, as the ledger receipt reports it. */
      sha: string;
      /** The single `served_by` for the whole window, when one call covers it. */
      served_by?: string;
      covered_by: [CoveredSpan, ...CoveredSpan[]];
      /** True when the ledger holds the WHOLE file at this sha. */
      complete: boolean;
    }
  /**
   * Some requested lines are held and some are not. The caller serves ONLY
   * `remainder` and reports `covered_by`; `remaining` keeps its existing zoom
   * meaning (windows of this request the response does not carry).
   */
  | {
      kind: "partial";
      sha: string;
      covered_by: [CoveredSpan, ...CoveredSpan[]];
      /** Uncovered sub-windows, ascending, 1-based inclusive. */
      remainder: Array<[number, number]>;
      /** `remainder`, in the wire's `"<a>-<b>"` spelling. */
      remaining: string[];
      /** Lines of the request the caller already holds. */
      covered_lines: number;
      /** Lines of the request the caller must still be sent. */
      uncovered_lines: number;
    }
  /** Serve normally. */
  | { kind: "none"; reason: CoverageMissReason };

/**
 * What the caller asked for, as a discriminated union so "a symbol that no
 * longer resolves" cannot be spelled the same way as "the whole file".
 *
 *  - `"full"`   — `content:"full"`. Compared against `1..totalLines`, which IS
 *                 the whole-file-after-slices case: the remainder of a
 *                 partially-served file falls out of the same arithmetic.
 *  - `"range"`  — an explicit window, 1-based INCLUSIVE (protocol dialect).
 *  - `"symbol"` — §2.2 rule 3: symbol and range share one coordinate system, so
 *                 the caller resolves the symbol to its CURRENT line range and
 *                 this module applies the identical overlap test. Resolving
 *                 FIRST is what makes symbol drift across an edit safe — the
 *                 post-edit range meets post-edit spans. An unresolvable symbol
 *                 carries no `range` and is `unresolved-symbol`, never a receipt.
 */
export type CoverageWant =
  | { want: "full" }
  | { want: "range"; start: number; end: number }
  | { want: "symbol"; range?: { start: number; end: number } };

export type CoverageRequest = CoverageWant & {
  /**
   * The RESOLVED workspace root — the same string the emit site passes to
   * `recordServedRange`. Lane scoping is applied by `getSession` from the
   * ambient `runWithSessionLane` binding, not from the `lane` field below.
   */
  workspace: string;
  /** The ledger key: the same path spelling the recording site books. */
  path: string;
  /** sha of the bytes on disk RIGHT NOW. The caller re-hashes; this is (1). */
  sha: string;
  /** The file's own line count at `sha`. */
  totalLines: number;
  /** `task.force_serve:true`. A caller that lost its context is never receipted. */
  forceServe?: boolean;
  /**
   * The caller's declared lane, when it has one. Checked against the lane
   * actually bound by `runWithSessionLane`; a mismatch is `lane-mismatch`.
   * Omit when the call site is already inside its own lane scope.
   */
  lane?: string | undefined;
};

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

function spell(start: number, end: number): string {
  return `${start}-${end}`;
}

/**
 * Intersections of `[start,end]` with `served`, ascending. `served` arrives
 * merged and ascending from `servedRangeCoverage` (it is `state.ranges`, the
 * capped projection of `spans`) — CONSERVATIVE by construction, since the caps
 * only ever drop coverage, never invent it.
 */
function intersect(
  served: ReadonlyArray<readonly [number, number]>,
  start: number,
  end: number,
): Array<[number, number]> {
  const hits: Array<[number, number]> = [];
  for (const [rangeStart, rangeEnd] of served) {
    const low = Math.max(start, rangeStart);
    const high = Math.min(end, rangeEnd);
    if (low <= high) hits.push([low, high]);
  }
  return hits.sort((left, right) => left[0] - right[0]);
}

/** The complement of `hits` inside `[start,end]`. */
function complement(
  hits: ReadonlyArray<readonly [number, number]>,
  start: number,
  end: number,
): Array<[number, number]> {
  const gaps: Array<[number, number]> = [];
  let cursor = start;
  for (const [low, high] of hits) {
    if (cursor < low) gaps.push([cursor, low - 1]);
    cursor = Math.max(cursor, high + 1);
  }
  if (cursor <= end) gaps.push([cursor, end]);
  return gaps;
}

/**
 * The W-LEDGER decision. See the module header for the honesty contract.
 *
 * Returns `none` for every doubt: no entry, a sha that moved, a symbol that
 * no longer resolves, a lane that is not the bound one, `force_serve`, or the
 * flag being off. A `none` costs one redundant serve; a wrong `full` costs the
 * caller code it never saw (A.8.1 E-1 / A.4), so the asymmetry is deliberate
 * and matches `servedRangeReceipt`'s own "deliberately CONSERVATIVE" stance.
 */
export function coverageReceiptFor(request: CoverageRequest): CoverageVerdict {
  if (!receiptCoverageEnabled()) return { kind: "none", reason: "flag-off" };
  if (request.forceServe === true) return { kind: "none", reason: "force-serve" };

  // (3) lane. `getSession` keys on (root, ambient lane); a declared lane that
  // is not the bound one means this call would read a PEER lane's residency.
  if (request.lane !== undefined && request.lane !== "" && request.lane !== currentSessionLane()) {
    return { kind: "none", reason: "lane-mismatch" };
  }

  const totalLines = Math.floor(request.totalLines);
  if (!Number.isFinite(totalLines) || totalLines < 1) {
    return { kind: "none", reason: "empty-file" };
  }

  // Rule 3: a symbol request is decided on its CURRENT range; a symbol that no
  // longer resolves is a miss, not a whole-file comparison.
  const window = request.want === "symbol"
    ? request.range
    : request.want === "range"
      ? { start: request.start, end: request.end }
      : { start: 1, end: totalLines };
  if (window === undefined) return { kind: "none", reason: "unresolved-symbol" };

  // Same clamping as `recordServedRange` (session.ts:4565-4566), so a request
  // that runs past EOF is compared against real file lines and ND-4's
  // "a window entirely past EOF denotes no bytes" stays true.
  const start = clamp(Math.floor(window.start), 1, totalLines);
  const end = clamp(Math.floor(window.end), start, totalLines);

  // (1) sha, and the existence check. `servedRangeCoverage` collapses "no
  // entry" and "entry at another sha" into one `undefined`; split them so the
  // miss reason is diagnosable.
  const coverage = servedRangeCoverage(request.workspace, request.path, request.sha, totalLines);
  if (coverage === undefined) {
    return hasServedRangeLedgerEntry(request.workspace, request.path)
      ? { kind: "none", reason: "sha-mismatch" }
      : { kind: "none", reason: "no-ledger-entry" };
  }

  const hits = intersect(coverage.served, start, end);
  if (hits.length === 0) return { kind: "none", reason: "no-overlap" };

  const coveredBy = hits.map((hit): CoveredSpan => {
    const label = servedPathProvenance(request.workspace, request.path, hit);
    return { range: spell(hit[0], hit[1]), ...(label !== undefined ? { served_by: label } : {}) };
  }) as [CoveredSpan, ...CoveredSpan[]];

  // FULL is decided by `servedRangeReceipt`, not by this module's arithmetic:
  // that function subsumes from the UNMERGED `spans` (F2's "the property is
  // local to one array and cannot be manufactured by an accumulator"), which
  // is the audited honesty path. The arithmetic above only ever narrows what
  // it would say, because `coverage.served` is the capped projection of the
  // same spans.
  const held = servedRangeReceipt(
    request.workspace,
    request.path,
    request.sha,
    start,
    end,
    totalLines,
  );
  if (held !== undefined) {
    return {
      kind: "full",
      sha: held.sha,
      ...(held.served_by !== undefined ? { served_by: held.served_by } : {}),
      covered_by: coveredBy,
      complete: held.complete,
    };
  }

  const remainder = complement(hits, start, end);
  if (remainder.length === 0) {
    // Unreachable in practice: an empty complement means one merged cluster of
    // `coverage.served` spans the request, which `servedRangeReceipt` would
    // have subsumed. Fail to a normal serve rather than mint a `partial` that
    // carries no bytes to serve.
    return { kind: "none", reason: "no-overlap" };
  }
  const coveredLines = hits.reduce((sum, [low, high]) => sum + (high - low + 1), 0);
  return {
    kind: "partial",
    sha: request.sha.slice(0, 12),
    covered_by: coveredBy,
    remainder,
    remaining: remainder.map(([low, high]) => spell(low, high)),
    covered_lines: coveredLines,
    uncovered_lines: end - start + 1 - coveredLines,
  };
}

/**
 * The `covered_by` an emitter stamps on a `code-unchanged` body. Kept here so
 * the emit sites and `readFamily.ts`'s projector agree on the shape by
 * construction; E-1 (A.8.1) forbids an empty array standing in for absence, so
 * this returns `undefined` rather than `[]`.
 */
export function coveredByField(verdict: CoverageVerdict): CoveredSpan[] | undefined {
  if (verdict.kind === "none") return undefined;
  return verdict.covered_by.length > 0 ? verdict.covered_by : undefined;
}
