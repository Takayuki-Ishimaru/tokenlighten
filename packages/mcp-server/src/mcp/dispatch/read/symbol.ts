import type { ToolCallResult } from "../../../protocol/result.js";
import { toolError, toolStructuredError, toolOk } from "../../../protocol/result.js";
import { getSymbolWithContext, elideSymbolContextForDisplay } from "../../../tools/getSymbolWithContext.js";
import { isMarkdownPath } from "../../../util/markdownSections.js";
import { handleTable, shaOfText, shortSha } from "../../../util/handles.js";
import { canonicalToolCall, noteServeAttribution } from "../../../protocol/envelope.js";
import { countLines } from "../../../util/countLines.js";
import { servedRangeReceipt, noteSymbolWindow, recordReadPath, servedRangeCoverage, beginServeCall, recordServedRange } from "../../../state/session.js";
import { elideDocCommentsWithWindows, spansExcludingWindows } from "../../../util/formatCompress.js";
import { languageForPath } from "../../../util/languages.js";
import { attachSupply } from "../../../util/attachSupply.js";
import { TINY_BYTES, TINY_LINES } from "../../../util/fullGovernor.js";
import { READ_SYMBOL_CAP_BYTES } from "../../../tools/readCodeModes.js";
import { deltaContextEnabled } from "../../../util/flags.js";
import { markdownSymbolMissPayload } from "../../../serverOwned/read-admission2.js";
import { openParentReceiptContinuation } from "../../../serverOwned/canonical-input3.js";
import { servedContentReceipt, buildSymbolDowngradePayload, deltaContextDecision, buildLedgerDifferenceFullPayload } from "../../../serverOwned/read-receipts.js";
import { stageWindowReadRequest } from "../../../serverOwned/canonical-input.js";

