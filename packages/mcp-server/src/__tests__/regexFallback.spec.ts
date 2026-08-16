// Tests for skeleton/regexFallback.ts — direct/deterministic (pure function,
// no tree-sitter/WASM dependency), so the css fix below does not depend on
// whether tree-sitter WASM happens to load in a given environment.
//
// regexFallbackSkeleton's own trailing "AST-fallback mode" note used to be
// built with a hardcoded `//`/`#` prefix regardless of language, which is
// invalid CSS syntax for a css file (css has no line-comment syntax at all).
// It now delegates to util/sentinelComment.ts's commentNote(), same as
// getFileSkeleton.ts's degradedNotice and getSymbolWithContext.ts's headers.

import { describe, it, expect } from "vitest";
import { regexFallbackSkeleton, regexSignatureLines } from "../skeleton/regexFallback.js";

const NOTE = "note: AST-fallback mode (no scope header); use get_file_skeleton instead for unsupported languages.";

describe("regexFallbackSkeleton", () => {
  it("appends a // -formed note for typescript (unchanged)", () => {
    const out = regexFallbackSkeleton("export function x() {}\n", "typescript");
    expect(out).toBe(`export function x() {}\n\n// ${NOTE}`);
  });

  it("appends a # -formed note for python (unchanged)", () => {
    const out = regexFallbackSkeleton("def x():\n    pass\n", "python");
    expect(out).toBe(`def x():\n\n# ${NOTE}`);
  });

  it("appends a # -formed note for ruby (unchanged)", () => {
    const out = regexFallbackSkeleton("def x\nend\n", "ruby");
    expect(out).toBe(`def x\n\n# ${NOTE}`);
  });

  it("appends a /* ... */ -formed note for css (fixed — css has no line-comment syntax)", () => {
    const out = regexFallbackSkeleton(":root { --x: 1; }\n", "css");
    expect(out).toBe(`(no signatures detected)\n\n/* ${NOTE} */`);
  });

  it("the css note contains no // line anywhere in the output", () => {
    const out = regexFallbackSkeleton(":root { --x: 1; }\n", "css");
    for (const line of out.split("\n")) {
      expect(line.trim().startsWith("//")).toBe(false);
    }
  });

  it("css has no LANG_PATTERNS entry, so the body is always the no-signatures notice", () => {
    // regexSignatureLines has no css pattern (css skeletons go through the
    // dedicated tree-sitter CSS outline instead — see treeSitterCss.spec.ts);
    // this fallback only engages when tree-sitter itself is unavailable/empty.
    expect(regexSignatureLines(":root { --x: 1; }\n.card { color: red; }\n", "css")).toEqual([]);
  });
});
