// ---------------------------------------------------------------------------
// V10-11 selection policy -- allowlist/hard-fixed-kind honesty, gain
// thresholds (row count, absolute, relative), the "never bigger than json"
// and "never exceed the host cap" safety floors, mode dispatch, and the
// pipeline's malformed/unexpected-error -> json fallback.
// ---------------------------------------------------------------------------

import { describe, it, expect, afterEach } from "vitest";
import type { Kind } from "@tokenlighten/types";
import {
  HARD_JSON_FIXED_KINDS,
  MIN_ABSOLUTE_GAIN_BYTES,
  MIN_RELATIVE_GAIN,
  MIN_ROWS,
  NON_JSON_ALLOWLIST,
  evaluateCandidates,
  isEligibleKind,
  selectForWire,
  type CodecCandidate,
} from "../protocol/codec/policy.js";
import { tlTable1Codec } from "../protocol/codec/tlTable1.js";
import { canonicalEqual } from "../protocol/codec/types.js";
import { applyResponseCodec } from "../protocol/codec/pipeline.js";
import type { ProtocolCallContext } from "../protocol/envelope.js";

const ALL_15_KINDS: readonly Kind[] = [
  "read.task_pack", "read.text", "read.map", "read.batch",
  "read.artifact", "read.receipt", "read.closure",
  "search.matches", "search.references", "search.tree",
  "edit.applied", "edit.reclassified", "edit.rolled_back", "edit.state_unknown",
  "refusal",
];

// ---------------------------------------------------------------------------
// Allowlist / hard-fixed honesty
// ---------------------------------------------------------------------------

