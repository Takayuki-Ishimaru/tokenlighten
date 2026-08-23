// ---------------------------------------------------------------------------
// v0.10 internal domain model — Task Reasoning IR v1.
//
// SOURCE: DESIGN-v0.10-expansion-plan-v1.3.md §4.3 "共通データモデル",
// "TaskReasoningIR v1" (lines 611-635), and §4.4 "state、context、semantic
// payload、wireの境界" (lines 685-699) for the `stateHash` boundary.
//
// THIS IS THE INTERNAL DOMAIN MODEL, NOT THE WIRE PROTOCOL (D-1). See
// `./evidence.ts`'s file header for the shared internal/wire boundary note;
// this module imports nothing from `../mcp/*`.
//
// ADVISORY PROJECTION, NOT A NEW AUTHORITY. Per reconciliation §4's beta.1
// stage note, `TaskReasoningIR` is "an advisory projection from existing
// pack state" — it restates what `../mcp/decision.ts`'s `TaskDecision` and
// the pre-v1 task-pack contract already certify, for reasoning/telemetry
// use. It is never a second wire authority for the bounded effect area or
// the certified decision — the same E4 second-authority class
// `../mcp/decision.ts`'s `CertificateRef` doc comment names and forbids.
//
// STATEHASH BOUNDARY (§4.4, transcribed). Four hashes cover four
// deliberately DIFFERENT identities, and this module's `stateHash` is only
// the first:
//   task_state_hash       — EvidenceIdentity / EvidenceUse / obligations /
//                            decision identity (THIS is
//                            `TaskReasoningIR.stateHash`, below)
//   context_state_hash    — acknowledged receipt set / client context
//                            generation identity (`ClientContextAttestation`,
//                            `./state-handle.js`)
//   semantic_payload_hash — protocol-projection-object identity (wire-
//                            facing; lives in the future codec/projection
//                            layer)
//   wire_hash             — post-codec bytes identity (wire-facing)
// `TaskReasoningIR.stateHash` never absorbs the other three — see
// `EvidenceDelivery`'s doc comment (`./evidence.js`) for the concrete case
// where delivery/context facts are excluded from task state identity.
// ---------------------------------------------------------------------------

import type { EvidenceId, EvidenceIdentity, EvidenceUse } from "./evidence.js";

/**
 * §4.3 "TaskReasoningIR v1". See the file header for its advisory status
 * and the `stateHash` boundary.
 */
export type TaskReasoningIR = {
  taskRef: string;
  stateVersion: number;
  stateHash: string;
  goal: string;
  constraints: Array<{ id: string; text: string; source: "user" | "repository" }>;
  evidenceCatalog: EvidenceIdentity[];
  evidenceUses: EvidenceUse[];
  obligations: Array<{
    id: string;
    claim: string;
    state: "open" | "satisfied" | "blocked" | "invalidated";
    evidenceRefs: EvidenceId[];
  }>;
  decision: {
    state: "pending" | "prepared" | "acting" | "verifying" | "done";
    evidenceRefs: EvidenceId[];
  };
  allowedNext: Array<{ tool: string; reason: string }>;
  invalidationKeys: Array<{ type: string; value: string }>;
};

// ---------------------------------------------------------------------------
// v0.11 internal domain model — Task Reasoning IR v2 (V11-04).
//
// SOURCE: DESIGN-v0.10-expansion-plan-v1.3.md §7 "V11-04. Task Reasoning IR
// v2: reasoning_delta / Obligation DAG / Tombstone / Shadow Stop", reconciled
// by DESIGN-v0.11-expansion-plan-reconciliation.md §3 (row V11-04) and its
// deviations E-5 (Shadow Stop = trace-only candidates + a fixture harness)
// and E-7 (open-obligation preference is an ADVISORY optional input, never a
// behaviour constraint).
//
// ADDITIVE, NOT A REPLACEMENT. `TaskReasoningIR` above is v1 and stays exactly
// as it is: still pure, still unwired, still projected only by
// `task-state/reasoningIr.ts`. Everything below is a SIBLING vocabulary the v2
// projection (`task-state/reasoningIrV2.ts`) owns. Nothing here is a wire type
// — the same D-1 boundary this file's header states applies unchanged, and
// V11-04 adds ZERO wire kinds and ZERO wire fields (its only emission is
// `util/trace.ts`).
//
// THE HASH BOUNDARY IS NARROWER THAN THE STATE (§4.4, and this is deliberate).
// `TaskReasoningIRv2.stateHash` covers EXACTLY the four components §4.4 names —
// `evidenceCatalog` (EvidenceIdentity), `evidenceUses` (EvidenceUse),
// `obligations`, `decision`. `goal`, `constraints`, `tombstones`,
// `allowedNext`, `invalidationKeys` and `appliedDeltaIds` ride the STATE but
// are OUTSIDE its identity, and delivery/codec/receipt material never entered
// the IR at all. Delta ordering therefore never leans on the hash alone: it is
// `(baseVersion, baseHash)` for ordering plus `deltaId` for idempotency, so a
// state change outside the hashed four is still ordered and still replayable.
// See `task-state/reasoningDelta.ts`'s `TASK_STATE_HASH_COMPONENTS`.
// ---------------------------------------------------------------------------

/** One fine-grained invalidation basis: file SHA, index generation, provider coverage, user change. */
export type ValidityKey = { type: string; value: string };

/* Where an obligation node came from. `heuristic` is the ONLY advisory origin:
 * plan §7 "heuristic nodeはadvisoryにする" and reconciliation §3's common rule
 * that heuristic evidence never closes obligations, completeness, or absence. */
export type ObligationOrigin =
  | "source-requirement"
  | "direct-evidence"
  | "existing-check"
  | "heuristic";

