// read-receipts — extracted implementation; imports point to the owning modules.
import type { RefusalCode } from "@tokenlighten/types";
import type { ServedRangeLedgerReceipt } from "../state/session.js";
import type { ToolCall } from "@tokenlighten/types";
import { GOVERNED_FULL_SERVE_BYTES } from "../util/fullGovernor.js";
import { MAX_SLICE_RANGES } from "../tools/readCodeModes.js";
import { READ_SYMBOL_CAP_BYTES } from "../tools/readCodeModes.js";
import { TINY_BYTES } from "../util/fullGovernor.js";
import { TINY_LINES } from "../util/fullGovernor.js";
import { attachSupply } from "../util/attachSupply.js";
import { beginServeCall } from "../state/session.js";
import { canonicalToolCall } from "../protocol/envelope.js";
import { compressFormat } from "../util/formatCompress.js";
import { countLines } from "../util/countLines.js";
import { coverageReceiptFor } from "../protocol/coverageReceipt.js";
import { coveredByField } from "../protocol/coverageReceipt.js";
import { deltaContextEnabled } from "../util/flags.js";
import { deltaLedgerStatus } from "../state/session.js";
import { elideDocComments } from "../util/formatCompress.js";
import { elideDocCommentsForDisplay } from "../util/formatCompress.js";
import { elideDocCommentsWithWindows } from "../util/formatCompress.js";
import { extractSymbolsFromFile } from "../tools/readCodeModes.js";
import { handleTable } from "../util/handles.js";
import { languageForPath } from "../util/languages.js";
import { mustFetchReadBudget } from "../util/mustFetch.js";
import { planBudgetedFullServe } from "../tools/readCodeModes.js";
import { recordFullServeCompleteness } from "../state/session.js";
import { recordReadPath } from "../state/session.js";
import { recordServedRange } from "../state/session.js";
import { servedRangeCoverage } from "../state/session.js";
import { servedRangeReceipt } from "../state/session.js";
import { servedRangeUnheldLines } from "../state/session.js";
import { shaOfText } from "../util/handles.js";
import { shortSha } from "../util/handles.js";
import { spansExcludingWindows } from "../util/formatCompress.js";
import { stageFullReadRequest } from "./canonical-input3.js";
import { toolOk } from "../protocol/result.js";
import { trace } from "../util/trace.js";
import { wasFullyServed } from "../state/session.js";

/**
 * The process's single guard stack, handed to write/guardedWorkspace.ts once,
 * here, at module init (function declarations are hoisted, so this runs after
 * nothing that matters and before any dispatch). From this point on the ONLY
 * way a dispatch case can obtain a `GuardedWorkspaceRoot` — and therefore the
 * only way it can reach `createFile`/`applyEditsMulti`/`searchReplaceEdit`/
 * `readAndEdit`/`renameSymbol`/`editArtifact`/the pathless edits/`applyIntent`
 * — is by running these two guards in order. A second install throws, so a
 * future case cannot quietly substitute permissive guards of its own.
 *
 * The lambdas are pass-throughs on purpose: no adapter logic means nothing
 * that can drift from what dispatch used to call directly. `writesEnabled` is
 * a thunk so it reads ALLOW_WRITE at call time, matching the `if (ALLOW_WRITE)`
 * gate the write cases used to spell out themselves.
 */







/**
 * turn-economy wave 2 (W1): the file head a GOVERNED full downgrade serves.
 * Returns the leading logical lines of `content` whose cumulative UTF-8 size
 * fits `budgetBytes`, plus the file's total logical line count (countLines
 * semantics). When the whole file fits, `head === content` and
 * `servedLines === totalLines` — the caller serves it untruncated with no
 * remainder `next`.
 *
 * Line boundaries are EXACT against the original file (no elision, no
 * whitespace collapse) so the remainder range `(servedLines+1)-totalLines` a
 * truncated serve returns as `next` always lines up with what a subsequent
 * mode=slice returns. Degenerate single-long-line case (the first logical line
 * alone exceeds the budget): a byte-bounded, code-point-aligned prefix of that
 * line is served with servedLines:0, so the remainder `next` re-fetches from
 * line 1 (mode=slice clamps and continues) rather than dropping its tail.
 */
export function serveGovernedFullHead(
  content: string,
  budgetBytes: number,
): { head: string; servedLines: number; totalLines: number } {
  const totalLines = countLines(content);
  if (totalLines === 0) return { head: content, servedLines: 0, totalLines: 0 };
  if (Buffer.byteLength(content, "utf8") <= budgetBytes) {
    return { head: content, servedLines: totalLines, totalLines };
  }
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const body = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  const lines = body.split("\n"); // exactly totalLines elements (countLines semantics)
  let acc = "";
  let served = 0;
  for (let i = 0; i < lines.length; i++) {
    const candidate = i === 0 ? lines[0]! : `${acc}\n${lines[i]!}`;
    if (Buffer.byteLength(candidate, "utf8") > budgetBytes) break;
    acc = candidate;
    served = i + 1;
  }
  if (served === 0) {
    // First logical line alone overflows the budget: serve a code-point-aligned
    // prefix (never split a multi-byte char), servedLines:0 → remainder starts
    // at line 1.
    let prefix = "";
    let usedBytes = 0;
    for (const ch of lines[0]!) {
      const chBytes = Buffer.byteLength(ch, "utf8");
      if (usedBytes + chBytes > budgetBytes) break;
      prefix += ch;
      usedBytes += chBytes;
    }
    return { head: prefix, servedLines: 0, totalLines };
  }
  return { head: acc, servedLines: served, totalLines };
}

/**
 * R2-R1: the first `lines` whole lines of `content`, cut exactly the way
 * `serveGovernedFullHead` cuts a head (same newline normalization, one trailing
 * newline dropped, lines joined by "\n") — for a caller (the measured budget
 * plan, `planBudgetedFullServe`) that has already DECIDED how many lines to
 * serve. Never fewer than one line, never more than the file has.
 */
export function governedHeadByLines(
  content: string,
  lines: number,
): { head: string; servedLines: number; totalLines: number } {
  const totalLines = countLines(content);
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const body = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  const kept = Math.max(1, Math.min(lines, totalLines));
  return { head: body.split("\n").slice(0, kept).join("\n"), servedLines: kept, totalLines };
}

/**
 * The escape hatch, stated on the receipt itself. A caller whose context was
 * compacted away no longer HAS the bytes the ledger says it was served, so the
 * force-serve path must be first-class and self-documenting — never something
 * the caller has to already know.
 *
 * DESIGN-v0.15 §6.3 (R6) migration note: this used to name `content:"full"`
 * as a forcing input too, because `forceContentServe` (below) treated that
 * bare canonical field as a resend request. It no longer does — canonical
 * `content:"full"` is now purely a REPRESENTATION selector, judged in the
 * same served-range ledger as any other window, and only `task.force_serve:
 * true` (or the legacy `allowFull`/`mode:"full"` dialect kept for
 * `TL_LEGACY_INPUT=accept`'s compat window, see `forceContentServe`'s own
 * doc comment) guarantees a resend. The note is updated to match.
 */
export const SERVED_CONTENT_RECEIPT_NOTE =
  'served earlier this session and unchanged; pass task.force_serve:true to force the bytes';

/**
 * Compact receipt for a read whose payload the SAME session already served for
 * the SAME file sha (state/session.ts's servedRangeReceipt decides that;
 * qualification is deliberately conservative — exact re-serves and fully
 * subsumed ranges only). Content-EQUIVALENT to a re-serve, in the same sense
 * as task_pack's `pack_unchanged` and a surface's `code_unchanged`: the caller
 * already holds these bytes, so charging for them again buys nothing.
 *
 * `summary` carries the receipt's actual payload — precisely WHICH line ranges
 * of the file the caller holds and whether any remain unserved (same `summary`
 * convention mode=closure uses for "what this session already did"). Without
 * it the response would be a bare pointer, which is exactly the zero-content
 * shape the turn-economy work exists to eliminate.
 *
 * DESIGN-v0.15 §6.2 (R4): `summary.unserved` (when present) is purely
 * INFORMATIONAL — the rest of the FILE this session has not yet read. It is
 * never, by itself, a reason to attach a `next`: a receipt for a request
 * whose OWN window is fully satisfied ends that request (§3.3's "既読通知の
 * 終端"). The ONLY thing that may put a `next` on this receipt is
 * `parentContinuation` — an OPEN full/range/batch read request for this same
 * path that still owes lines (the caller's `openParentReceiptContinuation`
 * decides that from the read-request store, never from `ledger.unserved`).
 */
