// ---------------------------------------------------------------------------
// v0.10 internal domain model — coverage reducer state.
//
// SOURCE: DESIGN-v0.10-expansion-plan-v1.3.md §4.3 "共通データモデル",
// "CoverageState" (lines 548-560).
//
// THIS IS THE INTERNAL DOMAIN MODEL, NOT THE WIRE PROTOCOL (D-1). See
// `./evidence.ts`'s file header for the shared internal/wire boundary note;
// this module imports nothing from `../mcp/*`.
//
// REDUCER-INTERNAL, NEVER A WIRE OBJECT (D-1, reconciliation §3/§5).
// `CoverageState` is the accumulator a pack-building reducer folds
// required-role coverage into as evidence is gathered. It is NEVER
// serialized as a response field. Its wire projection is
// `../mcp/decision.ts`'s `TaskRef` (`coverage: "complete"|"focused"|
// "partial"` + `coverage_reason`) for surface-IDENTIFICATION coverage, and
// `../mcp/protocol.ts`'s `CapabilityGap[]` riding `TaskDecision`'s
// `discover.gaps` for the SEMANTIC half — never a merged `CoverageState`-
// shaped object on the wire. Reconciliation §3, verbatim: "the plan's
// `ContinuationControl` and `CoverageState` become internal domain types
// only (reducer inputs/outputs), never wire objects."
//
// `blockingGaps[].role` is deliberately typed `string`, not `EvidenceRole`
// (`./evidence.js`): §4.3 leaves it open, and narrowing it to the closed
// `EvidenceRole` union here would make a reducer state that names a
// not-yet-modeled required role fail to type-check even though the plan's
// own shape allows it. Most values in practice ARE `EvidenceRole` members.
// ---------------------------------------------------------------------------

/**
 * §4.3 "CoverageState". Reducer-internal; see the file header. Tracks
 * whether the required-role surface of a task is covered, independent of
 * delivery (`ContinuationControl`, `./continuation.js`) and of any one
 * evidence item's identity (`EvidenceIdentity`, `./evidence.js`).
 */
export type CoverageState = {
  status: "complete" | "partial" | "unknown";
  requiredRoles: string[];
  coveredRoles: string[];
  blockingGaps: Array<{ id: string; role: string; reason: string }>;
  optionalFollowups: Array<{ id: string; reason: string }>;
  omittedRequired: string[];
  providerCoverage: "complete" | "partial" | "unknown";
};
