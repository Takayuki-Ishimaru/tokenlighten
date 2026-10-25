import {createHash} from "node:crypto";
import type {ReadCallCursorAliasRecord} from "@tokenlighten/types";
import {validateHandleToken, workspaceRefOf} from "./handleCodec.js";
import {resolveReadCallContinuation} from "./readCallContinuationStore.js";
import {FETCH_REQUEST_HANDLE_TTL_MS, fetchRequestPayloadRef} from "./stateHandles.js";
import {stateStoreFor} from "./stateStore.js";

const PREFIX = "tlc_s1_";
const ALIAS_RE = /^tlc_s1_([A-Za-z0-9_-]{12})_([A-Za-z0-9_-]{22})$/;
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

function aliasDigest(canonical: string, lane: string): string {
  return createHash("sha256").update(`tokenlighten:read-call-cursor-alias:v1\0${canonical}\0${lane}`, "utf8")
    .digest().subarray(0, 16).toString("base64url");
}

function aliasFor(canonical: string, payloadRef: string, lane: string): string {
  return `${PREFIX}${payloadRef}_${aliasDigest(canonical, lane)}`;
}

function recordKey(alias: string): string {
  return fetchRequestPayloadRef(`read-call-cursor-alias:${alias}`).toString("base64url");
}

export type ReadCallCursorAliasResolution =
  | {kind: "other"}
  | {kind: "refusal"; detail: string}
  | {kind: "canonical"; cursor: string};

/** Return a short alias only after its canonical immutable plan is persisted and authenticated. */
export function mintReadCallCursorAlias(input: {
  workspaceRoot: string; lane: string; canonicalCursor: string;
}): string | undefined {
  try {
    const resolved = resolveReadCallContinuation({workspaceRoot: input.workspaceRoot, lane: input.lane, cursor: input.canonicalCursor});
    if (resolved.kind !== "read-call") return undefined;
    const store = stateStoreFor(input.workspaceRoot);
    if (!store?.available) return undefined;
    const canonical = validateHandleToken({token: input.canonicalCursor, expectedPurpose: "read-request", workspaceRoot: input.workspaceRoot});
    const parent = validateHandleToken({token: resolved.state.task_handle, expectedPurpose: "task", workspaceRoot: input.workspaceRoot});
    if (!canonical.ok || !parent.ok) return undefined;
    const expiresAtMs = Math.min(resolved.state.expires_at_ms, canonical.decoded.expiresAtMs, parent.decoded.expiresAtMs);
    const now = Date.now();
    if (expiresAtMs <= now || expiresAtMs - now > FETCH_REQUEST_HANDLE_TTL_MS) return undefined;
    const alias = aliasFor(input.canonicalCursor, canonical.decoded.payloadRef, input.lane);
    const existing = store.get(recordKey(alias));
    if (existing) {
      const checked = resolveReadCallCursorAlias({workspaceRoot: input.workspaceRoot, lane: input.lane, cursor: alias});
      return checked.kind === "canonical" && checked.cursor === input.canonicalCursor ? alias : undefined;
    }
    const data: ReadCallCursorAliasRecord = {
      v: 1, family: "read-call-cursor-alias", alias, canonical_cursor: input.canonicalCursor,
      payload_ref: canonical.decoded.payloadRef, lane: input.lane, expires_at_ms: expiresAtMs,
    };
    const put = store.put({key: recordKey(alias), purpose: "read-request", data: data as unknown as Record<string, unknown>,
      ttlMs: expiresAtMs - now, expectedVersion: 0});
    if (put.ok) return alias;
    // Another concurrent projection may have published the same immutable mapping.
    const checked = resolveReadCallCursorAlias({workspaceRoot: input.workspaceRoot, lane: input.lane, cursor: alias});
    return checked.kind === "canonical" && checked.cursor === input.canonicalCursor ? alias : undefined;
  } catch { return undefined; }
}

/** Lookup-only reverse projection used when an already-published sibling is reused. */
export function readCallCursorAliasForCanonical(input: {
  workspaceRoot: string; lane: string; canonicalCursor: string;
}): string | undefined {
  try {
    const validation = validateHandleToken({token: input.canonicalCursor, expectedPurpose: "read-request", workspaceRoot: input.workspaceRoot});
    if (!validation.ok) return undefined;
    const alias = aliasFor(input.canonicalCursor, validation.decoded.payloadRef, input.lane);
    const resolved = resolveReadCallCursorAlias({workspaceRoot: input.workspaceRoot, lane: input.lane, cursor: alias});
    return resolved.kind === "canonical" && resolved.cursor === input.canonicalCursor ? alias : undefined;
  } catch { return undefined; }
}

/** Exact lookup only. Unknown, malformed, expired, or tampered aliases fail closed. */
export function resolveReadCallCursorAlias(input: {
  workspaceRoot: string; lane: string; cursor: string;
}): ReadCallCursorAliasResolution {
  if (!input.cursor.startsWith(PREFIX)) return {kind: "other"};
  const match = ALIAS_RE.exec(input.cursor);
  if (!match) return {kind: "refusal", detail: "read-call cursor alias is malformed or unknown"};
  try {
    const store = stateStoreFor(input.workspaceRoot);
    if (!store?.available) return {kind: "refusal", detail: "read-call cursor alias store is unavailable"};
    const record = store.get(recordKey(input.cursor));
    const data = object(record?.data);
    const now = Date.now();
    if (!record || record.purpose !== "read-request" || record.version !== 1 || !data
      || data["v"] !== 1 || data["family"] !== "read-call-cursor-alias"
      || data["alias"] !== input.cursor || data["payload_ref"] !== match[1]
      || data["lane"] !== input.lane || typeof data["canonical_cursor"] !== "string"
      || !Number.isSafeInteger(data["expires_at_ms"]) || Number(data["expires_at_ms"]) <= now
      || aliasFor(data["canonical_cursor"], match[1]!, input.lane) !== input.cursor) {
      return {kind: "refusal", detail: "read-call cursor alias is invalid, expired, or belongs to another lane"};
    }
    const canonical = resolveReadCallContinuation({workspaceRoot: input.workspaceRoot, lane: input.lane,
      cursor: data["canonical_cursor"]});
    if (canonical.kind !== "read-call") return {kind: "refusal", detail: "aliased read-call plan is no longer available"};
    const validation = validateHandleToken({token: data["canonical_cursor"], expectedPurpose: "read-request", workspaceRoot: input.workspaceRoot});
    const parent = validateHandleToken({token: canonical.state.task_handle, expectedPurpose: "task", workspaceRoot: input.workspaceRoot});
    const expiry = Number(data["expires_at_ms"]);
    if (!validation.ok || !parent.ok || validation.decoded.payloadRef !== match[1]
      || validation.decoded.stateStoreEpoch !== store.epoch
      || canonical.state.workspace_ref !== workspaceRefOf(input.workspaceRoot)
      || expiry > canonical.state.expires_at_ms || expiry > validation.decoded.expiresAtMs
      || expiry > parent.decoded.expiresAtMs) {
      return {kind: "refusal", detail: "aliased read-call plan does not match its authenticated binding"};
    }
    return {kind: "canonical", cursor: data["canonical_cursor"]};
  } catch { return {kind: "refusal", detail: "read-call cursor alias could not be validated"}; }
}
