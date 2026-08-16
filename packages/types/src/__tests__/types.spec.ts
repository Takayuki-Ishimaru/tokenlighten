/**
 * Sanity tests for @tokenlighten/types.
 *
 * These tests verify that all exported types are re-exported from index.ts
 * and that a handful of runtime values round-trip through structural type
 * checks. No external runtime dependencies are needed — the types package
 * is pure TypeScript declarations.
 */

import { describe, it, expect } from "vitest";
import { MCP_LANGS, MCP_LANG_EXTS } from "../index.js";
import {
  MCP_LANGS as MCP_LANGS_FROM_MODULES,
  MCP_LANG_EXTS as MCP_LANG_EXTS_FROM_MODULES,
} from "../mcp/index.js";

// ---------------------------------------------------------------------------
// Type-level imports (used only for assignability checks below)
// ---------------------------------------------------------------------------
import type {
  McpToolResult,
  RankedFile,
  ApiEndpoint,
  ModuleNode,
  RepoSkeleton,
  SentinelBlock,
  StubTargetId,
  StubTarget,
  GenerateResult,
  TLConfig,
} from "../index.js";

// ---------------------------------------------------------------------------
// Helper: assert a value satisfies a type without emitting to dist
// ---------------------------------------------------------------------------
function satisfies<T>(value: T): T {
  return value;
}

// ---------------------------------------------------------------------------
// mcp.ts
// ---------------------------------------------------------------------------

describe("MCP language runtime contract", () => {
  it("preserves language and extension declaration order through the barrels", () => {
    expect(MCP_LANGS).toEqual([
      "ts",
      "js",
      "py",
      "go",
      "java",
      "rs",
      "c",
      "cpp",
      "kt",
      "cs",
      "php",
      "rb",
    ]);
    expect(Object.keys(MCP_LANG_EXTS)).toEqual(MCP_LANGS);
    expect(MCP_LANGS_FROM_MODULES).toBe(MCP_LANGS);
    expect(MCP_LANG_EXTS_FROM_MODULES).toBe(MCP_LANG_EXTS);
  });
});

// D8: the `GetFileSkeletonInput` / `GetFileSkeletonOutput` /
// `GetSymbolWithContextInput` / `GetSymbolWithContextOutput` /
// `ExtractOfficeTextInput` / `ExtractOfficeTextOutput` assignability suites
// that stood here are DELETED with `mcp/legacy-read.ts`. Two of the six moved
// into the mcp-server modules that emit them (the request shapes of
// `read_file mode=skeleton` / `mode=symbol` / the office paths, plus their
// payload shapes, now declared next to their single emitter); none of the six
// is a shared contract any more, so none belongs in this package's suite.

describe("McpToolResult", () => {
  it("ok=true carries data", () => {
    const ok = satisfies<McpToolResult<{ signatures: string; language: string; truncated: boolean }>>({
      ok: true,
      data: {
        signatures: "export class Foo {}",
        language: "typescript",
        truncated: false,
      },
    });
    if (ok.ok) {
      expect(ok.data.language).toBe("typescript");
    }
  });

  it("ok=false carries error and code", () => {
    const err = satisfies<McpToolResult<{ signatures: string; language: string; truncated: boolean }>>({
      ok: false,
      error: "File not found: src/missing.ts",
      code: "not-found",
    });
    if (!err.ok) {
      expect(err.code).toBe("not-found");
    }
  });
});

// ---------------------------------------------------------------------------
// skeleton.ts
// ---------------------------------------------------------------------------

describe("RankedFile", () => {
  it("round-trips a ranked file entry", () => {
    const v = satisfies<RankedFile>({
      path: "src/proxy/hooks.ts",
      rank: 0.082,
      reasons: ["recently edited", "high in-degree"],
    });
    expect(v.rank).toBeCloseTo(0.082);
    expect(v.reasons).toHaveLength(2);
  });
});

describe("ApiEndpoint", () => {
  it("round-trips an endpoint entry", () => {
    const v = satisfies<ApiEndpoint>({
      method: "POST",
      path: "/tl/kill",
      handlerFile: "src/proxy/admin.ts",
      handlerSymbol: "KillSwitchHandler.disableGlobal",
    });
    expect(v.method).toBe("POST");
  });
});

