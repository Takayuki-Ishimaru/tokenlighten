// ---------------------------------------------------------------------------
// readRequestContinuation.ts — DESIGN-v0.15 §5 (R2): THE EMIT-TAIL HALF.
//
// NORMATIVE SOURCE: DESIGN-v0.15-exploration-continuation-reliability.md §3.2
// ("処理順は「要求正規化→候補/本文生成→予算内への投影→残件・証明・nextの最終
// 整合→確定した応答から一度だけ記帳」とする … 最終段で証拠が減ったならact.*を
// 降格し"), §5.1, §5.2, §5.3 (one canonical `next`); Wave-1 contract §2.4.
//
// ------------------------------ WHERE THIS RUNS -----------------------------
//
// `emit.ts` runs the ladder, then settles the served-range ledger against the
// POST-SHED payload ("THE LEDGER HALF"). Everything here happens in that same
// tail, in this order:
//
//   1. GENERIC DEMOTION. If the ladder took evidence away from a
//      `read.task_pack` that was still claiming `act.answer`/`act.edit`, the
//      act is demoted to `discover` with the restoring calls. §2.1.1's act
//      floor already catches the case where the evidence set becomes
//      structurally insufficient; this catches the weaker one the design also
//      names — the evidence merely DECREASED — because a certificate is a
//      claim about bytes that shipped, and fewer shipped than it was minted
//      against.
//   2. SETTLE. `settleReadRequest` recomputes D = Q - (C ∪ S) from the ledger
//      the step before just finalized, and persists it.
//   3. ONE CANONICAL CONTINUATION. `limit.next` becomes the parent request's
//      cursor call; `evidence[].remaining` mirrors D; a `read.batch` entry's
//      own `next` becomes the SAME cursor call. §5.3: "実行の正典となるnextを
//      一つに集約し、互換の別位置に残すなら同じ親requestを保持する同等の継続に
//      する。単独の小範囲nextで残りtargetsを失わせない."
//   4. D = ∅ ⇒ NO CONTINUATION AT ALL. §3.3's "既読通知の終端".
//
// BYTE-IDENTICAL WHEN NOTHING IS STAGED. Every entry point returns the payload
// BY IDENTITY unless this call actually opened or resumed a read request and
// the ladder actually shed, so `emit.ts`'s "REFACTOR AT DEFAULT BUDGETS"
// invariant and the §6.1(b) pins are untouched.
// ---------------------------------------------------------------------------

import type { Kind, LineWindow, ToolCall } from "@tokenlighten/types";

import { demoteToDiscover } from "./budget/actFloor.js";
import { carriesStripDisclosure, type ShedPayload } from "./budget/shedders/registry.js";
import { canonicalToolCall } from "./envelope.js";
import {
  markReadRequestOpenness,
  mintReadCursor,
  parseWindow,
  previewSettledRemaining,
  readRequestComplete,
  settleReadRequest,
  windowStrings,
  wireLineCostBytes,
  type StagedReadRequest,
} from "../state/readRequestStore.js";

/**
 * The read request THIS call opened or resumed.
 *
 * Declared here, by ownership, exactly as `budget/ladder.ts` declares
 * `shedRecords`: the slot is written by the read dispatcher and read by the
 * emit tail, and nothing else may touch it. Absent on every call that is not a
 * line-addressed read, which is what keeps the tail a no-op elsewhere.
 */
