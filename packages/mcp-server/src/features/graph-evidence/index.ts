// ---------------------------------------------------------------------------
// graph-evidence/index.ts — V11-01 public surface.
//
// WAVE-A CONTRACT: nothing in production imports this barrel. It exists so the
// wave-B consumers named in DESIGN-v0.11-expansion-plan-reconciliation.md §3 —
// V11-05 Compound Retrieval and V11-06's `write/impactGuard.ts` — have ONE
// import site to wire, and so `graphEvidencePurity.spec.ts` has one surface to
// pin when it proves the module is still unwired.
//
// THE THREE ENTRY POINTS a consumer needs:
//
//   analyzeImpact({ seeds, providers, bounds, generations })
//       the bounded impact set, tiered required/likely/informational.
//   canSupportClosure(evidenceClass) / canCloseObligation(edges)
//       the fence. Ask before treating any of this as obligation-closing.
//   buildCoverageMatrix(snapshot, providers)
//       the per-language telemetry report.
//
// `adapters.ts` is exported too, but a consumer should prefer injecting
// providers: the adapter binds the surfaces that happen to be cleanly
// importable today, not the ones a seam will eventually have.
// ---------------------------------------------------------------------------

export * from "./model.js";
export * from "./providers.js";
export * from "./bounds.js";
export * from "./stale.js";
export * from "./edges.js";
export * from "./impact.js";
export * from "./coverageMatrix.js";
export * from "./adapters.js";
