import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { E5_MIT_NOTICE, MULTILINGUAL_E5_MODEL } from "@tokenlighten/types";
import { createLocalEmbeddingBackend, DEFAULT_SEMANTIC_MODEL_CACHE_DIR, normalizeVector,
  throwIfAborted, type LocalEmbeddingOptions } from "./backend.js";
import { REQUIRED_SEMANTIC_ASSETS, semanticModelDirectory } from "./modelAssets.js";

export interface SemanticModelStatus {
  readonly model: string;
  readonly revision: string;
  readonly cacheDir: string;
  /** Asset presence only. The GUI must not call this an integrity attestation. */
  readonly status: "ready" | "missing" | "incomplete";
  readonly missingFiles: readonly string[];
  readonly fingerprint: string | null;
}

/** Filesystem-only inspection: imports no inference runtime and performs no network access. */
export async function readSemanticModelStatus(options: { readonly cacheDir?: string } = {}): Promise<SemanticModelStatus> {
  const cacheDir = resolve(options.cacheDir ?? DEFAULT_SEMANTIC_MODEL_CACHE_DIR);
  const modelRoot = semanticModelDirectory(cacheDir);
  const missingFiles: string[] = [];
  const identities: string[] = [];
  for (const file of REQUIRED_SEMANTIC_ASSETS) {
    try {
      const stat = await lstat(join(modelRoot, file));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) { missingFiles.push(file); continue; }
      identities.push(`${file}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`);
    } catch { missingFiles.push(file); }
  }
  return {
    model: MULTILINGUAL_E5_MODEL.id, revision: MULTILINGUAL_E5_MODEL.revision, cacheDir,
    status: missingFiles.length === REQUIRED_SEMANTIC_ASSETS.length ? "missing" : missingFiles.length ? "incomplete" : "ready",
    missingFiles, fingerprint: identities.length ? createHash("sha256").update(identities.join("\n")).digest("hex") : null,
  };
}

/** Explicit installer/warmup; callers choose whether downloads are authorized. */
export async function prepareSemanticModel(options: LocalEmbeddingOptions & { readonly signal?: AbortSignal } = {}): Promise<SemanticModelStatus> {
  throwIfAborted(options.signal);
  const cacheDir = resolve(options.cacheDir ?? DEFAULT_SEMANTIC_MODEL_CACHE_DIR);
  const backend = createLocalEmbeddingBackend({ ...options, cacheDir });
  try {
    const vectors = await backend.embed(["query: local multilingual semantic search"], options.signal);
    normalizeVector(vectors[0]!, MULTILINGUAL_E5_MODEL.dimensions);
    throwIfAborted(options.signal);
    const modelRoot = join(cacheDir, MULTILINGUAL_E5_MODEL.id, MULTILINGUAL_E5_MODEL.revision);
    await mkdir(modelRoot, { recursive: true });
    const notices: [string, string][] = [
      ["MODEL_LICENSE.txt", E5_MIT_NOTICE],
      ["MODEL_PROVENANCE.json", `${JSON.stringify(MULTILINGUAL_E5_MODEL, null, 2)}\n`],
    ];
    for (const [name, text] of notices) {
      throwIfAborted(options.signal);
      const path = join(modelRoot, name);
      try { await writeFile(path, text, { encoding: "utf8", flag: "wx" }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const stat = await lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink() || await readFile(path, "utf8") !== text) {
          throw new Error("Model notice path contains a different existing file");
        }
      }
    }
    return await readSemanticModelStatus({ cacheDir });
  } finally {
    if (options.signal?.aborted) void backend.dispose?.().catch(() => undefined);
    else await backend.dispose?.();
  }
}
