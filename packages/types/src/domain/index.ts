// ---------------------------------------------------------------------------
// The `packages/types/src/domain` barrel — the v0.10 INTERNAL DOMAIN MODEL.
//
// SOURCE: DESIGN-v0.10-expansion-plan-v1.3.md §4.3/§4.4, reconciled by
// DESIGN-v0.10-expansion-plan-reconciliation.md §3 ("Domain types... Type-
// only, no wire export") and §5 (D-1, D-2, D-4).
//
// NOT THE WIRE PROTOCOL. Every type re-exported here is internal — a
// reducer input/output, a decoded server-side envelope, or a telemetry
// shape. The frozen MCP wire contract is `../mcp/index.ts`, and this barrel
// never re-exports anything from it (enforced by `__tests__/domain.spec.ts`'s
// no-collision test) and is never re-exported BY it.
//
// Grouped by source file, in the order those files appear in
// DESIGN-v0.10-expansion-plan-v1.3.md §4.3.
// ---------------------------------------------------------------------------

export type {
  EvidenceId,
  EvidenceRole,
  EvidenceIdentity,
  EvidenceUse,
  DeliveryDisposition,
  EmissionHistory,
  EvidenceDelivery,
} from "./evidence.js";
export {
  EVIDENCE_ROLES,
  isEvidenceRole,
  DELIVERY_DISPOSITIONS,
  isDeliveryDisposition,
} from "./evidence.js";

export type { CoverageState } from "./coverage.js";

export type { ContinuationControl } from "./continuation.js";

export type {
  StateHandlePurpose,
  DecodedStateHandle,
  CommonStateInput,
  TrustedClientContextMeta,
  ClientContextAttestation,
  ContextReceipt,
  LocalTaskState,
} from "./state-handle.js";
export {
  STATE_HANDLE_PURPOSES,
  isStateHandlePurpose,
  HANDLE_WIRE_PREFIXES,
  parseHandlePurposeFromPrefix,
  HANDLE_WIRE_SIZE_TARGET_P95,
  HANDLE_WIRE_SIZE_MAX,
} from "./state-handle.js";

export type {
  ContextAttestationV1,
  ContextAttestationRejection,
  ContextAttestationVerdict,
  ContextGenerationState,
} from "./context-attestation.js";
export {
  CONTEXT_STATE_META_KEY,
  CONTEXT_ATTESTATION_VERSION,
} from "./context-attestation.js";

export type { TaskReasoningIR } from "./reasoning.js";
// V11-04 Task Reasoning IR v2 — additive sibling vocabulary; v1 above unchanged.
export type {
  ValidityKey,
  ObligationOrigin,
  EvidencePredicate,
  ObligationState,
  ObligationNode,
  TombstoneScope,
  DirectAbsenceProof,
  HypothesisTombstone,
  ObligationPatch,
  ReasoningDeltaOp,
  ReasoningDelta,
  TaskReasoningIRv2,
  StopCertificateCandidate,
} from "./reasoning.js";

export type { TermResult, TreeScopeReport } from "./search.js";

export type { HostBudgetProfile } from "./budget.js";

export type { EncodingDecision, ContributionEstimate } from "./measurement.js";
