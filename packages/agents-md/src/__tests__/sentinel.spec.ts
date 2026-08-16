// Tests for packages/agents-md/src/sentinel.ts
// Covers: parseSentinelBlock, round-trip, malformed rejection, version/sha extraction.

import { describe, it, expect } from "vitest";
import {
  parseSentinelBlock,
  findManagedRange,
  extractVersion,
  extractSha256,
  detectEol,
  sha256hex,
  countSentinels,
  SENTINEL_START,
  SENTINEL_END,
} from "../sentinel.js";

const GOOD_BLOCK = [
  SENTINEL_START,
  "<!-- tl-instructions-version: 2026-06-25-cheap -->",
  "<!-- tl-instructions-sha256: " + "a".repeat(64) + " -->",
  "## TokenLighten MCP",
  "body text here",
  SENTINEL_END,
].join("\n");

describe("detectEol", () => {
  it("returns LF for pure LF text", () => {
    expect(detectEol("hello\nworld\n")).toBe("\n");
  });

  it("returns CRLF for pure CRLF text", () => {
    expect(detectEol("hello\r\nworld\r\n")).toBe("\r\n");
  });

  it("returns LF for empty string", () => {
    expect(detectEol("")).toBe("\n");
  });
});

describe("sha256hex", () => {
  it("produces a 64-char hex string", () => {
    const h = sha256hex("hello");
    expect(h).toHaveLength(64);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic", () => {
    expect(sha256hex("abc")).toBe(sha256hex("abc"));
  });

  it("differs for different inputs", () => {
    expect(sha256hex("abc")).not.toBe(sha256hex("xyz"));
  });
});

describe("countSentinels", () => {
  it("counts 0/0 for empty text", () => {
    expect(countSentinels("")).toEqual({ starts: 0, ends: 0 });
  });

  it("counts 1/1 for a complete block", () => {
    expect(countSentinels(GOOD_BLOCK)).toEqual({ starts: 1, ends: 1 });
  });

  it("counts 1/0 for a broken block (start only)", () => {
    const broken = `# Header\n${SENTINEL_START}\n## body`;
    expect(countSentinels(broken)).toEqual({ starts: 1, ends: 0 });
  });

  it("counts 2/2 for duplicate blocks", () => {
    const dup = GOOD_BLOCK + "\n\n" + GOOD_BLOCK;
    expect(countSentinels(dup)).toEqual({ starts: 2, ends: 2 });
  });
});

describe("findManagedRange", () => {
  it("finds a complete block", () => {
    const text = `# Header\n\n${GOOD_BLOCK}\n\nfooter`;
    const range = findManagedRange(text);
    expect(range).not.toBeUndefined();
    expect(range!.start).toBeGreaterThan(0);
    expect(range!.end).toBeLessThanOrEqual(text.length);
  });

  it("returns undefined for text with no block", () => {
    expect(findManagedRange("just some text")).toBeUndefined();
  });

  it("returns undefined when only start sentinel is present", () => {
    expect(findManagedRange(`${SENTINEL_START}\nbody without end`)).toBeUndefined();
  });
});

describe("extractVersion", () => {
  it("extracts the version from a block", () => {
    expect(extractVersion(GOOD_BLOCK)).toBe("2026-06-25-cheap");
  });

  it("returns undefined when version line is absent", () => {
    expect(extractVersion("no version here")).toBeUndefined();
  });
});

describe("extractSha256", () => {
  it("extracts a 64-char sha from a block", () => {
    const sha = extractSha256(GOOD_BLOCK);
    expect(sha).toHaveLength(64);
    expect(sha).toBe("a".repeat(64));
  });

  it("returns undefined for proto-compat blocks without hash line", () => {
    const protoBlock = [
      SENTINEL_START,
      "<!-- tl-instructions-version: 2026-06-20-old -->",
      "body",
      SENTINEL_END,
    ].join("\n");
    expect(extractSha256(protoBlock)).toBeUndefined();
  });
});

describe("parseSentinelBlock", () => {
  it("parses a well-formed block (happy path)", () => {
    const text = `# Header\n\n${GOOD_BLOCK}\n`;
    const result = parseSentinelBlock(text);
    expect(result.block).not.toBeUndefined();
    expect(result.block!.version).toBe("2026-06-25-cheap");
    expect(result.block!.sha256).toBe("a".repeat(64));
    expect(result.hasBom).toBe(false);
    expect(result.eol).toBe("\n");
  });

  it("normalises CRLF and reports eol as CRLF", () => {
    const crlf = GOOD_BLOCK.replace(/\n/g, "\r\n");
    const result = parseSentinelBlock(crlf);
    expect(result.eol).toBe("\r\n");
    expect(result.block).not.toBeUndefined();
    // Normalised text should use LF internally
    expect(result.normalised).not.toContain("\r");
  });

  it("strips BOM and reports hasBom = true", () => {
    const withBom = "﻿" + GOOD_BLOCK;
    const result = parseSentinelBlock(withBom);
    expect(result.hasBom).toBe(true);
    expect(result.block).not.toBeUndefined();
  });

  it("returns block=undefined for text with no sentinels", () => {
    const result = parseSentinelBlock("# Just a header\n\nsome text");
    expect(result.block).toBeUndefined();
  });

  it("throws for duplicate blocks", () => {
    const dup = GOOD_BLOCK + "\n\n" + GOOD_BLOCK;
    expect(() => parseSentinelBlock(dup)).toThrow(/malformed sentinels/);
  });

  it("throws for start without end", () => {
    const broken = `${SENTINEL_START}\n## orphan start`;
    // countSentinels sees 1/0 → malformed
    // Note: parseSentinelBlock checks starts !== ends via countSentinels
    expect(() => parseSentinelBlock(broken)).toThrow(/malformed sentinels/);
  });

  it("round-trips: parse(text).normalised re-parses identically", () => {
    const text = `# Header\n\n${GOOD_BLOCK}\n`;
    const r1 = parseSentinelBlock(text);
    const r2 = parseSentinelBlock(r1.normalised);
    expect(r2.block?.version).toBe(r1.block?.version);
    expect(r2.block?.sha256).toBe(r1.block?.sha256);
    expect(r2.normalised).toBe(r1.normalised);
  });
});

// 2026-07-12b2: extractBodyForHash's version-line pattern was `[^-]*-->`,
// which can never match a hyphenated version string — the version line was
// silently hashed into every block sha, so a version bump alone changed the
// sha despite the documented "stable regardless of version bump" contract.
// blockSha256(locale, version) exposes exactly that contract.
describe("blockSha256 — version-independence contract", () => {
  it("identical prose under two different version strings hashes identically", async () => {
    const { blockSha256 } = await import("../render.js");
    const a = blockSha256("en", "2026-01-01-vaa-alpha");
    const b = blockSha256("en", "2026-12-31-vzz-omega");
    expect(a).toBe(b);
  });

  it("jp locale honours the same contract", async () => {
    const { blockSha256 } = await import("../render.js");
    expect(blockSha256("jp", "2026-01-01-vaa-alpha")).toBe(blockSha256("jp", "2026-12-31-vzz-omega"));
  });
});
