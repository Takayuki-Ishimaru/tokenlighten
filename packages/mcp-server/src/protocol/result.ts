import type { RefusalCode } from "@tokenlighten/types";

import { supplyRefusalGuidance } from "../util/attachSupply.js";

/** Success/refusal shape returned by MCP tool dispatch. */
export type ToolCallResult = {
  content: Array<{ type: string; text: string }>;
  isError?: true;
  /**
   * PI-03: HOST-VISIBLE result metadata. Never part of `content[*].text`, so
   * it is never in the model-facing payload and never in the byte budget the
   * cost model measures — deviation D-3's position ("telemetry + `_meta` only,
   * not response body") applied to the one value that has to reach the client
   * HOST rather than the model: the issued `context_handle`.
   *
   * Absent on every default-path response. Nothing that already emits a result
   * sets it, so the frozen 15-kind wire is untouched (wireBaselines and the
   * replay corpus both read `content[0].text`).
   */
  _meta?: Record<string, unknown>;
};

/**
 * Optional recovery context a refusal site can attach so the caller can act
 * without re-deriving what it already sent. Everything here is optional: with
 * none of it, toolError still default-carries guidance (see toolStructuredError
 * → supplyRefusalGuidance), so no refusal can ship as a bare
 * `{ok:false,error}` dead end again.
 */
export interface RefusalRecovery {
  /** The file this refusal is about — turns generic guidance into a path retry. */
  path?: string;
  /** A handle the caller can actually resolve (never a stale/unknown one). */
  handle?: string;
  /** A concrete, copy-pasteable next call. Wins over any derived default. */
  next?: string;
  /** One-line explanation of the constraint that was violated. */
  hint?: string;
  /**
   * C2-6: the A.7.1 `RefusalCode` this bare-string `toolError` site carries.
   * `toolError` never had a slot for one — the ~74 call sites A.7.1
   * consequence 1 found were exactly the sites with no `code` field to put
   * one in — so a site that needs an explicit code threads it through here
   * instead of hand-building a `toolStructuredError` object.
   */
  code?: RefusalCode;
}

/**
 * Plain-message refusal. Routed through toolStructuredError (and therefore
 * supplyRefusalGuidance) rather than serializing `{ok:false,error}` directly:
 * this is the highest-traffic refusal helper in the server (~70 read/search
 * sites), and every one of those used to emit a payload with nothing for the
 * caller to do next — a pure-loss turn whose only cheap recovery was a native
 * read. `recovery` lets a site that KNOWS the path/handle/next say so; sites
 * that do not still inherit the derived default.
 */
export function toolError(
  message: string,
  recovery?: RefusalRecovery,
): { content: Array<{ type: string; text: string }>; isError: true } {
  return toolStructuredError({
    ok: false,
    error: message,
    ...(recovery?.code !== undefined ? { code: recovery.code } : {}),
    ...(recovery?.path !== undefined ? { path: recovery.path } : {}),
    ...(recovery?.handle !== undefined ? { handle: recovery.handle } : {}),
    ...(recovery?.next !== undefined ? { next: recovery.next } : {}),
    ...(recovery?.hint !== undefined ? { hint: recovery.hint } : {}),
  });
}

/**
 * Structured error: same transport shape as toolError but carries a rich JSON
 * payload. 2026-07-16a review round 2, DEFECT A: this is the actual shared
 * exit for MOST refusals (57+ call sites) — attachSupply only ever sees the
 * task_pack/pack-shaped ones (dispatch wraps those in toolOk, not this).
 * Without deriving guidance here too, a refusal returned straight from a
 * mode handler (e.g. resolveSlice's "symbol or range is required" refusal)
 * carried a bare path and nothing for the caller to do next. Mirrors
 * attachSupply's own never-break-a-response contract: a derivation bug must
 * never turn a working refusal into a worse one.
 *
 * C2-6 / A.9.2 row 3: the first (refusal-shaped) overload requires `code`
 * so a literal refusal object is checked against A.7.1's closed
 * `RefusalCode` enum at its call site. This is NOT yet the full
 * `ProtocolResult`-typed boundary A.9.2 row 3 describes as the eventual
 * closure proof — the ~115 already-self-coded call sites pass results
 * whose upstream `.code` fields are typed plain `string` (or are cast
 * `as unknown as Record<string, unknown>`) before reaching here, so
 * requiring `ProtocolResult` throughout would ripple into retyping those
 * upstream failure unions repo-wide (the "explodes" case this row's own
 * text anticipates). The second, structural overload is the deliberately
 * loose landing point that keeps those sites compiling; `tsc` therefore
 * checks NEW literal-shaped refusals but does not yet PROVE every refusal
 * carries a code — that proof is future work.
 */
export function toolStructuredError(
  data: Record<string, unknown> & { ok: false; code: RefusalCode },
): { content: Array<{ type: string; text: string }>; isError: true };
export function toolStructuredError(
  data: Record<string, unknown>,
): { content: Array<{ type: string; text: string }>; isError: true };
export function toolStructuredError(data: Record<string, unknown>): { content: Array<{ type: string; text: string }>; isError: true } {
  let payload = data;
  if ((data as { ok?: boolean }).ok === false) {
    try {
      payload = supplyRefusalGuidance(data);
    } catch {
      payload = data;
    }
  }
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    isError: true,
  };
}

export function toolOk(data: unknown): { content: Array<{ type: string; text: string }> } {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
  };
}