export function servedContentReceipt(args: {
  mode: string;
  path: string;
  handle: string;
  sha: string;
  range?: string;
  symbol?: string;
  ledger: ServedRangeLedgerReceipt;
  /**
   * F3 (2026-08-02 serve-honesty) override for the one caller whose `ledger`
   * is a RECORD result rather than a probe (mode=slice decides by
   * added_lines===0), so it has to carry the provenance it probed separately.
   */
  servedBy?: string;
  extra?: Record<string, unknown>;
  /** V10-02: the workspace this receipt is for, so this one function can
   *  trace repeated_range for every mode that funnels through it. Optional
   *  and additive — omitted callers simply do not emit the event. */
  workspace?: string;
  /**
   * DESIGN-v0.15 §6.2 (R4): the open PARENT request's own continuation, when
   * this window is a page of one (`openParentReceiptContinuation`). Absent
   * for an independent request — the ordinary case — which then carries no
   * `next` at all.
   */
  parentContinuation?: ToolCall;
  /**
   * 2026-10-20 (decision run 6t-7): the read of the comment lines inside this
   * receipt's own window that the caller holds no byte of
   * (`sliceReceiptCommentWindows`, kind `next`). A line of the window, not
   * the rest of the file, so it does not reopen §6.2's terminal receipt.
   * Yields to `parentContinuation`.
   */
  commentsContinuation?: ToolCall;
}): Record<string, unknown> {
  const { mode, path: filePath, handle, sha, range, symbol, ledger, extra, parentContinuation, commentsContinuation } = args;
  // F3: a receipt that cannot be checked is indistinguishable from a false
  // one — name the call that put these bytes on the wire (~30 B).
  const servedBy = args.servedBy ?? ledger.served_by;
  // V10-02: repeated_range — a served-range ledger hit answered as a
  // receipt/prior instead of fresh bytes. This function IS the shared
  // receipt builder every servedContentReceipt call site already funnels
  // through, so one trace() call here covers all of them.
  if (args.workspace !== undefined) {
    trace("repeated_range", {
      mode,
      path: filePath,
      ...(range !== undefined ? { range } : {}),
      ...(symbol !== undefined ? { symbol } : {}),
      complete: ledger.complete,
      clusters: ledger.clusters,
    }, args.workspace);
  }
  return {
    mode,
    path: filePath,
    handle,
    ...(range !== undefined ? { range } : {}),
    ...(symbol !== undefined ? { symbol } : {}),
    sha,
    // A.4 (C2-3): the `receipt` TAG is the discriminator; `code_unchanged`
    // survives as the in-process signal several read guards still read, and
    // `protocol/readFamily.ts` deletes it from the wire.
    receipt: "code-unchanged",
    code_unchanged: true,
    ...(servedBy !== undefined ? { served_by: servedBy } : {}),
    summary: {
      served: ledger.served,
      ...(ledger.unserved.length > 0 ? { unserved: ledger.unserved } : {}),
      complete: ledger.complete,
    },
    note: SERVED_CONTENT_RECEIPT_NOTE,
    // DESIGN-v0.15 §6.2 (R4): a `next` here means "the PARENT request this
    // page belongs to still owes lines", never "the file has more unread
    // lines" — `ledger.unserved` (the whole-file complement) no longer drives
    // this field; only an OPEN parent request does (R4 fix — pre-fix this
    // unconditionally named `ledger.unserved`, attaching an unrequested `next`
    // for the rest of the file to an otherwise fully-satisfied receipt).
    ...(parentContinuation !== undefined
      ? { next: parentContinuation }
      : commentsContinuation !== undefined
        ? { next: commentsContinuation }
        : {}),
    ...(extra ?? {}),
  };
}

/**
 * §3.3 addressing, applied to the fence's served receipts (C2-3).
 *
 * `state/session.ts`'s `heldSelfMaterialReceipt` proves residency of N windows
 * of ONE file, and it has no handle to name them by — the session layer holds a
 * `resolveHandlePath` callback, never the handle table. Under A.2.7 every
 * `Evidence` entry is addressed by a handle, so a receipt with only a path
 * cannot be projected without inventing one.
 *
 * The dispatcher is the layer that CAN name it, so it does: one upsert on the
 * path the receipt is already about, which mints nothing new when the file was
 * served before (that is what `upsert` means). This adds addressing to a claim
 * that was already being made; it does not widen the claim.
 */
export function addressServedReceipt(
  receipt: Record<string, unknown>,
  workspace: string,
): Record<string, unknown> {
  if (typeof receipt["handle"] === "string" && receipt["handle"] !== "") return receipt;
  const path = receipt["path"];
  if (typeof path !== "string" || path === "") return receipt;
  return {
    ...receipt,
    handle: handleTable.upsert({ kind: "file", path, workspaceRoot: workspace }).id,
  };
}

/**
 * A6 (reports/bench/2026-07-02a §3.4): every mode=full refusal — whether the
 * byte cap (even the raised allowFull ceiling) or the governor's per-path/
 * per-task cap — used to return a bare {ok:false,error} with no content. That
 * turned every refusal into a pure-loss turn (live: identical retry, then 11
 * native reads). A-2/C10.4 then made it a SUCCESS-shaped mode=skeleton payload
 * (skeleton signatures + symbol ranges + handle + a slice `next`).
 *
 * turn-economy wave 2 (W1, 2026-07-24): even that skeleton payload was the
 * WRONG mechanism. Live forensics (run 2026-07-24-semantic-signal5-2): after
 * the first ~6 non-tiny fulls, EVERY subsequent mode=full of an ordinary
 * source file was downgraded to a mode:"skeleton" response with ZERO content
 * bytes and an executable slice continuation — and the model dutifully spent
 * a manufactured second API turn (~$0.03–0.05, ~100–170K cache-read context)
 * to fetch content the caller was always going to fetch anyway, ~17 times in
 * one task. An extra turn is always worse than serving a few extra KB (<$0.01).
 *
 * So a governed downgrade now SERVES the file head up to GOVERNED_FULL_SERVE_BYTES
 * with `truncated` + handle + (only if genuinely partial) a remainder `next` —
 * the caps bound bytes-per-response, they never force a second call. The one
 * exception is content-EQUIVALENT, not a breadcrumb: a governed REPEAT read of
 * the SAME path whose sha is unchanged since the earlier FULL serve returns a
 * compact `{code_unchanged:true, handle, sha}` — the caller already holds those
 * exact bytes (see session.wasFullyServed). No skeleton, no zero-content
 * pointer, ever, on this path.
 */
