/**
 * handleCodec.ts — purpose-bound, MAC-authenticated state handles (PI-09).
 *
 * WIRE SHAPE. `<prefix><base64url(body || mac)>`, where `<prefix>` is one of
 * `HANDLE_WIRE_PREFIXES` (`tlh_task_v1_` / `tlh_ctx_v1_` / `tlh_cont_v1_`).
 * The token is OPAQUE: `packages/types/src/domain/state-handle.ts`'s file
 * header is the contract — a `DecodedStateHandle` is a server-side view that is
 * NEVER put on the wire, and the token carries no raw source body, no absolute
 * path and no credential. Every field below is a fixed-width integer or a
 * TRUNCATED HASH; the only variable-width region is `aad`, whose contents are
 * chosen by the mint site and are subject to the same no-path/no-source rule
 * (see `mintHandle`'s `aad` doc).
 *
 * BODY LAYOUT (big-endian; `HEADER_BYTES` = 61):
 *
 *   off  size  field              notes
 *   ---  ----  -----------------  ----------------------------------------
 *     0     1  tokenVersion       always 1 in v0.10
 *     1     1  purpose            1=task 2=context 3=continuation
 *     2     4  keyId              names the signing key (rotation)
 *     6     8  workspaceRef       sha256(realpath root), truncated
 *    14     8  subjectRef         sha256("subject:" + installationId)
 *    22     4  issuerId           sha256("issuer:" + server build stamp)
 *    26     4  stateStoreEpoch    the store generation this handle belongs to
 *    30     9  payloadRef         random store key (12 base64url chars)
 *    39     4  stateVersion       uint32, the CAS version at mint time
 *    43     4  issuedAt           uint32 seconds since HANDLE_EPOCH
 *    47     4  expiresAt          uint32 seconds since HANDLE_EPOCH
 *    51     8  nonce              replay-distinguishing randomness
 *    59     2  aadLen             uint16, length of the authenticated tail
 *    61     n  aad                authenticated, NOT encrypted
 *
 * MAC = HMAC-SHA256(activeKey, prefixBytes || body), truncated to 16 bytes and
 * appended to the body. The PREFIX is inside the MAC input on purpose: a
 * `tlh_cont_v1_` token cannot be re-labelled `tlh_task_v1_` and still verify,
 * so purpose confusion is caught by the MAC itself and not only by the
 * (advisory, diagnostic) prefix comparison — PI-09's "purpose prefixは診断用に
 * 使うが、securityはMACとserver-side validationで担保する".
 *
 * SIZE. Body 61 + MAC 16 = 77 bytes with no `aad` -> 103 base64url chars, plus
 * a 12/11/13-char prefix = 115/114/116 chars on the wire. `HANDLE_WIRE_SIZE_MAX`
 * (512) is asserted at mint time and is a hard failure, not a warning; the p95
 * target of `HANDLE_WIRE_SIZE_TARGET_P95` (256) leaves ~140 bytes of `aad`
 * headroom, which is what bounds the continuation payload.
 *
 * FAIL-CLOSED OUTCOMES. `validateHandle` never throws and never returns a
 * partial success: the caller gets either `{ok:true, decoded}` or a NAMED
 * outcome. `invalid` covers tamper, unknown key, malformed base64 and truncated
 * bodies; `wrong-purpose`, `expired`, `wrong-workspace` and `wrong-subject`
 * are separated so the refusal layer can offer the right recovery. `stale` and
 * `unknown` are STORE outcomes and are produced by `stateHandles.ts`, not here
 * — this module has no I/O.
 */

import { createHash, randomBytes } from "node:crypto";

import {
  HANDLE_WIRE_PREFIXES,
  HANDLE_WIRE_SIZE_MAX,
  STATE_HANDLE_PURPOSES,
  parseHandlePurposeFromPrefix,
  type DecodedStateHandle,
  type StateHandlePurpose,
} from "@tokenlighten/types";

import { handleKeyRing, type HandleKeyRing } from "./handleKeys.js";

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

