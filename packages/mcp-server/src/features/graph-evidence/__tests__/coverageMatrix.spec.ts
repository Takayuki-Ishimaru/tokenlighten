// ---------------------------------------------------------------------------
// coverageMatrix.spec.ts — V11-01 acceptance:
// "language coverage matrix を生成できる".
//
// The matrix has to answer, per language: which providers cover it, with which
// edge types, at what strength — and therefore whether graph evidence may close
// anything there at all. A language nobody parses must read as `unknown`, never
// as silently fine.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";

import { createPathHeuristicsProvider } from "../adapters.js";
import {
  buildCoverageMatrix,
  languageSummary,
  type WorkspaceSnapshot,
} from "../coverageMatrix.js";
import { GRAPH_EDGE_TYPES } from "../model.js";
import type { ProviderSet } from "../providers.js";
import {
  fixtureImportProvider,
  fixtureReferenceProvider,
  fixtureSymbolProvider,
  shaMapFor,
  IMPORT_ID,
  PATH_ID,
  REF_ID,
  SYMBOL_ID,
} from "./support.js";

// ---------------------------------------------------------------------------
// A mixed-language snapshot
// ---------------------------------------------------------------------------

const FILES = [
  { path: "src/registry.ts", language: "typescript" },
  { path: "src/plugin.ts", language: "typescript" },
  { path: "svc/handler.py", language: "python" },
  { path: "cmd/main.go", language: "go" },
  { path: "docs/architecture.md", language: "markdown" },
  { path: "tsconfig.json", language: "json" },
] as const;

const SNAPSHOT: WorkspaceSnapshot = {
  label: "mixed-language-fixture",
  files: FILES.map((file) => ({
    path: file.path,
    language: file.language,
    sha: `sha256:${file.path}`,
  })),
};

const PATHS = FILES.map((file) => file.path);

/** Parser and index coverage is uneven, which is the realistic case. */
function mixedProviders(): ProviderSet {
  return {
    references: fixtureReferenceProvider({
      definitions: {},
      references: {},
      languages: ["typescript", "python"],
    }),
    symbols: fixtureSymbolProvider({ declarations: [], languages: ["typescript"] }),
    imports: fixtureImportProvider({
      imports: {},
      files: PATHS,
      languages: ["typescript", "python", "go"],
    }),
    paths: createPathHeuristicsProvider({
      files: PATHS,
      sourceShas: shaMapFor(PATHS),
      // Deliberately narrower than the snapshot: the naming rules run
      // everywhere, but the caller only vouched for these three.
      languages: ["typescript", "python", "go"],
      id: PATH_ID,
    }),
  };
}

// ---------------------------------------------------------------------------
// 1. It generates
// ---------------------------------------------------------------------------

