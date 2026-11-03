// callerRangeDelivery — extracted implementation; imports point to the owning modules.
import type { CallerRangePreTrimSnapshot } from "./servedStateAndEdits3.js";
import type { CertificateCitation } from "../certificateWireInvariant.js";
import type { ServedSpans } from "../certificateWireInvariant.js";
import type { TaskPackResult } from "../model.js";
import type { TaskPackSurface } from "../model.js";
import { FileReadCache } from "./packBasics2.js";
import { MAX_SURFACE_CODE_BYTES } from "./packBasics2.js";
import { activePackByteCeiling } from "./packBasics2.js";
import { breachedCitations } from "../certificateWireInvariant.js";
import { callableBodiesNotShown } from "./changeAndReadinessEvidence.js";
import { centeredSliceForCap } from "./packBasics2.js";
import { certificateCitations } from "../certificateWireInvariant.js";
import { certificateWireBreaches } from "../certificateWireInvariant.js";
import { certifiedSurfacesOf } from "./answerCertificates.js";
import { clampToActiveCeiling } from "./packBasics2.js";
import { codeTaskPackSurfaces } from "../artifactSections.js";
import { countLines } from "../../../util/countLines.js";
import { deriveCanonicalTaskDecision } from "../canonicalDecision.js";
import { elideDocCommentsWithWindows } from "../../../util/formatCompress.js";
import { evidenceRereadCall } from "./answerCertificates2.js";
import { failClosedToEvidenceReread } from "./answerCertificates2.js";
import { fitsInCap } from "./packTrimming2.js";
import { foldSmallRemainderEnabled } from "../../../util/flags.js";
import { handleTable } from "../../../util/handles.js";
import { hasCallableBody } from "./changeAndReadinessEvidence2.js";
import { isCallerRangeSurface } from "../sfWithholdingMarks.js";
import { isCandidateListPack } from "./recursiveClosure3.js";
import { isExplicitRangeSurface } from "../sfWithholdingMarks.js";
import { isMarkdownPath } from "../../../util/markdownSections.js";
import { isTraceEnabled } from "../../../util/trace.js";
import { languageForPath } from "../../../util/languages.js";
import { packServedSpans } from "./packState2.js";
import { parsePackLineRange } from "./packState2.js";
import { parseSurfaceSpan } from "./packState2.js";
import { readCached } from "./packBasics2.js";
import { sliceCode } from "./packBasics2.js";
import { trace } from "../../../util/trace.js";
import { unservedCitedWindows } from "../certificateWireInvariant.js";
import { wasSemanticFrontierBodyWithheld } from "../sfWithholdingMarks.js";
import { withResidentSpans } from "./answerCertificates.js";

/** Every `result.surfaces` entry `markCallerRangeSurface` marked, snapshotted before trimToCap can touch it. Call BEFORE `trimToCap`. */
export function snapshotCallerRangeSurfaces(result: TaskPackResult): Map<TaskPackSurface, CallerRangePreTrimSnapshot> {
  const snapshot = new Map<TaskPackSurface, CallerRangePreTrimSnapshot>();
  for (const surf of result.surfaces) {
    if (!isCallerRangeSurface(surf)) continue;
    snapshot.set(surf, {
      code: surf.code,
      remainingRanges: surf.remaining_ranges,
      contentCompleteness: surf.content_completeness,
    });
  }
  return snapshot;
}

/** Real (non-trailing-newline) line count of a served body — `""` (`code === ""`, never produced today) counts as zero lines. */
export function displayLineCount(text: string): number {
  if (text === "") return 0;
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.length;
}

/**
 * The 1-based SOURCE line the first `keptDisplayLines` display lines of a
 * body starting at `startLine` reach, given that body's own elision windows
 * (ascending, non-overlapping, FILE-absolute — `elideDocCommentsWithWindows`'s
 * `elided`). A marker line consumes ONE display line but represents its
 * WHOLE source span (`windowEnd - windowStart + 1` source lines), matching
 * the renderer's own accounting exactly (this is the same walk
 * `elideCBlockComments`/`elidePythonDocstrings` performs to PRODUCE the
 * marker, run forward instead of being re-derived from output text).
 * `ceiling` bounds the result the way `spansExcludingWindows`' own `rangeEnd`
 * bounds a window: a body can never be credited with source lines past it.
 */
export function sourceLineAfterDisplayLines(
  startLine: number,
  elided: ReadonlyArray<readonly [number, number]>,
  keptDisplayLines: number,
  ceiling: number,
): number {
  if (keptDisplayLines <= 0) return startLine - 1;
  let sourceCursor = startLine;
  let displayLinesUsed = 0;
  for (const [winStart, winEnd] of elided) {
    if (winStart < sourceCursor) continue; // window behind the cursor already (defensive; elided is ascending)
    const normalCount = winStart - sourceCursor;
    if (displayLinesUsed + normalCount >= keptDisplayLines) {
      const consumed = keptDisplayLines - displayLinesUsed;
      return Math.min(ceiling, sourceCursor + consumed - 1);
    }
    displayLinesUsed += normalCount;
    sourceCursor = winStart;
    displayLinesUsed += 1; // the marker line itself
    if (displayLinesUsed >= keptDisplayLines) return Math.min(ceiling, winEnd);
    sourceCursor = winEnd + 1;
  }
  const remaining = keptDisplayLines - displayLinesUsed;
  return Math.min(ceiling, sourceCursor + remaining - 1);
}

