// Plain data only — no meta envelope, no 'tokenlighten:meta' wrappers.
// Reason: docs/00-postmortem.md §2.2

/**
 * Index persistence module.
 * Handles reading/writing the SourceIndexManifestV1 JSON cache.
 */

import { promises as fs } from "node:fs";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";

import type { ChunkKind, IndexedChunkV1, SymbolKind } from "./chunker.js";
import { extractChunks } from "./chunker.js";
import { enumerateFiles, extractSymbolsRegex, languageForPath, languageForPathWithContent } from "./graph.js";
import { createIgnoreMatcher } from "./ignore.js";
import { hashContent, buildDirectoryDigests } from "./merkle.js";
import { writeGraphIfStale } from "./graphBuilder.js";
import { assertSafeWriteTarget, ensureSafeWriteParent } from "./safeWritePath.js";
import { readRegularFileUtf8 } from "./readGuard.js";

export type { ChunkKind, IndexedChunkV1, SymbolKind };

const execFileAsync = promisify(execFile);

const _require = createRequire(import.meta.url);
const PKG_VERSION: string = (_require("../package.json") as { version: string }).version;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SourceIndexManifestV1 {
  version: 1;
  engineVersion: string;
  repoRootRealpath: string;
  ignoreHash: string;
  builtFromCommit: string;
  rootHash: string;
  /** key = workspace-relative POSIX path */
  files: Record<string, IndexedFileV1>;
  directories: Record<string, DirectoryDigestV1>;
}

export interface IndexedFileV1 {
  path: string;
  language: string;
  sizeBytes: number;
  mtimeMs: number;
  contentSha256: string;
  symbols: IndexedSymbolV1[];
  chunks: IndexedChunkV1[];
  /** symbolName → count */
  outgoingSymbolRefs: Record<string, number>;
}

export interface IndexedSymbolV1 {
  name: string;
  kind: SymbolKind;
  signature: string;
  lineStart: number;
  lineEnd: number;
  chunkIds: string[];
}

export interface DirectoryDigestV1 {
  path: string;
  childHashes: Record<string, string>;
  hash: string;
}

// ---------------------------------------------------------------------------
// Cache path
// ---------------------------------------------------------------------------

export const CACHE_PATH = ".tokenlighten/cache/source-index.v1.json";
export const MAX_CACHE_MANIFEST_BYTES = 32 * 1024 * 1024;

export function getCachePath(root: string): string {
  return join(root, ".tokenlighten", "cache", "source-index.v1.json");
}

// ---------------------------------------------------------------------------
// In-process manifest memo
// ---------------------------------------------------------------------------
//
// A server process asks for the same workspace's index many times per task
// (several symbol searches inside one locate, follow-up locates inside one
// pack). The on-disk cache alone cannot absorb that: it re-reads and
// re-validates every file per call, and on repos whose manifest exceeds
// MAX_CACHE_MANIFEST_BYTES it never persists at all, silently turning every
// call into a full rebuild. Memoize the last built manifests keyed by the
// workspace realpath and revalidate with a stat fingerprint (path+size+mtime
// of every enumerated file) — the same trust level as the disk fast path,
// without re-reading file contents. The memoized manifest is returned as a
// shared object; callers treat manifests as read-only.
const MANIFEST_MEMO_MAX_WORKSPACES = 2;

interface ManifestMemoEntry {
  ignoreHash: string;
  statFingerprint: string;
  manifest: SourceIndexManifestV1;
}

const manifestMemo = new Map<string, ManifestMemoEntry>();

/** Reset the in-process manifest memo (for tests). */
export function resetManifestMemoForTest(): void {
  manifestMemo.clear();
}

function statFingerprintOf(
  files: readonly { path: string; sizeBytes: number; mtimeMs: number }[],
): string {
  const lines = files.map((f) => `${f.path}\u0000${f.sizeBytes}\u0000${f.mtimeMs}`).sort();
  return hashContent(Buffer.from(lines.join("\n")));
}

// ---------------------------------------------------------------------------
// JSON serialization with sorted keys
// ---------------------------------------------------------------------------

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value; // preserve array order
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = sortKeys(obj[key]);
  }
  return sorted;
}

