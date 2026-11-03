// receiptProgress — extracted implementation; imports point to the owning modules.
import * as fs from "fs";
import type { ContinuationCall } from "./packBasics.js";
import type { ServedPackRecord } from "./packState2.js";
import type { TaskPackResult } from "../model.js";
import { hasExecutedNext } from "../../../util/packServeLog.js";
import { parseSurfaceSpan } from "./packState2.js";
import { safeResolve } from "../../../util/safePath.js";
import { servedClusterRanges } from "../../../state/session.js";
import { surfaceFileIdentity } from "./packState2.js";

/**
 * FX-M4 (P1, 2026-09-03): does the session's OWN served-range ledger —
 * `session.servedRangeLedger`, the exact structure `recordServedRange` writes
 * and the SAME "shippedSurfaces-booked ranges" source FX-K/FX-L's
 * `addressShipped` reads via `editPathResidency` (both are written together,
 * atomically, by `recordServedRange`) — prove this row's declared `range` was
 * put on the wire for `path` at some point this session?
 *
 * DELIBERATELY NOT `prev.surfaces[].content_completeness`. That field is the
 * PACK RECORD's own memory of itself, captured once at serve time
 * (`captureServedPack`) and never re-verified; P1 (round-16) proved a plain
 * re-ask stamps `prior` on a Phase-E-stripped row using exactly that kind of
 * unverified self-report. This function is the one place a compact receipt
 * asks the ledger instead of the record — the read-side twin of ruling (r)'s
 * write-side "the certificate is not write authority" (`addressShipped`
 * reads `editPathResidency`, never the certificate's own evidence list). Both
 * `revalidateRecordToReceipt`'s plain-re-ask path and its qref-replay path
 * route through this one predicate (`compactReceiptFromRecord` is their only
 * shared surfaces-builder), so `prior` eligibility is decided identically on
 * both.
 *
 * `servedClusterRanges` returns the ledger's merged clusters for `path`
 * regardless of the row's own `range` framing, so full coverage of
 * `[start,end]` is checked here by interval union — a cluster gap anywhere
 * inside the row's declared range means the row is NOT provably shipped.
 * Fails closed (declares "not shipped") on an unparseable range, an evicted
 * ledger entry (bounded FIFO cap), or a genuinely partial cluster set — the
 * safe direction, since the fallback is an honest `remaining` + handle, never
 * a wrongly withheld body.
 *
 * P1-1 FOLLOW-UP (2026-09-08, review finding 1): a WHOLE-FILE surface's OWN
 * declared `range` can itself over-count by one line. `selectQueryEvidence`
 * (tools/queryEvidence.ts) windows a raw `content.split("\n")`, which yields
 * a phantom trailing element for any LF-terminated file (the norm — nearly
 * every real file), and its end-of-window clamp (`Math.min(lines.length - 1,
 * …)`) has no way to know that final split element is not a real line. A
 * 12-line file with a trailing newline can therefore mint a surface
 * declaring `range:"1-13"`, while every actual serve of that file only ever
 * books lines `1-12` — `cursor` could then never cross `target.end` (13), so
 * the row was NEVER provably shipped. That was the exact mechanism behind
 * the reported `qref` re-pack loop on a newline-terminated whole-file
 * surface. Clamp `target.end` to the file's OWN real servable line count via
 * `surfaceFileIdentity` — the same "trailing newline is not a line" rule
 * `applyLedgerServedSurfaces` already applies — before comparing against the
 * ledger's clusters, and fail closed (declare "not shipped") both when the
 * identity is unavailable and when the clamped window is degenerate
 * (`target.start` beyond the file's real last line), in the same direction
 * every other uncertain input here already resolves.
 */
export function surfaceRangeShipped(workspace: string, path: string, range: string): boolean {
  const target = parseSurfaceSpan(range);
  if (target === undefined) return false;
  const identity = surfaceFileIdentity(workspace, path);
  if (identity === undefined) return false;
  const end = Math.min(target.end, identity.totalLines);
  if (target.start > end) return false;
  const clusters = servedClusterRanges(workspace, path)
    .map(parseSurfaceSpan)
    .filter((c): c is { start: number; end: number } => c !== undefined)
    .sort((a, b) => a.start - b.start);
  let cursor = target.start;
  for (const cluster of clusters) {
    if (cluster.end < cursor) continue;
    if (cluster.start > cursor) return false;
    cursor = Math.max(cursor, cluster.end + 1);
    if (cursor > end) return true;
  }
  return cursor > end;
}

