import type { ToolCallResult } from "../../../protocol/result.js";
import { isMarkdownPath, parseMarkdownHeadings, selectMarkdownSections, similarHeadingTexts } from "../../../util/markdownSections.js";
import { toolError, toolStructuredError, toolOk } from "../../../protocol/result.js";
import { canonicalToolCall } from "../../../protocol/envelope.js";
import { resolveSlice } from "../../../tools/readCodeModes.js";
import { shortSha, shaOfText, handleTable } from "../../../util/handles.js";
import { elideDocComments } from "../../../util/formatCompress.js";
import { countLines } from "../../../util/countLines.js";
import { servedRangeReceipt, type ServedRangeLedgerReceipt, beginServeCall, recordServedRange } from "../../../state/session.js";
import { parseWindows } from "../../../state/readRequestStore.js";
import { attachSupply } from "../../../util/attachSupply.js";
import { servedTextForRoute, undecodableTextMessage, markdownSymbolMissPayload, attachMarkdownHeadingIndex } from "../../../serverOwned/read-admission2.js";
import { rangeStartLine } from "../../../serverOwned/edit-anchor.js";
import { openParentReceiptContinuation } from "../../../serverOwned/canonical-input3.js";
import { servedContentReceipt } from "../../../serverOwned/read-receipts.js";

