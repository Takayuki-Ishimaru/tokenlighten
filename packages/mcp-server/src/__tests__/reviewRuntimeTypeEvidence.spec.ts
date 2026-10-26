import { describe, expect, it } from "vitest";
import { hasValuePositionOccurrence, runtimeValueLines, configurationEvidenceSpan } from "../features/task-pack/evidenceClosure.js";
describe("TypeScript runtime value evidence", () => {
  it.each([
    ["return value < DEFAULT_LIMIT;", "DEFAULT_LIMIT", true],
    ["return (value as Flag) < DEFAULT_LIMIT;", "DEFAULT_LIMIT", true],
    ["return (value as Flag) < DEFAULT_LIMIT;", "Flag", false],
    ["const result: Record<string, Widget> = VALUE;", "Widget", false],
    ["const result: Record<string, Widget> = VALUE;", "VALUE", true],
    ["return condition ? LEFT : RIGHT;", "LEFT", true],
    ["return condition ? LEFT : RIGHT;", "RIGHT", true],
    ["return VALUE satisfies Schema;", "VALUE", true],
    ["return VALUE satisfies Schema;", "Schema", false],
    ["return Factory<Settings>(INPUT);", "Settings", false],
    ["return Factory<Settings>(INPUT);", "INPUT", true],
    ["class Child extends Base<Shape> {}", "Base", true],
    ["class Child extends Base<Shape> {}", "Shape", false],
    ["read(): NodeJS.ErrnoException { return DEFAULT; }", "NodeJS.ErrnoException", false],
    ["read(): NodeJS.ErrnoException { return DEFAULT; }", "DEFAULT", true],
    ["return (error as NodeJS.ErrnoException).code;", "NodeJS.ErrnoException", false],
    ["return NodeJS.ErrnoException;", "NodeJS.ErrnoException", true],
  ])("classifies %s / %s as runtime=%s", (line, name, expected) => {
    expect(hasValuePositionOccurrence([line as string], false, name as string, "source.ts")).toBe(expected);
  });
  it("preserves line count and UTF-16 offsets", () => {
    const lines = ['const text = "日本語";', "const value: Shape = DEFAULT;"];
    const result = runtimeValueLines(lines, "source.ts");
    expect(result).toHaveLength(lines.length);
    for (let i = 0; i < lines.length; i++) expect(result[i]!.length).toBe(lines[i]!.length);
    expect(result[0]).toBe(lines[0]);
    expect(result[1]).toContain("DEFAULT");
    expect(result[1]).not.toContain("Shape");
  });
});

describe("connected configuration evidence", () => {
  const lines = [
    'function optionPath() { return process.env.OPTIONS_FILE || "/home/example/options.json"; }',
    'function baseline() { return { featureGate: { enabled: false } }; }',
    'function strict(file = optionPath()) { const defaults = baseline(); const raw = readFileSync(file); return { ...defaults, ...JSON.parse(raw) }; }',
    'function normal(file = optionPath()) { try { return strict(file); } catch { return baseline(); } }',
    'function unrelated() { return MISSING_RATE; }',
  ];
  it("includes defaults, default-argument paths and the normal reader catch", () => {
    const span = configurationEvidenceSpan(lines, "options.ts", ["featureGate"]);
    expect(span).toEqual({ start: 1, end: 4 });
    const evidence = lines.slice(span!.start - 1, span!.end).join("\n");
    expect(evidence).toContain("OPTIONS_FILE");
    expect(evidence).toContain("enabled: false");
    expect(evidence).toContain("catch { return baseline(); }");
    expect(evidence).not.toContain("MISSING_RATE");
  });
  it("does not bind unknown keys or code-looking strings/comments", () => {
    expect(configurationEvidenceSpan(lines, "options.ts", ["missingGate"])).toBeUndefined();
    expect(configurationEvidenceSpan([
      'function fake() { const text = "JSON.parse(readFileSync(file))"; return { featureGate: false }; }',
    ], "options.ts", ["featureGate"])).toBeUndefined();
  });
  it("fails closed when the local call graph exceeds its bound", () => {
    const chain = Array.from({ length: 34 }, (_, i) => `function f${i}() { return ${i === 33 ? "{ featureGate: false }" : `f${i + 1}()`}; }`);
    chain.unshift('function reader(file = f0()) { return JSON.parse(readFileSync(file)); }');
    expect(configurationEvidenceSpan(chain, "options.ts", ["featureGate"])).toBeUndefined();
  });
});
