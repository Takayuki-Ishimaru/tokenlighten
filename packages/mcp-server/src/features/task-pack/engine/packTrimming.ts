// packTrimming — extracted implementation; imports point to the owning modules.
import type { TaskPackResult } from "../model.js";
import { CALL_RE } from "./packSettlement2.js";
import { CALL_STOPWORDS } from "./packSettlement2.js";
import { COMMON_BUILTIN_CALLEES } from "../evidenceClosure.js";
import { MAX_CALLEES_SCANNED } from "./packSettlement2.js";
import { protocolCallContext } from "../../../protocol/envelope.js";
import { taskPackSizePreview } from "../../../protocol/taskPackSizePreview.js";

/**
 * R2 (2026-08-28): is this call RECEIVER-QUALIFIED (`Math.round(`, `a?.b(`,
 * a fluent chain)? A qualified call is not a workspace-local definition the
 * caller could serve, so counting it would claim the pack should have in
 * fact served every real callee's definition.
 *
 * Whitespace is skipped so a fluent chain broken across lines is still seen as
 * qualified; nothing else about the scan changes.
 */
export function isReceiverQualified(code: string, matchIndex: number): boolean {
  let cursor = matchIndex - 1;
  while (cursor >= 0 && /\s/u.test(code[cursor]!)) cursor -= 1;
  return cursor >= 0 && code[cursor] === ".";
}

/** Existing TS/JS call-form extractor, used by one-hop proof expansion. */
export function calleesOf(code: string, own: readonly string[]): string[] {
  const out: string[] = [];
  const ownLower = new Set(own.map((s) => s.toLowerCase()));
  CALL_RE.lastIndex = 0;
  for (let m = CALL_RE.exec(code); m !== null; m = CALL_RE.exec(code)) {
    const name = m[1]!;
    if (CALL_STOPWORDS.has(name.toLowerCase())) continue;
    // P2-16 (round-4 fable finding, 2026-09-28): a runtime/standard-library
    // global (`encodeURIComponent`, `fetch`, `setTimeout`, ...) can never be
    // an in-workspace dependency DEFINITION, so counting it here only ever
    // manufactures a dependency-definitions obligation that can never be
    // discharged — confirmed live (manyCallers: every one of 30 handler
    // bodies calls `encodeURIComponent(id)`, so the final `act.answer`
    // disclosed `explicit-gap:dependency-definitions:encodeURIComponent`
    // forever). Reuses evidenceClosure.ts's own builtin-callee list (its
    // `calleeNamesIn` guards the identical concern for the facet-closure
    // callee walk) rather than a second, drifting copy.
    if (COMMON_BUILTIN_CALLEES.has(name)) continue;
    if (ownLower.has(name.toLowerCase())) continue;
    if (isReceiverQualified(code, m.index)) continue;
    if (!out.includes(name)) out.push(name);
    if (out.length >= MAX_CALLEES_SCANNED) break;
  }
  return out;
}

/**
 * The serialized size of the pack as it stands.
 *
 * Extracted from `fitsInCap` (2026-09-04, FX-OH F1) so the caller-named
 * frontier join can size its bounded body against the pack's LIVE headroom
 * through the SAME measurement the shedder itself uses — one Class-C
 * pre-shed byte-measurement site for both, never a second one that could
 * drift from it (see wireBudgetG8Fence.spec.ts's ratchet).
 */
export function packWireBytes(result: TaskPackResult): number {
  return taskPackSizePreview(result, protocolCallContext()?.clientId)
    ?? Buffer.byteLength(JSON.stringify(result), "utf8");
}
