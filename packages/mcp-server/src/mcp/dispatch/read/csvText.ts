import type { ToolCallResult } from "../../../protocol/result.js";
import { readBytesSafe } from "../../../util/safePath.js";
import { toolError, toolOk } from "../../../protocol/result.js";
import { TINY_BYTES } from "../../../util/fullGovernor.js";
import { shaOfBytes, handleTable } from "../../../util/handles.js";
import { countLines } from "../../../util/countLines.js";
import { decodeCsvBytes } from "../../../office/csv.js";
import { declareKind } from "../../../protocol/envelope.js";
import { recordReadPath } from "../../../state/session.js";
import { attachSupply } from "../../../util/attachSupply.js";
import { serveBoundedCsvArtifact } from "../../../serverOwned/artifact-csv2.js";

export interface read_csvTextPort {
  "ext": string;
  "mode": string;
  "filePath": string;
  "workspace": string;
  "forceContentServe": boolean;
}
export async function read_csvText(port: read_csvTextPort): Promise<ToolCallResult | undefined> {
  const { ext, mode, filePath, workspace, forceContentServe } = port;
if ((ext === "csv" || ext === "tsv") && (mode === "auto" || mode === "skeleton" || mode === "symbol")) {
        // served-bytes: not-served (csv/tsv container bytes: decodeCsvBytes / serveBoundedCsvArtifact owns the decode)
        const csvBytes = await readBytesSafe(filePath, workspace);
        if (csvBytes === null) return toolError(`File not found or outside workspace: ${filePath}`, { code: "not-found" });
        if (csvBytes.length > TINY_BYTES) {
          const csvSha = shaOfBytes(csvBytes);
          const csvHEntry = handleTable.upsert({ kind: "file", path: filePath, workspaceRoot: workspace, sha: csvSha });
          // FX-O2 (ruling (s), finding 3): this is the THIRD ship-and-book-
          // nothing route (see `bookCsvArtifactServe`'s doc comment) — a bare
          // `tl_read_file path=x.csv` auto-mode call on a large csv/tsv.
          const csvOut = serveBoundedCsvArtifact(csvBytes, ext, { path: filePath, handle: csvHEntry.id, sha: csvSha }, {
            workspace,
            totalLines: countLines(decodeCsvBytes(csvBytes)),
            // FX-P1 (ruling (u)): the same forced-serve escape the other two
            // csv routes honour — a compacted caller's `force_serve`/
            // `allowFull` must get bytes, never a receipt (DESIGN-v0.15 §6.3
            // (R6): `content:"full"` alone no longer does).
            forceServe: forceContentServe,
          });
          if (csvOut !== undefined) {
            // Third implicit-artifact route (see the xlsx roster branch): a
            // size-gated csv/tsv serves `columns`/`rows`, an A.5.5 `csv`
            // content form, on a request whose mode is still `auto`.
            declareKind("read.artifact");
            recordReadPath(workspace, filePath);
            return toolOk(attachSupply(csvOut, workspace));
          }
          // csvTable failed unexpectedly (should not happen for text) — fall
          // through to the generic text pipeline rather than hard-erroring.
        }
        // small csv/tsv (<= TINY_BYTES): fall through to today's text behavior.
      }
  return undefined;
}