describe("ModuleNode", () => {
  it("round-trips a leaf node (no children)", () => {
    const v = satisfies<ModuleNode>({ path: "src/proxy/hooks.ts", children: [] });
    expect(v.children).toEqual([]);
  });

  it("round-trips a directory node with children", () => {
    const v = satisfies<ModuleNode>({
      path: "src/proxy",
      children: ["src/proxy/hooks.ts", "src/proxy/dedup.ts"],
    });
    expect(v.children).toHaveLength(2);
  });
});

describe("RepoSkeleton", () => {
  it("round-trips a minimal skeleton", () => {
    const v = satisfies<RepoSkeleton>({
      version: 1,
      commit: "abc1234",
      topRanked: [],
      apiEndpoints: [],
      moduleMap: [],
      excluded: ["vendor/**"],
    });
    expect(v.version).toBe(1);
    expect(v.excluded).toContain("vendor/**");
  });
});

// ---------------------------------------------------------------------------
// agents.ts
// ---------------------------------------------------------------------------

describe("SentinelBlock", () => {
  it("round-trips a sentinel block", () => {
    const v = satisfies<SentinelBlock>({
      start: 0,
      end: 120,
      version: "2026-06-25-cheap",
      sha256: "a".repeat(64),
      body: "<!-- tokenlighten:mcp-instructions:start -->\n<!-- tokenlighten:mcp-instructions:end -->",
    });
    expect(v.version).toBe("2026-06-25-cheap");
    expect(v.sha256).toHaveLength(64);
  });
});

describe("StubTargetId", () => {
  it("accepts all valid ids", () => {
    const ids: StubTargetId[] = ["claude", "copilot", "cursor", "cline", "continue"];
    expect(ids).toHaveLength(5);
  });
});

describe("StubTarget", () => {
  it("round-trips a claude stub target", () => {
    const v = satisfies<StubTarget>({
      id: "claude",
      file: "CLAUDE.md",
      injectionMode: "managed-block",
    });
    expect(v.id).toBe("claude");
    expect(v.injectionMode).toBe("managed-block");
  });

  it("round-trips a copilot stub target", () => {
    const v = satisfies<StubTarget>({
      id: "copilot",
      file: ".github/copilot-instructions.md",
      injectionMode: "managed-block",
    });
    expect(v.file).toBe(".github/copilot-instructions.md");
  });
});

describe("GenerateResult", () => {
  it("round-trips an all-success result", () => {
    const v = satisfies<GenerateResult>({
      wrote: ["AGENTS.md", "CLAUDE.md"],
      skipped: [],
      drifted: [],
    });
    expect(v.wrote).toHaveLength(2);
  });

  it("round-trips a mixed result", () => {
    const v = satisfies<GenerateResult>({
      wrote: ["AGENTS.md"],
      skipped: [{ path: ".clinerules", reason: "symlink-refused" }],
      drifted: [
        {
          path: ".github/copilot-instructions.md",
          expected: "a".repeat(64),
          actual: "b".repeat(64),
        },
      ],
    });
    expect(v.skipped[0].reason).toBe("symlink-refused");
    expect(v.drifted[0].path).toBe(".github/copilot-instructions.md");
  });
});

// ---------------------------------------------------------------------------
// config.ts
// ---------------------------------------------------------------------------

describe("TLConfig", () => {
  it("accepts an empty config", () => {
    const v = satisfies<TLConfig>({});
    expect(v).toEqual({});
  });

  it("round-trips a full config", () => {
    const v = satisfies<TLConfig>({
      mcp: { workspaceRoot: "/home/user/myrepo" },
      skeleton: { sizeCapBytes: 65536, maxRanked: 40 },
      agentsMd: { driftPolicy: "fail-build" },
    });
    expect(v.mcp?.workspaceRoot).toBe("/home/user/myrepo");
    expect(v.skeleton?.maxRanked).toBe(40);
    expect(v.agentsMd?.driftPolicy).toBe("fail-build");
  });

  it("accepts diff-warn and silent-overwrite drift policies", () => {
    const w = satisfies<TLConfig>({ agentsMd: { driftPolicy: "diff-warn" } });
    const s = satisfies<TLConfig>({ agentsMd: { driftPolicy: "silent-overwrite" } });
    expect(w.agentsMd?.driftPolicy).toBe("diff-warn");
    expect(s.agentsMd?.driftPolicy).toBe("silent-overwrite");
  });
});
