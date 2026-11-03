import type { ToolCallResult } from "../../../protocol/result.js";
import { toolError, toolStructuredError, toolOk } from "../../../protocol/result.js";
import { readBytesSafe } from "../../../util/safePath.js";
import { shaOfBytes, handleTable, shortSha } from "../../../util/handles.js";
import { prepareOfficeDocument } from "../../../office/decrypt.js";
import { mustFetchReadBudget } from "../../../util/mustFetch.js";
import { READ_SYMBOL_CAP_BYTES } from "../../../tools/readCodeModes.js";
import { artifactRangeReceipt, beginServeCall, recordArtifactServedRange } from "../../../state/session.js";
import { attachSupply } from "../../../util/attachSupply.js";
import { countLines } from "../../../util/countLines.js";
import { decodeCsvBytes, csvTable } from "../../../office/csv.js";
import { artifactQueryWindowEnabled } from "../../../util/flags.js";
import { officeOrArchiveSurfaceRefusal } from "../../../serverOwned/read-admission2.js";
import { xlsxTableFailureCode } from "../../../serverOwned/task-pack-wire.js";
import { SERVED_CONTENT_RECEIPT_NOTE } from "../../../serverOwned/read-receipts.js";
import { csvArtifactServeReceipt, bookCsvArtifactServe, csvArtifactShape } from "../../../serverOwned/artifact-csv.js";
import { serveCsvQueryWindow, serveBoundedCsvArtifact } from "../../../serverOwned/artifact-csv2.js";

