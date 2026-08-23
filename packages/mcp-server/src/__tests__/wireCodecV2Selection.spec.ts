// ---------------------------------------------------------------------------
// V11-07 v2 selection -- isEligibleKindV2/restrictCandidatesForWidenedKind,
// selectForWireV2's two-stage gain-ordered algorithm (proven against
// FABRICATED candidates so the algorithm is exercised independent of any
// one codec's real compression ratio -- the same reasoning
// wireCodecPolicy.spec.ts's own `fakeCandidate` helper uses for v1), the
// breakeven table's practical effect, and full pipeline.ts integration
// (flag-off byte identity, trace shapes, client-profile wiring).
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Kind } from "@tokenlighten/types";
import {
  isEligibleKindV2,
  restrictCandidatesForWidenedKind,
  selectForWireV2,
} from "../protocol/codec/selectV2.js";
import type { CodecCandidate } from "../protocol/codec/policy.js";
import { evaluateCandidates, selectForWire } from "../protocol/codec/policy.js";
import { UNKNOWN_CLIENT_PROFILE, resolveClientProfile, type ClientProfile } from "../protocol/codec/clientProfile.js";
import { byteCounter, type TokenCounter } from "../protocol/codec/tokenCounter.js";
import { EncodingCache } from "../protocol/codec/encodingCache.js";
import { tlRaw1Codec } from "../protocol/codec/tlRaw1.js";
import type { CodecPayload } from "../protocol/codec/types.js";
import { applyResponseCodec, resetV2CacheForTest } from "../protocol/codec/pipeline.js";
import type { ProtocolCallContext } from "../protocol/envelope.js";
import { getTracePath, setTraceEnabledForTest } from "../util/trace.js";

const REFERENCE_VALIDATED_MS = Date.parse("2026-08-21");
const FRESH_NOW = REFERENCE_VALIDATED_MS + 1000;

function referenceProfile(): ClientProfile {
  return resolveClientProfile("tl-reference-client", FRESH_NOW);
}

function rowsPayload(n: number): CodecPayload {
  return { v: 1, kind: "search.matches", items: Array.from({ length: n }, (_, i) => ({ a: i, b: `x${i}` })) };
}

/** A synthetic candidate with fully independent control over `bytes` and `text` -- never runs a real encode/decode, so it is only ever used with `selectForWireV2` directly (which never calls `.encode`/`.decode`), not through `evaluateCandidates`'s oracle. */
function fakeCandidate(codecId: string, text: string, bytes: number): CodecCandidate {
  return {
    codec: { id: codecId, version: "1", canEncode: () => true, encode: () => text, decode: () => ({}) },
    text,
    bytes,
  };
}

/** A counter with a FIXED unit count per exact text -- throws on any text it was not told about, so a test can never silently fall through to an unintended default. */
function fixedCounter(id: string, unitsByText: Record<string, number>): TokenCounter {
  return {
    id,
    count(text: string): number {
      const u = unitsByText[text];
      if (u === undefined) throw new Error(`fixedCounter(${id}): no fixture for text ${JSON.stringify(text)}`);
      return u;
    },
  };
}

// ---------------------------------------------------------------------------
// isEligibleKindV2 / restrictCandidatesForWidenedKind
// ---------------------------------------------------------------------------

describe("isEligibleKindV2", () => {
  it("false for every kind other than read.text, regardless of client profile", () => {
    const allowingProfile = referenceProfile();
    for (const kind of ["search.matches", "read.map", "read.batch", "read.artifact", "read.task_pack", "edit.applied"] as Kind[]) {
      expect(isEligibleKindV2(kind, allowingProfile)).toBe(false);
    }
  });

  it("false for read.text under the unknown profile", () => {
    expect(isEligibleKindV2("read.text", UNKNOWN_CLIENT_PROFILE)).toBe(false);
  });

  it("true for read.text under a profile that explicitly allows tl-raw-1/1", () => {
    expect(isEligibleKindV2("read.text", referenceProfile())).toBe(true);
  });

  it("false for read.text under a known profile that does NOT list tl-raw-1", () => {
    const profile: ClientProfile = { id: "other", profileVersion: "1", lastValidated: "2026-08-21", allowedCodecIds: ["tl-table-1/1"] };
    expect(isEligibleKindV2("read.text", profile)).toBe(false);
  });
});

