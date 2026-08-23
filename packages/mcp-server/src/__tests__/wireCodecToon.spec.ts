// ---------------------------------------------------------------------------
// toon-4.1 codec -- encode/decode property (fuzz) tests over generated
// payloads (CJK, emoji, control chars, newlines-in-values, S7.2 quoting-
// trigger battery), the implemented-subset boundary (canEncode negatives
// for shapes SPEC.md v4.1 covers but this module deliberately does not),
// and malformed-input coverage. See protocol/codec/toon.ts for the exact
// pinned-spec citation and the implemented-subset statement.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { toon41Codec } from "../protocol/codec/toon.js";
import { canonicalEqual } from "../protocol/codec/types.js";
import { mulberry32, randomString, randomScalar, int, type Rng } from "./helpers/wireCodecFuzz.js";

// ---------------------------------------------------------------------------
// S7.2 quoting-trigger battery -- each condition individually, round-tripped
// through the full codec (needsValueQuoting is private; a missing-quote bug
// would surface here as a type reinterpretation on decode, e.g. the string
// "42" coming back as the number 42).
// ---------------------------------------------------------------------------

const QUOTING_TRIGGER_VALUES: readonly string[] = [
  "", // empty
  " leading space",
  "trailing space ",
  "\tleading tab",
  "true",
  "false",
  "null",
  "42",
  "-3.14",
  "+1",
  "05",
  "1e-6",
  "has:colon",
  'has"quote',
  "has\\backslash",
  "has[bracket",
  "has]bracket",
  "has{brace",
  "has}brace",
  "has,comma",
  "-leading-hyphen",
  "#leading-hash",
  "plain unquoted string with spaces inside",
  "cjk 日本語 漢字テスト",
  "emoji 🎉🚀" + String.fromCodePoint(0x1f600),
  "newline\nin\nvalue",
  "cr\rin\rvalue",
  "tab\tin\tvalue",
  "control" + String.fromCharCode(1) + "char",
];