export async function buildFullDowngradePayload(args: {
  workspace: string;
  filePath: string;
  content: string;
  handleId: string;
  sha: string;
  bytes: number;
  maxBytes: number;
  /**
   * A-2: the PRECISE cause, carried through verbatim so bench can attribute
   * the downgrade. Governor reasons ("per-path-cap-reached" etc.) are passed
   * straight through instead of being collapsed to "full-downgraded"; the byte
   * cap keeps "cap-exceeded" and a governor deny keeps "full-denied".
   */
  reason:
    | "cap-exceeded"
    | "full-denied"
    | "per-path-cap-reached"
    | "per-task-cap-reached"
    | "tiny-task-cap-reached"
    | "tiny-skeleton-cap-reached"
    | "allowfull-task-cap-reached"
    | "candidate-pack-full-repeat"
    | "full-downgraded";
  allowFullWouldHelp: boolean;
  /**
   * W1: retained on the signature so the three existing call sites still
   * compile unchanged, but no longer rendered — a content-bearing serve is not
   * a refusal, so it needs neither an `alternatives` menu nor a prose `hint`.
   */
  alternatives?: unknown[];
  hint?: string;
  /** Internal W5 selector; keeps the existing skeleton wire shape. */
  skeletonOnly?: boolean;
  /**
   * FX-OH F3 (2026-09-04) — THE PROJECTION THE REQUEST ASKED FOR.
   *
   * `resolveFullReadForPath` has always known this (it is `commentsMode.keep`,
   * computed once per call) and has never passed it here, so every gate below
   * decided against a ledger with no projection axis. See the F3 block comment
   * at the two gates for the self-referential dead end that caused.
   */
  keepComments: boolean;
}): Promise<Record<string, unknown>> {
  const { workspace, filePath, content, handleId, sha, bytes, reason, allowFullWouldHelp, keepComments } = args;

  // -------------------------------------------------------------------------
  // FX-OH F3 (2026-09-04) — A `comments:"keep"` REQUEST IS A REQUEST FOR BYTES
  // THE LEDGER'S OWN RECEIPT PROVES IT NEVER SHIPPED.
  //
  // THE DEAD END, MEASURED (r4 SF05, twice; r3 SF05's control arm once, for 6
  // turns). Default reads elide comment blocks. An edit anchored on an elided
  // line is refused `elided-content`, and that refusal's own `next` is
  // `tl_read_file … comments:"keep"`. Executing it VERBATIM returned a
  // `read.receipt` (`wasFullyServed`, whose key is `(workspace, path, sha)` —
  // no projection axis) or a `read.map` skeleton (the per-task-cap branch), and
  // never the comment-preserving bytes. The refusal's own receipt proved the
  // gap: `covered_by` listed nine served ranges with nine holes at exactly the
  // elided comment blocks. The server prescribed a call it then declined to
  // answer — 2 of every 4 turns in each recovery loop.
  //
  // THE MINIMAL CONTRACT (ruling F3). `keepComments === true` bypasses BOTH
  // gates and falls through to the W1 head serve, which renders `content`
  // verbatim (no elision on that path) — so the prescribed recovery returns
  // bytes. Ruling (s): what SHIPS books, so the head's own span is recorded
  // against the range ledger below.
  //
  // DEFAULT PATH UNAFFECTED. `keepComments` is false for every request that
  // does not ask for the projection, and the default path emits
  // `comments:"keep"` only as this exact refusal recovery.
  // -------------------------------------------------------------------------

  // W1 exception (content-EQUIVALENT, not a breadcrumb): a governed REPEAT read
  // of the SAME path whose sha is unchanged since the earlier FULL serve. A
  // governor downgrade never records an expansion (only an "allow" does), so
  // wasFullyServed is true only for a genuine prior full serve of this exact
  // sha — the caller already holds these bytes. Return a compact pointer, not a
  // re-serve of what it has, and never a zero-content skeleton.
  if (wasFullyServed(workspace, filePath, sha, keepComments)) {
    recordReadPath(workspace, filePath);
    // V10-02: repeated_range — a wasFullyServed ledger hit answered as a
    // code-unchanged receipt instead of a re-serve. This function is the
    // single builder all three governed-downgrade call sites already share.
    trace("repeated_range", { mode: "full", path: filePath, reason, complete: true }, workspace);
    const totalLines = countLines(content);
    const coverage = servedRangeCoverage(workspace, filePath, sha, totalLines);
    const servedBy = coverage?.served[0] === undefined
      ? undefined
      : servedRangeReceipt(
          workspace,
          filePath,
          sha,
          coverage.served[0][0],
          coverage.served[0][1],
          totalLines,
        )?.served_by;
    // W-WIRE-2A: `wasFullyServed` already proved this whole file resident at
    // this sha — coverageReceiptFor's `want:"full"` verdict is asked here only
    // to source `covered_by` for the receipt below, never to re-decide whether
    // one fires. `kind:"none"` under a flag-off/force-serve/lane-mismatch/no-op
    // makes `coveredByField` return undefined, so this is a no-op addition
    // whenever the verdict does not independently confirm full coverage.
    const coveredBy = coveredByField(coverageReceiptFor({
      workspace,
      path: filePath,
      sha,
      totalLines,
      want: "full",
      forceServe: false,
    }));
    return {
      mode: "full",
      downgraded_from: "full",
      reason,
      path: filePath,
      handle: handleId,
      sha: shortSha(sha), // C10.1: short display sha; handleId was minted on the full sha.
      bytes,
      // A.4 (C2-3): the `receipt` tag discriminates this repeat-read pointer as
      // a `code-unchanged` receipt. Harmless inside a `mode=full` BATCH item —
      // `readFamily.ts`'s `file-downgraded` arm does not carry it — and it is
      // the discriminator when this payload IS the whole response.
      receipt: "code-unchanged",
      code_unchanged: true,
      ...(coveredBy !== undefined ? { covered_by: coveredBy } : {}),
      // W1: state WHAT the caller already holds and how to force the bytes
      // back — the same receipt payload the served-range receipts carry, so no
      // read path answers with a bare pointer.
      //
      // F1 wave 2 (2026-08-02 serve-honesty): this used to hardcode
      // `served:[1-N], complete:true` because wasFullyServed proves a COMPLETE
      // prior serve. That conflated two different ledgers. wasFullyServed
      // answers "did a whole-file serve happen for this (path,sha)?" — still
      // true, still the right gate for THIS receipt (a repeat mode=full would
      // return the identical elided body the caller already has). But a
      // whole-file serve does not put a file's elided comment blocks on the
      // wire, so the COVERAGE summary must come from the range ledger, which
      // now books only what shipped. Fall back to the old shape only when the
      // range ledger has nothing for this sha (e.g. TL_SERVED_RANGE_LEDGER=0).
      ...(servedBy !== undefined ? { served_by: servedBy } : {}),
      summary: coverage === undefined
        ? { served: [`1-${totalLines}`], complete: true }
        : {
            served: coverage.served.map(([start, end]) => `${start}-${end}`),
            ...(coverage.unserved.length > 0 ? { unserved: coverage.unserved } : {}),
            complete: coverage.complete,
          },
      note: SERVED_CONTENT_RECEIPT_NOTE,
      // FX-1: canonical `targets=[...]` prose (see the sibling receipt above).
      ...(coverage !== undefined && coverage.unserved.length > 0
        ? { next: canonicalToolCall("tl_read_file", { targets: [{ handle: handleId, ranges: coverage.unserved }], content: "auto" }) }
        : {}),
      ...(allowFullWouldHelp ? { allow_full_would_help: true } : {}),
    };
  }

  // B2c (2026-08-01 serving-completeness): the PER-TASK cap converts, the other
  // governor reasons do not.
  //
  // Live evidence (2026-07-31-semantic-signal5-2, T13): the per-task cap fired
  // at full-read #8/#10 and the W1 head-serve above answered every one of them.
  // Serving 12KB of head bytes read as ACCEPTANCE — the solver kept issuing
  // mode=full and never once zoomed, so the cap bounded bytes-per-response
  // while doing nothing at all about the read shape it exists to correct.
  // A per-task cap means "this task has already spent its whole-file budget on
  // OTHER files"; the honest answer is the file's structure plus the exact
  // slice call that gets the part actually wanted, not another head.
  //
  // Non-tiny candidate-pack repeats deliberately keep the W1 content path:
  // T05c recovery depended on that path still serving content. Tiny files are
  // the exception because their governed head would resend the whole body.
  const tinyShapeDowngrade = bytes <= TINY_BYTES && countLines(content) <= TINY_LINES;
  if (!keepComments && (args.skeletonOnly === true || reason === "per-task-cap-reached" || reason === "tiny-skeleton-cap-reached" || tinyShapeDowngrade)) {
    const totalLines = countLines(content);
    // F1 wave 2 note: with honest recording, `unserved` can now include a gap
    // that is purely an elided comment block. Naming it is not wrong — those
    // lines genuinely never shipped, and comments:"keep" is the way to get
    // them — but a zoom target picked here may point at documentation rather
    // than code. Left as-is deliberately: filtering would need comment
    // awareness that does not belong in the downgrade payload, and this branch
    // is only reachable when the file was NOT fully served.
    const coverage = servedRangeCoverage(workspace, filePath, sha, totalLines);
    const remainingRanges = coverage !== undefined && coverage.unserved.length > 0
      ? coverage.unserved
      : coverage !== undefined && coverage.complete
        ? []
        : [`1-${totalLines}`];
    const widthOf = (range: string): number => {
      const parsed = range.match(/^(\d+)-(\d+)$/);
      if (parsed === null) return 0;
      return parseInt(parsed[2]!, 10) - parseInt(parsed[1]!, 10) + 1;
    };
    // 2026-10-19 (DESIGN-v0.14-plan.md §20.26, R1's open item from §20.19):
    // the pre-filled zoom named only the largest unserved span, so a file with
    // four gaps (6t-3 T13 rep1 #2: 1-77, 115-322, 394-440, 478-503) cost one
    // call per gap. It names every unserved span that fits one governed serve,
    // largest first and always the largest, up to the ranges-per-call cap, in
    // file order; the rest stays in remaining_ranges.
    const sourceLines = content.split(/\r?\n/);
    const bytesOf = (range: string): number => {
      const parsed = range.match(/^(\d+)-(\d+)$/);
      if (parsed === null) return 0;
      return Buffer.byteLength(sourceLines.slice(parseInt(parsed[1]!, 10) - 1, parseInt(parsed[2]!, 10)).join("\n"), "utf8");
    };
    const zoomRanges: string[] = [];
    let zoomBytes = 0;
    for (const range of [...remainingRanges].sort((a, b) => widthOf(b) - widthOf(a))) {
      if (zoomRanges.length >= MAX_SLICE_RANGES) break;
      const rangeBytes = bytesOf(range);
      if (zoomRanges.length > 0 && zoomBytes + rangeBytes > GOVERNED_FULL_SERVE_BYTES) continue;
      zoomRanges.push(range);
      zoomBytes += rangeBytes;
    }
    zoomRanges.sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
    // The outline IS the payload here: signatures + exact line ranges, so the
    // zoom below is a targeted pick rather than a blind re-request.
    const symbols = await extractSymbolsFromFile(content, filePath, 48);
    recordReadPath(workspace, filePath);
    return {
      mode: "skeleton",
      downgraded_from: "full",
      reason,
      path: filePath,
      handle: handleId,
      sha: shortSha(sha),
      bytes,
      total_lines: totalLines,
      skeleton: symbols,
      ...(remainingRanges.length > 0 ? { remaining_ranges: remainingRanges } : {}),
      ...(allowFullWouldHelp ? { allow_full_would_help: true } : {}),
      // PRE-FILLED zoom: same handle, the largest span this session has not
      // served yet. A cap that names the next call is a redirect; one that only
      // says "no" is the pure-loss turn W1 removed.
      // FX-1: canonical `targets=[...]` prose (see the sibling receipts above).
      ...(zoomRanges.length > 0
        ? { next: canonicalToolCall("tl_read_file", { targets: [{ handle: handleId, ranges: zoomRanges }], content: "auto" }) }
        : {}),
      note: args.skeletonOnly === true
        ? "post-ready discovery trimmed; zoom this handle by range (the pre-filled `next` names the unserved spans that fit one serve, largest first)"
        : "per-task whole-file budget spent on other files; zoom this handle by range"
          + " (the pre-filled `next` names the unserved spans that fit one serve, largest first)",
    };
  }

  // W1 default: SERVE the file head (never a zero-content skeleton + breadcrumb).
  // The cap bounds bytes-per-response, so the caller gets real content THIS turn
  // and — only when the head is genuinely partial — a remainder `next` whose
  // range is byte-exact against the original file (serveGovernedFullHead keeps
  // line boundaries intact, no elision/whitespace collapse). A subsequent
  // mode=slice on that range clamps and chains its own remainder, so the whole
  // body is reachable without a single contentless turn. `next` stays
  // slice-shaped even when allowFull would serve the full body — re-reading full
  // would resend the head we just served; allow_full_would_help signals the
  // option without routing the caller back through a redundant full read.
  //
  // eval-0929 §3/§8 row 5 (WP-J): this `next` is built from the GOVERNED head's
  // own cap (GOVERNED_FULL_SERVE_BYTES=12288), before the generic wire-shed
  // ladder (protocol/budget/shedders/readText.ts's rung 4) gets a chance to
  // truncate `content` FURTHER to fit the caller's own smaller declared budget.
  // When it does, the ladder's own narrower continuation is correct but
  // `wireLimit.ts`'s `mergeWireLimit` clause 4 keeps THIS pre-built, now-stale
  // `next` instead (an emitter `next` is normally the more authoritative one —
  // true for e.g. a paging cursor, false here), permanently skipping every line
  // between the ladder's cut and this cap's own cut. `buildFullServePayload`
  // (this function's sibling) never has that problem because it stages this
  // same request via `stageFullReadRequest` — the ONE call below — so
  // `emit.ts`'s tail (`applyReadRequestContinuation`) settles D against
  // whatever ACTUALLY shipped and mints one reconciled cursor, overriding
  // whichever `next` the ladder or this cap produced. Reusing that mechanism
  // here (rather than teaching `mergeWireLimit`/`readText.ts` a second special
  // case) is what closes the gap; `applyReadRequestContinuation`'s own "which
  // responses this owns" gate keeps the ordinary calibrated-budget/no-shed
  // downgrade byte-identical to before this fix.
  stageFullReadRequest(workspace, filePath, content, sha, keepComments);
  const { head, servedLines, totalLines } = serveGovernedFullHead(content, GOVERNED_FULL_SERVE_BYTES);
  const truncated = servedLines < totalLines;
  recordReadPath(workspace, filePath);
  // FX-OH F3 / ruling (s): these bytes SHIP, so they book. Only on the
  // comments-keep path — that is the branch this wave newly reaches, and the
  // span it books is honest by construction (no elision was applied to
  // `head`, so every line in `1..servedLines` really did reach the caller).
  // Booking it is what stops the very next `comments:"keep"` call from being
  // answered by the receipt gate this fix just bypassed.
  if (keepComments && servedLines > 0) {
    recordServedRange(
      workspace, filePath, sha, 1, servedLines, totalLines,
      { mode: "full-comments-keep", range: `1-${totalLines}`, call: beginServeCall(workspace) },
    );
  } else if (servedLines > 0) {
    // R2-R1 (P1-5, review 2026-09-30): the DEFAULT head ships the same verbatim
    // bytes and used to book NOTHING. Every later page of the chain booked its
    // own span, so after a completed whole-file chain the ledger held lines
    // 151-2000 of a 2000-line file but NOT the head it had delivered first; the
    // identical request then missed the receipt gate (the file was not "fully
    // held"), re-served the head, and — the request's D being empty — shipped it
    // with no `limit`/`next`: a partial page presented as complete. Booked
    // PROVISIONALLY like every other serve, so the funnel keeps exactly the
    // lines the (possibly ladder-cut) response carried and retracts the rest.
    recordServedRange(
      workspace, filePath, sha, 1, servedLines, totalLines,
      { mode: "full-head", range: `1-${servedLines}`, call: beginServeCall(workspace) },
    );
  }
  return {
    mode: "full",
    downgraded_from: "full",
    reason,
    path: filePath,
    handle: handleId,
    sha: shortSha(sha),
    bytes,
    content: head,
    truncated,
    ...(allowFullWouldHelp ? { allow_full_would_help: true } : {}),
    ...(truncated
      ? { next: canonicalToolCall("tl_read_file", { handle: handleId, range: `${servedLines + 1}-${totalLines}` }) }
      : {}),
  };
}