/**
 * `surfaceRangeShipped`'s other half, for an answer-first map's receipt: the windows of
 * `range` the served-range ledger cannot prove were put on the wire for `path`, as
 * "start-end" ranges in order — what is left of the row's extent once the clusters the
 * caller was served are taken out. `undefined` where `surfaceRangeShipped` fails closed
 * for want of an answer (an unparseable range, an unavailable file identity, a degenerate
 * window): the caller then keeps the whole range, as it always has.
 */
export function surfaceRangeUnserved(workspace: string, path: string, range: string): string[] | undefined {
  const target = parseSurfaceSpan(range);
  if (target === undefined) return undefined;
  const identity = surfaceFileIdentity(workspace, path);
  if (identity === undefined) return undefined;
  const end = Math.min(target.end, identity.totalLines);
  if (target.start > end) return undefined;
  const clusters = servedClusterRanges(workspace, path)
    .map(parseSurfaceSpan)
    .filter((c): c is { start: number; end: number } => c !== undefined)
    .sort((a, b) => a.start - b.start);
  const gaps: string[] = [];
  let cursor = target.start;
  for (const cluster of clusters) {
    if (cluster.end < cursor) continue;
    if (cluster.start > end) break;
    if (cluster.start > cursor) gaps.push(`${cursor}-${cluster.start - 1}`);
    cursor = Math.max(cursor, cluster.end + 1);
    if (cursor > end) break;
  }
  if (cursor <= end) gaps.push(`${cursor}-${end}`);
  return gaps.length > 0 ? gaps : undefined;
}

/**
 * v0.15.1 runtime review (2026-10-06): true when a stored record's surface
 * says part of its range reached the caller — a body served partially
 * (`content_completeness:"partial"`) whose `remaining_ranges` leave some line
 * of the range out. A surface a byte cap withheld whole reports its entire
 * range remaining, and is never resident on its record's word.
 */
export function recordSurfacePartlyServed(surface: { range: string; content_completeness?: "partial"; remaining_ranges?: readonly string[] }): boolean {
  if (surface.content_completeness !== "partial") return false;
  const span = parseSurfaceSpan(surface.range);
  if (span === undefined) return false;
  const remaining = (surface.remaining_ranges ?? [])
    .map(parseSurfaceSpan)
    .filter((entry): entry is { start: number; end: number } => entry !== undefined)
    .sort((a, b) => a.start - b.start);
  let cursor = span.start;
  for (const window of remaining) {
    if (window.end < cursor) continue;
    if (window.start > cursor) return true;
    cursor = window.end + 1;
    if (cursor > span.end) return false;
  }
  return cursor <= span.end;
}

/**
 * P1-1 (2026-09-08): the receipt path's own consumption scope.
 *
 * `hasExecutedNext` partitions its ledger by (workspace, lane, taskBinding),
 * and the dispatcher writes a call under the CANONICAL task binding it
 * resolved for that call (`canonicalTaskBindingForExecutedCall`). A receipt
 * built without that binding would read a different partition and conclude
 * "never executed" about a call the caller demonstrably ran, so the binding
 * travels with the receipt request rather than being re-derived here.
 */
export interface ReceiptConsumptionScope {
  readonly lane: string;
  readonly taskBinding?: string;
}

/**
 * P1-1 (2026-09-08): "has this exact continuation already been spent?", asked
 * the way the RECEIPT can honestly ask it.
 *
 * The bound partition is authoritative — it is the one the dispatcher wrote
 * under when the caller ran the prescribed next while holding a task handle.
 * The UNBOUND partition is consulted as a fallback for the same reason
 * `receiptContractWithoutConsumedSearch` consults it directly: a handleless
 * execution of the identical call shape in the same workspace+lane delivered
 * the identical bytes, and re-prescribing it would charge the caller a turn
 * for a body already in its context. Never widened past the lane: F-V13-3's
 * cross-lane rule is that one agent's consumption is not another's.
 */
