// ---------------------------------------------------------------------------
// V11-07 fuzz -- JSON fallback 100% under fuzz, INCLUDING the new v2 path
// (TOKENLIGHTEN_RESPONSE_FORMAT=auto + TL_WIRE_BREAKEVEN, a resolvable
// client profile, and a counter whose ordering deliberately diverges from
// byte length). Extends __tests__/helpers/wireCodecFuzz.ts's seeded
// generators -- the same ones each single-codec spec
// (wireCodecTlTable1/TlRaw1/Toon.spec.ts) already uses for round-trip
// proofs -- to drive full payloads through `applyResponseCodec` itself,
// proving the SELECTION layer (not just one codec's encode/decode) never
// emits anything that fails to round-trip or exceeds json's own byte size.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Kind } from "@tokenlighten/types";
import { mulberry32, randomScalar, randomString, int, pick, type Rng } from "./helpers/wireCodecFuzz.js";
import { applyResponseCodec, resetV2CacheForTest } from "../protocol/codec/pipeline.js";
import { EncodingCache } from "../protocol/codec/encodingCache.js";
import { byteCounter, type TokenCounter } from "../protocol/codec/tokenCounter.js";
import { NON_JSON_CANDIDATES } from "../protocol/codec/registry.js";
import { canonicalEqual, type CodecPayload } from "../protocol/codec/types.js";
import type { ProtocolCallContext } from "../protocol/envelope.js";

const WS_ROOT = "/workspace/wire-codec-v2-fuzz-test";
const FRESH_NOW = Date.parse("2026-08-21") + 1000;
const KINDS: readonly Kind[] = ["search.matches", "search.references", "read.map", "read.batch", "read.artifact", "read.text"];

function decodeWireText(text: string): CodecPayload {
  try {
    return JSON.parse(text) as CodecPayload;
  } catch {
    // not json -- fall through to the non-json candidates
  }
  for (const codec of NON_JSON_CANDIDATES) {
    try {
      return codec.decode(text);
    } catch {
      continue;
    }
  }
  throw new Error(`decodeWireText: no registered codec could decode this text (first 40 chars: ${JSON.stringify(text.slice(0, 40))})`);
}

function randomFlatObject(rng: Rng, fieldCount: number): CodecPayload {
  const obj: CodecPayload = {};
  for (let i = 0; i < fieldCount; i++) obj[`f${i}`] = randomScalar(rng);
  return obj;
}

function randomUniformArrayPayload(rng: Rng, kind: Kind): CodecPayload {
  const rows = int(rng, 0, 40);
  const fieldCount = int(rng, 1, 5);
  const items = Array.from({ length: rows }, () => randomFlatObject(rng, fieldCount));
  return { v: 1, kind, items };
}

function randomStringHeavyPayload(rng: Rng, kind: Kind): CodecPayload {
  return {
    v: 1,
    kind,
    text: randomString(rng, { minLen: 0, maxLen: 600, spiceRate: 0.4 }),
    path: randomString(rng, { minLen: 0, maxLen: 20, spiceRate: 0.1 }),
  };
}

function randomPositionalRowsPayload(rng: Rng, kind: Kind): CodecPayload {
  const rowCount = int(rng, 0, 30);
  const columns = Array.from({ length: int(rng, 1, 4) }, (_, i) => `c${i}`);
  const rows = Array.from({ length: rowCount }, () => columns.map(() => randomScalar(rng)));
  return { v: 1, kind, table: { columns, rows } };
}

function randomPayload(rng: Rng, kind: Kind): CodecPayload {
  const shape = int(rng, 0, 2);
  if (shape === 0) return randomUniformArrayPayload(rng, kind);
  if (shape === 1) return randomStringHeavyPayload(rng, kind);
  return randomPositionalRowsPayload(rng, kind);
}

