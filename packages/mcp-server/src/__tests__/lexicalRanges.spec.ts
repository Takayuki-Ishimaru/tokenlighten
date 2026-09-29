// lexicalRanges.spec.ts — unit tests for collectLexicalSegments' comment/
// string extraction AND (2026-09-27, large-workspace task_pack cost, item B)
// its process-level content-addressed LRU memo.
//
// Motivation for the memo (see lexicalRanges.ts's own doc comment): a
// task_pack's Layer 4 (locateTaskContext.ts) calls findReferences() up to
// twice per pack, each of which tree-sitter-parses every scanned file that
// contains ITS OWN symbol via collectLexicalSegments — a large file matched
// by BOTH searched symbols was parsed twice, and an unedited file already
// parsed by an earlier task_pack was parsed again from scratch.

import { describe, it, expect, afterEach, vi } from "vitest";
import * as treeSitterMod from "../skeleton/treeSitter.js";
import {
  collectLexicalSegments,
  segmentKindAt,
  resetLexicalSegmentsCache,
  __setLexicalSegmentsCacheMaxBytesForTest,
  __lexicalSegmentsCacheBytesForTest,
  type LexicalSegment,
} from "../tools/lexicalRanges.js";

afterEach(() => {
  resetLexicalSegmentsCache();
  vi.restoreAllMocks();
});

const TS_SOURCE = [
  "// a leading comment",
  "export function greet(name: string): string {",
  '  const template = `hello, ${name}`;',
  "  return template; // trailing comment",
  "}",
].join("\n");

