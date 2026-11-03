import { describe, expect, it } from "vitest";
import { compressRunOutput } from "../runOutput.js";

function compress(output: string, command = "tsc --noEmit", exitCode = 2, limitBytes = 4096) {
  return compressRunOutput({ output, command, exitCode, limitBytes, logPath: "/tmp/full.log" });
}

describe("run output feedback regressions", () => {
  it("collapses identical TypeScript diagnostics and reports their occurrence count", () => {
    const diagnostic = "src/a.ts(3,4): error TS2322: Type 'string' is not assignable to type 'number'.";
    const result = compress(`${Array(60).fill(diagnostic).join("\n")}\nFound 60 errors in 1 file.\n`);
    expect(result.split(diagnostic)).toHaveLength(2);
    expect(result).toMatch(/60 (?:occurrences|times)|59 (?:duplicates|repeated)/i);
    expect(result).toContain("Found 60 errors");
    expect(Buffer.byteLength(result)).toBeLessThan(900);
  });

  it("groups the same diagnostic at different source locations without losing their addresses", () => {
    const output = Array.from({ length: 60 }, (_, i) => `src/f${i}.ts(3,4): error TS2322: Type 'string' is not assignable to type 'number'.`).join("\n");
    const result = compress(output);
    expect((result.match(/error TS2322:/g) ?? []).length).toBe(1);
    expect(result).toContain("60 occurrences at 60 locations");
    for (let i = 0; i < 60; i++) expect(result).toContain(`src/f${i}.ts(3,4)`);
    expect(Buffer.byteLength(result)).toBeLessThan(2200);
  });

  it("preserves different locations, messages and continuation details", () => {
    const a = "src/a.ts(3,4): error TS2322: Type 'A' is not assignable to type 'B'.";
    const b = "src/b.ts(9,2): error TS2322: Type 'A' is not assignable to type 'B'.";
    const c = "src/a.ts(8,1): error TS2322: Type 'C' is not assignable to type 'D'.";
    const result = compress(`${a}\n  Property 'alpha' is missing.\n${a}\n  Property 'beta' is missing.\n${b}\n${c}\nFound 4 errors.\n`);
    for (const needle of ["src/a.ts(3,4)", "src/b.ts(9,2)", "src/a.ts(8,1)", "Property 'alpha'", "Property 'beta'", "Type 'C'", "Found 4 errors"]) expect(result).toContain(needle);
  });

  it("does not consume an indented subsequent diagnostic as continuation", () => {
    const a = "  src/a.ts(1,1): error TS2322: first failure";
    const b = "  src/b.ts(2,1): error TS2304: second failure";
    const result = compress(`${a}\n${b}\n${a}\nFound 3 errors.\n`);
    expect(result).toContain("src/a.ts(1,1)");
    expect(result).toContain("src/b.ts(2,1)");
    expect(result).toMatch(/2 occurrences/);
    expect(result).toContain("Found 3 errors");
  });

  it("retains failure details and the byte limit when repeated diagnostics overflow", () => {
    const output = Array.from({ length: 80 }, (_, i) => `src/a.ts(${i + 1},1): error TS${2000 + i}: Unique failure ${i}.`).join("\n");
    const result = compress(output, "tsc --noEmit", 2, 1024);
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(1024);
    expect(result).toContain("Unique failure 0");
    expect(result).toMatch(/more failure lines/);
  });

  it.each([
    ["vitest run", " Test Files  1 passed (1)\n      Tests  40 passed (40)", " ✓ src/noise.spec.ts (40 tests) 2ms"],
    ["jest", "Test Suites: 1 passed, 1 total\nTests: 40 passed, 40 total", "PASS src/noise.test.ts"],
  ])("does not reintroduce routine successful lines for %s", (command, counts, noise) => {
    const result = compress(`${counts}\n${noise}\n`, command, 0);
    expect(result).toContain(counts);
    expect(result).not.toContain(noise);
    expect(result).toContain("full log:");
  });

  it("retains the tail for an unrecognized runner", () => {
    const result = compress(Array.from({ length: 80 }, (_, i) => `custom output ${i}`).join("\n"), "custom-tool", 0);
    expect(result).toContain("custom output 0");
    expect(result).toContain("custom output 79");
  });
});
