// ---------------------------------------------------------------------------
// V11-07 encoding cache -- bounded LRU correctness, hit byte-identity
// against a fresh encode, and tokenizer-id key separation.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { EncodingCache, hashSemanticPayload } from "../protocol/codec/encodingCache.js";
import { tlTable1Codec } from "../protocol/codec/tlTable1.js";
import type { CodecPayload } from "../protocol/codec/types.js";

function tablePayload(rows: number): CodecPayload {
  return {
    v: 1,
    kind: "search.matches",
    matches: {
      form: "symbols",
      locations: Array.from({ length: rows }, (_, i) => ({ path: `f${i}.ts`, line: i, symbol: `s${i}` })),
      total: rows,
    },
  };
}

describe("hashSemanticPayload -- canonical, key-order independent", () => {
  it("the same content in a different key order hashes identically", () => {
    const a = { z: 1, a: 2, m: { y: 1, b: 2 } };
    const b = { a: 2, z: 1, m: { b: 2, y: 1 } };
    expect(hashSemanticPayload(a)).toBe(hashSemanticPayload(b));
  });

  it("different content hashes differently", () => {
    expect(hashSemanticPayload({ a: 1 })).not.toBe(hashSemanticPayload({ a: 2 }));
  });

  it("array order DOES matter (arrays are not sorted, only object keys are)", () => {
    expect(hashSemanticPayload({ a: [1, 2] })).not.toBe(hashSemanticPayload({ a: [2, 1] }));
  });
});

describe("EncodingCache -- basic get/set and stats", () => {
  it("a miss is reported before any set, and a set is retrievable afterward", () => {
    const cache = new EncodingCache(4);
    const key = { payloadHash: "h1", codecId: "tl-table-1", codecVersion: "1", tokenizerId: "bytes" };
    expect(cache.get(key)).toBeUndefined();
    cache.set(key, { text: "TL1T...", bytes: 100, units: 100 });
    expect(cache.get(key)).toEqual({ text: "TL1T...", bytes: 100, units: 100 });
    expect(cache.stats()).toEqual({ hits: 1, misses: 1, size: 1 });
  });

  it("rejects a non-positive or non-integer maxEntries", () => {
    expect(() => new EncodingCache(0)).toThrow();
    expect(() => new EncodingCache(-1)).toThrow();
    expect(() => new EncodingCache(1.5)).toThrow();
  });

  it("clear() resets entries and counters together", () => {
    const cache = new EncodingCache(4);
    const key = { payloadHash: "h1", codecId: "c", codecVersion: "1", tokenizerId: "bytes" };
    cache.set(key, { text: "x", bytes: 1, units: 1 });
    cache.get(key);
    cache.get({ ...key, payloadHash: "miss" });
    cache.clear();
    expect(cache.stats()).toEqual({ hits: 0, misses: 0, size: 0 });
    expect(cache.get(key)).toBeUndefined();
  });
});

describe("EncodingCache -- bounded LRU eviction", () => {
  it("evicts the least-recently-used entry once capacity is exceeded", () => {
    const cache = new EncodingCache(2);
    const k1 = { payloadHash: "h1", codecId: "c", codecVersion: "1", tokenizerId: "bytes" };
    const k2 = { payloadHash: "h2", codecId: "c", codecVersion: "1", tokenizerId: "bytes" };
    const k3 = { payloadHash: "h3", codecId: "c", codecVersion: "1", tokenizerId: "bytes" };
    cache.set(k1, { text: "1", bytes: 1, units: 1 });
    cache.set(k2, { text: "2", bytes: 1, units: 1 });
    cache.set(k3, { text: "3", bytes: 1, units: 1 }); // evicts k1 (oldest, capacity 2)
    expect(cache.get(k1)).toBeUndefined();
    expect(cache.get(k2)).toBeDefined();
    expect(cache.get(k3)).toBeDefined();
    expect(cache.stats().size).toBe(2);
  });

  it("a get() bumps recency, so the just-read entry survives the next eviction instead of the untouched one", () => {
    const cache = new EncodingCache(2);
    const k1 = { payloadHash: "h1", codecId: "c", codecVersion: "1", tokenizerId: "bytes" };
    const k2 = { payloadHash: "h2", codecId: "c", codecVersion: "1", tokenizerId: "bytes" };
    const k3 = { payloadHash: "h3", codecId: "c", codecVersion: "1", tokenizerId: "bytes" };
    cache.set(k1, { text: "1", bytes: 1, units: 1 });
    cache.set(k2, { text: "2", bytes: 1, units: 1 });
    cache.get(k1); // k1 is now more recent than k2
    cache.set(k3, { text: "3", bytes: 1, units: 1 }); // evicts k2, the now-oldest
    expect(cache.get(k2)).toBeUndefined();
    expect(cache.get(k1)).toBeDefined();
    expect(cache.get(k3)).toBeDefined();
  });
});

describe("EncodingCache -- tokenizer-id key separation", () => {
  it("the same payload+codec cached under two different tokenizer ids are two independent entries", () => {
    const cache = new EncodingCache(4);
    const base = { payloadHash: "h1", codecId: "tl-table-1", codecVersion: "1" };
    cache.set({ ...base, tokenizerId: "bytes" }, { text: "same-text", bytes: 50, units: 50 });
    expect(cache.get({ ...base, tokenizerId: "fake-tokenizer" })).toBeUndefined(); // different tokenizer -> miss
    cache.set({ ...base, tokenizerId: "fake-tokenizer" }, { text: "same-text", bytes: 50, units: 12 });
    expect(cache.get({ ...base, tokenizerId: "bytes" })!.units).toBe(50);
    expect(cache.get({ ...base, tokenizerId: "fake-tokenizer" })!.units).toBe(12);
    expect(cache.stats().size).toBe(2);
  });
});

describe("EncodingCache -- a hit is byte-identical to a fresh encode", () => {
  it("the text stored via set() and returned via get() is EXACTLY what the codec produces from scratch", () => {
    const payload = tablePayload(6);
    const fresh = tlTable1Codec.encode(payload);
    const cache = new EncodingCache(4);
    const key = {
      payloadHash: hashSemanticPayload(payload),
      codecId: tlTable1Codec.id,
      codecVersion: tlTable1Codec.version,
      tokenizerId: "bytes",
    };
    cache.set(key, { text: fresh, bytes: fresh.length, units: fresh.length });
    const cached = cache.get(key);
    expect(cached).toBeDefined();
    // The proof: re-encode the SAME payload independently (a second, fresh
    // call into the codec, not a re-read of anything cached) and assert the
    // cached text matches it byte-for-byte.
    const reEncoded = tlTable1Codec.encode(payload);
    expect(cached!.text).toBe(reEncoded);
    expect(cached!.text).toBe(fresh);
  });
});
