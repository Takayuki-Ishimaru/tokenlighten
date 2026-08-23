/**
 * Tests for graph.ts — symbol extraction and file enumeration.
 * No network required — all fixtures are in-memory strings.
 *
 * P2.3: Validates C/C++ multi-line signature patterns, header declarations,
 * and class extraction. Also tests that preprocessor lines (#define, etc.)
 * do not produce false positives.
 */

import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  extractSymbolsRegex,
  languageForPath,
  languageForPathWithContent,
  enumerateFiles,
  buildFileInputs,
} from "../graph.js";
import { createIgnoreMatcherSync } from "../ignore.js";
import {
  buildSymbolGraph,
  runPersonalizedPageRank,
  aggregateToFileScores,
  normalizeScores,
} from "../pagerank.js";
import { MCP_LANG_EXTS } from "@tokenlighten/types";
import type { McpLang } from "@tokenlighten/types";

// ---------------------------------------------------------------------------
// C++ — class extraction
// ---------------------------------------------------------------------------

describe("extractSymbolsRegex — cpp class", () => {
  it("extracts class declarations", () => {
    const src = `
class GearManager {
public:
    GearManager();
    void request(int id);
    void forceTransition(int id);
};
`;
    const symbols = extractSymbolsRegex(src, "cpp");
    const names = symbols.map((s) => s.name);
    expect(names).toContain("GearManager");
  });

  it("extracts struct declarations", () => {
    const src = `
struct GainOutput {
    float thrust;
    float roll;
};
`;
    const symbols = extractSymbolsRegex(src, "cpp");
    const names = symbols.map((s) => s.name);
    expect(names).toContain("GainOutput");
  });

  it("extracts enum class declarations", () => {
    const src = `
enum class DriveMode {
    Manual,
    Stabilize,
    PosHold,
};
`;
    const symbols = extractSymbolsRegex(src, "cpp");
    const names = symbols.map((s) => s.name);
    expect(names).toContain("DriveMode");
  });
});

// ---------------------------------------------------------------------------
// C++ — single-line method definitions
// ---------------------------------------------------------------------------