/** Elision windows (FILE-absolute) for the real source underlying `[requestedStart, ceiling]` of `relPath` — `[]` for a non-elidable language or an unreadable file, matching `elideDocCommentsWithWindows`'s own no-op shape. */
export function callerRangeElisionWindows(
  workspace: string,
  relPath: string,
  requestedStart: number,
  ceiling: number,
  cache?: FileReadCache,
): Array<[number, number]> {
  const sourceText = readCached(workspace, relPath, cache);
  if (sourceText === undefined) return [];
  const sourceLines = sourceText.split(/\r?\n/);
  const clampedCeiling = Math.min(ceiling, sourceLines.length);
  if (clampedCeiling < requestedStart) return [];
  const slice = sourceLines.slice(requestedStart - 1, clampedCeiling).join("\n");
  const lang = languageForPath(relPath);
  return elideDocCommentsWithWindows(slice, lang, requestedStart).elided;
}

/** Merge "a-b" windows: parse, sort by start, merge overlapping/contiguous runs, re-render ordered and deduplicated. */
export function mergeRangeStrings(ranges: readonly string[]): string[] {
  const parsed: Array<[number, number]> = [];
  for (const range of ranges) {
    const m = /^(\d+)-(\d+)$/.exec(range);
    if (m === null) continue;
    const start = Number(m[1]);
    const end = Number(m[2]);
    if (end >= start) parsed.push([start, end]);
  }
  parsed.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of parsed) {
    const last = merged[merged.length - 1];
    if (last !== undefined && start <= last[1] + 1) {
      last[1] = Math.max(last[1], end);
    } else {
      merged.push([start, end]);
    }
  }
  return merged.map(([start, end]) => `${start}-${end}`);
}

export function reconcileCallerRangeRemaining(
  result: TaskPackResult,
  workspace: string,
  preTrim: ReadonlyMap<TaskPackSurface, CallerRangePreTrimSnapshot>,
  cache?: FileReadCache,
): void {
  for (const surf of codeTaskPackSurfaces(result.surfaces)) {
    const snapshot = preTrim.get(surf);
    if (snapshot === undefined) continue; // not a marked caller-range surface
    // Requirement 1: trimToCap did not touch this surface's body at all —
    // leave it byte-identical to whatever trimToCap already returned.
    if (surf.code === snapshot.code) continue;

    const requested = /^(\d+)-(\d+)$/.exec(surf.range);
    if (requested === null) continue;
    const requestedStart = Number(requested[1]);
    const requestedEnd = Number(requested[2]);

    if (snapshot.code === undefined) continue; // nothing to map a cut FROM

    // The pre-trim body's OWN true source coverage — requirement 3 is
    // explicit that this is NOT necessarily requestedEnd (an earlier,
    // more generous construction pass may already have windowed it short).
    const elided = callerRangeElisionWindows(workspace, surf.path, requestedStart, requestedEnd, cache);
    const preTrimEnd = sourceLineAfterDisplayLines(
      requestedStart, elided, displayLineCount(snapshot.code), requestedEnd,
    );

    if (surf.code === undefined) {
      // trimToCap's Phase F stripped the body entirely: the pre-trim body's
      // WHOLE span is undelivered, not just some stale tail of it.
      surf.content_completeness = "partial";
      surf.remaining_ranges = mergeRangeStrings([
        `${requestedStart}-${preTrimEnd}`,
        ...(snapshot.remainingRanges ?? []),
      ]);
      continue;
    }

    // trimToCap's Phase E halving always keeps a PREFIX of the pre-trim
    // DISPLAY text (`lines.slice(0, kept)`), so the kept body's display-line
    // count against the SAME elision windows gives the true source line it
    // now reaches.
    const deliveredEnd = sourceLineAfterDisplayLines(
      requestedStart, elided, displayLineCount(surf.code), preTrimEnd,
    );

    if (deliveredEnd >= preTrimEnd) {
      // The kept body still reaches as far (in source terms) as the
      // pre-trim body did — e.g. a marker absorbed the cut lines — so
      // nothing new is undelivered. Restate the pre-trim value exactly
      // rather than reusing whatever `surf.remaining_ranges` trimToCap
      // itself already wrote (which may be the false superset this fix
      // exists to remove).
      surf.content_completeness = snapshot.contentCompleteness;
      surf.remaining_ranges = snapshot.remainingRanges === undefined
        ? undefined : [...snapshot.remainingRanges];
      continue;
    }

    surf.content_completeness = "partial";
    surf.remaining_ranges = mergeRangeStrings([
      `${deliveredEnd + 1}-${preTrimEnd}`,
      ...(snapshot.remainingRanges ?? []),
    ]);
  }
}

