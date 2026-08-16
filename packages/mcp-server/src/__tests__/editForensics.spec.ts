/**
 * editForensics.spec.ts — search-not-found forensics (2026-07-26).
 * Pinned by the T09 R2 escape chain: an edit_file not-found with no evidence
 * of the range's actual bytes sent the solver into 4 native turns of
 * `cat -A`/`od -c` whitespace archaeology. The error must carry the closest
 * region verbatim so tab/space drift is visible in the response itself.
 */
import { describe, expect, it } from "vitest";
import { nearestMatchForensics, outOfRangeAnchor } from "../write/editForensics.js";

describe("nearestMatchForensics", () => {
  it("locates a whitespace-drifted region by normalized first-line anchor", () => {
    const segment = [
      "const byPriority: Record<string, number> = {", // spaces here...
      "\tCRITICAL: 0,", // ...but tabs in the body (the live T09 drift)
      "\tHIGH: 1,",
      "};",
    ].join("\n");
    // The solver's search used 4-space indentation.
    const search = "const byPriority: Record<string, number> = {\n    CRITICAL: 0,\n    HIGH: 1,\n};";
    const info = nearestMatchForensics(segment, search, 170);
    expect(info.nearest_match).toBeDefined();
    expect(info.actual).toBeUndefined();
    expect(info.nearest_match!.range).toBe("170-173");
    // Verbatim bytes: the tab characters must survive into the payload.
    expect(info.nearest_match!.code).toContain("\tCRITICAL: 0,");
    expect(info.nearest_match!.note).toContain("4/4");
  });

  it("falls back to the scope head when the first line has no normalized match", () => {
    const segment = ["alpha();", "beta();", "gamma();"].join("\n");
    const info = nearestMatchForensics(segment, "completelyAbsent();", 10);
    expect(info.nearest_match).toBeUndefined();
    expect(info.actual).toBeDefined();
    expect(info.actual!.range).toBe("10-12");
    expect(info.actual!.code).toBe("alpha();\nbeta();\ngamma();");
  });

  it("caps payloads on a line boundary and never throws on empty scopes", () => {
    const longLine = "x".repeat(400);
    const segment = Array.from({ length: 10 }, () => longLine).join("\n");
    const info = nearestMatchForensics(segment, `${longLine}\nnope`, 1);
    expect(info.nearest_match).toBeDefined();
    expect(Buffer.byteLength(info.nearest_match!.code, "utf8")).toBeLessThanOrEqual(1200);
    expect(nearestMatchForensics("", "anything", 1)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// P4.2 (2026-08-02 T13 rep1-a idx 70→71): an edits[] item against a handle
// bound to lines 199-259 whose search text actually lives near L118 got the
// scope-head `actual` fallback — TRUE for the searched segment, and useless.
// The solver paid a full re-read of 1-198 plus a fresh handle, deterministically,
// once per occurrence. The anchor's REAL location is one bounded pass away.
// ---------------------------------------------------------------------------
describe("outOfRangeAnchor — whole-file locator for a range-scoped miss", () => {
  const FILE = [
    ...Array.from({ length: 117 }, (_, i) => `// header line ${i + 1}`),   // L1-117
    "# Wire buffer large enough for any single encoded frame",              // L118
    "TX_BUF_CAP = HEADER + MAX_PAYLOAD + CRC",                              // L119
    ...Array.from({ length: 79 }, (_, i) => `// filler ${i + 1}`),          // L120-198
    ...Array.from({ length: 61 }, (_, i) => `// bound-range body ${i + 1}`),// L199-259
  ].join("\n");
  const SEARCH = "# Wire buffer large enough for any single encoded frame\nTX_BUF_CAP = HEADER + MAX_PAYLOAD + CRC\n";

  it("P4.2a a range-scoped miss whose anchor lives elsewhere reports the real location", () => {
    const info = outOfRangeAnchor(FILE, SEARCH, 199, 259);
    expect(info.nearest_match).toBeDefined();
    expect(info.nearest_match!.out_of_range).toBe(true);
    expect(info.nearest_match!.range).toBe("118-119");
    expect(info.nearest_match!.code).toContain("TX_BUF_CAP = HEADER + MAX_PAYLOAD + CRC");
    // The note must name BOTH the real location and the range the handle is
    // bound to — that pair is what removes the re-read.
    expect(info.nearest_match!.note).toContain("118-119");
    expect(info.nearest_match!.note).toContain("199-259");
  });

  it("P4.2b an ambiguous file-wide anchor returns no relocation", () => {
    const ambiguous = [
      "# Wire buffer large enough for any single encoded frame",
      "TX_BUF_CAP = HEADER + MAX_PAYLOAD + CRC",
      ...Array.from({ length: 40 }, (_, i) => `// filler ${i + 1}`),
      "# Wire buffer large enough for any single encoded frame",
      "TX_BUF_CAP = HEADER + MAX_PAYLOAD + CRC",
      ...Array.from({ length: 40 }, (_, i) => `// tail ${i + 1}`),
    ].join("\n");
    // Ambiguous relocation is worse than none.
    expect(outOfRangeAnchor(ambiguous, SEARCH, 60, 84)).toEqual({});
  });

  it("P4.2c an anchor absent file-wide keeps today's scope-head fallback", () => {
    const absent = Array.from({ length: 40 }, (_, i) => `// nothing ${i + 1}`).join("\n");
    expect(outOfRangeAnchor(absent, SEARCH, 10, 20)).toEqual({});
    // The existing fallback is untouched and still fires for the segment.
    const info = nearestMatchForensics(["alpha();", "beta();"].join("\n"), "completelyAbsent();", 10);
    expect(info.actual!.note).toBe(
      "scope head — the search's first line has no whitespace-normalized match here; compare content before retrying",
    );
  });

  it("P4.2d the locator is bounded", () => {
    const longLine = "y".repeat(400);
    const big = [
      ...Array.from({ length: 20 }, () => "// pad"),
      longLine,
      ...Array.from({ length: 20 }, () => longLine.replace("y", "z")),
      ...Array.from({ length: 20 }, () => "// tail"),
    ].join("\n");
    const info = outOfRangeAnchor(big, `${longLine}\n${longLine.replace("y", "z")}\n`, 55, 61);
    if (info.nearest_match) {
      expect(Buffer.byteLength(info.nearest_match.code, "utf8")).toBeLessThanOrEqual(1200);
    }
    // Never throws on degenerate inputs.
    expect(outOfRangeAnchor("", "anything", 1, 2)).toEqual({});
    expect(outOfRangeAnchor("a\nb\n", "", 1, 2)).toEqual({});
  });
});
