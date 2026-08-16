// renameSymbol.spec.ts — unit tests for edit_code mode=rename.
//
// Tests:
//   - workspace-wide rename rewrites all word-boundary matches
//   - line-comment matches are SKIPPED by default
//   - includeComments:true rewrites comment matches too
//   - rename is word-boundary (does NOT touch findByIdLater, etc.)
//   - allowWrite:false → write-not-enabled error (no mutations)
//   - invalid identifier → invalid-input
//   - from === to → invalid-input
//   - path scope limits rewrites to that subtree
//   - secret files are skipped (and reported), not failed
//   - file with all matches in comments produces 0 changed files

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { renameSymbol } from "../tools/renameSymbol.js";
import { unsafeGuardedWorkspaceRootForTests, type GuardedWorkspaceRoot } from "../write/guardedWorkspace.js";

const tmpDirs: string[] = [];
const SESSION = "test-session";

function mkWorkspace(): GuardedWorkspaceRoot {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tl-rs-test-"));
  tmpDirs.push(dir);
  return unsafeGuardedWorkspaceRootForTests(dir);
}

function writeFile(workspace: string, rel: string, content: string): void {
  const abs = path.join(workspace, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

function readFile(workspace: string, rel: string): string {
  return fs.readFileSync(path.join(workspace, rel), "utf8");
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
  }
});

describe("renameSymbol — basic rewrite", () => {
  it("rewrites word-boundary matches across multiple files", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "a.ts", "const r = repo.findById(1);\nconst r2 = repo.findById(2);\n");
    writeFile(ws, "src/b.ts", "import { findById } from './x';\nfindById(3);\n");

    const result = await renameSymbol({ from: "findById", to: "getById" }, ws, true, SESSION);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.total_replacements).toBe(4);
    expect(result.changed_files.map((f) => f.path).sort()).toEqual(["a.ts", "src/b.ts"]);
    expect(readFile(ws, "a.ts")).toBe("const r = repo.getById(1);\nconst r2 = repo.getById(2);\n");
    expect(readFile(ws, "src/b.ts")).toBe("import { getById } from './x';\ngetById(3);\n");
  });

  it("preserves CRLF line endings", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "a.ts", "const a = findById(1);\r\nconst b = findById(2);\r\n");

    const result = await renameSymbol({ from: "findById", to: "getById" }, ws, true, SESSION);

    expect(result.ok).toBe(true);
    expect(readFile(ws, "a.ts")).toBe("const a = getById(1);\r\nconst b = getById(2);\r\n");
  });

  it("does NOT touch substring matches like findByIdLater", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "a.ts", [
      "findById(1);",
      "findByIdLater(2);",
      "myFindById(3);",
      "foo_findById_bar(4);",
    ].join("\n"));

    const result = await renameSymbol({ from: "findById", to: "getById" }, ws, true, SESSION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.total_replacements).toBe(1);
    expect(readFile(ws, "a.ts")).toBe([
      "getById(1);",
      "findByIdLater(2);",
      "myFindById(3);",
      "foo_findById_bar(4);",
    ].join("\n"));
  });

  // FIX 2: rename must rewrite EVERY reference to be correct, including source
  // in legitimately-named build-dir / generated directories (which are
  // noise-filtered for orientation modes). renameSymbol passes fullRecall.
  it("rewrites references in legitimately-named build/ and generated/ source dirs", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "src/main.ts", "findById(0);\n");
    writeFile(ws, "src/build/utils.ts", "export const x = findById(1);\n");
    writeFile(ws, "src/codegen/generated/schema.ts", "export const y = findById(2);\n");
    writeFile(ws, "packages/lib/__generated__/api.ts", "export const z = findById(3);\n");

    const result = await renameSymbol({ from: "findById", to: "getById" }, ws, true, SESSION);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const changed = result.changed_files.map((f) => f.path).sort();
    expect(changed).toContain("src/main.ts");
    expect(changed).toContain("src/build/utils.ts");
    expect(changed).toContain("src/codegen/generated/schema.ts");
    expect(changed).toContain("packages/lib/__generated__/api.ts");
    expect(readFile(ws, "src/build/utils.ts")).toBe("export const x = getById(1);\n");
    expect(readFile(ws, "src/codegen/generated/schema.ts")).toBe("export const y = getById(2);\n");
  });
});

