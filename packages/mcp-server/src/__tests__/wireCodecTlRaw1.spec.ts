// ---------------------------------------------------------------------------
// tl-raw-1 codec -- encode/decode property (fuzz) tests, the collision-
// checked delimiter derivation (exercised deterministically via dependency
// injection -- forcing a REAL SHA-256 collision to test against is
// intentionally infeasible), and malformed-input / negative canEncode
// coverage. See protocol/codec/tlRaw1.ts for the wire format.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { tlRaw1Codec, deriveDelimiterWith } from "../protocol/codec/tlRaw1.js";
import { canonicalEqual } from "../protocol/codec/types.js";
import {
  mulberry32, randomString, randomScalar, randomReadTextEvidencePayload, int,
} from "./helpers/wireCodecFuzz.js";

const NUL = String.fromCharCode(0);

/**
 * Parses just enough of an encoded tl-raw-1 text (the wire format
 * tlRaw1.ts's own `decode` reads: `MAGIC \n metaLen \n metaText \n
 * locatorLine \n ...`) to recover the field-selector line WITHOUT exporting
 * any internal function -- a JSON string means the top-level `field` key
 * won (`decodeLocation`'s `{at:"top",...}` branch), a JSON number means the
 * nested `evidence[index].body` won. Used to prove WHICH location a
 * "dominant body" contest picked, independent of total encoded length
 * (metaText still carries whatever did NOT get extracted, verbatim-escaped,
 * so text length alone does not say which field won).
 */
function locatorOf(text: string): string | number {
  const magicEnd = text.indexOf("\n");
  const metaLenEnd = text.indexOf("\n", magicEnd + 1);
  const metaLen = Number(text.slice(magicEnd + 1, metaLenEnd));
  const metaTextEnd = metaLenEnd + 1 + metaLen;
  const locatorEnd = text.indexOf("\n", metaTextEnd + 1);
  const locatorLine = text.slice(metaTextEnd + 1, locatorEnd);
  return JSON.parse(locatorLine) as string | number;
}

// ---------------------------------------------------------------------------
// Basic round-trip
// ---------------------------------------------------------------------------

