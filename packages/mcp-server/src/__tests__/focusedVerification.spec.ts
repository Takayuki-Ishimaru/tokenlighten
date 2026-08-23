// focusedVerification.spec.ts — V11-06 Known-Local Fast Path v2: Focused
// Verification. Every check is independently callable and independently
// tested; `runFocusedVerification` composes them.

import { describe, it, expect } from "vitest";
import {
  verifyReplacementCount,
  verifyChangedLineCap,
  verifyChangeConfinement,
  verifyFormatDelta,
  verifyPostSha,
  verifyParseCheck,
  runFocusedVerification,
} from "../write/focusedVerification.js";
import { FINGERPRINT_WINDOW_CHARS } from "../write/targetFingerprint.js";
import type { CollectSymbolsAttempt } from "../symbols/collectSymbols.js";

describe("verifyReplacementCount", () => {
  it("passes when the anchor occurs exactly the expected number of times", () => {
    const result = verifyReplacementCount({ beforeText: "a\nb\na\n", anchorText: "b", expectedReplacementCount: 1 });
    expect(result.ok).toBe(true);
    expect(result.name).toBe("replacement-count");
  });

  it("fails when the actual count disagrees with expectation", () => {
    const result = verifyReplacementCount({ beforeText: "b\nb\n", anchorText: "b", expectedReplacementCount: 1 });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("found 2");
  });
});

describe("verifyChangedLineCap", () => {
  it("passes for a normal, small single-hunk edit", () => {
    const beforeText = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n") + "\n";
    const result = verifyChangedLineCap({ beforeText, anchorText: "line 5", replacementText: "line FIVE" });
    expect(result.ok).toBe(true);
  });

  it("fails when the edit replaces/shrinks the file at blastRadius's whole-file scale (reuses write/blastRadius.ts's own threshold)", () => {
    // A file well beyond blastRadius's TINY exemption, where the edit
    // replaces essentially the whole thing with something far shorter.
    const beforeText = Array.from({ length: 200 }, (_, i) => `line number ${i} with some real content here`).join("\n") + "\n";
    const result = verifyChangedLineCap({ beforeText, anchorText: beforeText, replacementText: "x" });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/exceeds blastRadius/);
  });
});

describe("verifyChangeConfinement", () => {
  it("passes when the ONLY difference is inside the fingerprinted span", () => {
    const beforeText = "AAAA target BBBB";
    const afterText = "AAAA TARGET BBBB";
    const spanStart = beforeText.indexOf("target");
    const spanEnd = spanStart + "target".length;
    const result = verifyChangeConfinement({ beforeText, afterText, spanStart, spanEnd });
    expect(result.ok).toBe(true);
  });

  it("fails when the diff escapes the fingerprinted window — an unexpected surface change", () => {
    const padding = "P".repeat(FINGERPRINT_WINDOW_CHARS * 4);
    const beforeText = `${padding}\ntarget\n${padding}`;
    // Mutate something far OUTSIDE the fingerprint window around "target".
    const afterText = `${padding.replace("PPP", "QQQ")}\ntarget\n${padding}`;
    const spanStart = beforeText.indexOf("target");
    const spanEnd = spanStart + "target".length;
    const result = verifyChangeConfinement({ beforeText, afterText, spanStart, spanEnd });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("escapes the fingerprinted window");
  });
});

describe("verifyFormatDelta", () => {
  it("disclosure-only: always ok:true, even when it detects a whitespace-only change", () => {
    const result = verifyFormatDelta({ anchorText: "const  x = 1;", replacementText: "const x = 1;" });
    expect(result.ok).toBe(true);
    expect(result.detail).toContain("whitespace-only");
  });

  it("labels a substantive (non-whitespace) change distinctly, still ok:true", () => {
    const result = verifyFormatDelta({ anchorText: "const x = 1;", replacementText: "const x = 2;" });
    expect(result.ok).toBe(true);
    expect(result.detail).toContain("non-whitespace");
  });

  it("labels an identical search/replace pair distinctly", () => {
    const result = verifyFormatDelta({ anchorText: "same", replacementText: "same" });
    expect(result.detail).toContain("identical");
  });
});

describe("verifyPostSha", () => {
  it("skipped when no post-write read is supplied", () => {
    const result = verifyPostSha({ expectedAfterText: "x", postReadText: undefined });
    expect(result.skipped).toBe(true);
    expect(result.ok).toBe(true);
  });

  it("passes when the fresh read matches the intended write", () => {
    const result = verifyPostSha({ expectedAfterText: "hello\n", postReadText: "hello\n" });
    expect(result.ok).toBe(true);
    expect(result.skipped).toBeUndefined();
  });

  it("fails when the fresh read does NOT match — the write did not land as intended", () => {
    const result = verifyPostSha({ expectedAfterText: "hello\n", postReadText: "goodbye\n" });
    expect(result.ok).toBe(false);
  });
});

