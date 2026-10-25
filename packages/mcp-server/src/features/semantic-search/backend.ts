import { MULTILINGUAL_E5_MODEL } from "@tokenlighten/types";
import { homedir } from "node:os";
import { join } from "node:path";
import { ensureSemanticModelAssets } from "./modelAssets.js";

export const DEFAULT_SEMANTIC_MODEL_CACHE_DIR = join(homedir(), ".tokenlighten", "models");

/** Private provider seam: implementations receive only bounded local text. */
export interface EmbeddingBackend {
  readonly identity: string;
  readonly dimensions?: number;
  embed(texts: readonly string[], signal?: AbortSignal): Promise<readonly (readonly number[])[]>;
  dispose?(): Promise<void>;
}

export interface LocalEmbeddingOptions {
  /** An explicit opt-in. Defaults to cached/local model files only. */
  readonly allowDownload?: boolean;
  readonly cacheDir?: string;
}

interface Tokenizer {
  (text: string, options: {padding: false; truncation: false}): {input_ids?: {dims?: readonly number[]; data?: {length: number}}};
}

interface Extractor {
  (texts: string[], options: { pooling: "mean"; normalize: true }): Promise<{ tolist(): unknown }>;
  dispose(): Promise<unknown>;
}

export class SemanticBackendError extends Error {
  constructor(readonly code: "model-unavailable" | "invalid-vector" | "queue-limit" | "disposed" | "input-token-budget") {
    super(code);
    this.name = "SemanticBackendError";
  }
}

export function abortError(): Error {
  const error = new Error("Semantic search cancelled");
  error.name = "AbortError";
  return error;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

/** Waiter cancellation never poisons a shared model initialization. */
export function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => { cleanup(); reject(abortError()); };
    const cleanup = (): void => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

/**
 * Lazy ONNX CPU inference. This invokes no hosted inference endpoint: remote
 * access, when explicitly enabled, downloads immutable public model assets.
 * Per-pipeline local_files_only avoids mutating Transformers.js global env.
 */
export function createLocalEmbeddingBackend(options: LocalEmbeddingOptions = {}): EmbeddingBackend {
  const identity = `${MULTILINGUAL_E5_MODEL.id}@${MULTILINGUAL_E5_MODEL.revision}:${MULTILINGUAL_E5_MODEL.dtype}:e5-v1`;
  let loading: Promise<Extractor> | undefined;
  let loaded: Extractor | undefined;
  let loadedTokenizer: Tokenizer | undefined;
  let disposal: Promise<void> | undefined;
  let inferenceTail: Promise<void> = Promise.resolve();
  const loadingController = new AbortController();
  let disposed = false;
  const load = (): Promise<Extractor> => {
    if (disposed) return Promise.reject(new SemanticBackendError("disposed"));
    if (!loading) {
      loading = (async () => {
        const modelRoot = await ensureSemanticModelAssets(options.cacheDir ?? DEFAULT_SEMANTIC_MODEL_CACHE_DIR, options.allowDownload === true, loadingController.signal);
        if (disposed) throw new SemanticBackendError("disposed");
        // Variable import keeps the optional runtime out of the eager server
        // startup graph and permits lexical operation without its installation.
        const moduleName = "@huggingface/transformers";
        const runtime = await import(moduleName) as {
          AutoTokenizer: { from_pretrained(model: string, settings: Record<string, unknown>): Promise<Tokenizer> };
          AutoModel: { from_pretrained(model: string, settings: Record<string, unknown>): Promise<unknown> };
          FeatureExtractionPipeline: new (settings: { task: string; tokenizer: unknown; model: unknown }) => Extractor;
        };
        if (disposed) throw new SemanticBackendError("disposed");
        const settings = {
          revision: MULTILINGUAL_E5_MODEL.revision,
          dtype: MULTILINGUAL_E5_MODEL.dtype,
          device: "cpu",
          local_files_only: true,
          cache_dir: options.cacheDir ?? DEFAULT_SEMANTIC_MODEL_CACHE_DIR,
        };
        // Transformers.js 4.3.1 pipeline() probes model files before carrying
        // revision/local_files_only/cache_dir into its preliminary config read.
        // Construct its documented components directly to preserve offline and
        // immutable-revision guarantees for every file request.
        const tokenizer = await runtime.AutoTokenizer.from_pretrained(modelRoot, settings);
        if (disposed) throw new SemanticBackendError("disposed");
        const model = await runtime.AutoModel.from_pretrained(modelRoot, settings);
        const extractor = new runtime.FeatureExtractionPipeline({ task: "feature-extraction", tokenizer, model });
        if (disposed) {
          await extractor.dispose();
          throw new SemanticBackendError("disposed");
        }
        loaded = extractor;
        loadedTokenizer = tokenizer;
        return extractor;
      })().catch(() => {
        loading = undefined;
        throw new SemanticBackendError(disposed ? "disposed" : "model-unavailable");
      });
    }
    return loading;
  };
  return {
    identity,
    dimensions: MULTILINGUAL_E5_MODEL.dimensions,
    async embed(texts, signal) {
      throwIfAborted(signal);
      const extractor = await abortable(load(), signal);
      throwIfAborted(signal);
      // ORT cannot interrupt a CPU kernel. Keep the kernel in the serialization
      // chain even when its waiter cancels, preventing overlapping sessions.
      const inference = inferenceTail.then(async () => {
        throwIfAborted(signal);
        if (disposed) throw new SemanticBackendError("disposed");
        // E5 accepts at most 512 tokens, including source path, role and special tokens.
        // Count exact inputs without truncation before any CPU inference.
        for (const text of texts) {
          throwIfAborted(signal);
          const ids = loadedTokenizer?.(text, {padding: false, truncation: false}).input_ids;
          const dims = ids?.dims;
          if (!dims || dims.length !== 2 || dims[0] !== 1 || !Number.isSafeInteger(dims[1])
            || dims[1]! < 1 || dims[1]! > 512 || ids?.data?.length !== dims[1]) {
            throw new SemanticBackendError("input-token-budget");
          }
        }
        return await extractor([...texts], { pooling: "mean", normalize: true });
      });
      inferenceTail = inference.then(() => undefined, () => undefined);
      const result = await abortable(inference, signal);
      throwIfAborted(signal);
      const vectors = result.tolist();
      if (!Array.isArray(vectors) || vectors.length !== texts.length || !vectors.every(Array.isArray)) {
        throw new SemanticBackendError("invalid-vector");
      }
      return vectors as number[][];
    },
    dispose() {
      if (disposal) return disposal;
      disposed = true;
      loadingController.abort();
      disposal = (async () => {
        if (loaded) {
          await inferenceTail;
          await loaded.dispose();
          loaded = undefined;
          loadedTokenizer = undefined;
        } else if (loading) {
          // load() disposes a session that finishes after this cancellation.
          void loading.catch(() => undefined);
        }
      })();
      return disposal;
    },
  };
}

export function normalizeVector(input: readonly number[], dimensions?: number): readonly number[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 16_384 || (dimensions !== undefined && input.length !== dimensions)
    || input.some(value => typeof value !== "number" || !Number.isFinite(value))) {
    throw new SemanticBackendError("invalid-vector");
  }
  const scale = Math.max(...input.map(Math.abs));
  if (!(scale > 0)) throw new SemanticBackendError("invalid-vector");
  const scaled = input.map(value => value / scale);
  const norm = Math.sqrt(scaled.reduce((sum, value) => sum + value * value, 0));
  return Object.freeze(scaled.map(value => value / norm));
}