/**
 * GATE-A (2026-09-21): the last line in `(floorExclusive, ceiling]` that both
 * EXISTS in `relPath`'s CURRENT content and is not blank/whitespace-only — or
 * `floorExclusive` when every line in that window is beyond EOF or blank.
 *
 * `settleCallerRangeDelivery` below needs this because a DISPLAY-line count
 * mapped back to a source line cannot distinguish "a real line beyond it was
 * cut" from "every line beyond it is blank, so joining the body's lines with
 * a newline produced the exact same bytes as if they had never been sliced in
 * at all" (`Array.prototype.join` cannot represent a trailing blank element
 * distinctly from one fewer element — `["a", ""].join("\n")` is byte-identical
 * to `["a"].join("\n") + "\n"`). A requested end past the file's CURRENT
 * length is the same question from the other side: there is no byte there to
 * omit either. Both are resolved the same way — read the source once, trim
 * the tail — rather than re-derived a second time from rendered text.
 *
 * Returns `ceiling` unchanged when the source cannot be read, matching the
 * pre-fix behavior, since blankness cannot be verified without it.
 */
export function trailingBlankOrMissingTrimmedEnd(
  workspace: string,
  relPath: string,
  floorExclusive: number,
  ceiling: number,
  cache?: FileReadCache,
): number {
  const sourceText = readCached(workspace, relPath, cache);
  if (sourceText === undefined) return ceiling;
  const sourceLines = sourceText.split(/\r?\n/);
  let end = Math.min(ceiling, countLines(sourceText));
  while (end > floorExclusive) {
    const text = sourceLines[end - 1];
    if (text !== undefined && text.trim() !== "") return end;
    end -= 1;
  }
  return floorExclusive;
}

/**
 * TL-01 (2026-09-21) — `U = R − S`, computed from the body that ACTUALLY SHIPS.
 *
 * `reconcileCallerRangeRemaining` above settles a caller-ranged surface against
 * the SNAPSHOT `trimToCap` was handed, which is exactly right for the cut
 * trimToCap itself made and says nothing about a later one. This function needs
 * no snapshot: it re-derives, for every surviving caller-range-marked surface,
 * the source line its CURRENT body reaches, and unions whatever is left of the
 * caller's own requested window into `remaining_ranges`.
 *
 * WIDENING-ONLY, deliberately. It never clears an entry and never narrows one:
 * the undelivered set can only be under-stated by an upstream pass, never
 * over-stated, and a `remaining` this cannot corroborate is still honest. That
 * also makes it idempotent, so running it after a later mutation is safe.
 *
 * PREFIX ASSUMPTION, stated: a caller-ranged surface's body is head-anchored at
 * the caller's own start line (`explicitSeedStart`), and every pass that can
 * shorten it keeps a leading prefix (`trimToCap` Phase E's `lines.slice(0,
 * kept)`, Phase F's whole-body strip, `reduceCallerNamedBody`'s own ladder).
 * This is the SAME assumption `reconcileCallerRangeRemaining` and
 * `reduceCallerNamedBody` already document and rely on. Elision is accounted
 * for the sanctioned way — `callerRangeElisionWindows` +
 * `sourceLineAfterDisplayLines`, never by re-parsing rendered marker text — so
 * a COMPLETE body containing a doc-elision marker still settles to
 * `deliveredEnd === requestedEnd` and gains no false `remaining`.
 *
 * GATE-A (2026-09-21): raw `deliveredEnd` can UNDER-count by exactly the
 * source's own trailing blank/whitespace-only lines within the requested
 * window (see `trailingBlankOrMissingTrimmedEnd`'s doc comment) — measured on
 * a caller-named whole-file target whose file's last line is blank: clean HEAD
 * certified `act.answer`; this function, unpatched, flipped it to `discover`
 * with a `next` for a line that serves empty. A requested end beyond the
 * file's CURRENT length is the same blind spot from the other side. Both are
 * resolved the same way, once, against the real source, before
 * `remaining_ranges` is ever written — never by re-deriving from rendered
 * text a second time. Still widening-only: the span added below can only
 * shrink or disappear relative to the OLD `${deliveredEnd + 1}-${requestedEnd}`,
 * it is never wider, and an entry another pass already wrote is still never
 * narrowed.
 */
