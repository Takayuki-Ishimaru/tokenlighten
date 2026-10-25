import { mkdir, mkdtemp, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MULTILINGUAL_E5_MODEL } from "@tokenlighten/types";
import { ensureSemanticModelAssets, REQUIRED_SEMANTIC_ASSETS, semanticModelDirectory } from "../../features/semantic-search/modelAssets.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function temporaryCache(): Promise<string> { const root = await mkdtemp(join(tmpdir(), "tl-model-assets-")); roots.push(root); return root; }

describe("explicit immutable model-asset installation", () => {
  it.each(["success", "failure", "cancelled"])("supports Node 20.0 without AbortSignal.any during %s", async outcome => {
    const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, "any")!;
    Object.defineProperty(AbortSignal, "any", { ...descriptor, value: undefined });
    const controller = new AbortController();
    const added = vi.spyOn(controller.signal, "addEventListener");
    const removed = vi.spyOn(controller.signal, "removeEventListener");
    try {
      const root = await temporaryCache();
      const network = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, options) => {
        if (outcome === "failure") throw new Error("transport failed");
        if (outcome === "cancelled") controller.abort();
        options?.signal?.throwIfAborted();
        return new Response("asset");
      });
      const pending = ensureSemanticModelAssets(root, true, controller.signal);
      if (outcome === "success") {
        await expect(pending).resolves.toBe(semanticModelDirectory(root));
        expect(network).toHaveBeenCalledTimes(REQUIRED_SEMANTIC_ASSETS.length);
      } else {
        await expect(pending).rejects.toMatchObject(outcome === "cancelled" ? { name: "AbortError" } : { message: "transport failed" });
      }
      expect(added).toHaveBeenCalled();
      expect(removed.mock.calls.length).toBe(added.mock.calls.length);
    } finally { Object.defineProperty(AbortSignal, "any", descriptor); }
  });

  it("makes no network request or cache write when downloads are disabled", async () => {
    const root = await temporaryCache();
    const network = vi.spyOn(globalThis, "fetch");
    await expect(ensureSemanticModelAssets(root, false)).rejects.toThrow("model-unavailable");
    expect(network).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  });

  it("downloads pinned public assets once, then reuses only local files", async () => {
    const root = await temporaryCache();
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(async input => new Response(`asset:${String(input)}`));
    expect(await ensureSemanticModelAssets(root, true)).toBe(semanticModelDirectory(root));
    expect(network).toHaveBeenCalledTimes(REQUIRED_SEMANTIC_ASSETS.length);
    for (let index = 0; index < REQUIRED_SEMANTIC_ASSETS.length; index++) {
      const file = REQUIRED_SEMANTIC_ASSETS[index]!;
      const url = `https://huggingface.co/${MULTILINGUAL_E5_MODEL.id}/resolve/${MULTILINGUAL_E5_MODEL.revision}/${file}`;
      expect(network.mock.calls[index]![0]).toBe(url);
      expect(await readFile(join(semanticModelDirectory(root), file), "utf8")).toBe(`asset:${url}`);
    }
    await ensureSemanticModelAssets(root, false);
    expect(network).toHaveBeenCalledTimes(REQUIRED_SEMANTIC_ASSETS.length);
    expect((await readdir(semanticModelDirectory(root))).filter(name => name.startsWith(".tl-model-"))).toEqual([]);
  });

  it("fails before writing an oversized or failed HTTP response", async () => {
    const root = await temporaryCache();
    const network = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("failure", { status: 503 }))
      .mockResolvedValueOnce(new Response("tiny", { headers: { "content-length": String(257 * 1024 * 1024) } }));
    await expect(ensureSemanticModelAssets(root, true)).rejects.toThrow("Model asset download failed");
    await expect(ensureSemanticModelAssets(root, true)).rejects.toThrow("download budget");
    expect(network).toHaveBeenCalledTimes(2);
    expect(await readdir(semanticModelDirectory(root))).toEqual([]);
  });

  it("cancels before downloading or modifying the cache", async () => {
    const root = await temporaryCache();
    const controller = new AbortController(); controller.abort();
    const network = vi.spyOn(globalThis, "fetch");
    await expect(ensureSemanticModelAssets(root, true, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(network).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  });

  it("preserves all streamed chunks in order", async () => {
    const root = await temporaryCache();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(new ReadableStream({ start(controller) {
      for (const text of ["first", "second", "third"]) controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    } })));
    await ensureSemanticModelAssets(root, true);
    expect(await readFile(join(semanticModelDirectory(root), "config.json"), "utf8")).toBe("firstsecondthird");
  });

  it("cleans its owned partial payload after a body failure", async () => {
    const root = await temporaryCache();
    let reads = 0;
    const body = new ReadableStream({ pull(controller) {
      if (reads++ === 0) controller.enqueue(new Uint8Array([1, 2, 3]));
      else controller.error(new Error("body failed"));
    } });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body));
    await expect(ensureSemanticModelAssets(root, true)).rejects.toThrow("body failed");
    expect(await readdir(semanticModelDirectory(root))).toEqual([]);
  });

  it("rejects cancellation during final asset sync before publication", async () => {
    const root = await temporaryCache();
    const controller = new AbortController();
    const modelRoot = semanticModelDirectory(root);
    for (const file of REQUIRED_SEMANTIC_ASSETS.slice(0, -1)) {
      await mkdir(dirname(join(modelRoot, file)), { recursive: true });
      await writeFile(join(modelRoot, file), "cached");
    }
    const probe = await open(join(root, "probe"), "wx");
    const originalSync = probe.sync;
    vi.spyOn(Object.getPrototypeOf(probe), "sync").mockImplementation(async function (this: typeof probe) {
      await originalSync.call(this);
      controller.abort();
    });
    await probe.close();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("last asset"));
    await expect(ensureSemanticModelAssets(root, true, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    await expect(readFile(join(modelRoot, REQUIRED_SEMANTIC_ASSETS.at(-1)!))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(join(modelRoot, "onnx"))).toEqual([]);
  });
});
