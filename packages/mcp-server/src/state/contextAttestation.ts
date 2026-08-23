// ---------------------------------------------------------------------------
// PI-03 attestation tier — verification, generation rotation, context handles.
//
// v0.10 close-out of DESIGN-v0.10-expansion-plan-reconciliation.md §2's PI-03
// row ("New: `ClientContextAttestation` contract (types, HMAC validation,
// `_meta[\"io.tokenlighten/context-state\"]` channel, generation rotation),
// `context_handle` issuance only after verified attestation,
// `client_acknowledged_prior` disposition allowed only then; default OFF").
// Types live in `@tokenlighten/types` domain/context-attestation.ts (D-1/D-2:
// internal domain model, never a wire object).
//
// ---------------------------------------------------------------------------
// WHAT THIS TIER IS FOR, IN ONE PARAGRAPH
// ---------------------------------------------------------------------------
//
// Today's dedup is the plan's `micro_restate` tier: a receipt withholds bytes
// but always restates enough addressing for the caller to find them, because
// the server's own emission history is NOT proof that any model still holds
// them (MCP proves nothing about context retention). A TL-aware client HOST
// can observe compaction, subagent splits and context resets, and can
// therefore make a claim the server cannot make for itself. This module
// verifies that claim. When it holds, the restatement bytes become redundant
// and may be dropped; when it does not — for any reason at all — the server
// behaves exactly as it does for an unknown client.
//
// ---------------------------------------------------------------------------
// TRANSPORT ERA COVERAGE (investigated 2026-08-20, both legs)
// ---------------------------------------------------------------------------
//
// The channel is `params._meta["io.tokenlighten/context-state"]` on
// `tools/call`. BOTH eras deliver it:
//
//   legacy (SDK v1, `mcp/transport/legacyStdio.ts`) — the handler receives the
//     raw request and reads `r.params`; `_meta` is a declared member of the
//     MCP `tools/call` params object in every revision this server serves, and
//     the SDK's schema passes it through. It was simply never read before.
//   legacy fallback (hand-rolled JSON-RPC, `mcp/transport/fallbackStdio.ts`) —
//     `handleRequest` parses `params` itself, so `_meta` is whatever the client
//     sent, verbatim.
//   modern (SDK v2, `mcp/transport/modernStdio.ts`) — same shape, same read.
//
// So the tier is NOT scoped to one era. All three legs pass the metadata into
// `callTool`, and `modernEraTransport`/`dualEraReplay` keep the two eras'
// bytes comparable. What is era-INDEPENDENT by construction is the
// verification itself: it never consults the era, per PI-09 item 14 ("one
// domain contract, both eras").
//
// ---------------------------------------------------------------------------
// WHAT IS DELIBERATELY NOT HERE
// ---------------------------------------------------------------------------
//
// No inbound `context_handle` REDEMPTION path. The plan allows strong use of a
// handle re-injected through trusted metadata, but a handle adds nothing this
// module cannot already prove from the attestation itself, and every extra
// redemption surface is another place to get purpose/workspace binding wrong.
// The handle is ISSUED (host-visible, in response `_meta`) so a host can carry
// it forward; it is not yet an input. Recorded as a gap, not hidden.
// ---------------------------------------------------------------------------

import { createHash, timingSafeEqual } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

import {
  CONTEXT_ATTESTATION_VERSION,
  CONTEXT_STATE_META_KEY,
  HANDLE_WIRE_PREFIXES,
  type ContextAttestationRejection,
  type ContextAttestationV1,
  type ContextAttestationVerdict,
  type ContextGenerationState,
} from "@tokenlighten/types";

import { contextAttestationEnabled } from "../util/flags.js";
import { handleKeyRing, type HandleKeyRing } from "./handleKeys.js";
import { mintHandle, subjectRefOf, workspaceRefOf } from "./handleCodec.js";
import { stateStoreFor } from "./stateStore.js";

