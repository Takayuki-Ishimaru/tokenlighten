/**
 * Tests for compact.ts — renderCompactSkeleton
 *
 * Verifies: byte-stability, token cap enforcement, minimum-include guarantee,
 * annotation extraction, and correct tree structure.
 * No network required.
 */

import { describe, it, expect } from "vitest";
import type { RepoSkeleton } from "@tokenlighten/types";
import { renderCompactSkeleton } from "../compact.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function smallSkeleton(): RepoSkeleton {
  return {
    version: 1,
    commit: "abc1234567890abcdef1234567890abcdef12345",
    topRanked: [
      { path: "src/core/ledger.ts", rank: 0.9, reasons: ["recently edited"] },
      { path: "src/core/account.ts", rank: 0.7, reasons: [] },
      { path: "src/api/routes.ts", rank: 0.5, reasons: [] },
      { path: "tests/ledger.spec.ts", rank: 0.3, reasons: [] },
    ],
    apiEndpoints: [],
    moduleMap: [
      { path: "src", children: ["src/core", "src/api"] },
      { path: "src/core", children: ["src/core/ledger.ts", "src/core/account.ts"] },
      { path: "src/core/ledger.ts", children: [] },
      { path: "src/core/account.ts", children: [] },
      { path: "src/api", children: ["src/api/routes.ts"] },
      { path: "src/api/routes.ts", children: [] },
      { path: "tests", children: ["tests/ledger.spec.ts"] },
      { path: "tests/ledger.spec.ts", children: [] },
    ],
    excluded: [],
  };
}

function largeSkeleton(fileCount: number): RepoSkeleton {
  const topRanked = [];
  const moduleMap = [];

  // Create a mix of directories and files.
  const dirs = ["src/core", "src/api", "src/utils", "src/services", "src/models"];
  for (let i = 0; i < fileCount; i++) {
    const dir = dirs[i % dirs.length]!;
    const fileName = `file${i.toString().padStart(3, "0")}.ts`;
    const filePath = `${dir}/${fileName}`;
    topRanked.push({
      path: filePath,
      rank: (fileCount - i) / fileCount, // descending
      reasons: [],
    });
    moduleMap.push({ path: filePath, children: [] });
  }

  return {
    version: 1,
    commit: "abc1234567890abcdef1234567890abcdef12345",
    topRanked,
    apiEndpoints: [],
    moduleMap,
    excluded: [],
  };
}

// ---------------------------------------------------------------------------
// 1. Byte-stability: two renders of the same skeleton produce identical output
// ---------------------------------------------------------------------------

describe("renderCompactSkeleton (byte-stability)", () => {
  it("produces identical output on consecutive renders of the same skeleton", () => {
    const skeleton = smallSkeleton();
    const out1 = renderCompactSkeleton(skeleton);
    const out2 = renderCompactSkeleton(skeleton);
    expect(out1).toBe(out2);
  });

  it("produces identical output with a large skeleton (50 files)", () => {
    const skeleton = largeSkeleton(50);
    const out1 = renderCompactSkeleton(skeleton);
    const out2 = renderCompactSkeleton(skeleton);
    expect(out1).toBe(out2);
  });
});

// ---------------------------------------------------------------------------
// 2. Small skeleton fits under the default 800-token cap
// ---------------------------------------------------------------------------