/**
 * FIX C (2026-07-12c forensics): mode=symbol's cap-exceeded refusal used
 * to fire for a symbol body even trivially over READ_SYMBOL_CAP_BYTES (live:
 * a single method body was 8378B against an 8192B cap,
 * 2.3% over) — the caller got zero content and had to immediately re-fetch
 * via mode=slice, the exact pure-loss-turn class buildFullDowngradePayload
 * above already closed for mode=full. Mirrors that precedent for mode=symbol:
 * serve a head-of-body TRIMMED to fit, `downgraded_from:"symbol"`, and a
 * `next` pointing at `mode=slice` over the symbol's full line RANGE — not
 * `symbol=` — since resolveSlice's RANGE branch (readCodeModes.ts) already
 * truncates-and-continues on its own cap instead of refusing, so the
 * caller's remainder fetch always succeeds without hitting the sibling
 * refusal in resolveSlice's OWN symbol branch.
 *
 * Bake-into-cap (the findText.ts / resolveMap / resolveDigest convention —
 * see e.g. tools/findText.ts's "baked into every trial's byte count, not
 * spliced on after" comments, and resolveMap/resolveDigest's serialize-
 * measure-trim loops above in readCodeModes.ts): every field in the final
 * payload — handle/sha/path/symbol/range/downgraded_from/reason/bytes/
 * maxBytes/next, not just `code` — is measured as part of the SAME
 * serialized trial the code budget is computed against, and re-trimmed if
 * JSON-escaping ever pushes the total back over maxBytes. Nothing is ever
 * spliced on after a content-only truncation.
 *
 * Returns undefined only for the pathological case where the non-code
 * envelope fields alone already meet/exceed maxBytes — the caller keeps its
 * existing hard refusal for that case.
 */
export function buildSymbolDowngradePayload(args: {
  filePath: string;
  symbolName: string;
  language: string;
  range: { start: number; end: number };
  /** Raw full-file content; used to map the served head to exact source lines. */
  sourceContent: string;
  keepComments: boolean;
  handleId: string;
  /** Short display sha (already shortSha'd by the caller — C10.1 convention). */
  sha: string;
  /** The ORIGINAL (pre-trim) byte count — same number the legacy refusal reported. */
  bytes: number;
  maxBytes: number;
}): Record<string, unknown> | undefined {
  const { filePath, symbolName, language, range, sourceContent, keepComments, handleId, sha, bytes, maxBytes } = args;
  const sourceLines = sourceContent.split(/\r?\n/);
  const bodyEnd = Math.min(range.end, sourceLines.length);
  const bodyLines = sourceLines.slice(range.start - 1, bodyEnd);
  if (bodyLines.length === 0) return undefined;

  // With the experiment enabled, spend the deterministic must-fetch tier on
  // this same response. Otherwise this is exactly the legacy 8K wire cap.
  const wireCap = mustFetchReadBudget(maxBytes);
  const envelope = (bodyCode: string, servedEnd: number): Record<string, unknown> => {
    const wasTrimmed = servedEnd < bodyEnd;
    const next = wasTrimmed
      ? canonicalToolCall("tl_read_file", { handle: handleId, range: `${servedEnd + 1}-${bodyEnd}` })
      : undefined;
    return {
      code: bodyCode,
      language,
      range,
      served_range: `${range.start}-${servedEnd}`,
      handle: handleId,
      sha,
      path: filePath,
      symbol: symbolName,
      downgraded_from: "symbol",
      reason: "symbol-cap-reached",
      truncated: wasTrimmed,
      bytes,
      maxBytes: wireCap,
      ...(next !== undefined ? { next } : {}),
    };
  };

  // Select the largest whole-source-line prefix whose COMPLETE serialized
  // envelope fits. Mapping the head to raw lines makes the continuation start
  // strictly after what was served; the former assembled-view continuation
  // restarted at range.start and duplicated the entire head.
  let low = 1;
  let high = bodyLines.length;
  let best: Record<string, unknown> | undefined;
  while (low <= high) {
    const count = Math.floor((low + high) / 2);
    const rawBody = bodyLines.slice(0, count).join("\n");
    const bodyCode = keepComments
      ? rawBody
      : elideDocComments(rawBody, language, range.start);
    const candidate = envelope(bodyCode, range.start + count - 1);
    if (bodyCode.trim() !== "" && Buffer.byteLength(JSON.stringify(candidate), "utf8") <= wireCap) {
      best = candidate;
      low = count + 1;
    } else {
      high = count - 1;
    }
  }

  return best;
}

