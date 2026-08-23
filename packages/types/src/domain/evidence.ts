// ---------------------------------------------------------------------------
// v0.10 internal domain model — evidence identity, per-task use, and
// per-response delivery disposition.
//
// SOURCE: DESIGN-v0.10-expansion-plan-v1.3.md §4.3 "共通データモデル",
// "EvidenceIdentity" / "EvidenceUse" / "EvidenceDelivery" (lines 362-441),
// reconciled against the Protocol v1 freeze by
// DESIGN-v0.10-expansion-plan-reconciliation.md §3 ("Evidence shape
// `{handle,path,range,body,prior,remaining,role}` and 5-form receipts already
// exist... EvidenceIdentity/EvidenceUse/EvidenceDelivery split is an INTERNAL
// DOMAIN MODEL projected onto the existing wire Evidence/Receipt — reuse, not
// addition") and §5 D-1.
//
// THIS IS THE INTERNAL DOMAIN MODEL, NOT THE WIRE PROTOCOL (D-1). The wire
// contract is exactly what `../mcp/protocol.ts`'s `Evidence`/`FreshEvidence`/
// `PriorEvidence` and `../mcp/receipts.ts`'s `Receipt` freeze; nothing here is
// emitted in their place, and a future codec/projection layer that maps these
// types onto the wire MUST NOT import mutation rights (`EditToolCall`, or a
// `ToolCall` bound to `edit_file`) — only the read-side vocabulary a
// projection legitimately needs. This module imports nothing from `../mcp/*`:
// the internal model and the wire model are two separate type graphs, joined
// only by a future projector, never by a shared base type.
//
// NOT THE SAME VOCABULARY AS (deliberately not unified, per the house
// practice at `../mcp/protocol.ts`'s `SurfaceRole` doc comment):
//  - wire `SurfaceRole` (`../mcp/protocol.ts`, aliasing `ImpactSurface`): ten
//    values answering "what KIND of surface is this evidence?". `EvidenceRole`
//    below answers a different question — "what OBLIGATION does this evidence
//    discharge for THIS task?" — and a single evidence item can carry several
//    roles at once (`EvidenceUse.roles`), which a wire `SurfaceRole`
//    (singular) cannot express.
//  - pre-v1 `TaskEvidenceRole` (`../mcp/task-pack.ts`:
//    producer/consumer/adapter/insertion/host/carrier), the wiring-graph
//    relation role. It shares the literal `"consumer"` with `EvidenceRole`
//    and nothing else; the two enums answer unrelated questions and are
//    never interchangeable.
// ---------------------------------------------------------------------------

/**
 * Opaque identity of one piece of evidence. Stable across responses; NOT a
 * wire handle (`../mcp/protocol.ts`'s `Evidence.handle` is response-scoped
 * and addresses delivery, not identity).
 */
export type EvidenceId = string;

/**
 * §4.3 "EvidenceRole" (part of "EvidenceUse"). What obligation this evidence
 * discharges for the CURRENT task. Plural use is normal: `EvidenceUse.roles`
 * lets one evidence item satisfy several obligations at once, rather than
 * forcing a single-role choice the way a wire `SurfaceRole` would.
 *
 * See the file header for why this is NOT the same vocabulary as wire
 * `SurfaceRole` or pre-v1 `TaskEvidenceRole`.
 */
export type EvidenceRole =
  | "target"
  | "definition"
  | "consumer"
  | "test"
  | "config"
  | "build"
  | "doc";

/**
 * `EvidenceRole`'s closed member list, backing `isEvidenceRole` and the
 * exhaustiveness fixtures in `__tests__/domain.spec.ts`.
 */
export const EVIDENCE_ROLES = [
  "target",
  "definition",
  "consumer",
  "test",
  "config",
  "build",
  "doc",
] as const satisfies readonly EvidenceRole[];

/**
 * Runtime guard for `EvidenceRole`. Mirrors the house idiom at
 * `packages/mcp-server/src/protocol/budget/requiredSets.ts`'s
 * `isKnownProtocolKind`.
 */
export function isEvidenceRole(value: unknown): value is EvidenceRole {
  return typeof value === "string" && (EVIDENCE_ROLES as readonly string[]).includes(value);
}

/**
 * §4.3 "EvidenceIdentity". The evidence's own identity, independent of task,
 * client, codec, or how THIS response happens to deliver it. Immutable in
 * principle — re-derive rather than patch when the underlying source moves.
 */