declare module "./envelope.js" {
  interface ProtocolCallContext {
    readRequest?: StagedReadRequest;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function evidenceOf(payload: ShedPayload): Record<string, unknown>[] {
  const evidence = payload["evidence"];
  return Array.isArray(evidence) ? evidence.filter(isRecord) : [];
}

/**
 * Did the ladder take evidence AWAY?
 *
 * Both losses count, and the design counts both: an entry whose `body` is gone
 * (rung 5's whole-entry drop) and an entry whose `body` is SHORTER than the one
 * the producer built (rung 4's truncation). "証拠が減った" is a statement about
 * delivered bytes, not about the entry count, and a certificate minted against
 * a 113-line body is not discharged by a 15-line one.
 *
 * Matched by `handle` where both sides have one, by position otherwise, so a
 * shedder that rebuilt the array in order is compared entry-for-entry.
 */
export function evidenceDecreased(before: ShedPayload, after: ShedPayload): boolean {
  const pre = evidenceOf(before);
  const post = evidenceOf(after);
  const byHandle = new Map<string, Record<string, unknown>>();
  for (const entry of post) {
    const handle = entry["handle"];
    if (typeof handle === "string" && handle !== "") byHandle.set(handle, entry);
  }
  for (let index = 0; index < pre.length; index += 1) {
    const entry = pre[index]!;
    const body = entry["body"];
    if (typeof body !== "string" || body === "") continue;
    const handle = entry["handle"];
    const match = typeof handle === "string" && handle !== ""
      ? byHandle.get(handle)
      : post[index];
    if (match === undefined) return true;
    const shipped = match["body"];
    if (typeof shipped !== "string" || shipped.length < body.length) return true;
  }
  return false;
}

/**
 * §3.2's last sentence, as code: a `read.task_pack` whose evidence the ladder
 * reduced may not keep an `act.*` decision.
 *
 * Returns the payload BY IDENTITY when nothing applies — including when
 * `demoteToDiscover` can name no restoring call, in which case the honest
 * outcome is the one `ladder.ts` already takes for the same situation: keep
 * what is there rather than emit a `discover` with no `next`.
 */
export function demoteActAfterShed(input: {
  before: ShedPayload;
  after: ShedPayload;
  onWire: Kind;
  shed: boolean;
  canonicalize?: (candidate: ShedPayload) => ShedPayload;
}): ShedPayload {
  const { before, after, onWire, shed, canonicalize } = input;
  if (!shed || onWire !== "read.task_pack") return after;
  const decision = after["decision"];
  if (!isRecord(decision)) return after;
  const kind = decision["kind"];
  if (kind !== "act.answer" && kind !== "act.edit") return after;
  if (!evidenceDecreased(before, after)) return after;
  const demoted = demoteToDiscover(after, before);
  if (demoted === undefined) return after;
  return canonicalize === undefined ? demoted : canonicalize(demoted);
}

/**
 * The one canonical continuation call for a staged request.
 *
 * Exported for `server.ts`'s R4 parent-request receipt sites
 * (`openParentReadRequest` callers): the SAME cursor-call shape a normal
 * ladder/settle continuation mints, so a receipt's `next` and an ordinary
 * page's `limit.next` are never two different dialects for the same request.
 */
export function cursorCall(staged: StagedReadRequest, cursor: string): ToolCall {
  const echo = staged.echo;
  return canonicalToolCall("tl_read_file", {
    cursor,
    ...(echo.cwd !== undefined && echo.cwd !== "" ? { cwd: echo.cwd } : {}),
    ...(echo.lane !== undefined && echo.lane !== "" ? { lane: echo.lane } : {}),
    ...(echo.taskHandle !== undefined && echo.taskHandle !== ""
      ? { task: { handle: echo.taskHandle } }
      : {}),
  }) as ToolCall;
}

/** True iff this `next` is one of the read-family continuations we may replace. */
function replaceableNext(value: unknown): boolean {
  return isRecord(value) && value["tool"] === "tl_read_file";
}

/**
 * DESIGN-v0.15 §5.1 (R2) / finding 12: what the FINALIZED payload's own
 * evidence says THIS call actually shipped, per path — fed to
 * `settleReadRequest` so a page a later shed pass narrowed cannot let D
 * advance past lines that never reached the wire (see `readRequestStore.ts`'s
 * `settledTargets` doc comment for the "CURRENT PAGE" rationale in full).
 * `evidence[].range` names the semantic extent an entry claims; elision only
 * changes the BODY TEXT inside that range, never the range itself, and a rung
 * that truncates a body rewrites the range to match (`readText.ts`'s
 * `truncateLargestBody`) — so this always reads the TRUE shipped extent.
 *
 * Returns `undefined` when the response carries no `evidence` array AT ALL
 * (a receipt, most notably) — that is "no information", not "nothing
 * shipped", and the store then credits a fixed page wholesale, exactly as it
 * did before this fix (a receipt IS a statement about delivery).
 *
 * A REFUSAL is the opposite answer and must not be confused with it: nothing
 * shipped at all, so an EMPTY map is returned and the page stays fully owed.
 * A refusal reaches this tail with the request still staged — a
 * `budget-below-minimum` refusal's own `limit.next` is how a caller retries
 * the same request at a raised budget — so without this branch a refusal
 * would have credited its whole page as delivered.
 */
function shippedWindowsByPath(payload: ShedPayload): Map<string, LineWindow[]> | undefined {
  if (payload["kind"] === "refusal") return new Map<string, LineWindow[]>();
  const evidence = payload["evidence"];
  if (!Array.isArray(evidence)) return undefined;
  const map = new Map<string, LineWindow[]>();
  for (const raw of evidence) {
    if (!isRecord(raw)) continue;
    const path = raw["path"];
    if (typeof path !== "string") continue;
    if (!map.has(path)) map.set(path, []);
    const body = raw["body"];
    const range = raw["range"];
    if (typeof body !== "string" || typeof range !== "string") continue;
    const window = parseWindow(range);
    if (window === undefined) continue;
    // A blank line's verbatim body is `""` (readFamily.ts `blankLineBody`) and
    // it did ship; an empty body for a wider window ships nothing. Without
    // this a budgeted read of a blank line stayed owed and its cursor
    // re-served the same line forever.
    if (body === "" && window.end !== window.start) continue;
    map.get(path)!.push(window);
  }
  return map;
}

/**
 * DESIGN-v0.15 §5.3 / finding 11: drop the LAST WHOLE LINE from the LARGEST
 * evidence body, narrowing its own `range` to match — a 1-line-granularity
 * cousin of `protocol/budget/shedders/readText.ts`'s `truncateLargestBody`
 * rung ("the addressing must move with the bytes"), reimplemented here rather
 * than reused because the ladder rung halves (geometric convergence over
 * several passes) while `emit.ts`'s post-rewrite safety net wants the
 * SMALLEST possible correction, tried exactly once.
 *
 * Exported for `emit.ts`'s post-rewrite budget check ONLY — never reachable
 * at today's calibrated reserves, so this earns no call site of its own
 * elsewhere. Returns `undefined` when there is no evidence body left that can
 * shrink by a line (no evidence array, no parsable `range`, or a body already
 * down to its first line); the caller fails closed in that case.
 */
export function shrinkLargestEvidenceByOneLine(payload: ShedPayload): ShedPayload | undefined {
  const evidence = payload["evidence"];
  if (!Array.isArray(evidence)) return undefined;
  let index = -1;
  let widest = -1;
  evidence.forEach((raw, i) => {
    if (!isRecord(raw)) return;
    const body = raw["body"];
    if (typeof body === "string" && body.length > widest) {
      widest = body.length;
      index = i;
    }
  });
  if (index === -1) return undefined;
  const entry = evidence[index] as Record<string, unknown>;
  const body = entry["body"];
  const range = entry["range"];
  if (typeof body !== "string" || typeof range !== "string") return undefined;
  const window = parseWindow(range);
  if (window === undefined || window.end <= window.start) return undefined;
  const trailingNewline = body.endsWith("\n");
  const lines = (trailingNewline ? body.slice(0, -1) : body).split("\n");
  if (lines.length < 2) return undefined;
  lines.pop();
  const shrunkBody = lines.join("\n") + (trailingNewline ? "\n" : "");
  const shrunkRange = `${window.start}-${window.end - 1}`;
  const shrunkEvidence = evidence.map((raw, i) => (
    i === index ? { ...entry, body: shrunkBody, range: shrunkRange } : raw
  ));
  return { ...payload, evidence: shrunkEvidence };
}

/**
 * The `start-end` string naming the SINGLE line `droppedLine`, merged onto
 * the front of `priorRemaining` (a `read.batch` entry's own `remaining_ranges`,
 * already recording what an EARLIER truncation — `readCodeModes.ts`'s
 * `resolveSlice`, or server.ts's `truncateResolvedItemToFit` — deferred).
 * Extends the first prior span left by one line when it is immediately
 * adjacent (`droppedLine + 1 === priorStart`, the ordinary case: this shrink
 * always narrows the entry's OWN still-being-served tail, which sits right
 * before whatever was already deferred); otherwise prepends a new one-line
 * span, never dropping a prior span or merging two that are not adjacent.
 */
function withDroppedLineMerged(droppedLine: number, priorRemaining: readonly string[]): string[] {
  const first = priorRemaining[0];
  const firstWindow = first !== undefined ? parseWindow(first) : undefined;
  if (firstWindow !== undefined && firstWindow.start === droppedLine + 1) {
    return [`${droppedLine}-${firstWindow.end}`, ...priorRemaining.slice(1)];
  }
  return [`${droppedLine}-${droppedLine}`, ...priorRemaining];
}

/**
 * BCF2 (eval-0929 §9): the `read.batch` sibling of `shrinkLargestEvidenceByOneLine`
 * above — same contract (SMALLEST possible correction, tried exactly once,
 * for `emit.ts`'s post-rewrite budget check ONLY), extended to the shape
 * `read.batch` uses instead of `read.text`'s `evidence[]`: `entries[]`, each
 * addressed by `content`+`range` rather than `body`+`range`.
 *
 * THE GAP THIS CLOSES (V15-BCF's own reported residual, this package's
 * item 2): a force-admitted, byte-fitted batch entry whose resolution ALSO
 * staged a read request can have `applyReadRequestContinuation`'s rewrite
 * (replacing a short per-entry `next`/top-level `next` with the unified
 * cursor call) grow the response past budget — `shrinkLargestEvidenceByOneLine`
 * returns `undefined` for a `read.batch` (no top-level `evidence[]`), so
 * there was no fallback and the call refused `budget-below-minimum` outright,
 * discarding an already-correctly-sized batch.
 *
 * ONLY an entry that carries BOTH a `content` string and a parseable `range`
 * is eligible — a `form:"file"`/`form:"file-downgraded"` entry has no range
 * to narrow, and WP-G's standing rule ("never drop an entry" —
 * `readRequestContinuation.ts`'s `clearContinuation`/`addressesForeignPath`
 * doc comments) means shrinking one entry's own content by a line is the one
 * correction this function may make; removing an entry from `entries[]`
 * entirely is not among its options. Among eligible entries, picks the
 * WIDEST by `content.length` — the same single well-defined choice the
 * evidence-shaped sibling makes.
 *
 * UNLIKE the evidence-shaped sibling, this ALSO updates the shrunk entry's
 * own `remaining_ranges` (`withDroppedLineMerged`, above) and sets
 * `truncated: true`: `rewriteContinuation`'s `entries[]` branch (this file)
 * only ever replaces an entry's OWN `next`, never derives or writes
 * `remaining_ranges` for it the way it derives `evidence[].remaining` from
 * the settled read-request state — `read.batch` has no top-level `evidence`
 * array for `shippedWindowsByPath` to settle against, so nothing downstream
 * would otherwise record that this line was held back. Recording it here is
 * what keeps the dropped line disclosed rather than silently lost.
 *
 * Returns `undefined` when there is no eligible entry to shrink (no
 * `entries[]` array, no entry has both `content` and a parseable `range`, or
 * the widest eligible entry's content is already down to one line) — the
 * caller fails closed exactly as it already does for the evidence-shaped case.
 */
export function shrinkLargestBatchEntryByOneLine(payload: ShedPayload): ShedPayload | undefined {
  const entries = payload["entries"];
  if (!Array.isArray(entries)) return undefined;
  let index = -1;
  let widest = -1;
  entries.forEach((raw, i) => {
    if (!isRecord(raw)) return;
    const content = raw["content"];
    const range = raw["range"];
    if (typeof content !== "string" || typeof range !== "string") return;
    if (parseWindow(range) === undefined) return;
    if (content.length > widest) {
      widest = content.length;
      index = i;
    }
  });
  if (index === -1) return undefined;
  const entry = entries[index] as Record<string, unknown>;
  const content = entry["content"];
  const range = entry["range"];
  if (typeof content !== "string" || typeof range !== "string") return undefined;
  const window = parseWindow(range);
  if (window === undefined || window.end <= window.start) return undefined;
  const trailingNewline = content.endsWith("\n");
  const lines = (trailingNewline ? content.slice(0, -1) : content).split("\n");
  if (lines.length < 2) return undefined;
  lines.pop();
  const shrunkContent = lines.join("\n") + (trailingNewline ? "\n" : "");
  const shrunkRange = `${window.start}-${window.end - 1}`;
  const priorRemaining = Array.isArray(entry["remaining_ranges"])
    ? (entry["remaining_ranges"] as unknown[]).filter((value): value is string => typeof value === "string")
    : [];
  const remainingRanges = withDroppedLineMerged(window.end, priorRemaining);
  const shrunkEntry = {
    ...entry,
    content: shrunkContent,
    range: shrunkRange,
    truncated: true as const,
    remaining_ranges: remainingRanges,
  };
  const shrunkEntries = entries.map((raw, i) => (i === index ? shrunkEntry : raw));
  return { ...payload, entries: shrunkEntries };
}

/**
 * Rewrite every `next` position to the ONE cursor call, and every
 * `evidence[].remaining` to that target's D.
 */
function rewriteContinuation(
  payload: ShedPayload,
  call: ToolCall,
  remainingByPath: Map<string, string[]>,
  soleRemaining: string[],
): ShedPayload {
  const next: ShedPayload = { ...payload };

  const limit = next["limit"];
  next["limit"] = isRecord(limit)
    ? { ...limit, cause: "wire", next: call }
    : { cause: "wire", omitted: ["evidence"], next: call };

  if (replaceableNext(next["next"])) next["next"] = call;

  // finding 7: a receipt built at dispatch time (`server.ts`'s
  // `openParentReceiptContinuation`, via `openParentReadRequest`'s own
  // internal settle) can mint its OWN cursor for this same parent request
  // BEFORE this tail runs — a different `stateVersion`, hence a genuinely
  // different token, than the one this tail is about to install as
  // `limit.next`. Design §5.3: "実行の正典となるnextを一つに集約し…同じ親
  // requestを保持する同等の継続にする" — overwrite it with the SAME call
  // rather than leave two non-equivalent cursors fixing two different pages.
  const receipt = next["receipt"];
  if (isRecord(receipt) && replaceableNext(receipt["next"])) {
    next["receipt"] = { ...receipt, next: call };
  }

  const evidence = next["evidence"];
  if (Array.isArray(evidence)) {
    // ONE `remaining` PER TARGET, ON ITS FIRST ENTRY — the same convention
    // `readFamily.ts`'s `textEvidence` already follows when it folds
    // `remaining_ranges` onto `evidence[0]`. A multi-window serve projects one
    // entry per window; repeating D on each of them would state the same
    // outstanding work N times, and a reader summing `remaining` (which is the
    // only honest way to ask "how much is left?") would get N x D.
    const claimed = new Set<string>();
    next["evidence"] = evidence.map((entry) => {
      if (!isRecord(entry)) return entry;
      const path = entry["path"];
      const key = typeof path === "string" ? path : "";
      const windows = typeof path === "string" && remainingByPath.has(path)
        ? remainingByPath.get(path)!
        : remainingByPath.size === 1 ? soleRemaining : undefined;
      if (windows === undefined) return entry;
      const first = !claimed.has(key);
      claimed.add(key);
      const copy = { ...entry };
      if (!first || windows.length === 0) delete copy["remaining"];
      else copy["remaining"] = windows;
      return copy;
    });
  }

  const entries = next["entries"];
  if (Array.isArray(entries)) {
    next["entries"] = entries.map((entry) => {
      if (!isRecord(entry) || !replaceableNext(entry["next"])) return entry;
      return { ...entry, next: call };
    });
  }

  return next;
}

/**
 * Every `path` a `tl_read_file` continuation call names directly — `path`,
 * `targets[].path`, or a `paths[]` entry (object or bare string). Mirrors
 * `readFamily.ts`'s own `toolCallAddresses`, kept local rather than shared:
 * this module has no other dependency on the read-family projector.
 *
 * A `handle`-only entry is deliberately left unresolved (this module has no
 * handle table to resolve it against) — see `addressesForeignPath`'s own
 * doc comment for why that is safe for every call this function is asked
 * about today.
 */
function toolCallNamedPaths(value: unknown): Set<string> {
  const paths = new Set<string>();
  if (!isRecord(value)) return paths;
  const args = value["arguments"];
  if (!isRecord(args)) return paths;
  const addPath = (candidate: unknown): void => {
    if (typeof candidate === "string" && candidate !== "") paths.add(candidate);
  };
  addPath(args["path"]);
  for (const entry of Array.isArray(args["targets"]) ? args["targets"] : []) {
    if (isRecord(entry)) addPath(entry["path"]);
  }
  for (const entry of Array.isArray(args["paths"]) ? args["paths"] : []) {
    if (isRecord(entry)) addPath(entry["path"]);
    else addPath(entry);
  }
  return paths;
}

/**
 * eval-0929 §8 (WP-G): true iff `next` NAMES a path outside this staged
 * request's own `paths` (its Q) — i.e. this continuation is not the one
 * `clearContinuation`'s caller is settling, and dropping it would lose a
 * DIFFERENT target's own disclosure.
 *
 * THE DEFECT THIS CLOSES. A mixed `targets:[]` batch — one entry the caller
 * ranged, one it left bare — stages a read-request Q from ONLY the bare
 * entry: the ranged one is served through `resolveRangedPathsBatchEntry`,
 * which never calls `stageFullReadRequest`/`appendReadRequestTarget` (see
 * `server.ts`'s R2 comment on that helper, mode=full paths[] batch). When
 * the bare entry is small enough to admit and the ranged one alone exceeds
 * the caller's budget, THIS path's own Q reaches D=∅ on this call —
 * legitimately — but the response ALSO carries the OTHER entry's
 * `limit.next` (server.ts's own `deferredForNext`, reason `cap-exceeded`),
 * naming a path this Q never staged. The pre-fix `dropLimit` fired on ANY
 * `wire`-caused `limit.next` bound for `tl_read_file`, with no check for WHICH
 * path it named — deleting the one remaining trace of a target the caller
 * explicitly asked for and the server explicitly deferred: no entry, no
 * `next`, no `limit`, no disclosure at all (confirmed live — a
 * `large.ts`+`small.ts` batch under a byte budget shipped `small.ts` only,
 * with `large.ts` neither entried, nor omitted, nor continued).
 *
 * FAILS CLOSED TOWARD THE PRE-FIX BEHAVIOUR, NOT TOWARD KEEPING EVERYTHING:
 * a `next` that names NO path at all (a handle-only rung, or a bare cursor)
 * returns `false` here — "no foreign path found" — so the existing,
 * legitimate single-target continuation-clearing this function was written
 * for is unaffected byte-for-byte.
 */
function addressesForeignPath(value: unknown, paths: ReadonlySet<string>): boolean {
  for (const path of toolCallNamedPaths(value)) {
    if (!paths.has(path)) return true;
  }
  return false;
}

/**
 * Drop the continuation this request no longer owes (§3.3's terminal rule).
 *
 * RETURNS BY IDENTITY WHEN THERE IS NOTHING TO CLEAR, which is the ordinary
 * case: a read that delivered everything it was asked for carries no `limit`
 * and no `remaining` in the first place. The identity return is what keeps
 * `emit.ts` from re-serializing — and therefore what keeps the §0.3 byte
 * invariant structural rather than arithmetic — on every complete read.
 *
 * eval-0929 §8 (WP-G): a `wire` `limit`/`next`/`receipt.next` that names a
 * path OUTSIDE `paths` is a DIFFERENT target's own disclosure riding the
 * same response (a mixed batch's still-deferred sibling) — this request's
 * own terminal rule does not own it and must not delete it
 * (`addressesForeignPath`).
 */
function clearContinuation(payload: ShedPayload, paths: ReadonlySet<string>): ShedPayload {
  const limit = payload["limit"];
  const dropLimit = isRecord(limit) && limit["cause"] === "wire" && replaceableNext(limit["next"])
    && !addressesForeignPath(limit["next"], paths);
  const dropNext = replaceableNext(payload["next"]) && !addressesForeignPath(payload["next"], paths);
  // finding 7's other half: a stale receipt-side cursor (minted at dispatch
  // time, before this settle found D empty) must not survive past the point
  // §3.3's terminal rule fires — an empty-D response owes no continuation in
  // ANY position, `receipt.next` included.
  const receipt = payload["receipt"];
  const dropReceiptNext = isRecord(receipt) && replaceableNext(receipt["next"])
    && !addressesForeignPath(receipt["next"], paths);
  const evidence = payload["evidence"];
  const clearable = Array.isArray(evidence)
    && evidence.some((entry) => {
      if (!isRecord(entry) || entry["remaining"] === undefined) return false;
      const path = entry["path"];
      return !(typeof path === "string" && !paths.has(path) && paths.size > 1);
    });
  if (!dropLimit && !dropNext && !dropReceiptNext && !clearable) return payload;

  const next: ShedPayload = { ...payload };
  // A next-less `wire` limit is unconstructible (A.8.1 E-5), and the honest
  // fallback `wireLimit.ts` itself names for that situation is to say nothing:
  // "The response is smaller than it was and discloses no limit, which
  // understates rather than misstates."
  if (dropLimit) delete next["limit"];
  if (dropNext) delete next["next"];
  if (dropReceiptNext && isRecord(receipt)) {
    const receiptCopy = { ...receipt };
    delete receiptCopy["next"];
    next["receipt"] = receiptCopy;
  }
  if (Array.isArray(evidence)) {
    next["evidence"] = evidence.map((entry) => {
      if (!isRecord(entry) || entry["remaining"] === undefined) return entry;
      const path = entry["path"];
      if (typeof path === "string" && !paths.has(path) && paths.size > 1) return entry;
      const copy = { ...entry };
      delete copy["remaining"];
      return copy;
    });
  }
  return next;
}

/**
 * Settle the staged request and install its ONE canonical continuation.
 *
 * Returns the payload by IDENTITY when no request is staged, or when nothing
 * could be persisted — a fabricated cursor is worse than the producer's own
 * `next`, so a store failure falls back rather than inventing state.
 */
export function applyReadRequestContinuation(
  payload: ShedPayload,
  staged: StagedReadRequest | undefined,
  claim: {
    budgetDeclared: boolean;
    shed: boolean;
    /**
     * R2-R1: the exact size of the smallest response this request can be served
     * in, measured by the funnel when the ladder failed closed to a `cap-exceeded`
     * refusal (which names no floor of its own). See `budgetFloorOf`.
     */
    refusalFloorBytes?: number;
    /**
     * R2-R1: the refused response was a multi-target `read.batch`. Its floor is the
     * smallest whole-ENTRY batch (`readBatchRequiredMinBytes`), not the smallest
     * response the request can be served in: the cursor pages the same request file
     * by file INSIDE the budget the caller declared (v0.14.4's recovery — a batch
     * declared at 700 B is served in ~600 B pages), where a restart at that floor
     * would answer a 700 B budget with a ~5.5 KB batch. Such a refusal keeps the
     * plain cursor.
     */
    refusalOfBatch?: boolean;
  },
): ShedPayload {
  if (staged === undefined) return payload;
  // WHICH RESPONSES THIS OWNS, AND WHY IT IS NOT ALL OF THEM.
  //
  // A `resume` is always ours: a cursor call exists only to continue this
  // request, and its next page cannot come from anywhere else.
  //
  // An `open` is ours only when the caller's OWN budget bound the response, or
  // when the ladder actually cut it. Outside those two, the response was shaped
  // entirely by a PRODUCER cap — `buildFullServePayload`'s 24576 B governed
  // head, `resolveSliceRanges`' own ceiling — and those continuations are
  // already correct: one `next`, naming `servedLines+1 .. totalLines`, i.e.
  // exactly D. Replacing a correct continuation with an equivalent one would
  // buy nothing and would move wire bytes on every default-budget read, which
  // `emit.ts`'s "REFACTOR AT DEFAULT BUDGETS" invariant and the §6.1(b) pins
  // (replay corpus svc1/svc2/tsl1) forbid. R2's defect is the ladder's
  // continuation, and this is the boundary of the fix.
  if (staged.mode === "open" && !claim.budgetDeclared && !claim.shed) return payload;
  // R2-R1 (FX1 chip 3 + P0-2): A BUDGET REFUSAL CARRIES ONE EXECUTABLE `next` —
  // THE CALL THAT FITS. A plain cursor on a refusal (what this tail installed
  // before) re-runs the very page that just did not fit at the very budget
  // that just refused it: the reviewer's markdown range at 600 B answered
  // `cap-exceeded` forty times in a row, every `next` re-issuing the same call.
  // With a floor in hand — the refusal's own `required_min_bytes`, or the one
  // the funnel measured for a `cap-exceeded` — the `next` changes the ONE
  // thing that makes it fit: the budget.
  //   - `open`: nothing was served, so nothing is settled, persisted or
  //     indexed (a refused call must not leave an "open parent request" for a
  //     later plain read to attach a `next` to), and the retry is the ORIGINAL
  //     request, fresh, at the floor — whose own first-call floor is exactly
  //     the one measured, so it works on the first retry.
  //   - `resume`: the same cursor, budget raised (the cursor call's sanctioned
  //     override) — below.
  const refusalFloor = payload["kind"] === "refusal" && claim.refusalOfBatch !== true
    ? budgetFloorOf(payload, claim.refusalFloorBytes)
    : undefined;
  if (refusalFloor !== undefined && staged.mode === "open") {
    return rewriteContinuation(payload, restartCall(staged, refusalFloor), new Map<string, string[]>(), []);
  }
  const settled = settleReadRequest(staged, shippedWindowsByPath(payload));
  if (settled === undefined) return payload;

  const paths = new Set(settled.targets.map((target) => target.path));
  const complete = readRequestComplete(settled);
  // DESIGN-v0.15 §6.2 (R4): index this request (by path) while it is still
  // owed lines, so a LATER plain read of the same path — no cursor, just an
  // ordinary symbol/range re-ask — can find it and carry its `next` forward
  // instead of ending as an unrelated next-less receipt. Dropped again the
  // moment a settle (this one, or one run from that later lookup) empties D.
  markReadRequestOpenness(staged, complete);
  if (complete) return clearContinuation(payload, paths);

  const cursor = mintReadCursor(staged);
  if (cursor === undefined) return payload;

  const remainingByPath = new Map<string, string[]>();
  for (const target of settled.targets) {
    remainingByPath.set(target.path, windowStrings(target.remaining));
  }
  const sole = settled.targets.length === 1
    ? windowStrings(settled.targets[0]!.remaining)
    : [];
  return rewriteContinuation(
    payload,
    refusalFloor !== undefined ? budgetedCursorCall(staged, cursor, refusalFloor) : cursorCall(staged, cursor),
    remainingByPath,
    sole,
  );
}

/** The call-scoping members every continuation this module mints echoes (`cursorCall`'s own rule). */
function echoedIdentity(staged: StagedReadRequest): Record<string, unknown> {
  const echo = staged.echo;
  return {
    ...(echo.cwd !== undefined && echo.cwd !== "" ? { cwd: echo.cwd } : {}),
    ...(echo.lane !== undefined && echo.lane !== "" ? { lane: echo.lane } : {}),
    ...(echo.taskHandle !== undefined && echo.taskHandle !== "" ? { task: { handle: echo.taskHandle } } : {}),
  };
}

/** The ORIGINAL request, fresh, at `budgetBytes` — the shape the stale-cursor restart already uses. */
function restartCall(staged: StagedReadRequest, budgetBytes: number): ToolCall {
  return canonicalToolCall("tl_read_file", {
    ...staged.state.original_input,
    budget: { bytes: budgetBytes },
    ...echoedIdentity(staged),
  }) as ToolCall;
}

/** The same cursor with its budget raised (a cursor call's sanctioned override). */
function budgetedCursorCall(staged: StagedReadRequest, cursor: string, budgetBytes: number): ToolCall {
  return canonicalToolCall("tl_read_file", {
    cursor,
    budget: { bytes: budgetBytes },
    ...echoedIdentity(staged),
  }) as ToolCall;
}

/**
 * The byte floor a budget refusal names: its own `required_min_bytes`
 * (`budget-below-minimum`), or — for a `cap-exceeded`, which names none — the
 * floor the funnel measured (`claimFloor`). `undefined` when the refusal is not
 * a budget refusal or no floor is known: such a refusal keeps the plain cursor
 * it always had rather than a guess.
 */
function budgetFloorOf(payload: ShedPayload, claimFloor: number | undefined): number | undefined {
  const code = payload["code"];
  if (code !== "budget-below-minimum" && code !== "cap-exceeded") return undefined;
  const named = payload["required_min_bytes"];
  if (typeof named === "number" && Number.isFinite(named) && named > 0) return Math.ceil(named);
  return claimFloor !== undefined && Number.isFinite(claimFloor) && claimFloor > 0 ? Math.ceil(claimFloor) : undefined;
}

// ---------------------------------------------------------------------------
// R2-R1 (P0-2, review 2026-09-30) — DECIDE THE FINAL PAYLOAD BEFORE ANYTHING
// IS BOOKED.
//
// `emit.ts` settles the served-range LEDGER (`settleServedCallBookings`) and
// the read REQUEST (`applyReadRequestContinuation`) against the payload the
// ladder produced, and only THEN measures what the cursor swap made of it. When
// that measurement found the page over budget, the post-rewrite safety net
// dropped a line (or replaced the whole page by a `budget-below-minimum`
// refusal) — but the ledger had already booked every line of the pre-shrink
// payload, and `D = Q - (C u S)` reads `C` from that ledger, so the dropped
// lines were never owed again. Measured on the reviewer's own fixture: a
// refused first call booked lines 1-126 that never shipped; the re-issued call
// served 1-75 and its cursor resumed at 127 — lines 76-126 were skipped for
// good, silently, while `limit.next` claimed the chain was on track. The same
// mechanism lost the last line of a multi-window page (FX1 chip 2).
//
// The ledger cannot be un-booked from here, so the order changes instead:
// `fitStagedReadToBudget` runs a DRY RUN of the continuation
// (`previewSettledRemaining`, the real cursor, D for what would ship), sheds
// prose and whole lines until the response fits, or reports the exact floor;
// the funnel then settles the ledger and the request ONCE, on what ships.
// ---------------------------------------------------------------------------

/**
 * What `applyReadRequestContinuation` WOULD return for `payload`, computed
 * WITHOUT booking, persisting or minting anything (`previewSettledRemaining`
 * is the pure half of the settle; `call` is the cursor call the tail would
 * install, minted once by the caller because it is loop-invariant). The bytes
 * are the real ones: same D per target, same collapsed `next` positions, same
 * cursor call.
 */
function previewContinuation(
  payload: ShedPayload,
  staged: StagedReadRequest,
  call: ToolCall,
): { payload: ShedPayload; continued: boolean } {
  const remaining = previewSettledRemaining(staged, shippedWindowsByPath(payload));
  const targets = staged.state.targets;
  const paths = new Set(targets.map((target) => target.path));
  const complete = targets.every((target) => (remaining.get(target.path) ?? []).length === 0);
  if (complete) return { payload: clearContinuation(payload, paths), continued: false };
  const remainingByPath = new Map<string, string[]>();
  for (const target of targets) remainingByPath.set(target.path, windowStrings(remaining.get(target.path) ?? []));
  const sole = targets.length === 1 ? windowStrings(remaining.get(targets[0]!.path) ?? []) : [];
  return { payload: rewriteContinuation(payload, call, remainingByPath, sole), continued: true };
}

/**
 * The decorative prose the ladder's first `read.text` rung sheds
 * (`shedders/readText.ts`'s `TEXT_PROSE`), cheapest-loss-first. Peeled here
 * BEFORE any line is dropped, exactly as the ladder orders it: a note costs the
 * caller bytes it declared it could not spare, a line costs it content.
 */
const READ_PROSE_KEYS: readonly string[] = ["note", "focus", "hint", "headings_note", "concern_note"];

/** The payload without its cheapest prose member, or `undefined` when none is left. A NUL-strip disclosure is never prose. */
function peelReadProse(payload: ShedPayload): ShedPayload | undefined {
  for (const key of READ_PROSE_KEYS) {
    if (payload[key] === undefined || carriesStripDisclosure(payload[key])) continue;
    const peeled: ShedPayload = { ...payload };
    delete peeled[key];
    return peeled;
  }
  return undefined;
}

/**
 * Drop trailing whole lines from the WIDEST evidence body that still has more
 * than one line — as many as it takes to save `excessBytes` of wire (at least
 * one, never the last) — narrowing its `range` the way the ladder's own rung
 * does (`start + keptLines - 1`: a body whose lines were collapsed or elided
 * can only be UNDER-claimed, so nothing is ever claimed that did not ship).
 * `remaining` is not touched here: the continuation preview and the real tail
 * both derive D from what the evidence carries.
 */
function shrinkEvidenceBySavedBytes(payload: ShedPayload, excessBytes: number): ShedPayload | undefined {
  const evidence = payload["evidence"];
  if (!Array.isArray(evidence)) return undefined;
  let index = -1;
  let widest = -1;
  evidence.forEach((raw, i) => {
    if (!isRecord(raw)) return;
    const body = raw["body"];
    const range = raw["range"];
    if (typeof body !== "string" || typeof range !== "string" || parseWindow(range) === undefined) return;
    const lineCount = (body.endsWith("\n") ? body.slice(0, -1) : body).split("\n").length;
    if (lineCount < 2) return;
    if (body.length > widest) {
      widest = body.length;
      index = i;
    }
  });
  if (index === -1) return undefined;
  const entry = evidence[index] as Record<string, unknown>;
  const body = entry["body"] as string;
  const window = parseWindow(entry["range"] as string)!;
  const trailingNewline = body.endsWith("\n");
  const lines = (trailingNewline ? body.slice(0, -1) : body).split("\n");
  let saved = 0;
  let drop = 0;
  while (drop < lines.length - 1 && (drop === 0 || saved < excessBytes)) {
    saved += wireLineCostBytes(lines[lines.length - 1 - drop]!);
    drop += 1;
  }
  const kept = lines.length - drop;
  const shrunkEntry = {
    ...entry,
    body: lines.slice(0, kept).join("\n") + (trailingNewline ? "\n" : ""),
    range: `${window.start}-${window.start + kept - 1}`,
  };
  return { ...payload, evidence: evidence.map((raw, i) => (i === index ? shrunkEntry : raw)) };
}

/** What `fitStagedReadToBudget` decided. */
export type StagedReadFit =
  | { ok: true; payload: ShedPayload; shrunk: boolean }
  | { ok: false; requiredMinBytes: number };

/** Hard stop for the shrink loop: a bulk step removes at least the measured excess, so a handful of passes always suffice. */
const MAX_PRESETTLE_STEPS = 256;

/**
 * Bytes kept in reserve beneath `limit` — but ONLY for a payload some line was
 * cut from (by the ladder before the fit, or by the fit itself). The preview's
 * D is `Q - (C_baseline u S)` (`previewSettledRemaining`); the real D, derived
 * after the funnel confirmed or narrowed this call's provisional spans, reads
 * the live ledger, which can differ from the preview's by a few characters of
 * `remaining` (a digit, or one more window when a corroborated span is narrowed
 * in the middle of a window, or coverage another read added meanwhile). For a
 * payload nothing was cut from, the producer booked exactly what ships and the
 * two agree — reserving anything there would refuse a response that fits (FX1's
 * floor: a budget one byte above the smallest one-line page must serve it). For
 * a payload lines were cut from, sizing to `limit - 16` makes that difference
 * unable to push the REAL response over the limit — the one outcome that would
 * re-open the hole this closes, because the post-rewrite net that would then
 * fire cannot un-book a ledger. The refusal's floor carries the same 16 B in
 * that case, so it works on the first retry.
 */
const PRESETTLE_SAFETY_BYTES = 16;

/**
 * Size a staged read's response — AFTER the cursor swap, the real bytes — and
 * shed until it fits `limit`, BEFORE the ledger or the request is settled.
 *
 * Order, exactly the ladder's: decorative prose first, then whole lines from
 * the widest body (`shrinkEvidenceBySavedBytes`; a `read.batch` entry one line
 * at a time, `shrinkLargestBatchEntryByOneLine`). `shrunk` is true iff a LINE
 * was dropped: the funnel must then treat the response as shed (`wasShed`) so
 * the ledger's settlement can never widen a corroborated window back over the
 * lines that were cut.
 *
 * `{ok:false}` means nothing more can be shed (every body is down to one line,
 * no prose is left) and the response STILL does not fit: `requiredMinBytes` is
 * the exact size of that smallest response — a budget of that many bytes
 * serves it, so the refusal's floor works on its FIRST retry (the previous
 * floor was the size of the unshrunk page, a moving target that grew with the
 * budget it had just been sized for). The caller builds the refusal BEFORE
 * booking anything, so a refused call books nothing.
 *
 * A no-op (`ok:true`, payload by identity) for a refusal, for an `open` request
 * the tail would leave alone (no declared budget, nothing shed), and when no
 * cursor can be minted — exactly the cases `applyReadRequestContinuation`
 * itself leaves alone.
 */
export function fitStagedReadToBudget(input: {
  payload: ShedPayload;
  staged: StagedReadRequest;
  claim: { budgetDeclared: boolean; shed: boolean };
  limit: number;
  /** The ONE sanctioned wire-byte counter, passed in so this module never imports the budget layer. */
  measure: (payload: ShedPayload) => number;
}): StagedReadFit {
  const { staged, claim, limit, measure } = input;
  let candidate = input.payload;
  if (candidate["kind"] === "refusal") return { ok: true, payload: candidate, shrunk: false };
  if (staged.mode === "open" && !claim.budgetDeclared && !claim.shed) return { ok: true, payload: candidate, shrunk: false };
  const cursor = mintReadCursor(staged);
  if (cursor === undefined) return { ok: true, payload: candidate, shrunk: false };
  const call = cursorCall(staged, cursor);
  // The reserve exists only for a response that WILL carry a continuation (a
  // complete one, D empty, is exactly what the real tail ships) and whose
  // lines were cut somewhere (see `PRESETTLE_SAFETY_BYTES`).
  const sized = (payload: ShedPayload, linesCut: boolean): number => {
    const preview = previewContinuation(payload, staged, call);
    return measure(preview.payload) + (preview.continued && linesCut ? PRESETTLE_SAFETY_BYTES : 0);
  };
  let shrunk = false;
  let bytes = sized(candidate, claim.shed);
  for (let step = 0; step < MAX_PRESETTLE_STEPS; step += 1) {
    if (bytes <= limit) return { ok: true, payload: candidate, shrunk };
    const peeled = peelReadProse(candidate);
    const smaller = peeled
      ?? shrinkEvidenceBySavedBytes(candidate, bytes - limit)
      ?? shrinkLargestBatchEntryByOneLine(candidate);
    if (smaller === undefined) return { ok: false, requiredMinBytes: bytes };
    if (peeled === undefined) shrunk = true;
    candidate = smaller;
    bytes = sized(candidate, claim.shed || shrunk);
  }
  return bytes <= limit ? { ok: true, payload: candidate, shrunk } : { ok: false, requiredMinBytes: bytes };
}

/**
 * The exact size of the SMALLEST response a staged read can be served in —
 * every body down to one line, prose gone, continuation and cursor included —
 * or `undefined` when nothing is staged/sizeable. This is the floor a
 * `cap-exceeded` refusal (which names none) hands to `applyReadRequestContinuation`
 * so its `next` can raise the budget to a value that works on the first retry.
 */
export function stagedReadFloorBytes(input: {
  payload: ShedPayload;
  staged: StagedReadRequest;
  claim: { budgetDeclared: boolean; shed: boolean };
  measure: (payload: ShedPayload) => number;
}): number | undefined {
  const fit = fitStagedReadToBudget({ ...input, limit: 0 });
  return fit.ok ? undefined : fit.requiredMinBytes;
}
