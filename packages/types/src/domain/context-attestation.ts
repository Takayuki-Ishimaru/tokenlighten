// ---------------------------------------------------------------------------
// v0.10 INTERNAL DOMAIN MODEL — PI-03 attestation tier (v1).
//
// SOURCE: DESIGN-v0.10-expansion-plan-v1.3.md §4.3 ("ContextReceipt /
// ClientContextAttestation") and the PI-03 section's 受入基準;
// DESIGN-v0.10-expansion-plan-reconciliation.md §2 (PI-03 row: "New:
// `ClientContextAttestation` contract (types, HMAC validation,
// `_meta[\"io.tokenlighten/context-state\"]` channel, generation rotation) …
// default OFF; unknown clients keep exactly today's behavior") and §5 D-1/D-2.
//
// NOT THE WIRE PROTOCOL — D-1/D-2 house style. Nothing here is a member of the
// frozen 15-kind response surface, and nothing here is an advertised tool
// argument. These types describe (a) what a TL-aware client HOST puts in
// request `_meta`, and (b) the server-side verdict that reading it produces.
//
// WHY A SECOND SHAPE BESIDE `ClientContextAttestation`. `state-handle.ts`
// carries the plan's own `ClientContextAttestation` VERBATIM, and that shape is
// under-specified for a verifier: it binds a client and a client-side
// generation, but nothing ties it to a WORKSPACE or to a server-side
// generation the server can rotate. `ContextAttestationV1` is the plan's shape
// PLUS exactly the three bindings TL's HMAC actually covers, so the plan type
// stays the contract's statement of intent and this one is what the code
// checks. Extending the plan type in place would have been the other option
// and was rejected: it would silently redefine an already-published internal
// contract to mean something narrower.
//
// PLAN INVARIANT 15, RESTATED HERE BECAUSE IT IS A TYPE-LEVEL FACT: a
// `context_handle` is never a model-controlled strong argument. Nothing in
// this file appears in an advertised tool schema; the only inbound channel is
// trusted client-host metadata (`ContextStateMetaKey` below), and the only
// outbound channel is response `_meta`. A model that copies a handle into a
// tool argument reaches an `unknown-arguments` refusal, not this tier.
// ---------------------------------------------------------------------------

import type { ClientContextAttestation } from "./state-handle.js";

/**
 * The `_meta` key both directions of the attestation channel use, on
 * `tools/call` request params and on the tool result.
 *
 * Namespaced like `PROTOCOL_META_KEY` and for the same reason: a multi-server
 * host must be able to tell whose context state it is reading.
 */
export const CONTEXT_STATE_META_KEY = "io.tokenlighten/context-state" as const;

/** The attestation envelope version this server understands. */
export const CONTEXT_ATTESTATION_VERSION = 1 as const;

/**
 * The TL-verifiable attestation: the plan's `ClientContextAttestation` plus the
 * three bindings the HMAC covers and the verifier requires.
 *
 * WHY EACH BINDING EXISTS — every one closes a named 副作用 from the plan's
 * PI-03 "副作用・失敗モード" list:
 *
 *   `workspaceRef`
 *     Hash of the resolved workspace root (`state/handleCodec.ts`'s
 *     `workspaceRefOf`), never the path itself. Closes "task/context handle、
 *     workspace、clientの混線": an attestation minted for one workspace cannot
 *     license suppression in another.
 *
 *   `stateStoreEpoch` + `serverContextGeneration`
 *     The SERVER's generation of this workspace's context, as a pair: the
 *     store's own generation id, plus a counter inside it. Closes
 *     "attestation key漏えい、replay、context generationの更新漏れ" — a
 *     rotation on either half invalidates every attestation minted before it,
 *     and a store reset (which mints a fresh epoch) rotates for free.
 *
 *   `clientContextDigest`
 *     A digest the client host computes over the context it is attesting to.
 *     The server does not interpret it; it is MAC'd so a client cannot later
 *     claim a DIFFERENT context under the same signature. Closes "client-host
 *     attestationが実context状態とずれる" as far as a server can: it makes the
 *     claim specific and non-repudiable, which is the most a server can do
 *     about a client's own honesty.
 */