describe("toon-4.1 -- S7.2 quoting-trigger battery", () => {
  it.each(QUOTING_TRIGGER_VALUES)("round-trips %j as a string field value", (value) => {
    const payload = { v: 1, kind: "read.map", field: value };
    const text = toon41Codec.encode(payload);
    const decoded = toon41Codec.decode(text);
    expect(canonicalEqual(decoded, payload)).toBe(true);
    expect(typeof decoded["field"]).toBe("string");
  });

  it.each(QUOTING_TRIGGER_VALUES)("round-trips %j inside a tabular row cell", (value) => {
    const payload = {
      v: 1,
      kind: "search.matches",
      items: [
        { a: value, b: 1 },
        { a: "other", b: 2 },
      ],
    };
    const text = toon41Codec.encode(payload);
    const decoded = toon41Codec.decode(text);
    expect(canonicalEqual(decoded, payload)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Property (fuzz)
// ---------------------------------------------------------------------------

function randomKey(rng: Rng, salt: number): string {
  const letters = "abcdefghijklmnopqrstuvwxyz_";
  const len = int(rng, 1, 6);
  let out = "";
  for (let i = 0; i < len; i++) out += letters[int(rng, 0, letters.length - 1)];
  return `${out}_${salt}`;
}

/** Object body -- primitives, primitive arrays, uniform-primitive tabular
 *  arrays, and nested objects, recursively -- everything this codec's
 *  implemented subset covers. */
function randomToonObject(rng: Rng, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const fieldCount = int(rng, 1, 4);
  for (let i = 0; i < fieldCount; i++) {
    const key = randomKey(rng, i);
    out[key] = randomToonValue(rng, depth);
  }
  return out;
}

function randomToonValue(rng: Rng, depth: number): unknown {
  const choice = depth > 2 ? int(rng, 0, 2) : int(rng, 0, 5);
  switch (choice) {
    case 0:
      return randomScalar(rng);
    case 1: {
      // primitive array (inline form)
      const n = int(rng, 0, 5);
      return Array.from({ length: n }, () => randomScalar(rng));
    }
    case 2: {
      // nested object (possibly empty)
      if (rng() < 0.2) return {};
      return randomToonObject(rng, depth + 1);
    }
    case 3: {
      // uniform-primitive tabular array
      const cols = Array.from({ length: int(rng, 1, 3) }, (_, i) => randomKey(rng, 100 + i));
      const rows = int(rng, 1, 5);
      return Array.from({ length: rows }, () => {
        const row: Record<string, unknown> = {};
        for (const c of cols) row[c] = randomScalar(rng);
        return row;
      });
    }
    case 4:
      return randomString(rng, { maxLen: 24 });
    default:
      return randomToonObject(rng, depth + 1);
  }
}

describe("toon-4.1 encode/decode -- property (fuzz)", () => {
  const SEEDS = Array.from({ length: 40 }, (_, i) => i * 65599 + 17);
  it.each(SEEDS)("round-trips canonically for seed %i", (seed) => {
    const rng = mulberry32(seed);
    const payload = { v: 1, kind: "read.map", ...randomToonObject(rng, 0) };
    // canEncode is not guaranteed true here (a tabular column can randomly
    // fail uniformity), so gate the round-trip proof on it rather than assert it.
    if (!toon41Codec.canEncode("read.map", payload)) return;
    const text = toon41Codec.encode(payload);
    const decoded = toon41Codec.decode(text);
    expect(canonicalEqual(decoded, payload)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Structural coverage: nested objects, empty forms, inline arrays
// ---------------------------------------------------------------------------

describe("toon-4.1 -- structural forms", () => {
  it("round-trips deeply nested objects", () => {
    const payload = { v: 1, kind: "read.map", a: { b: { c: { d: { e: "deep" } } } } };
    const text = toon41Codec.encode(payload);
    expect(canonicalEqual(toon41Codec.decode(text), payload)).toBe(true);
  });

  it("round-trips an empty nested object", () => {
    const payload = { v: 1, kind: "read.map", empty: {} };
    const text = toon41Codec.encode(payload);
    expect(canonicalEqual(toon41Codec.decode(text), payload)).toBe(true);
  });

  it("round-trips an empty array", () => {
    const payload = { v: 1, kind: "read.map", items: [] };
    const text = toon41Codec.encode(payload);
    expect(text).toContain("items: []");
    expect(canonicalEqual(toon41Codec.decode(text), payload)).toBe(true);
  });

  it("round-trips a primitive inline array with mixed types", () => {
    const payload = { v: 1, kind: "read.map", vals: [1, "two", true, null, -3.5] };
    const text = toon41Codec.encode(payload);
    expect(canonicalEqual(toon41Codec.decode(text), payload)).toBe(true);
  });

  it("round-trips -0 and other numeric edge cases", () => {
    const payload = { v: 1, kind: "read.map", a: -0, b: 0, c: 1e-6, d: 1e21, e: -1.5, f: 1000000 };
    const text = toon41Codec.encode(payload);
    expect(canonicalEqual(toon41Codec.decode(text), payload)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// canEncode negatives -- the documented boundary of the implemented subset
// ---------------------------------------------------------------------------

describe("toon-4.1 -- canEncode negatives (implemented-subset boundary)", () => {
  it("returns false for a non-uniform array of objects (different key sets)", () => {
    const payload = { v: 1, kind: "search.matches", items: [{ a: 1 }, { b: 2 }] };
    expect(toon41Codec.canEncode("search.matches", payload)).toBe(false);
  });

  it("returns false for a tabular column that is not uniform-primitive (nested object value)", () => {
    const payload = {
      v: 1,
      kind: "search.matches",
      items: [
        { a: 1, b: { x: 1 } },
        { a: 2, b: { x: 2 } },
      ],
    };
    expect(toon41Codec.canEncode("search.matches", payload)).toBe(false);
  });

  it("returns false for an array of arrays", () => {
    const payload = { v: 1, kind: "read.map", pairs: [[1, 2], [3, 4]] };
    expect(toon41Codec.canEncode("read.map", payload)).toBe(false);
  });

  it("returns false for a mixed (non-uniform-typed) array", () => {
    const payload = { v: 1, kind: "read.map", items: [1, { a: 1 }, "text"] };
    expect(toon41Codec.canEncode("read.map", payload)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Malformed input -- decode must throw, never mis-parse
// ---------------------------------------------------------------------------

describe("toon-4.1 decode -- malformed input", () => {
  it("throws on an unterminated bracket segment", () => {
    expect(() => toon41Codec.decode("a[2: 1,2")).toThrow();
  });

  it("throws on an inline array count mismatch", () => {
    expect(() => toon41Codec.decode("a[3]: 1,2")).toThrow();
  });

  it("throws on a tabular row cell count mismatch", () => {
    const bad = ["a[1]{x,y}:", "  1"].join("\n");
    expect(() => toon41Codec.decode(bad)).toThrow();
  });

  it("throws on an unexpected indentation increase", () => {
    const bad = ["a: 1", "    b: 2"].join("\n");
    expect(() => toon41Codec.decode(bad)).toThrow();
  });

  it("throws on an invalid \\u escape", () => {
    const bad = 'a: "\\uZZZZ"';
    expect(() => toon41Codec.decode(bad)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Real shape, measured gain -- an all-primitive-column symbol search payload
// ---------------------------------------------------------------------------

describe("toon-4.1 -- real shape, measured gain", () => {
  it("produces fewer bytes than json for a 15-row all-primitive symbols payload", () => {
    const locations = Array.from({ length: 15 }, (_, i) => ({
      path: `packages/mcp-server/src/features/foo/bar${i}.ts`,
      line: 10 + i,
      symbol: `exportedFunction${i}`,
      kind: "function",
    }));
    const payload = { v: 1, kind: "search.matches", matches: { form: "symbols", locations, total: locations.length } };
    expect(toon41Codec.canEncode("search.matches", payload)).toBe(true);
    const jsonBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
    const text = toon41Codec.encode(payload);
    const codecBytes = Buffer.byteLength(text, "utf8");
    expect(canonicalEqual(toon41Codec.decode(text), payload)).toBe(true);
    expect(codecBytes).toBeLessThan(jsonBytes);
  });
});
