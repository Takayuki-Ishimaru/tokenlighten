import type { ToolCallResult } from "../../../protocol/result.js";
import { toolError, toolStructuredError, toolOk } from "../../../protocol/result.js";
import { canonicalToolCall, protocolCallContext } from "../../../protocol/envelope.js";
import { recordReadOnlyServedRangedServe } from "../../../features/task-pack/engine/epochEvidence.js";
import { normalizeContractLane, recordServedWindow } from "../../../util/packServeLog.js";
import { elideDocCommentsForExplicitWindow, elideDocCommentsForDisplay, spansExcludingWindows } from "../../../util/formatCompress.js";
import { languageForPath } from "../../../util/languages.js";
import { countLines, sliceLinesToText } from "../../../util/countLines.js";
import { bindToResponseCeiling } from "../../../protocol/budget/wireBudget.js";
import { resolveCallerByteCeiling, resolveSliceRanges, MAX_SLICE_RANGES, READ_SYMBOL_CAP_BYTES, resolveSlice } from "../../../tools/readCodeModes.js";
import { parseWindows } from "../../../state/readRequestStore.js";
import { shaOfText, handleTable, shortSha } from "../../../util/handles.js";
import { batchHintsEnabled, receiptCoverageEnabled } from "../../../util/flags.js";
import { servedClusterCount, servedClusterRanges, unservedLineCount, servedRangeReceipt, type ServedRangeLedgerReceipt, beginServeCall, recordServedRange, servedRangeCoverage, recordReadPath } from "../../../state/session.js";
import { coverageReceiptFor, type CoverageVerdict, coveredByField } from "../../../protocol/coverageReceipt.js";
import { attachSupply } from "../../../util/attachSupply.js";
import { isMarkdownPath } from "../../../util/markdownSections.js";
import { elideSymbolContextForDisplay } from "../../../tools/getSymbolWithContext.js";
import { admitCallerRangedContinuation, servedTextForRoute, undecodableTextMessage, attachMarkdownHeadingIndex, markdownSymbolMissPayload, nulStrippedNoteText } from "../../../serverOwned/read-admission2.js";
import { resolveDeclaredAnswerEpochTokens } from "../../../serverOwned/task-binding2.js";
import { stageReadRequestForServe } from "../../../serverOwned/canonical-input2.js";
import { parseLedgerRangeSpec, composeReadBatchHint, type ReadLedgerEntry } from "../../../serverOwned/workspace-routing.js";
import { rangeStartLine, rangeEndLine } from "../../../serverOwned/edit-anchor.js";
import { openParentReceiptContinuation } from "../../../serverOwned/canonical-input3.js";
import { servedContentReceipt, buildLedgerDifferenceFullPayload, sliceReceiptCommentWindows, serveSliceCommentWindows, computeSliceContinuation } from "../../../serverOwned/read-receipts.js";
import { elisionMarkerNote } from "../../../serverOwned/search-support.js";
import { stageWindowReadRequest } from "../../../serverOwned/canonical-input.js";