export function settleCallerRangeDelivery(
  result: TaskPackResult,
  workspace: string,
  cache?: FileReadCache,
): void {
  for (const surf of codeTaskPackSurfaces(result.surfaces)) {
    if (!isCallerRangeSurface(surf)) continue;
    const requested = /^(\d+)-(\d+)$/.exec(surf.range);
    if (requested === null) continue;
    const requestedStart = Number(requested[1]);
    const requestedEnd = Number(requested[2]);
    if (requestedEnd < requestedStart) continue;

    // A `code_unchanged` row is FULLY DELIVERED, and its value is a residency
    // POINTER, not a body ("<handle> — see prior pack"; §2.3's `prior` on the
    // wire). The dedup that writes it refuses to claim residency over a
    // disclosed-partial surface — see its own "A disclosed-partial body is NOT
    // the whole `range`" guard — so its presence means the caller already holds
    // this window in full. Measuring the pointer's own line count instead
    // stamped a `remaining` over four lines the caller could already read, and
    // demoted a `prepared` certificate to `discover` (replay corpus
    // `v0142a3c_bare_qref_repack_keeps_act_edit`).
    if (surf.code_unchanged !== undefined) continue;

    const deliveredEnd = surf.code === undefined
      ? requestedStart - 1
      : sourceLineAfterDisplayLines(
          requestedStart,
          callerRangeElisionWindows(workspace, surf.path, requestedStart, requestedEnd, cache),
          displayLineCount(surf.code),
          requestedEnd,
        );
    if (deliveredEnd >= requestedEnd) continue;

    const settledEnd = trailingBlankOrMissingTrimmedEnd(workspace, surf.path, deliveredEnd, requestedEnd, cache);
    if (settledEnd <= deliveredEnd) continue; // the whole gap is blank/whitespace or past EOF: nothing real is missing

    surf.content_completeness = "partial";
    surf.remaining_ranges = mergeRangeStrings([
      `${deliveredEnd + 1}-${settledEnd}`,
      ...(surf.remaining_ranges ?? []),
    ]);
  }
}

// ---------------------------------------------------------------------------
// WP-S7 (2026-09-20, TL_FOLD_SMALL_REMAINDER) -- do not leave a remainder
// that is cheaper to serve than to ask for. See util/flags.ts's
// `foldSmallRemainderEnabled` doc block for the full motivation and contract;
// this block is its one implementation.
// ---------------------------------------------------------------------------

/** WP-S7: a remainder of at most this many lines is eligible to fold into the whole file. */
export const FOLD_SMALL_REMAINDER_MAX_LINES = 40;

/** WP-S7: ...and whose own elided embed costs at most this many bytes. */
export const FOLD_SMALL_REMAINDER_MAX_BYTES = 2048;

/**
 * WP-S7: every `remaining_ranges` entry of a surface, parsed as [start,end]
 * pairs. `undefined` on any entry that is not a plain "N-M" span (never
 * expected today, but a malformed entry must abstain, not guess).
 */
export function parseRemainingSpans(ranges: readonly string[]): Array<[number, number]> | undefined {
  const spans: Array<[number, number]> = [];
  for (const entry of ranges) {
    const span = parseSurfaceSpan(entry);
    if (span === undefined) return undefined;
    spans.push([span.start, span.end]);
  }
  return spans;
}

/**
 * WP-S7: the lines and post-elision bytes `spans` of `relPath` would cost if
 * served on their own — the same measure `sliceCode` (this file's shared
 * embed helper) applies to any other slice, so a remainder that "fits" here is
 * held to the identical bar as the body it would join. A generous `maxBytes`
 * (never the per-surface cap) is passed through so the byte figure returned is
 * the remainder's true elided size, never an early cap rejection. `undefined`
 * when any span cannot be read/sliced (a malformed span, or the file vanished
 * under us) — the caller's job then is to abstain, never to guess.
 */
export function foldableRemainderSize(
  workspace: string,
  relPath: string,
  spans: ReadonlyArray<readonly [number, number]>,
  cache?: FileReadCache,
): { lines: number; bytes: number } | undefined {
  let lines = 0;
  let bytes = 0;
  for (const [start, end] of spans) {
    lines += end - start + 1;
    const slice = sliceCode(workspace, relPath, `${start}-${end}`, cache, Number.MAX_SAFE_INTEGER);
    if (slice === undefined) return undefined;
    bytes += Buffer.byteLength(slice, "utf8");
  }
  return { lines, bytes };
}

/**
 * WP-S7: widen a surface whose only unserved lines are a small file-boundary
 * remainder to the whole file, so a caller never spends a whole extra model
 * turn fetching a `remaining` span that was cheaper to have shipped up front.
 * Mutates `result.surfaces` in place; a no-op with the flag off. See
 * `foldSmallRemainderEnabled`'s doc block (util/flags.ts) for the full
 * contract.
 *
 * Must run BEFORE `trimToCap` (a fold that does not survive the pack budget
 * is undone right here, never discovered later as a stale `remaining_ranges`
 * after an unrelated trim) and AFTER this function's own caller-range marking
 * loop just above (so `isCallerRangeSurface` is authoritative for every
 * surface below, exactly as `snapshotCallerRangeSurfaces` relies on next).
 *
 * Exported (not otherwise part of the public task-pack API) purely for direct
 * unit testing against constructed TaskPackResult values, the same rationale
 * `applyAgentGuideElision`/`trimToCap`/`dedupeAgentGuideSurfaces` are already
 * exported under -- the real entry point remains
 * dedupeTrimAndPersist/buildTaskPack.
 */
