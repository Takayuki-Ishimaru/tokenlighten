// ---------------------------------------------------------------------------
// v0.10 internal domain model — continuation reducer state.
//
// SOURCE: DESIGN-v0.10-expansion-plan-v1.3.md §4.3 "共通データモデル",
// "ContinuationControl" (lines 523-546).
//
// THIS IS THE INTERNAL DOMAIN MODEL, NOT THE WIRE PROTOCOL (D-1). See
// `./evidence.ts`'s file header for the shared internal/wire boundary note;
// this module imports nothing from `../mcp/*`.
//
// ContinuationControl IS REDUCER-INTERNAL (D-1, reconciliation §3/§5). Its
// wire projection is the FROZEN THREE-WAY SPLIT that
// DESIGN-v0.10-protocol-v1-contract-freeze.md §4.4 names and forbids
// re-fusing:
//   - `../mcp/protocol.ts`'s `Limit`                — DELIVERY ("what did
//     this response not carry, and how do I get it?")
//   - `../mcp/protocol.ts`'s `CapabilityGap`, riding `TaskDecision`'s
//     `discover.gaps`                                — SEMANTIC ("what can
//     this server not decide?")
//   - `../mcp/protocol.ts`'s `Evidence.remaining`     — PER-SOURCE
//     continuation
// `ContinuationControl` is NEVER serialized as a response object, NEVER a
// wire field, and NEVER emitted under a `continuation` key on any
// `ProtocolResult` member. Reconciliation §3 quotes the frozen rule
// verbatim: "§4.4 three-way split... must not be re-fused" — merging them
// back into one object is the "recurring root-cause class" the split exists
// to forbid.
//
// `next.tool` is narrowed to `"read_file" | "search_files"` (never
// `edit_file`) — a continuation resumes a READ, matching the plan's own
// example and keeping this reducer type free of mutation rights by
// construction, consistent with the D-1 codec/projection note in
// `./evidence.ts`'s file header.
// ---------------------------------------------------------------------------

/**
 * §4.3 "ContinuationControl". Reducer-internal; see the file header. Feeds
 * the wire projection that emits `Limit` / `CapabilityGap` /
 * `Evidence.remaining` — this type itself is never on the wire.
 */
export type ContinuationControl = {
  responseId: string;
  completeness: "complete" | "partial" | "unknown";
  cause?: "capped" | "permission" | "unsupported" | "provider-incomplete";
  limit: {
    requested?: number;
    effectiveBytes: number;
    hostSafeBytes: number;
  };
  /**
   * Present iff a continuation call is constructible. Never a template —
   * see `../mcp/protocol.ts`'s `ToolCall` doc comment ("§2.6 abolishes
   * placeholder-bearing calls") on the wire side of the same rule.
   */
  next?: {
    tool: "read_file" | "search_files";
    arguments: Record<string, unknown> & { continuation_token: string };
    idempotent: true;
  };
  remaining?: {
    items?: number;
    ranges?: string[];
    roles?: string[];
  };
};
