// ---------------------------------------------------------------------------
// A1/A2 -- the real-tokenizer shadow and token selection. T-numbers refer to the
// improvement spec's §10.2 table. Real js-tiktoken runs wherever a test claims a
// count; a fake backend appears only to force an order or a failure no real
// dictionary produces on demand.
// ---------------------------------------------------------------------------

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Kind } from "@tokenlighten/types";
import { callTool } from "../server.js";
import { handleTable } from "../util/handles.js";
import { resetAll as resetAllSessions } from "../util/session.js";
import { resetPackDedupeCache, resetRoleInventoryCache } from "../tools/readCodeTaskPack.js";
import { resetRootResolverCache, setActiveRootWorkspace } from "../tools/locateTaskContext.js";
import { getTracePath, setTraceEnabledForTest } from "../util/trace.js";
import { resolveTokenBreakevenThresholds, TOKEN_POLICY_VERSION, tokenPolicyVersion } from "../protocol/codec/breakeven.js";
import { UNKNOWN_CLIENT_PROFILE, resolveClientProfile } from "../protocol/codec/clientProfile.js";
import { EncodingCache } from "../protocol/codec/encodingCache.js";
import { applyResponseCodec, resetV2CacheForTest } from "../protocol/codec/pipeline.js";
import { evaluateCandidates, evaluateCandidatesWithRejections, selectForWire, type CodecCandidate } from "../protocol/codec/policy.js";
import { selectForWireV2 } from "../protocol/codec/selectV2.js";
import { tlTable1Codec } from "../protocol/codec/tlTable1.js";
import { byteCounter, type TokenCounter } from "../protocol/codec/tokenCounter.js";
import {
  countCost,
  ensureWireTokenizerLoaded,
  MAX_COUNT_INPUT_BYTES,
  resolveWireTokenizer,
  setWireTokenizerLoaderForTest,
  TokenCountRefused,
  wireTokenizerNeeded,
  type RealTokenCounter,
  type TokenizerBackend,
} from "../protocol/codec/tokenizerResolver.js";
import { measureTokenShadow, type TokenShadowRecord } from "../protocol/codec/tokenShadow.js";
import type { CodecPayload } from "../protocol/codec/types.js";
import type { ProtocolCallContext } from "../protocol/envelope.js";

const ENV_KEYS = [
  "TOKENLIGHTEN_RESPONSE_FORMAT",
  "TL_WIRE_SHADOW",
  "TL_WIRE_BREAKEVEN",
  "TL_WIRE_TOKENIZER",
  "TL_WIRE_TOKEN_SELECT",
  "TOKENLIGHTEN_CLIENT_ID",
] as const;

let savedEnv: Record<string, string | undefined>;
let tmpHome: string;
let origHome: string | undefined;
const WS_ROOT = "/workspace/wire-token-selection-test";
const CONTEXT: ProtocolCallContext = { tool: "tl_search_files", workspace: WS_ROOT };

beforeEach(() => {
  origHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "tl-wire-token-"));
  process.env.HOME = tmpHome;
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  setTraceEnabledForTest(true);
  resetV2CacheForTest();
  setWireTokenizerLoaderForTest();
});