export function applyFoldSmallRemainder(
  workspace: string,
  result: TaskPackResult,
  cache?: FileReadCache,
): void {
  // Tight host budgets make a tiny tail cost an entire extra model turn.
  // Keep explicit opt-outs and every structural/fit guard below.
  const boundedDefault = process.env["TL_FOLD_SMALL_REMAINDER"] === undefined
    && clampToActiveCeiling(Number.MAX_SAFE_INTEGER) <= 20 * 1024;
  if (!foldSmallRemainderEnabled() && !boundedDefault) return;
  // v0.16.0 release verification (T01): a candidate-list pack is a choice between
  // served candidates, not a remainder to complete. Widening one candidate to its
  // whole file makes EVERY candidate look "served whole" to GATE-C1
  // (canonicalDecision.ts `discoveryBundleNext`'s multi-concern gate), which then
  // withholds the one bundle `next` and leaves a bare `await_input/choose-candidate`
  // dead end. That holds whatever switched the fold on -- the bounded default of
  // the small-ceiling hosts (Copilot CLI 18 KiB, VS Code 14,336 B), the
  // TL_TURN_ECONOMY umbrella (the VS Code extension and `tl workspace setup`
  // write it), or TL_FOLD_SMALL_REMAINDER itself -- so such a pack is never
  // folded.
  if (isCandidateListPack(result)) return;
  const surfaces = codeTaskPackSurfaces(result.surfaces);
  const surfacesForPath = new Map<string, number>();
  for (const surface of surfaces) {
    surfacesForPath.set(surface.path, (surfacesForPath.get(surface.path) ?? 0) + 1);
  }

  for (const surf of surfaces) {
    if (surf.code === undefined) continue; // body-less (prior/handle-only): nothing to widen
    if (isMarkdownPath(surf.path)) continue; // Markdown already has its own unconditional whole-file promotion
    if ((surfacesForPath.get(surf.path) ?? 0) > 1) continue; // multi-window file: each window owns its own remainder
    if (isCallerRangeSurface(surf) && (!boundedDefault || isExplicitRangeSurface(surf))) continue; // explicit windows remain hard; a named-only seed may complete its tiny tail
    if (wasSemanticFrontierBodyWithheld(surf)) continue; // the semantic frontier already decided this surface's body
    const remaining = surf.remaining_ranges;
    if (remaining === undefined || remaining.length === 0) continue; // nothing left to fold

    const spans = parseRemainingSpans(remaining);
    if (spans === undefined) continue;
    const size = foldableRemainderSize(workspace, surf.path, spans, cache);
    if (size === undefined) continue;
    if (size.lines > FOLD_SMALL_REMAINDER_MAX_LINES || size.bytes > FOLD_SMALL_REMAINDER_MAX_BYTES) continue;

    const content = readCached(workspace, surf.path, cache);
    if (content === undefined) continue;
    const totalLines = countLines(content);
    if (totalLines <= 0) continue;
    const wholeRange = `1-${totalLines}`;
    // range can already span the whole file while code still omits the tail.

    // The exact whole-file path a fits-the-cap serve already uses: at the
    // shared per-surface allowance, this returns a complete (empty
    // remaining_ranges) embed only when the WHOLE file actually fits — the
    // "per-surface allowance" fit check this widen must pass before landing.
    const widened = centeredSliceForCap(workspace, surf.path, wholeRange, cache, undefined, MAX_SURFACE_CODE_BYTES);
    if (widened === undefined || widened.remaining_ranges.length > 0) continue;

    const before = {
      range: surf.range,
      code: surf.code,
      remaining_ranges: surf.remaining_ranges,
      content_completeness: surf.content_completeness,
      handle: surf.handle,
      symbol: surf.symbol,
    };
    const oldHandle = surf.handle;
    // A fresh handle for the WIDENED range, exactly like the sibling
    // whole-file promotion above (wholeFileRangeIfDominant/candidateToSurface)
    // — the handle table's own registration must match what this surface now
    // claims, or a later bare-handle re-read would resolve the stale, narrower
    // span.
    const newHandle = handleTable.upsert({
      kind: "range",
      path: surf.path,
      range: wholeRange,
      workspaceRoot: workspace,
    }).id;

    surf.range = wholeRange;
    surf.code = widened.code;
    delete surf.remaining_ranges;
    delete surf.content_completeness;
    surf.handle = newHandle;
    delete surf.symbol; // the surface now names the whole file, not one symbol's span
    for (const edit of surf.likely_edits ?? []) {
      if (edit.handle === oldHandle) edit.handle = newHandle;
    }

    if (fitsInCap(result)) continue; // widen accepted — fits the pack's own byte budget

    // Does not fit the pack budget: leave the surface exactly as it was.
    surf.range = before.range;
    surf.code = before.code;
    if (before.remaining_ranges !== undefined) surf.remaining_ranges = before.remaining_ranges;
    else delete surf.remaining_ranges;
    if (before.content_completeness !== undefined) surf.content_completeness = before.content_completeness;
    else delete surf.content_completeness;
    surf.handle = before.handle;
    if (before.symbol !== undefined) surf.symbol = before.symbol;
    for (const edit of surf.likely_edits ?? []) {
      if (edit.handle === newHandle) edit.handle = oldHandle;
    }
  }
}

