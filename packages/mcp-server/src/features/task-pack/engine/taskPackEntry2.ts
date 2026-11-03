// taskPackEntry — extracted implementation; imports point to the owning modules.


// ---------------------------------------------------------------------------
// Semantic Frontier v0.15 — the task_pack state seam (W-SATISFACTION).
//
// DESIGN-v0.15-semantic-frontier-plan.md §3.2 (context/keying), §3.3
// (lifecycle: record what was served, then apply the kind table), §11 Wave 3.
//
// WHAT THIS WAVE DOES AND DOES NOT DO. It builds the `SfTaskContext` from what
// the pack already holds, extracts the task's structural concerns, opens the
// IR v2 record, catalogs the surfaces this pack SERVED, discharges the
// concerns those bodies actually cover, records the decision state, and
// publishes the resulting snapshot on a `WeakMap` side table for W-DEMOTE and
// W-NEXT-ARBITER. It changes NO EMITTED BYTE — not with the flags off, and not
// with them on. `sfSatisfaction.ts`'s `attachSfPackContext` is a side table
// precisely so that is a structural fact rather than a review promise: no
// serializer, fingerprinter, or wire baseline can reach a WeakMap, and
// `sfSatisfaction.spec.ts` pins flag-on/flag-off byte identity anyway.
//
// FAIL-OPEN, TWICE (invariant I-1). `sfState.ts` is already total — every
// exported function returns an inert snapshot instead of throwing. This
// wrapper adds a second try/catch anyway, because the things it does OUTSIDE
// the adapter (reading `result.surfaces`, parsing a range, building a ledger
// reader) belong to the read path and must not be able to fail it either. An
// SF defect degrades to a trace line and an unchanged pack.
//
// PRIVACY. The verbatim query is used in-process for concern EXTRACTION (that
// is the extractor's whole input) but never enters the `SfTaskContext`. The
// identity chain hashes whatever it is given (`deriveIrTaskRef`), so passing
// the fingerprint instead of the text is identity-preserving and keeps request
// text out of a persisted record and out of every SF trace line.
// ---------------------------------------------------------------------------

/** `EvidenceRole`'s closed member list, checked without importing the guard. */
export const SF_EVIDENCE_ROLES: ReadonlySet<string> = new Set([
  "target",
  "definition",
  "consumer",
  "test",
  "config",
  "build",
  "doc",
]);