/**
 * The evidence condition a node must meet before it may close. `manual` is
 * never auto-satisfiable by construction — it is how a node says "a human/agent
 * act, not an evidence count, discharges me", and it makes "invalid obligation
 * closure 0" a structural property rather than a review promise.
 */
export type EvidencePredicate =
  | { kind: "any-grounded-evidence" }
  | { kind: "min-grounded-evidence"; count: number }
  | { kind: "named-evidence"; evidenceIds: EvidenceId[] }
  | { kind: "manual" };

export type ObligationState = "open" | "satisfied" | "blocked" | "invalidated";

/** A v1 flat obligation plus its DAG edges, origin, and closure predicate. */
export type ObligationNode = {
  id: string;
  claim: string;
  state: ObligationState;
  evidenceRefs: EvidenceId[];
  origin: ObligationOrigin;
  /** True iff `origin === "heuristic"`; an advisory node can never block a non-advisory one. */
  advisory: boolean;
  /** Dependency edges: this node cannot close until each named node has closed. */
  blockedBy: string[];
  predicate: EvidencePredicate;
};

/** What a rejected hypothesis was rejected OVER. `complete` is the scope-completeness proof. */
export type TombstoneScope = {
  kind: "repository" | "paths" | "symbol" | "query";
  description: string;
  /** Emitted iff `kind === "paths"`; the exact path prefixes the scope covered. */
  paths?: string[];
  /** True only when the provider reported the scope as exhaustively searched. */
  complete: boolean;
};

/**
 * A direct-absence observation, in the shape of this repo's absence discipline
 * (`search_files` 0 matches + a scope-complete report). The literal `true`/`0`
 * make a strong tombstone unconstructible from a partial observation at the
 * TYPE level; `tombstone.ts` re-checks the same facts at runtime for untrusted
 * input.
 */
export type DirectAbsenceProof = {
  evidenceId: EvidenceId;
  scopeComplete: true;
  observedMatches: 0;
  provider: string;
};

/** A rejected hypothesis, with the exact conditions that revive or invalidate it. */
export type HypothesisTombstone = {
  id: string;
  claim: string;
  scope: TombstoneScope;
  evidenceRefs: EvidenceId[];
  /** `weak` deprioritizes only; `strong` requires complete scope + direct absence. */
  strength: "weak" | "strong";
  reviveCondition: string;
  /** Non-empty: a tombstone with no invalidation basis could never go stale. */
  validityKeys: ValidityKey[];
  /** Present iff `strength === "strong"`. */
  absence?: DirectAbsenceProof;
  /** Obligation ids this rejection contradicts if they ever close. */
  contradicts?: string[];
};

/** Patchable fields of an obligation node (`id`/`origin`/`advisory` are identity). */
export type ObligationPatch = {
  claim?: string;
  state?: ObligationState;
  evidenceRefs?: EvidenceId[];
  blockedBy?: string[];
  predicate?: EvidencePredicate;
};

export type ReasoningDeltaOp =
  | { op: "add"; target: "evidence"; evidence: EvidenceIdentity }
  | { op: "add"; target: "use"; use: EvidenceUse }
  | { op: "add"; target: "obligation"; obligation: ObligationNode }
  | { op: "add"; target: "tombstone"; tombstone: HypothesisTombstone }
  | { op: "update"; target: "obligation"; id: string; patch: ObligationPatch }
  | { op: "update"; target: "decision"; decision: TaskReasoningIRv2["decision"] }
  | { op: "close"; target: "obligation"; id: string }
  | { op: "invalidate"; target: "obligation" | "evidence" | "tombstone"; id: string; reason: string };

/**
 * One ordered state transition. `(baseVersion, baseHash)` is the ordering
 * guard — an out-of-order or forked delta is REFUSED, never best-effort
 * patched — and `deltaId` is the idempotency key, so a duplicate replay is a
 * proven no-op rather than a second application.
 */
export type ReasoningDelta = {
  taskRef: string;
  lane: string;
  baseVersion: number;
  baseHash: string;
  newVersion: number;
  newHash: string;
  deltaId: string;
  ops: ReasoningDeltaOp[];
};

/** IR v2 state. See this block's header for the stateHash boundary. */
export type TaskReasoningIRv2 = {
  irVersion: 2;
  taskRef: string;
  /** Lane isolation key; "" is the shared default lane. */
  lane: string;
  stateVersion: number;
  stateHash: string;
  goal: string;
  constraints: Array<{ id: string; text: string; source: "user" | "repository" }>;
  evidenceCatalog: EvidenceIdentity[];
  evidenceUses: EvidenceUse[];
  obligations: ObligationNode[];
  decision: {
    state: "pending" | "prepared" | "acting" | "verifying" | "done";
    evidenceRefs: EvidenceId[];
  };
  tombstones: HypothesisTombstone[];
  allowedNext: Array<{ tool: string; reason: string }>;
  invalidationKeys: ValidityKey[];
  /** Bounded ring of applied delta ids — the idempotency ledger, not identity. */
  appliedDeltaIds: string[];
  /** False for local (<=2 sites / <=2 obligations) tasks: a flat v1-style list. */
  dagEnabled: boolean;
};

/**
 * A SHADOW Stop Certificate (E-5). Trace-only: never wire-visible, never
 * consulted by dispatch, never a behaviour constraint in v0.11. It exists so
 * v0.12's Stop/Replan decision has recorded data instead of a guess.
 */
export type StopCertificateCandidate = {
  taskRef: string;
  lane: string;
  stateVersion: number;
  stateHash: string;
  closedObligations: string[];
  /** Advisory nodes still open — allowed, by the advisory rule. */
  advisoryOpen: string[];
  reason: "all-non-advisory-obligations-closed";
};