// ---------------------------------------------------------------------------
// R2-T1 (eval-0929 review P0-3 / P1-1) — THE BYTE-BUDGET TIERS OF
// `dedupeTrimAndPersist` ARE POST-CERTIFICATION MUTATIONS TOO.
//
// THE DEFECT, MEASURED (VS Code config: `TOKENLIGHTEN_CLIENT_ID=vscode`, the
// 14,336-byte ceiling `tl setup` writes; equally a `budget.bytes` or
// `TOKENLIGHTEN_TASK_PACK_MAX_BYTES` near the pack size). "Explain all
// conditions of retry300, including the actual values in RETRY_CODES." over a
// 300-branch function: the final build certified `act.answer` (surface-content,
// identifier, behavior-body, request-item:facet-1:condition,
// request-item:facet-2:value) with 142 lines of the body in the response; the
// pack was ~900 bytes over the ceiling, the optional shed tier removed the
// WHOLE 12 KB body (the largest optional surface), and TL-01's re-derivation
// re-certified every obligation over what was left — the constant's line and
// the file's import line. No `next`, no gap. A re-derivation is only as honest
// as each obligation's evaluator, and one accepts a surrogate that is harmless
// while the real evidence ships beside it: `behavior-body`'s evidence is every
// surface whose SYMBOL is callable (see `sharpenBehaviorBodyCitation`). With a
// 160-branch function the same tiers instead left one surface too large for
// the ceiling, and the proof-preserving fallback — which never shrank the body
// it retains — threw "unreachable task-pack construction invariant" as a
// JSON-RPC -32603 (P1-1).
//
// THE RULE (eval-0929 §8; WP-B's `certificateWireInvariant.ts`, applied to
// these tiers): a certificate never outlives the evidence it was minted over.
// The certificate the final build minted is snapshotted
// (`ceilingCertificationSnapshot`) BEFORE any tier compacts or sheds, then:
//   1. PREVENTION — the optional tier removes only surfaces whose withdrawal
//      breaks no citation (`wouldIntroduceBreach`); a cited one is skipped.
//   2. When that is not enough, no response under this cap carries both the
//      certificate and its evidence. The EVIDENCE is kept: bodies are reduced
//      from the tail (`reduceServedBodyTail` — rows, handles and an honest
//      `remaining_ranges` stay; a cited surface is never removed whole), and
//      the certificate goes: `discover` with ONE executable, ceiling-budgeted
//      read of every cited line the client does not hold
//      (`enforceCeilingCertificateInvariant` -> `failClosedToEvidenceReread`).
//   3. The fallback shrinks the body it retains until its envelope fits,
//      instead of throwing, and is held to the same invariant.
//   4. ONE enforcement at the exit re-applies a demotion no later rebuild may
//      undo, and catches a withdrawal any other tier made.
// A pack that fits, a pack whose certificate is not `act.answer`, and a pack
// whose shed touches no cited line are left exactly as they were. The two
// evaluator weaknesses themselves are closed at their source (orchestrator
// ruling 2026-09-30): a condition / flow facet requires a long callable focal
// whole (facetGate.ts, MAX_FACET_FOCAL_LINES), and `behavior-body` needs a
// served body line beyond the declaration (`callableBodiesNotShown`).
// Languages: line arithmetic over served spans plus the per-line declaration
// recognizer `callableBodiesNotShown` documents (TS/JS, Python, Go, Rust,
// Kotlin, Java, C#, C/C++); a file whose declarations it cannot recognize keeps
// the pre-existing proof.
// ---------------------------------------------------------------------------

/** The certificate the byte-budget tiers are judged against, as the final build minted it. */
export interface CeilingCertificationSnapshot {
  /** WP-B's citations (`certificateCitations`, per-obligation modes intact), `behavior-body`'s sharpened to the windows that show a body. */
  readonly citations: readonly CertificateCitation[];
  /** The line spans this response carried in a body at that moment (`packServedSpans`). */
  readonly certifiedSpans: ServedSpans;
}

/**
 * The snapshot, or `undefined` when there is nothing to protect: the pack does
 * not project `act.answer` (an edit / discovery pack keeps every tier exactly
 * as it was), or its certificate cites no window. MUST be taken before
 * `contractForTrim` drops the per-obligation evidence (after that only the
 * conservative compacted citation is left); taken only for a pack already over
 * its cap, so a pack that fits never pays for it.
 */
