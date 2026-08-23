// ---------------------------------------------------------------------------
// tl-table-1 codec -- escaping unit tests, encode/decode property (fuzz)
// tests over generated payloads (CJK, emoji, control chars, newlines-in-
// cells, delimiter-collision bodies), positional (columns+rows) shape, and
// malformed-input / negative canEncode coverage. See protocol/codec/
// tlTable1.ts for the wire format this exercises.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { escapeCell, unescapeCell, tlTable1Codec } from "../protocol/codec/tlTable1.js";
import { canonicalEqual } from "../protocol/codec/types.js";
import { mulberry32, randomString, randomScalar, int, type Rng } from "./helpers/wireCodecFuzz.js";

// ---------------------------------------------------------------------------
// Escaping -- explicit CJK / emoji / control-char / newline coverage
// ---------------------------------------------------------------------------

const ESCAPE_CASES: readonly string[] = [
  "",
  "plain",
  "back\\slash",
  "tab\there",
  "newline\nhere",
  "cr\rhere",
  'quote"here',
  "control" + String.fromCharCode(1),
  "unit-sep" + String.fromCharCode(0x1f),
  "del" + String.fromCharCode(0x7f),
  "cjk 日本語 漢字テスト",
  "emoji 🎉🚀" + String.fromCodePoint(0x1f600),
  "mixed\t\n\\\"" + String.fromCharCode(2) + "end",
  "only-tabs\t\t\t",
  "only-newlines\n\n\n",
];