// ---------------------------------------------------------------------------
// Policy constants
// ---------------------------------------------------------------------------

const ISSUER = "tokenlighten-mcp/context-v1";

/**
 * Context handles are the shortest-lived of the three purposes.
 *
 * A `task_handle` names work that outlives a session (24h); a continuation
 * names a page position (1h). A context handle names a claim about what is
 * CURRENTLY in a model's context — the most volatile thing the server tracks,
 * and the one whose staleness is least visible from the server side. 15
 * minutes is long enough for a multi-call turn and short enough that a handle
 * outliving the context it describes is a narrow window rather than a day.
 */
export const CONTEXT_HANDLE_TTL_MS = 15 * 60 * 1000;

/** Store key of the per-workspace context generation record. */
const GENERATION_KEY = "ctxgen:v1";

/** Lifetime of the generation record. Refreshed on every read that bumps it. */
const GENERATION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Tolerated clock skew for `issuedAtMs`.
 *
 * Only the FUTURE direction needs a tolerance: an attestation issued slightly
 * ahead of the server's clock is a clock difference, not an attack. The past
 * direction is already bounded by `expiresAtMs`, which the client sets.
 */
const CLOCK_SKEW_MS = 60 * 1000;

/**
 * Longest single string field accepted. A claim, not a payload — every field
 * here is an id, a hash or a short generation label.
 *
 * BOUNDED PER FIELD, NOT BY SERIALIZING THE ENVELOPE. The obvious guard —
 * measuring the UTF-8 byte length of the serialized blob — is wrong twice
 * over: that idiom is the response-level measurement the G8 fence reserves for
 * `protocol/budget/measure.ts` (wireBudgetG8Fence.spec.ts caught the first
 * draft of this file doing it), and it serializes attacker-controlled input in
 * order to decide whether that input is too large, i.e. does the expensive
 * thing first. Per-field caps bound the work before any of it happens.
 */
const MAX_FIELD_CHARS = 1024;

/** Longest `retainedReceiptIds` list accepted. */
const MAX_RETAINED_RECEIPTS = 512;

// ---------------------------------------------------------------------------
// Signature
// ---------------------------------------------------------------------------

/**
 * The exact bytes the HMAC covers.
 *
 * FIELD-LENGTH-PREFIXED, not delimiter-joined. A plain join is forgeable by
 * moving a delimiter between adjacent fields (a `clientId` of "a|b" and a
 * `workspaceRef` of "c" signs the same string as "a" and "b|c"), and two of
 * these fields are client-chosen strings. Prefixing each field with its byte
 * length makes the encoding injective, so one signature verifies exactly one
 * tuple.
 *
 * `retainedReceiptIds` is covered in the order the client sent it, not sorted:
 * re-ordering is a different claim about a different list, and normalizing it
 * away would let one signature cover several lists.
 */
function attestationMessage(input: Omit<ContextAttestationV1, "signature">): Buffer {
  const parts: Buffer[] = [];
  const push = (value: string): void => {
    const bytes = Buffer.from(value, "utf8");
    const len = Buffer.alloc(4);
    len.writeUInt32BE(bytes.length, 0);
    parts.push(len, bytes);
  };
  push("tl-context-attestation-v1");
  push(String(input.attestationVersion));
  push(input.source);
  push(input.clientId);
  push(input.workspaceRef);
  push(input.stateStoreEpoch);
  push(String(input.serverContextGeneration));
  push(input.clientContextGeneration);
  push(input.clientContextDigest);
  push(String(input.issuedAtMs));
  push(String(input.expiresAtMs));
  push(String(input.retainedReceiptIds.length));
  for (const id of input.retainedReceiptIds) push(id);
  return Buffer.concat(parts);
}