export function receiptNextAlreadyExecuted(
  workspace: string,
  scope: ReceiptConsumptionScope,
  call: { tool: string; arguments?: unknown } | undefined,
): boolean {
  if (call === undefined) return false;
  const args = (call.arguments ?? {}) as Record<string, unknown>;
  if (hasExecutedNext(workspace, scope.lane, call.tool, args, scope.taskBinding)) return true;
  return scope.taskBinding !== undefined
    && hasExecutedNext(workspace, scope.lane, call.tool, args);
}

/**
 * P1-1, the SECOND consumption witness — and the one that does not depend on
 * the ledger's task partitioning at all.
 *
 * `hasExecutedNext` keys on (workspace, lane, taskBinding), and a HANDLELESS
 * re-pack (`tl_read_file {qref}`) is the one caller shape that cannot always
 * recover the binding under which the dispatcher recorded the caller's
 * execution of the prescribed next — a first pack opened with
 * `task.epoch:"new"` registers its contract before a handle exists, so
 * `uniqueTaskScopeForExactQuery`'s handle-backed lookup has nothing to match.
 * Asking only the ledger would therefore answer "never executed" about a call
 * whose bytes the same response is simultaneously labelling `prior`.
 *
 * So the receipt also asks the question it can answer from its OWN proof: a
 * read whose every addressed window is already covered by this session's
 * served-range ledger (`surfaceRangeShipped` — the same predicate that decides
 * whether a surface may claim `prior` on the wire) fetches nothing the caller
 * does not hold. Re-prescribing it is a round trip charged for no bytes, which
 * is exactly the condition every other no-repeat rule in this file forbids.
 *
 * Read-family only, and only for calls that ADDRESS something: a `query`/`qref`
 * task-pack call, a search, or an address this record cannot resolve, is left
 * alone for the ledger check above to judge.
 */
export function receiptReadNextAlreadyResident(
  workspace: string,
  prev: ServedPackRecord,
  call: { tool: string; arguments?: unknown } | undefined,
): boolean {
  if (call === undefined || call.tool !== "tl_read_file") return false;
  const args = (call.arguments ?? {}) as Record<string, unknown>;
  if (args["query"] !== undefined || args["qref"] !== undefined) return false;
  const rawTargets: Record<string, unknown>[] = Array.isArray(args["targets"])
    ? args["targets"].filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === "object")
    : [];
  if (rawTargets.length === 0) {
    if (args["handle"] !== undefined || args["path"] !== undefined) rawTargets.push(args);
    for (const handle of Array.isArray(args["handles"]) ? args["handles"] : []) {
      rawTargets.push({ handle });
    }
  }
  if (rawTargets.length === 0) return false;
  for (const target of rawTargets) {
    // A `ranges` list, or a symbol address, is not a shape this witness claims
    // to judge — fail open to the ledger check above.
    if (target["ranges"] !== undefined || target["symbol"] !== undefined) return false;
    const handle = typeof target["handle"] === "string" ? target["handle"] : undefined;
    // A PATH with no range addresses the whole file, so every window this
    // record holds for it must be shipped; a HANDLE addresses exactly one
    // surface. Picking the first path match and judging only its window would
    // suppress a legitimate whole-file read on the strength of one served
    // slice.
    const surfaces = handle === undefined
      ? prev.surfaces.filter((entry) => entry.path === target["path"])
      : prev.surfaces.filter((entry) => entry.handle === handle);
    if (surfaces.length === 0) return false;
    for (const surface of surfaces) {
      const range = typeof target["range"] === "string" && target["range"] !== ""
        ? target["range"]
        : surface.range;
      if (!surfaceRangeShipped(workspace, surface.path, range)) return false;
    }
  }
  return true;
}