export function ceilingCertificationSnapshot(
  result: TaskPackResult,
  workspace: string,
): CeilingCertificationSnapshot | undefined {
  const contract = result.execution_contract;
  if (contract === undefined || deriveCanonicalTaskDecision(result)?.kind !== "act-answer") return undefined;
  const surfacesByHandle = new Map(codeTaskPackSurfaces(result.surfaces).map((surface) => [surface.handle, surface] as const));
  const citations = certificateCitations(contract, certifiedSurfacesOf(result))
    .map((citation) => sharpenBehaviorBodyCitation(citation, surfacesByHandle, workspace));
  return citations.length === 0 ? undefined : { citations, certifiedSpans: packServedSpans(result) };
}

/**
 * `behavior-body`'s evidence lists every CALLABLE surface (`hasCallableBody`,
 * which accepts a surface on its SYMBOL alone), while the claim stands only on
 * a surface that shows a line of a body (`callableBodiesNotShown`, ruling rule
 * 3). The falsification pass's one-line row of the same file inherits the
 * callable's symbol while serving, say, its import line (measured, eval-0929
 * review P0-3: `r300.ts:1-1`, symbol `retry300`), and under WP-B's `any` mode
 * that row alone kept the citation standing after the real body was
 * withdrawn. For the invariant only the windows that show a body stand for the
 * claim; a citation with no such window is left exactly as minted (nothing a
 * later tier withdraws can make it weaker than it already was). A file whose
 * declarations this scan cannot recognize keeps the text test.
 */
export function sharpenBehaviorBodyCitation(
  citation: CertificateCitation,
  surfacesByHandle: ReadonlyMap<string, TaskPackSurface>,
  workspace: string,
): CertificateCitation {
  if (citation.obligationId !== "behavior-body") return citation;
  const showing = citation.windows.filter((window) => {
    const surface = surfacesByHandle.get(window.handle);
    if (surface === undefined) return false;
    const unshown = callableBodiesNotShown([surface], [surface], "", workspace, "any");
    return unshown === undefined ? hasCallableBody({ ...surface, symbol: undefined }) : unshown.length === 0;
  });
  return showing.length === 0 || showing.length === citation.windows.length ? citation : { ...citation, windows: showing };
}

/**
 * Free at least `needed` bytes of `surface`'s served body by dropping its
 * TRAILING display lines — WP-P2 B's `reduceCallerNamedBody`, for any served
 * surface: the row, its handle and its role stay, and `remaining_ranges` names
 * exactly the lines the body no longer carries. A body whose served lines are
 * not ONE contiguous window (an appended window, a hole) cannot be cut at a
 * line this function can name, so it is given back whole instead
 * (`remaining_ranges` gains its whole range): always honest, never a guessed
 * boundary. `false` only when there is no body to give.
 */
export function reduceServedBodyTail(
  surface: TaskPackSurface,
  needed: number,
  workspace: string,
  cache?: FileReadCache,
): boolean {
  const code = surface.code;
  if (code === undefined || code.length === 0) return false;
  // A structure map consists of exact separately addressed source windows.
  // Give back whole tail windows before the generic multislice fallback;
  // treating a small overflow as loss of the entire map forces many re-reads.
  const appended = surface.appended_windows;
  if (appended && appended.length > 0 && appended.every(entry =>
    entry.marker === `\n\n/* structure map (${entry.range}) */\n` && /^\d+-\d+$/.test(entry.range))) {
    const source = readCached(workspace, surface.path, cache)?.split(/\r?\n/);
    if (source) {
      let retainedCode = code;
      const retained = [...appended];
      const dropped: string[] = [];
      let freed = 0;
      let valid = true;
      // Validate the exact source suffix, never guess a marker inside source.
      for (let index = appended.length - 1; index >= 0; index--) {
        const entry = appended[index]!;
        const bounds = parsePackLineRange(entry.range)!;
        const segment = entry.marker + source.slice(bounds[0] - 1, bounds[1]).join("\n");
        if (!retainedCode.endsWith(segment)) { valid = false; break; }
        retainedCode = retainedCode.slice(0, -segment.length);
        if (freed < needed) {
          freed += Buffer.byteLength(segment, "utf8");
          dropped.push(entry.range); retained.pop();
        }
      }
      if (valid && dropped.length > 0) {
        // Validation walked every suffix. Rebuild precisely the prefix kept.
        const keepThrough = appended.length - dropped.length;
        const suffix = appended.slice(keepThrough).map(entry => {
          const bounds = parsePackLineRange(entry.range)!;
          return entry.marker + source.slice(bounds[0] - 1, bounds[1]).join("\n");
        }).join("");
        trace("structure_map_rows_shed", { path: surface.path, dropped, bytes_freed: freed }, workspace);
        surface.code = code.slice(0, -suffix.length);
        if (retained.length > 0) surface.appended_windows = retained;
        else delete surface.appended_windows;
        surface.remaining_ranges = mergeRangeStrings([...(surface.remaining_ranges ?? []), ...dropped]);
        surface.content_completeness = "partial";
        delete surface.anchors_served;
        if (freed < needed) reduceServedBodyTail(surface, needed - freed, workspace, cache);
        return true;
      }
    }
  }
  const served = packServedSpans({ mode: "task_pack", coverage: "partial", surfaces: [surface], missing: [] }).get(surface.path) ?? [];
  const window = served.length === 1 && (surface.appended_windows?.length ?? 0) === 0 ? served[0] : undefined;
  const lines = code.split("\n");
  let kept = lines.length;
  let freed = 0;
  while (kept > 0 && freed < needed) {
    kept -= 1;
    freed += Buffer.byteLength(lines[kept]!, "utf8") + 1;
  }
  const keptCode = window !== undefined && kept > 0 ? `${lines.slice(0, kept).join("\n")}\n` : undefined;
  let unserved: string[];
  if (keptCode === undefined || window === undefined) {
    unserved = String(surface.range ?? "").split(",").map((part) => part.trim()).filter((part) => /^\d+-\d+$/.test(part));
  } else {
    const [start, end] = window;
    const elided = keptCode.includes("doc elided L")
      ? callerRangeElisionWindows(workspace, surface.path, start, end, cache)
      : [];
    const deliveredEnd = sourceLineAfterDisplayLines(start, elided, displayLineCount(keptCode), end);
    unserved = deliveredEnd < end ? [`${deliveredEnd + 1}-${end}`] : [];
  }
  surface.code = keptCode;
  surface.content_completeness = "partial";
  if (unserved.length > 0) surface.remaining_ranges = mergeRangeStrings([...(surface.remaining_ranges ?? []), ...unserved]);
  // A reduced body no longer proves its decision-critical anchors were served.
  delete surface.anchors_served;
  return true;
}

