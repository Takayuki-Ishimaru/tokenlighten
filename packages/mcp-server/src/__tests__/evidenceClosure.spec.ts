/**
 * evidenceClosure.spec.ts — FIX-C1 (eval-0927 P0-1). Unit coverage for
 * evidenceClosure.ts's pure functions: `findModuleConstantWindow` and
 * `importSpecifiersNaming`, at least one constant case and one import case
 * per language family (TS/JS, Python, Go, Java, C#, C/C++ —
 * brief-fix-c1.md's own acceptance list), plus `constantLikeReferencesIn`/
 * `calleeNamesIn`'s locals/params/property-access exclusion.
 *
 * "callers" coverage per language is NOT re-tested here: brief-fix-c1.md
 * Deliverable 3 reuses callerExpansion.ts's OWN pure functions directly for
 * the callers/flow facets (its logic, not its flag — its own module doc
 * already claims, and callerExpansion.spec.ts already verifies, TS/JS,
 * Python, Go, Java, C#, C/C++ coverage for `findCallOccurrences`/
 * `maskNonCode`/`hasHashComments`). This file instead confirms the
 * `hasHashComments` boundary those primitives depend on for every language
 * this module's OWN constant scanner also targets, so a future edit to
 * either module's shared assumption is caught from both sides.
 */
import { describe, expect, it } from "vitest";

import { hasHashComments } from "../features/task-pack/callerExpansion.js";
import {
  calleeNamesIn,
  constantLikeReferencesIn,
  findModuleConstantWindow,
  importSpecifiersNaming,
  MAX_CONSTANT_WINDOW_LINES,
} from "../features/task-pack/evidenceClosure.js";

function lines(text: string): string[] {
  return text.split("\n");
}

