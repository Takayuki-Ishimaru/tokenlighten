import type { ToolCallResult } from "../../../protocol/result.js";
import { recordReadMode, recordReadPath } from "../../../state/session.js";
import { toolError, toolOk, toolStructuredError } from "../../../protocol/result.js";
import { safeResolve } from "../../../util/safePath.js";
import { existsSync, statSync } from "node:fs";
import { getFileSkeleton } from "../../../tools/getFileSkeleton.js";
import { handleTable } from "../../../util/handles.js";
import { canonicalToolCall } from "../../../protocol/envelope.js";
import { resolveMap } from "../../../tools/readCodeModes.js";
import { servedTextForRoute, undecodableTextMessage, MULTI_FILE_MAP_CAP_BYTES } from "../../../serverOwned/read-admission2.js";
import { mapMissRefusalCode } from "../../../serverOwned/task-pack-wire.js";

export interface read_mapPort {
  "mode": string;
  "workspace": string;
  "args": Record<string, unknown>;
  "resolvedPath": string | undefined;
  "resolvedSymbol": string | undefined;
}
export async function read_map(port: read_mapPort): Promise<ToolCallResult | undefined> {
  const { mode, workspace, args, resolvedPath, resolvedSymbol } = port;
if (mode === "map") {
        recordReadMode(workspace, "map");
        // mode=map paths=[...] — multi-file signature map. 2026-07-16 skc2
        // microbench Q1: paths[] was ignored entirely here (map required a
        // query and answered through the 1024-byte surface locator), so the
        // product's only 64KB-capped multi-file map (skeleton-engine's
        // buildSkeleton/renderSkeleton) was unreachable from the MCP tool
        // surface — and nothing enforced ANY total budget on a multi-file
        // map-shaped serve. This branch serves one per-file signature block
        // per requested file (each block already capped by getFileSkeleton's
        // own MAX_RESPONSE_BYTES) and enforces MULTI_FILE_MAP_CAP_BYTES over
        // the serialized files[] section with 5b252d24's trim semantics:
        // deterministic FILE-BOUNDARY trim — request order, whole blocks
        // dropped from the tail once the budget is exhausted, never a
        // mid-block cut — plus the explicit 'tokenlighten:skeleton-truncated'
        // indicator skeleton-engine's footer uses. The singular
        // query/path/symbol surface-locator map below is unchanged.
        const mapPathsRaw = Array.isArray(args["paths"]) ? (args["paths"] as unknown[]) : [];
        if (mapPathsRaw.length > 0) {
          if (typeof args["query"] === "string" && (args["query"] as string).trim().length > 0) {
            return toolError("paths[] and query are mutually exclusive for mode=map", { code: "invalid-input" });
          }
          // Same bare-string/object coercion as mode=full's batch below;
          // duplicates collapse to the first occurrence so the tail trim
          // stays order-deterministic.
          const mapPaths = [...new Set(mapPathsRaw.map((p) =>
            typeof p === "object" && p !== null ? String((p as Record<string, unknown>)["path"] ?? "") : String(p),
          ))];
          const mapFiles: Record<string, unknown>[] = [];
          const mapOmitted: Array<{ path: string; reason: string }> = [];
          let mapServedBytes = 0;
          let mapCapReached = false;
          for (const p of mapPaths) {
            if (!p) { mapOmitted.push({ path: p, reason: "path is required" }); continue; }
            if (mapCapReached) { mapOmitted.push({ path: p, reason: "map-byte-cap" }); continue; }
            // served-bytes: readServedText
            const mapVerdict = await servedTextForRoute(p, workspace);
            if (mapVerdict !== null && mapVerdict.kind === "undecodable") {
              // A batch entry is omitted with its reason, never a whole-call
              // refusal (the established batch precedent), but it is never
              // served either.
              mapOmitted.push({ path: p, reason: undecodableTextMessage(p, mapVerdict) });
              continue;
            }
            const mapContent = mapVerdict === null ? null : mapVerdict.text;
            if (mapContent === null) {
              const mapAbs = safeResolve(p, workspace);
              const mapIsDir = mapAbs !== undefined && existsSync(mapAbs) && statSync(mapAbs).isDirectory();
              mapOmitted.push({
                path: p,
                reason: mapIsDir
                  ? 'is a directory — pass file paths; for inventory use tl_search_files {action:"tree", scope:{path:"<dir>"}}'
                  : `File not found or outside workspace: ${p}`,
              });
              continue;
            }
            const blockResult = await getFileSkeleton(mapContent, { path: p });
            if (!blockResult.ok) { mapOmitted.push({ path: p, reason: blockResult.error }); continue; }
            const entry: Record<string, unknown> = {
              path: p,
              language: blockResult.data.language,
              handle: handleTable.upsert({ kind: "file", path: p, workspaceRoot: workspace }).id,
              signatures: blockResult.data.signatures,
              truncated: blockResult.data.truncated,
              // SHOULD-FIX 57: the strip statement for this door rides the
              // RESPONSE, not the entry — `read.map`'s `files` form keeps only
              // path/handle/language/signatures per entry and keeps `note` at
              // the outline level, which `servedTextForRoute` + the
              // `projectSuccessBody` funnel already fill.
            };
            // Serialized-entry accounting (+1 for the array separator): the
            // budget covers path/handle overhead, not just signature text, so
            // the files[] section as a whole can never exceed the cap.
            const entryBytes = Buffer.byteLength(JSON.stringify(entry), "utf8") + 1;
            if (mapServedBytes + entryBytes > MULTI_FILE_MAP_CAP_BYTES) {
              mapCapReached = true;
              mapOmitted.push({ path: p, reason: "map-byte-cap" });
              continue;
            }
            mapServedBytes += entryBytes;
            mapFiles.push(entry);
            recordReadPath(workspace, p);
          }
          const mapTrimmed = mapOmitted.filter((o) => o.reason === "map-byte-cap");
          return toolOk({
            mode: "map",
            files: mapFiles,
            omitted: mapOmitted,
            completeness: mapOmitted.length === 0 ? "complete" : mapFiles.length === 0 ? "empty" : "partial",
            truncated: mapTrimmed.length > 0,
            ...(mapTrimmed.length > 0
              ? {
                  map_cap_bytes: MULTI_FILE_MAP_CAP_BYTES,
                  note: `${mapTrimmed.length} file block(s) omitted to fit map_cap_bytes — tokenlighten:skeleton-truncated; re-scope with fewer paths[]`,
                  next: canonicalToolCall("tl_read_file", {
                    targets: mapTrimmed.slice(0, 3).map((o) => ({ path: o.path })),
                    content: "outline",
                  }),
                }
              : {}),
          });
        }
        const mapResult = await resolveMap(workspace, {
          query: args["query"] ? String(args["query"]) : resolvedPath ?? resolvedSymbol ?? "",
          ...(resolvedPath ? { path: resolvedPath } : {}),
          ...(resolvedSymbol ? { symbol: resolvedSymbol } : {}),
          ...(args["lang"] ? { lang: String(args["lang"]) } : {}),
        });
        if (!mapResult.ok) {
          // Row 11 (C2-6): a genuine refusal, not a made-up hit:false success
          // shape — see mapMissRefusalCode's doc comment.
          return toolStructuredError({
            ok: false,
            code: mapMissRefusalCode(mapResult.reason),
            detail: mapResult.reason,
          });
        }
        return toolOk(mapResult.data);
      }
  return undefined;
}
