import { describe, it, expect } from "vitest";
import { searchSymbols } from "../searchIndex.js";
import type { SearchContext } from "../searchIndex.js";
import type { SourceIndexManifestV1, IndexedFileV1 } from "../indexStore.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeManifest(
  entries: Array<{
    path: string;
    lang: string;
    symbols: Array<{ name: string; sig: string }>;
  }>,
): SourceIndexManifestV1 {
  const files: Record<string, IndexedFileV1> = {};
  for (const e of entries) {
    files[e.path] = {
      path: e.path,
      language: e.lang,
      sizeBytes: 100,
      mtimeMs: 0,
      contentSha256: "abc",
      symbols: e.symbols.map((s, i) => ({
        name: s.name,
        kind: "function" as const,
        signature: s.sig,
        lineStart: i * 10 + 1,
        lineEnd: i * 10 + 5,
        chunkIds: [],
      })),
      chunks: [],
      outgoingSymbolRefs: {},
    };
  }
  return {
    version: 1,
    engineVersion: "0.1.0",
    repoRootRealpath: "/repo",
    ignoreHash: "abc",
    builtFromCommit: "abc",
    rootHash: "abc",
    files,
    directories: {},
  };
}

function makeCtx(manifest: SourceIndexManifestV1, opts?: {
  fileScores?: Map<string, number>;
  recentFiles?: Set<string>;
}): SearchContext {
  return {
    manifest,
    fileScores: opts?.fileScores ?? new Map(),
    recentFiles: opts?.recentFiles ?? new Set(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("searchSymbols", () => {
  it("exact match outranks substring match", () => {
    const manifest = makeManifest([
      {
        path: "src/a.ts",
        lang: "typescript",
        symbols: [
          { name: "getUserById", sig: "function getUserById()" },
          { name: "getUser", sig: "function getUser()" },
        ],
      },
    ]);
    const ctx = makeCtx(manifest);
    const { locations } = searchSymbols(ctx, { query: "getUser" });
    expect(locations.length).toBeGreaterThan(0);
    // exact match "getUser" should rank first
    expect(locations[0]!.symbol).toBe("getUser");
  });

  it("includeScores=false → no score or reasons keys", () => {
    const manifest = makeManifest([
      { path: "src/a.ts", lang: "ts", symbols: [{ name: "foo", sig: "function foo()" }] },
    ]);
    const ctx = makeCtx(manifest);
    const { locations } = searchSymbols(ctx, { query: "foo" });
    expect(locations.length).toBeGreaterThan(0);
    expect(locations[0]!.score).toBeUndefined();
    expect(locations[0]!.reasons).toBeUndefined();
  });

  it("includeScores=true → score and reasons both present", () => {
    const manifest = makeManifest([
      { path: "src/a.ts", lang: "ts", symbols: [{ name: "foo", sig: "function foo()" }] },
    ]);
    const ctx = makeCtx(manifest);
    const { locations } = searchSymbols(ctx, { query: "foo", includeScores: true });
    expect(locations.length).toBeGreaterThan(0);
    expect(typeof locations[0]!.score).toBe("number");
    expect(Array.isArray(locations[0]!.reasons)).toBe(true);
  });

  it("limit=2 with 5 matches from 3 files → 2 results, truncated=true, total=3", () => {
    const manifest = makeManifest([
      {
        path: "src/a.ts",
        lang: "typescript",
        symbols: [
          { name: "handleFoo1", sig: "function handleFoo1()" },
          { name: "handleFoo2", sig: "function handleFoo2()" },
        ],
      },
      {
        path: "src/b.ts",
        lang: "typescript",
        symbols: [
          { name: "handleBar1", sig: "function handleBar1()" },
          { name: "handleBar2", sig: "function handleBar2()" },
        ],
      },
      {
        path: "src/c.ts",
        lang: "typescript",
        symbols: [
          { name: "handleBaz", sig: "function handleBaz()" },
        ],
      },
    ]);
    const ctx = makeCtx(manifest);
    const { locations, truncated, total } = searchSymbols(ctx, { query: "handle", limit: 2 });
    // After file dedup, 3 unique files; limit=2 so truncated=true.
    expect(locations.length).toBe(2);
    expect(truncated).toBe(true);
    expect(total).toBe(3);
  });

  it("Fix A (2026-07-12c): path is a HARD scope — a file outside it is excluded entirely, not merely ranked lower", () => {
    const manifest = makeManifest([
      { path: "src/api/handler.ts", lang: "typescript", symbols: [{ name: "apiHandler", sig: "function apiHandler()" }] },
      { path: "src/util/helper.ts", lang: "typescript", symbols: [{ name: "apiHelper", sig: "function apiHelper()" }] },
    ]);
    const ctx = makeCtx(manifest);
    const { locations, total } = searchSymbols(ctx, { query: "api", path: "src/api", includeScores: true });
    const paths = locations.map((l) => l.path);
    // Pre-Fix-A, path was only a +1.0 soft pathHintMatch ranking boost — the
    // non-matching file could still appear, just ranked lower. Fix A
    // hard-scopes: src/util/helper.ts must never appear at all.
    expect(paths).toContain("src/api/handler.ts");
    expect(paths).not.toContain("src/util/helper.ts");
    expect(total).toBe(1);
  });

  it("Fix A: path scoped to a directory admits a nested file, not just direct children", () => {
    const manifest = makeManifest([
      { path: "src/api/v1/handler.ts", lang: "typescript", symbols: [{ name: "nestedHandler", sig: "function nestedHandler()" }] },
      { path: "src/other/handler.ts", lang: "typescript", symbols: [{ name: "otherHandler", sig: "function otherHandler()" }] },
    ]);
    const ctx = makeCtx(manifest);
    const { locations } = searchSymbols(ctx, { query: "handler", path: "src/api" });
    expect(locations.map((l) => l.path)).toEqual(["src/api/v1/handler.ts"]);
  });

  it("Fix A: empty query + path lists EVERY symbol in that file (dedup-per-file skipped within an explicit scope)", () => {
    const manifest = makeManifest([
      {
        path: "src/target.ts",
        lang: "typescript",
        symbols: [
          { name: "TargetClass", sig: "class TargetClass" },
          { name: "targetHelperOne", sig: "function targetHelperOne()" },
          { name: "targetHelperTwo", sig: "function targetHelperTwo()" },
        ],
      },
      { path: "src/unrelated.ts", lang: "typescript", symbols: [{ name: "unrelatedFn", sig: "function unrelatedFn()" }] },
    ]);
    const ctx = makeCtx(manifest);
    // Outside an explicit scope, the "best-scoring symbol per file" dedup
    // would collapse this to ONE result even with a real query — the empty
    // query here additionally proves the vacuous-substring-match gate
    // (symbolLower.includes("")) no longer fans out to src/unrelated.ts.
    const { locations, total } = searchSymbols(ctx, { query: "", path: "src/target.ts" });
    expect(locations.map((l) => l.path)).toEqual(["src/target.ts", "src/target.ts", "src/target.ts"]);
    expect(locations.map((l) => l.symbol).sort()).toEqual(
      ["TargetClass", "targetHelperOne", "targetHelperTwo"].sort(),
    );
    expect(total).toBe(3);
  });

  it("Fix A: empty query with NO path returns nothing — never fans out repo-wide", () => {
    const manifest = makeManifest([
      { path: "src/a.ts", lang: "typescript", symbols: [{ name: "alpha", sig: "function alpha()" }] },
      { path: "src/b.ts", lang: "typescript", symbols: [{ name: "beta", sig: "function beta()" }] },
    ]);
    const ctx = makeCtx(manifest);
    const { locations, total } = searchSymbols(ctx, { query: "" });
    expect(locations).toEqual([]);
    expect(total).toBe(0);
  });

  it("lang filter: excludes wrong extensions", () => {
    const manifest = makeManifest([
      { path: "src/a.ts", lang: "typescript", symbols: [{ name: "myFunc", sig: "function myFunc()" }] },
      { path: "src/b.py", lang: "python", symbols: [{ name: "my_func", sig: "def my_func()" }] },
    ]);
    const ctx = makeCtx(manifest);
    const { locations } = searchSymbols(ctx, { query: "my", lang: "ts" });
    // Only TypeScript results (no Python)
    for (const loc of locations) {
      expect(loc.path).toMatch(/\.ts$/);
    }
  });

  it.each([
    ["kt", "src/a.kt"],
    ["cs", "src/a.cs"],
    ["php", "src/a.php"],
    ["rb", "src/a.rb"],
  ] as const)("lang filter: includes %s extension and excludes TypeScript", (lang, path) => {
    const manifest = makeManifest([
      { path, lang, symbols: [{ name: "targetSymbol", sig: "targetSymbol" }] },
      { path: "src/a.ts", lang: "typescript", symbols: [{ name: "targetSymbol", sig: "function targetSymbol()" }] },
    ]);
    const ctx = makeCtx(manifest);
    const { locations } = searchSymbols(ctx, { query: "target", lang });
    expect(locations.map((loc) => loc.path)).toEqual([path]);
  });

  it("test file path gets a lower rank than non-test equivalent", () => {
    const manifest = makeManifest([
      { path: "__tests__/util.spec.ts", lang: "typescript", symbols: [{ name: "testUtil", sig: "function testUtil()" }] },
      { path: "src/util.ts", lang: "typescript", symbols: [{ name: "testUtil", sig: "function testUtil()" }] },
    ]);
    const ctx = makeCtx(manifest);
    const { locations } = searchSymbols(ctx, { query: "testUtil", includeScores: true });
    const nonTestLoc = locations.find((l) => l.path === "src/util.ts");
    const testLoc = locations.find((l) => l.path.includes("__tests__"));
    expect(nonTestLoc).toBeDefined();
    expect(testLoc).toBeDefined();
    expect(nonTestLoc!.score!).toBeGreaterThan(testLoc!.score!);
  });

  it("returns empty when no name match", () => {
    const manifest = makeManifest([
      { path: "src/a.ts", lang: "typescript", symbols: [{ name: "alpha", sig: "function alpha()" }] },
    ]);
    const ctx = makeCtx(manifest);
    const { locations } = searchSymbols(ctx, { query: "zzznomatch" });
    expect(locations.length).toBe(0);
  });

  it("camelCase token match works", () => {
    const manifest = makeManifest([
      { path: "src/a.ts", lang: "typescript", symbols: [{ name: "getUserById", sig: "function getUserById()" }] },
    ]);
    const ctx = makeCtx(manifest);
    // "user" is a camelCase token in "getUserById"
    const { locations } = searchSymbols(ctx, { query: "user" });
    expect(locations.length).toBeGreaterThan(0);
    expect(locations[0]!.symbol).toBe("getUserById");
  });

  it("multi-token query matches via path segment overlap", () => {
    // Query "order payment checkout" — no symbol contains the full phrase,
    // but the path 'service/order.ts' has 'order' and 'payment.ts' has 'payment'.
    const manifest = makeManifest([
      { path: "service/order.ts", lang: "typescript", symbols: [{ name: "place", sig: "function place()" }] },
      { path: "service/payment.ts", lang: "typescript", symbols: [{ name: "pay", sig: "function pay()" }] },
      { path: "service/unrelated.ts", lang: "typescript", symbols: [{ name: "doOther", sig: "function doOther()" }] },
    ]);
    const ctx = makeCtx(manifest);
    const { locations } = searchSymbols(ctx, { query: "order payment checkout", includeScores: true });
    // Both order.ts and payment.ts should appear; unrelated.ts should not.
    const paths = locations.map((l) => l.path);
    expect(paths).toContain("service/order.ts");
    expect(paths).toContain("service/payment.ts");
    expect(paths).not.toContain("service/unrelated.ts");
    // order.ts and payment.ts should score above 0
    const orderLoc = locations.find((l) => l.path === "service/order.ts");
    const payLoc = locations.find((l) => l.path === "service/payment.ts");
    expect(orderLoc!.score!).toBeGreaterThan(0);
    expect(payLoc!.score!).toBeGreaterThan(0);
  });

  it("no double-count: single-token query with camelCaseOrTokenMatch does not also fire queryTokenSymbolMatch", () => {
    const manifest = makeManifest([
      { path: "src/a.ts", lang: "typescript", symbols: [{ name: "getUserById", sig: "function getUserById()" }] },
    ]);
    const ctx = makeCtx(manifest);
    // Single-token query "user" matches a camelCase token — queryTokenSymbolMatch should be 0
    const { locations } = searchSymbols(ctx, { query: "user", includeScores: true });
    expect(locations.length).toBeGreaterThan(0);
    const loc = locations[0]!;
    // camelCaseOrTokenMatch fires; queryTokenSymbolMatch must NOT also fire
    expect(loc.reasons).toContain("camelCaseOrTokenMatch");
    expect(loc.reasons).not.toContain("queryTokenSymbolMatch");
  });

  it("default limit is 10 (truncates at 10 unique files)", () => {
    // 15 files each with 1 matching symbol → 15 unique files.
    const manifest = makeManifest(
      Array.from({ length: 15 }, (_, i) => ({
        path: `src/file${i}.ts`,
        lang: "typescript",
        symbols: [{ name: `handleItem${i}`, sig: `function handleItem${i}()` }],
      })),
    );
    const ctx = makeCtx(manifest);
    const { locations, truncated, total } = searchSymbols(ctx, { query: "handle" });
    expect(locations).toHaveLength(10);
    expect(truncated).toBe(true);
    expect(total).toBe(15);
  });
});
