import { describe, expect, it } from "vitest";
import { EmbeddingCache } from "../../features/semantic-search/embeddingCache.js";
import { LocalSemanticSearch, formatE5Input, SemanticBackendError, type EmbeddingBackend } from "../../features/semantic-search/index.js";
import { normalizeVector } from "../../features/semantic-search/backend.js";

const sources = [
  { path: "src/retry.ts", text: "Retry failed network requests with exponential backoff.", identity: "repo-a/file-1" },
  { path: "src/colors.ts", text: "Render a blue button with a red border.", identity: "repo-a/file-2" },
];

function backendForTests() {
  const calls: string[][] = [];
  const backend: EmbeddingBackend = {
    identity: "test-model@immutable-revision", dimensions: 2,
    async embed(texts) {
      calls.push([...texts]);
      return texts.map(text => text.startsWith("query:") || text.includes("Retry") ? [3, 4] : [-4, 3]);
    },
  };
  return { backend, calls };
}

describe("local multilingual dense retrieval", () => {
  it("uses E5 query/passage prefixes, normalized cosine ranking, and source ranges", async () => {
    const { backend, calls } = backendForTests();
    const engine = new LocalSemanticSearch({ backend });
    const result = await engine.search({ query: "ネットワーク失敗時の再試行", sources });
    expect(result.status).toBe("available");
    expect(result.partial).toBe(true);
    expect(result.candidates[0]).toMatchObject({ path: "src/retry.ts", startLine: 1, endLine: 1, score: 1, reason: "local-embedding" });
    expect(result.candidates[1]!.score).toBeCloseTo(0);
    expect(calls.flat()).toEqual(["query: ネットワーク失敗時の再試行",
      "passage: src/retry.ts\nRetry failed network requests with exponential backoff.",
      "passage: src/colors.ts\nRender a blue button with a red border."]);
    expect(formatE5Input("cafe\u0301", "query")).toBe("query: café");
    await engine.dispose();
  });

  it("keeps explicit lexical anchors above semantic hits, even with limit one", async () => {
    const { backend } = backendForTests();
    const engine = new LocalSemanticSearch({ backend });
    const result = await engine.search({ query: "再試行", sources, anchors: [{ path: "src/colors.ts", line: 1 }], limit: 1 });
    expect(result.candidates).toEqual([{ path: "src/colors.ts", startLine: 1, endLine: 1, score: null, anchor: true, reason: "explicit-anchor" }]);
    const floor = await engine.search({ query: "再試行", sources, anchors: sources.map(source => ({ path: source.path })), limit: 1 });
    expect(floor.candidates).toHaveLength(2);
    await engine.dispose();
  });

  it.each(["first\nsecond\nRetry", "first\r\nsecond\r\nRetry", "first\rsecond\rRetry", "first\r\nsecond\rRetry"])("preserves explicit anchors across line endings %j", async text => {
    const { backend } = backendForTests();
    const engine = new LocalSemanticSearch({ backend });
    const input = {
      query: "retry",
      sources: [{ path: "notes.txt", text, startLine: 40 }],
    };
    try {
      const result = await engine.search({ ...input, anchors: [{ path: "notes.txt", line: 42 }] });
      expect(result.candidates[0]).toMatchObject({ path: "notes.txt", startLine: 42, endLine: 42, anchor: true });
      const beyond = await engine.search({ ...input, anchors: [{ path: "notes.txt", line: 43 }] });
      expect(beyond.candidates.some(candidate => candidate.anchor)).toBe(false);
    } finally {
      await engine.dispose();
    }
  });

  it("reuses embeddings, invalidates identity/content changes, and never leaks generations", async () => {
    const { backend, calls } = backendForTests();
    const engine = new LocalSemanticSearch({ backend });
    const input = { query: "再試行", sources };
    await engine.search(input);
    const count = calls.flat().length;
    await engine.search(input);
    expect(calls.flat()).toHaveLength(count);
    await engine.search({ ...input, sources: [{ ...sources[0]!, identity: "repo-b/file-1" }, sources[1]!] });
    expect(calls.flat()).toHaveLength(count + 1);
    await engine.search({ ...input, sources: [{ ...sources[0]!, text: "Changed retry implementation" }, sources[1]!] });
    expect(calls.flat()).toHaveLength(count + 2);
    await engine.dispose();
  });

  it("chunks by original line boundaries and preserves caller startLine", async () => {
    const { backend } = backendForTests();
    const engine = new LocalSemanticSearch({ backend });
    const text = [...Array.from({ length: 32 }, () => "blue button"), "Retry network failures"].join("\n");
    const result = await engine.search({ query: "再試行", sources: [{ path: "sample.ts", text, startLine: 40 }] });
    expect(result.candidates[0]!.path).toBe("sample.ts");
    expect(result.candidates[0]!.startLine).toBeLessThanOrEqual(72);
    expect(result.candidates[0]!.endLine).toBeGreaterThanOrEqual(72);
    expect(result.candidates[0]!.score).toBe(1);
    await engine.dispose();
  });

  it("bounds corpus/query/oversized-line work without inventing completeness", async () => {
    const { backend, calls } = backendForTests();
    const engine = new LocalSemanticSearch({ backend, maxChunks: 1, maxBytes: 80 });
    const result = await engine.search({ query: "再試行", sources });
    expect(result.status).toBe("bounded");
    expect(result.indexedChunks).toBe(1);
    expect(result.reasons).toContain("chunk-budget");
    const count = calls.length;
    const tooLong = await engine.search({ query: "x".repeat(4097), sources });
    expect(tooLong.reasons).toContain("query-budget");
    expect(calls).toHaveLength(count);
    const oversized = await engine.search({ query: "再試行", sources: [{ path: "big.ts", text: "x".repeat(1201) }] });
    expect(oversized.reasons).toContain("oversized-source");
    expect(oversized.candidates).toEqual([]);
    await engine.dispose();
  });

  it("indexes long lines without losing the coordinates of following lines", async () => {
    const { backend } = backendForTests();
    const engine = new LocalSemanticSearch({ backend });
    const result = await engine.search({ query: "retry", sources: [{ path: "big.ts", text: `${"x".repeat(1201)}\nRetry network failures` }] });
    expect(result.reasons).not.toContain("oversized-line");
    expect(result.indexedChunks).toBe(3);
    expect(result.candidates[0]!.startLine).toBeLessThanOrEqual(2);
    expect(result.candidates[0]!.endLine).toBeGreaterThanOrEqual(2);
    await engine.dispose();
  });

  it("finds a needle at the end of a 1921-character line and caches its fragments independently", async () => {
    const calls: string[] = [];
    const backend: EmbeddingBackend = {identity: "long-line", dimensions: 2, async embed(texts) {
      calls.push(...texts);
      return texts.map(text => text.startsWith("query:") || text.includes("NEEDLE") ? [1, 0] : [0, 1]);
    }};
    const engine = new LocalSemanticSearch({backend});
    const input = {query: "NEEDLE", sources: [{path: "long.ts", startLine: 40, text: "x".repeat(1915) + "NEEDLE"}]};
    const first = await engine.search(input);
    expect(first.status).toBe("available");
    expect(first.indexedChunks).toBe(2);
    expect(first.candidates[0]).toMatchObject({path: "long.ts", startLine: 40, endLine: 40, score: 1});
    const passages = calls.filter(text => text.startsWith("passage:"));
    expect(passages).toHaveLength(2);
    expect(new Set(passages).size).toBe(2);
    const count = calls.length;
    await engine.search(input);
    expect(calls).toHaveLength(count);
    await engine.dispose();
  });
  it("retains separated hits in one path without bridging unselected source", async () => {
    const backend: EmbeddingBackend = {identity: "two-hits", dimensions: 2, async embed(texts) {
      return texts.map(text => text.startsWith("query:") || text.includes("NEEDLE") ? [1, 0] : [0, 1]);
    }};
    const text = Array.from({length: 260}, (_, line) => line === 2 || line === 194 ? "NEEDLE" : "background").join("\n");
    const engine = new LocalSemanticSearch({backend});
    const result = await engine.search({query: "NEEDLE", sources: [{path: "notes.txt", text}], limit: 2});
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.every(hit => hit.path === "notes.txt")).toBe(true);
    expect(result.candidates.some(hit => hit.startLine <= 3 && hit.endLine >= 3)).toBe(true);
    expect(result.candidates.some(hit => hit.startLine <= 195 && hit.endLine >= 195)).toBe(true);
    expect(result.candidates.some(hit => hit.startLine <= 150 && hit.endLine >= 150)).toBe(false);
    await engine.dispose();
  });
  it("bounds token overflow with lexical anchors intact", async () => {
    const backend: EmbeddingBackend = {identity: "dense", async embed() {throw new SemanticBackendError("input-token-budget");}};
    const engine = new LocalSemanticSearch({backend});
    const result = await engine.search({query: "retry", sources, anchors: [{path: "src/retry.ts"}]});
    expect(result.status).toBe("bounded");
    expect(result.reasons).toContain("input-token-budget");
    expect(result.candidates).toEqual([{path: "src/retry.ts", startLine: 1, endLine: 1, score: null, anchor: true, reason: "explicit-anchor"}]);
    await engine.dispose();
  });
  it("degrades model failures to unavailable while retaining proven lexical anchors", async () => {
    const backend: EmbeddingBackend = { identity: "missing", async embed() { throw new SemanticBackendError("model-unavailable"); } };
    const engine = new LocalSemanticSearch({ backend });
    const result = await engine.search({ query: "再試行", sources, anchors: [{ path: "src/retry.ts" }] });
    expect(result.status).toBe("unavailable");
    expect(result.reasons).toContain("model-unavailable");
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.reason).toBe("explicit-anchor");
    await engine.dispose();
  });

  it.each([[0, 0], [NaN, 1], [Infinity, 1], [], [1, 2, 3]].map(vector => ({ vector })))("rejects invalid vector $vector without semantic evidence", async ({ vector }) => {
    const backend: EmbeddingBackend = { identity: "bad", dimensions: 2, async embed(texts) { return texts.map(() => vector); } };
    const engine = new LocalSemanticSearch({ backend });
    const result = await engine.search({ query: "retry", sources });
    expect(result.status).toBe("unavailable");
    expect(result.candidates).toEqual([]);
    expect(result.reasons).toContain("invalid-vector");
    await engine.dispose();
  });

  it("normalizes huge finite vectors without overflow", () => {
    for (const value of normalizeVector([Number.MAX_VALUE, Number.MAX_VALUE])) expect(value).toBeCloseTo(Math.SQRT1_2);
  });
});

