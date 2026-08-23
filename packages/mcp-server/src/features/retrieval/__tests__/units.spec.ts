/**
 * units.spec.ts — V10-08 Hybrid Retrieval v1: index unit builders.
 *
 * Exercises the six unit kinds (file metadata, symbol declaration/body,
 * markdown section, config object, test case) against real tmpdir fixtures —
 * the regex/parse logic in units.ts is the highest-risk surface in this
 * module (line-number bookkeeping, JSON/YAML key extraction, collectSymbols
 * wiring), so it gets its own direct coverage independent of the full
 * locateTaskContext integration tests.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  buildFileMetadataUnits,
  buildMarkdownUnits,
  buildConfigUnits,
  buildTestCaseUnits,
  buildSymbolUnits,
} from "../units.js";
import type { FoundFile } from "../../../tools/walkRepo.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
  }
});

function mkWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tl-retrieval-units-"));
  tmpDirs.push(dir);
  return dir;
}

function writeFile(workspace: string, rel: string, content: string): FoundFile {
  const abs = path.join(workspace, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
  return { relPath: rel, absPath: abs, language: "default", ext: path.extname(rel) };
}

describe("buildFileMetadataUnits", () => {
  it("builds one unit per file, path-decomposed and basename-decomposed", () => {
    const files: FoundFile[] = [
      { relPath: "src/userProfile.ts", absPath: "/x/src/userProfile.ts", language: "typescript", ext: ".ts" },
    ];
    const units = buildFileMetadataUnits(files);
    expect(units).toHaveLength(1);
    expect(units[0]!.kind).toBe("file-metadata");
    expect(units[0]!.path).toBe("src/userProfile.ts");
    expect(units[0]!.fields.path).toEqual(expect.arrayContaining(["src", "user", "profile"]));
    expect(units[0]!.fields.symbolName).toEqual(["user", "profile"]);
  });
});

describe("buildMarkdownUnits", () => {
  it("produces one unit per heading, with the heading's own section body", () => {
    const ws = mkWorkspace();
    const f = writeFile(
      ws,
      "docs/GUIDE.md",
      [
        "# Guide",
        "",
        "## Installation",
        "",
        "Run npm install to set up dependencies.",
        "",
        "## Configuration",
        "",
        "Edit the config file to set your API key.",
      ].join("\n"),
    );
    const units = buildMarkdownUnits(ws, [f]);
    expect(units.map((u) => u.symbol)).toEqual(["Guide", "Installation", "Configuration"]);
    const install = units.find((u) => u.symbol === "Installation")!;
    expect(install.kind).toBe("markdown-section");
    expect(install.fields.body).toEqual(expect.arrayContaining(["npm", "install", "dependencies"]));
    expect(install.fields.symbolName).toEqual(expect.arrayContaining(["installation"]));
  });

  it("skips a non-markdown file even if included in the input list", () => {
    const ws = mkWorkspace();
    const f = writeFile(ws, "src/notmd.ts", "export const x = 1;\n");
    expect(buildMarkdownUnits(ws, [f])).toEqual([]);
  });
});

describe("buildConfigUnits", () => {
  it("extracts top-level keys of a JSON config file with their source line", () => {
    const ws = mkWorkspace();
    const f = writeFile(
      ws,
      "package.json",
      JSON.stringify({ name: "widget", version: "1.0.0", scripts: { build: "tsc" } }, null, 2) + "\n",
    );
    const units = buildConfigUnits(ws, [f]);
    const keys = units.map((u) => u.symbol);
    expect(keys).toEqual(expect.arrayContaining(["name", "version", "scripts"]));
    const nameUnit = units.find((u) => u.symbol === "name")!;
    expect(nameUnit.kind).toBe("config-object");
    expect(nameUnit.fields.body).toContain("widget");
  });

  it("extracts top-level keys of a YAML config file, ignoring indented (nested) lines", () => {
    const ws = mkWorkspace();
    const f = writeFile(
      ws,
      "config.yaml",
      ["service: gateway", "port: 8080", "nested:", "  ignored: true", "# a comment: not a key"].join("\n"),
    );
    const units = buildConfigUnits(ws, [f]);
    const keys = units.map((u) => u.symbol);
    expect(keys).toEqual(expect.arrayContaining(["service", "port", "nested"]));
    expect(keys).not.toContain("ignored");
  });

  it("ignores a non-config file", () => {
    const ws = mkWorkspace();
    const f = writeFile(ws, "src/plain.ts", "export const x = 1;\n");
    expect(buildConfigUnits(ws, [f])).toEqual([]);
  });
});

describe("buildTestCaseUnits", () => {
  it("extracts describe/it/test names from a test file with correct line numbers", () => {
    const ws = mkWorkspace();
    const f = writeFile(
      ws,
      "src/__tests__/widget.spec.ts",
      [
        'describe("widget rendering", () => {',
        '  it("renders the default state", () => {',
        "    expect(true).toBe(true);",
        "  });",
        '  it("handles an empty input gracefully", () => {',
        "    expect(true).toBe(true);",
        "  });",
        "});",
      ].join("\n"),
    );
    const units = buildTestCaseUnits(ws, [f]);
    const names = units.map((u) => u.symbol);
    expect(names).toEqual(["widget rendering", "renders the default state", "handles an empty input gracefully"]);
    const secondIt = units.find((u) => u.symbol === "handles an empty input gracefully")!;
    expect(secondIt.line).toBe(5);
    expect(secondIt.kind).toBe("test-case");
    expect(secondIt.fields.symbolName).toEqual(expect.arrayContaining(["handles", "empty", "input", "gracefully"]));
  });

  it("ignores a non-test file", () => {
    const ws = mkWorkspace();
    const f = writeFile(ws, "src/plain.ts", 'describe("not actually a test file", () => {});\n');
    expect(buildTestCaseUnits(ws, [f])).toEqual([]);
  });
});

describe("buildSymbolUnits", () => {
  it("produces declaration + body units from a real tree-sitter parse, PLUS the byPath map used for parser-proven verification", async () => {
    const ws = mkWorkspace();
    writeFile(
      ws,
      "src/service.ts",
      [
        "/** Fetches the active user's profile. */",
        "export function fetchUserProfile(id: string): string {",
        "  return id;",
        "}",
      ].join("\n"),
    );
    const result = await buildSymbolUnits(ws, ["src/service.ts"]);
    const declKinds = result.units.map((u) => u.kind);
    expect(declKinds).toEqual(expect.arrayContaining(["symbol-declaration", "symbol-body"]));
    const decl = result.units.find((u) => u.kind === "symbol-declaration")!;
    expect(decl.symbol).toBe("fetchUserProfile");
    expect(decl.fields.symbolName).toEqual(expect.arrayContaining(["fetch", "user", "profile"]));
    expect(decl.fields.doc).toEqual(expect.arrayContaining(["fetches", "active", "user", "profile"]));

    expect(result.byPath.has("src/service.ts")).toBe(true);
    expect(result.byPath.get("src/service.ts")!.some((s) => s.name === "fetchUserProfile")).toBe(true);
  });

  it("produces zero units for an unsupported-for-extraction language, never a regex guess", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "src/page.html", "<html><body><script>function checkout() {}</script></body></html>\n");
    const result = await buildSymbolUnits(ws, ["src/page.html"]);
    expect(result.units).toEqual([]);
    expect(result.byPath.size).toBe(0);
  });

  it("produces zero units for a nonexistent file (defensive, no throw)", async () => {
    const ws = mkWorkspace();
    const result = await buildSymbolUnits(ws, ["src/does-not-exist.ts"]);
    expect(result.units).toEqual([]);
  });
});
