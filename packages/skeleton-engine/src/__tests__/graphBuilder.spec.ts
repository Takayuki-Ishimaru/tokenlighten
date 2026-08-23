import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SourceIndexManifestV1, IndexedFileV1 } from "../indexStore.js";
import { buildTlGraphFromManifest, writeGraphIfStale, getTlGraphPath } from "../graphBuilder.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = join(
    tmpdir(),
    `graphBuilder-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await fs.mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeFile(overrides: Partial<IndexedFileV1> & { path: string }): IndexedFileV1 {
  return {
    language: "typescript",
    sizeBytes: 100,
    mtimeMs: 1000,
    contentSha256: "aaa",
    symbols: [],
    chunks: [],
    outgoingSymbolRefs: {},
    ...overrides,
  };
}

function makeManifest(
  files: Record<string, IndexedFileV1>,
  rootHash = "hash-1",
): SourceIndexManifestV1 {
  return {
    version: 1,
    engineVersion: "0.1.0",
    repoRootRealpath: "/repo",
    ignoreHash: "abc",
    builtFromCommit: "def",
    rootHash,
    files,
    directories: {},
  };
}

// ---------------------------------------------------------------------------
// buildTlGraphFromManifest
// ---------------------------------------------------------------------------

describe("buildTlGraphFromManifest", () => {
  it("produces empty graph from empty manifest", () => {
    const graph = buildTlGraphFromManifest(makeManifest({}));
    expect(graph.version).toBe(1);
    expect(graph.symbols).toEqual([]);
    expect(graph.files).toEqual([]);
  });

  it("finds cross-file symbol references", () => {
    const manifest = makeManifest({
      "src/enums.ts": makeFile({
        path: "src/enums.ts",
        symbols: [
          { name: "TicketPriority", kind: "const", signature: "export const TicketPriority =", lineStart: 5, lineEnd: 10, chunkIds: [] },
        ],
        outgoingSymbolRefs: { TicketPriority: 1 },
      }),
      "src/stats.ts": makeFile({
        path: "src/stats.ts",
        symbols: [
          { name: "StatsService", kind: "class", signature: "export class StatsService", lineStart: 1, lineEnd: 50, chunkIds: [] },
        ],
        outgoingSymbolRefs: { TicketPriority: 3, StatsService: 2, console: 1 },
      }),
      "src/chip.tsx": makeFile({
        path: "src/chip.tsx",
        symbols: [
          { name: "PriorityChip", kind: "function", signature: "export function PriorityChip(", lineStart: 1, lineEnd: 30, chunkIds: [] },
        ],
        outgoingSymbolRefs: { TicketPriority: 2, PriorityChip: 1 },
      }),
    });

    const graph = buildTlGraphFromManifest(manifest);

    // TicketPriority should have references from stats.ts and chip.tsx
    const ipSymbol = graph.symbols.find((s) => s.name === "TicketPriority");
    expect(ipSymbol).toBeDefined();
    expect(ipSymbol!.definition).toEqual({ path: "src/enums.ts", line: 5, column: 0 });
    const refPaths = ipSymbol!.references.map((r) => r.path).sort();
    expect(refPaths).toEqual(["src/chip.tsx", "src/stats.ts"]);

    // StatsService: defined in stats.ts, no other file references it
    const asSymbol = graph.symbols.find((s) => s.name === "StatsService");
    expect(asSymbol).toBeUndefined(); // no external refs → excluded
  });

  it("builds file-level imports correctly", () => {
    const manifest = makeManifest({
      "src/enums.ts": makeFile({
        path: "src/enums.ts",
        symbols: [
          { name: "TicketPriority", kind: "const", signature: "export const TicketPriority =", lineStart: 5, lineEnd: 10, chunkIds: [] },
          { name: "TicketStatus", kind: "const", signature: "export const TicketStatus =", lineStart: 12, lineEnd: 20, chunkIds: [] },
        ],
        outgoingSymbolRefs: {},
      }),
      "src/service.ts": makeFile({
        path: "src/service.ts",
        symbols: [
          { name: "TicketService", kind: "class", signature: "export class TicketService", lineStart: 1, lineEnd: 100, chunkIds: [] },
        ],
        outgoingSymbolRefs: { TicketPriority: 2, TicketStatus: 1, TicketService: 5 },
      }),
    });

    const graph = buildTlGraphFromManifest(manifest);

    // service.ts should import enums.ts
    const svcFile = graph.files.find((f) => f.path === "src/service.ts");
    expect(svcFile).toBeDefined();
    expect(svcFile!.imports).toEqual(["src/enums.ts"]);

    // enums.ts should export TicketPriority and TicketStatus
    const enumFile = graph.files.find((f) => f.path === "src/enums.ts");
    expect(enumFile).toBeDefined();
    expect(enumFile!.exports).toEqual(["TicketPriority", "TicketStatus"]);
  });

  it("skips self-references in symbols and imports", () => {
    const manifest = makeManifest({
      "src/util.ts": makeFile({
        path: "src/util.ts",
        symbols: [
          { name: "helper", kind: "function", signature: "export function helper(", lineStart: 1, lineEnd: 5, chunkIds: [] },
        ],
        // references its own symbol — should be excluded
        outgoingSymbolRefs: { helper: 3 },
      }),
    });

    const graph = buildTlGraphFromManifest(manifest);
    expect(graph.symbols).toEqual([]);
    // File has exports but no imports
    const f = graph.files.find((f) => f.path === "src/util.ts");
    expect(f).toBeDefined();
    expect(f!.imports).toEqual([]);
  });

  it("handles ambiguous symbol names (defined in multiple files)", () => {
    const manifest = makeManifest({
      "src/a.ts": makeFile({
        path: "src/a.ts",
        symbols: [{ name: "render", kind: "function", signature: "export function render(", lineStart: 1, lineEnd: 10, chunkIds: [] }],
        outgoingSymbolRefs: {},
      }),
      "src/b.ts": makeFile({
        path: "src/b.ts",
        symbols: [{ name: "render", kind: "function", signature: "export function render(", lineStart: 1, lineEnd: 10, chunkIds: [] }],
        outgoingSymbolRefs: {},
      }),
      "src/consumer.ts": makeFile({
        path: "src/consumer.ts",
        symbols: [],
        outgoingSymbolRefs: { render: 2 },
      }),
    });

    const graph = buildTlGraphFromManifest(manifest);
    // Both definitions should appear as separate symbol entries
    const renderSymbols = graph.symbols.filter((s) => s.name === "render");
    expect(renderSymbols).toHaveLength(2);
    for (const sym of renderSymbols) {
      expect(sym.references).toEqual([{ path: "src/consumer.ts", line: 1, column: 0 }]);
    }

    // consumer.ts should import both a.ts and b.ts
    const consumer = graph.files.find((f) => f.path === "src/consumer.ts");
    expect(consumer!.imports).toEqual(["src/a.ts", "src/b.ts"]);
  });
});

// ---------------------------------------------------------------------------
// writeGraphIfStale
// ---------------------------------------------------------------------------

describe("writeGraphIfStale", () => {
  it("writes graph on first call", async () => {
    const manifest = makeManifest({
      "src/a.ts": makeFile({
        path: "src/a.ts",
        symbols: [{ name: "foo", kind: "function", signature: "function foo(", lineStart: 1, lineEnd: 5, chunkIds: [] }],
        outgoingSymbolRefs: {},
      }),
      "src/b.ts": makeFile({
        path: "src/b.ts",
        symbols: [],
        outgoingSymbolRefs: { foo: 1 },
      }),
    });

    const result = await writeGraphIfStale(tmpDir, manifest);
    expect(result.written).toBe(true);
    expect(result.symbolCount).toBe(1);
    expect(result.fileCount).toBe(2);

    const graphPath = getTlGraphPath(tmpDir);
    const content = JSON.parse(await fs.readFile(graphPath, "utf8"));
    expect(content.version).toBe(1);
    expect(content.rootHash).toBe("hash-1");
  });

  it("skips write when rootHash matches", async () => {
    const manifest = makeManifest({
      "src/a.ts": makeFile({
        path: "src/a.ts",
        symbols: [{ name: "foo", kind: "function", signature: "function foo(", lineStart: 1, lineEnd: 5, chunkIds: [] }],
        outgoingSymbolRefs: {},
      }),
    });

    await writeGraphIfStale(tmpDir, manifest);
    const result2 = await writeGraphIfStale(tmpDir, manifest);
    expect(result2.written).toBe(false);
  });

  it("rewrites when rootHash changes", async () => {
    const manifest1 = makeManifest({}, "hash-1");
    const manifest2 = makeManifest({
      "src/x.ts": makeFile({
        path: "src/x.ts",
        symbols: [{ name: "bar", kind: "function", signature: "function bar(", lineStart: 1, lineEnd: 3, chunkIds: [] }],
        outgoingSymbolRefs: {},
      }),
    }, "hash-2");

    await writeGraphIfStale(tmpDir, manifest1);
    const result = await writeGraphIfStale(tmpDir, manifest2);
    expect(result.written).toBe(true);

    const content = JSON.parse(await fs.readFile(getTlGraphPath(tmpDir), "utf8"));
    expect(content.rootHash).toBe("hash-2");
  });

  // -------------------------------------------------------------------------
  // V11-09: forceRebuild — the crash-recovery override.
  // -------------------------------------------------------------------------
  //
  // These prove forceRebuild is not redundant with the ordinary rootHash
  // shortcut: it is specifically for the case the shortcut CANNOT
  // distinguish on content alone — a stale on-disk graph left behind by a
  // crashed publish whose rootHash happens to still equal the current
  // manifest's (a content cycle: edit away, then edit back to the exact
  // same bytes). Ordinary rootHash comparison would wrongly call that
  // "fresh"; loadOrBuildSourceIndex's publish journal is what tells the
  // caller to pass forceRebuild:true in exactly that situation (see
  // faultInjection.spec.ts's "crash before the GRAPH rename" test for the
  // full integration path this option exists to serve).

  it("forceRebuild:true rewrites even when rootHash matches (bypasses the shortcut the ordinary path relies on)", async () => {
    const manifest = makeManifest({}, "hash-same");
    await writeGraphIfStale(tmpDir, manifest);

    // Without forceRebuild, this would report written:false (proven by the
    // "skips write when rootHash matches" test above, same manifest
    // object, no option passed).
    const result = await writeGraphIfStale(tmpDir, manifest, { forceRebuild: true });
    expect(result.written).toBe(true);
  });

  it("forceRebuild:true on a manifest whose rootHash cycled back still republishes the CURRENT generation, not the stale one", async () => {
    // Simulates the exact crash-recovery scenario: generation 1 (hash-A)
    // published in full; generation 2 (hash-B) manifest committed but its
    // graph write crashed (graph stays at generation 1 on disk); content
    // is then edited back to hash-A's exact bytes, so the RECOVERY
    // manifest is generation 3 but rootHash is hash-A again — coincidentally
    // matching what is ALREADY on disk (graph generation 1). forceRebuild
    // must still republish, stamping the CURRENT generation (3), not
    // silently agree with the stale generation-1 file just because their
    // rootHash happens to collide.
    const gen1 = { ...makeManifest({}, "hash-A"), generation: 1 };
    await writeGraphIfStale(tmpDir, gen1);

    const gen3 = { ...makeManifest({}, "hash-A"), generation: 3 };
    const result = await writeGraphIfStale(tmpDir, gen3, { forceRebuild: true });
    expect(result.written).toBe(true);

    const content = JSON.parse(await fs.readFile(getTlGraphPath(tmpDir), "utf8"));
    expect(content.rootHash).toBe("hash-A");
    expect(content.generation).toBe(3);
  });

  it("beforeRename hook fires right before publish and a throw there leaves the previous graph untouched", async () => {
    const manifest1 = makeManifest({}, "hash-1");
    await writeGraphIfStale(tmpDir, manifest1);
    const before = await fs.readFile(getTlGraphPath(tmpDir), "utf8");

    const manifest2 = makeManifest({}, "hash-2");
    await expect(
      writeGraphIfStale(tmpDir, manifest2, {
        beforeRename: () => {
          throw new Error("simulated crash");
        },
      }),
    ).rejects.toThrow(/simulated crash/);

    const after = await fs.readFile(getTlGraphPath(tmpDir), "utf8");
    expect(after).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// writeGraphIfStale — oversized-graph staleness probe
// ---------------------------------------------------------------------------

describe("writeGraphIfStale oversized staleness probe", () => {
  it("detects freshness from the head bytes without parsing a repo-scale graph", async () => {
    const manifest = makeManifest({}, "hash-big");
    const graphPath = getTlGraphPath(tmpDir);
    await fs.mkdir(join(tmpDir, ".tokenlighten", "index"), { recursive: true });
    // Hand-write a graph whose size exceeds the full-parse cap (8 MiB) but
    // whose head carries the matching rootHash — the probe must skip the
    // rewrite without JSON.parsing the body.
    const filler = `,"filler":"${"x".repeat(9 * 1024 * 1024)}"`;
    await fs.writeFile(
      graphPath,
      `{"version":1,"rootHash":"hash-big","symbols":[],"files":[]${filler}}`,
      "utf8",
    );
    const before = await fs.stat(graphPath);

    const result = await writeGraphIfStale(tmpDir, manifest);
    expect(result.written).toBe(false);

    const after = await fs.stat(graphPath);
    expect(after.size).toBe(before.size);
  });

  it("rewrites an oversized graph whose head rootHash differs", async () => {
    const manifest = makeManifest({}, "hash-new");
    const graphPath = getTlGraphPath(tmpDir);
    await fs.mkdir(join(tmpDir, ".tokenlighten", "index"), { recursive: true });
    const filler = `,"filler":"${"x".repeat(9 * 1024 * 1024)}"`;
    await fs.writeFile(
      graphPath,
      `{"version":1,"rootHash":"hash-old","symbols":[],"files":[]${filler}}`,
      "utf8",
    );

    const result = await writeGraphIfStale(tmpDir, manifest);
    expect(result.written).toBe(true);
    const content = JSON.parse(await fs.readFile(graphPath, "utf8"));
    expect(content.rootHash).toBe("hash-new");
  });
});