describe("cancellation and bounded concurrency", () => {
  it("deduplicates concurrent requests; cancelling one waiter preserves another", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    const backend: EmbeddingBackend = { identity: "shared", dimensions: 2, async embed(texts) {
      calls++; await gate; return texts.map(() => [1, 0]);
    } };
    const engine = new LocalSemanticSearch({ backend });
    const controller = new AbortController();
    const first = engine.search({ query: "retry", sources, signal: controller.signal });
    const second = engine.search({ query: "retry", sources });
    await Promise.resolve();
    controller.abort();
    expect((await first).status).toBe("cancelled");
    release();
    expect((await second).status).toBe("available");
    expect(calls).toBe(2); // one query + one shared corpus batch
    await engine.dispose();
  });

  it("rejects a third active query and enforces wall-clock timeout on a stalled backend", async () => {
    const backend: EmbeddingBackend = { identity: "stalled", async embed() { return await new Promise(() => undefined); } };
    const engine = new LocalSemanticSearch({ backend, timeoutMs: 15 });
    const first = engine.search({ query: "one", sources });
    const second = engine.search({ query: "two", sources });
    const third = await engine.search({ query: "three", sources });
    expect(third.status).toBe("bounded");
    expect(third.reasons).toContain("query-concurrency-budget");
    const timed = await first;
    expect(timed.status).toBe("bounded");
    expect(timed.reasons).toContain("time-budget");
    await second;
    await engine.dispose();
  });

  it("cancels before inference and refuses reuse after dispose", async () => {
    const { backend, calls } = backendForTests();
    const engine = new LocalSemanticSearch({ backend });
    const controller = new AbortController(); controller.abort();
    expect((await engine.search({ query: "retry", sources, signal: controller.signal })).status).toBe("cancelled");
    expect(calls).toEqual([]);
    await engine.dispose();
    expect((await engine.search({ query: "retry", sources })).reasons).toContain("disposed");
  });

  it("bounds the pending cache and evicts LRU vectors", async () => {
    const { backend, calls } = backendForTests();
    const cache = new EmbeddingCache(backend, 1, 1);
    const pending = cache.get("one", "query: one");
    await expect(cache.get("two", "query: two")).rejects.toMatchObject({ code: "queue-limit" });
    await pending;
    await cache.get("two", "query: two");
    await cache.get("one", "query: one");
    expect(calls).toHaveLength(3);
    await cache.dispose();
  });
});