describe("restrictCandidatesForWidenedKind", () => {
  it("passes every candidate through unchanged for a non-widened kind", () => {
    const candidates = [fakeCandidate("tl-table-1", "a", 1), fakeCandidate("toon-4.1", "b", 2)];
    expect(restrictCandidatesForWidenedKind("search.matches", candidates, referenceProfile())).toEqual(candidates);
  });

  it("for read.text, keeps ONLY tl-raw-1/1 candidates the profile allows, dropping everything else", () => {
    const raw = fakeCandidate("tl-raw-1", "raw-text", 10);
    const table = fakeCandidate("tl-table-1", "table-text", 10); // not tl-raw-1 -- must be dropped even though it "fits" bytes-wise
    const restricted = restrictCandidatesForWidenedKind("read.text", [table, raw], referenceProfile());
    expect(restricted).toEqual([raw]);
  });

  it("for read.text, drops even a real tl-raw-1 candidate when the profile does not allow it", () => {
    const raw = fakeCandidate("tl-raw-1", "raw-text", 10);
    expect(restrictCandidatesForWidenedKind("read.text", [raw], UNKNOWN_CLIENT_PROFILE)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// selectForWireV2 -- core algorithm, fabricated candidates
// ---------------------------------------------------------------------------

describe("selectForWireV2 -- baseline gates", () => {
  const payload = rowsPayload(10);
  const jsonText = JSON.stringify(payload);
  const jsonBytes = Buffer.byteLength(jsonText, "utf8");

  it("no candidates => json, fallbackReason no-candidates", () => {
    const result = selectForWireV2({
      kind: "search.matches", payload, jsonText, jsonBytes, candidates: [], limit: 999999,
      clientProfile: UNKNOWN_CLIENT_PROFILE, counter: byteCounter, cache: new EncodingCache(4),
    });
    expect(result).toMatchObject({ codecId: "json", fallbackReason: "no-candidates", text: jsonText });
  });

  it("a candidate NOT smaller in raw bytes than json is never even measured (byte-floor), regardless of counter", () => {
    const notSmaller = fakeCandidate("fake", "same-size-text", jsonBytes); // equal bytes -- fails the STRICT floor
    const alwaysGreatCounter = fixedCounter("always-great", { [jsonText]: 1000, "same-size-text": 1 });
    const result = selectForWireV2({
      kind: "search.matches", payload, jsonText, jsonBytes, candidates: [notSmaller], limit: 999999,
      clientProfile: UNKNOWN_CLIENT_PROFILE, counter: alwaysGreatCounter, cache: new EncodingCache(4),
    });
    expect(result.codecId).toBe("json");
    expect(result.fallbackReason).toBe("byte-floor");
  });

  it("negative gain under the counter floors to json even though the candidate is byte-smaller", () => {
    const smaller = fakeCandidate("fake", "smaller-text", jsonBytes - 100);
    // Bytes say this is a big win, but the counter says it is a LOSS.
    const counter = fixedCounter("adversarial", { [jsonText]: 100, "smaller-text": 500 });
    const result = selectForWireV2({
      kind: "search.matches", payload, jsonText, jsonBytes, candidates: [smaller], limit: 999999,
      clientProfile: UNKNOWN_CLIENT_PROFILE, counter, cache: new EncodingCache(4),
    });
    expect(result.codecId).toBe("json");
    expect(result.fallbackReason).toBe("negative-gain");
  });

  it("a candidate that clears every gate is selected, with fallbackReason none", () => {
    const good = fakeCandidate("tl-table-1", "good-text", 100);
    const counter = fixedCounter("simple", { [jsonText]: 1000, "good-text": 100 }); // 90% relative gain
    const result = selectForWireV2({
      kind: "search.matches", payload, jsonText, jsonBytes, candidates: [good], limit: 999999,
      clientProfile: UNKNOWN_CLIENT_PROFILE, counter, cache: new EncodingCache(4),
    });
    expect(result).toMatchObject({ codecId: "tl-table-1/1", fallbackReason: "none", text: "good-text" });
  });
});

describe("selectForWireV2 -- two-stage: gain-ordered, not byte-ordered", () => {
  const payload = rowsPayload(10);
  const jsonText = JSON.stringify(payload);
  const jsonBytes = Buffer.byteLength(jsonText, "utf8");

  it("tries the NEXT-best-gain candidate when the best-gain one overshoots the host budget", () => {
    // Byte-LARGER candidate has the BEST gain; byte-SMALLER candidate has a
    // mediocre but still-passing gain. If this walked byte-ascending order
    // (like evaluateCandidates' own sort, or v1's candidates[0]-only logic)
    // it would try the small one first and never even see the overshoot.
    // Gain-ordering tries the big one first, hits the overshoot, and THEN
    // falls through to the small one -- proving the two-stage mechanism.
    const big = fakeCandidate("tl-table-1", "big-best-gain", 900); // best gain, but overshoots limit=500
    const small = fakeCandidate("toon-4.1", "small-ok-gain", 200); // mediocre gain, fits limit=500
    const counter = fixedCounter("t2", { [jsonText]: 1000, "big-best-gain": 50, "small-ok-gain": 700 });
    const result = selectForWireV2({
      kind: "search.matches", payload, jsonText, jsonBytes, candidates: [big, small], limit: 500,
      clientProfile: UNKNOWN_CLIENT_PROFILE, counter, cache: new EncodingCache(4),
    });
    expect(result).toMatchObject({ codecId: "toon-4.1/1", fallbackReason: "none", text: "small-ok-gain" });
  });

  it("v1 rejects a candidate on its BYTE gain alone; v2 accepts the SAME candidate once its TOKEN gain is considered", () => {
    // v1 (policy.ts's selectForWire) has no concept of a TokenCounter at
    // all -- it is byte-based, unconditionally. A candidate with only a
    // tiny BYTE reduction (3%, well under the 10% global floor) is
    // rejected by v1 outright, however good its TOKEN gain might be. v2
    // measures the SAME candidate through the active counter and, when
    // that counter says the gain is actually large, accepts it -- proving
    // selection genuinely happens in counter units, not silently in bytes.
    const candidateBytes = Math.floor(jsonBytes * 0.97); // ~3% byte reduction
    const candidate = fakeCandidate("tl-table-1", "poor-byte-gain-great-token-gain", candidateBytes);

    const v1Result = selectForWire("auto", payload, jsonText, jsonBytes, [candidate], 999999);
    expect(v1Result.codecId).toBe("json"); // v1: ~3% byte gain fails the 10% relative-gain floor

    const counter = fixedCounter("token-view", { [jsonText]: 1000, "poor-byte-gain-great-token-gain": 100 });
    const v2Result = selectForWireV2({
      kind: "search.matches", payload, jsonText, jsonBytes, candidates: [candidate], limit: 999999,
      clientProfile: UNKNOWN_CLIENT_PROFILE, counter, cache: new EncodingCache(4),
    });
    expect(v2Result).toMatchObject({
      codecId: "tl-table-1/1",
      fallbackReason: "none",
      text: "poor-byte-gain-great-token-gain",
    });
  });

});

describe("selectForWireV2 -- caching", () => {
  it("the second call for the same payload/codec/tokenizer is a cache hit and never re-measures the candidate text", () => {
    const payload = rowsPayload(10);
    const jsonText = JSON.stringify(payload);
    const jsonBytes = Buffer.byteLength(jsonText, "utf8");
    const candidate = fakeCandidate("tl-table-1", "cache-me-text", 50);
    let candidateMeasureCalls = 0;
    const counter: TokenCounter = {
      id: "counting",
      count(text: string): number {
        if (text === "cache-me-text") candidateMeasureCalls += 1;
        return text === jsonText ? 1000 : 100;
      },
    };
    const cache = new EncodingCache(8);
    const params = {
      kind: "search.matches" as Kind, payload, jsonText, jsonBytes, candidates: [candidate], limit: 999999,
      clientProfile: UNKNOWN_CLIENT_PROFILE, counter, cache,
    };
    const first = selectForWireV2(params);
    expect(first.cacheHit).toBe(false);
    expect(candidateMeasureCalls).toBe(1);

    const second = selectForWireV2(params);
    expect(second.cacheHit).toBe(true);
    expect(candidateMeasureCalls).toBe(1); // unchanged -- the candidate text was never re-measured
    expect(second.text).toBe(first.text);
    expect(cache.stats().hits).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// breakeven cell -- practical effect on selection
// ---------------------------------------------------------------------------

describe("selectForWireV2 -- the breakeven table changes the outcome for the cell it names", () => {
  it("a read.text/string-heavy gain that clears the relaxed 5% tl-reference-client cell but not the 10% global default", () => {
    // Quote/backslash-heavy (like tl-raw-1's own header describes) so its
    // REAL encoded form is genuinely byte-smaller than json -- a plain
    // repeated character needs no JSON escaping at all, so tl-raw-1's own
    // framing overhead (magic/meta/delimiters) would make it byte-LARGER,
    // never clearing the byte hard floor in the first place. Also
    // comfortably >= shape.ts's STRING_HEAVY_MIN_LENGTH (200) -> "string-heavy".
    const longBody = Array.from(
      { length: 30 },
      (_, i) => `const x${i} = "value\\path\\${i}"; // "quoted" comment with \\backslashes\\`,
    ).join("\n");
    const payload: CodecPayload = { v: 1, kind: "read.text", text: longBody, path: "some/file.ts" };
    const jsonText = JSON.stringify(payload);
    const jsonBytes = Buffer.byteLength(jsonText, "utf8");
    const encoded = tlRaw1Codec.encode(payload); // a REAL, round-trip-correct candidate
    const candidate: CodecCandidate = { codec: tlRaw1Codec, text: encoded, bytes: Buffer.byteLength(encoded, "utf8") };
    // Forced gain: exactly 7% -- between the relaxed cell's 5% floor and
    // the 10% global default, so which one applies is the ONLY variable.
    // id MUST be "bytes" -- the documented cell is keyed to that tokenizer
    // id specifically (tokenizer id is part of the breakeven key: a
    // differently-named counter would simply miss the cell and fall back
    // to global defaults for BOTH profiles, which is a different, already
    // separately-proven behaviour -- see wireCodecBreakeven.spec.ts).
    const counter = fixedCounter("bytes", { [jsonText]: 1000, [encoded]: 930 });

    const unknownResult = selectForWireV2({
      kind: "read.text", payload, jsonText, jsonBytes, candidates: [candidate], limit: 999999,
      clientProfile: UNKNOWN_CLIENT_PROFILE, counter, cache: new EncodingCache(4),
    });
    expect(unknownResult.codecId).toBe("json");
    expect(unknownResult.fallbackReason).toBe("breakeven-not-cleared");

    const knownResult = selectForWireV2({
      kind: "read.text", payload, jsonText, jsonBytes, candidates: [candidate], limit: 999999,
      clientProfile: referenceProfile(), counter, cache: new EncodingCache(4),
    });
    expect(knownResult.codecId).toBe(`${tlRaw1Codec.id}/${tlRaw1Codec.version}`);
    expect(knownResult.fallbackReason).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// applyResponseCodec -- full pipeline integration
// ---------------------------------------------------------------------------

describe("applyResponseCodec -- v2 integration", () => {
  const WS_ROOT = "/workspace/wire-codec-v2-integration-test";
  let tmpHome: string;
  let origHome: string | undefined;
  const ENV_KEYS = ["TOKENLIGHTEN_RESPONSE_FORMAT", "TL_WIRE_SHADOW", "TL_WIRE_BREAKEVEN"] as const;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    origHome = process.env.HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "tl-wire-codec-v2-integration-"));
    process.env.HOME = tmpHome;
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    setTraceEnabledForTest(true);
    resetV2CacheForTest();
  });

  afterEach(() => {
    if (origHome !== undefined) process.env.HOME = origHome;
    else delete process.env.HOME;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    setTraceEnabledForTest(false);
    fs.rmSync(tmpHome, { recursive: true, force: true });
    resetV2CacheForTest();
  });

  function readTraceRecords(): Array<Record<string, unknown>> {
    const p = getTracePath(WS_ROOT);
    if (!fs.existsSync(p)) return [];
    return fs
      .readFileSync(p, "utf8")
      .trim()
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  it("flag-off (TL_WIRE_BREAKEVEN unset): mode=auto output is byte-identical to v1 selectForWire alone", () => {
    process.env["TOKENLIGHTEN_RESPONSE_FORMAT"] = "auto";
    const payload = rowsPayload(12);
    const jsonText = JSON.stringify(payload);
    const jsonBytes = Buffer.byteLength(jsonText, "utf8");
    const context: ProtocolCallContext = { tool: "search_files", workspace: WS_ROOT, clientId: "tl-reference-client" };

    const result = applyResponseCodec(jsonText, payload, "search.matches", context, 999999);

    const v1Candidates = evaluateCandidates("search.matches", payload);
    const v1Expected = selectForWire("auto", payload, jsonText, jsonBytes, v1Candidates, 999999);
    expect(result).toBe(v1Expected.text);
  });

  it("TL_WIRE_BREAKEVEN=1 but mode stays json (unset): byte-identical to the plain default path", () => {
    process.env["TL_WIRE_BREAKEVEN"] = "1";
    const payload = rowsPayload(12);
    const jsonText = JSON.stringify(payload);
    const context: ProtocolCallContext = { tool: "search_files", workspace: WS_ROOT };
    const result = applyResponseCodec(jsonText, payload, "search.matches", context, 999999);
    expect(result).toBe(jsonText);
  });

  it("both flags active: read.text widens for a resolvable, allowed client and stays fully json for an unresolved one", () => {
    process.env["TOKENLIGHTEN_RESPONSE_FORMAT"] = "auto";
    process.env["TL_WIRE_BREAKEVEN"] = "1";
    // Deliberately full of quotes/backslashes -- exactly what tl-raw-1's own
    // header says JSON string-escaping nearly doubles the size of.
    const longBody = Array.from(
      { length: 40 },
      (_, i) => `const x${i} = "value\\path\\${i}"; // "quoted" comment with \\backslashes\\`,
    ).join("\n");
    const payload: CodecPayload = { v: 1, kind: "read.text", text: longBody, path: "some/file.ts" };
    const jsonText = JSON.stringify(payload);

    const unknownContext: ProtocolCallContext = { tool: "read_file", workspace: WS_ROOT }; // no clientId
    const unknownResult = applyResponseCodec(jsonText, payload, "read.text", unknownContext, 999999);
    expect(unknownResult).toBe(jsonText); // stays fully json -- E-3's conservative default for an unresolved client

    const knownContext: ProtocolCallContext = { tool: "read_file", workspace: WS_ROOT, clientId: "tl-reference-client" };
    const knownResult = applyResponseCodec(jsonText, payload, "read.text", knownContext, 999999, { now: FRESH_NOW });
    expect(knownResult).not.toBe(jsonText);
    expect(tlRaw1Codec.decode(knownResult)).toEqual(payload); // still round-trip-correct
  });

  it("an injected counter that scores every candidate as a large loss forces json end-to-end", () => {
    process.env["TOKENLIGHTEN_RESPONSE_FORMAT"] = "auto";
    process.env["TL_WIRE_BREAKEVEN"] = "1";
    const payload = rowsPayload(12);
    const jsonText = JSON.stringify(payload);
    const context: ProtocolCallContext = { tool: "search_files", workspace: WS_ROOT };
    const alwaysTiedCounter: TokenCounter = { id: "always-tied", count: () => 1_000_000 };

    const result = applyResponseCodec(jsonText, payload, "search.matches", context, 999999, {
      counter: alwaysTiedCounter,
      cache: new EncodingCache(4),
    });
    expect(result).toBe(jsonText);
  });

  it("emits a wire_codec_v2_cell trace record with exactly the documented fields, malformed always false", () => {
    process.env["TOKENLIGHTEN_RESPONSE_FORMAT"] = "auto";
    process.env["TL_WIRE_BREAKEVEN"] = "1";
    const payload = rowsPayload(12);
    const jsonText = JSON.stringify(payload);
    const context: ProtocolCallContext = { tool: "search_files", workspace: WS_ROOT };

    applyResponseCodec(jsonText, payload, "search.matches", context, 999999);

    const records = readTraceRecords().filter((r) => r["event"] === "wire_codec_v2_cell");
    expect(records.length).toBe(1);
    const record = records[0]!;
    expect(record["malformed"]).toBe(false);
    expect(record["kind"]).toBe("search.matches");
    expect(typeof record["fallback_reason"]).toBe("string");
    expect(typeof record["tokenizer_id"]).toBe("string");
    expect(typeof record["client_profile_id"]).toBe("string");
    expect(typeof record["shape_class"]).toBe("string");
    expect(typeof record["cache_hit"]).toBe("boolean");
    expect(new Set(Object.keys(record))).toEqual(
      new Set([
        "event", "ts", "kind", "codec", "json_bytes", "fallback_reason", "tokenizer_id",
        "client_profile_id", "shape_class", "cache_hit", "malformed",
        "trace_id", "flags_active", "workspaceRef", "protocol_era",
      ]),
    );
  });

  it("wire_codec_shadow keeps its pinned shape unchanged even when v2 and shadow both run together", () => {
    process.env["TOKENLIGHTEN_RESPONSE_FORMAT"] = "auto";
    process.env["TL_WIRE_BREAKEVEN"] = "1";
    process.env["TL_WIRE_SHADOW"] = "1";
    const payload = rowsPayload(12);
    const jsonText = JSON.stringify(payload);
    const context: ProtocolCallContext = { tool: "search_files", workspace: WS_ROOT };

    applyResponseCodec(jsonText, payload, "search.matches", context, 999999);

    const shadowRecords = readTraceRecords().filter((r) => r["event"] === "wire_codec_shadow");
    expect(shadowRecords.length).toBeGreaterThan(0);
    for (const record of shadowRecords) {
      expect(new Set(Object.keys(record))).toEqual(
        new Set([
          "event", "ts", "kind", "codec", "json_bytes", "codec_bytes", "est_tokens", "chosen",
          "trace_id", "flags_active", "workspaceRef", "protocol_era",
        ]),
      );
    }
  });

  it("no wire_codec_v2_cell record at all when v2 never runs (flags off)", () => {
    const payload = rowsPayload(12);
    const jsonText = JSON.stringify(payload);
    const context: ProtocolCallContext = { tool: "search_files", workspace: WS_ROOT };
    applyResponseCodec(jsonText, payload, "search.matches", context, 999999);
    expect(fs.existsSync(getTracePath(WS_ROOT))).toBe(false);
  });
});