describe("buildCoverageMatrix", () => {
  it("produces a versioned report over every language in the snapshot", () => {
    const matrix = buildCoverageMatrix(SNAPSHOT, mixedProviders());
    expect(matrix.version).toBe(1);
    expect(matrix.snapshot).toBe("mixed-language-fixture");
    expect(matrix.languages).toEqual(["go", "json", "markdown", "python", "typescript"]);
    expect(matrix.totals.files).toBe(6);
    expect(matrix.totals.languages).toBe(5);
    expect(matrix.totals.providers).toBe(4);
  });

  it("emits one cell per language x provider", () => {
    const matrix = buildCoverageMatrix(SNAPSHOT, mixedProviders());
    expect(matrix.cells).toHaveLength(5 * 4);
    for (const language of matrix.languages) {
      const ids = matrix.cells.filter((cell) => cell.language === language).map((c) => c.provider);
      expect(new Set(ids)).toEqual(new Set([REF_ID, SYMBOL_ID, IMPORT_ID, PATH_ID]));
    }
  });

  it("counts files per language", () => {
    const matrix = buildCoverageMatrix(SNAPSHOT, mixedProviders());
    expect(languageSummary(matrix, "typescript")?.fileCount).toBe(2);
    expect(languageSummary(matrix, "go")?.fileCount).toBe(1);
    expect(languageSummary(matrix, "rust")).toBeUndefined();
  });

  it("is deterministic", () => {
    expect(JSON.stringify(buildCoverageMatrix(SNAPSHOT, mixedProviders()))).toBe(
      JSON.stringify(buildCoverageMatrix(SNAPSHOT, mixedProviders())),
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Per-language edge-type support
// ---------------------------------------------------------------------------

describe("per-language edge-type support", () => {
  it("typescript has the full semantic stack", () => {
    const summary = languageSummary(buildCoverageMatrix(SNAPSHOT, mixedProviders()), "typescript");
    expect(summary?.providers).toEqual([REF_ID, SYMBOL_ID, IMPORT_ID, PATH_ID]);
    expect(summary?.edgeTypes).toEqual([
      "IMPORTS",
      "IMPORTED_BY",
      "REFERENCES",
      "IMPLEMENTS",
      "EXTENDS",
      "TESTED_BY",
      "CONFIGURES",
      "GENERATED_FROM",
    ]);
    expect(summary?.bestEvidenceClass).toBe("direct");
  });

  it("names what is MISSING, so a gap cannot read as coverage", () => {
    const summary = languageSummary(buildCoverageMatrix(SNAPSHOT, mixedProviders()), "typescript");
    // No provider in this set can prove a call, so CALLS/CALLED_BY are missing
    // everywhere — which is the honest report for a tl-graph-shaped index.
    expect(summary?.missingEdgeTypes).toEqual(["CALLS", "CALLED_BY"]);
  });

  it("go loses the declaration provider and keeps the structural one", () => {
    const matrix = buildCoverageMatrix(SNAPSHOT, mixedProviders());
    const summary = languageSummary(matrix, "go");
    expect(summary?.providers).toEqual([IMPORT_ID, PATH_ID]);
    expect(summary?.edgeTypes).toEqual([
      "IMPORTS",
      "IMPORTED_BY",
      "TESTED_BY",
      "CONFIGURES",
      "GENERATED_FROM",
    ]);
    expect(summary?.bestEvidenceClass).toBe("structural");
    const symbolCell = matrix.cells.find(
      (cell) => cell.language === "go" && cell.provider === SYMBOL_ID,
    );
    expect(symbolCell?.status).toBe("unsupported");
    expect(symbolCell?.edgeTypes).toEqual([]);
    expect(symbolCell?.reason).toContain("no edge type for this language");
  });
});

// ---------------------------------------------------------------------------
// 3. Coverage honesty
// ---------------------------------------------------------------------------

describe("coverage honesty", () => {
  it("an advisory-only language is UNKNOWN and closes nothing", () => {
    const matrix = buildCoverageMatrix(SNAPSHOT, mixedProviders());
    for (const language of ["markdown", "json"]) {
      const summary = languageSummary(matrix, language);
      expect(summary?.providers, language).toEqual([PATH_ID]);
      expect(summary?.closureProviders, language).toEqual([]);
      expect(summary?.coverage, language).toBe("unknown");
      expect(summary?.bestEvidenceClass, language).toBe("heuristic");
      expect(summary?.closureEligible, language).toBe(false);
    }
  });

  it("a path provider that never saw the language reports unknown, not complete", () => {
    const matrix = buildCoverageMatrix(SNAPSHOT, mixedProviders());
    const cell = matrix.cells.find(
      (candidate) => candidate.language === "markdown" && candidate.provider === PATH_ID,
    );
    expect(cell?.status).toBe("unknown");
    expect(cell?.reason).toContain("absent from the provider's processed set");
  });

  it("a language with real, complete semantic coverage is closure-eligible", () => {
    const matrix = buildCoverageMatrix(SNAPSHOT, mixedProviders());
    expect(languageSummary(matrix, "typescript")?.coverage).toBe("complete");
    expect(languageSummary(matrix, "typescript")?.closureEligible).toBe(true);
    expect(languageSummary(matrix, "python")?.closureEligible).toBe(true);
    expect(matrix.totals.languagesClosureEligible).toBe(3); // ts, python, go
  });

  it("the advisory provider never drags a closure-capable language down", () => {
    const summary = languageSummary(buildCoverageMatrix(SNAPSHOT, mixedProviders()), "typescript");
    // The path provider is `partial` by nature and IS listed as covering...
    expect(summary?.providers).toContain(PATH_ID);
    // ...but is excluded from the coverage computation, exactly as
    // `aggregateProviderCoverage` excludes it.
    expect(summary?.closureProviders).not.toContain(PATH_ID);
    expect(summary?.coverage).toBe("complete");
  });

  it("a partial closure-capable provider DOES degrade the language", () => {
    const providers: ProviderSet = {
      references: fixtureReferenceProvider({
        definitions: {},
        references: {},
        languages: ["typescript"],
        coverage: {
          status: "partial",
          languages: ["typescript"],
          reason: "3 files failed to parse",
        },
      }),
    };
    const summary = languageSummary(buildCoverageMatrix(SNAPSHOT, providers), "typescript");
    expect(summary?.coverage).toBe("partial");
    expect(summary?.closureEligible).toBe(false);
  });

  it("a language no provider touches at all is reported as uncovered", () => {
    const matrix = buildCoverageMatrix(SNAPSHOT, {
      references: fixtureReferenceProvider({
        definitions: {},
        references: {},
        languages: ["typescript"],
      }),
    });
    for (const language of ["go", "json", "markdown", "python"]) {
      const summary = languageSummary(matrix, language);
      expect(summary?.providers, language).toEqual([]);
      expect(summary?.coverage, language).toBe("unknown");
      expect(summary?.bestEvidenceClass, language).toBe("none");
      expect(summary?.closureEligible, language).toBe(false);
      expect(summary?.missingEdgeTypes, language).toEqual([...GRAPH_EDGE_TYPES]);
    }
    expect(matrix.totals.languagesWithNoCoverage).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// 4. Degenerate inputs
// ---------------------------------------------------------------------------

describe("degenerate inputs", () => {
  it("an empty snapshot produces an empty, well-formed matrix", () => {
    const matrix = buildCoverageMatrix({ label: "empty", files: [] }, mixedProviders());
    expect(matrix.languages).toEqual([]);
    expect(matrix.cells).toEqual([]);
    expect(matrix.summary).toEqual([]);
    expect(matrix.totals.files).toBe(0);
    expect(matrix.totals.providers).toBe(4);
  });

  it("no providers means nothing is covered and nothing can close", () => {
    const matrix = buildCoverageMatrix(SNAPSHOT, {});
    expect(matrix.cells).toEqual([]);
    expect(matrix.totals.languagesWithNoCoverage).toBe(5);
    expect(matrix.totals.languagesClosureEligible).toBe(0);
    for (const summary of matrix.summary) expect(summary.coverage).toBe("unknown");
  });

  it("honours a narrowed expected edge-type set", () => {
    const matrix = buildCoverageMatrix(SNAPSHOT, mixedProviders(), {
      expectedEdgeTypes: ["REFERENCES", "IMPORTS"],
    });
    expect(languageSummary(matrix, "typescript")?.missingEdgeTypes).toEqual([]);
    expect(languageSummary(matrix, "markdown")?.missingEdgeTypes).toEqual([
      "IMPORTS",
      "REFERENCES",
    ]);
  });
});