export interface read_artifactPort {
  "mode": string;
  "resolvedPath": string | undefined;
  "args": Record<string, unknown>;
  "workspace": string;
  "credentialPassword": string | undefined;
  "forceContentServe": boolean;
  "defaultResponseByteCeiling": number | undefined;
}
export async function read_artifact(port: read_artifactPort): Promise<ToolCallResult | undefined> {
  const { mode, resolvedPath, args, workspace, credentialPassword, forceContentServe, defaultResponseByteCeiling } = port;
if (mode === "artifact") {
        // DESIGN-v0.15 §8.2 (R7 Part B): `mode` stays a generic legacy key (see
        // FULL_ONLY_LEGACY_KEYS's doc comment) — a legacy caller can send
        // `mode:"artifact"` directly, bypassing the `select`-based schema
        // gate a canonical caller would hit. Gate the value here too.
        const artifactSurfaceRefusal = officeOrArchiveSurfaceRefusal();
        if (artifactSurfaceRefusal !== undefined) return toolError(artifactSurfaceRefusal.error, { code: artifactSurfaceRefusal.code });
        const artifactPath = resolvedPath ?? "";
        if (!artifactPath) return toolError("path is required for mode=artifact", { code: "invalid-input" });
        const ext = (artifactPath.toLowerCase().match(/\.([^.\\/]+)$/)?.[1]) ?? "";
        const kind = (typeof args["kind"] === "string" ? args["kind"] : ext);

        // served-bytes: not-served (artifact CONTAINER bytes: extractOfficeText / the archive reader owns the decode)
        const bytes = await readBytesSafe(artifactPath, workspace);
        if (bytes === null) return toolError(`File not found or outside workspace: ${artifactPath}`, { code: "not-found" });

        // B5.2: full-content hash, not a first-48-bytes truncation (see
        // shaOfBytes doc comment in util/handles.ts).
        const sha = shaOfBytes(bytes);
        const hEntry = handleTable.upsert({
          kind: "file",
          path: artifactPath,
          workspaceRoot: workspace,
          sha,
        });
        let artifactBytes: Uint8Array = bytes;
        if (kind === "xlsx" || kind === "docx" || kind === "pptx") {
          const prepared = await prepareOfficeDocument(bytes, credentialPassword);
          if (!prepared.ok) {
            return toolStructuredError({
              ok: false,
              kind,
              path: artifactPath,
              error: prepared.error,
              code: prepared.code,
              ...(prepared.hint ? { hint: prepared.hint } : {}),
            });
          }
          artifactBytes = prepared.bytes;

          // Mandatory zip-bomb preflight — gates EVERY OOXML consumer below
          // (visual inventory, xlsxTable/xlsxRoster, docxSections,
          // pptxSlides) with exactly one walk of the central directory, so
          // mode=artifact can no longer hand raw/decrypted bytes straight to
          // JSZip-backed parsers unchecked. See TL-V0.9-RELEASE-STRATEGY-
          // 2026-08-12.md §6.6.
          const { preflightZip } = await import("../../../office/zipPreflight.js");
          const artifactPreflight = await preflightZip(artifactBytes);
          if (!artifactPreflight.ok) {
            return toolStructuredError({
              ok: false,
              kind,
              path: artifactPath,
              error: `Zip preflight failed: ${artifactPreflight.detail}`,
              code: artifactPreflight.code,
            });
          }
        }

        const visualInventory = kind === "xlsx" || kind === "docx" || kind === "pptx"
          ? await (await import("../../../office/ooxmlVisuals.js"))
            .extractOoxmlVisualInventory(artifactBytes, kind, { preflighted: true })
          : undefined;
        const visualFields = visualInventory
          && (visualInventory.charts.length > 0 || visualInventory.media.length > 0)
          ? { visuals: visualInventory }
          : {};

        if (kind === "xlsx") {
          const { xlsxRoster, xlsxTable, pickLargestSheetByCells } = await import("../../../office/xlsx.js");
          const sheet = typeof args["sheet"] === "string" ? args["sheet"] : undefined;
          const range = typeof args["range"] === "string" ? args["range"] : undefined;
          const asFormat = typeof args["as"] === "string" ? args["as"] : undefined;
          const maxRows = typeof args["maxRows"] === "number" ? args["maxRows"] : undefined;
          const maxCells = typeof args["maxCells"] === "number" ? args["maxCells"] : undefined;
          const columns = Array.isArray(args["columns"]) ? (args["columns"] as unknown[]).map(String) : undefined;
          const rowRange = Array.isArray(args["rows"]) ? args["rows"] as [number, number] : undefined;

          // If no sheet/range/as specified, return roster (overview) PLUS the
          // largest data sheet's bounded content inline — the "roster tax"
          // fix (bench task T10 forensics): a bare no-`sheet` artifact call
          // used to cost >=2 round trips on every workbook (this roster, then
          // a follow-up `sheet=` call for data) even though the row data for
          // every sheet is already sitting in the SAME parsed workbook (see
          // xlsxRoster's cellCount field). Pick is general/content-based —
          // see pickLargestSheetByCells's doc comment for why not by name.
          if (!sheet && !range && !asFormat && !columns) {
            const rosterResult = await xlsxRoster(artifactBytes);
            if (!rosterResult.ok) return toolError(rosterResult.error, { code: "corrupt" });

            const baseRoster: Record<string, unknown> = {
              mode: "artifact",
              kind: "xlsx",
              path: artifactPath,
              view: "roster",
              handle: hEntry.id,
              sha: shortSha(sha), // C10.1: short display prefix; hEntry above already minted on the FULL sha.
              sheets: rosterResult.sheets,
              warnings: rosterResult.warnings,
              ...visualFields,
            };

            const isSingleSheet = rosterResult.sheets.length === 1;
            // Hidden sheets are excluded from the auto-pick, matching
            // xlsxTable's own default-sheet behavior (it also skips hidden
            // sheets unless named explicitly) — an agent that wants a hidden
            // sheet's data must still ask for it by name.
            const inlineCandidates = rosterResult.sheets.filter((s) => !s.hidden);
            const largestName = pickLargestSheetByCells(inlineCandidates);

            if (largestName) {
              // Same budget the SIBLING xlsx auto-inline flow uses in
              // mode=auto/skeleton/symbol (see the `next`/`section`
              // block below in this file) — reusing it keeps "never exceed
              // current caps" literal rather than inventing a new number.
              const inlineBudget = mustFetchReadBudget(READ_SYMBOL_CAP_BYTES);

              // Attempt 1: today's normal per-call sheet bounds (same as an
              // explicit sheet=<largestName> call would get — nothing looser).
              const tableResult = await xlsxTable(artifactBytes, { sheet: largestName });
              if (tableResult.ok) {
                const withData: Record<string, unknown> = {
                  ...baseRoster,
                  inlined_sheet: largestName,
                  range: tableResult.range,
                  columns: tableResult.columns,
                  rows: tableResult.rows,
                  truncated: tableResult.truncated,
                  note: isSingleSheet
                    ? "single-sheet workbook — this call already returned the full bounded content; no follow-up read needed"
                    : `inlined "${largestName}" (largest sheet by non-empty cells); pass sheet=<name> to read a different one`,
                };
                if (Buffer.byteLength(JSON.stringify(withData), "utf8") <= inlineBudget) {
                  return toolOk(withData);
                }
              }

              // Attempt 2: the full bounded read didn't fit (huge sheet) —
              // fall back to a small, cheap head preview before giving up.
              // Never loosens the budget check above.
              const XLSX_ROSTER_HEAD_PREVIEW_ROWS = 20;
              const XLSX_ROSTER_HEAD_PREVIEW_CELLS = 2000;
              const headResult = await xlsxTable(artifactBytes, {
                sheet: largestName,
                maxRows: XLSX_ROSTER_HEAD_PREVIEW_ROWS,
                maxCells: XLSX_ROSTER_HEAD_PREVIEW_CELLS,
              });
              if (headResult.ok) {
                const withHead: Record<string, unknown> = {
                  ...baseRoster,
                  inlined_sheet: largestName,
                  range: headResult.range,
                  columns: headResult.columns,
                  rows: headResult.rows,
                  truncated: true,
                  note: `"${largestName}" is too large to inline in full; showing a head preview (first ${XLSX_ROSTER_HEAD_PREVIEW_ROWS} rows) — pass sheet="${largestName}" for a bounded full read`,
                };
                if (Buffer.byteLength(JSON.stringify(withHead), "utf8") <= inlineBudget) {
                  return toolOk(withHead);
                }
              }
            }

            // Fallback: today's roster-only behavior, unchanged.
            return toolOk(baseRoster);
          }

          // Otherwise return table data
          const tableResult = await xlsxTable(artifactBytes, {
            sheet,
            range,
            rowRange,
            columns,
            maxRows,
            maxCells,
            as: asFormat as "json" | "markdown" | undefined,
          });
          if (!tableResult.ok) return toolStructuredError({ ok: false, code: xlsxTableFailureCode(tableResult.error), error: tableResult.error });
          if (sheet !== undefined && range !== undefined && !forceContentServe) {
            const artifactReceipt = artifactRangeReceipt(workspace, artifactPath, sheet, sha, tableResult.range);
            if (artifactReceipt !== undefined) {
              return toolOk(attachSupply({ mode: "artifact", kind: "xlsx", path: artifactPath, sheet, range, handle: hEntry.id, sha: shortSha(sha), receipt: "code-unchanged", code_unchanged: true, ...(artifactReceipt.served_by ? { served_by: artifactReceipt.served_by } : {}), summary: { served: artifactReceipt.served, complete: true }, note: SERVED_CONTENT_RECEIPT_NOTE }, workspace));
            }
          }
          let artifactServedBy: string | undefined;
          if (tableResult.columns.length > 0 && tableResult.rows.length > 0) {
            const artifactCall = beginServeCall(workspace);
            artifactServedBy = recordArtifactServedRange(workspace, artifactPath, tableResult.sheet, sha, tableResult.range, `artifact ${tableResult.range} (call #${artifactCall})`).served_by;
          }
          return toolOk({
            mode: "artifact",
            kind: "xlsx",
            path: artifactPath,
            sheet: tableResult.sheet,
            range: tableResult.range,
            handle: hEntry.id,
            sha: shortSha(sha), // C10.1: short display prefix.
            columns: tableResult.columns,
            rows: tableResult.rows,
            truncated: tableResult.truncated || visualInventory?.truncated === true,
            warnings: tableResult.warnings,
            ...(artifactServedBy ? { served_by: artifactServedBy } : {}),
            ...visualFields,
          });
        }

        if (kind === "docx") {
          const { docxSections } = await import("../../../office/docx.js");
          const sections = Array.isArray(args["sections"]) ? (args["sections"] as unknown[]).map(String) : undefined;
          const query = typeof args["query"] === "string" ? args["query"] : undefined;
          const result = await docxSections(artifactBytes, { sections, query });
          if (!result.ok) return toolError(result.error, { code: "corrupt" });
          return toolOk({
            mode: "artifact",
            kind: "docx",
            path: artifactPath,
            handle: hEntry.id,
            sha: shortSha(sha), // C10.1: short display prefix.
            sections: result.sections,
            truncated: result.truncated || visualInventory?.truncated === true,
            warnings: result.warnings,
            ...visualFields,
          });
        }

        if (kind === "pptx") {
          const { pptxSlides } = await import("../../../office/pptx.js");
          const slides = Array.isArray(args["slides"]) ? (args["slides"] as unknown[]).map(String) : undefined;
          const query = typeof args["query"] === "string" ? args["query"] : undefined;
          const result = await pptxSlides(artifactBytes, { slides, query });
          if (!result.ok) return toolError(result.error, { code: "corrupt" });
          return toolOk({
            mode: "artifact",
            kind: "pptx",
            path: artifactPath,
            handle: hEntry.id,
            sha: shortSha(sha), // C10.1: short display prefix.
            slides: result.slides,
            truncated: result.truncated || visualInventory?.truncated === true,
            warnings: visualInventory && visualInventory.charts.length > 0
              ? result.warnings.filter((warning) => !warning.startsWith("chart content not extracted"))
              : result.warnings,
            ...visualFields,
          });
        }

        if (kind === "pdf") {
          const { pdfPages } = await import("../../../office/pdf.js");
          const pages = Array.isArray(args["pages"]) ? (args["pages"] as unknown[]).map(String) : undefined;
          const query = typeof args["query"] === "string" ? args["query"] : undefined;
          const result = await pdfPages(bytes, {
            pages,
            query,
            ...(credentialPassword !== undefined ? { password: credentialPassword } : {}),
          });
          if (!result.ok) {
            // Structured (not bare toolError) so the failure code and the
            // native-fallback hint (pdf-encrypted/pdf-no-text-layer cases)
            // survive to the caller. Never a dangling next=artifact loop:
            // this IS mode=artifact, so the hint IS the caller's next step,
            // not a redirect back here.
            return toolStructuredError({
              ok: false,
              kind: "pdf",
              path: artifactPath,
              error: result.error,
              code: result.code,
              ...(result.hint ? { hint: result.hint } : {}),
            });
          }
          return toolOk({
            mode: "artifact",
            kind: "pdf",
            path: artifactPath,
            handle: hEntry.id,
            sha: shortSha(sha), // C10.1: short display prefix.
            pages: result.pages,
            truncated: result.truncated,
            warnings: result.warnings,
          });
        }

        if (kind === "csv" || kind === "tsv") {
          // csv/tsv is a single table (no worksheet roster), so this mirrors
          // xlsx's TABLE-view branch, not its no-`sheet` roster branch: an
          // explicit range/columns selector passes through; a bare no-selector
          // call serves the bounded head (full → head → columns-only) held to
          // the same inline budget xlsx's no-`sheet` path uses. `ext` (csv/tsv)
          // forces the tab delimiter for .tsv inside csvTable.
          const csvRange = typeof args["range"] === "string" ? args["range"] : undefined;
          const csvColumns = Array.isArray(args["columns"]) ? (args["columns"] as unknown[]).map(String) : undefined;
          const csvMaxRows = typeof args["maxRows"] === "number" ? args["maxRows"] : undefined;
          const csvMaxCells = typeof args["maxCells"] === "number" ? args["maxCells"] : undefined;
          const identity = { path: artifactPath, handle: hEntry.id, sha };
          // FX-O2 (ruling (s), finding 3): the physical line count backing
          // BOTH csv artifact routes' booking below — see
          // `bookCsvArtifactServe`'s doc comment.
          const csvTotalLines = countLines(decodeCsvBytes(bytes));

          if (csvRange !== undefined || csvColumns !== undefined || csvMaxRows !== undefined || csvMaxCells !== undefined) {
            const table = csvTable(bytes, {
              ext,
              ...(csvRange !== undefined ? { range: csvRange } : {}),
              ...(csvColumns !== undefined ? { columns: csvColumns } : {}),
              ...(csvMaxRows !== undefined ? { maxRows: csvMaxRows } : {}),
              ...(csvMaxCells !== undefined ? { maxCells: csvMaxCells } : {}),
            });
            // apparent dead code at HEAD (C2-6 audit, discovered beyond the
            // official 4-site list): csvTable's own body has no observed
            // ok:false return path either — coded honestly regardless.
            if (!table.ok) return toolError(table.error, { code: "corrupt" });
            const csvReceipt = csvArtifactServeReceipt(workspace, identity, csvTotalLines, table, forceContentServe);
            if (csvReceipt !== undefined) return toolOk(attachSupply(csvReceipt, workspace));
            bookCsvArtifactServe(workspace, artifactPath, sha, csvTotalLines, table);
            return toolOk(csvArtifactShape(table, identity));
          }

          const csvQuery = typeof args["query"] === "string" ? args["query"] : undefined;
          if (csvQuery !== undefined && artifactQueryWindowEnabled()) {
            const csvWindow = serveCsvQueryWindow(bytes, ext, identity, { workspace, totalLines: csvTotalLines, forceServe: forceContentServe }, csvQuery, args, defaultResponseByteCeiling);
            if (csvWindow !== undefined && "shape" in csvWindow) return toolOk(csvWindow.shape);
            if (csvWindow !== undefined && "floorBytes" in csvWindow) {
              return toolStructuredError({
                ok: false,
                code: "budget-below-minimum",
                field: "budget",
                error: "this budget cannot hold the row the query located plus its envelope",
                detail: "raise budget.bytes to at least required_min_bytes and re-issue the same call",
                required_min_bytes: csvWindow.floorBytes,
                retry: "call",
              });
            }
            // A table with no data rows has nothing to serve and nothing to continue, and
            // the csv form requires content: say that, rather than fail its required set.
            if (csvWindow !== undefined) {
              return toolStructuredError({
                ok: false,
                code: "invalid-input",
                field: "query",
                error: `${artifactPath} has no data rows to search`,
                detail: "the file is empty or holds only a header; read it without select.kind to see its text",
                retry: "none",
              });
            }
          }
          const csvOut = serveBoundedCsvArtifact(bytes, ext, identity, { workspace, totalLines: csvTotalLines, forceServe: forceContentServe });
          if (csvOut === undefined) return toolError(`Could not parse csv/tsv: ${artifactPath}`, { code: "read-error" });
          return toolOk(csvOut);
        }

        return toolError(`Artifact mode not supported for kind="${kind}". Supported: xlsx, csv, tsv, docx, pptx, pdf.`, { code: "artifact-kind-mismatch" });
      }
  return undefined;
}
