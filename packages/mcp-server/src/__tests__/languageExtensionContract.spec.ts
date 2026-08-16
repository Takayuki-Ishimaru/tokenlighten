// Contract-drift conformance for MCP_LANG_EXTS (packages/types/src/mcp.ts)
// against mcp-server's own extension -> language resolution
// (util/languages.ts). Companion to skeleton-engine's
// src/__tests__/graph.spec.ts "MCP_LANG_EXTS contract drift" block, which
// runs the same assertions against skeleton-engine's enumeration language
// map — kept as two per-package specs (not one cross-package spec importing
// @tokenlighten/skeleton-engine) so each runs against its OWN package's
// fresh source, not a possibly-stale built dist of the other package.
//
// Every extension the contract lists for ANY McpLang must resolve to a real
// (non-"default"/non-undefined) language here, so a future MCP_LANG_EXTS
// addition that forgets to update EXT_TO_LANGUAGE fails this spec loudly
// instead of silently degrading callers to weak default-language handling
// (weak symbol/string/comment handling — see closure comment-stripping and
// collectSymbols, both keyed off this resolution).
//
// `.h` is contract-dual-listed under both "c" and "cpp" (packages/types/src/
// mcp.ts) and is handled as a documented exception: pure-extension
// resolution (no content in hand) may answer either, since the static
// EXT_TO_LANGUAGE table has to pick one. Callers holding file text should use
// languageForPathWithContent instead, which sniffs `.h` content for C++
// signals — covered by the second describe block below.

import { describe, it, expect } from "vitest";
import { MCP_LANG_EXTS } from "@tokenlighten/types";
import type { McpLang } from "@tokenlighten/types";
import { languageForPath, languageForPathWithContent } from "../util/languages.js";
// Cross-package parity import — see the "Cross-package parity" describe
// block at the bottom of this file for why this is a deliberate, narrow
// exception to the fresh-source discipline documented above.
import { languageForPathWithContent as skeletonEngineLanguageForPathWithContent } from "@tokenlighten/skeleton-engine";

describe("MCP_LANG_EXTS contract drift — mcp-server languages.ts", () => {
  const langs = Object.keys(MCP_LANG_EXTS) as McpLang[];

  for (const lang of langs) {
    for (const ext of MCP_LANG_EXTS[lang]) {
      it(`${lang} ext ${ext} resolves to a real language (not default/undefined)`, () => {
        const resolved = languageForPath(`example${ext}`) ?? "default";
        if (ext === ".h") {
          // Dual-listed under both c and cpp — pure-extension resolution
          // (no content in hand) is allowed to answer either.
          expect(["c", "cpp"]).toContain(resolved);
        } else {
          expect(resolved).not.toBe("default");
        }
      });
    }
  }

  it("covers every McpLang from the contract (no silently-skipped language)", () => {
    expect(langs.length).toBe(Object.keys(MCP_LANG_EXTS).length);
    expect(langs.length).toBeGreaterThan(0);
  });
});