/**
 * DESIGN-v0.9 §4.6a: compute the ONE inline continuation window for a
 * cap-truncated RANGE slice. `servedHead` is the raw content resolveSlice
 * actually served (its line count fixes where the head ended); the window is
 * the next whole-line span from there, bounded so head+window fits the §4.8
 * must-fetch budget for reads (16384 with the flag on; 8192 — i.e. no room —
 * with it off). Returns the window (comment-elided per keepComments) plus the
 * `next` string ADVANCED past it (undefined once the window reaches the
 * requested end). Returns undefined when nothing is left, the budget leaves no
 * room, or the window trims to empty — never fabricates a window past EOF.
 */
export function computeSliceContinuation(
  fileContent: string,
  servedRange: string,
  servedHead: string,
  handle: string,
  keepComments: boolean,
  language: string | undefined,
): { continued: { range: string; content: string; elided: Array<[number, number]> }; next?: ToolCall } | undefined {
  const m = servedRange.match(/^(\d+)-(\d+)$/);
  if (!m) return undefined;
  const startLine = parseInt(m[1]!, 10);
  const endLine = parseInt(m[2]!, 10);
  if (!Number.isFinite(startLine) || !Number.isFinite(endLine) || startLine < 1 || endLine < startLine) return undefined;

  const servedLines = servedHead === "" ? 0 : servedHead.split("\n").length;
  const contStart = startLine + servedLines; // first line AFTER the served head
  if (contStart > endLine) return undefined; // head already reached the requested end

  const budget = mustFetchReadBudget(READ_SYMBOL_CAP_BYTES);
  // §4.8: with the flag OFF the budget is unchanged, and the head already owns
  // the whole base cap — reserving the head's own cap for the head means there
  // is no room for a continuation, so §4.6a is a no-op (the `next` continuation
  // still points the agent at the remainder). Only the flag-on EXPANSION funds
  // an inline window; the head may have trimmed a little short of the base cap,
  // so the window gets that slack PLUS the expansion.
  if (budget <= READ_SYMBOL_CAP_BYTES) return undefined;
  const remaining = budget - Buffer.byteLength(servedHead, "utf8");
  if (remaining <= 0) return undefined;

  const lines = fileContent.split(/\r?\n/);
  // FIX-ORIG (2026-09-27, eval-0927 P1 §6.1 chip, orchestrator-directed):
  // was `Math.min(endLine, lines.length)` -- `lines.length` counts a phantom
  // trailing empty element for content ending in "\n" (nearly every file),
  // same class fixed at every task-pack producer this wave. Wire-visible
  // here too: when this continuation reaches real EOF and the resulting
  // (inflated-by-one) `windowText` fits under `remaining` without the
  // byte-truncation branch below firing, `windowLineCount`/`contEnd` a few
  // lines down inherit the same +1, landing directly in `sliceOut.continued`.
  const clampedEnd = Math.min(endLine, countLines(fileContent));
  if (contStart > clampedEnd) return undefined;

  let windowText = lines.slice(contStart - 1, clampedEnd).join("\n");
  if (Buffer.byteLength(windowText, "utf8") > remaining) {
    windowText = Buffer.from(windowText, "utf8").slice(0, remaining).toString("utf8");
    const lastNl = windowText.lastIndexOf("\n");
    if (lastNl > 0) windowText = windowText.slice(0, lastNl);
  }
  if (windowText === "" || windowText.trim() === "") return undefined;

  const windowLineCount = windowText.split("\n").length;
  const contEnd = contStart + windowLineCount - 1;
  // FX-W3 (ruling (aa)): carry the renderer's own elision accounting
  // alongside the display text, so the booking loop below never has to
  // re-parse `displayed` for marker-shaped lines.
  const { text: displayed, elided } = keepComments
    ? { text: windowText, elided: [] as Array<[number, number]> }
    : elideDocCommentsWithWindows(windowText, language, contStart);
  const continued = { range: `${contStart}-${contEnd}`, content: displayed, elided };
  const next = contEnd < endLine
    ? canonicalToolCall("tl_read_file", { handle, range: `${contEnd + 1}-${endLine}` })
    : undefined;
  return { continued, ...(next !== undefined ? { next } : {}) };
}

/**
 * Result of resolving mode=full for ONE path — extracted from the inline
 * single-path mode=full handler so both the original single-path call site
 * and the new paths[] batch (below) share IDENTICAL governor/office/cap
 * behavior instead of two copies drifting apart. `ok:true.data` is exactly
 * the object the single-path caller used to pass to toolOk(...); `ok:false`
 * carries exactly the string the single-path caller used to pass to
 * toolError(...) — so `resolveFullReadForPathSingle` below reproduces the
 * pre-extraction behavior byte-for-byte, and the batch caller can fold a
 * per-path failure into an `omitted` entry instead of aborting the batch.
 */
export type FullReadResolution = { ok: true; data: Record<string, unknown> } | { ok: false; error: string; code?: RefusalCode };

/**
 * B2e (2026-08-01 serving-completeness): per-response ceiling for ONE mode=full
 * serve, matching the slice batch's own response cap.
 *
 * Live defect (2026-07-31-semantic-signal5-2, T05c): a mode=full of a 50.5KB
 * source file produced a single ~52KB JSON tool result that the CLIENT harness
 * clamped — the model never received the body — while TL recorded the file as
 * FULLY served. Every later slice of that file then answered with a
 * `code_unchanged` receipt for bytes the model had never seen, and it took two
 * allowFull retries to recover. Bounding a single serve keeps the response
 * inside what clients actually deliver; `remaining_ranges` + a same-handle
 * continuation `next` make the rest reachable without a contentless turn.
 *
 * allowFull:true remains the documented uncapped escape hatch (it already
 * raises the byte ceiling to READ_FULL_CAP_BYTES_ALLOW_FULL) — but even then
 * only what was actually sent is recorded.
 */
export const FULL_SERVE_CHUNK_BYTES = 24576;

/**
 * B2e: build the mode=full success payload, chunked to FULL_SERVE_CHUNK_BYTES
 * unless `allowFull` was explicitly requested.
 *
 * BCF: when the CALLER declared an explicit budget smaller than
 * FULL_SERVE_CHUNK_BYTES (`callerBudgetBytes`, threaded from `budget.bytes`/
 * `budget.tokens` — never from a calibrated default ceiling), the chunk
 * target narrows to that budget (minus envelope reserve) instead of always
 * reaching for the fixed 24576 B chunk and relying on the emit-time shed
 * ladder's halving to cut it back down. `serveGovernedFullHead` is already a
 * byte-precise greedy line fill (unlike the halving ladder rung), so sizing
 * ITS target at the caller's real budget is what actually fills the budget:
 * the ladder still runs as a backstop, but now rarely needs to. `undefined`
 * (no explicit budget) reproduces today's FULL_SERVE_CHUNK_BYTES chunk
 * target exactly — `emit.ts`'s "REFACTOR AT DEFAULT BUDGETS" invariant and
 * the §6.1(b) replay-corpus pins (svc1/svc2/tsl1) stay byte-identical.
 *
 * Elision is applied to the WHOLE file first: a comment-heavy file that fits
 * the chunk cap after elision is still served complete (today's behavior). Only
 * when even the elided body overflows does the serve chunk, and then the chunk
 * is cut on RAW file line boundaries (serveGovernedFullHead) so
 * `remaining_ranges`/`next` line up byte-exactly with a follow-up mode=slice.
 */
