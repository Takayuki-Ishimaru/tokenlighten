// dispatch-funnel — extracted implementation; imports point to the owning modules.
import * as path from "path";
import type { ToolCallResult } from "../protocol/result.js";
import { dispatchEdit } from "../mcp/dispatch/dispatchEdit.js";
import { dispatchRead } from "../mcp/dispatch/dispatchRead.js";
import { dispatchSearch } from "../mcp/dispatch/dispatchSearch.js";
import { normalizeWireArgs } from "./canonical-input4.js";
import { otherActiveRoots } from "../state/session.js";
import { renamedToolName } from "@tokenlighten/types";
import { resolveClientProfile } from "../protocol/codec/clientProfile.js";
import { resolveDefaultResponseByteCeiling } from "../protocol/codec/clientProfile.js";
import { resolvedClientId } from "../runtime/config.js";
import { toolError } from "../protocol/result.js";
import { toolStructuredError } from "../protocol/result.js";

export async function dispatchTool(canonical: string, rawArgs: Record<string, unknown>): Promise<ToolCallResult> {
const normalized = normalizeWireArgs(canonical, rawArgs);
  if ("refusal" in normalized) return toolStructuredError(normalized.refusal);
  const args = normalized.args;
  // T1/T2/T3 (2026-08-27 field-eval): resolve the DEFAULT response byte
  // ceiling once per dispatch -- explicit per-call maxBytes/maxTokens (read
  // at each serve site below) always override this; this is only the
  // fallback consulted when the caller supplies neither. Cheap (an env read
  // plus a Map lookup) and harmless to compute unconditionally even for a
  // tool call that never consults it (tl_edit_file, mode=slice, ...). See
  // clientProfile.ts's resolveDefaultResponseByteCeiling for the
  // env/profile precedence.
  const defaultResponseByteCeiling = resolveDefaultResponseByteCeiling(
    resolveClientProfile(resolvedClientId()),
    process.env["TOKENLIGHTEN_TASK_PACK_MAX_BYTES"],
  );

switch(canonical) {
case "tl_read_file": { const result = await dispatchRead({ args, defaultResponseByteCeiling }); if (result !== undefined) return result; throw new Error("dispatch fell through: tl_read_file"); }
case "tl_edit_file": { const result = await dispatchEdit({ args, defaultResponseByteCeiling }); if (result !== undefined) return result; throw new Error("dispatch fell through: tl_edit_file"); }
case "tl_search_files": { const result = await dispatchSearch({ args, defaultResponseByteCeiling }); if (result !== undefined) return result; throw new Error("dispatch fell through: tl_search_files"); }
default: return toolError(unknownToolMessage("Unknown tool", canonical), { code: "invalid-input" });
}
}

/**
 * The unknown-tool message. A pre-`tl_` name (`read_file`, 2026-10-02) is
 * refused like any other stranger (D11) but the message names its current
 * name, so a caller with a stale tool list knows to refresh it.
 */
export function unknownToolMessage(prefix: string, name: string): string {
  const renamed = renamedToolName(name);
  return renamed === undefined
    ? `${prefix}: ${name}`
    : `${prefix}: ${name} (renamed ${renamed}; refresh the tool list)`;
}

/** Guard 1 root_note hard length cap (2026-07-12b) — see dispatchWithWorkspaceNotes. */
export const MAX_ROOT_NOTE_CHARS = 160;

/**
 * Canonical tool names Guard 1's root_note rides on.
 *
 * READ side (2026-07-12b): tl_read_file/tl_search_files.
 *
 * WRITE side (2026-08-01): every entry point that can WRITE through a
 * silently-defaulted root. A wrong-root READ costs a turn; a wrong-root
 * WRITE lands bytes in a tree the caller never named and reports plain
 * success — measured in bench 2026-08-01-semantic-signal5-2 (T13 rep2),
 * where a cwd-less `tl_edit_file {path:"bench/fixtures/.../x.cpp",
 * create:true}` created a 4937-byte file in the server's own default
 * checkout and answered `{"ok":true,...}` with nothing naming the root.
 * The write paths must therefore self-identify at least as loudly as the
 * read paths. D11: tl_edit_file is now the ONLY write entry point — the four
 * deprecated write aliases that used to share this seam are deleted.
 */
export const ROOT_NOTE_READ_TOOLS = new Set(["tl_read_file", "tl_search_files"]);

export const ROOT_NOTE_WRITE_TOOLS = new Set(["tl_edit_file"]);

/**
 * True when the call pins its own workspace through a handle rather than the
 * ambient default root. A handle carries its mint root (and tl_edit_file adopts
 * that root when cwd is omitted), so such a call is never a silent
 * default-root resolution. `edits[].handle` is the batch-write analogue of
 * `handles[]`; read paths never carry `edits`, so read behavior is unchanged.
 */
export function callPinsRootViaHandle(args: Record<string, unknown>): boolean {
  if (typeof args["handle"] === "string") return true;
  const handles = args["handles"];
  if (Array.isArray(handles) && handles.length > 0) return true;
  const edits = args["edits"];
  if (Array.isArray(edits)) {
    for (const entry of edits) {
      if (
        entry
        && typeof entry === "object"
        && typeof (entry as Record<string, unknown>)["handle"] === "string"
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Guard 1's note text, shared verbatim by the read and write paths so one
 * `root_note` shape (and one length cap) covers both.
 *
 * Returns undefined when no OTHER workspace is active this server lifetime:
 * with a single root there is no ambiguity to disclose, and consumers treat
 * any root_note as a hard "this response came from the wrong tree" marker,
 * so it must never fire on the unambiguous case.
 */
export function rootMismatchNote(resolvedRoot: string): string | undefined {
  const others = otherActiveRoots(resolvedRoot);
  if (others.length === 0) return undefined;
  const otherNames = others.slice(0, 2).map((r) => path.basename(r)).join(", ");
  let note = `resolved against server default root ${path.basename(resolvedRoot)}; other active workspace(s): ${otherNames} — pass cwd if you meant one of those`;
  if (note.length > MAX_ROOT_NOTE_CHARS) note = note.slice(0, MAX_ROOT_NOTE_CHARS - 1) + "…";
  return note;
}
