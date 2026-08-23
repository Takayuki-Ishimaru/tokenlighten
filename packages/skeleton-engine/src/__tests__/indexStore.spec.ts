import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadManifest,
  writeManifest,
  loadOrBuildSourceIndex,
  invalidateCachedWorkspaceFiles,
  MAX_CACHE_MANIFEST_BYTES,
} from "../indexStore.js";
import type { SourceIndexManifestV1 } from "../indexStore.js";
import { hashContent } from "../merkle.js";
import { searchSymbols as searchIndexSymbols } from "../searchIndex.js";
import type { SearchContext } from "../searchIndex.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
// This suite tests loadOrBuildSourceIndex/the manifestMemo's OWN behavior,
// not the opt-in/opt-out consistency scan (consistencyScan.spec.ts owns
// that) — pin the scan explicitly OFF for every test here so the V10-10
// same-stat-swap tests below keep documenting the RAW, unmitigated
// manifestMemo-shortcut behavior regardless of the scan's own default (on
// since 2026-08-21; see consistencyScan.ts).
const ORIGINAL_SCAN_ENV = process.env["TL_INDEX_CONSISTENCY_SCAN"];

beforeEach(async () => {
  tmpDir = join(
    tmpdir(),
    `indexStore-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await fs.mkdir(tmpDir, { recursive: true });
  process.env["TL_INDEX_CONSISTENCY_SCAN"] = "0";
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  if (ORIGINAL_SCAN_ENV === undefined) delete process.env["TL_INDEX_CONSISTENCY_SCAN"];
  else process.env["TL_INDEX_CONSISTENCY_SCAN"] = ORIGINAL_SCAN_ENV;
});

function makeManifest(overrides: Partial<SourceIndexManifestV1> = {}): SourceIndexManifestV1 {
  return {
    version: 1,
    engineVersion: "0.1.0",
    repoRootRealpath: "/repo",
    ignoreHash: "abc",
    builtFromCommit: "def",
    rootHash: "ghi",
    files: {},
    directories: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests: loadManifest / writeManifest round-trip
// ---------------------------------------------------------------------------

describe("loadManifest / writeManifest", () => {
  it("round-trip: write then load preserves shape", async () => {
    const manifest = makeManifest({ builtFromCommit: "abc123" });
    await writeManifest(tmpDir, manifest);
    const loaded = await loadManifest(tmpDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.version).toBe(1);
    expect(loaded!.engineVersion).toBe("0.1.0");
    expect(loaded!.builtFromCommit).toBe("abc123");
  });

  it("missing file → returns null", async () => {
    const result = await loadManifest(join(tmpDir, "nonexistent-subdir"));
    expect(result).toBeNull();
  });

  it("corrupt JSON → returns null", async () => {
    const cachePath = join(tmpDir, ".tokenlighten", "cache", "source-index.v1.json");
    await fs.mkdir(join(tmpDir, ".tokenlighten", "cache"), { recursive: true });
    await fs.writeFile(cachePath, "{ this is not valid json }", "utf8");
    const result = await loadManifest(tmpDir);
    expect(result).toBeNull();
  });

  it("version mismatch → returns null", async () => {
    const cachePath = join(tmpDir, ".tokenlighten", "cache", "source-index.v1.json");
    await fs.mkdir(join(tmpDir, ".tokenlighten", "cache"), { recursive: true });
    await fs.writeFile(
      cachePath,
      JSON.stringify({ version: 2, engineVersion: "0.1.0", files: {} }),
      "utf8",
    );
    const result = await loadManifest(tmpDir);
    expect(result).toBeNull();
  });

  it("refuses an oversized cache before reading or parsing it", async () => {
    const cachePath = join(tmpDir, ".tokenlighten", "cache", "source-index.v1.json");
    await fs.mkdir(join(tmpDir, ".tokenlighten", "cache"), { recursive: true });
    await fs.writeFile(cachePath, "{}", "utf8");
    await fs.truncate(cachePath, MAX_CACHE_MANIFEST_BYTES + 1);

    await expect(loadManifest(tmpDir)).resolves.toBeNull();
  });

  it("refuses to write a cache through a symlinked parent", async () => {
    const outside = await fs.mkdtemp(join(tmpdir(), "indexStore-outside-"));
    try {
      await fs.symlink(outside, join(tmpDir, ".tokenlighten"), "dir");
      await expect(writeManifest(tmpDir, makeManifest())).rejects.toThrow(/unsafe-write-path/);
      await expect(fs.readdir(outside)).resolves.toEqual([]);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: loadOrBuildSourceIndex with temp fixture
// ---------------------------------------------------------------------------

describe("loadOrBuildSourceIndex", () => {
  it("builds a manifest from a minimal fixture", async () => {
    // Write two small TypeScript files.
    const srcDir = join(tmpDir, "src");
    await fs.mkdir(srcDir, { recursive: true });
    await fs.writeFile(join(srcDir, "a.ts"), "export function hello() { return 1; }\n", "utf8");
    await fs.writeFile(join(srcDir, "b.ts"), "export const VALUE = 42;\n", "utf8");

    const result = await loadOrBuildSourceIndex(tmpDir, {
      noCache: false,
      commit: "test-commit",
      ignoreHash: "test-hash",
    });

    expect(result.manifest.version).toBe(1);
    expect(result.reparsed).toBeGreaterThan(0);
    // Two files parsed.
    expect(result.reparsed + result.reused).toBe(2);
    expect(Object.keys(result.manifest.files).length).toBe(2);
  });

  it("second run reuses cache (reused > 0, reparsed === 0)", async () => {
    const srcDir = join(tmpDir, "src");
    await fs.mkdir(srcDir, { recursive: true });
    await fs.writeFile(join(srcDir, "a.ts"), "export function hello() { return 1; }\n", "utf8");
    await fs.writeFile(join(srcDir, "b.ts"), "export const VALUE = 42;\n", "utf8");

    // First run — builds cache.
    await loadOrBuildSourceIndex(tmpDir, {
      noCache: false,
      commit: "test-commit",
      ignoreHash: "test-hash",
    });

    // Second run — should reuse cache.
    const result2 = await loadOrBuildSourceIndex(tmpDir, {
      noCache: false,
      commit: "test-commit",
      ignoreHash: "test-hash",
    });

    expect(result2.reused).toBeGreaterThan(0);
    expect(result2.reparsed).toBe(0);
  });

  it("noCache=true always reparses", async () => {
    const srcDir = join(tmpDir, "src");
    await fs.mkdir(srcDir, { recursive: true });
    await fs.writeFile(join(srcDir, "a.ts"), "export function hello() { return 1; }\n", "utf8");

    const result = await loadOrBuildSourceIndex(tmpDir, {
      noCache: true,
      commit: "test-commit",
      ignoreHash: "test-hash",
    });

    expect(result.reused).toBe(0);
    expect(result.reparsed).toBe(1);
  });

  it("total files = reused + reparsed", async () => {
    const srcDir = join(tmpDir, "src");
    await fs.mkdir(srcDir, { recursive: true });
    await fs.writeFile(join(srcDir, "a.ts"), "export function a() {}\n", "utf8");
    await fs.writeFile(join(srcDir, "b.ts"), "export function b() {}\n", "utf8");
    await fs.writeFile(join(srcDir, "c.ts"), "export function c() {}\n", "utf8");

    // First run.
    const result1 = await loadOrBuildSourceIndex(tmpDir, {
      noCache: false,
      commit: "c1",
      ignoreHash: "h1",
    });
    expect(result1.reused + result1.reparsed).toBe(3);

    // Second run.
    const result2 = await loadOrBuildSourceIndex(tmpDir, {
      noCache: false,
      commit: "c1",
      ignoreHash: "h1",
    });
    expect(result2.reused + result2.reparsed).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Tests: .h C++ content sniff (Task A — index-side sniffing, index A/B evidence)
// ---------------------------------------------------------------------------
//
// This is the module search_files action=symbols actually reads from
// (mcp-server's searchSymbols.ts calls loadOrBuildSourceIndex, not
// graph.ts's buildFileInputs — that separately feeds buildSkeleton's own
// PageRank/topN pipeline in index.ts). The reviewer-proven bug
// (`class Widget {...}` .h indexing as {"lang":"c","symbols":[]}) is only
// actually fixed if the sniff lands HERE, not only in buildFileInputs —
// see graph.spec.ts's parallel buildFileInputs-level test for the other half.

describe("loadOrBuildSourceIndex — .h C++ content sniff (index A/B evidence)", () => {
  it("A/B: a C++-shaped .h indexes as language=cpp with a non-empty symbol list containing Widget", async () => {
    const srcDir = join(tmpDir, "src");
    await fs.mkdir(srcDir, { recursive: true });
    await fs.writeFile(
      join(srcDir, "widget.h"),
      "#pragma once\nclass Widget { public: void draw(); };\n",
      "utf8",
    );

    const result = await loadOrBuildSourceIndex(tmpDir, {
      noCache: true,
      commit: "test-commit",
      ignoreHash: "test-hash",
    });

    const entry = result.manifest.files["src/widget.h"];
    expect(entry).toBeDefined();
    // "B" (post-fix): sniffed to cpp, not the static extension-only "c" answer.
    expect(entry!.language).toBe("cpp");
    // "B": non-empty symbol list containing Widget — LANG_PATTERNS.c has no
    // class-declaration pattern, so this is only reachable via the cpp sniff.
    // (Pre-fix "A" behavior was language="c", symbols=[] — reviewer's exact repro.)
    expect(entry!.symbols.length).toBeGreaterThan(0);
    expect(entry!.symbols.some((s) => s.name === "Widget")).toBe(true);
  });

  it("a plain C .h (no C++ signal) still indexes as language=c with its symbols", async () => {
    const srcDir = join(tmpDir, "src");
    await fs.mkdir(srcDir, { recursive: true });
    await fs.writeFile(
      join(srcDir, "point.h"),
      "#ifndef POINT_H\n#define POINT_H\n\ntypedef struct Point {\n  int x;\n  int y;\n} Point;\n\nint point_distance(Point a, Point b);\n\n#endif\n",
      "utf8",
    );

    const result = await loadOrBuildSourceIndex(tmpDir, {
      noCache: true,
      commit: "test-commit",
      ignoreHash: "test-hash",
    });

    const entry = result.manifest.files["src/point.h"];
    expect(entry).toBeDefined();
    expect(entry!.language).toBe("c");
    expect(entry!.symbols.some((s) => s.name === "point_distance")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: text-bearing files indexed as chunk-only entries (Task B)
// ---------------------------------------------------------------------------

describe("loadOrBuildSourceIndex — text-bearing files (textOnly, Task B)", () => {
  it("a .md file indexes with chunks but zero symbols and zero outgoingSymbolRefs", async () => {
    const srcDir = join(tmpDir, "src");
    await fs.mkdir(srcDir, { recursive: true });
    await fs.writeFile(join(srcDir, "a.ts"), "export function hello() { return 1; }\n", "utf8");
    await fs.writeFile(
      join(tmpDir, "README.md"),
      "# Demo\n\nThis document mentions hello many times. hello hello hello.\n".repeat(5),
      "utf8",
    );

    const result = await loadOrBuildSourceIndex(tmpDir, {
      noCache: true,
      commit: "test-commit",
      ignoreHash: "test-hash",
    });

    const entry = result.manifest.files["README.md"];
    expect(entry).toBeDefined();
    expect(entry!.language).toBe("text");
    expect(entry!.symbols).toEqual([]);
    expect(entry!.outgoingSymbolRefs).toEqual({});
    expect(entry!.chunks.length).toBeGreaterThan(0);
    expect(entry!.chunks.every((c) => c.kind === "text")).toBe(true);
  });

  it("repeated runs do not self-index the tool's own .tokenlighten/ cache/graph output", async () => {
    // Regression guard for the exact bug this feature introduced during
    // development: TEXT_EXTS added .json as a text-bearing extension, and
    // .tokenlighten/cache/source-index.v1.json + .tokenlighten/index/
    // tl-graph.json (written as a side effect of the FIRST run, INSIDE the
    // indexed root) were not covered by DEFAULT_IGNORE — so a SECOND run
    // would enumerate its own previous cache output as new textOnly
    // entries, growing the manifest without bound. Fixed by adding
    // ".tokenlighten/" to DEFAULT_IGNORE (ignore.ts).
    const srcDir = join(tmpDir, "src");
    await fs.mkdir(srcDir, { recursive: true });
    await fs.writeFile(join(srcDir, "a.ts"), "export function hello() { return 1; }\n", "utf8");
    await fs.writeFile(join(tmpDir, "README.md"), "# Demo\n\nSome prose.\n", "utf8");

    const result1 = await loadOrBuildSourceIndex(tmpDir, {
      noCache: false,
      commit: "test-commit",
      ignoreHash: "test-hash",
    });
    const result2 = await loadOrBuildSourceIndex(tmpDir, {
      noCache: false,
      commit: "test-commit",
      ignoreHash: "test-hash",
    });

    expect(Object.keys(result2.manifest.files).length).toBe(
      Object.keys(result1.manifest.files).length,
    );
    expect(Object.keys(result2.manifest.files).sort()).toEqual(["README.md", "src/a.ts"]);
    for (const path of Object.keys(result2.manifest.files)) {
      expect(path.startsWith(".tokenlighten/")).toBe(false);
    }
  });
});

describe("searchSymbols neutrality — text-bearing files do not change results for code files", () => {
  async function makeRoot(withDocs: boolean): Promise<string> {
    const root = join(
      tmpdir(),
      `indexStore-neutrality-${withDocs ? "docs" : "code"}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await fs.mkdir(join(root, "src"), { recursive: true });
    await fs.writeFile(join(root, "src", "a.ts"), "export function hello() { return 1; }\n", "utf8");
    await fs.writeFile(
      join(root, "src", "b.ts"),
      "export function helloAgain() { return hello() + 1; }\n",
      "utf8",
    );
    if (withDocs) {
      await fs.writeFile(
        join(root, "README.md"),
        "# Demo\n\nThis document talks about hello and helloAgain a lot. hello helloAgain.\n".repeat(10),
        "utf8",
      );
    }
    return root;
  }

  it("identical searchSymbols locations for code files with and without README.md present", async () => {
    const rootCodeOnly = await makeRoot(false);
    const rootWithDocs = await makeRoot(true);
    try {
      const resultA = await loadOrBuildSourceIndex(rootCodeOnly, { noCache: true, commit: "c", ignoreHash: "h" });
      const resultB = await loadOrBuildSourceIndex(rootWithDocs, { noCache: true, commit: "c", ignoreHash: "h" });

      const ctxA: SearchContext = { manifest: resultA.manifest, fileScores: new Map(), recentFiles: new Set() };
      const ctxB: SearchContext = { manifest: resultB.manifest, fileScores: new Map(), recentFiles: new Set() };

      const { locations: locA } = searchIndexSymbols(ctxA, { query: "hello", includeScores: true });
      const { locations: locB } = searchIndexSymbols(ctxB, { query: "hello", includeScores: true });

      expect(locB).toEqual(locA);
      // README.md itself never surfaces as a result.
      expect(locB.some((l) => l.path === "README.md")).toBe(false);
    } finally {
      await fs.rm(rootCodeOnly, { recursive: true, force: true });
      await fs.rm(rootWithDocs, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: in-process manifest memo
// ---------------------------------------------------------------------------

describe("in-process manifest memo", () => {
  async function seedWorkspace(): Promise<void> {
    await fs.mkdir(join(tmpDir, "src"), { recursive: true });
    await fs.writeFile(
      join(tmpDir, "src", "a.ts"),
      "export function hello() { return 1; }\n",
      "utf8",
    );
    await fs.writeFile(
      join(tmpDir, "src", "b.ts"),
      "export function other() { return 2; }\n",
      "utf8",
    );
  }

  it("serves an unchanged workspace from the memo even when the disk cache is absent", async () => {
    await seedWorkspace();
    const first = await loadOrBuildSourceIndex(tmpDir, { commit: "c", ignoreHash: "h" });
    expect(first.reparsed).toBeGreaterThan(0);

    // Simulate a workspace whose manifest could not be persisted (e.g. it
    // exceeds MAX_CACHE_MANIFEST_BYTES): no disk cache at all.
    await fs.rm(join(tmpDir, ".tokenlighten"), { recursive: true, force: true });

    const second = await loadOrBuildSourceIndex(tmpDir, { commit: "c", ignoreHash: "h" });
    expect(second.reparsed).toBe(0);
    expect(second.reused).toBe(Object.keys(first.manifest.files).length);
    expect(second.manifest).toBe(first.manifest); // shared object, not a rebuild
    // The memo hit must not resurrect the cache file either.
    await expect(loadManifest(tmpDir)).resolves.toBeNull();
  });

  it("seeds an incremental rebuild from the memo when the disk cache is absent", async () => {
    await seedWorkspace();
    await loadOrBuildSourceIndex(tmpDir, { commit: "c", ignoreHash: "h" });
    await fs.rm(join(tmpDir, ".tokenlighten"), { recursive: true, force: true });

    // Change exactly one file — only it should re-extract.
    await fs.writeFile(
      join(tmpDir, "src", "a.ts"),
      "export function hello() { return 42; }\n",
      "utf8",
    );
    const rebuilt = await loadOrBuildSourceIndex(tmpDir, { commit: "c", ignoreHash: "h" });
    expect(rebuilt.reparsed).toBe(1);
    expect(rebuilt.reused).toBe(1);
    expect(rebuilt.manifest.files["src/a.ts"]!.symbols[0]!.name).toBe("hello");
  });
});

// ---------------------------------------------------------------------------
// Tests: V10-10 — incremental content-hash index defect fixes
// ---------------------------------------------------------------------------
//
// Two orchestrator-verified stale-index mechanisms, one dangerous reproducer:
//
//   1. The per-file fast path used to accept a cached entry on
//      sizeBytes+mtimeMs match (plus the validateCachedSymbols name
//      heuristic) WITHOUT consulting contentSha256 — fixed by gating the
//      fast path on a content-hash comparison computed from the
//      already-read bytes (zero extra IO).
//   2. The in-process manifestMemo returns the WHOLE memoized manifest on a
//      matching stat fingerprint (path+size+mtime over every enumerated
//      file) before any per-file validation runs at all — so it bypasses
//      fix #1 entirely. Closed by invalidateCachedWorkspaceFiles(), which
//      the mcp-server write path calls after every successful apply.
//
// The dangerous reproducer for both is a same-size/same-mtime in-place
// content swap — forced here via fs.utimes, since an ordinary edit almost
// always changes at least one of size/mtime naturally (proven separately
// below).

describe("V10-10 — content-hash gate defeats a same-size/same-mtime swap", () => {
  const ORIGINAL = "export function hello() { return 1; }\n";
  // Same byte length as ORIGINAL, same symbol name/position — only the
  // return value's single digit differs. validateCachedSymbols' word-boundary
  // name search would find "hello" near the same lines either way, so this
  // shape is NOT caught by the pre-existing P1.3 heuristic alone — only a
  // real content-hash comparison catches it. This is the actual dangerous
  // case: a body-only edit that leaves the symbol's name/line range intact.
  const SWAPPED = "export function hello() { return 9; }\n";

  // fs.utimes accepts atime/mtime as a Number (Unix seconds) or Date; both
  // representations can silently drop the sub-millisecond jitter a real
  // write's mtime carries on some platforms/filesystems (observed
  // empirically: round-tripping a Date-typed mtime through fs.utimes can
  // land a fraction of a millisecond off). A WHOLE-SECOND timestamp has no
  // sub-second component to lose, so pinning to one makes "same size AND
  // same mtime" an exact, platform-independent precondition instead of
  // merely "close" — computed ONCE per test and reused for both utimes
  // calls, so a clock tick crossing a second boundary between them can't
  // introduce a mismatch of its own.
  function wholeSecondMtime(): number {
    return Math.floor(Date.now() / 1000);
  }

  it("without invalidation, the manifestMemo's whole-match shortcut serves the stale manifest object unchanged (documents why the write-path hook is required)", async () => {
    await fs.mkdir(join(tmpDir, "src"), { recursive: true });
    const filePath = join(tmpDir, "src", "a.ts");
    await fs.writeFile(filePath, ORIGINAL, "utf8");
    const pinnedMtimeSec = wholeSecondMtime();
    await fs.utimes(filePath, pinnedMtimeSec, pinnedMtimeSec);

    const first = await loadOrBuildSourceIndex(tmpDir, { commit: "c", ignoreHash: "h" });
    const statBefore = await fs.stat(filePath);
    expect(statBefore.mtimeMs).toBe(pinnedMtimeSec * 1000);

    await fs.writeFile(filePath, SWAPPED, "utf8");
    await fs.utimes(filePath, pinnedMtimeSec, pinnedMtimeSec);
    const statAfter = await fs.stat(filePath);
    expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
    expect(statAfter.size).toBe(statBefore.size);

    // No invalidateCachedWorkspaceFiles call here — the memo has no reason
    // to doubt itself, since every enumerated file's (path,size,mtime)
    // still matches exactly what it saw before.
    const second = await loadOrBuildSourceIndex(tmpDir, { commit: "c", ignoreHash: "h" });
    expect(second.manifest).toBe(first.manifest); // same object — memo hit
    expect(second.reparsed).toBe(0);
    // Confirms the served content is the STALE pre-swap sha (the file on
    // disk now genuinely differs from what this manifest reports).
    expect(second.manifest.files["src/a.ts"]!.contentSha256).not.toBe(
      hashContent(Buffer.from(SWAPPED)),
    );
  });

  it("invalidateCachedWorkspaceFiles + the fast-path content-hash gate together prove FRESH results for the same swap — exercises BOTH layers", async () => {
    await fs.mkdir(join(tmpDir, "src"), { recursive: true });
    const filePath = join(tmpDir, "src", "a.ts");
    await fs.writeFile(filePath, ORIGINAL, "utf8");
    const pinnedMtimeSec = wholeSecondMtime();
    await fs.utimes(filePath, pinnedMtimeSec, pinnedMtimeSec);

    const first = await loadOrBuildSourceIndex(tmpDir, { commit: "c", ignoreHash: "h" });
    expect(first.manifest.files["src/a.ts"]!.symbols[0]!.name).toBe("hello");
    const statBefore = await fs.stat(filePath);

    await fs.writeFile(filePath, SWAPPED, "utf8");
    await fs.utimes(filePath, pinnedMtimeSec, pinnedMtimeSec);
    const statAfter = await fs.stat(filePath);
    expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
    expect(statAfter.size).toBe(statBefore.size);

    // Simulates what the mcp-server write path does after a successful
    // apply (packages/mcp-server/src/write/atomicWrite.ts).
    invalidateCachedWorkspaceFiles(tmpDir);

    const second = await loadOrBuildSourceIndex(tmpDir, { commit: "c", ignoreHash: "h" });

    // Layer 2 (manifestMemo): the whole-match shortcut must have missed —
    // a freshly built manifest object, not the stale `first.manifest`
    // reference the memo would otherwise have returned unchanged.
    expect(second.manifest).not.toBe(first.manifest);

    // Layer 1 (per-file fast path): despite size+mtime BOTH still matching
    // the (now-stale) cached entry the memo seeded the per-file loop with,
    // the content-hash gate caught the mismatch and forced a re-extract —
    // not a validateCachedSymbols-only accept, which this shape would have
    // passed (the name "hello" never changed).
    expect(second.reparsed).toBe(1);
    expect(second.reused).toBe(0);
    expect(second.cacheRebuildReasons).toContain(
      "content-hash-mismatch-despite-stat-match:src/a.ts",
    );

    // The served content is genuinely fresh.
    expect(second.manifest.files["src/a.ts"]!.contentSha256).toBe(
      hashContent(Buffer.from(SWAPPED)),
    );
  });
});

describe("V10-10 — ordinary mutations already bust the stat gates (proven, not assumed)", () => {
  it("an ordinary edit (real fs.writeFile, no forced mtime) busts both the memo fingerprint and the per-file fast path", async () => {
    await fs.mkdir(join(tmpDir, "src"), { recursive: true });
    const filePath = join(tmpDir, "src", "a.ts");
    await fs.writeFile(filePath, "export function hello() { return 1; }\n", "utf8");

    const first = await loadOrBuildSourceIndex(tmpDir, { commit: "c", ignoreHash: "h" });
    expect(first.manifest.files["src/a.ts"]!.symbols[0]!.name).toBe("hello");

    // A real edit — no fs.utimes trickery. Content, byte length, and mtime
    // all change naturally, exactly like a real editor/tool write.
    await fs.writeFile(filePath, "export function helloRenamed() { return 42; }\n", "utf8");

    const second = await loadOrBuildSourceIndex(tmpDir, { commit: "c", ignoreHash: "h" });
    expect(second.manifest).not.toBe(first.manifest); // memo fingerprint busted
    expect(second.reparsed).toBe(1); // per-file fast path busted
    expect(second.reused).toBe(0);
    expect(second.manifest.files["src/a.ts"]!.symbols[0]!.name).toBe("helloRenamed");
  });

  it("a rename (old path gone, new path appears) busts the memo fingerprint and leaves no ghost entry under the old path", async () => {
    await fs.mkdir(join(tmpDir, "src"), { recursive: true });
    const oldPath = join(tmpDir, "src", "old.ts");
    const newPath = join(tmpDir, "src", "new.ts");
    await fs.writeFile(oldPath, "export function hello() { return 1; }\n", "utf8");

    const first = await loadOrBuildSourceIndex(tmpDir, { commit: "c", ignoreHash: "h" });
    expect(first.manifest.files["src/old.ts"]).toBeDefined();

    await fs.rename(oldPath, newPath);

    const second = await loadOrBuildSourceIndex(tmpDir, { commit: "c", ignoreHash: "h" });
    expect(second.manifest).not.toBe(first.manifest); // memo fingerprint busted
    // Ghost acceptance criterion: zero stale references to the deleted path.
    expect(second.manifest.files["src/old.ts"]).toBeUndefined();
    expect(Object.keys(second.manifest.files)).not.toContain("src/old.ts");
    expect(second.manifest.files["src/new.ts"]).toBeDefined();
    expect(second.manifest.files["src/new.ts"]!.symbols[0]!.name).toBe("hello");
  });

  it("a delete removes the file from the very next index read — zero ghost entries", async () => {
    await fs.mkdir(join(tmpDir, "src"), { recursive: true });
    const pathA = join(tmpDir, "src", "a.ts");
    const pathB = join(tmpDir, "src", "b.ts");
    await fs.writeFile(pathA, "export function hello() {}\n", "utf8");
    await fs.writeFile(pathB, "export function world() {}\n", "utf8");

    const first = await loadOrBuildSourceIndex(tmpDir, { commit: "c", ignoreHash: "h" });
    expect(Object.keys(first.manifest.files).sort()).toEqual(["src/a.ts", "src/b.ts"]);

    await fs.unlink(pathA);

    const second = await loadOrBuildSourceIndex(tmpDir, { commit: "c", ignoreHash: "h" });
    expect(second.manifest).not.toBe(first.manifest); // memo fingerprint busted
    expect(second.manifest.files["src/a.ts"]).toBeUndefined(); // no ghost
    expect(Object.keys(second.manifest.files)).toEqual(["src/b.ts"]);
    // The directory digest tree must not carry a ghost reference either.
    expect(JSON.stringify(second.manifest.directories)).not.toContain("a.ts");
  });
});

describe("V10-10 — corrupt manifest safe fallback (end-to-end through loadOrBuildSourceIndex)", () => {
  it("a corrupt on-disk manifest triggers a full rebuild instead of a crash or stale/empty result", async () => {
    await fs.mkdir(join(tmpDir, "src"), { recursive: true });
    await fs.writeFile(join(tmpDir, "src", "a.ts"), "export function hello() { return 1; }\n", "utf8");

    const cacheDir = join(tmpDir, ".tokenlighten", "cache");
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(join(cacheDir, "source-index.v1.json"), "{ this is not valid json", "utf8");

    const result = await loadOrBuildSourceIndex(tmpDir, { commit: "c", ignoreHash: "h" });
    expect(result.manifest.version).toBe(1);
    expect(result.reparsed).toBe(1);
    expect(result.reused).toBe(0);
    expect(result.manifest.files["src/a.ts"]!.symbols[0]!.name).toBe("hello");
  });
});

// ---------------------------------------------------------------------------
// Tests: symbolKindFromSignature kind precedence (F-A1-4)
// ---------------------------------------------------------------------------
//
// symbolKindFromSignature (module-private) used to scan the WHOLE
// signature line for the first class-family keyword (class/interface/
// struct/enum/trait) anywhere in it, so `export const Base = class { ... }`
// misreported kind:"class" — "class" only appears there as part of the
// initializer EXPRESSION, not the keyword that actually declares Base. The
// fix locates the captured name and prefers the declaring keyword
// structurally closest to it. These exercise the real end-to-end pipeline
// (loadOrBuildSourceIndex -> extractSymbolsRegex -> symbolKindFromSignature)
// — the same path search_files action=symbols reads from — since the
// function itself has no export to test directly.

describe("symbolKindFromSignature — kind precedence (F-A1-4)", () => {
  async function kindOf(fileContent: string, relPath: string, symbolName: string): Promise<string | undefined> {
    const srcDir = join(tmpDir, "src");
    await fs.mkdir(srcDir, { recursive: true });
    await fs.writeFile(join(srcDir, relPath), fileContent, "utf8");

    const result = await loadOrBuildSourceIndex(tmpDir, {
      noCache: true,
      commit: "test-commit",
      ignoreHash: "test-hash",
    });
    const entry = result.manifest.files[`src/${relPath}`];
    expect(entry, `expected src/${relPath} to be indexed`).toBeDefined();
    const sym = entry!.symbols.find((s) => s.name === symbolName);
    return sym?.kind;
  }

  it('a const binding assigned an anonymous class expression is "const", not "class"', async () => {
    const kind = await kindOf(
      "export const Base = class {\n  method() { return 1; }\n};\n",
      "base.ts",
      "Base",
    );
    expect(kind).toBe("const");
  });

  it('a let binding assigned an anonymous class expression is also "const" (the fix generalizes beyond const specifically)', async () => {
    const kind = await kindOf(
      "export let Base = class {\n  method() { return 1; }\n};\n",
      "base-let.ts",
      "Base",
    );
    expect(kind).toBe("const");
  });

  it('a plain class declaration is still "class" (regression guard)', async () => {
    const kind = await kindOf("export class Foo {\n  method() {}\n}\n", "foo.ts", "Foo");
    expect(kind).toBe("class");
  });

  it('an interface declaration is "class" (regression guard)', async () => {
    const kind = await kindOf("export interface X {\n  value: string;\n}\n", "x.ts", "X");
    expect(kind).toBe("class");
  });

  it('a type alias is "type", even though its value could in principle mention a class-family word', async () => {
    const kind = await kindOf("export type Y = string;\n", "y.ts", "Y");
    expect(kind).toBe("type");
  });

  it('an enum declaration is "class" (regression guard)', async () => {
    const kind = await kindOf("export enum Z {\n  A,\n  B,\n}\n", "z.ts", "Z");
    expect(kind).toBe("class");
  });

  it('Go: "type Foo struct { ... }" refines a bare "type" to "class" — struct/interface continues the SAME declaration clause, unlike an initializer expression', async () => {
    // No blank line between "package main" and the declaration: a blank
    // line immediately before a LANG_PATTERNS match is a separate,
    // pre-existing defect (the pattern's `^\s*` bridges the blank line's
    // own newline, so the match's reported index anchors there instead of
    // the declaration line, corrupting endLine/signature) — out of scope
    // for F-A1-4 and reported separately; this fixture avoids it so the
    // kind-precedence assertion below isn't confounded by an unrelated bug.
    const kind = await kindOf("package main\ntype Foo struct {\n\tX int\n}\n", "foo.go", "Foo");
    expect(kind).toBe("class");
  });
});
