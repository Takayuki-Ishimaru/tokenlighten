import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import {
  loadManifest,
  writeManifest,
  loadOrBuildSourceIndex,
  MAX_CACHE_MANIFEST_BYTES,
} from "../indexStore.js";
import type { SourceIndexManifestV1 } from "../indexStore.js";
import { searchSymbols as searchIndexSymbols } from "../searchIndex.js";
import type { SearchContext } from "../searchIndex.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = join(
    "/private/tmp",
    `indexStore-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await fs.mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
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
    const outside = await fs.mkdtemp(join("/private/tmp", "indexStore-outside-"));
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
      "/private/tmp",
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