afterEach(() => {
  if (origHome !== undefined) process.env.HOME = origHome;
  else delete process.env.HOME;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  setTraceEnabledForTest(false);
  resetV2CacheForTest();
  setWireTokenizerLoaderForTest();
  vi.restoreAllMocks();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function rowsPayload(n: number): CodecPayload {
  const items = Array.from({ length: n }, (_, i) => ({ path: `src/module${i}/file${i}.ts`, line: i + 1, symbol: `handler${i}` }));
  return { v: 1, kind: "search.matches", matches: { form: "symbols", locations: items, total: n } };
}

function traceRecords(event: string, root = WS_ROOT): Array<Record<string, unknown>> {
  const file = getTracePath(root);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split("\n").filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((record) => record["event"] === event);
}

function fakeBackend(encodeLength: (text: string) => number, dictionaryRevision = "fake0000"): TokenizerBackend {
  return { implementation: "fake-1", dictionaryRevision, encodeLength };
}

async function realCounter(encoding = "o200k_base"): Promise<RealTokenCounter> {
  process.env["TL_WIRE_TOKENIZER"] = encoding;
  process.env["TL_WIRE_SHADOW"] = "1";
  await ensureWireTokenizerLoaded();
  const resolved = resolveWireTokenizer();
  if (resolved.status !== "ready") throw new Error(`no tokenizer: ${JSON.stringify(resolved)}`);
  return resolved.counter;
}

async function fakeCounter(encodeLength: (text: string) => number, revision?: string): Promise<RealTokenCounter> {
  setWireTokenizerLoaderForTest(async () => fakeBackend(encodeLength, revision));
  return realCounter();
}

function shadowOf(payload: CodecPayload, kind: Kind, counter: RealTokenCounter | undefined, limit = 999_999): TokenShadowRecord {
  const jsonText = JSON.stringify(payload);
  return measureTokenShadow({
    kind, payload, jsonText, jsonBytes: Buffer.byteLength(jsonText, "utf8"), limit,
    clientProfile: UNKNOWN_CLIENT_PROFILE,
    tokenizer: counter === undefined ? { status: "unavailable", reason: "not-loaded" } : { status: "ready", counter },
    cache: new EncodingCache(16),
  });
}

function enableTokenSelection(): void {
  process.env["TOKENLIGHTEN_RESPONSE_FORMAT"] = "auto";
  process.env["TL_WIRE_BREAKEVEN"] = "1";
  process.env["TL_WIRE_TOKEN_SELECT"] = "1";
}

// ---------------------------------------------------------------------------
// A1 -- the real counter
// ---------------------------------------------------------------------------

describe("A1 real tokenizer (T02, T05, T06, T07)", () => {
  it("T02: counts a known string through the real dictionaries, with an identity naming every count-changing input", async () => {
    const counter = await realCounter("o200k_base");
    expect(counter.count("hello world")).toBe(2);
    expect(counter.unit).toBe("tokens");
    expect(counter.id).toMatch(/^tiktoken\/o200k_base\/js-tiktoken-1\/dict-[0-9a-f]{12}\/special-ordinary$/);
    expect(counter.id).not.toContain(" ");
    expect(counter.initMs).toBeGreaterThanOrEqual(0);

    const cl100k = await realCounter("cl100k_base");
    expect(cl100k.count("hello world")).toBe(2);
    expect(cl100k.id).not.toBe(counter.id);
  });

  it("T07: Japanese, English, emoji and special-token look-alikes count as ordinary text and never throw", async () => {
    const counter = await realCounter("o200k_base");
    for (const text of ["関連箇所の検索結果を返す。", "mixed 日本語 and English", "emoji 🎉👩‍💻 ok", "\"quoted\\path\"\n\ttabbed"]) {
      expect(counter.count(text)).toBeGreaterThan(0);
    }
    // js-tiktoken's own default REJECTS this input, and an allow-list would map it to a single id.
    const special = counter.count("<|endoftext|>");
    expect(special).toBeGreaterThan(1);
    expect(special).toBe(counter.count("<|endoftext|>"));
  });

  it("T05: an unknown encoding and a client name alone never yield a count, and a count never claims a model", async () => {
    process.env["TL_WIRE_TOKENIZER"] = "gpt-5";
    process.env["TL_WIRE_SHADOW"] = "1";
    await ensureWireTokenizerLoaded();
    expect(resolveWireTokenizer()).toEqual({ status: "unavailable", reason: "unknown-encoding" });

    delete process.env["TL_WIRE_TOKENIZER"];
    process.env["TOKENLIGHTEN_CLIENT_ID"] = "Visual Studio Code";
    expect(resolveWireTokenizer()).toEqual({ status: "disabled" });

    const counter = await realCounter();
    const record = shadowOf(rowsPayload(8), "search.matches", counter);
    expect(record.measurement).toBe("encoding-exact");
    expect(record.model_mapping).toBe("unverified");
  });

  it("T06: a different dictionary revision is a different identity, and the cache never crosses them", async () => {
    const first = await fakeCounter(() => 100, "aaaaaaaa");
    const second = await fakeCounter(() => 700, "bbbbbbbb");
    expect(first.id).not.toBe(second.id);

    const payload = rowsPayload(12);
    const jsonText = JSON.stringify(payload);
    const jsonBytes = Buffer.byteLength(jsonText, "utf8");
    const candidates = evaluateCandidates("search.matches", payload);
    const cache = new EncodingCache(16);
    const params = { kind: "search.matches" as Kind, payload, jsonText, jsonBytes, candidates, limit: 999_999, clientProfile: UNKNOWN_CLIENT_PROFILE, cache };
    expect(selectForWireV2({ ...params, counter: first }).jsonUnits).toBe(100);
    const after = selectForWireV2({ ...params, counter: second });
    expect(after.jsonUnits).toBe(700);
    expect(after.cacheHit).toBe(false);
    expect(selectForWireV2({ ...params, counter: first }).jsonUnits).toBe(100);
  });
});

describe("A1 failure handling (T04)", () => {
  const INVALID: ReadonlyArray<[string, () => number]> = [
    ["NaN", () => Number.NaN],
    ["negative", () => -1],
    ["fractional", () => 1.5],
    ["zero for a non-empty text", () => 0],
    ["a promise", () => Promise.resolve(3) as unknown as number],
  ];

  it.each(INVALID)("refuses an invalid count (%s), and selection falls back to bytes", async (_name, encodeLength) => {
    const counter = await fakeCounter(encodeLength);
    expect(() => counter.count("some text")).toThrow(TokenCountRefused);

    enableTokenSelection();
    const payload = rowsPayload(12);
    const jsonText = JSON.stringify(payload);
    const out = applyResponseCodec(jsonText, payload, "search.matches", CONTEXT, 999_999);
    const byteChoice = selectForWire("auto", payload, jsonText, Buffer.byteLength(jsonText, "utf8"), evaluateCandidates("search.matches", payload), 999_999);
    expect(out).toBe(byteChoice.text);
    const cell = traceRecords("wire_codec_v2_cell")[0]!;
    expect(cell["tokenizer_id"]).toBe("bytes");
    expect(cell["selection_basis"]).toBe("bytes-fallback");
    expect(cell["token_fallback"]).toBe("invalid-count");
  });

  it("a throwing encoder and a failed load keep the response, once per process for the load", async () => {
    const throwing = await fakeCounter(() => { throw new Error("boom"); });
    expect(() => throwing.count("x")).toThrow(/count-threw/);

    let loads = 0;
    setWireTokenizerLoaderForTest(async () => { loads += 1; throw new Error("dictionary missing"); });
    enableTokenSelection();
    process.env["TL_WIRE_TOKENIZER"] = "o200k_base";
    await ensureWireTokenizerLoaded();
    await ensureWireTokenizerLoaded();
    expect(loads).toBe(1);
    expect(resolveWireTokenizer()).toEqual({ status: "unavailable", reason: "load-failed" });

    const payload = rowsPayload(12);
    const jsonText = JSON.stringify(payload);
    const out = applyResponseCodec(jsonText, payload, "search.matches", CONTEXT, 999_999);
    expect(out.length).toBeGreaterThan(0);
    const cell = traceRecords("wire_codec_v2_cell")[0]!;
    expect(cell["tokenizer_id"]).toBe("bytes");
    expect(cell["token_fallback"]).toBe("load-failed");
  });

  it("the shadow reports refusal as null counts, never 0, and its own failure cannot touch the response", async () => {
    const counter = await fakeCounter(() => Number.NaN);
    const record = shadowOf(rowsPayload(12), "search.matches", counter);
    expect(record.counter_status).toBe("refused");
    expect(record.counter_reason).toBe("invalid-count");
    expect(record.measurement).toBe("unavailable");
    expect(record.json_tokens).toBeNull();
    expect(record.candidates.every((c) => c.tokens === null && c.token_rank === null)).toBe(true);
    expect(record.virtual_token_v2).toBeNull();

    const unavailable = shadowOf(rowsPayload(12), "search.matches", undefined);
    expect(unavailable.counter_status).toBe("unavailable");
    expect(unavailable.json_tokens).toBeNull();
  });

  it("nothing loads unless a consumer exists: an unset flag and a flag with no consumer do no work", async () => {
    let loads = 0;
    setWireTokenizerLoaderForTest(async () => { loads += 1; return fakeBackend(() => 1); });
    await ensureWireTokenizerLoaded();
    process.env["TL_WIRE_TOKENIZER"] = "o200k_base";
    expect(wireTokenizerNeeded()).toBe(false);
    await ensureWireTokenizerLoaded();
    setTraceEnabledForTest(false);
    process.env["TL_WIRE_SHADOW"] = "1";
    expect(wireTokenizerNeeded()).toBe(false);
    await ensureWireTokenizerLoaded();
    expect(loads).toBe(0);
  });
});

describe("A1 cost bounds (T08)", () => {
  it("prices the quadratic inputs before the encoder sees them", async () => {
    const encode = vi.fn((text: string) => text.length);
    const counter = await fakeCounter(encode);
    for (const [text, reason] of [
      ["a".repeat(16_000), "input-too-costly"],
      ["関連箇所の検索結果".repeat(300), "input-too-costly"],
      ["=-".repeat(4_000), "input-too-costly"],
      [" ".repeat(4_000), "input-too-costly"],
      ["\n".repeat(4_000), "input-too-costly"],
      [`${"word ".repeat(30_000)}`, "input-too-large"],
    ] as const) {
      expect(countCost(text)).toBe(reason);
      expect(() => counter.count(text)).toThrow(reason);
    }
    expect(encode).not.toHaveBeenCalled();
    expect(MAX_COUNT_INPUT_BYTES).toBe(128 * 1024);
  });

  it("the guard leaves ordinary large responses countable, and a real count stays fast", async () => {
    const counter = await realCounter("o200k_base");
    const body = JSON.stringify(rowsPayload(800));
    expect(countCost(body)).toBeUndefined();
    const started = performance.now();
    expect(counter.count(body)).toBeGreaterThan(1_000);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it("the measurement cache bounds retained text as well as entries", () => {
    const cache = new EncodingCache(100, 1_000);
    const key = (id: string) => ({ payloadHash: id, codecId: "c", codecVersion: "1", tokenizerId: "t" });
    cache.set(key("a"), { text: "x".repeat(600), bytes: 600, units: 1 });
    cache.set(key("b"), { text: "x".repeat(600), bytes: 600, units: 1 });
    expect(cache.get(key("a"))).toBeUndefined();
    expect(cache.get(key("b"))).toBeDefined();
    cache.set(key("huge"), { text: "x".repeat(1_001), bytes: 1_001, units: 1 });
    expect(cache.get(key("huge"))).toBeUndefined();
    expect(cache.stats().size).toBe(1);
  });
});

describe("A1 shadow record (T03)", () => {
  it("T03: detects byte/token rank inversion", async () => {
    // Fewer bytes -> more tokens: the exact order a byte comparison gets wrong.
    const counter = await fakeCounter((text) => 100_000 - text.length);
    const record = shadowOf(rowsPayload(12), "search.matches", counter);
    expect(record.candidates.length).toBeGreaterThan(1);
    expect(record.rank_inverted).toBe(true);
    // Over candidates selection could actually take, which a byte-floor candidate is not.
    const eligible = record.candidates.filter((c) => c.status === "eligible");
    expect(record.rank_inverted_eligible).toBe(eligible.length < 2 ? null : true);
    const bySize = [...record.candidates].sort((a, b) => a.bytes - b.bytes);
    expect(bySize[0]!.byte_rank).toBe(1);
    expect(bySize[0]!.token_rank).toBe(bySize.length);
  });

  it("records no text, path or query, and a real count for each candidate", async () => {
    const counter = await realCounter("cl100k_base");
    const payload = rowsPayload(12);
    const record = shadowOf(payload, "search.matches", counter);
    const flat = JSON.stringify(record);
    expect(flat).not.toContain("handler1");
    expect(flat).not.toContain("src/module");
    expect(record.json_tokens).toBeGreaterThan(0);
    expect(record.candidates.every((c) => (c.tokens ?? 0) > 0)).toBe(true);
    expect(record.boundary).toBe("tl-final-text");
    expect(record.policy_version).toBe(TOKEN_POLICY_VERSION);
    // Counted as whole texts: a candidate's count equals counting its own final string.
    const whole = evaluateCandidates("search.matches", payload);
    for (const entry of record.candidates) {
      const candidate = whole.find((c) => `${c.codec.id}/${c.codec.version}` === entry.codec)!;
      expect(entry.tokens).toBe(counter.count(candidate.text));
    }
  });

  it("distinguishes why a codec is absent and why a candidate is unusable", async () => {
    const counter = await realCounter("o200k_base");
    const payload = rowsPayload(12);
    const noRows = evaluateCandidatesWithRejections("read.map", { v: 1, kind: "read.map", note: "no tabular rows here" });
    expect(noRows.rejected.some((entry) => entry.reason === "cannot-encode")).toBe(true);

    vi.spyOn(tlTable1Codec, "decode").mockReturnValue({ v: 1, kind: "other" });
    expect(evaluateCandidatesWithRejections("search.matches", payload).rejected)
      .toContainEqual({ codecId: `${tlTable1Codec.id}/${tlTable1Codec.version}`, reason: "round-trip-mismatch" });
    vi.restoreAllMocks();
    vi.spyOn(tlTable1Codec, "encode").mockImplementation(() => { throw new Error("boom"); });
    expect(evaluateCandidatesWithRejections("search.matches", payload).rejected)
      .toContainEqual({ codecId: `${tlTable1Codec.id}/${tlTable1Codec.version}`, reason: "codec-threw" });
    vi.restoreAllMocks();

    const tight = shadowOf(payload, "search.matches", counter, 10);
    // Byte-floor outranks over-limit for a candidate that is both.
    expect(tight.candidates.some((c) => c.status === "over-limit")).toBe(true);
    expect(tight.candidates.every((c) => c.status !== "eligible")).toBe(true);
    expect(tight.virtual_token_v2).toBe("json");

    const longBody = Array.from({ length: 40 }, (_, i) => `const x${i} = "value\\path\\${i}"; // "quoted"`).join("\n");
    const textPayload: CodecPayload = { v: 1, kind: "read.text", text: longBody, path: "some/file.ts" };
    const widened = shadowOf(textPayload, "read.text", counter);
    expect(widened.kind_class).toBe("widened");
    expect(widened.candidates.length).toBeGreaterThan(0);
    expect(widened.candidates.every((c) => c.status === "profile-not-allowed")).toBe(true);
    expect(widened.virtual_token_v2).toBe("json");
  });
});

// ---------------------------------------------------------------------------
// A2 -- selection
// ---------------------------------------------------------------------------

function candidate(codecId: string, text: string, bytes: number): CodecCandidate {
  return { codec: { id: codecId, version: "1", canEncode: () => true, encode: () => text, decode: () => ({}) }, text, bytes };
}

/** A declared token counter with per-text units, resolving the real o200k policy. */
function tokens(unitsByText: Record<string, number>, encoding = "o200k_base"): RealTokenCounter {
  return {
    id: `tiktoken/${encoding}/test`, unit: "tokens", encoding: encoding as RealTokenCounter["encoding"], initMs: 0,
    count(text: string): number {
      const units = unitsByText[text];
      if (units === undefined) throw new Error(`no fixture for ${text.slice(0, 40)}`);
      return units;
    },
  };
}

describe("A2 selection gates (T10-T16)", () => {
  // Large enough that the fixture candidates below are genuinely byte-smaller than json.
  const payload = rowsPayload(60);
  const jsonText = JSON.stringify(payload);
  const jsonBytes = Buffer.byteLength(jsonText, "utf8");
  const base = { kind: "search.matches" as Kind, payload, jsonText, jsonBytes, limit: 999_999, clientProfile: UNKNOWN_CLIENT_PROFILE };
  const select = (candidates: CodecCandidate[], counter: TokenCounter, limit = 999_999) =>
    selectForWireV2({ ...base, candidates, counter, limit, cache: new EncodingCache(8) });

  it("T10: byte-smaller but token-larger is not adopted", () => {
    const c = candidate("a", "fewer-bytes", jsonBytes - 200);
    const result = select([c], tokens({ [jsonText]: 500, "fewer-bytes": 600 }));
    expect(result).toMatchObject({ codecId: "json", fallbackReason: "negative-gain", text: jsonText });
  });

  it("T11: token-smaller but over the host byte cap is not adopted, and the next candidate is", () => {
    const big = candidate("big", "big-text", 900);
    const small = candidate("small", "small-text", 200);
    const counter = tokens({ [jsonText]: 1000, "big-text": 50, "small-text": 700 });
    expect(select([big, small], counter, 500)).toMatchObject({ codecId: "small/1", text: "small-text" });
    expect(select([big], counter, 500)).toMatchObject({ codecId: "json", fallbackReason: "host-budget-overshoot" });
  });

  it("T12: token-smaller but not byte-smaller than json is never adopted, however large the token gain", () => {
    const same = candidate("c", "same-bytes", jsonBytes);
    const larger = candidate("d", "more-bytes", jsonBytes + 1);
    const result = select([same, larger], tokens({ [jsonText]: 1000, "same-bytes": 1, "more-bytes": 1 }));
    expect(result).toMatchObject({ codecId: "json", fallbackReason: "byte-floor" });
  });

  it("T13: a best candidate that fails its gate yields the next one, then json", () => {
    const best = candidate("best", "best-text", 900);
    const next = candidate("next", "next-text", 800);
    const counter = tokens({ [jsonText]: 1000, "best-text": 100, "next-text": 500 });
    expect(select([next, best], counter, 850)).toMatchObject({ codecId: "next/1" });
    expect(select([next, best], counter, 10)).toMatchObject({ codecId: "json" });
  });

  it("T16: thresholds are token-denominated at their exact boundaries, not the byte table's 64", () => {
    const thresholds = resolveTokenBreakevenThresholds("o200k_base", { clientProfileId: "unknown", kind: "search.matches", shapeClass: "rows-small" as never });
    expect(thresholds).toEqual({ minRelativeGain: 0.03, minAbsoluteGainUnits: 16, minRows: 3 });

    const c = candidate("a", "t", 100);
    // 16 tokens clears; 15 does not. A 64-unit floor would reject both.
    expect(select([c], tokens({ [jsonText]: 100, t: 84 }))).toMatchObject({ codecId: "a/1" });
    expect(select([c], tokens({ [jsonText]: 100, t: 85 }))).toMatchObject({ codecId: "json", fallbackReason: "breakeven-not-cleared" });
    // Relative floor: 3% clears, just under does not, though the absolute floor clears both.
    expect(select([c], tokens({ [jsonText]: 1000, t: 970 }))).toMatchObject({ codecId: "a/1" });
    expect(select([c], tokens({ [jsonText]: 1000, t: 971 }))).toMatchObject({ codecId: "json", fallbackReason: "breakeven-not-cleared" });
    // The units of the claim are the units of the comparison.
    expect(select([c], tokens({ [jsonText]: 100, t: 84 }))).toMatchObject({ jsonUnits: 100, chosenUnits: 84 });
  });

  it("B3: token-1 stays selectable as the rollback, with its own floor, and the trace names the one in force", () => {
    process.env["TL_WIRE_TOKEN_POLICY"] = "token-1";
    try {
      expect(tokenPolicyVersion()).toBe("token-1");
      expect(resolveTokenBreakevenThresholds("o200k_base", { clientProfileId: "unknown", kind: "search.matches", shapeClass: "rows-small" as never }))
        .toEqual({ minRelativeGain: 0.10, minAbsoluteGainUnits: 16, minRows: 3 });
      const c = candidate("a", "t", 100);
      expect(select([c], tokens({ [jsonText]: 1000, t: 970 }))).toMatchObject({ codecId: "json", fallbackReason: "breakeven-not-cleared" });
      expect(select([c], tokens({ [jsonText]: 1000, t: 900 }))).toMatchObject({ codecId: "a/1" });
    } finally {
      delete process.env["TL_WIRE_TOKEN_POLICY"];
    }
    expect(tokenPolicyVersion()).toBe(TOKEN_POLICY_VERSION);
  });

  it("T16: a token tie resolves to the byte-smaller candidate, stably and repeatably", () => {
    const small = candidate("small", "s-text", 100);
    const large = candidate("large", "l-text", 200);
    const counter = tokens({ [jsonText]: 1000, "s-text": 500, "l-text": 500 });
    const ordered = [small, large];
    for (let run = 0; run < 3; run += 1) expect(select(ordered, counter)).toMatchObject({ codecId: "small/1", chosenUnits: 500 });
  });

  it("an encoding with no policy measures nothing and says so", () => {
    expect(resolveTokenBreakevenThresholds("p50k_base", { clientProfileId: "unknown", kind: "search.matches", shapeClass: "rows-small" as never })).toBeUndefined();
    const c = candidate("a", "t", 100);
    const counter = tokens({}, "p50k_base");
    expect(select([c], counter)).toMatchObject({ codecId: "json", fallbackReason: "no-token-policy" });
  });

  it("a byte counter's thresholds are unchanged: 64 bytes, not 16", () => {
    // byteCounter measures the text itself, so the fixture's text must really be this long.
    const sized = (bytes: number) => candidate("a", "x".repeat(bytes), bytes);
    expect(select([sized(jsonBytes - 63)], byteCounter).codecId).toBe("json");
    expect(select([sized(Math.floor(jsonBytes * 0.5))], byteCounter).codecId).toBe("a/1");
  });
});

describe("A2 pipeline (T14, T15)", () => {
  it("T14: a round-trip failure is excluded before tokens are compared", async () => {
    await realCounter("o200k_base");
    enableTokenSelection();
    const payload = rowsPayload(12);
    const jsonText = JSON.stringify(payload);
    const tableId = `${tlTable1Codec.id}/${tlTable1Codec.version}`;
    vi.spyOn(tlTable1Codec, "decode").mockReturnValue({ v: 1, kind: "other" });
    const out = applyResponseCodec(jsonText, payload, "search.matches", CONTEXT, 999_999);
    expect(traceRecords("wire_codec_v2_cell")[0]!["codec"]).not.toBe(tableId);
    expect(out.startsWith("tl-table")).toBe(false);
  });

  it("T15: hard-JSON kinds and the raw profile gate are untouched", async () => {
    await realCounter("o200k_base");
    enableTokenSelection();
    const pack: CodecPayload = { v: 1, kind: "read.task_pack", items: Array.from({ length: 40 }, (_, i) => ({ a: i, b: `row${i}` })) };
    const packText = JSON.stringify(pack);
    expect(applyResponseCodec(packText, pack, "read.task_pack", CONTEXT, 999_999)).toBe(packText);

    const refusal: CodecPayload = { v: 1, kind: "refusal", code: "x", rows: Array.from({ length: 40 }, (_, i) => ({ a: i })) };
    const refusalText = JSON.stringify(refusal);
    expect(applyResponseCodec(refusalText, refusal, "refusal", CONTEXT, 999_999)).toBe(refusalText);

    const longBody = Array.from({ length: 40 }, (_, i) => `const x${i} = "value\\path\\${i}"; // "quoted" comment \\backslash\\`).join("\n");
    const text: CodecPayload = { v: 1, kind: "read.text", text: longBody, path: "some/file.ts" };
    const json = JSON.stringify(text);
    expect(applyResponseCodec(json, text, "read.text", { ...CONTEXT, tool: "tl_read_file" }, 999_999)).toBe(json);
    const known = applyResponseCodec(json, text, "read.text", { ...CONTEXT, tool: "tl_read_file", clientId: "tl-reference-client" }, 999_999, {
      now: Date.parse("2026-08-22"),
    });
    expect(known).not.toBe(json);
    const cells = traceRecords("wire_codec_v2_cell");
    expect(cells[cells.length - 1]!["selection_basis"]).toBe("tokens");
    expect(resolveClientProfile("tl-reference-client", Date.parse("2026-08-22")).allowedCodecIds).toEqual(["tl-raw-1/1", "tl-dedup-1/1"]);
  });
});

// ---------------------------------------------------------------------------
// The real MCP path: callTool -> dispatch -> emit -> pipeline
// ---------------------------------------------------------------------------

describe("the production MCP path (T01, T09)", () => {
  const NEEDLE = "TlWireTokenSelectionNeedle";
  let workspace = "";
  const created: string[] = [];

  beforeAll(() => {
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), ".tl-wire-token-e2e-")));
    created.push(workspace);
    for (let i = 0; i < 12; i += 1) {
      fs.writeFileSync(path.join(workspace, `fixture${i}.ts`), [
        `// fixture file ${i}`,
        `export function handler${i}(): number {`,
        `  const ${NEEDLE}_${i} = ${i}; // ${NEEDLE} marker`,
        `  return ${NEEDLE}_${i};`,
        "}",
        "",
      ].join("\n"), "utf8");
    }
  });

  afterAll(() => {
    for (const ws of created) fs.rmSync(ws, { recursive: true, force: true });
  });

  function resetServerState(): void {
    handleTable.reset();
    resetAllSessions();
    resetPackDedupeCache();
    resetRoleInventoryCache();
    resetRootResolverCache();
    setActiveRootWorkspace(workspace);
  }

  async function find(): Promise<string> {
    resetServerState();
    const reply = await callTool("tl_search_files", { cwd: workspace, action: "find", queries: [NEEDLE] });
    return (reply as { content: Array<{ text: string }> }).content[0]!.text;
  }

  it("T01: shadow on and off produce byte-identical responses, with a real measurement traced", async () => {
    const off = await find();

    process.env["TL_WIRE_SHADOW"] = "1";
    process.env["TL_WIRE_TOKENIZER"] = "o200k_base";
    const on = await find();
    expect(on).toBe(off);

    const records = traceRecords("wire_codec_token_shadow", workspace);
    expect(records.length).toBeGreaterThan(0);
    const record = records[records.length - 1]!;
    expect(record["counter_status"]).toBe("measured");
    expect(record["tokenizer_id"]).toMatch(/^tiktoken\/o200k_base\//);
    expect(record["json_tokens"]).toBeGreaterThan(0);
    expect(on).not.toContain("wire_codec");

    // debug mode is the other shadow door, and also changes nothing.
    delete process.env["TL_WIRE_SHADOW"];
    process.env["TOKENLIGHTEN_RESPONSE_FORMAT"] = "debug";
    expect(await find()).toBe(off);
  });

  it("T09: a real tool call selects through the real resolver, not an override", async () => {
    enableTokenSelection();
    process.env["TL_WIRE_TOKENIZER"] = "o200k_base";
    const fs0 = fs.existsSync(getTracePath(workspace)) ? fs.readFileSync(getTracePath(workspace), "utf8").length : 0;
    const out = await find();
    const trace = fs.readFileSync(getTracePath(workspace), "utf8").slice(fs0);
    const cell = trace.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => record["event"] === "wire_codec_v2_cell").pop()!;
    expect(cell["tokenizer_id"]).toMatch(/^tiktoken\/o200k_base\//);
    expect(cell["selection_basis"]).toBe("tokens");
    expect(cell["policy_version"]).toBe(TOKEN_POLICY_VERSION);
    expect(cell["model_mapping"]).toBe("unverified");
    expect(cell["json_units"] as number).toBeGreaterThanOrEqual(cell["chosen_units"] as number);
    if (cell["codec"] !== "json") expect(out.startsWith("{")).toBe(false);

    // Rollback: without the flag the same call selects in bytes, and the record's shape returns to the pinned one.
    delete process.env["TL_WIRE_TOKEN_SELECT"];
    const fs1 = fs.readFileSync(getTracePath(workspace), "utf8").length;
    await find();
    const after = fs.readFileSync(getTracePath(workspace), "utf8").slice(fs1).trim().split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => record["event"] === "wire_codec_v2_cell").pop()!;
    expect(after["tokenizer_id"]).toBe("bytes");
    expect(after["selection_basis"]).toBeUndefined();
  });
});