describe("verifyParseCheck", () => {
  it("skipped for a path with no known language", async () => {
    const result = await verifyParseCheck({ path: "README", afterText: "hello" });
    expect(result.skipped).toBe(true);
    expect(result.ok).toBe(true);
  });

  it("skipped for a known language with no tree-sitter grammar (e.g. yaml)", async () => {
    const result = await verifyParseCheck({ path: "config.yaml", afterText: "a: 1\n" });
    expect(result.skipped).toBe(true);
  });

  it("passes when the injected collector reports a successful parse", async () => {
    const attempt: CollectSymbolsAttempt = { symbols: [], parserAvailable: true };
    const result = await verifyParseCheck(
      { path: "src/a.ts", afterText: "export function f() {}\n" },
      { collect: async () => attempt },
    );
    expect(result.ok).toBe(true);
    expect(result.skipped).toBeUndefined();
  });

  it("fails when the injected collector reports the grammar failed to parse", async () => {
    const attempt: CollectSymbolsAttempt = { symbols: [], parserAvailable: false };
    const result = await verifyParseCheck(
      { path: "src/a.ts", afterText: "export function f() {}\n" },
      { collect: async () => attempt },
    );
    expect(result.ok).toBe(false);
  });

  it("really parses valid TypeScript with the REAL collector (no injection)", async () => {
    const result = await verifyParseCheck({ path: "src/real.ts", afterText: "export function real(): number {\n  return 1;\n}\n" });
    expect(result.skipped).toBeUndefined();
    expect(result.ok).toBe(true);
  });
});

describe("runFocusedVerification", () => {
  it("allPassed is true when every non-skipped check passes", async () => {
    const beforeText = "export function foo(): number {\n  return 1;\n}\n";
    const afterText = "export function foo(): number {\n  return 2;\n}\n";
    const report = await runFocusedVerification({
      path: "src/foo.ts",
      beforeText,
      afterText,
      anchorText: "return 1;",
      replacementText: "return 2;",
      expectedReplacementCount: 1,
      spanStart: beforeText.indexOf("return 1;"),
      spanEnd: beforeText.indexOf("return 1;") + "return 1;".length,
      postReadText: afterText,
    });
    expect(report.allPassed).toBe(true);
    expect(report.checks.map((c) => c.name).sort()).toEqual(
      ["changed-line-cap", "format-delta", "parse-check", "post-sha", "replacement-count", "unexpected-surface"].sort(),
    );
  });

  it("allPassed is false when any non-skipped check fails", async () => {
    const beforeText = "export function foo(): number {\n  return 1;\n}\n";
    const afterText = "export function foo(): number {\n  return 2;\n}\n";
    const report = await runFocusedVerification({
      path: "src/foo.ts",
      beforeText,
      afterText,
      anchorText: "return 1;",
      replacementText: "return 2;",
      expectedReplacementCount: 1,
      spanStart: beforeText.indexOf("return 1;"),
      spanEnd: beforeText.indexOf("return 1;") + "return 1;".length,
      postReadText: "SOMETHING ELSE ENTIRELY", // fails post-sha
    });
    expect(report.allPassed).toBe(false);
    expect(report.checks.find((c) => c.name === "post-sha")?.ok).toBe(false);
  });

  it("skipParseCheck omits the parse-check entry entirely", async () => {
    const beforeText = "export function foo(): number {\n  return 1;\n}\n";
    const afterText = "export function foo(): number {\n  return 2;\n}\n";
    const report = await runFocusedVerification(
      {
        path: "src/foo.ts",
        beforeText,
        afterText,
        anchorText: "return 1;",
        replacementText: "return 2;",
        expectedReplacementCount: 1,
        spanStart: beforeText.indexOf("return 1;"),
        spanEnd: beforeText.indexOf("return 1;") + "return 1;".length,
      },
      { skipParseCheck: true },
    );
    expect(report.checks.some((c) => c.name === "parse-check")).toBe(false);
  });

  it("a skipped check (e.g. unknown-language parse-check) never drags allPassed to false on its own", async () => {
    const beforeText = "hello world\n";
    const afterText = "hello THERE\n";
    const report = await runFocusedVerification({
      path: "notes.txt", // no known language ⇒ parse-check skipped
      beforeText,
      afterText,
      anchorText: "world",
      replacementText: "THERE",
      expectedReplacementCount: 1,
      spanStart: beforeText.indexOf("world"),
      spanEnd: beforeText.indexOf("world") + "world".length,
    });
    expect(report.checks.find((c) => c.name === "parse-check")?.skipped).toBe(true);
    expect(report.allPassed).toBe(true);
  });
});