describe("findModuleConstantWindow: one constant case per language family", () => {
  it("TS/JS: exported const object literal (the eval-0927 DEFAULT_OPTIONS fixture shape)", () => {
    const src = [
      "export interface ClientOptions {",
      "  timeoutMs: number;",
      "}",
      "",
      "export const DEFAULT_OPTIONS: ClientOptions = {",
      "  timeoutMs: 5000,",
      "  maxAttempts: 3,",
      "};",
      "",
      "export function loadOptions() { return DEFAULT_OPTIONS; }",
    ].join("\n");
    const win = findModuleConstantWindow(lines(src), "DEFAULT_OPTIONS", false);
    expect(win).toBeDefined();
    expect(win!.start).toBe(5);
    expect(win!.end).toBe(8);
    expect(win!.truncated).toBe(false);
  });

  it("TS/JS: non-exported let and a const enum are both found", () => {
    expect(findModuleConstantWindow(lines("let RETRY_COUNT = 3;\n"), "RETRY_COUNT", false)?.end).toBe(1);
    const src = ["export const enum Status {", "  Active,", "  Inactive,", "}"].join("\n");
    expect(findModuleConstantWindow(lines(src), "Status", false)).toEqual({ start: 1, end: 4, truncated: false });
  });

  it("Python: module-level assignment and a typed assignment, column 0 only", () => {
    expect(findModuleConstantWindow(lines("DEFAULT_TIMEOUT = 5000\n"), "DEFAULT_TIMEOUT", true)?.end).toBe(1);
    expect(findModuleConstantWindow(lines("MAX_RETRIES: int = 3\n"), "MAX_RETRIES", true)?.end).toBe(1);
    const indented = ["def f():", "    LOCAL_NOT_MODULE_LEVEL = 1", "    return LOCAL_NOT_MODULE_LEVEL"].join("\n");
    expect(findModuleConstantWindow(lines(indented), "LOCAL_NOT_MODULE_LEVEL", true)).toBeUndefined();
  });

  it("Go: a single const/var declaration, and a grouped const(...) block member", () => {
    expect(findModuleConstantWindow(lines("const MaxRetries = 3\n"), "MaxRetries", false)?.end).toBe(1);
    const grouped = ["const (", "\tDefaultTimeout = 5 * time.Second", "\tMaxRetries     = 3", ")"].join("\n");
    const win = findModuleConstantWindow(lines(grouped), "MaxRetries", false);
    expect(win).toEqual({ start: 3, end: 3, truncated: false });
  });

  it("Java: a static final field (indented class member, not column 0)", () => {
    const src = [
      "public class RetryPolicy {",
      "  private static final int MAX_ATTEMPTS = 3;",
      "  int attempts;",
      "}",
    ].join("\n");
    expect(findModuleConstantWindow(lines(src), "MAX_ATTEMPTS", false)?.start).toBe(2);
  });

  it("Java: an enum type declaration", () => {
    const src = ["public class C {", "  public enum Status { ACTIVE, INACTIVE }", "}"].join("\n");
    expect(findModuleConstantWindow(lines(src), "Status", false)?.start).toBe(2);
  });

  it("C#: a static readonly field, modifiers in either order", () => {
    expect(
      findModuleConstantWindow(lines("  private static readonly int MaxAttempts = 3;\n"), "MaxAttempts", false)?.start,
    ).toBe(1);
    expect(
      findModuleConstantWindow(lines("  private readonly static int MaxAttempts = 3;\n"), "MaxAttempts", false)?.start,
    ).toBe(1);
  });

  it("C/C++: #define, and a file-scope constexpr", () => {
    expect(findModuleConstantWindow(lines("#define MAX_RETRIES 3\n"), "MAX_RETRIES", false)?.end).toBe(1);
    expect(findModuleConstantWindow(lines("static constexpr int kMaxRetries = 3;\n"), "kMaxRetries", false)?.end).toBe(1);
  });

  it("a declaration inside a comment or string never matches (maskNonCode boundary)", () => {
    const src = [
      '// const DEFAULT_OPTIONS = "not a real declaration";',
      'const s = "const DEFAULT_OPTIONS = 1";',
    ].join("\n");
    expect(findModuleConstantWindow(lines(src), "DEFAULT_OPTIONS", false)).toBeUndefined();
  });

  it("a large declaration is capped at MAX_CONSTANT_WINDOW_LINES and reported truncated, never silently dropped", () => {
    const body = Array.from({ length: MAX_CONSTANT_WINDOW_LINES + 10 }, (_, i) => `  v${i}: ${i},`);
    const src = ["export const BIG = {", ...body, "};"].join("\n");
    const win = findModuleConstantWindow(lines(src), "BIG", false);
    expect(win).toBeDefined();
    expect(win!.truncated).toBe(true);
    expect(win!.end - win!.start + 1).toBe(MAX_CONSTANT_WINDOW_LINES);
  });
});