/**
 * Compute the signature for an attestation body.
 *
 * EXPORTED FOR THE REFERENCE CLIENT. A TL-aware client host is the other half
 * of this contract, and a contract only one side can implement is not a
 * contract — the test harness in `__tests__/helpers/contextAttestation.ts`
 * uses this to build valid attestations, exactly as a real adapter would over
 * the same installation key.
 *
 * The key is the INSTALLATION key ring (`handleKeys.ts`), which is why a key
 * rotation revokes every outstanding attestation: the signature stops
 * verifying AND the generation bump below fires.
 */
export function signContextAttestation(
  body: Omit<ContextAttestationV1, "signature">,
  ring: HandleKeyRing = handleKeyRing(),
): string {
  return ring.sign(attestationMessage(body), 32).toString("base64url");
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

function readGenerationRecord(workspaceRoot: string): ContextGenerationState | undefined {
  const store = stateStoreFor(workspaceRoot);
  if (store === undefined || !store.available) return undefined;
  const record = store.get(GENERATION_KEY);
  if (record === undefined || record.purpose !== "context") return undefined;
  const data = record.data;
  if (typeof data["generation"] !== "number" || !Number.isInteger(data["generation"])) return undefined;
  if (typeof data["subjectRef"] !== "string" || typeof data["stateStoreEpoch"] !== "string") return undefined;
  return {
    generation: data["generation"],
    subjectRef: data["subjectRef"],
    stateStoreEpoch: data["stateStoreEpoch"],
    updatedAtMs: typeof data["updatedAtMs"] === "number" ? data["updatedAtMs"] : record.updatedAtMs,
  };
}

function writeGenerationRecord(workspaceRoot: string, next: ContextGenerationState): boolean {
  const store = stateStoreFor(workspaceRoot);
  if (store === undefined || !store.available) return false;
  return store.put({
    key: GENERATION_KEY,
    purpose: "context",
    data: { ...next },
    ttlMs: GENERATION_TTL_MS,
  }).ok;
}

/**
 * The current server-side context generation for `workspaceRoot`, seeding or
 * ROTATING it as the store's own state demands.
 *
 * Returns `undefined` when there is no durable store: with nowhere to record a
 * generation, nothing can be rotated, and a tier whose revocation mechanism
 * does not work must not run at all. Fail-closed, not best-effort.
 *
 * The three honest triggers (see `ContextGenerationState`'s doc):
 *   1. no record, or a record from a DIFFERENT store epoch  -> seed at 1 in
 *      the current epoch. A store reset mints a fresh epoch, so this is the
 *      reset trigger;
 *   2. a record whose `subjectRef` is not the current installation identity ->
 *      bump. This is the installation-key rotation trigger;
 *   3. an explicit `rotateContextGeneration` call.
 */
export function currentContextGeneration(workspaceRoot: string): number | undefined {
  const store = stateStoreFor(workspaceRoot);
  if (store === undefined || !store.available) return undefined;
  const subjectRef = subjectRefOf(handleKeyRing());
  const record = readGenerationRecord(workspaceRoot);

  if (record === undefined || record.stateStoreEpoch !== store.epoch) {
    const seeded: ContextGenerationState = {
      generation: 1,
      subjectRef,
      stateStoreEpoch: store.epoch,
      updatedAtMs: Date.now(),
    };
    return writeGenerationRecord(workspaceRoot, seeded) ? seeded.generation : undefined;
  }
  if (record.subjectRef !== subjectRef) {
    const rotated: ContextGenerationState = {
      generation: record.generation + 1,
      subjectRef,
      stateStoreEpoch: store.epoch,
      updatedAtMs: Date.now(),
    };
    return writeGenerationRecord(workspaceRoot, rotated) ? rotated.generation : undefined;
  }
  return record.generation;
}

/**
 * Explicitly rotate the context generation (the plan's
 * `reset_context_generation`). Every attestation and `context_handle` minted
 * before this call stops verifying; TASK handles are untouched, per
 * reconciliation's "context generation resetはtask handleを失効させない".
 */
export function rotateContextGeneration(workspaceRoot: string): number | undefined {
  const store = stateStoreFor(workspaceRoot);
  if (store === undefined || !store.available) return undefined;
  const current = currentContextGeneration(workspaceRoot);
  if (current === undefined) return undefined;
  const rotated: ContextGenerationState = {
    generation: current + 1,
    subjectRef: subjectRefOf(handleKeyRing()),
    stateStoreEpoch: store.epoch,
    updatedAtMs: Date.now(),
  };
  return writeGenerationRecord(workspaceRoot, rotated) ? rotated.generation : undefined;
}

// ---------------------------------------------------------------------------
// Parse + verify
// ---------------------------------------------------------------------------

function isBoundedStringArray(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length <= MAX_RETAINED_RECEIPTS
    && value.every((entry) => typeof entry === "string" && entry.length > 0 && entry.length <= MAX_FIELD_CHARS);
}

/**
 * Structural parse of the metadata channel. DEFENSIVE BY CONSTRUCTION: every
 * field is checked, nothing is coerced, and any surprise is `malformed` — the
 * same outcome as absent.
 */
function parseAttestation(raw: unknown): { ok: true; body: ContextAttestationV1 } | { ok: false; reason: ContextAttestationRejection } {
  if (raw === undefined || raw === null) return { ok: false, reason: "absent" };
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "malformed" };
  const v = raw as Record<string, unknown>;

  // Version FIRST: an envelope this server does not implement is never
  // partially interpreted.
  if (v["attestationVersion"] !== CONTEXT_ATTESTATION_VERSION) {
    return { ok: false, reason: "unsupported-version" };
  }
  if (v["source"] !== "trusted-client-host") return { ok: false, reason: "malformed" };

  // Non-empty AND bounded: an over-long field is `malformed`, never truncated
  // — a truncated field would change what the MAC covers.
  const str = (key: string): string | undefined =>
    typeof v[key] === "string" && (v[key] as string).length > 0 && (v[key] as string).length <= MAX_FIELD_CHARS
      ? (v[key] as string)
      : undefined;
  const num = (key: string): number | undefined =>
    typeof v[key] === "number" && Number.isFinite(v[key] as number) ? (v[key] as number) : undefined;

  const clientId = str("clientId");
  const clientContextGeneration = str("clientContextGeneration");
  const clientContextDigest = str("clientContextDigest");
  const workspaceRef = str("workspaceRef");
  const stateStoreEpoch = str("stateStoreEpoch");
  const signature = str("signature");
  const serverContextGeneration = num("serverContextGeneration");
  const issuedAtMs = num("issuedAtMs");
  const expiresAtMs = num("expiresAtMs");
  const retainedReceiptIds = v["retainedReceiptIds"];

  if (
    clientId === undefined || clientContextGeneration === undefined
    || clientContextDigest === undefined || workspaceRef === undefined
    || stateStoreEpoch === undefined || signature === undefined
    || serverContextGeneration === undefined || !Number.isInteger(serverContextGeneration)
    || issuedAtMs === undefined || expiresAtMs === undefined
    || !isBoundedStringArray(retainedReceiptIds)
  ) {
    return { ok: false, reason: "malformed" };
  }

  return {
    ok: true,
    body: {
      attestationVersion: CONTEXT_ATTESTATION_VERSION,
      source: "trusted-client-host",
      clientId,
      clientContextGeneration,
      clientContextDigest,
      workspaceRef,
      stateStoreEpoch,
      serverContextGeneration,
      retainedReceiptIds,
      issuedAtMs,
      expiresAtMs,
      signature,
    },
  };
}