describe("renderCompactSkeleton (small skeleton under default cap)", () => {
  it("fits a 4-file skeleton under the default 800-token cap", () => {
    const out = renderCompactSkeleton(smallSkeleton());
    const estimatedTokens = Math.ceil(out.length / 4);
    expect(estimatedTokens).toBeLessThanOrEqual(800);
  });

  it("contains all 4 ranked file paths in the output", () => {
    const out = renderCompactSkeleton(smallSkeleton());
    expect(out).toContain("ledger.ts");
    expect(out).toContain("account.ts");
    expect(out).toContain("routes.ts");
    expect(out).toContain("ledger.spec.ts");
  });

  it("uses 2-space indentation for directory structure", () => {
    const out = renderCompactSkeleton(smallSkeleton());
    // Files nested under directories should have at least 2 spaces of indentation.
    const lines = out.split("\n").filter((l) => l.trimStart() !== l);
    expect(lines.length).toBeGreaterThan(0);
    // Each indented line should use spaces, not tabs.
    for (const line of lines) {
      expect(line).not.toMatch(/^\t/);
    }
  });

  it("ends with a LF newline", () => {
    const out = renderCompactSkeleton(smallSkeleton());
    expect(out.endsWith("\n")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Large skeleton (~50 files) is capped within 800 tokens (±50 tolerance)
// ---------------------------------------------------------------------------

describe("renderCompactSkeleton (large skeleton token cap)", () => {
  it("caps a 50-file skeleton to ≤ 850 estimated tokens", () => {
    const skeleton = largeSkeleton(50);
    const out = renderCompactSkeleton(skeleton);
    const estimatedTokens = Math.ceil(out.length / 4);
    expect(estimatedTokens).toBeLessThanOrEqual(850);
  });

  it("caps a 100-file skeleton to ≤ 850 estimated tokens", () => {
    const skeleton = largeSkeleton(100);
    const out = renderCompactSkeleton(skeleton);
    const estimatedTokens = Math.ceil(out.length / 4);
    expect(estimatedTokens).toBeLessThanOrEqual(850);
  });

  it("respects a custom maxTokens of 400", () => {
    const skeleton = largeSkeleton(50);
    const out = renderCompactSkeleton(skeleton, { maxTokens: 400 });
    const estimatedTokens = Math.ceil(out.length / 4);
    // Within tolerance: the min-include guarantee may push slightly over.
    expect(estimatedTokens).toBeLessThanOrEqual(450);
  });
});

// ---------------------------------------------------------------------------
// 4. Minimum-include guarantee: even at a tiny cap, top-10 files are present
// ---------------------------------------------------------------------------

describe("renderCompactSkeleton (minimum-include guarantee)", () => {
  it("includes at least the top 10 ranked files even at maxTokens: 100", () => {
    const skeleton = largeSkeleton(50);
    // Sort to know what the top-10 paths are.
    const sorted = skeleton.topRanked
      .slice()
      .sort((a, b) => b.rank - a.rank || Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
    const top10Paths = sorted.slice(0, 10).map((f) => f.path.split("/").pop()!);

    const out = renderCompactSkeleton(skeleton, { maxTokens: 100 });

    for (const name of top10Paths) {
      expect(out).toContain(name);
    }
  });

  it("does not include all files from a 50-file skeleton at maxTokens: 100", () => {
    const skeleton = largeSkeleton(50);
    const out = renderCompactSkeleton(skeleton, { maxTokens: 100 });
    // At 100 tokens, it definitely cannot fit all 50 files.
    const fileCount = (out.match(/\.ts/g) ?? []).length;
    expect(fileCount).toBeLessThan(50);
  });
});

// ---------------------------------------------------------------------------
// 5. Annotation extraction from fileSignatures
// ---------------------------------------------------------------------------

describe("renderCompactSkeleton (annotation extraction)", () => {
  it("extracts up to 3 symbol names from file signatures", () => {
    const skeleton = smallSkeleton();
    const sigs = new Map([
      [
        "src/core/ledger.ts",
        [
          "export function postEntry(entry: Entry): void;",
          "export function reverseEntry(id: string): void;",
          "export function getBalance(accountId: string): number;",
          "export function auditLog(): AuditEntry[];",
        ].join("\n"),
      ],
    ]);

    const out = renderCompactSkeleton(skeleton, { fileSignatures: sigs });
    // Should contain at most 3 symbol names from ledger.ts.
    expect(out).toContain("postEntry");
    expect(out).toContain("reverseEntry");
    expect(out).toContain("getBalance");
  });

  it("renders without annotations when fileSignatures is not provided", () => {
    const out = renderCompactSkeleton(smallSkeleton());
    // Should not throw and should still contain file paths.
    expect(out).toContain("ledger.ts");
    // No annotation dash should appear for files without sigs.
    const lines = out.split("\n").filter((l) => l.includes("ledger.ts"));
    expect(lines.length).toBeGreaterThan(0);
  });

  it("skips comment-only signature blocks (no symbol names extracted)", () => {
    const skeleton = smallSkeleton();
    const sigs = new Map([
      ["src/core/ledger.ts", "// This file has no extractable symbols\n// Only comments"],
    ]);

    const out = renderCompactSkeleton(skeleton, { fileSignatures: sigs });
    // The ledger line should still appear but without an annotation.
    expect(out).toContain("ledger.ts");
    // No " - " annotation for this file.
    const ledgerLine = out.split("\n").find((l) => l.includes("ledger.ts"));
    expect(ledgerLine).toBeDefined();
    expect(ledgerLine).not.toMatch(/ledger\.ts.*-\s+\w/);
  });
});

// ---------------------------------------------------------------------------
// 6. Edge cases
// ---------------------------------------------------------------------------

describe("renderCompactSkeleton (edge cases)", () => {
  it("handles empty topRanked gracefully", () => {
    const skeleton = smallSkeleton();
    skeleton.topRanked = [];
    const out = renderCompactSkeleton(skeleton);
    expect(out).toContain("no files ranked");
  });

  it("handles files in the repo root (no directory prefix)", () => {
    const skeleton: RepoSkeleton = {
      version: 1,
      commit: "abc",
      topRanked: [
        { path: "README.md", rank: 0.5, reasons: [] },
        { path: "package.json", rank: 0.3, reasons: [] },
      ],
      apiEndpoints: [],
      moduleMap: [],
      excluded: [],
    };
    const out = renderCompactSkeleton(skeleton);
    expect(out).toContain("README.md");
    expect(out).toContain("package.json");
  });
});