export type ContextAttestationV1 = ClientContextAttestation & {
  /** Hash of the resolved workspace root. Never the raw path. */
  workspaceRef: string;
  /** The state store generation this attestation belongs to. */
  stateStoreEpoch: string;
  /** Server-side context generation counter within `stateStoreEpoch`. */
  serverContextGeneration: number;
  /** Client-computed digest of the attested context. MAC'd, not interpreted. */
  clientContextDigest: string;
};

/**
 * Why an attestation was NOT accepted.
 *
 * EVERY value here means exactly one thing on the wire: NOTHING. A rejected
 * attestation is behaviourally identical to no attestation at all — the plan's
 * "unknown client／stale attestationでは`micro_restate`またはfull bodyへ戻す"
 * and its 受入基準 "tampered／expired／replayed attestation と context handle の
 * accept 0件". The reason exists for telemetry and tests, never for a response.
 */
export type ContextAttestationRejection =
  /** No `_meta` channel, or no attestation in it. The ordinary case. */
  | "absent"
  /** Present but not the declared shape. Includes every parse failure. */
  | "malformed"
  /** A version this server does not implement. Never guessed at. */
  | "unsupported-version"
  /** MAC mismatch: forged, edited, or signed with a rotated installation key. */
  | "bad-signature"
  /** Minted for a different workspace. */
  | "wrong-workspace"
  /** Minted before the current server-side context generation. */
  | "stale-generation"
  /** `expiresAtMs` has passed. */
  | "expired"
  /** `issuedAtMs` is in the future beyond the allowed clock skew. */
  | "not-yet-valid"
  /** The tier is switched off, so nothing is verified at all. */
  | "disabled";

/**
 * The verdict of reading the trusted-client-host metadata channel.
 *
 * There is deliberately no third state. Either an attestation is proven — in
 * which case the server may mint a `context_handle` and may use the
 * `client_acknowledged_prior` disposition — or it is not, and the server
 * behaves exactly as it does for an unknown client. "Probably fine" is the
 * state PI-03's acceptance criteria exist to make unreachable.
 */
export type ContextAttestationVerdict =
  | {
      ok: true;
      attestation: ContextAttestationV1;
      /** The generation the attestation was proven against. */
      generation: number;
    }
  | { ok: false; reason: ContextAttestationRejection };

/**
 * The server-side, store-backed context generation for one workspace.
 *
 * ROTATION TRIGGERS, and why these and not others. The plan asks for rotation
 * "compaction fixtureではgenerationが必ずrotateし、旧context handleのstrong use
 * 0件"; a server cannot observe host compaction, so the honest triggers are the
 * ones the store already models:
 *
 *   1. INSTALLATION-KEY ROTATION. `subjectRef` is a hash of the installation
 *      identity that signs attestations. A new key ring is a new `subjectRef`,
 *      which does not match the recorded one, which bumps the generation. This
 *      is also what makes key rotation a REVOCATION rather than merely a
 *      re-signing: old attestations fail both the MAC and the generation.
 *   2. EXPLICIT STORE RESET. `WorkspaceStateStore` mints a fresh `epoch` when
 *      it resets, and the record lives IN the store, so a reset restarts the
 *      generation under an epoch no prior attestation names.
 *   3. AN EXPLICIT SERVER-SIDE BUMP, for a caller that knows the client's
 *      context changed underneath it (the plan's `reset_context_generation`).
 *
 * Deliberately NOT a trigger: an ordinary task-state write. Reconciliation's
 * companion rule is that "context generation resetはtask handleを失効させない",
 * and the converse holds too — a task advancing does not invalidate the
 * client's retention of bytes it was already served.
 */
export type ContextGenerationState = {
  generation: number;
  /** Installation identity hash at the time this generation was recorded. */
  subjectRef: string;
  /** Store epoch this generation belongs to. */
  stateStoreEpoch: string;
  updatedAtMs: number;
};
