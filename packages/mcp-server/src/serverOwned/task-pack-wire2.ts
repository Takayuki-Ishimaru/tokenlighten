// task-pack-wire — extracted implementation; imports point to the owning modules.
import { isRecordLike } from "./search-support.js";
import { shaOfText } from "../util/handles.js";

/**
 * TL_EFF_EDIT_DIET (B2): the identity of one kit entry — what it says, without
 * the per-serve state that says what the caller holds (`body`, `served_by`)
 * or which of its headers the caller still lacks (`missing_include_handles`).
 * An entry whose body marker moved from "omitted" to "served-earlier" is the
 * same entry; one that gained an inline `code` body is a new one.
 */
export function kitEntryIdentity(family: string, value: unknown): string {
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip);
    if (!isRecordLike(node)) return node;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(node)) {
      if (key === "body" || key === "served_by" || key === "missing_include_handles") continue;
      out[key] = strip(child);
    }
    return out;
  };
  return `${family}:${shaOfText(JSON.stringify(strip(value)))}`;
}

/** TL_EFF_EDIT_DIET (B2): the opening of a kit delta's `note`, which then names what it left out. */
export const KIT_DELTA_NOTE_PREFIX = "delta — already sent by this task's earlier kits and still valid, so not repeated: ";
