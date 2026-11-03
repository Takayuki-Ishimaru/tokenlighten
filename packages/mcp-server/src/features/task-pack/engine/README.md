# Task-pack implementation owners

`../readCodeTaskPack.ts` is the compatibility facade. Production consumers import
the module that owns the binding; the facade retains the historical public API.
No implementation module imports its siblings through that facade.

| Stage | Owners |
| --- | --- |
| Request lifetime and engine configuration | `taskPackEntry.ts`, `packBasics*.ts` |
| Initial routing and target admission | `taskPackBuilder.ts`, `seedAdmission*.ts` |
| Materializing answer, selected and artifact surfaces | `answerPackBuilder*.ts`, `seededPackBuilder*.ts`, `artifactPackBuilder*.ts`, `surfaceMaterialization.ts` |
| Resolving calls, constants and execution context | `callableResolution*.ts`, `constantResolution*.ts`, `constantClosure*.ts`, `focalFlow*.ts`, `facetClosure*.ts` |
| Query requirements and source proofs | `requestItemReadiness.ts`, `facetReadiness*.ts`, `readinessObligations.ts`, `executionContract.ts` |
| Exact served evidence and task reconciliation | `epochEvidence*.ts`, `epochContract*.ts`, `packState*.ts` |
| Budgeting and final delivery | `packTrimming*.ts`, `callerRangeDelivery*.ts`, `packSettlement.ts` |
| Same-task receipts and progress | `receiptRestoration*.ts`, `receiptProgress*.ts` |

Natural retrieval lives one level above this directory. `naturalQueryPlan.ts`
extracts bounded executable facts and ranks connected implementations;
`naturalQueryWitnesses.ts` checks requested operations;
`naturalEditSurfaces.ts` links implementations, configuration, documentation and
tests. `naturalQueryAdapter.ts` keeps structural witnesses separate from actual
served source. `naturalTaskPackIntegration.ts` projects those obligations into
the existing execution contract. Ranking alone cannot certify an answer.

The original full query and route provenance live in the existing scoped task
record. Plans are rebuilt from authorized current source on each continuation.
Call-local evidence uses AsyncLocalStorage; there is no second durable proof
store. Budget trimming cannot remove mandatory obligations. A terminal receipt
must satisfy the current plan and retain its mandatory certificate identifiers.

Unsupported clauses can retain an existing structural owner instead of adding
duplicate generic gaps. Answer owners must cite current, positionally served
executable AST bodies or resolved value/caller facets; wiring owners retain
source, consumer, link and insertion obligations. Recognized natural operation
effects remain mandatory. A saved specialized certificate permits only a fresh
rebuild, never reuse of an old terminal decision or graph.

Mutable bindings and their direct writers share an owner. Maps and caches retain
one identity and their existing reset paths. The extraction used declaration
dependencies and cycle-safe grouping; numeric suffixes split a concern when
merging its declarations would create a dependency cycle. Original declaration
bodies were checked independently after extraction.

When changing routing or proof rules, run the natural-language corpus and public
retrieval/proof tests as well as the replay corpus. The Node tests under
`scripts/__tests__/` guard the extraction tooling and module-size bounds.