export interface read_markdownSectionsPort {
  "mode": string;
  "resolvedPath": string | undefined;
  "requestedMarkdownSections": string[];
  "markdownSymbolSection": string | undefined;
  "workspace": string;
  "noteZeroByteServe": () => void;
  "keepComments": boolean;
  "forceContentServe": boolean;
  "args": Record<string, unknown>;
}
export async function read_markdownSections(port: read_markdownSectionsPort): Promise<ToolCallResult | undefined> {
  const { mode, resolvedPath, requestedMarkdownSections, markdownSymbolSection, workspace, noteZeroByteServe, keepComments, forceContentServe, args } = port;
if (
        (mode === "auto" || mode === "slice" || mode === "symbol") &&
        resolvedPath &&
        isMarkdownPath(resolvedPath) &&
        (requestedMarkdownSections.length > 0 || markdownSymbolSection !== undefined)
      ) {
        // A capped section list is a partial serve, never a refusal: callers
        // already supplied the remaining headings, so the server can return a
        // literal continuation without making them reconstruct the request.
        const markdownSectionCap = 8;
        const cappedMarkdownSections = requestedMarkdownSections.slice(0, markdownSectionCap);
        const remainingMarkdownSections = requestedMarkdownSections.slice(markdownSectionCap);
        // served-bytes: readServedText
        const mdSectionVerdict = await servedTextForRoute(resolvedPath, workspace);
        if (mdSectionVerdict !== null && mdSectionVerdict.kind === "undecodable") {
          return toolError(undecodableTextMessage(resolvedPath, mdSectionVerdict), { code: "read-error" });
        }
        const markdown = mdSectionVerdict === null ? null : mdSectionVerdict.text;
        if (markdown === null) return toolError(`File not found or outside workspace: ${resolvedPath}`, { code: "not-found" });
        const headings = parseMarkdownHeadings(markdown);
        const sectionQueries = markdownSymbolSection !== undefined
          ? [markdownSymbolSection]
          : cappedMarkdownSections;
        const selected = selectMarkdownSections(headings, sectionQueries);
        const ambiguityCandidates = selected.ambiguous
          .flatMap((entry) => entry.candidates.map((heading) => ({
            query: entry.query,
            heading: heading.text,
            section: heading.path,
            range: String(heading.line) + "-" + String(heading.endLine),
          })))
          .slice(0, 6);
        const firstCandidate = ambiguityCandidates[0];

        if (selected.matches.length === 0) {
          // ND-1: the requested sections/symbol resolved to no heading, so
          // this call serves no file bytes — a later identical repeat must get
          // this same self-healing miss, never a residency claim minted from
          // the file-level served-range ledger.
          noteZeroByteServe();
          // R1: a doc symbol-miss answers with the heading map + a concrete
          // sections call, never the old whole-file redirect.
          if (markdownSymbolSection !== undefined) {
            return toolStructuredError(markdownSymbolMissPayload({
              path: resolvedPath,
              symbol: markdownSymbolSection,
              content: markdown,
            }));
          }
          const missPayload: Record<string, unknown> = {
            ok: false,
            code: selected.ambiguous.length > 0 ? "markdown-section-ambiguous" : "markdown-section-not-found",
            path: resolvedPath,
            ...(selected.missing.length > 0 ? { missing: selected.missing } : {}),
            ...(ambiguityCandidates.length > 0 ? { candidates: ambiguityCandidates } : {}),
          };
          // headings[] supersedes the old flat `outline` (same names, plus
          // level + the section range mode=slice needs) — one vocabulary, and
          // strictly fewer bytes than carrying both.
          attachMarkdownHeadingIndex(missPayload, markdown);
          // A missed section name is still a lexical signal: propose the
          // closest headings instead of "re-read the whole doc" (the live R1
          // hint, which cost more than the native slice it competed with).
          const missSimilar = similarHeadingTexts(headings, selected.missing[0] ?? sectionQueries[0] ?? "", 3);
          missPayload["next"] = firstCandidate
            ? canonicalToolCall("tl_read_file", { path: resolvedPath, sections: [firstCandidate.section] })
            : missSimilar.length > 0
              ? canonicalToolCall("tl_read_file", { path: resolvedPath, sections: missSimilar })
              : canonicalToolCall("tl_read_file", { mode: "overview", path: resolvedPath });
          return toolStructuredError(missPayload);
        }

        const items: Record<string, unknown>[] = [];
        // FX-Q3 (round-18A finding 4; ruling (s)/(t), 2026-09-03): the section
        // serve below ships real FILE bytes but used to book nothing — an
        // identical repeat re-shipped the same bytes (every other serve shape
        // answers a receipt) and the shipped lines granted no edit authority.
        // `rawSections` keeps the RAW (pre-elision) content + file-line range
        // resolveSlice returned for each MATCHED heading, purely for the
        // booking math below — it is never put on the wire. A section that
        // could not resolve to a real window never reaches `selected.matches`
        // (the `selected.matches.length === 0` branch above already returned),
        // so nothing here can book an unserved section.
        const rawSections: Array<{ range: string; rawContent: string; truncated: boolean }> = [];
        for (const heading of selected.matches) {
          const range = String(heading.line) + "-" + String(heading.endLine);
          const sliceResult = await resolveSlice(workspace, resolvedPath, markdown, undefined, range);
          if (!sliceResult.ok) {
            return toolStructuredError({
              ok: false,
              code: "markdown-section-read-failed",
              path: resolvedPath,
              section: heading.path,
              error: sliceResult.error,
            });
          }
          const data = sliceResult.data;
          rawSections.push({ range: data.range, rawContent: data.content, truncated: data.truncated === true });
          items.push({
            heading: heading.text,
            section: heading.path,
            level: heading.level,
            style: heading.style,
            range: data.range,
            handle: data.handle,
            sha: shortSha(data.sha),
            content: keepComments
              ? data.content
              : elideDocComments(data.content, "markdown", rangeStartLine(data.range)),
            truncated: data.truncated,
            ...(data.truncated ? { note: "section truncated; follow next before handle+content replacement" } : {}),
            ...(data.next ? { next: data.next } : {}),
          });
        }

        const omitted = [
          ...selected.missing.map((section) => ({ section, reason: "not-found" })),
          ...selected.ambiguous.map((entry) => ({
            section: entry.query,
            reason: "ambiguous",
            candidates: entry.candidates.slice(0, 3).map((heading) => heading.path),
          })),
        ];
        const continuation = remainingMarkdownSections.length > 0
          ? canonicalToolCall("tl_read_file", { path: resolvedPath, sections: remainingMarkdownSections })
          : omitted.length > 0 && firstCandidate
          ? canonicalToolCall("tl_read_file", { path: resolvedPath, sections: [firstCandidate.section] })
          : undefined;

        // A section serve is a PARTIAL surface unless the matched sections
        // happen to cover the file: carry the heading index so the next hop
        // is another sections call instead of a native grep for line numbers.
        const servedLines = selected.matches.reduce((sum, heading) => sum + (heading.endLine - heading.line + 1), 0);
        const partialServe = servedLines < countLines(markdown);
        const focus = {
          start: Math.min(...selected.matches.map((heading) => heading.line)),
          end: Math.max(...selected.matches.map((heading) => heading.endLine)),
        };

        // FX-Q3 booking: stage the FILE-LINE span each shipped section
        // occupies. Markdown is never a language `elideDocComments` elides
        // (ruling (aa): only C-comment and Python langs are), so each section
        // is booked as one literal span — no marker-parse of any kind, and
        // therefore no literal `doc elided …`-shaped line in a caller's own
        // markdown prose can ever be mistaken for a genuine collapse here.
        // Ruling (t)/(aa): the wire corroboration (`servedWindowsOf`) only
        // ever confirms or narrows what is staged here; it can never widen
        // it. Probe FIRST (before
        // recording any span from THIS response) so an already-held section is
        // never judged "new" merely because a sibling section of this same
        // response staged an overlapping span first — the same ordering
        // guarantee the ranges[] batch path above already relies on.
        const rawFileSha = shaOfText(markdown);
        const fileTotalLines = countLines(markdown);
        const alreadyHeldSections = new Set<number>();
        const alreadyHeldBy = new Map<number, string>();
        if (!forceContentServe) {
          for (let i = 0; i < rawSections.length; i++) {
            const section = rawSections[i]!;
            if (section.truncated) continue;
            const segStart = rangeStartLine(section.range);
            const segEnd = Math.min(fileTotalLines, segStart + countLines(section.rawContent) - 1);
            const heldReceipt = servedRangeReceipt(workspace, resolvedPath, rawFileSha, segStart, segEnd, fileTotalLines);
            if (heldReceipt !== undefined) {
              alreadyHeldSections.add(i);
              if (heldReceipt.served_by !== undefined) alreadyHeldBy.set(i, heldReceipt.served_by);
            }
          }
        }
        let sectionLedger: ServedRangeLedgerReceipt | undefined;
        {
          const sectionCall = beginServeCall(workspace);
          // FX-W3 (ruling (aa)): markdown is never a language `elideDocComments`
          // elides (only C-comment and Python langs are), so a section's own
          // display text is booked as ONE literal span — no marker-parse at all,
          // which also means no literal `doc elided …`-shaped line in a
          // caller's own markdown prose can ever be mistaken for a genuine
          // collapse here.
          for (let i = 0; i < rawSections.length; i++) {
            const section = rawSections[i]!;
            const segStart = rangeStartLine(section.range);
            const segEnd = Math.min(fileTotalLines, segStart + countLines(section.rawContent) - 1);
            sectionLedger = recordServedRange(
              workspace, resolvedPath, rawFileSha, segStart, segEnd, fileTotalLines,
              { mode: "markdown-section", range: section.range, call: sectionCall },
            );
          }
        }

        // Every requested section (after the 8-section cap) is already held
        // at this exact file sha, and none was capped/omitted this call — the
        // whole response collapses to one receipt, exactly like an ordinary
        // fully-covered range-slice re-ask. A MIX of held + new sections never
        // collapses (falls through and re-ships everything below, matching the
        // existing all-or-nothing ranges[] batch behavior) — the receipt is
        // therefore restricted to an IDENTICAL section set.
        if (
          rawSections.length > 0
          && alreadyHeldSections.size === rawSections.length
          && sectionLedger !== undefined
          && omitted.length === 0
          && remainingMarkdownSections.length === 0
        ) {
          const heldLabels = [...new Set(alreadyHeldBy.values())];
          const sectionServedBy = heldLabels.length === 0
            ? undefined
            : heldLabels.length <= 2
              ? heldLabels.join(" + ")
              : `${heldLabels[0]!} +${heldLabels.length - 1} more`;
          const sectionsParentContinuation = openParentReceiptContinuation(
            workspace, resolvedPath, rawFileSha, args,
            parseWindows(rawSections.map((section) => section.range)),
          );
          if (sectionQueries.length === 1 && items.length === 1) {
            return toolOk(attachSupply(servedContentReceipt({
              mode: "markdown-section",
              handle: items[0]!["handle"] as string,
              path: resolvedPath,
              range: items[0]!["range"] as string,
              sha: items[0]!["sha"] as string,
              ledger: sectionLedger,
              ...(sectionServedBy !== undefined ? { servedBy: sectionServedBy } : {}),
              extra: { section: items[0]!["section"], served_range_ledger: sectionLedger },
              workspace,
              ...(sectionsParentContinuation !== undefined ? { parentContinuation: sectionsParentContinuation } : {}),
            }), workspace));
          }
          const fileHandle = handleTable.upsert({
            kind: "file",
            path: resolvedPath,
            workspaceRoot: workspace,
            sha: rawFileSha,
          });
          return toolOk(attachSupply(servedContentReceipt({
            mode: "markdown-sections",
            handle: fileHandle.id,
            path: resolvedPath,
            range: items.map((item) => item["range"] as string).join(","),
            sha: shortSha(rawFileSha),
            ledger: sectionLedger,
            ...(sectionServedBy !== undefined ? { servedBy: sectionServedBy } : {}),
            extra: { sections: items.map((item) => item["section"]), served_range_ledger: sectionLedger },
            workspace,
            ...(sectionsParentContinuation !== undefined ? { parentContinuation: sectionsParentContinuation } : {}),
          }), workspace));
        }

        if (sectionQueries.length === 1 && items.length === 1 && omitted.length === 0) {
          const single: Record<string, unknown> = {
            mode: "markdown-section",
            path: resolvedPath,
            ...items[0],
          };
          if (partialServe) attachMarkdownHeadingIndex(single, markdown, focus);
          return toolOk(single);
        }
        const multi: Record<string, unknown> = {
          mode: "markdown-sections",
          path: resolvedPath,
          items,
          omitted,
          // The v1 read-text projector carries continuation values through
          // Evidence.remaining.  Section names are the addressable values for
          // this surface (rather than line windows), but retain the familiar
          // carrier so the continuation survives projection.
          ...(remainingMarkdownSections.length > 0 ? { remaining_ranges: remainingMarkdownSections } : {}),
          completeness: omitted.length === 0 && remainingMarkdownSections.length === 0 ? "complete" : "partial",
          ...(continuation ? { next: continuation } : {}),
        };
        if (partialServe) attachMarkdownHeadingIndex(multi, markdown, focus);
        return toolOk(multi);
      }
  return undefined;
}
