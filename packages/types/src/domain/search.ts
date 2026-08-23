// ---------------------------------------------------------------------------
// v0.10 internal domain model — per-term search results and tree-walk scope
// reporting.
//
// SOURCE: DESIGN-v0.10-expansion-plan-v1.3.md §4.3 "共通データモデル",
// "TermResult" / "TreeScopeReport" (lines 562-609).
//
// THIS IS THE INTERNAL DOMAIN MODEL, NOT THE WIRE PROTOCOL (D-1). See
// `./evidence.ts`'s file header for the shared internal/wire boundary note;
// this module imports nothing from `../mcp/*`.
//
// PI-04 (per-term absence) and PI-08 (tree scope report) name these two
// shapes as the reducer state a future emitter projects onto ADDITIVE
// optional wire fields on the existing `search.matches` / `search.tree`
// members (reconciliation §2, §3: "No new kinds in v0.10... every new
// disclosure rides existing kinds as additive optional fields") — never a
// new `Kind`.
// ---------------------------------------------------------------------------

import type { ContinuationControl } from "./continuation.js";

/**
 * §4.3 "TermResult". Per-term absence/match state for one query term,
 * closing the PI-04 gap where today's OR-set absence certificate is dropped
 * as soon as ANY term matches (reconciliation §2 PI-04).
 */
export type TermResult = {
  original: string;
  normalized: string[];
  status: "matched" | "absent" | "unknown";
  matchCount: number | null;
  scope: {
    root: string;
    pathFilter?: string;
    completeness: "complete" | "partial" | "unknown";
    indexGeneration: string;
  };
  evidenceRefs: string[];
  /** Emitted iff `status === "absent"` and the absence is certified over a complete scope; absence of this field means no certificate was minted. */
  absenceRef?: string;
};

/**
 * §4.3 "TreeScopeReport". Closes the PI-08 gap where `CompactTree` exposes
 * only `truncated: boolean` (reconciliation §2 PI-08). The invariant this
 * shape carries: `counts.visited === counts.returned + counts.excluded +
 * counts.errors`.
 */
export type TreeScopeReport = {
  requestedRoot: string;
  resolvedRoot: string;
  completeness: "complete" | "partial" | "unknown";
  counts: {
    visited: number;
    returned: number;
    excluded: number;
    errors: number;
  };
  excludedByReason: {
    ignored: number;
    hiddenPolicy: number;
    generatedPolicy: number;
    vendorPolicy: number;
    binary: number;
    unsupportedType: number;
    tooLarge: number;
    permissionDenied: number;
    symlinkPolicy: number;
    outsideWorkspace: number;
    budget: number;
  };
  /**
   * Reuses `ContinuationControl`'s `next` shape (`./continuation.js`) rather
   * than redeclaring it; still reducer-internal (D-1) until a projector maps
   * it onto the wire `Limit`/`next`.
   */
  continuation?: ContinuationControl["next"];
};
