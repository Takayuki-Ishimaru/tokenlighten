// editSelector.spec.ts — V11-06 Known-Local Fast Path v2: Edit
// Representation Selector. Pure module — no filesystem, no mocks. One
// canonical fixture per representation, in the plan's fixed priority order:
// unique literal -> bounded range -> symbol body -> structured scalar ->
// orchestrated fallback.

import { describe, it, expect } from "vitest";
import { selectEditRepresentation, EDIT_REPRESENTATION_ORDER } from "../write/editSelector.js";

describe("EDIT_REPRESENTATION_ORDER", () => {
  it("is the plan's fixed priority order", () => {
    expect(EDIT_REPRESENTATION_ORDER).toEqual([
      "unique-literal",
      "bounded-range",
      "symbol-body",
      "structured-scalar",
      "orchestrated-fallback",
    ]);
  });
});

describe("selectEditRepresentation — empty search", () => {
  it("refuses as unsupported — an empty search carries no anchor", () => {
    const result = selectEditRepresentation({ path: "src/a.ts", fileText: "hello\n", search: "" });
    expect(result).toEqual({ ok: false, code: "unsupported", reason: expect.any(String) });
  });
});

describe("selectEditRepresentation — 1. unique literal", () => {
  it("chosen when the search string is unique across the whole file, with NO hints", () => {
    const fileText = "const a = 1;\nconst b = 2;\nconst c = 3;\n";
    const result = selectEditRepresentation({ path: "src/a.ts", fileText, search: "const b = 2;" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.selection.representation).toBe("unique-literal");
    expect(result.selection.anchorText).toBe("const b = 2;");
    expect(result.selection.spanStart).toBe(fileText.indexOf("const b = 2;"));
    expect(result.selection.fingerprint.expectedCount).toBe(1);
  });

  it("wins over every hint even when hints are ALSO present — cheapest strategy checked first", () => {
    const fileText = "const UNIQUE_TOKEN = 1;\n// body\n";
    const result = selectEditRepresentation({
      path: "src/a.ts",
      fileText,
      search: "UNIQUE_TOKEN",
      hints: {
        range: { startLine: 1, endLine: 2 },
        symbol: { name: "whatever", bodyStart: 0, bodyEnd: fileText.length },
        structuredScalar: { keyPath: "UNIQUE_TOKEN" },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.selection.representation).toBe("unique-literal");
  });
});

describe("selectEditRepresentation — 2. bounded range", () => {
  const fileText = [
    "function target() {",
    "  return VALUE;",
    "}",
    "",
    "function other() {",
    "  return VALUE;",
    "}",
  ].join("\n");

  it("chosen when the search is ambiguous file-wide but unique within the range hint", () => {
    // "VALUE" occurs twice file-wide.
    expect(selectEditRepresentation({ path: "src/a.ts", fileText, search: "VALUE" }).ok).toBe(false);

    const result = selectEditRepresentation({
      path: "src/a.ts",
      fileText,
      search: "VALUE",
      hints: { range: { startLine: 1, endLine: 3 } },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.selection.representation).toBe("bounded-range");
    // The FIRST occurrence (line 2), not the second (line 6).
    expect(result.selection.spanStart).toBe(fileText.indexOf("VALUE"));
  });

  it("does not fire when the range hint is ALSO ambiguous — falls through toward symbol/structured/fallback", () => {
    const result = selectEditRepresentation({
      path: "src/a.ts",
      fileText: `${fileText}\n${fileText}`, // duplicate the whole thing so even the range is ambiguous
      search: "VALUE",
      hints: { range: { startLine: 1, endLine: 14 } },
    });
    expect(result.ok).toBe(false);
  });
});

describe("selectEditRepresentation — 3. symbol body", () => {
  const fileText = [
    "const shared = COUNT;", // occurrence #1, OUTSIDE both symbol bodies and outside any given range
    "function alpha() {",
    "  return COUNT;", // occurrence #2 — inside alpha's body
    "}",
    "function beta() {",
    "  return COUNT;", // occurrence #3 — inside beta's body
    "}",
  ].join("\n");
  const alphaStart = fileText.indexOf("function alpha");
  const alphaEnd = fileText.indexOf("function beta");

  it("chosen when the search is ambiguous file-wide (and the range hint doesn't help) but unique within the symbol body hint", () => {
    // "COUNT" occurs three times file-wide.
    expect(selectEditRepresentation({ path: "src/a.ts", fileText, search: "COUNT" }).ok).toBe(false);

    const result = selectEditRepresentation({
      path: "src/a.ts",
      fileText,
      search: "COUNT",
      hints: { symbol: { name: "alpha", kind: "function", bodyStart: alphaStart, bodyEnd: alphaEnd } },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.selection.representation).toBe("symbol-body");
    expect(result.selection.fingerprint.symbolKind).toBe("function");
    // Located WITHIN alpha's body, not the earlier file-level occurrence.
    expect(result.selection.spanStart).toBeGreaterThanOrEqual(alphaStart);
    expect(result.selection.spanStart).toBeLessThan(alphaEnd);
  });

  it("wins over a structured-scalar hint that is ALSO present", () => {
    const result = selectEditRepresentation({
      path: "src/a.ts",
      fileText,
      search: "COUNT",
      hints: {
        symbol: { name: "alpha", bodyStart: alphaStart, bodyEnd: alphaEnd },
        structuredScalar: { keyPath: "COUNT" }, // would never resolve on this non-config fixture anyway
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.selection.representation).toBe("symbol-body");
  });
});

describe("selectEditRepresentation — 4. structured scalar (config keys)", () => {
  it("chosen when the search is ambiguous by TEXT alone (2 lines share the value), and the keyPath hint's LAST segment narrows it to the one line whose value actually contains it", () => {
    const fileText = ["{", '  "name": "2.0.0",', '  "nested": {', '    "version": "2.0.0"', "  }", "}"].join("\n");
    // "2.0.0" occurs TWICE file-wide (once as "name", once as "nested.version")
    // — genuinely ambiguous, so "unique-literal" must fail first.
    expect(selectEditRepresentation({ path: "package.json", fileText, search: '"2.0.0"' }).ok).toBe(false);

    const result = selectEditRepresentation({
      path: "package.json",
      fileText,
      search: '"2.0.0"',
      hints: { structuredScalar: { keyPath: "nested.version" } },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.selection.representation).toBe("structured-scalar");
    expect(result.selection.anchorText).toBe('"2.0.0"');
    // Located at the "version" line's value, not the earlier "name" line's.
    expect(result.selection.spanStart).toBe(fileText.lastIndexOf('"2.0.0"'));
  });

  it("a same-named key at a DIFFERENT nesting level is safe: both are name-candidates, but only the value-matching one is ever selected — never a wrong-target pick", () => {
    const fileText = ['{', '  "version": "1.0.0",', '  "other": "1.0.0",', '  "nested": {', '    "version": "9.9.9"', "  }", "}"].join("\n");
    // "1.0.0" occurs TWICE file-wide ("version" and "other") — ambiguous.
    expect(selectEditRepresentation({ path: "package.json", fileText, search: '"1.0.0"' }).ok).toBe(false);

    // BOTH the top-level and nested lines are named "version" (2 name
    // candidates), but only the top-level one's VALUE contains "1.0.0" — the
    // nested one (value "9.9.9") is safely excluded rather than guessed.
    const result = selectEditRepresentation({
      path: "package.json",
      fileText,
      search: '"1.0.0"',
      hints: { structuredScalar: { keyPath: "version" } },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.selection.representation).toBe("structured-scalar");
    expect(result.selection.spanStart).toBe(fileText.indexOf('"1.0.0"'));
  });

  it("two same-named keys whose values BOTH match the search text ⇒ refuses (never auto-picks one)", () => {
    const bothMatch = ['{', '  "dup": "X",', '  "dup": "X"', "}"].join("\n");
    const result = selectEditRepresentation({
      path: "package.json",
      fileText: bothMatch,
      search: '"X"',
      hints: { structuredScalar: { keyPath: "dup" } },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("ambiguous");
  });
});

describe("selectEditRepresentation — 5. orchestrated fallback", () => {
  it("not-found: search absent everywhere, no hint locates it either", () => {
    const result = selectEditRepresentation({ path: "src/a.ts", fileText: "const a = 1;\n", search: "NOPE" });
    expect(result).toEqual({ ok: false, code: "not-found", reason: expect.any(String) });
  });

  it("ambiguous match ⇒ selection refuses, NEVER auto-picks", () => {
    const fileText = "dup\ndup\ndup\n";
    const result = selectEditRepresentation({ path: "src/a.ts", fileText, search: "dup" });
    expect(result).toEqual({ ok: false, code: "ambiguous", reason: expect.any(String) });
    // Explicitly: no selection object is ever produced on this path.
    expect((result as { selection?: unknown }).selection).toBeUndefined();
  });

  it("ambiguous match with a hint present that still fails to disambiguate ⇒ refuses (orchestrated fallback, not a guess)", () => {
    const fileText = "dup\ndup\ndup\n";
    const result = selectEditRepresentation({
      path: "src/a.ts",
      fileText,
      search: "dup",
      hints: { range: { startLine: 1, endLine: 3 } }, // still 3 occurrences in-range
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("ambiguous");
  });
});
