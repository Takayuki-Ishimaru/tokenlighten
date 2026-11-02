/**
 * The file windows a `tl_read_file` response actually served, for settling
 * symbol baselines (see `readBaseline.ts`). Kept apart from the pure baseline
 * measurement because it reads the response through `protocol/envelope.ts`.
 */

import { servedWindowsOf } from "../protocol/envelope.js";
import type { ServedBaselineWindow } from "./readBaseline.js";

/**
 * `{path, start, end}` windows declared by a response's JSON text (the same
 * structural walk the served-range ledger uses). Empty for non-JSON text, a
 * refusal, or a response that declares no window.
 */
export function servedWindowsOfResultText(text: unknown): ServedBaselineWindow[] {
  if (typeof text !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    return servedWindowsOf(parsed as Record<string, unknown>).windows;
  } catch {
    return [];
  }
}
