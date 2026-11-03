import type { ToolCallResult } from "../../../protocol/result.js";
import { countLines } from "../../../util/countLines.js";
import { TINY_BYTES, TINY_LINES } from "../../../util/fullGovernor.js";
import { servedRangeCoverage, recordReadPath, beginServeCall, recordServedRange } from "../../../state/session.js";
import { shaOfText, handleTable, shortSha } from "../../../util/handles.js";
import { toolError, toolOk } from "../../../protocol/result.js";
import { buildSmallFile } from "../../../tools/readCodeSmallFile.js";
import { elideDocCommentsForDisplay, spansExcludingWindows, compressFormat, elideDocComments } from "../../../util/formatCompress.js";
import { languageForPath } from "../../../util/languages.js";
import { deltaContextEnabled } from "../../../util/flags.js";
import { attachSupply } from "../../../util/attachSupply.js";
import { noteServeAttribution, canonicalToolCall } from "../../../protocol/envelope.js";
import { selectQueryEvidence } from "../../../tools/queryEvidence.js";
import { isSkeletonizableLanguage } from "../../../tools/getFileSkeleton.js";
import { isMarkdownPath, parseMarkdownHeadings, MARKDOWN_SECTIONS_HINT } from "../../../util/markdownSections.js";
import { parseSmallFileContent, READ_FULL_CAP_BYTES } from "../../../serverOwned/artifact-csv.js";
import { configuredAllowedParents, DOC_CONTENT_CAP_BYTES, capEnvelopeArray, DOC_HEADINGS_CAP_ENTRIES, DOC_HEADINGS_CAP_BYTES } from "../../../serverOwned/read-admission2.js";
import { deltaContextDecision, buildLedgerDifferenceFullPayload } from "../../../serverOwned/read-receipts.js";

