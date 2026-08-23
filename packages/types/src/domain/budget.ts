// ---------------------------------------------------------------------------
// v0.10 internal domain model — host response-size budget profile.
//
// SOURCE: DESIGN-v0.10-expansion-plan-v1.3.md §4.3 "共通データモデル", and
// PI-01 "大容量responseで`limit`・`next`が末尾ごと切れる" §実装内容 item 1
// (lines 971-980), which introduces `HostBudgetProfile` ahead of §4.3's own
// listing.
//
// THIS IS THE INTERNAL DOMAIN MODEL, NOT THE WIRE PROTOCOL (D-1). See
// `./evidence.ts`'s file header for the shared internal/wire boundary note;
// this module imports nothing from `../mcp/*`.
//
// PI-01 is already MATURE at the real baseline (reconciliation §2: "Single
// emit funnel... the only sanctioned byte measurement... 13 per-kind
// shedders + ladder"). `HostBudgetProfile` names the input that funnel's
// host-safe segmentation stage reads; it does not replace any of the
// existing `budget/measure.ts` / `budget/ladder.ts` / `budget/wireLimit.ts`
// machinery, and this package does not implement that machinery (no I/O, no
// server logic — see `packages/mcp-server`).
// ---------------------------------------------------------------------------

/**
 * The response-size ceiling this server negotiates or assumes for the
 * current client. Feeds the two-stage emitter pipeline's "body candidateを
 * safe budget内へsource-level split" stage (PI-01 実装内容 item 2 — "split
 * the body candidate into the safe budget at source level").
 */
export type HostBudgetProfile = {
  maxToolResultBytes: number;
  safetyReserveBytes: number;
  /** Emitted iff the client advertises a separate text-content sub-limit; absence means only `maxToolResultBytes` applies. */
  maxTextContentBytes?: number;
  source: "client-capability" | "client-profile" | "server-default";
};
