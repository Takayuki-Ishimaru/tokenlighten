import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { extractChunks } from "../chunker.js";
import type { ExtractedSymbol } from "../graph.js";

function chunkId(path: string, byteStart: number, byteEnd: number, kind: string): string {
  return createHash("sha256")
    .update(`${path}\0${byteStart}\0${byteEnd}\0${kind}`)
    .digest("hex");
}

function makeSymbol(name: string, line: number, endLine: number, signature: string): ExtractedSymbol {
  return { name, line, endLine, signature };
}

describe("extractChunks", () => {
  it("single small symbol → one chunk", () => {
    const raw = "function foo() {\n  return 1;\n}\n";
    const sym = makeSymbol("foo", 1, 3, "function foo()");
    const chunks = extractChunks({ path: "a.ts", raw, language: "typescript", symbols: [sym] });
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.symbolName).toBe("foo");
    expect(chunks[0]!.kind).toBe("symbol");
  });

  it("tokenEstimate = ceil((byteEnd - byteStart) / 4)", () => {
    const raw = "function foo() {\n  return 1;\n}\n";
    const sym = makeSymbol("foo", 1, 3, "function foo()");
    const chunks = extractChunks({ path: "a.ts", raw, language: "typescript", symbols: [sym] });
    const c = chunks[0]!;
    expect(c.tokenEstimate).toBe(Math.max(1, Math.ceil((c.byteEnd - c.byteStart) / 4)));
  });

  it("id is deterministic and matches sha256", () => {
    const raw = "function foo() {\n  return 1;\n}\n";
    const sym = makeSymbol("foo", 1, 3, "function foo()");
    const chunks1 = extractChunks({ path: "a.ts", raw, language: "typescript", symbols: [sym] });
    const chunks2 = extractChunks({ path: "a.ts", raw, language: "typescript", symbols: [sym] });
    expect(chunks1[0]!.id).toBe(chunks2[0]!.id);
    const c = chunks1[0]!;
    expect(c.id).toBe(chunkId("a.ts", c.byteStart, c.byteEnd, c.kind));
  });

  it("large symbol (>1600 bytes) → multiple chunks with #N suffix", () => {
    // Create a symbol body that is definitely >1600 bytes.
    const body = "x".repeat(2000);
    const raw = `function big() {\n${body}\n}\n`;
    const sym = makeSymbol("big", 1, 3, "function big()");
    const chunks = extractChunks({ path: "b.ts", raw, language: "typescript", symbols: [sym] });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]!.symbolName).toBe("big#0");
    expect(chunks[1]!.symbolName).toBe("big#1");
  });

  it("no symbols → text chunks emitted for non-empty raw", () => {
    const raw = "This is some text content.\n".repeat(10);
    const chunks = extractChunks({ path: "readme.md", raw, language: "", symbols: [] });
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((c) => c.kind === "text")).toBe(true);
  });

  // Task B (index-side text-bearing enumeration): indexStore.ts's slow path
  // passes language="text" for EnumeratedFile.textOnly files (.md/.txt/
  // .rst/.json/.yaml/.yml/.toml), with symbols always []. Pin that exact
  // sentinel here so this path (previously unreachable — text-bearing
  // extensions were never enumerated) stays proven reachable and produces
  // real text chunks, not symbol/class chunks.
  it('textOnly sentinel language ("text") with zero symbols → text chunks, not symbol chunks', () => {
    const raw = "# Widget Guide\n\nThis document explains the Widget API in prose, not code.\n".repeat(5);
    const chunks = extractChunks({ path: "docs/widget.md", raw, language: "text", symbols: [] });
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((c) => c.kind === "text")).toBe(true);
    expect(chunks.every((c) => c.symbolName === undefined)).toBe(true);
  });

  it("class signature maps to class kind", () => {
    const raw = "class MyClass {\n  x = 1;\n}\n";
    const sym = makeSymbol("MyClass", 1, 3, "class MyClass");
    const chunks = extractChunks({ path: "c.ts", raw, language: "typescript", symbols: [sym] });
    expect(chunks[0]!.kind).toBe("class");
  });

  it("identifiers are sorted and limited to 32", () => {
    const raw = "function foo() { return bar + baz + qux; }\n";
    const sym = makeSymbol("foo", 1, 1, "function foo()");
    const chunks = extractChunks({ path: "d.ts", raw, language: "typescript", symbols: [sym] });
    expect(chunks[0]!.identifiers.length).toBeLessThanOrEqual(32);
    // Should be sorted
    const ids = chunks[0]!.identifiers;
    expect([...ids].sort()).toEqual(ids);
  });
});
