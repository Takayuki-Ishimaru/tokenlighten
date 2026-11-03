// Plain data only — no meta envelope, no 'tokenlighten:meta' wrappers.
// Reason: docs/00-postmortem.md §2.2

/**
 * shardedManifest.ts — the on-disk source index of a workspace whose manifest
 * is larger than the single-file cache allows (indexStore.ts
 * `MAX_CACHE_MANIFEST_BYTES`, 32 MiB).
 *
 * WHY (2026-11-03, measured on TokenLighten itself: 4.5k files, a 119 MB
 * manifest). Such a manifest was never written, so every new server process
 * re-extracted the whole workspace (12–23 s) and a session's first task pack
 * answered without symbols (`coverage_reason:"index-warming"`). Persisted
 * here, a new process reloads it and only re-hashes the files.
 *
 * LAYOUT. `.tokenlighten/cache/source-index.v1.shards/`:
 *   - `head.json`: the manifest's scalar fields, `fileCount`, and the name and
 *     uncompressed size of every piece below;
 *   - `b<NN>-<key>.json.gz`: the `files` entries of one of SHARD_COUNT buckets
 *     (bucket = FNV-1a of the path), gzip-compressed;
 *   - `dirs-<key>.json.gz`: `directories`.
 * A piece's `<key>` hashes what its entries are a function of (the engine
 * version and, per file, path, content hash, size, mtime and parse status;
 * `rootHash` for `directories`), so a rebuild that changed one file rewrites
 * one bucket: a piece the previous head already names is not serialized again.
 *
 * PUBLICATION. Pieces first (each write-tmp-then-rename through atomicJson.ts),
 * `head.json` last, then the pieces the new head does not name are removed,
 * best-effort. A reader that loses a race with that removal finds a piece
 * missing and gets no cache, never a mixed manifest: the head names exact
 * pieces with exact sizes, and `fileCount` must match what they hold.
 *
 * TRUST. The same as the single-file cache: a load is only a seed.
 * loadOrBuildSourceIndex re-reads every file and reuses an entry only when its
 * content hash matches, so a stale, foreign or tampered piece costs a rebuild,
 * never a wrong symbol. Any failure here loads as `null`.
 *
 * COST. gzip and gunzip run in libuv's thread pool and JSON work is per piece,
 * so the event loop is never held for the whole manifest at once.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";

import { writeJsonAtomic, type AtomicJsonWriteHooks } from "./atomicJson.js";
import type { DirectoryDigestV1, IndexedFileV1, SourceIndexManifestV1 } from "./indexStore.js";
import { hashContent } from "./merkle.js";
import { readRegularFileBytes, readRegularFileUtf8 } from "./readGuard.js";
import { assertSafeWriteTarget } from "./safeWritePath.js";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export const SHARDED_CACHE_DIR = ".tokenlighten/cache/source-index.v1.shards";
export const SHARD_COUNT = 64;
/** The whole sharded manifest, uncompressed. */
export const MAX_SHARDED_MANIFEST_BYTES = 1024 * 1024 * 1024;
/** One piece, uncompressed: far below V8's string length limit. */
export const MAX_SHARD_BYTES = 256 * 1024 * 1024;

const HEAD_FILE = "head.json";
const MAX_HEAD_BYTES = 1024 * 1024;
const PIECE_NAME = /^(?:b\d{2}|dirs)-[0-9a-f]{32}\.json\.gz$/;
const READ_CONCURRENCY = 4;
/** An orphaned temp file (a writer killed mid-publish) is removed once older than this. */
const ORPHAN_TMP_AGE_MS = 10 * 60 * 1000;

interface ShardPieceV1 {
  name: string;
  /** Uncompressed bytes; a load requires exactly this many. */
  bytes: number;
}

interface ShardedHeadV1 {
  version: 1;
  format: "sharded-gzip";
  engineVersion: string;
  repoRootRealpath: string;
  ignoreHash: string;
  builtFromCommit: string;
  rootHash: string;
  generation?: number;
  fileCount: number;
  directories: ShardPieceV1;
  shards: ShardPieceV1[];
}

export function getShardedCacheDir(root: string): string {
  return join(root, ".tokenlighten", "cache", "source-index.v1.shards");
}

export function shardedManifestTooLargeError(): Error {
  return new Error("source index manifest exceeds the 1 GiB sharded cache limit");
}

/**
 * Write `manifest` as the sharded cache. Throws `shardedManifestTooLargeError`
 * past MAX_SHARDED_MANIFEST_BYTES (or MAX_SHARD_BYTES for one piece), and any
 * write error; the previous head stands in either case. `hooks.beforeRename`
 * fires before the head's publishing rename only.
 */
