// ---------------------------------------------------------------------------
// v0.10 internal domain model — explicit state handles (SEP-2567) and
// trusted client-context attestation.
//
// SOURCE: DESIGN-v0.10-expansion-plan-v1.3.md §4.3 "共通データモデル",
// "Explicit State Handle" / "ContextReceipt / ClientContextAttestation"
// (lines 443-521), and PI-09 "MCP 2026-07-28対応とExplicit State Handle
// Contract" (line 1702), whose 副作用を抑える方法 (line 1809) and 受入基準
// (line 1832) ground the wire-size/prefix notes below.
//
// THIS IS THE INTERNAL DOMAIN MODEL, NOT THE WIRE PROTOCOL (D-1). See
// `./evidence.ts`'s file header for the shared internal/wire boundary note;
// this module imports nothing from `../mcp/*` except the `EvidenceId` type
// alias, which comes from the sibling `./evidence.js` — an intra-domain
// edge, not a wire one.
//
// WIRE HANDLES ARE OPAQUE STRINGS. `DecodedStateHandle` is the server-side
// DECODED envelope — it is NEVER exposed to the agent, which only ever sees
// the opaque token produced by encoding and MAC-signing it (§4.3: "wire上の
// handleはopaque stringであり、decoded envelopeをagentへ露出しない", i.e. "the
// wire handle is an opaque string; the decoded envelope is never exposed to
// the agent"). A decoded handle's `mac` field is the proof of authenticity;
// nothing in this package computes or checks it (no crypto here — that lands
// in `packages/mcp-server` at alpha.2, PI-09).
//
// CONTINUATION TOKENS RIDE ONLY INSIDE `next.arguments` (F5). There is no
// standalone top-level `continuation_token` RESPONSE field — the frozen
// impossible-state CI test at §2.1.2 forbids one (reconciliation §3: "no
// standalone cursor field; cursor rides only inside `next.arguments`").
// `CommonStateInput` below models the additive OPTIONAL REQUEST arguments
// reconciliation §3's table allows (`task_handle`, `continuation_token`,
// `expected_state_version`, `operation_id`, `force_serve`); it is
// REQUEST-side only, and its fields stay `snake_case` because they mirror
// the actual wire argument names this type documents — unlike the rest of
// this internal domain model, which is `camelCase` throughout.
//
// DEVIATION D-2, RECORDED HERE ON PURPOSE. The plan's `CommonStateOutput` (a
// top-level response object carrying `protocol_era` / `task_handle` /
// `context_handle` / `continuation_token` / `state_version`) is DELIBERATELY
// NOT DEFINED anywhere in this package. Per reconciliation §5 D-2:
// `task_handle` rides `../mcp/decision.ts`'s `TaskRef.id`; continuation rides
// `next.arguments` (F5, above); and `state_version` is embedded inside the
// handle payload (`DecodedStateHandle.stateVersion` below) rather than paid
// for as a fixed top-level response cost on every reply. `protocol_era` is a
// separate deviation, D-3: telemetry/`_meta` only, never emitted in the body.
// ---------------------------------------------------------------------------

import type { EvidenceId } from "./evidence.js";

/**
 * §4.3 "Explicit State Handle": the three purposes a handle may be bound to.
 * Each has its own TTL, scope, and replay policy (§4.3, closing paragraph).
 * `task_handle` and `continuation_token` are ordinary tool arguments a model
 * threads itself; `context_handle` represents body RETENTION and is not
 * model-controlled strong evidence on its own — see `ClientContextAttestation`.
 */
export type StateHandlePurpose = "task" | "context" | "continuation";

/**
 * `StateHandlePurpose`'s closed member list, backing `isStateHandlePurpose`,
 * `parseHandlePurposeFromPrefix`, and the exhaustiveness fixtures in
 * `__tests__/domain.spec.ts`.
 */
export const STATE_HANDLE_PURPOSES = [
  "task",
  "context",
  "continuation",
] as const satisfies readonly StateHandlePurpose[];

/** Runtime guard for `StateHandlePurpose`. */
export function isStateHandlePurpose(value: unknown): value is StateHandlePurpose {
  return typeof value === "string" && (STATE_HANDLE_PURPOSES as readonly string[]).includes(value);
}

/**
 * §4.3 "Explicit State Handle". The server-side DECODED form of an opaque
 * wire handle — see the file header. `tokenVersion` is a compile-time marker
 * only (mirroring §1.6/D12's rule for substructure `version` fields on the
 * wire side): it is never read at runtime as a branch condition beyond "is
 * this the version this decoder understands".
 */
export type DecodedStateHandle = {
  tokenVersion: 1;
  purpose: StateHandlePurpose;
  keyId: string;
  payloadRef: string;
  workspaceRef: string;
  subjectRef: string;
  stateVersion: number;
  issuerId: string;
  stateStoreEpoch: string;
  issuedAtMs: number;
  expiresAtMs: number;
  nonce: string;
  /** The authenticity proof. Verified server-side only; see the file header's crypto-boundary note. */
  mac: string;
};