const TOKEN_VERSION = 1;
const KEY_ID_BYTES = 4;
const WORKSPACE_REF_BYTES = 8;
const SUBJECT_REF_BYTES = 8;
const ISSUER_ID_BYTES = 4;
const STORE_EPOCH_BYTES = 4;
const PAYLOAD_REF_BYTES = 9;
const NONCE_BYTES = 8;
const MAC_BYTES = 16;

const OFF_TOKEN_VERSION = 0;
const OFF_PURPOSE = 1;
const OFF_KEY_ID = 2;
const OFF_WORKSPACE_REF = OFF_KEY_ID + KEY_ID_BYTES;
const OFF_SUBJECT_REF = OFF_WORKSPACE_REF + WORKSPACE_REF_BYTES;
const OFF_ISSUER_ID = OFF_SUBJECT_REF + SUBJECT_REF_BYTES;
const OFF_STORE_EPOCH = OFF_ISSUER_ID + ISSUER_ID_BYTES;
const OFF_PAYLOAD_REF = OFF_STORE_EPOCH + STORE_EPOCH_BYTES;
const OFF_STATE_VERSION = OFF_PAYLOAD_REF + PAYLOAD_REF_BYTES;
const OFF_ISSUED_AT = OFF_STATE_VERSION + 4;
const OFF_EXPIRES_AT = OFF_ISSUED_AT + 4;
const OFF_NONCE = OFF_EXPIRES_AT + 4;
const OFF_AAD_LEN = OFF_NONCE + NONCE_BYTES;
export const HEADER_BYTES = OFF_AAD_LEN + 2;

/**
 * 2020-01-01T00:00:00Z. Timestamps are uint32 SECONDS from here rather than
 * uint64 milliseconds: 4 bytes each instead of 8, valid to the year 2156, and
 * a one-second granularity that no expiry policy in this codebase needs to
 * beat. `DecodedStateHandle` still exposes them as `…Ms`.
 */
const HANDLE_EPOCH_MS = Date.UTC(2020, 0, 1);

const PURPOSE_CODES: Record<StateHandlePurpose, number> = { task: 1, context: 2, continuation: 3 };
const PURPOSE_BY_CODE = new Map<number, StateHandlePurpose>(
  STATE_HANDLE_PURPOSES.map((p) => [PURPOSE_CODES[p], p]),
);

/** Largest `aad` that still fits under `HANDLE_WIRE_SIZE_MAX` on every prefix. */
export const MAX_AAD_BYTES = 256;

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

/**
 * Every way a handle can fail to be usable. `stale`/`unknown`/`state-conflict`
 * and `store-unavailable` are produced by the store layer; the rest are decided
 * here. Kept as one union so the refusal layer has ONE exhaustive switch.
 */
export type HandleFailure =
  | "invalid"
  | "wrong-purpose"
  | "expired"
  | "wrong-workspace"
  | "wrong-subject"
  | "stale"
  | "unknown"
  | "state-conflict"
  | "store-unavailable";

export type HandleValidation<T = undefined> =
  | { ok: true; decoded: DecodedStateHandle; aad: Buffer; state: T }
  | { ok: false; outcome: HandleFailure; detail?: string };

export interface MintHandleInput {
  purpose: StateHandlePurpose;
  /** Absolute, fully resolved workspace root. Hashed — never embedded. */
  workspaceRoot: string;
  /** Store generation this handle belongs to (4 raw bytes, hex-encoded). */
  storeEpoch: string;
  /** CAS version of the referenced state at mint time. */
  stateVersion: number;
  /** Lifetime in ms. Clamped to what a uint32-second field can express. */
  ttlMs: number;
  /**
   * Authenticated tail. Integrity-protected but NOT confidential — anything
   * here is readable by whoever holds the token, so it must contain no source
   * bytes, no absolute path and no credential. Used by the continuation
   * purpose to carry a page position without a store round-trip.
   */
  aad?: Buffer;
  /** Test/rotation seam. Defaults to the process key ring. */
  ring?: HandleKeyRing;
  /** Fixed payload ref (store key). Random when omitted. */
  payloadRef?: Buffer;
  /** Issuer identity (server build stamp or equivalent). */
  issuer: string;
}

