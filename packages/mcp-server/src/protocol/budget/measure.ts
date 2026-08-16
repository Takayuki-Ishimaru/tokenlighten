// ---------------------------------------------------------------------------
// protocol v1 — the ONE response-level byte count (P3a S1).
//
// NORMATIVE SOURCE: TL-PROTOCOL-V1-PHASE3A-PLAN-DRAFT.md §4.1 ("What is
// measured, and where"); DESIGN-v0.10-protocol-v1-contract-freeze.md A.6.2
// (`WireBudget`/`ShedRecord`, internal, not wire).
// ---------------------------------------------------------------------------

/**
 * THE ONLY SANCTIONED RESPONSE-LEVEL MEASUREMENT IN THIS SERVER.
 *
 * Post-serialization UTF-8 bytes of the response BODY — the JSON string that
 * becomes `content[0].text`. Taken exactly once per emission, by
 * `protocol/emit.ts`, and nowhere else at response level. G8's future grep
 * fence (S6) is written against this function: a second response-level
 * `Buffer.byteLength` anywhere in `src/protocol/` is the defect it looks for.
 *
 * TWO BOUNDARIES, stated so they are not re-litigated (plan §4.1):
 *
 *  1. THE BODY, NOT THE MCP ENVELOPE. §7.1's byte baselines and all fifteen
 *     `__tests__/fixtures/wire-baselines/*.json` pins hold the response body
 *     alone, so the budget denominates the body. The transport wraps it in
 *     `{"content":[{"type":"text","text":…}]}` — a 38 B constant frame plus
 *     JSON string-escaping of the body itself, which is payload-dependent
 *     (roughly +1 B per quote and backslash, so a code-bearing pack inflates
 *     more than a receipt). That frame + escaping headroom belongs to the
 *     misconfiguration floor check (plan §7.4), never to a per-kind limit.
 *     Anyone who later wants a wire-EXACT budget must change the instrument
 *     deliberately rather than discover the gap.
 *
 *  2. `Buffer.byteLength(…, "utf8")`, matching the instrument every existing
 *     regression fence already uses (`__tests__/responseCap.spec.ts`: "All
 *     byte measurements use `Buffer.byteLength(..., 'utf8')`"). A different
 *     instrument would silently re-baseline every one of those specs.
 *
 * THIS FUNCTION IS PURE AND HAS NO WIRE EFFECT. Measuring a response never
 * changes it; S1 is calibrated so that no legitimate response is ever over
 * budget (see `wireBudget.ts`), which is what makes the whole stage
 * byte-invisible on the wire.
 */
export function measureResponseBytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}
