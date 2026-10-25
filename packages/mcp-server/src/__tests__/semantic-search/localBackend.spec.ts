import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MULTILINGUAL_E5_MODEL } from "@tokenlighten/types";
import { createLocalEmbeddingBackend } from "../../features/semantic-search/backend.js";
import { defaultEngineConfiguration } from "../../features/engines/config.js";

const mocked = vi.hoisted(() => ({ pipeline: vi.fn(), assets: vi.fn(), tokenize: vi.fn() }));
vi.mock("../../features/semantic-search/modelAssets.js", () => ({ ensureSemanticModelAssets: mocked.assets }));
vi.mock("@huggingface/transformers", () => ({
  AutoTokenizer: { from_pretrained: async () => mocked.tokenize },
  AutoModel: { from_pretrained: mocked.pipeline },
  FeatureExtractionPipeline: function ({ model }: { model: unknown }) { return model; },
}));

afterEach(() => vi.resetAllMocks());
beforeEach(() => {
  mocked.assets.mockResolvedValue("/local/pinned-model");
  mocked.tokenize.mockReturnValue({input_ids: {dims: [1, 8], data: new BigInt64Array(8)}});
});

function extractor() {
  return Object.assign(vi.fn(async (texts: string[]) => ({ tolist: () => texts.map(() => [1, 0]) })), { dispose: vi.fn(async () => undefined) });
}