describe("importSpecifiersNaming: one import case per language family", () => {
  it("TS/JS: named import (with an alias), default import, and require destructuring", () => {
    expect(
      importSpecifiersNaming(lines('import { loadOptions, type ClientOptions } from "./config";'), "loadOptions", false),
    ).toEqual([{ specifier: "./config", relative: true, wildcard: false, packageEligible: true }]);
    expect(
      importSpecifiersNaming(lines('import { foo as DEFAULT_OPTIONS } from "./config";'), "DEFAULT_OPTIONS", false),
    ).toEqual([{ specifier: "./config", relative: true, wildcard: false, packageEligible: true, exportedName: "foo" }]);
    expect(
      importSpecifiersNaming(lines('import defaultThing from "./thing";'), "defaultThing", false),
    ).toEqual([{ specifier: "./thing", relative: true, wildcard: false, packageEligible: true }]);
    expect(
      importSpecifiersNaming(lines('const { RETRYABLE_STATUSES } = require("./retry");'), "RETRYABLE_STATUSES", false),
    ).toEqual([{ specifier: "./retry", relative: true, wildcard: false, packageEligible: true }]);
  });

  it("Python: from-import (with alias) and a bare module import", () => {
    expect(
      importSpecifiersNaming(lines("from .config import DEFAULT_TIMEOUT"), "DEFAULT_TIMEOUT", true),
    ).toEqual([{ specifier: ".config", relative: true, wildcard: false, packageEligible: true }]);
    expect(
      importSpecifiersNaming(lines("from pkg.config import DEFAULT_TIMEOUT as TIMEOUT"), "TIMEOUT", true),
    ).toEqual([{ specifier: "pkg.config", relative: false, wildcard: false, packageEligible: true, exportedName: "DEFAULT_TIMEOUT" }]);
  });

  it("Go: never resolves an individual name (package-qualified access is this module's own stated limitation)", () => {
    expect(importSpecifiersNaming(lines('import "myapp/config"'), "DefaultTimeout", false)).toEqual([]);
  });

  it("Java: import static names the exact member", () => {
    expect(
      importSpecifiersNaming(lines("import static com.acme.Config.MAX_RETRIES;"), "MAX_RETRIES", false),
    ).toEqual([{ specifier: "com.acme.Config", relative: false, wildcard: false, packageEligible: false }]);
  });

  it("C#: using static carries the whole class as a candidate (cannot isolate one member)", () => {
    expect(
      importSpecifiersNaming(lines("using static Acme.Config;"), "MaxRetries", false),
    ).toEqual([{ specifier: "Acme.Config", relative: false, wildcard: true, packageEligible: false }]);
  });

  it("C/C++: a local #include is always a candidate (a macro/enum has no per-name trace)", () => {
    expect(
      importSpecifiersNaming(lines('#include "config.h"'), "MAX_RETRIES", false),
    ).toEqual([{ specifier: "config.h", relative: true, wildcard: true, packageEligible: false }]);
  });

  it("an import inside a comment never matches", () => {
    expect(
      importSpecifiersNaming(lines('// import { DEFAULT_OPTIONS } from "./config";'), "DEFAULT_OPTIONS", false),
    ).toEqual([]);
  });
});

describe("constantLikeReferencesIn: shape + property-access exclusion", () => {
  it("finds an UPPER_SNAKE reference and a PascalCase hump, skips a property/member name and the own name", () => {
    const body = [
      "  const timeoutMs = options.timeoutMs;",
      "  return RETRYABLE_STATUSES.has(status) || Status.Active === status;",
    ];
    const refs = constantLikeReferencesIn(body, false, "shouldRetry", new Set(["status"]));
    expect(refs).toContain("RETRYABLE_STATUSES");
    expect(refs).toContain("Status");
    expect(refs).not.toContain("has");
    expect(refs).not.toContain("Active");
    expect(refs).not.toContain("timeoutMs");
    expect(refs).not.toContain("shouldRetry");
  });

  it("excludes an ordinary prose ALL-CAPS acronym (API, HTTP, ...)", () => {
    expect(constantLikeReferencesIn(["  const req = new HTTP.Request(url);"], false, "f")).not.toContain("HTTP");
  });
});

describe("calleeNamesIn: call-shape detection excludes control-flow/declaration keywords", () => {
  it("finds a bare call and a qualified call, excludes if/for/function/own-name", () => {
    const body = [
      "  if (isReady()) {",
      "    for (const x of items) { process(x); }",
      "  }",
      "  return loadOptions(env);",
    ];
    const callees = calleeNamesIn(body, false, "fetchWithRetry");
    expect(callees).toContain("isReady");
    expect(callees).toContain("process");
    expect(callees).toContain("loadOptions");
    expect(callees).not.toContain("if");
    expect(callees).not.toContain("for");
    expect(callees).not.toContain("fetchWithRetry");
  });
});

describe("hasHashComments: the language boundary this module's declaration shapes rely on", () => {
  it("Python is hash-commented; Go, Java, C#, C/C++, TS/JS are not (// or /* */ instead)", () => {
    expect(hasHashComments("src/config.py")).toBe(true);
    expect(hasHashComments("src/config.go")).toBe(false);
    expect(hasHashComments("Config.java")).toBe(false);
    expect(hasHashComments("Config.cs")).toBe(false);
    expect(hasHashComments("config.h")).toBe(false);
    expect(hasHashComments("config.ts")).toBe(false);
  });
});