describe("renameSymbol — comment handling", () => {
  it("skips // comment lines by default", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "a.ts", [
      "// findById is the old name",
      "function lookup() { return findById(1); }",
    ].join("\n"));

    const result = await renameSymbol({ from: "findById", to: "getById" }, ws, true, SESSION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.total_replacements).toBe(1);
    expect(readFile(ws, "a.ts")).toBe([
      "// findById is the old name",
      "function lookup() { return getById(1); }",
    ].join("\n"));
  });

  it("rewrites comment matches when includeComments:true", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "a.ts", [
      "// findById is the old name",
      "function lookup() { return findById(1); }",
    ].join("\n"));

    const result = await renameSymbol(
      { from: "findById", to: "getById", includeComments: true },
      ws, true, SESSION,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.total_replacements).toBe(2);
    expect(readFile(ws, "a.ts")).toBe([
      "// getById is the old name",
      "function lookup() { return getById(1); }",
    ].join("\n"));
  });

  it("returns 0 changed files when every match is in a comment (default)", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "a.ts", "// findById only mentioned here\n// and here findById too\n");

    const result = await renameSymbol({ from: "findById", to: "getById" }, ws, true, SESSION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.total_replacements).toBe(0);
    expect(result.changed_files).toEqual([]);
    // File untouched
    expect(readFile(ws, "a.ts")).toBe("// findById only mentioned here\n// and here findById too\n");
  });
});

describe("renameSymbol — lexical exclusions", () => {
  it("does not rewrite string literal mentions", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "a.ts", [
      "const label = \"findById\";",
      "const message = `call findById later`;",
      "function lookup() { return findById(1); }",
    ].join("\n"));

    const result = await renameSymbol({ from: "findById", to: "getById" }, ws, true, SESSION);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.total_replacements).toBe(1);
    expect(readFile(ws, "a.ts")).toBe([
      "const label = \"findById\";",
      "const message = `call findById later`;",
      "function lookup() { return getById(1); }",
    ].join("\n"));
  });
});

describe("renameSymbol — scoping", () => {
  it("limits rewrites to a subdirectory when path is a dir", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "a.ts", "findById(1);\n");
    writeFile(ws, "src/b.ts", "findById(2);\n");
    writeFile(ws, "other/c.ts", "findById(3);\n");

    const result = await renameSymbol({ from: "findById", to: "getById", path: "src" }, ws, true, SESSION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed_files.map((f) => f.path)).toEqual(["src/b.ts"]);
    expect(readFile(ws, "a.ts")).toBe("findById(1);\n");
    expect(readFile(ws, "src/b.ts")).toBe("getById(2);\n");
    expect(readFile(ws, "other/c.ts")).toBe("findById(3);\n");
  });
});

describe("renameSymbol — validation", () => {
  it("rejects allowWrite:false with write-not-enabled", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "a.ts", "findById(1);\n");

    const result = await renameSymbol({ from: "findById", to: "getById" }, ws, false, SESSION);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("write-not-enabled");
    // File untouched
    expect(readFile(ws, "a.ts")).toBe("findById(1);\n");
  });

  it("rejects invalid `from` identifier", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "a.ts", "foo();\n");

    const result = await renameSymbol({ from: "not-an-id", to: "bar" }, ws, true, SESSION);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid-input");
  });

  it("rejects invalid `to` identifier", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "a.ts", "foo();\n");

    const result = await renameSymbol({ from: "foo", to: "1bad" }, ws, true, SESSION);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid-input");
  });

  it("rejects from === to", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "a.ts", "foo();\n");

    const result = await renameSymbol({ from: "foo", to: "foo" }, ws, true, SESSION);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid-input");
  });
});