describe("tl-raw-1 -- basic round-trip", () => {
  it("round-trips a payload with one dominant string field plus scalar metadata", () => {
    const payload = {
      v: 1,
      kind: "read.text",
      path: "src/foo.ts",
      sha: "abc123",
      text: "line one\nline two\nline three with \"quotes\" and \\backslashes\\\n",
    };
    expect(tlRaw1Codec.canEncode("read.text", payload)).toBe(true);
    const text = tlRaw1Codec.encode(payload);
    const decoded = tlRaw1Codec.decode(text);
    expect(canonicalEqual(decoded, payload)).toBe(true);
  });

  it("picks the LONGEST string field as the body when several exist", () => {
    const payload = { v: 1, kind: "read.text", short: "a", longer: "b".repeat(500) };
    const text = tlRaw1Codec.encode(payload);
    const decoded = tlRaw1Codec.decode(text);
    expect(canonicalEqual(decoded, payload)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Property (fuzz)
// ---------------------------------------------------------------------------

function randomPayload(seed: number): Record<string, unknown> {
  const rng = mulberry32(seed);
  const bodyLen = int(rng, 0, 400);
  const payload: Record<string, unknown> = {
    v: 1,
    kind: "read.text",
    body: randomString(rng, { minLen: bodyLen, maxLen: bodyLen, spiceRate: 0.4 }),
  };
  const extraCount = int(rng, 0, 4);
  for (let i = 0; i < extraCount; i++) payload[`field_${i}`] = randomScalar(rng);
  return payload;
}

describe("tl-raw-1 encode/decode -- property (fuzz)", () => {
  const SEEDS = Array.from({ length: 40 }, (_, i) => i * 104729 + 3);
  it.each(SEEDS)("round-trips canonically for seed %i", (seed) => {
    const payload = randomPayload(seed);
    expect(tlRaw1Codec.canEncode("read.text", payload)).toBe(true);
    const text = tlRaw1Codec.encode(payload);
    const decoded = tlRaw1Codec.decode(text);
    expect(canonicalEqual(decoded, payload)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// D1 (F-C2b) -- nested `evidence[i].body` support (read.text's real shape)
// ---------------------------------------------------------------------------

describe("tl-raw-1 -- D1 nested evidence body (read.text's real shape)", () => {
  it("round-trips a single-evidence read.text payload whose body lives at evidence[0].body", () => {
    const payload = {
      v: 1,
      kind: "read.text",
      evidence: [
        {
          handle: "tlh_abc123",
          path: "src/foo.ts",
          range: "1-40",
          body: "line one\nline two\nline three with \"quotes\" and \\backslashes\\\n",
        },
      ],
    };
    expect(tlRaw1Codec.canEncode("read.text", payload)).toBe(true);
    const text = tlRaw1Codec.encode(payload);
    expect(text.startsWith("TL1R")).toBe(true);
    const decoded = tlRaw1Codec.decode(text);
    expect(canonicalEqual(decoded, payload)).toBe(true);
  });

  it("locates the body among several evidence entries, leaving the others untouched", () => {
    const payload = {
      v: 1,
      kind: "read.text",
      evidence: [
        { handle: "tlh_a", path: "src/a.ts", range: "1-5", remaining: ["6-20"] },
        {
          handle: "tlh_b",
          path: "src/b.ts",
          range: "1-30",
          body: "the dominant body ".repeat(20),
        },
        { handle: "tlh_c", path: "src/c.ts", prior: "call-7" },
      ],
    };
    const text = tlRaw1Codec.encode(payload);
    const decoded = tlRaw1Codec.decode(text);
    expect(canonicalEqual(decoded, payload)).toBe(true);
    // The OTHER entries are byte-identical in the decoded result, not merely
    // canonically equal -- proves withoutBody/withBody never perturb a
    // sibling entry while relocating the one that does carry a body.
    expect((decoded["evidence"] as unknown[])[0]).toEqual(payload.evidence[0]);
    expect((decoded["evidence"] as unknown[])[2]).toEqual(payload.evidence[2]);
  });

  it("multiple body-bearing evidence entries are ineligible -- no single dominant body, even though both bodies dwarf every top-level field", () => {
    const payload = {
      v: 1,
      kind: "read.text", // the only top-level string -- 9 chars
      evidence: [
        { handle: "tlh_a", path: "src/a.ts", range: "1-5", body: "first body ".repeat(80) }, // ~880 chars
        { handle: "tlh_b", path: "src/b.ts", range: "1-5", body: "second body ".repeat(80) }, // ~960 chars
      ],
    };
    // singleEvidenceBodyIndex sees TWO body-bearing entries and returns
    // undefined (D1's "multi-body payloads stay ineligible" rule) -- neither
    // large body is ever a candidate, so locateDominantBody falls all the
    // way back to the only top-level string, "kind" (9 chars) -- proven
    // directly via the wire's own locator line, not by encoded length
    // (metaText still carries BOTH untouched, JSON-escaped bodies either
    // way, so the total text is long regardless of which field won).
    expect(tlRaw1Codec.canEncode("read.text", payload)).toBe(true); // "kind" is still a (useless) candidate
    const text = tlRaw1Codec.encode(payload);
    expect(locatorOf(text)).toBe("kind");
    const decoded = tlRaw1Codec.decode(text);
    expect(canonicalEqual(decoded, payload)).toBe(true);
    // This is exactly why V10-11's own selection layer (policy.ts /
    // selectV2.ts) never actually picks this candidate for the live wire:
    // it is bigger than the json it would replace (delimiter/magic overhead
    // wrapping a 9-char field, with both real bodies STILL fully present,
    // escaped, in metaText), so the practical effect is "falls back to
    // json" even though canEncode itself is technically true.
  });

  it("a genuinely bigger TOP-LEVEL field still wins over a small nested evidence body (the 'dominant' contract, not 'nested always wins')", () => {
    const payload = {
      v: 1,
      kind: "read.text",
      headings: "# Section\n".repeat(60), // long top-level KEPT_ON_TEXT field
      evidence: [{ handle: "tlh_a", path: "src/a.ts", range: "1-2", body: "hi" }],
    };
    const text = tlRaw1Codec.encode(payload);
    // Encoded body is the LONGER headings string, not "hi" at evidence[0].
    expect(locatorOf(text)).toBe("headings");
    const decoded = tlRaw1Codec.decode(text);
    expect(canonicalEqual(decoded, payload)).toBe(true);
  });

  it("the nested rule is read.text-ONLY -- an evidence-shaped payload under a different kind is not considered", () => {
    const payload = {
      v: 1,
      kind: "read.batch", // NOT read.text
      evidence: [{ handle: "tlh_a", path: "src/a.ts", range: "1-2", body: "x".repeat(300) }],
    };
    // "kind" itself ("read.batch", 10 chars) is the only top-level string;
    // the 300-char nested body is never considered for a non-read.text kind.
    const text = tlRaw1Codec.encode(payload);
    expect(locatorOf(text)).toBe("kind");
    const decoded = tlRaw1Codec.decode(text);
    expect(canonicalEqual(decoded, payload)).toBe(true);
  });

  it("decode fails closed (never mis-parses) when the located evidence index is out of range", () => {
    // A hand-crafted wire text whose field-selector line names evidence
    // index 5 against a meta with only one evidence entry.
    const meta = { v: 1, kind: "read.text", evidence: [{ handle: "tlh_a", path: "src/a.ts", range: "1-2" }] };
    const metaText = JSON.stringify(meta);
    const delimiter = `${NUL}TLRAW:deadbeef${NUL}`;
    const bad = ["TL1R", String(metaText.length), metaText, "5", delimiter, "body text", delimiter].join("\n");
    expect(() => tlRaw1Codec.decode(bad)).toThrow();
  });

  it("decode fails closed when the located evidence entry is not an object", () => {
    const meta = { v: 1, kind: "read.text", evidence: ["not-an-object"] };
    const metaText = JSON.stringify(meta);
    const delimiter = `${NUL}TLRAW:deadbeef${NUL}`;
    const bad = ["TL1R", String(metaText.length), metaText, "0", delimiter, "body text", delimiter].join("\n");
    expect(() => tlRaw1Codec.decode(bad)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// D1 (F-C2b) -- nested evidence body, property (fuzz)
// ---------------------------------------------------------------------------

describe("tl-raw-1 nested evidence body -- property (fuzz)", () => {
  const SEEDS = Array.from({ length: 40 }, (_, i) => i * 65537 + 11);
  it.each(SEEDS)("round-trips a random read.text/evidence[].body payload for seed %i", (seed) => {
    const rng = mulberry32(seed);
    const payload = randomReadTextEvidencePayload(rng, { maxBodyLen: 500, spiceRate: 0.5 });
    const text = tlRaw1Codec.encode(payload);
    const decoded = tlRaw1Codec.decode(text);
    expect(canonicalEqual(decoded, payload)).toBe(true);
  });

  it.each(SEEDS.slice(0, 15))("round-trips escape-heavy CJK/emoji bodies for seed %i", (seed) => {
    const rng = mulberry32(seed);
    const payload = randomReadTextEvidencePayload(rng, {
      minBodyLen: 200, maxBodyLen: 1200, spiceRate: 0.85, evidenceCount: int(rng, 1, 4),
    });
    expect(tlRaw1Codec.canEncode("read.text", payload)).toBe(true);
    const text = tlRaw1Codec.encode(payload);
    const decoded = tlRaw1Codec.decode(text);
    expect(canonicalEqual(decoded, payload)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Delimiter derivation -- collision check, proven by dependency injection
// ---------------------------------------------------------------------------

describe("tl-raw-1 -- collision-checked delimiter derivation", () => {
  it("retries when the digest-derived candidate already collides, and returns one that does not", () => {
    // A fake digest whose FIRST call always returns "CNT0", exactly like a
    // fresh instance would; deliberately embedding that candidate in the
    // body forces attempt 0 to collide.
    const candidate0 = `${NUL}TLRAW:CNT0${NUL}`;
    const body = `before ${candidate0} after`;
    let n = 0;
    const countingDigest = (): string => `CNT${n++}`;

    const delimiter = deriveDelimiterWith(body, countingDigest);

    expect(delimiter).toBe(`${NUL}TLRAW:CNT1${NUL}`);
    expect(body.includes(delimiter)).toBe(false);
    expect(n).toBe(2); // attempt 0 (collided) + attempt 1 (accepted)
  });

  it("succeeds on the first attempt when there is no collision", () => {
    const body = "ordinary body with no special substrings";
    let calls = 0;
    const digest = (): string => {
      calls += 1;
      return "deadbeefcafefeed";
    };
    const delimiter = deriveDelimiterWith(body, digest);
    expect(calls).toBe(1);
    expect(body.includes(delimiter)).toBe(false);
  });

  it("throws (fail-closed) when every attempt collides", () => {
    const constantDigest = (): string => "always-the-same";
    const body = `x ${NUL}TLRAW:always-the-same${NUL} y`;
    expect(() => deriveDelimiterWith(body, constantDigest)).toThrow();
  });

  it("the real (production) delimiter never appears in an adversarial NUL/marker-heavy body", () => {
    const adversarial =
      NUL.repeat(20) + "TLRAW:".repeat(50) + NUL + "0123456789abcdef".repeat(30) + NUL.repeat(10);
    const payload = { v: 1, kind: "read.text", body: adversarial };
    const text = tlRaw1Codec.encode(payload);
    const decoded = tlRaw1Codec.decode(text);
    expect(canonicalEqual(decoded, payload)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// canEncode negatives
// ---------------------------------------------------------------------------

describe("tl-raw-1 -- canEncode negatives", () => {
  // A real protocol response always carries `kind` as a string, so this is a
  // synthetic exercise of locateDominantBody's top-level scan (no string
  // field at all, and no `evidence` array either), not a shape any live
  // payload actually has.
  it("returns false for a payload with no string-valued field anywhere", () => {
    const payload = { v: 1, count: 3, ok: true, nested: { x: 1, y: [1, 2, 3] } };
    expect(tlRaw1Codec.canEncode("read.map", payload)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Malformed input -- decode must throw, never mis-parse
// ---------------------------------------------------------------------------

describe("tl-raw-1 decode -- malformed input", () => {
  it("throws on bad magic", () => {
    expect(() => tlRaw1Codec.decode("NOTAMAGIC\n")).toThrow();
  });

  it("throws on a truncated meta section", () => {
    const bad = ["TL1R", "100", "short"].join("\n") + "\n";
    expect(() => tlRaw1Codec.decode(bad)).toThrow();
  });

  it("throws when the closing delimiter is missing", () => {
    const meta = JSON.stringify({ v: 1, kind: "read.text" });
    const bad = ["TL1R", String(meta.length), meta, '"body"', "SOME-DELIM", "the body text"].join("\n");
    expect(() => tlRaw1Codec.decode(bad)).toThrow();
  });
});