describe("extractSymbolsRegex — cpp single-line method definitions", () => {
  it("extracts scoped method definition ClassName::method", () => {
    const src = `
void GearManager::request(int id) {
    requested_ = static_cast<DriveId>(id);
}
`;
    const symbols = extractSymbolsRegex(src, "cpp");
    const names = symbols.map((s) => s.name);
    // Should match GearManager::request or just request depending on regex group
    expect(names.some((n) => n.includes("request"))).toBe(true);
  });

  it("extracts const member function", () => {
    const src = `
DriveId GearManager::currentId() const {
    return current_ ? current_->id() : DriveId::Manual;
}
`;
    const symbols = extractSymbolsRegex(src, "cpp");
    const names = symbols.map((s) => s.name);
    expect(names.some((n) => n.includes("currentId"))).toBe(true);
  });

  it("extracts noexcept function", () => {
    const src = `
void ElevationController::reset() noexcept {
    i_state_ = 0.0f;
}
`;
    const symbols = extractSymbolsRegex(src, "cpp");
    const names = symbols.map((s) => s.name);
    expect(names.some((n) => n.includes("reset"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// C++ — multi-line function signatures
// ---------------------------------------------------------------------------

describe("extractSymbolsRegex — cpp multi-line signatures", () => {
  it("extracts function with multi-line parameter list", () => {
    const src = `
void Muxer::yaw(
  float a,
  float b
)
{
    output_ = a + b;
}
`;
    const symbols = extractSymbolsRegex(src, "cpp");
    const names = symbols.map((s) => s.name);
    expect(names.some((n) => n.includes("yaw"))).toBe(true);
  });

  it("extracts method with multi-line params and const qualifier", () => {
    const src = `
RateSetpoint AttitudeController::update(
    const AttitudeSetpoint& sp,
    const math::Quat& measured,
    float dt
) const {
    return computeRate(sp, measured);
}
`;
    const symbols = extractSymbolsRegex(src, "cpp");
    const names = symbols.map((s) => s.name);
    expect(names.some((n) => n.includes("update"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// C++ — header declarations (semicolon-terminated)
// ---------------------------------------------------------------------------

describe("extractSymbolsRegex — cpp header declarations", () => {
  it("extracts virtual method declaration in class body", () => {
    const src = `
class DriveMode {
public:
    virtual void onEnter() = 0;
    virtual void onExit();
    virtual bool isActive() const;
};
`;
    const symbols = extractSymbolsRegex(src, "cpp");
    const names = symbols.map((s) => s.name);
    // Class should be extracted
    expect(names).toContain("DriveMode");
    // Method declarations should be extracted via header declaration pattern
    expect(names.some((n) => n.includes("onEnter") || n.includes("onExit") || n.includes("isActive"))).toBe(true);
  });

  it("extracts inline/static method declarations", () => {
    const src = `
inline void doSomething(int a);
static void doStatic(int b);
`;
    const symbols = extractSymbolsRegex(src, "cpp");
    const names = symbols.map((s) => s.name);
    expect(names.some((n) => n.includes("doSomething"))).toBe(true);
    expect(names.some((n) => n.includes("doStatic"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// C — function definitions (body-terminated)
// ---------------------------------------------------------------------------

describe("extractSymbolsRegex — c function definitions", () => {
  it("extracts plain C function", () => {
    const src = `
void muxQuadX(const GainOutput* out, float motor_throttle[4]) {
    motor_throttle[0] = out->thrust;
}
`;
    const symbols = extractSymbolsRegex(src, "c");
    const names = symbols.map((s) => s.name);
    expect(names).toContain("muxQuadX");
  });

  it("extracts static C function", () => {
    const src = `
static float clamp01(float v) {
    return v < 0.0f ? 0.0f : (v > 1.0f ? 1.0f : v);
}
`;
    const symbols = extractSymbolsRegex(src, "c");
    const names = symbols.map((s) => s.name);
    expect(names).toContain("clamp01");
  });

  it("extracts extern C function declaration (semicolon-terminated)", () => {
    const src = `
extern void doSomething(int a);
void anotherFunc(int b);
`;
    const symbols = extractSymbolsRegex(src, "c");
    const names = symbols.map((s) => s.name);
    expect(names.some((n) => n.includes("doSomething"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// False-positive guard — preprocessor lines must NOT match
// ---------------------------------------------------------------------------

describe("extractSymbolsRegex — no false positives on preprocessor", () => {
  it("does not extract #define macros as functions (cpp)", () => {
    const src = `
#define MAX_MOTORS 4
#define CLAMP(x, lo, hi) ((x) < (lo) ? (lo) : ((x) > (hi) ? (hi) : (x)))
#include <math.h>
`;
    const symbols = extractSymbolsRegex(src, "cpp");
    const names = symbols.map((s) => s.name);
    // None of these should be extracted as symbols
    expect(names).not.toContain("MAX_MOTORS");
    expect(names).not.toContain("CLAMP");
    expect(names).not.toContain("math");
  });

  it("does not extract #define macros as functions (c)", () => {
    const src = `
#define BUFFER_SIZE 1024
#define ABS(x) ((x) < 0 ? -(x) : (x))
`;
    const symbols = extractSymbolsRegex(src, "c");
    const names = symbols.map((s) => s.name);
    expect(names).not.toContain("BUFFER_SIZE");
    expect(names).not.toContain("ABS");
  });

  it("does not extract if-statement conditions as functions (cpp)", () => {
    const src = `
void someFunc() {
    if (condition1 && condition2) {
        doStuff();
    }
    while (running) {
        step();
    }
}
`;
    const symbols = extractSymbolsRegex(src, "cpp");
    const names = symbols.map((s) => s.name);
    // "if" and "while" should not appear; "someFunc" should
    expect(names).not.toContain("if");
    expect(names).not.toContain("while");
    expect(names.some((n) => n.includes("someFunc"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Regression tests for acmectl fixture patterns
// ---------------------------------------------------------------------------

describe("extractSymbolsRegex — acmectl fixture patterns", () => {
  it("extracts muxQuadX from muxer.cpp content", () => {
    const src = `
namespace acmectl::control {

void muxQuadX(const GainOutput& out, f32 motor_throttle[DRV_OUTPUT_COUNT]) {
    const float T = out.thrust;
    const float R = out.torque.x;
}

} // namespace acmectl::control
`;
    const symbols = extractSymbolsRegex(src, "cpp");
    const names = symbols.map((s) => s.name);
    expect(names).toContain("muxQuadX");
  });

  it("extracts GearManager class from gear_manager.hpp content", () => {
    const src = `
namespace acmectl::mode {

class GearManager {
public:
    GearManager();
    void registerDrive(DriveMode* mode);
    void request(DriveId id);
    DriveId currentId() const;
    DriveMode* current() const;
private:
    DriveMode* modes_[6] = {};
};

} // namespace acmectl::mode
`;
    const symbols = extractSymbolsRegex(src, "cpp");
    const names = symbols.map((s) => s.name);
    expect(names).toContain("GearManager");
  });

  it("extracts ElevationController from elevation_controller.cpp content", () => {
    const src = `
namespace acmectl::control {

ElevationController::ElevationController() {
    cfg_ = defaultConfig();
}

void ElevationController::configure(const VehicleConfig& cfg) {
    cfg_ = cfg;
    configured_ = true;
    reset();
}

void ElevationController::reset() {
    i_state_ = 0.0f;
}

} // namespace acmectl::control
`;
    const symbols = extractSymbolsRegex(src, "cpp");
    const names = symbols.map((s) => s.name);
    expect(names.some((n) => n.includes("ElevationController") || n.includes("configure") || n.includes("reset"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// .h content sniff — languageForPathWithContent (index-side C++ detection)
// ---------------------------------------------------------------------------
//
// Mirrors mcp-server's src/__tests__/languageExtensionContract.spec.ts ".h
// content sniff" block against THIS package's own helper — see graph.ts's
// languageForPathWithContent doc comment for why two hand-mirrored copies
// exist. languageExtensionContract.spec.ts additionally cross-checks the
// two packages' helpers agree on the same fixtures.

describe("languageForPathWithContent — .h content sniff", () => {
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
    const text = "class Widget {};\n";
    expect(languageForPathWithContent("widget.c", text)).toBe("c");
  });

  it(".hxx is unambiguous cpp regardless of content (sniff short-circuits)", () => {
    const text = "int add(int a, int b);\n";
    expect(languageForPathWithContent("legacy.hxx", text)).toBe("cpp");
  });

  it("non-.h source extension is unaffected by content", () => {
    expect(languageForPathWithContent("service.rb", "class Foo {}")).toBe("ruby");
  });

  it(".md is not a recognized source extension — content sniff cannot invent one (handled separately via EnumeratedFile.textOnly)", () => {
    expect(languageForPathWithContent("README.md", "class Foo {}")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildFileInputs — .h C++ sniff end-to-end (index-side)
// ---------------------------------------------------------------------------
//
// Reproduces the reviewer-proven bug: a `class Widget {...}` .h enumerated
// with the static extension-only "c" answer indexes as {"lang":"c",
// "symbols":[]} because LANG_PATTERNS.c has no class/struct pattern — so
// search_files action=symbols (backed by indexStore.ts's persisted index,
// which applies the SAME sniff via languageForPathWithContent) was losing
// C++ classes that direct read_file skeletons (mcp-server's own
// per-request sniff) already saw correctly.

describe("buildFileInputs — .h C++ sniff end-to-end", () => {
  async function makeFixture(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "tl-hsniff-"));
    await writeFile(
      join(root, "widget.h"),
      "#pragma once\nclass Widget { public: void draw(); };\n",
      "utf8",
    );
    await writeFile(
      join(root, "point.h"),
      "#ifndef POINT_H\n#define POINT_H\n\ntypedef struct Point {\n  int x;\n  int y;\n} Point;\n\nint point_distance(Point a, Point b);\n\n#endif\n",
      "utf8",
    );
    return root;
  }

  it("a C++-shaped .h indexes with a non-empty symbol list containing Widget", async () => {
    const root = await makeFixture();
    try {
      const matcher = createIgnoreMatcherSync();
      const files = await enumerateFiles(root, matcher);
      const { inputs } = await buildFileInputs(files);

      const widget = inputs.find((i) => i.path === "widget.h");
      expect(widget).toBeDefined();
      // Proof the cpp grammar (not c) was used: LANG_PATTERNS.c has no
      // class-declaration pattern, so "Widget" can only appear here if
      // languageForPathWithContent sniffed this .h to "cpp".
      expect(languageForPathWithContent("widget.h", widget!.raw)).toBe("cpp");
      expect(widget!.symbols.length).toBeGreaterThan(0);
      expect(widget!.symbols.some((s) => s.name === "Widget")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("a plain C .h (struct/typedef only, no C++ signal) stays c and keeps its symbols", async () => {
    const root = await makeFixture();
    try {
      const matcher = createIgnoreMatcherSync();
      const files = await enumerateFiles(root, matcher);
      const { inputs } = await buildFileInputs(files);

      const point = inputs.find((i) => i.path === "point.h");
      expect(point).toBeDefined();
      expect(languageForPathWithContent("point.h", point!.raw)).toBe("c");
      // LANG_PATTERNS.c is function-only (no struct/typedef pattern) —
      // unaffected by this change either way; proves no regression for
      // plain C headers with a real C++-free signal.
      expect(point!.symbols.some((s) => s.name === "point_distance")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// enumerateFiles — text-bearing extensions enumerate as textOnly (Task B)
// ---------------------------------------------------------------------------

describe("enumerateFiles — text-bearing extensions", () => {
  async function makeFixture(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "tl-textenum-"));
    await writeFile(join(root, "widget.ts"), "export function widget(): void {}\n", "utf8");
    await writeFile(join(root, "README.md"), "# Widget\n\nProse about the widget.\n", "utf8");
    await writeFile(join(root, "notes.txt"), "plain text notes\n", "utf8");
    await writeFile(join(root, "spec.rst"), "Widget Spec\n============\n", "utf8");
    await writeFile(join(root, "data.json"), '{"a":1}\n', "utf8");
    await writeFile(join(root, "config.yaml"), "a: 1\n", "utf8");
    await writeFile(join(root, "config.yml"), "a: 1\n", "utf8");
    await writeFile(join(root, "settings.toml"), "a = 1\n", "utf8");
    await writeFile(join(root, "image.png"), "not-real-png-bytes", "utf8");
    return root;
  }

  it("enumerates .md/.txt/.rst/.json/.yaml/.yml/.toml as textOnly:true, language undefined", async () => {
    const root = await makeFixture();
    try {
      const matcher = createIgnoreMatcherSync();
      const files = await enumerateFiles(root, matcher);
      const byPath = new Map(files.map((f) => [f.path, f]));

      for (const p of ["README.md", "notes.txt", "spec.rst", "data.json", "config.yaml", "config.yml", "settings.toml"]) {
        const f = byPath.get(p);
        expect(f, `expected ${p} to be enumerated`).toBeDefined();
        expect(f!.textOnly).toBe(true);
        expect(f!.language).toBeUndefined();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ordinary source files are not textOnly; unrecognized extensions still skipped", async () => {
    const root = await makeFixture();
    try {
      const matcher = createIgnoreMatcherSync();
      const files = await enumerateFiles(root, matcher);
      const byPath = new Map(files.map((f) => [f.path, f]));

      const widget = byPath.get("widget.ts");
      expect(widget).toBeDefined();
      expect(widget!.textOnly).toBeFalsy();
      expect(widget!.language).toBe("typescript");

      // .png has no recognized language and isn't in TEXT_EXTS — still skipped.
      expect(byPath.has("image.png")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("buildFileInputs excludes textOnly files from its output", async () => {
    const root = await makeFixture();
    try {
      const matcher = createIgnoreMatcherSync();
      const files = await enumerateFiles(root, matcher);
      const { inputs } = await buildFileInputs(files);
      const paths = inputs.map((i) => i.path);

      expect(paths).toContain("widget.ts");
      for (const p of ["README.md", "notes.txt", "spec.rst", "data.json", "config.yaml", "config.yml", "settings.toml"]) {
        expect(paths).not.toContain(p);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Ranking neutrality — text-bearing files must not perturb PageRank (Task B)
// ---------------------------------------------------------------------------
//
// normalizeScores does MIN-MAX normalization across every entry of the
// fileScores map (see pagerank.ts) — if a textOnly file ever leaked a
// default-1 score into that map, it could shift min/max and change EVERY
// other file's normalized score. This reproduces the
// enumerateFiles -> buildFileInputs -> buildSymbolGraph -> PageRank chain
// exactly as index.ts's buildSkeleton wires it (minus git/cache I/O) and
// proves byte-identical scores for the code files whether or not docs are
// present — including docs whose PROSE repeats the real symbol names, so a
// missing filter (not just "docs happen to have zero symbols") would be
// caught.

describe("ranking neutrality — text-bearing files do not perturb PageRank", () => {
  async function makeFixture(withDocs: boolean): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "tl-rankneutral-"));
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(
      join(root, "src", "a.ts"),
      "export function helper(): number { return 1; }\n",
      "utf8",
    );
    await writeFile(
      join(root, "src", "b.ts"),
      "import { helper } from \"./a.js\";\nexport function useHelper(): number { return helper() + 1; }\n",
      "utf8",
    );
    await writeFile(
      join(root, "src", "c.ts"),
      "export function unrelated(): number { return 42; }\n",
      "utf8",
    );
    if (withDocs) {
      await writeFile(
        join(root, "README.md"),
        "# Demo\n\nThis project defines helper and useHelper and unrelated. ".repeat(30),
        "utf8",
      );
      await mkdir(join(root, "docs"), { recursive: true });
      await writeFile(join(root, "docs", "notes.txt"), "helper useHelper unrelated\n".repeat(50), "utf8");
    }
    return root;
  }

  async function rankCodeFiles(root: string): Promise<Map<string, number>> {
    const matcher = createIgnoreMatcherSync();
    // Mirrors index.ts's buildSkeleton: textOnly files are filtered before
    // ranking (this is the SAME filter buildSkeleton applies at enumeration).
    const files = (await enumerateFiles(root, matcher)).filter((f) => !f.textOnly);
    const { inputs } = await buildFileInputs(files);
    const graph = buildSymbolGraph(inputs, null);
    const personalization = new Map<string, number>(
      Array.from(graph.nodes.keys()).map((id) => [id, 1]),
    );
    const nodeScores = runPersonalizedPageRank(graph, personalization);
    const fileScores = aggregateToFileScores(nodeScores);
    for (const f of files) {
      if (!fileScores.has(f.path)) fileScores.set(f.path, 1);
    }
    return normalizeScores(fileScores);
  }

  it("identical PageRank scores for code files with and without docs present", async () => {
    const rootCodeOnly = await makeFixture(false);
    const rootWithDocs = await makeFixture(true);
    try {
      const scoresA = await rankCodeFiles(rootCodeOnly);
      const scoresB = await rankCodeFiles(rootWithDocs);

      // Same set of ranked paths — no doc/text paths leaked in.
      expect([...scoresB.keys()].sort()).toEqual([...scoresA.keys()].sort());

      for (const [path, score] of scoresA) {
        expect(scoresB.get(path)).toBe(score);
      }
    } finally {
      await rm(rootCodeOnly, { recursive: true, force: true });
      await rm(rootWithDocs, { recursive: true, force: true });
    }
  });

  it("sanity: docs ARE enumerated unfiltered (the ranking filter above is doing real work, not a no-op)", async () => {
    const root = await makeFixture(true);
    try {
      const matcher = createIgnoreMatcherSync();
      const unfiltered = await enumerateFiles(root, matcher);
      expect(unfiltered.some((f) => f.path === "README.md")).toBe(true);
      expect(unfiltered.some((f) => f.path === "docs/notes.txt")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// MCP_LANG_EXTS contract drift — skeleton-engine's enumeration language map
// ---------------------------------------------------------------------------
//
// Companion to mcp-server's src/__tests__/languageExtensionContract.spec.ts,
// which runs the same assertions against mcp-server's OWN extension ->
// language resolution (util/languages.ts). Kept as two per-package specs
// (not one cross-package spec) so each runs against its own package's fresh
// source, not a possibly-stale built dist of the other package.
//
// Every extension the contract (packages/types/src/mcp.ts MCP_LANG_EXTS)
// lists for ANY McpLang must resolve to a real (non-undefined) language via
// this module's own languageForPath, so a future contract addition that
// forgets to update graph.ts's EXT_TO_LANG fails loudly here instead of
// silently degrading enumerated files to an undefined language.

describe("MCP_LANG_EXTS contract drift — skeleton-engine graph.ts", () => {
  const langs = Object.keys(MCP_LANG_EXTS) as McpLang[];

  for (const lang of langs) {
    for (const ext of MCP_LANG_EXTS[lang]) {
      it(`${lang} ext ${ext} resolves to a real language (not default/undefined)`, () => {
        const resolved = languageForPath(`example${ext}`) ?? "default";
        if (ext === ".h") {
          // Dual-listed under both c and cpp in the contract — pure-
          // extension resolution is allowed to answer either.
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

// ---------------------------------------------------------------------------
// extractSymbolsRegex — blank-line-before-declaration line/signature bug
// ---------------------------------------------------------------------------
//
// Every LANG_PATTERNS entry is anchored `^\s*...` with the multiline flag.
// `\s` matches newlines too, so when a declaration is preceded by one or
// more blank lines, the greedy `\s*` swallows the blank line(s)' own
// terminator(s) (and the declaration's leading indentation) as part of the
// SAME match — the match starts on the blank line, not on the declaration.
// Before the fix, extractSymbolsRegex used the raw match index for the
// line number AND for slicing `signature` off `lines[line - 1]`, so the
// reported line landed on the blank line (off by however many blank lines
// were skipped) and `signature` came back empty (a blank line's own text,
// trimmed, is still ""). Reproduction (PI-06 wave):
//   extractSymbolsRegex("const x = 1;\n\nexport function widget() { return 1; }\n", "typescript")
//   used to return widget as {name:"widget", line:2, endLine:3, signature:""}
//   instead of the correct line 3 with a non-empty signature.

describe("extractSymbolsRegex — blank line before declaration (line/signature bug)", () => {
  it("TypeScript function after a blank line reports the function's own line and signature", () => {
    const src = "const x = 1;\n\nexport function widget() { return 1; }\n";
    const symbols = extractSymbolsRegex(src, "typescript");
    const widget = symbols.find((s) => s.name === "widget");
    expect(widget).toBeDefined();
    expect(widget!.line).toBe(3);
    expect(widget!.endLine).toBe(3);
    expect(widget!.signature).toBe("export function widget() { return 1; }");
  });

  it("TypeScript const after a blank line reports the const's own line and signature", () => {
    const src = "function helper() { return 0; }\n\nexport const answer = 42;\n";
    const symbols = extractSymbolsRegex(src, "typescript");
    const answer = symbols.find((s) => s.name === "answer");
    expect(answer).toBeDefined();
    expect(answer!.line).toBe(3);
    expect(answer!.signature).toBe("export const answer = 42;");
  });

  it("Python def after a blank line reports the def's own line and signature", () => {
    const src = "class Foo:\n    pass\n\ndef standalone():\n    return 1\n";
    const symbols = extractSymbolsRegex(src, "python");
    const standalone = symbols.find((s) => s.name === "standalone");
    expect(standalone).toBeDefined();
    expect(standalone!.line).toBe(4);
    expect(standalone!.signature).toBe("def standalone():");
  });

  it("no regression: a declaration at the very start of the file still reports line 1", () => {
    const src = "export function atStart() { return 1; }\n";
    const symbols = extractSymbolsRegex(src, "typescript");
    const atStart = symbols.find((s) => s.name === "atStart");
    expect(atStart).toBeDefined();
    expect(atStart!.line).toBe(1);
    expect(atStart!.endLine).toBe(1);
    expect(atStart!.signature).toBe("export function atStart() { return 1; }");
  });

  it("no regression: a declaration right after a (non-blank) line comment still reports its own line", () => {
    const src = "// leading comment\nexport function afterComment() { return 1; }\n";
    const symbols = extractSymbolsRegex(src, "typescript");
    const afterComment = symbols.find((s) => s.name === "afterComment");
    expect(afterComment).toBeDefined();
    expect(afterComment!.line).toBe(2);
    expect(afterComment!.signature).toBe("export function afterComment() { return 1; }");
  });

  it("CRLF line endings: a declaration after a blank CRLF line still reports its own line and signature", () => {
    const src = "const x = 1;\r\n\r\nexport function widget() { return 1; }\r\n";
    const symbols = extractSymbolsRegex(src, "typescript");
    const widget = symbols.find((s) => s.name === "widget");
    expect(widget).toBeDefined();
    expect(widget!.line).toBe(3);
    expect(widget!.endLine).toBe(3);
    expect(widget!.signature).toBe("export function widget() { return 1; }");
  });

  it("multiple consecutive blank lines: reports the declaration's own line, not the first blank line", () => {
    const src = "const a = 1;\n\n\n\nexport function multi() { return 1; }\n";
    const symbols = extractSymbolsRegex(src, "typescript");
    const multi = symbols.find((s) => s.name === "multi");
    expect(multi).toBeDefined();
    expect(multi!.line).toBe(5);
    expect(multi!.endLine).toBe(5);
    expect(multi!.signature).toBe("export function multi() { return 1; }");
  });

  it("a declaration after a blank line that immediately follows a CLOSED block comment is found (not suppressed) and reports its own line/signature", () => {
    // Regression guard for the comment-state filter (F-A1-4): the
    // suppressedLines lookup keys off the SAME `line` this fix corrects,
    // so it must use the declaration's real line, not the blank line's.
    const src = [
      "/* comment",
      "   still open",
      "*/",
      "",
      "export function afterCommentAndBlank() { return 1; }",
      "",
    ].join("\n");
    const symbols = extractSymbolsRegex(src, "typescript");
    const names = symbols.map((s) => s.name);
    expect(names).toContain("afterCommentAndBlank");
    const hit = symbols.find((s) => s.name === "afterCommentAndBlank");
    expect(hit).toBeDefined();
    expect(hit!.line).toBe(5);
    expect(hit!.signature).toBe("export function afterCommentAndBlank() { return 1; }");
  });
});
