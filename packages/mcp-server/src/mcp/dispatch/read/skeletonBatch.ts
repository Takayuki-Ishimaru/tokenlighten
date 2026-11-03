import type { ToolCallResult } from "../../../protocol/result.js";
import { declareKind, canonicalToolCall } from "../../../protocol/envelope.js";
import "path";
import { getFileSkeleton } from "../../../tools/getFileSkeleton.js";
import { handleTable } from "../../../util/handles.js";
import { recordReadPath } from "../../../state/session.js";
import { toolOk } from "../../../protocol/result.js";
import { resolvePathsBatchEntry } from "../../../serverOwned/canonical-input.js";
import { servedTextForRoute, undecodableTextMessage, nulStrippedNote, skeletonBatchReserveBytes, MULTI_FILE_MAP_CAP_BYTES } from "../../../serverOwned/read-admission2.js";

export interface read_skeletonBatchPort {
  "mode": string;
  "args": Record<string, unknown>;
  "workspace": string;
  "defaultResponseByteCeiling": number | undefined;
}
export async function read_skeletonBatch(port: read_skeletonBatchPort): Promise<ToolCallResult | undefined> {
  const { mode, args, workspace, defaultResponseByteCeiling } = port;
if (mode === "skeleton" && Array.isArray(args["paths"]) && (args["paths"] as unknown[]).length >= 1) {
        declareKind("read.batch");
        // FX-M1/E1: resolve a bare `{handle}` entry (no `path`) to its real
        // path via `resolvePathsBatchEntry` instead of coercing it straight
        // to `""` — the mixed `targets:[{handle},{path}]` batch defect.
        const requestedEntries = (args["paths"] as unknown[]).map((entry) => resolvePathsBatchEntry(entry, workspace));
        const items: Record<string, unknown>[] = [];
        const omitted: Array<{ path: string; handle?: string; reason: string }> = [];
        let servedBytes = 0;
        for (let index = 0; index < requestedEntries.length; index += 1) {
          const { path: requestedPath, handle: requestedHandle, handleReason } = requestedEntries[index]!;
          if (!requestedPath) {
            omitted.push(handleReason !== undefined
              ? { path: requestedPath, handle: requestedHandle, reason: handleReason }
              : { path: requestedPath, reason: "path is required" });
            continue;
          }
          // served-bytes: readServedText
          // BLOCKER 52 (AB1, 2026-09-14, review round 11): this is the route a
          // CANONICAL `content:"outline"` batch actually takes — normalizeWireArgs
          // rewrites `content:"outline"` to `mode:"skeleton"` internally, DOWNSTREAM
          // of the legacy-input gate that refuses the explicit `mode:"skeleton"`
          // spelling, which is why rounds 6-10 never probed it. It read through
          // `readFileSafe`, the LENIENT decoder, and therefore served exactly the
          // bytes the single-target form of the SAME request refuses: a BOM-less
          // UTF-16 save shipped 63 escaped NULs and a Shift-JIS file an 80-U+FFFD
          // mojibake skeleton, each under a freshly minted handle. One policy, the
          // same shape `mode:"map"`'s batch already uses: an `undecodable` file
          // becomes an `omitted` row carrying the reason, never a served entry.
          // served-bytes: readServedText
          const skelVerdict = await servedTextForRoute(requestedPath, workspace);
          if (skelVerdict !== null && skelVerdict.kind === "undecodable") {
            omitted.push({ path: requestedPath, reason: undecodableTextMessage(requestedPath, skelVerdict) });
            continue;
          }
          const content = skelVerdict === null ? null : skelVerdict.text;
          if (content === null) { omitted.push({ path: requestedPath, reason: "File not found or outside workspace" }); continue; }
          const skeleton = await getFileSkeleton(content, { path: requestedPath });
          if (!skeleton.ok) { omitted.push({ path: requestedPath, reason: skeleton.error }); continue; }
          const entry: Record<string, unknown> = {
            path: requestedPath,
            language: skeleton.data.language,
            handle: handleTable.upsert({ kind: "file", path: requestedPath, workspaceRoot: workspace }).id,
            // SHOULD-FIX 57: a `stripped` serve is never silent. The skeleton is
            // a projection OF THE STRIPPED TEXT, so the entry says so.
            ...nulStrippedNote(skelVerdict),
            // `read.batch`'s established file-entry vocabulary is content,
            // not a second skeleton-only union arm. Preserve the exact
            // signature projection there so the common batch projector and
            // wire predicates retain it end to end.
            content: JSON.stringify(skeleton.data.signatures),
            signatures: skeleton.data.signatures,
            truncated: skeleton.data.truncated,
          };
          // 2026-10-24 (read-page ceiling): a client with a response ceiling gets
          // an outline batch cut to it HERE, at an entry boundary, with this
          // loop's own `next` (`content:"outline"` for the paths left). The emit
          // tail's whole-entry rung cannot do it: a dropped outline entry is a
          // `file`-form entry, whose recovery it spells `mode:"full"` -- the
          // WHOLE file for an outline, a different and much larger read. The
          // legacy cost below counts each entry twice (its signatures ride both
          // as `content` and as `signatures`) and the wire carries once, so for
          // such a client the ONE measurement this loop takes is of the entry the
          // batch projector will write (`form:"file"`, `content` only), and the
          // ceiling is judged on the running sum of those plus the envelope and
          // the `next` for every path that would be left. A client without a
          // ceiling is measured exactly as before. The first entry always ships
          // (a cap may bound a batch, never zero it: an outline wider than the
          // ceiling would otherwise refuse itself forever, its `next` the same
          // call).
          const measuredEntry: Record<string, unknown> = defaultResponseByteCeiling !== undefined
            ? { form: "file", path: requestedPath, truncated: entry["truncated"], handle: entry["handle"], content: entry["content"] }
            : entry;
          const entryBytes = Buffer.byteLength(JSON.stringify(measuredEntry), "utf8") + 1;
          const ceilingExceeded = defaultResponseByteCeiling !== undefined && items.length > 0
            && servedBytes + entryBytes + skeletonBatchReserveBytes(workspace, requestedEntries.slice(index + 1).map((rest) => rest.path))
              > defaultResponseByteCeiling;
          if (servedBytes + entryBytes > MULTI_FILE_MAP_CAP_BYTES || ceilingExceeded) {
            omitted.push({ path: requestedPath, reason: "skeleton-byte-cap" });
            for (const remainder of requestedEntries.slice(index + 1)) omitted.push({ path: remainder.path, reason: "skeleton-byte-cap" });
            break;
          }
          servedBytes += entryBytes;
          items.push(entry);
          recordReadPath(workspace, requestedPath);
        }
        const remaining = omitted.filter((entry) => entry.reason === "skeleton-byte-cap").map((entry) => entry.path);
        return toolOk({
          mode: "skeleton",
          items,
          omitted,
          completeness: omitted.length === 0 ? "complete" : items.length === 0 ? "empty" : "partial",
          ...(remaining.length > 0 ? {
            remaining,
            next: canonicalToolCall("tl_read_file", {
              targets: remaining.map((path) => ({ path })),
              content: "outline",
            }),
          } : {}),
        });
      }
  return undefined;
}