describe("policy -- allowlist and hard-fixed kinds", () => {
  it("the allowlist is exactly the five V10-11 kinds", () => {
    expect([...NON_JSON_ALLOWLIST].sort()).toEqual(
      ["read.artifact", "read.batch", "read.map", "search.matches", "search.references"].sort(),
    );
  });

  it("the hard-fixed set is exactly the eight coverage/control-surface kinds", () => {
    expect([...HARD_JSON_FIXED_KINDS].sort()).toEqual(
      [
        "edit.applied", "edit.reclassified", "edit.rolled_back", "edit.state_unknown",
        "read.closure", "read.receipt", "read.task_pack", "refusal",
      ].sort(),
    );
  });

  it("the allowlist and the hard-fixed set are disjoint", () => {
    for (const kind of NON_JSON_ALLOWLIST) {
      expect(HARD_JSON_FIXED_KINDS.has(kind)).toBe(false);
    }
  });

  it.each(ALL_15_KINDS)("isEligibleKind(%s) matches allowlist membership exactly", (kind) => {
    expect(isEligibleKind(kind)).toBe(NON_JSON_ALLOWLIST.has(kind));
  });

  it("read.text and search.tree are eligible for neither set (never compact-encoded today)", () => {
    expect(isEligibleKind("read.text")).toBe(false);
    expect(isEligibleKind("search.tree")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// evaluateCandidates -- sorted, round-trip-proven
// ---------------------------------------------------------------------------

describe("policy -- evaluateCandidates", () => {
  it("returns candidates sorted ascending by measured bytes, all round-trip-proven", () => {
    const files = Array.from({ length: 10 }, (_, i) => ({ path: `f${i}.ts`, line: i, symbol: `s${i}`, kind: "function" }));
    const payload = { v: 1, kind: "search.matches", matches: { form: "symbols", locations: files, total: files.length } };
    const candidates = evaluateCandidates("search.matches", payload);
    expect(candidates.length).toBeGreaterThan(0);
    for (let i = 1; i < candidates.length; i++) {
      expect(candidates[i]!.bytes).toBeGreaterThanOrEqual(candidates[i - 1]!.bytes);
    }
    for (const c of candidates) {
      expect(canonicalEqual(c.codec.decode(c.text), payload)).toBe(true);
    }
  });

  it("returns an empty array when nothing canEncode()s the payload", () => {
    // No qualifying object-array/positional-rows table (tl-table-1), no
    // string field at all (tl-raw-1), and an array-of-arrays column that
    // fails every implemented tabular/inline form (toon-4.1).
    const payload = { v: 1, count: 3, pairs: [[1, 2], [3, 4]] };
    expect(evaluateCandidates("read.map", payload)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// selectForWire -- gain thresholds, tested against FABRICATED candidates so
// the threshold arithmetic is exercised in isolation from any one codec's
// actual compression ratio.
// ---------------------------------------------------------------------------

function fakeCandidate(bytes: number): CodecCandidate {
  return { codec: tlTable1Codec, text: "x".repeat(bytes), bytes };
}

describe("policy -- selectForWire gain thresholds (auto mode)", () => {
  const JSON_BYTES = 1000;
  const JSON_TEXT = "x".repeat(JSON_BYTES);

  it("rejects (stays json) when candidate row count is below MIN_ROWS", () => {
    const payload = { v: 1, kind: "search.matches", items: [{ a: 1 }] }; // 1 row < MIN_ROWS
    const winner = fakeCandidate(JSON_BYTES - MIN_ABSOLUTE_GAIN_BYTES - 10); // clears the byte gates
    const result = selectForWire("auto", payload, JSON_TEXT, JSON_BYTES, [winner], 999999);
    expect(result.codecId).toBe("json");
  });

  it("rejects (stays json) when absolute gain is below MIN_ABSOLUTE_GAIN_BYTES", () => {
    const items = Array.from({ length: MIN_ROWS + 2 }, (_, i) => ({ a: i, b: i }));
    const payload = { v: 1, kind: "search.matches", items };
    const winner = fakeCandidate(JSON_BYTES - Math.floor(MIN_ABSOLUTE_GAIN_BYTES / 2)); // absolute gain too small
    const result = selectForWire("auto", payload, JSON_TEXT, JSON_BYTES, [winner], 999999);
    expect(result.codecId).toBe("json");
  });

  it("rejects (stays json) when relative gain is below MIN_RELATIVE_GAIN", () => {
    const items = Array.from({ length: MIN_ROWS + 2 }, (_, i) => ({ a: i, b: i }));
    const payload = { v: 1, kind: "search.matches", items };
    // Absolute gain clears the floor, but relative gain (a fraction of a
    // large JSON_BYTES) does not.
    const winner = fakeCandidate(JSON_BYTES - MIN_ABSOLUTE_GAIN_BYTES - 1);
    const relativeGain = MIN_ABSOLUTE_GAIN_BYTES / JSON_BYTES;
    expect(relativeGain).toBeLessThan(MIN_RELATIVE_GAIN); // sanity on the fixture itself
    const result = selectForWire("auto", payload, JSON_TEXT, JSON_BYTES, [winner], 999999);
    expect(result.codecId).toBe("json");
  });

  it("selects the candidate when all three thresholds clear", () => {
    const items = Array.from({ length: MIN_ROWS + 5 }, (_, i) => ({ a: i, b: i }));
    const payload = { v: 1, kind: "search.matches", items };
    const winner = fakeCandidate(Math.floor(JSON_BYTES * (1 - MIN_RELATIVE_GAIN - 0.05))); // well past every floor
    const result = selectForWire("auto", payload, JSON_TEXT, JSON_BYTES, [winner], 999999);
    expect(result.codecId).toBe(`${winner.codec.id}/${winner.codec.version}`);
    expect(result.text).toBe(winner.text);
  });
});

describe("policy -- selectForWire, compact mode bypasses the optimization gate", () => {
  it("selects a candidate below the auto thresholds as long as it is strictly smaller (the hard floor)", () => {
    const payload = { v: 1, kind: "search.matches", items: [{ a: 1 }] }; // 1 row -- fails MIN_ROWS
    const jsonBytes = 1000;
    const winner = fakeCandidate(jsonBytes - 1); // trivial gain, fails MIN_ABSOLUTE_GAIN_BYTES too
    const auto = selectForWire("auto", payload, "x".repeat(jsonBytes), jsonBytes, [winner], 999999);
    const compact = selectForWire("compact", payload, "x".repeat(jsonBytes), jsonBytes, [winner], 999999);
    expect(auto.codecId).toBe("json");
    expect(compact.codecId).toBe(`${winner.codec.id}/${winner.codec.version}`);
  });

  it("still refuses (both modes) when the candidate is not strictly smaller than json", () => {
    const payload = { v: 1, kind: "search.matches", items: [{ a: 1 }] };
    const jsonBytes = 500;
    const winner = fakeCandidate(jsonBytes + 50); // bigger than json
    const auto = selectForWire("auto", payload, "x".repeat(jsonBytes), jsonBytes, [winner], 999999);
    const compact = selectForWire("compact", payload, "x".repeat(jsonBytes), jsonBytes, [winner], 999999);
    expect(auto.codecId).toBe("json");
    expect(compact.codecId).toBe("json");
  });
});

describe("policy -- selectForWire never exceeds the host cap", () => {
  it("refuses a candidate whose bytes exceed the wire limit, even with huge gain", () => {
    const payload = { v: 1, kind: "search.matches", items: Array.from({ length: 20 }, (_, i) => ({ a: i })) };
    const jsonBytes = 100000;
    const winner = fakeCandidate(500); // enormous gain
    const result = selectForWire("auto", payload, "x".repeat(jsonBytes), jsonBytes, [winner], 400 /* limit < winner.bytes */);
    expect(result.codecId).toBe("json");
  });
});

describe("policy -- selectForWire mode dispatch (defense in depth)", () => {
  it.each(["json", "debug"] as const)("mode=%s never selects a non-json candidate", (mode) => {
    const payload = { v: 1, kind: "search.matches", items: Array.from({ length: 10 }, (_, i) => ({ a: i })) };
    const jsonBytes = 1000;
    const winner = fakeCandidate(10); // would trivially clear every gate
    const result = selectForWire(mode, payload, "x".repeat(jsonBytes), jsonBytes, [winner], 999999);
    expect(result.codecId).toBe("json");
    expect(result.text).toBe("x".repeat(jsonBytes));
  });

  it("returns json when there are no candidates at all", () => {
    const payload = { v: 1, kind: "search.matches", items: [] };
    const result = selectForWire("auto", payload, "{}", 2, [], 999999);
    expect(result.codecId).toBe("json");
  });
});

// ---------------------------------------------------------------------------
// applyResponseCodec (pipeline) -- malformed/unexpected error -> json fallback
// ---------------------------------------------------------------------------

describe("pipeline -- malformed/unexpected error always falls back to json", () => {
  const savedEnv: Record<string, string | undefined> = {};
  for (const key of ["TOKENLIGHTEN_RESPONSE_FORMAT", "TL_WIRE_SHADOW", "TL_TRACE"]) savedEnv[key] = process.env[key];
  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("returns the original text unchanged if reading context throws mid-pipeline", () => {
    process.env["TOKENLIGHTEN_RESPONSE_FORMAT"] = "compact";
    process.env["TL_WIRE_SHADOW"] = "1";
    // The workspace-guarded shadow-trace branch is the poisoned code path
    // below; it only runs when isTraceEnabled() is true.
    process.env["TL_TRACE"] = "1";
    const items = Array.from({ length: 20 }, (_, i) => ({ a: i, b: `row${i}` }));
    const payload = { v: 1, kind: "search.matches", items };
    const text = JSON.stringify(payload);
    const poisonedContext = {
      tool: "search_files",
      get workspace(): string {
        throw new Error("boom -- simulated pipeline failure");
      },
    } as unknown as ProtocolCallContext;

    const result = applyResponseCodec(text, payload, "search.matches", poisonedContext, 999999);
    expect(result).toBe(text);
  });
});