export interface read_symbolPort {
  "mode": string;
  "symbolArg": string;
  "content": string;
  "filePath": string;
  "noteZeroByteServe": () => void;
  "workspace": string;
  "forceContentServe": boolean;
  "keepComments": boolean;
  "args": Record<string, unknown>;
}
export async function read_symbol(port: read_symbolPort): Promise<ToolCallResult | undefined> {
  const { mode, symbolArg, content, filePath, noteZeroByteServe, workspace, forceContentServe, keepComments, args } = port;
if (mode === "symbol" || (mode === "auto" && symbolArg)) {
        if (!symbolArg) return toolError("symbol is required for mode=symbol", { code: "invalid-input" });
        const result = await getSymbolWithContext(content, { path: filePath, symbol: symbolArg });
        if (!result.ok) {
          // ND-1 (2026-08-08 serve honesty): the symbol does not exist, so this
          // call put no file bytes on the wire. Measured live at 67da02c2
          // without this verdict: calls 1 and 2 answered with the 395 B
          // not-found (candidates + skeleton + next), and the 3rd IDENTICAL
          // call was answered from the FILE-level ledger with a 408 B
          // {ok:true, reason:"already-served", windows:[{range:"1-41"}]} — a
          // receipt asserting that a symbol that does not exist is already in
          // the caller's context, and one that cost MORE than re-serving the
          // miss it replaced.
          noteZeroByteServe();
          // R1 (2026-07-25): doc backstop. The markdown route above normally
          // catches this call first; this covers the paths it deliberately
          // does not claim (e.g. symbol + explicit range on a .md) so a doc
          // symbol-miss can never fall back to the whole-file `next` again.
          if (isMarkdownPath(filePath)) {
            return toolStructuredError(markdownSymbolMissPayload({
              path: filePath,
              symbol: symbolArg,
              content,
            }));
          }
          // D1: symbol-not-found recovery passthrough — candidates/skeleton
          // survive instead of a bare toolError string. `path` + a derived
          // `next` (2026-07-16a bench forensics: refusal_without_next/
          // _handle) let the caller retry in one call instead of needing to
          // remember the path it already sent.
          //
          // 2026-07-30: the file itself resolved fine — only the symbol name
          // missed — so mint a whole-file handle and hand it back. That makes
          // the refusal HANDLE-CARRYING: the retry addresses the file by handle
          // instead of re-sending a path, and `next` is now unconditional (a
          // miss with no lexical candidates falls back to the skeleton, which
          // names every symbol the file actually has).
          return toolStructuredError({
            ok: false,
            error: result.error,
            code: result.code,
            path: filePath,
            handle: handleTable.upsert({
              kind: "file",
              path: filePath,
              workspaceRoot: workspace,
              sha: shaOfText(content),
            }).id,
            ...(result.candidates ? { candidates: result.candidates } : {}),
            ...(result.skeleton ? { skeleton: result.skeleton } : {}),
            next: result.candidates && result.candidates.length > 0
              ? canonicalToolCall("tl_read_file", { mode: "symbol", path: filePath, symbol: result.candidates[0] })
              : canonicalToolCall("tl_read_file", { mode: "skeleton", path: filePath }),
          });
        }
        // W1 served-content receipt: this session already served every file
        // line this symbol spans, at this exact sha. Re-assembling the same
        // window buys the caller nothing it does not already hold — answer with
        // the compact receipt (allowFull:true/force_serve:true force the
        // bytes; DESIGN-v0.15 §6.3 (R6) — content:"full" alone no longer does).
        if (!forceContentServe) {
          const symFileSha = shaOfText(content);
          const symTotalLines = countLines(content);
          const symLedger = servedRangeReceipt(
            workspace,
            filePath,
            symFileSha,
            result.data.range.start,
            result.data.range.end,
            symTotalLines,
            keepComments ? undefined : elideDocCommentsWithWindows(content, languageForPath(filePath), 1).elided,
          );
          if (symLedger !== undefined) {
            // §20.26: what a repeat of this read denotes, for the loop brake.
            noteSymbolWindow(workspace, filePath, symFileSha, symbolArg, result.data.range.start, result.data.range.end);
            const symRangeStr = `${result.data.range.start}-${result.data.range.end}`;
            const symHandle = handleTable.upsert({
              kind: "symbol",
              path: filePath,
              range: symRangeStr,
              symbol: symbolArg,
              workspaceRoot: workspace,
              sha: shaOfText(result.data.code),
            });
            recordReadPath(workspace, filePath);
            const symParentContinuation = openParentReceiptContinuation(
              workspace, filePath, symFileSha, args,
              [{ start: result.data.range.start, end: result.data.range.end }],
            );
            return toolOk(attachSupply(servedContentReceipt({
              mode: "symbol",
              path: filePath,
              handle: symHandle.id,
              sha: shortSha(symFileSha),
              range: symRangeStr,
              symbol: symbolArg,
              ledger: symLedger,
              workspace,
              ...(symParentContinuation !== undefined ? { parentContinuation: symParentContinuation } : {}),
            }), workspace));
          }
        }
        // The wire budget may shrink the producer's symbol prefix again.
        // Stage the entire resolved symbol so continuation is computed from
        // the final served lines, including any lines shed after projection.
        stageWindowReadRequest(workspace, filePath, content,
          `${result.data.range.start}-${result.data.range.end}`, keepComments);
        const symbolBytes = Buffer.byteLength(result.data.code, "utf8");
        // Augment with handle + sha (C.6). DESIGN-v0.8 §C3: sha/handle are
        // minted from the RAW (unelided) code — elision only ever changes
        // the display `code` field below, never the content a handle pins
        // or an edit precondition re-reads from disk.
        //
        // DESIGN-v0.8 B4.1: for a file at/below the small-file (TINY)
        // threshold, mint a WHOLE-FILE (1-EOF) handle instead of pinning just
        // the symbol's own range. A range-replace scoped to only the
        // symbol's range risks leaving an orphan tail elsewhere in a tiny
        // file untouched (a live case: a 13-line stub's handle covered only lines
        // 1-11, and a full-stub replace via that handle left a dangling
        // docstring close outside the range — a syntax error). A tiny file
        // is cheap enough that the caller should just get a handle to the
        // WHOLE file to edit against.
        //
        // kind:"range" (not kind:"file"): edit_code's {handle, content}
        // range-content-replace branch (below, further in this function)
        // only activates when the driving handle HAS a `range` field
        // (`handleId && handleRange && ...`) — a bare kind:"file" handle
        // (no range) falls through to the whole-file EXACT search/replace
        // path instead, which rejects an empty `search` on an existing file
        // (code "empty-search") and therefore can never actually be used
        // for the "replace with this whole new body" pattern this fix
        // exists to enable. A 1-N range handle is the form that is already
        // wired up end-to-end (range-content-replace, target=all,
        // B4.2's orphan-tail check, B3.3's refreshSha line-shift on a
        // follow-up edit) — literally "1-EOF" per the design text.
        //
        // The `sha` in the response always matches whatever the returned
        // `handle` is pinned to — a symbol handle's sha over
        // `result.data.code`, or (tiny-file case) a 1-EOF range handle's
        // sha over the FULL file content — so a follow-up expected-hash
        // precondition using this response's `sha` is valid for the handle
        // actually returned.
        // BUG FIX (bench transcript forensics): was
        // content.split(/\r?\n/).length, which counts a phantom final
        // segment for trailing-newline content (nearly every file) — e.g. a
        // 183-line file counted as 184, minting a "1-184" handle that
        // edit_code's bounds check (which correctly counts logical lines)
        // then rejected as out of bounds for a 183-line file. countLines()
        // is trailing-newline aware and matches that bounds check exactly
        // (see util/countLines.ts).
        const symbolFileLineCount = countLines(content);
        const symbolFileBytes = Buffer.byteLength(content, "utf8");
        const symbolFileIsTiny = symbolFileBytes <= TINY_BYTES && symbolFileLineCount <= TINY_LINES;
        const sha = symbolFileIsTiny ? shaOfText(content) : shaOfText(result.data.code);
        const hEntry = handleTable.upsert(
          symbolFileIsTiny
            ? { kind: "range", path: filePath, range: `1-${symbolFileLineCount}`, workspaceRoot: workspace, sha }
            : {
                kind: "symbol",
                path: filePath,
                range: `${result.data.range.start}-${result.data.range.end}`,
                symbol: symbolArg,
                workspaceRoot: workspace,
                sha,
              },
        );
        // C10.2: scopeHeader is dropped here — it is ALREADY the first line
        // of result.data.code (getSymbolWithContext.ts builds `code` as
        // `[scopeHeader, ...].join("\n")`), so returning it again as a
        // sibling field is pure duplication. destructure it out of the
        // spread instead of letting it ride along.
        // C10.1: sha is shortened for the response; the handle above was
        // minted on the full sha.
        const { scopeHeader: _scopeHeader, ...symbolDataWithoutScopeHeader } = result.data;
        // item 11: NO file-startLine is passed here (default 1) — unlike a
        // mode=slice/handles line slice, mode=symbol's `code` is an ASSEMBLED
        // view (scopeHeader, used-imports, enclosing/sibling signatures, a
        // `target:` marker, then the body — see getSymbolWithContext.ts), whose
        // preamble length varies, so there is no single file line offset that
        // maps `code` lines to file lines. Markers here stay code-relative.
        // The preamble and the target are elided as two texts
        // (`elideSymbolContextForDisplay`): a half-open block in the preamble
        // must not pair with the target's own delimiters.
        const symbolCode = keepComments
          ? symbolDataWithoutScopeHeader.code
          : elideSymbolContextForDisplay(symbolDataWithoutScopeHeader.code, languageForPath(filePath)).content;

        // FIX C (2026-07-12c forensics): a symbol body over
        // READ_SYMBOL_CAP_BYTES now serves a TRIMMED downgrade instead of a
        // bare refusal — see buildSymbolDowngradePayload's doc comment above
        // (near buildFullDowngradePayload) for the full rationale; mirrors
        // mode=full's downgraded_from:"full" precedent.
        if (symbolBytes > READ_SYMBOL_CAP_BYTES) {
          const downgraded = buildSymbolDowngradePayload({
            filePath,
            symbolName: symbolArg,
            language: symbolDataWithoutScopeHeader.language,
            range: result.data.range,
            sourceContent: content,
            keepComments,
            handleId: hEntry.id,
            sha: shortSha(sha),
            bytes: symbolBytes,
            maxBytes: READ_SYMBOL_CAP_BYTES,
          });
          if (downgraded) {
            recordReadPath(workspace, filePath);
            return toolOk(attachSupply(downgraded, workspace));
          }
          // Pathological: even a minimally-trimmed serve cannot fit within
          // cap (see buildSymbolDowngradePayload's doc comment) — keep the
          // hard refusal as the last resort.
          return toolStructuredError({
            ok: false,
            code: "cap-exceeded",
            error: "cap-exceeded",
            path: filePath,
            symbol: symbolArg,
            bytes: symbolBytes,
            maxBytes: READ_SYMBOL_CAP_BYTES,
            range: result.data.range,
            suggest: "tl_read_file mode=pack with a narrower range",
          });
        }

        // B2 / V12-02: a symbol read of a file whose ledger survived a server
        // edit takes the SAME already-shipped difference projection W7 uses.
        // The two levers stay independent by construction: W7's branch reads
        // its own flag and any coverage, the delta branch requires a
        // `deltaFromSha`-marked entry (`deltaContextDecision`) that only a
        // server-applied edit can mint, and force_serve bypasses both.
        const symbolDelta = forceContentServe || !deltaContextEnabled()
          ? undefined
          : deltaContextDecision({
              workspace,
              filePath,
              content,
              sha: shaOfText(content),
              totalLines: symbolFileLineCount,
              range: [result.data.range.start, result.data.range.end],
            });
        if (
          symbolDelta?.decision === "delta"
          && !forceContentServe
        ) {
          const symbolFileSha = shaOfText(content);
          const symbolCoverage = symbolDelta?.coverage ?? servedRangeCoverage(
            workspace, filePath, symbolFileSha, symbolFileLineCount,
          );
          if (symbolCoverage !== undefined && !symbolCoverage.complete) {
            const difference = buildLedgerDifferenceFullPayload({
              workspace,
              filePath,
              content,
              handleId: hEntry.id,
              sha: symbolFileSha,
              keepComments,
              mode: "symbol",
              range: [result.data.range.start, result.data.range.end],
              priorCoverage: symbolCoverage,
            });
            if (difference !== undefined
              && (difference["segments"] as Array<Record<string, unknown>>)
                .some((segment) => segment["code_unchanged"] === true)) {
              recordReadPath(workspace, filePath);
              return toolOk(attachSupply({ ...difference, symbol: symbolArg }, workspace));
            }
          }
        }

        // Feature 1 (2026-07-12b2): successful standalone mode=symbol serve.
        recordReadPath(workspace, filePath);
        // W1: the symbol's file lines are now resident — record them so a later
        // read of the same window answers with a receipt.
        //
        // F1 (2026-08-02 serve-honesty): booking the whole symbol range was the
        // shape behind the decisive live report — a `code_unchanged` receipt for
        // score_run's 139 lines when only 4 had ever been served. mode=symbol's
        // `code` is an ASSEMBLED view (scopeHeader + imports + signatures +
        // target marker + body) whose lines do NOT map to file lines, so the
        // served file lines are modelled by running the SAME elider over the
        // symbol's own file-line window. For a doc block wholly inside the body
        // — the case that matters — the two agree exactly.
        {
          const symStart = result.data.range.start;
          const symTotalLines = countLines(content);
          const symEnd = Math.min(result.data.range.end, symTotalLines);
          const symBodyRaw = content.split(/\r?\n/).slice(symStart - 1, symEnd).join("\n");
          // FX-W3 (ruling (aa)): renderer-accounted spans, not a re-parse of
          // the modeled display text.
          const symBodyElided = keepComments
            ? []
            : elideDocCommentsWithWindows(symBodyRaw, languageForPath(filePath), symStart).elided;
          const symSpans = spansExcludingWindows(symStart, symEnd, symBodyElided);
          // Degenerate guard: a body that elides down to nothing would record
          // nothing at all, and recordServedRange is also what makes this path
          // edit-admissible (A1, 2026-08-01 signal5-2). Keep the path grounded
          // with its signature line rather than dropping the record entirely.
          const symRecorded = symSpans.length > 0
            ? symSpans
            : [[symStart, symStart] as [number, number]];
          // FX-O1 (ruling (t), 2026-09-03; retired 2026-09-13, review round
          // BLOCKER 5): this response used to be
          // `{...symbolDataWithoutScopeHeader, code, handle, sha}` — it carried
          // the assembled scope view as a BODY and named no `path` anywhere, so
          // `servedWindowsOf` had nothing to attribute those bytes to and the
          // whole response projected `unattributed`, which the settlement used
          // to fail OPEN on (round-17 finding 2). This internal attribution call
          // stays (still the cheapest way to feed `servedWindowsOf`), but it is
          // no longer the ONLY place the file is named: the wire response below
          // now also carries a structured `path` unconditionally (Trim A's
          // small-file header omission, §5 lightweight-path wave, removed the
          // injected `// tokenlighten:scope path=...` body line that used to be
          // the sole substitute for it on a <=2 KiB file; `FreshEvidence`,
          // packages/types/src/mcp/protocol.ts, already declares `path` as
          // §3.3's addressing triple, so this is additive on an already-optional
          // field, not a new one).
          noteServeAttribution(filePath);
          const symCall = beginServeCall(workspace);
          for (const [spanStart, spanEnd] of symRecorded) {
            recordServedRange(
              workspace,
              filePath,
              shaOfText(content),
              spanStart,
              spanEnd,
              symTotalLines,
              { mode: "symbol", range: `${symStart}-${result.data.range.end}`, call: symCall },
            );
          }
          // §20.26: what a repeat of this read denotes, for the loop brake.
          noteSymbolWindow(workspace, filePath, shaOfText(content), symbolArg, symStart, result.data.range.end);
        }
        return toolOk(attachSupply({ ...symbolDataWithoutScopeHeader, code: symbolCode, handle: hEntry.id, sha: shortSha(sha), path: filePath }, workspace));
      }
  return undefined;
}
