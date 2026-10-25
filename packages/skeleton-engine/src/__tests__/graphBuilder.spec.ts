import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { IndexedSymbolV1, SourceIndexManifestV1, IndexedFileV1 } from "../indexStore.js";
import { buildTlGraphFromManifest, writeGraphIfStale, getTlGraphPath, DEFAULT_GRAPH_INDEX_MAX_BYTES } from "../graphBuilder.js";

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

// ---------------------------------------------------------------------------
// Perf (2026-09-27, large-workspace task_pack cost, item D): writeGraphIfStale
// must skip the stringify+disk-write for a graph the READER (mcp-server's
// GRAPH_INDEX_MAX_BYTES check) would never read back in non-"on" mode —
// writing it changes nothing any caller can observe, so it must not pay for
// JSON.stringify(graph) at all. "on" mode must still publish it, unchanged.
// ---------------------------------------------------------------------------
describe("writeGraphIfStale — item D: skip the doomed stringify+write for an oversized graph", () => {
  // A single symbol whose OWN NAME is already bigger than the whole cap:
  // The indexed lower-bound sum crosses DEFAULT_GRAPH_INDEX_MAX_BYTES from
  // this one field, so only two small files are needed to exercise the
  // gate (a symbol only enters `graph.symbols` once it has >=1 reference —
  // see buildTlGraphFromManifest's own `if (!refs...) continue` filter).
  function makeOversizedGraphManifest(): SourceIndexManifestV1 {
    const hugeName = "H".repeat(DEFAULT_GRAPH_INDEX_MAX_BYTES + 1024);
    return makeManifest({
      "a.ts": makeFile({
        path: "a.ts",
        symbols: [{ name: hugeName, kind: "function", signature: "sig", lineStart: 1, lineEnd: 1, chunkIds: [] }],
      }),
      "b.ts": makeFile({ path: "b.ts", outgoingSymbolRefs: { [hugeName]: 1 } }),
    });
  }

  it("in default (auto) mode, skips JSON.stringify entirely and reports written:false", async () => {
    const spy = vi.spyOn(JSON, "stringify");
    try {
      const result = await writeGraphIfStale(tmpDir, makeOversizedGraphManifest());
      expect(result.written).toBe(false);
      expect(result.symbolCount).toBe(1); // exact summary count without graph assembly/stringification
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("in default (auto) mode, does not create the on-disk graph file", async () => {
    await writeGraphIfStale(tmpDir, makeOversizedGraphManifest());
    await expect(fs.access(getTlGraphPath(tmpDir))).rejects.toThrow();
  });

  it("leaves an EXISTING on-disk graph file untouched when the new build is oversized (never deletes/replaces it)", async () => {
    const graphPath = getTlGraphPath(tmpDir);
    await fs.mkdir(join(tmpDir, ".tokenlighten", "index"), { recursive: true });
    const existing = '{"version":1,"rootHash":"hash-old","symbols":[],"files":[]}';
    await fs.writeFile(graphPath, existing, "utf8");

    const manifest = makeOversizedGraphManifest(); // rootHash differs from "hash-old" -> not a freshness-shortcut hit
    const result = await writeGraphIfStale(tmpDir, manifest);
    expect(result.written).toBe(false);
    expect(await fs.readFile(graphPath, "utf8")).toBe(existing);
  });

  it("admits by a linear lower bound before reading definition lines or expanding high-fanout references", async () => {
    const symbolCount = 160;
    const fanout = 160;
    const files: Record<string, IndexedFileV1> = {};
    for (let i = 0; i < symbolCount; i += 1) {
      const symbol: IndexedSymbolV1 = { name: "Shared", kind: "function", signature: "sig", lineStart: 1, lineEnd: 1, chunkIds: [] };
      if (i === 0) {
        Object.defineProperty(symbol, "lineStart", {
          get() { throw new Error("graph assembly reached before oversized admission"); },
        });
      }
      const path = `defs/${String(i).padStart(3, "0")}.ts`;
      files[path] = makeFile({ path, symbols: [symbol] });
    }
    for (let i = 0; i < fanout; i += 1) {
      const path = `refs/${String(i).padStart(3, "0")}.ts`;
      files[path] = makeFile({ path, outgoingSymbolRefs: { Shared: 1 } });
    }

    const result = await writeGraphIfStale(tmpDir, makeManifest(files), { graphIndexMaxBytes: 1 });
    expect(result).toEqual({ written: false, symbolCount, fileCount: symbolCount + fanout });
    await expect(fs.access(getTlGraphPath(tmpDir))).rejects.toThrow();
  });

  it("mode:\"on\" bypasses the gate: the same oversized graph IS built, stringified, and written", async () => {
    const manifest = makeOversizedGraphManifest();
    const result = await writeGraphIfStale(tmpDir, manifest, { graphIndexMode: "on" });
    expect(result.written).toBe(true);
    const content = JSON.parse(await fs.readFile(getTlGraphPath(tmpDir), "utf8"));
    expect(content.symbols.length).toBe(1);
  });

  it("keeps duplicate definitions and excludes every locally defining file from references", async () => {
    const symbol = (name: string, lineStart: number): IndexedSymbolV1 => ({
      name, kind: "function", signature: "sig", lineStart, lineEnd: lineStart, chunkIds: [],
    });
    const manifest = makeManifest({
      "a.ts": makeFile({ path: "a.ts", symbols: [symbol("Shared", 1), symbol("Shared", 2), symbol("Unused", 3)], outgoingSymbolRefs: { Shared: 1 } }),
      "b.ts": makeFile({ path: "b.ts", symbols: [symbol("Shared", 1)], outgoingSymbolRefs: { Shared: 1 } }),
      "c.ts": makeFile({ path: "c.ts", outgoingSymbolRefs: { Shared: 1, Unknown: 1 } }),
      "d.ts": makeFile({ path: "d.ts", symbols: [symbol("Other", 1)], outgoingSymbolRefs: { Shared: 1, Other: 1 } }),
      "e.ts": makeFile({ path: "e.ts", outgoingSymbolRefs: { Unknown: 1 } }),
    });
    expect(await writeGraphIfStale(tmpDir, manifest, { graphIndexMaxBytes: 1 }))
      .toEqual({ written: false, symbolCount: 3, fileCount: 4 });
    expect(await writeGraphIfStale(tmpDir, manifest, { graphIndexMode: "on", graphIndexMaxBytes: 1 }))
      .toEqual({ written: true, symbolCount: 3, fileCount: 4 });
    const graph = JSON.parse(await fs.readFile(getTlGraphPath(tmpDir), "utf8"));
    expect(graph.symbols.map((entry: { name: string; definition: { path: string; line: number }; references: { path: string }[] }) => ({
      name: entry.name, path: entry.definition.path, line: entry.definition.line,
      refs: entry.references.map((reference) => reference.path),
    }))).toEqual([
      { name: "Shared", path: "a.ts", line: 1, refs: ["c.ts", "d.ts"] },
      { name: "Shared", path: "a.ts", line: 2, refs: ["c.ts", "d.ts"] },
      { name: "Shared", path: "b.ts", line: 1, refs: ["c.ts", "d.ts"] },
    ]);
    expect(graph.files).toEqual([
      { path: "a.ts", imports: [], exports: ["Shared", "Shared", "Unused"] },
      { path: "b.ts", imports: [], exports: ["Shared"] },
      { path: "c.ts", imports: ["a.ts", "b.ts"], exports: [] },
      { path: "d.ts", imports: ["a.ts", "b.ts"], exports: ["Other"] },
    ]);
  });

  it("mode:\"off\" still applies the size gate (writing changes nothing the reader would ever surface in that mode either)", async () => {
    const result = await writeGraphIfStale(tmpDir, makeOversizedGraphManifest(), { graphIndexMode: "off" });
    expect(result.written).toBe(false);
  });

  it("an explicit graphIndexMaxBytes lets a caller apply a DIFFERENT cap than the default", async () => {
    // A manifest whose graph fits comfortably under the real 64 MiB default
    // but is deliberately made to exceed a much smaller caller-supplied cap.
    const manifest = makeManifest({
      "a.ts": makeFile({ path: "a.ts", symbols: [{ name: "Shared", kind: "function", signature: "sig", lineStart: 1, lineEnd: 1, chunkIds: [] }] }),
      "b.ts": makeFile({ path: "b.ts", outgoingSymbolRefs: { Shared: 1 } }),
    });
    const result = await writeGraphIfStale(tmpDir, manifest, { graphIndexMaxBytes: 4 });
    expect(result.written).toBe(false);
  });

  it("a graph that fits under the cap is written exactly as before this item existed", async () => {
    const manifest = makeManifest({
      "a.ts": makeFile({ path: "a.ts", symbols: [{ name: "Shared", kind: "function", signature: "sig", lineStart: 1, lineEnd: 1, chunkIds: [] }] }),
      "b.ts": makeFile({ path: "b.ts", outgoingSymbolRefs: { Shared: 1 } }),
    });
    const result = await writeGraphIfStale(tmpDir, manifest);
    expect(result.written).toBe(true);
    const serialized = await fs.readFile(getTlGraphPath(tmpDir), "utf8");
    expect(serialized).toBe(JSON.stringify(buildTlGraphFromManifest(manifest)));
    const content = JSON.parse(serialized);
    expect(content.symbols).toHaveLength(1);
    expect(content.symbols[0].name).toBe("Shared");
  });

  it("preserves Unicode and JSON escaping in the complete serialized graph", async () => {
    const name = '火🔥"name';
    const manifest = makeManifest({
      "src/火🔥.ts": makeFile({
        path: "src/火🔥.ts",
        symbols: [{ name, kind: "function", signature: "sig", lineStart: 3, lineEnd: 3, chunkIds: [] }],
      }),
      "consumer/é.ts": makeFile({ path: "consumer/é.ts", outgoingSymbolRefs: { [name]: 1 } }),
    }, "root-🔥");
    const expected = JSON.stringify(buildTlGraphFromManifest(manifest));
    const result = await writeGraphIfStale(tmpDir, manifest);
    expect(result.written).toBe(true);
    expect(await fs.readFile(getTlGraphPath(tmpDir), "utf8")).toBe(expected);
  });

  it("does not preflight-reject when the lower bound equals the cap, but rejects one byte below", async () => {
    const equalBoundSymbol: IndexedSymbolV1 = { name: "S", kind: "function", signature: "sig", lineStart: 1, lineEnd: 1, chunkIds: [] };
    Object.defineProperty(equalBoundSymbol, "lineStart", {
      get() { throw new Error("equal lower bound must reach graph assembly"); },
    });
    const equalBound = makeManifest({
      "a.ts": makeFile({ path: "a.ts", symbols: [equalBoundSymbol] }),
      "b.ts": makeFile({ path: "b.ts", outgoingSymbolRefs: { S: 1 } }),
    });
    // rootHash 6 + export name 1 + two graph paths 8 + symbol name 1 +
    // definition path 4 + referenced path 4 = 24 UTF-16 code units.
    await expect(writeGraphIfStale(tmpDir, equalBound, { graphIndexMaxBytes: 24 }))
      .rejects.toThrow("equal lower bound must reach graph assembly");

    const nextTmpDir = join(tmpDir, "below-bound");
    await fs.mkdir(nextTmpDir);
    const belowBound = await writeGraphIfStale(nextTmpDir, makeManifest({
      "a.ts": makeFile({ path: "a.ts", symbols: [{ name: "S", kind: "function", signature: "sig", lineStart: 1, lineEnd: 1, chunkIds: [] }] }),
      "b.ts": makeFile({ path: "b.ts", outgoingSymbolRefs: { S: 1 } }),
    }), { graphIndexMaxBytes: 23 });
    expect(belowBound).toEqual({ written: false, symbolCount: 1, fileCount: 2 });
    await expect(fs.access(getTlGraphPath(nextTmpDir))).rejects.toThrow();
  });

  it("preserves an existing graph when forceRebuild is oversized", async () => {
    const graphPath = getTlGraphPath(tmpDir);
    await fs.mkdir(join(tmpDir, ".tokenlighten", "index"), { recursive: true });
    const existing = '{"version":1,"rootHash":"hash-old","symbols":[],"files":[]}';
    await fs.writeFile(graphPath, existing, "utf8");
    const files = {
      "a.ts": makeFile({ path: "a.ts", symbols: [{ name: "Large", kind: "function", signature: "sig", lineStart: 1, lineEnd: 1, chunkIds: [] }] }),
      "b.ts": makeFile({ path: "b.ts", outgoingSymbolRefs: { Large: 1 } }),
    };

    const result = await writeGraphIfStale(tmpDir, makeManifest(files, "hash-new"), {
      forceRebuild: true,
      graphIndexMaxBytes: 1,
    });
    expect(result).toEqual({ written: false, symbolCount: 1, fileCount: 2 });
    expect(await fs.readFile(graphPath, "utf8")).toBe(existing);
  });
});
