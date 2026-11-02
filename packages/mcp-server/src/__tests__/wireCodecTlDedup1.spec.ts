// ---------------------------------------------------------------------------
// B2a -- `tl-dedup-1`: exact repeats folded reversibly. Only byte-identical
// strings and rows fold; everything else stays where it was, in order, and the
// original count and position come back on decode.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { applyResponseCodec, resetV2CacheForTest } from "../protocol/codec/pipeline.js";
import { evaluateCandidates } from "../protocol/codec/policy.js";
import { tlDedup1Codec } from "../protocol/codec/tlDedup1.js";
import { canonicalEqual, type CodecPayload } from "../protocol/codec/types.js";

function roundTrips(payload: CodecPayload): string {
  expect(tlDedup1Codec.canEncode("read.text", payload)).toBe(true);
  const text = tlDedup1Codec.encode(payload);
  const decoded = tlDedup1Codec.decode(text);
  expect(canonicalEqual(decoded, payload), JSON.stringify(decoded).slice(0, 300)).toBe(true);
  return text;
}

const body = (lines: string[]): CodecPayload => ({ v: 1, kind: "read.text", evidence: [{ path: "a.log", range: `1-${lines.length}`, body: lines.join("\n") }] });

describe("tl-dedup-1", () => {
  it("identifies itself", () => {
    expect(tlDedup1Codec.id).toBe("tl-dedup-1");
    expect(tlDedup1Codec.version).toBe("1");
  });

  it("folds consecutive repeats of a log line, and the count comes back exactly", () => {
    const lines = ["start", ...Array.from({ length: 200 }, () => "ERROR connection refused by upstream host"), "stop"];
    const text = roundTrips(body(lines));
    expect(text.length).toBeLessThan(JSON.stringify(body(lines)).length / 3);
    // The repeated line appears once on the wire.
    expect(text.split("ERROR connection refused by upstream host").length - 1).toBe(1);
  });

  it("restores a repeat that reappears after other lines, in its original positions", () => {
    const repeated = "WARN cache miss for the shared configuration key";
    const lines = [repeated, "a", repeated, repeated, "b", "c", repeated];
    const text = roundTrips(body(lines));
    expect(text.split(repeated).length - 1).toBe(1);
    const decoded = tlDedup1Codec.decode(text) as { evidence: Array<{ body: string }> };
    expect(decoded.evidence[0]!.body.split("\n")).toEqual(lines);
  });

  it.each([
    ["port number", "port: 80", "port: 8080"],
    ["sign", "delta = +5 for the current account", "delta = -5 for the current account"],
    ["negation", "the feature is enabled for this host", "the feature is not enabled for this host"],
    ["timestamp", "2026-10-30T10:00:00Z job finished", "2026-10-30T10:00:01Z job finished"],
    ["case", "Status Unknown In Region", "status unknown in region"],
    ["trailing space", "the same line of text", "the same line of text "],
  ])("never treats similar lines as equal: %s", (_name, first, second) => {
    const lines = [first, second, first, second, first, second, first, second];
    const decoded = tlDedup1Codec.decode(roundTrips(body(lines))) as { evidence: Array<{ body: string }> };
    expect(decoded.evidence[0]!.body.split("\n")).toEqual(lines);
    expect(tlDedup1Codec.encode(body(lines))).toContain(JSON.stringify(first).slice(1, -1));
    expect(tlDedup1Codec.encode(body(lines))).toContain(JSON.stringify(second).slice(1, -1));
  });

  it("keeps line endings, blank lines and a missing final newline as they were", () => {
    const line = "the same long enough line";
    for (const text of [`${line}\r\ny\r\n${line}\r\ny\r\n${line}\r\ny\r\n`, `\n\n\n${line}\n\n${line}\n\n${line}\n`, `${line}\n${line}\n${line}`, `${line}\n${line}\n${line}\n`]) {
      const payload: CodecPayload = { v: 1, kind: "read.text", text };
      const decoded = tlDedup1Codec.decode(roundTrips(payload)) as { text: string };
      expect(decoded.text).toBe(text);
    }
  });

  it("folds repeated rows of an array, and leaves their order and values alone", () => {
    const row = { path: "src/a.ts", line: 3, symbol: "handler", value: null };
    const other = { path: "src/a.ts", line: 4, symbol: "handler", value: 0 };
    const rows = [row, row, row, other, row, other, other, row];
    const payload: CodecPayload = { v: 1, kind: "search.matches", matches: { locations: rows } };
    const decoded = tlDedup1Codec.decode(roundTrips(payload)) as { matches: { locations: unknown[] } };
    expect(decoded.matches.locations).toEqual(rows);
  });

  it("does not equate 0, null, false, empty string or a differently ordered object", () => {
    const rows = [0, null, false, "", 0, null, false, "", { a: 1, b: 2 }, { b: 2, a: 1 }, { a: 1, b: 2 }, { b: 2, a: 1 }];
    const payload: CodecPayload = { v: 1, kind: "read.map", rows };
    const decoded = tlDedup1Codec.decode(roundTrips(payload)) as { rows: unknown[] };
    expect(decoded.rows).toEqual(rows);
    // Key order is not canonicalized away: the rows stay byte-distinct on decode.
    expect(JSON.stringify(decoded.rows)).toBe(JSON.stringify(rows));
  });

  it("declines a payload with nothing to fold, so metadata can never be its only content", () => {
    const unique = body(["alpha", "beta", "gamma", "delta"]);
    expect(tlDedup1Codec.canEncode("read.text", unique)).toBe(false);
    expect(tlDedup1Codec.canEncode("read.text", { v: 1, kind: "read.text" })).toBe(false);
    // Two copies of a short line are not worth a dictionary entry.
    expect(tlDedup1Codec.canEncode("read.text", body(["ab", "ab"]))).toBe(false);
  });

  it("declines a payload that already uses its reserved marker, and never collides with literal look-alikes", () => {
    const repeated = Array.from({ length: 12 }, () => "the same long enough line of text").join("\n");
    expect(tlDedup1Codec.canEncode("read.text", { v: 1, kind: "read.text", text: repeated, $tl1d: "x" })).toBe(false);
    expect(tlDedup1Codec.canEncode("read.text", { v: 1, kind: "read.text", text: repeated, nested: [{ $tl1d: [1] }] })).toBe(false);
    // A line that merely looks like the format stays ordinary text.
    const lookAlike = ["[0,3]", "0", "@1", "\"$tl1d\"", "the same long enough line of text", "the same long enough line of text", "the same long enough line of text"];
    const decoded = tlDedup1Codec.decode(roundTrips(body(lookAlike))) as { evidence: Array<{ body: string }> };
    expect(decoded.evidence[0]!.body.split("\n")).toEqual(lookAlike);
  });

  it("is deterministic, and survives Japanese, emoji and special-token look-alikes", () => {
    const lines = Array.from({ length: 30 }, (_, i) => (i % 3 === 0 ? "接続タイムアウトが発生しました 🎉 <|endoftext|>" : `行 ${i % 3}`));
    const first = roundTrips(body(lines));
    expect(tlDedup1Codec.encode(body(lines))).toBe(first);
    const decoded = tlDedup1Codec.decode(first) as { evidence: Array<{ body: string }> };
    expect(decoded.evidence[0]!.body.split("\n")).toEqual(lines);
  });

  it("starts with a self-describing header, and rejects text that is not its own", () => {
    const text = roundTrips(body(Array.from({ length: 12 }, () => "the same long enough line of text")));
    expect(text.startsWith("TL1D")).toBe(true);
    expect(text.split("\n")[0]!.length).toBeLessThan(160);
    expect(() => tlDedup1Codec.decode("{\"v\":1}")).toThrow();
    expect(() => tlDedup1Codec.decode("TL1D\nnot json")).toThrow();
  });

  it("bounds its own work", () => {
    const huge = Array.from({ length: 50_000 }, (_, i) => `line ${i % 5} of a long repeated log`);
    const started = performance.now();
    roundTrips(body(huge));
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});

describe("tl-dedup-1 in selection", () => {
  const KEYS = ["TL_WIRE_DEDUP", "TOKENLIGHTEN_RESPONSE_FORMAT", "TL_WIRE_BREAKEVEN"] as const;
  const rows = Array.from({ length: 60 }, (_, i) => ({ path: "src/shared/module.ts", line: 10, symbol: i % 2 === 0 ? "handlerA" : "handlerB" }));
  const payload: CodecPayload = { v: 1, kind: "search.matches", matches: { form: "symbols", locations: rows, total: 60 } };
  const text = JSON.stringify(payload);
  const context = { tool: "tl_search_files" as const };

  function withEnv<T>(env: Record<string, string>, run: () => T): T {
    const saved = KEYS.map((key) => [key, process.env[key]] as const);
    for (const key of KEYS) delete process.env[key];
    Object.assign(process.env, env);
    try {
      return run();
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  it("is not a candidate without its flag, so existing selection is unchanged", () => {
    const candidates = withEnv({}, () => evaluateCandidates("search.matches", payload));
    expect(candidates.map((c) => c.codec.id)).not.toContain("tl-dedup-1");
  });

  it("competes under the flag, and what it sends decodes to the payload", () => {
    const candidates = withEnv({ TL_WIRE_DEDUP: "1" }, () => evaluateCandidates("search.matches", payload));
    expect(candidates.map((c) => c.codec.id)).toContain("tl-dedup-1");
    const out = withEnv({ TL_WIRE_DEDUP: "1", TOKENLIGHTEN_RESPONSE_FORMAT: "auto", TL_WIRE_BREAKEVEN: "1" }, () => {
      resetV2CacheForTest();
      return applyResponseCodec(text, payload, "search.matches", context, 999_999);
    });
    expect(out.length).toBeLessThan(text.length);
    if (out.startsWith("TL1D")) expect(canonicalEqual(tlDedup1Codec.decode(out), payload)).toBe(true);
  });

  it("a log body with no rows can win, though the row floor would stop a table", () => {
    const log = Array.from({ length: 200 }, () => "ERROR connection refused by upstream host").join("\n");
    const batch: CodecPayload = { v: 1, kind: "read.batch", entries: [{ form: "handle", path: "a.log", range: "1-200", content: log }] };
    const out = withEnv({ TL_WIRE_DEDUP: "1", TOKENLIGHTEN_RESPONSE_FORMAT: "auto", TL_WIRE_BREAKEVEN: "1" }, () => {
      resetV2CacheForTest();
      return applyResponseCodec(JSON.stringify(batch), batch, "read.batch", { tool: "tl_read_file" as const }, 999_999);
    });
    expect(out.startsWith("TL1D")).toBe(true);
    expect(canonicalEqual(tlDedup1Codec.decode(out), batch)).toBe(true);
  });

  it("over the host limit it is not sent", () => {
    const out = withEnv({ TL_WIRE_DEDUP: "1", TOKENLIGHTEN_RESPONSE_FORMAT: "auto", TL_WIRE_BREAKEVEN: "1" }, () => {
      resetV2CacheForTest();
      return applyResponseCodec(text, payload, "search.matches", context, 10);
    });
    expect(out).toBe(text);
  });
});