/**
 * Rounds of `reduceServedBodyTail` the proof-preserving fallback may run on
 * its one retained body. Each round frees at least the overflow it measured,
 * so one normally suffices; the extra rounds absorb the few bytes a rebuilt
 * contract can differ by.
 */
export const MAX_FALLBACK_BODY_REDUCTIONS = 4;

/**
 * THE CHECK, and the demotion it forces (see this section's header). A cited
 * line this response carried when the certificate was minted and no longer
 * carries (`certificateWireBreaches`) takes the certificate with it unless the
 * client holds the line anyway (an earlier call's residency). The demotion's
 * one call reads every line of each breached window the client does not hold
 * (`unservedCitedWindows`) — for a focal, the rest of the declaration.
 *
 * `force`: re-apply even when the decision is no longer `act.answer` — the
 * proof-preserving fallback (its own `next` expands only the one surface it
 * kept) and the exit re-application of an earlier demotion. Otherwise a pack
 * that a re-derivation already honestly demoted keeps its own `discover`.
 * Returns true when `result` is (now) the demoted shape.
 */
export function enforceCeilingCertificateInvariant(
  result: TaskPackResult,
  snapshot: CeilingCertificationSnapshot,
  workspace: string,
  force: boolean,
): boolean {
  const final = packServedSpans(result);
  const breaches = certificateWireBreaches(snapshot.citations, snapshot.certifiedSpans, final);
  if (breaches.length === 0) return false;
  if (!force && deriveCanonicalTaskDecision(result)?.kind !== "act-answer") return false;
  const cited = breachedCitations(snapshot.citations, breaches);
  const unserved = unservedCitedWindows(
    cited,
    withResidentSpans(final, workspace, cited.flatMap((citation) => citation.windows.map((window) => window.path))),
  );
  if (unserved.windows.length === 0) return false;
  const budgetBytes = activePackByteCeiling();
  const reread = evidenceRereadCall(unserved.windows, budgetBytes);
  const contract = result.execution_contract;
  if (contract?.typestate.phase === "discovery" && JSON.stringify(contract.next_call) === JSON.stringify(reread)) return true;
  if (isTraceEnabled()) {
    trace("certificate_ceiling_demotion", {
      obligations: unserved.obligationIds,
      reread: unserved.windows.map((window) => `${window.path}:${window.start}-${window.end}`),
    }, workspace);
  }
  failClosedToEvidenceReread(
    result,
    unserved.windows,
    "the certified evidence does not fit this response's byte ceiling; read the named window(s) before answering",
    unserved.obligationIds,
    budgetBytes,
  );
  return true;
}

/** Most served callables one answer pack chases dependency values for (2026-10-06 review, P1-1/P1-2); past it each one is disclosed, never dropped. */
export const MAX_DEPENDENCY_FOCALS = 12;

/** The plan clause a dependency entry carries — never a query clause, so no facet requirement or request item ever matches it. */
export const DEPENDENCY_VALUE_CLAUSE = "(values the served code reads)";