export interface VerifyContextAttestationInput {
  /** The `_meta` object from the tools/call request params, if any. */
  meta?: Record<string, unknown> | undefined;
  /** Resolved workspace root of THIS call. */
  workspaceRoot: string;
  /** Clock override for expiry tests. */
  nowMs?: number;
  ring?: HandleKeyRing;
}

/**
 * Read the trusted-client-host channel and decide whether it proves retention.
 *
 * ORDER IS DELIBERATE. Cheap structural checks run before the MAC, and the MAC
 * runs before every binding check — so a binding failure is only ever reported
 * for an attestation that is at least authentic. That is the same ordering
 * `validateHandleToken` uses, and for the same reason: bindings carried by an
 * unauthenticated blob are attacker-chosen and must not steer a diagnosis.
 *
 * Every failure returns `ok:false` and NOTHING else happens. There is no
 * partial acceptance, no "weak" tier, and no telemetry side effect that could
 * make a rejected attestation observable in a response.
 */
export function verifyContextAttestation(input: VerifyContextAttestationInput): ContextAttestationVerdict {
  if (!contextAttestationEnabled()) return { ok: false, reason: "disabled" };

  const channel = input.meta?.[CONTEXT_STATE_META_KEY];
  if (channel === undefined || channel === null) return { ok: false, reason: "absent" };
  if (typeof channel !== "object" || Array.isArray(channel)) return { ok: false, reason: "malformed" };

  const raw = (channel as Record<string, unknown>)["context_attestation"];
  if (raw === undefined) return { ok: false, reason: "absent" };

  // Bounds live INSIDE the parse, per field (see `MAX_FIELD_CHARS`), so the
  // work is bounded before any of it is done — no serialization of
  // attacker-controlled input to decide whether that input is too large.
  const parsed = parseAttestation(raw);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  const body = parsed.body;

  // --- authenticity -------------------------------------------------------
  const ring = input.ring ?? handleKeyRing();
  const expected = ring.sign(attestationMessage(body), 32);
  let presented: Buffer;
  try {
    presented = Buffer.from(body.signature, "base64url");
  } catch {
    return { ok: false, reason: "bad-signature" };
  }
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    return { ok: false, reason: "bad-signature" };
  }

  // --- bindings, now that the claim is authentic --------------------------
  if (body.workspaceRef !== workspaceRefOf(input.workspaceRoot)) {
    return { ok: false, reason: "wrong-workspace" };
  }

  const now = input.nowMs ?? Date.now();
  if (now >= body.expiresAtMs) return { ok: false, reason: "expired" };
  if (body.issuedAtMs - CLOCK_SKEW_MS > now) return { ok: false, reason: "not-yet-valid" };

  const generation = currentContextGeneration(input.workspaceRoot);
  if (generation === undefined) {
    // No durable store => no revocation mechanism => no tier. See
    // `currentContextGeneration`.
    return { ok: false, reason: "stale-generation" };
  }
  const store = stateStoreFor(input.workspaceRoot);
  if (store === undefined || body.stateStoreEpoch !== store.epoch) {
    return { ok: false, reason: "stale-generation" };
  }
  if (body.serverContextGeneration !== generation) {
    return { ok: false, reason: "stale-generation" };
  }

  return { ok: true, attestation: body, generation };
}