describe("optional on-device ONNX backend", () => {
  it("counts complete formatted inputs without truncation and accepts the 512-token boundary", async () => {
    const extract = extractor();
    mocked.pipeline.mockResolvedValue(extract);
    mocked.tokenize.mockReturnValue({input_ids: {dims: [1, 512], data: new BigInt64Array(512)}});
    const backend = createLocalEmbeddingBackend();
    const input = "passage: src/public/example.ts\n" + "x ".repeat(497);
    await backend.embed([input]);
    expect(mocked.tokenize).toHaveBeenCalledExactlyOnceWith(input, {padding: false, truncation: false});
    expect(extract).toHaveBeenCalledOnce();
    await backend.dispose?.();
  });
  it.each([
    {dims: [1, 513], data: new BigInt64Array(513)},
    {dims: [1, 512], data: new BigInt64Array(511)},
    {dims: [2, 20], data: new BigInt64Array(40)},
    {dims: [1, NaN], data: []},
  ])("refuses excess or malformed token counts before inference: $dims", async ids => {
    const extract = extractor(); mocked.pipeline.mockResolvedValue(extract);
    mocked.tokenize.mockReturnValue({input_ids: ids});
    const backend = createLocalEmbeddingBackend();
    await expect(backend.embed(["passage: " + "long/path/".repeat(100)])).rejects.toMatchObject({
      code: "input-token-budget", message: "input-token-budget",
    });
    expect(extract).not.toHaveBeenCalled();
    await backend.dispose?.();
  });
  it("uses the installer cache by default so installed models work without a cache override", async () => {
    mocked.pipeline.mockResolvedValue(extractor());
    const backend = createLocalEmbeddingBackend();
    await backend.embed(["query: installed model"]);
    expect(mocked.assets.mock.calls[0]![0]).toBe(defaultEngineConfiguration().semanticSearch.cacheDir);
    await backend.dispose?.();
  });
  it("does not load until used, defaults to offline pinned CPU q8, pools and normalizes", async () => {
    const extract = extractor();
    mocked.pipeline.mockResolvedValue(extract);
    const backend = createLocalEmbeddingBackend({ cacheDir: "/test/cache" });
    expect(mocked.pipeline).not.toHaveBeenCalled();
    await backend.embed(["query: hello"]);
    expect(mocked.pipeline).toHaveBeenCalledExactlyOnceWith("/local/pinned-model", {
      revision: MULTILINGUAL_E5_MODEL.revision, dtype: "q8", device: "cpu", local_files_only: true, cache_dir: "/test/cache",
    });
    expect(extract).toHaveBeenCalledExactlyOnceWith(["query: hello"], { pooling: "mean", normalize: true });
    await backend.dispose?.();
    expect(extract.dispose).toHaveBeenCalledOnce();
  });

  it("permits model downloads only through an explicit opt-in", async () => {
    mocked.pipeline.mockResolvedValue(extractor());
    const backend = createLocalEmbeddingBackend({ allowDownload: true });
    await backend.embed(["passage: hello"]);
    expect(mocked.assets.mock.calls[0]![1]).toBe(true);
    expect(mocked.pipeline.mock.calls[0]![1]).toMatchObject({ local_files_only: true });
    await backend.dispose?.();
  });

  it("shares one initialization without poisoning it when one waiter cancels", async () => {
    let release!: (value: ReturnType<typeof extractor>) => void;
    mocked.pipeline.mockReturnValue(new Promise(resolve => { release = resolve; }));
    const backend = createLocalEmbeddingBackend();
    const controller = new AbortController();
    const first = backend.embed(["one"], controller.signal);
    const second = backend.embed(["two"]);
    await vi.waitFor(() => expect(mocked.pipeline).toHaveBeenCalledOnce());
    controller.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    release(extractor());
    expect(await second).toEqual([[1, 0]]);
    await backend.dispose?.();
  });

  it("degrades missing-model failures to a sanitized retryable error", async () => {
    mocked.pipeline.mockRejectedValueOnce(new Error("secret cache path")).mockResolvedValueOnce(extractor());
    const backend = createLocalEmbeddingBackend();
    await expect(backend.embed(["one"])).rejects.toMatchObject({ code: "model-unavailable", message: "model-unavailable" });
    await expect(backend.embed(["two"])).resolves.toEqual([[1, 0]]);
    await backend.dispose?.();
  });

  it("cancels before load and frees late initialization after disposal", async () => {
    const backend = createLocalEmbeddingBackend();
    const controller = new AbortController(); controller.abort();
    await expect(backend.embed(["one"], controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(mocked.pipeline).not.toHaveBeenCalled();
    let release!: (value: ReturnType<typeof extractor>) => void;
    mocked.pipeline.mockReturnValue(new Promise(resolve => { release = resolve; }));
    const pending = backend.embed(["two"]);
    await vi.waitFor(() => expect(mocked.pipeline).toHaveBeenCalledOnce());
    await backend.dispose?.();
    const extract = extractor(); release(extract);
    await expect(pending).rejects.toMatchObject({ code: "disposed" });
    expect(extract.dispose).toHaveBeenCalledOnce();
  });

  it("keeps cancelled CPU inference serialized until its kernel finishes", async () => {
    let release!: () => void;
    let running = 0;
    let maxRunning = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const extract = Object.assign(vi.fn(async (texts: string[]) => {
      running++; maxRunning = Math.max(maxRunning, running);
      await gate; running--; return { tolist: () => texts.map(() => [1, 0]) };
    }), { dispose: vi.fn(async () => undefined) });
    mocked.pipeline.mockResolvedValue(extract);
    const backend = createLocalEmbeddingBackend();
    const controller = new AbortController();
    const first = backend.embed(["one"], controller.signal);
    await vi.waitFor(() => expect(extract).toHaveBeenCalledOnce());
    controller.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    const second = backend.embed(["two"]);
    await Promise.resolve();
    expect(extract).toHaveBeenCalledOnce();
    release();
    await second;
    expect(maxRunning).toBe(1);
    await backend.dispose?.();
  });

  it("shares cleanup across simultaneous disposal requests", async () => {
    const extract = extractor();
    let release!: () => void;
    extract.dispose.mockImplementation(() => new Promise<undefined>(resolve => { release = () => resolve(undefined); }));
    mocked.pipeline.mockResolvedValue(extract);
    const backend = createLocalEmbeddingBackend();
    await backend.embed(["one"]);
    const first = backend.dispose!();
    const second = backend.dispose!();
    await vi.waitFor(() => expect(extract.dispose).toHaveBeenCalled());
    expect(extract.dispose).toHaveBeenCalledOnce();
    release();
    await Promise.all([first, second]);
    await backend.dispose!();
    expect(extract.dispose).toHaveBeenCalledOnce();
  });

  it("does not initialize the runtime after disposal during asset finalization", async () => {
    let release!: (root: string) => void;
    mocked.assets.mockReturnValue(new Promise<string>(resolve => { release = resolve; }));
    const backend = createLocalEmbeddingBackend();
    const pending = backend.embed(["one"]);
    await vi.waitFor(() => expect(mocked.assets).toHaveBeenCalledOnce());
    await backend.dispose!();
    release("/local/pinned-model");
    await expect(pending).rejects.toMatchObject({ code: "disposed" });
    expect(mocked.pipeline).not.toHaveBeenCalled();
  });
});