export interface MintedHandle {
  token: string;
  decoded: DecodedStateHandle;
  /** The store key this handle refers to (base64url, 12 chars). */
  payloadRef: string;
}

// ---------------------------------------------------------------------------
// Derivations
// ---------------------------------------------------------------------------

function truncatedHash(input: string, bytes: number): Buffer {
  return createHash("sha256").update(input, "utf8").digest().subarray(0, bytes);
}

/** Hash of the REAL workspace root. The raw path never enters a token. */
export function workspaceRefOf(workspaceRoot: string): string {
  return truncatedHash(`ws:${workspaceRoot}`, WORKSPACE_REF_BYTES).toString("hex");
}

/**
 * Subject binding. Derived from the INSTALLATION identity, never from
 * `clientInfo.name` — PI-09 item 6: "modelが申告するclient名をauthorization
 * boundaryに使わない".
 */
export function subjectRefOf(ring: HandleKeyRing): string {
  return truncatedHash(`subject:${ring.installationId}`, SUBJECT_REF_BYTES).toString("hex");
}

export function issuerIdOf(issuer: string): string {
  return truncatedHash(`issuer:${issuer}`, ISSUER_ID_BYTES).toString("hex");
}

function secondsSinceEpoch(ms: number): number {
  return Math.max(0, Math.min(0xffffffff, Math.floor((ms - HANDLE_EPOCH_MS) / 1000)));
}

function msFromSeconds(seconds: number): number {
  return HANDLE_EPOCH_MS + seconds * 1000;
}

// ---------------------------------------------------------------------------
// Mint
// ---------------------------------------------------------------------------

export function mintHandle(input: MintHandleInput): MintedHandle {
  const ring = input.ring ?? handleKeyRing();
  const aad = input.aad ?? Buffer.alloc(0);
  if (aad.length > MAX_AAD_BYTES) {
    throw new Error(`state handle aad ${aad.length}B exceeds ${MAX_AAD_BYTES}B`);
  }
  const payloadRef = input.payloadRef ?? randomBytes(PAYLOAD_REF_BYTES);
  if (payloadRef.length !== PAYLOAD_REF_BYTES) {
    throw new Error(`payloadRef must be exactly ${PAYLOAD_REF_BYTES} bytes`);
  }

  const issuedAtMs = Date.now();
  const expiresAtMs = issuedAtMs + Math.max(1000, input.ttlMs);
  const nonce = randomBytes(NONCE_BYTES);
  const storeEpoch = Buffer.from(input.storeEpoch, "hex");
  const epochBytes = Buffer.alloc(STORE_EPOCH_BYTES);
  storeEpoch.copy(epochBytes, 0, 0, Math.min(STORE_EPOCH_BYTES, storeEpoch.length));

  const body = Buffer.alloc(HEADER_BYTES + aad.length);
  body.writeUInt8(TOKEN_VERSION, OFF_TOKEN_VERSION);
  body.writeUInt8(PURPOSE_CODES[input.purpose], OFF_PURPOSE);
  Buffer.from(ring.activeKeyId, "hex").copy(body, OFF_KEY_ID, 0, KEY_ID_BYTES);
  Buffer.from(workspaceRefOf(input.workspaceRoot), "hex").copy(body, OFF_WORKSPACE_REF);
  Buffer.from(subjectRefOf(ring), "hex").copy(body, OFF_SUBJECT_REF);
  Buffer.from(issuerIdOf(input.issuer), "hex").copy(body, OFF_ISSUER_ID);
  epochBytes.copy(body, OFF_STORE_EPOCH);
  payloadRef.copy(body, OFF_PAYLOAD_REF);
  body.writeUInt32BE(Math.max(0, Math.min(0xffffffff, Math.floor(input.stateVersion))), OFF_STATE_VERSION);
  body.writeUInt32BE(secondsSinceEpoch(issuedAtMs), OFF_ISSUED_AT);
  body.writeUInt32BE(secondsSinceEpoch(expiresAtMs), OFF_EXPIRES_AT);
  nonce.copy(body, OFF_NONCE);
  body.writeUInt16BE(aad.length, OFF_AAD_LEN);
  aad.copy(body, HEADER_BYTES);

  const prefix = HANDLE_WIRE_PREFIXES[input.purpose];
  const mac = ring.sign(Buffer.concat([Buffer.from(prefix, "utf8"), body]), MAC_BYTES);
  const token = prefix + Buffer.concat([body, mac]).toString("base64url");

  if (Buffer.byteLength(token, "utf8") > HANDLE_WIRE_SIZE_MAX) {
    throw new Error(
      `state handle ${Buffer.byteLength(token, "utf8")}B exceeds the frozen ${HANDLE_WIRE_SIZE_MAX}B ceiling`,
    );
  }

  return {
    token,
    payloadRef: payloadRef.toString("base64url"),
    decoded: decodeUnchecked(body, mac, input.purpose)!,
  };
}