// ---------------------------------------------------------------------------
// Context handle issuance
// ---------------------------------------------------------------------------

/**
 * Mint the `tlh_ctx_v1_` handle for a VERIFIED attestation.
 *
 * The `context` purpose already exists in the codec's closed purpose set, so
 * this adds no new namespace — and because `validateHandleToken` refuses a
 * purpose mismatch, a context handle can never be redeemed where a task handle
 * or a continuation cursor is expected.
 *
 * `payloadRef` is derived from (generation, workspace, client, digest) rather
 * than random, so re-attesting the same context within a generation yields a
 * stable reference instead of a fresh one per call.
 */
export function mintContextHandle(
  workspaceRoot: string,
  attestation: ContextAttestationV1,
  generation: number,
): string | undefined {
  const store = stateStoreFor(workspaceRoot);
  if (store === undefined || !store.available) return undefined;
  try {
    const payloadRef = createHash("sha256")
      .update(`ctx:${store.epoch}:${generation}:${workspaceRoot}:${attestation.clientId}:${attestation.clientContextDigest}`, "utf8")
      .digest()
      .subarray(0, 9);
    const minted = mintHandle({
      purpose: "context",
      workspaceRoot,
      storeEpoch: store.epoch,
      stateVersion: generation,
      ttlMs: CONTEXT_HANDLE_TTL_MS,
      issuer: ISSUER,
      payloadRef,
    });
    return minted.token;
  } catch {
    return undefined;
  }
}