describe(".h content sniff — languageForPathWithContent", () => {
  it("plain C header (no C++ signal) stays c", () => {
    const text = "#ifndef FOO_H\n#define FOO_H\nint add(int a, int b);\n#endif\n";
    expect(languageForPathWithContent("foo.h", text)).toBe("c");
  });

  it("header with `class ` resolves to cpp", () => {
    const text = "#pragma once\nclass Widget {\npublic:\n  void render();\n};\n";
    expect(languageForPathWithContent("widget.h", text)).toBe("cpp");
  });

  it("header with `template<` resolves to cpp", () => {
    const text = "template<typename T>\nT max(T a, T b) { return a > b ? a : b; }\n";
    expect(languageForPathWithContent("util.h", text)).toBe("cpp");
  });

  it("header with `namespace ` resolves to cpp", () => {
    const text = "namespace acmectl {\nvoid init();\n}\n";
    expect(languageForPathWithContent("acmectl.h", text)).toBe("cpp");
  });

  it("header with `::` scope resolution resolves to cpp", () => {
    const text = "void Foo::bar() {}\n";
    expect(languageForPathWithContent("foo.h", text)).toBe("cpp");
  });

  it(".c files are never sniffed — always c even with C++-shaped content", () => {
    // Pathological input (a .c file is not contract-dual-listed), but proves
    // the sniff is scoped to .h and does not leak onto .c.
    const text = "class Widget {};\n";
    expect(languageForPathWithContent("widget.c", text)).toBe("c");
  });

  it(".hxx is unambiguous cpp regardless of content (sniff short-circuits)", () => {
    const text = "int add(int a, int b);\n"; // no cpp signal, but ext alone already resolves cpp
    expect(languageForPathWithContent("legacy.hxx", text)).toBe("cpp");
  });

  it("non-code extension is unaffected by content", () => {
    expect(languageForPathWithContent("README.md", "class Foo {}")).toBe("markdown");
  });

  it("matches languageForPath for every contract extension except .h", () => {
    const text = "class Foo {}"; // deliberately cpp-shaped, must not matter off-.h
    for (const lang of Object.keys(MCP_LANG_EXTS) as McpLang[]) {
      for (const ext of MCP_LANG_EXTS[lang]) {
        if (ext === ".h") continue;
        const p = `example${ext}`;
        expect(languageForPathWithContent(p, text)).toBe(languageForPath(p));
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Cross-package parity — mcp-server vs skeleton-engine .h sniff
// ---------------------------------------------------------------------------
//
// Deliberate, narrow exception to the "two per-package specs, no cross-
// package import" discipline documented at the top of this file: the two
// packages hand-mirror the SAME CPP_SNIFF_RE/SNIFF_WINDOW_CHARS logic (see
// skeleton-engine/src/graph.ts's languageForPathWithContent doc comment for
// why it is a hand-mirrored copy, not a shared import — skeleton-engine
// must not import mcp-server, per AGENTS.md's package table). A parity
// check that the two mirrors have not drifted necessarily has to import
// BOTH packages' own copies.
//
// mcp-server's own helper is imported fresh at the top of this file
// (../util/languages.js — a relative in-package import, always live TS
// source, transpiled by vitest, never stale). skeleton-engine's helper is
// imported via its package name (@tokenlighten/skeleton-engine), which
// resolves through package.json's "exports" to
// packages/skeleton-engine/dist/index.js — mcp-server's own tsconfig.json
// "paths" override only special-cases @tokenlighten/types (still to a
// dist .d.ts), not @tokenlighten/skeleton-engine, and no tsconfig-paths
// plugin is wired into this package's vitest config, so a dist import is
// the ONLY way to reach another package's code from here (a relative reach
// into ../../../skeleton-engine/src instead would fail
// `tsc -p packages/mcp-server/tsconfig.json` with TS6059, since that
// tsconfig's rootDir is "src").
//
// CONSEQUENCE: if skeleton-engine/src/graph.ts's languageForPathWithContent
// changes, `cd packages/skeleton-engine && npm run build` (or `npm run
// build` at the repo root) MUST run before this block reflects the change —
// otherwise it silently compares against the PREVIOUS dist, not the edit.
describe(".h content sniff parity — mcp-server vs skeleton-engine", () => {
  const fixtures: Array<{ name: string; path: string; text: string; expected: string }> = [
    {
      name: "C++-shaped .h (class) -> cpp",
      path: "widget.h",
      text: "#pragma once\nclass Widget { public: void draw(); };\n",
      expected: "cpp",
    },
    {
      name: "plain C .h (struct/typedef + function decl, no C++ signal) -> c",
      path: "point.h",
      text: "#ifndef POINT_H\n#define POINT_H\n\ntypedef struct Point {\n  int x;\n  int y;\n} Point;\n\nint point_distance(Point a, Point b);\n\n#endif\n",
      expected: "c",
    },
  ];

  for (const f of fixtures) {
    it(`both packages agree: ${f.name}`, () => {
      const mcpServerResult = languageForPathWithContent(f.path, f.text);
      const skeletonEngineResult = skeletonEngineLanguageForPathWithContent(f.path, f.text);
      expect(mcpServerResult).toBe(f.expected);
      expect(skeletonEngineResult).toBe(f.expected);
      expect(skeletonEngineResult).toBe(mcpServerResult);
    });
  }
});