// ---------------------------------------------------------------------------
// Decode / validate
// ---------------------------------------------------------------------------

function decodeUnchecked(body: Buffer, mac: Buffer, purpose: StateHandlePurpose): DecodedStateHandle | undefined {
  if (body.length < HEADER_BYTES) return undefined;
  return {
    tokenVersion: 1,
    purpose,
    keyId: body.subarray(OFF_KEY_ID, OFF_KEY_ID + KEY_ID_BYTES).toString("hex"),
    payloadRef: body.subarray(OFF_PAYLOAD_REF, OFF_PAYLOAD_REF + PAYLOAD_REF_BYTES).toString("base64url"),
    workspaceRef: body.subarray(OFF_WORKSPACE_REF, OFF_WORKSPACE_REF + WORKSPACE_REF_BYTES).toString("hex"),
    subjectRef: body.subarray(OFF_SUBJECT_REF, OFF_SUBJECT_REF + SUBJECT_REF_BYTES).toString("hex"),
    stateVersion: body.readUInt32BE(OFF_STATE_VERSION),
    issuerId: body.subarray(OFF_ISSUER_ID, OFF_ISSUER_ID + ISSUER_ID_BYTES).toString("hex"),
    stateStoreEpoch: body.subarray(OFF_STORE_EPOCH, OFF_STORE_EPOCH + STORE_EPOCH_BYTES).toString("hex"),
    issuedAtMs: msFromSeconds(body.readUInt32BE(OFF_ISSUED_AT)),
    expiresAtMs: msFromSeconds(body.readUInt32BE(OFF_EXPIRES_AT)),
    nonce: body.subarray(OFF_NONCE, OFF_NONCE + NONCE_BYTES).toString("hex"),
    mac: mac.toString("base64url"),
  };
}

export interface ValidateHandleInput {
  token: string;
  /** The purpose the CALL SITE requires. A mismatch is `wrong-purpose`. */
  expectedPurpose: StateHandlePurpose;
  /** Absolute resolved workspace root of the current call, when known. */
  workspaceRoot?: string;
  /** Clock override for expiry tests. */
  nowMs?: number;
  ring?: HandleKeyRing;
}

/**
 * Cryptographic + binding validation. Never throws.
 *
 * ORDER MATTERS and is deliberate: authenticity FIRST, then the bindings the
 * MAC now proves. Reporting `expired` for a forged token would leak that the
 * forgery decoded; reporting `invalid` for a genuine-but-expired one would
 * deny the caller its recovery. Purpose is checked before the MAC only through
 * the PREFIX (a cheap reject); the MAC covers the prefix, so a re-labelled
 * token still fails as `invalid` rather than passing as the wrong purpose.
 */