export function buildFullServePayload(args: {
  workspace: string;
  filePath: string;
  content: string;
  handleId: string;
  sha: string;
  keepComments: boolean;
  allowFull: boolean;
  callerBudgetBytes?: number;
  extra?: Record<string, unknown>;
}): Record<string, unknown> {
  const { workspace, filePath, content, handleId, sha, keepComments, allowFull, callerBudgetBytes, extra } = args;
  const language = languageForPath(filePath);
  // 2026-07-16a bench forensics: fall back to raw content + a note instead of
  // serving an elided-empty doc-only file — see elideDocCommentsForDisplay.
  const whole = elideDocCommentsForDisplay(content, language, keepComments);
  // DESIGN-v0.15 §5.1 (R2): a `content:"full"` request's Q is the WHOLE FILE,
  // in file coordinates, and it stays the request's scope even when the wire
  // budget later cuts the body down to a handful of lines. Staged here — the
  // one place that knows the file, its revision and its real line count —
  // rather than at the dispatcher, which knows none of the three.
  // TL-REVIEW-2 (2026-10-06): "§5.1: Q includes the representation" — under
  // `comments:"elide"` the comment blocks this serve elides (`whole.elided`,
  // the renderer's own windows) are disclosed, never owed, so they are not
  // part of Q. Otherwise a fully delivered read kept them in D, and a budgeted
  // one paged them back raw through cursors cut mid-block.
  stageFullReadRequest(workspace, filePath, content, sha, keepComments, whole.elided);
  // R2-R1 (P0-2 + FX1 chip 1): a caller-declared budget narrower than the
  // fixed chunk sizes this serve from the MEASURED response (whole first, then
  // the largest head of whole lines with the continuation counted once, no
  // note) — see `planBudgetedFullServe`. `undefined` (no explicit budget, a
  // budget at/above FULL_SERVE_CHUNK_BYTES, allowFull, or a wire this cannot
  // predict) is exactly v0.14.4: the fixed chunk below, the ladder measuring
  // the real bytes. Never raises the chunk past the client-clamp-safety
  // ceiling (this function's own header comment on why that ceiling exists).
  const budgetPlan = planBudgetedFullServe({
    callerBudgetBytes,
    allowFull,
    filePath,
    workspace,
    content,
    keepComments,
    whole,
    fixedChunkBytes: FULL_SERVE_CHUNK_BYTES,
  });
  const chunkCapBytes = FULL_SERVE_CHUNK_BYTES;
  const wholeFits = allowFull
    || (budgetPlan !== undefined
      ? budgetPlan.kind === "whole"
      : Buffer.byteLength(whole.content, "utf8") <= chunkCapBytes);

  recordReadPath(workspace, filePath);

  if (wholeFits) {
    recordFullServeCompleteness(workspace, filePath, sha, true, keepComments);
    return {
      mode: "full",
      handle: handleId,
      path: filePath,
      content: compressFormat(whole.content),
      truncated: false,
      sha: shortSha(sha),
      fullFileExpansion: true as const,
      language: filePath.split(".").pop() ?? "unknown",
      ...(whole.note ? { note: whole.note } : {}),
      // DESIGN-v0.15 §5.1 (R2): a GENUINELY EMPTY (0-byte) file. `content` is
      // already `""` (below), and `readFamily.ts`'s `str()` collapses an
      // empty string to absent everywhere on the wire (the shared rule that
      // keeps "" out of `path`/`range` as a false address) — which otherwise
      // makes `textEvidence`/`batchEntry` see NEITHER a body NOR a derivable
      // range and drop this window entirely, projecting `evidence: []` (a
      // `read.text`/`read.batch` item with nothing to address, violating its
      // own required set). `total_lines: 0` is the producer's OWN verified
      // fact — this branch only reaches it after actually reading and eliding
      // the file — so the projector can tell "empty file, correctly served"
      // from "no content available" without guessing from an absent key.
      // Additive only for this one case: every non-empty `content:"full"`
      // serve is unaffected, so the byte-identical-at-default-budgets
      // invariant holds for every OTHER file.
      ...(content === "" ? { total_lines: 0 } : {}),
      ...(extra ?? {}),
    };
  }

  const { head, servedLines, totalLines } = budgetPlan?.kind === "head"
    ? governedHeadByLines(content, budgetPlan.lines)
    : serveGovernedFullHead(content, chunkCapBytes);
  const remainingRange = `${servedLines + 1}-${totalLines}`;
  // Record ONLY what actually went on the wire. A chunked serve must never let
  // wasFullyServed / the served-range ledger claim the whole file.
  recordFullServeCompleteness(workspace, filePath, sha, false, keepComments);

  // WP-L item 1 guard (2026-09-29): `servedLines < 1` means NO whole line
  // survived this cap — `range:"1-${servedLines}"` would be the inverted
  // "1-0", and `head` is `serveGovernedFullHead`'s byte-bounded,
  // code-point-aligned PREFIX of a line that never fit, not a verbatim served
  // line. Never ship either as evidence: a served body must always be whole
  // lines matching its own range. The honest encoding for "nothing shipped,
  // here is the address and what remains" is the BODYLESS form
  // `protocol/readFamily.ts`'s `textEvidence` (its "GATE-A" branch) already
  // recognizes — omit `content`/`range` entirely and let `total_lines` +
  // `remaining_ranges` + `next` carry the fact, same as a governed downgrade
  // that shipped neither bytes nor an outline. The measured budget plan
  // (`planBudgetedFullServe`) never asks for fewer than ONE whole line, so a
  // budget-cut head cannot reach this branch; it is the last-resort net for the
  // fixed-chunk path (a single logical line genuinely larger than
  // `FULL_SERVE_CHUNK_BYTES`) and for any future caller that narrows some
  // other way.
  if (servedLines < 1) {
    const note =
      `served the first 0 of ${totalLines} lines (single-serve cap ${chunkCapBytes}B);`
      + " the unserved lines and a same-handle next follow — pass budget.allowFull:true to force one uncapped serve";
    return {
      mode: "full",
      handle: handleId,
      path: filePath,
      truncated: true,
      total_lines: totalLines,
      remaining_ranges: [remainingRange],
      sha: shortSha(sha),
      language: filePath.split(".").pop() ?? "unknown",
      next: canonicalToolCall("tl_read_file", { handle: handleId, range: remainingRange }),
      note,
      ...(extra ?? {}),
    };
  }

  // TL-REVIEW-2: the head is a WINDOW of the file (line 1 onward), so an
  // all-comment head is a comment-only window, never a "doc-only file".
  const chunk = elideDocCommentsForDisplay(head, language, keepComments, 1, "window");
  // TL-REVIEW-2 (2026-10-06): the whole-file comment windows past the head are
  // excluded from this request's Q (`stageFullReadRequest` above), so no
  // cursor page will ever serve — or mention — them. Disclose them here, with
  // the head (whose own windows the source-fidelity projection discloses);
  // a block the cut lands inside is disclosed from the first line past it.
  const elidedPastHead = whole.elided
    .filter(([, windowEnd]) => windowEnd > servedLines)
    .map(([windowStart, windowEnd]) => `${Math.max(windowStart, servedLines + 1)}-${windowEnd}`);
  // F1 (2026-08-02 serve-honesty): "what went on the wire" also excludes any
  // comment block the head's OWN display collapsed to a `doc elided` marker.
  // Book the surviving spans of `chunk.content`, not the flat 1..servedLines
  // the head was cut at. FX-W3 (ruling (aa)): the surviving spans come from
  // the renderer's own `chunk.elided` accounting, not from re-parsing
  // `chunk.content` for marker-shaped lines.
  const headCall = beginServeCall(workspace);
  for (const [spanStart, spanEnd] of spansExcludingWindows(1, servedLines, chunk.elided)) {
    recordServedRange(workspace, filePath, sha, spanStart, spanEnd, totalLines, {
      mode: "full-head",
      range: `1-${servedLines}`,
      call: headCall,
    });
  }
  // R2-R1: a head cut to the CALLER'S budget carries no "single-serve cap" note —
  // no serve cap bound it (the note would name the fixed chunk), `limit` +
  // `remaining` + `next` already say what was cut, and the emit ladder sheds
  // that prose before it cuts a line anyway (measured: ~170 B a 6144 B budget
  // could not spare). The note stays for the FIXED chunk, where it is true and
  // names the `allowFull` escape hatch.
  const composedNote = budgetPlan?.kind === "head"
    ? undefined
    : [
      chunk.note,
      `served the first ${servedLines} of ${totalLines} lines (single-serve cap ${chunkCapBytes}B);`
      + " the unserved lines and a same-handle next follow — pass budget.allowFull:true to force one uncapped serve",
    ].filter(Boolean).join("; ");
  return {
    mode: "full",
    handle: handleId,
    path: filePath,
    content: compressFormat(chunk.content),
    truncated: true,
    range: `1-${servedLines}`,
    total_lines: totalLines,
    remaining_ranges: [remainingRange],
    sha: shortSha(sha),
    language: filePath.split(".").pop() ?? "unknown",
    next: canonicalToolCall("tl_read_file", { handle: handleId, range: remainingRange }),
    ...(composedNote !== undefined ? { note: composedNote } : {}),
    ...(elidedPastHead.length > 0 ? { elided_windows: elidedPastHead } : {}),
    ...(extra ?? {}),
  };
}