export interface read_slicePort {
  "mode": string;
  "resolvedPath": string | undefined;
  "args": Record<string, unknown>;
  "hasRangesBatch": boolean;
  "rangesArg": string[];
  "resolvedRange": string | undefined;
  "workspace": string;
  "handleArg": string | undefined;
  "resolvedSymbol": string | undefined;
  "keepComments": boolean;
  "rangeContentFullMarker": boolean;
  "callerSuppliedRange": boolean;
  "defaultResponseByteCeiling": number | undefined;
  "readLedger": { entries: ReadLedgerEntry[]; truncatedNote?: string; };
  "forceContentServe": boolean;
  "staleHandleReresolved": string | undefined;
  "noteZeroByteServe": () => void;
}
export async function read_slice(port: read_slicePort): Promise<ToolCallResult | undefined> {
  const { mode, resolvedPath, args, hasRangesBatch, rangesArg, resolvedRange, workspace, handleArg, resolvedSymbol, keepComments, rangeContentFullMarker, callerSuppliedRange, defaultResponseByteCeiling, readLedger, forceContentServe, staleHandleReresolved, noteZeroByteServe } = port;
if (mode === "slice") {
        const slicePath = resolvedPath ?? "";
        if (!slicePath) {
          // FIELD DEFECT (2026-08-27 field-eval T1): explicit mode="slice"
          // with paths=[...] (no singular path/handle) used to fall straight
          // to the bare "path (or handle) is required" refusal below with no
          // `next` at all — the pathless-promotion net a few hundred lines up
          // (`promotionEligible`) only fires when mode is unspecified/"auto",
          // so an EXPLICIT slice bypasses it entirely and a caller reaching
          // for the batched-read idiom every other mode accepts got no
          // guidance back to the one form slice actually takes.
          const rawPaths = args["paths"];
          if (Array.isArray(rawPaths) && rawPaths.length > 0) {
            const pathList = rawPaths.map((entry) => String(entry));
            // FX-1: a target-object FRAGMENT (merged into the canonical
            // `targets=[...]` prose below), not a pre-joined `key=value` string —
            // a raw-string `next` is a blind spot for `canonicalizeEmittedToolCalls`,
            // which only rewrites OBJECT-shaped embedded tool calls.
            const preserved: Record<string, unknown> = hasRangesBatch
              ? { ranges: rangesArg }
              : resolvedRange !== undefined
                ? { range: resolvedRange }
                : {};
            if (pathList.length === 1) {
              return toolError(
                "mode=slice takes a singular path, not paths[] — did you mean the single path below?",
                {
                  code: "invalid-input",
                  next: canonicalToolCall("tl_read_file", {
                    targets: [{ path: pathList[0], ...preserved }],
                    content: "auto",
                  }),
                  hint: "slice reads exactly one file; ranges[] windows several spans of THAT file, not several files",
                },
              );
            }
            // NOTE: `normalizeWireArgs` (this file, ~L5545) already intercepts
            // mode=slice + paths.length>1 EARLIER in the pipeline, before this
            // deep-dispatch branch runs, with its own next:"mode=task_pack"
            // recovery ("mode=slice accepts one path; multiple paths are
            // discovery scope") — so in practice this arm is defense-in-depth
            // for any call shape that reaches dispatch without going through
            // that normalizer. Matches its next verbatim (task_pack, not
            // mode=full) so the two producers of the same refusal never teach
            // a caller two different recoveries for one situation.
            return toolError(
              `mode=slice takes a singular path, not paths[] (got ${pathList.length})`,
              {
                code: "invalid-input",
                next: canonicalToolCall("tl_read_file", {
                  targets: pathList.map((path) => ({ path })),
                  content: "outline",
                }),
                hint: "slice is single-file; multiple paths[] is discovery scope, not a bigger slice — task_pack handles a large set too",
              },
            );
          }
          return toolError("path (or handle) is required for mode=slice", { code: "invalid-input" });
        }
        // TL-06 (plan-0143 §4/§8.1, R04, FIX-A6): the single-target
        // continuation door — see admitCallerRangedContinuation's own doc
        // comment. A caller-ranged `{path,range}` / `{handle,range}` /
        // `{...,ranges:[...]}` slice, addressed as a LONE `targets[]` element
        // (normalizeCanonicalRequest's own `targets.length === 1` promotion
        // projects it straight onto `args.path`/`args.handle`/`args.range`,
        // never through the multi-target `pathlessExploratoryPaths`/
        // mode=task_pack doors that already carry this check), is exactly the
        // shape resolveSlice's OWN per-call byte-cap continuation
        // (`remainingRange`) and buildSymbolDowngradePayload's downgrade
        // continuation both re-enter: a bare `{handle,range}` `next`, never
        // wrapped back into a multi-target batch. FIX-A5 instrumented the A7
        // handles=[] batch and both task_pack doors but never this one — this
        // is the door the acceptance harness calls out as "answers as
        // kind:read.text". Scoped exactly like those callers: only when this
        // call is about to re-serve a CALLER-RANGED window (a plain `range`,
        // or the `ranges[]` batch handled just below) of a real path/handle;
        // an unranged whole-symbol/whole-file slice is left untouched,
        // matching admitCallerRangedContinuation's own "unranged target"
        // exemption. `hasRangesBatch` wins over a stale `resolvedRange` when
        // both happen to be set (a handle's own stored range copied forward
        // alongside a caller `ranges[]`) — the same precedence the dispatch
        // below gives the ranges[] sub-block, which never consults
        // `resolvedRange` once `hasRangesBatch` is true.
        if (resolvedRange !== undefined || hasRangesBatch) {
          const rangeAdmission = await admitCallerRangedContinuation(
            workspace,
            [{
              ...(handleArg !== undefined ? { handle: handleArg } : { path: slicePath }),
              ...(hasRangesBatch ? { ranges: rangesArg } : { range: resolvedRange }),
              ...(resolvedSymbol !== undefined ? { symbol: resolvedSymbol } : {}),
            }],
            args,
          );
          if (rangeAdmission !== undefined) return rangeAdmission;
        }
        // R-A2 item 1 (2026-09-21, held item 4): computed once for this whole
        // caller-ranged route (both the ranges[] batch and single-range
        // sub-branches below feed it the same `slicePath`, under whichever
        // handle each resolves) — see `resolveDeclaredAnswerEpochTokens`'s own
        // doc comment for the fallback semantics of an empty (but not
        // undefined) token list, and `recordReadOnlyServedRangedServe`'s doc
        // comment for why this may never touch the cumulative served-surface
        // log. Scoped to a genuine ranged re-serve for the identical reason
        // `admitCallerRangedContinuation` just above is: an unranged whole-
        // file/whole-symbol slice has its own coverage story.
        const zoomAnswerEpochTokens = (resolvedRange !== undefined || hasRangesBatch)
          ? resolveDeclaredAnswerEpochTokens(workspace, args)
          : undefined;
        // P1-9 (2026-09-28, review round 4/5, hugeFocalValue): `spans`/`sha`
        // are optional so every pre-existing call this closure had (bare
        // `handle`) stays byte-identical; a caller that also knows what it
        // just shipped additionally books it into the EPOCH+LANE-SCOPED
        // window ledger (`recordServedWindow`, util/packServeLog.ts) —
        // the ledger `firstUnservedPartialRange`/`servedWindowHasUnservedLines`
        // (readCodeTaskPack.ts) consult when a later task-pack REBUILD
        // re-derives a required surface's completeness. Without this,
        // `recordReadOnlyServedRangedServe` below proves only PATH membership
        // (its own doc comment: "range is unused by that function"), so a
        // byte-capped focal surface's already-delivered tail — fetched by
        // exactly this caller-ranged `{handle,range}` route — was invisible
        // to that byte-level check: the rebuild re-truncated the SAME surface
        // identically and re-declared the SAME tail as `remaining_ranges`
        // forever, so the completeness obligation could never close and the
        // pack dead-ended on `await_input` with no `next` (observed live: a
        // 168-line focal function capped at hop 0, the byte-capped tail
        // fetched by this route, then a `{qref}` repack that still called it
        // unserved). Scoped to `zoomAnswerEpochTokens.length > 0` — an empty
        // array means no explicit `task.handle` resolved an epoch (see that
        // const's own doc comment), so there is no query text to derive a
        // matching `scope.epoch` string from, and this leaves that narrower
        // case exactly as before rather than guess.
        const noteZoomServedForAnswerEpoch = (
          handle: string,
          served?: { sha: string; spans: ReadonlyArray<readonly [number, number]> },
        ): void => {
          if (zoomAnswerEpochTokens !== undefined) {
            recordReadOnlyServedRangedServe(workspace, { path: slicePath, handle }, zoomAnswerEpochTokens);
            if (served !== undefined && zoomAnswerEpochTokens.length > 0) {
              const epoch = zoomAnswerEpochTokens.join("\u0000");
              const lane = normalizeContractLane(args["lane"]);
              for (const [startLine, endLine] of served.spans) {
                recordServedWindow({ workspaceRoot: workspace, epoch, lane, path: slicePath, sha: served.sha, startLine, endLine });
              }
            }
          }
        };
        // AA1 (round 10): the DIRECT SLICE route. Round 9's residuals W1-3/X1-1
        // were measured here: `targets:[{path, range}]` served a BOM-less UTF-16
        // file's 63 raw NULs and a 73-byte file's lone NUL while every task-pack
        // door disclosed the same files. One verdict now (see
        // `undecodableTextMessage`).
        // served-bytes: readServedText
        const sliceVerdict = await servedTextForRoute(slicePath, workspace);
        if (sliceVerdict !== null && sliceVerdict.kind === "undecodable") {
          return toolError(undecodableTextMessage(slicePath, sliceVerdict), { code: "read-error" });
        }
        const content = sliceVerdict === null ? null : sliceVerdict.text;
        if (content === null) return toolError(`File not found or outside workspace: ${slicePath}`, { code: "not-found" });

        // TL-05 (plan §7.1): this whole branch only ever slices an explicit
        // range/ranges/symbol, so a request that named `content:"full"`
        // alongside one is asking for that window UNELIDED — reuse the
        // existing `comments:"keep"` axis (DESIGN-v0.8 §C3) rather than a new
        // projection flag, so the served-range ledger's own elision-aware
        // bookkeeping (`spansExcludingWindows`, `wasFullyServed`'s own
        // `keepComments` key) keeps distinguishing an elided serve from this
        // one automatically — no receipt gate here is otherwise touched.
        const effectiveKeepComments = keepComments || rangeContentFullMarker;
        // 2026-10-19 (v016 6t-2 T13 rep0 #14, 6t-3 T13 rep2 #20): a window
        // the CALLER named (`range`/`ranges`, not a cursor page or a handle's
        // stored range) renders through `elideDocCommentsForExplicitWindow`,
        // which keeps the comments of a small mostly-comment window. Used by
        // the request staging, the ranges[] display and the single-range
        // display below, so all three agree on what this request owes.
        const callerNamedWindows = (callerSuppliedRange || hasRangesBatch)
          && protocolCallContext()?.readRequest?.page === undefined;
        const renderNamedWindow = (text: string, start: number): { content: string; note?: string; elided: Array<[number, number]> } =>
          callerNamedWindows
            ? elideDocCommentsForExplicitWindow(text, languageForPath(slicePath), start, countLines(content))
            : elideDocCommentsForDisplay(text, languageForPath(slicePath), false, start);

        // BCF2 (eval-0929 §9, DESIGN-v0.14-plan.md §16.6 residual): the SAME
        // explicit-budget-only conversion BCF's own `callerBudgetBytes` uses
        // for `buildFullServePayload` (this file, ~L6737) — `undefined`
        // unless THIS call named an EXPLICIT `budget.bytes`/`budget.tokens`
        // (mapCanonicalBudget never populates `maxBytes`/`maxTokens` from a
        // calibrated default), so a plain default-budget mode=slice read is
        // byte-identical to before this fix. Threaded into both the ranges[]
        // batch and single-range resolveSlice/resolveSliceRanges calls below,
        // so this door's own byte cap sizes to what the caller actually
        // declared instead of always cutting at the fixed
        // READ_SYMBOL_CAP_BYTES/SLICE_RANGES_TOTAL_CAP_BYTES constant and
        // leaving the emit-time shed ladder's imprecise halving to cut it
        // back down further (measured live: 0.62 fill at a 6144 B budget).
        //
        // REGRESSION FOUND AND CLOSED DURING THIS FIX (readRequestContinuation.
        // spec.ts "never widens or narrows an already-fixed page when the
        // budget moves"): the CURSOR-RESUME rewrite just above (§5.2,
        // ~L12805-12821) sets THIS SAME `args["range"]`/`args["ranges"]` to a
        // page `choosePage`/`fixPage` ALREADY fixed — a boundary DESIGN-v0.15
        // §5.2 requires to survive verbatim regardless of what budget a LATER
        // call on the same cursor declares (`fixedPageFloorRefusal`'s own
        // doc comment: "never narrowed"). Narrowing it a SECOND time here,
        // keyed off THIS call's inherited/declared budget, silently
        // re-shrank an already-fixed page on a small inherited budget and
        // then (confirmed live) served it WIDER again on a later same-cursor
        // call with a bigger declared budget — the exact widen/narrow this
        // design forbids. `context.readRequest?.page` is set ONLY by that
        // cursor-resume branch (`staged.page = cursorPage`, the one other
        // assignment site in this file besides `stageReadRequestForServe`'s
        // own — which runs AFTER this point and never sets `.page`), so it is
        // a reliable, already-computed signal that this dispatch's range was
        // fixed upstream rather than freshly requested.
        //
        // 2026-10-24 (read-page ceiling): and the client profile's response
        // ceiling bounds it as well (`bindToResponseCeiling`: a declared budget
        // below the ceiling wins, a larger one is clamped, none = the ceiling), so
        // a window is cut to the page the client delivers HERE, on a line, rather
        // than at the fixed 24 KiB cap and cut back by the emit tail. `undefined`
        // for a client with no ceiling and no declared budget, which is every
        // default-budget read it ever made.
        const sliceCallerBudgetBytes = protocolCallContext()?.readRequest?.page !== undefined
          ? undefined
          : bindToResponseCeiling(
              resolveCallerByteCeiling(
                typeof args["maxBytes"] === "number" ? args["maxBytes"] : undefined,
                typeof args["maxTokens"] === "number" ? args["maxTokens"] : undefined,
                undefined,
              ),
              defaultResponseByteCeiling,
            );

        // DESIGN-v0.15 §5.1 (R2): an explicit window request has a Q too — the
        // windows the caller named — and §5.1 requires "複数targets、離れた
        // ranges、空ファイル、最終改行、CRLF、日本語・長い行でも同じ定義を使う".
        // A no-op on a cursor call (that one staged its own request on the way
        // in) and on a request that is fully delivered (nothing is persisted).
        {
          const requestedWindows = hasRangesBatch
            ? parseWindows(rangesArg)
            : resolvedRange !== undefined ? parseWindows([resolvedRange]) : [];
          if (requestedWindows.length > 0) {
            const sliceTotalLines = countLines(content);
            const clamped = requestedWindows.map((window) => ({
              start: Math.min(window.start, Math.max(1, sliceTotalLines)),
              end: Math.min(window.end, Math.max(1, sliceTotalLines)),
            }));
            // TL-REVIEW-2 (2026-10-06): under `comments:"elide"` each window's
            // OWN rendering decides which comment blocks it discloses as
            // `elided` instead of serving; those are not owed (§5.1's Q
            // includes the representation). A window that is nothing but a
            // comment block still serves raw (the doc-only fallback reports
            // no windows), so it stays in Q.
            const contentLines = effectiveKeepComments ? [] : content.split(/\r?\n/);
            const windowElided = effectiveKeepComments
              ? []
              : clamped.map((window) => renderNamedWindow(
                  contentLines.slice(window.start - 1, window.end).join("\n"),
                  window.start,
                ).elided);
            const requested = effectiveKeepComments
              ? clamped
              : clamped.flatMap((window, index) => spansExcludingWindows(window.start, window.end, windowElided[index]!)
                .map(([start, end]) => ({ start, end })));
            stageReadRequestForServe({
              workspace,
              relPath: slicePath,
              fileSha: shaOfText(content),
              totalLines: sliceTotalLines,
              requested,
              content: "auto",
              keepComments: effectiveKeepComments,
              args,
              elided: windowElided.flat().map(([start, end]) => ({ start, end })),
            });
          }
        }

        // W-BATCH-HINT (a): snapshot how many served-range CLUSTERS this
        // session already holds for slicePath BEFORE any of this call's own
        // recordServedRange calls (deep in the branches below, part of the
        // W-LEDGER coverage-receipt wiring this workstream does not touch)
        // can add one. Flag-gated and read-only — a plain Map lookup skipped
        // entirely when TL_BATCH_HINTS is off, so it can never perturb that
        // wiring or its byte-identical-when-off guarantee.
        const readBatchHintClustersBefore = batchHintsEnabled() && !hasRangesBatch
          ? servedClusterCount(workspace, slicePath)
          : undefined;
        const readBatchHintHeldBefore = readBatchHintClustersBefore === 1
          ? servedClusterRanges(workspace, slicePath)
          : [];
        // W-BATCH-HINT (c): cross-check any declared `ledger` entry for THIS
        // path against the session's own servedRangeLedger via
        // coverageReceiptFor — never against the caller's say-so. Entries for
        // OTHER paths are not probed here (no extra disk I/O per declared
        // path) and simply never confirm. A CONFIRMED entry (`kind:"full"`)
        // is folded into readBatchHintHeldBefore below so the hint can name a
        // span the ledger independently proves the caller holds; an
        // UNCONFIRMED one (`kind` "none"/"partial" — never actually served,
        // or only partially) is silently dropped. Either way this cross-check
        // never skips serving and never emits a receipt of its own — DC3
        // stays the only receipt authority.
        const readLedgerConfirmed: string[] = [];
        if (batchHintsEnabled() && readLedger.entries.length > 0) {
          const ledgerSha = shaOfText(content);
          const ledgerTotalLines = countLines(content);
          for (const entry of readLedger.entries) {
            if (entry.path !== slicePath) continue;
            const spec = entry.range !== undefined ? parseLedgerRangeSpec(entry.range) : undefined;
            const verdict = entry.range === undefined
              ? coverageReceiptFor({ workspace, path: slicePath, sha: ledgerSha, totalLines: ledgerTotalLines, want: "full" })
              : spec !== undefined
                ? coverageReceiptFor({
                    workspace, path: slicePath, sha: ledgerSha, totalLines: ledgerTotalLines,
                    want: "range", start: spec[0], end: spec[1],
                  })
                : undefined;
            if (verdict !== undefined && verdict.kind === "full") {
              readLedgerConfirmed.push(entry.range ?? `1-${ledgerTotalLines}`);
            }
          }
        }

        // ---------------------------------------------------------------------
        // A2 ranges[] batching: serve every requested window of THIS file in one
        // response. Shares this branch (not a mode of its own) so path/handle
        // resolution, the workspace guard, the doc-comment display helper and
        // the served-range ledger are the same code the single-range serve uses.
        // ---------------------------------------------------------------------
        if (hasRangesBatch) {
          // B2d (2026-08-01 serving-completeness): ZOOM PROGRESS GUARANTEE.
          //
          // resolveSliceRanges fills its response cap in CALLER order, so a
          // cap-clipped multi-range request served whatever came first and
          // deferred the rest. Live (2026-07-31-semantic-signal5-2, T03):
          // ranges:["45-105","271-1552"] served the ALREADY-HELD 45-105 and
          // re-deferred 271-1552 — a whole turn spent on 61 duplicate lines with
          // zero progress. Re-order the request by (unserved-lines DESC) against
          // the served-range ledger before the byte budget is applied, so the
          // window carrying the most NEW content always rides.
          const zoomFileSha = shaOfText(content);
          const zoomTotalLines = countLines(content);
          const parseRequested = (raw: string): { start: number; end: number } | undefined => {
            const one = raw.trim().match(/^L?(\d+)$/i);
            if (one !== null) {
              const line = parseInt(one[1]!, 10);
              return { start: line, end: line };
            }
            const span = raw.trim().match(/^L?(\d+)\s*-\s*L?(\d+)$/i);
            if (span === null) return undefined;
            return { start: parseInt(span[1]!, 10), end: parseInt(span[2]!, 10) };
          };
          const orderedRanges = !forceContentServe
            ? rangesArg
              .map((raw, index) => {
                const parsed = parseRequested(String(raw));
                // Unparseable entries keep their caller position (resolveSlice
                // owns the refusal/invalid_ranges shape for them) and are
                // treated as fully-unserved so they are never pushed behind a
                // held window.
                const unserved = parsed === undefined
                  ? Number.MAX_SAFE_INTEGER
                  : unservedLineCount(
                      workspace, slicePath, zoomFileSha, parsed.start, parsed.end, zoomTotalLines,
                    );
                return { raw: String(raw), index, unserved };
              })
              // Stable: more-unserved first, caller order breaks ties. A fully
              // held window (unserved === 0) always sorts LAST, so it can never
              // consume budget an unserved window needed.
              .sort((left, right) => right.unserved - left.unserved || left.index - right.index)
              .map((entry) => entry.raw)
            : rangesArg;
          // 2026-10-24 (read-page ceiling): a page the read-request store FIXED
          // under the client's ceiling is not a caller's hand-built batch, and the
          // twelve-window cap on one is a round trip per twelve windows of a
          // comment-fragmented file (see `resolveSliceRanges`'s `maxRanges`). Only
          // for a client with a ceiling: a page fixed under a declared budget keeps
          // the cap it has always had.
          const fixedPageUnderCeiling = protocolCallContext()?.readRequest?.page !== undefined
            && defaultResponseByteCeiling !== undefined;
          const batch = await resolveSliceRanges(
            workspace, slicePath, content, orderedRanges, sliceCallerBudgetBytes,
            fixedPageUnderCeiling ? Math.max(MAX_SLICE_RANGES, orderedRanges.length) : MAX_SLICE_RANGES,
          );
          if (!batch.ok) {
            return toolStructuredError({
              ok: false,
              error: batch.error,
              path: slicePath,
              handle: handleTable.upsert({
                kind: "file",
                path: slicePath,
                workspaceRoot: workspace,
                sha: shaOfText(content),
              }).id,
              ...(batch.code ? { code: batch.code } : {}),
              ...(batch.total_lines !== undefined ? { total_lines: batch.total_lines } : {}),
              ...(batch.next !== undefined ? { next: batch.next } : {}),
            });
          }
          const batchData = batch.data;
          const rawFileSha = zoomFileSha;
          const fileTotalLines = zoomTotalLines;
          // D10 (2026-08-14): `TL_SERVED_RANGE_LEDGER` is deleted; the ledger is
          // unconditional, so the former `ledgerOn` gate is gone.

          // W1 served-content receipts, per segment. PROBE every segment against
          // the ledger BEFORE recording any of them: recording first would make a
          // later segment that merely overlaps an EARLIER SEGMENT OF THIS SAME
          // CALL look already-served, and a receipt pointing at bytes the caller
          // is receiving in this very response is not a receipt, it is a hole.
          const alreadyHeld = new Set<string>();
          // F3 (2026-08-02 serve-honesty): the probe already computes the
          // provenance — keep it, so every held segment names the call that
          // actually served it instead of asserting it uncheckably.
          const alreadyHeldBy = new Map<string, string>();
          // Each probed segment's own rendering, reused by the display below.
          const probedDisplays = new Map<string, { content: string; note?: string; elided: Array<[number, number]> }>();
          if (!forceContentServe) {
            for (const segment of batchData.segments) {
              // W2A-1 (2026-08-21 serve-honesty): a TRUNCATED segment's
              // [segStart,segEnd] below is only the CLAMPED prefix
              // resolveSlice fit under the cap, not the caller's whole
              // requested window — `servedRangeReceipt` would correctly
              // confirm that clamped prefix alone was already held, but
              // marking the SEGMENT already-held then displays it as a bare
              // `code_unchanged` placeholder (no code) with no signal that
              // the segment itself never covered the rest of the request.
              // Never eligible for the elision, same reasoning as the
              // single-range branch's `sliceData.remaining_ranges` guard.
              if (segment.truncated === true) continue;
              const segStart = rangeStartLine(segment.range);
              const segEnd = Math.min(fileTotalLines, segStart + countLines(segment.code) - 1);
              // 2026-10-19 (DESIGN-v0.14-plan.md §20.26, 6t-3 T13 rep1 #3): the
              // comment windows this segment's own rendering elides are not
              // owed, the rule the single-range branch below applies through
              // `spansExcludingWindows(…, sliceDisplay.elided)` and the loop
              // brake through `requestElisionProbe`. Without it a repeat
              // `ranges` read of windows an earlier read served with their
              // comment blocks elided re-sent every code line (recorded:
              // 13,339 B). A held segment's re-affirmation below books only
              // these owed spans, never the elided lines.
              const ownDisplay = effectiveKeepComments ? undefined : renderNamedWindow(segment.code, segStart);
              if (ownDisplay !== undefined) probedDisplays.set(segment.range, ownDisplay);
              const heldReceipt = servedRangeReceipt(
                workspace, slicePath, rawFileSha, segStart, segEnd, fileTotalLines, ownDisplay?.elided,
                effectiveKeepComments,
              );
              if (heldReceipt !== undefined) {
                alreadyHeld.add(segment.range);
                if (heldReceipt.served_by !== undefined) {
                  alreadyHeldBy.set(segment.range, heldReceipt.served_by);
                }
              }
            }
          }
          // F1 (2026-08-02 serve-honesty): compose the DISPLAY text BEFORE
          // recording. `segment.code` is raw; the wire carries it with every
          // multi-line comment block collapsed to a `doc elided L<a>-<b>`
          // marker, so booking segStart..segStart+countLines(raw)-1 claimed
          // lines the caller never received and receipted them on the next
          // read. The alreadyHeld probe above still runs FIRST (unchanged) —
          // its ordering guarantee is what stops a segment of THIS response
          // from receipting a sibling segment of the same response.
          const segmentDisplays = new Map<string, { content: string; note?: string; elided: Array<[number, number]> }>();
          for (const segment of batchData.segments) {
            if (alreadyHeld.has(segment.range)) continue;
            segmentDisplays.set(
              segment.range,
              effectiveKeepComments
                ? { content: segment.code, note: undefined as string | undefined, elided: [] as Array<[number, number]> }
                : probedDisplays.get(segment.range) ?? renderNamedWindow(segment.code, rangeStartLine(segment.range)),
            );
          }
          let batchLedger: ServedRangeLedgerReceipt | undefined;
          const batchServedSpans: Array<[number, number]> = [];
          {
            const batchCall = beginServeCall(workspace);
            for (const segment of batchData.segments) {
              const segStart = rangeStartLine(segment.range);
              const segEnd = Math.min(fileTotalLines, segStart + countLines(segment.code) - 1);
              const display = segmentDisplays.get(segment.range);
              // An already-held segment is answered with a receipt, not bytes:
              // re-affirming its owed spans (its span minus the comment windows
              // its own rendering elides, §20.26) adds nothing (they are
              // subsumed by definition) and keeps batchLedger defined for the
              // all-held collapse below.
              // FX-W3 (ruling (aa)): renderer-accounted spans, not a re-parse
              // of `display.content`.
              const spans = display === undefined
                ? spansExcludingWindows(segStart, segEnd, probedDisplays.get(segment.range)?.elided ?? [])
                : spansExcludingWindows(segStart, segEnd, display.elided);
              for (const [spanStart, spanEnd] of spans) {
                batchLedger = recordServedRange(
                  workspace, slicePath, rawFileSha, spanStart, spanEnd, fileTotalLines,
                  { mode: "slice", range: segment.range, call: batchCall },
                );
                batchServedSpans.push([spanStart, spanEnd]);
              }
            }
          }
          noteZoomServedForAnswerEpoch(batchData.handle, { sha: rawFileSha, spans: batchServedSpans });

          // Every requested window is already held at this exact file sha — the
          // whole response collapses to the one shared receipt shape.
          //
          // W2A-1 (2026-08-21 serve-honesty): `batchData.remaining_ranges`
          // only names WHOLE requested ranges resolveSliceRanges never
          // attempted (overflow / total-byte-cap deferrals) — it says nothing
          // about a single held segment that was itself clamped short of what
          // it was asked for (e.g. `ranges=["587-8119"]` on a 21k-line file,
          // internally capped to 587-1104). `batchData.truncated` is the field
          // that already ORs in that per-segment signal
          // (`segments.some(s => s.truncated)`, see resolveSliceRanges); the
          // fast-path collapse must not fire while it holds, or the returned
          // receipt claims full coverage of the caller's request while the
          // clamped tail was never served OR disclosed (same defect and fix
          // as the single-range branch below, servedContentReceipt call #2).
          if (
            batchData.segments.length > 0
            && alreadyHeld.size === batchData.segments.length
            && batchLedger !== undefined
            && batchData.remaining_ranges === undefined
            && batchData.truncated !== true
          ) {
            const heldLabels = [...new Set(alreadyHeldBy.values())];
            const batchServedBy = heldLabels.length === 0
              ? undefined
              : heldLabels.length <= 2
                ? heldLabels.join(" + ")
                : `${heldLabels[0]!} +${heldLabels.length - 1} more`;
            const batchParentContinuation = openParentReceiptContinuation(
              workspace, slicePath, rawFileSha, args,
              parseWindows(batchData.segments.map((segment) => segment.range)),
            );
            return toolOk(attachSupply(servedContentReceipt({
              mode: "slice",
              handle: batchData.handle,
              path: slicePath,
              range: batchData.segments.map((segment) => segment.range).join(","),
              sha: shortSha(rawFileSha),
              ledger: batchLedger,
              ...(batchServedBy !== undefined ? { servedBy: batchServedBy } : {}),
              extra: { served_range_ledger: batchLedger },
              workspace,
              ...(batchParentContinuation !== undefined ? { parentContinuation: batchParentContinuation } : {}),
            }), workspace));
          }

          const segmentNotes: string[] = [];
          const servedSegments = batchData.segments.map((segment) => {
            if (alreadyHeld.has(segment.range)) {
              // Content-equivalent, not a breadcrumb: the caller was served these
              // exact lines at this exact sha earlier in the session.
              return {
                range: segment.range,
                sha: shortSha(segment.sha),
                code_unchanged: true as const,
                ...(alreadyHeldBy.has(segment.range)
                  ? { served_by: alreadyHeldBy.get(segment.range)! }
                  : {}),
              };
            }
            // Composed above (F1) so the ledger could be fed from the wire
            // text; the fallback keeps this map total for any segment the
            // probe loop classified as held after the displays were built.
            const display = segmentDisplays.get(segment.range) ?? (effectiveKeepComments
              ? { content: segment.code, note: undefined as string | undefined }
              : renderNamedWindow(segment.code, rangeStartLine(segment.range)));
            const composed = [segment.note, display.note, elisionMarkerNote(display.content)]
              .filter(Boolean).join("; ") || undefined;
            if (composed !== undefined) segmentNotes.push(`${segment.range}: ${composed}`);
            return {
              range: segment.range,
              code: display.content,
              sha: shortSha(segment.sha),
              ...(segment.truncated === true ? { truncated: true as const } : {}),
              ...(composed !== undefined ? { note: composed } : {}),
            };
          });

          // B2d: a requested window the cap pushed into remaining_ranges that
          // the ledger already covers must NOT be re-requested — telling the
          // caller to fetch bytes it already holds is the duplicate-turn the
          // reordering above exists to remove. Answer it as a compact receipt
          // here and drop it from remaining_ranges/next.
          const deferredHeld: Array<{
            range: string; sha: string; code_unchanged: true; served_by?: string;
          }> = [];
          let batchRemaining = batchData.remaining_ranges;
          if (!forceContentServe && batchRemaining !== undefined) {
            // §20.26: a deferred window owes what its own rendering would
            // serve, as a probed segment above does.
            const deferredLines = effectiveKeepComments ? [] : content.split(/\r?\n/);
            const deferredOwnElided = (start: number, end: number): Array<[number, number]> | undefined => {
              if (effectiveKeepComments) return undefined;
              const from = Math.max(1, Math.min(start, fileTotalLines));
              const to = Math.min(end, fileTotalLines);
              if (to < from) return undefined;
              return renderNamedWindow(deferredLines.slice(from - 1, to).join("\n"), from).elided;
            };
            const stillMissing: string[] = [];
            for (const raw of batchRemaining) {
              const parsed = parseRequested(String(raw));
              const receipt = parsed === undefined
                ? undefined
                : servedRangeReceipt(
                    workspace, slicePath, rawFileSha, parsed.start, parsed.end, fileTotalLines,
                    deferredOwnElided(parsed.start, parsed.end),
                    effectiveKeepComments,
                  );
              if (receipt === undefined) {
                stillMissing.push(String(raw));
                continue;
              }
              // Pinned by the FILE sha (these lines were never re-sliced this
              // call, so there is no per-slice body to hash) — the same sha the
              // served_range_ledger below reports. F2 re-audit (2026-08-02):
              // that pin stays correct because servedRangeReceipt only consults
              // an entry whose `fileSha` equals this exact sha, and F2 only ever
              // NARROWED which windows qualify (coverage now comes from the
              // unmerged per-serve spans) — a window whose lines were only ever
              // elided no longer receipts here, it stays in remaining_ranges.
              deferredHeld.push({
                range: String(raw),
                sha: shortSha(rawFileSha),
                code_unchanged: true as const,
                ...(receipt.served_by !== undefined ? { served_by: receipt.served_by } : {}),
              });
            }
            batchRemaining = stillMissing.length > 0 ? stillMissing : undefined;
          }
          // B2d: the reordering above is a BUDGET decision, not a presentation
          // one. Segments go back on the wire in the order the caller asked for
          // them (rangesBatch/replay-corpus pin that), with any deferred-but-held
          // window slotted at its own requested position.
          const requestedOrder = new Map<number, number>();
          rangesArg.forEach((raw, index) => {
            const parsed = parseRequested(String(raw));
            // FIRST occurrence wins, matching resolveSliceRanges' own dedupe:
            // ["L10-L12","10-12"] collapse to one window at position 0.
            if (parsed !== undefined && !requestedOrder.has(parsed.start)) {
              requestedOrder.set(parsed.start, index);
            }
          });
          const orderKey = (range: unknown): number => {
            const parsed = parseRequested(String(range));
            if (parsed === undefined) return Number.MAX_SAFE_INTEGER;
            return requestedOrder.get(parsed.start) ?? Number.MAX_SAFE_INTEGER;
          };
          const orderedSegments = [...servedSegments, ...deferredHeld]
            .map((segment, index) => ({ segment, index }))
            .sort((left, right) =>
              orderKey(left.segment.range) - orderKey(right.segment.range)
              || left.index - right.index)
            .map((entry) => entry.segment);

          const heldCount = alreadyHeld.size + deferredHeld.length;
          // FX-1: canonical `targets=[...]` prose, not the legacy `mode=slice`
          // dialect (a raw-string `next` bypasses `canonicalizeEmittedToolCalls`,
          // which only rewrites OBJECT-shaped embedded tool calls).
          const batchNext = batchRemaining !== undefined && batchRemaining.length > 0
            ? canonicalToolCall("tl_read_file", {
                targets: [{ handle: batchData.handle, ranges: batchRemaining }],
                content: "auto",
              })
            : batchData.remaining_ranges !== undefined
              ? undefined // every deferred window was already held — nothing to fetch
              : batchData.next;

          const batchComposedNote = [
            staleHandleReresolved
              ? `handle ${staleHandleReresolved} was no longer live; re-resolved by path=${slicePath}`
              : undefined,
            batchData.note,
            heldCount > 0
              ? `${heldCount} segment(s) already served at this sha — code_unchanged receipt instead of a re-send`
              : undefined,
            deferredHeld.length > 0
              ? "response cap: unserved windows were served first (zoom progress guarantee)"
              : undefined,
          ].filter(Boolean).join("; ") || undefined;

          const batchOut: Record<string, unknown> = {
            mode: "slice",
            handle: batchData.handle,
            path: slicePath,
            total_lines: batchData.total_lines,
            segments: orderedSegments,
            ...(batchRemaining !== undefined ? { remaining_ranges: batchRemaining } : {}),
            ...(batchData.invalid_ranges ? { invalid_ranges: batchData.invalid_ranges } : {}),
            // B2d: once every deferred window turned out to be already held,
            // nothing is actually outstanding — do not keep claiming truncation.
            ...(batchData.truncated === true
              && (batchRemaining !== undefined
                || batchData.segments.some((segment) => segment.truncated === true))
              ? { truncated: true }
              : {}),
            ...(batchComposedNote ? { note: batchComposedNote } : {}),
            ...(batchNext !== undefined ? { next: batchNext } : {}),
            ...(batchData.concern_note !== undefined ? { concern_note: batchData.concern_note } : {}),
            ...(batchLedger !== undefined ? { served_range_ledger: batchLedger } : {}),
          };
          if (isMarkdownPath(slicePath) && batchData.truncated === true) {
            attachMarkdownHeadingIndex(batchOut, content);
          }
          return toolOk(attachSupply(batchOut, workspace));
        }

        // Subtract held source before a caller budget cuts the head again.
        // The fixed slice cap remains; the final emission funnel still owns
        // the caller's byte limit and settles only bytes that actually ship.
        let producerSliceBudget = sliceCallerBudgetBytes;
        const requestedSlice = resolvedSymbol === undefined && typeof resolvedRange === "string"
          ? parseLedgerRangeSpec(resolvedRange) : undefined;
        if (producerSliceBudget !== undefined && !forceContentServe && requestedSlice !== undefined) {
          const total = countLines(content);
          const [start, end] = requestedSlice;
          const whole = sliceLinesToText(content, start, Math.min(end, total));
          if (start <= total && Buffer.byteLength(whole, "utf8") <= READ_SYMBOL_CAP_BYTES) {
            const coverage = servedRangeCoverage(
              workspace, slicePath, shaOfText(content), total, undefined, effectiveKeepComments,
            );
            const held = (coverage?.served ?? [])
              .map(([a, b]) => [Math.max(a, start), Math.min(b, end)] as const)
              .filter(([a, b]) => b >= a);
            const missing = coverage?.unserved.some((window) => {
              const bounds = parseLedgerRangeSpec(window);
              return bounds !== undefined && bounds[0] <= end && bounds[1] >= start;
            }) === true;
            const saved = held.reduce((sum, [a, b]) =>
              sum + Buffer.byteLength(sliceLinesToText(content, a, b), "utf8"), 0);
            if (missing && held.length > 0 && saved > 512 + 140 * held.length) producerSliceBudget = undefined;
          }
        }
        const sliceResult = await resolveSlice(workspace, slicePath, content, resolvedSymbol, resolvedRange, producerSliceBudget);
        if (!sliceResult.ok) {
          // ND-1: a not-found selector serves nothing. (A cap-exceeded refusal
          // is a different thing entirely — the material EXISTS and is merely
          // too large — so it is deliberately not filed as a zero-byte call.)
          if (sliceResult.code === "not-found") noteZeroByteServe();
          if (sliceResult.capExceeded) {
            // dead at HEAD (see C2-6 audit): resolveSlice no longer sets
            // capExceeded — the branch that used to was converted to a
            // trimmed-head serve instead of refusing. Coded honestly for
            // the day a genuinely un-trimmable case reintroduces it.
            return toolStructuredError({ ok: false, code: "cap-exceeded", error: "cap-exceeded", ...sliceResult.details });
          }
          // R1 (2026-07-25): a doc file has headings, not symbols — answer
          // with the heading index + a sections call rather than the generic
          // candidates/skeleton shape (both empty for markdown), whose
          // fallback `next` was a whole-file re-read.
          if (sliceResult.code === "not-found" && isMarkdownPath(slicePath) && resolvedSymbol) {
            return toolStructuredError(markdownSymbolMissPayload({
              path: slicePath,
              symbol: resolvedSymbol,
              content,
            }));
          }
          // D1: symbol-not-found recovery passthrough — candidates/skeleton
          // survive instead of a bare toolError string. `path` + a derived
          // `next` (2026-07-16a bench forensics: refusal_without_next/
          // _handle) let the caller retry in one call instead of needing to
          // remember the path it already sent.
          //
          // 2026-07-30: the file resolved — only the symbol/range did not — so
          // hand back a whole-file handle (a RESOLVABLE locator, so the retry is
          // handle-addressed) plus a derived `next`. resolveSlice's own recovery
          // (`sliceResult.next`, e.g. a valid range derived from the real line
          // count for a range-invalid refusal) wins when present. When
          // `sliceResult.code` is ALSO absent, this is resolveSlice's bare
          // "symbol or range is required" refusal (replayCorpus rn2) — neither a
          // not-found nor a range-invalid miss, so there is nothing to derive a
          // mode=symbol/mode=skeleton hint FROM; `next` is left unset and
          // toolStructuredError's own supplyRefusalGuidance derivation fills in
          // the generic known-path fallback (`tl_read_file path=<path>`) from
          // `path` alone, exactly as it did before this handle/code/total_lines
          // enrichment existed.
          return toolStructuredError({
            ok: false,
            error: sliceResult.error,
            path: slicePath,
            handle: handleTable.upsert({
              kind: "file",
              path: slicePath,
              workspaceRoot: workspace,
              sha: shaOfText(content),
            }).id,
            ...(sliceResult.code ? { code: sliceResult.code } : {}),
            ...(sliceResult.total_lines !== undefined ? { total_lines: sliceResult.total_lines } : {}),
            ...(sliceResult.candidates ? { candidates: sliceResult.candidates } : {}),
            ...(sliceResult.skeleton ? { skeleton: sliceResult.skeleton } : {}),
            ...(sliceResult.next !== undefined
              ? { next: sliceResult.next }
              : sliceResult.code !== undefined
                ? {
                    next: sliceResult.candidates && sliceResult.candidates.length > 0
                      ? canonicalToolCall("tl_read_file", { mode: "symbol", path: slicePath, symbol: sliceResult.candidates[0] })
                      : canonicalToolCall("tl_read_file", { mode: "skeleton", path: slicePath }),
                  }
                : {}),
          });
        }
        // DESIGN-v0.8 §C3: comments elided by default (comments=keep escape);
        // sliceResult.data.sha is already computed from the RAW content
        // (resolveSlice), so it stays a valid content pin regardless.
        // C10.1: shorten the response sha — the handle minted in resolveSlice
        // keeps the full sha; this only shortens the DISPLAY value.
        // item 11: true file start line for the slice's elision markers —
        // EXCEPT when resolveSlice took the symbol branch (`assembled: true`),
        // whose `content` is getSymbolWithContext's ASSEMBLED view (preamble +
        // body); `range` there is only the body's file range and does not
        // describe content's own line numbering, so markers must stay
        // code-relative (startLine 1), mirroring mode=symbol's documented
        // exception (server.ts ~:7308).
        const sliceData = sliceResult.data;
        if (sliceData.assembled) {
          stageWindowReadRequest(workspace, slicePath, content, sliceData.range, effectiveKeepComments);
        }
        // F1 (2026-08-02 serve-honesty): the display text is composed HERE,
        // ABOVE the ledger, because the ledger must book what the wire carries
        // and not what was asked for. This is a MOVE of the composition that
        // used to sit just below the ledger block (its rationale, C2, is kept
        // verbatim at the serve site) — not a second elision pass.
        const sliceDisplay = effectiveKeepComments
          ? { content: sliceData.content, note: undefined as string | undefined, elided: [] as Array<[number, number]> }
          : sliceData.assembled
            ? elideSymbolContextForDisplay(sliceData.content, languageForPath(slicePath))
            : callerNamedWindows
              ? elideDocCommentsForExplicitWindow(sliceData.content, languageForPath(slicePath), rangeStartLine(sliceData.range), countLines(content))
              : elideDocCommentsForDisplay(
                sliceData.content,
                languageForPath(slicePath),
                false,
                rangeStartLine(sliceData.range),
              );
        // ND-4 (2026-08-08 serve honesty): this window put ZERO file lines on
        // the wire — the fully-past-EOF case L5 answers with the 253 B
        // {content:"", the FILE's real sha, total_lines, note} shape, or a
        // genuinely empty file. Either way the call serves no bytes, so a
        // later byte-identical repeat must be re-served rather than answered
        // with "its bytes are already in your context". Measured live at
        // 67da02c2: `mode=slice path=include/ctl/types.hpp range=900-950`
        // three times over produced exactly that claim, about a window that
        // never overlapped the file. The symbol branch (`assembled`) is
        // excluded — an empty symbol body is not an empty window — and it
        // files its own verdict at the not-found return above.
        if (sliceData.assembled !== true && sliceData.content.length === 0) noteZeroByteServe();

        // W-WIRE-2A (W-LEDGER): decide coverage for this RESOLVED window
        // BEFORE this call's own recordServedRange loop (below) mutates the
        // ledger — coverageReceiptFor's honesty contract is "bytes previously
        // served in this lane+workspace at the same content sha", which means
        // deciding against the ledger as it stood when the request arrived,
        // not as it stands after this response is booked.
        // TL_RECEIPT_COVERAGE still gates the optional covered_by projection.
        // Ordinary partial-overlap reads can use the shared difference builder
        // without that flag when saved source outweighs the prior-entry cost;
        // only exact current-file coverage is eligible.
        //
        // `kind:"full"` needs no branch here: it means the WHOLE resolved
        // window was already covered, which is exactly what the EXISTING
        // addedLines===0 receipt below already detects (recordServedRange's
        // own added_lines against the same ledger) — this verdict is reused
        // there only to add `covered_by` to that receipt, never to re-decide it.
        let sliceCoverageVerdict: CoverageVerdict | undefined;
        if (
          sliceData.assembled !== true
          && sliceData.content.length > 0
          && !forceContentServe
        ) {
          const coverageSha = shaOfText(content);
          const coverageTotalLines = countLines(content);
          const coverageStart = rangeStartLine(sliceData.range);
          const coverageEnd = Math.min(
            coverageTotalLines,
            (sliceData.remaining_ranges === undefined ? rangeEndLine(sliceData.range) : undefined)
              ?? (coverageStart + countLines(sliceData.content) - 1),
          );
          if (receiptCoverageEnabled()) {
            sliceCoverageVerdict = coverageReceiptFor({
              workspace,
              path: slicePath,
              sha: coverageSha,
              totalLines: coverageTotalLines,
              want: "range",
              start: coverageStart,
              end: coverageEnd,
              forceServe: args["force_serve"] === true,
            });
          }
          // PARTIAL: some of the resolved window is already resident. Narrow
          // the wire to the uncovered remainder using the SAME segments/prior
          // builder mode=full/symbol already ship (buildLedgerDifferenceFullPayload,
          // B2/V12-02, unflagged there) — reused rather than re-implemented, so
          // a covered span is marked `code_unchanged`+`served_by` (readFamily.ts's
          // `textEvidence` already projects that to `Evidence.prior`) and only
          // the fresh span's bytes go on the wire.
          //
          // R11 A-4 (independent review, 2026-09-03): `sliceData.remaining_ranges`
          // mirrors the guard the `addedLines === 0` receipt below already
          // applies (W2A-1) — when the RESOLVED window itself was capped by the
          // byte-cap ABOVE this coverage decision, the caller's ORIGINAL request
          // reaches further than `sliceData` describes, and `difference` below
          // carries no `remaining_ranges`/`next` of its own. Taking this
          // short-circuit anyway would silently drop that disclosure — the
          // exact defect W2A-1 fixed for the sibling `code_unchanged` receipt,
          // reached here through the partial-coverage door instead. Falling
          // through instead re-enters the normal slice response below, which
          // already composes `remaining_ranges`/`next` correctly for a
          // truncated `sliceData`.
          const priorCoverage = servedRangeCoverage(
            workspace, slicePath, coverageSha, coverageTotalLines,
            sliceDisplay.elided, effectiveKeepComments,
          );
          const heldWindows = (priorCoverage?.served ?? [])
            .map(([start, end]) => [Math.max(start, coverageStart), Math.min(end, coverageEnd)] as const)
            .filter(([start, end]) => end >= start);
          const hasUnservedWindow = priorCoverage?.unserved.some((window) => {
            const bounds = parseLedgerRangeSpec(window);
            return bounds !== undefined && bounds[0] <= coverageEnd && bounds[1] >= coverageStart;
          }) === true;
          // Widening a window must identify held lines even when the overlap
          // is small. Otherwise the response silently resends prior source.
          if (heldWindows.length > 0 && hasUnservedWindow
            && sliceData.remaining_ranges === undefined) {
            const difference = buildLedgerDifferenceFullPayload({
              workspace,
              filePath: slicePath,
              content,
              handleId: sliceData.handle,
              sha: coverageSha,
              keepComments: effectiveKeepComments,
              mode: "slice",
              range: [coverageStart, coverageEnd],
              priorCoverage,
              policyElided: sliceDisplay.elided,
            });
            if (
              difference !== undefined
              && Array.isArray(difference["segments"])
              && (difference["segments"] as Array<Record<string, unknown>>)
                .some((segment) => segment["code_unchanged"] === true)
            ) {
              recordReadPath(workspace, slicePath);
              const differenceNote = [sliceData.note, difference["note"]]
                .filter((value): value is string => typeof value === "string" && value.length > 0).join("; ");
              return toolOk(attachSupply({
                ...difference,
                ...(differenceNote !== "" ? { note: differenceNote } : {}),
                ...(sliceData.concern_note !== undefined
                  ? { concern_note: sliceData.concern_note }
                  : {}),
              }, workspace));
            }
          }
        }

        let rangeLedger: ServedRangeLedgerReceipt | undefined;
        let rangeServedBy: string | undefined;
        if (
          sliceData.assembled !== true
          && sliceData.content.length > 0
        ) {
          const rawFileSha = shaOfText(content);
          const actualStart = rangeStartLine(sliceData.range);
          // P2-15 (round-4 evaluation, 2026-09-28): when this slice was NOT
          // capped (`remaining_ranges` undefined — the same signal the
          // code-unchanged gate below already keys on), `sliceData.range`'s
          // own declared end is trustworthy — resolveSlice returned exactly
          // the requested window verbatim, so it is authoritative over a
          // content-length GUESS that cannot tell "N real lines with an
          // ordinary trailing newline" apart from "N+1 lines whose LAST one
          // is blank" (both `["...", "...", ""].join("\n")` and
          // `["...", "..."].join("\n") + "\n"` produce the identical string,
          // so `countLines` undercounts by exactly one whenever the slice's
          // last requested line is blank). Live repro: a `range:"3-6"`
          // request over `export interface ClientOptions {\n...\n}\n\n` (line
          // 6 blank) resolved `sliceData.content` to 3 real lines; the OLD
          // content-length `actualEnd` came out to 5, so the booking/
          // code-unchanged check below never examined line 6 AT ALL, yet the
          // eventual `read.receipt` answered for the caller's full "3-6" ask.
          // A genuinely CAPPED slice (`remaining_ranges` defined) still falls
          // back to the content-length value below exactly as before this
          // fix (W2A-1's own reasoning, unchanged) — trusting the nominal end
          // there would OVER-claim coverage for bytes the cap never served.
          const nominalEnd = sliceData.remaining_ranges === undefined
            ? rangeEndLine(sliceData.range)
            : undefined;
          const actualEnd = Math.min(
            countLines(content),
            nominalEnd ?? (actualStart + countLines(sliceData.content) - 1),
          );
          // 2026-10-20 (decision run 6t-7): the comment lines a receipt for
          // this window would withhold, judged before this call books anything.
          const sliceComments = forceContentServe || sliceData.remaining_ranges !== undefined
            ? undefined
            : sliceReceiptCommentWindows({
                workspace, filePath: slicePath, sha: rawFileSha, totalLines: countLines(content),
                start: actualStart, end: actualEnd, rendererElided: sliceDisplay.elided, keepComments: effectiveKeepComments,
              });
          const commentsServed = sliceComments?.kind === "serve"
            ? serveSliceCommentWindows({
                workspace, filePath: slicePath, content, handleId: sliceData.handle, sha: rawFileSha,
                start: actualStart, end: actualEnd, windows: sliceComments.windows, concernNote: sliceData.concern_note,
              })
            : undefined;
          if (commentsServed !== undefined) return commentsServed;
          // F1: an elided comment block inside this window never reaches the
          // caller, so it must not be booked. Recording LESS costs at most one
          // redundant re-serve; recording more hands out a receipt for bytes
          // nobody received. FX-W3 (ruling (aa)): the surviving spans come
          // from the renderer's own `sliceDisplay.elided` accounting, not from
          // re-parsing `sliceDisplay.content`.
          const servedSpans = spansExcludingWindows(
            actualStart,
            actualEnd,
            sliceDisplay.elided,
          );
          // F3: probe the provenance BEFORE recording, so the label can never
          // name this very response.
          for (const [spanStart, spanEnd] of servedSpans) {
            rangeServedBy = servedRangeReceipt(
              workspace, slicePath, rawFileSha, spanStart, spanEnd, countLines(content),
            )?.served_by;
            if (rangeServedBy !== undefined) break;
          }
          const sliceCall = beginServeCall(workspace);
          let addedLines = 0;
          for (const [spanStart, spanEnd] of servedSpans) {
            rangeLedger = recordServedRange(
              workspace,
              slicePath,
              rawFileSha,
              spanStart,
              spanEnd,
              countLines(content),
              { mode: "slice", range: String(sliceData.range), call: sliceCall },
            );
            addedLines += rangeLedger.added_lines;
          }
          noteZoomServedForAnswerEpoch(sliceData.handle, { sha: rawFileSha, spans: servedSpans });
          // A content-hash-bound range that has already been served carries no
          // new evidence. Return only the receipt instead of charging for the
          // same bytes again. The request still costs a turn; the ledger's
          // purpose is byte/churn reduction, not a claim that turns disappear.
          //
          // W1 (2026-07-30 post-ready re-read forensics): `added_lines === 0`
          // IS the qualification — recordServedRange computes it against the
          // ranges already served for THIS EXACT sha, so it means "every line
          // asked for was already served and the file has not changed since".
          // That covers both qualifying shapes (an exact-handle re-serve, and a
          // narrower range fully subsumed by an earlier wider serve) and
          // excludes partial overlap, which adds lines and serves normally.
          // The earlier gate additionally required handle= plus a caller range
          // matching the handle's stored range, which restricted the receipt to
          // the single narrowest case and left every path-addressed and
          // subsumed re-read paying full price.
          //
          // F1 note: `addedLines` is now summed over the spans the DISPLAY
          // carries, so "added nothing" means "every line this response would
          // actually put on the wire is already held" — elided lines are
          // neither claimed nor required.
          //
          // W2A-1 (2026-08-21 serve-honesty): `sliceData.range`/`.content` are
          // already CLAMPED by resolveSlice/centeredSliceForCap when the
          // caller's requested range is bigger than one serve's byte cap —
          // `sliceData.remaining_ranges` is where the uncovered TAIL of the
          // original request lives (`centeredSliceForCap`'s own doc comment:
          // "report the uncovered spans of the ORIGINAL range as
          // remaining_ranges"). `addedLines === 0` only proves the CLAMPED
          // prefix was already held; it says nothing about that tail. Live
          // repro: `range=587-8119` on a 21k-line file, clamped to 587-1104 by
          // an earlier call, addedLines 0 on the immediate re-ask — without
          // this guard the code-unchanged receipt below named `range:
          // sliceData.range` ("587-1104") but was returned FOR the caller's
          // "587-8119" ask, with no `remaining`/`next` disclosing that lines
          // 1105-8119 (the majority of the request) were never served or even
          // examined. Falling through instead re-enters the normal slice
          // response below, which already composes `remaining_ranges`/`next`
          // correctly for a truncated `sliceData` (proven by the SAME request
          // on virgin ledger state, a few lines down).
          if (
            rangeLedger !== undefined
            && addedLines === 0
            && !forceContentServe
            && sliceData.remaining_ranges === undefined
            && sliceComments?.kind !== "withhold"
          ) {
            // W-WIRE-2A: `sliceCoverageVerdict` was decided pre-mutation, above,
            // against the identical (workspace,path,sha,window) identity this
            // receipt now confirms fully covered — reused only to ADD `covered_by`
            // to an already-correct receipt, never to re-decide whether one fires.
            // `coveredByField` returns undefined on `kind:"none"` (flag off, or
            // any of coverageReceiptFor's other miss reasons), so this is a no-op
            // extension whenever the verdict did not independently agree.
            const coveredBy = sliceCoverageVerdict !== undefined
              ? coveredByField(sliceCoverageVerdict)
              : undefined;
            // NOTE: the lookup key is `rawFileSha` (this branch's own
            // ledger-facing whole-file sha, the SAME value `rangeLedger`/
            // `rangeServedBy` above were computed against — see this
            // function's `const rawFileSha = shaOfText(content)`), NOT
            // `sliceData.sha`: `resolveSlice`'s own `.sha` can diverge from
            // the file's CURRENT content hash (observed live while
            // implementing R4 — a plain path+range re-read of a page the
            // parent's cursor had already served came back with a DIFFERENT
            // `sliceData.sha` than `shaOfText(content)`/`rawFileSha` for the
            // identical, unchanged file), which would make an open-parent
            // lookup keyed on it spuriously miss every time.
            const sliceParentContinuation = openParentReceiptContinuation(
              workspace, slicePath, rawFileSha, args,
              parseWindows(sliceData.range.split(",")),
            );
            const sliceCommentsNext = sliceComments?.kind === "next"
              ? canonicalToolCall("tl_read_file", {
                  targets: [{
                    handle: handleTable.upsert({ kind: "file", path: slicePath, workspaceRoot: workspace, sha: rawFileSha }).id,
                    ranges: sliceComments.windows.map(([start, end]) => `${start}-${end}`),
                  }],
                  select: { comments: "keep" },
                })
              : undefined;
            return toolOk(attachSupply(servedContentReceipt({
              mode: "slice",
              handle: sliceData.handle,
              path: slicePath,
              range: sliceData.range,
              sha: shortSha(sliceData.sha),
              ledger: rangeLedger,
              ...(rangeServedBy !== undefined ? { servedBy: rangeServedBy } : {}),
              ...(sliceParentContinuation !== undefined ? { parentContinuation: sliceParentContinuation } : {}),
              ...(sliceCommentsNext !== undefined ? { commentsContinuation: sliceCommentsNext } : {}),
              extra: {
                served_range_ledger: rangeLedger,
                ...(coveredBy !== undefined ? { covered_by: coveredBy } : {}),
                // B2d (2026-08-01 serving-completeness): a receipt replaces the
                // BYTES, never the guidance. The out-of-slice concern guard is
                // one-shot per (session,path) — dropping it here would silently
                // consume the only warning the caller gets. This became
                // reachable when pack-served ranges started landing in the
                // ledger (the pack may have served exactly this window).
                ...(sliceData.concern_note !== undefined
                  ? { concern_note: sliceData.concern_note }
                  : {}),
              },
              workspace,
            }), workspace));
          }
        }
        // C2 (2026-07-24): serve the slice through elideDocCommentsForDisplay —
        // the SAME empty-elision guard mode=full and mode=small_file already
        // use — instead of the raw elideDocComments. A slice whose ENTIRE range
        // is one multi-line doc/comment block used to collapse to a lone
        // "/* doc elided L.. */" marker while claiming ok:true+truncated:false
        // (a content-free serve). The display helper falls back to RAW content
        // plus an explanatory note in exactly that case, and returns identical
        // output to elideDocComments for every non-empty slice — so the agent
        // never has to spend a comments=keep round trip to see content that was
        // already computed. resolveSlice no longer manufactures that round-trip
        // hint (readCodeModes.ts) now that the serve self-heals here.
        // (`sliceDisplay` itself is composed ABOVE the served-range ledger — see
        // the F1 note there; this comment stays with the serve it explains.)
        const sliceComposedNote = [
          // C3 self-heal note: a re-slice whose handle had expired is served
          // directly by its recovered path rather than refused (see the
          // handle-resolution block above).
          staleHandleReresolved ? `handle ${staleHandleReresolved} was no longer live; re-resolved by path=${slicePath}` : undefined,
          sliceData.note,
          sliceDisplay.note,
          elisionMarkerNote(sliceDisplay.content),
          // SHOULD-FIX 57 (AB1, round 11): round 10 measured this exact route
          // serving a 299-character stripped body under `sha:"sha256:e0bd92dab9a3"`
          // with NO note at all. The strip is now stated wherever it happens.
          nulStrippedNoteText(sliceVerdict),
        ].filter(Boolean).join("; ") || undefined;
        const sliceOut: Record<string, unknown> = {
          ...sliceData,
          sha: shortSha(sliceData.sha),
          content: sliceDisplay.content,
          ...(sliceComposedNote ? { note: sliceComposedNote } : {}),
        };

        // DESIGN-v0.9 §4.6a same-handle slice continuation: when the RANGE
        // branch truncated at the byte cap, the follow-up is a deterministic
        // same-handle window over content already in `content` (this dispatch's
        // full-file read) — serve ONE extra window inline (bounded by the §4.8
        // must-fetch budget) and advance `next` past it, stamping
        // inlined:["slice-cont:<handle>"]. Excludes the SYMBOL-assembled branch
        // (assembled:true), whose `content` is a preamble+body view, not clean
        // file lines — its `next` re-reads the whole symbol range through THIS
        // very branch, which then continues cleanly. With TL_MUSTFETCH_EXPAND
        // off the head already fills the base cap, so nothing inlines.
        if (sliceData.assembled !== true && sliceData.truncated === true) {
          const cont = computeSliceContinuation(
            content, String(sliceData.range), sliceData.content, String(sliceData.handle),
            keepComments, languageForPath(slicePath),
          );
          if (cont) {
            // `cont.continued.elided` is FX-W3's own record-time accounting —
            // internal, never put on the wire (wire bytes are pinned).
            sliceOut["continued"] = { range: cont.continued.range, content: cont.continued.content };
            sliceOut["inlined"] = [`slice-cont:${sliceData.handle}`];
            if (rangeLedger !== undefined) {
              // F1 (2026-08-02 serve-honesty): `cont.continued.content` is
              // ALREADY the display text (computeSliceContinuation elides it),
              // so counting its lines as raw file lines both under-ran the
              // window's true end AND mis-attributed the lines it did claim to
              // the elided block. Book the renderer-accounted spans instead —
              // FX-W3 (ruling (aa)): from `cont.continued.elided`, not a
              // re-parse of `cont.continued.content`.
              const continuedStart = rangeStartLine(cont.continued.range);
              // The range string's own end is TRUE FILE coordinates
              // (`computeSliceContinuation` derives it from the RAW window
              // before elision, not from the display text's line count).
              const continuedEndMatch = cont.continued.range.match(/^(\d+)-(\d+)$/);
              const continuedEnd = continuedEndMatch ? Number(continuedEndMatch[2]) : continuedStart;
              const continuedCall = beginServeCall(workspace);
              for (const [spanStart, spanEnd] of spansExcludingWindows(
                continuedStart, continuedEnd, cont.continued.elided,
              )) {
                rangeLedger = recordServedRange(
                  workspace,
                  slicePath,
                  shaOfText(content),
                  spanStart,
                  spanEnd,
                  countLines(content),
                  { mode: "slice-cont", range: String(cont.continued.range), call: continuedCall },
                );
              }
            }
            if (cont.next !== undefined) sliceOut["next"] = cont.next;
            else delete sliceOut["next"];
          }
        }

        // R1 (2026-07-25): a markdown slice is the classic partial doc
        // surface — the solver holds lines A-B of a long doc and has no way
        // to name where anything else lives. Carry the heading index (the
        // served window first when the cap bites) plus the sections
        // instruction; skipped when the slice already covers the whole file.
        if (isMarkdownPath(slicePath)) {
          const sliceStart = rangeStartLine(String(sliceData.range));
          const sliceEnd = sliceStart + Math.max(0, countLines(String(sliceData.content)) - 1);
          if (sliceStart > 1 || sliceEnd < countLines(content) || sliceData.truncated === true) {
            attachMarkdownHeadingIndex(sliceOut, content, { start: sliceStart, end: sliceEnd });
          }
        }

        // W-BATCH-HINT (a)+(c): attach the one-shot serial-slice hint (naming
        // whatever this session already held for slicePath — ledger-confirmed
        // declared spans folded in) and/or the ledger truncation note, on
        // ONLY this ordinary (non-receipt, non-ranges-batch) slice serve —
        // the early receipt/continuation/markdown returns above are
        // untouched. Both are additive to sliceOut; sliceOut's own `note`
        // (staleHandleReresolved/elision/etc., composed above) is preserved
        // and extended with the SAME "; "-join idiom that composed it.
        const readBatchHintAlreadyHeld = [...new Set([...readBatchHintHeldBefore, ...readLedgerConfirmed])];
        const readBatchHintOut: Record<string, unknown> = readBatchHintClustersBefore === 1
          ? { ...sliceOut, hint: composeReadBatchHint(readBatchHintAlreadyHeld) }
          : sliceOut;
        const readBatchHintFinal: Record<string, unknown> = readLedger.truncatedNote !== undefined
          ? {
              ...readBatchHintOut,
              note: [readBatchHintOut["note"], readLedger.truncatedNote].filter(Boolean).join("; "),
            }
          : readBatchHintOut;
        return toolOk(attachSupply(readBatchHintFinal, workspace));
      }
  return undefined;
}
