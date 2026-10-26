import { createHash } from "node:crypto";
import { createLocalEmbeddingBackend, SemanticBackendError, throwIfAborted, type EmbeddingBackend, type LocalEmbeddingOptions } from "./backend.js";
import { EmbeddingCache } from "./embeddingCache.js";
import {abortable} from "./backend.js";
import {chunkSource, selectWindows, type TextWindow, type ScoredWindow, type DeclarationSpan} from "./chunks.js";
import {collectSymbols} from "../../symbols/collectSymbols.js";
import {languageForPathWithContent} from "../../util/languages.js";

export { createLocalEmbeddingBackend, DEFAULT_SEMANTIC_MODEL_CACHE_DIR, SemanticBackendError } from "./backend.js";
export type { EmbeddingBackend, LocalEmbeddingOptions } from "./backend.js";
export { prepareSemanticModel, readSemanticModelStatus } from "./modelLifecycle.js";
export type { SemanticModelStatus } from "./modelLifecycle.js";

// These are internal retrieval inputs, not additional MCP tool contracts.
export interface SemanticSource {
  readonly path: string;
  readonly text: string;
  /** Caller-supplied repository/file generation; digest independently checks content. */
  readonly identity?: string;
  readonly startLine?: number;
}
export interface SemanticAnchor {
  readonly path: string;
  readonly line?: number;
}
export interface SemanticSearchInput {
  readonly query: string;
  /** Already authorized snapshots. The engine never walks or reopens a repository. */
  readonly sources: readonly SemanticSource[];
  readonly anchors?: readonly SemanticAnchor[];
  readonly signal?: AbortSignal;
  readonly limit?: number;
}
export interface SemanticCandidate {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly score: number | null;
  readonly anchor: boolean;
  /** A retrieval hint, never absence/coverage/evidence proof. */
  readonly reason: "explicit-anchor" | "local-embedding";
}
export interface SemanticSearchResult {
  readonly status: "available" | "unavailable" | "cancelled" | "bounded";
  readonly candidates: readonly SemanticCandidate[];
  readonly model: string;
  readonly partial: true;
  readonly reasons: readonly string[];
  readonly indexedChunks: number;
}
export interface SemanticSearchOptions extends LocalEmbeddingOptions {
  readonly backend?: EmbeddingBackend;
  readonly timeoutMs?: number;
  readonly maxSources?: number;
  readonly maxChunks?: number;
  readonly maxBytes?: number;
  readonly cacheEntries?: number;
}

interface Chunk extends TextWindow {
  readonly formatted: string;
  readonly key: string;
}

const MAX_QUERY_CHARS = 4096;
const MAX_ANCHORS = 32;
const MAX_HITS = 64;
const MAX_SOURCE_SCAN = 2048;

function boundedInteger(value: number | undefined, fallback: number, upper: number): number {
  return value === undefined || !Number.isFinite(value) ? fallback : Math.max(1, Math.min(upper, Math.floor(value)));
}
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }

export function formatE5Input(text: string, role: "query" | "passage"): string {
  return `${role}: ${text.normalize("NFC")}`;
}

/** Multilingual dense retrieval with conservative source/range provenance. */
export class LocalSemanticSearch {
  private readonly backend: EmbeddingBackend;
  private readonly cache: EmbeddingCache;
  private readonly maxSources: number;
  private readonly maxChunks: number;
  private readonly maxBytes: number;
  private readonly timeoutMs: number;
  private active = 0;
  private disposed = false;

  constructor(options: SemanticSearchOptions = {}) {
    this.backend = options.backend ?? createLocalEmbeddingBackend(options);
    this.cache = new EmbeddingCache(this.backend, boundedInteger(options.cacheEntries, 1024, 8192));
    this.maxSources = boundedInteger(options.maxSources, 96, 512);
    this.maxChunks = boundedInteger(options.maxChunks, 192, 1024);
    this.maxBytes = boundedInteger(options.maxBytes, 512 * 1024, 4 * 1024 * 1024);
    this.timeoutMs = boundedInteger(options.timeoutMs, 10_000, 120_000);
  }