/**
 * FX-N (ruling (s), 2026-09-03): book the served-range ledger for a COMPLETE
 * whole-file `mode=full` serve (`fullFileExpansion:true`).
 *
 * `buildFullServePayload` books its own GOVERNED-HEAD branch inline (a chunked
 * serve must never claim the whole file), but the untruncated branch does not:
 * historically its single caller — the single-path `mode=full` handler — did
 * the booking itself, from the outer scope's already-loaded `content`. The
 * `paths[]` BATCH caller, added later and routed through the same helper, never
 * did, which is round-16 finding 2: a `tl_read_file
 * {targets:[{path:a},{path:b}], content:"full"}` put both bodies on the wire in
 * full and left the served-range ledger, the admissible union and the byte
 * residency untouched. Measured consequences, all live: `tl_edit_file` on a file
 * the server had JUST shipped refused `execution-typestate` (the T09/T10
 * regression class); an identical re-read re-shipped every byte with no
 * receipt; and `tl_search_files find` reported `lines_held:false` for lines it had
 * delivered. AGENTS.md steers callers into exactly this shape ("known small
 * whole files => ONE `targets:[{path:…},…]` batch at `content:\"full\"`"), so
 * the un-booked branch was on the recommended path.
 *
 * Extracted rather than moved INTO `buildFullServePayload` deliberately: the
 * `mode=full` handler calls `resolveFullReadForPath` a second time to PROBE for
 * a ledger-difference projection (`buildLedgerDifferenceFullPayload`) whose
 * body it may then discard, and booking inside the builder would book that
 * probe's bytes twice — once for a payload that never ships.
 *
 * Same triad as every other honest serve site: one `beginServeCall` ordinal for
 * the whole file, and only the spans that SURVIVE comment elision
 * (`spansExcludingWindows` over the renderer's own `elided` accounting, ruling
 * (aa)), never a flat 1..N.
 */
export function bookFullFileExpansionServe(
  workspace: string,
  filePath: string,
  content: string,
  keepComments: boolean,
): void {
  const servedTotal = countLines(content);
  const display = elideDocCommentsForDisplay(content, languageForPath(filePath), keepComments);
  const serveCall = beginServeCall(workspace);
  // FX-W3 (ruling (aa), 2026-09-04): the surviving spans come from the
  // RENDERER's own accounting (`display.elided`, computed by
  // `elideDocCommentsWithWindows` at the exact moment it collapses a genuine
  // multi-line block) via pure arithmetic — never by re-parsing
  // `display.content` for marker-shaped lines, which a caller's own file
  // content could forge (round-21A finding 1).
  for (const [spanStart, spanEnd] of spansExcludingWindows(1, servedTotal, display.elided)) {
    recordServedRange(
      workspace, filePath, shaOfText(content), spanStart, spanEnd, servedTotal,
      { mode: "full", range: `1-${servedTotal}`, call: serveCall },
    );
  }
}

/**
 * 2026-10-20 (decision run 6t-7): what a code-unchanged receipt for the one
 * window [start, end] of a mode=slice read would withhold, decided before the
 * read books anything. A receipt can stand for comment lines the caller holds
 * no byte of in two ways: a task pack books its surface's comment blocks with
 * the window and only discloses them as `elided` (W14 L1), and a
 * default-policy read whose code is held is owed nothing its own rendering
 * elides (TL-REVIEW-2). `servedRangeUnheldLines` names those lines.
 *
 *  - `withhold`: the request keeps comments, so it is owed them; no receipt.
 *    T03 rep0 #6 asked for 45-82 of OrderOrchestrator.java with
 *    select.comments:"keep" and got one for the Javadoc its pack had only
 *    disclosed, then re-sent the call with force_serve.
 *  - `serve`: a default-policy read whose every other line is held, and whose
 *    own rendering elides the unheld lines — serve them, comments kept, with
 *    the held lines as `prior`. T10 rep0 #16 and rep1 #18 re-read
 *    occupation.py after a failing smoke test, got a bare receipt, and
 *    force_served its docstrings in one more call (rep0) or two (rep1).
 *    Chosen over a receipt whose `next` reads the blocks: replayed, the
 *    re-read takes one call (2,099 B) instead of two (about 1.85 KB), and in
 *    the seven decision runs of 2026-10-18 to -20, 13 of the 19 receipts that
 *    withheld such lines were followed by a read of them.
 *  - `next`: a default-policy read that would SHOW some of those lines (a
 *    window inside a comment block a pack disclosed). Its receipt stands, as
 *    servedReceiptElisionHonesty.spec.ts's task_pack rule has it, and its
 *    `next` reads exactly the unheld lines with select.comments:"keep".
 *
 * `undefined` when the receipt would not fire or would withhold nothing.
 */
export function sliceReceiptCommentWindows(args: {
  workspace: string;
  filePath: string;
  sha: string;
  totalLines: number;
  start: number;
  end: number;
  /** The comment windows this read's own rendering elides. */
  rendererElided: ReadonlyArray<readonly [number, number]>;
  keepComments: boolean;
}): { kind: "withhold" } | { kind: "serve" | "next"; windows: Array<[number, number]> } | undefined {
  const unheld = servedRangeUnheldLines(args.workspace, args.filePath, args.sha, args.start, args.end, args.totalLines);
  if (unheld === undefined || unheld.length === 0) return undefined;
  if (args.keepComments) return { kind: "withhold" };
  // The slice door's receipt fires when every line the rendering shows is held.
  const shownSpans = spansExcludingWindows(args.start, args.end, args.rendererElided);
  if (shownSpans.length === 0) return undefined;
  const receipted = shownSpans.every(([spanStart, spanEnd]) =>
    servedRangeReceipt(args.workspace, args.filePath, args.sha, spanStart, spanEnd, args.totalLines) !== undefined);
  if (!receipted) return undefined;
  const shown = unheld.flatMap(([unheldStart, unheldEnd]) =>
    spansExcludingWindows(unheldStart, unheldEnd, args.rendererElided));
  return { kind: shown.length === 0 ? "serve" : "next", windows: unheld };
}

/**
 * `sliceReceiptCommentWindows`'s `serve`: the read's window as a difference
 * payload — `windows` (the comment lines the caller holds no byte of) served
 * raw, every other line `prior` — with a note saying why comments came back
 * from a default-policy read. `undefined` when there is nothing fresh to
 * serve, and the slice door then answers as before.
 */
export function serveSliceCommentWindows(args: {
  workspace: string;
  filePath: string;
  content: string;
  handleId: string;
  sha: string;
  start: number;
  end: number;
  windows: ReadonlyArray<readonly [number, number]>;
  concernNote?: string;
}): ReturnType<typeof toolOk> | undefined {
  const difference = buildLedgerDifferenceFullPayload({
    workspace: args.workspace,
    filePath: args.filePath,
    content: args.content,
    handleId: args.handleId,
    sha: args.sha,
    keepComments: true,
    mode: "slice",
    range: [args.start, args.end],
    priorCoverage: servedRangeCoverage(args.workspace, args.filePath, args.sha, countLines(args.content), undefined, true),
  });
  if (difference === undefined) return undefined;
  recordReadPath(args.workspace, args.filePath);
  const runs = args.windows.map(([start, end]) => `${start}-${end}`).join(", ");
  return toolOk(attachSupply({
    ...difference,
    note: `comment lines ${runs} were never sent (default reads elide them): served with comments kept;`
      + " the other lines are unchanged (prior)",
    ...(args.concernNote !== undefined ? { concern_note: args.concernNote } : {}),
  }, args.workspace));
}

/**
 * A partial task-pack/slice makes some file lines resident, but a later
 * whole-file request must still serve every line the caller does not hold.
 * Return mixed per-window evidence so the v1 projector can preserve both facts:
 * fresh gaps carry code and resident gaps carry code_unchanged provenance.
 */