export type EvidenceIdentity = {
  evidenceId: EvidenceId;
  source: {
    kind: "file" | "artifact" | "index" | "verification";
    uri: string;
    contentHash: string;
    /** Emitted iff the source is index-derived and versioned; absence means the source has no generation concept (e.g. a raw file). */
    indexGeneration?: string;
  };
  /** Emitted iff the evidence addresses a sub-region of its source; absence means the whole source is the evidence. */
  locator?: {
    lineRange?: { startLine: number; endLine: number };
    symbol?: { id: string; name: string; kind: string };
    sectionId?: string;
  };
  evidenceClass: "direct" | "structural" | "heuristic";
  validityKeys: Array<{ type: string; value: string }>;
};

/**
 * §4.3 "EvidenceUse". The same `EvidenceIdentity`, used for a specific
 * purpose within a specific task. `roles` is never forced to a single value
 * (see `EvidenceRole`'s doc comment) — one item can discharge several
 * obligations at once.
 */
export type EvidenceUse = {
  taskRef: string;
  evidenceId: EvidenceId;
  roles: EvidenceRole[];
  obligationIds: string[];
  required: boolean;
};

/**
 * §4.3 "EvidenceDelivery". How THIS response chose to deliver a piece of
 * evidence the task already knows about. Deliberately excluded from
 * `TaskReasoningIR.stateHash` (`./reasoning.js`) — §4.3: "Task IRの
 * `stateHash`には含めず、context ledgerとsemantic projectionで管理する"
 * (excluded from the Task IR's `stateHash`; managed by the context ledger and
 * semantic projection instead) — delivery is a per-response fact, not part
 * of task identity. See `./reasoning.ts`'s file header for the full
 * `stateHash` boundary table.
 */
export type DeliveryDisposition =
  | "inline"
  | "client_acknowledged_prior"
  | "micro_restate"
  | "omitted";

/**
 * `DeliveryDisposition`'s closed member list, backing `isDeliveryDisposition`
 * and the exhaustiveness fixtures in `__tests__/domain.spec.ts`.
 */
export const DELIVERY_DISPOSITIONS = [
  "inline",
  "client_acknowledged_prior",
  "micro_restate",
  "omitted",
] as const satisfies readonly DeliveryDisposition[];

/** Runtime guard for `DeliveryDisposition`. */
export function isDeliveryDisposition(value: unknown): value is DeliveryDisposition {
  return typeof value === "string" && (DELIVERY_DISPOSITIONS as readonly string[]).includes(value);
}

/**
 * Server-side delivery HISTORY for one evidence item. `"previously_emitted"`
 * is a FACT ABOUT THE PAST, not a permission: §4.3 is explicit that it "それ
 * 単独ではbodyless suppressionを許可しない" (does not by itself license
 * bodyless suppression). Absent a `ClientContextAttestation`
 * (`./state-handle.js`) verifying the client host actually retained the
 * bytes, a projector MUST resolve the current `EvidenceDelivery.disposition`
 * to `"micro_restate"` or `"inline"` — never silently to `"omitted"` or
 * `"client_acknowledged_prior"` on history alone.
 */
export type EmissionHistory = "never_emitted" | "previously_emitted";

/**
 * §4.3 "EvidenceDelivery". Excluded from `TaskReasoningIR.stateHash` by
 * design — see this file's `DeliveryDisposition` doc comment.
 */
export type EvidenceDelivery = {
  responseId: string;
  evidenceId: EvidenceId;
  emissionHistory: EmissionHistory;
  disposition: DeliveryDisposition;
  /** Emitted iff this delivery is grounded in a prior `Receipt` (wire `../mcp/receipts.ts`); absence means no receipt backs this claim. */
  receiptId?: string;
  /** Emitted iff a `context_handle` (`./state-handle.js`) grounds `disposition:"client_acknowledged_prior"`; absence means no trusted-client acknowledgment was used. */
  contextHandle?: string;
  /** The call that put these bytes on the wire, when `disposition` claims a prior serve. */
  servedByCallId?: string;
  projectionVersion: string;
  /** Emitted iff `disposition === "inline"`; the hash of the bytes actually inlined this response. */
  inlineBodyHash?: string;
  /** Emitted iff `disposition === "micro_restate"`. */
  microRestate?: {
    signature?: string;
    anchor?: string;
    summary?: string;
  };
};