// ---------------------------------------------------------------------------
// Load / write manifest
// ---------------------------------------------------------------------------

/**
 * Load the cached manifest from disk.
 * Returns null on any error (missing file, corrupt JSON, shape mismatch).
 */
export async function loadManifest(root: string): Promise<SourceIndexManifestV1 | null> {
  const cachePath = getCachePath(root);
  try {
    assertSafeWriteTarget(root, cachePath);
    const stat = await fs.stat(cachePath);
    if (!stat.isFile() || stat.size > MAX_CACHE_MANIFEST_BYTES) return null;
    const raw = await readRegularFileUtf8(cachePath, MAX_CACHE_MANIFEST_BYTES);
    if (Buffer.byteLength(raw, "utf8") > MAX_CACHE_MANIFEST_BYTES) return null;
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return null;
    }
    if (
      data === null ||
      typeof data !== "object" ||
      (data as Record<string, unknown>).version !== 1 ||
      typeof (data as Record<string, unknown>).engineVersion !== "string" ||
      typeof (data as Record<string, unknown>).files !== "object"
    ) {
      return null;
    }
    return data as SourceIndexManifestV1;
  } catch {
    return null;
  }
}

/**
 * Write the manifest to the cache file atomically.
 * Creates parent directories as needed.
 */
export async function writeManifest(root: string, manifest: SourceIndexManifestV1): Promise<void> {
  const cachePath = getCachePath(root);
  const cacheDir = dirname(cachePath);
  ensureSafeWriteParent(root, cachePath, true);
  assertSafeWriteTarget(root, cachePath);

  const tmpPath = join(cacheDir, `source-index.v1.${process.pid}.${Date.now()}.tmp`);
  // Compact (non-pretty) canonical JSON: readers only ever JSON.parse this
  // file, and pretty-printing a repo-scale manifest roughly doubles both the
  // serialize time and the on-disk bytes counted against
  // MAX_CACHE_MANIFEST_BYTES.
  const serialized = JSON.stringify(sortKeys(manifest));
  if (Buffer.byteLength(serialized, "utf8") > MAX_CACHE_MANIFEST_BYTES) {
    throw new Error("source index manifest exceeds the 32 MiB cache limit");
  }
  await fs.writeFile(tmpPath, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
  ensureSafeWriteParent(root, cachePath, false);
  assertSafeWriteTarget(root, cachePath);
  await fs.rename(tmpPath, cachePath);
}

// ---------------------------------------------------------------------------
// Kind mapping helper
// ---------------------------------------------------------------------------

function symbolKindFromSignature(signature: string): SymbolKind {
  if (/\b(class|interface|struct|enum|trait)\b/.test(signature)) return "class";
  if (/\btype\b/.test(signature)) return "type";
  if (/\b(const|let|var)\b/.test(signature)) return "const";
  return "function";
}

// ---------------------------------------------------------------------------
// Symbol-line validation (P1.3 Skeleton Correctness Gate)
// ---------------------------------------------------------------------------

/**
 * Validate that each cached symbol's name is still findable (word-boundary
 * match) within ±2 lines of its advertised lineStart/lineEnd range.
 *
 * Returns true if all symbols validate (or symbols array is empty).
 * Returns false if any symbol cannot be found on its claimed lines.
 *
 * Deterministic — no Date.now / Math.random.
 */
export function validateCachedSymbols(file: IndexedFileV1, content: string): boolean {
  if (file.symbols.length === 0) return true;

  const lines = content.split(/\r?\n/);

  for (const sym of file.symbols) {
    const lo = Math.max(0, sym.lineStart - 2);
    const hi = Math.min(lines.length, sym.lineEnd + 2);
    const needle = sym.name;

    // Build a word-boundary regex for this symbol name (escape special chars).
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${escaped}\\b`);

    let found = false;
    for (let i = lo; i < hi; i++) {
      if (re.test(lines[i] ?? "")) {
        found = true;
        break;
      }
    }
    if (!found) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// loadOrBuildSourceIndex
// ---------------------------------------------------------------------------

/**
 * Load the source index from cache or rebuild it from scratch.
 *
 * Returns the manifest plus stats:
 *   - reused: number of file entries reused from cache (fast or mid path)
 *   - reparsed: number of file entries that were re-extracted from source
 *   - cacheRebuildReasons: list of reasons why cache entries were rebuilt
 */
export async function loadOrBuildSourceIndex(
  root: string,
  opts: {
    noCache?: boolean;
    commit?: string;
    ignoreHash: string;
    extraIgnorePatterns?: string[];
  },
): Promise<{
  manifest: SourceIndexManifestV1;
  warnings: string[];
  reused: number;
  reparsed: number;
  cacheRebuildReasons: string[];
}> {
  const warnings: string[] = [];
  const cacheRebuildReasons: string[] = [];
  let reused = 0;
  let reparsed = 0;

  const rootKey = await fs.realpath(root).catch(() => root);

  // 1) Try to load cached manifest.
  let cachedManifest: SourceIndexManifestV1 | null = null;
  if (!opts.noCache) {
    cachedManifest = await loadManifest(root);
    // Discard cache if ignoreHash changed.
    if (cachedManifest !== null && cachedManifest.ignoreHash !== opts.ignoreHash) {
      cachedManifest = null;
      cacheRebuildReasons.push("ignore-hash");
    }
    // Discard cache if engineVersion changed.
    if (cachedManifest !== null && cachedManifest.engineVersion !== PKG_VERSION) {
      cachedManifest = null;
      cacheRebuildReasons.push("engine-version");
    }
    // P1.3: Discard cache if repoRootRealpath doesn't match current root (foreign cache).
    if (cachedManifest !== null) {
      if (cachedManifest.repoRootRealpath !== rootKey) {
        cachedManifest = null;
        cacheRebuildReasons.push("foreign-cache");
      }
    }
  }

  // 2) Enumerate files.
  const matcher = await createIgnoreMatcher(root, opts.extraIgnorePatterns);
  const files = await enumerateFiles(root, matcher);

  // 2b) In-process memo: an identical stat fingerprint (and compatible
  // options) means the previously built manifest is still current — skip the
  // per-file reads/validation and the cache/graph writes outright.
  const diskManifest = cachedManifest;
  const statFingerprint = opts.noCache ? "" : statFingerprintOf(files);
  if (!opts.noCache) {
    const memoEntry = manifestMemo.get(rootKey);
    if (
      memoEntry !== undefined &&
      memoEntry.ignoreHash === opts.ignoreHash &&
      memoEntry.statFingerprint === statFingerprint &&
      (opts.commit === undefined || opts.commit === memoEntry.manifest.builtFromCommit)
    ) {
      // Refresh recency (Map insertion order doubles as the LRU order).
      manifestMemo.delete(rootKey);
      manifestMemo.set(rootKey, memoEntry);
      return {
        manifest: memoEntry.manifest,
        warnings: [],
        reused: Object.keys(memoEntry.manifest.files).length,
        reparsed: 0,
        cacheRebuildReasons: [],
      };
    }
    // A stale memo still beats an absent/failed disk cache as the incremental
    // seed: unchanged files take the fast path below instead of a full
    // re-extract when the disk manifest could not be persisted.
    if (cachedManifest === null && memoEntry !== undefined && memoEntry.ignoreHash === opts.ignoreHash) {
      cachedManifest = memoEntry.manifest;
    }
  }

  // 3) Process each file.
  const fileEntries: Record<string, IndexedFileV1> = {};

  for (const f of files) {
    const cached = cachedManifest?.files[f.path];

    // Read file — needed for both hash verification (mid path) and
    // P1.3 symbol-line validation (fast path and mid path).
    let raw: string;
    try {
      raw = await readRegularFileUtf8(f.absPath);
    } catch (e) {
      warnings.push(`skeleton-index: failed to read ${f.path}: ${String(e)}`);
      cacheRebuildReasons.push(`file-read-error:${f.path}`);
      continue;
    }

    // Fast path: cached entry exists and sizeBytes + mtimeMs match.
    // P1.3: still validate symbol-line integrity before accepting the cached entry.
    if (cached && cached.sizeBytes === f.sizeBytes && cached.mtimeMs === f.mtimeMs) {
      if (validateCachedSymbols(cached, raw)) {
        fileEntries[f.path] = cached;
        reused++;
        continue;
      } else {
        // Symbol-line mismatch despite matching mtime/size — cache is corrupted.
        const rawLines = raw.split(/\r?\n/);
        const failingSym = cached.symbols.find((sym) => {
          const lo = Math.max(0, sym.lineStart - 2);
          const hi = Math.min(rawLines.length, sym.lineEnd + 2);
          const escaped = sym.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const re = new RegExp(`\\b${escaped}\\b`);
          for (let i = lo; i < hi; i++) {
            if (re.test(rawLines[i] ?? "")) return false; // found — not the failing sym
          }
          return true; // not found — this is the failing sym
        });
        const symName = failingSym?.name ?? "unknown";
        cacheRebuildReasons.push(`symbol-line-mismatch:${f.path}:${symName}`);
        // Fall through to slow path below.
      }
    }

    const sha = hashContent(Buffer.from(raw));

    // Track content change reason before mid-path check.
    if (cached && sha !== cached.contentSha256) {
      cacheRebuildReasons.push(`file-content-change:${f.path}`);
    }

    // Mid path: cached entry exists and content hash matches.
    // P1.3: also run symbol-line validation before trusting the cached entry.
    if (cached && sha === cached.contentSha256) {
      if (validateCachedSymbols(cached, raw)) {
        fileEntries[f.path] = {
          ...cached,
          sizeBytes: f.sizeBytes,
          mtimeMs: f.mtimeMs,
        };
        reused++;
        continue;
      } else {
        // Symbol-line mismatch — find the first failing symbol name for the reason.
        // A symbol "fails" when its name is NOT found in its claimed line range.
        const rawLines = raw.split(/\r?\n/);
        const failingSym = cached.symbols.find((sym) => {
          const lo = Math.max(0, sym.lineStart - 2);
          const hi = Math.min(rawLines.length, sym.lineEnd + 2);
          const escaped = sym.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const re = new RegExp(`\\b${escaped}\\b`);
          for (let i = lo; i < hi; i++) {
            if (re.test(rawLines[i] ?? "")) return false; // found — not the failing sym
          }
          return true; // not found — this is the failing sym
        });
        const symName = failingSym?.name ?? "unknown";
        // Avoid double-pushing the same reason if already added by the fast-path check.
        if (!cacheRebuildReasons.some((r) => r === `symbol-line-mismatch:${f.path}:${symName}`)) {
          cacheRebuildReasons.push(`symbol-line-mismatch:${f.path}:${symName}`);
        }
      }
    }

    // Slow path: extract symbols and chunks.
    // Text-bearing files (.md/.txt/... — EnumeratedFile.textOnly) get
    // chunked below (extractChunks routes empty-symbols input through
    // makeTextChunks) but must never get symbols or outgoingSymbolRefs —
    // both feed ranking/reference graphs (buildTlGraphFromManifest,
    // mcp-server's buildFileScoresFromManifest) that must stay neutral to
    // doc/config prose. Content is already in hand here — sniff .h files
    // for C++ signals instead of trusting the static extension-only "c"
    // answer, so the PERSISTED index that search_files action=symbols
    // reads from doesn't lock in the wrong grammar for genuinely-C++ .h
    // files. See graph.ts's languageForPathWithContent doc comment.
    const language = f.textOnly
      ? "text"
      : languageForPathWithContent(f.path, raw) ?? f.language ?? languageForPath(f.path) ?? "default";
    let extractedSymbols: import("./graph.js").ExtractedSymbol[];
    if (f.textOnly) {
      extractedSymbols = [];
    } else {
      try {
        extractedSymbols = extractSymbolsRegex(raw, language);
      } catch {
        extractedSymbols = [];
      }
    }

    const chunks = extractChunks({
      path: f.path,
      raw,
      language,
      symbols: extractedSymbols,
    });

    // Build IndexedSymbolV1[]
    // One pass over chunks keyed by base symbol name (the slice suffix is
    // `#<i>`), instead of a per-symbol chunks.filter scan — that pairing was
    // O(symbols × chunks) per file.
    const chunkIdsBySymbolName = new Map<string, string[]>();
    for (const c of chunks) {
      if (c.symbolName === undefined) continue;
      const hashIdx = c.symbolName.indexOf("#");
      const base = hashIdx === -1 ? c.symbolName : c.symbolName.slice(0, hashIdx);
      const ids = chunkIdsBySymbolName.get(base);
      if (ids) ids.push(c.id);
      else chunkIdsBySymbolName.set(base, [c.id]);
    }
    const symbols: IndexedSymbolV1[] = extractedSymbols.map((sym) => {
      const kind = symbolKindFromSignature(sym.signature);
      const chunkIds = chunkIdsBySymbolName.get(sym.name) ?? [];
      return {
        name: sym.name,
        kind,
        signature: sym.signature,
        lineStart: sym.line,
        lineEnd: sym.endLine,
        chunkIds,
      };
    });

    // outgoingSymbolRefs: count all identifier occurrences. Skipped for
    // textOnly files — prose mentioning a real symbol name (e.g. a README
    // that says "Widget") must not inject a reference edge into
    // buildTlGraphFromManifest's graph.
    const refCounts: Record<string, number> = {};
    if (!f.textOnly) {
      // Iterate the matches lazily — materializing every identifier
      // occurrence of every file into an array first was pure allocation
      // churn on repo-scale builds.
      for (const t of raw.matchAll(/\b[A-Za-z_$][\w$]*\b/g)) {
        const tok = t[0]!;
        refCounts[tok] = (refCounts[tok] ?? 0) + 1;
      }
    }

    fileEntries[f.path] = {
      path: f.path,
      language,
      sizeBytes: f.sizeBytes,
      mtimeMs: f.mtimeMs,
      contentSha256: sha,
      symbols,
      chunks,
      outgoingSymbolRefs: refCounts,
    };
    reparsed++;
  }

  // 4) Sort file entries by key.
  const sortedFiles: Record<string, IndexedFileV1> = {};
  for (const key of Object.keys(fileEntries).sort()) {
    sortedFiles[key] = fileEntries[key]!;
  }

  // 5) Build directory digests.
  const { root: rootHash, directories } = buildDirectoryDigests(Object.values(sortedFiles));

  // 6) Resolve commit.
  let commit: string;
  if (opts.commit) {
    commit = opts.commit;
  } else {
    try {
      const { stdout } = await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"], {
        timeout: 5000,
      });
      commit = stdout.trim().slice(0, 40);
    } catch {
      commit = "unknown";
    }
  }

  // 7) Resolve repoRootRealpath (resolved once at the top).
  const repoRootRealpath = rootKey;

  // 8) Assemble manifest.
  const manifest: SourceIndexManifestV1 = {
    version: 1,
    engineVersion: PKG_VERSION,
    repoRootRealpath,
    ignoreHash: opts.ignoreHash,
    builtFromCommit: commit,
    rootHash,
    files: sortedFiles,
    directories,
  };

  // 9) Write cache (unless noCache). Skip the rewrite when the disk cache
  // already holds this exact index content (only stat metadata could have
  // been refreshed) — serializing a repo-scale manifest per call is a real
  // cost, and the next reader re-derives freshness from content hashes.
  const diskCacheCurrent = diskManifest !== null
    && reparsed === 0
    && manifest.rootHash === diskManifest.rootHash;
  if (!opts.noCache && !diskCacheCurrent) {
    try {
      await writeManifest(root, manifest);
    } catch (e) {
      warnings.push(`skeleton-index: failed to write cache: ${String(e)}`);
    }
  }

  // 10) Build/refresh tl-graph.json (unless noCache).
  if (!opts.noCache) {
    try {
      await writeGraphIfStale(root, manifest);
    } catch (e) {
      warnings.push(`skeleton-index: failed to write graph index: ${String(e)}`);
    }
  }

  if (!opts.noCache) {
    manifestMemo.delete(rootKey);
    if (manifestMemo.size >= MANIFEST_MEMO_MAX_WORKSPACES) {
      const oldest = manifestMemo.keys().next().value;
      if (oldest !== undefined) manifestMemo.delete(oldest);
    }
    manifestMemo.set(rootKey, { ignoreHash: opts.ignoreHash, statFingerprint, manifest });
  }

  return { manifest, warnings, reused, reparsed, cacheRebuildReasons };
}
