// ---------------------------------------------------------------------------
// protocol v1 -- V11-07 (Adaptive Wire Encoding v2): the encoding
// measurement cache.
//
// A bounded LRU, size-capped, NO TIMERS -- this module is imported from a
// per-call hot path (pipeline.ts), and a timer-based eviction would need
// lifecycle management this codec layer has no seam for (no shutdown hook,
// no per-request cleanup phase).
//
// KEY SHAPE: (semantic payload hash x codec id+version x tokenizer id). The
// ENCODED TEXT for a given payload is fully determined by (payload, codec
// id+version) alone -- no codec in this directory ever consults a tokenizer
// while encoding -- but the MEASURED UNIT COUNT of that text is tokenizer-
// specific, so the tokenizer id is still part of the key even though it
// never changes which text is associated with an entry, only which
// measurement is.
//
// CORRECTNESS: "a hit must be byte-identical to a fresh encode; any doubt
// => miss" (V11-07 spec). This module satisfies that by CONSTRUCTION, not
// by re-verifying on every hit (re-encoding on every lookup would defeat
// the point of caching): the cached `text` is the exact string the caller
// handed to `set()` the moment it was produced, keyed by a hash of the
// CANONICAL (key-order-independent) payload content plus the exact codec
// id+version, so a different payload or a different codec version can
// never collide onto the same entry. `selectV2.ts` additionally compares
// the cached `text` against THIS call's freshly-produced candidate text
// before ever trusting a hit -- belt-and-suspenders against a
// theoretical hash collision, never assumed away. The "doubt => miss" half
// is `hashSemanticPayload`'s job: it throws on anything it cannot
// canonicalize, and every caller in this directory treats that throw as an
// unconditional cache bypass, never a guess.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import type { CodecPayload } from "./types.js";

export interface EncodingCacheKey {
  readonly payloadHash: string;
  readonly codecId: string;
  readonly codecVersion: string;
  readonly tokenizerId: string;
}

export interface CachedMeasurement {
  readonly text: string;
  readonly bytes: number;
  readonly units: number;
}

export interface EncodingCacheStats {
  readonly hits: number;
  readonly misses: number;
  readonly size: number;
}

/**
 * Canonicalizes `payload` (recursively sorted object keys -- the same
 * notion of "semantic" as types.ts's `canonicalEqual`, which also ignores
 * key order) and hashes it. Throws on anything JSON.stringify itself would
 * reject (a circular structure, for instance -- structurally impossible for
 * a JSON-safe CodecPayload that has already round-tripped through
 * policy.ts's oracle, but defended anyway); every caller treats that throw
 * as an unconditional cache bypass.
 */
export function hashSemanticPayload(payload: CodecPayload): string {
  return createHash("sha256").update(canonicalize(payload), "utf8").digest("hex");
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const body = keys.map((k) => `${JSON.stringify(k)}:${canonicalize(record[k])}`).join(",");
  return `{${body}}`;
}

function keyString(key: EncodingCacheKey): string {
  return `${key.payloadHash} ${key.codecId} ${key.codecVersion} ${key.tokenizerId}`;
}

/** Bounded LRU (an insertion-order Map, re-inserted on every hit/set to bump recency; the oldest key is evicted once size exceeds capacity). No timers -- see the module header. */
export class EncodingCache {
  private readonly store = new Map<string, CachedMeasurement>();
  private hits = 0;
  private misses = 0;

  constructor(private readonly maxEntries: number) {
    if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
      throw new Error(`EncodingCache: maxEntries must be a positive integer, got ${String(maxEntries)}`);
    }
  }

  get(key: EncodingCacheKey): CachedMeasurement | undefined {
    const k = keyString(key);
    const hit = this.store.get(k);
    if (hit === undefined) {
      this.misses += 1;
      return undefined;
    }
    this.hits += 1;
    // Bump recency: delete + re-insert moves this key to the end of the
    // Map's iteration order, which `evictIfNeeded` treats as "most recent".
    this.store.delete(k);
    this.store.set(k, hit);
    return hit;
  }

  set(key: EncodingCacheKey, value: CachedMeasurement): void {
    const k = keyString(key);
    this.store.delete(k); // re-setting an existing key must also bump recency
    this.store.set(k, value);
    this.evictIfNeeded();
  }

  private evictIfNeeded(): void {
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next();
      if (oldest.done === true) break; // unreachable (size > maxEntries >= 1 implies non-empty); kept for totality
      this.store.delete(oldest.value);
    }
  }

  stats(): EncodingCacheStats {
    return { hits: this.hits, misses: this.misses, size: this.store.size };
  }

  /** Test/diagnostic only -- clears every entry AND resets the hit/miss counters. */
  clear(): void {
    this.store.clear();
    this.hits = 0;
    this.misses = 0;
  }
}