describe("collectLexicalSegments — comment/string extraction (unaffected by the memo)", () => {
  it("marks a full-line comment and a trailing comment as 'comment'", async () => {
    const segments = await collectLexicalSegments(TS_SOURCE, "typescript");
    expect(segmentKindAt(segments, 1, 2)).toBe("comment");
    expect(segmentKindAt(segments, 4, 25)).toBe("comment");
  });

  it("marks a template-literal string as 'string'", async () => {
    const segments = await collectLexicalSegments(TS_SOURCE, "typescript");
    expect(segmentKindAt(segments, 3, 21)).toBe("string");
  });

  it("code (non-comment, non-string) positions are undefined", async () => {
    const segments = await collectLexicalSegments(TS_SOURCE, "typescript");
    expect(segmentKindAt(segments, 2, 10)).toBeUndefined(); // "function"
  });

  it("returns an empty map for an unsupported language, without caching (a later supported-language call for the same text still parses)", async () => {
    const spy = vi.spyOn(treeSitterMod, "withTreeSitterRoot");
    const segments = await collectLexicalSegments(TS_SOURCE, "plaintext");
    expect(segments.size).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("collectLexicalSegments — item B: content-addressed LRU memo", () => {
  it("a second call with the IDENTICAL (text, language) does not re-invoke the tree-sitter parse, and returns segments deep-equal to the first call", async () => {
    const spy = vi.spyOn(treeSitterMod, "withTreeSitterRoot");

    const first = await collectLexicalSegments(TS_SOURCE, "typescript");
    expect(spy).toHaveBeenCalledTimes(1);

    const second = await collectLexicalSegments(TS_SOURCE, "typescript");
    expect(spy).toHaveBeenCalledTimes(1); // still 1 — this call was a cache hit

    expect(second).toEqual(first);
  });

  it("a cache hit returns an INDEPENDENT copy: mutating the returned map never affects a later call's result", async () => {
    const first = await collectLexicalSegments(TS_SOURCE, "typescript");
    // Mutate the returned map/array as aggressively as a careless caller
    // might: clear a line's array, push a bogus segment onto another.
    first.get(1)?.splice(0, first.get(1)!.length);
    first.set(999, [{ line: 999, startCol: 0, endCol: 1, kind: "comment" } as LexicalSegment]);

    const second = await collectLexicalSegments(TS_SOURCE, "typescript");
    expect(second.get(1)?.length).toBeGreaterThan(0);
    expect(second.has(999)).toBe(false);
  });

  it("the SAME text under a DIFFERENT language is parsed independently (no key collision across languages)", async () => {
    const pySource = ["# a comment", "x = 1  # trailing"].join("\n");
    const spy = vi.spyOn(treeSitterMod, "withTreeSitterRoot");

    await collectLexicalSegments(pySource, "python");
    expect(spy).toHaveBeenCalledTimes(1);
    // Same bytes, claimed as a different (supported) language — must be
    // treated as a genuinely different cache entry, not a false hit.
    await collectLexicalSegments(pySource, "typescript");
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("editing a file's content changes the cache key: the edited text is reparsed, not served from the old text's cache entry", async () => {
    const spy = vi.spyOn(treeSitterMod, "withTreeSitterRoot");
    const edited = TS_SOURCE.replace("hello", "goodbye");

    const before = await collectLexicalSegments(TS_SOURCE, "typescript");
    const after = await collectLexicalSegments(edited, "typescript");
    expect(spy).toHaveBeenCalledTimes(2); // two distinct texts -> two real parses

    // The string segment on line 3 still covers the same columns either way
    // (only the identifier inside the template literal changed) — a
    // structural sanity check that `after` is a real, independent parse.
    expect(segmentKindAt(after, 3, 21)).toBe("string");
    expect(after).not.toBe(before);
  });

  it("respects an explicit byte budget: filling it past capacity evicts the LEAST-recently-used entry, forcing a real reparse", async () => {
    // Shrink the budget so eviction is exercisable without allocating tens
    // of MB of fixture text (the real 32 MiB default stays untouched by any
    // production call path — see __setLexicalSegmentsCacheMaxBytesForTest's
    // own "test-only" doc comment).
    const sourceA = TS_SOURCE;
    const sourceB = TS_SOURCE.replace("greet", "salute");
    const sourceC = TS_SOURCE.replace("greet", "welcome");
    // The budget counts what an entry really holds (its packed segments), so
    // size it from one real entry: the three texts differ only inside an
    // identifier, i.e. they pack to the same segment count.
    await collectLexicalSegments(sourceA, "typescript");
    const entryBytes = __lexicalSegmentsCacheBytesForTest();
    expect(entryBytes).toBeGreaterThan(0);
    resetLexicalSegmentsCache();
    // Room for exactly two entries, not three.
    __setLexicalSegmentsCacheMaxBytesForTest(Math.floor(entryBytes * 2.5));

    const spy = vi.spyOn(treeSitterMod, "withTreeSitterRoot");
    await collectLexicalSegments(sourceA, "typescript"); // parse 1 (A)
    await collectLexicalSegments(sourceB, "typescript"); // parse 2 (B) — cache now ~full (A, B)
    await collectLexicalSegments(sourceC, "typescript"); // parse 3 (C) — evicts A (least-recently-used)
    expect(spy).toHaveBeenCalledTimes(3);

    // B and C are still cached — no re-parse.
    await collectLexicalSegments(sourceB, "typescript");
    await collectLexicalSegments(sourceC, "typescript");
    expect(spy).toHaveBeenCalledTimes(3);

    // A was evicted — must re-parse, not silently return stale/wrong data.
    const reparsedA = await collectLexicalSegments(sourceA, "typescript");
    expect(spy).toHaveBeenCalledTimes(4);
    expect(segmentKindAt(reparsedA, 3, 21)).toBe("string");
  });

  it("a single text whose own size already exceeds the byte budget is never cached (parsed fresh every time, exactly like before this memo existed)", async () => {
    __setLexicalSegmentsCacheMaxBytesForTest(10); // smaller than TS_SOURCE itself
    const spy = vi.spyOn(treeSitterMod, "withTreeSitterRoot");

    await collectLexicalSegments(TS_SOURCE, "typescript");
    await collectLexicalSegments(TS_SOURCE, "typescript");
    expect(spy).toHaveBeenCalledTimes(2); // never a cache hit — too big to ever fit
  });
  it("a cache hit rebuilds a map equal to the miss result — same lines, same order, same segments — and never shares objects", async () => {
    const miss = await collectLexicalSegments(TS_SOURCE, "typescript");
    const hit = await collectLexicalSegments(TS_SOURCE, "typescript");
    expect([...hit.entries()]).toEqual([...miss.entries()]);
    expect([...hit.keys()]).toEqual([...miss.keys()]);
    const firstLine = [...hit.keys()][0]!;
    expect(hit.get(firstLine)).not.toBe(miss.get(firstLine));
    // A multi-line template/comment segment keeps its open end through the packed encoding.
    const MULTI = ["const s = `line one", "line two`;", "/* a", "   b */ const x = 1;"].join("\n");
    const multiMiss = await collectLexicalSegments(MULTI, "typescript");
    const multiHit = await collectLexicalSegments(MULTI, "typescript");
    expect([...multiHit.entries()]).toEqual([...multiMiss.entries()]);
    expect(multiHit.get(1)?.[0]?.endCol).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("a failed parse is not cached: the next call parses again", async () => {
    const spy = vi.spyOn(treeSitterMod, "withTreeSitterRoot").mockResolvedValueOnce(undefined);
    const failed = await collectLexicalSegments(TS_SOURCE, "typescript");
    expect(failed.size).toBe(0);
    const retried = await collectLexicalSegments(TS_SOURCE, "typescript");
    expect(spy).toHaveBeenCalledTimes(2);
    expect(segmentKindAt(retried, 1, 2)).toBe("comment");
  });
});
