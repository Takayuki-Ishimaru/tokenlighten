// ---------------------------------------------------------------------------
// protocol v1 -- B5: one spelling per semantic payload.
//
// A reply's object keys arrive in whatever order its code path assembled them,
// so the same fields can be spelled two ways. Under TL_WIRE_STABLE every object is
// spelled `v`, `kind`, then its other keys sorted. Only key order moves: arrays
// keep their order, and no value is touched, so the byte size is unchanged and
// no budget decision can differ.
//
// WHAT THIS DOES NOT DO. Handles and cursors carry a nonce and an issue time and
// are not fixed here: they are capabilities, and a repeated reply really is a new
// one. This also does not control a provider's prompt cache. That cache keys on the
// host's whole request prefix, which an MCP server cannot see or steer; this only
// removes one way TL could have differed from itself. TL's own encoding cache and
// served-range ledger are separate things again.
//
// `wire_stability` records whether a reply's bytes repeated one this process already
// sent, for measuring that claim. The digest stays in memory and is never traced.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";

const LEADING_KEYS = ["v", "kind"] as const;
const REPEAT_WINDOW = 64;

/** `value` with every object's keys in canonical order. Arrays keep theirs. */
export function canonicalKeyOrder<T>(value: T): T {
  if (Array.isArray(value)) return value.map(canonicalKeyOrder) as T;
  if (value === null || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  // No prototype, so an own "__proto__" from JSON.parse stays an ordinary key.
  const out = Object.create(null) as Record<string, unknown>;
  for (const key of LEADING_KEYS) if (key in source) out[key] = canonicalKeyOrder(source[key]);
  for (const key of Object.keys(source).sort()) {
    if (!(LEADING_KEYS as readonly string[]).includes(key)) out[key] = canonicalKeyOrder(source[key]);
  }
  return out as T;
}

/** Bounded, insertion-ordered memory of recent reply digests. */
const recent = new Map<string, true>();

/** Whether these exact bytes were sent earlier in this process, within a bounded window. */
export function noteReplyRepeat(text: string): boolean {
  const digest = createHash("sha256").update(text, "utf8").digest("base64url");
  const repeated = recent.delete(digest);
  recent.set(digest, true);
  if (recent.size > REPEAT_WINDOW) recent.delete(recent.keys().next().value as string);
  return repeated;
}

/** Test-only. */
export function resetReplyRepeatsForTest(): void {
  recent.clear();
}