export function buildLedgerDifferenceFullPayload(args: {
  workspace: string;
  filePath: string;
  content: string;
  handleId: string;
  sha: string;
  keepComments: boolean;
  // W-WIRE-2A: "slice" added so the single-range mode=slice door (below) can
  // reuse this same segments/prior-window builder for its OWN partial-coverage
  // narrowing, gated by TL_RECEIPT_COVERAGE, instead of a second copy of the
  // fresh/prior-span composition logic.
  mode: "full" | "auto" | "symbol" | "slice";
  /** Optional requested file-line window; omitted means the whole file. */
  range?: readonly [number, number];
  /** Coverage observed before a helper resolves a full expansion. */
  priorCoverage?: ReturnType<typeof servedRangeCoverage>;
  /**
   * TL-REVIEW-2 (2026-10-06): the comment windows THIS request's own
   * representation elides (a default-policy whole-file read: the whole-file
   * rendering's `elided`). An unheld gap lying inside one is not re-served —
   * not even raw through the doc-only fallback, which is how the reviewer's
   * identical repeat read got three JSDoc blocks back labelled "doc-only
   * file" — it is disclosed instead, as `elided_windows` (projected onto the
   * first evidence entry's `elided`). Omitted/empty for `comments:"keep"`.
   */
  policyElided?: ReadonlyArray<readonly [number, number]>;
}): Record<string, unknown> | undefined {
  const totalLines = countLines(args.content);
  const coverage = args.priorCoverage
    ?? servedRangeCoverage(args.workspace, args.filePath, args.sha, totalLines, args.policyElided, args.keepComments);
  if (coverage === undefined || coverage.complete) return undefined;

  const requestedStart = args.range?.[0] ?? 1;
  const requestedEnd = args.range?.[1] ?? totalLines;
  const lines = args.content.split(/\r?\n/);
  const segments: Array<Record<string, unknown>> = [];
  const notes: string[] = [];
  const elidedWindows: Array<[number, number]> = [];
  const serveCall = beginServeCall(args.workspace);

  const appendFresh = (start: number, end: number): void => {
    const raw = lines.slice(start - 1, end).join("\n");
    const display = args.keepComments
      ? { content: raw, note: undefined as string | undefined, elided: [] as Array<[number, number]> }
      : elideDocCommentsForDisplay(raw, languageForPath(args.filePath), false, start);
    segments.push({ range: `${start}-${end}`, code: display.content });
    if (display.note !== undefined) notes.push(`${start}-${end}: ${display.note}`);
    // FX-W3 (ruling (aa)): surviving spans from the renderer's own `elided`
    // accounting, not from re-parsing `display.content`.
    for (const [spanStart, spanEnd] of spansExcludingWindows(start, end, display.elided)) {
      recordServedRange(
        args.workspace,
        args.filePath,
        args.sha,
        spanStart,
        spanEnd,
        totalLines,
        { mode: args.mode, range: `${start}-${end}`, call: serveCall },
      );
    }
  };

  // TL-REVIEW-2: an unheld gap is served only where the request's own
  // representation would serve it; the parts inside `policyElided` windows
  // are disclosed (`elided_windows`), never re-served.
  const appendGap = (start: number, end: number): void => {
    const policy = args.keepComments ? [] : (args.policyElided ?? []);
    let at = start;
    for (const [windowStart, windowEnd] of policy) {
      const from = Math.max(at, windowStart);
      const to = Math.min(end, windowEnd);
      if (to < from) continue;
      if (from > at) appendFresh(at, from - 1);
      elidedWindows.push([from, to]);
      at = to + 1;
    }
    if (at <= end) appendFresh(at, end);
  };

  let cursor = requestedStart;
  for (const [servedStartRaw, servedEndRaw] of coverage.served) {
    const servedStart = Math.max(requestedStart, servedStartRaw);
    const servedEnd = Math.min(requestedEnd, servedEndRaw);
    if (servedEnd < cursor || servedStart > requestedEnd) continue;
    if (cursor < servedStart) appendGap(cursor, servedStart - 1);
    const priorStart = Math.max(cursor, servedStart);
    const receipt = servedRangeReceipt(
      args.workspace,
      args.filePath,
      args.sha,
      priorStart,
      servedEnd,
      totalLines,
    );
    segments.push({
      range: `${priorStart}-${servedEnd}`,
      code_unchanged: true,
      ...(receipt?.served_by !== undefined ? { served_by: receipt.served_by } : {}),
    });
    cursor = servedEnd + 1;
  }
  if (cursor <= requestedEnd) appendGap(cursor, requestedEnd);

  if (!segments.some((segment) => typeof segment["code"] === "string")) return undefined;
  return {
    mode: args.mode,
    path: args.filePath,
    handle: args.handleId,
    sha: shortSha(args.sha),
    total_lines: totalLines,
    segments,
    ...(notes.length > 0 ? { note: notes.join("; ") } : {}),
    // TL-REVIEW-2: internal carrier, projected by readFamily.ts's
    // `textEvidence` onto the first evidence entry's wire `elided`.
    ...(elidedWindows.length > 0
      ? { elided_windows: elidedWindows.map(([start, end]) => `${start}-${end}`) }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// B2 / V12-02 — delta context: the READ side (TL_DELTA_CONTEXT, default OFF)
// ---------------------------------------------------------------------------

/**
 * Bytes a `prior` segment costs once `readFamily.ts`'s `textEvidence` has
 * projected it: `{"handle":…,"path":…,"range":"120-480","prior":"slice 1-500
 * (call #2)"}`. Deliberately GENEROUS — the size guard's job is to prefer the
 * plain body whenever the delta win is marginal, so over-estimating the
 * projection's own overhead fails in the safe direction.
 */
export const DELTA_PRIOR_SEGMENT_BYTES = 140;

/** Extra bytes a fresh segment costs over the single-body serve it replaces. */
export const DELTA_FRESH_SEGMENT_BYTES = 90;

/** Raw byte size of file lines [start,end] of `lines` (newlines included). */
export function lineWindowBytes(lines: readonly string[], start: number, end: number): number {
  let bytes = 0;
  for (let i = start; i <= end && i <= lines.length; i += 1) {
    bytes += Buffer.byteLength(lines[i - 1] ?? "", "utf8") + 1;
  }
  return bytes;
}

/**
 * B2 / V12-02: should this read serve a delta projection instead of the plain
 * body, and is the ledger entry behind it still valid?
 *
 * THREE GATES, IN ORDER, ALL OF WHICH MUST PASS:
 *  1. `TL_DELTA_CONTEXT` is on. Off, this returns `undefined` before touching
 *     any state, which is what makes an edit-then-read sequence byte-identical
 *     to the pre-B2 tree.
 *  2. `deltaLedgerStatus` says `"carried"` — the entry survived an edit THIS
 *     server applied AND still describes the bytes on disk. A `"dropped"`
 *     answer is the base-mismatch fallback (an external write): the entry is
 *     gone and the caller serves the full body.
 *  3. THE SIZE GUARD (plan acceptance "delta>full なら自動 full"): the held
 *     windows must be worth more than the per-segment overhead they cost.
 *     Measured on the RAW line bytes of both sides — the elider shrinks held
 *     and fresh windows alike, so comparing pre-elision bytes keeps the
 *     decision monotone without running the elider twice.
 *
 * SIDE-EFFECT FREE ON A LOSS. It never builds the projection, so nothing is
 * booked into the served-range ledger for a delta the caller does not receive
 * — `buildLedgerDifferenceFullPayload` records as it goes, and calling it
 * speculatively would claim bytes that never reached the wire.
 */
export function deltaContextDecision(args: {
  workspace: string;
  filePath: string;
  content: string;
  sha: string;
  totalLines: number;
  /** Requested file-line window; omitted means the whole file. */
  range?: readonly [number, number];
}):
  | { decision: "delta"; coverage: NonNullable<ReturnType<typeof servedRangeCoverage>> }
  | { decision: "full" }
  | undefined {
  if (!deltaContextEnabled()) return undefined;
  const status = deltaLedgerStatus(args.workspace, args.filePath, args.sha);
  if (status === undefined) return undefined;
  // The entry was delta-derived and an external write invalidated it: the
  // caller must serve the plain body, and must NOT fall through to a coverage
  // check that a differently-shaped stale entry could still satisfy.
  if (status === "dropped") {
    trace("delta_context", {
      phase: "base-mismatch",
      path: args.filePath,
      outcome: "full-fallback",
    }, args.workspace);
    return { decision: "full" };
  }
  const coverage = servedRangeCoverage(args.workspace, args.filePath, args.sha, args.totalLines);
  if (coverage === undefined || coverage.complete) return undefined;

  const requestedStart = args.range?.[0] ?? 1;
  const requestedEnd = args.range?.[1] ?? args.totalLines;
  const lines = args.content.split(/\r?\n/);
  let heldBytes = 0;
  let priorSegments = 0;
  let freshSegments = 0;
  let cursor = requestedStart;
  for (const [servedStartRaw, servedEndRaw] of coverage.served) {
    const servedStart = Math.max(requestedStart, servedStartRaw);
    const servedEnd = Math.min(requestedEnd, servedEndRaw);
    if (servedEnd < cursor || servedStart > requestedEnd) continue;
    if (cursor < servedStart) freshSegments += 1;
    const priorStart = Math.max(cursor, servedStart);
    heldBytes += lineWindowBytes(lines, priorStart, servedEnd);
    priorSegments += 1;
    cursor = servedEnd + 1;
  }
  if (cursor <= requestedEnd) freshSegments += 1;
  // Nothing of this request is held: there is no delta to serve, and no reason
  // to override whatever the caller's ordinary path would have done.
  if (priorSegments === 0) return undefined;

  const projectionOverhead = priorSegments * DELTA_PRIOR_SEGMENT_BYTES
    + freshSegments * DELTA_FRESH_SEGMENT_BYTES;
  if (heldBytes <= projectionOverhead) {
    trace("delta_context", {
      phase: "guard",
      path: args.filePath,
      outcome: "full-cheaper",
      held_bytes: heldBytes,
      projection_overhead: projectionOverhead,
    }, args.workspace);
    return { decision: "full" };
  }
  trace("delta_context", {
    phase: "serve",
    path: args.filePath,
    range: `${requestedStart}-${requestedEnd}`,
    prior_segments: priorSegments,
    fresh_segments: freshSegments,
    held_bytes: heldBytes,
    projection_overhead: projectionOverhead,
  }, args.workspace);
  return { decision: "delta", coverage };
}