/** Diagnostic: does this string LOOK like a context handle? Never a check. */
export function looksLikeContextHandle(value: string): boolean {
  return value.startsWith(HANDLE_WIRE_PREFIXES.context);
}

// ---------------------------------------------------------------------------
// Per-call binding
// ---------------------------------------------------------------------------

/**
 * The verified attestation of the CURRENT call, if any.
 *
 * An `AsyncLocalStorage` slot rather than a parameter for the same reason
 * `protocol/envelope.ts` uses one: the consumer is the receipt projector, ten
 * frames below dispatch and reached through code paths that have no business
 * knowing this tier exists. Concurrent calls each get their own slot.
 */
export interface VerifiedContextAttestation {
  attestation: ContextAttestationV1;
  generation: number;
  workspaceRoot: string;
  /** The handle minted for this call, when one could be minted. */
  contextHandle?: string;
}

const _verified = new AsyncLocalStorage<VerifiedContextAttestation>();

export function runWithVerifiedContext<T>(value: VerifiedContextAttestation | undefined, fn: () => T): T {
  if (value === undefined) return fn();
  return _verified.run(value, fn);
}

/**
 * The current call's verified attestation, or undefined.
 *
 * Re-checks the flag on every read. A consumer therefore cannot act on a stale
 * binding if the flag were switched off mid-process (tests do exactly that),
 * and "flag off" and "no attestation" stay the same observable state.
 */
export function verifiedContextAttestation(): VerifiedContextAttestation | undefined {
  if (!contextAttestationEnabled()) return undefined;
  return _verified.getStore();
}

/**
 * May this call use the `client_acknowledged_prior` disposition for evidence
 * the given handle addresses?
 *
 * TWO CONDITIONS, both necessary:
 *   - a VERIFIED attestation for THIS workspace is bound to the call, and
 *   - the attestation's `retainedReceiptIds` actually names this handle.
 *
 * The second is what keeps the tier from becoming a blanket "this client is
 * fine" switch: the plan's 受入基準 include "未配信span、shed body、provisional
 * bodyをacknowledged-prior扱いするfalse suppression 0件", and a client that
 * attests to holding A and B must not thereby license suppression of C.
 */
export function clientAcknowledgedPrior(handle: string | undefined, workspaceRoot?: string): boolean {
  if (handle === undefined || handle === "") return false;
  const verified = verifiedContextAttestation();
  if (verified === undefined) return false;
  // The workspace binding was already proven at VERIFY time against this
  // call's resolved root; re-checking it is available to callers that hold a
  // root of their own (the write path's adopted workspace, say) and skipped by
  // those that do not. The claim itself — "I still hold the bytes served under
  // handle X" — is a fact about the CLIENT's context, so a handle adopted from
  // another workspace is still a handle whose bytes that client received.
  if (workspaceRoot !== undefined && verified.workspaceRoot !== workspaceRoot) return false;
  return verified.attestation.retainedReceiptIds.includes(handle);
}

// NO `resetVerifiedContextForTests` HOOK, deliberately. Every other state
// module here exports one because its state is module-level and outlives a
// call; this binding does not. `runWithVerifiedContext` scopes it to exactly
// one `callTool`, so there is nothing for a later test to inherit — and the
// only way to "clear" an AsyncLocalStorage from outside a `run()` is
// `enterWith(undefined)`, which leaks a poisoned slot into whatever execution
// context happens to be current. A hook that can only be implemented unsafely,
// for a leak that cannot occur, is worse than no hook.