describe("tl-table-1 escapeCell/unescapeCell", () => {
  it.each(ESCAPE_CASES)("round-trips %j", (s) => {
    expect(unescapeCell(escapeCell(s))).toBe(s);
  });

  it("never leaves a raw TAB or LF in escaped output (so raw-delimiter split is always safe)", () => {
    for (const s of ESCAPE_CASES) {
      const esc = escapeCell(s);
      expect(esc.includes("\t")).toBe(false);
      expect(esc.includes("\n")).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Property (fuzz): encode -> decode -> canonical equality
// ---------------------------------------------------------------------------

function randomKey(rng: Rng, salt: number): string {
  const letters = "abcdefghijklmnopqrstuvwxyz_";
  const len = int(rng, 1, 6);
  let out = "";
  for (let i = 0; i < len; i++) out += letters[int(rng, 0, letters.length - 1)];
  return `${out}_${salt}`;
}

function randomRowValue(rng: Rng): unknown {
  switch (int(rng, 0, 5)) {
    case 0:
    case 1:
      return randomScalar(rng);
    case 2:
      return [randomScalar(rng), randomScalar(rng), randomScalar(rng)];
    case 3:
      return { nested: randomScalar(rng) };
    case 4:
      return [];
    default:
      return randomString(rng, { maxLen: 20 });
  }
}

function randomObjectArrayPayload(rng: Rng): Record<string, unknown> {
  const keyCount = int(rng, 1, 5);
  const keys: string[] = [];
  for (let i = 0; i < keyCount; i++) keys.push(randomKey(rng, i));
  const rowCount = int(rng, 1, 8);
  const rows: Record<string, unknown>[] = [];
  for (let r = 0; r < rowCount; r++) {
    const row: Record<string, unknown> = {};
    for (const k of keys) {
      if (rng() < 0.15) continue; // occasionally omit -- exercises the "U" tag
      row[k] = randomRowValue(rng);
    }
    if (Object.keys(row).length === 0) row[keys[0]!] = randomScalar(rng);
    rows.push(row);
  }
  return {
    v: 1,
    kind: "search.matches",
    items: rows,
    trailer: randomString(rng, { maxLen: 10 }),
  };
}

describe("tl-table-1 encode/decode -- property (fuzz)", () => {
  const SEEDS = Array.from({ length: 40 }, (_, i) => i * 7919 + 13);
  it.each(SEEDS)("round-trips canonically for seed %i", (seed) => {
    const rng = mulberry32(seed);
    const payload = randomObjectArrayPayload(rng);
    expect(tlTable1Codec.canEncode("search.matches", payload)).toBe(true);
    const text = tlTable1Codec.encode(payload);
    const decoded = tlTable1Codec.decode(text);
    expect(canonicalEqual(decoded, payload)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Positional (columns+rows) shape -- read.artifact's xlsx.table/csv forms
// ---------------------------------------------------------------------------

describe("tl-table-1 -- positional (columns+rows) shape", () => {
  it("round-trips a read.artifact-shaped columns/rows table", () => {
    const payload = {
      v: 1,
      kind: "read.artifact",
      content: {
        form: "xlsx.table",
        sheet: "Sheet1",
        range: "A1:C3",
        columns: ["a", "b", "c"],
        rows: [
          [1, "x", true],
          [2, "y", false],
          [3, null, "z 日本語"],
        ],
      },
    };
    expect(tlTable1Codec.canEncode("read.artifact", payload)).toBe(true);
    const text = tlTable1Codec.encode(payload);
    const decoded = tlTable1Codec.decode(text);
    expect(canonicalEqual(decoded, payload)).toBe(true);
  });

  it("leaves a non-matching rows length as literal JSON (does not misfire)", () => {
    const payload = {
      v: 1,
      kind: "read.artifact",
      content: { form: "xlsx.table", columns: ["a", "b"], rows: [[1, 2], [1]] },
    };
    // 0 qualifying blocks anywhere -> canEncode is false; nothing to prove.
    expect(tlTable1Codec.canEncode("read.artifact", payload)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Delimiter-collision-shaped bodies
// ---------------------------------------------------------------------------

describe("tl-table-1 -- delimiter-collision-shaped bodies", () => {
  it("round-trips cells that are pure tabs and pure newlines", () => {
    const payload = {
      v: 1,
      kind: "search.matches",
      items: [
        { a: "\t\t\t", b: "\n\n\n" },
        { a: "x\ty", b: "p\nq" },
        { a: "\\t looks like tab but is not", b: "\\n looks like newline but is not" },
      ],
    };
    const text = tlTable1Codec.encode(payload);
    const decoded = tlTable1Codec.decode(text);
    expect(canonicalEqual(decoded, payload)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// canEncode negatives
// ---------------------------------------------------------------------------

describe("tl-table-1 -- canEncode negatives", () => {
  it("returns false when no qualifying array exists anywhere", () => {
    const payload = { v: 1, kind: "read.receipt", receipt: { receipt: "pack-unchanged" } };
    expect(tlTable1Codec.canEncode("read.receipt", payload)).toBe(false);
  });

  it("returns false for an array of empty objects", () => {
    const payload = { v: 1, kind: "search.matches", items: [{}, {}] };
    expect(tlTable1Codec.canEncode("search.matches", payload)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Malformed input -- decode must throw, never mis-parse
// ---------------------------------------------------------------------------

describe("tl-table-1 decode -- malformed input", () => {
  it("throws on bad magic", () => {
    expect(() => tlTable1Codec.decode("NOTAMAGIC\n")).toThrow();
  });

  it("throws on a truncated skeleton", () => {
    const bad = ["TL1T", "100", "short"].join("\n") + "\n";
    expect(() => tlTable1Codec.decode(bad)).toThrow();
  });

  it("throws on a row/column count mismatch", () => {
    const bad = ["TL1T", "2", "{}", "1", "O", "a\tb", "1", "Sx"].join("\n") + "\n";
    expect(() => tlTable1Codec.decode(bad)).toThrow();
  });

  it("throws on an unknown cell tag reachable through the skeleton", () => {
    // The skeleton MUST reference the block via its placeholder -- a block
    // decoded but never reinserted is dead data, not a decode-time defect.
    const skeleton = JSON.stringify({ items: { $tlTable: 0 } });
    const bad = ["TL1T", String(skeleton.length), skeleton, "1", "O", "a", "1", "Qbad"].join("\n") + "\n";
    expect(() => tlTable1Codec.decode(bad)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Real shape, measured gain -- a realistic search.matches payload
// ---------------------------------------------------------------------------

describe("tl-table-1 -- real shape, measured gain", () => {
  it("produces fewer bytes than json for a realistic 12-row search.matches payload", () => {
    const files = Array.from({ length: 12 }, (_, i) => ({
      path: `packages/mcp-server/src/features/foo/bar${i}.ts`,
      lines: [10 + i, 20 + i, 30 + i],
      snippets: [`const x${i} = 1;`, `return x${i};`, `// note ${i}`],
      match_count: 3,
    }));
    const payload = {
      v: 1,
      kind: "search.matches",
      matches: {
        form: "find",
        query: "x",
        files,
        total_files: files.length,
        total_matches: files.length * 3,
        literal: true,
      },
    };
    const jsonBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
    expect(tlTable1Codec.canEncode("search.matches", payload)).toBe(true);
    const text = tlTable1Codec.encode(payload);
    const codecBytes = Buffer.byteLength(text, "utf8");
    const decoded = tlTable1Codec.decode(text);
    expect(canonicalEqual(decoded, payload)).toBe(true);
    expect(codecBytes).toBeLessThan(jsonBytes);
  });
});