export async function writeShardedManifest(
  root: string,
  manifest: SourceIndexManifestV1,
  hooks?: AtomicJsonWriteHooks,
): Promise<void> {
  const dir = getShardedCacheDir(root);
  const previous = await readHead(root);
  const known = new Map<string, number>();
  if (previous !== null) {
    for (const piece of [previous.directories, ...previous.shards]) known.set(piece.name, piece.bytes);
  }

  const buckets: string[][] = Array.from({ length: SHARD_COUNT }, () => []);
  for (const path of Object.keys(manifest.files).sort()) buckets[bucketOf(path)]!.push(path);

  let total = 0;
  const count = (bytes: number): void => {
    total += bytes;
    if (total > MAX_SHARDED_MANIFEST_BYTES) throw shardedManifestTooLargeError();
  };

  const shards: ShardPieceV1[] = [];
  for (let bucket = 0; bucket < SHARD_COUNT; bucket++) {
    const paths = buckets[bucket]!;
    if (paths.length === 0) continue;
    const key = pieceKey([
      manifest.engineVersion,
      ...paths.map((path) => {
        const file = manifest.files[path]!;
        return `${path}\u0000${file.contentSha256}\u0000${file.sizeBytes}\u0000${file.mtimeMs}\u0000${file.parseStatus ?? "ok"}`;
      }),
    ]);
    const name = `b${String(bucket).padStart(2, "0")}-${key}.json.gz`;
    const bytes = await ensurePiece(root, dir, name, known, () => {
      const files: Record<string, IndexedFileV1> = {};
      for (const path of paths) files[path] = manifest.files[path]!;
      return JSON.stringify({ files });
    });
    count(bytes);
    shards.push({ name, bytes });
  }

  const directoriesName = `dirs-${pieceKey([manifest.engineVersion, manifest.rootHash])}.json.gz`;
  const directoriesBytes = await ensurePiece(root, dir, directoriesName, known, () =>
    JSON.stringify({ directories: manifest.directories }));
  count(directoriesBytes);

  const head: ShardedHeadV1 = {
    version: 1,
    format: "sharded-gzip",
    engineVersion: manifest.engineVersion,
    repoRootRealpath: manifest.repoRootRealpath,
    ignoreHash: manifest.ignoreHash,
    builtFromCommit: manifest.builtFromCommit,
    rootHash: manifest.rootHash,
    ...(manifest.generation !== undefined ? { generation: manifest.generation } : {}),
    fileCount: Object.keys(manifest.files).length,
    directories: { name: directoriesName, bytes: directoriesBytes },
    shards,
  };
  await writeJsonAtomic(
    root,
    join(dir, HEAD_FILE),
    JSON.stringify(head),
    (parent) => join(parent, `head.${process.pid}.${Date.now()}.tmp`),
    hooks,
  );
  await removePiecesExcept(root, dir, new Set([directoriesName, ...shards.map((piece) => piece.name)]));
}

/** The sharded cache as a manifest, or `null` when it is absent, oversized, incomplete or malformed. */
export async function loadShardedManifest(root: string): Promise<SourceIndexManifestV1 | null> {
  const head = await readHead(root);
  if (head === null) return null;
  const total = head.shards.reduce((sum, piece) => sum + piece.bytes, head.directories.bytes);
  if (total > MAX_SHARDED_MANIFEST_BYTES) return null;
  const dir = getShardedCacheDir(root);
  try {
    const files: Record<string, IndexedFileV1> = {};
    const pieces = await mapLimit(head.shards, READ_CONCURRENCY, (piece) => readPiece(root, dir, piece));
    for (const data of pieces) {
      const entries = recordField(data, "files");
      if (entries === undefined) return null;
      for (const [path, entry] of Object.entries(entries)) {
        if (asRecord(entry)?.["path"] !== path) return null;
        files[path] = entry as IndexedFileV1;
      }
    }
    if (Object.keys(files).length !== head.fileCount) return null;
    const directories = recordField(await readPiece(root, dir, head.directories), "directories");
    if (directories === undefined) return null;
    return {
      version: 1,
      engineVersion: head.engineVersion,
      repoRootRealpath: head.repoRootRealpath,
      ignoreHash: head.ignoreHash,
      builtFromCommit: head.builtFromCommit,
      rootHash: head.rootHash,
      ...(head.generation !== undefined ? { generation: head.generation } : {}),
      files,
      directories: directories as Record<string, DirectoryDigestV1>,
    };
  } catch {
    return null;
  }
}

