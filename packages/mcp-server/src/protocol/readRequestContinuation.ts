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
import type { ShedPayload } from "./budget/shedders/registry.js";
import { canonicalToolCall } from "./envelope.js";
import {
  markReadRequestOpenness,
  mintReadCursor,
  parseWindow,
  readRequestComplete,
  settleReadRequest,
  windowStrings,
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
  return canonicalToolCall("read_file", {
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
  return isRecord(value) && value["tool"] === "read_file";
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
    if (typeof body !== "string" || body === "" || typeof range !== "string") continue;
    const window = parseWindow(range);
    if (window !== undefined) map.get(path)!.push(window);
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
 * Drop the continuation this request no longer owes (§3.3's terminal rule).
 *
 * RETURNS BY IDENTITY WHEN THERE IS NOTHING TO CLEAR, which is the ordinary
 * case: a read that delivered everything it was asked for carries no `limit`
 * and no `remaining` in the first place. The identity return is what keeps
 * `emit.ts` from re-serializing — and therefore what keeps the §0.3 byte
 * invariant structural rather than arithmetic — on every complete read.
 */
function clearContinuation(payload: ShedPayload, paths: ReadonlySet<string>): ShedPayload {
  const limit = payload["limit"];
  const dropLimit = isRecord(limit) && limit["cause"] === "wire" && replaceableNext(limit["next"]);
  const dropNext = replaceableNext(payload["next"]);
  // finding 7's other half: a stale receipt-side cursor (minted at dispatch
  // time, before this settle found D empty) must not survive past the point
  // §3.3's terminal rule fires — an empty-D response owes no continuation in
  // ANY position, `receipt.next` included.
  const receipt = payload["receipt"];
  const dropReceiptNext = isRecord(receipt) && replaceableNext(receipt["next"]);
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
  claim: { budgetDeclared: boolean; shed: boolean },
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
  return rewriteContinuation(payload, cursorCall(staged, cursor), remainingByPath, sole);
}