/**
 * §4.3 "Explicit State Handle": the additive optional REQUEST arguments
 * (reconciliation §3's table). Request-side only — see the file header for
 * why these fields stay `snake_case` and why there is no `CommonStateOutput`
 * counterpart (D-2).
 */
export type CommonStateInput = {
  task_handle?: string;
  continuation_token?: string;
  expected_state_version?: number;
  operation_id?: string;
  force_serve?: boolean;
};

/**
 * §4.3 "Explicit State Handle": the trusted-client-host metadata channel,
 * `_meta["io.tokenlighten/context-state"]` on the wire (reconciliation §3).
 * `context_handle` never appears as a MODEL-controlled strong argument
 * (reconciliation §3, "plan invariant 15") — strong use arrives only through
 * this trusted channel, carrying a verified `ClientContextAttestation`.
 */
export type TrustedClientContextMeta = {
  context_handle?: string;
  context_attestation?: ClientContextAttestation;
};

/**
 * §4.3 "ContextReceipt / ClientContextAttestation". A TL-aware client-host
 * adapter's proof that it currently retains a given set of receipts in its
 * live context — MCP itself proves no such thing (§4.3: "MCP標準自体はmodel
 * のcontext保持を証明しないため、このattestationはTL固有のclient adapter
 * contractである", i.e. "the MCP standard itself does not prove the model's
 * context retention, so this attestation is a TL-specific client adapter
 * contract"). A model merely copying a receipt id into a tool argument is a
 * "weak model echo" — usable for telemetry, never sufficient to mint a
 * strong `context_handle` (§4.3, closing paragraph).
 */
export type ClientContextAttestation = {
  attestationVersion: 1;
  source: "trusted-client-host";
  clientId: string;
  clientContextGeneration: string;
  retainedReceiptIds: string[];
  issuedAtMs: number;
  expiresAtMs: number;
  signature: string;
};

/**
 * §4.3 "ContextReceipt / ClientContextAttestation". Proves only that a body
 * passed final wire settlement — not that any client retains it (that is
 * `ClientContextAttestation`'s claim, above).
 */
export type ContextReceipt = {
  receiptId: string;
  evidenceId: EvidenceId;
  contentHash: string;
  servedRange?: { startLine: number; endLine: number };
  projectionVersion: string;
  responseId: string;
  callId: string;
};

/**
 * §4.3 "LocalTaskState". The local-store-backed record a `task_handle`
 * addresses (`DecodedStateHandle.payloadRef`, above).
 */
export type LocalTaskState = {
  taskRef: string;
  taskHandle: string;
  targetHandle: string;
  baseSha: string;
  targetFingerprint: string;
  stateVersion: number;
  phase: "prepared" | "acting" | "verifying" | "done";
};

// ---------------------------------------------------------------------------
// Wire handle prefix / size constants — PI-09 (line 1809, line 1832).
// ---------------------------------------------------------------------------

/**
 * The wire prefix each handle purpose's opaque token is minted with.
 *
 * DIAGNOSTIC ONLY (PI-09, 副作用を抑える方法: "purpose prefixは診断用に使う
 * が、securityはMACとserver-side validationで担保する" — "the purpose prefix
 * is used for diagnostics, but security is guaranteed by MAC and server-side
 * validation"). Matching a prefix proves NOTHING about a token's
 * authenticity, workspace binding, or expiry — a forged or truncated token
 * can carry any prefix it likes. The only trustworthy purpose check is
 * server-side MAC validation against the decoded `DecodedStateHandle.purpose`.
 * Treat a `parseHandlePurposeFromPrefix` result as a hint for error messages
 * and routing, never as an authorization decision.
 */
export const HANDLE_WIRE_PREFIXES = {
  task: "tlh_task_v1_",
  context: "tlh_ctx_v1_",
  continuation: "tlh_cont_v1_",
} as const satisfies Record<StateHandlePurpose, string>;

/**
 * Recover the likely `StateHandlePurpose` from a wire handle's prefix, or
 * `undefined` if no known prefix matches. See `HANDLE_WIRE_PREFIXES`'s doc
 * comment: this is a diagnostic convenience, not a security check.
 */
export function parseHandlePurposeFromPrefix(token: string): StateHandlePurpose | undefined {
  for (const purpose of STATE_HANDLE_PURPOSES) {
    if (token.startsWith(HANDLE_WIRE_PREFIXES[purpose])) return purpose;
  }
  return undefined;
}

/**
 * Target p95 wire size, in bytes, for one encoded handle token (PI-09
 * 受入基準, line 1832: "handle wire sizeはp95 256 bytes以下を目標とし" — "the
 * handle wire size targets p95 <= 256 bytes"). A soft goal for the encoder,
 * not an enforced ceiling — see `HANDLE_WIRE_SIZE_MAX` for the hard cap.
 */
export const HANDLE_WIRE_SIZE_TARGET_P95 = 256;

/**
 * Hard cap, in bytes, on one encoded handle token (PI-09 受入基準, line
 * 1832: "上限を512 bytesに固定する" — "the ceiling is fixed at 512 bytes"). A
 * handle encoder that would exceed this MUST fail closed rather than emit an
 * oversized token.
 */
export const HANDLE_WIRE_SIZE_MAX = 512;
