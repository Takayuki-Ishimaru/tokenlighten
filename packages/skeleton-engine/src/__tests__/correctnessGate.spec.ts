// P1.3 Skeleton Correctness Gate — unit tests
//
// (a) Foreign cache rejected when repoRootRealpath doesn't match current root.
// (b) Symbol-line mismatch triggers re-parse of just that file.
// (c) Hash-patched corruption caught by symbol-line validation.
// (d) No-op fast path: second build with no changes emits no rebuild reasons.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadOrBuildSourceIndex,
  resetManifestMemoForTest,
  validateCachedSymbols,
  loadManifest,
  writeManifest,
} from "../indexStore.js";
import type { IndexedFileV1, SourceIndexManifestV1 } from "../indexStore.js";
import { hashContent } from "../merkle.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = join(
    tmpdir(),
    `correctness-gate-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await fs.mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const IGNORE_HASH = "test-ignore-hash";

async function buildIndex(dir: string) {
  return loadOrBuildSourceIndex(dir, {
    noCache: false,
    commit: "test-commit",
    ignoreHash: IGNORE_HASH,
  });
}

// ---------------------------------------------------------------------------
// validateCachedSymbols unit tests
// ---------------------------------------------------------------------------

describe("validateCachedSymbols", () => {
  it("returns true when symbols array is empty (config-file case)", () => {
    const file: IndexedFileV1 = {
      path: "a.json",
      language: "json",
      sizeBytes: 2,
      mtimeMs: 0,
      contentSha256: "x",
      symbols: [],
      chunks: [],
      outgoingSymbolRefs: {},
    };
    expect(validateCachedSymbols(file, '{ "a": 1 }')).toBe(true);
  });

  it("returns true when symbol name found on its claimed line", () => {
    const content = [
      "// line 0",
      "export function findAll(): Promise<Issue[]> {",
      "  return [];",
      "}",
    ].join("\n");
    const file: IndexedFileV1 = {
      path: "repo.ts",
      language: "typescript",
      sizeBytes: content.length,
      mtimeMs: 0,
      contentSha256: "x",
      symbols: [
        {
          name: "findAll",
          kind: "function",
          signature: "export function findAll(): Promise<Issue[]>",
          lineStart: 1,
          lineEnd: 3,
          chunkIds: [],
        },
      ],
      chunks: [],
      outgoingSymbolRefs: {},
    };
    expect(validateCachedSymbols(file, content)).toBe(true);
  });

  it("returns false when symbol name no longer appears in its line range", () => {
    const content = [
      "// line 0",
      "export function query(): Promise<Issue[]> {", // renamed from findAll
      "  return [];",
      "}",
    ].join("\n");
    const file: IndexedFileV1 = {
      path: "repo.ts",
      language: "typescript",
      sizeBytes: content.length,
      mtimeMs: 0,
      contentSha256: "x",
      symbols: [
        {
          name: "findAll",
          kind: "function",
          signature: "export function findAll(): Promise<Issue[]>",
          lineStart: 1,
          lineEnd: 3,
          chunkIds: [],
        },
      ],
      chunks: [],
      outgoingSymbolRefs: {},
    };
    expect(validateCachedSymbols(file, content)).toBe(false);
  });

  it("tolerates ±2 line shift (minor edits)", () => {
    // Symbol declared at lineStart=5, but we insert 2 blank lines above it.
    const content = [
      "// line 0",
      "",
      "",
      "// line 3",
      "// line 4",
      "export function findAll(): Promise<Issue[]> {", // now at line 5
      "  return [];",
      "}",
    ].join("\n");
    const file: IndexedFileV1 = {
      path: "repo.ts",
      language: "typescript",
      sizeBytes: content.length,
      mtimeMs: 0,
      contentSha256: "x",
      symbols: [
        {
          name: "findAll",
          kind: "function",
          signature: "export function findAll(): Promise<Issue[]>",
          // Cached at line 3, actual now at 5 — within ±2
          lineStart: 3,
          lineEnd: 7,
          chunkIds: [],
        },
      ],
      chunks: [],
      outgoingSymbolRefs: {},
    };
    expect(validateCachedSymbols(file, content)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe("correctnessGate — foreign cache rejected (a)", () => {
  it("rejects a cache whose repoRootRealpath differs from the current root", async () => {
    // Set up dirA with a source file and build a valid index.
    const dirA = join(tmpDir, "dirA");
    await fs.mkdir(join(dirA, "src"), { recursive: true });
    await fs.writeFile(
      join(dirA, "src", "a.ts"),
      "export function hello() { return 1; }\n",
      "utf8",
    );

    const first = await buildIndex(dirA);
    expect(first.manifest.repoRootRealpath).toBeTruthy();

    // Now inject a manifest that claims a different repoRootRealpath ("/foreign/root").
    const foreignManifest: SourceIndexManifestV1 = {
      ...first.manifest,
      repoRootRealpath: "/foreign/root/that/does/not/exist",
    };
    await writeManifest(dirA, foreignManifest);
    // Clear the in-process memo: this test asserts the DISK-cache trust gate,
    // i.e. what a fresh process would read — the memo would otherwise
    // legitimately serve this process's own last build (stats unchanged).
    resetManifestMemoForTest();

    // Reload — should detect foreign cache and rebuild.
    const second = await buildIndex(dirA);

    // The rebuilt manifest's realpath should match dirA (not the foreign path).
    const realDirA = await fs.realpath(dirA);
    expect(second.manifest.repoRootRealpath).toBe(realDirA);

    // cacheRebuildReasons should contain "foreign-cache".
    expect(second.cacheRebuildReasons).toContain("foreign-cache");

    // Everything was re-parsed (not reused from foreign cache).
    expect(second.reparsed).toBeGreaterThan(0);
  });
});

describe("correctnessGate — symbol-line mismatch triggers re-parse (b)", () => {
  it("re-parses the file when cached lineStart points at a blank line", async () => {
    const srcDir = join(tmpDir, "src");
    await fs.mkdir(srcDir, { recursive: true });
    const filePath = join(srcDir, "repo.ts");
    const src = [
      "// comment",
      "export function findAll(): Promise<Issue[]> {",
      "  return [];",
      "}",
    ].join("\n") + "\n";
    await fs.writeFile(filePath, src, "utf8");

    // First build — correct index.
    await buildIndex(tmpDir);

    // Load the manifest and corrupt one symbol's lineStart to point at line 0
    // ("// comment"), simulating a parser bug that put the symbol on the wrong line.
    // We set lineStart and lineEnd both to 0 which has no word "findAll".
    const manifest = await loadManifest(tmpDir);
    expect(manifest).not.toBeNull();
    const relPath = "src/repo.ts";
    const fileEntry = manifest!.files[relPath];
    expect(fileEntry).toBeDefined();
    expect(fileEntry!.symbols.length).toBeGreaterThan(0);

    // Move lineStart/lineEnd to line 99 (out-of-range, no such content).
    const corruptedEntry: IndexedFileV1 = {
      ...fileEntry!,
      symbols: fileEntry!.symbols.map((sym) => ({
        ...sym,
        lineStart: 99,
        lineEnd: 102,
      })),
    };
    const corruptedManifest: SourceIndexManifestV1 = {
      ...manifest!,
      files: { ...manifest!.files, [relPath]: corruptedEntry },
    };
    await writeManifest(tmpDir, corruptedManifest);
    // Clear the in-process memo — same reasoning as the foreign-cache test:
    // the symbol-line gate guards the DISK cache a fresh process would load.
    resetManifestMemoForTest();

    // Second build — symbol-line validation should catch the mismatch.
    const second = await buildIndex(tmpDir);

    // The file should have been re-parsed.
    expect(second.reparsed).toBeGreaterThan(0);

    // The rebuilt entry's symbols should now be on correct lines.
    const rebuilt = second.manifest.files[relPath];
    expect(rebuilt).toBeDefined();
    const findAllSym = rebuilt!.symbols.find((s) => s.name === "findAll");
    expect(findAllSym).toBeDefined();
    // lineStart should be near line 1 (0-indexed)
    expect(findAllSym!.lineStart).toBeLessThan(10);

    // Should have a rebuild reason mentioning symbol-line-mismatch.
    const hasMismatchReason = second.cacheRebuildReasons.some((r) =>
      r.startsWith("symbol-line-mismatch:"),
    );
    expect(hasMismatchReason).toBe(true);
  });
});

describe("correctnessGate — hash-patched corruption caught (c)", () => {
  it("catches stale symbol after manual file rename + hash patch", async () => {
    const srcDir = join(tmpDir, "src");
    await fs.mkdir(srcDir, { recursive: true });
    const filePath = join(srcDir, "repo.ts");

    const originalSrc =
      "export function findAll(): Promise<Issue[]> {\n  return [];\n}\n";
    await fs.writeFile(filePath, originalSrc, "utf8");

    // Build index with original content.
    await buildIndex(tmpDir);

    // Rename symbol in the file: findAll → query.
    const newSrc = "export function query(): Promise<Issue[]> {\n  return [];\n}\n";
    await fs.writeFile(filePath, newSrc, "utf8");

    // Patch the cached manifest so contentSha256 matches the NEW content
    // (simulating corruption where hash was updated but symbol metadata was not).
    const newHash = hashContent(Buffer.from(newSrc));
    const manifest = await loadManifest(tmpDir);
    expect(manifest).not.toBeNull();
    const relPath = "src/repo.ts";
    const fileEntry = manifest!.files[relPath];
    expect(fileEntry).toBeDefined();

    const patchedEntry: IndexedFileV1 = {
      ...fileEntry!,
      contentSha256: newHash, // hash matches new content
      // but symbols still say "findAll" — stale metadata
    };
    const patchedManifest: SourceIndexManifestV1 = {
      ...manifest!,
      files: { ...manifest!.files, [relPath]: patchedEntry },
    };
    await writeManifest(tmpDir, patchedManifest);

    // Third build: hash matches new content, but symbol-line validation
    // should catch that "findAll" is no longer present.
    const result = await buildIndex(tmpDir);

    // Must have re-parsed.
    expect(result.reparsed).toBeGreaterThan(0);

    // Resulting symbol set must contain "query", not "findAll".
    const rebuilt = result.manifest.files[relPath];
    expect(rebuilt).toBeDefined();
    const querySymbol = rebuilt!.symbols.find((s) => s.name === "query");
    const findAllSymbol = rebuilt!.symbols.find((s) => s.name === "findAll");
    expect(querySymbol).toBeDefined();
    expect(findAllSymbol).toBeUndefined();
  });
});

describe("correctnessGate — no-op fast path (d)", () => {
  it("second build emits no per-file rebuild reasons when nothing changed", async () => {
    const srcDir = join(tmpDir, "src");
    await fs.mkdir(srcDir, { recursive: true });
    await fs.writeFile(
      join(srcDir, "a.ts"),
      "export function hello() { return 1; }\n",
      "utf8",
    );
    await fs.writeFile(
      join(srcDir, "b.ts"),
      "export const VALUE = 42;\n",
      "utf8",
    );

    // First build.
    await buildIndex(tmpDir);

    // Second build — nothing changed.
    const second = await buildIndex(tmpDir);

    expect(second.reparsed).toBe(0);
    expect(second.reused).toBeGreaterThan(0);

    // No per-file rebuild reasons (file-content-change / symbol-line-mismatch)
    // should be emitted.
    const perFileReasons = second.cacheRebuildReasons.filter((r) =>
      r.startsWith("file-content-change:") ||
      r.startsWith("symbol-line-mismatch:") ||
      r.startsWith("file-read-error:"),
    );
    expect(perFileReasons).toHaveLength(0);
  });
});