/**
 * P1-1 (2026-09-08): what a receipt may honestly do about a stored `tl_read_file`
 * continuation — asked ONCE, so the two call sites cannot drift.
 *
 * `"fresh"`   — nothing is consumed; re-serve the record exactly as before.
 * `"advance"` — the continuation is spent but a required window is still
 *               unserved: the receipt keeps its shape and re-points `next_call`
 *               at that window (progress, the A-F2 rule).
 * `"spent"`   — the continuation is spent and no bounded read is left to name.
 *               The receipt must then STEP ASIDE rather than drop the call and
 *               park: it re-serves a STORED contract computed before its own
 *               next ran, so its readiness verdict describes a world that no
 *               longer exists, and a compact receipt carries no obligations,
 *               falsification report or action frontier to restate a better
 *               one. Dropping the call in place would leave a next-less
 *               terminus with whatever `missing[]` the record happened to
 *               capture — sequenceCorpus's I5 forbids exactly that ("a
 *               continuation is progress or a disclosed gap, never a bare
 *               terminus"). The full build re-derives readiness from the
 *               CURRENT ledger and discloses its own gaps.
 *
 * READ CONTINUATIONS ONLY. F-V13-5 already adjudicated the search family: a
 * consumed find/references/tree is repaired IN-RECEIPT and never declined,
 * because the receipt is the ONE read-family member that ships a top-level
 * `missing[]` and a fall-through recomputes that disclosure from a different
 * premise (observed: an absence-discharged concern reappearing as an
 * `unresolved-ledger:` entry the receipt had correctly dropped —
 * sequenceCorpus's I1/I3). Declining a search here would re-open precisely the
 * loss that ruling rejected; the gap P1-1 reports is the read family, which no
 * existing repair covers.
 *
 * Self-limiting: a decline rebuilds and captures a record whose continuation is
 * not spent, so the very next re-pack is served from the receipt again.
 */
export interface ReceiptContinuationDisposition {
  readonly state: "fresh" | "advance" | "spent";
  readonly progress?: ContinuationCall;
}

export function receiptContinuationDisposition(
  workspace: string,
  prev: ServedPackRecord,
  consumption: ReceiptConsumptionScope,
  storedNext: { tool: string; arguments?: unknown } | undefined,
): ReceiptContinuationDisposition {
  if (storedNext === undefined || storedNext.tool !== "tl_read_file") return { state: "fresh" };
  if (!receiptNextAlreadyExecuted(workspace, consumption, storedNext)
    && !receiptReadNextAlreadyResident(workspace, prev, storedNext)) return { state: "fresh" };
  const progress = prev.surfaces
    .filter((surface) => !surfaceRangeShipped(workspace, surface.path, surface.range))
    .map((surface): ContinuationCall => ({ tool: "tl_read_file", arguments: { handle: surface.handle } }))
    .find((call) => !receiptNextAlreadyExecuted(workspace, consumption, call)
      && !receiptReadNextAlreadyResident(workspace, prev, call));
  return progress === undefined ? { state: "spent" } : { state: "advance", progress };
}

/**
 * TL142-01C: the `create_target` a compact re-serve may restate, or undefined.
 *
 * Two conditions, both necessary and both cheap:
 *  - the record actually certified one (`ServedPackRecord.createTarget`), and
 *  - the named path STILL does not exist in the workspace.
 *
 * The second is the honesty gate: a create that already happened must never be
 * re-asserted (the caller would be told to create a file it just wrote). It is
 * an UNCACHED `fs.existsSync`, deliberately — the exact check
 * `resolveCreateTargetFromQuery` itself makes ("exists → edit, not create") —
 * because `statKindCached`'s memo has no invalidation hook for a file created
 * mid-session, and a stale "missing" is precisely the answer this gate must
 * never accept. One stat on a sub-1KB receipt path.
 *
 * Defence in depth, not the only line: creating the file also moves the
 * inventory fingerprint `revalidateRecordToReceipt` compares, which declines
 * the whole compact receipt and forces the full rebuild.
 */
export function restatableCreateTarget(
  workspace: string,
  prev: ServedPackRecord,
): TaskPackResult["create_target"] | undefined {
  const target = prev.createTarget;
  if (target === undefined || typeof target.path !== "string" || target.path.length === 0) return undefined;
  const absolute = safeResolve(target.path, workspace);
  if (absolute === undefined || fs.existsSync(absolute)) return undefined;
  return target;
}