/** Remove the sharded cache (head first, so no reader sees a head without its pieces). Best-effort. */
export async function removeShardedManifest(root: string): Promise<void> {
  const dir = getShardedCacheDir(root);
  const headPath = join(dir, HEAD_FILE);
  try {
    assertSafeWriteTarget(root, headPath);
    await fs.unlink(headPath);
  } catch {
    // absent, or not ours to remove
  }
  await removePiecesExcept(root, dir, new Set());
}

function bucketOf(path: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < path.length; i++) {
    hash ^= path.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % SHARD_COUNT;
}

function pieceKey(parts: readonly string[]): string {
  return hashContent(Buffer.from(parts.join("\n"))).slice(0, 32);
}

/** The piece's uncompressed size, writing it unless the previous head already names it and it is on disk. */
async function ensurePiece(
  root: string,
  dir: string,
  name: string,
  known: ReadonlyMap<string, number>,
  serialize: () => string,
): Promise<number> {
  const path = join(dir, name);
  const knownBytes = known.get(name);
  if (knownBytes !== undefined) {
    try {
      assertSafeWriteTarget(root, path);
      if ((await fs.lstat(path)).isFile()) return knownBytes;
    } catch {
      // missing or unusable: write it again below
    }
  }
  const json = serialize();
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > MAX_SHARD_BYTES) throw shardedManifestTooLargeError();
  const compressed = await gzipAsync(json, { level: 1 });
  await writeJsonAtomic(root, path, compressed, (parent) => join(parent, `${name}.${process.pid}.${Date.now()}.tmp`));
  return bytes;
}

async function readHead(root: string): Promise<ShardedHeadV1 | null> {
  try {
    const path = join(getShardedCacheDir(root), HEAD_FILE);
    assertSafeWriteTarget(root, path);
    const data: unknown = JSON.parse(await readRegularFileUtf8(path, MAX_HEAD_BYTES));
    return isHead(data) ? data : null;
  } catch {
    return null;
  }
}

async function readPiece(root: string, dir: string, piece: ShardPieceV1): Promise<unknown> {
  const path = join(dir, piece.name);
  assertSafeWriteTarget(root, path);
  const compressed = await readRegularFileBytes(path, MAX_SHARD_BYTES);
  const raw = await gunzipAsync(compressed, { maxOutputLength: piece.bytes + 1 });
  if (raw.length !== piece.bytes) throw new Error(`sharded index piece ${piece.name}: size mismatch`);
  return JSON.parse(raw.toString("utf8"));
}

async function removePiecesExcept(root: string, dir: string, keep: ReadonlySet<string>): Promise<void> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (keep.has(name)) continue;
    const path = join(dir, name);
    try {
      if (PIECE_NAME.test(name)) {
        assertSafeWriteTarget(root, path);
        await fs.unlink(path);
      } else if (name.endsWith(".tmp") && Date.now() - (await fs.lstat(path)).mtimeMs > ORPHAN_TMP_AGE_MS) {
        assertSafeWriteTarget(root, path);
        await fs.unlink(path);
      }
    } catch {
      // best-effort: a piece a concurrent writer still names, or one already gone
    }
  }
}

function isPiece(value: unknown): value is ShardPieceV1 {
  const piece = asRecord(value);
  return piece !== undefined
    && typeof piece["name"] === "string" && PIECE_NAME.test(piece["name"])
    && Number.isSafeInteger(piece["bytes"]) && (piece["bytes"] as number) >= 0
    && (piece["bytes"] as number) <= MAX_SHARD_BYTES;
}

function isHead(value: unknown): value is ShardedHeadV1 {
  const head = asRecord(value);
  if (head === undefined) return false;
  const shards = head["shards"];
  return head["version"] === 1
    && head["format"] === "sharded-gzip"
    && ["engineVersion", "repoRootRealpath", "ignoreHash", "builtFromCommit", "rootHash"].every((key) => typeof head[key] === "string")
    && (head["generation"] === undefined || Number.isSafeInteger(head["generation"]))
    && Number.isSafeInteger(head["fileCount"]) && (head["fileCount"] as number) >= 0
    && isPiece(head["directories"])
    && Array.isArray(shards) && shards.length <= SHARD_COUNT && shards.every(isPiece);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function recordField(container: unknown, key: string): Record<string, unknown> | undefined {
  return asRecord(asRecord(container)?.[key]);
}

async function mapLimit<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
