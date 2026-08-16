/**
 * collectSymbolsDocComment.spec.ts — MAX_DOC_COMMENT_LINES bound (2026-08-01).
 *
 * Measured live: docCommentBefore walked single-line comment runs (#, ///)
 * with no size bound, so a 2-line Python function under a 300-line comment
 * wall collected startLine=1 — a "symbol-scoped" range covering 99% of a
 * 304-line file, which a later {handle, content} full-body replace wiped.
 * The bound is whole-or-nothing: a run/block within the cap attaches intact
 * (B4.1 dangling-delimiter safety needs the WHOLE block inside the range),
 * an oversized one attaches nothing (the wall stays fully OUTSIDE the range,
 * which is equally safe — only PARTIAL attachment can dangle a delimiter).
 * The end-to-end dispatch shape is pinned by editCodeHandle.spec.ts and the
 * replay corpus scw group; these are the collector-level boundary cases.
 */

import { describe, it, expect } from "vitest";

import { collectSymbols, type CollectedSymbol } from "../symbols/collectSymbols.js";

function pythonWithLeadingComments(commentLines: number): string {
  return [
    ...Array.from({ length: commentLines }, (_, i) => `# padding line ${i}`),
    "def target_fn(x):",
    "    return x + 1",
    "",
    "AFTER_TARGET = 1",
  ].join("\n") + "\n";
}

async function targetFn(source: string): Promise<CollectedSymbol> {
  const symbols = await collectSymbols(source, "python");
  const found = symbols.find((symbol) => symbol.name === "target_fn");
  expect(found, "fixture must collect target_fn").toBeDefined();
  return found!;
}

describe("collectSymbols — leading-comment absorption bound", () => {
  it("a 300-line comment wall does NOT attach: the range starts at the declaration", async () => {
    const found = await targetFn(pythonWithLeadingComments(300));
    // Pre-fix: startLine was 1 (99% of the file). The declaration sits on
    // line 301; signatureStartLine and the widened startLine now agree.
    expect(found.startLine).toBe(301);
    expect(found.signatureStartLine).toBe(301);
    expect(found.docComment).toBeUndefined();
  });

  it("a modest comment run still attaches whole (docstring behavior unchanged)", async () => {
    const found = await targetFn(pythonWithLeadingComments(10));
    expect(found.startLine).toBe(1);
    expect(found.signatureStartLine).toBe(11);
    expect(found.docComment).toBeDefined();
    expect(found.docComment!.lines.length).toBe(10);
  });

  it("a run at exactly the 64-line cap attaches; one line over does not", async () => {
    const atCap = await targetFn(pythonWithLeadingComments(64));
    expect(atCap.startLine).toBe(1);
    expect(atCap.docComment).toBeDefined();

    const overCap = await targetFn(pythonWithLeadingComments(65));
    expect(overCap.startLine).toBe(66);
    expect(overCap.docComment).toBeUndefined();
  });

  it("an oversized /** block drops WHOLE (never partial — no dangling delimiter risk)", async () => {
    const bigBlock = [
      "/**",
      ...Array.from({ length: 68 }, (_, i) => ` * generated doc filler line ${i}`),
      " */",
      "export function documented(): number {",
      "  return 1;",
      "}",
    ].join("\n") + "\n";
    const symbols = await collectSymbols(bigBlock, "typescript");
    const found = symbols.find((symbol) => symbol.name === "documented");
    expect(found).toBeDefined();
    // 70-line block > cap: range starts at the declaration (line 71) and the
    // block stays fully outside it.
    expect(found!.startLine).toBe(71);
    expect(found!.docComment).toBeUndefined();
  });

  it("a normal /** block within the cap keeps attaching whole", async () => {
    const smallBlock = [
      "/**",
      " * Regular doc.",
      " */",
      "export function documented(): number {",
      "  return 1;",
      "}",
    ].join("\n") + "\n";
    const symbols = await collectSymbols(smallBlock, "typescript");
    const found = symbols.find((symbol) => symbol.name === "documented");
    expect(found).toBeDefined();
    expect(found!.startLine).toBe(1);
    expect(found!.docComment).toBeDefined();
    expect(found!.signatureStartLine).toBe(4);
  });
});