export interface read_autoPort {
  "mode": string;
  "content": string;
  "forceContentServe": boolean;
  "workspace": string;
  "filePath": string;
  "keepComments": boolean;
  "args": Record<string, unknown>;
  "SMALL_FILE_BYTES": 8192;
}
export async function read_auto(port: read_autoPort): Promise<ToolCallResult | undefined> {
  const { mode, content, forceContentServe, workspace, filePath, keepComments, args, SMALL_FILE_BYTES } = port;
if (mode === "auto") {
        const autoBytes = Buffer.byteLength(content, "utf8");
        // BUG FIX: was content.split(/\r?\n/).length — feeds the isTinyFile
        // threshold gate below.
        const autoLineCount = countLines(content);
        const isTinyFile = autoBytes <= TINY_BYTES && autoLineCount <= TINY_LINES;

        // auto-mode on a tiny file: always prefer small_file (D10: unconditional),
        // unless this session holds part of the file. 2026-10-20 (decision
        // run 6t-7, T07 rep1 #5): that read is served like a small file's,
        // as its unserved remainder plus `prior` for the held lines
        // (`buildLedgerDifferenceFullPayload` below), not resent whole.
        const tinyCoverage = isTinyFile && !forceContentServe
          ? servedRangeCoverage(workspace, filePath, shaOfText(content), autoLineCount, undefined, keepComments)
          : undefined;
        const tinyHeldInPart = tinyCoverage !== undefined && !tinyCoverage.complete && tinyCoverage.served.length > 0;
        if (isTinyFile && !tinyHeldInPart) {
          try {
            const smallFileContent = parseSmallFileContent(args["content"]);
            if (!smallFileContent.ok) return toolError("content must be full, outline, defer, or auto");
            const sfRes = await buildSmallFile(workspace, filePath, String(args["cwd"] ?? ""), { content: smallFileContent.value, keepComments, allowedParents: configuredAllowedParents(workspace) });
            if ("mode" in sfRes) return toolOk(sfRes);
            // fallback on refusal (should not happen for tiny files, but be safe)
          } catch {
            /* fall through to skeleton */
          }
        }

        if (content.length < SMALL_FILE_BYTES && autoBytes <= READ_FULL_CAP_BYTES) {
          // auto-mode small file: augment with handle + sha (C.6).
          const sha = shaOfText(content);
          const hEntry = handleTable.upsert({
            kind: "file",
            path: filePath,
            workspaceRoot: workspace,
            sha,
          });
          // C10.1: short display sha; hEntry above minted on the full sha.
          // DESIGN-v0.8 §C3: comments elided by default (comments=keep escape);
          // sha above is already computed from the RAW content, unaffected.
          // 2026-07-16a bench forensics: fall back to raw content + a note
          // instead of serving an elided-empty doc-only file — see
          // elideDocCommentsForDisplay's doc comment (util/formatCompress.ts).
          const { content: displayContent, note: elisionNote, elided: autoElided } = elideDocCommentsForDisplay(
            content,
            languageForPath(filePath),
            keepComments,
          );
          // B2 / V12-02: same suppression rule as the mode=full branch above —
          // this difference projection is unflagged, so the delta decision only
          // ADDS the base-mismatch drop and the size guard. `undefined` (flag
          // off, or an entry no server edit carried) leaves it untouched.
          const autoDelta = forceContentServe || !deltaContextEnabled()
            ? undefined
            : deltaContextDecision({
                workspace, filePath, content, sha, totalLines: autoLineCount,
              });
          const difference = !forceContentServe && autoDelta?.decision !== "full"
            ? buildLedgerDifferenceFullPayload({
                workspace,
                filePath,
                content,
                handleId: hEntry.id,
                sha,
                keepComments,
                mode: "auto",
              })
            : undefined;
          if (difference !== undefined) {
            recordReadPath(workspace, filePath);
            return toolOk(attachSupply(difference, workspace));
          }
          // Feature 1 (2026-07-12b2): successful mode=auto small-content serve.
          recordReadPath(workspace, filePath);
          // FX-M1/P2: this ships the WHOLE file as content — book it into the
          // served-range ledger exactly like the sibling `fullFileExpansion`
          // branch above (same beginServeCall + spansExcludingWindows +
          // recordServedRange triad, booking only the spans that survived
          // comment elision). Before this fix this branch called
          // `recordReadPath` but never `recordServedRange`, so a real,
          // shipped body left the served-range ledger, `editPathResidency`,
          // and `admissibleEditPaths` untouched — the one production-
          // reachable content-bearing read that skipped that bookkeeping
          // (the `difference !== undefined` branch just above is unaffected:
          // `buildLedgerDifferenceFullPayload` already books its own fresh
          // segments internally).
          // FX-O1 (ruling (t), 2026-09-03): the payload below is
          // `{content, language, handle, sha}` — a whole-file BODY with no
          // `path`, the second of the two shapes that projected `unattributed`
          // (round-17 finding 2 measured only the symbol one; this branch is
          // reached by any file over TINY_LINES but under SMALL_FILE_BYTES,
          // e.g. 300 short lines). Same one-line attribution, same untouched
          // wire.
          noteServeAttribution(filePath);
          const autoSmallServeCall = beginServeCall(workspace);
          // FX-W3 (ruling (aa)): renderer-accounted spans, not a re-parse of
          // `displayContent`.
          for (const [spanStart, spanEnd] of spansExcludingWindows(1, autoLineCount, autoElided)) {
            recordServedRange(
              workspace, filePath, sha, spanStart, spanEnd, autoLineCount,
              { mode: "auto", range: `1-${autoLineCount}`, call: autoSmallServeCall },
            );
          }
          return toolOk({
            content: compressFormat(displayContent),
            language: filePath.split(".").pop() ?? "unknown",
            handle: hEntry.id,
            sha: shortSha(sha),
            ...(elisionNote ? { note: elisionNote } : {}),
          });
        }

        // A semantic query over a large file should receive the evidence it
        // asks for, not the beginning of a skeleton/document. The file is
        // already resident in memory, so this adds no I/O and stays bounded to
        // one query-ranked window. Ambiguous/no-match queries preserve the
        // existing skeleton/prefix fallback below.
        const semanticQuery = typeof args["query"] === "string" ? args["query"].trim() : "";
        if (semanticQuery.length > 0) {
          const evidence = selectQueryEvidence(content, semanticQuery, { path: filePath });
          if (evidence !== undefined) {
            const fullSha = shaOfText(content);
            const rangeHandle = handleTable.upsert({
              kind: "range",
              path: filePath,
              range: evidence.range,
              workspaceRoot: workspace,
            });
            const evidenceStartLine = Number.parseInt(evidence.range.split("-", 1)[0] ?? String(evidence.line), 10);
            const displayContent = keepComments
              ? evidence.content
              : elideDocComments(evidence.content, languageForPath(filePath), evidenceStartLine);
            recordReadPath(workspace, filePath);
            return toolOk({
              content: compressFormat(displayContent),
              language: languageForPath(filePath) ?? (filePath.split(".").pop() ?? "unknown"),
              handle: rangeHandle.id,
              sha: shortSha(fullSha),
              range: evidence.range,
              focus: {
                kind: evidence.kind,
                matched_terms: evidence.matchedTerms,
                missing_terms: evidence.missingTerms,
                score: evidence.score,
                margin: evidence.margin,
              },
              truncated: true,
            });
          }
        }

        // S1/C1: mode=auto on a LARGE (>= SMALL_FILE_BYTES) NON-CODE file
        // (markdown/json/yaml/toml/text/log/csv/etc.) — getFileSkeleton would
        // return a useless "(no signatures detected)" header or a raw dump
        // for these. Return a capped content slice instead, same shape as
        // the small-file branch above plus truncation metadata. Explicit
        // mode=skeleton is NOT affected (falls through below unconditionally
        // for a user who actually asked for a skeleton); code files are not
        // affected either (isSkeletonizableLanguage gate).
        if (!isSkeletonizableLanguage(languageForPath(filePath))) {
          const fullSha = shaOfText(content);
          const hEntry = handleTable.upsert({
            kind: "file",
            path: filePath,
            workspaceRoot: workspace,
            sha: fullSha,
          });
          const rawBytes = Buffer.byteLength(content, "utf8");
          let capped = content;
          let truncated = false;
          let lastCoveredLine = autoLineCount;
          if (rawBytes > DOC_CONTENT_CAP_BYTES) {
            const buf = Buffer.from(content, "utf8");
            const slice = buf.subarray(0, DOC_CONTENT_CAP_BYTES).toString("utf8");
            // Truncate on a line boundary — never cut mid-line.
            const lastNewline = slice.lastIndexOf("\n");
            capped = lastNewline >= 0 ? slice.slice(0, lastNewline) : slice;
            truncated = true;
            lastCoveredLine = countLines(capped);
          }
          const displayContent = keepComments ? capped : elideDocComments(capped, languageForPath(filePath));
          const docResult: Record<string, unknown> = {
            content: compressFormat(displayContent),
            language: languageForPath(filePath) ?? (filePath.split(".").pop() ?? "unknown"),
            handle: hEntry.id,
            sha: shortSha(fullSha),
            truncated,
          };
          if (truncated) {
            const nextStart = lastCoveredLine + 1;
            const totalLines = countLines(content);
            if (nextStart <= totalLines) {
              // Remainder form, not a fixed 120-line window: the slice serve
              // clamps to its own byte cap per call, so naming the whole
              // remainder converges in ceil(bytes/cap) calls instead of a
              // window walk (2026-07-09c residual turn cost).
              docResult["next"] = canonicalToolCall("tl_read_file", {
                handle: hEntry.id,
                range: `${nextStart}-${totalLines}`,
              });
            } else {
              // skc2 Q5 (2026-07-17): the byte cap cut inside the file's LAST
              // line (a zero-newline file cuts inside line 1), so no whole
              // line exists after the cut and a line-range continuation
              // cannot name the remainder — the old unconditional next
              // emitted an inverted, unusable range (2-1 on a one-line 32KB
              // file). Keep truncated:true + handle and point at mode=full.
              docResult["hint"] = `remainder is inside line ${lastCoveredLine} (no later line to slice); use tl_read_file {targets:[{path:"${filePath}"}], content:"full"} for the whole file`;
            }
          }
          // OPTIONAL: markdown heading outline — extracted from the full
          // content regardless of truncation so the outline still names
          // sections beyond the capped slice. Capped by DOC_HEADINGS_CAP_*
          // (2026-07-17 spec-final rc2, cell md_4800kb: EVERY heading of a
          // generated ~4.8MB .md rode along — 22,680 entries / 3.72MB beside
          // the 4KB body); truncation is explicit, never silent.
          if (isMarkdownPath(filePath)) {
            const allHeadings = parseMarkdownHeadings(content);
            const headings = capEnvelopeArray(
              allHeadings.slice(0, DOC_HEADINGS_CAP_ENTRIES).map((heading) => ({
                level: heading.level,
                text: heading.text,
                line: heading.line,
                range: String(heading.line) + "-" + String(heading.endLine),
                section: heading.path,
                style: heading.style,
              })),
              DOC_HEADINGS_CAP_ENTRIES,
              DOC_HEADINGS_CAP_BYTES,
            );
            if (headings.length > 0) docResult["headings"] = headings;
            if (headings.length < allHeadings.length) {
              docResult["headings_truncated"] = true;
              docResult["headings_total"] = allHeadings.length;
            }
            // R1 (2026-07-25): the outline names sections but not how to ASK
            // for one — live, solvers read the heading list here and then
            // shelled out to grep/sed for line numbers. One short instruction
            // closes that gap (kept off heading-less docs, where it is noise).
            if (headings.length > 0) docResult["sections_hint"] = MARKDOWN_SECTIONS_HINT;
          }
          // Feature 1 (2026-07-12b2): successful mode=auto large-non-code serve.
          recordReadPath(workspace, filePath);
          return toolOk(docResult);
        }
      }
  return undefined;
}
