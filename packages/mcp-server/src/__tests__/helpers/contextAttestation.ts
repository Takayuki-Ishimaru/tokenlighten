// ---------------------------------------------------------------------------
// REFERENCE CLIENT for the PI-03 attestation tier (tests only).
//
// The tier is a CONTRACT BETWEEN TWO SIDES: a TL-aware client host mints an
// attestation, this server verifies it. A contract only one side can implement
// is not a contract, so the client half lives here — and building it from the
// SAME exported primitives a real adapter would use (`signContextAttestation`,
// `workspaceRefOf`, `currentContextGeneration`) is what makes the tests proof
// of an implementable protocol rather than proof that the server agrees with
// itself.
//
// Everything here is deliberately small enough to re-implement in another
// language from the module doc of `state/contextAttestation.ts`.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";

import { CONTEXT_STATE_META_KEY, type ContextAttestationV1 } from "@tokenlighten/types";

import { workspaceRefOf } from "../../state/handleCodec.js";
import { currentContextGeneration, signContextAttestation } from "../../state/contextAttestation.js";
import { stateStoreFor } from "../../state/stateStore.js";

export interface ReferenceAttestationOptions {
  /** Handles the client claims it still holds. These are the receipt ids. */
  retainedReceiptIds: readonly string[];
  /** Defaults to a stable test client identity. */
  clientId?: string;
  /** Defaults to the server's CURRENT generation (i.e. a fresh attestation). */
  serverContextGeneration?: number;
  /** Defaults to the workspace's real store epoch. */
  stateStoreEpoch?: string;
  /** Defaults to the real workspace ref. Override to forge a foreign one. */
  workspaceRef?: string;
  /** Defaults to now. */
  issuedAtMs?: number;
  /** Defaults to now + 5 minutes. */
  expiresAtMs?: number;
  /** Defaults to a digest over the retained ids. */
  clientContextDigest?: string;
  clientContextGeneration?: string;
}

/**
 * Mint a VALID attestation for `workspaceRoot`, exactly as a client host would.
 *
 * Every field is overridable so a negative test can change ONE thing and prove
 * the change alone is what the server rejects — the difference between "the
 * server refused something" and "the server refused THIS".
 */
export function referenceAttestation(
  workspaceRoot: string,
  options: ReferenceAttestationOptions,
): ContextAttestationV1 {
  const store = stateStoreFor(workspaceRoot);
  const now = options.issuedAtMs ?? Date.now();
  const body: Omit<ContextAttestationV1, "signature"> = {
    attestationVersion: 1,
    source: "trusted-client-host",
    clientId: options.clientId ?? "tl-reference-client",
    clientContextGeneration: options.clientContextGeneration ?? "ctx-gen-1",
    clientContextDigest:
      options.clientContextDigest
      ?? createHash("sha256").update(options.retainedReceiptIds.join("\u0000"), "utf8").digest("hex").slice(0, 32),
    workspaceRef: options.workspaceRef ?? workspaceRefOf(workspaceRoot),
    stateStoreEpoch: options.stateStoreEpoch ?? store?.epoch ?? "00000000",
    serverContextGeneration: options.serverContextGeneration ?? currentContextGeneration(workspaceRoot) ?? 1,
    retainedReceiptIds: [...options.retainedReceiptIds],
    issuedAtMs: now,
    expiresAtMs: options.expiresAtMs ?? now + 5 * 60 * 1000,
  };
  return { ...body, signature: signContextAttestation(body) };
}

/** Wrap an attestation in the `tools/call` request `_meta` channel. */
export function attestationMeta(attestation: unknown): Record<string, unknown> {
  return { [CONTEXT_STATE_META_KEY]: { context_attestation: attestation } };
}

/** The `context_handle` a response's `_meta` carries, if any. */
export function issuedContextHandle(result: { _meta?: Record<string, unknown> }): string | undefined {
  const channel = result._meta?.[CONTEXT_STATE_META_KEY];
  if (typeof channel !== "object" || channel === null) return undefined;
  const handle = (channel as Record<string, unknown>)["context_handle"];
  return typeof handle === "string" ? handle : undefined;
}
