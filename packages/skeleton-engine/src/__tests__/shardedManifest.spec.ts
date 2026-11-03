/**
 * shardedManifest.spec.ts — the sharded on-disk source index (2026-11-03): a
 * manifest over the single-file cap is persisted in gzip pieces so a new
 * process reloads it instead of re-extracting the workspace.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";

import {
  getCachePath,
  loadManifest,
  loadOrBuildSourceIndex,
  resetManifestMemoForTest,
  resetManifestTooLargeMemo,
  writeManifest,
} from "../indexStore.js";
import type { IndexedFileV1, SourceIndexManifestV1 } from "../indexStore.js";
import {
  SHARD_COUNT,
  getShardedCacheDir,
  loadShardedManifest,
  removeShardedManifest,
  writeShardedManifest,
} from "../shardedManifest.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "shardedManifest-test-")));
  resetManifestMemoForTest();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  resetManifestMemoForTest();
  resetManifestTooLargeMemo();
});

function fileEntry(path: string, sha = `sha-${path}`): IndexedFileV1 {
  return {
    path,
    language: "typescript",
    sizeBytes: 10,
    mtimeMs: 1,
    contentSha256: sha,
    symbols: [{ name: `fn_${path.replace(/\W/g, "_")}`, kind: "function", signature: `function f() // ${path}`, lineStart: 1, lineEnd: 2, chunkIds: [] }],
    chunks: [],
    outgoingSymbolRefs: { f: 1 },
  };
}

function manifestOf(count: number, overrides: Partial<SourceIndexManifestV1> = {}): SourceIndexManifestV1 {
  const files: Record<string, IndexedFileV1> = {};
  for (let i = 0; i < count; i++) {
    const path = `src/dir${i % 7}/file-${i}.ts`;
    files[path] = fileEntry(path);
  }
  return {
    version: 1,
    engineVersion: "0.0.0+test",
    repoRootRealpath: tmpDir,
    ignoreHash: "h",
    builtFromCommit: "c",
    rootHash: "root-1",
    generation: 3,
    files,
    directories: { src: { path: "src", childHashes: { a: "b" }, hash: "d" } },
    ...overrides,
  };
}

const dir = (): string => getShardedCacheDir(tmpDir);
const headPath = (): string => join(dir(), "head.json");
const pieces = async (): Promise<string[]> => (await fs.readdir(dir())).filter((name) => name.endsWith(".json.gz")).sort();
async function readHead(): Promise<{ fileCount: number; shards: Array<{ name: string; bytes: number }>; directories: { name: string; bytes: number } }> {
  return JSON.parse(await fs.readFile(headPath(), "utf8"));
}

describe("writeShardedManifest / loadShardedManifest", () => {
  it("round-trips a manifest spread over many buckets, keys and all", async () => {
    const manifest = manifestOf(300);
    await writeShardedManifest(tmpDir, manifest);
    const head = await readHead();
    expect(head.fileCount).toBe(300);
    expect(head.shards.length).toBeGreaterThan(1);
    expect(head.shards.length).toBeLessThanOrEqual(SHARD_COUNT);
    expect(await pieces()).toEqual([head.directories.name, ...head.shards.map((piece) => piece.name)].sort());
    await expect(loadShardedManifest(tmpDir)).resolves.toEqual(manifest);
  });

  it("rewrites only the bucket whose file changed, and removes the piece it replaced", async () => {
    const before = manifestOf(300);
    await writeShardedManifest(tmpDir, before);
    const piecesBefore = await pieces();

    const changedPath = "src/dir3/file-10.ts";
    const after = manifestOf(300);
    after.files[changedPath] = fileEntry(changedPath, "sha-changed");
    const spy = vi.spyOn(JSON, "stringify");
    try {
      await writeShardedManifest(tmpDir, after);
      const pieceCalls = spy.mock.calls.filter(([value]) => value !== null && typeof value === "object" && "files" in (value as object));
      expect(pieceCalls).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
    const piecesAfter = await pieces();
    expect(piecesAfter.filter((name) => !piecesBefore.includes(name))).toHaveLength(1);
    expect(piecesBefore.filter((name) => !piecesAfter.includes(name))).toHaveLength(1);
    await expect(loadShardedManifest(tmpDir)).resolves.toEqual(after);
  });

  it("a stat-only change (mtime) is a new piece too: what a piece holds is what its name hashes", async () => {
    await writeShardedManifest(tmpDir, manifestOf(50));
    const touched = manifestOf(50);
    touched.files["src/dir0/file-0.ts"] = { ...touched.files["src/dir0/file-0.ts"]!, mtimeMs: 2 };
    await writeShardedManifest(tmpDir, touched);
    await expect(loadShardedManifest(tmpDir)).resolves.toEqual(touched);
  });

  it("loads nothing when the cache is absent", async () => {
    await expect(loadShardedManifest(tmpDir)).resolves.toBeNull();
  });

  describe("any damaged or inconsistent piece loads as null (the cache is only a seed)", () => {
    beforeEach(async () => {
      await writeShardedManifest(tmpDir, manifestOf(120));
    });

    it("a missing piece", async () => {
      const head = await readHead();
      await fs.unlink(join(dir(), head.shards[0]!.name));
      await expect(loadShardedManifest(tmpDir)).resolves.toBeNull();
    });

    it("a piece that is not gzip", async () => {
      const head = await readHead();
      await fs.writeFile(join(dir(), head.shards[0]!.name), "not gzip");
      await expect(loadShardedManifest(tmpDir)).resolves.toBeNull();
    });

    it("a piece whose size differs from the head's", async () => {
      const head = await readHead();
      head.shards[0]!.bytes += 1;
      await fs.writeFile(headPath(), JSON.stringify(head));
      await expect(loadShardedManifest(tmpDir)).resolves.toBeNull();
    });

    it("a head whose fileCount differs from what the pieces hold", async () => {
      const head = await readHead();
      head.fileCount += 1;
      await fs.writeFile(headPath(), JSON.stringify(head));
      await expect(loadShardedManifest(tmpDir)).resolves.toBeNull();
    });

    it("an entry filed under another path", async () => {
      const head = await readHead();
      const piece = head.shards[0]!;
      const body = JSON.stringify({ files: { "src/elsewhere.ts": fileEntry("src/not-this-one.ts") } });
      await fs.writeFile(join(dir(), piece.name), gzipSync(body));
      piece.bytes = Buffer.byteLength(body);
      await fs.writeFile(headPath(), JSON.stringify(head));
      await expect(loadShardedManifest(tmpDir)).resolves.toBeNull();
    });

    it("a head naming a piece outside the cache directory", async () => {
      const head = await readHead();
      head.shards[0]!.name = "../../../escape.json.gz";
      await fs.writeFile(headPath(), JSON.stringify(head));
      await expect(loadShardedManifest(tmpDir)).resolves.toBeNull();
    });

    it("a head that is not JSON", async () => {
      await fs.writeFile(headPath(), "{ broken");
      await expect(loadShardedManifest(tmpDir)).resolves.toBeNull();
    });
  });

  it("a crash before the head's rename leaves the previous head and its pieces loadable", async () => {
    const first = manifestOf(80);
    await writeShardedManifest(tmpDir, first);
    const second = manifestOf(80, { rootHash: "root-2" });
    second.files["src/dir1/file-1.ts"] = fileEntry("src/dir1/file-1.ts", "sha-new");
    await expect(writeShardedManifest(tmpDir, second, { beforeRename: () => { throw new Error("crash"); } }))
      .rejects.toThrow("crash");
    await expect(loadShardedManifest(tmpDir)).resolves.toEqual(first);
    // The next publish succeeds and drops the pieces neither head kept.
    await writeShardedManifest(tmpDir, second);
    await expect(loadShardedManifest(tmpDir)).resolves.toEqual(second);
    const head = await readHead();
    expect(await pieces()).toEqual([head.directories.name, ...head.shards.map((piece) => piece.name)].sort());
  });

  it("removes an orphaned temp file once it is old, and keeps a fresh one", async () => {
    await writeShardedManifest(tmpDir, manifestOf(10));
    const old = join(dir(), "b01-orphan.json.gz.123.456.tmp");
    const fresh = join(dir(), "b02-inflight.json.gz.123.789.tmp");
    await fs.writeFile(old, "x");
    await fs.writeFile(fresh, "x");
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    await fs.utimes(old, hourAgo, hourAgo);
    await writeShardedManifest(tmpDir, manifestOf(11));
    await expect(fs.stat(old)).rejects.toThrow();
    await expect(fs.stat(fresh)).resolves.toBeTruthy();
  });

  it("removeShardedManifest removes the head and every piece", async () => {
    await writeShardedManifest(tmpDir, manifestOf(40));
    await removeShardedManifest(tmpDir);
    await expect(fs.readdir(dir())).resolves.toEqual([]);
    await expect(loadShardedManifest(tmpDir)).resolves.toBeNull();
  });

  it("loadManifest reads the sharded cache when there is no single-file cache, and writeManifest of a small manifest replaces it", async () => {
    const big = manifestOf(30);
    await writeShardedManifest(tmpDir, big);
    await expect(loadManifest(tmpDir)).resolves.toEqual(big);
    const small = manifestOf(2, { builtFromCommit: "small" });
    await writeManifest(tmpDir, small);
    await expect(fs.stat(getCachePath(tmpDir))).resolves.toBeTruthy();
    await expect(fs.stat(headPath())).rejects.toThrow();
    await expect(loadManifest(tmpDir)).resolves.toMatchObject({ builtFromCommit: "small" });
  });
});

describe("loadOrBuildSourceIndex with the sharded cache", () => {
  async function seedWorkspace(): Promise<void> {
    await fs.mkdir(join(tmpDir, "src"), { recursive: true });
    for (let i = 0; i < 12; i++) {
      await fs.writeFile(join(tmpDir, "src", `m${i}.ts`), `export function fn${i}() { return ${i}; }\n`, "utf8");
    }
  }

  it("a fresh process (no memo) seeds from the sharded cache: nothing re-extracts and nothing is rewritten", async () => {
    await seedWorkspace();
    const first = await loadOrBuildSourceIndex(tmpDir, { commit: "c", ignoreHash: "h" });
    expect(first.reparsed).toBe(12);
    // Move the cache into the sharded form, as an oversized workspace has it.
    await writeShardedManifest(tmpDir, first.manifest);
    await fs.unlink(getCachePath(tmpDir));
    const headBefore = await fs.stat(headPath());

    resetManifestMemoForTest();
    const second = await loadOrBuildSourceIndex(tmpDir, { commit: "c", ignoreHash: "h" });
    expect(second.reparsed).toBe(0);
    expect(second.reused).toBe(12);
    expect(second.manifest.files).toEqual(first.manifest.files);
    // The disk cache already held this content: no rewrite, no single-file cache.
    await expect(fs.stat(getCachePath(tmpDir))).rejects.toThrow();
    expect((await fs.stat(headPath())).mtimeMs).toBe(headBefore.mtimeMs);
  });

  it("a usable memo is the seed: the disk cache is not consulted, and an unchanged index is not rewritten", async () => {
    await seedWorkspace();
    const first = await loadOrBuildSourceIndex(tmpDir, { commit: "c", ignoreHash: "h" });
    // A foreign cache on disk, as another root's process might leave it.
    await writeManifest(tmpDir, { ...first.manifest, repoRootRealpath: "/somewhere/else" });
    // A stat-only change: the memo's whole-match shortcut misses, its seed still serves.
    const touched = join(tmpDir, "src", "m0.ts");
    const later = new Date(Date.now() + 5000);
    await fs.utimes(touched, later, later);

    const second = await loadOrBuildSourceIndex(tmpDir, { commit: "c", ignoreHash: "h" });
    expect(second.cacheRebuildReasons).not.toContain("foreign-cache");
    expect(second.reparsed).toBe(0);
    expect(second.reused).toBe(12);
    // This process wrote that rootHash itself: no rewrite (the foreign file stays).
    await expect(loadManifest(tmpDir)).resolves.toMatchObject({ repoRootRealpath: "/somewhere/else" });

    // A fresh process (no memo) does read the disk cache, and refuses it.
    resetManifestMemoForTest();
    const third = await loadOrBuildSourceIndex(tmpDir, { commit: "c", ignoreHash: "h" });
    expect(third.cacheRebuildReasons).toContain("foreign-cache");
  });
});
