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

  it.each(["\n", "\r\n", "\r"])("keeps exact UTF-8 symbol bounds with %j line endings and no trailing newline", newline => {
    const prefix = `// 日本語😀${newline}`;
    const body = `function foo() {${newline}  return target;${newline}}`;
    const raw = prefix + body;
    const [chunk] = extractChunks({ path: "unicode.ts", raw, language: "typescript", symbols: [makeSymbol("foo", 2, 4, "function foo()")] });
    expect(chunk!.byteStart).toBe(Buffer.byteLength(prefix));
    expect(chunk!.byteEnd).toBe(Buffer.byteLength(raw));
    expect(chunk!.identifiers).toEqual(["foo", "function", "return", "target"]);
  });

  it("does not invent a byte or an extra chunk at an exact text slice boundary", () => {
    const raw = "x".repeat(1600);
    const chunks = extractChunks({ path: "exact.txt", raw, language: "text", symbols: [] });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.byteEnd).toBe(1600);
  });

  it("extracts identifiers from the matching byte slice of Unicode text", () => {
    const raw = "é".repeat(800) + " target";
    const chunks = extractChunks({ path: "unicode.txt", raw, language: "text", symbols: [] });
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.identifiers).toEqual([]);
    expect(chunks[1]!.identifiers).toEqual(["target"]);
    expect(chunks[1]!.byteEnd).toBe(Buffer.byteLength(raw));
  });

  it("includes a partially covered final line in text slice ranges", () => {
    const raw = "x".repeat(1000) + "\r\n" + "y".repeat(1000);
    const chunks = extractChunks({ path: "lines.txt", raw, language: "text", symbols: [] });
    expect(chunks[0]).toMatchObject({ lineStart: 1, lineEnd: 2 });
    expect(chunks[1]).toMatchObject({ lineStart: 2, lineEnd: 2, byteEnd: Buffer.byteLength(raw) });
  });

  it("keeps large symbol slices aligned after Unicode prefixes", () => {
    const prefix = "é".repeat(1000) + "\n";
    const raw = prefix + "function big() {\n" + "é".repeat(900) + "; return target;\n}";
    const chunks = extractChunks({ path: "large.ts", raw, language: "typescript", symbols: [makeSymbol("big", 2, 4, "function big()")] });
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.byteStart).toBe(Buffer.byteLength(prefix));
    expect(chunks[0]!.identifiers).toEqual(["big", "function"]);
    expect(chunks[0]).toMatchObject({ lineStart: 2, lineEnd: 3 });
    expect(chunks[1]!.identifiers).toEqual(["return", "target"]);
    expect(chunks[1]!.byteEnd).toBe(Buffer.byteLength(raw));
  });
});
