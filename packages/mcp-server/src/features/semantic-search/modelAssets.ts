import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { MULTILINGUAL_E5_MODEL } from "@tokenlighten/types";
import { combinedAbortSignal } from "../../util/combinedAbortSignal.js";

export const REQUIRED_SEMANTIC_ASSETS = ["config.json", "tokenizer.json", "tokenizer_config.json", "onnx/model_quantized.onnx"] as const;
const MAX_ASSET_BYTES = 256 * 1024 * 1024;

export function semanticModelDirectory(cacheDir: string): string {
  return join(resolve(cacheDir), MULTILINGUAL_E5_MODEL.id, MULTILINGUAL_E5_MODEL.revision);
}

async function present(path: string): Promise<boolean> {
  try { const stat = await lstat(path); return stat.isFile() && !stat.isSymbolicLink() && stat.size > 0; }
  catch { return false; }
}

/**
 * No inference or model text ever reaches fetch. Every asset URL is immutable
 * and public. The directory is subsequently passed as a LOCAL model ID, so
 * Transformers.js 4.3.1 cannot issue its unpinned metadata probes.
 */
export async function ensureSemanticModelAssets(cacheDir: string, allowDownload: boolean, signal?: AbortSignal): Promise<string> {
  const modelRoot = semanticModelDirectory(cacheDir);
  for (const file of REQUIRED_SEMANTIC_ASSETS) {
    signal?.throwIfAborted();
    const destination = join(modelRoot, file);
    if (await present(destination)) continue;
    if (!allowDownload) throw new Error("model-unavailable");
    const parent = dirname(destination);
    await mkdir(parent, { recursive: true });
    const cacheRoot = await realpath(resolve(cacheDir));
    const pinnedParent = await realpath(parent);
    const rel = relative(cacheRoot, pinnedParent);
    if (rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("Model cache parent escaped configured root");
    const combined = combinedAbortSignal([AbortSignal.timeout(120_000), ...(signal ? [signal] : [])]);
    try {
      const boundedSignal = combined.signal;
      const response = await fetch(`https://huggingface.co/${MULTILINGUAL_E5_MODEL.id}/resolve/${MULTILINGUAL_E5_MODEL.revision}/${file}`, { signal: boundedSignal });
      if (!response.ok || !response.body) throw new Error("Model asset download failed");
      const declaredLength = Number(response.headers.get("content-length"));
      if (declaredLength > MAX_ASSET_BYTES) { await response.body.cancel(); throw new Error("Model asset exceeded download budget"); }
      const temporary = join(parent, `.tl-model-${randomUUID()}.tmp`);
      const handle = await open(temporary, "wx", 0o600);
      const identity = await handle.stat();
      const input = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0], { signal: boundedSignal });
      let size = 0;
      try {
        for await (const chunk of input) {
          boundedSignal.throwIfAborted();
          size += chunk.length;
          if (size > MAX_ASSET_BYTES) throw new Error("Model asset exceeded download budget");
          await handle.writeFile(chunk);
        }
        if (size === 0) throw new Error("Empty model asset");
        await handle.sync();
        boundedSignal.throwIfAborted();
        const publicationSource = await lstat(temporary);
        if (publicationSource.dev !== identity.dev || publicationSource.ino !== identity.ino || publicationSource.isSymbolicLink()) {
          throw new Error("Model download temporary was replaced");
        }
        // A hard link publishes only when the destination is absent. An existing
        // foreign/corrupt file is preserved instead of silently overwritten.
        boundedSignal.throwIfAborted();
        try { await link(temporary, destination); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !await present(destination)) throw error;
        }
      } finally {
        input.destroy();
        await handle.close();
        try {
          const current = await lstat(temporary);
          if (current.dev === identity.dev && current.ino === identity.ino) await unlink(temporary);
        } catch { /* Preserve anything whose ownership is no longer provable. */ }
      }
    } finally { combined.dispose(); }
  }
  signal?.throwIfAborted();
  return modelRoot;
}