/** Deterministic per-instance, NOT byte-proportional -- weights characters by class rather than counting bytes, so its ordering can diverge from `byteCounter`'s. Stress-tests the tokenizer-aware comparison path with something other than the default counter, without depending on any real tokenizer. */
function adversarialCounter(rng: Rng): TokenCounter {
  const bias = 0.5 + rng();
  return {
    id: `adversarial-${Math.round(bias * 1000)}`,
    count(text: string): number {
      let score = 0;
      for (let i = 0; i < text.length; i++) {
        score += text.charCodeAt(i) % 2 === 0 ? 1.7 : 0.3;
      }
      return score * bias;
    },
  };
}

describe("v2 fuzz -- JSON fallback 100%, byte-safety, and round-trip under randomized payloads", () => {
  let tmpHome: string;
  let origHome: string | undefined;
  const ENV_KEYS = ["TOKENLIGHTEN_RESPONSE_FORMAT", "TL_WIRE_BREAKEVEN", "TL_WIRE_SHADOW"] as const;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    origHome = process.env.HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "tl-wire-codec-v2-fuzz-"));
    process.env.HOME = tmpHome;
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env["TOKENLIGHTEN_RESPONSE_FORMAT"] = "auto";
    process.env["TL_WIRE_BREAKEVEN"] = "1";
    resetV2CacheForTest();
  });

  afterEach(() => {
    if (origHome !== undefined) process.env.HOME = origHome;
    else delete process.env.HOME;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(tmpHome, { recursive: true, force: true });
    resetV2CacheForTest();
  });

  it("never throws, never exceeds json's byte size, and always round-trips when a non-json codec is chosen", () => {
    const rng = mulberry32(0xc0ffee);
    const cache = new EncodingCache(64);
    let nonJsonCount = 0;
    const ITERATIONS = 300;

    for (let i = 0; i < ITERATIONS; i++) {
      const kind = pick(rng, KINDS);
      const payload = randomPayload(rng, kind);
      const jsonText = JSON.stringify(payload);
      const jsonBytes = Buffer.byteLength(jsonText, "utf8");
      const hasClientId = rng() < 0.5;
      const counter = rng() < 0.5 ? byteCounter : adversarialCounter(rng);
      const context: ProtocolCallContext = hasClientId
        ? { tool: "read_file", workspace: WS_ROOT, clientId: "tl-reference-client" }
        : { tool: "read_file", workspace: WS_ROOT };

      let result = "";
      expect(() => {
        result = applyResponseCodec(jsonText, payload, kind, context, 999999, { counter, cache, now: FRESH_NOW });
      }).not.toThrow();

      const resultBytes = Buffer.byteLength(result, "utf8");
      expect(resultBytes).toBeLessThanOrEqual(jsonBytes);

      if (result !== jsonText) {
        nonJsonCount += 1;
        const decoded = decodeWireText(result);
        expect(canonicalEqual(decoded, payload)).toBe(true);
      }
    }

    // Sanity on the fuzz harness itself: over 300 randomized iterations
    // across 6 kinds and 2 counters, the non-json path must actually have
    // fired at least once, or this test would trivially "pass" without
    // ever exercising the oracle it claims to prove.
    expect(nonJsonCount).toBeGreaterThan(0);
  });

  it("a tight host budget never selects a candidate over the limit, across the same randomized payloads", () => {
    const rng = mulberry32(0x5eed);
    const cache = new EncodingCache(64);
    for (let i = 0; i < 150; i++) {
      const kind = pick(rng, KINDS);
      const payload = randomPayload(rng, kind);
      const jsonText = JSON.stringify(payload);
      const limit = int(rng, 0, 200); // frequently far too tight to fit any non-json candidate
      const context: ProtocolCallContext = { tool: "read_file", workspace: WS_ROOT, clientId: "tl-reference-client" };

      let result = "";
      expect(() => {
        result = applyResponseCodec(jsonText, payload, kind, context, limit, { cache, now: FRESH_NOW });
      }).not.toThrow();

      if (result !== jsonText) {
        expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(limit);
      }
    }
  });
});