  async search(input: SemanticSearchInput): Promise<SemanticSearchResult> {
    const startedAt = Date.now();
    const reasons = new Set<string>();
    const anchors = new Map<string, SemanticAnchor>();
    for (const anchor of (input.anchors ?? []).slice(0, MAX_ANCHORS)) {
      if (typeof anchor.path === "string" && anchor.path.length) anchors.set(anchor.path, anchor);
    }
    if ((input.anchors?.length ?? 0) > MAX_ANCHORS) reasons.add("anchor-budget");
    const candidates = new Map<string, SemanticCandidate>();
    let semanticCandidates: SemanticCandidate[] = [];
    const sources = input.sources.slice(0, MAX_SOURCE_SCAN).sort((a, b) => Number(anchors.has(b.path)) - Number(anchors.has(a.path)));
    if (input.sources.length > MAX_SOURCE_SCAN) reasons.add("source-scan-budget");
    const chunks: Chunk[] = [];
    let bytes = 0;
    let admitted = 0;
    const seen = new Set<string>();
    for (const source of sources) {
      if (Date.now() - startedAt >= this.timeoutMs) { reasons.add("time-budget"); break; }
      if (typeof source.path !== "string" || typeof source.text !== "string" || !source.path || seen.has(source.path)) continue;
      seen.add(source.path);
      if (source.path.length > 4096 || source.text.length > this.maxBytes) { reasons.add("oversized-source"); continue; }
      const anchor = anchors.get(source.path);
      if (admitted >= this.maxSources && !anchor) { reasons.add("source-budget"); continue; }
      if (chunks.length >= this.maxChunks && !anchor) { reasons.add("chunk-budget"); continue; }
      const start = boundedInteger(source.startLine, 1, Number.MAX_SAFE_INTEGER);
      const lines = source.text.split(/\r\n|\r|\n/);
      if (anchor) {
        const line = boundedInteger(anchor.line, start, Number.MAX_SAFE_INTEGER);
        if (line >= start && line < start + lines.length) candidates.set(source.path, {
          path: source.path, startLine: line, endLine: line, score: null, anchor: true, reason: "explicit-anchor",
        });
      }
      if (admitted >= this.maxSources) { reasons.add("source-budget"); continue; }
      if (chunks.length >= this.maxChunks) { reasons.add("chunk-budget"); continue; }
      admitted++;
      const sourceDigest = digest(source.text);
      const snapshot = {...source, startLine: start};
      for (const window of chunkSource(snapshot)) {
        if (input.signal?.aborted) break;
        if (Date.now() - startedAt >= this.timeoutMs) {reasons.add("time-budget"); break;}
        if (chunks.length >= this.maxChunks) {reasons.add("chunk-budget"); break;}
        const size = Buffer.byteLength(window.text);
        if (bytes + size > this.maxBytes) {reasons.add("byte-budget"); break;}
        bytes += size;
        if (!window.text.trim()) continue;
        const formatted = formatE5Input(`${source.path}\n${window.text}`, "passage");
        chunks.push({...window, formatted, key: digest(JSON.stringify([this.backend.identity, source.path,
          source.identity ?? "", sourceDigest, window.startOffset, window.endOffset, formatted]))});
      }
    }
    const finish = (status: SemanticSearchResult["status"]): SemanticSearchResult => {
      const sorted = [...candidates.values(), ...semanticCandidates].sort((a, b) => Number(b.anchor) - Number(a.anchor)
        || (b.score ?? -2) - (a.score ?? -2) || a.path.localeCompare(b.path));
      const limit = Math.max(anchors.size, boundedInteger(input.limit, 12, MAX_HITS));
      return { status, candidates: sorted.slice(0, limit), model: this.backend.identity, partial: true,
        reasons: [...reasons], indexedChunks: chunks.length };
    };
    if (input.signal?.aborted) { reasons.add("cancelled"); return finish("cancelled"); }
    if (this.disposed) { reasons.add("disposed"); return finish("unavailable"); }
    if (this.active >= 2) { reasons.add("query-concurrency-budget"); return finish("bounded"); }
    if (!input.query.trim() || !chunks.length) { reasons.add("empty-input"); return finish("bounded"); }
    if (input.query.length > MAX_QUERY_CHARS) { reasons.add("query-budget"); return finish("bounded"); }
    if (reasons.has("time-budget")) return finish("bounded");
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    input.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => { reasons.add("time-budget"); controller.abort(); }, Math.max(1, this.timeoutMs - (Date.now() - startedAt)));
    timer.unref();
    this.active++;
    try {
      const signal = controller.signal;
      throwIfAborted(signal);
      const queryText = formatE5Input(input.query, "query");
      const query = await this.cache.get(`query:${digest(this.backend.identity + queryText)}`, queryText, signal);
      const vectors = await Promise.all(chunks.map(chunk => this.cache.get(chunk.key, chunk.formatted, signal)));
      const scored: ScoredWindow[] = [];
      throwIfAborted(signal);
      for (let index = 0; index < chunks.length; index++) {
        const chunk = chunks[index]!;
        const vector = vectors[index]!;
        const score = Math.max(-1, Math.min(1, query.reduce((sum, value, offset) => sum + value * vector[offset]!, 0)));
        if (!Number.isFinite(score)) throw new SemanticBackendError("invalid-vector");
        if (!candidates.has(chunk.source.path)) scored.push({...chunk, score});
      }
      const limit = Math.max(anchors.size, boundedInteger(input.limit, 12, MAX_HITS));
      const semanticLimit = Math.max(0, limit - candidates.size);
      const declarations = new Map<SemanticSource, DeclarationSpan[]>();
      const seedSources = [...new Set([...scored].sort((a, b) => b.score - a.score).slice(0, Math.min(MAX_HITS, semanticLimit * 2)).map(window => window.source))].slice(0, 6);
      for (const source of seedSources) {
        throwIfAborted(signal);
        const language = languageForPathWithContent(source.path, source.text);
        if (!language) continue;
        try {
          const symbols = await abortable(collectSymbols(source.text, language, {}), signal);
          declarations.set(source, symbols.filter(symbol => symbol.kind === "function" || symbol.kind === "method")
            .map(symbol => ({startLine: symbol.startLine + (source.startLine ?? 1) - 1,
              endLine: symbol.endLine + (source.startLine ?? 1) - 1})));
        } catch (error) {if (signal.aborted) throw error;}
      }
      semanticCandidates = selectWindows(scored, semanticLimit, declarations).map(window => ({
        path: window.source.path, startLine: window.startLine, endLine: window.endLine,
        score: window.score, anchor: false, reason: "local-embedding",
      }));
      return finish(reasons.size ? "bounded" : "available");
    } catch (error) {
      // Do not leak file paths, runtime stack traces, or model-cache contents.
      if (controller.signal.aborted) {
        const cancelled = input.signal?.aborted === true;
        reasons.add(cancelled ? "cancelled" : "time-budget");
        return finish(cancelled ? "cancelled" : "bounded");
      }
      reasons.add(error instanceof SemanticBackendError ? error.code : "model-unavailable");
      return finish(error instanceof SemanticBackendError && error.code === "input-token-budget" ? "bounded" : "unavailable");
    } finally {
      controller.abort();
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
      this.active--;
    }
  }

  async dispose(): Promise<void> { this.disposed = true; await this.cache.dispose(); }
}
