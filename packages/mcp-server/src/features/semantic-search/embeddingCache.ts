import { abortError, normalizeVector, SemanticBackendError, type EmbeddingBackend } from "./backend.js";

interface Waiter {
  resolve(vector: readonly number[]): void;
  reject(error: unknown): void;
  cleanup(): void;
}
interface Pending {
  key: string;
  text: string;
  waiters: Set<Waiter>;
  group?: { controller: AbortController; entries: Pending[] };
}

/** Bounded LRU, single-flight entries, and serialized micro-batches. */
export class EmbeddingCache {
  private readonly ready = new Map<string, readonly number[]>();
  private readonly pending = new Map<string, Pending>();
  private readonly queue: Pending[] = [];
  private running = false;
  private scheduled = false;
  private disposed = false;
  private dimensions: number | undefined;

  constructor(private readonly backend: EmbeddingBackend, private readonly capacity = 1024, private readonly batchSize = 8) {
    this.dimensions = backend.dimensions;
  }

  get(key: string, text: string, signal?: AbortSignal): Promise<readonly number[]> {
    if (this.disposed) return Promise.reject(new SemanticBackendError("disposed"));
    if (signal?.aborted) return Promise.reject(abortError());
    const cached = this.ready.get(key);
    if (cached) {
      this.ready.delete(key);
      this.ready.set(key, cached);
      return Promise.resolve(cached);
    }
    let entry = this.pending.get(key);
    if (entry?.group?.controller.signal.aborted) entry = undefined;
    if (!entry) {
      if (this.pending.size >= this.capacity) return Promise.reject(new SemanticBackendError("queue-limit"));
      entry = { key, text, waiters: new Set() };
      this.pending.set(key, entry);
      this.queue.push(entry);
    }
    const owned = entry;
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, cleanup: () => signal?.removeEventListener("abort", abort) };
      const abort = (): void => {
        owned.waiters.delete(waiter);
        waiter.cleanup();
        reject(abortError());
        if (owned.waiters.size === 0 && !owned.group) this.pending.delete(key);
        if (owned.group?.entries.every(item => item.waiters.size === 0)) owned.group.controller.abort();
      };
      owned.waiters.add(waiter);
      signal?.addEventListener("abort", abort, { once: true });
      this.schedule();
    });
  }

  private schedule(): void {
    if (this.running || this.scheduled || this.disposed) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; void this.pump(); });
  }

  private async pump(): Promise<void> {
    if (this.running || this.disposed) return;
    const entries: Pending[] = [];
    while (this.queue.length && entries.length < this.batchSize) {
      const entry = this.queue.shift()!;
      if (entry.waiters.size && this.pending.get(entry.key) === entry) entries.push(entry);
    }
    if (!entries.length) return;
    this.running = true;
    const group = { controller: new AbortController(), entries };
    for (const entry of entries) entry.group = group;
    try {
      const vectors = await this.backend.embed(entries.map(entry => entry.text), group.controller.signal);
      if (vectors.length !== entries.length) throw new SemanticBackendError("invalid-vector");
      const normalized = vectors.map(vector => {
        const result = normalizeVector(vector, this.dimensions);
        this.dimensions ??= result.length;
        return result;
      });
      for (let index = 0; index < entries.length; index++) {
        const entry = entries[index]!;
        const vector = normalized[index]!;
        // An abandoned or disposed computation cannot re-populate the cache.
        if (!this.disposed && entry.waiters.size) {
          this.ready.set(entry.key, vector);
          while (this.ready.size > this.capacity) this.ready.delete(this.ready.keys().next().value!);
        }
        for (const waiter of entry.waiters) { waiter.cleanup(); waiter.resolve(vector); }
      }
    } catch (error) {
      for (const entry of entries) for (const waiter of entry.waiters) { waiter.cleanup(); waiter.reject(error); }
    } finally {
      for (const entry of entries) {
        entry.waiters.clear();
        if (this.pending.get(entry.key) === entry) this.pending.delete(entry.key);
      }
      this.running = false;
      this.schedule();
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.ready.clear();
    for (const entry of this.pending.values()) {
      entry.group?.controller.abort();
      for (const waiter of entry.waiters) { waiter.cleanup(); waiter.reject(new SemanticBackendError("disposed")); }
      entry.waiters.clear();
    }
    this.pending.clear();
    this.queue.length = 0;
    await this.backend.dispose?.();
  }
}