export function validateHandleToken(input: ValidateHandleInput): HandleValidation {
  const ring = input.ring ?? handleKeyRing();
  const prefixPurpose = parseHandlePurposeFromPrefix(input.token);
  if (prefixPurpose === undefined) return { ok: false, outcome: "invalid", detail: "unrecognised handle prefix" };
  if (Buffer.byteLength(input.token, "utf8") > HANDLE_WIRE_SIZE_MAX) {
    return { ok: false, outcome: "invalid", detail: "handle exceeds the wire ceiling" };
  }

  const prefix = HANDLE_WIRE_PREFIXES[prefixPurpose];
  const encoded = input.token.slice(prefix.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) {
    return { ok: false, outcome: "invalid", detail: "handle payload is not base64url" };
  }
  const raw = Buffer.from(encoded, "base64url");
  if (raw.length < HEADER_BYTES + MAC_BYTES) {
    return { ok: false, outcome: "invalid", detail: "handle payload is truncated" };
  }
  // CANONICAL ENCODING REQUIRED. base64 ignores the padding bits of a partial
  // final group, so up to four distinct strings decode to the SAME bytes and
  // therefore carry the SAME valid MAC. That is harmless for authenticity and
  // NOT harmless here: this token is an IDENTITY (`task.id`), and two spellings
  // of one handle would compare unequal as strings while resolving to one piece
  // of state — a dedup/receipt hazard, and a needless "same handle, different
  // bytes" surface. Re-encoding and requiring equality makes the mapping
  // token <-> state one-to-one. Every minted token is canonical by
  // construction, so this can only reject a rewritten one.
  if (raw.toString("base64url") !== encoded) {
    return { ok: false, outcome: "invalid", detail: "handle payload is not canonically encoded" };
  }
  const body = raw.subarray(0, raw.length - MAC_BYTES);
  const mac = raw.subarray(raw.length - MAC_BYTES);
  const aadLen = body.readUInt16BE(OFF_AAD_LEN);
  if (body.length !== HEADER_BYTES + aadLen) {
    return { ok: false, outcome: "invalid", detail: "handle length disagrees with its own aad length" };
  }
  if (body.readUInt8(OFF_TOKEN_VERSION) !== TOKEN_VERSION) {
    return { ok: false, outcome: "invalid", detail: "unknown handle token version" };
  }
  const bodyPurpose = PURPOSE_BY_CODE.get(body.readUInt8(OFF_PURPOSE));
  if (bodyPurpose === undefined) {
    return { ok: false, outcome: "invalid", detail: "unknown handle purpose code" };
  }

  const keyId = body.subarray(OFF_KEY_ID, OFF_KEY_ID + KEY_ID_BYTES).toString("hex");
  if (!ring.verify(keyId, Buffer.concat([Buffer.from(prefix, "utf8"), body]), mac)) {
    // Tamper, unknown key, and a re-labelled prefix all land here.
    return { ok: false, outcome: "invalid", detail: "handle authentication failed" };
  }

  const decoded = decodeUnchecked(body, mac, bodyPurpose)!;

  // Authenticity is proven; the bindings it carries can now be trusted.
  if (bodyPurpose !== input.expectedPurpose || prefixPurpose !== input.expectedPurpose) {
    return { ok: false, outcome: "wrong-purpose", detail: `handle purpose is ${bodyPurpose}` };
  }
  if (decoded.subjectRef !== subjectRefOf(ring)) {
    return { ok: false, outcome: "wrong-subject", detail: "handle belongs to another installation" };
  }
  const now = input.nowMs ?? Date.now();
  if (now >= decoded.expiresAtMs) {
    return { ok: false, outcome: "expired", detail: "handle lifetime elapsed" };
  }
  if (input.workspaceRoot !== undefined && decoded.workspaceRef !== workspaceRefOf(input.workspaceRoot)) {
    return { ok: false, outcome: "wrong-workspace", detail: "handle belongs to another workspace" };
  }

  return { ok: true, decoded, aad: body.subarray(HEADER_BYTES), state: undefined };
}

/** Diagnostic only: does this string LOOK like a state handle of any purpose? */
export function looksLikeStateHandle(value: string): boolean {
  return parseHandlePurposeFromPrefix(value) !== undefined;
}
